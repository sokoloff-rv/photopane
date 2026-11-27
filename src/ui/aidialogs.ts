import { app } from '../app';
import { el, createCanvas, ctx2d, cloneCanvas } from '../core/util';
import { t } from '../i18n';
import { openDialog, toast, confirmDialog, busy } from './dialog';
export { busy };
import { select } from './controls';
import { Layer, hasEffects } from '../core/layer';
import type { Doc } from '../core/document';
import { Selection } from '../core/selection';
import { convertPixels } from '../core/colorspace';
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
    const { esrganUpscale } = await import('../ai/esrgan');
    return esrganUpscale(src, scale, (stage, p) => ui.set(stage === 'download' ? t('ai.downloading') : t('ai.upscaling'), p), cancelled);
  }
  ui.set(t('ai.sending'));
  // Stability takes at most 10 MiB a request (WebP or JPEG beyond that); Topaz takes no WebP, and no such limit
  const blob = engine === 'stability' ? await sendableBlob(src) : await canvasBlob(src);
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
/**
 * A cloud engine is sent what is seen (masks, opacity, hidden layers, styles as shown), and its result
 * replaces the picture: the document is flattened, after the result has come. A single plain layer covering
 * the canvas needs no flattening.
 */
function cloudFlattens(d: Doc): boolean {
  if (d.root.children.length !== 1) return true;
  const l = d.root.children[0];
  if (l.isGroup) return true;
  return l.kind === 'text' || !!l.mask || !l.visible || l.opacity !== 1 || l.blend !== 'normal' || hasEffects(l.effects)
    || l.x !== 0 || l.y !== 0 || l.canvas.width !== d.width || l.canvas.height !== d.height;
}

/** The result too large for a canvas: the document's for the cloud, every layer's for the local model. */
function sizeProblem(d: Doc, engine: 'local' | 'topaz' | 'stability', scale: number): string | null {
  const big = (w: number, h: number) => w * scale > MAX_SIDE || h * scale > MAX_SIDE || w * h * scale * scale > MAX_PX;
  if (big(d.width, d.height)) return t('ai.tooBig');
  // (every surface the resize makes, layers, text and masks, kept beyond the canvas by a crop too)
  if (d.layers.some(l => (!l.isGroup && big(l.canvas.width, l.canvas.height)) || (l.mask && big(l.mask.w, l.mask.h)))) return t('ai.tooBig');
  return null;
}

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
    note.textContent = engine === 'local' ? t('ai.localNote') : (cloudFlattens(d) ? t('ai.cloudFlatten') + ' ' : '') + t(engine === 'topaz' ? 'ai.topazNote' : 'ai.stabilityNote');
    // Topaz: the model it picks for this picture, and why
    model.textContent = engine === 'topaz' ? t('ai.topazModel.' + (topazPick ??= topazModelFor(d.composite())).why) : '';
    model.style.display = engine === 'topaz' ? '' : 'none';
    const why = upscaleProblem(engine, d.width, d.height) ?? sizeProblem(d, engine, scale);
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
      // (Enter reaches here even while OK is off)
      const why = upscaleProblem(engine, d.width, d.height) ?? sizeProblem(d, engine, scale);
      if (why) { toast(why, 'error', 6000); return false; }
      // the document of this window (another may have been opened from outside meanwhile)
      if (!app.docs.includes(d)) return;
      void runUpscale(d, engine, scale);
    },
  });
  okBtn = dlg.root.querySelector('.dlg-foot .btn.primary');
  refresh();
}

