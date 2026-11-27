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
export async function topazUpscale(image: Blob, w: number, h: number): Promise<Blob> {
  const key = aiSettings().topazKey;
  if (!key) throw new NeedKeyError('topaz');
  const fd = new FormData();
  fd.append('image', image, 'image.png');
  fd.append('model', 'Standard V2');
  fd.append('output_width', String(w));
  fd.append('output_height', String(h));
  fd.append('output_format', 'png');
  const r = await aiFetch('topaz', '/image/v1/enhance', { method: 'POST', headers: { 'X-API-Key': key, Accept: 'image/png' }, body: fd });
  if (!r.ok) throw new Error(`Topaz ${r.status}: ${await errorText(r)}`);
  return r.blob();
}
