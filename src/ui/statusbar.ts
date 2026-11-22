import { app } from '../app';
import { el } from '../core/util';
import { t } from '../i18n';

export class StatusBar {
  private zoom: HTMLInputElement;
  private size: HTMLElement;
  private profile: HTMLElement;
  private cursor: HTMLElement;
  private hint: HTMLElement;

  constructor(public root: HTMLElement) {
    this.zoom = document.createElement('input');
    this.zoom.className = 'zoom-input';
    this.zoom.addEventListener('change', () => {
      const v = parseFloat(this.zoom.value);
      if (!isNaN(v) && app.doc) app.viewport.setDeviceZoom(v / 100);
      this.render();
    });
    this.zoom.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') this.zoom.blur(); });
    this.size = el('span', { class: 'st-item' });
    this.profile = el('span', { class: 'st-item muted' });
    this.cursor = el('span', { class: 'st-item mono' });
    this.hint = el('span', { class: 'st-hint' });
    root.append(this.zoom, this.size, this.profile, this.cursor, this.hint);
  }

  render() {
    const d = app.doc;
    this.zoom.style.visibility = d ? '' : 'hidden';
    const dz = app.viewport.deviceZoom();
    if (d && document.activeElement !== this.zoom) this.zoom.value = +(dz * 100).toFixed(dz < 0.1 ? 2 : 1) + '%';
    this.profile.textContent = d?.colorProfile ? d.colorProfile.name : '';
    this.size.textContent = d ? `${d.width} × ${d.height} ${t('dlg.px')}` : '';
    const hk = app.tool.hintKey;
    const h = t(hk);
    this.hint.textContent = h === hk ? '' : h;
  }

  setCursor(p: { x: number; y: number } | null) {
    this.cursor.textContent = p ? `X ${Math.floor(p.x)}  Y ${Math.floor(p.y)}` : '';
  }
}
