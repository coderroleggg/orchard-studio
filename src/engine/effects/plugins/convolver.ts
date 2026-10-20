// Convolver (FL: Fruity Convolver). Zero-latency non-uniformly partitioned
// convolution: a 128-tap direct-form head plus three uniformly partitioned
// overlap-save FFT levels (128 / 1024 / 8192-sample partitions covering taps
// 128..2047, 2048..16383 and 16384..). The two larger levels have one frame
// of slack, so their work is spread over the 128-sample ticks of that frame
// (no CPU spikes). Stereo signals share complex FFTs (L + iR packing).
//
// The processed impulse (trim, reverse, stretch, fades, envelopes, self-
// convolution, equalizer, normalize, pre-delay) is rendered by renderImpulse():
// on the main thread by the editor module, which sends it to the engine as
// sample 'convolver:<hash of the impulse settings>'; the engine looks that key
// up through env.sample() and, until it arrives (or in tests), renders the
// built-in room itself (without the FFT-heavy self-convolution / EQ steps).
// A new impulse is prepared incrementally (a few FFTs per block) and swapped
// in with a short wet fade, like FL's "updating" pause.

import { getFFT } from '../../dsp/fft';
import { resampleBuffer } from '../../dsp/sinc';
import type { EffectInstance, EffectModule, FxContext, FxEnv, FxMonitor } from '../types';
import {
  convDelayMs, convDryGain, convWetGain, envAt, eqGain, eqTOfFreq, stretchRatio, DEFAULT_ENV, DEFAULT_EQ, type EnvKind, type EnvPoint,
} from '../../../model/fx/plugins/convolver';

export const IR_PREFIX = 'convolver:';
export const MAX_IR_SEC = 20;
/** Loudness normalisation target: impulse energy per channel at 44.1 kHz (FL's Default.wav is ~240). */
const NORM_ENERGY_44K = 240;

// ------------------------------------------------------------------ impulse settings

