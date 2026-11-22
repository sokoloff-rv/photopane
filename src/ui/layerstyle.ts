import { app } from '../app';
import { el } from '../core/util';
import { t } from '../i18n';
import { Layer, LayerEffects, BLEND_MODES, BlendMode, defaultEffects } from '../core/layer';
import { RGB } from '../core/color';
import { openDialog } from './dialog';
import { select, checkbox, colorSwatch } from './controls';
import { sliderRow } from './adjustdialogs';

type Section = 'blending' | 'bevel' | 'stroke' | 'colorOverlay' | 'gradientOverlay' | 'dropShadow';
const SECTIONS: Section[] = ['blending', 'bevel', 'stroke', 'colorOverlay', 'gradientOverlay', 'dropShadow'];

/** Layer → Layer Style… dialog with live preview. */
export function layerStyleDialog(start: Section = 'blending') {
  const d = app.doc;
  const l = d?.active;
  if (!d || !l) return;
  const before = { fx: JSON.stringify(l.effects), blend: l.blend, opacity: l.opacity };
  const fx: LayerEffects = l.effects;
  let current: Section = start;
  const changed = () => { l.touch(); app.update('canvas'); };

  const list = el('div', { class: 'ls-list' });
  const pane = el('div', { class: 'ls-pane' });

  const renderList = () => {
    list.innerHTML = '';
    for (const s of SECTIONS) {
      const row = el('div', { class: 'ls-item' + (s === current ? ' on' : '') });
      if (s !== 'blending') {
        const box = checkbox('', (fx as any)[s].enabled, v => { (fx as any)[s].enabled = v; changed(); current = s; renderList(); renderPane(); });
        box.addEventListener('click', e => e.stopPropagation());
        row.append(box);
      } else row.append(el('span', { class: 'ls-spacer' }));
      row.append(el('span', {}, t('fx.' + s)));
      row.addEventListener('click', () => {
        current = s;
        if (s !== 'blending' && !(fx as any)[s].enabled) { (fx as any)[s].enabled = true; changed(); }
        renderList(); renderPane();
      });
      list.append(row);
    }
  };

  const slider = (label: string, obj: any, key: string, min: number, max: number, unit = '', scale = 1) =>
    sliderRow({ key, label, min, max, def: Math.round(obj[key] * scale), unit }, Math.round(obj[key] * scale * 10) / 10, v => { obj[key] = v / scale; changed(); });
  const colorRow = (label: string, obj: any, key: string) =>
    el('div', { class: 'form-row' }, el('label', {}, label), colorSwatch(obj[key] as RGB, label, c => { obj[key] = c; changed(); }));
  const blendRow = (obj: any, key: string) =>
    el('div', { class: 'form-row' }, el('label', {}, t('fx.blendMode')),
      select(BLEND_MODES.map(m => ({ value: m as BlendMode, label: m === '-' ? '-' : t('blend.' + m) })), obj[key], v => { obj[key] = v; changed(); }));

  const renderPane = () => {
    pane.innerHTML = '';
    pane.append(el('div', { class: 'adj-section' }, t('fx.' + current)));
    if (current === 'blending') {
      const modes = BLEND_MODES.map(m => ({ value: m as BlendMode, label: m === '-' ? '-' : t('blend.' + m) }));
      if (l.isGroup) modes.unshift({ value: 'pass-through', label: t('blend.pass-through') });
      pane.append(
        el('div', { class: 'form-row' }, el('label', {}, t('fx.blendMode')), select(modes, l.blend, v => { l.blend = v; changed(); })),
        sliderRow({ key: 'op', label: t('opt.opacity'), min: 0, max: 100, def: 100, unit: '%' }, Math.round(l.opacity * 100), v => { l.opacity = v / 100; changed(); }),
      );
    } else if (current === 'dropShadow') {
      const s = fx.dropShadow;
      pane.append(blendRow(s, 'blend'), colorRow(t('dlg.color'), s, 'color'),
        slider(t('opt.opacity'), s, 'opacity', 0, 100, '%', 100), slider(t('opt.angle'), s, 'angle', -180, 180, '°'),
        slider(t('fx.distance'), s, 'distance', 0, 300, ' px'), slider(t('fx.spread'), s, 'spread', 0, 100, '%'), slider(t('opt.size'), s, 'size', 0, 250, ' px'));
    } else if (current === 'stroke') {
      const s = fx.stroke;
      pane.append(slider(t('opt.size'), s, 'size', 1, 250, ' px'),
        el('div', { class: 'form-row' }, el('label', {}, t('dlg.position')),
          select([{ value: 'outside', label: t('dlg.pos.outside') }, { value: 'inside', label: t('dlg.pos.inside') }, { value: 'center', label: t('dlg.pos.center') }], s.position, v => { s.position = v as any; changed(); })),
        colorRow(t('dlg.color'), s, 'color'), slider(t('opt.opacity'), s, 'opacity', 0, 100, '%', 100));
    } else if (current === 'bevel') {
      const s = fx.bevel;
      pane.append(
        el('div', { class: 'form-row' }, el('label', {}, t('opt.style')),
          select([{ value: 'inner', label: t('fx.inner') }, { value: 'outer', label: t('fx.outer') }, { value: 'emboss', label: t('fx.emboss') }, { value: 'pillow', label: t('fx.pillow') }], s.style, v => { s.style = v as any; changed(); })),
        slider(t('fx.depth'), s, 'depth', 1, 1000, '%'),
        el('div', { class: 'form-row' }, el('label', {}, t('fx.direction')),
          select([{ value: 'up', label: t('fx.up') }, { value: 'down', label: t('fx.down') }], s.direction, v => { s.direction = v as any; changed(); })),
        slider(t('opt.size'), s, 'size', 0, 250, ' px'), slider(t('fx.soften'), s, 'soften', 0, 16, ' px'),
        slider(t('opt.angle'), s, 'angle', -180, 180, '°'), slider(t('fx.altitude'), s, 'altitude', 0, 90, '°'),
        colorRow(t('fx.highlight'), s, 'highlightColor'), slider(t('fx.highlightOpacity'), s, 'highlightOpacity', 0, 100, '%', 100),
        colorRow(t('fx.shadow'), s, 'shadowColor'), slider(t('fx.shadowOpacity'), s, 'shadowOpacity', 0, 100, '%', 100));
    } else if (current === 'colorOverlay') {
      const s = fx.colorOverlay;
      pane.append(blendRow(s, 'blend'), colorRow(t('dlg.color'), s, 'color'), slider(t('opt.opacity'), s, 'opacity', 0, 100, '%', 100));
    } else if (current === 'gradientOverlay') {
      const s = fx.gradientOverlay;
      const first = s.stops[0], last = s.stops[s.stops.length - 1];
      pane.append(blendRow(s, 'blend'),
        el('div', { class: 'form-row' }, el('label', {}, t('fx.gradient')),
          colorSwatch(first.color, t('fx.gradient'), c => { first.color = c; changed(); }),
          colorSwatch(last.color, t('fx.gradient'), c => { last.color = c; changed(); }),
          checkbox(t('opt.reverse'), s.reverse, v => { s.reverse = v; changed(); })),
        el('div', { class: 'form-row' }, el('label', {}, t('opt.style')),
          select([{ value: 'linear', label: t('opt.linear') }, { value: 'radial', label: t('opt.radial') }], s.type, v => { s.type = v as any; changed(); })),
        slider(t('opt.opacity'), s, 'opacity', 0, 100, '%', 100), slider(t('opt.angle'), s, 'angle', -180, 180, '°'), slider(t('dlg.scale'), s, 'scale', 10, 150, '%'));
    }
  };

  renderList();
  renderPane();
  const reset = el('button', { class: 'btn sm' }, t('fx.clear'));
  reset.addEventListener('click', () => { Object.assign(fx, defaultEffects()); changed(); renderList(); renderPane(); });
  openDialog({
    title: t('cmd.layerStyle') + ' — ' + l.name, body: el('div', { class: 'ls' }, list, pane), width: 600, side: true,
    extraButtons: [reset],
    onOk: () => {
      if (JSON.stringify(l.effects) !== before.fx || l.blend !== before.blend || l.opacity !== before.opacity) app.commit('cmd.layerStyle');
      app.update('layers');
    },
    onCancel: () => { l.effects = JSON.parse(before.fx); l.blend = before.blend; l.opacity = before.opacity; changed(); app.update('layers'); },
  });
}

export function clearLayerStyle(l: Layer) { l.effects = defaultEffects(); l.touch(); }
