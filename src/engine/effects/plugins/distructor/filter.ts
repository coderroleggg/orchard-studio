// Distructor filter module (FL Studio "Distructor", module type 1; the 22 FLEX/Love Philter filter models).
//
// Reverse-engineered from FL's module binary (TFilterProcessor and its filter classes) and verified
// against renders of the real plugin; see dxfilter_notes.txt for the per-model structure and error figures.
//
// - Runs at the module's internal rate: pass the (possibly oversampled) rate to the constructor or
//   setSampleRate(). FL recomputes every coefficient for that rate (bilinear designs are prewarped, so the
//   analog response is the same at any rate; the Alt/comb/vowel/DC-blocker details scale with the rate).
// - FL processes in float32 with a few double-precision steps; this port reproduces that arithmetic order
//   with Math.fround and is sample-identical to FL for all 22 models (including the non-linear Alt filters,
//   feedback phasers and combs) at any rate where FL itself is stable.
// - Deviations from FL (only where FL breaks): non-finite or |x| >= 1e30 input is treated as 0; cutoffs
//   above 0.4999*sr are clamped (FL blows up there, possible only for internal rates < 41 kHz); runaway or
//   non-finite output resets the active filter; states below 1e-30 are flushed at block end.
// - Parameters: cutoff/resonance raw 0..10000 (normalised c = raw/10000). Cutoff in Hz for the cutoff-based
//   models is 20 * 2^(10c) (20 Hz .. 20480 Hz).
// - Smoothing (module "smooth" switch): one-pole glide of the normalised cutoff (and, for the 24 dB, Alt,
//   comb, vowel and phaser models, the resonance) with 90 % settling in 10 ms at the internal rate;
//   coefficients are then recomputed every sample. Without smoothing, coefficients change at block start.

const f32 = Math.fround;
const PI = 3.141592653589793;

export const DX_FILTER_MODEL_NAMES: readonly string[] = [
  'LP6', 'HP6', 'LP12', 'HP12', 'BP12', 'LP24', 'HP24', 'Notch', 'Low pass 12 Alt', 'Band pass 12 Alt',
  'High pass 12 Alt', 'Lowpass 24 Alt', 'Peak', 'Comb filter +', 'Comb filter -', 'Vowel', 'Phaser 1',
  'Phaser 2', 'Phaser 3', 'Low shelf', 'High shelf', 'Allpass',
];

/** Normalised (0..1, float32) value of a raw 0..10000 cutoff/resonance knob. */
export function dxFilterNorm(raw: number): number {
  const r = raw > 10000 ? 10000 : raw > 0 ? raw : 0;
  return f32(r / 10000);
}

/** Cutoff frequency (Hz) of a normalised cutoff, as FL computes it (float32). */
export function dxFilterCutoffHzNorm(c: number): number {
  return f32(20 * Math.pow(2, f32(c * 10)));
}

/** Cutoff frequency in Hz for a raw cutoff (0..10000): 20 * 1024^(raw/10000). Independent of the sample rate. */
export function dxFilterCutoffHz(raw: number, _sampleRate?: number): number {
  return dxFilterCutoffHzNorm(dxFilterNorm(raw));
}

/** SVF damping k (=1/Q) for LP12/HP12/BP12/Peak/Allpass: 1 - 0.99 r. */
export function dxFilterSvfK(resRaw: number): number {
  return f32(1 - 0.99 * dxFilterNorm(resRaw));
}

/** Notch damping: 1 - 0.792 r. */
export function dxFilterNotchK(resRaw: number): number {
  return f32(1 - 0.792 * dxFilterNorm(resRaw));
}

/** Per-stage damping of LP24/HP24 (two identical cascaded SVFs): 2 * sqrt(1 - 0.99 r). */
export function dxFilterSvf24K(resRaw: number): number {
  const k12 = f32(1 - 0.99 * dxFilterNorm(resRaw));
  return f32(2 * f32(1 / f32(Math.sqrt(f32(1 / k12)))));
}

/** Shelf gain in dB for Low/High shelf: 40 r - 20 (-20..+20 dB). */
export function dxFilterShelfDb(resRaw: number): number {
  return f32(-20 + f32(40 * dxFilterNorm(resRaw)));
}

/**
 * Comb read position in samples at a given rate: 1 + 0.05 s * sr * c (linear interpolation, 16384-sample ring).
 * Comb + (feed-forward) delays the input by this minus 1; Comb - (feedback) has this loop delay.
 */
export function dxFilterCombDelay(cutRaw: number, sampleRate: number): number {
  return f32(dxFilterNorm(cutRaw) * sampleRate * f32(0.05) + 1);
}

/** Phaser all-pass stage frequency in Hz (Phaser 1/3; Phaser 2 adds its slow LFO): 28.5 * 2^(9.269 c). */
export function dxFilterPhaserHz(cutRaw: number): number {
  const fq = 28.5 * Math.pow(2, f32(f32(dxFilterNorm(cutRaw) * 0.925) * f32(10.020833)));
  return f32(fq > 22000 ? 22000 : fq);
}

/** Vowel formant scale factor for a raw resonance: 2^(1.7 (r - 0.5)) (x0.555 .. x1.80). */
export function dxFilterVowelShift(resRaw: number): number {
  return f32(Math.pow(2, f32(dxFilterNorm(resRaw) - 0.5) * 1.7));
}

