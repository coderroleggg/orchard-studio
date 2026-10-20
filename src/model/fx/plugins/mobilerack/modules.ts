// FL Studio Mobile Rack FX: the effect modules (FL Studio Mobile's effects).
// Type ids, parameter names (FL's GetName minus the module prefix), defaults
// (FL's factory module presets) and value texts were read from FL's own
// plugin through flfxhost: a module's parameters are exposed by listing them
// in the state's PMAP chunk, then swept across their range. Values are the
// module's normalised floats 0..1 (FL's raw value / 65536); index 0 is the
// module's Enable switch. Choice lists whose FL text is a plain number were
// identified from the DSP (renders) and the plugin's strings; see
// docs/research/fx/mobilerack.md.

export type MrCategory = 'Echo' | 'Filter' | 'Level' | 'Misc';
export type MrKind = 'knob' | 'slider' | 'toggle' | 'choice' | 'hidden';

export interface MrParam {
  name: string;
  def: number;
  kind?: MrKind;
  options?: readonly string[];
  /** Choice index from the stored value (default: trunc(v x (n - 1))). */
  index?: (v: number) => number;
  /** Stored value for choice i (default: i / (n - 1)). */
  value?: (i: number) => number;
  /** Value text. */
  fmt?: (v: number) => string;
  /** Page (tab) of the module panel. */
  tab?: string;
  /** Short caption under/over the control (defaults to the name). */
  label?: string;
  /** Drawn from the middle. */
  bipolar?: boolean;
}

export interface MrModuleDef {
  type: number;
  /** Module name (FL Studio Mobile's). */
  name: string;
  /** Preset file name in FL's factory folder (where it differs from the name). */
  preset?: string;
  cat: MrCategory;
  params: MrParam[];
  /** Tab order when params are grouped. */
  tabs?: string[];
  /** One-line description (add-module list hint). */
  desc: string;
}

// ---- value text helpers (v = 0..1) ----
// FL Studio Mobile computes its texts in single precision and prints them with
// C's printf (ties to even), which the helpers below reproduce.

const q = (v: number) => Math.fround(Math.min(1, Math.max(0, v)));
const f32 = Math.fround;
/** printf("%.<d>f"): ties to even, keeps the sign of negative zero. */
export function cfix(x: number, d: number): string {
  const k = Math.pow(10, d), s = x * k, fl = Math.floor(s);
  let n = s - fl === 0.5 ? (fl % 2 === 0 ? fl : fl + 1) : Math.round(s);
  if (!Number.isFinite(n)) n = 0;
  const neg = x < 0 || Object.is(x, -0);
  const txt = (Math.abs(n) / k).toFixed(d);
  return neg && (n !== 0 || x !== 0 || Object.is(x, -0)) ? `-${txt}` : txt;
}
/** Truncation toward zero to d decimals. */
const tfix = (x: number, d: number) => { const k = Math.pow(10, d); const t = Math.trunc(x * k + (x >= 0 ? 1e-9 : -1e-9)) / k; return (Object.is(t, -0) ? 0 : t).toFixed(d); };
const pctR = (v: number) => `${cfix(f32(q(v) * 100), 0)} %`;
const pctT = (v: number) => `${tfix(f32(q(v) * 100), 0)} %`;
const pctN = (v: number) => `${cfix(f32(q(v) * 100), 0)}%`;
const pctNT = (v: number) => `${tfix(f32(q(v) * 100), 0)}%`;
/** FL's generic parameter text: trunc(v x 100). */
const n100 = (v: number) => tfix(f32(q(v) * 100), 0);
/** Module-specific 0..100 numbers (rounded). */
const n100R = (v: number) => cfix(f32(q(v) * 100), 0);
const bipT = (v: number) => tfix(f32((q(v) - 0.5) * 200), 0);
const bipR = (v: number) => cfix(f32((q(v) - 0.5) * 200), 0);
const bipPctNT = (v: number) => `${bipT(v)}%`;
const bipPctNR = (v: number) => `${bipR(v)}%`;
const signPctN = (v: number) => { const x = cfix(f32((q(v) - 0.5) * 200), 0); return `${Number(x) > 0 ? '+' : ''}${x}%`; };
const dbLin = (lo: number, hi: number, dec = 1) => (v: number) => `${cfix(f32(lo + (hi - lo) * q(v)), dec)} dB`;
const hzK = (f: number, decK = 1, decH = 1) => (f >= 1000 ? `${cfix(f32(f / 1000), decK)} kHz` : `${cfix(f32(f), decH)} Hz`);
const onOff = (v: number) => (v > 0.5 ? 'On' : 'Off');
const truncIdx = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.trunc(q(v) * (n - 1) + 1e-7)));
const roundIdx = (n: number) => (v: number) => Math.min(n - 1, Math.max(0, Math.round(q(v) * (n - 1))));

/** Choice index of a parameter value. */
export function mrIndex(p: MrParam, v: number): number {
  const n = p.options?.length ?? 2;
  return p.index ? p.index(v) : truncIdx(v, n);
}

/** Stored value selecting choice i. */
export function mrValueFor(p: MrParam, i: number): number {
  const n = p.options?.length ?? 2;
  if (p.value) return p.value(i);
  return n <= 1 ? 0 : i / (n - 1);
}