/** Everything that changes the processed impulse. */
export interface IrSpec {
  impulse: string | null;
  normalize: boolean;
  reverse: boolean;
  fadeIn: number;
  fadeOut: number;
  trimStart: number;
  trimEnd: number;
  env: Record<EnvKind, EnvPoint[]>;
  eq: EnvPoint[];
  delay: number;
  selfConv: number;
  stretch: number;
  eqMix: number;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const pts = (v: unknown, d: EnvPoint[]) => (Array.isArray(v) && v.length ? (v as EnvPoint[]) : d);

export function irSpec(raw: unknown): IrSpec {
  const p = (raw ?? {}) as Record<string, unknown>;
  const env = (p.env && typeof p.env === 'object' ? p.env : {}) as Partial<Record<EnvKind, EnvPoint[]>>;
  return {
    impulse: typeof p.impulse === 'string' ? p.impulse : null,
    normalize: p.normalize === undefined ? true : !!p.normalize,
    reverse: !!p.reverse,
    fadeIn: Math.min(1, Math.max(0, num(p.fadeIn, 0))),
    fadeOut: Math.min(1, Math.max(0, num(p.fadeOut, 0))),
    trimStart: Math.min(1, Math.max(0, num(p.trimStart, 0))),
    trimEnd: Math.min(1, Math.max(0, num(p.trimEnd, 1))),
    env: { vol: pts(env.vol, DEFAULT_ENV.vol), pan: pts(env.pan, DEFAULT_ENV.pan), sep: pts(env.sep, DEFAULT_ENV.sep), ap: pts(env.ap, DEFAULT_ENV.ap) },
    eq: pts(p.eq, DEFAULT_EQ),
    delay: Math.min(1000, Math.max(0, num(p.delay, 0))),
    selfConv: Math.min(1000, Math.max(0, num(p.selfConv, 0))),
    stretch: Math.min(1000, Math.max(-1000, num(p.stretch, 0))),
    eqMix: Math.min(1000, Math.max(0, num(p.eqMix, 1000))),
  };
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Sample key of the processed impulse for these settings at this engine rate. */
export function impulseKey(raw: unknown, fs: number): string {
  const s = irSpec(raw);
  return IR_PREFIX + fnv(JSON.stringify([s, Math.round(fs)])) + (s.impulse ? ':' + s.impulse : ':room');
}

const flatEnv = (p: EnvPoint[], v: number) => p.every((q) => Math.abs(q.v - v) < 1e-6);

// ------------------------------------------------------------------ built-in room

/** Deterministic synthetic room impulse (stereo, ~3.4 s; RT60 ~3.4 s at LF, ~1.5 s at 8 kHz, like FL's Default.wav). */
export function defaultImpulse(fs: number): Float32Array[] {
  const n = Math.round(3.4 * fs);
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) {
    let seed = c ? 0x9e3779b9 : 0x2545f491;
    const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1; };
    const x = out[c];
    // diffuse tail: noise with an onset build-up, exponential decay and a darkening low-pass
    let lp1 = 0, lp2 = 0;
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      const onset = t < 0.012 ? 0 : 1 - Math.exp(-(t - 0.012) / 0.018);
      const decay = Math.exp((-6.9078 * t) / 3.3);
      const fc = 1800 + 14000 * Math.exp(-t / 0.55);
      const a = 1 - Math.exp((-2 * Math.PI * fc) / fs);
      lp1 += a * (rnd() - lp1);
      lp2 += a * (lp1 - lp2);
      x[i] = (0.6 * lp1 + 0.4 * lp2) * onset * decay;
    }
    // early reflections
    for (let k = 0; k < 18; k++) {
      const t = 0.006 + 0.07 * Math.pow((k + 0.5 + 0.4 * rnd()) / 18, 1.3);
      const i = Math.round(t * fs);
      if (i < n) x[i] += (0.9 - 0.035 * k) * (rnd() > -0.2 ? 1 : -1) * (0.55 + 0.45 * Math.abs(rnd()));
    }
  }
  // overall level ~ FL's Default.wav (energy per channel ~240 at 44.1 kHz)
  let e = 0;
  for (const x of out) for (let i = 0; i < n; i++) e += x[i] * x[i];
  const g = Math.sqrt((NORM_ENERGY_44K * (fs / 44100)) / (e / 2));
  for (const x of out) for (let i = 0; i < n; i++) x[i] *= g;
  return out;
}

// ------------------------------------------------------------------ impulse rendering

/** In-place FFT convolution / filtering helpers (offline, main thread). */
function fftReal(x: Float32Array, N: number): [Float64Array, Float64Array] {
  const re = new Float64Array(N), im = new Float64Array(N);
  re.set(x.subarray(0, Math.min(x.length, N)));
  getFFT(N).transform(re, im);
  return [re, im];
}

function pow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * The processed impulse at engine rate `fs`. `src` is the pool sample (null = built-in room).
 * `cheap` skips the FFT-heavy steps (self-convolution, equalizer) for the engine's own fallback.
 */
