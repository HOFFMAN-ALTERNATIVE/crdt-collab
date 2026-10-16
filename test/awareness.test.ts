import { describe, expect, it } from 'vitest';
import { Awareness } from '../src/crdt/awareness.js';
import { parseMsg } from '../src/sync/protocol.js';

describe('Awareness', () => {
  it('keeps the newest state per client and expires silent peers', () => {
    let now = 0;
    const a = new Awareness('a', 1000, () => now);
    const b = new Awareness('b', 1000, () => now);
    const u1 = a.setLocal({ name: 'Ada', color: '#f0f' });
    const u2 = a.setLocal({ pointer: { x: 1, y: 2 } });
    expect(b.apply(u2)).toBe(true);
    expect(b.apply(u1)).toBe(false); // stale
    expect(b.peers().get('a')).toMatchObject({ name: 'Ada', pointer: { x: 1, y: 2 } });
    now = 900;
    b.apply(u2); // heartbeat refreshes
    now = 1500;
    expect(b.prune()).toEqual([]);
    now = 2000;
    expect(b.prune()).toEqual(['a']);
    expect(b.peers().size).toBe(0);
  });

  it('handles explicit leave and ignores own echoes', () => {
    const a = new Awareness('a');
    const b = new Awareness('b');
    b.apply(a.setLocal({ name: 'A', color: '#fff' }));
    expect(a.apply({ client: 'a', clock: 99, state: null })).toBe(false);
    expect(b.apply(a.leave())).toBe(true);
    expect(b.peers().size).toBe(0);
  });
});

describe('protocol validation', () => {
  const op = { t: 'ins', id: { client: 'a', clock: 1 }, seq: 1, after: null, text: 'x' };
  it('accepts well-formed messages', () => {
    expect(parseMsg(JSON.stringify({ type: 'hello', room: 'r', client: 'a', vv: { a: 1 }, reply: true }))).not.toBeNull();
    expect(parseMsg({ type: 'ops', ops: [op] })).not.toBeNull();
    expect(parseMsg({ type: 'awareness', updates: [{ client: 'a', clock: 1, state: null }] })).not.toBeNull();
  });
  it.each([
    ['garbage', '{nope'],
    ['unknown type', { type: 'rm -rf' }],
    ['bad room', { type: 'hello', room: '../etc', client: 'a', vv: {}, reply: true }],
    ['negative vv', { type: 'hello', room: 'r', client: 'a', vv: { a: -1 }, reply: true }],
    ['bad op id', { type: 'ops', ops: [{ ...op, id: { client: 'a', clock: 0 } }] }],
    ['empty insert', { type: 'ops', ops: [{ ...op, text: '' }] }],
    ['unknown op', { type: 'ops', ops: [{ ...op, t: 'drop' }] }],
    ['huge value', { type: 'ops', ops: [{ t: 'set', id: { client: 'a', clock: 1 }, seq: 1, key: 'k', value: 'x'.repeat(70_000) }] }],
    ['bad presence', { type: 'awareness', updates: [{ client: 'a', clock: 1, state: { name: 1 } }] }],
  ])('rejects %s', (_, raw) => {
    expect(parseMsg(typeof raw === 'string' ? raw : JSON.stringify(raw))).toBeNull();
  });
});
