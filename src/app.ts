import { Doc, cloneDoc } from './core/document';
import { RGB, BLACK, WHITE } from './core/color';
import { Layer, Surface } from './core/layer';
import { Selection } from './core/selection';
import { el } from './core/util';
import { t, setLang, getLang } from './i18n';
import { Tool } from './tools/tool';
import { createTools } from './tools';
import { Viewport } from './ui/viewport';
import { MenuBar } from './ui/menubar';
import { Toolbar } from './ui/toolbar';
import { OptionsBar } from './ui/optionsbar';
import { StatusBar } from './ui/statusbar';
import { Tabs } from './ui/tabs';
import { NavigatorPanel } from './ui/panels/navigator';
import { HistoryPanel } from './ui/panels/history';
import { LayersPanel } from './ui/panels/layers';
import { installPanelResizers } from './ui/panels/panel';
import { installEffects } from './core/effects';
import { registerCommands } from './commands';
import { dialogOpen, toast, confirmDialog, sideDialogs, nudgeSideDialog } from './ui/dialog';
import { handlePaste, openFiles } from './io/files';

export interface Command {
  id: string;
  label?: string;           // i18n key (defaults to cmd.<id>)
  keys?: string[];          // e.g. 'Ctrl+Shift+Z'
  run: () => void | Promise<void>;
  enabled?: () => boolean;
  checked?: () => boolean;
}

export type UpdateFlag = 'canvas' | 'view' | 'overlay' | 'layers' | 'history' | 'tabs' | 'options' | 'colors' | 'status' | 'all';

export interface PaintTarget { layer: Layer; surface: Surface; isMask: boolean }

export let app: App;
export function createApp(root: HTMLElement) { app = new App(root); app.init(); return app; }

export class App {
  docs: Doc[] = [];
  doc: Doc | null = null;
  fg: RGB = { ...BLACK };
  bg: RGB = { ...WHITE };
  tools!: Tool[];
  tool!: Tool;
  commands = new Map<string, Command>();
  clipboard: { canvas: HTMLCanvasElement; x: number; y: number; docW: number; docH: number } | null = null;
  lastSelection: Selection | null = null;
  /** Offset applied when drawing selection ants (move tool preview). */
  selOffset = { x: 0, y: 0 };
  /** Hide marching ants (selection is being transformed). */
  hideSelection = false;
  /** Set while the color picker is open: clicks on the canvas sample a color. */
  colorPick: ((c: RGB) => void) | null = null;
  settings: any = {};
  /** Controls of an open correction window shown in the options bar instead of the tool's (Adjust presets). */
  sideOptions: { icon: string; title: string; items: () => (HTMLElement | null)[] } | null = null;
  spaceDown = false;

  viewport!: Viewport;
  /** Compare: left and right panes (viewport is the active one) */
  viewportA!: Viewport;
  viewportB!: Viewport;
  split: { a: Doc; b: Doc } | null = null;
  private viewportsEl!: HTMLElement;
  menubar!: MenuBar;
  toolbar!: Toolbar;
  optionsbar!: OptionsBar;
  statusbar!: StatusBar;
  tabs!: Tabs;
  navigator!: NavigatorPanel;
  historyPanel!: HistoryPanel;
  layersPanel!: LayersPanel;

  private pending = new Set<UpdateFlag>();
  private raf = 0;

  constructor(public root: HTMLElement) {
    try { this.settings = JSON.parse(localStorage.getItem('pp.settings') || '{}'); } catch { this.settings = {}; }
    if (this.settings.fg) this.fg = this.settings.fg;
    if (this.settings.bg) this.bg = this.settings.bg;
  }

