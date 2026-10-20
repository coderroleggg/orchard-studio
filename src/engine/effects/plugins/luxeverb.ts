// LuxeVerb (FL: LuxeVerb). A 16-line feedback delay network calibrated against
// FL's plugin (flfxhost measurements in docs/research/fx/luxeverb.md):
//   input gain -> high cut / low cut (first order) -> pre-delay -> diffusers
//   -> pitch section (feed-forward voices, or the feedback shimmer loop)
//   -> pre-gap (FL's first arrival vs size) -> two common early taps + FDN
//   -> limiter -> peaking EQ (FL's constant-Q poles form) -> width -> wet gain
//   (+ envelope follower modulating the wet gain or the decay) + dry gain.
// FDN: line lengths from FL's first-pass pulses (scaled by size + 5.8),
// character = butterfly rotation angle (0 independent combs, 0.5 Hadamard,
// 1 swapped pairs = "bunching"), always-fractional reads (cubic = HQ, linear
// otherwise, as FL: high frequencies die out in freeze), per-line decay gains
// (RT60 = decay) and brightness shelves (HF RT ratio 0.061 + 0.939 b).

import { getFFT } from '../../dsp/fft';
import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import {
  cut5kHz, decaySec, envLowCutHz, ffDelay2Ms, gainDb, inHighCutHz, peakFreqHz, peakQ, predelayMs,
} from '../../../model/fx/plugins/luxeverb';

const N = 16;
/** Line lengths at size 20 (ms): FL's same-side first-pass pulses (L lines 0..7, R lines 8..15). */
const BASE_MS = [16.7, 28.5, 40.3, 53.8, 62.3, 73.6, 85.1, 96.9, 18.4, 27.7, 45.5, 53.5, 69.3, 80.4, 92.8, 104.6];
/** Fixed fractional parts of the line lengths (FL reads every line fractionally). */
const FRAC = [0.31, 0.12, 0.43, 0.22, 0.05, 0.37, 0.18, 0.47, 0.27, 0.09, 0.4, 0.15, 0.33, 0.03, 0.45, 0.24];
/** Output tap signs (decorrelation). */
const SIGN = [1, -1, 1, 1, -1, 1, -1, -1, 1, 1, -1, 1, -1, -1, 1, -1];
/** Mod LFO rate spread per line. */
const MOD_RATE = [1, 0.93, 1.07, 0.89, 1.11, 0.97, 1.03, 0.91, 1.09, 0.95, 1.05, 0.87, 1.13, 0.99, 1.01, 0.94];
/** FL's first arrival (ms) vs size. */
const GAP_SIZE = [1, 5, 10, 20, 40, 60, 80, 100];
const GAP_MS = [14.27, 14.83, 15.58, 17.29, 21.04, 24.29, 28.02, 32.04];
/** Diffuser allpass gain (the Diffusion knob crossfades to the diffused signal). */
const DIFF_G = 0.7;
/** Echo after each arrival: FL shows a +0.25 copy 0.312 (size + 5.8) ms later. */
const ECHO_G = 0.25;
/** In-loop allpasses (density): gain and length as a fraction of the line. */
const LOOP_AP_G = 0.32;
const LOOP_AP_FRAC = [0.137, 0.113, 0.151, 0.127, 0.109, 0.143, 0.121, 0.133, 0.139, 0.117, 0.147, 0.123, 0.111, 0.141, 0.129, 0.119];
/** Diffuser delays (ms). */
const DIFF_MS = [[1.37, 2.31, 3.79, 5.53], [1.49, 2.53, 3.53, 5.89]];
const MAX_MS = BASE_MS.reduce((a, b) => Math.max(a, b), 0) * (105.8 / 25.8) + 12;
/** Calibrated output normalisation (wet energy vs FL at decay 4 s). */
const OUT_GAIN = 0.3785;
/** Brightness -> high-frequency RT ratio (FL's plateaus). */
const BRIGHT_B = [0, 0.25, 0.5, 0.7, 0.85, 1];
const BRIGHT_R = [0.062, 0.263, 0.51, 0.7, 0.86, 1];
/** Output level correction vs size (wet energy matched to FL at decay 4 s). */
const GC_SIZE = [1, 5, 20, 40, 60, 100];
const GC = [0.984, 0.993, 1.006, 1.082, 1.162, 1.281];
const CROSS = 0.134; // L/R output cross term -> raw correlation 0.26 like FL
/** Delay excursion (ms, peak to peak) at mod amp 1 and size 20; scaled by MOD_SIZE vs size. */
const MOD_DEPTH_MS = 14.5;
const MOD_SIZE_X = [1, 20, 100];
const MOD_SIZE_K = [1.4, 1, 3.8];
const GRAIN_S = 2 / 15; // pitch shifter grain (FL: 15 Hz crossfade rate)
const SHIFT_GAIN = 1.2;
/** FL's feedback loop passes 0.54 x the gain knob (measured with the reverb off). */
const FB_K = 0.54;
const LN1000 = Math.log(1000);
/** Envelope level calibration (FL's envelope of a sine relative to our follower). */
const ENV_CAL_DB = 0;

