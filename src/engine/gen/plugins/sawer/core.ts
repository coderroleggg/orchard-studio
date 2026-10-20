// Sawer synthesizer core, ported from FL 2026's Sawer engine library (SawerSynth /
// CSawerGenerator on Image-Line's CSynth / CVoiceGenerator classes) by static analysis
// only: Sawer renders silence in FL's test host (licence check), so nothing here could be
// compared with FL's output. The CSynth layer (note handling, voice allocation, mono /
// legato / glide, arpeggiator, master gain) is PoiZone's verified port: FL's code for it
// is identical in both engines.
// - 24 generators (+1 spare that pads the four-voice groups); a block of n samples renders
//   the first min(polyphony, host max) sounding voices only;
// - per control step (sr / 1000 + 2 samples) each voice evaluates its envelopes (one-pole,
//   attack towards 5 x velocity), the global LFO (triangle / saw / square / random, free or
//   tempo-synced, attack / release fades, seven destinations), the filter envelope (four
//   destinations), a slow random pitch drift, and sets its 24-bit phase increments at 6x
//   the sample rate;
// - per 6x sample: saw from table 1 (8192 points, FL's data.saw), sub oscillator from
//   table 1 or 2 (table1 - table1 shifted by half a cycle) at a ratio with phase offset,
//   hard sync (a master phase resets both), noise and +-3 % dither (LCG, once per output
//   sample), a 4-pole ladder evaluated three times per sample with a 1 / (1 + 5 x^4)
//   saturation and resonance, LP24 / LP12 / BP / HP taps, smoothed stereo gains;
// - decimation by a biquad low-pass per channel (6 samples in, 1 out), a 4 Hz DC blocker
//   (FL shares one filter state between the left and right samples), the effect chain,
//   the arpeggiator and the master gain / pan.

import { f32, fma, fms, fnms, fmaD, dn, PzRand64 } from '../poizone/dsp';
import { exp2f, exp10f, sincosf } from '../poizone/applemath';
import { PzArpLike } from './arp';
import { SwFx } from './fx';
import { SW_TABLE_SIZE, swDerivedTable, swSubstituteTable } from './tables';

const LCG_A = 0x0bb38435;
const LCG_C = 0x3619636b;
const lcg = (s: number): number => (Math.imul(s, LCG_A) + LCG_C) >>> 0;
/** The generators' phase reset LCG (FL: x * 0x77a73631 + 0xf6ff3a94 on the same global seed). */
const lcgP = (s: number): number => (Math.imul(s, 0x77a73631) + 0xf6ff3a94) >>> 0;
const U32 = 2.3283064365386963e-10;
const N2P31 = 4.656612873077393e-10; // 2^-31
const F1E7 = f32(1e-7);
const F0_06 = f32(0.05999999865889549);
const F0_35 = f32(-0.3499999940395355);
const NGEN = 24;

/** CSawerGenerator. */
export class SwGen {
  readonly synth: SwSynth;
  readonly id: number;
  // CVoiceGenerator
  note = -1;
  uniIdx = 0;
  uniCnt = 1;
  det = 0;
  sr = 44100;
  vel = 0;
  released = false;
  glideRate = 0;
  glide = 0;
  age = 0;
  // CSawerGenerator
  relT = 0;
  t = 0;
  p1 = 0; i1 = 0; p2 = 0; i2 = 0; p3 = 0; i3 = 0; subOfs = 0;
  gL = 0; gR = 0; gTL = 0; gTR = 0;
  f1 = 0; f2 = 0; f3 = 0; f4 = 0; f5 = 0; fAvg = 0;
  cut = 0; cutT = 0; res = 0;
  atk = 0; dec = 0; rel = 0; sus = 0;
  ampT = 0; amp = 0; ampC = 0;
  fatk = 0; fdec = 0; frel = 0; fsus = 0;
  fenvT = 0; fenv = 0; fenvC = 0; fenvAmt = 0;
  driftT = 0; drift = 0; driftCnt = 0;
  noise = 0;

  constructor(synth: SwSynth, id: number) {
    this.synth = synth;
    this.id = id;
  }

  setNote(n: number): void {
    const u = this.synth.use;
    if (this.note >= 0 && this.note <= 127 && u[this.note] - 1 >= 0) u[this.note]--;
    this.note = n;
    if (n >= 0 && n <= 127) u[n]++;
  }

  freeNote(): void {
    const u = this.synth.use;
    if (this.note >= 0 && this.note <= 127 && u[this.note] - 1 >= 0) u[this.note]--;
    this.note = -1;
  }

  /** CVoiceGenerator: pitch in semitones (MIDI note scale). */
  pitch(): number {
    const S = this.synth;
    let oct = 0;
    if (S.octaver) oct = (this.uniIdx & 1) === 0 ? 0 : 12;
    let det = 0;
    if (this.uniCnt >= 2) {
      const d = S.uniDetune;
      det = fma(d, -0.5, f32(f32(d * this.uniIdx) / (this.uniCnt - 1)));
    }
    let s = f32(det + oct);
    s = f32(s + this.glide);
    s = f32(S.notePitch[this.note & 127] + s);
    s = f32(s + f32(S.tune + this.det));
    s = fma(S.bendRange, S.bend, s);
    return s;
  }

  freq(): number { return f32(Math.pow(2, fmaD(this.pitch(), 1 / 12, -4.75)) * 220); }

  /** Unison pan x FL's per-note gain x 0.5. */
  uniGain(right: boolean): number {
    const S = this.synth;
    let sp = 0;
    if (this.uniCnt >= 2) sp = f32(f32(f32(this.uniIdx + this.uniIdx) / (this.uniCnt - 1)) + -1);
    const s1 = f32(S.uniPan * sp);
    const g = right ? Math.min(Math.max(f32(1 - s1), 0), 1) : Math.min(Math.max(f32(s1 + 1), 0), 1);
    const nv = right ? S.noteR[this.note & 127] : S.noteL[this.note & 127];
    return f32(nv * f32(g * 0.5));
  }

  /** CVoiceGenerator glide towards the note. */
  private glideStep(n: number): void {
    const tgt = this.note;
    let cur = this.glide;
    if (!(cur >= tgt)) {
      cur = fma(this.glideRate, n, cur);
      this.glide = cur;
      if (cur > tgt) this.glide = tgt;
    } else if (cur > tgt) {
      cur = fms(this.glideRate, n, cur);
      this.glide = cur;
      if (cur < tgt) this.glide = tgt;
    }
  }

  /** Slot 3: note on (FL 0x3734). */
  trigger(): void {
    const S = this.synth;
    if (S.lfoRetrig) S.lfoPhase = 0;
    this.relT = -1;
    this.t = 0;
    this.atk = Math.max(S.mAtk, f32(0.001));
    this.dec = Math.max(S.mDec, f32(0.001));
    this.sus = S.mSus;
    this.fatk = Math.max(S.fAtk, f32(0.001));
    this.fdec = Math.max(S.fDec, f32(0.001));
    this.fsus = S.fSus;
    if (S.uniRetrig) { this.p3 = 0; this.p1 = 0; }
    if (S.subRetrig) this.p2 = Math.trunc(Math.min(Math.max(f32(f32(this.p1) * S.subRatio), 0), 4294967295));
    this.fenv = 0;
    S.dirty = true;
  }

  /** Slot 4: note off (FL 0x37c4). */
  noteOff(): void {
    const S = this.synth;
    this.rel = S.mRel < 0.01 ? f32(0.009999999776482582) : S.mRel;
    this.frel = S.fRel < 0.01 ? f32(0.009999999776482582) : S.fRel;
    this.relT = 0;
    this.released = true;
  }

  /** Slot 2: voice ends (FL 0x3820): states cleared, three new random 24-bit phases. */
  stop(): void {
    this.freeNote();
    const S = this.synth;
    this.driftCnt = 0;
    this.t = 0;
    this.ampT = 0; this.amp = 0; this.ampC = 0;
    this.fenvT = 0; this.fenv = 0; this.fenvC = 0;
    this.gL = 0; this.gR = 0; this.gTL = 0; this.gTR = 0;
    this.f1 = 0; this.f2 = 0; this.f3 = 0; this.f4 = 0; this.f5 = 0; this.fAvg = 0;
    this.cut = 0; this.cutT = 0; this.res = 0;
    let s = lcgP(S.seed);
    const a = s & 0xffffff;
    s = lcgP(s);
    const b = s & 0xffffff;
    s = lcgP(s);
    S.seed = s;
    this.p1 = a; this.i1 = 0;
    this.p2 = b; this.i2 = 0;
    this.p3 = s & 0xffffff; this.i3 = 0;
    S.dirty = true;
  }

  /** Slot 5: hard reset (sample rate, then stop). */
  kill(sr: number): void {
    if (sr !== 0) this.sr = sr;
    this.stop();
  }

