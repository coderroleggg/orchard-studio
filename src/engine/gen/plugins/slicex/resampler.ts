// Slicex's sample reader: FL's TResampler (unit DSP_Resample) as linked into Slicex_x64.dylib
// (arm64: SetData 0x210540 / 0x2105b0, SetSpeed 0x210140 (identical to FPC's), SetPitch 0x210290,
// Render 0x211c60, edge windows 0x2106e0 / 0x210930 / 0x210b80, safe range 0x20f530). Slicex's
// Render is a newer build than FPC's: its fast path checks both block ends against the safe
// range (reverse playback), loops wrap (Loop half of regions), and with FL's +0x77 flag (set by
// Slicex) it renders on past the region end through the edge window, returning the frames
// rendered before the end.
//
// Positions are FL's: relative to the region's first frame (FL points the reader at it), so
// fractions match FL's bit for bit; arrays are indexed at `base + k`. Kernels: linear in double
// (FL's 0x20ce80 family), FL's 6-point hermite and windowed sinc (FPC's ports, the same code:
// ../fpc/hermite.ts, ../fpc/sinc.ts).

import { fmaD } from '../drumpad/libm';
import { FlResampler, ResScratch, roundEven } from '../fpc/resampler';
import { hermiteKernel } from '../fpc/hermite';
import { sincApply, sincWeights } from '../fpc/sinc';

const MAXW = 2 * 512 + 8;

export class SxResampler extends FlResampler {
  /** Absolute index of the region's first frame in the channel arrays. */
  base = 0;
  /** Loop (FL +0x74), loop start / end (relative, +0x60 / +0x68), loops played (+0x70). */
  loopOn = false;
  loopS = 0;
  loopE = 0;
  loops = 0;
  /** Safe range for the fast path (FL +0xd8 / +0xe0) and the edge window limits (+0xc8 / +0xd0). */
  private lo = 0;
  private hi = 0;
  private loF = 0;
  private hiF = 0;
  private readonly fr: Float64Array;
  private readonly ix: Int32Array;
  private readonly edgeAt: Uint8Array;
  /** The current edge frame's windows (taps k - N + 1 .. k + N) per channel. */
  private readonly winL = new Float32Array(MAXW);
  private readonly winR = new Float32Array(MAXW);
  private winK = 0;

  constructor(max: number) {
    super(new ResScratch(8));
    this.fr = new Float64Array(max);
    this.ix = new Int32Array(max);
    this.edgeAt = new Uint8Array(max);
  }

  /** FL's SetData (+ the loop variant): frames [0, frames) of the channels from `base`; loop [ls, le) when given. */
  setRegion(L: Float32Array, R: Float32Array | null, base: number, frames: number, loop: boolean, ls: number, le: number): void {
    this.L = L; this.R = R;
    this.base = base;
    this.start = 0;
    this.end = frames;
    this.loops = 0;
    this.loopOn = loop;
    if (loop) {
      const e1 = this.end - 1;
      this.loopS = Math.min(Math.max(ls, 0), e1);
      this.loopE = Math.min(Math.max(le, 0), e1) + 1;
    } else {
      this.loopS = 0;
      this.loopE = this.end;
    }
    this.pos = 0;
    this.setQuality(this.basePts);
    this.setSpeed(1);
    this.safe();
  }

  /** FL 0x20f530: the range the fast path may read without an edge window. */
  private safe(): void {
    const N = this.pts;
    this.lo = (this.loops > 0 ? this.loopS : this.start) + N - 1;
    this.hi = this.loopE - N;
    this.loF = this.lo + 3;
    this.hiF = this.hi - 3;
  }

  override setSpeed(sp: number): void {
    const p = this.pts;
    super.setSpeed(sp);
    if (this.pts !== p) this.safe();
  }

  /** Kernels read through FL's edge window of the current frame here. */
  override at(c: Float32Array, k: number): number {
    const w = c === this.L ? this.winL : this.winR;
    return w[k - this.winK + this.pts - 1];
  }

  /** FL's edge window for frame k (relative): loop wraps, the range's edge samples outside it. */
  private window(c: Float32Array, w: Float32Array, k: number): void {
    const N = this.pts;
    const len = this.loopE - this.loopS;
    let cnt = this.loops;
    let lim = cnt > 0 ? this.loopS : -0x7fffffff;
    let j = k;
    for (let t = 0; t < N; t++) {
      while (j < lim) {
        j += len;
        cnt--;
        if (cnt <= 0) lim = -0x7fffffff;
      }
      w[N - 1 - t] = j < this.start ? c[this.base + this.start] : j >= this.end ? c[this.base + this.end - 1] : c[this.base + j];
      j--;
    }
    const top = this.loopOn ? this.loopE : 0x7fffffff;
    j = k + 1;
    for (let t = 1; t <= N; t++) {
      while (j >= top) j -= len;
      w[N - 1 + t] = j < this.start ? c[this.base + this.start] : j >= this.end ? c[this.base + this.end - 1] : c[this.base + j];
      j++;
    }
  }