async function runUpscale(d: Doc, engine: 'local' | 'topaz' | 'stability', scale: 2 | 4) {
  if (app.doc === d) app.tool.cancel();
  let stop = false;
  const ui = busy(t('ai.preparing'), () => { stop = true; });
  try {
    const why = upscaleProblem(engine, d.width, d.height) ?? sizeProblem(d, engine, scale);
    if (why) { toast(why, 'error', 6000); return; }
    // cloud engines: one call with the picture as seen (the size the window checked and named the Topaz model
    // for, nothing a mask hides); the document is flattened only once the result has come
    if (engine !== 'local') {
      // the services take sRGB: a document in another profile is sent as it looks, and the result is put back
      // into its profile
      const src = cloneCanvas(d.colorProfile ? d.displayComposite() : d.composite());
      // (the current History step: a change made meanwhile adds one; the version counter also moves when the
      // picture is only redrawn)
      const step0 = d.history.entries[d.history.index];
      const c = await guarded(() => upscaleCanvas(src, scale, engine, ui, () => stop));
      if (!c || stop) { ui.close(); if (stop) toast(t('ai.cancelled')); return; }
      // (closed, or changed meanwhile: a file placed while the request ran is not replaced by a result
      // made without it)
      if (!app.docs.includes(d)) return;
      if (d.history.entries[d.history.index] !== step0) { toast(t('ai.changedMeanwhile'), 'error', 6000); return; }
      if (d.colorProfile) {
        const g = ctx2d(c), data = g.getImageData(0, 0, c.width, c.height);
        convertPixels(data.data, null, d.colorProfile);
        g.putImageData(data, 0, 0);
      }
      // one History step: undone, the layers come back as they were (not a flattened copy on white)
      if (cloudFlattens(d)) flatten(d, t('layers.background'));
      resizeDocument(d, d.width * scale, d.height * scale, 'bicubic');
      const l = d.layers.find(x => !x.isGroup)!;
      l.content.replace(c, 0, 0); l.touch();
      app.commit('cmd.upscale', d);
      if (app.doc === d) app.viewport.fit(false);
      toast(t('ai.done'));
      return;
    }
    const rasters = d.layers.filter(l => !l.isGroup && l.kind !== 'text' && l.canvas.width > 0);
    const results: { l: Layer; c: HTMLCanvasElement; x: number; y: number }[] = [];
    for (let i = 0; i < rasters.length; i++) {
      const l = rasters[i];
      ui.set(t('ai.layerOf', i + 1, rasters.length));
      const c = await guarded(() => upscaleCanvas(l.canvas, scale, engine, ui, () => stop));
      if (!c) { ui.close(); if (stop) toast(t('ai.cancelled')); return; }
      results.push({ l, c, x: l.x, y: l.y });
    }
    // (Cancel pressed after the last tile)
    if (stop) { toast(t('ai.cancelled')); return; }
    if (!app.docs.includes(d)) return;
    // text, masks and the selection are scaled exactly; raster layers get the AI result
    resizeDocument(d, d.width * scale, d.height * scale, 'bicubic');
    for (const r of results) { r.l.content.replace(r.c, Math.round(r.x * scale), Math.round(r.y * scale)); r.l.touch(); }
    app.commit('cmd.upscale', d);
    if (app.doc === d) app.viewport.fit(false);
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
type OutpaintPlan = {
  ix: number; iy: number; iw: number; ih: number;
  /** the size the part in the frame is sent at, and how far it is extended on each side (as sent) */
  sw: number; sh: number; ext: { left: number; up: number; right: number; down: number };
};

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
  const e0 = { left: ix - Math.round(r.x), up: iy - Math.round(r.y), right: Math.round(r.x + r.w) - ix1, down: Math.round(r.y + r.h) - iy1 };
  const totalW = iw + e0.left + e0.right, totalH = ih + e0.up + e0.down;
  const k = Math.min(1, Math.sqrt(9_000_000 / (totalW * totalH)), o.maxExtend / Math.max(e0.left, e0.right, e0.up, e0.down, 1));
  const ratio = Math.max(iw, ih) / Math.min(iw, ih);
  // the numbers as sent, rounded: a side extended stays extended by at least a pixel. Within 2.5 : 1, rounding
  // never takes the part past it (the short side is rounded up when it would); beyond it, the request is
  // refused unless its rounded size is within (321 × 128 sent as 320 × 128)
  let sw = Math.max(1, Math.round(iw * k)), sh = Math.max(1, Math.round(ih * k));
  if (ratio > o.maxRatio && Math.max(sw, sh) / Math.min(sw, sh) > o.maxRatio) {
    // (the whole picture in the frame: it is the picture that is too long, a frame cannot help)
    return t(iw === W && ih === H ? 'ai.outpaintRatioWhole' : 'ai.outpaintRatio', ratio.toFixed(1).replace('.', t('num.dot')));
  }
  if (sw / sh > o.maxRatio) sh = Math.ceil(sw / o.maxRatio);
  if (sh / sw > o.maxRatio) sw = Math.ceil(sh / o.maxRatio);
  if (Math.min(sw, sh) < o.minSide) return t('ai.outpaintSmall');
  const side = (v: number) => (v > 0 ? Math.min(o.maxExtend, Math.max(1, Math.round(v * k))) : 0);
  const ext = { left: side(e0.left), up: side(e0.up), right: side(e0.right), down: side(e0.down) };
  return { ix, iy, iw, ih, sw, sh, ext };
}

export async function outpaintAfterCrop(before: HTMLCanvasElement, r: Frame) {
  const d = app.doc!;
  const plan = outpaintPlan(before.width, before.height, r);
  if (typeof plan === 'string') { toast(plan, 'error', 6000); return; }
  const { ix, iy, iw, ih, sw, sh, ext } = plan;
  const inner = createCanvas(iw, ih);
  ctx2d(inner).drawImage(before, -ix, -iy);
  let src = inner;
  if (sw !== iw || sh !== ih) { src = createCanvas(sw, sh); const g = ctx2d(src); g.imageSmoothingQuality = 'high'; g.drawImage(inner, 0, 0, sw, sh); }
  const ui = busy(t('ai.outpainting'));
  try {
    const res = await guarded(async () => blobCanvas(await stabilityOutpaint(await sendableBlob(src), ext)));
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
