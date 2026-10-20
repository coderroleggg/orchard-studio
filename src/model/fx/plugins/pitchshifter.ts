// Pitch Shifter (FL: Pitch Shifter): a real-time pitch shifter with two
// engines, Voice (pitch-synchronous overlap-add with pitch detection, formant
// shift and formant correction, relative or absolute pitch) and Music
// (granular), sharing an echo section (Off / Post / Pre / No shift) and a mix.
// Form 747 x 280. Parameters (FL Tags): 0 Pitch, 1 Formant (cents),
// 2 Analysis Channel, 3 Mix (0..2400), 4 Duration (2000..15000 = 20..150 ms),
// 5 Density (100..500 %), 6 Jitter, 7 Rand, 8 Delay (1..768: 1..1000 ms or
// 768/48 steps), 9 Feedback, 10 Delay mode, 11 Formant correction (0..65536),
// 12 Pitch mode. The engine tab, pitch detector, tempo sync and spectrum
// options live in the state (FL's state blob, version 7). Value texts are
// FL's (flfxhost sweeps); defaults are FL's Default preset (Music engine).

import type { FxPluginDef, FxPreset } from '../types';

export const PS_CHANNELS = ['LEFT', 'RIGHT', 'LEFT + RIGHT'];
export const PS_DELAY_MODES = ['OFF', 'POST', 'PRE', 'NO SHIFT'];
/** The delay mode switch captions in the editor. */
export const PS_DELAY_MODE_CAPTIONS = ['Off', 'Post', 'Pre', 'No shift'];
export const PS_PITCH_MODES = ['RELATIVE', 'ABSOLUTE C4', 'ABSOLUTE C5', 'ABSOLUTE C6'];
export const PS_DETECTORS = ['FAST', 'ACCURATE'];
/** Absolute pitch targets (FL octave numbering: C5 = middle C). */
export const PS_ABS_HZ = [130.8127827, 261.6255653, 523.2511306];
/** Spectrum speeds (FL menu tags, ms). */
export const PS_SPEEDS: [string, number][] = [['Slow', 2000], ['Medium', 1000], ['Fast', 500]];
export const PS_FCORR_MAX = 65536;

/** "+4.50 semitones", "0.00 semitones", "-12.00 semitones". */
export function psSemiText(v: number): string {
  const s = (v / 100).toFixed(2);
  return `${v > 0 ? '+' : ''}${s === '-0.00' ? '0.00' : s} semitones`;
}

export function psMixText(v: number): string {
  return `${Math.round(v / 24)}%`;
}

export function psDurationText(v: number): string {
  return `${(v / 100).toFixed(2)}ms`;
}

/** Delay time in ms (not tempo-synced): 1..1000 ms, linear. */
export function psDelayMs(v: number): number {
  return 1 + ((Math.min(768, Math.max(1, v)) - 1) * 999) / 767;
}

/** Delay in beats when tempo-synced: v / 48 steps of a quarter beat. */
export function psDelayBeats(v: number): number {
  return Math.min(768, Math.max(1, v)) / 192;
}

/** FL's delay text: "509.0ms", or "6:0 steps" (48 ticks a step) with tempo sync. */
export function psDelayText(v: number, tempo: boolean): string {
  const r = Math.round(Math.min(768, Math.max(1, v)));
  return tempo ? `${Math.floor(r / 48)}:${r % 48} steps` : `${psDelayMs(r).toFixed(1)}ms`;
}

export function psFcorrText(v: number): string {
  return `${Math.round((v * 100) / PS_FCORR_MAX)}%`;
}

/**
 * Voice latency (samples) FL reports: 27.85 ms with the FAST detector, 55.71 ms
 * with ACCURATE (1228 / 2457 at 44.1 kHz, 1336 / 2674 at 48 kHz). Music: 0.
 */
export function psLatency(sr: number, engine: number, detector: number): number {
  if (engine === 1) return 0;
  return Math.floor(sr * (detector === 1 ? 0.0557143 : 0.027846));
}

