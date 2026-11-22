import { createCanvas, ctx2d, Rect } from './util';

export interface P { x: number; y: number }
export type Quad = [P, P, P, P]; // TL, TR, BR, BL

/** 3x3 homography as 8 coefficients (h8 = 1). */
export type H = number[];

/** Homography mapping src[i] -> dst[i]. */
export function homography(src: P[], dst: P[]): H {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return solve(A, b);
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let i = 0; i < n; i++) A[i].push(b[i]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const div = A[c][c] || 1e-12;
    for (let k = c; k <= n; k++) A[c][k] /= div;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (f) for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map(row => row[n]);
}

export function applyH(h: H, x: number, y: number): P {
  const w = h[6] * x + h[7] * y + 1;
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

export function rectQuad(r: Rect): Quad {
  return [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
}

export function quadBounds(q: P[]): Rect {
  const x0 = Math.floor(Math.min(...q.map(p => p.x))), y0 = Math.floor(Math.min(...q.map(p => p.y)));
  const x1 = Math.ceil(Math.max(...q.map(p => p.x))), y1 = Math.ceil(Math.max(...q.map(p => p.y)));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

export function pointInPoly(p: P, q: P[]): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i], b = q[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Is the quad a parallelogram (affine image of a rectangle)? */
export function isParallelogram(q: Quad, eps = 0.01): boolean {
  return Math.abs(q[0].x + q[2].x - q[1].x - q[3].x) < eps && Math.abs(q[0].y + q[2].y - q[1].y - q[3].y) < eps;
}

/**
 * Projective warp. `src` lives at (sx, sy) in document space; `inv` maps document destination
 * points to document source points. Returns a canvas covering `dst` (document rect).
 * Bilinear sampling with premultiplied alpha.
 */
export function warp(src: HTMLCanvasElement, sx: number, sy: number, inv: H, dst: Rect): HTMLCanvasElement {
  const sw = src.width, shh = src.height;
  const sd = ctx2d(src).getImageData(0, 0, sw, shh).data;
  const out = createCanvas(dst.w, dst.h);
  const og = ctx2d(out);
  const img = og.createImageData(dst.w, dst.h);
  const od = img.data;
  for (let j = 0; j < dst.h; j++) {
    const Y = dst.y + j + 0.5;
    for (let i = 0; i < dst.w; i++) {
      const X = dst.x + i + 0.5;
      const w = inv[6] * X + inv[7] * Y + 1;
      const u = (inv[0] * X + inv[1] * Y + inv[2]) / w - sx - 0.5;
      const v = (inv[3] * X + inv[4] * Y + inv[5]) / w - sy - 0.5;
      if (u < -1 || v < -1 || u > sw || v > shh) continue;
      const x0 = Math.floor(u), y0 = Math.floor(v);
      const fx = u - x0, fy = v - y0;
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < 4; k++) {
        const xx = x0 + (k & 1), yy = y0 + (k >> 1);
        if (xx < 0 || yy < 0 || xx >= sw || yy >= shh) continue;
        const wgt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy);
        const p = (yy * sw + xx) * 4;
        const aw = sd[p + 3] * wgt;
        r += sd[p] * aw; g += sd[p + 1] * aw; b += sd[p + 2] * aw; a += aw;
      }
      if (a <= 0) continue;
      const o = (j * dst.w + i) * 4;
      od[o] = r / a; od[o + 1] = g / a; od[o + 2] = b / a; od[o + 3] = a;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}

/** Draw `img` (placed at sx,sy in doc space) warped by homography `h` (doc→doc) using a triangle mesh. Fast preview. */
export function drawMesh(g: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, sx: number, sy: number, h: H, n = 12) {
  const W = img.width, Hh = img.height;
  const pt = (i: number, j: number) => {
    const u = (i / n) * W, v = (j / n) * Hh;
    return { s: { x: u, y: v }, d: applyH(h, sx + u, sy + v) };
  };
  const grid: { s: P; d: P }[][] = [];
  for (let j = 0; j <= n; j++) { grid.push([]); for (let i = 0; i <= n; i++) grid[j].push(pt(i, j)); }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i + 1], d = grid[j + 1][i];
    tri(g, img, a, b, c);
    tri(g, img, a, c, d);
  }
}

function tri(g: CanvasRenderingContext2D, img: CanvasImageSource, a: { s: P; d: P }, b: { s: P; d: P }, c: { s: P; d: P }) {
  // affine transform mapping source triangle to destination triangle
  const { x: x0, y: y0 } = a.s, { x: x1, y: y1 } = b.s, { x: x2, y: y2 } = c.s;
  const { x: u0, y: v0 } = a.d, { x: u1, y: v1 } = b.d, { x: u2, y: v2 } = c.d;
  const den = x0 * (y2 - y1) - x1 * y2 + x2 * y1 + (x1 - x2) * y0;
  if (!den) return;
  const m11 = -(y0 * (u2 - u1) - y1 * u2 + y2 * u1 + (y1 - y2) * u0) / den;
  const m12 = (y1 * v2 + y0 * (v1 - v2) - y2 * v1 + (y2 - y1) * v0) / den;
  const m21 = (x0 * (u2 - u1) - x1 * u2 + x2 * u1 + (x1 - x2) * u0) / den;
  const m22 = -(x1 * v2 + x0 * (v1 - v2) - x2 * v1 + (x2 - x1) * v0) / den;
  const dx = (x0 * (y2 * u1 - y1 * u2) + y0 * (x1 * u2 - x2 * u1) + (x2 * y1 - x1 * y2) * u0) / den;
  const dy = (x0 * (y2 * v1 - y1 * v2) + y0 * (x1 * v2 - x2 * v1) + (x2 * y1 - x1 * y2) * v0) / den;
  // slightly expanded clip to hide seams
  const cx = (u0 + u1 + u2) / 3, cy = (v0 + v1 + v2) / 3;
  const ex = (u: number, v: number): [number, number] => { const l = Math.hypot(u - cx, v - cy) || 1; return [u + (u - cx) / l * 0.6, v + (v - cy) / l * 0.6]; };
  g.save();
  g.beginPath();
  g.moveTo(...ex(u0, v0)); g.lineTo(...ex(u1, v1)); g.lineTo(...ex(u2, v2));
  g.closePath();
  g.clip();
  g.transform(m11, m12, m21, m22, dx, dy);
  g.drawImage(img, 0, 0);
  g.restore();
}
