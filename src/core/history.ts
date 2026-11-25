import { Layer, Surface, TILE, LayerKind, BlendMode, LayerEffects, TextData } from './layer';
import { Selection } from './selection';
import { createCanvas, ctx2d, uid, readPixels } from './util';
import type { Doc } from './document';

type Tile = ImageData | null;

interface SurfSnap { x: number; y: number; w: number; h: number; fill: 0 | 255; tiles: Tile[]; enabled?: boolean }

interface LayerSnap {
  id: number; kind: LayerKind; name: string; visible: boolean; opacity: number; blend: BlendMode;
  clipped: boolean; lockAlpha: boolean; expanded: boolean; effects: string; text: string | null;
  content: SurfSnap; mask: SurfSnap | null; children: LayerSnap[];
}

interface DocSnap {
  w: number; h: number; layers: LayerSnap[]; activeId: number; editMask: boolean;
  sel: Uint32Array | null; selObj: Selection | null;
}

export interface HistoryEntry { label: string; snap: DocSnap; bytes: number }

const MAX_STEPS = 100;
const MAX_BYTES = 1.5 * 1024 * 1024 * 1024;

export class History {
  entries: HistoryEntry[] = [];
  index = -1;
  private cache = new WeakMap<Surface, SurfSnap>();
  private newBytes = 0;

