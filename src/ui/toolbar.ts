import { app } from '../app';
import { el } from '../core/util';
import { css } from '../core/color';
import { t } from '../i18n';
import { icon } from './icons';
import { openColorPicker } from './colorpicker';

export class Toolbar {
  private list: HTMLElement;
  private colors: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();

  constructor(public el: HTMLElement) {
    this.list = el.appendChild(document.createElement('div'));
    this.list.className = 'tools';
    this.colors = el.appendChild(document.createElement('div'));
    this.colors.className = 'colors';
    this.build();
    this.buildColors();
    new ResizeObserver(() => this.layout()).observe(el);
  }

  /** One column when there is room, otherwise wrap into more columns. */
  private layout() {
    const avail = this.el.clientHeight - this.colors.offsetHeight - 20;
    const n = this.buttons.size;
    const rows = Math.max(1, Math.floor((avail + 2) / 32));
    const cols = Math.ceil(n / rows);
    const rowsCss = `repeat(${Math.ceil(n / cols)}, 30px)`, wCss = cols * 30 + (cols - 1) * 3 + 'px';
    if (this.list.style.gridTemplateRows !== rowsCss) this.list.style.gridTemplateRows = rowsCss;
    if (this.list.style.width !== wCss) this.list.style.width = wCss;
  }

  private build() {
    this.list.innerHTML = '';
    this.buttons.clear();
    const groups = ['move', 'marquee', 'crop', 'eyedropper', 'gradient', 'blur', 'dodge', 'text', 'hand'];
    for (const tl of app.tools) {
      if (groups.includes(tl.id) && tl.id !== 'move') this.list.append(el('div', { class: 'tool-sep' }));
      const b = el('button', { class: 'tool-btn' + (tl.implemented ? '' : ' soon') }, icon(tl.iconName, 19)) as HTMLButtonElement;
      b.addEventListener('click', () => app.setTool(tl.id));
      this.buttons.set(tl.id, b);
      this.list.append(b);
    }
  }

  render() {
    for (const tl of app.tools) {
      const b = this.buttons.get(tl.id)!;
      b.classList.toggle('on', tl === app.tool);
      b.dataset.tip = t(tl.nameKey) + (tl.key ? ` (${tl.key})` : '') + (tl.implemented ? '' : ` — ${t('app.soon')}`);
      b.setAttribute('aria-label', t(tl.nameKey));
    }
  }

  private buildColors() {
    const fg = el('button', { class: 'swatch fg' });
    const bg = el('button', { class: 'swatch bg' });
    const swap = el('button', { class: 'mini-btn swap' }, icon('swap', 12));
    const reset = el('button', { class: 'mini-btn reset' }, el('span', { class: 'reset-ico' }, el('i'), el('i')));
    fg.addEventListener('click', () => openColorPicker(app.fg, t('dlg.color.fg'), c => app.setColor('fg', c)));
    bg.addEventListener('click', () => openColorPicker(app.bg, t('dlg.color.bg'), c => app.setColor('bg', c)));
    swap.addEventListener('click', () => { const f = app.fg; app.fg = app.bg; app.bg = f; app.saveSettings(); app.update('colors'); });
    reset.addEventListener('click', () => { app.setColor('fg', { r: 0, g: 0, b: 0 }); app.setColor('bg', { r: 255, g: 255, b: 255 }); });
    this.colors.append(el('div', { class: 'swatches' }, bg, fg, swap, reset));
  }

  renderColors() {
    const fg = this.colors.querySelector('.swatch.fg') as HTMLElement;
    const bg = this.colors.querySelector('.swatch.bg') as HTMLElement;
    fg.style.background = css(app.fg);
    bg.style.background = css(app.bg);
    fg.dataset.tip = t('colors.fg');
    bg.dataset.tip = t('colors.bg');
    (this.colors.querySelector('.swap') as HTMLElement).dataset.tip = t('colors.swap');
    (this.colors.querySelector('.reset') as HTMLElement).dataset.tip = t('colors.reset');
  }
}