  init() {
    setLang(getLang());
    installEffects();
    this.tools = createTools();
    for (const tl of this.tools) tl.loadOptions(this.settings.tools?.[tl.id]);
    this.tool = this.tools.find(x => x.id === (this.settings.tool || 'brush')) || this.tools[0];
    registerCommands(this);

    const menubarEl = el('header', { class: 'menubar' });
    const optionsEl = el('div', { class: 'optionsbar' });
    const toolbarEl = el('aside', { class: 'toolbar' });
    const tabsEl = el('div', { class: 'tabs' });
    const viewportEl = el('div', { class: 'viewport' });
    const viewportElB = el('div', { class: 'viewport hidden' });
    this.viewportsEl = el('div', { class: 'viewports' }, viewportEl, viewportElB);
    const panelsEl = el('aside', { class: 'panels' });
    const statusEl = el('footer', { class: 'statusbar' });
    this.root.append(
      menubarEl, optionsEl,
      el('div', { class: 'main' }, toolbarEl, el('section', { class: 'center' }, tabsEl, this.viewportsEl), panelsEl),
      statusEl,
    );
    this.viewport = this.viewportA = new Viewport(viewportEl);
    this.viewportB = new Viewport(viewportElB);
    this.menubar = new MenuBar(menubarEl);
    this.toolbar = new Toolbar(toolbarEl);
    this.optionsbar = new OptionsBar(optionsEl);
    this.statusbar = new StatusBar(statusEl);
    this.tabs = new Tabs(tabsEl);
    this.navigator = new NavigatorPanel();
    this.historyPanel = new HistoryPanel();
    this.layersPanel = new LayersPanel();
    panelsEl.append(this.navigator.el, this.historyPanel.el, this.layersPanel.el);
    installPanelResizers(panelsEl, [this.navigator, this.historyPanel, this.layersPanel]);

    window.addEventListener('keydown', e => this.onKeyDown(e));
    window.addEventListener('keyup', e => this.onKeyUp(e));
    window.addEventListener('paste', e => handlePaste(e));
    window.addEventListener('beforeunload', e => { if (this.docs.some(d => d.dirty)) { e.preventDefault(); e.returnValue = ''; } });
    window.addEventListener('blur', () => { if (this.spaceDown) { this.spaceDown = false; this.viewport.updateCursor(); } });
    // drag & drop files
    this.root.addEventListener('dragover', e => { e.preventDefault(); this.root.classList.add('dropping'); });
    this.root.addEventListener('dragleave', e => { if (e.target === this.root || !this.root.contains(e.relatedTarget as Node)) this.root.classList.remove('dropping'); });
    this.root.addEventListener('drop', e => {
      e.preventDefault();
      this.root.classList.remove('dropping');
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) openFiles(files, !!this.doc && e.altKey ? 'place' : 'open');
    });

