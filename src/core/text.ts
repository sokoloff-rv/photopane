import { Layer, TextData, CharStyle, StyleRun } from './layer';
export type { CharStyle, StyleRun };
import { createCanvas, ctx2d, Rect } from './util';
import { css } from './color';
import { isGoogleFamily, isGoogleLoaded, ensureGoogleFont } from './gfonts';

export const COMMON_FONTS = [
  'Arial', 'Segoe UI', 'Calibri', 'Cambria', 'Candara', 'Consolas', 'Constantia', 'Corbel', 'Courier New',
  'Franklin Gothic Medium', 'Georgia', 'Impact', 'Palatino Linotype', 'Segoe Print', 'Segoe Script',
  'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Bahnschrift', 'Comic Sans MS', 'Sitka Text',
];

/* ---------------- character styles ---------------- */
export const STYLE_KEYS: (keyof CharStyle)[] = ['font', 'size', 'color', 'bold', 'italic', 'underline', 'strike', 'caps', 'tracking', 'vScale', 'leading'];

export function baseStyle(t: TextData): CharStyle {
  const s: CharStyle = { font: t.font, size: t.size, color: { ...t.color }, bold: t.bold, italic: t.italic, underline: t.underline, tracking: t.tracking, vScale: t.vScale ?? 1, leading: t.leading };
  if (t.weight !== undefined) s.weight = t.weight;
  if (t.psName !== undefined) s.psName = t.psName;
  if (t.fauxBold !== undefined) s.fauxBold = t.fauxBold;
  if (t.strike) s.strike = true;
  if (t.caps) s.caps = true;
  return s;
}

const sameStyle = (a: CharStyle, b: CharStyle) => JSON.stringify(a) === JSON.stringify(b);

/** Runs covering the whole text (a single run when the layer has one style). */
export function getRuns(t: TextData): StyleRun[] {
  const n = t.text.length;
  const src = t.runs && t.runs.length ? t.runs : [{ len: n, s: baseStyle(t) }];
  const out: StyleRun[] = [];
  let acc = 0;
  for (const r of src) {
    const len = Math.max(0, Math.min(r.len, n - acc));
    if (len > 0) out.push({ len, s: { ...r.s, color: { ...r.s.color } } });
    acc += len;
  }
  if (acc < n || !out.length) out.push({ len: n - acc, s: out.length ? { ...out[out.length - 1].s } : baseStyle(t) });
  return out;
}

/** Store runs on the text data: merge equal neighbours, keep base fields = first character's style. */
export function setRuns(t: TextData, runs: StyleRun[]) {
  const merged: StyleRun[] = [];
  for (const r of runs) {
    if (r.len <= 0) continue;
    const last = merged[merged.length - 1];
    if (last && sameStyle(last.s, r.s)) last.len += r.len; else merged.push({ len: r.len, s: { ...r.s } });
  }
  const first = merged[0]?.s ?? (t.runs?.[0]?.s) ?? baseStyle(t);
  Object.assign(t, { font: first.font, size: first.size, color: { ...first.color }, bold: first.bold, italic: first.italic, underline: first.underline, tracking: first.tracking, vScale: first.vScale, leading: first.leading, weight: first.weight, psName: first.psName, fauxBold: first.fauxBold, strike: first.strike, caps: first.caps });
  t.runs = merged.length > 1 ? merged : undefined;
}

/** Style of the character at index i (or the one before the caret at the end). */
export function styleAt(t: TextData, i: number): CharStyle {
  const runs = getRuns(t);
  let acc = 0;
  for (const r of runs) { if (i < acc + r.len) return r.s; acc += r.len; }
  return runs[runs.length - 1]?.s ?? baseStyle(t);
}

