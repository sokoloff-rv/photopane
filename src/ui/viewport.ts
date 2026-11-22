import { app } from '../app';
import { el, clamp } from '../core/util';
import { t } from '../i18n';
import { PEvent } from '../tools/tool';
import { icon } from './icons';
import { smartLines } from '../core/snap';
import { openCanvasContextMenu } from './contextmenu';

const RB = 18; // ruler band size

const ZOOM_STEPS = [0.01, 0.02, 0.03, 0.04, 0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 32, 48, 64];

export class Viewport {
  main: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  welcome: HTMLElement;
  w = 0; h = 0; dpr = 1;
  pointer: { sx: number; sy: number; inside: boolean } = { sx: 0, sy: 0, inside: false };
  private antsPhase = 0;
  private dragging: 'tool' | 'pan' | 'guide' | null = null;
  private guideDrag: { axis: 'h' | 'v'; index: number } | null = null;
  private panStart = { x: 0, y: 0, px: 0, py: 0 };
  private checker: CanvasPattern | null = null;

  constructor(public el: HTMLElement) {
    this.main = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    this.main.className = 'vp-main';
    this.overlay.className = 'vp-overlay';
    this.welcome = this.buildWelcome();
    el.append(this.main, this.overlay, this.welcome);
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();

    const ov = this.overlay;
    ov.addEventListener('pointerdown', e => this.onDown(e));
    ov.addEventListener('pointermove', e => this.onMove(e));
    ov.addEventListener('pointerup', e => this.onUp(e));
    ov.addEventListener('pointercancel', e => this.onUp(e));
    ov.addEventListener('dblclick', e => { if (app.doc && !app.spaceDown) (this.isPanTool() ? this.fit(false) : app.tool.dblclick(this.ev(e))); });
    ov.addEventListener('pointerenter', () => { this.pointer.inside = true; });
    ov.addEventListener('pointerleave', () => { this.pointer.inside = false; this.renderOverlay(); app.statusbar.setCursor(null); });
    ov.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    ov.addEventListener('contextmenu', e => { e.preventDefault(); if (app.doc && !app.spaceDown) openCanvasContextMenu(e, this.ev(e)); });

    setInterval(() => {
      if (app.doc?.selection || app.tool.id === 'lasso') { this.antsPhase = (this.antsPhase + 1) % 1e6; this.renderOverlay(); }
    }, 90);
  }

  private buildWelcome() {
    const b1 = el('button', { class: 'btn primary lg' }, icon('fileNew', 18), el('span', {}, ''));
    const b2 = el('button', { class: 'btn lg' }, icon('folderOpen', 18), el('span', {}, ''));
    b1.addEventListener('click', () => app.run('new'));
    b2.addEventListener('click', () => app.run('open'));
    const w = el('div', { class: 'welcome' },
      el('div', { class: 'welcome-logo', html: '' }),
      el('h1', {}, ''), el('p', {}, ''),
      el('div', { class: 'welcome-actions' }, b1, b2));
    return w;
  }

  private renderWelcome() {
    const w = this.welcome;
    w.style.display = app.doc ? 'none' : '';
    if (app.doc) return;
    const logo = w.querySelector('.welcome-logo')!;
    if (!logo.firstChild) logo.append(icon('logo', 56));
    w.querySelector('h1')!.textContent = t('app.welcome.title');
    w.querySelector('p')!.textContent = t('app.welcome.sub');
    const spans = w.querySelectorAll('.welcome-actions span:not(.ico)');
    spans[0].textContent = t('cmd.new').replace('…', '');
    spans[1].textContent = t('cmd.open').replace('…', '');
  }

  resize() {
    const r = this.el.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    for (const c of [this.main, this.overlay]) {
      c.width = Math.max(1, Math.round(r.width * this.dpr));
      c.height = Math.max(1, Math.round(r.height * this.dpr));
      c.style.width = r.width + 'px';
      c.style.height = r.height + 'px';
    }
    const d = app?.doc;
    if (d && (!d.fitted || d.autoFit)) this.fit(true);
    this.render();
    this.renderOverlay();
  }

