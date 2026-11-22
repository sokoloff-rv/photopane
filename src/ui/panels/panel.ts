import { el } from '../../core/util';
import { t } from '../../i18n';
import { icon } from '../icons';

export class Panel {
  el: HTMLElement;
  body: HTMLElement;
  head: HTMLElement;
  private titleEl: HTMLElement;

  constructor(public titleKey: string, public cls: string) {
    this.titleEl = el('span', { class: 'panel-title' });
    const chevron = el('span', { class: 'panel-chev' }, icon('chevronDown', 14));
    this.head = el('div', { class: 'panel-head' }, chevron, this.titleEl, el('div', { class: 'panel-head-extra' }));
    this.body = el('div', { class: 'panel-body' });
    this.el = el('div', { class: 'panel ' + cls }, this.head, this.body);
    const key = 'pp.panel.' + cls;
    if (localStorage.getItem(key) === 'collapsed') this.el.classList.add('collapsed');
    this.head.addEventListener('click', e => {
      if ((e.target as HTMLElement).closest('.panel-head-extra')) return;
      this.el.classList.toggle('collapsed');
      try { localStorage.setItem(key, this.el.classList.contains('collapsed') ? 'collapsed' : ''); } catch {}
    });
  }

  get extra() { return this.head.querySelector('.panel-head-extra') as HTMLElement; }

  renderTitle() { this.titleEl.textContent = t(this.titleKey); }
}

/** Splitters: right column width and heights of the stacked panels. */
export function installPanelResizers(column: HTMLElement, panels: Panel[]) {
  const root = document.documentElement;
  const savedW = parseInt(localStorage.getItem('pp.panelsW') || '');
  if (savedW) root.style.setProperty('--panels-w', savedW + 'px');
  const vs = document.createElement('div');
  vs.className = 'panels-splitter';
  column.prepend(vs);
  vs.addEventListener('pointerdown', e => {
    e.preventDefault();
    vs.setPointerCapture(e.pointerId);
    vs.classList.add('drag');
    const startX = e.clientX, startW = column.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      const w = Math.max(220, Math.min(620, startW - (ev.clientX - startX)));
      root.style.setProperty('--panels-w', w + 'px');
    };
    const up = () => {
      vs.classList.remove('drag');
      vs.removeEventListener('pointermove', move); vs.removeEventListener('pointerup', up);
      try { localStorage.setItem('pp.panelsW', String(Math.round(column.getBoundingClientRect().width))); } catch {}
    };
    vs.addEventListener('pointermove', move); vs.addEventListener('pointerup', up);
  });
  // horizontal splitters below every panel except the last one
  panels.slice(0, -1).forEach(p => {
    const key = 'pp.panelH.' + p.cls;
    const saved = parseInt(localStorage.getItem(key) || '');
    if (saved) p.el.style.height = saved + 'px';
    const hs = document.createElement('div');
    hs.className = 'panel-resizer';
    p.el.after(hs);
    hs.addEventListener('pointerdown', e => {
      if (p.el.classList.contains('collapsed')) return;
      e.preventDefault();
      hs.setPointerCapture(e.pointerId);
      hs.classList.add('drag');
      const startY = e.clientY, startH = p.el.getBoundingClientRect().height;
      const move = (ev: PointerEvent) => { p.el.style.height = Math.max(70, Math.min(700, startH + ev.clientY - startY)) + 'px'; };
      const up = () => {
        hs.classList.remove('drag');
        hs.removeEventListener('pointermove', move); hs.removeEventListener('pointerup', up);
        try { localStorage.setItem(key, String(Math.round(p.el.getBoundingClientRect().height))); } catch {}
      };
      hs.addEventListener('pointermove', move); hs.addEventListener('pointerup', up);
    });
  });
}
