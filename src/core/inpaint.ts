/**
 * Content-aware fill: an area is rebuilt from small pieces (7×7 patches) of the rest of the picture, chosen so
 * that the texture and the structure around it carry on into it without seams.
 *
 * The method is PatchMatch (Barnes et al. 2009) in the multi-scale scheme of Wexler et al. (2007). On a pyramid of
 * the picture, from the coarsest level up, every patch that touches the area finds its most similar patch outside
 * it (random search, and the matches of its neighbours shifted by one), and every pixel of the area becomes the
 * weighted average of what the overlapping patches put there; a few rounds per level. The coarsest level settles
 * the layout (its first guess is grown from the edge of the area inwards), the finer ones the detail; at full
 * size each pixel is copied from its own patch's match, so the grain of the picture stays.
 *
 * Areas far apart are filled one by one, each from its own neighbourhood. A neighbourhood too large to search at
 * full size is searched at a reduced size, and the result is copied up with the offsets found there: the pixels
 * still come from the full-size picture, so the texture stays sharp.
 *
 * Pure computation (no DOM), so it can run in a worker (core/inpaintworker.ts). The same input always gives the
 * same result (a fixed random seed).
 */

/** patch radius: 7 × 7 patches */
const PR = 3;
const PATCH = 2 * PR + 1;
const PATCH_N = PATCH * PATCH;
/** the largest level searched, in pixels of the neighbourhood (memory and time) */
const SEARCH_BUDGET = 4_000_000;
/** the least context around an area, in pixels */
const MIN_MARGIN = 48;
/**
 * An area at the edge of the picture (what a crop adds around it) goes at most this many levels below the one
 * searched. Deeper, a patch is so large in the picture's pixels that the ones next to the edge no longer fit:
 * a sky darkening towards the top was then carried on from its lighter part below, with a step at the old edge.
 */
const EDGE_LEVELS = 3;
/**
 * The random search on the finer levels stays this close to the match brought up from the coarser one (the
 * coarser level has found where to take from; far tries there hardly ever win, and they took a third of the time).
 */
const FINE_RADIUS = 32;

export type Progress = (p: number) => void;

interface Box { x: number; y: number; w: number; h: number; n: number }
/** What the matches put at pixel q (RGBA into out); false when no patch covers it. */
type Predictor = (q: number, out: Float32Array) => boolean;

interface Level {
  w: number; h: number;
  /** RGBA; the area's pixels hold the current estimate */
  img: Uint8ClampedArray;
  /** 0 known, 1 to fill, 2 unknown but not this area's (another area, filled later): never used */
  mask: Uint8Array;
  holeN: number;
  // search data, on the levels that are searched
  /** 1 where a patch centred there lies inside the level and is all known (a possible source) */
  valid?: Uint8Array;
  validList?: Int32Array;
  /** target patches: the centres of the patches that touch the area, in raster order */
  T?: Int32Array;
  /** pixel → index into T, or -1 */
  map?: Int32Array;
  /** per target: the centre of its source patch (pixel index) */
  nnf?: Int32Array;
  /** per target: the distance to its source patch */
  dist?: Float64Array;
  /** per target: how many of its pixels are counted (inside the level and not «2») */
  cnt?: Uint8Array;
  /** per target: its weight in the vote */
  wt?: Float32Array;
}

/**
 * Fill the pixels where hole > 0, in place (`hole` is cleared as areas are done). Returns false when an area had
 * nothing to take its fill from (almost the whole picture selected); the other areas are still filled.
 */
