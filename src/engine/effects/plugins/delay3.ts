// Delay 3 (FL: Fruity Delay 3). FL's Delay 3 is a C++ engine (engine.vst, class
// ILDelay3); its constants and per-sample flow were read from the engine's code
// (also used by Distructor's chorus module) and checked against renders of FL's
// plugin with flfxhost (docs/research/fx/delay3.md):
//
//   in x input wet -> [true stereo: pre-delay of one input | mono: (L+R)/2 | ping pong: pan]
//     + DC-blocked feedback (line output x 0..1.25)
//     -> feedback filter (TPT state-variable LP / HP / BP) -> sample & hold -> bits
//     -> limiter / saturator -> diffusion allpass (write side) -> line   (Mono: the filter last)
//   line read at D - M + modulation (linear interpolation) -> wet
//   wet -> [mono: second tap for the offset] -> stereo spread -> tone (1st order) -> x output wet, + dry
//
// Arithmetic is single precision like FL (Math.fround). Continuous parameters go
// through the engine's 8-sample smoother (-20 dB in 20 ms); time, offset, rate,
// modulation time, diffusion spread, model and types apply at once. Time changes
// glide (Time smooth) or, with Keep pitch, crossfade linearly in 0.1 s between two
// tap sets, each with its own allpass. The LFO runs at 0.99 x the displayed rate
// with a float32 phase; the modulation depth follows a one-pole (-40 dB in 0.1 s).

import type { EffectInstance, EffectModule, FxContext } from '../types';
import { D3_DRIVE_LN, d3Knee, d3SatScale } from '../../../model/fx/plugins/delay3';

const F = Math.fround;

/** LFO period table (s); the DSP reads it at value x 0.99 x 5.9994 (the display at value x 5.9994). */
const RATE_T = [F(8.872), F(3.808), F(1.833), F(0.878), F(0.398), F(0.15), F(0.05)];
const RATE_P0 = RATE_T[0];
/** Cutoff tables (Hz) at quarter points. */
const LP_T = [270, 480, 1300, 7000, 22000];
const HP_T = [20, 90, 400, 1300, 4200];
/** Parameters that go through the 8-sample smoother (bit i = parameter index i). */
const SMOOTHED = 0x03ff4c81;
const SNAP = F(1e-4);
/** Limiter envelope steps (per sample; FL's constants, not scaled with the sample rate). */
const LIM_ATT = F(0.0052076578);
const LIM_REL = F(0.00052070618);
/** The distortion limiter's own envelope steps (measured; also per sample at any rate). */
const DLIM_ATT = F(1 - Math.exp(-1 / 191.5));
const DLIM_REL = F(1 - Math.exp(-1 / 1915.1));
/** Sample & hold length polynomial (in 44.1 kHz samples) of s1 = 127 (1 - rate)^3. */
const SH_A = F(0.0002);
const SH_B = F(-0.0171);
const SH_C = F(0.7435);
const TWO_PI_F = F(2 * Math.PI);
const PI_F = F(Math.PI);
/** Slowest tempo (FL: 10 BPM): a synced time of b beats needs b x 6 s. */
const MIN_TEMPO = 10;

/** Raw control ranges (FL's wheels), in parameter-index order. */
const KEYS = [
  'inWet', 'model', 'sync', 'keepPitch', 'time', 'offset', 'smoothing', 'spread', 'modRate', 'modTime', 'modCutoff',
  'diffLevel', 'diffSpread', 'distType', 'feedback', 'filterType', 'cutoff', 'res', 'distLevel', 'distKnee', 'distSym',
  'rate', 'bits', 'wet', 'tone', 'dry',
] as const;
const MIN = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -3000, 0];
const MAX = [6000, 3, 1, 1, 768, 6000, 1000, 6000, 6000, 6000, 6000, 6000, 6000, 1, 6000, 3, 6000, 6000, 6000, 6000, 6000, 60000, 6000, 6000, 3000, 6000];
/** FL's Default preset (raw). */
const DEF = [6000, 1, 1, 0, 192, 3000, 500, 6000, 3000, 0, 0, 0, 0, 1, 3000, 0, 6000, 0, 0, 0, 0, 60000, 6000, 6000, 0, 6000];

