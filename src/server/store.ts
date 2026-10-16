import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Op } from '../crdt/doc.js';
import { isOp, ROOM_RE } from '../sync/protocol.js';

/** Persists each room's op log as JSON with atomic (write + rename) snapshots. */
export class FileStore {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly dir: string,
    private readonly debounceMs = 250,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private path(room: string): string {
    if (!ROOM_RE.test(room)) throw new Error('invalid room name');
    return join(this.dir, `${room}.json`);
  }

  load(room: string): Op[] {
    try {
      const data: unknown = JSON.parse(readFileSync(this.path(room), 'utf8'));
      return Array.isArray(data) ? data.filter(isOp) : [];
    } catch {
      return [];
    }
  }

  /** Schedules a debounced save; `get` is evaluated at write time. */
  schedule(room: string, get: () => readonly Op[]): void {
    if (this.timers.has(room)) return;
    this.timers.set(
      room,
      setTimeout(() => {
        this.timers.delete(room);
        this.write(room, get());
      }, this.debounceMs),
    );
  }

  write(room: string, ops: readonly Op[]): void {
    const p = this.path(room);
    writeFileSync(`${p}.tmp`, JSON.stringify(ops));
    renameSync(`${p}.tmp`, p);
  }

  /** Flushes pending saves (graceful shutdown). */
  flush(get: (room: string) => readonly Op[]): void {
    for (const [room, t] of this.timers) {
      clearTimeout(t);
      this.write(room, get(room));
    }
    this.timers.clear();
  }
}
