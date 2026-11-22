import { app } from '../app';
import { t } from '../i18n';
import { Tool, PEvent } from './tool';
import { Layer, TextData, defaultText } from '../core/layer';
import { layoutText, renderTextLayer, COMMON_FONTS, fontString } from '../core/text';
import { css, RGB } from '../core/color';
import { el, normRect } from '../core/util';
import { numberField, select, segmented, colorSwatch, sep } from '../ui/controls';
import { spacer, textButton } from './transform';
import { toast } from '../ui/dialog';

interface TextOpts { font: string; size: number; bold: boolean; italic: boolean; underline: boolean; align: 'left' | 'center' | 'right'; leading: number; tracking: number }

let systemFonts: string[] | null = null;
let textCounter = 1;

export class TextTool extends Tool<TextOpts> {
  readonly id = 'text';
  readonly iconName = 'text';
  readonly key = 'T';
  cursor = 'text';
  private editing: Layer | null = null;
  private isNew = false;
  private before = '';
  private ta: HTMLTextAreaElement | null = null;
  private dragStart: { x: number; y: number } | null = null;
  private dragCur: { x: number; y: number } | null = null;

  constructor() { super({ font: 'Arial', size: 48, bold: false, italic: false, underline: false, align: 'left', leading: 1.2, tracking: 0 }); }

  /** Text layer under a document point. */
  private hitText(x: number, y: number): Layer | null {
    const d = app.doc!;
    for (const l of [...d.layers].reverse()) {
      if (l.kind !== 'text' || !l.text || !l.effectiveVisible) continue;
      const f = layoutText(l.text).frame;
      if (x >= f.x - 4 && y >= f.y - 4 && x <= f.x + f.w + 4 && y <= f.y + f.h + 4) return l;
    }
    return null;
  }

  down(e: PEvent) {
    if (this.editing) { this.commit(); return; }
    const hit = this.hitText(e.x, e.y);
    if (hit) { this.edit(hit); return; }
    this.dragStart = { x: e.x, y: e.y };
    this.dragCur = { x: e.x, y: e.y };
  }

  move(e: PEvent) { if (this.dragStart) { this.dragCur = { x: e.x, y: e.y }; app.update('overlay'); } }

  up() {
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
      td.ax = s.x; td.ay = s.y - td.size * td.leading * 0.6;
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
    if (l.text?.psdPixels) { l.text.psdPixels = false; }
    this.isNew = false;
    this.startEditor(l);
    app.update('layers', 'options');
  }

