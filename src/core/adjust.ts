import { app, PaintTarget } from '../app';
import { createCanvas, ctx2d } from './util';
import { rgbToHsl, hslToRgb } from './color';
import { t } from '../i18n';
import { toast } from '../ui/dialog';
import { levelsLUT, histogram, clipPoints, identityLUT, gaussianBlur, smoothstep } from './filters';

/**
 * Live, destructive adjustment of the active pixel layer with preview.
 * The original pixels are kept so the preview can be recomputed and cancelled.
 */
export class AdjustSession {
  target: PaintTarget;
  w: number; h: number;
  orig: ImageData;
  sel: Uint8Array | null = null;
  /** document coordinates of the surface origin */
  ox: number; oy: number;
  private pending: (() => void) | null = null;
  private raf = 0;
  done = false;
  /** Before/after line (document x) for the preview: the original is shown left of it. */
  split: number | null = null;
  /**
   * Optional GPU renderer: returns a canvas with the finished layer (selection and split applied,
   * premultiplied), or null to fall back to the CPU function.
   */
  gpu: ((final: boolean) => HTMLCanvasElement | null) | null = null;
  /** Called once when the session ends (frees GPU resources). */
  onEnd: (() => void) | null = null;
  /** Last CPU result, so moving the before/after line does not recompute it. */
  private full: Uint8ClampedArray | null = null;
  private fullFn: unknown = null;
  private out: ImageData | null = null;
  /** Canvas copies of the original and the selection, for drawing drafts on the GPU. */
  private origCanvas: HTMLCanvasElement | null = null;
  private selCanvas: HTMLCanvasElement | null = null;

  static start(): AdjustSession | null {
    const target = app.paintTarget();
    if (!target) return null;
    if (target.isMask) { toast(t('app.layerLocked')); return null; }
    return new AdjustSession(target);
  }

  private constructor(target: PaintTarget) {
    const d = app.doc!;
    this.target = target;
    const s = target.surface;
    this.w = s.w; this.h = s.h; this.ox = s.x; this.oy = s.y;
    this.orig = s.ctx.getImageData(0, 0, s.w, s.h);
    if (d.selection) {
      const c = createCanvas(s.w, s.h);
      ctx2d(c).drawImage(d.selection.mask, -s.x, -s.y);
      const a = ctx2d(c).getImageData(0, 0, s.w, s.h).data;
      this.sel = new Uint8Array(s.w * s.h);
      for (let i = 0; i < this.sel.length; i++) this.sel[i] = a[i * 4 + 3];
    }
  }

