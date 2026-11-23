import { readPsd, writePsd } from 'ag-psd';
import type { Psd, Layer as PsdLayer, LayerEffectsInfo, BlendMode as PsdBlend, Color as PsdColor } from 'ag-psd';
import { Doc } from '../core/document';
import { Layer, Surface, BlendMode, LayerEffects, defaultEffects, TextData, defaultText, CharStyle } from '../core/layer';
import { RGB } from '../core/color';
import { createCanvas, ctx2d } from '../core/util';
import type { FontNeed } from '../core/fonts';
import { baselineOffset, fontAvailable, getRuns, setRuns, baseStyle, textPivot } from '../core/text';

/* ---------------- blend modes ---------------- */
const FROM_PSD: Partial<Record<PsdBlend, BlendMode>> = {
  'pass through': 'pass-through', normal: 'normal', dissolve: 'normal',
  darken: 'darken', multiply: 'multiply', 'color burn': 'color-burn', 'linear burn': 'multiply', 'darker color': 'darken',
  lighten: 'lighten', screen: 'screen', 'color dodge': 'color-dodge', 'linear dodge': 'lighter', 'lighter color': 'lighten',
  overlay: 'overlay', 'soft light': 'soft-light', 'hard light': 'hard-light', 'vivid light': 'hard-light', 'linear light': 'hard-light',
  'pin light': 'hard-light', 'hard mix': 'hard-light', difference: 'difference', exclusion: 'exclusion', subtract: 'difference',
  divide: 'color-dodge', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};
const TO_PSD: Record<BlendMode, PsdBlend> = {
  'pass-through': 'pass through', normal: 'normal', darken: 'darken', multiply: 'multiply', 'color-burn': 'color burn',
  lighten: 'lighten', screen: 'screen', 'color-dodge': 'color dodge', lighter: 'linear dodge', overlay: 'overlay',
  'soft-light': 'soft light', 'hard-light': 'hard light', difference: 'difference', exclusion: 'exclusion',
  hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};
const blendFrom = (b?: string): BlendMode => (b && FROM_PSD[b as PsdBlend]) || 'normal';

/* ---------------- colors & units ---------------- */
function colorFrom(c: PsdColor | undefined, def: RGB): RGB {
  if (!c) return { ...def };
  const a = c as any;
  if ('r' in a) return { r: a.r, g: a.g, b: a.b };
  if ('fr' in a) return { r: a.fr * 255, g: a.fg * 255, b: a.fb * 255 };
  if ('k' in a && !('c' in a)) { const v = 255 - a.k * 255 / 100; return { r: v, g: v, b: v }; }
  return { ...def };
}
const colorTo = (c: RGB): PsdColor => ({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) });
const units = (u: { value: number } | undefined, def: number) => (u ? u.value : def);
const px = (value: number) => ({ units: 'Pixels' as const, value });
const first = <T,>(v: T | T[] | undefined): T | undefined => (Array.isArray(v) ? v[0] : v);

/* ---------------- effects ---------------- */
/** Document-wide light used by effects with 'Use Global Light'. */
let globalLight = { angle: 120, altitude: 30 };

