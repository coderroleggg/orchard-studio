// Edison's processing tools (Tools menu / toolbar), pure functions over
// channels: time stretch and pitch shift (WSOLA + cubic resampling), a
// parametric EQ (biquads), an algorithmic reverb, spectral noise reduction
// with an acquired noise profile, auto-slicing, and TypeScript versions of
// FL's stock Edison scripts (Audio scripts folder: Amp, Bit reduction,
// Destructoid, Limiter, Old school, Ring modulation, Sine / Saw / Pulse /
// Silence generator, Convert markers, Play to end).

import { getFFT } from '../../../../engine/dsp/fft';
import { BiquadState, bilinear, prototype, type ProtoKind } from '../../../../engine/dsp/biquad';
import type { EdMarker } from '../../../../model/fx/plugins/edison';
import {
  type Chans, ampRange, clampRange, cloneChans, frames, matchChannels, resampleChans, sineRange,
  pasteMix, emptyLike,
} from './ops';

// ------------------------------------------------------------- time stretch
/**
 * WSOLA time stretch: output length = input length * `factor` (factor > 1
 * makes it longer), pitch unchanged. All channels share the segment
 * alignment (found on the mono sum) so the stereo image stays intact.
 */
export function timeStretch(ch: Chans, factor: number, sr: number): Chans {
  const n = frames(ch);
  if (!(factor > 0) || Math.abs(factor - 1) < 1e-6 || n < 16) return cloneChans(ch);
  const W = Math.max(64, 2 * Math.round(0.02 * sr)); // ~40 ms window
  const H = W / 2; // synthesis hop
  const Ha = H / factor; // analysis hop
  const S = Math.round(0.01 * sr); // +-10 ms search
  const outLen = Math.max(1, Math.round(n * factor));
  const win = new Float32Array(W);
  for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / W);
  const mono = new Float32Array(n);
  for (const c of ch) for (let i = 0; i < n; i++) mono[i] += c[i];
  const out = ch.map(() => new Float32Array(outLen + W));
  const norm = new Float32Array(outLen + W);
  const at = (i: number) => (i >= 0 && i < n ? mono[i] : 0);
  // cross-correlation of the natural continuation with a candidate (decimated, then refined)
  const corr = (p: number, q: number, step: number) => {
    let s = 0;
    for (let i = 0; i < W; i += step) s += at(p + i) * at(q + i);
    return s;
  };
  let prev = 0;
  for (let k = 0; ; k++) {
    const so = k * H;
    if (so >= outLen) break;
    let pos = 0;
    if (k > 0) {
      const nat = prev + H;
      const nom = Math.round(k * Ha);
      let best = nom, bv = -Infinity;
      for (let d = -S; d <= S; d += 4) {
        const q = nom + d;
        const v = corr(nat, q, 4);
        if (v > bv) { bv = v; best = q; }
      }
      const c0 = best;
      let fine = -Infinity;
      for (let d = -3; d <= 3; d++) {
        const v = corr(nat, c0 + d, 1);
        if (v > fine) { fine = v; best = c0 + d; }
      }
      pos = Math.max(0, best);
    }
    for (let ci = 0; ci < ch.length; ci++) {
      const c = ch[ci], o = out[ci];
      for (let i = 0; i < W; i++) {
        const j = pos + i;
        if (j >= 0 && j < n) o[so + i] += c[j] * win[i];
      }
    }
    for (let i = 0; i < W; i++) norm[so + i] += win[i];
    prev = pos;
  }
  return out.map((o) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? o[i] / norm[i] : o[i];
    return r;
  });
}

/** Pitch shift by `semitones` keeping the length (stretch then resample). */
export function pitchShift(ch: Chans, semitones: number, sr: number): Chans {
  const f = Math.pow(2, semitones / 12);
  if (Math.abs(f - 1) < 1e-6) return cloneChans(ch);
  const n = frames(ch);
  const st = timeStretch(ch, f, sr);
  const rs = resampleChans(st, f);
  return rs.map((c) => { const o = new Float32Array(n); o.set(c.subarray(0, n)); return o; });
}

