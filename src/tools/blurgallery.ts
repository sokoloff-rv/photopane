import { app } from '../app';
import { t } from '../i18n';
import { Tool, PEvent } from './tool';
import { AdjustSession } from '../core/adjust';
import { gaussianBlur, smoothstep } from '../core/filters';
import { createCanvas, ctx2d, clamp, el } from '../core/util';
import { previews } from '../core/render';
import { numberField } from '../ui/controls';
import { spacer, textButton, span } from './transform';
import { toast, openDialog } from '../ui/dialog';
import { sliderRow } from '../ui/adjustdialogs';
import { checkbox } from '../ui/controls';
import { GpuBlur, BlurShape } from '../core/gpublur';

/** One full turn of the ring around a pin = this much blur (px), as the ring shows it. */
const RING_TURN = 200;

type Mode = 'field' | 'iris' | 'tilt';
interface Pin { x: number; y: number; blur: number }

/** Gaussian blur computed at reduced resolution for large radii (visually identical, much faster). */
function blurLevel(src: HTMLCanvasElement, sigma: number): Uint8ClampedArray {
  const w = src.width, h = src.height;
  if (sigma < 0.5) return ctx2d(src).getImageData(0, 0, w, h).data;
  const f = clamp(Math.floor(sigma / 4), 1, 16);
  const sw = Math.max(1, Math.round(w / f)), sh = Math.max(1, Math.round(h / f));
  const small = createCanvas(sw, sh);
  const sg = ctx2d(small);
  sg.imageSmoothingQuality = 'high';
  sg.drawImage(src, 0, 0, sw, sh);
  const blurred = gaussianBlur(sg.getImageData(0, 0, sw, sh).data, sw, sh, sigma / f);
  sg.putImageData(new ImageData(blurred as any, sw, sh), 0, 0);
  if (f === 1) return blurred;
  const big = createCanvas(w, h);
  const bg = ctx2d(big);
  bg.imageSmoothingQuality = 'high';
  bg.drawImage(small, 0, 0, w, h);
  return bg.getImageData(0, 0, w, h).data;
}

export class BlurGalleryTool extends Tool {
  readonly id = 'blurGallery';
  readonly iconName = 'blur';
  cursor = 'default';
  active = false;
  mode: Mode = 'iris';
  private s: AdjustSession | null = null;
  private srcCanvas: HTMLCanvasElement | null = null;
  /** reused for the preview with a selection (not a new document-sized canvas every frame) */
  private selTmp: HTMLCanvasElement | null = null;
  private proxy: { k: number; canvas: HTMLCanvasElement; levels: Uint8ClampedArray[]; R: number; out: HTMLCanvasElement } | null = null;
  private pins: Pin[] = [];
  private selPin = 0;
  private iris = { cx: 0, cy: 0, rx: 100, ry: 100, feather: 0.5, blur: 15 };
  private tilt = { cx: 0, cy: 0, angle: 0, focus: 100, trans: 150, blur: 15 };
  private drag: { what: string; start: { x: number; y: number }; snap: any; angle?: number; turned?: number; blur0?: number } | null = null;
  /** The ring under the pointer (shown highlighted, with the value). */
  private ringHover: string | null = null;
  /** GPU renderer of the on-screen proxy (null: CPU). */
  private gpu: GpuBlur | null = null;
  private timer = 0;
  /** Bokeh highlights: bright spots in the blurred area light up like out-of-focus lights (0..100). */
  private bokeh = 0;
  /** The window with the same settings as sliders (like the other filters); closed with the tool. */
  private win: { close: () => void } | null = null;
  private rows: { set: (v: number) => void; get: () => number }[] = [];
  /** Before/after line (document x), null = off; dragged by its handle at the bottom of the view. */
  private split: number | null = null;

  constructor() { super({}); }

