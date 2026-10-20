// Kepler / Kepler Exo voice (engine.dylib class "Voice", 0x32e8 bytes, eight of them in the engine):
// parameter decoding (0xd35c), note on / off (0xd168 / 0xd2a4), the per-sample update of pitch and
// filter modulation (0xdcb0), the oscillator stage (0xe314) and the output stage (0xe43c). Every
// operation is single precision (fused where the engine's NEON / FMADD code is) unless noted.

import { f32, fma32, exp2d } from './fmath';
import { sinf, exp2f } from './applemath';
import { KEnv } from './env';
import { SlaveOsc } from './slaveosc';
import { JunoOscEx } from './junoex';
import { LadderBank } from './filter';
import type { KLfo1, KLfo2 } from './lfo';
import {
  CURVE_SUB, CURVE_CUTOFF, CURVE_ENV_CUT, CURVE_LFO_CUT, CURVE_LFO_PITCH, TIME_ATTACK, TIME_DECAY, TIME_RELEASE,
} from './tables';
import { noiseSample, NOISE_LEN } from './noise';
import { ModMatrix, isGlobal } from './modmatrix';
import type { Routes } from './modmatrix';

/** 0xe5bcc: ten-segment piecewise-linear curve of x in 0..1 over a table of 11 breakpoints. */
export function curve(x: number, t: Float32Array): number {
  const s = f32(x * 10);
  const i = Math.trunc(s);
  if (i >= 10) return t[10];
  const fr = f32(s - i);
  return fma32(t[i], f32(1 - fr), f32(fr * t[i + 1]));
}

/** 0x7f2b0: quantise a 0..1 value to n steps (round half up). */
export function quant(v: number, n: number): number {
  const x = (n - 1) * v + 0.5;
  return x <= 0 ? 0 : Math.trunc(x) >>> 0;
}

/** The engine objects a voice reads (MyPlugin fields). */
export interface VoiceHost {
  readonly lfo1: KLfo1;
  readonly lfo2: KLfo2;
  /** LFO1 sine * delay fade (engine +0x1c844) and LFO2 shape * fade (+0x1c840). */
  srcLfo1Sine: number;
  srcLfo2: number;
  /** pitch bend position (+0x1cc08) and the pitch offset (+0x13f0, octaves). */
  bend: number;
  pitchOffset: number;
  /** +0x1ceb0: enhanced oscillators. +0x13e4: filter model. */
  enhOsc: boolean;
  filterType: number;
  /** 0x84b4: a float that flips sign at every call (returns the new value). */
  randFlip(): number;
  /** 0x84cc: 32-bit LCG state, returned as a float in [0, 1). */
  randLcg(): number;
  /** FL's noise loop when the user imported it (else the stand-in) */
  noiseTable: Int16Array | null;
  /** the engine's applied (unmodulated) and modulated parameter arrays (+0x1b3c8, +0x1b7d0) */
  readonly A: Float32Array;
  readonly B: Float32Array;
  readonly exo: boolean;
  /** LFO sources with the delay fade (+0x1c834 .. +0x1c844) */
  srcLfo1Uni: number;
  srcLfo2Uni: number;
  srcLfo1Tri: number;
}

const PW_CONST = f32(1);

export class KVoice {
  readonly host: VoiceHost;
  /** lane in the filter bank (0..3) and the banks of the three filter models */
  lane = 0;                    // @0x1200
  readonly bank: LadderBank;   // @0x1208 (model 0)
  readonly par = new Float32Array(260); // @0x2eb8: every parameter value the voice has seen
  readonly env1 = new KEnv();  // @0x2dd0
  readonly env2 = new KEnv();  // @0x2df8
  readonly osc1 = new SlaveOsc(); // @0x12a0
  readonly osc2 = new SlaveOsc(); // @0x2018
  /** the enhanced oscillators (@0x1398 / @0x2110): FL keeps them up to date with every parameter, they run when the option is on */
  readonly ex1 = new JunoOscEx();
  readonly ex2 = new JunoOscEx();
  noiseValue = 0;              // @0x1280
  noiseIdx = 0;                // @0x1298

