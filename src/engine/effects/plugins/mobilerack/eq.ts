// Mobile Rack equalisers and filter: Equalizer (Param EQ), Graphic EQ, Tuned EQ
// and Filter. Designs were identified on FL's binary (flfxhost impulse
// responses fitted with Prony's method):
//  - Equalizer: analog RBJ prototypes with impulse-invariant poles; the
//    numerator is FL's own: peak = 1 + (G - 1) (1 - r)(1 - z^-1)(1/2 + (r + 1/2) z^-1) / D,
//    low shelf = 1 + (G - 1) [D(1) (1/16 + 10/16 z^-1 + 5/16 z^-2) + BP / (A + 1)] / D,
//    high shelf = G x low shelf(1/A). Gains are twice the displayed dB (the
//    "+12 dB" end boosts 24 dB, as in FL); bandwidth = 0.25 + 7 v octaves;
//    one sample of latency.
//  - Graphic / Tuned EQ: RBJ cookbook shelves and bells (bilinear, digital
//    bandwidth form), gains twice the displayed dB, 8 samples of latency.
//  - Filter: 2/4/8 cascaded RBJ sections (24/48/96 dB/oct), Q = 0.4 + res^2;
//    band pass sections use the skirt-gain form with Q x 2; FL's low / high
//    pass sections carry a frequency- and Q-dependent gain (measured table);
//    one sample of latency.

import type { BiquadCoefs } from '../../../dsp/biquad';
import { Biquad2, rbj } from '../hardcore/dsp';
import { Latency, clamp, type MrModule } from './common';
import { mrMap } from '../../../../model/fx/plugins/mobilerack/modules';

const LN2_2 = Math.LN2 / 2;
const trunc = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.trunc(v * (n - 1) + 1e-7)));

/** Impulse-invariant denominator of s^2 + 2 zeta w0 s + w0^2 (w0 in rad/sample). */
function iiPoles(w0: number, zeta: number, out: Float64Array): void {
  w0 = Math.min(w0, Math.PI * 0.98);
  if (zeta < 1) {
    const r = Math.exp(-zeta * w0), wd = w0 * Math.sqrt(1 - zeta * zeta);
    out[1] = -2 * r * Math.cos(wd);
    out[2] = r * r;
  } else {
    const qq = w0 * Math.sqrt(zeta * zeta - 1);
    const p1 = Math.exp(-zeta * w0 + qq), p2 = Math.exp(-zeta * w0 - qq);
    out[1] = -(p1 + p2);
    out[2] = p1 * p2;
  }
}

const tmpA = new Float64Array(3);

/** FL Studio Mobile Equalizer band (kind 0 low shelf, 1 peak, 2 high shelf; gainDb = actual gain). */
export function flmBand(kind: number, f0: number, gainDb: number, bwOct: number, sr: number, out: BiquadCoefs): BiquadCoefs {
  const A = Math.pow(10, gainDb / 40), G = A * A;
  const Q = 1 / (2 * Math.sinh(LN2_2 * bwOct));
  const w0 = (2 * Math.PI * f0) / sr;
  if (kind === 1) {
    iiPoles(w0, 1 / (2 * A * Q), tmpA);
    const a1 = tmpA[1], a2 = tmpA[2], r = Math.sqrt(Math.max(0, a2));
    const k = (G - 1) * (1 - r);
    out.b0 = 1 + k * 0.5; out.b1 = a1 + k * r; out.b2 = a2 - k * (r + 0.5); out.a1 = a1; out.a2 = a2;
    return out;
  }
  // low shelf (the high shelf is G x low shelf with 1/A)
  const As = kind === 2 ? 1 / A : A, Gs = As * As;
  iiPoles(w0 / Math.sqrt(As), 1 / (2 * Q), tmpA);
  const a1 = tmpA[1], a2 = tmpA[2], r = Math.sqrt(Math.max(0, a2));
  const d1 = 1 + a1 + a2, bpK = (1 - r) / (As + 1);
  const g = Gs - 1;
  let b0 = 1 + g * (d1 / 16 + bpK * 0.5);
  let b1 = a1 + g * (d1 * 10 / 16 + bpK * r);
  let b2 = a2 + g * (d1 * 5 / 16 - bpK * (r + 0.5));
  if (kind === 2) { b0 *= G; b1 *= G; b2 *= G; }
  out.b0 = b0; out.b1 = b1; out.b2 = b2; out.a1 = a1; out.a2 = a2;
  return out;
}