  /** Each of the three is its own filter to the user: its own name, options and history step. */
  get nameKey() { return this.mode === 'field' ? 'cmd.fieldBlur' : this.mode === 'iris' ? 'cmd.irisBlur' : 'cmd.tiltShift'; }
  get hintKey() { return 'hint.blur.' + this.mode; }

  begin(mode: Mode): boolean {
    const s = AdjustSession.start();
    if (!s) return false;
    const d = app.doc!;
    this.s = s;
    this.mode = mode;
    this.srcCanvas = createCanvas(s.w, s.h);
    ctx2d(this.srcCanvas).putImageData(s.orig, 0, 0);
    const base = Math.round(Math.max(d.width, d.height) / 80) + 6;
    this.pins = [{ x: d.width / 2, y: d.height / 2, blur: base }];
    this.selPin = 0;
    this.iris = { cx: d.width / 2, cy: d.height / 2, rx: d.width * 0.22, ry: d.height * 0.22, feather: 0.5, blur: base };
    this.tilt = { cx: d.width / 2, cy: d.height / 2, angle: 0, focus: d.height * 0.08, trans: d.height * 0.18, blur: base };
    const k = Math.min(1, 1400 / Math.max(s.w, s.h));
    const pc = createCanvas(Math.max(1, Math.round(s.w * k)), Math.max(1, Math.round(s.h * k)));
    const pg = ctx2d(pc); pg.imageSmoothingQuality = 'high'; pg.drawImage(this.srcCanvas, 0, 0, pc.width, pc.height);
    this.proxy = { k, canvas: pc, levels: [], R: -1, out: createCanvas(pc.width, pc.height) };
    this.gpu = GpuBlur.create(pg.getImageData(0, 0, pc.width, pc.height));
    this.active = true;
    const l = s.target.layer;
    previews.set(l.id, g => {
      const p = this.proxy, s = this.s;
      if (!p || !s) { g.drawImage(l.canvas, l.x, l.y); return; }
      const sel = app.doc?.selection;
      // before/after: the layer as it is left of the line
      if (this.split != null) {
        g.save(); g.beginPath(); g.rect(-1e6, -1e6, this.split + 1e6, 2e6); g.clip(); g.drawImage(l.canvas, l.x, l.y); g.restore();
        g.save(); g.beginPath(); g.rect(this.split, -1e6, 2e6, 2e6); g.clip();
      }
      // only the blurred layer (its soft edges on transparency look as they will after Apply)
      if (!sel) { g.drawImage(p.out, s.ox, s.oy, s.w, s.h); if (this.split != null) g.restore(); return; }
      // with a selection: the layer as it is outside, the blur inside
      const W = g.canvas.width, H = g.canvas.height;
      if (!this.selTmp || this.selTmp.width !== W || this.selTmp.height !== H) this.selTmp = createCanvas(W, H);
      const tg = ctx2d(this.selTmp);
      tg.clearRect(0, 0, W, H);
      tg.drawImage(l.canvas, l.x, l.y);
      tg.globalCompositeOperation = 'destination-out'; tg.drawImage(sel.mask, 0, 0);
      tg.globalCompositeOperation = 'source-over';
      g.drawImage(this.selTmp, 0, 0);
      tg.clearRect(0, 0, W, H);
      tg.drawImage(p.out, s.ox, s.oy, s.w, s.h);
      tg.globalCompositeOperation = 'destination-in'; tg.drawImage(sel.mask, 0, 0);
      tg.globalCompositeOperation = 'source-over';
      g.drawImage(this.selTmp, 0, 0);
      if (this.split != null) g.restore();
    });
    this.renderProxy();
    this.openWindow();
    return true;
  }

