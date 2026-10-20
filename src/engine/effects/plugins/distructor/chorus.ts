// DxChorus: the CHORUS module (module type 2) of FL Studio's Distructor.
//
// FL's chorus module is not a separate DSP: it loads Fruity Delay 3's own engine
// (Plugins/Fruity/Effects/Fruity Delay 3/engine.vst) and drives it with a fixed set
// of Delay 3 parameters. This class reimplements that engine in the configuration
// the chorus uses (constants and per-sample flow read from the engine's arm64 code,
// every law checked against renders of FL's plugin; see dxchorus_notes.txt):
//
//   Delay 3 param      chorus value (raw = Distructor module param)
//   time               delay / 768          free time, keep pitch ON, smoothing 0.5
//   feedback (x1.25)   feedback / 6000      gain = raw / 4800 (0..0.8)
//   mod rate           speed / 6000         LFO period table read at 0.99 x
//   mod time           depth / 6000         delay swing 0.025 s * d^2 * sqrt(P / 8.872)
//   diffusion level    blur / 6000          allpass coefficient 0.499 * level
//   diffusion spread   blur / 6000          allpass length (65 + 590 s) sr / 44100 samples
//   output tone        (color + 3000)/6000  1st-order LP (color < 0) / HP (color > 0)
//   model: Stereo = True Stereo, offset +68 % (L input pre-delayed)
//          Mono   = Fake Stereo (L+R)/2, offset 0
//          Wide   = Ping Pong, offset 0 (crossed lines: L input echoes on R first)
//   fixed: input wet 1, dry 0, wet 1, spread 1, feedback LP SVF (21985 Hz, Q 0.707),
//          Saturate distortion at level 0 (y = x - x|x|/4 in the line input),
//          rate / bits reduction off, DC blocker (10 Hz) in the feedback path.
//
// process() returns the module's wet signal (the engine output); the module does the
// dry/wet mix. The first process() after construction or reset() reproduces FL's
// state-load start-up (parameter glides from the engine's defaults, keep-pitch
// crossfade from stale taps, LFO at phase 0), so short renders line up with FL.

const F = Math.fround;

/** Delay 3 LFO period table (seconds), 7 knots. The DSP reads it at value * 0.99 * 5.9994. */
const RATE_T = [F(8.872), F(3.808), F(1.833), F(0.878), F(0.398), F(0.15), F(0.05)];
const RATE_P0 = RATE_T[0];
/** Delay 3 cutoff tables (Hz) at quarter points: low-pass and high-pass. */
const LP_T = [270, 480, 1300, 7000, 22000];
const HP_T = [20, 90, 400, 1300, 4200];

const PI_F = F(Math.PI);
const TWO_PI_F = F(2 * Math.PI);
const C_099 = F(0.99);
const C_59994 = F(5.9994);
const C_39999 = F(3.9999);
const C_3999 = F(3.999);
const C_049 = F(0.49);
const C_0499 = F(0.499);
const C_0015 = F(0.015);
const C_01 = F(0.1);
const C_0707 = F(0.707);
const C_590 = F(590);
const SNAP = F(1e-4);
const SH_A = F(0.0002);
const SH_B = F(-0.0171);
const SH_C = F(0.7435);
const LIM_ATT = F(0.0052076578);
const LIM_REL = F(0.00052070618);

/** Engine defaults (normalized) loaded by its constructor, index = Delay 3 parameter. */
const ENGINE_DEF = [1, 0, 0, 0, 0.5, 0.95, 0, 1, 0.5, 0, 0, 0, 0.5, 0.5, 0.5, 0, 1, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 1];
/** Values the Distructor writes into a freshly created chorus engine (in index order). */
const CHORUS_INIT = [1, 0.33, 0, 1, 52 / 767, 0.84, 0.5, 1, 0.5, 0.5, 0, 0, 0, 1, 0.16, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0.5, 0];
/** Parameters that go through the engine's 8-sample smoother (the others apply at once). */
const SMOOTHED = 0x03ff4c81;

/** Ring buffer with the engine's read convention: read(d) = sample written d samples ago. */
class Ring {
  readonly buf: Float32Array;
  readonly mask: number;
  w = 0;
  constructor(minLen: number) {
    let n = 16;
    while (n < minLen) n <<= 1;
    this.buf = new Float32Array(n);
    this.mask = n - 1;
  }
  write(x: number): void {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }
  /** Linear interpolation like FL: i = trunc(d) (negative -> 0), f = d - i. */
  read(d: number): number {
    let i = d > 0 ? Math.floor(d) : 0;
    if (!(i <= this.mask)) i = this.mask;
    const f = d > 0 ? F(d - i) : 0;
    const a = this.buf[(this.w - i) & this.mask];
    const b = this.buf[(this.w - i - 1) & this.mask];
    return F(a * F(1 - f) + F(f * b));
  }
  clear(): void {
    this.buf.fill(0);
    this.w = 0;
  }
}

/** Per-channel state of one line's input chain. */
class Chain {
  // DC blocker (bilinear 1st-order HP, coefficients fixed for 44.1 kHz)
  dx = 0; dy = 0;
  // feedback low-pass (TPT state-variable filter)
  ic1 = 0; ic2 = 0;
  // sample & hold (only active during the start-up glide of the rate parameter)
  held = 0; cnt = 0;
  // output tone (1st-order)
  tx = 0; ty = 0;
  // ping-pong output limiter envelope
  env = 0;
  // diffusion allpasses, one per crossfade slot
  readonly ap0: Ring;
  readonly ap1: Ring;
  constructor(apLen: number) {
    this.ap0 = new Ring(apLen);
    this.ap1 = new Ring(apLen);
  }
}

export class DxChorus {
  private readonly sr: number;
  private readonly srF: number;
  private readonly lineA: Ring;
  private readonly lineB: Ring;
  private readonly preL: Ring;
  private readonly preR: Ring;
  private readonly ca: Chain;
  private readonly cb: Chain;

