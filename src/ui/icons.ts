import {
  createElement, Move, SquareDashed, CircleDashed, LassoSelect, WandSparkles, Crop, Grid3x3, Pipette, Bandage,
  Brush, Stamp, Eraser, PaintBucket, Droplet, Triangle, Pointer, Lollipop, Flame, Type, Shapes, Hand,
  Eye, EyeOff, Lock, LockOpen, Folder, FolderOpen, FolderPlus, Plus, Trash, Copy, ChevronDown, ChevronRight,
  ArrowLeftRight, Sparkles, Square, Circle, Minus, X, Check, Languages, Undo2, Redo2, ZoomIn, ZoomOut,
  Lasso, CornerDownRight, SquarePlus, Link2, Maximize, FilePlus, Image as ImageIcon, Settings, ArrowUpDown,
  TextAlignStart, TextAlignCenter, TextAlignEnd, AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal, Ruler, Magnet, RotateCw, RotateCcw,
} from 'lucide';

type IconNode = Parameters<typeof createElement>[0];

const custom: Record<string, string> = {
  rot180: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13a8 8 0 0 0 16 0"/><path d="M20 13a8 8 0 0 0-14.5-4.6"/><path d="M4 4v5h5"/><text x="12" y="15.5" font-size="7" font-family="sans-serif" text-anchor="middle" fill="currentColor" stroke="none">180</text></svg>`,
  rotAny: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="M4 20 15 6"/><path d="M11 20a7 7 0 0 0-1.6-4.5"/></svg>`,
  canvasFlipH: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16" stroke-dasharray="2 2.5"/><path d="M9 9l-3 3 3 3"/><path d="M15 9l3 3-3 3"/></svg>`,
  canvasFlipV: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18" stroke-dasharray="2 2.5"/><path d="M9 9l3-3 3 3"/><path d="M9 15l3 3 3-3"/></svg>`,
  magLasso: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 17.3C4.8 16.2 3 14.2 3 12c0-3.9 4-7 9-7s9 3.1 9 7-4 7-9 7"/><path d="M9 15.5v3.2a2 2 0 0 1-4 0v-3.2"/><path d="M5 17h4"/></svg>`,
  // Color Replacement: the brush with a circular arrow
  colorReplace: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m11 10 3 3"/><path d="M6.5 21A3.5 3.5 0 1 0 3 17.5a2.62 2.62 0 0 1-.708 1.792A1 1 0 0 0 3 21z"/><path d="M9.969 17.031 21.378 5.624a1 1 0 0 0-3.002-3.002L6.967 14.031"/><path d="M3.5 10A6.5 6.5 0 0 1 10 3.5"/><path d="m7.8 1.4 2.2 2.1-2.2 2.1"/></svg>`,
  polyLasso: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"><path d="M3 21 7 11 15 4 21 9 17 16 9 15Z"/></svg>`,
  flipH: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18" stroke-dasharray="2 2.5"/><path d="M9 6 3 18h6Z"/><path d="M15 6l6 12h-6Z" fill="currentColor" fill-opacity=".3"/></svg>`,
  flipV: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18" stroke-dasharray="2 2.5"/><path d="M6 9 18 3v6Z"/><path d="M6 15l12 6v-6Z" fill="currentColor" fill-opacity=".3"/></svg>`,
  gradient: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="ppg" x1="0" x2="1"><stop offset="0" stop-color="currentColor" stop-opacity="1"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><rect x="3" y="5" width="18" height="14" rx="3"/><rect x="5" y="7" width="14" height="10" rx="1.5" fill="url(#ppg)" stroke="none"/></svg>`,
  mask: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="12" cy="12" r="4.5" fill="currentColor" fill-opacity=".35"/></svg>`,
  fx: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4c-2 0-3 1-3.4 3L4.8 20"/><path d="M4 11h6"/><path d="m13 10 7 8"/><path d="m20 10-7 8"/></svg>`,
  sharpen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 20.5 19.5h-17Z"/><path d="M12 9v6" stroke-linecap="round"/></svg>`,
  shapeTriangle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 4 21 20H3Z"/></svg>`,
  modeNew: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="1.5" fill="currentColor" fill-opacity=".35"/></svg>`,
  modeAdd: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h11v5h7v13H10v-5H3Z" fill="currentColor" fill-opacity=".35" stroke-linejoin="round"/></svg>`,
  modeSub: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 3h11v5h-4v8H3Z" fill="currentColor" fill-opacity=".35"/><rect x="10" y="8" width="11" height="13" stroke-dasharray="2.5 2"/></svg>`,
  modeInt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="11" height="13" stroke-dasharray="2.5 2"/><rect x="10" y="8" width="11" height="13" stroke-dasharray="2.5 2"/><rect x="10" y="8" width="4" height="8" fill="currentColor" fill-opacity=".6" stroke="none"/></svg>`,
  logo: `<svg viewBox="0 0 32 32" fill="none"><rect x="5" y="5" width="15" height="15" rx="3.5" fill="currentColor"/><rect x="12" y="12" width="15" height="15" rx="3.5" stroke="currentColor" stroke-width="2" fill="none" opacity=".55"/></svg>`,
};

const lucideMap: Record<string, IconNode> = {
  move: Move, marquee: SquareDashed, ellipse: CircleDashed, lasso: LassoSelect, freeLasso: Lasso, wand: WandSparkles, crop: Crop,
  perspCrop: Grid3x3, eyedropper: Pipette, heal: Bandage, brush: Brush, stamp: Stamp,
  eraser: Eraser, bucket: PaintBucket, blur: Droplet, triangle: Triangle, smudge: Pointer, dodge: Lollipop,
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
