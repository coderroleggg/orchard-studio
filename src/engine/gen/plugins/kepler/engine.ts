// Kepler / Kepler Exo synth engine (engine.dylib class "MyPlugin"): eight voices, two LFOs, the
// parameter smoother, the oversampled signal path with its half-band decimator, the high-pass, the
// chorus and the effects. Kepler (the Juno-6 emulation) is the same engine reached through a 36-entry
// parameter map; Exo exposes every parameter. Decoded from FL 2026's arm64 engine.dylib
// (0x8508 process, 0x8918 one sample, 0x902c / 0x8f94 parameter application, 0x7c84 / 0x8158 notes).

import { f32, fma32 } from './fmath';
import { exp10f, powf, exp2f, tanf } from './applemath';
import { KLfo1, KLfo2, buildSineTable } from './lfo';
import { LadderBank } from './filter';
import { KVoice, coefTime, quant } from './voice';
import type { VoiceHost } from './voice';
import { HalfBand } from './halfband';
import { OnePole } from './onepole';
import { JunoChorus } from './chorus';
import { Arp, arpPeriod } from './arp';
import { Saturation } from './sat';
import { Eq } from './eq';
import { HyperChorus } from './hyperchorus';
import { KDelay } from './delay';
import { FxReverb } from './reverb';
import { TIME_DELAY, RATE_LFO1 } from './tables';
import { NOISE_LEN } from './noise';
import { ModMatrix, isRouted, isGlobal as isGlobalParam, NSLOT } from './modmatrix';
import type { Routes } from './modmatrix';
import { KEPLER_ENGINE_DEFAULTS, EXO_ENGINE_DEFAULTS } from './defaults';

/** Parameter ids whose changes the smoother glides (0x9c0c). */
const SMOOTHED = new Uint8Array(260);
for (let id = 138; id <= 148; id++) if (id !== 144) SMOOTHED[id] = 1;
{
  const mask = 0x422000000ac00081n;
  for (let b = 0; b < 63; b++) if ((mask >> BigInt(b)) & 1n) SMOOTHED[10 + b] = 1;
}

const NPAR = 260;

/** One entry of the parameter smoother (0xb758 / 0xb8b0). */
interface Glide { id: number; cur: number; target: number }

export class KeplerEngine implements VoiceHost {
  readonly sr: number;
  readonly exo: boolean;
  /** oversampling factor (2; 4 in HQ) and control period (44 samples) */
  os = 2;
  ctlPeriod = 44;

  // parameter arrays: targets (P, @0x1abb8), smoothed (A, @0x1b3c8), applied after modulation (B, @0x1b7d0)
  readonly P = new Float32Array(NPAR);
  readonly A = new Float32Array(NPAR);
  readonly B = new Float32Array(NPAR);
  private readonly glides: Glide[] = [];
  glideCoef = 0;

  // modulation matrix: the route table (+0x1c9e0), the engine-level matrix (+0x220) and its amounts (+0x1c9e8),
  // the focus voice's source copies (+0x1ce78)
  readonly routes: Routes = { src: new Array(NSLOT).fill(-1), dst: new Array(NSLOT).fill(-1) };
  private routesDirty = true;
  private readonly mm = new ModMatrix();
  readonly ampEng = new Float32Array(NSLOT);
  readonly focus = new Float32Array(14);

  readonly lfo1 = new KLfo1();
  readonly lfo2 = new KLfo2();
  srcLfo1Sine = 0;
  srcLfo2 = 0;
  srcLfo1Uni = 0; srcLfo2Uni = 0; srcLfo1Tri = 0;
  /** LFO delay fade (0x13c0 / 0x13c4) and its per-sample increments (0x13c8 / 0x13cc), LFO gates (0x1c828 / 0x1c82c) */
  fade = [1, 1];
  fadeInc = [0, 0];
  lfoGate = [1, 1];
  lfoTrig = [0, 0];

  bend = 0;
  pitchOffset = 0;
  noiseTable: Int16Array | null = null;
  enhOsc = false;
  filterType = 0;
  private flip = -0.5;          // @0x1c830
  private lcg = 77784;          // @0x1ceb8 (FL hands every new engine the next value of a process-wide counter, 77784 for the first)