/** Per-sample coefficient of the parameter smoother at a rate: 1 - 0.1^(1/(0.01 sr)) (90 % in 10 ms). */
export function dxFilterSmoothingCoef(sampleRate: number): number {
  return 1 - Math.pow(1 - 0.9, 1 / (0.01 * sampleRate));
}

// ------------------------------------------------------------------------------------------- TLinearSVF

/** Coefficients of Andrew Simper's linear trapezoidal SVF (FL TLinearSVF), float32. */
class SvfCoef {
  a1 = 0; a2 = 0; a3 = 0; m0 = 0; m1 = 0; m2 = 0;
  /** mode: 0 LP, 1 HP, 2 BP, 3 notch, 4 peak (HP-LP), 6 low shelf, 7 high shelf, 8 allpass. */
  set(piOverSr: number, freq: number, k: number, gain: number, mode: number): void {
    const w = f32(freq * piOverSr);
    let g: number;
    if (mode === 6 || mode === 7) {
      const A = f32(Math.pow(10, f32(gain / 40)));
      const sA = f32(Math.sqrt(A));
      g = mode === 6 ? f32(Math.tan(w) / sA) : f32(Math.tan(w) * sA);
      this.a1 = f32(1 / f32(1 + f32(g * f32(g + k))));
      this.a2 = f32(g * this.a1);
      this.a3 = f32(g * this.a2);
      if (mode === 6) {
        this.m0 = 1; this.m1 = f32(k * f32(A - 1)); this.m2 = f32(f32(A * A) - 1);
      } else {
        this.m0 = f32(A * A); this.m1 = f32(f32(k * f32(1 - A)) * A); this.m2 = f32(1 - f32(A * A));
      }
      return;
    }
    g = f32(Math.tan(w));
    this.a1 = f32(1 / f32(1 + f32(g * f32(g + k))));
    this.a2 = f32(g * this.a1);
    this.a3 = f32(g * this.a2);
    switch (mode) {
      case 0: this.m0 = 0; this.m1 = 0; this.m2 = gain; break;
      case 1: this.m0 = gain; this.m1 = f32(-k * gain); this.m2 = -gain; break;
      case 2: this.m0 = 0; this.m1 = gain; this.m2 = 0; break;
      case 3: this.m0 = gain; this.m1 = f32(-k * gain); this.m2 = 0; break;
      case 4: this.m0 = gain; this.m1 = f32(-k * gain); this.m2 = f32(-2 * gain); break;
      default: this.m0 = 1; this.m1 = f32(-2 * k); this.m2 = 0; break; // 8: allpass
    }
  }
  copy(o: SvfCoef): void {
    this.a1 = o.a1; this.a2 = o.a2; this.a3 = o.a3; this.m0 = o.m0; this.m1 = o.m1; this.m2 = o.m2;
  }
}

class SvfState {
  ic1 = 0; ic2 = 0;
  tick(c: SvfCoef, x: number): number {
    const ic1 = this.ic1, ic2 = this.ic2;
    const v3 = f32(x - ic2);
    const v1 = f32(f32(c.a1 * ic1) + f32(c.a2 * v3));
    const v2 = f32(f32(ic2 + f32(c.a2 * ic1)) + f32(c.a3 * v3));
    this.ic1 = f32(f32(2 * v1) - ic1);
    this.ic2 = f32(f32(2 * v2) - ic2);
    return f32(f32(f32(c.m0 * x) + f32(c.m1 * v1)) + f32(c.m2 * v2));
  }
  reset(): void { this.ic1 = 0; this.ic2 = 0; }
  sane(): void {
    if (!(Math.abs(this.ic1) < 1e30) || !(Math.abs(this.ic2) < 1e30)) { this.ic1 = 0; this.ic2 = 0; }
    if (Math.abs(this.ic1) < 1e-30) this.ic1 = 0;
    if (Math.abs(this.ic2) < 1e-30) this.ic2 = 0;
  }
}

// ------------------------------------------------------------------------------------------- TOnePole

/** Bilinear one-pole LP/HP (FL TOnePole), float32. */
class OnePole {
  b0 = 0; b1 = 0; a1 = 0;
  x1L = 0; y1L = 0; x1R = 0; y1R = 0;
  set(piOverSr: number, freq: number, lp: boolean): void {
    const t = f32(Math.tan(f32(freq * piOverSr)));
    const den = f32(1 + t);
    if (lp) { this.b0 = f32(t / den); this.b1 = this.b0; } else { this.b0 = f32(1 / den); this.b1 = -this.b0; }
    this.a1 = f32(f32(1 - t) / den);
  }
  tickL(x: number): number {
    const y = f32(f32(f32(x * this.b0) + f32(this.x1L * this.b1)) + f32(this.y1L * this.a1));
    this.x1L = x; this.y1L = y; return y;
  }
  tickR(x: number): number {
    const y = f32(f32(f32(x * this.b0) + f32(this.x1R * this.b1)) + f32(this.y1R * this.a1));
    this.x1R = x; this.y1R = y; return y;
  }
  reset(): void { this.x1L = this.y1L = this.x1R = this.y1R = 0; }
  sane(): void {
    if (!(Math.abs(this.y1L) < 1e30) || !(Math.abs(this.y1R) < 1e30)) this.reset();
    if (Math.abs(this.y1L) < 1e-30) this.y1L = 0;
    if (Math.abs(this.y1R) < 1e-30) this.y1R = 0;
  }
}

