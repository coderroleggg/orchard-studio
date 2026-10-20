// Sytrus operator waveforms: FL's TSytrusShape (Sytrus_x64 0xc3470 compile,
// 0xc4150 pre-filter, 0xc2d00 band-limited tables). A 16384-point single
// cycle is built from up to 256 harmonics (amplitude, phase) drawn with the
// SH (sine / triangle / saw / square / pulse morph), SK skew and SN sine
// shaper, half / even switches, normalised to peak 1, bent by TN tension,
// optionally made absolute, then low-passed in the spectrum by FL (brick wall
// at a harmonic, optional Gibbs sigma). BAND LIMIT / PLUCK operators read
// band-limited copies (harmonics up to h1, a linear fade to h2, optional
// Gibbs sigma) of 4096 points (16384 when rendering); others read the
// 16384-point table directly.

import type { SyOp } from '../../../../model/gen/plugins/sytrus/types';
import { FFT } from './fft';
import { curve, roundEven } from './env';

export const TABLE_BITS = 14;
export const TABLE_SIZE = 1 << TABLE_BITS;
const TINY = 5.960464477539063e-8;

let fft16k: FFT | null = null;
let fft4k: FFT | null = null;
function fftOf(n: number): FFT {
  if (n === TABLE_SIZE) return (fft16k ??= new FFT(TABLE_SIZE));
  if (n === 4096) return (fft4k ??= new FFT(4096));
  return new FFT(n);
}

/** FL's coefficient triple for a signed curve value (0xbf4c0). */
function coef(v: number): [number, number, number] {
  if (v === 0) return [0, 0, 0];
  const a = Math.abs(v);
  // FL's TCurve setup (0xbf4c0): 1 / |k| and log(1 + |k|) with the sum in single precision
  return [v, Math.fround(1 / a), Math.fround(Math.log(Math.fround(a + 1)))];
}

/** Key identifying the waveform settings (shared tables between identical operators). */
export function shapeKey(op: SyOp, gibbs: boolean): string {
  return [op.sh, op.tn, op.sk, op.sn, op.fl, op.half, op.even, op.abs, gibbs ? 1 : 0, op.amp.join(','), op.ph.join(',')].join('|');
}

let SINE: Float64Array | null = null;
/** sin(2 pi j / 16384). */
function sineTable(): Float64Array {
  if (!SINE) {
    SINE = new Float64Array(TABLE_SIZE);
    for (let j = 0; j < TABLE_SIZE; j++) SINE[j] = Math.sin((2 * Math.PI * j) / TABLE_SIZE);
  }
  return SINE;
}

export class SyShape {
  /** The 16384-point cycle plus a guard sample. */
  readonly table = new Float32Array(TABLE_SIZE + 1);
  /** Spectrum (bins 0..8192) after the FL pre-filter, for band-limited copies. */
  private readonly specRe = new Float64Array(TABLE_SIZE / 2 + 1);
  private readonly specIm = new Float64Array(TABLE_SIZE / 2 + 1);
  private readonly cache = new Map<number, Float32Array>();
  private readonly gibbs: boolean;

  constructor(op: SyOp, gibbs: boolean) {
    this.gibbs = gibbs;
    this.build(op);
  }