/** Ring buffer: read(d) = the sample written d samples ago, linear interpolation like FL. */
class Ring {
  buf: Float32Array;
  w = 0;
  constructor(n: number) { this.buf = new Float32Array(Math.max(8, n)); }
  get size(): number { return this.buf.length; }
  write(x: number): void {
    this.buf[this.w] = x;
    if (++this.w >= this.buf.length) this.w = 0;
  }
  /** i = trunc(d), f = d - i, y = a (1 - f) + b f (single precision). */
  read(d: number): number {
    const b = this.buf, n = b.length;
    let i = d > 0 ? Math.floor(d) : 0;
    if (i > n - 2) i = n - 2;
    const f = d > 0 ? F(d - i) : 0;
    let k = this.w - i;
    if (k < 0) k += n;
    let k1 = k - 1;
    if (k1 < 0) k1 += n;
    return F(b[k] * F(1 - f) + F(f * b[k1]));
  }
  /** Integer read (d >= 1). */
  at(d: number): number {
    const n = this.buf.length;
    let k = this.w - d;
    if (k < 0) k += n;
    else if (k >= n) k -= n;
    return this.buf[k < 0 ? 0 : k];
  }
  grow(n: number): void {
    if (n <= this.buf.length) return;
    const old = this.buf, m = old.length, nb = new Float32Array(n);
    // oldest .. newest, so that read(d) keeps working
    for (let k = 0; k < m; k++) nb[k] = old[(this.w + k) % m];
    this.buf = nb;
    this.w = m;
  }
  clear(): void { this.buf.fill(0); this.w = 0; }
}

/** One line's input chain state. */
class Chain {
  dx = 0; dy = 0;      // DC blocker
  ic1 = 0; ic2 = 0;    // feedback SVF
  held = 0; cnt = 0;   // sample & hold
  env = 0;             // limiter (distortion)
  tx = 0; ty = 0;      // output tone
  oenv = 0;            // ping-pong output limiter
  readonly ap0: Ring;  // diffusion allpasses, one per crossfade slot
  readonly ap1: Ring;
  constructor(apLen: number) { this.ap0 = new Ring(apLen); this.ap1 = new Ring(apLen); }
  reset(full: boolean): void {
    this.dx = this.dy = this.ic1 = this.ic2 = this.held = 0;
    this.ap0.clear(); this.ap1.clear();
    if (full) { this.cnt = 0; this.env = 0; this.tx = this.ty = 0; this.oenv = 0; }
  }
}

class Delay3 implements EffectInstance {
  private readonly sr: number;
  private readonly srF: number;
  private lastTempo = 60;
  private usedTempo = 0;
  private raw = DEF.slice();
  private fresh = true;
  /** Recompute the taps at the first block (the song tempo is known there). */
  private needSnap = true;

  private readonly lineA: Ring;
  private readonly lineB: Ring;
  private readonly preL: Ring;
  private readonly preR: Ring;
  private readonly ca: Chain;
  private readonly cb: Chain;

  // constants of the sample rate
  private readonly kSmooth: number;
  private readonly kAmp: number;
  private readonly halfSr: number;
  private readonly xfLen: number;
  private readonly xfInc: number;
  private readonly dcB0: number;
  private readonly dcA1: number;
  private readonly piSr: number;
  private readonly maxHz: number;
  private readonly shScale: number;

  // engine parameter values (normalized 0..1) and smoother targets
  private readonly cur = new Float64Array(26);
  private readonly tgt = new Float64Array(26);
  private readonly act = new Uint8Array(26);
  private stepCnt = 0;
  private fCnt = 3;

  // values derived from the parameters
  private model = 1; private sync = true; private keep = false; private timeX = 0; private offset = 0.5; private kGlide = 1;
  private spread = 1; private inWet = 1; private wet = 1; private dry = 1; private fb = F(0.625); private apC = 0;
  private modTimeF = 0; private lfoInc = 0; private sqrtRatio = 1; private modCut = 0; private cutX = 1; private resX = 0;
  private distType = 1; private filterType = 0; private drive = 1; private satC = 1; private knee = 0; private symP = 1; private symN = 1;
  private shRate = 0; private bitsS = 0; private bitsQ = 65536;
  private tLp = true; private tOn = false; private tB0 = 1; private tB1 = 0; private tA1 = 0;
  // feedback filter coefficients (updated every 4 samples)
  private s1 = 0; private s2 = 0; private s3 = 0; private fk = 1.414; private fMode = 0;

  // taps of the two crossfade slots: allpass length M, line tap Z = D - M, pre / post taps A, B
  private readonly iM = new Int32Array(2); private readonly iZ = new Int32Array(2);
  private readonly iA = new Int32Array(2); private readonly iB = new Int32Array(2);
  private readonly dM = new Float64Array(2); private readonly dZ = new Float64Array(2);
  private readonly dA = new Float64Array(2); private readonly dB = new Float64Array(2);
  private readonly gain = new Float64Array([1, 0]);
  private curSlot = 0; private nextSlot = 1; private fading = false; private fadeCnt = 0; private dirty = true;
  private offLow = false;

