import { app } from '../app';
import { RGB, css } from '../core/color';
import { createCanvas, ctx2d, el } from '../core/util';
import { compositeStroke } from '../tools/paint';
import { t } from '../i18n';
import { openDialog } from './dialog';
import { numberField, select, colorSwatch } from './controls';

type FillSource = 'fg' | 'bg' | 'color' | 'white' | 'black' | 'gray';

/** Composite a document-sized colored buffer onto the paint target. */
function applyDocBuffer(buf: HTMLCanvasElement, opacity: number, color: RGB) {
  const target = app.paintTarget();
  if (!target) return false;
  const d = app.doc!;
  const s = target.surface;
  s.ensureCovers({ x: 0, y: 0, w: d.width, h: d.height });
  compositeStroke(s.ctx, buf, target, 'paint', opacity, color, -s.x, -s.y);
  s.markDirtyDoc({ x: 0, y: 0, w: d.width, h: d.height });
  target.layer.touch();
  return true;
}

/** Edit → Fill… (Shift+F5) */
export function fillDialog() {
  if (!app.paintTarget()) return;
  const d = app.doc;
  if (!d) return;
  let src: FillSource = app.settings.fillSrc || 'fg';
  let custom: RGB = app.settings.fillColor || { r: 128, g: 128, b: 128 };
  let opacity = 100;
  const body = el('div', { class: 'form' },
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.contents')),
      select<FillSource>([
        { value: 'fg', label: t('dlg.fill.fg') }, { value: 'bg', label: t('dlg.fill.bg') }, { value: 'color', label: t('dlg.fill.color') },
        { value: 'white', label: t('dlg.bg.white') }, { value: 'black', label: t('dlg.bg.black') }, { value: 'gray', label: t('dlg.fill.gray') },
      ], src, v => (src = v)),
      colorSwatch(custom, t('dlg.fill.color'), c => { custom = c; src = 'color'; })),
    el('div', { class: 'form-row' }, el('label', {}, t('opt.opacity')), numberField({ value: opacity, min: 1, max: 100, unit: '%', onChange: v => (opacity = v) })));
  openDialog({
    title: t('dlg.fill.title'), body, width: 400,
    onOk: () => {
      app.settings.fillSrc = src; app.settings.fillColor = custom; app.saveSettings();
      const color: RGB = src === 'fg' ? app.fg : src === 'bg' ? app.bg : src === 'color' ? custom
        : src === 'white' ? { r: 255, g: 255, b: 255 } : src === 'black' ? { r: 0, g: 0, b: 0 } : { r: 128, g: 128, b: 128 };
      const buf = createCanvas(d.width, d.height);
      const g = ctx2d(buf);
      g.fillStyle = css(color);
      g.fillRect(0, 0, d.width, d.height);
      if (d.selection) { g.globalCompositeOperation = 'destination-in'; g.drawImage(d.selection.mask, 0, 0); }
      if (applyDocBuffer(buf, opacity / 100, color)) app.commit('cmd.fillDialog');
    },
  });
}

/** Edit → Stroke… : outline the selection. */
export function strokeDialog() {
  if (!app.paintTarget()) return;
  const d = app.doc;
  if (!d?.selection) return;
  let width = app.settings.strokeW ?? 3;
  let color: RGB = app.settings.strokeColor || { ...app.fg };
  let pos: 'inside' | 'center' | 'outside' = app.settings.strokePos || 'center';
  let opacity = 100;
  const body = el('div', { class: 'form' },
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.strokeWidth')), numberField({ value: width, min: 1, max: 250, unit: t('dlg.px'), onChange: v => (width = v) })),
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.color')), colorSwatch(color, t('dlg.color'), c => (color = c))),
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.position')),
      select([{ value: 'inside', label: t('dlg.pos.inside') }, { value: 'center', label: t('dlg.pos.center') }, { value: 'outside', label: t('dlg.pos.outside') }], pos, v => (pos = v as any))),
    el('div', { class: 'form-row' }, el('label', {}, t('opt.opacity')), numberField({ value: opacity, min: 1, max: 100, unit: '%', onChange: v => (opacity = v) })));
  openDialog({
    title: t('dlg.stroke.title'), body, width: 400,
    onOk: () => {
      app.settings.strokeW = width; app.settings.strokeColor = color; app.settings.strokePos = pos; app.saveSettings();
      const sel = d.selection!;
      const outer = pos === 'inside' ? sel : pos === 'center' ? sel.grow(width / 2) : sel.grow(width);
      const inner = pos === 'outside' ? sel : pos === 'center' ? sel.grow(-width / 2) : sel.grow(-width);
      if (!outer) return;
      const buf = createCanvas(d.width, d.height);
      const g = ctx2d(buf);
      g.drawImage(outer.mask, 0, 0);
      if (inner) { g.globalCompositeOperation = 'destination-out'; g.drawImage(inner.mask, 0, 0); }
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = css(color);
      g.fillRect(0, 0, d.width, d.height);
      if (applyDocBuffer(buf, opacity / 100, color)) app.commit('cmd.strokeSel');
    },
  });
}