  /** Slot 6: control step of n samples (FL 0x2efc). */
  prep(n: number): void {
    this.glideStep(n);
    const S = this.synth;
    // LFO with attack / release fades
    let a = f32(this.t / S.lfoAtk);
    if (a > 1) a = 1;
    let lfo = f32(a * S.lfoOut);
    if (!(this.relT < 0)) {
      let r = f32(this.relT / S.lfoRel);
      if (r > 1) r = 1;
      lfo = fms(r, lfo, lfo);
    }
    const amt = S.lfoAmt;
    S.seed = lcg(S.seed);
    const sd = S.seed;
    const cnt = this.driftCnt;
    if (cnt === 0) this.driftT = fma(f32(sd), f32(4.656612768993984e-12), f32(-0.009999999776482582));
    const amt2 = f32(amt * amt);
    this.driftCnt = cnt > 0x3ff ? 0 : cnt + 1;
    const d0 = this.t === 0 ? 0 : this.drift;
    const la2 = f32(lfo * amt2);
    this.drift = f32(fmaD(f32(this.driftT - d0), 0.0001, d0));
    const fe = this.fenv;
    const egAmt = S.egfAmt;
    this.gTL = this.uniGain(false);
    let gr = this.uniGain(true);
    this.gTR = gr;
    const dest = S.lfoDest;
    if (dest === 6) {
      const x = (amt * 0.5) * lfo;
      this.gTL = f32((0.5 - x) * this.gTL);
      this.gTR = f32((x + 0.5) * gr);
    } else if (dest === 5) {
      const h = f32(fmaD(lfo, 0.5, 0.5));
      const e = exp10f(f32(-amt * h));
      gr = f32(e * gr);
      this.gTL = f32(this.gTL * e);
      this.gTR = gr;
    }
    // noise
    let nz = f32(S.noiseLvl + (dest === 4 ? la2 : -0));
    nz = Math.min(Math.max(nz, 0), 1);
    nz = f32(nz * nz);
    this.noise = f32(nz * f32(0.699999988079071));
    // sub phase offset
    const egOut = f32(egAmt * fe);
    let sp = f32(S.subPhase + (S.egfDest === 2 ? egOut : -0));
    sp = f32((dest === 2 ? f32(lfo * amt) : -0) + sp);
    sp = Math.min(Math.max(sp, 0), 1);
    this.subOfs = Math.trunc(fmaD(sp, 8371830.285, 16777.215)) >>> 0;
    // sync ratio (octaves)
    let syn = 0;
    if (S.syncOn) {
      syn = S.syncFreq;
      if (S.egfDest === 1) {
        let x = fmaD(egOut, 4, syn);
        x = Math.max(x, 0);
        syn = x <= 4 ? x : 4;
      }
      if (dest === 1) {
        let x = fmaD(la2, 4, syn);
        x = Math.max(x, 0);
        syn = x > 4 ? 4 : x;
      }
    }
    // master frequency
    let fq = this.freq() * Math.pow(2, syn + this.drift);
    if (S.egfDest === 3) {
      const st = Math.trunc(f32(egAmt * 24));
      fq *= exp2f(f32(f32(fe * f32(0.0833333358168602)) * st));
    }
    if (dest === 3) fq *= exp2f(f32(la2 * amt2));
    const la4 = f32(la2 + la2);
    const sr6 = this.synth.sr * 6;
    const inc = (f: number): number => {
      let x = f / sr6;
      x = Math.max(x, 0);
      x = Math.min(x, 0.49);
      return Math.trunc(x * 16777215) >>> 0;
    };
    this.i1 = inc(fq);
    this.i2 = inc(fmaD(fq, S.subRatio, f32(S.subDetune * 3)));
    if (S.syncOn) this.i3 = inc(fq * Math.pow(2, -syn));
    else { this.p3 = 0; this.i3 = 0; }
    // cutoff
    const kp = (this.pitchNoExp() - 36) * 0.08333333333333333;
    const vt = fnmsD(this.vel + this.vel, S.velTrk * 4, S.velTrk * 4);
    let c = dest === 0 ? la4 + 5 : 5;
    c = fmaD(S.cutoff, 9.3, c);
    c = c + this.drift;
    c = fmaD(S.keyTrk, kp, c);
    c = c + vt;
    const cf = f32(Math.pow(2, c)) * 6;
    const ct = f32(cf / (S.sr * 18));
    this.cutT = ct;
    if (this.t === 0) this.cut = ct;
    let rs = f32(S.reso * 3.9899999999999998);
    if (rs > 3.9899999999999998) rs = f32(3.989999771118164);
    this.res = rs;
    const q = f32(f32(egAmt * egAmt) * f32(egAmt * egAmt));
    this.fenvAmt = S.egfDest === 0 ? f32(q * 320) : 0;
    // envelopes (time counted in n / 44100 s)
    const sr = this.sr;
    const dt = n * 2.2675736961451248e-05;
    let relT = this.relT;
    if (relT > -1) {
      const rl = this.rel;
      if (!(relT <= rl)) {
        this.gTL = 0; this.gTR = 0;
        if (relT > rl + 0.1) { this.kill(0); return; }
      }
      this.ampC = f32(8.82 / (rl * sr));
      relT += dt;
      this.relT = relT;
      this.ampT = F1E7;
    } else if (this.t < this.atk) {
      this.ampT = f32(this.vel * 5);
      this.ampC = f32(8.82 / ((sr * 39.441975) * this.atk));
      if (this.ampT < F1E7) this.ampT = F1E7;
    } else {
      this.ampT = f32(this.vel * this.sus);
      this.ampC = f32(8.82 / (this.dec * sr));
      if (this.ampT < F1E7) this.ampT = F1E7;
    }
    if (relT > -1) {
      const fr = this.frel;
      if (relT <= fr) {
        this.fenvC = f32(8.82 / (fr * sr));
        this.fenvT = F1E7;
      } else {
        this.fenvT = 0;
        this.fenvC = 0;
        return;
      }
    } else if (this.t < this.fatk) {
      this.fenvT = 5;
      this.fenvC = f32(8.82 / ((sr * 39.441975) * this.fatk));
    } else {
      this.fenvT = this.fsus;
      this.fenvC = f32(8.82 / (this.fdec * sr));
      if (this.fenvT < F1E7) this.fenvT = F1E7;
    }
    this.t += dt;
  }

  /** CVoiceGenerator pitch without the exponential (FL 0x3a2b0). */
  pitchNoExp(): number { return this.pitch(); }
}

/** d1 = d2 * d1 - d1 (FL's fnmsub on doubles: 2 vel x 4 vt - 4 vt). */
function fnmsD(a: number, b: number, c: number): number { return fmaD(a, b, -c); }

export class SwSynth {
  sr = 44100;
  tempo = 120;
  tempoF = 120;
  songPos = -1;
  playing = false;
  /** The engine-wide LCG (noise, dither, phase resets; FL: one global, initial 2545672). */
  seed = 2545672;
  /** CSynth's own LCG (note detune; initial 2222). */
  seed2 = 2222;
  readonly rand64 = new PzRand64();
  readonly gens: SwGen[] = [];
  readonly spare: SwGen;
  dirty = true;
  count = 0;
  readonly use = new Int32Array(128);
  readonly noteL = new Float32Array(128);
  readonly noteR = new Float32Array(128);
  readonly notePitch = new Float32Array(128);
  readonly noteCut = new Float32Array(128);
  readonly noteRes = new Float32Array(128);
  readonly vel01 = new Float32Array(128);
  readonly vel127 = new Uint8Array(128);
  readonly cc = new Float32Array(128);
  bend = 0;
  at = 0;
  lastVel = 0;
  readonly params = new Float32Array(96);
  readonly ccMap = new Int16Array(96).fill(-1);
  // mod matrix (6 slots)
  readonly modSrc = new Int32Array(6);
  readonly modDst = new Int32Array(6).fill(-1);
  readonly modAmt = new Float32Array(6);
  // voice / CSynth settings
  mono = false;
  octaver = false;
  uniCount = 1;
  uniDetune = f32(0.125);
  uniPan = 0;
  uniRetrig = false;
  tune = -12;
  transpose = -12;
  fine = 0;
  uniShift = 0;
  bendRange = 2;
  glideTime = f32(1e-4);
  glideMode = 0;
  poly = 8;
  maxPolyCfg = NGEN;
  maxPoly = NGEN;
  velCurve = 1;
  gain = 1;
  pan = 0.5;
  lastNote = -1;
  ageCtr = 0;
  arpOn = false;
  readonly arp: PzArpLike;
  // Sawer settings
  mAtk = f32(0.00101); mDec = 50; mSus = 1; mRel = f32(0.02);
  subPhase = 1; subRatio = 1; subLvl = 0; subDetune = 0; subSign = 1; subRetrig = false; subSquare = false;
  syncFreq = 0; syncOn = false; noiseLvl = 0;
  cutoff = 1; reso = 0; keyTrk = 0; velTrk = 0; filterMode = 0;
  readonly qT = new Float32Array([1, 1e-6, 1e-6, 1e-6].map(f32));
  readonly q = new Float32Array([1, 1e-6, 1e-6, 1e-6].map(f32));
  fAtk = f32(0.00101); fDec = 50; fSus = 1; fRel = 50; egfAmt = 0; egfDest = 0;
  lfoShape = 0; lfoSpeed = 1.25; lfoSync = false; lfoSyncMul = 1; lfoAtk = f32(0.01); lfoRel = 20;
  lfoRetrig = false; lfoInv = false; lfoAmt = 0; lfoDest = 0;
  lfoPhase = 0; lfoOut = 0; lfoSH = 0;
  osCount = 0;
  blockSize = 46;
  maxCut = 0;
  // decimator
  dA = 0; dB = 0; dC = 0;
  readonly dz = new Float32Array(8);
  // DC blocker (one state for both channels, like FL)
  hpA = 0; hpB = 0; hpC = 0; hpF = 0; hpQ = 0; hpSr = 0;
  readonly hpZ = new Float32Array(4);
  mgL = 0; mgR = 0;
  readonly fx = new SwFx();
  t1: Float32Array;
  t2: Float32Array;
  b6L = new Float32Array(0);
  b6R = new Float32Array(0);
  private readonly list: SwGen[] = [];