/** One biquad on a single channel with its state. */
class Bq {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  z1 = 0; z2 = 0;
  set(c: BiquadCoefs): void { this.b0 = c.b0; this.b1 = c.b1; this.b2 = c.b2; this.a1 = c.a1; this.a2 = c.a2; }
  tick(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  flush(): void { if (Math.abs(this.z1) < 1e-20) this.z1 = 0; if (Math.abs(this.z2) < 1e-20) this.z2 = 0; }
  reset(): void { this.z1 = this.z2 = 0; }
}

/** Block-rate glide of a parameter vector toward its targets. */
class Glides {
  readonly cur: Float64Array;
  readonly tgt: Float64Array;
  first = true;
  constructor(n: number) { this.cur = new Float64Array(n); this.tgt = new Float64Array(n); }
  /** Returns true when something moved. */
  step(k: number): boolean {
    let moved = false;
    for (let i = 0; i < this.cur.length; i++) {
      const d = this.tgt[i] - this.cur[i];
      if (d === 0) continue;
      moved = true;
      this.cur[i] = Math.abs(d) < 1e-5 ? this.tgt[i] : this.cur[i] + d * k;
    }
    return moved;
  }
  snap(): void { this.cur.set(this.tgt); }
}

const glideBlockK = (n: number, sr: number) => 1 - Math.exp(-n / (0.02 * sr));

// ---------------------------------------------------------------------------

/** Equalizer (Param EQ): four bands (kind, gain, frequency, bandwidth, channel). */
export class ParamEq implements MrModule {
  private readonly sr: number;
  private readonly g = new Glides(12); // per band: gainDb, log f, bw
  private readonly kind = new Int32Array(4);
  private readonly chan = new Int32Array(4);
  private readonly fL = Array.from({ length: 4 }, () => new Bq());
  private readonly fR = Array.from({ length: 4 }, () => new Bq());
  private readonly c: BiquadCoefs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  private readonly active = new Uint8Array(4);
  private readonly lat = new Latency(1);
  private dirty = true;

  constructor(sr: number) { this.sr = sr; }

  set(p: Float64Array): void {
    for (let b = 0; b < 4; b++) {
      const o = 1 + b * 4;
      this.g.tgt[b * 3] = 48 * (p[o] - 0.5);
      this.g.tgt[b * 3 + 1] = Math.log(mrMap.peqFreqHz(p[o + 1]));
      this.g.tgt[b * 3 + 2] = 0.25 + 7 * p[o + 2];
      const k = trunc(p[o + 3], 3);
      if (k !== this.kind[b]) { this.kind[b] = k; this.dirty = true; }
      this.chan[b] = trunc(p[17 + b], 5);
    }
    if (this.g.first) { this.g.snap(); this.g.first = false; this.dirty = true; }
  }

  snap(): void { this.g.snap(); this.dirty = true; }

  private coefs(): void {
    for (let b = 0; b < 4; b++) {
      const gdb = this.g.cur[b * 3];
      this.active[b] = Math.abs(gdb) > 1e-4 ? 1 : 0;
      if (!this.active[b]) continue;
      flmBand(this.kind[b], Math.exp(this.g.cur[b * 3 + 1]), gdb, this.g.cur[b * 3 + 2], this.sr, this.c);
      this.fL[b].set(this.c); this.fR[b].set(this.c);
    }
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.g.step(glideBlockK(n, this.sr)) || this.dirty) { this.dirty = false; this.coefs(); }
    for (let b = 0; b < 4; b++) {
      if (!this.active[b]) continue;
      const fl = this.fL[b], fr = this.fR[b];
      switch (this.chan[b]) {
        case 1: for (let i = 0; i < n; i++) L[i] = fl.tick(L[i]); break;
        case 2: for (let i = 0; i < n; i++) R[i] = fr.tick(R[i]); break;
        case 3: for (let i = 0; i < n; i++) { const m = 0.5 * (L[i] + R[i]), s = 0.5 * (L[i] - R[i]); const y = fl.tick(m); L[i] = y + s; R[i] = y - s; } break;
        case 4: for (let i = 0; i < n; i++) { const m = 0.5 * (L[i] + R[i]), s = 0.5 * (L[i] - R[i]); const y = fl.tick(s); L[i] = m + y; R[i] = m - y; } break;
        default: for (let i = 0; i < n; i++) { L[i] = fl.tick(L[i]); R[i] = fr.tick(R[i]); }
      }
      fl.flush(); fr.flush();
    }
    this.lat.process(L, R, n);
  }