function sizeFactor(size: number): number {
  return (size + 5.8) / 25.8;
}

function interp(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / (xs[i] - xs[i - 1]);
  }
  return ys[ys.length - 1];
}

function pow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

const flush = (x: number) => (x > 1e-25 || x < -1e-25 ? x : 0);

/** First-order low-pass (bilinear without pre-warping, like FL's input high cut). */
class OnePoleLP {
  b = 1; a = 0; s = 0;
  set(fc: number, fs: number, prewarp = false): void {
    const k = prewarp ? Math.tan(Math.min(Math.PI * fc / fs, 1.55)) : Math.min(Math.PI * fc / fs, 20);
    this.b = k / (1 + k);
    this.a = (1 - k) / (1 + k);
  }
  run(x: number): number {
    const y = this.b * x + this.s;
    this.s = flush(this.b * x + this.a * y);
    return y;
  }
}

/** First-order high-pass (bilinear). */
class OnePoleHP {
  c = 1; p = 0; x1 = 0; y1 = 0;
  set(fc: number, fs: number): void {
    const t = Math.tan(Math.min(Math.PI * fc / fs, 1.55));
    this.p = (1 - t) / (1 + t);
    this.c = (1 + this.p) / 2;
  }
  run(x: number): number {
    const y = this.c * (x - this.x1) + this.p * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

/** Biquad (direct form I) with FL's peaking EQ: H(s) = (s^2 + (K/Q) s + 1) / (s^2 + s/Q + 1). */
class Peak {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  on = false;
  set(f: number, gainDbv: number, q: number, fs: number): void {
    this.on = Math.abs(gainDbv) > 0.01;
    const K = Math.pow(10, gainDbv / 20);
    const w = Math.tan(Math.PI * Math.min(f, fs * 0.45) / fs); // pre-warped: s = (1 - z^-1)/(1 + z^-1) / w
    const iq = 1 / Math.max(0.05, q);
    // s' = s/w: numerator s^2/w^2 + (K/Q) s/w + 1 ... multiply by w^2
    const n0 = 1, n1 = K * iq * w, n2 = w * w;
    const d0 = 1, d1 = iq * w, d2 = w * w;
    // bilinear with s = (1 - z^-1)/(1 + z^-1)
    const A0 = d0 + d1 + d2, A1 = 2 * (d2 - d0), A2 = d0 - d1 + d2;
    const B0 = n0 + n1 + n2, B1 = 2 * (n2 - n0), B2 = n0 - n1 + n2;
    this.b0 = B0 / A0; this.b1 = B1 / A0; this.b2 = B2 / A0; this.a1 = A1 / A0; this.a2 = A2 / A0;
  }
  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = flush(y);
    return y;
  }
  clear(): void { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
}

/** Delay line with fractional reads. */
class Line {
  buf: Float32Array;
  mask: number;
  w = 0;
  constructor(n: number) {
    const s = pow2(Math.max(8, n));
    this.buf = new Float32Array(s);
    this.mask = s - 1;
  }
  push(x: number): void {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }
  /** Value written d samples ago (d >= 1), linear interpolation. */
  lin(d: number): number {
    const di = Math.floor(d), f = d - di;
    const j = this.w - di;
    const a = this.buf[j & this.mask];
    return a + f * (this.buf[(j - 1) & this.mask] - a);
  }
  /** Catmull-Rom cubic read (d >= 2). */
  cub(d: number): number {
    const di = Math.floor(d), f = d - di, m = this.mask, b = this.buf;
    const j = this.w - di;
    const xm1 = b[(j + 1) & m], x0 = b[j & m], x1 = b[(j - 1) & m], x2 = b[(j - 2) & m];
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }
  clear(): void { this.buf.fill(0); }
}

/** Schroeder allpass (input diffuser). */
class Allpass {
  line: Line;
  constructor(n: number) { this.line = new Line(n + 2); }
  run(x: number, d: number, g: number): number {
    const v = this.line.buf[(this.line.w - d) & this.line.mask];
    const w = x + g * v;
    this.line.push(w);
    return v - g * w;
  }
}

/** Granular pitch shifter: two Hann-windowed read heads, FL's 15 Hz crossfade rate. */
class PitchShifter {
  line: Line;
  ph = 0; // 0..1 grain phase of head A
  grain: number; // samples
  constructor(fs: number) {
    this.grain = GRAIN_S * fs;
    this.line = new Line(Math.ceil(this.grain * 2.2) + 8);
  }
  run(x: number, ratio: number): number {
    this.line.push(x);
    if (ratio === 1) return this.line.lin(1);
    const span = Math.abs(1 - ratio) * this.grain; // delay sweep over one grain
    let out = 0;
    for (let h = 0; h < 2; h++) {
      let p = this.ph + h * 0.5;
      if (p >= 1) p -= 1;
      // pitch up: delay shrinks from span to 0; pitch down: grows from 0 to span
      const d = 1.5 + (ratio > 1 ? (1 - p) * span : p * span);
      const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
      out += win * this.line.lin(d);
    }
    this.ph += 1 / this.grain;
    if (this.ph >= 1) this.ph -= 1;
    return out * SHIFT_GAIN; // the two heads add incoherently (FL's voice level is about unity)
  }
  clear(): void { this.line.clear(); this.ph = 0; }
}

interface P {
  inGain: number; inHighCut: number; inLowCut: number; reverbOn: number; decay: number; predelay: number; predelaySync: number;
  brightness: number; character: number; size: number; modFreq: number; modAmp: number; diffusion: number; freeze: number; hq: number;
  pitchOn: number; fbPitch: number; fbDelay: number; fbDelaySync: number; fbGain: number; fbHighCut: number; fbLowCut: number; fbMix: number;
  envScale: number; envThreshold: number; envAttack: number; envDecay: number; envOffset: number; envMode: number; envSidechain: number;
  envLowCut: number; envSmooth: number; dry: number; wet: number; peakFreq: number; peakGain: number; peakQ: number; width: number;
  limiter: number; pitchType: number; ffDirect: number; ffPitch1: number; ffPitch2: number; ffAmp1: number; ffAmp2: number;
  ffDelay1: number; ffDelay1Sync: number; ffDelay2: number; ffDelay2Sync: number;
  predelayT: boolean; fbDelayT: boolean; ff1T: boolean; ff2T: boolean; scInput: number;
}

const DEF: P = {
  inGain: 746, inHighCut: 13336, inLowCut: 547, reverbOn: 1, decay: 9273, predelay: 345, predelaySync: 1, brightness: 704, character: 41,
  size: 61, modFreq: 392, modAmp: 8, diffusion: 567, freeze: 0, hq: 1, pitchOn: 0, fbPitch: 120, fbDelay: 904, fbDelaySync: 192,
  fbGain: 398, fbHighCut: 3117, fbLowCut: 978, fbMix: 779, envScale: 70, envThreshold: -4159, envAttack: 181, envDecay: 602, envOffset: 0,
  envMode: 0, envSidechain: 0, envLowCut: 301, envSmooth: 221, dry: 746, wet: 701, peakFreq: 3218, peakGain: 393, peakQ: 2716, width: 170,
  limiter: 0, pitchType: 1, ffDirect: 1000, ffPitch1: 7, ffPitch2: 12, ffAmp1: 198, ffAmp2: 102, ffDelay1: 1000, ffDelay1Sync: 1,
  ffDelay2: 1000, ffDelay2Sync: 1, predelayT: false, fbDelayT: false, ff1T: true, ff2T: true, scInput: 1,
};

const dbg = (db: number) => (db <= -60 ? 0.001 : Math.pow(10, db / 20));
const SPEC_N = 1024;
const SPEC_BANDS = 64;

class LuxeVerb implements EffectInstance {
  latency = 0;
  tail = 5;
  private fs: number;
  private p: P = { ...DEF };
  private tempo = 130;
  private fresh = true;

  // input stage
  private hcL = new OnePoleLP(); private hcR = new OnePoleLP();
  private lcL = new OnePoleHP(); private lcR = new OnePoleHP();
  private pdL: Line; private pdR: Line;
  private pdCur = 0; private pdTgt = 0;
  private diff: Allpass[][] = [[], []];
  private diffLen: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0]];
  private gDiff = 0; private gDiffT = 0;
  // pitch section
  private fbShift: PitchShifter[];
  private fbLine: Line[];
  private fbHC = [new OnePoleLP(), new OnePoleLP()];
  private fbLC = [new OnePoleHP(), new OnePoleHP()];
  private fbOut = [0, 0];
  private fbDelCur = 0; private fbDelTgt = 0;
  private ffShift: PitchShifter[];
  private ffLine: Line[];
  private ffDelCur = [0, 0]; private ffDelTgt = [0, 0];
  // pre-gap + early taps
  private gapL: Line; private gapR: Line;
  private gap = 0; private gapT = 0;
  private early2 = 0; private early2T = 0;
  private eGain = 0; private eGainT = 0;
  // FDN
  private echoL: Line; private echoR: Line;
  private echoD = 0; private echoDT = 0;
  private lap: Line[] = [];
  private lapLen = new Float64Array(N);
  private lines: Line[] = [];
  private lenCur = new Float64Array(N);
  private lenTgt = new Float64Array(N);
  private g = new Float64Array(N); // per-line decay gain (smoothed)
  private gT = new Float64Array(N);
  private shB0 = new Float64Array(N); private shB1 = new Float64Array(N); private shA1 = new Float64Array(N);
  private shX = new Float64Array(N); private shY = new Float64Array(N);
  private y = new Float64Array(N);
  private modPh = new Float64Array(N);
  private md0 = new Float64Array(N);
  private md1 = new Float64Array(N);
  private cosT = Math.SQRT1_2; private sinT = Math.SQRT1_2;
  private outGain = 1; private outGainT = 1;
  private inMute = 1; // freeze: input to the reverb fades out
  private frozen = 0; // 0 normal, 1 freeze, 2 sustain
  private decayEff = 3; // seconds, incl. envelope modulation
  // output
  private peakL = new Peak(); private peakR = new Peak();
  private limEnv = 0; private limGain = 1;
  private gWet = 1; private gDry = 1; private width = 1.25;
  // envelope follower
  private envHP = new OnePoleHP();
  private envSm = 0; private env = 0;
  private envDb = -120;
  private modDb = 0;
  // monitor
  private specBuf = new Float32Array(SPEC_N);
  private specW = 0;
  private specRe = new Float64Array(SPEC_N);
  private specIm = new Float64Array(SPEC_N);
  private spec = new Float32Array(SPEC_BANDS);
  private outPkL = 0; private outPkR = 0;
  private limiting = false;

