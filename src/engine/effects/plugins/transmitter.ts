// Transmitter (FL Studio 2026). Measured on FL's plugin with flfxhost (see
// docs/research/fx/transmitter.md):
// - Transient envelope T (0..1, sustain = 1 - T, so the two parts always sum
//   to the input): a gate that opens at each detection and stays open for the
//   hold time (retriggered by every new detection), smoothed by Sanfilippo's
//   4-stage exponential smoother (coefficient exp(-2*pi*c / (t*sr)), c =
//   1/sqrt(2^(1/4) - 1)) with instant attack, or a 2 ms attack when Lookahead
//   is on (the audio is then delayed by floor(0.002*sr) samples, the reported
//   latency), and the release time as release.
// - Detection: a high-passed detector signal (the mid (L+R)/2 when Stereo link
//   is on, the selected sidechain input when one is chosen), fast and slow
//   envelope followers compared in dB, both rising and falling changes count,
//   an absolute floor that the Sensitivity knob lowers, and a minimum spacing
//   between detections set by the mode (Smooth 50 ms, Balanced 20 ms, Dense
//   5 ms). The followers' constants were fitted to FL's gate on drums, tones,
//   steps and noise.
// - Each part: tilt EQ (first-order shelf pair around 1 kHz, +-6 dB, before
//   the effect) -> effect with its own dry/wet mix -> level (-120..+12 dB)
//   and on/off; a part can also be sent (post effect) to another mixer track.
// - Effects: Saturation (tanh with FL's 0.9763 ceiling, drive 0..18 dB,
//   warmth = first-order allpass from Nyquist to 20 Hz after the shaper),
//   Bounce (64 ping-pong taps over 2 s with exponential
//   time and level curves), Diffusion (16-stage allpass dispersion + a feedback
//   network whose size follows the delay control), Blur (passes the signal
//   unchanged, as in FL 2026), Delay (1 ms..2 s or 1/48..16 steps, feedback,
//   two-tap linear interpolation and a 20 Hz DC blocker in the echoes).

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';

// ---------------------------------------------------------------- constants

const TWO_PI = Math.PI * 2;
/** Sanfilippo's cut-off correction for a 4-stage cascade of one-pole smoothers. */
const C4 = 1 / Math.sqrt(Math.pow(2, 1 / 4) - 1);
const TINY = 1e-25;

/** Coefficient of one stage of the 4-stage smoother reaching its target in `sec`. */
function cascCoef(sec: number, sr: number): number {
  return sec <= 0 ? 0 : Math.exp((-TWO_PI * C4) / (sec * sr));
}
/** One-pole coefficient for a time constant (seconds). */
function onePole(sec: number, sr: number): number {
  return sec <= 0 ? 0 : Math.exp(-1 / (sec * sr));
}

/**
 * Detector constants (fitted to FL's transient gate; see the research notes).
 * hp: detector high-pass (Hz); fast follower: attack / release (ms) and stages;
 * slow follower (fed by the fast one): attack / release (ms) and stages;
 * floor e0 + e1 * sens (dB); thresholds (t0 + t1 * sens) dB scaled per mode
 * (Smooth, Balanced, Dense); kd scales the threshold for falling changes.
 */
export const DETECT = {
  hp: 1057.2, hp2: true,
  fAtt: 1.0466, fRel: 18.65, fSt: 2,
  sAtt: 27.696, sRel: 0.1, sSt: 2,
  e0: -34.592, e1: -38.073,
  t0: 9.0349, t1: 2.6361,
  mode: [1.1328, 1, 0.9483],
  kd: 1.1657,
};
/** Minimum spacing between detections (ms) per mode: Smooth, Balanced, Dense. */
export const REFRACTORY_MS = [50, 20, 5];

