/**
 * Filter worker: computes full-size filter results off the main thread, so the sliders of a filter dialog
 * stay responsive while a multi-second result is being made. Each message carries the job and its input pixels.
 */
import { runJob, FxJob } from './fxjobs';

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { id: number; job: FxJob; src: Uint8ClampedArray; w: number; h: number };
  const dst = new Uint8ClampedArray(m.src.length);
  runJob(m.job, m.src, dst, m.w, m.h);
  (self as unknown as Worker).postMessage({ id: m.id, dst }, [dst.buffer]);
};