export function renderImpulse(src: { channels: Float32Array[]; sampleRate: number } | null, raw: unknown, fs: number, cheap = false): Float32Array[] {
  const s = irSpec(raw);
  const base = src ?? { channels: defaultImpulse(fs), sampleRate: fs };
  const srcCh = base.channels.length ? base.channels : [new Float32Array(1)];
  let ch = [srcCh[0], srcCh[1] ?? srcCh[0]];
  // trim + reverse
  const len0 = ch[0].length;
  const a = Math.floor(Math.min(s.trimStart, s.trimEnd) * len0), b = Math.max(a + 1, Math.ceil(Math.max(s.trimStart, s.trimEnd) * len0));
  ch = ch.map((c) => {
    const x = Float32Array.from(c.subarray(a, Math.min(len0, b)));
    if (s.reverse) x.reverse();
    return x;
  });
  // stretch (resampling changes length and pitch) to the engine rate
  const ratio = stretchRatio(s.stretch);
  const to = fs * ratio;
  if (Math.abs(to - base.sampleRate) > 1e-6) {
    ch = ch.map((c) => (cheap ? linearResample(c, base.sampleRate, to) : resampleBuffer(c, base.sampleRate, to, 32)));
  }
  const maxLen = Math.round(MAX_IR_SEC * fs);
  if (ch[0].length > maxLen) ch = ch.map((c) => c.subarray(0, maxLen));
  let [L, R] = ch.map((c) => Float32Array.from(c));
  const n = L.length;
  // fades
  const fi = Math.round(s.fadeIn * n), fo = Math.round(s.fadeOut * n);
  for (let i = 0; i < fi; i++) { const g = i / fi; L[i] *= g; R[i] *= g; }
  for (let i = 0; i < fo; i++) { const g = i / fo; L[n - 1 - i] *= g; R[n - 1 - i] *= g; }
  // envelopes: volume, pan, stereo separation, all-purpose (time-varying damping)
  const e = s.env;
  const doVol = !flatEnv(e.vol, 1), doPan = !flatEnv(e.pan, 0.5), doSep = !flatEnv(e.sep, 0.5), doAp = !flatEnv(e.ap, 1);
  if (doVol || doPan || doSep || doAp) {
    let lpL = 0, lpR = 0;
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0;
      let l = L[i], r = R[i];
      if (doAp) {
        const fc = 200 * Math.pow(100, envAt(e.ap, t)); // 200 Hz .. 20 kHz
        const k = 1 - Math.exp((-2 * Math.PI * Math.min(fc, fs * 0.45)) / fs);
        lpL += k * (l - lpL); lpR += k * (r - lpR);
        l = lpL; r = lpR;
      }
      if (doSep) {
        const v = envAt(e.sep, t);
        const w = v < 0.5 ? 1 + (0.5 - v) * 2 : 1 - (v - 0.5) * 2;
        const m = (l + r) * 0.5, sd = (l - r) * 0.5 * w;
        l = m + sd; r = m - sd;
      }
      if (doPan) {
        const v = envAt(e.pan, t);
        l *= Math.min(1, 2 * (1 - v)); r *= Math.min(1, 2 * v);
      }
      if (doVol) { const g = envAt(e.vol, t); l *= g; r *= g; }
      L[i] = l; R[i] = r;
    }
  }
  // self-convolution: the impulse convolved with itself, mixed in at equal energy
  if (!cheap && s.selfConv > 0 && n > 1) {
    const mix = s.selfConv / 1000;
    const N = pow2(2 * n);
    const self = [L, R].map((x) => {
      const [re, im] = fftReal(x, N);
      for (let k = 0; k < N; k++) { const r0 = re[k], i0 = im[k]; re[k] = r0 * r0 - i0 * i0; im[k] = 2 * r0 * i0; }
      getFFT(N).transform(re, im, true);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) y[i] = re[i] / N;
      return y;
    });
    let ex = 0, es = 0;
    for (let i = 0; i < n; i++) { ex += L[i] * L[i] + R[i] * R[i]; es += self[0][i] * self[0][i] + self[1][i] * self[1][i]; }
    const g = es > 0 ? Math.sqrt(ex / es) : 0;
    for (let i = 0; i < n; i++) {
      L[i] = (1 - mix) * L[i] + mix * g * self[0][i];
      R[i] = (1 - mix) * R[i] + mix * g * self[1][i];
    }
  }
  // equalizer (zero-phase, applied to the impulse), balanced with the plain impulse by the EQ knob
  if (!cheap && s.eqMix > 0 && !flatEnv(s.eq, 0.5)) {
    const mix = s.eqMix / 1000;
    const N = pow2(n + 4096);
    const G = new Float64Array(N / 2 + 1);
    for (let k = 0; k <= N / 2; k++) G[k] = eqGain(envAt(s.eq, eqTOfFreq((k * fs) / N)));
    const filt = (x: Float32Array) => {
      const [re, im] = fftReal(x, N);
      for (let k = 0; k <= N / 2; k++) {
        re[k] *= G[k]; im[k] *= G[k];
        if (k > 0 && k < N / 2) { re[N - k] *= G[k]; im[N - k] *= G[k]; }
      }
      getFFT(N).transform(re, im, true);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) y[i] = (1 - mix) * x[i] + (mix * re[i]) / N;
      return y;
    };
    L = filt(L); R = filt(R);
  }
  // loudness normalisation
  if (s.normalize) {
    let en = 0;
    for (let i = 0; i < n; i++) en += L[i] * L[i] + R[i] * R[i];
    if (en > 1e-20) {
      const g = Math.sqrt((NORM_ENERGY_44K * (fs / 44100)) / (en / 2));
      for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
    }
  }
  // pre-delay
  const d = Math.round((convDelayMs(s.delay) / 1000) * fs);
  if (d > 0) {
    const L2 = new Float32Array(n + d), R2 = new Float32Array(n + d);
    L2.set(L, d); R2.set(R, d);
    L = L2; R = R2;
  }
  return [L, R];
}

