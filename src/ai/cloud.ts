/**
 * Cloud AI services (Stability AI, Topaz Labs). Keys are stored only in the local settings.
 * Browser dev server: requests go through the Vite proxy (CORS); desktop app: through the Tauri HTTP
 * plugin; otherwise directly.
 */
import { app } from '../app';

export type Service = 'stability' | 'topaz';
const BASE: Record<Service, string> = { stability: 'https://api.stability.ai', topaz: 'https://api.topazlabs.com' };

export class NeedKeyError extends Error {
  constructor(public service: Service) { super('API key needed: ' + service); }
}

export interface AiSettings { stabilityKey?: string; topazKey?: string; upscaleEngine?: 'local' | 'topaz' | 'stability' }
export const aiSettings = (): AiSettings => (app.settings.ai ||= {});
export const hasKey = (s: Service) => !!(s === 'stability' ? aiSettings().stabilityKey : aiSettings().topazKey);

const inTauri = () => !!(window as any).__TAURI_INTERNALS__;

async function aiFetch(service: Service, path: string, init: RequestInit): Promise<Response> {
  if (inTauri()) {
    const { fetch: tfetch } = await import('@tauri-apps/plugin-http');
    return tfetch(BASE[service] + path, init);
  }
  if (import.meta.env.DEV) return fetch(`/api/${service}${path}`, init);
  return fetch(BASE[service] + path, init);
}

async function errorText(r: Response): Promise<string> {
  try {
    const j = await r.clone().json();
    return (Array.isArray(j.errors) ? j.errors.join('; ') : '') || j.message || j.detail || j.error || j.name || r.statusText;
  } catch { return (await r.text().catch(() => '')).slice(0, 200) || r.statusText; }
}

export const canvasBlob = (c: HTMLCanvasElement, type = 'image/png') =>
  new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode'))), type));

export async function blobCanvas(b: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(b);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

/* ---------------- Stability AI (v2beta) ---------------- */
async function stability(path: string, fields: Record<string, Blob | string | number | undefined>): Promise<Blob> {
  const key = aiSettings().stabilityKey;
  if (!key) throw new NeedKeyError('stability');
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === '') continue;
    if (v instanceof Blob) fd.append(k, v, k + '.png'); else fd.append(k, String(v));
  }
  const r = await aiFetch('stability', path, { method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'image/*' }, body: fd });
  if (!r.ok) throw new Error(`Stability AI ${r.status}: ${await errorText(r)}`);
  return r.blob();
}

/** Image with the background made transparent. */
export const stabilityRemoveBg = (image: Blob) => stability('/v2beta/stable-image/edit/remove-background', { image, output_format: 'png' });
/** Remove what the mask (white) covers and fill it naturally. */
/** Extend the image by the given number of pixels on each side. */
export const stabilityOutpaint = (image: Blob, d: { left: number; right: number; up: number; down: number }, prompt?: string) =>
  stability('/v2beta/stable-image/edit/outpaint', { image, ...d, prompt, output_format: 'png' });
/** 4× fast upscale. */
export const stabilityUpscale = (image: Blob) => stability('/v2beta/stable-image/upscale/fast', { image, output_format: 'png' });

/* ---------------- Topaz Labs ---------------- */
export type TopazModel = 'Low Resolution V2' | 'Standard V2' | 'High Fidelity V2';

/**
 * The Topaz model for a picture, as Topaz advises them: Low Resolution for small pictures (web images,
 * thumbnails), High Fidelity for pictures already of good size or sharp (Standard smoothed the fine detail of a
 * good photo), Standard for the soft ones between (an enlarged or blurred picture, where detail is to be made).
 *
 * Sharpness: the fine detail of a central crop (mean |Laplacian| of the luminance) against the same one octave
 * down. Sharp photos give about 0.55–0.65, the same picture enlarged 2× or 4× from a smaller one 0.43–0.45.
 */
export function topazModelFor(c: HTMLCanvasElement): { model: TopazModel; why: 'small' | 'sharp' | 'soft' } {
  const w = c.width, h = c.height;
  if (w * h < 500_000) return { model: 'Low Resolution V2', why: 'small' };
  if (w * h >= 4_000_000) return { model: 'High Fidelity V2', why: 'sharp' };
  const cw = Math.min(w, 1024) & ~1, ch = Math.min(h, 1024) & ~1;
  const t = document.createElement('canvas'); t.width = cw; t.height = ch;
  const g = t.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(c, -((w - cw) >> 1), -((h - ch) >> 1));
  const d = g.getImageData(0, 0, cw, ch).data;
  const L = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) L[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
  const lap = (a: Float32Array, aw: number, ah: number) => {
    let s = 0, n = 0;
    for (let y = 1; y < ah - 1; y++) for (let x = 1; x < aw - 1; x++) {
      const i = y * aw + x;
      s += Math.abs(4 * a[i] - a[i - 1] - a[i + 1] - a[i - aw] - a[i + aw]); n++;
    }
    return n ? s / n : 0;
  };
  const hw = cw >> 1, hh = ch >> 1, half = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
    const i = 2 * y * cw + 2 * x;
    half[y * hw + x] = (L[i] + L[i + 1] + L[i + cw] + L[i + cw + 1]) / 4;
  }
  const coarse = lap(half, hw, hh);
  const ratio = coarse > 0 ? lap(L, cw, ch) / coarse : 0;
  return ratio >= 0.5 ? { model: 'High Fidelity V2', why: 'sharp' } : { model: 'Standard V2', why: 'soft' };
}

export async function topazUpscale(image: Blob, w: number, h: number, model: TopazModel): Promise<Blob> {
  const key = aiSettings().topazKey;
  if (!key) throw new NeedKeyError('topaz');
  const fd = new FormData();
  fd.append('image', image, 'image.png');
  fd.append('model', model);
  fd.append('output_width', String(w));
  fd.append('output_height', String(h));
  fd.append('output_format', 'png');
  const r = await aiFetch('topaz', '/image/v1/enhance', { method: 'POST', headers: { 'X-API-Key': key, Accept: 'image/png' }, body: fd });
  if (!r.ok) throw new Error(`Topaz ${r.status}: ${await errorText(r)}`);
  return r.blob();
}