  // LFO and modulation depth
  private phase = 0;
  private amp = 0;


  constructor(sr: number) {
    this.sr = sr;
    this.srF = F(sr);
    const n = this.lineLen(DEF[4], true);
    this.lineA = new Ring(n);
    this.lineB = new Ring(n);
    this.preL = new Ring(this.preLen(DEF[4], true));
    this.preR = new Ring(this.preL.size);
    const apLen = Math.ceil((655 * sr) / 44100) + 8;
    this.ca = new Chain(apLen);
    this.cb = new Chain(apLen);
    this.kSmooth = F(1 - Math.pow(0.01, 1 / (sr * 0.005)));
    this.kAmp = F(1 - Math.pow(0.01, 1 / (sr * 0.1)));
    this.halfSr = F(sr * 0.5);
    this.xfLen = Math.max(1, Math.trunc(sr * 0.1));
    this.xfInc = F(1 / F(this.xfLen));
    this.shScale = F(sr / 44100);
    // DC blocker: 10 Hz bilinear high-pass, coefficients computed for 44.1 kHz at any rate
    const k = F(F(1 / 44100) * PI_F), g = F(Math.tan(F(k * 10))), s = F(g + 1);
    this.dcB0 = F(1 / s);
    this.dcA1 = F(F(1 - g) / s);
    this.piSr = F(F(1 / sr) * PI_F);
    this.maxHz = F(this.srF * F(0.49));
    for (let i = 0; i < 26; i++) this.immediate(i, this.norm(i, DEF[i]));
    this.updateFilter(0);
  }

  /** Samples a line must hold: 1.5 x the longest delay (mono offset tap) plus the modulation swing. */
  private lineLen(time: number, sync: boolean): number {
    const sec = sync ? (Math.min(768, Math.max(1, time)) / 192) * (60 / MIN_TEMPO) : 1;
    return Math.ceil(1.5 * sec * this.sr + 0.08 * this.sr) + 16;
  }

  private preLen(time: number, sync: boolean): number {
    const sec = sync ? (Math.min(768, Math.max(1, time)) / 192) * (60 / MIN_TEMPO) : 1;
    return Math.ceil(0.25 * sec * this.sr) + 16;
  }

  private norm(i: number, v: number): number {
    const c = Math.min(MAX[i], Math.max(MIN[i], v));
    return F((c - MIN[i]) / (MAX[i] - MIN[i]));
  }

  setParams(input: unknown): void {
    const q = (input ?? {}) as Record<string, unknown>;
    const next = DEF.slice();
    for (let i = 0; i < 26; i++) {
      const v = q[KEYS[i]];
      if (typeof v === 'number' && Number.isFinite(v)) next[i] = v;
      else if (typeof v === 'boolean') next[i] = v ? 1 : 0;
    }
    for (const i of [1, 2, 3, 13, 15]) next[i] = Math.round(next[i]);
    // grow the lines for a longer synced time (allocation stays out of process())
    const n = this.lineLen(next[4], next[2] >= 0.5);
    if (n > this.lineA.size) {
      const g = Math.max(n, Math.ceil(this.lineA.size * 1.5));
      this.lineA.grow(g);
      this.lineB.grow(g);
      const pn = Math.max(this.preLen(next[4], next[2] >= 0.5), Math.ceil(g / 6));
      this.preL.grow(pn);
      this.preR.grow(pn);
    }
    if (this.fresh) {
      this.fresh = false;
      // a state load applies at once (FL glides from its engine defaults; see the research notes)
      for (let i = 0; i < 26; i++) { this.act[i] = 0; this.immediate(i, this.norm(i, next[i])); }
      this.raw = next;
      this.snapTaps();
      this.needSnap = true;
      return;
    }
    for (let i = 0; i < 26; i++) {
      if (next[i] !== this.raw[i]) this.setParam(i, this.norm(i, next[i]));
    }
    this.raw = next;
  }

  /** Host parameter change: smoothed parameters get a target, the rest apply now. */
  private setParam(i: number, x: number): void {
    if ((SMOOTHED >> i) & 1) {
      this.tgt[i] = x;
      this.act[i] = 1;
    } else {
      this.immediate(i, x);
    }
  }

  /** One step of the 8-sample smoother. */
  private smootherStep(): void {
    for (let i = 0; i < 26; i++) {
      if (!this.act[i]) continue;
      const c = this.cur[i], t = this.tgt[i];
      const s = F(F(t - c) * this.kSmooth + c);
      if (Math.abs(F(s - t)) < SNAP) { this.act[i] = 0; this.immediate(i, t); }
      else this.immediate(i, s);
    }
  }

