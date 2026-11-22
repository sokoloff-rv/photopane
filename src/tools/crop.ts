import { app } from '../app';
import { t } from '../i18n';
import { Tool, PEvent } from './tool';
import { Rect, normRect } from '../core/util';
import { cropDocument } from '../core/ops';
import { Layer, Surface } from '../core/layer';
import { P, Quad, homography, applyH, pointInPoly, warp, rectQuad } from '../core/geom';
import { snapPoint, clearSmart } from '../core/snap';
import { select, checkbox, iconButton, sep } from '../ui/controls';
import { span, spacer, textButton } from './transform';
import { css } from '../core/color';
import { arrowBadgeCursor } from '../ui/icons';
import { openDialog } from '../ui/dialog';
import { el } from '../core/util';
import { resizeDocument } from '../ui/docdialogs';

/** A crop preset: an aspect ratio, or an exact size in pixels (the result is resampled to it). */
interface CropPreset { value: string; label: string; r: number; px?: { w: number; h: number }; custom?: boolean }

const RATIOS: CropPreset[] = [
  { value: 'free', label: '', r: 0 },
  { value: 'orig', label: '', r: -1 },
  { value: '1:1', label: '1 : 1', r: 1 },
  { value: '4:5', label: '4 : 5', r: 4 / 5 },
  { value: '3:2', label: '3 : 2', r: 3 / 2 },
  { value: '4:3', label: '4 : 3', r: 4 / 3 },
  { value: '16:9', label: '16 : 9', r: 16 / 9 },
];
const PX = (w: number, h: number, name: string): CropPreset => ({ value: `px:${w}x${h}`, label: `${w} × ${h} — ${name}`, r: w / h, px: { w, h } });
const PIXEL_PRESETS: CropPreset[] = [
  PX(1080, 1080, 'Instagram'),
  PX(1080, 1350, 'Instagram 4:5'),
  PX(1080, 1920, 'Stories / Reels'),
  PX(1200, 630, 'Facebook / Open Graph'),
  PX(1280, 720, 'HD'),
  PX(1920, 1080, 'Full HD'),
  PX(3840, 2160, '4K'),
  PX(2560, 1440, 'YouTube'),
  PX(1500, 500, 'X / Twitter'),
];

/** Saved user presets (settings). */
function customPresets(): CropPreset[] {
  const list: { kind: 'ratio' | 'px'; w: number; h: number; name?: string }[] = app.settings.cropPresets || [];
  return list.map(p => p.kind === 'px'
    ? { ...PX(p.w, p.h, p.name || t('opt.cropCustom')), value: `cpx:${p.w}x${p.h}:${p.name || ''}`, custom: true }
    : { value: `cr:${p.w}:${p.h}:${p.name || ''}`, label: `${p.w} : ${p.h}${p.name ? ' — ' + p.name : ''}`, r: p.w / p.h, custom: true });
}
function allPresets(): CropPreset[] { return [...RATIOS, ...PIXEL_PRESETS, ...customPresets()]; }

interface CropOpts { ratio: string; portrait: boolean; deletePixels: boolean; fill: 'transparent' | 'bg' }

export class CropTool extends Tool<CropOpts> {
  readonly id = 'crop';
  readonly iconName = 'crop';
  readonly key = 'C';
  cursor = arrowBadgeCursor('crop');
  private rect: Rect | null = null;
  private docId = -1;
  private drag: { mode: 'new' | 'move' | 'handle'; h?: [number, number]; start: P; r: Rect } | null = null;

  constructor() { super({ ratio: 'free', portrait: false, deletePixels: true, fill: 'transparent' }); }

  activate() { this.reset(); }
  private reset() {
    const d = app.doc;
    this.rect = d ? { x: 0, y: 0, w: d.width, h: d.height } : null;
    this.docId = d?.id ?? -1;
    // start with the largest centered frame of the chosen aspect ratio
    if (d && this.ratio()) this.fitRatio();
    app.update('overlay', 'options');
  }
  /** Is there a document; resets the frame when the document changed. `rect` may be null after Esc. */
  private ensure() { if (!app.doc) return false; if (this.docId !== app.doc.id) this.reset(); return true; }

  /** Remove the crop frame (Esc / Cancel); a new one can be drawn by dragging. */
  private clear() { this.rect = null; this.drag = null; app.update('overlay', 'options'); }

  private preset(): CropPreset | undefined { return allPresets().find(x => x.value === this.o.ratio); }