  constructor() {
    for (let i = 0; i < NGEN; i++) this.gens.push(new SwGen(this, i));
    this.spare = new SwGen(this, NGEN);
    this.arp = new PzArpLike(this);
    this.t1 = swSubstituteTable();
    this.t2 = swDerivedTable(this.t1);
    this.cc[7] = 1;
    this.cc[10] = 0.5;
  }

  /** FL's table 1 (data.saw) from the user's FL install, or null for the stand-in. */
  setTable(t: Float32Array | null): void {
    this.t1 = t && t.length >= SW_TABLE_SIZE ? t : swSubstituteTable();
    this.t2 = swDerivedTable(this.t1);
  }

  rand32(): number {
    this.seed2 = lcg(this.seed2);
    return f32(this.seed2 * U32);
  }

  /** FL's default engine values (0..83; 84..95 = 0). */
  static defaultParam(id: number): number {
    return id >= 0 && id < SW_DEFAULTS.length ? SW_DEFAULTS[id] : 0;
  }

  resetToDefaults(): void {
    for (let id = 0; id < 96; id++) this.setParameter(id, SwSynth.defaultParam(id));
  }

  loadState(v: ArrayLike<number>): void {
    for (let id = 0; id < 96; id++) this.setParameter(id, id < v.length ? v[id] : SwSynth.defaultParam(id));
  }

  /** The modulation matrix (FL 0x115ec): FL parameters get source x amount added, clamped to 0..1. */
  private modulated(id: number, v: number): number {
    if (id >= 73) return v;
    for (let k = 0; k < 6; k++) {
      const s = this.modSrc[k];
      if (s === 0 || this.modDst[k] !== id) continue;
      let x = 0;
      if (s === 1) x = this.lastVel;
      else if (s === 2) x = this.at;
      else if (s === 3) x = this.bend;
      else if (s - 4 >= 0 && s - 4 <= 0x7f) x = this.cc[(s + 0x7c) & 0x7f];
      v = fma(this.modAmt[k], x, v);
    }
    if (!(v >= 0)) v = 0;
    if (v > 1) v = 1;
    return v;
  }

  /** Re-apply every modulated parameter (FL: after note on / off, CC, aftertouch, pitch bend). */
  private applyMods(): void {
    for (let k = 0; k < 6; k++) {
      const d = this.modDst[k];
      if (this.modSrc[k] !== 0 && d >= 0) this.apply(d, this.params[d]);
    }
  }

  setParameter(id: number, v: number): void {
    v = f32(v);
    if (id >= 0 && id < 96) this.params[id] = v;
    if (id < 0) return;
    this.apply(id, v);
  }

  /** FL 0x10220: the modulated value of an engine id applied. */
  private apply(id: number, v: number): void {
    v = this.modulated(id, v);
    const fx = this.fx;
    switch (id) {
      case 0: this.gain = exp10f(fma(v, f32(2.4000000953674316), f32(-0.9000000357627869))); break;
      case 1: this.pan = Math.min(Math.max(v, 0), 1); break;
      case 2: this.mAtk = envTime(v); break;
      case 3: this.mDec = envTime(v); break;
      case 4: this.mSus = v; break;
      case 5: this.mRel = f32(fmaD(envTime(v), 0.35, 0.019999999552965164)); break;
      case 6: {
        const t = Math.min(Math.max(Math.trunc(fma(v, 48, -24)), -24), 24);
        this.transpose = f32(t + -12);
        this.tune = f32(f32(this.transpose + this.fine) + this.uniShift);
        break;
      }
      case 7:
        this.fine = f32(f32(v + v) + -1);
        this.tune = f32(f32(this.transpose + this.fine) + this.uniShift);
        break;
      case 8: this.setMono(v !== 0); break;
      case 9: case 10: {
        const tm = this.params[9], km = this.params[10];
        this.glideMode = tm === 0 ? (km === 0 ? 1 : 0) : (km === 0 ? 3 : 2);
        break;
      }
      case 11: this.setGlideTime(f32(f32(v * v) * v)); break;
      case 12: this.octaver = v !== 0; break;
      case 13: this.uniRetrig = v !== 0; break;
      case 14: {
        const idx = Math.min(Math.max(Math.trunc(f32(v * 3)), 0), 3);
        this.setUnison([1, 2, 4, 8][idx]);
        this.apply(15, this.params[15]);
        break;
      }
      case 15: {
        this.uniDetune = f32(v * 0.5);
        this.uniShift = f32(v * -0.25);
        if (!(this.params[14] >= 0.25)) this.uniShift = 0;
        this.tune = f32(f32(this.transpose + this.fine) + this.uniShift);
        break;
      }
      case 16: this.uniPan = Math.min(Math.max(v, 0), 1); break;
      case 17: this.subPhase = v; break;
      case 18: {
        const w = Math.trunc(v * 8);
        if (w <= 0) this.subRatio = 0.25;
        else if (w >= 8) this.subRatio = 4;
        else this.subRatio = [f32(1 / 3), 0.5, f32(2 / 3), 1, 1.5, 2, 3][w - 1];
        break;
      }
      case 19: this.subLvl = f32(v * v); break;
      case 20: this.subDetune = f32(v * v); break;
      case 21: this.subRetrig = v !== 0; break;
      case 22: this.subSign = v !== 0 ? -1 : 1; break;
      case 23: this.subSquare = v !== 0; break;
      case 24: this.syncFreq = f32(v * 4); break;
      case 25: this.syncOn = v !== 0; break;
      case 26: this.noiseLvl = v; break;
      case 27: this.cutoff = v; break;
      case 28: this.reso = v; break;
      case 29: this.keyTrk = v; break;
      case 30: this.velTrk = v; break;
      case 31: {
        const m = Math.min(Math.max(Math.trunc(f32(v * 3)), 0), 3);
        this.filterMode = m;
        this.qT.fill(f32(9.999999974752427e-07));
        if (m === 0) this.qT[0] = 1;
        else if (m === 1) this.qT[1] = 1;
        else if (m === 2) this.qT[2] = 1;
        else this.qT[3] = f32(0.6000000238418579);
        break;
      }
      case 32: this.fAtk = envTime(v); break;
      case 33: this.fDec = envTime(v); break;
      case 34: this.fSus = f32(v * v); break;
      case 35: this.fRel = envTime(v); break;
      case 36: this.egfAmt = v; break;
      case 37: this.egfDest = Math.min(Math.max(Math.trunc(f32(v * 3)), 0), 3); break;
      case 38: this.lfoShape = Math.min(Math.max(Math.trunc(f32(v * 3)), 0), 3); break;
      case 39: {
        this.lfoSpeed = f32(f32(f32(v * v) * 10) * v);
        const i = Math.min(Math.max(Math.trunc(f32(v * 9)), 0), 9);
        this.lfoSyncMul = [1, 2, 3, 4, 8, 12, 16, 32, 64, 128][i];
        break;
      }
      case 40: this.lfoSync = v !== 0; break;
      case 41: this.lfoAtk = fma(f32(f32(v * v) * 20), v, f32(0.009999999776482582)); break;
      case 42: this.lfoRel = fma(f32(f32(v * v) * 20), v, f32(0.009999999776482582)); break;
      case 43: this.lfoRetrig = v !== 0; break;
      case 44: this.lfoInv = v !== 0; break;
      case 45: this.lfoAmt = v; break;
      case 46: this.lfoDest = Math.max(Math.min(Math.trunc(f32(v * 6)), 6), 0); break;
      case 47: fx.chorus.setOn(v !== 0 ? 1 : v); break;
      case 48: fx.chorus.setDepth(v); break;
      case 49: fx.chorus.setRate(v); break;
      case 50: fx.chorus.setWet(v); break;
      case 51: fx.phaser.on = v !== 0; break;
      case 52: fx.phaser.center = v; break;
      case 53: fx.phaser.rate = v; break;
      case 54: fx.phaser.depth = v; break;
      case 55: fx.phaser.feedback = v; break;
      case 56: fx.phaser.mix = v; break;
      case 57: fx.delay.setOn(v); break;
      case 58: fx.delay.setTimeL(v); break;
      case 59: fx.delay.setTimeR(v); break;
      case 60: fx.delay.setFeedback(v); break;
      case 61: fx.delay.setDepth(v); break;
      case 62: fx.delay.setLoCut(v); break;
      case 63: fx.delay.setHiCut(v); break;
      case 64: fx.delay.setWet(v); break;
      case 65: fx.setReverbOn(v !== 0); break;
      case 66: fx.reverb.setParam(8, f32(f32(f32(v * v) * v) * 0.6)); break;
      case 67: fx.reverb.setParam(2, f32(f32(v * v) * v)); break;
      case 68: fx.reverb.setParam(9, f32(Math.abs(1 - v))); break;
      case 69: fx.reverb.setParam(12, fma(v, f32(0.9990000128746033), f32(0.0010000000474974513))); break;
      case 70: this.setArp(v !== 0); break;
      case 71: {
        const m = Math.min(Math.max(Math.trunc(fmaD(v, 3, 0.00030000000000000003)), 0), 3);
        this.arp.setMode(m);
        break;
      }
      case 72: this.arp.range = Math.min(Math.max(Math.trunc(fmaD(v, 3, 0.00030000000000000003)), 0), 3) + 1; break;
      case 74: {
        const i = Math.trunc(v);
        if (i >= 0 && i <= 6) this.arp.speed = [0.5, 1, 2, 3, 4, 8, 16][i];
        break;
      }
      case 75: this.setPolyphony(Math.trunc(fma(v, 4, 4))); break;
      case 76: this.bendRange = Math.trunc(v); break;
      default:
        if (id >= 78 && id <= 83) { const s = f32(f32(v + v) - 1); this.modAmt[id - 78] = f32(Math.abs(s) * s); }
        else if (id >= 84 && id <= 89) this.modDst[id - 84] = (Math.trunc(v) << 16) >> 16;
        else if (id >= 90 && id <= 95) this.modSrc[id - 90] = Math.trunc(v) & 0xffff;
    }
  }

