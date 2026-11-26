/**
 * Image → Colour Profile: converting the document between sRGB, Display P3 and Adobe RGB, assigning a
 * profile without converting, and reducing to indexed colours. The ICC profiles written here are simple
 * matrix/TRC profiles (ICC v2) that parseIcc() and other programs read.
 */
import { RgbProfile, parseIcc } from './colormgmt';

export type ProfileId = 'srgb' | 'p3' | 'adobe';

/** Primaries adapted to D50 (the ICC connection space) and the tone curve of each space. */
const SPACES: Record<ProfileId, { name: string; r: number[]; g: number[]; b: number[]; trc: 'srgb' | number }> = {
  srgb: { name: 'sRGB IEC61966-2.1', r: [0.4361, 0.2225, 0.0139], g: [0.3851, 0.7169, 0.0971], b: [0.1431, 0.0606, 0.7141], trc: 'srgb' },
  p3: { name: 'Display P3', r: [0.5151, 0.2412, -0.0011], g: [0.2920, 0.6922, 0.0419], b: [0.1571, 0.0666, 0.7841], trc: 'srgb' },
  adobe: { name: 'Adobe RGB (1998)', r: [0.6097, 0.3111, 0.0195], g: [0.2053, 0.6257, 0.0609], b: [0.1492, 0.0632, 0.7446], trc: 563 / 256 },
};
export const PROFILE_NAMES: Record<ProfileId, string> = { srgb: 'sRGB', p3: 'Display P3', adobe: 'Adobe RGB' };

/** A minimal ICC v2 display profile (desc, cprt, wtpt, rgb XYZ, rgb TRC). */
export function makeIcc(id: ProfileId): Uint8Array {
  const sp = SPACES[id];
  const parts: { sig: string; data: Uint8Array }[] = [];
  const be = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
  const s15 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, Math.round(v * 65536)); return b; };
  const cat = (...a: Uint8Array[]) => { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const ascii = (s: string) => new TextEncoder().encode(s);
  const desc = (() => {
    const txt = ascii(sp.name + '\0');
    return cat(ascii('desc'), new Uint8Array(4), be(txt.length), txt, new Uint8Array(4), new Uint8Array(4), new Uint8Array(2), new Uint8Array(1), new Uint8Array(67));
  })();
  const xyz = (v: number[]) => cat(ascii('XYZ '), new Uint8Array(4), s15(v[0]), s15(v[1]), s15(v[2]));
  let curve: Uint8Array;
  if (sp.trc === 'srgb') {
    const n = 1024, t = new Uint8Array(n * 2), dv = new DataView(t.buffer);
    for (let i = 0; i < n; i++) { const x = i / (n - 1); dv.setUint16(i * 2, Math.round(65535 * (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)))); }
    curve = cat(ascii('curv'), new Uint8Array(4), be(n), t);
  } else {
    const g = new Uint8Array(2); new DataView(g.buffer).setUint16(0, Math.round(sp.trc * 256));
    curve = cat(ascii('curv'), new Uint8Array(4), be(1), g);
  }
  parts.push({ sig: 'desc', data: desc });
  parts.push({ sig: 'cprt', data: cat(ascii('text'), new Uint8Array(4), ascii('No copyright, use freely\0')) });
  parts.push({ sig: 'wtpt', data: xyz([0.9642, 1.0, 0.8249]) });
  parts.push({ sig: 'rXYZ', data: xyz(sp.r) }, { sig: 'gXYZ', data: xyz(sp.g) }, { sig: 'bXYZ', data: xyz(sp.b) });
  parts.push({ sig: 'rTRC', data: curve }, { sig: 'gTRC', data: curve }, { sig: 'bTRC', data: curve });
  // tag table, data aligned to 4 bytes (the three curves share one copy)
  const tableSize = 4 + parts.length * 12;
  let off = 128 + tableSize;
  const placed = new Map<Uint8Array, number>();
  const blobs: Uint8Array[] = [];
  const entries: Uint8Array[] = [be(parts.length)];
  for (const p of parts) {
    let at = placed.get(p.data);
    if (at === undefined) {
      at = off; placed.set(p.data, at);
      const pad = (4 - (p.data.length % 4)) % 4;
      blobs.push(p.data, new Uint8Array(pad));
      off += p.data.length + pad;
    }
    entries.push(cat(ascii(p.sig), be(at), be(p.data.length)));
  }
  const header = new Uint8Array(128), hv = new DataView(header.buffer);
  hv.setUint32(0, off);
  hv.setUint32(8, 0x02100000);
  header.set(ascii('mntr'), 12); header.set(ascii('RGB '), 16); header.set(ascii('XYZ '), 20);
  header.set(ascii('acsp'), 36);
  hv.setInt32(68, Math.round(0.9642 * 65536)); hv.setInt32(72, 65536); hv.setInt32(76, Math.round(0.8249 * 65536));
  return cat(header, ...entries, ...blobs);
}

/** The profile a document's ICC bytes describe (null = sRGB). */
export const profileOf = (id: ProfileId): RgbProfile | null => (id === 'srgb' ? null : parseIcc(makeIcc(id)));

const decodeSRGB = (() => { const t = new Float32Array(256); for (let i = 0; i < 256; i++) { const x = i / 255; t[i] = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); } return t; })();

