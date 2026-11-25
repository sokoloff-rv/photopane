import { app, PaintTarget } from '../app';
import { t } from '../i18n';
import { Tool, PEvent } from './tool';
import { DabPath, StrokeSession, brushTip } from './paint';
import { cloneCanvas, createCanvas, ctx2d, Rect, rectUnion } from '../core/util';
import { rgbToHsl, hslToRgb } from '../core/color';
import { numberField, checkbox, select, sep } from '../ui/controls';
import { toast } from '../ui/dialog';

const falloff = (d: number, h: number) => {
  if (d >= 1) return 0;
  if (d <= h) return 1;
  const x = (d - h) / (1 - h);
  return 1 - x * x * (3 - 2 * x);
};

/* ---------------- pixel brushes (operate directly on pixels per dab) ---------------- */
interface PixOpts { size: number; hardness: number; strength: number; [k: string]: any }

abstract class PixelBrush<O extends PixOpts> extends Tool<O> {
  protected target: PaintTarget | null = null;
  protected backup: HTMLCanvasElement | null = null;
  protected sel: Uint8Array | null = null;
  protected path: DabPath | null = null;
  protected total: Rect | null = null;
  /**
   * The pixels the dabs read and write: a CPU copy of the layer. Reading the layer canvas itself (GPU) on
   * every dab stalled the brush and made the browser upload the whole layer again on each frame; now only
   * the area changed by a pointer move is written into the layer.
   */
  protected work: CanvasRenderingContext2D | null = null;
  private moveRect: Rect | null = null;
  protected changed(r: Rect) { this.moveRect = rectUnion(this.moveRect, r); this.total = rectUnion(this.total, r); }
  protected margin = 0;
  abstract readonly label: string;

  brushSize() { return this.o.size; }

  down(e: PEvent) {
    const tg = app.paintTarget();
    if (!tg) return;
    if (tg.isMask) { toast(t('app.layerLocked')); return; }
    const d = app.doc!;
    tg.surface.ensureCovers({ x: 0, y: 0, w: d.width, h: d.height });
    this.target = tg;
    // the dabs read the stroke's starting pixels: a CPU canvas, so the first read does not wait for the GPU
    this.backup = createCanvas(tg.surface.w, tg.surface.h);
    this.backup.getContext('2d', { willReadFrequently: true })!.drawImage(tg.surface.canvas, 0, 0);
    this.work = createCanvas(tg.surface.w, tg.surface.h).getContext('2d', { willReadFrequently: true })!;
    this.work.drawImage(this.backup, 0, 0);
    this.moveRect = null;
    this.sel = d.selection ? d.selection.alpha() : null;
    this.total = null;
    this.path = new DabPath(() => Math.max(1, this.o.size * this.spacing()));
    this.start(e);
    for (const p of this.path.to(e.x, e.y, e.pressure, true)) this.dab(p.x, p.y);
    this.endMove();
    this.flush();
  }

  protected spacing() { return 0.15; }
  protected start(_e: PEvent) {}

  move(e: PEvent) {
    if (!this.target) return;
    for (const p of this.path!.to(e.x, e.y, e.pressure)) this.dab(p.x, p.y);
    this.endMove();
    this.flush();
  }

  /** After the dabs of one pointer event (tools that work on the whole stroke at once). */
  protected endMove() {}

  up() {
    if (!this.target) return;
    if (this.total) this.target.surface.markDirty(this.total);
    this.target = null;
    this.work = null;
    app.commit(this.label);
  }

  cancel() {
    if (this.target && this.backup) {
      const g = this.target.surface.ctx;
      g.globalCompositeOperation = 'copy'; g.drawImage(this.backup, 0, 0); g.globalCompositeOperation = 'source-over';
      this.target.layer.touch();
      app.update('canvas');
    }
    this.target = null;
  }

  busy() { return !!this.target; }

