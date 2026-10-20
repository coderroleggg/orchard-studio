// Vintage Phaser (FL: Vintage Phaser), a Small Stone style phaser. Calibrated
// against FL's binary (flfxhost); see docs/research/fx/vphaser.md:
// - input high-pass (5..200 Hz) on everything, then dry (delayed by the 44
//   samples of latency) and the phaser, mixed linearly (Mix 0..100 % wet);
// - the phaser runs 4x oversampled (HQ: V1 8x, V2 16x): four identical
//   first-order allpasses at the Min..Max frequency (bilinear, prewarped at
//   the oversampled rate), feedback 0.9 x Feedback;
//   V1: linear, feedback one (oversampled) sample late, Feedback HP on the
//   loop and the output; V2: OTA stages whose integrating and
//   output currents saturate (Drive 0..30 dB in / out), delay-free feedback with the
//   Feedback HP inside the loop only, then FL's output filter (an FIR copy of
//   its measured response: steep low-pass near 20 kHz, ~4 samples later);
//   Invert feedback works in both engines;
// - LFO (triangle / sine, phase from 0, R = L + LR Phase) through the
//   Tension curve and the depth scale / pull-down laws, sweeping the stage
//   frequency exponentially between Min and Max (or Manual frequency);
// - colour low shelf (RBJ, Q 0.5) on the mix, noise, then the delay (on the
//   whole output, echo level = Delay mix, stereo per channel, feedback through
//   first-order low / high-pass, 43 ms glide or a 100 ms crossfade with Keep pitch);
// - as in FL, every other control applies at once (no glides).

import type { EffectInstance, EffectModule, FxContext } from '../types';
import {
  vphaserFreq, vphaserRateFreq, vphaserSyncTicks, vphaserDelayMs, vphaserDelayLpHz, vphaserDelayHpHz,
  vphaserHpHz, vphaserColorHz, vphaserNoise,
} from '../../../model/fx/plugins/vphaser';

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const F = Math.fround;
const TWO_PI = 2 * Math.PI;
const LATENCY = 44;
/** Samples by which FL's LFO leads the input (measured). */
const LFO_LEAD = 22;
/** V2 stage frequency factor (2^(1/400), measured 1.00174). */
const V2_FREQ = Math.pow(2, 1 / 400);
/** OTA saturation scales (V2): the integrating current and the output current,
 *  fitted to FL's compression and 3rd-harmonic level and phase. */
const OTA_K1 = 0.18;
const OTA_K2 = 0.115;
/** Linearise-and-solve passes per oversampled sample for the V2 loop. */
const V2_PASSES = 1;
/** Tension curve constant k(t) of s -> (1 - e^-ks) / (1 - e^-k), measured. */
const TENSION_T = [0, 0.05, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1];
const TENSION_K = [0, 0.055, 0.1299, 0.3898, 0.5848, 0.8247, 1.4394, 2.1841, 2.9988, 3.8434, 4.2782, 4.708, 5.5827, 6.4523];

/** V2 output filter (FL's measured response relative to the 44-sample latency; HQ off / on). */
const V2_OUT = new Float64Array([-2.24381e-05, 0.000563957, 0.0206932, 0.182101, 0.554602, 0.49716, -0.242701, -0.158637, 0.278229, -0.185916, 0.0310957, 0.0922126, -0.151532, 0.151532, -0.112104, 0.0550811, 0.00199642, -0.0477787, 0.0767736, -0.0880782, 0.08389, -0.0681452, 0.0454232, -0.0201501, -0.00392011, 0.0239895, -0.038313, 0.0461569, -0.0476623, 0.0436506, -0.0354042, 0.0244463, -0.0123412, 0.000527758, 0.00980498, -0.0177968, 0.0229505, -0.025126, 0.0245011, -0.0215078, 0.0167538, -0.0109388, 0.00477355, 0.0010907, -0.00611725, 0.00992076, -0.0122843, 0.0131638, -0.012637, 0.0109658, -0.00847023, 0.00543611, -0.00221969, -0.000823022, 0.00340045, -0.00531414, 0.0064637, -0.00683913, 0.00650666, -0.00559081, 0.00425456, -0.00267922, 0.00104524, 0.00048428, -0.00177667, 0.00273827, -0.00331844, 0.00350908, -0.00334011, 0.00287208, -0.0021866, 0.00137602, -0.000533321, -0.000256841, 0.000925225, -0.00142273, 0.00172264, -0.00182043, 0.00173154, -0.00148737, 0.0011304, -0.00070871, 0.000270708, 0.000139569, -0.000486135, 0.000743531, -0.000897972, 0.000947251, -0.000899521, 0.000771257, -0.000584645, 0.000364754, -0.000136782, -7.63875e-05, 0.000256095, -0.000389182, 0.000468578, -0.000493237, 0.000467499, -0.000400009, 0.000302368, -0.000187648, 6.89617e-05, 4.1805e-05, -0.000134983, 0.000202905, -0.0002404, 0.00024709, -0.000226708, 0.000186028, -0.000133467, 7.76317e-05, -2.60391e-05, -1.57879e-05, 4.47798e-05, -6.03141e-05, 6.38251e-05, -5.8155e-05, 4.68023e-05, -3.32106e-05, 2.02144e-05, -9.70811e-06, 2.55656e-06, 1.28616e-06, -2.51155e-06, 2.12634e-06, -1.13509e-06, 2.97988e-07]);
const V2_OUT_HQ = new Float64Array([5.414e-05, 0.000108723, 0.01019, 0.151637, 0.581212, 0.52312, -0.318212, -0.0318135, 0.20917, -0.237912, 0.190034, -0.116706, 0.0450293, 0.0135899, -0.0562146, 0.0838775, -0.0991301, 0.104825, -0.103574, 0.097555, -0.0884854, 0.0776653, -0.066047, 0.0543062, -0.0429044, 0.0321423, -0.0222019, 0.0131792, -0.00510953, -0.00201372, 0.008225, -0.0135764, 0.0181302, -0.0219536, 0.0251153, -0.0276825, 0.0297199, -0.0312881, 0.0324436, -0.0332379, 0.0337183, -0.0339272, 0.0339028, -0.0336793, 0.033287, -0.0327528, 0.0321007, -0.0313482, 0.0305367, -0.0296387, 0.0286535, -0.0276624, 0.0266859, -0.0257148, 0.0247364, -0.0237431, 0.0227339, -0.0217121, 0.0206836, -0.0196558, 0.0186357, -0.01763, 0.0166446, -0.0156842, 0.0147527, -0.013853, 0.0129871, -0.0121564, 0.0113616, -0.0106031, 0.00988056, -0.00919365, 0.00854159, -0.00792347, 0.00733821, -0.00678466, 0.00626157, -0.00576766, 0.00530165, -0.00486223, 0.00444812, -0.00405807, 0.00369083, -0.00334522, 0.00302009, -0.00271433, 0.00242689, -0.00215675, 0.00190294, -0.00166455, 0.00144071, -0.00123059, 0.0010334, -0.000848403, 0.000674902, -0.000512233, 0.000359772, -0.000216929, 8.31493e-05, 4.20921e-05, -0.000159288, 0.000268905, -0.000371379, 0.000467123, -0.000556527, 0.000637218, -0.000705525, 0.000760167, -0.000800277, 0.000825401, -0.000835497, 0.000830918, -0.000812392, 0.000780985, -0.000738067, 0.000685266, -0.000624419, 0.000557524, -0.000486686, 0.000414061, -0.00034181, 0.000272042, -0.000206769, 0.000147864, -9.70183e-05, 5.57088e-05, -2.51699e-05, 6.37098e-06]);

