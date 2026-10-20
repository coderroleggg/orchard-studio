// Delay (FL: Fruity Delay, legacy), measured from FL's own plugin with
// flfxhost (docs/research/fx/delay.md):
//
//   in x input (ramped) (+ feedback x 0.99 fb, ramped) -> one-pole low-pass -> line (D) per input side
//   normal: L line -> L out; inverted: L line -> R out; ping pong: crossed feedback, swapped outputs
//   out = in + wet (the dry signal always passes at unity)
//
// D = steps x round-half-even(sr x 60 / (4 x tempo)), tempo = the song's or
// round(60 + v x 220 / 1024). Like FL, any change of the delay length clears
// the line (the next echoes start from silence). Input and feedback ramp per
// processing block toward their targets, at most 0.001 per sample at 44.1 kHz.

import type { EffectInstance, EffectModule, FxContext } from '../types';
import { delayCutoffCoef, delayMode, delayTempo } from '../../../model/fx/plugins/delay';

const MIN_TEMPO = 10;
/** The line is sized for tempos down to this (or the song's tempo when slower). */
const SIZE_TEMPO = 30;

interface DlParams { input: number; feedback: number; cutoff: number; tempo: number; steps: number; mode: number }
const DEFAULTS: DlParams = { input: 338, feedback: 512, cutoff: 1024, tempo: 0, steps: 3, mode: 0 };

/** Round half to even (Delphi's Round). */
function roundEven(x: number): number {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** A delay line; content written before the last clear() reads as silence (FL rebuilds its buffer). */
class Line {
  buf: Float32Array;
  w = 0;
  age = 0;
  constructor(n: number) { this.buf = new Float32Array(Math.max(4, n)); }
  size(): number { return this.buf.length; }
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

/** FL's per-block ramp: linear toward the target across the block, at most `lim` per sample (value used, then stepped). */
class Ramp {
  v: number;
  t: number;
  inc = 0;
  constructor(v: number) { this.v = v; this.t = v; }
  block(n: number, lim: number): void {
    const d = this.t - this.v;
    this.inc = d === 0 ? 0 : Math.max(-lim, Math.min(lim, d / n));
  }
  end(n: number, lim: number): void {
    if (this.inc === 0) return;
    if (Math.abs(this.inc) < lim) this.v = this.t;
    else {
      this.v += this.inc * n;
      if ((this.inc > 0 && this.v > this.t) || (this.inc < 0 && this.v < this.t)) this.v = this.t;
    }
  }
}

class Delay implements EffectInstance {
  private readonly sr: number;
  private p: DlParams = { ...DEFAULTS };
  private fresh = true;
  private lastTempo = 120;
  private readonly A: Line;
  private readonly B: Line;
  private D = 0;
  private fA = 0; private fB = 0;
  private readonly gIn = new Ramp(338 / 1024);
  private readonly gFb = new Ramp((512 / 1024) * 0.99);

  constructor(sr: number) {
    this.sr = sr;
    const n = this.lineLen(DEFAULTS.steps, SIZE_TEMPO);
    this.A = new Line(n);
    this.B = new Line(n);
  }

  /** Line size for `steps` at `bpm`. */
  private lineLen(steps: number, bpm: number): number {
    return Math.ceil(steps * ((this.sr * 60) / (4 * bpm))) + 4;
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Partial<Record<keyof DlParams, unknown>>;
    const p = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof DlParams)[]) {
      const v = q[k];
      if (typeof v === 'number' && Number.isFinite(v)) p[k] = v;
    }
    p.steps = Math.round(Math.min(16, Math.max(1, p.steps)));
    this.p = p;
    this.gIn.t = Math.min(1024, Math.max(0, p.input)) / 1024;
    this.gFb.t = (Math.min(1024, Math.max(0, p.feedback)) / 1024) * 0.99;
    if (this.fresh) { this.gIn.v = this.gIn.t; this.gFb.v = this.gFb.t; this.fresh = false; }
    const bpm = Math.round(p.tempo) <= 0 ? Math.max(MIN_TEMPO, Math.min(SIZE_TEMPO, this.lastTempo)) : delayTempo(p.tempo);
    const n = this.lineLen(p.steps, bpm);
    if (n > this.A.size()) { this.A.grow(n); this.B.grow(n); this.D = 0; }
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    const p = this.p, sr = this.sr;
    if (ctx.tempo > 0 && Number.isFinite(ctx.tempo)) this.lastTempo = ctx.tempo;
    const bpm = Math.round(p.tempo) <= 0 ? Math.max(MIN_TEMPO, this.lastTempo) : delayTempo(p.tempo);
    const D = Math.min(this.A.size(), Math.max(1, p.steps * roundEven((sr * 60) / (4 * bpm))));
    if (D !== this.D) {
      this.A.clear(); this.B.clear();
      this.fA = this.fB = 0;
      this.D = D;
    }
    const lim = 0.001 * (44100 / sr);
    const A = this.A, B = this.B, mode = delayMode(p.mode), pp = mode === 2, swap = mode !== 0;
    const a = delayCutoffCoef(p.cutoff);
    const gi = this.gIn, gf = this.gFb;
    gi.block(n, lim); gf.block(n, lim);
    let g = gi.v, fb = gf.v;
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      const oa = A.read(D), ob = B.read(D);
      this.fA += a * (xl * g + fb * (pp ? ob : oa) - this.fA);
      this.fB += a * (xr * g + fb * (pp ? oa : ob) - this.fB);
      A.write(this.fA);
      B.write(this.fB);
      L[i] = xl + (swap ? ob : oa);
      R[i] = xr + (swap ? oa : ob);
      g += gi.inc; fb += gf.inc;
    }
    gi.end(n, lim); gf.end(n, lim);
    if (!Number.isFinite(this.fA + this.fB)) this.reset();
    if (Math.abs(this.fA) < 1e-20) this.fA = 0;
    if (Math.abs(this.fB) < 1e-20) this.fB = 0;
  }

  reset(): void {
    this.A.clear(); this.B.clear();
    this.fA = this.fB = 0;
  }

  /** Repeats until -90 dB (capped at 60 s). */
  get tail(): number {
    const p = this.p;
    const bpm = Math.round(p.tempo) <= 0 ? Math.max(MIN_TEMPO, this.lastTempo) : delayTempo(p.tempo);
    const T = (p.steps * 60) / (4 * bpm);
    const g = (Math.min(1024, Math.max(0, p.feedback)) / 1024) * 0.99;
    if (g <= 1e-4) return Math.min(60, T + 0.05);
    const repeats = Math.ceil(Math.log(10 ** (-90 / 20)) / Math.log(g));
    return Math.min(60, (repeats + 1) * T + 0.05);
  }
}

export const effect: EffectModule = {
  id: 'delay',
  create: (sampleRate) => new Delay(sampleRate),
};
