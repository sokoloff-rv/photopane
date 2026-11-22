/** Minimal EXIF handling: extract the APP1 Exif segment from a JPEG and insert it into another JPEG. */

export function extractExif(buf: ArrayBuffer): Uint8Array | null {
  const b = new Uint8Array(buf);
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 < b.length) {
    if (b[p] !== 0xff) return null;
    const marker = b[p + 1];
    if (marker === 0xda || marker === 0xd9) return null; // start of scan / end
    const len = (b[p + 2] << 8) | b[p + 3];
    if (marker === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) {
      const seg = b.slice(p, p + 2 + len);
      resetOrientation(seg);
      return seg;
    }
    p += 2 + len;
  }
  return null;
}

/** Pixels are already rotated on import, so the Orientation tag must become 1 (normal). */
function resetOrientation(seg: Uint8Array) {
  const tiff = 10; // FF E1 len(2) "Exif\0\0"
  const le = seg[tiff] === 0x49;
  const u16 = (o: number) => (le ? seg[o] | (seg[o + 1] << 8) : (seg[o] << 8) | seg[o + 1]);
  const u32 = (o: number) => (le ? (seg[o] | (seg[o + 1] << 8) | (seg[o + 2] << 16) | (seg[o + 3] << 24)) >>> 0 : ((seg[o] << 24) | (seg[o + 1] << 16) | (seg[o + 2] << 8) | seg[o + 3]) >>> 0);
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > seg.length) return;
  const n = u16(ifd0);
  for (let i = 0; i < n; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > seg.length) return;
    if (u16(e) === 0x0112) {
      if (le) { seg[e + 8] = 1; seg[e + 9] = 0; } else { seg[e + 8] = 0; seg[e + 9] = 1; }
      return;
    }
  }
}

export async function insertExif(jpeg: Blob, exif: Uint8Array): Promise<Blob> {
  const b = new Uint8Array(await jpeg.arrayBuffer());
  if (b[0] !== 0xff || b[1] !== 0xd8) return jpeg;
  // skip a JFIF APP0 written by the encoder so EXIF comes first (as cameras do)
  let p = 2;
  if (b[2] === 0xff && b[3] === 0xe0) p = 4 + ((b[4] << 8) | b[5]);
  return new Blob([b.slice(0, 2), exif as BlobPart, b.slice(p)], { type: 'image/jpeg' });
}
