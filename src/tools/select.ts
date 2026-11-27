import { app } from '../app';
import { t } from '../i18n';
import { Tool, PEvent } from './tool';
import { Selection, SelMode } from '../core/selection';
import { floodMask } from '../core/fill';
import { numberField, checkbox, segmented, sep } from '../ui/controls';
import { iconCursor, arrowBadgeCursor } from '../ui/icons';
import { snapPoint, clearSmart } from '../core/snap';

/** Selection mode from modifiers at the start of an operation (Photoshop conventions). */
export function modeFromEvent(e: { shift: boolean; alt: boolean }, def: SelMode): SelMode {
  if (e.shift && e.alt) return 'intersect';
  if (e.shift) return 'add';
  if (e.alt) return 'subtract';
  return def;
}

export function modeButtons(value: SelMode, onChange: (m: SelMode) => void) {
  return segmented<SelMode>([
    { value: 'new', icon: 'modeNew', title: t('opt.mode.new') },
    { value: 'add', icon: 'modeAdd', title: t('opt.mode.add') + ' (Shift)' },
    { value: 'subtract', icon: 'modeSub', title: t('opt.mode.subtract') + ' (Alt)' },
    { value: 'intersect', icon: 'modeInt', title: t('opt.mode.intersect') + ' (Shift+Alt)' },
  ], value, onChange);
}

/**
 * Arrow keys with a selection tool move the selection outline (not the pixels) by a pixel, with Shift by
 * ten, as Photoshop's Nudge Outline; each press is a step in History.
 */
export function nudgeSelection(e: KeyboardEvent): boolean {
  const k = e.key;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k) || e.ctrlKey || e.altKey || e.metaKey) return false;
  const d = app.doc;
  if (!d?.selection) return false;
  const n = e.shiftKey ? 10 : 1;
  const dx = k === 'ArrowLeft' ? -n : k === 'ArrowRight' ? n : 0;
  const dy = k === 'ArrowUp' ? -n : k === 'ArrowDown' ? n : 0;
  const moved = d.selection.translate(dx, dy);
  if (!moved) return true;   // it would leave the document entirely: it stays where it is
  d.selection = moved;
  app.commit('h.nudgeSel');
  app.update('overlay');
  return true;
}

export function applySelection(shape: Selection | null, mode: SelMode, feather = 0) {
  const d = app.doc!;
  if (shape && feather > 0) shape = shape.feather(feather);
  const before = d.selection;
  d.selection = Selection.combine(d.selection, shape, mode, d.width, d.height);
  if (d.selection !== before) {
    if (!d.selection) app.lastSelection = before;
    app.commit(d.selection ? 'h.select' : 'h.deselect');
  }
  app.update('overlay');
}

/* ---------------- Marquee ---------------- */
interface MarqueeOpts { shape: 'rect' | 'ellipse'; mode: SelMode; feather: number; antialias: boolean }

export class MarqueeTool extends Tool<MarqueeOpts> {
  readonly id = 'marquee';
  readonly key = 'M';
  get iconName() { return this.o.shape === 'ellipse' ? 'ellipse' : 'marquee'; }
  private start: { x: number; y: number } | null = null;
  private cur: { x: number; y: number } | null = null;
  private mode: SelMode = 'new';
  private modsAtStart = { shift: false, alt: false };
  private live = { shift: false, alt: false };

  constructor() { super({ shape: 'rect', mode: 'new', feather: 0, antialias: true }); }

  keydown(e: KeyboardEvent) { return !this.busy?.() && nudgeSelection(e); }

  down(e: PEvent) {
    this.mode = modeFromEvent(e, this.o.mode);
    this.modsAtStart = { shift: e.shift, alt: e.alt };
    this.start = snapPoint(e.x, e.y);
    this.cur = { ...this.start };
  }

  move(e: PEvent) {
    if (!this.start) return;
    this.cur = snapPoint(e.x, e.y);
    this.live = { shift: e.shift && !this.modsAtStart.shift, alt: e.alt && !this.modsAtStart.alt };
  }

  private rect() {
    const s = this.start!, c = this.cur!;
    let w = c.x - s.x, h = c.y - s.y;
    if (this.live.shift) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
    let x = s.x, y = s.y;
    if (this.live.alt) { x = s.x - w; y = s.y - h; w *= 2; h *= 2; }
    const x0 = Math.min(x, x + w), y0 = Math.min(y, y + h);
    const snap = this.o.shape === 'rect';
    if (snap) {
      const rx = Math.round(x0), ry = Math.round(y0);
      return { x: rx, y: ry, w: Math.round(x0 + Math.abs(w)) - rx, h: Math.round(y0 + Math.abs(h)) - ry };
    }
    return { x: x0, y: y0, w: Math.abs(w), h: Math.abs(h) };
  }