  readonly voices: KVoice[] = [];
  readonly banks: LadderBank[] = [new LadderBank(), new LadderBank()];
  private readonly halfs: HalfBand[] = [new HalfBand(), new HalfBand()];
  private readonly hp = new OnePole();
  readonly chorus = new JunoChorus();
  // effects (chain order after the chorus: saturation before / EQ / hyper chorus / delay / reverb / saturation after)
  readonly sat = new Saturation();
  readonly eq = new Eq();
  eqOn = false;                          // @0x1cc50
  readonly hc = new HyperChorus();
  readonly delay = new KDelay();
  hcOn = false;                          // @0x1cd90
  satOn = false; satPost = false;
  readonly reverb: FxReverb;
  reverbOn = false;
  private readonly rvL = new Float32Array(1);
  private readonly rvR = new Float32Array(1);
  // chorus mode switch (0x1bbd8 mode in use, +8 target, +0xc state 0 steady / 1 fading in / 2 fading out, +0x250 fade)
  chMode = 0; chTarget = 0; chState = 0; chFade = 1; chFadeInc = 0;
  private readonly cw = new Float32Array(2);
  hpActive = true;

  // master output (0x1400 / 0x1408 / 0x1410 smoothing; 0x13d4 / 0x13dc MIDI volume and pan)
  readonly masterTarget = [0, 0];
  readonly masterCur = [0, 0];
  masterCoef = 0;
  midiVol = 1; midiPan = 0.5;            // @0x13e8 / @0x13ec
  readonly midiGainTarget = [0, 0];      // @0x13d4
  readonly midiGainCur = [0, 0];         // @0x13dc

  // note handling
  readonly held: number[] = [];          // @0x1468 list of held keys (7e38 / 7ed0)
  lastKey = 64;                          // @0x1428 (the constructor stores 64; only a note on changes it)
  focusVoice = 0;                        // @0x13f4
  sampleCounter = 0;                     // @0x1cec0
  ctlCount = 0;                          // @0x13f8
  playing = false;
  time = 0;                              // beats (0x1418)
  seconds = 0;                           // 0x1420

  private readonly acc = new Float32Array(2);
  private readonly sL = new Float32Array(8);
  private readonly sR = new Float32Array(8);
  private readonly io = new Float32Array(2);

  constructor(sr: number, exo = false) {
    this.sr = sr;
    this.exo = exo;
    for (let g = 0; g < 2; g++) this.banks[g].tap = 3;
    for (let k = 0; k < 8; k++) {
      const v = new KVoice(this, this.banks[k >> 2], k & 3);
      v.noiseIdx = Math.trunc((k * NOISE_LEN) / 8); // the voices read the noise loop from evenly spread points
      this.voices.push(v);
    }
    this.hp.setSampleRate(sr);
    this.chorus.setSampleRate(sr);
    this.sat.setSampleRate(sr);
    this.eq.setSampleRate(sr);
    this.hc.setSampleRate(sr);
    this.delay.setSampleRate(sr);
    this.reverb = new FxReverb(sr);
    this.chFadeInc = f32(200 / sr);
    this.ctlPeriod = Math.trunc(sr / 1000);
    this.lfo1.seed = 22222;
    this.lfo2.seed = (22222 + 0x8235) | 0;
    this.lfo1.inc = f32(0.01); this.lfo1.rate = 1;
    this.lfo2.inc = f32(0.01); this.lfo2.rate = 1;
    this.configure();
    this.resetDefaults();
    this.setMidiVolumePan(1, 0.5, true); // FL's engine has run since it was created: the MIDI gain rests at its default

    // the engine's constructor routes Mod X -> cutoff and Mod Y -> resonance (after the defaults went to the voices)
    if (!exo) { this.routes.src[0] = 6; this.routes.dst[0] = 37; this.routes.src[1] = 7; this.routes.dst[1] = 38; }
  }

  /** 0x7814: configure voices and filters for the sample rate and oversampling, then re-apply every parameter. */
  configure(): void {
    for (const v of this.voices) v.config(this.sr, this.ctlPeriod, this.os);
    for (const b of this.banks) b.setSampleRate(this.sr * this.os);
    this.glideCoef = coefTime(0.2, 0.99, this.sr);
    this.masterCoef = coefTime(0.0025, 0.9, this.sr);
    for (const v of this.voices) v.osc1.setN(this.os), v.osc2.setN(this.os);
  }

  /** The engine's constructor defaults (read from FL's engine; the Kepler build differs in a few). */
  resetDefaults(): void {
    this.P.set(this.exo ? EXO_ENGINE_DEFAULTS : KEPLER_ENGINE_DEFAULTS);
    for (let id = 0; id < NPAR; id++) this.applyParam(id, this.P[id]);
  }

  // ------------------------------------------------------------------ parameters
  /** 0x7634 / 0x7460: set a parameter (the value is a normalised float); the smoother glides most of them. */
  setParameter(id: number, v: number): void {
    v = f32(v);
    this.addGlide(id, this.P[id], v);
    this.P[id] = v;
  }

