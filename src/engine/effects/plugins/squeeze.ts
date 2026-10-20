// Squeeze (FL: Fruity Squeeze): squarize (amplitude quantiser), puncher
// (periodic impact / preserve gating) and a 2x oversampled state-variable
// filter before or after them, then a dry / wet mix and gain. A line-by-line
// port of FL's plugin code (arm64: Eff_Render 0x5d2d0, ProcessParam 0x5c8d0,
// filter 0x5d810, SVF class 0x5e320..0x5e7b0, Math.Power 0x12d680; see
// docs/research/fx/squeeze.md) in FL's single precision with FL's operation
// order, so the output is FL's bit for bit.
//
// FL quirks reproduced: the filter's coefficients always assume 44100 Hz (FL
// never passes the real rate on); the puncher lengths do follow the sample
// rate; blocks whose input stays within +-1e-6 pass through untouched (FL's
// CPU saving, which also freezes the filter and puncher); no smoothing (gain,
// mix, steps, filter and puncher settings switch at the next block); full
// resonance gives q = 0, a lossless resonator that FL's single-precision
// rounding keeps bounded (measured: noise through it stays near 50x for
// 30 s), as it does here; Relation x 2 writes 2 x Preserve into Impact
// without a clamp (above 44100 the impact phase never ends).
//
// Departure (keeps the output finite): NaN / Inf input samples become 0.

import type { EffectInstance, EffectModule } from '../types';

const f32 = Math.fround;
/** FL flushes |x| < 2^-24 to 0 (filter input and notch). */
const TINY = 5.960464477539063e-8;
const SILENT = f32(1e-6);
const LN50 = f32(Math.log(50));
const LN_MAX = f32(Math.log(33075)); // 0.75 x 44100: FL's filter never sees another rate
const LN_RANGE = f32(LN_MAX - LN50);

/** FPC's Math.Power for single precision (as Squeeze calls it). */
function power32(base: number, e: number): number {
  if (e === 0) return 1;
  if (base === 0 && e > 0) return 0;
  if (Math.trunc(e) === e) {
    // IntPower in single precision
    let r = 1, b = base, n = Math.abs(e);
    while (n > 0) { if (n & 1) r = f32(r * b); b = f32(b * b); n >>= 1; }
    return e < 0 ? f32(1 / r) : r;
  }
  return f32(Math.exp(e * Math.log(base)));
}

/** FL's knob laws (raw control values in, physical values out). */
export function squeezeSteps(v: number): number {
  return power32(32768, f32(1 - v / 32768));
}
/** Puncher length in samples at 44.1 kHz (x sr / 44100 at other rates). */
export function squeezeSamples(v: number): number {
  return f32(power32(44101, f32(v / 44100)) - 1);
}
/** Cutoff wheel 0..1 -> Hz: 50 Hz .. 0.75 * 44100 Hz on a log scale (FL's SVF mapping, single precision). */
export function squeezeCutoffHz(c: number): number {
  const e = f32(Math.exp(f32(f32(f32(c) * LN_RANGE) + LN50)));
  return e < 50 ? 50 : e > 33075 ? 33075 : e;
}
/** FL's SVF coefficients for cutoff / resonance 0..1 (2x oversampled Chamberlin SVF at 44.1 kHz). */
export function squeezeSvf(cut: number, res: number): { f: number; q: number } {
  let r = f32(squeezeCutoffHz(cut) / 88200);
  if (!(0.25 >= r)) r = 0.25;
  const f = f32(2 * Math.sin(Math.PI * r));
  const qmax = f32(f32(2 / f) - f32(f * 0.5));
  const s8 = 2 >= qmax ? qmax : 2;
  const q = f32(2 * f32(1 - power32(f32(res), 0.25)));
  return { f, q: q < s8 ? q : s8 };
}
/** The impact length FL derives from preserve for Relation 1..3 (raw control units, clamped to the wheel for the editor). */
export function relatedImpact(relation: number, preserve: number, impact: number): number {
  switch (Math.round(relation)) {
    case 1: return preserve;
    case 2: return Math.min(44100, preserve * 2);
    case 3: return Math.trunc(preserve / 2);
    default: return impact;
  }
}

