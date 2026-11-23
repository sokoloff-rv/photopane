/**
 * Font menu of the text tool: Google Fonts with Cyrillic first (downloaded on first use, no installation),
 * the fonts of this computer on a second tab. Names are shown in their own font; Google previews load only
 * the letters of the name.
 */
import { el } from '../core/util';
import { t } from '../i18n';
import { icon } from './icons';
import { showPopup, closeContextMenu } from './contextmenu';
import { toast } from './dialog';
import { GOOGLE_FONTS, GFamily, googlePreview, ensureGoogleFont, isGoogleLoaded, isGoogleCached } from '../core/gfonts';

export interface SystemFonts {
  list: () => string[];
  /** All installed fonts can still be listed (asks the browser for access). */
  canLoadMore: () => boolean;
  loadMore: () => Promise<boolean>;
  /** Make a picked installed family usable. */
  register: (family: string) => Promise<void>;
}

type Tab = 'google' | 'system';
const CATS: GFamily['cat'][] = ['s', 'r', 'd', 'h', 'm'];
let lastCat: GFamily['cat'] | '' = '';

export function fontPicker(current: string, sys: SystemFonts, onPick: (family: string) => void): HTMLElement {
  const name = el('span', { class: 'font-pick-name', style: { fontFamily: `"${current}", sans-serif` } }, current);
  const btn = el('button', { class: 'font-pick', title: t('opt.font') }, name, icon('chevronDown', 14));
  btn.addEventListener('mousedown', e => e.preventDefault());   // keep the text selection of the editor
  btn.addEventListener('click', () => open());

  function open() {
    let tab: Tab = 'google';
    const panel = el('div', { class: 'menu-drop ctx-menu font-pop' });
    const tabs = el('div', { class: 'seg font-tabs' });
    const search = el('input', { class: 'text-input font-q', type: 'text', placeholder: t('gf.search') }) as HTMLInputElement;
    const cat = el('select', { class: 'select font-cat' }) as HTMLSelectElement;
    cat.append(el('option', { value: '' }, t('gf.all')), ...CATS.map(c => el('option', { value: c }, t('gf.cat.' + c))));
    cat.value = lastCat;
    const list = el('div', { class: 'font-list' });
    const foot = el('div', { class: 'font-foot' });
    panel.append(tabs, el('div', { class: 'font-search' }, search, cat), list, foot);

    const tabBtn = (v: Tab, label: string) => {
      const b = el('button', { class: 'seg-btn' }, label);
      b.addEventListener('click', () => { tab = v; render(); });
      return b;
    };
    tabs.append(tabBtn('google', t('gf.google')), tabBtn('system', t('gf.system')));

    // previews load while their rows scroll into view
    const io = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const row = en.target as HTMLElement;
        io.unobserve(row);
        const fam = row.dataset.family!;
        const label = row.querySelector('.font-row-name') as HTMLElement;
        void googlePreview(fam).then(alias => { if (alias) label.style.fontFamily = `"${alias}", sans-serif`; });
        const st = row.querySelector('.font-row-state') as HTMLElement;
        void isGoogleCached(fam).then(c => { if (!c) st.replaceChildren(icon('cloudDown', 13)); st.title = c ? '' : t('gf.download'); });
      }
    }, { root: list, rootMargin: '120px' });

    const pick = async (fam: string, row: HTMLElement, google: boolean) => {
      if (row.classList.contains('busy')) return;
      row.classList.add('busy');
      const st = row.querySelector('.font-row-state') as HTMLElement;
      st.textContent = t('gf.loading');
      const ok = google ? await ensureGoogleFont(fam) : (await sys.register(fam), true);
      row.classList.remove('busy');
      if (!ok) { st.textContent = ''; toast(t('gf.failed', fam), 'error', 5000); return; }
      closeContextMenu();
      name.textContent = fam;
      name.style.fontFamily = `"${fam}", sans-serif`;
      onPick(fam);
    };

    const render = () => {
      [...tabs.children].forEach((b, i) => b.classList.toggle('on', (i === 0) === (tab === 'google')));
      cat.style.display = tab === 'google' ? '' : 'none';
      list.innerHTML = '';
      foot.innerHTML = '';
      io.disconnect();
      const q = search.value.trim().toLowerCase();
      if (tab === 'google') {
        lastCat = cat.value as GFamily['cat'] | '';
        const items = GOOGLE_FONTS.filter(g => (!q || g.family.toLowerCase().includes(q)) && (!lastCat || g.cat === lastCat));
        for (const g of items) {
          const row = el('div', { class: 'font-row' + (g.family === current ? ' on' : '') },
            el('span', { class: 'font-row-name', style: isGoogleLoaded(g.family) ? { fontFamily: `"${g.family}", sans-serif` } : {} }, g.family),
            el('span', { class: 'font-row-state' }, g.family === current ? icon('check', 13) : ''));
          row.dataset.family = g.family;
          row.addEventListener('click', () => pick(g.family, row, true));
          list.append(row);
          io.observe(row);
        }
        if (!items.length) list.append(el('div', { class: 'font-empty' }, t('gf.empty')));
      } else {
        const items = sys.list().filter(f => !q || f.toLowerCase().includes(q));
        for (const f of items) {
          const row = el('div', { class: 'font-row' + (f === current ? ' on' : '') },
            el('span', { class: 'font-row-name', style: { fontFamily: `"${f}", sans-serif` } }, f),
            el('span', { class: 'font-row-state' }, f === current ? icon('check', 13) : ''));
          row.addEventListener('click', () => pick(f, row, false));
          list.append(row);
        }
        if (!items.length) list.append(el('div', { class: 'font-empty' }, t('gf.empty')));
        if (sys.canLoadMore()) {
          const more = el('button', { class: 'btn sm' }, t('gf.moreSystem'));
          more.addEventListener('click', async () => { if (await sys.loadMore()) render(); });
          foot.append(more);
        }
      }
      list.scrollTop = 0;
    };
    search.addEventListener('input', render);
    cat.addEventListener('change', render);
    render();
    const r = btn.getBoundingClientRect();
    showPopup(panel, r.left, r.bottom + 4);
    setTimeout(() => search.focus(), 0);
  }
  return btn;
}