function effectsFrom(e: LayerEffectsInfo | undefined): LayerEffects {
  const fx = defaultEffects();
  if (!e || e.disabled) return fx;
  const ds = first(e.dropShadow);
  if (ds) Object.assign(fx.dropShadow, {
    enabled: ds.enabled !== false, color: colorFrom(ds.color, fx.dropShadow.color), opacity: ds.opacity ?? 0.75, angle: ds.useGlobalLight ? globalLight.angle : (ds.angle ?? 120),
    distance: units(ds.distance, 5), size: units(ds.size, 5), spread: units(ds.choke, 0), blend: blendFrom(ds.blendMode),
  });
  const st = first(e.stroke);
  if (st) Object.assign(fx.stroke, {
    enabled: st.enabled !== false, color: colorFrom(st.color, fx.stroke.color), size: units(st.size, 3),
    position: st.position || 'outside', opacity: st.opacity ?? 1, blend: blendFrom(st.blendMode),
  });
  const bv = first(e.bevel as any) as typeof e.bevel;
  if (bv && typeof bv === 'object') Object.assign(fx.bevel, {
    enabled: bv.enabled !== false,
    style: bv.style === 'outer bevel' ? 'outer' : bv.style === 'emboss' ? 'emboss' : bv.style === 'pillow emboss' ? 'pillow' : 'inner',
    depth: (bv.strength ?? 1) * 100, direction: bv.direction || 'up', size: units(bv.size, 5), soften: units(bv.soften, 0),
    angle: bv.useGlobalLight ? globalLight.angle : (bv.angle ?? 120), altitude: bv.useGlobalLight ? globalLight.altitude : (bv.altitude ?? 30),
    highlightColor: colorFrom(bv.highlightColor, fx.bevel.highlightColor), highlightOpacity: bv.highlightOpacity ?? 0.75,
    shadowColor: colorFrom(bv.shadowColor, fx.bevel.shadowColor), shadowOpacity: bv.shadowOpacity ?? 0.75,
  });
  const sf = first(e.solidFill);
  if (sf) Object.assign(fx.colorOverlay, { enabled: sf.enabled !== false, color: colorFrom(sf.color, fx.colorOverlay.color), opacity: sf.opacity ?? 1, blend: blendFrom(sf.blendMode) });
  const go = first(e.gradientOverlay);
  if (go) {
    const gr = go.gradient as any;
    const stops = gr?.type === 'solid' && gr.colorStops?.length
      ? gr.colorStops.map((s: any) => ({ color: colorFrom(s.color, { r: 0, g: 0, b: 0 }), pos: s.location }))
      : fx.gradientOverlay.stops;
    Object.assign(fx.gradientOverlay, {
      enabled: go.enabled !== false, stops, opacity: go.opacity ?? 1, angle: go.angle ?? 90,
      type: go.type === 'radial' ? 'radial' : 'linear', reverse: !!go.reverse, scale: (go.scale ?? 1) * 100, blend: blendFrom(go.blendMode),
    });
  }
  return fx;
}

function effectsTo(fx: LayerEffects): LayerEffectsInfo | undefined {
  const e: LayerEffectsInfo = {};
  let any = false;
  const d = fx.dropShadow;
  if (d.enabled) { any = true; e.dropShadow = [{ enabled: true, present: true, showInDialog: true, color: colorTo(d.color), opacity: d.opacity, angle: d.angle, distance: px(d.distance), size: px(d.size), choke: px(d.spread), blendMode: TO_PSD[d.blend], useGlobalLight: false }]; }
  const s = fx.stroke;
  if (s.enabled) { any = true; e.stroke = [{ enabled: true, present: true, showInDialog: true, size: px(s.size), position: s.position, fillType: 'color', color: colorTo(s.color), opacity: s.opacity, blendMode: TO_PSD[s.blend] }]; }
  const b = fx.bevel;
  if (b.enabled) {
    any = true;
    e.bevel = {
      enabled: true, present: true, showInDialog: true, size: px(b.size), soften: px(b.soften), angle: b.angle, altitude: b.altitude, strength: b.depth / 100,
      style: b.style === 'outer' ? 'outer bevel' : b.style === 'emboss' ? 'emboss' : b.style === 'pillow' ? 'pillow emboss' : 'inner bevel',
      technique: 'smooth', direction: b.direction, useGlobalLight: false,
      highlightColor: colorTo(b.highlightColor), highlightOpacity: b.highlightOpacity, highlightBlendMode: 'screen',
      shadowColor: colorTo(b.shadowColor), shadowOpacity: b.shadowOpacity, shadowBlendMode: 'multiply',
    };
  }
  const c = fx.colorOverlay;
  if (c.enabled) { any = true; e.solidFill = [{ enabled: true, present: true, showInDialog: true, color: colorTo(c.color), opacity: c.opacity, blendMode: TO_PSD[c.blend] }]; }
  const g = fx.gradientOverlay;
  if (g.enabled) {
    any = true;
    e.gradientOverlay = [{
      enabled: true, present: true, showInDialog: true, opacity: g.opacity, angle: g.angle, type: g.type, reverse: g.reverse, scale: g.scale / 100,
      blendMode: TO_PSD[g.blend], align: true,
      gradient: {
        name: 'Custom', type: 'solid', smoothness: 1,
        colorStops: g.stops.map(st => ({ color: colorTo(st.color), location: st.pos, midpoint: 0.5 })),
        opacityStops: [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 1, location: 1, midpoint: 0.5 }],
      },
    }];
  }
  return any ? e : undefined;
}

