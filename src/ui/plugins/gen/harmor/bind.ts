// Harmor editor bindings: FL's control Tags to plugin parameter keys, the
// non-parameter settings the Tag -1 / negative controls edit, the editor
// target (ArtSelect) and articulator part (EnvSelect) lists, and combo item
// handling. FL's TQuickCombo.Value is the index among the SELECTABLE items:
// "-" separators and "-Header" items are skipped (F1TypeSelectChange 0xb9fe0
// stores Value, Value + 100, Value + 200; the factory presets confirm it).

import { ART_ENV_TARGETS, ART_FIELDS, ART_TARGETS, GLOBAL_PARAMS, PART_MAIN, type PartId } from '../../../../model/gen/plugins/harmor/params';
import type { HEnv, HGlobal, HPart, HView } from '../../../../model/gen/plugins/harmor/types';
import { FORM, type FCtl } from './form';

/** First global parameter index (772) - the Tag 10000 block; the Tag 20000 block starts at 789. */
const G2 = 789 - 772;

/** Parameter key of an FL Tag for part `p` (null: not a parameter). */
export function tagKey(tag: number | undefined, p: PartId): string | null {
  if (tag === undefined || tag < 0) return null;
  if (tag >= 20000) return GLOBAL_PARAMS[G2 + tag - 20000]?.[0] ?? null;
  if (tag >= 10000) return GLOBAL_PARAMS[tag - 10000]?.[0] ?? null;
  const row = PART_MAIN[tag];
  return row ? `${p}_${row[0]}` : null;
}

/** Key of articulator field `field` (ART_FIELDS key or 'smooth') of target t. */
export function artFieldKey(p: PartId, t: number, field: string): string {
  return `${p}_art${t}_${field}`;
}

/** The envelope / LFO wheels of FL's envelope editor frame use Tags 0..7 = ART_FIELDS. */
export function envWheelKey(p: PartId, t: number, tag: number): string | null {
  if (t < 0 || t >= ART_ENV_TARGETS) return null;
  const f = ART_FIELDS[tag];
  return f ? artFieldKey(p, t, f[0]) : null;
}

export const partId = (part: number): PartId => (part === 1 ? 'b' : 'a');

// ------------------------------------------------------------------ combos

/** An item of an FL item list: '-' = separator, '-Text' = header, else selectable. */
export function isSeparator(s: string): boolean {
  return s.startsWith('-');
}

/** Selectable items of an FL item list (FL's combo Value indexes these). */
export function selectable(items: readonly string[]): string[] {
  return items.filter((s) => !isSeparator(s));
}

/** Text of combo Value v. */
export function itemText(items: readonly string[], v: number): string {
  return selectable(items)[Math.round(v)] ?? '';
}

// ------------------------------------------------------------- settings

/** HPart number fields edited by the part page and ADV controls. */
export type PartField = {
  [K in keyof HPart]: HPart[K] extends number ? K : never;
}[keyof HPart];

/** HGlobal number fields. */
export type GlobalField = {
  [K in keyof HGlobal]: HGlobal[K] extends number ? K : never;
}[keyof HGlobal];

/**
 * Non-parameter controls: FL component -> setting, value mapping and range.
 * `scale` maps the control value to the stored value (eqMix = wheel / 1000).
 */
export interface SettingBind {
  scope: 'part' | 'global';
  field: string;
  min: number;
  max: number;
  def: number;
  scale?: number;
  /** FL stores the combo Value plus this offset (resonance types + 100, phaser + 200 in FL's file; the model keeps Value). */
  label: string;
}

