/**
 * Filters described as plain data ([operation, ...settings]) so the same job can run on the main thread
 * (draft preview, fallback) or in the filter worker (full-size result) and give identical pixels.
 */
import {
  motionBlur, radialBlur, surfaceBlur, highPass, dehaze, denoise, glow, chromatic, pixelate, halftone,
  sepia, posterize, threshold, emboss,
} from './fx';
import { gaussianBlur, unsharp, addNoise } from './filters';

type Buf = Uint8ClampedArray;

export const FX_OPS = {
  motionBlur, radialBlur, surfaceBlur, highPass, dehaze, denoise, glow, chromatic, pixelate, halftone,
  sepia, posterize, threshold, emboss,
  gaussian: (src: Buf, dst: Buf, w: number, h: number, sigma: number) => dst.set(gaussianBlur(src, w, h, sigma)),
  noise: (src: Buf, dst: Buf, _w: number, _h: number, amount: number, gaussian: boolean, mono: boolean) => addNoise(src, dst, amount, gaussian, mono),
  unsharp: (src: Buf, dst: Buf, w: number, h: number, amount: number, radius: number, thr: number) =>
    unsharp(src, dst, gaussianBlur(src, w, h, radius), amount, thr),
};

export type FxOp = keyof typeof FX_OPS;
export type FxJob = [FxOp, ...(number | string | boolean)[]];

export function runJob(job: FxJob, src: Buf, dst: Buf, w: number, h: number) {
  const [op, ...args] = job;
  (FX_OPS[op] as (...a: unknown[]) => void)(src, dst, w, h, ...args);
}