/** Apply a style patch to characters [a, b). */
export function applyStyle(t: TextData, a: number, b: number, patch: Partial<CharStyle>) {
  const runs = getRuns(t);
  const out: StyleRun[] = [];
  let acc = 0;
  for (const r of runs) {
    const s0 = acc, e0 = acc + r.len;
    const parts: [number, number, boolean][] = [];
    if (b <= s0 || a >= e0) parts.push([s0, e0, false]);
    else {
      if (a > s0) parts.push([s0, a, false]);
      parts.push([Math.max(a, s0), Math.min(b, e0), true]);
      if (b < e0) parts.push([b, e0, false]);
    }
    for (const [ps, pe, hit] of parts) if (pe > ps) out.push({ len: pe - ps, s: hit ? { ...r.s, ...patch } : r.s });
    acc = e0;
  }
  setRuns(t, out);
}

/** Apply a patch to every character (and the base style). */
export function applyStyleAll(t: TextData, patch: Partial<CharStyle>) {
  setRuns(t, getRuns(t).map(r => ({ len: r.len, s: { ...r.s, ...patch } })));
  Object.assign(t, patch);
}

/** Keep styles in sync after the text changed from `oldText` to t.text (one contiguous edit). New characters take
 *  the style of the character before the edit (or `typing` if given). */
export function textEdited(t: TextData, oldText: string, typing?: CharStyle) {
  const nt = t.text;
  let p = 0;
  while (p < oldText.length && p < nt.length && oldText[p] === nt[p]) p++;
  let so = oldText.length, sn = nt.length;
  while (so > p && sn > p && oldText[so - 1] === nt[sn - 1]) { so--; sn--; }
  const tmp: TextData = { ...t, text: oldText };
  const runs = getRuns(tmp);
  const ins = sn - p;
  const insStyle = typing ?? (p > 0 ? styleAt(tmp, p - 1) : styleAt(tmp, 0));
  const out: StyleRun[] = [];
  let acc = 0, inserted = false;
  const insert = () => { if (!inserted && ins > 0) out.push({ len: ins, s: insStyle }); inserted = true; };
  for (const r of runs) {
    const s0 = acc, e0 = acc + r.len;
    // part before the edit
    if (s0 < p) out.push({ len: Math.min(e0, p) - s0, s: r.s });
    if (e0 >= p && !inserted && s0 <= p) insert();
    // part after the removed range
    if (e0 > so) out.push({ len: e0 - Math.max(s0, so), s: r.s });
    acc = e0;
  }
  insert();
  setRuns(t, out);
}

export function hasMixedStyles(t: TextData) { return !!t.runs && t.runs.length > 1; }

/* ---------------- fonts & metrics ---------------- */
export function styleFont(s: CharStyle, scale = 1): string {
  return `${s.italic ? 'italic ' : ''}${fontWeight(s)} ${s.size * scale}px "${s.font}", sans-serif`;
}

/** Effective CSS weight of a style. */
export function fontWeight(s: CharStyle): number {
  return s.weight ?? (s.bold ? 700 : 400);
}

/** Text as drawn: capitals when the style asks for them (one character stays one character, so the caret and
 * selection keep their positions; letters whose capital form is longer, like ß, stay as they are). */
export function shownText(s: CharStyle, text: string): string {
  if (!s.caps) return text;
  let out = '';
  for (const ch of text) { const u = ch.toUpperCase(); out += u.length === ch.length ? u : ch; }
  return out;
}
export function fontString(t: TextData, scale = 1): string { return styleFont(baseStyle(t), scale); }

let measureCtx: CanvasRenderingContext2D | null = null;
function mctx(s: CharStyle) {
  if (!measureCtx) measureCtx = ctx2d(createCanvas(4, 4));
  measureCtx.font = styleFont(s);
  (measureCtx as any).letterSpacing = `${(s.tracking / 1000) * s.size}px`;
  return measureCtx;
}
export function measure(s: CharStyle, text: string) { return text ? mctx(s).measureText(shownText(s, text)).width : 0; }

