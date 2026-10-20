// Multiband Delay (FL: Multiband Delay, engine by Daniel Schaack). Measured on
// FL's binary (docs/research/fx/mbdelay.md):
//   16-band split, crossovers T = 31, 47, 71, ..., 12654 Hz (band 16 up to 19 kHz):
//     Gentle  - band 1 LP1, bands 2..15 0.5 HP1 x LP1 at 1.0886 T (a Q 0.5 band-pass at -12 dB),
//               band 16 HP1 x AP1^2
//     Steep   - sqrt(2) LR8 band-passes (LR8 LP at T[k], LR8 HP at T[k-1]), band 16 also AP_LR8(19 kHz)^2
//     Linear  - 1023-tap linear-phase FIRs (2048-bin brick-wall bands, sine window) by FFT
//               overlap-save; latency 1536 samples
//   per band: delay line (1 sample minimum) with feedback 0.95 x fb (Weighting: a decay rate in
//   dB/s instead), smoothed delay changes (Smoothing time: 90 % in that time) or, with Keep pitch,
//   100 ms crossfades between taps; Harmonic scale: loop of sr / (C3 2^(4 (scale + delay))) samples;
//   volume curve, constant-power balance
//   wet sum -> 1st-order high-pass -> Comp / Sat (tanh) / Clip -> linear dry/wet mix.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';

const NB = 16;
const ONE = 1073741824;
const T = [31, 47, 71, 112, 172, 264, 413, 624, 958, 1502, 2266, 3611, 5456, 8395, 12660, 19000];
const GENTLE_RATIO = 1.0886;
const C3 = 130.8128;
/** Weighting: decay time T60 (s) at 0.95 x feedback = 0, 0.2, ..., 1 (linear in between; delays count as >= 1 ms). */
const W_T60 = [0, 0.06, 0.3, 1.5, 7.5, 30];
const XFADE_SEC = 0.1; // Keep pitch crossfade
/** Comp: per channel, cubic-mean level detector (fitted to FL: a steady sine settles at a 1.14 peak). */
const COMP_TARGET = 0.8368;
const COMP_DET_SEC = 0.0174;
const COMP_ATT_SEC = 0.0013;
const COMP_REL_DB_S = 177;
/** Linear phase: FFT overlap-save. */
const LP_N = 2048;
const LP_HOP = 1024;
const LP_TAPS = 1023;
const HIST_CHUNK_SEC = 0.01;
const HIST_LEN = 64;

function volGain(x: number): number {
  const v = Math.min(1, Math.max(0, x));
  return v * (0.24719 + v * (-0.23133 + v * 0.98414));
}

function wT60(g0: number): number {
  const x = Math.min(1, Math.max(0, g0)) * 5, i = Math.min(4, Math.floor(x));
  return W_T60[i] + (W_T60[i + 1] - W_T60[i]) * (x - i);
}

// ---------------------------------------------------------------------------
// filters (coefficients in flat arrays: b0 b1 b2 a1 a2)

function setBiquad(c: Float64Array, o: number, b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): void {
  c[o] = b0 / a0; c[o + 1] = b1 / a0; c[o + 2] = b2 / a0; c[o + 3] = a1 / a0; c[o + 4] = a2 / a0;
}
/** Butterworth-type 2nd order (bilinear, prewarped) with quality Q: kind 0 LP, 1 HP, 2 AP. */
function bw2(c: Float64Array, o: number, f: number, sr: number, Q: number, kind: number): void {
  const K = Math.tan((Math.PI * Math.min(f, 0.49 * sr)) / sr), K2 = K * K;
  const a0 = 1 + K / Q + K2, a1 = 2 * (K2 - 1), a2 = 1 - K / Q + K2;
  if (kind === 0) setBiquad(c, o, K2, 2 * K2, K2, a0, a1, a2);
  else if (kind === 1) setBiquad(c, o, 1, -2, 1, a0, a1, a2);
  else setBiquad(c, o, a2, a1, a0, a0, a1, a2);
}
/** First order as a biquad: kind 0 LP, 1 HP, 2 AP. */
function first(c: Float64Array, o: number, f: number, sr: number, kind: number): void {
  const K = Math.tan((Math.PI * Math.min(f, 0.49 * sr)) / sr);
  if (kind === 0) setBiquad(c, o, K, K, 0, 1 + K, K - 1, 0);
  else if (kind === 1) setBiquad(c, o, 1, -1, 0, 1 + K, K - 1, 0);
  else setBiquad(c, o, K - 1, 1 + K, 0, 1 + K, K - 1, 0);
}
/** RBJ band-pass (0 dB peak) times g. */
function bandpass(c: Float64Array, o: number, f: number, sr: number, Q: number, g: number): void {
  const w0 = (2 * Math.PI * Math.min(f, 0.49 * sr)) / sr, al = Math.sin(w0) / (2 * Q);
  setBiquad(c, o, g * al, 0, -g * al, 1 + al, -2 * Math.cos(w0), 1 - al);
}

