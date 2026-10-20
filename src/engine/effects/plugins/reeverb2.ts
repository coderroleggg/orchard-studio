// Reeverb 2 (FL: Fruity Reeverb 2). Measured against FL's own plugin: the late
// reverb is a Dattorro-style "figure-8" tank, with FL's own taps and
// coefficient laws; with modulation off it matches FL's impulse response
// sample for sample at room size 50 (see docs/research/fx/reeverb2.md).
//
// Signal flow (mono input = (L+R)/2, or (L-R)/2 in SIDE mode, where the
// reverb's right output is also inverted so the reverb returns as side signal):
//   high cut (one-pole) -> low cut (one-pole) -> diffuser 1 -+-> ER taps L/R
//                                                           +-> predelay -> diffusers 2..4 -> tank
//   tank half (x2): input + other half -> damping LP -> AP1 (modulated) -> D1 -> AP2 -> D2 -> bass shelf -> x decay
//   7 output taps per channel inside the tank; ER + wet -> stereo separation (M/S width); + dry.
// All delays scale with (room size + 15); allpass gains follow g = base^((room+15)/D).

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';

// Dattorro's delay lengths (samples at 29761 Hz) used by FL's tank, scaled by S48 * (room + 15) at 48 kHz.
const S48 = 0.0208682;
const DIFF_IN = [142, 107, 379, 277];
const SEG = [
  [672, 4453, 1800, 3720], // left half: AP1, D1, AP2, D2
  [908, 4217, 2656, 3163], // right half
];
const AP1 = 0, D1 = 1, AP2 = 2, D2 = 3;
/** Output taps: sign, half, segment, offset (48 kHz samples at room 50, where the scale is REF_S). */
const REF_S = 1.35643;
const TAPS: [number, number, number, number][][] = [
  [[1, 1, D1, 360], [1, 0, D1, 2292], [-1, 1, D1, 4034], [1, 0, AP2, 253], [-1, 1, AP2, 2594], [1, 0, D2, 2124], [-1, 1, D2, 3385]],
  [[1, 0, D1, 478], [-1, 1, D1, 2456], [1, 0, D1, 4920], [1, 1, AP2, 454], [-1, 0, AP2, 2344], [1, 1, D2, 842], [-1, 0, D2, 4304]],
];
/**
 * Decay applied to each tap, in output time order (identical for L and R in FL).
 * FL applies the decay in two equal stages per tank half (gain gs each) and
 * gives a tap inside a stage the linear blend of the stage's end gains:
 * stage position F -> gs^floor(F) * lerp(1, gs, frac(F)). Measured from 0.5 to 20 s.
 */
const TAP_STAGE = [0, 0.4, 0.75, 1, 1.3, 1.5, 1.8];
export const TAP_GAIN = 0.463325;
/** Average half-loop length (Dattorro samples): FL applies the same decay to both halves. */
const HALF_AVG = 10794.5;
/**
 * FL's decay knob: at room 50 each tank half decays by exactly 60 dB x
 * (10548 samples / 48 kHz) / T (measured from 0.5 to 20 s), so the RT60 is
 * 1.38813 x the set time (the half loop is 14642 samples there).
 */
const RT_RATIO = (HALF_AVG * S48 * 65) / 10548;
const ER_GAIN = [0.17587, 0.1668];
/** ER tap delays (48 kHz samples per room unit, offset 3). */
const ER_DELAY = [17.4646, 13.2727];
/** Modulation: 200 samples at 44.1 kHz peak to peak at 100% depth. */
const MOD_EXCURSION_S = 200 / 44100;
const LN1000 = Math.log(1000);

/** One-pole low-pass pole with an exact -3 dB point at fc (FL's damping / high cut). */
export function onePolePole(fc: number, fs: number): number {
  const w = (2 * Math.PI * Math.min(fc, fs * 0.49)) / fs;
  const c = 2 - Math.cos(w);
  return c - Math.sqrt(c * c - 1);
}