  constructor(fs: number) {
    this.fs = fs;
    const ms = (x: number) => Math.ceil((x / 1000) * fs);
    this.pdL = new Line(ms(520) + 4); this.pdR = new Line(ms(520) + 4);
    for (let c = 0; c < 2; c++) for (let k = 0; k < 4; k++) this.diff[c].push(new Allpass(ms(DIFF_MS[c][k] * 2.1) + 4));
    this.fbShift = [new PitchShifter(fs), new PitchShifter(fs)];
    this.fbLine = [new Line(ms(4100)), new Line(ms(4100))];
    this.ffShift = [0, 1, 2, 3].map(() => new PitchShifter(fs));
    this.ffLine = [0, 1, 2, 3].map(() => new Line(ms(4100)));
    this.gapL = new Line(ms(60)); this.gapR = new Line(ms(60));
    this.echoL = new Line(ms(36)); this.echoR = new Line(ms(36));
    const modMax = ms(MOD_DEPTH_MS * 3.8 * 1.1) + 8;
    for (let i = 0; i < N; i++) {
      this.lines.push(new Line(ms(MAX_MS) + modMax));
      this.lap.push(new Line(ms(MAX_MS * 0.16) + 4));
      this.modPh[i] = (i / N) * Math.PI * 2;
    }
    this.compute();
    this.snap();
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    const p = this.p as unknown as Record<string, number | boolean>;
    for (const k of Object.keys(DEF) as (keyof P)[]) {
      const d = DEF[k];
      const v = q[k];
      if (typeof d === 'boolean') p[k] = v === undefined ? d : !!v;
      else p[k] = typeof v === 'number' && Number.isFinite(v) ? v : d;
    }
    this.compute();
  }

