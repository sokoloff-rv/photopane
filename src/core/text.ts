import { Layer, TextData } from './layer';
import { createCanvas, ctx2d, Rect } from './util';
import { css } from './color';

export const COMMON_FONTS = [
  'Arial', 'Segoe UI', 'Calibri', 'Cambria', 'Candara', 'Consolas', 'Constantia', 'Corbel', 'Courier New',
  'Franklin Gothic Medium', 'Georgia', 'Impact', 'Palatino Linotype', 'Segoe Print', 'Segoe Script',
  'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Bahnschrift', 'Comic Sans MS', 'Sitka Text',
];

export function fontString(t: TextData, scale = 1): string {
  return `${t.italic ? 'italic ' : ''}${t.bold ? '700' : '400'} ${t.size * scale}px "${t.font}", sans-serif`;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function mctx(t: TextData) {
  if (!measureCtx) measureCtx = ctx2d(createCanvas(4, 4));
  measureCtx.font = fontString(t);
  (measureCtx as any).letterSpacing = `${(t.tracking / 1000) * t.size}px`;
  return measureCtx;
}

export interface TextLayout { lines: { text: string; width: number }[]; frame: Rect; lineH: number; baseline: number }

const metricsCache = new Map<string, { asc: number; desc: number }>();
/** Font ascent/descent in px (font box), used to place the baseline like a CSS line box. */
export function fontMetrics(t: TextData): { asc: number; desc: number } {
  const key = fontString(t);
  let m = metricsCache.get(key);
  if (!m) {
    const g = mctx(t);
    const tm = g.measureText('HgЙу');
    const vs = t.vScale ?? 1;
    const asc = (tm.fontBoundingBoxAscent ?? t.size * 0.8) * vs;
    const desc = (tm.fontBoundingBoxDescent ?? t.size * 0.2) * vs;
    m = { asc, desc };
    if (metricsCache.size > 200) metricsCache.clear();
    metricsCache.set(key, m);
  }
  return m;
}

/** Distance from the top of the text frame to the first baseline (Photoshop: the font ascent;
 *  leading only spaces the following lines). */
export function baselineOffset(t: TextData): number {
  return fontMetrics(t).asc;
}

/** Extra space a CSS line box adds above the first baseline compared to the frame (for the editor overlay). */
export function cssHalfLeading(t: TextData): number {
  const { asc, desc } = fontMetrics(t);
  return (t.size * t.leading - (asc + desc)) / 2;
}

/** Is a font family installed? (compares text widths against generic fallbacks) */
export function fontAvailable(family: string): boolean {
  const g = ctx2d(createCanvas(4, 4));
  const sample = 'mmmmmmmmmmlliWW@#АБВЖЩабвжщ0123';
  for (const base of ['monospace', 'serif', 'sans-serif']) {
    g.font = `72px ${base}`;
    const w0 = g.measureText(sample).width;
    g.font = `72px "${family}", ${base}`;
    if (Math.abs(g.measureText(sample).width - w0) > 0.5) return true;
  }
  return false;
}

/** Lay out text: wrap for box text, measure lines, compute the frame in document space. */
export function layoutText(t: TextData): TextLayout {
  const g = mctx(t);
  const lineH = t.size * t.leading;
  const lines: { text: string; width: number }[] = [];
  const paragraphs = t.text.split('\n');
  for (const para of paragraphs) {
    if (!t.box) { lines.push({ text: para, width: g.measureText(para).width }); continue; }
    const words = para.split(/(\s+)/);
    let cur = '';
    for (const w of words) {
      const test = cur + w;
      if (g.measureText(test).width <= t.box.w || !cur) {
        // break a very long word by characters
        if (g.measureText(test).width > t.box.w && !cur.trim()) {
          let part = '';
          for (const ch of w) {
            if (g.measureText(part + ch).width > t.box.w && part) { lines.push({ text: part, width: g.measureText(part).width }); part = ''; }
            part += ch;
          }
          cur = part;
        } else cur = test;
      } else {
        lines.push({ text: cur.trimEnd(), width: g.measureText(cur.trimEnd()).width });
        cur = w.trimStart();
      }
    }
    lines.push({ text: cur, width: g.measureText(cur).width });
  }
  const maxW = Math.max(1, ...lines.map(l => l.width));
  let frame: Rect;
  if (t.psdPixels && t.psdFrame) frame = { ...t.psdFrame };
  else if (t.box) frame = { x: t.ax, y: t.ay, w: t.box.w, h: t.box.h };
  else {
    const x = t.align === 'left' ? t.ax : t.align === 'center' ? t.ax - maxW / 2 : t.ax - maxW;
    const { asc, desc } = fontMetrics(t);
    frame = { x, y: t.ay, w: maxW, h: asc + desc + (lines.length - 1) * lineH };
  }
  return { lines, frame, lineH, baseline: baselineOffset(t) };
}

/** Render a text layer's pixels from its TextData. */
export function renderTextLayer(l: Layer) {
  const t = l.text;
  if (!t) return;
  t.psdPixels = false;
  const lay = layoutText(t);
  const pad = Math.ceil(t.size * 0.6);
  const f = lay.frame;
  const contentH = f.h;
  const c = createCanvas(Math.ceil(f.w) + pad * 2, Math.ceil(contentH) + pad * 2);
  const g = ctx2d(c);
  g.font = fontString(t);
  (g as any).letterSpacing = `${(t.tracking / 1000) * t.size}px`;
  g.fillStyle = css(t.color);
  g.textBaseline = 'alphabetic';
  const vs = t.vScale ?? 1;
  if (t.box) { g.beginPath(); g.rect(pad, pad, f.w, f.h); g.clip(); }
  const ox = f.x - Math.floor(f.x), oy = f.y - Math.floor(f.y);
  if (ox || oy) g.translate(ox, oy);
  lay.lines.forEach((ln, i) => {
    const x = t.align === 'left' ? pad : t.align === 'center' ? pad + (f.w - ln.width) / 2 : pad + f.w - ln.width;
    const y = pad + i * lay.lineH + lay.baseline;
    if (vs !== 1) { g.save(); g.translate(x, y); g.scale(1, vs); g.fillText(ln.text, 0, 0); g.restore(); }
    else g.fillText(ln.text, x, y);
    if (t.underline && ln.text) {
      const th = Math.max(1, t.size / 16);
      g.fillRect(x, y + t.size * 0.1, ln.width, th);
    }
  });
  l.content.replace(c, Math.floor(f.x) - pad, Math.floor(f.y) - pad);
  l.touch();
}
