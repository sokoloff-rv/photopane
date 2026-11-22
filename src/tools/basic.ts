import { app } from '../app';
import { t } from '../i18n';
import { Tool, PEvent } from './tool';
import { Layer } from '../core/layer';
import { Selection } from '../core/selection';
import { createCanvas, ctx2d, cloneCanvas, alphaBounds } from '../core/util';
import { css, RGB } from '../core/color';
import { floodMask, coverageToImageData } from '../core/fill';
import { previews } from '../core/render';
import { numberField, checkbox, segmented, select, sep } from '../ui/controls';
import { applyBuffer, sampleColor } from './paint';
import { snap45 } from './select';
import { iconCursor, arrowBadgeCursor } from '../ui/icons';
import { collectTargets, snapRect, clearSmart, Targets, snapEnabled } from '../core/snap';
import { layerBounds } from '../core/ops';
import { iconButton } from '../ui/controls';
import { Rect } from '../core/util';

/* ---------------- Move ---------------- */
interface MoveOpts { autoSelect: boolean }

/** All surfaces that move with a layer (content + masks, recursively for groups). */
function movable(l: Layer): { s: { x: number; y: number }; x: number; y: number }[] {
  const out: { s: { x: number; y: number }; x: number; y: number }[] = [];
  const add = (n: Layer) => {
    if (!n.isGroup) out.push({ s: n.content, x: n.content.x, y: n.content.y });
    if (n.text) {
      const tx = n.text;
      out.push({ s: { get x() { return tx.ax; }, set x(v: number) { tx.ax = v; }, get y() { return tx.ay; }, set y(v: number) { tx.ay = v; } }, x: tx.ax, y: tx.ay });
    }
    if (n.mask) out.push({ s: n.mask, x: n.mask.x, y: n.mask.y });
    n.children.forEach(add);
  };
  add(l);
  return out;
}

export function pickLayerAt(x: number, y: number): Layer | null {
  const d = app.doc!;
  const all = d.layers.filter(l => !l.isGroup && l.effectiveVisible).reverse();
  for (const l of all) {
    const lx = Math.floor(x - l.x), ly = Math.floor(y - l.y);
    if (lx < 0 || ly < 0 || lx >= l.canvas.width || ly >= l.canvas.height) continue;
    const a = ctx2d(l.canvas).getImageData(lx, ly, 1, 1).data[3];
    if (a > 10) return l;
  }
  return null;
}

export class MoveTool extends Tool<MoveOpts> {
  readonly id = 'move';
  readonly iconName = 'move';
  readonly key = 'V';
  cursor = 'default';
  private start: { x: number; y: number } | null = null;
  private items: ReturnType<typeof movable> = [];
  private float: { canvas: HTMLCanvasElement; x: number; y: number; layer: Layer; sel: Selection } | null = null;
  private moved = false;
  private startBounds: Rect | null = null;
  private targets: Targets | null = null;

  constructor() { super({ autoSelect: false }); }

  down(e: PEvent) {
    const d = app.doc!;
    if (this.o.autoSelect || e.ctrl) {
      const hit = pickLayerAt(e.x, e.y);
      if (hit && hit.id !== d.activeId) { d.setActive(hit); app.layersPanel.clearMulti(); app.update('layers'); }
    }
    const l = d.active;
    if (!l) return;
    this.start = { x: e.x, y: e.y };
    this.moved = false;
    if (d.selection && !l.isGroup && !(d.editMask && l.mask)) {
      // move selected pixels: lift them into a floating piece
      const sel = d.selection;
      const b = sel.bounds;
      const fc = createCanvas(b.w, b.h);
      const g = ctx2d(fc);
      g.drawImage(l.canvas, l.x - b.x, l.y - b.y);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(sel.mask, -b.x, -b.y);
      if (e.alt) {
        // Alt+drag duplicates selection contents (layer stays intact)
      } else {
        const lg = l.content.ctx;
        lg.globalCompositeOperation = 'destination-out';
        lg.drawImage(sel.mask, -l.x, -l.y);
        lg.globalCompositeOperation = 'source-over';
      }
      this.float = { canvas: fc, x: b.x, y: b.y, layer: l, sel };
      l.content.markDirtyDoc(b);
      this.items = [];
      const ab = alphaBounds(fc);
      this.startBounds = ab ? { x: b.x + ab.x, y: b.y + ab.y, w: ab.w, h: ab.h } : null;
    } else {
      this.items = movable(l);
      this.startBounds = e.button >= 0 && snapEnabled() ? layerBounds(l) : null;
    }
    this.targets = this.startBounds ? collectTargets(new Set([l]), true) : null;
  }