// ------------------------------------------------------------------------------------------- TSFV4 (Alt 12)

/** Chamberlin SVF run 4x per sample on a linearly interpolated input, with a soft-clipped resonance term. */
class Sfv4 {
  f = 0; c = 0; mLP = 1; mHP = 0; mBP = 0;
  xpL = 0; hpL = 0; bpL = 0; lpL = 0;
  xpR = 0; hpR = 0; bpR = 0; lpR = 0;
  set(invSr: number, fc: number, res: number): void {
    this.c = f32(res * 0.5);
    const f = f32(6.283 * fc * invSr * 0.25);
    this.f = f < 1.2 ? f : 1.2; // guard: FL has no clamp (unstable only for internal rates below ~27 kHz)
  }
  private static nl(v: number): number {
    if (v > 2) return 1;
    if (v < -2) return -1;
    const u = f32(v * 0.5);
    return f32(u * f32(2 - Math.abs(u)));
  }
  tickL(x: number): number {
    const f = this.f, c = this.c, xp = this.xpL;
    const x1 = f32(f32(xp * 0.75) + f32(x * 0.25));
    const x2 = f32(f32(xp * 0.5) + f32(x * 0.5));
    const x3 = f32(f32(xp * 0.25) + f32(x * 0.75));
    this.xpL = x;
    let hp = 0, bp = this.bpL, lp = this.lpL;
    for (let s = 0; s < 4; s++) {
      const inp = s === 0 ? xp : s === 1 ? x1 : s === 2 ? x2 : x3;
      hp = f32(f32(inp - lp) - bp);
      hp = f32(hp + f32(c * Sfv4.nl(f32(bp * 4))));
      bp = f32(bp + f32(f * hp));
      lp = f32(lp + f32(f * bp));
    }
    this.hpL = hp; this.bpL = bp; this.lpL = lp;
    return f32(f32(f32(lp * this.mLP) + f32(hp * this.mHP)) + f32(bp * this.mBP));
  }
  tickR(x: number): number {
    const f = this.f, c = this.c, xp = this.xpR;
    const x1 = f32(f32(xp * 0.75) + f32(x * 0.25));
    const x2 = f32(f32(xp * 0.5) + f32(x * 0.5));
    const x3 = f32(f32(xp * 0.25) + f32(x * 0.75));
    this.xpR = x;
    let hp = 0, bp = this.bpR, lp = this.lpR;
    for (let s = 0; s < 4; s++) {
      const inp = s === 0 ? xp : s === 1 ? x1 : s === 2 ? x2 : x3;
      hp = f32(f32(inp - lp) - bp);
      hp = f32(hp + f32(c * Sfv4.nl(f32(bp * 4))));
      bp = f32(bp + f32(f * hp));
      lp = f32(lp + f32(f * bp));
    }
    this.hpR = hp; this.bpR = bp; this.lpR = lp;
    return f32(f32(f32(lp * this.mLP) + f32(hp * this.mHP)) + f32(bp * this.mBP));
  }
  reset(): void {
    this.xpL = this.hpL = this.bpL = this.lpL = 0;
    this.xpR = this.hpR = this.bpR = this.lpR = 0;
  }
  sane(): void {
    if (!(Math.abs(this.bpL) < 1e30) || !(Math.abs(this.lpL) < 1e30) || !(Math.abs(this.bpR) < 1e30) ||
      !(Math.abs(this.lpR) < 1e30)) this.reset();
    if (Math.abs(this.bpL) < 1e-30) this.bpL = 0;
    if (Math.abs(this.lpL) < 1e-30) this.lpL = 0;
    if (Math.abs(this.bpR) < 1e-30) this.bpR = 0;
    if (Math.abs(this.lpR) < 1e-30) this.lpR = 0;
  }
}

// ------------------------------------------------------------------------------------------- TMaxxMSFilter

/**
 * Lowpass 24 Alt: 4 cascaded one-pole lowpasses with global feedback k = 4.05 r, integrated exactly over
 * 4096 sub-steps per sample (zero-order-hold input, matrix doubled 12 times), state 0 soft-saturated
 * x/(1+x^2) once per sample, input biased by +0.35 and scaled 0.2, output DC-blocked (one-pole, 0.005).
 */
