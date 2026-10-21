// Synthesized stand-ins for FL Keys' wavetables (FL's recordings are FL content and never ship with
// Orchard). Each stand-in has the same structure as the wavetable it replaces: key groups with a root and a
// `high` key, an end and a loop (or none), a sample rate and velocity factor, velocity layers for the Rhodes,
// and per-group level matched to what FL's recordings give at the default parameters (first 0.5 s RMS
// measured on FL's tables). They are additive models, not recordings: a plausible piano / e-piano / organ
// played by the real engine, not FL's sound. Built once per name (about 0.1 s) and cached.
//
// - mda Piano: a struck-string transient decaying into a looped, slowly beating sustain (the engine's decay
//   envelope shapes the note, as with FL's looped recordings);
// - Grand Piano: inharmonic partials with two-stage decays, no loop (the voice ends with the sample, as with FL's);
// - Rhodes (mda ePiano): three velocity layers (brighter with velocity), a bell partial in the attack, looped;
// - Roto Organ: drawbar harmonics, exactly periodic loop.

import { KEYS_PARAMS, type KeysTable } from './table';
import { keysEntry } from './catalog';

interface Spec {
  rate: number;
  vf: number;
  relHigh: boolean;
  /** Key groups: root notes (the `high` key of group i is the next root - 2, the last one 999). */
  roots: number[];
  layers: number[];
  /** First 0.5 s RMS target of a group (per layer). */
  rms: number[];
  /** Whether the sample loops (the loop body is a whole number of periods). */
  loop: boolean;
}

const SPECS: Record<string, Spec> = {
  'mda Piano': { rate: 22050, vf: 3, relHigh: false, roots: [36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80, 84, 88, 93], layers: [0], rms: [0.23], loop: true },
  'Grand Piano': { rate: 22050, vf: 4, relHigh: false, roots: [24, 30, 36, 42, 48, 54, 60, 66, 72, 78, 84, 90, 96, 102], layers: [0], rms: [0.1], loop: false },
  'Rhodes (mda ePiano)': { rate: 22050, vf: 3, relHigh: true, roots: [36, 43, 48, 55, 60, 67, 72, 79, 84, 91, 96], layers: [0, 48, 80], rms: [0.17, 0.18, 0.2], loop: true },
  'Roto Organ': { rate: 44100, vf: 1, relHigh: false, roots: [36, 42, 48, 54, 60, 66, 72], layers: [0], rms: [0.4], loop: true },
};

let seed = 1;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1; };

/** Add a decaying partial: amp * (sum of exponentials) * sin(2 pi cycles * t + phase), cycles per frame. */
function partial(buf: Float64Array, from: number, to: number, cyc: number, amp: number, phase: number, dec1: number, dec2 = 0, w2 = 0): void {
  const w = 2 * Math.PI * cyc;
  const cs = Math.cos(w), sn = Math.sin(w);
  let c = Math.cos(phase), s = Math.sin(phase);
  let e1 = amp * (1 - w2), e2 = amp * w2;
  for (let i = from; i < to; i++) {
    buf[i] += (e1 + e2) * s;
    const nc = c * cs - s * sn;
    s = s * cs + c * sn; c = nc;
    e1 *= dec1; e2 *= dec2 || 1;
  }
}

const hz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