const PRESET_TABLE: [string, Record<string, unknown>][] = [
  ['Default', {}],
  ['Music/Daunting Delays', { pitch: 300, mix: 784, dur: 5461, dens: 500, rand: 17, delay: 48, fb: 47, dmode: 1, fcorr: 0, tempo: true, detector: 0 }],
  ['Music/Delay Oct Down 1', { pitch: -1200, mix: 716, dur: 2000, dens: 262, delay: 192, fb: 64, dmode: 2, fcorr: 0, tempo: true, detector: 0 }],
  ['Music/Delay Oct Down 2', { pitch: -1200, mix: 716, dur: 15000, dens: 257, delay: 144, fb: 64, dmode: 2, fcorr: 0, tempo: true, detector: 0 }],
  ['Music/Delay Oct Up 1', { pitch: 1200, mix: 826, dur: 6391, dens: 251, jit: 6, rand: 10, delay: 192, fb: 69, dmode: 2, fcorr: 0, tempo: true, detector: 0 }],
  ['Music/Delay Oct Up 2', { pitch: 1200, mix: 716, dur: 2000, dens: 262, delay: 144, fb: 64, dmode: 2, fcorr: 0, tempo: true, detector: 0 }],
  ['Music/Drum Spice', { mix: 784, dur: 2404, dens: 175, rand: 42, delay: 23, fb: 31, dmode: 3, fcorr: 0, detector: 0 }],
  ['Music/Fifth Down', { pitch: -700, dur: 15000, dens: 300, dmode: 1, fcorr: 0, detector: 0 }],
  ['Music/Fifth Up', { pitch: 700, dur: 15000, dens: 300, dmode: 1, fcorr: 0, detector: 0 }],
  ['Music/Forth Down', { pitch: -500, dur: 15000, dens: 300, dmode: 1, fcorr: 0, detector: 0 }],
  ['Music/Forth Up', { pitch: 500, dur: 15000, dens: 300, dmode: 1, fcorr: 0, detector: 0 }],
  ['Music/Octave Down', { pitch: -1200, dur: 15000, dens: 300, dmode: 1, fcorr: 0, detector: 0 }],
  ['Music/Octave Up', { pitch: 1200, dur: 15000, dens: 300, dmode: 1, fcorr: 0, detector: 0 }],
  ['Music/Pad Atmos Ringer', { pitch: 60, mix: 1846, dur: 2519, dens: 355, delay: 96, fb: 6, dmode: 3, fcorr: 0, tempo: true, detector: 0 }],
  ['Music/Pad Grainy', { pitch: 1200, mix: 1154, dur: 15000, dens: 100, jit: 29, rand: 47, delay: 81, fb: 38, dmode: 3, fcorr: 0, detector: 0 }],
  ['Music/Pad Texturer', { pitch: 27, mix: 1043, dur: 7509, dens: 500, jit: 11, delay: 144, fb: 82, dmode: 3, fcorr: 0, tempo: true, detector: 0 }],
  ['Music/Unison Buzz', { pitch: -35, dur: 5577, dens: 270, jit: 35, rand: 24, dmode: 1, fcorr: 0, detector: 0 }],
  ['Music/Unison Ecostack', { pitch: -31, mix: 1638, dur: 13191, dens: 459, jit: 4, rand: 12, delay: 1, fcorr: 0, detector: 0 }],
  ['Music/Unison Swarm', { pitch: 10, dur: 15000, dens: 288, jit: 15, rand: 100, dmode: 1, fcorr: 0, detector: 0 }],
  ['Voice/Gregorian', { pitch: -500, formant: 372, chan: 2, mix: 1177, dur: 15000, dens: 100, jit: 29, rand: 47, delay: 96, fb: 37, dmode: 2, fcorr: 33103, engine: 0, tempo: true }],
  ['Voice/Little Chorus', { pitch: -2, formant: -200, chan: 2, mix: 1942, dur: 15000, dens: 100, jit: 29, rand: 47, delay: 72, fb: 42, dmode: 1, fcorr: 27236, engine: 0, detector: 0 }],
  ['Voice/Long Delay', { pitch: -7, formant: 217, chan: 2, mix: 1942, dur: 15000, dens: 100, jit: 29, rand: 47, delay: 192, fb: 54, dmode: 3, fcorr: 28772, engine: 0, tempo: true }],
  ['Voice/Low Voice', { formant: -300, chan: 2, dur: 15000, dens: 100, jit: 29, rand: 47, delay: 1, dmode: 3, fcorr: 0, engine: 0, detector: 0 }],
  ['Voice/Octaver 1', { pitch: -1200, formant: 1200, chan: 2, mix: 1163, dur: 15000, dens: 100, jit: 29, rand: 47, delay: 1, dmode: 2, fcorr: 0, engine: 0, detector: 0 }],
  ['Voice/Octaver 2', { pitch: 1200, formant: -1200, chan: 2, mix: 1200, dur: 15000, dens: 100, jit: 29, rand: 47, delay: 1, dmode: 2, fcorr: 10811, engine: 0, detector: 0 }],
  ['Voice/Vibrance', { pitch: 3, formant: 235, chan: 1, mix: 1172, dur: 15000, dens: 100, jit: 29, rand: 47, delay: 144, fb: 23, dmode: 3, fcorr: 42063, engine: 0, tempo: true }],
];

