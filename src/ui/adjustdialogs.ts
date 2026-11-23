import { app } from '../app';
import { el, clamp, createCanvas, ctx2d } from '../core/util';
import { t } from '../i18n';
import { openDialog } from './dialog';
import { checkbox, select } from './controls';
import {
  AdjustSession, DetailCache, enhance, EnhanceParams, ENHANCE_DEFAULTS, autoEnhanceParams, applyLUTs, unsharp, addNoise,
} from '../core/adjust';
import { histogram, levelsLUT, curveLUT, composeLUT, gaussianBlur, clipPoints, Histogram } from '../core/filters';
import { keepAlpha } from '../core/fx';
import { runJob, FxJob } from '../core/fxjobs';
import { splitCompareTool } from '../tools/splitcompare';
import { EnhanceGPU } from '../core/gpuadjust';

/* ---------------- controls ---------------- */
export interface SliderSpec { key: string; label: string; min: number; max: number; def: number; step?: number; unit?: string }

export function sliderRow(spec: SliderSpec, value: number, onInput: (v: number) => void) {
  const range = el('input', { type: 'range', class: 'range' + (spec.min < 0 ? ' bipolar' : ''), min: spec.min, max: spec.max, step: spec.step ?? 1, value }) as HTMLInputElement;
  const val = el('input', { class: 'slider-val', value: String(value) + (spec.unit || '') }) as HTMLInputElement;
  const label = el('label', { title: t('adj.resetHint') }, spec.label);
  const set = (v: number) => { v = clamp(v, spec.min, spec.max); range.value = String(v); val.value = String(v) + (spec.unit || ''); onInput(v); };
  range.addEventListener('input', () => set(parseFloat(range.value)));
  val.addEventListener('change', () => { const v = parseFloat(val.value); if (!isNaN(v)) set(v); });
  val.addEventListener('keydown', e => e.stopPropagation());
  label.addEventListener('dblclick', () => set(spec.def));
  range.addEventListener('dblclick', () => set(spec.def));
  const row = el('div', { class: 'slider-row' }, label, val, range) as unknown as HTMLElement & { set(v: number): void };
  row.set = (v: number) => { range.value = String(v); val.value = String(v) + (spec.unit || ''); };
  return row;
}

/**
 * Common dialog with live preview over an AdjustSession. "Before / after" puts a draggable line on the
 * canvas (original on the left); `alpha` adds "Preserve transparency" for filters that spread pixels.
 */
/** Size of the draft preview of heavy filters (pixels): about what the screen shows of a whole photo. */
const DRAFT_PIXELS = 0.6e6;

type PixelFn = (src: Uint8ClampedArray, dst: Uint8ClampedArray) => void;