  // ---- voice state (names by role; offsets are the engine's)
  key = -1;                    // @0x11c0
  age = 0;                     // @0x11c4
  noiseLevel = 0;              // @0x11c8
  rndSign = f32(0.5);          // @0x11cc (an idle voice shows 0.5)
  rndVal = 0;                  // @0x11d0
  cutBase = 1;                 // @0x11d4
  reso = 0;                    // @0x11d8
  envCut = 0;                  // @0x11dc
  lfo1Cut = 0;                 // @0x11e0
  lfo2Cut = 0;                 // @0x11e4
  lfo1Dco1 = 0;                // @0x11e8
  lfo2Dco1 = 0;                // @0x11ec
  lfo1Dco2 = 0;                // @0x11f0
  lfo2Dco2 = 0;                // @0x11f4
  env2Dco1 = 0;                // @0x11f8
  env2Dco2 = 0;                // @0x11fc
  pw1Amt = 0;                  // @0x1220
  pw1Src = 0;                  // @0x1228 (0 LFO1, 1 constant, 2 env1)
  pw2Amt = 0;                  // @0x1230
  pw2Src = 0;                  // @0x1238
  gate = 0;                    // @0x1240 smoothed gate level
  gateCoef = 0;                // @0x1244
  sr = 44100;                  // @0x1248 f64
  invSrOsF = 0;                // @0x1250 f32
  invSrOs = 0;                 // @0x1258 f64
  octave = 0;                  // @0x1260
  noteOfs = 0;                 // @0x1264 pitch offset from the note expression (octaves)
  panL = 1; panR = 1;          // @0x1268 / @0x126c
  bendRange = 0;               // @0x1270
  fine2 = 0;                   // @0x1274
  fine1 = 0;                   // @0x1278
  dco2Active = false;          // @0x2010
  hardSync = false;            // @0x2030
  slope = 0;                   // @0x2d88
  envPol = 1;                  // @0x2e20
  fmAmt = 0;                   // @0x2e24
  fmShape = 0;                 // @0x2e28
  xm12Shape = 0;               // @0x2e2c
  xm21Shape = 0;               // @0x2e30
  dco1Level = 0;               // @0x2e34
  dco2Level = 0;               // @0x2e38
  amAmt = 0;                   // @0x2e3c
  dco2Pitch = 0;               // @0x2e40
  pitchTgt = 0;                // @0x2e44
  pitchCur = 0;                // @0x2e48
  portaCoef = 0;               // @0x2e4c
  portaStep = 1000;            // @0x2e50
  portaMode = 0;               // @0x2e54
  ctlCount = 0;                // @0x2e58
  ctlPeriod = 44;              // @0x2e5c
  s2e60 = 0; s2e64 = 1;        // @0x2e60 / 0x2e64
  fcutMod = 0; fresMod = 0;    // @0x2e68 / 0x2e6c
  s2e70 = 0; s2e74 = 0; s2e78 = 0; s2e7c = 0; // @0x2e70..0x2e7c
  keyMinusHalf = f32(0.5);     // @0x2e80 (the constructor stores 0.5 here and 0 in keyNorm)
  keyNorm = 0;                 // @0x2e84
  vel = 0;                     // @0x2e88
  relVel = 0;                  // @0x2e8c
  velGate = 0;                 // @0x2e90
  velAmp = 0;                  // @0x2e94
  readonly matAmt = new Float32Array(8); // @0x2e98 mod matrix amounts (bipolar)
  gainFlag = true;             // @0x32c0 pan gains jump (note start)
  gainL = 0; gainR = 0;        // @0x32c4 / 0x32c8
  panCoef = 0;                 // @0x32cc
  vcaOut = 0;                  // @0x32d0
  vcaCoef = 0;                 // @0x32d4
  vcaSrc = 0;                  // @0x32e0 (0 gate, 1 env1, 2 env2)
  vcaSmooth = false;           // @0x32e4
  active = false;
  readonly mm = new ModMatrix();
  /** filter bank of the three models (only model 0 exists so far) */
  constructor(host: VoiceHost, bank: LadderBank, lane: number) {
    this.host = host;
    this.bank = bank;
    this.lane = lane;
  }

