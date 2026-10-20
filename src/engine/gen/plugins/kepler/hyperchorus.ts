// Kepler Exo hyper chorus (engine.dylib: 0xec68 constructor, 0xf030 sample rate, 0xf0ac parameters, 0xee0c process,
// 0x15080 one bank of four chorus lines, 0x14ec0 bank parameters, 0x12fc4 / 0x12f4c post filters, 0xedd8 reset).
//
// Two banks of four stereo chorus lines (the "lines" switch enables the second bank). Every line has a 65536-sample
// delay buffer per channel with a four-point cubic read, a modulated delay time (base delay x (1 + depth x triangle-ish
// LFO), the right channel from a second phase of the same LFO), a feedback of its own previous output, and an input
// that an LFO "movement" pans between the left and right input (equal power). The eight outputs are summed per
// channel, run through a low-pass and an optional high-pass (a 10 ms cross-fade in and out), and mixed with the dry signal
// by an equal-power law. The per-line ranges are FL's table (one row per line: delay ms, modulation rate Hz, modulation
// depth %, movement rate Hz; low and high end). The start phases come from libc's rand(), which in FL's process is the
// Park-Miller sequence of seed 1 (a fresh instance takes the first sixteen values). All arithmetic is single precision
// without fused multiply-adds (NEON lane operations) except the post filters; the sample rate only enters the
// parameter conversions (it is a double @44100 in FL's constructor and set through the engine's sample rate).

import { f32, fma32 } from './fmath';
import { exp2f } from './applemath';

/** Per line (rows: bank 0 lines 0..3, bank 1 lines 0..3): delay ms lo/hi, mod rate Hz lo/hi, mod depth % lo/hi, movement rate Hz lo/hi. */
const LINE_TABLE = Float32Array.of(
  2.0, 6.0, 1.5, 2.47, 20.0, 80.0, 0.33, 3.56,
  3.5, 8.25, 1.57, 3.41, 20.0, 80.0, 0.29, 2.66,
  6.5, 10.0, 0.38, 3.64, 20.0, 80.0, 0.26, 3.78,
  5.0, 12.8, 1.29, 3.68, 20.0, 80.0, 0.14, 2.98,
  7.1, 16.6, 3.41, 5.03, 20.0, 80.0, 0.44, 5.06,
  9.1, 15.1, 2.47, 5.37, 20.0, 80.0, 0.66, 8.08,
  8.3, 16.8, 3.01, 6.02, 20.0, 80.0, 0.93, 6.02,
  9.6, 17.7, 3.3, 6.5, 20.0, 80.0, 0.41, 10.22,
);

/** The default values of the eleven raw parameters (FL's constructor), index = hyper chorus parameter. */
const RAW_DEFAULT = [0.4, 0.5, 0.4, 0.4, 0.3, 0.3, 0.0, 1.0, 0.0, 0.5, 0.1];

const PAN_K = f32(1.4144271612167358);
const LP_K = f32(4.945435523986816);
const HP_K = f32(6.505149841308594);
const LINE_LEN = 0x10000;

/** libc rand() as FL's process has it before anything seeds it: x <- 16807 x mod (2^31 - 1), returned as is. */
export class Rand {
  private x = 1;
  next(): number {
    // Schrage's method keeps the product inside 53 bits
    const hi = Math.floor(this.x / 127773), lo = this.x % 127773;
    let y = 16807 * lo - 2836 * hi;
    if (y < 0) y += 0x7fffffff;
    this.x = y;
    return y;
  }
  /** 0xec2c: a float in 0..1 */
  unit(): number {
    const f = f32(this.next() / 2147483647);
    return f < 0 ? 0 : Math.min(f, 1);
  }
}

/** The generic stereo biquad of the engine (0x12f4c process, 0x12fc4 design) with a double precision designer. */
class Biquad2 {
  sr = 44100;
  b0 = 0; b1 = 0; b2 = 0; na1 = 0; na2 = 0;      // @0x08 .. 0x18 (the feedback terms are stored negated)
  x1l = 0; x2l = 0; y1l = 0; y2l = 0;             // @0x24 0x28 0x1c 0x20
  x1r = 0; x2r = 0; y1r = 0; y2r = 0;             // @0x34 0x38 0x2c 0x30

  clear(): void { this.x1l = this.x2l = this.y1l = this.y2l = this.x1r = this.x2r = this.y1r = this.y2r = 0; }

