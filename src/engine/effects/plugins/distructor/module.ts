// One Distructor module slot: input gain, the module's effect (distortion and
// filter modules optionally oversampled with FL's half-band filters, dry path
// included), linear dry/wet mix, Center (distortion only, at the base rate),
// output gain. Measured through FL's plugin:
//   - in / out gain = raw / 5000, mix = raw / 10000 (linear crossfade; the dry
//     path is the signal after the input gain);
//   - oversampling 2^os applies to distortion and filter modules only and
//     uses HIIR polyphase half-bands (6 coefficients, transition 0.1) per
//     octave; the module reports no latency;
//   - power off = untouched passthrough (gains bypassed too);
//   - in / mix / out change at the next block, without smoothing (FL).

import type { DxModule } from '../../../../model/fx/plugins/distructor';
import { DxCabinet } from './cabinet';
import { DxChorus } from './chorus';
import { DxDist } from './dist';
import { DxFilter } from './filter';
import { Downsampler, FL_HALFBAND, Upsampler } from './oversample';

const TINY = 5.960464477539063e-8;
/** FL's Center: x - LP2(x), the low-pass a damped integrator pair (as Fruity WaveShaper). */
const CENTER_A = 2.2834999999999997e-5;

export class DxSlot {
  private readonly sr: number;
  private readonly maxBlock: number;
  private type = -1;
  private bypass = false;
  private center = false;
  private os = 0;
  private F = 1;
  private up: Upsampler[] = [];
  private down: Downsampler[] = [];
  private readonly wl: Float32Array;
  private readonly wr: Float32Array;
  private readonly dl: Float32Array;
  private readonly dr: Float32Array;
  private readonly tmp = new Float64Array(16);
  private readonly dist: DxDist;
  private readonly filter: DxFilter;
  private readonly chorus: DxChorus;
  private readonly cab: DxCabinet;
  private readonly p: number[] = new Array(49).fill(0);
  private gIn = 1;
  private gMix = 1;
  private gOut = 1;
  private readonly cs = new Float64Array(4);
  private readonly centerA: number;
  /** Peak of the module output since the last read (L, R). */
  peakL = 0;
  peakR = 0;

  constructor(sampleRate: number, maxBlock: number) {
    this.sr = sampleRate;
    this.maxBlock = Math.max(128, maxBlock);
    const m = 16 * this.maxBlock;
    this.wl = new Float32Array(m);
    this.wr = new Float32Array(m);
    this.dl = new Float32Array(m);
    this.dr = new Float32Array(m);
    this.dist = new DxDist(sampleRate);
    this.filter = new DxFilter(sampleRate);
    this.chorus = new DxChorus(sampleRate, this.maxBlock);
    // FL plays its 44.1 kHz cabinet IRs unresampled at every rate: emulate that (response and level follow the rate)
    this.cab = new DxCabinet(sampleRate, this.maxBlock, true);
    this.centerA = CENTER_A * (44100 / sampleRate);
    this.setOs(0);
  }

  private setOs(os: number): void {
    const k = Math.max(0, Math.min(4, Math.round(os)));
    if (k === this.os && this.up.length) return;
    this.os = k;
    this.F = 1 << k;
    this.up = [new Upsampler(this.F, FL_HALFBAND), new Upsampler(this.F, FL_HALFBAND)];
    this.down = [new Downsampler(this.F, FL_HALFBAND), new Downsampler(this.F, FL_HALFBAND)];
    const r = this.sr * this.F;
    this.dist.setRate(r);
    this.filter.setSampleRate(r);
  }

  /** New module state and raw parameter values (49, FL's order). */
  configure(m: DxModule, raw: ArrayLike<number>): void {
    for (let k = 0; k < 49; k++) this.p[k] = raw[k];
    const p = this.p;
    if (m.type !== this.type) {
      this.type = m.type;
      this.resetEffects();
    }
    this.bypass = m.bypass >= 1;
    this.center = m.type === 0 && m.center >= 1;
    this.setOs(m.type <= 1 ? m.os : 0);
    // FL keeps the module gains in single precision
    this.gIn = Math.fround(Math.max(0, p[36]) / 5000);
    this.gMix = Math.fround(Math.min(1, Math.max(0, p[37] / 10000)));
    this.gOut = Math.fround(Math.max(0, p[38]) / 5000);
    switch (m.type) {
      case 0: this.dist.set(m.dist, p); break;
      case 1: this.filter.set(m.filter, p[39], p[40], m.smooth >= 1); break;
      case 2: this.chorus.set(m.chorus, { delay: p[43], feedback: p[44], speed: p[45], depth: p[46], blur: p[47], color: p[48] }); break;
      default: this.cab.set(m.cab, p[41], p[42]);
    }
  }