/**
 * Time stretch / pitch shift tool on [a, b): `pitch` in semitones, `time`
 * as a length factor; `resample` = tape mode (both change together, `pitch`
 * then sets the speed).
 */
export function stretchRange(ch: Chans, a: number, b: number, sr: number, pitch: number, time: number, resample: boolean): Chans {
  const [x, y] = clampRange(ch, a, b);
  const part = ch.map((c) => c.slice(x, y));
  let proc: Chans;
  if (resample) proc = resampleChans(part, Math.pow(2, pitch / 12));
  else {
    proc = part;
    if (Math.abs(pitch) > 1e-6) proc = pitchShift(proc, pitch, sr);
    if (Math.abs(time - 1) > 1e-6) proc = timeStretch(proc, time, sr);
  }
  return ch.map((c, ci) => {
    const p = proc[ci];
    const out = new Float32Array(c.length - (y - x) + p.length);
    out.set(c.subarray(0, x), 0);
    out.set(p, x);
    out.set(c.subarray(y), x + p.length);
    return out;
  });
}

// ---------------------------------------------------------------------- EQ
export interface EqBand { kind: ProtoKind; freq: number; gain: number; q: number; on: boolean }

export const EQ_DEFAULT: EqBand[] = [
  { kind: 'highpass', freq: 30, gain: 0, q: 0.707, on: false },
  { kind: 'lowshelf', freq: 120, gain: 0, q: 0.707, on: true },
  { kind: 'peaking', freq: 500, gain: 0, q: 1, on: true },
  { kind: 'peaking', freq: 2500, gain: 0, q: 1, on: true },
  { kind: 'highshelf', freq: 8000, gain: 0, q: 0.707, on: true },
  { kind: 'lowpass', freq: 18000, gain: 0, q: 0.707, on: false },
];

/** Magnitude response (dB) of an EQ setting at `f` Hz. */
export function eqResponseDb(bands: EqBand[], f: number, sr: number): number {
  let db = 0;
  for (const bd of bands) {
    if (!bd.on) continue;
    const c = bilinear(prototype(bd.kind, bd.q, bd.gain), bd.freq, sr);
    const w = (2 * Math.PI * f) / sr;
    const cr = Math.cos(w), ci = -Math.sin(w), c2r = Math.cos(2 * w), c2i = -Math.sin(2 * w);
    const nr = c.b0 + c.b1 * cr + c.b2 * c2r, ni = c.b1 * ci + c.b2 * c2i;
    const dr = 1 + c.a1 * cr + c.a2 * c2r, di = c.a1 * ci + c.a2 * c2i;
    db += 10 * Math.log10((nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di));
  }
  return db;
}

export function equalizeRange(ch: Chans, a: number, b: number, sr: number, bands: EqBand[]): Chans {
  const [x, y] = clampRange(ch, a, b);
  const coefs = bands.filter((bd) => bd.on && (bd.kind === 'highpass' || bd.kind === 'lowpass' || Math.abs(bd.gain) > 0.01))
    .map((bd) => bilinear(prototype(bd.kind, bd.q, bd.gain), Math.min(bd.freq, sr * 0.49), sr));
  return ch.map((c) => {
    const out = new Float32Array(c);
    if (y <= x || !coefs.length) return out;
    const seg = out.subarray(x, y);
    for (const co of coefs) new BiquadState().process(co, seg, 0, seg.length);
    return out;
  });
}

// ------------------------------------------------------------------ reverb
export interface ReverbOpts { decay: number; predelay: number; damp: number; mix: number; dry: number }

/**
 * Algorithmic reverb (parallel combs + allpasses, Freeverb topology) on
 * [a, b). The tail is mixed into the audio that follows, and the sample
 * grows when the range reaches its end.
 */
