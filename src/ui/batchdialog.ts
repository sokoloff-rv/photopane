/** File → Batch processing: pick a folder or files, choose what to do, process them all with progress. */
import { app } from '../app';
import { el } from '../core/util';
import { t } from '../i18n';
import { openDialog, toast } from './dialog';
import { checkbox, select, segmented } from './controls';
import { busy } from './aidialogs';
import { adjustPresets } from '../core/presets';
import { BATCH_DEFAULTS, BatchOps, BatchSource, BatchFormat, pickSource, runBatch } from '../io/batch';

export function batchDialog() {
  const ops: BatchOps = { ...BATCH_DEFAULTS, ...(app.settings.batch || {}) };
  if (ops.adjust && ops.adjust !== '__auto' && !adjustPresets().some(p => p.name === ops.adjust)) ops.adjust = '';
  let src: BatchSource | null = null;
  const processed = t('batch.processed');

  /* ----- source ----- */
  const srcInfo = el('div', { class: 'batch-src-info muted' }, t('batch.noSource'));
  const pick = async (kind: 'folder' | 'files') => {
    try {
      const s = await pickSource(kind, processed);
      if (!s) return;
      if (!s.items.length) { toast(t('batch.noImages'), 'error'); return; }
      src = s;
      srcInfo.classList.remove('muted');
      srcInfo.textContent = kind === 'folder' ? t('batch.folderInfo', s.folder, String(s.items.length)) : t('batch.filesInfo', String(s.items.length));
      updateSave();
    } catch (e: any) { toast(`${t('app.error')}: ${e?.message || e}`, 'error', 5000); }
  };
  const folderBtn = el('button', { class: 'btn sm' }, t('batch.pickFolder'));
  const filesBtn = el('button', { class: 'btn sm' }, t('batch.pickFiles'));
  folderBtn.addEventListener('click', () => pick('folder'));
  filesBtn.addEventListener('click', () => pick('files'));

  /* ----- actions ----- */
  const num = (v: number, on: (n: number) => void) => {
    const i = el('input', { class: 'text-input sm batch-num', type: 'number', min: 16, max: 30000, value: v }) as HTMLInputElement;
    i.addEventListener('change', () => { const n = Math.round(+i.value); if (n >= 16) on(n); else i.value = String(v); });
    return i;
  };
  const resizeRow = el('div', { class: 'batch-row' },
    checkbox(t('batch.resize'), ops.resize, v => { ops.resize = v; }),
    el('div', { class: 'batch-opts' }, el('span', { class: 'muted' }, t('batch.fitInto')), num(ops.maxW, n => { ops.maxW = n; }), el('span', { class: 'muted' }, '×'), num(ops.maxH, n => { ops.maxH = n; }), el('span', { class: 'muted' }, t('batch.px'))));
  const adjOpts = [{ value: '', label: t('batch.noAdjust') }, { value: '__auto', label: t('batch.auto') }, ...adjustPresets().map(p => ({ value: p.name, label: p.name }))];
  const adjustRow = el('div', { class: 'batch-row' },
    el('span', { class: 'batch-label' }, t('batch.adjust')),
    el('div', { class: 'batch-opts' }, select(adjOpts, ops.adjust, v => { ops.adjust = v; })));
  const quality = el('input', { class: 'text-input sm batch-num', type: 'number', min: 10, max: 100, value: ops.quality }) as HTMLInputElement;
  quality.addEventListener('change', () => { ops.quality = Math.max(10, Math.min(100, Math.round(+quality.value) || 90)); quality.value = String(ops.quality); });
  const fmtSel = select<BatchFormat>([
    { value: 'same', label: t('batch.sameFormat') }, { value: 'jpeg', label: 'JPEG' }, { value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP' },
  ], ops.format, v => { ops.format = v; updateFormat(); });
  const qualityBox = el('span', { class: 'batch-quality' }, el('span', { class: 'muted' }, t('batch.quality')), quality, el('span', { class: 'muted' }, '%'));
  const exif = checkbox(t('batch.keepExif'), ops.keepExif, v => { ops.keepExif = v; });
  const formatRow = el('div', { class: 'batch-row' }, el('span', { class: 'batch-label' }, t('batch.format')), el('div', { class: 'batch-opts' }, fmtSel, qualityBox));
  // EXIF is kept in JPEG files only
  const exifRow = el('div', { class: 'batch-row' }, el('span', { class: 'batch-label' }), exif);
  const updateFormat = () => {
    fmtSel.disabled = ops.overwrite;
    if (ops.overwrite) { ops.format = 'same'; fmtSel.value = 'same'; }
    qualityBox.style.visibility = ops.format === 'png' ? 'hidden' : '';
    exifRow.style.display = ops.format === 'same' || ops.format === 'jpeg' ? '' : 'none';
  };

  /* ----- saving ----- */
  const saveNote = el('div', { class: 'batch-note muted' });
  const updateSave = () => {
    saveNote.classList.toggle('warn', ops.overwrite);
    saveNote.textContent = ops.overwrite ? t('batch.overwriteNote')
      : !src ? t('batch.folderNoteNone')
      : src.outLabel ? t('batch.folderNote', src.outLabel) : t('batch.folderNoteAsk');
  };
  const saveSeg = segmented<'folder' | 'over'>([
    { value: 'folder', label: t('batch.toFolder'), title: t('batch.toFolder') }, { value: 'over', label: t('batch.overwrite'), title: t('batch.overwrite') },
  ], ops.overwrite ? 'over' : 'folder', v => { ops.overwrite = v === 'over'; updateFormat(); updateSave(); });
  updateFormat(); updateSave();

  const body = el('div', { class: 'batch' },
    el('div', { class: 'adj-section' }, t('batch.source')),
    el('div', { class: 'batch-row' }, el('div', { class: 'batch-src' }, folderBtn, filesBtn), srcInfo),
    el('div', { class: 'adj-section' }, t('batch.actions')),
    resizeRow, adjustRow, formatRow, exifRow,
    el('div', { class: 'adj-section' }, t('batch.save')),
    el('div', { class: 'batch-row' }, saveSeg), saveNote);

  openDialog({
    // the size fields are one option among several: none of them takes the focus on opening
    title: t('cmd.batch'), body, width: 540, okLabel: t('batch.run'), autoFocus: false,
    onOk: () => {
      if (!src) { toast(t('batch.noSource'), 'error'); return false; }
      if (!ops.resize && !ops.adjust && ops.format === 'same') { toast(t('batch.nothing'), 'error'); return false; }
      app.settings.batch = { ...ops };
      app.saveSettings();
      void run(src, { ...ops });
    },
  });
}

async function run(src: BatchSource, ops: BatchOps) {
  let stop = false;
  const b = busy(t('batch.preparing'), () => { stop = true; });
  try {
    const r = await runBatch(src, ops, (done, total, name) => b.set(name ? t('batch.progress', String(done + 1), String(total), name) : t('batch.finishing'), done / total), () => stop);
    b.close();
    if (r.errors.length) {
      openDialog({
        title: t('cmd.batch'), cancelLabel: null, width: 460,
        body: el('div', {}, el('p', { class: 'dlg-text' }, t('batch.doneErrors', String(r.done), String(r.errors.length))),
          el('div', { class: 'batch-errors mono' }, ...r.errors.slice(0, 20).map(e => el('div', {}, `${e.name}: ${e.message}`)))),
      });
    } else toast(stop ? t('batch.stopped', String(r.done)) : t('batch.done', String(r.done)), 'info', 4000);
  } catch (e: any) {
    b.close();
    if (e?.name !== 'AbortError') toast(`${t('app.error')}: ${e?.message || e}`, 'error', 6000);
  }
}