export const SETTINGS: Record<string, SettingBind> = {
  HarmBlendSelect: { scope: 'part', field: 'blend', min: 0, max: 5, def: 0, label: 'Timbre blending mode' },
  F1TypeSelect: { scope: 'part', field: 'f1Type', min: 0, max: 18, def: 0, label: 'Filter 1 shape' },
  F2TypeSelect: { scope: 'part', field: 'f2Type', min: 0, max: 18, def: 0, label: 'Filter 2 shape' },
  PhaserTypeSelect: { scope: 'part', field: 'phType', min: 0, max: 10, def: 0, label: 'Phaser type' },
  GlobalEQMixWheel: { scope: 'part', field: 'eqMix', min: 0, max: 1000, def: 1000, scale: 0.001, label: 'Global EQ mix' },
  HarmClipModeSelect: { scope: 'part', field: 'clipMode', min: 0, max: 4, def: 0, label: 'Clipping mode' },
  SubVolModeSelect: { scope: 'part', field: 'subMode', min: 0, max: 1, def: 0, label: 'Sub-harmonic configuration' },
  GrittyModeBox: { scope: 'part', field: 'prismMode', min: 0, max: 1, def: 0, label: 'Prism add / multiply mode' },
  GrittyFromVolSelect: { scope: 'part', field: 'prismVol', min: 0, max: 2, def: 0, label: 'Harmonic level to prism amount' },
  PluckToBlurBox: { scope: 'part', field: 'pluckBlur', min: 0, max: 1, def: 0, label: 'Pluck replaces blur decay' },
  HarmPitchModeSelect: { scope: 'part', field: 'pitchMode', min: 0, max: 1, def: 1, label: 'Partial pitch distribution' },
  DeclickWheel: { scope: 'part', field: 'declick', min: 0, max: 1000, def: 0, label: 'Transient declicking time' },
  RampWheel: { scope: 'part', field: 'ramp', min: -2000, max: 2000, def: 1000, label: 'Ramping time' },
  AutoGainModeSelect: { scope: 'part', field: 'agMode', min: 0, max: 1, def: 0, label: 'Auto-gain mode' },
  BMPResynthModeSelect: { scope: 'part', field: 'resynth', min: 0, max: 1, def: 0, label: 'Resynthesis method' },
  BMPDenoiseWheel: { scope: 'part', field: 'denoise', min: 0, max: 1000, def: 250, label: 'Denoising / thinning after resynthesis / waveform import' },
  MidSideBtn: { scope: 'part', field: 'side', min: 0, max: 1, def: 0, label: 'Side processing / invert right channel' },
  BMPViewScaleSelect: { scope: 'part', field: 'view', min: 0, max: 1, def: 1, label: 'Display scale' },
  DistModeSelect: { scope: 'global', field: 'distMode', min: 0, max: 11, def: 0, label: 'Distortion type' },
  CompTypeSelect: { scope: 'global', field: 'compType', min: 0, max: 4, def: 0, label: 'Compression type' },
  MonoSelect: { scope: 'global', field: 'mono', min: 0, max: 3, def: 0, label: 'Monophonic' },
  VoiceRandSelect: { scope: 'global', field: 'voiceRand', min: 0, max: 3, def: 1, label: 'Voice randomness' },
  VoiceSameMapRandBox: { scope: 'global', field: 'sameRand', min: 0, max: 1, def: 0, label: 'Same random input for all mappings' },
  ModSmoothBox: { scope: 'global', field: 'modSmooth', min: 0, max: 1, def: 1, label: 'Smooth up XYZ modulation & filter frequency' },
  QThreadedBox: { scope: 'global', field: 'threaded', min: 0, max: 1, def: 1, label: 'Threaded' },
  QHQRenderBox: { scope: 'global', field: 'hq', min: 0, max: 1, def: 1, label: 'Highest possible quality for offline rendering' },
  QLocalMaxNumTonesWheel: { scope: 'global', field: 'maxTones', min: 3600, max: 10800, def: 10800, label: 'Highest partial count' },
  QSafetyWheel: { scope: 'global', field: 'safety', min: 0, max: 2400, def: 75, label: 'Partials safety ceiling' },
  QGrainWheel: { scope: 'global', field: 'grain', min: 50, max: 300, def: 200, label: 'Envelope granularity' },
  QPrecisionSelect: { scope: 'global', field: 'precision', min: 0, max: 2, def: 0, label: 'Computation precision' },
  LinkPartsBox: { scope: 'global', field: 'linkParts', min: 0, max: 1, def: 0, label: 'GUI-link parts' },
};

/** Resonance type combos: FL stores Value + 100 (r1Type / r2Type keep FL's raw value). */
export const RES_TYPE: Record<string, 'r1Type' | 'r2Type'> = { F1ResTypeSelect: 'r1Type', F2ResTypeSelect: 'r2Type' };