  private ratio(): number {
    const r = this.preset()?.r ?? 0;
    const d = app.doc!;
    let v = r === -1 ? d.width / d.height : r;
    if (v && this.o.portrait) v = 1 / v;
    return v;
  }

  private handleAt(e: PEvent): [number, number] | null {
    const r = this.rect;
    if (!r) return null;
    const v = app.viewport;
    for (const hx of [-1, 0, 1]) for (const hy of [-1, 0, 1]) {
      if (!hx && !hy) continue;
      const p = v.toScreen(r.x + (hx + 1) / 2 * r.w, r.y + (hy + 1) / 2 * r.h);
      if (Math.hypot(p.x - e.sx, p.y - e.sy) < 9) return [hx, hy];
    }
    return null;
  }

  hover(e: PEvent) {
    if (!this.ensure()) return;
    const h = this.handleAt(e);
    const r = this.rect;
    const inside = !!r && e.x > r.x && e.y > r.y && e.x < r.x + r.w && e.y < r.y + r.h;
    const c = h ? (h[0] && h[1] ? (h[0] === h[1] ? 'nwse-resize' : 'nesw-resize') : h[0] ? 'ew-resize' : 'ns-resize') : inside ? 'move' : arrowBadgeCursor('crop');
    if (c !== this.cursor) { this.cursor = c; app.viewport.updateCursor(); }
  }

  down(e: PEvent) {
    if (!this.ensure()) return;
    const h = this.handleAt(e);
    const r = this.rect;
    const inside = !!r && e.x > r.x && e.y > r.y && e.x < r.x + r.w && e.y < r.y + r.h;
    const start = h || inside ? { x: e.x, y: e.y } : snapPoint(e.x, e.y);
    this.drag = { mode: h ? 'handle' : inside ? 'move' : 'new', h: h || undefined, start, r: r ? { ...r } : { x: start.x, y: start.y, w: 0, h: 0 } };
  }

  move(e: PEvent) {
    const dr = this.drag;
    if (!dr) return;
    const p = snapPoint(e.x, e.y);
    const ratio = this.ratio() || (e.shift ? (dr.mode === 'new' ? 1 : dr.r.w / dr.r.h) : 0);
    if (dr.mode === 'move') {
      this.rect = { ...dr.r, x: Math.round(dr.r.x + e.x - dr.start.x), y: Math.round(dr.r.y + e.y - dr.start.y) };
    } else if (dr.mode === 'new') {
      let w = p.x - dr.start.x, h = p.y - dr.start.y;
      if (ratio) { if (Math.abs(w) / ratio > Math.abs(h)) h = Math.sign(h || 1) * Math.abs(w) / ratio; else w = Math.sign(w || 1) * Math.abs(h) * ratio; }
      this.rect = roundRect(normRect(dr.start.x, dr.start.y, dr.start.x + w, dr.start.y + h));
    } else {
      const [hx, hy] = dr.h!;
      let x0 = dr.r.x, y0 = dr.r.y, x1 = dr.r.x + dr.r.w, y1 = dr.r.y + dr.r.h;
      if (hx < 0) x0 = p.x; if (hx > 0) x1 = p.x;
      if (hy < 0) y0 = p.y; if (hy > 0) y1 = p.y;
      if (ratio) {
        let w = x1 - x0, h = y1 - y0;
        if (!hy) h = w / ratio; else if (!hx) w = h * ratio; else if (Math.abs(w) / ratio > Math.abs(h)) h = w / ratio * Math.sign(h * w || 1); else w = h * ratio * Math.sign(h * w || 1);
        if (hx < 0) x0 = x1 - w; else x1 = x0 + w;
        if (hy < 0) y0 = y1 - h; else if (hy > 0) y1 = y0 + h; else { const cy = dr.r.y + dr.r.h / 2; y0 = cy - h / 2; y1 = cy + h / 2; }
        if (!hx) { const cx = dr.r.x + dr.r.w / 2; x0 = cx - w / 2; x1 = cx + w / 2; }
      }
      this.rect = roundRect(normRect(x0, y0, x1, y1));
    }
    app.update('overlay', 'options');
  }

  up() {
    // a click without dragging on empty space leaves no frame
    if (this.drag?.mode === 'new' && this.rect && (this.rect.w < 2 || this.rect.h < 2)) this.rect = null;
    this.drag = null; clearSmart(); app.update('overlay', 'options');
  }

  dblclick() { this.apply(); }

  keydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { this.apply(); return true; }
    if (e.key === 'Escape') { if (this.rect) { this.clear(); return true; } return false; }
    return false;
  }

  apply() {
    if (!this.ensure()) return;
    const d = app.doc!;
    const r = this.rect;
    if (!r || r.w < 1 || r.h < 1) return;
    if (r.x === 0 && r.y === 0 && r.w === d.width && r.h === d.height) return;
    const extends_ = r.x < 0 || r.y < 0 || r.x + r.w > d.width || r.y + r.h > d.height;
    cropDocument(d, r, this.o.deletePixels);
    if (extends_ && this.o.fill === 'bg') {
      const l = new Layer('raster', t('layers.background'), d.width, d.height);
      const g = l.content.ctx; g.fillStyle = css(app.bg); g.fillRect(0, 0, d.width, d.height);
      d.root.children.unshift(l); l.parent = d.root;
      if (d.root.children[1]) d.root.children[1].clipped = false;
    }
    // pixel preset: scale the cropped image to the exact size (portrait swaps width and height)
    const px = this.preset()?.px;
    if (px) {
      const W = this.o.portrait ? px.h : px.w, H = this.o.portrait ? px.w : px.h;
      if (d.width !== W || d.height !== H) resizeDocument(d, W, H, 'auto');
    }
    app.commit('tool.crop');
    app.viewport.fit(false);
    this.reset();
  }

  overlay(g: CanvasRenderingContext2D) {
    if (!this.ensure() || !this.rect) return;
    const v = app.viewport;
    const r = this.rect;
    const a = v.toScreen(r.x, r.y), b = v.toScreen(r.x + r.w, r.y + r.h);
    g.save();
    g.beginPath(); g.rect(0, 0, v.w, v.h); g.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fill('evenodd');
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < 3; i++) {
      const x = a.x + (b.x - a.x) * i / 3, y = a.y + (b.y - a.y) * i / 3;
      g.moveTo(x, a.y); g.lineTo(x, b.y); g.moveTo(a.x, y); g.lineTo(b.x, y);
    }
    g.stroke();
    g.strokeStyle = '#fff'; g.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1);
    // corner brackets
    g.lineWidth = 3;
    const L = 14;
    const corners: [number, number, number, number][] = [[a.x, a.y, 1, 1], [b.x, a.y, -1, 1], [b.x, b.y, -1, -1], [a.x, b.y, 1, -1]];
    g.beginPath();
    for (const [x, y, sx, sy] of corners) { g.moveTo(x + sx * L, y + sy * 1.5); g.lineTo(x + sx * 1.5, y + sy * 1.5); g.lineTo(x + sx * 1.5, y + sy * L); }
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    g.moveTo(mx - L / 2, a.y + 1.5); g.lineTo(mx + L / 2, a.y + 1.5);
    g.moveTo(mx - L / 2, b.y - 1.5); g.lineTo(mx + L / 2, b.y - 1.5);
    g.moveTo(a.x + 1.5, my - L / 2); g.lineTo(a.x + 1.5, my + L / 2);
    g.moveTo(b.x - 1.5, my - L / 2); g.lineTo(b.x - 1.5, my + L / 2);
    g.stroke();
    g.restore();
  }

  options() {
    const r = this.rect;
    return [
      this.presetSelect(),
      iconButton('updown', t('opt.swapRatio'), () => { this.set('portrait', !this.o.portrait); this.fitRatio(); }),
      this.preset()?.custom ? iconButton('trash', t('opt.cropDelete'), () => this.deletePreset()) : null,
      r ? span(`${Math.round(r.w)} × ${Math.round(r.h)} ${t('dlg.px')}`) : null,
      sep(),
      checkbox(t('opt.deleteCropped'), this.o.deletePixels, v => this.set('deletePixels', v)),
      select([{ value: 'transparent', label: t('opt.extendTransparent') }, { value: 'bg', label: t('opt.extendBg') }], this.o.fill, v => this.set('fill', v)),
      spacer(),
      textButton(t('dlg.cancel'), () => this.clear()),
      textButton(t('opt.apply'), () => this.apply(), true),
    ];
  }

  /** Ratios, sizes in pixels, the user's own presets and "New preset…". */
  private presetSelect() {
    const lab = (x: CropPreset) => x.value === 'free' ? t('opt.ratioFree') : x.value === 'orig' ? t('opt.ratioOrig') : x.label;
    const custom = customPresets();
    const opts: { value: string; label: string }[] = [
      ...RATIOS.map(x => ({ value: x.value, label: lab(x) })),
      { value: '-', label: '' },
      ...PIXEL_PRESETS.map(x => ({ value: x.value, label: x.label })),
      ...(custom.length ? [{ value: '-', label: '' }, ...custom.map(x => ({ value: x.value, label: x.label }))] : []),
      { value: '-', label: '' },
      { value: '__new', label: t('opt.cropNew') },
    ];
    const s = select(opts, this.o.ratio, v => {
      if (v === '__new') { s.value = this.o.ratio; this.newPresetDialog(); return; }
      this.set('ratio', v); this.fitRatio();
    });
    return s;
  }

  private newPresetDialog() {
    let kind: 'ratio' | 'px' = 'ratio';
    const name = el('input', { class: 'text-input', type: 'text', placeholder: t('opt.cropName') }) as HTMLInputElement;
    const w = el('input', { class: 'text-input', type: 'number', min: 1, value: 3 }) as HTMLInputElement;
    const h = el('input', { class: 'text-input', type: 'number', min: 1, value: 2 }) as HTMLInputElement;
    const kindSel = select([{ value: 'ratio', label: t('opt.cropKindRatio') }, { value: 'px', label: t('opt.cropKindPx') }], kind, v => {
      kind = v as any;
      if (kind === 'px' && +w.value < 50) { w.value = '1920'; h.value = '1080'; }
      if (kind === 'ratio' && +w.value > 50) { w.value = '3'; h.value = '2'; }
    });
    for (const i of [name, w, h]) i.addEventListener('keydown', e => e.stopPropagation());
    const body = el('div', { class: 'form' },
      el('div', { class: 'form-row' }, el('label', {}, t('opt.cropKind')), kindSel),
      el('div', { class: 'form-row' }, el('label', {}, t('opt.cropSize')), w, el('span', { class: 'muted' }, '×'), h),
      el('div', { class: 'form-row' }, el('label', {}, t('opt.cropNameLabel')), name));
    openDialog({
      title: t('opt.cropNewTitle'), body, width: 360,
      onOk: () => {
        const W = Math.round(+w.value), H = Math.round(+h.value);
        if (!(W > 0 && H > 0)) return false;
        const list = app.settings.cropPresets || [];
        list.push({ kind, w: W, h: H, name: name.value.trim() || undefined });
        app.settings.cropPresets = list;
        this.set('ratio', kind === 'px' ? `cpx:${W}x${H}:${name.value.trim()}` : `cr:${W}:${H}:${name.value.trim()}`);
        this.fitRatio();
      },
    });
  }

  private deletePreset() {
    const cur = this.o.ratio;
    const list: { kind: 'ratio' | 'px'; w: number; h: number; name?: string }[] = app.settings.cropPresets || [];
    app.settings.cropPresets = list.filter(p => (p.kind === 'px' ? `cpx:${p.w}x${p.h}:${p.name || ''}` : `cr:${p.w}:${p.h}:${p.name || ''}`) !== cur);
    this.set('ratio', 'free');
    app.update('options');
  }

  private fitRatio() {
    const ratio = this.ratio();
    if (ratio && this.rect) {
      const r = this.rect;
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      let w = r.w, h = r.w / ratio;
      if (h > r.h) { h = r.h; w = h * ratio; }
      this.rect = roundRect({ x: cx - w / 2, y: cy - h / 2, w, h });
    }
    app.update('overlay', 'options');
  }
}