  up() {
    if (!this.start) return;
    const r = this.rect();
    this.start = null;
    clearSmart();
    const d = app.doc!;
    if (r.w < 1 || r.h < 1) {
      if (this.mode === 'new' && d.selection) applySelection(null, 'new');
      return;
    }
    const shape = Selection.fromDraw(d.width, d.height, g => {
      g.imageSmoothingEnabled = this.o.antialias;
      if (this.o.shape === 'rect') g.fillRect(r.x, r.y, r.w, r.h);
      else { g.beginPath(); g.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2); g.fill(); }
    });
    applySelection(shape, this.mode, this.o.feather);
  }

  cancel() { this.start = null; app.update('overlay'); }

  overlay(g: CanvasRenderingContext2D) {
    if (!this.start || !this.cur) return;
    const r = this.rect();
    const v = app.viewport;
    const a = v.toScreen(r.x, r.y), b = v.toScreen(r.x + r.w, r.y + r.h);
    g.save();
    g.beginPath();
    if (this.o.shape === 'rect') g.rect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
    else g.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    g.fillStyle = 'rgba(91,140,255,0.08)'; g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke();
    g.setLineDash([4, 4]); g.strokeStyle = '#000'; g.stroke();
    g.restore();
    app.statusbar.setCursor({ x: r.w, y: r.h });
  }

  options() {
    return [
      segmented<'rect' | 'ellipse'>([
        { value: 'rect', icon: 'marquee', title: t('opt.rect') },
        { value: 'ellipse', icon: 'ellipse', title: t('opt.ellipse') },
      ], this.o.shape, v => { this.set('shape', v); app.update('options'); }),
      sep(),
      modeButtons(this.o.mode, m => this.set('mode', m)),
      sep(),
      numberField({ label: t('opt.feather'), value: this.o.feather, min: 0, max: 250, unit: 'px', onChange: v => this.set('feather', v) }),
      this.o.shape === 'ellipse' ? checkbox(t('opt.antialias'), this.o.antialias, v => this.set('antialias', v)) : null,
    ];
  }
}

/* ---------------- Lasso: freehand, polygonal, magnetic ---------------- */
type LassoType = 'free' | 'poly' | 'magnetic';
interface LassoOpts { type: LassoType; mode: SelMode; feather: number; antialias: boolean }
type P = { x: number; y: number };
const LASSO_ICONS: Record<LassoType, string> = { free: 'freeLasso', poly: 'polyLasso', magnetic: 'magLasso' };

/**
 * One lasso tool; the type is chosen in the options bar (like the marquee's rectangle/ellipse):
 * freehand (drag), polygonal (click points) and magnetic (move along an edge: the path follows the
 * strongest contrast between the last anchor and the cursor, anchors are added automatically).
 *
 * With Ctrl (Cmd) held, an open polygonal or magnetic outline waits and its points can be dragged (as the pen's
 * points with Ctrl in Photoshop): a point missed fifteen points back is put right without removing all the
 * later ones. A magnetic outline's two stretches beside the point follow the edge again; a polygon's stay
 * straight. Released, the outline goes on from its last point.
 */
export class LassoTool extends Tool<LassoOpts> {
  readonly id = 'lasso';
  readonly key = 'L';
  // the toolbar shows the chosen type (as the marquee shows rectangle or ellipse)
  get iconName() { return this.typeIcon; }
  private get typeIcon() { return LASSO_ICONS[this.o.type] ?? 'freeLasso'; }
  cursor = arrowBadgeCursor('freeLasso');
  private pts: P[] = [];
  private hoverPt: P | null = null;
  private mode: SelMode = 'new';
  /** time and screen point of the last click: a double click closes the polygon */
  private lastClick = { t: 0, sx: 0, sy: 0 };
  private dragging = false;
  // magnetic
  private anchors: number[] = [];      // indices in pts
  private wire: P[] = [];              // live path from the last anchor to the cursor
  private grad: Uint8Array | null = null;
  private gw = 0;
  private gh = 0;
  // Ctrl: dragging points
  /** Ctrl held over an open outline: it waits, its points can be taken */
  private editing = false;
  /** the point under the cursor while editing (index into handles()), or -1 */
  private hot = -1;
  /** the point being dragged */
  private grab: number | null = null;