  private syncSec(ticks: number): number {
    return (ticks / 192) * (60 / Math.max(10, this.tempo));
  }

  /** Derived targets (on edits and tempo changes). */
  private compute(): void {
    const p = this.p, fs = this.fs;
    this.hcL.set(inHighCutHz(p.inHighCut), fs); this.hcR.set(inHighCutHz(p.inHighCut), fs);
    this.lcL.set(cut5kHz(p.inLowCut), fs); this.lcR.set(cut5kHz(p.inLowCut), fs);
    const pdSec = p.predelayT ? this.syncSec(p.predelaySync) : predelayMs(p.predelay) / 1000;
    this.pdTgt = Math.min(Math.round(pdSec * fs), this.pdL.mask - 4);
    const D = p.diffusion / 1000;
    this.gDiffT = D;
    const sf = sizeFactor(Math.min(100, Math.max(1, p.size)));
    const dsc = Math.sqrt(sf);
    for (let c = 0; c < 2; c++) for (let k = 0; k < 4; k++) {
      this.diffLen[c][k] = Math.max(1, Math.min(this.diff[c][k].line.mask - 2, Math.round((DIFF_MS[c][k] * Math.min(2, dsc) / 1000) * fs)));
    }
    this.gapT = (interp(GAP_SIZE, GAP_MS, p.size) / 1000) * fs;
    this.early2T = ((0.2438 * (p.size + 8.3)) / 1000) * fs;
    this.eGainT = 0.108 * Math.pow(sf, 0.64);
    for (let i = 0; i < N; i++) {
      const full = (BASE_MS[i] * sf / 1000) * fs;
      this.lapLen[i] = Math.max(1, Math.round(full * LOOP_AP_FRAC[i]));
      this.lenTgt[i] = Math.max(4, Math.round(full - this.lapLen[i])) + FRAC[i];
    }
    this.echoDT = Math.min(this.echoL.mask - 4, ((0.312 * (p.size + 5.8)) / 1000) * fs);
    this.outGainT = OUT_GAIN * Math.pow(sf, 0.519) * interp(GC_SIZE, GC, p.size);
    const th = (Math.min(100, Math.max(0, p.character)) / 100) * (Math.PI / 2);
    this.cosT = Math.cos(th); this.sinT = Math.sin(th);
    this.frozen = Math.round(Math.min(2, Math.max(0, p.freeze)));
    this.peakL.set(peakFreqHz(p.peakFreq), p.peakGain / 100, peakQ(p.peakQ), fs);
    this.peakR.set(peakFreqHz(p.peakFreq), p.peakGain / 100, peakQ(p.peakQ), fs);
    this.width = p.width / 100;
    this.gDry = dbg(gainDb(p.dry));
    this.fbHC[0].set(cut5kHz(p.fbHighCut), fs, true); this.fbHC[1].set(cut5kHz(p.fbHighCut), fs, true);
    this.fbLC[0].set(cut5kHz(p.fbLowCut), fs); this.fbLC[1].set(cut5kHz(p.fbLowCut), fs);
    const fbSec = p.fbDelayT ? this.syncSec(p.fbDelaySync) : p.fbDelay / 10000;
    this.fbDelTgt = Math.min(this.fbLine[0].mask - 4, Math.max(1, fbSec * fs));
    const f1 = p.ff1T ? this.syncSec(p.ffDelay1Sync) : p.ffDelay1 / 10000;
    const f2 = p.ff2T ? this.syncSec(p.ffDelay2Sync) : ffDelay2Ms(p.ffDelay2) / 1000;
    this.ffDelTgt[0] = Math.min(this.ffLine[0].mask - 4, Math.max(1, f1 * fs));
    this.ffDelTgt[1] = Math.min(this.ffLine[0].mask - 4, Math.max(1, f2 * fs));
    this.envHP.set(envLowCutHz(p.envLowCut), fs);
    this.decayCoefs(decaySec(p.decay));
    const T = decaySec(p.decay);
    const tMax = p.envMode === 2 && p.envScale > 0 ? 20 : T;
    this.tail = this.frozen ? Infinity : pdSec + 1.3 * tMax + 0.6
      + (p.pitchOn >= 0.5 && p.pitchType < 0.5 ? (fbSec + 0.2) * (1 + 12 * (p.fbGain / 1000)) : 0)
      + (p.pitchOn >= 0.5 && p.pitchType >= 0.5 ? Math.max(f1, f2) + 0.2 : 0);
  }

