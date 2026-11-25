import { app } from '../app';
import { Doc } from '../core/document';
import { newRasterLayer } from '../core/layer';
import { createCanvas, ctx2d, canvasToBlob, el, debounce } from '../core/util';
import { t } from '../i18n';
import { openDialog, toast, dialogOpen, sideDialogOpen, nudgeSideDialog } from '../ui/dialog';
import { numberField, select, checkbox } from '../ui/controls';
import { psdToDoc, psdComposite, docToPsd } from './psd';
import { extractExif, insertExif } from './exif';
import { ensureDocFonts } from '../ui/fontprompt';
import { convertToSRGB } from '../core/colormgmt';
import { resampleSharp } from '../ui/resample';

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
  // a window is open (a correction previews on the current layer): nothing is pasted behind it
  if (dialogOpen()) { if (sideDialogOpen()) nudgeSideDialog(); return; }
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
type Fmt = 'psd' | 'png' | 'jpeg' | 'webp' | 'pdf';
const MIME: Record<Fmt, string> = { psd: 'image/vnd.adobe.photoshop', png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' };
const EXT: Record<Fmt, string> = { psd: '.psd', png: '.png', jpeg: '.jpg', webp: '.webp', pdf: '.pdf' };
const fmtOf = (name: string): Fmt => (/\.psd$/i.test(name) ? 'psd' : /\.png$/i.test(name) ? 'png' : /\.webp$/i.test(name) ? 'webp' : 'jpeg');

function flattenedFor(d: Doc, fmt: Fmt): HTMLCanvasElement {
  const c = createCanvas(d.width, d.height);
  const g = ctx2d(c);
  if (fmt === 'jpeg' || fmt === 'pdf') { g.fillStyle = '#fff'; g.fillRect(0, 0, d.width, d.height); }
  g.drawImage(d.composite(), 0, 0);
  if (d.colorProfile) {
    // flattened formats are written as sRGB: convert from the document's colour space
    const img = g.getImageData(0, 0, c.width, c.height);
    convertToSRGB(img.data, d.colorProfile);
    g.putImageData(img, 0, 0);
  }
  return c;
}

/** Encode the document; `size` (export) scales the flattened picture with the sharp resampler. */
export async function encode(d: Doc, fmt: Fmt, quality: number, keepExif: boolean, size?: { w: number; h: number }): Promise<Blob> {
  if (fmt === 'psd') return new Blob([docToPsd(d)], { type: MIME.psd });
  let c = flattenedFor(d, fmt);
  if (size && (size.w !== c.width || size.h !== c.height)) {
    const out = createCanvas(size.w, size.h);
    if (!resampleSharp(c, size.w, size.h, out)) { const g = ctx2d(out); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, size.w, size.h); }
    c = out;
  }
  if (fmt === 'pdf') return jpegToPdf(await canvasToBlob(c, 'image/jpeg', quality / 100), c.width, c.height);
  let blob = await canvasToBlob(c, MIME[fmt], quality / 100);
  if (fmt === 'jpeg' && keepExif && d.exif) blob = await insertExif(blob, d.exif);
  return blob;
}

/** A one-page PDF with the picture as a JPEG image, the page sized for printing at 300 dpi. */
async function jpegToPdf(jpeg: Blob, w: number, h: number): Promise<Blob> {
  const img = new Uint8Array(await jpeg.arrayBuffer());
  const pw = +(w * 72 / 300).toFixed(2), ph = +(h * 72 / 300).toFixed(2);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const put = (x: string | Uint8Array) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); pos += b.length; };
  const obj = (n: number, body: string) => { offsets[n] = pos; put(`${n} 0 obj\n${body}\nendobj\n`); };
  put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = pos;
  put(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`);
  put(img);
  put('\nendstream\nendobj\n');
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = pos;
  put(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map(n => String(offsets[n]).padStart(10, '0') + ' 00000 n \n').join('')}`);
  put(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: MIME.pdf });
}

