import { app } from '../../app';
import { el } from '../../core/util';
import { t } from '../../i18n';
import { Panel } from './panel';
import { iconButton } from '../controls';

export class HistoryPanel extends Panel {
  private list: HTMLElement;
  private count: HTMLElement;

  constructor() {
    super('panel.history', 'hist');
    this.list = el('div', { class: 'hist-list' });
    this.body.append(this.list);
    this.count = el('span', { class: 'panel-badge' });
    this.extra.append(
      this.count,
      iconButton('undo', t('cmd.undo'), () => app.run('undo')),
      iconButton('redo', t('cmd.redo'), () => app.run('redo')),
    );
  }

  render() {
    this.renderTitle();
    this.list.innerHTML = '';
    const d = app.doc;
    if (!d) { this.count.textContent = ''; return; }
    const h = d.history;
    this.count.textContent = `${h.index + 1}/${h.entries.length}`;
    h.entries.forEach((e, i) => {
      const row = el('div', { class: 'hist-row' + (i === h.index ? ' on' : '') + (i > h.index ? ' future' : '') },
        el('span', { class: 'hist-dot' }), el('span', {}, t(e.label)));
      row.addEventListener('click', () => app.historyGo(() => h.goto(i)));
      this.list.append(row);
    });
    const on = this.list.querySelector('.on') as HTMLElement | null;
    on?.scrollIntoView({ block: 'nearest' });
  }
}
