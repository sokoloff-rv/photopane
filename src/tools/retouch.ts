import { app, PaintTarget } from '../app';
import { t } from '../i18n';
import { Tool, PEvent } from './tool';
import { DabPath, StrokeSession, brushTip } from './paint';
import { cloneCanvas, createCanvas, ctx2d, Rect, rectUnion } from '../core/util';
import { rgbToHsl, hslToRgb } from '../core/color';
import { numberField, checkbox, select, sep } from '../ui/controls';
import { MAX_BRUSH_SIZE } from '../ui/sizecurve';
import { toast } from '../ui/dialog';
import { Layer, hasEffects } from '../core/layer';
import { GpuRetouch, RetouchKind, PresentParams } from '../core/gpuretouch';

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
  /**
   * The stroke on the video card (see core/gpuretouch.ts): then there is no CPU copy (`backup`, `work`) and
   * the dabs and results are drawn by shaders. Null: the CPU does the stroke.
   */
  protected gpu: GpuRetouch | null = null;
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
    const kind = this.gpuKind();
    this.gpu = kind ? GpuRetouch.begin(tg.surface, d.width, d.height, d.selection, kind) : null;
    if (this.gpu) { this.backup = null; this.work = null; this.sel = null; }
    else {
      // the dabs read the stroke's starting pixels: a CPU canvas, so the first read does not wait for the GPU
      this.backup = createCanvas(tg.surface.w, tg.surface.h);
      this.backup.getContext('2d', { willReadFrequently: true })!.drawImage(tg.surface.canvas, 0, 0);
      this.work = createCanvas(tg.surface.w, tg.surface.h).getContext('2d', { willReadFrequently: true })!;
      this.work.drawImage(this.backup, 0, 0);
      this.sel = d.selection ? d.selection.alpha() : null;
    }
    this.moveRect = null;
    this.total = null;
    this.path = new DabPath(() => Math.max(1, this.o.size * this.spacing()));
    this.start(e);
    for (const p of this.path.to(e.x, e.y, e.pressure, true)) this.dab(p.x, p.y);
    this.endMove();
    this.flush();
  }

  protected spacing() { return 0.15; }
  protected start(_e: PEvent) {}

  /** What the video card does for this brush (null: the CPU only). */
  protected gpuKind(): RetouchKind | null { return null; }
  /** The settings the video card draws a pointer move's area with. */
  protected gpuParams(): PresentParams { return { kind: this.gpuKind()! }; }
  /** One dab on the video card (Blur, Smudge; the coverage brushes have their own dab()). */
  protected gpuDab(_x: number, _y: number) {}
  /** A dab's centre (surface pixels) and its area, `m` pixels wider; null when it misses the surface. */
  protected dabArea(x: number, y: number, m: number) {
    const s = this.target!.surface, r = this.o.size / 2, lx = x - s.x, ly = y - s.y;
    const x0 = Math.max(0, Math.floor(lx - r) - m), y0 = Math.max(0, Math.floor(ly - r) - m);
    const x1 = Math.min(s.w, Math.ceil(lx + r) + m), y1 = Math.min(s.h, Math.ceil(ly + r) + m);
    return x1 > x0 && y1 > y0 ? { lx, ly, r, x0, y0, x1, y1 } : null;
  }

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
    this.work = null; this.backup = null;
    this.gpu?.end(); this.gpu = null;
    app.commit(this.label);
  }

  cancel() {
    if (this.target && this.gpu) {
      // the layer as it was, from the copy on the video card
      if (this.total) this.gpu.present(this.total, 'orig', this.target.surface.ctx);
      this.target.layer.touch();
      app.update('canvas');
    } else if (this.target && this.backup) {
      const g = this.target.surface.ctx;
      g.globalCompositeOperation = 'copy'; g.drawImage(this.backup, 0, 0); g.globalCompositeOperation = 'source-over';
      this.target.layer.touch();
      app.update('canvas');
    }
    this.target = null;
    this.work = null; this.backup = null;
    this.gpu?.end(); this.gpu = null;
  }

  busy() { return !!this.target; }

  /** The area the last pointer move changed goes from the working copy into the layer and onto the screen. */
  private flush() {
    const r = this.moveRect, tg = this.target;
    if (!r || !tg || (!this.work && !this.gpu)) return;
    this.moveRect = null;
    const s = tg.surface;
    if (this.gpu) this.gpu.present(r, this.gpuParams(), s.ctx);
    else s.ctx.putImageData(this.work!.getImageData(r.x, r.y, r.w, r.h), r.x, r.y);
    tg.layer.touch();
    let fx = false;
    for (let l: Layer | null = tg.layer; l && !fx; l = l.parent) fx = hasEffects(l.effects);
    if (fx) app.update('canvas'); else app.paintDirty({ x: r.x + s.x, y: r.y + s.y, w: r.w, h: r.h });
  }

  /** Process one dab: weights per pixel and the operation. */
  protected dab(x: number, y: number) {
    if (this.gpu) { this.gpuDab(x, y); return; }
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
      numberField({ label: t('opt.size'), value: this.o.size, min: 1, max: MAX_BRUSH_SIZE, unit: 'px', log: true, onChange: v => { this.set('size', v as any); app.update('overlay'); } }),
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
  protected gpuKind(): RetouchKind | null { return 'blur'; }
  protected gpuDab(x: number, y: number) {
    const a = this.dabArea(x, y, this.margin);
    if (!a) return;
    this.gpu!.blurDab(a.lx, a.ly, a.r, this.o.hardness / 100, this.o.strength / 100, a.x0, a.y0, a.x1, a.y1);
    this.changed({ x: a.x0, y: a.y0, w: a.x1 - a.x0, h: a.y1 - a.y0 });
  }
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

/* ---------- Smudge ---------- */
/**
 * Each dab drags the picture from where the previous dab was. The dabs are 1–2 px apart and the colours are
 * taken between pixels (bilinear), so the smear is smooth: with dabs 8 % of the size apart, every dab left a
 * shifted copy of the detail and the copies added up to a comb of stripes. A dab mixes by weight × strength,
 * so the picture moves at strength × the brush's speed (the smear is as long as before, whatever the
 * spacing) and the brush's soft edge stays soft.
 */
export class SmudgeTool extends PixelBrush<PixOpts> {
  readonly id = 'smudge';
  readonly iconName = 'smudge';
  readonly key = 'R';
  readonly label = 'tool.smudge';
  protected margin = 3;
  /** The previous dab's centre and the shift from it to this dab (surface pixels). */
  private prev: { x: number; y: number } | null = null;
  private delta = { x: 0, y: 0 };
  constructor() { super({ size: 50, hardness: 40, strength: 50 }); }
  private step() { return Math.min(2, Math.max(1, this.o.size * 0.02)); }
  protected spacing() { return this.step() / this.o.size; }
  protected start() { this.prev = null; }
  protected dab(x: number, y: number) {
    const s = this.target!.surface, cx = x - s.x, cy = y - s.y, p = this.prev;
    this.prev = { x: cx, y: cy };
    // the first dab of a stroke only marks where the dragging starts
    if (!p) return;
    this.delta = { x: cx - p.x, y: cy - p.y };
    super.dab(x, y);
  }
  protected gpuKind(): RetouchKind | null { return 'smudge'; }
  protected gpuDab(x: number, y: number) {
    const a = this.dabArea(x, y, 0);
    if (!a) return;
    this.gpu!.smudgeDab(a.lx, a.ly, a.r, this.o.hardness / 100, this.o.strength / 100, this.delta.x, this.delta.y, a.x0, a.y0, a.x1, a.y1);
    this.changed({ x: a.x0, y: a.y0, w: a.x1 - a.x0, h: a.y1 - a.y0 });
  }
  protected op(img: ImageData, wt: Float32Array, w: number, h: number) {
    const src = img.data.slice(), d = img.data;
    const dx = this.delta.x, dy = this.delta.y;
    // colour × alpha, so transparent pixels do not darken what is dragged across them
    const tap = (i: number, j: number, f: number, acc: number[]) => {
      i = i < 0 ? 0 : i >= w ? w - 1 : i; j = j < 0 ? 0 : j >= h ? h - 1 : j;
      const q = (j * w + i) * 4, a = src[q + 3] / 255 * f;
      acc[0] += src[q] * a; acc[1] += src[q + 1] * a; acc[2] += src[q + 2] * a; acc[3] += a;
    };
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = wt[j * w + i];
      if (!k) continue;
      const sx = i - dx, sy = j - dy, ix = Math.floor(sx), iy = Math.floor(sy), tx = sx - ix, ty = sy - iy;
      const acc = [0, 0, 0, 0];
      tap(ix, iy, (1 - tx) * (1 - ty), acc); tap(ix + 1, iy, tx * (1 - ty), acc);
      tap(ix, iy + 1, (1 - tx) * ty, acc); tap(ix + 1, iy + 1, tx * ty, acc);
      const p = (j * w + i) * 4, a0 = src[p + 3] / 255;
      const A = a0 + (acc[3] - a0) * k;
      if (A <= 0) { d[p] = d[p + 1] = d[p + 2] = d[p + 3] = 0; continue; }
      for (let c = 0; c < 3; c++) d[p + c] = (src[p + c] * a0 + (acc[c] - src[p + c] * a0) * k) / A;
      d[p + 3] = A * 255;
    }
  }
  options() { return [...this.baseOptions(), sep(), numberField({ label: t('opt.strength'), value: this.o.strength, min: 1, max: 100, unit: '%', onChange: v => this.set('strength', v) })]; }
}

