import { app } from '../app';
import { t } from '../i18n';
import { Tool, PEvent } from './tool';
import { Layer, Surface } from '../core/layer';
import { Selection } from '../core/selection';
import { createCanvas, ctx2d, cloneCanvas, Rect, alphaBounds } from '../core/util';
import { previews } from '../core/render';
import { layerBounds } from '../core/ops';
import { P, Quad, homography, applyH, rectQuad, quadBounds, pointInPoly, isParallelogram, warp, drawMesh, H } from '../core/geom';
import { numberField, iconButton, sep } from '../ui/controls';
import { toast } from '../ui/dialog';

interface Item { layer: Layer; surface: Surface | null; src: HTMLCanvasElement; sx: number; sy: number; kind: 'content' | 'mask' | 'float' | 'sel' }
interface Affine { cx: number; cy: number; sx: number; sy: number; rot: number }

const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M5 12a7 7 0 1 1 7 7" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round"/><path d="M5 12a7 7 0 1 1 7 7" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><path d="M2 9l3 4 3-4" fill="#fff" stroke="#000" stroke-width="1"/></svg>')}") 12 12, crosshair`;

const HANDLES: [number, number][] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

export class TransformTool extends Tool {
  readonly id = 'transform';
  readonly iconName = 'move';
  cursor = 'default';
  active = false;
  private selOnly = false;
  private items: Item[] = [];
  private B: Rect = { x: 0, y: 0, w: 1, h: 1 };
  private quad: Quad = rectQuad({ x: 0, y: 0, w: 1, h: 1 });
  private aff: Affine | null = null;
  private floatInfo: { layer: Layer; backup: HTMLCanvasElement; bx: number; by: number; sel: Selection } | null = null;
  private maskStates: { s: Layer; enabled: boolean }[] = [];
  private drag: { kind: 'move' | 'rotate' | 'handle'; h?: number; start: P; quad: Quad; aff: Affine | null; ctrl: boolean; perspective: boolean } | null = null;

  constructor() { super({}); }

  /** Prepare a transform of the active layer or selection. Returns false if nothing to transform. */
  begin(selOnly = false): boolean {
    const d = app.doc;
    const l = d?.active;
    if (!d || (!l && !selOnly)) return false;
    this.items = [];
    this.floatInfo = null;
    this.maskStates = [];
    this.selOnly = selOnly;
    if (selOnly) {
      if (!d.selection) return false;
      this.items.push({ layer: d.root, surface: null, src: d.selection.mask, sx: 0, sy: 0, kind: 'sel' });
      this.B = { ...d.selection.bounds };
      app.hideSelection = true;
    } else if (!l) return false;
    else if (l.kind === 'text') { app.askRasterize(); return false; }
    if (selOnly) { /* set up above */ }
    else if (d.selection && !l!.isGroup && !(d.editMask && l!.mask)) {
      const sel = d.selection;
      const fc = createCanvas(sel.bounds.w, sel.bounds.h);
      const g = ctx2d(fc);
      g.drawImage(l!.canvas, l!.x - sel.bounds.x, l!.y - sel.bounds.y);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(sel.mask, -sel.bounds.x, -sel.bounds.y);
      const ab = alphaBounds(fc);
      if (!ab) { toast(t('app.emptyArea')); return false; }
      const piece = createCanvas(ab.w, ab.h);
      ctx2d(piece).drawImage(fc, -ab.x, -ab.y);
      const backup = cloneCanvas(l!.canvas);
      this.floatInfo = { layer: l!, backup, bx: l!.x, by: l!.y, sel };
      const lg = l!.content.ctx;
      lg.globalCompositeOperation = 'destination-out';
      lg.drawImage(sel.mask, -l!.x, -l!.y);
      lg.globalCompositeOperation = 'source-over';
      this.items.push({ layer: l!, surface: null, src: piece, sx: sel.bounds.x + ab.x, sy: sel.bounds.y + ab.y, kind: 'float' });
      this.B = { x: sel.bounds.x + ab.x, y: sel.bounds.y + ab.y, w: ab.w, h: ab.h };
    } else if (d.editMask && l!.mask) {
      const m = l!.mask;
      this.items.push({ layer: l!, surface: m, src: m.canvas, sx: m.x, sy: m.y, kind: 'mask' });
      this.B = layerBounds(l!) || m.bounds();
    } else {
      const L = l!;
      const b = layerBounds(L);
      if (!b) { toast(t('app.emptyArea')); return false; }
      this.B = b;
      const layers = L.isGroup ? [...L.descendants()] : [L];
      for (const x of layers) {
        if (!x.isGroup) this.items.push({ layer: x, surface: x.content, src: x.canvas, sx: x.x, sy: x.y, kind: 'content' });
        if (x.mask) this.items.push({ layer: x, surface: x.mask, src: x.mask.canvas, sx: x.mask.x, sy: x.mask.y, kind: 'mask' });
      }
      if (L.isGroup && L.mask) this.items.push({ layer: L, surface: L.mask, src: L.mask.canvas, sx: L.mask.x, sy: L.mask.y, kind: 'mask' });
    }
    // masks are hidden while the preview is shown
    for (const it of this.items) if (it.kind === 'mask' && it.layer.mask) { this.maskStates.push({ s: it.layer, enabled: it.layer.mask.enabled }); it.layer.mask.enabled = false; }
    const B = this.B;
    this.aff = { cx: B.x + B.w / 2, cy: B.y + B.h / 2, sx: 1, sy: 1, rot: 0 };
    this.quad = this.quadFromAffine(this.aff);
    this.active = true;
    this.installPreview();
    app.update('canvas', 'overlay');
    return true;
  }

