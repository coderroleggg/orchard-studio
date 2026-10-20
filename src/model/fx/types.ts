// Effect plugin definitions shared by the engine and the UI: FL's parameter
// list for each plugin (names, parameter indices, control ranges, defaults and
// value texts) plus the plugin's menu name, category and editor size.

/** FL's plugin database categories (Browser > Plugin database > Effects), in FL's order. */
export type FxCategory =
  | 'Controller' | 'Delay reverb' | 'Distortion' | 'Dynamics' | 'Filter'
  | 'Flanger' | 'Gain' | 'Misc' | 'Patcher' | 'Visual';

export const FX_CATEGORIES: FxCategory[] = [
  'Controller', 'Delay reverb', 'Distortion', 'Dynamics', 'Filter', 'Flanger', 'Gain', 'Misc', 'Patcher', 'Visual',
];

/**
 * One automatable plugin parameter. Values are stored in FL's own control
 * units (the range of the control in FL's editor, e.g. 0..2000 for a gain
 * wheel), so ranges, defaults and presets match FL one to one; the plugin's
 * DSP maps them to physical units.
 */
export interface FxParamDef {
  /** Key in the slot's params object. */
  key: string;
  /** FL's parameter name (hints, automation clip names, Browser > Current project). */
  name: string;
  /** FL's parameter index (the control's Tag in FL's editor form). */
  index?: number;
  min: number;
  max: number;
  def: number;
  /** Quantisation in control units (0 = continuous). Default 1 (FL wheels are integer). */
  step?: number;
  /** Discrete choices: options[value - min]. */
  options?: string[];
  /** FL's value text for a control value, e.g. "-0.2 dB", "10 ms". */
  /** FL's value text; `state` is the plugin's whole state when known (texts that follow Tempo sync and the like). */
  format?: (v: number, state?: FxParams) => string;
  /** Typed-in value (display units) -> control value. */
  parse?: (typed: number) => number;
  /** Arc drawn from the middle (bipolar controls). */
  bipolar?: boolean;
  /** Not linkable / automatable. */
  noAuto?: boolean;
}

export interface FxPluginDef {
  /** Stable id stored in projects (FxSlot.plugin). */
  id: string;
  /** Name in menus and the plugin window title. */
  name: string;
  /** Category in the slot menu and the Browser (first = main). */
  category: FxCategory;
  /** Further categories the plugin is also listed in. */
  alsoIn?: FxCategory[];
  /** Editor size at 100% (FL's editor panel). */
  width: number;
  height: number;
  /** Automatable parameters. */
  params: FxParamDef[];
  /** Non-parameter state defaults (A/B spare state, text, file references, envelopes...). */
  state?: () => Record<string, unknown>;
  /** Fill / repair a stored params object (fields missing from older saves). */
  normalize?: (p: Record<string, unknown>) => Record<string, unknown>;
  /** One-line description (Browser hint). */
  description?: string;
  /** Kept loadable but not offered in menus (legacy plugins). */
  hidden?: boolean;
  /**
   * Controller plugins: the names of their internal controller outputs, in
   * output index order (FL's FPN_OutCtrl names: "Peak+LFO", "Peak", "LFO").
   * They are listed in the Remote control settings dialog as
   * "<plugin name> (<mixer track>) - <output>". A function gets the slot state
   * (outputs that depend on it, e.g. Control Surface controls); empty names
   * are unused indices. The DSP reports the values with EffectInstance.controls().
   */
  outputs?: string[] | ((p: Record<string, unknown>) => string[]);
  /**
   * Factory presets (FL's preset names and their parameter values, in control
   * units), offered by the plugin window's preset menu and arrows. Values not
   * listed keep their defaults.
   */
  presets?: FxPreset[];
  /**
   * State keys that are view settings (selected band or page, display speed,
   * IN/OUT view switches): kept when a preset is loaded.
   */
  viewState?: string[];
}

export interface FxPreset {
  name: string;
  params: Record<string, unknown>;
}

/** A plugin's stored state: parameter values by key, plus plugin-specific fields. */
export type FxParams = Record<string, unknown>;
