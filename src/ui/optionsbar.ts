import { app } from '../app';
import { el } from '../core/util';
import { t } from '../i18n';
import { icon } from './icons';

export class OptionsBar {
  constructor(public el: HTMLElement) {}

  render() {
    this.el.innerHTML = '';
    const so = app.sideOptions;
    if (so) {
      // a correction window is open: its own controls (they stay usable while the rest of the bar is locked)
      const box = el('div', { class: 'side-opts' }, el('div', { class: 'opt-tool' }, icon(so.icon, 16), el('span', {}, so.title)), el('div', { class: 'opt-sep' }));
      for (const c of so.items()) if (c) box.append(c);
      this.el.append(box);
      return;
    }
    const tl = app.tool;
    const head = el('div', { class: 'opt-tool' }, icon(tl.iconName, 16), el('span', {}, t(tl.nameKey)));
    this.el.append(head, el('div', { class: 'opt-sep' }));
    for (const c of tl.options()) if (c) this.el.append(c);
  }
}

