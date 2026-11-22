import { app } from '../app';
import { t } from '../i18n';
import { Tool, PEvent } from './tool';
import { brushTip, DabPath, StrokeSession, sampleColor } from './paint';
import { numberField, checkbox, sep } from '../ui/controls';

interface BrushOpts { size: number; hardness: number; opacity: number; flow: number; pressure: boolean }

/** Shared last point for Shift+click straight lines. */
let lastPoint: { x: number; y: number } | null = null;

export class BrushTool extends Tool<BrushOpts> {
  readonly id: string = 'brush';
  readonly iconName: string = 'brush';
  readonly key: string = 'B';
  protected mode: 'paint' | 'erase' = 'paint';
  private session: StrokeSession | null = null;
  private path: DabPath | null = null;
  private picking = false;

  constructor(defaults: BrushOpts = { size: 30, hardness: 80, opacity: 100, flow: 100, pressure: true }) { super(defaults); }

  brushSize() { return this.o.size; }

  protected color() { return app.fg; }

  down(e: PEvent) {
    if (e.alt && this.mode === 'paint') { this.picking = true; this.pick(e); return; }
    const target = app.paintTarget();
    if (!target) return;
    this.session = new StrokeSession(target, this.mode, this.o.opacity / 100, this.color());
    const o = this.o;
    this.path = new DabPath(p => Math.max(0.5, this.diameter(p) * 0.1));
    if (e.shift && lastPoint) {
      this.path.to(lastPoint.x, lastPoint.y, e.pressure, true);
      this.dabTo(e);
    } else {
      this.dabs(this.path.to(e.x, e.y, e.pressure, true));
    }
    this.session.flush();
    lastPoint = { x: e.x, y: e.y };
    void o;
  }

  move(e: PEvent) {
    if (this.picking) { this.pick(e); return; }
    if (!this.session) return;
    this.dabTo(e);
    this.session.flush();
    lastPoint = { x: e.x, y: e.y };
  }

  up(_e: PEvent) {
    if (this.picking) { this.picking = false; return; }
    if (!this.session) return;
    this.session.finish(this.mode === 'erase' ? 'h.eraser' : 'h.brush');
    this.session = null;
  }

  cancel() {
    if (this.session) { this.session.cancel(); this.session = null; }
  }

  busy() { return !!this.session; }

  private pick(e: PEvent) {
    const c = sampleColor(e.x, e.y, 1, true);
    if (c) app.setColor('fg', c);
  }

  private diameter(p: number) {
    return this.o.pressure ? Math.max(1, this.o.size * p) : this.o.size;
  }

  private dabTo(e: PEvent) {
    this.dabs(this.path!.to(e.x, e.y, e.pressure));
  }

  private dabs(pts: { x: number; y: number; p: number }[]) {
    const s = this.session!;
    const color = s.target.isMask ? { r: 255, g: 255, b: 255 } : this.color();
    for (const p of pts) {
      const d = this.diameter(p.p);
      const tip = brushTip(Math.min(d, 512), this.o.hardness / 100, color);
      s.dab(tip, p.x, p.y, d, this.o.flow / 100);
    }
  }

  options() {
    const o = this.o;
    return [
      numberField({ label: t('opt.size'), value: o.size, min: 1, max: 2500, unit: 'px', onChange: v => { this.set('size', v); app.update('overlay'); } }),
      numberField({ label: t('opt.hardness'), value: o.hardness, min: 0, max: 100, unit: '%', onChange: v => this.set('hardness', v) }),
      sep(),
      numberField({ label: t('opt.opacity'), value: o.opacity, min: 1, max: 100, unit: '%', onChange: v => this.set('opacity', v) }),
      numberField({ label: t('opt.flow'), value: o.flow, min: 1, max: 100, unit: '%', onChange: v => this.set('flow', v) }),
      sep(),
      checkbox(t('opt.pressure'), o.pressure, v => this.set('pressure', v)),
    ];
  }
}

export class EraserTool extends BrushTool {
  readonly id = 'eraser';
  readonly iconName = 'eraser';
  readonly key = 'E';
  protected mode: 'paint' | 'erase' = 'erase';
  constructor() { super({ size: 40, hardness: 100, opacity: 100, flow: 100, pressure: false }); }
}
