// Spreader (FL: Spreader), a port of FL's own DSP (the "StereoEnhancer"
// engine in FL's shared ildsp library, read from its arm64 code):
// - parameters are smoothed per sample with a one-pole (a = exp(-500/sr)),
//   all starting from 0 when the plugin is created or reset: the enable gain
//   B crossfades dry -> processed, so the plugin fades in from dry;
// - the input times B goes through a Linkwitz-Riley crossover at the low
//   bypass frequency (two TPT state-variable filters, Butterworth, in
//   series): ap = 2nd-order all-pass of stage 1, lp = LR4 low-pass,
//   hp = ap - lp (LR4 high-pass);
// - HS = hpL - hpR and HM = hpL + hpR are written to 2048-sample delay
//   lines; both are read at a delay of trunc(sr·6.349 ms·C) samples (C = the
//   smoothed spread), crossfading over 1024/44100 s between the old and the
//   new tap whenever it changes, and scaled by C;
// - the delayed signals pass a 15 kHz first-order low-pass / high-pass pair
//   (W(x) = LP(x) + 0.398·HP(x): -8 dB above 15 kHz);
// - out = x(1-B) + lp(1-F) + F·(lpL+lpR)/2 + HM/2 + C·W(HSd)/2 ± E·(HS + C·W(HMd))
//   with E = separation (0..1, 0.5 = original) and F = mono bass.

import type { EffectInstance, EffectModule, FxMonitor } from '../types';

const SQRT2 = 1.4142135381698608;
const SQRT8 = 2.8284270763397217;
const N = 2048;
const MASK = N - 1;

class Spreader implements EffectInstance {
  private readonly a: number;
  private readonly b: number;
  private readonly piOverSr: number;
  private readonly maxTap: number;
  private readonly maxTapF: number;
  private readonly xfStep: number;
  private readonly k1: number;
  private readonly k2: number;
  private readonly k3: number;
  // targets
  private tA = 10;
  private tB = 1;
  private tC = 0.5;
  private tE = 0.5;
  private tF = 0;
  // smoothed values
  private A = 0;
  private B = 0;
  private C = 0;
  private E = 0;
  private F = 0;
  // crossover states (TPT SVF s1/s2 for stage 1 and 2, L and R)
  private z1L = 0; private z2L = 0; private y1L = 0; private y2L = 0;
  private z1R = 0; private z2R = 0; private y1R = 0; private y2R = 0;
  // delay lines and taps
  private readonly dlS = new Float32Array(N);
  private readonly dlM = new Float32Array(N);
  private widx = 0;
  private tapA = 0;
  private tapB = 0;
  private pos = 0;
  private step = 0;
  // 15 kHz filters
  private Dp = 0; private f1 = 0; private f2 = 0;
  private Mp = 0; private g1 = 0; private g2 = 0;
  // editor scopes: decimated pre / post sample pairs and phase / balance accumulators
  private readonly scopePre = new Float32Array(512);
  private readonly scopePost = new Float32Array(512);
  private scopeN = 0;
  private scopeDec = 0;
  private corrPre = [0, 0, 0];
  private corrPost = [0, 0, 0];

