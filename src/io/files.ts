import { app } from '../app';
import { Doc } from '../core/document';
import { newRasterLayer } from '../core/layer';
import { createCanvas, ctx2d, canvasToBlob, el, debounce } from '../core/util';
import { t } from '../i18n';
import { openDialog, toast } from '../ui/dialog';
import { numberField, select } from '../ui/controls';

const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif,.psd';

function baseName(name: string) { return name.replace(/\.[^.]+$/, ''); }

export async function decodeImage(file: Blob): Promise<ImageBitmap> {
  return await createImageBitmap(file, { imageOrientation: 'from-image' } as any);
}

export function pickFiles(multiple = true): Promise<File[]> {
  return new Promise(res => {
    const input = el('input', { type: 'file', accept: IMAGE_ACCEPT, multiple }) as HTMLInputElement;
    input.addEventListener('change', () => res([...(input.files || [])]));
    input.click();
  });
}

export async function openFiles(files: File[], mode: 'open' | 'place') {
  for (const f of files) {
    try {
      if (/\.psd$/i.test(f.name)) { toast(`PSD: ${t('app.soon')}`); continue; }
      const bmp = await decodeImage(f);
      if (mode === 'place' && app.doc) placeImage(bmp, baseName(f.name), 'h.place');
      else {
        const d = Doc.fromImage(baseName(f.name), bmp);
        d.root.children[0].name = t('layers.background');
        d.fileName = f.name;
        app.addDoc(d);
      }
    } catch (e) {
      console.error(e);
      toast(`${t('app.openFailed')}: ${f.name}`, 'error');
    }
  }
}

/** Add an image as a new layer centered in the document (or at x,y). */
export function placeImage(img: CanvasImageSource & { width: number; height: number }, name: string, label: string, x?: number, y?: number) {
  const d = app.doc!;
  const l = newRasterLayer(name, img.width, img.height,
    x ?? Math.round((d.width - img.width) / 2), y ?? Math.round((d.height - img.height) / 2));
  l.content.ctx.drawImage(img, 0, 0);
  d.add(l);
  app.layersPanel.clearMulti();
  app.commit(label);
}

export async function handlePaste(e: ClipboardEvent) {
  const tgt = e.target as HTMLElement;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
  const items = [...(e.clipboardData?.items || [])];
  const imgItem = items.find(i => i.type.startsWith('image/'));
  e.preventDefault();
  if (imgItem) {
    const file = imgItem.getAsFile();
    if (!file) return;
    const bmp = await decodeImage(file);
    // prefer internal clipboard position if it is the same image
    if (!app.doc) { const d = Doc.fromImage(t('app.untitled'), bmp); d.root.children[0].name = t('layers.layer') + ' 1'; app.addDoc(d, 'h.new'); return; }
    const ic = app.clipboard;
    if (ic && ic.canvas.width === bmp.width && ic.canvas.height === bmp.height && ic.docW === app.doc.width && ic.docH === app.doc.height) placeImage(ic.canvas, t('layers.layer'), 'h.paste', ic.x, ic.y);
    else placeImage(bmp, t('layers.layer'), 'h.paste');
    return;
  }
  if (app.clipboard && app.doc) {
    const ic = app.clipboard;
    const same = ic.docW === app.doc.width && ic.docH === app.doc.height;
    placeImage(ic.canvas, t('layers.layer'), 'h.paste', same ? ic.x : undefined, same ? ic.y : undefined);
  }
}

export async function readClipboardImage(): Promise<ImageBitmap | null> {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find(x => x.startsWith('image/'));
      if (type) return await decodeImage(await it.getType(type));
    }
  } catch (e) { console.warn(e); }
  if (app.clipboard) return await createImageBitmap(app.clipboard.canvas);
  return null;
}