// ---- FIR resampling --------------------------------------------------------

/**
 * First (1x <-> 2x) stage: a linear-phase square-root-Nyquist filter (designed
 * so that up + down is flat to 22 kHz like FL's, which also folds the band edge
 * the same way: -1.77 dB at 22 kHz for a 1.8 kHz phaser). Centre tap first.
 */
const HALF_79 = [0.507070416, 0.317921184, -0.00714920886, -0.105119366, 0.00710073366, 0.0620456797, -0.00700936914, -0.0432391376, 0.00689267888, 0.0325203939, -0.00673513004, -0.0255035708, 0.00655493855, 0.0204783951, -0.00633720365, -0.0166760186, 0.00610074912, 0.0136624437, -0.00583125476, -0.0112169729, 0.00554809566, 0.00917354417, -0.00523747313, -0.00745491589, 0.00491925507, 0.00597698327, -0.00458010904, -0.00471130209, 0.00424034191, 0.00360302151, -0.0038870142, -0.00263975678, 0.00354068123, 0.00177079121, -0.00318806036, -0.000969089894, 0.00284655024, 0.000109924423, -0.00248193509, 0.00142529475];
const HALF_75 = [0.50744178, 0.318037811, -0.00732830761, -0.105107939, 0.00726958454, 0.0619952429, -0.00718549774, -0.0431401751, 0.00705701182, 0.0323976144, -0.00690513053, -0.0253397593, 0.00671147088, 0.020296244, -0.00649768544, -0.0164575762, 0.00624603557, 0.0134299573, -0.00597881332, -0.0109519794, 0.00567891525, 0.00889749985, -0.0053692669, -0.00714806572, 0.00503340179, 0.00565864285, -0.00469489249, -0.00435805137, 0.00433792786, 0.00322748082, -0.00398668515, -0.00220490852, 0.0036255558, 0.00125660713, -0.00327654773, -0.00023315997, 0.00290530366, -0.00161875596];

function symmetric(half: number[]): Float64Array {
  const m = half.length - 1, h = new Float64Array(2 * m + 1);
  for (let i = 0; i <= m; i++) { h[m + i] = half[i]; h[m - i] = half[i]; }
  return h;
}

/**
 * Least-squares linear-phase low-pass for a later resampling stage running at
 * `R` x the base rate: flat to the base Nyquist, stopping the images that start
 * at (R - 1) / 2 x the base rate (weight 0.3: +-0.003 dB, 55..75 dB down).
 */