  /** The engine's parameter handlers (normalized value). */
  private immediate(i: number, v: number): void {
    const x = F(v);
    this.cur[i] = x;
    this.tgt[i] = this.act[i] ? this.tgt[i] : x;
    switch (i) {
      case 0: this.inWet = x; break;
      case 1: {
        const m = Math.trunc(x * 3 + 0.5);
        if (m !== this.model) {
          this.model = m;
          this.engineReset();
          this.dirty = true;
        }
        break;
      }
      case 2: { const s = x >= 0.5; if (s !== this.sync) { this.sync = s; this.dirty = true; } break; }
      case 3: { const k = x >= 0.5; if (k !== this.keep) { this.keep = k; this.dirty = true; } break; }
      case 4: this.timeX = x; this.dirty = true; break;
      case 5: this.offset = x; this.dirty = true; break;
      case 6: this.kGlide = x > 0 ? F(1 - Math.pow(0.01, 1 / (this.sr * x))) : 1; break;
      case 7: this.spread = x; break;
      case 8: {
        const P = table7(F(F(x * F(0.99)) * F(5.9994)));
        this.lfoInc = F(1 / F(P * this.srF));
        this.sqrtRatio = F(Math.sqrt(F(P / RATE_P0)));
        break;
      }
      case 9: this.modTimeF = F(F(x * x) * F(0.1)); break;
      case 10: this.modCut = x; break;
      case 11: this.apC = F(x * F(0.499)); break;
      case 12: this.dirty = true; break;
      case 13: this.distType = x >= 0.5 ? 1 : 0; break;
      case 14: this.fb = F(x * 1.25); break;
      case 15: this.filterType = Math.trunc(x * 3 + 0.5); break;
      case 16: this.cutX = x; break;
      case 17: this.resX = x; break;
      case 18: this.drive = Math.exp(x * D3_DRIVE_LN); this.satC = d3SatScale(x); break;
      case 19: this.knee = x; break;
      case 20: this.symP = 1 + x; this.symN = 1 - x; break;
      case 21: { const s = F(1 - x); this.shRate = F(F(s * s) * s); break; }
      case 22: {
        const s = F(1 - x), s2 = F(s * s);
        this.bitsS = s2;
        this.bitsQ = F(Math.pow(2, F(F(1 - F(Math.sqrt(F(Math.sqrt(s2))))) * 14 + 2)));
        break;
      }
      case 23: this.wet = x; break;
      case 24: this.setTone(x); break;
      case 25: this.dry = x; break;
      default: break;
    }
  }

  private setTone(v: number): void {
    if (v < 0.5) { this.tOn = true; this.tLp = true; this.toneCoefs(table5(LP_T, F(F(v + v) * F(3.9999)))); }
    else if (v === 0.5) { this.tOn = false; }
    else { this.tOn = true; this.tLp = false; this.toneCoefs(table5(HP_T, F(F(F(v - 0.5) * 2) * F(3.9999)))); }
  }

  private toneCoefs(hz: number): void {
    const fc = hz > this.maxHz ? this.maxHz : hz;
    const g = F(Math.tan(F(this.piSr * fc))), s = F(g + 1);
    this.tA1 = F(F(1 - g) / s);
    if (this.tLp) { this.tB0 = F(g / s); this.tB1 = this.tB0; }
    else { this.tB0 = F(1 / s); this.tB1 = -this.tB0; }
  }

  /** Feedback filter coefficients from the smoothed cutoff / resonance and the LFO (every 4 samples). */
  private updateFilter(u: number): void {
    const t = this.filterType;
    // the filter mode switches with the coefficients
    this.fMode = t;
    if (t === 3) return;
    let x = F(this.cutX + F(F(0.5 * this.modCut) * u));
    if (x > 1) x = 1;
    const r2 = F(this.resX * this.resX);
    const Q = t === 2 ? F(F(r2 * F(1.15)) + F(0.107)) : F(r2 + F(0.707));
    let fc = t === 1 ? table5(HP_T, F(x * F(3.999))) : table5(LP_T, F(x * (t === 2 ? F(3.6) : F(3.999))));
    if (fc > this.maxHz) fc = this.maxHz;
    const k = F(1 / Q);
    const g = F(Math.tan(F(F(3.1415 / this.sr) * fc)));
    this.fk = k;
    this.s1 = F(1 / F(F(g * F(g + k)) + 1));
    this.s2 = F(g * this.s1);
    this.s3 = F(g * this.s2);
  }

