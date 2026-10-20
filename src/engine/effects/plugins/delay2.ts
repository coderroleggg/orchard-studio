// Delay 2 (FL: Fruity Delay 2), measured from FL's own plugin with flfxhost
// (docs/research/fx/delay2.md):
//
//   in -> input pan (pour law) -> x input volume -> stereo offset pre-delay (one input)
//      (+ feedback) -> one-pole low-pass -> delay line (D) per input side
//   normal: L line -> L out; invert: L line -> R out; ping pong: crossed feedback, swapped outputs
//   out = dry x in + wet
//
// D = round-half-even(time * sr) with time = raw / 192 beats. FL clears its
// lines whenever the delay length (time, tempo) or the offset changes: the
// next echoes start from silence. Feedback = raw / 128 per repeat.

import type { EffectInstance, EffectModule, FxContext } from '../types';
import { d2CutoffCoef, d2Gain, d2OffsetMs } from '../../../model/fx/plugins/delay2';

const MIN_TEMPO = 10;

interface D2Params { pan: number; vol: number; dry: number; feedback: number; time: number; offset: number; mode: number; cutoff: number }
const DEFAULTS: D2Params = { pan: 0, vol: 128, dry: 128, feedback: 64, time: 144, offset: 0, mode: 0, cutoff: 128 };