/** One recording of a group: Float64 samples, the loop length (0 = none) and the end index. */
function record(name: string, root: number, layer: number, spec: Spec): { data: Float64Array; loop: number } {
  const sr = spec.rate;
  const f0 = hz(root);
  const nyq = 0.46 * sr;
  if (name === 'Grand Piano') {
    const T = 7.5 * Math.pow(2, -(root - 21) / 26) + 0.9; // seconds, A0 .. C8
    const len = Math.min(Math.round(sr * T * 3.2), sr * 9);
    const b = new Float64Array(len + 8);
    const B = 0.00012 * Math.pow(2, (root - 21) / 30);
    const nk = Math.min(26, Math.floor(nyq / f0));
    for (let k = 1; k <= nk; k++) {
      const fk = f0 * k * Math.sqrt(1 + B * k * k);
      const a = Math.pow(k, -0.85) * (0.3 + Math.abs(Math.sin(Math.PI * k * 0.13))) * Math.pow(0.6, root > 72 ? (k - 1) / 4 : 0);
      const tau = (T / (1 + 0.45 * (k - 1))) * sr;
      for (const dt of [-1, 1]) partial(b, 0, len, (fk * (1 + dt * 0.0003 * (1 + rnd() * 0.3))) / sr, 0.5 * a, rnd() * 6.28, Math.exp(-1 / tau), Math.exp(-1 / (5 * tau)), 0.35);
    }
    for (let i = 0; i < 400; i++) b[i] += rnd() * 0.25 * Math.exp(-i / 90) * (root < 60 ? 1 : 0.5);
    const fade = Math.round(0.08 * sr);
    for (let i = 0; i < fade; i++) b[len - 1 - i] *= i / fade;
    return { data: b, loop: 0 };
  }
  // looped recordings: head (attack transient) + body of M periods (periodic)
  const H = Math.round(sr * (name === 'Roto Organ' ? 0.06 : 0.35));
  const Lt = name === 'Roto Organ' ? 0.1 : 0.8;
  const M = Math.max(2, 2 * Math.round((f0 * Lt) / 2));
  const L = Math.round((M * sr) / f0);
  const f0c = M / L; // cycles per frame of the loop's fundamental
  const len = H + L;
  const b = new Float64Array(len + 8);
  const per = (r: number, amp: number, beat = false) => {
    // partial with whole cycles per loop (ratio r of the fundamental); `beat` adds a pair one cycle apart
    const cyc = Math.max(1, Math.round(r * M));
    if (cyc * sr / L > nyq) return;
    const ph = rnd() * 6.28;
    if (beat) { partial(b, 0, len, (cyc - 1) / L, amp * 0.5, ph, 1); partial(b, 0, len, (cyc + 1) / L, amp * 0.5, ph + 1, 1); }
    else partial(b, 0, len, cyc / L, amp, ph, 1);
  };
  const bright = [0.35, 0.65, 1][Math.min(2, spec.layers.indexOf(layer))] ?? 1;
  if (name === 'Roto Organ') {
    for (const [r, a] of [[0.5, 0.7], [1, 1], [2, 0.75], [3, 0.55], [4, 0.4], [6, 0.25], [8, 0.2]] as const) per(r, a);
    for (let i = 0; i < 200; i++) b[i] += rnd() * 0.12 * Math.exp(-i / 40);
    for (let i = 0; i < Math.round(0.004 * sr); i++) b[i] *= i / Math.round(0.004 * sr);
    void f0c;
    return { data: b, loop: L };
  }
  if (name === 'Rhodes (mda ePiano)') {
    per(1, 1, true);
    per(2, 0.3 + 0.5 * bright);
    per(3, 0.15 + 0.35 * bright);
    per(4, 0.1 * bright);
    // the bell: an inharmonic tine partial in the attack
    const bell = Math.round(6.9 * M);
    if (bell * sr / L < nyq) partial(b, 0, H, bell / L, 0.5 * bright, rnd() * 6.28, Math.exp(-1 / (0.06 * sr)));
    for (let i = 0; i < 300; i++) b[i] += rnd() * 0.2 * bright * Math.exp(-i / 60);
    return { data: b, loop: L };
  }
  // mda Piano: harmonic sustain with slow beats + a strong decaying attack
  const nk = Math.min(18, Math.floor(nyq / f0));
  for (let k = 1; k <= nk; k++) per(k, Math.pow(k, -0.9) * (0.35 + Math.abs(Math.sin(Math.PI * k * 0.14))), k <= 6);
  const att = new Float64Array(len + 8);
  for (let k = 1; k <= Math.min(nk, 20); k++) {
    const a = Math.pow(k, -0.8) * (0.3 + Math.abs(Math.sin(Math.PI * k * 0.14)));
    partial(att, 0, H, (k * M) / L, 2.2 * a, rnd() * 6.28, Math.exp(-1 / (0.07 * sr)), Math.exp(-1 / (0.25 * sr)), 0.4);
  }
  for (let i = 0; i < H; i++) b[i] += att[i] * (i > 0.8 * H ? (H - i) / (0.2 * H) : 1);
  for (let i = 0; i < 300; i++) b[i] += rnd() * 0.5 * Math.exp(-i / 50);
  return { data: b, loop: L };
}

const cache = new Map<string, KeysTable>();

/** The synthesized wavetable standing in for FL's `name` (unknown names: the default). */
export function synthTable(name: string): KeysTable {
  const entry = keysEntry(name);
  const hit = cache.get(entry.name);
  if (hit) return hit;
  const spec = SPECS[entry.name];
  seed = 0x1badf00d;
  const groups = spec.roots.length * spec.layers.length;
  const recs: { data: Float64Array; loop: number; root: number; high: number }[] = [];
  spec.roots.forEach((root, gi) => {
    const high = gi === spec.roots.length - 1 ? 999 : spec.roots[gi + 1] - 2;
    spec.layers.forEach((layer) => {
      const r = record(entry.name, root, layer, spec);
      // level: the first 0.5 s RMS of FL's recordings
      const n = Math.min(r.data.length, Math.round(0.5 * spec.rate));
      let ss = 0;
      for (let i = 0; i < n; i++) ss += r.data[i] * r.data[i];
      const target = spec.rms[Math.min(spec.rms.length - 1, spec.layers.indexOf(layer))];
      let g = target / Math.sqrt(ss / Math.max(1, n) + 1e-12);
      let pk = 0;
      for (let i = 0; i < r.data.length; i++) pk = Math.max(pk, Math.abs(r.data[i]));
      if (pk * g > 0.98) g = 0.98 / pk;
      for (let i = 0; i < r.data.length; i++) r.data[i] *= g;
      recs.push({ ...r, root, high });
    });
  });
  let total = 0;
  for (const r of recs) total += r.data.length - 8 + 1;
  const waves = new Float32Array(total + 8);
  const root = new Int32Array(groups), high = new Int32Array(groups), pos = new Int32Array(groups), end = new Int32Array(groups), loop = new Int32Array(groups);
  let cur = 0;
  recs.forEach((r, i) => {
    const len = r.data.length - 8;
    for (let k = 0; k < len; k++) waves[cur + k] = Math.round(r.data[k] * 32768) / 32768;
    root[i] = r.root; high[i] = r.high; pos[i] = cur; end[i] = cur + len - 1;
    loop[i] = r.loop > 0 ? r.loop : end[i];
    // the frame after the end repeats the one the loop wrap lands on
    waves[end[i] + 1] = r.loop > 0 ? waves[end[i] - r.loop + 1] : 0;
    cur += len + 1;
  });
  const thr = Int32Array.from(spec.layers);
  const t: KeysTable = {
    name: entry.name, stereo: false, rate: spec.rate, fileRate: spec.rate, vf: spec.vf, relHigh: spec.relHigh, resample: false,
    layers: spec.layers.length, thr, root, high, pos, end, loop, waves, frames: total, defaults: new Float64Array(KEYS_PARAMS).fill(NaN),
  };
  cache.set(entry.name, t);
  return t;
}