  /** The area the last pointer move changed goes from the working copy into the layer and onto the screen. */
  private flush() {
    const r = this.moveRect, tg = this.target;
    if (!r || !tg || !this.work) return;
    this.moveRect = null;
    const s = tg.surface;
    s.ctx.putImageData(this.work.getImageData(r.x, r.y, r.w, r.h), r.x, r.y);
    tg.layer.touch();
    app.paintDirty({ x: r.x + s.x, y: r.y + s.y, w: r.w, h: r.h });
  }

  /** Process one dab: weights per pixel and the operation. */
  protected dab(x: number, y: number) {
    const s = this.target!.surface;
    const d = app.doc!;
    const r = this.o.size / 2;
    const m = this.margin;
    const lx = x - s.x, ly = y - s.y;
    const x0 = Math.max(0, Math.floor(lx - r) - m), y0 = Math.max(0, Math.floor(ly - r) - m);
    const x1 = Math.min(s.w, Math.ceil(lx + r) + m), y1 = Math.min(s.h, Math.ceil(ly + r) + m);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    const img = this.work!.getImageData(x0, y0, w, h);
    const weights = new Float32Array(w * h);
    const hard = this.o.hardness / 100, str = this.o.strength / 100;
    let any = false;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const px = x0 + i, py = y0 + j;
      let wt = falloff(Math.hypot(px + 0.5 - lx, py + 0.5 - ly) / r, hard) * str;
      if (wt <= 0) continue;
      if (this.sel) {
        const dx = px + s.x, dy = py + s.y;
        wt *= dx >= 0 && dy >= 0 && dx < d.width && dy < d.height ? this.sel[dy * d.width + dx] / 255 : 0;
      } else {
        const dx = px + s.x, dy = py + s.y;
        if (dx < 0 || dy < 0 || dx >= d.width || dy >= d.height) wt = 0;
      }
      weights[j * w + i] = wt;
      if (wt > 0) any = true;
    }
    if (!any) return;
    this.op(img, weights, w, h, x0, y0, lx, ly);
    this.work!.putImageData(img, x0, y0);
    this.changed({ x: x0, y: y0, w, h });
  }

  protected abstract op(img: ImageData, wt: Float32Array, w: number, h: number, x0: number, y0: number, cx: number, cy: number): void;

  protected baseOptions() {
    return [
      numberField({ label: t('opt.size'), value: this.o.size, min: 1, max: 1000, unit: 'px', log: true, onChange: v => { this.set('size', v as any); app.update('overlay'); } }),
      numberField({ label: t('opt.hardness'), value: this.o.hardness, min: 0, max: 100, unit: '%', onChange: v => this.set('hardness', v as any) }),
    ];
  }
}

/* ---------- Blur / Sharpen ---------- */
function boxAvg(d: Uint8ClampedArray, w: number, h: number, i: number, j: number, c: number, rad: number) {
  let s = 0, n = 0;
  for (let yy = Math.max(0, j - rad); yy <= Math.min(h - 1, j + rad); yy++)
    for (let xx = Math.max(0, i - rad); xx <= Math.min(w - 1, i + rad); xx++) { s += d[(yy * w + xx) * 4 + c]; n++; }
  return s / n;
}

export class BlurTool extends PixelBrush<PixOpts> {
  readonly id: string = 'blur';
  readonly iconName: string = 'blur';
  readonly key: string = 'R';
  readonly label: string = 'tool.blur';
  protected margin = 2;
  constructor() { super({ size: 60, hardness: 50, strength: 50 }); }
  protected op(img: ImageData, wt: Float32Array, w: number, h: number) {
    const src = img.data.slice();
    const d = img.data;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = wt[j * w + i];
      if (!k) continue;
      const p = (j * w + i) * 4;
      for (let c = 0; c < 4; c++) d[p + c] = src[p + c] + (boxAvg(src, w, h, i, j, c, 2) - src[p + c]) * k * 0.6;
    }
  }
  options() { return [...this.baseOptions(), sep(), numberField({ label: t('opt.strength'), value: this.o.strength, min: 1, max: 100, unit: '%', onChange: v => this.set('strength', v) })]; }
}

