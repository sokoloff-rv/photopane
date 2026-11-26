import { Layer, newRasterLayer } from './layer';
import { Selection } from './selection';
import { History } from './history';
import { createCanvas, ctx2d, uid } from './util';
import { compositeDocument } from './render';
import { RgbProfile, parseIcc, drawForDisplay } from './colormgmt';

export class Doc {
  id = uid();
  name: string;
  width: number;
  height: number;
  root: Layer;
  activeId = -1;
  /** Paint into the active layer's mask instead of its pixels. */
  editMask = false;
  selection: Selection | null = null;
  history: History;
  zoom = 1;
  panX = 0;
  panY = 0;
  fitted = false;
  /** View still follows the window size (until the user zooms or pans). */
  autoFit = false;
  /** Size of the view the pan was set for (another pane size keeps the same point in the middle). */
  viewW = 0;
  viewH = 0;
  fileHandle: any = null;
  fileName: string | null = null;
  /** EXIF segment of the original JPEG (orientation reset), kept for export. */
  exif: Uint8Array | null = null;
  /** Fonts used by imported text that the browser cannot see by name (see core/fonts). */
  missingFonts: { psName: string; family: string; bold: boolean; italic: boolean; weight?: number }[] = [];
  dirty = false;
  guides: { h: number[]; v: number[] } = { h: [], v: [] };

  private _composite: HTMLCanvasElement | null = null;
  private _compositeValid = false;
  private _display: HTMLCanvasElement | null = null;
  private _displayValid = false;
  /** Embedded ICC profile of the document (kept and written back to PSD) */
  iccProfile: Uint8Array | null = null;
  /** Parsed profile when it differs from sRGB; pixels stay in this space, the screen converts */
  colorProfile: RgbProfile | null = null;

  constructor(name: string, width: number, height: number) {
    this.name = name;
    this.width = width;
    this.height = height;
    this.root = new Layer('group', 'root');
    this.history = new History(this);
  }

  static blank(name: string, w: number, h: number, background: string | null): Doc {
    const d = new Doc(name, w, h);
    const l = newRasterLayer(background ? 'Background' : 'Layer 1', w, h);
    if (background) { const g = l.content.ctx; g.fillStyle = background; g.fillRect(0, 0, w, h); }
    d.add(l);
    return d;
  }

  static fromImage(name: string, img: CanvasImageSource & { width: number; height: number }): Doc {
    const w = img.width, h = img.height;
    const d = new Doc(name, w, h);
    const l = newRasterLayer('Background', w, h);
    l.content.ctx.drawImage(img, 0, 0);
    d.add(l);
    return d;
  }

  /* ---------- layer tree ---------- */
  get layers(): Layer[] { return [...this.root.descendants()]; }

  find(id: number): Layer | null {
    for (const l of this.root.descendants()) if (l.id === id) return l;
    return null;
  }

  get active(): Layer | null { return this.find(this.activeId); }

  setActive(l: Layer | null) {
    this.activeId = l ? l.id : -1;
    if (!l || !l.mask) this.editMask = false;
  }

  /** Insert layer above `ref` (same parent), or at the top of root. If ref is an expanded group, inserts inside it. */
  add(layer: Layer, ref: Layer | null = this.active, inside = false) {
    let parent = this.root, index = this.root.children.length;
    if (ref) {
      if (ref.isGroup && (inside || ref.expanded) && ref !== this.root) {
        parent = ref; index = ref.children.length;
      } else if (ref.parent) {
        parent = ref.parent; index = parent.children.indexOf(ref) + 1;
      }
    }
    parent.children.splice(index, 0, layer);
    layer.parent = parent;
    this.setActive(layer);
    this.invalidate();
    return layer;
  }

  remove(layer: Layer) {
    const p = layer.parent;
    if (!p) return;
    const i = p.children.indexOf(layer);
    p.children.splice(i, 1);
    layer.parent = null;
    if (this.activeId === layer.id || !this.active) {
      const next = p.children[Math.min(i, p.children.length - 1)] ?? (p !== this.root ? p : this.root.children[this.root.children.length - 1]);
      this.setActive(next ?? null);
    }
    this.invalidate();
  }

