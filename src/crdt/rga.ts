import { compareIds, idKey, type Id } from './id.js';

/** One character of the replicated sequence. Deleted characters stay as tombstones. */
interface Node {
  readonly id: Id;
  readonly ch: string;
  deleted: boolean;
}

/**
 * Replicated Growable Array (RGA) — a sequence CRDT.
 *
 * Every character is inserted *after* a reference character (or the head) and
 * carries a Lamport id that is larger than its reference. Concurrent inserts
 * after the same reference are ordered by descending id, which is implemented
 * by the single skip rule in {@link Rga.insert}: starting right after the
 * reference, skip every node whose id is greater than the new one. Because a
 * node's descendants always have larger ids than the node itself, this skips
 * whole subtrees of "newer" siblings and stops exactly at the right slot —
 * on every replica, regardless of delivery order.
 *
 * Deletes mark tombstones so that later inserts can still reference them.
 *
 * Storage is a flat array in document order plus an id index: O(n) inserts,
 * which is fine for documents of tens of thousands of characters. Production
 * systems (Yjs, Automerge) add run-length encoding and tree indexes.
 */
export class Rga {
  private readonly nodes: Node[] = [];
  private readonly index = new Map<string, Node>();
  private visible = 0;

  get length(): number {
    return this.visible;
  }

  has(id: Id): boolean {
    return this.index.has(idKey(id));
  }

  isDeleted(id: Id): boolean {
    return this.index.get(idKey(id))?.deleted ?? false;
  }

  /** Integrates a character. Returns false if it was already present. */
  insert(id: Id, after: Id | null, ch: string): boolean {
    const key = idKey(id);
    if (this.index.has(key)) return false;
    let pos = 0;
    if (after !== null) {
      const ref = this.index.get(idKey(after));
      if (!ref) throw new Error(`rga: missing reference ${idKey(after)}`);
      pos = this.nodes.indexOf(ref) + 1;
    }
    while (pos < this.nodes.length && compareIds(this.nodes[pos]!.id, id) > 0) pos++;
    const node: Node = { id, ch, deleted: false };
    this.nodes.splice(pos, 0, node);
    this.index.set(key, node);
    this.visible++;
    return true;
  }

  /** Tombstones a character. Returns false if it was already deleted. */
  delete(id: Id): boolean {
    const node = this.index.get(idKey(id));
    if (!node) throw new Error(`rga: missing target ${idKey(id)}`);
    if (node.deleted) return false;
    node.deleted = true;
    this.visible--;
    return true;
  }

  toString(): string {
    let s = '';
    for (const n of this.nodes) if (!n.deleted) s += n.ch;
    return s;
  }

  /** Id of the visible character at `index`. */
  idAt(index: number): Id {
    let i = 0;
    for (const n of this.nodes) {
      if (n.deleted) continue;
      if (i === index) return n.id;
      i++;
    }
    throw new RangeError(`rga: index ${index} out of bounds (length ${this.visible})`);
  }

  /** Id of the visible character just before a caret at `index` (null = start). */
  idBefore(index: number): Id | null {
    return index <= 0 ? null : this.idAt(index - 1);
  }

  /** Ids of `count` visible characters starting at `index`. */
  idsInRange(index: number, count: number): Id[] {
    const out: Id[] = [];
    let i = 0;
    for (const n of this.nodes) {
      if (n.deleted) continue;
      if (i >= index && out.length < count) out.push(n.id);
      i++;
      if (out.length === count) break;
    }
    return out;
  }

  /**
   * Caret index right after the character `id` — a position that is stable
   * under concurrent edits (used for cursors and remote carets). If `id` was
   * deleted, the caret sticks to where the character used to be.
   */
  caretAfter(id: Id | null): number {
    if (id === null) return 0;
    const target = this.index.get(idKey(id));
    if (!target) return 0;
    let i = 0;
    for (const n of this.nodes) {
      if (!n.deleted) i++;
      if (n === target) return i;
    }
    return i;
  }
}