/** Desktop app (Tauri) without the File System Access API (macOS WebView): system save dialog + file write. */
const inTauri = () => !!(window as any).__TAURI_INTERNALS__;
async function writeTauri(blob: Blob, suggested: string, fmt: Fmt, handle?: { tauriPath: string; name: string }) {
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  let path = handle?.tauriPath;
  if (!path) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const picked = await save({ defaultPath: suggested, filters: [{ name: fmt.toUpperCase(), extensions: [EXT[fmt].slice(1)] }] });
    if (!picked) return null;
    path = picked;
  }
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return { tauriPath: path, name: path.split(/[\\/]/).pop() || suggested };
}

async function writeBlob(blob: Blob, suggested: string, fmt: Fmt, handle?: any): Promise<any> {
  const w = window as any;
  if (handle?.tauriPath || (!handle && !w.showSaveFilePicker && inTauri())) return writeTauri(blob, suggested, fmt, handle);
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

/**
 * Save As: the file the document is kept in (PSD with layers by default); Ctrl+S then writes there.
 * Export As: a copy to publish or send (PNG, JPEG, WebP or a PDF page), optionally at another size; the
 * document stays linked to its own file. Both: the file name, the format as buttons with a one-line hint,
 * quality where it matters and the resulting file size.
 */
function fileDialog(saveAs: boolean) {
  const d = app.doc;
  if (!d) return;
  const formats: Fmt[] = saveAs ? ['psd', 'jpeg', 'png', 'webp'] : ['jpeg', 'png', 'webp', 'pdf'];
  let fmt: Fmt = saveAs ? ((app.settings.saveFmt as Fmt) || 'psd') : ((app.settings.exportFmt as Fmt) || 'jpeg');
  if (!formats.includes(fmt)) fmt = formats[0];
  let quality = app.settings.jpegQuality ?? 92;
  let keepExif = app.settings.keepExif ?? false;
  let size = { w: d.width, h: d.height };
  const nameInput = el('input', { class: 'text-input', type: 'text', value: baseName(d.fileName || d.name), spellcheck: 'false' }) as HTMLInputElement;
  nameInput.addEventListener('keydown', e => e.stopPropagation());
  const extEl = el('span', { class: 'muted mono' }, EXT[fmt]);
  const hint = el('div', { class: 'muted sm save-hint' });
  const sizeEl = el('span', { class: 'mono' }, '…');
  const dimsEl = el('span', { class: 'muted' });
  const qualityRow = el('div', { class: 'form-row' });
  const exifRow = el('div', { class: 'form-row' });
  let seq = 0;
  const updateSize = debounce(async () => {
    const my = ++seq;
    dimsEl.textContent = `${size.w} × ${size.h} ${t('dlg.px')}`;
    if (fmt === 'psd') { sizeEl.textContent = '—'; return; }
    sizeEl.textContent = '…';
    const b = await encode(d, fmt, quality, keepExif, size);
    if (my !== seq) return;
    sizeEl.textContent = b.size > 1048576 ? (b.size / 1048576).toFixed(2) + ' MB' : Math.round(b.size / 1024) + ' KB';
  }, 200);
  const segBtns: HTMLButtonElement[] = [];
  const labels: Record<Fmt, string> = { psd: 'PSD', png: 'PNG', jpeg: 'JPEG', webp: 'WebP', pdf: 'PDF' };
  const seg = el('div', { class: 'seg save-formats' });
  for (const f of formats) {
    const b = el('button', { class: 'seg-btn' }, labels[f]) as HTMLButtonElement;
    b.addEventListener('click', () => { fmt = f; renderRows(); updateSize(); });
    segBtns.push(b); seg.append(b);
  }
  const renderRows = () => {
    segBtns.forEach((b, i) => b.classList.toggle('on', formats[i] === fmt));
    extEl.textContent = EXT[fmt];
    hint.textContent = t('fmt.hint.' + fmt);
    qualityRow.innerHTML = '';
    exifRow.innerHTML = '';
    if (fmt === 'jpeg' || fmt === 'webp' || fmt === 'pdf') qualityRow.append(el('label', {}, t('dlg.quality')), numberField({ value: quality, min: 1, max: 100, unit: '%', onChange: v => { quality = v; updateSize(); } }));
    // metadata only when the source had any (a disabled box with a note only took room)
    if (fmt === 'jpeg' && d.exif) exifRow.append(el('label', {}, ''), checkbox(t('dlg.keepExif'), keepExif, v => { keepExif = v; updateSize(); }));
    exifRow.style.display = exifRow.childElementCount ? '' : 'none';
    qualityRow.style.display = qualityRow.childElementCount ? '' : 'none';
  };
  // Export: another size (proportions kept), e.g. a smaller copy for a site or a messenger
  let sizeRow: HTMLElement | null = null;
  if (!saveAs) {
    const ratio = d.width / d.height;
    let wf: HTMLElement & { set(v: number): void }, hf: HTMLElement & { set(v: number): void }, pf: HTMLElement & { set(v: number): void };
    const setSize = (w: number, h: number, from: 'w' | 'h' | 'p') => {
      size = { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
      if (from !== 'w') wf.set(size.w);
      if (from !== 'h') hf.set(size.h);
      if (from !== 'p') pf.set(Math.round(size.w / d.width * 1000) / 10);
      updateSize();
    };
    wf = numberField({ value: d.width, min: 1, max: 30000, width: 48, onChange: (v, fin) => { if (fin) setSize(v, v / ratio, 'w'); } });
    hf = numberField({ value: d.height, min: 1, max: 30000, width: 48, onChange: (v, fin) => { if (fin) setSize(v * ratio, v, 'h'); } });
    pf = numberField({ value: 100, min: 1, max: 400, step: 0.1, unit: '%', width: 40, onChange: (v, fin) => { if (fin) setSize(d.width * v / 100, d.height * v / 100, 'p'); } });
    sizeRow = el('div', { class: 'form-row' }, el('label', {}, t('dlg.exportSize')),
      el('div', { class: 'save-dims' }, wf, el('span', { class: 'muted' }, '×'), hf, el('span', { class: 'muted' }, t('dlg.px')), pf));
  }
  const body = el('div', { class: 'form save-form' },
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.fileName')), el('div', { class: 'save-name' }, nameInput, extEl)),
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.format')), seg),
    el('div', { class: 'form-row' }, el('label', {}, ''), hint),
    sizeRow, qualityRow, exifRow,
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.fileSize')), el('div', { class: 'save-result' }, sizeEl, dimsEl)),
    el('p', { class: 'muted sm' }, t(saveAs ? 'dlg.saveHint' : 'dlg.exportHint')));
  renderRows();
  updateSize();
  openDialog({
    title: saveAs ? t('dlg.save.title') : t('cmd.export'), body, width: 460, okLabel: t(saveAs ? 'cmd.save' : 'dlg.exportOk'),
    onOk: async () => {
      if (saveAs) app.settings.saveFmt = fmt; else app.settings.exportFmt = fmt;
      app.settings.jpegQuality = quality;
      app.settings.keepExif = keepExif;
      app.saveSettings();
      const blob = await encode(d, fmt, quality, keepExif, saveAs ? undefined : size);
      const name = (nameInput.value.trim().replace(/[\\/:*?"<>|]+/g, '_') || baseName(d.name)) + EXT[fmt];
      const h = await writeBlob(blob, name, fmt);
      if (!h) return false;
      if (saveAs) {
        if (h !== 'download') { d.fileHandle = h; d.fileName = h.name || name; d.name = baseName(d.fileName!); }
        else d.fileName = name;
        d.dirty = false;
      }
      toast(t(saveAs ? 'app.saved' : 'app.exported'));
      app.update('tabs');
    },
  });
}