/** What FL's ProcessParam writes into Impact (no clamp: Relation x 2 can exceed the wheel). */
function relatedImpactRaw(relation: number, preserve: number, impact: number): number {
  switch (Math.round(relation)) {
    case 1: return preserve;
    case 2: return preserve * 2;
    case 3: return Math.trunc(preserve / 2);
    default: return impact;
  }
}

function num(v: unknown, d: number): number {
  const x = typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d;
  return Math.round(x);
}

class Squeeze implements EffectInstance {
  /** FL's sample rate factor for the puncher lengths, f32(sr / 44100). */
  private readonly k: number;
  private gain = f32(93 * (1 / 127));
  private dry = f32((128 - 108) / 128);
  private wet = f32(108 / 128);
  private steps = 32768;
  private filterOn = true;
  private ftype = 4;
  private post = true;
  private f = 0;
  private q = 2;
  private impact = 0;
  private preserve = 0;
  private amount = 0;
  // FL's Impact parameter as ProcessParam leaves it (Relation / Preserve changes write it)
  private impactRaw = -1;
  private lastRel = NaN;
  private lastPres = NaN;
  private lastImp = NaN;
  // puncher state (FL: impact counter, preserve counter, phase flag; single precision)
  private cImp = 0;
  private cPres = 0;
  private inImpact = false;
  // SVF state per channel: low, band
  private svf = new Float32Array(4);
  private buf: Float32Array;

  constructor(sampleRate: number, blockSize: number) {
    this.k = f32(sampleRate / 44100);
    this.buf = new Float32Array(2 * Math.max(blockSize, 128));
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const gain = Math.max(0, num(q.gain, 93)), mix = Math.min(128, Math.max(0, num(q.mix, 108)));
    this.gain = f32(gain * (1 / 127));
    this.dry = f32((128 - mix) / 128);
    this.wet = f32(mix / 128);
    const st = Math.min(32768, Math.max(1, num(q.steps, 28417)));
    this.steps = squeezeSteps(st);
    this.filterOn = num(q.filter, 1) >= 1;
    this.ftype = Math.min(4, Math.max(0, num(q.ftype, 4)));
    this.post = num(q.fpos, 1) >= 1;
    const c = squeezeSvf(f32(Math.min(65536, Math.max(0, num(q.cutoff, 23552))) / 65536), f32(Math.min(65536, Math.max(0, num(q.res, 46592))) / 65536));
    this.f = c.f;
    this.q = c.q;
    // FL's ProcessParam: a Relation or Preserve change writes Impact (relation 1..3), an Impact
    // change sets it; a state load sets the parameters in index order (relation, impact, preserve)
    const rel = num(q.relation, 0), pres = Math.min(44100, Math.max(0, num(q.preserve, 4684))), impP = Math.min(44100, Math.max(0, num(q.impact, 2892)));
    if (this.impactRaw < 0) this.impactRaw = relatedImpactRaw(rel, pres, impP);
    else {
      if (impP !== this.lastImp) this.impactRaw = impP;
      if (rel !== this.lastRel || pres !== this.lastPres) this.impactRaw = relatedImpactRaw(rel, pres, this.impactRaw);
    }
    this.lastRel = rel; this.lastPres = pres; this.lastImp = impP;
    this.impact = f32(squeezeSamples(this.impactRaw) * this.k);
    this.preserve = f32(squeezeSamples(pres) * this.k);
    this.amount = Math.min(65536, Math.max(0, num(q.amount, 0)));
  }

