import { alphaBounds, createCanvas, ctx2d, Rect } from './util';

export type SelMode = 'new' | 'add' | 'subtract' | 'intersect';

/**
 * Immutable selection. The mask is a document-sized canvas whose alpha channel holds
 * the selection strength (white pixels).
 */
export class Selection {
  readonly mask: HTMLCanvasElement;
  readonly bounds: Rect;
  private _contours: Int32Array[] | null = null;
  private _alpha: Uint8Array | null = null;
  private _rle: Uint32Array | null = null;

  private constructor(mask: HTMLCanvasElement, bounds: Rect) {
    this.mask = mask;
    this.bounds = bounds;
  }

  get width() { return this.mask.width; }
  get height() { return this.mask.height; }

  /** Wraps a mask canvas; returns null when empty. The canvas must not be modified afterwards. */
  static fromMask(mask: HTMLCanvasElement): Selection | null {
    const b = alphaBounds(mask, 0);
    return b ? new Selection(mask, b) : null;
  }

  static fromDraw(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): Selection | null {
    const c = createCanvas(w, h);
    const g = ctx2d(c);
    g.fillStyle = '#fff';
    g.strokeStyle = '#fff';
    draw(g);
    return Selection.fromMask(c);
  }

  static all(w: number, h: number): Selection {
    const c = createCanvas(w, h);
    const g = ctx2d(c); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    return new Selection(c, { x: 0, y: 0, w, h });
  }

