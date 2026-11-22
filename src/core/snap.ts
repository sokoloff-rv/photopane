import { app } from '../app';
import { Layer } from './layer';
import { Rect, alphaBounds } from './util';

/** Lines shown while snapping (document coords). */
export const smartLines: { x?: number; y?: number }[] = [];

const boundsCache = new WeakMap<Layer, { v: number; c: HTMLCanvasElement; b: Rect | null }>();
function cachedBounds(l: Layer): Rect | null {
  const e = boundsCache.get(l);
  if (e && e.v === l.version && e.c === l.canvas) return e.b ? { x: e.b.x + l.x, y: e.b.y + l.y, w: e.b.w, h: e.b.h } : null;
  const b = alphaBounds(l.canvas, 8);
  boundsCache.set(l, { v: l.version, c: l.canvas, b });
  return b ? { x: b.x + l.x, y: b.y + l.y, w: b.w, h: b.h } : null;
}

export function snapEnabled() { return app.settings.snap !== false; }

export interface Targets { xs: number[]; ys: number[] }

/** Snap targets: document edges/center, guides, and (optionally) bounds of other visible layers. */
export function collectTargets(exclude: Set<Layer> | null, withLayers: boolean): Targets {
  const d = app.doc!;
  const xs = [0, d.width / 2, d.width, ...d.guides.v];
  const ys = [0, d.height / 2, d.height, ...d.guides.h];
  if (withLayers) {
    for (const l of d.layers) {
      if (l.isGroup || !l.effectiveVisible || (exclude && isUnder(l, exclude))) continue;
      const b = cachedBounds(l);
      if (!b) continue;
      xs.push(b.x, b.x + b.w / 2, b.x + b.w);
      ys.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
  }
  return { xs, ys };
}

function isUnder(l: Layer, set: Set<Layer>) {
  for (let p: Layer | null = l; p; p = p.parent) if (set.has(p)) return true;
  return false;
}

const tol = () => 7 / (app.doc?.zoom || 1);

/** Snap a moving rect: returns adjusted delta and records smart guide lines. */
export function snapRect(r: Rect, t: Targets): { dx: number; dy: number } {
  smartLines.length = 0;
  if (!snapEnabled()) return { dx: 0, dy: 0 };
  const T = tol();
  const best = (vals: number[], targets: number[]) => {
    let bd = Infinity, bt = 0;
    for (const v of vals) for (const tt of targets) { const dd = tt - v; if (Math.abs(dd) < Math.abs(bd) && Math.abs(dd) <= T) { bd = dd; bt = tt; } }
    return bd === Infinity ? null : { d: bd, t: bt };
  };
  const bx = best([r.x, r.x + r.w / 2, r.x + r.w], t.xs);
  const by = best([r.y, r.y + r.h / 2, r.y + r.h], t.ys);
  if (bx) smartLines.push({ x: bx.t });
  if (by) smartLines.push({ y: by.t });
  return { dx: bx ? bx.d : 0, dy: by ? by.d : 0 };
}

/** Snap a single point to document edges/center and guides. */
export function snapPoint(x: number, y: number, withLayers = false): { x: number; y: number } {
  smartLines.length = 0;
  if (!snapEnabled() || !app.doc) return { x, y };
  const t = collectTargets(null, withLayers);
  const T = tol();
  let sx = x, sy = y;
  let dx = T + 1, dy = T + 1;
  for (const tx of t.xs) if (Math.abs(tx - x) < dx) { dx = Math.abs(tx - x); sx = tx; }
  for (const ty of t.ys) if (Math.abs(ty - y) < dy) { dy = Math.abs(ty - y); sy = ty; }
  if (dx > T) sx = x; else smartLines.push({ x: sx });
  if (dy > T) sy = y; else smartLines.push({ y: sy });
  return { x: sx, y: sy };
}

export function clearSmart() { smartLines.length = 0; }