  move(e: PEvent) {
    if (!this.start) return;
    let dx = Math.round(e.x - this.start.x), dy = Math.round(e.y - this.start.y);
    if (e.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    if (this.startBounds && this.targets && !e.ctrl) {
      const b = this.startBounds;
      const s = snapRect({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, this.targets);
      if (!(e.shift && dx === 0)) dx += Math.round(s.dx);
      if (!(e.shift && dy === 0)) dy += Math.round(s.dy);
    }
    if (dx || dy) this.moved = true;
    this.apply(dx, dy);
  }

  private apply(dx: number, dy: number) {
    if (this.float) {
      const f = this.float;
      const l = f.layer;
      previews.set(l.id, g => {
        g.drawImage(l.canvas, l.x, l.y);
        g.drawImage(f.canvas, f.x + dx, f.y + dy);
      });
      app.selOffset = { x: dx, y: dy };
      (this as any)._d = { dx, dy };
    } else {
      for (const it of this.items) { it.s.x = it.x + dx; it.s.y = it.y + dy; }
      app.doc!.active?.touch();
    }
    app.update('canvas');
  }

  up() {
    if (!this.start) return;
    this.start = null;
    clearSmart();
    const d = app.doc!;
    if (this.float) {
      const f = this.float;
      const { dx, dy } = (this as any)._d || { dx: 0, dy: 0 };
      previews.delete(f.layer.id);
      app.selOffset = { x: 0, y: 0 };
      const nx = f.x + dx, ny = f.y + dy;
      f.layer.content.ensureCovers({ x: nx, y: ny, w: f.canvas.width, h: f.canvas.height });
      const lg = f.layer.content.ctx;
      lg.drawImage(f.canvas, nx - f.layer.x, ny - f.layer.y);
      f.layer.content.markDirtyDoc({ x: nx, y: ny, w: f.canvas.width, h: f.canvas.height });
      f.layer.content.markDirtyDoc({ x: f.x, y: f.y, w: f.canvas.width, h: f.canvas.height });
      f.layer.touch();
      if (dx || dy) {
        const m = createCanvas(d.width, d.height);
        ctx2d(m).drawImage(f.sel.mask, dx, dy);
        d.selection = Selection.fromMask(m);
      }
      this.float = null;
      (this as any)._d = null;
      app.commit('h.move');
    } else if (this.moved) app.commit('h.move');
    app.update('canvas', 'overlay');
  }

  cancel() {
    if (this.float) {
      const f = this.float;
      previews.delete(f.layer.id);
      app.selOffset = { x: 0, y: 0 };
      f.layer.content.ctx.drawImage(f.canvas, f.x - f.layer.x, f.y - f.layer.y);
      this.float = null;
    } else for (const it of this.items) { it.s.x = it.x; it.s.y = it.y; }
    this.start = null;
    app.update('canvas', 'overlay');
  }

  busy() { return !!this.start; }

  keydown(e: KeyboardEvent) {
    const k = e.key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k) || e.ctrlKey) return false;
    const d = app.doc;
    if (!d?.active) return false;
    const n = e.shiftKey ? 10 : 1;
    const dx = k === 'ArrowLeft' ? -n : k === 'ArrowRight' ? n : 0;
    const dy = k === 'ArrowUp' ? -n : k === 'ArrowDown' ? n : 0;
    this.down({ x: 0, y: 0, sx: 0, sy: 0, shift: false, alt: false, ctrl: false, button: -1, pressure: 1, pen: false });
    this.startBounds = null; this.targets = null;
    this.moved = true;
    this.apply(dx, dy);
    this.up();
    return true;
  }

  options() {
    const al = (k: AlignKind, ico: string, key: string) => iconButton(ico, t(key), () => alignLayers(k));
    return [
      checkbox(t('opt.autoSelect'), this.o.autoSelect, v => this.set('autoSelect', v)),
      sep(),
      al('left', 'layAlignL', 'opt.alLeft'), al('cx', 'layAlignCX', 'opt.alCX'), al('right', 'layAlignR', 'opt.alRight'),
      al('top', 'layAlignT', 'opt.alTop'), al('cy', 'layAlignCY', 'opt.alCY'), al('bottom', 'layAlignB', 'opt.alBottom'),
      sep(),
      el2span(t('opt.layerGroup')),
      cmdBtn('rotateLayerCCW', 'rotCCW'), cmdBtn('rotateLayerCW', 'rotCW'), cmdBtn('rotateLayer180', 'rot180'),
      cmdBtn('flipLayerH', 'flipH'), cmdBtn('flipLayerV', 'flipV'),
      sep(),
      el2span(t('opt.canvasGroup')),
      cmdBtn('rotCCW', 'rotCCW'), cmdBtn('rotCW', 'rotCW'), cmdBtn('rot180', 'rot180'), cmdBtn('rotArbitrary', 'rotAny'),
      cmdBtn('flipCanvasH', 'canvasFlipH'), cmdBtn('flipCanvasV', 'canvasFlipV'),
    ];
  }
}

