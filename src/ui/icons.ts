import {
  createElement, Move, SquareDashed, CircleDashed, LassoSelect, WandSparkles, Crop, Grid3x3, Pipette, Bandage,
  Brush, Stamp, Eraser, PaintBucket, Droplet, Triangle, Pointer, Lollipop, Flame, Type, Shapes, Hand,
  Eye, EyeOff, Lock, LockOpen, Folder, FolderOpen, FolderPlus, Plus, Trash, Copy, ChevronDown, ChevronRight,
  ArrowLeftRight, Sparkles, Square, Circle, Minus, X, Check, Languages, Undo2, Redo2, ZoomIn, ZoomOut,
  Lasso, CornerDownRight, SquarePlus, Link2, Maximize, FilePlus, Image as ImageIcon, Settings, ArrowUpDown,
  TextAlignStart, TextAlignCenter, TextAlignEnd, AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal, Ruler, Magnet, RotateCw, RotateCcw,
  Italic, Underline, Strikethrough, CaseUpper, SlidersHorizontal, CloudDownload,
} from 'lucide';

type IconNode = Parameters<typeof createElement>[0];

const custom: Record<string, string> = {
  rot180: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13a8 8 0 0 0 16 0"/><path d="M20 13a8 8 0 0 0-14.5-4.6"/><path d="M4 4v5h5"/><text x="12" y="15.5" font-size="7" font-family="sans-serif" text-anchor="middle" fill="currentColor" stroke="none">180</text></svg>`,
  rotAny: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="M4 20 15 6"/><path d="M11 20a7 7 0 0 0-1.6-4.5"/></svg>`,
  canvasFlipH: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16" stroke-dasharray="2 2.5"/><path d="M9 9l-3 3 3 3"/><path d="M15 9l3 3-3 3"/></svg>`,
  canvasFlipV: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18" stroke-dasharray="2 2.5"/><path d="M9 9l3-3 3 3"/><path d="M9 15l3 3 3-3"/></svg>`,
  magLasso: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.34 14A6.8 6.8 0 0 1 2 10c0-4.42 4.48-8 10-8s10 3.58 10 8c0 .34-.03.67-.08 1"/><path d="M7 16.93c.96.43 1.96.74 2.99.91"/><path d="M7 22a5 5 0 0 1-2-4"/><circle cx="5" cy="16" r="2"/><g transform="translate(10.6 10.6) scale(0.58)" stroke-width="3.3"><path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15"/><path d="m5 8 4 4"/><path d="m12 15 4 4"/></g></svg>`,
  // Color Replacement: one colour becomes another (deliberately unlike the brush next to it)
  colorReplace: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="17" r="4" fill="currentColor"/><circle cx="17" cy="7" r="4"/><path d="M5 11.5C5 7.5 7.5 5.5 11 5.8"/><path d="m9.4 3.9 1.9 1.9-1.9 1.9"/></svg>`,
  polyLasso: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14 3 4l17-1 1 11-12 3"/><path d="M7 22a5 5 0 0 1-2-4"/><circle cx="5" cy="16" r="2"/></svg>`,
  flipH: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18" stroke-dasharray="2 2.5"/><path d="M9 6 3 18h6Z"/><path d="M15 6l6 12h-6Z" fill="currentColor" fill-opacity=".3"/></svg>`,
  flipV: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18" stroke-dasharray="2 2.5"/><path d="M6 9 18 3v6Z"/><path d="M6 15l12 6v-6Z" fill="currentColor" fill-opacity=".3"/></svg>`,
  gradient: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="ppg" x1="0" x2="1"><stop offset="0" stop-color="currentColor" stop-opacity="1"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><rect x="3" y="5" width="18" height="14" rx="3"/><rect x="5" y="7" width="14" height="10" rx="1.5" fill="url(#ppg)" stroke="none"/></svg>`,
  mask: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="12" cy="12" r="4.5" fill="currentColor" fill-opacity=".35"/></svg>`,
  fx: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4c-2 0-3 1-3.4 3L4.8 20"/><path d="M4 11h6"/><path d="m13 10 7 8"/><path d="m20 10-7 8"/></svg>`,
  sharpen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 20.5 19.5h-17Z"/><path d="M12 9v6" stroke-linecap="round"/></svg>`,
  shapeTriangle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 4 21 20H3Z"/></svg>`,
  modeNew: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="4.5" width="15" height="15" rx="2.5" fill="currentColor" fill-opacity=".22"/></svg>`,
  modeAdd: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3h7A2.5 2.5 0 0 1 15 5.5V9h3.5A2.5 2.5 0 0 1 21 11.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 9 18.5V15H5.5A2.5 2.5 0 0 1 3 12.5v-7A2.5 2.5 0 0 1 5.5 3z" fill="currentColor" fill-opacity=".22"/></svg>`,
  modeSub: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3h7A2.5 2.5 0 0 1 15 5.5V9h-3.5A2.5 2.5 0 0 0 9 11.5V15H5.5A2.5 2.5 0 0 1 3 12.5v-7A2.5 2.5 0 0 1 5.5 3z" fill="currentColor" fill-opacity=".22"/><rect x="9" y="9" width="12" height="12" rx="2.5" stroke-dasharray="1.6 3.3"/></svg>`,
  modeInt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="12" height="12" rx="2.5" stroke-dasharray="1.6 3.3"/><rect x="9" y="9" width="12" height="12" rx="2.5" stroke-dasharray="1.6 3.3"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" fill-opacity=".22" stroke-dasharray="none"/></svg>`,
  logo: `<svg viewBox="0 0 32 32" fill="none"><rect x="5" y="5" width="15" height="15" rx="3.5" fill="currentColor"/><rect x="12" y="12" width="15" height="15" rx="3.5" stroke="currentColor" stroke-width="2" fill="none" opacity=".55"/></svg>`,
};

