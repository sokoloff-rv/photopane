import { app, PaintTarget } from '../app';
import { t } from '../i18n';
import { Tool, PEvent } from './tool';
import { DabPath } from './paint';
import { createCanvas, ctx2d, readPixels } from '../core/util';
import { numberField } from '../ui/controls';
import { MAX_BRUSH_SIZE } from '../ui/sizecurve';
import { toast } from '../ui/dialog';
import { healPixels } from '../core/heal';

interface HealOpts { size: number; hardness: number }

/**
 * Spot Healing Brush: paint over a blemish; on release the area is filled with matching texture from
 * nearby and blended into its surroundings.
 */
export class HealTool extends Tool<HealOpts> {
  readonly id = 'heal';
  readonly iconName = 'heal';
  readonly key = 'J';
  private target: PaintTarget | null = null;
  private mask: HTMLCanvasElement | null = null;
  private maskCanvas: HTMLCanvasElement | null = null;
  private path: DabPath | null = null;
  private pts: { x: number; y: number }[] = [];

  constructor() { super({ size: 30, hardness: 60 }); }

  brushSize() { return this.o.size; }
  busy() { return !!this.target; }

  down(e: PEvent) {
    const tg = app.paintTarget();
    if (!tg) return;
    if (tg.isMask) { toast(t('app.layerLocked')); return; }
    const d = app.doc!;
    tg.surface.ensureCovers({ x: 0, y: 0, w: d.width, h: d.height });
    this.target = tg;
    this.mask = this.maskCanvas = createCanvas(tg.surface.w, tg.surface.h);
    this.shade = null;
    this.path = new DabPath(() => Math.max(1, this.o.size * 0.15));
    this.pts = [];
    for (const p of this.path.to(e.x, e.y, 1, true)) this.dab(p.x, p.y);
    app.update('overlay');
  }

  move(e: PEvent) {
    if (!this.target) return;
    for (const p of this.path!.to(e.x, e.y, 1)) this.dab(p.x, p.y);
    app.update('overlay');
  }

  private dab(x: number, y: number) {
    const s = this.target!.surface, g = ctx2d(this.mask!);
    const r = this.o.size / 2, lx = x - s.x, ly = y - s.y;
    const hard = this.o.hardness / 100;
    const gr = g.createRadialGradient(lx, ly, r * hard, lx, ly, r);
    gr.addColorStop(0, '#fff'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(lx, ly, r, 0, Math.PI * 2); g.fill();
    this.pts.push({ x, y });
  }

  up() {
    const tg = this.target;
    if (!tg || !this.mask) return;
    this.target = null;
    const s = tg.surface;
    const d = app.doc!;
    // Only the painted spot and the neighbourhood the healing takes texture from (up to ~3 spot sizes away)
    // are read and processed, not the whole layer (11 MP on a large photo).
    const half = this.o.size / 2 + 2;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const p of this.pts) {
      bx0 = Math.min(bx0, p.x - s.x - half); by0 = Math.min(by0, p.y - s.y - half);
      bx1 = Math.max(bx1, p.x - s.x + half); by1 = Math.max(by1, p.y - s.y + half);
    }
    const pad = Math.ceil(3.4 * Math.max(bx1 - bx0, by1 - by0)) + 12;
    const rx = Math.max(0, Math.floor(bx0 - pad)), ry = Math.max(0, Math.floor(by0 - pad));
    const rw = Math.min(s.w, Math.ceil(bx1 + pad)) - rx, rh = Math.min(s.h, Math.ceil(by1 + pad)) - ry;
    this.mask = null; this.pts = []; this.shade = null;
    if (rw <= 0 || rh <= 0) { app.update('overlay'); return; }
    const ma = ctx2d(this.maskCanvas!).getImageData(rx, ry, rw, rh).data;
    this.maskCanvas = null;
    const mask = new Uint8Array(rw * rh);
    for (let i = 0; i < mask.length; i++) mask[i] = ma[i * 4 + 3];
    // respect the selection
    if (d.selection) {
      const sel = d.selection.alpha();
      for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
        const dx = rx + x + s.x, dy = ry + y + s.y;
        const k = dx >= 0 && dy >= 0 && dx < d.width && dy < d.height ? sel[dy * d.width + dx] : 0;
        mask[y * rw + x] = (mask[y * rw + x] * k) / 255;
      }
    }
    const img = readPixels(s.canvas, rx, ry, rw, rh);
    const r = healPixels(img.data, rw, rh, mask);
    if (r) {
      s.ctx.putImageData(img, rx, ry, r.x, r.y, r.w, r.h);
      s.markDirty({ x: rx + r.x, y: ry + r.y, w: r.w, h: r.h });
      tg.layer.touch();
      app.commit('tool.heal');
    }
    app.update('canvas', 'overlay');
  }

  cancel() { this.target = null; this.mask = null; this.maskCanvas = null; this.pts = []; this.shade = null; app.update('overlay'); }

  /**
   * The painted area while the brush moves, kept in a screen-sized canvas: each move adds its new dabs only
   * (drawing every dab of a long stroke again on each move slowed the brush down as the stroke grew).
   */
  private shade: { c: HTMLCanvasElement; zoom: number; panX: number; panY: number; w: number; h: number; n: number } | null = null;

  overlay(g: CanvasRenderingContext2D) {
    if (!this.target || !this.pts.length) return;
    const v = app.viewport, d = app.doc!;
    const W = g.canvas.width, H = g.canvas.height;
    let sh = this.shade;
    if (!sh || sh.zoom !== d.zoom || sh.panX !== d.panX || sh.panY !== d.panY || sh.w !== W || sh.h !== H) {
      sh = this.shade = { c: sh?.c ?? createCanvas(W, H), zoom: d.zoom, panX: d.panX, panY: d.panY, w: W, h: H, n: 0 };
      sh.c.width = W; sh.c.height = H;
    }
    if (sh.n < this.pts.length) {
      const sg = ctx2d(sh.c);
      sg.setTransform(g.getTransform());
      sg.fillStyle = '#000';
      const r = (this.o.size * d.zoom) / 2;
      sg.beginPath();
      for (let i = sh.n; i < this.pts.length; i++) { const p = v.toScreen(this.pts[i].x, this.pts[i].y); sg.moveTo(p.x + r, p.y); sg.arc(p.x, p.y, r, 0, Math.PI * 2); }
      sg.fill();
      sh.n = this.pts.length;
    }
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 0.35;
    g.drawImage(sh.c, 0, 0);
    g.restore();
  }

  options() {
    return [
      numberField({ label: t('opt.size'), value: this.o.size, min: 1, max: MAX_BRUSH_SIZE, unit: 'px', log: true, onChange: v => { this.set('size', v); app.update('overlay'); } }),
      numberField({ label: t('opt.hardness'), value: this.o.hardness, min: 0, max: 100, unit: '%', onChange: v => this.set('hardness', v) }),
    ];
  }
}
