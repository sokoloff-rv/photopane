import { app } from '../app';
import { el } from '../core/util';
import { t, getLang } from '../i18n';
import { icon } from './icons';

type Item = string | { sub: string; items: Item[] };

const MENUS: { key: string; items: Item[] }[] = [
  { key: 'menu.file', items: ['new', 'newFromClipboard', 'open', '-', 'place', '-', 'save', 'saveAs', 'export', '-', 'close'] },
  { key: 'menu.edit', items: ['undo', 'redo', '-', 'cut', 'copy', 'copyMerged', 'paste', 'clear', '-', 'fill', 'fillBg', '-', 'freeTransform',
    { sub: 'cmd.transform', items: ['rotateLayer180', 'rotateLayerCW', 'rotateLayerCCW', '-', 'flipLayerH', 'flipLayerV'] }, '-', 'settings'] },
  { key: 'menu.image', items: [
    { sub: 'cmd.adjustments', items: ['enhance', 'levels', 'curves', 'hueSat', '-', 'invert', 'desaturate'] }, '-',
    'autoTone', 'autoContrast', 'autoColor', '-', 'imageSize', 'canvasSize',
    { sub: 'cmd.rotation', items: ['rot180', 'rotCW', 'rotCCW', 'rotArbitrary', '-', 'flipCanvasH', 'flipCanvasV'] }, 'cropToSel', '-',
    'upscale', 'removeBg', 'removeObject'] },
  { key: 'menu.layer', items: ['newLayer', 'newGroup', 'duplicate', 'deleteLayer', '-', 'layerViaCopy', 'layerViaCut', '-', 'layerStyle',
    { sub: 'cmd.layerMask', items: ['maskReveal', 'maskHide', 'maskFromSel', 'maskHideSel', '-', 'maskToggle', 'maskApply', 'maskDelete'] },
    'clipMask', '-', 'groupLayers', 'ungroup', '-',
    { sub: 'cmd.arrange', items: ['bringFront', 'bringForward', 'sendBackward', 'sendBack'] }, 'lockAlpha', '-',
    'rasterize', '-', 'mergeDown', 'mergeVisible', 'stampVisible', 'flatten'] },
  { key: 'menu.select', items: ['selectAll', 'deselect', 'reselect', 'inverse', '-',
    { sub: 'cmd.modify', items: ['feather', 'expand', 'contract', 'smooth'] }, '-', 'selectLayerPixels', 'selectSubject'] },
  { key: 'menu.filter', items: ['gaussian', 'unsharp', 'noise', '-', { sub: 'cmd.blurGallery', items: ['fieldBlur', 'irisBlur', 'tiltShift'] }, '-', 'vignette'] },
  { key: 'menu.view', items: ['zoomIn', 'zoomOut', 'fit', 'actual', '-', 'rulers', 'showGuides', 'snap', 'clearGuides', '-', 'language'] },
  { key: 'menu.help', items: ['shortcuts', 'about'] },
];

export function prettyKey(k: string) {
  return k.replace('Backspace', '⌫').replace('Delete', 'Del').replace('Escape', 'Esc');
}

export class MenuBar {
  private open: HTMLElement | null = null;

  constructor(public el: HTMLElement) {
    document.addEventListener('pointerdown', e => { if (this.open && !this.el.contains(e.target as Node)) this.close(); });
    window.addEventListener('blur', () => this.close());
    this.render();
  }

  close() { this.open?.classList.remove('open'); this.open = null; }

  render() {
    this.el.innerHTML = '';
    const logo = el('div', { class: 'brand' }, icon('logo', 18), el('span', {}, 'PhotoPane'));
    const menus = el('nav', { class: 'menus' });
    for (const m of MENUS) {
      const btn = el('button', { class: 'menu-btn' }, t(m.key));
      const wrap = el('div', { class: 'menu' }, btn);
      btn.addEventListener('pointerdown', e => {
        e.preventDefault();
        if (this.open === wrap) { this.close(); return; }
        this.show(wrap, m.items);
      });
      btn.addEventListener('pointerenter', () => { if (this.open && this.open !== wrap) this.show(wrap, m.items); });
      menus.append(wrap);
    }
    const lang = el('button', { class: 'chip', title: t('cmd.language') }, icon('languages', 14), el('span', {}, getLang().toUpperCase()));
    lang.addEventListener('click', () => app.run('language'));
    this.el.append(logo, menus, el('div', { style: { flex: '1' } }), lang);
  }

  private show(wrap: HTMLElement, items: Item[]) {
    this.close();
    wrap.querySelector('.menu-drop')?.remove();
    wrap.append(this.buildList(items));
    wrap.classList.add('open');
    this.open = wrap;
  }

  private buildList(items: Item[]): HTMLElement {
    const list = el('div', { class: 'menu-drop' });
    for (const it of items) {
      if (it === '-') { list.append(el('div', { class: 'menu-sep' })); continue; }
      if (typeof it === 'object') {
        const sub = el('div', { class: 'menu-item has-sub' }, el('span', { class: 'mi-check' }), el('span', { class: 'mi-label' }, t(it.sub)), icon('chevronRight', 14));
        const child = this.buildList(it.items);
        child.classList.add('sub');
        sub.append(child);
        list.append(sub);
        continue;
      }
      const c = app.commands.get(it);
      const enabled = !!c && (!c.enabled || c.enabled());
      const checked = !!c?.checked?.();
      const row = el('div', { class: 'menu-item' + (enabled ? '' : ' disabled') },
        el('span', { class: 'mi-check' }, checked ? icon('check', 13) : ''),
        el('span', { class: 'mi-label' }, t(c?.label || 'cmd.' + it)),
        el('span', { class: 'mi-key' }, c?.keys?.[0] ? prettyKey(c.keys[0]) : ''));
      if (!c) row.title = t('app.soon');
      row.addEventListener('click', e => {
        e.stopPropagation();
        if (!enabled) return;
        this.close();
        app.run(it);
      });
      list.append(row);
    }
    return list;
  }
}
