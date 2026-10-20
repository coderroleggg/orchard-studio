// Sampler channel settings (Channel Settings window: SMP / INS / MISC tabs).
//
// Knob values are stored normalised (0..1 or -1..1) like FL's own controls;
// the mapping functions below turn them into engine units. Defaults follow a
// freshly created Sampler (see docs/research/sampler.md for sources).

import type { Id } from './types';
import { flGain } from './scales';

export type InterpMode = 'linear' | 'hermite6' | 'sinc24' | 'sinc64' | 'sinc128' | 'sinc256' | 'sinc512';
export type FilterType = 'fastlp' | 'lp' | 'bp' | 'hp' | 'bs' | 'lpx2' | 'svflp' | 'svflpx2';
export type LfoShape = 'sine' | 'triangle' | 'pulse';
/** INS tab order: PAN | VOL | MOD X | MOD Y | PITCH. */
export type EnvTarget = 'pan' | 'vol' | 'modX' | 'modY' | 'pitch';
export type DeclickMode = 'out' | 'transient' | 'transientBleed' | 'generic' | 'smooth' | 'crossfade';
export type StretchMode = 'resample' | 'stretch' | 'e3generic' | 'e3mono' | 'slicestretch' | 'slicemap' | 'auto';
export type ArpDirection = 'off' | 'up' | 'down' | 'updown' | 'updownSticky' | 'random';

export const ENV_TARGETS: EnvTarget[] = ['pan', 'vol', 'modX', 'modY', 'pitch'];
export const ENV_TARGET_LABELS: Record<EnvTarget, string> = { pan: 'PAN', vol: 'VOL', modX: 'MOD X', modY: 'MOD Y', pitch: 'PITCH' };
/** Current FL has no pan envelope (only a pan LFO); the fields are kept for compatibility. */
export const HAS_ENVELOPE: Record<EnvTarget, boolean> = { pan: false, vol: true, modX: true, modY: true, pitch: true };

export const FILTER_TYPES: FilterType[] = ['fastlp', 'lp', 'bp', 'hp', 'bs', 'lpx2', 'svflp', 'svflpx2'];
export const FILTER_LABELS: Record<FilterType, string> = {
  fastlp: 'Fast LP', lp: 'LP', bp: 'BP', hp: 'HP', bs: 'BS', lpx2: 'LPx2', svflp: 'SVF LP', svflpx2: 'SVF LPx2',
};

export const DECLICK_LABELS: Record<DeclickMode, string> = {
  out: 'Out only', transient: 'Transient (no bleeding)', transientBleed: 'Transient (bleeding)',
  generic: 'Generic (bleeding)', smooth: 'Smooth (bleeding)', crossfade: 'Crossfade (bleeding)',
};

export const INTERP_LABELS: Record<InterpMode, string> = {
  linear: 'Linear', hermite6: '6-point hermite', sinc24: '24-point sinc', sinc64: '64-point sinc',
  sinc128: '128-point sinc', sinc256: '256-point sinc', sinc512: '512-point sinc',
};

export interface EnvSettings {
  enabled: boolean;
  delay: number; // 0..1 (raw 100..65536)
  attack: number;
  hold: number;
  decay: number;
  sustain: number; // level 0..1 (raw 0..128)
  release: number;
  amount: number; // -1..1 (not used by VOL: always full depth)
  attackTension: number; // -1..1
  decayTension: number;
  releaseTension: number;
  tempo: boolean;
}

export interface LfoSettings {
  shape: LfoShape;
  delay: number;
  attack: number;
  amount: number; // -1..1
  speed: number; // 0..1, 0.5 = 16-step period when tempo-synced
  tempo: boolean;
  global: boolean;
}

export interface EnvLfo {
  env: EnvSettings;
  lfo: LfoSettings;
}

export interface Tracking {
  mid: number; // velocity (0..128) or key (0..131)
  pan: number; // -1..1
  modX: number;
  modY: number;
}

export interface ArpSettings {
  direction: ArpDirection;
  time: number; // steps between arpeggiated notes
  gate: number; // 0..1
  range: number; // octaves 1..
  repeat: number; // 1..
  chord: 'auto' | 'autoSustain' | 'none';
  slide: boolean;
}

export interface EchoSettings {
  feed: number; // 0..1, 0 = off, 0.5 = echoes keep the original volume, 1 = 200%
  pan: number; // -1..1 per echo
  cut: number; // -1..1 Mod X offset per echo
  res: number; // -1..1 Mod Y offset per echo
  pitch: number; // cents per echo (-1200..1200)
  time: number; // steps between echoes (0..8), default 3
  count: number; // 1..10
  pingPong: boolean;
  fat: boolean;
}

export interface SamplerSettings {
  sampleId: Id | null;

