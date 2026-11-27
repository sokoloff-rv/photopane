/**
 * Desktop app (Tauri) only: files opened from the system (double click on a .psd, "Open with", a second
 * launch while PhotoPane is open), the Windows window frame drawn by the app, and making PhotoPane the
 * program for .psd files.
 */
import { openFiles } from './files';

export const inTauri = () => !!(window as any).__TAURI_INTERNALS__;
/** The Windows desktop app: its window has no system frame, the menu bar is the title bar. */
export const windowsDesktop = () => inTauri() && /Windows/i.test(navigator.userAgent);

/** Open files given by path (read with the fs plugin; saving goes back to the same path). */
async function openPaths(paths: string[]) {
  const fs = await import('@tauri-apps/plugin-fs');
  const items: { file: File; handle: { tauriPath: string; name: string } }[] = [];
  for (const p of paths) {
    try {
      const bytes = await fs.readFile(p);
      const name = p.split(/[\\/]/).pop() || p;
      items.push({ file: new File([bytes], name), handle: { tauriPath: p, name } });
    } catch (e) { console.warn('PhotoPane: cannot open', p, e); }
  }
  if (items.length) await openFiles(items, 'open');
}

/** At start: the files PhotoPane was launched with, and the ones a later launch passes on. */
export async function initDesktop() {
  if (!inTauri()) return;
  // the window starts hidden, already in place (main.rs): shown once the interface is drawn, it appears
  // whole, at its size, without a white frame first
  // (after two frames, or a moment, whichever comes first: a hidden window may get no animation frames, macOS)
  let shown = false;
  const show = async () => {
    if (shown) return;
    shown = true;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const w = getCurrentWindow();
      await w.show();
      await w.setFocus();
    } catch (e) { console.warn('PhotoPane: show window', e); }
  };
  requestAnimationFrame(() => requestAnimationFrame(() => void show()));
  setTimeout(() => void show(), 120);
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    await listen<string[]>('open-files', e => void openPaths(e.payload));
    const files = await invoke<string[]>('startup_files');
    if (files.length) await openPaths(files);
  } catch (e) { console.warn('PhotoPane: desktop start', e); }
}

/** Help → Open PSD files in PhotoPane (Windows): registers PhotoPane for .psd for this user. */
export async function associatePsd(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('associate_psd');
}

/** Help → About: the source code page, in the system's browser (a link in the app's window goes nowhere). */
export async function openSourcePage(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_source_page');
}

/** The window buttons of the app's own title bar (Windows). */
export async function windowControls(): Promise<HTMLElement | null> {
  if (!windowsDesktop()) return null;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  const svg = (d: string) => `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1">${d}</svg>`;
  const ICON = {
    min: svg('<path d="M0 5.5h10"/>'),
    max: svg('<rect x="0.5" y="0.5" width="9" height="9"/>'),
    restore: svg('<rect x="0.5" y="2.5" width="7" height="7"/><path d="M2.5 2.5V0.5h7v7h-2"/>'),
    close: svg('<path d="M0.5 0.5l9 9M9.5 0.5l-9 9"/>'),
  };
  const box = document.createElement('div');
  box.className = 'win-controls';
  const btn = (cls: string, html: string, run: () => void) => {
    const b = document.createElement('button');
    b.className = 'win-btn ' + cls; b.innerHTML = html; b.tabIndex = -1;
    b.addEventListener('click', run);
    box.append(b);
    return b;
  };
  btn('min', ICON.min, () => void win.minimize());
  const max = btn('max', ICON.max, () => void win.toggleMaximize());
  // close goes through the unsaved-work question (onCloseRequested in app.ts)
  btn('close', ICON.close, () => void win.close());
  const sync = async () => { max.innerHTML = (await win.isMaximized()) ? ICON.restore : ICON.max; };
  void sync();
  void win.onResized(() => void sync());
  return box;
}
