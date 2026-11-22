import { Doc } from './document';
import { Layer, Surface, newRasterLayer } from './layer';
import { Selection } from './selection';
import { createCanvas, ctx2d, cloneCanvas, Rect, alphaBounds } from './util';
import { drawNode, renderChildren } from './render';

export function cloneSurface<T extends Surface>(s: T): T {
  const n = new Surface(1, 1, s.x, s.y, s.fill) as T;
  n.canvas = cloneCanvas(s.canvas);
  if ((s as any).enabled !== undefined) (n as any).enabled = (s as any).enabled;
  return n;
}

export function cloneLayer(l: Layer, suffix = ''): Layer {
  const n = new Layer(l.kind, l.name + suffix);
  n.content = cloneSurface(l.content);
  n.visible = l.visible; n.opacity = l.opacity; n.blend = l.blend; n.clipped = l.clipped; n.lockAlpha = l.lockAlpha;
  n.mask = l.mask ? cloneSurface(l.mask) : null;
  n.effects = JSON.parse(JSON.stringify(l.effects));
  n.text = l.text ? JSON.parse(JSON.stringify(l.text)) : null;
  n.expanded = l.expanded;
  n.children = l.children.map(c => { const cc = cloneLayer(c); cc.parent = n; return cc; });
  return n;
}

/** Apply an affine transform (document space) to a surface. Uncovered area of fill-255 masks stays white. */
export function transformSurface(s: Surface, m: DOMMatrix, smooth = true) {
  const pts = [new DOMPoint(s.x, s.y), new DOMPoint(s.x + s.w, s.y), new DOMPoint(s.x, s.y + s.h), new DOMPoint(s.x + s.w, s.y + s.h)].map(p => p.matrixTransform(m));
  const x0 = Math.floor(Math.min(...pts.map(p => p.x))), y0 = Math.floor(Math.min(...pts.map(p => p.y)));
  const x1 = Math.ceil(Math.max(...pts.map(p => p.x))), y1 = Math.ceil(Math.max(...pts.map(p => p.y)));
  const c = createCanvas(x1 - x0, y1 - y0);
  const g = ctx2d(c);
  g.imageSmoothingEnabled = smooth;
  g.imageSmoothingQuality = 'high';
  if (s.fill === 255) {
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x - x0, p.y - y0) : g.moveTo(p.x - x0, p.y - y0))); g.closePath(); g.fill();
    g.globalCompositeOperation = 'source-over';
  }
  g.setTransform(new DOMMatrix().translate(-x0, -y0).multiply(m).translate(s.x, s.y));
  g.drawImage(s.canvas, 0, 0);
  s.replace(c, x0, y0);
}

export function transformLayer(l: Layer, m: DOMMatrix) {
  if (l.kind === 'text') { l.kind = 'raster'; l.text = null; }
  if (!l.isGroup) transformSurface(l.content, m);
  if (l.mask) transformSurface(l.mask, m);
  for (const c of l.children) transformLayer(c, m);
  l.touch();
}

/** Bounds of the visible content of a layer (document coords). */
export function layerBounds(l: Layer): Rect | null {
  if (l.isGroup) {
    let r: Rect | null = null;
    for (const c of l.children) {
      const b = layerBounds(c);
      if (b) r = r ? { x: Math.min(r.x, b.x), y: Math.min(r.y, b.y), w: Math.max(r.x + r.w, b.x + b.w) - Math.min(r.x, b.x), h: Math.max(r.y + r.h, b.y + b.h) - Math.min(r.y, b.y) } : b;
    }
    return r;
  }
  const b = alphaBounds(l.canvas);
  return b ? { x: b.x + l.x, y: b.y + l.y, w: b.w, h: b.h } : null;
}

/** Rotate/flip the whole document. kind: cw | ccw | 180 | flipH | flipV */
export function transformDocument(d: Doc, kind: 'cw' | 'ccw' | '180' | 'flipH' | 'flipV') {
  const W = d.width, H = d.height;
  let m = new DOMMatrix();
  let nw = W, nh = H;
  if (kind === 'cw') { m = new DOMMatrix([0, 1, -1, 0, H, 0]); nw = H; nh = W; }
  else if (kind === 'ccw') { m = new DOMMatrix([0, -1, 1, 0, 0, W]); nw = H; nh = W; }
  else if (kind === '180') m = new DOMMatrix([-1, 0, 0, -1, W, H]);
  else if (kind === 'flipH') m = new DOMMatrix([-1, 0, 0, 1, W, 0]);
  else m = new DOMMatrix([1, 0, 0, -1, 0, H]);
  for (const l of d.root.children) transformLayer(l, m);
  if (d.selection) {
    const c = createCanvas(nw, nh);
    const g = ctx2d(c);
    g.setTransform(m);
    g.drawImage(d.selection.mask, 0, 0);
    d.selection = Selection.fromMask(c);
  }
  d.width = nw; d.height = nh;
  d.guides = { h: [], v: [] };
  d.invalidate();
}