function linearResample(x: Float32Array, from: number, to: number): Float32Array {
  const ratio = from / to;
  const n = Math.max(1, Math.round(x.length / ratio));
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, j = Math.floor(p), f = p - j;
    y[i] = (x[j] ?? 0) + f * ((x[j + 1] ?? 0) - (x[j] ?? 0));
  }
  return y;
}

// ------------------------------------------------------------------ partitioned convolution

const HEAD = 128;
const LEVELS = [
  { P: 128, start: 128, end: 2048 },
  { P: 1024, start: 2048, end: 16384 },
  { P: 8192, start: 16384, end: Infinity },
];

/** Partition spectra of one level for an impulse (L/R separated, bins 0..P). */
interface LevelIR { K: number; HLr: Float32Array; HLi: Float32Array; HRr: Float32Array; HRi: Float32Array }

/** Runtime state of one FFT level. */
class Level {
  readonly P: number; readonly N: number; readonly B: number; readonly start: number; readonly T: number;
  ir: LevelIR | null = null;
  XLr = new Float32Array(0); XLi = new Float32Array(0); XRr = new Float32Array(0); XRi = new Float32Array(0);
  fdl = 0; // index of the newest spectrum
  re: Float64Array; im: Float64Array;
  YLr: Float64Array; YLi: Float64Array; YRr: Float64Array; YRi: Float64Array;
  outL: Float32Array; outR: Float32Array; nextL: Float32Array; nextR: Float32Array;
  slice = 0;
  constructor(P: number, start: number) {
    this.P = P; this.N = 2 * P; this.B = P + 1; this.start = start; this.T = P / HEAD;
    this.re = new Float64Array(this.N); this.im = new Float64Array(this.N);
    this.YLr = new Float64Array(this.B); this.YLi = new Float64Array(this.B); this.YRr = new Float64Array(this.B); this.YRi = new Float64Array(this.B);
    this.outL = new Float32Array(P); this.outR = new Float32Array(P); this.nextL = new Float32Array(P); this.nextR = new Float32Array(P);
  }
  setIR(ir: LevelIR | null): void {
    this.ir = ir;
    const n = ir ? ir.K * this.B : 0;
    if (this.XLr.length !== n) { this.XLr = new Float32Array(n); this.XLi = new Float32Array(n); this.XRr = new Float32Array(n); this.XRi = new Float32Array(n); }
    else { this.XLr.fill(0); this.XLi.fill(0); this.XRr.fill(0); this.XRi.fill(0); }
    this.outL.fill(0); this.outR.fill(0); this.nextL.fill(0); this.nextR.fill(0);
    this.fdl = 0; this.slice = 0;
  }
}