  // ---- SMP: file / content
  keepOnDisk: boolean;
  resample: boolean;
  loadRegions: boolean;
  loadSliceMarkers: boolean;
  // ---- SMP: playback
  startOffset: number; // 0..1 (does not trim)
  useLoopPoints: boolean;
  loopStart: number; // 0..1 of the sample
  loopEnd: number;
  pingPong: boolean;
  declick: DeclickMode;
  // ---- SMP: time stretching
  stretchPitch: number; // cents -1200..1200 (non-resample modes)
  stretchMul: number; // knob 0..1, log 25%..400%, 0.5 = 100%
  stretchTimeBeats: number; // 0 = (none); otherwise target duration in beats
  stretchMode: StretchMode;
  // ---- SMP: precomputed tools
  removeDC: boolean;
  reversePolarity: boolean;
  normalize: boolean;
  fadeStereo: boolean;
  reverse: boolean;
  swapStereo: boolean;
  smpStart: number; // trim start 0..1
  length: number; // trim end 0..1 (1 = full)
  fadeIn: number; // 0..1 (raw 0..1024)
  fadeOut: number;
  crossfade: number; // 0..1 loop crossfade
  trim: number; // 0..1 silence threshold
  // ---- SMP: precomputed effects
  boost: number; // 0..1
  clip: boolean;
  eq: number; // 0..1, 0.5 = flat tilt
  rmMix: number; // 0..1
  rmFreq: number; // 0..1, 0.5 default
  cut: number; // 0..1 lowpass (1 = open)
  res: number; // 0..1
  reverbMix: number; // 0..1
  reverbType: 'A' | 'B';
  stereoDelay: number; // -1..1 (0 = none)
  pogo: number; // -1..1 (0 = none)

  // ---- INS
  envlfo: Record<EnvTarget, EnvLfo>;
  filterType: FilterType;
  modX: number; // cutoff knob 0..1 (default 1 = open)
  modY: number; // resonance knob 0..1 (default 0)

  // ---- MISC: levels adjustment
  adjPan: number; // -1..1
  adjVol: number; // 0..1, 0.5 = 100%
  adjModX: number; // -1..1
  adjModY: number;
  // ---- MISC: polyphony
  polyMax: number; // 0 = unlimited
  mono: boolean;
  porta: boolean;
  slide: number; // knob 0..1 (raw 0..1660), default ~0.494 (half a step)
  // ---- MISC: time
  gate: number; // 0..1, 1 = off
  shift: number; // 0..1 of a step
  swingMix: number; // 0..1, default 1
  fullPorta: boolean;
  // ---- MISC: tracking
  velTrack: Tracking;
  keyTrack: Tracking;
  // ---- MISC: cut groups
  cutGroup: number; // 0 = none
  cutBy: number; // 0 = none
  // ---- MISC: arpeggiator / echo
  arp: ArpSettings;
  echo: EchoSettings;
  // ---- MISC: keyboard
  rootKey: number; // default 60 (C5)
  fineTune: number; // cents -100..100
  keyLo: number;
  keyHi: number;
  mainPitch: boolean; // follow the toolbar main pitch
  addToKey: boolean;

  // ---- header
  pitchRange: number; // semitones for the channel PITCH knob, default 2
}

const T20000 = 20000 / 65536;
const T30000 = 30000 / 65536;
const T100 = 100 / 65536;

export function defaultEnvLfo(target: EnvTarget): EnvLfo {
  return {
    env: {
      enabled: false,
      delay: T100,
      attack: T20000,
      hold: T20000,
      decay: T30000,
      sustain: 50 / 128,
      release: T20000,
      amount: 0,
      attackTension: 0,
      decayTension: 0,
      releaseTension: target === 'vol' ? -101 / 128 : 0,
      tempo: false,
    },
    lfo: { shape: 'sine', delay: T100, attack: T20000, amount: 0, speed: 32950 / 65536, tempo: false, global: false },
  };
}

export function defaultSampler(sampleId: Id | null = null): SamplerSettings {
  return {
    sampleId,
    keepOnDisk: false,
    resample: true,
    loadRegions: true,
    loadSliceMarkers: false,
    startOffset: 0,
    useLoopPoints: false,
    loopStart: 0,
    loopEnd: 1,
    pingPong: false,
    declick: 'out',
    stretchPitch: 0,
    stretchMul: 0.5,
    stretchTimeBeats: 0,
    stretchMode: 'resample',
    removeDC: false,
    reversePolarity: false,
    normalize: false,
    fadeStereo: false,
    reverse: false,
    swapStereo: false,
    smpStart: 0,
    length: 1,
    fadeIn: 0,
    fadeOut: 0,
    crossfade: 0,
    trim: 0,
    boost: 0,
    clip: false,
    eq: 0.5,
    rmMix: 0,
    rmFreq: 0.5,
    cut: 1,
    res: 0,
    reverbMix: 0,
    reverbType: 'B',
    stereoDelay: 0,
    pogo: 0,
    envlfo: {
      pan: defaultEnvLfo('pan'),
      vol: defaultEnvLfo('vol'),
      modX: defaultEnvLfo('modX'),
      modY: defaultEnvLfo('modY'),
      pitch: defaultEnvLfo('pitch'),
    },
    filterType: 'fastlp',
    modX: 1,
    modY: 0,
    adjPan: 0,
    adjVol: 0.5,
    adjModX: 0,
    adjModY: 0,
    polyMax: 0,
    mono: false,
    porta: false,
    slide: 820 / 1660,
    gate: 1,
    shift: 0,
    swingMix: 1,
    fullPorta: false,
    velTrack: { mid: 100, pan: 0, modX: 0, modY: 0 },
    keyTrack: { mid: 60, pan: 0, modX: 0, modY: 0 },
    cutGroup: 0,
    cutBy: 0,
    arp: { direction: 'off', time: 1, gate: 1, range: 1, repeat: 1, chord: 'auto', slide: false },
    echo: { feed: 0, pan: 0, cut: 0, res: 0, pitch: 0, time: 3, count: 4, pingPong: false, fat: false },
    rootKey: 60,
    fineTune: 0,
    keyLo: 0,
    keyHi: 131,
    mainPitch: true,
    addToKey: false,
    pitchRange: 2,
  };
}

