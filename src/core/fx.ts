/**
 * Modern filters (all work on RGBA byte buffers of the same size; colour maths on premultiplied floats
 * where pixels are mixed, so transparent edges get no dark halos).
 */
import { boxesForGauss, gaussianBlur } from './filters';

type Buf = Uint8ClampedArray;

/* ---------------- helpers ---------------- */
function toPremul(src: Buf): Float32Array {
  const a = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const al = src[i + 3] / 255;
    a[i] = src[i] * al; a[i + 1] = src[i + 1] * al; a[i + 2] = src[i + 2] * al; a[i + 3] = src[i + 3];
  }
  return a;
}
function fromPremul(a: Float32Array, out: Buf) {
  for (let i = 0; i < a.length; i += 4) {
    const al = a[i + 3];
    if (al <= 0.01) { out[i + 3] = 0; continue; }
    const k = 255 / al;
    out[i] = a[i] * k; out[i + 1] = a[i + 1] * k; out[i + 2] = a[i + 2] * k; out[i + 3] = al;
  }
}
/** Bilinear sample of a premultiplied float buffer (clamped to the edges) into o[0..3]. */
function sample(a: Float32Array, w: number, h: number, x: number, y: number, o: Float32Array) {
  x = Math.min(w - 1, Math.max(0, x)); y = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const top = a[i00 + c] + (a[i10 + c] - a[i00 + c]) * fx;
    const bot = a[i01 + c] + (a[i11 + c] - a[i01 + c]) * fx;
    o[c] = top + (bot - top) * fy;
  }
}
/** Box mean of a single-channel float image (radius r), O(N). */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * r + 1);
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}
function blurF(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return src.slice();
  let a: Float32Array = src;
  for (const size of boxesForGauss(sigma, 3)) { const r = Math.max(1, Math.round((size - 1) / 2)); a = boxMean(a, w, h, r); }
  return a;
}
/** Edge-preserving smoothing (guided filter, He et al.) of channel p with guide I. */
function guided(I: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h;
  const II = new Float32Array(n), Ip = new Float32Array(n);
  for (let i = 0; i < n; i++) { II[i] = I[i] * I[i]; Ip[i] = I[i] * p[i]; }
  const mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r), mII = boxMean(II, w, h, r), mIp = boxMean(Ip, w, h, r);
  const A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = mII[i] - mI[i] * mI[i], cv = mIp[i] - mI[i] * mp[i];
    A[i] = cv / (v + eps); B[i] = mp[i] - A[i] * mI[i];
  }
  const mA = boxMean(A, w, h, r), mB = boxMean(B, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = mA[i] * I[i] + mB[i];
  return q;
}
function channel(src: Buf, c: number): Float32Array {
  const o = new Float32Array(src.length / 4);
  for (let i = 0, p = 0; p < o.length; i += 4, p++) o[p] = src[i + c] / 255;
  return o;
}
const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Keep the source alpha (Preserve transparency) — colour comes from the filtered result. */
export function keepAlpha(src: Buf, dst: Buf) { for (let i = 3; i < src.length; i += 4) dst[i] = src[i]; }

/* ---------------- blur ---------------- */
/** Motion blur along an angle (degrees, counter-clockwise) over `dist` px: repeated averaging of shifted copies. */
export function motionBlur(src: Buf, dst: Buf, w: number, h: number, angle: number, dist: number) {
  let a: Float32Array = toPremul(src), b: Float32Array = new Float32Array(a.length);
  const dx = Math.cos(angle * Math.PI / 180), dy = -Math.sin(angle * Math.PI / 180);
  const s1 = new Float32Array(4), s2 = new Float32Array(4);
  for (let s = dist / 4; s >= 0.35; s /= 2) {
    const ox = dx * s, oy = dy * s;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
      sample(a, w, h, x + ox, y + oy, s1); sample(a, w, h, x - ox, y - oy, s2);
      b[i] = (s1[0] + s2[0]) / 2; b[i + 1] = (s1[1] + s2[1]) / 2; b[i + 2] = (s1[2] + s2[2]) / 2; b[i + 3] = (s1[3] + s2[3]) / 2;
    }
    const t = a; a = b; b = t;
  }
  fromPremul(a, dst);
}

