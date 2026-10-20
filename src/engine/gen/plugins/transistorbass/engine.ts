// Transistor Bass sound engine: FL's "V2" TB-303 voice (TB303Engine2 in FL's
// engine library), decoded from FL 2026's binary and transcribed with its
// constants, precision (float / double as FL computes) and order of updates.
// One instance is the whole monophonic voice; tick() returns one output sample
// at the host rate. Inside, the oscillator, filter, VCA, high-pass, volume and
// distortion run 4x oversampled and two polyphase IIR half-band stages
// decimate (musicdsp "steep" order-12 coefficients).
//
// Signal: wavetable saw / pulse (difference of two saws) blend -> negated ->
// TB-303 diode ladder (Open303's "TeeBeeFilter" TB_303 mode, rational
// approximations of the integrator gain and feedback, feedback through a
// 160 Hz one-pole high-pass) -> x VCA (attack / decay envelopes, accent
// envelopes, asymmetric smoothing, "Clicks" smoothing) -> one-pole high-pass
// (HP knob, 10..400 Hz) -> x volume -> RAT-style distortion (optional) ->
// decimation. Control values (pitch glide, filter envelope, cutoff, VCA) are
// computed once per host sample.

import { tbWavetables } from './wavetable';

const f32 = Math.fround;
const OS = 4;

/** FL's one-pole TPT filter (floats): LP or HP, tan prewarped. */
export class OnePole {
  y1 = 0;
  x1 = 0;
  b0 = 0;
  b1 = 0;
  a1 = 0;
  hp = false;
  fc = 0;
  /** pi / sample rate (float). */
  piOverSr = f32(Math.PI / 44100);

  setSampleRate(sr: number): void {
    this.piOverSr = f32(f32(1 / sr) * f32(Math.PI));
    if (this.hp) this.setHP(this.fc); else this.setLP(this.fc);
  }

  setLP(fc: number): void {
    this.fc = f32(fc);
    this.hp = false;
    const t = f32(Math.tan(f32(this.piOverSr * this.fc)));
    const d = f32(t + 1);
    const b = f32(t / d);
    this.b0 = b; this.b1 = b;
    this.a1 = f32(-f32(t - 1) / d);
  }

  setHP(fc: number): void {
    this.fc = f32(fc);
    this.hp = true;
    const t = f32(Math.tan(f32(this.piOverSr * this.fc)));
    const d = f32(t + 1);
    const b = f32(1 / d);
    this.b0 = b; this.b1 = -b;
    this.a1 = f32(-f32(t - 1) / d);
  }

  tick(x: number): number {
    const y = f32(f32(x * this.b0 + f32(this.x1 * this.b1)) + this.y1 * this.a1);
    this.y1 = y;
    this.x1 = x;
    return y;
  }

  reset(): void { this.y1 = 0; this.x1 = 0; }
}

/** One stage of musicdsp's polyphase IIR half-band: two allpass cascades. */
class AllpassCascade {
  private readonly a: Float64Array;
  private readonly s: Float64Array; // x0, x1, y0, y1 per stage
  constructor(coefs: number[]) {
    this.a = Float64Array.from(coefs);
    this.s = new Float64Array(coefs.length * 4);
  }
  tick(x: number): number {
    const a = this.a, s = this.s;
    for (let i = 0, o = 0; i < a.length; i++, o += 4) {
      const y = (x - s[o + 3]) * a[i] + s[o + 1];
      s[o + 1] = s[o]; s[o] = x;
      s[o + 3] = s[o + 2]; s[o + 2] = y;
      x = y;
    }
    return x;
  }
  reset(): void { this.s.fill(0); }
}

const HB_A = [0.036681502163648017, 0.2746317593794541, 0.56109896978791948, 0.769741833862266, 0.8922608180038789, 0.962094548378084];
const HB_B = [0.13654762463195771, 0.42313861743656667, 0.6775400499741616, 0.839889624849638, 0.9315419599631839, 0.9878163707328971];

export class HalfBand {
  private readonly fa = new AllpassCascade(HB_A);
  private readonly fb = new AllpassCascade(HB_B);
  private old = 0;
  tick(x: number): number {
    const out = (this.fa.tick(x) + this.old) * 0.5;
    this.old = this.fb.tick(x);
    return out;
  }
  reset(): void { this.fa.reset(); this.fb.reset(); this.old = 0; }
}

/** FL's attack / rise / decay envelope objects (TB303Engine2 +0x8f8 / 0x900 / 0x908). */
class AmpEnv {
  // times (s) and levels as FL's constructor sets them
  attackT: number;
  mid: number;
  riseT: number;
  decayT: number;
  decayTo: number;
  constructor(attackT: number, mid: number, riseT: number, decayT: number, decayTo: number) {
    this.attackT = attackT; this.mid = mid; this.riseT = riseT; this.decayT = decayT; this.decayTo = decayTo;
  }
  attackInc = 0;
  riseInc = 0;
  decayCoef = 0;
  a = 0;
  b = 0;
  out = 0;
  stage = 2;
  setSampleRate(sr: number): void {
    this.attackInc = 1 / (this.attackT * sr);
    this.riseInc = 1 / (this.riseT * sr);
    this.decayCoef = Math.pow(this.decayTo, 1 / (this.decayT * sr));
  }
  trigger(): void { this.a = 0; this.b = 0; this.stage = 0; }
  release(): void { this.stage = 3; }
  tick(): number {
    switch (this.stage) {
      case 0: {
        let a = this.a + this.attackInc;
        if (a > 1) { a = 1; this.stage = 1; }
        this.a = a;
        this.out = this.mid * (a * a * a);
        return f32(this.out);
      }
      case 1: {
        let b = this.b + this.riseInc;
        if (b > 1) { b = 1; this.stage = 2; }
        this.b = b;
        const u = f32(1 - b);
        const s = f32(1 - f32(f32(u * u) * u));
        this.out = (1 - this.mid) * s + this.mid;
        return f32(this.out);
      }
      case 2:
        this.out = this.out * this.decayCoef;
        return f32(this.out);
      default:
        return 0;
    }
  }
}