  /** Compute dst from src (same size RGBA) and show it. Throttled to one per frame. */
  preview(fn: (src: Uint8ClampedArray, dst: Uint8ClampedArray) => void) {
    this.pending = () => this.apply(fn);
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; const p = this.pending; this.pending = null; p?.(); });
  }

  apply(fn: (src: Uint8ClampedArray, dst: Uint8ClampedArray) => void, final = false) {
    if (this.gpu) {
      const c = this.gpu(final);
      if (c) {
        const g = this.target.surface.ctx;
        g.save(); g.globalCompositeOperation = 'copy'; g.drawImage(c, 0, 0); g.restore();
        this.target.layer.touch();
        app.update('canvas');
        return;
      }
      this.gpu = null;   // GPU lost: continue on the CPU
    }
    const src = this.orig.data;
    // the same function again (only the before/after line moved): reuse its result
    if (!this.full || this.fullFn !== fn) {
      this.full = new Uint8ClampedArray(src.length);
      fn(src, this.full);
      this.fullFn = fn;
    }
    const out = (this.out ??= new ImageData(this.w, this.h));
    const dst = out.data;
    dst.set(this.full);
    if (!final && this.split != null) {
      const cut = Math.max(0, Math.min(this.w, Math.round(this.split - this.ox)));
      for (let y = 0; y < this.h; y++) { const r = y * this.w * 4; dst.set(src.subarray(r, r + cut * 4), r); }
    }
    // keep alpha unless the function changed it; blend with selection
    if (this.sel) {
      const s = this.sel;
      for (let i = 0, p = 0; i < dst.length; i += 4, p++) {
        const a = s[p];
        if (a === 255) continue;
        if (a === 0) { dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; dst[i + 3] = src[i + 3]; continue; }
        const k = a / 255;
        dst[i] = src[i] + (dst[i] - src[i]) * k; dst[i + 1] = src[i + 1] + (dst[i + 1] - src[i + 1]) * k;
        dst[i + 2] = src[i + 2] + (dst[i + 2] - src[i + 2]) * k; dst[i + 3] = src[i + 3] + (dst[i + 3] - src[i + 3]) * k;
      }
    }
    this.target.surface.ctx.putImageData(out, 0, 0);
    this.target.layer.touch();
    app.update('canvas');
  }

  private end() {
    this.done = true;
    this.full = null; this.out = null; this.origCanvas = null; this.selCanvas = null;
    this.onEnd?.(); this.onEnd = null;
    this.gpu = null;
  }

  /**
   * Show a reduced-size result scaled up to the layer (fast preview while the settings of a heavy filter
   * change; the full result follows). Selection and the before/after line are applied with canvas compositing.
   */
  previewDraft(make: () => HTMLCanvasElement | null) {
    this.pending = () => { const c = make(); if (c) this.drawDraft(c); };
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; const p = this.pending; this.pending = null; p?.(); });
  }

  private drawDraft(c: HTMLCanvasElement) {
    const g = this.target.surface.ctx;
    const { w, h } = this;
    if (!this.origCanvas) { this.origCanvas = createCanvas(w, h); ctx2d(this.origCanvas).putImageData(this.orig, 0, 0); }
    g.save();
    g.globalCompositeOperation = 'copy';
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(c, 0, 0, w, h);
    if (this.sel) {
      if (!this.selCanvas) {
        this.selCanvas = createCanvas(w, h);
        const m = new ImageData(w, h);
        for (let i = 0; i < this.sel.length; i++) m.data[i * 4 + 3] = this.sel[i];
        ctx2d(this.selCanvas).putImageData(m, 0, 0);
      }
      // result inside the selection, original outside: draft·k + orig·(1−k)
      g.globalCompositeOperation = 'destination-in'; g.drawImage(this.selCanvas, 0, 0);
      const outside = createCanvas(w, h), og = ctx2d(outside);
      og.drawImage(this.origCanvas, 0, 0);
      og.globalCompositeOperation = 'destination-out'; og.drawImage(this.selCanvas, 0, 0);
      g.globalCompositeOperation = 'lighter'; g.drawImage(outside, 0, 0);
    }
    if (this.split != null) {
      const cut = Math.max(0, Math.min(w, Math.round(this.split - this.ox)));
      if (cut > 0) { g.globalCompositeOperation = 'copy'; g.beginPath(); g.rect(0, 0, cut, h); g.clip(); g.drawImage(this.origCanvas, 0, 0); }
    }
    g.restore();
    this.target.layer.touch();
    app.update('canvas');
  }

  restore() {
    this.target.surface.ctx.putImageData(this.orig, 0, 0);
    this.target.layer.touch();
    app.update('canvas');
  }

  commit(label: string, fn?: (src: Uint8ClampedArray, dst: Uint8ClampedArray) => void) {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    this.split = null;
    if (fn) this.apply(fn, true); else if (this.pending) { this.pending(); this.pending = null; }
    this.end();
    this.target.surface.markDirty();
    app.commit(label);
  }

  cancel() {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    this.pending = null;
    this.end();
    this.restore();
  }
}

/** Run a one-shot adjustment (no dialog). */
export function instantAdjust(label: string, fn: (src: Uint8ClampedArray, dst: Uint8ClampedArray, s: AdjustSession) => void) {
  const s = AdjustSession.start();
  if (!s) return;
  s.commit(label, (a, b) => fn(a, b, s));
}

/** Apply per-channel LUTs. */
export function applyLUTs(src: Uint8ClampedArray, dst: Uint8ClampedArray, r: Uint8ClampedArray, g: Uint8ClampedArray = r, b: Uint8ClampedArray = r) {
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = r[src[i]]; dst[i + 1] = g[src[i + 1]]; dst[i + 2] = b[src[i + 2]]; dst[i + 3] = src[i + 3];
  }
}

/* ---------------- one-shot adjustments ---------------- */
export function invert(src: Uint8ClampedArray, dst: Uint8ClampedArray) {
  for (let i = 0; i < src.length; i += 4) { dst[i] = 255 - src[i]; dst[i + 1] = 255 - src[i + 1]; dst[i + 2] = 255 - src[i + 2]; dst[i + 3] = src[i + 3]; }
}