function roundRect(r: Rect): Rect {
  const x = Math.round(r.x), y = Math.round(r.y);
  return { x, y, w: Math.max(1, Math.round(r.x + r.w) - x), h: Math.max(1, Math.round(r.y + r.h) - y) };
}

/* ---------------- Perspective crop ---------------- */
export class PerspCropTool extends Tool {
  readonly id = 'perspCrop';
  readonly iconName = 'perspCrop';
  readonly key = 'C';
  private quad: Quad | null = null;
  private docId = -1;
  private drag: { i: number; start: P; quad: Quad } | null = null;

  constructor() { super({}); }

  activate() { this.reset(); }
  private reset() {
    const d = app.doc;
    if (!d) { this.quad = null; return; }
    const ix = d.width * 0.1, iy = d.height * 0.1;
    this.quad = rectQuad({ x: ix, y: iy, w: d.width - 2 * ix, h: d.height - 2 * iy });
    this.docId = d.id;
    app.update('overlay');
  }
  private ensure() { if (!app.doc) return false; if (this.docId !== app.doc.id || !this.quad) this.reset(); return !!this.quad; }

  down(e: PEvent) {
    if (!this.ensure()) return;
    const v = app.viewport;
    const q = this.quad!;
    let idx = q.findIndex(p => { const s = v.toScreen(p.x, p.y); return Math.hypot(s.x - e.sx, s.y - e.sy) < 10; });
    if (idx < 0 && pointInPoly({ x: e.x, y: e.y }, q)) idx = 4;
    if (idx < 0) return;
    this.drag = { i: idx, start: { x: e.x, y: e.y }, quad: q.map(p => ({ ...p })) as Quad };
  }

