/** Saved Adjust settings (named presets), kept in the app settings; used by the Adjust window and batch processing. */
import { app } from '../app';
import { ENHANCE_DEFAULTS, EnhanceParams } from './adjust';

export interface AdjustPreset { name: string; p: EnhanceParams }

export function adjustPresets(): AdjustPreset[] {
  const list: AdjustPreset[] = (app.settings.adjustPresets ||= []);
  return list;
}

/** Save under a name (a preset with the same name is replaced). */
export function saveAdjustPreset(name: string, p: EnhanceParams) {
  const list = adjustPresets();
  const item = { name, p: { ...ENHANCE_DEFAULTS, ...p } };
  const i = list.findIndex(x => x.name === name);
  if (i >= 0) list[i] = item; else list.push(item);
  app.saveSettings();
}

export function deleteAdjustPreset(name: string) {
  app.settings.adjustPresets = adjustPresets().filter(x => x.name !== name);
  app.saveSettings();
}

export function findAdjustPreset(name: string): AdjustPreset | undefined {
  return adjustPresets().find(x => x.name === name);
}
