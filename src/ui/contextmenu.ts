import { app } from '../app';
import { el, clamp } from '../core/util';
import { t } from '../i18n';
import { PEvent } from '../tools/tool';
import { ctx2d, readPixels } from '../core/util';
import { prettyKey } from './menubar';

export type CtxItem = '-' | { cmd: string; label?: string } | { label: string; run: () => void; checked?: boolean };

let current: HTMLElement | null = null;
/** The button that opened the popup: clicking it again closes the popup (instead of reopening it). */
let anchor: HTMLElement | null = null;

export function closeContextMenu() {
  current?.remove();
  current = null;
  anchor = null;
  delete document.body.dataset.popup;
  document.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', closeContextMenu);
}
function onOutside(e: Event) {
  if (!current || current.contains(e.target as Node)) return;
  const a = anchor;
  closeContextMenu();
  // a press on the button that opened it only closes it: its click must not open it again
  if (a && a.contains(e.target as Node)) {
    const swallow = (ev: Event) => { if (a.contains(ev.target as Node)) { ev.stopPropagation(); ev.preventDefault(); } window.removeEventListener('click', swallow, true); };
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true), 600);
  }
}
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { e.stopPropagation(); closeContextMenu(); } }

function place(node: HTMLElement, x: number, y: number) {
  document.body.append(node);
  const r = node.getBoundingClientRect();
  node.style.left = clamp(x, 4, window.innerWidth - r.width - 4) + 'px';
  node.style.top = (y + r.height > window.innerHeight - 4 ? Math.max(4, y - r.height) : y) + 'px';
  current = node;
  // dialogs leave Esc to an open popup
  document.body.dataset.popup = '1';
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeContextMenu);
  }, 0);
}

/**
 * Show a ready-made popup (a menu-drop element) at x, y; it closes on an outside click, Esc, or a second
 * click on `from`, the button that opened it.
 */
export function showPopup(node: HTMLElement, x: number, y: number, from?: HTMLElement) {
  closeContextMenu();
  place(node, x, y);
  anchor = from ?? null;
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
/** Sliders for every brush-like tool option, in the order the options bar shows them. */
const BRUSH_SLIDERS: { key: string; label: string; min: number; max: number; unit: string }[] = [
  { key: 'size', label: 'opt.size', min: 1, max: 1000, unit: 'px' },
  { key: 'hardness', label: 'opt.hardness', min: 0, max: 100, unit: '%' },
  { key: 'opacity', label: 'opt.opacity', min: 1, max: 100, unit: '%' },
  { key: 'flow', label: 'opt.flow', min: 1, max: 100, unit: '%' },
  { key: 'strength', label: 'opt.strength', min: 1, max: 100, unit: '%' },
  { key: 'tolerance', label: 'opt.tolerance', min: 0, max: 100, unit: '%' },
];
const BRUSH_CHECKS: { key: string; label: string }[] = [
  { key: 'pressure', label: 'opt.pressure' }, { key: 'aligned', label: 'opt.aligned' }, { key: 'allLayers', label: 'opt.allLayers' },
  { key: 'showSource', label: 'opt.showSource' },
];

/**
 * Right click with a brush-like tool: the same settings as the options bar, as sliders that are easy to
 * move on the fly (size and hardness first, then opacity, flow, strength/exposure, range…).
 */
function brushPopover(x: number, y: number) {
  closeContextMenu();
  const tool = app.tool;
  const o = tool.o as any;
  const changed = () => { app.saveSettings(); app.update('options', 'overlay'); };
  const row = (label: string, key: string, min: number, max: number, unit: string) => {
    const val = el('span', { class: 'ctx-val mono' }, `${o[key]} ${unit}`);
    // the size on a log scale (as in the options bar): small and medium brushes get most of the track
    const lg = key === 'size';
    const span = Math.log(max / min);
    const toPos = (v: number) => (lg ? Math.round(1000 * Math.log(clamp(v, min, max) / min) / span) : v);
    const fromPos = (p: number) => (lg ? Math.round(min * Math.exp(span * p / 1000)) : p);
    const r = el('input', { type: 'range', class: 'range', min: lg ? 0 : min, max: lg ? 1000 : max, value: toPos(o[key]) }) as HTMLInputElement;
    r.addEventListener('input', () => { o[key] = fromPos(+r.value); val.textContent = `${o[key]} ${unit}`; changed(); });
    return el('div', { class: 'ctx-row' }, el('div', { class: 'ctx-row-head' }, el('span', {}, label), val), r);
  };
  const rows: HTMLElement[] = [];
  for (const s of BRUSH_SLIDERS) {
    if (typeof o[s.key] !== 'number') continue;
    const label = s.key === 'strength' && (tool.id === 'dodge' || tool.id === 'burn') ? 'opt.exposure' : s.label;
    rows.push(row(t(label), s.key, s.min, s.max, s.unit));
  }
  // dodge / burn range as a segmented choice
  if (typeof o.range === 'string') {
    const seg = el('div', { class: 'seg ctx-seg' });
    for (const v of ['shadows', 'midtones', 'highlights']) {
      const b = el('button', { class: 'seg-btn' + (o.range === v ? ' on' : '') }, t('opt.' + v));
      b.addEventListener('click', () => { o.range = v; seg.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('on', x === b)); changed(); });
      seg.append(b);
    }
    rows.push(seg);
  }
  for (const c of BRUSH_CHECKS) {
    if (typeof o[c.key] !== 'boolean') continue;
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = o[c.key];
    cb.addEventListener('change', () => { o[c.key] = cb.checked; changed(); });
    rows.push(el('label', { class: 'ctx-check' }, cb, el('span', {}, t(c.label))));
  }
  const pop = el('div', { class: 'menu-drop ctx-menu ctx-pop' }, ...rows);
  place(pop, x, y);
}

