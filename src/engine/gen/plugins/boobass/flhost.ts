// FL host services that FL's plugins call to apply voice levels, in FL's
// single precision (FLEngine 26.1.6, arm64), shared by BooBass and Plucked!:
// - ComputeLRVol: the circular pan law (FLEngine 0x3a8420 -> 0x33b0), via
//   macOS's __sincosf_stret (emulated, ./libm.ts);
// - AddWave_32FM_32FS_Ramp / AddWave_32FS_32FS_Ramp (FLEngine 0x3d8390 /
//   0x3d84e0, step 0x3a8240): add a mono / stereo block with gains ramped
//   from the last ones to the new targets (per channel step = (target - last)
//   / n, clamped to +-0.001 x 44100 / rate; gain last + step x i in double).

import { f } from './f32';
import { sincos, sincosf } from './libm';

/** ComputeLRVol's result (reused). */
export const flLR = { l: 0, r: 0 };

/** FL's ComputeLRVol (circular law): flLR.l / flLR.r for a pan (-1..1, clamped) and volume. */
export function flComputeLRVol(pan: number, vol: number): void {
  let p = pan;
  if (!(p >= -1)) p = -1; else if (p > 1) p = 1;
  sincosf(f(f(p + 1) * 0.7853981633974483));
  flLR.l = f(sincos.c * vol);
  flLR.r = f(sincos.s * vol);
}

/** The ramp state FL keeps per voice (the "last" gains AddWave updates). */
export interface RampState { lastL: number; lastR: number }

let rampStart = 0;
let rampDelta = 0;
/** One channel of FL's ramp setup: sets rampStart / rampDelta, returns the new "last" gain. */
function rampStep(target: number, last: number, n: number, maxStep: number): number {
  rampStart = last;
  let step = f(target - last);
  if (step === 0) { rampDelta = 0; return last; }
  let nl = target;
  step = f(step / f(n));
  if (Math.abs(step) > maxStep) {
    step = step < 0 ? -maxStep : maxStep;
    nl = f(last + f(step * f(n)));
    if (Math.abs(nl) < 1e-30) { nl = 0; step = f(-last / f(n)); }
  }
  rampDelta = step;
  return nl;
}

/**
 * FL's AddWave ramp for one block applied in parts: FL computes the steps
 * from the whole block, so a block that straddles two engine blocks is set
 * up once (begin) and added part by part (add) with the ramp continued.
 */
export class FlRamp {
  private lv = 0; private rv = 0;
  private stl = 0; private str = 0;
  private gl = 0; private gr = 0;
  private flat = true;
  /** Set up a block of n samples towards gains lv / rv (updates st's last gains like FL). */
  begin(lv: number, rv: number, n: number, st: RampState, sr: number): void {
    const maxStep = f(0.001 * (44100 / sr));
    st.lastL = rampStep(lv, st.lastL, n, maxStep);
    this.gl = rampStart; this.stl = rampDelta;
    st.lastR = rampStep(rv, st.lastR, n, maxStep);
    this.gr = rampStart; this.str = rampDelta;
    this.lv = lv; this.rv = rv;
    this.flat = this.stl === 0 && this.str === 0;
  }
  /** Add m frames of the block's next part (mono, or interleaved stereo) to L / R at `off`. */
  add(src: Float32Array, L: Float32Array, R: Float32Array, off: number, m: number, stereo: boolean): void {
    const k = stereo ? 2 : 1, o = stereo ? 1 : 0;
    if (this.flat) {
      const lv = this.lv, rv = this.rv;
      if (lv === 0 && rv === 0) return;
      for (let i = 0; i < m; i++) {
        L[off + i] = f(L[off + i] + f(src[k * i] * lv));
        R[off + i] = f(R[off + i] + f(src[k * i + o] * rv));
      }
      return;
    }
    let gl = this.gl, gr = this.gr;
    const stl = this.stl, str = this.str;
    for (let i = 0; i < m; i++) {
      L[off + i] = f(L[off + i] + src[k * i] * gl);
      gl += stl;
      R[off + i] = f(R[off + i] + src[k * i + o] * gr);
      gr += str;
    }
    this.gl = gl; this.gr = gr;
  }
}
