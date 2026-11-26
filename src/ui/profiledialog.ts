/** Image → Colour Profile: see and change the document's colour space, or reduce it to indexed colours. */
import { app } from '../app';
import { el } from '../core/util';
import { readPixels } from '../core/util';
import { t } from '../i18n';
import { openDialog, toast } from './dialog';
import { numberField, checkbox } from './controls';
import { Layer } from '../core/layer';
import { parseIcc } from '../core/colormgmt';
import { ProfileId, PROFILE_NAMES, makeIcc, profileOf, convertPixels, medianCut, indexPixels } from '../core/colorspace';

/** Every pixel layer of the document (text stays text, groups are walked into). */
function rasters(children: Layer[], out: Layer[] = []): Layer[] {
  for (const l of children) {
    if (l.isGroup) rasters(l.children, out);
    else if (l.kind !== 'text') out.push(l);
  }
  return out;
}

function transformLayers(f: (data: Uint8ClampedArray, w: number, h: number) => void) {
  const d = app.doc!;
  for (const l of rasters(d.root.children)) {
    const s = l.content;
    if (s.w <= 0 || s.h <= 0) continue;
    const img = readPixels(s.canvas, 0, 0, s.w, s.h);
    f(img.data, s.w, s.h);
    s.ctx.putImageData(img, 0, 0);
    s.markDirty();
    l.touch();
  }
}

/** Which of the offered spaces the document is in (null: another embedded profile). */
function currentId(): ProfileId | null {
  const p = app.doc!.colorProfile;
  if (!p) return 'srgb';
  if (/p3/i.test(p.name)) return 'p3';
  if (/adobe/i.test(p.name)) return 'adobe';
  return null;
}

export function colorProfileDialog() {
  const d = app.doc;
  if (!d) return;
  const status = el('p', { class: 'dlg-text' });
  const ids: ProfileId[] = ['srgb', 'p3', 'adobe'];
  const convBtns = ids.map(id => el('button', { class: 'btn sm' }, PROFILE_NAMES[id]) as HTMLButtonElement);
  const assignBtns = ids.map(id => el('button', { class: 'btn sm' }, PROFILE_NAMES[id]) as HTMLButtonElement);
  const refresh = () => {
    const cur = currentId();
    status.textContent = t('prof.current', d.colorProfile?.name ?? 'sRGB');
    ids.forEach((id, i) => { convBtns[i].disabled = cur === id; assignBtns[i].disabled = cur === id; });
  };
  // convert: the colours stay the same, the numbers change
  ids.forEach((id, i) => convBtns[i].addEventListener('click', () => {
    const from = d.colorProfile, to = profileOf(id);
    transformLayers(data => convertPixels(data, from, to));
    d.setIccProfile(id === 'srgb' ? null : makeIcc(id));
    app.commit('cmd.colorProfile');
    toast(t('prof.converted', PROFILE_NAMES[id]));
    refresh();
  }));
  // assign: the numbers stay, they are read in another space (the picture looks different)
  ids.forEach((id, i) => assignBtns[i].addEventListener('click', () => {
    d.setIccProfile(id === 'srgb' ? null : makeIcc(id));
    app.commit('cmd.colorProfile');
    toast(t('prof.assigned', PROFILE_NAMES[id]));
    refresh();
  }));
  let colors = 256, dither = true;
  const apply = el('button', { class: 'btn sm' }, t('prof.indexApply'));
  apply.addEventListener('click', () => {
    // one palette for the whole picture, from what is visible
    const comp = d.compositeRead().canvas as HTMLCanvasElement;
    const step = Math.max(1, Math.ceil(Math.sqrt(d.width * d.height / 60000)));
    const sw = Math.ceil(d.width / step), sh = Math.ceil(d.height / step);
    const c = document.createElement('canvas'); c.width = sw; c.height = sh;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.imageSmoothingEnabled = false;
    g.drawImage(comp, 0, 0, sw, sh);
    const pal = medianCut(g.getImageData(0, 0, sw, sh).data, colors);
    transformLayers((data, w, h) => indexPixels(data, w, h, pal, dither));
    app.commit('cmd.indexedColors');
    toast(t('prof.indexed', pal.length));
  });
  const section = (title: string, hint: string, ...items: HTMLElement[]) =>
    el('div', { class: 'prof-section' }, el('div', { class: 'adj-section' }, title), el('div', { class: 'prof-row' }, ...items), el('div', { class: 'muted sm' }, hint));
  const body = el('div', { class: 'form prof-form' },
    status,
    section(t('prof.convert'), t('prof.convertHint'), ...convBtns),
    section(t('prof.assign'), t('prof.assignHint'), ...assignBtns),
    section(t('prof.indexed.title'), t('prof.indexedHint'),
      numberField({ label: t('prof.colors'), value: colors, min: 2, max: 256, onChange: v => { colors = v; } }),
      checkbox(t('prof.dither'), dither, v => { dither = v; }),
      apply));
  refresh();
  void parseIcc;
  openDialog({ title: t('cmd.colorProfile'), body, width: 440, okLabel: t('dlg.close'), cancelLabel: null, autoFocus: false });
}