export function contentAwareFill(img: Uint8ClampedArray, w: number, h: number, hole: Uint8Array, onProgress?: Progress): boolean {
  const boxes = holeClusters(hole, w, h);
  const total = boxes.reduce((s, b) => s + b.n, 0) || 1;
  let done = 0, ok = true;
  for (const b of boxes) {
    // context around the area: about its size, less for long thin areas (a wire across the sky)
    const m = Math.max(MIN_MARGIN, Math.min(Math.max(b.w, b.h), 3 * Math.min(b.w, b.h)));
    const x0 = Math.max(0, b.x - m), y0 = Math.max(0, b.y - m);
    const x1 = Math.min(w, b.x + b.w + m), y1 = Math.min(h, b.y + b.h + m);
    const rw = x1 - x0, rh = y1 - y0;
    const sub = new Uint8ClampedArray(rw * rh * 4);
    const mask = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      const row = (y0 + y) * w + x0;
      sub.set(img.subarray(row * 4, (row + rw) * 4), y * rw * 4);
      const inY = y0 + y >= b.y && y0 + y < b.y + b.h;
      for (let x = 0; x < rw; x++) {
        if (!hole[row + x]) continue;
        const gx = x0 + x;
        mask[y * rw + x] = inY && gx >= b.x && gx < b.x + b.w ? 1 : 2;
      }
    }
    const share = b.n / total;
    const base = done;
    const atEdge = b.x === 0 || b.y === 0 || b.x + b.w === w || b.y + b.h === h;
    const filled = new Region(sub, rw, rh, mask, atEdge, p => onProgress?.(base + p * share)).run();
    if (!filled) ok = false;
    else {
      for (let y = 0; y < rh; y++) {
        const row = (y0 + y) * w + x0;
        for (let x = 0; x < rw; x++) {
          const i = y * rw + x;
          if (mask[i] !== 1) continue;
          const gi = (row + x) * 4, si = i * 4;
          img[gi] = sub[si]; img[gi + 1] = sub[si + 1]; img[gi + 2] = sub[si + 2]; img[gi + 3] = sub[si + 3];
          hole[row + x] = 0;
        }
      }
    }
    done += share;
    onProgress?.(done);
  }
  return ok;
}

/**
 * The areas to fill: bounding boxes of the connected parts of the hole (8-connected, scanline flood fill), with
 * parts close to each other merged (they share patches).
 */
function holeClusters(hole: Uint8Array, w: number, h: number): Box[] {
  const seen = new Uint8Array(w * h);
  const boxes: Box[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!hole[i] || seen[i]) continue;
    let minX = w, minY = h, maxX = -1, maxY = -1, n = 0;
    stack.push(i);
    while (stack.length) {
      const s = stack.pop()!;
      if (seen[s]) continue;
      const y = (s / w) | 0, row = y * w;
      let lx = s - row, rx = lx;
      while (lx > 0 && hole[row + lx - 1] && !seen[row + lx - 1]) lx--;
      while (rx < w - 1 && hole[row + rx + 1] && !seen[row + rx + 1]) rx++;
      for (let x = lx; x <= rx; x++) seen[row + x] = 1;
      n += rx - lx + 1;
      if (lx < minX) minX = lx;
      if (rx > maxX) maxX = rx;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      // the rows above and below, one pixel wider (diagonal neighbours)
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= h) continue;
        const nrow = ny * w;
        let inRun = false;
        for (let x = Math.max(0, lx - 1); x <= Math.min(w - 1, rx + 1); x++) {
          const on = !!hole[nrow + x] && !seen[nrow + x];
          if (on && !inRun) stack.push(nrow + x);
          inRun = on;
        }
      }
    }
    boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, n });
  }
  // a selection of many specks (Magic Wand on noise): one area
  if (boxes.length > 400) {
    const u = boxes.reduce((a, b) => union(a, b));
    return [u];
  }
  const gap = 2 * PATCH;
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.x - gap < b.x + b.w && b.x - gap < a.x + a.w && a.y - gap < b.y + b.h && b.y - gap < a.y + a.h) {
          boxes[i] = union(a, b); boxes.splice(j, 1); merged = true; break;
        }
      }
    }
  }
  return boxes;
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y, n: a.n + b.n };
}

/** One area with its neighbourhood. */
class Region {
  private levels: Level[] = [];
  private seed = 0x9e3779b9;
  private done = 0;
  private total = 1;

