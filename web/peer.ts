import { Awareness, type PresenceState } from '../src/crdt/awareness.js';
import { Doc } from '../src/crdt/doc.js';
import type { Id } from '../src/crdt/id.js';
import { Whiteboard, type Shape, type ShapeKind } from '../src/crdt/whiteboard.js';
import { Provider, type Link } from '../src/sync/provider.js';

const SVG = 'http://www.w3.org/2000/svg';
const COLORS = ['#00e5ff', '#ff2bd6', '#39ff14', '#ffb000', '#8a7dff'];
const BOARD_W = 800;
const BOARD_H = 420;

type Tool = 'select' | ShapeKind;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const rid = () => Math.random().toString(36).slice(2, 10);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** Computes a minimal single-splice diff between two strings. */
export function diff(a: string, b: string): { at: number; remove: number; insert: string } {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { at: p, remove: a.length - p - s, insert: b.slice(p, b.length - s) };
}

export interface PeerOptions {
  name: string;
  color: string;
  room: string;
  link: Link;
  onRemove?: () => void;
  latencyLabel?: () => string;
}

/** One simulated user: a replica, its provider and the UI bound to it. */
export class PeerView {
  readonly doc: Doc;
  readonly awareness: Awareness;
  readonly provider: Provider;
  readonly board: Whiteboard;
  readonly root: HTMLElement;

  private readonly textarea: HTMLTextAreaElement;
  private readonly mirror: HTMLElement;
  private readonly svgEl: SVGSVGElement;
  private readonly shapesLayer: SVGGElement;
  private readonly cursorsLayer: SVGGElement;
  private readonly stats: HTMLElement;
  private readonly toggle: HTMLInputElement;
  private lastText = '';
  private composing = false;
  private anchor: Id | null = null;
  private head: Id | null = null;
  private tool: Tool = 'select';
  private color = COLORS[0]!;
  private selected: string | null = null;
  private drag: { id: string; dx: number; dy: number } | null = null;
  private pen: { points: number[]; path: SVGPathElement } | null = null;
  private lastPointerSent = 0;
  private lastMoveSent = 0;
  private renderQueued = false;

