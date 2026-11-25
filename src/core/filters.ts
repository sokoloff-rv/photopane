/* Pixel-level helpers: blur, histograms, lookup tables, curves. */

/** Box sizes that approximate a gaussian of sigma with n passes. */
export function boxesForGauss(sigma: number, n = 3): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

/*
 * Box passes with clamped edges. Both run along rows in memory order: the vertical pass keeps one running
 * sum per column instead of walking down columns, which on a wide photo missed the cache on every pixel.
 */
function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const iarr = 1 / (r + r + 1);
  const last = w - 1;
  for (let y = 0; y < h; y++) {
    const o = y * w * 4;
    let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
    for (let j = -r; j <= r; j++) {
      const k = o + (j < 0 ? 0 : j > last ? last : j) * 4;
      a0 += src[k]; a1 += src[k + 1]; a2 += src[k + 2]; a3 += src[k + 3];
    }
    for (let x = 0; x < w; x++) {
      const d = o + x * 4;
      dst[d] = a0 * iarr; dst[d + 1] = a1 * iarr; dst[d + 2] = a2 * iarr; dst[d + 3] = a3 * iarr;
      const xa = x + r + 1, xb = x - r;
      const ka = o + (xa > last ? last : xa) * 4, kb = o + (xb < 0 ? 0 : xb) * 4;
      a0 += src[ka] - src[kb]; a1 += src[ka + 1] - src[kb + 1]; a2 += src[ka + 2] - src[kb + 2]; a3 += src[ka + 3] - src[kb + 3];
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const iarr = 1 / (r + r + 1);
  const W4 = w * 4, last = h - 1;
  const acc = new Float64Array(W4);
  for (let j = -r; j <= r; j++) {
    const o = (j < 0 ? 0 : j > last ? last : j) * W4;
    for (let k = 0; k < W4; k++) acc[k] += src[o + k];
  }
  for (let y = 0; y < h; y++) {
    const o = y * W4;
    for (let k = 0; k < W4; k++) dst[o + k] = acc[k] * iarr;
    const ya = y + r + 1, yb = y - r;
    const oa = (ya > last ? last : ya) * W4, ob = (yb < 0 ? 0 : yb) * W4;
    for (let k = 0; k < W4; k++) acc[k] += src[oa + k] - src[ob + k];
  }
}

/** Gaussian blur of RGBA data (premultiplied internally so transparent edges don't darken). */
export function gaussianBlur(data: Uint8ClampedArray, w: number, h: number, sigma: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  if (sigma < 0.3) { out.set(data); return out; }
  let a = new Float32Array(data.length), b = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const al = data[i + 3] / 255;
    a[i] = data[i] * al; a[i + 1] = data[i + 1] * al; a[i + 2] = data[i + 2] * al; a[i + 3] = data[i + 3];
  }
  for (const size of boxesForGauss(sigma, 3)) {
    const r = Math.min((size - 1) / 2, Math.floor((Math.min(w, h) - 1) / 2));
    if (r < 1) continue;
    boxH(a, b, w, h, r);
    boxV(b, a, w, h, r);
  }
  for (let i = 0; i < data.length; i += 4) {
    const al = a[i + 3];
    if (al <= 0.01) { out[i + 3] = 0; continue; }
    const k = 255 / al;
    out[i] = a[i] * k; out[i + 1] = a[i + 1] * k; out[i + 2] = a[i + 2] * k; out[i + 3] = al;
  }
  return out;
}

export interface Histogram { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array; total: number }

export function histogram(data: Uint8ClampedArray, mask?: Uint8Array | null): Histogram {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  let total = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] < 8) continue;
    if (mask && mask[p] < 128) continue;
    r[data[i]]++; g[data[i + 1]]++; b[data[i + 2]]++;
    l[Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])]++;
    total++;
  }
  return { r, g, b, l, total };
}

/** Value below which `frac` of the histogram lies (and from the top for hi). */
export function clipPoints(h: Uint32Array, total: number, frac: number): [number, number] {
  const lim = total * frac;
  let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) { acc += h[i]; if (acc > lim) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += h[i]; if (acc > lim) { hi = i; break; } }
  return [lo, Math.max(lo + 1, hi)];
}

