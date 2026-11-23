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
  invalidate() { this._compositeValid = false; this._displayValid = false; this.version++; }

  setIccProfile(bytes: Uint8Array | null | undefined) {
    this.iccProfile = bytes ? new Uint8Array(bytes) : null;
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
    if (!this._displayValid) {
      drawForDisplay(comp, this._display, this.colorProfile);
      this._displayValid = true;
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
    }
    return this._composite;
  }

  /** Layer rendered into a document-sized canvas (without effects, with mask). */
  layerImageData(l: Layer): ImageData {
    const c = createCanvas(this.width, this.height);
    const g = ctx2d(c);
    g.drawImage(l.canvas, l.x, l.y);
    return g.getImageData(0, 0, this.width, this.height);
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
