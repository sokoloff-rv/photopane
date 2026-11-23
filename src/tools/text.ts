import { app } from '../app';
import { t } from '../i18n';
import { Tool, PEvent } from './tool';
import { Layer, TextData, defaultText, CharStyle } from '../core/layer';
import {
  layoutText, renderTextLayer, COMMON_FONTS, baselineOffset, styleAt, applyStyle, applyStyleAll, textEdited,
  caretPos, hitIndex, selectionRects, baseStyle, toLocalPoint, toDocPoint, textQuad, textMatrix, fontWeight,
} from '../core/text';
import { icon } from '../ui/icons';
import { fontPicker } from '../ui/fontpicker';
import { onGoogleFontLoaded } from '../core/gfonts';
import { pointInPoly } from '../core/geom';
import { css, RGB } from '../core/color';
import { el, normRect } from '../core/util';
import { numberField, select, segmented, colorSwatch, sep } from '../ui/controls';
import { spacer, textButton } from './transform';
import { toast } from '../ui/dialog';
import { loadLocalFontList, localFamilies, registerFamily, localFontsSupported } from '../core/fonts';
import { clearFontCaches } from '../core/text';

interface TextOpts { font: string; size: number; bold: boolean; italic: boolean; underline: boolean; align: 'left' | 'center' | 'right'; leading: number; tracking: number; weight: number; strike: boolean; caps: boolean }

// a Google family finished loading: redraw the text layers that use it (they were drawn with a fallback)
onGoogleFontLoaded(family => {
  clearFontCaches();
  for (const d of app.docs) for (const l of d.layers) {
    const td = l.text;
    if (l.kind !== 'text' || !td || td.psdPixels) continue;
    if (td.font === family || td.runs?.some(r => r.s.font === family)) renderTextLayer(l);
  }
  app.update('canvas', 'overlay', 'options');
});

let systemFonts: string[] | null = null;
let textCounter = 1;

/**
 * Type tool. Text input goes through a hidden textarea (keyboard, IME, clipboard, selection offsets);
 * the caret and the selection are drawn on the canvas from our own layout, so they match characters of
 * different sizes exactly. Option changes apply to the selected characters, or to the whole layer.
 */
export class TextTool extends Tool<TextOpts> {
  readonly id = 'text';
  readonly iconName = 'text';
  readonly key = 'T';
  cursor = 'text';
  private editing: Layer | null = null;
  private isNew = false;
  private before = '';
  private ta: HTMLTextAreaElement | null = null;
  private lastText = '';
  private dragStart: { x: number; y: number } | null = null;
  private dragCur: { x: number; y: number } | null = null;
  private selecting: number | null = null;
  private blinkOn = true;
  private blinkTimer = 0;
  private lastClick = { time: 0, idx: -1, count: 0 };

  constructor() { super({ font: 'Arial', size: 48, bold: false, italic: false, underline: false, align: 'left', leading: 1.2, tracking: 0, weight: 400, strike: false, caps: false }); }

  /** Text layer under a document point. */
  private hitText(x: number, y: number): Layer | null {
    const d = app.doc!;
    for (const l of [...d.layers].reverse()) {
      if (l.kind !== 'text' || !l.text || !l.effectiveVisible) continue;
      const f = layoutText(l.text).frame;
      const p = toLocalPoint(l.text, x, y);
      if (p.x >= f.x - 4 && p.y >= f.y - 4 && p.x <= f.x + f.w + 4 && p.y <= f.y + f.h + 4) return l;
    }
    return null;
  }

  private insideEditing(x: number, y: number) {
    const tx = this.editing?.text;
    if (!tx) return false;
    const f = layoutText(tx).frame;
    const m = 6 / (app.doc?.zoom || 1);
    const p = toLocalPoint(tx, x, y);
    return p.x >= f.x - m && p.y >= f.y - m && p.x <= f.x + f.w + m && p.y <= f.y + f.h + m;
  }

