// Remote control links ("Link to controller..."): a parameter (automation
// target) follows an internal controller (an output of a controller plugin in a
// mixer slot) or a MIDI controller, through a mapping formula. Data model,
// FL's mapping presets and the value chain shared by the engine and the UI
// (docs/research/fx/links.md).
//
// Value chain: controller output (0..1) -> mapping formula (Input = the
// controller value) -> clamped to 0..1 -> optional smoothing -> the target's
// normalised range (target.min..max, quantised by target.step) -> model value.

import type { AutomationTarget } from './automation';
import { compileCached, type FormulaEnv } from './formula';

export interface ControllerLink {
  id: string;
  /** The linked parameter (automation addressing: scope / id / path / range). */
  target: AutomationTarget;
  /** Internal controller: output `output` of the controller plugin in mixer slot `slotId`. */
  source?: { slotId: string; output: number };
  /** MIDI controller: port (-1 = any), channel 1..16, controller number (CC 0..127). */
  midi?: { port: number; chan: number; ctrl: number; omni?: boolean; mode?: number };
  /** Mapping formula in FL's syntax ("Input" = 1:1). */
  formula: string;
  /** Incremental (relative) mapping: the formula output is added to the value (endless MIDI encoders). */
  relative?: boolean;
  /** Smoothing switch and its time control (-1024..1024, FL's default 469). */
  smooth?: boolean;
  smoothTime?: number;
  /** "Record automation" switch (stored; recording is not implemented). */
  record?: boolean;
}

export const DEFAULT_FORMULA = 'Input';
export const SMOOTH_TIME_DEFAULT = 469;

/**
 * Smoothing time in ms for the Time control (-1024..1024): FL's hint law
 * (11^(|v|/1024) - 1) x 100 ms, 200 ms at the default 469, 1 s at the ends.
 */
export function smoothTimeMs(v: number): number {
  const s = Math.min(1024, Math.abs(v));
  return (Math.pow(11, s / 1024) - 1) * 100;
}

export interface MappingPreset {
  label: string;
  formula: string;
  /** Section header that starts before this item. */
  section?: string;
  relative?: boolean;
  separatorBefore?: boolean;
}

/** FL's Mapping formula presets (Remote control settings > Mapping formula menu), in FL's order. */
export const MAPPING_PRESETS: MappingPreset[] = [
  { section: 'Linear (absolute)', label: 'Default', formula: 'Input' },
  { label: 'Inverted', formula: '1-Input' },
  { separatorBefore: true, label: 'Log scale', formula: 'Tension(Input,10)' },
  { label: 'Inverted log scale', formula: 'Tension(Input,-10)' },
  { separatorBefore: true, label: 'Switch', formula: 'Round(Input)' },
  { label: 'Steppy', formula: 'Int(Input*9)/8' },
  { label: 'Steppy (cents to semitones)', formula: 'Int(Input*25)/24' },
  { separatorBefore: true, label: 'First half', formula: 'Input*0.5' },
  { label: 'Last half', formula: 'Input*0.5+0.5' },
  { separatorBefore: true, label: 'Center dead zone (small)', formula: 'Min(Input*1.1,0.5)+Max(Input*1.1,0.6)-0.6' },
  { label: 'Center dead zone (large)', formula: 'Min(Input*1.3,0.5)+Max(Input*1.3,0.8)-0.8' },
  { separatorBefore: true, label: 'MIDI CC centered around 63', formula: 'Input*1.00793650794' },
  { label: 'MIDI CC centered around 64', formula: 'Input*0.9921875' },
  { section: 'Incremental (relative)', label: 'Default increment', formula: 'Input', relative: true },
  { label: 'Inverted increment', formula: '-Input', relative: true },
  { separatorBefore: true, label: '4x smaller increment', formula: 'Input*0.25', relative: true },
  { label: '2x smaller increment', formula: 'Input*0.5', relative: true },
  { label: '2x bigger increment', formula: 'Input*2', relative: true },
  { label: '4x bigger increment', formula: 'Input*4', relative: true },
  { separatorBefore: true, label: '1/50 increment', formula: '0.02', relative: true },
  { label: '1/20 increment', formula: '0.05', relative: true },
  { label: '1/10 increment', formula: '0.1', relative: true },
  { separatorBefore: true, label: 'Force boolean', formula: 'Ceil(Input)', relative: true },
  { section: 'Special', label: 'Launchpad XY - X', formula: '(Frac(Input*7.875+0.001)-0.001)*1.142857142857143' },
  { label: 'Launchpad XY - Y', formula: 'Int(Input*8)*0.14285714285714285' },
];

