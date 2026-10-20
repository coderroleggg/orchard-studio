// Emphasis (FL: Emphasis). Signal flow, after FL's flowchart and measurements
// on FL's binary (docs/research/fx/emphasis.md):
//   input gain -> DC block -> L/R or M/S
//   Stage 1: clean look-ahead limiter (24 ms window, 4-pole attack/release
//            smoothing, linked detection). It takes the share (1 - phi) of the
//            gain reduction in dB; phi comes from the mode, the Emphasis amount,
//            the spectrum (adaptive modes keep bass clean) and transients.
//   Stage 2: per-channel shaping limiter, oversampled 1..16x: instant attack,
//            peak hold 41.7 ms * 2^-hardness, release 10000 smp * 2^-hardness
//            (48 kHz); hardness 9 is close to a hard clipper.
//   Stage 3: brick-wall look-ahead limiter at 0 dBFS (optional true peak).
//   -> output ceiling gain, level matching, delta, bypass. Latency 54 ms.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';

const LATENCY_SEC = 0.054;
/** FL's "Low latency" option (Options menu): shorter look-ahead windows (not with Instant recovery). */
const LOW_LATENCY_SEC = 0.012;
const LOW_W_SCALE = 5 / 24;
const W1_SEC = 0.024; // stage 1 look-ahead window
const HOLD1_SEC = 0.006; // stage 1 post-hold before release
const ATT1_SEC = 0.0041; // stage 1 attack, per pole (4 poles)
const REL1_SEC = 0.00245; // stage 1 release, per pole (4 poles)
const W3_SEC = 0.004; // stage 3 look-ahead
const ATT3_SEC = 0.00055;
const REL3_SEC = 0.0015;
const HOLD3_SEC = 0;
/** Stage 2 look-ahead delay (fixed) and, at hardness 0, window / hold / smoothing; all scale by 2^-x(hardness). */
const D2_SEC = 0.024;
const WA2_SEC = 0.024;
const WB2_SEC = 0.006;
const ATT2_SEC = 0.0041;
const REL2_SEC = 0.00245;
/** Stage 2 time scale relative to stage 1 (fitted to FL's distortion-vs-frequency data). */
const STAGE2_TIME = 2.0;
/** Effective time exponent per hardness step (FL's 8 and 9 are only slightly apart). */
const HARD_EXP = [0, 1, 2, 3, 4, 5, 6, 7, 7.75, 7.95];
const OS_TAPS = 16; // polyphase FIR taps per phase (delay = OS_TAPS base samples)
const LM_SEC = 1.5; // level-matching RMS window
const CHUNK_SEC = 0.0107; // history column for the rolling display
const HIST = 4096;

/** Stage-2 share of the gain reduction for steady signals. */
export function emPhi(mode: number, emph: number, spectral: number, transient: number): number {
  const e = Math.min(1, Math.max(0, emph));
  switch (mode) {
    case 0: return spectral; // Versatile: adaptive, bass is limited cleanly
    case 1: return 0.65 + 0.35 * spectral; // Loud: less protection
    case 2: { // Transient: steady parts get less emphasis than transients
      const e3 = e * e * e;
      const ps = 1 - (1 - e3) * (1 - e3);
      const pt = 1 - (1 - e) * (1 - e) * 0.35; // transients stay emphasised even at low amounts
      return ps + (pt - ps) * transient;
    }
    default: return 1 - (1 - e) * (1 - e); // Steady
  }
}

// ---------------------------------------------------------------------------
// helpers (all buffers allocated up front)

/** Sliding-window extreme (monotonic deque over absolute time stamps). */
class SlidingExt {
  private v: Float64Array;
  private t: Float64Array;
  private head = 0;
  private size = 0;
  private cap: number;
  private isMin: boolean;
  constructor(cap: number, isMin: boolean) {
    this.cap = cap;
    this.isMin = isMin;
    this.v = new Float64Array(cap);
    this.t = new Float64Array(cap);
  }
  clear(): void { this.head = 0; this.size = 0; }
  push(val: number, time: number): void {
    const cap = this.cap;
    if (this.isMin) { while (this.size > 0 && this.v[(this.head + this.size - 1) % cap] >= val) this.size--; }
    else { while (this.size > 0 && this.v[(this.head + this.size - 1) % cap] <= val) this.size--; }
    if (this.size === cap) { this.head = (this.head + 1) % cap; this.size--; }
    const k = (this.head + this.size) % cap;
    this.v[k] = val; this.t[k] = time; this.size++;
  }
  /** Extreme over stamps >= from (empty window: neutral `def`). */
  get(from: number, def: number): number {
    while (this.size > 0 && this.t[this.head] < from) { this.head = (this.head + 1) % this.cap; this.size--; }
    return this.size > 0 ? this.v[this.head] : def;
  }
}