/* ---------- brushes with a stroke coverage (Dodge / Burn, Sharpen, Color Replacement) ---------- */
abstract class CoverageBrush<O extends PixOpts> extends PixelBrush<O> {
  /** Stroke coverage per surface pixel (0..1, already scaled by exposure). */
  protected cov: Float32Array | null = null;
  protected covW = 0;
  /** Area whose coverage changed since the pixels were last updated (surface coordinates). */
  protected dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  protected start(_e?: PEvent) {
    this.dirty = null;
    if (this.gpu) return;   // the coverage is a texture on the video card
    const s = this.target!.surface;
    this.covW = s.w;
    this.cov = new Float32Array(s.w * s.h);
  }

  /** Color Replacement: the sample (surface pixel) and tolerance its dabs keep to on the video card. */
  protected gpuReplace(): { sample: [number, number] | null; tol: number } | undefined { return undefined; }

  /** On the video card a pointer move only marks its area; flush() draws it. True when the GPU has the stroke. */
  protected gpuEndMove(): boolean {
    if (!this.gpu) return false;
    const dr = this.dirty;
    if (dr && this.target) {
      this.dirty = null;
      this.changed({ x: dr.x0, y: dr.y0, w: dr.x1 - dr.x0, h: dr.y1 - dr.y0 });
    }
    return true;
  }