  // constants derived from the sample rate
  private readonly kSmooth: number;   // parameter smoother, per 8-sample step
  private readonly kModAmp: number;   // modulation amplitude one-pole, per sample
  private readonly halfSr: number;
  private readonly xfLen: number;     // keep-pitch crossfade, samples
  private readonly xfInc: number;
  private readonly dcB0: number; private readonly dcA1: number;
  private readonly svA1: number; private readonly svA2: number; private readonly svA3: number;
  private readonly tonePiSr: number;
  private readonly toneMaxHz: number;
  private readonly shScale: number;

  // engine parameter values (normalized, float32) and smoother targets
  private readonly cur = new Float64Array(26);
  private readonly tgt = new Float64Array(26);
  private readonly act = new Uint8Array(26);
  private stepCnt = 0;

  // values derived from parameters
  private model = 0;          // engine model: 0 fake stereo, 1 true stereo, 2 ping pong
  private keepPitch = false;
  private timeX = 0.5;
  private offset = 0.95;
  private diffSpread = 0.5;
  private inWet = 1;
  private wet = 0.5;
  private dry = 1;
  private fb = F(0.625);
  private apC = 0;
  private modTimeF = 0;
  private lfoInc = 0;
  private sqrtRatio = 1;
  private shRate = 1;         // (1 - rate)^3; > 0 enables the sample & hold
  private bitsS = 1;          // (1 - bits)^2; > 0 enables the quantizer
  private bitsQ = 4;
  private tB0 = 1; private tB1 = 0; private tA1 = 0;
  private offLow = false;     // offset < 0.5 (latched when taps are computed)
  private engSr = 44100;      // the engine's sample rate (44.1 kHz until the module sets it)

  // keep-pitch slots: integer taps (computed) and the doubles the reads use
  private readonly iM = new Int32Array(2);
  private readonly iA = new Int32Array(2);
  private readonly iB = new Int32Array(2);
  private readonly iZ = new Int32Array(2);
  private readonly dM = new Float64Array(2);
  private readonly dA = new Float64Array(2);
  private readonly dB = new Float64Array(2);
  private readonly dZ = new Float64Array(2);
  private readonly gain = new Float64Array(2);
  private curSlot = 0;
  private nextSlot = 1;
  private fading = false;
  private fadeCnt = 0;
  private dirty = true;

  // LFO and modulation amplitude
  private phase = 0;
  private lfoVal = 0;
  private modAmp = 0;
  private tmp = 0;            // scratch value for the start-up rate / bit reduction

  // chorus parameters (raw) as last given to set()
  private cModel = 0;
  private cDelay = 108; private cFb = 2880; private cSpeed = 1500;
  private cDepth = 1995; private cBlur = 0; private cColor = 0;
  private fresh = true;

  constructor(sampleRate: number, maxBlock: number) {
    void maxBlock; // per-sample processing, no block buffers needed
    const sr = sampleRate > 0 && Number.isFinite(sampleRate) ? sampleRate : 44100;
    this.sr = sr;
    this.srF = F(sr);
    // lines: taps <= 0.047 sr (35 ms delay, plus a transient fake-stereo post tap after a
    // model change) plus the modulation (<= 0.075 sr)
    this.lineA = new Ring(Math.ceil(0.13 * sr) + 64);
    this.lineB = new Ring(this.lineA.buf.length);
    this.preL = new Ring(Math.ceil(0.006 * sr) + 64);
    this.preR = new Ring(this.preL.buf.length);
    // diffusion allpass: (65 + 590) sr / 44100 samples at most
    const apLen = Math.ceil((655 * sr) / 44100) + 64;
    this.ca = new Chain(apLen);
    this.cb = new Chain(apLen);

    this.kSmooth = F(1 - Math.pow(0.01, 1 / (sr * 0.005)));
    this.kModAmp = F(1 - Math.pow(0.01, 1 / (sr * 0.1)));
    this.halfSr = F(sr * 0.5);
    this.xfLen = Math.max(1, Math.trunc(sr * 0.1));
    this.xfInc = F(1 / F(this.xfLen));
    this.shScale = F(sr / 44100);
    // DC blocker: 10 Hz bilinear high-pass computed for 44.1 kHz whatever the rate
    {
      const k = F(F(1 / 44100) * PI_F);
      const g = F(Math.tan(F(k * 10)));
      const s = F(g + 1);
      this.dcB0 = F(1 / s);
      this.dcA1 = F(F(1 - g) / s);
    }
    // feedback filter: Delay 3 LP at knob 1.0 (table at 3.999 -> 21985 Hz), Q 0.707
    {
      const idx = C_3999; // 1.0 * 3.999
      const i = 3, fr = F(idx - i);
      let fc = F(F(1 - fr) * LP_T[i] + F(fr * LP_T[i + 1]));
      const lim = F(this.srF * C_049);
      if (fc > lim) fc = lim;
      const k = F(1 / C_0707);
      const g = F(Math.tan(F(F(3.1415 / sr) * fc)));
      this.svA1 = F(1 / F(g * F(g + k) + 1));
      this.svA2 = F(g * this.svA1);
      this.svA3 = F(g * this.svA2);
    }
    this.tonePiSr = F(F(1 / sr) * PI_F);
    this.toneMaxHz = F(this.srF * C_049);
    this.initEngine();
  }

  /** Raw module values (see header). Changes apply like FL automation (only changed values). */
  set(model: number, p: { delay: number; feedback: number; speed: number; depth: number; blur: number; color: number }): void {
    const m = clampInt(model, 0, 2, 0);
    const d = clampInt(p.delay, 1, 216, 108);
    const fbv = clampInt(p.feedback, 0, 3840, 2880);
    const sp = clampInt(p.speed, 0, 6000, 1500);
    const dp = clampInt(p.depth, 300, 6000, 1995);
    const bl = clampInt(p.blur, 0, 6000, 0);
    const co = clampInt(p.color, -3000, 3000, 0);
    if (this.fresh) {
      this.cModel = m; this.cDelay = d; this.cFb = fbv; this.cSpeed = sp;
      this.cDepth = dp; this.cBlur = bl; this.cColor = co;
      return;
    }
    if (d !== this.cDelay) { this.cDelay = d; this.setParam(4, F(d / 768)); }
    if (fbv !== this.cFb) { this.cFb = fbv; this.setParam(14, F(fbv / 6000)); }
    if (sp !== this.cSpeed) { this.cSpeed = sp; this.setParam(8, F(sp / 6000)); }
    if (dp !== this.cDepth) { this.cDepth = dp; this.setParam(9, F(dp / 6000)); }
    if (bl !== this.cBlur) { this.cBlur = bl; this.setParam(11, F(bl / 6000)); this.setParam(12, F(bl / 6000)); }
    if (co !== this.cColor) { this.cColor = co; this.setParam(24, F((co + 3000) / 6000)); }
    if (m !== this.cModel) { this.cModel = m; this.applyModel(m); }
  }