/** Round half to even (Delphi's Round). */
function roundEven(x: number): number {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * A delay of `len` samples whose content written before the last clear()
 * reads as silence (FL re-creates its buffers; this does it in O(1)).
 */
class Line {
  buf: Float32Array;
  w = 0;
  /** Samples written since the last clear. */
  age = 0;
  constructor(n: number) { this.buf = new Float32Array(Math.max(4, n)); }
  size(): number { return this.buf.length; }
  /** The sample written `d` samples ago (1 <= d <= size). */
  read(d: number): number {
    if (d > this.age) return 0;
    let k = this.w - d;
    if (k < 0) k += this.buf.length;
    return this.buf[k];
  }
  write(v: number): void {
    this.buf[this.w] = v;
    if (++this.w >= this.buf.length) this.w = 0;
    if (this.age < 0x3fffffff) this.age++;
  }
  clear(): void { this.age = 0; }
  grow(n: number): void {
    if (n <= this.buf.length) return;
    this.buf = new Float32Array(n);
    this.w = 0;
    this.age = 0;
  }
}

/**
 * FL's Delay 2 smoothing: once per processing block the value heads linearly
 * for its target across the block, at most `lim` per sample (0.001 at 44.1 kHz).
 * Each sample uses the value before it is stepped (FL).
 */
class Ramp {
  v: number;
  private t: number;
  private inc = 0;
  constructor(v: number, private readonly lim: number) { this.v = v; this.t = v; }
  set(t: number, snap = false): void {
    this.t = t;
    if (snap) this.v = t;
  }
  /** Start a block of n samples. */
  block(n: number): void {
    const d = this.t - this.v;
    this.inc = d === 0 ? 0 : Math.max(-this.lim, Math.min(this.lim, d / n));
  }
  next(): number {
    const v = this.v;
    if (this.inc !== 0) {
      this.v += this.inc;
      if ((this.inc > 0 && this.v >= this.t) || (this.inc < 0 && this.v <= this.t)) { this.v = this.t; this.inc = 0; }
    }
    return v;
  }
}

class Delay2 implements EffectInstance {
  private readonly sr: number;
  private p: D2Params = { ...DEFAULTS };
  private fresh = true;
  private lastTempo = 60;
  private readonly A: Line; // line fed by the left input
  private readonly B: Line; // line fed by the right input
  private readonly O: Line; // offset pre-delay
  private D = 0;
  private P = 0;
  private offSide = 0;
  private fA = 0; private fB = 0; // one-pole states
  // per-block ramps (FL); the dry level and the cutoff coefficient switch at once (FL)
  private readonly gVol: Ramp; private readonly gLL: Ramp; private readonly gLR: Ramp; private readonly gRR: Ramp; private readonly gRL: Ramp;
  private readonly gDry: Ramp; private readonly gFb: Ramp; private readonly gCut: Ramp;

  constructor(sr: number) {
    this.sr = sr;
    const n = this.lineLen(DEFAULTS.time);
    this.A = new Line(n);
    this.B = new Line(n);
    this.O = new Line(Math.ceil(0.5 * sr) + 4);
    const lim = 0.001 * (44100 / sr);
    this.gVol = new Ramp(1, lim);
    // the pan reaches its target within one block (no step limit)
    this.gLL = new Ramp(1, Infinity); this.gLR = new Ramp(0, Infinity); this.gRR = new Ramp(1, Infinity); this.gRL = new Ramp(0, Infinity);
    this.gDry = new Ramp(1, lim); this.gFb = new Ramp(0.5, lim); this.gCut = new Ramp(1, lim);
  }

  private lineLen(time: number): number {
    return Math.ceil((Math.min(768, Math.max(1, time)) / 192) * (60 / MIN_TEMPO) * this.sr) + 4;
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Partial<Record<keyof D2Params, unknown>>;
    const p = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof D2Params)[]) {
      const v = q[k];
      if (typeof v === 'number' && Number.isFinite(v)) p[k] = v;
    }
    p.mode = Math.round(Math.min(2, Math.max(0, p.mode)));
    this.p = p;
    const n = this.lineLen(p.time);
    if (n > this.A.size()) { this.A.grow(n); this.B.grow(n); }
    const snap = this.fresh;
    this.fresh = false;
    // input pan, FL's pour law as a 2 x 2 matrix (each coefficient ramps on its own)
    const pan = Math.min(1, Math.max(-1, p.pan / 128));
    this.gLL.set(pan < 0 ? 1 + pan / 2 : 1 - pan, snap);
    this.gLR.set(pan < 0 ? -pan / 2 : 0, snap);
    this.gRR.set(pan < 0 ? 1 + pan : 1 - pan / 2, snap);
    this.gRL.set(pan > 0 ? pan / 2 : 0, snap);
    this.gVol.set(d2Gain(p.vol), snap);
    this.gDry.set(d2Gain(p.dry), true); // FL switches the dry level at once
    this.gFb.set(Math.min(127, Math.max(0, p.feedback)) / 128, snap);
    this.gCut.set(d2CutoffCoef(p.cutoff, this.sr), true); // FL switches the filter coefficient at once
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    const p = this.p, sr = this.sr;
    if (ctx.tempo > 0 && Number.isFinite(ctx.tempo)) this.lastTempo = ctx.tempo;
    // delay length and offset; any change re-creates (clears) the lines, like FL
    const D = Math.min(this.A.size(), Math.max(1, roundEven((Math.min(768, Math.max(1, p.time)) / 192) * (60 / this.lastTempo) * sr)));
    const P = Math.min(this.O.size(), roundEven((d2OffsetMs(p.offset) * sr) / 1000));
    const side = p.offset < 0 ? -1 : p.offset > 0 ? 1 : 0;
    if (D !== this.D || P !== this.P || side !== this.offSide) {
      this.A.clear(); this.B.clear(); this.O.clear();
      this.fA = this.fB = 0;
      this.D = D; this.P = P; this.offSide = side;
    }
    const A = this.A, B = this.B, O = this.O, mode = p.mode;
    this.gVol.block(n); this.gLL.block(n); this.gLR.block(n); this.gRR.block(n); this.gRL.block(n);
    this.gDry.block(n); this.gFb.block(n); this.gCut.block(n);
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      // input pan: FL's pour law (the far side fades, half of it pours into the near side)
      const g = this.gVol.next();
      const ll = this.gLL.next(), lr = this.gLR.next(), rr = this.gRR.next(), rl = this.gRL.next();
      let il = (xl * ll + xr * lr) * g, ir = (xr * rr + xl * rl) * g;
      if (side < 0 && P > 0) { const d = O.read(P); O.write(il); il = d; }
      else if (side > 0 && P > 0) { const d = O.read(P); O.write(ir); ir = d; }
      // the lines belong to the input sides; the mode picks the feedback and output routing
      // (FL: echoes already in the lines move to the other side when the mode changes)
      const oa = A.read(D), ob = B.read(D);
      const fb = this.gFb.next(), a = this.gCut.next();
      const pp = mode === 2;
      this.fA += a * (il + fb * (pp ? ob : oa) - this.fA);
      this.fB += a * (ir + fb * (pp ? oa : ob) - this.fB);
      A.write(this.fA);
      B.write(this.fB);
      const dry = this.gDry.next();
      const swap = mode !== 0;
      L[i] = xl * dry + (swap ? ob : oa);
      R[i] = xr * dry + (swap ? oa : ob);
    }
    if (!Number.isFinite(this.fA + this.fB)) this.reset();
    if (Math.abs(this.fA) < 1e-20) this.fA = 0;
    if (Math.abs(this.fB) < 1e-20) this.fB = 0;
  }

  reset(): void {
    this.A.clear(); this.B.clear(); this.O.clear();
    this.fA = this.fB = 0;
  }

  /** Repeats until -90 dB (capped at 60 s), plus the offset. */
  get tail(): number {
    const p = this.p;
    const T = (Math.min(768, Math.max(1, p.time)) / 192) * (60 / Math.max(1, this.lastTempo));
    const g = Math.min(127, Math.max(0, p.feedback)) / 128;
    const extra = d2OffsetMs(p.offset) / 1000 + 0.05;
    if (g <= 1e-4) return Math.min(60, T + extra);
    const repeats = Math.ceil(Math.log(10 ** (-90 / 20)) / Math.log(g));
    return Math.min(60, (repeats + 1) * T + extra);
  }
}

export const effect: EffectModule = {
  id: 'delay2',
  create: (sampleRate) => new Delay2(sampleRate),
};