  private build(op: SyOp): void {
    const T = TABLE_SIZE;
    const tab = new Float64Array(T);
    // SH: 0 sine .. 1 triangle .. 2 saw .. 3 square .. 4 narrow pulse
    let W = Math.fround(op.sh * 0.0078125), Tr = 1, Q = 0, Pw = 0;
    if (W > 1) {
      if (W > 2) {
        Tr = 0;
        if (W > 3) { Q = 1; Pw = Math.fround(W - 3); } else Q = Math.fround(W - 2);
      } else Tr = Math.fround(2 - W);
      W = 1;
    }
    // SK skew curve
    const skv = Math.fround(Math.fround(Math.exp(Math.fround(op.sk * 0.0078125) * 3.044522437723423) - 1) * 0.05);
    const [sk0, sk1, sk2] = coef(Math.fround(Math.exp(skv * 20.72326583694641) - 1));
    const s13 = op.sn > 0 ? Math.fround(op.sn * Math.PI * 0.01171875) : 0;
    const pure = op.sh === 0 && op.sk === 0 && op.sn === 0 && !op.half && !op.even;
    const twoTri = Math.fround(2 / (2 - Tr));
    const shapeFn = (x: number): number => {
      if (Pw > 0) return x >= 1 - Pw * 0.75 ? -1 : 1;
      let s = Math.sin(x * Math.PI);
      if (W > 0) {
        let y = x + Tr * 0.5;
        while (y > 2) y -= 2;
        let tri: number;
        if (y < Tr) tri = (y / Tr) * 2 - 1;
        else {
          tri = 1 - (y - Tr) * twoTri;
          if (Q !== 0) tri = y < 1 ? Q + tri * (1 - Q) : -Q + tri * (1 - Q);
        }
        s = s * (1 - W) + tri * W;
      }
      return s;
    };
    const nh = Math.min(256, op.amp.length);
    // FL sums the harmonics sample by sample. Every position it evaluates is an exact multiple of the
    // grid step g (phase 0) or of g plus the harmonic's phase, so shaped harmonics without a phase read
    // a once-evaluated grid G (same values), and sine harmonics read a sine table.
    let gs = 2 / T, gd11 = 2, gd12 = 2;
    if (op.half) { gs *= 0.5; gd11 *= 0.5; gd12 *= 0.5; }
    if (op.even) { gs *= 2; gd11 *= 2; }
    const evalAt = (d10: number): number => {
      if (!(d10 <= gd12)) return 0;
      let x = d10;
      if (op.sk > 0) {
        const d14 = Math.abs(d10 > 1 ? d10 - 1 : 1 - d10);
        const d15 = sk0 === 0 ? d14 : curve(sk0, sk1, sk2, d14);
        x = d10 > 1 ? d15 + 1 : 1 - d15;
      }
      let v = shapeFn(x);
      if (op.sn > 0) v = Math.sin(v * s13);
      return v;
    };
    let G: Float64Array | null = null;
    const M = T - 1;
    for (let k = 0; k < nh; k++) {
      const a = op.amp[k];
      if (!a) continue;
      const ph = Math.fround((op.ph[k] ?? 0) * 2);
      const m = k + 1;
      if (pure) {
        const S = sineTable();
        if (ph === 0) {
          for (let n = 0, j = 0; n < T; n++, j = (j + m) & M) tab[n] += a * S[j];
        } else {
          const p0 = Math.PI * ph, sp = Math.sin(p0), cp = Math.cos(p0);
          for (let n = 0, j = 0; n < T; n++, j = (j + m) & M) tab[n] += a * (sp * S[(j + T / 4) & M] + cp * S[j]);
        }
        continue;
      }
      if (ph === 0) {
        if (!G) { G = new Float64Array(T + 1); for (let j = 0; j <= T; j++) G[j] = evalAt(j * gs); }
        tab[0] += G[0] * a;
        for (let n = 1, j = m; n < T; n++, j += m) { if (j > T) j -= T; tab[n] += G[j] * a; }
        continue;
      }
      const d8 = m * gs;
      let d10 = ph;
      const sk = op.sk > 0, sn = op.sn > 0, skLin = sk0 === 0;
      for (let n = 0; n < T; n++) {
        while (d10 > gd11) d10 -= gd11;
        if (d10 <= gd12) {
          let x = d10;
          if (sk) {
            const d14 = Math.abs(d10 > 1 ? d10 - 1 : 1 - d10);
            const d15 = skLin ? d14 : sk0 > 0 ? 1 - (Math.exp((1 - d14) * sk2) - 1) * sk1 : (Math.exp(d14 * sk2) - 1) * sk1;
            x = d10 > 1 ? d15 + 1 : 1 - d15;
          }
          let v = shapeFn(x);
          if (sn) v = Math.sin(v * s13);
          tab[n] += v * a;
        }
        d10 += d8;
      }
    }
    // normalise to peak 1
    let m = 0;
    for (let n = 0; n < T; n++) { const v = Math.abs(tab[n]); if (v > m) m = v; }
    if (m > TINY) { const g = 1 / m; for (let n = 0; n < T; n++) tab[n] *= g; }
    // TN tension
    if (op.tn !== 0) {
      const t = Math.fround(Math.abs(op.tn) * 0.0078125);
      const v = Math.fround(Math.fround(Math.exp(t * 3.044522437723423) - 1) * 0.05);
      const [c0, c1, c2] = coef(Math.fround((op.tn < 0 ? -1 : 1) * Math.fround(Math.exp(v * 41.446531658199575) - 1)));
      for (let n = 0; n < T; n++) {
        const x = tab[n], y = curve(c0, c1, c2, Math.abs(x));
        tab[n] = x < 0 ? -y : y;
      }
    }
    if (op.abs) for (let n = 0; n < T; n++) tab[n] = Math.abs(tab[n]);
    // spectrum, FL pre-filter
    const re = new Float64Array(T), im = new Float64Array(T);
    re.set(tab);
    const F = fftOf(T);
    F.transform(re, im, -1);
    const half = T / 2;
    const fl = Math.fround(op.fl * 0.0078125);
    const h = roundEven(Math.fround(Math.fround(Math.exp(Math.fround(0.65 + 0.35 * fl) * 23.025850929940457) - 1) * 1.6384e-6));
    if (h <= half) {
      for (let k = Math.max(h, 1); k <= half; k++) { re[k] = 0; im[k] = 0; if (k < half) { re[T - k] = 0; im[T - k] = 0; } }
    }
    for (let k = 0; k <= half; k++) { this.specRe[k] = re[k] / T; this.specIm[k] = im[k] / T; }
    if (h <= half) {
      if (this.gibbs && h > 1) {
        const s8 = (h - 1) / Math.PI, s9 = Math.PI / (h - 1);
        for (let k = 1; k < h; k++) {
          const g = (s8 * Math.sin(k * s9)) / k;
          re[k] *= g; im[k] *= g; re[T - k] *= g; im[T - k] *= g;
        }
      }
      F.transform(re, im, 1);
      for (let n = 0; n < T; n++) tab[n] = re[n] / T;
    }
    const out = this.table;
    for (let n = 0; n < T; n++) { const v = Math.fround(tab[n]); out[n] = Math.abs(v) < TINY ? 0 : v; }
    out[T] = out[0];
  }