  /**
   * The usual filter window: the blur (of the chosen pin), bokeh, the iris size and feather or the tilt-shift focus and
   * transition, and before/after. The rings and handles on the canvas and the options bar work as well; all of
   * them stay in step.
   */
  private openWindow() {
    const d = app.doc!;
    const big = Math.max(d.width, d.height);
    const rows: { el: HTMLElement & { set(v: number): void }; get: () => number }[] = [];
    const add = (key: string, label: string, min: number, max: number, unit: string, get: () => number, set: (v: number) => void) => {
      const el = sliderRow({ key, label: t(label), min, max, def: get(), unit }, Math.round(get()), v => { set(v); this.schedule(); app.update('overlay', 'options'); });
      rows.push({ el, get });
    };
    add('blur', 'blur.amount', 0, 500, ' px', () => this.getBlur(this.mode === 'field' ? 'pin' + this.selPin : 'center'), v => this.setBlur(this.mode === 'field' ? 'pin' + this.selPin : 'center', v));
    add('bokeh', 'blur.bokeh', 0, 100, '%', () => this.bokeh, v => { this.bokeh = v; });
    if (this.mode === 'iris') {
      // the outer ellipse: its larger radius; the proportions stay as dragged on the canvas
      add('size', 'blur.size', 5, big, ' px', () => Math.max(this.iris.rx, this.iris.ry), v => {
        const ir = this.iris, k = Math.max(5, v) / Math.max(ir.rx, ir.ry);
        ir.rx = Math.max(5, ir.rx * k); ir.ry = Math.max(5, ir.ry * k);
      });
      add('feather', 'blur.feather', 0, 98, '%', () => this.iris.feather * 100, v => { this.iris.feather = v / 100; });
    }
    if (this.mode === 'tilt') {
      add('focus', 'blur.focus', 0, Math.round(big / 2), ' px', () => this.tilt.focus, v => { this.tilt.focus = v; });
      add('trans', 'blur.transition', 2, Math.round(big / 2), ' px', () => this.tilt.trans, v => { this.tilt.trans = Math.max(2, v); });
    }
    this.rows = rows.map(r => ({ set: (v: number) => r.el.set(Math.round(v)), get: r.get }));
    const split = checkbox(t('adj.beforeAfter'), false, on => {
      if (on) { const v = app.viewport, a = v.toDoc(0, 0), b = v.toDoc(v.w, 0); this.split = Math.round((Math.max(0, a.x) + Math.min(d.width, b.x)) / 2); }
      else this.split = null;
      this.schedule(); app.update('overlay');
    });
    const body = el('div', { class: 'adj' }, el('div', { class: 'adj-foot adj-foot-wrap adj-top' }, split), ...rows.map(r => r.el));
    this.win = openDialog({
      title: t(this.nameKey), body, width: 320, side: true, sideKey: 'blurGallery', posKey: 'blurGallery',
      onOk: () => { this.apply(); },
      onCancel: () => { this.win = null; this.cancel(); },
      keys: e => (e.key === 'Delete' || e.key === 'Backspace') && this.keydown(e),
    });
    // the options bar keeps the gallery's own controls (not locked by the window)
    app.sideOptions = { icon: 'blur', title: t(this.nameKey), items: () => this.options() };
    app.update('options');
  }

  /** The window's sliders follow changes made on the canvas or in the options bar. */
  private syncWindow() { for (const r of this.rows) r.set(r.get()); }

  private maxBlur() { return this.mode === 'field' ? Math.max(...this.pins.map(p => p.blur)) : this.mode === 'iris' ? this.iris.blur : this.tilt.blur; }

  /** Blur amount (document px) at a document point. */
  private blurAt(): (x: number, y: number) => number {
    if (this.mode === 'iris') {
      const ir = this.iris;
      return (x, y) => { const dx = (x - ir.cx) / ir.rx, dy = (y - ir.cy) / ir.ry; return ir.blur * smoothstep(ir.feather, 1, Math.sqrt(dx * dx + dy * dy)); };
    }
    if (this.mode === 'tilt') {
      const tl = this.tilt;
      const nx = -Math.sin(tl.angle), ny = Math.cos(tl.angle);
      return (x, y) => tl.blur * smoothstep(tl.focus, tl.focus + tl.trans, Math.abs((x - tl.cx) * nx + (y - tl.cy) * ny));
    }
    const pins = this.pins;
    if (pins.length === 1) { const b = pins[0].blur; return () => b; }
    return (x, y) => {
      let sw = 0, sb = 0;
      for (const p of pins) { const w = 1 / ((x - p.x) ** 2 + (y - p.y) ** 2 + 1); sw += w; sb += w * p.blur; }
      return sb / sw;
    };
  }