export class SharpenTool extends BlurTool {
  readonly id = 'sharpen';
  readonly iconName = 'sharpen';
  readonly label = 'tool.sharpen';
  protected margin = 1;
  constructor() { super(); this.o.strength = 35; }
  protected op(img: ImageData, wt: Float32Array, w: number, h: number) {
    const src = img.data.slice();
    const d = img.data;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = wt[j * w + i];
      if (!k) continue;
      const p = (j * w + i) * 4;
      for (let c = 0; c < 3; c++) d[p + c] = src[p + c] + (src[p + c] - boxAvg(src, w, h, i, j, c, 1)) * k * 0.7;
    }
  }
}

/* ---------- Smudge ---------- */
export class SmudgeTool extends PixelBrush<PixOpts> {
  readonly id = 'smudge';
  readonly iconName = 'smudge';
  readonly key = 'R';
  readonly label = 'tool.smudge';
  private buf: Float32Array | null = null;
  private bufSize = 0;
  constructor() { super({ size: 50, hardness: 40, strength: 50 }); }
  protected spacing() { return 0.08; }
  protected start() { this.buf = null; }
  protected op(img: ImageData, wt: Float32Array, w: number, h: number, x0: number, y0: number, cx: number, cy: number) {
    const D = Math.ceil(this.o.size) + 2;
    const d = img.data;
    const bx = Math.round(cx) - Math.floor(D / 2), by = Math.round(cy) - Math.floor(D / 2);
    if (!this.buf || this.bufSize !== D) {
      this.bufSize = D;
      this.buf = new Float32Array(D * D * 4);
      for (let j = 0; j < D; j++) for (let i = 0; i < D; i++) {
        const ii = bx + i - x0, jj = by + j - y0;
        if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
        const p = (jj * w + ii) * 4, q = (j * D + i) * 4;
        for (let c = 0; c < 4; c++) this.buf[q + c] = d[p + c];
      }
      return;
    }
    const buf = this.buf;
    for (let j = 0; j < D; j++) for (let i = 0; i < D; i++) {
      const ii = bx + i - x0, jj = by + j - y0;
      if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
      const k = wt[jj * w + ii];
      const p = (jj * w + ii) * 4, q = (j * D + i) * 4;
      if (k) for (let c = 0; c < 4; c++) d[p + c] = d[p + c] + (buf[q + c] - d[p + c]) * k;
      for (let c = 0; c < 4; c++) buf[q + c] = d[p + c];
    }
  }
  options() { return [...this.baseOptions(), sep(), numberField({ label: t('opt.strength'), value: this.o.strength, min: 1, max: 100, unit: '%', onChange: v => this.set('strength', v) })]; }
}

/* ---------- Dodge / Burn ---------- */
type Range = 'shadows' | 'midtones' | 'highlights';
interface DBOpts extends PixOpts { range: Range }

export class DodgeTool extends PixelBrush<DBOpts> {
  readonly id: string = 'dodge';
  readonly iconName: string = 'dodge';
  readonly key: string = 'O';
  readonly label: string = 'tool.dodge';
  protected dir = 1;
  /** Stroke coverage per surface pixel (0..1, already scaled by exposure). */
  private cov: Float32Array | null = null;
  private covW = 0;
  /** Area whose coverage changed since the pixels were last updated (surface coordinates). */
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  constructor(defaults?: any) { super(defaults ?? { size: 80, hardness: 0, strength: 50, range: 'midtones' }); }
  protected start(_e?: PEvent) {
    const s = this.target!.surface;
    this.covW = s.w;
    this.cov = new Float32Array(s.w * s.h);
    this.dirty = null;
  }