  /** A state load: the value takes effect at once (the smoother is off while FL loads a state). */
  setParameterNow(id: number, v: number): void {
    v = f32(v);
    const i = this.glides.findIndex((g) => g.id === id);
    if (i >= 0) this.glides.splice(i, 1);
    this.P[id] = v;
    this.applyParam(id, v);
  }

  /** 0xb758 */
  private addGlide(id: number, cur: number, target: number): void {
    if (!SMOOTHED[id]) { this.applyParam(id, target); return; }
    for (const g of this.glides) if (g.id === id) { g.target = target; return; }
    this.glides.push({ id, cur, target });
  }

  /** 0xb8b0: one smoother step (every sample). */
  private tickGlides(): void {
    const gs = this.glides;
    for (let k = gs.length - 1; k >= 0; k--) {
      const g = gs[k];
      if (Math.abs(f32(g.target - g.cur)) < f32(9.999999747378752e-05)) {
        const id = g.id, t = g.target;
        this.applyParam(id, t);
        // the callback may have changed the list; remove this entry
        const i = gs.indexOf(g);
        if (i >= 0) gs.splice(i, 1);
      } else {
        g.cur = fma32(f32(g.target - g.cur), this.glideCoef, g.cur);
        this.applyParam(g.id, g.cur);
      }
    }
  }

  private readonly applyGlobal = (id: number, v: number): void => this.onParam(id, v);

  /** 0x8f94: a (smoothed) parameter value reaches the voices and effects. */
  applyParam(id: number, v: number): void {
    if (id >= 0x1000000) return; // MIDI controller sources (mod matrix) are not ported yet
    this.A[id] = v;
    if (isRouted(this.routes, id)) return; // the matrix delivers it (modulated) at the next control tick
    this.onParam(id, v);
  }

  /** 0x902c */
  private onParam(id: number, v: number): void {
    const prev = this.B[id];
    this.B[id] = v;
    const B = this.B;
    switch (id) {
      case 36: {
        const x = powf(v, f32(1.600000023841858));
        this.hp.setHighpass(fma32(x, 2680, 20));
        break;
      }
      case 48: this.setLfo1Rate(v); break;
      case 49: this.lfo1.setSync(v >= 0.5); this.setLfo1Rate(B[48]); break;
      case 50: this.fadeInc[0] = this.delayInc(v); break;
      case 51: {
        const mode = v >= 0.5 ? 1 : 0;
        this.lfoTrig[0] = mode;
        this.lfoGate[0] = mode === 1 && B[81] < 0.5 ? 0 : 1;
        break;
      }
      case 54: this.setLfo2Rate(v); break;
      case 55: this.lfo2.setSync(v >= 0.5); this.setLfo2Rate(B[54]); break;
      case 56: this.fadeInc[1] = this.delayInc(v); break;
      case 57: {
        const mode = v >= 0.5 ? 1 : 0;
        this.lfoTrig[1] = mode;
        this.lfoGate[1] = mode === 1 && B[81] < 0.5 ? 0 : 1;
        break;
      }
      case 58: this.lfo2.setShape(Math.trunc(((6 - 1) * v) + 0.5)); break;
      case 82: this.setHold(v >= 0.5); break;
      case 85: this.setArp(v >= 0.5); break;
      case 86: this.arp.setPeriod(arpPeriod(v, this.arpSync, quant)); break;
      case 87: {
        const on = v >= 0.5;
        if (this.arpSync !== on) { this.arp.stop(); this.arpSync = on; }
        this.arp.setPeriod(arpPeriod(B[86], this.arpSync, quant));
        break;
      }
      case 88: this.arp.range = 1 << quant(v, 3); break;
      case 89:
        this.arp.mode = this.exo ? quant(v, 9) : (v < f32(0.3330000042915344) ? 0 : (v < f32(0.6660000085830688) ? 1 : 2));
        break;
      case 90: this.arp.setGate(v); break;
      case 91: this.arp.buggy = v < 0.5; break;
      case 81: {
        // the manual LFO trigger button (0x8048 on a rising edge)
        if (v >= 0.5 && prev < 0.5) this.lfoRetrigger(1);
        this.lfoGate[0] = this.lfoTrig[0] === 1 && v < 0.5 ? 0 : 1;
        this.lfoGate[1] = this.lfoTrig[1] === 1 && v < 0.5 ? 0 : 1;
        break;
      }
      case 100: this.eqOn = v >= 0.5; break;
      case 101: case 102: case 103: case 104: case 105: case 106: case 107: case 108: case 109: this.eq.setParam(id - 100, v); break;
      case 110: case 111: case 112: case 113: case 114: case 115: case 116: case 117: case 118: case 119: case 120: this.delay.setParam(id - 110, v); break;
      case 137: this.hcOn = v >= 0.5; break;
      case 138: case 139: case 140: case 141: case 142: case 143: case 144: case 145: case 146: case 147: case 148: this.hc.setParam(id - 138, v); break;
      case 121: this.reverbOn = v >= 0.5; break;
      case 122: this.reverb.setParam(1, v); break;
      case 123: this.reverb.setParam(2, v); break;
      case 124: this.reverb.setParam(3, v); break;
      case 125: this.reverb.setParam(4, f32(v * f32(0.8999999761581421))); break;
      case 126: this.reverb.setParam(5, v); break;
      case 127: this.reverb.setParam(6, v); break;
      case 128: this.reverb.setParam(9, f32(v * v)); break;
      case 129: this.reverb.setParam(10, v); break;
      case 130: this.reverb.setParam(14, v); break;
      case 131: this.reverb.setParam(11, v); break;
      case 132: this.reverb.setParam(12, v); break;
      case 133: this.reverb.setParam(13, v); break;
      case 134: this.satOn = v >= 0.5; break;
      case 135: this.sat.setAmount(v); break;
      case 136: this.satPost = v >= 0.5; break;
      case 152: this.sat.hq = v >= 0.5; break;
      case 154: this.hpActive = v >= 0.5; break; // the output high-pass (0x9890: a flag at +0x1c769)
      case 69: {
        const m = quant(v, 4);
        if (this.chTarget !== m) { this.chTarget = m; this.chState = 2; }
        break;
      }
      case 70:
        // the Exo dispatcher scales the value by 1/4 first (and hands the scaled value on to the voices)
        if (this.exo) v = f32(v * 0.25);
        this.chorus.setNoise(f32(f32(v * v) * v));
        break;
      case 71: this.chorus.setGate(v >= 0.5); break;
      case 72: case 74: this.setMaster(); break;
      case 75: this.flReset(); break; // the mono switch runs MyPlugin::reset (also when the matrix drives it, at every control tick)
      case 92: case 93: case 94: case 95: case 96: case 97: case 98: case 99:
        this.ampEng[id - 92] = fma32(v, 2, -1);
        break;
      case 149: for (const vo of this.voices) vo.updateModX(); break;
      case 150: for (const vo of this.voices) vo.updateModY(); break;
      default: break;
    }
    for (const vo of this.voices) vo.setParam(id, v, this.exo);
  }

