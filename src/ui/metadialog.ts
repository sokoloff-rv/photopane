/** Image → Show Metadata: what the picture is and how it was taken (camera, lens, exposure, date, place). */
import { app } from '../app';
import { el } from '../core/util';
import { t, getLang } from '../i18n';
import { openDialog } from './dialog';
import { readExif } from '../io/exifread';

export function metadataDialog() {
  const d = app.doc;
  if (!d) return;
  const rows: [string, string][] = [];
  const add = (key: string, v: string | undefined | null) => { if (v) rows.push([t(key), v]); };
  const fmt = (n: number, digits = 1) => n.toLocaleString(getLang() === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: digits });

  // the file
  add('meta.file', d.fileName ?? d.name);
  add('meta.size', `${d.width} × ${d.height} ${t('dlg.px')} (${fmt(d.width * d.height / 1e6)} ${t('meta.mp')})`);
  add('meta.profile', d.colorProfile?.name ?? 'sRGB');
  add('meta.layers', String(d.layers.filter(l => !l.isGroup).length));

  // how it was taken
  const x = readExif(d.exif);
  if (x) {
    add('meta.camera', [x.make, x.model].filter(Boolean).join(' '));
    add('meta.lens', x.lens);
    const sec = t('meta.sec'), mm = t('meta.mmUnit');
    const shutter = x.exposure ? (x.exposure >= 1 ? `${fmt(x.exposure)} ${sec}` : `1/${Math.round(1 / x.exposure)} ${sec}`) : undefined;
    const exposure = [shutter, x.fnumber ? `f/${fmt(x.fnumber)}` : undefined, x.iso ? `ISO ${x.iso}` : undefined].filter(Boolean).join(' · ');
    add('meta.exposure', exposure);
    if (x.focal) add('meta.focal', `${fmt(x.focal)} ${mm}` + (x.focal35 && Math.round(x.focal35) !== Math.round(x.focal) ? ` (${t('meta.eq35', Math.round(x.focal35))})` : ''));
    if (x.bias) add('meta.bias', `${x.bias > 0 ? '+' : ''}${fmt(x.bias)} EV`);
    if (x.flash !== undefined) add('meta.flash', t(x.flash ? 'meta.flashOn' : 'meta.flashOff'));
    if (x.date) {
      // EXIF dates are "YYYY:MM:DD HH:MM:SS"
      const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d)/.exec(x.date);
      add('meta.date', m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).toLocaleString(getLang() === 'ru' ? 'ru-RU' : 'en-US', { dateStyle: 'long', timeStyle: 'short' }) : x.date);
    }
    if (x.gps) add('meta.gps', `${x.gps.lat.toFixed(6)}, ${x.gps.lon.toFixed(6)}` + (x.gps.alt !== undefined ? ` · ${Math.round(x.gps.alt)} ${t('meta.m')}` : ''));
    add('meta.software', x.software);
    add('meta.artist', x.artist);
    add('meta.copyright', x.copyright);
  }

  const table = el('div', { class: 'meta-table' }, ...rows.map(([k, v]) => el('div', { class: 'meta-row' }, el('span', { class: 'muted' }, k), el('span', { class: 'meta-val' }, v))));
  const body = el('div', { class: 'form' }, table, x ? null : el('div', { class: 'muted sm' }, t('meta.none')));
  openDialog({ title: t('meta.title'), body, width: 440, okLabel: t('dlg.close'), cancelLabel: null });
}
