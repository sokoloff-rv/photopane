import { app, PaintTarget } from '../app';
import { RGB, css, gray } from '../core/color';
import { cloneCanvas, createCanvas, ctx2d, Rect, rectUnion, rectIntersect, rectInt } from '../core/util';
import { Selection } from '../core/selection';

/* ---------- brush tip ---------- */
const tipCache = new Map<string, HTMLCanvasElement>();

/** Round brush tip. Diameter d, hardness 0..1, colored. */
export function brushTip(d: number, hardness: number, color: RGB): HTMLCanvasElement {
  const size = Math.max(1, Math.ceil(d));
  const key = `${size}|${hardness.toFixed(2)}|${color.r},${color.g},${color.b}`;
  let c = tipCache.get(key);
  if (c) return c;
  if (tipCache.size > 64) tipCache.clear();
  const W = size + 2;
  c = createCanvas(W, W);
  const g = ctx2d(c);
  // Computed pixel by pixel, not with a canvas radial gradient: the browser dithers gradients (adds noise
  // against banding), and hundreds of overlapping dabs piled that noise up into a dirty, grainy stroke.
  const img = g.createImageData(W, W), px = img.data;
  const r = Math.max(0.5, d / 2), cx = W / 2;
  const hard = hardness >= 0.99 || d <= 2;
  const h = Math.max(0, Math.min(0.98, hardness));
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cx);
      let a: number;
      if (hard) a = Math.min(1, Math.max(0, r - dist + 0.5));       // a clean anti-aliased edge
      else {
        const u = dist / r;
        if (u <= h) a = 1;
        else if (u >= 1) a = 0;
        else { const t = (u - h) / (1 - h); a = (1 - t) * (1 - t) * (1 + 2 * t); }   // smooth falloff
      }
      const i = (y * W + x) * 4;
      px[i] = color.r; px[i + 1] = color.g; px[i + 2] = color.b; px[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  tipCache.set(key, c);
  return c;
}

/* ---------- dab spacing ---------- */
export class DabPath {
  private last: { x: number; y: number; p: number } | null = null;
  private rest = 0;
  constructor(private spacing: (pressure: number) => number) {}

  /** Returns positions where dabs should be placed for moving to (x,y). */
  to(x: number, y: number, p: number, first = false): { x: number; y: number; p: number }[] {
    if (!this.last || first) { this.last = { x, y, p }; this.rest = 0; return [{ x, y, p }]; }
    const out: { x: number; y: number; p: number }[] = [];
    const l = this.last;
    const dx = x - l.x, dy = y - l.y;
    const dist = Math.hypot(dx, dy);
    const sp = Math.max(0.25, this.spacing(p));
    // distance along this segment to the next dab
    let s = sp - this.rest;
    while (s <= dist) {
      const k = dist > 0 ? s / dist : 0;
      out.push({ x: l.x + dx * k, y: l.y + dy * k, p: l.p + (p - l.p) * k });
      s += sp;
    }
    // distance travelled since the last dab
    this.rest = dist - (s - sp);
    this.last = { x, y, p };
    return out;
  }
}

/* ---------- stroke session (paint into a stroke buffer, composite over backup) ---------- */
export type StrokeMode = 'paint' | 'erase';

export class StrokeSession {
  target: PaintTarget;
  backup: HTMLCanvasElement;
  stroke: HTMLCanvasElement;
  sg: CanvasRenderingContext2D;
  sel: Selection | null;
  private pending: Rect | null = null;
  total: Rect | null = null;

  /**
   * `tint`: the stroke is one colour (the brush). Dabs are then collected as coverage only (white) and the
   * colour is put on at output, once: kept in the buffer, a colour at low coverage is rounded to 8 bits on
   * every dab, which made soft strokes look dirty.
   */
  private tint: RGB | null;
  private tintBuf: HTMLCanvasElement | null = null;

  constructor(target: PaintTarget, public mode: StrokeMode, public opacity: number, public color: RGB, tint = false) {
    this.tint = tint && mode === 'paint' && !target.isMask ? color : null;
    const d = app.doc!;
    this.target = target;
    target.surface.ensureCovers({ x: 0, y: 0, w: d.width, h: d.height });
    this.backup = cloneCanvas(target.surface.canvas);
    this.stroke = createCanvas(target.surface.w, target.surface.h);
    this.sg = ctx2d(this.stroke);
    this.sel = d.selection;
  }