  // ------------------------------------------------------------------ configuration
  /** 0xd020: sample rate, control period and the oversampling factor. */
  config(sr: number, period: number, os: number): void {
    this.sr = sr;
    this.ctlPeriod = period;
    const srOs = os * sr;
    const inv = 1 / srOs;
    this.invSrOsF = f32(inv);
    this.invSrOs = inv;
    this.env1.setSampleRate(sr);
    this.env2.setSampleRate(sr);
    this.osc1.setN(os);
    this.osc2.setN(os);
    this.gateCoef = coefTime(0.0025, 0.9, sr);
    this.panCoef = coefTime(0.005, 0.9, sr);
    this.vcaCoef = coefTime(0.005, 0.9, sr);
    const k = f32(Math.pow(0.37, 10 / sr)); // the integrator leak's upper limit (osc +0x14)
    this.osc1.leakCap = k;
    this.osc2.leakCap = k;
  }

  // ------------------------------------------------------------------ parameters (0xd35c)
  /**
   * Voice::setParam(id, value): `v` is the normalised parameter (float). Kepler's build quantises the
   * three-way switches with thresholds 0.333 / 0.666 (exoSwitches = false); Kepler Exo rounds.
   */
  setParam(id: number, v: number, exo = false): void {
    const par = this.par;
    par[id] = v;
    switch (id) {
      case 0: case 1: {
        let x = curve(par[0], CURVE_LFO_PITCH);
        this.lfo1Dco1 = x;
        if (par[1] >= 0.5) this.lfo1Dco1 = f32(x * 10);
        break;
      }
      case 2: case 3: {
        const x = curve(par[2], CURVE_LFO_PITCH);
        this.lfo2Dco1 = x;
        if (par[3] >= 0.5) this.lfo2Dco1 = f32(x * 10);
        break;
      }
      case 4: this.env2Dco1 = f32(v * 10); break;
      case 5: this.pw1Amt = v; break;
      case 6: this.pw1Src = this.pwSource(v, exo); break;
      case 7: this.osc1.offLevel = this.ex1.pulseLevel = v >= 0.5 ? 1 : 0; break; // (a switch: the matrix can hand over fractions)
      case 8: this.osc1.sawLevel = this.ex1.sawLevel = v >= 0.5 ? 1 : 0; break;
      case 9: case 10:
        if (par[9] >= 0.5) this.osc1.pulseLevel = this.ex1.subLevel = f32(curve(par[10], CURVE_SUB) * f32(1.1111111640930176));
        else this.osc1.pulseLevel = this.ex1.subLevel = 0;
        break;
      case 11: this.osc1.thrA = this.ex1.thrSub = f32(v * f32(0.9900000095367432)); break;
      case 12:
        this.dco2Active = v >= 0.5;
        this.osc1.slave = this.dco2Active ? this.osc2 : null;
        break;
      case 13: case 14: {
        const s0 = f32(par[13] + -0.5), s1 = f32(par[14] + -0.5);
        const a = f32(s0 + s0);
        const st = Math.trunc(f32(a * 48));
        this.dco2Pitch = f32(fma32(f32(s1 + s1), 0.5, st) * f32(0.0833333358168602));
        break;
      }
      case 15: this.osc2.sawLevel = this.ex2.sawLevel = v >= 0.5 ? 1 : 0; break;
      case 16: case 17:
        if (par[16] >= 0.5) this.osc2.pulseLevel = this.ex2.subLevel = f32(curve(par[17], CURVE_SUB) * f32(1.1111111640930176));
        else this.osc2.pulseLevel = this.ex2.subLevel = 0;
        break;
      case 18: this.osc2.thrA = this.ex2.thrSub = f32(v * f32(0.9900000095367432)); break;
      case 19: this.pw2Amt = v; break;
      case 20: case 21: {
        const x = curve(par[20], CURVE_LFO_PITCH);
        this.lfo1Dco2 = par[21] >= 0.5 ? f32(x * 10) : x;
        break;
      }
      case 22: case 23: {
        const x = curve(par[22], CURVE_LFO_PITCH);
        this.lfo2Dco2 = par[23] >= 0.5 ? f32(x * 10) : x;
        break;
      }
      case 24: this.env2Dco2 = f32(v * 10); break;
      case 25: this.pw2Src = this.pwSource(v, exo); break;
      case 26: this.osc2.offLevel = this.ex2.pulseLevel = v >= 0.5 ? 1 : 0; break;
      case 27: this.hardSync = v >= 0.5; this.osc2.isSyncSource = this.hardSync; this.ex1.slave = this.hardSync ? this.ex2 : null; break;
      case 30: this.xm12Shape = quant(v, 6); break;
      case 31: this.xm21Shape = quant(v, 6); break;
      case 32: this.dco1Level = v; break;
      case 33: this.dco2Level = v; break;
      case 34: this.noiseLevel = Math.max(curve(v, CURVE_SUB), f32(0.009999999776482582)); break;
      case 35: this.amAmt = v; break;
      case 37: {
        const x = v < 0 ? 0 : v > 1 ? 1 : v;
        this.cutBase = exp2f(curve(x, CURVE_CUTOFF));
        break;
      }
      case 38: this.reso = v < 0 ? 0 : v > 1 ? 1 : v; break;
      case 40: this.slope = quant(v, 4); this.bank.tap = this.slope; break;
      case 41: this.fmAmt = f32(f32(f32(v * v) * v) * 16); break;
      case 42: this.fmShape = quant(v, 6); break;
      case 43: this.envPol = v >= 0.5 ? -1 : 1; break;
      case 44: this.envCut = curve(v, CURVE_ENV_CUT); break;
      case 45: this.lfo1Cut = curve(v, CURVE_LFO_CUT); break;
      case 46: this.lfo2Cut = curve(v, CURVE_LFO_CUT); break;
      case 47:
        // Kepler: 2-way (envelope / gate); Exo: envelope 1 / gate / envelope 2 at 0.333 / 0.666
        this.vcaSrc = exo ? (v < f32(0.3330000042915344) ? 1 : v < f32(0.6660000085830688) ? 0 : 2) : (v >= 0.5 ? 0 : 1);
        break;
      case 61: this.env1.setAttack(curve(par[61], TIME_ATTACK)); break;
      case 62: this.env1.setDecay(curve(par[62], TIME_DECAY)); break;
      case 63: this.env1.setSustain(v); break;
      case 64: this.env1.setRelease(curve(par[64], TIME_RELEASE)); break;
      case 65: this.env2.setAttack(curve(par[65], TIME_ATTACK)); break;
      case 66: this.env2.setDecay(curve(par[66], TIME_DECAY)); break;
      case 67: this.env2.setSustain(v); break;
      case 68: this.env2.setRelease(curve(par[68], TIME_RELEASE)); break;
      case 79: this.portaMode = quant(v, 2); break;
      case 80: {
        const t = v * v * v * 10; // double
        this.portaCoef = coefTime(t, 0.9, this.sr); // 0x61b8(t, 0.9, sr)
        this.portaStep = t > 0 ? f32(1 / (t * this.sr)) : 1000;
        break;
      }
      case 83: case 153:
        // Exo adds the master tune (parameter 153, +-1 octave around 0.5) to the octave switch
        this.octave = exo ? f32(fma32(par[153], 2, f32(quant(par[83], 3) + -1)) + -1) : f32(quant(par[83], 3) + -1);
        break;
      case 84: this.bendRange = f32(f32(f32(quant(v, 24) + 1) * 2) / 12); break;
      case 92: case 93: case 94: case 95: case 96: case 97: case 98: case 99:
        this.matAmt[id - 92] = fma32(v, 2, -1);
        break;
      case 151: this.vcaSmooth = v >= 0.5; break;
      case 0x100: this.fine2 = f32(f32(v + -0.5) * 24); break; // @0x1274: DCO1 pitch (matrix destination 256)
      case 0x101: this.fine1 = f32(f32(v + -0.5) * 24); break; // @0x1278: DCO2 pitch (matrix destination 257)
      default: break;
    }
  }