/** Compute the partition spectra of taps [start, end) for partition size P (one partition per call). */
class LevelBuilder {
  readonly ir: LevelIR;
  readonly P: number;
  readonly start: number;
  readonly L: Float32Array;
  readonly R: Float32Array;
  k = 0;
  private re: Float64Array; private im: Float64Array;
  constructor(P: number, start: number, L: Float32Array, R: Float32Array, end: number) {
    this.P = P; this.start = start; this.L = L; this.R = R;
    const taps = Math.max(0, Math.min(L.length, end) - start);
    const K = Math.ceil(taps / P);
    const B = P + 1;
    this.ir = { K, HLr: new Float32Array(K * B), HLi: new Float32Array(K * B), HRr: new Float32Array(K * B), HRi: new Float32Array(K * B) };
    this.re = new Float64Array(2 * P); this.im = new Float64Array(2 * P);
  }
  get done(): boolean { return this.k >= this.ir.K; }
  /** Returns the FFT size used (work units). */
  step(): number {
    const { P, re, im, L, R } = this;
    const N = 2 * P, B = P + 1, o = this.start + this.k * P;
    re.fill(0); im.fill(0);
    for (let i = 0; i < P; i++) { const j = o + i; if (j < L.length) { re[i] = L[j]; im[i] = R[j]; } }
    getFFT(N).transform(re, im);
    const ir = this.ir, base = this.k * B;
    for (let q = 0; q < B; q++) {
      const nq = q === 0 ? 0 : N - q;
      const ar = re[q], ai = im[q], br = re[nq], bi = -im[nq]; // X[q], conj(X[N-q])
      ir.HLr[base + q] = 0.5 * (ar + br); ir.HLi[base + q] = 0.5 * (ai + bi);
      ir.HRr[base + q] = 0.5 * (ai - bi); ir.HRi[base + q] = -0.5 * (ar - br);
    }
    this.k++;
    return N;
  }
}

interface Prepared { head: Float32Array[]; levels: (LevelIR | null)[]; length: number }

class Convolver implements EffectInstance {
  latency = 0;
  tail = 4;
  private fs: number;
  private env: FxEnv;
  private raw: Record<string, unknown> = {};
  // runtime gains
  private gDry = 1; private gDryT = 1;
  private gWet = 0.0305; private gWetT = 0.0305;
  private inW = 1; private inWT = 1;
  private wetW = 1; private wetWT = 1;
  // impulse
  private wantKey = '';
  private loadedKey = '';
  private building: { key: string; head: Float32Array[]; builders: LevelBuilder[]; length: number } | null = null;
  private pending: Prepared | null = null;
  private pendingKey = '';
  private fade = 1; // wet fade for impulse swaps
  private fadeDir = 0;
  private headL = new Float32Array(HEAD); private headR = new Float32Array(HEAD); // reversed taps
  private hbL = new Float32Array(2 * HEAD); private hbR = new Float32Array(2 * HEAD);
  private hp = 0;
  private levels = LEVELS.map((l) => new Level(l.P, l.start));
  private hist = [new Float32Array(32768), new Float32Array(32768)];
  private hw = 0;
  private tickPos = 0;
  private ticks = 0;
  private irLength = 0;
  // trigger / record
  private trigger = 0;
  private fireClick = false;
  private record = 0;
  private recBuf: Float32Array[] | null = null;
  private recPos = 0;
  private recStarted = false;
  private recQuiet = 0;
  private recDone: Float32Array[] | null = null;
  private peak = 0;
  private seen = false;
  /** Samples waited for the main thread's processed impulse (local fallback after 0.4 s). */
  private waited = 0;

  constructor(fs: number, env: FxEnv) {
    this.fs = fs;
    this.env = env;
    this.setParams({});
  }

  setParams(raw: unknown): void {
    const p = (raw ?? {}) as Record<string, unknown>;
    this.raw = p;
    this.gDryT = convDryGain(num(p.dry, 1000));
    this.gWetT = convWetGain(num(p.wet, 500));
    const sw = (v: number) => 1 - v / 1000; // -1000 -> width 2 (100% separated) .. 1000 -> 0 (100% merged)
    this.inWT = sw(num(p.inSep, 0));
    this.wetWT = sw(num(p.wetSep, 0));
    this.latency = Math.max(0, Math.round(num(p.latency, 0)));
    // trigger / record counters: react to changes after the first state (a loaded project must not fire)
    const trig = num(p.trigger, 0), rec = num(p.record, 0);
    if (this.seen) {
      if (trig > this.trigger) this.fireClick = true;
      if (rec !== this.record) {
        if (rec > this.record) { this.recBuf = [new Float32Array(this.fs * 10), new Float32Array(this.fs * 10)]; this.recPos = 0; this.recStarted = false; this.recQuiet = 0; }
        else this.recBuf = null;
      }
    }
    this.trigger = trig; this.record = rec;
    this.seen = Object.keys(p).length > 0;
    const key = impulseKey(p, this.fs);
    if (key !== this.wantKey) {
      this.wantKey = key;
      this.lookup();
    }
  }