  /** Composite blur levels according to the blur map. */
  private composite(levels: Uint8ClampedArray[], R: number, w: number, h: number, scale: number, ox: number, oy: number, dst: Uint8ClampedArray) {
    const fn = this.blurAt();
    const n = levels.length - 1;
    for (let y = 0; y < h; y++) {
      const dy = oy + (y + 0.5) / scale;
      for (let x = 0; x < w; x++) {
        const b = R > 0 ? fn(ox + (x + 0.5) / scale, dy) : 0;
        const f = clamp((b / (R || 1)) * n, 0, n);
        const i0 = Math.min(n - 1, Math.floor(f)), fr = f - i0;
        const a = levels[i0], c = levels[i0 + 1];
        const p = (y * w + x) * 4;
        dst[p] = a[p] + (c[p] - a[p]) * fr; dst[p + 1] = a[p + 1] + (c[p + 1] - a[p + 1]) * fr;
        dst[p + 2] = a[p + 2] + (c[p + 2] - a[p + 2]) * fr; dst[p + 3] = a[p + 3] + (c[p + 3] - a[p + 3]) * fr;
        if (this.bokeh && f > 0) {
          const L = (0.299 * dst[p] + 0.587 * dst[p + 1] + 0.114 * dst[p + 2]) / 255;
          const k = 1 + (this.bokeh / 100) * 1.8 * (f / n) * smoothstep(0.5, 0.92, L);
          dst[p] *= k; dst[p + 1] *= k; dst[p + 2] *= k;
        }
      }
    }
  }

  private levelsFor(src: HTMLCanvasElement, R: number): Uint8ClampedArray[] {
    const N = 5;
    const out: Uint8ClampedArray[] = [];
    for (let i = 0; i < N; i++) out.push(blurLevel(src, (R * i) / (N - 1) / 2));
    return out;
  }

  private shape(): BlurShape { return { mode: this.mode, pins: this.pins, iris: this.iris, tilt: this.tilt, bokeh: this.bokeh }; }

  private renderProxy() {
    const p = this.proxy, s = this.s;
    if (!p || !s) return;
    const R = this.maxBlur();
    if (this.gpu) {
      const c = this.gpu.render(this.shape(), R, p.canvas.width / s.w, s.ox, s.oy, 'screen');
      if (c) { p.out = c; s.target.layer.touch(); app.update('canvas'); return; }
      this.gpu = null;
      p.out = createCanvas(p.canvas.width, p.canvas.height);
    }
    if (Math.abs(R - p.R) > 0.01 || !p.levels.length) { p.levels = this.levelsFor(p.canvas, R * p.k); p.R = R; }
    const w = p.canvas.width, h = p.canvas.height;
    const img = new ImageData(w, h);
    this.composite(p.levels, R * p.k, w, h, p.k * (w / (s.w * p.k)), s.ox, s.oy, img.data);
    ctx2d(p.out).putImageData(img, 0, 0);
    s.target.layer.touch();
    app.update('canvas');
  }

  private schedule() {
    if (this.timer) return;
    this.timer = requestAnimationFrame(() => { this.timer = 0; this.renderProxy(); this.syncWindow(); });
  }

