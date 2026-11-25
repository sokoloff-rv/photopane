/**
 * Several adjustment and filter windows open at once, combined like a stack of corrections:
 * the layer as it was → the first window → the second window → … → the screen.
 *
 * - Every window is a stage. Changing a window recomputes the chain from that stage on; the outputs of
 *   the stages before it are kept, so the windows after it react as fast as on their own.
 * - A chain of only Adjust, Levels and Curves runs entirely on the GPU (smooth on large photos).
 *   With a heavy filter in the chain, large layers show a reduced draft while the sliders move and the
 *   full result (heavy filters in a worker) once they rest.
 * - OK writes a stage into the layer as its own history step as soon as every stage before it is done;
 *   until then it waits (the window closes, the picture stays the same). Cancel removes only its stage.
 * - Each stage is blended with the selection; the before/after line shows the layer as it was.
 */
import { app, PaintTarget } from '../app';
import type { Doc } from './document';
import { createCanvas, ctx2d, readPixels } from './util';
import { t } from '../i18n';
import { toast } from '../ui/dialog';
import { GpuChain, GpuStageDesc } from './gpuchain';
import { runJob, FxJob } from './fxjobs';
import { keepAlpha } from './fx';
import { splitCompareTool } from '../tools/splitcompare';

export type PixelFn = (src: Uint8ClampedArray, dst: Uint8ClampedArray) => void;

/** The pixels a stage works on: size and layer offset (k < 1 for the reduced draft, scaling sizes in px). */
export interface StageCtx { w: number; h: number; ox: number; oy: number; k: number }

export interface StageSpec {
  /** Command that opened the window (one window per command). */
  key: string;
  /** History label. */
  label: string;
  /** CPU computation for the current settings. */
  cpu: (c: StageCtx) => PixelFn;
  /** The current settings for the GPU (Adjust, Levels, Curves). */
  gpu?: () => GpuStageDesc;
  /** A heavy filter as a data job: draft preview on large layers, full result in a worker. */
  job?: (c: StageCtx) => FxJob;
  /** Preserve transparency (filters that have the option). */
  keepAlpha?: () => boolean;
}

let nextId = 1;
export class Stage {
  readonly id = nextId++;
  version = 0;
  /** OK was pressed; written into the layer once the stages before it are done. */
  frozen = false;
  constructor(readonly spec: StageSpec) {}
  get tag() { return `${this.id}.${this.version}`; }
}

/** Draft size for heavy filters (pixels): about what the screen shows of a whole photo. */
const DRAFT_PIXELS = 0.6e6;

/** dst = src + (dst − src)·selection (a stage only acts inside the selection). */
function blendSel(src: Uint8ClampedArray, dst: Uint8ClampedArray, sel: Uint8Array | null) {
  if (!sel) return;
  for (let i = 0, p = 0; i < dst.length; i += 4, p++) {
    const a = sel[p];
    if (a === 255) continue;
    if (a === 0) { dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; dst[i + 3] = src[i + 3]; continue; }
    const k = a / 255;
    dst[i] = src[i] + (dst[i] - src[i]) * k; dst[i + 1] = src[i + 1] + (dst[i + 1] - src[i + 1]) * k;
    dst[i + 2] = src[i + 2] + (dst[i + 2] - src[i + 2]) * k; dst[i + 3] = src[i + 3] + (dst[i + 3] - src[i + 3]) * k;
  }
}

export class AdjustChain {
  static current: AdjustChain | null = null;

  /** Add a window's stage to the chain (starting the chain on the active layer if there is none). */
  static join(spec: StageSpec): { chain: AdjustChain; stage: Stage } | null {
    let c = AdjustChain.current;
    if (!c) {
      const target = app.paintTarget();
      if (!target) return null;
      if (target.isMask) { toast(t('app.layerLocked')); return null; }
      c = AdjustChain.current = new AdjustChain(target);
    }
    const stage = new Stage(spec);
    c.stages.push(stage);
    return { chain: c, stage };
  }

  readonly target: PaintTarget;
  /** The document the chain works on (history steps go there even if another one became active). */
  readonly doc: Doc;
  readonly w: number; readonly h: number;
  /** document coordinates of the layer surface origin */
  readonly ox: number; readonly oy: number;
  /** The layer as committed so far (the chain input) and its cache key. */
  private base: Uint8ClampedArray;
  private baseKey = 'b';
  readonly sel: Uint8Array | null = null;
  readonly stages: Stage[] = [];
  /** Before/after line (document x), null = off. */
  split: number | null = null;