function lsLowpass(n: number, R: number): Float64Array {
  const m = (n - 1) / 2, cols = m + 1;
  const ata = new Float64Array(cols * cols), atb = new Float64Array(cols);
  const row = new Float64Array(cols);
  const add = (f: number, target: number, w: number) => {
    row[0] = 1;
    for (let k = 1; k <= m; k++) row[k] = 2 * Math.cos(TWO_PI * f * k);
    for (let a = 0; a < cols; a++) {
      atb[a] += w * w * row[a] * target;
      for (let b = 0; b < cols; b++) ata[a * cols + b] += w * w * row[a] * row[b];
    }
  };
  for (let i = 0; i <= 300; i++) add((0.5 / R) * (i / 300), 1, 1);
  const s0 = (R - 1) / (2 * R);
  for (let i = 0; i <= 600; i++) add(s0 + (0.5 - s0) * (i / 600), 0, 0.3);
  // Gaussian elimination
  for (let c = 0; c < cols; c++) {
    let p = c;
    for (let r = c + 1; r < cols; r++) if (Math.abs(ata[r * cols + c]) > Math.abs(ata[p * cols + c])) p = r;
    if (p !== c) {
      for (let k = 0; k < cols; k++) { const t = ata[c * cols + k]; ata[c * cols + k] = ata[p * cols + k]; ata[p * cols + k] = t; }
      const t = atb[c]; atb[c] = atb[p]; atb[p] = t;
    }
    for (let r = c + 1; r < cols; r++) {
      const f = ata[r * cols + c] / ata[c * cols + c];
      for (let k = c; k < cols; k++) ata[r * cols + k] -= f * ata[c * cols + k];
      atb[r] -= f * atb[c];
    }
  }
  const x = new Float64Array(cols);
  for (let c = cols - 1; c >= 0; c--) {
    let v = atb[c];
    for (let k = c + 1; k < cols; k++) v -= ata[c * cols + k] * x[k];
    x[c] = v / ata[c * cols + c];
  }
  const h = new Float64Array(n);
  h[m] = x[0];
  for (let k = 1; k <= m; k++) { h[m + k] = x[k]; h[m - k] = x[k]; }
  return h;
}

/** x2 interpolator (zero stuffing + FIR with gain 2), polyphase. */
class Up2 {
  private readonly ev: Float64Array;
  private readonly od: Float64Array;
  private readonly hist: Float64Array;
  private readonly len: number;
  private p = 0;
  constructor(h: Float64Array) {
    const ne = (h.length + 1) >> 1, no = h.length >> 1;
    this.ev = new Float64Array(ne); this.od = new Float64Array(no);
    for (let j = 0; j < ne; j++) this.ev[j] = 2 * h[2 * j];
    for (let j = 0; j < no; j++) this.od[j] = 2 * h[2 * j + 1];
    this.len = ne;
    this.hist = new Float64Array(2 * ne);
  }
  run(x: number, out: Float64Array, k: number): void {
    const len = this.len, hist = this.hist;
    this.p = this.p === 0 ? len - 1 : this.p - 1;
    const p = this.p;
    hist[p] = x; hist[p + len] = x;
    let a = 0, b = 0;
    const ev = this.ev, od = this.od;
    for (let j = 0; j < ev.length; j++) a += ev[j] * hist[p + j];
    for (let j = 0; j < od.length; j++) b += od[j] * hist[p + j];
    out[k] = a; out[k + 1] = b;
  }
  clear(): void { this.hist.fill(0); }
}

/** x2 decimator: FIR, keeps the outputs at the even input indices. */
class Down2 {
  private readonly h: Float64Array;
  private readonly hist: Float64Array;
  private readonly len: number;
  private p = 0;
  constructor(h: Float64Array) {
    this.h = h; this.len = h.length;
    this.hist = new Float64Array(2 * h.length);
  }
  /** Push an even then an odd sample; returns the output at the even one. */
  run(a: number, b: number): number {
    const len = this.len, hist = this.hist, h = this.h;
    this.p = this.p === 0 ? len - 1 : this.p - 1;
    let p = this.p;
    hist[p] = a; hist[p + len] = a;
    let y = 0;
    for (let j = 0; j < len; j++) y += h[j] * hist[p + j];
    this.p = this.p === 0 ? len - 1 : this.p - 1;
    p = this.p;
    hist[p] = b; hist[p + len] = b;
    return y;
  }
  clear(): void { this.hist.fill(0); }
}

/** Up / down chain for one channel: factor 2^stages, 44 samples of latency in total. */
class Resampler {
  readonly factor: number;
  private readonly ups: Up2[];
  private readonly downs: Down2[];
  private readonly bufs: Float64Array[];
  constructor(lengths: number[]) {
    this.ups = []; this.downs = []; this.bufs = [];
    let f = 1;
    for (let i = 0; i < lengths.length; i++) {
      f *= 2;
      // the later stages only have to stay flat to 22 kHz and remove distant images
      const n = lengths[i];
      const h = i === 0 ? symmetric(n === 75 ? HALF_75 : HALF_79) : lsLowpass(n, f);
      this.ups.push(new Up2(h)); this.downs.push(new Down2(h));
      this.bufs.push(new Float64Array(f));
    }
    this.factor = f;
  }
  /** One input sample -> `factor` samples in out. */
  up(x: number, out: Float64Array): void {
    const st = this.ups.length;
    let cur = this.bufs[0];
    this.ups[0].run(x, cur, 0);
    for (let s = 1; s < st; s++) {
      const nxt = this.bufs[s], prev = cur, m = prev.length, u = this.ups[s];
      for (let i = 0; i < m; i++) u.run(prev[i], nxt, 2 * i);
      cur = nxt;
    }
    for (let i = 0; i < cur.length; i++) out[i] = cur[i];
  }
  /** `factor` processed samples -> one output sample. */
  down(inp: Float64Array): number {
    let cur = inp, len = this.factor;
    for (let s = this.downs.length - 1; s >= 1; s--) {
      const m = len >> 1, nxt = this.bufs[s - 1], d = this.downs[s];
      for (let i = 0; i < m; i++) nxt[i] = d.run(cur[2 * i], cur[2 * i + 1]);
      cur = nxt; len = m;
    }
    return this.downs[0].run(cur[0], cur[1]);
  }
  clear(): void { for (const u of this.ups) u.clear(); for (const d of this.downs) d.clear(); }
}