  setMaxPoly(n: number): void { this.maxPoly = n !== 0 ? n : this.maxPolyCfg; }

  private setPolyphony(n: number): void {
    this.poly = this.maxPolyCfg >= n && n >= 1 ? n : this.maxPolyCfg;
  }

  private setUnison(n: number): void { this.uniCount = Math.min(Math.max(n, 1), 8); }

  private setGlideTime(g: number): void {
    const x = f32(Math.min(Math.max(g, 0), 1) * 2);
    this.glideTime = x < 1e-4 ? f32(1e-4) : x;
  }

  private allNotesOff(): void {
    const sus = this.cc[64];
    this.cc[64] = 0;
    for (let n = 0; n < 128; n++) this.noteOff(n);
    this.cc[64] = sus;
  }

  private setMono(on: boolean): void {
    if (this.mono === on) return;
    this.mono = on;
    this.allNotesOff();
  }

  private setArp(on: boolean): void {
    if (this.arpOn === on) return;
    const sus = this.cc[64];
    this.cc[64] = 0;
    for (let n = 0; n < 128; n++) this.noteOff(n);
    this.cc[64] = sus;
    this.arpOn = on;
  }

  /** FL's polyphony limit: min(polyphony, host max). */
  maxVoices(): number { return Math.min(this.poly, this.maxPoly); }

  // ------------------------------------------------------------- MIDI input
  noteOn(n: number, vel: number): void {
    this.vel01[n] = f32(vel * f32(1 / 127));
    if (vel === 0) { this.noteOff(n); return; }
    this.lastVel = this.vel01[n];
    this.applyMods();
    this.vel127[n] = Math.trunc(f32(this.vel01[n] * 127));
    if (this.arpOn) this.arp.update();
    else this.playNote(n, this.vel01[n]);
  }

  noteOff(n: number): void {
    this.vel01[n] = 0;
    if (this.cc[64] !== 0) return;
    this.vel127[n] = 0;
    if (this.arpOn) this.arp.update();
    else this.playNote(n, 0);
  }

  controlChange(c: number, v127: number): void {
    // CSynth's handling first (PoiZone's code), then Sawer re-applies its modulations
    this.cc[c] = f32(v127 * f32(1 / 127));
    if (c === 64) {
      if (this.cc[64] === 0) {
        for (let n = 0; n < 128; n++) if (this.vel01[n] === 0 && this.vel127[n] !== 0) this.noteOff(n);
      }
    } else if (c === 121) {
      this.cc.fill(0);
      this.cc[7] = 1; this.cc[10] = 0.5;
    } else if (c === 123) {
      this.allNotesOff();
    } else {
      for (let p = 0; p < 96; p++) if (this.ccMap[p] === c) this.setParameter(p, this.cc[c]);
    }
    if (c !== 7 && c !== 10 && c !== 0x20) this.applyMods();
  }

  /** Channel aftertouch 0..127 (CSynth stores v / 127; Sawer re-applies its modulations). */
  aftertouch(v127: number): void { this.at = f32(v127 * f32(1 / 127)); this.applyMods(); }
  pitchBend(v: number): void { this.bend = v; this.applyMods(); }

  /** CSynth::playNote (PoiZone's code). */
  playNote(n: number, vel: number): void {
    this.vel127[n] = Math.trunc(f32(vel * 127));
    if (this.mono) { this.monoNote(n, vel); return; }
    if (vel === 0) {
      for (const g of this.gens) if (g.note === n) { g.released = true; g.noteOff(); }
      return;
    }
    this.seed2 = lcg(this.seed2);
    const r = this.seed2;
    let from = this.lastNote < 0 ? n : this.lastNote;
    if ((this.glideMode | 2) === 3) {
      let best = 128, cand = n, found = false;
      for (let i = 0; i < 128; i++) {
        const d = Math.abs(n - i);
        if (this.vel127[i] !== 0 && i !== n && d < best) { best = d; cand = i; found = true; }
      }
      from = found ? cand : n;
    }
    const det = f32((f32(r * U32) * 2 - 2) * f32(0.01));
    const maxV = this.maxVoices();
    for (let u = 0; u < this.uniCount; u++) {
      let g: SwGen;
      if (maxV < 1) g = this.gens[0];
      else {
        let oldR = this.gens[0], oldA = this.gens[0], pick: SwGen | null = null;
        for (let i = 0; i < Math.min(maxV, NGEN); i++) {
          const c = this.gens[i];
          if (c.note < 0) { pick = c; break; }
          if (c.released) { if (oldR.age > c.age) oldR = c; }
          else if (oldA.age > c.age) oldA = c;
        }
        g = pick ?? (oldR.released ? oldR : oldA);
      }
      g.age = this.ageCtr++ >>> 0;
      g.setNote(n);
      g.uniIdx = u;
      g.uniCnt = this.uniCount;
      g.det = det;
      g.vel = this.velCurve === 1 ? vel : f32(Math.pow(vel, this.velCurve));
      g.released = false;
      g.glide = from;
      if (this.glideTime < 0.001) g.glide = n;
      if (this.glideMode <= 1) g.glideRate = f32(12 / (this.sr * this.glideTime));
      else g.glideRate = f32(Math.abs(f32(n - g.glide)) / (this.sr * this.glideTime));
      g.trigger();
    }
    this.lastNote = n;
  }

  private monoNote(n: number, vel: number): void {
    if (vel === 0) {
      let best = 128, cand = n, found = false;
      for (let i = 0; i < 128; i++) {
        const d = Math.abs(n - i);
        if (this.vel127[i] !== 0 && d < best) { best = d; cand = i; found = true; }
      }
      if (found) {
        for (const g of this.gens) {
          if (g.note !== n) continue;
          g.age = this.ageCtr++ >>> 0;
          g.setNote(cand);
          g.glideRate = f32(12 / (this.sr * this.glideTime));
          this.lastNote = cand;
        }
      } else {
        for (const g of this.gens) if (g.note === n) { g.released = true; g.noteOff(); }
      }
      return;
    }
    this.seed2 = lcg(this.seed2);
    const r = this.seed2;
    const last = this.lastNote < 0 ? n : this.lastNote;
    let from = n;
    const g0 = this.gens[0];
    if ((this.glideMode | 2) === 3) { if (g0.note >= 0 && !g0.released) from = last; }
    else from = last;
    const det = f32((f32(r * U32) * 2 - 2) * f32(0.01));
    for (let u = 0; u < this.uniCount && u < this.gens.length; u++) {
      const g = this.gens[u];
      const wasNote = g.note, wasRel = g.released;
      g.age = this.ageCtr++ >>> 0;
      g.setNote(n);
      g.released = false;
      g.det = det;
      g.uniIdx = u;
      g.uniCnt = this.uniCount;
      if (this.glideMode <= 1) g.glideRate = f32(12 / (this.sr * this.glideTime));
      else g.glideRate = f32(Math.abs(f32(n - g.glide)) / (this.sr * this.glideTime));
      if (wasNote < 0 || wasRel) {
        g.vel = this.velCurve === 1 ? vel : f32(Math.pow(vel, this.velCurve));
        g.glide = from;
        if (this.glideTime < 0.001) g.glide = n;
        g.trigger();
      }
    }
    this.lastNote = n;
  }

  // ------------------------------------------------------------- host side
  /** Sample rate change / flush (sr 0): notes off, voices stopped, filters and effects reset. */
  setSampleRate(sr: number): void {
    if (sr > 0) this.sr = sr;
    const sus = this.cc[64];
    this.cc[64] = 0;
    for (let n = 0; n < 128; n++) this.noteOff(n);
    this.cc[64] = sus;
    for (const g of [...this.gens, this.spare]) { g.kill(this.sr); g.glide = 48; }
    this.mgL = this.masterGain(false);
    this.mgR = this.masterGain(true);
    this.lastNote = -1;
    this.arp.reset();
    this.arp.stop();
    if (sr !== 0) {
      this.setupHp(4, 1, f32(sr));
      this.blockSize = Math.trunc(sr * 0.001) + 2;
      this.maxCut = f32(f32(121026 / sr) * f32(0.1666666716337204));
      const w = 16755.160819145563 / sr;
      const s = Math.sin(w), c = Math.cos(w);
      const a = f32((1 - c) / fmaD(s, 0.125, 2));
      const b = f32((c * -16) / (s + 8));
      const cc = f32((8 - s) / (s + 8));
      const flush = (x: number) => (x < f32(9.999999717180685e-10) && x > f32(-9.999999717180685e-10) ? 0 : x);
      this.dA = flush(a); this.dB = flush(b); this.dC = flush(cc);
      this.fx.setSampleRate(sr);
    }
    this.lfoPhase = 0;
    this.dz.fill(0);
    this.q.set(this.qT);
    this.hpZ.fill(0);
    this.fx.reset();
  }

