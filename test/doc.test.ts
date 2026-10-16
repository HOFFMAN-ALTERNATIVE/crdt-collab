import { describe, expect, it } from 'vitest';
import { Doc, type Op } from '../src/crdt/doc.js';
import { Whiteboard } from '../src/crdt/whiteboard.js';
import { LwwMap } from '../src/crdt/lww.js';

function sync(...docs: Doc[]): void {
  for (const a of docs) for (const b of docs) if (a !== b) b.applyRemote(a.opsSince(b.versionVector()));
}

describe('Doc', () => {
  it('edits locally like a string', () => {
    const d = new Doc('a');
    d.insertText(0, 'hello world');
    d.deleteText(5, 6);
    d.insertText(5, ', crdt');
    d.insertText(0, '>> ');
    expect(d.getText()).toBe('>> hello, crdt');
    expect(d.deleteText(100, 3)).toBeNull();
    expect(d.insertText(3, '')).toBeNull();
  });

  it('merges concurrent edits and offline work', () => {
    const a = new Doc('alice');
    const b = new Doc('bob');
    a.insertText(0, 'The cat');
    sync(a, b);
    a.insertText(4, 'black ');
    b.insertText(7, ' sat');
    b.deleteText(0, 4);
    sync(a, b);
    expect(a.getText()).toBe(b.getText());
    expect(a.getText()).toBe('black cat sat');
    expect(a.fingerprint()).toBe(b.fingerprint());
  });

  it('never interleaves two concurrent runs typed at the same spot', () => {
    const a = new Doc('a');
    const b = new Doc('b');
    a.insertText(0, '[]');
    sync(a, b);
    a.insertText(1, 'alpha');
    b.insertText(1, 'BRAVO');
    sync(a, b);
    expect(['[alphaBRAVO]', '[BRAVOalpha]']).toContain(a.getText());
    expect(b.getText()).toBe(a.getText());
  });

  it('buffers ops whose causal dependencies have not arrived', () => {
    const a = new Doc('a');
    a.insertText(0, 'ab');
    a.insertText(2, 'cd');
    a.deleteText(1, 2);
    const ops = [...a.allOps()];
    const b = new Doc('b');
    expect(b.applyRemote([ops[2]!])).toEqual([]);
    expect(b.applyRemote([ops[1]!])).toEqual([]);
    expect(b.pendingCount()).toBe(2);
    expect(b.applyRemote([ops[0]!]).length).toBe(3);
    expect(b.pendingCount()).toBe(0);
    expect(b.getText()).toBe('ad');
  });

  it('ignores duplicates and reports only fresh ops', () => {
    const a = new Doc('a');
    a.insertText(0, 'x');
    const b = new Doc('b');
    expect(b.applyRemote(a.allOps()).length).toBe(1);
    expect(b.applyRemote(a.allOps())).toEqual([]);
  });

  it('opsSince ships exactly the missing ops', () => {
    const a = new Doc('a');
    const b = new Doc('b');
    a.insertText(0, 'one');
    sync(a, b);
    a.insertText(3, ' two');
    a.set('k', 1);
    expect(a.opsSince(b.versionVector()).map((o: Op) => o.t)).toEqual(['ins', 'set']);
    expect(a.opsSince(a.versionVector())).toEqual([]);
  });

  it('local Lamport clock always exceeds everything seen', () => {
    const a = new Doc('a');
    const b = new Doc('b');
    b.insertText(0, 'x'.repeat(50));
    a.applyRemote(b.allOps());
    const op = a.insertText(0, 'y')!;
    expect(op.id.clock).toBeGreaterThan(50);
  });

  it('rebuilds from a persisted log', () => {
    const a = new Doc('a');
    a.insertText(0, 'persist me');
    a.set('title', 'doc');
    const copy = Doc.fromOps('b', JSON.parse(JSON.stringify(a.allOps())) as Op[]);
    expect(copy.fingerprint()).toBe(a.fingerprint());
  });

  it('notifies listeners with local/remote flag', () => {
    const a = new Doc('a');
    const b = new Doc('b');
    const seen: boolean[] = [];
    b.onChange((e) => seen.push(e.local));
    b.insertText(0, 'x');
    a.insertText(0, 'y');
    b.applyRemote(a.allOps());
    expect(seen).toEqual([true, false]);
  });
});

describe('LwwMap', () => {
  it('keeps the greatest timestamp and supports tombstones', () => {
    const m = new LwwMap();
    expect(m.set('k', 1, { client: 'a', clock: 2 })).toBe(true);
    expect(m.set('k', 2, { client: 'a', clock: 1 })).toBe(false);
    expect(m.set('k', 3, { client: 'b', clock: 2 })).toBe(true);
    expect(m.get('k')).toBe(3);
    m.set('k', null, { client: 'a', clock: 9 });
    expect(m.get('k')).toBeUndefined();
    expect(m.keys()).toEqual([]);
  });
});

describe('Whiteboard', () => {
  it('merges concurrent edits of different fields and lets delete win', () => {
    const a = new Doc('a');
    const b = new Doc('b');
    const wa = new Whiteboard(a);
    const wb = new Whiteboard(b);
    wa.create({ id: 's1', kind: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#fff', text: '', points: [] });
    wa.create({ id: 's2', kind: 'note', x: 5, y: 5, w: 10, h: 10, fill: '#fff', text: 'hi', points: [] });
    sync(a, b);
    wa.update('s1', { x: 100, y: 50 });
    wb.update('s1', { fill: '#f0f' });
    wa.update('s2', { x: 999 });
    wb.remove('s2');
    sync(a, b);
    expect(wa.shapes()).toEqual(wb.shapes());
    expect(wa.shapes()).toHaveLength(1);
    expect(wa.shapes()[0]).toMatchObject({ id: 's1', x: 100, y: 50, fill: '#f0f' });
  });

  it('bringToFront reorders by z', () => {
    const a = new Doc('a');
    const w = new Whiteboard(a);
    w.create({ id: 'x', kind: 'rect', x: 0, y: 0, w: 1, h: 1, fill: '#fff', text: '', points: [] });
    w.create({ id: 'y', kind: 'ellipse', x: 0, y: 0, w: 1, h: 1, fill: '#fff', text: '', points: [] });
    expect(w.shapes().map((s) => s.id)).toEqual(['x', 'y']);
    w.bringToFront('x');
    expect(w.shapes().map((s) => s.id)).toEqual(['y', 'x']);
  });
});
