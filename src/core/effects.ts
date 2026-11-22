import { Layer, LayerEffects, compositeOp, hasEffects } from './layer';
import { createCanvas, ctx2d, Rect, rectIntersect, alphaBounds } from './util';
import { css } from './color';
import { distanceTransform } from './selection';
import { hooks, previews } from './render';

/* Layer style rendering: drop shadow, stroke, bevel & emboss, color overlay, gradient overlay. */

function extent(fx: LayerEffects): number {
  let e = 0;
  if (fx.dropShadow.enabled) e = Math.max(e, fx.dropShadow.distance + fx.dropShadow.size * 1.5 + fx.dropShadow.spread);
  if (fx.stroke.enabled && fx.stroke.position !== 'inside') e = Math.max(e, fx.stroke.size);
  if (fx.bevel.enabled && fx.bevel.style !== 'inner') e = Math.max(e, fx.bevel.size * 1.5);
  return Math.ceil(e) + 4;
}

const cache = new WeakMap<Layer, { key: string; canvas: HTMLCanvasElement; x: number; y: number }>();

export function renderEffects(l: Layer, g: CanvasRenderingContext2D, W: number, H: number) {
  const fx = l.effects;
  if (!hasEffects(fx)) return;
  const ext = extent(fx);
  // while a preview (free transform…) replaces the layer, its pixels are elsewhere than the layer canvas
  // and change every frame: use the whole document and skip the cache
  const live = previews.has(l.id);
  let base: Rect = l.isGroup ? { x: 0, y: 0, w: W, h: H } : { x: l.x - ext, y: l.y - ext, w: l.canvas.width + ext * 2, h: l.canvas.height + ext * 2 };
  if (live && !l.isGroup) {
    const ab = alphaBounds(g.canvas);
    if (!ab) return;
    base = { x: ab.x - ext, y: ab.y - ext, w: ab.w + ext * 2, h: ab.h + ext * 2 };
  }
  const R = rectIntersect(base, { x: 0, y: 0, w: W, h: H });
  if (!R) return;
  const key = l.isGroup || live ? '' : `${l.version}|${JSON.stringify(fx)}|${R.x},${R.y},${R.w},${R.h}|${l.mask ? l.mask.enabled : ''}`;
  const hit = key ? cache.get(l) : undefined;
  if (hit && hit.key === key) {
    g.clearRect(0, 0, W, H);
    g.drawImage(hit.canvas, hit.x, hit.y);
    return;
  }
  const src = createCanvas(R.w, R.h);
  const sg = ctx2d(src);
  sg.drawImage(g.canvas, -R.x, -R.y);
  const A = alphaOf(src);
  const out = createCanvas(R.w, R.h);
  const og = ctx2d(out);
  const silhouette = (color: string) => {
    const c = createCanvas(R.w, R.h), cg = ctx2d(c);
    cg.drawImage(src, 0, 0);
    cg.globalCompositeOperation = 'source-in';
    cg.fillStyle = color; cg.fillRect(0, 0, R.w, R.h);
    return c;
  };

  // 1. drop shadow
  const ds = fx.dropShadow;
  if (ds.enabled) {
    const a = (ds.angle * Math.PI) / 180;
    const dx = -Math.cos(a) * ds.distance, dy = Math.sin(a) * ds.distance;
    let sil = silhouette(css(ds.color));
    if (ds.spread > 0 && ds.size > 0) sil = dilate(sil, A, R.w, R.h, (ds.spread / 100) * ds.size, css(ds.color));
    og.save();
    og.globalAlpha = ds.opacity;
    if (ds.size > 0) og.filter = `blur(${ds.size / 2}px)`;
    og.drawImage(sil, dx, dy);
    og.restore();
  }

  // 2. bevel (outer part) and stroke (outside part) go below the content
  const bevel = fx.bevel.enabled ? bevelMaps(src, A, R.w, R.h, fx) : null;
  if (bevel) drawBevel(og, bevel.outerHL, bevel.outerSH, fx, 'source-over');
  const stroke = fx.stroke.enabled ? strokeMaps(A, R.w, R.h, fx) : null;
  if (stroke?.outer) drawColored(og, stroke.outer, R.w, R.h, css(fx.stroke.color), fx.stroke.opacity, 'source-over');

  // 3. content
  og.drawImage(src, 0, 0);

  // 4. overlays (gradient, then color on top — like Photoshop)
  // gradient overlay is aligned to the visible content bounds (like Photoshop's 'Align with layer')
  const bounds = alphaBounds(src, 8) || { x: 0, y: 0, w: R.w, h: R.h };
  const go = fx.gradientOverlay;
  if (go.enabled) {
    const c = createCanvas(R.w, R.h), cg = ctx2d(c);
    const cx = bounds.x + bounds.w / 2, cy = bounds.y + bounds.h / 2;
    const a = (go.angle * Math.PI) / 180;
    const stops = go.reverse ? go.stops.map(s => ({ ...s, pos: 1 - s.pos })).reverse() : go.stops;
    let gr: CanvasGradient;
    if (go.type === 'radial') {
      gr = cg.createRadialGradient(cx, cy, 0, cx, cy, (Math.max(bounds.w, bounds.h) / 2) * (go.scale / 100));
    } else {
      const L = ((Math.abs(bounds.w * Math.cos(a)) + Math.abs(bounds.h * Math.sin(a))) / 2) * (go.scale / 100);
      const ux = Math.cos(a), uy = -Math.sin(a);
      gr = cg.createLinearGradient(cx - ux * L, cy - uy * L, cx + ux * L, cy + uy * L);
    }
    for (const s of [...stops].sort((p, q) => p.pos - q.pos)) gr.addColorStop(Math.min(1, Math.max(0, s.pos)), css(s.color));
    cg.fillStyle = gr; cg.fillRect(0, 0, R.w, R.h);
    cg.globalCompositeOperation = 'destination-in'; cg.drawImage(src, 0, 0);
    og.save(); og.globalAlpha = go.opacity; og.globalCompositeOperation = go.blend === 'normal' ? 'source-atop' : compositeOp(go.blend); og.drawImage(c, 0, 0); og.restore();
  }
  const co = fx.colorOverlay;
  if (co.enabled) {
    const c = silhouette(css(co.color));
    og.save(); og.globalAlpha = co.opacity; og.globalCompositeOperation = co.blend === 'normal' ? 'source-atop' : compositeOp(co.blend); og.drawImage(c, 0, 0); og.restore();
  }

  // 5. inner bevel and inner/center stroke on top
  if (bevel) drawBevel(og, bevel.innerHL, bevel.innerSH, fx, 'source-atop');
  if (stroke?.inner) drawColored(og, stroke.inner, R.w, R.h, css(fx.stroke.color), fx.stroke.opacity, 'source-over');

  g.clearRect(0, 0, W, H);
  g.drawImage(out, R.x, R.y);
  if (key) cache.set(l, { key, canvas: out, x: R.x, y: R.y });
}

