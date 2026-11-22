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

/* ---------------- Freehand lasso ---------------- */
export class FreeLassoTool extends Tool<{ mode: SelMode; feather: number }> {
  readonly id = 'freeLasso';
  readonly iconName = 'freeLasso';
  readonly key = 'L';
  cursor = arrowBadgeCursor('freeLasso');
  private pts: { x: number; y: number }[] = [];
  private mode: SelMode = 'new';

  constructor() { super({ mode: 'new', feather: 0 }); }

  down(e: PEvent) {
    this.mode = modeFromEvent(e, this.o.mode);
    this.pts = [{ x: e.x, y: e.y }];
  }

  move(e: PEvent) {
    if (!this.pts.length) return;
    const last = this.pts[this.pts.length - 1];
    const minDist = 1 / (app.doc?.zoom || 1);
    if (Math.hypot(e.x - last.x, e.y - last.y) >= minDist) this.pts.push({ x: e.x, y: e.y });
    app.update('overlay');
  }

  up() {
    const pts = this.pts;
    this.pts = [];
    const d = app.doc!;
    if (pts.length < 3) {
      if (this.mode === 'new' && d.selection) applySelection(null, 'new');
      app.update('overlay');
      return;
    }
    const shape = Selection.fromDraw(d.width, d.height, g => {
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
      g.closePath();
      g.fill();
    });
    applySelection(shape, this.mode, this.o.feather);
  }

  cancel() { this.pts = []; app.update('overlay'); }
  busy() { return this.pts.length > 0; }

  overlay(g: CanvasRenderingContext2D) {
    if (this.pts.length < 2) return;
    const v = app.viewport;
    g.save();
    g.beginPath();
    this.pts.forEach((p, i) => { const s = v.toScreen(p.x, p.y); if (i) g.lineTo(s.x, s.y); else g.moveTo(s.x, s.y); });
    g.lineWidth = 1;
    g.strokeStyle = '#fff'; g.stroke();
    g.setLineDash([4, 4]); g.strokeStyle = '#000'; g.stroke();
    g.restore();
  }

  options() {
    return [
      modeButtons(this.o.mode, m => this.set('mode', m)),
      sep(),
      numberField({ label: t('opt.feather'), value: this.o.feather, min: 0, max: 250, unit: 'px', onChange: v => this.set('feather', v) }),
    ];
  }
}

/* ---------------- Polygonal lasso ---------------- */
interface LassoOpts { mode: SelMode; feather: number; antialias: boolean }

export class LassoTool extends Tool<LassoOpts> {
  readonly id = 'lasso';
  readonly iconName = 'polyLasso';
  readonly key = 'L';
  cursor = arrowBadgeCursor('polyLasso');
  private pts: { x: number; y: number }[] = [];
  private hoverPt: { x: number; y: number } | null = null;
  private mode: SelMode = 'new';
  private lastClick = 0;

  constructor() { super({ mode: 'new', feather: 0, antialias: true }); }

  down(e: PEvent) {
    const now = performance.now();
    if (!this.pts.length) this.mode = modeFromEvent(e, this.o.mode);
    // close if clicking near the first point
    if (this.pts.length > 2) {
      const f = app.viewport.toScreen(this.pts[0].x, this.pts[0].y);
      if (Math.hypot(f.x - e.sx, f.y - e.sy) < 8) { this.close(); return; }
    }
    if (now - this.lastClick < 300 && this.pts.length > 2) { this.close(); return; }
    this.lastClick = now;
    let p = { x: e.x, y: e.y };
    if (e.shift && this.pts.length) p = snap45(this.pts[this.pts.length - 1], p);
    this.pts.push(p);
    app.update('overlay');
  }

  hover(e: PEvent) {
    if (!this.pts.length) return;
    this.hoverPt = e.shift ? snap45(this.pts[this.pts.length - 1], { x: e.x, y: e.y }) : { x: e.x, y: e.y };
  }
  move(e: PEvent) { this.hover(e); }

  dblclick() { if (this.pts.length > 2) this.close(); }

  keydown(e: KeyboardEvent) {
    if (!this.pts.length) return false;
    if (e.key === 'Enter') { this.close(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') { this.pts.pop(); app.update('overlay'); return true; }
    return false;
  }

  busy() { return this.pts.length > 0; }

  private close() {
    const pts = this.pts;
    this.pts = [];
    this.hoverPt = null;
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

  cancel() { this.pts = []; this.hoverPt = null; app.update('overlay'); }

  overlay(g: CanvasRenderingContext2D) {
    if (!this.pts.length) return;
    const v = app.viewport;
    const sp = this.pts.map(p => v.toScreen(p.x, p.y));
    if (this.hoverPt) sp.push(v.toScreen(this.hoverPt.x, this.hoverPt.y));
    g.save();
    g.beginPath();
    g.moveTo(sp[0].x, sp[0].y);
    for (const p of sp.slice(1)) g.lineTo(p.x, p.y);
    g.lineWidth = 1;
    g.strokeStyle = '#fff'; g.stroke();
    g.setLineDash([4, 4]); g.strokeStyle = '#000'; g.stroke();
    g.setLineDash([]);
    for (const p of sp.slice(0, this.pts.length)) { g.fillStyle = '#fff'; g.fillRect(p.x - 2, p.y - 2, 4, 4); g.strokeStyle = '#000'; g.strokeRect(p.x - 2.5, p.y - 2.5, 5, 5); }
    // highlight first point when closable
    if (this.hoverPt && this.pts.length > 2) {
      const f = sp[0], h = sp[sp.length - 1];
      if (Math.hypot(f.x - h.x, f.y - h.y) < 8) { g.beginPath(); g.arc(f.x, f.y, 6, 0, Math.PI * 2); g.strokeStyle = '#5b8cff'; g.lineWidth = 2; g.stroke(); }
    }
    g.restore();
  }

  options() {
    return [
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

  down(e: PEvent) {
    const d = app.doc!;
    const mode = modeFromEvent(e, this.o.mode);
    const l = d.active;
    let img: ImageData;
    if (this.o.allLayers || !l || l.isGroup) {
      const c = d.composite();
      img = c.getContext('2d')!.getImageData(0, 0, d.width, d.height);
    } else img = d.layerImageData(l);
    const cov = floodMask(img, e.x, e.y, this.o.tolerance, this.o.contiguous, this.o.antialias);
    applySelection(Selection.fromAlphaArray(cov, d.width, d.height), mode);
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