const metricsCache = new Map<string, { asc: number; desc: number }>();
export function styleMetrics(s: CharStyle): { asc: number; desc: number } {
  const key = styleFont(s) + '|' + s.vScale;
  let m = metricsCache.get(key);
  if (!m) {
    const tm = mctx(s).measureText('HgЙу');
    m = { asc: (tm.fontBoundingBoxAscent ?? s.size * 0.8) * s.vScale, desc: (tm.fontBoundingBoxDescent ?? s.size * 0.2) * s.vScale };
    if (metricsCache.size > 300) metricsCache.clear();
    metricsCache.set(key, m);
  }
  return m;
}
export function fontMetrics(t: TextData) { return styleMetrics(baseStyle(t)); }

/** Forget cached metrics (after fonts were registered). */
export function clearFontCaches() { metricsCache.clear(); }

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

/* ---------------- layout ---------------- */
export interface Seg { start: number; end: number; text: string; s: CharStyle; w: number }
export interface Line { start: number; end: number; segs: Seg[]; width: number; asc: number; desc: number; lead: number; x: number; baseline: number }
export interface TextLayout { lines: Line[]; frame: Rect; /** first baseline from frame top */ baseline: number }

function runsWithOffsets(t: TextData) {
  let acc = 0;
  return getRuns(t).map(r => { const o = { start: acc, end: acc + r.len, s: r.s }; acc += r.len; return o; });
}

/** Lay out text (wrapping box text), with per-run fonts. Point text: first baseline = ascent of the first line,
 *  each following baseline moves down by the largest leading on that line (like Photoshop). */
export function layoutText(t: TextData): TextLayout {
  const text = t.text;
  const runs = runsWithOffsets(t);
  const styleIdx = (i: number) => runs.find(r => i >= r.start && i < r.end)?.s ?? runs[runs.length - 1]?.s ?? baseStyle(t);
  const segsOf = (a: number, b: number): Seg[] => {
    const out: Seg[] = [];
    for (const r of runs) {
      const s = Math.max(a, r.start), e = Math.min(b, r.end);
      if (e > s) { const tx = text.slice(s, e); out.push({ start: s, end: e, text: tx, s: r.s, w: measure(r.s, tx) }); }
    }
    return out;
  };
  const widthOf = (a: number, b: number) => segsOf(a, b).reduce((w, s) => w + s.w, 0);
  const makeLine = (a: number, b: number): Line => {
    const segs = segsOf(a, b);
    const styles = segs.length ? segs.map(s => s.s) : [styleIdx(Math.max(0, a - 1))];
    let asc = 0, desc = 0, lead = 0;
    for (const s of styles) { const m = styleMetrics(s); asc = Math.max(asc, m.asc); desc = Math.max(desc, m.desc); lead = Math.max(lead, s.size * s.leading); }
    return { start: a, end: b, segs, width: segs.reduce((w, s) => w + s.w, 0), asc, desc, lead, x: 0, baseline: 0 };
  };
  const lines: Line[] = [];
  let pos = 0;
  for (const para of text.split('\n')) {
    const ps = pos, pe = pos + para.length;
    if (!t.box) lines.push(makeLine(ps, pe));
    else {
      const maxW = t.box.w;
      const tokens = [...para.matchAll(/\S+|\s+/g)].map(m => ({ s: ps + m.index!, e: ps + m.index! + m[0].length, space: /^\s/.test(m[0]) }));
      let ls = ps, cur = 0;
      for (const tk of tokens) {
        let tw = widthOf(tk.s, tk.e);
        if (!tk.space && cur + tw > maxW && cur > 0) { lines.push(makeLine(ls, tk.s)); ls = tk.s; cur = 0; }
        if (!tk.space && tw > maxW) {
          // break a very long word by characters
          let cs = tk.s;
          for (let i = tk.s + 1; i <= tk.e; i++) {
            if (widthOf(cs, i) > maxW && i - 1 > cs) { lines.push(makeLine(ls, i - 1)); ls = i - 1; cs = i - 1; }
          }
          tw = widthOf(cs, tk.e);
          cur = tw;
          continue;
        }
        cur += tw;
      }
      lines.push(makeLine(ls, pe));
    }
    pos = pe + 1;
  }
  // vertical positions
  let y = 0;
  lines.forEach((ln, i) => { y = i === 0 ? ln.asc : y + ln.lead; ln.baseline = y; });
  const last = lines[lines.length - 1];
  const contentH = last ? last.baseline + last.desc : 0;
  const maxW = Math.max(1, ...lines.map(l => l.width));
  let frame: Rect;
  if (t.psdPixels && t.psdFrame) frame = { ...t.psdFrame };
  else if (t.box) frame = { x: t.ax, y: t.ay, w: t.box.w, h: t.box.h };
  else {
    const x = t.align === 'left' ? t.ax : t.align === 'center' ? t.ax - maxW / 2 : t.ax - maxW;
    frame = { x, y: t.ay, w: maxW, h: Math.max(1, contentH) };
  }
  const fw = t.box ? t.box.w : maxW;
  for (const ln of lines) ln.x = t.align === 'left' ? 0 : t.align === 'center' ? (fw - ln.width) / 2 : fw - ln.width;
  return { lines, frame, baseline: lines[0]?.baseline ?? 0 };
}

