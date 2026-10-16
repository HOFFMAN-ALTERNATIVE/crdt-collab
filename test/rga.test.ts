import { describe, expect, it } from 'vitest';
import { Rga } from '../src/crdt/rga.js';
import { compareIds } from '../src/crdt/id.js';

const id = (client: string, clock: number) => ({ client, clock });

describe('Rga', () => {
  it('inserts, deletes and maps carets', () => {
    const r = new Rga();
    r.insert(id('a', 1), null, 'H');
    r.insert(id('a', 2), id('a', 1), 'i');
    r.insert(id('a', 3), id('a', 2), '!');
    expect(r.toString()).toBe('Hi!');
    expect(r.length).toBe(3);
    r.delete(id('a', 2));
    expect(r.toString()).toBe('H!');
    expect(r.length).toBe(2);
    expect(r.caretAfter(id('a', 2))).toBe(1); // tombstone keeps its place
    expect(r.caretAfter(id('a', 3))).toBe(2);
    expect(r.caretAfter(null)).toBe(0);
    expect(r.idBefore(1)).toEqual(id('a', 1));
    expect(r.idsInRange(0, 5)).toEqual([id('a', 1), id('a', 3)]);
  });

  it('is idempotent', () => {
    const r = new Rga();
    expect(r.insert(id('a', 1), null, 'x')).toBe(true);
    expect(r.insert(id('a', 1), null, 'x')).toBe(false);
    expect(r.delete(id('a', 1))).toBe(true);
    expect(r.delete(id('a', 1))).toBe(false);
    expect(r.toString()).toBe('');
  });

  it('orders concurrent siblings by descending id regardless of arrival order', () => {
    const ops = [
      [id('a', 2), 'A'],
      [id('b', 2), 'B'],
      [id('c', 5), 'C'],
    ] as const;
    const results = new Set<string>();
    for (const perm of [[0, 1, 2], [2, 1, 0], [1, 0, 2], [2, 0, 1]]) {
      const r = new Rga();
      r.insert(id('z', 1), null, '_');
      for (const i of perm) r.insert(ops[i]![0], id('z', 1), ops[i]![1]);
      results.add(r.toString());
    }
    expect([...results]).toEqual(['_CBA']);
  });

  it('rejects inserts after unknown references', () => {
    expect(() => new Rga().insert(id('a', 2), id('a', 1), 'x')).toThrow(/missing reference/);
    expect(() => new Rga().delete(id('a', 1))).toThrow(/missing target/);
    expect(() => new Rga().idAt(0)).toThrow(RangeError);
  });

  it('compareIds is a total order', () => {
    expect(compareIds(id('a', 1), id('b', 1))).toBe(-1);
    expect(compareIds(id('b', 1), id('a', 2))).toBe(-1);
    expect(compareIds(id('a', 1), id('a', 1))).toBe(0);
  });
});