/** Icon button running a registered command; tooltip = command name. */
function cmdBtn(cmd: string, ico: string) {
  const c = app.commands.get(cmd);
  let title = t('cmd.' + cmd).replace('…', '');
  if (cmd.startsWith('rot') && !cmd.includes('Layer')) title = `${t('cmd.rotation')}: ${title}`;
  const b = iconButton(ico, title, () => app.run(cmd));
  if (c?.enabled && !c.enabled()) b.disabled = true;
  return b;
}

type AlignKind = 'left' | 'cx' | 'right' | 'top' | 'cy' | 'bottom';

/** Align selected layers to the selection, to each other (several layers) or to the canvas. */
export function alignLayers(kind: AlignKind) {
  const d = app.doc;
  if (!d) return;
  const layers = app.layersPanel.selected();
  const bounds = layers.map(l => layerBounds(l));
  let ref: Rect;
  if (d.selection) ref = d.selection.bounds;
  else if (layers.length > 1) {
    const bs = bounds.filter(Boolean) as Rect[];
    if (!bs.length) return;
    const x0 = Math.min(...bs.map(b => b.x)), y0 = Math.min(...bs.map(b => b.y));
    ref = { x: x0, y: y0, w: Math.max(...bs.map(b => b.x + b.w)) - x0, h: Math.max(...bs.map(b => b.y + b.h)) - y0 };
  } else ref = { x: 0, y: 0, w: d.width, h: d.height };
  let changed = false;
  layers.forEach((l, i) => {
    const b = bounds[i];
    if (!b) return;
    let dx = 0, dy = 0;
    if (kind === 'left') dx = ref.x - b.x;
    if (kind === 'cx') dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
    if (kind === 'right') dx = ref.x + ref.w - (b.x + b.w);
    if (kind === 'top') dy = ref.y - b.y;
    if (kind === 'cy') dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
    if (kind === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
    dx = Math.round(dx); dy = Math.round(dy);
    if (!dx && !dy) return;
    for (const it of movable(l)) { it.s.x = it.x + dx; it.s.y = it.y + dy; }
    l.touch();
    changed = true;
  });
  if (changed) app.commit('h.align');
}

/* ---------------- Hand ---------------- */
export class HandTool extends Tool {
  readonly id = 'hand';
  readonly iconName = 'hand';
  readonly key = 'H';
  cursor = 'grab';
  constructor() { super({}); }
  options() {
    return [
      el2('button', 'btn sm', t('cmd.actual'), () => app.run('actual')),
      el2('button', 'btn sm', t('cmd.fit'), () => app.run('fit')),
    ];
  }
}

function el2(tag: string, cls: string, text: string, onClick: () => void) {
  const b = document.createElement(tag);
  b.className = cls; b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

/* ---------------- Eyedropper ---------------- */
interface EyeOpts { sample: number; allLayers: boolean }

export class EyedropperTool extends Tool<EyeOpts> {
  readonly id = 'eyedropper';
  readonly iconName = 'eyedropper';
  readonly key = 'I';
  cursor = iconCursor('eyedropper', 2, 22);
  private active = false;
  private which: 'fg' | 'bg' = 'fg';
  private preview: RGB | null = null;
  constructor() { super({ sample: 1, allLayers: true }); }

  down(e: PEvent) { this.active = true; this.which = e.alt ? 'bg' : 'fg'; this.pick(e); }
  move(e: PEvent) { if (this.active) this.pick(e); }
  up() { this.active = false; this.preview = null; app.update('overlay'); }

  private pick(e: PEvent) {
    const c = sampleColor(e.x, e.y, this.o.sample, this.o.allLayers);
    if (c) { app.setColor(this.which, c); this.preview = c; }
  }

  overlay(g: CanvasRenderingContext2D) {
    if (!this.active || !this.preview) return;
    const { sx, sy } = app.viewport.pointer;
    g.save();
    g.lineWidth = 14;
    g.beginPath(); g.arc(sx, sy, 34, -Math.PI / 2, Math.PI / 2); g.strokeStyle = css(this.preview); g.stroke();
    g.beginPath(); g.arc(sx, sy, 34, Math.PI / 2, Math.PI * 1.5); g.strokeStyle = css(this.which === 'fg' ? app.bg : app.fg); g.stroke();
    g.lineWidth = 1; g.strokeStyle = 'rgba(0,0,0,.4)';
    g.beginPath(); g.arc(sx, sy, 41, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(sx, sy, 27, 0, Math.PI * 2); g.stroke();
    g.restore();
  }

  options() {
    return [
      el2span(t('opt.sample') + ':'),
      select([{ value: '1', label: t('opt.point') }, { value: '3', label: t('opt.avg3') }, { value: '5', label: t('opt.avg5') }], String(this.o.sample) as any,
        v => this.set('sample', parseInt(v))),
      select([{ value: 'all', label: t('opt.allLayers') }, { value: 'cur', label: t('opt.currentLayer') }], this.o.allLayers ? 'all' : 'cur',
        v => this.set('allLayers', v === 'all')),
    ];
  }
}

function el2span(text: string) { const s = document.createElement('span'); s.className = 'muted sm'; s.textContent = text; return s; }

/* ---------------- Paint bucket ---------------- */
interface BucketOpts { tolerance: number; contiguous: boolean; allLayers: boolean; antialias: boolean; opacity: number }

export class BucketTool extends Tool<BucketOpts> {
  readonly id = 'bucket';
  readonly iconName = 'bucket';
  readonly key = 'G';
  cursor = arrowBadgeCursor('bucket');
  constructor() { super({ tolerance: 32, contiguous: true, allLayers: false, antialias: true, opacity: 100 }); }

  down(e: PEvent) {
    const d = app.doc!;
    const target = app.paintTarget();
    if (!target) return;
    if (e.x < 0 || e.y < 0 || e.x >= d.width || e.y >= d.height) return;
    let img: ImageData;
    if (this.o.allLayers || target.isMask) img = ctx2d(d.composite()).getImageData(0, 0, d.width, d.height);
    else img = d.layerImageData(target.layer);
    const cov = floodMask(img, e.x, e.y, this.o.tolerance, this.o.contiguous, this.o.antialias);
    const buf = createCanvas(d.width, d.height);
    ctx2d(buf).putImageData(coverageToImageData(cov, d.width, d.height, app.fg.r, app.fg.g, app.fg.b), 0, 0);
    applyBuffer(target, buf, 0, 0, this.o.opacity / 100, app.fg);
    target.surface.markDirtyDoc({ x: 0, y: 0, w: d.width, h: d.height });
    app.commit('h.bucket');
  }

  options() {
    return [
      numberField({ label: t('opt.opacity'), value: this.o.opacity, min: 1, max: 100, unit: '%', onChange: v => this.set('opacity', v) }),
      numberField({ label: t('opt.tolerance'), value: this.o.tolerance, min: 0, max: 255, onChange: v => this.set('tolerance', v) }),
      sep(),
      checkbox(t('opt.antialias'), this.o.antialias, v => this.set('antialias', v)),
      checkbox(t('opt.contiguous'), this.o.contiguous, v => this.set('contiguous', v)),
      checkbox(t('opt.allLayers'), this.o.allLayers, v => this.set('allLayers', v)),
    ];
  }
}

/* ---------------- Gradient ---------------- */
interface GradOpts { type: 'linear' | 'radial'; colors: 'fgbg' | 'fgtr'; reverse: boolean; opacity: number }

export class GradientTool extends Tool<GradOpts> {
  readonly id = 'gradient';
  readonly iconName = 'gradient';
  readonly key = 'G';
  private a: { x: number; y: number } | null = null;
  private b: { x: number; y: number } | null = null;
  private backup: HTMLCanvasElement | null = null;
  private target: ReturnType<typeof app.paintTarget> = null;

  constructor() { super({ type: 'linear', colors: 'fgbg', reverse: false, opacity: 100 }); }

  down(e: PEvent) {
    this.target = app.paintTarget();
    if (!this.target) return;
    const d = app.doc!;
    this.target.surface.ensureCovers({ x: 0, y: 0, w: d.width, h: d.height });
    this.backup = cloneCanvas(this.target.surface.canvas);
    this.a = { x: e.x, y: e.y };
    this.b = { x: e.x, y: e.y };
  }

  move(e: PEvent) {
    if (!this.a) return;
    this.b = e.shift ? snap45(this.a, { x: e.x, y: e.y }) : { x: e.x, y: e.y };
    this.render();
  }

  private render() {
    const d = app.doc!, a = this.a!, b = this.b!, tg = this.target!;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1) return;
    const buf = createCanvas(d.width, d.height);
    const g = ctx2d(buf);
    const gr = this.o.type === 'linear'
      ? g.createLinearGradient(a.x, a.y, b.x, b.y)
      : g.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.hypot(b.x - a.x, b.y - a.y));
    let c0 = css(app.fg), c1 = this.o.colors === 'fgbg' ? css(app.bg) : css(app.fg, 0);
    if (tg.isMask) {
      // masks: encode gray as alpha of white
      const g0 = (app.fg.r * 0.299 + app.fg.g * 0.587 + app.fg.b * 0.114) / 255;
      const g1 = this.o.colors === 'fgbg' ? (app.bg.r * 0.299 + app.bg.g * 0.587 + app.bg.b * 0.114) / 255 : 0;
      c0 = `rgba(255,255,255,${g0})`; c1 = `rgba(255,255,255,${g1})`;
      if (this.o.colors === 'fgtr') c1 = 'rgba(255,255,255,0)';
    }
    if (this.o.reverse) [c0, c1] = [c1, c0];
    gr.addColorStop(0, c0); gr.addColorStop(1, c1);
    g.fillStyle = gr;
    g.fillRect(0, 0, d.width, d.height);
    if (tg.isMask) {
      // replace mask values within selection
      const s = tg.surface, sg = s.ctx;
      sg.globalCompositeOperation = 'copy'; sg.drawImage(this.backup!, 0, 0); sg.globalCompositeOperation = 'source-over';
      const cut = createCanvas(d.width, d.height), cg = ctx2d(cut);
      cg.fillStyle = '#fff'; cg.fillRect(0, 0, d.width, d.height);
      if (d.selection) { cg.globalCompositeOperation = 'destination-in'; cg.drawImage(d.selection.mask, 0, 0); }
      sg.globalAlpha = this.o.opacity / 100;
      sg.globalCompositeOperation = 'destination-out'; sg.drawImage(cut, -s.x, -s.y);
      if (d.selection) { g.globalCompositeOperation = 'destination-in'; g.drawImage(d.selection.mask, 0, 0); }
      sg.globalCompositeOperation = 'source-over'; sg.drawImage(buf, -s.x, -s.y);
      sg.globalAlpha = 1;
      tg.layer.touch();
    } else applyBuffer(tg, buf, 0, 0, this.o.opacity / 100, app.fg, this.backup!);
    app.update('canvas');
  }

  up() {
    if (!this.a) return;
    const moved = this.b && Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y) >= 1;
    this.a = null;
    if (moved && this.target) {
      const d = app.doc!;
      this.target.surface.markDirtyDoc({ x: 0, y: 0, w: d.width, h: d.height });
      app.commit('h.gradient');
    }
    this.backup = null;
    app.update('overlay');
  }

  cancel() {
    if (this.a && this.backup && this.target) {
      const g = this.target.surface.ctx;
      g.globalCompositeOperation = 'copy'; g.drawImage(this.backup, 0, 0); g.globalCompositeOperation = 'source-over';
      this.target.layer.touch();
      app.update('canvas');
    }
    this.a = null;
  }

  busy() { return !!this.a; }

  overlay(g: CanvasRenderingContext2D) {
    if (!this.a || !this.b) return;
    const v = app.viewport;
    const a = v.toScreen(this.a.x, this.a.y), b = v.toScreen(this.b.x, this.b.y);
    g.save();
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.5)';
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    g.lineWidth = 1.5; g.strokeStyle = '#fff'; g.stroke();
    for (const p of [a, b]) { g.beginPath(); g.arc(p.x, p.y, 4, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1; g.stroke(); }
    g.restore();
  }

  options() {
    return [
      segmented<'linear' | 'radial'>([
        { value: 'linear', label: t('opt.linear'), title: t('opt.linear') },
        { value: 'radial', label: t('opt.radial'), title: t('opt.radial') },
      ], this.o.type, v => this.set('type', v)),
      select([{ value: 'fgbg', label: t('opt.fgToBg') }, { value: 'fgtr', label: t('opt.fgToTransparent') }], this.o.colors, v => this.set('colors', v)),
      checkbox(t('opt.reverse'), this.o.reverse, v => this.set('reverse', v)),
      sep(),
      numberField({ label: t('opt.opacity'), value: this.o.opacity, min: 1, max: 100, unit: '%', onChange: v => this.set('opacity', v) }),
    ];
  }
}

/* ---------------- Placeholder for later stages ---------------- */
export class SoonTool extends Tool {
  implemented = false;
  constructor(readonly id: string, readonly iconName: string, readonly key: string = '') { super({}); }
}

export { alphaBounds };
