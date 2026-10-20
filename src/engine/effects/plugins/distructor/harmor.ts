/*
 * harmor.ts - FL Studio "Distructor" distortion module, the 11 Harmor models
 * (module type 0, dist 3..13):
 *    3 Classic   4 Hill   5 Flathat   6 Cube   7 Log   8 Softsat
 *    9 Rubber   10 Ribbon 11 Sincrush 12 Bitcrush 13 Bitjam
 * plus the Harmor-section controls: pre amp (23), asymmetry (24), wet vol (25), dry mix (26),
 * filter cut (27), and the post filter.
 *
 * Derived from measurements of FL Studio 2026's real plugin through flfxhost (error figures in
 * harmor_notes.txt). Every model is a closed formula that matches FL to float32 rounding:
 * max abs error <= 6e-7 for |x| <= 1 and <= 1.4e-6 for |x| <= 4 (outputs up to 4.7), pre 0..1000,
 * with and without asymmetry (Ribbon with asymmetry at pre >= 880: 1.2e-6). Bitcrush
 * matches bit for bit. Bitjam matches except ~1 sample in 1e5, where FL's float32 rounding puts
 * the sample on the other side of a quantiser threshold (an error of one step there).
 *
 * IMPORTANT: FL does NOT use a lookup table in the audio path. The curves are evaluated directly
 * per sample. Evidence: midpoints between 1/32768 nodes follow the true curvature, and the curves
 * continue unchanged for |x| > 1 (Rubber keeps folding, Bitcrush keeps quantising, Classic
 * keeps its tanh). `harmorTable` is for display or legacy code only. For audio, use
 * `HarmorShaper.process` or `HarmorDistortion`.
 *
 * ---------------------------------------------------------------------------------------------
 * PER-SAMPLE SIGNAL FLOW OF A HARMOR MODEL (FL's order). x = the module input after the module's
 * input gain, inside the oversampled section when the module's "os" > 0 (every rate below is
 * then the oversampled rate sr * 2^os). a = asym/500 in -1..1 (negative "stereo", positive "mono").
 *
 *   1. shaper      s = f_model,pre,asym,ch(x)        direct formula, no table, no input clamp.
 *                  The asymmetry is model specific (see the formulas below):
 *                    Classic Hill Flathat Cube Log Softsat Rubber: input offset s = f(x + off), with
 *                        off_L = 0.75 a^2,  off_R = 0.75 a|a|   (R gets -c when stereo).
 *                        No compensation afterwards: the output carries the DC f(off).
 *                    Ribbon:   the three tanh factors are spread apart by p_L = a^2, p_R = a|a|.
 *                    Sincrush: the sine amplitude is scaled by 4^-a (both channels).
 *                    Bitcrush: quantiser offset a_ch/L, a_L = a, a_R = |a| (L gets the sign!).
 *                    Bitjam:   companding constant A = 2^(10 + 10 a) (both channels).
 *   2. wet / dry   d = dry/1000 (-1..1),  w = (3^(wet/1000) - 1)/2   (wet 1000 -> 1, 2000 -> 4)
 *                  m = w * (1 - |d|) * s  +  d * x          (the dry term uses the plain input x)
 *   3. post filter y = LR4(m): two identical 2nd-order Butterworth low-pass biquads (bilinear,
 *                  prewarped), Direct Form I, double precision, per channel.
 *                  fc = 523.2511306 * 2^((cut-500)/100) Hz, clamped to 0.4999*sr - 45.
 *                  cut raw == 1100 (the maximum) bypasses the filter completely.
 *                  Coefficient changes apply at once and the DF1 state is kept.
 *   After that come the module's own mix (param 37), output gain, DC remover ("center"),
 *   oversampling decimation, and so on.
 *
 * Parameter changes take effect at the next block, without smoothing. The exception is an FL
 * quirk in the asymmetry state of models 3-10 and 12 (the off/p values above). During the first
 * processing block after asym changes, including the first block after instantiation (where the
 * old value is 0), FL uses
 *     v_glitch = v_old - exp(-307/sr) * (v_new - v_old)
 * This is a kick in the wrong direction lasting exactly one host block, whatever its size.
 * After that it uses v_new. Sincrush and Bitjam have no glitch. `HarmorDistortion` can emulate
 * it per processBlock call (option `asymGlitch`, off by default).
 * ---------------------------------------------------------------------------------------------
 *
 * Model formulas, a = asym/500; off/p per channel as above;
 * g = 2^((pre-400)/100), so g = 2 at pre 500 and 64 at pre 1000; t(u) = tanh(pi g u):
 *   Classic   tanh(pi g (x+off)) / (pi tanh g)
 *   Hill      (exp(tanh(pi g (x+off))) - 1) / (pi tanh g)        (not odd: +(e-1)/pi .. -(1-1/e)/pi)
 *   Flathat   tanh(exp(pi g (x+off)) - 1) / (pi tanh g)          (not odd: +1/pi .. -tanh(1)/pi)
 *   Cube      tanh(4 pi g (x+off))^3 / (pi tanh(16 g)^3)
 *   Log       sign(z) ln(1 + b|z|) / (ln(1 + b) (1 + pre/1000)),  z = x+off,  b = 2^((pre-200)/40)
 *   Softsat   cbrt(tanh((pi h z)^3)) / (pi tanh h),               z = x+off,  h = 2^(pre/200 - 3)
 *   Rubber    sign(z) sin(k sqrt|z|) / sqrt(k),                   z = x+off,  k = (pi/2) 2^(pre/500)
 *   Ribbon    t(x) t(x+p) t(x+2p) / (pi tanh g)                    (= t(x)^3 / (pi tanh g) at a = 0)
 *   Sincrush  x + 4^-a sin(N pi x) / (N pi),                       N = 2^(7 - 7 pre/1000)
 *   Bitcrush  roundHalfAway((x + a_ch/L) L) / L,                   L = 2^(9 - 7 pre/1000)  (float32 ops)
 *   Bitjam    A = 2^(10 + 10a), L = 2^(10 - 7 pre/1000):
 *             v = ln(1 + A|x|) L / ln(1 + A),  k = floor(v + 1/2),  y = sign(x) ((1 + A)^(k/L) - 1) / A
 *
 * Self-contained, no imports, strict-mode clean, allocation-free while processing, sample-rate
 * aware, finite for any input (NaN -> 0, |x| clamped to 1e6, filter state flushed of
 * denormals and reset on non-finite values).
 */

