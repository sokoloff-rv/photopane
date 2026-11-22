import { app } from '../../app';
import { el, clamp } from '../../core/util';
import { Panel } from './panel';
import { iconButton } from '../controls';
import { t } from '../../i18n';

export class NavigatorPanel extends Panel {
  private canvas: HTMLCanvasElement;
  private slider: HTMLInputElement;
  private pct: HTMLElement;
  private box = { x: 0, y: 0, w: 0, h: 0, scale: 1 };

  constructor() {
    super('panel.navigator', 'nav');
    this.canvas = el('canvas', { class: 'nav-canvas' }) as HTMLCanvasElement;
    this.slider = el('input', { type: 'range', class: 'range', min: -460, max: 416, step: 1 }) as HTMLInputElement;
    this.pct = el('span', { class: 'nav-pct' });
    this.slider.addEventListener('input', () => app.viewport.setZoom(Math.pow(2, +this.slider.value / 100)));
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

  private centerAt(e: PointerEvent) {
    const d = app.doc;
    if (!d) return;
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left - this.box.x) / this.box.scale;
    const y = (e.clientY - r.top - this.box.y) / this.box.scale;
    d.autoFit = false;
    d.panX = app.viewport.w / 2 - x * d.zoom;
    d.panY = app.viewport.h / 2 - y * d.zoom;
    app.update('view');
  }

  render() {
    this.renderTitle();
    const d = app.doc;
    const view = this.canvas.parentElement!;
    const W = Math.max(40, view.clientWidth), H = Math.max(40, view.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, W * dpr); this.canvas.height = H * dpr;
    this.canvas.style.width = W + 'px'; this.canvas.style.height = H + 'px';
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!d) { this.pct.textContent = ''; return; }
    const scale = Math.min(W / d.width, H / d.height);
    const w = d.width * scale, h = d.height * scale;
    const x = (W - w) / 2, y = (H - h) / 2;
    this.box = { x, y, w, h, scale };
    g.fillStyle = '#fff'; g.fillRect(x, y, w, h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(d.composite(), x, y, w, h);
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
    if (document.activeElement !== this.slider) this.slider.value = String(Math.round(Math.log2(d.zoom) * 100));
    this.pct.textContent = Math.round(d.zoom * 1000) / 10 + '%';
  }
}