  /* ---------- coordinates ---------- */
  toDoc(sx: number, sy: number) {
    const d = app.doc!;
    return { x: (sx - d.panX) / d.zoom, y: (sy - d.panY) / d.zoom };
  }
  toScreen(x: number, y: number) {
    const d = app.doc!;
    return { x: x * d.zoom + d.panX, y: y * d.zoom + d.panY };
  }

  fit(onlyShrink: boolean) {
    const d = app.doc;
    if (!d || this.w < 10) return;
    const pad = 48;
    let z = Math.min((this.w - pad) / d.width, (this.h - pad) / d.height);
    if (onlyShrink) z = Math.min(z, 1);
    d.zoom = clamp(z, 0.01, 64);
    d.panX = Math.round((this.w - d.width * d.zoom) / 2);
    d.panY = Math.round((this.h - d.height * d.zoom) / 2);
    d.fitted = true;
    d.autoFit = onlyShrink;
    app.update('view');
  }

  setZoom(z: number, sx = this.w / 2, sy = this.h / 2) {
    const d = app.doc;
    if (!d) return;
    z = clamp(z, 0.01, 64);
    d.autoFit = false;
    const p = this.toDoc(sx, sy);
    d.zoom = z;
    d.panX = sx - p.x * z;
    d.panY = sy - p.y * z;
    app.update('view');
  }

  zoomStep(dir: 1 | -1, sx?: number, sy?: number) {
    const d = app.doc;
    if (!d) return;
    const z = d.zoom;
    let next = dir > 0 ? ZOOM_STEPS.find(s => s > z * 1.001) : [...ZOOM_STEPS].reverse().find(s => s < z / 1.001);
    if (next == null) next = z;
    this.setZoom(next, sx, sy);
  }