  /** Cubic volume taper shared by the master volume and the MIDI volume (0x90cc, 0x795c). */
  private volCurve(v: number): number {
    const a = f32(v * f32(v * f32(0.9843500256538391)));
    const b = f32(v * f32(v * f32(-0.23157300055027008)));
    return fma32(v, f32(0.24722300469875336), fma32(a, v, b));
  }

  /** 0x90cc: master volume (inverting) and pan to the target gain pair. */
  private setMaster(): void {
    const gain = -this.volCurve(this.B[72]);
    let pan = this.B[74];
    pan = pan < 0 ? pan : Math.min(pan, 1);
    const k = f32(1.4144271612167358);
    this.masterTarget[0] = f32(f32(f32(Math.sqrt(f32(1 - pan))) * k) * gain);
    this.masterTarget[1] = f32(f32(f32(Math.sqrt(pan)) * k) * gain);
  }

  private delayInc(v: number): number {
    const s0 = f32(v * 10);
    const i = Math.trunc(s0);
    let t: number;
    if (i > 9) t = f32(6.705999851226807);
    else {
      const fr = f32(s0 - i);
      t = fma32(TIME_DELAY[i], f32(1 - fr), f32(fr * TIME_DELAY[i + 1]));
    }
    return t > 0 ? f32(1 / f32(t * f32(this.sr))) : 1;
  }

  private setLfo1Rate(v: number): void {
    const s = f32(v * 10);
    const i = Math.trunc(s);
    let e: number;
    if (i > 9) e = 0;
    else {
      const fr = f32(s - i);
      e = fma32(RATE_LFO1[i], f32(1 - fr), f32(fr * RATE_LFO1[i + 1]));
    }
    const hz = f32(1 / f32(exp2f(e) * f32(0.04600000008940697)));
    this.lfo1.inc = f32(hz * f32(1 / this.sr));
    this.lfo1.rate = this.syncRate(v);
  }

  private setLfo2Rate(v: number): void {
    const hz = f32(f32(exp10f(f32(v * 4)) * f32(0.10000000149011612)));
    this.lfo2.inc = f32(hz * f32(1 / this.sr));
    this.lfo2.rate = this.syncRate(v);
  }

