// SoundFont Player state (FL 2026 SaveRestoreState 0x628a0, version 6): FL's 13 parameters plus what FL keeps in
// its saved state (soundfont, send routing, options). FL stores the soundfont as a file path; here each loaded
// soundfont is kept as a sample pool WAV (`sample`, the smpl / sm24 data) and the base64 `pdta` hydra (presets,
// zones, generators, modulators, sample headers). See docs/research/gen/soundfont.md.

import type { FxParamDef, FxParams } from '../../../fx/types';
import { base64ToBytes, parseHydra, type Sf2Hydra } from './sf2';

/** A loaded soundfont (FL's "Loaded SoundFonts" list). */
export interface SfFont {
  name: string;
  /** Sample pool id of the sample data (mono WAV; sample header positions index it). */
  sample: string;
  /** Sample rate the WAV was written with (the pool decodes at the audio context's rate: positions are rescaled by the ratio). */
  rate: number;
  /** Sample points in the pool. */
  frames: number;
  has24: boolean;
  /** Base64 of the file's pdta chunk. */
  hydra: string;
}

export interface SfState {
  fonts: SfFont[];
  /** Index of the soundfont that plays. */
  active: number;
  /** FL's Resampling menu (SetResampling mode): 1 Crunchy, 4 Standard, 6 HQ, 8 Extreme HQ. */
  resampling: number;
  /** Program mode: 0 Automatic, 1 Instrument, 2 Drum. */
  programMode: number;
  /** Options: velocity -> filter cutoff modulator, EMU volume envelope (attenuation scale 0.4), ignore sample links ("Fix unexpected levels"). */
  velFc: boolean;
  emu: boolean;
  ignoreLinks: boolean;
  /** BUILT-IN reverb / chorus on. */
  revOn: boolean;
  chorOn: boolean;
  /** SEND TO: mixer track offset (-125..125, 0 = none: the built-in effect). */
  revTo: number;
  chorTo: number;
  /** "Disable for preset default" unchecked: the send level knob replaces the preset's reverb / chorus send. */
  useRevLevel: boolean;
  useChorLevel: boolean;
}

export const SF_DEFAULTS: SfState = {
  fonts: [], active: 0, resampling: 4, programMode: 0, velFc: true, emu: true, ignoreLinks: true,
  revOn: false, chorOn: false, revTo: 0, chorTo: 0, useRevLevel: true, useChorLevel: true,
};

/** FL's send level multiplier (parameters 2 / 3): (19^(v / 128) - 1) / 18, 1 at 128 (ProcessParam 0x5ee70). */
export function sendLevel(v: number): number {
  return (Math.pow(19, v / 128) - 1) / 18;
}

const b01 = (x: unknown, d: boolean): boolean => (typeof x === 'boolean' ? x : typeof x === 'number' ? x !== 0 : d);
const num = (x: unknown, d: number, lo: number, hi: number): number =>
  typeof x === 'number' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : d;

function fontOf(x: unknown): SfFont | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.sample !== 'string' || typeof o.hydra !== 'string') return null;
  return {
    name: typeof o.name === 'string' ? o.name : 'SoundFont',
    sample: o.sample,
    rate: num(o.rate, 44100, 1000, 768000),
    frames: num(o.frames, 0, 0, 2 ** 31),
    has24: b01(o.has24, false),
    hydra: o.hydra,
  };
}

/** The typed state of a stored params object (missing / damaged fields take FL's defaults). */
export function sfState(p: FxParams): SfState {
  const fonts: SfFont[] = [];
  if (Array.isArray(p.fonts)) for (const f of p.fonts) { const x = fontOf(f); if (x) fonts.push(x); }
  const resampling = num(p.resampling, 4, 0, 19);
  return {
    fonts,
    active: fonts.length ? num(p.active, 0, 0, fonts.length - 1) : 0,
    resampling: [1, 4, 6, 8].includes(resampling) ? resampling : 4,
    programMode: num(p.programMode, 0, 0, 2),
    velFc: b01(p.velFc, SF_DEFAULTS.velFc),
    emu: b01(p.emu, SF_DEFAULTS.emu),
    ignoreLinks: b01(p.ignoreLinks, SF_DEFAULTS.ignoreLinks),
    revOn: b01(p.revOn, false),
    chorOn: b01(p.chorOn, false),
    revTo: num(p.revTo, 0, -125, 125),
    chorTo: num(p.chorTo, 0, -125, 125),
    useRevLevel: b01(p.useRevLevel, true),
    useChorLevel: b01(p.useChorLevel, true),
  };
}

/** Non-parameter state of a new instance (FL's plugin database state: no soundfont, patch 1, bank 0). */
export function sfInitialState(): Record<string, unknown> {
  return {
    fonts: [], active: 0, resampling: 4, programMode: 0, velFc: 1, emu: 1, ignoreLinks: 1,
    revOn: 0, chorOn: 0, revTo: 0, chorTo: 0, useRevLevel: 1, useChorLevel: 1,
  };
}

/** Repair a stored params object (the framework calls it on load): keep only valid fonts, clamp options. */
export function sfNormalize(p: Record<string, unknown>): Record<string, unknown> {
  const s = sfState(p);
  return {
    ...p,
    fonts: s.fonts.map((f) => ({ ...f })), active: s.active, resampling: s.resampling, programMode: s.programMode,
    velFc: s.velFc ? 1 : 0, emu: s.emu ? 1 : 0, ignoreLinks: s.ignoreLinks ? 1 : 0, revOn: s.revOn ? 1 : 0, chorOn: s.chorOn ? 1 : 0,
    revTo: s.revTo, chorTo: s.chorTo, useRevLevel: s.useRevLevel ? 1 : 0, useChorLevel: s.useChorLevel ? 1 : 0,
  };
}

