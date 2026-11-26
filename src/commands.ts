import { App } from './app';
import { Doc } from './core/document';
import { Layer, newRasterLayer } from './core/layer';
import { Selection } from './core/selection';
import { createCanvas, ctx2d, el } from './core/util';
import { css } from './core/color';
import { t, setLang, getLang } from './i18n';
import { openDialog, toast, promptNumber, resetDialogPositions } from './ui/dialog';
import { resetPanelLayout } from './ui/panels/panel';
import { numberField, select } from './ui/controls';
import { cloneLayer, transformLayer, transformDocument, cropDocument, mergeDown, mergeVisible, stampVisible, flatten, copySelected, clearSelected, layerBounds } from './core/ops';
import { pickFiles, openFiles, saveDoc, exportDialog, readClipboardImage, writeClipboard, placeImage } from './io/files';
import { TransformTool } from './tools/transform';
import { imageSizeDialog, canvasSizeDialog, rotateArbitraryDialog } from './ui/docdialogs';
import { fillDialog, strokeDialog } from './ui/filldialogs';
import { batchDialog } from './ui/batchdialog';
import { printDoc } from './io/print';
import { metadataDialog } from './ui/metadialog';
import { colorProfileDialog } from './ui/profiledialog';
import { associatePsd } from './io/desktop';
import { hslMixerDialog, toningDialog } from './ui/colordialogs';
import { aiSettingsDialog, upscaleDialog, removeBackground, selectSubject, removeObject } from './ui/aidialogs';
import {
  motionBlurDialog, radialBlurDialog, surfaceBlurDialog, highPassDialog, dehazeDialog, denoiseDialog, glowDialog,
  chromaticDialog, pixelateDialog, halftoneDialog, gradientMapDialog, lutDialog,
  sepiaDialog, posterizeDialog, thresholdDialog, embossDialog, desaturateDialog, invertDialog, findEdgesDialog,
} from './ui/filterdialogs';
import { enhanceDialog, levelsDialog, curvesDialog, gaussianDialog, unsharpDialog, noiseDialog } from './ui/adjustdialogs';
import { instantAdjust, invert, desaturate, autoTone, autoContrast, autoColor } from './core/adjust';
import { blurGalleryTool } from './tools/blurgallery';
import { layerStyleDialog, clearLayerStyle } from './ui/layerstyle';
import { hasEffects } from './core/layer';

export const transformTool = new TransformTool();

let layerCounter = 1;
let groupCounter = 1;

