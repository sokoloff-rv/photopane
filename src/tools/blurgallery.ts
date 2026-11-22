import { app } from '../app';
import { t } from '../i18n';
import { Tool, PEvent } from './tool';
import { AdjustSession } from '../core/adjust';
import { gaussianBlur, smoothstep } from '../core/filters';
import { createCanvas, ctx2d, clamp } from '../core/util';
import { previews } from '../core/render';
import { numberField, segmented, sep } from '../ui/controls';
import { spacer, textButton, span } from './transform';
import { toast } from '../ui/dialog';

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
  private proxy: { k: number; canvas: HTMLCanvasElement; levels: Uint8ClampedArray[]; R: number; out: HTMLCanvasElement } | null = null;
  private pins: Pin[] = [];
  private selPin = 0;
  private iris = { cx: 0, cy: 0, rx: 100, ry: 100, feather: 0.5, blur: 15 };
  private tilt = { cx: 0, cy: 0, angle: 0, focus: 100, trans: 150, blur: 15 };
  private drag: { what: string; start: { x: number; y: number }; snap: any } | null = null;
  private timer = 0;

  constructor() { super({}); }

  get nameKey() { return 'cmd.blurGallery'; }
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
    this.active = true;
    const l = s.target.layer;
    previews.set(l.id, g => {
      const p = this.proxy;
      if (!p || !this.s) { g.drawImage(l.canvas, l.x, l.y); return; }
      g.drawImage(l.canvas, l.x, l.y);
      const sel = app.doc?.selection;
      if (sel) {
        const tmp = createCanvas(g.canvas.width, g.canvas.height), tg = ctx2d(tmp);
        tg.drawImage(p.out, this.s.ox, this.s.oy, this.s.w, this.s.h);
        tg.globalCompositeOperation = 'destination-in'; tg.drawImage(sel.mask, 0, 0);
        g.drawImage(tmp, 0, 0);
      } else g.drawImage(p.out, this.s.ox, this.s.oy, this.s.w, this.s.h);
    });
    this.renderProxy();
    return true;
  }

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
      }
    }
  }

  private levelsFor(src: HTMLCanvasElement, R: number): Uint8ClampedArray[] {
    const N = 5;
    const out: Uint8ClampedArray[] = [];
    for (let i = 0; i < N; i++) out.push(blurLevel(src, (R * i) / (N - 1) / 2));
    return out;
  }

  private renderProxy() {
    const p = this.proxy, s = this.s;
    if (!p || !s) return;
    const R = this.maxBlur();
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
    this.timer = requestAnimationFrame(() => { this.timer = 0; this.renderProxy(); });
  }

  apply() {
    if (!this.active || !this.s) return;
    const s = this.s;
    toast(t('adj.processing'), 'info', 1500);
    setTimeout(() => {
      const R = this.maxBlur();
      const levels = this.levelsFor(this.srcCanvas!, R);
      this.cleanup();
      s.commit('cmd.blurGallery', (_src, dst) => this.composite(levels, R, s.w, s.h, 1, s.ox, s.oy, dst));
      app.popTool();
    }, 30);
  }

  private cleanup() {
    if (this.s) previews.delete(this.s.target.layer.id);
    this.active = false;
    this.proxy = null;
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
    for (const h of this.handles()) { const s = this.scr(h.x, h.y); if (Math.hypot(s.x - e.sx, s.y - e.sy) < 10) return h.id; }
    return null;
  }

  hover(e: PEvent) {
    if (!this.active) return;
    const h = this.hit(e);
    const c = h ? (h === 'center' || h.startsWith('pin') ? 'move' : 'pointer') : this.mode === 'field' ? 'copy' : 'default';
    if (c !== this.cursor) { this.cursor = c; app.viewport.updateCursor(); }
  }

  down(e: PEvent) {
    if (!this.active) return;
    let h = this.hit(e);
    if (!h && this.mode === 'field') {
      this.pins.push({ x: e.x, y: e.y, blur: this.pins[this.selPin]?.blur ?? 15 });
      this.selPin = this.pins.length - 1;
      h = 'pin' + this.selPin;
      this.schedule();
      app.update('options');
    }
    if (!h) return;
    if (h.startsWith('pin')) { this.selPin = parseInt(h.slice(3)); app.update('options'); }
    this.drag = { what: h, start: { x: e.x, y: e.y }, snap: JSON.parse(JSON.stringify({ iris: this.iris, tilt: this.tilt, pins: this.pins })) };
  }

  move(e: PEvent) {
    const dr = this.drag;
    if (!dr) return;
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

  up() { this.drag = null; }

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
    for (const h of this.handles()) {
      const s = v.toScreen(h.x, h.y);
      const big = h.id === 'center' || h.id.startsWith('pin');
      g.setLineDash([]);
      g.beginPath(); g.arc(s.x, s.y, big ? 8 : 4.5, 0, Math.PI * 2);
      g.fillStyle = h.id.startsWith('pin') && h.id === 'pin' + this.selPin ? '#fff' : 'rgba(20,20,20,.65)';
      g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
      if (big) {
        // blur ring like Photoshop pins
        const blur = h.id.startsWith('pin') ? this.pins[parseInt(h.id.slice(3))].blur : this.maxBlur();
        const maxB = 200;
        g.beginPath(); g.arc(s.x, s.y, 14, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, blur / maxB));
        g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 2.5; g.stroke();
      }
    }
    g.restore();
  }

  options() {
    const blurVal = this.mode === 'field' ? (this.pins[this.selPin]?.blur ?? 15) : this.mode === 'iris' ? this.iris.blur : this.tilt.blur;
    return [
      segmented<Mode>([
        { value: 'field', label: t('blur.field'), title: t('cmd.fieldBlur') },
        { value: 'iris', label: t('blur.iris'), title: t('cmd.irisBlur') },
        { value: 'tilt', label: t('blur.tilt'), title: t('cmd.tiltShift') },
      ], this.mode, v => { this.mode = v; this.schedule(); app.update('options', 'overlay', 'status'); }),
      sep(),
      numberField({
        label: t('blur.amount'), value: Math.round(blurVal), min: 0, max: 500, unit: 'px',
        onChange: v => {
          if (this.mode === 'field') { if (this.pins[this.selPin]) this.pins[this.selPin].blur = v; }
          else if (this.mode === 'iris') this.iris.blur = v; else this.tilt.blur = v;
          this.schedule(); app.update('overlay');
        },
      }),
      this.mode === 'field' ? span(t('blur.fieldHint')) : null,
      spacer(),
      textButton(t('dlg.cancel'), () => this.cancel()),
      textButton(t('opt.apply'), () => this.apply(), true),
    ];
  }
}

export const blurGalleryTool = new BlurGalleryTool();