  private satisfied(): boolean {
    const k = this.wantKey;
    return this.loadedKey === k || this.pendingKey === k || (this.building !== null && this.building.key === k);
  }

  /**
   * Find the processed impulse for the wanted key. Until the editor module has
   * sent it, render it ourselves without the FFT-heavy steps: at once when
   * nothing plays yet (or `force`), else after waiting 0.4 s.
   */
  private lookup(force = false): void {
    if (this.satisfied()) return;
    const s = this.env.sample(this.wantKey);
    if (s && s.channels.length) {
      const ch = s.channels.length > 1 ? s.channels : [s.channels[0], s.channels[0]];
      const data = Math.abs(s.sampleRate - this.fs) > 0.5 ? ch.map((c) => linearResample(c, s.sampleRate, this.fs)) : ch;
      this.startBuild(this.wantKey, data[0], data[1]);
      return;
    }
    const local = 'local:' + this.wantKey;
    if (this.loadedKey === local || this.pendingKey === local || this.building?.key === local) return;
    const idle = !this.loadedKey && !this.building && !this.pending;
    if (!force && !idle && this.waited < 0.4 * this.fs) return;
    const spec = irSpec(this.raw);
    const src = spec.impulse ? this.env.sample(spec.impulse) ?? null : null;
    if (spec.impulse && !src && !idle && !force) return;
    const ir = renderImpulse(src, spec.impulse && !src ? { ...this.raw, impulse: null } : this.raw, this.fs, true);
    this.startBuild(local, ir[0], ir[1]);
  }

  private startBuild(key: string, L: Float32Array, R: Float32Array): void {
    const head = [new Float32Array(HEAD), new Float32Array(HEAD)];
    for (let i = 0; i < HEAD; i++) { head[0][HEAD - 1 - i] = L[i] ?? 0; head[1][HEAD - 1 - i] = R[i] ?? 0; }
    const builders = LEVELS.map((l) => new LevelBuilder(l.P, l.start, L, R, l.end));
    this.building = { key, head, builders, length: L.length };
  }

  /** Incremental impulse preparation: about 3 x 16384 FFT points per block. */
  private buildStep(): void {
    const b = this.building;
    if (!b) return;
    let budget = 49152;
    for (const bl of b.builders) {
      while (!bl.done && budget > 0) budget -= bl.step();
      if (budget <= 0) return;
    }
    this.pending = { head: b.head, levels: b.builders.map((x) => (x.ir.K ? x.ir : null)), length: b.length };
    this.pendingKey = b.key;
    this.building = null;
    this.fadeDir = -1; // fade the wet out, swap, fade back in
  }

  private swap(): void {
    const pr = this.pending;
    if (!pr) return;
    this.headL.set(pr.head[0]); this.headR.set(pr.head[1]);
    this.levels.forEach((lv, i) => lv.setIR(pr.levels[i]));
    this.irLength = pr.length;
    this.loadedKey = this.pendingKey;
    this.pending = null;
    this.pendingKey = '';
    this.tail = this.irLength / this.fs + 0.1;
    this.fadeDir = 1;
  }

  reset(): void {
    this.hbL.fill(0); this.hbR.fill(0); this.hp = 0;
    this.hist[0].fill(0); this.hist[1].fill(0); this.hw = 0;
    for (const lv of this.levels) lv.setIR(lv.ir);
    this.tickPos = 0; this.ticks = 0;
    this.gDry = this.gDryT; this.gWet = this.gWetT; this.inW = this.inWT; this.wetW = this.wetWT;
    // finish any preparation now (tests / offline start)
    this.lookup(true);
    while (this.building) this.buildStep();
    if (this.pending) this.swap();
    this.fade = 1; this.fadeDir = 0;
    this.peak = 0;
  }

