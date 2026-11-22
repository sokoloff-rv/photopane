import { app } from '../app';
import { el } from '../core/util';
import { t } from '../i18n';
import { checkbox, segmented } from './controls';
import { adjustDialog, sliderRow, SliderSpec } from './adjustdialogs';
import { toast } from './dialog';
import { openColorPicker } from './colorpicker';
import {
  motionBlur, radialBlur, surfaceBlur, highPass, dehaze, denoise, glow, chromatic, pixelate, halftone,
  gradientMap, parseCube, applyLut, Lut3D, RGBc,
} from '../core/fx';

/** Remembered filter settings (per filter, in app settings). */
function mem<T extends object>(key: string, def: T): T {
  const all = (app.settings.filters ||= {});
  return (all[key] = { ...def, ...(all[key] || {}) });
}

/** A filter dialog made of sliders over a parameter object. */
function sliderFilter<P extends Record<string, any>>(o: {
  cmd: string; key: string; def: P; sliders: (SliderSpec & { key: keyof P & string })[];
  extra?: (p: P, refresh: () => void) => HTMLElement[];
  alpha?: boolean;
  compute: (p: P, src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, ox: number, oy: number) => void;
}) {
  const p = mem(o.key, o.def);
  let refresh = () => {};
  const body = el('div', { class: 'adj' },
    ...o.sliders.map(s => sliderRow(s, p[s.key], v => { (p as any)[s.key] = v; refresh(); })),
    ...(o.extra ? o.extra(p, () => refresh()) : []));
  const res = adjustDialog({
    title: t('cmd.' + o.cmd), body, label: 'cmd.' + o.cmd, alpha: o.alpha,
    compute: s => (src, dst) => o.compute(p, src, dst, s.w, s.h, s.ox, s.oy),
  });
  if (res) { refresh = () => { app.saveSettings(); res.refresh(); }; res.refresh(); }
}

const S = (key: string, label: string, min: number, max: number, def: number, unit = '', step = 1): SliderSpec => ({ key, label: t(label), min, max, def, unit, step });

/* ---------------- blur ---------------- */
export function motionBlurDialog() {
  sliderFilter({
    cmd: 'motionBlur', key: 'motion', def: { angle: 0, dist: 30 }, alpha: true,
    sliders: [S('angle', 'opt.angle', -180, 180, 0, '°') as any, S('dist', 'flt.distance', 1, 500, 30, ' px') as any],
    compute: (p, src, dst, w, h) => motionBlur(src, dst, w, h, p.angle, p.dist),
  });
}

export function radialBlurDialog() {
  sliderFilter({
    cmd: 'radialBlur', key: 'radial', def: { amount: 30, cx: 50, cy: 50, mode: 'zoom' as 'zoom' | 'spin' }, alpha: true,
    sliders: [S('amount', 'adj.amount', 1, 100, 30) as any, S('cx', 'flt.centerX', 0, 100, 50, '%') as any, S('cy', 'flt.centerY', 0, 100, 50, '%') as any],
    extra: (p, refresh) => [segmented<'zoom' | 'spin'>([
      { value: 'zoom', label: t('flt.zoom'), title: t('flt.zoom') }, { value: 'spin', label: t('flt.spin'), title: t('flt.spin') },
    ], p.mode, v => { p.mode = v; refresh(); })],
    compute: (p, src, dst, w, h, ox, oy) => {
      const d = app.doc!;
      radialBlur(src, dst, w, h, d.width * p.cx / 100 - ox, d.height * p.cy / 100 - oy, p.amount, p.mode);
    },
  });
}

export function surfaceBlurDialog() {
  sliderFilter({
    cmd: 'surfaceBlur', key: 'surface', def: { radius: 6, threshold: 18 },
    sliders: [S('radius', 'dlg.radius', 1, 60, 6, ' px') as any, S('threshold', 'adj.threshold', 1, 100, 18) as any],
    compute: (p, src, dst, w, h) => surfaceBlur(src, dst, w, h, p.radius, p.threshold),
  });
}