  /** Delay in samples for the current time / tempo (FL: truncated). */
  private delaySamples(sr: number): number {
    let T: number;
    if (this.sync) {
      const raw = Math.round(this.timeX * 767) + 1;
      T = ((raw / 192) * 60) / Math.max(1, this.usedTempo || this.lastTempo);
    } else {
      let t = this.timeX * 0.94 + 0.06;
      t = t * t * t;
      t = (t - 0.000216) * 1.0002160466660799;
      T = t * 0.999 + 0.001;
    }
    const maxD = Math.floor((this.lineA.size - 0.08 * sr - 16) / 1.5);
    return Math.max(1, Math.min(maxD, Math.trunc(sr * T)));
  }

  /** Integer taps of a slot (FL's layout). */
  private computeTimes(slot: number): void {
    const sr = this.sr;
    const D = this.delaySamples(sr);
    const Df = F(D);
    let r = F(Df / F(this.srF * F(0.015)));
    if (r > 1) r = 1;
    const spread = F(F(this.cur[12] * F(590)) + 65);
    let mf = F(F(spread * this.shScale) * r);
    if (mf < 1) mf = 1;
    const M = Math.min(this.ca.ap0.size - 2, Math.trunc(mf));
    this.iM[slot] = M;
    this.offLow = this.offset < 0.5;
    const f = F(F(Math.abs(F(this.offset - 0.5))) * 2);
    const zf = F(Df - F(M));
    const Z = Math.trunc(zf < 1 ? 1 : zf);
    this.iZ[slot] = Z;
    if (this.model === 1) {
      const h = F(f * 0.5);
      let pre = F(h * F(h * Df));
      if (pre < 1) pre = 1;
      const P = Math.min(this.preL.size - 2, Math.trunc(pre));
      if (this.offLow) { this.iA[slot] = 1; this.iB[slot] = P; } else { this.iA[slot] = P; this.iB[slot] = 1; }
    } else if (this.model === 0) {
      const post = F(Df - F(F(1 - F(f * 0.5)) * Df));
      const Qt = Math.trunc(F(post + F(Z)));
      if (this.offLow) { this.iA[slot] = Qt; this.iB[slot] = Z; } else { this.iA[slot] = Z; this.iB[slot] = Qt; }
    } else {
      this.iA[slot] = 1; this.iB[slot] = 1;
    }
  }

  /** Jump to the current taps (state load, reset). */
  private snapTaps(): void {
    this.usedTempo = this.lastTempo;
    this.computeTimes(0);
    this.dM[0] = this.iM[0]; this.dZ[0] = this.iZ[0]; this.dA[0] = this.iA[0]; this.dB[0] = this.iB[0];
    this.dM[1] = this.dM[0]; this.dZ[1] = this.dZ[0]; this.dA[1] = this.dA[0]; this.dB[1] = this.dB[0];
    this.iM[1] = this.iM[0]; this.iZ[1] = this.iZ[0]; this.iA[1] = this.iA[0]; this.iB[1] = this.iB[0];
    this.curSlot = 0; this.nextSlot = 1; this.gain[0] = 1; this.gain[1] = 0; this.fading = false; this.dirty = false;
  }

  /** Engine reset (model change): lines, allpasses, filter and DC states. */
  private engineReset(): void {
    this.lineA.clear(); this.lineB.clear(); this.preL.clear(); this.preR.clear();
    this.ca.reset(false); this.cb.reset(false);
  }

  /** Time smooth: slot 0's taps glide per sample. */
  private glideTaps(): void {
    const k = this.kGlide, dZ = this.dZ, dM = this.dM, dA = this.dA, dB = this.dB;
    // in double precision (single precision would stall long glides)
    dZ[0] += (this.iZ[0] - dZ[0]) * k;
    dM[0] += (this.iM[0] - dM[0]) * k;
    dA[0] += (this.iA[0] - dA[0]) * k;
    dB[0] += (this.iB[0] - dB[0]) * k;
  }

  /** Sample & hold and bit reduction. */
  private shq(c: Chain, v: number): number {
    if (this.shRate > 0) {
      const s1 = F(this.shRate * 127);
      const p2 = F(F(s1 * SH_A) * s1), p3 = F(F(s1 * SH_B) * s1);
      let hold = F(F(F(s1 * SH_C + F(p2 * s1 + p3)) + 1) * this.shScale);
      if (hold < 1) hold = 1;
      const n = F(c.cnt + 1);
      if (n < hold) { c.cnt = n; v = c.held; }
      else {
        let r = 0;
        if (n >= 0 && hold > 0) { const q = F(n / hold); r = F(n * F(q - Math.trunc(q))); }
        c.cnt = r;
        c.held = v;
      }
    }
    if (this.bitsS > 0) v = F(Math.trunc(F(v * this.bitsQ)) / this.bitsQ);
    return v;
  }