  private startEditor(l: Layer) {
    this.editing = l;
    this.before = JSON.stringify(l.text);
    const ta = el('textarea', { class: 'text-editor', spellcheck: false }) as HTMLTextAreaElement;
    ta.value = l.text!.text;
    ta.addEventListener('input', () => {
      if (!this.editing?.text) return;
      this.editing.text.text = ta.value;
      renderTextLayer(this.editing);
      this.position();
      app.update('canvas');
    });
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.commit(); }
    });
    ta.addEventListener('paste', e => e.stopPropagation());
    app.viewport.el.append(ta);
    this.ta = ta;
    this.position();
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
    app.update('options');
  }

  /** Place the textarea over the text frame. */
  private position() {
    const l = this.editing, ta = this.ta, d = app.doc;
    if (!l?.text || !ta || !d) return;
    const tx = l.text;
    const lay = layoutText(tx);
    const z = d.zoom;
    const v = app.viewport;
    const f = lay.frame;
    const extra = tx.size * z;
    const w = tx.box ? f.w * z : f.w * z + extra;
    let left = v.toScreen(f.x, f.y).x;
    if (!tx.box) left = tx.align === 'left' ? left : tx.align === 'center' ? v.toScreen(tx.ax, 0).x - w / 2 : v.toScreen(tx.ax, 0).x - w;
    const top = v.toScreen(f.x, f.y).y;
    Object.assign(ta.style, {
      left: left + 'px', top: top + 'px', width: Math.max(w, 20) + 'px',
      height: Math.max(lay.lines.length * lay.lineH * z, lay.lineH * z) + (tx.box ? 0 : 2) + 'px',
      font: fontString(tx, z), lineHeight: lay.lineH * z + 'px', letterSpacing: (tx.tracking / 1000) * tx.size * z + 'px',
      textAlign: tx.align, whiteSpace: tx.box ? 'pre-wrap' : 'pre', caretColor: css(tx.color),
      textDecoration: 'none',
    });
    if (tx.box) ta.style.height = f.h * z + 'px';
  }

  viewChanged() { this.position(); }

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
    this.ta?.remove();
    this.ta = null;
    this.editing = null;
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
    // outline of the active text layer when not editing
    const l = app.doc?.active;
    if (!this.editing && l?.kind === 'text' && l.text) {
      const f = layoutText(l.text).frame;
      const a = v.toScreen(f.x, f.y), b = v.toScreen(f.x + f.w, f.y + f.h);
      g.save(); g.strokeStyle = 'rgba(10,132,255,0.6)'; g.strokeRect(a.x - 0.5, a.y - 0.5, b.x - a.x + 1, b.y - a.y + 1); g.restore();
    }
  }

  /* ---------- options ---------- */
  /** The text data the options apply to (editing layer, active text layer) */
  private targetLayer(): Layer | null {
    if (this.editing) return this.editing;
    const l = app.doc?.active;
    return l?.kind === 'text' ? l : null;
  }

  private setProp<K extends keyof TextOpts>(k: K, v: TextOpts[K]) {
    this.set(k, v);
    const l = this.targetLayer();
    if (l?.text) {
      (l.text as any)[k] = v;
      renderTextLayer(l);
      this.position();
      if (!this.editing) app.commit('h.text'); else app.update('canvas');
      this.ta?.focus();
    }
  }

  options() {
    const l = this.targetLayer();
    const td: TextOpts & { color: RGB } = l?.text ? { ...this.o, ...l.text } : { ...this.o, color: app.fg };
    const fonts = [...new Set([td.font, ...COMMON_FONTS, ...(systemFonts || [])])].sort((a, b) => a.localeCompare(b));
    const fontOpts = fonts.map(f => ({ value: f, label: f }));
    fontOpts.push({ value: '__more', label: systemFonts ? '' : t('opt.moreFonts') });
    const fontSel = select(fontOpts.filter(o => o.label), td.font, async v => {
      if (v === '__more') {
        fontSel.value = td.font;
        try {
          const list = await (window as any).queryLocalFonts();
          systemFonts = [...new Set<string>(list.map((f: any) => f.family))];
          app.update('options');
        } catch { toast(t('opt.fontsDenied')); }
        return;
      }
      this.setProp('font', v);
    }, 'font-select');
    const toggle = (k: 'bold' | 'italic' | 'underline', label: string, style: Partial<CSSStyleDeclaration>) => {
      const b = el('button', { class: 'seg-btn' + (td[k] ? ' on' : ''), title: t('opt.' + k) }, el('span', { style }, label));
      b.addEventListener('click', () => { this.setProp(k, !td[k]); app.update('options'); });
      return b;
    };
    return [
      fontSel,
      el('div', { class: 'seg' }, toggle('bold', 'B', { fontWeight: '700' }), toggle('italic', 'I', { fontStyle: 'italic', fontFamily: 'Georgia, serif' }), toggle('underline', 'U', { textDecoration: 'underline' })),
      numberField({ label: t('opt.size'), value: td.size, min: 1, max: 2000, step: 0.5, unit: 'px', onChange: (v, fin) => { if (fin) this.setProp('size', v); } }),
      colorSwatch(td.color, t('opt.textColor'), c => {
        const tl = this.targetLayer();
        if (tl?.text) { tl.text.color = c; renderTextLayer(tl); if (!this.editing) app.commit('h.text'); else app.update('canvas'); this.ta?.focus(); }
        else app.setColor('fg', c);
      }),
      sep(),
      segmented<'left' | 'center' | 'right'>([
        { value: 'left', icon: 'alignL', title: t('opt.alignLeft') },
        { value: 'center', icon: 'alignC', title: t('opt.alignCenter') },
        { value: 'right', icon: 'alignR', title: t('opt.alignRight') },
      ], td.align, v => this.setAlign(v)),
      numberField({ label: t('opt.leading'), value: Math.round(td.leading * 100), min: 50, max: 400, unit: '%', onChange: (v, fin) => { if (fin) this.setProp('leading', v / 100); } }),
      numberField({ label: t('opt.tracking'), value: td.tracking, min: -200, max: 1000, onChange: (v, fin) => { if (fin) this.setProp('tracking', v); } }),
      ...(this.editing ? [spacer(), textButton(t('opt.apply'), () => this.commit(), true)] : []),
    ];
  }

  /** Change alignment keeping point text visually in place. */
  private setAlign(v: 'left' | 'center' | 'right') {
    const l = this.targetLayer();
    if (l?.text && !l.text.box) {
      const f = layoutText(l.text).frame;
      l.text.ax = v === 'left' ? f.x : v === 'center' ? f.x + f.w / 2 : f.x + f.w;
    }
    this.setProp('align', v);
  }
}