const fr = Math.fround;
const PI = Math.PI;
const MAX_IN = 1e6;

/** First and last Distructor distortion-model index of the Harmor family. */
export const HARMOR_FIRST_MODEL = 3;
export const HARMOR_LAST_MODEL = 13;
export const HARMOR_MODEL_NAMES: readonly string[] = [
  'Classic', 'Hill', 'Flathat', 'Cube', 'Log', 'Softsat', 'Rubber', 'Ribbon', 'Sincrush', 'Bitcrush', 'Bitjam',
];

function clampNum(v: number, lo: number, hi: number, def: number): number {
  if (v !== v) return def;
  return v < lo ? lo : v > hi ? hi : v;
}

function sanitize(x: number): number {
  if (x !== x) return 0;
  return x > MAX_IN ? MAX_IN : x < -MAX_IN ? -MAX_IN : x;
}

/**
 * Harmor waveshaper for one (model, pre amp, asymmetry) setting with per-channel asymmetry
 * state. `process` evaluates FL's curve directly for any input, with no table and no clamp at
 * |x| = 1. Constants are computed in set(); process() allocates nothing.
 */
export class HarmorShaper {
  model = 3;
  pre = 500;
  asym = 0;
  /** Per-channel asymmetry state in the model's own units (input offset, Ribbon spacing, Bitcrush offset). */
  asymL = 0;
  asymR = 0;
  private k0 = 0;
  private k1 = 0;
  private k2 = 0;

  constructor(model = 3, pre = 500, asym = 0) {
    this.set(model, pre, asym);
  }