  /** 0x12fc4 for types 1 (low-pass) and 2 (high-pass) with Q 0.5 and 0 dB. */
  design(type: number, fc: number): void {
    // FL's filter is unstable above the Nyquist frequency (the 22 kHz low-pass at sample rates below 44.1 kHz ends
    // in infinities): the frequency stays just below it, which never changes a rate of 44.1 kHz or more
    fc = Math.min(fc, this.sr * 0.49995);
    const w = (fc * 6.283185307179586) / this.sr;
    const sin = Math.sin(w), cos = Math.cos(w);
    const alpha = sin / (0.5 + 0.5);
    let b0: number, b1: number, b2: number;
    if (type === 1) { b1 = 1 - cos; b2 = b1 * 0.5; b0 = b2; } else { const p = cos + 1; b2 = p * 0.5; b1 = -p; b0 = b2; }
    const a0 = alpha + 1, a1 = cos * -2, a2 = 1 - alpha;
    this.na1 = -f32(a1 / a0);
    this.na2 = -f32(a2 / a0);
    this.b0 = f32(1 * f32(b0 / a0));
    this.b1 = f32(1 * f32(b1 / a0));
    this.b2 = f32(1 * f32(b2 / a0));
  }

  /** 0x12f4c: both channels in place (io[0] = L, io[1] = R). */
  process(io: Float32Array): void {
    const xl = io[0], xr = io[1];
    let y = fma32(this.b0, xl, f32(this.b1 * this.x1l));
    y = fma32(this.b2, this.x2l, y);
    y = fma32(this.na1, this.y1l, y);
    y = fma32(this.na2, this.y2l, y);
    this.x2l = this.x1l; this.x1l = xl; this.y2l = this.y1l; this.y1l = y;
    let z = fma32(this.b0, xr, f32(this.b1 * this.x1r));
    z = fma32(this.b2, this.x2r, z);
    z = fma32(this.na1, this.y1r, z);
    z = fma32(this.na2, this.y2r, z);
    this.x2r = this.x1r; this.x1r = xr; this.y2r = this.y1r; this.y1r = z;
    io[0] = y; io[1] = z;
  }
}

/** Four chorus lines (left and right buffer each). */
class Bank {
  readonly out = new Float32Array(8);     // @0x00 left lanes, @0x10 right lanes: the last interpolated outputs
  readonly delay = new Float32Array(4);   // @0x20 base delay in samples
  readonly fb = new Float32Array(4);      // @0x30 feedback
  readonly depth = new Float32Array(4);   // @0x40 modulation depth
  readonly phD = new Float32Array(4);     // @0x50 modulation LFO phase
  readonly rateD = new Float32Array(4);   // @0x60 modulation LFO rate (per sample)
  readonly offF = new Float32Array(4);    // @0x70 phase offset of the right channel's LFO
  readonly phA = new Float32Array(4);     // @0x80 movement LFO phase
  readonly rateA = new Float32Array(4);   // @0x90 movement LFO rate
  readonly move = new Float32Array(4);    // @0xa0 movement depth
  readonly bufs: Float32Array[] = [];     // 4 left then 4 right lines
  w = 0;                                  // @0x2000b0 write index (16 bit)
  sr = 44100;                             // @0x2000b8
  readonly row: number;                   // @0x2000c0 first table row of this bank (0 or 4)
  private readonly tmp = new Float32Array(8);

  constructor(row: number, rng: Rand) {
    this.row = row;
    for (let i = 0; i < 8; i++) this.bufs.push(new Float32Array(LINE_LEN));
    for (let i = 0; i < 4; i++) this.phD[i] = rng.unit();
    for (let i = 0; i < 4; i++) this.phA[i] = rng.unit();
  }

  /** 0x14e90: silence (outputs and delay lines). */
  clear(): void {
    this.out.fill(0);
    for (const b of this.bufs) b.fill(0);
    this.w = 0;
  }