const lucideMap: Record<string, IconNode> = {
  move: Move, marquee: SquareDashed, ellipse: CircleDashed, lasso: LassoSelect, freeLasso: Lasso, wand: WandSparkles, crop: Crop,
  perspCrop: Grid3x3, eyedropper: Pipette, heal: Bandage, brush: Brush, stamp: Stamp,
  eraser: Eraser, bucket: PaintBucket, blur: Droplet, triangle: Triangle, smudge: Pointer, dodge: Lollipop,
  italic: Italic, underline: Underline, strike: Strikethrough, caps: CaseUpper, sliders: SlidersHorizontal, cloudDown: CloudDownload,
  burn: Flame, text: Type, shape: Shapes, hand: Hand, eye: Eye, eyeOff: EyeOff, lock: Lock, lockOpen: LockOpen,
  folder: Folder, folderOpen: FolderOpen, folderPlus: FolderPlus, plus: Plus, trash: Trash, copy: Copy,
  chevronDown: ChevronDown, chevronRight: ChevronRight, swap: ArrowLeftRight, sparkles: Sparkles,
  square: Square, circle: Circle, line: Minus, x: X, check: Check, languages: Languages, undo: Undo2, redo: Redo2,
  zoomIn: ZoomIn, zoomOut: ZoomOut, clip: CornerDownRight, newLayer: SquarePlus, link: Link2, fit: Maximize,
  fileNew: FilePlus, image: ImageIcon, settings: Settings, updown: ArrowUpDown,
  alignL: TextAlignStart, alignC: TextAlignCenter, alignR: TextAlignEnd,
  layAlignL: AlignStartVertical, layAlignCX: AlignCenterVertical, layAlignR: AlignEndVertical,
  layAlignT: AlignStartHorizontal, layAlignCY: AlignCenterHorizontal, layAlignB: AlignEndHorizontal,
  ruler: Ruler, magnet: Magnet, rotCW: RotateCw, rotCCW: RotateCcw,
};

export function icon(name: string, size = 18): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'ico';
  if (custom[name]) {
    wrap.innerHTML = custom[name];
    const svg = wrap.firstElementChild as SVGElement;
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
  } else {
    const node = lucideMap[name];
    if (node) {
      const svg = createElement(node, { width: size, height: size, 'stroke-width': 1.75 } as any);
      wrap.append(svg);
    }
  }
  return wrap;
}

/* ---------- tool cursors (icon with a white halo, like Photoshop) ---------- */
function nodeMarkup(node: IconNode): string {
  return (node as any[]).map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
}

const cursorCache = new Map<string, string>();
/** CSS cursor built from an icon; (hx, hy) is the hotspot in 24×24 icon space. */
export function iconCursor(name: string, hx: number, hy: number, fallback = 'crosshair'): string {
  const key = `${name}|${hx}|${hy}`;
  let c = cursorCache.get(key);
  if (c) return c;
  let inner: string;
  if (custom[name]) inner = custom[name].replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  else if (lucideMap[name]) inner = nodeMarkup(lucideMap[name]);
  else return fallback;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<g stroke="#fff" stroke-width="4">${inner}</g><g stroke="#000" stroke-width="1.6">${inner}</g></svg>`;
  c = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, ${fallback}`;
  cursorCache.set(key, c);
  return c;
}

/** Photoshop-style cursor: small arrow (hotspot at its tip) with a tool badge at the lower right. */
export function arrowBadgeCursor(badge: string): string {
  const key = 'arrow|' + badge;
  let c = cursorCache.get(key);
  if (c) return c;
  let inner = '';
  if (custom[badge]) inner = custom[badge].replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  else if (lucideMap[badge]) inner = nodeMarkup(lucideMap[badge]);
  const arrow = 'M1.5 1.5v15l4-3.6 2.6 5.8 2.4-1.1-2.6-5.6h5.4Z';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${arrow}" fill="#000" stroke="#fff" stroke-width="1.2"/>` +
    `<g transform="translate(14 14) scale(0.62)"><g stroke="#fff" stroke-width="5">${inner}</g><g stroke="#000" stroke-width="2.2">${inner}</g></g></svg>`;
  c = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 1 1, default`;
  cursorCache.set(key, c);
  return c;
}