/** Radial blur around (cx, cy): zoom (rays from the centre) or spin (circles around it). */
export function radialBlur(src: Buf, dst: Buf, w: number, h: number, cx: number, cy: number, amount: number, mode: 'zoom' | 'spin') {
  let a: Float32Array = toPremul(src), b: Float32Array = new Float32Array(a.length);
  const s1 = new Float32Array(4), s2 = new Float32Array(4);
  const R = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
  let s = mode === 'zoom' ? amount / 100 * 0.2 : amount / 100 * (20 * Math.PI / 180);
  while (s * R >= 0.5) {
    const cs = Math.cos(s), sn = Math.sin(s);
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
      const vx = x - cx, vy = y - cy;
      if (mode === 'zoom') { sample(a, w, h, cx + vx * (1 + s), cy + vy * (1 + s), s1); sample(a, w, h, cx + vx * (1 - s), cy + vy * (1 - s), s2); }
      else { sample(a, w, h, cx + vx * cs - vy * sn, cy + vx * sn + vy * cs, s1); sample(a, w, h, cx + vx * cs + vy * sn, cy - vx * sn + vy * cs, s2); }
      b[i] = (s1[0] + s2[0]) / 2; b[i + 1] = (s1[1] + s2[1]) / 2; b[i + 2] = (s1[2] + s2[2]) / 2; b[i + 3] = (s1[3] + s2[3]) / 2;
    }
    const t = a; a = b; b = t;
    s /= 2;
  }
  fromPremul(a, dst);
}

/** Surface blur: smooths flat areas and noise, keeps edges (guided filter per channel). */
export function surfaceBlur(src: Buf, dst: Buf, w: number, h: number, radius: number, threshold: number) {
  const r = Math.max(1, Math.round(radius));
  const eps = Math.pow(threshold / 255, 2);
  for (let c = 0; c < 3; c++) {
    const p = channel(src, c);
    const q = guided(p, p, w, h, r, eps);
    for (let i = 0, k = c; i < q.length; i++, k += 4) dst[k] = q[i] * 255;
  }
  keepAlpha(src, dst);
}

/* ---------------- detail ---------------- */
/** High Pass: details around mid-grey (use with Overlay / Soft Light for clean sharpening). */
export function highPass(src: Buf, dst: Buf, w: number, h: number, radius: number) {
  const bl = gaussianBlur(src, w, h, radius);
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = 128 + src[i] - bl[i]; dst[i + 1] = 128 + src[i + 1] - bl[i + 1]; dst[i + 2] = 128 + src[i + 2] - bl[i + 2]; dst[i + 3] = src[i + 3];
  }
}

/** Sliding minimum over a window of radius r (rows then columns). */
function minFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const q = new Int32Array(Math.max(w, h));
  const pass = (get: (i: number) => number, set: (i: number, v: number) => void, n: number) => {
    let head = 0, tail = 0;
    for (let i = 0; i < n + r; i++) {
      if (i < n) { const v = get(i); while (tail > head && get(q[tail - 1]) >= v) tail--; q[tail++] = i; }
      const c = i - r;
      if (c >= 0) { while (q[head] < c - r) head++; set(c, get(q[head])); }
    }
  };
  for (let y = 0; y < h; y++) pass(i => src[y * w + i], (i, v) => { tmp[y * w + i] = v; }, w);
  for (let x = 0; x < w; x++) pass(i => tmp[i * w + x], (i, v) => { out[i * w + x] = v; }, h);
  return out;
}

