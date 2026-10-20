// SimSynth: FL's plugin object (SSPlug, SimSynth_eng_x64.dylib) and what its FPC
// wrapper (SimSynth_x64.dylib, TTestPlug) does around it:
// - creation (CreatePlugInstance 0x8a7c, SSPlug::DefaultPreset 0x8ba4), the wrapper
//   pushing its form's control values, the host's sample rate / process mode calls;
// - ProcessParam (0x93c8; the wrapper scales coarse by 420), state loads
//   (SaveRestoreState 0x900c + the wrapper re-applying all 58 controls);
// - TriggerVoice (0x9c74, 12 engine voices with stealing), Voice_Release, Voice_Kill;
// - Gen_Render (0x95ec): per voice FL's ComputeLRVol gain with a 128-sample ramp,
//   pitch / Mod X / Mod Y, patch::FillBuff, the mix, and the chorus (Mod, a 65536
//   point delay whose read speed sweeps 0.9928..1.0072; left = delayed, right = dry).

import { Preset } from './preset';
import { Patch } from './patch';
import { G } from './tables';
import { cvtms, cvtzs, f32, fmaf, rint } from './fmath';

export const NV = 12;

/** The uninitialised time counter's start value for new instances (tests may change it). */
export const PLUG_TIME0 = { v: 0x065e065e };

/** SSPlug::ProcessParam's table (0xb52c): [type 0 switch / 1 value / 2 shape, slot, range] by control tag. */
const PT: [number, number, number][] = [
  [1, 3, 65535], [1, 4, 65535], [1, 5, 65535], [1, 10, 65535], [1, 11, 65535], [1, 12, 65535], [1, 17, 65535], [1, 18, 65535], [1, 19, 65535],
  [1, 21, 65535], [1, 22, 65535], [1, 26, 65535], [1, 27, 65535], [1, 28, 65535], [1, 29, 65535], [1, 32, 65535], [1, 33, 65535],
  [1, 35, 65535], [1, 36, 65535], [1, 37, 65535], [1, 38, 65535], [1, 39, 65535], [1, 41, 65535], [1, 42, 65535], [1, 43, 65535], [1, 44, 65535],
  [1, 0, 65535], [1, 1, 20160], [1, 2, 65535], [1, 7, 65535], [1, 8, 20160], [1, 9, 65535], [1, 14, 65535], [1, 15, 20160], [1, 16, 65535], [1, 30, 65535],
  [0, 18, 0], [0, 13, 0], [0, 16, 0], [0, 12, 0], [0, 14, 0], [0, 0, 0], [0, 4, 0], [0, 8, 0], [0, 17, 0],
  [0, 1, 0], [0, 2, 0], [0, 3, 0], [0, 5, 0], [0, 6, 0], [0, 7, 0], [0, 9, 0], [0, 10, 0], [0, 11, 0],
  [2, 6, 0], [2, 13, 0], [2, 20, 0], [2, 24, 0],
];
/** Shape selector index -> patch value (0xb7e8). */
const SHAPE_D = [0.2, 0.1, 0, 0.4, 0.3];

/** SSPlug::DefaultPreset's tables (0xb810 / 0xb978). */
const DEF_D = [
  0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5,
  0, 0.5, 0.5, 0.5, 0, 0.25, 1, 0.6, 0.5, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0.5, 1, 0, 0.5, 0, 0,
];
const DEF_I = [1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1];

/** The wrapper's form values (TTestPlug's editor, pushed at creation; coarse as knob 0..48). */
const FORM = [
  32767, 32767, 32767, 32767, 32767, 32767, 41470, 32767, 32767, 0, 32767, 13463, 12970, 44888, 32767, 0, 0,
  0, 43007, 54014, 7935, 37630, 6143, 14590, 23807, 7423,
  32767, 24, 34303, 32767, 12, 31998, 50687, 0, 32767, 24064,
  0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 2,
];

const COARSE = (t: number) => t === 27 || t === 30 || t === 33;

const K002 = f32(0.020000001415610313); // 0x3ca3d70b (not the float nearest 0.02)
const K0001 = f32(0.0010000000474974513); // 0x3a83126f
const KMUL = f32(2.2675736545352265e-5); // 0x37be37c6
const INV128 = f32(0.0078125);

