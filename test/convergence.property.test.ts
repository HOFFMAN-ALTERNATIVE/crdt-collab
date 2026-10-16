import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Doc, type Op } from '../src/crdt/doc.js';
import { Whiteboard } from '../src/crdt/whiteboard.js';

/**
 * Property-based convergence tests (strong eventual consistency):
 * any number of replicas, any interleaving of local edits, any delivery
 * order, with duplicates and causally-premature messages — once every replica
 * has received every op, all replicas are identical.
 */

const RUNS = Number(process.env.FC_RUNS ?? 300);

type Action =
  | { kind: 'ins'; r: number; pos: number; text: string }
  | { kind: 'del'; r: number; pos: number; len: number }
  | { kind: 'set'; r: number; key: string; value: number | null }
  | { kind: 'shape'; r: number; id: string; x: number }
  | { kind: 'deliver'; pick: number; dup: boolean };

const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('ins' as const), r: fc.nat(3), pos: fc.double({ min: 0, max: 1, noNaN: true }), text: fc.string({ minLength: 1, maxLength: 5 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('del' as const), r: fc.nat(3), pos: fc.double({ min: 0, max: 1, noNaN: true }), len: fc.integer({ min: 1, max: 4 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('set' as const), r: fc.nat(3), key: fc.constantFrom('title', 'theme', 'owner'), value: fc.option(fc.integer(), { nil: null }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('shape' as const), r: fc.nat(3), id: fc.constantFrom('s1', 's2'), x: fc.integer({ min: 0, max: 500 }) }) },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('deliver' as const), pick: fc.nat(), dup: fc.boolean() }) },
);

interface Packet {
  to: number;
  op: Op;
}

function run(n: number, actions: Action[], shuffleSeed: number): Doc[] {
  const docs = Array.from({ length: n }, (_, i) => new Doc(`r${i}`));
  const boards = docs.map((d) => new Whiteboard(d));
  const net: Packet[] = [];
  const emit = (from: number, op: Op | null) => {
    if (!op) return;
    for (let to = 0; to < n; to++) if (to !== from) net.push({ to, op });
  };
  for (const a of actions) {
    if (a.kind === 'deliver') {
      if (net.length === 0) continue;
      const i = a.pick % net.length;
      const p = net[i]!;
      docs[p.to]!.applyRemote([p.op]);
      if (!a.dup) net.splice(i, 1); // dup => will be delivered again later
      continue;
    }
    const r = a.r % n;
    const d = docs[r]!;
    switch (a.kind) {
      case 'ins':
        emit(r, d.insertText(Math.floor(a.pos * (d.text.length + 1)), a.text));
        break;
      case 'del':
        emit(r, d.deleteText(Math.floor(a.pos * d.text.length), a.len));
        break;
      case 'set':
        emit(r, d.set(a.key, a.value));
        break;
      case 'shape': {
        const before = d.allOps().length;
        if (boards[r]!.shapes().some((s) => s.id === a.id)) boards[r]!.update(a.id, { x: a.x });
        else boards[r]!.create({ id: a.id, kind: 'rect', x: a.x, y: 0, w: 10, h: 10, fill: '#0ff', text: '', points: [] });
        for (const op of d.allOps().slice(before)) emit(r, op);
        break;
      }
    }
  }
  // Drain the network in a pseudo-random order (xorshift on the seed).
  let s = shuffleSeed | 1;
  const rand = () => ((s ^= s << 13), (s ^= s >>> 17), (s ^= s << 5), (s >>> 0) / 2 ** 32);
  for (let i = net.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [net[i], net[j]] = [net[j]!, net[i]!];
  }
  for (const p of net) docs[p.to]!.applyRemote([p.op]);
  return docs;
}

describe('convergence (fast-check)', () => {
  it('all replicas converge under arbitrary interleavings, reordering and duplication', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 4 }), fc.array(action, { maxLength: 80 }), fc.integer(), (n, actions, seed) => {
        const docs = run(n, actions, seed);
        const [first, ...rest] = docs;
        for (const d of rest) {
          expect(d.getText()).toBe(first!.getText());
          expect(d.map.toObject()).toEqual(first!.map.toObject());
          expect(d.fingerprint()).toBe(first!.fingerprint());
          expect(d.pendingCount()).toBe(0);
          expect(new Whiteboard(d).shapes()).toEqual(new Whiteboard(first!).shapes());
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('applying the same op set in any order yields the same state (commutativity + idempotence)', () => {
    fc.assert(
      fc.property(fc.array(action, { minLength: 1, maxLength: 60 }), fc.integer(), (actions, seed) => {
        const docs = run(3, actions, seed);
        const ops = docs.flatMap((d) => d.allOps().filter((o) => o.id.client === d.clientId));
        const shuffled = fc.sample(fc.shuffledSubarray(ops, { minLength: ops.length, maxLength: ops.length }), { numRuns: 1, seed })[0]!;
        const replay = new Doc('observer');
        replay.applyRemote(shuffled);
        replay.applyRemote([...shuffled].reverse()); // duplicates are no-ops
        expect(replay.fingerprint()).toBe(docs[0]!.fingerprint());
        expect(replay.pendingCount()).toBe(0);
      }),
      { numRuns: RUNS },
    );
  });

  it('a single replica behaves exactly like a plain string (model-based)', () => {
    const edit = fc.oneof(
      fc.record({ ins: fc.constant(true), pos: fc.nat(), text: fc.string({ minLength: 1, maxLength: 8 }) }),
      fc.record({ ins: fc.constant(false), pos: fc.nat(), len: fc.integer({ min: 1, max: 6 }) }),
    );
    fc.assert(
      fc.property(fc.array(edit, { maxLength: 100 }), (edits) => {
        const d = new Doc('solo');
        let model = '';
        for (const e of edits) {
          const pos = e.pos % (model.length + 1);
          if (e.ins) {
            d.insertText(pos, e.text);
            model = model.slice(0, pos) + e.text + model.slice(pos);
          } else {
            d.deleteText(pos, e.len);
            model = model.slice(0, pos) + model.slice(pos + e.len);
          }
          expect(d.getText()).toBe(model);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('preserves each writer’s intent: a run typed by one peer stays contiguous', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 10 }), fc.string({ minLength: 1, maxLength: 10 }), fc.nat(5), (x, y, at) => {
        const a = new Doc('a');
        const b = new Doc('b');
        a.insertText(0, 'abcde');
        b.applyRemote(a.allOps());
        a.insertText(at, x);
        b.insertText(at, y);
        a.applyRemote(b.opsSince(a.versionVector()));
        b.applyRemote(a.opsSince(b.versionVector()));
        const t = a.getText();
        expect(b.getText()).toBe(t);
        const base = 'abcde';
        expect([base.slice(0, at) + x + y + base.slice(at), base.slice(0, at) + y + x + base.slice(at)]).toContain(t);
      }),
      { numRuns: RUNS },
    );
  });
});
