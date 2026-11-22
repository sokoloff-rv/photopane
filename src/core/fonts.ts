/**
 * Access to installed fonts that the browser does not expose to CSS by name (e.g. fonts installed only for the
 * current Windows user). Uses the Local Font Access API: with the user's permission the font files are read and
 * registered as FontFace objects under the family names our text styles use.
 */

export interface FontNeed { psName: string; family: string; bold: boolean; italic: boolean }

interface LocalFontData { postscriptName: string; fullName: string; family: string; style: string; blob(): Promise<Blob> }

let localFonts: LocalFontData[] | null = null;
const registered = new Set<string>();

export const localFontsSupported = () => typeof (window as any).queryLocalFonts === 'function';

export async function localFontsPermission(): Promise<PermissionState | 'unsupported'> {
  if (!localFontsSupported()) return 'unsupported';
  try { return (await navigator.permissions.query({ name: 'local-fonts' as PermissionName })).state; }
  catch { return 'prompt'; }
}

/** Query installed fonts (asks for permission the first time; must run from a user gesture then). */
export async function loadLocalFontList(): Promise<LocalFontData[] | null> {
  if (localFonts) return localFonts;
  if (!localFontsSupported()) return null;
  try { localFonts = await (window as any).queryLocalFonts(); return localFonts; }
  catch { return null; }
}

export function localFamilies(): string[] | null {
  return localFonts ? [...new Set(localFonts.map(f => f.family))] : null;
}

const weightOf = (style: string) => /black|heavy/i.test(style) ? '900' : /bold/i.test(style) ? '700' : /semi|demi/i.test(style) ? '600' : /medium/i.test(style) ? '500' : /light/i.test(style) ? '300' : /thin/i.test(style) ? '200' : '400';
const italicOf = (style: string) => /italic|oblique/i.test(style) ? 'italic' : 'normal';

async function register(fd: LocalFontData, family: string, weight: string, style: string) {
  const key = `${family}|${weight}|${style}`;
  if (registered.has(key)) return;
  registered.add(key);
  const buf = await (await fd.blob()).arrayBuffer();
  const face = new FontFace(family, buf, { weight, style });
  await face.load();
  document.fonts.add(face);
}

/** Register the faces our styles need. Returns the PostScript names that were found. */
export async function registerNeeded(needs: FontNeed[]): Promise<string[]> {
  const list = await loadLocalFontList();
  if (!list) return [];
  const found: string[] = [];
  for (const n of needs) {
    const fd = list.find(f => f.postscriptName === n.psName) || list.find(f => f.fullName.replace(/\s+/g, '') === n.psName.replace(/-/g, ''));
    if (!fd) continue;
    // exactly the family / weight our text style asks for …
    await register(fd, n.family, n.bold ? '700' : '400', n.italic ? 'italic' : 'normal');
    // … and the font's own family with its real weight (for the font menu and later edits)
    await register(fd, fd.family, weightOf(fd.style), italicOf(fd.style));
    found.push(n.psName);
  }
  return found;
}

/** Make every face of a family usable (when picked in the font menu). */
export async function registerFamily(family: string) {
  const list = localFonts;
  if (!list) return;
  for (const fd of list.filter(f => f.family === family)) await register(fd, fd.family, weightOf(fd.style), italicOf(fd.style));
}
