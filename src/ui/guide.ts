/**
 * Help → Learn: a window with the sections of the guide on the left and their text on the right, and a search
 * over all of it. It floats (stays open while you work and try what it describes), like Show Metadata.
 */
import { app } from '../app';
import { t, getLang } from '../i18n';
import { el } from '../core/util';
import { openDialog } from './dialog';

let open: { close: () => void } | null = null;
let opening = false;

export async function openGuide() {
  // (a second F1 while the text is still loading opens no second window)
  if (open || opening) return;
  opening = true;
  let GUIDE: typeof import('./guidetext').GUIDE;
  try { ({ GUIDE } = await import('./guidetext')); } finally { opening = false; }
  if (open) return;
  const L = getLang() === 'en' ? 1 : 0;
  const nav = el('div', { class: 'guide-nav' });
  const content = el('div', { class: 'guide-body' });
  const search = el('input', { class: 'text-input guide-search', type: 'search', placeholder: t('guide.search'), spellcheck: 'false' }) as HTMLInputElement;
  // the window's keys stay in the field (the editor's shortcuts must not fire while typing)
  search.addEventListener('keydown', e => { if (e.key !== 'Escape') e.stopPropagation(); });
  let current = (app.settings.guideSection as string) || GUIDE[0].id;

  const item = (it: (typeof GUIDE)[number]['items'][number]) =>
    el('div', { class: 'guide-item' },
      el('div', { class: 'guide-item-head' }, el('h4', {}, it.t[L]), it.k ? el('kbd', {}, it.k) : null),
      el('p', {}, it.d[L]));

  const showSection = (id: string) => {
    current = id;
    app.settings.guideSection = id;
    const s = GUIDE.find(x => x.id === id) ?? GUIDE[0];
    nav.querySelectorAll('.guide-link').forEach(b => b.classList.toggle('on', (b as HTMLElement).dataset.id === s.id));
    content.innerHTML = '';
    content.append(el('h3', {}, s.t[L]));
    if (s.intro) content.append(el('p', { class: 'guide-intro' }, s.intro[L]));
    for (const it of s.items) content.append(item(it));
    if (s.id === 'start') {
      const sc = el('button', { class: 'btn sm' }, t('cmd.shortcuts'));
      sc.addEventListener('click', () => app.run('shortcuts'));
      content.append(el('div', { class: 'guide-more' }, sc));
    }
    content.scrollTop = 0;
  };

  const showSearch = (q: string) => {
    // word endings dropped, so «маска» finds «маской» and «размытие» «размытия» (Russian changes its endings)
    // (only words of letters: «ctrl+j» is looked for as it is)
    const stem = (w: string) => (!/^[a-zа-я]+$/.test(w) ? w : w.length > 5 ? w.slice(0, -2) : w.length > 4 ? w.slice(0, -1) : w);
    const words = q.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean).map(stem);
    nav.querySelectorAll('.guide-link').forEach(b => b.classList.remove('on'));
    content.innerHTML = '';
    let found = 0;
    const matches = (text: string) => { const s2 = text.toLowerCase().replace(/ё/g, 'е'); return words.every(w => s2.includes(w)); };
    for (const s of GUIDE) {
      // a section's introduction counts as an entry of its own (Ctrl+K is said in the AI one)
      const intro = s.intro && matches(s.t[L] + ' ' + s.intro[L]) ? [{ t: s.t, d: s.intro }] : [];
      const hits = [...intro, ...s.items.filter(it => matches(it.t[L] + ' ' + it.d[L] + ' ' + (it.k ?? '')))];
      if (!hits.length) continue;
      found += hits.length;
      content.append(el('div', { class: 'guide-found-in' }, s.t[L]));
      for (const it of hits) content.append(item(it));
    }
    if (!found) content.append(el('p', { class: 'muted' }, t('guide.nothing')));
    content.scrollTop = 0;
  };

  for (const s of GUIDE) {
    const b = el('button', { class: 'guide-link', 'data-id': s.id }, s.t[L]);
    b.addEventListener('click', () => { search.value = ''; showSection(s.id); });
    nav.append(b);
  }
  search.addEventListener('input', () => { const q = search.value.trim(); if (q) showSearch(q); else showSection(current); });
  showSection(current);

  const body = el('div', { class: 'guide' }, el('div', { class: 'guide-side' }, search, nav), content);
  open = openDialog({
    title: t('guide.title'), body, width: 860, okLabel: t('dlg.close'), cancelLabel: null,
    floating: true, posKey: 'guide', autoFocus: false,
    onOk: () => { open = null; app.saveSettings(); },
    onCancel: () => { open = null; app.saveSettings(); },
  });
}