/** Dehaze (dark channel prior with a guided-filter transmission map); negative adds haze. */
export function dehaze(src: Buf, dst: Buf, w: number, h: number, amount: number) {
  const n = w * h;
  if (amount < 0) {
    // add haze: lift towards a soft light grey-blue
    const k = -amount / 100 * 0.6;
    for (let i = 0; i < src.length; i += 4) { dst[i] = src[i] + (215 - src[i]) * k; dst[i + 1] = src[i + 1] + (220 - src[i + 1]) * k; dst[i + 2] = src[i + 2] + (228 - src[i + 2]) * k; dst[i + 3] = src[i + 3]; }
    return;
  }
  const r = Math.max(3, Math.round(Math.min(w, h) / 120));
  const dark0 = new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) dark0[p] = Math.min(src[i], src[i + 1], src[i + 2]) / 255;
  const dark = minFilter(dark0, w, h, r);
  // atmospheric light: mean colour of the 0.1% haziest pixels
  const bins = new Uint32Array(1024);
  for (let p = 0; p < n; p++) bins[Math.min(1023, Math.floor(dark[p] * 1023))]++;
  let cut = 1023, acc = 0;
  const want = Math.max(1, Math.floor(n / 1000));
  while (cut > 0 && acc + bins[cut] < want) acc += bins[cut--];
  let A = [0, 0, 0], cnt = 0;
  for (let p = 0; p < n; p++) if (dark[p] * 1023 >= cut) { A[0] += src[p * 4]; A[1] += src[p * 4 + 1]; A[2] += src[p * 4 + 2]; cnt++; }
  A = A.map(v => Math.max(40, v / Math.max(1, cnt)) / 255);
  const nd = new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) nd[p] = Math.min(src[i] / 255 / A[0], src[i + 1] / 255 / A[1], src[i + 2] / 255 / A[2]);
  const ndm = minFilter(nd, w, h, r);
  const omega = amount / 100 * 0.95;
  const t0 = new Float32Array(n);
  for (let p = 0; p < n; p++) t0[p] = 1 - omega * ndm[p];
  const L = new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) L[p] = lum(src[i], src[i + 1], src[i + 2]) / 255;
  const t = guided(L, t0, w, h, r * 4, 1e-3);
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    const tt = Math.max(0.1, Math.min(1, t[p]));
    for (let c = 0; c < 3; c++) dst[i + c] = ((src[i + c] / 255 - A[c]) / tt + A[c]) * 255;
    dst[i + 3] = src[i + 3];
  }
}

/** Noise reduction with separate luminance and colour strength (YCbCr). */
export function denoise(src: Buf, dst: Buf, w: number, h: number, luma: number, chroma: number) {
  const n = w * h;
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    const r = src[i] / 255, g = src[i + 1] / 255, b = src[i + 2] / 255;
    Y[p] = lum(r, g, b); Cb[p] = -0.168736 * r - 0.331264 * g + 0.5 * b; Cr[p] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  const y2 = luma > 0 ? guided(Y, Y, w, h, 2 + Math.round(luma / 40), Math.pow(luma / 100, 2) * 0.012) : Y;
  const sc = chroma / 100 * Math.max(2, Math.min(w, h) / 250);
  const cb2 = chroma > 0 ? blurF(Cb, w, h, sc) : Cb, cr2 = chroma > 0 ? blurF(Cr, w, h, sc) : Cr;
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    const yy = y2[p], cb = cb2[p], cr = cr2[p];
    dst[i] = (yy + 1.402 * cr) * 255; dst[i + 1] = (yy - 0.344136 * cb - 0.714136 * cr) * 255; dst[i + 2] = (yy + 1.772 * cb) * 255; dst[i + 3] = src[i + 3];
  }
}

