/**
 * Local 4× upscaling with Real-ESRGAN (realesr-general-x4v3, BSD-3) running in the browser through
 * ONNX Runtime Web (WebGPU when available, otherwise WebAssembly). The 4.8 MB model is downloaded on
 * first use and cached.
 */
// the WebGPU bundle of ONNX Runtime 1.2x+ runs on the asyncify build (it also has the CPU backend)
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';

const MODEL_URL = 'https://huggingface.co/jonathanst29/tinier-upscale-models/resolve/main/realesr-general-x4v3.onnx';
const CACHE = 'photopane-models-v1';

type Ort = typeof import('onnxruntime-web/webgpu');
let ortP: Promise<Ort> | null = null;
let sessionP: Promise<{ ort: Ort; s: import('onnxruntime-web').InferenceSession }> | null = null;

/** Let the UI update between tiles; unlike setTimeout it is not throttled in a background window. */
function yieldToUi(): Promise<void> {
  return new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
}

async function modelBytes(onStatus: (p: number) => void): Promise<ArrayBuffer> {
  const cache = 'caches' in window ? await caches.open(CACHE).catch(() => null) : null;
  const hit = cache ? await cache.match(MODEL_URL) : undefined;
  if (hit) return hit.arrayBuffer();
  const r = await fetch(MODEL_URL);
  if (!r.ok || !r.body) throw new Error('model download ' + r.status);
  const total = +(r.headers.get('content-length') || 0);
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (total) onStatus(got / total);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  if (cache) await cache.put(MODEL_URL, new Response(buf.slice().buffer, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
  return buf.buffer;
}

async function session(onDownload: (p: number) => void) {
  if (!sessionP) {
    sessionP = (async () => {
      ortP ||= import('onnxruntime-web/webgpu');
      const ort = await ortP;
      ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
      const bytes = new Uint8Array(await modelBytes(onDownload));
      let s;
      try { s = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu', 'wasm'] }); }
      catch { s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }); }
      return { ort, s };
    })();
    sessionP.catch(() => { sessionP = null; });
  }
  return sessionP;
}

/**
 * Upscale a canvas 4× (colour by the network, alpha bicubic). Processed in tiles with overlap so large
 * images fit in memory; `onProgress` gets 0..1, `cancelled()` stops between tiles.
 */
export async function esrgan4x(src: HTMLCanvasElement, onProgress: (stage: 'download' | 'run', p: number) => void, cancelled: () => boolean): Promise<HTMLCanvasElement | null> {
  const { ort, s } = await session(p => onProgress('download', p));
  const W = src.width, H = src.height;
  const data = src.getContext('2d')!.getImageData(0, 0, W, H).data;
  const out = document.createElement('canvas');
  out.width = W * 4; out.height = H * 4;
  const og = out.getContext('2d')!;
  const T = 256, P = 12;
  const tiles: { x: number; y: number; w: number; h: number }[] = [];
  for (let y = 0; y < H; y += T) for (let x = 0; x < W; x += T) tiles.push({ x, y, w: Math.min(T, W - x), h: Math.min(T, H - y) });
  const inName = s.inputNames[0], outName = s.outputNames[0];
  for (let ti = 0; ti < tiles.length; ti++) {
    if (cancelled()) return null;
    const tl = tiles[ti];
    // fully transparent tiles stay empty (sparse layers: frames, logos, text effects)
    let empty = true;
    for (let y = tl.y; y < tl.y + tl.h && empty; y++) for (let x = tl.x; x < tl.x + tl.w; x++) if (data[(y * W + x) * 4 + 3]) { empty = false; break; }
    if (empty) { onProgress('run', (ti + 1) / tiles.length); continue; }
    // tile with context around it
    const x0 = Math.max(0, tl.x - P), y0 = Math.max(0, tl.y - P), x1 = Math.min(W, tl.x + tl.w + P), y1 = Math.min(H, tl.y + tl.h + P);
    const tw = x1 - x0, th = y1 - y0;
    const input = new Float32Array(3 * tw * th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const i = ((y0 + y) * W + x0 + x) * 4, k = y * tw + x;
      input[k] = data[i] / 255; input[tw * th + k] = data[i + 1] / 255; input[2 * tw * th + k] = data[i + 2] / 255;
    }
    const res = await s.run({ [inName]: new ort.Tensor('float32', input, [1, 3, th, tw]) });
    const o = res[outName].data as Float32Array;
    const OW = tw * 4, OH = th * 4, plane = OW * OH;
    // keep only the tile's own area
    const cx = (tl.x - x0) * 4, cy = (tl.y - y0) * 4, cw = tl.w * 4, ch = tl.h * 4;
    const img = og.createImageData(cw, ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const k = (cy + y) * OW + cx + x, p = (y * cw + x) * 4;
      img.data[p] = o[k] * 255; img.data[p + 1] = o[plane + k] * 255; img.data[p + 2] = o[2 * plane + k] * 255; img.data[p + 3] = 255;
    }
    og.putImageData(img, tl.x * 4, tl.y * 4);
    res[outName].dispose?.();
    onProgress('run', (ti + 1) / tiles.length);
    await yieldToUi();
  }
  // alpha: bicubic from the source
  let transparent = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { transparent = true; break; }
  if (transparent) {
    const a = document.createElement('canvas'); a.width = out.width; a.height = out.height;
    const ag = a.getContext('2d')!; ag.imageSmoothingQuality = 'high'; ag.drawImage(src, 0, 0, out.width, out.height);
    og.globalCompositeOperation = 'destination-in'; og.drawImage(a, 0, 0); og.globalCompositeOperation = 'source-over';
  }
  return out;
}