  constructor(img: Uint8ClampedArray, w: number, h: number, mask: Uint8Array, private atEdge: boolean, private progress: Progress) {
    let holeN = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] === 1) holeN++;
    this.levels.push({ w, h, img, mask: new Uint8Array(mask), holeN });
  }

  /** xorshift32 in [0, 1) */
  private rnd(): number {
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  run(): boolean {
    const lv = this.levels;
    if (!lv[0].holeN) return true;
    // down to the size that can be searched
    while (lv[lv.length - 1].w * lv[lv.length - 1].h > SEARCH_BUDGET) lv.push(downsample(lv[lv.length - 1]));
    const ls = lv.length - 1;
    // then on until a patch reaches across the area from its edge to its middle
    const md = maxHoleDistance(lv[ls]);
    if (md === Infinity) return false;
    for (let k = 1; md / 2 ** k > PR - 1 && (!this.atEdge || k <= EDGE_LEVELS); k++) {
      const c = lv[lv.length - 1];
      if (Math.min(Math.ceil(c.w / 2), Math.ceil(c.h / 2)) < 3 * PATCH) break;
      lv.push(downsample(c));
    }
    // the coarsest level must have somewhere to take patches from
    let L = lv.length - 1;
    for (; L >= ls; L--) {
      prepare(lv[L]);
      if (lv[L].validList!.length) break;
    }
    if (L < ls) return false;
    lv.length = L + 1;
    // the work: target patches × passes (votes count as passes)
    this.total = 0;
    for (let l = L; l >= ls; l--) this.total += lv[l].holeN * 1.6 * this.passes(l, L);
    this.total = Math.max(1, this.total);

    for (let l = L; l >= ls; l--) {
      const c = lv[l];
      if (l !== L) prepare(c);
      const units = c.holeN * 1.6;
      if (l === L) {
        this.randomNnf(c);
        this.onionFill(c); this.step(units * 3);
      } else {
        this.upsampleNnf(lv[l + 1], c);
        this.vote(c, true); this.step(units);
        // the coarser level is no longer needed (except the one the result is copied up from)
        if (l + 1 !== ls) freeSearch(lv[l + 1]);
      }
      const em = this.emRounds(l, L);
      for (let r = 0; r < em; r++) {
        this.computeDist(c);
        for (let i = 0; i < 2; i++) { this.pass(c, ((r + i) & 1) === 1, l === L ? Infinity : FINE_RADIUS); this.step(units); }
        this.weights(c);
        this.vote(c, false); this.step(units);
      }
    }
    // the full-size area from the matches
    const f = lv[0], out = new Float32Array(4);
    const predict = ls > 0 ? this.upPredictor(lv[ls], f, 2 ** ls) : this.finePredictor(f);
    for (let q = 0; q < f.w * f.h; q++) {
      if (f.mask[q] !== 1 || !predict(q, out)) continue;
      const o = q * 4;
      f.img[o] = out[0]; f.img[o + 1] = out[1]; f.img[o + 2] = out[2]; f.img[o + 3] = out[3];
    }
    return true;
  }

  /**
   * Full size searched: the patches over a pixel, weighted by how well they matched and, steeply, by how near
   * their centre the pixel is. Where neighbouring matches agree it is an exact copy (the grain stays: an even
   * average of the 49 patches over a pixel loses about 15 % of the fine detail); where they change, the seam
   * is blended over two or three pixels instead of a hard edge.
   */
  private finePredictor(c: Level): Predictor {
    const { w, h, img } = c, map = c.map!, nnf = c.nnf!, wt = c.wt;
    const sw = new Float32Array(PATCH_N);
    for (let dy = -PR; dy <= PR; dy++) for (let dx = -PR; dx <= PR; dx++) sw[(dy + PR) * PATCH + dx + PR] = Math.exp(-(dx * dx + dy * dy) / 2);
    return (q, out) => {
      const qx = q % w, qy = (q - qx) / w;
      let r = 0, g = 0, b = 0, a = 0, s = 0;
      for (let dy = -PR; dy <= PR; dy++) {
        const py = qy - dy;
        if (py < 0 || py >= h) continue;
        for (let dx = -PR; dx <= PR; dx++) {
          const px = qx - dx;
          if (px < 0 || px >= w) continue;
          const t = map[py * w + px];
          if (t < 0) continue;
          const k = sw[(dy + PR) * PATCH + dx + PR] * (wt ? wt[t] : 1);
          const si = (nnf[t] + dy * w + dx) * 4;
          r += img[si] * k; g += img[si + 1] * k; b += img[si + 2] * k; a += img[si + 3] * k; s += k;
        }
      }
      if (!s) return false;
      out[0] = r / s; out[1] = g / s; out[2] = b / s; out[3] = a / s;
      return true;
    };
  }

  private emRounds(l: number, L: number) { return l === L ? 6 : L - l <= 2 ? 3 : 2; }
  private passes(l: number, L: number) { return (l === L ? 3 : 1) + this.emRounds(l, L) * 3; }
  private step(units: number) { this.done += units; this.progress(Math.min(1, this.done / this.total)); }

  private randomNnf(c: Level) {
    const n = c.T!.length, vl = c.validList!;
    c.nnf = new Int32Array(n);
    c.dist = new Float64Array(n);
    for (let t = 0; t < n; t++) c.nnf[t] = vl[(this.rnd() * vl.length) | 0];
  }

  /** The matches found on the coarser level, doubled, as the start on this one. */
  private upsampleNnf(cs: Level, c: Level) {
    const T = c.T!, n = T.length, w = c.w, valid = c.valid!, vl = c.validList!;
    const nnf = new Int32Array(n);
    for (let t = 0; t < n; t++) {
      const p = T[t], px = p % w, py = (p - px) / w;
      const qx = Math.min(cs.w - 1, px >> 1), qy = Math.min(cs.h - 1, py >> 1);
      const tq = cs.map![qy * cs.w + qx];
      let s = -1;
      if (tq >= 0) {
        const sc = cs.nnf![tq], scx = sc % cs.w, scy = (sc - scx) / cs.w;
        const sx = 2 * scx + (px - 2 * qx), sy = 2 * scy + (py - 2 * qy);
        if (sx >= 0 && sx < w && sy >= 0 && sy < c.h && valid[sy * w + sx]) s = sy * w + sx;
        else {
          // next to the edge of what is known: the nearest possible source around it
          for (let r = 1; r <= 2 && s < 0; r++) {
            for (let dy = -r; dy <= r && s < 0; dy++) for (let dx = -r; dx <= r; dx++) {
              const x = sx + dx, y = sy + dy;
              if (x >= 0 && x < w && y >= 0 && y < c.h && valid[y * w + x]) { s = y * w + x; break; }
            }
          }
        }
      }
      nnf[t] = s >= 0 ? s : vl[(this.rnd() * vl.length) | 0];
    }
    c.nnf = nnf;
    c.dist = new Float64Array(n);
  }

  /**
   * The first guess on the coarsest level, from the edge of the area inwards (onion peel). A pixel at a time, in
   * order of its distance from the known pixels, its patch is matched on the pixels known or already filled
   * (the matches of its filled neighbours shifted to it, random tries over the level, then windows halving
   * around the best), and it takes the centre of the best source. The area can be thick there (at the edge of
   * the picture the pyramid stops early); deep inside it a patch would otherwise have nothing to match on and
   * pick at random: grass next to a sky, a sky next to grass.
   */
  private onionFill(c: Level) {
    const { w, h, img, mask } = c;
    const map = c.map!, nnf = c.nnf!, valid = c.valid!, vl = c.validList!, N = w * h;
    const d = holeDistances(c);
    const known = new Uint8Array(N);
    let maxD = 0;
    for (let q = 0; q < N; q++) {
      if (mask[q] === 0) known[q] = 1;
      else if (mask[q] === 1 && d[q] > maxD) maxD = d[q];
    }
    // the area's pixels by distance (counting sort)
    const start = new Int32Array(maxD + 2);
    for (let q = 0; q < N; q++) if (mask[q] === 1) start[d[q] + 1]++;
    for (let k = 1; k <= maxD + 1; k++) start[k] += start[k - 1];
    const order = new Int32Array(start[maxD + 1]), fillAt = start.slice();
    for (let q = 0; q < N; q++) if (mask[q] === 1) order[fillAt[d[q]]++] = q;
    // the distance over the target pixels known or filled so far
    const D = (p: number, s: number, limit: number) => {
      const px = p % w, py = (p - px) / w;
      let e = 0;
      for (let dy = -PR; dy <= PR; dy++) {
        const ty = py + dy;
        if (ty < 0 || ty >= h) continue;
        for (let dx = -PR; dx <= PR; dx++) {
          const tx = px + dx;
          if (tx < 0 || tx >= w) continue;
          const ti = ty * w + tx;
          if (!known[ti]) continue;
          const a = ti * 4, b = (s + dy * w + dx) * 4;
          const e0 = img[a] - img[b], e1 = img[a + 1] - img[b + 1], e2 = img[a + 2] - img[b + 2], e3 = img[a + 3] - img[b + 3];
          e += e0 * e0 + e1 * e1 + e2 * e2 + e3 * e3;
        }
        if (e >= limit) return e;
      }
      return e;
    };
    const maxR = Math.max(w, h);
    for (const p of order) {
      const t = map[p];
      let bs = nnf[t], bd = D(p, bs, Infinity);
      const tryS = (s: number) => {
        if (s === bs || s < 0 || s >= N || !valid[s]) return;
        const e = D(p, s, bd);
        if (e < bd) { bd = e; bs = s; }
      };
      // filled neighbours: their match, shifted by the step to this pixel
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const n = p + dy * w + dx;
        if ((dx || dy) && n >= 0 && n < N && mask[n] === 1 && known[n] && Math.abs((n % w) - (p % w)) <= 1) tryS(nnf[map[n]] - dy * w - dx);
      }
      for (let i = 0; i < 16; i++) tryS(vl[(this.rnd() * vl.length) | 0]);
      for (let R = maxR; R >= 1; R >>= 1) {
        const bx = bs % w, by = (bs - bx) / w;
        const x0 = Math.max(PR, bx - R), x1 = Math.min(w - 1 - PR, bx + R);
        const y0 = Math.max(PR, by - R), y1 = Math.min(h - 1 - PR, by + R);
        if (x1 < x0 || y1 < y0) break;
        tryS((y0 + ((this.rnd() * (y1 - y0 + 1)) | 0)) * w + x0 + ((this.rnd() * (x1 - x0 + 1)) | 0));
      }
      nnf[t] = bs;
      const o = p * 4, so = bs * 4;
      img[o] = img[so]; img[o + 1] = img[so + 1]; img[o + 2] = img[so + 2]; img[o + 3] = img[so + 3];
      known[p] = 1;
    }
  }

  private computeDist(c: Level) {
    const T = c.T!, nnf = c.nnf!, dist = c.dist!;
    const D = distFn(c);
    for (let t = 0; t < T.length; t++) dist[t] = D(t, T[t], nnf[t], Infinity);
  }

  /**
   * One PatchMatch pass over the targets: propagation from the neighbour before, then random search in windows
   * halving from `maxRadius` (the whole level by default).
   */
  private pass(c: Level, reverse: boolean, maxRadius = Infinity) {
    const { w, h } = c;
    const T = c.T!, map = c.map!, nnf = c.nnf!, dist = c.dist!, valid = c.valid!;
    const n = T.length, dir = reverse ? -1 : 1, N = w * h;
    const D = distFn(c);
    const maxR = Math.min(maxRadius, Math.max(w, h));
    for (let k = 0; k < n; k++) {
      const t = reverse ? n - 1 - k : k;
      const p = T[t];
      const px = p % w, py = (p - px) / w;
      let bs = nnf[t], bd = dist[t];
      const tryS = (s: number) => {
        const d = D(t, p, s, bd);
        if (d < bd) { bd = d; bs = s; }
      };
      // the neighbour before this one in the scan, horizontally and vertically: its match, one step on
      if (px - dir >= 0 && px - dir < w) {
        const tq = map[p - dir];
        if (tq >= 0) {
          const s = nnf[tq] + dir;
          if (s !== bs && s >= 0 && s < N && valid[s]) tryS(s);
        }
      }
      if (py - dir >= 0 && py - dir < h) {
        const tq = map[p - dir * w];
        if (tq >= 0) {
          const s = nnf[tq] + dir * w;
          if (s !== bs && s >= 0 && s < N && valid[s]) tryS(s);
        }
      }
      // random search in windows halving around the best so far
      for (let R = maxR; R >= 1; R >>= 1) {
        const bx = bs % w, by = (bs - bx) / w;
        const x0 = Math.max(PR, bx - R), x1 = Math.min(w - 1 - PR, bx + R);
        const y0 = Math.max(PR, by - R), y1 = Math.min(h - 1 - PR, by + R);
        if (x1 < x0 || y1 < y0) break;
        const s = (y0 + ((this.rnd() * (y1 - y0 + 1)) | 0)) * w + x0 + ((this.rnd() * (x1 - x0 + 1)) | 0);
        if (s === bs || !valid[s]) continue;
        tryS(s);
      }
      nnf[t] = bs; dist[t] = bd;
    }
  }

  /** Vote weights from how well each target matched (Wexler et al.: exp(−d / 2σ²), σ² the 75th percentile). */
  private weights(c: Level) {
    const n = c.T!.length, dist = c.dist!, cnt = c.cnt!;
    const wt = (c.wt ??= new Float32Array(n));
    const step = Math.max(1, Math.floor(n / 4000));
    const sample: number[] = [];
    for (let t = 0; t < n; t += step) sample.push(dist[t] / cnt[t]);
    sample.sort((a, b) => a - b);
    const s2 = sample[Math.floor(sample.length * 0.75)] || 1;
    for (let t = 0; t < n; t++) wt[t] = Math.exp(-(dist[t] / cnt[t]) / (2 * s2)) + 1e-6;
  }

  /** Every pixel of the area: the weighted average of what the patches over it bring there. */
  private vote(c: Level, uniform: boolean) {
    const { w, h, img, mask } = c;
    const map = c.map!, nnf = c.nnf!, wt = c.wt;
    for (let q = 0; q < w * h; q++) {
      if (mask[q] !== 1) continue;
      const qx = q % w, qy = (q - qx) / w;
      let r = 0, g = 0, b = 0, a = 0, sw = 0;
      for (let dy = -PR; dy <= PR; dy++) {
        const py = qy - dy;
        if (py < 0 || py >= h) continue;
        for (let dx = -PR; dx <= PR; dx++) {
          const px = qx - dx;
          if (px < 0 || px >= w) continue;
          const t = map[py * w + px];
          if (t < 0) continue;
          const k = uniform || !wt ? 1 : wt[t];
          // the pixel of its source patch that lands on q (sources are known pixels: never the area itself)
          const si = (nnf[t] + dy * w + dx) * 4;
          r += img[si] * k; g += img[si + 1] * k; b += img[si + 2] * k; a += img[si + 3] * k; sw += k;
        }
      }
      if (sw > 0) { const i = q * 4; img[i] = r / sw; img[i + 1] = g / sw; img[i + 2] = b / sw; img[i + 3] = a / sw; }
    }
  }

  /**
   * The full-size picture from a level searched at 1/S: a pixel is copied from the full-size picture with the
   * offsets of the four nearest patch centres there, blended by distance (where they agree, an exact copy).
   */
  private upPredictor(c: Level, f: Level, S: number): Predictor {
    const { w, h, img, mask } = f;
    const map = c.map!, nnf = c.nnf!, wt = c.wt, cw = c.w, ch = c.h;
    return (q, out) => {
      const qx = q % w, qy = (q - qx) / w;
      const u = (qx + 0.5) / S - 0.5, v = (qy + 0.5) / S - 0.5;
      const ux = Math.floor(u), vy = Math.floor(v), fx = u - ux, fy = v - vy;
      let r = 0, g = 0, b = 0, a = 0, sw = 0;
      for (let j = 0; j < 2; j++) {
        const cy = Math.min(ch - 1, Math.max(0, vy + j)), by = j ? fy : 1 - fy;
        for (let i = 0; i < 2; i++) {
          const cx = Math.min(cw - 1, Math.max(0, ux + i)), k0 = (i ? fx : 1 - fx) * by;
          if (k0 <= 0) continue;
          const t = map[cy * cw + cx];
          if (t < 0) continue;
          const s = nnf[t], sx = s % cw, sy = (s - sx) / cw;
          const x = qx + (sx - cx) * S, y = qy + (sy - cy) * S;
          if (x < 0 || x >= w || y < 0 || y >= h) continue;
          const si = y * w + x;
          if (mask[si] !== 0) continue;
          const k = k0 * (wt ? wt[t] : 1);
          const pi = si * 4;
          r += img[pi] * k; g += img[pi + 1] * k; b += img[pi + 2] * k; a += img[pi + 3] * k; sw += k;
        }
      }
      if (sw > 0) { out[0] = r / sw; out[1] = g / sw; out[2] = b / sw; out[3] = a / sw; return true; }
      if (mask[q] !== 1) return false;
      // nothing to copy from (rare, at the very edge): the searched level's own pixel
      const cx = Math.min(cw - 1, Math.max(0, Math.round(u))), cy = Math.min(ch - 1, Math.max(0, Math.round(v)));
      const ci = (cy * cw + cx) * 4;
      out[0] = c.img[ci]; out[1] = c.img[ci + 1]; out[2] = c.img[ci + 2]; out[3] = c.img[ci + 3];
      return true;
    };
  }
}

