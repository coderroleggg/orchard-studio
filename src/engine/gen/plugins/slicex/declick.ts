// FL's real-time declicker (class TDeclicker, as Slicex configures it in 0x7d300: attack mode 2
// over 4 ms, release mode 1 over 20 ms; setup 0x2813d0 / 0x281620, per voice init 0x281d20,
// process 0x281db0). FL's single precision throughout.
//
// - Attack (a voice that starts inside the sample): the first frame's value, negated, is added
//   to the voice with a raised-cosine weight falling from ~1 to 0 over 4 ms (FL's NEON kernel
//   0x5058: out = in + w * v, products and sums in float32), so the voice starts at zero.
// - Release (the voice's end: note off with no envelope left, or the region end): a one-pole
//   tracker dc += (x - dc) c whose coefficient rises as 2 / rate x e^(10 i / len) (capped at 1)
//   is subtracted (a high-pass sweeping up), times a raised-cosine fade over the last 1 ms.

import { exp, cos } from './libm';
const f32 = Math.fround;
const MAXINT = 0x7fffffff;

/** Per-voice declicker state (FL's voice +0xfc..+0x12c). */
export class DeclickState {
  /** Attack position (MAXINT: done). */
  a = MAXINT;
  /** Release position (-1: not releasing). */
  r = -1;
  /** Frames to skip before the release starts (the region end inside a block). */
  skip = 0;
  /** Attack values (negated first frame) and release trackers. */
  aL = 0;
  aR = 0;
  dL = 0;
  dR = 0;
}

export class Declicker {
  readonly aLen: number;
  readonly rLen: number;
  /** Attack weights. */
  readonly aTab: Float32Array;
  /** Release gain and tracker coefficient tables. */
  readonly rGain: Float32Array;
  readonly rCoef: Float32Array;

  constructor(sampleRate: number) {
    const ms = (t: number) => Math.max(1, roundEven(t * 0.001 * sampleRate));
    // attack: mode 2, 4 ms
    this.aLen = ms(4);
    this.aTab = new Float32Array(this.aLen);
    const d11 = 1 / (this.aLen + 1);
    for (let i = 1; i <= this.aLen; i++) this.aTab[i - 1] = f32((cos(i * d11 * Math.PI) + 1) * 0.5);
    // release: mode 1, 20 ms
    this.rLen = ms(20);
    this.rGain = new Float32Array(this.rLen);
    this.rCoef = new Float32Array(this.rLen);
    const d9 = (10.001067880874992 / (0.6931471805599453 * this.rLen)) * 0.6931471805599453;
    const d10 = 2 / sampleRate;
    const one = Math.min(this.rLen, roundEven(0.001 * sampleRate));
    const k11 = 1 / (one + 1);
    const w21 = this.rLen - one;
    let d13 = 1;
    for (let i = 1; i <= this.rLen; i++) {
      const c = d10 * exp(i * d9);
      this.rCoef[i - 1] = f32(c < 1 ? c : 1);
      if (i > w21) d13 = (cos((i - w21) * k11 * Math.PI) + 1) * 0.5;
      this.rGain[i - 1] = f32(d13);
    }
  }

  /** FL 0x281d20: a voice starting at position > 0 gets the attack declick. */
  init(s: DeclickState, midSample: boolean): void {
    s.a = midSample ? 0 : MAXINT;
    s.r = -1;
    s.aL = 0; s.aR = 0; s.dL = 0; s.dR = 0;
    s.skip = 0;
  }

  /** Start the release: FL sets the attack done, release position 0 and the frames to skip. */
  release(s: DeclickState, skip: number): void {
    if (s.r >= 0) return;
    s.a = MAXINT;
    s.r = 0;
    s.skip = skip;
  }

  /** Whether the release has run its course (FL: release length <= position). */
  done(s: DeclickState): boolean {
    return s.r >= 0 && this.rLen <= s.r;
  }

  /** Process n frames of the voice buffers in place from `o` (FL 0x281db0). */
  process(s: DeclickState, L: Float32Array, R: Float32Array, o: number, n: number): void {
    if (this.aLen > s.a) {
      if (s.a === 0) { s.aL = -L[o]; s.aR = -R[o]; }
      const m = Math.min(this.aLen - s.a, n);
      const t = this.aTab;
      for (let i = 0; i < m; i++) {
        const w = t[s.a + i];
        L[o + i] = f32(L[o + i] + f32(w * s.aL));
        R[o + i] = f32(R[o + i] + f32(w * s.aR));
      }
      s.a += m;
    }
    if (s.r < 0) return;
    if (s.skip > 0) {
      const m = Math.min(s.skip, n);
      s.skip -= m;
      o += m; n -= m;
      if (n <= 0) return;
    }
    const g = this.rGain, c = this.rCoef, last = this.rLen - 1;
    for (let i = 0; i < n; i++) {
      const j = s.r < last ? s.r : last;
      const gg = g[j], cc = c[j];
      s.r++;
      s.dL = f32(s.dL + f32(cc * f32(L[o + i] - s.dL)));
      L[o + i] = f32(f32(L[o + i] - s.dL) * gg);
      s.dR = f32(s.dR + f32(cc * f32(R[o + i] - s.dR)));
      R[o + i] = f32(f32(R[o + i] - s.dR) * gg);
    }
  }
}

function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && (r & 1) !== 0 ? r - 1 : r;
}