export function adjustDialog(opts: {
  title: string; body: HTMLElement; width?: number; label: string;
  compute: (s: AdjustSession) => PixelFn;
  onReady?: (s: AdjustSession, refresh: () => void) => void;
  extra?: HTMLElement[];
  alpha?: boolean;
  /**
   * The filter as a data job for the given size, with sizes in pixels scaled by k. On large layers this gives
   * a draft preview (the filter on a reduced copy, instantly) and the full-size result from a worker
   * once the sliders rest, so the dialog never freezes.
   */
  job?: (w: number, h: number, ox: number, oy: number, k: number) => FxJob;
}) {
  const s = AdjustSession.start();
  if (!s) return null;
  let previewOn = true;
  let keepA = opts.alpha ? !!app.settings.fltKeepAlpha : false;
  const withAlpha = (f: PixelFn): PixelFn => keepA ? (src, dst) => { f(src, dst); keepAlpha(src, dst); } : f;
  const fn = () => withAlpha(opts.compute(s));
  // `cur` is the function for the current settings; the session reuses its result while only the
  // before/after line moves
  let cur: PixelFn | null = null;
  /** Bumped on every settings change; worker results for older settings are dropped. */
  let gen = 0;

  /* ----- draft preview on a reduced copy ----- */
  const useDraft = !!opts.job && s.w * s.h > DRAFT_PIXELS * 1.8;
  // the draft size adapts so a heavy filter (radial blur) still answers within ~50 ms
  let draftPx = DRAFT_PIXELS, sw = 1, sh = 1;
  let smallSrc: ImageData | null = null, draftCanvas: HTMLCanvasElement | null = null, lastDraft: HTMLCanvasElement | null = null;
  let draftShown = false, fullTimer = 0;
  const makeDraft = () => {
    const t0 = performance.now();
    if (!draftCanvas || !smallSrc) {
      const k = Math.min(1, Math.sqrt(draftPx / (s.w * s.h)));
      sw = Math.max(1, Math.round(s.w * k)); sh = Math.max(1, Math.round(s.h * k));
      const big = createCanvas(s.w, s.h);
      ctx2d(big).putImageData(s.orig, 0, 0);
      draftCanvas = createCanvas(sw, sh);
      const g = ctx2d(draftCanvas);
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(big, 0, 0, sw, sh);
      smallSrc = g.getImageData(0, 0, sw, sh);
    }
    const out = new ImageData(sw, sh);
    runJob(opts.job!(sw, sh, s.ox * sw / s.w, s.oy * sh / s.h, sw / s.w), smallSrc.data, out.data, sw, sh);
    if (keepA) keepAlpha(smallSrc.data, out.data);
    ctx2d(draftCanvas).putImageData(out, 0, 0);
    const c = (lastDraft = draftCanvas);
    const ms = performance.now() - t0;
    const next = ms > 50 ? draftPx * 50 / ms : ms < 15 ? draftPx * 1.5 : draftPx;
    const clamped = Math.max(0.12e6, Math.min(DRAFT_PIXELS, next));
    if (Math.abs(clamped - draftPx) / draftPx > 0.25) { draftPx = clamped; draftCanvas = null; smallSrc = null; }
    return c;
  };

  /* ----- full-size result in a worker ----- */
  let worker: Worker | null = null, workerFailed = false, busy = false, inflight = -1;
  let queued: { id: number; job: FxJob } | null = null;
  let waitFull: ((ok: boolean) => void) | null = null;
  let haveFull = -1;   // gen of the full result shown
  const startWorker = () => {
    if (worker || workerFailed) return !!worker;
    try {
      worker = new Worker(new URL('../core/fxworker.ts', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'init', src: s.orig.data.slice(), w: s.w, h: s.h });
      worker.onmessage = (e: MessageEvent) => {
        busy = false; inflight = -1;
        if (queued) { const q = queued; queued = null; busy = true; inflight = q.id; worker!.postMessage({ type: 'run', ...q }); }
        const { id, dst } = e.data as { id: number; dst: Uint8ClampedArray };
        if (id !== gen || s.done) return;
        const f = withAlpha((_src, out) => out.set(dst));
        cur = f; haveFull = id; draftShown = false;
        if (previewOn) s.preview(f);
        waitFull?.(true); waitFull = null;
      };
      worker.onerror = () => { workerFailed = true; worker?.terminate(); worker = null; waitFull?.(false); waitFull = null; };
    } catch { workerFailed = true; worker = null; }
    return !!worker;
  };
  const runFull = () => {
    if (s.done) return;
    if (!startWorker()) { draftShown = false; if (previewOn) s.preview(cur ??= fn()); return; }
    if (inflight === gen || queued?.id === gen) return;   // already on its way
    const job = { id: gen, job: opts.job!(s.w, s.h, s.ox, s.oy, 1) };
    if (busy) { queued = job; return; }
    busy = true; inflight = gen;
    worker!.postMessage({ type: 'run', ...job });
  };

  const refresh = () => {
    cur = fn(); gen++;
    if (!previewOn) return;
    if (!useDraft) { s.preview(cur); return; }
    draftShown = true;
    s.previewDraft(makeDraft);
    clearTimeout(fullTimer);
    fullTimer = window.setTimeout(runFull, 250);
  };
  const refreshView = () => {
    if (!previewOn) return;
    if (draftShown && lastDraft) { const c = lastDraft; s.previewDraft(() => c); }
    else s.preview(cur ??= fn());
  };
  const prev = checkbox(t('adj.preview'), true, v => { previewOn = v; if (!v) s.restore(); else if (draftShown) refresh(); else refreshView(); });
  let splitOn = false;
  const endSplit = () => { if (!splitOn) return; splitOn = false; splitCompareTool.detach(); if (app.tool === splitCompareTool) app.popTool(); app.update('overlay'); };
  const split = checkbox(t('adj.beforeAfter'), false, v => {
    if (v) { splitOn = true; splitCompareTool.attach(s, refreshView); app.pushTool(splitCompareTool); }
    else endSplit();
    refreshView();
  });
  const rows: HTMLElement[] = [prev, split];
  if (opts.alpha) rows.push(checkbox(t('adj.keepAlpha'), keepA, v => { keepA = v; app.settings.fltKeepAlpha = v; app.saveSettings(); refresh(); }));
  opts.body.append(el('div', { class: 'adj-foot adj-foot-wrap' }, ...rows, ...(opts.extra || [])));
  const finish = () => { clearTimeout(fullTimer); worker?.terminate(); worker = null; endSplit(); };
  let committing = false;
  openDialog({
    title: opts.title, body: opts.body, width: opts.width || 340, side: true,
    onOk: async () => {
      if (committing) return false;
      committing = true;
      // the full result of the current settings is (or will shortly be) ready in the worker: use it
      if (useDraft && haveFull !== gen && startWorker()) {
        clearTimeout(fullTimer);
        document.body.classList.add('busy-cursor');
        const ok = await new Promise<boolean>(res => { waitFull = res; runFull(); });
        document.body.classList.remove('busy-cursor');
        if (!ok) cur = fn();
      }
      finish();
      s.commit(opts.label, cur ?? fn());
    },
    onCancel: () => { finish(); s.cancel(); },
  });
  opts.onReady?.(s, refresh);
  return { s, refresh };
}

