import { el, clamp } from '../core/util';
import { icon } from './icons';
import { RGB, css } from '../core/color';
import { openColorPicker } from './colorpicker';

/** Compact numeric field with a scrubbable label and a popup slider (Photoshop-style). */
export function numberField(opts: {
  label?: string; value: number; min: number; max: number; step?: number; unit?: string; width?: number;
  title?: string; onChange: (v: number, final: boolean) => void;
}): HTMLElement & { set(v: number): void } {
  const step = opts.step ?? 1;
  let value = opts.value;
  const dec = step < 1 ? Math.max(0, -Math.floor(Math.log10(step))) : 0;
  const input = el('input', { class: 'num-input', type: 'text', value: value.toFixed(dec), style: { width: (opts.width ?? 44) + 'px' } }) as HTMLInputElement;
  const range = el('input', { class: 'range', type: 'range', min: opts.min, max: opts.max, step, value }) as HTMLInputElement;
  const pop = el('div', { class: 'num-pop' }, range);
  const arrow = el('button', { class: 'num-arrow', tabIndex: -1 }, icon('chevronDown', 12));
  const label = opts.label ? el('span', { class: 'num-label', title: opts.title || '' }, opts.label) : null;
  const root = el('div', { class: 'num-field' }, label, el('div', { class: 'num-box' }, input, opts.unit ? el('span', { class: 'num-unit' }, opts.unit) : null, arrow), pop) as any;

  const apply = (v: number, final: boolean) => {
    v = clamp(Math.round(v / step) * step, opts.min, opts.max);
    value = v;
    input.value = v.toFixed(dec);
    range.value = String(v);
    opts.onChange(v, final);
  };
  root.set = (v: number) => { value = v; input.value = v.toFixed(dec); range.value = String(v); };

  input.addEventListener('change', () => { const v = parseFloat(input.value.replace(',', '.')); if (!isNaN(v)) apply(v, true); else input.value = value.toFixed(dec); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { input.blur(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      apply(value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1), true);
    }
    e.stopPropagation();
  });
  range.addEventListener('input', () => apply(parseFloat(range.value), false));
  range.addEventListener('change', () => apply(parseFloat(range.value), true));
  arrow.addEventListener('click', e => {
    e.stopPropagation();
    const open = !root.classList.contains('open');
    document.querySelectorAll('.num-field.open').forEach(n => n.classList.remove('open'));
    if (open) {
      root.classList.add('open');
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
