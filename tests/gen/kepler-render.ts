// Shared by tests/gen/kepler.test.ts and keplerexo.test.ts: scenarios that were rendered by FL's test host (flfxhost,
// FL Studio 2026, 44.1 kHz, 130 BPM, 96 PPQ, 512-sample blocks split at the note events, a 0.25 s preroll with the
// transport stopped), and a renderer that drives Orchard's engine exactly the way the host drives FL's plugin.
// The recorded results of FL's renders are in kepler-render.golden.ts (a hash of the whole render and a few samples).
import { existsSync, readFileSync } from 'node:fs';
import { KeplerPlugin } from '../../src/engine/gen/plugins/kepler/plugin';
import { kpFindTables, kpPackTables, type KeplerTables } from '../../src/engine/gen/plugins/kepler/fltables';
import { keplerPresetState } from '../../src/model/gen/plugins/kepler/data';
import { keplerExoPresetState } from '../../src/model/gen/plugins/keplerexo/data';
import { newLevels, setInitLevels } from '../../src/engine/gen/levels';
import type { GenEnv, GenNote } from '../../src/engine/gen/types';

export interface KScenario {
  id: string;
  /** What the scenario exercises. */
  about: string;
  kind: 'kepler' | 'exo';
  /** Factory preset the state starts from (index in the model's preset list). */
  preset: number;
  /** Parameter values (FL control units), option switches or the modulation matrix replacing the preset's. */
  over?: Record<string, unknown>;
  /** Notes: key (60 = C5), velocity, start (s), length (s). */
  notes: [number, number, number, number][];
  /** Seconds rendered after the last note ended. */
  tail: number;
  /** The channel's volume (FL channel path, `--fl-channel`) and pan knob. */
  chan?: { vol?: number; pan?: number };
  bpm?: number;
  sr?: number;
  /** Parameter changes while playing: time (s), parameter values (FL control units) set from then on. */
  at?: [number, Record<string, number>][];
  /**
   * With the synthesised stand-in tables the render may differ from FL's by this many dB (relative to FL's level); absent when
   * the sound depends on the tables so much that only FL's own tables reproduce it (the LFO and noise).
   */
  standin?: number;
}

const CHORD: [number, number, number, number][] = [[60, 100, 0, 0.5], [64, 90, 0, 0.5], [67, 80, 0, 0.5], [72, 100, 0.55, 0.3]];
const TWO: [number, number, number, number][] = [[60, 100, 0, 0.55], [67, 90, 0.3, 0.5]];
const TRIAD: [number, number, number, number][] = [[60, 100, 0, 0.9], [64, 100, 0, 0.9], [67, 100, 0, 0.9]];
/** Ten notes 50 ms apart, each held 0.7 s: the ninth and tenth take voices from the oldest (eight voices). */
const POLY10: [number, number, number, number][] = [36, 40, 43, 48, 52, 55, 60, 64, 67, 72].map((k, i) => [k, 100, i * 0.05, 0.7]);