  /**
   * Like Photoshop, one stroke changes a pixel by at most the exposure: overlapping dabs only extend the
   * stroke's coverage, and the result is always computed from the pixels as they were before the stroke.
   * So a dab only updates the coverage; the pixels of all dabs of a pointer move are computed once.
   */
  protected dab(x: number, y: number) {
    if (this.gpu) {
      const a = this.dabArea(x, y, 0);
      if (!a) return;
      this.gpu.covDab(a.lx, a.ly, a.r, this.o.hardness / 100, this.o.strength / 100, a.x0, a.y0, a.x1, a.y1, this.gpuReplace());
      const dr = this.dirty;
      this.dirty = dr ? { x0: Math.min(dr.x0, a.x0), y0: Math.min(dr.y0, a.y0), x1: Math.max(dr.x1, a.x1), y1: Math.max(dr.y1, a.y1) } : { x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 };
      return;
    }
    const s = this.target!.surface;
    const d = app.doc!;
    const r = this.o.size / 2, ir = 1 / r;
    const lx = x - s.x, ly = y - s.y;
    const x0 = Math.max(0, Math.floor(lx - r)), y0 = Math.max(0, Math.floor(ly - r));
    const x1 = Math.min(s.w, Math.ceil(lx + r)), y1 = Math.min(s.h, Math.ceil(ly + r));
    if (x1 <= x0 || y1 <= y0) return;
    const hard = this.o.hardness / 100, str = this.o.strength / 100;
    const cov = this.cov!, CW = this.covW, sel = this.sel;
    this.beginDab(x0, y0, x1, y1);
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
        wt = this.dabWeight(px, py, wt);
        const ci = py * CW + px;
        if (wt > cov[ci]) cov[ci] = wt;
      }
    }
    const dr = this.dirty;
    this.dirty = dr ? { x0: Math.min(dr.x0, x0), y0: Math.min(dr.y0, y0), x1: Math.max(dr.x1, x1), y1: Math.max(dr.y1, y1) } : { x0, y0, x1, y1 };
  }

  protected endMove() {
    if (this.gpuEndMove()) return;
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

  /** Before a dab's coverage is computed (its area in surface coordinates). */
  protected beginDab(_x0: number, _y0: number, _x1: number, _y1: number) {}
  /** A dab's coverage at a pixel, before it joins the stroke's coverage (Color Replacement adds its tolerance). */
  protected dabWeight(_px: number, _py: number, wt: number) { return wt; }

  /** One pixel: `orig` as before the stroke, `d` gets the result, `c` the stroke's coverage there. */
  protected tone(_orig: Uint8ClampedArray, _d: Uint8ClampedArray, _p: number, _c: number) {}

  protected op() { /* pixels are computed per pointer move in endMove() */ }
  up() { super.up(); this.cov = null; }
  cancel() { super.cancel(); this.cov = null; }
}

