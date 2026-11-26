/**
 * The slider scale for sizes (brush, eraser, stamp, healing, retouch brushes, text size), as in Photoshop:
 * 200 px at 80 % of the track and the largest size at its end.
 *
 * Up to 200 px the size grows almost evenly (a slight acceleration), so every pixel of the track moves the
 * size by about the same amount; past 80 % it grows fast to the maximum. The logarithmic scale before had
 * the opposite fault: near the start a long stretch of the track changed the size by one pixel, and at 200 px
 * one step of the track was already 2–3 px.
 *
 * Positions are 0…1000 (the range inputs use that many steps).
 */
const KNEE = 0.8;
const KNEE_SIZE = 200;
/** the slight acceleration below the knee (1 = even) */
const P = 1.3;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function posToSize(pos: number, min: number, max: number): number {
  const t = clamp(pos / 1000, 0, 1);
  if (max <= KNEE_SIZE) return min + (max - min) * Math.pow(t, P);
  if (t <= KNEE) return min + (KNEE_SIZE - min) * Math.pow(t / KNEE, P);
  return KNEE_SIZE * Math.pow(max / KNEE_SIZE, (t - KNEE) / (1 - KNEE));
}

export function sizeToPos(size: number, min: number, max: number): number {
  const v = clamp(size, min, max);
  if (max <= KNEE_SIZE) return 1000 * Math.pow((v - min) / (max - min || 1), 1 / P);
  if (v <= KNEE_SIZE) return 1000 * KNEE * Math.pow((v - min) / (KNEE_SIZE - min), 1 / P);
  return 1000 * (KNEE + (1 - KNEE) * Math.log(v / KNEE_SIZE) / Math.log(max / KNEE_SIZE));
}
