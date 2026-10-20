// FL's sample resampler (DSP_Resample unit, class TResampler, as linked into
// FPC_x64.dylib; arm64: SetSpeed 0x201f80, SetPitch 0x2020d0, Render
// 0x202a70, kernels 0x1fed00.. and the NEON sinc kernel 0x2a9c..), reproduced
// for FPC's use: one-shot playback of a sample range (no loop) at a speed
// from cents and a rate ratio, into a stereo buffer (mono sources duplicated).
//
// - Speed = exp(cents x ln 2 / 1200) x (sample rate x (1 / host rate)), or exactly
//   1 for 0 cents at ratio 1. At speed 1 from a whole position the samples are
//   copied (FL's copy mode).
// - Positions: pos_i = fma(i, speed, pos) (ippsVectorSlope_64f), index = trunc,
//   fraction = pos_i - index; the block end advances pos by n x speed. Near the
//   range ends FL renders sample by sample through a window that repeats the edge
//   samples; past the end the voice stops (the count rendered is returned).
// - Kernels by FL's interpolation setting (FPD_ProcessMode bits 8..23 = half width
//   N): N <= 2 linear (double precision), N = 3 FL's 6-point hermite, N >= 4 FL's
//   windowed sinc with 2N taps (./sinc.ts).

import { fmaD } from '../drumpad/libm';
import { sincApply, sincInit, sincWeights, type SincState } from './sinc';
import { hermiteKernel } from './hermite';

const LN2_1200 = 0.057762265046662105 / 100;

/** Scratch shared by every voice of an instance (FL keeps it per resampler; renders are sequential). */
export class ResScratch {
  /** Fractions per output frame. */
  frac: Float64Array;
  /** Source index per output frame (into `win` when < 0: the edge window's centre). */
  idx: Int32Array;
  /** Mono / left and right results of the kernel. */
  win: Float32Array;
  winR: Float32Array;
  constructor(max: number) {
    this.frac = new Float64Array(max);
    this.idx = new Int32Array(max);
    this.win = new Float32Array(2 * 512 + 8);
    this.winR = new Float32Array(2 * 512 + 8);
  }
}

export class FlResampler {
  L: Float32Array = new Float32Array(0);
  R: Float32Array | null = null;
  start = 0;
  /** Exclusive end. */
  end = 0;
  pos = 0;
  speed = 1;
  copy = false;
  /** Half width (FL's points): 1 linear, 3 hermite, >= 4 sinc. */
  pts = 1;
  /** The interpolation setting's half width (FL's 0xf0). */
  basePts = 1;
  readonly sinc: SincState = sincInit();
  private sc: ResScratch;

  constructor(sc: ResScratch) { this.sc = sc; }

  /** FL's mode by half width (0 = default: linear here, as FL's live ProcessMode 0). */
  private setPoints(n: number): void {
    this.pts = n;
    if (n >= 7) {
      this.sinc.piN = Math.PI / n;
      this.sinc.c2N = 2 * Math.cos(this.sinc.piN);
    }
  }

  setQuality(halfWidth: number): void {
    let n: number;
    if (halfWidth <= 2) n = 1;
    else if (halfWidth === 3) n = 3;
    else n = Math.min(512, halfWidth);
    this.basePts = n;
    this.setPoints(n);
  }

  /** FL's SetSample: a sample range [start, end) of channel data (R null = mono). */
  setSample(L: Float32Array, R: Float32Array | null, start: number, end: number): void {
    this.L = L; this.R = R;
    const n = L.length - 1;
    if (n < 0) { this.start = this.end = 0; this.pos = 0; return; }
    const s = start > 0 ? Math.min(start, n) : 0;
    const e = end < 0 ? n : end;
    this.start = s;
    this.end = Math.min(Math.max(s, e), n) + 1;
    this.pos = s;
    this.setPoints(this.basePts);
    this.setSpeed(1);
  }

  /** FL's SetSpeed: the copy flag and (sinc) the anti-aliasing cut-off for speeds above 1. */
  setSpeed(sp: number): void {
    this.speed = sp;
    this.copy = sp === 1 && this.pos - Math.trunc(this.pos) === 0;
    if (this.pts >= 7) {
      const a = Math.abs(sp);
      if (a > 1) {
        this.sinc.piS = Math.PI / a;
        this.sinc.c2S = 2 * Math.cos(this.sinc.piS);
      } else {
        this.sinc.piS = Math.PI;
        this.sinc.c2S = -2;
      }
      let n = roundEven(a);
      n = (n + 3) & ~3;
      let p = n > this.basePts ? n : this.basePts;
      if (p > 512) p = 512;
      if (p !== this.pts) this.setPoints(p);
    }
  }