/**
 * Bilinear one-pole low-pass pole (FL's bass crossover; no frequency prewarp):
 * H(z) = (1 - p) / 2 * (1 + 1/z) / (1 - p/z), p = (1 - t) / (1 + t), t = pi fc / fs.
 */
export function bltPole(fc: number, fs: number): number {
  const t = (Math.PI * Math.min(fc, fs * 100)) / fs; // FL: unclamped (cut shelf corner = cross / G)
  return (1 - t) / (1 + t);
}

/** FL's dry level curve (Reeverb 2): 0..160, 128 = unity. */
export function dryGain(v: number): number {
  return (Math.pow(11, v / 128) - 1) / 10;
}

/** FL's ER / wet level curve (Reeverb 2). */
export function wetGain(v: number): number {
  return (Math.pow(11, v / 256) - 1) / (Math.sqrt(11) - 1);
}

/** Stereo separation -> M/S width (2 = 100% separated, 0 = merged). */
export function sepWidth(v: number): number {
  return v < 0 ? 1 - v / 64 : 1 - (Math.pow(5, v / 64) - 1) / 4;
}

function pow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

interface Params {
  lowCut: number; highCut: number; predelay: number; room: number; diffusion: number; decay: number;
  damping: number; bass: number; cross: number; sep: number; dry: number; er: number; wet: number;
  modSpeed: number; modDepth: number; side: boolean; tempo: boolean;
  /** Overrides used by the legacy Reeverb (linear levels, predelay in ms); NaN = unused. */
  ovDry: number; ovWet: number; ovEr: number; ovPredelayMs: number;
}

const DEFAULTS: Params = {
  lowCut: 75, highCut: 40, predelay: 0, room: 50, diffusion: 100, decay: 15, damping: 40, bass: 100, cross: 500,
  sep: 0, dry: 128, er: 128, wet: 87, modSpeed: 684, modDepth: 0, side: false, tempo: false,
  ovDry: NaN, ovWet: NaN, ovEr: NaN, ovPredelayMs: NaN,
};

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

export class Reeverb2 implements EffectInstance {
  private fs: number;
  private p: Params = { ...DEFAULTS };
  latency = 0;
  tail = 3;

  // delay buffers (power-of-two sizes for room 100 at this rate)
  private dinBuf: Float32Array[] = [];
  private dinMask: number[] = [];
  private dinW = [0, 0, 0, 0];
  private seg: Float32Array[][] = [[], []];
  private segMask: number[][] = [[], []];
  private segW = [[0, 0, 0, 0], [0, 0, 0, 0]];
  private erBuf: Float32Array;
  private erMask: number;
  private erW = 0;
  private pdBuf: Float32Array;
  private pdMask: number;
  private pdW = 0;

  // size: current scale (glides toward the target when the room size changes)
  private sCur = 0;
  private sTgt = 0;
  // predelay (samples, glides)
  private pdCur = 0;
  private pdTgt = 0;

  // coefficients (targets and smoothed values)
  private gin = 0.7; private ginT = 0.7;
  private gt = 0.64; private gtT = 0.64;
  private g2 = 0.43; private g2T = 0.43;
  private ghalf = 0.5; private ghalfT = 0.5;
  private lnr = -1e-4;
  private hcB = 0; private hcOn = true;
  private lcP = 0; private lcC = 1; private lcOn = true;
  private dampB = 0; private dampOn = true;
  private shelfK = 0; private shelfKT = 0; private shelfB = 0;
  // output gains (per-block ramps)
  private gDry = 1; private gDryT = 1;
  private gWet = 0.35; private gWetT = 0.35;
  private gEr = 0.35; private gErT = 0.35;
  private width = 1; private widthT = 1;
  private modExc = 0; // peak-to-peak samples
  private modFreq = 0.47;
  private modPhase = 0;
  private tapGain = new Float64Array(7);

  // filter / tank state
  private hcY = 0; private lcX = 0; private lcY = 0;
  private dampY = [0, 0];
  private shelfY = [0, 0];
  private shelfX = [0, 0];
  private peak = 0;

