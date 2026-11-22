import { app } from '../../app';
import { el } from '../../core/util';
import { t } from '../../i18n';
import { Layer, BLEND_MODES, BlendMode, listedEffects } from '../../core/layer';
import { Doc } from '../../core/document';
import { Panel } from './panel';
import { icon } from '../icons';
import { numberField, select, iconButton } from '../controls';
import { toast } from '../dialog';
import { layerStyleDialog } from '../layerstyle';
import { showContextMenu, CtxItem } from '../contextmenu';

const FX_KEYS = ['bevel', 'stroke', 'colorOverlay', 'gradientOverlay', 'dropShadow'] as const;

const TW = 40, TH = 30;

export class LayersPanel extends Panel {
  private list: HTMLElement;
  private top: HTMLElement;
  private bottom: HTMLElement;
  private multi = new WeakMap<Doc, Set<number>>();
  private thumbTimer = 0;
  /** Layers whose effects list is expanded (Photoshop shows it under the layer). */
  private fxOpen = new Set<number>();
  private fxSeen = new Set<number>();
  private dragId = -1;

  constructor() {
    super('panel.layers', 'layers');
    this.top = el('div', { class: 'layers-top' });
    this.list = el('div', { class: 'layers-list' });
    this.bottom = el('div', { class: 'layers-bottom' });
    this.body.append(this.top, this.list, this.bottom);
    this.list.addEventListener('dragover', e => this.onDragOver(e));
    this.list.addEventListener('drop', e => this.onDrop(e));
    this.list.addEventListener('dragleave', () => this.clearDrop());
  }

  /** Layers selected in the panel (always includes the active one), in stack order. */
  selected(): Layer[] {
    const d = app.doc;
    if (!d) return [];
    const ids = this.multi.get(d) || new Set<number>();
    const all = d.layers;
    const res = all.filter(l => ids.has(l.id) || l.id === d.activeId);
    // drop layers whose ancestor is selected as well
    return res.filter(l => { for (let p = l.parent; p; p = p.parent) if (res.includes(p)) return false; return true; });
  }

  clearMulti() { const d = app.doc; if (d) this.multi.set(d, new Set()); }

  render() {
    this.renderTitle();
    this.renderTop();
    this.renderBottom();
    this.list.innerHTML = '';
    const d = app.doc;
    if (!d) return;
    const ids = this.multi.get(d) || new Set<number>();
    const addRows = (children: Layer[], depth: number) => {
      for (let i = children.length - 1; i >= 0; i--) {
        const l = children[i];
        this.list.append(this.row(d, l, depth, ids));
        if (listedEffects(l.effects) && this.fxOpen.has(l.id)) this.fxRows(d, l, depth);
        if (l.isGroup && l.expanded) addRows(l.children, depth + 1);
      }
    };
    addRows(d.root.children, 0);
    this.drawThumbs();
  }

  private renderTop() {
    this.top.innerHTML = '';
    const d = app.doc, l = d?.active;
    const modes = BLEND_MODES.filter(m => m !== '-' || true).map(m => ({ value: m as BlendMode, label: m === '-' ? '-' : t('blend.' + m) }));
    if (l?.isGroup) modes.unshift({ value: 'pass-through', label: t('blend.pass-through') });
    const blend = select(modes, (l?.blend || 'normal') as BlendMode, v => {
      if (!l) return; l.blend = v; l.touch(); app.commit('h.layerProps');
    }, 'blend-select');
    blend.disabled = !l;
    const opacity = numberField({
      label: t('layers.opacity'), value: Math.round((l?.opacity ?? 1) * 100), min: 0, max: 100, unit: '%', width: 34,
      onChange: (v, final) => { if (!l) return; l.opacity = v / 100; l.touch(); app.update('canvas'); if (final) app.commit('h.layerProps'); },
    });
    const lock = el('button', { class: 'icon-btn toggle' + (l?.lockAlpha ? ' on' : ''), title: t('layers.lockAlpha') }, icon('lock', 15));
    lock.addEventListener('click', () => app.run('lockAlpha'));
    this.top.append(el('div', { class: 'layers-top-row' }, blend, opacity), el('div', { class: 'layers-top-row' }, el('span', { class: 'muted sm' }, t('layers.lock') + ':'), lock));
  }

