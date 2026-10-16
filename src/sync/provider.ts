import type { Awareness } from '../crdt/awareness.js';
import type { Doc, Op } from '../crdt/doc.js';
import type { Msg } from './protocol.js';

/** Client side of a transport. */
export interface Link {
  readonly connected: boolean;
  connect(): void;
  disconnect(): void;
  send(msg: Msg): void;
  onOpen(fn: () => void): void;
  onClose(fn: () => void): void;
  onMessage(fn: (msg: Msg) => void): void;
}

export interface ProviderStats {
  sent: number;
  received: number;
}

/**
 * Binds a document and its awareness to a link: handshake on (re)connect,
 * push local ops while online, and catch up in both directions after an
 * offline period. Offline edits simply accumulate in the op log; the version
 * vector exchange in `hello` ships exactly the missing ops each way.
 */
export class Provider {
  readonly stats: ProviderStats = { sent: 0, received: 0 };
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly unsub: Array<() => void> = [];

  constructor(
    readonly doc: Doc,
    readonly awareness: Awareness,
    readonly link: Link,
    readonly room: string,
    heartbeatMs = 10_000,
  ) {
    link.onOpen(() => {
      this.send({ type: 'hello', room, client: doc.clientId, vv: doc.versionVector(), reply: true });
      const me = awareness.localUpdate();
      if (me) this.send({ type: 'awareness', updates: [me] });
    });
    link.onMessage((m) => this.receive(m));
    this.unsub.push(
      doc.onChange((e) => {
        if (e.local) this.send({ type: 'ops', ops: e.ops });
      }),
    );
    this.heartbeat = setInterval(() => {
      const me = awareness.localUpdate();
      if (me) this.send({ type: 'awareness', updates: [me] });
      awareness.prune();
    }, heartbeatMs);
  }

  /** Broadcasts a presence patch. */
  setPresence(update: ReturnType<Awareness['setLocal']>): void {
    this.send({ type: 'awareness', updates: [update] });
  }

  private send(msg: Msg): void {
    if (!this.link.connected) return;
    if (msg.type === 'ops') this.stats.sent += msg.ops.length;
    this.link.send(msg);
  }

  private receive(msg: Msg): void {
    switch (msg.type) {
      case 'hello': {
        // Peer told us what it has: push what it is missing (our offline edits).
        const missing: Op[] = this.doc.opsSince(msg.vv);
        if (missing.length) this.send({ type: 'ops', ops: missing });
        break;
      }
      case 'ops':
        this.stats.received += msg.ops.length;
        this.doc.applyRemote(msg.ops);
        break;
      case 'awareness':
        for (const u of msg.updates) this.awareness.apply(u);
        break;
      case 'error':
        break;
    }
  }

  destroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.unsub.forEach((f) => f());
    if (this.link.connected) this.link.send({ type: 'awareness', updates: [this.awareness.leave()] });
    this.link.disconnect();
  }
}