  constructor(fs: number) {
    this.fs = fs;
    const sMax = S48 * 115 * (fs / 48000) + 1e-9;
    for (let k = 0; k < 4; k++) {
      const n = pow2(Math.ceil(DIFF_IN[k] * sMax) + 4);
      this.dinBuf.push(new Float32Array(n)); this.dinMask.push(n - 1);
    }
    const modMax = Math.ceil(MOD_EXCURSION_S * fs) + 4;
    for (let h = 0; h < 2; h++) {
      for (let k = 0; k < 4; k++) {
        const n = pow2(Math.ceil(SEG[h][k] * sMax) + (k === AP1 ? modMax : 0) + 4);
        this.seg[h].push(new Float32Array(n)); this.segMask[h].push(n - 1);
      }
    }
    const erN = pow2(Math.ceil(ER_DELAY[0] * 103 * (fs / 48000)) + 4);
    this.erBuf = new Float32Array(erN); this.erMask = erN - 1;
    // predelay: up to 1 s, or 8 steps at 20 BPM in tempo mode (capped at 6 s)
    const pdN = pow2(Math.ceil(fs * 6) + 4);
    this.pdBuf = new Float32Array(pdN); this.pdMask = pdN - 1;
    this.compute(130);
    this.snap();
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Partial<Record<keyof Params, unknown>>;
    const p = this.p;
    p.lowCut = num(q.lowCut, DEFAULTS.lowCut);
    p.highCut = num(q.highCut, DEFAULTS.highCut);
    p.predelay = num(q.predelay, DEFAULTS.predelay);
    p.room = Math.min(100, Math.max(1, num(q.room, DEFAULTS.room)));
    p.diffusion = Math.min(100, Math.max(0, num(q.diffusion, DEFAULTS.diffusion)));
    p.decay = Math.min(200, Math.max(1, num(q.decay, DEFAULTS.decay)));
    p.damping = num(q.damping, DEFAULTS.damping);
    p.bass = Math.min(300, Math.max(20, num(q.bass, DEFAULTS.bass)));
    p.cross = Math.min(2000, Math.max(25, num(q.cross, DEFAULTS.cross)));
    p.sep = Math.min(64, Math.max(-64, num(q.sep, DEFAULTS.sep)));
    p.dry = Math.min(160, Math.max(0, num(q.dry, DEFAULTS.dry)));
    p.er = Math.min(160, Math.max(0, num(q.er, DEFAULTS.er)));
    p.wet = Math.min(160, Math.max(0, num(q.wet, DEFAULTS.wet)));
    p.modSpeed = Math.min(2048, Math.max(0, num(q.modSpeed, DEFAULTS.modSpeed)));
    p.modDepth = Math.min(2048, Math.max(0, num(q.modDepth, DEFAULTS.modDepth)));
    p.side = !!q.side;
    p.tempo = !!q.tempo;
    p.ovDry = num(q.ovDry, NaN); p.ovWet = num(q.ovWet, NaN); p.ovEr = num(q.ovEr, NaN); p.ovPredelayMs = num(q.ovPredelayMs, NaN);
    this.compute(this.lastTempo);
  }

  private lastTempo = 130;
  /** No audio processed since creation / reset. */
  private fresh = true;