export function desaturate(src: Uint8ClampedArray, dst: Uint8ClampedArray) {
  for (let i = 0; i < src.length; i += 4) {
    // Photoshop's Desaturate uses lightness ((max+min)/2)
    const mx = Math.max(src[i], src[i + 1], src[i + 2]), mn = Math.min(src[i], src[i + 1], src[i + 2]);
    const v = (mx + mn) / 2;
    dst[i] = dst[i + 1] = dst[i + 2] = v; dst[i + 3] = src[i + 3];
  }
}

/** Auto Contrast: stretch all channels together. */
export function autoContrast(src: Uint8ClampedArray, dst: Uint8ClampedArray, sel: Uint8Array | null) {
  const h = histogram(src, sel);
  if (!h.total) { dst.set(src); return; }
  const lo = Math.min(clipPoints(h.r, h.total, 0.001)[0], clipPoints(h.g, h.total, 0.001)[0], clipPoints(h.b, h.total, 0.001)[0]);
  const hi = Math.max(clipPoints(h.r, h.total, 0.001)[1], clipPoints(h.g, h.total, 0.001)[1], clipPoints(h.b, h.total, 0.001)[1]);
  applyLUTs(src, dst, levelsLUT(lo, hi, 1));
}

/** Auto Tone: stretch each channel separately. */
export function autoTone(src: Uint8ClampedArray, dst: Uint8ClampedArray, sel: Uint8Array | null) {
  const h = histogram(src, sel);
  if (!h.total) { dst.set(src); return; }
  const [rl, rh] = clipPoints(h.r, h.total, 0.001), [gl, gh] = clipPoints(h.g, h.total, 0.001), [bl, bh] = clipPoints(h.b, h.total, 0.001);
  applyLUTs(src, dst, levelsLUT(rl, rh, 1), levelsLUT(gl, gh, 1), levelsLUT(bl, bh, 1));
}

/** Auto Color: per-channel stretch plus neutralizing the midtones. */
export function autoColor(src: Uint8ClampedArray, dst: Uint8ClampedArray, sel: Uint8Array | null) {
  const h = histogram(src, sel);
  if (!h.total) { dst.set(src); return; }
  const ch = [h.r, h.g, h.b].map(x => clipPoints(x, h.total, 0.005));
  const luts = ch.map(([lo, hi]) => levelsLUT(lo, hi, 1));
  // mean of each stretched channel over midtone pixels
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0, p = 0; i < src.length; i += 16, p += 4) {
    if (src[i + 3] < 8 || (sel && sel[p] < 128)) continue;
    const r = luts[0][src[i]], g = luts[1][src[i + 1]], b = luts[2][src[i + 2]];
    const l = (r + g + b) / 3;
    if (l < 40 || l > 215) continue;
    sum[0] += r; sum[1] += g; sum[2] += b; n++;
  }
  if (n) {
    const mean = sum.map(s => s / n / 255);
    const target = (mean[0] + mean[1] + mean[2]) / 3;
    for (let c = 0; c < 3; c++) {
      const gamma = Math.log(mean[c]) / Math.log(target || 0.5);
      const fixed = luts[c].map(v => 255 * Math.pow(v / 255, Math.max(0.5, Math.min(2, gamma))));
      luts[c] = Uint8ClampedArray.from(fixed);
    }
  }
  applyLUTs(src, dst, luts[0], luts[1], luts[2]);
}

/* ---------------- Enhance (Google Photos-like) ---------------- */
/** How much a colour looks like skin (0..1): warm hues 0–50°, moderate saturation, not too dark or bright. */
function skinWeight(hDeg: number, s: number, l: number): number {
  const d = Math.abs(((hDeg - 25 + 540) % 360) - 180);              // distance from the skin hue centre
  const hw = d < 11 ? 1 : d < 23 ? 1 - (d - 11) / 12 : 0;            // pure red (0°) and yellow (55°+) stay out
  if (!hw) return 0;
  const sw = s < 0.08 ? 0 : s < 0.18 ? (s - 0.08) / 0.1 : s < 0.6 ? 1 : s < 0.8 ? (0.8 - s) / 0.2 : 0;
  const lw = l < 0.12 ? 0 : l < 0.25 ? (l - 0.12) / 0.13 : l < 0.85 ? 1 : l < 0.95 ? (0.95 - l) / 0.1 : 0;
  return hw * sw * lw;
}