/**
 * FL's accent "wow" circuit (TB303Engine2 +0x928): an RC network whose
 * capacitor charges towards an accent voltage through the resonance pot.
 */
export class AccentSweep {
  dirty = true;
  lastRes = -1;
  lastAcc = -1;
  sr = 44100;
  c0 = 0; c8 = 0; c10 = 0; c18 = 0;
  k38 = 0; k40 = 0;
  v1 = 3.25;
  v2 = 3.25;
  out = 3.25;

  tick(res: number, acc: number, drive: number): number {
    let g: number;
    let d1: number;
    if (this.dirty || this.lastRes !== res) {
      g = drive * acc + -0.43;
      this.dirty = false;
      this.recompute(res, acc);
      d1 = this.c0;
    } else if (this.lastAcc !== acc) {
      g = drive * acc + -0.43;
      this.recompute(res, acc);
      d1 = this.c0;
    } else {
      g = drive * acc + -0.43;
      d1 = this.c0;
    }
    const v1 = this.v1, v2 = this.v2;
    const thr = (v2 - v1) * d1 + v1;
    let r: number;
    if (g > thr) {
      const d0 = (g - v1) * this.c8 + v1;
      const nv2 = (d0 - v2) * this.k38 + v2;
      this.v2 = nv2;
      r = (d0 - nv2) * this.c10 + nv2;
    } else {
      const nv2 = (v1 - v2) * this.k40 + v2;
      this.v2 = nv2;
      r = (nv2 - v1) * this.c18 + v1;
    }
    this.out = r;
    return f32(r);
  }

  private recompute(res: number, acc: number): void {
    this.lastRes = res;
    this.lastAcc = acc;
    const ra = acc * 50000, rb = (1 - acc) * 50000;
    const rp = (ra * rb) / (ra + rb);
    const r3 = res * 50000, r4 = (1 - res) * 50000;
    const rtot = rp + 47000 + r3;
    const d13 = r4 + 1 / (1 / rtot + 1e-5);
    const d15 = r4 + 100000;
    this.k38 = 1 - Math.pow(0.37, 1 / (d13 * 1e-6 * this.sr));
    this.k40 = 1 - Math.pow(0.37, 1 / (d15 * 1e-6 * this.sr));
    const d1 = 100000 / d15;
    this.c0 = d1;
    this.c8 = 100000 / (rtot + 100000);
    this.c10 = r4 / d13;
    this.c18 = d1;
  }
}

/** TB-303 diode ladder (Open303 TeeBeeFilter, TB_303 mode) with a 160 Hz feedback high-pass. */
export class TeeBee {
  maxFc = 0;
  invSrSqrt2 = 0;
  b0 = 0; k = 0; g2 = 0;
  y1 = 0; y2 = 0; y3 = 0; y4 = 0;
  readonly hp = new OnePole();

  setSampleRate(sr: number): void {
    this.maxFc = sr * 0.4;
    this.invSrSqrt2 = 1 / (sr * 1.4142135623730951);
    this.hp.setSampleRate(sr);
    this.hp.setHP(160);
  }

  set(fcIn: number, res: number): void {
    let fc = fcIn;
    if (fc < 11) fc = 11;
    else if (this.maxFc < fc) fc = f32(this.maxFc);
    const wc = this.invSrSqrt2 * fc;
    this.b0 = (0.0004552234600001 + wc * 6.192218900001) / (1.000001 + wc * 12.35835400001 + (wc * wc) * 4.415634500001);
    const kk = wc * (wc * (wc * (wc * (wc * (wc + 7198.699700001) + -5837.791700001) + -476.4730800001) + 614.9561100001) + 213.8712600001) + 16.99879200001;
    const r = res;
    let g = (kk * 0.058823529411764705 + -1) * r + 1;
    g = (r + 1) * g;
    this.g2 = g + g;
    this.k = kk * r;
  }

  tick(x: number): number {
    const fb = this.hp.tick(f32(this.k * this.y4));
    const y0 = f32(x - fb);
    const b0 = this.b0;
    const y1 = (y0 - this.y1 + this.y2) * b0 * 2 + this.y1;
    const y2 = b0 * (this.y2 * -2 + y1 + this.y3) + this.y2;
    this.y1 = y1; this.y2 = y2;
    const y3 = b0 * (this.y3 * -2 + y2 + this.y4) + this.y3;
    const y4 = b0 * (this.y4 * -2 + y3) + this.y4;
    this.y3 = y3; this.y4 = y4;
    return f32(this.g2 * y4);
  }

  reset(): void { this.y1 = this.y2 = this.y3 = this.y4 = 0; this.hp.reset(); }
}

const DRIVE_LP = [16000, 5000, 2500, 1500, 900, 600];

/** FL's RAT-style distortion (TB303Engine2 +0xeac). */
export class Distortion {
  readonly hp0 = new OnePole();
  readonly hp1 = new OnePole();
  readonly hpUser = new OnePole();
  readonly lpDrive = new OnePole();
  readonly lpTone = new OnePole();
  drive = 0;
  hpVal = 0;
  prev = 0;
  slew = 0;
  gain = 1;
  vol = 4;
  outGain = 0;