  /** Mark a document-space rect as changed by dabs. */
  touched(r: Rect) {
    const s = this.target.surface;
    const lr = rectIntersect(rectInt({ x: r.x - s.x - 1, y: r.y - s.y - 1, w: r.w + 2, h: r.h + 2 }), { x: 0, y: 0, w: s.w, h: s.h });
    if (!lr) return;
    this.pending = rectUnion(this.pending, lr);
  }

  dab(tip: HTMLCanvasElement, x: number, y: number, d: number, alpha: number) {
    const s = this.target.surface;
    const size = tip.width * (d / Math.max(1, tip.width - 2));
    this.sg.globalAlpha = alpha;
    this.sg.drawImage(tip, x - s.x - size / 2, y - s.y - size / 2, size, size);
    this.touched({ x: x - size / 2, y: y - size / 2, w: size, h: size });
  }

  /** Composite pending region of the stroke buffer onto the target. */
  flush() {
    const R = this.pending;
    if (!R) return;
    this.pending = null;
    this.total = rectUnion(this.total, R);
    const s = this.target.surface;
    const g = s.ctx;
    // clip stroke to selection
    if (this.sel) {
      this.sg.save();
      this.sg.beginPath(); this.sg.rect(R.x, R.y, R.w, R.h); this.sg.clip();
      this.sg.globalAlpha = 1;
      this.sg.globalCompositeOperation = 'destination-in';
      this.sg.drawImage(this.sel.mask, -s.x, -s.y);
      this.sg.restore();
    } else {
      // clip to the document bounds
      const d = app.doc!;
      this.sg.save();
      this.sg.globalCompositeOperation = 'destination-in';
      this.sg.beginPath(); this.sg.rect(R.x, R.y, R.w, R.h); this.sg.clip();
      this.sg.fillStyle = '#000';
      this.sg.fillRect(-s.x, -s.y, d.width, d.height);
      this.sg.restore();
    }
    g.save();
    g.beginPath(); g.rect(R.x, R.y, R.w, R.h); g.clip();
    g.globalCompositeOperation = 'copy';
    g.drawImage(this.backup, 0, 0);
    compositeStroke(g, this.tint ? this.tinted(R) : this.stroke, this.target, this.mode, this.opacity, this.color);
    g.restore();
    this.target.layer.touch();
    // only this part of the picture is composited and drawn again
    app.paintDirty({ x: R.x + s.x, y: R.y + s.y, w: R.w, h: R.h });
  }