/** Deterministic noise in −1..1 (roughly Gaussian) for a pixel, so the grain does not crawl between previews. */
function grainNoise(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  const a = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  h = Math.imul(h ^ 0x9e3779b9, 2246822519);
  const b = ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  return (a + b - 1) * 1.2;
}

export interface EnhanceParams {
  brightness: number; contrast: number; highlights: number; shadows: number; whites: number; blacks: number;
  saturation: number; vibrance: number; warmth: number; tint: number; skin: number; hue: number;
  sharpness: number; clarity: number; grain: number;
  vignette: number; vigMidpoint: number; vigRoundness: number; vigFeather: number;
}
export const ENHANCE_DEFAULTS: EnhanceParams = {
  brightness: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  saturation: 0, vibrance: 0, warmth: 0, tint: 0, skin: 0, hue: 0, sharpness: 0, clarity: 0, grain: 0,
  vignette: 0, vigMidpoint: 50, vigRoundness: 0, vigFeather: 50,
};

/**
 * Automatic settings for the Adjust sliders (like Camera Raw's Auto): exposure from the median,
 * white/black points from the histogram tails, contrast from the spread, highlight/shadow recovery
 * when the ends are crowded, a gentle grey-world white balance and some vibrance for flat colours.
 */
export function autoEnhanceParams(src: Uint8ClampedArray, sel: Uint8Array | null): Partial<EnhanceParams> {
  const hist = new Float64Array(256);
  let n = 0, sr = 0, sg = 0, sb = 0, mw = 0, satSum = 0;
  const step = Math.max(1, Math.floor(src.length / 4 / 400000)) * 4;   // sample up to ~400k pixels
  for (let i = 0, px = 0; i < src.length; i += step, px += step / 4) {
    if (src[i + 3] < 128 || (sel && sel[px] < 128)) continue;
    const r = src[i], g = src[i + 1], b = src[i + 2];
    const L = 0.299 * r + 0.587 * g + 0.114 * b;
    hist[Math.round(L)]++; n++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    satSum += mx ? (mx - mn) / mx : 0;
    // white balance from midtones that are not strongly coloured
    if (L > 40 && L < 220 && mx - mn < 90) { sr += r; sg += g; sb += b; mw++; }
  }
  if (!n) return {};
  const pct = (q: number) => { let acc = 0; const lim = q * n; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= lim) return i / 255; } return 1; };
  const lo = pct(0.005), hi = pct(0.995), med = pct(0.5);
  let mean = 0, sq = 0;
  for (let i = 0; i < 256; i++) { const v = i / 255; mean += v * hist[i]; sq += v * v * hist[i]; }
  mean /= n; const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
  const clamp = (v: number, a: number, b: number) => Math.round(Math.max(a, Math.min(b, v)));
  const p: Partial<EnhanceParams> = {};
  // white / black points (see enhance(): wp = 1 − whites·0.15, bp = −blacks·0.15)
  p.whites = clamp((1 - Math.max(hi, 0.6)) / 0.15 * 100 * 0.8, 0, 60);
  p.blacks = clamp(-Math.min(lo, 0.25) / 0.15 * 100 * 0.8, -60, 0);
  // exposure: bring the median towards the middle (gamma = 2^(−brightness/100))
  const m = Math.min(0.95, Math.max(0.05, med));
  const gamma = Math.log(0.46) / Math.log(m);
  p.brightness = clamp(-100 * Math.log2(gamma) * 0.7, -50, 50);
  // contrast from the spread
  p.contrast = clamp((0.2 / Math.max(0.05, sd) - 1) / 1.2 * 100 * 0.5, -25, 30);
  // recover crowded ends
  const fracHi = hist.slice(235).reduce((a, b) => a + b, 0) / n, fracLo = hist.slice(0, 25).reduce((a, b) => a + b, 0) / n;
  p.highlights = clamp(-fracHi * 300, -45, 0);
  p.shadows = clamp(fracLo * 250, 0, 40);
  // gentle grey-world white balance (half strength)
  if (mw > n * 0.05) {
    const ar = sr / mw, ag = sg / mw, ab = sb / mw;
    const qrb = ab / Math.max(1, ar), k = (qrb - 1) / (qrb + 1);
    p.warmth = clamp(k / 0.12 * 100 * 0.5, -30, 30);
    const tg = ((ar + ab) / 2) / Math.max(1, ag);
    p.tint = clamp((1 - tg) / 0.1 * 100 * 0.5, -25, 25);
  }
  // flat colours get some vibrance
  const sat = satSum / n;
  p.vibrance = clamp((0.35 - sat) * 80, 0, 25);
  return p;
}