  /**
   * Like Photoshop, one stroke changes a pixel by at most the exposure: overlapping dabs only extend the
   * stroke's coverage, and the result is always computed from the pixels as they were before the stroke.
   * So a dab only updates the coverage; the pixels of all dabs of a pointer move are computed once.
   */
  protected dab(x: number, y: number) {
    const s = this.target!.surface;
    const d = app.doc!;
    const r = this.o.size / 2, ir = 1 / r;
    const lx = x - s.x, ly = y - s.y;
    const x0 = Math.max(0, Math.floor(lx - r)), y0 = Math.max(0, Math.floor(ly - r));
    const x1 = Math.min(s.w, Math.ceil(lx + r)), y1 = Math.min(s.h, Math.ceil(ly + r));
    if (x1 <= x0 || y1 <= y0) return;
    const hard = this.o.hardness / 100, str = this.o.strength / 100;
    const cov = this.cov!, CW = this.covW, sel = this.sel;
    for (let py = y0; py < y1; py++) {
      const dy = (py + 0.5 - ly) * ir, docY = py + s.y;
      if (docY < 0 || docY >= d.height) continue;
      for (let px = x0; px < x1; px++) {
        const dx = (px + 0.5 - lx) * ir;
        const dist2 = dx * dx + dy * dy;
        if (dist2 >= 1) continue;
        const docX = px + s.x;
        if (docX < 0 || docX >= d.width) continue;
        let wt = falloff(Math.sqrt(dist2), hard) * str;
        if (sel) wt *= sel[docY * d.width + docX] / 255;
        const ci = py * CW + px;
        if (wt > cov[ci]) cov[ci] = wt;
      }
    }
    const dr = this.dirty;
    this.dirty = dr ? { x0: Math.min(dr.x0, x0), y0: Math.min(dr.y0, y0), x1: Math.max(dr.x1, x1), y1: Math.max(dr.y1, y1) } : { x0, y0, x1, y1 };
  }

  protected endMove() {
    const dr = this.dirty;
    if (!dr || !this.target) return;
    this.dirty = null;
    const w = dr.x1 - dr.x0, h = dr.y1 - dr.y0;
    const img = this.work!.getImageData(dr.x0, dr.y0, w, h);
    const orig = this.backup!.getContext('2d')!.getImageData(dr.x0, dr.y0, w, h).data;
    const d = img.data, cov = this.cov!, CW = this.covW;
    this.prepareTone();
    for (let j = 0, p = 0; j < h; j++) {
      const row = (dr.y0 + j) * CW + dr.x0;
      for (let i = 0; i < w; i++, p += 4) {
        const c = cov[row + i];
        if (c) this.tone(orig, d, p, c);
      }
    }
    this.work!.putImageData(img, dr.x0, dr.y0);
    this.changed({ x: dr.x0, y: dr.y0, w, h });
  }

  /** Settings read once per pointer move, before tone() runs for its pixels. */
  protected prepareTone() {}

  /** One pixel: `orig` as before the stroke, `d` gets the result, `c` the stroke's coverage there. */
  protected tone(orig: Uint8ClampedArray, d: Uint8ClampedArray, p: number, c: number) {
    const range = this.o.range, dodge = this.dir > 0;
    {
      {
        const r = orig[p] / 255, g = orig[p + 1] / 255, b = orig[p + 2] / 255;
        const L = 0.299 * r + 0.587 * g + 0.114 * b;
        const a = c * 0.5;
        let L2: number;
        if (range === 'midtones') {
          // dodge lifts with a gamma curve; burn uses its mirror image, which darkens the midtones as much
          // but the shadows far less (L^(1+a) ran dark areas to black within a couple of strokes)
          L2 = dodge ? Math.pow(L, 1 / (1 + a)) : 1 - Math.pow(1 - L, 1 / (1 + a * 0.8));
        } else {
          const tw = range === 'shadows' ? (1 - L) * (1 - L) : L * L;
          L2 = dodge ? L + (1 - L) * a * tw * 0.8 : L - L * a * tw * 0.8;
        }
        // protect tones: scale the colour with the luminance so hue and saturation stay
        let R: number, G: number, B: number;
        if (L > 1e-4) { const k = L2 / L; R = r * k; G = g * k; B = b * k; }
        else R = G = B = L2;
        const mx = Math.max(R, G, B);
        if (mx > 1) { const t = (mx - 1) / (mx - L2 || 1); R += (L2 - R) * t; G += (L2 - G) * t; B += (L2 - B) * t; }
        d[p] = R * 255; d[p + 1] = G * 255; d[p + 2] = B * 255;
      }
    }
  }