/** FL's saturation curve: tanh up to |u| = 1.4, then a measured knee to 0.9763. */
const SAT_U = [1.4, 1.6, 1.8, 2.0, 2.2, 2.4, 2.6, 2.8, 3.0, 3.3, 3.6, 4.0, 4.5, 5.0, 6.0];
const SAT_Y = [0.88535, 0.92146, 0.94384, 0.95664, 0.96408, 0.96853, 0.97128, 0.97302, 0.97414, 0.97513, 0.97566, 0.97601, 0.97619, 0.97626, 0.9763];
export const SAT_CEIL = 0.9763;
const SAT_N = 256;
const SAT_TAB = new Float64Array(SAT_N + 2);
(() => {
  // resample the knee (1.4..6) onto a uniform grid with monotone cubic interpolation
  const n = SAT_U.length;
  const d = new Float64Array(n);
  const m = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) m[i] = (SAT_Y[i + 1] - SAT_Y[i]) / (SAT_U[i + 1] - SAT_U[i]);
  d[0] = 1 - SAT_Y[0] * SAT_Y[0]; // tanh' at the junction
  d[n - 1] = 0;
  for (let i = 1; i < n - 1; i++) d[i] = m[i - 1] * m[i] <= 0 ? 0 : (2 * m[i - 1] * m[i]) / (m[i - 1] + m[i]);
  for (let k = 0; k <= SAT_N + 1; k++) {
    const u = 1.4 + ((6 - 1.4) * Math.min(k, SAT_N)) / SAT_N;
    let i = 0;
    while (i < n - 2 && u > SAT_U[i + 1]) i++;
    const h = SAT_U[i + 1] - SAT_U[i], t = (u - SAT_U[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    SAT_TAB[k] = (2 * t3 - 3 * t2 + 1) * SAT_Y[i] + (t3 - 2 * t2 + t) * h * d[i] + (-2 * t3 + 3 * t2) * SAT_Y[i + 1] + (t3 - t2) * h * d[i + 1];
  }
})();

export function satCurve(u: number): number {
  const a = u < 0 ? -u : u;
  let y: number;
  if (a <= 1.4) y = Math.tanh(a);
  else if (a >= 6) y = SAT_CEIL;
  else {
    const f = ((a - 1.4) / (6 - 1.4)) * SAT_N;
    const i = f | 0;
    y = SAT_TAB[i] + (SAT_TAB[i + 1] - SAT_TAB[i]) * (f - i);
  }
  return u < 0 ? -y : y;
}

/** Warmth -> first-order allpass coefficient (measured at 44.1 kHz as corner frequency). */
const WARM_W = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const WARM_FC = [22050, 2285.0, 926.64, 459.66, 255.64, 152.31, 95.5, 62.13, 41.62, 28.57, 20.11];
export function warmthCorner(w: number): number {
  const x = Math.min(1, Math.max(0, w)) * 10;
  const i = Math.min(9, Math.floor(x));
  const t = x - i;
  // interpolate in log frequency
  return Math.exp(Math.log(WARM_FC[i]) + (Math.log(WARM_FC[i + 1]) - Math.log(WARM_FC[i])) * t);
}

/** Bounce: 64 alternating L/R taps over a 2 s window. */
export const BOUNCE_TAPS = 64;
export const BOUNCE_WINDOW = 2;
export function bounceTapTime(k: number, timeCurve: number): number {
  // k = 1..64, exponential warp: t_k = W (1 - q^k) / (1 - q^64), q = exp(-10 c / 64)
  if (Math.abs(timeCurve) < 1e-6) return (BOUNCE_WINDOW * k) / BOUNCE_TAPS;
  const q = Math.exp((-10 * timeCurve) / BOUNCE_TAPS);
  return (BOUNCE_WINDOW * (1 - Math.pow(q, k))) / (1 - Math.pow(q, BOUNCE_TAPS));
}
export function bounceTapGain(k: number, ampCurve: number): number {
  const a = Math.min(1, Math.abs(ampCurve));
  if (a === 0) return 1;
  const e = ampCurve > 0 ? Math.exp((-10 * (BOUNCE_TAPS - k)) / BOUNCE_TAPS) : Math.exp((-10 * k) / BOUNCE_TAPS);
  return 1 - 0.95 * a * (1 - e);
}

/** Diffusion network: base loop delays (samples at 44.1 kHz for a 1 s "delay" setting). */
const DIFF_BASE = [107, 149, 203, 257];
const DIFF_STAGES = 16;
/** RT60 / delay setting as a function of depth (measured). */
const DIFF_DEPTH = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99];
const DIFF_K = [2.4, 2.4, 2.6, 3.7, 6.3, 17.5, 90];
function diffK(d: number): number {
  for (let i = 0; i < DIFF_DEPTH.length - 1; i++) {
    if (d <= DIFF_DEPTH[i + 1]) {
      const t = (d - DIFF_DEPTH[i]) / (DIFF_DEPTH[i + 1] - DIFF_DEPTH[i]);
      return Math.exp(Math.log(DIFF_K[i]) + (Math.log(DIFF_K[i + 1]) - Math.log(DIFF_K[i])) * t);
    }
  }
  return DIFF_K[DIFF_K.length - 1];
}
const DIFF_OUT = 0.42; // network output gain (calibrated on FL's tail level)
/** Network input gain vs depth (calibrated on FL's tail level; none at depth 0). */
const DIFF_DEPTH_IN = [0, 0.05, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99];
const DIFF_IN = [0, 0.8, 1.27, 1.6, 1.12, 0.75, 0.45, 0.3];
function lerpTable(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  for (let i = 0; i < xs.length - 1; i++) {
    if (x <= xs[i + 1]) return ys[i] + ((ys[i + 1] - ys[i]) * (x - xs[i])) / (xs[i + 1] - xs[i]);
  }
  return ys[ys.length - 1];
}

// ------------------------------------------------------------- parameters

interface PathParams {
  level: number; // linear gain
  tilt: number; // dB
  on: number;
  fx: number;
  satMix: number; drive: number; warmth: number;
  bncMix: number; bncAmp: number; bncTime: number;
  diffMix: number; depth: number; diffDelay: number;
  dlyMix: number; dlyTime: number; dlySync: number; dlyFb: number; tempo: number;
}

const num = (q: Record<string, unknown>, k: string, d: number, lo: number, hi: number) => {
  const v = Number(q[k] ?? d);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
};
const n32 = (v: number, span = 10000) => Math.fround(v / span);

function readPath(q: Record<string, unknown>, p: 't' | 's', d: { level: number; fx: number }): PathParams {
  const levelRaw = num(q, p + 'Level', 8743, 0, 12800);
  const db = -120 + 132 * Math.pow(n32(levelRaw, 12800), 0.25);
  const x = (k: string, def: number) => n32(num(q, p + k, def, 0, 10000));
  return {
    level: Math.pow(10, db / 20),
    tilt: (x('Tilt', 5000) - 0.5) * 12,
    on: num(q, p + 'On', 1, 0, 1) >= 0.5 ? 1 : 0,
    fx: Math.round(num(q, p + 'Fx', d.fx, 0, 5)),
    satMix: x('SatMix', 10000), drive: Math.pow(10, (x('SatDrive', p === 't' ? 3333 : 3342) * 18) / 20), warmth: x('SatWarmth', 0),
    bncMix: x('BncMix', 10000), bncAmp: (x('BncAmp', p === 't' ? 5320 : 4443) - 0.5) * 2, bncTime: (x('BncTime', p === 't' ? 5275 : 4642) - 0.5) * 2,
    diffMix: x('DiffMix', p === 't' ? 10000 : 5000), depth: x('DiffDepth', p === 't' ? 9112 : 5051) * 0.99,
    diffDelay: 0.1 * Math.pow(100, x('DiffDelay', p === 't' ? 0 : 5000)),
    dlyMix: x('DlyMix', 10000), dlyTime: (() => { const t = x('DlyTime', p === 't' ? 3531 : 3156); return 0.001 + 1.999 * t * t; })(),
    dlySync: num(q, p + 'DlySync', p === 't' ? 144 : 240, 1, 768), dlyFb: x('DlyFb', 0),
    tempo: num(q, p + 'Tempo', 0, 0, 1) >= 0.5 ? 1 : 0,
  };
}