class Maxx {
  // A[r*4+c], B[r] (double)
  readonly A = new Float64Array(16);
  readonly B = new Float64Array(4);
  private readonly tA = new Float64Array(16);
  private readonly tB = new Float64Array(4);
  readonly sL = new Float64Array(4);
  readonly sR = new Float64Array(4);
  dcL = 0; dcR = 0;
  private lastFc = -1; private lastRes = -1; private lastSr = -1;
  set(sr: number, fc: number, res: number): void {
    if (fc === this.lastFc && res === this.lastRes && sr === this.lastSr) return;
    this.lastFc = fc; this.lastRes = res; this.lastSr = sr;
    const k = f32(res * 4.05);
    const fcc = fc > 20000 ? 20000 : fc;
    let a = f32(fcc * 6.25) / (sr * 4096);
    if (a < 0) a = 0;
    if (a > 1) a = 1;
    const b = 1 - a, nk = -k;
    const A = this.A, B = this.B;
    A.fill(0);
    // column 0 (s0)
    A[0] = b; A[4] = b * a; A[8] = b * a * a; A[12] = b * a * a * a;
    // column 1 (s1)
    A[5] = b; A[9] = b * a; A[13] = b * a * a;
    // column 2 (s2)
    A[10] = b; A[14] = b * a;
    // column 3 (s3)
    A[3] = nk * a; A[7] = nk * a * a; A[11] = nk * a * a * a; A[15] = b + nk * a * a * a * a;
    B[0] = a; B[1] = a * a; B[2] = a * a * a; B[3] = a * a * a * a;
    const tA = this.tA, tB = this.tB;
    for (let it = 0; it < 12; it++) {
      for (let j = 0; j < 4; j++) {
        for (let c = 0; c < 4; c++) {
          // new A[j][c] = ((A[0][c]*A[j][0] + A[1][c]*A[j][1]) + A[2][c]*A[j][2]) + A[3][c]*A[j][3]
          tA[j * 4 + c] = ((A[c] * A[j * 4] + A[4 + c] * A[j * 4 + 1]) + A[8 + c] * A[j * 4 + 2]) + A[12 + c] * A[j * 4 + 3];
        }
        tB[j] = (((B[0] * A[j * 4] + B[1] * A[j * 4 + 1]) + B[2] * A[j * 4 + 2]) + B[3] * A[j * 4 + 3]) + B[j];
      }
      A.set(tA); B.set(tB);
    }
  }
  private step(s: Float64Array, x: number): number {
    const A = this.A, B = this.B;
    const u = f32(f32(x + f32(0.35)) * f32(0.2));
    const s0 = s[0], s1 = s[1], s2 = s[2], s3 = s[3];
    const n0 = (((s0 * A[0] + s1 * A[1]) + s2 * A[2]) + s3 * A[3]) + u * B[0];
    const n1 = (((s0 * A[4] + s1 * A[5]) + s2 * A[6]) + s3 * A[7]) + u * B[1];
    const n2 = (((s0 * A[8] + s1 * A[9]) + s2 * A[10]) + s3 * A[11]) + u * B[2];
    const n3 = (((s0 * A[12] + s1 * A[13]) + s2 * A[14]) + s3 * A[15]) + u * B[3];
    s[0] = n0 / (1 + n0 * n0); s[1] = n1; s[2] = n2; s[3] = n3;
    return n3 / 0.20000000298023224;
  }
  tickL(x: number): number {
    const y = this.step(this.sL, x);
    this.dcL = this.dcL + (y - this.dcL) * 0.005;
    return f32(y - this.dcL);
  }
  tickR(x: number): number {
    const y = this.step(this.sR, x);
    this.dcR = this.dcR + (y - this.dcR) * 0.005;
    return f32(y - this.dcR);
  }
  reset(): void { this.sL.fill(0); this.sR.fill(0); this.dcL = 0; this.dcR = 0; }
  sane(): void {
    for (let i = 0; i < 4; i++) {
      if (!(Math.abs(this.sL[i]) < 1e30) || !(Math.abs(this.sR[i]) < 1e30)) { this.reset(); return; }
      if (Math.abs(this.sL[i]) < 1e-30) this.sL[i] = 0;
      if (Math.abs(this.sR[i]) < 1e-30) this.sR[i] = 0;
    }
    if (!(Math.abs(this.dcL) < 1e30) || !(Math.abs(this.dcR) < 1e30)) this.reset();
  }
}

// ------------------------------------------------------------------------------------------- TCombFilter

const COMB_SIZE = 16384;
const COMB_MASK = COMB_SIZE - 1;

/** Comb + (feed-forward, y = x + g x[n-D]) / Comb - (feedback, y = x + g y[n-1-D]); g = 0.95 r, D = 0.05 s * c. */
class Comb {
  readonly bufL = new Float32Array(COMB_SIZE);
  readonly bufR = new Float32Array(COMB_SIZE);
  wp = 0;
  g = 0; delay = 1;
  set(sr: number, cut: number, res: number): void {
    this.g = f32(res * 0.95);
    this.delay = f32(cut * sr * f32(0.05) + 1);
  }
  private read(buf: Float32Array, wp: number, d: number): number {
    const i = Math.trunc(d);
    const fr = f32(d - i);
    const a = buf[(wp - i) & COMB_MASK];
    const b = buf[(wp - i - 1) & COMB_MASK];
    return f32(f32(a * f32(1 - fr)) + f32(b * fr));
  }
  /** feedForward: Comb +; else Comb -. Processes one stereo sample, returns via outL/outR fields. */
  outL = 0; outR = 0;
  tick(xL: number, xR: number, feedForward: boolean): void {
    const d = this.delay, g = this.g;
    if (feedForward) {
      this.bufL[this.wp] = xL; this.bufR[this.wp] = xR;
      this.wp = (this.wp + 1) & COMB_MASK;
      this.outL = f32(xL + f32(this.read(this.bufL, this.wp, d) * g));
      this.outR = f32(xR + f32(this.read(this.bufR, this.wp, d) * g));
    } else {
      const yL = f32(xL + f32(this.read(this.bufL, this.wp, d) * g));
      const yR = f32(xR + f32(this.read(this.bufR, this.wp, d) * g));
      this.bufL[this.wp] = yL; this.bufR[this.wp] = yR;
      this.wp = (this.wp + 1) & COMB_MASK;
      this.outL = yL; this.outR = yR;
    }
  }
  reset(): void { this.bufL.fill(0); this.bufR.fill(0); this.wp = 0; }
}

