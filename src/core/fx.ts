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
/** Average of two bilinear samples of a premultiplied float buffer (clamped to the edges), written to b[i..i+3]. */
function avg2(a: Float32Array, w: number, h: number, xa: number, ya: number, xb: number, yb: number, b: Float32Array, i: number) {
  const mx = w - 1, my = h - 1;
  xa = xa < 0 ? 0 : xa > mx ? mx : xa; ya = ya < 0 ? 0 : ya > my ? my : ya;
  xb = xb < 0 ? 0 : xb > mx ? mx : xb; yb = yb < 0 ? 0 : yb > my ? my : yb;
  const ax0 = xa | 0, ay0 = ya | 0, bx0 = xb | 0, by0 = yb | 0;
  const afx = xa - ax0, afy = ya - ay0, bfx = xb - bx0, bfy = yb - by0;
  const ax1 = ax0 < mx ? ax0 + 1 : mx, ay1 = ay0 < my ? ay0 + 1 : my, bx1 = bx0 < mx ? bx0 + 1 : mx, by1 = by0 < my ? by0 + 1 : my;
  const a00 = (ay0 * w + ax0) * 4, a10 = (ay0 * w + ax1) * 4, a01 = (ay1 * w + ax0) * 4, a11 = (ay1 * w + ax1) * 4;
  const b00 = (by0 * w + bx0) * 4, b10 = (by0 * w + bx1) * 4, b01 = (by1 * w + bx0) * 4, b11 = (by1 * w + bx1) * 4;
  for (let c = 0; c < 4; c++) {
    const at = a[a00 + c] + (a[a10 + c] - a[a00 + c]) * afx, ab = a[a01 + c] + (a[a11 + c] - a[a01 + c]) * afx;
    const bt = a[b00 + c] + (a[b10 + c] - a[b00 + c]) * bfx, bb = a[b01 + c] + (a[b11 + c] - a[b01 + c]) * bfx;
    b[i + c] = ((at + (ab - at) * afy) + (bt + (bb - bt) * bfy)) / 2;
  }
}
/** Box mean of a single-channel float image (radius r, clamped edges), O(N), both passes in memory order. */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const k = 1 / (2 * r + 1), lastX = w - 1, lastY = h - 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + (x < 0 ? 0 : x > lastX ? lastX : x)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * k;
      const xa = x + r + 1, xb = x - r;
      acc += src[row + (xa > lastX ? lastX : xa)] - src[row + (xb < 0 ? 0 : xb)];
    }
  }
  const acc = new Float64Array(w);
  for (let y = -r; y <= r; y++) { const o = (y < 0 ? 0 : y > lastY ? lastY : y) * w; for (let x = 0; x < w; x++) acc[x] += tmp[o + x]; }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = acc[x] * k;
    const ya = y + r + 1, yb = y - r;
    const oa = (ya > lastY ? lastY : ya) * w, ob = (yb < 0 ? 0 : yb) * w;
    for (let x = 0; x < w; x++) acc[x] += tmp[oa + x] - tmp[ob + x];
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
  for (let s = dist / 4; s >= 0.35; s /= 2) {
    const ox = dx * s, oy = dy * s;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) avg2(a, w, h, x + ox, y + oy, x - ox, y - oy, b, i);
    const t = a; a = b; b = t;
  }
  fromPremul(a, dst);
}