/* ---------------- text ---------------- */
const STYLE_WORDS = /(Bold|Black|Heavy|SemiBold|Semibold|DemiBold|Demi|Medium|Light|Thin|Regular|Book|Italic|Oblique|It)/g;

/** Map a PostScript font name (e.g. "Ralenta-Bold", "LazurskiBoldCyrillic", "ArialMT") to an installed family. */
type Resolved = { family: string; bold: boolean; italic: boolean; weight: number; available: boolean };

/** Weight from a PostScript / style name. */
export function weightFromName(n: string): number {
  if (/thin|hairline/i.test(n)) return 100;
  if (/extra-?light|ultra-?light/i.test(n)) return 200;
  if (/light/i.test(n)) return 300;
  if (/medium/i.test(n)) return 500;
  if (/semi-?bold|demi-?bold|demi/i.test(n)) return 600;
  if (/extra-?bold|ultra-?bold/i.test(n)) return 800;
  if (/black|heavy/i.test(n)) return 900;
  if (/bold/i.test(n)) return 700;
  return 400;
}
const fontCache = new Map<string, Resolved>();
/** Fonts of the document being imported that the browser cannot see by name. */
let importNeeds: FontNeed[] = [];
export function resolveFont(psName: string): Resolved {
  let res = fontCache.get(psName);
  if (!res || !res.available) { res = resolveFontUncached(psName); fontCache.set(psName, res); }
  if (!res.available && !importNeeds.some(n => n.psName === psName)) importNeeds.push({ psName, family: res.family, bold: res.bold, italic: res.italic, weight: res.weight });
  return res;
}

function resolveFontUncached(psName: string): Resolved {
  const boldIn = (s: string) => /bold|black|heavy|semibold|demibold/i.test(s);
  const italicIn = (s: string) => /italic|oblique/i.test(s);
  const [base0, style = ''] = psName.split('-');
  const base = base0.replace(/(PSMT|MT|PS)$/, '');
  const spaced = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  const stripped = base.replace(STYLE_WORDS, '');
  const cands: { family: string; bold: boolean; italic: boolean }[] = [];
  const add = (family: string, bold: boolean, italic: boolean) => { if (family && !cands.some(c => c.family === family)) cands.push({ family, bold, italic }); };
  // family names that already contain the weight (e.g. "Lazurski Bold Cyrillic") need no faux bold
  add(spaced(base), boldIn(style), italicIn(style));
  add(base, boldIn(style), italicIn(style));
  add(spaced(stripped), boldIn(psName), italicIn(psName));
  add(stripped, boldIn(psName), italicIn(psName));
  const firstWord = spaced(base).split(' ')[0];
  add(firstWord, boldIn(psName), italicIn(psName));
  const weight = weightFromName(psName);
  for (const c of cands) if (fontAvailable(c.family)) return { ...c, weight, available: true };
  // not visible to the browser: keep the family name (it may be registered later from the font file)
  const first = cands[0] || { family: 'Arial', bold: false, italic: false };
  return { ...first, bold: boldIn(psName), italic: italicIn(psName), weight, available: false };
}