// filter lengths per oversampling factor (latency sum (N - 1) / 2^stage = 44)
const CHAIN: Record<number, number[]> = { 4: [79, 21], 8: [79, 17, 9], 16: [75, 21, 9, 17] };

// ---- phaser core -------------------------------------------------------------

/** One channel's phaser at the oversampled rate. */
class Core {
  // V1
  readonly z = new Float64Array(4);
  fbPrev = 0;
  hpS = 0;           // feedback / output HP (V1: TDF, V2: TPT integrator)
  // V2
  readonly s = new Float64Array(4);
  readonly c = new Float64Array([1, 1, 1, 1]);   // integrator current gain (linearised)
  readonly d = new Float64Array([1, 1, 1, 1]);   // output current gain (linearised)
  clear(): void { this.z.fill(0); this.s.fill(0); this.c.fill(1); this.d.fill(1); this.fbPrev = 0; this.hpS = 0; }
}

// ---- small filters at the base rate -------------------------------------------

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

function lowShelf(f0: number, gdb: number, sr: number): Biquad {
  const A = Math.pow(10, gdb / 40), w0 = (TWO_PI * Math.min(f0, sr * 0.45)) / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * 0.5), sa = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 + (A - 1) * cw + sa;
  return {
    b0: (A * (A + 1 - (A - 1) * cw + sa)) / a0, b1: (2 * A * (A - 1 - (A + 1) * cw)) / a0, b2: (A * (A + 1 - (A - 1) * cw - sa)) / a0,
    a1: (-2 * (A - 1 + (A + 1) * cw)) / a0, a2: (A + 1 + (A - 1) * cw - sa) / a0,
  };
}

/** tanh(x) / x (Lambert's continued fraction, 7th order: 1e-7 accurate to |x| = 4.97). */
function tanhRatio(x: number): number {
  const ax = x < 0 ? -x : x;
  if (ax >= 4.97) return 1 / ax;
  const q = x * x;
  return (135135 + q * (17325 + q * (378 + q))) / (135135 + q * (62370 + q * (3150 + q * 28)));
}

/** Zero tiny filter states (denormal safety in long silences). */
const flush = (v: number) => (v > 1e-30 || v < -1e-30 ? v : 0);

/** First-order bilinear coefficient pair k = tan(pi f / sr). */
const kOf = (f: number, sr: number) => Math.tan((Math.PI * Math.min(f, sr * 0.49)) / sr);

class VintagePhaser implements EffectInstance {
  readonly latency = LATENCY;
  private readonly sr: number;
  // resampling: [4x, 8x, 16x] per channel
  private readonly rs: Record<number, Resampler[]> = {};
  private readonly up: Record<number, Float64Array> = { 4: new Float64Array(4), 8: new Float64Array(8), 16: new Float64Array(16) };
  private readonly flushList: Float64Array[];
  private readonly cores = [new Core(), new Core()];
  private readonly gs = new Float64Array(4);
  private readonly dens = new Float64Array(4);
  private factor = 4;
  // dry delay line (44 samples)
  private readonly dry = [new Float64Array(64), new Float64Array(64)];
  private dw = 0;
  // input HP state (TDF first order), per channel
  private readonly inS = new Float64Array(2);
  // V2 output FIR history
  private readonly firH = [new Float64Array(256), new Float64Array(256)];
  private fp = 0;
  // colour shelf
  private shelf: Biquad | null = null;
  private readonly shS = new Float64Array(4);
  // noise
  private seed = 0x2468ace1;
  private readonly nLp = new Float64Array(2);
  private gateEnv = 0;
  private gateGain = 0;
  // delay
  private readonly dbuf: Float32Array[];
  private readonly dmask: number;
  private dwp = 0;
  private dCur = 0; private dOld = 0; private xf = 1;
  private readonly fbState = new Float64Array(2);
  private readonly dHpS = new Float64Array(2);
  private readonly dLpS = new Float64Array(2);
  private delayGain = 0;
  // LFO
  private phase = 0;
  private wasPlaying = false;
  // settings
  private engine = 1;
  private hq = false;
  private manual = false;
  private lfoSine = false;
  private tensionK = 0;
  private lr = 0;
  private startPh = 0;
  private speedX = 0;
  private rateHz = 0.025;
  private sync = false;
  private syncTicks = 6144;
  private scale = 1;
  private pull = 0;
  private logMinT = Math.log(87.24); private logMin = Math.log(87.24);
  private logMaxT = Math.log(2326.61); private logMax = Math.log(2326.61);
  private logManT = Math.log(1.25); private logMan = Math.log(1.25);
  private fbT = 0.45; private fb = 0.45;
  private mixT = 0.5; private mix = 0.5;
  private drive = 1;
  private invert = false;
  private inK = 0;
  private hpFbF = 5;
  private mono = false;
  private noiseT = 0; private noise = 0;
  private gate = false;
  private delayOn = false;
  private keepPitch = false;
  private delayMixT = 0; private delayMix = 0;
  private delayFbT = 0; private delayFb = 0;
  private delayTimeV = 1;
  private delaySync = false;
  private dTarget = 0;
  private dlpK = 0;
  private dhpK = 0;
  private readonly stGain = new Float64Array(4); // L direct, L echo, R direct, R echo
  private primed = false;