  /** Per-line decay gains and brightness shelves for decay time T (seconds). */
  private decayCoefs(T: number): void {
    const p = this.p, fs = this.fs;
    this.decayEff = T;
    const frozen = this.frozen !== 0;
    const r = interp(BRIGHT_B, BRIGHT_R, Math.min(1000, Math.max(0, p.brightness)) / 1000);
    const fm = 2000 + 700 * (1 - r) * (1 - r) * (1 - r);
    for (let i = 0; i < N; i++) {
      const L = this.lenTgt[i] + this.lapLen[i]; // loop length incl. the in-loop allpass
      this.gT[i] = frozen ? 1 : Math.exp((-LN1000 * L) / (T * fs));
      let A = frozen ? 0 : ((60 * L) / (T * fs)) * (1 / r - 1);
      A = Math.min(A, 48);
      if (A < 1e-4) { this.shB0[i] = 1; this.shB1[i] = 0; this.shA1[i] = 0; continue; }
      const fz = Math.min(fm * Math.pow(10, A / 40), fs * 0.48), fp = fm * Math.pow(10, -A / 40);
      const wz = Math.tan((Math.PI * fz) / fs), wp = Math.tan((Math.PI * fp) / fs);
      const k = wp / wz;
      this.shB0[i] = (k * (1 + wz)) / (1 + wp);
      this.shB1[i] = (k * (wz - 1)) / (1 + wp);
      this.shA1[i] = (wp - 1) / (1 + wp);
    }
  }

  private snap(): void {
    this.pdCur = this.pdTgt; this.gDiff = this.gDiffT; this.echoD = this.echoDT; this.gap = this.gapT; this.early2 = this.early2T; this.eGain = this.eGainT;
    this.outGain = this.outGainT;
    for (let i = 0; i < N; i++) { this.lenCur[i] = this.lenTgt[i]; this.g[i] = this.gT[i]; }
    this.fbDelCur = this.fbDelTgt; this.ffDelCur[0] = this.ffDelTgt[0]; this.ffDelCur[1] = this.ffDelTgt[1];
    const p = this.p;
    this.gWet = dbg(gainDb(p.wet));
    this.inMute = this.frozen === 1 ? 0 : 1;
  }

