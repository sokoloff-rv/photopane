/**
 * Filter worker: computes full-size filter results off the main thread, so the sliders of a filter dialog
 * stay responsive while a multi-second result is being made. One worker per dialog; the layer pixels are
 * sent once ('init'), then each 'run' carries only the job.
 */
import { runJob, FxJob } from './fxjobs';

let src: Uint8ClampedArray | null = null;
let w = 0, h = 0;

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: 'init'; src: Uint8ClampedArray; w: number; h: number } | { type: 'run'; id: number; job: FxJob };
  if (m.type === 'init') { src = m.src; w = m.w; h = m.h; return; }
  if (!src) return;
  const dst = new Uint8ClampedArray(src.length);
  runJob(m.job, src, dst, w, h);
  (self as unknown as Worker).postMessage({ id: m.id, dst }, [dst.buffer]);
};