  reset(): void {
    this.svf.fill(0);
    this.cImp = this.cPres = 0;
    this.inImpact = false;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    // FL: a block that stays within +-1e-6 passes through untouched (NaN counts as loud)
    let loud = false;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      if (!(l <= SILENT && l >= -SILENT && r <= SILENT && r >= -SILENT)) { loud = true; break; }
    }
    if (!loud) return;
    if (this.buf.length < 2 * n) this.buf = new Float32Array(2 * n);
    const buf = this.buf;
    for (let i = 0; i < n; i++) {
      if (L[i] - L[i] !== 0) L[i] = 0; // NaN / Inf
      if (R[i] - R[i] !== 0) R[i] = 0;
      buf[2 * i] = L[i];
      buf[2 * i + 1] = R[i];
    }
    if (this.filterOn && !this.post) this.filter(buf, n);
    // squarize: rint in double of the single product, back to single, divided in single
    const steps = this.steps;
    if (steps < 32768) {
      for (let i = 0; i < 2 * n; i++) buf[i] = f32(f32(rintEven(f32(buf[i] * steps))) / steps);
    }
    // puncher
    const imp = this.impact;
    if (imp > 0) {
      const pres = this.preserve, amt = this.amount * 1.52587890625e-5;
      let cImp = this.cImp, cPres = this.cPres, inImp = this.inImpact;
      for (let i = 0; i < n; i++) {
        let wImp = 0, wPres = 0;
        if (inImp) {
          if (cImp > imp) { inImp = false; wPres = f32(cImp - imp); wImp = f32(1 - wPres); cImp = 0; cPres = wPres; }
          else { wImp = 1; cImp = f32(cImp + 1); }
        } else if (cPres > pres) { inImp = true; wImp = f32(cPres - pres); wPres = f32(1 - wImp); cImp = wImp; cPres = 0; }
        else { wPres = 1; cPres = f32(cPres + 1); }
        const g = f32(amt * wImp);
        const l = buf[2 * i], r = buf[2 * i + 1];
        buf[2 * i] = f32(f32(g * l) + f32(wPres * l));
        buf[2 * i + 1] = f32(f32(g * r) + f32(wPres * r));
      }
      this.cImp = cImp; this.cPres = cPres; this.inImpact = inImp;
    }
    if (this.filterOn && this.post) this.filter(buf, n);
    // mix and gain
    const g = this.gain, d = this.dry, w = this.wet;
    for (let i = 0; i < n; i++) {
      L[i] = f32(f32(f32(L[i] * d) + f32(buf[2 * i] * w)) * g);
      R[i] = f32(f32(f32(R[i] * d) + f32(buf[2 * i + 1] * w)) * g);
    }
    const s = this.svf;
    if (!Number.isFinite(s[0] + s[1] + s[2] + s[3])) s.fill(0);
  }

  /** FL's 2x oversampled Chamberlin SVF (input repeated, the two outputs averaged), in place. */
  private filter(buf: Float32Array, n: number): void {
    const st = this.svf, type = this.ftype, f = this.f, q = this.q;
    for (let ch = 0; ch < 2; ch++) {
      let low = st[ch * 2], band = st[ch * 2 + 1];
      for (let i = 0; i < n; i++) {
        let x = buf[2 * i + ch];
        if (x < TINY && x > -TINY) x = 0;
        // pass 1
        let notch = f32(x - f32(q * band));
        if (notch < TINY && notch > -TINY) notch = 0;
        low = f32(low + f32(f * band));
        let high = f32(notch - low);
        band = f32(f32(f * high) + band);
        let o = type === 0 ? low : type === 1 ? high : type === 2 ? band : type === 3 ? notch : f32(low - high);
        const o1 = f32(0.5 * o);
        // pass 2
        notch = f32(x - f32(q * band));
        if (notch < TINY && notch > -TINY) notch = 0;
        low = f32(low + f32(f * band));
        high = f32(notch - low);
        band = f32(f32(f * high) + band);
        o = type === 0 ? low : type === 1 ? high : type === 2 ? band : type === 3 ? notch : f32(low - high);
        buf[2 * i + ch] = f32(o1 + f32(0.5 * o));
      }
      st[ch * 2] = low;
      st[ch * 2 + 1] = band;
    }
  }
}

/** Round half to even (frintx in the default rounding mode). */
function rintEven(v: number): number {
  const fl = Math.floor(v);
  const d = v - fl;
  if (d > 0.5) return fl + 1;
  if (d < 0.5) return fl;
  return fl % 2 === 0 ? fl : fl + 1;
}

export const effect: EffectModule = {
  id: 'squeeze',
  create: (sampleRate, blockSize) => new Squeeze(sampleRate, blockSize),
};