function alphaOf(c: HTMLCanvasElement): Uint8Array {
  const d = ctx2d(c).getImageData(0, 0, c.width, c.height).data;
  const a = new Uint8Array(c.width * c.height);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return a;
}

/** Draw a coverage map (0..1) as a solid color. */
function drawColored(g: CanvasRenderingContext2D, cov: Float32Array, w: number, h: number, color: string, opacity: number, op: GlobalCompositeOperation) {
  const c = createCanvas(w, h), cg = ctx2d(c);
  const img = cg.createImageData(w, h);
  for (let i = 0; i < cov.length; i++) img.data[i * 4 + 3] = cov[i] * 255;
  cg.putImageData(img, 0, 0);
  cg.globalCompositeOperation = 'source-in'; cg.fillStyle = color; cg.fillRect(0, 0, w, h);
  g.save(); g.globalAlpha = opacity; g.globalCompositeOperation = op; g.drawImage(c, 0, 0); g.restore();
}

function dilate(sil: HTMLCanvasElement, A: Uint8Array, w: number, h: number, r: number, color: string): HTMLCanvasElement {
  const inside = new Uint8Array(A.length);
  for (let i = 0; i < A.length; i++) inside[i] = A[i] >= 128 ? 1 : 0;
  const d = distanceTransform(inside, w, h);
  const cov = new Float32Array(A.length);
  for (let i = 0; i < A.length; i++) cov[i] = Math.max(A[i] / 255, Math.min(1, Math.max(0, r - d[i] + 0.5)));
  const c = createCanvas(w, h);
  drawColored(ctx2d(c), cov, w, h, color, 1, 'source-over');
  void sil;
  return c;
}

