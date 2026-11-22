import { RGB, BLACK, WHITE } from './color';
import { createCanvas, ctx2d, Rect, uid } from './util';

export type BlendMode =
  | 'pass-through' | 'normal'
  | 'darken' | 'multiply' | 'color-burn'
  | 'lighten' | 'screen' | 'color-dodge' | 'lighter'
  | 'overlay' | 'soft-light' | 'hard-light'
  | 'difference' | 'exclusion'
  | 'hue' | 'saturation' | 'color' | 'luminosity';

export const BLEND_MODES: (BlendMode | '-')[] = [
  'normal', '-',
  'darken', 'multiply', 'color-burn', '-',
  'lighten', 'screen', 'color-dodge', 'lighter', '-',
  'overlay', 'soft-light', 'hard-light', '-',
  'difference', 'exclusion', '-',
  'hue', 'saturation', 'color', 'luminosity',
];

export function compositeOp(b: BlendMode): GlobalCompositeOperation {
  if (b === 'normal' || b === 'pass-through') return 'source-over';
  return b as GlobalCompositeOperation;
}

/* ---------------- Layer effects (layer style) ---------------- */
export interface GradientStop { color: RGB; pos: number }
export interface LayerEffects {
  dropShadow: { enabled: boolean; color: RGB; opacity: number; angle: number; distance: number; size: number; spread: number; blend: BlendMode };
  stroke: { enabled: boolean; color: RGB; size: number; position: 'outside' | 'inside' | 'center'; opacity: number; blend: BlendMode };
  bevel: {
    enabled: boolean; style: 'inner' | 'outer' | 'emboss' | 'pillow'; depth: number; direction: 'up' | 'down';
    size: number; soften: number; angle: number; altitude: number;
    highlightColor: RGB; highlightOpacity: number; shadowColor: RGB; shadowOpacity: number;
  };
  colorOverlay: { enabled: boolean; color: RGB; opacity: number; blend: BlendMode };
  gradientOverlay: { enabled: boolean; stops: GradientStop[]; opacity: number; angle: number; type: 'linear' | 'radial'; reverse: boolean; scale: number; blend: BlendMode };
}

export function defaultEffects(): LayerEffects {
  return {
    dropShadow: { enabled: false, color: { ...BLACK }, opacity: 0.75, angle: 120, distance: 5, size: 5, spread: 0, blend: 'multiply' },
    stroke: { enabled: false, color: { r: 0, g: 0, b: 0 }, size: 3, position: 'outside', opacity: 1, blend: 'normal' },
    bevel: {
      enabled: false, style: 'inner', depth: 100, direction: 'up', size: 5, soften: 0, angle: 120, altitude: 30,
      highlightColor: { ...WHITE }, highlightOpacity: 0.75, shadowColor: { ...BLACK }, shadowOpacity: 0.75,
    },
    colorOverlay: { enabled: false, color: { r: 255, g: 0, b: 0 }, opacity: 1, blend: 'normal' },
    gradientOverlay: {
      enabled: false, stops: [{ color: { ...BLACK }, pos: 0 }, { color: { ...WHITE }, pos: 1 }],
      opacity: 1, angle: 90, type: 'linear', reverse: false, scale: 100, blend: 'normal',
    },
  };
}

export function hasEffects(e: LayerEffects): boolean {
  return e.dropShadow.enabled || e.stroke.enabled || e.bevel.enabled || e.colorOverlay.enabled || e.gradientOverlay.enabled;
}

/* ---------------- Text ---------------- */
export interface TextData {
  text: string;
  font: string;
  size: number;          // px
  color: RGB;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: 'left' | 'center' | 'right';
  leading: number;       // line height multiplier
  tracking: number;      // 1/1000 em
  box: { w: number; h: number } | null; // paragraph text box
  /** Anchor in document space: top-left of the frame (left), top-center (center) or top-right (right). For box text: top-left of the box. */
  ax: number;
  ay: number;
  /** Original pixels from PSD are shown until the text is edited */
  psdPixels?: boolean;
}

export function defaultText(): TextData {
  return {
    text: '', font: 'Arial', size: 48, ax: 0, ay: 0, color: { ...BLACK }, bold: false, italic: false, underline: false,
    align: 'left', leading: 1.2, tracking: 0, box: null,
  };
}

/* ---------------- Pixel surface ---------------- */
export const TILE = 256;

/** A canvas with an offset in document space. Tracks dirty tiles for history. */
export class Surface {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  /** Value outside of the canvas (used by masks: 0 = hidden, 255 = revealed). */
  fill: 0 | 255;
  dirty: Set<number> | 'all' = 'all';

