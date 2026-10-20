// Fruity Slicer's voice (FL 2026, Fruity Slicer_x64.dylib, arm64): a slice of the processed
// sample played through FL's TResampler (0x1a72e0..0x1a9400) at
// 2^((FinalLevels.Pitch + (60 - key) * 100) / 1200) x sample rate / host rate, then FL's
// channel sampler processing compiled into the plugin (0x1fa000..): the 441-sample release
// declick after the note off and the voice levels (float32 pan law, gains ramped from the
// previous ones, at most 0.001 per sample, FL's NEON mix kernel). See
// docs/research/gen/slicer.md.

import type { GenVoice, GenVoiceParams } from '../../types';
import { PITCH_C5 } from '../../levels';
import { SincKernel, kernelOf, linearAt } from './interp';

const f32 = Math.fround;
/** FL's level ramp: at most this gain change per sample. */
const MAX_STEP = f32(0.001);
/** Gains below 2^-24 snap to 0 after a clamped ramp (FL 0x6f460). */
const TINY = f32(5.960464477539063e-8);
/** The release declick: 441 samples at any sample rate (FL's INS processor). */
export const RELEASE_LEN = 441;
/** f32(pi / 442): the release declick's phase step (cos of (k + 1) pi / 442). */
const REL_STEP = f32(Math.PI / (RELEASE_LEN + 1));

/** Round half to even (ARM frintx). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** One gain ramp (FL 0x6f460): the step; `t` holds the target (moved when the slope is clamped). */
function rampStep(t: { v: number }, last: number, len: number): number {
  let step = f32(t.v - last);
  if (step === 0 && 1 / step > 0) return 0;
  step = f32(step / len);
  if (Math.abs(step) > MAX_STEP) {
    step = step < 0 || Object.is(step, -0) ? -MAX_STEP : MAX_STEP;
    t.v = f32(last + f32(step * len));
    if (Math.abs(t.v) < TINY) { t.v = 0; step = f32(-last / len); }
  }
  return step;
}

/** What a voice plays: frames [start, start + len) of the processed sample's channels. */
export interface SliceSource {
  channels: readonly Float32Array[];
  /** Processed sample rate / host rate. */
  rateRatio: number;
}

export class SlicerVoice implements GenVoice {
  free = true;
  /** Slice index (editor's animation). */
  slice = -1;
  released = false;
  private params: GenVoiceParams | null = null;
  private L: Float32Array = new Float32Array(0);
  private R: Float32Array = new Float32Array(0);
  private from = 0;
  private len = 0;
  /** Pitch offset (60 - key) x 100 cents: a slice plays at its own pitch on its key. */
  private ofs = 0;
  private ratio = 1;
  /** TResampler position (double, frames from the slice start). */
  private pos = 0;
  /** Release declick: samples done since the note off (-1 = not released). */
  private rel = -1;
  private lastL = NaN;
  private lastR = NaN;
  private readonly t = { v: 0 };
  /** Interpolation kernel (FL's FPD_ProcessMode points: 1 linear, 3 sinc). */
  private kind = 3;
  private readonly sinc = new SincKernel();
  private readonly o2 = new Float32Array(2);
  /** Frame of the previous render step (a lower one starts a new channel block = FL's block). */
  private lastFrame = -1;
  private readonly raw0 = new Float32Array(16);
  private readonly raw1 = new Float32Array(16);

  /** FL's TriggerVoice for a slice (0x62af0): `len` frames from `start`. */
  start(p: GenVoiceParams, src: SliceSource, slice: number, start: number, len: number, key: number, points = 24): void {
    const kn = kernelOf(points);
    // FL's 3-point kernel 2 is not ported: linear instead
    this.kind = kn.kind === 3 ? 3 : 1;
    if (kn.kind === 3) this.sinc.setPoints(kn.taps);
    this.params = p;
    this.free = false;
    this.released = false;
    this.slice = slice;
    this.L = src.channels[0] as Float32Array;
    this.R = (src.channels[1] ?? src.channels[0]) as Float32Array;
    this.from = start;
    this.len = Math.max(1, len);
    this.ofs = f32((60 - key) * 100);
    this.ratio = src.rateRatio;
    this.pos = 0;
    this.rel = -1;
    this.lastFrame = -1;
    this.lastL = NaN;
    this.lastR = NaN;
  }

  get finished(): boolean {
    return this.pos >= this.len;
  }