  /** The 2-pole DC blocker's coefficients (FL 0x37bf0). */
  private setupHp(f: number, q: number, sr: number): void {
    if (this.hpF === f && this.hpQ === q && this.hpSr === sr) return;
    this.hpF = f; this.hpQ = q; this.hpSr = sr;
    const w = f32((f * 6.283185307179586) / sr);
    const sc = [0, 0];
    sincosf(w, sc);
    const s = sc[0], c = sc[1];
    const d = f32(s + q);
    const a = f32(f32(c + 1) / f32(f32(s / q) + 2));
    const b = f32((q * -2 * c) / d);
    const e = f32(f32(q - s) / d);
    const flush = (x: number) => (x < f32(9.999999717180685e-10) && x > f32(-9.999999717180685e-10) ? 0 : x);
    this.hpA = flush(a); this.hpB = flush(b); this.hpC = flush(e);
  }

  private hp(x: number): number {
    const z = this.hpZ;
    const T = f32(9.999999717180685e-10);
    const xi = x > -T && x < T ? 0 : x;
    const x1 = z[1], x2 = z[0], y1 = z[3], y2 = z[2];
    const t = f32(f32(xi - f32(x1 + x1)) + x2);
    let y = fnms(t, this.hpA, fma(y1, this.hpB, f32(y2 * this.hpC)));
    if (y > -T && y < T) y = 0;
    z[0] = x1; z[1] = xi; z[2] = y1; z[3] = y;
    return y;
  }

  /** CSynth master gain / pan (gain x 0.5 x CC 7, pan from CC 10). */
  private masterGain(right: boolean): number {
    const s1 = f32(f32(this.gain * 0.5) * this.cc[7]);
    if (!(s1 > 0)) return 0;
    let p = f32((this.cc[10] - 0.5 + this.pan) * 2);
    p = Math.min(Math.max(p, 0), 2);
    if (!right) return p <= 1 ? s1 : f32(f32(2 - p) * s1);
    return p < 1 ? f32(p * s1) : s1;
  }

  /** One engine block of n samples into L / R (zeroed by the caller). */
  process(L: Float32Array, R: Float32Array, n: number): void {
    // global LFO: value from the current phase, then the phase advances
    let o = 0;
    switch (this.lfoShape) {
      case 0: { let s = f32(this.lfoPhase + this.lfoPhase); if (s > 1) s = f32(2 - s); o = f32(s + s - 1); break; }
      case 1: o = f32(this.lfoPhase + this.lfoPhase - 1); break;
      case 2: o = this.lfoPhase < 0.5 ? 1 : -1; break;
      default: o = this.lfoSH;
    }
    this.lfoOut = o;
    if (this.lfoSync) this.lfoPhase += (this.tempo * n) / ((this.lfoSyncMul * 15) * this.sr);
    else this.lfoPhase += (this.lfoSpeed * n) / this.sr;
    if (this.lfoPhase > 1) {
      this.lfoPhase -= 1;
      this.lfoSH = fma(f32(this.seed), f32(N2P31), -1);
    }
    if (this.lfoInv) this.lfoOut = f32(-this.lfoOut);
    // voice lists: sounding within the limit, sounding beyond it, free
    const C: SwGen[] = [], B: SwGen[] = [], A: SwGen[] = [];
    const maxV = this.maxVoices();
    for (const g of this.gens) {
      if (g.note < 0) A.push(g);
      else if (C.length < maxV) C.push(g);
      else B.push(g);
    }
    const list = this.list;
    list.length = 0;
    list.push(...C, ...B, ...A);
    while (list.length < NGEN + 3) list.push(this.spare);
    this.count = C.length;
    if (this.b6L.length < n * 6) { this.b6L = new Float32Array(n * 6); this.b6R = new Float32Array(n * 6); }
    if (C.length < 1) {
      this.osCount = 0;
    } else {
      let left = C.length, base = 0, first = true;
      while (left > 0) {
        if (left === 1) {
          const g = list[base];
          let done = 0;
          while (done < n) {
            const m = Math.min(n - done, this.blockSize);
            g.prep(m);
            this.render1(g, done * 6, m * 6, first);
            done += m;
          }
          break;
        }
        const grp = [list[base], list[base + 1], list[base + 2], list[base + 3]];
        let done = 0;
        while (done < n) {
          const m = Math.min(n - done, this.blockSize);
          for (const g of grp) if (g.note >= 0) g.prep(m);
          this.render4(grp, done * 6, m * 6, first);
          done += m;
        }
        first = false;
        base += 4;
        left -= 4;
      }
      this.decimate(L, R, n);
    }
    for (let i = 0; i < n; i++) { L[i] = this.hp(L[i]); R[i] = this.hp(R[i]); }
    this.fx.setTempo(this.tempo);
    this.fx.process(L, R, n);
    if (this.arpOn) this.arp.process(this.sr, this.tempo, n);
    const tL = this.masterGain(false), tR = this.masterGain(true);
    let gl = this.mgL, gr = this.mgR;
    for (let i = 0; i < n; i++) {
      L[i] = f32(L[i] * gl);
      R[i] = f32(R[i] * gr);
      gl = fma(f32(tL - gl), f32(0.004999999888241291), gl);
      gr = fma(f32(tR - gr), f32(0.004999999888241291), gr);
    }
    this.mgL = gl;
    this.mgR = gr;
  }

  /** 6:1 decimation through one biquad low-pass per channel (FL 0x14028). */
  private decimate(L: Float32Array, R: Float32Array, n: number): void {
    const z = this.dz, A = this.dA, B = this.dB, C = this.dC, nB = -B;
    let lx2 = z[0], lx1 = z[1], ly2 = z[2], ly1 = z[3], rx2 = z[4], rx1 = z[5], ry2 = z[6], ry1 = z[7];
    const iL = this.b6L, iR = this.b6R;
    for (let o = 0; o < n; o++) {
      for (let k = 0; k < 6; k++) {
        const xl = iL[o * 6 + k];
        const tl = f32(f32(lx1 + lx1) + f32(xl + lx2));
        const yl = fnms(tl, A, fma(ly1, B, f32(ly2 * C)));
        lx2 = lx1; lx1 = xl; ly2 = ly1; ly1 = yl;
        const xr = iR[o * 6 + k];
        const tr = f32(f32(rx1 + rx1) + f32(xr + rx2));
        const yr = fma(tr, A, fnms(ry1, nB, f32(ry2 * C)));
        rx2 = rx1; rx1 = xr; ry2 = ry1; ry1 = yr;
      }
      L[o] = ly1;
      R[o] = ry1;
    }
    z[0] = lx2; z[1] = lx1; z[2] = ly2; z[3] = ly1; z[4] = rx2; z[5] = rx1; z[6] = ry2; z[7] = ry1;
  }