export const SCENARIOS: KScenario[] = [
  // ---- Kepler (Juno-6): factory presets and parameter sets
  { id: 'kep-default', about: 'the Default preset: one saw, filter open, C5', kind: 'kepler', preset: 0, notes: [[60, 100, 0, 0.5]], tail: 0.4, standin: -34 },
  { id: 'kep-acebass', about: 'preset Basses/AceBass', kind: 'kepler', preset: 9, notes: [[36, 100, 0, 0.5]], tail: 0.4, standin: -34 },
  { id: 'kep-bassguitar', about: 'preset Basses/Bassguitar 1, two notes', kind: 'kepler', preset: 11, notes: TWO, tail: 0.4, standin: -34 },
  { id: 'kep-organ', about: 'preset Keys/J6 Organ 2, chord', kind: 'kepler', preset: 85, notes: CHORD, tail: 0.3, standin: -34 },
  { id: 'kep-strings', about: 'preset Strings/J60 Strings 3 (chorus), chord', kind: 'kepler', preset: 144, notes: CHORD, tail: 0.3, standin: -34 },
  { id: 'kep-pwm-strings', about: 'preset Strings/PWM Strings (pulse width from the LFO), chord', kind: 'kepler', preset: 148, notes: CHORD, tail: 0.3, standin: -34 },
  { id: 'kep-twang', about: 'preset Synths/Twanguitar, two notes', kind: 'kepler', preset: 176, notes: TWO, tail: 0.3, standin: -34 },
  { id: 'kep-arp-preset', about: 'preset Arps/Ascendirect (arpeggiator), chord', kind: 'kepler', preset: 1, notes: CHORD, tail: 0.3, standin: -34 },
  { id: 'kep-chorus1', about: 'saw + pulse through chorus I, chord', kind: 'kepler', preset: 0, over: { dcoPulse: 1, dcoSaw: 1, chorusMode: 1 }, notes: CHORD, tail: 0.3, standin: -34 },
  { id: 'kep-chorus3-noise', about: 'chorus I + II with the chorus hiss option, chord', kind: 'kepler', preset: 0, over: { dcoPulse: 1, chorusMode: 3, chorusNoise: true }, notes: CHORD, tail: 0.3, standin: -34 },
  { id: 'kep-filter', about: 'pulse width, high-pass, low-pass with resonance, envelope and key follow, ADSR', kind: 'kepler', preset: 0, over: { dcoPulse: 1, dcoPwm: 3000, hpf: 1500, vcfFreq: 2500, vcfReso: 4200, vcfEnv: 4500, vcfKeyboard: 3000, envDecay: 2500, envSustain: 1000, envRelease: 1500 }, notes: TWO, tail: 0.4, standin: -34 },
  { id: 'kep-lfo', about: 'LFO with delay on pitch, pulse width and filter (needs FL\'s LFO table)', kind: 'kepler', preset: 0, over: { dcoPulse: 1, lfoRate: 140000, lfoDelay: 2000, dcoLfo: 1500, vcfLfo: 2500, dcoPwmSource: 1, dcoPwm: 4000, vcfFreq: 3500 }, notes: TWO, tail: 0.4, standin: -20 },
  { id: 'kep-sub-noise', about: 'pulse + sub oscillator + noise (FL\'s noise table)', kind: 'kepler', preset: 0, over: { dcoPulse: 1, dcoSub: 1, dcoSubLevel: 3500, dcoNoise: 2500, vcfFreq: 4000 }, notes: TWO, tail: 0.4, standin: -33 },
  { id: 'kep-arp', about: 'arpeggiator up, two octaves, tempo synced, triad', kind: 'kepler', preset: 0, over: { arp: 1, arpMode: 0, arpRange: 1, arpRate: 122880, arpSync: 1, dcoPulse: 1 }, notes: TRIAD, tail: 0.3, standin: -34 },
  { id: 'kep-hold', about: 'hold switch, octave up, VCA from the envelope', kind: 'kepler', preset: 0, over: { hold: 1, octave: 2, envRelease: 2000, vcaSource: 1 }, notes: [[60, 100, 0, 0.2], [64, 100, 0.3, 0.2], [67, 100, 0.6, 0.2]], tail: 0.4, standin: -34 },
  { id: 'kep-hq', about: 'high quality (4x oversampling)', kind: 'kepler', preset: 0, over: { hq: true, dcoPulse: 1, vcfFreq: 5000, vcfReso: 3000 }, notes: TWO, tail: 0.3, standin: -34 },
  { id: 'kep-channel', about: 'FL channel path: channel volume and pan arrive as MIDI events', kind: 'kepler', preset: 11, notes: TWO, tail: 0.3, chan: { vol: 0.5510106, pan: 0.5 }, standin: -34 },
  { id: 'kep-velocity', about: 'velocity changes the volume (Options: velocity to volume)', kind: 'kepler', preset: 0, over: { dcoPulse: 1 }, notes: [[48, 20, 0, 0.3], [60, 64, 0.4, 0.3], [72, 127, 0.8, 0.3]], tail: 0.3, standin: -34 },
  { id: 'kep-no-velocity', about: 'velocity to volume switched off', kind: 'kepler', preset: 0, over: { dcoPulse: 1, velocityToVolume: false }, notes: [[48, 20, 0, 0.3], [60, 64, 0.4, 0.3], [72, 127, 0.8, 0.3]], tail: 0.3, standin: -34 },
  { id: 'kep-poly10', about: 'ten notes on eight voices', kind: 'kepler', preset: 0, over: { dcoPulse: 1, envRelease: 1500 }, notes: POLY10, tail: 0.2, standin: -34 },
  { id: 'kep-arp-free-32k', about: 'free-running arpeggio (seconds clock) at 32 kHz: the wrapper converts the host time at 44.1 kHz', kind: 'kepler', preset: 7, over: { arpSync: 0 }, notes: [[46, 104, 0.21, 0.2]], tail: 0.4, sr: 32000 },
  { id: 'kep-sr48', about: '48 kHz', kind: 'kepler', preset: 144, notes: TWO, tail: 0.3, sr: 48000, standin: -34 },
  // ---- Kepler Exo: oscillators, the effects one by one, the chain, the matrix and presets
  { id: 'exo-default', about: 'the Default preset: one saw, C5', kind: 'exo', preset: 0, notes: [[60, 100, 0, 0.5]], tail: 0.4, standin: -34 },
  { id: 'exo-dco2', about: 'second oscillator with detune, hard sync and cross modulation', kind: 'exo', preset: 0, over: { dco2On: 1, dco2Semi: 7, dco2Detune: 2100, dco2Pulse: 1, dco2Sync: 1, dco1Pulse: 1, xmod21: 120000, dco2Level: 120000 }, notes: TWO, tail: 0.4, standin: -34 },
  { id: 'exo-eq', about: 'three-band equaliser: low shelf, peak, high shelf', kind: 'exo', preset: 0, over: { eqOn: 1, eqLoGain: 5000, eqLoFreq: 3000, eqLoQ: 2000, eqMidGain: 1000, eqMidFreq: 9000, eqMidQ: 4500, eqHiGain: 5500, eqHiFreq: 15000, eqHiQ: 4000, dco1Pulse: 1 }, notes: TWO, tail: 0.3, standin: -34 },
  { id: 'exo-sat', about: 'saturation before the effects', kind: 'exo', preset: 0, over: { satOn: 1, satAmount: 3500, satPost: 0 }, notes: TWO, tail: 0.3, standin: -34 },
  { id: 'exo-sat-post-hq', about: 'saturation after the effects, high quality (anti-aliased) shaper, with reverb', kind: 'exo', preset: 0, over: { satOn: 1, satAmount: 4500, satPost: 1, satHq: 1, reverbOn: 1, reverbWet: 3000 }, notes: TWO, tail: 0.3, standin: -34 },
  { id: 'exo-hyperchorus', about: 'hyper chorus', kind: 'exo', preset: 0, over: { hcOn: 1, hcMix: 4000, hcLines: 1 }, notes: CHORD, tail: 0.4, standin: -34 },
  { id: 'exo-delay', about: 'delay with feedback, blur and stereo spread (free time)', kind: 'exo', preset: 0, over: { delayOn: 1, delayAmount: 4500, delayTime: 2000, delayFeedback: 4000, delayBlur: 2500, delayStereo: 4500 }, notes: TWO, tail: 0.8, standin: -34 },
  { id: 'exo-delay-sync', about: 'tempo-synced delay at 100 BPM, filter type 1, tone', kind: 'exo', preset: 0, over: { delayOn: 1, delaySync: 1, delayTime: 3200, delayAmount: 5000, delayFeedback: 4500, delayFbType: 1, delayTone: 2500 }, notes: [[60, 100, 0, 0.3]], tail: 1.0, bpm: 100, standin: -34 },
  { id: 'exo-reverb', about: 'reverb', kind: 'exo', preset: 0, over: { reverbOn: 1, reverbWet: 6000, reverbDry: 4000 }, notes: TWO, tail: 0.6, standin: -34 },
  { id: 'exo-chain', about: 'all effects at once with chorus II', kind: 'exo', preset: 0, over: { eqOn: 1, eqMidGain: 4500, satOn: 1, satAmount: 2500, hcOn: 1, delayOn: 1, delayTime: 2500, delayAmount: 3500, reverbOn: 1, reverbWet: 4000, dco1Pulse: 1, chorusMode: 2 }, notes: CHORD, tail: 0.5, standin: -34 },
  { id: 'exo-matrix', about: 'modulation matrix: Env2 to cutoff, key follow to pulse width, velocity to resonance', kind: 'exo', preset: 0, over: { modMatrix: { src: [3, 13, 4, -1, -1, -1, -1, -1], dst: [37, 5, 38, -1, -1, -1, -1, -1] }, modAmount1: 5000, modAmount2: 4500, modAmount3: 4200, dco1Pulse: 1, cutoff: 100000, reso: 1500 }, notes: [[48, 100, 0, 0.4], [60, 60, 0.45, 0.4], [72, 127, 0.9, 0.4]], tail: 0.3, standin: -34 },
  { id: 'exo-matrix-lfo', about: 'modulation matrix with the LFO sources (needs FL\'s LFO table)', kind: 'exo', preset: 0, over: { modMatrix: { src: [0, 10, 22, -1, -1, -1, -1, -1], dst: [37, 5, 256, -1, -1, -1, -1, -1] }, modAmount1: 5000, modAmount2: 4500, modAmount3: 3300, lfo1Rate: 160000, dco1Pulse: 1, cutoff: 100000 }, notes: TWO, tail: 0.4, standin: -33 },
  { id: 'exo-arp-mono', about: 'arpeggiator mode 1 with gate, triad', kind: 'exo', preset: 0, over: { arp: 1, arpRate: 122880, arpSync: 1, arpRange: 1, arpMode: 1, arpGate: 4000 }, notes: TRIAD, tail: 0.3, standin: -34 },
  { id: 'exo-mono-porta', about: 'mono, legato and portamento', kind: 'exo', preset: 0, over: { mono: 1, legato: 1, portaMode: 1, porta: 20000, dco1Pulse: 1 }, notes: [[60, 100, 0, 0.5], [67, 100, 0.3, 0.5]], tail: 0.3, standin: -34 },
  { id: 'exo-poly10', about: 'ten notes on eight voices through the chain', kind: 'exo', preset: 0, over: { dco1Pulse: 1, env1Release: 1500, hcOn: 1, reverbOn: 1 }, notes: POLY10, tail: 0.2, standin: -34 },
  { id: 'exo-sr48', about: '48 kHz with delay and reverb', kind: 'exo', preset: 0, over: { delayOn: 1, delayTime: 2200, reverbOn: 1, hcOn: 1 }, notes: TWO, tail: 0.5, sr: 48000, standin: -34 },
  { id: 'exo-enhanced', about: 'Options > Enhanced Oscillators: saw, pulse with width, sub, DCO2 with hard sync, cross modulation and AM', kind: 'exo', preset: 0, over: { enhancedOscillators: true, dco1Pulse: 1, dco1Pw: 3500, dco1Sub: 1, dco1SubLevel: 3500, dco2On: 1, dco2Semi: 7, dco2Detune: 2100, dco2Pulse: 1, dco2Sync: 1, xmod21: 90000, dcoAm: 2000, dco2Level: 120000 }, notes: [[48, 100, 0, 0.5], [60, 90, 0.3, 0.5], [72, 110, 0.6, 0.3]], tail: 0.4, standin: -34 },
  { id: 'exo-enhanced-hq-high', about: 'Enhanced Oscillators in HQ mode with very high notes (several edges per sample), sub and noise cross modulation', kind: 'exo', preset: 0, over: { enhancedOscillators: true, hq: true, dco1Pulse: 1, dco1Sub: 1, dco2On: 1, dco2Pulse: 1, dco2Sync: 1, xmod12: 60000, xmod12Shape: 4, xmod21Shape: 5, xmod21: 150000 }, notes: [[96, 100, 0, 0.3], [115, 90, 0.2, 0.3], [127, 100, 0.4, 0.3]], tail: 0.3 },
  { id: 'exo-arp-free-48k', about: 'free-running arpeggio (seconds clock) at 48 kHz, three modes of the Exo arpeggiator', kind: 'exo', preset: 0, over: { arp: 1, arpRate: 100000, arpSync: 0, arpRange: 1, arpMode: 6, dco1Pulse: 1 }, notes: TRIAD, tail: 0.3, sr: 48000, standin: -34 },
  { id: 'exo-hp-off', about: 'the output high-pass switched off (Exo parameter "HP on")', kind: 'exo', preset: 0, over: { hpOn: 0, dco1Pulse: 1, cutoff: 60000 }, notes: [[36, 100, 0, 0.5], [48, 100, 0.3, 0.4]], tail: 0.3, standin: -34 },
  { id: 'exo-vca-smooth', about: 'VCA smooth on: filters the envelope-driven amplifier (envelope 1 and 2), not the gate', kind: 'exo', preset: 0, over: { vcaSmooth: 1, vcaSource: 0, env1Attack: 600, env1Release: 1500, dco1Pulse: 1 }, notes: TWO, tail: 0.4, standin: -34 },
  { id: 'exo-vca-smooth-gate', about: 'VCA smooth on with the gate as the amplifier source: no effect', kind: 'exo', preset: 0, over: { vcaSmooth: 1, vcaSource: 1, dco1Pulse: 1 }, notes: TWO, tail: 0.3, standin: -34 },
  { id: 'exo-mono-reset', about: 'a matrix route to the Mono switch runs the engine reset at every control period (releases the voices)', kind: 'exo', preset: 0, over: { modMatrix: { src: [20, -1, -1, -1, -1, -1, -1, -1], dst: [75, -1, -1, -1, -1, -1, -1, -1] }, dco1Pulse: 1 }, notes: [[41, 30, 0.2, 0.4], [60, 100, 0.5, 0.3]], tail: 0.3, standin: -34 },
  { id: 'exo-preset-19', about: 'factory preset 19', kind: 'exo', preset: 19, notes: CHORD, tail: 0.5, standin: -30 },
  { id: 'exo-preset-117', about: 'factory preset 117', kind: 'exo', preset: 117, notes: CHORD, tail: 0.5, standin: -30 },
  { id: 'exo-preset-146', about: 'factory preset 146', kind: 'exo', preset: 146, notes: CHORD, tail: 0.5, standin: -30 },
  { id: 'exo-preset-171', about: 'factory preset 171', kind: 'exo', preset: 171, notes: CHORD, tail: 0.5, standin: -30 },
];