/** Half size: known where all four pixels are known; «to fill» where any of them is. */
function downsample(c: Level): Level {
  const w = Math.ceil(c.w / 2), h = Math.ceil(c.h / 2);
  const img = new Uint8ClampedArray(w * h * 4), mask = new Uint8Array(w * h);
  let holeN = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0, m = 0;
    for (let j = 0; j < 2; j++) {
      const yy = 2 * y + j;
      if (yy >= c.h) continue;
      for (let i = 0; i < 2; i++) {
        const xx = 2 * x + i;
        if (xx >= c.w) continue;
        const k = yy * c.w + xx, mk = c.mask[k];
        if (mk === 1) m = 1; else if (mk === 2 && m === 0) m = 2;
        const pi = k * 4;
        r += c.img[pi]; g += c.img[pi + 1]; b += c.img[pi + 2]; a += c.img[pi + 3]; n++;
      }
    }
    const o = (y * w + x) * 4;
    img[o] = r / n; img[o + 1] = g / n; img[o + 2] = b / n; img[o + 3] = a / n;
    mask[y * w + x] = m;
    if (m === 1) holeN++;
  }
  return { w, h, img, mask, holeN };
}

/** How far each pixel is from a known one (chessboard distance; 0 for known pixels, a huge number if none is known). */
function holeDistances(c: Level): Int32Array {
  const { w, h, mask } = c;
  const d = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] === 0 ? 0 : UNREACHED;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i]) continue;
    let m = d[i];
    if (x > 0) m = Math.min(m, d[i - 1] + 1);
    if (y > 0) {
      m = Math.min(m, d[i - w] + 1);
      if (x > 0) m = Math.min(m, d[i - w - 1] + 1);
      if (x < w - 1) m = Math.min(m, d[i - w + 1] + 1);
    }
    d[i] = m;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!d[i]) continue;
    let m = d[i];
    if (x < w - 1) m = Math.min(m, d[i + 1] + 1);
    if (y < h - 1) {
      m = Math.min(m, d[i + w] + 1);
      if (x < w - 1) m = Math.min(m, d[i + w + 1] + 1);
      if (x > 0) m = Math.min(m, d[i + w - 1] + 1);
    }
    d[i] = m;
  }
  return d;
}
const UNREACHED = 1 << 29;