export function registerCommands(app: App) {
  const R = (id: string, run: () => any, keys?: string[], enabled?: () => boolean, extra: Partial<{ checked: () => boolean; label: string }> = {}) =>
    app.register({ id, run, keys, enabled, ...extra });
  const hasDoc = () => !!app.doc;
  const hasLayer = () => !!app.doc?.active;
  const hasPixelLayer = () => !!app.doc?.active && !app.doc.active.isGroup;
  const hasSel = () => !!app.doc?.selection;
  const D = () => app.doc!;
  const A = () => app.doc!.active!;
  const done = (label: string) => app.commit(label);

  /* ---------- File ---------- */
  R('new', () => newDocDialog(app), ['Ctrl+N']);
  R('newFromClipboard', async () => {
    const img = await readClipboardImage();
    if (!img) { toast(t('app.noSelection')); return; }
    const d = Doc.fromImage(t('app.untitled'), img);
    d.root.children[0].name = t('layers.layer') + ' 1';
    app.addDoc(d, 'h.new');
  }, ['Ctrl+Alt+N']);
  R('open', async () => openFiles(await pickFiles(), 'open'), ['Ctrl+O']);
  R('place', async () => openFiles(await pickFiles(), 'place'), [], hasDoc);
  R('save', () => saveDoc(false), ['Ctrl+S'], hasDoc);
  R('saveAs', () => saveDoc(true), ['Ctrl+Shift+S'], hasDoc);
  R('export', () => exportDialog(false), ['Ctrl+Alt+Shift+W'], hasDoc);
  R('batch', () => batchDialog());
  R('print', () => printDoc(), ['Ctrl+P'], hasDoc);
  R('close', () => app.closeDoc(D()), ['Ctrl+W'], hasDoc);

  /* ---------- Edit ---------- */
  R('undo', () => app.historyGo(d => d.history.undo()), ['Ctrl+Z'], () => !!app.doc?.history.canUndo);
  R('redo', () => app.historyGo(d => d.history.redo()), ['Ctrl+Shift+Z', 'Ctrl+Y'], () => !!app.doc?.history.canRedo);
  const copy = (merged: boolean) => {
    const d = D();
    let res;
    if (merged) {
      const c = d.composite();
      const r = d.selection ? d.selection.bounds : { x: 0, y: 0, w: d.width, h: d.height };
      const out = createCanvas(r.w, r.h);
      const g = ctx2d(out);
      g.drawImage(c, -r.x, -r.y);
      if (d.selection) { g.globalCompositeOperation = 'destination-in'; g.drawImage(d.selection.mask, -r.x, -r.y); }
      res = { canvas: out, x: r.x, y: r.y };
    } else res = copySelected(A(), d.selection, d.width, d.height);
    if (!res) return false;
    app.clipboard = { ...res, docW: d.width, docH: d.height };
    writeClipboard(res.canvas);
    toast(t('app.copied'), 'info', 1200);
    return true;
  };
  R('copy', () => { copy(false); }, ['Ctrl+C'], hasPixelLayer);
  R('copyMerged', () => { copy(true); }, ['Ctrl+Shift+C'], hasDoc);
  R('cut', () => { if (copy(false) && D().selection) { clearSelected(A(), D().selection!); done('cmd.cut'); } }, ['Ctrl+X'], () => hasPixelLayer() && hasSel());
  R('paste', async () => {
    const img = await readClipboardImage();
    if (!img) return;
    if (!app.doc) { const d = Doc.fromImage(t('app.untitled'), img); d.root.children[0].name = t('layers.layer') + ' 1'; app.addDoc(d, 'h.new'); return; }
    const ic = app.clipboard;
    const same = ic && ic.docW === D().width && ic.docH === D().height && ic.canvas.width === img.width && ic.canvas.height === img.height;
    placeImage(img, t('layers.layer'), 'h.paste', same ? ic!.x : undefined, same ? ic!.y : undefined);
  }, ['Ctrl+V']);
  R('clear', () => {
    const d = D(), l = A();
    if (!d.selection) { toast(t('app.noSelection')); return; }
    if (d.editMask && l.mask) {
      const g = l.mask.ctx;
      g.globalCompositeOperation = 'destination-out'; g.drawImage(d.selection.mask, -l.mask.x, -l.mask.y); g.globalCompositeOperation = 'source-over';
      l.mask.markDirtyDoc(d.selection.bounds); l.touch();
    } else clearSelected(l, d.selection);
    done('cmd.clear');
  }, ['Delete', 'Backspace'], hasPixelLayer);
  const fillWith = (bg: boolean) => {
    const target = app.paintTarget();
    if (!target) return;
    const d = D();
    const color = bg ? app.bg : app.fg;
    const s = target.surface;
    s.ensureCovers({ x: 0, y: 0, w: d.width, h: d.height });
    const buf = createCanvas(d.width, d.height);
    const g = ctx2d(buf);
    g.fillStyle = target.isMask ? `rgba(255,255,255,${(color.r * .299 + color.g * .587 + color.b * .114) / 255})` : css(color);
    g.fillRect(0, 0, d.width, d.height);
    if (d.selection) { g.globalCompositeOperation = 'destination-in'; g.drawImage(d.selection.mask, 0, 0); }
    const sg = s.ctx;
    if (target.isMask) { sg.globalCompositeOperation = 'destination-out'; sg.drawImage(d.selection ? d.selection.mask : buf, -s.x, -s.y); }
    sg.globalCompositeOperation = target.layer.lockAlpha && !target.isMask ? 'source-atop' : 'source-over';
    sg.drawImage(buf, -s.x, -s.y);
    sg.globalCompositeOperation = 'source-over';
    s.markDirtyDoc({ x: 0, y: 0, w: d.width, h: d.height });
    target.layer.touch();
    done(bg ? 'cmd.fillBg' : 'cmd.fill');
  };
  R('fill', () => fillWith(false), ['Alt+Backspace', 'Alt+Delete'], hasPixelLayer);
  R('fillBg', () => fillWith(true), ['Ctrl+Backspace', 'Ctrl+Delete'], hasPixelLayer);

  R('freeTransform', () => { if (transformTool.begin()) app.pushTool(transformTool); }, ['Ctrl+T'], hasLayer);
  R('transformSel', () => { if (transformTool.begin(true)) app.pushTool(transformTool); }, [], hasSel);
  R('fillDialog', () => fillDialog(), ['Shift+F5'], hasPixelLayer);
  R('strokeSel', () => strokeDialog(), [], () => hasPixelLayer() && hasSel());

  const layerXform = (id: string, mk: (b: { x: number; y: number; w: number; h: number }) => DOMMatrix) => {
    R(id, () => {
      const l = A();
      const b = layerBounds(l);
      if (!b) return;
      transformLayer(l, mk(b));
      done('cmd.' + id);
    }, undefined, hasLayer);
  };
  const about = (b: any, m: DOMMatrix) => new DOMMatrix().translate(b.x + b.w / 2, b.y + b.h / 2).multiply(m).translate(-(b.x + b.w / 2), -(b.y + b.h / 2));
  layerXform('rotateLayer180', b => about(b, new DOMMatrix().rotate(180)));
  layerXform('rotateLayerCW', b => about(b, new DOMMatrix().rotate(90)));
  layerXform('rotateLayerCCW', b => about(b, new DOMMatrix().rotate(-90)));
  layerXform('flipLayerH', b => about(b, new DOMMatrix().scale(-1, 1)));
  layerXform('flipLayerV', b => about(b, new DOMMatrix().scale(1, -1)));

  /* ---------- Image ---------- */
  const docXform = (id: string, kind: Parameters<typeof transformDocument>[1]) =>
    R(id, () => { transformDocument(D(), kind); done('cmd.' + id); app.viewport.fit(false); }, undefined, hasDoc);
  docXform('rot180', '180');
  docXform('rotCW', 'cw');
  docXform('rotCCW', 'ccw');
  docXform('flipCanvasH', 'flipH');
  docXform('flipCanvasV', 'flipV');
  // adjustments & filters
  R('enhance', () => enhanceDialog(false), ['Ctrl+U'], hasPixelLayer);
  R('settings', () => aiSettingsDialog(), ['Ctrl+K']);
  R('upscale', () => upscaleDialog(), [], hasDoc);
  R('removeBg', () => removeBackground(), [], hasPixelLayer);
  R('removeObject', () => removeObject(), [], () => hasPixelLayer() && hasSel());
  R('selectSubject', () => selectSubject(), [], hasDoc);
  R('motionBlur', () => motionBlurDialog(), [], hasPixelLayer);
  R('radialBlur', () => radialBlurDialog(), [], hasPixelLayer);
  R('surfaceBlur', () => surfaceBlurDialog(), [], hasPixelLayer);
  R('highPass', () => highPassDialog(), [], hasPixelLayer);
  R('dehaze', () => dehazeDialog(), [], hasPixelLayer);
  R('denoise', () => denoiseDialog(), [], hasPixelLayer);
  R('glow', () => glowDialog(), [], hasPixelLayer);
  R('chromatic', () => chromaticDialog(), [], hasPixelLayer);
  R('pixelate', () => pixelateDialog(), [], hasPixelLayer);
  R('halftone', () => halftoneDialog(), [], hasPixelLayer);
  R('gradientMap', () => gradientMapDialog(), [], hasPixelLayer);
  R('sepia', () => sepiaDialog(), [], hasPixelLayer);
  R('posterize', () => posterizeDialog(), [], hasPixelLayer);
  R('threshold', () => thresholdDialog(), [], hasPixelLayer);
  R('emboss', () => embossDialog(), [], hasPixelLayer);
  R('findEdges', () => findEdgesDialog(), [], hasPixelLayer);
  R('lut', () => lutDialog(), [], hasPixelLayer);
  R('levels', () => levelsDialog(), ['Ctrl+L'], hasPixelLayer);
  R('curves', () => curvesDialog(), ['Ctrl+M'], hasPixelLayer);
  R('hslMixer', () => hslMixerDialog(), [], hasPixelLayer);
  R('toning', () => toningDialog(), [], hasPixelLayer);
  // from the Filter menu: a window with a strength slider; the shortcuts apply them at once, at 100 %
  R('invert', () => invertDialog(), [], hasPixelLayer);
  R('desaturate', () => desaturateDialog(), [], hasPixelLayer);
  R('invertNow', () => instantAdjust('cmd.invert', invert), ['Ctrl+I'], hasPixelLayer, { label: 'cmd.invert' });
  R('desaturateNow', () => instantAdjust('cmd.desaturate', desaturate), ['Ctrl+Shift+U'], hasPixelLayer, { label: 'cmd.desaturate' });
  R('gaussian', () => gaussianDialog(), [], hasPixelLayer);
  R('unsharp', () => unsharpDialog(), [], hasPixelLayer);
  R('noise', () => noiseDialog(), [], hasPixelLayer);
  const gallery = (id: string, mode: 'field' | 'iris' | 'tilt') => R(id, () => { if (blurGalleryTool.begin(mode)) app.pushTool(blurGalleryTool); }, [], hasPixelLayer);
  gallery('fieldBlur', 'field');
  gallery('irisBlur', 'iris');
  gallery('tiltShift', 'tilt');

  R('imageSize', () => imageSizeDialog(), ['Ctrl+Alt+I'], hasDoc);
  R('metadata', () => metadataDialog(), [], hasDoc);
  R('colorProfile', () => colorProfileDialog(), [], hasDoc);
  R('canvasSize', () => canvasSizeDialog(), ['Ctrl+Alt+C'], hasDoc);
  R('rotArbitrary', () => rotateArbitraryDialog(), [], hasDoc);
  R('cropToSel', () => { cropDocument(D(), D().selection!.bounds); D().selection = null; done('cmd.cropToSel'); app.viewport.fit(false); }, undefined, hasSel);

  /* ---------- Layer ---------- */
  const nextLayerName = () => `${t('layers.layer')} ${++layerCounter}`;
  R('newLayer', () => {
    const d = D();
    const l = newRasterLayer(nextLayerName(), d.width, d.height);
    d.add(l);
    app.layersPanel.clearMulti();
    done('cmd.newLayer');
  }, ['Ctrl+Shift+N'], hasDoc);
  R('newGroup', () => {
    const d = D();
    const g = new Layer('group', `${t('layers.groupName')} ${groupCounter++}`);
    d.add(g, d.active, false);
    done('cmd.newGroup');
  }, [], hasDoc);
  R('groupLayers', () => {
    const d = D();
    const sel = app.layersPanel.selected();
    if (!sel.length) return;
    const top = sel[sel.length - 1];
    const g = new Layer('group', `${t('layers.groupName')} ${groupCounter++}`);
    const parent = top.parent!;
    const idx = parent.children.indexOf(top);
    parent.children.splice(idx + 1, 0, g);
    g.parent = parent;
    for (const l of sel) { d.move(l, g, g.children.length); }
    for (const l of g.children) if (g.children[0] === l) l.clipped = false;
    d.setActive(g);
    app.layersPanel.clearMulti();
    done('cmd.groupLayers');
  }, ['Ctrl+G'], hasLayer);
  R('ungroup', () => {
    const d = D(), g = A();
    if (!g.isGroup) return;
    const p = g.parent!;
    const idx = p.children.indexOf(g);
    const kids = [...g.children];
    p.children.splice(idx, 1, ...kids);
    kids.forEach(k => (k.parent = p));
    d.setActive(kids[kids.length - 1] || null);
    d.invalidate();
    done('cmd.ungroup');
  }, ['Ctrl+Shift+G'], () => !!app.doc?.active?.isGroup);
  R('duplicate', () => {
    const d = D();
    const src = A();
    const c = cloneLayer(src, ' ' + t('layers.copy'));
    d.add(c, src, false);
    done('cmd.duplicate');
  }, [], hasLayer);
  R('layerViaCopy', () => {
    const d = D(), l = A();
    if (!d.selection || l.isGroup) { app.run('duplicate'); return; }
    const res = copySelected(l, d.selection, d.width, d.height)!;
    const n = newRasterLayer(nextLayerName(), res.canvas.width, res.canvas.height, res.x, res.y);
    n.content.ctx.drawImage(res.canvas, 0, 0);
    d.add(n, l, false);
    d.selection = null;
    done('cmd.layerViaCopy');
  }, ['Ctrl+J'], hasLayer);
  R('layerViaCut', () => {
    const d = D(), l = A();
    if (!d.selection || l.isGroup) return;
    const res = copySelected(l, d.selection, d.width, d.height)!;
    clearSelected(l, d.selection);
    const n = newRasterLayer(nextLayerName(), res.canvas.width, res.canvas.height, res.x, res.y);
    n.content.ctx.drawImage(res.canvas, 0, 0);
    d.add(n, l, false);
    d.selection = null;
    done('cmd.layerViaCut');
  }, ['Ctrl+Shift+J'], () => hasPixelLayer() && hasSel());
  R('deleteLayer', () => {
    const d = D();
    const sel = app.layersPanel.selected();
    for (const l of sel) d.remove(l);
    app.layersPanel.clearMulti();
    done('cmd.deleteLayer');
  }, [], hasLayer);
  R('layerStyle', () => layerStyleDialog(), [], hasLayer);
  R('clearStyle', () => { clearLayerStyle(A()); done('cmd.clearStyle'); }, [], () => !!app.doc?.active && hasEffects(app.doc.active.effects));
  R('rasterize', () => { const l = A(); if (l.kind === 'text') { l.kind = 'raster'; l.text = null; } done('cmd.rasterize'); }, [], () => app.doc?.active?.kind === 'text');

  // masks
  const addMask = (fill: 0 | 255, fromSel: 'reveal' | 'hide' | null) => {
    const d = D(), l = A();
    if (l.mask) { toast(t('cmd.layerMask') + ' ✓'); return; }
    const m = l.addMask(d.width, d.height, fill);
    if (fromSel && d.selection) {
      const g = m.ctx;
      g.clearRect(0, 0, m.w, m.h);
      if (fromSel === 'reveal') g.drawImage(d.selection.mask, -m.x, -m.y);
      else { g.fillStyle = '#fff'; g.fillRect(0, 0, m.w, m.h); g.globalCompositeOperation = 'destination-out'; g.drawImage(d.selection.mask, -m.x, -m.y); g.globalCompositeOperation = 'source-over'; }
      m.fill = fromSel === 'reveal' ? 0 : 255;
      d.selection = null;
    }
    d.editMask = true;
    done('cmd.layerMask');
  };
  R('maskReveal', () => addMask(255, D().selection ? 'reveal' : null), [], hasLayer);
  R('maskHide', () => addMask(0, null), [], hasLayer);
  R('maskFromSel', () => addMask(0, 'reveal'), [], () => hasLayer() && hasSel());
  R('maskHideSel', () => addMask(255, 'hide'), [], () => hasLayer() && hasSel());
  R('maskDelete', () => { const l = A(); l.mask = null; D().editMask = false; l.touch(); done('cmd.maskDelete'); }, [], () => !!app.doc?.active?.mask);
  R('maskToggle', () => { const l = A(); l.mask!.enabled = !l.mask!.enabled; l.touch(); done('cmd.maskToggle'); }, [], () => !!app.doc?.active?.mask);
  R('maskApply', () => {
    const d = D(), l = A();
    if (l.isGroup || !l.mask) return;
    const m = l.mask;
    if (m.fill === 255) m.ensureCovers(l.content.bounds());
    const g = l.content.ctx;
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(m.canvas, m.x - l.x, m.y - l.y);
    g.globalCompositeOperation = 'source-over';
    l.content.markDirty();
    l.mask = null; d.editMask = false; l.touch();
    done('cmd.maskApply');
  }, [], () => !!app.doc?.active?.mask && !app.doc.active.isGroup);
  R('clipMask', () => {
    const l = A();
    if (l.parent!.children.indexOf(l) === 0) return;
    l.clipped = !l.clipped; l.touch();
    done('cmd.clipMask');
  }, ['Ctrl+Alt+G'], hasLayer);
  const arrange = (id: string, fn: (l: Layer) => void, keys: string[]) => R(id, () => { fn(A()); done('h.reorder'); }, keys, hasLayer);
  arrange('bringFront', l => D().shift(l, 1e6), ['Ctrl+Shift+]']);
  arrange('bringForward', l => D().shift(l, 1), ['Ctrl+]']);
  arrange('sendBackward', l => D().shift(l, -1), ['Ctrl+[']);
  arrange('sendBack', l => D().shift(l, -1e6), ['Ctrl+Shift+[']);
  R('lockAlpha', () => { const l = A(); l.lockAlpha = !l.lockAlpha; done('h.layerProps'); }, ['/'], hasPixelLayer, { checked: () => !!app.doc?.active?.lockAlpha });
  R('mergeDown', () => { if (mergeDown(D(), A())) done('cmd.mergeDown'); }, ['Ctrl+E'], hasLayer);
  R('mergeVisible', () => { mergeVisible(D(), nextLayerName()); done('cmd.mergeVisible'); }, ['Ctrl+Shift+E'], hasDoc);
  R('stampVisible', () => { const d = D(); const l = stampVisible(d, nextLayerName()); d.add(l); done('cmd.stampVisible'); }, ['Ctrl+Alt+Shift+E'], hasDoc);
  R('flatten', () => { flatten(D(), t('layers.background')); done('cmd.flatten'); }, [], hasDoc);

  /* ---------- Select ---------- */
  const setSel = (s: Selection | null, label: string) => {
    const d = D();
    if (!s && d.selection) app.lastSelection = d.selection;
    d.selection = s;
    done(label);
    app.update('overlay');
  };
  R('selectAll', () => setSel(Selection.all(D().width, D().height), 'h.select'), ['Ctrl+A'], hasDoc);
  R('deselect', () => setSel(null, 'h.deselect'), ['Ctrl+D'], hasSel);
  R('reselect', () => {
    const s = app.lastSelection;
    if (s && s.width === D().width && s.height === D().height) setSel(s, 'h.select');
  }, ['Ctrl+Shift+D'], () => !!app.lastSelection && hasDoc());
  R('inverse', () => setSel(D().selection!.invert(), 'h.select'), ['Ctrl+Shift+I'], hasSel);
  const modify = (id: string, keys: string[], fn: (s: Selection, v: number) => Selection | null, max = 500) =>
    R(id, async () => {
      const v = await promptNumber(t('cmd.' + id), t('dlg.radius'), app.settings['sel_' + id] ?? 2, 1, max, t('dlg.px'));
      if (v == null) return;
      app.settings['sel_' + id] = v; app.saveSettings();
      setSel(fn(D().selection!, v), 'h.select');
    }, keys, hasSel);
  modify('feather', ['Shift+F6'], (s, v) => s.feather(v));
  modify('expand', [], (s, v) => s.grow(v));
  modify('contract', [], (s, v) => s.grow(-v));
  modify('smooth', [], (s, v) => s.smooth(v), 100);
  R('selectLayerPixels', () => {
    const d = D(), l = A();
    const c = createCanvas(d.width, d.height);
    const g = ctx2d(c);
    if (l.isGroup) g.drawImage(d.composite(), 0, 0); else g.drawImage(l.canvas, l.x, l.y);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = '#fff'; g.fillRect(0, 0, d.width, d.height);
    setSel(Selection.fromMask(c), 'h.select');
  }, [], hasLayer);

  /* ---------- View ---------- */
  R('zoomIn', () => app.viewport.zoomStep(1), ['Ctrl+=', 'Ctrl+Shift+='], hasDoc);
  R('zoomOut', () => app.viewport.zoomStep(-1), ['Ctrl+-'], hasDoc);
  R('fit', () => app.viewport.fit(false), ['Ctrl+0'], hasDoc);
  R('actual', () => app.viewport.setDeviceZoom(1), ['Ctrl+1'], hasDoc);
  R('compare', () => (app.split ? app.endCompare() : app.startCompare()), [], hasDoc, { checked: () => !!app.split });
  const toggleSetting = (id: string, key: string, def: boolean, keys: string[]) =>
    R(id, () => { app.settings[key] = !(app.settings[key] ?? def); app.saveSettings(); app.update('overlay'); }, keys, undefined, { checked: () => app.settings[key] ?? def });
  // the rulers cover part of the canvas: the picture re-centres (or refits) for the visible area
  R('rulers', () => {
    app.settings.rulers = !(app.settings.rulers ?? false);
    app.saveSettings();
    const d = app.doc, vp = app.viewport;
    if (d) { if (d.autoFit) vp.fit(true); else vp.snapPan(); }
    app.update('view', 'overlay');
  }, ['Ctrl+R'], undefined, { checked: () => app.settings.rulers ?? false });
  toggleSetting('showGuides', 'showGuides', true, ['Ctrl+;']);
  toggleSetting('snap', 'snap', true, ['Ctrl+Shift+;']);
  R('resetLayout', () => { resetDialogPositions(); resetPanelLayout(); app.update('all'); });
  R('clearGuides', () => { const d = D(); d.guides = { h: [], v: [] }; app.update('overlay'); }, [], () => !!app.doc && (app.doc.guides.h.length + app.doc.guides.v.length > 0));

  R('language', () => { setLang(getLang() === 'ru' ? 'en' : 'ru'); app.relocalize(); });

  /* ---------- Help ---------- */
  R('shortcuts', () => shortcutsDialog(app));
  R('psdAssoc', async () => {
    try { await associatePsd(); toast(t('app.psdAssocDone'), 'info', 6000); }
    catch (e: any) { toast(`${t('app.error')}: ${e?.message || e}`, 'error', 5000); }
  });
  R('about', () => openDialog({ title: 'PhotoPane', body: el('p', { class: 'dlg-text' }, t('about.text', __APP_VERSION__)), cancelLabel: null, width: 360 }));

  void placeImage;
}