// ---------------------------------------------------------------- detector

/** Transient detector + gate envelope (also used by Transporter for its triggers). */
export class Detector {
  private hpA = 0;
  private hx1 = 0; private hy1 = 0; private hx2 = 0; private hy2 = 0;
  private readonly fS = new Float64Array(4);
  private readonly sS = new Float64Array(4);
  private fa = 0; private fr = 0; private sa = 0; private sr = 0;
  private eps = 1e-3; private thUp = 10; private thDn = 10;
  private refractory = 882;
  private since = 1e9; // samples since the last detection
  private hold = 44;
  private holdLeft = 0;
  // transient envelope (4-stage smoother)
  private readonly tS = new Float64Array(4);
  private ta = 0; private tr = 0.9;

  configure(sr: number, sens: number, mode: number, holdSec: number, relSec: number, lookahead: boolean): void {
    const D = DETECT;
    this.hpA = D.hp > 0 ? Math.exp((-TWO_PI * D.hp) / sr) : 0;
    // stage coefficient of an n-stage smoother reaching its target in `ms`
    const stg = (ms: number, st: number) => {
      if (ms <= 0) return 0;
      const c = st > 1 ? 1 / Math.sqrt(Math.pow(2, 1 / st) - 1) : 1;
      return Math.exp((-TWO_PI * c) / ((ms / 1000) * sr));
    };
    this.fa = stg(D.fAtt, D.fSt); this.fr = stg(D.fRel, D.fSt);
    this.sa = stg(D.sAtt, D.sSt); this.sr = stg(D.sRel, D.sSt);
    this.eps = Math.pow(10, (D.e0 + D.e1 * sens) / 20);
    this.thUp = Math.max(0.01, (D.t0 + D.t1 * sens) * D.mode[mode]);
    this.thDn = this.thUp * D.kd;
    this.refractory = Math.round((REFRACTORY_MS[mode] * sr) / 1000);
    this.hold = Math.max(1, Math.round(holdSec * sr));
    this.ta = lookahead ? cascCoef(0.002, sr) : 0;
    this.tr = cascCoef(relSec, sr);
  }

  reset(): void {
    this.hx1 = this.hy1 = this.hx2 = this.hy2 = 0;
    this.fS.fill(0); this.sS.fill(0); this.tS.fill(0);
    this.since = 1e9; this.holdLeft = 0;
  }

  /** One detector sample; true when a new detection fires (respecting the mode spacing). */
  trigger(x: number): boolean {
    let v = x;
    if (this.hpA > 0) {
      const y = this.hpA * (this.hy1 + v - this.hx1);
      this.hx1 = v; this.hy1 = y; v = y;
      if (DETECT.hp2) { const y2 = this.hpA * (this.hy2 + v - this.hx2); this.hx2 = v; this.hy2 = y2; v = y2; }
    }
    let r = v < 0 ? -v : v;
    const fS = this.fS, sS = this.sS;
    for (let k = 0; k < DETECT.fSt; k++) { const c = r > fS[k] ? this.fa : this.fr; fS[k] = r + c * (fS[k] - r); r = fS[k]; }
    const f = r;
    let q = f;
    for (let k = 0; k < DETECT.sSt; k++) { const c = q > sS[k] ? this.sa : this.sr; sS[k] = q + c * (sS[k] - q); q = sS[k]; }
    const D = 20 * Math.log10((f + this.eps) / (q + this.eps));
    this.since++;
    if ((D > this.thUp || D < -this.thDn) && this.since >= this.refractory) {
      this.since = 0;
      return true;
    }
    return false;
  }

  /** One detector sample; returns the transient envelope T (0..1). */
  step(x: number): number {
    if (this.trigger(x)) this.holdLeft = this.hold;
    let g = 0;
    if (this.holdLeft > 0) { g = 1; this.holdLeft--; }
    // 4-stage smoother, attack (2 ms or instant) / release
    const tS = this.tS;
    let e = g;
    for (let k = 0; k < 4; k++) { const c = e > tS[k] ? this.ta : this.tr; tS[k] = e + c * (tS[k] - e); e = tS[k]; }
    return e;
  }

  flush(): void {
    for (let k = 0; k < 4; k++) {
      if (Math.abs(this.fS[k]) < TINY) this.fS[k] = 0;
      if (Math.abs(this.sS[k]) < TINY) this.sS[k] = 0;
      if (Math.abs(this.tS[k]) < TINY) this.tS[k] = 0;
    }
    if (Math.abs(this.hy1) < TINY) this.hy1 = 0;
    if (Math.abs(this.hy2) < TINY) this.hy2 = 0;
  }
}

// -------------------------------------------------------------- one part

/** Linear parameter ramp across a block (value at block start -> target). */
class Ramp {
  cur = 0; tgt = 0; step = 0;
  constructor(v = 0) { this.cur = this.tgt = v; }
  begin(target: number, n: number, coef: number): void {
    // one-pole smoothing per block, rendered as a linear ramp inside the block
    this.tgt = target + (this.cur - target) * coef;
    if (Math.abs(this.tgt - target) < 1e-7) this.tgt = target;
    this.step = (this.tgt - this.cur) / n;
  }
  next(): number { const v = this.cur; this.cur += this.step; return v; }
  end(): void { this.cur = this.tgt; }
}