  move(e: PEvent) {
    const dr = this.drag;
    if (!dr) return;
    const dx = e.x - dr.start.x, dy = e.y - dr.start.y;
    const q = dr.quad.map(p => ({ ...p })) as Quad;
    if (dr.i === 4) q.forEach(p => { p.x += dx; p.y += dy; });
    else q[dr.i] = { x: q[dr.i].x + dx, y: q[dr.i].y + dy };
    this.quad = q;
    app.update('overlay');
  }

  up() { this.drag = null; }

  hover(e: PEvent) {
    if (!this.ensure()) return;
    const v = app.viewport;
    const onCorner = this.quad!.some(p => { const s = v.toScreen(p.x, p.y); return Math.hypot(s.x - e.sx, s.y - e.sy) < 10; });
    const c = onCorner ? 'pointer' : pointInPoly({ x: e.x, y: e.y }, this.quad!) ? 'move' : arrowBadgeCursor('perspCrop');
    if (c !== this.cursor) { this.cursor = c; app.viewport.updateCursor(); }
  }

  keydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { this.apply(); return true; }
    if (e.key === 'Escape') { this.reset(); return true; }
    return false;
  }

  apply() {
    if (!this.ensure()) return;
    const d = app.doc!;
    const q = this.quad!;
    const len = (a: P, b: P) => Math.hypot(b.x - a.x, b.y - a.y);
    const W = Math.max(1, Math.round((len(q[0], q[1]) + len(q[3], q[2])) / 2));
    const H = Math.max(1, Math.round((len(q[0], q[3]) + len(q[1], q[2])) / 2));
    const inv = homography(rectQuad({ x: 0, y: 0, w: W, h: H }), q); // dst -> src
    const dst = { x: 0, y: 0, w: W, h: H };
    const conv = (s: Surface) => {
      s.replace(warp(s.canvas, s.x, s.y, inv, dst), 0, 0);
    };
    const walk = (l: Layer) => {
      if (l.kind === 'text') { l.kind = 'raster'; l.text = null; }
      if (!l.isGroup) conv(l.content);
      if (l.mask) conv(l.mask);
      l.children.forEach(walk);
      l.touch();
    };
    d.root.children.forEach(walk);
    d.width = W; d.height = H;
    d.selection = null;
    d.guides = { h: [], v: [] };
    d.invalidate();
    app.commit('tool.perspCrop');
    app.viewport.fit(false);
    this.reset();
  }

  overlay(g: CanvasRenderingContext2D) {
    if (!this.ensure()) return;
    const v = app.viewport;
    const q = this.quad!;
    const s = q.map(p => v.toScreen(p.x, p.y));
    g.save();
    g.beginPath(); g.rect(0, 0, v.w, v.h);
    s.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fill('evenodd');
    // perspective grid
    const h = homography(rectQuad({ x: 0, y: 0, w: 1, h: 1 }), q);
    g.beginPath();
    for (let i = 1; i < 6; i++) {
      const tt = i / 6;
      const a1 = applyH(h, tt, 0), b1 = applyH(h, tt, 1), a2 = applyH(h, 0, tt), b2 = applyH(h, 1, tt);
      const sa1 = v.toScreen(a1.x, a1.y), sb1 = v.toScreen(b1.x, b1.y), sa2 = v.toScreen(a2.x, a2.y), sb2 = v.toScreen(b2.x, b2.y);
      g.moveTo(sa1.x, sa1.y); g.lineTo(sb1.x, sb1.y); g.moveTo(sa2.x, sa2.y); g.lineTo(sb2.x, sb2.y);
    }
    g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 1; g.stroke();
    g.beginPath(); s.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath();
    g.strokeStyle = '#fff'; g.stroke();
    for (const p of s) {
      g.fillStyle = '#fff'; g.fillRect(p.x - 4, p.y - 4, 8, 8);
      g.strokeStyle = 'rgba(0,0,0,0.6)'; g.strokeRect(p.x - 4, p.y - 4, 8, 8);
    }
    g.restore();
  }

  options() {
    return [span(t('hint.perspCrop')), spacer(), textButton(t('dlg.cancel'), () => this.reset()), textButton(t('opt.apply'), () => this.apply(), true)];
  }
}