  /** model: Distructor dist index 3..13; pre: raw 0..1000; asym: raw -500..500 (all clamped). */
  set(model: number, pre: number, asym = 0): void {
    const m = Math.round(clampNum(model, HARMOR_FIRST_MODEL, HARMOR_LAST_MODEL, 3));
    const p = clampNum(pre, 0, 1000, 500);
    const asy = clampNum(asym, -500, 500, 0);
    const a = asy / 500;
    this.model = m;
    this.pre = p;
    this.asym = asy;
    this.asymL = 0;
    this.asymR = 0;
    const g = Math.pow(2, (p - 400) / 100);
    if (m <= 9) {
      // input offset models; FL computes c in float32: c = f32(0.75 * f32(a32 * a32)), a32 = f32(asym/500)
      const a32 = fr(a);
      const c = fr(0.75 * fr(a32 * a32));
      this.asymL = c;
      this.asymR = a < 0 ? -c : c;
    }
    switch (m) {
      case 3: // Classic
      case 4: // Hill
      case 5: // Flathat
        this.k0 = PI * g;
        this.k1 = 1 / (PI * Math.tanh(g));
        break;
      case 6: { // Cube
        const t = Math.tanh(16 * g);
        this.k0 = 4 * PI * g;
        this.k1 = 1 / (PI * t * t * t);
        break;
      }
      case 7: { // Log
        const b = Math.pow(2, (p - 200) / 40);
        this.k0 = b;
        this.k1 = 1 / (Math.log1p(b) * (1 + p / 1000));
        break;
      }
      case 8: { // Softsat
        const h = Math.pow(2, p / 200 - 3);
        this.k0 = PI * h;
        this.k1 = 1 / (PI * Math.tanh(h));
        break;
      }
      case 9: { // Rubber
        const k = (PI / 2) * Math.pow(2, p / 500);
        this.k0 = k;
        this.k1 = 1 / Math.sqrt(k);
        break;
      }
      case 10: // Ribbon
        this.k0 = PI * g;
        this.k1 = 1 / (PI * Math.tanh(g));
        this.asymL = a * a;
        this.asymR = a * Math.abs(a);
        break;
      case 11: { // Sincrush
        const n = Math.pow(2, 7 - (7 * p) / 1000);
        this.k0 = n * PI;
        this.k1 = Math.pow(4, -a) / (n * PI);
        break;
      }
      case 12: { // Bitcrush (FL: float32 level count, float32 adds/products, round half away from zero)
        const L = fr(Math.pow(2, 9 - (7 * p) / 1000));
        const q = fr(1 / L);
        this.k0 = L;
        this.k1 = q;
        this.asymL = a * q;
        this.asymR = Math.abs(a) * q;
        break;
      }
      default: { // 13 Bitjam
        const L = Math.pow(2, 10 - (7 * p) / 1000);
        const A = Math.pow(2, 10 + 10 * a);
        const lnA1 = Math.log1p(A);
        this.k0 = fr(fr(L) / fr(lnA1)); // float32 scale applied to ln(1 + A|x|)
        this.k1 = lnA1 / L;             // expansion step
        this.k2 = A;
        break;
      }
    }
  }

  /** True for the models whose asymmetry state shows FL's one-block glitch (3..10, 12). */
  get hasAsymGlitch(): boolean {
    return this.model !== 11 && this.model !== 13;
  }

  /** FL's curve for channel ch (0 = L, 1 = R) with the steady-state asymmetry. Finite for any input. */
  process(x: number, ch: 0 | 1 = 0): number {
    return this.processWith(x, ch === 1 ? this.asymR : this.asymL);
  }