function inv3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** Encoding table (4096 linear steps → byte) that inverts a 256-entry decoding table. */
function encoderFor(dec: Float32Array): Uint8ClampedArray {
  const t = new Uint8ClampedArray(4096);
  let j = 0;
  for (let i = 0; i < 4096; i++) {
    const v = i / 4095;
    while (j < 255 && dec[j + 1] < v) j++;
    t[i] = j < 255 && Math.abs(dec[j + 1] - v) < Math.abs(dec[j] - v) ? j + 1 : j;
  }
  return t;
}

/** Convert RGBA pixels in place from one space to another (null = sRGB), in float between the two ends. */
export function convertPixels(data: Uint8ClampedArray, from: RgbProfile | null, to: RgbProfile | null) {
  if (!from && !to) return;
  const ident = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const toS = from ? from.toSRGB : ident;
  const fromS = to ? inv3(to.toSRGB) : ident;
  // linear source → linear sRGB → linear target, one matrix
  const m = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) m[i * 3 + j] += fromS[i * 3 + k] * toS[k * 3 + j];
  const [dr, dg, db] = from ? from.decode : [decodeSRGB, decodeSRGB, decodeSRGB];
  const enc = to ? to.decode.map(encoderFor) : [encoderFor(decodeSRGB), encoderFor(decodeSRGB), encoderFor(decodeSRGB)];
  const q = (v: number) => Math.max(0, Math.min(4095, Math.round(v * 4095)));
  for (let i = 0; i < data.length; i += 4) {
    const r = dr[data[i]], g = dg[data[i + 1]], b = db[data[i + 2]];
    data[i] = enc[0][q(m[0] * r + m[1] * g + m[2] * b)];
    data[i + 1] = enc[1][q(m[3] * r + m[4] * g + m[5] * b)];
    data[i + 2] = enc[2][q(m[6] * r + m[7] * g + m[8] * b)];
  }
}

/* ---------------- indexed colours ---------------- */

/** A palette of up to n colours for the sampled pixels (median cut). */
export function medianCut(sample: Uint8ClampedArray, n: number): number[][] {
  const px: number[][] = [];
  for (let i = 0; i < sample.length; i += 4) if (sample[i + 3] > 8) px.push([sample[i], sample[i + 1], sample[i + 2]]);
  if (!px.length) return [[0, 0, 0]];
  const boxes: number[][][] = [px];
  while (boxes.length < n) {
    // split the box with the widest channel range (and more than one colour)
    let bi = -1, bc = 0, br = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const p of b) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; }
        if (hi - lo > br) { br = hi - lo; bi = i; bc = c; }
      }
    });
    if (bi < 0 || br === 0) break;
    const b = boxes[bi].sort((x, y) => x[bc] - y[bc]);
    const mid = b.length >> 1;
    boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }
  return boxes.map(b => { const s = [0, 0, 0]; for (const p of b) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; } return s.map(v => Math.round(v / b.length)); });
}

/** Map RGBA pixels to the palette in place, optionally with Floyd–Steinberg dithering; alpha is kept. */
export function indexPixels(data: Uint8ClampedArray, w: number, h: number, pal: number[][], dither: boolean) {
  // nearest palette entry per 5-bit cell, so the mapping is a lookup
  const cube = new Uint16Array(32768);
  for (let i = 0; i < 32768; i++) {
    const r = ((i >> 10) & 31) * 8 + 4, g = ((i >> 5) & 31) * 8 + 4, b = (i & 31) * 8 + 4;
    let best = 0, bd = Infinity;
    for (let k = 0; k < pal.length; k++) { const p = pal[k], d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2; if (d < bd) { bd = d; best = k; } }
    cube[i] = best;
  }
  const near = (r: number, g: number, b: number) => pal[cube[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)]];
  if (!dither) {
    for (let i = 0; i < data.length; i += 4) { if (!data[i + 3]) continue; const p = near(data[i], data[i + 1], data[i + 2]); data[i] = p[0]; data[i + 1] = p[1]; data[i + 2] = p[2]; }
    return;
  }
  const err = new Float32Array(w * 3 * 2);   // the current and next row's carried error
  for (let y = 0; y < h; y++) {
    const cur = (y & 1) * w * 3, nxt = ((y + 1) & 1) * w * 3;
    err.fill(0, nxt, nxt + w * 3);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, e = cur + x * 3;
      if (!data[i + 3]) continue;
      const r = Math.max(0, Math.min(255, data[i] + err[e])), g = Math.max(0, Math.min(255, data[i + 1] + err[e + 1])), b = Math.max(0, Math.min(255, data[i + 2] + err[e + 2]));
      const p = near(r | 0, g | 0, b | 0);
      data[i] = p[0]; data[i + 1] = p[1]; data[i + 2] = p[2];
      const er = r - p[0], eg = g - p[1], eb = b - p[2];
      const spread = (dx: number, row: number, k: number) => { const xx = x + dx; if (xx < 0 || xx >= w) return; const o = row + xx * 3; err[o] += er * k; err[o + 1] += eg * k; err[o + 2] += eb * k; };
      spread(1, cur, 7 / 16); spread(-1, nxt, 3 / 16); spread(0, nxt, 5 / 16); spread(1, nxt, 1 / 16);
    }
  }
}
