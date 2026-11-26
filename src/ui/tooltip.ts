/**
 * One tooltip for the whole app, in the editor's own look. The browser's tooltips (the `title` attribute) were
 * plain system boxes that showed late and in another style than the toolbar's; every `title`, also in windows
 * made later, becomes `data-tip`, and any element with `data-tip` shows this tooltip.
 *
 * Placement: below the element (`data-tip-pos` = right, up, up-end for the side toolbar and the Layers panel's
 * bottom bar); it flips and slides to stay inside the window. It shows after a short pause, and at once while
 * the pointer moves along a row of buttons.
 */

const DELAY = 450;
/** after a tooltip hid, the next one shows at once for this long (moving along a toolbar) */
const QUICK = 350;
const GAP = 7;
const MARGIN = 6;

let tipEl: HTMLDivElement | null = null;
let target: HTMLElement | null = null;
let timer = 0;
let hiddenAt = 0;

/** `title` → `data-tip` (and an accessible name where the element has no text of its own). */
function adopt(el: Element) {
  const text = el.getAttribute('title');
  if (text == null || el.closest('svg') && el.tagName.toLowerCase() !== 'svg') return;
  el.removeAttribute('title');
  if (!text) return;
  (el as HTMLElement).dataset.tip = text;
  if (!el.hasAttribute('aria-label') && !(el.textContent || '').trim()) el.setAttribute('aria-label', text);
}

function place() {
  if (!tipEl || !target) return;
  const r = target.getBoundingClientRect();
  const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
  const W = window.innerWidth, H = window.innerHeight;
  const pos = target.dataset.tipPos || 'down';
  let x: number, y: number;
  if (pos === 'right') {
    x = r.right + GAP; y = r.top + r.height / 2 - th / 2;
    if (x + tw > W - MARGIN) x = r.left - GAP - tw;
  } else {
    const up = pos === 'up' || pos === 'up-end';
    x = pos === 'up-end' ? r.right - tw : r.left + r.width / 2 - tw / 2;
    y = up ? r.top - GAP - th : r.bottom + GAP;
    // no room on the chosen side: the other one
    if (up && y < MARGIN) y = r.bottom + GAP;
    if (!up && y + th > H - MARGIN) y = r.top - GAP - th;
  }
  x = Math.max(MARGIN, Math.min(x, W - MARGIN - tw));
  y = Math.max(MARGIN, Math.min(y, H - MARGIN - th));
  tipEl.style.left = Math.round(x) + 'px';
  tipEl.style.top = Math.round(y) + 'px';
}

function show() {
  if (!target || !target.isConnected) { hide(); return; }
  const text = target.dataset.tip;
  if (!text) { hide(); return; }
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'pp-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.append(tipEl);
  }
  tipEl.textContent = text;
  tipEl.classList.add('on');
  place();
}

function hide() {
  clearTimeout(timer);
  if (tipEl?.classList.contains('on')) hiddenAt = performance.now();
  tipEl?.classList.remove('on');
  target = null;
}

/** Start: adopt the titles there are and the ones added later, and follow the pointer. */
export function initTooltips() {
  document.querySelectorAll('[title]').forEach(adopt);
  new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'attributes') {
        if (m.attributeName === 'title') adopt(m.target as Element);
        // the text of the tooltip that is showing changed (a language switch, a state shown in it)
        else if (m.target === target && tipEl?.classList.contains('on')) { tipEl.textContent = target!.dataset.tip || ''; place(); }
        continue;
      }
      m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        adopt(n as Element);
        (n as Element).querySelectorAll('[title]').forEach(adopt);
      });
      // the element under the tooltip went away (a window closed, a list rebuilt)
      if (target && !target.isConnected) hide();
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title', 'data-tip'] });

  document.addEventListener('pointerover', e => {
    if (e.pointerType === 'touch') return;
    const el = (e.target as Element | null)?.closest?.<HTMLElement>('[data-tip]') ?? null;
    if (el === target) return;
    const wasShown = !!tipEl?.classList.contains('on') || performance.now() - hiddenAt < QUICK;
    hide();
    if (!el) return;
    target = el;
    if (wasShown) show(); else timer = window.setTimeout(show, DELAY);
  });
  document.addEventListener('pointerout', e => {
    if (!target) return;
    const to = e.relatedTarget as Node | null;
    if (to && target.contains(to)) return;
    hide();
  });
  // a click, a key, scrolling or the window losing focus: the tooltip goes
  for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) document.addEventListener(ev, () => { hide(); hiddenAt = 0; }, true);
  window.addEventListener('scroll', () => hide(), true);
  window.addEventListener('blur', () => hide());
}
