import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Hub, type Conn, type Room } from '../sync/hub.js';
import { parseMsg, type Msg } from '../sync/protocol.js';
import { FileStore } from './store.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Directory for room snapshots; omit for in-memory only. */
  dataDir?: string;
  /** Directory with the built web client to serve at `/`. */
  staticDir?: string;
  maxPayload?: number;
  /** Token bucket per connection. */
  ratePerSec?: number;
  burst?: number;
  heartbeatMs?: number;
  presenceTimeoutMs?: number;
  /** Rooms are created on first hello; cap them so clients cannot exhaust memory. */
  maxRooms?: number;
  /** Allowed Origin values for WebSocket upgrades (empty = any). */
  allowedOrigins?: string[];
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface RunningServer {
  url: string;
  port: number;
  hub: Hub;
  close(): Promise<void>;
}

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Starts the HTTP + WebSocket sync server. */
export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const log = opts.log ?? (() => {});
  const store = opts.dataDir ? new FileStore(opts.dataDir) : null;
  const hub = new Hub((room) => store?.load(room) ?? []);
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const presenceTimeoutMs = opts.presenceTimeoutMs ?? 45_000;

  const http: Server = createServer((req, res) => handleHttp(req, res, hub, opts.staticDir));
  const wss = new WebSocketServer({
    server: http,
    path: '/ws',
    maxPayload: opts.maxPayload ?? 1 << 20,
    verifyClient: ({ origin }: { origin: string }) =>
      !opts.allowedOrigins?.length || opts.allowedOrigins.includes(origin),
  });

  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (ws) => {
    const id = randomUUID();
    const bucket = new TokenBucket(opts.ratePerSec ?? 200, opts.burst ?? 400);
    let room: Room | null = null;
    const conn: Conn = {
      id,
      send: (msg: Msg) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    };
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));

    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(1003, 'binary not supported');
      if (!bucket.take()) {
        conn.send({ type: 'error', message: 'rate limited' });
        return ws.close(1008, 'rate limited');
      }
      const msg = parseMsg(data.toString());
      if (!msg) {
        conn.send({ type: 'error', message: 'invalid message' });
        return ws.close(1007, 'invalid message');
      }
      if (msg.type === 'hello') {
        if (room && room.name !== msg.room) return ws.close(1008, 'one room per connection');
        if (!room) {
          if (!hub.rooms.has(msg.room) && hub.rooms.size >= (opts.maxRooms ?? 1000)) {
            conn.send({ type: 'error', message: 'room limit reached' });
            return ws.close(1013, 'room limit reached');
          }
          room = hub.room(msg.room);
          room.join(conn);
          log('join', { room: room.name, conn: id, peers: room.conns.size });
        }
      }
      if (!room) {
        conn.send({ type: 'error', message: 'send hello first' });
        return ws.close(1008, 'hello required');
      }
      try {
        const fresh = room.handle(conn, msg);
        if (fresh.length && store) {
          const r = room;
          store.schedule(r.name, () => r.doc.allOps());
        }
      } catch (err) {
        log('error', { err: String(err) });
        ws.close(1011, 'internal error');
      }
    });

    ws.on('close', () => {
      if (room) {
        room.leave(id);
        log('leave', { room: room.name, conn: id, peers: room.conns.size });
      }
    });
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
    for (const r of hub.rooms.values()) r.prunePresence(presenceTimeoutMs);
  }, heartbeatMs);

  await new Promise<void>((ok) => http.listen(opts.port ?? 8787, opts.host ?? '0.0.0.0', ok));
  const { port } = http.address() as AddressInfo;
  log('listening', { port });

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    port,
    hub,
    close: async () => {
      clearInterval(timer);
      store?.flush((name) => hub.rooms.get(name)?.doc.allOps() ?? []);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((ok) => wss.close(() => ok()));
      await new Promise<void>((ok) => http.close(() => ok()));
    },
  };
}

function handleHttp(req: IncomingMessage, res: ServerResponse, hub: Hub, staticDir?: string): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (url.pathname === '/api/rooms') {
    const rooms = [...hub.rooms.values()].map((r) => ({
      room: r.name,
      peers: r.conns.size,
      presence: r.presenceCount(),
      ops: r.doc.allOps().length,
      chars: r.doc.text.length,
      fingerprint: r.doc.fingerprint(),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(rooms));
    return;
  }
  if (staticDir && req.method === 'GET') {
    const root = resolve(staticDir);
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = join(root, rel || 'index.html');
    if (!file.startsWith(root + sep) && file !== root) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    if (existsSync(file)) {
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      createReadStream(file).pipe(res);
      return;
    }
  }
  res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
}
