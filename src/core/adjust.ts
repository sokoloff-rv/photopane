import { app, PaintTarget } from '../app';
import { createCanvas, ctx2d, readPixels } from './util';
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
  /** Last CPU result, so moving the before/after line does not recompute it. */
  private full: Uint8ClampedArray | null = null;
  private fullFn: unknown = null;
  private out: ImageData | null = null;

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
    this.orig = readPixels(s.canvas, 0, 0, s.w, s.h);
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
    this.full = null; this.out = null;
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
 * Automatic settings for the Adjust sliders, like Auto in Camera Raw: tone only (white balance, hue and the
 * detail sliders stay as they are), predictable rather than dramatic. Each value is found by running this
 * very Adjust on a reduced copy and measuring the result, step by step, so the sliders account for each
 * other instead of stacking up:
 *  1. Brightness: the median brightness moves half of the way to mid-grey, within limits (a dark scene
 *     stays dark, a bright one bright).
 *  2. Highlights / Shadows: recover them when many pixels crowd near white or black.
 *  3. Whites / Blacks: the brightest and darkest few pixels move most of the way to white and black.
 *  4. Contrast, with the range set: half of the way to the spread of a typical photo, without clipping.
 *  5. Midtones back on target, some Vibrance for flat colours.
 */
export function autoEnhanceParams(src: Uint8ClampedArray, w: number, h: number, sel: Uint8Array | null, current: EnhanceParams = ENHANCE_DEFAULTS): Partial<EnhanceParams> {
  // reduced copy (~100k px) of single sampled pixels: averaging blocks would shrink the histogram tails and
  // push Whites/Blacks too far; pixels outside the selection or mostly transparent are not measured
  const f = Math.max(1, Math.sqrt((w * h) / 100000));
  const pw = Math.max(1, Math.floor(w / f)), ph = Math.max(1, Math.floor(h / f));
  const proxy = new Uint8ClampedArray(pw * ph * 4);
  const mask = new Uint8Array(pw * ph);
  let used = 0;
  for (let py = 0; py < ph; py++) {
    const y = Math.min(h - 1, Math.floor((py + 0.5) * h / ph));
    for (let px = 0; px < pw; px++) {
      const x = Math.min(w - 1, Math.floor((px + 0.5) * w / pw));
      const i = (y * w + x) * 4, o = (py * pw + px) * 4;
      proxy[o] = src[i]; proxy[o + 1] = src[i + 1]; proxy[o + 2] = src[i + 2]; proxy[o + 3] = 255;
      if (src[i + 3] >= 128 && (!sel || sel[y * w + x] >= 128)) { mask[py * pw + px] = 1; used++; }
    }
  }
  if (used < 16) return {};

  const out = new Uint8ClampedArray(proxy.length);
  const cache = new DetailCache();
  const hist = new Uint32Array(256);
  // tone-only simulation: the colour settings stay, detail and vignette do not change the measurements
  const base: EnhanceParams = { ...current, brightness: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, vibrance: 0, sharpness: 0, clarity: 0, grain: 0, vignette: 0 };
  const stats = (p: EnhanceParams) => {
    enhance(p, { w: pw, h: ph, ox: 0, oy: 0 }, cache, proxy, out);
    hist.fill(0);
    let n = 0, sum = 0, sq = 0, satSum = 0, satN = 0;
    for (let i = 0, q = 0; q < mask.length; i += 4, q++) {
      if (!mask[q]) continue;
      const r = out[i], g = out[i + 1], b = out[i + 2];
      const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      hist[Math.round(L * 255)]++;
      sum += L; sq += L * L; n++;
      if (L > 0.1 && L < 0.95) { const mx = Math.max(r, g, b); satSum += mx ? (mx - Math.min(r, g, b)) / mx : 0; satN++; }
    }
    const mean = sum / n;
    const pct = (qq: number) => { let acc = 0; const lim = qq * n; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= lim) return i / 255; } return 1; };
    const frac = (a: number, b: number) => { let c = 0; for (let i = Math.round(a * 255); i <= Math.round(b * 255); i++) c += hist[i]; return c / n; };
    return { med: pct(0.5), lo: pct(0.003), hi: pct(0.997), sd: Math.sqrt(Math.max(0, sq / n - mean * mean)), frac, sat: satN ? satSum / satN : 0 };
  };
  /** Value of `key` in [lo, hi] at which the measurement (increasing with it) reaches `target`. */
  const solve = (p: EnhanceParams, key: keyof EnhanceParams, lo: number, hi: number, target: number, measure: (s: ReturnType<typeof stats>) => number) => {
    let a = lo, b = hi;
    for (let it = 0; it < 9; it++) {
      const m = (a + b) / 2;
      (p as any)[key] = m;
      if (measure(stats(p)) < target) a = m; else b = m;
    }
    (p as any)[key] = Math.round((a + b) / 2);
  };

  const p = { ...base };
  const s0 = stats(p);
  // 1. brightness: half of the way to mid-grey, by at most −0.12…+0.15 (high-key and low-key pictures stay so)
  const medTarget = s0.med + Math.max(-0.12, Math.min(0.15, (0.46 - s0.med) * 0.5));
  solve(p, 'brightness', -70, 70, medTarget, s => s.med);
  // 2. recovery of crowded ends (after the exposure moved them)
  const s1 = stats(p);
  p.highlights = -Math.round(Math.min(50, Math.max(0, (s1.frac(0.92, 1) - 0.02) * 400)));
  p.shadows = Math.round(Math.min(40, Math.max(0, (s1.frac(0, 0.08) - 0.02) * 300)));
  // 3. white and black points: the extremes move most of the way to white and black
  const s2 = stats(p);
  solve(p, 'whites', -30, 70, s2.hi >= 0.97 ? 0.97 : s2.hi + (0.97 - s2.hi) * 0.6, s => s.hi);
  const s3 = stats(p);
  solve(p, 'blacks', -70, 20, s3.lo <= 0.03 ? 0.03 : s3.lo - (s3.lo - 0.03) * 0.6, s => s.lo);
  // 4. contrast with the range set: half of the way to the spread of a typical photo, but never so much
  //    that it clips (this contrast stretches linearly around the middle and would push the ends out)
  const s4 = stats(p);
  solve(p, 'contrast', -15, 30, s4.sd + (0.21 - s4.sd) * 0.5, s => s.sd);
  const clean = () => { const st = stats(p); return st.hi <= 0.985 && st.lo >= 0.015; };
  if (p.contrast > 0 && !clean()) {
    let lo = 0, hi = p.contrast;
    for (let it = 0; it < 8; it++) { const m = (lo + hi) / 2; p.contrast = m; if (clean()) lo = m; else hi = m; }
    p.contrast = Math.round(lo);
  }
  // 5. midtones back on target, vibrance for flat colours
  if (Math.abs(stats(p).med - medTarget) > 0.02) solve(p, 'brightness', -70, 70, medTarget, s => s.med);
  p.vibrance = Math.round(Math.min(25, Math.max(0, (0.32 - stats(p).sat) * 100)));
  return { brightness: p.brightness, contrast: p.contrast, highlights: p.highlights, shadows: p.shadows, whites: p.whites, blacks: p.blacks, vibrance: p.vibrance };
}