/** Value text of a parameter. */
export function mrFormat(p: MrParam, v: number): string {
  if (p.fmt) return p.fmt(v);
  if (p.options) return p.options[mrIndex(p, v)] ?? '';
  return n100(v);
}

// ---- control laws shared with the DSP (measured with flfxhost) ----

export const mrMap = {
  chorusRateHz: (v: number) => 0.2 + 4 * v * v,
  combPitchHz: (v: number) => 1 + 2499 * Math.pow(v, 4),
  compThreshDb: (v: number) => -40 * (1 - v),
  compRatio: (v: number) => (v >= 1 ? Infinity : 1 + 19 * v * v),
  compAttackMs: (v: number) => 50 * v * v,
  compReleaseMs: (v: number) => 10 + 490 * v * v,
  /** Filter cutoff (Hz). */
  filterHz: (v: number) => 16 * Math.pow(2, 10.3 * v),
  /** Flanger / Phaser free LFO speed (Hz). */
  lfoHz: (v: number) => 0.1 + 9.9 * v * v * v,
  flangerDelayMs: (v: number) => 2.5 * v * v,
  gateThreshDb: (v: number) => -60 * (1 - v),
  levellerDb: (v: number) => -60 + 72 * Math.pow(Math.max(0, v), 0.6),
  limiterReleaseS: (v: number) => 0.1 + 1.9 * Math.pow(v, 4),
  mbFreqHz: (v: number) => 20 * Math.pow(2, 9 * v),
  peqFreqHz: (v: number) => 32 * Math.pow(2, 9.25 * v),
  phaserHz: (v: number) => 50 + 15950 * v * v,
  revCutHz: (v: number) => (0.5 + 21.6 * v) * 1000,
  revLowCutHz: (v: number) => 19 + 2981 * v,
  revDecayS: (v: number) => 0.1 + 19.9 * v,
  spreaderLowHz: (v: number) => 10 * Math.pow(1000, v),
  tapeDelayMs: (v: number) => 1000 * v * v,
  tapeStopS: (v: number) => 5 * v,
  tremoloHz: (v: number) => 0.1 + 19.9 * v,
  wowHz: (v: number) => 0.1 + 4.9 * v,
  flutterHz: (v: number) => 5 + 15 * v,
  randomHz: (v: number) => 0.1 + 9.9 * v,
  wsCutHz: (v: number) => 20 * Math.pow(1000, v),
  wsMidHz: (v: number) => 500 * Math.pow(4, v),
};

/** Tempo divisions: labels and lengths in beats. */
export const MR_SYNC_PHASER = ['1/4', '3/8', '1/2', '3/4', '1/1', '2/1', '4/1', '8/1', '1 Bar', '2 Bars', '4 Bars', '8 Bars', '16 bars'];
/** Measured at 130 BPM: "1 Bar" is 16 beats in FL Studio Mobile's LFOs. */
export const MR_SYNC_PHASER_BEATS = [0.25, 0.375, 0.5, 0.75, 1, 2, 4, 8, 16, 32, 64, 128, 256];
export const MR_SYNC_WOW = ['1/8', '1/4', '3/8', '1/2', '3/4', 'beat', '2 beats', '4 beats', '8 beats', '16 beats'];
export const MR_SYNC_WOW_BEATS = [0.125, 0.25, 0.375, 0.5, 0.75, 1, 2, 4, 8, 16];
export const MR_SYNC_TREMOLO = ['1/4', '3/8', '1/2', '3/4', '2 beats', '16 beats', '1/8'];
export const MR_SYNC_TREMOLO_BEATS = [0.25, 0.375, 0.5, 0.75, 2, 16, 0.125];
/** Tremolo Rate Sync: FL's (irregular) label boundaries, swept on its binary. */
const TREMOLO_SYNC_EDGES = [0.1083, 0.225, 0.3417, 0.4417, 0.5583, 0.6583];
export const MR_TRANCE_TIMES = ['1/4', '3/8', '1/2', '3/4', '1/1'];
export const MR_TRANCE_BEATS = [0.25, 0.375, 0.5, 0.75, 1];
export const MR_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const MR_LFO_SHAPES = ['Sine', 'Saw', 'Square'];

/** FL's comb pitch text: 2 significant digits below 10, 3 above, kHz from 1000, trailing zeros stripped (even integer ones: 229.6 Hz reads "23 Hz" in FL). */
function combHz(f: number): string {
  const strip = (t: string) => t.replace(/0+$/, '').replace(/\.$/, '');
  if (f >= 1000) return `${strip((f / 1000).toPrecision(2))} KHz`;
  return `${strip(f.toPrecision(f < 10 ? 2 : 3))} Hz`;
}
const revCut = (v: number) => (q(v) >= 0.999 ? 'OFF' : `${cfix(f32(mrMap.revCutHz(q(v)) / 1000), 1)}kHz`);
const ms0 = (lo: number, hi: number) => (v: number) => `${cfix(f32(lo + (hi - lo) * q(v)), 0)} ms`;
const tapeTime = (v: number) => {
  const sec = f32(mrMap.tapeStopS(q(v)));
  if (sec <= 0) return 'Off';
  return sec * 1000 < 999.5 ? `${cfix(sec * 1000, 0)} ms` : `${cfix(sec, 2)} s`;
};
const deg = (v: number) => cfix(f32(360 * q(v)), 2);
/** Spacer delays: integer ms from 10 ms, one decimal from 1 ms, two below. */
const spacerMs = (d: number) => (d >= 9.995 ? `${cfix(d, 0)} ms` : d >= 0.9995 ? `${cfix(d, 1)} ms` : `${cfix(d, 2)} ms`);
/** Spacer M/S delay: ms from 1 ms (as above), microseconds below. */
const spacerUs = (d: number) => {
  if (d >= 0.9995) return spacerMs(d);
  const us = d * 1000;
  return us >= 99.95 ? `${cfix(us, 0)} us` : `${cfix(us, 1)} us`;
};