  /** Limiter or saturator (level, knee, symmetry). */
  private dist(c: Chain, v: number): number {
    if (this.distType === 0) {
      const a = v < 0 ? -v : v;
      c.env = F(F(a - c.env) * (a < c.env ? DLIM_REL : DLIM_ATT) + c.env);
      return c.env > this.satC ? F(v * F(this.satC / c.env)) : v;
    }
    const u = v * this.drive;
    if (u >= 0) return F(this.satC * this.symP * d3Knee(u / this.symP, this.knee));
    return this.symN <= 0 ? 0 : F(-this.satC * this.symN * d3Knee(-u / this.symN, this.knee));
  }

  /** TPT state-variable filter (Cytomic form). */
  private svf(c: Chain, v: number): number {
    const v3 = F(v - c.ic2);
    const v1 = F(this.s1 * c.ic1 + F(v3 * this.s2));
    const v2 = F(this.s3 * v3 + F(this.s2 * c.ic1 + c.ic2));
    c.ic1 = F(2 * v1 - c.ic1);
    c.ic2 = F(2 * v2 - c.ic2);
    const t = this.fMode;
    if (t === 0) return v2;
    if (t === 2) return F(v1 * this.fk);
    return F(F(v - v1 * this.fk) - v2);
  }

  /** The chain on what enters a line: (filter) -> S&H / bits -> distortion -> (filter in Mono) -> allpasses. */
  private chain(c: Chain, v: number, filterLast: boolean): number {
    const fOn = this.fMode !== 3;
    if (fOn && !filterLast) v = this.svf(c, v);
    if (this.shRate > 0 || this.bitsS > 0) v = this.shq(c, v);
    v = this.dist(c, v);
    if (fOn && filterLast) v = this.svf(c, v);
    return v;
  }

  /** Write side diffusion: both slots' allpasses, mixed by the slot gains. */
  private diffuse(c: Chain, v: number): number {
    const cc = this.apC, k = F(1 - cc * cc), g0 = this.gain[0], g1 = this.gain[1];
    // the allpass taps are read with interpolation (they glide with Time smooth)
    const d0 = c.ap0.read(F(this.dM[0]));
    c.ap0.write(F(v - d0 * cc));
    const d1 = c.ap1.read(F(this.dM[1]));
    c.ap1.write(F(v - d1 * cc));
    const y0 = F(v * cc + F(d0 * k)), y1 = F(v * cc + F(d1 * k));
    return F(y0 * g0 + F(y1 * g1));
  }