    this.tool.activate();
    this.update('all');
  }

  /* ---------------- settings ---------------- */
  saveSettings() {
    this.settings.tools = Object.fromEntries(this.tools.map(tl => [tl.id, tl.o]));
    this.settings.tool = (this.prevTool ?? this.tool).id;
    this.settings.fg = this.fg;
    this.settings.bg = this.bg;
    try { localStorage.setItem('pp.settings', JSON.stringify(this.settings)); } catch {}
  }

  /* ---------------- updates ---------------- */
  update(...flags: UpdateFlag[]) {
    for (const f of flags) this.pending.add(f);
    if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }

  /** Synchronous canvas refresh (used during strokes). */
  private flush() {
    this.raf = 0;
    const p = this.pending;
    this.pending = new Set();
    const all = p.has('all');
    const canvas = all || p.has('canvas');
    if (canvas) { this.doc?.invalidate(); this.layersPanel.refreshThumbs(); }
    if (canvas || p.has('view')) { this.viewport.render(); this.navigator.render(); }
    if (canvas || p.has('view') || p.has('overlay')) this.viewport.renderOverlay();
    if (this.split && (canvas || p.has('view'))) this.syncPartner();
    if (all || p.has('layers')) this.layersPanel.render();
    if (all || p.has('history')) this.historyPanel.render();
    if (all || p.has('tabs')) this.tabs.render();
    if (all || p.has('options')) { this.optionsbar.render(); this.toolbar.render(); }
    if (all || p.has('colors')) this.toolbar.renderColors();
    if (all || p.has('status') || canvas || p.has('view')) this.statusbar.render();
    if (all) this.menubar.render();
  }

  /** Re-render everything after a language change. */
  relocalize() {
    this.menubar.render();
    this.update('all');
  }

  /* ---------------- documents ---------------- */
  addDoc(doc: Doc, historyLabel = 'h.open') {
    this.docs.push(doc);
    doc.history.push(historyLabel);
    this.setDoc(doc);
    this.viewport.fit(true);
    requestAnimationFrame(() => { if (doc.autoFit) this.viewport.fit(true); });
  }

  setDoc(doc: Doc | null) {
    if (this.split) {
      const pane = doc === this.split.a ? this.viewportA : doc === this.split.b ? this.viewportB : null;
      if (pane) { this.activatePane(pane); return; }
      this.endCompare();
    }
    if (this.doc === doc) return;
    this.tool.cancel();
    this.doc = doc;
    this.update('all');
  }

  async closeDoc(doc: Doc) {
    if (doc.dirty && !(await confirmDialog(t('app.unsaved')))) return;
    if (this.split && (doc === this.split.a || doc === this.split.b)) this.endCompare();
    if (doc === this.doc) this.tool.cancel();
    const i = this.docs.indexOf(doc);
    this.docs.splice(i, 1);
    if (this.doc === doc) { this.doc = null; this.setDoc(this.docs[Math.min(i, this.docs.length - 1)] || null); }
    this.update('all');
  }

  /* ---------------- compare ---------------- */
  /**
   * Split the view in two: the right pane gets an independent copy of the document with its whole history,
   * so each side can step back in history or be edited on its own. Zoom and position follow the active side.
   */
  startCompare() {
    const a = this.doc;
    if (!a || this.split) return;
    this.tool.cancel();
    const center = this.viewport.toDoc(this.viewport.w / 2, this.viewport.h / 2);
    const b = cloneDoc(a, t('app.compareCopy', a.name));
    this.docs.splice(this.docs.indexOf(a) + 1, 0, b);
    this.split = { a, b };
    this.viewportA.bound = a;
    this.viewportB.bound = b;
    this.viewportB.el.classList.remove('hidden');
    this.viewportsEl.classList.add('split');
    this.viewport = this.viewportA;
    this.markActivePane();
    this.afterLayout(() => { for (const vp of [this.viewportA, this.viewportB]) if (vp.doc?.autoFit) vp.fit(true); else vp.centerOn(center); this.update('all'); });
    this.update('all');
  }

  /** Back to one view; both documents stay open as tabs. */
  endCompare() {
    if (!this.split) return;
    this.tool.cancel();
    const center = this.viewport.toDoc(this.viewport.w / 2, this.viewport.h / 2);
    const keep = this.viewport.bound;
    this.split = null;
    this.viewportA.bound = null;
    this.viewportB.bound = null;
    this.viewportB.el.classList.add('hidden');
    this.viewportsEl.classList.remove('split');
    this.viewport = this.viewportA;
    this.doc = keep ?? this.doc;
    this.markActivePane();
    this.afterLayout(() => { if (this.doc?.autoFit) this.viewport.fit(true); else this.viewport.centerOn(center); this.update('all'); });
    this.update('all');
  }

  /** Make a Compare pane the active one (its document becomes the current document). */
  activatePane(vp: Viewport) {
    if (!this.split || vp === this.viewport) return;
    this.tool.cancel();
    this.viewport = vp;
    this.doc = vp.bound;
    this.markActivePane();
    this.update('all');
  }

  private markActivePane() {
    this.viewportA.el.classList.toggle('pane-active', !!this.split && this.viewport === this.viewportA);
    this.viewportB.el.classList.toggle('pane-active', !!this.split && this.viewport === this.viewportB);
  }

  /** The inactive pane follows the active one's zoom and position. */
  private syncPartner() {
    const s = this.split!;
    const other = this.viewport === this.viewportA ? this.viewportB : this.viewportA;
    const d = this.doc, od = other.doc;
    if (d && od && (d === s.a || d === s.b)) {
      od.zoom = d.zoom; od.panX = d.panX; od.panY = d.panY; od.autoFit = d.autoFit; od.fitted = true;
      od.viewW = d.viewW; od.viewH = d.viewH;
    }
    other.render();
    other.renderOverlay();
  }

  private afterLayout(fn: () => void) { requestAnimationFrame(() => requestAnimationFrame(fn)); }

  /** Jump in history; refit the view if the document size changed. */
  historyGo(fn: (d: Doc) => void) {
    const d = this.doc;
    if (!d) return;
    this.tool.cancel();
    const w = d.width, h = d.height;
    fn(d);
    d.dirty = true;
    if (d.width !== w || d.height !== h) this.viewport.fit(false);
    this.update('canvas', 'layers', 'history', 'overlay', 'tabs');
  }

  /** Record a history step for the current document. */
  commit(label: string) {
    const d = this.doc;
    if (!d) return;
    d.history.push(label);
    d.dirty = true;
    this.update('canvas', 'layers', 'history', 'tabs');
  }

  /* ---------------- tools ---------------- */
  private prevTool: Tool | null = null;

  /** Temporarily switch to a tool that is not on the toolbar (free transform etc.). */
  pushTool(tl: Tool) {
    this.prevTool = this.tool;
    this.tool.deactivate();
    this.tool = tl;
    tl.activate();
    this.viewport.updateCursor();
    this.update('options', 'overlay', 'status');
  }

  popTool() {
    const p = this.prevTool;
    this.prevTool = null;
    if (!p) return;
    this.tool = p;
    p.activate();
    this.viewport.updateCursor();
    this.update('options', 'overlay', 'status');
  }

  setTool(id: string) {
    const tl = this.tools.find(x => x.id === id);
    if (!tl) return;
    if (!tl.implemented) { toast(`${t(tl.nameKey)}: ${t('app.soon')}`); return; }
    if (tl === this.tool) return;
    this.prevTool = null;
    this.tool.deactivate();
    this.tool = tl;
    tl.activate();
    this.saveSettings();
    this.viewport.updateCursor();
    this.update('options', 'overlay', 'status');
  }

  setColor(which: 'fg' | 'bg', c: RGB) {
    this[which] = { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) };
    this.saveSettings();
    this.update('colors');
  }

  /** Where painting tools draw: active layer pixels or its mask. */
  paintTarget(): PaintTarget | null {
    const d = this.doc;
    const l = d?.active;
    if (!d || !l) return null;
    if (d.editMask && l.mask) return { layer: l, surface: l.mask, isMask: true };
    if (l.isGroup) { toast(t('app.groupSelected')); return null; }
    if (l.kind === 'text') { this.askRasterize(); return null; }
    return { layer: l, surface: l.content, isMask: false };
  }

  /** Command currently starting (lets an action resume after a confirmation such as rasterizing). */
  private startingCmd: string | null = null;
  private rasterAsking = false;

  /**
   * A pixel operation hit a type layer. Like Photoshop, ask before rasterizing: it is usually a mistake
   * (the wrong layer is selected). After confirmation the layer is rasterized as its own history step and
   * the command that asked is run again; a tool action (brush stroke…) is simply repeated by the user.
   */
  askRasterize() {
    const d = this.doc, l = d?.active;
    if (!d || !l || l.kind !== 'text' || this.rasterAsking) return;
    const retry = this.startingCmd;
    this.rasterAsking = true;
    confirmDialog(t('app.rasterizeAsk'), t('cmd.rasterize')).then(ok => {
      this.rasterAsking = false;
      if (!ok || this.doc !== d || d.active !== l || l.kind !== 'text') return;
      l.kind = 'raster'; l.text = null; l.touch();
      this.commit('cmd.rasterize');
      if (retry) this.run(retry);
    });
  }

  /* ---------------- commands & keys ---------------- */
  register(c: Command) { this.commands.set(c.id, c); }

  /** Commands that only change the view: available while correction/filter windows are open. */
  static readonly VIEW_COMMANDS = new Set(['zoomIn', 'zoomOut', 'fit', 'actual', 'rulers', 'showGuides', 'snap', 'clearGuides', 'shortcuts', 'about', 'language']);
  /** Correction and filter windows: different ones combine (the adjustment chain), each once. */
  static readonly CHAIN_COMMANDS = new Set([
    'enhance', 'levels', 'curves', 'gaussian', 'unsharp', 'noise', 'motionBlur', 'radialBlur', 'surfaceBlur', 'highPass', 'dehaze',
    'denoise', 'glow', 'chromatic', 'pixelate', 'halftone', 'sepia', 'posterize', 'threshold', 'emboss', 'gradientMap', 'lut',
  ]);
  /** While side windows are open: only viewing, and other correction/filter windows (an open one is pointed at). */
  commandLocked(id: string) {
    const open = sideDialogs();
    if (!open.length || App.VIEW_COMMANDS.has(id) || open.some(d => d.key === id)) return false;
    return !(App.CHAIN_COMMANDS.has(id) && open.every(d => d.chain));
  }

  run(id: string) {
    const c = this.commands.get(id);
    if (!c) { toast(t('app.soon')); return; }
    // the same window again: point at it; an edit that cannot join the open windows: point at them
    if (sideDialogs().some(d => d.key === id)) { nudgeSideDialog(id); return; }
    if (this.commandLocked(id)) { nudgeSideDialog(); return; }
    if (c.enabled && !c.enabled()) return;
    if (this.tool.busy() && !['undo', 'redo', 'zoomIn', 'zoomOut', 'fit', 'actual'].includes(id)) this.tool.cancel();
    this.startingCmd = id;
    let res: unknown;
    try { res = c.run(); }
    catch (err: any) { console.error(err); toast(`${t('app.error')}: ${err?.message || err}`, 'error', 5000); }
    finally { this.startingCmd = null; }
    Promise.resolve(res).catch(err => { console.error(err); toast(`${t('app.error')}: ${err?.message || err}`, 'error', 5000); });
  }

  static comboFromEvent(e: KeyboardEvent): string {
    let k = e.code;
    if (k.startsWith('Key')) k = k.slice(3);
    else if (k.startsWith('Digit')) k = k.slice(5);
    else if (k.startsWith('Numpad')) k = ({ NumpadAdd: '=', NumpadSubtract: '-', NumpadEnter: 'Enter' } as any)[k] ?? k.slice(6);
    else k = ({ BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.' } as any)[k] ?? k;
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    parts.push(k);
    return parts.join('+');
  }

  private onKeyDown(e: KeyboardEvent) {
    if (dialogOpen()) return;
    const tgt = e.target as HTMLElement;
    const typing = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable);
    if (typing) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!this.spaceDown) { this.spaceDown = true; this.viewport.updateCursor(); }
      return;
    }
    if (this.tool.keydown(e)) { e.preventDefault(); return; }
    const combo = App.comboFromEvent(e);
    for (const c of this.commands.values()) {
      if (c.keys?.includes(combo)) {
        if (combo === 'Ctrl+V') return; // handled by the paste event
        e.preventDefault();
        this.run(c.id);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey || e.altKey) { if (e.altKey) e.preventDefault(); return; }
    const key = combo.replace('Shift+', '');
    // tool shortcuts
    const group = this.tools.filter(x => x.key === key);
    if (group.length) {
      e.preventDefault();
      let next: Tool;
      if (group.includes(this.tool)) next = e.shiftKey ? group[(group.indexOf(this.tool) + 1) % group.length] : this.tool;
      else next = group.find(x => x.id === this.settings.lastInGroup?.[key]) || group[0];
      this.settings.lastInGroup = { ...(this.settings.lastInGroup || {}), [key]: next.id };
      this.setTool(next.id);
      return;
    }
    if (key === 'X') { const f = this.fg; this.fg = this.bg; this.bg = f; this.saveSettings(); this.update('colors'); }
    else if (key === 'D') { this.fg = { ...BLACK }; this.bg = { ...WHITE }; this.saveSettings(); this.update('colors'); }
    else if (key === '[' || key === ']') {
      const o = this.tool.o as any;
      if (e.shiftKey && typeof o.hardness === 'number') { o.hardness = Math.max(0, Math.min(100, o.hardness + (key === ']' ? 25 : -25))); }
      else if (typeof o.size === 'number') {
        const s = o.size;
        const stepv = s < 10 ? 1 : s < 50 ? 5 : s < 100 ? 10 : s < 300 ? 25 : 50;
        o.size = Math.max(1, Math.min(2500, s + (key === ']' ? stepv : -stepv)));
      }
      this.saveSettings();
      this.update('options', 'overlay');
    } else if (/^[0-9]$/.test(key)) {
      const o = this.tool.o as any;
      if (typeof o.opacity === 'number') { o.opacity = key === '0' ? 100 : parseInt(key) * 10; this.saveSettings(); this.update('options'); }
    }
  }

  private onKeyUp(e: KeyboardEvent) {
    if (e.code === 'Space' && this.spaceDown) { this.spaceDown = false; this.viewport.updateCursor(); }
    this.tool.keyup(e);
  }
}