const P = (name: string, def: number, fmt: (v: number) => string = pctR, extra: Partial<MrParam> = {}): MrParam => ({ name, def, fmt, ...extra });
const S = (name: string, def: number, fmt: (v: number) => string, extra: Partial<MrParam> = {}): MrParam => ({ name, def, fmt, kind: 'slider', ...extra });
/** Two-state switch: on above 0.5 (FL). */
const T = (name: string, def: number, labels: readonly [string, string] = ['Off', 'On'], extra: Partial<MrParam> = {}): MrParam =>
  ({ name, def, kind: 'toggle', options: labels, index: (v) => (v > 0.5 ? 1 : 0), value: (i) => (i ? 1 : 0), fmt: (v) => labels[v > 0.5 ? 1 : 0], ...extra });
const C = (name: string, def: number, options: readonly string[], extra: Partial<MrParam> = {}): MrParam =>
  ({ name, def, kind: 'choice', options, ...extra });
const H = (name: string, def = 0): MrParam => ({ name, def, kind: 'hidden', fmt: n100 });
const ENABLE: MrParam = { name: 'Enable', def: 1, kind: 'hidden', fmt: onOff };
/** LFO waveform: FL's text is its generic number; the index rounds v x 2. */
const SHAPE = (name: string, tab?: string): MrParam => C(name, 0, MR_LFO_SHAPES, { index: roundIdx(3), tab, fmt: n100 });