/** Blurred copies of an input used by sharpness/clarity, kept while the same input comes back. */
export class DetailCache {
  private small: { src: Uint8ClampedArray; data: Uint8ClampedArray } | null = null;
  private large: { src: Uint8ClampedArray; data: Uint8ClampedArray } | null = null;
  getSmall(src: Uint8ClampedArray, w: number, h: number) {
    if (this.small?.src !== src) this.small = { src, data: gaussianBlur(src, w, h, 1.2) };
    return this.small.data;
  }
  getLarge(src: Uint8ClampedArray, w: number, h: number) {
    if (this.large?.src !== src) this.large = { src, data: gaussianBlur(src, w, h, Math.max(8, Math.min(60, Math.max(w, h) / 60))) };
    return this.large.data;
  }
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

/** `s`: size and layer offset of the pixels; k < 1 for a reduced draft (the vignette scales with it). */
export function enhance(p: EnhanceParams, s: { w: number; h: number; ox: number; oy: number; k?: number; docW?: number; docH?: number }, cache: DetailCache, src: Uint8ClampedArray, dst: Uint8ClampedArray) {
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
  const small = sharp ? cache.getSmall(src, s.w, s.h) : null;
  const large = clar ? cache.getLarge(src, s.w, s.h) : null;
  const doc = app.doc;
  const k = s.k ?? 1;
  // the vignette is centred on the document (or on the image itself when there is none, e.g. batch processing)
  const vig = p.vignette ? vignetteFn((s.docW ?? doc?.width ?? s.w) * k, (s.docH ?? doc?.height ?? s.h) * k, p.vigMidpoint, p.vigRoundness, p.vigFeather) : null;
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
      // vibrance leaves skin mostly alone (like Lightroom), so portraits do not turn orange
      let v = vib;
      if (v) { const [hh, ss, ll] = rgbToHsl(Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, b))); v *= 1 - 0.8 * skinWeight(hh * 360, ss, ll); }
      const k = sat * (1 + v * (1 - Math.min(1, cur * 1.5)));
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

export { identityLUT };