/** Levels LUT. */
export function levelsLUT(inB: number, inW: number, gamma: number, outB = 0, outW = 255): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const range = Math.max(1, inW - inB);
  for (let i = 0; i < 256; i++) {
    let v = Math.min(1, Math.max(0, (i - inB) / range));
    v = Math.pow(v, 1 / gamma);
    lut[i] = outB + v * (outW - outB);
  }
  return lut;
}

export const identityLUT = () => { const l = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) l[i] = i; return l; };

export function composeLUT(a: Uint8ClampedArray, b: Uint8ClampedArray): Uint8ClampedArray {
  const l = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) l[i] = b[a[i]];
  return l;
}

/** Monotone cubic interpolation (Fritsch–Carlson) through curve points → LUT. Points in 0..255. */
export function curveLUT(points: { x: number; y: number }[]): Uint8ClampedArray {
  const p = [...points].sort((a, b) => a.x - b.x);
  const lut = new Uint8ClampedArray(256);
  const n = p.length;
  if (n === 0) return identityLUT();
  if (n === 1) { lut.fill(p[0].y); return lut; }
  const dx: number[] = [], dy: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx.push(p[i + 1].x - p[i].x || 1e-6); dy.push(p[i + 1].y - p[i].y); m.push(dy[i] / dx[i]); }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  for (let x = 0; x < 256; x++) {
    if (x <= p[0].x) { lut[x] = p[0].y; continue; }
    if (x >= p[n - 1].x) { lut[x] = p[n - 1].y; continue; }
    let i = 0;
    while (i < n - 2 && x > p[i + 1].x) i++;
    const h = dx[i], tt = (x - p[i].x) / h;
    const h00 = 2 * tt ** 3 - 3 * tt ** 2 + 1, h10 = tt ** 3 - 2 * tt ** 2 + tt, h01 = -2 * tt ** 3 + 3 * tt ** 2, h11 = tt ** 3 - tt ** 2;
    lut[x] = h00 * p[i].y + h10 * h * t[i] + h01 * p[i + 1].y + h11 * h * t[i + 1];
  }
  return lut;
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};

/** Unsharp mask: src + (src − blurred)·amount where the difference passes the threshold. */
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

/** Noise values (−1…1 uniform and unit gaussian), made once; a pixel picks its values by a hash of its index. */
let noiseTables: { u: Float32Array; g: Float32Array } | null = null;
function tables() {
  if (noiseTables) return noiseTables;
  const N = 1 << 16;
  const u = new Float32Array(N), g = new Float32Array(N);
  let x = 2654435761 >>> 0;
  const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
  for (let i = 0; i < N; i++) {
    u[i] = rnd() * 2 - 1;
    let s = 0; for (let k = 0; k < 4; k++) s += rnd();
    g[i] = (s - 2) * 1.73;
  }
  return (noiseTables = { u, g });
}

/**
 * Add noise (uniform or gaussian, colour or mono); always the same grain for the same picture size. The values
 * come from a table through a per-pixel hash: drawing four random numbers per channel took seconds on 24 MP.
 */
export function addNoise(src: Uint8ClampedArray, dst: Uint8ClampedArray, amount: number, gaussian: boolean, mono: boolean, seed = 1) {
  const T = gaussian ? tables().g : tables().u;
  const amp = amount / 100 * 255 * (gaussian ? 0.5 : 1);
  const s0 = Math.imul(seed, 0x9e3779b1);
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    let hsh = Math.imul(p ^ s0, 0x85ebca6b); hsh ^= hsh >>> 13; hsh = Math.imul(hsh, 0xc2b2ae35); hsh ^= hsh >>> 16;
    if (mono) {
      const n = T[hsh & 0xffff] * amp;
      dst[i] = src[i] + n; dst[i + 1] = src[i + 1] + n; dst[i + 2] = src[i + 2] + n;
    } else {
      // three independent values: the hash mixed again for each channel
      let h2 = Math.imul(hsh ^ (hsh >>> 15), 0x2c1b3c6d); h2 ^= h2 >>> 12;
      let h3 = Math.imul(h2 ^ (h2 >>> 15), 0x297a2d39); h3 ^= h3 >>> 12;
      dst[i] = src[i] + T[hsh & 0xffff] * amp;
      dst[i + 1] = src[i + 1] + T[h2 & 0xffff] * amp;
      dst[i + 2] = src[i + 2] + T[h3 & 0xffff] * amp;
    }
    dst[i + 3] = src[i + 3];
  }
}