  reset(): void { for (const f of this.fL) f.reset(); for (const f of this.fR) f.reset(); this.lat.reset(); }
  tail(): number { return 0.2; }

  /** Current response for the editor curve: per band coefficients. */
  monitor() {
    const out: number[] = [];
    for (let b = 0; b < 4; b++) {
      const f = this.fL[b];
      out.push(this.active[b], f.b0, f.b1, f.b2, f.a1, f.a2);
    }
    return { bands: out, sr: this.sr };
  }
}

// ---------------------------------------------------------------------------

const GEQ_F = [80, 160, 375, 750, 1500, 3000, 6000, 12000];
/** Tuned EQ band centres at tuning C: C2 .. C9. */
const TEQ_F = [65.40639, 130.81278, 261.62557, 523.25113, 1046.5023, 2093.0045, 4186.009, 8372.018];

/** Eight RBJ bands (shelf, six bells, shelf) with block-rate gain glides. */
class EightBand implements MrModule {
  protected readonly sr: number;
  protected readonly f = Array.from({ length: 8 }, () => new Biquad2());
  protected readonly gdb = new Glides(8);
  protected freq = new Float64Array(8);
  protected bw = 1;
  protected readonly active = new Uint8Array(8);
  private readonly lat: Latency;
  protected dirty = true;

  constructor(sr: number) { this.sr = sr; this.lat = new Latency(Math.round((8 * sr) / 48000)); }

  set(p: Float64Array): void {
    for (let b = 0; b < 8; b++) this.gdb.tgt[b] = 48 * (p[1 + b] - 0.5);
    if (this.gdb.first) { this.gdb.snap(); this.gdb.first = false; }
    this.dirty = true;
  }

  snap(): void { this.gdb.snap(); this.dirty = true; }

  protected coefs(): void {
    for (let b = 0; b < 8; b++) {
      const g = this.gdb.cur[b];
      this.active[b] = Math.abs(g) > 1e-4 ? 1 : 0;
      if (!this.active[b]) continue;
      const kind = b === 0 ? 'lowshelf' : b === 7 ? 'highshelf' : 'peak';
      this.f[b].set(rbj(kind, this.freq[b], this.sr, g, 0, this.bw));
    }
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.gdb.step(glideBlockK(n, this.sr)) || this.dirty) { this.dirty = false; this.coefs(); }
    for (let b = 0; b < 8; b++) if (this.active[b]) this.f[b].process(L, R, n);
    this.lat.process(L, R, n);
  }

  reset(): void { for (const f of this.f) f.reset(); this.lat.reset(); }
  tail(): number { return 0.2; }

  monitor() {
    const out: number[] = [];
    for (let b = 0; b < 8; b++) { const f = this.f[b]; out.push(this.active[b], f.b0, f.b1, f.b2, f.a1, f.a2); }
    return { bands: out, sr: this.sr };
  }
}

/** Graphic EQ: shelves at 80 Hz / 12 kHz, bells at 160 Hz .. 6 kHz, 1 octave, +-24 dB. */
export class GraphicEq extends EightBand {
  constructor(sr: number) { super(sr); this.freq = Float64Array.from(GEQ_F); this.bw = 1; }
}

/** Tuned EQ: bands on the C notes C2..C9 shifted by Tuning semitones; bandwidth 0.1 + 10 v^3 octaves. */
export class TunedEq extends EightBand {
  set(p: Float64Array): void {
    super.set(p);
    const t = Math.min(11, Math.max(0, Math.trunc(p[9] * 11 + 1e-7)));
    const k = Math.pow(2, t / 12);
    for (let b = 0; b < 8; b++) this.freq[b] = TEQ_F[b] * k;
    const v = p[10];
    this.bw = 0.1 + 10 * v * v * v;
  }
}

// ---------------------------------------------------------------------------