class Part {
  private readonly sr: number;
  // tilt (first-order, per channel)
  private tb0 = 1; private tb1 = 0; private ta1 = 0;
  private readonly tx1 = new Float64Array(2);
  private readonly ty1 = new Float64Array(2);
  private tiltCur = 0;
  // gains
  readonly level = new Ramp(1);
  readonly mix = new Ramp(1);
  private fxCur = 0;
  private fadeOld = -1; // effect index fading out after a switch
  private fadePos = 0;
  private readonly fadeLen: number;
  // saturation
  private driveCur = 1;
  private warmCur = 0;
  private readonly apS = new Float64Array(2); // allpass state
  private warmOn = false;
  // bounce
  private readonly bBuf: Float32Array[];
  private readonly bLen: number;
  private bW = 0;
  private readonly tapPos = new Int32Array(BOUNCE_TAPS);
  private readonly tapGain = new Float32Array(BOUNCE_TAPS);
  private readonly tapPosOld = new Int32Array(BOUNCE_TAPS);
  private readonly tapGainOld = new Float32Array(BOUNCE_TAPS);
  private tapXf = 0; // crossfade position after a tap change (0 = done)
  private bAmp = NaN; private bTime = NaN;
  // diffusion
  private readonly apStages = new Float64Array(DIFF_STAGES * 2);
  private apCoef = 0;
  private readonly fdn: Float32Array[]; // 4 lines x 2 channels
  private readonly fdnLen: number;
  private fdnW = 0;
  private readonly fdnD = new Float64Array(4);
  private readonly fdnG = new Float64Array(4);
  private fdnIn = 0;
  private readonly fdnLp = new Float64Array(8);
  // delay
  private readonly dBuf: Float32Array[];
  private readonly dLen: number;
  private dW = 0;
  private dTime = -1; // smoothed delay (samples)
  private readonly dHpX = new Float64Array(2);
  private readonly dHpY = new Float64Array(2);
  private readonly dPrev = new Float64Array(2);
  private readonly dHpA: number;
  private dFb = 0;
  // scratch
  private readonly wetL: Float32Array;
  private readonly wetR: Float32Array;
  private readonly oldL: Float32Array;
  private readonly oldR: Float32Array;

  constructor(sr: number, blockSize: number) {
    this.sr = sr;
    this.fadeLen = Math.max(32, Math.round(0.003 * sr));
    this.bLen = Math.ceil(BOUNCE_WINDOW * sr) + 4;
    this.bBuf = [new Float32Array(this.bLen), new Float32Array(this.bLen)];
    this.fdnLen = Math.ceil((DIFF_BASE[3] / 44100) * 10 * sr * 1.05) + 8;
    this.fdn = Array.from({ length: 8 }, () => new Float32Array(this.fdnLen));
    this.dLen = Math.ceil(2.05 * sr) + 8;
    this.dBuf = [new Float32Array(this.dLen), new Float32Array(this.dLen)];
    this.dHpA = Math.exp((-TWO_PI * 20) / sr);
    const n = Math.max(1, blockSize | 0);
    this.wetL = new Float32Array(n); this.wetR = new Float32Array(n);
    this.oldL = new Float32Array(n); this.oldR = new Float32Array(n);
  }

  reset(): void {
    this.tx1.fill(0); this.ty1.fill(0); this.apS.fill(0);
    for (const b of this.bBuf) b.fill(0);
    for (const b of this.fdn) b.fill(0);
    for (const b of this.dBuf) b.fill(0);
    this.apStages.fill(0); this.fdnLp.fill(0);
    this.dHpX.fill(0); this.dHpY.fill(0); this.dPrev.fill(0);
    this.fadeOld = -1; this.tapXf = 0;
    this.snapNext = true;
  }

  /** Jump to the targets on the next prepare() (after creation or reset). */
  private snapNext = true;
  snap(): void { this.snapNext = true; }

  /** Recompute per-block coefficients toward the targets. */
  prepare(p: PathParams, n: number, smoothIn: number, tempoSec: number): void {
    const sr = this.sr;
    const smooth = this.snapNext ? 0 : smoothIn;
    if (this.snapNext) {
      this.fxCur = p.fx;
      this.fadeOld = -1;
      this.mix.cur = this.mix.tgt = this.mixTarget(p);
      this.dTime = -1;
      this.fdnD.fill(0);
      this.snapNext = false;
    }
    // tilt: smoothed dB, first-order H(s) = A (s + wc/A) / (s + wc A), bilinear
    this.tiltCur = p.tilt + (this.tiltCur - p.tilt) * smooth;
    if (Math.abs(this.tiltCur - p.tilt) < 1e-4) this.tiltCur = p.tilt;
    const A = Math.pow(10, this.tiltCur / 20);
    const wc = TWO_PI * 1000;
    const K = 2 * sr;
    const a0 = K + wc * A;
    this.tb0 = (A * (K + wc / A)) / a0;
    this.tb1 = (A * (wc / A - K)) / a0;
    this.ta1 = (wc * A - K) / a0;
    // effect switch: fade the old effect out
    if (p.fx !== this.fxCur) {
      this.fadeOld = this.fxCur;
      this.fadePos = 0;
      this.fxCur = p.fx;
    }
    // saturation
    this.driveCur = p.drive + (this.driveCur - p.drive) * smooth;
    this.warmCur = p.warmth + (this.warmCur - p.warmth) * smooth;
    if (Math.abs(this.warmCur - p.warmth) < 1e-5) this.warmCur = p.warmth;
    this.warmOn = this.warmCur > 1e-4;
    // bounce taps
    if (p.bncAmp !== this.bAmp || p.bncTime !== this.bTime) {
      const first = Number.isNaN(this.bAmp);
      this.tapPosOld.set(this.tapPos); this.tapGainOld.set(this.tapGain);
      for (let k = 1; k <= BOUNCE_TAPS; k++) {
        this.tapPos[k - 1] = Math.min(this.bLen - 2, Math.floor(bounceTapTime(k, p.bncTime) * sr));
        this.tapGain[k - 1] = bounceTapGain(k, p.bncAmp);
      }
      this.bAmp = p.bncAmp; this.bTime = p.bncTime;
      this.tapXf = first ? 0 : this.fadeLen;
    }
    // diffusion
    this.apCoef = p.depth;
    const rt = Math.max(0.05, p.diffDelay * diffK(p.depth));
    for (let i = 0; i < 4; i++) {
      const tgt = Math.min(this.fdnLen - 4, Math.max(2, ((DIFF_BASE[i] / 44100) * sr) * p.diffDelay));
      this.fdnD[i] = this.fdnD[i] === 0 ? tgt : tgt + (this.fdnD[i] - tgt) * smooth;
      this.fdnG[i] = Math.pow(10, (-3 * this.fdnD[i]) / (rt * sr));
    }
    // network input: none at depth 0, louder for lighter diffusion (calibrated on FL's tail level)
    this.fdnIn = lerpTable(DIFF_DEPTH_IN, DIFF_IN, p.depth);
    // delay
    const dSec = p.tempo ? Math.min(2, p.dlySync / 48 * tempoSec) : p.dlyTime;
    const dTgt = Math.min(this.dLen - 4, Math.max(1, dSec * sr));
    if (this.dTime < 0) this.dTime = dTgt;
    this.dFb = p.dlyFb;
    this.dTarget = dTgt;
    void n;
  }

