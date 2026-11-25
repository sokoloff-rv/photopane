/**
 * Reading the common EXIF fields (camera, lens, exposure, date, GPS) from the APP1 segment kept with a
 * document (see exif.ts). Only what people look at in an image's info; unknown tags are skipped.
 */

export interface ExifInfo {
  make?: string; model?: string; lens?: string; software?: string; artist?: string; copyright?: string;
  date?: string;
  exposure?: number; fnumber?: number; iso?: number; focal?: number; focal35?: number; bias?: number;
  flash?: boolean;
  width?: number; height?: number;
  gps?: { lat: number; lon: number; alt?: number };
}

export function readExif(seg: Uint8Array | null): ExifInfo | null {
  if (!seg || seg.length < 18) return null;
  const T = 10; // FF E1 len(2) "Exif\0\0", then the TIFF header
  const le = seg[T] === 0x49;
  const u16 = (o: number) => (o + 2 > seg.length ? 0 : le ? seg[o] | (seg[o + 1] << 8) : (seg[o] << 8) | seg[o + 1]);
  const u32 = (o: number) => (o + 4 > seg.length ? 0 : le
    ? (seg[o] | (seg[o + 1] << 8) | (seg[o + 2] << 16) | (seg[o + 3] << 24)) >>> 0
    : ((seg[o] << 24) | (seg[o + 1] << 16) | (seg[o + 2] << 8) | seg[o + 3]) >>> 0);
  const s32 = (o: number) => u32(o) | 0;

  /** Value of one IFD entry: strings, numbers or rationals (first value, or all for GPS triples). */
  const value = (e: number): string | number | number[] | undefined => {
    const type = u16(e + 2), count = u32(e + 4);
    const size = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8][type] || 0;
    const at = size * count > 4 ? T + u32(e + 8) : e + 8;
    if (at + size * count > seg.length) return undefined;
    switch (type) {
      case 2: { // ASCII
        let s = '';
        for (let i = 0; i < count && seg[at + i]; i++) s += String.fromCharCode(seg[at + i]);
        return s.trim();
      }
      case 3: return u16(at);
      case 4: return u32(at);
      case 9: return s32(at);
      case 5: case 10: {
        const out: number[] = [];
        for (let i = 0; i < count; i++) {
          const n = type === 5 ? u32(at + i * 8) : s32(at + i * 8), d = type === 5 ? u32(at + i * 8 + 4) : s32(at + i * 8 + 4);
          out.push(d ? n / d : 0);
        }
        return count === 1 ? out[0] : out;
      }
      case 7: return count <= 4 ? u32(at) : undefined;
      default: return undefined;
    }
  };
  const ifd = (o: number): Map<number, string | number | number[]> => {
    const m = new Map<number, string | number | number[]>();
    if (o <= T || o + 2 > seg.length) return m;
    const n = u16(o);
    for (let i = 0; i < n && i < 500; i++) {
      const e = o + 2 + i * 12;
      if (e + 12 > seg.length) break;
      const v = value(e);
      if (v !== undefined) m.set(u16(e), v);
    }
    return m;
  };

  const ifd0 = ifd(T + u32(T + 4));
  const exif = ifd0.has(0x8769) ? ifd(T + (ifd0.get(0x8769) as number)) : new Map();
  const gpsI = ifd0.has(0x8825) ? ifd(T + (ifd0.get(0x8825) as number)) : new Map();
  const str = (m: Map<number, unknown>, k: number) => { const v = m.get(k); return typeof v === 'string' && v ? v : undefined; };
  const num = (m: Map<number, unknown>, k: number) => { const v = m.get(k); return typeof v === 'number' && isFinite(v) ? v : undefined; };

  const info: ExifInfo = {
    make: str(ifd0, 0x010f), model: str(ifd0, 0x0110), software: str(ifd0, 0x0131),
    artist: str(ifd0, 0x013b), copyright: str(ifd0, 0x8298),
    lens: str(exif, 0xa434),
    date: str(exif, 0x9003) ?? str(ifd0, 0x0132),
    exposure: num(exif, 0x829a), fnumber: num(exif, 0x829d), iso: num(exif, 0x8827),
    focal: num(exif, 0x920a), focal35: num(exif, 0xa405), bias: num(exif, 0x9204),
    width: num(exif, 0xa002), height: num(exif, 0xa003),
  };
  const flash = num(exif, 0x9209);
  if (flash !== undefined) info.flash = (flash & 1) === 1;
  // the model often repeats the make ("Canon" + "Canon EOS R6")
  if (info.make && info.model?.toLowerCase().startsWith(info.make.toLowerCase())) info.make = undefined;
  const dms = (v: unknown) => (Array.isArray(v) && v.length >= 3 ? v[0] + v[1] / 60 + v[2] / 3600 : undefined);
  const lat = dms(gpsI.get(0x0002)), lon = dms(gpsI.get(0x0004));
  if (lat !== undefined && lon !== undefined && (lat || lon)) {
    const alt = num(gpsI, 0x0006);
    info.gps = {
      lat: str(gpsI, 0x0001) === 'S' ? -lat : lat,
      lon: str(gpsI, 0x0003) === 'W' ? -lon : lon,
      alt: alt !== undefined ? (gpsI.get(0x0005) === 1 ? -alt : alt) : undefined,
    };
  }
  return Object.values(info).some(v => v !== undefined) ? info : null;
}
