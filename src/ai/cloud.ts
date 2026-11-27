/**
 * Cloud AI services (Stability AI, Topaz Labs). Keys are stored only in the local settings.
 * Browser dev server: requests go through the Vite proxy (CORS); desktop app: through the Tauri HTTP
 * plugin; otherwise directly.
 */
import { app } from '../app';
import { t } from '../i18n';

export type Service = 'stability' | 'topaz';
const NAME: Record<Service, string> = { stability: 'Stability AI', topaz: 'Topaz Labs' };

/**
 * What Stability AI accepts (its API reference). Pictures are made to fit before they are sent where that can
 * be done unnoticed (reduced, re-encoded); otherwise the window says what does not fit before anything is sent.
 */
export const STABILITY = {
  /** a whole request at most */
  maxBytes: 10 * 1024 * 1024,
  removeBg: { minSide: 64, maxPx: 4_194_304 },
  outpaint: { minSide: 64, maxPx: 9_437_184, maxRatio: 2.5, maxExtend: 2000 },
  upscale: { minSide: 32, maxSide: 1536, maxPx: 1_048_576 },
};
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
  } catch {
    // a page instead of an answer (a firewall or proxy in front of the service): its HTML is no message
    const text = (await r.text().catch(() => '')).trim();
    const html = /html/i.test(r.headers.get('content-type') ?? '') || /<[a-z!/][^>]*>/i.test(text);
    return (text && !html ? text.slice(0, 200) : '') || r.statusText || `HTTP ${r.status}`;
  }
}

/** A refused request in words: the usual causes by status; what the service said only where it adds something. */
async function failure(service: Service, r: Response): Promise<Error> {
  const detail = await errorText(r);
  const s = r.status;
  const why = s === 401 ? t('ai.err.key')
    : s === 402 ? t('ai.err.credits')
    : s === 403 ? (/moderat|flag/i.test(detail) ? t('ai.err.moderated') : service === 'topaz' ? t('ai.err.access', detail) : t('ai.err.key'))
    : s === 413 ? t('ai.err.large')
    : s === 429 ? t('ai.err.busy')
    : s >= 500 ? t('ai.err.server')
    : t('ai.err.rejected', detail);
  return new Error(`${NAME[service]}: ${why}`);
}

/** The request, and a failure to reach the service (no connection) in words. */
async function send(service: Service, path: string, init: RequestInit): Promise<Response> {
  let r: Response;
  try { r = await aiFetch(service, path, init); } catch { throw new Error(`${NAME[service]}: ${t('ai.err.network')}`); }
  if (!r.ok) throw await failure(service, r);
  return r;
}

export const canvasBlob = (c: HTMLCanvasElement, type = 'image/png', quality?: number) =>
  new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode'))), type, quality));

/**
 * The picture as a file Stability takes: PNG (exact, with transparency); when that is over its limit for a
 * request (a large photo), WebP, which keeps the transparency, at a quality that fits; where the browser cannot
 * make WebP (some Linux WebKit builds hand back PNG instead), JPEG over white. Never more than the limit.
 */
export async function sendableBlob(c: HTMLCanvasElement, maxBytes = STABILITY.maxBytes - 64 * 1024): Promise<Blob> {
  const png = await canvasBlob(c);
  if (png.size <= maxBytes) return png;
  for (const q of [0.95, 0.88, 0.8, 0.7]) {
    const b = await canvasBlob(c, 'image/webp', q);
    if (b.type !== 'image/webp') break;
    if (b.size <= maxBytes) return b;
  }
  const flat = document.createElement('canvas');
  flat.width = c.width; flat.height = c.height;
  const g = flat.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(c, 0, 0);
  for (const q of [0.92, 0.85, 0.75, 0.6]) {
    const b = await canvasBlob(flat, 'image/jpeg', q);
    if (b.size <= maxBytes) return b;
  }
  throw new Error(`Stability AI: ${t('ai.err.large')}`);
}

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
    if (v instanceof Blob) fd.append(k, v, k + (v.type === 'image/webp' ? '.webp' : v.type === 'image/jpeg' ? '.jpg' : '.png')); else fd.append(k, String(v));
  }
  const r = await send('stability', path, { method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'image/*' }, body: fd });
  return r.blob();
}

/** Image with the background made transparent. */
export const stabilityRemoveBg = (image: Blob) => stability('/v2beta/stable-image/edit/remove-background', { image, output_format: 'png' });
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
  const r = await send('topaz', '/image/v1/enhance', { method: 'POST', headers: { 'X-API-Key': key, Accept: 'image/png' }, body: fd });
  return r.blob();
}
