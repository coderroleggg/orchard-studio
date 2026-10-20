// The Granulizer's grain reader: FL's TResampler (Fruity Granulizer_x64.dylib 0x1966d0, the code
// Fruity Slicer shares: src/engine/gen/plugins/slicer/interp.ts has its kernels) configured as the
// plugin does for a grain: the whole channel sample as range, the loop flag, the position and the
// speed of the grain's pitch. A block is read in chunks: the fast path (positions pos + i x speed,
// copy mode at speed 1, all kernel taps inside the sample) or, near the sample's edges, one frame
// at a time with the taps repeating the first / last frame, or wrapping around the loop
// (0x196480). The output is interleaved stereo; a mono sample has L and R the same array.
// Kernels: linear, FL's 6-point polynomial (the "6-point Hermite" resampling setting, 0x1935b0) and the
// windowed sinc (shared with Fruity Slicer).

import { SincKernel, kernelOf, linearAt } from '../slicer/interp';
import { appleCos, fma, vvsin } from './libm';

/** Round half to even (ARM frintx). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** The channel's sample as the plugin holds it. */
export interface GranSample {
  L: Float32Array;
  R: Float32Array;
  /** Frame count (FL: count). */
  len: number;
  /** Sample rate in Hz. */
  rate: number;
}

/** The 18 float32 coefficients of FL's 6-point kernel (0x2905c8). */
const H = new Float32Array(new Uint32Array([
  0xbd2aaaab, 0x3e555555, 0xbed55555, 0x3caaaaab, 0xbd800000, 0x3d2aaaab, 0x3dd55555, 0xbf300000, 0x3fc55555,
  0xbd555555, 0x3ed00000, 0xbeb55555, 0xbcc00000, 0x3e22aaab, 0xbfae0000, 0x3c400000, 0xbdc80000, 0x3f160000,
]).buffer);
const f32 = Math.fround;

/**
 * One channel of FL's 6-point kernel (float stereo 0x1935b0): y0..y5 are the frames k - 2 .. k + 3, z = f - 0.5 (double).
 * Even / odd sums of the symmetric tap pairs, five Horner steps in float32 whose products with z go through a double,
 * and the last step without z.
 */
function poly6(y0: number, y1: number, y2: number, y3: number, y4: number, y5: number, z: number): number {
  const s2 = f32(y0 + y5), s3 = f32(y0 - y5);
  const s4 = f32(y1 + y4), s5 = f32(y1 - y4);
  const s6 = f32(y2 + y3), s7 = f32(y2 - y3);
  let r = f32(f32(f32(H[0] * s3) + f32(H[1] * s5)) + f32(H[2] * s7));
  const s8 = f32(r * z);
  r = f32(f32(f32(f32(H[3] * s2) + f32(H[4] * s4)) + f32(H[5] * s6)) + s8);
  const s9 = f32(r * z);
  r = f32(f32(f32(f32(H[6] * s3) + f32(H[7] * s5)) + f32(H[8] * s7)) + s9);
  const s10 = f32(r * z);
  r = f32(f32(f32(f32(H[9] * s2) + f32(H[10] * s4)) + f32(H[11] * s6)) + s10);
  const s11 = f32(r * z);
  r = f32(f32(f32(f32(H[12] * s3) + f32(H[13] * s5)) + f32(H[14] * s7)) + s11);
  const s12 = f32(r * z);
  return f32(f32(f32(f32(H[15] * s2) + f32(H[16] * s4)) + f32(H[17] * s6)) + s12);
}

/** FL's 6-point kernel at k + f of the frames [st, st + len) of L / R (taps outside repeat the first / last frame). */
function hermiteAt(L: Float32Array, R: Float32Array, st: number, len: number, k: number, f: number, out: Float32Array): void {
  const last = len - 1;
  const z = f - 0.5;
  let a = k - 2, i0 = st + (a < 0 ? 0 : a > last ? last : a);
  a = k - 1; const i1 = st + (a < 0 ? 0 : a > last ? last : a);
  a = k; const i2 = st + (a < 0 ? 0 : a > last ? last : a);
  a = k + 1; const i3 = st + (a < 0 ? 0 : a > last ? last : a);
  a = k + 2; const i4 = st + (a < 0 ? 0 : a > last ? last : a);
  a = k + 3; const i5 = st + (a < 0 ? 0 : a > last ? last : a);
  out[0] = poly6(L[i0], L[i1], L[i2], L[i3], L[i4], L[i5], z);
  out[1] = poly6(R[i0], R[i1], R[i2], R[i3], R[i4], R[i5], z);
}

export class GrainReader {
  pos = 0;
  step = 1;
  loop = false;
  /** Times the reader wrapped around the loop (FL +0x70). */
  loopCount = 0;
  /** FL's copy mode (+0x75): speed exactly 1 at an integral position when the speed was set. */
  private copy = false;
  private src: GranSample | null = null;
  private kind: 1 | 2 | 3 = 1;
  private readonly sinc = new SincKernel();
  private readonly o2 = new Float32Array(2);
  private wl = new Float32Array(0);
  private wr = new Float32Array(0);

  constructor() {
    // FL's libm: Apple's cos in the kernel setup, Accelerate's vvsin where the sine recurrence cancels
    this.sinc.cos = appleCos;
    this.sinc.sinNear = vvsin;
  }