export function reverbRange(ch: Chans, a: number, b: number, sr: number, o: ReverbOpts): Chans {
  const [x, y] = clampRange(ch, a, b);
  const tail = Math.round(Math.min(10, Math.max(0.1, o.decay)) * sr);
  const n = frames(ch);
  const pre = Math.round(Math.max(0, o.predelay) * sr);
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => Math.round((d * sr) / 44100));
  const aps = [556, 441, 341, 225].map((d) => Math.round((d * sr) / 44100));
  const meanDelay = combs.reduce((s, d) => s + d, 0) / combs.length / sr;
  const fb = Math.pow(10, (-3 * meanDelay) / Math.max(0.05, o.decay)); // RT60
  const damp = Math.min(0.95, Math.max(0, o.damp));
  const len = Math.max(n, y + pre + tail);
  return ch.map((c, ci) => {
    const inp = new Float32Array(y - x + pre + tail);
    for (let i = x; i < y; i++) inp[i - x + pre] = c[i];
    const wet = new Float32Array(inp.length);
    for (const d0 of combs) {
      const d = d0 + ci * 23;
      const buf = new Float32Array(d);
      let k = 0, lp = 0;
      for (let i = 0; i < inp.length; i++) {
        const v = buf[k];
        lp = v * (1 - damp) + lp * damp;
        buf[k] = inp[i] + lp * fb;
        wet[i] += v;
        if (++k === d) k = 0;
      }
    }
    for (const d0 of aps) {
      const d = d0 + ci * 23;
      const buf = new Float32Array(d);
      let k = 0;
      for (let i = 0; i < wet.length; i++) {
        const bo = buf[k], v = wet[i];
        buf[k] = v + bo * 0.5;
        wet[i] = bo - v;
        if (++k === d) k = 0;
      }
    }
    const out = new Float32Array(len);
    out.set(c, 0);
    for (let i = x; i < y; i++) out[i] *= o.dry;
    const g = (o.mix * 0.12);
    for (let i = 0; i < wet.length; i++) { const j = x + i; if (j < len) out[j] += wet[i] * g; }
    return out;
  });
}

// ---------------------------------------------------------- noise reduction
const NR_FFT = 2048;

/** Average magnitude spectrum of [a, b) (Acquire noise profile). */
export function noiseProfile(ch: Chans, a: number, b: number): Float32Array | null {
  const [x, y] = clampRange(ch, a, b);
  if (y - x < NR_FFT) return null;
  const fft = getFFT(NR_FFT);
  const re = new Float64Array(NR_FFT), im = new Float64Array(NR_FFT);
  const prof = new Float32Array(NR_FFT / 2 + 1);
  let count = 0;
  for (const c of ch) {
    for (let p = x; p + NR_FFT <= y; p += NR_FFT / 2) {
      for (let i = 0; i < NR_FFT; i++) { re[i] = c[p + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NR_FFT)); im[i] = 0; }
      fft.transform(re, im);
      for (let k = 0; k <= NR_FFT / 2; k++) prof[k] += Math.hypot(re[k], im[k]);
      count++;
    }
  }
  for (let k = 0; k < prof.length; k++) prof[k] /= Math.max(1, count);
  return prof;
}

/**
 * Spectral subtraction (Clean up): per-bin gain max(floor, 1 - amount *
 * noise / magnitude), smoothed over time, 75 % overlapped sqrt-Hann frames.
 */
export function denoiseRange(ch: Chans, a: number, b: number, profile: Float32Array, amount: number, floorDb: number): Chans {
  const [x, y] = clampRange(ch, a, b);
  const N = NR_FFT, hop = N / 4;
  const fft = getFFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const floor = Math.pow(10, floorDb / 20);
  const re = new Float64Array(N), im = new Float64Array(N);
  const gPrev = new Float64Array(N / 2 + 1);
  return ch.map((c) => {
    const out = new Float32Array(c);
    if (y - x < 8) return out;
    const seg = new Float64Array(y - x + 2 * N);
    for (let i = x; i < y; i++) seg[i - x + N] = c[i];
    const acc = new Float64Array(seg.length);
    gPrev.fill(1);
    for (let p = 0; p + N <= seg.length; p += hop) {
      for (let i = 0; i < N; i++) { re[i] = seg[p + i] * win[i]; im[i] = 0; }
      fft.transform(re, im);
      for (let k = 0; k <= N / 2; k++) {
        const mag = Math.hypot(re[k], im[k]);
        let g = mag > 1e-12 ? 1 - (amount * profile[k]) / mag : 0;
        g = Math.max(floor, g);
        g = Math.max(g, gPrev[k] * 0.6); // release smoothing (less musical noise)
        gPrev[k] = g;
        re[k] *= g; im[k] *= g;
        if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
      }
      fft.transform(re, im, true);
      for (let i = 0; i < N; i++) acc[p + i] += (re[i] / N) * win[i];
    }
    // sqrt-Hann analysis + synthesis at 75 % overlap sums to 1.5
    for (let i = x; i < y; i++) out[i] = acc[i - x + N] / 1.5;
    return out;
  });
}