function textFrom(l: PsdLayer): TextData | null {
  const tx = l.text;
  if (!tx || !tx.text) return null;
  const psRuns = tx.styleRuns || [];
  const ps = { ...(tx.paragraphStyle || {}), ...(tx.paragraphStyleRuns?.[0]?.style || {}) };
  const tr = tx.transform || [1, 0, 0, 1, l.left || 0, l.top || 0];
  // a plain uniform scale is folded into the font size; rotation / skew / non-uniform scale is kept as a matrix
  const uniform = Math.abs(tr[1]) < 1e-4 && Math.abs(tr[2]) < 1e-4 && Math.abs(tr[0] - tr[3]) < 1e-4;
  const scale = uniform ? (Math.abs(tr[3]) || 1) : 1;
  const baseFontSize = (tx.style?.fontSize ?? psRuns.find(r => r.style.fontSize)?.style.fontSize) ?? 12;
  /** Photoshop character style (base style + run overrides) → our style. */
  const charStyle = (over: any): CharStyle => {
    const st = { ...(tx.style || {}), ...(over || {}) };
    const fs = st.fontSize ?? baseFontSize;
    const f = resolveFont(st.font?.name || 'Arial');
    return {
      font: f.family, size: fs * scale, color: colorFrom(st.fillColor, { r: 0, g: 0, b: 0 }),
      bold: !!st.fauxBold || f.weight >= 600, italic: !!st.fauxItalic || f.italic, underline: !!st.underline,
      weight: st.fauxBold ? Math.max(f.weight, 700) : f.weight, psName: st.font?.name, fauxBold: !!st.fauxBold,
      strike: !!st.strikethrough || undefined, caps: st.fontCaps === 2 || undefined,
      tracking: st.tracking ?? 0, vScale: st.verticalScale ?? 1,
      leading: st.autoLeading === false && st.leading ? st.leading / fs : (ps.autoLeading ?? 1.2),
    };
  };
  const just = ps.justification || 'left';
  const align: TextData['align'] = just.includes('center') ? 'center' : just.includes('right') ? 'right' : 'left';
  const first = charStyle(psRuns[0]?.style);
  const td: TextData = {
    ...defaultText(), text: tx.text.replace(/\r/g, '\n').replace(/\n$/, ''),
    font: first.font, size: first.size, color: first.color, bold: first.bold, italic: first.italic, underline: first.underline,
    align, leading: first.leading, tracking: first.tracking, vScale: first.vScale, box: null, psdPixels: true,
    weight: first.weight, psName: first.psName, fauxBold: first.fauxBold, strike: first.strike, caps: first.caps,
  };
  if (psRuns.length > 1) setRuns(td, psRuns.map(r => ({ len: r.length, s: charStyle(r.style) })));
  if (tx.shapeType === 'box' && tx.boxBounds) {
    const [bl, bt, br, bb] = tx.boxBounds;
    td.box = { w: (br - bl) * scale, h: (bb - bt) * scale };
    td.ax = tr[4] + bl * scale; td.ay = tr[5] + bt * scale;
    if (!uniform) td.tf = { m: [tr[0], tr[1], tr[2], tr[3]], dx: -bl, dy: -bt };
  } else {
    // point text: the transform origin is the baseline of the first line at the alignment point
    td.ax = tr[4];
    td.ay = tr[5] - baselineOffset(td);
    if (!uniform) td.tf = { m: [tr[0], tr[1], tr[2], tr[3]], dx: 0, dy: 0 };
  }
  const bb = tx.bounds;
  if (bb) td.psdFrame = { x: tr[4] + bb.left.value * scale, y: tr[5] + bb.top.value * scale, w: (bb.right.value - bb.left.value) * scale, h: (bb.bottom.value - bb.top.value) * scale };
  else if (l.right !== undefined) td.psdFrame = { x: l.left || 0, y: l.top || 0, w: (l.right || 0) - (l.left || 0), h: (l.bottom || 0) - (l.top || 0) };
  return td;
}