  /** Run the kernel for scratch frames 0 .. m - 1 into the outputs at `out`. */
  private kernelRun(oL: Float32Array, oR: Float32Array, out: number, m: number): void {
    const N = this.pts;
    const L = this.L, R = this.R;
    const b = this.base;
    for (let f = 0; f < m; f++) {
      const k = this.ix[f];
      const x = this.fr[f];
      const edge = this.edgeAt[f] === 1;
      if (edge) {
        this.winK = b + k;
        this.window(L, this.winL, k);
        if (R) this.window(R, this.winR, k);
      }
      const ka = b + k;
      let l: number, r: number;
      if (N <= 2) {
        if (edge) {
          l = Math.fround(this.winL[N - 1] * (1 - x) + this.winL[N] * x);
          r = R ? Math.fround(this.winR[N - 1] * (1 - x) + this.winR[N] * x) : l;
        } else {
          l = Math.fround(L[ka] * (1 - x) + L[ka + 1] * x);
          r = R ? Math.fround(R[ka] * (1 - x) + R[ka + 1] * x) : l;
        }
      } else if (N === 3) {
        l = hermiteKernel(this, L, ka, x, edge);
        r = R ? hermiteKernel(this, R, ka, x, edge) : l;
      } else {
        const half = sincWeights(this, x);
        l = sincApply(this, L, ka, edge, half);
        r = R ? sincApply(this, R, ka, edge, half) : l;
      }
      oL[out + f] = l;
      oR[out + f] = r;
      this.edgeAt[f] = 0;
    }
  }

  /**
   * FL's Render (n <= scratch size) into oL / oR at `out`: returns the frames rendered before the
   * region end (FL renders the whole block, the frames after the end through the edge window).
   */
  renderAt(oL: Float32Array, oR: Float32Array, out: number, n: number): number {
    if (this.start >= this.end) {
      oL.fill(0, out, out + n); oR.fill(0, out, out + n);
      return 0;
    }
    let rem = n;
    let rendered = 0;
    let endAt = -1;
    for (;;) {
      const sp = this.speed;
      const p0 = this.pos;
      const pe = p0 + rem * sp;
      if (p0 >= this.loF && p0 < this.hiF && pe >= this.loF && pe < this.hiF) {
        if (this.copy) {
          const k0 = this.base + roundEven(p0);
          const L = this.L, R = this.R;
          for (let i = 0; i < rem; i++) {
            oL[out + i] = L[k0 + i];
            oR[out + i] = R ? R[k0 + i] : L[k0 + i];
          }
          this.pos = p0 + rem * sp;
        } else {
          for (let i = 0; i < rem; i++) {
            const p = fmaD(i, sp, p0);
            const k = Math.trunc(p);
            this.ix[i] = k;
            this.fr[i] = p - k;
          }
          this.pos = p0 + rem * sp;
          this.kernelRun(oL, oR, out, rem);
        }
        rendered += rem;
        break;
      }
      // frame by frame near the range ends
      let restart = false;
      let i = 0;
      for (; i < rem; i++) {
        let k = Math.trunc(this.pos);
        if (this.loopE <= k) {
          if (this.loopOn) {
            do {
              this.pos = this.pos - this.loopE + this.loopS;
              k = Math.trunc(this.pos);
              this.loops++;
              if (this.loops === 1) this.safe();
            } while (this.loopE <= k);
          } else if (this.speed >= 0) {
            if (endAt < 0) endAt = rendered + i;
          } else {
            k = this.loopE - 1;
            this.pos = k;
          }
        } else {
          const st = this.loops > 0 ? this.loopS : this.start;
          if (st > k) {
            if (this.loops > 0) {
              do {
                this.pos = this.pos + this.loopE - this.loopS;
                k = Math.trunc(this.pos);
                this.loops--;
                if (this.loops === 0) this.safe();
              } while (st > k);
            } else {
              this.pos = this.start;
              k = this.start;
            }
          }
        }
        this.fr[i] = this.pos - k;
        this.pos = this.pos + this.speed;
        this.ix[i] = k;
        if (k < this.lo || k >= this.hi) {
          this.edgeAt[i] = 1;
          const m = i + 1;
          if (m < rem) {
            this.kernelRun(oL, oR, out, m);
            out += m; rem -= m; rendered += m;
            restart = true;
            break;
          }
        }
      }
      if (restart) continue;
      if (rem > 0) {
        this.kernelRun(oL, oR, out, rem);
        rendered += rem;
      }
      break;
    }
    return endAt >= 0 ? endAt : rendered;
  }
}