  constructor() {
    this.setSampleRate(44100);
    this.hp0.setHP(7.2);
    this.hp1.setHP(60);
    this.setDrive(0);
    this.lpTone.setLP(19475);
    this.hpVal = 0;
    this.hpUser.setHP(10);
    this.vol = 4;
    this.updateOut();
  }

  setSampleRate(sr: number): void {
    for (const f of [this.hp0, this.hp1, this.hpUser, this.lpDrive, this.lpTone]) f.setSampleRate(sr);
    this.slew = f32(300000 / sr);
  }

  private updateOut(): void {
    const e = f32(Math.exp(f32(this.drive * f32(-11.834190368652344))));
    const c = f32(f32(f32(1 - e) * f32(-0.9819049835205078)) + f32(1.0041040182113647));
    this.outGain = f32(f32(this.hpVal + 1) * f32(this.vol * c));
  }

  /** Drive (FL passes the knob value squared). */
  setDrive(d: number): void {
    this.drive = f32(d);
    const x = f32(this.drive * f32(4.999000072479248));
    const i = Math.trunc(x);
    const fr = f32(x - i);
    const fc = f32(DRIVE_LP[i] * f32(1 - fr) + f32(fr * DRIVE_LP[i + 1]));
    this.lpDrive.setLP(fc);
    this.gain = f32(f32(f32(this.drive * this.drive) * this.drive) * 2305 + 1);
    this.updateOut();
  }

  setHP(v: number): void {
    this.hpVal = f32(v);
    this.hpUser.setHP(f32(f32(f32(v * 3000) * v) + 10));
    this.updateOut();
  }

  setTone(v: number): void {
    this.lpTone.setLP(f32(f32(f32(v * 19000) * v) + 475));
  }

  setVolume(v: number): void {
    this.vol = f32(Math.pow(2, f32(f32(f32(v + -0.5) * 2) * 2)));
    this.updateOut();
  }

  tick(x: number): number {
    let s = this.hp0.tick(f32(this.gain * x));
    s = this.hp1.tick(s);
    s = this.hpUser.tick(s);
    s = this.lpDrive.tick(s);
    let d = f32(s - this.prev);
    const lim = this.slew;
    if (d < -lim) d = -lim; else if (d > lim) d = lim;
    let v = f32(this.prev + d);
    if (v < -4.5) v = -4.5; else if (v > 4.5) v = 4.5;
    this.prev = v;
    const t = this.lpTone.tick(f32(Math.tanh(v)));
    return f32(t * this.outGain);
  }

  reset(): void {
    for (const f of [this.hp0, this.hp1, this.hpUser, this.lpDrive, this.lpTone]) f.reset();
    this.prev = 0;
  }
}

/** Mip-mapped wavetable oscillator (TB303Engine2 +0x970). */
export class WaveOsc {
  readonly tables = tbWavetables();
  phase = 0;
  inc = 0;
  pw = f32(0.5);
  saw = 0;
  table: Float32Array;
  len: number;
  sr = 44100;
  invSr = 1 / 44100;
  levelOffset = 0;

  constructor() {
    this.table = this.tables.tables[0];
    this.len = this.tables.lengths[0];
  }

  setSampleRate(sr: number): void {
    this.sr = sr;
    this.invSr = 1 / sr;
    const len0 = this.tables.lengths[0] / 16;
    this.levelOffset = Math.log((sr * 0.9) / len0 / 8.1757989156) / -0.6931471805599453 / 12;
  }

  /** Frequency from the normalised pitch (note / 144). */
  setPitch(p: number): void {
    const pf = f32(p);
    const e = f32(Math.pow(2, f32(12 * pf)));
    const f = f32(8.1757989156 * e);
    this.inc = f32(this.invSr * f);
    let lvl = Math.trunc((this.levelOffset + pf) * 48);
    if (lvl > 47) lvl = 47;
    if (lvl < 0) lvl = 0;
    this.table = this.tables.tables[lvl];
    this.len = this.tables.lengths[lvl];
  }

  /** Pulse (saw(phase) - saw(phase + pw)); the saw is left in `saw`. */
  tickPulse(): number {
    const ph = this.phase;
    const len = this.len, t = this.table;
    const p1 = ph * len;
    const i = Math.trunc(p1);
    let q = ph + this.pw;
    q -= Math.trunc(q);
    const p2 = len * q;
    const j = Math.trunc(p2);
    const fa = f32(p1 - i);
    const sa = f32(t[i + 1] * f32(1 - fa) + f32(t[i + 2] * fa));
    this.saw = sa;
    const fb = f32(p2 - j);
    const sb = f32(t[j + 1] * f32(1 - fb) + f32(t[j + 2] * fb));
    let np = ph + this.inc;
    np -= Math.trunc(np);
    this.phase = np;
    return f32(sa - sb);
  }

  /** Saw only (used with the 303 pulse model). */
  tickSaw(): number {
    const ph = this.phase;
    const p1 = ph * this.len;
    const i = Math.trunc(p1);
    const fa = f32(p1 - i);
    const t = this.table;
    const sa = f32(t[i + 1] * f32(1 - fa) + f32(t[i + 2] * fa));
    let np = ph + this.inc;
    np -= Math.trunc(np);
    this.phase = np;
    return sa;
  }
}

