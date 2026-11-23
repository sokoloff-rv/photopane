import { el } from '../core/util';
import { t } from '../i18n';
import { icon } from './icons';

export interface DialogOptions {
  title: string;
  body: HTMLElement;
  okLabel?: string;
  cancelLabel?: string | null;
  width?: number;
  onOk?: () => boolean | void | Promise<boolean | void>;
  onCancel?: () => void;
  extraButtons?: HTMLElement[];
  /** Non-dimming dialog placed beside the image (adjustments with live preview). */
  side?: boolean;
  /** Non-dimming dialog that lets clicks through to the canvas (color picker eyedropper). */
  passthrough?: boolean;
}

let openCount = 0;
export const dialogOpen = () => openCount > 0;

/**
 * The open side window (Adjust, Levels, a filter, Layer Style). It previews on the layer, so while it is
 * open the rest of the editor must not change the document: one such window at a time, no tab switching,
 * history jumps, layer changes or painting. Viewing (zoom, pan, the before/after line) stays available.
 */
let sideCard: HTMLElement | null = null;
export const sideDialogOpen = () => !!sideCard;

/** Briefly shake the open side window to show it has to be finished first. Returns false if there is none. */
export function nudgeSideDialog(): boolean {
  const c = sideCard;
  if (!c) return false;
  c.classList.remove('nudge');
  void c.offsetWidth;
  c.classList.add('nudge');
  return true;
}

/** Parts of the window that change the document; the navigator panel only moves the view. */
const LOCKED_WHILE_SIDE = '.tabs, .toolbar, .optionsbar, .panel.layers, .panel.hist';
function sideGuard(e: Event) {
  const target = e.target as Element | null;
  if (!sideCard || !target?.closest?.(LOCKED_WHILE_SIDE)) return;
  e.preventDefault(); e.stopPropagation();
  if (e.type === 'pointerdown') nudgeSideDialog();
}

export function openDialog(o: DialogOptions): { close: () => void; root: HTMLElement } {
  openCount++;
  const ok = el('button', { class: 'btn primary' }, o.okLabel || t('dlg.ok'));
  const cancel = o.cancelLabel === null ? null : el('button', { class: 'btn' }, o.cancelLabel || t('dlg.cancel'));
  const closeX = el('button', { class: 'icon-btn dlg-x' }, icon('x', 16));
  const header = el('div', { class: 'dlg-head' }, el('div', { class: 'dlg-title' }, o.title), closeX);
  const card = el('div', { class: 'dlg', style: { width: (o.width || 420) + 'px' } },
    header,
    el('div', { class: 'dlg-body' }, o.body),
    el('div', { class: 'dlg-foot' }, ...(o.extraButtons || []), el('div', { style: { flex: '1' } }), cancel, ok));
  const overlay = el('div', { class: 'dlg-overlay' + (o.side ? ' side' : '') + (o.passthrough ? ' pass' : '') }, card);
  document.body.append(overlay);
  if (o.side) {
    sideCard = card;
    for (const type of ['pointerdown', 'click', 'dblclick', 'contextmenu']) window.addEventListener(type, sideGuard, { capture: true });
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true; openCount--;
    if (o.side && sideCard === card) {
      sideCard = null;
      for (const type of ['pointerdown', 'click', 'dblclick', 'contextmenu']) window.removeEventListener(type, sideGuard, { capture: true });
    }
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 120);
    window.removeEventListener('keydown', onKey, true);
  };
  const doCancel = () => { o.onCancel?.(); close(); };
  const doOk = async () => {
    const r = await o.onOk?.();
    if (r !== false) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); doCancel(); }
    else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault(); e.stopPropagation();
      (document.activeElement as HTMLElement)?.blur?.();
      setTimeout(doOk, 0);
    } else e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  ok.addEventListener('click', doOk);
  cancel?.addEventListener('click', doCancel);
  closeX.addEventListener('click', doCancel);

  // draggable by header
  header.addEventListener('pointerdown', e => {
    if ((e.target as HTMLElement).closest('button')) return;
    const r = card.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    card.style.position = 'fixed';
    card.style.margin = '0';
    const move = (ev: PointerEvent) => { card.style.left = ev.clientX - dx + 'px'; card.style.top = ev.clientY - dy + 'px'; };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  setTimeout(() => (card.querySelector('input:not([type=checkbox]):not([type=range])') as HTMLInputElement | null)?.select?.(), 30);
  return { close, root: card };
}

export function confirmDialog(text: string, okLabel?: string): Promise<boolean> {
  return new Promise(res => {
    openDialog({ title: 'PhotoPane', body: el('p', { class: 'dlg-text' }, text), okLabel, width: 380, onOk: () => res(true), onCancel: () => res(false) });
  });
}

export function promptNumber(title: string, label: string, value: number, min: number, max: number, unit = ''): Promise<number | null> {
  return new Promise(res => {
    const input = el('input', { class: 'text-input', type: 'number', value, min, max, step: 'any' }) as HTMLInputElement;
    const body = el('div', { class: 'form-row' }, el('label', {}, label), input, unit ? el('span', { class: 'muted' }, unit) : null);
    openDialog({
      title, body, width: 340,
      onOk: () => { const v = parseFloat(input.value); res(isNaN(v) ? null : Math.max(min, Math.min(max, v))); },
      onCancel: () => res(null),
    });
  });
}

/* ---------- toasts ---------- */
let toastHost: HTMLElement | null = null;
export function toast(text: string, kind: 'info' | 'error' = 'info', ms = 2600) {
  if (!toastHost) { toastHost = el('div', { class: 'toasts' }); document.body.append(toastHost); }
  const tEl = el('div', { class: 'toast ' + kind }, text);
  toastHost.append(tEl);
  setTimeout(() => { tEl.classList.add('out'); setTimeout(() => tEl.remove(), 250); }, ms);
}