  constructor(sr: number) {
    this.sr = sr;
    for (const f of [4, 8, 16]) this.rs[f] = [new Resampler(CHAIN[f]), new Resampler(CHAIN[f])];
    let len = 1;
    while (len < Math.ceil(6 * sr) + 8) len <<= 1;
    this.dbuf = [new Float32Array(len), new Float32Array(len)];
    this.dmask = len - 1;
    this.flushList = [this.inS, this.shS, this.fbState, this.dHpS, this.dLpS, this.nLp];
    this.setParams({});
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const sr = this.sr;
    this.engine = num(q.engine, 1) >= 0.5 ? 1 : 0;
    const hq = num(q.hq, 0) >= 0.5;
    this.hq = hq;
    this.factor = hq ? (this.engine ? 16 : 8) : 4;
    this.manual = num(q.manual, 0) >= 0.5;
    this.lfoSine = num(q.lfoType, 0) >= 0.5;
    const t = clamp(num(q.tension, 0) / 6000, 0, 1);
    let k = 0;
    for (let i = 1; i < TENSION_T.length; i++) {
      if (t <= TENSION_T[i]) { const u = (t - TENSION_T[i - 1]) / (TENSION_T[i] - TENSION_T[i - 1]); k = TENSION_K[i - 1] + u * (TENSION_K[i] - TENSION_K[i - 1]); break; }
    }
    this.tensionK = k;
    this.lr = clamp(num(q.lrPhase, 0), 0, 6000) / 6000;
    this.startPh = clamp(num(q.startPhase, 0), 0, 6000) / 6000;
    const speed = clamp(num(q.speed, 1), 1, 245760);
    this.speedX = (speed - 1) / 245759;
    const r1 = vphaserRateFreq(num(q.rate1, 25)), r2 = vphaserRateFreq(num(q.rate2, 150000));
    this.rateHz = r1 * Math.pow(r2 / r1, this.speedX);
    this.sync = num(q.sync, 0) >= 0.5;
    this.syncTicks = vphaserSyncTicks(speed);
    this.scale = clamp(num(q.lfoScale, 6000) / 6000, 0, 1);
    this.pull = clamp(num(q.lfoPull, 0) / 6000, 0, 1);
    this.logMinT = Math.log(vphaserFreq(num(q.minFreq, 896070)));
    this.logMaxT = Math.log(vphaserFreq(num(q.maxFreq, 1588996)));
    this.logManT = Math.log(vphaserFreq(num(q.manualFreq, 125)));
    // (FL's manual says V1 only, but V2 inverts its feedback too)
    this.invert = num(q.invertFb, 0) >= 0.5;
    this.fbT = 0.9 * (clamp(num(q.feedback, 3000), 0, 6000) / 6000) * (this.invert ? -1 : 1);
    this.mixT = clamp(num(q.mix, 50), 0, 100) / 100;
    this.drive = this.engine ? Math.pow(10, (30 * clamp((num(q.drive, 5000) - 5000) / 645000, 0, 1)) / 20) : 1;
    this.inK = kOf(vphaserHpHz(num(q.inputHp, 2000)), sr);
    this.hpFbF = vphaserHpHz(num(q.feedbackHp, 2000));
    this.mono = num(q.mono, 0) >= 0.5;
    this.noiseT = vphaserNoise(num(q.noise, 0));
    this.gate = num(q.gate, 0) >= 0.5;
    const cg = (30 * clamp(num(q.colorGain, 0), 0, 6000)) / 6000;
    this.shelf = cg > 1e-6 ? lowShelf(vphaserColorHz(num(q.colorFreq, 5000)), cg, sr) : null;
    // delay
    this.delayOn = num(q.delayOn, 0) >= 0.5;
    this.keepPitch = num(q.keepPitch, 0) >= 0.5;
    this.delayMixT = clamp(num(q.delayMix, 0), 0, 6000) / 6000;
    this.delayFbT = clamp(num(q.delayFeedback, 0), 0, 6000) / 6000;
    this.delayTimeV = clamp(Math.round(num(q.delayTime, 1)), 1, 768);
    this.delaySync = num(q.delaySync, 0) >= 0.5;
    this.dlpK = kOf(vphaserDelayLpHz(num(q.delayLp, 3200)), sr);
    this.dhpK = kOf(vphaserDelayHpHz(num(q.delayHp, 2000)), sr);
    // stereo: quadratic laws measured from FL (equal power at the ends and centre)
    const st = clamp(num(q.delayStereo, 3000), 0, 6000);
    const qq = st <= 3000 ? st / 3000 : (6000 - st) / 3000;
    const K = 1 - Math.SQRT1_2;
    const near = qq + K * qq * (1 - qq);                       // 0 .. 1
    const far = Math.SQRT2 - (Math.SQRT2 - 1 - K) * qq - K * qq * qq; // sqrt 2 .. 1
    if (st <= 3000) { this.stGain[0] = near; this.stGain[1] = far; this.stGain[2] = far; this.stGain[3] = near; }
    else { this.stGain[0] = far; this.stGain[1] = near; this.stGain[2] = near; this.stGain[3] = far; }
    // FL applies every control at once (the delay time glides, see process)
    this.fb = this.fbT; this.mix = this.mixT; this.noise = this.noiseT; this.delayMix = this.delayMixT; this.delayFb = this.delayFbT;
    this.logMin = this.logMinT; this.logMax = this.logMaxT; this.logMan = this.logManT;
    this.delayGain = this.delayOn ? 1 : 0;
  }