/* ---------- Dodge / Burn ---------- */
type Range = 'shadows' | 'midtones' | 'highlights';
interface DBOpts extends PixOpts { range: Range }

export class DodgeTool extends CoverageBrush<DBOpts> {
  readonly id: string = 'dodge';
  readonly iconName: string = 'dodge';
  readonly key: string = 'O';
  readonly label: string = 'tool.dodge';
  protected dir = 1;
  constructor(defaults?: any) { super(defaults ?? { size: 80, hardness: 0, strength: 50, range: 'midtones' }); }
  protected gpuKind(): RetouchKind | null { return 'tone'; }
  protected gpuParams(): PresentParams {
    return { kind: 'tone', dodge: this.dir > 0, range: this.o.range === 'shadows' ? 0 : this.o.range === 'highlights' ? 2 : 1 };
  }

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

/* ---------- Sharpen ---------- */
/** [1 4 6 4 1] in both directions (about a 1 px Gaussian); outside the area counts as zero. */
function blur5(src: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      let s = 6 * src[r + x];
      if (x > 0) s += 4 * src[r + x - 1];
      if (x > 1) s += src[r + x - 2];
      if (x < w - 1) s += 4 * src[r + x + 1];
      if (x < w - 2) s += src[r + x + 2];
      tmp[r + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      let s = 6 * tmp[r + x];
      if (y > 0) s += 4 * tmp[r + x - w];
      if (y > 1) s += tmp[r + x - 2 * w];
      if (y < h - 1) s += 4 * tmp[r + x + w];
      if (y < h - 2) s += tmp[r + x + 2 * w];
      out[r + x] = s;
    }
  }
  return out;
}

/**
 * Like Dodge/Burn, a stroke sharpens each pixel once, from the pixels as they were before the stroke, by at
 * most the strength: the dabs only extend the stroke's coverage. Each dab used to sharpen again what the dabs
 * before it had sharpened (about six times per stroke), so after two or three strokes noise and edges turned
 * into bright and dark specks. Only the brightness is sharpened (no colour fringes), the faintest grain is
 * left as it is, and a pixel goes at most a few levels past the darkest or brightest of its neighbours (no
 * halos or specks).
 */
export class SharpenTool extends CoverageBrush<PixOpts> {
  readonly id = 'sharpen';
  readonly iconName = 'sharpen';
  readonly key = 'R';
  readonly label = 'tool.sharpen';
  constructor() { super({ size: 60, hardness: 50, strength: 50 }); }
  protected gpuKind(): RetouchKind | null { return 'sharpen'; }