// ------------------------------------------------------------------------------------------- TVowelFilter

const VOWEL_A = [250, 700, 2500, 3500, 4200, 8500, 10000, 12000];
const VOWEL_B = [700, 1250, 2500, 3500, 4200, 8500, 10000, 12000];
const VOWEL_C = [250, 2500, 2700, 3500, 4200, 8500, 10000, 12000];

/** RBJ band-pass (constant skirt gain, peak gain Q), float32 direct form I (FL TVowelBandPass). */
class VowelBP {
  b0 = 0; a1 = 0; a2 = 0;
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  lf = -1; lq = -1; lsr = -1;
  set(f: number, q: number, sr: number): void {
    if (f === this.lf && q === this.lq && sr === this.lsr) return;
    this.lf = f; this.lq = q; this.lsr = sr;
    const w = f * 6.28318530717959 / sr;
    const sn = Math.sin(w), cs = Math.cos(w);
    const b0 = f32(sn * 0.5);
    const a1 = f32(2 * cs);
    const q2 = f32(2 * q);
    const a2 = f32(1 - sn / q2);
    const n = 1 + sn / q2;
    this.b0 = f32(b0 / n); this.a1 = f32(a1 / n); this.a2 = f32(a2 / n);
  }
  tick(x: number): number {
    const y = f32(f32(f32(this.b0 * f32(x - this.x2)) + f32(this.a1 * this.y1)) - f32(this.a2 * this.y2));
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
  reset(): void { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  sane(): void {
    if (!(Math.abs(this.y1) < 1e30) || !(Math.abs(this.y2) < 1e30)) this.reset();
    if (Math.abs(this.y1) < 1e-30) this.y1 = 0;
    if (Math.abs(this.y2) < 1e-30) this.y2 = 0;
  }
}

/**
 * Vowel: 8 parallel RBJ band-passes (Q 12) at formant sets A/B/C morphed linearly by the cutoff
 * (A at c=0 and c=1, B at 1/3, C at 2/3), all scaled by 2^(1.7 (r - 0.5)); output 0.5 * g * sum, where
 * g = 1, 0.875, 0.75 in the three morph segments.
 */
class Vowel {
  readonly bpL: VowelBP[] = [];
  readonly bpR: VowelBP[] = [];
  gseg = 1;
  private lc = -1; private lr = -1; private lsr = -1;
  constructor() {
    for (let k = 0; k < 8; k++) { this.bpL.push(new VowelBP()); this.bpR.push(new VowelBP()); }
  }
  set(srF: number, cut: number, res: number): void {
    if (cut === this.lc && res === this.lr && srF === this.lsr) return;
    this.lc = cut; this.lr = res; this.lsr = srF;
    const shift = f32(Math.pow(2, f32(res - 0.5) * 1.7));
    const pos = f32(cut * 3);
    let seg = Math.trunc(pos);
    const fr = f32(pos - seg);
    if (seg >= 3) seg = 0;
    let wA = 0, wB = 0, wC = 0;
    if (seg === 0) { wA = f32(1 - fr); wB = fr; }
    else if (seg === 1) { wB = f32(1 - fr); wC = fr; }
    else { wC = f32(1 - fr); wA = fr; }
    this.gseg = f32(1 - f32(seg * 0.125));
    // guard: FL has no clamp; a formant at or above Nyquist (only possible below ~43.3 kHz) would be unstable
    const fmax = f32(srF * 0.4999);
    for (let k = 0; k < 8; k++) {
      let f = f32(f32(f32(f32(wA * VOWEL_A[k]) + f32(wB * VOWEL_B[k])) + f32(wC * VOWEL_C[k])) * shift);
      if (f > fmax) f = fmax;
      this.bpL[k].set(f, 12, srF);
      this.bpR[k].set(f, 12, srF);
    }
  }
  outL = 0; outR = 0;
  tick(xL: number, xR: number): void {
    const g = this.gseg;
    let aL = 0, aR = 0;
    for (let k = 0; k < 8; k++) {
      aL = f32(aL + f32(this.bpL[k].tick(xL) * g));
      aR = f32(aR + f32(this.bpR[k].tick(xR) * g));
    }
    this.outL = f32(aL * 0.5);
    this.outR = f32(aR * 0.5);
  }
  reset(): void { for (let k = 0; k < 8; k++) { this.bpL[k].reset(); this.bpR[k].reset(); } }
  sane(): void { for (let k = 0; k < 8; k++) { this.bpL[k].sane(); this.bpR[k].sane(); } }
}

// ------------------------------------------------------------------------------------------- TPhaser

const PH_QTAB = [3.0, 1.6, 0.832, 0.5, 0.35].map((v) => f32(v));
const PH_LFOTAB = [576.29, 26.96, 8.88, 4.0, 1.84, 0.88, 0.4, 0.147, 0.02, 1.0].map((v) => f32(v));

/** round to nearest, ties to even (ARM frintx in the default rounding mode) */
function rintEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x - Math.trunc(x)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

function phInterp(tab: number[], x: number): number {
  const i = Math.trunc(x);
  const fr = f32(x - i);
  const b = i + 1 < tab.length ? tab[i + 1] : tab[i];
  return f32(f32(tab[i] * f32(1 - fr)) + f32(b * fr));
}

/**
 * FL TPhaser as configured by the three Distructor phaser presets: N identical SVF all-pass stages
 * (f = 28.5 Hz * 2^(9.269 c), k = 1/interp([3, 1.6, 0.832, 0.5, 0.35], 4 r)), feedback of stage fbTap's
 * output into the chain input (coefficient +-0.728, one-sample delay), output taken after stage outTap
 * (fully wet), then a bilinear one-pole high-pass (16.8 Hz / 10 Hz). Phaser 2 also has a 576 s triangle LFO
 * (depth 0.2125) on the sweep.
 */
class Phaser {
  readonly coef = new SvfCoef();
  readonly stL: SvfState[] = [];
  readonly stR: SvfState[] = [];
  readonly hp = new OnePole();
  nst = 5; outTap = 3; fbTap = 4; fb = 0; depth = 0; hpFreq = 10;
  lfoPhase = 0; lfoInc = 0; lfoPeriod = 576.29;
  fbL = 0; fbR = 0;
  piOverSr = 0;
  fMax = 22000;
  private lastFreq = -1; private lastQ = -1;
  private cut = 0.5; private res = 0.5;
  constructor(type: number) {
    for (let i = 0; i < 6; i++) { this.stL.push(new SvfState()); this.stR.push(new SvfState()); }
    // preset tables (14 params) from the binary; only the ones that affect the sound are used
    const P = type === 0 ? [1, 0, 0.462, 0.436, 0, 0.5, 0, 0, 1, 0, 0.839, 0.19, 0, 0.63]
      : type === 1 ? [1, 0, 0.5065, 0.4166, 1, 0.5, 0.25, 0, 1, 0, 0.5, 0.19, 0, 0.459]
        : [1, 0, 0.5, 1, 0, 0.5, 0, 0, 1, 0, 0.37, 0, 1, 1];
    const p = P.map((v) => f32(v));
    const st = Math.min(6, Math.max(1, rintEven(Math.min(1, Math.max(0, p[3])) * 6) + 1));
    this.outTap = st - 1;
    this.fbTap = Math.min(5, Math.max(0, rintEven(Math.min(1, Math.max(0, p[13])) * 6)));
    this.nst = Math.max(4, this.fbTap + 1);
    this.fb = f32(f32(-0.728) + f32(f32(f32(2) * f32(0.728)) * p[4]));
    this.depth = f32(p[6] * 0.85);
    const v = p[11];
    this.hpFreq = f32(10 + f32(f32(f32(v * v) * v) * 990));
    this.lfoPeriod = phInterp(PH_LFOTAB, f32(p[1] * 7.99999));
  }
  setSampleRate(sr: number): void {
    this.piOverSr = f32(PI / sr);
    this.fMax = 0.4999 * sr;
    this.lastFreq = -1;
    this.lfoInc = f32(1 / f32(this.lfoPeriod * f32(sr)));
    this.hp.set(f32(PI * (1 / sr)), this.hpFreq, false);
  }
  set(cut: number, res: number): void { this.cut = cut; this.res = res; }
  /** processes one stereo sample in place via outL/outR */
  outL = 0; outR = 0;
  tick(xL: number, xR: number): void {
    const q = phInterp(PH_QTAB, f32(this.res * 3.9999));
    // triangle LFO (float32 phase accumulator, phase offset 0); only Phaser 2 has depth
    let ph = f32(this.lfoPhase + this.lfoInc);
    ph = f32(ph - Math.trunc(ph));
    this.lfoPhase = ph;
    const tri = this.depth === 0 ? 0 : ph < 0.5 ? f32(ph * 2) : f32(2 - f32(ph * 2));
    const base = this.cut;
    const sweep = f32(base + f32(f32(f32(1 - base) * tri) * this.depth));
    let fq = 28.5 * Math.pow(2, f32(f32(sweep * 0.925) * f32(10.020833)));
    if (fq > 22000) fq = 22000;
    if (fq > this.fMax) fq = this.fMax; // guard: FL is unstable above Nyquist (internal rates < 44 kHz only)
    const freq = f32(fq);
    if (freq !== this.lastFreq || q !== this.lastQ) {
      this.lastFreq = freq; this.lastQ = q;
      this.coef.set(this.piOverSr, freq, f32(1 / q), 1, 8);
    }
    const c = this.coef, n = this.nst, ot = this.outTap, ft = this.fbTap;
    let x = f32(xL + f32(this.fbL * this.fb));
    let out = 0;
    for (let i = 0; i < n; i++) {
      x = this.stL[i].tick(c, x);
      if (i === ot) out = x;
      if (i === ft) this.fbL = x;
    }
    this.outL = this.hp.tickL(out);
    x = f32(xR + f32(this.fbR * this.fb));
    out = 0;
    for (let i = 0; i < n; i++) {
      x = this.stR[i].tick(c, x);
      if (i === ot) out = x;
      if (i === ft) this.fbR = x;
    }
    this.outR = this.hp.tickR(out);
  }
  reset(): void {
    for (let i = 0; i < 6; i++) { this.stL[i].reset(); this.stR[i].reset(); }
    this.hp.reset(); this.fbL = 0; this.fbR = 0;
  }
  sane(): void {
    if (!(Math.abs(this.fbL) < 1e30) || !(Math.abs(this.fbR) < 1e30)) this.reset();
    for (let i = 0; i < 6; i++) { this.stL[i].sane(); this.stR[i].sane(); }
    this.hp.sane();
    if (Math.abs(this.fbL) < 1e-30) this.fbL = 0;
    if (Math.abs(this.fbR) < 1e-30) this.fbR = 0;
  }
}

// ------------------------------------------------------------------------------------------- DxFilter

/** One Distructor filter module (stereo, in place). */
export class DxFilter {
  private sr = 44100;
  private piOverSr = f32(PI / 44100);
  private piOverSrOP = f32(PI * (1 / 44100));
  private invSrF = f32(1 / f32(44100));
  private srF = f32(44100);
  private fMax = 0.4999 * 44100;
  private bad = false;
  private dirty = true;
  private lastC = -1;
  private lastR = -1;
  private lastRaw = -1;
  private model = 2;
  private cutN = 0.5;
  private resN = 0.5;
  private smooth = false;
  // FL TFilterProcessor parameter smoother (normalised cutoff / resonance)
  private smCut = 0.5;
  private smCutT = 0.5;
  private smRes = 0.5;
  private smResT = 0.5;
  private smC = 0;
  private readonly svf = new SvfCoef();
  private readonly svfL = new SvfState();
  private readonly svfR = new SvfState();
  private readonly s24 = new SvfCoef();
  private readonly s24L1 = new SvfState();
  private readonly s24R1 = new SvfState();
  private readonly s24L2 = new SvfState();
  private readonly s24R2 = new SvfState();
  private readonly op = new OnePole();
  private readonly sfv = new Sfv4();
  private readonly maxx = new Maxx();
  private readonly comb = new Comb();
  private readonly vowel = new Vowel();
  private readonly ph: Phaser[] = [new Phaser(0), new Phaser(1), new Phaser(2)];

  constructor(sampleRate: number) {
    this.setSampleRate(sampleRate);
  }

  /** Internal (module) sample rate. All coefficients are recomputed for it, as FL does. */
  setSampleRate(sampleRate: number): void {
    const sr = sampleRate > 1000 ? sampleRate : 1000;
    this.sr = sr;
    this.piOverSr = f32(PI / sr);
    this.piOverSrOP = f32(PI * (1 / sr));
    this.srF = f32(sr);
    this.invSrF = f32(1 / this.srF);
    this.fMax = 0.4999 * sr;
    this.dirty = true;
    this.smC = dxFilterSmoothingCoef(sr);
    for (let i = 0; i < 3; i++) this.ph[i].setSampleRate(sr);
  }

  /** model 0..21, cutoff/resonance raw 0..10000, smooth = module smoothing switch. */
  set(model: number, cutoffRaw: number, resRaw: number, smooth: boolean): void {
    let m = Math.round(model);
    if (!(m >= 0)) m = 0;
    if (m > 21) m = 21;
    this.model = m;
    this.cutN = dxFilterNorm(cutoffRaw);
    this.resN = dxFilterNorm(resRaw);
    this.smCutT = this.cutN;
    this.smResT = this.resN;
    this.smooth = smooth;
    this.dirty = true;
  }

  /**
   * A new FL filter processor: clears all filter states (delay lines, integrators) and
   * restarts the smoother at FL's constructor values (c = r = 0.5), so the next blocks
   * glide from there (smooth on) or jump at the next block (smooth off), as FL does after
   * a module is created or loaded.
   */
  reset(): void {
    this.svfL.reset(); this.svfR.reset();
    this.s24L1.reset(); this.s24R1.reset(); this.s24L2.reset(); this.s24R2.reset();
    this.op.reset(); this.sfv.reset(); this.maxx.reset(); this.comb.reset(); this.vowel.reset();
    for (let i = 0; i < 3; i++) this.ph[i].reset();
    this.smCut = 0.5; this.smRes = 0.5;
  }

  /** clears the states used by the current model (after a non-finite / runaway output) */
  private resetModel(): void {
    switch (this.model) {
      case 0: case 1: this.op.reset(); break;
      case 5: case 6: this.s24L1.reset(); this.s24R1.reset(); this.s24L2.reset(); this.s24R2.reset(); break;
      case 8: case 9: case 10: this.sfv.reset(); break;
      case 11: this.maxx.reset(); break;
      case 13: case 14: this.comb.reset(); break;
      case 15: this.vowel.reset(); break;
      case 16: case 17: case 18: this.ph[this.model - 16].reset(); break;
      default: this.svfL.reset(); this.svfR.reset(); break;
    }
  }

  private tickSmoother(): void {
    if (this.smCut !== this.smCutT) {
      let c = f32(this.smCut + f32(this.smCutT - this.smCut) * this.smC);
      if (Math.abs(f32(c - this.smCutT)) < 1e-4) c = this.smCutT;
      this.smCut = c;
    }
    if (this.smRes !== this.smResT) {
      let r = f32(this.smRes + f32(this.smResT - this.smRes) * this.smC);
      if (Math.abs(f32(r - this.smResT)) < 1e-4) r = this.smResT;
      this.smRes = r;
    }
  }

  /** sets the coefficients of the current model from normalised cut (c) and resonance (r); rawRes for SVF k. */
  private coefs(c: number, r: number, rawRes: number): void {
    const m = this.model;
    const fc = dxFilterCutoffHzNorm(c);
    // guard for the bilinear designs: FL has no clamp and blows up when the cutoff passes Nyquist
    // (possible only for internal rates below 40.96 kHz); identical to FL everywhere else
    const fb = fc < this.fMax ? fc : f32(this.fMax);
    switch (m) {
      case 0: case 1: this.op.set(this.piOverSrOP, fb, m === 0); break;
      case 2: case 3: case 4: case 12: case 21: {
        const k = f32(1 - 0.99 * rawRes);
        const mode = m === 2 ? 0 : m === 3 ? 1 : m === 4 ? 2 : m === 12 ? 4 : 8;
        this.svf.set(this.piOverSr, fb, k, 1, mode);
        break;
      }
      case 7: this.svf.set(this.piOverSr, fb, f32(1 - 0.792 * rawRes), 1, 3); break;
      case 19: case 20: {
        const gain = f32(-20 + f32(40 * rawRes));
        this.svf.set(this.piOverSr, fb, 1, gain, m === 19 ? 6 : 7);
        break;
      }
      case 5: case 6: {
        const k12 = f32(1 - 0.99 * r);
        const k = f32(2 * f32(1 / f32(Math.sqrt(f32(1 / k12)))));
        this.s24.set(this.piOverSr, fb, k, 1, m === 5 ? 0 : 1);
        break;
      }
      case 8: case 9: case 10:
        this.sfv.set(this.invSrF, fc, r);
        this.sfv.mLP = m === 8 ? 1 : 0; this.sfv.mBP = m === 9 ? 1 : 0; this.sfv.mHP = m === 10 ? 1 : 0;
        break;
      case 11: this.maxx.set(this.sr, fc, r); break;
      case 13: case 14: this.comb.set(this.sr, c, r); break;
      case 15: this.vowel.set(this.srF, c, r); break;
      case 16: case 17: case 18: this.ph[m - 16].set(c, r); break;
      default: break;
    }
  }

  private tick(L: Float32Array | Float64Array, R: Float32Array | Float64Array, i: number): void {
    let xl = f32(L[i]);
    let xr = f32(R[i]);
    if (!(Math.abs(xl) < 1e30)) xl = 0;
    if (!(Math.abs(xr) < 1e30)) xr = 0;
    let yl: number, yr: number;
    switch (this.model) {
      case 0: case 1: yl = this.op.tickL(xl); yr = this.op.tickR(xr); break;
      case 2: case 3: case 4: case 7: case 12: case 19: case 20: case 21:
        yl = this.svfL.tick(this.svf, xl); yr = this.svfR.tick(this.svf, xr); break;
      case 5: case 6:
        yl = this.s24L2.tick(this.s24, this.s24L1.tick(this.s24, xl));
        yr = this.s24R2.tick(this.s24, this.s24R1.tick(this.s24, xr));
        break;
      case 8: case 9: case 10: yl = this.sfv.tickL(xl); yr = this.sfv.tickR(xr); break;
      case 11: yl = this.maxx.tickL(xl); yr = this.maxx.tickR(xr); break;
      case 13: case 14: this.comb.tick(xl, xr, this.model === 13); yl = this.comb.outL; yr = this.comb.outR; break;
      case 15: this.vowel.tick(xl, xr); yl = this.vowel.outL; yr = this.vowel.outR; break;
      default: { const p = this.ph[this.model - 16]; p.tick(xl, xr); yl = p.outL; yr = p.outR; break; }
    }
    if (!(Math.abs(yl) < 1e30)) { yl = 0; this.bad = true; }
    if (!(Math.abs(yr) < 1e30)) { yr = 0; this.bad = true; }
    L[i] = yl;
    R[i] = yr;
  }

  /** Processes n stereo samples in place. Allocation-free. */
  process(L: Float32Array | Float64Array, R: Float32Array | Float64Array, n: number): void {
    if (!this.smooth) {
      this.dirty = true;
      this.coefs(this.cutN, this.resN, this.resN);
      for (let i = 0; i < n; i++) this.tick(L, R, i);
    } else {
      for (let i = 0; i < n; i++) {
        this.tickSmoother();
        // FL recomputes the coefficients every sample here; they only change while the smoother moves
        // (the plain SVF models smooth only the cutoff: FL reads the raw resonance there)
        if (this.smCut !== this.lastC || this.smRes !== this.lastR || this.resN !== this.lastRaw || this.dirty) {
          this.lastC = this.smCut; this.lastR = this.smRes; this.lastRaw = this.resN; this.dirty = false;
          this.coefs(this.smCut, this.smRes, this.resN);
        }
        this.tick(L, R, i);
      }
    }
    this.sanitize();
  }

  private sanitize(): void {
    if (this.bad) { this.bad = false; this.resetModel(); return; }
    switch (this.model) {
      case 0: case 1: this.op.sane(); break;
      case 5: case 6: this.s24L1.sane(); this.s24R1.sane(); this.s24L2.sane(); this.s24R2.sane(); break;
      case 8: case 9: case 10: this.sfv.sane(); break;
      case 11: this.maxx.sane(); break;
      case 15: this.vowel.sane(); break;
      case 16: case 17: case 18: this.ph[this.model - 16].sane(); break;
      case 13: case 14: break;
      default: this.svfL.sane(); this.svfR.sane(); break;
    }
  }
}
