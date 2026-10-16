import type { Hub } from '../src/sync/hub.js';
import { parseMsg, type Msg } from '../src/sync/protocol.js';
import type { Link } from '../src/sync/provider.js';

type Fn<T = void> = (arg: T) => void;

class Listeners {
  open: Array<Fn> = [];
  close: Array<Fn> = [];
  msg: Array<Fn<Msg>> = [];
}

/**
 * In-page network simulator: every message is delayed by `latency` ms (plus
 * random jitter, which reorders messages — the CRDT's causal buffer has to
 * cope with that), and links can be cut at any time.
 */
export class SimNetwork {
  latency = 150;
  jitter = false;
  inFlight = 0;
  private readonly listeners = new Set<() => void>();

  constructor(readonly hub: Hub) {}

  deliver(fn: () => void): void {
    this.inFlight++;
    const delay = this.latency + (this.jitter ? Math.random() * this.latency * 1.5 : 0);
    setTimeout(() => {
      this.inFlight--;
      fn();
      this.listeners.forEach((l) => l());
    }, delay);
  }

  onTraffic(fn: () => void): void {
    this.listeners.add(fn);
  }
}

let linkSeq = 0;

/** A peer's link to the in-page hub through the simulated network. */
export class SimLink implements Link {
  connected = false;
  private session = 0;
  private readonly l = new Listeners();
  private readonly connId = `sim-${linkSeq++}`;

  constructor(
    private readonly net: SimNetwork,
    private readonly room: string,
  ) {}

  connect(): void {
    if (this.connected) return;
    const s = ++this.session;
    this.connected = true;
    const room = this.net.hub.room(this.room);
    room.join({
      id: this.connId,
      send: (m) => {
        const copy = structuredClone(m);
        this.net.deliver(() => {
          if (this.session === s && this.connected) this.l.msg.forEach((f) => f(copy));
        });
      },
    });
    this.l.open.forEach((f) => f());
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.session++;
    this.net.hub.room(this.room).leave(this.connId);
    this.l.close.forEach((f) => f());
  }

  send(msg: Msg): void {
    if (!this.connected) return;
    const copy = structuredClone(msg);
    const room = this.net.hub.room(this.room);
    const conn = room.conns.get(this.connId);
    this.net.deliver(() => {
      if (conn) room.handle(conn, copy);
    });
  }

  onOpen(f: Fn): void {
    this.l.open.push(f);
  }
  onClose(f: Fn): void {
    this.l.close.push(f);
  }
  onMessage(f: Fn<Msg>): void {
    this.l.msg.push(f);
  }
}

/** Browser WebSocket link to the Node sync server, with automatic reconnect. */
export class WsLink implements Link {
  connected = false;
  private ws: WebSocket | null = null;
  private wanted = false;
  private retry = 0;
  private readonly l = new Listeners();

  constructor(private readonly url: string) {}

  connect(): void {
    this.wanted = true;
    if (this.ws) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retry = 0;
      this.connected = true;
      this.l.open.forEach((f) => f());
    };
    ws.onmessage = (e) => {
      const m = parseMsg(String(e.data));
      if (m && this.ws === ws) this.l.msg.forEach((f) => f(m));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.connected;
      this.connected = false;
      if (was) this.l.close.forEach((f) => f());
      if (this.wanted) setTimeout(() => this.wanted && this.connect(), Math.min(5000, 250 * 2 ** this.retry++));
    };
  }

  disconnect(): void {
    this.wanted = false;
    const ws = this.ws;
    this.ws = null;
    if (this.connected) {
      this.connected = false;
      this.l.close.forEach((f) => f());
    }
    ws?.close();
  }

  send(msg: Msg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  onOpen(f: Fn): void {
    this.l.open.push(f);
  }
  onClose(f: Fn): void {
    this.l.close.push(f);
  }
  onMessage(f: Fn<Msg>): void {
    this.l.msg.push(f);
  }
}

/**
 * Bridges the in-page hub to other tabs of the same browser over
 * BroadcastChannel. Each tab's hub is a full replica, so tabs form a mesh
 * using the very same hello/ops/awareness protocol as the WebSocket server.
 */
export function bridgeTabs(hub: Hub, room: string): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const bc = new BroadcastChannel(`crdt-collab:${room}`);
  const r = hub.room(room);
  const conn = { id: 'tabs', send: (m: Msg) => bc.postMessage(m) };
  r.join(conn);
  bc.onmessage = (e: MessageEvent) => {
    const m = parseMsg(e.data);
    if (m) r.handle(conn, m);
  };
  bc.postMessage({ type: 'hello', room, client: r.doc.clientId, vv: r.doc.versionVector(), reply: true } satisfies Msg);
  return () => {
    r.leave(conn.id);
    bc.close();
  };
}