  /** LFO tempo-sync scale: 1 / ((trunc(((2^(7(1-v)) - 1) 1.007874 48 6143) / 6144 + 1.1) / 48) 0.25). */
  private syncRate(v: number): number {
    const e = exp2f(f32(f32(1 - v) * 7));
    const t = f32(f32(f32(f32(f32(e + -1) * f32(1.0078740119934082)) * 48) * f32(6143)) / 6144);
    const n = Math.trunc(f32(t + f32(1.100000023841858)));
    return 1 / ((n / 48) * 0.25);
  }

  // ------------------------------------------------------------------ voice host
  randFlip(): number { this.flip = f32(-this.flip); return this.flip; }
  randLcg(): number {
    this.lcg = (Math.imul(this.lcg, 0x0bb38435) + 0x3619636b) | 0;
    return f32(f32(f32(this.lcg) * f32(4.656612873077393e-10)) * 0.5); // 0x82f8: the signed state / 2^32
  }

  // ------------------------------------------------------------------ notes
  /** FL's LFO sine and noise loop (the user's import); null keeps the stand-ins. */
  setTables(t: { lfo: Int16Array; noise: Int16Array } | null): void {
    this.lfo1.sine = buildSineTable(t ? t.lfo : null);
    this.noiseTable = t ? t.noise : null;
  }

  /** The wrapper's note on (vtable +0x30, 0x8344): the held-key stack, the LFO retrigger and the arpeggiator in front of the voices. */
  hostNoteOn(key: number, vel: number): void {
    const stk = this.stackKeys;
    // 0x34768: a key that is already held is ignored
    if (stk.indexOf(key) >= 0) return;
    stk.push(key); this.stackVels.push(vel);
    let first = false;
    if (stk.length === 1) {
      if (!this.hold || this.holdEmpty) {
        this.lfoRetrigger(0); // 0x7fa0 (automatic trigger mode) on the first held note
        this.holdEmpty = false;
        first = true;
        if (this.hold && this.arp.enabled) this.arp.clearLists();
      } else if (this.arp.enabled) this.arp.clearLists();
    }
    const quant = this.arpQuantize && this.playing ? this.arpSync : false;
    this.arp.noteOn(key, vel, first, quant);
  }

  /** The wrapper's note off (vtable +0x38, 0x8448). */
  hostNoteOff(key: number, vel: number): void {
    const i = this.stackKeys.indexOf(key);
    if (i >= 0) { this.stackKeys.splice(i, 1); this.stackVels.splice(i, 1); }
    if (this.hold) return;
    this.arp.noteOff(key, vel);
  }

  /** The keys the wrapper holds (@0x1440): as played. */
  private readonly stackKeys: number[] = [];
  private readonly stackVels: number[] = [];
  hold = false;          // @0x1bbdc
  holdEmpty = false;     // @0x1bbdd
  arpSync = false;       // @0x1414
  readonly arp: Arp = new Arp({
    noteOn: (k, v) => this.noteOn(k, v),
    noteOff: (k, v) => this.noteOff(k, v),
  }, 0x6ad6fb1d);

  /** The hold switch (id 82, 0x96f0): holding keeps notes sounding after the keys are released. */
  private setHold(on: boolean): void {
    if (this.hold === on) return;
    this.hold = on;
    if (on) { this.holdEmpty = this.stackKeys.length === 0; return; }
    // released: whatever only the hold kept alive stops
    if (this.arp.enabled) this.arp.releaseUnheld((k) => this.stackKeys.indexOf(k) >= 0);
    else for (const v of this.voices) if (this.stackKeys.indexOf(v.key) < 0 && v.s2e60 !== 0) v.noteOff(0);
  }

  /** The arp switch (id 85, 0x9730). */
  private setArp(on: boolean): void {
    if (this.arp.enabled === on) return;
    this.arp.enable(on);
    if (!on) return;
    // the keys held now start the arpeggio; the voices playing them directly stop
    const quant = this.arpQuantize && this.playing ? this.arpSync : false;
    for (let i = 0; i < this.stackKeys.length; i++) this.arp.noteOn(this.stackKeys[i], this.stackVels[i], true, quant);
    for (const v of this.voices) v.noteOff(0);
  }

