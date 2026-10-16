import type { Id } from './id.js';

/** Ephemeral per-user state: never persisted, never part of the CRDT. */
export interface PresenceState {
  name: string;
  color: string;
  /** Caret anchored to a character id (stable under concurrent edits). */
  cursor?: { anchor: Id | null; head: Id | null } | null;
  /** Pointer position on the whiteboard, in board coordinates. */
  pointer?: { x: number; y: number } | null;
  selection?: string | null;
}

export interface AwarenessUpdate {
  client: string;
  clock: number;
  state: PresenceState | null;
}

interface Entry {
  clock: number;
  state: PresenceState;
  seenAt: number;
}

/**
 * Presence ("awareness") protocol: each client owns its state and bumps a
 * private clock on every change; receivers keep the highest clock per client.
 * States expire after `timeoutMs` without a heartbeat, which covers crashed
 * tabs and silent network partitions.
 */
export class Awareness {
  private readonly states = new Map<string, Entry>();
  private clock = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly clientId: string,
    private readonly timeoutMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Merges `patch` into the local state and returns the update to broadcast. */
  setLocal(patch: Partial<PresenceState>): AwarenessUpdate {
    const cur = this.states.get(this.clientId)?.state ?? { name: this.clientId, color: '#00e5ff' };
    const state = { ...cur, ...patch };
    this.states.set(this.clientId, { clock: ++this.clock, state, seenAt: this.now() });
    this.emit();
    return { client: this.clientId, clock: this.clock, state };
  }

  /** Current local update (for heartbeats and on (re)connect). */
  localUpdate(): AwarenessUpdate | null {
    const e = this.states.get(this.clientId);
    return e ? { client: this.clientId, clock: e.clock, state: e.state } : null;
  }

  /** Signals that the local user left. */
  leave(): AwarenessUpdate {
    this.states.delete(this.clientId);
    this.emit();
    return { client: this.clientId, clock: ++this.clock, state: null };
  }

  /** Applies a remote update; returns true if it changed anything. */
  apply(u: AwarenessUpdate): boolean {
    if (u.client === this.clientId) return false;
    const cur = this.states.get(u.client);
    if (u.state === null) {
      if (!cur || cur.clock > u.clock) return false;
      this.states.delete(u.client);
      this.emit();
      return true;
    }
    if (cur && cur.clock >= u.clock) {
      if (cur.clock === u.clock) cur.seenAt = this.now(); // heartbeat
      return false;
    }
    this.states.set(u.client, { clock: u.clock, state: u.state, seenAt: this.now() });
    this.emit();
    return true;
  }

  /** Drops remote states that have not been refreshed within the timeout. */
  prune(): string[] {
    const dead: string[] = [];
    const t = this.now();
    for (const [client, e] of this.states) {
      if (client !== this.clientId && t - e.seenAt > this.timeoutMs) {
        this.states.delete(client);
        dead.push(client);
      }
    }
    if (dead.length) this.emit();
    return dead;
  }

  /** Remote peers' states. */
  peers(): Map<string, PresenceState> {
    const out = new Map<string, PresenceState>();
    for (const [c, e] of this.states) if (c !== this.clientId) out.set(c, e.state);
    return out;
  }

  all(): AwarenessUpdate[] {
    return [...this.states].map(([client, e]) => ({ client, clock: e.clock, state: e.state }));
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