  reset(): void {
    for (const l of this.lines) l.clear();
    for (const l of this.lap) l.clear();
    this.echoL.clear(); this.echoR.clear();
    this.pdL.clear(); this.pdR.clear(); this.gapL.clear(); this.gapR.clear();
    for (const c of this.diff) for (const a of c) a.line.clear();
    for (const s of this.fbShift) s.clear();
    for (const s of this.ffShift) s.clear();
    for (const l of this.fbLine) l.clear();
    for (const l of this.ffLine) l.clear();
    for (const f of [this.hcL, this.hcR, ...this.fbHC]) f.s = 0;
    for (const f of [this.lcL, this.lcR, ...this.fbLC, this.envHP]) { f.x1 = 0; f.y1 = 0; }
    this.peakL.clear(); this.peakR.clear();
    this.shX.fill(0); this.shY.fill(0); this.y.fill(0);
    this.fbOut[0] = this.fbOut[1] = 0;
    this.limEnv = 0; this.limGain = 1; this.envSm = 0; this.env = 0; this.envDb = -120; this.modDb = 0;
    for (let i = 0; i < N; i++) this.modPh[i] = (i / N) * Math.PI * 2;
    this.specBuf.fill(0); this.outPkL = this.outPkR = 0;
    this.fresh = true;
    this.decayCoefs(decaySec(this.p.decay));
    this.snap();
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    const p = this.p, fs = this.fs;
    if (ctx.tempo !== this.tempo && (p.predelayT || p.fbDelayT || p.ff1T || p.ff2T)) {
      this.tempo = ctx.tempo;
      this.compute();
      if (this.fresh) this.snap();
    }
    this.fresh = false;
    // ---- per-block smoothing
    const a20 = 1 - Math.exp(-n / (0.02 * fs));
    const a60 = 1 - Math.exp(-n / (0.06 * fs));
    const a300 = 1 - Math.exp(-n / (0.3 * fs));
    this.gDiff += (this.gDiffT - this.gDiff) * a20;
    this.eGain += (this.eGainT - this.eGain) * a20;
    this.outGain += (this.outGainT - this.outGain) * a20;
    this.gap += (this.gapT - this.gap) * a60;
    this.echoD += (this.echoDT - this.echoD) * a60;
    this.early2 += (this.early2T - this.early2) * a60;
    for (let i = 0; i < N; i++) {
      const d = this.lenTgt[i] - this.lenCur[i];
      if (d !== 0) this.lenCur[i] = Math.abs(d) < 0.01 ? this.lenTgt[i] : this.lenCur[i] + d * a60;
    }
    this.pdCur += (this.pdTgt - this.pdCur) * a300;
    if (Math.abs(this.pdTgt - this.pdCur) < 0.5) this.pdCur = this.pdTgt;
    this.fbDelCur += (this.fbDelTgt - this.fbDelCur) * a300;
    this.ffDelCur[0] += (this.ffDelTgt[0] - this.ffDelCur[0]) * a300;
    this.ffDelCur[1] += (this.ffDelTgt[1] - this.ffDelCur[1]) * a300;
    const muteT = this.frozen === 1 ? 0 : 1;
    const mute0 = this.inMute, mute1 = mute0 + (muteT - mute0) * Math.min(1, n / (0.02 * fs));
    this.inMute = mute1;

    // ---- envelope follower (block-rate output, sample-rate detection)
    const envMode = Math.round(p.envMode);
    const envOn = envMode > 0;
    let envSrcL: Float32Array = L, envSrcR: Float32Array = R;
    if (envOn && p.envSidechain >= 0.5) {
      const sc = ctx.sidechain[Math.max(0, Math.round(p.scInput) - 1)];
      if (sc) { envSrcL = sc.L; envSrcR = sc.R; }
    }
    const aSm = 1 - Math.exp(-1 / (Math.max(0.0005, p.envSmooth / 10000) * fs));
    const aAt = 1 - Math.exp(-1 / ((0.03 + 0.61 * (p.envAttack / 1000)) * fs));
    const aRe = 1 - Math.exp(-1 / ((0.0334 + 0.445 * (p.envDecay / 1000)) * fs));
    let sm = this.envSm, env = this.env;
    for (let i = 0; i < n; i++) {
      const x = this.envHP.run((envSrcL[i] + envSrcR[i]) * 0.5);
      const r = x < 0 ? -x : x;
      env += (r - env) * (r > env ? aAt : aRe); // attack / decay follower on the rectified input
      sm += (env - sm) * aSm; // then smoothing
    }
    this.envSm = flush(sm); this.env = flush(env);
    this.envDb = 20 * Math.log10(sm + 1e-9) + ENV_CAL_DB;
    const over = Math.max(0, this.envDb - p.envThreshold / 100);
    const scale = p.envScale / 1000;
    let wetDb = gainDb(p.wet);
    this.modDb = 0;
    if (envMode === 1) {
      this.modDb = scale * (2 * over - 78.4 * ((p.envOffset - 50) / 100));
      wetDb = Math.min(15, Math.max(-60, wetDb + this.modDb));
    }
    const T0 = decaySec(p.decay);
    const Tm = envMode === 2 ? Math.min(20, Math.max(0.25, T0 + scale * 0.94 * over)) : T0;
    if (Math.abs(Tm - this.decayEff) > 1e-4) this.decayCoefs(Tm);
    for (let i = 0; i < N; i++) this.g[i] += (this.gT[i] - this.g[i]) * a20;
    const gw0 = this.gWet, gw1 = dbg(wetDb);
    this.gWet = gw1;

    // ---- constants for the sample loop
    const inG = dbg(gainDb(p.inGain));
    const gDiff = this.gDiff;
    const dl0 = this.diffLen[0], dl1 = this.diffLen[1];
    const dA = this.diff[0], dB = this.diff[1];
    const pitchOn = p.pitchOn >= 0.5;
    const ffMode = pitchOn && p.pitchType >= 0.5;
    const fbMode = pitchOn && !ffMode;
    const reverbOn = p.reverbOn >= 0.5;
    const fbGain = FB_K * (p.fbGain / 1000), fbMix = p.fbMix / 1000;
    const fbRatio = Math.pow(2, p.fbPitch / 120);
    const ffDirect = p.ffDirect / 1000, ffA1 = p.ffAmp1 / 1000, ffA2 = p.ffAmp2 / 1000;
    const ffR1 = Math.pow(2, p.ffPitch1 / 12), ffR2 = Math.pow(2, p.ffPitch2 / 12);
    const gap = Math.max(2, this.gap), e2 = gap + Math.max(1, this.early2);
    const eG = this.eGain * mute1, oG = this.outGain;
    const hq = p.hq >= 0.5;
    const c = this.cosT, s = this.sinT;
    const modAmp = 0.5 * Math.pow(Math.max(0, p.modAmp) / 100, 0.7) * (MOD_DEPTH_MS / 1000) * fs * interp(MOD_SIZE_X, MOD_SIZE_K, p.size);
    const modW = (2 * Math.PI * Math.max(0.0001, p.modFreq / 1000)) / fs;
    const lines = this.lines, y = this.y, g = this.g, len = this.lenCur, ph = this.modPh;
    const lap = this.lap, lapLen = this.lapLen, echoD = Math.max(1, this.echoD);
    // modulation offsets at the block start / end (LFOs <= 1 Hz: linear within the block)
    const modOn = modAmp > 0;
    const md0 = this.md0, md1 = this.md1;
    if (modOn) {
      for (let k = 0; k < N; k++) {
        md0[k] = modAmp * (1 + Math.sin(ph[k]));
        ph[k] += modW * MOD_RATE[k] * n;
        if (ph[k] > 6.283185307179586) ph[k] -= 6.283185307179586;
        md1[k] = modAmp * (1 + Math.sin(ph[k]));
      }
    }
    const b0 = this.shB0, b1 = this.shB1, a1 = this.shA1, sx = this.shX, sy = this.shY;
    const limOn = p.limiter >= 0.5;
    const thrLim = Math.pow(10, -11 / 20);
    const aLimAtt = 1 - Math.exp(-1 / (0.005 * fs)), aLimRel = 1 - Math.exp(-1 / (0.15 * fs));
    const aDet = 1 - Math.exp(-1 / (0.02 * fs));
    let limEnv = this.limEnv, limGain = this.limGain, limMin = 1;
    const w = this.width, gD = this.gDry;
    const pd = this.pdCur;
    const inv = 1 / n;
    let pkL = this.outPkL, pkR = this.outPkR;
    const fbD = this.fbDelCur, ffD1 = this.ffDelCur[0], ffD2 = this.ffDelCur[1];

    for (let i = 0; i < n; i++) {
      const t = i * inv;
      const xl0 = L[i], xr0 = R[i];
      // input stage
      let xl = this.lcL.run(this.hcL.run(xl0 * inG));
      let xr = this.lcR.run(this.hcR.run(xr0 * inG));
      this.pdL.push(xl); this.pdR.push(xr);
      if (pd >= 1) { xl = this.pdL.lin(pd); xr = this.pdR.lin(pd); }
      if (reverbOn) {
        // FL "mixes in" the diffusers: crossfade between the plain and the fully diffused input
        let ul = xl, ur = xr;
        for (let k = 0; k < 4; k++) { ul = dA[k].run(ul, dl0[k], DIFF_G); ur = dB[k].run(ur, dl1[k], DIFF_G); }
        xl += (ul - xl) * gDiff; xr += (ur - xr) * gDiff;
      }
      // pitch section
      let cl = xl, cr = xr;
      if (ffMode) {
        const fl = this.ffLine, fsh = this.ffShift;
        fl[0].push(fsh[0].run(xl, ffR1)); fl[1].push(fsh[1].run(xr, ffR1));
        fl[2].push(fsh[2].run(xl, ffR2)); fl[3].push(fsh[3].run(xr, ffR2));
        cl = ffDirect * xl + ffA1 * fl[0].lin(ffD1) + ffA2 * fl[2].lin(ffD2);
        cr = ffDirect * xr + ffA1 * fl[1].lin(ffD1) + ffA2 * fl[3].lin(ffD2);
      } else if (fbMode) {
        cl += this.fbOut[0];
        cr += this.fbOut[1];
      }
      // reverb
      let rl: number, rr: number;
      if (reverbOn) {
        let inL = cl * mute1, inR = cr * mute1;
        this.echoL.push(inL); this.echoR.push(inR);
        inL += ECHO_G * this.echoL.lin(echoD); inR += ECHO_G * this.echoR.lin(echoD);
        this.gapL.push(inL); this.gapR.push(inR);
        const gl = this.gapL.lin(gap), gr = this.gapR.lin(gap);
        const mono = (gl + gr) * 0.5 + (this.gapL.lin(e2) + this.gapR.lin(e2)) * 0.5;
        // read lines
        let oL = 0, oR = 0;
        for (let k = 0; k < N; k++) {
          const d = len[k] + (modOn ? md0[k] + (md1[k] - md0[k]) * t : 0);
          let v = hq ? lines[k].cub(d) : lines[k].lin(d);
          { // in-loop allpass (density)
            const ap = lap[k], ad = lapLen[k];
            const av = ap.buf[(ap.w - ad) & ap.mask];
            const aw = v + LOOP_AP_G * av;
            ap.push(aw);
            v = av - LOOP_AP_G * aw;
          }
          // brightness shelf, then decay gain
          const sh = b0[k] * v + b1[k] * sx[k] - a1[k] * sy[k];
          sx[k] = v; sy[k] = flush(sh);
          v = sh * g[k];
          y[k] = v;
          if (k < 8) { oL += SIGN[k] * v; oR += CROSS * SIGN[k] * v; }
          else { oR += SIGN[k] * v; oL += CROSS * SIGN[k] * v; }
        }
        // mixing: 4 butterfly stages (rotation by the character angle)
        for (let span = 1; span < N; span <<= 1) {
          for (let k = 0; k < N; k++) {
            if (k & span) continue;
            const u = y[k], v = y[k + span];
            y[k] = c * u + s * v;
            y[k + span] = c * v - s * u;
          }
        }
        // inject (L lines 0..7, R lines 8..15) and write
        const il = gl * 0.5, ir = gr * 0.5;
        for (let k = 0; k < N; k++) lines[k].push(flush(y[k] + (k < 8 ? il : ir)));
        rl = oG * oL + eG * mono;
        rr = oG * oR + eG * mono;
      } else {
        rl = cl; rr = cr;
      }
      // feedback shimmer loop: mix of reverb out and reverb in -> filters -> pitch -> delay -> gain
      if (fbMode) {
        for (let ch = 0; ch < 2; ch++) {
          const src = ch === 0 ? fbMix * rl + (1 - fbMix) * cl : fbMix * rr + (1 - fbMix) * cr;
          let f = this.fbLC[ch].run(this.fbHC[ch].run(src));
          f = this.fbShift[ch].run(f, fbRatio);
          this.fbLine[ch].push(f);
          let o = this.fbLine[ch].lin(fbD) * fbGain;
          if (o > 2 || o < -2) o = Math.tanh(o * 0.5) * 2; // keep a runaway loop finite
          this.fbOut[ch] = flush(o);
        }
      }
      // limiter (RMS detector, -11 dBFS)
      if (limOn) {
        const pw = (rl * rl + rr * rr) * 0.5;
        limEnv += (pw - limEnv) * aDet;
        const rmsv = Math.sqrt(limEnv);
        const want = rmsv > thrLim ? thrLim / rmsv : 1;
        limGain += (want - limGain) * (want < limGain ? aLimAtt : aLimRel);
        rl *= limGain; rr *= limGain;
        if (limGain < limMin) limMin = limGain;
      }
      // peak EQ, width, wet gain
      if (this.peakL.on) { rl = this.peakL.run(rl); rr = this.peakR.run(rr); }
      const m = (rl + rr) * 0.5, sd = (rl - rr) * 0.5 * w;
      const gw = gw0 + (gw1 - gw0) * t;
      rl = (m + sd) * gw; rr = (m - sd) * gw;
      const ol = xl0 * gD + rl, or = xr0 * gD + rr;
      L[i] = ol; R[i] = or;
      this.specBuf[this.specW] = (rl + rr) * 0.5;
      this.specW = (this.specW + 1) & (SPEC_N - 1);
      const al = ol < 0 ? -ol : ol, ar = or < 0 ? -or : or;
      if (al > pkL) pkL = al;
      if (ar > pkR) pkR = ar;
    }
    this.limEnv = flush(limEnv); this.limGain = limGain;
    if (limMin < 0.94) this.limiting = true;
    this.outPkL = pkL; this.outPkR = pkR;
  }