  /**
   * 0x7fa0 (mode 0: an LFO in automatic trigger mode restarts on a note) / 0x8048 (mode 1: the manual trigger button
   * restarts an LFO in manual mode): the delay fade starts again, the phase follows the LFO's retrigger settings.
   */
  lfoRetrigger(mode: number): void {
    const B = this.B;
    if (this.lfoTrig[0] === mode) {
      this.fade[0] = 0;
      this.lfo1.requestResync();
      if (B[52] >= 0.5) this.lfo1.setPhase(B[53]);
    }
    if (this.lfoTrig[1] === mode) {
      this.fade[1] = 0;
      this.lfo2.requestResync();
      if (B[59] >= 0.5) this.lfo2.setPhase(B[60]);
    }
  }

  /** 0x79e8: a note expression (1 Mod X, 2 Mod Y, 3 pitch cents beyond the key, 4 pan) for the first voice playing `key`. */
  noteExpr(key: number, kind: number, val: number): void {
    for (const v of this.voices) {
      if (v.key === key) { v.setExpression(kind, val); return; }
    }
  }

  /** Exo's modulation matrix: 8 (source, destination) slots (-1 = none). */
  setModMatrix(src: number[], dst: number[]): void {
    for (let k = 0; k < NSLOT; k++) {
      const s = src[k] ?? -1, d = dst[k] ?? -1;
      if (this.routes.src[k] !== s || this.routes.dst[k] !== d) { this.routes.src[k] = s; this.routes.dst[k] = d; this.routesDirty = true; }
    }
  }

  /** 0x3080c for the engine's matrix and every voice's (the process loop does it when the route table changed). */
  private rebuildMatrices(): void {
    this.routesDirty = false;
    this.mm.rebuild(
      this.routes,
      (dst) => dst !== 84 && isGlobalParam(dst),
      (dst) => () => this.A[dst],
      (src) => this.engineSource(src),
      (j) => () => this.ampEng[j],
    );
    for (const v of this.voices) v.rebuildMatrix(this.routes);
  }

  /** 0x9c84: the engine-level matrix reads the focus voice's copies. */
  private engineSource(i: number): () => number {
    const f = this.focus;
    switch (i) {
      case 0: return () => this.lfo1.out18;
      case 1: return () => this.lfo2.out18;
      case 2: return () => f[0];
      case 3: return () => f[1];
      case 4: return () => f[8];
      case 5: return () => f[9];
      case 6: return () => f[2];
      case 7: return () => f[3];
      case 8: return () => f[6];
      case 9: return () => f[7];
      case 10: return () => this.lfo1.out14;
      case 11: return () => this.lfo1.out10;
      case 12: return () => this.lfo2.out10;
      case 13: return () => f[10];
      case 14: return () => this.srcLfo1Tri;
      case 15: return () => this.srcLfo2;
      case 16: return () => this.srcLfo1Sine;
      case 17: return () => this.srcLfo1Uni;
      case 18: return () => this.srcLfo2Uni;
      case 19: return () => f[12];
      case 20: return () => f[11];
      case 21: return () => f[13];
      case 22: return () => f[4];
      case 23: return () => f[5];
      default: return () => 0;
    }
  }

  /** 0x9e20: the focus voice's values for the engine-level matrix. */
  private copyFocus(): void {
    const v = this.voices[this.focusVoice];
    const f = this.focus;
    f[0] = v.env1.value; f[1] = v.env2.value;
    f[2] = v.s2e70; f[3] = v.s2e74; f[4] = v.s2e78; f[5] = v.s2e7c;
    f[6] = v.s2e60; f[7] = v.s2e64; f[8] = v.vel; f[9] = v.relVel;
    f[10] = v.keyMinusHalf; f[11] = v.keyNorm; f[12] = v.rndSign; f[13] = v.rndVal;
  }

  /** The song position jumped backwards (loop, seek): the arpeggiator re-syncs. */
  timeJumped(_beats: number): void { /* ported later */ }

  arpQuantize = false;

  /** Oversampling 2 (4 in HQ mode): the voices and filters are configured again. */
  setOversampling(os: number): void {
    this.os = os;
    this.configure();
  }

  /** Back to the state of a new instance (the parameters stay). */
  reset(): void {
    for (const v of this.voices) v.reset();
    this.held.length = 0;
  }

  /**
   * 0x9ea4, MyPlugin::reset: every voice is released and its envelopes idle, the note stack and the held-key list are emptied,
   * the arpeggiator stops, the delay core and the reverb are cleared (the other effects, the chorus and the filters stay).
   */
  private flReset(): void {
    for (const v of this.voices) v.flReset();
    this.stackKeys.length = 0; this.stackVels.length = 0;
    this.arp.stop();
    this.held.length = 0;
    this.delay.clearCore();
    this.reverb.flReset();
  }

