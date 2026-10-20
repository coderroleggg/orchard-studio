// Small allocation-free DSP blocks for the Hardcore pedals (also used by the
// FL Studio Mobile Rack modules): smoothing, interpolated delay lines, LFOs,
// stereo biquads, a 4x polyphase-IIR oversampler and envelope helpers.

import { bilinear, matched, prototype, type BiquadCoefs, type ProtoKind } from '../../../dsp/biquad';

export const TAU = Math.PI * 2;

/** Flush tiny values (denormal guard for recursive state). */
export function fl(x: number): number {
  return x > 1e-18 || x < -1e-18 ? x : 0;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export const dbToLin = (db: number) => Math.pow(10, db / 20);
export const linToDb = (g: number) => (g > 1e-12 ? 20 * Math.log10(g) : -240);

/** Coefficient of a one-pole smoother reaching ~63% in `ms` milliseconds. */
export function onePoleK(ms: number, sr: number): number {
  return ms <= 0 ? 1 : 1 - Math.exp(-1 / (Math.max(1e-6, ms) * 0.001 * sr));
}

/** One-pole parameter smoother (per sample). */
export class Smooth {
  v: number;
  t: number;
  k: number;
  constructor(v = 0, k = 0.002) { this.v = v; this.t = v; this.k = k; }
  set(t: number): void { this.t = t; }
  snap(v = this.t): void { this.v = v; this.t = v; }
  next(): number { this.v += (this.t - this.v) * this.k; return this.v; }
  get settled(): boolean { return Math.abs(this.t - this.v) < 1e-6 * (1 + Math.abs(this.t)); }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Circular delay line (one channel) with fractional reads. */
export class DelayLine {
  readonly buf: Float32Array;
  readonly mask: number;
  w = 0;
  constructor(maxSamples: number) {
    this.buf = new Float32Array(nextPow2(Math.max(8, Math.ceil(maxSamples) + 4)));
    this.mask = this.buf.length - 1;
  }
  get size(): number { return this.buf.length - 4; }
  write(x: number): void { this.buf[this.w] = x; this.w = (this.w + 1) & this.mask; }
  /** Sample written `d` samples ago (d >= 1 reads the previous write). */
  tap(d: number): number { return this.buf[(this.w - d) & this.mask]; }
  /** Linear interpolation, d in samples (>= 1). */
  read(d: number): number {
    const i = Math.floor(d), f = d - i;
    const a = this.buf[(this.w - i) & this.mask], b = this.buf[(this.w - i - 1) & this.mask];
    return a + (b - a) * f;
  }
  /** 4-point Hermite interpolation, d in samples (>= 2). */
  readHermite(d: number): number {
    const i = Math.floor(d), f = d - i, m = this.mask, w = this.w;
    const xm1 = this.buf[(w - i + 1) & m], x0 = this.buf[(w - i) & m], x1 = this.buf[(w - i - 1) & m], x2 = this.buf[(w - i - 2) & m];
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }
  clear(): void { this.buf.fill(0); this.w = 0; }
}

/** Sine LFO (phase in cycles). */
export class Lfo {
  phase = 0;
  inc = 0;
  setRate(hz: number, sr: number): void { this.inc = hz / sr; }
  /** Advance and return sin(2 pi (phase + offset)). */
  next(offset = 0): number {
    const v = Math.sin(TAU * (this.phase + offset));
    this.phase += this.inc;
    if (this.phase >= 1) this.phase -= 1;
    return v;
  }
  /** Value at the current phase plus offset, without advancing. */
  at(offset = 0): number { return Math.sin(TAU * (this.phase + offset)); }
  step(): void { this.phase += this.inc; if (this.phase >= 1) this.phase -= 1; }
}

/** Design a biquad: magnitude-matched (no cramping near Nyquist) unless `bilin`. */
export function design(kind: ProtoKind, f: number, q: number, gainDb: number, sr: number, bilin = false): BiquadCoefs {
  const fc = clamp(f, 5, sr * 0.49);
  const h = prototype(kind, q, gainDb);
  if (bilin || kind === 'allpass' || kind === 'notch') return bilinear(h, fc, sr);
  return matched(h, fc, sr);
}

/** Stereo transposed-direct-form-II biquad. */
export class Biquad2 {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private l1 = 0; private l2 = 0; private r1 = 0; private r2 = 0;
  set(c: BiquadCoefs): void { this.b0 = c.b0; this.b1 = c.b1; this.b2 = c.b2; this.a1 = c.a1; this.a2 = c.a2; }
  reset(): void { this.l1 = this.l2 = this.r1 = this.r2 = 0; }
  tickL(x: number): number {
    const y = this.b0 * x + this.l1;
    this.l1 = this.b1 * x - this.a1 * y + this.l2;
    this.l2 = this.b2 * x - this.a2 * y;
    return y;
  }
  tickR(x: number): number {
    const y = this.b0 * x + this.r1;
    this.r1 = this.b1 * x - this.a1 * y + this.r2;
    this.r2 = this.b2 * x - this.a2 * y;
    return y;
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    let l1 = this.l1, l2 = this.l2, r1 = this.r1, r2 = this.r2;
    for (let i = 0; i < n; i++) {
      const x = L[i], y = b0 * x + l1;
      l1 = b1 * x - a1 * y + l2; l2 = b2 * x - a2 * y; L[i] = y;
      const xr = R[i], yr = b0 * xr + r1;
      r1 = b1 * xr - a1 * yr + r2; r2 = b2 * xr - a2 * yr; R[i] = yr;
    }
    this.l1 = fl(l1); this.l2 = fl(l2); this.r1 = fl(r1); this.r2 = fl(r2);
  }
  flush(): void { this.l1 = fl(this.l1); this.l2 = fl(this.l2); this.r1 = fl(this.r1); this.r2 = fl(this.r2); }
}

/** First-order TPT filter (low / high pass) for one channel. */
export class OnePole1 {
  g = 0.5;
  s = 0;
  setHz(f: number, sr: number): void { const w = Math.tan(Math.PI * clamp(f, 1, sr * 0.49) / sr); this.g = w / (1 + w); }
  lp(x: number): number { const v = (x - this.s) * this.g; const y = v + this.s; this.s = fl(y + v); return y; }
  hp(x: number): number { return x - this.lp(x); }
  reset(): void { this.s = 0; }
}

/** DC blocker (one channel). */
export class DcBlock {
  private x1 = 0; private y1 = 0;
  r = 0.9995;
  setHz(f: number, sr: number): void { this.r = Math.exp((-TAU * f) / sr); }
  tick(x: number): number { const y = x - this.x1 + this.r * this.y1; this.x1 = x; this.y1 = fl(y); return y; }
  reset(): void { this.x1 = this.y1 = 0; }
}

// ---- 4x oversampling with polyphase IIR half-band filters ----
// H(z) = (A0(z^2) + z^-1 A1(z^2)) / 2, Ai = cascades of first-order all-passes.
// Stage 1 (1x <-> 2x): 12 coefficients, ~104 dB rejection, transition 0.49-0.51 fs/2.
// Stage 2 (2x <-> 4x): 4 coefficients (~54 dB) - its transition band is wide.

const HB12_A = [0.036681502163648017, 0.2746317593794541, 0.56109896978791948, 0.769741833862266, 0.8922608180038789, 0.962094548378084];
const HB12_B = [0.13654762463195771, 0.42313861743656667, 0.6775400499741616, 0.839889624849638, 0.9315419599631839, 0.9878163707328971];
const HB4_A = [0.12073211751675449, 0.6632020224193995];
const HB4_B = [0.3903621872345006, 0.890786832653497];

/** Cascade of first-order all-passes (c + z^-1) / (1 + c z^-1). */
class AllpassChain {
  private readonly c: Float64Array;
  private readonly x1: Float64Array;
  private readonly y1: Float64Array;
  constructor(c: number[]) { this.c = Float64Array.from(c); this.x1 = new Float64Array(c.length); this.y1 = new Float64Array(c.length); }
  tick(x: number): number {
    const c = this.c, x1 = this.x1, y1 = this.y1;
    for (let i = 0; i < c.length; i++) {
      const y = c[i] * (x - y1[i]) + x1[i];
      x1[i] = x; y1[i] = y; x = y;
    }
    return x;
  }
  reset(): void { this.x1.fill(0); this.y1.fill(0); }
  flush(): void { for (let i = 0; i < this.c.length; i++) { this.x1[i] = fl(this.x1[i]); this.y1[i] = fl(this.y1[i]); } }
}

class HalfBand {
  private readonly a: AllpassChain;
  private readonly b: AllpassChain;
  private odd = 0;
  constructor(a: number[], b: number[]) { this.a = new AllpassChain(a); this.b = new AllpassChain(b); }
  /** Interpolate: one input -> two outputs (written to out[o], out[o + 1]). */
  up(x: number, out: Float64Array, o: number): void { out[o] = this.a.tick(x); out[o + 1] = this.b.tick(x); }
  /** Decimate: two inputs -> one output. */
  down(even: number, odd: number): number {
    const y = 0.5 * (this.a.tick(even) + this.b.tick(this.odd));
    this.odd = odd;
    return y;
  }
  reset(): void { this.a.reset(); this.b.reset(); this.odd = 0; }
  flush(): void { this.a.flush(); this.b.flush(); }
}

/** 4x up / down sampler for one channel. */
export class Oversampler4 {
  private readonly u1 = new HalfBand(HB12_A, HB12_B);
  private readonly u2a = new HalfBand(HB4_A, HB4_B);
  private readonly d2 = new HalfBand(HB4_A, HB4_B);
  private readonly d1 = new HalfBand(HB12_A, HB12_B);
  private readonly t2 = new Float64Array(2);
  /** Upsample x into out[0..3]. */
  up(x: number, out: Float64Array): void {
    this.u1.up(x, this.t2, 0);
    const a = this.t2[0], b = this.t2[1];
    this.u2a.up(a, out, 0);
    this.u2a.up(b, out, 2);
  }
  /** Downsample in[0..3] to one sample. */
  down(v: Float64Array): number {
    const a = this.d2.down(v[0], v[1]);
    const b = this.d2.down(v[2], v[3]);
    return this.d1.down(a, b);
  }
  reset(): void { this.u1.reset(); this.u2a.reset(); this.d2.reset(); this.d1.reset(); }
  flush(): void { this.u1.flush(); this.u2a.flush(); this.d2.flush(); this.d1.flush(); }
}

/** Envelope follower with separate attack / release (on |x| or a level). */
export class Envelope {
  v = 0;
  ka = 0.5;
  kr = 0.001;
  setTimes(attackMs: number, releaseMs: number, sr: number): void { this.ka = onePoleK(attackMs, sr); this.kr = onePoleK(releaseMs, sr); }
  tick(x: number): number { this.v += (x - this.v) * (x > this.v ? this.ka : this.kr); this.v = fl(this.v); return this.v; }
  reset(): void { this.v = 0; }
}

/** Equal-power-ish gain pair for a pan position p in -1..1 (unity at the centre). */
export function panGains(p: number, out: Float64Array): void {
  const a = (clamp(p, -1, 1) + 1) * 0.25 * Math.PI;
  out[0] = Math.cos(a) * Math.SQRT2;
  out[1] = Math.sin(a) * Math.SQRT2;
}

/** Soft saturation used to keep feedback loops bounded (unity slope at 0). */
export function softClip(x: number): number {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/** Block-rate smoothed parameter (filter settings): eases toward the target once per block. */
export class Glide {
  cur: number;
  tgt: number;
  constructor(v = 0) { this.cur = v; this.tgt = v; }
  set(t: number): void { this.tgt = t; }
  snap(): void { this.cur = this.tgt; }
  /** Move toward the target by factor k (0..1); true when the value changed. */
  step(k: number): boolean {
    const d = this.tgt - this.cur;
    if (d === 0) return false;
    if (Math.abs(d) < 1e-4 * (Math.abs(this.tgt) + 1e-3)) this.cur = this.tgt;
    else this.cur += d * k;
    return true;
  }
}

/** Per-block glide factor for a time constant of `ms` over `n` samples. */
export function glideK(n: number, ms: number, sr: number): number {
  return 1 - Math.exp(-n / Math.max(1, ms * 0.001 * sr));
}

export type RbjKind = 'peak' | 'lowshelf' | 'highshelf' | 'lp' | 'hp';

/**
 * RBJ "Audio EQ Cookbook" biquad (bilinear), with alpha from Q or from a
 * bandwidth in octaves (sin(w0) sinh(ln2/2 BW w0/sin(w0)), the cookbook's
 * digital-bandwidth form). FL's Hardcore EQs match these designs exactly.
 */
export function rbj(kind: RbjKind, f0: number, sr: number, gainDb: number, q: number, bwOct = 0): BiquadCoefs {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * clamp(f0, 1, sr * 0.4999)) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = bwOct > 0 ? sw * Math.sinh(((Math.LN2 / 2) * bwOct * w0) / sw) : sw / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (kind) {
    case 'peak':
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cw + s); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - s);
      a0 = A + 1 + (A - 1) * cw + s; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - s; break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s);
      a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s; break;
    }
    case 'lp':
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    default:
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** |H(f)| of a biquad. */
export function biquadMag(c: BiquadCoefs, f: number, sr: number): number {
  const w = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cw + c.b2 * c2, ni = -(c.b1 * sw + c.b2 * s2);
  const dr = 1 + c.a1 * cw + c.a2 * c2, di = -(c.a1 * sw + c.a2 * s2);
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** Linear interpolation in a table sampled at v = 0 .. 1 in equal steps. */
export function lerpTable(t: readonly number[], v: number): number {
  const x = clamp(v, 0, 1) * (t.length - 1), i = Math.min(t.length - 2, Math.floor(x)), f = x - i;
  return t[i] + (t[i + 1] - t[i]) * f;
}