/** Polyphase FIR oversampler (windowed sinc); up + down delay = OS_TAPS base samples. */
class Oversampler {
  readonly n: number;
  private h: Float64Array;
  private xin: Float64Array; // base-rate history (T+1)
  private xp = 0;
  private hi: Float64Array; // high-rate history (len)
  private hp = 0;
  private len: number;
  constructor(n: number) {
    this.n = n;
    const T = OS_TAPS;
    this.len = n * T + 1;
    this.h = new Float64Array(this.len);
    const mid = (this.len - 1) / 2, fc = 0.45 / n;
    let sum = 0;
    for (let i = 0; i < this.len; i++) {
      const x = i - mid;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      // Kaiser-like window (Blackman-Harris for robustness)
      const w = 0.35875 - 0.48829 * Math.cos((2 * Math.PI * i) / (this.len - 1)) + 0.14128 * Math.cos((4 * Math.PI * i) / (this.len - 1)) - 0.01168 * Math.cos((6 * Math.PI * i) / (this.len - 1));
      this.h[i] = sinc * w;
      sum += this.h[i];
    }
    for (let i = 0; i < this.len; i++) this.h[i] /= sum;
    this.xin = new Float64Array(T + 1);
    this.hi = new Float64Array(this.len);
  }
  clear(): void { this.xin.fill(0); this.hi.fill(0); this.xp = 0; this.hp = 0; }
  /** One base sample in, n high-rate samples out. */
  up(x: number, out: Float64Array): void {
    const n = this.n, T = OS_TAPS, h = this.h, xin = this.xin;
    this.xp = (this.xp + 1) % (T + 1);
    xin[this.xp] = x;
    for (let p = 0; p < n; p++) {
      let acc = 0;
      for (let k = 0, j = this.xp; k <= T; k++) {
        const ti = p + k * n;
        if (ti < this.len) acc += h[ti] * xin[j];
        j = j === 0 ? T : j - 1;
      }
      out[p] = acc * n;
    }
  }
  /** n high-rate samples in, one base sample out. */
  down(u: Float64Array): number {
    const n = this.n, len = this.len, h = this.h, hi = this.hi;
    for (let p = 0; p < n; p++) { this.hp = (this.hp + 1) % len; hi[this.hp] = u[p]; }
    let acc = 0;
    for (let k = 0, j = this.hp; k < len; k++) { acc += h[k] * hi[j]; j = j === 0 ? len - 1 : j - 1; }
    return acc;
  }
}

/** Biquad (direct form I) for the K-weighting filters. */
class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
  clear(): void { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
}

function kWeighting(sr: number): [Biquad, Biquad] {
  const s = new Biquad(), h = new Biquad();
  {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / sr), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    s.b0 = (Vh + (Vb * K) / Q + K * K) / a0; s.b1 = (2 * (K * K - Vh)) / a0; s.b2 = (Vh - (Vb * K) / Q + K * K) / a0;
    s.a1 = (2 * (K * K - 1)) / a0; s.a2 = (1 - K / Q + K * K) / a0;
  }
  {
    const f0 = 38.13547087602444, Q = 0.5003270373238773;
    const K = Math.tan((Math.PI * f0) / sr), a0 = 1 + K / Q + K * K;
    h.b0 = 1; h.b1 = -2; h.b2 = 1; h.a1 = (2 * (K * K - 1)) / a0; h.a2 = (1 - K / Q + K * K) / a0;
  }
  return [s, h];
}

const LUFS_BINS = 760; // -70 .. +6 LUFS in 0.1 LU steps

// ---------------------------------------------------------------------------

