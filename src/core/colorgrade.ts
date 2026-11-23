/**
 * HSL mixer and Toning. The CPU code here and the shaders in gpuchain.ts do the same maths step for step,
 * so the preview (GPU) and the result agree.
 *
 * HSL mixer: eight colour ranges (centres below); a pixel belongs to the two ranges around its hue (linear
 * blend between their centres), so neighbouring colours change smoothly. Greys are left alone: the hue and
 * lightness changes fade out for unsaturated pixels, and saturation is multiplied.
 *
 * Toning: one tint for the shadows and one for the highlights (hue + saturation), the balance moves the
 * border between them; pure black and white stay neutral. The tint is added as colour only (its luminance
 * is removed), so brightness stays.
 */
import { rgbToHsl, hslToRgb } from './color';

/** Centres of the ranges, degrees: red, orange, yellow, green, aqua, blue, purple, magenta. */
export const HSL_CENTERS = [0, 30, 60, 120, 180, 225, 270, 315];
export const HSL_KEYS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;

export interface HslParams { hue: number[]; sat: number[]; lum: number[] }
export const hslDefaults = (): HslParams => ({ hue: Array(8).fill(0), sat: Array(8).fill(0), lum: Array(8).fill(0) });
export const hslIsIdentity = (p: HslParams) => [...p.hue, ...p.sat, ...p.lum].every(v => !v);

export interface ToneParams { shHue: number; shSat: number; hiHue: number; hiSat: number; balance: number }
export const TONE_DEFAULTS: ToneParams = { shHue: 220, shSat: 0, hiHue: 40, hiSat: 0, balance: 0 };

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Weights of the 8 ranges for a hue in degrees (two neighbours share it). */
export function hslWeights(hDeg: number, out: Float32Array) {
  out.fill(0);
  const h = ((hDeg % 360) + 360) % 360;
  for (let i = 0; i < 8; i++) {
    const a = HSL_CENTERS[i], b = i === 7 ? 360 : HSL_CENTERS[i + 1];
    if (h >= a && h < b) {
      const t = (h - a) / (b - a);
      out[i] = 1 - t; out[(i + 1) % 8] += t;
      return;
    }
  }
}

export function hslMix(p: HslParams, src: Uint8ClampedArray, dst: Uint8ClampedArray) {
  const w = new Float32Array(8);
  for (let i = 0; i < src.length; i += 4) {
    const [h, s, l] = rgbToHsl(src[i] / 255, src[i + 1] / 255, src[i + 2] / 255);
    dst[i + 3] = src[i + 3];
    if (s === 0) { dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; continue; }
    hslWeights(h * 360, w);
    let dh = 0, ds = 0, dl = 0;
    for (let k = 0; k < 8; k++) { dh += w[k] * p.hue[k]; ds += w[k] * p.sat[k]; dl += w[k] * p.lum[k]; }
    const sw = smooth(0.02, 0.2, s);
    const h2 = (h + (dh / 100) * (30 / 360) * sw + 1) % 1;
    const s2 = Math.min(1, Math.max(0, s * (1 + ds / 100)));
    const k = (dl / 100) * 0.5 * sw;
    const l2 = Math.min(1, Math.max(0, k > 0 ? l + (1 - l) * k : l + l * k));
    const [r, g, b] = hslToRgb(h2, s2, l2);
    dst[i] = r * 255; dst[i + 1] = g * 255; dst[i + 2] = b * 255;
  }
}

/** Colour of a tint (hue in degrees) without its luminance, so adding it changes colour only. */
export function tintChroma(hueDeg: number): [number, number, number] {
  const [r, g, b] = hslToRgb((((hueDeg % 360) + 360) % 360) / 360, 1, 0.5);
  const y = luma(r, g, b);
  return [r - y, g - y, b - y];
}

export function splitTone(p: ToneParams, src: Uint8ClampedArray, dst: Uint8ClampedArray) {
  const ts = tintChroma(p.shHue), th = tintChroma(p.hiHue);
  const as = p.shSat / 100 * 0.35, ah = p.hiSat / 100 * 0.35;
  const mid = 0.5 - p.balance / 100 * 0.3;
  for (let i = 0; i < src.length; i += 4) {
    const r = src[i] / 255, g = src[i + 1] / 255, b = src[i + 2] / 255;
    const L = luma(r, g, b);
    const t = smooth(mid - 0.3, mid + 0.3, L);
    const fade = Math.min(1, Math.max(0, L * 5)) * Math.min(1, Math.max(0, (1 - L) * 5));
    const ks = as * (1 - t) * fade, kh = ah * t * fade;
    dst[i] = (r + ts[0] * ks + th[0] * kh) * 255;
    dst[i + 1] = (g + ts[1] * ks + th[1] * kh) * 255;
    dst[i + 2] = (b + ts[2] * ks + th[2] * kh) * 255;
    dst[i + 3] = src[i + 3];
  }
}