  private rnd(): number {
    let s = this.seed;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.seed = s;
    return (s >>> 0) / 2147483648 - 1;
  }

  /** Normalised sweep position for an LFO value u in [-1, 1]. */
  private sweep(u: number): number {
    let s = 0.5 * (1 + u);
    const k = this.tensionK;
    if (k > 1e-6) s = (1 - Math.exp(-k * s)) / (1 - Math.exp(-k));
    const x = this.speedX;
    const top = 1 - this.pull * x * x * x * x;
    const depth = 1 - (1 - this.scale) * x;
    return top - depth * (1 - s);
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    const sr = this.sr;
    if (!this.primed) {
      this.primed = true;
      this.dTarget = this.delaySamples(ctx);
      this.dCur = this.settle(0, this.dTarget); this.dOld = this.dCur;
    }
    // LFO increment (tempo sync restarts at Start phase plus the song position)
    let inc: number;
    if (this.sync) {
      const stepSec = 60 / Math.max(1, ctx.tempo) / 4;
      inc = 1 / ((this.syncTicks / 48) * stepSec * sr);
      if (ctx.playing && !this.wasPlaying) {
        const steps = (ctx.pos / Math.max(1, ctx.ppq)) * 4;
        this.phase = (((steps / (this.syncTicks / 48) + this.startPh) % 1) + 1) % 1;
      }
    } else inc = this.rateHz / sr;
    this.wasPlaying = ctx.playing;
    // delay target (glide or crossfade)
    const dT = this.delaySamples(ctx);
    if (dT !== this.dTarget) {
      this.dTarget = dT;
      if (this.keepPitch) { this.dOld = this.dCur; this.dCur = dT; this.xf = 0; }
    }
    const factor = this.factor;
    const rsL = this.rs[factor][0], rsR = this.rs[factor][1];
    const upBuf = this.up[factor];
    const osr = sr * factor;
    const kGlide = F(1 - Math.exp(-1 / (0.0434 * sr)));
    const v2 = this.engine === 1;
    const hpG = kOf(this.hpFbF, osr);
    const hpB0 = 1 / (1 + hpG), hpA1 = (hpG - 1) / (hpG + 1);
    const inB0 = 1 / (1 + this.inK), inA1 = (this.inK - 1) / (this.inK + 1);
    const D = this.drive, invD = 1 / D;
    const fir = this.hq ? V2_OUT_HQ : V2_OUT;
    const sh = this.shelf;
    const gateRel = Math.exp(-1 / (0.1 * sr)), gateAtt = Math.exp(-1 / (0.002 * sr));
    const nK = 1 - Math.exp((-TWO_PI * 100) / sr);
    let phase = this.phase;
    for (let i = 0; i < n; i++) {
      let xl = L[i], xr = R[i];
      if (this.mono) { const m = 0.5 * (xl + xr); xl = m; xr = m; }
      // LFO and stage frequencies
      let uL = 0, uR = 0;
      if (!this.manual) {
        // FL runs the LFO in step with the oversampled core: half the latency ahead
        let pl = phase + LFO_LEAD * inc; if (pl >= 1) pl -= 1;
        let pr = pl + this.lr; if (pr >= 1) pr -= 1;
        uL = this.lfoSine ? Math.sin(TWO_PI * pl) : (pl < 0.25 ? 4 * pl : pl < 0.75 ? 2 - 4 * pl : 4 * pl - 4);
        uR = this.lfoSine ? Math.sin(TWO_PI * pr) : (pr < 0.25 ? 4 * pr : pr < 0.75 ? 2 - 4 * pr : 4 * pr - 4);
      }
      phase += inc;
      if (phase >= 1) phase -= 1;
      let fcL: number, fcR: number;
      if (this.manual) { fcL = fcR = Math.exp(this.logMan); }
      else {
        const span = this.logMax - this.logMin;
        fcL = Math.exp(this.logMin + span * this.sweep(uL));
        fcR = Math.exp(this.logMin + span * this.sweep(uR));
      }
      // V2's OTA stages sit 3 cents higher than the nominal frequency (measured x1.00173)
      const fs = v2 ? V2_FREQ : 1;
      const gL = Math.tan((Math.PI * clamp(fcL * fs, 0.5, 21000)) / osr), gR = Math.tan((Math.PI * clamp(fcR * fs, 0.5, 21000)) / osr);
      // input high-pass (first order, bilinear) on everything
      let y = inB0 * xl + this.inS[0]; this.inS[0] = -inB0 * xl - inA1 * y; xl = y;
      y = inB0 * xr + this.inS[1]; this.inS[1] = -inB0 * xr - inA1 * y; xr = y;
      // dry, delayed by the latency
      const dw = this.dw;
      this.dry[0][dw] = xl; this.dry[1][dw] = xr;
      const dr = (dw - LATENCY + 64) & 63;
      const dryL = this.dry[0][dr], dryR = this.dry[1][dr];
      this.dw = (dw + 1) & 63;
      // wet: oversampled phaser
      const wl = this.runCore(this.cores[0], rsL, xl, gL, upBuf, v2, hpB0, hpA1, hpG, D, invD);
      const wr = this.runCore(this.cores[1], rsR, xr, gR, upBuf, v2, hpB0, hpA1, hpG, D, invD);
      let ol = dryL + this.mix * (wl - dryL), or = dryR + this.mix * (wr - dryR);
      // V2: FL's output filter on the whole mix
      if (v2) {
        const fh = this.fp;
        const hl = this.firH[0], hr = this.firH[1];
        hl[fh] = ol; hl[fh + 128] = ol; hr[fh] = or; hr[fh + 128] = or;
        let al = 0, ar = 0;
        for (let j = 0; j < 128; j++) { const c = fir[j]; al += c * hl[fh + j]; ar += c * hr[fh + j]; }
        ol = al; or = ar;
        this.fp = fh === 0 ? 127 : fh - 1;
      }
      // colour low shelf
      if (sh) {
        const s = this.shS;
        let t = sh.b0 * ol + s[0]; s[0] = sh.b1 * ol - sh.a1 * t + s[1]; s[1] = sh.b2 * ol - sh.a2 * t; ol = t;
        t = sh.b0 * or + s[2]; s[2] = sh.b1 * or - sh.a1 * t + s[3]; s[3] = sh.b2 * or - sh.a2 * t; or = t;
      }
      // noise (follows the LFO; gated by the input on request)
      if (this.noise > 0) {
        let g = 1;
        if (this.gate) {
          const lev = Math.max(Math.abs(L[i]), Math.abs(R[i]));
          this.gateEnv = lev > this.gateEnv ? lev + (this.gateEnv - lev) * gateAtt : lev + (this.gateEnv - lev) * gateRel;
          this.gateGain += ((this.gateEnv > 1e-4 ? 1 : 0) - this.gateGain) * 0.002;
          g = this.gateGain;
        }
        if (g > 1e-6) {
          const a = this.noise * g;
          // the low-passed part opens with the LFO (130 Hz at the bottom of the sweep,
          // 1 kHz at the top; 100 Hz in Manual mode)
          const kl = this.manual ? nK : 1 - Math.exp((-TWO_PI * 600 * Math.pow(2.71, uL - 0.5)) / sr);
          const kr = this.manual ? nK : 1 - Math.exp((-TWO_PI * 600 * Math.pow(2.71, uR - 0.5)) / sr);
          this.nLp[0] += (this.rnd() - this.nLp[0]) * kl;
          this.nLp[1] += (this.rnd() - this.nLp[1]) * kr;
          ol += a * (NOISE_FLOOR * this.rnd() + NOISE_LP * this.nLp[0]);
          or += a * (NOISE_FLOOR * this.rnd() + NOISE_LP * this.nLp[1]);
        }
      }
      // delay
      if (this.delayGain > 1e-5) {
        // FL glides the delay in single precision, which stalls a little short of
        // the target (0.12 samples at 45 ms, 0.94 at 260 ms): replicated
        if (!this.keepPitch) this.dCur = F(this.dCur + F(kGlide * F(this.dTarget - this.dCur)));
        else if (this.xf < 1) this.xf = Math.min(1, this.xf + 1 / (0.1 * sr));
        const echoL = this.tap(0), echoR = this.tap(1);
        const w = this.dwp;
        this.dbuf[0][w] = ol + this.delayFb * this.fbState[0];
        this.dbuf[1][w] = or + this.delayFb * this.fbState[1];
        this.dwp = (w + 1) & this.dmask;
        this.fbState[0] = this.loopFilter(0, echoL);
        this.fbState[1] = this.loopFilter(1, echoR);
        const sg = this.stGain, m = this.delayMix, dg = this.delayGain;
        const yl = sg[0] * ol + sg[1] * m * echoL, yr = sg[2] * or + sg[3] * m * echoR;
        ol += dg * (yl - ol); or += dg * (yr - or);
      }
      L[i] = ol; R[i] = or;
    }
    this.phase = phase;
    for (const c of this.cores) {
      if (!Number.isFinite(c.fbPrev + c.hpS + c.z[0] + c.s[0])) { c.clear(); rsL.clear(); rsR.clear(); }
      c.fbPrev = flush(c.fbPrev); c.hpS = flush(c.hpS);
      for (let j = 0; j < 4; j++) { c.z[j] = flush(c.z[j]); c.s[j] = flush(c.s[j]); }
    }
    for (const a of this.flushList) for (let j = 0; j < a.length; j++) a[j] = flush(a[j]);
  }