  private dTarget = 1;

  mixTarget(p: PathParams): number {
    return p.fx === 0 ? p.satMix : p.fx === 1 ? p.bncMix : p.fx === 2 ? p.diffMix : p.fx === 4 ? p.dlyMix : 0;
  }

  /** Process one part in place (xL/xR hold the part's input, receive its output before level). */
  run(xL: Float32Array, xR: Float32Array, n: number, p: PathParams, mixTarget: number, smooth: number): void {
    // tilt
    for (let c = 0; c < 2; c++) {
      const b = c === 0 ? xL : xR;
      let x1 = this.tx1[c], y1 = this.ty1[c];
      const b0 = this.tb0, b1 = this.tb1, a1 = this.ta1;
      for (let i = 0; i < n; i++) { const x = b[i]; const y = b0 * x + b1 * x1 - a1 * y1; x1 = x; y1 = y; b[i] = y; }
      this.tx1[c] = x1; this.ty1[c] = Math.abs(y1) < TINY ? 0 : y1;
    }
    // effect (wet) into wetL/R, then mix
    this.mix.begin(mixTarget, n, smooth);
    const fx = this.fxCur;
    this.effect(fx, xL, xR, this.wetL, this.wetR, n);
    if (this.fadeOld >= 0) {
      this.effect(this.fadeOld, xL, xR, this.oldL, this.oldR, n);
    }
    const wL = this.wetL, wR = this.wetR;
    for (let i = 0; i < n; i++) {
      const m = this.mix.next();
      let l = xL[i] + (wL[i] - xL[i]) * m;
      let r = xR[i] + (wR[i] - xR[i]) * m;
      if (this.fadeOld >= 0 && this.fadePos < this.fadeLen) {
        const t = this.fadePos / this.fadeLen;
        // the old effect keeps its own mix (approximately the current one) while it fades
        const ol = xL[i] + (this.oldL[i] - xL[i]) * m, or = xR[i] + (this.oldR[i] - xR[i]) * m;
        l = ol + (l - ol) * t; r = or + (r - or) * t;
        this.fadePos++;
      }
      xL[i] = l; xR[i] = r;
    }
    this.mix.end();
    if (this.fadeOld >= 0 && this.fadePos >= this.fadeLen) this.fadeOld = -1;
    void p;
  }

  private effect(fx: number, xL: Float32Array, xR: Float32Array, oL: Float32Array, oR: Float32Array, n: number): void {
    switch (fx) {
      case 0: this.saturate(xL, xR, oL, oR, n); break;
      case 1: this.bounce(xL, xR, oL, oR, n); break;
      case 2: this.diffuse(xL, xR, oL, oR, n); break;
      case 4: this.delay(xL, xR, oL, oR, n); break;
      default: oL.set(xL.subarray(0, n)); oR.set(xR.subarray(0, n)); break; // Blur, Off
    }
  }

  private saturate(xL: Float32Array, xR: Float32Array, oL: Float32Array, oR: Float32Array, n: number): void {
    const g = this.driveCur;
    const warm = this.warmOn;
    // warmth: first-order allpass after the shaper (corner from Nyquist at 0 to 20 Hz at 1)
    let a = 1;
    if (warm) {
      const fc = Math.min(0.4999 * this.sr, warmthCorner(this.warmCur));
      const t = Math.tan((Math.PI * fc) / this.sr);
      a = (t - 1) / (t + 1);
    }
    for (let c = 0; c < 2; c++) {
      const x = c === 0 ? xL : xR, o = c === 0 ? oL : oR;
      let s = this.apS[c];
      for (let i = 0; i < n; i++) {
        let y = satCurve(g * x[i]);
        if (warm) { const ap = a * y + s; s = y - a * ap; y = ap; }
        o[i] = y;
      }
      this.apS[c] = Math.abs(s) < TINY ? 0 : s;
    }
  }