/** FL's TPlugVoice state for one note (handle given to the host) plus the levels it reads. */
export class PlugVoice {
  /** Engine slot (Voice[i]) or -1. */
  slot = -1;
  /** FL's FinalLevels (TVoiceParams_Old): pan -64..64, vol, pitch (cents from the root), Mod X, Mod Y. */
  pan = 0;
  vol = 1;
  pitch = 0;
  fcut = 0;
  fres = 0;
  /** 0x38.. : current / step of the left and right gains, ramp samples left, last Mod Y. */
  curL = 0;
  curR = 0;
  incL = 0;
  incR = 0;
  ramp = 0;
  lastFres = 0;
  /** 0x50 / 0x54: trigger / release time stamps (0 = not released). */
  trig = 0;
  rel = 0;
  /** The host killed it (stolen or finished): the channel drops it. */
  dead = false;
}

/** FL's ComputeLRVol_Old: the circular pan law on pan / 64 (float math as the test host's FLEngine port). */
function lrVol(pan: number, vol: number, out: { l: number; r: number }): void {
  let p = f32(f32(pan) * 0.015625);
  if (!(p >= -1)) p = -1; else if (p > 1) p = 1;
  const a = f32(f32(p + 1) * 0.7853981633974483);
  out.l = f32(f32(Math.cos(a)) * vol);
  out.r = f32(f32(Math.sin(a)) * vol);
}

export class SSPlug {
  readonly pre = new Preset();
  readonly patches: Patch[] = [];
  /** 0x40d50: the engine slots. */
  readonly slots: (PlugVoice | null)[] = new Array(NV).fill(null);
  /** 0x40dc0 / 0x40f28: the saved state (what ProcessParam sets and SaveRestoreState writes). */
  readonly dsave = new Float64Array(45);
  readonly isave = new Int32Array(19);
  /** Mod (0xad0): the chorus delay line and its state. */
  readonly cbuf = new Float32Array(65536);
  cw = 0;
  cpos = 0;
  cspd = 1;
  cdspd = 0;
  readonly cmax = 1.0072;
  readonly cmin = 0.9928;
  ctail = 0;
  ctailLen = 0;
  /**
   * 0x40db8: samples rendered with voices, the time a note syncs the LFO to when RETRIGGER
   * is off. FL never initialises it (heap garbage); this is the value the test host's
   * process shows (0x065e065e) in most runs, so the free-running LFO phase matches it.
   */
  time = PLUG_TIME0.v;
  private readonly lr = { l: 0, r: 0 };

  constructor(sampleRate: number) {
    this.modInit(G.grate);
    // CreatePlugInstance
    for (let i = 0; i < NV; i++) {
      const p = new Patch(this.pre.sy);
      this.patches.push(p);
      this.pre.addVoice(p);
    }
    this.pre.setNumVoices(NV);
    this.pre.setBendScale(200);
    this.pre.setQuality(1, false);
    this.pre.setRender(0, 0, true);
    this.defaultPreset();
    // TTestPlug: the editor form's values
    for (let t = 0; t < 58; t++) this.wrapperSet(t, FORM[t]);
    // the host: FPD_SetSampleRate (which also runs FPD_ProcessMode), FPD_ProcessMode
    this.setSampleRate(sampleRate);
    this.processMode();
  }

  /** The chorus set-up (SSPlug ctor / FPD_SetSampleRate): its sweep rate follows a global instance counter. */
  private modInit(rate: number): void {
    const w11 = G.modInst + 333;
    G.modInst = (G.modInst + 5) % 53;
    this.cw = 0;
    const r = f32(rate);
    const s2 = f32(r * K002);
    this.cpos = fmaf(-r, K002, 65536);
    this.cdspd = -0.0288 / f32(G.spm * f32(w11));
    this.cspd = 1;
    this.ctail = 0;
    this.ctailLen = cvtzs(s2);
  }

  /** SSPlug::DefaultPreset (0x8ba4). */
  private defaultPreset(): void {
    const pre = this.pre;
    pre.clearOffsets();
    pre.setAll(DEF_D, DEF_I);
    pre.transpose = 2400;
    pre.bend(0);
    this.dsave.set(DEF_D);
    this.isave.set(DEF_I);
    pre.chorus = 1;
    pre.vca = f32(DEF_D[39]);
  }

