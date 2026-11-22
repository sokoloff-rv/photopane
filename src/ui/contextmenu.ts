import { app } from '../app';
import { el, clamp } from '../core/util';
import { t } from '../i18n';
import { PEvent } from '../tools/tool';
import { ctx2d } from '../core/util';
import { prettyKey } from './menubar';

export type CtxItem = '-' | { cmd: string; label?: string } | { label: string; run: () => void; checked?: boolean };

let current: HTMLElement | null = null;

export function closeContextMenu() {
  current?.remove();
  current = null;
  document.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', closeContextMenu);
}
function onOutside(e: Event) { if (current && !current.contains(e.target as Node)) closeContextMenu(); }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { e.stopPropagation(); closeContextMenu(); } }

function place(node: HTMLElement, x: number, y: number) {
  document.body.append(node);
  const r = node.getBoundingClientRect();
  node.style.left = clamp(x, 4, window.innerWidth - r.width - 4) + 'px';
  node.style.top = (y + r.height > window.innerHeight - 4 ? Math.max(4, y - r.height) : y) + 'px';
  current = node;
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeContextMenu);
  }, 0);
}

export function showContextMenu(x: number, y: number, items: CtxItem[]) {
  closeContextMenu();
  const list = el('div', { class: 'menu-drop ctx-menu' });
  for (const it of items) {
    if (it === '-') { if (list.lastElementChild && !list.lastElementChild.classList.contains('menu-sep')) list.append(el('div', { class: 'menu-sep' })); continue; }
    let label: string, run: () => void, enabled = true, key = '', checked = false;
    if ('cmd' in it) {
      const c = app.commands.get(it.cmd);
      if (!c) continue;
      label = t(it.label || c.label || 'cmd.' + it.cmd);
      enabled = !c.enabled || c.enabled();
      key = c.keys?.[0] ? prettyKey(c.keys[0]) : '';
      run = () => app.run(it.cmd);
    } else { label = it.label; run = it.run; checked = !!it.checked; }
    const row = el('div', { class: 'menu-item' + (enabled ? '' : ' disabled') },
      el('span', { class: 'mi-check' }, checked ? '✓' : ''), el('span', { class: 'mi-label' }, label), el('span', { class: 'mi-key' }, key));
    row.addEventListener('click', () => { if (!enabled) return; closeContextMenu(); run(); });
    list.append(row);
  }
  while (list.lastElementChild?.classList.contains('menu-sep')) list.lastElementChild.remove();
  if (!list.children.length) return;
  place(list, x, y);
}

/** Brush size / hardness popover (Photoshop shows a brush picker on right click). */
function brushPopover(x: number, y: number) {
  closeContextMenu();
  const o = app.tool.o as any;
  const row = (label: string, key: 'size' | 'hardness', min: number, max: number, unit: string) => {
    const val = el('span', { class: 'ctx-val mono' }, `${o[key]} ${unit}`);
    const r = el('input', { type: 'range', class: 'range', min, max, value: o[key] }) as HTMLInputElement;
    r.addEventListener('input', () => { o[key] = +r.value; val.textContent = `${r.value} ${unit}`; app.saveSettings(); app.update('options', 'overlay'); });
    return el('div', { class: 'ctx-row' }, el('div', { class: 'ctx-row-head' }, el('span', {}, label), val), r);
  };
  const pop = el('div', { class: 'menu-drop ctx-menu ctx-pop' },
    row(t('opt.size'), 'size', 1, 1000, 'px'),
    row(t('opt.hardness'), 'hardness', 0, 100, '%'));
  place(pop, x, y);
}

/** Layers with visible pixels under a document point, topmost first. */
function layersAt(px: number, py: number) {
  const d = app.doc!;
  return d.layers.filter(l => !l.isGroup && l.effectiveVisible).reverse().filter(l => {
    const lx = Math.floor(px - l.x), ly = Math.floor(py - l.y);
    if (lx < 0 || ly < 0 || lx >= l.canvas.width || ly >= l.canvas.height) return false;
    return ctx2d(l.canvas).getImageData(lx, ly, 1, 1).data[3] > 0;
  });
}

const SELECT_TOOLS = ['marquee', 'lasso', 'freeLasso', 'wand'];

export function selectionMenu(): CtxItem[] {
  return [
    { cmd: 'deselect', label: 'ctx.deselect' },
    { cmd: 'inverse', label: 'ctx.inverse' },
    { cmd: 'feather' },
    '-',
    { cmd: 'layerViaCopy', label: 'ctx.layerViaCopy' },
    { cmd: 'layerViaCut', label: 'ctx.layerViaCut' },
    { cmd: 'newLayer' },
    '-',
    { cmd: 'freeTransform' },
    { cmd: 'transformSel' },
    '-',
    { cmd: 'fillDialog' },
    { cmd: 'strokeSel' },
  ];
}

/** Right click in the canvas: context menu depending on the tool, like Photoshop. */
export function openCanvasContextMenu(e: MouseEvent, pe: PEvent) {
  const d = app.doc;
  if (!d || app.tool.busy()) return;
  const id = app.tool.id;
  if (id === 'brush' || id === 'eraser') { brushPopover(e.clientX, e.clientY); return; }
  if (id === 'move') {
    const ls = layersAt(pe.x, pe.y);
    const items: CtxItem[] = ls.map(l => ({ label: l.name, checked: l.id === d.activeId, run: () => { d.setActive(l); app.layersPanel.clearMulti(); app.update('layers', 'options'); } }));
    if (d.selection) items.push('-', ...selectionMenu());
    showContextMenu(e.clientX, e.clientY, items);
    return;
  }
  if (d.selection) { showContextMenu(e.clientX, e.clientY, selectionMenu()); return; }
  if (SELECT_TOOLS.includes(id)) {
    showContextMenu(e.clientX, e.clientY, [{ cmd: 'selectAll', label: 'ctx.selectAll' }, { cmd: 'reselect' }, '-', { cmd: 'newLayer' }, { cmd: 'freeTransform' }]);
  }
}