  protected op() { /* pixels are computed per pointer move in endMove() */ }
  up() { super.up(); this.cov = null; }
  options() {
    return [
      ...this.baseOptions(), sep(),
      select<Range>([{ value: 'shadows', label: t('opt.shadows') }, { value: 'midtones', label: t('opt.midtones') }, { value: 'highlights', label: t('opt.highlights') }], this.o.range, v => this.set('range', v)),
      numberField({ label: t('opt.exposure'), value: this.o.strength, min: 1, max: 100, unit: '%', onChange: v => this.set('strength', v) }),
    ];
  }
}

export class BurnTool extends DodgeTool {
  readonly id = 'burn';
  readonly iconName = 'burn';
  readonly label = 'tool.burn';
  protected dir = -1;
}

/* ---------- Color replacement ---------- */
interface CROpts extends PixOpts { tolerance: number; sampling: 'once' | 'continuous' }

/**
 * Like Dodge/Burn, a stroke changes each pixel once, from the pixels as they were before the stroke: the
 * dabs only extend the stroke's coverage. Each dab used to recolour pixels already recoloured by the dabs
 * before it (and to sample its own result), so the stroke came out patchy, one circle on top of another.
 */
export class ReplaceTool extends DodgeTool {
  readonly id = 'replace';
  readonly iconName = 'colorReplace';
  readonly key = 'B';
  readonly label = 'tool.replace';
  private sample: [number, number, number] | null = null;
  private toneArgs = { tol: 0, fh: 0, fs: 0 };
  constructor() { super({ size: 40, hardness: 60, strength: 100, tolerance: 30, sampling: 'continuous', range: 'midtones' }); }
  protected start(e?: PEvent) { super.start(); if (e) this.sample = this.sampleAt(e.x, e.y); }
  /** The colour to replace, read from the picture before the stroke. */
  private sampleAt(x: number, y: number): [number, number, number] | null {
    const s = this.target!.surface;
    const lx = Math.floor(x - s.x), ly = Math.floor(y - s.y);
    if (lx < 0 || ly < 0 || lx >= s.w || ly >= s.h) return null;
    const p = this.backup!.getContext('2d')!.getImageData(lx, ly, 1, 1).data;
    return [p[0], p[1], p[2]];
  }
  protected dab(x: number, y: number) {
    if ((this.o as any).sampling === 'continuous') this.sample = this.sampleAt(x, y) || this.sample;
    super.dab(x, y);
  }
  protected prepareTone() {
    const [fh, fs] = rgbToHsl(app.fg.r / 255, app.fg.g / 255, app.fg.b / 255);
    this.toneArgs = { tol: (this.o as any).tolerance * 2.55, fh, fs };
  }
  protected tone(orig: Uint8ClampedArray, d: Uint8ClampedArray, p: number, c: number) {
    const smp = this.sample;
    if (!smp || !orig[p + 3]) return;
    const { tol, fh, fs } = this.toneArgs;
    const diff = Math.max(Math.abs(orig[p] - smp[0]), Math.abs(orig[p + 1] - smp[1]), Math.abs(orig[p + 2] - smp[2]));
    if (diff > tol) { d[p] = orig[p]; d[p + 1] = orig[p + 1]; d[p + 2] = orig[p + 2]; return; }
    const k = c * (tol > 0 ? Math.min(1, (tol - diff) / (tol * 0.35 + 1)) : 1);
    const [, , l] = rgbToHsl(orig[p] / 255, orig[p + 1] / 255, orig[p + 2] / 255);
    const [r, g, b] = hslToRgb(fh, fs, l);
    d[p] = orig[p] + (r * 255 - orig[p]) * k; d[p + 1] = orig[p + 1] + (g * 255 - orig[p + 1]) * k; d[p + 2] = orig[p + 2] + (b * 255 - orig[p + 2]) * k;
  }
  options() {
    const o = this.o as any;
    return [
      ...this.baseOptions(), sep(),
      numberField({ label: t('opt.tolerance'), value: o.tolerance, min: 1, max: 100, unit: '%', onChange: v => this.set('tolerance' as any, v as any) }),
      select([{ value: 'continuous', label: t('opt.sampleCont') }, { value: 'once', label: t('opt.sampleOnce') }], o.sampling, v => this.set('sampling' as any, v as any)),
    ];
  }
}