/** Distance from the top of the frame to the first baseline. */
export function baselineOffset(t: TextData): number {
  const lay = layoutText({ ...t, psdPixels: false });
  return lay.baseline;
}

/* ---------------- text transform ---------------- */
/** Pivot of the text transform in document coordinates. */
export function textPivot(t: TextData, lay?: TextLayout): { x: number; y: number } {
  if (t.box) return { x: t.ax + (t.tf?.dx ?? 0), y: t.ay + (t.tf?.dy ?? 0) };
  const base = (lay && !t.psdPixels) ? lay.baseline : baselineOffset(t);
  return { x: t.ax, y: t.ay + base };
}

/** Matrix mapping layout (untransformed) coordinates to the document; null when the text is not transformed. */
export function textMatrix(t: TextData, lay?: TextLayout): DOMMatrix | null {
  if (!t.tf) return null;
  const p = textPivot(t, lay);
  const [a, b, c, d] = t.tf.m;
  return new DOMMatrix([a, b, c, d, p.x - (a * p.x + c * p.y), p.y - (b * p.x + d * p.y)]);
}

export function toDocPoint(t: TextData, x: number, y: number, m = textMatrix(t)): { x: number; y: number } {
  if (!m) return { x, y };
  const p = new DOMPoint(x, y).matrixTransform(m);
  return { x: p.x, y: p.y };
}

export function toLocalPoint(t: TextData, x: number, y: number, m = textMatrix(t)): { x: number; y: number } {
  if (!m) return { x, y };
  const p = new DOMPoint(x, y).matrixTransform(m.inverse());
  return { x: p.x, y: p.y };
}

/** Corners of the text frame in document coordinates (TL, TR, BR, BL). */
export function textQuad(t: TextData, lay = layoutText(t)): { x: number; y: number }[] {
  const f = lay.frame;
  const m = textMatrix(t, lay);
  return [[f.x, f.y], [f.x + f.w, f.y], [f.x + f.w, f.y + f.h], [f.x, f.y + f.h]].map(([x, y]) => toDocPoint(t, x, y, m));
}

/* ---------------- caret geometry (layout coordinates; use toDocPoint for the document) ---------------- */
function frameOrigin(t: TextData, lay: TextLayout) {
  // while editing psdPixels is false, so the frame is our own layout frame
  return { x: lay.frame.x, y: lay.frame.y };
}