  constructor(w: number, h: number, x = 0, y = 0, fill: 0 | 255 = 0) {
    this.canvas = createCanvas(w, h);
    this.x = x; this.y = y; this.fill = fill;
    if (fill === 255) {
      const c = this.ctx; c.fillStyle = '#fff'; c.fillRect(0, 0, w, h);
    }
  }

  get ctx() { return ctx2d(this.canvas); }
  get w() { return this.canvas.width; }
  get h() { return this.canvas.height; }
  get cols() { return Math.ceil(this.w / TILE); }
  get rows() { return Math.ceil(this.h / TILE); }
  bounds(): Rect { return { x: this.x, y: this.y, w: this.w, h: this.h }; }

  /** r in surface-local coordinates. No arg = everything. */
  markDirty(r?: Rect) {
    if (this.dirty === 'all') return;
    if (!r) { this.dirty = 'all'; return; }
    const c0 = Math.max(0, Math.floor(r.x / TILE)), c1 = Math.min(this.cols - 1, Math.floor((r.x + r.w - 1) / TILE));
    const r0 = Math.max(0, Math.floor(r.y / TILE)), r1 = Math.min(this.rows - 1, Math.floor((r.y + r.h - 1) / TILE));
    for (let ty = r0; ty <= r1; ty++) for (let tx = c0; tx <= c1; tx++) this.dirty.add(ty * this.cols + tx);
  }

  markDirtyDoc(r: Rect) { this.markDirty({ x: r.x - this.x, y: r.y - this.y, w: r.w, h: r.h }); }

  /** Grow canvas so that rect (document coordinates) is covered. Returns true if resized. */
  ensureCovers(r: Rect): boolean {
    const x0 = Math.min(this.x, Math.floor(r.x)), y0 = Math.min(this.y, Math.floor(r.y));
    const x1 = Math.max(this.x + this.w, Math.ceil(r.x + r.w)), y1 = Math.max(this.y + this.h, Math.ceil(r.y + r.h));
    if (x0 === this.x && y0 === this.y && x1 === this.x + this.w && y1 === this.y + this.h) return false;
    const c = createCanvas(x1 - x0, y1 - y0);
    const g = ctx2d(c);
    if (this.fill === 255) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.clearRect(this.x - x0, this.y - y0, this.w, this.h); }
    g.drawImage(this.canvas, this.x - x0, this.y - y0);
    this.canvas = c; this.x = x0; this.y = y0;
    this.dirty = 'all';
    return true;
  }

  replace(canvas: HTMLCanvasElement, x: number, y: number) {
    this.canvas = canvas; this.x = x; this.y = y; this.dirty = 'all';
  }
}

/* ---------------- Layer ---------------- */
export type LayerKind = 'raster' | 'text' | 'group';

export interface LayerMask extends Surface { enabled: boolean }

export class Layer {
  id = uid();
  kind: LayerKind;
  name: string;
  content: Surface;
  visible = true;
  opacity = 1;
  blend: BlendMode = 'normal';
  clipped = false;
  lockAlpha = false;
  mask: (Surface & { enabled: boolean }) | null = null;
  effects: LayerEffects = defaultEffects();
  text: TextData | null = null;
  children: Layer[] = [];
  parent: Layer | null = null;
  expanded = true;
  /** Incremented on any visual change (for thumbnails and render caches). */
  version = 0;

  constructor(kind: LayerKind, name: string, w = 1, h = 1, x = 0, y = 0) {
    this.kind = kind;
    this.name = name;
    this.content = new Surface(w, h, x, y);
    if (kind === 'group') this.blend = 'pass-through';
  }

  get canvas() { return this.content.canvas; }
  get x() { return this.content.x; }
  set x(v: number) { this.content.x = v; }
  get y() { return this.content.y; }
  set y(v: number) { this.content.y = v; }
  get isGroup() { return this.kind === 'group'; }

  touch() { this.version++; }

  addMask(docW: number, docH: number, fill: 0 | 255 = 255) {
    const b = this.content.bounds();
    const x0 = Math.min(0, b.x), y0 = Math.min(0, b.y);
    const x1 = Math.max(docW, b.x + b.w), y1 = Math.max(docH, b.y + b.h);
    const m = new Surface(x1 - x0, y1 - y0, x0, y0, fill) as Surface & { enabled: boolean };
    m.enabled = true;
    this.mask = m;
    this.touch();
    return m;
  }

  /** All descendants, depth-first, bottom to top. */
  *descendants(): Generator<Layer> {
    for (const c of this.children) {
      yield c;
      if (c.isGroup) yield* c.descendants();
    }
  }

  /** Is this layer visible including all ancestors. */
  get effectiveVisible(): boolean {
    let l: Layer | null = this;
    while (l) { if (!l.visible) return false; l = l.parent; }
    return true;
  }
}

export function newRasterLayer(name: string, w: number, h: number, x = 0, y = 0) {
  return new Layer('raster', name, w, h, x, y);
}