/**
 * The "303 Pulse" oscillator. FL's plugin plays single cycles recorded from a
 * TB-303 (55 tables in its engine binary, chosen by period at each cycle
 * start; not copied here). This synthesized substitute models the 303's
 * square: a flat low half and a high half that sags through the coupling
 * capacitor (RC 12.5 ms), DC-free with FL's ~1.95 peak-to-peak (it fits FL's
 * mid-range tables, e.g. 83 Hz: low -0.86, high 1.08 -> 0.67).
 */
export class Pulse303 {
  phase = 0;
  inc = 0;
  invSr = 1 / 44100;
  freq = 65;
  private lo = -0.86;
  private hi = 1.09;
  private k = 0;
  setSampleRate(sr: number): void { this.invSr = 1 / sr; }
  setPitch(p: number): void {
    const f = 8.1757989156 * f32(Math.pow(2, f32(12 * f32(p))));
    this.inc = this.invSr * f;
    if (f !== this.freq) {
      this.freq = f;
      const T = 1 / Math.max(1, f);
      const tau = 0.0125;
      const q = (tau / T) * (1 - Math.exp(-T / (2 * tau)));
      this.hi = 1.95 / (1 + 2 * q);
      this.lo = -2 * this.hi * q;
      this.k = T / tau;
    }
  }
  tick(): number {
    const ph = this.phase;
    const v = ph < 0.5 ? this.lo : this.hi * Math.exp(-(ph - 0.5) * this.k);
    let np = ph + this.inc;
    np -= Math.trunc(np);
    this.phase = np;
    return f32(v);
  }
}

const DECAY_TBL = [0.1850000023841858, 0.20399999618530273, 0.2329999953508377, 0.3540000021457672, 0.45500001311302185, 0.5379999876022339, 0.652999997138977, 0.9409999847412109, 1.4299999475479126, 2.121999979019165, 2.2249999046325684];
const RES_TBL = [0.0, 0.10300000011920929, 0.38999998569488525, 0.5910000205039978, 1.0019999742507935];
const CUT_TBL = [0.3330000042915344, 0.3709999918937683, 0.44699999690055847, 0.5329999923706055, 0.6299999952316284];
const ENV_TBL = [0.091796875, 0.12800000607967377, 0.169097900390625, 0.2709999978542328, 0.550000011920929];

function tbl4(t: number[], v: number, top: number): number {
  if (v >= 1) return top;
  const x = f32(v * 4);
  const i = Math.trunc(v * 4);
  const fr = f32(x - Math.trunc(x));
  return f32(t[i] * f32(1 - fr) + f32(fr * t[i + 1]));
}

/**
 * The TB303Engine2 voice. `mode303` = the "V2 TB303 cutoff range" engine
 * (FL's mode flag 0), false = "V2 Extended cutoff range" (flag 1, FL's
 * default).
 */
/** Common interface of FL's two TB-303 engines. */
export interface TbVoiceEngine {
  readonly P: Float32Array;
  bend: number;
  noteOffset: number;
  cutMod: number;
  resMod: number;
  seqTranspose: number;
  setSampleRate(sr: number): void;
  setParam(i: number, v: number): void;
  noteOn(note: number, slide: boolean, accent: boolean): void;
  noteOff(): void;
  tick(): number;
  reset(): void;
}

export class TbEngine implements TbVoiceEngine {
  readonly P = new Float32Array(64);
  sr = 44100;
  srOs = 44100 * OS;
  extended = true;
  // engine values (FL offsets 0x418 + 4 i)
  tuning = 0.5; wave = 0; cutoff = 0.35; keyFollow = 0.5; reso = 0.39;
  volume = 0.375; pwBase = 0.545; lfoAmt = 0; lfoInc = 0;
  envMod = 0.441796875;
  decayKnob = 0.5;
  minDecay = 0.185;
  decayCoef = 0;
  accentDecayCoef = 0;
  vcaAtk = 0; vcaRel = 0; clickCoef = 0;
  glideTimes = [0.0001, 0.05];
  glideCoef = [0, 0];
  glideSel = 0;
  // state
  pitchCur = 0;
  pitchTarget = 0;
  /** Pitch bend (semitones, FL's FPE_MIDI_Pitch). */
  bend = 0;
  /** Per-note pitch offset (semitones) and cutoff offset (Mod X), sequencer transpose. */
  noteOffset = 0;
  cutMod = 0;
  /** Mod Y (unused by the V2 engine). */
  resMod = 0;
  seqTranspose = 0;
  fEnv = 0;
  fEnvOut = 0;
  gate = false;
  accent = false;
  lfoPhase = 0;
  vca1 = 0;
  vca2 = 0;
  pulse303 = false;
  distOn = false;
  readonly env1 = new AmpEnv(0.0007709750566893424, 0.5, 0.01, 3.2, 0.1);
  readonly env2 = new AmpEnv(0.0007709750566893424, 0.5, 0.007, 0.2, 0.15);
  readonly env3 = new AmpEnv(0.0007709750566893424, 0.5, 0.01, 0.185, 0.1);
  readonly sweep = new AccentSweep();
  readonly osc = new WaveOsc();
  readonly p303 = new Pulse303();
  readonly filter = new TeeBee();
  readonly hp = new OnePole();
  readonly dist = new Distortion();
  readonly dec1 = new HalfBand();
  readonly dec2 = new HalfBand();
  private readonly buf = new Float64Array(OS);