  down(e: PEvent) {
    if (this.editing) {
      if (this.insideEditing(e.x, e.y)) { this.pointerSelect(e); return; }
      this.commit();
      return;
    }
    const hit = this.hitText(e.x, e.y);
    if (hit) { this.edit(hit); this.pointerSelect(e); return; }
    this.dragStart = { x: e.x, y: e.y };
    this.dragCur = { x: e.x, y: e.y };
  }

  /** Click / double click / triple click inside the edited text. */
  private pointerSelect(e: PEvent) {
    const tx = this.editing?.text, ta = this.ta;
    if (!tx || !ta) return;
    const lp = toLocalPoint(tx, e.x, e.y);
    const i = hitIndex(tx, lp.x, lp.y);
    const now = performance.now();
    const same = Math.abs(i - this.lastClick.idx) <= 1 && now - this.lastClick.time < 400;
    this.lastClick = { time: now, idx: i, count: same ? this.lastClick.count + 1 : 1 };
    if (this.lastClick.count === 2) {
      // select word
      const s = tx.text;
      let a = i, b = i;
      while (a > 0 && /[\p{L}\p{N}_]/u.test(s[a - 1])) a--;
      while (b < s.length && /[\p{L}\p{N}_]/u.test(s[b])) b++;
      ta.setSelectionRange(a, b);
      this.selecting = null;
    } else if (this.lastClick.count >= 3) {
      // select line (paragraph)
      const s = tx.text;
      const a = s.lastIndexOf('\n', i - 1) + 1, bb = s.indexOf('\n', i);
      ta.setSelectionRange(a, bb < 0 ? s.length : bb);
      this.selecting = null;
    } else if (e.shift) {
      const anchor = ta.selectionDirection === 'backward' ? ta.selectionEnd : ta.selectionStart;
      this.setSel(anchor, i);
      this.selecting = anchor;
    } else {
      ta.setSelectionRange(i, i);
      this.selecting = i;
    }
    this.focusSoon();
    this.restartBlink();
    app.update('overlay', 'options');
  }

  private setSel(anchor: number, focus: number) {
    const ta = this.ta!;
    if (focus >= anchor) ta.setSelectionRange(anchor, focus, 'forward'); else ta.setSelectionRange(focus, anchor, 'backward');
  }

  move(e: PEvent) {
    if (this.selecting !== null && this.editing?.text) {
      const lp = toLocalPoint(this.editing.text, e.x, e.y);
      this.setSel(this.selecting, hitIndex(this.editing.text, lp.x, lp.y));
      this.restartBlink();
      app.update('overlay');
      return;
    }
    if (this.dragStart) { this.dragCur = { x: e.x, y: e.y }; app.update('overlay'); }
  }

  up() {
    if (this.selecting !== null) { this.selecting = null; app.update('options'); return; }
    if (!this.dragStart) return;
    const s = this.dragStart, c = this.dragCur!;
    this.dragStart = null;
    const d = app.doc!;
    const td: TextData = { ...defaultText(), ...this.o, color: { ...app.fg }, text: '' };
    const screenDist = Math.hypot(c.x - s.x, c.y - s.y) * d.zoom;
    if (screenDist > 8) {
      const r = normRect(s.x, s.y, c.x, c.y);
      td.box = { w: Math.max(10, r.w), h: Math.max(td.size * td.leading, r.h) };
      td.ax = r.x; td.ay = r.y; td.align = this.o.align;
    } else {
      td.ax = s.x; td.ay = s.y - baselineOffset(td);
    }
    const l = new Layer('text', `${t('tool.text')} ${textCounter++}`);
    l.text = td;
    renderTextLayer(l);
    d.add(l);
    app.layersPanel.clearMulti();
    this.isNew = true;
    this.startEditor(l);
    app.update('canvas', 'layers', 'overlay');
  }