  constructor(private readonly opts: PeerOptions) {
    const clientId = `${opts.name.toLowerCase()}-${rid()}`;
    this.doc = new Doc(clientId);
    this.awareness = new Awareness(clientId);
    this.board = new Whiteboard(this.doc);
    this.provider = new Provider(this.doc, this.awareness, opts.link, opts.room);
    this.awareness.setLocal({ name: opts.name, color: opts.color, cursor: null, pointer: null, selection: null });

    this.root = el('section', 'peer');
    this.root.style.setProperty('--peer', opts.color);
    const header = el('header', 'peer-head');
    header.innerHTML = `
      <span class="avatar"></span>
      <span class="peer-name">${esc(opts.name)}</span>
      <span class="peer-id" title="replica id">${esc(clientId)}</span>
      <label class="switch" title="Toggle network connection"><input type="checkbox" checked><span></span><em>ONLINE</em></label>
      ${opts.onRemove ? '<button class="icon close" title="Remove peer">✕</button>' : ''}`;
    this.toggle = header.querySelector('input')!;
    this.toggle.addEventListener('change', () => this.setOnline(this.toggle.checked));
    header.querySelector('.close')?.addEventListener('click', () => opts.onRemove?.());

    // ---- text editor
    const editor = el('div', 'editor');
    this.mirror = el('div', 'mirror');
    this.mirror.setAttribute('aria-hidden', 'true');
    this.textarea = el('textarea');
    this.textarea.spellcheck = false;
    this.textarea.setAttribute('aria-label', `${opts.name}'s copy of the shared document`);
    editor.append(this.mirror, this.textarea);
    this.textarea.addEventListener('compositionstart', () => (this.composing = true));
    this.textarea.addEventListener('compositionend', () => {
      this.composing = false;
      this.onInput();
    });
    this.textarea.addEventListener('input', () => !this.composing && this.onInput());
    for (const ev of ['select', 'keyup', 'mouseup', 'focus']) this.textarea.addEventListener(ev, () => this.captureSelection());
    this.textarea.addEventListener('scroll', () => (this.mirror.scrollTop = this.textarea.scrollTop));
    this.textarea.addEventListener('blur', () => this.provider.setPresence(this.awareness.setLocal({ cursor: null })));

    // ---- whiteboard
    const boardWrap = el('div', 'board');
    const toolbar = el('div', 'toolbar');
    const icon = (d: string) =>
      `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const tools: Array<[Tool, string, string]> = [
      ['select', icon('<path d="M5 3l14 8-6 2-2 6z"/>'), 'Select / move (V)'],
      ['rect', icon('<rect x="4" y="6" width="16" height="12" rx="1"/>'), 'Rectangle (R)'],
      ['ellipse', icon('<ellipse cx="12" cy="12" rx="8" ry="6"/>'), 'Ellipse (E)'],
      ['note', icon('<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5"/>'), 'Sticky note (N)'],
      ['path', icon('<path d="M3 17c3-6 5-6 7-2s4 4 7-3 3-4 4-4"/>'), 'Pen (P)'],
    ];
    for (const [t, icon, title] of tools) {
      const b = el('button', `tool${t === 'select' ? ' active' : ''}`, icon);
      b.title = title;
      b.dataset.tool = t;
      b.addEventListener('click', () => this.setTool(t));
      toolbar.append(b);
    }
    toolbar.append(el('span', 'sep'));
    for (const c of COLORS) {
      const b = el('button', `swatch${c === this.color ? ' active' : ''}`);
      b.style.setProperty('--sw', c);
      b.title = c;
      b.dataset.color = c;
      b.addEventListener('click', () => {
        this.color = c;
        toolbar.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', (s as HTMLElement).dataset.color === c));
        if (this.selected) this.board.update(this.selected, { fill: c });
      });
      toolbar.append(b);
    }
    toolbar.append(el('span', 'sep'));
    const del = el('button', 'tool', icon('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'));
    del.title = 'Delete selected (Del)';
    del.addEventListener('click', () => this.deleteSelected());
    const front = el('button', 'tool', icon('<rect x="8" y="8" width="12" height="12"/><path d="M4 16V4h12"/>'));
    front.title = 'Bring to front';
    front.addEventListener('click', () => this.selected && this.board.bringToFront(this.selected));
    toolbar.append(front, del);

    this.svgEl = svg('svg', { viewBox: `0 0 ${BOARD_W} ${BOARD_H}`, tabindex: 0, role: 'img' });
    this.svgEl.setAttribute('aria-label', `${opts.name}'s whiteboard`);
    const defs = svg('defs');
    defs.innerHTML = `<pattern id="grid-${clientId}" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="rgba(0,229,255,.07)"/></pattern>`;
    this.svgEl.append(defs, svg('rect', { width: BOARD_W, height: BOARD_H, fill: `url(#grid-${clientId})`, class: 'bg' }));
    this.shapesLayer = svg('g');
    this.cursorsLayer = svg('g', { class: 'cursors' });
    this.svgEl.append(this.shapesLayer, this.cursorsLayer);
    this.bindBoard();
    boardWrap.append(toolbar, this.svgEl);

    this.stats = el('footer', 'peer-stats');
    this.root.append(header, editor, boardWrap, this.stats);

    this.doc.onChange(() => {
      this.syncTextFromDoc(); // no-op for edits that came from this textarea
      this.queueRender();
    });
    this.awareness.onChange(() => this.queueRender());
    opts.link.onOpen(() => this.queueRender());
    opts.link.onClose(() => this.queueRender());
    opts.link.connect();
    this.queueRender();
  }

  get online(): boolean {
    return this.opts.link.connected;
  }

  setOnline(on: boolean): void {
    this.toggle.checked = on;
    this.root.classList.toggle('offline', !on);
    if (on) this.opts.link.connect();
    else this.opts.link.disconnect();
    this.queueRender();
  }

  destroy(): void {
    this.provider.destroy();
    this.root.remove();
  }

  // ------------------------------------------------------------------ text

  private onInput(): void {
    const next = this.textarea.value;
    const d = diff(this.lastText, next);
    if (d.remove) this.doc.deleteText(d.at, d.remove);
    if (d.insert) this.doc.insertText(d.at, d.insert);
    this.lastText = this.doc.getText();
    this.captureSelection();
  }

  private captureSelection(): void {
    const { selectionStart, selectionEnd, selectionDirection } = this.textarea;
    const [a, h] = selectionDirection === 'backward' ? [selectionEnd, selectionStart] : [selectionStart, selectionEnd];
    this.anchor = this.doc.text.idBefore(Math.min(a, this.doc.text.length));
    this.head = this.doc.text.idBefore(Math.min(h, this.doc.text.length));
    if (document.activeElement === this.textarea) {
      this.provider.setPresence(this.awareness.setLocal({ cursor: { anchor: this.anchor, head: this.head } }));
    }
  }

  /** Applies remote text changes while keeping the local caret anchored to character ids. */
  private syncTextFromDoc(): void {
    const text = this.doc.getText();
    if (text === this.textarea.value) return;
    const focused = document.activeElement === this.textarea;
    const a = this.doc.text.caretAfter(this.anchor);
    const h = this.doc.text.caretAfter(this.head);
    const scroll = this.textarea.scrollTop;
    this.textarea.value = text;
    this.lastText = text;
    if (focused) this.textarea.setSelectionRange(Math.min(a, h), Math.max(a, h), a > h ? 'backward' : 'forward');
    this.textarea.scrollTop = scroll;
  }

