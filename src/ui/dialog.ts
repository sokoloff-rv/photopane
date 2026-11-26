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
  /** May return a promise: the window stays open (and blocks the editor) until it settles. */
  onCancel?: () => void | Promise<void>;
  extraButtons?: HTMLElement[];
  /** Non-dimming dialog placed beside the image (adjustments with live preview). */
  side?: boolean;
  /** Side dialog: the command that opened it (the same one cannot be opened twice). */
  sideKey?: string;
  /** Side dialog that combines with other such windows (the adjustment chain). */
  chain?: boolean;
  /** Non-dimming dialog that lets clicks through to the canvas (color picker eyedropper). */
  passthrough?: boolean;
  /** Where the window was dragged is remembered under this name (default: the side key or the title). */
  posKey?: string;
  /**
   * An information window that stays open while you work (Show Metadata): no dimming, clicks go through
   * around it, it blocks no other window or shortcut, and takes Esc / Enter only when it has the focus.
   */
  floating?: boolean;
  /** Keys the window lets its tool have (Delete removes a Field Blur pin); return true when handled. */
  keys?: (e: KeyboardEvent) => boolean;
}

/* ---------- remembered window positions (kept in this browser / app profile) ---------- */
const POS_STORE = 'pp.dialogPos';
function savedPositions(): Record<string, { x: number; y: number }> {
  try { return JSON.parse(localStorage.getItem(POS_STORE) || '{}'); } catch { return {}; }
}
function rememberPosition(key: string, x: number, y: number) {
  try {
    const all = savedPositions();
    all[key] = { x: Math.round(x), y: Math.round(y) };
    localStorage.setItem(POS_STORE, JSON.stringify(all));
  } catch { /* storage unavailable: positions are just not kept */ }
}
/** View → Reset layout: forget where windows were dragged; open ones go back to their usual place. */
export function resetDialogPositions() {
  try { localStorage.removeItem(POS_STORE); } catch { /* nothing kept */ }
  document.querySelectorAll<HTMLElement>('.dlg-overlay .dlg').forEach(card => {
    card.style.position = ''; card.style.left = ''; card.style.top = ''; card.style.margin = '';
  });
}

/** Put a window at x, y, wholly on screen (the app window may be smaller or on another monitor since then). */
function placeCard(card: HTMLElement, x: number, y: number) {
  // layout size, not the on-screen one (the opening animation scales the window a little)
  const w = card.offsetWidth, h = card.offsetHeight;
  card.style.position = 'fixed';
  card.style.margin = '0';
  card.style.left = Math.max(0, Math.min(x, window.innerWidth - w)) + 'px';
  card.style.top = Math.max(0, Math.min(y, window.innerHeight - h)) + 'px';
}

let openCount = 0;
export const dialogOpen = () => openCount > 0;
/** Something modal that is not a dialog (a busy overlay): the editor's shortcuts wait as for a dialog. */
export function holdDialog(): () => void {
  openCount++;
  let held = true;
  return () => { if (held) { held = false; openCount--; } };
}

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
  if (!sides.length || !target?.closest?.(LOCKED_WHILE_SIDE) || target.closest('.side-opts')) return;
  e.preventDefault(); e.stopPropagation();
  if (e.type === 'pointerdown') nudgeSideDialog();
}
const GUARDED = ['pointerdown', 'click', 'dblclick', 'contextmenu'];

