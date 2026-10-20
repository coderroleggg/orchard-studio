/*
 * dxmisc.ts - FL Studio "Distructor" distortion module, models 14..17:
 *   14 Wave folder, 15 Aperture, 16 Abrasive, 17 Crusher
 * plus exact value-text formatters for their parameters.
 *
 * Derived from measurements of FL Studio 2026's real plugin (flfxhost) and from the
 * disassembly of Distructor/module/module_x64.dylib. Every model is reproduced
 * sample-exactly when fed the same float32 input (see dxmisc_notes.txt):
 *   - waveFold / aperture : static curves, bit-identical to FL (FL computes in double from
 *     float inputs, single-precision parameter maths; replicated with Math.fround).
 *     WaveFolderProc / ApertureProc add FL's block-wise handling of crossover/asymmetry
 *     changes (a one-block wrong-direction overshoot), also bit-identical.
 *   - Abrasive            : FL's own Mersenne-Twister port (seed 19650218, with FL's twist
 *     off-by-one) + float32 linear-trapezoid SVF band-pass; bit-identical from reset().
 *   - Crusher             : fractional phase-accumulator sample-and-hold (no jitter) followed
 *     by a truncating quantiser; bit-identical.
 *
 * Raw parameters are FL's integer knob positions, indexed by the module parameter index
 * (6..9 Wave folder, 10..15 Aperture, 28..33 Abrasive, 34..35 Crusher). Pass the module's
 * 49-entry raw array, or any object with those numeric keys; missing keys take FL defaults.
 *
 * Scope: only the model itself. Distructor's module input gain, dry/wet mix, output gain,
 * DC remover ("center") and oversampling are applied around these by the caller. When the
 * module is oversampled, construct Abrasive/Crusher with the oversampled rate (sr * factor),
 * as FL does.
 *
 * Self-contained, no imports, strict-mode clean, allocation-free in processing.
 */

const fr = Math.fround;

/** Raw parameter record: module parameter index -> raw integer value. */
export type RawParams = { readonly [index: number]: number | undefined };

const MAX_IN = 1e30; // input clamp for non-finite / absurd inputs (keeps every path finite)

function clampRaw(v: number | undefined, def: number, lo: number, hi: number): number {
  if (v === undefined || v !== v) return def;
  const r = Math.round(v);
  return r < lo ? lo : r > hi ? hi : r;
}

function rawAt(p: RawParams, i: number, def: number, lo: number, hi: number): number {
  return clampRaw(p[i], def, lo, hi);
}

/** float32 input conditioning: NaN -> 0, +-Inf/huge -> +-1e30, then float32 rounding. */
function inF32(x: number): number {
  if (x !== x) return 0;
  if (x > MAX_IN) return fr(MAX_IN);
  if (x < -MAX_IN) return fr(-MAX_IN);
  return fr(x);
}