/* ---------------- light & optics ---------------- */
/** Glow / bloom: soft light around bright areas (screen blend); `warm` gives film halation. */
export function glow(src: Buf, dst: Buf, w: number, h: number, threshold: number, radius: number, strength: number, warm: boolean) {
  const g = new Uint8ClampedArray(src.length);
  const thr = threshold / 255;
  for (let i = 0; i < src.length; i += 4) {
    const L = lum(src[i], src[i + 1], src[i + 2]) / 255;
    const k = L <= thr ? 0 : Math.min(1, (L - thr) / Math.max(0.02, 1 - thr));
    g[i] = src[i] * k; g[i + 1] = src[i + 1] * k; g[i + 2] = src[i + 2] * k; g[i + 3] = src[i + 3];
  }
  const bl = gaussianBlur(g, w, h, radius);
  const tint = warm ? [1, 0.62, 0.42] : [1, 1, 1];
  const s = strength / 100;
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const a = src[i + c] / 255, b = Math.min(1, bl[i + c] / 255 * tint[c] * s);
      dst[i + c] = (1 - (1 - a) * (1 - b)) * 255;
    }
    dst[i + 3] = src[i + 3];
  }
}

/** Chromatic aberration: red and blue scaled from the centre in opposite directions (negative corrects fringes). */
export function chromatic(src: Buf, dst: Buf, w: number, h: number, amount: number, cx: number, cy: number) {
  const a = toPremul(src);
  const k = amount / 100 * 0.012;
  const o = new Float32Array(4);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
    const vx = x - cx, vy = y - cy;
    sample(a, w, h, cx + vx / (1 + k), cy + vy / (1 + k), o); const r = o[0], ar = o[3];
    sample(a, w, h, cx + vx / (1 - k), cy + vy / (1 - k), o); const b = o[2], ab = o[3];
    const ag = a[i + 3];
    const al = Math.max(ar, ag, ab);
    if (al <= 0.01) { dst[i + 3] = 0; continue; }
    const m = 255 / al;
    dst[i] = r * m; dst[i + 1] = a[i + 1] * m; dst[i + 2] = b * m; dst[i + 3] = al;
  }
}

/* ---------------- stylize ---------------- */
/** Mosaic: average colour per square cell (hide faces, plates, private data). */
export function pixelate(src: Buf, dst: Buf, w: number, h: number, cell: number) {
  const c = Math.max(2, Math.round(cell));
  for (let y0 = 0; y0 < h; y0 += c) for (let x0 = 0; x0 < w; x0 += c) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    const x1 = Math.min(w, x0 + c), y1 = Math.min(h, y0 + c);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4, al = src[i + 3];
      r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; n++;
    }
    const R = a ? r / a : 0, G = a ? g / a : 0, B = a ? b / a : 0, A = a / n;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; dst[i] = R; dst[i + 1] = G; dst[i + 2] = B; dst[i + 3] = A; }
  }
}

/** Halftone: dots on a rotated grid, sized by darkness; mono (black on white) or in the image colours. */
export function halftone(src: Buf, dst: Buf, w: number, h: number, cell: number, angle: number, color: boolean) {
  const c = Math.max(3, cell);
  const bl = gaussianBlur(src, w, h, c / 3);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  const an = angle * Math.PI / 180, cs = Math.cos(an), sn = Math.sin(an);
  const R = Math.hypot(w, h);
  for (let v = -R; v < R; v += c) for (let u = -R; u < R; u += c) {
    const x = w / 2 + u * cs - v * sn, y = h / 2 + u * sn + v * cs;
    if (x < -c || y < -c || x > w + c || y > h + c) continue;
    const xi = Math.min(w - 1, Math.max(0, Math.round(x))), yi = Math.min(h - 1, Math.max(0, Math.round(y)));
    const i = (yi * w + xi) * 4;
    const L = lum(bl[i], bl[i + 1], bl[i + 2]) / 255;
    const rad = c * 0.71 * Math.sqrt(Math.max(0, 1 - L));
    if (rad < 0.3) continue;
    g.fillStyle = color ? `rgb(${bl[i]},${bl[i + 1]},${bl[i + 2]})` : '#000';
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  const out = g.getImageData(0, 0, w, h).data;
  for (let i = 0; i < src.length; i += 4) { dst[i] = out[i]; dst[i + 1] = out[i + 1]; dst[i + 2] = out[i + 2]; dst[i + 3] = src[i + 3]; }
}

export type RGBc = [number, number, number];
/** Gradient map: luminance → colour along the stops (0..1 positions), mixed by strength. */
export function gradientMap(src: Buf, dst: Buf, stops: { p: number; c: RGBc }[], strength: number) {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1].p) k++;
    const a = stops[k], b = stops[Math.min(stops.length - 1, k + 1)];
    const f = b.p > a.p ? Math.min(1, Math.max(0, (t - a.p) / (b.p - a.p))) : 0;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = a.c[c] + (b.c[c] - a.c[c]) * f;
  }
  const s = strength / 100;
  for (let i = 0; i < src.length; i += 4) {
    const L = Math.round(lum(src[i], src[i + 1], src[i + 2]));
    for (let c = 0; c < 3; c++) dst[i + c] = src[i + c] + (lut[L * 3 + c] - src[i + c]) * s;
    dst[i + 3] = src[i + 3];
  }
}

