/**
 * Batch processing: the same simple operations on many images (resize to fit, Auto or a saved Adjust preset,
 * format conversion), saved into a separate folder or over the originals.
 *
 * Files are read and written through Tauri in the desktop app (paths) and through the File System Access API
 * in the browser (handles).
 */
import { ENHANCE_DEFAULTS, EnhanceParams, autoEnhanceParams, enhance, DetailCache } from '../core/adjust';
import { GpuChain } from '../core/gpuchain';
import { findAdjustPreset } from '../core/presets';
import { resampleSharp } from '../ui/resample';
import { extractExif, insertExif } from './exif';

export type BatchFormat = 'same' | 'jpeg' | 'png' | 'webp';
export interface BatchOps {
  resize: boolean; maxW: number; maxH: number;
  /** '' = no correction, '__auto' = Auto, else a preset name */
  adjust: string;
  format: BatchFormat;
  quality: number;
  keepExif: boolean;
  /** true: replace the originals; false: a separate folder */
  overwrite: boolean;
}
export const BATCH_DEFAULTS: BatchOps = { resize: true, maxW: 2000, maxH: 2000, adjust: '', format: 'same', quality: 90, keepExif: true, overwrite: false };

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;
const MIME: Record<Exclude<BatchFormat, 'same'>, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXT: Record<Exclude<BatchFormat, 'same'>, string> = { jpeg: '.jpg', png: '.png', webp: '.webp' };

export interface BatchItem { name: string; read(): Promise<Uint8Array>; write(data: Uint8Array, name: string): Promise<void> }
export interface BatchSource {
  /** a whole folder, or some files of a folder */
  kind: 'folder' | 'files';
  /** folder name shown to the user */
  folder: string;
  items: BatchItem[];
  /** Where a separate output folder goes (for the summary line). */
  outLabel: string;
  /** Prepare the separate output folder; returns a writer into it. */
  openOutput(): Promise<(data: Uint8Array, name: string) => Promise<void>>;
}

const inTauri = () => !!(window as any).__TAURI_INTERNALS__;

/** Name of the separate folder: next to a picked folder, inside the folder of picked files. */
export const outFolderName = (src: { kind: 'folder' | 'files'; folder: string }, processed: string) =>
  src.kind === 'folder' ? `${src.folder} (${processed})` : processed;

/* ---------------- picking ---------------- */

export async function pickSource(kind: 'folder' | 'files', processed: string): Promise<BatchSource | null> {
  return inTauri() ? pickTauri(kind, processed) : pickBrowser(kind, processed);
}

async function pickTauri(kind: 'folder' | 'files', processed: string): Promise<BatchSource | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const fs = await import('@tauri-apps/plugin-fs');
  const path = await import('@tauri-apps/api/path');
  let dir: string;
  let files: string[];
  if (kind === 'folder') {
    const picked = await open({ directory: true });
    if (!picked || Array.isArray(picked)) return null;
    dir = picked;
    const entries = await fs.readDir(dir);
    files = await Promise.all(entries.filter(e => e.isFile && IMAGE_EXT.test(e.name)).map(e => path.join(dir, e.name)));
  } else {
    const picked = await open({ multiple: true, filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }] });
    if (!picked) return null;
    files = (Array.isArray(picked) ? picked : [picked]).filter(p => IMAGE_EXT.test(p));
    if (!files.length) return null;
    dir = await path.dirname(files[0]);
  }
  const folder = await path.basename(dir);
  const outDir = kind === 'folder' ? await path.join(await path.dirname(dir), outFolderName({ kind, folder }, processed)) : await path.join(dir, processed);
  const items: BatchItem[] = await Promise.all(files.sort((a, b) => a.localeCompare(b)).map(async p => {
    const name = await path.basename(p);
    return {
      name,
      read: () => fs.readFile(p),
      write: async (data: Uint8Array, outName: string) => fs.writeFile(await path.join(await path.dirname(p), outName), data),
    };
  }));
  return {
    kind, folder, items, outLabel: outDir,
    openOutput: async () => {
      await fs.mkdir(outDir, { recursive: true });
      return async (data, name) => fs.writeFile(await path.join(outDir, name), data);
    },
  };
}

async function pickBrowser(kind: 'folder' | 'files', processed: string): Promise<BatchSource | null> {
  const w = window as any;
  try {
    if (kind === 'folder') {
      if (!w.showDirectoryPicker) return null;
      const dir = await w.showDirectoryPicker({ mode: 'readwrite' });
      const items: BatchItem[] = [];
      for await (const [name, h] of dir.entries()) {
        if (h.kind !== 'file' || !IMAGE_EXT.test(name)) continue;
        items.push(handleItem(name, h));
      }
      items.sort((a, b) => a.name.localeCompare(b.name));
      // the browser cannot write next to the picked folder: the separate folder goes inside it
      const outName = processed;
      return {
        kind, folder: dir.name, items, outLabel: `${dir.name}/${outName}`,
        openOutput: async () => {
          const out = await dir.getDirectoryHandle(outName, { create: true });
          return async (data, name) => writeHandle(await out.getFileHandle(name, { create: true }), data);
        },
      };
    }
    if (!w.showOpenFilePicker) return null;
    const hs = await w.showOpenFilePicker({ multiple: true, types: [{ description: 'Images', accept: { 'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'] } }] });
    const items = (hs as any[]).filter(h => IMAGE_EXT.test(h.name)).map(h => handleItem(h.name, h));
    if (!items.length) return null;
    return {
      kind, folder: '', items, outLabel: '',
      // picked files give no access to their folder: ask where the separate folder may go
      openOutput: async () => {
        const dir = await w.showDirectoryPicker({ mode: 'readwrite' });
        const out = await dir.getDirectoryHandle(processed, { create: true });
        return async (data, name) => writeHandle(await out.getFileHandle(name, { create: true }), data);
      },
    };
  } catch (e: any) {
    if (e?.name === 'AbortError') return null;
    throw e;
  }
}