/**
 * Blur: smears the spectrum over time (per-bin magnitude smoothing with a
 * `time` second release, original phases), mixed with the dry signal.
 */
export function blurRange(ch: Chans, a: number, b: number, sr: number, time: number, mix: number): Chans {
  const [x, y] = clampRange(ch, a, b);
  const N = NR_FFT, hop = N / 4;
  const fft = getFFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const keep = Math.exp(-hop / Math.max(1, time * sr));
  const re = new Float64Array(N), im = new Float64Array(N);
  const prev = new Float64Array(N / 2 + 1);
  return ch.map((c) => {
    const out = new Float32Array(c);
    if (y - x < 8) return out;
    const seg = new Float64Array(y - x + 2 * N);
    for (let i = x; i < y; i++) seg[i - x + N] = c[i];
    const acc = new Float64Array(seg.length);
    prev.fill(0);
    for (let p = 0; p + N <= seg.length; p += hop) {
      for (let i = 0; i < N; i++) { re[i] = seg[p + i] * win[i]; im[i] = 0; }
      fft.transform(re, im);
      for (let k = 0; k <= N / 2; k++) {
        const mag = Math.hypot(re[k], im[k]);
        const sm = Math.max(mag, prev[k] * keep);
        prev[k] = sm;
        const g = mag > 1e-12 ? sm / mag : 0;
        re[k] *= g; im[k] *= g;
        if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
      }
      fft.transform(re, im, true);
      for (let i = 0; i < N; i++) acc[p + i] += (re[i] / N) * win[i];
    }
    for (let i = x; i < y; i++) out[i] = c[i] * (1 - mix) + (acc[i - x + N] / 1.5) * mix;
    return out;
  });
}

// --------------------------------------------------------------- slicing
/**
 * Onset positions (frames) for auto-slicing: a peak envelope in 3 ms steps,
 * an onset where it jumps above its recent average (`sens` 0 dull .. 2
 * sharp sets the jump and the shortest slice), refined to the first sample
 * that reaches a quarter of the new peak. The sample start is always a slice.
 */
export function autoSlice(ch: Chans, sr: number, sens: 0 | 1 | 2): number[] {
  const n = frames(ch);
  const hop = Math.max(32, Math.round(sr * 0.003));
  const env: number[] = [];
  for (let p = 0; p < n; p += hop) {
    let e = 0;
    for (const c of ch) for (let i = p; i < Math.min(n, p + hop); i++) { const v = c[i] < 0 ? -c[i] : c[i]; if (v > e) e = v; }
    env.push(e);
  }
  const ratio = [3.2, 2.2, 1.6][sens];
  const minGap = Math.round(([0.18, 0.09, 0.045][sens] * sr) / hop);
  const out: number[] = [0];
  let last = -minGap;
  for (let k = 1; k < env.length; k++) {
    let avg = 0, m = 0;
    for (let j = Math.max(0, k - 20); j < k; j++) { avg += env[j]; m++; }
    avg = m ? avg / m : 0;
    if (env[k] > 0.02 && env[k] > avg * ratio + 0.005 && env[k] >= env[k - 1] && k - last >= minGap) {
      let pos = k * hop;
      const lim = env[k] * 0.25;
      for (let i = Math.max(0, (k - 1) * hop); i < Math.min(n, (k + 1) * hop); i++) {
        let v = 0;
        for (const c of ch) { const a = c[i] < 0 ? -c[i] : c[i]; if (a > v) v = a; }
        if (v >= lim) { pos = i; break; }
      }
      if (pos > 0) out.push(pos);
      last = k;
    }
  }
  return out;
}