  constructor(sampleRate: number, extended = true) {
    this.extended = extended;
    this.env2.out = 0; this.env3.out = 0; this.env1.out = 0;
    this.hp.setHP(200);
    this.setSampleRate(sampleRate);
    // FL's engine constructor defaults (the plugin then applies its patch)
    this.setParam(6, 0.5); this.setParam(1, 0); this.setParam(9, 0.5); this.setParam(2, 1);
    this.setParam(11, f32(0.2)); this.setParam(8, 0.5); this.setParam(7, 0.5); this.setParam(5, 0.5);
    this.setParam(10, 0.5); this.setParam(13, 0); this.setParam(12, 0.5);
  }

  setSampleRate(sr: number): void {
    this.sr = sr;
    this.srOs = OS * sr;
    for (let i = 0; i < 2; i++) this.glideCoef[i] = 1 - Math.pow(0.1, 1 / (this.glideTimes[i] * sr));
    this.env1.setSampleRate(sr); this.env2.setSampleRate(sr); this.env3.setSampleRate(sr);
    this.updateClicks();
    this.hp.setSampleRate(this.srOs);
    this.filter.setSampleRate(this.srOs);
    this.osc.setSampleRate(this.srOs);
    this.p303.setSampleRate(this.srOs);
    this.sweep.sr = sr;
    this.sweep.dirty = true;
    this.decayCoef = Math.pow(0.1, 1 / (sr * this.minDecay));
    this.accentDecayCoef = this.decayCoef;
    this.vcaAtk = 1 - Math.pow(0.1, 1 / (sr * 0.0003));
    this.vcaRel = 1 - Math.pow(0.1, 1 / (sr * 0.01));
    this.dist.setSampleRate(this.srOs);
    this.lfoInc = f32(f32(f32(this.P[12] * f32(9.899999618530273)) + f32(0.10000000149011612)) * (1 / sr));
  }

  private updateClicks(): void {
    const c = this.P[40];
    const t = (f32(f32(c * c) * c)) * 0.05 + 0.0001;
    this.clickCoef = 1 - Math.pow(0.1, 1 / (this.sr * t));
  }

  private decayTime(): number {
    const k = this.decayKnob;
    let s3: number;
    if (k >= 1) s3 = f32(2.2249999046325684);
    else {
      const x = f32(k * 10);
      const i = Math.trunc(x);
      const fr = f32(x - Math.trunc(x));
      s3 = f32(DECAY_TBL[i] * f32(1 - fr) + f32(fr * DECAY_TBL[i + 1]));
    }
    const d2 = f32(this.minDecay / 0.1850000023841858);
    return f32(f32(f32(d2 * f32(1 - k)) + k) * s3);
  }

  /** FL's engine parameter setter (index = FL parameter index, value 0..1). */
  setParam(i: number, v: number): void {
    v = f32(v);
    this.P[i] = v;
    switch (i) {
      case 0: this.tuning = v; break;
      case 1: this.wave = v; break;
      case 2: this.cutoff = this.extended ? f32(v * f32(0.699999988079071)) : tbl4(CUT_TBL, v, f32(0.6299999952316284)); break;
      case 3: this.keyFollow = v; break;
      case 4: this.reso = tbl4(RES_TBL, v, f32(1.0019999742507935)); break;
      case 5: this.envMod = this.extended ? f32(v * f32(0.699999988079071) + f32(0.091796875)) : tbl4(ENV_TBL, this.P[5], f32(0.550000011920929)); break;
      case 6:
        this.decayKnob = v;
        this.decayCoef = Math.pow(0.1, 1 / (this.decayTime() * this.sr));
        break;
      case 8: this.volume = f32(f32(v * 0.25) * 3); break;
      case 9: this.hp.setHP(f32(v * 390 + 10)); break;
      case 10: {
        const md = f32(f32(f32(v + -0.5) * f32(0.10000000149011612)) + f32(0.1850000023841858));
        this.minDecay = md;
        this.decayCoef = Math.pow(0.1, 1 / (this.decayTime() * this.sr));
        const t = f32(f32(f32(md / f32(0.1850000023841858)) + 0) * f32(0.1850000023841858));
        this.accentDecayCoef = Math.pow(0.1, 1 / (this.sr * t));
        break;
      }
      case 11: this.pwBase = f32(v * f32(0.44999998807907104) + 0.5); break;
      case 12: this.lfoInc = f32(f32(f32(v * f32(9.899999618530273)) + f32(0.10000000149011612)) * (1 / this.sr)); break;
      case 13: this.lfoAmt = f32(v * f32(0.23999999463558197)); break;
      case 27: this.distOn = v >= 0.5; break;
      case 28: this.dist.setHP(v); break;
      case 29: this.dist.setDrive(f32(v * v)); break;
      case 30: this.dist.setTone(v); break;
      case 31: this.dist.setVolume(v); break;
      case 40: this.updateClicks(); break;
      case 41: this.pulse303 = v >= 0.5; break;
      default: break;
    }
  }

  /** Note on (FL's engine 0x8444): note 0..127, slide (legato) and accent flags. */
  noteOn(note: number, slide: boolean, accent: boolean): void {
    this.accent = accent;
    this.gate = true;
    const n = note < 0 ? 0 : note > 127 ? 127 : note;
    if (!slide) {
      this.env1.trigger();
      this.fEnv = 1;
      if (accent) { this.env2.trigger(); this.env3.trigger(); }
    }
    this.glideSel = slide ? 1 : 0;
    this.pitchTarget = n;
  }

  /** Gate off (FL's engine 0x8428). */
  noteOff(): void {
    this.gate = false;
    this.env1.release();
    this.env2.release();
  }