export const MR_MODULES: MrModuleDef[] = [
  {
    type: 26, name: 'Analyzer', preset: 'Analyser', cat: 'Misc', desc: 'Spectrum, scope and level display', params: [ENABLE],
  },
  {
    type: 29, name: 'Autoduck', cat: 'Level', desc: 'Tempo-synced volume ducking ("sidechain" pumping)',
    params: [ENABLE, P('Ducking', 0.5855, pctT), P('Attack', 0.01692, (v) => `${cfix(f32(215 * q(v)), 0)} ms`),
      P('Curve', 0, (v) => (q(v) >= 1 ? 'Linear' : `${cfix(f32((1 - q(v)) * 100), 0)} %`)), P('Time', 0.9915),
      P('Shift', 0.4821, (v) => `${cfix(f32((q(v) - 0.5) * 100), 0)} %`, { bipolar: true }),
      P('Hold', 0, (v) => `${cfix(f32(99.12 * q(v)), 0)} %`), P('Shape', 0.8, n100)],
  },
  {
    type: 11, name: 'Chorus', cat: 'Misc', desc: 'Detuned voices for a thicker sound',
    params: [ENABLE, P('Rate', 0.4, (v) => `${cfix(f32(mrMap.chorusRateHz(q(v))), 2)} Hz`), P('Depth', 0.6), P('Stereo', 1), P('Mix', 0.6)],
  },
  {
    type: 40, name: 'Comb Filter', cat: 'Filter', desc: 'Tuned comb filter with pitch tracking', tabs: ['MAIN', 'TUNE'],
    params: [ENABLE, C('Mode', 0, ['Manual', 'MIDI Note', 'Audio Pitch'], { tab: 'TUNE' }),
      P('Pitch', 0.33, (v) => combHz(f32(mrMap.combPitchHz(q(v)))), { tab: 'TUNE' }), P('Feedback', 0.8, pctR, { tab: 'MAIN' }), P('Mix', 0.75, pctR, { tab: 'MAIN' }),
      P('Offset', 0.5, (v) => { const o = Math.round((q(v) - 0.5) * 4); return `${o > 0 ? '+' : ''}${o} Oct`; }, { tab: 'TUNE', bipolar: true }),
      P('Smoothing', 0.25, pctR, { tab: 'MAIN' }), T('Snap', 1, ['No', 'Yes'], { tab: 'TUNE', index: (v) => (v > 0 ? 1 : 0), fmt: (v) => (v > 0 ? 'Yes' : 'No') }),
      C('Polarity', 0, ['Both +', 'Left -', 'Right -', 'Both -'], { tab: 'MAIN' }),
      P('Asymmetry', 0.5, (v) => `${cfix(f32((q(v) - 0.5) * 10), 1)} %`, { tab: 'MAIN', bipolar: true }),
      P('Pitch Oct', 0.5, (v) => `${Math.round(q(v) * 7) - 1}`, { tab: 'TUNE', label: 'Octave' }),
      P('Pitch Note', 0.4, (v) => MR_NOTES[Math.round(q(v) * 11)], { tab: 'TUNE', label: 'Note' })],
  },
  {
    type: 8, name: 'Compressor', cat: 'Level', desc: 'Make quiet sounds louder',
    params: [ENABLE, P('Thresh', 0.499, (v) => `${cfix(f32(mrMap.compThreshDb(q(v))), 1)} dB`),
      P('Ratio', 0, (v) => (q(v) >= 1 ? '+inf' : `${cfix(f32(mrMap.compRatio(q(v))), 1)}:1`)),
      P('Attack', 0.6, (v) => `${cfix(f32(mrMap.compAttackMs(q(v))), 1)} ms`), P('Release', 0.6, (v) => `${cfix(f32(mrMap.compReleaseMs(q(v))), 1)} ms`),
      P('Level', 0.5001, dbLin(-20, 20), { bipolar: true }), P('Hold', 0, (v) => `${cfix(f32(50 * q(v) * q(v)), 1)} ms`), T('Auto gain', 1),
      P('Input gain', 0.5, dbLin(-20, 20), { bipolar: true }), T('RMS', 0)],
  },
  {
    type: 6, name: 'Distortion', cat: 'Level', desc: 'Overdrive typical of guitar amplifiers',
    params: [ENABLE, P('Drive', 0.25, n100), P('BitCrush', 0, n100), P('Gain', 1, dbLin(-24, 0)), P('Stereo', 0.5, bipT, { bipolar: true }),
      C('Kind', 0, ['Hard', 'Tube', 'Soft', 'Clip'], { fmt: n100 }), P('Bias', 0.5, bipT, { bipolar: true })],
  },
  {
    type: 3, name: 'Equalizer', preset: 'Param EQ', cat: 'Filter', desc: 'Four-band parametric equalizer', tabs: ['1', '2', '3', '4'],
    params: [ENABLE, ...[0.2, 0.4, 0.6, 0.8].flatMap((f, b) => [
      P(`Gain ${b + 1}`, 0.5, dbLin(-12, 12), { tab: `${b + 1}`, label: 'Gain', bipolar: true }),
      P(`Frequency ${b + 1}`, f, (v) => hzK(mrMap.peqFreqHz(q(v)), 2, 1), { tab: `${b + 1}`, label: 'Frequency' }),
      P(`Bandwidth ${b + 1}`, 0.5, n100, { tab: `${b + 1}`, label: 'Bandwidth' }),
      C(`Kind ${b + 1}`, 0.51, ['Low Shelf', 'Peaking', 'High Shelf'], { tab: `${b + 1}`, label: 'Kind', value: (i) => [0, 0.51, 1][i], fmt: n100 }),
    ]), ...[1, 2, 3, 4].map((b) => C(`Channel ${b}`, 0, ['Stereo', 'Left', 'Right', 'Mid', 'Side'], { tab: `${b}`, label: 'Channel', fmt: n100 }))],
  },
  {
    type: 9, name: 'Filter', cat: 'Filter', desc: 'Resonant low, band and high pass filter',
    params: [ENABLE, P('Frequency', 0.7, (v) => `${cfix(f32(mrMap.filterHz(q(v))), 1)} Hz`), P('Resonance', 0, n100),
      C('Kind', 0, ['LP', 'BP', 'HP']), C('Slope', 0.5, ['24 dB/O', '48 dB/O', '96 dB/O'])],
  },
  {
    type: 13, name: 'Flanger', cat: 'Misc', desc: 'Swept comb filtering', tabs: ['MAIN', 'LFO'],
    params: [ENABLE, C('LFO Rate', 0.4, MR_SYNC_PHASER, { tab: 'LFO', label: 'Rate', fmt: n100 }), T('Sync', 0, ['Off', 'On'], { tab: 'LFO', fmt: n100 }),
      P('LFO Speed', 0.55, (v) => `${cfix(f32(mrMap.lfoHz(q(v))), 2)} Hz`, { tab: 'LFO', label: 'Speed' }), SHAPE('LFO Shape', 'LFO'),
      P('LFO Amount', 1, pctR, { tab: 'LFO', label: 'Amount' }), P('Delay', 0.25, (v) => `${cfix(f32(mrMap.flangerDelayMs(q(v))), 2)} ms`, { tab: 'MAIN' }),
      P('Feedback', 0.75, pctR, { tab: 'MAIN' }), T('Inv. FDBK', 1, ['Off', 'On'], { tab: 'MAIN', fmt: n100 }), P('Stereo', 0, pctR, { tab: 'MAIN' }),
      P('Mix', 1, pctR, { tab: 'MAIN' }), T('Inv. Mix', 1, ['Off', 'On'], { tab: 'MAIN', fmt: n100 })],
  },
  {
    type: 27, name: 'Gate', cat: 'Level', desc: 'Volume gate with shaped opening and closing',
    params: [ENABLE, P('Threshold', 0, (v) => `${cfix(f32(mrMap.gateThreshDb(q(v))), 0)} dB`), P('Asymmetry', 0, (v) => `${cfix(f32(66 * q(v) * q(v)), 0)} dB`),
      P('Attack', 0.01, ms0(0, 1000)), P('A. Curve', 0, (v) => cfix(q(v), 1)), P('Release', 0.25, ms0(0, 1000)),
      P('R. Curve', 1, (v) => cfix(q(v), 1)), P('Mix', 1, bipPctNR, { bipolar: true }), P('Hold', 0.25, ms0(0, 1000))],
  },
  {
    type: 7, name: 'Graphic EQ', cat: 'Filter', desc: 'Eight-band graphic equalizer',
    params: [ENABLE, ...['80 Hz', '160 Hz', '375 Hz', '750 Hz', '1.5 kHz', '3 kHz', '6 kHz', '12 kHz'].map((n) => S(n, 0.5, dbLin(-12, 12), { bipolar: true }))],
  },
  {
    type: 20, name: 'Leveller', preset: 'Leveler', cat: 'Level', desc: 'Precise volume and panning',
    params: [ENABLE, P('Gain', 0.738, (v) => { const d = f32(mrMap.levellerDb(q(v))); return Math.abs(d) < 0.05 ? '0 dB' : `${d > 0 ? '+' : ''}${cfix(d, 1)} dB`; }),
      P('Pan', 0.5, (v) => { const x = f32((q(v) - 0.5) * 200); return Math.abs(x) < 0.05 ? 'mid' : `${tfix(Math.abs(x), 1)}% ${x < 0 ? 'L' : 'R'}`; }, { bipolar: true })],
  },
  {
    type: 28, name: 'Limiter', cat: 'Level', desc: 'Brick-wall limiting',
    params: [ENABLE, P('In Gain', 0.5, dbLin(-24, 24), { bipolar: true }), P('Out Gain', 0.5, dbLin(-24, 24), { bipolar: true }),
      P('Release Time', 0.2, (v) => `${cfix(f32(mrMap.limiterReleaseS(q(v))), 2)} s`, { label: 'Release' }), P('Threshold', 1, dbLin(-24, 0))],
  },
  {
    type: 4, name: 'Multi FX', cat: 'Misc', desc: 'Delay, reverb, filters, flanger, phaser, panner and vox on an X/Y pad',
    params: [ENABLE, C('FX Kind', 0, ['Delay', 'Reverb', 'LP Filter', 'HP Filter', 'Flanger', 'Phaser', 'Panner', 'Vox'], { label: 'Effect', fmt: n100 }),
      P('Axis X', 0.5, n100), P('Axis Y', 0.5, n100), P('LFO Rate', 0.61, n100), P('LFO Amount', 0, n100), SHAPE('LFO Shape')],
  },
  {
    type: 36, name: 'Multiband Compressor', cat: 'Level', desc: 'Three-band mastering compression', tabs: ['Master', 'Low', 'Mid', 'High'],
    params: [ENABLE, S('Input Gain', 0.5, dbLin(-24, 24), { tab: 'Master', label: 'Gain', bipolar: true }),
      S('Low Freq', 0.3, (v) => hzK(mrMap.mbFreqHz(q(v))), { tab: 'Master' }), S('High Freq', 0.7, (v) => hzK(mrMap.mbFreqHz(q(v))), { tab: 'Master' }),
      C('Mode', 0, ['Full', 'Safe'], { tab: 'Master', fmt: n100 }), S('Dry Mix', 0, (v) => `${cfix(f32(q(v) * q(v) * 100), 0)}%`, { tab: 'Master' }),
      ...['Low', 'Mid', 'High'].flatMap((b) => [
        S(`${b} Input Gain`, 0.5, dbLin(-24, 24), { tab: b, label: 'Input', bipolar: true }),
        S(`${b} Thres`, 1, (v) => `${cfix(f32(-48 * (1 - q(v))), 1)} dB`, { tab: b, label: 'Thres' }),
        S(`${b} Ratio`, 0, (v) => cfix(f32(1 + 30 * q(v)), 1), { tab: b, label: 'Ratio' }),
        S(`${b} Attack`, 0.3, (v) => `${cfix(f32(50 * q(v) * q(v)), 1)} ms`, { tab: b, label: 'Attack' }),
        S(`${b} Release`, 0.3, (v) => `${cfix(f32(10 + 990 * q(v)), 1)} ms`, { tab: b, label: 'Release' }),
        S(`${b} Gain`, 0.5, dbLin(-24, 24), { tab: b, label: 'Gain', bipolar: true }),
        C(`${b} Bps`, 0, ['On', 'Bypass', 'Mute'], { tab: b, label: 'Band', fmt: n100 }),
      ]),
      S('Low Width', 0.5, n100, { tab: 'Master' }), S('Mid Width', 0.5, n100, { tab: 'Master' }), S('High Width', 0.5, n100, { tab: 'Master' }), H('Reserved')],
  },
  {
    type: 14, name: 'Phaser', cat: 'Misc', desc: 'Moving frequency cancellation', tabs: ['MAIN', 'LFO'],
    params: [ENABLE, C('LFO Rate', 0.1122, MR_SYNC_PHASER, { tab: 'LFO', label: 'Rate' }), P('LFO Amount', 0.25, pctR, { tab: 'LFO', label: 'Amount' }),
      P('Feedback', 0.1, pctR, { tab: 'MAIN' }), P('Frequency', 0.25, (v) => `${cfix(f32(mrMap.phaserHz(q(v))), 0)} Hz`, { tab: 'MAIN' }),
      P('Mix', 1, pctR, { tab: 'MAIN' }), T('Sync', 1, ['Off', 'On'], { tab: 'LFO', fmt: n100 }),
      P('LFO Speed', 0, (v) => `${cfix(f32(mrMap.lfoHz(q(v))), 2)} Hz`, { tab: 'LFO', label: 'Speed' }), SHAPE('LFO Shape', 'LFO'), P('Stereo', 1, pctR, { tab: 'MAIN' })],
  },
  {
    type: 45, name: 'Pitcher 2', cat: 'Misc', desc: 'Real-time pitch correction', tabs: ['SCALE', 'MAIN'],
    params: [ENABLE, ...['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'].map((n, i) =>
      T(`Note ${n}`, [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0][i], ['Off', 'On'], { tab: 'SCALE', label: n, fmt: n100 })),
      P('Speed', 0.5, n100, { tab: 'MAIN' }), H('Reserved 1'), H('Reserved 2'),
      T('Formant Mode', 0, ['Off', 'On'], { tab: 'MAIN', label: 'Formants', fmt: n100 }), P('Formant Ratio', 0.5, bipPctNR, { tab: 'MAIN', label: 'F-Shift', bipolar: true }),
      C('Ref. Channel', 1, ['Left channel', 'Left + Right', 'Right channel'], { tab: 'MAIN', label: 'Pitch Ref.', fmt: n100 }),
      P('Stability', 0.5, pctN, { tab: 'MAIN' }), P('Humanization', 0, pctN, { tab: 'MAIN' }), T('Snapping', 0, ['Off', 'On'], { tab: 'MAIN', fmt: n100 }),
      P('Mix', 1, pctN, { tab: 'MAIN' }), P('Sensitivity', 0.5, pctN, { tab: 'MAIN' }), P('Vibrato', 0, pctN, { tab: 'MAIN' }),
      H('Latency'), T('Process Sibilants', 0, ['Off', 'On'], { tab: 'MAIN', label: 'Sibilants', fmt: n100 })],
  },
  {
    type: 35, name: 'Reverb 2', preset: 'Reeverb 2', cat: 'Echo', desc: 'Room, hall and plate reverb', tabs: ['MAIN', 'TUNE'],
    params: [ENABLE, P('HIGH CUT', 0.2256, revCut, { tab: 'MAIN' }), P('LOW CUT', 0.2306, (v) => (q(v) <= 0.001 ? 'OFF' : `${cfix(f32(mrMap.revLowCutHz(q(v))), 0)}Hz`), { tab: 'MAIN' }),
      P('SIZE', 0.999, pctN, { tab: 'MAIN' }), P('DECAY', 0.04581, (v) => `${cfix(f32(mrMap.revDecayS(q(v))), 1)}s`, { tab: 'MAIN' }), P('DIFFUSION', 1, pctN, { tab: 'MAIN' }),
      P('DAMPING', 0.07062, revCut, { tab: 'MAIN' }), P('DRY', 0.8, (v) => `${cfix(f32(q(v) * 125), 0)}%`, { tab: 'MAIN' }),
      P('ER', 0.8, (v) => `${cfix(f32(q(v) * 125), 0)}%`, { tab: 'MAIN' }), P('WET', 0.56, (v) => `${cfix(f32(q(v) * 125), 0)}%`, { tab: 'MAIN' }),
      T('SIDE INPUT', 0, ['OFF', 'ON'], { tab: 'TUNE' }), P('DELAY', 0, (v) => `${cfix(f32(1000 * q(v)), 0)}ms`, { tab: 'TUNE' }), T('TEMPO', 0, ['OFF', 'ON'], { tab: 'TUNE' }),
      P('MOD', 0.3349, pctN, { tab: 'TUNE' }), P('BASS', 0.28, (v) => cfix(f32(0.2 + 2.8 * q(v)), 1), { tab: 'TUNE' }),
      P('SEPARATION', 0.5, signPctN, { tab: 'TUNE', bipolar: true }), P('SPEED', 0.33, pctN, { tab: 'TUNE' }),
      P('CROSS', 0.2405, (v) => `${cfix(f32(25 + 1975 * q(v)), 0)}Hz`, { tab: 'TUNE' }), P('PAN', 0.5, signPctN, { tab: 'TUNE', bipolar: true })],
  },
  {
    type: 34, name: 'Spacer', cat: 'Filter', desc: 'Enhance the stereo image of mono sources',
    params: [ENABLE, P('L/R Delay', 0.5, (v) => { const x = Math.abs(2 * q(v) - 1); return x < 0.002 ? 'off' : spacerMs(f32(300 * x * x * x)); }, { bipolar: true }),
      P('Pan', 0.5, (v) => { const x = Math.abs(2 * q(v) - 1); return x < 0.002 ? 'Center' : `${cfix(f32(100 * x), 0)} %`; }, { bipolar: true }),
      P('Separation', 0.5, (v) => { const x = Number(cfix(f32((2 * q(v) - 1) * 100), 0)); return x === 0 ? 'off' : `${x > 0 ? '+' : ''}${x} %`; }, { bipolar: true }),
      C('L/R Inversion', 0, ['none', 'left', 'right', 'both'], { index: roundIdx(4) }),
      P('M/S Delay', 0.5, (v) => { const x = Math.abs(2 * q(v) - 1); const d = f32(100 * Math.pow(x, 5)); return d < 0.002 ? 'off' : spacerUs(d); }, { bipolar: true }),
      C('M/S Inversion', 0, ['none', 'mid', 'side', 'both'], { index: roundIdx(4) }), C('Stereo Mode', 0, ['Standard', 'Output M/S', 'Input M/S'], { index: roundIdx(3) })],
  },
  {
    type: 44, name: 'Spreader', cat: 'Filter', desc: 'Stereo widening from mono sources',
    params: [ENABLE, P('Width', 0, (v) => cfix(f32(2 * q(v)), 1)),
      P('Low Bypass', 0, (v) => { const f = f32(mrMap.spreaderLowHz(q(v))); return f >= 9999.5 ? `${cfix(f / 1000, 0)} kHz` : f >= 999.5 ? `${cfix(f / 1000, 1)} kHz` : `${cfix(f, 0)} Hz`; }),
      T('Mono Bass', 0, ['Off', 'On'], { fmt: n100 }),
      P('Separation', 0.5, (v) => { const x = Number(cfix(f32((2 * q(v) - 1) * 100), 0)); return x === 0 ? 'Original' : `${x} %`; }, { bipolar: true })],
  },
  {
    type: 15, name: 'Stereoizer', cat: 'Filter', desc: 'Stereo effects from mono sources',
    params: [ENABLE, P('Strength', 0.7, n100), P('Timbre', 0.52, n100), P('Focus', 0.75, bipPctNT, { bipolar: true }),
      P('L/R Delay', 0.5, bipPctNT, { bipolar: true }), P('Pan', 0.5, bipPctNT, { bipolar: true }), H('Reserved')],
  },
  {
    type: 18, name: 'Tape Delay', cat: 'Echo', desc: 'Tape-style echo',
    params: [ENABLE, P('Time', 0.6, (v) => `${tfix(f32(mrMap.tapeDelayMs(q(v))), 0)} ms`), P('Fdbk', 0.6, pctNT, { label: 'Feedback' }),
      P('Async.', 0.5, bipPctNT, { bipolar: true }), P('Mix', 0.4, pctNT)],
  },
  {
    type: 42, name: 'Tape Stop', cat: 'Misc', desc: 'Tape or vinyl style stops and starts',
    params: [ENABLE, P('Stop Time', 0.2, tapeTime), P('Start Time', 0.2, tapeTime),
      { name: 'Stop Time (sync)', def: 0.3333, kind: 'hidden', fmt: tapeTime }, { name: 'Start Time (sync)', def: 0.3333, kind: 'hidden', fmt: tapeTime },
      T('Toggle Play', 1, ['Off', 'On'], { label: 'Play' }), P('Warp', 0.5, () => 'Warp'), T('Sync', 0, ['Off', 'On'], { fmt: () => 'Sync' })],
  },
  {
    type: 16, name: 'Trance Delay', cat: 'Echo', desc: 'Tempo-synced echo',
    params: [ENABLE, C('Time', 0.775, MR_TRANCE_TIMES, { index: (v) => Math.min(4, Math.trunc(q(v) * 4 + 1e-7)), value: (i) => [0.1, 0.35, 0.6, 0.775, 1][i], fmt: n100 }),
      P('Fdbk', 0.4, n100, { label: 'Feedback' }), P('Mix', 1, n100), P('Filter', 0.5, n100, { bipolar: true }),
      C('Mode', 0.5, ['Normal', 'Ping-Pong', 'Offset'], { index: roundIdx(3), fmt: n100 }), P('Pan', 0.5, n100, { bipolar: true })],
  },
  {
    type: 46, name: 'Tremolo', cat: 'Misc', desc: 'Rapidly varied volume', tabs: ['MAIN', 'SHAPE'],
    params: [ENABLE, P('Rate Free', 0.04547, (v) => `${cfix(f32(mrMap.tremoloHz(q(v))), 2)} Hz`, { tab: 'MAIN', label: 'Rate' }),
      C('Rate Sync', 0, MR_SYNC_TREMOLO, { tab: 'MAIN', label: 'Rate', index: (v) => { let i = 0; while (i < TREMOLO_SYNC_EDGES.length && q(v) >= TREMOLO_SYNC_EDGES[i]) i++; return i; }, value: (i) => [0, 0.15, 0.28, 0.4, 0.5, 0.6, 0.8][i] }),
      P('Amount Max', 1, pctR, { tab: 'MAIN', label: 'Max' }), P('Amount Min', 0, pctR, { tab: 'MAIN', label: 'Min' }),
      P('Phase Offset', 0, deg, { tab: 'SHAPE', label: 'Phase' }), P('Stereo Offset', 0, deg, { tab: 'SHAPE', label: 'Stereo' }),
      T('Sync', 0, ['Off', 'On'], { tab: 'MAIN', fmt: () => 'Sync' }), P('Shape', 0.5, n100R, { tab: 'SHAPE' }), P('Smooth', 1, n100R, { tab: 'SHAPE' }),
      P('Skew', 0.5, bipR, { tab: 'SHAPE', bipolar: true }), P('Width', 0.5, n100R, { tab: 'SHAPE' })],
  },
  {
    type: 30, name: 'Tuned EQ', cat: 'Filter', desc: 'Eight bands centred on the notes of a key',
    params: [ENABLE, ...['65 Hz', '130 Hz', '261 Hz', '523 Hz', '1.0 kHz', '2.1 kHz', '4.2 kHz', '8.4 kHz'].map((n) => S(n, 0.5, dbLin(-12, 12), { bipolar: true })),
      C('Tuning', 0, MR_NOTES), P('Bandwidth', 0.6, n100)],
  },
  {
    type: 24, name: 'Tuner', cat: 'Misc', desc: 'Pitch display', params: [ENABLE],
  },
  {
    type: 41, name: 'Waveshaper', cat: 'Level', desc: 'Wave distortion with real-time control', tabs: ['SHAPE', 'EQ', 'LFO'],
    params: [ENABLE, C('Shape', 0, ['Analog', 'Moshpit', 'Foldback', 'Chainsaw', 'Rectifuzz', 'Cyclone'], { tab: 'SHAPE', fmt: n100 }),
      T('Auto-Gain', 0, ['Off', 'On'], { tab: 'SHAPE', fmt: n100 }),
      P('X', 0.5, n100, { tab: 'SHAPE' }), P('Y', 0.5, n100, { tab: 'SHAPE' }), P('Drive', 0, n100, { tab: 'SHAPE' }),
      P('Post Gain', 0.5, dbLin(-18, 18), { tab: 'SHAPE', label: 'Gain', bipolar: true }),
      P('Stereo Spread', 0, n100, { tab: 'SHAPE', label: 'Spread' }), P('Mix', 1, n100, { tab: 'SHAPE' }),
      P('High Cut', 1, (v) => hzK(mrMap.wsCutHz(q(v)), 2, 1), { tab: 'EQ' }), P('Low Cut', 0, (v) => hzK(mrMap.wsCutHz(q(v)), 2, 1), { tab: 'EQ' }),
      P('Bass', 0.5, dbLin(-18, 18), { tab: 'EQ', bipolar: true }), P('Mid Freq', 0.5, (v) => hzK(mrMap.wsMidHz(q(v)), 2, 1), { tab: 'EQ' }),
      P('Mid Gain', 0.5, dbLin(-18, 18), { tab: 'EQ', bipolar: true }), P('Treble', 0.5, dbLin(-18, 18), { tab: 'EQ', bipolar: true }),
      SHAPE('LFO Shape', 'LFO'), T('LFO Sync', 0, ['Off', 'On'], { tab: 'LFO', label: 'Sync', fmt: n100 }),
      C('LFO Rate', 0.5, MR_SYNC_WOW, { tab: 'LFO', label: 'Rate', fmt: n100 }), P('LFO Rate Free', 0, n100, { tab: 'LFO', label: 'Rate' }),
      P('LFO to X', 0, (v) => `${cfix(f32(q(v) * 100), 1)} %`, { tab: 'LFO', label: 'To X' }), P('LFO to Y', 0, (v) => `${cfix(f32(q(v) * 100), 1)} %`, { tab: 'LFO', label: 'To Y' })],
  },
  {
    type: 43, name: 'Wow & Flutter', cat: 'Misc', desc: 'Lo-fi cassette tape artifacts',
    params: [ENABLE, P('Wow Rate', 0.1846, (v) => `${cfix(f32(mrMap.wowHz(q(v))), 2)} Hz`, { label: 'Wow' }),
      C('Wow Rate (sync)', 0.2, MR_SYNC_WOW, { kind: 'hidden', label: 'Wow' }), P('Wow Amount', 0.25, pctR, { label: 'Amount' }),
      P('Flutter Rate', 0.06682, (v) => `${cfix(f32(mrMap.flutterHz(q(v))), 2)} Hz`, { label: 'Flutter' }),
      C('Flutter Rate (sync)', 0.1, MR_SYNC_WOW, { kind: 'hidden', label: 'Flutter' }), P('Flutter Amount', 0.25, pctR, { label: 'Amount' }),
      T('Sync', 0, ['Off', 'On'], { fmt: () => 'Sync' }), P('Random Rate', 0.08952, (v) => `${cfix(f32(mrMap.randomHz(q(v))), 1)} Hz`, { label: 'Random' }),
      C('Random Rate (sync)', 0.8, MR_SYNC_WOW, { kind: 'hidden', label: 'Random' }), P('Random Amount', 0.25, pctR, { label: 'Amount' })],
  },
];

const byType = new Map(MR_MODULES.map((m) => [m.type, m]));

export function mrModuleDef(type: number): MrModuleDef | undefined {
  return byType.get(type);
}

/** Default parameter values of a module type. */
export function mrDefaults(type: number): number[] {
  return (byType.get(type)?.params ?? [ENABLE]).map((p) => p.def);
}

export const MR_CATEGORIES: MrCategory[] = ['Echo', 'Filter', 'Level', 'Misc'];