// ----------------------------------------------------------------- scripts
export interface ScriptInput {
  name: string;
  def: number;
  min: number;
  max: number;
  kind: 'knob' | 'input' | 'combo';
  options?: string[];
}

export interface ScriptContext {
  ch: Chans;
  sr: number;
  /** Selection [a, b) (the whole sample when nothing is selected). */
  a: number;
  b: number;
  clip: Chans | null;
  markers: EdMarker[];
}

export interface ScriptResult { ch?: Chans; sr?: number; markers?: EdMarker[] }

export interface EdScript {
  folder: string;
  name: string;
  title: string;
  desc: string;
  inputs: ScriptInput[];
  run(c: ScriptContext, v: number[]): ScriptResult | null;
}

/** An empty sample gets 1000 ms of audio before generators run (FL's scripts do the same). */
function ensureLength(c: ScriptContext): ScriptContext {
  if (frames(c.ch) > 0) return c;
  const n = Math.round(c.sr);
  return { ...c, ch: [new Float32Array(n), new Float32Array(n)], a: 0, b: n };
}

function quantize(ch: Chans, a: number, b: number, bits: number): Chans {
  const v1 = 2 ** (Math.max(1, Math.round(bits)) - 1), v2 = 1 / v1;
  const [x, y] = clampRange(ch, a, b);
  return ch.map((c) => { const o = new Float32Array(c); for (let i = x; i < y; i++) o[i] = Math.round(c[i] * v1) * v2; return o; });
}

/**
 * Sum of harmonic sines (FL's Saw / Pulse generators: harmonic m at 1/m
 * amplitude up to Nyquist), rendered from a one-cycle table of the same sum.
 */
function harmonicGen(c0: ScriptContext, freq: number, phase: number, vol: number, odd: boolean): ScriptResult {
  const c = ensureLength(c0);
  const [x, y] = clampRange(c.ch, c.a, c.b);
  const f0 = Math.max(10, freq), ny = c.sr * 0.5;
  const N = 4096;
  const table = new Float64Array(N + 1);
  const v = vol * 0.5;
  for (let m = 1; m * f0 < ny; m += odd ? 2 : 1) {
    for (let j = 0; j < N; j++) table[j] += Math.sin(2 * Math.PI * ((m * j) / N + phase * m)) * (v / m);
  }
  table[N] = table[0];
  const out = c.ch.map((ch) => { const o = new Float32Array(ch); o.fill(0, x, y); return o; });
  const inc = f0 / c.sr;
  for (let i = x; i < y; i++) {
    const p = (((i - x) * inc) % 1) * N, k = Math.floor(p), t = p - k;
    const s = table[k] + (table[k + 1] - table[k]) * t;
    for (const o of out) o[i] = s;
  }
  return { ch: out };
}

