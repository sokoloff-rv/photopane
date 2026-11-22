import { app } from '../app';
import { t } from '../i18n';
import { Tool, PEvent } from './tool';
import type { AdjustSession } from '../core/adjust';

/**
 * Before / after line on the canvas while a filter dialog is open: left of the line shows the original,
 * right of it the result. Drag (or click) anywhere on the canvas to move it.
 */
export class SplitCompareTool extends Tool {
  readonly id = 'splitCompare';
  readonly iconName = 'move';
  cursor = 'ew-resize';
  private session: AdjustSession | null = null;
  private refresh: () => void = () => {};
  private dragging = false;

  constructor() { super({}); }

  attach(s: AdjustSession, refresh: () => void) {
    this.session = s;
    this.refresh = refresh;
    const d = app.doc!;
    // start in the middle of the visible part of the image
    const v = app.viewport;
    const a = v.toDoc(0, 0).x, b = v.toDoc(v.w, 0).x;
    s.split = Math.round((Math.max(0, a) + Math.min(d.width, b)) / 2);
  }

  detach() { if (this.session) this.session.split = null; this.session = null; }

  private moveTo(e: PEvent) {
    if (!this.session) return;
    this.session.split = Math.round(Math.max(0, Math.min(app.doc!.width, e.x)));
    this.refresh();
    app.update('overlay');
  }

  down(e: PEvent) { this.dragging = true; this.moveTo(e); }
  move(e: PEvent) { if (this.dragging) this.moveTo(e); }
  up() { this.dragging = false; }

  overlay(g: CanvasRenderingContext2D) {
    const s = this.session;
    if (!s || s.split == null) return;
    const v = app.viewport;
    const d = app.doc!;
    const top = v.toScreen(s.split, 0), bot = v.toScreen(s.split, d.height);
    const x = Math.round(top.x) + 0.5;
    const y0 = Math.max(0, top.y), y1 = Math.min(v.h, bot.y);
    g.save();
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke();
    g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
    // handle and labels
    const my = (y0 + y1) / 2;
    g.fillStyle = '#fff'; g.beginPath(); g.arc(x, my, 9, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#333'; g.beginPath(); g.moveTo(x - 6, my); g.lineTo(x - 2, my - 4); g.lineTo(x - 2, my + 4); g.fill();
    g.beginPath(); g.moveTo(x + 6, my); g.lineTo(x + 2, my - 4); g.lineTo(x + 2, my + 4); g.fill();
    g.font = '600 11px system-ui, sans-serif'; g.textBaseline = 'middle';
    const pill = (text: string, right: boolean) => {
      const w = g.measureText(text).width + 14;
      const px = right ? x + 14 : x - 14 - w, py = my - 10;
      g.fillStyle = 'rgba(20,20,20,0.72)'; g.beginPath(); g.roundRect(px, py, w, 20, 10); g.fill();
      g.fillStyle = '#fff'; g.fillText(text, px + 7, py + 10.5);
    };
    pill(t('adj.before'), false);
    pill(t('adj.after'), true);
    g.restore();
  }

  options() { return []; }
}

export const splitCompareTool = new SplitCompareTool();
