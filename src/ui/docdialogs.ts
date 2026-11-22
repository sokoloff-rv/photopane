import { app } from '../app';
import { Doc } from '../core/document';
import { Layer, Surface } from '../core/layer';
import { Selection } from '../core/selection';
import { createCanvas, ctx2d, el } from '../core/util';
import { css } from '../core/color';
import { renderTextLayer } from '../core/text';
import { cropDocument, transformLayer } from '../core/ops';
import { t } from '../i18n';
import { openDialog } from './dialog';
import { numberField, select, checkbox } from './controls';

type Method = 'auto' | 'bicubic' | 'bilinear' | 'nearest';

/** High quality resampling (stepwise halving for strong downscales). */
export function resample(src: HTMLCanvasElement, w: number, h: number, method: Method): HTMLCanvasElement {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  let cur = src;
  if (method !== 'nearest') {
    while (cur.width / 2 >= w && cur.height / 2 >= h) {
      const half = createCanvas(Math.ceil(cur.width / 2), Math.ceil(cur.height / 2));
      const g = ctx2d(half);
      g.imageSmoothingQuality = 'high';
      g.drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
    }
  }
  const out = createCanvas(w, h);
  const g = ctx2d(out);
  g.imageSmoothingEnabled = method !== 'nearest';
  g.imageSmoothingQuality = method === 'bilinear' ? 'medium' : 'high';
  g.drawImage(cur, 0, 0, w, h);
  return out;
}

export function resizeDocument(d: Doc, W: number, H: number, method: Method) {
  const sx = W / d.width, sy = H / d.height;
  const scaleSurface = (s: Surface) => {
    const nx = Math.round(s.x * sx), ny = Math.round(s.y * sy);
    const nw = Math.max(1, Math.round((s.x + s.w) * sx) - nx), nh = Math.max(1, Math.round((s.y + s.h) * sy) - ny);
    s.replace(resample(s.canvas, nw, nh, method), nx, ny);
  };
  const walk = (l: Layer) => {
    if (l.kind === 'text' && l.text) {
      const tx = l.text;
      tx.size *= sy; tx.ax *= sx; tx.ay *= sy;
      if (tx.box) tx.box = { w: tx.box.w * sx, h: tx.box.h * sy };
      renderTextLayer(l);
    } else if (!l.isGroup) scaleSurface(l.content);
    if (l.mask) scaleSurface(l.mask);
    l.children.forEach(walk);
    l.touch();
  };
  d.root.children.forEach(walk);
  if (d.selection) {
    const c = createCanvas(W, H);
    const g = ctx2d(c); g.imageSmoothingQuality = 'high';
    g.drawImage(d.selection.mask, 0, 0, W, H);
    d.selection = Selection.fromMask(c);
  }
  d.guides = { h: d.guides.h.map(y => y * sy), v: d.guides.v.map(x => x * sx) };
  d.width = W; d.height = H;
  d.invalidate();
}

export function imageSizeDialog() {
  const d = app.doc;
  if (!d) return;
  let w = d.width, h = d.height, linked = true;
  let method: Method = (app.settings.resample as Method) || 'auto';
  const ratio = d.width / d.height;
  const pct = el('span', { class: 'muted sm mono' });
  const updPct = () => { pct.textContent = `${Math.round(w / d.width * 1000) / 10}% × ${Math.round(h / d.height * 1000) / 10}%  ·  ${(w * h / 1e6).toFixed(1)} MP`; };
  const wf = numberField({ value: w, min: 1, max: 30000, unit: t('dlg.px'), width: 64, onChange: v => { w = v; if (linked) { h = Math.max(1, Math.round(v / ratio)); hf.set(h); } updPct(); } });
  const hf = numberField({ value: h, min: 1, max: 30000, unit: t('dlg.px'), width: 64, onChange: v => { h = v; if (linked) { w = Math.max(1, Math.round(v * ratio)); wf.set(w); } updPct(); } });
  const pctField = numberField({ value: 100, min: 1, max: 1000, step: 0.1, unit: '%', width: 52, onChange: v => { w = Math.max(1, Math.round(d.width * v / 100)); h = Math.max(1, Math.round(d.height * v / 100)); wf.set(w); hf.set(h); updPct(); } });
  updPct();
  const body = el('div', { class: 'form' },
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.current')), el('span', { class: 'mono' }, `${d.width} × ${d.height} ${t('dlg.px')}`)),
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.scale')), pctField),
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.width')), wf),
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.height')), hf),
    el('div', { class: 'form-row' }, el('label', {}, ''), checkbox(t('dlg.constrain'), linked, v => (linked = v))),
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.resample')),
      select<Method>([{ value: 'auto', label: t('dlg.rs.auto') }, { value: 'bicubic', label: t('dlg.rs.bicubic') }, { value: 'bilinear', label: t('dlg.rs.bilinear') }, { value: 'nearest', label: t('dlg.rs.nearest') }], method, v => (method = v))),
    el('div', { class: 'form-row' }, el('label', {}, ''), pct));
  openDialog({
    title: t('cmd.imageSize').replace('…', ''), body, width: 420,
    onOk: () => {
      if (w === d.width && h === d.height) return;
      app.settings.resample = method; app.saveSettings();
      resizeDocument(d, w, h, method);
      app.commit('cmd.imageSize');
      app.viewport.fit(true);
    },
  });
}