  private bounce(xL: Float32Array, xR: Float32Array, oL: Float32Array, oR: Float32Array, n: number): void {
    const len = this.bLen, bL = this.bBuf[0], bR = this.bBuf[1];
    let w = this.bW;
    for (let i = 0; i < n; i++) {
      bL[w] = xL[i]; bR[w] = xR[i];
      let l = 0, r = 0;
      // odd taps (k = 1, 3, ...) go left, even taps right; each tap reads its own channel
      for (let k = 0; k < BOUNCE_TAPS; k += 2) {
        let j = w - this.tapPos[k]; if (j < 0) j += len;
        l += bL[j] * this.tapGain[k];
        let j2 = w - this.tapPos[k + 1]; if (j2 < 0) j2 += len;
        r += bR[j2] * this.tapGain[k + 1];
      }
      if (this.tapXf > 0) {
        let lo = 0, ro = 0;
        for (let k = 0; k < BOUNCE_TAPS; k += 2) {
          let j = w - this.tapPosOld[k]; if (j < 0) j += len;
          lo += bL[j] * this.tapGainOld[k];
          let j2 = w - this.tapPosOld[k + 1]; if (j2 < 0) j2 += len;
          ro += bR[j2] * this.tapGainOld[k + 1];
        }
        const t = this.tapXf / this.fadeLen;
        l = l + (lo - l) * t; r = r + (ro - r) * t;
        this.tapXf--;
      }
      oL[i] = l; oR[i] = r;
      if (++w >= len) w = 0;
    }
    this.bW = w;
  }

  private diffuse(xL: Float32Array, xR: Float32Array, oL: Float32Array, oR: Float32Array, n: number): void {
    const a = this.apCoef;
    const st = this.apStages;
    const len = this.fdnLen;
    let w = this.fdnW;
    const D = this.fdnD, G = this.fdnG, gin = this.fdnIn;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) {
        // 16 first-order allpass stages (coefficient = depth; depth 0 = 16 samples of delay)
        let v = c === 0 ? xL[i] : xR[i];
        const base = c * DIFF_STAGES;
        for (let k = 0; k < DIFF_STAGES; k++) {
          const s = st[base + k];
          const y = a * v + s;
          st[base + k] = v - a * y;
          v = y;
        }
        // 4-line feedback network (Householder mixing), fed by the dispersed signal
        const lines = this.fdn;
        let o0 = 0, o1 = 0, o2 = 0, o3 = 0;
        for (let k = 0; k < 4; k++) {
          const buf = lines[c * 4 + k];
          const d = D[k];
          const di = d | 0, fr = d - di;
          let j0 = w - di; if (j0 < 0) j0 += len;
          let j1 = j0 - 1; if (j1 < 0) j1 += len;
          const s = buf[j0] + (buf[j1] - buf[j0]) * fr;
          if (k === 0) o0 = s; else if (k === 1) o1 = s; else if (k === 2) o2 = s; else o3 = s;
        }
        const sum = (o0 + o1 + o2 + o3) * 0.5;
        const inV = v * gin;
        // gentle damping inside the loop
        const lp = this.fdnLp;
        const f0 = (o0 - sum) * G[0], f1 = (o1 - sum) * G[1], f2 = (o2 - sum) * G[2], f3 = (o3 - sum) * G[3];
        const k0 = c * 4;
        lp[k0] = f0 + 0.15 * (lp[k0] - f0);
        lp[k0 + 1] = f1 + 0.15 * (lp[k0 + 1] - f1);
        lp[k0 + 2] = f2 + 0.15 * (lp[k0 + 2] - f2);
        lp[k0 + 3] = f3 + 0.15 * (lp[k0 + 3] - f3);
        lines[k0][w] = inV + lp[k0];
        lines[k0 + 1][w] = inV - lp[k0 + 1];
        lines[k0 + 2][w] = inV + lp[k0 + 2];
        lines[k0 + 3][w] = inV - lp[k0 + 3];
        const out = v + (o0 - o1 + o2 - o3) * DIFF_OUT * gin;
        if (c === 0) oL[i] = out; else oR[i] = out;
      }
      if (++w >= len) w = 0;
    }
    this.fdnW = w;
    for (let k = 0; k < st.length; k++) if (Math.abs(st[k]) < TINY) st[k] = 0;
    for (let k = 0; k < 8; k++) if (Math.abs(this.fdnLp[k]) < TINY) this.fdnLp[k] = 0;
  }

  private delay(xL: Float32Array, xR: Float32Array, oL: Float32Array, oR: Float32Array, n: number): void {
    const len = this.dLen, bL = this.dBuf[0], bR = this.dBuf[1];
    let w = this.dW;
    const glide = 1 - Math.exp(-1 / (0.05 * this.sr)); // 50 ms glide toward the set time
    const fb = this.dFb, ha = this.dHpA;
    let d = this.dTime;
    const tgt = this.dTarget;
    for (let i = 0; i < n; i++) {
      d += (tgt - d) * glide;
      const di = Math.floor(d), fr = d - di;
      let j0 = w - di; if (j0 < 0) j0 += len;
      let j1 = j0 - 1; if (j1 < 0) j1 += len;
      // linear interpolation averaged over two neighbouring reads (FL's echo kernel)
      const sl = bL[j0] + (bL[j1] - bL[j0]) * fr;
      const sr = bR[j0] + (bR[j1] - bR[j0]) * fr;
      const el = 0.5 * (sl + this.dPrev[0]), er = 0.5 * (sr + this.dPrev[1]);
      this.dPrev[0] = sl; this.dPrev[1] = sr;
      // DC blocker on the echoes
      const yl = ha * (this.dHpY[0] + el - this.dHpX[0]); this.dHpX[0] = el; this.dHpY[0] = yl;
      const yr = ha * (this.dHpY[1] + er - this.dHpX[1]); this.dHpX[1] = er; this.dHpY[1] = yr;
      bL[w] = xL[i] + yl * fb;
      bR[w] = xR[i] + yr * fb;
      oL[i] = yl; oR[i] = yr;
      if (++w >= len) w = 0;
    }
    this.dW = w;
    this.dTime = d;
    if (Math.abs(this.dHpY[0]) < TINY) this.dHpY[0] = 0;
    if (Math.abs(this.dHpY[1]) < TINY) this.dHpY[1] = 0;
  }
}

