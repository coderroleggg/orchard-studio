// Toxic Biohazard's per-voice oscillator bank, ported from FL 2026's Toxic
// Biohazard (the engine behind every voice): up to 48 wavetable oscillators
// (6 operators x 8 unison voices) rendered four at a time like FL's NEON loop.
// - 32-bit phase accumulators; the phase increment glides linearly (integer
//   steps) to the block's target; phase modulation from the FM inputs:
//   round(fm x 16777215) << 8 added to the phase (the inputs rest at 20.0);
// - table read: top 8 bits select the Catmull-Rom segment, the low 24 bits
//   are the fraction (fused cubic);
// - level: one-pole towards the envelope target (clamped to 1), times a cubic
//   in the block time t (velocity / LFO amplitude, fitted per block);
// - per-oscillator stereo gains smoothed with 0.001 x 44100 / sr per sample;
// - FM routing after every sample: input[dst] += amount x output[src].

import { f32 } from '../poizone/dsp';

export const TX_OSCS = 48;

/** The plugin-wide random seed of the oscillator start phases (FL: one global, seed 22222). */
export const txSeed = { v: 22222 };

/** arm64 fcvtns (round to nearest even, saturating to int32). */
function cvtns(x: number): number {
  if (!(x === x)) return 0;
  if (x >= 2147483647) return 2147483647;
  if (x <= -2147483648) return -2147483648;
  const r = Math.round(x);
  return (r - x === 0.5 && (r & 1) !== 0 ? r - 1 : r) | 0;
}

export class TxBank {
  /** 44100 / sr (pan smoothing scale), block time t and its step 1 / n. */
  k = 1;
  t = 0;
  dt = 0;
  readonly phase = new Uint32Array(TX_OSCS);
  readonly inc = new Int32Array(TX_OSCS);
  readonly dinc = new Int32Array(TX_OSCS);
  readonly target = new Float32Array(TX_OSCS);
  readonly level = new Float32Array(TX_OSCS);
  readonly coef = new Float32Array(TX_OSCS);
  readonly c0 = new Float32Array(TX_OSCS);
  readonly c1 = new Float32Array(TX_OSCS);
  readonly c2 = new Float32Array(TX_OSCS);
  readonly c3 = new Float32Array(TX_OSCS);
  readonly tab: (Float32Array | null)[] = new Array(TX_OSCS).fill(null);
  readonly tabOff = new Int32Array(TX_OSCS);
  readonly gLT = new Float32Array(TX_OSCS);
  readonly gL = new Float32Array(TX_OSCS);
  readonly gRT = new Float32Array(TX_OSCS);
  readonly gR = new Float32Array(TX_OSCS);
  readonly fmIn = new Float32Array(TX_OSCS).fill(20);
  readonly out = new Float32Array(TX_OSCS);
  // routing (FL: up to 0x1a2 entries; amount, destination input, source output)
  readonly rAmt = new Float32Array(512);
  readonly rDst = new Int32Array(512);
  readonly rSrc = new Int32Array(512);
  nRoute = 0;

  resetRouting(): void { this.nRoute = 0; }

  /** FM routes from oscillator src's output into the inputs of targets[i] (amounts[i]). */
  addRoutes(src: number, amounts: ArrayLike<number>, targets: ArrayLike<number>, count: number): void {
    for (let i = 0; i < count; i++) {
      const r = this.nRoute++;
      this.rAmt[r] = amounts[i];
      this.rDst[r] = targets[i];
      this.rSrc[r] = src;
    }
  }

  /** Start an oscillator: start level (envelope init), phase (fixed 0..1, or < 0: random from the global seed). */
  initOsc(i: number, init: number, ph: number): void {
    const s = (Math.imul(txSeed.v, 0x0bb38435) + 0x3619636b) >>> 0;
    txSeed.v = s;
    if (i < 0 || i >= TX_OSCS) return;
    if (ph >= 0) {
      const v = ph * 4294967295.0;
      this.phase[i] = v >= 4294967295 ? 4294967295 : v <= 0 ? 0 : Math.trunc(v);
    } else this.phase[i] = s;
    const lv = init > 1e-7 ? init : f32(1e-7);
    this.inc[i] = 0; this.dinc[i] = 0;
    this.target[i] = lv; this.level[i] = lv;
    this.coef[i] = 0; this.c0[i] = 0; this.c1[i] = 0; this.c2[i] = 0; this.c3[i] = 0;
    this.gLT[i] = 0; this.gL[i] = 0; this.gRT[i] = 0; this.gR[i] = 0;
    this.fmIn[i] = 20;
    this.out[i] = 0;
  }