/* ---------------- Clone stamp ---------------- */
interface StampOpts { size: number; hardness: number; opacity: number; flow: number; aligned: boolean; allLayers: boolean; showSource: boolean }

export class StampTool extends Tool<StampOpts> {
  readonly id = 'stamp';
  readonly iconName = 'stamp';
  readonly key = 'S';
  private source: { x: number; y: number } | null = null;
  private offset: { x: number; y: number } | null = null;
  private session: StrokeSession | null = null;
  private snap: { c: HTMLCanvasElement; x: number; y: number } | null = null;
  private path: DabPath | null = null;
  private dabCanvas = createCanvas(1, 1);
  private strokeStart: { x: number; y: number } | null = null;

  constructor() { super({ size: 60, hardness: 50, opacity: 100, flow: 100, aligned: true, allLayers: false, showSource: true }); }

  brushSize() { return this.o.size; }

  down(e: PEvent) {
    if (e.alt) { this.source = { x: e.x, y: e.y }; this.offset = null; toast(t('stamp.sourceSet'), 'info', 1200); app.update('overlay'); return; }
    if (!this.source) { toast(t('stamp.needSource')); return; }
    const target = app.paintTarget();
    if (!target) return;
    const d = app.doc!;
    if (!this.offset || !this.o.aligned) this.offset = { x: this.source.x - e.x, y: this.source.y - e.y };
    if (this.o.allLayers || target.isMask) this.snap = { c: cloneCanvas(d.composite()), x: 0, y: 0 };
    else this.snap = { c: cloneCanvas(target.layer.canvas), x: target.layer.x, y: target.layer.y };
    this.session = new StrokeSession(target, 'paint', this.o.opacity / 100, app.fg);
    this.path = new DabPath(() => Math.max(1, this.o.size * 0.1));
    this.strokeStart = { x: e.x, y: e.y };
    for (const p of this.path.to(e.x, e.y, e.pressure, true)) this.dab(p.x, p.y);
    this.session.flush();
  }

  move(e: PEvent) {
    if (!this.session) return;
    for (const p of this.path!.to(e.x, e.y, e.pressure)) this.dab(p.x, p.y);
    this.session.flush();
  }

  up() {
    if (!this.session) return;
    this.session.finish('tool.stamp');
    this.session = null; this.snap = null; this.strokeStart = null;
    app.update('overlay');
  }

  cancel() { this.session?.cancel(); this.session = null; }
  busy() { return !!this.session; }

  private dab(x: number, y: number) {
    const s = this.session!, sn = this.snap!, off = this.offset!;
    const D = this.o.size;
    const tip = brushTip(Math.min(D, 1000), this.o.hardness / 100, { r: 255, g: 255, b: 255 });
    const size = tip.width * (D / Math.max(1, tip.width - 2));
    const n = Math.ceil(size);
    if (this.dabCanvas.width !== n || this.dabCanvas.height !== n) { this.dabCanvas.width = n; this.dabCanvas.height = n; }
    const g = ctx2d(this.dabCanvas);
    g.globalCompositeOperation = 'copy';
    g.drawImage(sn.c, -(x + off.x - size / 2 - sn.x), -(y + off.y - size / 2 - sn.y));
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(tip, 0, 0, size, size);
    g.globalCompositeOperation = 'source-over';
    const surf = s.target.surface;
    s.sg.globalAlpha = this.o.flow / 100;
    s.sg.drawImage(this.dabCanvas, x - surf.x - size / 2, y - surf.y - size / 2);
    s.touched({ x: x - size / 2, y: y - size / 2, w: size, h: size });
  }

