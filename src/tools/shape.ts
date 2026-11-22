import { app } from '../app';
import { t } from '../i18n';
import { Tool, PEvent } from './tool';
import { RGB, css } from '../core/color';
import { newRasterLayer } from '../core/layer';
import { snapPoint, clearSmart } from '../core/snap';
import { numberField, segmented, checkbox, colorSwatch, sep } from '../ui/controls';
import { snap45 } from './select';

type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'line';
interface ShapeOpts { kind: ShapeKind; fill: boolean; fillColor: RGB; strokeWidth: number; strokeColor: RGB; radius: number }

const counters: Record<ShapeKind, number> = { rect: 1, ellipse: 1, triangle: 1, line: 1 };

export class ShapeTool extends Tool<ShapeOpts> {
  readonly id = 'shape';
  readonly key = 'U';
  get iconName() { return 'shape'; }
  private a: { x: number; y: number } | null = null;
  private b: { x: number; y: number } | null = null;
  private live = { shift: false, alt: false };

  constructor() {
    super({ kind: 'rect', fill: true, fillColor: { r: 10, g: 132, b: 255 }, strokeWidth: 0, strokeColor: { r: 0, g: 0, b: 0 }, radius: 0 });
  }

  down(e: PEvent) {
    const p = snapPoint(e.x, e.y);
    this.a = p; this.b = { ...p };
  }

  move(e: PEvent) {
    if (!this.a) return;
    this.live = { shift: e.shift, alt: e.alt };
    this.b = this.o.kind === 'line' && e.shift ? snap45(this.a, { x: e.x, y: e.y }) : snapPoint(e.x, e.y);
    app.update('overlay');
  }

  /** Geometry in document coordinates. */
  private geom() {
    const a = this.a!, b = this.b!;
    if (this.o.kind === 'line') return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    let w = b.x - a.x, h = b.y - a.y;
    if (this.live.shift) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
    let x = a.x, y = a.y;
    if (this.live.alt) { x -= w; y -= h; w *= 2; h *= 2; }
    return { x0: Math.min(x, x + w), y0: Math.min(y, y + h), x1: Math.max(x, x + w), y1: Math.max(y, y + h) };
  }

  /** Draw the shape path with g already scaled to document space. */
  private path(g: CanvasRenderingContext2D, k: { x0: number; y0: number; x1: number; y1: number }) {
    const o = this.o;
    g.beginPath();
    if (o.kind === 'rect') {
      const r = Math.min(o.radius, (k.x1 - k.x0) / 2, (k.y1 - k.y0) / 2);
      if (r > 0) g.roundRect(k.x0, k.y0, k.x1 - k.x0, k.y1 - k.y0, r); else g.rect(k.x0, k.y0, k.x1 - k.x0, k.y1 - k.y0);
    } else if (o.kind === 'ellipse') {
      g.ellipse((k.x0 + k.x1) / 2, (k.y0 + k.y1) / 2, (k.x1 - k.x0) / 2, (k.y1 - k.y0) / 2, 0, 0, Math.PI * 2);
    } else if (o.kind === 'triangle') {
      g.moveTo((k.x0 + k.x1) / 2, k.y0); g.lineTo(k.x1, k.y1); g.lineTo(k.x0, k.y1); g.closePath();
    } else {
      g.moveTo(k.x0, k.y0); g.lineTo(k.x1, k.y1);
    }
  }

  private paint(g: CanvasRenderingContext2D, k: ReturnType<ShapeTool['geom']>) {
    const o = this.o;
    this.path(g, k);
    if (o.kind === 'line') {
      g.lineWidth = Math.max(1, o.strokeWidth || 2);
      g.lineCap = 'round';
      g.strokeStyle = css(o.strokeWidth ? o.strokeColor : o.fillColor);
      g.stroke();
      return;
    }
    if (o.fill) { g.fillStyle = css(o.fillColor); g.fill(); }
    if (o.strokeWidth > 0) { g.lineWidth = o.strokeWidth; g.lineJoin = 'round'; g.strokeStyle = css(o.strokeColor); g.stroke(); }
  }

  up() {
    if (!this.a || !this.b) return;
    const k = this.geom();
    this.a = null;
    clearSmart();
    const d = app.doc!;
    const big = Math.abs(k.x1 - k.x0) >= 2 || Math.abs(k.y1 - k.y0) >= 2;
    if (!big) { app.update('overlay'); return; }
    const pad = Math.ceil((this.o.kind === 'line' ? Math.max(1, this.o.strokeWidth || 2) : this.o.strokeWidth) / 2) + 2;
    const x = Math.floor(Math.min(k.x0, k.x1)) - pad, y = Math.floor(Math.min(k.y0, k.y1)) - pad;
    const w = Math.ceil(Math.abs(k.x1 - k.x0)) + pad * 2 + 1, h = Math.ceil(Math.abs(k.y1 - k.y0)) + pad * 2 + 1;
    const kind = this.o.kind;
    const l = newRasterLayer(`${t('shape.' + kind)} ${counters[kind]++}`, w, h, x, y);
    const g = l.content.ctx;
    g.translate(-x, -y);
    this.paint(g, k);
    d.add(l);
    app.layersPanel.clearMulti();
    app.commit('tool.shape');
  }

  cancel() { this.a = null; app.update('overlay'); }

  overlay(g: CanvasRenderingContext2D) {
    if (!this.a || !this.b) return;
    const d = app.doc!;
    g.save();
    g.translate(d.panX, d.panY);
    g.scale(d.zoom, d.zoom);
    g.globalAlpha = 0.85;
    this.paint(g, this.geom());
    g.restore();
  }

  options() {
    const o = this.o;
    return [
      segmented<ShapeKind>([
        { value: 'rect', icon: 'square', title: t('shape.rect') },
        { value: 'ellipse', icon: 'circle', title: t('shape.ellipse') },
        { value: 'triangle', icon: 'shapeTriangle', title: t('shape.triangle') },
        { value: 'line', icon: 'line', title: t('shape.line') },
      ], o.kind, v => { this.set('kind', v); app.update('options'); }),
      sep(),
      o.kind !== 'line' ? checkbox(t('opt.fill'), o.fill, v => this.set('fill', v)) : null,
      colorSwatch(o.fillColor, t('opt.fill'), c => this.set('fillColor', c)),
      sep(),
      numberField({ label: o.kind === 'line' ? t('opt.lineWidth') : t('opt.stroke'), value: o.strokeWidth, min: 0, max: 500, unit: 'px', onChange: v => this.set('strokeWidth', v) }),
      colorSwatch(o.strokeColor, t('opt.stroke'), c => this.set('strokeColor', c)),
      o.kind === 'rect' ? sep() : null,
      o.kind === 'rect' ? numberField({ label: t('opt.radius'), value: o.radius, min: 0, max: 2000, unit: 'px', onChange: v => this.set('radius', v) }) : null,
    ];
  }
}
