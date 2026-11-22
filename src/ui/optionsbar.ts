import { app } from '../app';
import { el } from '../core/util';
import { t } from '../i18n';
import { icon } from './icons';

export class OptionsBar {
  constructor(public el: HTMLElement) {}

  render() {
    this.el.innerHTML = '';
    const tl = app.tool;
    const head = el('div', { class: 'opt-tool' }, icon(tl.iconName, 16), el('span', {}, t(tl.nameKey)));
    this.el.append(head, el('div', { class: 'opt-sep' }));
    for (const c of tl.options()) if (c) this.el.append(c);
  }
}

