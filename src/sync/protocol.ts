import type { AwarenessUpdate, PresenceState } from '../crdt/awareness.js';
import type { Op, VersionVector } from '../crdt/doc.js';
import type { Id } from '../crdt/id.js';

/**
 * Wire protocol (JSON). Symmetric: the same messages flow client→server,
 * server→client and tab↔tab.
 *
 *  hello      "this is what I have" (version vector). The receiver answers with
 *             `ops` containing everything the sender is missing and, if
 *             `reply` is set, with its own hello so the sender can push back
 *             what *it* has that the receiver lacks (offline edits).
 *  ops        operations to integrate; relays forward only newly applied ops.
 *  awareness  ephemeral presence (cursor, pointer, name, colour).
 */
export type Msg =
  | { type: 'hello'; room: string; client: string; vv: VersionVector; reply: boolean }
  | { type: 'ops'; ops: Op[] }
  | { type: 'awareness'; updates: AwarenessUpdate[] }
  | { type: 'error'; message: string };

export const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CLIENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_OPS_PER_MSG = 10_000;
const MAX_TEXT = 100_000;
const MAX_KEY = 256;
const MAX_VALUE_JSON = 64 * 1024;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNat = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const isPos = (x: unknown): x is number => isNat(x) && x > 0;

export function isId(x: unknown): x is Id {
  return isObj(x) && typeof x.client === 'string' && CLIENT_RE.test(x.client) && isPos(x.clock);
}

export function isOp(x: unknown): x is Op {
  if (!isObj(x) || !isId(x.id) || !isPos(x.seq)) return false;
  switch (x.t) {
    case 'ins':
      return (x.after === null || isId(x.after)) && typeof x.text === 'string' && x.text.length > 0 && x.text.length <= MAX_TEXT;
    case 'del':
      return Array.isArray(x.targets) && x.targets.length > 0 && x.targets.length <= MAX_TEXT && x.targets.every(isId);
    case 'set':
      return (
        typeof x.key === 'string' &&
        x.key.length > 0 &&
        x.key.length <= MAX_KEY &&
        'value' in x &&
        JSON.stringify(x.value ?? null).length <= MAX_VALUE_JSON
      );
    default:
      return false;
  }
}

function isPresence(x: unknown): x is PresenceState {
  return isObj(x) && typeof x.name === 'string' && x.name.length <= 64 && typeof x.color === 'string' && x.color.length <= 32;
}

function isVV(x: unknown): x is VersionVector {
  return isObj(x) && Object.entries(x).every(([k, v]) => CLIENT_RE.test(k) && isNat(v));
}

/** Parses and validates an untrusted message. Returns null if invalid. */
export function parseMsg(raw: unknown): Msg | null {
  let m: unknown = raw;
  if (typeof raw === 'string') {
    try {
      m = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObj(m)) return null;
  switch (m.type) {
    case 'hello':
      return typeof m.room === 'string' && ROOM_RE.test(m.room) && typeof m.client === 'string' && CLIENT_RE.test(m.client) && isVV(m.vv) && typeof m.reply === 'boolean'
        ? (m as Msg)
        : null;
    case 'ops':
      return Array.isArray(m.ops) && m.ops.length <= MAX_OPS_PER_MSG && m.ops.every(isOp) ? (m as Msg) : null;
    case 'awareness':
      return Array.isArray(m.updates) &&
        m.updates.length <= 256 &&
        m.updates.every((u) => isObj(u) && typeof u.client === 'string' && CLIENT_RE.test(u.client) && isNat(u.clock) && (u.state === null || isPresence(u.state)))
        ? (m as Msg)
        : null;
    case 'error':
      return typeof m.message === 'string' ? (m as Msg) : null;
    default:
      return null;
  }
}