  private pwSource(v: number, _exo: boolean): number {
    return v < f32(0.3330000042915344) ? 0 : (v < f32(0.6660000085830688) ? 1 : 2);
  }
  private pwValue(src: number): number {
    return src === 0 ? this.host.lfo1.out10 : src === 1 ? PW_CONST : this.env1.value;
  }

  // ------------------------------------------------------------------ notes
  /** 0xd168. */
  noteOn(prevKey: number, key: number, vel: number, retrig: boolean, flag: boolean): void {
    this.rndSign = this.host.randFlip();
    this.rndVal = this.host.randLcg();
    this.gainFlag = flag;
    this.s2e60 = 1; this.s2e64 = 0;
    if (prevKey >= 0) this.pitchCur = f32(f32(prevKey - 69) * f32(0.0833333358168602));
    this.pitchTgt = f32(f32(key - 69) * f32(0.0833333358168602));
    if (vel >= 0) {
      this.vel = vel;
      const s9 = this.par[73];
      const c = velCurve(vel);
      this.velGate = fma32(s9, c, f32(1 - s9));
      this.velAmp = f32(this.velGate * f32(1.0256409645080566));
    }
    this.relVel = vel;
    this.keyNorm = f32(key / 127);
    this.keyMinusHalf = f32(this.keyNorm + -0.5);
    this.key = key;
    this.age = 0;
    if (retrig) { this.env1.noteOn(); this.env2.noteOn(); }
    this.ctlCount = this.ctlPeriod;
    this.modTick();
    this.active = true;
  }