  setPitch(cents: number, ratio: number): void {
    if (cents === 0 && ratio === 1) this.setSpeed(1);
    else this.setSpeed(Math.exp(cents * LN2_1200) * ratio);
  }

  /** Whether the voice has played its range. */
  ended(): boolean { return this.end <= this.pos; }

  /**
   * Render up to n frames into oL / oR (from 0; they arrive zeroed): FL's Render with the mono to stereo
   * expansion. Returns the frames rendered (fewer once the end is reached).
   */
  render(oL: Float32Array, oR: Float32Array, n: number): number {
    if (this.start >= this.end) return 0;
    const N = this.pts;
    const lo = this.start + N - 1, hi = this.end - N;
    const loF = lo + 3, hiF = hi - 3;
    let rendered = 0;
    let out = 0;
    let rem = n;
    const sc = this.sc;
    for (;;) {
      // fast path: the whole block lies inside the safe range
      const rp = roundEven(this.pos);
      if (loF <= rp && this.pos + rem * this.speed < hiF) {
        if (this.copy) {
          const k0 = rp;
          for (let i = 0; i < rem; i++) {
            oL[out + i] = this.L[k0 + i];
            oR[out + i] = this.R ? this.R[k0 + i] : this.L[k0 + i];
          }
          this.pos = this.pos + this.speed * rem;
        } else {
          const p0 = this.pos, sp = this.speed;
          for (let i = 0; i < rem; i++) {
            const p = fmaD(i, sp, p0);
            const k = Math.trunc(p);
            sc.idx[i] = k;
            sc.frac[i] = p - k;
          }
          this.pos = p0 + sp * rem;
          this.kernel(oL, oR, out, 0, rem, -1);
        }
        return rendered + rem;
      }
      // per frame near the range ends
      let i = 0;
      let restart = false;
      for (; i < rem; i++) {
        const k = Math.trunc(this.pos);
        if (this.end <= k) { rem = i; break; }
        sc.frac[i] = this.pos - k;
        this.pos = this.pos + this.speed;
        sc.idx[i] = k;
        if (k < lo || k >= hi) {
          // the edge window: render the frames so far (this one through the window) right away
          const m = i + 1;
          if (m < rem) {
            this.kernel(oL, oR, out, 0, m, i);
            out += m; rem -= m; rendered += m;
            restart = true;
            break;
          }
          // last frame of the block: rendered below with the others
          this.edge = i;
        }
      }
      if (restart) continue;
      if (rem > 0) {
        this.kernel(oL, oR, out, 0, rem, this.edge);
        rendered += rem;
      }
      this.edge = -1;
      return rendered;
    }
  }

  /** Frame (in the scratch) that reads through the edge window, -1 = none. */
  private edge = -1;

  /** Run the kernel for scratch frames f0 .. f0 + m - 1 into the outputs at `out`; frame `edgeAt` uses the edge window. */
  private kernel(oL: Float32Array, oR: Float32Array, out: number, f0: number, m: number, edgeAt: number): void {
    const N = this.pts;
    const sc = this.sc;
    for (let j = 0; j < m; j++) {
      const f = f0 + j;
      const k = sc.idx[f];
      const x = sc.frac[f];
      let l: number, r: number;
      if (N <= 2) {
        if (f === edgeAt) {
          const a = this.at(this.L, k), b = this.at(this.L, k + 1);
          l = Math.fround(a * (1 - x) + b * x);
          if (this.R) { const c = this.at(this.R, k), d = this.at(this.R, k + 1); r = Math.fround(c * (1 - x) + d * x); } else r = l;
        } else {
          l = Math.fround(this.L[k] * (1 - x) + this.L[k + 1] * x);
          r = this.R ? Math.fround(this.R[k] * (1 - x) + this.R[k + 1] * x) : l;
        }
      } else if (N === 3) {
        l = hermiteKernel(this, this.L, k, x, f === edgeAt);
        r = this.R ? hermiteKernel(this, this.R, k, x, f === edgeAt) : l;
      } else {
        const half = sincWeights(this, x);
        l = sincApply(this, this.L, k, f === edgeAt, half);
        r = this.R ? sincApply(this, this.R, k, f === edgeAt, half) : l;
      }
      oL[out + j] = l;
      oR[out + j] = r;
    }
  }

  /** Sample k of a channel as FL's edge window reads it: the range's first / last sample outside the range. */
  at(c: Float32Array, k: number): number {
    if (k < this.start) return c[this.start];
    if (k >= this.end) return c[this.end - 1];
    return c[k];
  }
}

/** frintx: round to nearest, ties to even. */
export function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && (r & 1) !== 0 ? r - 1 : r;
}