  /** One level's work for this tick (frames complete every T ticks; work spread over the next frame). */
  private levelTick(lv: Level): void {
    const ir = lv.ir;
    if (!ir) return;
    const T = lv.T, phase = this.ticks % T;
    const K = ir.K, B = lv.B, N = lv.N;
    if (phase === 0) {
      // a frame just completed: publish the previous result, transform the new input window
      if (T > 1) { const tl = lv.outL; lv.outL = lv.nextL; lv.nextL = tl; const tr = lv.outR; lv.outR = lv.nextR; lv.nextR = tr; }
      const { re, im } = lv;
      const hl = this.hist[0], hr = this.hist[1], m = 32767;
      for (let i = 0; i < N; i++) { const j = (this.hw - N + i) & m; re[i] = hl[j]; im[i] = hr[j]; }
      getFFT(N).transform(re, im);
      lv.fdl = (lv.fdl + 1) % K;
      const base = lv.fdl * B;
      for (let q = 0; q < B; q++) {
        const nq = q === 0 ? 0 : N - q;
        const ar = re[q], ai = im[q], br = re[nq], bi = -im[nq];
        lv.XLr[base + q] = 0.5 * (ar + br); lv.XLi[base + q] = 0.5 * (ai + bi);
        lv.XRr[base + q] = 0.5 * (ai - bi); lv.XRi[base + q] = -0.5 * (ar - br);
      }
      lv.YLr.fill(0); lv.YLi.fill(0); lv.YRr.fill(0); lv.YRi.fill(0);
    }
    // multiply-accumulate this tick's share of the partitions
    const k0 = Math.floor((phase * K) / T), k1 = Math.floor(((phase + 1) * K) / T);
    const { YLr, YLi, YRr, YRi, XLr, XLi, XRr, XRi } = lv;
    const { HLr, HLi, HRr, HRi } = ir;
    for (let k = k0; k < k1; k++) {
      const xo = (((lv.fdl - k) % K) + K) % K * B, ho = k * B;
      for (let q = 0; q < B; q++) {
        const xr = XLr[xo + q], xi = XLi[xo + q], hr = HLr[ho + q], hi = HLi[ho + q];
        YLr[q] += xr * hr - xi * hi; YLi[q] += xr * hi + xi * hr;
        const yr = XRr[xo + q], yi = XRi[xo + q], gr = HRr[ho + q], gi = HRi[ho + q];
        YRr[q] += yr * gr - yi * gi; YRi[q] += yr * gi + yi * gr;
      }
    }
    if (phase === T - 1) {
      // inverse transform of YL + i YR: real part = left, imaginary part = right
      const { re, im } = lv;
      for (let q = 0; q < B; q++) {
        re[q] = YLr[q] - YRi[q]; im[q] = YLi[q] + YRr[q];
        if (q > 0 && q < B - 1) { re[N - q] = YLr[q] + YRi[q]; im[N - q] = -YLi[q] + YRr[q]; }
      }
      getFFT(N).transform(re, im, true);
      const dstL = T > 1 ? lv.nextL : lv.outL, dstR = T > 1 ? lv.nextR : lv.outR;
      const inv = 1 / N, P = lv.P;
      for (let i = 0; i < P; i++) { dstL[i] = re[P + i] * inv; dstR[i] = im[P + i] * inv; }
    }
  }