  /**
   * Table for harmonic limits h1 (full level up to h1-1) and h2 (fade end):
   * the 16384-point cycle when h1 exceeds the copy's band, else a band-limited
   * copy of `size` points (4096 live, 16384 when rendering).
   */
  tableFor(h1: number, h2: number, size: number): Float32Array {
    const half = size / 2;
    if (h1 > half) return this.table;
    if (h2 > half) h2 = half;
    const key = (size === TABLE_SIZE ? 1 << 30 : 0) + h1 * 16384 + h2;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const win = new Float64Array(half + 1);
    for (let k = 0; k < h1 && k <= half; k++) win[k] = 1;
    if (h2 >= h1) {
      const n = h2 - h1 + 1;
      for (let j = 0; j < n && h1 + j <= half; j++) win[h1 + j] = Math.fround(1 - (j + 1) / n);
    }
    if (this.gibbs && h2 > 0) {
      const s8 = h2 / Math.PI, s9 = Math.PI / h2;
      for (let k = 1; k <= h2 && k <= half; k++) win[k] *= (s8 * Math.sin(k * s9)) / k;
    }
    const re = new Float64Array(size), im = new Float64Array(size);
    for (let k = 0; k <= half; k++) {
      const g = win[k];
      if (!g) continue;
      re[k] = this.specRe[k] * g * size;
      im[k] = this.specIm[k] * g * size;
      if (k > 0 && k < half) { re[size - k] = re[k]; im[size - k] = -im[k]; }
    }
    fftOf(size).transform(re, im, 1);
    const t = new Float32Array(size + 1);
    for (let n = 0; n < size; n++) { const v = Math.fround(re[n] / size); t[n] = Math.abs(v) < TINY ? 0 : v; }
    t[size] = t[0];
    if (this.cache.size > 96) this.cache.clear();
    this.cache.set(key, t);
    return t;
  }
}