  /** Same as process() with an explicit per-channel asymmetry state value v (see asymL/asymR). */
  processWith(xIn: number, v: number): number {
    const x = sanitize(xIn);
    switch (this.model) {
      case 3: // Classic
        return Math.tanh(this.k0 * (x + v)) * this.k1;
      case 4: // Hill
        return Math.expm1(Math.tanh(this.k0 * (x + v))) * this.k1;
      case 5: // Flathat (expm1 may overflow to +Infinity, tanh(+Inf) = 1)
        return Math.tanh(Math.expm1(this.k0 * (x + v))) * this.k1;
      case 6: { // Cube
        const t = Math.tanh(this.k0 * (x + v));
        return t * t * t * this.k1;
      }
      case 7: { // Log
        const z = x + v;
        const r = Math.log1p(this.k0 * Math.abs(z)) * this.k1;
        return z < 0 ? -r : r;
      }
      case 8: { // Softsat
        const u = this.k0 * (x + v);
        return Math.cbrt(Math.tanh(u * u * u)) * this.k1;
      }
      case 9: { // Rubber
        const z = x + v;
        const r = Math.sin(this.k0 * Math.sqrt(Math.abs(z))) * this.k1;
        return z < 0 ? -r : r;
      }
      case 10: { // Ribbon
        const k = this.k0;
        return Math.tanh(k * x) * Math.tanh(k * (x + v)) * Math.tanh(k * (x + 2 * v)) * this.k1;
      }
      case 11: // Sincrush
        return x + Math.sin(this.k0 * x) * this.k1;
      case 12: { // Bitcrush
        const s = fr(fr(fr(x) + fr(v)) * this.k0);
        const q = Math.floor(Math.abs(s) + 0.5);
        return (s < 0 ? -q : q) * this.k1;
      }
      default: { // 13 Bitjam
        const A = this.k2;
        const ax = fr(Math.abs(x));
        const s = fr(fr(Math.log(fr(1 + fr(A * ax)))) * this.k0);
        const k = Math.floor(s + 0.5);
        const y = Math.expm1(k * this.k1) / A;
        return x < 0 ? -y : y;
      }
    }
  }
}

const scratchShaper = new HarmorShaper();

/** Convenience: f(x) for (model, pre, asym, ch). Recomputes constants on a change; use HarmorShaper in loops. */
export function harmorShape(model: number, pre: number, x: number, asym = 0, ch: 0 | 1 = 0): number {
  const s = scratchShaper;
  if (s.model !== model || s.pre !== pre || s.asym !== asym) s.set(model, pre, asym);
  return s.process(x, ch);
}

/**
 * Fill a 65536-entry table with entry i <-> x = (i - 32768)/32768 (x in [-1, 32767/32768]).
 * It matches FL's curve at those nodes, but FL evaluates the curve directly. A table lookup
 * misses |x| >= 1, where FL keeps evaluating the formula, and the fine structure of Log/Rubber
 * near 0 and of the quantisers. Use it for display only.
 */
export function harmorTable(model: number, pre: number, out: Float32Array, asym = 0, ch: 0 | 1 = 0): void {
  const s = new HarmorShaper(model, pre, asym); // setup-time allocation only
  const n = Math.min(out.length, 65536);
  for (let i = 0; i < n; i++) out[i] = s.process((i - 32768) / 32768, ch);
}

/** Wet vol raw 0..2000 -> linear gain (3^(raw/1000) - 1)/2: 0 -> 0, 500 -> 0.366, 1000 -> 1, 2000 -> 4. */
export function harmorWetGain(raw: number): number {
  const r = clampNum(raw, 0, 2000, 1000);
  return (Math.pow(3, r / 1000) - 1) / 2;
}

/** Dry mix raw -1000..1000 -> signed linear gain raw/1000, applied to the plain input x. */
export function harmorDryGain(raw: number): number {
  return clampNum(raw, -1000, 1000, 0) / 1000;
}

/**
 * Total gain on the shaper output: harmorWetGain(wet) * (1 - |harmorDryGain(dry)|).
 * The dry mix crossfades: at |dry| = 100% the shaper is muted whatever the wet vol.
 */
export function harmorWetScale(wetRaw: number, dryRaw: number): number {
  return harmorWetGain(wetRaw) * (1 - Math.abs(harmorDryGain(dryRaw)));
}

/**
 * Filter cut raw 500..1100 -> nominal cutoff in Hz: 523.2511306 * 2^((raw-500)/100)
 * (= 440 * 2^(raw/100 - 4.75); 500 -> 523.25 Hz "C5", 950 -> 11839.82 Hz "F#9").
 * raw >= 1100 means "filter off" (see HarmorPostFilter.setRaw). FL's value text stops at
 * 30181.13 Hz from raw 1085 up; the DSP does not apply that limit.
 */
export function harmorCutHz(raw: number): number {
  const r = clampNum(raw, 500, 1100, 950);
  return 523.2511306047798 * Math.pow(2, (r - 500) / 100);
}

/** Effective cutoff FL uses at a given (possibly oversampled) rate: min(hz, 0.4999*sr - 45). */
export function harmorEffectiveCutHz(hz: number, sampleRate: number): number {
  const lim = 0.4999 * sampleRate - 45;
  return hz < lim ? hz : lim;
}