  private renderMirror(): void {
    const text = this.doc.getText();
    const marks: Array<{ at: number; color: string; name: string }> = [];
    for (const [, st] of this.awareness.peers()) {
      if (!st.cursor) continue;
      marks.push({ at: this.doc.text.caretAfter(st.cursor.head), color: st.color, name: st.name });
    }
    marks.sort((x, y) => x.at - y.at);
    let html = '';
    let pos = 0;
    for (const m of marks) {
      html += esc(text.slice(pos, m.at));
      html += `<span class="rcaret" style="--c:${esc(m.color)}"><b>${esc(m.name)}</b></span>`;
      pos = m.at;
    }
    html += esc(text.slice(pos)) + '\u200b';
    this.mirror.innerHTML = html;
    this.mirror.scrollTop = this.textarea.scrollTop;
  }

  // ------------------------------------------------------------ whiteboard

  private setTool(t: Tool): void {
    this.tool = t;
    this.root.querySelectorAll<HTMLElement>('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    this.svgEl.classList.toggle('drawing', t !== 'select');
  }

  private point(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const m = this.svgEl.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }

  private select(id: string | null): void {
    this.selected = id;
    this.provider.setPresence(this.awareness.setLocal({ selection: id }));
    this.queueRender();
  }

  private deleteSelected(): void {
    if (!this.selected) return;
    this.board.remove(this.selected);
    this.select(null);
  }

  private bindBoard(): void {
    const s = this.svgEl;
    s.addEventListener('pointerdown', (e) => {
      s.focus();
      const p = this.point(e);
      const target = (e.target as Element).closest<SVGElement>('[data-shape]');
      if (this.tool === 'select') {
        if (target) {
          const id = target.dataset.shape!;
          const shape = this.board.shapes().find((x) => x.id === id);
          if (!shape) return;
          this.select(id);
          this.drag = { id, dx: p.x - shape.x, dy: p.y - shape.y };
          s.setPointerCapture(e.pointerId);
        } else this.select(null);
        return;
      }
      if (this.tool === 'path') {
        const path = svg('path', { class: 'preview', stroke: this.color });
        this.shapesLayer.append(path);
        this.pen = { points: [p.x, p.y], path };
        s.setPointerCapture(e.pointerId);
        return;
      }
      const size = this.tool === 'note' ? { w: 150, h: 100 } : { w: 130, h: 85 };
      const id = rid();
      this.board.create({
        id,
        kind: this.tool,
        x: Math.round(p.x - size.w / 2),
        y: Math.round(p.y - size.h / 2),
        ...size,
        fill: this.color,
        text: this.tool === 'note' ? `${this.opts.name} was here` : '',
        points: [],
      });
      this.setTool('select');
      this.select(id);
    });
    s.addEventListener('pointermove', (e) => {
      const p = this.point(e);
      const now = performance.now();
      if (now - this.lastPointerSent > 40) {
        this.lastPointerSent = now;
        this.provider.setPresence(this.awareness.setLocal({ pointer: p }));
      }
      if (this.drag && now - this.lastMoveSent > 30) {
        this.lastMoveSent = now;
        this.board.update(this.drag.id, { x: p.x - this.drag.dx, y: p.y - this.drag.dy });
      }
      if (this.pen) {
        this.pen.points.push(p.x, p.y);
        this.pen.path.setAttribute('d', pathD(this.pen.points));
      }
    });
    const end = (e: PointerEvent) => {
      if (this.drag) {
        const p = this.point(e);
        this.board.update(this.drag.id, { x: p.x - this.drag.dx, y: p.y - this.drag.dy });
        this.drag = null;
      }
      if (this.pen) {
        const pts = this.pen.points;
        this.pen.path.remove();
        this.pen = null;
        if (pts.length >= 4) {
          const xs = pts.filter((_, i) => i % 2 === 0);
          const ys = pts.filter((_, i) => i % 2 === 1);
          const x = Math.min(...xs);
          const y = Math.min(...ys);
          this.board.create({
            id: rid(),
            kind: 'path',
            x,
            y,
            w: Math.max(...xs) - x,
            h: Math.max(...ys) - y,
            fill: this.color,
            text: '',
            points: pts.map((v, i) => (i % 2 === 0 ? v - x : v - y)),
          });
        }
      }
    };
    s.addEventListener('pointerup', end);
    s.addEventListener('pointercancel', end);
    s.addEventListener('pointerleave', () => this.provider.setPresence(this.awareness.setLocal({ pointer: null })));
    s.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelected();
      const map: Record<string, Tool> = { v: 'select', r: 'rect', e: 'ellipse', n: 'note', p: 'path' };
      const t = map[e.key.toLowerCase()];
      if (t) this.setTool(t);
    });
    s.addEventListener('dblclick', (e) => {
      const target = (e.target as Element).closest<SVGElement>('[data-shape]');
      const shape = target && this.board.shapes().find((x) => x.id === target.dataset.shape);
      if (shape?.kind === 'note') this.editNote(shape);
    });
  }

  private editNote(shape: Shape): void {
    const wrap = this.svgEl.parentElement!;
    const r = this.svgEl.getBoundingClientRect();
    const k = r.width / BOARD_W;
    const ta = el('textarea', 'note-edit');
    ta.value = shape.text;
    Object.assign(ta.style, {
      left: `${shape.x * k + (r.left - wrap.getBoundingClientRect().left)}px`,
      top: `${shape.y * k + (r.top - wrap.getBoundingClientRect().top)}px`,
      width: `${shape.w * k}px`,
      height: `${shape.h * k}px`,
    });
    wrap.append(ta);
    ta.focus();
    ta.select();
    const commit = () => {
      if (ta.isConnected) {
        if (ta.value !== shape.text) this.board.update(shape.id, { text: ta.value.slice(0, 500) });
        ta.remove();
      }
    };
    ta.addEventListener('blur', commit);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commit();
      }
      if (e.key === 'Escape') ta.remove();
    });
  }

  private renderBoard(): void {
    const peers = this.awareness.peers();
    const selectedBy = new Map<string, PresenceState>();
    for (const st of peers.values()) if (st.selection) selectedBy.set(st.selection, st);

    this.shapesLayer.replaceChildren();
    for (const sh of this.board.shapes()) {
      const g = svg('g', { 'data-shape': sh.id, class: `shape ${sh.kind}`, transform: `translate(${sh.x} ${sh.y})` });
      g.style.setProperty('--fill', sh.fill);
      if (sh.kind === 'rect' || sh.kind === 'note') {
        g.append(svg('rect', { width: sh.w, height: sh.h, rx: sh.kind === 'note' ? 4 : 2 }));
      } else if (sh.kind === 'ellipse') {
        g.append(svg('ellipse', { cx: sh.w / 2, cy: sh.h / 2, rx: sh.w / 2, ry: sh.h / 2 }));
      } else {
        g.append(svg('path', { d: pathD(sh.points) }));
      }
      if (sh.kind === 'note') {
        const t = svg('text', { x: 10, y: 22 });
        wrapText(sh.text, 18).slice(0, 4).forEach((line, i) => {
          const ts = svg('tspan', { x: 10, dy: i ? 18 : 0 });
          ts.textContent = line;
          t.append(ts);
        });
        g.append(t);
      }
      const remote = selectedBy.get(sh.id);
      if (sh.id === this.selected || remote) {
        g.append(
          svg('rect', {
            class: 'sel',
            x: -5,
            y: -5,
            width: sh.w + 10,
            height: sh.h + 10,
            stroke: sh.id === this.selected ? this.opts.color : remote!.color,
          }),
        );
      }
      this.shapesLayer.append(g);
    }

    this.cursorsLayer.replaceChildren();
    for (const st of peers.values()) {
      if (!st.pointer) continue;
      const g = svg('g', { transform: `translate(${st.pointer.x} ${st.pointer.y})`, class: 'rpointer' });
      g.append(svg('path', { d: 'M0 0 L0 16 L4 12 L8 20 L11 19 L7 11 L13 11 Z', fill: st.color }));
      const label = svg('text', { x: 14, y: 26, fill: st.color });
      label.textContent = st.name;
      g.append(label);
      this.cursorsLayer.append(g);
    }
  }

  // ---------------------------------------------------------------- render

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderMirror();
      this.renderBoard();
      this.renderStats();
    });
  }

  renderStats(): void {
    const online = this.online;
    this.root.classList.toggle('offline', !online);
    this.stats.innerHTML = `
      <span class="${online ? 'ok' : 'warn'}">${online ? '● LINKED' : '○ OFFLINE — edits queue locally'}</span>
      <span>ops ${this.doc.allOps().length}</span>
      <span>↑${this.provider.stats.sent} ↓${this.provider.stats.received}</span>
      <span title="ops waiting for causal dependencies">buffered ${this.doc.pendingCount()}</span>
      <span>peers ${this.awareness.peers().size}</span>
      <span class="fp" title="state fingerprint">#${this.doc.fingerprint()}</span>`;
  }
}

function pathD(points: number[]): string {
  let d = '';
  for (let i = 0; i + 1 < points.length; i += 2) d += `${i ? 'L' : 'M'}${points[i]} ${points[i + 1]}`;
  return d;
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if ((line + ' ' + word).trim().length > width && line) {
        out.push(line);
        line = word;
      } else line = (line + ' ' + word).trim();
    }
    out.push(line);
  }
  return out;
}