  constructor() { super({ type: 'free', mode: 'new', feather: 0, antialias: true }); }

  busy() { return this.pts.length > 0; }
  cancel() {
    this.pts = []; this.anchors = []; this.wire = []; this.hoverPt = null; this.dragging = false;
    this.editing = false; this.hot = -1; this.grab = null; this.setEditCursor(false);
    app.update('overlay');
  }
  activate() { this.cursor = arrowBadgeCursor(this.typeIcon); }
  deactivate() { this.cancel(); this.grad = null; }

  down(e: PEvent) {
    const type = this.o.type;
    // Ctrl on an open outline: take the point under the cursor (a Ctrl+click elsewhere adds nothing)
    if (type !== 'free' && this.pts.length && e.ctrl) {
      const h = this.handleAt(e.sx, e.sy);
      if (h >= 0) { this.grab = h; this.wire = []; this.hoverPt = null; app.update('overlay'); }
      return;
    }
    if (type === 'free') {
      this.mode = modeFromEvent(e, this.o.mode);
      this.pts = [{ x: e.x, y: e.y }];
      this.dragging = true;
      return;
    }
    const now = performance.now();
    if (!this.pts.length) {
      this.mode = modeFromEvent(e, this.o.mode);
      this.lastClick = { t: now, sx: e.sx, sy: e.sy };
      const p = { x: e.x, y: e.y };
      this.pts = [p];
      if (type === 'magnetic') { this.prepareEdges(); this.anchors = [0]; this.wire = []; }
      app.update('overlay');
      return;
    }
    // close on the first point or on a double click: two clicks on the same spot, not just two quick
    // clicks (placing points fast used to close the polygon too early)
    const f = app.viewport.toScreen(this.pts[0].x, this.pts[0].y);
    const nearStart = this.pts.length > 2 && Math.hypot(f.x - e.sx, f.y - e.sy) < 8;
    const lc = this.lastClick;
    const dbl = now - lc.t < 350 && Math.hypot(e.sx - lc.sx, e.sy - lc.sy) < 5;
    if (nearStart || (dbl && this.pts.length > 2)) { this.close(); return; }
    if (dbl) return;   // a double click on the second point: nothing to close yet, no duplicate point
    this.lastClick = { t: now, sx: e.sx, sy: e.sy };
    if (type === 'poly') {
      let p = { x: e.x, y: e.y };
      if (e.shift) p = snap45(this.pts[this.pts.length - 1], p);
      this.pts.push(p);
    } else {
      this.updateWire({ x: e.x, y: e.y });
      this.commitWire();
    }
    app.update('overlay');
  }

  hover(e: PEvent) {
    if (!this.pts.length) return;
    if (this.o.type !== 'free' && e.ctrl) {
      // the outline waits while Ctrl is held; the point under the cursor is shown
      this.editing = true;
      this.hot = this.handleAt(e.sx, e.sy);
      this.setEditCursor(this.hot >= 0);
      app.update('overlay');
      return;
    }
    if (this.editing) { this.editing = false; this.hot = -1; this.setEditCursor(false); }
    if (this.o.type === 'poly') this.hoverPt = e.shift ? snap45(this.pts[this.pts.length - 1], { x: e.x, y: e.y }) : { x: e.x, y: e.y };
    else if (this.o.type === 'magnetic') { this.updateWire({ x: e.x, y: e.y }); app.update('overlay'); }
  }

  move(e: PEvent) {
    if (this.grab !== null) { this.moveHandle(this.grab, { x: e.x, y: e.y }); app.update('overlay'); return; }
    if (this.o.type !== 'free') { this.hover(e); return; }
    if (!this.dragging || !this.pts.length) return;
    const last = this.pts[this.pts.length - 1];
    const minDist = 1 / (app.doc?.zoom || 1);
    if (Math.hypot(e.x - last.x, e.y - last.y) >= minDist) this.pts.push({ x: e.x, y: e.y });
    app.update('overlay');
  }

  up() {
    if (this.grab !== null) { this.grab = null; app.update('overlay'); return; }
    if (this.o.type !== 'free' || !this.dragging) return;
    this.dragging = false;
    const d = app.doc!;
    if (this.pts.length < 3) {
      this.pts = [];
      if (this.mode === 'new' && d.selection) applySelection(null, 'new');
      app.update('overlay');
      return;
    }
    this.close();
  }

  // the double click is recognised in down() (same spot, 350 ms); the system one would also fire for two
  // separate quick clicks
  dblclick() {}