  tick(): number {
    // pulse width LFO
    const lph = this.lfoPhase;
    const lfo = f32(Math.sin(f32(lph * f32(6.2831854820251465))));
    let nph = f32(this.lfoInc + lph);
    nph = f32(nph - Math.trunc(nph));
    this.lfoPhase = nph;
    // pitch glide
    this.pitchCur = this.pitchCur + (this.pitchTarget - this.pitchCur) * this.glideCoef[this.glideSel];
    let d0 = this.pitchCur + this.bend + -64 + 24 + 4;
    d0 = this.tuning * 24 + d0;
    d0 += this.noteOffset;
    d0 += this.seqTranspose;
    const pn = d0 < 0 ? 0 : Math.min(d0, 144) / 144;
    // filter envelope
    const env = (this.accent ? this.accentDecayCoef : this.decayCoef) * this.fEnv;
    this.fEnv = env;
    this.fEnvOut = env;
    const accRaw = this.P[7];
    const drive = this.accent ? f32(f32(env * accRaw) * 10) : 0;
    const sw = this.sweep.tick(this.P[4], accRaw, drive);
    const wow = (sw + -3.25) * 0.1 * 1.33;
    let pw = f32(lfo * this.lfoAmt + this.pwBase);
    if (pw < f32(0.0010000000474974513)) pw = f32(0.0010000000474974513);
    else if (pw > f32(0.9990000128746033)) pw = f32(0.9990000128746033);
    this.osc.pw = pw;
    const wowF = f32(wow);
    if (this.pulse303) this.p303.setPitch(pn);
    this.osc.setPitch(pn);
    let c = f32((env + -0.32499998807907104) * this.envMod);
    c = f32(wowF * 0.75 + c);
    c = f32(this.cutoff + c);
    c = f32(c + f32(0.10000000149011612));
    c = f32(pn * f32(this.keyFollow + -0.5) + c);
    c = f32(this.cutMod + c);
    const fc = f32(Math.pow(2, c * 128 * 0.08333333333333333) * 8.1757989156);
    this.filter.set(fc, this.reso);
    // VCA
    const e1 = this.env1.tick();
    const e2 = f32(f32(this.env2.tick() * 3) * accRaw);
    let e3 = Math.min(f32(f32(this.env3.tick() * 1.75) * accRaw), 1);
    if (this.gate) e3 = 0;
    const tgt = Math.max(e3, e1 > e2 ? e1 : e2);
    const v1 = this.vca1;
    this.vca1 = v1 + (tgt - v1) * (v1 < tgt ? this.vcaAtk : this.vcaRel);
    this.vca2 = this.vca2 + (this.vca1 - this.vca2) * this.clickCoef;
    // oversampled audio
    const wv = this.wave, wv1 = f32(1 - wv), vca = this.vca2, vol = this.volume;
    for (let k = 0; k < OS; k++) {
      let s: number;
      if (this.pulse303) {
        const saw = this.osc.tickSaw();
        const p = this.p303.tick();
        s = f32(p * wv1 + f32(saw * wv));
      } else {
        const p = this.osc.tickPulse();
        s = f32(p * wv1 + f32(wv * this.osc.saw));
      }
      s = this.filter.tick(-s);
      s = f32(vca * s);
      s = this.hp.tick(s);
      s = f32(s * vol);
      if (this.distOn) s = this.dist.tick(s);
      this.buf[k] = s;
    }
    this.dec1.tick(this.buf[0]);
    const a = this.dec1.tick(this.buf[1]);
    this.dec1.tick(this.buf[2]);
    const b = this.dec1.tick(this.buf[3]);
    this.dec2.tick(f32(a));
    return f32(this.dec2.tick(f32(b)));
  }

  reset(): void {
    this.filter.reset(); this.hp.reset(); this.dist.reset(); this.dec1.reset(); this.dec2.reset();
    this.vca1 = 0; this.vca2 = 0; this.fEnv = 0;
  }
}

/** Parameters FL applies at once (switches); the others go through the smoother. */
const TB_SWITCHES = new Set([14, 32, 33, 41]);

/**
 * FL's parameter smoother (TB's plugin +0x1f0): pending parameter targets are
 * moved every 16 samples by a one-pole step, coefficient
 * 1 - 0.01^(1 / (0.005 sr)) (computed per sample, applied per 16 samples), and
 * snap to the target within 1e-4. At most 16 parameters are pending; the rest
 * apply at once.
 */
export class TbSmoother {
  readonly idx = new Int32Array(16);
  readonly target = new Float32Array(16);
  count = 0;
  coef = 0;
  counter = 0;
  setSampleRate(sr: number): void {
    this.coef = f32(1 - Math.pow(0.01, 1 / (sr * 0.005)));
  }
  /** Queue a parameter change; returns false when it must apply at once. */
  add(i: number, v: number): boolean {
    for (let k = 0; k < this.count; k++) if (this.idx[k] === i) { this.target[k] = f32(v); return true; }
    if (this.count >= 16) return false;
    this.idx[this.count] = i;
    this.target[this.count] = f32(v);
    this.count++;
    return true;
  }
  /** One 16-sample step: cur(i) reads the applied value, set(i, v) applies. */
  step(cur: (i: number) => number, set: (i: number, v: number) => void): void {
    for (let k = 0; k < this.count;) {
      const i = this.idx[k];
      const c = cur(i);
      const t = this.target[k];
      const nv = f32(f32((t - c) * this.coef) + c);
      if (Math.abs(f32(nv - t)) < f32(9.999999747378752e-05)) {
        set(i, t);
        for (let m = k + 1; m < this.count; m++) { this.idx[m - 1] = this.idx[m]; this.target[m - 1] = this.target[m]; }
        this.count--;
      } else {
        set(i, nv);
        k++;
      }
    }
  }
  isSwitch(i: number): boolean { return TB_SWITCHES.has(i); }
}