/** FL's Limiter script: lookahead peak, release, 3-pole gain smoothing, 0 dB top. */
function limiterScript(c: ScriptContext, gain: number, laMs: number, relMs: number, thres: number, tension: number, showEnv: boolean): ScriptResult {
  const [x, y] = clampRange(c.ch, c.a, c.b);
  const sr = c.sr;
  const top = 0.95;
  const LAL = Math.max(1, Math.round((laMs * sr) / 1000));
  const silTime = Math.round(0.2 * sr);
  // peak over the next LAL frames (all channels), via a sliding max
  const n = y - x;
  const pk = new Float32Array(n + LAL);
  for (let i = 0; i < n; i++) { let v = 0; for (const ch of c.ch) { const s = Math.abs(ch[x + i]); if (s > v) v = s; } pk[i] = v; }
  const ahead = new Float32Array(n);
  const dq: number[] = [];
  for (let i = 0, j = 0; i < n; i++) {
    while (j < Math.min(n, i + LAL)) { while (dq.length && pk[dq[dq.length - 1]] <= pk[j]) dq.pop(); dq.push(j); j++; }
    while (dq.length && dq[0] < i) dq.shift();
    ahead[i] = dq.length ? pk[dq[0]] : 0;
  }
  const relC = Math.exp(Math.log(0.01) / Math.max(1, Math.round((relMs * sr) / 1000)));
  const fadeC = Math.exp(Math.log(0.01) / Math.max(1, silTime));
  // 3-pole smoothing (Olli Niemitalo's parameter filter, as in the script)
  const a3 = 1 - 4.8 / Math.max(LAL, 10), b3 = tension;
  const coef = [a3, a3 * b3, a3 * b3 * b3];
  const la = Math.log(a3), lab = Math.log(a3 * b3), labb = Math.log(a3 * b3 * b3);
  const master = 1 / (-1 / (la + 2 * Math.log(b3)) + 2 / (la + Math.log(b3)) - 1 / la);
  const gains = [master, master * (labb * (la - lab) / ((labb - lab) * lab) - la / lab), master * (-(la - lab) / (labb - lab))];
  const mem = [0, 0, 0];
  const init = 1;
  let rel = 1, fadeV = 1, silCount = silTime, old = 0;
  const out = c.ch.map((ch) => new Float32Array(ch));
  for (let i = 0; i < n; i++) {
    let v = ahead[i];
    if (v > old) rel = v;
    rel = v + (rel - v) * relC;
    v = rel;
    old = v;
    let v2 = v * gain > top ? top / v : gain;
    if (v < thres) {
      if (silCount === 0) fadeV = v2;
      silCount++;
      fadeV = 1 + (fadeV - 1) * fadeC;
      v2 = fadeV;
    } else silCount = 0;
    const d = v2 - init;
    mem[0] = coef[0] * mem[0] + d; mem[1] = coef[1] * mem[1] + d; mem[2] = coef[2] * mem[2] + d;
    const g = init + gains[0] * mem[0] + gains[1] * mem[1] + gains[2] * mem[2];
    for (let k = 0; k < out.length; k++) out[k][x + i] = showEnv ? g / 2 - 1 : c.ch[k][x + i] * g;
  }
  return { ch: out };
}