  private quadFromAffine(a: Affine): Quad {
    const ex = { x: Math.cos(a.rot), y: Math.sin(a.rot) }, ey = { x: -Math.sin(a.rot), y: Math.cos(a.rot) };
    const W = this.B.w * a.sx / 2, Hh = this.B.h * a.sy / 2;
    const pt = (u: number, v: number) => ({ x: a.cx + ex.x * u * W + ey.x * v * Hh, y: a.cy + ex.y * u * W + ey.y * v * Hh });
    return [pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1)];
  }

  private matrix(): DOMMatrix {
    const a = this.aff!, B = this.B;
    return new DOMMatrix().translate(a.cx, a.cy).rotate(a.rot * 180 / Math.PI).scale(a.sx, a.sy).translate(-B.w / 2, -B.h / 2).translate(-B.x, -B.y);
  }

  private hom(): H { return homography(rectQuad(this.B), this.quad); }

  private drawItem(g: CanvasRenderingContext2D, it: Item) {
    g.save();
    g.imageSmoothingQuality = 'high';
    if (this.aff) {
      g.setTransform(this.matrix().translate(it.sx, it.sy));
      g.drawImage(it.src, 0, 0);
    } else drawMesh(g, it.src, it.sx, it.sy, this.hom(), 14);
    g.restore();
  }

  private installPreview() {
    const byLayer = new Map<Layer, Item[]>();
    for (const it of this.items) if (it.kind === 'content' || it.kind === 'float') { const a = byLayer.get(it.layer) || []; a.push(it); byLayer.set(it.layer, a); }
    for (const [l, its] of byLayer) {
      previews.set(l.id, g => {
        if (this.floatInfo) g.drawImage(l.canvas, l.x, l.y);
        for (const it of its) this.drawItem(g, it);
      });
    }
  }

  private removePreview() {
    for (const it of this.items) previews.delete(it.layer.id);
    for (const m of this.maskStates) if (m.s.mask) m.s.mask.enabled = m.enabled;
  }

  /* ---------------- commit / cancel ---------------- */
  apply(pop = true) {
    if (!this.active) return;
    this.active = false;
    this.removePreview();
    const d = app.doc!;
    const affine = !!this.aff;
    const M = affine ? this.matrix() : null;
    const hInv = affine ? null : homography(this.quad, rectQuad(this.B));
    const xform = (src: HTMLCanvasElement, sx: number, sy: number, fill: 0 | 255): { c: HTMLCanvasElement; x: number; y: number } => {
      const corners = rectQuad({ x: sx, y: sy, w: src.width, h: src.height });
      const dq = affine ? corners.map(p => new DOMPoint(p.x, p.y).matrixTransform(M!)) : corners.map(p => applyH(this.hom(), p.x, p.y));
      let r = quadBounds(dq);
      if (fill === 255) r = unionRect(r, { x: 0, y: 0, w: d.width, h: d.height });
      let c: HTMLCanvasElement;
      if (affine) {
        c = createCanvas(r.w, r.h);
        const g = ctx2d(c);
        g.imageSmoothingQuality = 'high';
        g.setTransform(new DOMMatrix().translate(-r.x, -r.y).multiply(M!).translate(sx, sy));
        g.drawImage(src, 0, 0);
      } else c = warp(src, sx, sy, hInv!, r);
      if (fill === 255) {
        // revealed area outside the transformed mask
        const w = createCanvas(r.w, r.h), g = ctx2d(w);
        g.fillStyle = '#fff'; g.fillRect(0, 0, r.w, r.h);
        g.globalCompositeOperation = 'destination-out';
        g.beginPath(); dq.forEach((p, i) => (i ? g.lineTo(p.x - r.x, p.y - r.y) : g.moveTo(p.x - r.x, p.y - r.y))); g.closePath(); g.fill();
        g.globalCompositeOperation = 'source-over';
        g.drawImage(c, 0, 0);
        c = w;
      }
      return { c, x: r.x, y: r.y };
    };
    for (const it of this.items) {
      if (it.kind === 'sel') {
        const res = xform(it.src, 0, 0, 0);
        const m = createCanvas(d.width, d.height);
        ctx2d(m).drawImage(res.c, res.x, res.y);
        d.selection = Selection.fromMask(m);
        continue;
      }
      if (it.kind === 'float') {
        const fi = this.floatInfo!;
        const res = xform(it.src, it.sx, it.sy, 0);
        fi.layer.content.ensureCovers({ x: res.x, y: res.y, w: res.c.width, h: res.c.height });
        fi.layer.content.ctx.drawImage(res.c, res.x - fi.layer.x, res.y - fi.layer.y);
        fi.layer.content.markDirty();
        // transform the selection too
        const sres = xform(fi.sel.mask, 0, 0, 0);
        const m = createCanvas(d.width, d.height);
        ctx2d(m).drawImage(sres.c, sres.x, sres.y);
        d.selection = Selection.fromMask(m);
      } else if (it.surface) {
        const res = xform(it.src, it.sx, it.sy, it.surface.fill);
        it.surface.replace(res.c, res.x, res.y);
      }
      it.layer.touch();
    }
    this.items = [];
    app.hideSelection = false;
    app.commit(this.selOnly ? 'cmd.transformSel' : 'cmd.freeTransform');
    if (pop) app.popTool();
  }

  cancel() {
    if (!this.active) return;
    this.active = false;
    this.removePreview();
    if (this.floatInfo) {
      const fi = this.floatInfo;
      fi.layer.content.replace(fi.backup, fi.bx, fi.by);
      fi.layer.content.dirty = 'all';
      fi.layer.touch();
    }
    this.items = [];
    app.hideSelection = false;
    app.update('canvas', 'overlay');
    if (app.tool === this) app.popTool();
  }

  deactivate() { if (this.active) this.apply(false); }
  busy() { return this.active; }

  /* ---------------- interaction ---------------- */
  private handlePoints(): P[] {
    const q = this.quad;
    const mid = (a: P, b: P) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    return [q[0], mid(q[0], q[1]), q[1], mid(q[1], q[2]), q[2], mid(q[2], q[3]), q[3], mid(q[3], q[0])];
  }

  private hit(e: PEvent): { kind: 'handle'; h: number } | { kind: 'move' } | { kind: 'rotate' } {
    const v = app.viewport;
    const hp = this.handlePoints().map(p => v.toScreen(p.x, p.y));
    for (let i = 0; i < hp.length; i++) if (Math.hypot(hp[i].x - e.sx, hp[i].y - e.sy) < 8) return { kind: 'handle', h: i };
    if (pointInPoly({ x: e.x, y: e.y }, this.quad)) return { kind: 'move' };
    return { kind: 'rotate' };
  }

  hover(e: PEvent) {
    if (!this.active) return;
    const h = this.hit(e);
    let c = 'default';
    if (h.kind === 'move') c = 'move';
    else if (h.kind === 'rotate') c = ROTATE_CURSOR;
    else {
      const hp = this.handlePoints();
      const center = { x: (this.quad[0].x + this.quad[2].x) / 2, y: (this.quad[0].y + this.quad[2].y) / 2 };
      const p = hp[h.h];
      const ang = ((Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI + 360) % 180;
      c = ang < 22.5 || ang >= 157.5 ? 'ew-resize' : ang < 67.5 ? 'nwse-resize' : ang < 112.5 ? 'ns-resize' : 'nesw-resize';
      if (e.ctrl) c = 'crosshair';
    }
    if (c !== this.cursor) { this.cursor = c; app.viewport.updateCursor(); }
  }

  down(e: PEvent) {
    if (!this.active) return;
    const h = this.hit(e);
    this.drag = {
      kind: h.kind, h: h.kind === 'handle' ? h.h : undefined, start: { x: e.x, y: e.y },
      quad: this.quad.map(p => ({ ...p })) as Quad, aff: this.aff ? { ...this.aff } : null,
      ctrl: e.ctrl, perspective: e.ctrl && e.alt && e.shift,
    };
  }

  move(e: PEvent) {
    const dr = this.drag;
    if (!dr) return;
    const dx = e.x - dr.start.x, dy = e.y - dr.start.y;
    if (dr.kind === 'move') {
      this.quad = dr.quad.map(p => ({ x: p.x + dx, y: p.y + dy })) as Quad;
      if (this.aff && dr.aff) { this.aff.cx = dr.aff.cx + dx; this.aff.cy = dr.aff.cy + dy; }
    } else if (dr.kind === 'rotate') {
      const c = dr.aff ? { x: dr.aff.cx, y: dr.aff.cy } : { x: (dr.quad[0].x + dr.quad[2].x) / 2, y: (dr.quad[0].y + dr.quad[2].y) / 2 };
      let da = Math.atan2(e.y - c.y, e.x - c.x) - Math.atan2(dr.start.y - c.y, dr.start.x - c.x);
      if (dr.aff && this.aff) {
        let r = dr.aff.rot + da;
        if (e.shift) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12);
        this.aff.rot = r;
        this.quad = this.quadFromAffine(this.aff);
      } else {
        if (e.shift) da = Math.round(da / (Math.PI / 12)) * (Math.PI / 12);
        const cs = Math.cos(da), sn = Math.sin(da);
        this.quad = dr.quad.map(p => ({ x: c.x + (p.x - c.x) * cs - (p.y - c.y) * sn, y: c.y + (p.x - c.x) * sn + (p.y - c.y) * cs })) as Quad;
      }
    } else {
      const hi = dr.h!;
      const corner = hi % 2 === 0;
      const qi = [0, -1, 1, -1, 2, -1, 3, -1][hi];
      if (dr.ctrl || !this.aff) {
        // distort / skew / perspective — free quad
        this.aff = null;
        const q = dr.quad.map(p => ({ ...p })) as Quad;
        if (corner) {
          if (dr.perspective) {
            // move the neighbouring corner on the same edge in the opposite direction
            const horiz = Math.abs(dx) > Math.abs(dy);
            const nb = horiz ? [1, 0, 3, 2][qi] : [3, 2, 1, 0][qi];
            q[qi] = { x: q[qi].x + (horiz ? dx : 0), y: q[qi].y + (horiz ? 0 : dy) };
            q[nb] = { x: q[nb].x - (horiz ? dx : 0), y: q[nb].y - (horiz ? 0 : dy) };
          } else q[qi] = { x: q[qi].x + dx, y: q[qi].y + dy };
        } else {
          const edge = [[0, 1], [1, 2], [2, 3], [3, 0]][(hi - 1) / 2];
          for (const k of edge) q[k] = { x: q[k].x + dx, y: q[k].y + dy };
        }
        this.quad = q;
      } else {
        this.scaleAffine(dr.aff!, HANDLES[hi], { x: e.x, y: e.y }, corner && !e.shift, e.alt);
        this.quad = this.quadFromAffine(this.aff);
      }
    }
    app.update('canvas', 'options');
  }

  private scaleAffine(a0: Affine, [hx, hy]: [number, number], p: P, proportional: boolean, fromCenter: boolean) {
    const ex = { x: Math.cos(a0.rot), y: Math.sin(a0.rot) }, ey = { x: -Math.sin(a0.rot), y: Math.cos(a0.rot) };
    const W = this.B.w * a0.sx, Hh = this.B.h * a0.sy;
    const anchor = fromCenter ? { x: a0.cx, y: a0.cy }
      : { x: a0.cx - ex.x * hx * W / 2 - ey.x * hy * Hh / 2, y: a0.cy - ex.y * hx * W / 2 - ey.y * hy * Hh / 2 };
    const d = { x: p.x - anchor.x, y: p.y - anchor.y };
    const lx = d.x * ex.x + d.y * ex.y, ly = d.x * ey.x + d.y * ey.y;
    const f = fromCenter ? 2 : 1;
    let W2 = W, H2 = Hh;
    if (proportional) {
      const hv = { x: hx * W / f, y: hy * Hh / f };
      const k = (lx * hv.x + ly * hv.y) / (hv.x * hv.x + hv.y * hv.y || 1);
      W2 = W * k; H2 = Hh * k;
    } else {
      if (hx) W2 = (f * lx) / hx;
      if (hy) H2 = (f * ly) / hy;
    }
    if (Math.abs(W2) < 1) W2 = Math.sign(W2 || 1);
    if (Math.abs(H2) < 1) H2 = Math.sign(H2 || 1);
    const c = fromCenter ? anchor : { x: anchor.x + ex.x * hx * W2 / 2 + ey.x * hy * H2 / 2, y: anchor.y + ex.y * hx * W2 / 2 + ey.y * hy * H2 / 2 };
    this.aff = { cx: c.x, cy: c.y, sx: W2 / this.B.w, sy: H2 / this.B.h, rot: a0.rot };
  }

  up() {
    if (!this.drag) return;
    this.drag = null;
    // a free quad that is still a parallelogram can go back to affine mode — keep free for simplicity
    if (!this.aff && isParallelogram(this.quad)) { /* stays free */ }
  }

  dblclick(e: PEvent) { if (this.active && pointInPoly({ x: e.x, y: e.y }, this.quad)) this.apply(); }

  keydown(e: KeyboardEvent) {
    if (!this.active) return false;
    if (e.key === 'Enter') { this.apply(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    const n = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0;
    const dy = e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0;
    if (dx || dy) {
      this.quad = this.quad.map(p => ({ x: p.x + dx, y: p.y + dy })) as Quad;
      if (this.aff) { this.aff.cx += dx; this.aff.cy += dy; }
      app.update('canvas', 'overlay');
      return true;
    }
    return false;
  }

  overlay(g: CanvasRenderingContext2D) {
    if (!this.active) return;
    const v = app.viewport;
    const q = this.quad.map(p => v.toScreen(p.x, p.y));
    g.save();
    if (this.selOnly) {
      g.save(); g.beginPath(); q.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath();
      g.setLineDash([4, 4]); g.strokeStyle = '#000'; g.lineWidth = 1; g.stroke(); g.restore();
    }
    g.beginPath();
    q.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 3; g.stroke();
    g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke();
    for (const p of this.handlePoints().map(pp => v.toScreen(pp.x, pp.y))) {
      g.fillStyle = '#fff';
      g.fillRect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7);
      g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 1;
      g.strokeRect(Math.round(p.x) - 3.5, Math.round(p.y) - 3.5, 7, 7);
    }
    const c = v.toScreen((this.quad[0].x + this.quad[2].x) / 2, (this.quad[0].y + this.quad[2].y) / 2);
    g.beginPath(); g.arc(c.x, c.y, 3, 0, Math.PI * 2); g.strokeStyle = '#fff'; g.stroke();
    g.restore();
  }

  options() {
    const a = this.aff;
    const els: (HTMLElement | null)[] = [];
    if (a) {
      els.push(
        numberField({ label: 'W', value: Math.round(a.sx * 1000) / 10, min: -10000, max: 10000, step: 0.1, unit: '%', width: 50, onChange: (v, fin) => { if (!this.aff) return; this.aff.sx = v / 100 || 0.001; this.quad = this.quadFromAffine(this.aff); app.update('canvas'); if (fin) app.update('options'); } }),
        numberField({ label: 'H', value: Math.round(a.sy * 1000) / 10, min: -10000, max: 10000, step: 0.1, unit: '%', width: 50, onChange: (v, fin) => { if (!this.aff) return; this.aff.sy = v / 100 || 0.001; this.quad = this.quadFromAffine(this.aff); app.update('canvas'); if (fin) app.update('options'); } }),
        numberField({ label: t('opt.angle'), value: Math.round(a.rot * 1800 / Math.PI) / 10, min: -360, max: 360, step: 0.1, unit: '°', width: 44, onChange: v => { if (!this.aff) return; this.aff.rot = v * Math.PI / 180; this.quad = this.quadFromAffine(this.aff); app.update('canvas'); } }),
        sep(),
        iconButton('flipH', t('cmd.flipLayerH'), () => { if (!this.aff) return; this.aff.sx = -this.aff.sx; this.quad = this.quadFromAffine(this.aff); app.update('canvas', 'options'); }),
        iconButton('flipV', t('cmd.flipLayerV'), () => { if (!this.aff) return; this.aff.sy = -this.aff.sy; this.quad = this.quadFromAffine(this.aff); app.update('canvas', 'options'); }),
      );
    } else {
      els.push(span(t('opt.distortMode')));
    }
    els.push(sep(), span(t('hint.transformKeys')));
    els.push(spacer(), textButton(t('dlg.cancel'), () => this.cancel()), textButton(t('opt.apply'), () => this.apply(), true));
    return els;
  }
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function span(text: string) { const s = document.createElement('span'); s.className = 'muted sm'; s.textContent = text; return s; }
export function spacer() { const s = document.createElement('div'); s.style.flex = '1'; return s; }
export function textButton(text: string, onClick: () => void, primary = false) {
  const b = document.createElement('button');
  b.className = 'btn sm' + (primary ? ' primary' : '');
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}