  /** One voice (FL's scalar loop, 0x130b8). */
  private render1(g: SwGen, at: number, N: number, first: boolean): void {
    const oL = this.b6L, oR = this.b6R;
    this.subGain = f32(this.subLvl * this.subSign);
    let p1 = g.p1, i1 = g.i1, p2 = g.p2, i2 = g.i2, p3 = g.p3, i3 = g.i3;
    const so = g.subOfs;
    const T1 = this.t1, T2 = this.subSquare ? this.t2 : this.t1;
    const nzL = g.noise;
    let gL = g.gL, gR = g.gR;
    const gTL = g.gTL, gTR = g.gTR;
    let amp = g.amp, fenv = g.fenv, cut = g.cut;
    const ampT = g.ampT, ampC = g.ampC, fenvT = g.fenvT, fenvC = g.fenvC, fenvA = g.fenvAmt, cutT = g.cutT;
    let s16 = g.f1, s7 = g.f2, s6 = g.f3, s8 = g.f4, s5 = g.f5, s27 = g.fAvg;
    const res = g.res;
    const cs = f32(176.40000915527344 / this.sr);
    const old = this.seed;
    this.seed = lcg(old);
    let seed = this.seed;
    let noise = f32(f32((f32(old)) * U32 + -0.5) * nzL);
    let dith = 0;
    let gc = Math.min(f32((f32(fenv * fenvA)) * cut + cut), this.maxCut);
    const r5 = f32(res * -0.5), r6 = f32(res * 0.5);
    let k = this.osCount;
    const q = this.q, qT = this.qT;
    for (let i = 0; i < N; i++) {
      if (k === 0) {
        for (let j = 0; j < 4; j++) q[j] = f32((f32(qT[j] - q[j])) * cs + q[j]);
        const rnd = f32((f32(seed)) * U32 + -0.5);
        seed = lcg(seed);
        this.seed = seed;
        dith = f32(rnd * F0_06);
        noise = f32(rnd * nzL);
        gc = Math.min(f32((f32(fenv * fenvA)) * cut + cut), this.maxCut);
        cut = f32((f32(cutT - cut)) * cs + cut);
        fenv = Math.min(f32((f32(fenvT - fenv)) * fenvC + fenv), 1);
        amp = Math.min(f32((f32(ampT - amp)) * ampC + amp), 1);
        gL = f32((f32(gTL - gL)) * cs + gL);
        gR = f32((f32(gTR - gR)) * cs + gR);
      }
      k = k + 1 === 6 ? 0 : k + 1;
      const a = T1[(p1 >>> 11) & 0x1fff];
      const b = T2[((p2 + so) >>> 11) & 0x1fff];
      let x = f32(this.subGain * b + a);
      let w = (p3 + i3) >>> 0;
      const ov = w >>> 24;
      p3 = ov === 0 ? w : 0;
      let q2 = ov === 0 ? p2 : 0;
      let q1 = ov === 0 ? p1 : 0;
      w = (q1 + i1) >>> 0;
      p1 = (w >>> 24) === 0 ? w : 0;
      w = (q2 + i2) >>> 0;
      p2 = (w >>> 24) === 0 ? w : 0;
      x = f32(x * dith + x);
      x = f32(x + -0.35);
      x = f32(noise + x);
      x = f32(x * amp);
      // ladder, three passes
      let t = f32(res * (f32(-s27)) - s16);
      t = f32(t + x);
      s16 = f32(t * gc + s16);
      t = f32(s16 - s7); s7 = f32(t * gc + s7);
      t = f32(s7 - s6); s6 = f32(t * gc + s6);
      t = f32(s6 - s8); let y = f32(t * gc + s8);
      let m = Math.max(y, 0); m = f32(m * m); m = f32(m * m); m = f32(m * 5 + 1);
      const ya = f32(y / m);
      s5 = f32(ya + s5);
      t = f32(x - s16);
      s5 = f32(r5 * s5 + t);
      s5 = f32(s5 * gc + s16);
      t = f32(s5 - s7); s7 = f32(t * gc + s7);
      t = f32(s7 - s6); s6 = f32(t * gc + s6);
      t = f32(s6 - ya); y = f32(t * gc + ya);
      m = Math.max(y, 0); m = f32(m * m); m = f32(m * m); m = f32(m * 5 + 1);
      const yb = f32(y / m);
      const yab = f32(yb + ya);
      x = f32(x - r6 * yab);
      t = f32(x - s5); s16 = f32(t * gc + s5);
      t = f32(s16 - s7); s7 = f32(t * gc + s7);
      t = f32(s7 - s6); s6 = f32(t * gc + s6);
      t = f32(s6 - yb); y = f32(t * gc + yb);
      m = Math.max(y, 0); m = f32(m * m); m = f32(m * m); m = f32(m * 5 + 1);
      s5 = f32(y / m);
      let out = f32(s5 * q[0] + (f32(s7 * q[1])));
      out = f32((f32(s5 - s6)) * q[2] + out);
      out = f32((f32(x - s5)) * q[3] + out);
      const l = f32(out * gL), r = f32(out * gR);
      const j = at + i;
      if (first) { oL[j] = l; oR[j] = r; } else { oL[j] = f32(oL[j] + l); oR[j] = f32(oR[j] + r); }
      s27 = f32(f32(s5 + yb) * 0.5);
      s8 = s5;
    }
    this.osCount = k;
    g.p1 = p1; g.p2 = p2; g.p3 = p3;
    g.gL = gL; g.gR = gR; g.amp = amp; g.fenv = fenv;
    g.f1 = s16; g.f2 = s7; g.f3 = s6; g.f4 = s8; g.f5 = s5; g.fAvg = s27; g.cut = cut;
    void i1; void i2;
  }

  subGain = 0;

