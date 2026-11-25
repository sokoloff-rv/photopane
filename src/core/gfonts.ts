/**
 * Google Fonts with Cyrillic, usable without installing anything: a family is downloaded the first time it is
 * picked (only its Latin and Cyrillic files), kept in the browser cache storage for offline use and registered
 * as FontFace objects under its family name, so text layers simply name it like any other font.
 */
import { GFONT_ROWS } from '../data/gfonts';

export interface GFamily {
  family: string;
  cat: 's' | 'r' | 'd' | 'h' | 'm';
  weights: number[];
  italics: number[];
  /** variable weight axis */
  range: [number, number] | null;
}

const bits = (m: number) => [100, 200, 300, 400, 500, 600, 700, 800, 900].filter((_, i) => m & (1 << i));
export const GOOGLE_FONTS: GFamily[] = GFONT_ROWS.map(([family, cat, w, it, range]) => ({ family, cat, weights: bits(w), italics: bits(it), range: range || null }));
const byName = new Map(GOOGLE_FONTS.map(g => [g.family.toLowerCase(), g]));

export const googleFamily = (name: string) => byName.get(name.toLowerCase());
export const isGoogleFamily = (name: string) => byName.has(name.toLowerCase());

const CACHE = 'photopane-fonts-v1';
/** Scripts we need; the rest (Greek, Vietnamese …) is not downloaded. */
const SUBSETS = new Set(['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext']);

const loaded = new Set<string>();
const loading = new Map<string, Promise<boolean>>();
const listeners = new Set<(family: string) => void>();

/** Called after a family has finished loading (text layers using it are redrawn). */
export function onGoogleFontLoaded(f: (family: string) => void) { listeners.add(f); }
export const isGoogleLoaded = (family: string) => loaded.has(family.toLowerCase());

function cssUrl(g: GFamily): string {
  const name = encodeURIComponent(g.family).replace(/%20/g, '+');
  let tuples: string[];
  if (g.range) {
    const r = `${g.range[0]}..${g.range[1]}`;
    tuples = ['0,' + r, ...(g.italics.length ? ['1,' + r] : [])];
  } else {
    tuples = [...g.weights.map(w => '0,' + w), ...g.italics.map(w => '1,' + w)];
    if (!tuples.length) tuples = ['0,400'];
  }
  return `https://fonts.googleapis.com/css2?family=${name}:ital,wght@${tuples.join(';')}&display=block`;
}

async function openCache(): Promise<Cache | null> {
  try { return 'caches' in window ? await caches.open(CACHE) : null; } catch { return null; }
}

/** A response from the cache, else from the network (then kept). */
async function cached(url: string): Promise<Response> {
  const cache = await openCache();
  const hit = await cache?.match(url);
  if (hit) return hit;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  if (cache) await cache.put(url, r.clone()).catch(() => {});
  return r;
}

/** Has this family been downloaded before (usable offline)? */
export async function isGoogleCached(family: string): Promise<boolean> {
  const g = googleFamily(family);
  if (!g) return false;
  if (loaded.has(g.family.toLowerCase())) return true;
  const cache = await openCache();
  return !!(await cache?.match(cssUrl(g)));
}

interface Face { subset: string; style: string; weight: string; url: string; range: string }

function parseCss(css: string): Face[] {
  const out: Face[] = [];
  const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const body = m[2];
    const get = (k: string) => (new RegExp(k + '\\s*:\\s*([^;]+);').exec(body)?.[1] ?? '').trim();
    const url = /url\(([^)]+)\)/.exec(get('src'))?.[1]?.replace(/['"]/g, '');
    if (!url) continue;
    out.push({ subset: m[1], style: get('font-style') || 'normal', weight: get('font-weight') || '400', url, range: get('unicode-range') });
  }
  return out;
}

/** Download (or take from the cache) and register a Google family. Resolves false when it cannot be loaded. */
export function ensureGoogleFont(family: string): Promise<boolean> {
  const g = googleFamily(family);
  if (!g) return Promise.resolve(false);
  const key = g.family.toLowerCase();
  if (loaded.has(key)) return Promise.resolve(true);
  let p = loading.get(key);
  if (p) return p;
  p = (async () => {
    try {
      const css = await (await cached(cssUrl(g))).text();
      const faces = parseCss(css).filter(f => SUBSETS.has(f.subset));
      if (!faces.length) return false;
      await Promise.all(faces.map(async f => {
        const buf = await (await cached(f.url)).arrayBuffer();
        const face = new FontFace(g.family, buf, { style: f.style, weight: f.weight, unicodeRange: f.range || undefined });
        await face.load();
        document.fonts.add(face);
      }));
      loaded.add(key);
      listeners.forEach(l => l(g.family));
      return true;
    } catch (e) {
      console.warn('PhotoPane: could not load Google font', g.family, e);
      return false;
    } finally {
      loading.delete(key);
    }
  })();
  loading.set(key, p);
  return p;
}

/** Download a family into the cache (all its styles), without registering it: picking it later is instant and works offline. */
async function cacheGoogleFont(g: GFamily): Promise<number> {
  const css = await (await cached(cssUrl(g))).text();
  const faces = parseCss(css).filter(f => SUBSETS.has(f.subset));
  let bytes = 0;
  for (const f of faces) bytes += (await (await cached(f.url)).arrayBuffer()).byteLength;
  return bytes;
}

/**
 * Download many families at once (the font picker's "Download all"), a few at a time. `progress(done, total)`
 * after each family; `cancelled()` stops between families. Returns how many failed and how much was fetched.
 */
export async function downloadGoogleFonts(families: string[], progress: (done: number, total: number) => void, cancelled: () => boolean): Promise<{ failed: string[]; bytes: number }> {
  const list = families.map(googleFamily).filter((g): g is GFamily => !!g);
  const failed: string[] = [];
  let next = 0, done = 0, bytes = 0;
  const worker = async () => {
    while (next < list.length && !cancelled()) {
      const g = list[next++];
      try { bytes += await cacheGoogleFont(g); } catch { failed.push(g.family); }
      progress(++done, list.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { failed, bytes };
}

/* ---------- previews for the font menu: only the letters of the name, a few KB each ---------- */
const previews = new Map<string, Promise<string | null>>();

/** A font family name that shows `family` well enough to draw its own name (loads a tiny subset). */
export function googlePreview(family: string): Promise<string | null> {
  const g = googleFamily(family);
  if (!g) return Promise.resolve(null);
  if (loaded.has(g.family.toLowerCase())) return Promise.resolve(g.family);
  let p = previews.get(g.family);
  if (!p) {
    p = (async () => {
      try {
        const name = encodeURIComponent(g.family).replace(/%20/g, '+');
        const w = g.range ? Math.min(Math.max(400, g.range[0]), g.range[1]) : g.weights.includes(400) ? 400 : g.weights[0] ?? 400;
        const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${name}:wght@${w}&text=${encodeURIComponent(g.family)}&display=block`)).text();
        const url = /url\(([^)]+)\)/.exec(css)?.[1]?.replace(/['"]/g, '');
        if (!url) return null;
        const alias = 'pp-preview-' + g.family;
        const face = new FontFace(alias, `url(${url})`, { weight: String(w) });
        await face.load();
        document.fonts.add(face);
        return alias;
      } catch { return null; }
    })();
    previews.set(g.family, p);
  }
  return p;
}