  monitor(): FxMonitor {
    // spectrum of the wet output: 64 log bands, 30 Hz .. 20 kHz
    const re = this.specRe, im = this.specIm, b = this.specBuf, w0 = this.specW;
    for (let i = 0; i < SPEC_N; i++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SPEC_N);
      re[i] = b[(w0 + i) & (SPEC_N - 1)] * win;
      im[i] = 0;
    }
    getFFT(SPEC_N).transform(re, im);
    const binHz = this.fs / SPEC_N;
    for (let k = 0; k < SPEC_BANDS; k++) {
      const f0 = 30 * Math.pow(20000 / 30, k / SPEC_BANDS), f1 = 30 * Math.pow(20000 / 30, (k + 1) / SPEC_BANDS);
      const i0 = Math.max(1, Math.floor(f0 / binHz)), i1 = Math.min(SPEC_N / 2 - 1, Math.max(i0, Math.floor(f1 / binHz)));
      let e = 0;
      for (let i = i0; i <= i1; i++) e = Math.max(e, re[i] * re[i] + im[i] * im[i]);
      this.spec[k] = 10 * Math.log10(e / (SPEC_N * SPEC_N * 0.0625) + 1e-12);
    }
    const p = this.p;
    const m: FxMonitor = {
      env: this.envDb, thr: p.envThreshold / 100, wetDb: Math.max(-60, Math.min(15, gainDb(p.wet) + (Math.round(p.envMode) === 1 ? this.modDb : 0))),
      decay: this.decayEff, mode: Math.round(p.envMode), peakL: this.outPkL, peakR: this.outPkR, limiting: this.limiting,
      spec: Float32Array.from(this.spec),
    };
    this.outPkL = this.outPkR = 0;
    this.limiting = false;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'luxeverb',
  create: (sampleRate) => new LuxeVerb(sampleRate),
};