const Q4A = 0.5411961, Q4B = 1.3065630; // 4th-order Butterworth sections

/**
 * IIR filterbank: up to 8 biquads per band, per channel. `n[k]` sections for band k, `g[k]` gain.
 */
class IirBank {
  c: Float64Array;
  z: Float64Array; // [ch][band][sec][2]
  n = new Int32Array(NB);
  g = new Float64Array(NB);
  constructor() {
    this.c = new Float64Array(NB * 8 * 5);
    this.z = new Float64Array(2 * NB * 8 * 2);
  }
  clear(): void { this.z.fill(0); }
  design(mode: number, sr: number): void {
    const c = this.c;
    if (mode === 0) {
      for (let k = 0; k < NB; k++) {
        const f = T[k] * GENTLE_RATIO, o = k * 40;
        if (k === 0) { first(c, o, f, sr, 0); this.n[k] = 1; this.g[k] = 1; }
        else if (k === NB - 1) { first(c, o, f, sr, 1); first(c, o + 5, f, sr, 2); first(c, o + 10, f, sr, 2); this.n[k] = 3; this.g[k] = 1; }
        else { bandpass(c, o, f, sr, 0.5, 0.25); this.n[k] = 1; this.g[k] = 1; }
      }
    } else {
      for (let k = 0; k < NB; k++) {
        const o = k * 40;
        let s = 0;
        if (k < NB - 1) { for (let r = 0; r < 2; r++) { bw2(c, o + 5 * s++, T[k], sr, Q4A, 0); bw2(c, o + 5 * s++, T[k], sr, Q4B, 0); } }
        if (k > 0) { for (let r = 0; r < 2; r++) { bw2(c, o + 5 * s++, T[k - 1], sr, Q4A, 1); bw2(c, o + 5 * s++, T[k - 1], sr, Q4B, 1); } }
        if (k === NB - 1) { for (let r = 0; r < 2; r++) { bw2(c, o + 5 * s++, T[NB - 1], sr, Q4A, 2); bw2(c, o + 5 * s++, T[NB - 1], sr, Q4B, 2); } }
        this.n[k] = s; this.g[k] = Math.SQRT2;
      }
    }
  }
  /** Filter one sample of channel ch into out[0..15]. */
  run(x: number, ch: number, out: Float64Array): void {
    const c = this.c, z = this.z;
    for (let k = 0; k < NB; k++) {
      let v = x;
      const ns = this.n[k];
      let zo = ((ch * NB + k) * 8) * 2, co = k * 40;
      for (let s = 0; s < ns; s++, zo += 2, co += 5) {
        const y = c[co] * v + z[zo];
        z[zo] = c[co + 1] * v - c[co + 3] * y + z[zo + 1];
        z[zo + 1] = c[co + 2] * v - c[co + 4] * y;
        v = y;
      }
      out[k] = v * this.g[k];
    }
  }
  flush(): void {
    const z = this.z;
    for (let i = 0; i < z.length; i++) if (z[i] > -1e-25 && z[i] < 1e-25) z[i] = 0;
  }
}

