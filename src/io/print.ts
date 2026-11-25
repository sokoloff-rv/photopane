/**
 * Printing: the image, not the editor window. Before the browser prints (File → Print, Ctrl+P, or the system
 * print shortcut while a window is open) the page is replaced by the flattened image, fitted to the paper
 * in the orientation that suits it; afterwards everything is as it was.
 */
import { app } from '../app';
import { createCanvas, ctx2d } from '../core/util';

let host: HTMLElement | null = null;
let pageStyle: HTMLStyleElement | null = null;

function prepare() {
  cleanup();
  const d = app.doc;
  host = document.createElement('div');
  host.className = 'print-host';
  if (d) {
    // a canvas prints its pixels at once (an <img> from a data URL could still be loading)
    const c = createCanvas(d.width, d.height);
    // converted to sRGB like the screen and the flattened exports (an Adobe RGB picture printed raw looked dull)
    ctx2d(c).drawImage(d.displayComposite(), 0, 0);
    host.append(c);
  }
  document.body.append(host);
  document.body.classList.add('printing');
  // landscape paper for wide images; no page margin, so the browser adds no header (date, address) or footer
  pageStyle = document.createElement('style');
  pageStyle.textContent = `@page { size: ${d && d.width > d.height ? 'landscape' : 'portrait'}; margin: 0; }`;
  document.head.append(pageStyle);
}

function cleanup() {
  host?.remove(); host = null;
  pageStyle?.remove(); pageStyle = null;
  document.body.classList.remove('printing');
}

window.addEventListener('beforeprint', prepare);
window.addEventListener('afterprint', cleanup);

/** File → Print. */
export function printDoc() {
  if (!app.doc) return;
  window.print();
}
