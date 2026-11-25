import { app } from '../app';
import { el } from '../core/util';
import { t, getLang } from '../i18n';
import { icon } from './icons';

type Item = string | { sub: string; items: Item[] };

// One obvious path per action: selection commands live in the canvas context menu, layer commands in the
// Layers panel (buttons and right-click menu), language in the corner switch. Shortcuts keep working.
const MENUS: { key: string; items: Item[] }[] = [
  { key: 'menu.file', items: ['new', 'newFromClipboard', 'open', '-', 'place', '-', 'save', 'saveAs', 'export', '-', 'print', '-', 'batch', '-', 'close'] },
  { key: 'menu.edit', items: ['undo', 'redo', '-', 'cut', 'copy', 'copyMerged', 'paste', 'clear', '-', 'settings'] },
  { key: 'menu.image', items: [
    'enhance', 'levels', 'curves', 'hslMixer', 'toning', '-',
    'imageSize', 'canvasSize',
    { sub: 'cmd.rotation', items: ['rot180', 'rotCW', 'rotCCW', 'rotArbitrary', '-', 'flipCanvasH', 'flipCanvasV'] }, 'cropToSel', '-',
    'upscale', 'removeBg', 'removeObject'] },
  // all filters at once, in four groups as people look for them: blur, sharpness & noise, effects, colour (LUT last)
  { key: 'menu.filter', items: [
    'gaussian', 'motionBlur', 'radialBlur', 'surfaceBlur', 'fieldBlur', 'irisBlur', 'tiltShift', '-',
    'unsharp', 'highPass', 'dehaze', 'denoise', 'noise', '-',
    'glow', 'chromatic', 'emboss', 'findEdges', 'pixelate', 'halftone', '-',
    'desaturate', 'sepia', 'invert', 'posterize', 'threshold', 'gradientMap', 'lut',
  ] },
  { key: 'menu.view', items: ['zoomIn', 'zoomOut', 'fit', 'actual', '-', 'compare', '-', 'rulers', 'showGuides', 'snap', 'clearGuides', '-', 'resetLayout'] },
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
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && this.open) { e.stopPropagation(); this.close(); } }, true);
    this.render();
  }

  close() {
    this.el.querySelectorAll('.menu-drop').forEach(n => n.remove());
    this.el.querySelectorAll('.menu.open').forEach(n => n.classList.remove('open'));
    this.open = null;
  }

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
        this.show(wrap, m.items, m.key === 'menu.filter');
      });
      btn.addEventListener('pointerenter', () => { if (this.open && this.open !== wrap) this.show(wrap, m.items, m.key === 'menu.filter'); });
      menus.append(wrap);
    }
    const lang = el('button', { class: 'chip', title: t('cmd.language') }, icon('languages', 14), el('span', {}, getLang().toUpperCase()));
    lang.addEventListener('click', () => app.run('language'));
    this.el.append(logo, menus, el('div', { style: { flex: '1' } }), lang);
  }

  /** `noKeys`: the Filter menu lists every filter equally, so no shortcut stands out (they still work). */
  private show(wrap: HTMLElement, items: Item[], noKeys = false) {
    this.close();
    wrap.append(this.buildList(items, noKeys));
    wrap.classList.add('open');
    this.open = wrap;
  }

  private buildList(items: Item[], noKeys = false): HTMLElement {
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
      const enabled = !!c && (!c.enabled || c.enabled()) && !app.commandLocked(it);
      const checked = !!c?.checked?.();
      const row = el('div', { class: 'menu-item' + (enabled ? '' : ' disabled') },
        el('span', { class: 'mi-check' }, checked ? icon('check', 13) : ''),
        el('span', { class: 'mi-label' }, t(c?.label || 'cmd.' + it)),
        el('span', { class: 'mi-key' }, c?.keys?.[0] && !noKeys ? prettyKey(c.keys[0]) : ''));
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