  /** Back to the state right after FL loads the module (LFO phase 0, start-up glides). */
  reset(): void {
    this.clearAll();
    this.initEngine();
  }

  /** In place; returns the wet (engine) signal. */
  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.fresh) this.loadState();
    const len = Math.min(n | 0, L.length, R.length);
    if (len > 0) {
      // the engine model only changes between blocks (set() / state load)
      if (this.model === 0) this.runFake(L, R, len);
      else if (this.model === 1) this.runTrue(L, R, len);
      else this.runPing(L, R, len);
    }
    this.sanitize();
  }

  // ------------------------------------------------------------------ engine set-up

  private initEngine(): void {
    // engine object defaults, then its constructor loads its own parameter defaults
    this.phase = 0; this.lfoVal = 0; this.modAmp = 0; this.lfoInc = 0;
    this.model = 0; this.keepPitch = false; this.dirty = true;
    this.fading = false; this.curSlot = 0; this.nextSlot = 1; this.fadeCnt = 0;
    this.gain[0] = 1; this.gain[1] = 0;
    this.iM.fill(10); this.iZ.fill(10); this.iA.fill(0); this.iB.fill(0);
    this.dM.fill(10); this.dZ.fill(10); this.dA.fill(0); this.dB.fill(0);
    this.act.fill(0);
    this.stepCnt = 0;
    this.engSr = 44100;
    for (let i = 0; i < 26; i++) this.immediate(i, ENGINE_DEF[i]);
    this.engineReset(44100);
    // the Distructor's chorus processor writes its init values (engine still at 44.1 kHz)
    for (let i = 0; i < 26; i++) this.setParam(i, F(CHORUS_INIT[i]));
    // the engine is reset once more at 44.1 kHz, then the module sets its sample rate
    // (re-allocation + reset): the stale keep-pitch slot holds the init-value taps at 44.1 kHz
    this.engineReset(44100);
    this.engSr = this.sr;
    this.engineReset(this.sr);
    this.fresh = true;
  }

  /** State load of the module's parameters (FL: params 43..48, then the chorus model). */
  private loadState(): void {
    this.fresh = false;
    this.setParam(4, F(this.cDelay / 768));
    this.setParam(14, F(this.cFb / 6000));
    this.setParam(8, F(this.cSpeed / 6000));
    this.setParam(9, F(this.cDepth / 6000));
    this.setParam(11, F(this.cBlur / 6000));
    this.setParam(12, F(this.cBlur / 6000));
    this.setParam(24, F((this.cColor + 3000) / 6000));
    this.applyModel(this.cModel);
  }

  private applyModel(m: number): void {
    // Stereo -> True Stereo (0.33), offset 0.84; Mono -> Fake Stereo (0); Wide -> Ping Pong (0.66)
    this.setParam(1, F(m === 0 ? 0.33 : m === 1 ? 0 : 0.66));
    this.setParam(5, F(m === 0 ? 0.84 : 0.5));
  }

  /** Engine reset (after a model change or a sample-rate change). */
  private engineReset(calcSr: number): void {
    this.lineA.clear(); this.lineB.clear(); this.preL.clear(); this.preR.clear();
    resetChain(this.ca, false);
    resetChain(this.cb, false);
    for (let s = 0; s < 2; s++) {
      this.dM[s] = this.iM[s]; this.dA[s] = this.iA[s]; this.dB[s] = this.iB[s]; this.dZ[s] = this.iZ[s];
    }
    this.computeTimes(0, calcSr);
    this.computeTimes(1, calcSr);
  }

  /** Host-side setParameter: smoothed parameters get a smoother target, the rest apply now. */
  private setParam(i: number, v: number): void {
    const x = F(v < 0 ? 0 : v > 1 ? 1 : v);
    if ((SMOOTHED >> i) & 1) {
      this.tgt[i] = x;
      this.act[i] = 1;
    } else {
      this.immediate(i, x);
    }
  }

  /** One step of the engine's parameter smoother (every 8 samples). */
  private smootherStep(): void {
    for (let i = 0; i < 26; i++) {
      if (!this.act[i]) continue;
      const c = this.cur[i], t = this.tgt[i];
      const s = F(F(t - c) * this.kSmooth + c);
      if (Math.abs(F(s - t)) < SNAP) {
        this.act[i] = 0;
        this.immediate(i, t);
      } else {
        this.immediate(i, s);
      }
    }
  }

  /** The engine's per-parameter handlers (value normalized 0..1). */
  private immediate(i: number, v: number): void {
    const x = F(v);
    this.cur[i] = x;
    switch (i) {
      case 0: this.inWet = x; break;
      case 1: {
        const m = Math.trunc(x * 3 + 0.5);
        if (m !== this.model) {
          this.model = m;
          this.engineReset(this.engSr);
          this.dirty = true;
        }
        break;
      }
      case 3: this.keepPitch = x >= 0.5; if (!this.keepPitch) this.dirty = true; break;
      case 4: this.timeX = x; this.dirty = true; break;
      case 5: this.offset = x; this.dirty = true; break;
      case 8: {
        const v99 = F(x * C_099);
        const idx = F(v99 * C_59994);
        const P = table7(idx);
        this.lfoInc = F(1 / F(P * this.srF));
        this.sqrtRatio = F(Math.sqrt(F(P / RATE_P0)));
        break;
      }
      case 9: this.modTimeF = F(F(v * v) * C_01); break;
      case 11: this.apC = F(Math.min(1, Math.max(0, x)) * C_0499); break;
      case 12: this.diffSpread = x; this.dirty = true; break;
      case 14: this.fb = F(x * 1.25); break;
      case 21: { const s = F(1 - x); this.shRate = F(F(s * s) * s); break; }
      case 22: {
        const s = F(1 - x), s2 = F(s * s);
        this.bitsS = s2;
        this.bitsQ = F(Math.pow(2, F(F(1 - F(Math.sqrt(F(Math.sqrt(s2))))) * 14 + 2)));
        break;
      }
      case 23: this.wet = x; break;
      case 24: this.setTone(x); break;
      case 25: this.dry = x; break;
      default: break; // sync, smoothing, spread, cutoff, distortion: constant in the chorus
    }
  }

  private setTone(v: number): void {
    if (v < 0.5) {
      const fc = table5(LP_T, F(F(v + v) * C_39999));
      this.toneCoefs(0, fc);
    } else if (v === 0.5) {
      this.tB0 = 1; this.tB1 = 0; this.tA1 = 0; // bypass
    } else {
      const fc = table5(HP_T, F(F(F(v - 0.5) * 2) * C_39999));
      this.toneCoefs(1, fc);
    }
  }

  private toneCoefs(mode: number, hz: number): void {
    const fc = hz > this.toneMaxHz ? this.toneMaxHz : hz;
    const g = F(Math.tan(F(this.tonePiSr * fc)));
    const s = F(g + 1);
    this.tA1 = F(F(1 - g) / s);
    if (mode === 0) { this.tB0 = F(g / s); this.tB1 = this.tB0; }
    else { this.tB0 = F(1 / s); this.tB1 = -this.tB0; }
  }

  /** Integer taps of a crossfade slot (engine model layout, as FL computes them). */
  private computeTimes(slot: number, calcSr: number): void {
    const x = this.timeX;
    let t = x * 0.94 + 0.06;
    t = t * t * t;
    t = (t + -0.000216) * 1.0002160466660799;
    t = t * 0.999 + 0.001;
    const D = Math.trunc(calcSr * t);
    const Df = F(D);
    const s3 = F(calcSr / 44100);
    let r = F(Df / F(F(calcSr) * C_0015));
    if (r > 1) r = 1;
    const spread = F(this.diffSpread * C_590 + 65);
    let mf = F(F(F(spread * s3)) * r);
    if (mf < 1) mf = 1;
    const M = Math.trunc(mf);
    this.iM[slot] = M;
    this.offLow = this.offset < 0.5;
    const f = F(F(Math.abs(F(this.offset - 0.5))) * 2);
    const zf = F(Df - F(M));
    const Z = Math.trunc(zf < 1 ? 1 : zf);
    if (this.model === 1 || this.model === 2) {
      const h = F(f * 0.5);
      let pre = F(h * F(h * Df));
      if (pre < 1) pre = 1;
      const P = Math.trunc(pre);
      this.iZ[slot] = Z;
      if (this.offLow) { this.iA[slot] = 1; this.iB[slot] = P; }
      else { this.iA[slot] = P; this.iB[slot] = 1; }
    } else if (this.model === 0) {
      const post = F(Df - F(F(1 - f * 0.5) * Df));
      const Q = Math.trunc(F(post + F(Z)));
      if (this.offLow) { this.iA[slot] = Q; this.iB[slot] = Z; }
      else { this.iA[slot] = Z; this.iB[slot] = Q; }
    }
  }

  // ------------------------------------------------------------------ per sample
  //
  // One loop per engine model with the DSP written out inline (no double-valued calls in
  // the hot path, so the JIT does not box numbers). Arithmetic and rounding follow the
  // engine: float32 everywhere, fused multiply-adds rounded once.

  /** Smoother step every 8 samples and the keep-pitch crossfade trigger (start of a sample). */
  private pre(): void {
    if (++this.stepCnt === 8) { this.stepCnt = 0; this.smootherStep(); }
    if (this.keepPitch && !this.fading && this.dirty) {
      this.dirty = false;
      this.fading = true;
      this.fadeCnt = 0;
      const s = this.nextSlot;
      this.computeTimes(s, this.sr);
      this.dM[s] = this.iM[s]; this.dA[s] = this.iA[s]; this.dB[s] = this.iB[s]; this.dZ[s] = this.iZ[s];
    }
  }

  /** Crossfade gains for the next sample (end of a sample). */
  private post(): void {
    if (this.keepPitch && this.fading) {
      const g = F(F(this.fadeCnt) * this.xfInc);
      this.gain[this.curSlot] = F(1 - g);
      this.gain[this.nextSlot] = g;
      if (++this.fadeCnt === this.xfLen) {
        this.fading = false;
        const t = this.curSlot; this.curSlot = this.nextSlot; this.nextSlot = t;
      }
    }
  }

  /** Rate / bit reduction on this.tmp (only during the start-up glide of those knobs). */
  private shq(c: Chain): void {
    let v = this.tmp;
    if (this.shRate > 0) {
      const s1 = F(this.shRate * 127);
      const p2 = F(F(s1 * SH_A) * s1);
      const p3 = F(F(s1 * SH_B) * s1);
      let hold = F(F(F(s1 * SH_C + F(p2 * s1 + p3)) + 1) * this.shScale);
      if (hold < 1) hold = 1;
      const n = F(c.cnt + 1);
      if (n < hold) {
        c.cnt = n;
        v = c.held;
      } else {
        let r = 0;
        if (n >= 0 && hold > 0) {
          const q = F(n / hold);
          r = F(n * F(q - Math.trunc(q)));
        }
        c.cnt = r;
        c.held = v;
      }
    }
    if (this.bitsS > 0) v = F(Math.trunc(F(v * this.bitsQ)) / this.bitsQ);
    this.tmp = v;
  }

  /** Fake stereo: (L + R) / 2 into one line, read at two taps (L, R). */
  private runFake(L: Float32Array, R: Float32Array, n: number): void {
    const ca = this.ca, cb = this.cb;
    const bA = this.lineA.buf, mA = this.lineA.mask;
    const p0 = ca.ap0.buf, p1 = ca.ap1.buf, mp = ca.ap0.mask;
    let wA = this.lineA.w, w0 = ca.ap0.w, w1 = ca.ap1.w;
    let dx = ca.dx, dy = ca.dy, ic1 = ca.ic1, ic2 = ca.ic2;
    let txL = ca.tx, tyL = ca.ty, txR = cb.tx, tyR = cb.ty;
    let ph = this.phase, amp = this.modAmp, lfo = this.lfoVal;
    const inc = this.lfoInc, kAmp = this.kModAmp;
    const target = F(F(this.halfSr * this.modTimeF) * this.sqrtRatio);
    const b0 = this.dcB0, nb0 = -this.dcB0, a1 = this.dcA1;
    const s1 = this.svA1, s2 = this.svA2, s3 = this.svA3;
    const gain = this.gain, dA = this.dA, dB = this.dB, dM = this.dM;
    for (let i = 0; i < n; i++) {
      this.pre();
      let xl = L[i], xr = R[i];
      if (!(xl > 1e-13 || xl < -1e-13) || xl === Infinity || xl === -Infinity) xl = 0;
      else if (xl > 1e30) xl = 1e30; else if (xl < -1e30) xl = -1e30;
      if (!(xr > 1e-13 || xr < -1e-13) || xr === Infinity || xr === -Infinity) xr = 0;
      else if (xr > 1e30) xr = 1e30; else if (xr < -1e30) xr = -1e30;
      // LFO: float32 phase, value from the phase before the increment
      const nx = F(ph + inc);
      lfo = F(F(F(Math.sin(F(ph * TWO_PI_F))) + 1) * 0.5);
      ph = F(nx - Math.trunc(nx));
      amp = F(F(target - amp) * kAmp + amp);
      const mod = F(amp * F(lfo + 0.5));
      const g0 = gain[0], g1 = gain[1];
      // four interpolated taps (slot 0 / 1, L / R)
      let t = F(F(dA[0]) + mod);
      let k = t > 0 ? Math.floor(t) : 0; if (!(k <= mA)) k = mA;
      let f = t > 0 ? F(t - k) : 0;
      const rL0 = F(bA[(wA - k) & mA] * F(1 - f) + F(f * bA[(wA - k - 1) & mA]));
      t = F(F(dB[0]) + mod);
      k = t > 0 ? Math.floor(t) : 0; if (!(k <= mA)) k = mA;
      f = t > 0 ? F(t - k) : 0;
      const rR0 = F(bA[(wA - k) & mA] * F(1 - f) + F(f * bA[(wA - k - 1) & mA]));
      t = F(F(dA[1]) + mod);
      k = t > 0 ? Math.floor(t) : 0; if (!(k <= mA)) k = mA;
      f = t > 0 ? F(t - k) : 0;
      const rL1 = F(bA[(wA - k) & mA] * F(1 - f) + F(f * bA[(wA - k - 1) & mA]));
      t = F(F(dB[1]) + mod);
      k = t > 0 ? Math.floor(t) : 0; if (!(k <= mA)) k = mA;
      f = t > 0 ? F(t - k) : 0;
      const rR1 = F(bA[(wA - k) & mA] * F(1 - f) + F(f * bA[(wA - k - 1) & mA]));
      const wl = F(rL1 * g1 + F(rL0 * g0));
      const wr = F(rR1 * g1 + F(rR0 * g0));
      // feedback (from the tap without post-delay) through the DC blocker
      const fbIn = F((this.offLow ? wr : wl) * this.fb);
      const yd = F(F(fbIn * b0 + F(dx * nb0)) + dy * a1);
      dx = fbIn; dy = yd;
      let v = F(F(F(F(xl + xr) * 0.5) * this.inWet) + yd);
      if (this.shRate > 0 || this.bitsS > 0) { this.tmp = v; this.shq(ca); v = this.tmp; }
      // saturate (level 0): y = x - x|x|/4
      if (v >= 0) { const u = v > 2 ? 2 : v; v = F(u * F(1 - 0.25 * u)); }
      else { const u = -v > 2 ? 2 : -v; v = -F(u * F(1 - 0.25 * u)); }
      // feedback low-pass (TPT SVF), after the distortion in this model
      {
        const v3 = F(v - ic2);
        const v1 = F(s1 * ic1 + F(v3 * s2));
        const v2 = F(s3 * v3 + F(s2 * ic1 + ic2));
        ic1 = F(2 * v1 - ic1); ic2 = F(2 * v2 - ic2);
        v = v2;
      }
      // diffusion allpasses of both slots on the line input
      {
        const c = this.apC, cc = F(1 - c * c);
        const d0 = p0[(w0 - dM[0]) & mp];
        p0[w0] = F(v - d0 * c); w0 = (w0 + 1) & mp;
        const d1 = p1[(w1 - dM[1]) & mp];
        p1[w1] = F(v - d1 * c); w1 = (w1 + 1) & mp;
        const y0 = F(v * c + F(d0 * cc)), y1 = F(v * c + F(d1 * cc));
        bA[wA] = F(y0 * g0 + F(y1 * g1)); wA = (wA + 1) & mA;
      }
      // output tone, then dry + wet (spread 1)
      const tb0 = this.tB0, tb1 = this.tB1, ta1 = this.tA1;
      const oL = F(F(wl * tb0 + F(txL * tb1)) + tyL * ta1); txL = wl; tyL = oL;
      const oR = F(F(wr * tb0 + F(txR * tb1)) + tyR * ta1); txR = wr; tyR = oR;
      L[i] = F(F(xl * this.dry) + F(oL * this.wet));
      R[i] = F(F(xr * this.dry) + F(oR * this.wet));
      this.post();
    }
    this.lineA.w = wA; ca.ap0.w = w0; ca.ap1.w = w1;
    ca.dx = dx; ca.dy = dy; ca.ic1 = ic1; ca.ic2 = ic2;
    ca.tx = txL; ca.ty = tyL; cb.tx = txR; cb.ty = tyR;
    this.phase = ph; this.modAmp = amp; this.lfoVal = lfo;
  }

  /** True stereo: independent lines; the L input (offset > 0) or R input is pre-delayed. */
  private runTrue(L: Float32Array, R: Float32Array, n: number): void {
    const ca = this.ca, cb = this.cb;
    const bA = this.lineA.buf, bB = this.lineB.buf, mA = this.lineA.mask;
    const bPL = this.preL.buf, bPR = this.preR.buf, mP = this.preL.mask;
    const pa0 = ca.ap0.buf, pa1 = ca.ap1.buf, pb0 = cb.ap0.buf, pb1 = cb.ap1.buf, mp = ca.ap0.mask;
    let wA = this.lineA.w, wB = this.lineB.w, wPL = this.preL.w, wPR = this.preR.w;
    let wa0 = ca.ap0.w, wa1 = ca.ap1.w, wb0 = cb.ap0.w, wb1 = cb.ap1.w;
    let dxa = ca.dx, dya = ca.dy, ia1 = ca.ic1, ia2 = ca.ic2, txa = ca.tx, tya = ca.ty;
    let dxb = cb.dx, dyb = cb.dy, ib1 = cb.ic1, ib2 = cb.ic2, txb = cb.tx, tyb = cb.ty;
    let ph = this.phase, amp = this.modAmp, lfo = this.lfoVal;
    const inc = this.lfoInc, kAmp = this.kModAmp;
    const target = F(F(this.halfSr * this.modTimeF) * this.sqrtRatio);
    const b0 = this.dcB0, nb0 = -this.dcB0, a1 = this.dcA1;
    const s1 = this.svA1, s2 = this.svA2, s3 = this.svA3;
    const gain = this.gain, dA = this.dA, dB = this.dB, dZ = this.dZ, dM = this.dM;
    for (let i = 0; i < n; i++) {
      this.pre();
      let xl = L[i], xr = R[i];
      if (!(xl > 1e-13 || xl < -1e-13) || xl === Infinity || xl === -Infinity) xl = 0;
      else if (xl > 1e30) xl = 1e30; else if (xl < -1e30) xl = -1e30;
      if (!(xr > 1e-13 || xr < -1e-13) || xr === Infinity || xr === -Infinity) xr = 0;
      else if (xr > 1e30) xr = 1e30; else if (xr < -1e30) xr = -1e30;
      const nx = F(ph + inc);
      lfo = F(F(F(Math.sin(F(ph * TWO_PI_F))) + 1) * 0.5);
      ph = F(nx - Math.trunc(nx));
      amp = F(F(target - amp) * kAmp + amp);
      const mod = F(amp * F(lfo + 0.5));
      const g0 = gain[0], g1 = gain[1];
      // line taps of both slots (same positions in both lines)
      let t = F(dZ[0] + mod);
      let k0 = t > 0 ? Math.floor(t) : 0; if (!(k0 <= mA)) k0 = mA;
      const f0 = t > 0 ? F(t - k0) : 0, h0 = F(1 - f0);
      t = F(dZ[1] + mod);
      let k1 = t > 0 ? Math.floor(t) : 0; if (!(k1 <= mA)) k1 = mA;
      const f1 = t > 0 ? F(t - k1) : 0, h1 = F(1 - f1);
      const wa = F(F(bA[(wA - k1) & mA] * h1 + F(f1 * bA[(wA - k1 - 1) & mA])) * g1
        + F(F(bA[(wA - k0) & mA] * h0 + F(f0 * bA[(wA - k0 - 1) & mA])) * g0));
      const wb = F(F(bB[(wB - k1) & mA] * h1 + F(f1 * bB[(wB - k1 - 1) & mA])) * g1
        + F(F(bB[(wB - k0) & mA] * h0 + F(f0 * bB[(wB - k0 - 1) & mA])) * g0));
      // input pre-delays (crossfaded like the taps; 1 = no delay)
      bPL[wPL] = xl; wPL = (wPL + 1) & mP;
      const pl = F(bPL[(wPL - dA[0]) & mP] * g0 + F(bPL[(wPL - dA[1]) & mP] * g1));
      bPR[wPR] = xr; wPR = (wPR + 1) & mP;
      const pr = F(bPR[(wPR - dB[0]) & mP] * g0 + F(bPR[(wPR - dB[1]) & mP] * g1));
      const fb = this.fb, inWet = this.inWet, c = this.apC, cc = F(1 - c * c);
      // channel A: DC-blocked feedback + input -> SVF -> (S&H/bits) -> saturate -> allpasses
      {
        const fi = F(wa * fb);
        const yd = F(F(fi * b0 + F(dxa * nb0)) + dya * a1); dxa = fi; dya = yd;
        let v = F(pl * inWet + yd);
        const v3 = F(v - ia2);
        const v1 = F(s1 * ia1 + F(v3 * s2));
        const v2 = F(s3 * v3 + F(s2 * ia1 + ia2));
        ia1 = F(2 * v1 - ia1); ia2 = F(2 * v2 - ia2);
        v = v2;
        if (this.shRate > 0 || this.bitsS > 0) { this.tmp = v; this.shq(ca); v = this.tmp; }
        if (v >= 0) { const u = v > 2 ? 2 : v; v = F(u * F(1 - 0.25 * u)); }
        else { const u = -v > 2 ? 2 : -v; v = -F(u * F(1 - 0.25 * u)); }
        const d0 = pa0[(wa0 - dM[0]) & mp];
        pa0[wa0] = F(v - d0 * c); wa0 = (wa0 + 1) & mp;
        const d1 = pa1[(wa1 - dM[1]) & mp];
        pa1[wa1] = F(v - d1 * c); wa1 = (wa1 + 1) & mp;
        bA[wA] = F(F(v * c + F(d0 * cc)) * g0 + F(F(v * c + F(d1 * cc)) * g1)); wA = (wA + 1) & mA;
      }
      // channel B
      {
        const fi = F(wb * fb);
        const yd = F(F(fi * b0 + F(dxb * nb0)) + dyb * a1); dxb = fi; dyb = yd;
        let v = F(pr * inWet + yd);
        const v3 = F(v - ib2);
        const v1 = F(s1 * ib1 + F(v3 * s2));
        const v2 = F(s3 * v3 + F(s2 * ib1 + ib2));
        ib1 = F(2 * v1 - ib1); ib2 = F(2 * v2 - ib2);
        v = v2;
        if (this.shRate > 0 || this.bitsS > 0) { this.tmp = v; this.shq(cb); v = this.tmp; }
        if (v >= 0) { const u = v > 2 ? 2 : v; v = F(u * F(1 - 0.25 * u)); }
        else { const u = -v > 2 ? 2 : -v; v = -F(u * F(1 - 0.25 * u)); }
        const d0 = pb0[(wb0 - dM[0]) & mp];
        pb0[wb0] = F(v - d0 * c); wb0 = (wb0 + 1) & mp;
        const d1 = pb1[(wb1 - dM[1]) & mp];
        pb1[wb1] = F(v - d1 * c); wb1 = (wb1 + 1) & mp;
        bB[wB] = F(F(v * c + F(d0 * cc)) * g0 + F(F(v * c + F(d1 * cc)) * g1)); wB = (wB + 1) & mA;
      }
      const tb0 = this.tB0, tb1 = this.tB1, ta1 = this.tA1;
      const oL = F(F(wa * tb0 + F(txa * tb1)) + tya * ta1); txa = wa; tya = oL;
      const oR = F(F(wb * tb0 + F(txb * tb1)) + tyb * ta1); txb = wb; tyb = oR;
      L[i] = F(F(xl * this.dry) + F(oL * this.wet));
      R[i] = F(F(xr * this.dry) + F(oR * this.wet));
      this.post();
    }
    this.lineA.w = wA; this.lineB.w = wB; this.preL.w = wPL; this.preR.w = wPR;
    ca.ap0.w = wa0; ca.ap1.w = wa1; cb.ap0.w = wb0; cb.ap1.w = wb1;
    ca.dx = dxa; ca.dy = dya; ca.ic1 = ia1; ca.ic2 = ia2; ca.tx = txa; ca.ty = tya;
    cb.dx = dxb; cb.dy = dyb; cb.ic1 = ib1; cb.ic2 = ib2; cb.tx = txb; cb.ty = tyb;
    this.phase = ph; this.modAmp = amp; this.lfoVal = lfo;
  }

  /**
   * Ping pong: line B takes the L input plus the feedback of line A, line A the R input
   * plus the feedback of line B; L output = line A, R output = line B (an L input
   * therefore echoes on the right first). The outputs pass the engine's limiter.
   */
  private runPing(L: Float32Array, R: Float32Array, n: number): void {
    const ca = this.ca, cb = this.cb;
    const bA = this.lineA.buf, bB = this.lineB.buf, mA = this.lineA.mask;
    const pa0 = ca.ap0.buf, pa1 = ca.ap1.buf, pb0 = cb.ap0.buf, pb1 = cb.ap1.buf, mp = ca.ap0.mask;
    let wA = this.lineA.w, wB = this.lineB.w;
    let wa0 = ca.ap0.w, wa1 = ca.ap1.w, wb0 = cb.ap0.w, wb1 = cb.ap1.w;
    let dxa = ca.dx, dya = ca.dy, ia1 = ca.ic1, ia2 = ca.ic2, txa = ca.tx, tya = ca.ty, ea = ca.env;
    let dxb = cb.dx, dyb = cb.dy, ib1 = cb.ic1, ib2 = cb.ic2, txb = cb.tx, tyb = cb.ty, eb = cb.env;
    let ph = this.phase, amp = this.modAmp, lfo = this.lfoVal;
    const inc = this.lfoInc, kAmp = this.kModAmp;
    const target = F(F(this.halfSr * this.modTimeF) * this.sqrtRatio);
    const b0 = this.dcB0, nb0 = -this.dcB0, a1 = this.dcA1;
    const s1 = this.svA1, s2 = this.svA2, s3 = this.svA3;
    const gain = this.gain, dZ = this.dZ, dM = this.dM;
    for (let i = 0; i < n; i++) {
      this.pre();
      let xl = L[i], xr = R[i];
      if (!(xl > 1e-13 || xl < -1e-13) || xl === Infinity || xl === -Infinity) xl = 0;
      else if (xl > 1e30) xl = 1e30; else if (xl < -1e30) xl = -1e30;
      if (!(xr > 1e-13 || xr < -1e-13) || xr === Infinity || xr === -Infinity) xr = 0;
      else if (xr > 1e30) xr = 1e30; else if (xr < -1e30) xr = -1e30;
      const nx = F(ph + inc);
      lfo = F(F(F(Math.sin(F(ph * TWO_PI_F))) + 1) * 0.5);
      ph = F(nx - Math.trunc(nx));
      amp = F(F(target - amp) * kAmp + amp);
      const mod = F(amp * F(lfo + 0.5));
      const g0 = gain[0], g1 = gain[1];
      let t = F(dZ[0] + mod);
      let k0 = t > 0 ? Math.floor(t) : 0; if (!(k0 <= mA)) k0 = mA;
      const f0 = t > 0 ? F(t - k0) : 0, h0 = F(1 - f0);
      t = F(dZ[1] + mod);
      let k1 = t > 0 ? Math.floor(t) : 0; if (!(k1 <= mA)) k1 = mA;
      const f1 = t > 0 ? F(t - k1) : 0, h1 = F(1 - f1);
      const wa = F(F(bA[(wA - k1) & mA] * h1 + F(f1 * bA[(wA - k1 - 1) & mA])) * g1
        + F(F(bA[(wA - k0) & mA] * h0 + F(f0 * bA[(wA - k0 - 1) & mA])) * g0));
      const wb = F(F(bB[(wB - k1) & mA] * h1 + F(f1 * bB[(wB - k1 - 1) & mA])) * g1
        + F(F(bB[(wB - k0) & mA] * h0 + F(f0 * bB[(wB - k0 - 1) & mA])) * g0));
      const fb = this.fb, inWet = this.inWet, c = this.apC, cc = F(1 - c * c);
      // L input + feedback of line A -> line B
      {
        const fi = F(wa * fb);
        const yd = F(F(fi * b0 + F(dxa * nb0)) + dya * a1); dxa = fi; dya = yd;
        let v = F(xl * inWet + yd);
        const v3 = F(v - ia2);
        const v1 = F(s1 * ia1 + F(v3 * s2));
        const v2 = F(s3 * v3 + F(s2 * ia1 + ia2));
        ia1 = F(2 * v1 - ia1); ia2 = F(2 * v2 - ia2);
        v = v2;
        if (this.shRate > 0 || this.bitsS > 0) { this.tmp = v; this.shq(ca); v = this.tmp; }
        if (v >= 0) { const u = v > 2 ? 2 : v; v = F(u * F(1 - 0.25 * u)); }
        else { const u = -v > 2 ? 2 : -v; v = -F(u * F(1 - 0.25 * u)); }
        const d0 = pa0[(wa0 - dM[0]) & mp];
        pa0[wa0] = F(v - d0 * c); wa0 = (wa0 + 1) & mp;
        const d1 = pa1[(wa1 - dM[1]) & mp];
        pa1[wa1] = F(v - d1 * c); wa1 = (wa1 + 1) & mp;
        bB[wB] = F(F(v * c + F(d0 * cc)) * g0 + F(F(v * c + F(d1 * cc)) * g1)); wB = (wB + 1) & mA;
      }
      // R input + feedback of line B -> line A
      {
        const fi = F(wb * fb);
        const yd = F(F(fi * b0 + F(dxb * nb0)) + dyb * a1); dxb = fi; dyb = yd;
        let v = F(xr * inWet + yd);
        const v3 = F(v - ib2);
        const v1 = F(s1 * ib1 + F(v3 * s2));
        const v2 = F(s3 * v3 + F(s2 * ib1 + ib2));
        ib1 = F(2 * v1 - ib1); ib2 = F(2 * v2 - ib2);
        v = v2;
        if (this.shRate > 0 || this.bitsS > 0) { this.tmp = v; this.shq(cb); v = this.tmp; }
        if (v >= 0) { const u = v > 2 ? 2 : v; v = F(u * F(1 - 0.25 * u)); }
        else { const u = -v > 2 ? 2 : -v; v = -F(u * F(1 - 0.25 * u)); }
        const d0 = pb0[(wb0 - dM[0]) & mp];
        pb0[wb0] = F(v - d0 * c); wb0 = (wb0 + 1) & mp;
        const d1 = pb1[(wb1 - dM[1]) & mp];
        pb1[wb1] = F(v - d1 * c); wb1 = (wb1 + 1) & mp;
        bA[wA] = F(F(v * c + F(d0 * cc)) * g0 + F(F(v * c + F(d1 * cc)) * g1)); wA = (wA + 1) & mA;
      }
      const tb0 = this.tB0, tb1 = this.tB1, ta1 = this.tA1;
      let oL = F(F(wa * tb0 + F(txa * tb1)) + tya * ta1); txa = wa; tya = oL;
      let oR = F(F(wb * tb0 + F(txb * tb1)) + tyb * ta1); txb = wb; tyb = oR;
      // output limiter: envelope of |x|, gain 1 / max(env, 1)
      let a = oL < 0 ? -oL : oL;
      ea = F(F(a - ea) * (a < ea ? LIM_REL : LIM_ATT) + ea);
      oL = F(oL / (ea > 1 ? ea : 1));
      a = oR < 0 ? -oR : oR;
      eb = F(F(a - eb) * (a < eb ? LIM_REL : LIM_ATT) + eb);
      oR = F(oR / (eb > 1 ? eb : 1));
      L[i] = F(F(xl * this.dry) + F(oL * this.wet));
      R[i] = F(F(xr * this.dry) + F(oR * this.wet));
      this.post();
    }
    this.lineA.w = wA; this.lineB.w = wB;
    ca.ap0.w = wa0; ca.ap1.w = wa1; cb.ap0.w = wb0; cb.ap1.w = wb1;
    ca.dx = dxa; ca.dy = dya; ca.ic1 = ia1; ca.ic2 = ia2; ca.tx = txa; ca.ty = tya; ca.env = ea;
    cb.dx = dxb; cb.dy = dyb; cb.ic1 = ib1; cb.ic2 = ib2; cb.tx = txb; cb.ty = tyb; cb.env = eb;
    this.phase = ph; this.modAmp = amp; this.lfoVal = lfo;
  }

  /** Flush denormals; restart cleanly if anything became non-finite. */
  private sanitize(): void {
    const bad = !flushChain(this.ca) || !flushChain(this.cb) || !Number.isFinite(this.modAmp + this.phase);
    if (bad) {
      this.clearAll();
      if (!Number.isFinite(this.modAmp)) this.modAmp = 0;
      if (!Number.isFinite(this.phase)) this.phase = 0;
    }
  }

  private clearAll(): void {
    this.lineA.clear(); this.lineB.clear(); this.preL.clear(); this.preR.clear();
    resetChain(this.ca, true);
    resetChain(this.cb, true);
  }
}