/* ---------------- Enhance / Vignette ---------------- */
export function enhanceDialog(vignetteOnly = false) {
  const p: EnhanceParams = { ...ENHANCE_DEFAULTS };
  if (vignetteOnly) p.vignette = 40;
  const body = el('div', { class: 'adj' });
  const rows: { spec: SliderSpec; row: HTMLElement & { set(v: number): void } }[] = [];
  let refresh = () => {};
  const section = (title: string, specs: SliderSpec[]) => {
    body.append(el('div', { class: 'adj-section' }, title));
    for (const spec of specs) {
      const row = sliderRow(spec, (p as any)[spec.key], v => { (p as any)[spec.key] = v; refresh(); });
      rows.push({ spec, row });
      body.append(row);
    }
  };
  const S = (key: keyof EnhanceParams, min = -100, max = 100, def = 0): SliderSpec => ({ key, label: t('adj.' + key), min, max, def });
  if (!vignetteOnly) {
    section(t('adj.sec.light'), [S('brightness'), S('contrast'), S('highlights'), S('shadows'), S('whites'), S('blacks')]);
    section(t('adj.sec.color'), [S('saturation'), S('vibrance'), S('warmth'), S('tint'), S('skin'), S('hue', -180, 180)]);
    section(t('adj.sec.detail'), [S('sharpness', 0, 100), S('clarity', -100, 100), S('grain', 0, 100)]);
  }
  section(t('adj.sec.vignette'), [S('vignette'), S('vigMidpoint', 0, 100, 50), S('vigRoundness', -100, 100, 0), S('vigFeather', 0, 100, 50)]);
  const reset = el('button', { class: 'btn sm' }, t('adj.reset'));
  reset.addEventListener('click', () => {
    Object.assign(p, ENHANCE_DEFAULTS);
    if (vignetteOnly) p.vignette = 40;
    rows.forEach(r => r.row.set((p as any)[r.spec.key]));
    refresh();
  });
  // Auto: moves the light and colour sliders at once, like Camera Raw (detail and vignette stay as they are)
  const auto = el('button', { class: 'btn sm' }, t('adj.auto'));
  let session: AdjustSession | null = null;
  auto.addEventListener('click', () => {
    if (!session) return;
    Object.assign(p, autoEnhanceParams(session.orig.data, session.sel));
    rows.forEach(r => r.row.set((p as any)[r.spec.key]));
    refresh();
  });
  let cache: DetailCache;
  const res = adjustDialog({
    title: vignetteOnly ? t('cmd.vignette') : t('cmd.enhance'), body, width: 320,
    label: vignetteOnly ? 'cmd.vignette' : 'cmd.enhance',
    compute: s => (src, dst) => enhance(p, s, (cache ??= new DetailCache(s)), src, dst),
    onReady: s => {
      // the same maths on the GPU: smooth sliders even on large photos (CPU stays as the fallback)
      const gpu = EnhanceGPU.create(s);
      if (!gpu) return;
      const d = app.doc!;
      s.gpu = final => gpu.render(p, d.width, d.height, final ? null : s.split);
      s.onEnd = () => gpu.dispose();
    },
    extra: vignetteOnly ? [el('div', { style: { flex: '1' } }), reset] : [el('div', { style: { flex: '1' } }), auto, reset],
  });
  if (res) { refresh = res.refresh; session = res.s; if (vignetteOnly) refresh(); }
}