class EmphasisFx implements EffectInstance {
  latency: number;
  tail: number;
  private sr: number;
  // parameters (targets) and smoothed values
  private p = { bypass: 0, delta: 0, envOrder: 1, truePeak: 0, ms: 0, mode: 0, inDb: 0, link: 1, emph: 1, ceil: 1, lm: 0, os: 2, hard: 7, instant: 0, dc: 0 };
  private gIn = 1; private gIn0 = 1;
  private ceil = 1; private ceil0 = 1;
  private link = 1; private emph = 1;
  private byp = 0; private byp0 = 0; private dlt = 0; private dlt0 = 0;
  // delays
  private L: number; // total latency
  private lowLat = false;
  private dry: Float64Array[]; private dryPos = 0; private dryLen: number;
  private pre: Float64Array[]; private prePos = 0; private preLen: number; private preDelay = 0;
  private w1: number; private hold1: number; private d1: Float64Array[]; private d1Len: number;
  private w3: number; private hold3: number; private d3: Float64Array[]; private d3Len: number;
  private time = 0;
  // stage 1
  private s1min: SlidingExt[];
  private c1a: number; private c1r: number; private c1rInst: number;
  private g1: Float64Array; // 2 channels x 4 poles
  // stage 2
  private osIdx = -1; private ovs: Oversampler[] = []; private upBuf: Float64Array; private dnBuf: Float64Array;
  private s2min: SlidingExt[] = []; private s2g: Float64Array; private s2time = 0;
  private d2: Float64Array[] = []; private d2Len = 1; private d2n = 0; private wa2 = 0; private wb2 = 0;
  private c2a = 1; private c2r = 1;
  private g2min = 1;
  // stage 3
  private s3min: SlidingExt[];
  private c3a: number; private c3r: number; private g3: Float64Array;
  private tpHist: Float64Array[]; private tpPos = 0; private tpTaps: Float64Array;
  // analysis
  private dcx = [0, 0]; private dcy = [0, 0]; private dcR: number;
  private lpS1 = 0; private lpS2 = 0; private lpCoef: number; private lpQ: number;
  private envLp = 0; private envFull = 0; private envRel: number;
  private trFast = 0; private trSlow = 0; private trAtt: number; private trRel: number;
  // level matching
  private lmIn = 1e-9; private lmOut = 1e-9; private lmCoef: number; private lmGain = 1;
  // metering
  private kw: [Biquad, Biquad][] = [];
  private subLen: number; private subPos = 0; private subAcc = 0;
  private subs = new Float64Array(30); private subCount = 0; private subW = 0;
  private binCount = new Float64Array(LUFS_BINS); private binPow = new Float64Array(LUFS_BINS);
  private stMin = Infinity; private stMax = -Infinity; private playing = false;
  private pkL = 0; private pkR = 0; private rmsAccL = 0; private rmsAccR = 0; private rmsN = 0;
  private grSoft = 1; private grHard = 1;
  private chunkLen: number; private chunkPos = 0; private cPk = 0; private cG1 = 1; private cG2 = 1;
  private hPk = new Float32Array(HIST); private hG1 = new Float32Array(HIST); private hG2 = new Float32Array(HIST); private hLu = new Float32Array(HIST);
  private hW = 0; private hR = 0;

