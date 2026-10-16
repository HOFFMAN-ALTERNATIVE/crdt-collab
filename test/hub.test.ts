import { describe, expect, it } from 'vitest';
import { Awareness } from '../src/crdt/awareness.js';
import { Doc } from '../src/crdt/doc.js';
import { Hub, type Conn } from '../src/sync/hub.js';
import type { Msg } from '../src/sync/protocol.js';
import { Provider, type Link } from '../src/sync/provider.js';

/** Synchronous in-memory link between a Provider and a Hub room. */
class MemLink implements Link {
  connected = false;
  private open?: () => void;
  private close?: () => void;
  private msg?: (m: Msg) => void;
  private conn: Conn;
  static n = 0;
  constructor(
    private readonly hub: Hub,
    private readonly room: string,
  ) {
    this.conn = { id: `c${MemLink.n++}`, send: (m) => this.connected && this.msg?.(structuredClone(m)) };
  }
  connect() {
    this.connected = true;
    this.hub.room(this.room).join(this.conn);
    this.open?.();
  }
  disconnect() {
    this.connected = false;
    this.hub.room(this.room).leave(this.conn.id);
    this.close?.();
  }
  send(m: Msg) {
    if (this.connected) this.hub.room(this.room).handle(this.conn, structuredClone(m));
  }
  onOpen(f: () => void) {
    this.open = f;
  }
  onClose(f: () => void) {
    this.close = f;
  }
  onMessage(f: (m: Msg) => void) {
    this.msg = f;
  }
}

function peer(hub: Hub, name: string) {
  const doc = new Doc(name);
  const aw = new Awareness(name);
  const link = new MemLink(hub, 'room');
  const p = new Provider(doc, aw, link, 'room', 60_000);
  return { doc, aw, link, p };
}

describe('Hub + Provider', () => {
  it('syncs live edits, offline edits and late joiners', () => {
    const hub = new Hub();
    const a = peer(hub, 'alice');
    const b = peer(hub, 'bob');
    a.link.connect();
    b.link.connect();
    a.doc.insertText(0, 'hello');
    expect(b.doc.getText()).toBe('hello');

    // bob goes offline and both keep editing
    b.link.disconnect();
    a.doc.insertText(5, ' world');
    b.doc.insertText(0, '>> ');
    b.doc.set('title', 'offline');
    expect(a.doc.getText()).toBe('hello world');

    b.link.connect(); // handshake ships missing ops both ways
    expect(a.doc.getText()).toBe('>> hello world');
    expect(b.doc.fingerprint()).toBe(a.doc.fingerprint());
    expect(hub.room('room').doc.fingerprint()).toBe(a.doc.fingerprint());

    const c = peer(hub, 'carol'); // late joiner catches up from the hub alone
    a.link.disconnect();
    b.link.disconnect();
    c.link.connect();
    expect(c.doc.getText()).toBe('>> hello world');
    expect(c.doc.map.get('title')).toBe('offline');
    [a, b, c].forEach((x) => x.p.destroy());
  });

  it('relays presence and clears it when a peer disconnects', () => {
    const hub = new Hub();
    const a = peer(hub, 'alice');
    const b = peer(hub, 'bob');
    a.link.connect();
    a.p.setPresence(a.aw.setLocal({ name: 'Alice', color: '#f0f', cursor: { anchor: null, head: null } }));
    b.link.connect(); // receives existing presence on hello
    expect(b.aw.peers().get('alice')?.name).toBe('Alice');
    a.link.disconnect();
    expect(b.aw.peers().size).toBe(0);
    [a, b].forEach((x) => x.p.destroy());
  });

  it('loads persisted state for a room', () => {
    const src = new Doc('x');
    src.insertText(0, 'restored');
    const hub = new Hub(() => src.allOps());
    const a = peer(hub, 'alice');
    a.link.connect();
    expect(a.doc.getText()).toBe('restored');
    a.p.destroy();
  });
});