/* ---------------- histogram drawing ---------------- */
function drawHistogram(c: HTMLCanvasElement, h: Histogram, ch: 'rgb' | 'r' | 'g' | 'b', overlay?: (g: CanvasRenderingContext2D, W: number, H: number) => void) {
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth || 280, H = c.clientHeight || 110;
  c.width = W * dpr; c.height = H * dpr;
  const g = c.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const arr = ch === 'r' ? h.r : ch === 'g' ? h.g : ch === 'b' ? h.b : h.l;
  let max = 1;
  const sorted = [...arr].sort((a, b) => b - a);
  max = Math.max(1, sorted[2] || sorted[0]);
  g.fillStyle = ch === 'r' ? 'rgba(255,90,90,.75)' : ch === 'g' ? 'rgba(90,220,120,.75)' : ch === 'b' ? 'rgba(90,150,255,.8)' : 'rgba(220,220,225,.55)';
  g.beginPath();
  g.moveTo(0, H);
  for (let i = 0; i < 256; i++) g.lineTo((i / 255) * W, H - Math.min(1, arr[i] / max) * (H - 4));
  g.lineTo(W, H);
  g.fill();
  overlay?.(g, W, H);
}

/* ---------------- Levels ---------------- */
type Ch = 'rgb' | 'r' | 'g' | 'b';
interface LevelsCh { inB: number; inW: number; gamma: number; outB: number; outW: number }