/* ---------------- detail ---------------- */
export function highPassDialog() {
  sliderFilter({
    cmd: 'highPass', key: 'highpass', def: { radius: 3 },
    sliders: [S('radius', 'dlg.radius', 0.5, 100, 3, ' px', 0.1) as any],
    extra: () => [el('div', { class: 'muted sm' }, t('flt.highPassHint'))],
    compute: (p, src, dst, w, h) => highPass(src, dst, w, h, p.radius),
  });
}

export function dehazeDialog() {
  sliderFilter({
    cmd: 'dehaze', key: 'dehaze', def: { amount: 40 },
    sliders: [S('amount', 'adj.amount', -100, 100, 40) as any],
    compute: (p, src, dst, w, h) => dehaze(src, dst, w, h, p.amount),
  });
}

export function denoiseDialog() {
  sliderFilter({
    cmd: 'denoise', key: 'denoise', def: { luma: 30, chroma: 50 },
    sliders: [S('luma', 'flt.luma', 0, 100, 30) as any, S('chroma', 'flt.chroma', 0, 100, 50) as any],
    compute: (p, src, dst, w, h) => denoise(src, dst, w, h, p.luma, p.chroma),
  });
}

/* ---------------- light & optics ---------------- */
export function glowDialog() {
  sliderFilter({
    cmd: 'glow', key: 'glow', def: { threshold: 170, radius: 25, strength: 80, warm: false },
    sliders: [S('threshold', 'adj.threshold', 0, 250, 170) as any, S('radius', 'dlg.radius', 1, 200, 25, ' px') as any, S('strength', 'adj.amount', 0, 200, 80, '%') as any],
    extra: (p, refresh) => [checkbox(t('flt.halation'), p.warm, v => { p.warm = v; refresh(); })],
    compute: (p, src, dst, w, h) => glow(src, dst, w, h, p.threshold, p.radius, p.strength, p.warm),
  });
}

export function chromaticDialog() {
  sliderFilter({
    cmd: 'chromatic', key: 'chromatic', def: { amount: 30 },
    sliders: [S('amount', 'adj.amount', -100, 100, 30) as any],
    extra: () => [el('div', { class: 'muted sm' }, t('flt.chromaticHint'))],
    compute: (p, src, dst, w, h, ox, oy) => { const d = app.doc!; chromatic(src, dst, w, h, p.amount, d.width / 2 - ox, d.height / 2 - oy); },
  });
}

/* ---------------- stylize ---------------- */
export function pixelateDialog() {
  sliderFilter({
    cmd: 'pixelate', key: 'pixelate', def: { cell: 16 },
    sliders: [S('cell', 'flt.cell', 2, 200, 16, ' px') as any],
    compute: (p, src, dst, w, h) => pixelate(src, dst, w, h, p.cell),
  });
}

export function halftoneDialog() {
  sliderFilter({
    cmd: 'halftone', key: 'halftone', def: { cell: 10, angle: 45, color: false },
    sliders: [S('cell', 'flt.dot', 3, 80, 10, ' px') as any, S('angle', 'opt.angle', 0, 90, 45, '°') as any],
    extra: (p, refresh) => [checkbox(t('flt.colorDots'), p.color, v => { p.color = v; refresh(); })],
    compute: (p, src, dst, w, h) => halftone(src, dst, w, h, p.cell, p.angle, p.color),
  });
}

const GM_PRESETS: { name: string; stops: { p: number; c: RGBc }[] }[] = [
  { name: 'bw', stops: [{ p: 0, c: [0, 0, 0] }, { p: 1, c: [255, 255, 255] }] },
  { name: 'sepia', stops: [{ p: 0, c: [38, 22, 12] }, { p: 0.55, c: [160, 112, 70] }, { p: 1, c: [246, 232, 206] }] },
  { name: 'duoBlueOrange', stops: [{ p: 0, c: [22, 34, 92] }, { p: 1, c: [255, 160, 70] }] },
  { name: 'duoPurpleTeal', stops: [{ p: 0, c: [52, 14, 86] }, { p: 1, c: [86, 240, 200] }] },
  { name: 'sunset', stops: [{ p: 0, c: [40, 10, 60] }, { p: 0.5, c: [226, 68, 92] }, { p: 1, c: [255, 214, 130] }] },
  { name: 'cold', stops: [{ p: 0, c: [8, 20, 40] }, { p: 0.6, c: [70, 130, 170] }, { p: 1, c: [220, 240, 255] }] },
];
const css = (c: RGBc) => `rgb(${c[0]},${c[1]},${c[2]})`;
const grad = (stops: { p: number; c: RGBc }[]) => `linear-gradient(90deg, ${stops.map(s => `${css(s.c)} ${s.p * 100}%`).join(', ')})`;