  /** FPD_SetSampleRate (Dispatcher 4). */
  setSampleRate(sr: number): void {
    const s0 = f32(sr);
    G.grate = s0;
    G.rateDiv = f32(f32(44100) / s0);
    G.rateMul = f32(s0 * KMUL);
    G.spm = f32(s0 * K0001);
    this.modInit(s0);
    this.processMode();
  }

  /** FPD_ProcessMode (Dispatcher 1): render off, quality on, every voice rebuilt. */
  processMode(): void {
    this.pre.setRender(0, 0, false);
    this.pre.setQuality(1, true);
  }

  /** SSPlug::ProcessParam with REC_UpdateValue. */
  engineSet(tag: number, value: number): void {
    const [type, slot, range] = PT[tag];
    if (type === 0) {
      const x = value !== 0 ? 1 : 0;
      this.isave[slot] = x;
      this.pre.setI(slot, x, true, null);
    } else {
      const d = type === 1 ? value / range : SHAPE_D[Math.max(0, Math.min(4, value | 0))];
      this.dsave[slot] = d;
      this.pre.setD(slot, d, true, null);
    }
  }

  /** SSPlug::ProcessParam with REC_GetValue. */
  engineGet(tag: number): number {
    const [type, slot, range] = PT[tag];
    if (type === 0) return this.isave[slot];
    const d = this.dsave[slot];
    if (type === 1) return cvtms(d * range);
    if (d === 0) return 2;
    if (d === 0.4) return 3;
    if (d === 0.2) return 0;
    return d === 0.3 ? 4 : 1;
  }

  /** The wrapper's ProcessParam: coarse knobs 0..48 go to the engine x 420. */
  wrapperSet(tag: number, v: number): void {
    this.engineSet(tag, COARSE(tag) ? v * 420 : v);
  }

  wrapperGet(tag: number): number {
    const v = this.engineGet(tag);
    return COARSE(tag) ? rint(v * 0.002380952380952381) : v;
  }

  /**
   * A state load (FL: SaveRestoreState, then the wrapper re-applies every control):
   * `ctl` = the 58 control values. Every voice stops (FL kills them).
   */
  loadState(ctl: ArrayLike<number>, now: number): void {
    const d = Float64Array.from(DEF_D);
    const ints = Int32Array.from(DEF_I);
    d[23] = 0.5; d[25] = 0; d[31] = 0; d[34] = 0; d[40] = 1; ints[15] = 0;
    for (let t = 0; t < 58; t++) {
      const [type, slot, range] = PT[t];
      const v = ctl[t];
      if (type === 0) ints[slot] = v !== 0 ? 1 : 0;
      else if (type === 1) d[slot] = (COARSE(t) ? v * 420 : v) / range;
      else d[slot] = SHAPE_D[Math.max(0, Math.min(4, v | 0))];
    }
    const pre = this.pre;
    this.dsave.set(d);
    this.isave.set(ints);
    pre.clearOffsets();
    pre.transpose = 2400;
    pre.bend(0);
    pre.chorus = ints[18];
    pre.vca = f32(d[39]);
    pre.setAll(d, ints);
    this.killDead(now);
    for (let t = 0; t < 58; t++) this.wrapperSet(t, this.wrapperGet(t));
  }

  // ------------------------------------------------------------ voices

  /** SSPlug::TriggerVoice (0x9c74). */
  trigger(v: PlugVoice, now: number): void {
    let s = -1;
    for (let i = 0; i < NV; i++) if (!this.slots[i]) { s = i; break; }
    if (s < 0) {
      // steal: the voice released longest ago, else the newest one
      let best = 0;
      for (let i = 0; i < NV; i++) {
        const o = this.slots[i]!;
        const age = now - o.rel;
        if (o.rel !== 0 && age > best) { best = age; s = i; }
      }
      if (s < 0) {
        best = 0;
        s = 0;
        for (let i = 0; i < NV; i++) { const o = this.slots[i]!; if (o.trig > best) { best = o.trig; s = i; } }
      }
      const old = this.slots[s]!;
      this.patches[s].mute();
      old.dead = true;
      old.slot = -1;
    }
    this.slots[s] = v;
    v.slot = s;
    v.dead = false;
    lrVol(v.pan, f32(this.pre.vca * v.vol), this.lr);
    v.curL = this.lr.l;
    v.curR = this.lr.r;
    v.ramp = 0;
    // FL reads the int pitch as a float here (TVoiceParams_Old): always 0 -> 2400
    const pre = this.pre;
    let pg = (2400 + pre.transpose) | 0;
    if (!(pg > 100)) pg = 100;
    this.patches[s].gate(pg, cvtzs(f32(v.vol * 127)), this.time, v.fcut, v.fres);
    v.lastFres = v.fres;
    v.trig = now;
    v.rel = 0;
  }