  /* ---------- rendering ---------- */
  render() {
    this.renderWelcome();
    app.tool.viewChanged();
    const g = this.main.getContext('2d')!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const d = app.doc;
    if (!d) return;
    const comp = d.composite();
    const x = d.panX, y = d.panY, w = d.width * d.zoom, h = d.height * d.zoom;
    // shadow
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.35)';
    g.shadowBlur = 16;
    g.shadowOffsetY = 2;
    g.fillStyle = '#fff';
    g.fillRect(x, y, w, h);
    g.restore();
    // checkerboard
    if (!this.checker) {
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      const cg = c.getContext('2d')!;
      cg.fillStyle = '#ffffff'; cg.fillRect(0, 0, 16, 16);
      cg.fillStyle = '#e6e6e6'; cg.fillRect(0, 0, 8, 8); cg.fillRect(8, 8, 8, 8);
      this.checker = g.createPattern(c, 'repeat');
    }
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    g.fillStyle = this.checker!;
    g.fillRect(x, y, w, h);
    g.imageSmoothingEnabled = d.zoom < 2;
    g.imageSmoothingQuality = 'high';
    g.drawImage(comp, x, y, w, h);
    // pixel grid at high zoom
    if (d.zoom >= 12) {
      g.strokeStyle = 'rgba(128,128,128,0.25)';
      g.lineWidth = 1 / this.dpr;
      g.beginPath();
      const x0 = Math.max(0, Math.floor(-x / d.zoom)), x1 = Math.min(d.width, Math.ceil((this.w - x) / d.zoom));
      const y0 = Math.max(0, Math.floor(-y / d.zoom)), y1 = Math.min(d.height, Math.ceil((this.h - y) / d.zoom));
      for (let i = x0; i <= x1; i++) { const sx = Math.round(x + i * d.zoom) + 0.5 / this.dpr; g.moveTo(sx, y + y0 * d.zoom); g.lineTo(sx, y + y1 * d.zoom); }
      for (let j = y0; j <= y1; j++) { const sy = Math.round(y + j * d.zoom) + 0.5 / this.dpr; g.moveTo(x + x0 * d.zoom, sy); g.lineTo(x + x1 * d.zoom, sy); }
      g.stroke();
    }
    g.restore();
  }

  renderOverlay() {
    const g = this.overlay.getContext('2d')!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const d = app.doc;
    if (!d) return;
    // marching ants: thin black/white dashes flowing along continuous contours,
    // drawn in device pixels and snapped to the pixel grid so they stay crisp on HiDPI screens
    if (d.selection && !app.hideSelection) {
      const k = this.dpr;
      const z = d.zoom * k;
      const ox = (d.panX + app.selOffset.x * d.zoom) * k, oy = (d.panY + app.selOffset.y * d.zoom) * k;
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.beginPath();
      for (const loop of d.selection.contours) {
        for (let i = 0; i < loop.length; i += 2) {
          const x = Math.round(loop[i] * z + ox) + 0.5, y = Math.round(loop[i + 1] * z + oy) + 0.5;
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.closePath();
      }
      const dash = Math.max(3, Math.round(4 * k));
      g.lineWidth = k >= 1.5 ? 1.3 : 1;
      g.strokeStyle = '#fff';
      g.stroke();
      g.strokeStyle = '#000';
      g.setLineDash([dash, dash]);
      g.lineDashOffset = -((this.antsPhase * Math.max(1, Math.round(k))) % (dash * 2));
      g.stroke();
      g.restore();
    }
    app.tool.overlay(g);
    this.drawGuides(g);
    // brush outline
    const bs = app.tool.brushSize();
    if (bs > 0 && this.pointer.inside && !app.spaceDown) {
      const r = (bs * d.zoom) / 2;
      const { sx, sy } = this.pointer;
      g.save();
      g.beginPath();
      g.arc(sx, sy, Math.max(r, 1), 0, Math.PI * 2);
      g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 2.5; g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 1; g.stroke();
      if (r < 4) {
        g.beginPath();
        g.moveTo(sx - 6, sy); g.lineTo(sx + 6, sy); g.moveTo(sx, sy - 6); g.lineTo(sx, sy + 6);
        g.stroke();
      }
      g.restore();
    }
    if (app.settings.rulers) this.drawRulers(g);
  }

  /* ---------- guides & rulers ---------- */
  private drawGuides(g: CanvasRenderingContext2D) {
    const d = app.doc!;
    g.save();
    g.lineWidth = 1;
    if (app.settings.showGuides !== false) {
      g.strokeStyle = 'rgba(0, 212, 255, 0.9)';
      g.beginPath();
      for (const y of d.guides.h) { const sy = Math.round(y * d.zoom + d.panY) + 0.5; g.moveTo(0, sy); g.lineTo(this.w, sy); }
      for (const x of d.guides.v) { const sx = Math.round(x * d.zoom + d.panX) + 0.5; g.moveTo(sx, 0); g.lineTo(sx, this.h); }
      g.stroke();
    }
    if (smartLines.length) {
      g.strokeStyle = '#ff2d92';
      g.beginPath();
      for (const l of smartLines) {
        if (l.x != null) { const sx = Math.round(l.x * d.zoom + d.panX) + 0.5; g.moveTo(sx, 0); g.lineTo(sx, this.h); }
        if (l.y != null) { const sy = Math.round(l.y * d.zoom + d.panY) + 0.5; g.moveTo(0, sy); g.lineTo(this.w, sy); }
      }
      g.stroke();
    }
    g.restore();
  }

  private drawRulers(g: CanvasRenderingContext2D) {
    const d = app.doc!;
    const z = d.zoom;
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
    const step = steps.find(s => s * z >= 60) || 10000;
    const minor = step / (String(step).startsWith('25') ? 5 : step >= 10 && !String(step).startsWith('2') ? 10 : 4);
    g.save();
    g.fillStyle = 'rgba(30,30,30,0.96)';
    g.fillRect(0, 0, this.w, RB);
    g.fillRect(0, 0, RB, this.h);
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.beginPath(); g.moveTo(0, RB - 0.5); g.lineTo(this.w, RB - 0.5); g.moveTo(RB - 0.5, 0); g.lineTo(RB - 0.5, this.h); g.stroke();
    g.font = '9.5px ' + getComputedStyle(document.body).fontFamily;
    g.fillStyle = 'rgba(235,235,240,0.55)';
    g.strokeStyle = 'rgba(235,235,240,0.35)';
    g.beginPath();
    const x0 = Math.floor(-d.panX / z / minor) * minor, x1 = (this.w - d.panX) / z;
    for (let v = x0; v <= x1; v += minor) {
      const sx = Math.round(v * z + d.panX) + 0.5;
      if (sx < RB) continue;
      const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
      g.moveTo(sx, major ? 2 : RB - 5); g.lineTo(sx, RB);
      if (major) g.fillText(String(Math.round(v)), sx + 3, 10);
    }
    const y0 = Math.floor(-d.panY / z / minor) * minor, y1 = (this.h - d.panY) / z;
    for (let v = y0; v <= y1; v += minor) {
      const sy = Math.round(v * z + d.panY) + 0.5;
      if (sy < RB) continue;
      const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
      g.moveTo(major ? 2 : RB - 5, sy); g.lineTo(RB, sy);
      if (major) { g.save(); g.translate(10, sy + 3); g.rotate(-Math.PI / 2); g.fillText(String(Math.round(v)), -g.measureText(String(Math.round(v))).width - 3, 0); g.restore(); }
    }
    g.stroke();
    // pointer position markers
    if (this.pointer.inside) {
      g.strokeStyle = '#fff';
      g.beginPath();
      g.moveTo(Math.round(this.pointer.sx) + 0.5, 0); g.lineTo(Math.round(this.pointer.sx) + 0.5, RB);
      g.moveTo(0, Math.round(this.pointer.sy) + 0.5); g.lineTo(RB, Math.round(this.pointer.sy) + 0.5);
      g.stroke();
    }
    g.fillStyle = 'rgba(30,30,30,1)';
    g.fillRect(0, 0, RB, RB);
    g.restore();
  }

  private guideAt(pe: PEvent): { axis: 'h' | 'v'; index: number } | null {
    const d = app.doc!;
    if (app.settings.showGuides === false) return null;
    for (let i = 0; i < d.guides.h.length; i++) if (Math.abs(d.guides.h[i] * d.zoom + d.panY - pe.sy) < 4) return { axis: 'h', index: i };
    for (let i = 0; i < d.guides.v.length; i++) if (Math.abs(d.guides.v[i] * d.zoom + d.panX - pe.sx) < 4) return { axis: 'v', index: i };
    return null;
  }

  /* ---------- cursor ---------- */
  isPanTool() { return app.spaceDown || app.tool.id === 'hand'; }

  updateCursor() {
    const c = this.isPanTool() ? (this.dragging === 'pan' ? 'grabbing' : 'grab') : app.tool.brushSize() > 0 ? 'none' : app.tool.cursor;
    this.overlay.style.cursor = c;
    this.renderOverlay();
  }

  /* ---------- input ---------- */
  ev(e: PointerEvent | MouseEvent): PEvent {
    const r = this.overlay.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const p = app.doc ? this.toDoc(sx, sy) : { x: 0, y: 0 };
    const pe = e as PointerEvent;
    const pen = pe.pointerType === 'pen';
    return {
      x: p.x, y: p.y, sx, sy, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, button: e.button,
      pressure: pen ? (pe.pressure || 0.5) : 1, pen,
    };
  }

  private onDown(e: PointerEvent) {
    if (!app.doc) return;
    (document.activeElement as HTMLElement)?.blur?.();
    this.overlay.setPointerCapture(e.pointerId);
    if (this.isPanTool() || e.button === 1) {
      this.dragging = 'pan';
      const d = app.doc;
      this.panStart = { x: e.clientX, y: e.clientY, px: d.panX, py: d.panY };
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;
    const pe = this.ev(e);
    const d = app.doc;
    // new guide dragged out of a ruler
    if (app.settings.rulers && (pe.sy < RB || pe.sx < RB) && !(pe.sy < RB && pe.sx < RB)) {
      const axis = pe.sy < RB ? 'h' : 'v';
      if (app.settings.showGuides === false) { app.settings.showGuides = true; app.saveSettings(); }
      d.guides[axis].push(axis === 'h' ? Math.round(pe.y) : Math.round(pe.x));
      this.guideDrag = { axis, index: d.guides[axis].length - 1 };
      this.dragging = 'guide';
      return;
    }
    if (app.tool.id === 'move') {
      const gh = this.guideAt(pe);
      if (gh) { this.guideDrag = gh; this.dragging = 'guide'; return; }
    }
    this.dragging = 'tool';
    app.tool.down(pe);
  }

  private onMove(e: PointerEvent) {
    const pe = this.ev(e);
    this.pointer.sx = pe.sx; this.pointer.sy = pe.sy; this.pointer.inside = true;
    if (!app.doc) return;
    app.statusbar.setCursor({ x: pe.x, y: pe.y });
    if (this.dragging === 'pan') {
      const d = app.doc;
      d.autoFit = false;
      d.panX = this.panStart.px + (e.clientX - this.panStart.x);
      d.panY = this.panStart.py + (e.clientY - this.panStart.y);
      app.update('view');
      return;
    }
    if (this.dragging === 'guide' && this.guideDrag) {
      const g = this.guideDrag;
      app.doc.guides[g.axis][g.index] = Math.round(g.axis === 'h' ? pe.y : pe.x);
      this.renderOverlay();
      return;
    }
    if (!this.dragging && app.tool.id === 'move' && !app.spaceDown) {
      const gh = this.guideAt(pe);
      this.overlay.style.cursor = gh ? (gh.axis === 'h' ? 'ns-resize' : 'ew-resize') : app.tool.cursor;
    }
    if (this.dragging === 'tool') {
      const evs = (e.getCoalescedEvents?.() || []) as PointerEvent[];
      if (evs.length > 1) for (const ce of evs) app.tool.move(this.ev(ce));
      else app.tool.move(pe);
    } else app.tool.hover(pe);
    this.renderOverlay();
  }

  private onUp(e: PointerEvent) {
    if (!this.dragging) return;
    const was = this.dragging;
    this.dragging = null;
    try { this.overlay.releasePointerCapture(e.pointerId); } catch {}
    if (was === 'tool' && app.doc) app.tool.up(this.ev(e));
    if (was === 'guide' && this.guideDrag && app.doc) {
      const pe = this.ev(e);
      const g = this.guideDrag;
      const d = app.doc;
      const pos = d.guides[g.axis][g.index];
      const outside = g.axis === 'h' ? pe.sy < RB || pos < 0 || pos > d.height : pe.sx < RB || pos < 0 || pos > d.width;
      if (outside) d.guides[g.axis].splice(g.index, 1);
      this.guideDrag = null;
      this.renderOverlay();
    }
    this.updateCursor();
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const d = app.doc;
    if (!d) return;
    const r = this.overlay.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (e.ctrlKey || e.altKey || e.metaKey) {
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
      this.setZoom(d.zoom * f, sx, sy);
    } else {
      const k = e.deltaMode === 1 ? 20 : 1;
      d.autoFit = false;
      if (e.shiftKey) d.panX -= (e.deltaY || e.deltaX) * k;
      else { d.panX -= e.deltaX * k; d.panY -= e.deltaY * k; }
      app.update('view');
    }
  }
}
