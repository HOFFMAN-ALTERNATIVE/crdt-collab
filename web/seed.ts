import { Doc, type Op } from '../src/crdt/doc.js';
import { Whiteboard } from '../src/crdt/whiteboard.js';

/**
 * Deterministic welcome content. Every tab/client generates byte-identical ops
 * under the reserved `seed` replica id, so seeding is idempotent: replicas
 * deduplicate them by version vector instead of duplicating the text.
 */
export function seedOps(): Op[] {
  const d = new Doc('seed');
  d.insertText(
    0,
    [
      'Welcome to CRDT//COLLAB',
      '',
      'Every panel is an independent replica of this document.',
      '1. Type in any panel - edits stream to the others.',
      '2. Flip a peer OFFLINE, keep editing on both sides.',
      '3. Bring it back online: replicas merge, no conflicts, no lost keystrokes.',
      '4. Crank latency + jitter to reorder packets, or unleash the chaos monkey.',
      '5. Open this page in a second tab: tabs sync over BroadcastChannel.',
      '',
    ].join('\n'),
  );
  const w = new Whiteboard(d);
  w.create({ id: 'seed-note', kind: 'note', x: 40, y: 40, w: 170, h: 110, fill: '#ffb000', text: 'Drag me while a peer is offline, then reconnect', points: [] });
  w.create({ id: 'seed-rect', kind: 'rect', x: 280, y: 90, w: 160, h: 100, fill: '#00e5ff', text: '', points: [] });
  w.create({ id: 'seed-ellipse', kind: 'ellipse', x: 520, y: 180, w: 150, h: 110, fill: '#ff2bd6', text: '', points: [] });
  return [...d.allOps()];
}
