import { compareIds, type Id } from './id.js';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface Entry {
  value: Json;
  ts: Id;
}

/**
 * Last-Writer-Wins map. Each key holds the write with the greatest Lamport id;
 * `null` is a tombstone. Merge is commutative, associative and idempotent, so
 * replicas converge whatever order (or number of times) writes arrive in.
 */
export class LwwMap {
  private readonly entries = new Map<string, Entry>();

  /** Applies a write; returns true if it became the winning value. */
  set(key: string, value: Json, ts: Id): boolean {
    const cur = this.entries.get(key);
    if (cur && compareIds(cur.ts, ts) >= 0) return false;
    this.entries.set(key, { value, ts });
    return true;
  }

  get(key: string): Json | undefined {
    const e = this.entries.get(key);
    return e === undefined || e.value === null ? undefined : e.value;
  }

  timestamp(key: string): Id | undefined {
    return this.entries.get(key)?.ts;
  }

  /** Live (non-tombstoned) entries, sorted by key for deterministic output. */
  toObject(): Record<string, Json> {
    const out: Record<string, Json> = {};
    for (const k of [...this.entries.keys()].sort()) {
      const v = this.entries.get(k)!.value;
      if (v !== null) out[k] = v;
    }
    return out;
  }

  keys(prefix = ''): string[] {
    return [...this.entries.keys()].filter((k) => k.startsWith(prefix) && this.entries.get(k)!.value !== null);
  }
}