/* ---------------- 3D LUT (.cube) ---------------- */
export interface Lut3D { size: number; data: Float32Array; min: RGBc; max: RGBc; title: string }

export function parseCube(text: string): Lut3D {
  let size = 0, title = '';
  let min: RGBc = [0, 0, 0], max: RGBc = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [k, ...rest] = line.split(/\s+/);
    if (k === 'TITLE') { title = line.slice(5).trim().replace(/^"|"$/g, ''); continue; }
    if (k === 'LUT_3D_SIZE') { size = +rest[0]; continue; }
    if (k === 'DOMAIN_MIN') { min = rest.map(Number) as RGBc; continue; }
    if (k === 'DOMAIN_MAX') { max = rest.map(Number) as RGBc; continue; }
    if (k === 'LUT_1D_SIZE') throw new Error('1D LUT');
    if (/^[-\d.]/.test(k)) vals.push(+k, +rest[0], +rest[1]);
  }
  if (!size || vals.length < size * size * size * 3) throw new Error('bad LUT');
  return { size, data: new Float32Array(vals.slice(0, size * size * size * 3)), min, max, title };
}

/** Apply a 3D LUT (trilinear), mixed by strength. Red changes fastest in .cube data. */
export function applyLut(src: Buf, dst: Buf, lut: Lut3D, strength: number) {
  const N = lut.size, D = lut.data, s = strength / 100;
  const at = (r: number, g: number, b: number, c: number) => D[((b * N + g) * N + r) * 3 + c];
  for (let i = 0; i < src.length; i += 4) {
    const v = [0, 1, 2].map(c => Math.min(N - 1, Math.max(0, ((src[i + c] / 255 - lut.min[c]) / (lut.max[c] - lut.min[c])) * (N - 1))));
    const r0 = Math.floor(v[0]), g0 = Math.floor(v[1]), b0 = Math.floor(v[2]);
    const r1 = Math.min(N - 1, r0 + 1), g1 = Math.min(N - 1, g0 + 1), b1 = Math.min(N - 1, b0 + 1);
    const fr = v[0] - r0, fg = v[1] - g0, fb = v[2] - b0;
    for (let c = 0; c < 3; c++) {
      const c00 = at(r0, g0, b0, c) + (at(r1, g0, b0, c) - at(r0, g0, b0, c)) * fr;
      const c10 = at(r0, g1, b0, c) + (at(r1, g1, b0, c) - at(r0, g1, b0, c)) * fr;
      const c01 = at(r0, g0, b1, c) + (at(r1, g0, b1, c) - at(r0, g0, b1, c)) * fr;
      const c11 = at(r0, g1, b1, c) + (at(r1, g1, b1, c) - at(r0, g1, b1, c)) * fr;
      const c0 = c00 + (c10 - c00) * fg, c1 = c01 + (c11 - c01) * fg;
      const out = (c0 + (c1 - c0) * fb) * 255;
      dst[i + c] = src[i + c] + (out - src[i + c]) * s;
    }
    dst[i + 3] = src[i + 3];
  }
}