const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
/** PostScript-style name for a family, weight and slant (read back by weightFromName on import). */
function psFontName(s: CharStyle): string {
  const w = Math.min(900, Math.max(100, Math.round((s.weight ?? (s.bold ? 700 : 400)) / 100) * 100));
  const style = (w === 400 && s.italic ? '' : WEIGHT_NAMES[w]) + (s.italic ? 'Italic' : '');
  return s.font.replace(/\s+/g, '') + '-' + style;
}

function psStyle(s: CharStyle) {
  return {
    font: { name: s.psName || psFontName(s) }, fontSize: s.size,
    fauxBold: s.psName ? !!s.fauxBold : false, fauxItalic: s.psName ? (s.italic && !/italic|oblique/i.test(s.psName)) : false, underline: s.underline,
    tracking: s.tracking, autoLeading: false, leading: s.size * s.leading, fillColor: colorTo(s.color), verticalScale: s.vScale,
    strikethrough: !!s.strike, fontCaps: s.caps ? 2 : 0,
  };
}

function textTo(l: Layer): PsdLayer['text'] {
  const td = l.text!;
  const runs = getRuns(td);
  const base: PsdLayer['text'] = {
    text: td.text.replace(/\n/g, '\r'),
    style: psStyle(runs[0]?.s ?? baseStyle(td)),
    styleRuns: runs.length > 1 ? runs.map(r => ({ length: r.len, style: psStyle(r.s) })) : undefined,
    paragraphStyle: { justification: td.align },
    antiAlias: 'smooth',
  };
  if (td.box) {
    base.shapeType = 'box';
    if (td.tf) {
      const p = textPivot(td);
      base.boxBounds = [td.ax - p.x, td.ay - p.y, td.ax - p.x + td.box.w, td.ay - p.y + td.box.h];
      base.transform = [...td.tf.m, p.x, p.y];
    } else {
      base.boxBounds = [0, 0, td.box.w, td.box.h];
      base.transform = [1, 0, 0, 1, td.ax, td.ay];
    }
  } else {
    base.shapeType = 'point';
    base.transform = td.tf ? [...td.tf.m, td.ax, td.ay + baselineOffset(td)] : [1, 0, 0, 1, td.ax, td.ay + baselineOffset(td)];
  }
  return base;
}

/* ---------------- masks ---------------- */
function maskFrom(m: NonNullable<PsdLayer['mask']>): (Surface & { enabled: boolean }) | null {
  const fill: 0 | 255 = (m.defaultColor ?? 0) >= 128 ? 255 : 0;
  const left = m.left ?? 0, top = m.top ?? 0;
  const w = Math.max(0, (m.right ?? 0) - left), h = Math.max(0, (m.bottom ?? 0) - top);
  const s = new Surface(Math.max(1, w), Math.max(1, h), left, top, 0) as Surface & { enabled: boolean };
  s.fill = fill;
  s.enabled = !m.disabled;
  if (m.canvas && w && h) {
    const src = ctx2d(m.canvas).getImageData(0, 0, w, h).data;
    const img = new ImageData(w, h);
    for (let i = 0; i < src.length; i += 4) { img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = src[i]; }
    s.ctx.putImageData(img, 0, 0);
  } else if (fill === 255) { const g = s.ctx; g.fillStyle = '#fff'; g.fillRect(0, 0, s.w, s.h); }
  return s;
}

