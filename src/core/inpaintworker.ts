/**
 * Content-aware fill worker: the fill (core/inpaint.ts) takes from a fraction of a second to several seconds, and
 * the editor stays responsive (the progress bar moves, Cancel works) while it runs.
 */
import { contentAwareFill } from './inpaint';

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { img: Uint8ClampedArray; w: number; h: number; hole: Uint8Array };
  let last = 0;
  const ok = contentAwareFill(m.img, m.w, m.h, m.hole, p => {
    const now = performance.now();
    if (now - last < 80) return;
    last = now;
    (self as unknown as Worker).postMessage({ progress: p });
  });
  // the hole comes back too: what is still 1 there could not be filled
  (self as unknown as Worker).postMessage({ done: true, ok, img: m.img, hole: m.hole }, [m.img.buffer, m.hole.buffer]);
};