  /** One base-rate sample through the oversampled phaser of one channel. */
  private runCore(c: Core, rs: Resampler, x: number, g: number, buf: Float64Array, v2: boolean,
    hpB0: number, hpA1: number, hpG: number, D: number, invD: number): number {
    rs.up(x, buf);
    const fb = this.fb;
    const m = buf.length;
    if (!v2) {
      const a = (g - 1) / (g + 1);
      const z = c.z;
      for (let i = 0; i < m; i++) {
        let u = buf[i] + fb * c.fbPrev;
        let y = a * u + z[0]; z[0] = u - a * y; u = y;
        y = a * u + z[1]; z[1] = u - a * y; u = y;
        y = a * u + z[2]; z[2] = u - a * y; u = y;
        y = a * u + z[3]; z[3] = u - a * y; u = y;
        // feedback / output high-pass (TDF first order)
        const h = hpB0 * u + c.hpS; c.hpS = -hpB0 * u - hpA1 * h;
        c.fbPrev = h;
        buf[i] = h;
      }
    } else {
      const s = c.s, cc = c.c, dd = c.d, gs = this.gs, dens = this.dens;
      const k1 = OTA_K1, k2 = OTA_K2;
      const hg = hpG / (1 + hpG), h0 = 1 / (1 + hpG);
      for (let i = 0; i < m; i++) {
        const hs = c.hpS;
        let u = 0;
        // linearised stages y_j = A_j x_j + B_j (integrating current c e, output x - 2 d e);
        // the delay-free loop is solved, the gains re-estimated and the loop solved again
        for (let pass = 0; pass < V2_PASSES; pass++) {
          let A = 1, B = 0;
          for (let j = 0; j < 4; j++) {
            const G = g * cc[j], den = 1 / (1 + G);
            gs[j] = G; dens[j] = den;
            const Aj = 1 - 2 * dd[j] * den, Bj = 2 * dd[j] * s[j] * den;
            A = Aj * A; B = Aj * B + Bj;
          }
          // feedback through the TPT high-pass: hp = h0 (y - lpState)
          const x1 = (D * buf[i] + fb * (h0 * B - h0 * hs)) / (1 - fb * h0 * A);
          u = x1;
          const last = pass === V2_PASSES - 1;
          for (let j = 0; j < 4; j++) {
            const v = (s[j] + gs[j] * u) * dens[j];
            const e = u - v;
            if (last) s[j] = 2 * v - s[j];
            // tanh(a) / a for the two currents
            const r1 = tanhRatio(k1 * e), r2 = tanhRatio(k2 * e);
            cc[j] = r1;
            dd[j] = r2;
            u = u - 2 * r2 * e;
          }
        }
        // high-pass state update (TPT: lp = (s + g y) / (1 + g))
        const lp = hs + hg * (u - hs);
        c.hpS = 2 * lp - hs;
        buf[i] = u * invD;
      }
    }
    return rs.down(buf);
  }