/** The farthest any pixel of the area is from a known one; Infinity when one cannot be reached. */
function maxHoleDistance(c: Level): number {
  const d = holeDistances(c);
  let md = 0;
  for (let i = 0; i < d.length; i++) if (c.mask[i] === 1 && d[i] > md) md = d[i];
  return md >= UNREACHED ? Infinity : md;
}

/** Possible sources, target patches and their pixel counts for a level. */
function prepare(c: Level) {
  const { w, h, mask } = c;
  const W = w + 1;
  // integral images of the unknown pixels and of the area's pixels
  const unk = new Int32Array(W * (h + 1)), hol = new Int32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let ru = 0, rh = 0;
    for (let x = 0; x < w; x++) {
      const m = mask[y * w + x];
      if (m) ru++;
      if (m === 1) rh++;
      unk[(y + 1) * W + x + 1] = unk[y * W + x + 1] + ru;
      hol[(y + 1) * W + x + 1] = hol[y * W + x + 1] + rh;
    }
  }
  const box = (a: Int32Array, x0: number, y0: number, x1: number, y1: number) => a[y1 * W + x1] - a[y0 * W + x1] - a[y1 * W + x0] + a[y0 * W + x0];
  const valid = new Uint8Array(w * h);
  let nv = 0;
  for (let y = PR; y < h - PR; y++) for (let x = PR; x < w - PR; x++) {
    if (box(unk, x - PR, y - PR, x + PR + 1, y + PR + 1) === 0) { valid[y * w + x] = 1; nv++; }
  }
  const validList = new Int32Array(nv);
  for (let i = 0, k = 0; i < w * h; i++) if (valid[i]) validList[k++] = i;
  const map = new Int32Array(w * h).fill(-1);
  let nt = 0;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - PR), y1 = Math.min(h, y + PR + 1);
    for (let x = 0; x < w; x++) {
      if (box(hol, Math.max(0, x - PR), y0, Math.min(w, x + PR + 1), y1) > 0) map[y * w + x] = nt++;
    }
  }
  const T = new Int32Array(nt), cnt = new Uint8Array(nt);
  for (let i = 0; i < w * h; i++) {
    const t = map[i];
    if (t < 0) continue;
    T[t] = i;
    const x = i % w, y = (i - x) / w;
    let n = 0;
    for (let dy = -PR; dy <= PR; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -PR; dx <= PR; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < w && mask[yy * w + xx] !== 2) n++;
      }
    }
    cnt[t] = n;
  }
  Object.assign(c, { valid, validList, map, T, cnt });
}