  /** 0x7c84 (poly and mono) after the held-key list update. */
  noteOn(key: number, vel: number): void {
    const held = this.held;
    const lastHeld = held.length ? held[held.length - 1] : -1;
    const i = held.indexOf(key);
    if (i >= 0) held.splice(i, 1);
    held.push(key);
    const velF = f32(vel / 127);
    if (this.B[75] < 0.5) {
      let idx = -1, same = false;
      for (let k = 0; k < 8; k++) if (this.voices[k].key === key) { idx = k; same = true; break; }
      if (idx < 0) {
        let max = 0;
        for (let k = 0; k < 8; k++) if (idx < 0 || this.voices[k].age > max) { idx = k; max = this.voices[k].age; }
      }
      const v = this.voices[idx];
      if (this.B[76] >= 0.5) v.noteOn(lastHeld < 0 ? key : lastHeld, key, velF, true, !same);
      else v.noteOn(this.lastKey, key, velF, true, !same);
    } else {
      const first = held.length === 1;
      const prev = first && this.B[76] >= 0.5 ? key : -1;
      this.voices[0].noteOn(prev, key, velF, first || this.B[77] >= 0.5, first);
    }
    this.lastKey = key;
    this.updateFocus();
  }

  /** 0x8158 */
  noteOff(key: number, vel: number): void {
    const held = this.held;
    const i = held.indexOf(key);
    if (i >= 0) held.splice(i, 1);
    if (this.B[75] < 0.5) {
      const rel = f32(vel / 127);
      for (const v of this.voices) if (v.key === key) v.noteOff(rel);
    } else if (held.length >= 1) {
      this.voices[0].noteOn(-1, held[held.length - 1], -0.007874015718698502, this.P[78] >= 0.5, false);
    } else this.voices[0].noteOff(f32(vel / 127));
    this.updateFocus();
  }

  private updateFocus(): void {
    if (this.held.length >= 1) {
      const k = this.held[this.held.length - 1];
      for (let i = 0; i < 8; i++) if (this.voices[i].key === k) { this.focusVoice = i; break; }
    }
  }

  // ------------------------------------------------------------------ audio
  /** 0x8918: render one output sample into out[0], out[1]. */
  tick(time: number, seconds: number, out: Float32Array): void {
    if (this.routesDirty) this.rebuildMatrices();
    this.arp.tick(this.arpSync ? time : seconds);
    this.sampleCounter++;
    this.tickGlides();
    if (++this.ctlCount >= this.ctlPeriod) {
      this.copyFocus();
      this.ctlCount = 0;
      this.mm.tick(this.applyGlobal);
    }
    this.lfo1.tick(time);
    this.lfo2.tick(time);
    // LFO sources with the delay fade and the trigger gates
    {
      const g1 = f32(this.lfoGate[0] * this.fade[0]), g2 = f32(this.lfoGate[1] * this.fade[1]);
      this.srcLfo1Sine = f32(this.lfo1.out14 * g1);
      this.srcLfo1Uni = f32(this.lfo1.out10 * g1);
      this.srcLfo2Uni = f32(this.lfo2.out10 * g2);
      this.srcLfo1Tri = f32(this.lfo1.out18 * g1);
      this.srcLfo2 = f32(this.lfo2.out18 * g2);
      this.fade[0] = Math.min(f32(this.fade[0] + this.fadeInc[0]), 1);
      this.fade[1] = Math.min(f32(this.fade[1] + this.fadeInc[1]), 1);
    }
    const mono = this.B[75] >= 0.5;
    const nv = mono ? 1 : 8;
    const ng = mono ? 1 : 2;
    for (let v = 0; v < nv; v++) this.voices[v].update();
    for (let g = 0; g < ng; g++) this.banks[g].coeffs();
    const os = this.os;
    const acc = this.acc;
    for (let k = 0; k < os; k++) {
      for (let v = 0; v < nv; v++) this.voices[v].oscStage();
      for (let g = 0; g < ng; g++) this.banks[g].process();
      acc[0] = 0; acc[1] = 0;
      for (let v = 0; v < nv; v++) this.voices[v].out(acc);
      this.sL[k] = acc[0]; this.sR[k] = acc[1];
    }
    // half-band decimation
    {
      const L = this.sL, R = this.sR, io = this.io;
      let n = os, stage = 0;
      while (n >= 2) {
        for (let i = 0; i < n; i++) {
          io[0] = L[i]; io[1] = R[i];
          this.halfs[stage].step(io);
          L[i >> 1] = io[0]; R[i >> 1] = io[1];
        }
        stage++;
        const old = n;
        n >>= 1;
        if (!(old > 3)) break;
      }
    }
    out[0] = this.sL[0]; out[1] = this.sR[0];
    if (this.hpActive) this.hp.process(out);
    this.runChorus(out);
    this.runEffects(out);
    // master volume / pan (smoothed) and the MIDI volume / pan gains
    {
      const c = this.masterCoef;
      this.masterCur[0] = fma32(f32(this.masterTarget[0] - this.masterCur[0]), c, this.masterCur[0]);
      this.masterCur[1] = fma32(f32(this.masterTarget[1] - this.masterCur[1]), c, this.masterCur[1]);
      out[0] = f32(out[0] * this.masterCur[0]);
      out[1] = f32(this.masterCur[1] * out[1]);
      out[0] = f32(this.midiGainCur[0] * out[0]);
      out[1] = f32(this.midiGainCur[1] * out[1]);
      this.midiGainCur[0] = fma32(f32(this.midiGainTarget[0] - this.midiGainCur[0]), f32(0.05), this.midiGainCur[0]);
      this.midiGainCur[1] = fma32(f32(this.midiGainTarget[1] - this.midiGainCur[1]), f32(0.05), this.midiGainCur[1]);
    }
  }