export function levelsDialog() {
  const chs: Record<Ch, LevelsCh> = { rgb: def(), r: def(), g: def(), b: def() };
  function def(): LevelsCh { return { inB: 0, inW: 255, gamma: 1, outB: 0, outW: 255 }; }
  let ch: Ch = 'rgb';
  const hc = el('canvas', { class: 'hist-canvas' }) as HTMLCanvasElement;
  const inTrack = el('canvas', { class: 'lv-track' }) as HTMLCanvasElement;
  const outTrack = el('canvas', { class: 'lv-track' }) as HTMLCanvasElement;
  const info = el('div', { class: 'curve-info' });
  const outInfo = el('div', { class: 'curve-info' });
  let hist: Histogram;
  let refresh = () => {};
  const L = () => chs[ch];
  const drawTrack = (c: HTMLCanvasElement, handles: { v: number; color: string }[], gradient: boolean) => {
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth || 280, H = 16;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (gradient) { const gr = g.createLinearGradient(0, 0, W, 0); gr.addColorStop(0, '#000'); gr.addColorStop(1, '#fff'); g.fillStyle = gr; g.fillRect(0, 2, W, 4); }
    for (const h of handles) {
      const x = (h.v / 255) * W;
      g.beginPath(); g.moveTo(x, 6); g.lineTo(x - 5, 15); g.lineTo(x + 5, 15); g.closePath();
      g.fillStyle = h.color; g.fill(); g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1; g.stroke();
    }
  };
  const midPos = (l: LevelsCh) => l.inB + (l.inW - l.inB) * Math.pow(0.5, l.gamma);
  const redraw = () => {
    const l = L();
    drawHistogram(hc, hist, ch);
    drawTrack(inTrack, [{ v: l.inB, color: '#111' }, { v: midPos(l), color: '#888' }, { v: l.inW, color: '#fff' }], false);
    drawTrack(outTrack, [{ v: l.outB, color: '#111' }, { v: l.outW, color: '#fff' }], true);
    info.textContent = `${t('adj.input')}: ${Math.round(l.inB)}   ${l.gamma.toFixed(2)}   ${Math.round(l.inW)}`;
    outInfo.textContent = `${t('adj.output')}: ${Math.round(l.outB)}   ${Math.round(l.outW)}`;
  };
  const dragTrack = (c: HTMLCanvasElement, isIn: boolean) => {
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      const r = c.getBoundingClientRect();
      const l = L();
      const val = (ev: PointerEvent) => clamp(((ev.clientX - r.left) / r.width) * 255, 0, 255);
      const v0 = val(e);
      const cands = isIn ? [['inB', l.inB], ['mid', midPos(l)], ['inW', l.inW]] as const : [['outB', l.outB], ['outW', l.outW]] as const;
      let which = cands[0][0] as string, best = 1e9;
      for (const [k, v] of cands) if (Math.abs(v - v0) < best) { best = Math.abs(v - v0); which = k; }
      const move = (ev: PointerEvent) => {
        const v = val(ev);
        if (which === 'inB') l.inB = Math.min(v, l.inW - 2);
        else if (which === 'inW') l.inW = Math.max(v, l.inB + 2);
        else if (which === 'mid') { const tt = clamp((v - l.inB) / (l.inW - l.inB), 0.01, 0.99); l.gamma = clamp(Math.log(tt) / Math.log(0.5), 0.1, 9.99); }
        else if (which === 'outB') l.outB = v; else l.outW = v;
        redraw(); refresh();
      };
      move(e);
      const up = () => { c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); };
      c.addEventListener('pointermove', move); c.addEventListener('pointerup', up);
    });
  };
  dragTrack(inTrack, true); dragTrack(outTrack, false);
  const chSel = select<Ch>([{ value: 'rgb', label: 'RGB' }, { value: 'r', label: t('adj.red') }, { value: 'g', label: t('adj.green') }, { value: 'b', label: t('adj.blue') }], 'rgb', v => { ch = v; redraw(); });
  const autoBtn = el('button', { class: 'btn sm' }, t('adj.auto'));
  const body = el('div', { class: 'adj' }, el('div', { class: 'form-row' }, el('span', { class: 'muted' }, t('adj.channel')), chSel), hc, inTrack, info, el('div', { style: { height: '8px' } }), outTrack, outInfo);
  const lutFor = (l: LevelsCh) => levelsLUT(l.inB, l.inW, l.gamma, l.outB, l.outW);
  const res = adjustDialog({
    title: t('cmd.levels'), body, width: 320, label: 'cmd.levels',
    compute: () => (src, dst) => {
      const m = lutFor(chs.rgb);
      applyLUTs(src, dst, composeLUT(m, lutFor(chs.r)), composeLUT(m, lutFor(chs.g)), composeLUT(m, lutFor(chs.b)));
    },
    extra: [el('div', { style: { flex: '1' } }), autoBtn],
  });
  if (!res) return;
  refresh = res.refresh;
  hist = histogram(res.s.orig.data, res.s.sel);
  autoBtn.addEventListener('click', () => {
    for (const c of ['r', 'g', 'b'] as const) { const [lo, hi] = clipPoints(hist[c], hist.total, 0.001); chs[c] = { ...def(), inB: lo, inW: hi }; }
    chs.rgb = def();
    redraw(); refresh();
  });
  requestAnimationFrame(redraw);
}