  apply() {
    if (!this.active || !this.s) return;
    const s = this.s;
    toast(t('adj.processing'), 'info', 1500);
    setTimeout(() => {
      const R = this.maxBlur();
      const label = this.nameKey;
      // full size on the GPU when it fits, else the CPU levels
      const full = GpuBlur.create(s.orig);
      const data = full?.render(this.shape(), R, 1, s.ox, s.oy, 'pixels') ?? null;
      full?.dispose();
      if (data) { this.cleanup(); s.commit(label, (_src, dst) => dst.set(data)); }
      else {
        const levels = this.levelsFor(this.srcCanvas!, R);
        this.cleanup();
        s.commit(label, (_src, dst) => this.composite(levels, R, s.w, s.h, 1, s.ox, s.oy, dst));
      }
      app.popTool();
    }, 30);
  }

  private cleanup() {
    if (this.s) previews.delete(this.s.target.layer.id);
    const w = this.win; this.win = null; w?.close();
    this.rows = []; this.split = null;
    if (app.sideOptions?.icon === 'blur') { app.sideOptions = null; app.update('options'); }
    this.active = false;
    this.proxy = null;
    this.gpu?.dispose();
    this.gpu = null;
    this.ringHover = null;
    // the layer copy and the session are large on big photos: not kept after the tool is done
    this.s = null;
    this.srcCanvas = null;
    this.selTmp = null;
  }

  cancel() {
    if (!this.active) return;
    const s = this.s;
    this.cleanup();
    s?.target.layer.touch();
    app.update('canvas', 'overlay');
    if (app.tool === this) app.popTool();
  }

  deactivate() { if (this.active) this.cancel(); }
  busy() { return this.active; }

  /* ---------------- interaction ---------------- */
  private scr(x: number, y: number) { return app.viewport.toScreen(x, y); }

  private handles(): { id: string; x: number; y: number }[] {
    if (this.mode === 'iris') {
      const ir = this.iris;
      const fx = ir.cx + ir.rx * ir.feather * Math.SQRT1_2, fy = ir.cy - ir.ry * ir.feather * Math.SQRT1_2;
      return [{ id: 'rx', x: ir.cx + ir.rx, y: ir.cy }, { id: 'rx', x: ir.cx - ir.rx, y: ir.cy }, { id: 'ry', x: ir.cx, y: ir.cy - ir.ry }, { id: 'ry', x: ir.cx, y: ir.cy + ir.ry },
        { id: 'feather', x: fx, y: fy }, { id: 'center', x: ir.cx, y: ir.cy }];
    }
    if (this.mode === 'tilt') {
      const tl = this.tilt;
      const z = app.doc!.zoom;
      const dx = Math.cos(tl.angle), dy = Math.sin(tl.angle), nx = -dy, ny = dx;
      const r = 70 / z;
      return [{ id: 'center', x: tl.cx, y: tl.cy }, { id: 'rotate', x: tl.cx + dx * r, y: tl.cy + dy * r },
        { id: 'focus', x: tl.cx + nx * tl.focus, y: tl.cy + ny * tl.focus }, { id: 'focus', x: tl.cx - nx * tl.focus, y: tl.cy - ny * tl.focus },
        { id: 'trans', x: tl.cx + nx * (tl.focus + tl.trans), y: tl.cy + ny * (tl.focus + tl.trans) }, { id: 'trans', x: tl.cx - nx * (tl.focus + tl.trans), y: tl.cy - ny * (tl.focus + tl.trans) }];
    }
    return this.pins.map((p, i) => ({ id: 'pin' + i, x: p.x, y: p.y }));
  }

  private hit(e: PEvent) {
    const hs = this.handles();
    for (const h of hs) { const s = this.scr(h.x, h.y); if (Math.hypot(s.x - e.sx, s.y - e.sy) < 10) return h.id; }
    // the ring around a pin / the centre: drag along it to change the blur
    for (const h of hs) {
      if (h.id !== 'center' && !h.id.startsWith('pin')) continue;
      const s = this.scr(h.x, h.y), d = Math.hypot(s.x - e.sx, s.y - e.sy);
      if (d >= 10 && d <= 20) return 'ring:' + h.id;
    }
    return null;
  }