/** Every FL component whose Tag is a parameter (for tests and the renderer). */
export function paramControls(): FCtl[] {
  return Object.values(FORM).filter((c) => c.tag !== undefined && c.tag >= 0
    && (c.k === 'wheel' || c.k === 'slider' || c.k === 'check' || c.k === 'combo' || c.k === 'switch'
      || c.k === 'digi' || c.k === 'multidigi' || c.k === 'button' || c.k === 'cells')
    && !(c.page === 'env' && (c.n.startsWith('Env') || c.n.startsWith('LFO')))
    && c.n !== 'EnvVisual' && c.n !== 'EditVolSel' && c.n !== 'FXUnitOrderSelect'
    && !(c.page === 'env' && c.k === 'button'));
}

// ----------------------------------------------------------- targets

/** FL's ArtSelect list (93 items: headers / separators included). */
export const ART_SELECT_ITEMS: readonly string[] = FORM.ArtSelect.items ?? [];

/** Selectable editor targets (FL's ArtSelect.Value 0..69). */
export const TARGETS = selectable(ART_SELECT_ITEMS);
export const T_MAPS = 43;
export const T_IMAGE_COLUMN = 69;

export type TargetKind = 'art' | 'mapart' | 'map' | 'image';

/** Kind of editor target t: 0..30 articulation, 31..42 mapping-only, 43..68 shaping maps, 69 image column. */
export function targetKind(t: number): TargetKind {
  if (t < ART_ENV_TARGETS) return 'art';
  if (t < T_MAPS) return 'mapart';
  if (t < T_IMAGE_COLUMN) return 'map';
  return 'image';
}

/** The 9 articulator mappings (FL's EnvSelect items after Envelope / LFO, 0xefd10). */
export const MAPPING_NAMES = [
  'Keyboard mapping', 'Velocity mapping', 'Modulation X mapping', 'Modulation Y mapping',
  'Modulation Z mapping', 'Random mapping', 'Unison index mapping', 'Held index mapping', 'Mod X speed mapping',
] as const;

/** FL's EnvSelect items for target t (separators included; artPart 0 env, 1 LFO, 2..10 mappings). */
export function envSelectItems(t: number): string[] {
  const k = targetKind(t);
  if (k === 'art') return ['Envelope', 'LFO', '-', ...MAPPING_NAMES];
  if (k === 'mapart') return [...MAPPING_NAMES];
  return ['Mapping'];
}

/** Articulator part (0 env, 1 LFO, 2..10 mapping) to EnvSelect Value for target t, and back. */
export function artPartToValue(t: number, artPart: number): number {
  const k = targetKind(t);
  if (k === 'art') return Math.max(0, Math.min(10, artPart));
  if (k === 'mapart') return Math.max(0, Math.min(8, artPart - 2));
  return 0;
}

export function valueToArtPart(t: number, v: number): number {
  const k = targetKind(t);
  if (k === 'art') return Math.max(0, Math.min(10, v));
  if (k === 'mapart') return Math.max(2, Math.min(10, v + 2));
  return 0;
}

/** Valid articulator part for target t (mapping-only targets have no envelope / LFO). */
export function clampArtPart(t: number, artPart: number): number {
  return valueToArtPart(t, artPartToValue(t, artPart));
}

/** Name of target t (ArtSelect item text). */
export function targetName(t: number): string {
  return TARGETS[t] ?? '';
}

/** Name of the articulation / mapping target t in the model's list (params.ts ART_TARGETS). */
export function artTargetName(t: number): string {
  return ART_TARGETS[t] ?? '';
}

/** Path of the curve shown for (target, artPart) inside a part: ['arts', t, 'e' | 'l' | 'k', j] or ['maps', i]. */
export type CurvePath = ['arts', number, 'e'] | ['arts', number, 'l'] | ['arts', number, 'k', number] | ['maps', number];