  keydown(e: KeyboardEvent) {
    if (!this.pts.length) return nudgeSelection(e);
    if (this.o.type === 'free') return false;
    if (e.key === 'Control' || e.key === 'Meta') {
      // the outline stops following the cursor at once, before the mouse moves
      if (!this.editing) { this.editing = true; this.wire = []; this.hoverPt = null; app.update('overlay'); }
      return false;
    }
    if (e.key === 'Enter') { this.close(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      if (this.o.type === 'poly') this.pts.pop();
      else if (this.anchors.length > 1) { this.anchors.pop(); this.pts.length = this.anchors[this.anchors.length - 1] + 1; this.wire = []; }
      else this.cancel();
      app.update('overlay');
      return true;
    }
    return false;
  }

  keyup(e: KeyboardEvent) {
    if ((e.key === 'Control' || e.key === 'Meta') && this.editing) {
      this.editing = false; this.hot = -1; this.setEditCursor(false);
      // the outline follows the cursor again from where it is
      const v = app.viewport;
      if (this.pts.length && v.pointer.inside) {
        const c = v.toDoc(v.pointer.sx, v.pointer.sy);
        if (this.o.type === 'magnetic') this.updateWire(c); else this.hoverPt = c;
      }
      app.update('overlay');
    }
  }

  /** The points that can be dragged: every point of a polygon, the anchors of a magnetic outline. */
  private handles(): P[] { return this.o.type === 'poly' ? this.pts : this.anchors.map(i => this.pts[i]); }

  /** The point within a few screen pixels of (sx, sy), the nearest one; -1 if none. */
  private handleAt(sx: number, sy: number): number {
    const v = app.viewport;
    let best = -1, bd = 8;
    this.handles().forEach((p, i) => {
      const s = v.toScreen(p.x, p.y), dd = Math.hypot(s.x - sx, s.y - sy);
      if (dd < bd) { bd = dd; best = i; }
    });
    return best;
  }

  private setEditCursor(on: boolean) {
    const c = on ? 'move' : arrowBadgeCursor(this.typeIcon);
    if (this.cursor !== c) { this.cursor = c; app.viewport.updateCursor(); }
  }

  /**
   * Point h moved to p. A polygon's point just moves. A magnetic anchor takes the two stretches beside it along
   * with it: from the anchor before to p and from p to the anchor after, each found along the edge again; the
   * anchors after it shift by the change in the number of points.
   */
  private moveHandle(h: number, p: P) {
    if (this.o.type === 'poly') { this.pts[h] = p; return; }
    const A = this.anchors, last = A.length - 1;
    const before = h > 0 ? this.pts.slice(0, A[h - 1] + 1) : [];
    const toP = h > 0 ? this.liveWire(this.pts[A[h - 1]], p).slice(1) : [p];
    const fromP = h < last ? this.liveWire(p, this.pts[A[h + 1]]).slice(1, -1) : [];
    const after = h < last ? this.pts.slice(A[h + 1]) : [];
    const shift = before.length + toP.length + fromP.length - (h < last ? A[h + 1] : 0);
    this.pts = [...before, ...toP, ...fromP, ...after];
    A[h] = before.length + toP.length - 1;
    for (let i = h + 1; i <= last; i++) A[i] += shift;
  }

  private close() {
    if (this.o.type === 'magnetic' && this.pts.length > 1) {
      // follow the edge back to the start
      this.commitWire();
      const first = this.pts[0];
      this.updateWire(first, false);
      this.commitWire();
    }
    const pts = this.pts;
    this.pts = []; this.anchors = []; this.wire = []; this.hoverPt = null;
    if (pts.length < 3) { app.update('overlay'); return; }
    const d = app.doc!;
    const shape = Selection.fromDraw(d.width, d.height, g => {
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
      g.closePath();
      g.fill();
    });
    applySelection(shape, this.mode, this.o.feather);
  }

  /* ---------- magnetic lasso ---------- */
  /** Edge strength of the visible image (Sobel on luminance), 0..255. */
  private prepareEdges() {
    const d = app.doc!;
    const W = d.width, H = d.height;
    const src = d.compositeRead().getImageData(0, 0, W, H).data;
    const L = new Float32Array(W * H);
    for (let i = 0, p = 0; p < L.length; i += 4, p++) L[p] = (0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]) * src[i + 3] / 255;
    const mag = new Float32Array(W * H);
    let max = 1;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = L[i - W + 1] + 2 * L[i + 1] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - 1] - L[i + W - 1];
      const gy = L[i + W - 1] + 2 * L[i + W] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - W] - L[i - W + 1];
      const m = Math.sqrt(gx * gx + gy * gy);
      mag[i] = m; if (m > max) max = m;
    }
    const g = new Uint8Array(W * H);
    const k = 255 / (max * 0.5);
    for (let i = 0; i < g.length; i++) g[i] = Math.min(255, mag[i] * k);
    this.grad = g; this.gw = W; this.gh = H;
  }

  /** Cheapest path along edges between two points (Dijkstra in a window around them). */
  private liveWire(a: P, b: P): P[] {
    const G = this.grad;
    if (!G) return [a, b];
    const M = 16;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x)) - M), y0 = Math.max(0, Math.floor(Math.min(a.y, b.y)) - M);
    const x1 = Math.min(this.gw - 1, Math.ceil(Math.max(a.x, b.x)) + M), y1 = Math.min(this.gh - 1, Math.ceil(Math.max(a.y, b.y)) + M);
    const W = x1 - x0 + 1, H = y1 - y0 + 1;
    if (W < 2 || H < 2 || W * H > 200000) return [a, b];
    const idx = (p: P) => (Math.min(H - 1, Math.max(0, Math.round(p.y - 0.5) - y0))) * W + Math.min(W - 1, Math.max(0, Math.round(p.x - 0.5) - x0));
    const s = idx(a), t = idx(b);
    const dist = new Float32Array(W * H).fill(Infinity);
    const prev = new Int32Array(W * H).fill(-1);
    const done = new Uint8Array(W * H);
    // binary heap with lazy deletion
    let hk = new Float32Array(1024), hv = new Int32Array(1024), hn = 0;
    const push = (k: number, v: number) => {
      if (hn === hk.length) { const nk = new Float32Array(hn * 2); nk.set(hk); hk = nk; const nv = new Int32Array(hn * 2); nv.set(hv); hv = nv; }
      let i = hn++;
      while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; }
      hk[i] = k; hv[i] = v;
    };
    const pop = () => {
      const v = hv[0], lk = hk[--hn], lv = hv[hn];
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= hn) break; if (c + 1 < hn && hk[c + 1] < hk[c]) c++; if (hk[c] >= lk) break; hk[i] = hk[c]; hv[i] = hv[c]; i = c; }
      hk[i] = lk; hv[i] = lv;
      return v;
    };
    dist[s] = 0; push(0, s);
    const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1], DL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
    while (hn) {
      const u = pop();
      if (done[u]) continue;
      done[u] = 1;
      if (u === t) break;
      const ux = u % W, uy = (u - ux) / W;
      for (let k = 0; k < 8; k++) {
        const vx = ux + DX[k], vy = uy + DY[k];
        if (vx < 0 || vy < 0 || vx >= W || vy >= H) continue;
        const v = vy * W + vx;
        if (done[v]) continue;
        const e = 1 - G[(vy + y0) * this.gw + vx + x0] / 255;
        const nd = dist[u] + DL[k] * (e * e + 0.03);
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push(nd, v); }
      }
    }
    if (prev[t] < 0 && s !== t) return [a, b];
    const path: P[] = [];
    for (let v = t; v >= 0; v = prev[v]) { const vx = v % W; path.push({ x: vx + x0 + 0.5, y: (v - vx) / W + y0 + 0.5 }); if (v === s) break; }
    path.reverse();
    return path;
  }

  /** Recompute the live path to `c`; long paths get anchors automatically. */
  private updateWire(c: P, auto = true) {
    const zoom = app.doc?.zoom || 1;
    const freq = Math.max(12, 45 / zoom);
    for (let guard = 0; guard < 8; guard++) {
      const a = this.pts[this.pts.length - 1];
      this.wire = this.liveWire(a, c);
      if (!auto || this.wire.length <= freq) return;
      const k = Math.floor(freq * 0.7);
      this.pts.push(...this.wire.slice(1, k + 1));
      this.anchors.push(this.pts.length - 1);
    }
  }

  private commitWire() {
    if (this.wire.length > 1) { this.pts.push(...this.wire.slice(1)); this.anchors.push(this.pts.length - 1); }
    this.wire = [];
  }

  overlay(g: CanvasRenderingContext2D) {
    if (!this.pts.length) return;
    const v = app.viewport;
    const sp = this.pts.map(p => v.toScreen(p.x, p.y));
    const edit = this.editing || this.grab !== null;
    if (!edit && this.o.type === 'poly' && this.hoverPt) sp.push(v.toScreen(this.hoverPt.x, this.hoverPt.y));
    if (!edit && this.o.type === 'magnetic') for (const p of this.wire.slice(1)) sp.push(v.toScreen(p.x, p.y));
    if (sp.length < 2 && this.o.type === 'free') return;
    g.save();
    g.beginPath();
    g.moveTo(sp[0].x, sp[0].y);
    for (const p of sp.slice(1)) g.lineTo(p.x, p.y);
    g.lineWidth = 1;
    g.strokeStyle = '#fff'; g.stroke();
    g.setLineDash([4, 4]); g.strokeStyle = '#000'; g.stroke();
    g.setLineDash([]);
    const marks = this.o.type === 'free' ? [] : this.handles();
    // with Ctrl the points grow and the one under the cursor (or held) is marked: they can be dragged
    const r = edit ? 3.5 : 2, on = this.grab ?? this.hot;
    marks.forEach((m, i) => {
      const p = v.toScreen(m.x, m.y);
      g.fillStyle = edit && i === on ? '#5b8cff' : '#fff'; g.fillRect(p.x - r, p.y - r, 2 * r, 2 * r);
      g.strokeStyle = '#000'; g.strokeRect(p.x - r - 0.5, p.y - r - 0.5, 2 * r + 1, 2 * r + 1);
    });
    // highlight the first point when the path can be closed there
    const tip = sp[sp.length - 1];
    if (this.o.type !== 'free' && this.pts.length > 2 && Math.hypot(sp[0].x - tip.x, sp[0].y - tip.y) < 8) {
      g.beginPath(); g.arc(sp[0].x, sp[0].y, 6, 0, Math.PI * 2); g.strokeStyle = '#5b8cff'; g.lineWidth = 2; g.stroke();
    }
    g.restore();
  }

  options() {
    return [
      segmented<LassoType>([
        { value: 'free', icon: 'freeLasso', title: t('opt.lassoFree') },
        { value: 'magnetic', icon: 'magLasso', title: t('opt.lassoMag') },
        { value: 'poly', icon: 'polyLasso', title: t('opt.lassoPoly') },
      ], this.o.type, v => { this.cancel(); this.set('type', v); this.cursor = arrowBadgeCursor(this.typeIcon); app.viewport.updateCursor(); app.update('options'); }),
      sep(),
      modeButtons(this.o.mode, m => this.set('mode', m)),
      sep(),
      numberField({ label: t('opt.feather'), value: this.o.feather, min: 0, max: 250, unit: 'px', onChange: v => this.set('feather', v) }),
    ];
  }
}