function sgn(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/* ------------------------------------------------------------------------------------ */
/* Shared pre-processing of Wave folder / Aperture: asymmetry offset then crossover.     */
/*   a = x + sx            sx = raw_asym/5000 - 1   (float32, range -1..1)              */
/*   b = a + sign(a) * cx  cx = raw_cross/5000 - 1  (sign(0) = 0 -> b = 0)               */
/* Both offsets are applied in input units, i.e. BEFORE the pre-amp gain.               */
/* ------------------------------------------------------------------------------------ */

function preOffsets(x: number, sx: number, cx: number): number {
  const a = fr(inF32(x) + sx);
  return a > 0 ? fr(a + cx) : a < 0 ? fr(a - cx) : 0;
}

/* ------------------------------------------------------------------------------------ */
/* 14  Wave folder                                                                       */
/* ------------------------------------------------------------------------------------ */

export interface FoldCoefs {
  g: number; // pre-amp gain = 1 + raw6/500           (float32)
  T: number; // threshold    = 0.1 + 0.9*raw9/10000   (double)
  sx: number; // asymmetry offset (float32)
  cx: number; // crossover offset (float32)
}

export function waveFoldCoefs(p: RawParams, out?: FoldCoefs): FoldCoefs {
  const pre = rawAt(p, 6, 500, 0, 10000);
  const cross = rawAt(p, 7, 5000, 0, 10000);
  const asym = rawAt(p, 8, 5000, 0, 10000);
  const thr = rawAt(p, 9, 10000, 0, 10000);
  const c: FoldCoefs = out !== undefined ? out : { g: 1, T: 1, sx: 0, cx: 0 };
  c.g = fr(1 + fr(pre / 500));
  c.T = (thr * 0.9) / 10000 + 0.1;
  c.sx = fr(fr(asym / 5000) - 1);
  c.cx = fr(fr(cross / 5000) - 1);
  return c;
}

/** Wave folder with precomputed coefficients: y = T*tri(g*b/T), tri = unit triangle, period 4. */
export function waveFoldWith(x: number, c: FoldCoefs): number {
  const b = preOffsets(x, c.sx, c.cx);
  const v = c.g * b;
  const T = c.T;
  let ph = (Math.abs(v) * 0.25) / T;
  ph = ph - Math.trunc(ph);
  let r: number;
  if (ph < 0.25) r = ph * 4;
  else if (ph < 0.75) r = 1 - (ph - 0.25) * 4;
  else r = -1 + (ph - 0.75) * 4;
  return fr(v < 0 ? -r * T : r * T);
}

const foldTmp: FoldCoefs = { g: 1, T: 1, sx: 0, cx: 0 };

/** Wave folder, one sample. p = raw params (indices 6..9). */
export function waveFold(x: number, p: RawParams): number {
  return waveFoldWith(x, waveFoldCoefs(p, foldTmp));
}

/** In-place block version (coefficients computed once). */
export function waveFoldBlock(L: Float32Array | Float64Array, R: Float32Array | Float64Array, n: number, p: RawParams): void {
  const c = waveFoldCoefs(p, foldTmp);
  for (let i = 0; i < n; i++) {
    L[i] = waveFoldWith(L[i]!, c);
    R[i] = waveFoldWith(R[i]!, c);
  }
}

/* ------------------------------------------------------------------------------------ */
/* 15  Aperture                                                                          */
/*   v = g*b, T = 0.5 + 0.5*raw13/10000, warp point P = 1 - 2*raw14/10000 (absolute level) */
/*   |v| <= T : y = v                                                                    */
/*   mode A   : y = fmod(v, T) + P - T     (C fmod; the offset P-T is the same on both    */
/*              signs, so the curve is not odd-symmetric)                                */
/*   mode B   : odd wrap of |v| into (P, T]: up to 8 subtractions of (T - P); if still     */
/*              above T after 8 steps, clip to +-T (T - P <= 0 -> hard clip at +-T)       */
/* ------------------------------------------------------------------------------------ */

export interface ApertureCoefs {
  g: number; // pre-amp gain (float32)
  T: number; // threshold (float32)
  d9: number; // 2*warp - 1 = -P (float32)
  modeA: boolean;
  sx: number;
  cx: number;
}

export function apertureCoefs(p: RawParams, out?: ApertureCoefs): ApertureCoefs {
  const pre = rawAt(p, 10, 500, 0, 10000);
  const cross = rawAt(p, 11, 5000, 0, 10000);
  const asym = rawAt(p, 12, 5000, 0, 10000);
  const thr = rawAt(p, 13, 10000, 0, 10000);
  const warp = rawAt(p, 14, 2000, 0, 10000);
  const mode = rawAt(p, 15, 0, 0, 1);
  const c: ApertureCoefs = out !== undefined ? out : { g: 1, T: 1, d9: 0, modeA: true, sx: 0, cx: 0 };
  c.g = fr(1 + fr(pre / 500));
  c.T = fr(fr(fr(thr * 0.5) / 10000) + 0.5);
  c.d9 = fr(fr((2 * warp) / 10000) - 1);
  c.modeA = mode === 0;
  c.sx = fr(fr(asym / 5000) - 1);
  c.cx = fr(fr(cross / 5000) - 1);
  return c;
}

export function apertureWith(x: number, c: ApertureCoefs): number {
  const b = preOffsets(x, c.sx, c.cx);
  const T = c.T;
  let v = c.g * b;
  if (c.modeA) {
    if (Math.abs(v) > T) {
      v = v - T * Math.trunc(v / T);
      v = v - (T + c.d9);
    }
    return fr(v);
  }
  const band = T + c.d9;
  let k = 0;
  while (Math.abs(v) > T) {
    v = sgn(v) * (Math.abs(v) - band);
    k++;
    if (k >= 8) {
      if (Math.abs(v) > T) v = sgn(v) * T;
      break;
    }
  }
  return fr(v);
}

const apeTmp: ApertureCoefs = { g: 1, T: 1, d9: 0, modeA: true, sx: 0, cx: 0 };

/** Aperture, one sample. p = raw params (indices 10..15). */
export function aperture(x: number, p: RawParams): number {
  return apertureWith(x, apertureCoefs(p, apeTmp));
}

export function apertureBlock(L: Float32Array | Float64Array, R: Float32Array | Float64Array, n: number, p: RawParams): void {
  const c = apertureCoefs(p, apeTmp);
  for (let i = 0; i < n; i++) {
    L[i] = apertureWith(L[i]!, c);
    R[i] = apertureWith(R[i]!, c);
  }
}

/* ------------------------------------------------------------------------------------ */
/* Stateful block processors for Wave folder / Aperture that also reproduce FL's handling  */
/* of crossover/asymmetry changes. FL feeds both offsets through a TSmoothedParameter whose */
/* block routine is effectively a one-block extrapolation: for the first block processed    */
/* after a change the offset used is  old + f*(old - new)  (i.e. it overshoots in the WRONG */
/* direction by ~the step size), from the next block on it is exactly the new value;       */
/* f = float(exp(ln(0.01) / (0.015 * sampleRate)))  (0.99306 at 44.1 kHz) - a 15 ms        */
/* per-sample coefficient misused once per block. Pre amp, threshold, warp and mode are    */
/* not smoothed (they take effect at the next block). Call process() once per host block  */
/* (FL's glitch lasts exactly one block). Pass flSmoothing = false for plain jumps.        */
/* ------------------------------------------------------------------------------------ */

function offsetSmoothCoef(sampleRate: number): number {
  const sr = sampleRate > 0 && sampleRate < 1e7 ? sampleRate : 44100;
  return fr(Math.exp(Math.log(0.01) / (15 * 0.001 * sr)));
}

function smoothStep(old: number, target: number, f: number): number {
  return fr(fr(f * fr(old - target)) + old);
}

export class WaveFolderProc {
  private readonly tgt: FoldCoefs = { g: 1, T: 1, sx: 0, cx: 0 };
  private readonly eff: FoldCoefs = { g: 1, T: 1, sx: 0, cx: 0 };
  private f = 0;
  private sxOld = 0;
  private cxOld = 0;
  private readonly flSmoothing: boolean;

  constructor(sampleRate: number, flSmoothing = true) {
    this.flSmoothing = flSmoothing;
    this.setSampleRate(sampleRate);
    this.set({});
  }

  setSampleRate(sampleRate: number): void {
    this.f = offsetSmoothCoef(sampleRate);
  }

  /** p = raw params, indices 6..9. */
  set(p: RawParams): void {
    waveFoldCoefs(p, this.tgt);
  }

  /** A new FL processor: the smoothed offsets restart from their constructor values (0). */
  reset(): void {
    this.sxOld = 0;
    this.cxOld = 0;
  }

  process(L: Float32Array | Float64Array, R: Float32Array | Float64Array, n: number): void {
    const t = this.tgt, e = this.eff;
    e.g = t.g;
    e.T = t.T;
    e.sx = this.flSmoothing ? smoothStep(this.sxOld, t.sx, this.f) : t.sx;
    e.cx = this.flSmoothing ? smoothStep(this.cxOld, t.cx, this.f) : t.cx;
    this.sxOld = t.sx;
    this.cxOld = t.cx;
    for (let i = 0; i < n; i++) {
      L[i] = waveFoldWith(L[i]!, e);
      R[i] = waveFoldWith(R[i]!, e);
    }
  }
}

export class ApertureProc {
  private readonly tgt: ApertureCoefs = { g: 1, T: 1, d9: 0, modeA: true, sx: 0, cx: 0 };
  private readonly eff: ApertureCoefs = { g: 1, T: 1, d9: 0, modeA: true, sx: 0, cx: 0 };
  private f = 0;
  private sxOld = 0;
  private cxOld = 0;
  private readonly flSmoothing: boolean;

  constructor(sampleRate: number, flSmoothing = true) {
    this.flSmoothing = flSmoothing;
    this.setSampleRate(sampleRate);
    this.set({});
  }

  setSampleRate(sampleRate: number): void {
    this.f = offsetSmoothCoef(sampleRate);
  }

  /** p = raw params, indices 10..15. */
  set(p: RawParams): void {
    apertureCoefs(p, this.tgt);
  }

  /** A new FL processor: the smoothed offsets restart from their constructor values (0). */
  reset(): void {
    this.sxOld = 0;
    this.cxOld = 0;
  }

  process(L: Float32Array | Float64Array, R: Float32Array | Float64Array, n: number): void {
    const t = this.tgt, e = this.eff;
    e.g = t.g;
    e.T = t.T;
    e.d9 = t.d9;
    e.modeA = t.modeA;
    e.sx = this.flSmoothing ? smoothStep(this.sxOld, t.sx, this.f) : t.sx;
    e.cx = this.flSmoothing ? smoothStep(this.cxOld, t.cx, this.f) : t.cx;
    this.sxOld = t.sx;
    this.cxOld = t.cx;
    for (let i = 0; i < n; i++) {
      L[i] = apertureWith(L[i]!, e);
      R[i] = apertureWith(R[i]!, e);
    }
  }
}

/* ------------------------------------------------------------------------------------ */
/* 16  Abrasive ("noise modulation distortion")                                          */
/*   per sample, one noise value n shared by L and R:                                    */
/*   y = clip1( post * ( (1-mix)*pre*x + mix*pre*|x|*[|x| > gate]*n ) )                  */
/*   pre = 1 + raw28/5000, gate = raw29/10000 (instantaneous compare on the input before   */
/*   pre-amp, no envelope follower), mix = raw30/10000, post = 1 + raw31/5000,           */
/*   clip1 = hard clip to [-1, 1].                                                       */
/*   n = uniform noise in [-1,1) from FL's Mersenne Twister; with "Filter" on it is      */
/*   band-passed by a linear-trapezoid SVF: fc = 20*2^(raw32/1000) Hz, k = 0.505          */
/*   (Q = 1.98), output = band (peak gain 1/k = +5.9 dB). The RNG and filter only run     */
/*   while mix != 0.                                                                     */
/* ------------------------------------------------------------------------------------ */

export class Abrasive {
  private sr = 44100;
  private piOverSr = 0;
  private readonly mt = new Uint32Array(624);
  private mti = 625;
  private ic1 = 0;
  private ic2 = 0;
  private pre = 1;
  private gate = 0;
  private mix = 0;
  private post = 1;
  private bpRaw = 8400;
  private filterOn = false;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;

  constructor(sampleRate: number) {
    this.setSampleRate(sampleRate);
    this.reset();
    this.set({});
  }

  setSampleRate(sampleRate: number): void {
    this.sr = sampleRate > 0 && sampleRate < 1e7 ? sampleRate : 44100;
    this.piOverSr = fr(Math.PI / this.sr);
    this.updateFilter();
  }

  /** p: raw params, indices 28 pre amp, 29 gate thresh, 30 dry/wet, 31 post gain, 32 noise bp, 33 filter. */
  set(p: RawParams): void {
    this.setRaw(
      rawAt(p, 28, 2000, 0, 10000),
      rawAt(p, 29, 5000, 0, 10000),
      rawAt(p, 30, 2000, 0, 10000),
      rawAt(p, 31, 5000, 0, 10000),
      rawAt(p, 32, 8400, 0, 10000),
      rawAt(p, 33, 0, 0, 1),
    );
  }

  setRaw(preAmp: number, gateThresh: number, dryWet: number, postGain: number, noiseBp: number, filter: number): void {
    this.pre = fr(1 + fr(preAmp / 5000));
    this.gate = fr(gateThresh / 10000);
    this.mix = fr(dryWet / 10000);
    this.post = fr(1 + fr(postGain / 5000));
    this.bpRaw = noiseBp;
    this.filterOn = filter === 1;
    this.updateFilter();
  }

  /** Re-seeds the noise generator (FL does this when the module is created) and clears the filter. */
  reset(): void {
    this.seed(19650218);
    this.ic1 = 0;
    this.ic2 = 0;
  }

  private updateFilter(): void {
    const f = fr(20 * Math.pow(2, this.bpRaw / 1000));
    const k = fr(1 - 0.99 * 0.5);
    let w = fr(f * this.piOverSr);
    if (w > 1.5707) w = 1.5707; // only reachable below ~41 kHz with raw32 near max; keeps tan finite
    const g = fr(Math.tan(w));
    this.a1 = fr(1 / fr(1 + fr(g * fr(g + k))));
    this.a2 = fr(g * this.a1);
    this.a3 = fr(g * this.a2);
  }

  private seed(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) {
      const prev = mt[i - 1]!;
      mt[i] = (Math.imul(1812433253, (prev ^ (prev >>> 30)) >>> 0) + i) >>> 0;
    }
    this.mti = 624;
  }

  /** FL's MT19937 port: identical to the reference except the 2nd twist loop starts at 226
   *  and reads mt[-1], which in FL's object layout is the index field (624). */
  private nextU32(): number {
    const mt = this.mt;
    if (this.mti >= 624) {
      if (this.mti === 625) this.seed(5489);
      let y = 0;
      for (let kk = 0; kk <= 226; kk++) {
        y = (mt[kk]! & 0x80000000) | (mt[kk + 1]! & 0x7fffffff);
        mt[kk] = mt[kk + 397]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      for (let kk = 226; kk < 623; kk++) {
        y = (mt[kk]! & 0x80000000) | (mt[kk + 1]! & 0x7fffffff);
        const back = kk >= 227 ? mt[kk - 227]! : this.mti;
        mt[kk] = back ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      y = (mt[623]! & 0x80000000) | (mt[0]! & 0x7fffffff);
      mt[623] = mt[396]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      this.mti = 0;
    }
    let y = mt[this.mti++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  private chan(xIn: number, nz: number, wet: boolean): number {
    const x = inF32(xIn);
    const d0 = x * this.pre;
    let d3: number;
    if (wet) {
      const mask = Math.abs(x) > this.gate ? sgn(x) : 0;
      const d4 = d0 * this.mix * mask * nz;
      d3 = this.post * (d0 * (1 - this.mix) + d4);
    } else {
      d3 = this.post * d0;
    }
    const a = Math.abs(d3);
    return fr(sgn(d3) * (a >= 1 ? 1 : a));
  }

  process(L: Float32Array | Float64Array, R: Float32Array | Float64Array, n: number): void {
    const wet = this.mix !== 0;
    const filt = wet && this.filterOn;
    const a1 = this.a1, a2 = this.a2, a3 = this.a3;
    let ic1 = this.ic1, ic2 = this.ic2;
    for (let i = 0; i < n; i++) {
      let nz = 0;
      if (wet) {
        nz = fr(this.nextU32() * 2.3283064370807974e-10 * 2.0 - 1.0);
        if (filt) {
          const v3 = fr(nz - ic2);
          const v1 = fr(fr(a1 * ic1) + fr(a2 * v3));
          const v2 = fr(fr(ic2 + fr(a2 * ic1)) + fr(a3 * v3));
          ic1 = fr(fr(2 * v1) - ic1);
          ic2 = fr(fr(2 * v2) - ic2);
          if (!(Math.abs(ic1) >= 1e-30)) ic1 = 0; // denormal / NaN guard (never hit with real noise)
          if (!(Math.abs(ic2) >= 1e-30)) ic2 = 0;
          nz = v1;
        }
      }
      L[i] = this.chan(L[i]!, nz, wet);
      R[i] = this.chan(R[i]!, nz, wet);
    }
    this.ic1 = ic1;
    this.ic2 = ic2;
  }
}

/* ------------------------------------------------------------------------------------ */
/* 17  Crusher                                                                           */
/*   1) sample-and-hold (only if raw34 > 0): clean fractional phase accumulator.         */
/*      r = 127*(raw34/10000)^3  (DSP uses the CUBE; the displayed Hz uses raw34/10000   */
/*      linearly - FL's text does not match its DSP except at 0 and 10000)               */
/*      P0 = 0.0002 r^3 - 0.0171 r^2 + 0.7435 r + 1   (hold length at 44.1 kHz, samples) */
/*      P = max(1, P0 * sr/44100); per sample: c += 1; if c >= P: c -= P*trunc(c/P),     */
/*      hold = current input. Holds start at 0, so output is 0 until the first capture.  */
/*   2) quantiser (only if raw35 > 0): levels = 2^(2 + 14*(1 - raw35/10000)),            */
/*      y = trunc(x*levels)/levels (truncation toward zero; step 2^-bits, no dither).    */
/* ------------------------------------------------------------------------------------ */

function crusherRateParam(rateRaw: number): number {
  const s = fr(rateRaw / 10000);
  return fr(fr(s * s) * s);
}

function crusherPeriod(rateParam: number, srRatio: number): number {
  const d0 = fr(rateParam * 127);
  let d2 = 0.0002 * d0 * d0 * d0;
  d2 = d2 - 0.0171 * d0 * d0;
  const d1 = d2 + 0.7435 * d0;
  const P = fr(fr(d1 + 1.0) * srRatio);
  return P < 1 ? 1 : P;
}

function crusherLevels(bitsParam: number): number {
  const q = fr(Math.sqrt(fr(Math.sqrt(bitsParam))));
  const e = fr(2 + fr(fr(1 - q) * 14));
  return fr(Math.pow(2, e));
}

export class Crusher {
  private sr = 44100;
  private srRatio = 1;
  private rateP = 0;
  private bitsP = 0;
  private levels = 1;
  private period = 1;
  private cL = 0;
  private cR = 0;
  private hL = 0;
  private hR = 0;

  constructor(sampleRate: number) {
    this.setSampleRate(sampleRate);
  }

  setSampleRate(sampleRate: number): void {
    this.sr = sampleRate > 0 && sampleRate < 1e7 ? sampleRate : 44100;
    this.srRatio = fr(this.sr / 44100);
    this.period = crusherPeriod(this.rateP, this.srRatio);
  }

  /** rateRaw = param 34, bitsRaw = param 35 (0..10000, 0 = off). */
  set(rateRaw: number, bitsRaw: number): void {
    const rr = clampRaw(rateRaw, 0, 0, 10000);
    const br = clampRaw(bitsRaw, 0, 0, 10000);
    this.rateP = crusherRateParam(rr);
    this.period = crusherPeriod(this.rateP, this.srRatio);
    const b = fr(br / 10000);
    this.bitsP = fr(b * b);
    this.levels = crusherLevels(this.bitsP);
  }

  /** Clears the sample-and-hold phase and held values. */
  reset(): void {
    this.cL = 0;
    this.cR = 0;
    this.hL = 0;
    this.hR = 0;
  }

  /** Actual hold length in samples at the current sample rate (0 when rate crush is off). */
  holdSamples(): number {
    return this.rateP > 0 ? this.period : 0;
  }

  process(L: Float32Array | Float64Array, R: Float32Array | Float64Array, n: number): void {
    const doRate = this.rateP > 0;
    const doBits = this.bitsP > 0;
    const P = this.period;
    const lv = this.levels;
    let cL = this.cL, cR = this.cR, hL = this.hL, hR = this.hR;
    for (let i = 0; i < n; i++) {
      let xl = inF32(L[i]!);
      let xr = inF32(R[i]!);
      if (doRate) {
        cL = fr(cL + 1);
        if (cL >= P) {
          cL = fr(cL - P * Math.trunc(fr(cL / P)));
          hL = xl;
        }
        xl = hL;
        cR = fr(cR + 1);
        if (cR >= P) {
          cR = fr(cR - P * Math.trunc(fr(cR / P)));
          hR = xr;
        }
        xr = hR;
      }
      if (doBits) {
        xl = fr(fr(Math.trunc(fr(xl * lv))) / lv);
        xr = fr(fr(Math.trunc(fr(xr * lv))) / lv);
      }
      L[i] = xl;
      R[i] = xr;
    }
    this.cL = cL;
    this.cR = cR;
    this.hL = hL;
    this.hR = hR;
  }
}

/** Hold length (samples) the Crusher DSP really uses. */
export function crusherHoldSamples(rateRaw: number, sampleRate: number): number {
  if (rateRaw <= 0) return 0;
  return crusherPeriod(crusherRateParam(rateRaw), fr(sampleRate / 44100));
}

/** The Hz value FL displays for param 34 (uses raw/10000 linearly, unlike the DSP). */
export function crusherDisplayHz(rateRaw: number, sampleRate = 44100): number {
  const s = fr(rateRaw / 10000);
  const P = crusherPeriod(s, fr(sampleRate / 44100));
  return fr(sampleRate / P);
}

/** The effective S&H rate in Hz that the DSP actually produces (sampleRate / hold length). */
export function crusherActualHz(rateRaw: number, sampleRate = 44100): number {
  if (rateRaw <= 0) return sampleRate;
  return sampleRate / crusherHoldSamples(rateRaw, sampleRate);
}

/** Bit depth FL displays (and the quantiser uses) for param 35: 2 + 14*(1 - raw/10000). */
export function crusherBits(bitsRaw: number): number {
  const b = fr(bitsRaw / 10000);
  return Math.log(crusherLevels(fr(b * b))) / 0.6931471805599453;
}

/* ------------------------------------------------------------------------------------ */
/* Value texts (exactly as FL prints them after "Module N: <name>: ")                    */
/* FL/FPC formatting rounds half away from zero on the exact binary value (same as JS     */
/* toFixed) and never prints a negative zero.                                            */
/* ------------------------------------------------------------------------------------ */

function fixedFL(v: number, digits: number): string {
  if (v !== v) return 'Nan';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  const s = v.toFixed(digits);
  return s.charCodeAt(0) === 45 && Number(s) === 0 ? s.slice(1) : s;
}

const PARAM_NAMES: { readonly [index: number]: string } = {
  6: 'Wave folder - Pre amp',
  7: 'Wave folder - Crossover',
  8: 'Wave folder - Asymmetry',
  9: 'Wave folder - Threshold',
  10: 'Aperture - Pre amp',
  11: 'Aperture - Crossover',
  12: 'Aperture - Asymmetry',
  13: 'Aperture - Threshold',
  14: 'Aperture - Warp point',
  15: 'Aperture - Mode',
  28: 'Abrasive - Pre amp',
  29: 'Abrasive - Gate thresh',
  30: 'Abrasive - Dry/wet',
  31: 'Abrasive - Post gain',
  32: 'Abrasive - Noise bp',
  33: 'Abrasive - Filter',
  34: 'Crusher - Rate crush',
  35: 'Crusher - Bit crush',
};

/** Parameter name as FL shows it (without the "Module N: " prefix); '' for other indices. */
export function dxmiscParamName(index: number): string {
  const s = PARAM_NAMES[index];
  return s === undefined ? '' : s;
}

/**
 * Value text for module parameter `index` (6..15, 28..35) at raw value `raw`.
 * sampleRate = the module's processing rate (sr * oversampling factor); only the
 * Crusher rate text depends on it (by float rounding). Returns '' for other indices.
 */
export function dxmiscValueText(index: number, raw: number, sampleRate = 44100): string {
  const r = Math.round(raw);
  switch (index) {
    case 6:
    case 10:
      return fixedFL(20 * Math.log10(fr(1 + fr(r / 500))), 1) + 'dB';
    case 7:
    case 8:
    case 11:
    case 12:
      return fixedFL(fr(fr(r / 5000) - 1) * 100, 0) + '%';
    case 9:
      return fixedFL(20 * Math.log10((r * 0.9) / 10000 + 0.1), 1) + 'dB';
    case 13:
      return fixedFL(20 * Math.log10(fr(fr(fr(r * 0.5) / 10000) + 0.5)), 1) + 'dB';
    case 14:
    case 30:
    case 32:
      return fixedFL(r / 100, 0) + '%';
    case 15:
      return r === 0 ? 'A' : 'B';
    case 28:
    case 31:
      return fixedFL(20 * Math.log10(fr(1 + fr(r / 5000))), 1) + 'dB';
    case 29:
      return r <= 0 ? '-InfdB' : fixedFL(20 * Math.log10(fr(r / 10000)), 1) + 'dB';
    case 33:
      return r === 0 ? 'Off' : 'On';
    case 34:
      return r === 0 ? 'Max Hz' : fixedFL(crusherDisplayHz(r, sampleRate), 2) + ' Hz';
    case 35:
      return r === 0 ? 'Max bits' : fixedFL(crusherBits(r), 2) + ' bits';
    default:
      return '';
  }
}