  /** The stroke coverage in region R coloured with the brush colour (the rest of the buffer stays as it was). */
  private tinted(R: Rect): HTMLCanvasElement {
    const st = this.stroke;
    if (!this.tintBuf || this.tintBuf.width !== st.width || this.tintBuf.height !== st.height) this.tintBuf = createCanvas(st.width, st.height);
    const g = ctx2d(this.tintBuf);
    g.save();
    g.beginPath(); g.rect(R.x, R.y, R.w, R.h); g.clip();
    g.globalCompositeOperation = 'copy';
    g.drawImage(st, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = css(this.tint!);
    g.fillRect(R.x, R.y, R.w, R.h);
    g.restore();
    return this.tintBuf;
  }

  finish(label: string) {
    this.flush();
    if (this.total) this.target.surface.markDirty(this.total);
    app.commit(label);
  }

  cancel() {
    const g = this.target.surface.ctx;
    g.save(); g.globalCompositeOperation = 'copy'; g.drawImage(this.backup, 0, 0); g.restore();
    this.target.layer.touch();
    app.update('canvas');
  }
}

/**
 * Composite a coverage/color buffer onto the target context (whose content is the backup).
 * For pixel layers the buffer holds colored pixels; for masks the buffer's alpha is coverage.
 */
export function compositeStroke(g: CanvasRenderingContext2D, buf: HTMLCanvasElement, target: PaintTarget, mode: StrokeMode, opacity: number, color: RGB, dx = 0, dy = 0) {
  g.globalAlpha = opacity;
  if (target.isMask) {
    const v = mode === 'erase' ? 0 : gray(color) / 255;
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(buf, dx, dy);
    if (v > 0) {
      // buffer may be colored: use it as alpha only by drawing white through a temp
      const tmp = whiteFrom(buf);
      g.globalAlpha = opacity * v;
      g.globalCompositeOperation = 'source-over';
      g.drawImage(tmp, dx, dy);
    }
  } else if (mode === 'erase') {
    if (target.layer.lockAlpha) {
      g.globalCompositeOperation = 'source-atop';
      g.drawImage(tinted(buf, app.bg), dx, dy);
    } else {
      g.globalCompositeOperation = 'destination-out';
      g.drawImage(buf, dx, dy);
    }
  } else {
    g.globalCompositeOperation = target.layer.lockAlpha ? 'source-atop' : 'source-over';
    g.drawImage(buf, dx, dy);
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

let whiteTmp: HTMLCanvasElement | null = null;
function whiteFrom(buf: HTMLCanvasElement): HTMLCanvasElement {
  return tinted(buf, { r: 255, g: 255, b: 255 });
}
function tinted(buf: HTMLCanvasElement, c: RGB): HTMLCanvasElement {
  if (!whiteTmp || whiteTmp.width !== buf.width || whiteTmp.height !== buf.height) whiteTmp = createCanvas(buf.width, buf.height);
  const g = ctx2d(whiteTmp);
  g.globalCompositeOperation = 'copy';
  g.drawImage(buf, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = css(c);
  g.fillRect(0, 0, buf.width, buf.height);
  g.globalCompositeOperation = 'source-over';
  return whiteTmp;
}

/** Apply a document-sized (or offset) colored buffer onto the paint target, honoring selection. Used by fill & gradient. */
export function applyBuffer(target: PaintTarget, buf: HTMLCanvasElement, bx: number, by: number, opacity: number, color: RGB, backup?: HTMLCanvasElement) {
  const d = app.doc!;
  const s = target.surface;
  s.ensureCovers({ x: 0, y: 0, w: d.width, h: d.height });
  const tmp = createCanvas(buf.width, buf.height);
  const tg = ctx2d(tmp);
  tg.drawImage(buf, 0, 0);
  tg.globalCompositeOperation = 'destination-in';
  if (d.selection) tg.drawImage(d.selection.mask, -bx, -by);
  else { tg.fillStyle = '#000'; tg.fillRect(-bx, -by, d.width, d.height); }
  const g = s.ctx;
  if (backup) { g.globalCompositeOperation = 'copy'; g.drawImage(backup, 0, 0); g.globalCompositeOperation = 'source-over'; }
  compositeStroke(g, tmp, target, 'paint', opacity, color, bx - s.x, by - s.y);
  target.layer.touch();
}

/** Sample color at document point from composite or a layer. size: 1, 3, 5 */
export function sampleColor(x: number, y: number, size: number, allLayers: boolean): RGB | null {
  const d = app.doc!;
  const ix = Math.floor(x), iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= d.width || iy >= d.height) return null;
  const r = Math.floor(size / 2);
  let g: CanvasRenderingContext2D, ox = 0, oy = 0;
  if (allLayers) g = d.compositeRead();
  else { const l = d.active; if (!l || l.isGroup) return null; g = ctx2d(l.canvas); ox = l.x; oy = l.y; }
  const sx = Math.max(0, ix - r - ox), sy = Math.max(0, iy - r - oy);
  const w = Math.min(g.canvas.width - sx, size), h = Math.min(g.canvas.height - sy, size);
  if (w <= 0 || h <= 0) return null;
  const data = g.getImageData(sx, sy, w, h).data;
  let R = 0, G = 0, B = 0, A = 0;
  for (let i = 0; i < data.length; i += 4) { const a = data[i + 3]; R += data[i] * a; G += data[i + 1] * a; B += data[i + 2] * a; A += a; }
  if (!A) return null;
  return { r: R / A, g: G / A, b: B / A };
}