  /** 0x14ec0 */
  setParam(idx: number, v: number): void {
    const T = LINE_TABLE, sr = this.sr, srf = f32(sr);
    switch (idx) {
      case 0:
        for (let i = 0; i < 4; i++) {
          const o = (this.row + i) * 8, lo = T[o];
          this.delay[i] = f32(f32(fma32(v, f32(T[o + 1] - lo), lo) * f32(0.0010000000474974513)) * srf);
        }
        break;
      case 1: this.fb.fill(f32(v * f32(0.699999988079071))); break;
      case 2:
        for (let i = 0; i < 4; i++) {
          const o = (this.row + i) * 8, lo = T[o + 2];
          this.rateD[i] = f32(fma32(v, f32(T[o + 3] - lo), lo) / srf);
        }
        break;
      case 3:
        for (let i = 0; i < 4; i++) {
          const o = (this.row + i) * 8, lo = T[o + 4];
          const s = f32(fma32(v, f32(T[o + 5] - lo), lo) * f32(0.009999999776482582));
          this.depth[i] = f32(f32(s * s) * 0.5);
        }
        break;
      case 4: this.move.fill(f32(v * f32(0.49900001287460327))); break;
      case 5:
        for (let i = 0; i < 4; i++) {
          const o = (this.row + i) * 8, lo = T[o + 6];
          this.rateA[i] = f32(fma32(v, f32(T[o + 7] - lo), lo) / srf);
        }
        break;
      case 10: this.offF.fill(f32(f32(f32(v * v) * v) * 0.25)); break;
      default: break;
    }
  }

  /** the triangle-like wave of FL's LFOs from a phase p in 0..1: 4 * ((m1 - m1^2) - (m2 - m2^2)), t = 2p */
  private static wave(p: number): number {
    const t = f32(p + p);
    const m1 = Math.min(t, 1);
    const m2 = f32(Math.max(t, 1) + -1);
    return f32(f32(f32(m1 - f32(m1 * m1)) - f32(m2 - f32(m2 * m2))) * 4);
  }

  /** 0x15080: one sample; the outputs stay in this.out. */
  process(lin: number, rin: number): void {
    const w = this.w;
    const out = this.out, tmp = this.tmp;
    const pl = new Float32Array(4), pr = new Float32Array(4), dl = new Float32Array(4), dr = new Float32Array(4);
    for (let k = 0; k < 4; k++) {
      // movement: pan of the line's inputs
      const wv = Bank.wave(this.phA[k]);
      const p = f32(f32(this.move[k] * wv) + 0.5);
      const gl = f32(f32(Math.sqrt(f32(1 - p))) * PAN_K);
      const gr = f32(f32(Math.sqrt(p)) * PAN_K);
      const aL = f32(gl * lin), aR = f32(gr * rin);
      // modulation LFOs
      const M = Bank.wave(this.phD[k]);
      let q = f32(this.phD[k] + this.offF[k]);
      q = f32(q - Math.trunc(q));
      const N = Bank.wave(q);
      const gc = f32(this.delay[k] * this.depth[k]);
      dl[k] = f32(this.delay[k] + f32(M * gc));
      dr[k] = f32(this.delay[k] + f32(gc * N));
      pl[k] = f32(aL + f32(this.fb[k] * out[k]));
      pr[k] = f32(aR + f32(this.fb[k] * out[4 + k]));
    }
    for (let k = 0; k < 4; k++) { this.bufs[k][w] = pl[k]; this.bufs[4 + k][w] = pr[k]; }
    for (let k = 0; k < 4; k++) {
      tmp[k] = this.cubic(this.bufs[k], w, dl[k]);
      tmp[4 + k] = this.cubic(this.bufs[4 + k], w, dr[k]);
    }
    for (let k = 0; k < 8; k++) out[k] = tmp[k];
    for (let k = 0; k < 4; k++) {
      let ph = f32(this.phD[k] + this.rateD[k]);
      this.phD[k] = f32(ph - Math.trunc(ph));
      ph = f32(this.phA[k] + this.rateA[k]);
      this.phA[k] = f32(ph - Math.trunc(ph));
    }
    this.w = (w + 1) & 0xffff;
  }

  /** four-point cubic read at delay d (samples) behind the newest sample */
  private cubic(buf: Float32Array, w: number, d: number): number {
    const di = Math.trunc(d);
    const base = (w - (di & 0xffff)) | 0;
    const y0 = buf[base & 0xffff], y1 = buf[(base - 1) & 0xffff], y2 = buf[(base - 2) & 0xffff], y3 = buf[(base - 3) & 0xffff];
    const c = f32(f32(y2 - y0) * 0.5);
    const a = f32(y1 - y2);
    const s6 = f32(a + c);
    let s3 = f32(a + s6);
    s3 = f32(f32(f32(y3 - y1) * 0.5) + s3);
    const f = f32(d - di);
    const s4 = f32(s6 + s3);
    let r = f32(f * s3);
    r = f32(r - s4);
    r = f32(f * r);
    r = f32(c + r);
    r = f32(f * r);
    return f32(y1 + r);
  }
}