  /** 0xd2a4. */
  noteOff(relVel: number): void {
    if (this.s2e60 === 0) return;
    this.s2e60 = 0; this.s2e64 = 1;
    this.velGate = 0;
    this.relVel = relVel;
    this.env1.noteOff();
    this.env2.noteOff();
  }

  /** 0xd1b4 (Voice::reset as MyPlugin::reset runs it): the note is released, both envelopes idle at 0 and the matrix's pitch offsets are cleared. */
  flReset(): void {
    this.noteOff(0);
    this.env1.reset(); this.env2.reset();
    this.fine2 = 0; this.fine1 = 0;
  }

  /** Silence: envelopes, filter and level followers cleared (the plugin's own reset / stop). */
  reset(): void {
    this.env1.reset(); this.env2.reset();
    this.key = -1;
    this.s2e60 = 0; this.s2e64 = 1;
    this.velGate = 0; this.gate = 0; this.vcaOut = 0;
    this.gainFlag = true;
    this.active = false;
    for (let s = 0; s < 4; s++) this.bank.st[s][this.lane] = 0;
  }

  /** 0x30988 for the voice's own mod matrix: modulated per-voice parameters. */
  modTick(): void {
    this.mm.tick(this.applyMod);
  }
  private readonly applyMod = (dst: number, v: number): void => this.setParam(dst, v, this.host.exo);

  /** 0x3080c: collect the voice's routes (per-voice destinations and the matrix amounts). */
  rebuildMatrix(r: Routes): void {
    const h = this.host;
    this.mm.rebuild(
      r,
      (dst) => (dst >= 92 && dst <= 99) || !isGlobal(dst),
      (dst) => () => h.A[dst],
      (src) => this.source(src),
      (j) => () => this.matAmt[j],
    );
  }