/* ---------- stroke via euclidean distance transform ---------- */
function strokeMaps(A: Uint8Array, w: number, h: number, fx: LayerEffects) {
  const size = fx.stroke.size, pos = fx.stroke.position;
  const inside = new Uint8Array(A.length), outside = new Uint8Array(A.length);
  for (let i = 0; i < A.length; i++) { const v = A[i] >= 128 ? 1 : 0; inside[i] = v; outside[i] = 1 - v; }
  const outR = pos === 'outside' ? size : pos === 'center' ? size / 2 : 0;
  const inR = pos === 'inside' ? size : pos === 'center' ? size / 2 : 0;
  let outer: Float32Array | null = null, inner: Float32Array | null = null;
  if (outR > 0) {
    const dOut = distanceTransform(inside, w, h);
    const dIn = distanceTransform(outside, w, h);
    outer = new Float32Array(A.length);
    for (let i = 0; i < A.length; i++) {
      if (!inside[i]) outer[i] = Math.min(1, Math.max(0, outR - dOut[i] + 0.5));
      else if (dIn[i] <= 1.5) outer[i] = 1 - A[i] / 255; // fill under anti-aliased edges
    }
  }
  if (inR > 0) {
    const dIn = distanceTransform(outside, w, h);
    inner = new Float32Array(A.length);
    for (let i = 0; i < A.length; i++) if (inside[i] || A[i]) inner[i] = Math.min(1, Math.max(0, inR - dIn[i] + 0.5)) * (A[i] / 255);
  }
  return { outer, inner };
}

/* ---------- bevel & emboss ---------- */
function bevelMaps(src: HTMLCanvasElement, A: Uint8Array, w: number, h: number, fx: LayerEffects) {
  const b = fx.bevel;
  // height map: blurred alpha
  const hc = createCanvas(w, h), hg = ctx2d(hc);
  hg.filter = `blur(${Math.max(0.5, b.size / 2)}px)`;
  hg.drawImage(src, 0, 0);
  const Hm = alphaOf(hc);
  const a = (b.angle * Math.PI) / 180, alt = (b.altitude * Math.PI) / 180;
  const Lx = Math.cos(a) * Math.cos(alt), Ly = -Math.sin(a) * Math.cos(alt), Lz = Math.sin(alt);
  const k = (b.depth / 100) * Math.max(1, b.size) * 1.25 * (b.direction === 'down' ? -1 : 1);
  const mk = () => new Float32Array(w * h);
  const innerHL = mk(), innerSH = mk(), outerHL = mk(), outerSH = mk();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const hv = Hm[i];
      if (hv === 0 && A[i] === 0) continue;
      const gx = (Hm[i + 1] - Hm[i - 1]) / 255, gy = (Hm[i + w] - Hm[i - w]) / 255;
      const nx = -gx * k, ny = -gy * k;
      const dot = (nx * Lx + ny * Ly + Lz) / Math.sqrt(nx * nx + ny * ny + 1);
      const diff = Math.max(-1, Math.min(1, (dot - Lz) * 2));
      const ai = A[i] / 255;
      const style = b.style;
      if (style === 'inner' || style === 'emboss' || style === 'pillow') {
        if (diff > 0) innerHL[i] = diff * ai; else innerSH[i] = -diff * ai;
      }
      if (style === 'outer' || style === 'emboss' || style === 'pillow') {
        const ao = (1 - ai) * (hv / 255 > 0.01 ? 1 : 0);
        const dd = style === 'pillow' ? -diff : diff;
        if (dd > 0) outerHL[i] = dd * ao; else outerSH[i] = -dd * ao;
      }
    }
  }
  return { innerHL, innerSH, outerHL, outerSH, w, h };
}

function drawBevel(g: CanvasRenderingContext2D, hl: Float32Array, sh: Float32Array, fx: LayerEffects, op: GlobalCompositeOperation) {
  const b = fx.bevel;
  const w = g.canvas.width, h = g.canvas.height;
  const draw = (cov: Float32Array, color: string, opacity: number) => {
    const c = createCanvas(w, h), cg = ctx2d(c);
    const img = cg.createImageData(w, h);
    let any = false;
    for (let i = 0; i < cov.length; i++) { const v = cov[i]; if (v > 0) { img.data[i * 4 + 3] = v * 255; any = true; } }
    if (!any) return;
    cg.putImageData(img, 0, 0);
    cg.globalCompositeOperation = 'source-in'; cg.fillStyle = color; cg.fillRect(0, 0, w, h);
    g.save();
    g.globalAlpha = opacity;
    g.globalCompositeOperation = op;
    if (b.soften > 0) g.filter = `blur(${b.soften / 2}px)`;
    g.drawImage(c, 0, 0);
    g.restore();
  };
  draw(hl, css(b.highlightColor), b.highlightOpacity);
  draw(sh, css(b.shadowColor), b.shadowOpacity);
}

export function installEffects() { hooks.effects = renderEffects; }