  private renderBottom() {
    this.bottom.innerHTML = '';
    this.bottom.append(
      iconButton('fx', t('layers.fx'), () => app.run('layerStyle')),
      iconButton('mask', t('layers.mask'), () => app.run(app.doc?.active?.mask ? 'maskDelete' : 'maskReveal')),
      iconButton('folderPlus', t('layers.group'), () => app.run('newGroup')),
      iconButton('newLayer', t('layers.new'), () => app.run('newLayer')),
      iconButton('copy', t('layers.duplicate'), () => app.run('duplicate')),
      iconButton('trash', t('layers.delete'), () => app.run('deleteLayer')),
    );
  }

  private row(d: Doc, l: Layer, depth: number, ids: Set<number>): HTMLElement {
    const active = l.id === d.activeId;
    const r = el('div', {
      class: 'lrow' + (active ? ' on' : '') + (ids.has(l.id) ? ' sel' : '') + (l.clipped ? ' clipped' : '') + (l.isGroup ? ' group' : '') + (!l.effectiveVisible ? ' hidden' : ''),
      draggable: true,
    });
    r.dataset.id = String(l.id);
    const eye = el('button', { class: 'lrow-eye', title: t('layers.visibility') }, icon(l.visible ? 'eye' : 'eyeOff', 15));
    eye.addEventListener('click', e => {
      e.stopPropagation();
      l.visible = !l.visible; l.touch();
      app.commit('h.visibility');
    });
    r.append(eye, el('span', { class: 'lrow-indent', style: { width: depth * 14 + 'px' } }));
    if (l.isGroup) {
      const chev = el('button', { class: 'lrow-chev' }, icon(l.expanded ? 'chevronDown' : 'chevronRight', 14));
      chev.addEventListener('click', e => { e.stopPropagation(); l.expanded = !l.expanded; app.update('layers'); });
      r.append(chev, el('span', { class: 'lrow-folder' }, icon(l.expanded ? 'folderOpen' : 'folder', 18)));
    } else {
      if (l.clipped) r.append(el('span', { class: 'lrow-clip', title: t('layers.clipped') }, icon('clip', 13)));
      const th = el('canvas', { class: 'lthumb' + (active && !d.editMask ? ' target' : ''), width: TW * 2, height: TH * 2, title: t('layers.thumb') }) as HTMLCanvasElement;
      (th as any)._layer = l;
      th.addEventListener('click', e => {
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) { d.setActive(l); app.run('selectLayerPixels'); return; }
        this.activate(d, l, e, false);
      });
      r.append(th);
      if (l.kind === 'text') th.classList.add('text');
    }
    if (l.mask) {
      const mt = el('canvas', { class: 'lthumb mask' + (active && d.editMask ? ' target' : '') + (l.mask.enabled ? '' : ' off'), width: TW * 2, height: TH * 2, title: t('layers.maskThumb') }) as HTMLCanvasElement;
      (mt as any)._mask = l;
      mt.addEventListener('click', e => {
        e.stopPropagation();
        if (e.shiftKey) { l.mask!.enabled = !l.mask!.enabled; l.touch(); app.commit('h.layerProps'); return; }
        this.activate(d, l, e, true);
      });
      r.append(mt);
    }
    const name = el('span', { class: 'lrow-name' }, l.kind === 'text' ? icon('text', 12) : null, el('span', {}, l.name));
    name.addEventListener('dblclick', e => { e.stopPropagation(); this.rename(l, name); });
    r.append(name);
    if (listedEffects(l.effects)) {
      // expanded by default the first time a layer with effects is shown
      if (!this.fxSeen.has(l.id)) { this.fxSeen.add(l.id); this.fxOpen.add(l.id); }
      const open = this.fxOpen.has(l.id);
      const fx = el('button', { class: 'lrow-fx', title: t('layers.fxHint') }, el('span', {}, 'fx'), icon(open ? 'chevronDown' : 'chevronRight', 11));
      fx.addEventListener('click', e => {
        e.stopPropagation();
        if (open) this.fxOpen.delete(l.id); else this.fxOpen.add(l.id);
        app.update('layers');
      });
      fx.addEventListener('dblclick', e => { e.stopPropagation(); d.setActive(l); layerStyleDialog(); });
      r.append(fx);
    }
    r.addEventListener('contextmenu', e => { e.preventDefault(); this.layerMenu(d, l, e); });
    if (l.lockAlpha) r.append(el('span', { class: 'lrow-lock' }, icon('lock', 12)));
    r.addEventListener('click', e => {
      if (e.altKey) {
        // toggle clipping mask
        const p = l.parent!;
        if (p.children.indexOf(l) === 0) return;
        l.clipped = !l.clipped; l.touch();
        app.commit('h.layerProps');
        return;
      }
      this.activate(d, l, e, d.editMask && l.id === d.activeId);
    });
    r.addEventListener('dblclick', e => {
      if (l.kind === 'text' && (e.target as HTMLElement).closest('.lthumb')) {
        app.setTool('text');
        (app.tool as any).edit?.(l);
        return;
      }
      if (!l.isGroup) app.run('layerStyle');
    });
    r.addEventListener('dragstart', e => { this.dragId = l.id; e.dataTransfer!.effectAllowed = 'move'; e.dataTransfer!.setData('text/x-layer', String(l.id)); });
    r.addEventListener('dragend', () => { this.dragId = -1; this.clearDrop(); });
    return r;
  }

  /** Effects listed under a layer: eye toggles an effect, double click opens Layer Style on it. */
  private fxRows(d: Doc, l: Layer, depth: number) {
    const indent = depth * 14 + 34;
    const head = el('div', { class: 'lfx-row head' }, el('span', { style: { width: indent + 'px' } }), el('span', { class: 'lfx-label' }, t('layers.effects')));
    head.addEventListener('dblclick', () => { d.setActive(l); layerStyleDialog(); });
    this.list.append(head);
    for (const k of FX_KEYS) {
      const fxo = l.effects[k] as { enabled: boolean };
      if (!fxo.enabled && !(fxo as any)._hidden) continue;
      const hidden = !fxo.enabled;
      const eye = el('button', { class: 'lrow-eye sm' }, icon(hidden ? 'eyeOff' : 'eye', 13));
      eye.addEventListener('click', e => {
        e.stopPropagation();
        // hidden effects keep their settings (like Photoshop's per-effect eye)
        if (hidden) { fxo.enabled = true; delete (fxo as any)._hidden; } else { fxo.enabled = false; (fxo as any)._hidden = true; }
        l.touch();
        app.commit('h.layerProps');
      });
      const row = el('div', { class: 'lfx-row' + (hidden ? ' off' : '') }, el('span', { style: { width: indent - 26 + 'px' } }), eye, el('span', { class: 'lfx-label' }, t('fx.' + k)));
      row.addEventListener('dblclick', () => { d.setActive(l); layerStyleDialog(k); });
      this.list.append(row);
    }
  }

  /** Right-click menu on a layer row. */
  private layerMenu(d: Doc, l: Layer, e: MouseEvent) {
    if (d.activeId !== l.id) { d.setActive(l); this.clearMulti(); app.update('layers', 'options'); }
    // everything the old Layer menu had, in one place
    const mask: CtxItem[] = l.mask
      ? [{ cmd: 'maskToggle' }, { cmd: 'maskApply' }, { cmd: 'maskDelete' }]
      : [{ cmd: 'maskReveal', label: 'layers.mask' }, ...(d.selection ? [{ cmd: 'maskFromSel', label: 'ctx.maskFromSel' } as CtxItem] : [])];
    const items: CtxItem[] = [
      { label: t('ctx.blending'), run: () => layerStyleDialog('blending') },
      { cmd: 'layerStyle' },
      { cmd: 'clearStyle' },
      '-',
      { cmd: 'duplicate' }, { cmd: 'deleteLayer' },
      l.isGroup ? { cmd: 'ungroup' } : { cmd: 'groupLayers' },
      '-',
      { cmd: 'selectLayerPixels', label: 'ctx.selectPixels' },
      { cmd: 'rasterize' },
      '-',
      ...mask,
      { cmd: 'clipMask' },
      '-',
      { cmd: 'mergeDown' }, { cmd: 'mergeVisible' }, { cmd: 'stampVisible' }, { cmd: 'flatten' },
    ];
    showContextMenu(e.clientX, e.clientY, items);
  }

  private activate(d: Doc, l: Layer, e: MouseEvent, mask: boolean) {
    let ids = this.multi.get(d) || new Set<number>();
    if (e.ctrlKey || e.metaKey) {
      if (d.activeId !== l.id) ids.add(d.activeId);
      if (ids.has(l.id) && l.id !== d.activeId) ids.delete(l.id); else ids.add(l.id);
    } else if (e.shiftKey) {
      const order = [...this.list.querySelectorAll('.lrow')].map(n => +(n as HTMLElement).dataset.id!);
      const a = order.indexOf(d.activeId), b = order.indexOf(l.id);
      ids = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else ids = new Set();
    this.multi.set(d, ids);
    d.setActive(l);
    d.editMask = mask && !!l.mask;
    app.update('layers', 'options');
  }

  private rename(l: Layer, nameEl: HTMLElement) {
    const input = el('input', { class: 'text-input sm', value: l.name }) as HTMLInputElement;
    nameEl.replaceWith(input);
    input.focus(); input.select();
    const done = (ok: boolean) => {
      if (ok && input.value.trim() && input.value !== l.name) { l.name = input.value.trim(); app.commit('h.rename'); }
      else app.update('layers');
    };
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = l.name; input.blur(); } });
    input.addEventListener('blur', () => done(true));
  }

  /* ---------- drag & drop reordering ---------- */
  private dropInfo: { target: Layer; where: 'above' | 'below' | 'into' } | null = null;

  private clearDrop() {
    this.list.querySelectorAll('.drop-above,.drop-below,.drop-into').forEach(n => n.classList.remove('drop-above', 'drop-below', 'drop-into'));
    this.dropInfo = null;
  }

  private onDragOver(e: DragEvent) {
    const d = app.doc;
    if (!d || this.dragId < 0) return;
    e.preventDefault();
    const rowEl = (e.target as HTMLElement).closest('.lrow') as HTMLElement | null;
    this.clearDrop();
    if (!rowEl) return;
    const target = d.find(+rowEl.dataset.id!);
    if (!target || target.id === this.dragId) return;
    const rc = rowEl.getBoundingClientRect();
    const f = (e.clientY - rc.top) / rc.height;
    const where = target.isGroup && f > 0.3 && f < 0.7 ? 'into' : f < 0.5 ? 'above' : 'below';
    rowEl.classList.add('drop-' + where);
    this.dropInfo = { target, where };
  }

  private onDrop(e: DragEvent) {
    e.preventDefault();
    const d = app.doc;
    const info = this.dropInfo;
    this.clearDrop();
    if (!d || !info) return;
    const layer = d.find(this.dragId);
    if (!layer) return;
    const { target, where } = info;
    if (where === 'into') d.move(layer, target, target.children.length);
    else {
      const p = target.parent!;
      const idx = p.children.indexOf(target);
      d.move(layer, p, where === 'above' ? idx + 1 : idx);
    }
    if (layer.parent && layer.parent.children[0] === layer) layer.clipped = false;
    app.commit('h.reorder');
  }

  /* ---------- thumbnails ---------- */
  refreshThumbs() {
    if (this.thumbTimer) return;
    this.thumbTimer = window.setTimeout(() => { this.thumbTimer = 0; this.drawThumbs(); }, 200);
  }

  private drawThumbs() {
    const d = app.doc;
    if (!d) return;
    const scale = Math.min((TW * 2) / d.width, (TH * 2) / d.height);
    const w = d.width * scale, h = d.height * scale;
    const ox = (TW * 2 - w) / 2, oy = (TH * 2 - h) / 2;
    this.list.querySelectorAll('canvas.lthumb').forEach(node => {
      const c = node as HTMLCanvasElement;
      const g = c.getContext('2d')!;
      g.clearRect(0, 0, c.width, c.height);
      const l: Layer | undefined = (c as any)._layer;
      const ml: Layer | undefined = (c as any)._mask;
      g.save();
      g.beginPath(); g.rect(ox, oy, w, h); g.clip();
      if (l) {
        drawChecker(g, ox, oy, w, h);
        g.imageSmoothingQuality = 'high';
        g.drawImage(l.canvas, ox + l.x * scale, oy + l.y * scale, l.canvas.width * scale, l.canvas.height * scale);
      } else if (ml?.mask) {
        const m = ml.mask;
        g.fillStyle = m.fill === 255 ? '#fff' : '#000'; g.fillRect(ox, oy, w, h);
        g.fillStyle = '#000';
        // mask stores coverage in alpha: draw black background then white mask
        g.fillRect(ox, oy, w, h);
        g.drawImage(m.canvas, ox + m.x * scale, oy + m.y * scale, m.canvas.width * scale, m.canvas.height * scale);
      }
      g.restore();
    });
  }
}

function drawChecker(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  g.fillStyle = '#fff'; g.fillRect(x, y, w, h);
  g.fillStyle = '#e3e3e3';
  const s = 6;
  for (let j = 0; j * s < h; j++) for (let i = 0; i * s < w; i++) if ((i + j) % 2) g.fillRect(x + i * s, y + j * s, s, s);
}

export function noLayerToast() { toast(t('app.layerLocked')); }