/** FL's factory presets (Default, Music\*, Voice\*), decoded from the plugin's own state with flfxhost. */
export const PS_PRESETS: FxPreset[] = PRESET_TABLE.map(([name, params]) => ({ name, params }));

function num(v: unknown, d: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
}

export const def: FxPluginDef = {
  id: 'pitchshifter',
  name: 'Pitch Shifter',
  category: 'Misc',
  width: 747,
  height: 280,
  description: 'Pitch shifter with a voice (formant) engine and a granular music engine',
  params: [
    { key: 'pitch', name: 'Pitch', index: 0, min: -1200, max: 1200, def: 0, bipolar: true, format: psSemiText, parse: (t) => Math.round(t * 100) },
    { key: 'formant', name: 'Formant', index: 1, min: -1200, max: 1200, def: 0, bipolar: true, format: psSemiText, parse: (t) => Math.round(t * 100) },
    { key: 'chan', name: 'Analysis Channel', index: 2, min: 0, max: 2, def: 0, options: PS_CHANNELS },
    { key: 'mix', name: 'Mix', index: 3, min: 0, max: 2400, def: 2400, format: psMixText, parse: (t) => Math.round(t * 24) },
    { key: 'dur', name: 'Duration', index: 4, min: 2000, max: 15000, def: 8500, format: psDurationText, parse: (t) => Math.round(t * 100) },
    { key: 'dens', name: 'Density', index: 5, min: 100, max: 500, def: 200, format: (v) => `${Math.round(v)}%`, parse: (t) => Math.round(t) },
    { key: 'jit', name: 'Jitter', index: 6, min: 0, max: 100, def: 0, format: (v) => `${Math.round(v)}%`, parse: (t) => Math.round(t) },
    { key: 'rand', name: 'Rand', index: 7, min: 0, max: 100, def: 0, format: (v) => `${Math.round(v)}%`, parse: (t) => Math.round(t) },
    // the text depends on the tempo sync state; the editor shows psDelayText(value, tempo)
    { key: 'delay', name: 'Delay', index: 8, min: 1, max: 768, def: 768, format: (v) => psDelayText(v, false), parse: (t) => Math.round(1 + ((t - 1) * 767) / 999) },
    { key: 'fb', name: 'Feedback', index: 9, min: 0, max: 100, def: 0, format: (v) => `${Math.round(v)}%`, parse: (t) => Math.round(t) },
    { key: 'dmode', name: 'Delay mode', index: 10, min: 0, max: 3, def: 0, options: PS_DELAY_MODES },
    { key: 'fcorr', name: 'Formant correction', index: 11, min: 0, max: PS_FCORR_MAX, def: PS_FCORR_MAX, format: psFcorrText, parse: (t) => Math.round((t * PS_FCORR_MAX) / 100) },
    { key: 'pmode', name: 'Pitch mode', index: 12, min: 0, max: 3, def: 0, options: PS_PITCH_MODES },
  ],
  state: () => ({
    /** Engine tab: 0 Voice, 1 Music (FL's Default preset opens on Music). */
    engine: 1,
    /** Pitch detector: 0 FAST (28 ms), 1 ACCURATE (56 ms). */
    detector: 1,
    /** Delay in steps (tempo-based time). */
    tempo: false,
    /** Spectrogram on the X/Y pad, its speed (ms tag) and colour scheme. */
    spectrum: true,
    speed: 1000,
    mono: true,
  }),
  normalize: (p) => {
    p.engine = num(p.engine, 1, 0, 1) >= 0.5 ? 1 : 0;
    p.detector = num(p.detector, 1, 0, 1) >= 0.5 ? 1 : 0;
    p.tempo = p.tempo === true;
    p.spectrum = p.spectrum !== false;
    const sp = num(p.speed, 1000, 0, 100000);
    p.speed = PS_SPEEDS.some(([, v]) => v === sp) ? sp : 1000;
    p.mono = p.mono !== false;
    return p;
  },
  presets: PS_PRESETS,
};