/** FL's low pass section gain vs w (rad/sample) and resonance (columns res = 0, .25, .5, .75, 1). */
const FG_W = [0.01731, 0.02578, 0.0384, 0.0572, 0.0852, 0.12691, 0.18905, 0.2816, 0.41946, 0.62482, 0.93072, 1.38637, 2.06511, 3.07614];
const FG = [
  [0.904, 0.9087, 0.9154, 0.9253, 0.9396, 0.96, 0.9884, 1.0268, 1.0759, 1.1339, 1.1931, 1.2348, 1.2119, 0.9295],
  [0.9028, 0.9066, 0.9127, 0.9213, 0.9338, 0.9517, 0.9769, 1.0112, 1.0558, 1.1093, 1.1649, 1.2048, 1.1828, 0.9249],
  [0.9005, 0.9032, 0.9074, 0.9137, 0.9228, 0.9359, 0.9547, 0.9808, 1.0156, 1.0587, 1.1053, 1.1398, 1.1207, 0.9164],
  [0.8985, 0.9005, 0.9033, 0.9075, 0.9138, 0.9229, 0.9361, 0.9546, 0.98, 1.0124, 1.0486, 1.0764, 1.0609, 0.9094],
  [0.897, 0.8984, 0.9005, 0.9035, 0.9078, 0.9142, 0.9235, 0.9367, 0.9551, 0.979, 1.0065, 1.028, 1.0159, 0.9047],
];
const FG0 = 2 / Math.sqrt(5);

/** Per-section gain of FL's Filter low pass at w (rad/sample) and resonance r (0..1). */
export function filterSectionGain(w: number, r: number): number {
  const x = clamp(r, 0, 1) * 4, j = Math.min(3, Math.floor(x)), fj = x - j;
  const col = (row: number[]) => {
    if (w <= FG_W[0]) return FG0 + (row[0] - FG0) * (w / FG_W[0]);
    if (w >= FG_W[FG_W.length - 1]) return row[row.length - 1];
    let i = 0;
    while (i < FG_W.length - 2 && w > FG_W[i + 1]) i++;
    const t = Math.log(w / FG_W[i]) / Math.log(FG_W[i + 1] / FG_W[i]);
    return row[i] + (row[i + 1] - row[i]) * t;
  };
  return col(FG[j]) * (1 - fj) + col(FG[j + 1]) * fj;
}

/** Filter: LP / BP / HP, 24 / 48 / 96 dB per octave. */
export class Filter implements MrModule {
  private readonly sr: number;
  private readonly secs = Array.from({ length: 8 }, () => new Biquad2());
  private readonly c: BiquadCoefs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  private readonly g = new Glides(2); // log f, res
  private kind = 0;
  private nsec = 4;
  private dirty = true;
  private readonly lat = new Latency(1);

  constructor(sr: number) { this.sr = sr; }

  set(p: Float64Array): void {
    this.g.tgt[0] = Math.log(mrMap.filterHz(p[1]));
    this.g.tgt[1] = p[2];
    const k = trunc(p[3], 3), s = [2, 4, 8][trunc(p[4], 3)];
    if (k !== this.kind || s !== this.nsec) {
      if (s > this.nsec) for (let i = this.nsec; i < s; i++) this.secs[i].reset();
      this.kind = k; this.nsec = s; this.dirty = true;
    }
    if (this.g.first) { this.g.snap(); this.g.first = false; this.dirty = true; }
  }

  snap(): void { this.g.snap(); this.dirty = true; }

  private coefs(): void {
    const f = Math.min(Math.exp(this.g.cur[0]), this.sr * 0.49);
    const r = this.g.cur[1];
    const Q = 0.4 + r * r;
    const w = (2 * Math.PI * f) / this.sr;
    const cw = Math.cos(w), sw = Math.sin(w);
    if (this.kind === 1) {
      // skirt-gain band pass (peak = Q_bp), Q_bp = 2 Q
      const qb = 2 * Q, alpha = sw / (2 * qb), a0 = 1 + alpha;
      const c = this.c;
      c.b0 = (sw / 2) / a0; c.b1 = 0; c.b2 = -(sw / 2) / a0; c.a1 = (-2 * cw) / a0; c.a2 = (1 - alpha) / a0;
    } else {
      const base = rbj(this.kind === 0 ? 'lp' : 'hp', f, this.sr, 0, Q);
      const gain = filterSectionGain(w, r) * (this.kind === 2 ? Math.sqrt(1.25) : 1);
      const c = this.c;
      c.b0 = base.b0 * gain; c.b1 = base.b1 * gain; c.b2 = base.b2 * gain; c.a1 = base.a1; c.a2 = base.a2;
    }
    for (let i = 0; i < this.nsec; i++) this.secs[i].set(this.c);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.g.step(glideBlockK(n, this.sr)) || this.dirty) { this.dirty = false; this.coefs(); }
    for (let i = 0; i < this.nsec; i++) this.secs[i].process(L, R, n);
    this.lat.process(L, R, n);
  }

  reset(): void { for (const s of this.secs) s.reset(); this.lat.reset(); }
  tail(): number { return 0.3; }
}