  /** SSPlug::Voice_Release (0x9fcc). */
  release(v: PlugVoice, now: number): void {
    v.rel = now;
    if (v.slot >= 0 && this.slots[v.slot] === v) this.patches[v.slot].release();
  }

  /** SSPlug::Voice_Kill (0xa000). */
  kill(v: PlugVoice, now: number): void {
    if (v.rel === 0) v.rel = now;
    if (v.slot >= 0 && this.slots[v.slot] === v) {
      this.patches[v.slot].mute();
      this.slots[v.slot] = null;
    }
    v.slot = -1;
    v.dead = true;
  }

  /** SSPlug::KillDeadVoices (0x934c) and the host's Voice_Kill: finished voices free their slot. */
  killDead(now: number): void {
    for (let i = 0; i < NV; i++) {
      const v = this.slots[i];
      if (v && this.patches[i].env1.stage === 4) this.kill(v, now);
    }
  }

  /** The start of a Gen_Render call for one voice: gain (ramp), pitch, Mod X / Y. */
  callStart(s: number): void {
    const v = this.slots[s]!;
    const p = this.patches[s];
    const pre = this.pre;
    if (v.ramp === 0) {
      lrVol(v.pan, f32(pre.vca * v.vol), this.lr);
      if (this.lr.l !== v.curL || this.lr.r !== v.curR) {
        v.ramp = 128;
        v.incL = f32(f32(this.lr.l - v.curL) * INV128);
        v.incR = f32(f32(this.lr.r - v.curR) * INV128);
      }
    }
    // Voice::Change, Voice::FiltMod, Voice::QMod
    let pc = (pre.transpose + v.pitch + 2400) | 0;
    if (!(pc > 100)) pc = 100;
    p.chngNote(pc);
    p.filtMod(v.fcut, f32((v.pitch + 2400) | 0), pre.transpose);
    if (v.fres !== v.lastFres) {
      v.lastFres = v.fres;
      p.offsetFilterQ(cvtzs(f32(v.fres * 255)));
    }
  }

  /** The voice's samples into the mix (FL's fused gain x sample + mix), with the gain ramp. */
  mixVoice(s: number, mono: Float32Array, a: number, b: number, mixL: Float32Array, mixR: Float32Array): void {
    const v = this.slots[s]!;
    let cl = v.curL, cr = v.curR, n = v.ramp;
    const il = v.incL, ir = v.incR;
    for (let k = a; k < b; k++) {
      if (n !== 0) { cl = f32(cl + il); cr = f32(cr + ir); n--; }
      const x = mono[k];
      mixL[k] = fmaf(cl, x, mixL[k]);
      mixR[k] = fmaf(cr, x, mixR[k]);
    }
    v.curL = cl; v.curR = cr; v.ramp = n;
  }

  /** One chorus sample (Gen_Render 0x9910): returns the delayed (left) output. */
  chorus(x: number): number {
    const buf = this.cbuf;
    const pos = this.cpos;
    buf[this.cw] = x;
    const idx = cvtzs(pos);
    const a = buf[idx & 0xffff];
    let npos = this.cspd + pos;
    if (!(npos < 65536)) npos = npos + -65536;
    let spd = this.cdspd + this.cspd;
    if (!(spd > 0.9928) || !(spd < 1.0072)) {
      this.cdspd = -this.cdspd;
      if (spd < this.cmin) spd = this.cmin;
      else if (!(spd <= this.cmax)) spd = this.cmax;
    }
    this.cspd = spd;
    this.cw = (this.cw + 1) & 0xffff;
    const b = buf[(idx + 1) & 0xffff];
    const fr = f32(f32(pos) - f32(idx));
    this.cpos = npos;
    return fmaf(f32(b - a), fr, a);
  }
}