  protected endMove() {
    if (this.gpuEndMove()) return;
    const dr = this.dirty;
    if (!dr || !this.target) return;
    this.dirty = null;
    const s = this.target.surface, M = 2;
    const ex0 = Math.max(0, dr.x0 - M), ey0 = Math.max(0, dr.y0 - M);
    const ew = Math.min(s.w, dr.x1 + M) - ex0, eh = Math.min(s.h, dr.y1 + M) - ey0, n = ew * eh;
    const orig = this.backup!.getContext('2d')!.getImageData(ex0, ey0, ew, eh).data;
    // brightness before the stroke; its blur is weighted by opacity, so transparent pixels do not darken edges
    const L = new Float32Array(n), A = new Float32Array(n), LA = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      L[i] = 0.299 * orig[p] + 0.587 * orig[p + 1] + 0.114 * orig[p + 2];
      A[i] = orig[p + 3];
      LA[i] = L[i] * A[i];
    }
    const bLA = blur5(LA, ew, eh), bA = blur5(A, ew, eh);
    const w = dr.x1 - dr.x0, h = dr.y1 - dr.y0;
    const img = this.work!.getImageData(dr.x0, dr.y0, w, h);
    const d = img.data, cov = this.cov!, CW = this.covW;
    const AMOUNT = 3, GRAIN = 3, OVER = 3;
    for (let j = 0; j < h; j++) {
      const ey = dr.y0 + j - ey0, row = (dr.y0 + j) * CW + dr.x0;
      for (let i = 0; i < w; i++) {
        const c = cov[row + i];
        if (!c) continue;
        const ex = dr.x0 + i - ex0, e = ey * ew + ex;
        if (!A[e]) continue;
        const y = L[e];
        let detail = y - bLA[e] / bA[e];
        detail = detail > GRAIN ? detail - GRAIN : detail < -GRAIN ? detail + GRAIN : 0;
        if (!detail) continue;
        let lo = 255, hi = 0;
        for (let yy = Math.max(0, ey - 1); yy <= Math.min(eh - 1, ey + 1); yy++) {
          for (let xx = Math.max(0, ex - 1); xx <= Math.min(ew - 1, ex + 1); xx++) {
            const q = yy * ew + xx;
            if (!A[q]) continue;
            if (L[q] < lo) lo = L[q];
            if (L[q] > hi) hi = L[q];
          }
        }
        // a little past the neighbours (crisper), never far (halos, specks)
        const over = Math.min(OVER, (hi - lo) * 0.1);
        const y2 = Math.min(hi + over, Math.max(lo - over, y + detail * AMOUNT));
        const delta = (y2 - y) * c, p = e * 4, q = (j * w + i) * 4;
        d[q] = orig[p] + delta; d[q + 1] = orig[p + 1] + delta; d[q + 2] = orig[p + 2] + delta;
      }
    }
    this.work!.putImageData(img, dr.x0, dr.y0);
    this.changed({ x: dr.x0, y: dr.y0, w, h });
  }

  options() { return [...this.baseOptions(), sep(), numberField({ label: t('opt.strength'), value: this.o.strength, min: 1, max: 100, unit: '%', onChange: v => this.set('strength', v) })]; }
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
  /** Where the sample was taken (surface pixel): the video card reads the colour there. */
  private samplePos: [number, number] | null = null;
  private toneArgs = { tol: 0, fh: 0, fs: 0 };
  constructor() { super({ size: 40, hardness: 60, strength: 100, tolerance: 30, sampling: 'continuous', range: 'midtones' }); }
  protected start(e?: PEvent) { super.start(); this.sample = null; this.samplePos = null; if (e) this.takeSample(e.x, e.y); }
  /** The colour to replace, from the picture before the stroke; off the layer the last sample stays. */
  private takeSample(x: number, y: number) {
    const s = this.target!.surface;
    const lx = Math.floor(x - s.x), ly = Math.floor(y - s.y);
    if (lx < 0 || ly < 0 || lx >= s.w || ly >= s.h) return;
    this.samplePos = [lx, ly];
    if (this.gpu) return;
    const p = this.backup!.getContext('2d')!.getImageData(lx, ly, 1, 1).data;
    this.sample = [p[0], p[1], p[2]];
  }
  protected dab(x: number, y: number) {
    if ((this.o as any).sampling === 'continuous') this.takeSample(x, y);
    super.dab(x, y);
  }
  protected gpuKind(): RetouchKind | null { return 'replace'; }
  protected gpuParams(): PresentParams {
    const [fgH, fgS] = rgbToHsl(app.fg.r / 255, app.fg.g / 255, app.fg.b / 255);
    return { kind: 'replace', fgH, fgS };
  }
  protected gpuReplace() { return { sample: this.samplePos, tol: (this.o as any).tolerance * 2.55 }; }
  /**
   * The tolerance is decided per dab, with the sample under that dab, and kept in the stroke's coverage:
   * deciding it per pointer move with the latest sample undid pixels recoloured under an earlier sample.
   */
  private dabOrig: { x0: number; y0: number; w: number; data: Uint8ClampedArray } | null = null;
  protected beginDab(x0: number, y0: number, x1: number, y1: number) {
    this.dabOrig = { x0, y0, w: x1 - x0, data: this.backup!.getContext('2d')!.getImageData(x0, y0, x1 - x0, y1 - y0).data };
  }
  protected dabWeight(px: number, py: number, wt: number) {
    const smp = this.sample, o = this.dabOrig;
    if (!smp || !o || wt <= 0) return 0;
    const i = ((py - o.y0) * o.w + (px - o.x0)) * 4, a = o.data;
    if (!a[i + 3]) return 0;
    const tol = (this.o as any).tolerance * 2.55;
    const diff = Math.max(Math.abs(a[i] - smp[0]), Math.abs(a[i + 1] - smp[1]), Math.abs(a[i + 2] - smp[2]));
    if (diff > tol) return 0;
    return wt * (tol > 0 ? Math.min(1, (tol - diff) / (tol * 0.35 + 1)) : 1);
  }
  protected prepareTone() {
    const [fh, fs] = rgbToHsl(app.fg.r / 255, app.fg.g / 255, app.fg.b / 255);
    this.toneArgs = { tol: 0, fh, fs };
  }
  protected tone(orig: Uint8ClampedArray, d: Uint8ClampedArray, p: number, c: number) {
    if (!orig[p + 3]) return;
    const { fh, fs } = this.toneArgs;
    const k = c;
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
    if (e.alt) {
      this.source = { x: e.x, y: e.y }; this.offset = null;
      toast(t('stamp.sourceSet'), 'info', 1200);
      // with the source marker hidden, a short cross at the sampled point still shows that it was taken
      this.flashUntil = performance.now() + 700;
      setTimeout(() => app.update('overlay'), 720);
      app.update('overlay');
      return;
    }
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

  private flashUntil = 0;

  overlay(g: CanvasRenderingContext2D) {
    // the source marker can be hidden to see the picture under it better; just after Alt+click a cross
    // still flashes at the sampled point
    if (this.o.showSource === false) {
      if (this.source && performance.now() < this.flashUntil) {
        const v = app.viewport, p = v.toScreen(this.source.x, this.source.y);
        g.save();
        g.beginPath(); g.moveTo(p.x - 8, p.y); g.lineTo(p.x + 8, p.y); g.moveTo(p.x, p.y - 8); g.lineTo(p.x, p.y + 8);
        g.strokeStyle = 'rgba(0,0,0,.65)'; g.lineWidth = 3; g.stroke();
        g.strokeStyle = '#fff'; g.lineWidth = 1.2; g.stroke();
        g.restore();
      }
      return;
    }
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
      numberField({ label: t('opt.size'), value: this.o.size, min: 1, max: MAX_BRUSH_SIZE, unit: 'px', log: true, onChange: v => { this.set('size', v); app.update('overlay'); } }),
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
