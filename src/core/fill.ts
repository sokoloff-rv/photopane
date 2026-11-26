/** The area a fill covered (x1, y1 exclusive); empty when x1 <= x0. */
export interface FillBox { x0: number; y0: number; x1: number; y1: number }

/**
 * Flood fill / color range. Returns per-pixel coverage (0..255).
 * tolerance 0..255 compares max channel difference (including alpha).
 * `box` receives the covered area, so the callers (Magic Wand, Bucket) work on it instead of the whole
 * picture: on a 12 MP photo each whole-picture pass cost tens of milliseconds even for a small fill.
 */
export function floodMask(img: ImageData, sx: number, sy: number, tolerance: number, contiguous: boolean, antialias = true, box?: FillBox): Uint8Array {
  const { width: w, height: h, data: d } = img;
  const out = new Uint8Array(w * h);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  const report = () => {
    if (!box) return;
    if (maxX < 0) { box.x0 = box.y0 = box.x1 = box.y1 = 0; return; }
    // the soft edge reaches one pixel further
    const m = antialias ? 1 : 0;
    box.x0 = Math.max(0, minX - m); box.y0 = Math.max(0, minY - m);
    box.x1 = Math.min(w, maxX + 1 + m); box.y1 = Math.min(h, maxY + 1 + m);
  };
  sx = Math.floor(sx); sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) { report(); return out; }
  const si = (sy * w + sx) * 4;
  const r0 = d[si], g0 = d[si + 1], b0 = d[si + 2], a0 = d[si + 3];
  const tol = tolerance;
  const match = (p: number) => {
    const i = p * 4;
    // transparent pixels are compared by alpha only
    if (a0 === 0) return d[i + 3] <= tol;
    if (d[i + 3] === 0) return a0 <= tol;
    return Math.abs(d[i] - r0) <= tol && Math.abs(d[i + 1] - g0) <= tol &&
      Math.abs(d[i + 2] - b0) <= tol && Math.abs(d[i + 3] - a0) <= tol;
  };
  if (!contiguous) {
    for (let y = 0, p = 0; y < h; y++) for (let x = 0; x < w; x++, p++) {
      if (!match(p)) continue;
      out[p] = 255;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; maxY = y;
    }
  } else {
    const stack: number[] = [sx, sy];
    while (stack.length) {
      const y = stack.pop()!, x0 = stack.pop()!;
      let x = x0;
      const row = y * w;
      if (out[row + x] || !match(row + x)) continue;
      while (x > 0 && !out[row + x - 1] && match(row + x - 1)) x--;
      let upOpen = false, downOpen = false;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (; x < w && !out[row + x] && match(row + x); x++) {
        out[row + x] = 255;
        if (y > 0) {
          const m = !out[row - w + x] && match(row - w + x);
          if (m && !upOpen) { stack.push(x, y - 1); upOpen = true; } else if (!m) upOpen = false;
        }
        if (y < h - 1) {
          const m = !out[row + w + x] && match(row + w + x);
          if (m && !downOpen) { stack.push(x, y + 1); downOpen = true; } else if (!m) downOpen = false;
        }
      }
      if (x - 1 > maxX) maxX = x - 1;
    }
  }
  report();
  if (maxX < 0) return out;
  if (antialias) {
    // soften the hard edge: edge pixels get partial coverage (only around the filled area)
    const res = out.slice();
    for (let y = Math.max(1, minY - 1); y <= Math.min(h - 2, maxY + 1); y++) {
      for (let x = Math.max(1, minX - 1); x <= Math.min(w - 2, maxX + 1); x++) {
        const p = y * w + x;
        const s = out[p - 1] + out[p + 1] + out[p - w] + out[p + w] + out[p] * 4;
        if (s !== 0 && s !== 255 * 8) res[p] = Math.round(s / 8);
      }
    }
    return res;
  }
  return out;
}

/** Coverage array → white canvas mask (alpha = coverage), optionally offset. */
export function coverageToImageData(cov: Uint8Array, w: number, h: number, r = 255, g = 255, b = 255): ImageData {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let i = 0, j = 0; i < cov.length; i++, j += 4) {
    if (cov[i]) { d[j] = r; d[j + 1] = g; d[j + 2] = b; d[j + 3] = cov[i]; }
  }
  return img;
}