export function gradientMapDialog() {
  const p = mem('gradmap', { preset: 0, strength: 100, dark: [20, 30, 80] as RGBc, light: [255, 200, 120] as RGBc, custom: false });
  let refresh = () => {};
  const stops = () => p.custom ? [{ p: 0, c: p.dark }, { p: 1, c: p.light }] : GM_PRESETS[p.preset].stops;
  const presets = el('div', { class: 'gm-presets' });
  const btns: HTMLElement[] = [];
  const mark = () => btns.forEach((b, i) => b.classList.toggle('on', !p.custom && i === p.preset));
  GM_PRESETS.forEach((g, i) => {
    const b = el('button', { class: 'gm-preset', title: t('flt.gm.' + g.name), style: { background: grad(g.stops) } });
    b.addEventListener('click', () => { p.preset = i; p.custom = false; mark(); customRow.classList.remove('on'); refresh(); });
    btns.push(b); presets.append(b);
  });
  const sw = (key: 'dark' | 'light') => {
    const b = el('button', { class: 'opt-swatch', style: { background: css(p[key]) } });
    b.addEventListener('click', () => openColorPicker({ r: p[key][0], g: p[key][1], b: p[key][2] }, t('flt.gm.custom'), c => {
      p[key] = [c.r, c.g, c.b]; p.custom = true; b.style.background = css(p[key]); mark(); refresh();
    }));
    return b;
  };
  const customRow = el('div', { class: 'gm-custom' }, el('span', {}, t('flt.gm.custom')), sw('dark'), el('span', {}, '→'), sw('light'));
  const body = el('div', { class: 'adj' }, presets, customRow,
    sliderRow(S('strength', 'adj.amount', 0, 100, 100, '%'), p.strength, v => { p.strength = v; refresh(); }));
  mark();
  const res = adjustDialog({ title: t('cmd.gradientMap'), body, label: 'cmd.gradientMap', compute: () => (src, dst) => gradientMap(src, dst, stops(), p.strength) });
  if (res) { refresh = () => { app.saveSettings(); res.refresh(); }; res.refresh(); }
}

/** Colour LUT from a .cube file (thousands of free film and grading presets). */
let lastLut: Lut3D | null = null;
export function lutDialog() {
  let strength = 100;
  let refresh = () => {};
  const name = el('div', { class: 'lut-name' }, lastLut ? (lastLut.title || t('flt.lutLoaded')) : t('flt.lutNone'));
  const input = el('input', { type: 'file', accept: '.cube', style: { display: 'none' } }) as HTMLInputElement;
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    try { lastLut = parseCube(await f.text()); name.textContent = lastLut.title || f.name.replace(/\.cube$/i, ''); refresh(); }
    catch { toast(t('flt.lutBad'), 'error'); }
  });
  const pick = el('button', { class: 'btn sm' }, t('flt.lutOpen'));
  pick.addEventListener('click', () => input.click());
  const body = el('div', { class: 'adj' }, el('div', { class: 'gm-custom' }, pick, name), input,
    sliderRow(S('strength', 'adj.amount', 0, 100, 100, '%'), strength, v => { strength = v; refresh(); }));
  const res = adjustDialog({
    title: t('cmd.lut'), body, label: 'cmd.lut',
    compute: () => (src, dst) => { if (lastLut) applyLut(src, dst, lastLut, strength); else dst.set(src); },
  });
  if (res) { refresh = res.refresh; res.refresh(); if (!lastLut) input.click(); }
}
