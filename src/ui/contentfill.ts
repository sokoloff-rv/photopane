/**
 * Content-aware fill in the editor: Edit → Fill with «Content-Aware» (the selection on the active layer) and the
 * crop's «Extend: content-aware» (the new area around the picture). The fill itself (core/inpaint.ts) runs in a
 * worker behind a progress window that can be cancelled.
 */
import { app } from '../app';
import { t } from '../i18n';
import { createCanvas, ctx2d, Rect } from '../core/util';
import { Layer } from '../core/layer';
import type { Doc } from '../core/document';
import { busy, toast } from './dialog';

interface FillResult { img: Uint8ClampedArray; ok: boolean }

/** The fill of the pixels where hole > 0, in a worker; null when cancelled or when the worker failed. */
function fillInWorker(img: Uint8ClampedArray, w: number, h: number, hole: Uint8Array): Promise<FillResult | null> {
  return new Promise(resolve => {
    let worker: Worker | null = null;
    let settled = false;
    const finish = (r: FillResult | null) => {
      if (settled) return;
      settled = true;
      worker?.terminate();
      ui.close();
      resolve(r);
    };
    const text = t('fill.contentBusy');
    const ui = busy(text, () => finish(null));
    ui.set(text, 0);
    try {
      worker = new Worker(new URL('../core/inpaintworker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      toast(String(e), 'error');
      finish(null);
      return;
    }
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { progress?: number; done?: boolean; ok?: boolean; img?: Uint8ClampedArray };
      if (m.done) finish({ img: m.img!, ok: !!m.ok });
      else if (m.progress !== undefined) ui.set(text, m.progress);
    };
    worker.onerror = e => { toast(e.message || 'Content-aware fill failed', 'error'); finish(null); };
    worker.postMessage({ img, w, h, hole }, [img.buffer, hole.buffer]);
  });
}

function readRegion(src: CanvasImageSource, sx: number, sy: number, w: number, h: number): Uint8ClampedArray {
  const c = createCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(src, -sx, -sy);
  return g.getImageData(0, 0, w, h).data;
}

/**
 * Edit → Fill → Content-Aware: the selected area of the active layer is rebuilt from the layer's own pixels
 * around it. A soft selection blends the fill in by its strength, and `opacity` over that.
 */
export async function contentAwareFillSelection(opacity: number) {
  const d = app.doc;
  if (!d) return;
  const sel = d.selection;
  if (!sel) { toast(t('fill.needSel'), 'error'); return; }
  const target = app.paintTarget();
  if (!target) return;
  if (target.isMask) { toast(t('ai.needRaster'), 'error'); return; }
  const l = target.layer, s = target.surface;
  // the neighbourhood the fill can take from: the selection's box with room around it (each separate part
  // of the selection takes from its own, smaller neighbourhood inside this)
  const b = sel.bounds;
  const m = Math.max(48, b.w, b.h);
  const x0 = Math.max(0, b.x - m), y0 = Math.max(0, b.y - m);
  const R: Rect = { x: x0, y: y0, w: Math.min(d.width, b.x + b.w + m) - x0, h: Math.min(d.height, b.y + b.h + m) - y0 };
  // the layer's pixels in document coordinates (outside its canvas: transparent)
  const img = readRegion(s.canvas, R.x - s.x, R.y - s.y, R.w, R.h);
  const sa = readRegion(sel.mask, R.x, R.y, R.w, R.h);
  const hole = new Uint8Array(R.w * R.h);
  let n = 0;
  // the faintest edge of a soft selection would hardly change: left out (less to compute)
  for (let i = 0; i < hole.length; i++) if (sa[i * 4 + 3] > 3) { hole[i] = 1; n++; }
  if (!n) return;
  const res = await fillInWorker(img, R.w, R.h, hole);
  if (!res) return;
  if (!res.ok) toast(t('fill.nothingToTake'), 'error');
  // the filled pixels, inside the selection only (by its strength)
  const patch = createCanvas(R.w, R.h), pg = ctx2d(patch);
  pg.putImageData(new ImageData(res.img as Uint8ClampedArray<ArrayBuffer>, R.w, R.h), 0, 0);
  pg.globalCompositeOperation = 'destination-in';
  pg.drawImage(sel.mask, -R.x, -R.y);
  s.ensureCovers(b);
  const g = s.ctx;
  g.save();
  g.globalAlpha = opacity;
  if (l.lockAlpha) {
    // transparency locked: only the colours change
    g.globalCompositeOperation = 'source-atop';
    g.drawImage(patch, R.x - s.x, R.y - s.y);
  } else {
    // the layer's pixels give way by the selection's strength, the fill takes their place (a true blend, also
    // where the layer was transparent)
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(sel.mask, R.x, R.y, R.w, R.h, R.x - s.x, R.y - s.y, R.w, R.h);
    g.globalCompositeOperation = 'lighter';
    g.drawImage(patch, R.x - s.x, R.y - s.y);
  }
  g.restore();
  s.markDirtyDoc(b);
  l.touch();
  app.commit('h.contentFill');
}

/**
 * Crop with «Extend: content-aware»: the area the crop added around the picture is filled from the picture, on a
 * new layer under the others (as «Extend: background color» puts its colour there). `inner` is where the old
 * picture is in the cropped document.
 */
export async function extendWithContent(d: Doc, inner: Rect) {
  const W = d.width, H = d.height;
  const img = readRegion(d.composite(), 0, 0, W, H);
  const hole = new Uint8Array(W * H);
  const x1 = inner.x + inner.w, y1 = inner.y + inner.h;
  for (let y = 0; y < H; y++) {
    const inY = y >= inner.y && y < y1;
    for (let x = 0; x < W; x++) if (!inY || x < inner.x || x >= x1) hole[y * W + x] = 1;
  }
  const res = await fillInWorker(img, W, H, hole);
  if (!res) return;
  if (!res.ok) { toast(t('fill.nothingToTake'), 'error'); return; }
  const l = new Layer('raster', t('layers.contentFill'), W, H);
  const g = l.content.ctx;
  g.putImageData(new ImageData(res.img as Uint8ClampedArray<ArrayBuffer>, W, H), 0, 0);
  // only the new area: the picture itself stays on its layers
  g.clearRect(inner.x, inner.y, inner.w, inner.h);
  d.root.children.unshift(l); l.parent = d.root;
  if (d.root.children[1]) d.root.children[1].clipped = false;
  l.touch();
}