// ------------------------------------------------------------- the plugin

const MON_BUCKETS = 4096;

class Transmitter implements EffectInstance {
  private readonly sr: number;
  private readonly bs: number;
  private readonly det = [new Detector(), new Detector()];
  private readonly parts: [Part, Part];
  private pT: PathParams;
  private pS: PathParams;
  private sens = 0.7475;
  private mode = 1;
  private holdSec = 0.05;
  private relSec = 0.05;
  private lookahead = true;
  private link = true;
  private scIn = 0;
  private tOut = -1;
  private sOut = -1;
  private dirty = true;
  // lookahead delay of the audio
  private readonly laLen: number;
  private readonly laBuf: Float32Array[];
  private laW = 0;
  private readonly laSamples: number;
  // scratch
  private readonly tL: Float32Array; private readonly tR: Float32Array;
  private readonly sL: Float32Array; private readonly sR: Float32Array;
  private readonly envL: Float32Array; private readonly envR: Float32Array;
  private readonly gainT = new Ramp(1);
  private readonly gainS = new Ramp(1);
  private readonly smooth: number;
  // controller output (TSS envelope)
  private readonly ctl = new Float32Array(1);
  // monitor ring: per bucket min, max of the input (mid) and the transient envelope
  private readonly bucket: number;
  private readonly monMin = new Float32Array(MON_BUCKETS);
  private readonly monMax = new Float32Array(MON_BUCKETS);
  private readonly monEnv = new Float32Array(MON_BUCKETS);
  private monW = 0;
  private monRead = 0;
  private bCount = 0; private bMin = 0; private bMax = 0; private bEnv = 0;
  private peakIn = 0; private peakOut = 0;
  tail = 0.5;
  private primed = false;

  constructor(sr: number, blockSize: number) {
    this.sr = sr;
    this.bs = Math.max(1, blockSize | 0);
    this.parts = [new Part(sr, this.bs), new Part(sr, this.bs)];
    this.laSamples = Math.floor(0.002 * sr);
    this.laLen = this.laSamples + 1;
    this.laBuf = [new Float32Array(this.laLen), new Float32Array(this.laLen)];
    const n = this.bs;
    this.tL = new Float32Array(n); this.tR = new Float32Array(n);
    this.sL = new Float32Array(n); this.sR = new Float32Array(n);
    this.envL = new Float32Array(n); this.envR = new Float32Array(n);
    this.smooth = Math.exp(-n / (0.02 * sr)); // ~20 ms per-block smoothing
    this.bucket = Math.max(8, Math.round(sr / 1400));
    this.pT = readPath({}, 't', { level: 1, fx: 0 });
    this.pS = readPath({}, 's', { level: 1, fx: 2 });
    for (const pt of this.parts) pt.level.cur = pt.level.tgt = 1;
  }

  get latency(): number {
    return this.lookahead ? this.laSamples : 0;
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    this.sens = n32(num(q, 'sens', 7475, 0, 10000));
    // measured gate length: 1.111 ms .. 250.02 ms (the display reads 1.0 .. 250.0 ms)
    this.holdSec = 0.0011111 + 0.24891 * n32(num(q, 'hold', 1968, 0, 10000));
    this.relSec = (1 + 249 * n32(num(q, 'release', 1968, 0, 10000))) / 1000;
    this.mode = Math.round(num(q, 'mode', 1, 0, 2));
    this.lookahead = num(q, 'lookahead', 1, 0, 1) >= 0.5;
    this.link = num(q, 'stereoLink', 1, 0, 1) >= 0.5;
    this.pT = readPath(q, 't', { level: 1, fx: 0 });
    this.pS = readPath(q, 's', { level: 1, fx: 2 });
    const sc = Number(q.scIn ?? 0);
    this.scIn = Number.isInteger(sc) && sc > 0 ? sc : 0;
    const to = Number(q.tOut ?? -1), so = Number(q.sOut ?? -1);
    this.tOut = Number.isInteger(to) && to >= 0 ? to : -1;
    this.sOut = Number.isInteger(so) && so >= 0 ? so : -1;
    this.dirty = true;
    this.tail = this.computeTail();
  }

  private computeTail(): number {
    let t = this.holdSec + this.relSec + 0.05;
    for (const p of [this.pT, this.pS]) {
      if (!p.on) continue;
      if (p.fx === 1) t = Math.max(t, BOUNCE_WINDOW + 0.1);
      if (p.fx === 2) t = Math.max(t, Math.min(30, p.diffDelay * diffK(p.depth) + 0.1));
      if (p.fx === 4) {
        const d = p.tempo ? 2 : p.dlyTime;
        const reps = p.dlyFb > 0 ? Math.log(1e-4) / Math.log(Math.min(0.9999, p.dlyFb)) : 1;
        t = Math.max(t, Math.min(30, d * (reps + 1) + 0.1));
      }
    }
    return t;
  }

  sendTargets(): number[] {
    const out: number[] = [];
    if (this.tOut >= 0) out.push(this.tOut);
    if (this.sOut >= 0 && this.sOut !== this.tOut) out.push(this.sOut);
    return out;
  }