  constructor(sampleRate: number) {
    const sr = Math.min(192000, Math.max(1, Math.trunc(sampleRate)));
    const inv = Math.fround(1 / sr);
    this.a = Math.fround(Math.exp(Math.fround(inv * -500)));
    this.b = Math.fround(1 - this.a);
    this.piOverSr = Math.fround(inv * 3.1415927410125732);
    const md = Math.fround(sr * 0.0063492064364254475);
    this.maxTap = Math.trunc(md);
    this.maxTapF = Math.trunc(md);
    this.xfStep = Math.fround(1 / Math.trunc(Math.fround(sr * 0.02321995422244072)));
    const t = Math.fround(Math.tan(Math.fround(inv * 47123.890625)));
    const it = Math.fround(1 / t);
    this.k1 = Math.fround(1 - it);
    this.k2 = Math.fround(1 / (it + 1));
    this.k3 = Math.fround(0.5 / t);
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number, lo: number, hi: number) => {
      const v = Number(q[k] ?? d);
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;
    };
    // FL: normalised (raw - min) / (max - min), handed to the engine as float32
    this.tC = Math.fround(num('spread', 5000, 0, 10000) / 10000);
    this.tE = Math.fround((num('sep', 0, -10000, 10000) + 10000) / 20000);
    const x = Math.fround((num('lowbypass', 10990, 1000, 1000000) - 1000) * (1 / 999000));
    const hz = x <= 0.5 ? 1000 * x : 500 + 9500 * ((x - 0.5) * 2);
    this.tA = Math.max(10, Math.fround(hz));
    this.tF = num('mono', 0, 0, 1);
    this.tB = num('enabled', 1, 0, 1);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    // FL keeps the smoothed values in float32 (fused multiply-add); the delay tap
    // decisions depend on their exact values, so they are rounded the same way
    const f32 = Math.fround;
    const a = this.a, bA = f32(this.tA * this.b), bB = f32(this.tB * this.b), bC = f32(this.tC * this.b), bE = f32(this.tE * this.b), bF = f32(this.tF * this.b);
    const k1 = this.k1, k2 = this.k2, k3 = this.k3, piOverSr = this.piOverSr, maxTap = this.maxTap, maxTapF = this.maxTapF;
    const dlS = this.dlS, dlM = this.dlM;
    let A = this.A, B = this.B, C = this.C, E = this.E, F = this.F;
    let z1L = this.z1L, z2L = this.z2L, y1L = this.y1L, y2L = this.y2L, z1R = this.z1R, z2R = this.z2R, y1R = this.y1R, y2R = this.y2R;
    let w = this.widx, tapA = this.tapA, tapB = this.tapB, pos = this.pos, step = this.step;
    let Dp = this.Dp, f1 = this.f1, f2 = this.f2, Mp = this.Mp, g1 = this.g1, g2 = this.g2;
    const cp = this.corrPre, cq = this.corrPost;
    for (let i = 0; i < n; i++) {
      A = f32(A * a + bA);
      const g = Math.tan(A * piOverSr);
      const gk = g + SQRT2;
      const d = 1 / (gk * g + 1);
      B = f32(B * a + bB);
      const xL = L[i], xR = R[i];
      // left: stage 1 (all-pass output) and stage 2 (LR4 low-pass)
      const uL = xL * B;
      let gh = (uL - (z1L * gk + z2L)) * g * d;
      let bp = gh + z1L;
      z1L += 2 * gh;
      let gb = bp * g;
      const lp1L = z2L + gb;
      z2L += 2 * gb;
      const apL = uL - bp * SQRT8;
      gh = (lp1L - (y1L * gk + y2L)) * g * d;
      bp = gh + y1L;
      y1L += 2 * gh;
      gb = bp * g;
      const lpL = y2L + gb;
      y2L += 2 * gb;
      // right
      const uR = xR * B;
      gh = (uR - (z1R * gk + z2R)) * g * d;
      bp = gh + z1R;
      z1R += 2 * gh;
      gb = bp * g;
      const lp1R = z2R + gb;
      z2R += 2 * gb;
      const apR = uR - bp * SQRT8;
      gh = (lp1R - (y1R * gk + y2R)) * g * d;
      bp = gh + y1R;
      y1R += 2 * gh;
      gb = bp * g;
      const lpR = y2R + gb;
      y2R += 2 * gb;
      // high-band side / mid into the delay lines
      const hs = apL - lpL - (apR - lpR);
      const wi = w & MASK;
      dlS[wi] = hs;
      C = f32(C * a + bC);
      const target = Math.trunc(f32(maxTapF * C));
      // tap crossfade (FL's state machine)
      const tapA0 = tapA, pos0 = pos;
      let st: number;
      if (step !== 0) st = pos0 < 1 && pos0 > 0 ? step : 0;
      else if (pos0 === 0 && tapA0 !== target) st = this.xfStep;
      else if (pos0 === 1 && tapB !== target) st = -this.xfStep;
      else st = 0;
      step = st;
      pos = Math.max(0, Math.min(1, f32(pos0 + st)));
      tapA = tapB !== target && pos0 >= 1 ? target : tapA0;
      tapB = tapA0 !== target && pos0 <= 0 ? target : tapB;
      const ra = (w - Math.min(Math.max(tapA, 0), maxTap)) & MASK;
      const rb = (w - Math.min(Math.max(tapB, 0), maxTap)) & MASK;
      const sA = dlS[ra];
      const D = -(sA + (dlS[rb] - sA) * pos) * C;
      f1 = -k2 * (k1 * f1 + 0.5 * (D + Dp));
      f2 = k2 * (k3 * (Dp - D) - k1 * f2);
      Dp = D;
      const ap = apL + apR, lp = lpL + lpR;
      const hm = ap - lp;
      dlM[wi] = hm;
      const mA = dlM[ra];
      const Md = (mA + (dlM[rb] - mA) * pos) * C;
      g1 = k2 * (0.5 * (Md + Mp) - k1 * g1);
      g2 = k2 * (k3 * (Md - Mp) - k1 * g2);
      Mp = Md;
      E = f32(E * a + bE);
      F = f32(F * a + bF);
      const s21 = f2 * 0.7962143421173096 + ap;
      let ss = (lp - 2 * (lpL - apL + f1) - s21) * 0.5 + f1 + g1 + (g2 + f2) * 0.3981071710586548;
      ss = 2 * ss * E;
      const mm = (2 * f1 - lp + s21 + F * lp) * 0.5;
      const oL = xL * (1 - B) + lpL * (1 - F) + mm + ss;
      const oR = xR * (1 - B) + lpR * (1 - F) + mm - ss;
      L[i] = oL;
      R[i] = oR;
      w = (w + 1) | 0;
      // editor meters: correlation and balance, pre and post
      cp[0] += xL * xR; cp[1] += xL * xL; cp[2] += xR * xR;
      cq[0] += oL * oR; cq[1] += oL * oL; cq[2] += oR * oR;
      if (++this.scopeDec >= 4 && this.scopeN < 256) {
        this.scopeDec = 0;
        const k = this.scopeN++ * 2;
        this.scopePre[k] = xL; this.scopePre[k + 1] = xR;
        this.scopePost[k] = oL; this.scopePost[k + 1] = oR;
      }
    }
    // keep the recursive states finite (stable filters; guard against bad input)
    if (!(Math.abs(z1L) + Math.abs(z2L) + Math.abs(y1L) + Math.abs(y2L) + Math.abs(z1R) + Math.abs(z2R) + Math.abs(y1R) + Math.abs(y2R) + Math.abs(f1) + Math.abs(f2) + Math.abs(g1) + Math.abs(g2) < 1e30)) {
      this.clearStates();
      return;
    }
    this.A = A; this.B = B; this.C = C; this.E = E; this.F = F;
    this.z1L = z1L; this.z2L = z2L; this.y1L = y1L; this.y2L = y2L; this.z1R = z1R; this.z2R = z2R; this.y1R = y1R; this.y2R = y2R;
    this.widx = w & 0x7fffffff; this.tapA = tapA; this.tapB = tapB; this.pos = pos; this.step = step;
    this.Dp = Dp; this.f1 = f1; this.f2 = f2; this.Mp = Mp; this.g1 = g1; this.g2 = g2;
  }

  private clearStates(): void {
    this.z1L = this.z2L = this.y1L = this.y2L = this.z1R = this.z2R = this.y1R = this.y2R = 0;
    this.dlS.fill(0); this.dlM.fill(0);
    this.Dp = this.f1 = this.f2 = this.Mp = this.g1 = this.g2 = 0;
  }

  reset(): void {
    // FL's reset: smoothed values back to 0 (fade in from dry), states cleared
    this.A = this.B = this.C = this.E = this.F = 0;
    this.clearStates();
    this.widx = 0; this.tapA = this.tapB = 0; this.pos = this.step = 0;
  }

  get tail(): number {
    return 0.25; // crossover ring-out and the 6 ms delay
  }

  monitor(): FxMonitor {
    const m: FxMonitor = {
      pre: this.scopePre.slice(0, this.scopeN * 2),
      post: this.scopePost.slice(0, this.scopeN * 2),
      corrPre: this.corrPre[0] / (Math.sqrt(this.corrPre[1] * this.corrPre[2]) || 1),
      corrPost: this.corrPost[0] / (Math.sqrt(this.corrPost[1] * this.corrPost[2]) || 1),
      powL: this.corrPost[1],
      powR: this.corrPost[2],
      powPreL: this.corrPre[1],
      powPreR: this.corrPre[2],
    };
    this.scopeN = 0;
    this.corrPre = [0, 0, 0];
    this.corrPost = [0, 0, 0];
    return m;
  }
}

export const effect: EffectModule = {
  id: 'spreader',
  create: (sampleRate) => new Spreader(sampleRate),
};
