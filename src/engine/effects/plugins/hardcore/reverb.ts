// Compact stereo reverb for the Hardcore Reverb pedal (also used by Mobile Rack):
// a 4-stage all-pass input diffuser into an 8-line feedback delay network
// (Hadamard mixing), with per-line damping and gains set from the decay time,
// two slowly modulated lines against metallic ringing, and decorrelated left /
// right output taps. Damping is a one-pole low pass blended into a high shelf:
// `dampFloorDb` is the high-frequency loss per 45 ms of loop (Infinity = plain
// low pass), scaled to each line's length so the HF decay time is predictable.

import { DelayLine, OnePole1, fl } from './dsp';

const LINES_MS = [29.65, 37.1, 41.1, 43.73, 47.27, 53.1, 59.98, 67.73];
const DIFF_MS = [4.77, 3.59, 12.73, 9.31];
const DIFF_G = 0.62;

export class FdnReverb {
  private readonly sr: number;
  private readonly lines: DelayLine[];
  private readonly len: Float64Array;
  private readonly gain = new Float64Array(8);
  private readonly damp: OnePole1[];
  private readonly dampMix = new Float64Array(8);
  private readonly diff: DelayLine[];
  private readonly diffLen: Int32Array;
  private readonly pre: DelayLine;
  private readonly hp = new OnePole1();
  private readonly v = new Float64Array(8);
  private preSamples = 1;
  private size = 1;
  private modPh = 0;
  private readonly modInc: number;
  private readonly modDepth: number;
  decay = 1.5;

  constructor(sr: number, maxPreMs = 120, maxSize = 1.3) {
    this.sr = sr;
    this.len = Float64Array.from(LINES_MS, (m) => (m * sr) / 1000);
    this.lines = LINES_MS.map((m) => new DelayLine((m * maxSize * sr) / 1000 + 64));
    this.damp = LINES_MS.map(() => new OnePole1());
    this.diff = DIFF_MS.map((m) => new DelayLine((m * sr) / 1000 + 4));
    this.diffLen = Int32Array.from(DIFF_MS, (m) => Math.max(1, Math.round((m * sr) / 1000)));
    this.pre = new DelayLine((maxPreMs * sr) / 1000 + 4);
    this.hp.setHz(90, sr);
    this.modInc = 0.6 / sr;
    this.modDepth = 0.0012 * sr; // 1.2 ms
    this.set(1.5, 8000, 8, 1);
  }

  /**
   * decay = RT60 (s), dampHz = damping corner (Hz), pre = pre-delay (ms), size =
   * line scale (0.5..1.3), dampFloorDb = HF loss per 45 ms of loop (Infinity: low pass).
   */
  set(decay: number, dampHz: number, preMs = 8, size = 1, dampFloorDb = Infinity): void {
    this.decay = Math.max(0.05, decay);
    this.size = Math.min(1.3, Math.max(0.3, size));
    this.preSamples = Math.max(0, Math.min(this.pre.size - 2, Math.round((preMs * this.sr) / 1000)));
    for (let i = 0; i < 8; i++) {
      const L = this.len[i] * this.size;
      this.gain[i] = Math.pow(10, (-3 * L) / (this.sr * this.decay));
      this.damp[i].setHz(dampHz, this.sr);
      const floor = Number.isFinite(dampFloorDb) ? Math.pow(10, (-dampFloorDb * (L / this.sr / 0.045)) / 20) : 0;
      this.dampMix[i] = 1 - Math.min(1, Math.max(0, floor));
    }
  }

  reset(): void {
    for (const l of this.lines) l.clear();
    for (const d of this.diff) d.clear();
    for (const d of this.damp) d.reset();
    this.pre.clear();
    this.hp.reset();
    this.v.fill(0);
  }

  /** Process: reads inL/inR, writes the wet signal to outL/outR (may alias the inputs). */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, n: number): void {
    const v = this.v, lines = this.lines, gain = this.gain, damp = this.damp, diff = this.diff, dl = this.diffLen, dm = this.dampMix;
    const sz = this.size;
    const l0 = this.len[0] * sz, l1 = this.len[1] * sz, l2 = this.len[2] * sz, l3 = this.len[3] * sz;
    const l4 = this.len[4] * sz, l5 = this.len[5] * sz, l6 = this.len[6] * sz, l7 = this.len[7] * sz;
    for (let i = 0; i < n; i++) {
      // input: mono, high passed, pre-delayed, diffused
      let x = this.hp.hp(0.5 * (inL[i] + inR[i]));
      if (this.preSamples > 0) { this.pre.write(x); x = this.pre.tap(this.preSamples); }
      for (let k = 0; k < 4; k++) {
        const d = diff[k].tap(dl[k]);
        const w = x + DIFF_G * d;
        diff[k].write(w);
        x = d - DIFF_G * w;
      }
      // line outputs (two modulated)
      this.modPh += this.modInc;
      if (this.modPh >= 1) this.modPh -= 1;
      const m = Math.sin(6.283185307179586 * this.modPh) * this.modDepth;
      v[0] = lines[0].read(l0 + m);
      v[1] = lines[1].tap(l1 | 0);
      v[2] = lines[2].tap(l2 | 0);
      v[3] = lines[3].read(l3 - m);
      v[4] = lines[4].tap(l4 | 0);
      v[5] = lines[5].tap(l5 | 0);
      v[6] = lines[6].tap(l6 | 0);
      v[7] = lines[7].tap(l7 | 0);
      // stereo taps before mixing
      const oL = v[0] - v[2] + v[4] - v[6] + 0.5 * (v[1] + v[7]);
      const oR = v[1] - v[3] + v[5] - v[7] + 0.5 * (v[2] + v[6]);
      // fast Walsh-Hadamard (orthogonal, scaled 1/sqrt(8))
      for (let h = 1; h < 8; h <<= 1) {
        for (let a = 0; a < 8; a += h << 1) {
          for (let b = a; b < a + h; b++) {
            const p = v[b], q = v[b + h];
            v[b] = p + q; v[b + h] = p - q;
          }
        }
      }
      for (let k = 0; k < 8; k++) {
        const u = v[k] * 0.35355339059327373;
        const y = (u + dm[k] * (damp[k].lp(u) - u)) * gain[k] + ((k & 1) ? -x : x) * 0.5;
        lines[k].write(fl(y));
      }
      outL[i] = oL * 0.42;
      outR[i] = oR * 0.42;
    }
  }
}