// ------------------------------------------------------------------ FL parameters
const disabled = (v: number, min: number): string => (v === min ? 'Disabled' : String(Math.round(v)));
const percent = (v: number): string => `${Math.floor(100 * sendLevel(v) + 0.5)}%`;

/** FL's 13 parameters (host info / sweep: names, ranges, defaults, value texts). */
export function sfParams(): FxParamDef[] {
  return [
    { key: 'patch', name: 'Patch', index: 0, min: 1, max: 256, def: 1, noAuto: true, format: (v) => String(Math.round(v)) },
    { key: 'bank', name: 'Bank number', index: 1, min: 0, max: 127, def: 0, noAuto: true, format: (v) => String(Math.round(v)) },
    { key: 'revSend', name: 'Reverb send level (multiplier)', index: 2, min: 0, max: 256, def: 128, format: percent },
    { key: 'chorSend', name: 'Chorus send level (multiplier)', index: 3, min: 0, max: 256, def: 128, format: percent },
    { key: 'mod', name: 'Modulation', index: 4, min: 0, max: 127, def: 0, format: (v) => String(Math.round(v)) },
    { key: 'envAtk', name: 'Env 2 attack time', index: 5, min: -1, max: 5940, def: -1, format: (v) => disabled(v, -1) },
    { key: 'envDec', name: 'Env 2 decay time', index: 6, min: -1, max: 5940, def: -1, format: (v) => disabled(v, -1) },
    { key: 'envSus', name: 'Env 2 sustain level', index: 7, min: -1, max: 127, def: -1, format: (v) => disabled(v, -1) },
    { key: 'envRel', name: 'Env 2 release time', index: 8, min: -1, max: 5940, def: -1, format: (v) => disabled(v, -1) },
    { key: 'lfoDelay', name: 'LFO 2 predelay', index: 9, min: -1, max: 5900, def: -1, format: (v) => disabled(v, -1) },
    { key: 'lfoAmt', name: 'LFO 2 amount', index: 10, min: -128, max: 127, def: -128, format: (v) => disabled(v, -128) },
    { key: 'lfoSpeed', name: 'LFO 2 speed', index: 11, min: -1, max: 127, def: -1, format: (v) => disabled(v, -1) },
    { key: 'cutoff', name: 'Initial filter cutoff', index: 12, min: -1, max: 127, def: -1, format: (v) => disabled(v, -1) },
  ];
}

// ------------------------------------------------------------------ presets (bank / program lists)
/** One selectable preset of a hydra: FL's list is sorted by bank, then program. */
export interface SfPresetEntry {
  name: string;
  /** SF2 bank (0..127, 128 = percussion) and program. */
  bank: number;
  program: number;
  /** Index in the hydra's preset list. */
  index: number;
}

/** The presets of a hydra in FL's list order (bank, program; the terminal record dropped). */
export function presetList(h: Sf2Hydra | null): SfPresetEntry[] {
  if (!h) return [];
  const out: SfPresetEntry[] = [];
  for (let i = 0; i + 1 < h.presets.length; i++) {
    const p = h.presets[i];
    out.push({ name: p.name, bank: p.bank, program: p.program, index: i });
  }
  out.sort((a, b) => a.bank - b.bank || a.program - b.program || a.index - b.index);
  return out;
}

/**
 * FL's parameters 0 / 1 -> MIDI bank and program (0x5eec0): patch = program + 1, patches above 128 add 128 to the
 * bank (bank 128 = percussion), bank = param 1.
 */
export function bankProgram(patch: number, bank: number): { bank: number; program: number } {
  let p = Math.max(1, Math.min(256, Math.round(patch)));
  let b = Math.max(0, Math.min(127, Math.round(bank)));
  if (p > 128) { p -= 128; b += 128; }
  return { bank: b, program: p - 1 };
}

/** The preset the player plays for parameters 0 / 1: the entry of that bank / program, else the first of the list (FL's list is sorted by bank, program). */
export function currentPreset(list: SfPresetEntry[], patch: number, bank: number): SfPresetEntry | undefined {
  const bp = bankProgram(patch, bank);
  return list.find((e) => e.bank === bp.bank && e.program === bp.program) ?? list[0];
}

/** The reverse: FL parameters of a bank / program. */
export function patchOf(bank: number, program: number): { patch: number; bank: number } {
  const hi = bank >= 128;
  return { patch: program + 1 + (hi ? 128 : 0), bank: hi ? bank - 128 : bank };
}

const hydraCache = new Map<string, Sf2Hydra | null>();

/** Parsed hydra of a font (cached by its text). */
export function fontHydra(f: SfFont | undefined): Sf2Hydra | null {
  if (!f) return null;
  if (hydraCache.has(f.hydra)) return hydraCache.get(f.hydra)!;
  const bytes = base64ToBytes(f.hydra);
  const h = bytes ? parseHydra(bytes) : null;
  if (hydraCache.size > 8) hydraCache.clear();
  hydraCache.set(f.hydra, h);
  return h;
}
