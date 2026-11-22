import { Layer, compositeOp, hasEffects } from './layer';
import { createCanvas, ctx2d } from './util';
import type { Doc } from './document';

/** Temporary replacement drawing of a layer (free transform preview etc.), in document coordinates. */
export const previews = new Map<number, (g: CanvasRenderingContext2D) => void>();

/** Hook for layer style rendering, installed by the effects module. Draws effects in place into g (which holds the layer). */
export const hooks: {
  effects: ((l: Layer, g: CanvasRenderingContext2D, W: number, H: number) => void) | null;
} = { effects: null };

/* ---------- temp canvas pool ---------- */
const pool: HTMLCanvasElement[] = [];
function acquire(W: number, H: number): CanvasRenderingContext2D {
  let c = pool.pop();
  if (!c || c.width !== W || c.height !== H) c = createCanvas(W, H);
  const g = ctx2d(c);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  g.clearRect(0, 0, W, H);
  return g;
}
function release(g: CanvasRenderingContext2D) { if (pool.length < 8) pool.push(g.canvas); }

function blit(g: CanvasRenderingContext2D, src: CanvasImageSource, x: number, y: number, alpha: number, op: GlobalCompositeOperation) {
  g.globalAlpha = alpha;
  g.globalCompositeOperation = op;
  g.drawImage(src, x, y);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

export function applyMask(g: CanvasRenderingContext2D, l: Layer, W: number, H: number) {
  const m = l.mask;
  if (!m || !m.enabled) return;
  if (m.fill === 255) m.ensureCovers({ x: 0, y: 0, w: W, h: H });
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(m.canvas, m.x, m.y);
  g.globalCompositeOperation = 'source-over';
}

export function compositeDocument(doc: Doc, g: CanvasRenderingContext2D) {
  renderChildren(doc.root.children, g, doc.width, doc.height);
}

export function renderChildren(children: Layer[], g: CanvasRenderingContext2D, W: number, H: number) {
  for (let i = 0; i < children.length; i++) {
    const base = children[i];
    let j = i + 1;
    while (j < children.length && children[j].clipped) j++;
    const clips = children.slice(i + 1, j).filter(c => c.visible);
    i = j - 1;
    if (!base.visible) continue;
    if (!clips.length) { drawNode(base, g, W, H, false); continue; }
    const t = acquire(W, H);
    drawNode(base, t, W, H, true);
    for (const c of clips) {
      const ct = acquire(W, H);
      drawNode(c, ct, W, H, true);
      ct.globalCompositeOperation = 'destination-in';
      ct.drawImage(t.canvas, 0, 0);
      blit(t, ct.canvas, 0, 0, c.opacity, c.blend === 'normal' ? 'source-atop' : compositeOp(c.blend));
      release(ct);
    }
    blit(g, t.canvas, 0, 0, base.opacity, compositeOp(base.blend));
    release(t);
  }
}

/** Draw a layer node. `plain` = ignore own opacity/blend (caller applies them). */
export function drawNode(l: Layer, g: CanvasRenderingContext2D, W: number, H: number, plain: boolean) {
  const opacity = plain ? 1 : l.opacity;
  const op = plain ? 'source-over' : compositeOp(l.blend);
  const masked = !!(l.mask && l.mask.enabled);
  if (l.isGroup) {
    if (!plain && l.blend === 'pass-through' && l.opacity === 1 && !masked && !hasEffects(l.effects)) {
      renderChildren(l.children, g, W, H);
      return;
    }
    const t = acquire(W, H);
    renderChildren(l.children, t, W, H);
    if (masked) applyMask(t, l, W, H);
    if (hasEffects(l.effects) && hooks.effects) hooks.effects(l, t, W, H);
    blit(g, t.canvas, 0, 0, opacity, op);
    release(t);
    return;
  }
  const preview = previews.get(l.id);
  const fx = hasEffects(l.effects) && !!hooks.effects;
  if (!preview && !masked && !fx) {
    blit(g, l.canvas, l.x, l.y, opacity, op);
    return;
  }
  const t = acquire(W, H);
  if (preview) preview(t); else t.drawImage(l.canvas, l.x, l.y);
  if (masked) applyMask(t, l, W, H);
  if (fx) hooks.effects!(l, t, W, H);
  blit(g, t.canvas, 0, 0, opacity, op);
  release(t);
}

/** Render a single layer (with mask/effects) into a document-sized canvas. */
export function renderLayerAlone(l: Layer, W: number, H: number): HTMLCanvasElement {
  const c = createCanvas(W, H);
  drawNode(l, ctx2d(c), W, H, true);
  return c;
}
