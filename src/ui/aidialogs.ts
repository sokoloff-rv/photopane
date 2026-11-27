import { app } from '../app';
import { el, createCanvas, ctx2d, cloneCanvas } from '../core/util';
import { t, tn, fmtNum, getLang } from '../i18n';
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
  NAME, STABILITY_PRICE, STABILITY_CREDIT_USD, accountBalance, topazEstimate, onSpent, within, Balance, keyOf,
} from '../ai/cloud';
import { spentOver } from '../ai/usage';

/* ---------------- credits ---------------- */
const usd = (credits: number) => '$' + (credits * STABILITY_CREDIT_USD).toLocaleString(getLang() === 'ru' ? 'ru-RU' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** «1 234,5 кредита (≈ $12,35)» for Stability, whose credit has a price; «57 кредитов» for Topaz */
const creditsText = (s: Service, credits: number, digits = 0) => tn('ai.credits', credits, digits) + (s === 'stability' ? ` (≈ ${usd(credits)})` : '');
/** «Стоимость: 5 кредитов (≈ $0,05)»: said where a cloud operation is called, and while it runs */
export const costText = (s: Service, credits: number) => t('ai.cost', creditsText(s, credits));
const balanceText = (s: Service, b: Balance) => creditsText(s, b.credits, 1) + (b.reserved ? `, ${t('ai.reserved', fmtNum(b.reserved))}` : '');
/** an error said under the service's name: without the name again */
const withoutName = (s: Service, e: unknown) => {
  const m = String((e as Error)?.message ?? e).replace(NAME[s] + ': ', '');
  return m === t('ai.err.key') ? t('ai.keyRejected') : m.charAt(0).toUpperCase() + m.slice(1);
};

// every charge said as it happens, with what is left after it (asked of the service; a cancelled request is
// charged too, the service has done it)
// (a balance that comes after the one of a later charge is older than what was said: left out)
const charges: Record<Service, { n: number; shown: number }> = { stability: { n: 0, shown: 0 }, topaz: { n: 0, shown: 0 } };
onSpent((s, credits) => {
  const c = charges[s], my = ++c.n;
  void within(accountBalance(s)).catch(() => null).then(b => {
    if (b && my < c.shown) b = null;
    if (b) c.shown = my;
    const what = credits == null ? t('ai.spentUnknown') : t('ai.spent', tn('ai.credits', credits));
    toast(`${NAME[s]}: ${what}${b ? ', ' + t('ai.left', tn('ai.credits', b.credits, 1)) : ''}`, 'info', 5000);
  });
});

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
/** `onSaved`: a window waiting under this one, told when the keys may have changed (it shows prices). */
export function aiSettingsDialog(onSaved?: () => void) {
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

  // what is left on each key, asked when the window opens and when a key is changed (a check of the key too)
  const balanceLine = (svc: Service, input: HTMLInputElement) => {
    const text = el('span', {});
    const again = el('button', { class: 'btn sm', type: 'button' }, t('ai.refresh'));
    const line = el('div', { class: 'ai-balance sm' }, text, again);
    let seq = 0;
    const load = () => {
      const key = input.value.trim();
      line.style.display = key ? '' : 'none';
      const my = ++seq;
      if (!key) return;
      text.className = 'muted';
      text.textContent = t('ai.balanceLoading');
      within(accountBalance(svc, key)).then(
        b => { if (my === seq) text.textContent = t('ai.balance', balanceText(svc, b)); },
        e => { if (my === seq) { text.className = 'warn-text'; text.textContent = withoutName(svc, e); } });
    };
    // a key pasted or typed is asked about once it stays the same a moment (a balance asked for the key before
    // is not shown beside the new one)
    let wait = 0;
    input.addEventListener('input', () => {
      ++seq; clearTimeout(wait); wait = window.setTimeout(load, 700);
      text.className = 'muted'; text.textContent = t('ai.balanceLoading');
    });
    input.addEventListener('change', () => { clearTimeout(wait); load(); });
    again.addEventListener('click', load);
    load();
    return line;
  };

  // what PhotoPane has spent, counted here (the services' figures are the whole account's)
  let period = s.usagePeriod ?? '30';
  const usage = el('div', { class: 'ai-usage sm' });
  const showUsage = () => {
    usage.innerHTML = '';
    for (const svc of ['stability', 'topaz'] as Service[]) {
      const u = spentOver(svc, period === 'all' ? null : +period);
      usage.append(el('div', {}, el('span', { class: 'muted' }, NAME[svc] + ': '),
        u.requests ? `${creditsText(svc, u.credits)}, ${tn('ai.requests', u.requests)}` : t('ai.usageNone')));
    }
  };
  showUsage();

  const body = el('div', { class: 'form ai-settings' },
    el('p', { class: 'dlg-text' }, t('ai.intro')),
    el('div', { class: 'adj-section' }, t('ai.keys')),
    el('label', { class: 'ai-label' }, 'Stability AI'), st.row,
    balanceLine('stability', st.i),
    el('div', { class: 'muted sm' }, t('ai.stabilityUse')),
    el('label', { class: 'ai-label' }, 'Topaz Labs'), tz.row,
    balanceLine('topaz', tz.i),
    el('div', { class: 'muted sm' }, t('ai.topazUse')),
    el('div', { class: 'adj-section' }, t('ai.usage')),
    el('div', { class: 'form-row' }, el('label', {}, t('ai.period')),
      select([{ value: '7', label: t('ai.period.7') }, { value: '30', label: t('ai.period.30') }, { value: 'all', label: t('ai.period.all') }], period, v => { period = v as typeof period; showUsage(); })),
    usage,
    el('div', { class: 'adj-section' }, t('ai.upscaleDefault')),
    select([{ value: 'local', label: t('ai.engine.local') }, { value: 'topaz', label: 'Topaz Labs' }, { value: 'stability', label: 'Stability AI' }], engine, v => { engine = v as any; }));
  openDialog({
    title: t('cmd.settings'), body, width: 440,
    onOk: () => {
      s.stabilityKey = st.i.value.trim() || undefined;
      s.topazKey = tz.i.value.trim() || undefined;
      s.upscaleEngine = engine;
      s.usagePeriod = period;
      app.saveSettings();
      app.update('all');
      onSaved?.();
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
    ui.note(costText('stability', STABILITY_PRICE.upscale));
    let out = await blobCanvas(await stabilityUpscale(blob));
    if (scale === 2) { const half = createCanvas(src.width * 2, src.height * 2); const g = ctx2d(half); g.imageSmoothingQuality = 'high'; g.drawImage(out, 0, 0, half.width, half.height); out = half; }
    return out;
  }
  const model = topazModelFor(src).model;
  // (the estimate the window asked for, kept)
  void within(topazEstimate(src.width, src.height, src.width * scale, src.height * scale, model)).then(c => ui.note(costText('topaz', c)), () => {});
  return blobCanvas(await topazUpscale(blob, src.width, src.height, src.width * scale, src.height * scale, model));
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
  // the local model enlarges every surface the resize makes, layers, text as drawn and masks, kept beyond the
  // canvas by a crop too (the cloud flattens to the document first)
  if (engine === 'local' && d.layers.some(l => (!l.isGroup && big(l.canvas.width, l.canvas.height)) || (l.mask && big(l.mask.w, l.mask.h)))) return t('ai.tooBig');
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
  // what the cloud engine will charge, and what is left on the account; said, not enforced (the balance may be
  // a moment old)
  const cost = el('div', { class: 'muted sm' });
  const short = el('div', { class: 'warn-text sm' });
  // (asked once for each key: one replaced in the settings meanwhile is asked about anew)
  const balances = new Map<string, Promise<Balance | null>>();
  const balanceOf = (s: Service) => {
    const id = s + '|' + keyOf(s);
    let p = balances.get(id);
    if (!p) { p = within(accountBalance(s)).catch(() => null); balances.set(id, p); }
    return p;
  };
  let costSeq = 0;
  const showCost = async (why: string | null) => {
    const my = ++costSeq;
    short.style.display = 'none';
    const s = engine;
    if (s === 'local' || why || (s === 'topaz' && !hasKey('topaz'))) { cost.style.display = 'none'; return; }
    cost.style.display = '';
    let price: number | null = STABILITY_PRICE.upscale;
    if (s === 'topaz') {
      cost.textContent = t('ai.costLoading');
      price = await within(topazEstimate(d.width, d.height, d.width * scale, d.height * scale, topazPick!.model)).catch(() => null);
      if (my !== costSeq) return;
    }
    const priceText = price == null ? t('ai.costUnknown') : costText(s, price);
    cost.textContent = priceText;
    if (!hasKey(s)) return;
    const b = await balanceOf(s);
    if (my !== costSeq || !b) return;
    cost.textContent = `${priceText} · ${t('ai.left', tn('ai.credits', b.credits, 1))}`;
    if (price != null && b.credits < price) { short.textContent = t('ai.notEnough'); short.style.display = ''; }
  };
  let okBtn: HTMLButtonElement | null = null;
  let topazPick: ReturnType<typeof topazModelFor> | undefined;
  const refresh = () => {
    size.textContent = `${d.width} × ${d.height} → ${d.width * scale} × ${d.height * scale} ${t('dlg.px')}`;
    note.textContent = engine === 'local' ? t('ai.localNote') : (cloudFlattens(d) ? t('ai.cloudFlatten') + ' ' : '') + t(engine === 'topaz' ? 'ai.topazNote' : 'ai.stabilityNote');
    // Topaz: the model it picks for this picture, and why
    // (from the same pixels as are sent: as displayed, for a document in another colour profile)
    model.textContent = engine === 'topaz' ? t('ai.topazModel.' + (topazPick ??= topazModelFor(d.colorProfile ? d.displayComposite() : d.composite())).why) : '';
    model.style.display = engine === 'topaz' ? '' : 'none';
    const why = upscaleProblem(engine, d.width, d.height) ?? sizeProblem(d, engine, scale);
    problem.textContent = why ?? '';
    problem.style.display = why ? '' : 'none';
    if (okBtn) okBtn.disabled = !!why;
    void showCost(why);
  };
  const body = el('div', { class: 'form' },
    el('div', { class: 'form-row' }, el('label', {}, t('ai.engine')),
      select([{ value: 'local', label: t('ai.engine.local') }, { value: 'topaz', label: 'Topaz Labs' }, { value: 'stability', label: 'Stability AI' }], engine, v => { engine = v as any; refresh(); })),
    el('div', { class: 'form-row' }, el('label', {}, t('ai.scale')),
      select([{ value: '2', label: '2×' }, { value: '4', label: '4×' }], '2', v => { scale = +v as 2 | 4; refresh(); })),
    size, model, problem, cost, short, note);
  refresh();
  const dlg = openDialog({
    title: t('cmd.upscale'), body, width: 400,
    onOk: () => {
      // no key yet: the settings, and this window shows the price once one is given (before OK can send)
      if (engine !== 'local' && !hasKey(engine as Service)) {
        toast(t('ai.needKey', NAME[engine as Service]), 'error', 4000);
        aiSettingsDialog(refresh);
        return false;
      }
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
      // (no «Done»: the charge is said as it is made, with what is left)
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
    // (Cancel pressed after the last tile: a click waiting in the queue is taken first)
    await new Promise(r => setTimeout(r, 0));
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
  ui.note(costText('stability', STABILITY_PRICE.removeBg));
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
  // (the same request as background removal)
  ui.note(costText('stability', STABILITY_PRICE.removeBg));
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
  const sent = Math.max(sw, sh) / Math.min(sw, sh);
  if (ratio > o.maxRatio && sent > o.maxRatio) {
    // (the whole picture in the frame: it is the picture that is too long, a frame cannot help; as many
    // decimals as it takes, so that 2.51 or 2.5025 is not shown as the 2.5 that is allowed)
    let n = 2;
    while (n < 5 && sent.toFixed(n) === o.maxRatio.toFixed(n)) n++;
    const shown = sent.toFixed(n);
    return t(iw === W && ih === H ? 'ai.outpaintRatioWhole' : 'ai.outpaintRatio', shown.replace('.', t('num.dot')));
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
  ui.note(costText('stability', STABILITY_PRICE.outpaint));
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
