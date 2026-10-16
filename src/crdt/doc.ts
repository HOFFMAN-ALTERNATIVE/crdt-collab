import { idKey, type Id } from './id.js';
import { LwwMap, type Json } from './lww.js';
import { Rga } from './rga.js';

/**
 * Operations are the unit of replication. `id` is the Lamport id of the op
 * (for `ins`, of its first character; following characters get consecutive
 * clocks) and `seq` is a per-client counter used for version vectors.
 */
export type Op =
  | { t: 'ins'; id: Id; seq: number; after: Id | null; text: string }
  | { t: 'del'; id: Id; seq: number; targets: Id[] }
  | { t: 'set'; id: Id; seq: number; key: string; value: Json };

/** client id -> highest contiguous seq applied from that client. */
export type VersionVector = Record<string, number>;

export interface ChangeEvent {
  ops: Op[];
  local: boolean;
}

const MAX_PENDING = 50_000;

/**
 * A replicated document: one RGA text plus one LWW map (used by the
 * whiteboard). Remote operations may arrive in any order, duplicated, or
 * before their causal dependencies; such ops are buffered until they can be
 * applied, so the replica state is always causally consistent.
 */
export class Doc {
  readonly text = new Rga();
  readonly map = new LwwMap();
  private clock = 0;
  private seq = 0;
  private readonly vv = new Map<string, number>();
  private readonly log: Op[] = [];
  private readonly pending = new Map<string, Op>();
  private readonly listeners = new Set<(e: ChangeEvent) => void>();

  constructor(readonly clientId: string) {
    if (!clientId) throw new Error('doc: clientId required');
  }

  // ---------------------------------------------------------------- queries

  getText(): string {
    return this.text.toString();
  }

  versionVector(): VersionVector {
    return Object.fromEntries(this.vv);
  }

  /** All ops the holder of `vv` has not seen, in causal (application) order. */
  opsSince(vv: VersionVector): Op[] {
    return this.log.filter((op) => op.seq > (vv[op.id.client] ?? 0));
  }

  /** Full op log (for persistence / snapshots). */
  allOps(): readonly Op[] {
    return this.log;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** Cheap 32-bit FNV-1a fingerprint of the visible state, to compare replicas. */
  fingerprint(): string {
    const s = this.getText() + '\u0000' + JSON.stringify(this.map.toObject());
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  onChange(fn: (e: ChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------------------------------------------------------- local editing

  /** Inserts `text` at visible index; returns the op to broadcast (or null). */
  insertText(index: number, text: string): Op | null {
    if (text.length === 0) return null;
    const i = Math.max(0, Math.min(index, this.text.length));
    const op: Op = { t: 'ins', id: this.nextId(text.length), seq: ++this.seq, after: this.text.idBefore(i), text };
    this.commitLocal(op);
    return op;
  }

  /** Deletes `count` visible characters starting at `index`. */
  deleteText(index: number, count: number): Op | null {
    const targets = this.text.idsInRange(Math.max(0, index), Math.max(0, count));
    if (targets.length === 0) return null;
    const op: Op = { t: 'del', id: this.nextId(1), seq: ++this.seq, targets };
    this.commitLocal(op);
    return op;
  }

  /** Writes a map key (`null` deletes it). */
  set(key: string, value: Json): Op {
    const op: Op = { t: 'set', id: this.nextId(1), seq: ++this.seq, key, value };
    this.commitLocal(op);
    return op;
  }

  /** Current Lamport time (useful for z-ordering of new whiteboard shapes). */
  now(): number {
    return this.clock;
  }

  private nextId(width: number): Id {
    const id = { client: this.clientId, clock: this.clock + 1 };
    this.clock += width;
    return id;
  }

  private commitLocal(op: Op): void {
    this.integrate(op);
    this.emit({ ops: [op], local: true });
  }

  // ---------------------------------------------------------- replication

  /**
   * Applies remote ops in any order. Returns the ops that were newly applied
   * (including previously buffered ones that became ready), which is exactly
   * what a relay should forward.
   */
  applyRemote(ops: readonly Op[]): Op[] {
    const applied: Op[] = [];
    for (const op of ops) {
      if (this.seen(op)) continue;
      if (this.ready(op)) {
        this.integrate(op);
        applied.push(op);
      } else {
        if (this.pending.size >= MAX_PENDING) throw new Error('doc: pending buffer overflow');
        this.pending.set(`${op.id.client}:${op.seq}`, op);
      }
    }
    if (applied.length > 0) this.drainPending(applied);
    if (applied.length > 0) this.emit({ ops: applied, local: false });
    return applied;
  }

  private seen(op: Op): boolean {
    return op.seq <= (this.vv.get(op.id.client) ?? 0) || this.pending.has(`${op.id.client}:${op.seq}`);
  }

  private ready(op: Op): boolean {
    if (op.seq !== (this.vv.get(op.id.client) ?? 0) + 1) return false;
    switch (op.t) {
      case 'ins':
        return op.after === null || this.text.has(op.after);
      case 'del':
        return op.targets.every((t) => this.text.has(t));
      case 'set':
        return true;
    }
  }

  private drainPending(applied: Op[]): void {
    let progress = true;
    while (progress && this.pending.size > 0) {
      progress = false;
      for (const [k, op] of this.pending) {
        if (op.seq <= (this.vv.get(op.id.client) ?? 0)) {
          this.pending.delete(k);
        } else if (this.ready(op)) {
          this.pending.delete(k);
          this.integrate(op);
          applied.push(op);
          progress = true;
        }
      }
    }
  }

  private integrate(op: Op): void {
    let maxClock = op.id.clock;
    switch (op.t) {
      case 'ins': {
        let after = op.after;
        let clock = op.id.clock;
        // One node per UTF-16 code unit, matching DOM selection offsets.
        for (let i = 0; i < op.text.length; i++) {
          const id = { client: op.id.client, clock };
          this.text.insert(id, after, op.text[i]!);
          after = id;
          clock++;
        }
        maxClock = clock - 1;
        break;
      }
      case 'del':
        for (const t of op.targets) this.text.delete(t);
        break;
      case 'set':
        this.map.set(op.key, op.value, op.id);
        break;
    }
    this.clock = Math.max(this.clock, maxClock);
    this.vv.set(op.id.client, op.seq);
    if (op.id.client === this.clientId) this.seq = Math.max(this.seq, op.seq);
    this.log.push(op);
  }

  private emit(e: ChangeEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  /** Rebuilds a replica from a persisted op log. */
  static fromOps(clientId: string, ops: readonly Op[]): Doc {
    const d = new Doc(clientId);
    d.applyRemote(ops);
    return d;
  }
}

/** Number of characters an op occupies in Lamport time. */
export const opWidth = (op: Op): number => (op.t === 'ins' ? op.text.length : 1);

export { idKey };