  /**
   * The raw voice (TResampler 0x1a8c90) for n frames into raw0 / raw1: copy mode at speed 1
   * from an integral position inside the slice, else the interpolation kernel; positions
   * advance by the speed per sample near the slice edges (FL's slow path) and as
   * pos + i x speed elsewhere (FL's fast path, one step = one block here).
   */
  private resample(n: number): void {
    const p = this.params!;
    const cents = f32(f32(p.levels.pitch - PITCH_C5) + this.ofs);
    let speed: number;
    if (cents === 0 && this.ratio === 1) speed = 1;
    else speed = Math.exp(cents * (0.057762265046662105 / 100)) * this.ratio;
    if (!Number.isFinite(speed) || speed <= 0) speed = 1;
    const L = this.L, R = this.R, st = this.from, len = this.len;
    const r0 = this.raw0, r1 = this.raw1, o = this.o2;
    const sinc = this.kind === 3 ? this.sinc : null;
    if (sinc) sinc.setSpeed(speed);
    const taps = sinc ? sinc.taps : 1;
    let pos = this.pos;
    const copy = speed === 1 && pos === Math.floor(pos);
    const fast = roundEven(pos) >= taps + 2 && pos + n * speed < len - taps - 3;
    if (fast && copy) {
      for (let i = 0; i < n; i++) { r0[i] = L[st + pos + i]; r1[i] = R[st + pos + i]; }
      pos += n;
    } else {
      for (let i = 0; i < n; i++) {
        const pi = fast ? pos + i * speed : pos;
        const k = Math.trunc(pi);
        const fr = pi - k;
        if (sinc) sinc.run(L, R, st, len, k, fr, o); else linearAt(L, R, st, len, k, fr, o);
        r0[i] = o[0]; r1[i] = o[1];
        if (!fast) pos += speed;
      }
      if (fast) pos += n * speed;
    }
    this.pos = pos;
  }

  render(L: Float32Array, R: Float32Array, n: number): boolean {
    if (this.free || !this.params) return false;
    if (n > 16) {
      let alive = true;
      for (let o = 0; o < n && alive; o += 16) alive = this.render(L.subarray(o, Math.min(n, o + 16)), R.subarray(o, Math.min(n, o + 16)), Math.min(16, n - o));
      return alive;
    }
    // FL checks the voice after each block: a slice that ended (or a finished release) in the
    // previous channel block is dropped now
    const fr = this.params.frame;
    const newBlock = this.lastFrame >= 0 && !(fr > this.lastFrame);
    this.lastFrame = fr;
    if (this.rel >= RELEASE_LEN || (newBlock && this.finished)) return false;
    this.resample(n);
    const r0 = this.raw0, r1 = this.raw1;
    if (this.rel >= 0) {
      for (let i = 0; i < n; i++) {
        let g = 0;
        if (this.rel < RELEASE_LEN) {
          const a = f32(f32(this.rel + 1) * REL_STEP);
          g = f32(f32(f32(Math.cos(a)) + 1) * 0.5);
          this.rel++;
        }
        r0[i] = f32(r0[i] * g);
        r1[i] = f32(r1[i] * g);
      }
    }
    this.mix(L, R, n);
    return true;
  }

  /** FL's voice levels: float32 pan law of FinalLevels, ramp from the last gains, FL's mix kernel. */
  private mix(L: Float32Array, R: Float32Array, n: number): void {
    const p = this.params!.levels;
    let pan = f32(p.pan);
    if (!(pan >= -1)) pan = -1; else if (pan > 1) pan = 1;
    const vol = f32(p.vol);
    const a = f32(f32(pan + 1) * 0.7853981633974483);
    let tl = f32(f32(Math.cos(a)) * vol);
    let tr = f32(f32(Math.sin(a)) * vol);
    if (!Number.isFinite(tl)) tl = 0;
    if (!Number.isFinite(tr)) tr = 0;
    if (this.lastL !== this.lastL) { this.lastL = tl; this.lastR = tr; }
    const t = this.t;
    t.v = tl;
    const sl = rampStep(t, this.lastL, n);
    tl = t.v;
    t.v = tr;
    const sr = rampStep(t, this.lastR, n);
    tr = t.v;
    const r0 = this.raw0, r1 = this.raw1;
    if (sl === 0 && sr === 0) {
      for (let i = 0; i < n; i++) {
        L[i] = f32(f32(r0[i] * tl) + L[i]);
        R[i] = f32(f32(r1[i] * tr) + R[i]);
      }
    } else {
      // FL's NEON ramp kernel: frame pairs stepped by two steps in groups of 8 frames; the
      // remaining frames step left by the right step and vice versa
      let g0 = this.lastL, g1 = this.lastR, g2 = f32(this.lastL + sl), g3 = f32(this.lastR + sr);
      let i = 0;
      if (n >= 8) {
        const d0 = f32(sl + sl), d1 = f32(sr + sr);
        for (; n - i >= 8; ) {
          for (let k = 0; k < 4; k++, i += 2) {
            L[i] = f32(f32(r0[i] * g0) + L[i]);
            R[i] = f32(f32(r1[i] * g1) + R[i]);
            L[i + 1] = f32(f32(r0[i + 1] * g2) + L[i + 1]);
            R[i + 1] = f32(f32(r1[i + 1] * g3) + R[i + 1]);
            g0 = f32(d0 + g0); g1 = f32(d1 + g1); g2 = f32(d0 + g2); g3 = f32(d1 + g3);
          }
        }
      }
      for (; i < n; i++) {
        L[i] = f32(f32(r0[i] * g0) + L[i]);
        R[i] = f32(f32(r1[i] * g1) + R[i]);
        g0 = f32(sr + g0); g1 = f32(sl + g1);
      }
    }
    this.lastL = tl;
    this.lastR = tr;
  }

  /** FL's Voice_Release: the INS processor's release declick starts (441 samples). */
  release(): void {
    if (this.free || this.released) return;
    this.released = true;
    this.rel = 0;
  }

  kill(): void {
    this.free = true;
    this.params = null;
    this.slice = -1;
  }
}