/**
 * Input offset of the offset-type models (Classic, Hill, Flathat, Cube, Log, Softsat, Rubber)
 * for channel ch: 0.75 a^2 on L; on R +0.75 a^2 if asym > 0 ("mono"), -0.75 a^2 if asym < 0 ("stereo").
 */
export function harmorAsymOffset(asymRaw: number, ch: 0 | 1): number {
  const a = clampNum(asymRaw, -500, 500, 0) / 500;
  const a32 = fr(a);
  const c = fr(0.75 * fr(a32 * a32));
  return ch === 1 && a < 0 ? -c : c;
}

/**
 * Harmor post filter: 4th-order Linkwitz-Riley low-pass (two identical Butterworth biquads,
 * Q = 1/sqrt2, bilinear with prewarp K = tan(pi fc/sr)), Direct Form I, double precision,
 * independent state for 2 channels. -6.02 dB and -180 degrees at fc, unity DC gain.
 */
export class HarmorPostFilter {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private bypass = true;
  // per channel: x1 x2 (input), u1 u2 (stage-1 output = stage-2 input), y1 y2 (output)
  private readonly st = new Float64Array(12);

  constructor() {
    this.reset();
  }

  /**
   * Set the cutoff in Hz at the given processing rate (the oversampled rate when the module is
   * oversampled). FL clamps fc to 0.4999*sr - 45. A non-finite or non-positive hz bypasses the
   * filter. The state is kept, as in FL.
   */
  set(hz: number, sampleRate: number): void {
    const sr = sampleRate > 0 && sampleRate < Infinity ? sampleRate : 44100;
    if (!(hz > 0) || hz === Infinity) {
      this.bypass = true;
      return;
    }
    const fc = harmorEffectiveCutHz(hz, sr);
    if (!(fc > 0)) {
      this.bypass = true;
      return;
    }
    const K = Math.tan((PI * fc) / sr);
    const K2 = K * K;
    const kq = Math.SQRT2 * K; // K/Q with Q = 1/sqrt2
    const d = 1 / (1 + kq + K2);
    this.b0 = K2 * d;
    this.b1 = 2 * this.b0;
    this.b2 = this.b0;
    this.a1 = 2 * (K2 - 1) * d;
    this.a2 = (1 - kq + K2) * d;
    this.bypass = false;
  }

  /** Set from FL's raw "Filter cut" 500..1100. 1100 (the maximum) bypasses the filter. */
  setRaw(raw: number, sampleRate: number): void {
    if (!(raw < 1100)) {
      this.bypass = true;
      return;
    }
    this.set(harmorCutHz(raw), sampleRate);
  }

  get isBypassed(): boolean {
    return this.bypass;
  }

  reset(): void {
    this.st.fill(0);
  }

  process(x: number, ch: 0 | 1): number {
    if (this.bypass) return x;
    const s = this.st;
    const o = ch === 1 ? 6 : 0;
    const xin = x === x ? x : 0;
    const x1 = s[o]!, x2 = s[o + 1]!, u1 = s[o + 2]!, u2 = s[o + 3]!, y1 = s[o + 4]!, y2 = s[o + 5]!;
    let u = this.b0 * xin + this.b1 * x1 + this.b2 * x2 - this.a1 * u1 - this.a2 * u2;
    let y = this.b0 * u + this.b1 * u1 + this.b2 * u2 - this.a1 * y1 - this.a2 * y2;
    if (!(Math.abs(y) < 1e30) || !(Math.abs(u) < 1e30)) {
      for (let i = 0; i < 6; i++) s[o + i] = 0;
      return 0;
    }
    if (Math.abs(u) < 1e-30) u = 0;
    if (Math.abs(y) < 1e-30) y = 0;
    s[o + 1] = x1;
    s[o] = xin;
    s[o + 3] = u1;
    s[o + 2] = u;
    s[o + 5] = y1;
    s[o + 4] = y;
    return y;
  }
}

/** Raw Harmor-section parameters (FL knob positions). */
export interface HarmorParams {
  model: number; // 3..13
  pre: number;   // 0..1000     (default 500)
  asym: number;  // -500..500   (default 0)
  wet: number;   // 0..2000     (default 1000)
  dry: number;   // -1000..1000 (default 0)
  cut: number;   // 500..1100   (default 950)
}