/** Fill in any fields missing from older saved projects. */
export function normalizeSampler(s: Partial<SamplerSettings> | undefined, sampleId: Id | null = null): SamplerSettings {
  const d = defaultSampler(sampleId);
  const out = { ...d, ...(s ?? {}) } as SamplerSettings;
  out.envlfo = { ...d.envlfo, ...(s?.envlfo ?? {}) };
  for (const t of ENV_TARGETS) {
    out.envlfo[t] = { env: { ...d.envlfo[t].env, ...(out.envlfo[t]?.env ?? {}) }, lfo: { ...d.envlfo[t].lfo, ...(out.envlfo[t]?.lfo ?? {}) } };
  }
  out.velTrack = { ...d.velTrack, ...(s?.velTrack ?? {}) };
  out.keyTrack = { ...d.keyTrack, ...(s?.keyTrack ?? {}) };
  out.arp = { ...d.arp, ...(s?.arp ?? {}) };
  out.echo = { ...d.echo, ...(s?.echo ?? {}) };
  return out;
}

// ------------------------------------------------------------- mappings
// Curves that the manual does not document are isolated here so they can be
// recalibrated against measurements without touching the engine.

/** Envelope / LFO stage time in seconds for a knob position (community fit). */
export function envSeconds(x: number): number {
  if (x <= T100 + 1e-9) return 0;
  return Math.pow(3.66 * x, 2.7) / 3.48;
}

/** Envelope time when TEMPO is on: knob -> beats (1/16 .. 16 bars), returns seconds. */
export function envTempoSeconds(x: number, bpm: number): number {
  const beats = 0.25 * Math.pow(2, Math.round(x * 8)); // 1 step .. 64 beats
  return (beats * 60) / bpm;
}

/** Segment shape for normalised time u in 0..1 and tension t in -1..1. */
export function tensionShape(u: number, t: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (t === 0) return u;
  return Math.pow(u, Math.pow(2, 3 * t));
}

/** LFO frequency in Hz (free running). */
export function lfoHz(x: number): number {
  return 0.02 * Math.pow(10, 3 * x); // 0.02 Hz .. 20 Hz, 50% ~ 0.63 Hz
}

/** LFO period in steps when tempo-synced: 50% = 16 steps. */
export function lfoTempoSteps(x: number): number {
  return 16 * Math.pow(2, Math.round(8 * (0.5 - x)));
}

/** Filter Mod X -> cutoff Hz, Mod Y -> Q (placeholder curves, see research notes). */
export function filterCutoffHz(modX: number): number {
  return 20 * Math.pow(2, 10 * Math.min(1, Math.max(0, modX)));
}

export function filterQ(modY: number): number {
  return 0.707 * Math.pow(30, Math.min(1, Math.max(0, modY)));
}

/** Portamento / slide time in steps (fit: raw 820 = half a step, max 8 steps). */
export function slideSteps(x: number): number {
  return 8 * Math.pow(Math.max(0, x), 3.93);
}

/** GATE knob -> max note length in steps, or Infinity when off (fully clockwise). */
export function gateSteps(x: number): number {
  if (x >= 0.999) return Infinity;
  const raw = 450 + x * (1446 - 450);
  return Math.pow(2, (raw - 129) / 200) / 24;
}

/** Stretch MUL knob -> multiplier 0.25..4 (log), 0.5 = 1. */
export function stretchMultiplier(x: number): number {
  return Math.pow(16, x) / 4;
}

/** Note velocity (0..128) -> gain: velocity 100 = unity, 128 = +6.25 dB. */
export function velocityGain(vel: number): number {
  return flGain(vel / 100);
}

/** Levels adjustment VOL knob (0..1, 0.5 = 100%) -> gain. */
export function adjVolGain(x: number): number {
  return flGain(2 * x);
}

/** Declick fade lengths in ms: [fade in, fade out]. */
export function declickTimes(m: DeclickMode): [number, number] {
  switch (m) {
    case 'out': return [0, 10];
    case 'transient': return [0.15, 10];
    case 'transientBleed': return [0.15, 20];
    case 'generic': return [20, 20];
    case 'smooth': return [100, 100];
    case 'crossfade': return [200, 200];
  }
}