/** Cache of blurred copies used by sharpness/clarity. */
export class DetailCache {
  small: Uint8ClampedArray | null = null;
  large: Uint8ClampedArray | null = null;
  constructor(private s: AdjustSession) {}
  getSmall() { return (this.small ??= gaussianBlur(this.s.orig.data, this.s.w, this.s.h, 1.2)); }
  getLarge() { return (this.large ??= gaussianBlur(this.s.orig.data, this.s.w, this.s.h, Math.max(8, Math.min(60, Math.max(this.s.w, this.s.h) / 60)))); }
}

/** Vignette factor table builder. Returns t(x,y) 0..1 (0 = center). */
export function vignetteFn(docW: number, docH: number, midpoint: number, roundness: number, feather: number) {
  const cx = docW / 2, cy = docH / 2;
  // roundness: -100 = follows the image aspect, 100 = circle
  const r = (roundness + 100) / 200;
  const ar = Math.sqrt(docW * docH) / 2;
  const rx = (docW / 2) * (1 - r) + ar * r, ry = (docH / 2) * (1 - r) + ar * r;
  const inner = 0.2 + (midpoint / 100) * 0.9;
  const width = 0.05 + (feather / 100) * 1.1;
  return (x: number, y: number) => {
    const dx = (x - cx) / rx, dy = (y - cy) / ry;
    return smoothstep(inner - width / 2, inner + width / 2, Math.sqrt(dx * dx + dy * dy) / 1.0);
  };
}