  reset(): void {
    for (const d of this.det) d.reset();
    for (const p of this.parts) p.reset();
    for (const b of this.laBuf) b.fill(0);
    this.monW = this.monRead = 0;
    this.bCount = 0; this.bMin = this.bMax = this.bEnv = 0;
    this.primed = false;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (n <= 0) return;
    const sr = this.sr;
    if (this.dirty) {
      for (const d of this.det) d.configure(sr, this.sens, this.mode, this.holdSec, this.relSec, this.lookahead);
      this.dirty = false;
    }
    if (!this.primed) {
      // first block after creation / reset: start at the targets (no fade-in from defaults)
      this.gainT.cur = this.gainT.tgt = this.pT.level * this.pT.on;
      this.gainS.cur = this.gainS.tgt = this.pS.level * this.pS.on;
      this.parts[0].snap(); this.parts[1].snap();
      this.primed = true;
    }
    const tempoSec = 60 / Math.max(10, ctx.tempo || 120) / 4; // one step
    this.parts[0].prepare(this.pT, n, this.smooth, tempoSec);
    this.parts[1].prepare(this.pS, n, this.smooth, tempoSec);

    // ---- detection (on the undelayed input, or the sidechain input)
    const sc = this.scIn > 0 ? ctx.sidechain[this.scIn - 1] : undefined;
    const dL = sc ? sc.L : L, dR = sc ? sc.R : R;
    const eL = this.envL, eR = this.envR;
    let tMax = 0;
    if (this.link) {
      const d0 = this.det[0];
      for (let i = 0; i < n; i++) {
        const e = d0.step(0.5 * (dL[i] + dR[i]));
        eL[i] = e; eR[i] = e;
        if (e > tMax) tMax = e;
      }
    } else {
      const d0 = this.det[0], d1 = this.det[1];
      for (let i = 0; i < n; i++) {
        const a = d0.step(dL[i]), b = d1.step(dR[i]);
        eL[i] = a; eR[i] = b;
        const m = a > b ? a : b;
        if (m > tMax) tMax = m;
      }
    }
    this.det[0].flush(); this.det[1].flush();
    this.ctl[0] = tMax;

    // ---- monitor buckets (input mid and envelope)
    {
      let c = this.bCount, mn = this.bMin, mx = this.bMax, ev = this.bEnv;
      let pin = this.peakIn;
      for (let i = 0; i < n; i++) {
        const x = 0.5 * (L[i] + R[i]);
        if (c === 0) { mn = x; mx = x; ev = 0; }
        if (x < mn) mn = x;
        if (x > mx) mx = x;
        const e = eL[i] > eR[i] ? eL[i] : eR[i];
        if (e > ev) ev = e;
        const ax = x < 0 ? -x : x;
        if (ax > pin) pin = ax;
        if (++c >= this.bucket) {
          const w = this.monW;
          this.monMin[w] = mn; this.monMax[w] = mx; this.monEnv[w] = ev;
          this.monW = (w + 1) % MON_BUCKETS;
          if (this.monW === this.monRead) this.monRead = (this.monRead + 1) % MON_BUCKETS;
          c = 0;
        }
      }
      this.bCount = c; this.bMin = mn; this.bMax = mx; this.bEnv = ev; this.peakIn = pin;
    }

    // ---- lookahead delay of the audio and the split
    const tL = this.tL, tR = this.tR, sL = this.sL, sR = this.sR;
    const la = this.lookahead ? this.laSamples : 0;
    const bL = this.laBuf[0], bR = this.laBuf[1], len = this.laLen;
    let w = this.laW;
    for (let i = 0; i < n; i++) {
      let xl = L[i], xr = R[i];
      if (la > 0) {
        bL[w] = xl; bR[w] = xr;
        let j = w - la; if (j < 0) j += len;
        xl = bL[j]; xr = bR[j];
        if (++w >= len) w = 0;
      }
      const el = eL[i], er = eR[i];
      tL[i] = xl * el; tR[i] = xr * er;
      sL[i] = xl - tL[i]; sR[i] = xr - tR[i];
    }
    this.laW = w;

    // ---- the two parts
    const [pt, ps] = this.parts;
    pt.run(tL, tR, n, this.pT, pt.mixTarget(this.pT), this.smooth);
    ps.run(sL, sR, n, this.pS, ps.mixTarget(this.pS), this.smooth);

    // sends (post effect, before the level slider; a muted part sends nothing)
    if (this.tOut >= 0 && this.tOut !== ctx.track && this.pT.on) ctx.sendTo(this.tOut, tL, tR, n, 1, 1);
    if (this.sOut >= 0 && this.sOut !== ctx.track && this.pS.on) ctx.sendTo(this.sOut, sL, sR, n, 1, 1);

    // levels and on/off (smoothed)
    this.gainT.begin(this.pT.level * this.pT.on, n, this.smooth);
    this.gainS.begin(this.pS.level * this.pS.on, n, this.smooth);
    let pout = this.peakOut;
    for (let i = 0; i < n; i++) {
      const gt = this.gainT.next(), gs = this.gainS.next();
      let l = tL[i] * gt + sL[i] * gs;
      let r = tR[i] * gt + sR[i] * gs;
      if (!(l === l) || l > 1e6 || l < -1e6) l = 0; // NaN / runaway guard
      if (!(r === r) || r > 1e6 || r < -1e6) r = 0;
      L[i] = l; R[i] = r;
      const a = l < 0 ? -l : l;
      if (a > pout) pout = a;
    }
    this.peakOut = pout;
    this.gainT.end(); this.gainS.end();
  }

  controls(): ArrayLike<number> {
    return this.ctl;
  }

  monitor(): FxMonitor {
    let k = this.monRead;
    const cnt = (this.monW - k + MON_BUCKETS) % MON_BUCKETS;
    const wave = new Float32Array(cnt * 2);
    const env = new Float32Array(cnt);
    for (let i = 0; i < cnt; i++) {
      wave[2 * i] = this.monMin[k]; wave[2 * i + 1] = this.monMax[k]; env[i] = this.monEnv[k];
      k = (k + 1) % MON_BUCKETS;
    }
    this.monRead = k;
    const m: FxMonitor = { wave, env, rate: this.sr / this.bucket, peakIn: this.peakIn, peakOut: this.peakOut };
    this.peakIn = this.peakOut = 0;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'transmitter',
  create: (sr, bs) => new Transmitter(sr, bs),
};