export function openDialog(o: DialogOptions): { close: () => void; root: HTMLElement } {
  if (!o.floating) openCount++;
  const ok = el('button', { class: 'btn primary' }, o.okLabel || t('dlg.ok'));
  const cancel = o.cancelLabel === null ? null : el('button', { class: 'btn' }, o.cancelLabel || t('dlg.cancel'));
  const closeX = el('button', { class: 'icon-btn dlg-x' }, icon('x', 16));
  const header = el('div', { class: 'dlg-head' }, el('div', { class: 'dlg-title' }, o.title), closeX);
  const card = el('div', { class: 'dlg', style: { width: (o.width || 420) + 'px' } },
    header,
    el('div', { class: 'dlg-body' }, o.body),
    el('div', { class: 'dlg-foot' }, ...(o.extraButtons || []), el('div', { style: { flex: '1' } }), cancel, ok));
  const overlay = el('div', { class: 'dlg-overlay' + (o.side ? ' side' : '') + (o.passthrough || o.floating ? ' pass' : '') }, card);
  // under the correction windows and other dialogs, outside their keyboard order
  if (o.floating) overlay.style.zIndex = '290';
  if (o.side) {
    // next to the side windows already open, towards the left
    const offset = sides.reduce((x, d) => x + d.card.offsetWidth + 12, 0);
    if (offset) overlay.style.paddingRight = `calc(var(--panels-w, 280px) + ${16 + offset}px)`;
    if (!sides.length) for (const type of GUARDED) window.addEventListener(type, sideGuard, { capture: true });
    sides.push({ card, key: o.sideKey, chain: !!o.chain });
    card.addEventListener('pointerdown', () => raise(card), true);
  }
  document.body.append(overlay);
  // the place the user last dragged this window to
  const posKey = o.posKey ?? o.sideKey ?? o.title;
  const saved = savedPositions()[posKey];
  if (saved) placeCard(card, saved.x, saved.y);
  if (!o.floating) raise(card);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (!o.floating) openCount--;
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
  // OK or Cancel still working (a filter being written into the layer): further clicks and keys wait
  let pending = false;
  const settleWith = async (fn: () => unknown) => {
    if (pending || closed) return undefined;
    pending = true;
    try { return await fn(); } finally { pending = false; }
  };
  const doCancel = async () => {
    if (pending || closed) return;
    await settleWith(() => o.onCancel?.());
    close();
  };
  const doOk = async () => {
    if (pending || closed) return;
    const r = await settleWith(() => o.onOk?.());
    if (r !== false) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (o.floating) { if (!card.contains(document.activeElement)) return; }
    else if (stack[stack.length - 1] !== card) return;   // another dialog is on top
    if (document.body.dataset.popup) return;          // a popup menu of the dialog handles its own keys
    const inField = (e.target as HTMLElement)?.matches?.('input, select, textarea');
    if (o.keys && !inField && o.keys(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    // typing in a field outside the window (the zoom value in the navigator or status bar) is that field's own
    const tgt = e.target as HTMLElement | null;
    if (tgt && tgt !== document.body && !card.contains(tgt) && tgt.matches?.('input, select, textarea, [contenteditable]')) return;
    // stopImmediatePropagation: the window below, now on top, must not take the same key and close too
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); void doCancel(); }
    else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault(); e.stopImmediatePropagation();
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
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      // kept on screen, and stored as the same style position it is restored with
      placeCard(card, parseFloat(card.style.left) || 0, parseFloat(card.style.top) || 0);
      rememberPosition(posKey, parseFloat(card.style.left) || 0, parseFloat(card.style.top) || 0);
    };
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

/** Ask for a short text (a name); null when cancelled or empty. */
export function promptText(title: string, label: string, value: string, okLabel?: string): Promise<string | null> {
  return new Promise(res => {
    const input = el('input', { class: 'text-input', type: 'text', value, maxlength: 60 }) as HTMLInputElement;
    const body = el('div', { class: 'form-row' }, el('label', {}, label), input);
    openDialog({
      title, body, width: 380, okLabel,
      onOk: () => { const v = input.value.trim(); res(v || null); },
      onCancel: () => res(null),
    });
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

/* ---------------- busy overlay with progress and cancel ---------------- */
export function busy(text: string, onCancel?: () => void) {
  const label = el('div', { class: 'busy-text' }, text);
  const bar = el('div', { class: 'busy-bar' }, el('div', { class: 'busy-fill' }));
  const cancel = onCancel ? el('button', { class: 'btn sm' }, t('dlg.cancel')) : null;
  cancel?.addEventListener('click', () => onCancel?.());
  const root = el('div', { class: 'busy' }, el('div', { class: 'busy-card' }, el('div', { class: 'busy-spin' }), label, bar, cancel));
  document.body.append(root);
  // shortcuts (Ctrl+N, Ctrl+Z…) wait too: the result is written when it arrives
  const release = holdDialog();
  return {
    set(text: string, p?: number) {
      label.textContent = text;
      bar.style.visibility = p === undefined ? 'hidden' : 'visible';
      if (p !== undefined) (bar.firstChild as HTMLElement).style.width = Math.round(p * 100) + '%';
    },
    close() { root.remove(); release(); },
  };
}