  /** 0xda70: where modulation source `i` lives. */
  source(i: number): () => number {
    const h = this.host;
    switch (i) {
      case 0: return () => h.lfo1.out18;
      case 1: return () => h.lfo2.out18;
      case 2: return () => this.env1.value;
      case 3: return () => this.env2.value;
      case 4: return () => this.vel;
      case 5: return () => this.relVel;
      case 6: return () => this.s2e70;
      case 7: return () => this.s2e74;
      case 8: return () => this.s2e60;
      case 9: return () => this.s2e64;
      case 10: return () => h.lfo1.out14;
      case 11: return () => h.lfo1.out10;
      case 12: return () => h.lfo2.out10;
      case 13: return () => this.keyMinusHalf;
      case 14: return () => h.srcLfo1Tri;
      case 15: return () => h.srcLfo2;
      case 16: return () => h.srcLfo1Sine;
      case 17: return () => h.srcLfo1Uni;
      case 18: return () => h.srcLfo2Uni;
      case 19: return () => this.rndSign;
      case 20: return () => this.keyNorm;
      case 21: return () => this.rndVal;
      case 22: return () => this.s2e78;
      case 23: return () => this.s2e7c;
      default: return () => 0;
    }
  }

  /** 0xdc30: Mod X = the note's Mod X + the engine's X offset, clamped to -0.5..0.5 (bipolar, unipolar copy). */
  updateModX(): void {
    let s = f32(f32(this.fcutMod + this.host.B[149]) + -0.5);
    s = s < -0.5 ? -0.5 : Math.min(s, 0.5);
    this.s2e70 = s;
    this.s2e78 = f32(s + 0.5);
  }

  /** 0xdc70: Mod Y. */
  updateModY(): void {
    let s = f32(f32(this.fresMod + this.host.B[150]) + -0.5);
    s = s < -0.5 ? -0.5 : Math.min(s, 0.5);
    this.s2e74 = s;
    this.s2e7c = f32(s + 0.5);
  }

  // ------------------------------------------------------------------ per sample
  private shape(sh: number, phase: number, wave: number): number {
    // shapes: 0 sine, 1 triangle, 2 square, 3 saw, 4 noise, 5 the oscillator's own output
    switch (sh) {
      case 0: return sinf(f32(phase * f32(6.2831854820251465)));
      case 1: return phase < 0.5 ? fma32(phase, 4, -1) : fma32(f32(phase + -0.5), -4, 1);
      case 2: return phase < 0.5 ? -1 : 1;
      case 3: return fma32(phase, 2, -1);
      case 4: return this.noiseValue;
      case 5: return wave;
      default: return 0;
    }
  }

