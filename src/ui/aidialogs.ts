import { app } from '../app';
import { el, createCanvas, ctx2d } from '../core/util';
import { t } from '../i18n';
import { openDialog, toast, confirmDialog, busy } from './dialog';
export { busy };
import { select } from './controls';
import { Layer } from '../core/layer';
import { Selection } from '../core/selection';
import { flatten } from '../core/ops';
import { resizeDocument } from './docdialogs';
import { applySelection } from '../tools/select';
import {
  aiSettings, hasKey, NeedKeyError, canvasBlob, blobCanvas, stabilityRemoveBg, stabilityUpscale,
  topazUpscale, topazModelFor, stabilityOutpaint, Service, STABILITY, sendableBlob,
} from '../ai/cloud';

/** Run a cloud call; a missing key opens the settings, errors become a toast. */
async function guarded<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); }
  catch (e: any) {
    if (e instanceof NeedKeyError) { toast(t('ai.needKey', e.service === 'stability' ? 'Stability AI' : 'Topaz Labs'), 'error', 4000); aiSettingsDialog(); }
    else { console.error(e); toast(`${t('app.error')}: ${e?.message || e}`, 'error', 6000); }
    return null;
  }
}

/* ---------------- settings ---------------- */
export function aiSettingsDialog() {
  const s = aiSettings();
  const keyInput = (v: string | undefined, ph: string) => {
    const i = el('input', { class: 'text-input', type: 'password', value: v || '', placeholder: ph, autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
    i.addEventListener('keydown', e => e.stopPropagation());
    const eye = el('button', { class: 'btn sm', type: 'button' }, t('ai.show'));
    eye.addEventListener('click', () => { i.type = i.type === 'password' ? 'text' : 'password'; eye.textContent = i.type === 'password' ? t('ai.show') : t('ai.hide'); });
    return { i, row: el('div', { class: 'ai-key' }, i, eye) };
  };
  const st = keyInput(s.stabilityKey, 'sk-…'), tz = keyInput(s.topazKey, '');
  let engine = s.upscaleEngine || 'local';
  const body = el('div', { class: 'form ai-settings' },
    el('p', { class: 'dlg-text' }, t('ai.intro')),
    el('div', { class: 'adj-section' }, t('ai.keys')),
    el('label', { class: 'ai-label' }, 'Stability AI'), st.row,
    el('div', { class: 'muted sm' }, t('ai.stabilityUse')),
    el('label', { class: 'ai-label' }, 'Topaz Labs'), tz.row,
    el('div', { class: 'muted sm' }, t('ai.topazUse')),
    el('div', { class: 'adj-section' }, t('ai.upscaleDefault')),
    select([{ value: 'local', label: t('ai.engine.local') }, { value: 'topaz', label: 'Topaz Labs' }, { value: 'stability', label: 'Stability AI' }], engine, v => { engine = v as any; }),
    el('div', { class: 'muted sm' }, t('ai.privacy')));
  openDialog({
    title: t('cmd.settings'), body, width: 420,
    onOk: () => {
      s.stabilityKey = st.i.value.trim() || undefined;
      s.topazKey = tz.i.value.trim() || undefined;
      s.upscaleEngine = engine;
      app.saveSettings();
      app.update('all');
    },
  });
}

/* ---------------- upscale ---------------- */
const MAX_SIDE = 16384, MAX_PX = 120e6;

async function upscaleCanvas(src: HTMLCanvasElement, scale: 2 | 4, engine: 'local' | 'topaz' | 'stability', ui: ReturnType<typeof busy>, cancelled: () => boolean): Promise<HTMLCanvasElement | null> {
  if (engine === 'local') {
    const { esrgan4x } = await import('../ai/esrgan');
    const big = await esrgan4x(src, (stage, p) => ui.set(stage === 'download' ? t('ai.downloading') : t('ai.upscaling'), p), cancelled);
    if (!big || scale === 4) return big;
    const half = createCanvas(src.width * 2, src.height * 2);
    const g = ctx2d(half); g.imageSmoothingQuality = 'high'; g.drawImage(big, 0, 0, half.width, half.height);
    return half;
  }
  ui.set(t('ai.sending'));
  const blob = await sendableBlob(src);
  if (engine === 'stability') {
    const why = upscaleProblem('stability', src.width, src.height);
    if (why) throw new Error(why);
    let out = await blobCanvas(await stabilityUpscale(blob));
    if (scale === 2) { const half = createCanvas(src.width * 2, src.height * 2); const g = ctx2d(half); g.imageSmoothingQuality = 'high'; g.drawImage(out, 0, 0, half.width, half.height); out = half; }
    return out;
  }
  return blobCanvas(await topazUpscale(blob, src.width * scale, src.height * scale, topazModelFor(src).model));
}

/**
 * Why an engine cannot take a picture of this size, or null: Stability's fast upscaler takes 32–1536 px per
 * side and at most 1 MP (it gives 4×; 2× is that result halved).
 */
function upscaleProblem(engine: 'local' | 'topaz' | 'stability', w: number, h: number): string | null {
  if (engine !== 'stability') return null;
  const u = STABILITY.upscale, size = `${w} × ${h}`;
  if (Math.min(w, h) < u.minSide) return t('ai.stabilityTooSmall', size);
  if (Math.max(w, h) > u.maxSide || w * h > u.maxPx) return t('ai.stabilityTooBig', size);
  return null;
}

export function upscaleDialog() {
  const d = app.doc;
  if (!d) return;
  let engine = aiSettings().upscaleEngine || 'local';
  let scale: 2 | 4 = 2;
  const note = el('div', { class: 'muted sm' });
  const size = el('div', { class: 'muted' });
  const model = el('div', { class: 'muted sm' });
  // what keeps the chosen engine from taking this picture, said before anything is sent (OK waits)
  const problem = el('div', { class: 'warn-text sm' });
  let okBtn: HTMLButtonElement | null = null;
  let topazPick: ReturnType<typeof topazModelFor> | undefined;
  const refresh = () => {
    size.textContent = `${d.width} × ${d.height} → ${d.width * scale} × ${d.height * scale} ${t('dlg.px')}`;
    const layers = d.layers.filter(l => !l.isGroup).length;
    note.textContent = engine === 'local' ? t('ai.localNote') : (layers > 1 ? t('ai.cloudFlatten') + ' ' : '') + t(engine === 'topaz' ? 'ai.topazNote' : 'ai.stabilityNote');
    // Topaz: the model it picks for this picture, and why
    model.textContent = engine === 'topaz' ? t('ai.topazModel.' + (topazPick ??= topazModelFor(d.composite())).why) : '';
    model.style.display = engine === 'topaz' ? '' : 'none';
    const W = d.width * scale, H = d.height * scale;
    const why = upscaleProblem(engine, d.width, d.height) ?? (W > MAX_SIDE || H > MAX_SIDE || W * H > MAX_PX ? t('ai.tooBig') : null);
    problem.textContent = why ?? '';
    problem.style.display = why ? '' : 'none';
    if (okBtn) okBtn.disabled = !!why;
  };
  const body = el('div', { class: 'form' },
    el('div', { class: 'form-row' }, el('label', {}, t('ai.engine')),
      select([{ value: 'local', label: t('ai.engine.local') }, { value: 'topaz', label: 'Topaz Labs' }, { value: 'stability', label: 'Stability AI' }], engine, v => { engine = v as any; refresh(); })),
    el('div', { class: 'form-row' }, el('label', {}, t('ai.scale')),
      select([{ value: '2', label: '2×' }, { value: '4', label: '4×' }], '2', v => { scale = +v as 2 | 4; refresh(); })),
    size, model, problem, note);
  refresh();
  const dlg = openDialog({
    title: t('cmd.upscale'), body, width: 400,
    onOk: () => {
      if (engine !== 'local' && !hasKey(engine as Service)) { guarded(() => Promise.reject(new NeedKeyError(engine as Service))); return false; }
      const W = d.width * scale, H = d.height * scale;
      if (W > MAX_SIDE || H > MAX_SIDE || W * H > MAX_PX) { toast(t('ai.tooBig'), 'error', 4000); return false; }
      runUpscale(engine, scale);
    },
  });
  okBtn = dlg.root.querySelector('.dlg-foot .btn.primary');
  refresh();
}

async function runUpscale(engine: 'local' | 'topaz' | 'stability', scale: 2 | 4) {
  const d = app.doc!;
  app.tool.cancel();
  let stop = false;
  const ui = busy(t('ai.preparing'), () => { stop = true; });
  try {
    // cloud engines work on the whole picture: one call instead of one per layer
    if (engine !== 'local' && d.layers.filter(l => !l.isGroup).length > 1) { flatten(d, t('layers.background')); app.commit('cmd.flatten', d); }
    const rasters = d.layers.filter(l => !l.isGroup && l.kind !== 'text' && l.canvas.width > 0);
    const results: { l: Layer; c: HTMLCanvasElement; x: number; y: number }[] = [];
    for (let i = 0; i < rasters.length; i++) {
      const l = rasters[i];
      ui.set(t('ai.layerOf', i + 1, rasters.length));
      const c = await guarded(() => upscaleCanvas(l.canvas, scale, engine, ui, () => stop));
      if (!c) { ui.close(); if (stop) toast(t('ai.cancelled')); return; }
      results.push({ l, c, x: l.x, y: l.y });
    }
    // text, masks and the selection are scaled exactly; raster layers get the AI result
    resizeDocument(d, d.width * scale, d.height * scale, 'bicubic');
    for (const r of results) { r.l.content.replace(r.c, Math.round(r.x * scale), Math.round(r.y * scale)); r.l.touch(); }
    app.commit('cmd.upscale', d);
    app.viewport.fit(false);
    toast(t('ai.done'));
  } finally { ui.close(); }
}

/* ---------------- background removal / subject ---------------- */
/**
 * Background removal takes 64 px per side and at most 4.19 MP (it took 9.4 before, and larger photos were
 * refused): a reduced copy is sent and the mask scaled back.
 */
function limitSize(c: HTMLCanvasElement, maxPx = STABILITY.removeBg.maxPx, minSide = STABILITY.removeBg.minSide): { c: HTMLCanvasElement; k: number } {
  const px = c.width * c.height;
  let k = px > maxPx ? Math.sqrt(maxPx / px) : 1;
  if (Math.min(c.width, c.height) * k < minSide) k = minSide / Math.min(c.width, c.height);
  if (k === 1) return { c, k };
  // rounded down: rounded to the nearest, 2365 × 1774 came out a few pixels over the limit
  const o = createCanvas(Math.max(minSide, Math.floor(c.width * k)), Math.max(minSide, Math.floor(c.height * k)));
  const g = ctx2d(o); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, o.width, o.height);
  return { c: o, k };
}

/** Alpha of the subject (document-sized canvas whose alpha is the mask). */
async function subjectAlpha(src: HTMLCanvasElement, ui: ReturnType<typeof busy>): Promise<HTMLCanvasElement | null> {
  const { c } = limitSize(src);
  ui.set(t('ai.sending'));
  const res = await guarded(async () => blobCanvas(await stabilityRemoveBg(await sendableBlob(c))));
  if (!res) return null;
  const out = createCanvas(src.width, src.height);
  const g = ctx2d(out); g.imageSmoothingQuality = 'high'; g.drawImage(res, 0, 0, src.width, src.height);
  return out;
}

/** Remove Background: the active layer gets a mask that hides the background (non-destructive). */
export async function removeBackground() {
  const d = app.doc, l = d?.active;
  if (!d || !l) return;
  if (l.isGroup || l.kind === 'text') { toast(t('ai.needRaster'), 'error'); return; }
  if (!hasKey('stability')) { guarded(() => Promise.reject(new NeedKeyError('stability'))); return; }
  if (l.mask && !(await confirmDialog(t('ai.replaceMask')))) return;
  const ui = busy(t('ai.removingBg'));
  try {
    const src = createCanvas(d.width, d.height);
    ctx2d(src).drawImage(l.canvas, l.x, l.y);
    const alpha = await subjectAlpha(src, ui);
    if (!alpha) return;
    l.mask = null;
    const m = l.addMask(d.width, d.height, 0);
    m.ctx.clearRect(0, 0, m.w, m.h);
    m.ctx.drawImage(alpha, -m.x, -m.y);
    m.markDirty();
    l.touch();
    app.commit('cmd.removeBg', d);
  } finally { ui.close(); }
}

/** Select Subject: selection of the main subject of the visible image. */
export async function selectSubject() {
  const d = app.doc;
  if (!d) return;
  if (!hasKey('stability')) { guarded(() => Promise.reject(new NeedKeyError('stability'))); return; }
  const ui = busy(t('ai.selecting'));
  try {
    const alpha = await subjectAlpha(d.composite(), ui);
    if (!alpha) return;
    applySelection(Selection.fromMask(alpha), 'new');
  } finally { ui.close(); }
}

/* ---------------- outpainting (crop beyond the canvas) ---------------- */
/**
 * After a crop that extended the canvas: generate the new area. `before` is the visible image before
 * the crop, `r` the crop rectangle in its coordinates.
 */
type Frame = { x: number; y: number; w: number; h: number };
type OutpaintPlan = { ix: number; iy: number; iw: number; ih: number; ext: { left: number; up: number; right: number; down: number }; k: number };

/**
 * The outpainting request for a crop frame `r` over a W × H picture: the part of the picture in the frame, how
 * far it is extended on each side, and the scale that keeps the request within Stability's limits (at most 2000
 * px per side extended, about 9 MP in all); or why it cannot be sent: the part in the frame must be at least
 * 64 px on each side (once scaled) and no longer than 2.5 : 1. Checked before the crop is made.
 */
export function outpaintPlan(W: number, H: number, r: Frame): OutpaintPlan | string {
  const o = STABILITY.outpaint;
  const ix = Math.max(0, Math.round(r.x)), iy = Math.max(0, Math.round(r.y));
  const ix1 = Math.min(W, Math.round(r.x + r.w)), iy1 = Math.min(H, Math.round(r.y + r.h));
  const iw = ix1 - ix, ih = iy1 - iy;
  if (iw <= 0 || ih <= 0) return t('ai.outpaintNothing');
  const ext = { left: ix - Math.round(r.x), up: iy - Math.round(r.y), right: Math.round(r.x + r.w) - ix1, down: Math.round(r.y + r.h) - iy1 };
  const totalW = iw + ext.left + ext.right, totalH = ih + ext.up + ext.down;
  const k = Math.min(1, Math.sqrt(9_000_000 / (totalW * totalH)), o.maxExtend / Math.max(ext.left, ext.right, ext.up, ext.down, 1));
  const ratio = Math.max(iw, ih) / Math.min(iw, ih);
  // (the whole picture in the frame: it is the picture that is too long, a frame cannot help)
  if (ratio > o.maxRatio) return t(iw === W && ih === H ? 'ai.outpaintRatioWhole' : 'ai.outpaintRatio', ratio.toFixed(1).replace('.', t('num.dot')));
  if (Math.min(iw, ih) * k < o.minSide) return t('ai.outpaintSmall');
  return { ix, iy, iw, ih, ext, k };
}

export async function outpaintAfterCrop(before: HTMLCanvasElement, r: Frame) {
  const d = app.doc!;
  const plan = outpaintPlan(before.width, before.height, r);
  if (typeof plan === 'string') { toast(plan, 'error', 6000); return; }
  const { ix, iy, iw, ih, ext, k } = plan;
  const inner = createCanvas(iw, ih);
  ctx2d(inner).drawImage(before, -ix, -iy);
  let src = inner;
  if (k < 1) { src = createCanvas(Math.round(inner.width * k), Math.round(inner.height * k)); const g = ctx2d(src); g.imageSmoothingQuality = 'high'; g.drawImage(inner, 0, 0, src.width, src.height); }
  const ui = busy(t('ai.outpainting'));
  try {
    const res = await guarded(async () => blobCanvas(await stabilityOutpaint(await sendableBlob(src), {
      left: Math.round(ext.left * k), right: Math.round(ext.right * k), up: Math.round(ext.up * k), down: Math.round(ext.down * k),
    })));
    if (!res) return;
    // on top of the others: Stability redraws the whole frame a little, the old picture's edges too, so under
    // the old layers its result showed their hard edge instead of its smooth join
    const l = new Layer('raster', t('ai.outpaintLayer'), d.width, d.height);
    const g = l.content.ctx; g.imageSmoothingQuality = 'high'; g.drawImage(res, 0, 0, d.width, d.height);
    d.root.children.push(l); l.parent = d.root;
    l.touch();
    d.setActive(l);
    app.commit('cmd.outpaint', d);
  } finally { ui.close(); }
}