  overlay(g: CanvasRenderingContext2D) {
    // the source marker can be hidden to see the picture under it better
    if (this.o.showSource === false) return;
    const v = app.viewport;
    this.drawPreview(g);
    let p: { x: number; y: number } | null = null;
    if (this.session && this.offset) {
      const cur = v.toDoc(v.pointer.sx, v.pointer.sy);
      p = { x: cur.x + this.offset.x, y: cur.y + this.offset.y };
    } else if (this.source && !this.offset) p = this.source;
    else if (this.source && this.offset && this.o.aligned && v.pointer.inside) {
      const cur = v.toDoc(v.pointer.sx, v.pointer.sy);
      p = { x: cur.x + this.offset.x, y: cur.y + this.offset.y };
    }
    if (!p) return;
    const s = v.toScreen(p.x, p.y);
    g.save();
    g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(s.x - 7, s.y); g.lineTo(s.x + 7, s.y); g.moveTo(s.x, s.y - 7); g.lineTo(s.x, s.y + 7); g.stroke();
    g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke();
    g.beginPath(); g.arc(s.x, s.y, (this.o.size * app.doc!.zoom) / 2, 0, Math.PI * 2); g.setLineDash([3, 3]); g.stroke();
    g.restore();
  }

  /**
   * Before painting (source chosen, pointer over the image): what the stamp would put down, shown under the
   * brush circle as in Photoshop, so the patch can be lined up before clicking.
   */
  private drawPreview(g: CanvasRenderingContext2D) {
    const v = app.viewport, d = app.doc;
    if (this.session || !this.source || !d || !v.pointer.inside) return;
    const l = d.active;
    if (!l || l.isGroup) return;
    const cur = v.toDoc(v.pointer.sx, v.pointer.sy);
    // aligned: the same offset as the last stroke; otherwise the next stroke starts at the source point
    const src = this.offset && this.o.aligned ? { x: cur.x + this.offset.x, y: cur.y + this.offset.y } : this.source;
    const all = this.o.allLayers || d.editMask;
    const img: CanvasImageSource = all ? d.composite() : l.canvas;
    const ox = all ? 0 : l.x, oy = all ? 0 : l.y;
    const r = this.o.size / 2, z = d.zoom;
    const p = v.toScreen(cur.x, cur.y);
    g.save();
    g.beginPath(); g.arc(p.x, p.y, r * z, 0, Math.PI * 2); g.clip();
    g.globalAlpha = 0.7;
    g.imageSmoothingEnabled = z < 1;
    g.drawImage(img, src.x - r - ox, src.y - r - oy, 2 * r, 2 * r, p.x - r * z, p.y - r * z, 2 * r * z, 2 * r * z);
    g.restore();
  }

  options() {
    return [
      numberField({ label: t('opt.size'), value: this.o.size, min: 1, max: 1000, unit: 'px', log: true, onChange: v => { this.set('size', v); app.update('overlay'); } }),
      numberField({ label: t('opt.hardness'), value: this.o.hardness, min: 0, max: 100, unit: '%', onChange: v => this.set('hardness', v) }),
      sep(),
      numberField({ label: t('opt.opacity'), value: this.o.opacity, min: 1, max: 100, unit: '%', onChange: v => this.set('opacity', v) }),
      numberField({ label: t('opt.flow'), value: this.o.flow, min: 1, max: 100, unit: '%', onChange: v => this.set('flow', v) }),
      sep(),
      checkbox(t('opt.aligned'), this.o.aligned, v => { this.set('aligned', v); this.offset = null; }),
      checkbox(t('opt.allLayers'), this.o.allLayers, v => this.set('allLayers', v)),
      checkbox(t('opt.showSource'), this.o.showSource !== false, v => { this.set('showSource', v); app.update('overlay'); }),
    ];
  }
}