  /** 0xdcb0: advance envelopes, portamento and compute the oscillators' increments and the filter inputs. */
  update(): void {
    const h = this.host;
    this.env1.tick();
    this.env2.tick();
    if (++this.ctlCount >= this.ctlPeriod) { this.ctlCount = 0; this.modTick(); }
    const sS10 = f32(-0.4320000112056732), sS11 = f32(0.4580000042915344);
    {
      const src = this.pwValue(this.pw1Src);
      this.osc1.thrB = this.ex1.thrPw = fma32(f32(src * sS10), this.pw1Amt, sS11);
    }
    // portamento
    {
      const tgt = this.pitchTgt;
      let cur = this.pitchCur;
      if (this.portaMode !== 0) {
        if (tgt > cur) { cur = f32(cur + this.portaStep); if (!(cur < tgt)) cur = tgt; this.pitchCur = cur; }
        else if (tgt < cur) { cur = f32(cur - this.portaStep); if (!(tgt < cur)) cur = tgt; this.pitchCur = cur; }
      } else {
        this.pitchCur = cur = fma32(f32(tgt - cur), this.portaCoef, cur);
      }
    }
    const s8 = f32(h.srcLfo1Sine + h.srcLfo1Sine);
    const s9 = f32(h.srcLfo2 + h.srcLfo2);
    const bend = f32(h.bend * this.bendRange);
    let s12 = f32(this.pitchCur + bend);
    s12 = f32(s12 + this.octave);
    s12 = f32(s12 + this.noteOfs);
    s12 = f32(s12 + h.pitchOffset);
    let inner = fma32(s9, this.lfo2Dco1, s12);
    inner = fma32(this.env2.value, this.env2Dco1, inner);
    inner = f32(inner + this.fine2);
    let s13 = fma32(s8, this.lfo1Dco1, inner);
    const enh = h.enhOsc;
    const w22 = enh;
    if (this.dco2Active) {
      const s14 = this.par[29];
      const sh = this.xm21Shape;
      let val = 0;
      if (sh <= 5) {
        const ph = f32(enh ? this.ex2.phase : this.osc2.phase);
        val = this.shape(sh, ph, enh ? this.ex2.out1 : this.osc2.outPulse);
      }
      s13 = fma32(s14, val, s13);
    }
    const inc1 = Math.max(Math.min(this.invSrOs * (exp2d(s13 * 1.0005) * 440), 0.25), 0);
    this.osc1.inc = this.ex1.inc = inc1;
    if (!w22) this.osc1.updateLeak();
    if (this.dco2Active) {
      const src = this.pwValue(this.pw2Src);
      this.osc2.thrB = this.ex2.thrPw = fma32(f32(src * sS10), this.pw2Amt, sS11);
      let t = f32(s12 + this.dco2Pitch);
      t = fma32(s8, this.lfo1Dco2, t);
      t = fma32(s9, this.lfo2Dco2, t);
      t = fma32(this.env2.value, this.env2Dco2, t);
      const s10 = f32(t + this.fine1);
      const s11 = this.par[28];
      const sh = this.xm12Shape;
      let val = 0;
      if (sh <= 5) {
        const ph = f32(enh ? this.ex1.phase : this.osc1.phase);
        val = this.shape(sh, ph, enh ? this.ex1.out1 : this.osc1.outPulse);
      }
      const lg = exp2f(fma32(s11, val, s10));
      const inc2 = Math.max(Math.min(f32(f32(lg * 440) * this.invSrOsF), 0.25), 0);
      this.osc2.inc = this.ex2.inc = inc2;
      if (!enh) this.osc2.updateLeak();
    }
    // filter cutoff
    {
      const keyTrack = f32(this.par[39] * f32(f32(this.key - 24) * f32(0.0833333358168602)));
      const modv = fma32(s9, this.lfo2Cut, fma32(f32(this.env1.value * this.envPol), this.envCut, f32(s8 * this.lfo1Cut)));
      let c = f32(keyTrack + modv);
      if (this.fmAmt !== 0) {
        const sh = this.fmShape;
        let val = 0;
        if (sh <= 5) {
          const ph = f32(enh ? this.ex1.phase : this.osc1.phase);
          val = this.shape(sh, ph, enh ? this.ex1.out1 : this.osc1.outPulse);
        }
        c = fma32(this.fmAmt, val, c);
      }
      let cut = f32(this.cutBase * exp2f(c));
      cut = cut < 5 ? 5 : Math.min(cut, 30000);
      const b = this.bank;
      b.cutoff[this.lane] = cut;
      b.res[this.lane] = this.reso;
    }
    this.gate = fma32(f32(this.velGate - this.gate), this.gateCoef, this.gate);
    this.age++;
  }