export class HyperChorus {
  private n = 0;                        // @0x00 high-pass cross-fade position
  private limit = 441;                  // @0x04 length of the cross-fade (10 ms)
  private inc = f32(1 / 441);           // @0x08
  private dry = 1; private wet = 0;     // @0x0c / 0x10
  private lines = false;                // @0x14 second bank on
  private sr = 44100;                   // @0x18
  private readonly raw = new Float32Array(11); // @0x20 the raw parameter values
  private readonly lp = new Biquad2();  // @0x50
  private readonly hp = new Biquad2();  // @0x90
  private readonly banks: Bank[];
  private readonly io = new Float32Array(2);

  constructor() {
    const rng = new Rand();
    this.banks = [new Bank(0, rng), new Bank(4, rng)];
    for (let i = 0; i < 11; i++) this.raw[i] = RAW_DEFAULT[i];
  }

  /** 0xf030 */
  setSampleRate(sr: number): void {
    this.sr = sr;
    this.limit = Math.trunc(sr / 100);
    this.inc = f32(1 / f32(this.limit));
    for (const b of this.banks) b.sr = sr;
    this.lp.sr = sr; this.hp.sr = sr;
  }

  /** 0xf0ac: idx 0..5 and 10 reach both banks, 6 the line switch, 7 / 8 the filters, 9 the mix. */
  setParam(idx: number, v: number): void {
    v = f32(v);
    this.raw[idx] = v;
    switch (idx) {
      case 6: this.lines = v >= 0.5; break;
      case 7: this.lp.design(1, f32(exp2f(f32(LP_K * v)) * 714)); break;
      case 8: this.hp.design(2, f32(exp2f(f32(HP_K * v)) * 12)); break;
      case 9: {
        const s2 = fma32(f32(v + -0.5), -2, 1);
        const s1 = fma32(f32(s2 * s2), -0.5, 1);
        const t = f32(v + v);
        const x = v >= 0.5 ? s1 : f32(f32(t * t) * 0.5);
        this.dry = f32(Math.sqrt(f32(1 - x)));
        this.wet = f32(Math.sqrt(x));
        break;
      }
      default:
        if (idx <= 5 || idx === 10) for (const b of this.banks) b.setParam(idx, v);
    }
  }

  /** 0xedd8 */
  reset(): void {
    this.lp.clear(); this.hp.clear();
    this.n = 0;
    this.banks[0].clear();
  }

  /** 0xee0c: one stereo sample in place. */
  process(io: Float32Array): void {
    const lin = io[0], rin = io[1];
    const b0 = this.banks[0];
    b0.process(lin, rin);
    const o = b0.out;
    const sl = f32(o[3] + f32(o[2] + f32(o[0] + o[1])));
    const sr = f32(o[7] + f32(o[6] + f32(o[4] + o[5])));
    const x = this.io;
    if (this.lines) {
      const b1 = this.banks[1];
      b1.process(lin, rin);
      const p = b1.out;
      const tl = f32(p[3] + f32(p[2] + f32(p[0] + p[1])));
      const tr = f32(p[7] + f32(p[6] + f32(p[4] + p[5])));
      const k = f32(0.28117048740386963);
      x[0] = f32(f32(sl + tl) * k);
      x[1] = f32(f32(sr + tr) * k);
    } else {
      const k = f32(0.5623409748077393);
      x[0] = f32(sl * k);
      x[1] = f32(sr * k);
    }
    this.lp.process(x);
    if (this.raw[8] !== 0) {
      if (this.n >= this.limit) this.hp.process(x);
      else { this.fade(x); this.n++; }
    } else if (this.n >= 1) {
      this.fade(x);
      this.n--;
    }
    io[0] = fma32(lin, this.dry, f32(x[0] * this.wet));
    io[1] = fma32(rin, this.dry, f32(x[1] * this.wet));
  }

  /** 0xefb8: the high-pass cross-faded in (n / limit) */
  private fade(x: Float32Array): void {
    const f = f32(this.inc * f32(this.n));
    const l = x[0], r = x[1];
    this.hp.process(x);
    const g = f32(1 - f);
    x[0] = fma32(x[0], f, f32(l * g));
    x[1] = fma32(x[1], f, f32(r * g));
  }
}
