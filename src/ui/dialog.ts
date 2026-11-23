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
  /** Side dialog: the command that opened it (the same one cannot be opened twice). */
  sideKey?: string;
  /** Side dialog that combines with other such windows (the adjustment chain). */
  chain?: boolean;
  /** Non-dimming dialog that lets clicks through to the canvas (color picker eyedropper). */
  passthrough?: boolean;
}

let openCount = 0;
export const dialogOpen = () => openCount > 0;

/**
 * Open side windows (Adjust, Levels, filters, Layer Style). They preview on the layer, so while any is open
 * the rest of the editor must not change the document: no tab switching, history jumps, layer changes or
 * painting. Different correction and filter windows can be open together (the adjustment chain); viewing
 * (zoom, pan, the before/after line) stays available.
 */
export interface SideDialog { card: HTMLElement; key?: string; chain: boolean }
const sides: SideDialog[] = [];
export const sideDialogOpen = () => sides.length > 0;
export const sideDialogs = (): readonly SideDialog[] => sides;

/** Dialogs from bottom to top; only the top one takes the keyboard (Esc, Enter). */
const stack: HTMLElement[] = [];
function raise(card: HTMLElement) {
  const i = stack.indexOf(card);
  if (i >= 0) stack.splice(i, 1);
  stack.push(card);
  stack.forEach((c, k) => { (c.parentElement as HTMLElement).style.zIndex = String(300 + k); });
}

/**
 * Briefly shake a side window to show it is already open or has to be finished first: the one opened by
 * `key`, else the topmost. Returns false if there is none.
 */
export function nudgeSideDialog(key?: string): boolean {
  const d = (key && sides.find(x => x.key === key)) || [...sides].sort((a, b) => stack.indexOf(b.card) - stack.indexOf(a.card))[0];
  if (!d) return false;
  const c = d.card;
  raise(c);
  c.classList.remove('nudge');
  void c.offsetWidth;
  c.classList.add('nudge');
  return true;
}

/** Parts of the window that change the document; the navigator panel only moves the view. */
const LOCKED_WHILE_SIDE = '.tabs, .toolbar, .optionsbar, .panel.layers, .panel.hist';
function sideGuard(e: Event) {
  const target = e.target as Element | null;
  if (!sides.length || !target?.closest?.(LOCKED_WHILE_SIDE)) return;
  e.preventDefault(); e.stopPropagation();
  if (e.type === 'pointerdown') nudgeSideDialog();
}
const GUARDED = ['pointerdown', 'click', 'dblclick', 'contextmenu'];

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
  if (o.side) {
    // next to the side windows already open, towards the left
    const offset = sides.reduce((x, d) => x + d.card.offsetWidth + 12, 0);
    if (offset) overlay.style.paddingRight = `calc(var(--panels-w, 280px) + ${16 + offset}px)`;
    if (!sides.length) for (const type of GUARDED) window.addEventListener(type, sideGuard, { capture: true });
    sides.push({ card, key: o.sideKey, chain: !!o.chain });
    card.addEventListener('pointerdown', () => raise(card), true);
  }
  document.body.append(overlay);
  raise(card);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true; openCount--;
    const si = sides.findIndex(d => d.card === card);
    if (si >= 0) {
      sides.splice(si, 1);
      if (!sides.length) for (const type of GUARDED) window.removeEventListener(type, sideGuard, { capture: true });
    }
    const ki = stack.indexOf(card);
    if (ki >= 0) stack.splice(ki, 1);
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
    if (stack[stack.length - 1] !== card) return;   // another dialog is on top
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