export const SCRIPTS: EdScript[] = [
  {
    folder: 'Amp', name: 'Amp', title: 'Amp', desc: 'Simple amplification.',
    inputs: [{ name: 'Volume', def: 1, min: 0, max: 2, kind: 'knob' }],
    run: (c, v) => ({ ch: ampRange(c.ch, c.a, c.b, v[0]) }),
  },
  {
    folder: 'FX', name: 'Bit reduction', title: 'Bit reduction', desc: 'Bit reduction. Enter desired bit depth (for normalized input).',
    inputs: [{ name: 'Bit depth', def: 16, min: 1, max: 24, kind: 'knob' }],
    run: (c, v) => ({ ch: quantize(c.ch, c.a, c.b, Math.round(v[0])) }),
  },
  {
    folder: 'FX', name: 'Destructoid', title: 'Destructoid', desc: 'Waveshaping & samplerate reduction.',
    inputs: [
      { name: 'Freq', def: 8000, min: 250, max: 44100, kind: 'knob' },
      { name: 'Distortion', def: 50, min: 1, max: 100, kind: 'knob' },
      { name: 'Mix', def: 0.75, min: 0, max: 1, kind: 'knob' },
    ],
    run: (c, v) => {
      const [x, y] = clampRange(c.ch, c.a, c.b);
      const freq = Math.max(250, Math.round(v[0]));
      const part = c.ch.map((ch) => ch.slice(x, y));
      const down = freq < c.sr ? resampleChans(part, c.sr / freq) : part;
      for (const ch of down) for (let i = 0; i < ch.length; i++) ch[i] = Math.atan(ch[i] * v[1]) * 0.2;
      const back = freq < c.sr ? resampleChans(down, freq / c.sr) : down;
      const mix = v[2];
      return {
        ch: c.ch.map((ch, ci) => {
          const o = new Float32Array(ch);
          for (let i = x; i < y; i++) o[i] = (back[ci][i - x] ?? 0) * mix + ch[i] * (1 - mix);
          return o;
        }),
      };
    },
  },
  {
    folder: 'FX', name: 'Limiter', title: 'Limiter',
    desc: "A limiter with 0dB top. Gain doesn't apply below silence threshold. Switch envelope on to output the gain envelope.",
    inputs: [
      { name: 'Input gain', def: 2, min: 0.25, max: 4, kind: 'knob' },
      { name: 'Lookahead', def: 5, min: 1, max: 20, kind: 'knob' },
      { name: 'Release', def: 100, min: 1, max: 200, kind: 'knob' },
      { name: 'Silence thres', def: 0, min: 0, max: 0.25, kind: 'knob' },
      { name: 'Tension', def: 0.99, min: 0.1, max: 0.99, kind: 'knob' },
      { name: 'Envelope', def: 0, min: 0, max: 1, kind: 'combo', options: ['No', 'Yes'] },
    ],
    run: (c, v) => limiterScript(c, v[0], v[1], v[2], v[3], v[4], v[5] === 1),
  },
  {
    folder: 'FX', name: 'Old school', title: 'Old school', desc: 'Bit & samplerate reduction. Applied on the whole sample.',
    inputs: [],
    run: (c) => {
      const rs = resampleChans(c.ch, c.sr / 11000);
      return { ch: quantize(rs, 0, frames(rs), 8), sr: 11000, markers: c.markers.map((m) => ({ ...m, pos: Math.round(m.pos * 11000 / c.sr), ...(m.end !== undefined ? { end: Math.round(m.end * 11000 / c.sr) } : {}) })) };
    },
  },
  {
    folder: 'FX', name: 'Ring modulation', title: 'Ring modulation', desc: 'Oversampled ring modulation. Clipboard data is used as modulator.',
    inputs: [
      { name: 'Mix', def: 1, min: 0, max: 1, kind: 'input' },
      { name: 'Oversample', def: 0, min: 0, max: 1, kind: 'combo', options: ['No', 'Yes'] },
    ],
    run: (c, v) => {
      if (!c.clip || !frames(c.clip)) return null;
      const mod = matchChannels(c.clip, c.ch.length);
      const [x, y0] = clampRange(c.ch, c.a, c.b);
      const y = Math.min(y0, x + frames(mod));
      const mix = v[0];
      return {
        ch: c.ch.map((ch, ci) => {
          const o = new Float32Array(ch);
          for (let i = x; i < y; i++) { const s1 = ch[i], s2 = mod[ci][i - x]; o[i] = s1 * s2 * mix + s1 * (1 - mix); }
          return o;
        }),
      };
    },
  },
  {
    folder: 'Generation', name: 'Pulse generator', title: 'Pulse generator', desc: 'A bandlimited pulse generator.',
    inputs: [
      { name: 'Volume', def: 1, min: 0, max: 1, kind: 'input' },
      { name: 'Base freq (Hz)', def: 500, min: 10, max: 5000, kind: 'knob' },
      { name: 'Phase', def: 0, min: 0, max: 1, kind: 'input' },
    ],
    run: (c, v) => harmonicGen(c, v[1], v[2], v[0], true),
  },
  {
    folder: 'Generation', name: 'Saw generator', title: 'Saw generator', desc: 'A bandlimited saw generator.',
    inputs: [
      { name: 'Base freq (Hz)', def: 500, min: 10, max: 5000, kind: 'knob' },
      { name: 'Phase', def: 0, min: 0, max: 1, kind: 'input' },
      { name: 'Volume', def: 1, min: 0, max: 1, kind: 'input' },
    ],
    run: (c, v) => harmonicGen(c, v[0], v[1], v[2], false),
  },
  {
    folder: 'Generation', name: 'Silence generator', title: 'Silence generator', desc: 'Simple silence generator.',
    inputs: [{ name: 'Length (samples)', def: 44100, min: 1, max: 158760000, kind: 'knob' }],
    run: (c, v) => {
      if (frames(c.ch) <= 0) { const n = Math.max(1, Math.round(v[0])); return { ch: [new Float32Array(n), new Float32Array(n)] }; }
      const [x, y] = clampRange(c.ch, c.a, c.b);
      return { ch: c.ch.map((ch) => { const o = new Float32Array(ch); o.fill(0, x, y); return o; }) };
    },
  },
  {
    folder: 'Generation', name: 'Sine generator', title: 'Sine generator', desc: 'Simple sine generator.',
    inputs: [
      { name: 'Freq (Hz)', def: 500, min: 1, max: 20000, kind: 'knob' },
      { name: 'Phase', def: 0, min: 0, max: 1, kind: 'input' },
      { name: 'Volume', def: 1, min: 0, max: 2, kind: 'knob' },
    ],
    run: (c0, v) => { const c = ensureLength(c0); return { ch: sineRange(c.ch, c.a, c.b, c.sr, v[0], v[1], v[2]) }; },
  },
  {
    folder: 'Regions', name: 'Convert markers', title: 'Convert markers', desc: 'Converts markers into regions ending at the next marker.',
    inputs: [],
    run: (c) => {
      const ms = [...c.markers].sort((p, q) => p.pos - q.pos);
      const len = frames(c.ch);
      return { markers: ms.map((m, i) => ({ ...m, end: i === ms.length - 1 ? len : ms[i + 1].pos })).filter((m) => (m.end ?? 0) > m.pos) };
    },
  },
  {
    folder: 'Regions', name: 'Play to end', title: 'Play To End',
    desc: 'Converts all markers to regions ending at the end of the sample. If Selection is activated, only selected regions will be processed.',
    inputs: [
      { name: 'Reset', def: 0, min: 0, max: 1, kind: 'combo', options: ['No', 'Yes'] },
      { name: 'Selection', def: 0, min: 0, max: 1, kind: 'combo', options: ['No', 'Yes'] },
    ],
    run: (c, v) => {
      const ms = [...c.markers].sort((p, q) => p.pos - q.pos);
      const len = frames(c.ch);
      const reset = v[0] === 1, onlySel = v[1] === 1;
      const inSel = (m: EdMarker) => !onlySel || (m.pos > c.a - 1 && m.pos < c.b);
      return {
        markers: ms.map((m, i) => {
          if (!inSel(m)) return m;
          if (reset) return i < ms.length - 1 ? { ...m, end: ms[i + 1].pos } : m;
          return { ...m, end: len };
        }).filter((m) => m.end === undefined || m.end > m.pos),
      };
    },
  },
];

