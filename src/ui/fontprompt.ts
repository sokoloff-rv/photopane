import { app } from '../app';
import { Doc } from '../core/document';
import { el } from '../core/util';
import { t } from '../i18n';
import { openDialog, toast } from './dialog';
import { localFontsPermission, registerNeeded } from '../core/fonts';
import { clearFontCaches, renderTextLayer } from '../core/text';

/** After opening a PSD: make fonts the browser cannot see usable (asks for access to local fonts once). */
export async function ensureDocFonts(d: Doc) {
  const needs = d.missingFonts;
  if (!needs.length) return;
  const names = needs.map(n => n.psName).join(', ');
  const perm = await localFontsPermission();
  const run = async () => {
    const found = await registerNeeded(needs);
    clearFontCaches();
    for (const l of d.layers) if (l.kind === 'text' && l.text && !l.text.psdPixels) renderTextLayer(l);
    d.missingFonts = needs.filter(n => !found.includes(n.psName));
    app.update('canvas', 'options', 'overlay');
    if (d.missingFonts.length) toast(t('fonts.notInstalled', d.missingFonts.map(n => n.psName).join(', ')), 'error', 6000);
    else if (found.length && perm !== 'granted') toast(t('fonts.loaded'));
  };
  if (perm === 'granted') { await run(); return; }
  if (perm === 'unsupported' || perm === 'denied') { toast(t('fonts.unavailable', names), 'info', 6000); return; }
  openDialog({
    title: t('fonts.title'),
    body: el('div', {}, el('p', { class: 'dlg-text' }, t('fonts.text')), el('p', { class: 'dlg-text mono' }, names)),
    okLabel: t('fonts.allow'), cancelLabel: t('fonts.later'), width: 440,
    onOk: () => { run(); },
  });
}
