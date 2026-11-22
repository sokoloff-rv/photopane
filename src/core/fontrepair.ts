/**
 * Repair TrueType/OpenType fonts that Chromium's font sanitizer rejects or that lack a Unicode character map.
 * Old fonts (e.g. Cyrillic fonts for Windows-1251) often have a malformed or empty Unicode 'cmap' — Windows and
 * Photoshop cope with that, browsers don't. We rebuild a clean format-4 'cmap' from every mapping we can read:
 * Unicode subtables, and for legacy fonts the Macintosh byte table interpreted as Windows-1251.
 */

type Tables = Record<string, Uint8Array>;

function parseFont(buf: ArrayBuffer): { ver: number; t: Tables } | null {
  const dv = new DataView(buf);
  if (buf.byteLength < 12) return null;
  const ver = dv.getUint32(0);
  if (ver !== 0x00010000 && ver !== 0x4f54544f && ver !== 0x74727565) return null; // TrueType / CFF / 'true'
  const n = dv.getUint16(4);
  const t: Tables = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + 16 * i;
    if (o + 16 > buf.byteLength) return null;
    const tag = String.fromCharCode(...new Uint8Array(buf, o, 4));
    const off = dv.getUint32(o + 8), len = dv.getUint32(o + 12);
    if (off + len > buf.byteLength) return null;
    t[tag] = new Uint8Array(buf, off, len).slice();
  }
  return { ver, t };
}

function buildFont(ver: number, tables: Tables): ArrayBuffer {
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  let off = 12 + 16 * n;
  const placed: [string, number, Uint8Array][] = [];
  for (const tg of tags) { placed.push([tg, off, tables[tg]]); off += (tables[tg].length + 3) & ~3; }
  const out = new Uint8Array(off);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, ver);
  dv.setUint16(4, n);
  let es = 0;
  while ((1 << (es + 1)) <= n) es++;
  dv.setUint16(6, (1 << es) * 16); dv.setUint16(8, es); dv.setUint16(10, n * 16 - (1 << es) * 16);
  placed.forEach(([tg, o, d], i) => {
    const r = 12 + 16 * i;
    for (let k = 0; k < 4; k++) out[r + k] = tg.charCodeAt(k);
    let sum = 0;
    const padded = new Uint8Array((d.length + 3) & ~3); padded.set(d);
    const pv = new DataView(padded.buffer);
    for (let k = 0; k < padded.length; k += 4) sum = (sum + pv.getUint32(k)) >>> 0;
    dv.setUint32(r + 4, sum); dv.setUint32(r + 8, o); dv.setUint32(r + 12, d.length);
    out.set(d, o);
  });
  return out.buffer;
}

const numGlyphs = (t: Tables) => (t.maxp && t.maxp.length >= 6 ? new DataView(t.maxp.buffer).getUint16(4) : 0xffff);

/** Read every (code → glyph) mapping we can from the cmap table, tolerating malformed data. */
function readCmap(c: Uint8Array, nG: number): { unicode: Map<number, number>; macBytes: Map<number, number> } {
  const v = new DataView(c.buffer);
  const unicode = new Map<number, number>(), macBytes = new Map<number, number>();
  if (c.length < 4) return { unicode, macBytes };
  const n = v.getUint16(2);
  const u16 = (p: number) => (p + 2 <= c.length ? v.getUint16(p) : 0);
  for (let k = 0; k < n; k++) {
    const rec = 4 + 8 * k;
    if (rec + 8 > c.length) break;
    const pid = v.getUint16(rec), eid = v.getUint16(rec + 2), off = v.getUint32(rec + 4);
    if (off + 4 > c.length) continue;
    const fmt = v.getUint16(off);
    const isUnicode = pid === 0 || (pid === 3 && (eid === 1 || eid === 10));
    try {
      if (fmt === 4 && isUnicode) {
        const segX2 = u16(off + 6), segs = segX2 / 2;
        const ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
        for (let i = 0; i < segs; i++) {
          const e = u16(ends + 2 * i), s = u16(starts + 2 * i), d = (u16(deltas + 2 * i) << 16) >> 16, ro = u16(ranges + 2 * i);
          if (e < s || e - s > 0x8000) continue;
          for (let ch = s; ch <= e && ch !== 0xffff; ch++) {
            let g: number;
            if (!ro) g = (ch + d) & 0xffff;
            else { g = u16(ranges + 2 * i + ro + 2 * (ch - s)); if (g) g = (g + d) & 0xffff; }
            if (g > 0 && g < nG && !unicode.has(ch)) unicode.set(ch, g);
          }
        }
      } else if (fmt === 12 && isUnicode) {
        const groups = v.getUint32(off + 12);
        for (let i = 0; i < groups; i++) {
          const p = off + 16 + 12 * i;
          if (p + 12 > c.length) break;
          const s = v.getUint32(p), e = v.getUint32(p + 4), g0 = v.getUint32(p + 8);
          for (let ch = s; ch <= e && ch <= 0xffff && ch - s < 0x10000; ch++) { const g = g0 + (ch - s); if (g > 0 && g < nG && !unicode.has(ch)) unicode.set(ch, g); }
        }
      } else if (fmt === 0 && pid === 1 && eid === 0) {
        for (let b = 0; b < 256; b++) { const g = c[off + 6 + b]; if (g > 0 && g < nG) macBytes.set(b, g); }
      } else if (fmt === 4 && pid === 3 && eid === 0) {
        // symbol fonts map bytes into U+F0xx
        const segX2 = u16(off + 6), segs = segX2 / 2;
        const ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
        for (let i = 0; i < segs; i++) {
          const e = u16(ends + 2 * i), s = u16(starts + 2 * i), d = (u16(deltas + 2 * i) << 16) >> 16, ro = u16(ranges + 2 * i);
          for (let ch = s; ch <= e && ch !== 0xffff; ch++) {
            let g = !ro ? (ch + d) & 0xffff : u16(ranges + 2 * i + ro + 2 * (ch - s));
            if (ro && g) g = (g + d) & 0xffff;
            if (g > 0 && g < nG && (ch & 0xff00) === 0xf000 && !macBytes.has(ch & 0xff)) macBytes.set(ch & 0xff, g);
          }
        }
      }
    } catch { /* ignore malformed subtables */ }
  }
  return { unicode, macBytes };
}