  private gpu: GpuChain | null | undefined;
  /** full-size output of each stage, valid for its key */
  private outs = new Map<number, { key: string; data: Uint8ClampedArray }>();
  private raf = 0;
  private fullTimer = 0;
  /** a full-size result is being computed; another one is wanted after it */
  private fullBusy = false;
  private fullAgain = false;
  /** bumped on every change; async results for older states are dropped */
  private gen = 0;
  private last: { kind: 'gpu' } | { kind: 'full'; data: Uint8ClampedArray } | { kind: 'draft'; canvas: HTMLCanvasElement } | null = null;
  private outImg: ImageData | null = null;
  private baseCanvas: HTMLCanvasElement | null = null;
  private draftPx = DRAFT_PIXELS;
  private draftBase: { key: string; w: number; h: number; data: Uint8ClampedArray; sel: Uint8Array | null } | null = null;
  private draftCanvas: HTMLCanvasElement | null = null;
  private worker: Worker | null = null;
  private workerFailed = false;
  private jobs = new Map<number, (d: Uint8ClampedArray | null) => void>();
  private jobId = 0;
  private settling: Promise<void> = Promise.resolve();
  private splitListeners = new Set<(on: boolean) => void>();

  private constructor(target: PaintTarget) {
    this.target = target;
    const d = this.doc = app.doc!;
    const s = target.surface;
    this.w = s.w; this.h = s.h; this.ox = s.x; this.oy = s.y;
    this.base = readPixels(s.canvas, 0, 0, s.w, s.h).data;
    if (d.selection) {
      const c = createCanvas(s.w, s.h);
      ctx2d(c).drawImage(d.selection.mask, -s.x, -s.y);
      const a = ctx2d(c).getImageData(0, 0, s.w, s.h).data;
      const sel = new Uint8Array(s.w * s.h);
      for (let i = 0; i < sel.length; i++) sel[i] = a[i * 4 + 3];
      this.sel = sel;
    }
  }

  /* ---------------- public ---------------- */

  /** A window's settings changed. */
  changed(stage: Stage) {
    stage.version++;
    this.gen++;
    this.request();
  }

  /** OK in a window: its stage is written into the layer once the stages before it are done. */
  ok(stage: Stage): Promise<void> {
    stage.frozen = true;
    return this.settle();
  }

  /**
   * Cancel in a window: only its stage goes away. Resolves once the windows after it that already had OK
   * are written (the cancelled window stays open until then, so the editor stays locked meanwhile).
   */
  cancel(stage: Stage): Promise<void> {
    const i = this.stages.indexOf(stage);
    if (i < 0) return Promise.resolve();
    this.stages.splice(i, 1);
    this.outs.delete(stage.id);
    this.gen++;
    return this.settle();
  }

  /**
   * Full-size input of a stage (what the earlier windows made of the layer), for Auto and histograms:
   * given at once when that is quick, else when the worker has computed the heavy filters before it.
   */
  inputOf(stage: Stage, use: (data: Uint8ClampedArray) => void) {
    const i = this.stages.indexOf(stage), n = i < 0 ? this.stages.length : i;
    const heavy = this.w * this.h > DRAFT_PIXELS * 1.8 &&
      this.stages.slice(0, n).some((s, j) => s.spec.job && this.outs.get(s.id)?.key !== this.keyAt(j));
    if (!heavy || !this.startWorker()) { use(this.computeSync(n)); return; }
    document.body.classList.add('busy-cursor');
    void this.computeAsync(n).then(d => {
      document.body.classList.remove('busy-cursor');
      if (d && AdjustChain.current === this) use(d);
    });
  }

  /** Before/after line on or off (shared by all windows). */
  setSplit(on: boolean) {
    if (on === (this.split != null)) return;
    if (on) { splitCompareTool.attach(this, () => this.refreshView()); app.pushTool(splitCompareTool); }
    else this.endSplit();
    this.splitListeners.forEach(f => f(on));
    this.refreshView();
  }

  /** Keep a window's before/after checkbox in step; returns the unsubscribe function. */
  onSplit(f: (on: boolean) => void) { this.splitListeners.add(f); return () => this.splitListeners.delete(f); }

  /* ---------------- rendering ---------------- */