  /** Targets from the parameters (cheap; called on edits and tempo changes). */
  private compute(tempo: number): void {
    const p = this.p, fs = this.fs;
    this.lastTempo = tempo;
    const r15 = p.room + 15;
    this.sTgt = S48 * r15 * (fs / 48000);
    const D = p.diffusion / 100;
    this.ginT = D > 0 ? Math.pow(0.5, r15 / 130 / D) : 0;
    this.gtT = D > 0 ? Math.exp((-0.0067718 * r15) / D) : 0;
    this.g2T = D > 0 ? Math.exp((-0.013131 * r15) / D) : 0;
    const T = p.decay / 10;
    this.lnr = -LN1000 / (RT_RATIO * T * fs);
    const halfLn = this.lnr * HALF_AVG * this.sTgt;
    this.ghalfT = Math.exp(halfLn);
    // bass multiplier: LF loss per pass = HF loss * (1 + m) / (2 m)
    const m = p.bass / 100;
    const G = Math.exp((-halfLn * (m - 1)) / (2 * m));
    this.shelfKT = G - 1;
    this.shelfB = bltPole(G >= 1 ? p.cross : p.cross / G, fs);
    this.hcOn = p.highCut < 221;
    this.hcB = this.hcOn ? onePolePole(p.highCut * 100, fs) : 0;
    this.lcOn = p.lowCut > 19;
    if (this.lcOn) {
      const t = Math.tan((Math.PI * Math.min(p.lowCut, fs * 0.45)) / fs);
      this.lcP = (1 - t) / (1 + t);
      this.lcC = (1 + this.lcP) / 2;
    }
    this.dampOn = p.damping < 221;
    this.dampB = this.dampOn ? onePolePole(p.damping * 100, fs) : 0;
    this.gDryT = Number.isNaN(p.ovDry) ? dryGain(p.dry) : p.ovDry;
    this.gWetT = Number.isNaN(p.ovWet) ? wetGain(p.wet) : p.ovWet;
    this.gErT = Number.isNaN(p.ovEr) ? wetGain(p.er) : p.ovEr;
    this.widthT = sepWidth(p.sep);
    this.modExc = (p.modDepth / 2048) * MOD_EXCURSION_S * fs;
    const sp = p.modSpeed / 2048;
    this.modFreq = 0.1 + 9.9 * sp * sp * sp;
    const v = Math.round(p.predelay);
    if (!Number.isNaN(p.ovPredelayMs)) {
      const ms = Math.max(0, Math.round(p.ovPredelayMs));
      this.pdTgt = ms > 0 ? Math.min(this.pdMask - 2, Math.round((ms * fs) / 1000) - 1) : 0;
    } else if (p.tempo) {
      const sec = (v / 192) * (60 / Math.max(10, tempo));
      this.pdTgt = Math.min(this.pdMask - 2, Math.max(0, Math.round(sec * fs) - 1));
    } else {
      this.pdTgt = v > 0 ? Math.round((v * fs) / 384) - 1 : 0;
    }
    const gs = Math.exp(halfLn / 2);
    for (let k = 0; k < 7; k++) {
      const F = TAP_STAGE[k], i = Math.floor(F), fr = F - i;
      this.tapGain[k] = TAP_GAIN * Math.pow(gs, i) * (1 - fr + fr * gs);
    }
    // tail: predelay + 1.25 x the longest RT60 + one tank loop
    const rt = RT_RATIO * T * Math.max(1, (2 * m) / (1 + m));
    this.tail = this.pdTgt / fs + 1.25 * rt + (2 * HALF_AVG * this.sTgt) / fs + 0.2;
  }

  /** Jump every smoothed value to its target (reset / creation). */
  private snap(): void {
    this.sCur = this.sTgt; this.pdCur = this.pdTgt;
    this.gin = this.ginT; this.gt = this.gtT; this.g2 = this.g2T; this.ghalf = this.ghalfT; this.shelfK = this.shelfKT;
    this.gDry = this.gDryT; this.gWet = this.gWetT; this.gEr = this.gErT; this.width = this.widthT;
  }