export const HARMOR_DEFAULTS: Readonly<HarmorParams> = { model: 3, pre: 500, asym: 0, wet: 1000, dry: 0, cut: 950 };

/**
 * Complete Harmor-model processor (steps 1-3 of the signal flow above), stereo, allocation-free.
 * The caller applies the module's input gain before it, and the module mix, output gain,
 * DC remover and oversampling around it. Construct or call setSampleRate with the oversampled
 * rate when the module is oversampled.
 */
export class HarmorDistortion {
  readonly shaper = new HarmorShaper();
  readonly filter = new HarmorPostFilter();
  /** Emulate FL's one-block asymmetry glitch in processBlock (see header). Off by default. */
  asymGlitch = false;
  private sr = 44100;
  private wet = 1000;
  private dry = 0;
  private cut = 950;
  private wetScale = 1;
  private dryGain = 0;
  private prevL = 0; // asymmetry state in force during the previous processBlock (0 after reset)
  private prevR = 0;
  private prevModel = -1;
  private pendingGlitch = true;

  constructor(sampleRate = 44100, params: Partial<HarmorParams> = {}) {
    this.sr = sampleRate > 0 && sampleRate < Infinity ? sampleRate : 44100;
    this.setParams({ ...HARMOR_DEFAULTS, ...params });
    this.reset();
  }

  setSampleRate(sampleRate: number): void {
    this.sr = sampleRate > 0 && sampleRate < Infinity ? sampleRate : 44100;
    this.filter.setRaw(this.cut, this.sr);
  }

  /** Update any subset of the raw parameters (they take effect immediately, as FL does at block starts). */
  setParams(p: Partial<HarmorParams>): void {
    const sh = this.shaper;
    const model = p.model ?? sh.model;
    const pre = p.pre ?? sh.pre;
    const asym = p.asym ?? sh.asym;
    if (model !== sh.model || pre !== sh.pre || asym !== sh.asym) {
      if (asym !== sh.asym) this.pendingGlitch = true;
      sh.set(model, pre, asym);
    }
    if (p.wet !== undefined) this.wet = clampNum(p.wet, 0, 2000, 1000);
    if (p.dry !== undefined) this.dry = clampNum(p.dry, -1000, 1000, 0);
    this.wetScale = harmorWetScale(this.wet, this.dry);
    this.dryGain = harmorDryGain(this.dry);
    if (p.cut !== undefined) {
      this.cut = clampNum(p.cut, 500, 1100, 950);
      this.filter.setRaw(this.cut, this.sr);
    }
  }

  /** Clear the filter state. For asymGlitch, also restart as after instantiation. */
  reset(): void {
    this.filter.reset();
    this.prevL = 0;
    this.prevR = 0;
    this.prevModel = this.shaper.model;
    this.pendingGlitch = true;
  }

  /** One sample of channel ch (0 = L, 1 = R) with the steady-state asymmetry. */
  process(x: number, ch: 0 | 1): number {
    return this.run(x, ch, ch === 1 ? this.shaper.asymR : this.shaper.asymL);
  }

  private run(xIn: number, ch: 0 | 1, v: number): number {
    const x = sanitize(xIn);
    const s = this.shaper.processWith(x, v);
    return this.filter.process(this.wetScale * s + this.dryGain * x, ch);
  }

  /** In-place stereo block of n frames. */
  processBlock(L: Float32Array | Float64Array, R: Float32Array | Float64Array, n: number): void {
    const sh = this.shaper;
    let vL = sh.asymL;
    let vR = sh.asymR;
    if (this.asymGlitch && this.pendingGlitch && sh.hasAsymGlitch && this.prevModel === sh.model) {
      const k = Math.exp(-307 / this.sr);
      vL = this.prevL - k * (sh.asymL - this.prevL);
      vR = this.prevR - k * (sh.asymR - this.prevR);
    }
    this.pendingGlitch = false;
    this.prevL = sh.asymL;
    this.prevR = sh.asymR;
    this.prevModel = sh.model;
    const m = Math.min(n, L.length, R.length);
    for (let i = 0; i < m; i++) {
      L[i] = this.run(L[i]!, 0, vL);
      R[i] = this.run(R[i]!, 1, vR);
    }
  }
}
