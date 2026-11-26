import { el, clamp } from '../core/util';
import { icon } from './icons';
import { RGB, css } from '../core/color';
import { openColorPicker } from './colorpicker';

/** Compact numeric field with a scrubbable label and a popup slider (Photoshop-style). */
export function numberField(opts: {
  label?: string; value: number; min: number; max: number; step?: number; unit?: string; width?: number;
  title?: string; onChange: (v: number, final: boolean) => void;
  /** Usual values to pick from (a list opens instead of the slider); typing any value still works. */
  presets?: number[];
  /**
   * Sizes (1…2500 px): the slider moves on a logarithmic scale, so the usual 10–200 px take a good part of
   * the track instead of its first few percent (as in Photoshop); typing any value still works.
   */
  log?: boolean;
}): HTMLElement & { set(v: number): void } {
  const step = opts.step ?? 1;
  let value = opts.value;
  const dec = step < 1 ? Math.max(0, -Math.floor(Math.log10(step))) : 0;
  const input = el('input', { class: 'num-input', type: 'text', value: value.toFixed(dec), style: { width: (opts.width ?? 44) + 'px' } }) as HTMLInputElement;
  const lg = !!opts.log && opts.min > 0;
  const span = Math.log(opts.max / opts.min);
  /** slider position (0…1000 on a log scale) ↔ value */
  const toPos = (v: number) => (lg ? Math.round(1000 * Math.log(clamp(v, opts.min, opts.max) / opts.min) / span) : v);
  const fromPos = (p: number) => (lg ? opts.min * Math.exp(span * p / 1000) : p);
  const range = el('input', lg
    ? { class: 'range', type: 'range', min: 0, max: 1000, step: 1, value: toPos(value) }
    : { class: 'range', type: 'range', min: opts.min, max: opts.max, step, value }) as HTMLInputElement;
  const list = opts.presets ? el('div', { class: 'num-presets' }) : null;
  const pop = el('div', { class: 'num-pop' + (list ? ' list' : '') }, list ?? range);
  const arrow = el('button', { class: 'num-arrow', tabIndex: -1 }, icon('chevronDown', 12));
  const label = opts.label ? el('span', { class: 'num-label', title: opts.title || '' }, opts.label) : null;
  const root = el('div', { class: 'num-field' }, label, el('div', { class: 'num-box' }, input, opts.unit ? el('span', { class: 'num-unit' }, opts.unit) : null, arrow), pop) as any;

  const apply = (v: number, final: boolean) => {
    v = clamp(Math.round(v / step) * step, opts.min, opts.max);
    value = v;
    input.value = v.toFixed(dec);
    range.value = String(toPos(v));
    opts.onChange(v, final);
  };
  root.set = (v: number) => { value = v; input.value = v.toFixed(dec); range.value = String(toPos(v)); };
  /**
   * The popup opens under the field, right-aligned; where that would leave the window or panel the field is
   * in (a field near the left edge of a dialog), it opens from the left edge of the box instead.
   */
  const placePopup = () => {
    pop.style.left = ''; pop.style.right = '';
    let left = 0;
    for (let n = root.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { left = n.getBoundingClientRect().left; break; }
    }
    if (pop.getBoundingClientRect().left < left + 4) {
      const box = root.querySelector('.num-box') as HTMLElement;
      pop.style.right = 'auto'; pop.style.left = box.offsetLeft + 'px';
    }
  };
  if (list) {
    const fill = () => {
      list.innerHTML = '';
      for (const pv of opts.presets!) {
        const b = el('button', { class: 'num-preset' + (Math.abs(pv - value) < 1e-9 ? ' on' : '') }, pv.toFixed(dec) + (opts.unit ? ' ' + opts.unit : ''));
        b.addEventListener('mousedown', e => e.preventDefault());   // keep the text selection of the text tool
        b.addEventListener('click', e => { e.stopPropagation(); root.classList.remove('open'); apply(pv, true); });
        list.append(b);
      }
    };
    (root as any)._fill = fill;
  }

  input.addEventListener('change', () => { const v = parseFloat(input.value.replace(',', '.')); if (!isNaN(v)) apply(v, true); else input.value = value.toFixed(dec); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { input.blur(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      apply(value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1), true);
    }
    e.stopPropagation();
  });
  range.addEventListener('input', () => apply(fromPos(parseFloat(range.value)), false));
  if (lg) range.addEventListener('keydown', e => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    e.preventDefault(); e.stopPropagation();
    // about 4 % per press (at least one step), so small and large sizes move alike
    apply(value + dir * Math.max(step, Math.round(value * 0.04 / step) * step), true);
  });
  range.addEventListener('change', () => apply(fromPos(parseFloat(range.value)), true));
  arrow.addEventListener('click', e => {
    e.stopPropagation();
    const open = !root.classList.contains('open');
    document.querySelectorAll('.num-field.open').forEach(n => n.classList.remove('open'));
    if (open) {
      (root as any)._fill?.();
      root.classList.add('open');
      placePopup();
      const close = (ev: Event) => { if (!root.contains(ev.target as Node)) { root.classList.remove('open'); document.removeEventListener('pointerdown', close, true); } };
      document.addEventListener('pointerdown', close, true);
    }
  });
  if (label) {
    label.addEventListener('pointerdown', e => {
      e.preventDefault();
      const sx = e.clientX, sv = value;
      const range = opts.max - opts.min;
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - sx;
        // on a log scale the drag moves along the same curve as the slider (2 positions per pixel)
        if (lg) { apply(fromPos(toPos(sv) + dx * 2 * (ev.shiftKey ? 5 : 1)), false); return; }
        const per = range > 200 ? 1 : range / 200;
        apply(sv + dx * Math.max(step, per) * (ev.shiftKey ? 10 : 1), false);
      };
      const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); opts.onChange(value, true); };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }
  return root;
}