  /**
   * FL's TResampler setup for a grain (config 0x195df0, pitch 0x195cf0): `step` is the speed in
   * source frames per output frame, `points` the interpolation setting (FPD_ProcessMode).
   */
  start(src: GranSample, loop: boolean, pos: number, step: number, points: number): void {
    this.src = src;
    this.loop = loop;
    this.loopCount = 0;
    this.pos = pos < 0 ? 0 : pos > src.len ? src.len : pos;
    this.step = step;
    this.copy = step === 1 && this.pos === Math.floor(this.pos);
    const kn = kernelOf(points);
    this.kind = kn.kind;
    if (this.kind === 3) {
      this.sinc.setPoints(kn.taps);
      this.sinc.setSpeed(step);
    }
  }

  /** The source has run out (a non-looping reader at or past the end). */
  get ended(): boolean {
    return !this.loop && !!this.src && this.pos >= this.src.len;
  }

  /** Release the sample reference. */
  stop(): void {
    this.src = null;
  }

  /** One frame at k + f with FL's tap gathering at the loop (0x196480): wrap, or the first frame before the first wrap. */
  private looped(k: number, f: number): void {
    const s = this.src!;
    const len = s.len;
    const reach = this.kind === 3 ? this.sinc.taps : this.kind === 2 ? 3 : 1;
    const w = 2 * reach + 2;
    if (this.wl.length < w) { this.wl = new Float32Array(w); this.wr = new Float32Array(w); }
    const bl = this.wl, br = this.wr;
    for (let i = 0; i < w; i++) {
      let j = k - reach + i;
      if (j < 0) {
        // before the loop start a tap wraps only once the reader has looped
        if (this.loopCount > 0) { while (j < 0) j += len; } else j = 0;
      } else {
        while (j >= len) j -= len;
      }
      bl[i] = s.L[j];
      br[i] = s.R[j];
    }
    if (this.kind === 3) this.sinc.run(bl, br, 0, w, reach, f, this.o2);
    else if (this.kind === 2) hermiteAt(bl, br, 0, w, reach, f, this.o2);
    else linearAt(bl, br, 0, w, reach, f, this.o2);
  }

  /**
   * Read `n` frames into out (interleaved stereo, from out[0]); returns the frames that came from the
   * sample before its end (n unless the reader ran out of a non-looping sample). FL's flow (0x1966d0):
   * while frames remain, the fast path takes all of them at positions pos + i x speed (fused, from the
   * DSP library's ippsVectorSlope_64f) when the block fits inside the kernel's safe zone; otherwise
   * the slow path walks the frames accumulating the position (pos += speed), taking direct taps
   * inside the safe zone and gathered taps (clamped or wrapped) outside it, and after a gathered
   * frame the fast condition is tested again.
   */
  read(out: Float32Array, n: number): number {
    const s = this.src;
    if (!s || s.len <= 0 || n <= 0) return 0;
    const len = s.len;
    const L = s.L, R = s.R;
    const sinc = this.kind === 3 ? this.sinc : null;
    const herm = this.kind === 2;
    const taps = sinc ? sinc.taps : herm ? 3 : 1;
    // the kernel's safe zone [taps - 1, len - taps) and FL's fast-path limits (0x194fd0)
    const zoneLo = taps - 1, zoneHi = len - taps;
    const lo = zoneLo + 3, hi = zoneHi - 3;
    const step = this.step;
    const o = this.o2;
    let rem = n, done = 0;
    while (rem > 0) {
      if (roundEven(this.pos) >= lo && this.pos + step * rem < hi) {
        const pos = this.pos;
        if (this.copy) {
          const a = roundEven(pos);
          for (let i = 0; i < rem; i++) { out[2 * (done + i)] = L[a + i]; out[2 * (done + i) + 1] = R[a + i]; }
        } else {
          for (let i = 0; i < rem; i++) {
            const p = fma(i, step, pos);
            const k = Math.trunc(p);
            const f = p - k;
            if (sinc) sinc.run(L, R, 0, len, k, f, o); else if (herm) hermiteAt(L, R, 0, len, k, f, o); else linearAt(L, R, 0, len, k, f, o);
            out[2 * (done + i)] = o[0]; out[2 * (done + i) + 1] = o[1];
          }
        }
        this.pos = pos + step * rem;
        done += rem;
        break;
      }
      // slow path: frame by frame with the accumulated position
      while (rem > 0) {
        let k = Math.trunc(this.pos);
        if (k >= len) {
          if (!this.loop) return done;
          do { this.pos = this.pos - len; k = Math.trunc(this.pos); this.loopCount++; } while (len <= k);
        }
        const f = this.pos - k;
        this.pos += step;
        const gather = k < zoneLo || k >= zoneHi;
        if (gather && this.loop) this.looped(k, f);
        else if (sinc) sinc.run(L, R, 0, len, k, f, o);
        else if (herm) hermiteAt(L, R, 0, len, k, f, o);
        else linearAt(L, R, 0, len, k, f, o);
        out[2 * done] = o[0]; out[2 * done + 1] = o[1];
        done++; rem--;
        if (gather) break;
      }
    }
    return done;
  }
}