  private dcb(c: Chain, x: number): number {
    const y = F(F(x * this.dcB0 + F(c.dx * -this.dcB0)) + c.dy * this.dcA1);
    c.dx = x;
    c.dy = y;
    return y;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (ctx.tempo > 0 && Number.isFinite(ctx.tempo)) this.lastTempo = ctx.tempo;
    if (this.needSnap) { this.needSnap = false; this.snapTaps(); }
    if (this.sync && this.lastTempo !== this.usedTempo) this.dirty = true;
    const lA = this.lineA, lB = this.lineB, ca = this.ca, cb = this.cb, gain = this.gain;
    const dA = this.dA, dB = this.dB, dZ = this.dZ, dM = this.dM;
    for (let i = 0; i < n; i++) {
      // smoother step every 8 samples; tap changes (keep pitch: start a crossfade, else glide targets)
      if (++this.stepCnt === 8) { this.stepCnt = 0; this.smootherStep(); }
      if (this.dirty) {
        if (this.keep) {
          if (!this.fading) {
            this.dirty = false;
            this.usedTempo = this.lastTempo;
            const s = this.nextSlot;
            this.computeTimes(s);
            dM[s] = this.iM[s]; dZ[s] = this.iZ[s]; dA[s] = this.iA[s]; dB[s] = this.iB[s];
            this.fading = true;
            this.fadeCnt = 0;
          }
        } else {
          this.dirty = false;
          this.usedTempo = this.lastTempo;
          this.computeTimes(0);
          gain[0] = 1; gain[1] = 0; this.curSlot = 0; this.nextSlot = 1; this.fading = false;
        }
      }
      if (!this.keep) this.glideTaps();

      let xl = L[i], xr = R[i];
      if (!(xl > 1e-13 || xl < -1e-13)) xl = 0;
      if (!(xr > 1e-13 || xr < -1e-13)) xr = 0;

      // LFO (float32 phase, value from the phase before the step) and the modulation depth
      const nx = F(this.phase + this.lfoInc);
      const u = F(F(F(Math.sin(F(this.phase * TWO_PI_F))) + 1) * 0.5);
      this.phase = F(nx - Math.trunc(nx));
      const target = F(F(this.halfSr * this.modTimeF) * this.sqrtRatio);
      this.amp = F(F(target - this.amp) * this.kAmp + this.amp);
      const mod = F(this.amp * F(u + 0.5));
      // feedback filter coefficients every 4 samples (from sample 0), with the cutoff modulation
      if (++this.fCnt === 4) { this.fCnt = 0; this.updateFilter(u); }

      const model = this.model;
      const g0 = gain[0], g1 = gain[1];
      let wl: number, wr: number;
      if (model === 3) {
        // Off: the processing chain on the input itself
        wl = this.chain(ca, xl, false);
        wr = this.chain(cb, xr, false);
      } else if (model === 0) {
        // mono: (L + R) / 2 in one line, read at two taps (the offset moves one of them)
        const rl = F(lA.read(F(F(dA[1]) + mod)) * g1 + F(lA.read(F(F(dA[0]) + mod)) * g0));
        const rr = F(lA.read(F(F(dB[1]) + mod)) * g1 + F(lA.read(F(F(dB[0]) + mod)) * g0));
        const fbIn = F((this.offLow ? rr : rl) * this.fb);
        let v = F(F(F(F(xl + xr) * 0.5) * this.inWet) + this.dcb(ca, fbIn));
        v = this.chain(ca, v, true);
        lA.write(this.diffuse(ca, v));
        wl = rl; wr = rr;
      } else {
        const ra = F(lA.read(F(F(dZ[1]) + mod)) * g1 + F(lA.read(F(F(dZ[0]) + mod)) * g0));
        const rb = F(lB.read(F(F(dZ[1]) + mod)) * g1 + F(lB.read(F(F(dZ[0]) + mod)) * g0));
        if (model === 1) {
          // true stereo: the offset pre-delays one input
          this.preL.write(xl);
          this.preR.write(xr);
          // pre-delays (1 = none); a gliding tap is read with interpolation
          const pl = F(this.preL.read(F(dA[0])) * g0 + F(this.preL.read(F(dA[1])) * g1));
          const pr = F(this.preR.read(F(dB[0])) * g0 + F(this.preR.read(F(dB[1])) * g1));
          let va = F(pl * this.inWet + this.dcb(ca, F(ra * this.fb)));
          let vb = F(pr * this.inWet + this.dcb(cb, F(rb * this.fb)));
          va = this.chain(ca, va, false);
          vb = this.chain(cb, vb, false);
          lA.write(this.diffuse(ca, va));
          lB.write(this.diffuse(cb, vb));
          wl = ra; wr = rb;
        } else {
          // ping pong: the panned input enters crossed lines (an L input echoes on the right first)
          const pan = F(F(this.offset - 0.5) * 2);
          let il = F(xl * this.inWet), ir = F(xr * this.inWet);
          if (pan < 0) { const t = -pan * 0.5; const nl = il + (ir - il) * t; ir *= 1 + pan; il = nl; }
          else if (pan > 0) { const t = pan * 0.5; const nr = ir + (il - ir) * t; il *= 1 - pan; ir = nr; }
          // line B <- L input + feedback of line A; line A <- R input + feedback of line B
          let vb = F(il + this.dcb(ca, F(ra * this.fb)));
          let va = F(ir + this.dcb(cb, F(rb * this.fb)));
          vb = this.chain(ca, vb, false);
          va = this.chain(cb, va, false);
          lB.write(this.diffuse(ca, vb));
          lA.write(this.diffuse(cb, va));
          wl = ra; wr = rb;
        }
      }

      // stereo spread
      const s = this.spread;
      if (s < 1) {
        const a = F((1 + s) * 0.5), b = F((1 - s) * 0.5);
        const l2 = F(F(a * wl) + F(b * wr));
        wr = F(F(b * wl) + F(a * wr));
        wl = l2;
      }
      // output tone
      if (this.tOn) {
        const oL = F(F(wl * this.tB0 + F(ca.tx * this.tB1)) + ca.ty * this.tA1); ca.tx = wl; ca.ty = oL; wl = oL;
        const oR = F(F(wr * this.tB0 + F(cb.tx * this.tB1)) + cb.ty * this.tA1); cb.tx = wr; cb.ty = oR; wr = oR;
      } else {
        ca.tx = wl; ca.ty = wl; cb.tx = wr; cb.ty = wr;
      }
      if (model === 2) {
        // ping pong output limiter: gain 1 / max(envelope, 1)
        let a = wl < 0 ? -wl : wl;
        ca.oenv = F(F(a - ca.oenv) * (a < ca.oenv ? LIM_REL : LIM_ATT) + ca.oenv);
        if (ca.oenv > 1) wl = F(wl / ca.oenv);
        a = wr < 0 ? -wr : wr;
        cb.oenv = F(F(a - cb.oenv) * (a < cb.oenv ? LIM_REL : LIM_ATT) + cb.oenv);
        if (cb.oenv > 1) wr = F(wr / cb.oenv);
      }
      L[i] = F(F(xl * this.dry) + F(wl * this.wet));
      R[i] = F(F(xr * this.dry) + F(wr * this.wet));

      // keep-pitch crossfade gains for the next sample
      if (this.keep && this.fading) {
        const g = F(F(this.fadeCnt) * this.xfInc);
        gain[this.curSlot] = F(1 - g);
        gain[this.nextSlot] = g;
        if (++this.fadeCnt >= this.xfLen) {
          this.fading = false;
          const t = this.curSlot; this.curSlot = this.nextSlot; this.nextSlot = t;
        }
      }
    }
    this.flush();
  }