  /**
   * Four voices at once (FL's NEON loop, 0x134b4): FL's lane math in its own rounding order,
   * the lanes interleaved in scalar locals (generated by .flref/ilsynths/saw/gen_render4.py).
   */
  private render4(G: SwGen[], at: number, N: number, first: boolean): void {
    this.subGain = f32(this.subLvl * this.subSign);
    const T1 = this.t1, T2 = this.subSquare ? this.t2 : this.t1, sg = this.subGain, maxCut = this.maxCut;
    const cs = f32(176.40000915527344 / this.sr);
    // shared by the four lanes: the LCG draws (four per control tick, in lane order) and the
    // filter-mode smoother (the lanes read its value from before the tick's update)
    const s0 = this.seed, sA = lcg(s0), sB = lcg(sA), sC = lcg(sB);
    let seed = lcg(sC);
    const q = this.q, qT = this.qT;
    const g0 = G[0], g1 = G[1], g2 = G[2], g3 = G[3];
    let p10 = g0.p1, p20 = g0.p2, p30 = g0.p3;
    let p11 = g1.p1, p21 = g1.p2, p31 = g1.p3;
    let p12 = g2.p1, p22 = g2.p2, p32 = g2.p3;
    let p13 = g3.p1, p23 = g3.p2, p33 = g3.p3;
    const i10 = g0.i1, i20 = g0.i2, i30 = g0.i3, so0 = g0.subOfs, nz0 = g0.noise;
    const i11 = g1.i1, i21 = g1.i2, i31 = g1.i3, so1 = g1.subOfs, nz1 = g1.noise;
    const i12 = g2.i1, i22 = g2.i2, i32 = g2.i3, so2 = g2.subOfs, nz2 = g2.noise;
    const i13 = g3.i1, i23 = g3.i2, i33 = g3.i3, so3 = g3.subOfs, nz3 = g3.noise;
    let gL0 = g0.gL, gR0 = g0.gR, amp0 = g0.amp, fenv0 = g0.fenv, cut0 = g0.cut;
    let gL1 = g1.gL, gR1 = g1.gR, amp1 = g1.amp, fenv1 = g1.fenv, cut1 = g1.cut;
    let gL2 = g2.gL, gR2 = g2.gR, amp2 = g2.amp, fenv2 = g2.fenv, cut2 = g2.cut;
    let gL3 = g3.gL, gR3 = g3.gR, amp3 = g3.amp, fenv3 = g3.fenv, cut3 = g3.cut;
    const gTL0 = g0.gTL, gTR0 = g0.gTR, ampT0 = g0.ampT, ampC0 = g0.ampC, fenvT0 = g0.fenvT, fenvC0 = g0.fenvC, fenvA0 = g0.fenvAmt, cutT0 = g0.cutT;
    const gTL1 = g1.gTL, gTR1 = g1.gTR, ampT1 = g1.ampT, ampC1 = g1.ampC, fenvT1 = g1.fenvT, fenvC1 = g1.fenvC, fenvA1 = g1.fenvAmt, cutT1 = g1.cutT;
    const gTL2 = g2.gTL, gTR2 = g2.gTR, ampT2 = g2.ampT, ampC2 = g2.ampC, fenvT2 = g2.fenvT, fenvC2 = g2.fenvC, fenvA2 = g2.fenvAmt, cutT2 = g2.cutT;
    const gTL3 = g3.gTL, gTR3 = g3.gTR, ampT3 = g3.ampT, ampC3 = g3.ampC, fenvT3 = g3.fenvT, fenvC3 = g3.fenvC, fenvA3 = g3.fenvAmt, cutT3 = g3.cutT;
    let s160 = g0.f1, s70 = g0.f2, s60 = g0.f3, s80 = g0.f4, s50 = g0.f5, s270 = g0.fAvg;
    let s161 = g1.f1, s71 = g1.f2, s61 = g1.f3, s81 = g1.f4, s51 = g1.f5, s271 = g1.fAvg;
    let s162 = g2.f1, s72 = g2.f2, s62 = g2.f3, s82 = g2.f4, s52 = g2.f5, s272 = g2.fAvg;
    let s163 = g3.f1, s73 = g3.f2, s63 = g3.f3, s83 = g3.f4, s53 = g3.f5, s273 = g3.fAvg;
    const rr0 = g0.res, r50 = f32(rr0 * -0.5), r60 = f32(rr0 * 0.5), nr0 = -rr0;
    const rr1 = g1.res, r51 = f32(rr1 * -0.5), r61 = f32(rr1 * 0.5), nr1 = -rr1;
    const rr2 = g2.res, r52 = f32(rr2 * -0.5), r62 = f32(rr2 * 0.5), nr2 = -rr2;
    const rr3 = g3.res, r53 = f32(rr3 * -0.5), r63 = f32(rr3 * 0.5), nr3 = -rr3;
    const rnd00 = f32(f32(s0) * U32 + -0.5);
    const rnd01 = f32(f32(sA) * U32 + -0.5);
    const rnd02 = f32(f32(sB) * U32 + -0.5);
    const rnd03 = f32(f32(sC) * U32 + -0.5);
    let noise0 = f32(rnd00 * nz0), dith0 = f32(rnd00 * F0_06);
    let noise1 = f32(rnd01 * nz1), dith1 = f32(rnd01 * F0_06);
    let noise2 = f32(rnd02 * nz2), dith2 = f32(rnd02 * F0_06);
    let noise3 = f32(rnd03 * nz3), dith3 = f32(rnd03 * F0_06);
    let gc0 = Math.min(f32(cut0 * f32(fenv0 * fenvA0) + cut0), maxCut);
    let gc1 = Math.min(f32(cut1 * f32(fenv1 * fenvA1) + cut1), maxCut);
    let gc2 = Math.min(f32(cut2 * f32(fenv2 * fenvA2) + cut2), maxCut);
    let gc3 = Math.min(f32(cut3 * f32(fenv3 * fenvA3) + cut3), maxCut);
    let qa = q[0], qb = q[1], qc = q[2], qd = q[3];
    const tSeed = this.tSeed;
    let k = this.osCount;
    const oL = this.b6L, oR = this.b6R;
    for (let i = 0; i < N; i++) {
      if (k === 0) {
        qa = q[0]; qb = q[1]; qc = q[2]; qd = q[3];
        for (let j = 0; j < 4; j++) q[j] = f32(f32(qT[j] - q[j]) * cs + q[j]);
        const a0 = seed, a1 = lcg(a0), a2 = lcg(a1), a3 = lcg(a2);
        seed = lcg(a3);
        tSeed[0] = a0; tSeed[1] = a1; tSeed[2] = a2; tSeed[3] = a3;
        const t4 = 0;
        const rnd0 = f32(f32(tSeed[t4 + 0]) * U32 + -0.5);
        const rnd1 = f32(f32(tSeed[t4 + 1]) * U32 + -0.5);
        const rnd2 = f32(f32(tSeed[t4 + 2]) * U32 + -0.5);
        const rnd3 = f32(f32(tSeed[t4 + 3]) * U32 + -0.5);
        dith0 = f32(rnd0 * F0_06);
        dith1 = f32(rnd1 * F0_06);
        dith2 = f32(rnd2 * F0_06);
        dith3 = f32(rnd3 * F0_06);
        noise0 = f32(rnd0 * nz0);
        noise1 = f32(rnd1 * nz1);
        noise2 = f32(rnd2 * nz2);
        noise3 = f32(rnd3 * nz3);
        gc0 = Math.min(f32(cut0 * f32(fenv0 * fenvA0) + cut0), maxCut);
        gc1 = Math.min(f32(cut1 * f32(fenv1 * fenvA1) + cut1), maxCut);
        gc2 = Math.min(f32(cut2 * f32(fenv2 * fenvA2) + cut2), maxCut);
        gc3 = Math.min(f32(cut3 * f32(fenv3 * fenvA3) + cut3), maxCut);
        const dc0 = f32(cutT0 - cut0);
        const dc1 = f32(cutT1 - cut1);
        const dc2 = f32(cutT2 - cut2);
        const dc3 = f32(cutT3 - cut3);
        fenv0 = Math.min(f32(f32(fenvT0 - fenv0) * fenvC0 + fenv0), 1);
        fenv1 = Math.min(f32(f32(fenvT1 - fenv1) * fenvC1 + fenv1), 1);
        fenv2 = Math.min(f32(f32(fenvT2 - fenv2) * fenvC2 + fenv2), 1);
        fenv3 = Math.min(f32(f32(fenvT3 - fenv3) * fenvC3 + fenv3), 1);
        amp0 = Math.min(f32(f32(ampT0 - amp0) * ampC0 + amp0), 1);
        amp1 = Math.min(f32(f32(ampT1 - amp1) * ampC1 + amp1), 1);
        amp2 = Math.min(f32(f32(ampT2 - amp2) * ampC2 + amp2), 1);
        amp3 = Math.min(f32(f32(ampT3 - amp3) * ampC3 + amp3), 1);
        cut0 = f32(dc0 * cs + cut0);
        cut1 = f32(dc1 * cs + cut1);
        cut2 = f32(dc2 * cs + cut2);
        cut3 = f32(dc3 * cs + cut3);
        gL0 = f32(f32(gTL0 - gL0) * cs + gL0);
        gL1 = f32(f32(gTL1 - gL1) * cs + gL1);
        gL2 = f32(f32(gTL2 - gL2) * cs + gL2);
        gL3 = f32(f32(gTL3 - gL3) * cs + gL3);
        gR0 = f32(f32(gTR0 - gR0) * cs + gR0);
        gR1 = f32(f32(gTR1 - gR1) * cs + gR1);
        gR2 = f32(f32(gTR2 - gR2) * cs + gR2);
        gR3 = f32(f32(gTR3 - gR3) * cs + gR3);
      }
      k = k + 1 === 6 ? 0 : k + 1;
      const a0 = T1[(p10 >>> 11) & 0x1fff];
      const a1 = T1[(p11 >>> 11) & 0x1fff];
      const a2 = T1[(p12 >>> 11) & 0x1fff];
      const a3 = T1[(p13 >>> 11) & 0x1fff];
      const b0 = T2[((p20 + so0) >>> 11) & 0x1fff];
      const b1 = T2[((p21 + so1) >>> 11) & 0x1fff];
      const b2 = T2[((p22 + so2) >>> 11) & 0x1fff];
      const b3 = T2[((p23 + so3) >>> 11) & 0x1fff];
      const osc0 = f32(b0 * sg + a0);
      const osc1 = f32(b1 * sg + a1);
      const osc2 = f32(b2 * sg + a2);
      const osc3 = f32(b3 * sg + a3);
      let w0 = (p30 + i30) >>> 0;
      let w1 = (p31 + i31) >>> 0;
      let w2 = (p32 + i32) >>> 0;
      let w3 = (p33 + i33) >>> 0;
      const ov0 = w0 >>> 24;
      const ov1 = w1 >>> 24;
      const ov2 = w2 >>> 24;
      const ov3 = w3 >>> 24;
      p30 = ov0 === 0 ? w0 : 0;
      p31 = ov1 === 0 ? w1 : 0;
      p32 = ov2 === 0 ? w2 : 0;
      p33 = ov3 === 0 ? w3 : 0;
      const q20 = ov0 === 0 ? p20 : 0;
      const q21 = ov1 === 0 ? p21 : 0;
      const q22 = ov2 === 0 ? p22 : 0;
      const q23 = ov3 === 0 ? p23 : 0;
      const q10 = ov0 === 0 ? p10 : 0;
      const q11 = ov1 === 0 ? p11 : 0;
      const q12 = ov2 === 0 ? p12 : 0;
      const q13 = ov3 === 0 ? p13 : 0;
      w0 = (q10 + i10) >>> 0;
      w1 = (q11 + i11) >>> 0;
      w2 = (q12 + i12) >>> 0;
      w3 = (q13 + i13) >>> 0;
      p10 = (w0 >>> 24) === 0 ? w0 : 0;
      p11 = (w1 >>> 24) === 0 ? w1 : 0;
      p12 = (w2 >>> 24) === 0 ? w2 : 0;
      p13 = (w3 >>> 24) === 0 ? w3 : 0;
      w0 = (q20 + i20) >>> 0;
      w1 = (q21 + i21) >>> 0;
      w2 = (q22 + i22) >>> 0;
      w3 = (q23 + i23) >>> 0;
      p20 = (w0 >>> 24) === 0 ? w0 : 0;
      p21 = (w1 >>> 24) === 0 ? w1 : 0;
      p22 = (w2 >>> 24) === 0 ? w2 : 0;
      p23 = (w3 >>> 24) === 0 ? w3 : 0;
      let x0 = f32(f32(noise0 + F0_35) + osc0);
      let x1 = f32(f32(noise1 + F0_35) + osc1);
      let x2 = f32(f32(noise2 + F0_35) + osc2);
      let x3 = f32(f32(noise3 + F0_35) + osc3);
      x0 = f32(osc0 * dith0 + x0);
      x1 = f32(osc1 * dith1 + x1);
      x2 = f32(osc2 * dith2 + x2);
      x3 = f32(osc3 * dith3 + x3);
      x0 = f32(x0 * amp0);
      x1 = f32(x1 * amp1);
      x2 = f32(x2 * amp2);
      x3 = f32(x3 * amp3);
      let t0 = f32(s270 * nr0 + f32(-s160));
      let t1 = f32(s271 * nr1 + f32(-s161));
      let t2 = f32(s272 * nr2 + f32(-s162));
      let t3 = f32(s273 * nr3 + f32(-s163));
      t0 = f32(t0 + x0);
      t1 = f32(t1 + x1);
      t2 = f32(t2 + x2);
      t3 = f32(t3 + x3);
      s160 = f32(t0 * gc0 + s160);
      s161 = f32(t1 * gc1 + s161);
      s162 = f32(t2 * gc2 + s162);
      s163 = f32(t3 * gc3 + s163);
      t0 = f32(s160 - s70); s70 = f32(t0 * gc0 + s70);
      t1 = f32(s161 - s71); s71 = f32(t1 * gc1 + s71);
      t2 = f32(s162 - s72); s72 = f32(t2 * gc2 + s72);
      t3 = f32(s163 - s73); s73 = f32(t3 * gc3 + s73);
      t0 = f32(s70 - s60); s60 = f32(t0 * gc0 + s60);
      t1 = f32(s71 - s61); s61 = f32(t1 * gc1 + s61);
      t2 = f32(s72 - s62); s62 = f32(t2 * gc2 + s62);
      t3 = f32(s73 - s63); s63 = f32(t3 * gc3 + s63);
      t0 = f32(s60 - s80); let y0 = f32(t0 * gc0 + s80);
      t1 = f32(s61 - s81); let y1 = f32(t1 * gc1 + s81);
      t2 = f32(s62 - s82); let y2 = f32(t2 * gc2 + s82);
      t3 = f32(s63 - s83); let y3 = f32(t3 * gc3 + s83);
      let m0 = y0 > 0 ? y0 : 0; m0 = f32(m0 * m0); m0 = f32(m0 * m0); m0 = f32(m0 * 5 + 1);
      let m1 = y1 > 0 ? y1 : 0; m1 = f32(m1 * m1); m1 = f32(m1 * m1); m1 = f32(m1 * 5 + 1);
      let m2 = y2 > 0 ? y2 : 0; m2 = f32(m2 * m2); m2 = f32(m2 * m2); m2 = f32(m2 * 5 + 1);
      let m3 = y3 > 0 ? y3 : 0; m3 = f32(m3 * m3); m3 = f32(m3 * m3); m3 = f32(m3 * 5 + 1);
      const ya0 = f32(y0 / m0);
      const ya1 = f32(y1 / m1);
      const ya2 = f32(y2 / m2);
      const ya3 = f32(y3 / m3);
      const sum0 = f32(ya0 + s50);
      const sum1 = f32(ya1 + s51);
      const sum2 = f32(ya2 + s52);
      const sum3 = f32(ya3 + s53);
      t0 = f32(x0 - s160);
      t1 = f32(x1 - s161);
      t2 = f32(x2 - s162);
      t3 = f32(x3 - s163);
      t0 = f32(r50 * sum0 + t0);
      t1 = f32(r51 * sum1 + t1);
      t2 = f32(r52 * sum2 + t2);
      t3 = f32(r53 * sum3 + t3);
      s160 = f32(t0 * gc0 + s160);
      s161 = f32(t1 * gc1 + s161);
      s162 = f32(t2 * gc2 + s162);
      s163 = f32(t3 * gc3 + s163);
      t0 = f32(s160 - s70); s70 = f32(t0 * gc0 + s70);
      t1 = f32(s161 - s71); s71 = f32(t1 * gc1 + s71);
      t2 = f32(s162 - s72); s72 = f32(t2 * gc2 + s72);
      t3 = f32(s163 - s73); s73 = f32(t3 * gc3 + s73);
      t0 = f32(s70 - s60); s60 = f32(t0 * gc0 + s60);
      t1 = f32(s71 - s61); s61 = f32(t1 * gc1 + s61);
      t2 = f32(s72 - s62); s62 = f32(t2 * gc2 + s62);
      t3 = f32(s73 - s63); s63 = f32(t3 * gc3 + s63);
      t0 = f32(s60 - ya0); y0 = f32(t0 * gc0 + ya0);
      t1 = f32(s61 - ya1); y1 = f32(t1 * gc1 + ya1);
      t2 = f32(s62 - ya2); y2 = f32(t2 * gc2 + ya2);
      t3 = f32(s63 - ya3); y3 = f32(t3 * gc3 + ya3);
      m0 = y0 > 0 ? y0 : 0; m0 = f32(m0 * m0); m0 = f32(m0 * m0); m0 = f32(m0 * 5 + 1);
      m1 = y1 > 0 ? y1 : 0; m1 = f32(m1 * m1); m1 = f32(m1 * m1); m1 = f32(m1 * 5 + 1);
      m2 = y2 > 0 ? y2 : 0; m2 = f32(m2 * m2); m2 = f32(m2 * m2); m2 = f32(m2 * 5 + 1);
      m3 = y3 > 0 ? y3 : 0; m3 = f32(m3 * m3); m3 = f32(m3 * m3); m3 = f32(m3 * 5 + 1);
      const yb0 = f32(y0 / m0);
      const yb1 = f32(y1 / m1);
      const yb2 = f32(y2 / m2);
      const yb3 = f32(y3 / m3);
      x0 = f32(x0 - r60 * f32(yb0 + ya0));
      x1 = f32(x1 - r61 * f32(yb1 + ya1));
      x2 = f32(x2 - r62 * f32(yb2 + ya2));
      x3 = f32(x3 - r63 * f32(yb3 + ya3));
      t0 = f32(x0 - s160); s160 = f32(t0 * gc0 + s160);
      t1 = f32(x1 - s161); s161 = f32(t1 * gc1 + s161);
      t2 = f32(x2 - s162); s162 = f32(t2 * gc2 + s162);
      t3 = f32(x3 - s163); s163 = f32(t3 * gc3 + s163);
      t0 = f32(s160 - s70); s70 = f32(t0 * gc0 + s70);
      t1 = f32(s161 - s71); s71 = f32(t1 * gc1 + s71);
      t2 = f32(s162 - s72); s72 = f32(t2 * gc2 + s72);
      t3 = f32(s163 - s73); s73 = f32(t3 * gc3 + s73);
      t0 = f32(s70 - s60); s60 = f32(t0 * gc0 + s60);
      t1 = f32(s71 - s61); s61 = f32(t1 * gc1 + s61);
      t2 = f32(s72 - s62); s62 = f32(t2 * gc2 + s62);
      t3 = f32(s73 - s63); s63 = f32(t3 * gc3 + s63);
      t0 = f32(s60 - yb0); y0 = f32(t0 * gc0 + yb0);
      t1 = f32(s61 - yb1); y1 = f32(t1 * gc1 + yb1);
      t2 = f32(s62 - yb2); y2 = f32(t2 * gc2 + yb2);
      t3 = f32(s63 - yb3); y3 = f32(t3 * gc3 + yb3);
      m0 = y0 > 0 ? y0 : 0; m0 = f32(m0 * m0); m0 = f32(m0 * m0); m0 = f32(m0 * 5 + 1);
      m1 = y1 > 0 ? y1 : 0; m1 = f32(m1 * m1); m1 = f32(m1 * m1); m1 = f32(m1 * 5 + 1);
      m2 = y2 > 0 ? y2 : 0; m2 = f32(m2 * m2); m2 = f32(m2 * m2); m2 = f32(m2 * 5 + 1);
      m3 = y3 > 0 ? y3 : 0; m3 = f32(m3 * m3); m3 = f32(m3 * m3); m3 = f32(m3 * 5 + 1);
      const yc0 = f32(y0 / m0);
      const yc1 = f32(y1 / m1);
      const yc2 = f32(y2 / m2);
      const yc3 = f32(y3 / m3);
      let out0 = f32(yc0 * qa + f32(s70 * qb));
      let out1 = f32(yc1 * qa + f32(s71 * qb));
      let out2 = f32(yc2 * qa + f32(s72 * qb));
      let out3 = f32(yc3 * qa + f32(s73 * qb));
      out0 = f32(f32(yc0 - s60) * qc + out0);
      out1 = f32(f32(yc1 - s61) * qc + out1);
      out2 = f32(f32(yc2 - s62) * qc + out2);
      out3 = f32(f32(yc3 - s63) * qc + out3);
      out0 = f32(f32(x0 - yc0) * qd + out0);
      out1 = f32(f32(x1 - yc1) * qd + out1);
      out2 = f32(f32(x2 - yc2) * qd + out2);
      out3 = f32(f32(x3 - yc3) * qd + out3);
      const lo0 = f32(out0 * gL0), ro0 = f32(out0 * gR0);
      const lo1 = f32(out1 * gL1), ro1 = f32(out1 * gR1);
      const lo2 = f32(out2 * gL2), ro2 = f32(out2 * gR2);
      const lo3 = f32(out3 * gL3), ro3 = f32(out3 * gR3);
      s270 = f32(f32(yc0 + yb0) * 0.5);
      s271 = f32(f32(yc1 + yb1) * 0.5);
      s272 = f32(f32(yc2 + yb2) * 0.5);
      s273 = f32(f32(yc3 + yb3) * 0.5);
      s50 = yc0;
      s51 = yc1;
      s52 = yc2;
      s53 = yc3;
      s80 = yc0;
      s81 = yc1;
      s82 = yc2;
      s83 = yc3;
      const sl = f32(f32(lo0 + lo1) + f32(lo2 + lo3));
      const sr = f32(f32(ro0 + ro1) + f32(ro2 + ro3));
      const j = at + i;
      if (first) { oL[j] = sl; oR[j] = sr; } else { oL[j] = f32(oL[j] + sl); oR[j] = f32(oR[j] + sr); }
    }
    this.seed = seed;
    this.osCount = k;
    g0.p1 = p10; g0.p2 = p20; g0.p3 = p30;
    g1.p1 = p11; g1.p2 = p21; g1.p3 = p31;
    g2.p1 = p12; g2.p2 = p22; g2.p3 = p32;
    g3.p1 = p13; g3.p2 = p23; g3.p3 = p33;
    g0.gL = gL0; g0.gR = gR0; g0.amp = amp0; g0.fenv = fenv0; g0.cut = cut0;
    g1.gL = gL1; g1.gR = gR1; g1.amp = amp1; g1.fenv = fenv1; g1.cut = cut1;
    g2.gL = gL2; g2.gR = gR2; g2.amp = amp2; g2.fenv = fenv2; g2.cut = cut2;
    g3.gL = gL3; g3.gR = gR3; g3.amp = amp3; g3.fenv = fenv3; g3.cut = cut3;
    g0.f1 = s160; g0.f2 = s70; g0.f3 = s60; g0.f4 = s80; g0.f5 = s50; g0.fAvg = s270;
    g1.f1 = s161; g1.f2 = s71; g1.f3 = s61; g1.f4 = s81; g1.f5 = s51; g1.fAvg = s271;
    g2.f1 = s162; g2.f2 = s72; g2.f3 = s62; g2.f4 = s82; g2.f5 = s52; g2.fAvg = s272;
    g3.f1 = s163; g3.f2 = s73; g3.f3 = s63; g3.f4 = s83; g3.f5 = s53; g3.fAvg = s273;
  }

  private readonly tSeed = new Float64Array(4);
}

/** FL's envelope time law: max(50 v^5, 0.00101) seconds. */
function envTime(v: number): number {
  const d = v;
  const t = ((d * d) * (d * d)) * (d * 50);
  return f32(Math.max(t, 0.00101));
}

/** FL's default engine values 0..83 (Sawer's defaults table). */
const SW_DEFAULTS = [
  0.5, 0.5, 0, 1, 1, 0, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0.25, 0, 1, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1,
  0, 0, 0, 0.5, 0, 0, 1, 0, 0, 0, 0, 0, 0.5, 0.25, f32(0.3), 0, f32(0.3), f32(0.2), f32(0.7), 0, f32(0.6), 0, f32(0.4), f32(0.4),
  f32(0.3), 0.25, 0, 1, 0.5, 0, 0.5, 0.5, 0.5, 0.5, 0, 0, 0.5, 0, 1, 8, 2, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5,
];
