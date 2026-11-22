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

export interface TextLayout { lines: { text: string; width: number }[]; frame: Rect; lineH: number }

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
  if (t.box) frame = { x: t.ax, y: t.ay, w: t.box.w, h: t.box.h };
  else {
    const x = t.align === 'left' ? t.ax : t.align === 'center' ? t.ax - maxW / 2 : t.ax - maxW;
    frame = { x, y: t.ay, w: maxW, h: Math.max(lineH, lines.length * lineH) };
  }
  return { lines, frame, lineH };
}

/** Render a text layer's pixels from its TextData. */
export function renderTextLayer(l: Layer) {
  const t = l.text;
  if (!t) return;
  const lay = layoutText(t);
  const pad = Math.ceil(t.size * 0.6);
  const f = lay.frame;
  const contentH = t.box ? f.h : lay.lines.length * lay.lineH;
  const c = createCanvas(Math.ceil(f.w) + pad * 2, Math.ceil(contentH) + pad * 2);
  const g = ctx2d(c);
  g.font = fontString(t);
  (g as any).letterSpacing = `${(t.tracking / 1000) * t.size}px`;
  g.fillStyle = css(t.color);
  g.textBaseline = 'middle';
  if (t.box) { g.beginPath(); g.rect(pad, pad, f.w, f.h); g.clip(); }
  const ox = f.x - Math.floor(f.x), oy = f.y - Math.floor(f.y);
  if (ox || oy) g.translate(ox, oy);
  lay.lines.forEach((ln, i) => {
    const x = t.align === 'left' ? pad : t.align === 'center' ? pad + (f.w - ln.width) / 2 : pad + f.w - ln.width;
    const y = pad + i * lay.lineH + lay.lineH / 2;
    g.fillText(ln.text, x, y);
    if (t.underline && ln.text) {
      const th = Math.max(1, t.size / 16);
      g.fillRect(x, y + t.size * 0.42, ln.width, th);
    }
  });
  l.content.replace(c, Math.floor(f.x) - pad, Math.floor(f.y) - pad);
  l.touch();
}