  /** Denormal flush and recovery from non-finite states (once per block). */
  private flush(): void {
    if (!flushChain(this.ca) || !flushChain(this.cb)) { this.reset(); return; }
  }

  reset(): void {
    this.lineA.clear(); this.lineB.clear(); this.preL.clear(); this.preR.clear();
    this.ca.reset(true); this.cb.reset(true);
    this.phase = 0;
    this.amp = F(F(this.halfSr * this.modTimeF) * this.sqrtRatio);
    for (let i = 0; i < 26; i++) if (this.act[i]) { this.act[i] = 0; this.immediate(i, this.tgt[i]); }
    this.snapTaps();
    this.needSnap = true;
  }

  /** Echo tail: repeats until -90 dB (feedback >= ~100 % self-oscillates: capped at 60 s). */
  get tail(): number {
    const p = this.raw;
    if (Math.round(p[1]) === 3) return 0.05;
    const sync = p[2] >= 0.5;
    const T = sync ? (Math.min(768, Math.max(1, p[4])) / 192) * (60 / Math.max(1, Math.min(this.lastTempo, 999)))
      : timeSec(this.norm(4, p[4])) + 0.08;
    const extra = T * 0.5 + 0.05 + (p[11] > 0 ? 0.25 : 0);
    const g = (p[14] / 6000) * 1.25;
    if (g >= 0.999) return 60;
    if (g <= 1e-4) return Math.min(60, T + extra);
    const repeats = Math.ceil(Math.log(10 ** (-90 / 20)) / Math.log(g));
    return Math.min(60, (repeats + 1) * T + extra);
  }
}

/** Free time law (seconds) of the normalized time x. */
function timeSec(x: number): number {
  let t = x * 0.94 + 0.06;
  t = t * t * t;
  t = (t - 0.000216) * 1.0002160466660799;
  return t * 0.999 + 0.001;
}

function flushChain(c: Chain): boolean {
  if (!Number.isFinite(c.dx + c.dy + c.ic1 + c.ic2 + c.held + c.env + c.tx + c.ty + c.oenv)) return false;
  if (Math.abs(c.dy) < 1e-30) c.dy = 0;
  if (Math.abs(c.ic1) < 1e-30) c.ic1 = 0;
  if (Math.abs(c.ic2) < 1e-30) c.ic2 = 0;
  if (Math.abs(c.ty) < 1e-30) c.ty = 0;
  return true;
}

/** 7-knot period table, linear, index truncated like FL. */
function table7(idx: number): number {
  let i = Math.trunc(idx);
  if (i < 0) i = 0;
  if (i > 5) i = 5;
  const f = F(idx - i);
  return F(F(1 - f) * RATE_T[i] + F(f * RATE_T[i + 1]));
}

/** 5-knot cutoff table, linear. */
function table5(t: number[], idx: number): number {
  let i = Math.trunc(idx);
  if (i < 0) i = 0;
  if (i > 3) i = 3;
  const f = F(idx - i);
  return F(F(1 - f) * t[i] + F(f * t[i + 1]));
}

export const effect: EffectModule = {
  id: 'delay3',
  create: (sampleRate) => new Delay3(sampleRate),
};