  /** Block setup of one oscillator (FL 0x35b48). */
  setOsc(i: number, gl: number, gr: number, target: number, coef: number,
    c0: number, c1: number, c2: number, c3: number, tab: Float32Array, off: number, n: number, freq: number, sr: number): void {
    if (i < 0 || i >= TX_OSCS) return;
    const MIN = f32(1e-7);
    if (!(gl >= MIN)) gl = MIN;
    if (!(target >= MIN)) target = MIN;
    this.target[i] = target;
    this.coef[i] = coef;
    this.c0[i] = c0; this.c1[i] = c1; this.c2[i] = c2; this.c3[i] = c3;
    this.gLT[i] = gl;
    if (!(gr >= MIN)) gr = MIN;
    if (!(this.gL[i] >= MIN)) this.gL[i] = gl;
    this.gRT[i] = gr;
    if (!(this.gR[i] >= MIN)) this.gR[i] = gr;
    this.tab[i] = tab;
    this.tabOff[i] = off;
    let f = freq > 0 ? freq : 0;
    const lim = sr * 0.49;
    if (f > lim) f = lim;
    const v = Math.trunc((f * 4294967295.0) / sr) | 0;
    this.dinc[i] = Math.trunc((v - this.inc[i]) / n) | 0;
  }

  /** Render m samples of nOsc oscillators into L / R (sums of the stereo outputs). */
  render(L: Float32Array, R: Float32Array, off: number, m: number, nOsc: number): void {
    const panK = f32(this.k * f32(0.001));
    let t = this.t;
    const dt = this.dt;
    const ph = this.phase, inc = this.inc, dinc = this.dinc, tgt = this.target, lvl = this.level, cf = this.coef;
    const c0 = this.c0, c1 = this.c1, c2 = this.c2, c3 = this.c3, fmIn = this.fmIn, out = this.out;
    const gLT = this.gLT, gL = this.gL, gRT = this.gRT, gR = this.gR;
    const yl = [0, 0, 0, 0], yr = [0, 0, 0, 0];
    for (let s = 0; s < m; s++) {
      let first = true;
      let left = nOsc;
      let base = 0;
      do {
        for (let l = 0; l < 4; l++) {
          const i = base + l;
          const q = f32(fmIn[i] * 16777215);
          const p = ((cvtns(q) << 8) + ph[i]) >>> 0;
          ph[i] = (ph[i] + inc[i]) >>> 0;
          inc[i] = (inc[i] + dinc[i]) | 0;
          const fr = f32((p & 0xffffff) * 5.960464477539063e-8);
          const T = this.tab[i];
          let y = 0;
          if (T) {
            const o = this.tabOff[i] + (p >>> 24) * 4;
            y = f32(T[o + 3] * fr + T[o + 2]);
            y = f32(y * fr + T[o + 1]);
            y = f32(y * fr + T[o]);
          }
          const old = lvl[i];
          let nl = f32(f32(tgt[i] - old) * cf[i] + old);
          if (nl > 1) nl = 1;
          lvl[i] = nl;
          y = f32(y * old);
          let e = f32(c3[i] * t + c2[i]);
          e = f32(e * t + c1[i]);
          e = f32(e * t + c0[i]);
          y = f32(y * e);
          out[i] = y;
          const gl = gL[i], gr = gR[i];
          yl[l] = f32(y * gl);
          gL[i] = f32(f32(gLT[i] - gl) * panK + gl);
          gR[i] = f32(f32(gRT[i] - gr) * panK + gr);
          yr[l] = f32(y * gr);
        }
        const sl = f32(f32(yl[0] + yl[1]) + f32(yl[2] + yl[3]));
        const sr = f32(f32(yr[0] + yr[1]) + f32(yr[2] + yr[3]));
        if (first) { L[off + s] = sl; R[off + s] = sr; }
        else { L[off + s] = f32(sl + L[off + s]); R[off + s] = f32(R[off + s] + sr); }
        fmIn[base] = 20; fmIn[base + 1] = 20; fmIn[base + 2] = 20; fmIn[base + 3] = 20;
        first = false;
        base += 4;
        left -= 4;
      } while (left > 0);
      t = f32(t + dt);
      for (let r = 0; r < this.nRoute; r++) {
        const d = this.rDst[r];
        fmIn[d] = f32(this.rAmt[r] * out[this.rSrc[r]] + fmIn[d]);
      }
    }
    this.t = t;
  }
}