  constructor(private doc: Doc) {}

  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.entries.length - 1; }

  push(label: string) {
    this.newBytes = 0;
    const snap = this.snapshot();
    this.entries.splice(this.index + 1);
    this.entries.push({ label, snap, bytes: this.newBytes });
    this.index = this.entries.length - 1;
    // keep live selection objects only for recent steps (they hold document-sized canvases)
    for (let i = 0; i < this.entries.length - 3; i++) this.entries[i].snap.selObj = null;
    this.trim();
  }

  /** Replace the label/state of the current step (used for continuous edits). */
  amend(label?: string) {
    if (this.index < 0) return this.push(label || '');
    this.newBytes = 0;
    const e = this.entries[this.index];
    e.snap = this.snapshot();
    e.bytes += this.newBytes;
    if (label) e.label = label;
  }

  private trim() {
    while (this.entries.length > MAX_STEPS) { this.entries.shift(); this.index--; }
    let total = this.entries.reduce((s, e) => s + e.bytes, 0);
    while (total > MAX_BYTES && this.entries.length > 5) {
      total -= this.entries[0].bytes;
      this.entries.shift(); this.index--;
    }
  }

  /**
   * Take over a copy of another document's history (Compare): the steps share their immutable tiles,
   * layer ids are remapped so both documents stay independent, and the current step is restored here.
   */
  adopt(src: History) {
    const ids = new Map<number, number>();
    const id = (n: number) => { let v = ids.get(n); if (v === undefined) { v = uid(); ids.set(n, v); } return v; };
    const layer = (l: LayerSnap): LayerSnap => ({ ...l, id: id(l.id), children: l.children.map(layer) });
    this.entries = src.entries.map(e => ({
      label: e.label, bytes: e.bytes,
      snap: { ...e.snap, layers: e.snap.layers.map(layer), activeId: e.snap.activeId >= 0 ? id(e.snap.activeId) : -1, selObj: null },
    }));
    this.index = src.index;
    if (this.index >= 0) this.restore(this.entries[this.index].snap);
  }

  undo() { if (this.canUndo) this.goto(this.index - 1); }
  redo() { if (this.canRedo) this.goto(this.index + 1); }

  goto(i: number) {
    if (i < 0 || i >= this.entries.length || i === this.index) return;
    this.index = i;
    this.restore(this.entries[i].snap);
  }

  /* ---------------- snapshot ---------------- */
  private snapSurface(s: Surface): SurfSnap {
    const prev = this.cache.get(s);
    let tiles: Tile[];
    const cols = s.cols, rows = s.rows;
    const sameGeom = prev && prev.w === s.w && prev.h === s.h && s.dirty !== 'all';
    if (sameGeom && (s.dirty as Set<number>).size === 0) {
      tiles = prev!.tiles;
    } else {
      tiles = sameGeom ? prev!.tiles.slice() : new Array(cols * rows).fill(null);
      const indices = sameGeom ? [...(s.dirty as Set<number>)] : [...Array(cols * rows).keys()];
      // one read of the area the changed tiles cover (through a CPU copy, so the layer stays on the GPU)
      let bx0 = Infinity, by0 = Infinity, bx1 = 0, by1 = 0;
      for (const idx of indices) {
        const x = (idx % cols) * TILE, y = Math.floor(idx / cols) * TILE;
        bx0 = Math.min(bx0, x); by0 = Math.min(by0, y);
        bx1 = Math.max(bx1, Math.min(s.w, x + TILE)); by1 = Math.max(by1, Math.min(s.h, y + TILE));
      }
      const area = indices.length && bx1 > bx0 && by1 > by0 ? readPixels(s.canvas, bx0, by0, bx1 - bx0, by1 - by0) : null;
      const AW = bx1 - bx0;
      for (const idx of indices) {
        const tx = idx % cols, ty = Math.floor(idx / cols);
        const x = tx * TILE, y = ty * TILE;
        const w = Math.min(TILE, s.w - x), h = Math.min(TILE, s.h - y);
        if (w <= 0 || h <= 0 || !area) continue;
        const img = new ImageData(w, h);
        for (let r = 0; r < h; r++) {
          const o = ((y - by0 + r) * AW + (x - bx0)) * 4;
          img.data.set(area.data.subarray(o, o + w * 4), r * w * 4);
        }
        const d = img.data;
        let empty = true;
        for (let k = 3; k < d.length; k += 4) if (d[k]) { empty = false; break; }
        tiles[idx] = empty ? null : img;
        if (!empty) this.newBytes += d.length;
      }
    }
    const snap: SurfSnap = { x: s.x, y: s.y, w: s.w, h: s.h, fill: s.fill, tiles };
    this.cache.set(s, snap);
    s.dirty = new Set();
    return snap;
  }

  private snapLayer(l: Layer): LayerSnap {
    let mask: SurfSnap | null = null;
    if (l.mask) { mask = { ...this.snapSurface(l.mask), enabled: l.mask.enabled }; }
    return {
      id: l.id, kind: l.kind, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend,
      clipped: l.clipped, lockAlpha: l.lockAlpha, expanded: l.expanded,
      effects: JSON.stringify(l.effects), text: l.text ? JSON.stringify(l.text) : null,
      content: this.snapSurface(l.content), mask,
      children: l.children.map(c => this.snapLayer(c)),
    };
  }

  private snapshot(): DocSnap {
    const d = this.doc;
    let sel: Uint32Array | null = null;
    const prevSel = this.index >= 0 ? this.entries[this.index]?.snap : undefined;
    if (d.selection) {
      if (prevSel && prevSel.selObj === d.selection) sel = prevSel.sel;
      else { sel = d.selection.rle(); this.newBytes += sel.byteLength; }
    }
    return {
      w: d.width, h: d.height, layers: d.root.children.map(l => this.snapLayer(l)),
      activeId: d.activeId, editMask: d.editMask, sel, selObj: d.selection,
    };
  }

  /* ---------------- restore ---------------- */
  private restoreSurface(s: Surface | null, snap: SurfSnap): Surface {
    const cached = s ? this.cache.get(s) : undefined;
    if (s && cached && cached.w === snap.w && cached.h === snap.h && s.w === snap.w && s.h === snap.h && s.dirty !== 'all') {
      const g = s.ctx;
      const dirty = s.dirty as Set<number>;
      for (let i = 0; i < snap.tiles.length; i++) {
        if (cached.tiles[i] === snap.tiles[i] && !dirty.has(i)) continue;
        this.putTile(g, snap, i);
      }
    } else {
      if (!s) s = new Surface(snap.w, snap.h, snap.x, snap.y, snap.fill);
      const c = createCanvas(snap.w, snap.h);
      const g = ctx2d(c);
      for (let i = 0; i < snap.tiles.length; i++) if (snap.tiles[i]) this.putTile(g, snap, i);
      s.canvas = c;
    }
    s.x = snap.x; s.y = snap.y; s.fill = snap.fill;
    s.dirty = new Set();
    this.cache.set(s, snap);
    return s;
  }

  private putTile(g: CanvasRenderingContext2D, snap: SurfSnap, i: number) {
    const cols = Math.ceil(snap.w / TILE);
    const x = (i % cols) * TILE, y = Math.floor(i / cols) * TILE;
    const t = snap.tiles[i];
    if (t) g.putImageData(t, x, y);
    else g.clearRect(x, y, TILE, TILE);
  }

  private restoreLayer(snap: LayerSnap, existing: Map<number, Layer>, parent: Layer): Layer {
    let l = existing.get(snap.id);
    if (!l) { l = new Layer(snap.kind, snap.name); l.id = snap.id; }
    l.kind = snap.kind; l.name = snap.name; l.visible = snap.visible; l.opacity = snap.opacity;
    l.blend = snap.blend; l.clipped = snap.clipped; l.lockAlpha = snap.lockAlpha; l.expanded = snap.expanded;
    l.effects = JSON.parse(snap.effects) as LayerEffects;
    l.text = snap.text ? (JSON.parse(snap.text) as TextData) : null;
    l.content = this.restoreSurface(existing.has(snap.id) ? l.content : null, snap.content);
    if (snap.mask) {
      const m = this.restoreSurface(l.mask, snap.mask) as Surface & { enabled: boolean };
      m.enabled = !!snap.mask.enabled;
      l.mask = m;
    } else l.mask = null;
    l.parent = parent;
    l.children = snap.children.map(c => this.restoreLayer(c, existing, l!));
    l.touch();
    return l;
  }

  private restore(snap: DocSnap) {
    const d = this.doc;
    const existing = new Map<number, Layer>();
    for (const l of d.root.descendants()) existing.set(l.id, l);
    d.width = snap.w; d.height = snap.h;
    d.root.children = snap.layers.map(s => this.restoreLayer(s, existing, d.root));
    d.activeId = snap.activeId;
    d.editMask = snap.editMask;
    if (snap.selObj && snap.selObj.width === snap.w && snap.selObj.height === snap.h) d.selection = snap.selObj;
    else d.selection = snap.sel ? Selection.fromRle(snap.sel, snap.w, snap.h) : null;
    snap.selObj = d.selection;
    if (!d.find(d.activeId)) d.activeId = d.root.children[d.root.children.length - 1]?.id ?? -1;
  }
}