export function checkbox(label: string, value: boolean, onChange: (v: boolean) => void, title?: string): HTMLElement {
  const input = el('input', { type: 'checkbox', checked: value }) as HTMLInputElement;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'check', title: title || '' }, input, el('span', { class: 'check-box' }, icon('check', 11)), el('span', {}, label));
}

export function select<T extends string>(options: { value: T; label: string }[], value: T, onChange: (v: T) => void, cls = ''): HTMLSelectElement {
  const s = el('select', { class: 'select ' + cls }) as HTMLSelectElement;
  for (const o of options) {
    if (o.value === ('-' as T)) { const opt = el('option', { disabled: true }, '──────────'); s.append(opt); continue; }
    s.append(el('option', { value: o.value }, o.label));
  }
  s.value = value;
  s.addEventListener('change', () => onChange(s.value as T));
  s.addEventListener('keydown', e => e.stopPropagation());
  return s;
}

export function segmented<T extends string>(items: { value: T; icon?: string; label?: string; title: string }[], value: T, onChange: (v: T) => void): HTMLElement & { set(v: T): void } {
  const root = el('div', { class: 'seg' }) as any;
  const btns: HTMLButtonElement[] = [];
  for (const it of items) {
    const b = el('button', { class: 'seg-btn' + (it.value === value ? ' on' : ''), title: it.title },
      it.icon ? icon(it.icon, 16) : null, it.label ? el('span', {}, it.label) : null) as HTMLButtonElement;
    b.dataset.v = it.value;
    b.addEventListener('click', () => { root.set(it.value); onChange(it.value); });
    btns.push(b);
    root.append(b);
  }
  root.set = (v: T) => btns.forEach(b => b.classList.toggle('on', b.dataset.v === v));
  return root;
}

export function iconButton(name: string, title: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  const b = el('button', { class: 'icon-btn ' + cls, title }, icon(name, 16)) as HTMLButtonElement;
  b.addEventListener('click', onClick);
  return b;
}

export const sep = () => el('div', { class: 'opt-sep' });

/** Small color swatch that opens the color picker. */
export function colorSwatch(color: RGB, title: string, onPick: (c: RGB) => void): HTMLElement {
  const b = el('button', { class: 'opt-swatch', title, style: { background: css(color) } });
  b.addEventListener('click', () => openColorPicker(color, title, c => { b.style.background = css(c); onPick(c); }));
  return b;
}