// ------------------------------------------------------------------------------------------------ state and rendering
/** The state a scenario loads: the preset, the overrides and (when given) the pool sample of FL's tables. */
export function scenarioState(s: KScenario, withTables = false): Record<string, unknown> {
  const st: Record<string, unknown> = { ...(s.kind === 'exo' ? keplerExoPresetState(s.preset) : keplerPresetState(s.preset)), ...(s.over ?? {}) };
  if (withTables) st.flTablesSample = TABLES_ID;
  return st;
}

const TABLES_ID = 'fl-tables';
const packed = new Map<KeplerTables, Float32Array>();

function envOf(t: KeplerTables | null): GenEnv {
  return {
    sample: (id) => {
      if (!t || id !== TABLES_ID) return undefined;
      let p = packed.get(t);
      if (!p) { p = kpPackTables(t); packed.set(t, p); }
      return { channels: [p], sampleRate: 44100 };
    },
  };
}

function note(id: number, key: number, vel: number, chan: KScenario['chan']): GenNote {
  const init = newLevels();
  setInitLevels(init, (key - 60) * 100, vel, 0, 0, 0);
  const levels = { ...init };
  levels.vol = chan?.vol ?? 1;
  levels.pan = Math.max(-1, Math.min(1, init.pan + (chan?.pan ?? 0)));
  return { id, key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

/** The number of frames the host renders for a scenario (notes plus tail). */
export function scenarioFrames(s: KScenario): number {
  const sr = s.sr ?? 44100;
  return Math.round(Math.max(...s.notes.map((n) => n[2] + n[3]), 0) * sr) + Math.round(s.tail * sr);
}

/** Render a scenario the way the test host drives the plugin; `tables` are FL's LFO / noise tables (null: the synthesised stand-ins). */
export function renderScenario(s: KScenario, tables: KeplerTables | null, frames = scenarioFrames(s)): [Float32Array, Float32Array] {
  const sr = s.sr ?? 44100, exo = s.kind === 'exo', B = 512;
  const p = new KeplerPlugin(sr, B, exo, envOf(tables));
  p.setParams(scenarioState(s, tables !== null));
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const evs = s.notes.map((n, k) => ({ note: note(k + 1, n[0], n[1], s.chan), on: false, off: false, tOn: Math.round(n[2] * sr), tOff: Math.round((n[2] + n[3]) * sr) }));
  const bpm = s.bpm ?? 130, PPQ = 96;
  const pre = Math.round(0.25 * sr);
  const spt = (sr * 60) / (bpm * PPQ);
  const ctx = { sampleRate: sr, blockSize: B, tempo: bpm, ppq: PPQ, playing: false, pos: 0, songMode: false, track: 0 };
  const bl = new Float32Array(B), br = new Float32Array(B);
  const cur = scenarioState(s, tables !== null);
  const ats = (s.at ?? []).map(([sec, o]) => ({ t: Math.round(sec * sr), o, done: false }));
  let t = -pre;
  while (t < frames) {
    for (const a of ats) if (!a.done && a.t <= t) { a.done = true; Object.assign(cur, a.o); p.setParams({ ...cur }); }
    for (const q of evs) {
      if (!q.on && q.tOn <= t) { q.on = true; p.noteOn(q.note, 0); }
      if (q.on && !q.off && q.tOff <= t) { q.off = true; p.noteOff(q.note, 0); }
    }
    let n = Math.min(B, (t < 0 ? 0 : frames) - t);
    for (const a of ats) if (!a.done && a.t > t) n = Math.min(n, a.t - t);
    for (const q of evs) {
      if (!q.on && q.tOn > t) n = Math.min(n, q.tOn - t);
      if (q.on && !q.off && q.tOff > t) n = Math.min(n, q.tOff - t);
    }
    if (n <= 0) n = 1;
    ctx.playing = t >= 0;
    ctx.pos = t >= 0 ? t / spt : 0;
    bl.fill(0, 0, n); br.fill(0, 0, n);
    p.render(bl, br, n, ctx);
    if (t >= 0) { L.set(bl.subarray(0, n), t); R.set(br.subarray(0, n), t); }
    t += n;
  }
  return [L, R];
}

/** FNV-1a over the 32-bit words of the interleaved stereo render (negative zero counts as zero). */
export function fnvStereo(L: Float32Array, R: Float32Array): number {
  const f = new Float32Array(2), u = new Uint32Array(f.buffer);
  let h = 0x811c9dc5;
  for (let i = 0; i < L.length; i++) {
    f[0] = L[i] + 0; f[1] = R[i] + 0;
    h = Math.imul(h ^ u[0], 0x01000193);
    h = Math.imul(h ^ u[1], 0x01000193);
  }
  return h >>> 0;
}

/** The frames a golden excerpt holds: the first eight and every 1009th after them. */
export function excerptFrames(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.min(8, n); i++) out.push(i);
  for (let i = 8 + 1009; i < n; i += 1009) out.push(i);
  return out;
}

// ------------------------------------------------------------------------------------------------ FL's tables
/** The Kepler engine library of a local FL Studio install (read at test time, never copied into the project). */
const FL_ENGINES = [
  '/Applications/FL Studio 2026.app/Contents/Resources/FL/Plugins/Fruity/Generators/Kepler Exo/engine.dylib',
  '/Applications/FL Studio 2026.app/Contents/Resources/FL/Plugins/Fruity/Generators/Kepler/engine.dylib',
];

let flTables: KeplerTables | null | undefined;
/** FL's LFO and noise tables from the local FL install (found by fingerprint), or null without one. */
export function localFlTables(): KeplerTables | null {
  if (flTables !== undefined) return flTables;
  flTables = null;
  for (const f of FL_ENGINES) {
    if (!existsSync(f)) continue;
    const t = kpFindTables(readFileSync(f));
    if (t) { flTables = t; break; }
  }
  return flTables;
}
