import { app, PaintTarget } from '../app';
import { t } from '../i18n';
import { Tool, PEvent } from './tool';
import { DabPath } from './paint';
import { createCanvas, ctx2d } from '../core/util';
import { numberField } from '../ui/controls';
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
    this.mask = createCanvas(tg.surface.w, tg.surface.h);
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
    const ma = ctx2d(this.mask).getImageData(0, 0, s.w, s.h).data;
    const mask = new Uint8Array(s.w * s.h);
    for (let i = 0; i < mask.length; i++) mask[i] = ma[i * 4 + 3];
    // respect the selection
    const d = app.doc!;
    if (d.selection) {
      const sel = d.selection.alpha();
      for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
        const dx = x + s.x, dy = y + s.y;
        const k = dx >= 0 && dy >= 0 && dx < d.width && dy < d.height ? sel[dy * d.width + dx] : 0;
        mask[y * s.w + x] = (mask[y * s.w + x] * k) / 255;
      }
    }
    const img = s.ctx.getImageData(0, 0, s.w, s.h);
    const r = healPixels(img.data, s.w, s.h, mask);
    this.mask = null; this.pts = [];
    if (r) {
      s.ctx.putImageData(img, 0, 0, r.x, r.y, r.w, r.h);
      s.markDirty(r);
      tg.layer.touch();
      app.commit('tool.heal');
    }
    app.update('canvas', 'overlay');
  }

  cancel() { this.target = null; this.mask = null; this.pts = []; app.update('overlay'); }

  overlay(g: CanvasRenderingContext2D) {
    if (!this.target || !this.pts.length) return;
    const v = app.viewport;
    const r = (this.o.size * app.doc!.zoom) / 2;
    g.save();
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath();
    for (const p of this.pts) { const s = v.toScreen(p.x, p.y); g.moveTo(s.x + r, s.y); g.arc(s.x, s.y, r, 0, Math.PI * 2); }
    g.fill();
    g.restore();
  }

  options() {
    return [
      numberField({ label: t('opt.size'), value: this.o.size, min: 1, max: 1000, unit: 'px', onChange: v => { this.set('size', v); app.update('overlay'); } }),
      numberField({ label: t('opt.hardness'), value: this.o.hardness, min: 0, max: 100, unit: '%', onChange: v => this.set('hardness', v) }),
    ];
  }
}