  reset(): void {
    for (const b of this.dinBuf) b.fill(0);
    for (const h of this.seg) for (const b of h) b.fill(0);
    this.erBuf.fill(0); this.pdBuf.fill(0);
    this.hcY = this.lcX = this.lcY = 0;
    this.dampY[0] = this.dampY[1] = 0;
    this.shelfY[0] = this.shelfY[1] = 0;
    this.shelfX[0] = this.shelfX[1] = 0;
    this.modPhase = 0;
    this.peak = 0;
    this.fresh = true;
    this.snap();
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (this.p.tempo && ctx.tempo !== this.lastTempo) {
      this.compute(ctx.tempo);
      if (this.fresh) this.pdCur = this.pdTgt; // first block after a reset: no glide
    }
    this.fresh = false;
    const fs = this.fs;
    // ---- per-block smoothing (~20 ms coefficient glide, ~60 ms size glide)
    const a = 1 - Math.exp(-n / (0.02 * fs));
    this.gin += (this.ginT - this.gin) * a;
    this.gt += (this.gtT - this.gt) * a;
    this.g2 += (this.g2T - this.g2) * a;
    this.ghalf += (this.ghalfT - this.ghalf) * a;
    this.shelfK += (this.shelfKT - this.shelfK) * a;
    const as = 1 - Math.exp(-n / (0.06 * fs));
    let gliding = false;
    if (this.sCur !== this.sTgt) {
      this.sCur += (this.sTgt - this.sCur) * as;
      if (Math.abs(this.sCur - this.sTgt) < 1e-4 * this.sTgt) this.sCur = this.sTgt;
      gliding = true;
    }
    const pd0 = this.pdCur;
    if (this.pdCur !== this.pdTgt) {
      this.pdCur += (this.pdTgt - this.pdCur) * as;
      if (Math.abs(this.pdCur - this.pdTgt) < 0.5) this.pdCur = this.pdTgt;
    }
    const pd1 = this.pdCur;
    const s = this.sCur;

    // delay lengths for this block (integer unless the size glides)
    const g = gliding;
    const dinLen0 = lenOf(DIFF_IN[0], s, g), dinLen1 = lenOf(DIFF_IN[1], s, g);
    const dinLen2 = lenOf(DIFF_IN[2], s, g), dinLen3 = lenOf(DIFF_IN[3], s, g);
    const lA1L = lenOf(SEG[0][AP1], s, g), lD1L = lenOf(SEG[0][D1], s, g), lA2L = lenOf(SEG[0][AP2], s, g), lD2L = lenOf(SEG[0][D2], s, g);
    const lA1R = lenOf(SEG[1][AP1], s, g), lD1R = lenOf(SEG[1][D1], s, g), lA2R = lenOf(SEG[1][AP2], s, g), lD2R = lenOf(SEG[1][D2], s, g);
    const rs = s / REF_S;
    const roomK = (this.p.room + 3) * (fs / 48000);
    const erL = Math.max(1, Math.round(ER_DELAY[0] * roomK)), erR = Math.max(1, Math.round(ER_DELAY[1] * roomK));

    const gin = this.gin, gt = this.gt, g2 = this.g2, ghalf = this.ghalf;
    const hcOn = this.hcOn, hcB = this.hcB, lcOn = this.lcOn, lcP = this.lcP, lcC = this.lcC;
    const dampOn = this.dampOn, dampB = this.dampB;
    const shK = this.shelfK, shB = this.shelfB, shA = (1 - shB) / 2, shOn = Math.abs(shK) > 1e-9;
    const side = this.p.side;

    const dB0 = this.dinBuf[0], dB1 = this.dinBuf[1], dB2 = this.dinBuf[2], dB3 = this.dinBuf[3];
    const dM0 = this.dinMask[0], dM1 = this.dinMask[1], dM2 = this.dinMask[2], dM3 = this.dinMask[3];
    let dW0 = this.dinW[0], dW1 = this.dinW[1], dW2 = this.dinW[2], dW3 = this.dinW[3];
    const sL = this.seg[0], sR = this.seg[1], mL = this.segMask[0], mR = this.segMask[1];
    const bA1L = sL[0], bD1L = sL[1], bA2L = sL[2], bD2L = sL[3];
    const bA1R = sR[0], bD1R = sR[1], bA2R = sR[2], bD2R = sR[3];
    const kA1L = mL[0], kD1L = mL[1], kA2L = mL[2], kD2L = mL[3];
    const kA1R = mR[0], kD1R = mR[1], kA2R = mR[2], kD2R = mR[3];
    const wL = this.segW[0], wR = this.segW[1];
    let wA1L = wL[0], wD1L = wL[1], wA2L = wL[2], wD2L = wL[3];
    let wA1R = wR[0], wD1R = wR[1], wA2R = wR[2], wD2R = wR[3];
    const erB = this.erBuf, erM = this.erMask;
    let erW = this.erW;
    const pdB = this.pdBuf, pdM = this.pdMask;
    let pdW = this.pdW;

    // taps: precomputed buffer / mask / offset for this block
    const tb = TB, tm = TM, to = TO, tg = TG;
    for (let c = 0; c < 2; c++) {
      for (let k = 0; k < 7; k++) {
        const tp = TAPS[c][k];
        const sg = tp[0], h = tp[1], sgi = tp[2], off = tp[3];
        const i = c * 7 + k;
        tb[i] = this.seg[h][sgi];
        tm[i] = this.segMask[h][sgi];
        to[i] = Math.round(off * rs) + 1; // read after this sample's write
        tg[i] = sg * this.tapGain[k];
        TH[i] = h * 4 + sgi;
      }
    }

    // modulation of both AP1 delays (unipolar, linear interpolation like FL)
    const exc = this.modExc * 0.5;
    const modOn = exc > 0;
    const dph = (2 * Math.PI * this.modFreq) / fs;
    let ph = this.modPhase;

    let hcY = this.hcY, lcX = this.lcX, lcY = this.lcY;
    let dYL = this.dampY[0], dYR = this.dampY[1], shYL = this.shelfY[0], shYR = this.shelfY[1];
    let shXL = this.shelfX[0], shXR = this.shelfX[1];

    // output levels: FL's per-block slew (linear toward the target, at most 0.001 x 44100 / sr
    // per sample; each sample uses the value before its step), measured on the dry level
    // (dry); ER and wet slew the same (11^x - 1) / 10 value, so their gains move at most
    // 0.01 / (sqrt 11 - 1) x 44100 / sr per sample (measured); the width ramps across the block
    const lim = 0.001 * (44100 / fs), limEw = lim * (10 / (Math.sqrt(11) - 1));
    const slew = (a: number, b: number, l: number) => { const d = (b - a) / n; return d > l ? l : d < -l ? -l : d; };
    // the legacy Reeverb (level overrides) switches its levels at once (measured)
    if (!Number.isNaN(this.p.ovDry)) { this.gDry = this.gDryT; this.gWet = this.gWetT; this.gEr = this.gErT; }
    const g0d = this.gDry, g0w = this.gWet, g0e = this.gEr, w0 = this.width;
    const dd = slew(g0d, this.gDryT, lim), dw = slew(g0w, this.gWetT, limEw), de = slew(g0e, this.gErT, limEw), dwd = (this.widthT - w0) / n;
    const inv = 1 / n;
    let pk = this.peak;
    const fracRead = gliding;

    for (let i = 0; i < n; i++) {
      const t = i * inv;
      const inL = L[i], inR = R[i];
      let x = side ? (inL - inR) * 0.5 : (inL + inR) * 0.5;
      if (hcOn) { hcY = (1 - hcB) * x + hcB * hcY; x = hcY; }
      if (lcOn) { const y = lcC * (x - lcX) + lcP * lcY; lcX = x; lcY = y; x = y; }
      // diffuser 1
      let v = fracRead ? readF(dB0, dM0, dW0, dinLen0) : dB0[(dW0 - dinLen0) & dM0];
      let w = x + gin * v; x = v - gin * w; dB0[dW0] = w; dW0 = (dW0 + 1) & dM0;
      // early reflections: diffuser-1 output delayed
      erB[erW] = x;
      const eL = erB[(erW - erL) & erM], eR = erB[(erW - erR) & erM];
      erW = (erW + 1) & erM;
      // predelay
      pdB[pdW] = x;
      const pdc = pd0 + (pd1 - pd0) * t;
      let y: number;
      if (pdc <= 0) y = x;
      else { const pi = Math.floor(pdc), pf = pdc - pi; const j = pdW - pi; y = pdB[j & pdM] + pf * (pdB[(j - 1) & pdM] - pdB[j & pdM]); }
      pdW = (pdW + 1) & pdM;
      // diffusers 2..4
      v = fracRead ? readF(dB1, dM1, dW1, dinLen1) : dB1[(dW1 - dinLen1) & dM1];
      w = y + gin * v; y = v - gin * w; dB1[dW1] = w; dW1 = (dW1 + 1) & dM1;
      v = fracRead ? readF(dB2, dM2, dW2, dinLen2) : dB2[(dW2 - dinLen2) & dM2];
      w = y + gin * v; y = v - gin * w; dB2[dW2] = w; dW2 = (dW2 + 1) & dM2;
      v = fracRead ? readF(dB3, dM3, dW3, dinLen3) : dB3[(dW3 - dinLen3) & dM3];
      w = y + gin * v; y = v - gin * w; dB3[dW3] = w; dW3 = (dW3 + 1) & dM3;

      // ---- tank: crossfeed = end of each half (bass shelf, half decay)
      let fL = fracRead ? readF(bD2L, kD2L, wD2L, lD2L) : bD2L[(wD2L - lD2L) & kD2L];
      let fR = fracRead ? readF(bD2R, kD2R, wD2R, lD2R) : bD2R[(wD2R - lD2R) & kD2R];
      if (shOn) {
        shYL = shA * (fL + shXL) + shB * shYL; shXL = fL; fL += shK * shYL;
        shYR = shA * (fR + shXR) + shB * shYR; shXR = fR; fR += shK * shYR;
      }
      fL *= ghalf; fR *= ghalf;
      if (fL < 1e-30 && fL > -1e-30) fL = 0;
      if (fR < 1e-30 && fR > -1e-30) fR = 0;
      let uL = y + fR, uR = y + fL;
      if (dampOn) { dYL = (1 - dampB) * uL + dampB * dYL; uL = dYL; dYR = (1 - dampB) * uR + dampB * dYR; uR = dYR; }
      // AP1 (modulated)
      const mo = modOn ? exc * (1 + Math.sin(ph)) : 0;
      let d1 = lA1L + mo, d2 = lA1R + mo;
      v = modOn || fracRead ? readF(bA1L, kA1L, wA1L, d1) : bA1L[(wA1L - d1) & kA1L];
      w = uL + gt * v; uL = v - gt * w; bA1L[wA1L] = w; wA1L = (wA1L + 1) & kA1L;
      v = modOn || fracRead ? readF(bA1R, kA1R, wA1R, d2) : bA1R[(wA1R - d2) & kA1R];
      w = uR + gt * v; uR = v - gt * w; bA1R[wA1R] = w; wA1R = (wA1R + 1) & kA1R;
      // D1
      d1 = fracRead ? readF(bD1L, kD1L, wD1L, lD1L) : bD1L[(wD1L - lD1L) & kD1L];
      bD1L[wD1L] = uL; wD1L = (wD1L + 1) & kD1L; uL = d1;
      d2 = fracRead ? readF(bD1R, kD1R, wD1R, lD1R) : bD1R[(wD1R - lD1R) & kD1R];
      bD1R[wD1R] = uR; wD1R = (wD1R + 1) & kD1R; uR = d2;
      // AP2 (the delay holds x + g*y: FL's output taps read inside it)
      v = fracRead ? readF(bA2L, kA2L, wA2L, lA2L) : bA2L[(wA2L - lA2L) & kA2L];
      let o = v - g2 * uL; bA2L[wA2L] = uL + g2 * o; wA2L = (wA2L + 1) & kA2L; uL = o;
      v = fracRead ? readF(bA2R, kA2R, wA2R, lA2R) : bA2R[(wA2R - lA2R) & kA2R];
      o = v - g2 * uR; bA2R[wA2R] = uR + g2 * o; wA2R = (wA2R + 1) & kA2R; uR = o;
      // D2 write
      bD2L[wD2L] = uL; wD2L = (wD2L + 1) & kD2L;
      bD2R[wD2R] = uR; wD2R = (wD2R + 1) & kD2R;
      if (modOn) { ph += dph; if (ph > 6.283185307179586) ph -= 6.283185307179586; }

      // ---- output taps (read after this sample's writes)
      SEGW[0] = wA1L; SEGW[1] = wD1L; SEGW[2] = wA2L; SEGW[3] = wD2L;
      SEGW[4] = wA1R; SEGW[5] = wD1R; SEGW[6] = wA2R; SEGW[7] = wD2R;
      let oL = 0, oR = 0;
      for (let k = 0; k < 7; k++) {
        oL += tg[k] * tb[k][(SEGW[TH[k]] - to[k]) & tm[k]];
        const k2 = k + 7;
        oR += tg[k2] * tb[k2][(SEGW[TH[k2]] - to[k2]) & tm[k2]];
      }
      const gw = g0w + dw * i, ge = g0e + de * i;
      let rL = oL * gw + eL * ER_GAIN[0] * ge;
      let rR = oR * gw + eR * ER_GAIN[1] * ge;
      const wd = w0 + dwd * i;
      const mid = (rL + rR) * 0.5, sd = (rL - rR) * 0.5 * wd;
      rL = mid + sd; rR = side ? sd - mid : mid - sd; // SIDE: the reverb's right output is inverted
      const gd = g0d + dd * i;
      const outL = inL * gd + rL, outR = inR * gd + rR;
      L[i] = outL; R[i] = outR;
      const al = rL < 0 ? -rL : rL, ar = rR < 0 ? -rR : rR;
      if (al > pk) pk = al;
      if (ar > pk) pk = ar;
    }
    if (hcY < 1e-30 && hcY > -1e-30) hcY = 0;
    if (lcY < 1e-30 && lcY > -1e-30) { lcY = 0; }
    if (dYL < 1e-30 && dYL > -1e-30) dYL = 0;
    if (dYR < 1e-30 && dYR > -1e-30) dYR = 0;
    if (shYL < 1e-30 && shYL > -1e-30) shYL = 0;
    if (shYR < 1e-30 && shYR > -1e-30) shYR = 0;
    this.hcY = hcY; this.lcX = lcX; this.lcY = lcY;
    this.dampY[0] = dYL; this.dampY[1] = dYR; this.shelfY[0] = shYL; this.shelfY[1] = shYR;
    this.shelfX[0] = shXL; this.shelfX[1] = shXR;
    this.dinW[0] = dW0; this.dinW[1] = dW1; this.dinW[2] = dW2; this.dinW[3] = dW3;
    wL[0] = wA1L; wL[1] = wD1L; wL[2] = wA2L; wL[3] = wD2L;
    wR[0] = wA1R; wR[1] = wD1R; wR[2] = wA2R; wR[3] = wD2R;
    this.erW = erW; this.pdW = pdW;
    this.modPhase = ph;
    // end of the block's slew (exactly the target once within reach)
    this.gDry = Math.abs(this.gDryT - g0d) <= lim * n ? this.gDryT : g0d + dd * n;
    this.gWet = Math.abs(this.gWetT - g0w) <= limEw * n ? this.gWetT : g0w + dw * n;
    this.gEr = Math.abs(this.gErT - g0e) <= limEw * n ? this.gErT : g0e + de * n;
    this.width = this.widthT;
    this.peak = pk;
  }

  monitor(): FxMonitor {
    const m = { peak: this.peak, room: this.p.room };
    this.peak = 0;
    return m;
  }
}

// scratch tables shared by instances (filled per block, used single-threaded)
const TB: Float32Array[] = new Array(14);
const TM = new Int32Array(14);
const TO = new Int32Array(14);
const TG = new Float64Array(14);
const TH = new Int32Array(14);
const SEGW = new Int32Array(8);

/** Delay length for a Dattorro length at scale s: FL truncates; fractional while the size glides. */
function lenOf(base: number, s: number, gliding: boolean): number {
  const x = base * s;
  return Math.max(1, gliding ? x : Math.floor(x));
}

/** Linear-interpolated read `d` samples back from write index w (d >= 1). */
function readF(b: Float32Array, m: number, w: number, d: number): number {
  const di = Math.floor(d), f = d - di;
  const j = w - di;
  const a = b[j & m];
  return a + f * (b[(j - 1) & m] - a);
}

export const effect: EffectModule = {
  id: 'reeverb2',
  create: (sampleRate) => new Reeverb2(sampleRate),
};