function encodeFormat4(map: Map<number, number>): Uint8Array {
  const chars = [...map.keys()].filter(c => c < 0xffff).sort((a, b) => a - b);
  const segs: { s: number; e: number; g0: number }[] = [];
  for (const ch of chars) {
    const g = map.get(ch)!;
    const last = segs[segs.length - 1];
    if (last && ch === last.e + 1 && g === last.g0 + (ch - last.s)) last.e = ch; else segs.push({ s: ch, e: ch, g0: g });
  }
  segs.push({ s: 0xffff, e: 0xffff, g0: 0 });
  const n = segs.length, len = 16 + n * 8;
  const out = new Uint8Array(len);
  const v = new DataView(out.buffer);
  v.setUint16(0, 4); v.setUint16(2, len); v.setUint16(4, 0); v.setUint16(6, n * 2);
  let es = 0;
  while ((1 << (es + 1)) <= n) es++;
  v.setUint16(8, (1 << es) * 2); v.setUint16(10, es); v.setUint16(12, n * 2 - (1 << es) * 2);
  segs.forEach((s, i) => {
    v.setUint16(14 + 2 * i, s.e);
    v.setUint16(16 + n * 2 + 2 * i, s.s);
    v.setInt16(16 + n * 4 + 2 * i, s.s === 0xffff ? 1 : ((s.g0 - s.s) << 16) >> 16);
    v.setUint16(16 + n * 6 + 2 * i, 0);
  });
  return out;
}

let cp1251: string | null = null;
function decode1251(b: number): number {
  if (b < 0x80) return b;
  if (!cp1251) {
    try { cp1251 = new TextDecoder('windows-1251').decode(Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i)); }
    catch { cp1251 = ''; }
  }
  return cp1251 ? cp1251.charCodeAt(b - 0x80) : b;
}

export interface RepairResult { buffer: ArrayBuffer; repaired: boolean; chars: number }

/** Return the font with a clean Unicode cmap. Legacy byte-encoded fonts get Windows-1251 Cyrillic mapped to Unicode. */
export function repairFont(buf: ArrayBuffer): RepairResult {
  const f = parseFont(buf);
  if (!f || !f.t.cmap) return { buffer: buf, repaired: false, chars: 0 };
  const nG = numGlyphs(f.t);
  const { unicode, macBytes } = readCmap(f.t.cmap, nG);
  const map = new Map(unicode);
  const hasCyr = [...unicode.keys()].some(c => c >= 0x410 && c <= 0x44f);
  if (!hasCyr && macBytes.size) {
    // legacy font: interpret the byte table as Windows-1251 (Cyrillic) and fill in missing code points
    for (const [b, g] of macBytes) { const ch = decode1251(b); if (!map.has(ch)) map.set(ch, g); }
  }
  if (!map.size) return { buffer: buf, repaired: false, chars: 0 };
  const sub = encodeFormat4(map);
  const cmap = new Uint8Array(12 + sub.length);
  const cv = new DataView(cmap.buffer);
  cv.setUint16(0, 0); cv.setUint16(2, 1); cv.setUint16(4, 3); cv.setUint16(6, 1); cv.setUint32(8, 12);
  cmap.set(sub, 12);
  return { buffer: buildFont(f.ver, { ...f.t, cmap }), repaired: true, chars: map.size };
}