  /**
   * A selection from per-pixel strengths (the array is kept as the selection's alpha: it must not change
   * afterwards). `box`: where the strengths can be non-zero (a fill's area) — only that part is scanned and
   * drawn, and the bounds are found from the array instead of reading the mask canvas back.
   */
  static fromAlphaArray(alpha: Uint8Array, w: number, h: number, box?: { x0: number; y0: number; x1: number; y1: number }): Selection | null {
    const bx0 = box?.x0 ?? 0, by0 = box?.y0 ?? 0, bx1 = box?.x1 ?? w, by1 = box?.y1 ?? h;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = by0; y < by1; y++) {
      const row = y * w;
      for (let x = bx0; x < bx1; x++) {
        if (!alpha[row + x]) continue;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; maxY = y;
      }
    }
    if (maxX < 0) return null;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const c = createCanvas(w, h);
    const g = ctx2d(c);
    const img = g.createImageData(bw, bh);
    const d = img.data;
    for (let y = 0, j = 0; y < bh; y++) {
      const row = (minY + y) * w + minX;
      for (let x = 0; x < bw; x++, j += 4) {
        const a = alpha[row + x];
        if (a) { d[j] = d[j + 1] = d[j + 2] = 255; d[j + 3] = a; }
      }
    }
    g.putImageData(img, minX, minY);
    const s = new Selection(c, { x: minX, y: minY, w: bw, h: bh });
    s._alpha = alpha;
    return s;
  }

  /** Combine current selection with a new shape mask according to the mode. */
  static combine(cur: Selection | null, shape: Selection | null, mode: SelMode, w: number, h: number): Selection | null {
    if (mode === 'new' || !cur) {
      if (mode === 'subtract' || mode === 'intersect') return mode === 'subtract' ? cur : null;
      return shape;
    }
    if (!shape) return mode === 'add' || mode === 'subtract' ? cur : null;
    const c = createCanvas(w, h);
    const g = ctx2d(c);
    g.drawImage(cur.mask, 0, 0);
    g.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'subtract' ? 'destination-out' : 'destination-in';
    g.drawImage(shape.mask, 0, 0);
    return Selection.fromMask(c);
  }

  alpha(): Uint8Array {
    if (!this._alpha) {
      const d = ctx2d(this.mask).getImageData(0, 0, this.width, this.height).data;
      const a = new Uint8Array(this.width * this.height);
      for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j];
      this._alpha = a;
    }
    return this._alpha;
  }

  /** Run-length encoding for compact history storage: pairs [value, count]. */
  rle(): Uint32Array {
    if (!this._rle) {
      const a = this.alpha();
      const out: number[] = [];
      let v = a[0], n = 0;
      for (let i = 0; i < a.length; i++) {
        if (a[i] === v) n++;
        else { out.push(v, n); v = a[i]; n = 1; }
      }
      out.push(v, n);
      this._rle = Uint32Array.from(out);
    }
    return this._rle;
  }

  static fromRle(rle: Uint32Array, w: number, h: number): Selection | null {
    const a = new Uint8Array(w * h);
    let p = 0;
    for (let i = 0; i < rle.length; i += 2) {
      const v = rle[i], n = rle[i + 1];
      if (v) a.fill(v, p, p + n);
      p += n;
    }
    const s = Selection.fromAlphaArray(a, w, h);
    if (s) { s._rle = rle; s._alpha = a; }
    return s;
  }

  invert(): Selection | null {
    const c = createCanvas(this.width, this.height);
    const g = ctx2d(c);
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(this.mask, 0, 0);
    return Selection.fromMask(c);
  }

  feather(radius: number): Selection | null {
    if (radius <= 0) return this;
    const c = createCanvas(this.width, this.height);
    const g = ctx2d(c);
    g.filter = `blur(${radius / 2}px)`;
    g.drawImage(this.mask, 0, 0);
    return Selection.fromMask(c);
  }

  /** Grow (r > 0) or shrink (r < 0) by r pixels using a euclidean distance transform. */
  grow(r: number): Selection | null {
    if (!r) return this;
    const w = this.width, h = this.height;
    const a = this.alpha();
    const inside = new Uint8Array(w * h);
    for (let i = 0; i < a.length; i++) inside[i] = a[i] >= 128 ? 1 : 0;
    const out = new Uint8Array(w * h);
    if (r > 0) {
      const d = distanceTransform(inside, w, h); // distance to nearest selected pixel
      for (let i = 0; i < out.length; i++) {
        const v = r + 0.5 - d[i];
        out[i] = v >= 1 ? 255 : v <= 0 ? 0 : Math.round(v * 255);
      }
    } else {
      const rr = -r;
      for (let i = 0; i < inside.length; i++) inside[i] = inside[i] ? 0 : 1;
      const d = distanceTransform(inside, w, h); // distance to nearest unselected pixel
      for (let i = 0; i < out.length; i++) {
        const v = d[i] - rr + 0.5;
        out[i] = v >= 1 ? 255 : v <= 0 ? 0 : Math.round(v * 255);
      }
    }
    return Selection.fromAlphaArray(out, w, h);
  }

  /** Smooth jagged edges: small blur + contrast. */
  smooth(radius: number): Selection | null {
    if (radius <= 0) return this;
    const blurred = this.feather(radius * 2);
    if (!blurred) return null;
    const a = blurred.alpha().slice();
    for (let i = 0; i < a.length; i++) a[i] = a[i] >= 128 ? 255 : 0;
    return Selection.fromAlphaArray(a, this.width, this.height);
  }

  /**
   * Closed contours along the selection edge (threshold 50%), as flat [x0,y0,x1,y1,...] arrays of pixel-corner
   * coordinates. Continuous loops let the marching ants flow around the perimeter like in Photoshop.
   */
  get contours(): Int32Array[] {
    if (this._contours) return this._contours;
    const w = this.width, h = this.height;
    const a = this.alpha();
    const b = this.bounds;
    // Pixel-corner grid of the bounding box. Each corner has at most two outgoing edges (two only where two
    // selected pixels touch diagonally): the first in a typed array, the rare second one in a small map.
    // A Map of arrays for every corner took tens of seconds for a speckled selection (millions of islands).
    const BW = b.w + 1, BH = b.h + 1;
    const next = new Int32Array(BW * BH).fill(-1);
    const extra = new Map<number, number>();
    const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && a[y * w + x] >= 128;
    const V = (x: number, y: number) => (y - b.y) * BW + (x - b.x);
    const add = (v0: number, v1: number) => { if (next[v0] < 0) next[v0] = v1; else extra.set(v0, v1); };
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        if (!on(x, y)) continue;
        if (!on(x, y - 1)) add(V(x, y), V(x + 1, y));
        if (!on(x + 1, y)) add(V(x + 1, y), V(x + 1, y + 1));
        if (!on(x, y + 1)) add(V(x + 1, y + 1), V(x, y + 1));
        if (!on(x - 1, y)) add(V(x, y + 1), V(x, y));
      }
    }
    const take = (v: number) => {
      const e = extra.get(v);
      if (e !== undefined) { extra.delete(v); return e; }
      const n = next[v];
      if (n >= 0) next[v] = -1;
      return n;
    };
    const loops: Int32Array[] = [];
    const pts: number[] = [];
    for (let start = 0; start < next.length; start++) {
      while (next[start] >= 0 || extra.has(start)) {
        pts.length = 0;
        let cur = start, pdx = 0, pdy = 0;
        for (let guard = 0; guard < 1e8; guard++) {
          const v = take(cur);
          if (v < 0) break;
          const cx = cur % BW, cy = (cur - cx) / BW;
          const vx = v % BW, vy = (v - vx) / BW;
          const dx = vx - cx, dy = vy - cy;
          if (dx !== pdx || dy !== pdy) pts.push(cx + b.x, cy + b.y); // keep only corners
          pdx = dx; pdy = dy;
          cur = v;
          if (cur === start) break;
        }
        if (pts.length >= 6) loops.push(Int32Array.from(pts));
      }
    }
    this._contours = loops;
    this._contourPoints = loops.reduce((n, l) => n + l.length / 2, 0);
    return loops;
  }

  /**
   * Rough length of the selection edge (edge crossings on every 4th row, × 4): a speckled magic-wand
   * selection has hundreds of thousands, a rectangle or a lasso shape a few thousand at most. Cheap to get.
   */
  get complexity(): number {
    if (this._complexity >= 0) return this._complexity;
    const a = this.alpha(), w = this.width, b = this.bounds;
    let n = 0;
    for (let y = b.y; y < b.y + b.h; y += 4) {
      let prev = false;
      for (let x = b.x, i = y * w + b.x; x < b.x + b.w; x++, i++) { const on = a[i] >= 128; if (on !== prev) { n++; prev = on; } }
    }
    return (this._complexity = n * 4);
  }
  private _complexity = -1;

  /** Number of corner points of all contours (a measure of how costly the marching ants are to draw). */
  get contourPoints(): number { void this.contours; return this._contourPoints; }
  private _contourPoints = 0;

}

/* ---------- Euclidean distance transform (Felzenszwalb & Huttenlocher) ---------- */
const INF = 1e20;
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** For each pixel: distance to the nearest pixel where src = 1. */
export function distanceTransform(src: Uint8Array, w: number, h: number): Float32Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < src.length; i++) grid[i] = src[i] ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}