/** In-place complex radix-2 FFT. */
class FFT {
  private n: number;
  private cs: Float64Array;
  private sn: Float64Array;
  private rev: Uint32Array;
  constructor(n: number) {
    this.n = n;
    this.cs = new Float64Array(n / 2); this.sn = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cs[i] = Math.cos((2 * Math.PI * i) / n); this.sn[i] = -Math.sin((2 * Math.PI * i) / n); }
    this.rev = new Uint32Array(n);
    const bits = Math.round(Math.log2(n));
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
  }
  /** Forward (sign -1) or inverse (sign +1, unscaled) transform. */
  run(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = this.n, rev = this.rev, C = this.cs, S = this.sn, sg = inverse ? -1 : 1;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half, s = sg * S[k];
          const tr = re[b] * C[k] - im[b] * s, ti = re[b] * s + im[b] * C[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

/** Linear-phase band split: FL's 1023-tap frequency-sampled FIRs by FFT overlap-save (stereo packed). */
class LinBank {
  private fft = new FFT(LP_N);
  private hr: Float64Array[] = [];
  private hi: Float64Array[] = [];
  private inL = new Float64Array(LP_N);
  private inR = new Float64Array(LP_N);
  private re = new Float64Array(LP_N);
  private im = new Float64Array(LP_N);
  private xr = new Float64Array(LP_N);
  private xi = new Float64Array(LP_N);
  /** Output band signals of the current hop: [band][ch][LP_HOP]. */
  private out: Float64Array[];
  private pos = 0;
  constructor(sr: number) {
    this.out = Array.from({ length: NB * 2 }, () => new Float64Array(LP_HOP));
    const half = LP_N / 2;
    const ker = new Float64Array(LP_N), kim = new Float64Array(LP_N);
    let lo = 0;
    for (let k = 0; k < NB; k++) {
      const hiBin = k === NB - 1 ? half : Math.floor((T[k] * LP_N) / sr) - 1;
      // zero-phase brick-wall band on the 2048-bin grid
      ker.fill(0); kim.fill(0);
      for (let b = lo; b <= hiBin && b <= half; b++) { ker[b] = 1; if (b > 0 && b < half) ker[LP_N - b] = 1; }
      this.fft.run(ker, kim, true);
      // centre 1023 taps (sine window) at index 512, zero elsewhere
      const tap = new Float64Array(LP_N);
      for (let i = 0; i < LP_TAPS; i++) {
        const m = i - 511; // lag
        const v = ker[(m + LP_N) % LP_N] / LP_N;
        tap[i + 1] = v * Math.sin((Math.PI * (i + 1)) / (LP_TAPS + 1));
      }
      const hr = Float64Array.from(tap), hi = new Float64Array(LP_N);
      this.fft.run(hr, hi, false);
      this.hr.push(hr); this.hi.push(hi);
      lo = Math.max(lo, hiBin + 1);
    }
  }
  clear(): void { this.inL.fill(0); this.inR.fill(0); for (const o of this.out) o.fill(0); this.pos = 0; }
  /** Push one stereo sample; writes the band outputs (delayed by one hop + 512) into bL/bR. */
  run(xl: number, xr: number, bL: Float64Array, bR: Float64Array): void {
    const p = this.pos;
    for (let k = 0; k < NB; k++) { bL[k] = this.out[2 * k][p]; bR[k] = this.out[2 * k + 1][p]; }
    this.inL[LP_HOP + p] = xl; this.inR[LP_HOP + p] = xr;
    if (++this.pos >= LP_HOP) { this.pos = 0; this.block(); }
  }
  private block(): void {
    const N = LP_N, re = this.re, im = this.im, xr = this.xr, xi = this.xi;
    for (let i = 0; i < N; i++) { xr[i] = this.inL[i]; xi[i] = this.inR[i]; }
    this.fft.run(xr, xi, false);
    for (let k = 0; k < NB; k++) {
      const hr = this.hr[k], hi = this.hi[k];
      for (let i = 0; i < N; i++) {
        // (XL + j XR) * H : both channels at once (H is the spectrum of a real kernel)
        re[i] = xr[i] * hr[i] - xi[i] * hi[i];
        im[i] = xr[i] * hi[i] + xi[i] * hr[i];
      }
      this.fft.run(re, im, true);
      const oL = this.out[2 * k], oR = this.out[2 * k + 1], s = 1 / N;
      for (let i = 0; i < LP_HOP; i++) { oL[i] = re[LP_HOP + i] * s; oR[i] = im[LP_HOP + i] * s; }
    }
    this.inL.copyWithin(0, LP_HOP); this.inR.copyWithin(0, LP_HOP);
  }
}

// ---------------------------------------------------------------------------

class MultibandDelayFx implements EffectInstance {
  private sr: number;
  private iir = new IirBank();
  private lin: LinBank;
  // parameters
  private bandP = new Float64Array(384);
  private scale = 0; private x01 = false; private fb = 0; private smoothMs = 0; private mode = 0; private keep = false;
  private morph = 0; private mix = 1; private harm = false; private weight = false; private hpHz = 10; private sat = 0;
  private bandMode = new Int32Array(NB);
  private curMode = -1;
  // per band and channel delay lines
  private dl: Float32Array[];
  private dlLen: number;
  private wpos = 0;
  private dCur = new Float64Array(NB); // smoothed delay (samples, >= 1)
  private dTgt = new Float64Array(NB);
  private tapA = new Float64Array(NB);
  private tapB = new Float64Array(NB);
  private xf = new Float64Array(NB); // crossfade position (0 = A, 1 = B), < 0 idle
  private fbG = new Float64Array(NB);
  private gL = new Float64Array(NB); private gR = new Float64Array(NB); // current gains
  private tL = new Float64Array(NB); private tR = new Float64Array(NB); // targets
  private bPrevL = new Float64Array(NB); private bPrevR = new Float64Array(NB);
  private bL = new Float64Array(NB); private bR = new Float64Array(NB);
  // dry delay (linear phase)
  private dryL: Float32Array; private dryR: Float32Array; private dryPos = 0;
  // wet chain
  private hpC = 0; private hpX = [0, 0]; private hpY = [0, 0];
  private det = [0, 0]; private cg = [1, 1];
  private kDet: number; private kAtt: number; private relMul: number; private kG: number;
  private mixS = 1;
  private sOn = new Float64Array(NB);
  // monitor
  private hist: Float32Array; private histW = 0; private histR = 0; private chunk: number; private chunkPos = 0;
  private bandPk = new Float64Array(NB);
  private pkL = 0; private pkR = 0;

  constructor(sr: number) {
    this.sr = sr;
    this.lin = new LinBank(sr);
    this.dlLen = Math.ceil(sr * 1.0) + 8;
    this.dl = Array.from({ length: NB * 2 }, () => new Float32Array(this.dlLen));
    this.dryL = new Float32Array(1537); this.dryR = new Float32Array(1537);
    this.kDet = 1 - Math.exp(-1 / (COMP_DET_SEC * sr));
    this.kAtt = 1 - Math.exp(-1 / (COMP_ATT_SEC * sr));
    this.relMul = Math.pow(10, COMP_REL_DB_S / sr / 20);
    this.kG = 1 - Math.exp(-1 / (0.005 * sr));
    this.chunk = Math.max(64, Math.round(HIST_CHUNK_SEC * sr));
    this.hist = new Float32Array(HIST_LEN * NB);
    this.setParams({});
    this.reset();
  }

  get latency(): number { return this.mode === 2 ? 1536 : 0; }

  /** Ring-out time: longest delay plus the feedback decay to -60 dB. */
  get tail(): number {
    let t = 0.05;
    for (let k = 0; k < NB; k++) {
      const D = Math.max(this.dTgt[k], this.dCur[k]) / this.sr;
      const g = this.fbG[k];
      const dec = g > 1e-6 ? (D * 60) / Math.max(1e-6, -20 * Math.log10(Math.min(0.999999, g))) : 0;
      t = Math.max(t, D + dec + 0.05);
    }
    return Math.min(120, t);
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number) => { const v = q[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d; };
    for (let b = 0; b < 8; b++) for (let t = 0; t < 3; t++) for (let k = 0; k < NB; k++) {
      const key = `${'dvp'[t]}${b + 1}_${k + 1}`;
      const d = t === 0 ? 0 : t === 1 ? ONE : ONE / 2;
      // FL keeps the band values as float32 fractions of 2^30
      this.bandP[b * 48 + t * 16 + k] = Math.fround(Math.fround(Math.min(ONE, Math.max(0, num(key, d)))) / ONE);
    }
    // scale as FL computes it: 2 x - 1 from the normalised control (float32)
    const sx = Math.fround((Math.min(6000, Math.max(-6000, num('scale', 0))) + 6000) / 12000);
    this.scale = Math.fround(2 * sx - 1);
    this.x01 = num('x01', 0) >= 0.5;
    this.fb = Math.min(1, Math.max(0, num('feedback', 0) / 6000));
    this.smoothMs = Math.max(0, num('smoothing', 0) / 6);
    this.mode = Math.round(Math.min(2, Math.max(0, num('filterMode', 0))));
    this.keep = num('keepPitch', 0) >= 0.5;
    this.morph = Math.min(7, Math.max(0, num('morph', 0) / 1000));
    this.mix = (Math.min(128, Math.max(-128, num('mix', 128))) + 128) / 256;
    this.harm = num('harmonic', 0) >= 0.5;
    this.weight = num('weighting', 0) >= 0.5;
    const hv = Math.min(100000, Math.max(1000, num('hp', 1000)));
    this.hpHz = 10 * Math.pow(100, Math.fround((hv - 1000) / 99000));
    this.sat = Math.round(Math.min(2, Math.max(0, num('sat', 0))));
    const modes = q.bandModes;
    for (let k = 0; k < NB; k++) this.bandMode[k] = Array.isArray(modes) && modes[k] === 1 ? 1 : 0;
    const K = Math.tan((Math.PI * Math.min(this.hpHz, 0.45 * this.sr)) / this.sr);
    this.hpC = (K - 1) / (K + 1);
    this.updateTargets();
  }

  /** Morph-interpolated band settings -> delay targets (samples), gains and feedback. */
  private updateTargets(): void {
    const m = this.morph, i0 = Math.min(6, Math.floor(m)), fr = m - i0;
    const sr = this.sr;
    for (let k = 0; k < NB; k++) {
      const at = (t: number) => {
        const a = this.bandP[i0 * 48 + t * 16 + k], b = this.bandP[(i0 + 1) * 48 + t * 16 + k];
        return fr > 0 ? Math.fround(a + (b - a) * fr) : a;
      };
      const d = at(0), v = at(1), pn = at(2);
      let D: number;
      // Harmonic scale: loop pitch C3 * 2^(st/12), st = whole semitones of the scale (+-48) + 48 x delay
      if (this.harm) D = Math.max(1, Math.floor(sr / (C3 * Math.pow(2, (Math.trunc(Math.fround(48 * this.scale)) + 48 * d) / 12))));
      else {
        const range = this.x01 ? 0.1 : 1;
        // FL: integer delays (float32 product, then times the rate in double), at least one sample
        const s = this.scale, dd = s >= 0 ? d : Math.fround(1 - d), a = s >= 0 ? s : Math.fround(-s);
        D = Math.max(1, Math.floor(Math.fround(dd * a) * range * sr));
      }
      this.dTgt[k] = Math.min(this.dlLen - 4, D);
      const g = volGain(v);
      this.tL[k] = g * Math.sqrt(2 * (1 - pn));
      this.tR[k] = g * Math.sqrt(2 * pn);
    }
  }

  reset(): void {
    this.updateTargets();
    for (const d of this.dl) d.fill(0);
    this.wpos = 0;
    for (let k = 0; k < NB; k++) {
      // FL starts the delays at their minimum and lets the smoothing glide them in
      this.dCur[k] = this.smoothMs > 0 && !this.keep ? 1 : this.dTgt[k];
      this.tapA[k] = Math.round(this.dTgt[k]); this.tapB[k] = this.tapA[k]; this.xf[k] = -1;
      this.gL[k] = this.tL[k]; this.gR[k] = this.tR[k];
      this.bPrevL[k] = 0; this.bPrevR[k] = 0;
      this.sOn[k] = this.bandMode[k] === 1 ? 0 : 1;
    }
    this.iir.clear(); this.lin.clear();
    this.curMode = -1;
    this.dryL.fill(0); this.dryR.fill(0); this.dryPos = 0;
    this.hpX = [0, 0]; this.hpY = [0, 0]; this.det = [0, 0]; this.cg = [1, 1];
    this.mixS = this.mix;
    this.hist.fill(0); this.histW = 0; this.histR = 0; this.chunkPos = 0; this.bandPk.fill(0);
    this.pkL = 0; this.pkR = 0;
  }

  private feedbackGains(): void {
    const sr = this.sr;
    for (let k = 0; k < NB; k++) {
      if (this.fb <= 0 || this.bandMode[k] === 1) { this.fbG[k] = 0; continue; }
      if (!this.weight) { this.fbG[k] = 0.95 * this.fb; continue; }
      // Weighting: the same decay time for every delay length (FL: T60 table over 0.95 x feedback)
      const t60 = wT60(0.95 * this.fb);
      const D = this.keep ? Math.max(this.tapA[k], this.tapB[k]) : this.dCur[k];
      this.fbG[k] = t60 > 0 ? Math.pow(10, (-3 * Math.max(D / sr, 0.001)) / t60) : 0;
    }
  }

  process(L: Float32Array, R: Float32Array, n: number, _ctx: FxContext): void {
    void _ctx;
    if (n <= 0) return;
    const sr = this.sr;
    if (this.mode !== this.curMode) {
      if (this.mode !== 2) this.iir.design(this.mode, sr);
      this.iir.clear(); this.lin.clear();
      this.curMode = this.mode;
    }
    this.feedbackGains();
    const mode = this.mode, keep = this.keep, dlLen = this.dlLen;
    const ks = this.smoothMs > 0 ? Math.fround(1 - Math.exp(-Math.LN10 / (this.smoothMs * 0.001 * sr))) : 1;
    const xfStep = 1 / (XFADE_SEC * sr);
    // gains: per-sample one-pole (5 ms); mix ramps over the block
    const kb = 1 - Math.exp(-n / (0.01 * sr)), kG = this.kG;
    const dgL = this.gL, dgR = this.gR;
    const mixT = this.mix, mix0 = this.mixS; this.mixS += (mixT - this.mixS) * kb; const dMix = (this.mixS - mix0) / n;
    const bL = this.bL, bR = this.bR;
    const hpC = this.hpC, sat = this.sat;
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      // band split
      if (mode === 2) this.lin.run(xl, xr, bL, bR);
      else { this.iir.run(xl, 0, bL); this.iir.run(xr, 1, bR); }
      const w = this.wpos;
      let wetL = 0, wetR = 0;
      for (let k = 0; k < NB; k++) {
        const dlL = this.dl[2 * k], dlR = this.dl[2 * k + 1];
        dgL[k] += (this.tL[k] - dgL[k]) * kG; dgR[k] += (this.tR[k] - dgR[k]) * kG;
        this.sOn[k] += ((this.bandMode[k] === 1 ? 0 : 1) - this.sOn[k]) * kG;
        // read the delayed signal (loop length = delay), then write input + feedback
        const fg = this.fbG[k];
        let yl: number, yr: number;
        if (!keep) {
          // FL's smoothing: float32 one-pole toward the integer target (it stalls a fraction of a
          // sample short, as FL does), read with linear interpolation
          let d = this.dCur[k];
          const tg = this.dTgt[k];
          if (d !== tg) { d = Math.fround(d + Math.fround(Math.fround(tg - d) * ks)); this.dCur[k] = d; }
          const di = Math.floor(d), f = d - di;
          let r0 = w - di; if (r0 < 0) r0 += dlLen;
          if (f === 0) { yl = dlL[r0]; yr = dlR[r0]; }
          else {
            const r1 = r0 - 1 < 0 ? r0 - 1 + dlLen : r0 - 1;
            yl = dlL[r0] + (dlL[r1] - dlL[r0]) * f;
            yr = dlR[r0] + (dlR[r1] - dlR[r0]) * f;
          }
        } else {
          let a = this.tapA[k];
          const tg = Math.round(this.dTgt[k]);
          if (this.xf[k] < 0 && tg !== a) { this.tapB[k] = tg; this.xf[k] = 0; }
          let ra = w - a; if (ra < 0) ra += dlLen;
          if (this.xf[k] < 0) { yl = dlL[ra]; yr = dlR[ra]; }
          else {
            let rb = w - this.tapB[k]; if (rb < 0) rb += dlLen;
            const t = this.xf[k];
            yl = dlL[ra] * (1 - t) + dlL[rb] * t;
            yr = dlR[ra] * (1 - t) + dlR[rb] * t;
            const nt = t + xfStep;
            if (nt >= 1) { a = this.tapB[k]; this.tapA[k] = a; this.xf[k] = -1; }
            else this.xf[k] = nt;
          }
        }
        const vl = bL[k] + fg * yl, vr = bR[k] + fg * yr;
        dlL[w] = vl > -1e-25 && vl < 1e-25 ? 0 : vl;
        dlR[w] = vr > -1e-25 && vr < 1e-25 ? 0 : vr;
        // band switched off: passes unaffected (1-sample delay, no feedback)
        const on = this.sOn[k];
        wetL += on * yl * dgL[k] + (1 - on) * this.bPrevL[k];
        wetR += on * yr * dgR[k] + (1 - on) * this.bPrevR[k];
        this.bPrevL[k] = bL[k]; this.bPrevR[k] = bR[k];
        const a = Math.abs(yl) + Math.abs(yr);
        if (a > this.bandPk[k]) this.bandPk[k] = a;
      }
      this.wpos = w + 1 >= dlLen ? 0 : w + 1;
      // wet: first-order high-pass, then saturation
      let hl = hpC * wetL + this.hpX[0] - hpC * this.hpY[0]; // allpass part
      this.hpX[0] = wetL; this.hpY[0] = hl; hl = 0.5 * (wetL - hl);
      let hr = hpC * wetR + this.hpX[1] - hpC * this.hpY[1];
      this.hpX[1] = wetR; this.hpY[1] = hr; hr = 0.5 * (wetR - hr);
      if (sat === 1) { hl = Math.tanh(hl); hr = Math.tanh(hr); }
      else if (sat === 2) { hl = hl > 1 ? 1 : hl < -1 ? -1 : hl; hr = hr > 1 ? 1 : hr < -1 ? -1 : hr; }
      else { hl = this.comp(0, hl); hr = this.comp(1, hr); }
      // dry (latency-aligned in linear-phase mode)
      let dryl = xl, dryr = xr;
      if (mode === 2) {
        const p = this.dryPos;
        dryl = this.dryL[p]; dryr = this.dryR[p];
        this.dryL[p] = xl; this.dryR[p] = xr;
        this.dryPos = p + 1 >= 1536 ? 0 : p + 1;
      }
      const m = mix0 + dMix * (i + 1);
      const yl = dryl + (hl - dryl) * m, yr = dryr + (hr - dryr) * m;
      L[i] = yl; R[i] = yr;
      const al = yl < 0 ? -yl : yl, ar = yr < 0 ? -yr : yr;
      if (al > this.pkL) this.pkL = al; if (ar > this.pkR) this.pkR = ar;
      if (++this.chunkPos >= this.chunk) {
        this.chunkPos = 0;
        const o = this.histW * NB;
        for (let k = 0; k < NB; k++) { this.hist[o + k] = this.bandPk[k]; this.bandPk[k] = 0; }
        this.histW = (this.histW + 1) % HIST_LEN;
        if (this.histW === this.histR) this.histR = (this.histR + 1) % HIST_LEN;
      }
    }
    if (mode !== 2) this.iir.flush();
  }

  /** Comp: cubic-mean level held at COMP_TARGET; attack 1.3 ms, release 177 dB/s. */
  private comp(c: number, x: number): number {
    const a = x < 0 ? -x : x;
    this.det[c] += (a * a * a - this.det[c]) * this.kDet;
    const lvl = Math.cbrt(this.det[c]);
    const tg = lvl > COMP_TARGET ? COMP_TARGET / lvl : 1;
    let g = this.cg[c];
    if (tg < g) g += (tg - g) * this.kAtt;
    else if (g < 1) { g *= this.relMul; if (g > tg) g = tg; }
    this.cg[c] = g;
    return x * g;
  }

  monitor(): FxMonitor {
    const nCh = (this.histW - this.histR + HIST_LEN) % HIST_LEN;
    const env: number[] = new Array(nCh * NB);
    for (let j = 0, r = this.histR; j < nCh; j++, r = (r + 1) % HIST_LEN) for (let k = 0; k < NB; k++) env[j * NB + k] = this.hist[r * NB + k];
    this.histR = this.histW;
    const m: FxMonitor = { env, chunk: this.chunk / this.sr, pkL: this.pkL, pkR: this.pkR };
    this.pkL = 0; this.pkR = 0;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'mbdelay',
  create: (sampleRate) => new MultibandDelayFx(sampleRate),
};
