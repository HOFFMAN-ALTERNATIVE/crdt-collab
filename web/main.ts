import './style.css';
import type { Op } from '../src/crdt/doc.js';
import { Hub } from '../src/sync/hub.js';
import { ROOM_RE } from '../src/sync/protocol.js';
import { PeerView } from './peer.js';
import { seedOps } from './seed.js';
import { bridgeTabs, SimLink, SimNetwork, WsLink } from './transports.js';

const PEOPLE: Array<[string, string]> = [
  ['Ada', '#00e5ff'],
  ['Linus', '#ff2bd6'],
  ['Grace', '#39ff14'],
  ['Alan', '#ffb000'],
];

const params = new URLSearchParams(location.search);
const room = ROOM_RE.test(params.get('room') ?? '') ? params.get('room')! : 'lobby';
const wsUrl = params.get('ws');
const storageKey = `crdt-collab:${room}`;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const grid = $('#peers');
const peers: PeerView[] = [];

// ---------------------------------------------------------------- network

let net: SimNetwork | null = null;
let hub: Hub | null = null;

if (wsUrl) {
  $('#mode').textContent = `WEBSOCKET · ${wsUrl}`;
  document.body.classList.add('ws-mode');
} else {
  hub = new Hub((name) => {
    try {
      return JSON.parse(localStorage.getItem(`crdt-collab:${name}`) ?? '[]') as Op[];
    } catch {
      return [];
    }
  });
  const r = hub.room(room);
  if (r.doc.allOps().length === 0) r.doc.applyRemote(seedOps());
  net = new SimNetwork(hub);
  net.onTraffic(() => queueStatus());
  bridgeTabs(hub, room);
  // Offline-first: persist the hub replica so a reload keeps the document.
  let saveTimer = 0;
  r.doc.onChange(() => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(r.doc.allOps()));
      } catch {
        /* quota exceeded: keep running in memory */
      }
    }, 400);
  });
  setInterval(() => r.prunePresence(30_000), 5_000);
  $('#mode').textContent = `SIMULATED NETWORK · room "${room}" · multi-tab via BroadcastChannel`;
}

function addPeer(): void {
  if (peers.length >= PEOPLE.length) return;
  const used = new Set(peers.map((p) => p.awareness.localUpdate()?.state?.name));
  const [name, color] = PEOPLE.find(([n]) => !used.has(n))!;
  const link = wsUrl ? new WsLink(wsUrl) : new SimLink(net!, room);
  const view: PeerView = new PeerView({
    name,
    color,
    room,
    link,
    onRemove: () => {
      peers.splice(peers.indexOf(view), 1);
      view.destroy();
      layout();
    },
  });
  if (wsUrl && peers.length === 0) view.doc.applyRemote(seedOps());
  view.doc.onChange(() => queueStatus());
  link.onOpen(() => queueStatus());
  link.onClose(() => queueStatus());
  peers.push(view);
  grid.append(view.root);
  layout();
}

function layout(): void {
  grid.dataset.count = String(peers.length);
  $<HTMLButtonElement>('#add').disabled = peers.length >= PEOPLE.length;
  queueStatus();
}

// ---------------------------------------------------------------- status

let statusQueued = false;
function queueStatus(): void {
  if (statusQueued) return;
  statusQueued = true;
  requestAnimationFrame(() => {
    statusQueued = false;
    renderStatus();
  });
}

function renderStatus(): void {
  const fps = peers.map((p) => p.doc.fingerprint());
  if (hub) fps.push(hub.room(room).doc.fingerprint());
  const allSame = fps.every((f) => f === fps[0]);
  const offline = peers.filter((p) => !p.online).length;
  const inFlight = net?.inFlight ?? 0;
  const pending = peers.reduce((n, p) => n + p.doc.pendingCount(), 0);
  const box = $('#status');
  let cls: string;
  let label: string;
  if (allSame && inFlight === 0) {
    cls = 'ok';
    label = `CONVERGED · #${fps[0] ?? '--------'}`;
  } else if (offline > 0 && inFlight === 0) {
    cls = 'warn';
    label = `PARTITIONED · ${offline} peer${offline > 1 ? 's' : ''} offline · ${new Set(fps).size} divergent states`;
  } else {
    cls = 'sync';
    label = `SYNCING · ${inFlight} msg in flight${pending ? ` · ${pending} buffered` : ''}`;
  }
  box.className = `status ${cls}`;
  box.textContent = label;
  peers.forEach((p) => p.renderStats());
}

// ---------------------------------------------------------------- controls

const latency = $<HTMLInputElement>('#latency');
const latencyOut = $('#latency-out');
latency.addEventListener('input', () => {
  if (net) net.latency = Number(latency.value);
  latencyOut.textContent = `${latency.value} ms`;
});
$<HTMLInputElement>('#jitter').addEventListener('change', (e) => {
  if (net) net.jitter = (e.target as HTMLInputElement).checked;
});
$('#add').addEventListener('click', addPeer);
$('#partition').addEventListener('click', () => peers.forEach((p) => p.setOnline(false)));
$('#heal').addEventListener('click', () => peers.forEach((p) => p.setOnline(true)));
$('#reset').addEventListener('click', () => {
  localStorage.removeItem(storageKey);
  location.reload();
});

// Chaos monkey: random edits from random peers plus random link flaps.
let chaos = 0;
const WORDS = ['crdt ', 'merge ', 'lamport ', 'replica ', 'causal ', 'offline ', 'sync ', '⚡ ', 'tombstone '];
$<HTMLInputElement>('#chaos').addEventListener('change', (e) => {
  clearInterval(chaos);
  if (!(e.target as HTMLInputElement).checked) return;
  chaos = window.setInterval(() => {
    const p = peers[Math.floor(Math.random() * peers.length)];
    if (!p) return;
    const r = Math.random();
    const len = p.doc.text.length;
    if (r < 0.55) p.doc.insertText(Math.floor(Math.random() * (len + 1)), WORDS[Math.floor(Math.random() * WORDS.length)]!);
    else if (r < 0.8 && len > 200) p.doc.deleteText(Math.floor(Math.random() * len), 1 + Math.floor(Math.random() * 6));
    else if (r < 0.92) {
      const shapes = p.board.shapes();
      const s = shapes[Math.floor(Math.random() * shapes.length)];
      if (s) p.board.update(s.id, { x: Math.max(0, Math.min(680, s.x + Math.round((Math.random() - 0.5) * 120))), y: Math.max(0, Math.min(320, s.y + Math.round((Math.random() - 0.5) * 80))) });
    } else p.setOnline(!p.online);
  }, 180);
});

addPeer();
addPeer();
setInterval(renderStatus, 1000);