/** Generate noise tool (Tools > Synthesis): white noise on [a, b), or 1 s when the sample is empty. */
export function generateNoise(ch: Chans, a: number, b: number, sr: number, vol: number, seed: number): Chans {
  if (!frames(ch)) {
    const n = Math.round(sr);
    ch = [new Float32Array(n), new Float32Array(n)];
    a = 0; b = n;
  }
  const r = (() => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
  const [x, y] = clampRange(ch, a, b);
  return ch.map((c) => { const o = new Float32Array(c); for (let i = x; i < y; i++) o[i] = (r() * 2 - 1) * vol; return o; });
}

/** Mix a processed version into [a, b) with a 0..1 envelope (paste mix (envelope) / undo using mix). */
export function mixWithEnvelope(orig: Chans, proc: Chans, a: number, env: (frame: number) => number): Chans {
  const len = Math.max(frames(orig), a + frames(proc));
  const base = orig.length ? orig : emptyLike(proc, 0);
  const src = matchChannels(proc, base.length);
  return base.map((c, ci) => {
    const out = new Float32Array(len);
    out.set(c, 0);
    const s = src[ci];
    for (let i = 0; i < s.length; i++) { const g = env(a + i); out[a + i] = out[a + i] * (1 - g) + s[i] * g; }
    return out;
  });
}

export { pasteMix };