/** Radial blur around (cx, cy): zoom (rays from the centre) or spin (circles around it). */
export function radialBlur(src: Buf, dst: Buf, w: number, h: number, cx: number, cy: number, amount: number, mode: 'zoom' | 'spin') {
  let a: Float32Array = toPremul(src), b: Float32Array = new Float32Array(a.length);
  const R = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
  let s = mode === 'zoom' ? amount / 100 * 0.2 : amount / 100 * (20 * Math.PI / 180);
  while (s * R >= 0.5) {
    const cs = Math.cos(s), sn = Math.sin(s);
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
      const vx = x - cx, vy = y - cy;
      if (mode === 'zoom') avg2(a, w, h, cx + vx * (1 + s), cy + vy * (1 + s), cx + vx * (1 - s), cy + vy * (1 - s), b, i);
      else avg2(a, w, h, cx + vx * cs - vy * sn, cy + vx * sn + vy * cs, cx + vx * cs + vy * sn, cy - vx * sn + vy * cs, b, i);
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

/** Sliding minimum along each row (monotonic queue), radius r, edges clamped. */
function minRows(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, q: Int32Array) {
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let head = 0, tail = 0;
    for (let i = 0; i < w + r; i++) {
      if (i < w) { const v = src[o + i]; while (tail > head && src[o + q[tail - 1]] >= v) tail--; q[tail++] = i; }
      const c = i - r;
      if (c >= 0) { while (q[head] < c - r) head++; dst[o + c] = src[o + q[head]]; }
    }
  }
}
/** Transpose a w×h single-channel image in cache-friendly blocks. */
function transpose(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h), B = 64;
  for (let y0 = 0; y0 < h; y0 += B) for (let x0 = 0; x0 < w; x0 += B) {
    const y1 = Math.min(h, y0 + B), x1 = Math.min(w, x0 + B);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[x * h + y] = src[y * w + x];
  }
  return out;
}
/** Sliding minimum over a square window of radius r (rows, then columns through a transpose). */
function minFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const q = new Int32Array(Math.max(w, h) + 1);
  const tmp = new Float32Array(w * h);
  minRows(src, tmp, w, h, r, q);
  const t = transpose(tmp, w, h), t2 = new Float32Array(w * h);
  minRows(t, t2, h, w, r, q);
  return transpose(t2, h, w);
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
export function denoise(src: Buf, dst: Buf, w: number, h: number, luma: number, chroma: number, scale = 1) {
  const n = w * h;
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    const r = src[i] / 255, g = src[i + 1] / 255, b = src[i + 2] / 255;
    Y[p] = lum(r, g, b); Cb[p] = -0.168736 * r - 0.331264 * g + 0.5 * b; Cr[p] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  const y2 = luma > 0 ? guided(Y, Y, w, h, Math.max(1, Math.round((2 + Math.round(luma / 40)) * scale)), Math.pow(luma / 100, 2) * 0.012) : Y;
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

/**
 * Halftone: dots on a rotated grid, sized by the darkness of their cell; mono (black on white) or in the
 * image colours. Computed per pixel (cell averages first, then each pixel tests the four nearest dots with
 * an antialiased edge) instead of drawing hundreds of thousands of circles on a canvas.
 */
export function halftone(src: Buf, dst: Buf, w: number, h: number, cell: number, angle: number, color: boolean) {
  const c = Math.max(1, cell);   // the dialog keeps it ≥ 3; smaller only for the reduced draft preview
  const an = angle * Math.PI / 180, cs = Math.cos(an), sn = Math.sin(an);
  const cx = w / 2, cy = h / 2;
  const N = Math.ceil(Math.hypot(w, h) / 2 / c) + 2, S = 2 * N + 1;
  // grid coordinates of a pixel: u along the rotated x axis, v along the rotated y axis (in cells)
  const ic = 1 / c;
  // 1) average colour of each cell (alpha-weighted)
  const sr = new Float32Array(S * S), sg = new Float32Array(S * S), sb = new Float32Array(S * S), sa = new Float32Array(S * S);
  for (let y = 0, i = 0; y < h; y++) {
    const dy = y - cy;
    for (let x = 0; x < w; x++, i += 4) {
      const al = src[i + 3];
      if (!al) continue;
      const dx = x - cx;
      const u = (dx * cs + dy * sn) * ic, v = (dy * cs - dx * sn) * ic;
      const k = (Math.round(v) + N) * S + Math.round(u) + N;
      sr[k] += src[i] * al; sg[k] += src[i + 1] * al; sb[k] += src[i + 2] * al; sa[k] += al;
    }
  }
  // 2) dot radius (in cells) per cell from its lightness
  const rad = new Float32Array(S * S);
  for (let k = 0; k < rad.length; k++) {
    const a = sa[k];
    if (!a) continue;
    sr[k] /= a; sg[k] /= a; sb[k] /= a;
    const L = lum(sr[k], sg[k], sb[k]) / 255;
    const r = 0.71 * Math.sqrt(Math.max(0, 1 - L));
    rad[k] = r * c < 0.3 ? 0 : r;
  }
  // 3) each pixel: coverage by the nearest dots (union), 1 px soft edge
  for (let y = 0, i = 0; y < h; y++) {
    const dy = y - cy;
    for (let x = 0; x < w; x++, i += 4) {
      const dx = x - cx;
      const u = (dx * cs + dy * sn) * ic, v = (dy * cs - dx * sn) * ic;
      const u0 = Math.floor(u), v0 = Math.floor(v);
      let cov = 0, best = -1;
      for (let j = v0; j <= v0 + 1; j++) for (let q = u0; q <= u0 + 1; q++) {
        const k = (j + N) * S + q + N;
        const r = rad[k];
        if (!r) continue;
        const du = u - q, dv = v - j, d2 = du * du + dv * dv, reach = r + 0.5 * ic;
        if (d2 >= reach * reach) continue;
        const e = (r - Math.sqrt(d2)) * c + 0.5;
        const cv = e >= 1 ? 1 : e;
        if (cv > cov) { cov = cv; best = k; }
      }
      if (color && best >= 0) {
        dst[i] = 255 + (sr[best] - 255) * cov; dst[i + 1] = 255 + (sg[best] - 255) * cov; dst[i + 2] = 255 + (sb[best] - 255) * cov;
      } else {
        dst[i] = dst[i + 1] = dst[i + 2] = 255 * (1 - cov);
      }
      dst[i + 3] = src[i + 3];
    }
  }
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

/* ---------------- simple colour filters ---------------- */
const SEPIA_STOPS: { p: number; c: RGBc }[] = [{ p: 0, c: [38, 22, 12] }, { p: 0.55, c: [160, 112, 70] }, { p: 1, c: [246, 232, 206] }];

/** Sepia: brown toning by brightness (the classic old-photo look); `amount` mixes it with the original. */
export function sepia(src: Buf, dst: Buf, _w: number, _h: number, amount: number) {
  gradientMap(src, dst, SEPIA_STOPS, amount);
}

/** Posterize: each channel reduced to `levels` equal steps (poster / screen-print look). */
export function posterize(src: Buf, dst: Buf, _w: number, _h: number, levels: number) {
  const n = Math.max(2, Math.min(255, Math.round(levels)));
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(Math.min(n - 1, Math.floor(i * n / 256)) * 255 / (n - 1));
  for (let i = 0; i < src.length; i += 4) { dst[i] = lut[src[i]]; dst[i + 1] = lut[src[i + 1]]; dst[i + 2] = lut[src[i + 2]]; dst[i + 3] = src[i + 3]; }
}

/** Threshold: pure black and white, split at brightness `level` (line art, stamps, scans). */
export function threshold(src: Buf, dst: Buf, _w: number, _h: number, level: number) {
  for (let i = 0; i < src.length; i += 4) {
    const v = lum(src[i], src[i + 1], src[i + 2]) >= level ? 255 : 0;
    dst[i] = dst[i + 1] = dst[i + 2] = v; dst[i + 3] = src[i + 3];
  }
}

/* ---------------- simple effects ---------------- */
/**
 * Emboss: relief lit from `angle` (degrees, 135 = from the top left): the brightness difference across
 * `height` px, on grey or over the image colours.
 */
export function emboss(src: Buf, dst: Buf, w: number, h: number, angle: number, height: number, amount: number, color: boolean) {
  const n = w * h;
  const L = new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) L[p] = lum(src[i], src[i + 1], src[i + 2]);
  const an = angle * Math.PI / 180, dx = Math.cos(an) * height, dy = -Math.sin(an) * height;
  const k = amount / 100, mx = w - 1, my = h - 1;
  const at = (x: number, y: number) => {
    x = x < 0 ? 0 : x > mx ? mx : x; y = y < 0 ? 0 : y > my ? my : y;
    const x0 = x | 0, y0 = y | 0, x1 = x0 < mx ? x0 + 1 : mx, y1 = y0 < my ? y0 + 1 : my, fx = x - x0, fy = y - y0;
    const t = L[y0 * w + x0] + (L[y0 * w + x1] - L[y0 * w + x0]) * fx, b = L[y1 * w + x0] + (L[y1 * w + x1] - L[y1 * w + x0]) * fx;
    return t + (b - t) * fy;
  };
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
    // facing the light (darker towards it, brighter away from it) comes out bright
    const d = (at(x - dx, y - dy) - at(x + dx, y + dy)) * k;
    if (color) { dst[i] = src[i] + d; dst[i + 1] = src[i + 1] + d; dst[i + 2] = src[i + 2] + d; }
    else dst[i] = dst[i + 1] = dst[i + 2] = 128 + d;
    dst[i + 3] = src[i + 3];
  }
}