  private request() {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  private ctx(k = 1, w = this.w, h = this.h): StageCtx { return { w, h, ox: this.ox * k, oy: this.oy * k, k }; }

  /** Cache key of the output of stage i (it depends on the base and every stage up to i). */
  private keyAt(i: number): string {
    let k = this.baseKey;
    for (let j = 0; j <= i; j++) k += '>' + this.stages[j].tag;
    return k;
  }

  private getGpu(): GpuChain | null {
    if (this.gpu === undefined) {
      this.gpu = GpuChain.create(this.w, this.h, this.ox, this.oy, this.sel);
      this.gpu?.setBase(this.base);
    }
    if (this.gpu && !this.gpu.ok) this.dropGpu();
    return this.gpu;
  }

  /** The GPU gave up (lost context, buffer too small): free it and go on with the CPU. */
  private dropGpu() {
    this.gpu?.dispose();
    this.gpu = null;
  }

  private splitCut(): number | null {
    return this.split == null ? null : Math.max(0, Math.min(this.w, Math.round(this.split - this.ox)));
  }

  private render() {
    if (AdjustChain.current !== this) return;
    if (!this.stages.length) { this.showData(this.base); return; }
    const doc = this.doc;
    // Adjust, Levels and Curves only: everything on the GPU
    if (this.stages.every(s => s.spec.gpu) && this.getGpu()) {
      const c = this.gpu!.display(this.stages.map((s, i) => ({ d: s.spec.gpu!(), key: this.keyAt(i) })), this.baseKey, this.splitCut(), doc.width, doc.height);
      if (c) { this.drawCanvas(c); this.last = { kind: 'gpu' }; return; }
      this.dropGpu();
    }
    const lastSt = this.stages[this.stages.length - 1];
    const hit = this.outs.get(lastSt.id);
    if (hit && hit.key === this.keyAt(this.stages.length - 1)) { this.showFull(hit.data); return; }
    // a heavy filter on a large layer: a draft now, the full result when the sliders rest
    if (this.stages.some(s => s.spec.job) && this.w * this.h > DRAFT_PIXELS * 1.8) {
      this.showDraft();
      clearTimeout(this.fullTimer);
      this.fullTimer = window.setTimeout(() => void this.runFull(), 250);
      return;
    }
    this.showFull(this.computeSync(this.stages.length));
  }

  /**
   * The full-size result once the sliders rest. Worker jobs cannot be stopped, so only one runs at a time:
   * a change meanwhile asks for one more run after it with the latest settings (not a queue of stale ones).
   */
  private async runFull() {
    if (this.fullBusy) { this.fullAgain = true; return; }
    this.fullBusy = true;
    try {
      do {
        this.fullAgain = false;
        const gen = this.gen;
        const data = await this.computeAsync(this.stages.length, gen);
        if (data && gen === this.gen && AdjustChain.current === this) this.showFull(data);
      } while (this.fullAgain && AdjustChain.current === this);
    } finally { this.fullBusy = false; }
  }

  /** Redraw after the before/after line moved, without recomputing. */
  private refreshView() {
    const l = this.last;
    if (!l || l.kind === 'gpu') this.request();
    else if (l.kind === 'full') this.showFull(l.data);
    else this.drawDraft(l.canvas);
  }

  private drawCanvas(c: HTMLCanvasElement, scaled = false) {
    const g = this.target.surface.ctx;
    g.save();
    g.globalCompositeOperation = 'copy';
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(c, 0, 0, this.w, this.h);
    g.restore();
    if (scaled) this.drawSplitFromBase();
    this.target.layer.touch();
    app.update('canvas');
  }

  /** The original left of the before/after line, on top of a drawn result. */
  private drawSplitFromBase() {
    const cut = this.splitCut();
    if (!cut) return;
    if (!this.baseCanvas) { this.baseCanvas = createCanvas(this.w, this.h); ctx2d(this.baseCanvas).putImageData(new ImageData(new Uint8ClampedArray(this.base), this.w, this.h), 0, 0); }
    const g = this.target.surface.ctx;
    g.save();
    g.globalCompositeOperation = 'copy';
    g.beginPath(); g.rect(0, 0, cut, this.h); g.clip();
    g.drawImage(this.baseCanvas, 0, 0);
    g.restore();
  }

  private showData(data: Uint8ClampedArray) {
    const out = (this.outImg ??= new ImageData(this.w, this.h));
    out.data.set(data);
    this.target.surface.ctx.putImageData(out, 0, 0);
    this.target.layer.touch();
    app.update('canvas');
  }

  private showFull(data: Uint8ClampedArray) {
    const out = (this.outImg ??= new ImageData(this.w, this.h));
    out.data.set(data);
    const cut = this.splitCut();
    if (cut) {
      const b = this.base, d = out.data;
      for (let y = 0; y < this.h; y++) { const r = y * this.w * 4; d.set(b.subarray(r, r + cut * 4), r); }
    }
    this.target.surface.ctx.putImageData(out, 0, 0);
    this.target.layer.touch();
    app.update('canvas');
    this.last = { kind: 'full', data };
  }

  /* ---------------- draft ---------------- */

  private showDraft() {
    const t0 = performance.now();
    const k = Math.min(1, Math.sqrt(this.draftPx / (this.w * this.h)));
    const sw = Math.max(1, Math.round(this.w * k)), sh = Math.max(1, Math.round(this.h * k));
    let db = this.draftBase;
    if (!db || db.key !== this.baseKey || db.w !== sw || db.h !== sh) {
      const big = createCanvas(this.w, this.h);
      ctx2d(big).putImageData(new ImageData(new Uint8ClampedArray(this.base), this.w, this.h), 0, 0);
      const small = createCanvas(sw, sh), g = ctx2d(small);
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(big, 0, 0, sw, sh);
      let sel: Uint8Array | null = null;
      if (this.sel) {
        const m = new ImageData(this.w, this.h);
        for (let i = 0; i < this.sel.length; i++) m.data[i * 4 + 3] = this.sel[i];
        ctx2d(big).putImageData(m, 0, 0);
        const sc = createCanvas(sw, sh), sg = ctx2d(sc);
        sg.imageSmoothingEnabled = true; sg.imageSmoothingQuality = 'high';
        sg.drawImage(big, 0, 0, sw, sh);
        const a = sg.getImageData(0, 0, sw, sh).data;
        sel = new Uint8Array(sw * sh);
        for (let i = 0; i < sel.length; i++) sel[i] = a[i * 4 + 3];
      }
      db = this.draftBase = { key: this.baseKey, w: sw, h: sh, data: g.getImageData(0, 0, sw, sh).data, sel };
    }
    const c = this.ctx(sw / this.w, sw, sh);
    let cur = db.data;
    for (const st of this.stages) {
      const out = new Uint8ClampedArray(cur.length);
      if (st.spec.job) runJob(st.spec.job(c), cur, out, sw, sh); else st.spec.cpu(c)(cur, out);
      if (st.spec.keepAlpha?.()) keepAlpha(cur, out);
      blendSel(cur, out, db.sel);
      cur = out;
    }
    const canvas = (this.draftCanvas = createCanvas(sw, sh));
    ctx2d(canvas).putImageData(new ImageData(cur as Uint8ClampedArray<ArrayBuffer>, sw, sh), 0, 0);
    this.drawDraft(canvas);
    // keep drafts near 50 ms whatever the filters cost
    const ms = performance.now() - t0;
    const next = ms > 50 ? this.draftPx * 50 / ms : ms < 15 ? this.draftPx * 1.5 : this.draftPx;
    this.draftPx = Math.max(0.12e6, Math.min(DRAFT_PIXELS, next));
  }

  private drawDraft(canvas: HTMLCanvasElement) {
    this.drawCanvas(canvas, true);
    this.last = { kind: 'draft', canvas };
  }

  /* ---------------- full-size computation ---------------- */

  /** One stage at full size on the main thread (GPU when it has a GPU form). */
  private stageSync(st: Stage, input: Uint8ClampedArray): Uint8ClampedArray {
    if (st.spec.gpu && this.getGpu()) {
      const r = this.gpu!.run(st.spec.gpu(), input, this.doc.width, this.doc.height);
      if (r) return r;
      this.dropGpu();
    }
    const out = new Uint8ClampedArray(input.length);
    const c = this.ctx();
    if (st.spec.job) runJob(st.spec.job(c), input, out, this.w, this.h); else st.spec.cpu(c)(input, out);
    return this.finish(st, input, out);
  }

  private finish(st: Stage, input: Uint8ClampedArray, out: Uint8ClampedArray) {
    if (st.spec.keepAlpha?.()) keepAlpha(input, out);
    blendSel(input, out, this.sel);
    return out;
  }

  /** Output of the first n stages (n = 0: the base), computed now. */
  private computeSync(n: number): Uint8ClampedArray {
    let input = this.base;
    for (let i = 0; i < n; i++) {
      const st = this.stages[i], key = this.keyAt(i);
      const hit = this.outs.get(st.id);
      if (hit && hit.key === key) { input = hit.data; continue; }
      input = this.stageSync(st, input);
      this.outs.set(st.id, { key, data: input });
    }
    return input;
  }

  /** Output of the first n stages, heavy filters in the worker; null if the chain changed meanwhile. */
  private async computeAsync(n: number, gen?: number): Promise<Uint8ClampedArray | null> {
    let input = this.base;
    for (let i = 0; i < n; i++) {
      const st = this.stages[i], key = this.keyAt(i);
      const hit = this.outs.get(st.id);
      if (hit && hit.key === key) { input = hit.data; continue; }
      let out: Uint8ClampedArray | null = null;
      if (st.spec.job && this.startWorker()) {
        const raw = await this.inWorker(st.spec.job(this.ctx()), input);
        if (AdjustChain.current !== this || this.stages[i] !== st || this.keyAt(i) !== key) return null;
        if (raw) out = this.finish(st, input, raw);
        // still valid for this stage even if a later window moved meanwhile: kept, not computed again
        if (out) this.outs.set(st.id, { key, data: out });
        if (gen !== undefined && gen !== this.gen) return null;
      }
      input = out ?? this.stageSync(st, input);
      this.outs.set(st.id, { key, data: input });
    }
    return input;
  }

  private startWorker(): boolean {
    if (this.worker || this.workerFailed) return !!this.worker;
    try {
      const w = new Worker(new URL('./fxworker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent) => {
        const { id, dst } = e.data as { id: number; dst: Uint8ClampedArray };
        this.jobs.get(id)?.(dst);
        this.jobs.delete(id);
      };
      w.onerror = () => {
        this.workerFailed = true; w.terminate(); this.worker = null;
        this.jobs.forEach(r => r(null)); this.jobs.clear();
      };
      this.worker = w;
    } catch { this.workerFailed = true; }
    return !!this.worker;
  }

  private inWorker(job: FxJob, input: Uint8ClampedArray): Promise<Uint8ClampedArray | null> {
    return new Promise(res => {
      const id = ++this.jobId;
      this.jobs.set(id, res);
      const src = input.slice();
      this.worker!.postMessage({ id, job, src, w: this.w, h: this.h }, [src.buffer]);
    });
  }

  /* ---------------- committing ---------------- */

  /** Write the finished stages at the front of the chain into the layer, one history step each. */
  private settle(): Promise<void> {
    this.settling = this.settling.then(async () => {
      while (this.stages.length && this.stages[0].frozen) {
        const st = this.stages[0];
        document.body.classList.add('busy-cursor');
        let data: Uint8ClampedArray | null;
        try { data = await this.computeAsync(1); }
        finally { document.body.classList.remove('busy-cursor'); }
        if (this.stages[0] !== st) continue;   // the chain changed while it was computed
        data ??= this.computeSync(1);
        const s = this.target.surface;
        s.ctx.putImageData(new ImageData(new Uint8ClampedArray(data), this.w, this.h), 0, 0);
        this.target.layer.touch();
        s.markDirty();
        app.commit(st.spec.label, this.doc);
        // the chain now starts from the committed layer; later stages keep their cached results
        this.baseKey = this.keyAt(0);
        this.base = data;
        this.stages.shift();
        this.outs.delete(st.id);
        this.gpu?.setBase(data);
        this.baseCanvas = null;
      }
      if (!this.stages.length) this.end();
      else { this.gen++; this.request(); }
    }).catch(err => {
      // keep the chain usable (later OK and Cancel still work) and say what went wrong
      console.error(err);
      toast(`${t('app.error')}: ${err?.message || err}`, 'error', 5000);
    });
    return this.settling;
  }

  private endSplit() {
    splitCompareTool.detach();
    if (app.tool === splitCompareTool) app.popTool();
    app.update('overlay');
  }

  private end() {
    if (AdjustChain.current !== this) return;
    AdjustChain.current = null;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.fullTimer);
    if (this.split != null) this.endSplit();
    this.showData(this.base);
    this.gpu?.dispose();
    this.worker?.terminate();
    this.jobs.forEach(r => r(null));
    this.outs.clear();
  }
}