  /** Move layer into parent at index (index in parent's children after removal). */
  move(layer: Layer, parent: Layer, index: number) {
    // prevent moving a group into itself
    for (let p: Layer | null = parent; p; p = p.parent) if (p === layer) return;
    const op = layer.parent!;
    const oi = op.children.indexOf(layer);
    op.children.splice(oi, 1);
    if (op === parent && oi < index) index--;
    index = Math.max(0, Math.min(parent.children.length, index));
    parent.children.splice(index, 0, layer);
    layer.parent = parent;
    this.invalidate();
  }

  /** Layer index among siblings shifted by delta (+1 = up). */
  shift(layer: Layer, delta: number) {
    const p = layer.parent!;
    const i = p.children.indexOf(layer);
    const j = Math.max(0, Math.min(p.children.length - 1, i + delta));
    if (i === j) return;
    p.children.splice(i, 1);
    p.children.splice(j, 0, layer);
    this.invalidate();
  }

  /* ---------- composite ---------- */
  /** Bumped on every content change (caches keyed on the picture, e.g. the scaled view) */
  version = 0;
  invalidate() { this._compositeValid = false; this._displayValid = false; this._dirty = null; this._displayDirty = null; this.version++; }

  /**
   * Only this rectangle changed (a brush dab): the next composite() redraws just that part instead of the
   * whole picture, which keeps painting smooth on large images.
   */
  invalidateRect(r: { x: number; y: number; w: number; h: number }) {
    if (this._compositeValid) {
      const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
      const x1 = Math.min(this.width, Math.ceil(r.x + r.w)), y1 = Math.min(this.height, Math.ceil(r.y + r.h));
      if (x1 > x0 && y1 > y0) {
        const d = this._dirty;
        this._dirty = d
          ? { x: Math.min(d.x, x0), y: Math.min(d.y, y0), w: Math.max(d.x + d.w, x1) - Math.min(d.x, x0), h: Math.max(d.y + d.h, y1) - Math.min(d.y, y0) }
          : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
    }
    // a colour-managed picture: its screen copy is converted again only where the composite changed
    const b = this._dirty;
    if (this.colorProfile && this._displayValid && b) {
      const a = this._displayDirty;
      if (!a) this._displayDirty = { ...b };
      else {
        const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
        this._displayDirty = { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
      }
    } else { this._displayValid = false; this._displayDirty = null; }
    this.version++;
  }
  private _dirty: { x: number; y: number; w: number; h: number } | null = null;
  /** Part of the screen copy of a colour-managed picture still to convert (see displayComposite). */
  private _displayDirty: { x: number; y: number; w: number; h: number } | null = null;

  setIccProfile(bytes: Uint8Array | null | undefined) {
    // kept as given: history compares the object to know whether the profile changed
    this.iccProfile = bytes ?? null;
    this.colorProfile = parseIcc(this.iccProfile);
    this._displayValid = false;
    this.version++;
  }

  /** Composite converted to sRGB for the screen (same canvas as composite() when the document is sRGB). */
  displayComposite(): HTMLCanvasElement {
    const comp = this.composite();
    if (!this.colorProfile) return comp;
    if (!this._display || this._display.width !== comp.width || this._display.height !== comp.height) {
      this._display = createCanvas(comp.width, comp.height);
      this._displayValid = false;
    }
    const part = this._displayDirty;
    this._displayDirty = null;
    if (!this._displayValid) {
      drawForDisplay(comp, this._display, this.colorProfile);
      this._displayValid = true;
    } else if (part) {
      // a brush changed a small part: convert just that, not the whole picture on every frame
      const src = createCanvas(part.w, part.h), out = createCanvas(part.w, part.h);
      ctx2d(src).drawImage(comp, part.x, part.y, part.w, part.h, 0, 0, part.w, part.h);
      drawForDisplay(src, out, this.colorProfile);
      const g = ctx2d(this._display);
      g.save(); g.globalCompositeOperation = 'copy';
      g.beginPath(); g.rect(part.x, part.y, part.w, part.h); g.clip();
      g.drawImage(out, part.x, part.y);
      g.restore();
    }
    return this._display;
  }

  composite(): HTMLCanvasElement {
    if (!this._composite || this._composite.width !== this.width || this._composite.height !== this.height) {
      this._composite = createCanvas(this.width, this.height);
      this._compositeValid = false;
    }
    if (!this._compositeValid) {
      const g = ctx2d(this._composite);
      g.clearRect(0, 0, this.width, this.height);
      compositeDocument(this, g);
      this._compositeValid = true;
      this._dirty = null;
    } else if (this._dirty) {
      // only the changed part: the same drawing, clipped to it
      const r = this._dirty, g = ctx2d(this._composite);
      this._dirty = null;
      g.save();
      g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
      g.clearRect(r.x, r.y, r.w, r.h);
      compositeDocument(this, g);
      g.restore();
    }
    return this._composite;
  }

  /**
   * The composite for reading pixels (eyedropper, magic wand, fill, magnetic lasso). Reading the composite
   * canvas itself makes the browser move it out of GPU memory, after which every redraw of a large picture
   * uploads it again; this CPU copy is refreshed only when the picture has changed.
   */
  compositeRead(): CanvasRenderingContext2D {
    const r = this._read;
    if (r && r.ver === this.version && r.g.canvas.width === this.width && r.g.canvas.height === this.height) return r.g;
    const c = r?.g.canvas.width === this.width && r.g.canvas.height === this.height ? r.g.canvas as HTMLCanvasElement : createCanvas(this.width, this.height);
    const g = r?.g.canvas === c ? r.g : c.getContext('2d', { willReadFrequently: true })!;
    g.clearRect(0, 0, this.width, this.height);
    g.drawImage(this.composite(), 0, 0);
    this._read = { g, ver: this.version };
    return g;
  }
  private _read: { g: CanvasRenderingContext2D; ver: number } | null = null;

  /** Layer rendered into a document-sized canvas (without effects, with mask). */
  layerImageData(l: Layer): ImageData {
    // kept while the layer is unchanged (several magic wand clicks read it once); one copy for all documents
    const k = layerRead;
    if (k && k.layer === l && k.canvas === l.canvas && k.ver === l.version && k.x === l.x && k.y === l.y && k.img.width === this.width && k.img.height === this.height) return k.img;
    const img = layerPixels(l, this.width, this.height);
    layerRead = { layer: l, canvas: l.canvas, ver: l.version, x: l.x, y: l.y, img };
    return img;
  }
}

/** Independent copy of a document including its whole history (used by Compare). */
export function cloneDoc(src: Doc, name: string): Doc {
  const d = new Doc(name, src.width, src.height);
  d.history.adopt(src.history);
  d.zoom = src.zoom; d.panX = src.panX; d.panY = src.panY; d.fitted = src.fitted; d.autoFit = src.autoFit;
  d.viewW = src.viewW; d.viewH = src.viewH;
  d.exif = src.exif;
  d.missingFonts = src.missingFonts.map(f => ({ ...f }));
  d.guides = { h: [...src.guides.h], v: [...src.guides.v] };
  if (src.iccProfile) d.setIccProfile(src.iccProfile);
  d.dirty = true;
  d.invalidate();
  return d;
}

let layerRead: { layer: Layer; canvas: HTMLCanvasElement; ver: number; x: number; y: number; img: ImageData } | null = null;
/** A document closed: its layer copy for the magic wand (if any) must not keep the layers alive. */
export function forgetLayerRead() { layerRead = null; }

/** A layer's pixels placed in a document-sized image (read through a CPU copy, see readPixels). */
function layerPixels(l: Layer, W: number, H: number): ImageData {
  const c = createCanvas(W, H);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(l.canvas, l.x, l.y);
  return g.getImageData(0, 0, W, H);
}
