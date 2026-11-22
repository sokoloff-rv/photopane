import { RGB, rgbToHsv, hsvToRgb, rgbToHex, hexToRgb, css } from '../core/color';
import { el, clamp } from '../core/util';
import { t } from '../i18n';
import { openDialog } from './dialog';
import { app } from '../app';

const RECENT_KEY = 'pp.recentColors';

export function openColorPicker(initial: RGB, title: string, onPick: (c: RGB) => void) {
  let { h, s, v } = rgbToHsv(initial);
  const sv = el('canvas', { class: 'cp-sv', width: 256, height: 256 }) as HTMLCanvasElement;
  const hue = el('canvas', { class: 'cp-hue', width: 20, height: 256 }) as HTMLCanvasElement;
  const svKnob = el('div', { class: 'cp-knob' });
  const hueKnob = el('div', { class: 'cp-hknob' });
  const newSw = el('div', { class: 'cp-sw' });
  const oldSw = el('div', { class: 'cp-sw', style: { background: css(initial) } });
  oldSw.addEventListener('click', () => setRgb(initial));
  const inputs: Record<string, HTMLInputElement> = {};
  const field = (k: string, label: string, max: number, unit = '') => {
    const i = el('input', { class: 'text-input sm', type: 'number', min: 0, max }) as HTMLInputElement;
    inputs[k] = i;
    i.addEventListener('input', () => fromInputs(k));
    return el('label', { class: 'cp-field' }, el('span', {}, label), i, el('span', { class: 'muted' }, unit));
  };
  const hex = el('input', { class: 'text-input', maxLength: 7, style: { width: '84px' } }) as HTMLInputElement;
  hex.addEventListener('change', () => { const c = hexToRgb(hex.value); if (c) setRgb(c); });

  let recent: string[] = [];
  try { recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch {}
  const recentRow = el('div', { class: 'cp-recent' }, ...recent.map(hx => {
    const b = el('button', { class: 'cp-rsw', style: { background: hx }, title: hx });
    b.addEventListener('click', () => { const c = hexToRgb(hx); if (c) setRgb(c); });
    return b;
  }));

  const body = el('div', { class: 'cp' },
    el('div', { class: 'cp-sv-wrap' }, sv, svKnob),
    el('div', { class: 'cp-hue-wrap' }, hue, hueKnob),
    el('div', { class: 'cp-side' },
      el('div', { class: 'cp-compare' }, el('div', {}, el('small', {}, t('dlg.color.new')), newSw), el('div', {}, el('small', {}, t('dlg.color.current')), oldSw)),
      el('div', { class: 'cp-fields' },
        field('h', 'H', 360, '°'), field('s', 'S', 100, '%'), field('v', 'B', 100, '%'),
        field('r', 'R', 255), field('g', 'G', 255), field('b', 'B', 255)),
      el('label', { class: 'cp-field' }, el('span', {}, '#'), hex)),
    recent.length ? recentRow : null);

  const drawHue = () => {
    const g = hue.getContext('2d')!;
    const gr = g.createLinearGradient(0, 0, 0, 256);
    for (let i = 0; i <= 6; i++) gr.addColorStop(i / 6, `hsl(${360 - i * 60},100%,50%)`);
    g.fillStyle = gr; g.fillRect(0, 0, 20, 256);
  };
  const drawSV = () => {
    const g = sv.getContext('2d')!;
    g.fillStyle = `hsl(${h},100%,50%)`; g.fillRect(0, 0, 256, 256);
    const w = g.createLinearGradient(0, 0, 256, 0); w.addColorStop(0, '#fff'); w.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = w; g.fillRect(0, 0, 256, 256);
    const b = g.createLinearGradient(0, 0, 0, 256); b.addColorStop(0, 'rgba(0,0,0,0)'); b.addColorStop(1, '#000');
    g.fillStyle = b; g.fillRect(0, 0, 256, 256);
  };
  const cur = () => hsvToRgb(h, s, v);
  const sync = (skip?: string) => {
    const c = cur();
    drawSV();
    svKnob.style.left = s * 100 + '%'; svKnob.style.top = (1 - v) * 100 + '%';
    hueKnob.style.top = (1 - h / 360) * 100 + '%';
    newSw.style.background = css(c);
    const vals: Record<string, number> = { h: Math.round(h), s: Math.round(s * 100), v: Math.round(v * 100), r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) };
    for (const k in inputs) if (k !== skip) inputs[k].value = String(vals[k]);
    if (skip !== 'hex') hex.value = rgbToHex(c);
  };
  const setRgb = (c: RGB) => { ({ h, s, v } = rgbToHsv(c)); sync(); };
  const fromInputs = (k: string) => {
    const n = (x: string) => clamp(parseFloat(inputs[x].value) || 0, 0, 360);
    if ('hsv'.includes(k)) { h = clamp(n('h'), 0, 360); s = clamp(n('s'), 0, 100) / 100; v = clamp(n('v'), 0, 100) / 100; }
    else ({ h, s, v } = rgbToHsv({ r: clamp(n('r'), 0, 255), g: clamp(n('g'), 0, 255), b: clamp(n('b'), 0, 255) }));
    sync(k);
  };
  const drag = (target: HTMLElement, fn: (x: number, y: number) => void) => {
    target.addEventListener('pointerdown', e => {
      target.setPointerCapture(e.pointerId);
      const r = target.getBoundingClientRect();
      const go = (ev: PointerEvent) => fn(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1));
      go(e);
      const mv = (ev: PointerEvent) => go(ev);
      const up = () => { target.removeEventListener('pointermove', mv); target.removeEventListener('pointerup', up); };
      target.addEventListener('pointermove', mv);
      target.addEventListener('pointerup', up);
    });
  };
  drag(sv.parentElement!, (x, y) => { s = x; v = 1 - y; sync(); });
  drag(hue.parentElement!, (_x, y) => { h = (1 - y) * 360; sync(); });
  drawHue();
  sync();

  // while the picker is open, clicking the image samples a color (like Photoshop)
  app.colorPick = c => setRgb(c);
  app.viewport.updateCursor();
  const stopPick = () => { app.colorPick = null; app.viewport.updateCursor(); };
  openDialog({
    title, body, width: 520, passthrough: true,
    onCancel: stopPick,
    onOk: () => {
      stopPick();
      const c = cur();
      const hx = rgbToHex(c);
      recent = [hx, ...recent.filter(x => x !== hx)].slice(0, 14);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch {}
      onPick(c);
    },
  });
}