  process(L: Float32Array, R: Float32Array, n: number, _ctx: FxContext): void {
    if (this.satisfied()) this.waited = 0;
    else { this.waited += n; this.lookup(); }
    if (this.building) this.buildStep();
    const fs = this.fs;
    const fadeStep = 1 / (0.01 * fs);
    const inv = 1 / n;
    const d0 = this.gDry, d1 = this.gDryT, w0 = this.gWet, w1 = this.gWetT;
    const i0 = this.inW, i1 = this.inWT, s0 = this.wetW, s1 = this.wetWT;
    const hl = this.hist[0], hr = this.hist[1];
    const hbL = this.hbL, hbR = this.hbR, headL = this.headL, headR = this.headR;
    const [lA, lB, lC] = this.levels;
    let pk = this.peak;
    for (let i = 0; i < n; i++) {
      const t = i * inv;
      const xl0 = L[i], xr0 = R[i];
      // recording (FL: arm, starts at the first sound, stops at silence)
      if (this.recBuf) this.recSample(xl0, xr0);
      // input stereo separation
      const iw = i0 + (i1 - i0) * t;
      const mi = (xl0 + xr0) * 0.5, si = (xl0 - xr0) * 0.5 * iw;
      const xl = mi + si, xr = mi - si;
      // history for the FFT levels and the head
      hl[this.hw] = xl; hr[this.hw] = xr; this.hw = (this.hw + 1) & 32767;
      const hp = this.hp;
      hbL[hp] = xl; hbL[hp + HEAD] = xl; hbR[hp] = xr; hbR[hp + HEAD] = xr;
      this.hp = (hp + 1) & (HEAD - 1);
      // head: taps 0..127 (direct form; window ends with the newest sample)
      let yl = 0, yr = 0;
      const o = hp + 1;
      for (let k = 0; k < HEAD; k++) { yl += headL[k] * hbL[o + k]; yr += headR[k] * hbR[o + k]; }
      // FFT levels
      const tp = this.tickPos;
      yl += lA.outL[tp];
      yr += lA.outR[tp];
      const pB = (this.ticks % lB.T) * HEAD + tp, pC = (this.ticks % lC.T) * HEAD + tp;
      yl += lB.outL[pB] + lC.outL[pC];
      yr += lB.outR[pB] + lC.outR[pC];
      // wet stereo separation, gains, swap fades
      if (this.fadeDir < 0) { this.fade -= fadeStep; if (this.fade <= 0) { this.fade = 0; this.swap(); } }
      else if (this.fadeDir > 0) { this.fade += fadeStep; if (this.fade >= 1) { this.fade = 1; this.fadeDir = 0; } }
      const ww = s0 + (s1 - s0) * t;
      const mw = (yl + yr) * 0.5, sw = (yl - yr) * 0.5 * ww;
      const g = (w0 + (w1 - w0) * t) * this.fade, gd = d0 + (d1 - d0) * t;
      let ol = xl0 * gd + (mw + sw) * g, or = xr0 * gd + (mw - sw) * g;
      if (this.fireClick) { ol += 1; or += 1; this.fireClick = false; }
      L[i] = ol; R[i] = or;
      const a = Math.abs(ol) > Math.abs(or) ? Math.abs(ol) : Math.abs(or);
      if (a > pk) pk = a;
      // tick: every 128 input samples
      this.tickPos = tp + 1;
      if (this.tickPos === HEAD) {
        this.tickPos = 0;
        this.ticks = (this.ticks + 1) % 1048576;
        this.levelTick(lA);
        this.levelTick(lB);
        this.levelTick(lC);
      }
    }
    this.gDry = d1; this.gWet = w1; this.inW = i1; this.wetW = s1;
    this.peak = pk;
  }

  private recSample(l: number, r: number): void {
    const b = this.recBuf!;
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (!this.recStarted) { if (a < 0.001) return; this.recStarted = true; }
    if (this.recPos < b[0].length) { b[0][this.recPos] = l; b[1][this.recPos] = r; this.recPos++; }
    this.recQuiet = a < 0.0001 ? this.recQuiet + 1 : 0;
    if (this.recQuiet > 0.3 * this.fs || this.recPos >= b[0].length) {
      const n = Math.max(1, this.recPos - this.recQuiet);
      this.recDone = [b[0].slice(0, n), b[1].slice(0, n)];
      this.recBuf = null;
    }
  }

  monitor(): FxMonitor {
    const m: FxMonitor = {
      updating: !!this.building || !!this.pending || (this.loadedKey !== this.wantKey && this.loadedKey !== 'local:' + this.wantKey),
      length: this.irLength, peak: this.peak, recording: !!this.recBuf, recStarted: this.recStarted,
    };
    if (this.recDone) { m.recL = this.recDone[0]; m.recR = this.recDone[1]; m.recRate = this.fs; this.recDone = null; }
    this.peak = 0;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'convolver',
  create: (sampleRate, _blockSize, env) => new Convolver(sampleRate, env),
};