/* ---------------- Curves ---------------- */
export function curvesDialog() {
  type Pt = { x: number; y: number };
  const curves: Record<Ch, Pt[]> = { rgb: base(), r: base(), g: base(), b: base() };
  function base(): Pt[] { return [{ x: 0, y: 0 }, { x: 255, y: 255 }]; }
  let ch: Ch = 'rgb';
  let sel = -1;
  const cv = el('canvas', { class: 'curves-canvas' }) as HTMLCanvasElement;
  const info = el('div', { class: 'curve-info' });
  let hist: Histogram;
  let refresh = () => {};
  const SZ = 280;
  const toPx = (p: Pt) => ({ x: (p.x / 255) * SZ, y: SZ - (p.y / 255) * SZ });
  const redraw = () => {
    const dpr = window.devicePixelRatio || 1;
    cv.width = SZ * dpr; cv.height = SZ * dpr;
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, SZ, SZ);
    // histogram
    const arr = ch === 'rgb' ? hist.l : hist[ch];
    const max = Math.max(1, [...arr].sort((a, b) => b - a)[2]);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.beginPath(); g.moveTo(0, SZ);
    for (let i = 0; i < 256; i++) g.lineTo((i / 255) * SZ, SZ - Math.min(1, arr[i] / max) * SZ * 0.9);
    g.lineTo(SZ, SZ); g.fill();
    // grid
    g.strokeStyle = 'rgba(255,255,255,0.1)'; g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < 4; i++) { const v = Math.round((i / 4) * SZ) + 0.5; g.moveTo(v, 0); g.lineTo(v, SZ); g.moveTo(0, v); g.lineTo(SZ, v); }
    g.stroke();
    g.beginPath(); g.moveTo(0, SZ); g.lineTo(SZ, 0); g.strokeStyle = 'rgba(255,255,255,0.18)'; g.stroke();
    // other channels faint
    const color = (c: Ch) => c === 'r' ? '#ff6b6b' : c === 'g' ? '#5cd68a' : c === 'b' ? '#6aa0ff' : '#f2f2f2';
    const drawCurve = (c: Ch, alpha: number) => {
      const lut = curveLUT(curves[c]);
      g.beginPath();
      for (let i = 0; i < 256; i++) { const x = (i / 255) * SZ, y = SZ - (lut[i] / 255) * SZ; i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.globalAlpha = alpha; g.strokeStyle = color(c); g.lineWidth = 1.5; g.stroke(); g.globalAlpha = 1;
    };
    for (const c of ['r', 'g', 'b', 'rgb'] as Ch[]) if (c !== ch && curves[c].length > 2 || (c !== ch && JSON.stringify(curves[c]) !== JSON.stringify(base()))) drawCurve(c, 0.35);
    drawCurve(ch, 1);
    curves[ch].forEach((p, i) => {
      const q = toPx(p);
      g.beginPath(); g.rect(q.x - 4, q.y - 4, 8, 8);
      g.fillStyle = i === sel ? '#fff' : 'rgba(30,30,30,1)'; g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke();
    });
    const sp = curves[ch][sel];
    info.textContent = sp ? `${t('adj.input')}: ${Math.round(sp.x)}   ${t('adj.output')}: ${Math.round(sp.y)}` : t('adj.curvesHint');
  };
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId);
    const r = cv.getBoundingClientRect();
    const pos = (ev: PointerEvent) => ({ x: clamp(((ev.clientX - r.left) / r.width) * 255, 0, 255), y: clamp((1 - (ev.clientY - r.top) / r.height) * 255, 0, 255), outside: ev.clientX < r.left - 20 || ev.clientX > r.right + 20 || ev.clientY < r.top - 20 || ev.clientY > r.bottom + 20 });
    const pts = curves[ch];
    const p0 = pos(e);
    let idx = pts.findIndex(p => Math.hypot((p.x - p0.x) / 255 * SZ, (p.y - p0.y) / 255 * SZ) < 9);
    if (idx < 0) { pts.push({ x: p0.x, y: p0.y }); pts.sort((a, b) => a.x - b.x); idx = pts.findIndex(p => p.x === p0.x && p.y === p0.y); }
    sel = idx;
    let removed = false;
    const move = (ev: PointerEvent) => {
      const p = pos(ev);
      const pt = pts[sel];
      if (!pt) return;
      const endpoint = sel === 0 || sel === pts.length - 1;
      if (p.outside && !endpoint && pts.length > 2) { if (!removed) { pts.splice(sel, 1); removed = true; sel = -1; } }
      else if (!removed) {
        const lo = sel > 0 ? pts[sel - 1].x + 1 : 0, hi = sel < pts.length - 1 ? pts[sel + 1].x - 1 : 255;
        pt.x = clamp(p.x, lo, hi); pt.y = p.y;
      }
      redraw(); refresh();
    };
    move(e);
    const up = () => { cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); };
    cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up);
  });
  cv.addEventListener('keydown', e => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel > 0 && sel < curves[ch].length - 1) { curves[ch].splice(sel, 1); sel = -1; redraw(); refresh(); e.stopPropagation(); }
  });
  cv.tabIndex = 0;
  const chSel = select<Ch>([{ value: 'rgb', label: 'RGB' }, { value: 'r', label: t('adj.red') }, { value: 'g', label: t('adj.green') }, { value: 'b', label: t('adj.blue') }], 'rgb', v => { ch = v; sel = -1; redraw(); });
  const reset = el('button', { class: 'btn sm' }, t('adj.reset'));
  reset.addEventListener('click', () => { curves.rgb = base(); curves.r = base(); curves.g = base(); curves.b = base(); sel = -1; redraw(); refresh(); });
  const body = el('div', { class: 'adj' }, el('div', { class: 'form-row' }, el('span', { class: 'muted' }, t('adj.channel')), chSel), cv, info);
  const res = adjustDialog({
    title: t('cmd.curves'), body, width: 320, label: 'cmd.curves',
    compute: () => (src, dst) => {
      const m = curveLUT(curves.rgb);
      applyLUTs(src, dst, composeLUT(m, curveLUT(curves.r)), composeLUT(m, curveLUT(curves.g)), composeLUT(m, curveLUT(curves.b)));
    },
    extra: [el('div', { style: { flex: '1' } }), reset],
  });
  if (!res) return;
  refresh = res.refresh;
  hist = histogram(res.s.orig.data, res.s.sel);
  redraw();
}

