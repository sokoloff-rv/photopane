import { app } from '../app';
import { Doc } from '../core/document';
import { newRasterLayer } from '../core/layer';
import { createCanvas, ctx2d, canvasToBlob, el, debounce } from '../core/util';
import { t } from '../i18n';
import { openDialog, toast } from '../ui/dialog';
import { numberField, select, checkbox } from '../ui/controls';
import { psdToDoc, psdComposite, docToPsd } from './psd';
import { extractExif, insertExif } from './exif';
import { ensureDocFonts } from '../ui/fontprompt';
import { convertToSRGB } from '../core/colormgmt';

const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif,.psd';

function baseName(name: string) { return name.replace(/\.[^.]+$/, ''); }

export async function decodeImage(file: Blob): Promise<ImageBitmap> {
  return await createImageBitmap(file, { imageOrientation: 'from-image' } as any);
}

export interface PickedFile { file: File; handle?: any }

/** Open dialog; uses the File System Access API when available so files can be saved back in place. */
export async function pickFiles(multiple = true): Promise<PickedFile[]> {
  const w = window as any;
  if (w.showOpenFilePicker) {
    try {
      const handles = await w.showOpenFilePicker({
        multiple,
        types: [{ description: 'Images', accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'], 'image/vnd.adobe.photoshop': ['.psd'] } }],
      });
      return Promise.all(handles.map(async (h: any) => ({ file: await h.getFile(), handle: h })));
    } catch (e: any) { if (e?.name === 'AbortError') return []; }
  }
  return new Promise(res => {
    const input = el('input', { type: 'file', accept: IMAGE_ACCEPT, multiple }) as HTMLInputElement;
    input.addEventListener('change', () => res([...(input.files || [])].map(file => ({ file }))));
    input.click();
  });
}

export async function openFiles(files: (File | PickedFile)[], mode: 'open' | 'place') {
  for (const item of files) {
    const f = item instanceof File ? item : item.file;
    const handle = item instanceof File ? undefined : item.handle;
    try {
      if (/\.psd$/i.test(f.name)) {
        const buf = await f.arrayBuffer();
        if (mode === 'place' && app.doc) { placeImage(psdComposite(buf), baseName(f.name), 'h.place'); continue; }
        const d = psdToDoc(buf, baseName(f.name));
        d.fileName = f.name;
        d.fileHandle = handle || null;
        app.addDoc(d);
        ensureDocFonts(d);
        continue;
      }
      const bmp = await decodeImage(f);
      if (mode === 'place' && app.doc) placeImage(bmp, baseName(f.name), 'h.place');
      else {
        const d = Doc.fromImage(baseName(f.name), bmp);
        d.root.children[0].name = t('layers.background');
        d.fileName = f.name;
        d.fileHandle = handle || null;
        if (/\.jpe?g$/i.test(f.name)) d.exif = extractExif(await f.arrayBuffer());
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
    if (!app.doc) { const d = Doc.fromImage(t('app.untitled'), bmp); d.root.children[0].name = t('layers.layer') + ' 1'; app.addDoc(d, 'h.new'); return; }
    // prefer internal clipboard position if it is the same image
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
type Fmt = 'psd' | 'png' | 'jpeg' | 'webp';
const MIME: Record<Fmt, string> = { psd: 'image/vnd.adobe.photoshop', png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const EXT: Record<Fmt, string> = { psd: '.psd', png: '.png', jpeg: '.jpg', webp: '.webp' };
const fmtOf = (name: string): Fmt => (/\.psd$/i.test(name) ? 'psd' : /\.png$/i.test(name) ? 'png' : /\.webp$/i.test(name) ? 'webp' : 'jpeg');

function flattenedFor(d: Doc, fmt: Fmt): HTMLCanvasElement {
  const c = createCanvas(d.width, d.height);
  const g = ctx2d(c);
  if (fmt === 'jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, d.width, d.height); }
  g.drawImage(d.composite(), 0, 0);
  if (d.colorProfile) {
    // flattened formats are written as sRGB: convert from the document's colour space
    const img = g.getImageData(0, 0, c.width, c.height);
    convertToSRGB(img.data, d.colorProfile);
    g.putImageData(img, 0, 0);
  }
  return c;
}

export async function encode(d: Doc, fmt: Fmt, quality: number, keepExif: boolean): Promise<Blob> {
  if (fmt === 'psd') return new Blob([docToPsd(d)], { type: MIME.psd });
  let blob = await canvasToBlob(flattenedFor(d, fmt), MIME[fmt], quality / 100);
  if (fmt === 'jpeg' && keepExif && d.exif) blob = await insertExif(blob, d.exif);
  return blob;
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

/** Ctrl+S: write back to the opened file (PSD keeps layers), otherwise Save As. */
export async function saveDoc(asNew: boolean) {
  const d = app.doc;
  if (!d) return;
  if (!asNew && d.fileHandle && d.fileName) {
    const fmt = fmtOf(d.fileName);
    const blob = await encode(d, fmt, app.settings.jpegQuality ?? 92, app.settings.keepExif ?? false);
    await writeBlob(blob, d.fileName, fmt, d.fileHandle);
    d.dirty = false;
    toast(t('app.saved'));
    app.update('tabs');
    return;
  }
  fileDialog(true);
}

export function exportDialog(_setAsDocFile = false) { fileDialog(false); }

/** Save As (PSD by default) or Export As (flattened formats with a live file size estimate). */
function fileDialog(saveAs: boolean) {
  const d = app.doc;
  if (!d) return;
  const formats: Fmt[] = saveAs ? ['psd', 'png', 'jpeg', 'webp'] : ['png', 'jpeg', 'webp'];
  let fmt: Fmt = saveAs ? 'psd' : ((app.settings.exportFmt as Fmt) || 'png');
  if (!formats.includes(fmt)) fmt = formats[0];
  let quality = app.settings.jpegQuality ?? 92;
  let keepExif = app.settings.keepExif ?? false;
  const sizeEl = el('span', { class: 'mono' }, '…');
  const qualityRow = el('div', { class: 'form-row' });
  const exifRow = el('div', { class: 'form-row' });
  let seq = 0;
  const updateSize = debounce(async () => {
    const my = ++seq;
    if (fmt === 'psd') { sizeEl.textContent = '—'; return; }
    sizeEl.textContent = '…';
    const b = await encode(d, fmt, quality, keepExif);
    if (my !== seq) return;
    sizeEl.textContent = b.size > 1048576 ? (b.size / 1048576).toFixed(2) + ' MB' : Math.round(b.size / 1024) + ' KB';
  }, 200);
  const renderRows = () => {
    qualityRow.innerHTML = '';
    exifRow.innerHTML = '';
    if (fmt === 'jpeg' || fmt === 'webp') qualityRow.append(el('label', {}, t('dlg.quality')), numberField({ value: quality, min: 1, max: 100, unit: '%', onChange: v => { quality = v; updateSize(); } }));
    if (fmt === 'jpeg') {
      const cb = checkbox(t('dlg.keepExif'), keepExif && !!d.exif, v => { keepExif = v; updateSize(); });
      if (!d.exif) { (cb.querySelector('input') as HTMLInputElement).disabled = true; cb.style.opacity = '0.5'; }
      exifRow.append(el('label', {}, ''), cb);
      if (!d.exif) exifRow.append(el('span', { class: 'muted sm' }, t('dlg.noExif')));
    }
  };
  const labels: Record<Fmt, string> = { psd: t('dlg.fmt.psd'), png: 'PNG', jpeg: 'JPEG', webp: 'WebP' };
  const body = el('div', { class: 'form' },
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.format')),
      select<Fmt>(formats.map(f => ({ value: f, label: labels[f] })), fmt, v => { fmt = v; renderRows(); updateSize(); })),
    qualityRow, exifRow,
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.fileSize')), sizeEl),
    el('p', { class: 'muted sm' }, `${d.width} × ${d.height} px, sRGB`));
  renderRows();
  updateSize();
  openDialog({
    title: saveAs ? t('dlg.save.title') : t('cmd.export'), body, width: 420, okLabel: t('cmd.save'),
    onOk: async () => {
      if (!saveAs) app.settings.exportFmt = fmt;
      app.settings.jpegQuality = quality;
      app.settings.keepExif = keepExif;
      app.saveSettings();
      const blob = await encode(d, fmt, quality, keepExif);
      const name = baseName(d.fileName || d.name) + EXT[fmt];
      const h = await writeBlob(blob, name, fmt);
      if (!h) return false;
      if (saveAs) {
        if (h !== 'download') { d.fileHandle = h; d.fileName = h.name || name; d.name = baseName(d.fileName!); }
        else d.fileName = name;
        d.dirty = false;
      }
      toast(t('app.saved'));
      app.update('tabs');
    },
  });
}