  private getBlur(id: string) {
    if (id.startsWith('pin')) return this.pins[parseInt(id.slice(3))]?.blur ?? 0;
    return this.mode === 'iris' ? this.iris.blur : this.tilt.blur;
  }
  private setBlur(id: string, v: number) {
    if (id.startsWith('pin')) { const p = this.pins[parseInt(id.slice(3))]; if (p) p.blur = v; }
    else if (this.mode === 'iris') this.iris.blur = v; else this.tilt.blur = v;
  }
  /** Angle of the pointer around a handle, clockwise from the top (screen). */
  private ringAngle(id: string, e: PEvent) {
    const h = this.handles().find(x => x.id === id);
    if (!h) return 0;
    const s = this.scr(h.x, h.y);
    return Math.atan2(e.sx - s.x, -(e.sy - s.y));
  }

  hover(e: PEvent) {
    if (!this.active) return;
    const h = this.hit(e);
    const ring = h?.startsWith('ring:') ? h.slice(5) : null;
    if (ring !== this.ringHover) { this.ringHover = ring; app.update('overlay'); }
    const c = h ? (ring ? 'grab' : h === 'center' || h.startsWith('pin') ? 'move' : 'pointer') : this.mode === 'field' ? 'copy' : 'default';
    if (c !== this.cursor) { this.cursor = c; app.viewport.updateCursor(); }
  }

  /** The before/after handle: a knob at the bottom of the view on the line. */
  private splitHandle(): { x: number; y: number } | null {
    if (this.split == null) return null;
    const v = app.viewport, p = v.toScreen(this.split, 0);
    return { x: p.x, y: v.h - 26 };
  }

  down(e: PEvent) {
    if (!this.active) return;
    const sh = this.splitHandle();
    if (sh && Math.hypot(e.sx - sh.x, e.sy - sh.y) < 14) { this.drag = { what: 'split', start: { x: e.x, y: e.y }, snap: null }; return; }
    let h = this.hit(e);
    if (!h && this.mode === 'field') {
      this.pins.push({ x: e.x, y: e.y, blur: this.pins[this.selPin]?.blur ?? 15 });
      this.selPin = this.pins.length - 1;
      h = 'pin' + this.selPin;
      this.schedule();
      app.update('options');
    }
    if (!h) return;
    if (h.startsWith('ring:')) {
      const id = h.slice(5);
      if (id.startsWith('pin')) { this.selPin = parseInt(id.slice(3)); app.update('options'); }
      this.drag = { what: h, start: { x: e.x, y: e.y }, snap: null, angle: this.ringAngle(id, e), turned: 0, blur0: this.getBlur(id) };
      this.cursor = 'grabbing'; app.viewport.updateCursor();
      return;
    }
    if (h.startsWith('pin')) { this.selPin = parseInt(h.slice(3)); app.update('options'); }
    this.drag = { what: h, start: { x: e.x, y: e.y }, snap: JSON.parse(JSON.stringify({ iris: this.iris, tilt: this.tilt, pins: this.pins })) };
  }

