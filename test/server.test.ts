import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Awareness } from '../src/crdt/awareness.js';
import { Doc } from '../src/crdt/doc.js';
import { parseMsg, type Msg } from '../src/sync/protocol.js';
import { Provider, type Link } from '../src/sync/provider.js';
import { startServer, type RunningServer } from '../src/server/server.js';

/** Node WebSocket link with reconnect-on-demand, mirroring the browser one. */
class WsLink implements Link {
  connected = false;
  private ws?: WebSocket;
  private open: Array<() => void> = [];
  private close: Array<() => void> = [];
  private msg: Array<(m: Msg) => void> = [];
  constructor(private readonly url: string) {}
  connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.open.forEach((f) => f());
    });
    ws.on('message', (d) => {
      const m = parseMsg(d.toString());
      if (m) this.msg.forEach((f) => f(m));
    });
    ws.on('close', () => {
      if (this.ws !== ws) return; // a stale socket closing after a reconnect
      this.connected = false;
      this.close.forEach((f) => f());
    });
  }
  disconnect() {
    this.connected = false;
    this.ws?.close();
  }
  send(m: Msg) {
    this.ws?.send(JSON.stringify(m));
  }
  onOpen(f: () => void) {
    this.open.push(f);
  }
  onClose(f: () => void) {
    this.close.push(f);
  }
  onMessage(f: (m: Msg) => void) {
    this.msg.push(f);
  }
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let server: RunningServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await server?.close();
  server = undefined;
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function client(url: string, name: string, room = 'r1') {
  const doc = new Doc(name);
  const aw = new Awareness(name);
  const link = new WsLink(url);
  const p = new Provider(doc, aw, link, room, 60_000);
  return { doc, aw, link, p };
}

describe('WebSocket sync server', () => {
  it('converges three clients with concurrent and offline edits', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const [a, b, c] = ['a', 'b', 'c'].map((n) => client(server!.url, n));
    [a, b, c].forEach((x) => x!.link.connect());
    await until(() => a!.link.connected && b!.link.connected && c!.link.connected);

    a!.doc.insertText(0, 'shared ');
    await until(() => c!.doc.getText() === 'shared ');

    c!.link.disconnect();
    await until(() => !c!.link.connected);
    a!.doc.insertText(7, 'doc');
    b!.doc.insertText(0, '# ');
    c!.doc.insertText(7, 'OFFLINE ');
    c!.doc.set('k', 'v');

    c!.link.connect();
    const fp = () => a!.doc.fingerprint();
    await until(() => [b, c].every((x) => x!.doc.fingerprint() === fp()) && a!.doc.map.get('k') === 'v');
    expect(a!.doc.getText()).toContain('OFFLINE');
    expect(a!.doc.getText().startsWith('# shared ')).toBe(true);
    [a, b, c].forEach((x) => x!.p.destroy());
  });

  it('isolates rooms, relays presence and exposes stats', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const a = client(server.url, 'a', 'room-1');
    const b = client(server.url, 'b', 'room-1');
    const x = client(server.url, 'x', 'room-2');
    [a, b, x].forEach((p) => p.link.connect());
    await until(() => a.link.connected && b.link.connected && x.link.connected);
    a.p.setPresence(a.aw.setLocal({ name: 'Ada', color: '#0ff' }));
    a.doc.insertText(0, 'only room 1');
    await until(() => b.doc.getText() === 'only room 1' && b.aw.peers().has('a'));
    await new Promise((r) => setTimeout(r, 50));
    expect(x.doc.getText()).toBe('');
    expect(x.aw.peers().size).toBe(0);

    const res = await fetch(`http://127.0.0.1:${server.port}/api/rooms`);
    const rooms = (await res.json()) as Array<{ room: string; peers: number; fingerprint: string }>;
    expect(rooms.find((r) => r.room === 'room-1')).toMatchObject({ peers: 2, fingerprint: a.doc.fingerprint() });
    [a, b, x].forEach((p) => p.p.destroy());
  });

  it('persists rooms across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crdt-'));
    dirs.push(dir);
    server = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir });
    const a = client(server.url, 'a');
    a.link.connect();
    await until(() => a.link.connected);
    a.doc.insertText(0, 'durable');
    await until(() => server!.hub.room('r1').doc.getText() === 'durable');
    a.p.destroy();
    await server.close(); // flushes snapshot

    server = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir });
    const b = client(server.url, 'b');
    b.link.connect();
    await until(() => b.doc.getText() === 'durable');
    b.p.destroy();
  });

  it('rejects invalid messages, missing hello and floods', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', ratePerSec: 1, burst: 3 });
    const closeCode = (send: (ws: WebSocket) => void) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(server!.url);
        ws.on('open', () => send(ws));
        ws.on('close', (code) => resolve(code));
      });
    expect(await closeCode((ws) => ws.send('{"type":"ops","ops":[{"t":"evil"}]}'))).toBe(1007);
    expect(await closeCode((ws) => ws.send(JSON.stringify({ type: 'ops', ops: [] })))).toBe(1008);
    expect(
      await closeCode((ws) => {
        ws.send(JSON.stringify({ type: 'hello', room: 'r', client: 'c', vv: {}, reply: false }));
        for (let i = 0; i < 10; i++) ws.send(JSON.stringify({ type: 'awareness', updates: [] }));
      }),
    ).toBe(1008);
    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(health.status).toBe(200);
  });

  it('refuses new rooms past maxRooms but still admits existing ones', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', maxRooms: 1 });
    const hello = (room: string) =>
      new Promise<number | 'open'>((resolve) => {
        const ws = new WebSocket(server!.url);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'hello', room, client: `c-${room}`, vv: {}, reply: false }));
          setTimeout(() => {
            ws.close();
            resolve('open');
          }, 200);
        });
        ws.on('close', (code) => resolve(code));
      });
    expect(await hello('first')).toBe('open');
    expect(await hello('second')).toBe(1013);
    expect(await hello('first')).toBe('open');
  });
});