/* ---------------- dialogs ---------------- */
function newDocDialog(app: App) {
  const s = app.settings.newDoc || { w: 1920, h: 1080, bg: 'white' };
  let w = s.w, h = s.h, bg = s.bg;
  const name = el('input', { class: 'text-input', value: t('app.untitled') }) as HTMLInputElement;
  const wf = numberField({ value: w, min: 1, max: 30000, unit: t('dlg.px'), width: 64, onChange: v => (w = v) });
  const hf = numberField({ value: h, min: 1, max: 30000, unit: t('dlg.px'), width: 64, onChange: v => (h = v) });
  const presets: [string, number, number][] = [['Full HD 1920×1080', 1920, 1080], ['4K 3840×2160', 3840, 2160], ['Instagram 1080×1080', 1080, 1080],
    ['Instagram Story 1080×1920', 1080, 1920], ['YouTube 1280×720', 1280, 720], ['A4 300 dpi 2480×3508', 2480, 3508], ['800×600', 800, 600]];
  const presetRow = el('div', { class: 'preset-row' }, ...presets.map(([label, pw, ph]) => {
    const b = el('button', { class: 'chip' }, label);
    b.addEventListener('click', () => { w = pw; h = ph; wf.set(pw); hf.set(ph); });
    return b;
  }));
  const body = el('div', { class: 'form' },
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.name')), name),
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.width')), wf),
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.height')), hf),
    el('div', { class: 'form-row' }, el('label', {}, t('dlg.background')),
      select([{ value: 'white', label: t('dlg.bg.white') }, { value: 'black', label: t('dlg.bg.black') }, { value: 'transparent', label: t('dlg.bg.transparent') }, { value: 'bgcolor', label: t('dlg.bg.bgColor') }], bg, v => (bg = v))),
    el('div', { class: 'form-label' }, t('dlg.presets')), presetRow);
  openDialog({
    title: t('dlg.new.title'), body, width: 460, okLabel: t('dlg.create'),
    onOk: () => {
      app.settings.newDoc = { w, h, bg }; app.saveSettings();
      const color = bg === 'white' ? '#fff' : bg === 'black' ? '#000' : bg === 'bgcolor' ? css(app.bg) : null;
      const d = Doc.blank(name.value || t('app.untitled'), w, h, color);
      d.root.children[0].name = color ? t('layers.background') : t('layers.layer') + ' 1';
      app.addDoc(d, 'h.new');
    },
  });
}

function shortcutsDialog(app: App) {
  const rows: HTMLElement[] = [];
  for (const tl of app.tools) if (tl.key) rows.push(el('div', { class: 'sc-row' }, el('span', {}, t(tl.nameKey)), el('kbd', {}, tl.key)));
  const cmds = ['undo', 'redo', 'copy', 'copyMerged', 'paste', 'freeTransform', 'newLayer', 'layerViaCopy', 'groupLayers', 'mergeDown', 'stampVisible', 'selectAll', 'deselect', 'inverse', 'save', 'saveAs'];
  for (const id of cmds) { const c = app.commands.get(id); if (c?.keys?.length) rows.push(el('div', { class: 'sc-row' }, el('span', {}, t('cmd.' + id)), el('kbd', {}, c.keys[0]))); }
  const body = el('div', {}, el('p', { class: 'muted sm' }, t('sc.space')), el('p', { class: 'muted sm' }, t('sc.zoom')), el('p', { class: 'muted sm' }, t('sc.colors')), el('div', { class: 'sc-grid' }, ...rows));
  openDialog({ title: t('sc.title'), body, cancelLabel: null, width: 560 });
}