  private resetEffects(): void {
    this.dist.reset();
    this.filter.reset();
    this.chorus.reset();
    this.cab.reset();
    for (const u of this.up) u.reset();
    for (const d of this.down) d.reset();
    this.cs.fill(0);
  }

  reset(): void {
    this.resetEffects();
    this.peakL = this.peakR = 0;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.bypass || this.type < 0) {
      this.meter(L, R, n);
      return;
    }
    const F = this.type <= 1 ? this.F : 1;
    const wl = this.wl, wr = this.wr, dl = this.dl, dr = this.dr;
    // input gain -> dry copy, at the internal rate (FL applies the module gains inside the
    // oversampled section: after the upsampler, before the downsampler)
    const g = this.gIn;
    if (F === 1) {
      for (let i = 0; i < n; i++) {
        const l = L[i] * g, r = R[i] * g;
        dl[i] = wl[i] = l > -1e9 && l < 1e9 ? l : 0;
        dr[i] = wr[i] = r > -1e9 && r < 1e9 ? r : 0;
      }
    } else {
      const ul = this.up[0], ur = this.up[1], t = this.tmp;
      for (let i = 0; i < n; i++) {
        const l = L[i], r = R[i];
        const o = i * F;
        ul.process(l > -1e9 && l < 1e9 ? l : 0, t);
        for (let j = 0; j < F; j++) dl[o + j] = wl[o + j] = t[j] * g;
        ur.process(r > -1e9 && r < 1e9 ? r : 0, t);
        for (let j = 0; j < F; j++) dr[o + j] = wr[o + j] = t[j] * g;
      }
    }
    const m = n * F;
    switch (this.type) {
      case 0: this.dist.process(wl, wr, m); break;
      case 1: this.filter.process(wl, wr, m); break;
      case 2: this.chorus.process(wl, wr, m); break;
      default: this.cab.process(wl, wr, m);
    }
    // dry / wet (linear) and output gain at the internal rate, downsample, Center
    const mx = this.gMix, go = this.gOut;
    const f32 = Math.fround, dm = f32(1 - mx);
    if (F === 1) {
      for (let i = 0; i < n; i++) {
        L[i] = f32(f32(f32(dl[i] * dm) + f32(wl[i] * mx)) * go);
        R[i] = f32(f32(f32(dr[i] * dm) + f32(wr[i] * mx)) * go);
      }
    } else {
      for (let i = 0; i < m; i++) {
        wl[i] = f32(f32(f32(dl[i] * dm) + f32(wl[i] * mx)) * go);
        wr[i] = f32(f32(f32(dr[i] * dm) + f32(wr[i] * mx)) * go);
      }
      const dnl = this.down[0], dnr = this.down[1];
      for (let i = 0; i < n; i++) {
        L[i] = dnl.processAt(wl, i * F);
        R[i] = dnr.processAt(wr, i * F);
      }
    }
    if (this.center) this.removeDc(L, R, n);
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      if (!(l > -1e9 && l < 1e9)) L[i] = 0;
      if (!(r > -1e9 && r < 1e9)) R[i] = 0;
    }
    this.meter(L, R, n);
  }

  private meter(L: Float32Array, R: Float32Array, n: number): void {
    let a = this.peakL, b = this.peakR;
    for (let i = 0; i < n; i++) {
      const l = Math.abs(L[i]), r = Math.abs(R[i]);
      if (l > a) a = l;
      if (r > b) b = r;
    }
    this.peakL = a;
    this.peakR = b;
  }

  private removeDc(L: Float32Array, R: Float32Array, n: number): void {
    const a = this.centerA, st = this.cs;
    let p0 = st[0], v0 = st[1], p1 = st[2], v1 = st[3];
    for (let i = 0; i < n; i++) {
      const xl = L[i];
      v0 += (xl - p0) * a; p0 += v0; v0 *= 0.96;
      L[i] = xl - p0;
      const xr = R[i];
      v1 += (xr - p1) * a; p1 += v1; v1 *= 0.96;
      R[i] = xr - p1;
    }
    if (p0 < TINY && p0 > -TINY) p0 = 0;
    if (v0 < TINY && v0 > -TINY) v0 = 0;
    if (p1 < TINY && p1 > -TINY) p1 = 0;
    if (v1 < TINY && v1 > -TINY) v1 = 0;
    if (!Number.isFinite(p0 + v0 + p1 + v1)) p0 = v0 = p1 = v1 = 0;
    st[0] = p0; st[1] = v0; st[2] = p1; st[3] = v1;
  }
}