  constructor(sr: number) {
    this.sr = sr;
    this.L = 0; this.latency = 0; this.tail = 0; this.dryLen = 1; this.preLen = 1; this.d1Len = 1; this.d3Len = 1;
    this.w1 = 0; this.hold1 = 0; this.w3 = 0; this.hold3 = 0;
    this.dry = []; this.pre = []; this.d1 = []; this.d3 = []; this.s1min = []; this.s3min = [];
    this.configureTiming(false);
    const pole = (sec: number) => 1 - Math.exp(-1 / Math.max(1e-6, sec * sr));
    this.c1a = pole(ATT1_SEC); this.c1r = pole(REL1_SEC); this.c1rInst = pole(REL1_SEC / 4);
    this.c3a = pole(ATT3_SEC); this.c3r = pole(REL3_SEC);
    this.g1 = new Float64Array(8).fill(1);
    this.g3 = new Float64Array(4).fill(1);
    this.s2g = new Float64Array(8).fill(1);
    this.upBuf = new Float64Array(16); this.dnBuf = new Float64Array(16);
    // 4x true-peak interpolator taps (4 phases x 8 taps, windowed sinc)
    this.tpTaps = new Float64Array(32);
    for (let ph = 0; ph < 4; ph++) {
      let s = 0;
      for (let k = 0; k < 8; k++) {
        const t = k - 4 + ph / 4;
        const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
        const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / 4.5);
        this.tpTaps[ph * 8 + k] = sinc * w;
        s += sinc * w;
      }
      for (let k = 0; k < 8; k++) this.tpTaps[ph * 8 + k] /= s;
    }
    this.tpHist = [new Float64Array(8), new Float64Array(8)];
    this.dcR = Math.exp((-2 * Math.PI * 5) / sr);
    // 2nd-order lowpass (SVF) at 120 Hz for the spectral weight
    this.lpCoef = Math.tan((Math.PI * 120) / sr);
    this.lpQ = Math.SQRT1_2;
    this.envRel = 1 - Math.exp(-1 / (0.05 * sr));
    this.trAtt = 1 - Math.exp(-1 / (0.008 * sr));
    this.trRel = Math.exp(-1 / (0.08 * sr));
    this.lmCoef = 1 - Math.exp(-1 / (LM_SEC * sr));
    this.kw = [kWeighting(sr), kWeighting(sr)];
    this.subLen = Math.round(0.1 * sr);
    this.chunkLen = Math.max(32, Math.round(CHUNK_SEC * sr));
    this.setParams({});
    this.reset();
  }

  /** Delay lines and windows for the normal (54 ms) or low-latency timing. */
  private configureTiming(low: boolean): void {
    const sr = this.sr;
    this.lowLat = low;
    const ws = low ? LOW_W_SCALE : 1;
    this.L = Math.round((low ? LOW_LATENCY_SEC : LATENCY_SEC) * sr);
    this.latency = this.L;
    this.tail = this.L / sr + 0.15;
    this.dryLen = Math.max(1, this.L);
    this.dry = [new Float64Array(this.dryLen), new Float64Array(this.dryLen)];
    this.w1 = Math.round(W1_SEC * ws * sr);
    this.hold1 = Math.round(HOLD1_SEC * sr);
    this.d1Len = this.w1 + 1;
    this.d1 = [new Float64Array(this.d1Len), new Float64Array(this.d1Len)];
    this.w3 = Math.round(W3_SEC * (low ? 0.5 : 1) * sr);
    this.hold3 = Math.round(HOLD3_SEC * sr);
    this.d3Len = this.w3 + 1;
    this.d3 = [new Float64Array(this.d3Len), new Float64Array(this.d3Len)];
    this.preLen = this.L + 1;
    this.pre = [new Float64Array(this.preLen), new Float64Array(this.preLen)];
    const capW1 = this.w1 + this.hold1 + 8, capW3 = this.w3 + this.hold3 + 16;
    this.s1min = [new SlidingExt(capW1, true), new SlidingExt(capW1, true)];
    this.s3min = [new SlidingExt(capW3, true), new SlidingExt(capW3, true)];
    this.osIdx = -1; // rebuild stage 2 with the new delay
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number) => { const v = q[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d; };
    const cl = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const P = this.p;
    P.bypass = num('bypass', 0) >= 0.5 ? 1 : 0;
    P.delta = num('delta', 0) >= 0.5 ? 1 : 0;
    P.envOrder = cl(Math.round(num('envOrder', 1)), 1, 4);
    P.truePeak = num('truePeak', 0) >= 0.5 ? 1 : 0;
    P.ms = num('channelMode', 0) >= 0.5 ? 1 : 0;
    P.mode = cl(Math.round(num('mode', 0)), 0, 3);
    P.inDb = (24 * cl(num('inputGain', 0), 0, 10000)) / 10000;
    P.link = cl(num('linking', 10000), 0, 10000) / 10000;
    P.emph = cl(num('emphasis', 10000), 0, 10000) / 10000;
    const cv = cl(num('ceiling', 9912), 0, 10000);
    P.ceil = (Math.pow(11, cv / 10000) - 1) / 10;
    P.lm = num('levelMatch', 0) >= 0.5 ? 1 : 0;
    P.os = cl(Math.round(num('oversampling', 2)), 0, 4);
    P.hard = cl(Math.round(num('hardness', 7)), 0, 9);
    P.instant = num('instantRecovery', 0) >= 0.5 ? 1 : 0;
    P.dc = num('dcBlock', 0) >= 0.5 ? 1 : 0;
    const low = q.lowLatency === true && !P.instant;
    if (low !== this.lowLat) { this.configureTiming(low); this.time = 0; this.s2time = 0; }
    this.configureStage2();
  }

  /** (Re)build the oversampling path when the factor changes; recompute hardness constants. */
  private configureStage2(): void {
    const P = this.p, sr = this.sr;
    const n = [1, 2, 4, 8, 16][P.os];
    const rate = sr * n;
    if (P.os !== this.osIdx) {
      this.osIdx = P.os;
      this.ovs = n > 1 ? [new Oversampler(n), new Oversampler(n), new Oversampler(n), new Oversampler(n)] : [];
      this.d2n = Math.round(D2_SEC * (this.lowLat ? LOW_W_SCALE : 1) * sr) * n; // whole base samples, so the total delay stays exact
      this.d2Len = this.d2n + 1;
      this.d2 = [new Float64Array(this.d2Len), new Float64Array(this.d2Len)];
      const cap = this.d2n + Math.round(WB2_SEC * rate) + 8;
      this.wa2 = -1;
      this.s2min = [new SlidingExt(cap, true), new SlidingExt(cap, true)];
      this.s2g.fill(1);
      this.s2time = 0;
      // keep the total latency: pre-delay absorbs the stage-2 delay and the oversampling filters
      const dos = n > 1 ? OS_TAPS : 0;
      this.preDelay = Math.max(0, this.L - this.w1 - this.d2n / n - this.w3 - dos);
      this.pre[0].fill(0); this.pre[1].fill(0);
    }
    const sc = Math.pow(2, -HARD_EXP[P.hard]);
    const sw = STAGE2_TIME * sc; // window and attack; hold and release follow stage 1's timing
    // Envelope order: longer, more S-shaped release (FL: higher orders give stronger dynamic shifts, less loudness)
    const ord = 1 + 0.25 * (P.envOrder - 1);
    const wa = Math.min(this.d2n, Math.round(WA2_SEC * rate * sw));
    if (wa !== this.wa2) for (const m of this.s2min) m.clear(); // time stamps shift with the window
    this.wa2 = wa;
    this.wb2 = Math.round(WB2_SEC * rate * sc);
    const pole = (sec: number) => 1 - Math.exp(-1 / Math.max(1e-6, sec * rate));
    this.c2a = pole(ATT2_SEC * sc);
    this.c2r = pole(REL2_SEC * sc * ord);
  }

  reset(): void {
    const P = this.p;
    this.gIn = this.gIn0 = Math.pow(10, P.inDb / 20);
    this.ceil = this.ceil0 = P.ceil;
    this.link = P.link; this.emph = P.emph;
    this.byp = this.byp0 = P.bypass; this.dlt = this.dlt0 = P.delta;
    for (const a of [...this.dry, ...this.pre, ...this.d1, ...this.d3, ...this.tpHist]) a.fill(0);
    this.dryPos = this.prePos = this.tpPos = 0;
    this.time = 0; this.s2time = 0;
    for (const s of [...this.s1min, ...this.s3min, ...this.s2min]) s.clear();
    for (const o of this.ovs) o.clear();
    this.g1.fill(1); this.g3.fill(1); this.s2g.fill(1);
    for (const d of this.d2) d.fill(0);
    this.dcx[0] = this.dcx[1] = this.dcy[0] = this.dcy[1] = 0;
    this.lpS1 = this.lpS2 = 0; this.envLp = this.envFull = 0; this.trFast = this.trSlow = 0;
    this.lmIn = this.lmOut = 1e-9; this.lmGain = 1;
    for (const [a, b] of this.kw) { a.clear(); b.clear(); }
    this.resetLufs();
    this.pkL = this.pkR = 0; this.rmsAccL = this.rmsAccR = 0; this.rmsN = 0;
    this.grSoft = this.grHard = 1;
    this.chunkPos = 0; this.cPk = 0; this.cG1 = this.cG2 = 1; this.hW = this.hR = 0;
  }

  private resetLufs(): void {
    this.subPos = 0; this.subAcc = 0; this.subs.fill(0); this.subCount = 0; this.subW = 0;
    this.binCount.fill(0); this.binPow.fill(0); this.stMin = Infinity; this.stMax = -Infinity;
  }

  process(Lb: Float32Array, Rb: Float32Array, n: number, ctx: FxContext): void {
    if (n <= 0) return;
    if (this.playing && !ctx.playing) this.resetLufs(); // FL resets the LUFS meter on stop
    this.playing = ctx.playing;
    const P = this.p;
    // block-rate smoothing (~20 ms) of continuous controls
    const k = 1 - Math.exp(-n / (0.02 * this.sr));
    const gInT = Math.pow(10, P.inDb / 20);
    this.gIn0 = this.gIn; this.gIn += (gInT - this.gIn) * k;
    this.ceil0 = this.ceil; this.ceil += (P.ceil - this.ceil) * k;
    this.link += (P.link - this.link) * k;
    this.emph += (P.emph - this.emph) * k;
    this.byp0 = this.byp; this.byp += (P.bypass - this.byp) * k; if (Math.abs(this.byp - P.bypass) < 1e-4) this.byp = P.bypass;
    this.dlt0 = this.dlt; this.dlt += (P.delta - this.dlt) * k; if (Math.abs(this.dlt - P.delta) < 1e-4) this.dlt = P.delta;
    const inv = 1 / n;
    const dGin = (this.gIn - this.gIn0) * inv, dCeil = (this.ceil - this.ceil0) * inv;
    const dByp = (this.byp - this.byp0) * inv, dDlt = (this.dlt - this.dlt0) * inv;

    const w1 = this.w1, hold1 = this.hold1, w3 = this.w3, hold3 = this.hold3;
    const c1a = this.c1a, c1r = P.instant ? this.c1rInst : this.c1r, hold1e = P.instant ? 0 : hold1;
    const c3a = this.c3a, c3r = this.c3r;
    const os = this.ovs.length > 0, N = os ? this.ovs[0].n : 1;
    const mode = P.mode, ms = P.ms, dc = P.dc, tp = P.truePeak, lm = P.lm;
    const link = this.link, emph = this.emph;
    const g1 = this.g1, g3 = this.g3;
    const up = this.upBuf, dn = this.dnBuf;

    for (let i = 0; i < n; i++) {
      const t = this.time++;
      const rawL = Lb[i], rawR = Rb[i];
      // dry (latency-aligned) path for bypass / delta
      this.dryPos = (this.dryPos + 1) % this.dryLen;
      const dryL = this.dry[0][this.dryPos], dryR = this.dry[1][this.dryPos];
      this.dry[0][this.dryPos] = rawL; this.dry[1][this.dryPos] = rawR;

      const gi = this.gIn0 + dGin * i;
      let xl = rawL * gi, xr = rawR * gi;
      if (dc) {
        const yl = xl - this.dcx[0] + this.dcR * this.dcy[0]; this.dcx[0] = xl; this.dcy[0] = yl; xl = yl;
        const yr = xr - this.dcx[1] + this.dcR * this.dcy[1]; this.dcx[1] = xr; this.dcy[1] = yr; xr = yr;
      }
      let a = xl, b = xr;
      if (ms) { a = (xl + xr) * 0.5; b = (xl - xr) * 0.5; }

      // ---- analysis: spectral weight (bass share) and transientness
      const mono = (a + b) * 0.5;
      {
        const g = this.lpCoef, R2 = 1 / this.lpQ;
        const hp = (mono - (R2 + g) * this.lpS1 - this.lpS2) / (1 + R2 * g + g * g);
        const bp = g * hp + this.lpS1; this.lpS1 = g * hp + bp;
        const lp = g * bp + this.lpS2; this.lpS2 = g * bp + lp;
        // band power ratio (bass share), ~50 ms averages
        this.envLp += this.envRel * (lp * lp - this.envLp);
        this.envFull += this.envRel * (mono * mono - this.envFull);
        const tin = Math.abs(a) + Math.abs(b);
        this.trFast = tin > this.trFast ? tin : this.trFast * this.trRel;
        this.trSlow = tin > this.trSlow ? this.trSlow + this.trAtt * (tin - this.trSlow) : this.trSlow * this.trRel;
      }
      const br = this.envFull > 1e-9 ? Math.min(1, this.envLp / this.envFull) : 0;
      const spectral = Math.min(1, Math.max(0, (0.95 - br) / 0.33));
      const transient = Math.min(1, Math.max(0, (this.trFast / (this.trSlow + 1e-12) - 1.22) * 2));
      const phi = emPhi(mode, emph, spectral, transient);

      // ---- pre-delay (keeps the total latency constant)
      this.prePos = (this.prePos + 1) % this.preLen;
      const rp = (this.prePos - this.preDelay + this.preLen) % this.preLen;
      this.pre[0][this.prePos] = a; this.pre[1][this.prePos] = b;
      const pa = this.pre[0][rp], pb = this.pre[1][rp];

      // ---- stage 1: linked targets, sliding minimum over the look-ahead window, 4-pole smoothing
      const ea = Math.abs(pa), eb = Math.abs(pb), em = ea > eb ? ea : eb;
      const da = ea + (em - ea) * link, db = eb + (em - eb) * link;
      const ta = da > 1 ? Math.pow(da, phi - 1) : 1;
      const tb = db > 1 ? Math.pow(db, phi - 1) : 1;
      this.s1min[0].push(ta, t); this.s1min[1].push(tb, t);
      const from1 = t - w1 - hold1e;
      const ma = this.s1min[0].get(from1, 1), mb = this.s1min[1].get(from1, 1);
      for (let c = 0; c < 2; c++) {
        let v = c === 0 ? ma : mb;
        for (let s = 0; s < 4; s++) {
          const j = c * 4 + s;
          const cur = g1[j];
          g1[j] = cur + (v < cur ? c1a : c1r) * (v - cur);
          v = g1[j];
        }
      }
      const pos1 = t % this.d1Len, rd1 = (t + 1) % this.d1Len; // delay w1
      this.d1[0][pos1] = pa; this.d1[1][pos1] = pb;
      const s1a = this.d1[0][rd1] * g1[3], s1b = this.d1[1][rd1] * g1[7];

      // ---- stage 2: per-channel shaping limiter (oversampled)
      let y2a: number, y2b: number;
      this.g2min = 1;
      if (os) {
        this.ovs[0].up(s1a, up); this.ovs[1].up(s1b, dn);
        for (let p2 = 0; p2 < N; p2++) {
          const tt = this.s2time++;
          up[p2] = this.lim2(0, up[p2], tt);
          dn[p2] = this.lim2(1, dn[p2], tt);
        }
        y2a = this.ovs[2].down(up); y2b = this.ovs[3].down(dn);
      } else {
        const tt = this.s2time++;
        y2a = this.lim2(0, s1a, tt); y2b = this.lim2(1, s1b, tt);
      }
      const g2min = this.g2min;

      // ---- stage 3: brick wall (sample or true peak), look-ahead w3
      let pka = y2a < 0 ? -y2a : y2a, pkb = y2b < 0 ? -y2b : y2b;
      if (tp) {
        this.tpPos = (this.tpPos + 1) & 7;
        this.tpHist[0][this.tpPos] = y2a; this.tpHist[1][this.tpPos] = y2b;
        for (let ph = 1; ph < 4; ph++) {
          let sa = 0, sb = 0;
          for (let kk = 0; kk < 8; kk++) {
            const j = (this.tpPos - 7 + kk + 8) & 7;
            const w = this.tpTaps[ph * 8 + kk];
            sa += w * this.tpHist[0][j]; sb += w * this.tpHist[1][j];
          }
          sa = sa < 0 ? -sa : sa; sb = sb < 0 ? -sb : sb;
          if (sa > pka) pka = sa;
          if (sb > pkb) pkb = sb;
        }
      }
      this.s3min[0].push(pka > 1 ? 1 / pka : 1, t); this.s3min[1].push(pkb > 1 ? 1 / pkb : 1, t);
      const from3 = t - w3 - hold3;
      {
        let v = this.s3min[0].get(from3, 1);
        g3[0] += (v < g3[0] ? c3a : c3r) * (v - g3[0]); v = g3[0];
        g3[1] += (v < g3[1] ? c3a : c3r) * (v - g3[1]);
        v = this.s3min[1].get(from3, 1);
        g3[2] += (v < g3[2] ? c3a : c3r) * (v - g3[2]); v = g3[2];
        g3[3] += (v < g3[3] ? c3a : c3r) * (v - g3[3]);
      }
      const pos3 = t % this.d3Len, rd3 = (t + 1) % this.d3Len;
      this.d3[0][pos3] = y2a; this.d3[1][pos3] = y2b;
      let oa = this.d3[0][rd3] * g3[1], ob = this.d3[1][rd3] * g3[3];
      if (oa > 1) oa = 1; else if (oa < -1) oa = -1;
      if (ob > 1) ob = 1; else if (ob < -1) ob = -1;
      let ol = oa, or = ob;
      if (ms) { ol = oa + ob; or = oa - ob; }

      // ---- output: ceiling, level matching, delta, bypass
      const ce = this.ceil0 + dCeil * i;
      let fl = ol * ce, fr = or * ce;
      // level matching (RMS of input before input gain vs output)
      this.lmIn += this.lmCoef * ((rawL * rawL + rawR * rawR) * 0.5 - this.lmIn);
      this.lmOut += this.lmCoef * ((fl * fl + fr * fr) * 0.5 - this.lmOut);
      if (lm) {
        const tg = Math.min(31.6, Math.max(0.0316, Math.sqrt((this.lmIn + 1e-12) / (this.lmOut + 1e-12))));
        this.lmGain += (tg - this.lmGain) * 0.0005;
        fl *= this.lmGain; fr *= this.lmGain;
      }
      const dl = this.dlt0 + dDlt * i;
      if (dl > 0) {
        // FL: the residual; without level matching it is scaled back by the input gain (ceiling disabled)
        const giD = this.gIn0 + dGin * i;
        const refL = dryL * giD, refR = dryR * giD;
        const rl = lm ? fl - dryL : (ol - refL) / giD, rr = lm ? fr - dryR : (or - refR) / giD;
        fl += (rl - fl) * dl; fr += (rr - fr) * dl;
      }
      const bp = this.byp0 + dByp * i;
      if (bp > 0) { fl += (dryL - fl) * bp; fr += (dryR - fr) * bp; }
      Lb[i] = fl; Rb[i] = fr;

      // ---- metering
      const afl = fl < 0 ? -fl : fl, afr = fr < 0 ? -fr : fr;
      if (afl > this.pkL) this.pkL = afl;
      if (afr > this.pkR) this.pkR = afr;
      this.rmsAccL += fl * fl; this.rmsAccR += fr * fr; this.rmsN++;
      const g1min = g1[3] < g1[7] ? g1[3] : g1[7];
      const g23 = g2min * (g3[1] < g3[3] ? g3[1] : g3[3]);
      if (g1min < this.grSoft) this.grSoft = g1min;
      if (g23 < this.grHard) this.grHard = g23;
      const kl = this.kw[0][1].run(this.kw[0][0].run(fl)), kr = this.kw[1][1].run(this.kw[1][0].run(fr));
      this.subAcc += kl * kl + kr * kr;
      if (++this.subPos >= this.subLen) this.endSubBlock();
      const mpk = afl > afr ? afl : afr;
      if (mpk > this.cPk) this.cPk = mpk;
      if (g1min < this.cG1) this.cG1 = g1min;
      if (g23 < this.cG2) this.cG2 = g23;
      if (++this.chunkPos >= this.chunkLen) {
        const w = this.hW;
        this.hPk[w] = this.cPk; this.hG1[w] = this.cG1; this.hG2[w] = this.cG2; this.hLu[w] = this.lufs(4);
        this.hW = (w + 1) % HIST;
        if (this.hW === this.hR) this.hR = (this.hR + 1) % HIST;
        this.chunkPos = 0; this.cPk = 0; this.cG1 = this.cG2 = 1;
      }
    }
    // denormal / runaway guards
    for (let j = 0; j < 8; j++) if (!(g1[j] > 1e-9 && g1[j] <= 1)) g1[j] = 1;
    for (let j = 0; j < 4; j++) if (!(g3[j] > 1e-9 && g3[j] <= 1)) g3[j] = 1;
    for (let j = 0; j < 8; j++) if (!(this.s2g[j] > 1e-9 && this.s2g[j] <= 1)) this.s2g[j] = 1;
    if (!Number.isFinite(this.lmGain)) this.lmGain = 1;
  }

  /** Stage 2 for one channel at the (over)sampled rate: look-ahead limiter (window and smoothing scaled by hardness). */
  private lim2(c: number, u: number, tt: number): number {
    const dl = this.d2[c], len = this.d2Len, n = this.d2n;
    const w = tt % len;
    dl[w] = u;
    // target of the sample `wa2` ahead of the output position
    const ahead = dl[(tt - (n - this.wa2) + len * 4) % len];
    const av = ahead < 0 ? -ahead : ahead;
    const sm = this.s2min[c];
    sm.push(av > 1 ? 1 / av : 1, tt - (n - this.wa2));
    const v0 = sm.get(tt - n - this.wb2, 1);
    const g = this.s2g;
    const a = this.c2a, r = this.c2r;
    let v = v0;
    for (let s = 0; s < 4; s++) {
      const j = c * 4 + s, cur = g[j];
      g[j] = cur + (v < cur ? a : r) * (v - cur);
      v = g[j];
    }
    const out = dl[(tt - n + len * 4) % len];
    if (v < this.g2min) this.g2min = v;
    return out * v;
  }

  private endSubBlock(): void {
    const ms = this.subAcc / this.subLen;
    this.subAcc = 0; this.subPos = 0;
    this.subs[this.subW] = ms;
    this.subW = (this.subW + 1) % 30;
    if (this.subCount < 30) this.subCount++;
    if (this.subCount >= 4) {
      const l = this.lufs(4);
      if (l > -70) {
        const bin = Math.min(LUFS_BINS - 1, Math.max(0, Math.floor((l + 70) * 10)));
        this.binCount[bin] += 1;
        this.binPow[bin] += Math.pow(10, (l + 0.691) / 10);
      }
    }
    if (this.subCount >= 30) {
      const st = this.lufs(30);
      if (st > -70) { if (st < this.stMin) this.stMin = st; if (st > this.stMax) this.stMax = st; }
    }
  }

  /** Loudness of the last k sub-blocks (k = 4: momentary, 30: short term). */
  private lufs(k: number): number {
    const m = Math.min(k, this.subCount);
    if (m === 0) return -Infinity;
    let s = 0;
    for (let j = 1; j <= m; j++) s += this.subs[(this.subW - j + 30) % 30];
    const p = s / m;
    return p > 1e-20 ? -0.691 + 10 * Math.log10(p) : -Infinity;
  }

  private integrated(): number {
    let c = 0, s = 0;
    for (let i = 0; i < LUFS_BINS; i++) { c += this.binCount[i]; s += this.binPow[i]; }
    if (c === 0) return -Infinity;
    const rel = -0.691 + 10 * Math.log10(s / c) - 10;
    const b0 = Math.max(0, Math.floor((rel + 70) * 10));
    c = 0; s = 0;
    for (let i = b0; i < LUFS_BINS; i++) { c += this.binCount[i]; s += this.binPow[i]; }
    return c > 0 ? -0.691 + 10 * Math.log10(s / c) : -Infinity;
  }

  monitor(): FxMonitor {
    const n = (this.hW - this.hR + HIST) % HIST;
    const pk: number[] = new Array(n), g1: number[] = new Array(n), g2: number[] = new Array(n), lu: number[] = new Array(n);
    for (let j = 0, r = this.hR; j < n; j++, r = (r + 1) % HIST) { pk[j] = this.hPk[r]; g1[j] = this.hG1[r]; g2[j] = this.hG2[r]; lu[j] = this.hLu[r]; }
    this.hR = this.hW;
    const rn = Math.max(1, this.rmsN);
    const m: FxMonitor = {
      pkL: this.pkL, pkR: this.pkR, rmsL: Math.sqrt(this.rmsAccL / rn), rmsR: Math.sqrt(this.rmsAccR / rn),
      grSoft: this.grSoft, grHard: this.grHard,
      lufsM: this.lufs(4), lufsS: this.lufs(30), lufsI: this.integrated(),
      rangeLo: Number.isFinite(this.stMin) ? this.stMin : -Infinity, rangeHi: Number.isFinite(this.stMax) ? this.stMax : -Infinity,
      hPk: pk, hG1: g1, hG2: g2, hLu: lu, chunk: this.chunkLen / this.sr,
    };
    this.pkL = this.pkR = 0; this.rmsAccL = this.rmsAccR = 0; this.rmsN = 0; this.grSoft = this.grHard = 1;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'emphasis',
  create: (sampleRate) => new EmphasisFx(sampleRate),
};
