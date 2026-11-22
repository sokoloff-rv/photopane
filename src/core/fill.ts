/**
 * Flood fill / color range. Returns per-pixel coverage (0..255).
 * tolerance 0..255 compares max channel difference (including alpha).
 */
export function floodMask(img: ImageData, sx: number, sy: number, tolerance: number, contiguous: boolean, antialias = true): Uint8Array {
  const { width: w, height: h, data: d } = img;
  const out = new Uint8Array(w * h);
  sx = Math.floor(sx); sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return out;
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
    for (let p = 0; p < w * h; p++) if (match(p)) out[p] = 255;
  } else {
    const stack: number[] = [sx, sy];
    while (stack.length) {
      const y = stack.pop()!, x0 = stack.pop()!;
      let x = x0;
      const row = y * w;
      if (out[row + x] || !match(row + x)) continue;
      while (x > 0 && !out[row + x - 1] && match(row + x - 1)) x--;
      let upOpen = false, downOpen = false;
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
    }
  }
  if (antialias) {
    // soften the hard edge: edge pixels get partial coverage
    const res = out.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
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