/** Engine reset of a channel chain (FL keeps the tone filter, limiter and S&H counter). */
function resetChain(c: Chain, full: boolean): void {
  c.dx = 0; c.dy = 0; c.ic1 = 0; c.ic2 = 0; c.held = 0;
  c.ap0.clear(); c.ap1.clear();
  if (full) { c.cnt = 0; c.tx = 0; c.ty = 0; c.env = 0; }
}

/** Denormal flush of a chain's IIR states; false if any state is not finite. */
function flushChain(c: Chain): boolean {
  if (!Number.isFinite(c.dx + c.dy + c.ic1 + c.ic2 + c.held + c.tx + c.ty + c.env + c.cnt)) return false;
  if (Math.abs(c.dy) < 1e-30) c.dy = 0;
  if (Math.abs(c.ic1) < 1e-30) c.ic1 = 0;
  if (Math.abs(c.ic2) < 1e-30) c.ic2 = 0;
  if (Math.abs(c.ty) < 1e-30) c.ty = 0;
  return true;
}

function clampInt(v: number, lo: number, hi: number, def: number): number {
  if (!Number.isFinite(v)) return def;
  const r = Math.round(v);
  return r < lo ? lo : r > hi ? hi : r;
}

/** 7-knot period table, linear, index truncated like FL. */
function table7(idx: number): number {
  let i = Math.trunc(idx);
  if (i < 0) i = 0;
  if (i > 5) i = 5;
  const f = F(idx - i);
  return F(F(1 - f) * RATE_T[i] + F(f * RATE_T[i + 1]));
}

/** 5-knot cutoff table, linear. */
function table5(t: number[], idx: number): number {
  let i = Math.trunc(idx);
  if (i < 0) i = 0;
  if (i > 3) i = 3;
  const f = F(idx - i);
  return F(F(1 - f) * t[i] + F(f * t[i + 1]));
}