/** The formulas FL ships in Config/Mapping/Formulas.txt (the menu's "User defined" section). */
export const USER_FORMULAS: MappingPreset[] = [
  { label: 'Sine curve', formula: 'Sin(Input*Pi*0.5)' },
  { label: 'Double curve', formula: '1-Cos(Input*Pi)*0.5-0.5' },
  { separatorBefore: true, label: 'Switch 1 of 4', formula: '1-Min(Round(Input*2),1)' },
  { label: 'Switch 2 of 4', formula: 'ifg(input,0.25)+ifl(input,0.5)-1' },
  { label: 'Switch 3 of 4', formula: 'ifg(input,0.5)+ifl(input,0.75)-1' },
  { label: 'Switch 4 of 4', formula: 'Max(Round(Input*2),1)-1' },
  { separatorBefore: true, label: 'Inverted first half', formula: '1-Input*0.5-0.5' },
  { label: 'Inverted last half', formula: '1-Input*0.5' },
  { separatorBefore: true, label: 'First half input', formula: 'Input*2' },
  { label: 'Last half input', formula: 'Input*2-1' },
  { label: 'Up and down', formula: '1-(Max(Input,0.5)- Min(Input,0.5))*2' },
  { label: 'Up and down smooth', formula: 'Sin(Input*Pi)' },
];

const clamp01 = (v: number) => (v > 1 ? 1 : v >= 0 ? v : 0); // NaN -> 0

/**
 * Mapping formula output for a controller value, clamped to 0..1 (FL cuts
 * values outside the range off). An invalid formula maps 1:1. `raw` returns
 * the unclamped output (relative / incremental links add it as a step).
 */
export function mapLinkValue(formula: string, input: number, env?: FormulaEnv, raw = false): number {
  const c = compileCached(formula || DEFAULT_FORMULA);
  const e = env ?? scratchEnv;
  e.input = input;
  const v = c.ok ? c.fn(e) : input;
  if (raw) return Number.isFinite(v) ? v : 0;
  return clamp01(v);
}

const scratchEnv: FormulaEnv = {};

/** A controller output listed in the Remote control settings dialog. */
export interface ControllerSourceInfo {
  slotId: string;
  output: number;
  /** "<plugin name> (<mixer track>) - <output>", FL's list text. */
  label: string;
}

/**
 * Repair stored links (older saves have none): drop malformed entries and
 * links whose controller plugin no longer exists; fill missing fields.
 */
export function normalizeLinks(list: unknown, slotExists: (slotId: string) => boolean): ControllerLink[] {
  if (!Array.isArray(list)) return [];
  const out: ControllerLink[] = [];
  for (const raw of list as Partial<ControllerLink>[]) {
    const t = raw?.target;
    if (!raw || typeof raw.id !== 'string' || !t || typeof t.path !== 'string' || typeof t.scope !== 'string') continue;
    const src = raw.source && typeof raw.source.slotId === 'string' && slotExists(raw.source.slotId)
      ? { slotId: raw.source.slotId, output: Math.max(0, Math.round(Number(raw.source.output) || 0)) }
      : undefined;
    const midi = raw.midi && Number.isFinite(raw.midi.ctrl) && raw.midi.ctrl >= 0
      ? { port: raw.midi.port ?? -1, chan: Math.min(16, Math.max(1, raw.midi.chan ?? 1)), ctrl: raw.midi.ctrl, omni: !!raw.midi.omni, mode: raw.midi.mode ?? 0 }
      : undefined;
    if (!src && !midi) continue;
    out.push({
      id: raw.id,
      target: { ...t, min: Number(t.min) || 0, max: Number.isFinite(Number(t.max)) ? Number(t.max) : 1, label: t.label ?? t.path },
      ...(src ? { source: src } : {}),
      ...(midi ? { midi } : {}),
      formula: typeof raw.formula === 'string' && raw.formula.trim() ? raw.formula : DEFAULT_FORMULA,
      ...(raw.relative ? { relative: true } : {}),
      ...(raw.smooth ? { smooth: true } : {}),
      smoothTime: Number.isFinite(raw.smoothTime) ? raw.smoothTime : SMOOTH_TIME_DEFAULT,
      ...(raw.record ? { record: true } : {}),
    });
  }
  return out;
}