  /** 0xe314: oscillator and noise stage for one oversampled sample; writes the filter input. */
  oscStage(): void {
    const enh = this.host.enhOsc;
    if (enh) this.ex1.tick(); else this.osc1.tick();
    this.noiseStep();
    let s0 = enh ? this.ex1.out0 : this.osc1.outSaw;
    let x: number;
    if (this.dco2Active) {
      if (enh) this.ex2.tick(); else this.osc2.tick();
      const s2 = enh ? this.ex2.out0 : this.osc2.outSaw;
      const s3 = f32(s2 * this.dco2Level);
      let s1 = fma32(s0, this.dco1Level, s3);
      s1 = fma32(this.noiseValue, this.noiseLevel, s1);
      const am = f32(s0 * this.amAmt);
      x = fma32(am, s2, s1);
    } else {
      const s2 = f32(this.noiseValue * this.noiseLevel);
      x = fma32(s0, this.dco1Level, s2);
    }
    this.bank.input[this.lane] = f32(x * f32(0.27000001072883606));
  }

  /** 0x3812c: the recorded noise table, one sample per call. */
  private noiseStep(): void {
    this.noiseValue = f32(noiseSample(this.noiseIdx, this.host.noiseTable ?? undefined) * f32(8.631591481389478e-05));
    const n = this.noiseIdx + 1;
    this.noiseIdx = n >= NOISE_LEN ? 0 : n;
  }

  /** 0xe43c: add the voice's filtered, amplified and panned output to the sums. */
  out(acc: Float32Array): void {
    let s0: number;
    if (this.vcaSrc === 0) s0 = this.gate; // the gate is never smoothed (the option only filters the envelopes)
    else {
      const e = this.vcaSrc === 1 ? this.env1.value : this.env2.value;
      s0 = f32(this.velAmp * Math.max(f32(e + f32(-0.02500000037252903)), 0));
      if (this.vcaSmooth) s0 = fma32(f32(s0 - this.vcaOut), this.vcaCoef, this.vcaOut);
    }
    this.vcaOut = s0;
    let s1 = this.panL;
    if (this.gainFlag) {
      this.gainL = s1; this.gainR = this.panR; this.gainFlag = false;
    } else {
      const c = this.panCoef;
      const nl = fma32(f32(s1 - this.gainL), c, this.gainL);
      const nr = fma32(f32(this.panR - this.gainR), c, this.gainR);
      this.gainL = nl; this.gainR = nr;
      s1 = nl;
    }
    const s2 = this.bank.out[this.lane];
    acc[0] = fma32(f32(s2 * s1), s0, acc[0]);
    acc[1] = fma32(f32(s2 * this.gainR), this.vcaOut, acc[1]);
  }

  // pan / pitch / modulation from the note's live levels (kinds of MyPlugin::noteExpr 0x79e8)
  setExpression(kind: number, val: number): void {
    switch (kind) {
      case 1: this.fcutMod = f32(val * 0.5); this.updateModX(); break;
      case 2: this.fresMod = f32(val * 0.5); this.updateModY(); break;
      case 3: this.noteOfs = f32(f32(val * f32(0.009999999776482582)) / 12); break;
      case 4: {
        let x = f32(f32(val + 1) * 0.5);
        x = x < 0 ? x : Math.min(x, 1);
        const a = f32(Math.sqrt(f32(1 - x))), b = f32(Math.sqrt(x));
        this.panL = f32(a * f32(1.4144271612167358));
        this.panR = f32(b * f32(1.4144271612167358));
        break;
      }
      default: break;
    }
  }
}

/** 0x61b8: coefficient for a one-pole that reaches `frac` of the way in t seconds. */
export function coefTime(t: number, frac: number, sr: number): number {
  if (t === 0) return 1;
  return f32(1 - Math.pow(1 - frac, 1 / (t * sr)));
}

/** 0x5cbc: velocity curve of the note's MIDI velocity (0..1). */
function velCurve(v: number): number {
  const a = f32(f32(v * f32(0.9843500256538391)) * v);
  const b = f32(f32(v * f32(-0.23157300055027008)) * v);
  return fma32(v, f32(0.24722300469875336), fma32(a, v, b));
}