  /** Start editing an existing text layer. */
  edit(l: Layer) {
    const d = app.doc!;
    d.setActive(l);
    if (l.text) { l.text.psdPixels = false; l.text.mixedStyles = false; }
    this.isNew = false;
    this.startEditor(l);
    if (l.text) renderTextLayer(l);
    app.update('layers', 'options', 'canvas');
  }

  private startEditor(l: Layer) {
    this.editing = l;
    this.before = JSON.stringify(l.text);
    this.lastText = l.text!.text;
    const ta = el('textarea', { class: 'text-input-proxy', spellcheck: false, autocomplete: 'off' }) as HTMLTextAreaElement;
    ta.value = l.text!.text;
    ta.addEventListener('input', () => this.onInput());
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.commit(); return; }
      requestAnimationFrame(() => { this.restartBlink(); app.update('overlay', 'options'); });
    });
    ta.addEventListener('keyup', () => app.update('overlay'));
    ta.addEventListener('paste', e => e.stopPropagation());
    ta.addEventListener('blur', () => app.update('overlay'));
    document.addEventListener('selectionchange', this.onSelChange);
    app.viewport.el.append(ta);
    this.ta = ta;
    ta.setSelectionRange(ta.value.length, ta.value.length);
    this.focusSoon();
    this.restartBlink();
    app.update('options', 'overlay');
  }

  private onSelChange = () => { if (this.ta && document.activeElement === this.ta) { this.restartBlink(); app.update('overlay'); } };

  private focusSoon() { setTimeout(() => this.ta?.focus({ preventScroll: true }), 0); }

  private restartBlink() {
    this.blinkOn = true;
    clearInterval(this.blinkTimer);
    this.blinkTimer = window.setInterval(() => { this.blinkOn = !this.blinkOn; app.update('overlay'); }, 530);
    this.placeProxy();
  }

  /** Keep the hidden textarea at the caret so IME candidate windows appear in the right place. */
  private placeProxy() {
    const tx = this.editing?.text, ta = this.ta;
    if (!tx || !ta) return;
    const c = caretPos(tx, ta.selectionEnd);
    const d = toDocPoint(tx, c.x, c.bottom);
    const p = app.viewport.toScreen(d.x, d.y);
    ta.style.left = p.x + 'px';
    ta.style.top = p.y + 'px';
  }

  private onInput() {
    const l = this.editing, ta = this.ta;
    if (!l?.text || !ta) return;
    l.text.text = ta.value;
    textEdited(l.text, this.lastText);
    this.lastText = ta.value;
    renderTextLayer(l);
    this.restartBlink();
    app.update('canvas', 'overlay');
  }

  viewChanged() { this.placeProxy(); }

  commit() {
    const l = this.editing;
    if (!l) return;
    this.closeEditor();
    const d = app.doc!;
    if (!l.text || !l.text.text.trim()) {
      d.remove(l);
      if (!this.isNew) app.commit('cmd.deleteLayer');
      else app.update('canvas', 'layers');
      return;
    }
    if (this.isNew || JSON.stringify(l.text) !== this.before) {
      // name new layers after their content (like Photoshop)
      if (this.isNew) l.name = l.text.text.split('\n')[0].slice(0, 32) || l.name;
      app.commit('h.text');
    }
  }

  private closeEditor() {
    clearInterval(this.blinkTimer);
    document.removeEventListener('selectionchange', this.onSelChange);
    this.ta?.remove();
    this.ta = null;
    this.editing = null;
    this.selecting = null;
    app.update('options', 'overlay');
  }

  cancel() { if (this.editing) this.commit(); this.dragStart = null; }
  deactivate() { this.cancel(); }
  busy() { return !!this.editing; }

  keydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !this.editing) {
      const l = app.doc?.active;
      if (l?.kind === 'text') { this.edit(l); return true; }
    }
    return false;
  }

  overlay(g: CanvasRenderingContext2D) {
    const v = app.viewport;
    if (this.dragStart && this.dragCur) {
      const a = v.toScreen(this.dragStart.x, this.dragStart.y), b = v.toScreen(this.dragCur.x, this.dragCur.y);
      g.save(); g.setLineDash([4, 3]); g.strokeStyle = '#fff'; g.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y); g.restore();
    }
    const l = this.editing || app.doc?.active;
    if (!(l?.kind === 'text' && l.text)) return;
    const tx = l.text;
    const lay = layoutText(tx);
    const m = textMatrix(tx, lay);
    const scr = (x: number, y: number) => { const d = toDocPoint(tx, x, y, m); return v.toScreen(d.x, d.y); };
    const poly = (pts: { x: number; y: number }[]) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); };
    g.save();
    g.strokeStyle = 'rgba(10,132,255,0.6)'; g.lineWidth = 1;
    poly(textQuad(tx, lay).map(p => v.toScreen(p.x, p.y)));
    g.stroke();
    if (this.editing && this.ta) {
      const s0 = this.ta.selectionStart, s1 = this.ta.selectionEnd;
      if (s1 > s0) {
        g.fillStyle = 'rgba(10,132,255,0.32)';
        for (const r of selectionRects(tx, s0, s1, lay)) {
          poly([scr(r.x, r.y), scr(r.x + r.w, r.y), scr(r.x + r.w, r.y + r.h), scr(r.x, r.y + r.h)]);
          g.fill();
        }
      } else if (this.blinkOn && document.activeElement === this.ta) {
        const c = caretPos(tx, s1, lay);
        const p = scr(c.x, c.top), q = scr(c.x, c.bottom);
        g.strokeStyle = 'rgba(0,0,0,0.65)'; g.lineWidth = 3;
        g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
        g.strokeStyle = '#fff'; g.lineWidth = 1.2; g.stroke();
      }
    }
    g.restore();
    void pointInPoly;
  }

  /* ---------- options ---------- */
  /** The text data the options apply to (editing layer, active text layer) */
  private targetLayer(): Layer | null {
    if (this.editing) return this.editing;
    const l = app.doc?.active;
    return l?.kind === 'text' ? l : null;
  }

  /** Selected character range while editing (null = whole layer). */
  private range(): [number, number] | null {
    if (!this.editing || !this.ta) return null;
    const a = this.ta.selectionStart, b = this.ta.selectionEnd;
    return b > a ? [a, b] : null;
  }

  /** Style shown in the options bar: selection start / caret, or the layer's base style. */
  private shownStyle(): CharStyle | null {
    const l = this.targetLayer();
    if (!l?.text) return null;
    if (this.editing && this.ta) {
      const a = this.ta.selectionStart, b = this.ta.selectionEnd;
      return styleAt(l.text, b > a ? a : Math.max(0, a - 1));
    }
    return baseStyle(l.text);
  }

  private setStyle(patch: Partial<CharStyle>) {
    for (const [k, v] of Object.entries(patch)) if (k in this.o) this.set(k as keyof TextOpts, v as never);
    const l = this.targetLayer();
    if (!l?.text) return;
    const r = this.range();
    if (r) applyStyle(l.text, r[0], r[1], patch);
    else applyStyleAll(l.text, patch);
    renderTextLayer(l);
    if (!this.editing) app.commit('h.text'); else app.update('canvas', 'overlay');
    if (this.ta) { const ta = this.ta; const a = ta.selectionStart, b = ta.selectionEnd; this.focusSoon(); setTimeout(() => ta.setSelectionRange(a, b), 0); }
    app.update('options');
  }

  options() {
    const l = this.targetLayer();
    const st = this.shownStyle();
    const td = st ? { ...st, align: l!.text!.align } : { ...this.o, color: app.fg, vScale: 1 };
    const fontSel = fontPicker(td.font, {
      list: () => [...new Set([...COMMON_FONTS, ...(systemFonts || [])])].sort((a, b) => a.localeCompare(b)),
      canLoadMore: () => !systemFonts && localFontsSupported(),
      loadMore: async () => {
        const list = await loadLocalFontList();
        if (list) { systemFonts = localFamilies(); return true; }
        toast(t('opt.fontsDenied'));
        return false;
      },
      register: async f => { if (systemFonts?.includes(f)) await registerFamily(f); },
    }, f => { clearFontCaches(); this.setStyle({ font: f, psName: undefined }); });
    // style toggles as icons of one size (letters in different faces looked uneven)
    const toggle = (k: 'italic' | 'underline' | 'strike' | 'caps', ico: string) => {
      const on = !!(td as any)[k];
      const b = el('button', { class: 'seg-btn' + (on ? ' on' : ''), title: t('opt.' + k) }, icon(ico, 15));
      b.addEventListener('mousedown', e => e.preventDefault()); // keep text selection
      b.addEventListener('click', () => {
        const patch: Partial<CharStyle> = { [k]: !on };
        if (k === 'italic') Object.assign(patch, { psName: undefined });   // a manual change leaves the exact PSD face
        this.setStyle(patch);
      });
      return b;
    };
    // weight: the whole range instead of a bold on/off button
    const w = fontWeight(td as CharStyle);
    const weights = [100, 200, 300, 400, 500, 600, 700, 800, 900];
    const weightSel = select(weights.map(v => ({ value: String(v), label: t('opt.weight' + v) })), String(weights.includes(w) ? w : Math.round(w / 100) * 100), v => {
      const n = +v;
      this.setStyle({ weight: n, bold: n >= 600, psName: undefined, fauxBold: undefined });
    }, 'weight-select');
    weightSel.title = t('opt.weight');
    weightSel.addEventListener('mousedown', e => e.stopPropagation());
    return [
      fontSel,
      weightSel,
      numberField({ label: t('opt.size'), value: Math.round(td.size * 10) / 10, min: 1, max: 2000, step: 0.5, unit: 'px', onChange: (v, fin) => { if (fin) this.setStyle({ size: v }); } }),
      colorSwatch(td.color as RGB, t('opt.textColor'), c => { if (this.targetLayer()) this.setStyle({ color: c }); else app.setColor('fg', c); }),
      sep(),
      el('div', { class: 'seg' }, toggle('italic', 'italic'), toggle('underline', 'underline'), toggle('strike', 'strike')),
      sep(),
      segmented<'left' | 'center' | 'right'>([
        { value: 'left', icon: 'alignL', title: t('opt.alignLeft') },
        { value: 'center', icon: 'alignC', title: t('opt.alignCenter') },
        { value: 'right', icon: 'alignR', title: t('opt.alignRight') },
      ], td.align, v => this.setAlign(v)),
      numberField({ label: t('opt.leading'), value: Math.round(td.leading * 100), min: 50, max: 2000, unit: '%', presets: [80, 100, 115, 125, 150, 175, 200, 250, 300], onChange: (v, fin) => { if (fin) this.setStyle({ leading: v / 100 }); } }),
      numberField({ label: t('opt.tracking'), title: t('opt.trackingTip'), value: td.tracking, min: -200, max: 1000, presets: [-100, -75, -50, -25, -10, 0, 10, 25, 50, 75, 100, 200], onChange: (v, fin) => { if (fin) this.setStyle({ tracking: v }); } }),
      ...(this.editing ? [spacer(), textButton(t('opt.apply'), () => this.commit(), true)] : []),
    ];
  }

  /** Change alignment (whole layer) keeping point text visually in place. */
  private setAlign(v: 'left' | 'center' | 'right') {
    this.set('align', v);
    const l = this.targetLayer();
    if (!l?.text) return;
    if (!l.text.box) {
      const f = layoutText(l.text).frame;
      l.text.ax = v === 'left' ? f.x : v === 'center' ? f.x + f.w / 2 : f.x + f.w;
    }
    l.text.align = v;
    renderTextLayer(l);
    if (!this.editing) app.commit('h.text'); else { app.update('canvas', 'overlay'); this.focusSoon(); }
  }
}