function maskTo(m: Surface & { enabled: boolean }): PsdLayer['mask'] {
  const c = createCanvas(m.w, m.h);
  const g = ctx2d(c);
  const src = m.ctx.getImageData(0, 0, m.w, m.h).data;
  const img = g.createImageData(m.w, m.h);
  for (let i = 0; i < src.length; i += 4) { const v = src[i + 3]; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  return { left: m.x, top: m.y, right: m.x + m.w, bottom: m.y + m.h, defaultColor: m.fill, disabled: !m.enabled, canvas: c };
}

/* ---------------- import ---------------- */
function layerFrom(p: PsdLayer): Layer {
  const isGroup = !!p.children;
  const l = new Layer(isGroup ? 'group' : 'raster', p.name || '');
  l.visible = !p.hidden;
  l.opacity = p.opacity ?? 1;
  l.blend = blendFrom(p.blendMode);
  if (!isGroup && l.blend === 'pass-through') l.blend = 'normal';
  l.clipped = !!p.clipping;
  l.lockAlpha = !!p.transparencyProtected;
  l.effects = effectsFrom(p.effects);
  if (isGroup) {
    l.expanded = p.opened !== false;
    l.children = (p.children || []).map(c => { const n = layerFrom(c); n.parent = l; return n; });
  } else {
    if (p.canvas && p.canvas.width && p.canvas.height) l.content.replace(p.canvas, p.left ?? 0, p.top ?? 0);
    else l.content.replace(createCanvas(1, 1), p.left ?? 0, p.top ?? 0);
    const td = textFrom(p);
    if (td) { l.kind = 'text'; l.text = td; }
  }
  if (p.mask && (p.mask.canvas || p.mask.defaultColor !== undefined) && !p.mask.fromVectorData) l.mask = maskFrom(p.mask);
  return l;
}

export function psdToDoc(buffer: ArrayBuffer, name: string): Doc {
  importNeeds = [];
  const psd = readPsd(buffer, { skipThumbnail: true });
  globalLight = { angle: psd.imageResources?.globalAngle ?? 120, altitude: psd.imageResources?.globalAltitude ?? 30 };
  const d = new Doc(name, psd.width, psd.height);
  if (psd.children && psd.children.length) {
    d.root.children = psd.children.map(c => { const l = layerFrom(c); l.parent = d.root; return l; });
  } else if (psd.canvas) {
    const l = new Layer('raster', 'Background');
    l.content.replace(psd.canvas, 0, 0);
    l.parent = d.root;
    d.root.children = [l];
  }
  const top = d.root.children[d.root.children.length - 1];
  d.setActive(top || null);
  d.setIccProfile(psd.imageResources?.iccProfile);
  d.missingFonts = importNeeds;
  importNeeds = [];
  return d;
}

/** Flattened image of a PSD (used by "Place"). */
export function psdComposite(buffer: ArrayBuffer): HTMLCanvasElement {
  const d = psdToDoc(buffer, 'tmp');
  return d.composite();
}

/* ---------------- export ---------------- */
function layerTo(l: Layer): PsdLayer {
  const p: PsdLayer = {
    name: l.name, hidden: !l.visible, opacity: l.opacity, blendMode: TO_PSD[l.blend] || 'normal',
    clipping: l.clipped, transparencyProtected: l.lockAlpha,
  };
  const fx = effectsTo(l.effects);
  if (fx) p.effects = fx;
  if (l.mask) p.mask = maskTo(l.mask);
  if (l.isGroup) {
    p.opened = l.expanded;
    p.children = l.children.map(layerTo);
    if (l.blend === 'normal') p.blendMode = 'normal';
  } else {
    p.left = l.x; p.top = l.y;
    p.canvas = l.canvas;
    if (l.kind === 'text' && l.text) p.text = textTo(l);
  }
  return p;
}

export function docToPsd(d: Doc): ArrayBuffer {
  const psd: Psd = {
    width: d.width, height: d.height,
    children: d.root.children.map(layerTo),
    canvas: d.composite(),
    ...(d.iccProfile ? { imageResources: { iccProfile: d.iccProfile } } : {}),
  };
  return writePsd(psd, { generateThumbnail: true, noBackground: true, invalidateTextLayers: true });
}
