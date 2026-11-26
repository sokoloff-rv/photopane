/**
 * Image → Apply Image («Внешний канал»): the window. Source (document, layer or the merged picture, channel,
 * invert), blending (mode, opacity; scale and offset for Add and Subtract), preserve transparency; the result is
 * shown live on the active layer and written into it on OK. The selection limits it.
 */
import { app } from '../app';
import { t } from '../i18n';
import { el, createCanvas, ctx2d, cloneCanvas } from '../core/util';
import { openDialog, toast } from './dialog';
import { select, checkbox } from './controls';
import { sliderRow } from './adjustdialogs';
import { previews } from '../core/render';
import type { Doc } from '../core/document';
import { ApplyImageGpu, ApplyParams, ApplyChannel, ApplyMode, APPLY_MODES, applyImageCpu } from '../core/applyimage';

const DEFAULTS: ApplyParams = { channel: 'rgb', invert: false, mode: 'multiply', opacity: 1, scale: 1, offset: 0, preserveTransparency: true };

export function applyImageDialog() {
  const d = app.doc;
  const l = d?.active;
  if (!d || !l) return;
  if (l.isGroup || l.kind === 'text') { toast(t('ai.needRaster'), 'error'); return; }
  const W = d.width, H = d.height;
  const p: ApplyParams = { ...DEFAULTS, ...(app.settings.applyImage || {}) };
  if (!APPLY_MODES.includes(p.mode as any)) p.mode = DEFAULTS.mode;

  // the active layer and this document's merged picture as they are now (before the preview changes them)
  const target = createCanvas(W, H);
  ctx2d(target).drawImage(l.canvas, l.x, l.y);
  const mergedHere = cloneCanvas(d.composite());
  const docs = app.docs.filter(x => x === d || (x.width === W && x.height === H));
  let srcDoc: Doc = d;
  let srcLayer: 'merged' | number = 'merged';
  const sourceCanvas = (): HTMLCanvasElement => {
    if (srcLayer === 'merged') return srcDoc === d ? mergedHere : srcDoc.composite();
    const sl = srcDoc.find(srcLayer);
    const c = createCanvas(W, H);
    if (sl && !sl.isGroup) ctx2d(c).drawImage(sl === l ? target : sl.canvas, sl === l ? 0 : sl.x, sl === l ? 0 : sl.y);
    return c;
  };

  const gpu = ApplyImageGpu.create(W, H);
  gpu?.setTarget(target);
  gpu?.setSelection(d.selection?.mask ?? null);
  // without WebGL2: the same maths on the CPU, at full size, a moment after the settings stop changing
  let cpu: { t: Uint8ClampedArray; s: Uint8ClampedArray; sel: Uint8Array | null; out: HTMLCanvasElement } | null = null;
  const readPx = (c: HTMLCanvasElement) => { const tc = createCanvas(W, H); const g = tc.getContext('2d', { willReadFrequently: true })!; g.drawImage(c, 0, 0); return g.getImageData(0, 0, W, H).data; };
  if (!gpu) cpu = { t: readPx(target), s: new Uint8ClampedArray(0), sel: d.selection ? d.selection.alpha() : null, out: createCanvas(W, H) };
  const setSource = () => {
    const c = sourceCanvas();
    if (gpu) gpu.setSource(c); else cpu!.s = readPx(c);
  };
  let timer = 0;
  const render = () => {
    if (gpu) { gpu.render(p); app.update('canvas'); return; }
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const res = applyImageCpu(cpu!.t, cpu!.s, cpu!.sel, p);
      ctx2d(cpu!.out).putImageData(new ImageData(res as any, W, H), 0, 0);
      app.update('canvas');
    }, 120);
  };
  const result = (): HTMLCanvasElement => {
    if (gpu) return gpu.render(p);
    const res = applyImageCpu(cpu!.t, cpu!.s, cpu!.sel, p);
    ctx2d(cpu!.out).putImageData(new ImageData(res as any, W, H), 0, 0);
    return cpu!.out;
  };
  setSource();
  previews.set(l.id, g => g.drawImage(gpu ? gpu.canvas : cpu!.out, 0, 0));
  render();

  /* ----- the window ----- */
  const layerOptions = () => [{ value: 'merged', label: t('apply.merged') },
    ...srcDoc.layers.filter(x => !x.isGroup).reverse().map(x => ({ value: String(x.id), label: x.name }))];
  const layerBox = el('div', { class: 'apply-layer' });
  const fillLayers = () => {
    layerBox.innerHTML = '';
    if (srcLayer !== 'merged' && !srcDoc.find(srcLayer)) srcLayer = 'merged';
    layerBox.append(select(layerOptions(), String(srcLayer), v => { srcLayer = v === 'merged' ? 'merged' : +v; setSource(); render(); }));
  };
  fillLayers();
  const row = (label: string, ...items: HTMLElement[]) => el('div', { class: 'form-row' }, el('label', {}, label), ...items);
  const docRow = docs.length > 1
    ? row(t('apply.document'), select(docs.map((x, i) => ({ value: String(i), label: x.name })), String(docs.indexOf(d)), v => { srcDoc = docs[+v]; srcLayer = 'merged'; fillLayers(); setSource(); render(); }))
    : null;
  const modeSel = select(APPLY_MODES.map(m => ({ value: m as ApplyMode, label: m === '-' ? '-' : t(MODE_LABEL[m] ?? 'blend.' + m) })), p.mode, v => { p.mode = v; arith(); render(); });
  const chanSel = select<ApplyChannel>([
    { value: 'rgb', label: 'RGB' }, { value: 'r', label: t('apply.red') }, { value: 'g', label: t('apply.green') },
    { value: 'b', label: t('apply.blue') }, { value: 'a', label: t('apply.alpha') },
  ], p.channel, v => { p.channel = v; render(); });
  const opacity = sliderRow({ key: 'opacity', label: t('opt.opacity'), min: 0, max: 100, def: 100, unit: '%' }, Math.round(p.opacity * 100), v => { p.opacity = v / 100; render(); });
  const scale = sliderRow({ key: 'scale', label: t('apply.scale'), min: 1, max: 2, def: 1, step: 0.01 }, p.scale, v => { p.scale = v; render(); });
  const offset = sliderRow({ key: 'offset', label: t('apply.offset'), min: -255, max: 255, def: 0 }, p.offset, v => { p.offset = v; render(); });
  // scale and offset only mean something for Add and Subtract
  const arith = () => { const on = p.mode === 'add' || p.mode === 'subtract'; scale.style.display = offset.style.display = on ? '' : 'none'; };
  arith();
  const body = el('div', { class: 'form apply-image' },
    el('div', { class: 'adj-section' }, t('apply.source')),
    docRow,
    row(t('apply.layer'), layerBox),
    row(t('apply.channel'), chanSel),
    el('div', { class: 'form-row' }, el('label', {}, ''), checkbox(t('apply.invert'), p.invert, v => { p.invert = v; render(); })),
    el('div', { class: 'adj-section' }, t('apply.blending')),
    row(t('apply.mode'), modeSel),
    el('div', { class: 'adj' }, opacity, scale, offset),
    el('div', { class: 'form-row' }, el('label', {}, ''), checkbox(t('apply.preserve'), p.preserveTransparency, v => { p.preserveTransparency = v; render(); })),
    el('div', { class: 'muted sm' }, t('apply.hint')));

  const close = () => {
    clearTimeout(timer);
    previews.delete(l.id);
    gpu?.dispose();
    app.update('canvas');
  };
  openDialog({
    title: t('cmd.applyImage'), body, width: 360, side: true, sideKey: 'applyImage', posKey: 'applyImage', autoFocus: false,
    onOk: () => {
      const out = result();
      // into the layer, over the document area only (the layer may reach beyond it)
      const s = l.content;
      s.ensureCovers({ x: 0, y: 0, w: W, h: H });
      const g = s.ctx;
      g.save();
      g.beginPath(); g.rect(-s.x, -s.y, W, H); g.clip();
      g.globalCompositeOperation = 'copy';
      g.drawImage(out, -s.x, -s.y);
      g.restore();
      s.markDirtyDoc({ x: 0, y: 0, w: W, h: H });
      l.touch();
      close();
      app.settings.applyImage = { ...p };
      app.saveSettings();
      app.commit('cmd.applyImage');
    },
    onCancel: close,
  });
}

/** Modes whose names are not among the layer blend modes. */
const MODE_LABEL: Partial<Record<string, string>> = {
  'linear-burn': 'apply.linearBurn', 'linear-light': 'apply.linearLight', divide: 'apply.divide', add: 'apply.add', subtract: 'apply.subtract',
};