function handleItem(name: string, h: any): BatchItem {
  return {
    name,
    read: async () => new Uint8Array(await (await h.getFile()).arrayBuffer()),
    write: async (data, outName) => {
      if (outName !== name) throw new Error('rename');
      await writeHandle(h, data);
    },
  };
}

async function writeHandle(h: any, data: Uint8Array) {
  const ws = await h.createWritable();
  await ws.write(data);
  await ws.close();
}

/* ---------------- processing ---------------- */

const formatOf = (name: string): Exclude<BatchFormat, 'same'> =>
  /\.jpe?g$/i.test(name) ? 'jpeg' : /\.webp$/i.test(name) ? 'webp' : 'png';

/** Process one image; returns the encoded file and its name. */
export async function processImage(bytes: Uint8Array, name: string, ops: BatchOps): Promise<{ data: Uint8Array; name: string }> {
  const srcFmt = formatOf(name);
  const fmt = ops.overwrite || ops.format === 'same' ? srcFmt : ops.format;
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: 'from-image' } as any);
  let c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  // fit inside maxW × maxH (never enlarged)
  if (ops.resize && (c.width > ops.maxW || c.height > ops.maxH)) {
    const k = Math.min(ops.maxW / c.width, ops.maxH / c.height);
    const dw = Math.max(1, Math.round(c.width * k)), dh = Math.max(1, Math.round(c.height * k));
    const out = document.createElement('canvas');
    if (!resampleSharp(c, dw, dh, out)) {
      out.width = dw; out.height = dh;
      const g = out.getContext('2d')!;
      g.imageSmoothingQuality = 'high';
      g.drawImage(c, 0, 0, dw, dh);
    }
    c = out;
  }
  // Auto or a saved Adjust preset
  if (ops.adjust) {
    const w = c.width, h = c.height;
    const g = c.getContext('2d')!;
    const img = g.getImageData(0, 0, w, h);
    let p: EnhanceParams | null;
    if (ops.adjust === '__auto') p = { ...ENHANCE_DEFAULTS, ...autoEnhanceParams(img.data, w, h, null) };
    else { const pr = findAdjustPreset(ops.adjust); p = pr ? { ...ENHANCE_DEFAULTS, ...pr.p } : null; }
    if (p) {
      const gpu = GpuChain.create(w, h, 0, 0, null);
      let res = gpu?.run({ kind: 'enhance', p }, img.data, w, h) ?? null;
      gpu?.dispose();
      if (!res) { res = new Uint8ClampedArray(img.data.length); enhance(p, { w, h, ox: 0, oy: 0, docW: w, docH: h }, new DetailCache(), img.data, res); }
      g.putImageData(new ImageData(res as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
    }
  }
  let blob = await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode'))), MIME[fmt], ops.quality / 100));
  if (fmt === 'jpeg' && ops.keepExif && srcFmt === 'jpeg') {
    const exif = extractExif(bytes.slice().buffer);
    if (exif) blob = await insertExif(blob, exif);
  }
  // the same format keeps the file name (and its extension spelling); another one gets its extension
  const outName = fmt === srcFmt && formatOf(name) === fmt && !/\.(gif|bmp)$/i.test(name) ? name : name.replace(/\.[^.]+$/, '') + EXT[fmt];
  return { data: new Uint8Array(await blob.arrayBuffer()), name: outName };
}

/** Run the batch; `progress(done, total, name)`; `cancelled()` stops between files. Returns the errors. */
export async function runBatch(src: BatchSource, ops: BatchOps, progress: (done: number, total: number, name: string) => void, cancelled: () => boolean): Promise<{ done: number; errors: { name: string; message: string }[] }> {
  const errors: { name: string; message: string }[] = [];
  const write = ops.overwrite ? null : await src.openOutput();
  let done = 0;
  for (const it of src.items) {
    if (cancelled()) break;
    progress(done, src.items.length, it.name);
    try {
      const r = await processImage(await it.read(), it.name, ops);
      if (write) await write(r.data, r.name); else await it.write(r.data, r.name);
      done++;
    } catch (e: any) {
      console.error(e);
      errors.push({ name: it.name, message: e?.message || String(e) });
    }
    // let the progress bar paint
    await new Promise(r => setTimeout(r, 0));
  }
  progress(done, src.items.length, '');
  return { done, errors };
}
