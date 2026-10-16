import type { Doc } from './doc.js';
import type { Json } from './lww.js';

export type ShapeKind = 'rect' | 'ellipse' | 'note' | 'path';

export interface Shape {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  text: string;
  points: number[]; // path: flat [x0,y0,x1,y1,...] relative to (x, y)
  z: number;
}

const PREFIX = 'shape/';
const FIELDS = ['kind', 'x', 'y', 'w', 'h', 'fill', 'text', 'points', 'z'] as const;
type Field = (typeof FIELDS)[number];

/**
 * Whiteboard model on top of the document's LWW map. Each shape field is its
 * own register (`shape/<id>/<field>`), so concurrent edits to *different*
 * fields of the same shape (one user moves it, another recolours it) both
 * survive; concurrent edits to the same field resolve last-writer-wins.
 * Deletion is a separate `deleted` register, so delete beats a concurrent move.
 */
export class Whiteboard {
  constructor(private readonly doc: Doc) {}

  create(shape: Omit<Shape, 'z'> & { z?: number }): void {
    const z = shape.z ?? this.doc.now() + 1;
    for (const f of FIELDS) {
      const v = f === 'z' ? z : (shape[f] as Json);
      this.doc.set(`${PREFIX}${shape.id}/${f}`, v);
    }
  }

  update(id: string, patch: Partial<Pick<Shape, Field>>): void {
    for (const [f, v] of Object.entries(patch)) {
      if ((FIELDS as readonly string[]).includes(f)) this.doc.set(`${PREFIX}${id}/${f}`, v as Json);
    }
  }

  bringToFront(id: string): void {
    this.doc.set(`${PREFIX}${id}/z`, this.doc.now() + 1);
  }

  remove(id: string): void {
    this.doc.set(`${PREFIX}${id}/deleted`, true);
  }

  /** Live shapes sorted by z (then id, for determinism). */
  shapes(): Shape[] {
    const byId = new Map<string, Record<string, Json>>();
    for (const [key, value] of Object.entries(this.doc.map.toObject())) {
      if (!key.startsWith(PREFIX)) continue;
      const rest = key.slice(PREFIX.length);
      const slash = rest.lastIndexOf('/');
      const id = rest.slice(0, slash);
      const field = rest.slice(slash + 1);
      let rec = byId.get(id);
      if (!rec) byId.set(id, (rec = {}));
      rec[field] = value;
    }
    const out: Shape[] = [];
    for (const [id, r] of byId) {
      if (r.deleted === true || typeof r.kind !== 'string') continue;
      out.push({
        id,
        kind: r.kind as ShapeKind,
        x: num(r.x),
        y: num(r.y),
        w: num(r.w),
        h: num(r.h),
        fill: typeof r.fill === 'string' ? r.fill : '#00e5ff',
        text: typeof r.text === 'string' ? r.text : '',
        points: Array.isArray(r.points) ? r.points.map(num) : [],
        z: num(r.z),
      });
    }
    return out.sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1));
  }
}

const num = (v: Json | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