/** Find Edges: outlines of the image in its colours on white (Sobel per channel), like a coloured sketch. */
export function findEdges(src: Buf, dst: Buf, w: number, h: number) {
  const mx = w - 1, my = h - 1;
  for (let y = 0; y < h; y++) {
    const ya = (y > 0 ? y - 1 : 0) * w, yb = y * w, yc = (y < my ? y + 1 : my) * w;
    for (let x = 0; x < w; x++) {
      const xa = x > 0 ? x - 1 : 0, xc = x < mx ? x + 1 : mx;
      const i = (yb + x) * 4;
      for (let c = 0; c < 3; c++) {
        const p00 = src[(ya + xa) * 4 + c], p01 = src[(ya + x) * 4 + c], p02 = src[(ya + xc) * 4 + c];
        const p10 = src[(yb + xa) * 4 + c], p12 = src[(yb + xc) * 4 + c];
        const p20 = src[(yc + xa) * 4 + c], p21 = src[(yc + x) * 4 + c], p22 = src[(yc + xc) * 4 + c];
        const gx = p02 + 2 * p12 + p22 - p00 - 2 * p10 - p20, gy = p20 + 2 * p21 + p22 - p00 - 2 * p01 - p02;
        dst[i + c] = 255 - Math.sqrt(gx * gx + gy * gy) / 4;
      }
      dst[i + 3] = src[i + 3];
    }
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
  const N = lut.size, D = lut.data, s = strength / 100, M = N - 1;
  // per channel and byte value: the lower grid index (as an offset into the data), the step to the next one
  // and the fraction between them (no per-pixel division or allocation: 24 MP stays well under a second)
  const lo = [new Int32Array(256), new Int32Array(256), new Int32Array(256)];
  const step = [new Int32Array(256), new Int32Array(256), new Int32Array(256)];
  const fr = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  const stride = [3, N * 3, N * N * 3];
  for (let c = 0; c < 3; c++) {
    const span = lut.max[c] - lut.min[c] || 1;
    for (let v = 0; v < 256; v++) {
      const x = Math.min(M, Math.max(0, ((v / 255 - lut.min[c]) / span) * M));
      const i0 = Math.floor(x);
      lo[c][v] = i0 * stride[c];
      step[c][v] = (i0 < M ? 1 : 0) * stride[c];
      fr[c][v] = x - i0;
    }
  }
  const [loR, loG, loB] = lo, [stR, stG, stB] = step, [frR, frG, frB] = fr;
  for (let i = 0; i < src.length; i += 4) {
    const r = src[i], g = src[i + 1], b = src[i + 2];
    const o000 = loR[r] + loG[g] + loB[b];
    const dr = stR[r], dg = stG[g], db = stB[b];
    const fR = frR[r], fG = frG[g], fB = frB[b];
    for (let c = 0; c < 3; c++) {
      const o = o000 + c;
      const c00 = D[o] + (D[o + dr] - D[o]) * fR;
      const c10 = D[o + dg] + (D[o + dg + dr] - D[o + dg]) * fR;
      const c01 = D[o + db] + (D[o + db + dr] - D[o + db]) * fR;
      const c11 = D[o + db + dg] + (D[o + db + dg + dr] - D[o + db + dg]) * fR;
      const c0 = c00 + (c10 - c00) * fG, c1 = c01 + (c11 - c01) * fG;
      const out = (c0 + (c1 - c0) * fB) * 255;
      dst[i + c] = src[i + c] + (out - src[i + c]) * s;
    }
    dst[i + 3] = src[i + 3];
  }
}
