import type { AwarenessUpdate } from '../crdt/awareness.js';
import { Doc, type Op } from '../crdt/doc.js';
import type { Msg } from './protocol.js';

/** A bidirectional connection as seen by the hub (WebSocket, BroadcastChannel, in-memory link…). */
export interface Conn {
  readonly id: string;
  send(msg: Msg): void;
}

interface Presence {
  update: AwarenessUpdate;
  conn: string;
  seenAt: number;
}

/**
 * A room: a server-side replica of the document plus the set of connected
 * peers. The hub is just another CRDT replica — it can merge anything, so it
 * never has to understand edits, only relay ops it has not seen before.
 */
export class Room {
  readonly doc: Doc;
  readonly conns = new Map<string, Conn>();
  private readonly presence = new Map<string, Presence>();
  private readonly greeted = new Set<string>();

  constructor(
    readonly name: string,
    ops: readonly Op[] = [],
    private readonly now: () => number = Date.now,
  ) {
    this.doc = Doc.fromOps(`hub-${name}`.slice(0, 64), ops);
  }

  join(conn: Conn): void {
    this.conns.set(conn.id, conn);
  }

  leave(connId: string): void {
    this.conns.delete(connId);
    this.greeted.delete(connId);
    const gone: AwarenessUpdate[] = [];
    for (const [client, p] of this.presence) {
      if (p.conn === connId) {
        this.presence.delete(client);
        gone.push({ client, clock: p.update.clock + 1, state: null });
      }
    }
    if (gone.length) this.broadcast({ type: 'awareness', updates: gone }, connId);
  }

  /** Handles a validated message from `from`. Returns newly applied ops. */
  handle(from: Conn, msg: Msg): Op[] {
    switch (msg.type) {
      case 'hello': {
        from.send({ type: 'ops', ops: this.doc.opsSince(msg.vv) });
        const presence = [...this.presence.values()].filter((p) => p.conn !== from.id).map((p) => p.update);
        if (presence.length) from.send({ type: 'awareness', updates: presence });
        if (msg.reply || !this.greeted.has(from.id)) {
          this.greeted.add(from.id);
          from.send({ type: 'hello', room: this.name, client: this.doc.clientId, vv: this.doc.versionVector(), reply: false });
        }
        return [];
      }
      case 'ops': {
        const fresh = this.doc.applyRemote(msg.ops);
        if (fresh.length) this.broadcast({ type: 'ops', ops: fresh }, from.id);
        return fresh;
      }
      case 'awareness': {
        const changed: AwarenessUpdate[] = [];
        for (const u of msg.updates) {
          const cur = this.presence.get(u.client);
          if (cur && cur.update.clock > u.clock) continue;
          if (u.state === null) this.presence.delete(u.client);
          else this.presence.set(u.client, { update: u, conn: from.id, seenAt: this.now() });
          changed.push(u);
        }
        if (changed.length) this.broadcast({ type: 'awareness', updates: changed }, from.id);
        return [];
      }
      case 'error':
        return [];
    }
  }

  /** Expires presence of peers that stopped sending heartbeats. */
  prunePresence(timeoutMs: number): void {
    const gone: AwarenessUpdate[] = [];
    for (const [client, p] of this.presence) {
      if (this.now() - p.seenAt > timeoutMs) {
        this.presence.delete(client);
        gone.push({ client, clock: p.update.clock + 1, state: null });
      }
    }
    if (gone.length) this.broadcast({ type: 'awareness', updates: gone });
  }

  presenceCount(): number {
    return this.presence.size;
  }

  private broadcast(msg: Msg, except?: string): void {
    for (const [id, c] of this.conns) if (id !== except) c.send(msg);
  }
}

/** Room registry. Persistence is injected so the hub stays transport- and storage-agnostic. */
export class Hub {
  readonly rooms = new Map<string, Room>();

  constructor(private readonly load: (room: string) => readonly Op[] = () => []) {}

  room(name: string): Room {
    let r = this.rooms.get(name);
    if (!r) {
      r = new Room(name, this.load(name));
      this.rooms.set(name, r);
    }
    return r;
  }
}