export async function writeClipboard(canvas: HTMLCanvasElement) {
  try {
    const blob = await canvasToBlob(canvas, 'image/png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } catch (e) { console.warn('clipboard write failed', e); }
}

/* ---------------- saving ---------------- */
type Fmt = 'png' | 'jpeg' | 'webp';
const MIME: Record<Fmt, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const EXT: Record<Fmt, string> = { png: '.png', jpeg: '.jpg', webp: '.webp' };

function flattenedFor(d: Doc, fmt: Fmt): HTMLCanvasElement {
  const c = createCanvas(d.width, d.height);
  const g = ctx2d(c);
  if (fmt === 'jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, d.width, d.height); }
  g.drawImage(d.composite(), 0, 0);
  return c;
}

async function writeBlob(blob: Blob, suggested: string, fmt: Fmt, handle?: any): Promise<any> {
  const w = window as any;
  if (!handle && w.showSaveFilePicker) {
    try {
      handle = await w.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: fmt.toUpperCase(), accept: { [MIME[fmt]]: [EXT[fmt]] } }],
      });
    } catch (e: any) { if (e?.name === 'AbortError') return null; handle = null; }
  }
  if (handle) {
    const ws = await handle.createWritable();
    await ws.write(blob);
    await ws.close();
    return handle;
  }
  const a = el('a', { href: URL.createObjectURL(blob), download: suggested }) as HTMLAnchorElement;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'download';
}

export async function saveDoc(asNew: boolean) {
  const d = app.doc;
  if (!d) return;
  if (!asNew && d.fileHandle && d.fileName) {
    const fmt = (/\.png$/i.test(d.fileName) ? 'png' : /\.webp$/i.test(d.fileName) ? 'webp' : 'jpeg') as Fmt;
    const blob = await canvasToBlob(flattenedFor(d, fmt), MIME[fmt], (app.settings.jpegQuality ?? 92) / 100);
    await writeBlob(blob, d.fileName, fmt, d.fileHandle);
    d.dirty = false;
    toast(t('app.saved'));
    app.update('tabs');
    return;
  }
  exportDialog(true);
}

export function exportDialog(setAsDocFile: boolean) {
  const d = app.doc;
  if (!d) return;
  let fmt: Fmt = (app.settings.exportFmt as Fmt) || 'png';
  let quality = app.settings.jpegQuality ?? 92;
  const sizeEl = el('span', { class: 'mono' }, '…');
  const qualityRow = el('div', { class: 'form-row' });
  const updateSize = debounce(async () => {
    sizeEl.textContent = '…';
    const b = await canvasToBlob(flattenedFor(d, fmt), MIME[fmt], quality / 100);
    sizeEl.textContent = b.size > 1048576 ? (b.size / 1048576).toFixed(2) + ' MB' : Math.round(b.size / 1024) + ' KB';
  }, 200);
  const renderQuality = () => {
    qualityRow.innerHTML = '';
    if (fmt !== 'png') qualityRow.append(el('label', {}, t('dlg.quality')), numberField({ value: quality, min: 1, max: 100, unit: '%', onChange: v => { quality = v; updateSize(); } }));
  };
  const body = el('div', { class: 'form' },
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.format')),
      select<Fmt>([{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPEG' }, { value: 'webp', label: 'WebP' }], fmt, v => { fmt = v; renderQuality(); updateSize(); })),
    qualityRow,
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.fileSize')), sizeEl),
    el('p', { class: 'muted sm' }, `${d.width} × ${d.height} px, sRGB`));
  renderQuality();
  updateSize();
  openDialog({
    title: t('dlg.save.title'), body, width: 380, okLabel: t('cmd.save').replace('…', ''),
    onOk: async () => {
      app.settings.exportFmt = fmt; app.settings.jpegQuality = quality; app.saveSettings();
      const blob = await canvasToBlob(flattenedFor(d, fmt), MIME[fmt], quality / 100);
      const name = baseName(d.fileName || d.name) + EXT[fmt];
      const h = await writeBlob(blob, name, fmt);
      if (!h) return false;
      if (setAsDocFile) {
        if (h !== 'download') { d.fileHandle = h; d.fileName = h.name || name; d.name = baseName(d.fileName!); }
        d.dirty = false;
      }
      toast(t('app.saved'));
      app.update('tabs');
    },
  });
}
