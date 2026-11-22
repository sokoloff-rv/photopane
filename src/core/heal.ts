/**
 * Spot healing: fill the painted area with texture from a nearby matching patch whose colour and
 * brightness are adjusted to the surroundings (membrane / pull-push interpolation of the boundary
 * difference, a fast approximation of Poisson blending).
 */

/** Smoothly fill values where weight = 0 from known neighbours (pull-push pyramid). 4 channels. */
function pullPush(v: Float32Array, wt: Float32Array, w: number, h: number) {
  const lv: { v: Float32Array; wt: Float32Array; w: number; h: number }[] = [{ v, wt, w, h }];
  while (lv[lv.length - 1].w > 1 || lv[lv.length - 1].h > 1) {
    const f = lv[lv.length - 1];
    const nw = Math.ceil(f.w / 2), nh = Math.ceil(f.h / 2);
    const cv = new Float32Array(nw * nh * 4), cw = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let sw = 0; const acc = [0, 0, 0, 0];
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const fx = 2 * x + i, fy = 2 * y + j;
        if (fx >= f.w || fy >= f.h) continue;
        const k = fy * f.w + fx, q = f.wt[k];
        if (!q) continue;
        sw += q;
        for (let c = 0; c < 4; c++) acc[c] += f.v[k * 4 + c] * q;
      }
      const k = y * nw + x;
      if (sw > 0) for (let c = 0; c < 4; c++) cv[k * 4 + c] = acc[c] / sw;
      cw[k] = Math.min(1, sw);
    }
    lv.push({ v: cv, wt: cw, w: nw, h: nh });
  }
  for (let l = lv.length - 2; l >= 0; l--) {
    const f = lv[l], c = lv[l + 1];
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const k = y * f.w + x, q = f.wt[k];
      if (q >= 1) continue;
      // bilinear from the coarser level
      const cx = Math.min(c.w - 1, Math.max(0, (x - 0.5) / 2)), cy = Math.min(c.h - 1, Math.max(0, (y - 0.5) / 2));
      const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(c.w - 1, x0 + 1), y1 = Math.min(c.h - 1, y0 + 1);
      const fx = cx - x0, fy = cy - y0;
      for (let ch = 0; ch < 4; ch++) {
        const a = c.v[(y0 * c.w + x0) * 4 + ch], b = c.v[(y0 * c.w + x1) * 4 + ch];
        const d = c.v[(y1 * c.w + x0) * 4 + ch], e = c.v[(y1 * c.w + x1) * 4 + ch];
        const up = (a + (b - a) * fx) * (1 - fy) + (d + (e - d) * fx) * fy;
        f.v[k * 4 + ch] = f.v[k * 4 + ch] * q + up * (1 - q);
      }
      f.wt[k] = 1;
    }
  }
}

/**
 * Heal `img` (RGBA, w×h) inside `mask` (0..255 per pixel, same size). Works in the mask's bounding box;
 * returns the changed rectangle or null.
 */
export function healPixels(img: Uint8ClampedArray, w: number, h: number, mask: Uint8Array): { x: number; y: number; w: number; h: number } | null {
  let mx0 = w, my0 = h, mx1 = -1, my1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < mx0) mx0 = x; if (x > mx1) mx1 = x; if (y < my0) my0 = y; if (y > my1) my1 = y; }
  if (mx1 < 0) return null;
  const m = 4;
  const bx = Math.max(0, mx0 - m), by = Math.max(0, my0 - m), bx1 = Math.min(w - 1, mx1 + m), by1 = Math.min(h - 1, my1 + m);
  const bw = bx1 - bx + 1, bh = by1 - by + 1;
  const n = bw * bh;
  const inM = (x: number, y: number) => mask[(by + y) * w + bx + x] > 0;
  // ring of known pixels around the hole (used to choose the source patch)
  const ring: number[] = [];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (inM(x, y)) continue;
    let near = false;
    for (let j = -3; j <= 3 && !near; j++) for (let i = -3; i <= 3; i++) {
      const xx = x + i, yy = y + j;
      if (xx >= 0 && yy >= 0 && xx < bw && yy < bh && inM(xx, yy)) { near = true; break; }
    }
    if (near) ring.push(y * bw + x);
  }
  const px = (x: number, y: number) => ((by + y) * w + bx + x) * 4;
  // candidate source offsets: rings around the hole, several distances and directions
  const S = Math.max(bw, bh);
  let best: { dx: number; dy: number; score: number } | null = null;
  for (const k of [1.15, 1.6, 2.3, 3.2]) {
    const dist = Math.max(6, k * S);
    for (let a = 0; a < 24; a++) {
      const ang = (a / 24) * Math.PI * 2;
      const dx = Math.round(Math.cos(ang) * dist), dy = Math.round(Math.sin(ang) * dist);
      if (bx + dx < 0 || by + dy < 0 || bx1 + dx >= w || by1 + dy >= h) continue;
      // the source must not overlap the painted area
      let bad = false;
      for (let y = 0; y < bh && !bad; y += 2) for (let x = 0; x < bw; x += 2) if (mask[(by + y + dy) * w + bx + x + dx]) { bad = true; break; }
      if (bad) continue;
      let score = 0;
      for (const r of ring) {
        const x = r % bw, y = (r - x) / bw;
        const p = px(x, y), q = ((by + y + dy) * w + bx + x + dx) * 4;
        for (let c = 0; c < 4; c++) { const d = img[p + c] - img[q + c]; score += d * d; }
      }
      score *= 1 + 0.08 * k; // prefer closer patches
      if (!best || score < best.score) best = { dx, dy, score };
    }
  }
  // difference between target and source outside the hole, smoothly filled inside it
  const diff = new Float32Array(n * 4), wt = new Float32Array(n);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const k = y * bw + x;
    if (inM(x, y)) continue;
    const p = px(x, y);
    if (best) { const q = ((by + y + best.dy) * w + bx + x + best.dx) * 4; for (let c = 0; c < 4; c++) diff[k * 4 + c] = img[p + c] - img[q + c]; }
    else for (let c = 0; c < 4; c++) diff[k * 4 + c] = img[p + c];
    wt[k] = 1;
  }
  pullPush(diff, wt, bw, bh);
  const out = img.slice();
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const a = mask[(by + y) * w + bx + x];
    if (!a) continue;
    const k = y * bw + x, p = px(x, y);
    const t = a / 255;
    for (let c = 0; c < 4; c++) {
      const src = best ? img[((by + y + best.dy) * w + bx + x + best.dx) * 4 + c] : 0;
      const healed = src + diff[k * 4 + c];
      out[p + c] = img[p + c] + (healed - img[p + c]) * t;
    }
  }
  img.set(out);
  return { x: bx, y: by, w: bw, h: bh };
}