  private delaySamples(ctx: FxContext): number {
    if (this.delaySync) {
      const sec = (this.delayTimeV / 192) * (60 / Math.max(1, ctx.tempo));
      return F(Math.min(this.dmask - 4, sec * this.sr));
    }
    return F((vphaserDelayMs(this.delayTimeV) / 1000) * this.sr);
  }

  /** Where FL's single-precision glide from `from` comes to rest for `to`. */
  private settle(from: number, to: number): number {
    const k = F(1 - Math.exp(-1 / (0.0434 * this.sr)));
    let d = F(from);
    for (let i = 0; i < 200000; i++) {
      const nx = F(d + F(k * F(to - d)));
      if (nx === d) break;
      d = nx;
    }
    return d;
  }

  private read(ch: number, d: number): number {
    const buf = this.dbuf[ch], mask = this.dmask;
    if (d < 1) d = 1;
    const pos = this.dwp - d + mask + 1;
    const ip = Math.floor(pos);
    const t = pos - ip;
    return buf[ip & mask] * (1 - t) + buf[(ip + 1) & mask] * t;
  }

  private tap(ch: number): number {
    if (!this.keepPitch || this.xf >= 1) return this.read(ch, this.dCur);
    return this.read(ch, this.dOld) * (1 - this.xf) + this.read(ch, this.dCur) * this.xf;
  }

  /** Delay feedback filters: first-order high-pass then low-pass (bilinear). */
  private loopFilter(ch: number, x: number): number {
    const kh = this.dhpK, kl = this.dlpK;
    const hb = 1 / (1 + kh), ha = (kh - 1) / (kh + 1);
    let y = hb * x + this.dHpS[ch]; this.dHpS[ch] = -hb * x - ha * y;
    const lb = kl / (1 + kl), la = (kl - 1) / (kl + 1);
    const z = lb * y + this.dLpS[ch]; this.dLpS[ch] = lb * y - la * z;
    return Number.isFinite(z) ? z : 0;
  }

  get tail(): number {
    if (this.noiseT > 0 && !this.gate) return Infinity;
    if (this.delayOn && this.delayMixT > 0) {
      const d = this.dTarget / this.sr + 0.01;
      const fb = this.delayFbT;
      const repeats = fb > 0.001 ? Math.min(400, Math.log(0.001) / Math.log(Math.min(0.999, fb))) : 1;
      return Math.min(30, d * (repeats + 1) + 0.3);
    }
    return 0.3;
  }

  reset(): void {
    for (const c of this.cores) c.clear();
    for (const f of [4, 8, 16]) for (const r of this.rs[f]) r.clear();
    this.dry[0].fill(0); this.dry[1].fill(0);
    this.inS.fill(0); this.shS.fill(0);
    this.firH[0].fill(0); this.firH[1].fill(0);
    this.dbuf[0].fill(0); this.dbuf[1].fill(0);
    this.fbState.fill(0); this.dHpS.fill(0); this.dLpS.fill(0);
    this.nLp.fill(0);
  }
}

/** Noise mix: white floor and a low-passed part that follows the LFO (calibrated). */
const NOISE_FLOOR = 0.353;
const NOISE_LP = 2.54;

export const effect: EffectModule = {
  id: 'vphaser',
  create: (sr) => new VintagePhaser(sr),
};