export function canvasSizeDialog() {
  const d = app.doc;
  if (!d) return;
  let w = d.width, h = d.height, relative = false;
  let ax = 1, ay = 1;
  let fill: 'transparent' | 'bg' | 'white' | 'black' = 'transparent';
  const wf = numberField({ value: w, min: -30000, max: 30000, unit: t('dlg.px'), width: 64, onChange: v => (w = v) });
  const hf = numberField({ value: h, min: -30000, max: 30000, unit: t('dlg.px'), width: 64, onChange: v => (h = v) });
  const grid = el('div', { class: 'align-grid' });
  const renderGrid = () => {
    grid.innerHTML = '';
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const b = el('button', { class: i === ax && j === ay ? 'on' : '' });
      b.addEventListener('click', () => { ax = i; ay = j; renderGrid(); });
      grid.append(b);
    }
  };
  renderGrid();
  const body = el('div', { class: 'form' },
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.current')), el('span', { class: 'mono' }, `${d.width} × ${d.height} ${t('dlg.px')}`)),
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.width')), wf),
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.height')), hf),
    el('div', { class: 'form-row' }, el('label', {}, ''), checkbox(t('dlg.relative'), relative, v => {
      relative = v;
      w = v ? 0 : d.width; h = v ? 0 : d.height; wf.set(w); hf.set(h);
    })),
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.anchor')), grid),
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.extension')),
      select([{ value: 'transparent', label: t('dlg.bg.transparent') }, { value: 'bg', label: t('dlg.bg.bgColor') }, { value: 'white', label: t('dlg.bg.white') }, { value: 'black', label: t('dlg.bg.black') }], fill, v => (fill = v as any))));
  openDialog({
    title: t('cmd.canvasSize').replace('…', ''), body, width: 420,
    onOk: () => {
      const W = Math.max(1, relative ? d.width + w : w), H = Math.max(1, relative ? d.height + h : h);
      if (W === d.width && H === d.height) return;
      const x = -Math.round((W - d.width) * ax / 2), y = -Math.round((H - d.height) * ay / 2);
      const oldW = d.width, oldH = d.height;
      cropDocument(d, { x, y, w: W, h: H }, true);
      if (fill !== 'transparent' && (W > oldW || H > oldH)) {
        const color = fill === 'bg' ? css(app.bg) : fill;
        const l = new Layer('raster', t('layers.background'), W, H);
        const g = l.content.ctx;
        g.fillStyle = color; g.fillRect(0, 0, W, H);
        g.clearRect(-x, -y, oldW, oldH);
        d.root.children.unshift(l); l.parent = d.root;
        if (d.root.children[1]) d.root.children[1].clipped = false;
      }
      app.commit('cmd.canvasSize');
      app.viewport.fit(true);
    },
  });
}

export function rotateArbitraryDialog() {
  const d = app.doc;
  if (!d) return;
  let angle = app.settings.rotAngle ?? 15;
  let cw = true;
  const body = el('div', { class: 'form' },
    el('div', { class: 'form-row' }, el('label', {}, t('opt.angle')), numberField({ value: angle, min: 0, max: 359.99, step: 0.01, unit: '°', width: 60, onChange: v => (angle = v) })),
    el('div', { class: 'form-row' }, el('label', {}, ''),
      select([{ value: 'cw', label: t('dlg.cw') }, { value: 'ccw', label: t('dlg.ccw') }], 'cw', v => (cw = v === 'cw'))));
  openDialog({
    title: t('cmd.rotArbitrary').replace('…', ''), body, width: 360,
    onOk: () => {
      if (!angle) return;
      app.settings.rotAngle = angle; app.saveSettings();
      rotateDocument(d, (cw ? 1 : -1) * angle);
      app.commit('cmd.rotation');
      app.viewport.fit(true);
    },
  });
}

/** Rotate the whole document by an arbitrary angle; the canvas grows to fit. */
export function rotateDocument(d: Doc, deg: number) {
  const r = deg * Math.PI / 180;
  const W = d.width, H = d.height;
  const nw = Math.ceil(Math.abs(W * Math.cos(r)) + Math.abs(H * Math.sin(r)));
  const nh = Math.ceil(Math.abs(W * Math.sin(r)) + Math.abs(H * Math.cos(r)));
  const m = new DOMMatrix().translate(nw / 2, nh / 2).rotate(deg).translate(-W / 2, -H / 2);
  for (const l of d.root.children) transformLayer(l, m);
  if (d.selection) {
    const c = createCanvas(nw, nh);
    const g = ctx2d(c); g.setTransform(m); g.drawImage(d.selection.mask, 0, 0);
    d.selection = Selection.fromMask(c);
  }
  d.width = nw; d.height = nh;
  d.guides = { h: [], v: [] };
  d.invalidate();
}