/** Layers with visible pixels under a document point, topmost first. */
function layersAt(px: number, py: number) {
  const d = app.doc!;
  return d.layers.filter(l => !l.isGroup && l.effectiveVisible).reverse().filter(l => {
    const lx = Math.floor(px - l.x), ly = Math.floor(py - l.y);
    if (lx < 0 || ly < 0 || lx >= l.canvas.width || ly >= l.canvas.height) return false;
    return readPixels(l.canvas, lx, ly, 1, 1).data[3] > 0;
  });
}

const SELECT_TOOLS = ['marquee', 'lasso', 'wand'];

export function selectionMenu(): CtxItem[] {
  return [
    { cmd: 'deselect', label: 'ctx.deselect' },
    { cmd: 'inverse', label: 'ctx.inverse' },
    '-',
    { cmd: 'feather' }, { cmd: 'expand' }, { cmd: 'contract' }, { cmd: 'smooth' },
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
    '-',
    { cmd: 'removeObject' },
  ];
}

/** Right click in the canvas: context menu depending on the tool, like Photoshop. */
export function openCanvasContextMenu(e: MouseEvent, pe: PEvent) {
  const d = app.doc;
  if (!d || app.tool.busy()) return;
  const id = app.tool.id;
  if (app.tool.brushSize() > 0) { brushPopover(e.clientX, e.clientY); return; }
  if (id === 'move') {
    const ls = layersAt(pe.x, pe.y);
    const items: CtxItem[] = ls.map(l => ({ label: l.name, checked: l.id === d.activeId, run: () => { d.setActive(l); app.layersPanel.clearMulti(); app.update('layers', 'options'); } }));
    if (d.selection) items.push('-', ...selectionMenu());
    else items.push(...(items.length ? ['-' as const] : []), { cmd: 'freeTransform' });
    showContextMenu(e.clientX, e.clientY, items);
    return;
  }
  if (d.selection) { showContextMenu(e.clientX, e.clientY, selectionMenu()); return; }
  if (SELECT_TOOLS.includes(id)) {
    showContextMenu(e.clientX, e.clientY, [
      { cmd: 'selectAll', label: 'ctx.selectAll' }, { cmd: 'reselect' }, { cmd: 'selectSubject' }, { cmd: 'selectLayerPixels', label: 'ctx.selectPixels' },
      '-', { cmd: 'newLayer' }, { cmd: 'freeTransform' },
    ]);
  }
}