function freeSearch(c: Level) {
  c.valid = c.validList = c.map = c.T = c.nnf = c.cnt = undefined;
  c.dist = undefined; c.wt = undefined;
}

/**
 * The distance between target patch (centre p, target index t) and source patch (centre s): the sum of squared
 * RGBA differences over the target pixels inside the level and not «2». It stops as soon as it passes `limit`.
 */
function distFn(c: Level): (t: number, p: number, s: number, limit: number) => number {
  const { w, h, img, mask } = c;
  const cnt = c.cnt!;
  return (t, p, s, limit) => {
    let d = 0;
    if (cnt[t] === PATCH_N) {
      // the whole patch counts: no checks
      const o = -PR * w - PR;
      for (let dy = 0; dy < PATCH; dy++) {
        let a = (p + o + dy * w) * 4, b = (s + o + dy * w) * 4;
        for (let dx = 0; dx < PATCH; dx++, a += 4, b += 4) {
          const e0 = img[a] - img[b], e1 = img[a + 1] - img[b + 1], e2 = img[a + 2] - img[b + 2], e3 = img[a + 3] - img[b + 3];
          d += e0 * e0 + e1 * e1 + e2 * e2 + e3 * e3;
        }
        if (d >= limit) return d;
      }
      return d;
    }
    const px = p % w, py = (p - px) / w;
    for (let dy = -PR; dy <= PR; dy++) {
      const ty = py + dy;
      if (ty < 0 || ty >= h) continue;
      for (let dx = -PR; dx <= PR; dx++) {
        const tx = px + dx;
        if (tx < 0 || tx >= w) continue;
        const ti = ty * w + tx;
        if (mask[ti] === 2) continue;
        const a = ti * 4, b = (s + dy * w + dx) * 4;
        const e0 = img[a] - img[b], e1 = img[a + 1] - img[b + 1], e2 = img[a + 2] - img[b + 2], e3 = img[a + 3] - img[b + 3];
        d += e0 * e0 + e1 * e1 + e2 * e2 + e3 * e3;
      }
      if (d >= limit) return d;
    }
    return d;
  };
}