const f32b = Math.fround;

/**
 * FL's "V1 Legacy" engine (TB303Engine1): the first Transistor Bass voice,
 * which FL selects for states saved before engine choice existed (all three
 * factory presets). Same oscillator, filter, high-pass and distortion; its own
 * cutoff / envelope laws, accent circuit and a per-oversampled-sample VCA.
 */
export class TbEngineV1 implements TbVoiceEngine {
  readonly P = new Float32Array(64);
  sr = 44100;
  srOs = 44100 * OS;
  tuning = 0.5; wave = 0; cutoff = 0; keyFollow = 0.5; reso = 0.5;
  envModAmt = 0; envModOff = 1; accentAmt = 0.25; volume = 0.375;
  pwBase = 0.545; lfoAmt = 0; lfoInc = 0;
  minDecay = 0.185; maxDecay = 2.16; decayT = 0.185;
  accAtkT = 0.05; accRelT = 0.2; accAtk = 0; accRel = 0;
  vcaAtkT = 0.005; vcaRelT = 0.005; vcaAtk = 1; vcaRel = 1;
  ampDecayT = 1; ampCoef = 0;
  accLo = 0.7400000095367432; accHi = 2.5999999046325684;
  glideTimes = [0.0001, 0.05];
  glideCoef = [0, 0];
  glideSel = 0;
  pitchCur = 0; pitchTarget = 0;
  bend = 0; noteOffset = 0; cutMod = 0; resMod = 0; seqTranspose = 0;
  fEnv = 0; ampEnv = 0; accSm = 0; vca = 0;
  gate = false; accent = false;
  lfoPhase = 0;
  pulse303 = false; distOn = false;
  readonly osc = new WaveOsc();
  readonly p303 = new Pulse303();
  readonly filter = new TeeBee();
  readonly hp = new OnePole();
  readonly dist = new Distortion();
  readonly dec1 = new HalfBand();
  readonly dec2 = new HalfBand();
  private readonly buf = new Float64Array(OS);

  constructor(sampleRate: number) {
    this.hp.setHP(200);
    this.setSampleRate(sampleRate);
    this.setParam(6, 0.5); this.setParam(1, 0); this.setParam(9, 0.5); this.setParam(2, 1);
    this.setParam(11, f32b(0.2)); this.setParam(8, 0.5); this.setParam(7, 0.5); this.setParam(5, 0.5);
    this.setParam(10, 0.5); this.setParam(13, 0); this.setParam(12, 0.5);
  }

  setSampleRate(sr: number): void {
    this.sr = sr;
    this.srOs = OS * sr;
    for (let i = 0; i < 2; i++) this.glideCoef[i] = 1 - Math.pow(0.1, 1 / (this.glideTimes[i] * sr));
    this.vcaAtk = 1 - Math.pow(0.1, 1 / (this.vcaAtkT * this.srOs));
    this.vcaRel = 1 - Math.pow(0.1, 1 / (this.vcaRelT * this.srOs));
    this.hp.setSampleRate(this.srOs);
    this.filter.setSampleRate(this.srOs);
    this.osc.setSampleRate(this.srOs);
    this.p303.setSampleRate(this.srOs);
    this.accAtk = 1 - Math.pow(0.1, 1 / (this.accAtkT * sr));
    this.accRel = 1 - Math.pow(0.1, 1 / (this.accRelT * sr));
    this.ampCoef = Math.pow(0.1, 1 / (this.ampDecayT * this.srOs));
    this.dist.setSampleRate(this.srOs);
    this.lfoInc = f32b(f32b(f32b(this.P[12] * f32b(9.899999618530273)) + f32b(0.10000000149011612)) * (1 / sr));
  }

  setParam(i: number, v: number): void {
    v = f32b(v);
    this.P[i] = v;
    switch (i) {
      case 0: this.tuning = v; break;
      case 1: this.wave = v; break;
      case 2: this.cutoff = f32b(f32b(f32b(Math.pow(v, 1.5)) * f32b(0.5799999833106995)) + f32b(0.10000000149011612)); break;
      case 3: this.keyFollow = v; break;
      case 4: this.reso = v; break;
      case 5: {
        const q = f32b(v * v);
        this.envModAmt = f32b(f32b(q * f32b(0.5400000214576721)) + f32b(0.1599999964237213));
        this.envModOff = f32b(f32b(q * f32b(-0.3100000023841858)) + 1);
        break;
      }
      case 6: {
        const q = f32b(v * v);
        this.decayT = (this.maxDecay - this.minDecay) * q + this.minDecay;
        break;
      }
      case 7: this.accentAmt = f32b(v * v); break;
      case 8: this.volume = f32b(f32b(v * 0.25) * 3); break;
      case 9: this.hp.setHP(f32b(v * 390 + 10)); break;
      case 10: {
        this.minDecay = f32b(v * f32b(0.1850000023841858) + f32b(0.1850000023841858));
        const q = f32b(this.P[6] * this.P[6]);
        this.decayT = (this.maxDecay - this.minDecay) * q + this.minDecay;
        break;
      }
      case 11: this.pwBase = f32b(v * f32b(0.44999998807907104) + 0.5); break;
      case 12: this.lfoInc = f32b(f32b(f32b(v * f32b(9.899999618530273)) + f32b(0.10000000149011612)) * (1 / this.sr)); break;
      case 13: this.lfoAmt = f32b(v * f32b(0.23999999463558197)); break;
      case 27: this.distOn = v >= 0.5; break;
      case 28: this.dist.setHP(v); break;
      case 29: this.dist.setDrive(f32b(v * v)); break;
      case 30: this.dist.setTone(v); break;
      case 31: this.dist.setVolume(v); break;
      case 40: {
        const q = f32b(v * v);
        this.vcaAtkT = q * 0.01 + 0.005;
        this.vcaRelT = q * 0.045 + 0.005;
        this.vcaAtk = 1 - Math.pow(0.1, 1 / (this.vcaAtkT * this.srOs));
        this.vcaRel = 1 - Math.pow(0.1, 1 / (this.vcaRelT * this.srOs));
        break;
      }
      case 41: this.pulse303 = Math.round(v) >= 1; break;
      default: break;
    }
  }