export function curvePath(t: number, artPart: number): CurvePath | null {
  const k = targetKind(t);
  if (k === 'map') return ['maps', t - T_MAPS];
  if (k === 'image') return null;
  const ap = clampArtPart(t, artPart);
  if (ap === 0) return ['arts', t, 'e'];
  if (ap === 1) return ['arts', t, 'l'];
  return ['arts', t, 'k', ap - 2];
}

/** The curve at a path of a part (undefined when missing). */
export function curveAt(part: HPart | undefined, path: CurvePath | null): HEnv | undefined {
  if (!part || !path) return undefined;
  if (path[0] === 'maps') return part.maps[path[1]];
  const art = part.arts[path[1]];
  if (!art) return undefined;
  if (path[2] === 'e') return art.e;
  if (path[2] === 'l') return art.l;
  return art.k[path[3]];
}

/** Key of the curve in HPart.missing ('m<i>', 'a<t>e', 'a<t>l', 'a<t>k<j>'). */
export function missingKey(path: CurvePath): string {
  if (path[0] === 'maps') return `m${path[1]}`;
  if (path[2] === 'e') return `a${path[1]}e`;
  if (path[2] === 'l') return `a${path[1]}l`;
  return `a${path[1]}k${path[3]}`;
}

// ----------------------------------------------------------- view state

export const VIEW_DEFAULT: HView = { part: 0, page: 0, target: 1, artPart: 0, kb: 1, vis: 0 };

export function viewOf(params: Record<string, unknown>): HView {
  const v = (params.hView ?? {}) as Partial<HView>;
  const n = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  return {
    part: n(v.part, 0) === 1 ? 1 : 0,
    page: Math.max(0, Math.min(3, Math.round(n(v.page, 0)))),
    target: Math.max(0, Math.min(T_IMAGE_COLUMN, Math.round(n(v.target, 1)))),
    artPart: Math.max(0, Math.min(10, Math.round(n(v.artPart, 0)))),
    kb: n(v.kb, 1) ? 1 : 0,
    vis: n(v.vis, 0) ? 1 : 0,
  };
}

/** Editor panel size: FL's 1024 x 680 with the keyboard, 612 without (the keyboard strip starts at y 612). */
export const PANEL_W = 1024;
export const PANEL_H = 680;
export const PANEL_H_NOKB = 612;
/** Width added by the visual feedback panel (FBVisual at x 1027, 110 wide, plus FL's margins). */
export const VIS_W = 123;

// ----------------------------------------------------------- in use

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Articulator parts in use for target t (FL's IsDefault, 0xef3f0: an envelope
 * or LFO counts when enabled, a mapping when it differs from the default
 * curve of its slot in `base`).
 */
export function partsInUse(part: HPart | undefined, base: HPart, t: number): boolean[] {
  const out: boolean[] = new Array(11).fill(false);
  const k = targetKind(t);
  if (!part || (k !== 'art' && k !== 'mapart')) return out;
  const art = part.arts[t], b = base.arts[t];
  if (!art || !b) return out;
  if (k === 'art') {
    out[0] = (art.e.m[1] | 0) !== 0;
    out[1] = (art.l.m[1] | 0) !== 0;
  }
  for (let j = 0; j < 9; j++) out[2 + j] = !!art.k[j] && !!b.k[j] && !same(art.k[j], b.k[j]);
  return out;
}

/** Is editor target t in use (any articulator part, or a shaping map that differs from its default)? */
export function targetInUse(part: HPart | undefined, base: HPart, t: number): boolean {
  const k = targetKind(t);
  if (!part) return false;
  if (k === 'map') return !same(part.maps[t - T_MAPS], base.maps[t - T_MAPS]);
  if (k === 'image') return false;
  return partsInUse(part, base, t).some(Boolean);
}

/**
 * The articulator part FL shows when target t is selected (0xefd10): the
 * previously shown part when it is in use, else the first part in use, else
 * the previous part (clamped to the target's list).
 */
export function partForTarget(part: HPart | undefined, base: HPart, t: number, prev: number): number {
  const use = partsInUse(part, base, t);
  const cur = clampArtPart(t, prev);
  if (use[cur]) return cur;
  const lo = targetKind(t) === 'art' ? 0 : 2;
  for (let i = lo; i <= 10; i++) if (use[i]) return i;
  return cur;
}
