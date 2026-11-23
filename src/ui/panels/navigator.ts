import { app } from '../../app';
import type { Doc } from '../../core/document';
import { el, clamp } from '../../core/util';
import { Panel } from './panel';
import { iconButton } from '../controls';
import { t } from '../../i18n';

export class NavigatorPanel extends Panel {
  private canvas: HTMLCanvasElement;
  private slider: HTMLInputElement;
  private pct: HTMLInputElement;
  private box = { x: 0, y: 0, w: 0, h: 0, scale: 1 };

  constructor() {
    super('panel.navigator', 'nav');
    this.canvas = el('canvas', { class: 'nav-canvas' }) as HTMLCanvasElement;
    this.slider = el('input', { type: 'range', class: 'range', min: -460, max: 416, step: 1 }) as HTMLInputElement;
    this.pct = el('input', { class: 'nav-pct', title: t('nav.zoomHint') }) as HTMLInputElement;
    this.pct.addEventListener('focus', () => this.pct.select());
    this.pct.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') this.pct.blur();
      if (e.key === 'Escape') { this.pct.value = ''; this.pct.blur(); }
    });
    this.pct.addEventListener('change', () => {
      const v = parseFloat(this.pct.value.replace(',', '.'));
      if (!isNaN(v) && v > 0 && app.doc) app.viewport.setDeviceZoom(v / 100);
      this.render();
    });
    this.pct.addEventListener('blur', () => setTimeout(() => this.render(), 0));
    this.slider.addEventListener('input', () => app.viewport.setDeviceZoom(Math.pow(2, +this.slider.value / 100)));
    const out = iconButton('zoomOut', t('cmd.zoomOut'), () => app.viewport.zoomStep(-1));
    const inn = iconButton('zoomIn', t('cmd.zoomIn'), () => app.viewport.zoomStep(1));
    this.body.append(el('div', { class: 'nav-view' }, this.canvas), el('div', { class: 'nav-zoom' }, out, this.slider, inn, this.pct));
    this.canvas.addEventListener('pointerdown', e => {
      this.canvas.setPointerCapture(e.pointerId);
      const go = (ev: PointerEvent) => this.centerAt(ev);
      go(e);
      const up = () => { this.canvas.removeEventListener('pointermove', go); this.canvas.removeEventListener('pointerup', up); };
      this.canvas.addEventListener('pointermove', go);
      this.canvas.addEventListener('pointerup', up);
    });
    new ResizeObserver(() => requestAnimationFrame(() => this.render())).observe(this.canvas.parentElement!);
  }

  private thumb: { canvas: HTMLCanvasElement; doc: unknown; ver: number; at: number } | null = null;
  private thumbTimer = 0;
  /** Small copy of the picture; while it keeps changing it is redrawn at most every 200 ms. */
  private thumbnail(d: Doc, tw: number, th: number): HTMLCanvasElement {
    let t = this.thumb;
    const fresh = t && t.doc === d && t.canvas.width === tw && t.canvas.height === th;
    if (fresh && t!.ver === d.version) return t!.canvas;
    const now = performance.now();
    if (fresh && now - t!.at < 200) {
      if (!this.thumbTimer) this.thumbTimer = window.setTimeout(() => { this.thumbTimer = 0; this.render(); }, 220);
      return t!.canvas;
    }
    const c = t?.canvas ?? document.createElement('canvas');
    if (c.width !== tw || c.height !== th) { c.width = tw; c.height = th; }
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, tw, th);
    g.imageSmoothingQuality = 'high';
    g.drawImage(d.displayComposite(), 0, 0, tw, th);
    t = this.thumb = { canvas: c, doc: d, ver: d.version, at: now };
    return c;
  }

  private centerAt(e: PointerEvent) {
    const d = app.doc;
    if (!d) return;
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left - this.box.x) / this.box.scale;
    const y = (e.clientY - r.top - this.box.y) / this.box.scale;
    d.autoFit = false;
    d.panX = app.viewport.w / 2 - x * d.zoom;
    d.panY = app.viewport.h / 2 - y * d.zoom;
    app.viewport.snapPan();
    app.update('view');
  }

  render() {
    this.renderTitle();
    const d = app.doc;
    const view = this.canvas.parentElement!;
    const W = Math.max(40, view.clientWidth), H = Math.max(40, view.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(W * dpr)), ch = Math.max(1, Math.round(H * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    this.canvas.style.width = W + 'px'; this.canvas.style.height = H + 'px';
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!d) { this.pct.value = ''; this.pct.disabled = true; return; }
    this.pct.disabled = false;
    const scale = Math.min(W / d.width, H / d.height);
    const w = d.width * scale, h = d.height * scale;
    const x = (W - w) / 2, y = (H - h) / 2;
    this.box = { x, y, w, h, scale };
    g.fillStyle = '#fff'; g.fillRect(x, y, w, h);
    g.drawImage(this.thumbnail(d, Math.max(1, Math.round(w * dpr)), Math.max(1, Math.round(h * dpr))), x, y, w, h);
    // viewport rectangle
    const vp = app.viewport;
    const vx = x + (-d.panX / d.zoom) * scale, vy = y + (-d.panY / d.zoom) * scale;
    const vw = (vp.w / d.zoom) * scale, vh = (vp.h / d.zoom) * scale;
    g.save();
    g.beginPath(); g.rect(0, 0, W, H); g.rect(clamp(vx, -1, W), clamp(vy, -1, H), Math.min(vw, W), Math.min(vh, H));
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.fill('evenodd');
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1;
    g.strokeRect(vx, vy, vw, vh);
    g.restore();
    const dz = app.viewport.deviceZoom();
    if (document.activeElement !== this.slider) this.slider.value = String(Math.round(Math.log2(dz) * 100));
    if (document.activeElement !== this.pct) this.pct.value = Math.round(dz * 1000) / 10 + '%';
  }
}