export function enhance(p: EnhanceParams, s: AdjustSession, cache: DetailCache, src: Uint8ClampedArray, dst: Uint8ClampedArray) {
  // per-channel tone LUT: brightness (gamma), contrast, whites/blacks
  const lut = new Float32Array(256);
  const gamma = Math.pow(2, -p.brightness / 100);
  const cf = p.contrast >= 0 ? 1 + (p.contrast / 100) * 1.2 : 1 + (p.contrast / 100) * 0.8;
  const bp = -(p.blacks / 100) * 0.15, wp = 1 - (p.whites / 100) * 0.15;
  for (let i = 0; i < 256; i++) {
    let v = Math.pow(i / 255, gamma);
    v = 0.5 + (v - 0.5) * cf;
    v = (v - bp) / (wp - bp);
    lut[i] = v;
  }
  const sh = p.shadows / 100 * 0.4, hl = p.highlights / 100 * 0.4;
  const sat = 1 + p.saturation / 100, vib = p.vibrance / 100 * 1.3;
  const wr = 1 + p.warmth / 100 * 0.12, wb = 1 - p.warmth / 100 * 0.12, tg = 1 - p.tint / 100 * 0.1;
  const sharp = p.sharpness / 100 * 1.6, clar = p.clarity / 100 * 0.7;
  // hue: shift around the colour wheel in HSL, as Photoshop's Hue (red +120° → pure green)
  const hshift = ((p.hue % 360) + 360) % 360 / 360;
  // skin tone (Google Photos-like): only skin-coloured pixels move, towards pink (−) or golden/tan (+)
  const skin = p.skin / 100;
  // grain: luminance noise, stable per document pixel, strongest in the midtones
  const grain = p.grain / 100 * 0.16;
  const small = sharp ? cache.getSmall() : null;
  const large = clar ? cache.getLarge() : null;
  const doc = app.doc!;
  const vig = p.vignette ? vignetteFn(doc.width, doc.height, p.vigMidpoint, p.vigRoundness, p.vigFeather) : null;
  const vamt = p.vignette / 100;
  const W = s.w;
  for (let i = 0, px = 0; i < src.length; i += 4, px++) {
    if (src[i + 3] === 0) { dst[i + 3] = 0; continue; }
    let r = lut[src[i]], g = lut[src[i + 1]], b = lut[src[i + 2]];
    if (sh || hl) {
      const L = Math.min(1, Math.max(0, 0.299 * r + 0.587 * g + 0.114 * b));
      const d = sh * (1 - L) * (1 - L) + hl * L * L;
      r += d; g += d; b += d;
    }
    if (wr !== 1 || tg !== 1) { r *= wr; b *= wb; g *= tg; }
    if (hshift) {
      const [h, sl, l] = rgbToHsl(Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, b)));
      [r, g, b] = hslToRgb((h + hshift) % 1, sl, l);
    }
    if (skin) {
      const [h, sl, l] = rgbToHsl(Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, b)));
      const w = skinWeight(h * 360, sl, l);
      if (w > 0) {
        // + : warmer / more golden and a little richer; − : pinker and a little paler
        const nh = (h + w * skin * (10 / 360) + 1) % 1;
        const ns = Math.min(1, Math.max(0, sl * (1 + w * skin * 0.12)));
        [r, g, b] = hslToRgb(nh, ns, l);
      }
    }
    if (sat !== 1 || vib) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      const cur = Math.max(r, g, b) - Math.min(r, g, b);
      const k = sat * (1 + vib * (1 - Math.min(1, cur * 1.5)));
      r = l + (r - l) * k; g = l + (g - l) * k; b = l + (b - l) * k;
    }
    if (small) { r += sharp * (src[i] - small[i]) / 255; g += sharp * (src[i + 1] - small[i + 1]) / 255; b += sharp * (src[i + 2] - small[i + 2]) / 255; }
    if (large) {
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const mw = 4 * L * (1 - L);
      r += clar * mw * (src[i] - large[i]) / 255; g += clar * mw * (src[i + 1] - large[i + 1]) / 255; b += clar * mw * (src[i + 2] - large[i + 2]) / 255;
    }
    if (vig) {
      const x = (px % W) + s.ox, y = Math.floor(px / W) + s.oy;
      const tt = vig(x, y) * Math.abs(vamt);
      if (vamt > 0) { const k = 1 - tt * 0.9; r *= k; g *= k; b *= k; }
      else { r += (1 - r) * tt * 0.9; g += (1 - g) * tt * 0.9; b += (1 - b) * tt * 0.9; }
    }
    if (grain) {
      const x = (px % W) + s.ox, y = Math.floor(px / W) + s.oy;
      const L = Math.min(1, Math.max(0, 0.299 * r + 0.587 * g + 0.114 * b));
      const nz = grainNoise(x, y) * grain * (0.45 + 2.2 * L * (1 - L));
      r += nz; g += nz; b += nz;
    }
    dst[i] = r * 255; dst[i + 1] = g * 255; dst[i + 2] = b * 255; dst[i + 3] = src[i + 3];
  }
}

/* ---------------- Filters ---------------- */
export function unsharp(src: Uint8ClampedArray, dst: Uint8ClampedArray, blurred: Uint8ClampedArray, amount: number, threshold: number) {
  const k = amount / 100;
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = src[i + c] - blurred[i + c];
      dst[i + c] = Math.abs(d) * 2 < threshold ? src[i + c] : src[i + c] + d * k;
    }
    dst[i + 3] = src[i + 3];
  }
}

export function addNoise(src: Uint8ClampedArray, dst: Uint8ClampedArray, amount: number, gaussian: boolean, mono: boolean, seed = 1) {
  let x = seed * 2654435761 >>> 0;
  const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) / 4294967296); };
  const gauss = () => { let s = 0; for (let k = 0; k < 4; k++) s += rnd(); return (s - 2) * 1.73; };
  const amp = amount / 100 * 255 * (gaussian ? 0.5 : 1);
  for (let i = 0; i < src.length; i += 4) {
    if (mono) { const n = (gaussian ? gauss() : rnd() * 2 - 1) * amp; dst[i] = src[i] + n; dst[i + 1] = src[i + 1] + n; dst[i + 2] = src[i + 2] + n; }
    else for (let c = 0; c < 3; c++) dst[i + c] = src[i + c] + (gaussian ? gauss() : rnd() * 2 - 1) * amp;
    dst[i + 3] = src[i + 3];
  }
}

export { identityLUT };
