import { app } from '../app';
import { el } from '../core/util';
import { t } from '../i18n';
import { icon } from './icons';

export class Tabs {
  constructor(public el: HTMLElement) {}

  render() {
    this.el.innerHTML = '';
    this.el.style.display = app.docs.length ? '' : 'none';
    for (const d of app.docs) {
      const x = el('button', { class: 'tab-x', title: t('cmd.close') }, icon('x', 12));
      const tab = el('div', { class: 'tab' + (d === app.doc ? ' on' : '') },
        el('span', { class: 'tab-name' }, d.name + (d.dirty ? ' •' : '')),
        el('span', { class: 'tab-zoom' }, Math.round(d.zoom * app.viewport.dpr * 100) + '%'), x);
      tab.title = `${d.name} — ${d.width}×${d.height}`;
      tab.addEventListener('pointerdown', e => { if (e.button === 1) { e.preventDefault(); app.closeDoc(d); } else app.setDoc(d); });
      x.addEventListener('pointerdown', e => { e.stopPropagation(); });
      x.addEventListener('click', e => { e.stopPropagation(); app.closeDoc(d); });
      this.el.append(tab);
    }
  }
}
