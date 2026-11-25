import { app } from '../app';

export interface PEvent {
  x: number; y: number;      // document coordinates (float)
  sx: number; sy: number;    // viewport coordinates (css px)
  shift: boolean; alt: boolean; ctrl: boolean;
  button: number;
  pressure: number;
  pen: boolean;
}

export abstract class Tool<O extends Record<string, any> = Record<string, any>> {
  abstract readonly id: string;
  abstract readonly iconName: string;
  /** Shortcut key (KeyboardEvent.code letter). Tools with the same key cycle with Shift. */
  readonly key: string = '';
  cursor = 'crosshair';
  /** Not yet implemented — button visible but shows a "coming soon" note. */
  implemented = true;
  o: O;

  constructor(defaults: O) {
    this.o = { ...defaults };
  }

  /** Load persisted options (called by app after construction). */
  loadOptions(saved: any) { if (saved) Object.assign(this.o, saved); }
  set<K extends keyof O>(k: K, v: O[K]) {
    const ic = this.iconName;
    this.o[k] = v; app.saveSettings();
    // a type change (rectangle/ellipse, lasso type) shows on the toolbar at once
    if (this.iconName !== ic) app.toolbar.render();
  }

  get hintKey() { return 'hint.' + this.id; }
  get nameKey() { return 'tool.' + this.id; }

  /** Diameter of brush outline in document px (0 = no outline cursor). */
  brushSize(): number { return 0; }

  down(_e: PEvent) {}
  move(_e: PEvent) {}
  up(_e: PEvent) {}
  hover(_e: PEvent) {}
  dblclick(_e: PEvent) {}
  keydown(_e: KeyboardEvent): boolean { return false; }
  keyup(_e: KeyboardEvent) {}
  /** Draw overlay, `g` is in viewport css-pixel space. */
  overlay(_g: CanvasRenderingContext2D) {}
  options(): (HTMLElement | null)[] { return []; }
  activate() {}
  /** Called after the view was panned/zoomed. */
  viewChanged() {}
  deactivate() { this.cancel(); }
  cancel() {}
  /** Is an operation in progress that blocks switching documents etc. */
  busy() { return false; }
}