/* ---------------- Filters ---------------- */
export function gaussianDialog() {
  let radius = app.settings.gaussR ?? 4;
  let refresh = () => {};
  const body = el('div', { class: 'adj' }, sliderRow({ key: 'r', label: t('dlg.radius'), min: 0.1, max: 250, step: 0.1, def: 4, unit: ' px' }, radius, v => { radius = v; app.settings.gaussR = v; refresh(); }));
  const res = adjustDialog({
    title: t('cmd.gaussian'), body, label: 'cmd.gaussian', alpha: true,
    compute: s => (src, dst) => dst.set(gaussianBlur(src, s.w, s.h, radius)),
    job: (_w, _h, _ox, _oy, k) => ['gaussian', radius * k],
  });
  if (res) { refresh = res.refresh; refresh(); }
}

export function unsharpDialog() {
  const p = { amount: 100, radius: 1.5, threshold: 0 };
  let blurred: Uint8ClampedArray | null = null, blurredR = -1;
  let refresh = () => {};
  const body = el('div', { class: 'adj' },
    sliderRow({ key: 'a', label: t('adj.amount'), min: 1, max: 500, def: 100, unit: '%' }, p.amount, v => { p.amount = v; refresh(); }),
    sliderRow({ key: 'r', label: t('dlg.radius'), min: 0.1, max: 100, step: 0.1, def: 1.5, unit: ' px' }, p.radius, v => { p.radius = v; refresh(); }),
    sliderRow({ key: 't', label: t('adj.threshold'), min: 0, max: 255, def: 0 }, p.threshold, v => { p.threshold = v; refresh(); }));
  const res = adjustDialog({
    title: t('cmd.unsharp'), body, label: 'cmd.unsharp',
    compute: s => (src, dst) => {
      if (!blurred || blurredR !== p.radius) { blurred = gaussianBlur(src, s.w, s.h, p.radius); blurredR = p.radius; }
      unsharp(src, dst, blurred, p.amount, p.threshold);
    },
  });
  if (res) { refresh = res.refresh; refresh(); }
}

export function noiseDialog() {
  const p = { amount: 10, gaussian: true, mono: false };
  let refresh = () => {};
  const body = el('div', { class: 'adj' },
    sliderRow({ key: 'a', label: t('adj.amount'), min: 0.1, max: 100, step: 0.1, def: 10, unit: '%' }, p.amount, v => { p.amount = v; refresh(); }),
    el('div', { class: 'form-row' }, select([{ value: 'g', label: t('adj.gaussian') }, { value: 'u', label: t('adj.uniform') }], 'g', v => { p.gaussian = v === 'g'; refresh(); })),
    checkbox(t('adj.mono'), false, v => { p.mono = v; refresh(); }));
  const res = adjustDialog({
    title: t('cmd.noise'), body, label: 'cmd.noise',
    compute: () => (src, dst) => addNoise(src, dst, p.amount, p.gaussian, p.mono),
  });
  if (res) { refresh = res.refresh; refresh(); }
}