/** Crop/extend the document to rect (document coords). Pixels outside are deleted. */
export function cropDocument(d: Doc, r: Rect, deletePixels = true) {
  const nx = Math.round(r.x), ny = Math.round(r.y), nw = Math.max(1, Math.round(r.w)), nh = Math.max(1, Math.round(r.h));
  const shift = (s: Surface) => {
    s.x -= nx; s.y -= ny;
    if (deletePixels) {
      const x0 = Math.max(s.x, 0), y0 = Math.max(s.y, 0);
      const x1 = Math.min(s.x + s.w, nw), y1 = Math.min(s.y + s.h, nh);
      if (s.fill === 255) { s.ensureCovers({ x: 0, y: 0, w: nw, h: nh }); }
      const cx0 = s.fill === 255 ? 0 : x0, cy0 = s.fill === 255 ? 0 : y0;
      const cx1 = s.fill === 255 ? nw : x1, cy1 = s.fill === 255 ? nh : y1;
      if (cx1 <= cx0 || cy1 <= cy0) { s.replace(createCanvas(1, 1), 0, 0); return; }
      const c = createCanvas(cx1 - cx0, cy1 - cy0);
      ctx2d(c).drawImage(s.canvas, s.x - cx0, s.y - cy0);
      s.replace(c, cx0, cy0);
    } else s.dirty = s.dirty; // offsets only
  };
  const walk = (l: Layer) => {
    if (l.text) { l.text.ax -= nx; l.text.ay -= ny; }
    if (!l.isGroup) shift(l.content);
    if (l.mask) shift(l.mask);
    l.children.forEach(walk);
    l.touch();
  };
  d.root.children.forEach(walk);
  if (d.selection) {
    const c = createCanvas(nw, nh);
    ctx2d(c).drawImage(d.selection.mask, -nx, -ny);
    d.selection = Selection.fromMask(c);
  }
  d.width = nw; d.height = nh;
  d.guides = { h: [], v: [] };
  d.invalidate();
}

/** Bake layer (mask, effects, opacity 1) into a document-sized canvas. */
export function bakeLayer(d: Doc, l: Layer): HTMLCanvasElement {
  const c = createCanvas(d.width, d.height);
  drawNode(l, ctx2d(c), d.width, d.height, true);
  return c;
}

export function mergeDown(d: Doc, upper: Layer): Layer | null {
  const p = upper.parent!;
  const i = p.children.indexOf(upper);
  const lower = p.children[i - 1];
  if (!lower || lower.isGroup || !upper.visible) return null;
  const c = bakeLayer(d, lower);
  const g = ctx2d(c);
  // upper plus its clipped layers, blended with its own opacity/blend
  renderChildren([upper], g, d.width, d.height);
  lower.content.replace(c, 0, 0);
  lower.mask = null;
  lower.effects = JSON.parse(JSON.stringify(new Layer('raster', '').effects));
  if (lower.kind === 'text') { lower.kind = 'raster'; lower.text = null; }
  lower.touch();
  d.remove(upper);
  d.setActive(lower);
  return lower;
}

/** New layer containing everything visible. */
export function stampVisible(d: Doc, name: string): Layer {
  const l = newRasterLayer(name, d.width, d.height);
  l.content.ctx.drawImage(d.composite(), 0, 0);
  return l;
}

export function mergeVisible(d: Doc, name: string) {
  const visible = d.root.children.filter(l => l.visible);
  if (!visible.length) return;
  const merged = stampVisible(d, name);
  const idx = d.root.children.indexOf(visible[0]);
  d.root.children = d.root.children.filter(l => !l.visible);
  d.root.children.splice(Math.min(idx, d.root.children.length), 0, merged);
  merged.parent = d.root;
  d.setActive(merged);
  d.invalidate();
}

export function flatten(d: Doc, name: string) {
  const l = newRasterLayer(name, d.width, d.height);
  const g = l.content.ctx;
  g.fillStyle = '#fff'; g.fillRect(0, 0, d.width, d.height);
  g.drawImage(d.composite(), 0, 0);
  d.root.children = [l];
  l.parent = d.root;
  d.setActive(l);
  d.invalidate();
}

/** Copy selected pixels of a layer into a canvas cropped to the selection bounds. */
export function copySelected(l: Layer, sel: Selection | null, docW: number, docH: number): { canvas: HTMLCanvasElement; x: number; y: number } | null {
  if (l.isGroup) return null;
  const r = sel ? sel.bounds : { x: 0, y: 0, w: docW, h: docH };
  const c = createCanvas(r.w, r.h);
  const g = ctx2d(c);
  g.drawImage(l.canvas, l.x - r.x, l.y - r.y);
  if (sel) { g.globalCompositeOperation = 'destination-in'; g.drawImage(sel.mask, -r.x, -r.y); }
  return { canvas: c, x: r.x, y: r.y };
}

export function clearSelected(l: Layer, sel: Selection) {
  const g = l.content.ctx;
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(sel.mask, -l.x, -l.y);
  g.globalCompositeOperation = 'source-over';
  l.content.markDirtyDoc(sel.bounds);
  l.touch();
}