  noteOn(note: number, slide: boolean, accent: boolean): void {
    this.gate = true;
    const n = note < 0 ? 0 : note > 127 ? 127 : note;
    this.accent = accent;
    if (!slide) { this.fEnv = 1; this.ampEnv = 1; }
    this.glideSel = slide ? 1 : 0;
    this.pitchTarget = n;
  }

  noteOff(): void { this.gate = false; }

  tick(): number {
    const lph = this.lfoPhase;
    const lfo = f32b(Math.sin(f32b(lph * f32b(6.2831854820251465))));
    let nph = f32b(this.lfoInc + lph);
    nph = f32b(nph - Math.trunc(nph));
    this.lfoPhase = nph;
    this.pitchCur = this.pitchCur + (this.pitchTarget - this.pitchCur) * this.glideCoef[this.glideSel];
    let d0 = this.pitchCur + this.bend + -64 + 24 + 4;
    d0 = this.tuning * 24 + d0;
    d0 += this.noteOffset;
    d0 += this.seqTranspose;
    const pn = d0 < 0 ? 0 : Math.min(d0, 144) / 144;
    const T = this.accent ? this.minDecay : this.decayT;
    const coef = Math.pow(0.1, 1 / (T * this.sr));
    const env = coef * this.fEnv;
    this.fEnv = env;
    this.ampEnv = this.ampEnv * this.ampCoef;
    const s2 = f32b(f32b(f32b(1 - this.reso) * -0.5) + 1);
    const s0 = f32b(1 - s2);
    const s1 = this.accent ? f32b((env * this.accentAmt) * s2) : 0;
    const a = this.accSm;
    this.accSm = a + (s1 - a) * (a >= s1 ? this.accRel : this.accAtk);
    const wow = f32b(this.accSm + f32b(f32b(s0 * s1) * 6));
    let pw = f32b(lfo * this.lfoAmt + this.pwBase);
    if (pw < f32b(0.0010000000474974513)) pw = f32b(0.0010000000474974513);
    else if (pw > f32b(0.9990000128746033)) pw = f32b(0.9990000128746033);
    this.osc.pw = pw;
    if (this.pulse303) this.p303.setPitch(pn);
    this.osc.setPitch(pn);
    let c = f32b(env * this.envModAmt + f32b(this.envModOff * this.cutoff) + f32b(wow * f32b(0.23000000417232513)));
    c = f32b(c + f32b(-0.019999999552965164));
    c = f32b(pn * f32b(this.keyFollow + -0.5) + c);
    c = f32b(this.cutMod + c);
    const fc = f32b(Math.pow(2, c * 128 * 0.08333333333333333) * 8.1757989156);
    let r = f32b(this.reso + this.resMod);
    if (r < 0) r = 0; else if (r > 1) r = 1;
    this.filter.set(fc, r);
    const wv = this.wave, wv1 = f32b(1 - wv), vol = this.volume;
    for (let k = 0; k < OS; k++) {
      let s: number;
      if (this.pulse303) {
        const saw = this.osc.tickSaw();
        const p = this.p303.tick();
        s = f32b(p * wv1 + f32b(saw * wv));
      } else {
        const p = this.osc.tickPulse();
        s = f32b(p * wv1 + f32b(wv * this.osc.saw));
      }
      s = this.filter.tick(s);
      if (this.gate) {
        let lvl = 0;
        if (this.accent) {
          const g = f32b((this.accHi - this.accLo) * this.accentAmt + this.accLo);
          lvl = f32b(this.fEnv * g + this.accLo);
        }
        if (this.ampEnv > lvl) lvl = f32b(this.ampEnv);
        this.vca = this.vca + (lvl - this.vca) * this.vcaAtk;
      } else {
        this.vca = this.vca + (0 - this.vca) * this.vcaRel;
      }
      s = f32b(this.vca * s);
      s = this.hp.tick(s);
      s = f32b(s * vol);
      if (this.distOn) s = this.dist.tick(s);
      this.buf[k] = s;
    }
    this.dec1.tick(this.buf[0]);
    const a1 = this.dec1.tick(this.buf[1]);
    this.dec1.tick(this.buf[2]);
    const b1 = this.dec1.tick(this.buf[3]);
    this.dec2.tick(f32b(a1));
    return f32b(this.dec2.tick(f32b(b1)));
  }

  reset(): void {
    this.filter.reset(); this.hp.reset(); this.dist.reset(); this.dec1.reset(); this.dec2.reset();
    this.vca = 0; this.fEnv = 0; this.ampEnv = 0; this.accSm = 0;
  }
}