  /** 0x8d74: saturation, EQ, hyper chorus, delay, reverb and the saturation again when it is set to post. */
  private runEffects(out: Float32Array): void {
    if (this.satOn && !this.satPost) this.sat.process(out);
    if (this.eqOn) this.eq.process(out);
    if (this.hcOn) this.hc.process(out);
    this.delay.process(out);
    if (this.reverbOn) {
      const L = this.rvL, R = this.rvR;
      L[0] = out[0]; R[0] = out[1];
      this.reverb.process(L, R, 1);
      out[0] = L[0]; out[1] = R[0];
    }
    if (this.satOn && this.satPost) this.sat.process(out);
  }

  /** The chorus with its click-free mode change (0x8918, after the high-pass). */
  private runChorus(out: Float32Array): void {
    const st = this.chState;
    if (st === 0) {
      if (this.chMode !== 0) this.chorus.process(out);
      return;
    }
    const w = this.cw;
    w[0] = out[0]; w[1] = out[1];
    const dryL = out[0], dryR = out[1];
    if (this.chMode !== 0) this.chorus.process(w);
    else { w[0] = dryL; w[1] = dryR; }
    const f = this.chFade > 0 ? this.chFade : 0;
    const g = f32(1 - f);
    out[0] = fma32(dryL, g, f32(w[0] * f));
    out[1] = fma32(dryR, g, f32(f * w[1]));
    if (st === 1) {
      const nf = f32(this.chFade + this.chFadeInc);
      this.chFade = nf;
      if (nf > 1) { this.chFade = 1; this.chState = 0; }
    } else if (st === 2) {
      const nf = f32(this.chFade - this.chFadeInc);
      this.chFade = nf;
      if (nf < 0) {
        this.chFade = -1; this.chState = 1;
        this.chMode = this.chTarget;
        this.chorus.setMode(this.chTarget);
      }
    }
  }

  /**
   * The master and MIDI gains rest at the fixed point of their smoothers (what FL's engine has long reached when
   * a note arrives): called once the first state has been loaded.
   */
  settleGains(): void {
    const c = this.masterCoef;
    for (let k = 0; k < 2; k++) {
      let cur = this.masterCur[k];
      const t = this.masterTarget[k];
      for (let i = 0; i < 100000; i++) {
        const n = fma32(f32(t - cur), c, cur);
        if (n === cur) break;
        cur = n;
      }
      this.masterCur[k] = cur;
    }
  }

  /** 0x795c: MIDI volume (FPE_MIDI_Vol / 127) and pan (0..1) to the output gain pair. */
  setMidiVolumePan(vol: number, pan: number, jump = false): void {
    this.midiVol = vol; this.midiPan = pan;
    pan = pan < 0 ? pan : Math.min(pan, 1);
    const w = f32(this.volCurve(vol) * f32(6.309000015258789));
    const k = f32(1.4144271612167358);
    this.midiGainTarget[0] = f32(f32(f32(Math.sqrt(f32(1 - pan))) * k) * w);
    this.midiGainTarget[1] = f32(f32(f32(Math.sqrt(pan)) * k) * w);
    if (jump) {
      // the change had been made long before the first note: the engine's smoother has settled at its fixed point
      for (let k = 0; k < 2; k++) {
        let c = this.midiGainCur[k];
        const t = this.midiGainTarget[k];
        for (let i = 0; i < 4000; i++) {
          const n = fma32(f32(t - c), f32(0.05), c);
          if (n === c) break;
          c = n;
        }
        this.midiGainCur[k] = c;
      }
    }
  }
}