/** x offset (doc) of the caret before character i, and the line it is on. */
export function caretPos(t: TextData, i: number, lay = layoutText(t)): { x: number; top: number; bottom: number; line: number } {
  const o = frameOrigin(t, lay);
  let li = lay.lines.findIndex(l => i >= l.start && i <= l.end);
  if (li < 0) li = lay.lines.length - 1;
  const ln = lay.lines[li];
  let x = ln.x;
  for (const s of ln.segs) {
    if (i >= s.end) { x += s.w; continue; }
    if (i > s.start) x += measure(s.s, t.text.slice(s.start, i));
    break;
  }
  const st = styleAt(t, Math.max(0, i - 1));
  const m = styleMetrics(st);
  return { x: o.x + x, top: o.y + ln.baseline - Math.max(m.asc, ln.asc * 0.9), bottom: o.y + ln.baseline + Math.max(m.desc, ln.desc), line: li };
}

/** Character index closest to a document point. */
export function hitIndex(t: TextData, px: number, py: number, lay = layoutText(t)): number {
  const o = frameOrigin(t, lay);
  let li = 0;
  for (let k = 0; k < lay.lines.length; k++) {
    const ln = lay.lines[k];
    if (py >= o.y + ln.baseline - ln.asc - (k ? (ln.lead - ln.asc - lay.lines[k - 1].desc) / 2 : 1e6)) li = k;
  }
  const ln = lay.lines[li];
  if (!ln) return 0;
  let best = ln.start, bd = Infinity;
  for (let i = ln.start; i <= ln.end; i++) {
    const d = Math.abs(caretPos(t, i, lay).x - px);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Selection rectangles (document coords) for [a, b). */
export function selectionRects(t: TextData, a: number, b: number, lay = layoutText(t)): Rect[] {
  const o = frameOrigin(t, lay);
  const out: Rect[] = [];
  for (const ln of lay.lines) {
    const s = Math.max(a, ln.start), e = Math.min(b, ln.end);
    if (e < s || (e === s && !(a <= ln.end && b > ln.end))) continue;
    const x0 = caretPos(t, s, lay).x, x1 = b > ln.end ? caretPos(t, ln.end, lay).x + 4 : caretPos(t, e, lay).x;
    out.push({ x: x0, y: o.y + ln.baseline - ln.asc, w: Math.max(1, x1 - x0), h: ln.asc + ln.desc });
  }
  return out;
}

/* ---------------- rendering ---------------- */
export function renderTextLayer(l: Layer) {
  const t = l.text;
  if (!t) return;
  // a Google Fonts family that is not here yet: fetch it (the layer is redrawn when it arrives)
  for (const r of getRuns(t)) if (isGoogleFamily(r.s.font) && !isGoogleLoaded(r.s.font)) void ensureGoogleFont(r.s.font);
  t.psdPixels = false;
  const lay = layoutText(t);
  const maxSize = Math.max(t.size, ...getRuns(t).map(r => r.s.size));
  const pad = Math.ceil(maxSize * 0.6);
  const f = lay.frame;
  const c = createCanvas(Math.ceil(f.w) + pad * 2, Math.ceil(f.h) + pad * 2);
  const ox = f.x - Math.floor(f.x), oy = f.y - Math.floor(f.y);
  /** Draw the glyphs in the upright frame canvas coordinates (frame origin at pad + sub-pixel offset). */
  const paint = (g: CanvasRenderingContext2D) => {
    g.textBaseline = 'alphabetic';
    if (t.box) { g.beginPath(); g.rect(pad, pad, f.w, f.h); g.clip(); }
    if (ox || oy) g.translate(ox, oy);
    for (const ln of lay.lines) {
      let x = pad + ln.x;
      const y = pad + ln.baseline;
      for (const sg of ln.segs) {
        const s = sg.s;
        g.font = styleFont(s);
        (g as any).letterSpacing = `${(s.tracking / 1000) * s.size}px`;
        g.fillStyle = css(s.color);
        const shown = shownText(s, sg.text);
        if (s.vScale !== 1) { g.save(); g.translate(x, y); g.scale(1, s.vScale); g.fillText(shown, 0, 0); g.restore(); }
        else g.fillText(shown, x, y);
        const line = Math.max(1, s.size / 16);
        if (s.underline && sg.text.trim()) g.fillRect(x, y + s.size * 0.1, sg.w, line);
        if (s.strike && sg.text.trim()) g.fillRect(x, y - s.size * 0.3 * s.vScale - line / 2, sg.w, line);
        x += sg.w;
      }
    }
  };
  const lx = Math.floor(f.x) - pad, ly = Math.floor(f.y) - pad;
  const m = textMatrix(t, lay);
  if (!m) { paint(ctx2d(c)); l.content.replace(c, lx, ly); l.touch(); return; }
  // transformed text: draw the glyph outlines through the text matrix (stays crisp when scaled or rotated)
  const pts = [[lx, ly], [lx + c.width, ly], [lx + c.width, ly + c.height], [lx, ly + c.height]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
  const x0 = Math.floor(Math.min(...pts.map(p => p.x))), y0 = Math.floor(Math.min(...pts.map(p => p.y)));
  const x1 = Math.ceil(Math.max(...pts.map(p => p.x))), y1 = Math.ceil(Math.max(...pts.map(p => p.y)));
  const out = createCanvas(Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  const og = ctx2d(out);
  og.setTransform(new DOMMatrix().translate(-x0, -y0).multiply(m).translate(lx, ly));
  paint(og);
  l.content.replace(out, x0, y0);
  l.touch();
}

/**
 * Apply a document-space affine transform to a type layer while keeping the text editable
 * (Photoshop's free transform / rotate / flip on type). Uniform scale is baked into the font sizes;
 * rotation, skew, mirroring and non-uniform scale stay in the text matrix.
 */
export function transformText(l: Layer, M: DOMMatrix) {
  const t = l.text;
  if (!t) return;
  const P = textPivot(t);
  const L = t.tf?.m ?? [1, 0, 0, 1];
  // L' = A·L (DOMMatrix order: x' = a·x + c·y, y' = b·x + d·y)
  let a = M.a * L[0] + M.c * L[1], b = M.b * L[0] + M.d * L[1];
  let c = M.a * L[2] + M.c * L[3], d = M.b * L[2] + M.d * L[3];
  // the pivot follows the transform; the layout moves with the anchor
  const MP = new DOMPoint(P.x, P.y).matrixTransform(M);
  let dx = t.tf?.dx ?? 0, dy = t.tf?.dy ?? 0;
  t.psdPixels = false;
  delete t.psdFrame;
  // bake a uniform scale (rotation / reflection with equal axes) into the type size, like Photoshop's size field
  const s = Math.sqrt(Math.abs(a * d - b * c));
  const ortho = s > 1e-6 && Math.abs((a * a + b * b) / (s * s) - 1) < 1e-3 && Math.abs((c * c + d * d) / (s * s) - 1) < 1e-3 && Math.abs((a * c + b * d) / (s * s)) < 1e-3;
  if (ortho && Math.abs(s - 1) > 1e-6) {
    const r2 = (v: number) => Math.round(v * 1000) / 1000;
    t.size = r2(t.size * s);
    if (t.runs) t.runs.forEach(r => { r.s.size = r2(r.s.size * s); });
    if (t.box) t.box = { w: t.box.w * s, h: t.box.h * s };
    dx *= s; dy *= s;
    a /= s; b /= s; c /= s; d /= s;
  }
  const ident = Math.abs(a - 1) < 1e-6 && Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6 && Math.abs(d - 1) < 1e-6;
  t.tf = ident ? null : { m: [a, b, c, d], dx: t.box ? dx : 0, dy: t.box ? dy : 0 };
  // place the anchor so that the pivot lands on its transformed position
  if (t.box) { t.ax = MP.x - dx; t.ay = MP.y - dy; }
  else { t.ax = MP.x; t.ay = MP.y - baselineOffset(t); }
  renderTextLayer(l);
}