  move(e: PEvent) {
    const dr = this.drag;
    if (!dr) return;
    if (dr.what === 'split') { this.split = Math.round(clamp(e.x, 0, app.doc!.width)); this.schedule(); app.update('overlay', 'canvas'); return; }
    if (dr.what.startsWith('ring:')) {
      // turning along the ring: clockwise adds blur, a full turn is RING_TURN px
      const id = dr.what.slice(5);
      const a = this.ringAngle(id, e);
      let da = a - dr.angle!;
      if (da > Math.PI) da -= Math.PI * 2; else if (da < -Math.PI) da += Math.PI * 2;
      dr.angle = a; dr.turned! += da;
      this.setBlur(id, Math.round(clamp(dr.blur0! + (dr.turned! / (Math.PI * 2)) * RING_TURN, 0, 500)));
      this.schedule();
      app.update('overlay', 'options');
      return;
    }
    const dx = e.x - dr.start.x, dy = e.y - dr.start.y;
    if (this.mode === 'iris') {
      const ir = this.iris, s0 = dr.snap.iris;
      if (dr.what === 'center') { ir.cx = s0.cx + dx; ir.cy = s0.cy + dy; }
      else if (dr.what === 'rx') ir.rx = Math.max(5, Math.abs(e.x - ir.cx));
      else if (dr.what === 'ry') ir.ry = Math.max(5, Math.abs(e.y - ir.cy));
      else if (dr.what === 'feather') { const ux = (e.x - ir.cx) / ir.rx, uy = (e.y - ir.cy) / ir.ry; ir.feather = clamp(Math.hypot(ux, uy), 0, 0.98); }
    } else if (this.mode === 'tilt') {
      const tl = this.tilt, s0 = dr.snap.tilt;
      const nx = -Math.sin(tl.angle), ny = Math.cos(tl.angle);
      const dist = Math.abs((e.x - tl.cx) * nx + (e.y - tl.cy) * ny);
      if (dr.what === 'center') { tl.cx = s0.cx + dx; tl.cy = s0.cy + dy; }
      else if (dr.what === 'rotate') { let a = Math.atan2(e.y - tl.cy, e.x - tl.cx); if (e.shift) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12); tl.angle = a; }
      else if (dr.what === 'focus') { const tot = tl.focus + tl.trans; tl.focus = clamp(dist, 0, tot - 2); tl.trans = tot - tl.focus; }
      else if (dr.what === 'trans') tl.trans = Math.max(2, dist - tl.focus);
    } else {
      const i = parseInt(dr.what.slice(3)), p = this.pins[i], s0 = dr.snap.pins[i];
      if (p) { p.x = s0.x + dx; p.y = s0.y + dy; }
    }
    this.schedule();
  }

  up() {
    if (this.drag?.what.startsWith('ring:')) { this.cursor = 'grab'; app.viewport.updateCursor(); }
    this.drag = null;
  }

  keydown(e: KeyboardEvent) {
    if (!this.active) return false;
    if (e.key === 'Enter') { this.apply(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.mode === 'field' && this.pins.length > 1) {
      this.pins.splice(this.selPin, 1); this.selPin = 0; this.schedule(); app.update('options'); return true;
    }
    return false;
  }

  overlay(g: CanvasRenderingContext2D) {
    if (!this.active) return;
    const v = app.viewport, z = app.doc!.zoom;
    g.save();
    const line = (dash: boolean) => { g.setLineDash(dash ? [5, 4] : []); g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 3; g.stroke(); g.strokeStyle = '#fff'; g.lineWidth = 1.2; g.stroke(); };
    if (this.mode === 'iris') {
      const ir = this.iris, c = v.toScreen(ir.cx, ir.cy);
      g.beginPath(); g.ellipse(c.x, c.y, ir.rx * z, ir.ry * z, 0, 0, Math.PI * 2); line(false);
      g.beginPath(); g.ellipse(c.x, c.y, ir.rx * z * ir.feather, ir.ry * z * ir.feather, 0, 0, Math.PI * 2); line(true);
    } else if (this.mode === 'tilt') {
      const tl = this.tilt;
      const dx = Math.cos(tl.angle), dy = Math.sin(tl.angle), nx = -dy, ny = dx;
      const L = 5000;
      const drawLine = (off: number, dash: boolean) => {
        const a = v.toScreen(tl.cx + nx * off - dx * L, tl.cy + ny * off - dy * L), b = v.toScreen(tl.cx + nx * off + dx * L, tl.cy + ny * off + dy * L);
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); line(dash);
      };
      drawLine(tl.focus, false); drawLine(-tl.focus, false);
      drawLine(tl.focus + tl.trans, true); drawLine(-tl.focus - tl.trans, true);
    }
    const sh = this.splitHandle();
    if (sh) {
      g.setLineDash([]);
      g.beginPath(); g.moveTo(Math.round(sh.x) + 0.5, 0); g.lineTo(Math.round(sh.x) + 0.5, v.h); line(false);
      g.beginPath(); g.arc(sh.x, sh.y, 10, 0, Math.PI * 2);
      g.fillStyle = 'rgba(20,20,20,.75)'; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
      g.beginPath(); g.moveTo(sh.x - 5, sh.y); g.lineTo(sh.x - 2, sh.y - 3); g.lineTo(sh.x - 2, sh.y + 3); g.closePath();
      g.moveTo(sh.x + 5, sh.y); g.lineTo(sh.x + 2, sh.y - 3); g.lineTo(sh.x + 2, sh.y + 3); g.closePath();
      g.fillStyle = '#fff'; g.fill();
    }
    for (const h of this.handles()) {
      const s = v.toScreen(h.x, h.y);
      const big = h.id === 'center' || h.id.startsWith('pin');
      g.setLineDash([]);
      g.beginPath(); g.arc(s.x, s.y, big ? 8 : 4.5, 0, Math.PI * 2);
      g.fillStyle = h.id.startsWith('pin') && h.id === 'pin' + this.selPin ? '#fff' : 'rgba(20,20,20,.65)';
      g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
      if (big) {
        // the blur ring, as on Photoshop pins: drag along it to change the blur
        const blur = this.getBlur(h.id);
        const active = this.ringHover === h.id || this.drag?.what === 'ring:' + h.id;
        const end = -Math.PI / 2 + Math.PI * 2 * Math.min(1, blur / RING_TURN);
        g.beginPath(); g.arc(s.x, s.y, 14, 0, Math.PI * 2);
        g.strokeStyle = active ? 'rgba(255,255,255,.45)' : 'rgba(255,255,255,.25)'; g.lineWidth = 4; g.stroke();
        g.beginPath(); g.arc(s.x, s.y, 14, -Math.PI / 2, end);
        g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 5; g.stroke();
        g.strokeStyle = '#fff'; g.lineWidth = 3; g.stroke();
        g.beginPath(); g.arc(s.x + Math.cos(end) * 14, s.y + Math.sin(end) * 14, active ? 4 : 3, 0, Math.PI * 2);
        g.fillStyle = '#fff'; g.fill();
        if (active) {
          const text = Math.round(blur) + ' px';
          g.font = '600 11px system-ui, sans-serif'; g.textBaseline = 'middle';
          const tw = g.measureText(text).width + 12;
          g.fillStyle = 'rgba(20,20,20,.75)'; g.beginPath(); g.roundRect(s.x + 22, s.y - 10, tw, 20, 10); g.fill();
          g.fillStyle = '#fff'; g.fillText(text, s.x + 28, s.y + 0.5);
        }
      }
    }
    g.restore();
  }

  options() {
    const blurVal = this.mode === 'field' ? (this.pins[this.selPin]?.blur ?? 15) : this.mode === 'iris' ? this.iris.blur : this.tilt.blur;
    return [
      numberField({
        label: t('blur.amount'), value: Math.round(blurVal), min: 0, max: 500, unit: 'px',
        onChange: v => {
          if (this.mode === 'field') { if (this.pins[this.selPin]) this.pins[this.selPin].blur = v; }
          else if (this.mode === 'iris') this.iris.blur = v; else this.tilt.blur = v;
          this.schedule(); app.update('overlay');
        },
      }),
      numberField({ label: t('blur.bokeh'), value: this.bokeh, min: 0, max: 100, unit: '%', onChange: v => { this.bokeh = v; this.schedule(); } }),
      this.mode === 'field' ? span(t('blur.fieldHint')) : null,
      spacer(),
      textButton(t('dlg.cancel'), () => this.cancel()),
      textButton(t('opt.apply'), () => this.apply(), true),
    ];
  }
}

export const blurGalleryTool = new BlurGalleryTool();
