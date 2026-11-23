/** Image → HSL Mixer and Image → Toning (both part of the adjustment chain, on the GPU). */
import { el } from '../core/util';
import { t } from '../i18n';
import { adjustDialog, sliderRow } from './adjustdialogs';
import {
  HSL_CENTERS, HSL_KEYS, HslParams, hslDefaults, hslMix, ToneParams, TONE_DEFAULTS, splitTone,
} from '../core/colorgrade';

const hslCss = (h: number, s = 80, l = 50) => `hsl(${((h % 360) + 360) % 360}, ${s}%, ${l}%)`;
const track = (row: HTMLElement, gradient: string) => {
  const r = row.querySelector('input.range') as HTMLInputElement;
  r.classList.add('grad');
  r.style.background = gradient;
};

/* ---------------- HSL mixer ---------------- */
export function hslMixerDialog() {
  const p: HslParams = hslDefaults();
  const copy = (): HslParams => ({ hue: [...p.hue], sat: [...p.sat], lum: [...p.lum] });
  let sel = 0;
  let refresh = () => {};
  const name = el('div', { class: 'hsl-name' });
  const dots = HSL_KEYS.map((k, i) => {
    const b = el('button', { class: 'hsl-dot', title: t('hsl.' + k), style: { background: hslCss(HSL_CENTERS[i], 85, 52) } });
    b.addEventListener('click', () => { sel = i; show(); });
    return b;
  });
  const changed = () => { dots.forEach((d, i) => d.classList.toggle('changed', !!(p.hue[i] || p.sat[i] || p.lum[i]))); refresh(); };
  const rowH = sliderRow({ key: 'h', label: t('hsl.hue'), min: -100, max: 100, def: 0 }, 0, v => { p.hue[sel] = v; changed(); });
  const rowS = sliderRow({ key: 's', label: t('hsl.sat'), min: -100, max: 100, def: 0 }, 0, v => { p.sat[sel] = v; changed(); });
  const rowL = sliderRow({ key: 'l', label: t('hsl.lum'), min: -100, max: 100, def: 0 }, 0, v => { p.lum[sel] = v; changed(); });
  // the sliders of the chosen colour, their tracks painted in it
  const show = () => {
    const c = HSL_CENTERS[sel];
    dots.forEach((d, i) => d.classList.toggle('on', i === sel));
    name.textContent = t('hsl.' + HSL_KEYS[sel]);
    rowH.set(p.hue[sel]); rowS.set(p.sat[sel]); rowL.set(p.lum[sel]);
    track(rowH, `linear-gradient(90deg, ${hslCss(c - 30)}, ${hslCss(c)}, ${hslCss(c + 30)})`);
    track(rowS, `linear-gradient(90deg, ${hslCss(c, 0)}, ${hslCss(c, 100)})`);
    track(rowL, `linear-gradient(90deg, ${hslCss(c, 80, 15)}, ${hslCss(c, 80, 50)}, ${hslCss(c, 80, 85)})`);
  };
  const reset = el('button', { class: 'btn sm' }, t('adj.reset'));
  reset.addEventListener('click', () => { Object.assign(p, hslDefaults()); show(); changed(); });
  const body = el('div', { class: 'adj' }, el('div', { class: 'hsl-dots' }, ...dots), name, rowH, rowS, rowL);
  show();
  const res = adjustDialog({
    title: t('cmd.hslMixer'), body, width: 320, label: 'cmd.hslMixer',
    compute: () => { const q = copy(); return (src, dst) => hslMix(q, src, dst); },
    gpu: () => ({ kind: 'hsl', p: copy() }),
    extra: [el('div', { style: { flex: '1' } }), reset],
  });
  if (res) refresh = res.refresh;
}

/* ---------------- Toning ---------------- */
export function toningDialog() {
  const p: ToneParams = { ...TONE_DEFAULTS };
  let refresh = () => {};
  const part = (title: string, hueKey: 'shHue' | 'hiHue', satKey: 'shSat' | 'hiSat') => {
    const swatch = el('span', { class: 'tone-swatch' });
    const sat = sliderRow({ key: satKey, label: t('tone.sat'), min: 0, max: 100, def: 0 }, p[satKey], v => { p[satKey] = v; paint(); refresh(); });
    const hue = sliderRow({ key: hueKey, label: t('tone.hue'), min: 0, max: 360, def: p[hueKey], unit: '°' }, p[hueKey], v => { p[hueKey] = v; paint(); refresh(); });
    track(hue, 'linear-gradient(90deg, hsl(0,85%,52%), hsl(60,85%,52%), hsl(120,85%,52%), hsl(180,85%,52%), hsl(240,85%,52%), hsl(300,85%,52%), hsl(360,85%,52%))');
    const paint = () => {
      track(sat, `linear-gradient(90deg, hsl(0,0%,50%), ${hslCss(p[hueKey], 85, 52)})`);
      swatch.style.background = hslCss(p[hueKey], Math.max(8, p[satKey]), 52);
    };
    paint();
    return [el('div', { class: 'adj-section' }, title, swatch), hue, sat];
  };
  const balance = sliderRow({ key: 'balance', label: t('tone.balance'), min: -100, max: 100, def: 0 }, 0, v => { p.balance = v; refresh(); });
  const body = el('div', { class: 'adj' },
    ...part(t('tone.highlights'), 'hiHue', 'hiSat'),
    ...part(t('tone.shadows'), 'shHue', 'shSat'),
    el('div', { class: 'adj-section' }, t('tone.balanceTitle')), balance);
  const res = adjustDialog({
    title: t('cmd.toning'), body, width: 320, label: 'cmd.toning',
    compute: () => { const q = { ...p }; return (src, dst) => splitTone(q, src, dst); },
    gpu: () => ({ kind: 'tone', p: { ...p } }),
  });
  if (res) refresh = res.refresh;
}