function snap45(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}
export { snap45 };

/* ---------------- Magic wand ---------------- */
interface WandOpts { mode: SelMode; tolerance: number; contiguous: boolean; allLayers: boolean; antialias: boolean }

export class WandTool extends Tool<WandOpts> {
  readonly id = 'wand';
  readonly iconName = 'wand';
  readonly key = 'W';
  cursor = arrowBadgeCursor('wand');

  constructor() { super({ mode: 'new', tolerance: 32, contiguous: true, allLayers: false, antialias: true }); }

  keydown(e: KeyboardEvent) { return !this.busy?.() && nudgeSelection(e); }

  down(e: PEvent) {
    const d = app.doc!;
    const mode = modeFromEvent(e, this.o.mode);
    const l = d.active;
    let img: ImageData;
    if (this.o.allLayers || !l || l.isGroup) {
      img = d.compositeRead().getImageData(0, 0, d.width, d.height);
    } else img = d.layerImageData(l);
    const box = { x0: 0, y0: 0, x1: 0, y1: 0 };
    const cov = floodMask(img, e.x, e.y, this.o.tolerance, this.o.contiguous, this.o.antialias, box);
    applySelection(Selection.fromAlphaArray(cov, d.width, d.height, box), mode);
  }

  options() {
    return [
      modeButtons(this.o.mode, m => this.set('mode', m)),
      sep(),
      numberField({ label: t('opt.tolerance'), value: this.o.tolerance, min: 0, max: 255, onChange: v => this.set('tolerance', v) }),
      checkbox(t('opt.antialias'), this.o.antialias, v => this.set('antialias', v)),
      checkbox(t('opt.contiguous'), this.o.contiguous, v => this.set('contiguous', v)),
      checkbox(t('opt.allLayers'), this.o.allLayers, v => this.set('allLayers', v)),
    ];
  }
}
