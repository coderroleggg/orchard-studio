// Morphine's synthesizer object (CMorSynth, vtable 0x88c58) and its FL wrapper
// (CFLWrapper): FL voices keyed by note number (TriggerVoice 0x69704 uses the
// key as the voice handle), per-key levels (Gen_Render 0x68940: FL's pan law
// and the pitch offset of each key with an FL voice), the voice allocation of
// the poly / mono note handlers (0x62c98 / 0x630a4), glide, the cached
// parameter values (Synth_OnParamChanged 0x70664), the effects chain and the
// master gain loop (Synth_Process 0x714ac).

import { cosf, logf, powf, sinf, exp10f } from '../poizone/applemath';
import { fmaD } from '../../../../model/gen/plugins/morphine/libm';
import { N_PROG } from '../../../../model/gen/plugins/morphine/params';
import { MorFx } from './fx';
import type { CProgram } from './program';
import { Voice, type SynthCtx } from './voice';

const f32 = Math.fround;
const INV127 = f32(1 / 127);
const MAX_VOICES = 32;
/** float 41.71426 (0x4226db67): FL InitLevels.Vol -> MIDI velocity. */
const VEL_K = (() => { const d = new DataView(new ArrayBuffer(4)); d.setUint32(0, 0x4226db67); return d.getFloat32(0); })();

/** FL's ComputeLRVol (circular pan law, float): out[0] left, out[1] right. */
export function computeLRVol(pan: number, vol: number, out: Float32Array): void {
  let p = f32(pan);
  if (!(p >= -1)) p = -1;
  else if (p > 1) p = 1;
  const a = f32(f32(p + 1) * 0.7853981633974483);
  out[0] = f32(cosf(a) * vol);
  out[1] = f32(sinf(a) * vol);
}

export class MorSynth {
  readonly ctx: SynthCtx;
  readonly voices: Voice[] = [];
  readonly fx: MorFx;
  sr: number;
  /** Cached parameter values (OnParamChanged). */
  private master = 1;
  private glideT = f32(1e-4);
  private velExp = 0;
  private polyN = 32;
  /** FL's max polyphony (synth+0x38ec, FPE_MaxPoly: 0 -> the 32 voices). */
  maxPoly = MAX_VOICES;
  private mono = false;
  private glideMode = 0;
  /** Held keys (synth+0x390c: trunc(vel * 127)), note velocities (synth+0x1068). */
  readonly held = new Uint8Array(128);
  readonly keyVel = new Float32Array(128);
  private lastKey = -1;
  private counter = 0;
  /** Master gain (synth+0x3994 / 0x3998). */
  gL = 0;
  gR = 0;
  private readonly lr = new Float32Array(2);

  constructor(sr: number, prog: CProgram, f: Float32Array) {
    this.sr = sr;
    const cc = new Float32Array(128);
    cc[7] = 1;
    cc[10] = 0.5;
    this.ctx = {
      prog, f, cc, at: 0, wheel: 0, tempo: 130,
      levL: new Float32Array(128), levR: new Float32Array(128), levPitch: new Float32Array(128),
      transpInt: 0, transpFine: 0, bendRange: 0, keyVoices: new Int32Array(128),
    };
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice(this.ctx));
    // FL: SetSampleRate builds the chain, then the program's parameters are applied (the chorus wet
    // stored -(w^2): a later SetSampleRate would square it again), voices get the rate, gains snap.
    this.fx = new MorFx(sr);
    for (let i = 0; i < N_PROG; i++) this.paramChanged(i);
    this.setPoly(prog.poly);
    this.glideMode = prog.glideMode;
    for (const v of this.voices) v.kill(sr);
    this.gL = this.target(0);
    this.gR = this.target(1);
  }

  /** CMorSynth::SetSampleRate: voices re-initialised, gains snap to their targets, effects rebuilt. */
  setSampleRate(sr: number): void {
    this.sr = sr;
    for (const v of this.voices) v.kill(sr);
    this.gL = this.target(0);
    this.gR = this.target(1);
    this.fx.setSampleRate(sr);
  }

  /** Synth_OnParamChanged for a program parameter whose float changed (the DSP reads the others live). */
  paramChanged(i: number): void {
    const f = this.ctx.f, c = this.ctx;
    switch (i) {
      case 0: this.master = exp10f(f32(f[0] * f32(2.4) + f32(-1.2))); break;
      case 1: { const t = f32(f[1] * f32(f[1] * f[1])); this.glideT = t < 0.0001 ? f32(0.0001) : t; break; }
      case 2: { const e = f32(f[2] * 5); this.velExp = e > 0 ? e : 0; break; }
      case 3: c.bendRange = Math.trunc(f[3] * 12); break;
      case 4: case 5: {
        const t = fmaD(f[4], 48, -24);
        c.transpInt = Math.trunc(t);
        c.transpFine = f32(fmaD(Math.trunc(fmaD(f[5], 200, -100)), 0.01, Math.trunc(t)));
        break;
      }
      default:
        if (i >= 6 && i <= 29) this.fx.setParam(i, f[i]);
    }
  }

  /** Internal parameter 124 (Polyphony raw n: n + 1 voices, 0 = mono; 0x63408 / 0x63420). */
  setPoly(n: number): void {
    const k = n + 1;
    this.polyN = k > MAX_VOICES || k < 1 ? MAX_VOICES : k;
    const mono = n === 0;
    if (mono !== this.mono) {
      this.mono = mono;
      const sus = this.ctx.cc[64];
      this.ctx.cc[64] = 0;
      for (let key = 0; key < 128; key++) this.noteOff(key);
      this.ctx.cc[64] = sus;
    }
  }

  setGlideMode(m: number): void { this.glideMode = m; }

  /** FPE_MaxPoly (0x63940): the channel's polyphony, 0 = unlimited (the 32 voices). */
  setMaxPoly(n: number): void { this.maxPoly = n > 0 ? n : MAX_VOICES; }

  setProgram(p: CProgram): void { this.ctx.prog = p; }

  /** MIDI CC (params 123..250; 7, 10, 32 are not forwarded by the wrapper) and aftertouch (251). */
  setCC(cc: number, v: number): void {
    const c = this.ctx;
    c.cc[cc] = f32(v * INV127);
    if (cc === 64) {
      if (c.cc[64] === 0) for (let k = 0; k < 128; k++) if (this.keyVel[k] === 0 && this.held[k]) this.noteOff(k);
    } else if (cc === 121) {
      c.cc.fill(0);
      c.cc[7] = 1;
      c.cc[10] = 0.5;
    } else if (cc === 123) {
      const sus = c.cc[64];
      c.cc[64] = 0;
      for (let k = 0; k < 128; k++) this.noteOff(k);
      c.cc[64] = sus;
    }
  }

  setAftertouch(v: number): void { this.ctx.at = f32(v * INV127); }

  /** MIDI velocity of an FL note from InitLevels.Vol (TriggerVoice 0x69704 / 0x72e54). */
  static midiVelocity(vol: number): number {
    const v = Math.trunc(f32(logf(f32(f32(vol) * 10 + 1)) * VEL_K));
    return v < 0 ? 0 : v > 127 ? 127 : v;
  }

  /** CSynthesizer note on (0x7f70 -> 0x637d4 -> poly / mono handler). */
  noteOn(key: number, vel: number): void {
    if (vel === 0) { this.noteOff(key); return; }
    this.keyVel[key] = f32(vel * INV127);
    this.held[key] = Math.trunc(f32(this.keyVel[key] * 127)) & 0xff;
    if (this.mono) this.monoNote(key, this.keyVel[key]);
    else this.polyNote(key, this.keyVel[key]);
  }

  /** CSynthesizer note off (0x7fa8 -> 0x63828): ignored while the sustain pedal (CC 64) is down. */
  noteOff(key: number): void {
    this.keyVel[key] = 0;
    if (this.ctx.cc[64] !== 0) return;
    this.held[key] = 0;
    if (this.mono) this.monoNote(key, 0);
    else for (const v of this.voices) if (v.key === key) { v.released = true; v.release(); }
  }

  private glideStart(key: number): number {
    let s = this.lastKey < 0 ? f32(key) : f32(this.lastKey);
    if ((this.glideMode | 2) === 3) {
      let best = 128, found = -1;
      for (let k = 0; k < 128; k++) {
        const d = Math.abs(key - k);
        if (this.held[k] && k !== key && d < best) { best = d; found = k; }
      }
      s = found >= 0 ? f32(found) : f32(key);
    }
    return s;
  }

  private setGlide(v: Voice): void {
    const T = this.glideT;
    if (T < 0.001) v.glidePos = f32(v.key);
    if (this.glideMode <= 1) v.glideRate = f32(12 / (this.sr * T));
    else if ((this.glideMode & 0xfe) === 2) v.glideRate = f32(Math.abs(f32(f32(v.key) - v.glidePos)) / (this.sr * T));
  }

  /** Poly note on 0x62c98. */
  private polyNote(key: number, vel: number): void {
    const start = this.glideStart(key);
    const N = Math.min(this.polyN, this.maxPoly), vs = this.voices;
    let chosen: Voice | null = null;
    let oldR = vs[0], oldU = vs[0];
    for (let i = 0; i < N && i < vs.length; i++) {
      const v = vs[i];
      if (v.key < 0) { chosen = v; break; }
      if (v.released) { if ((oldR.age >>> 0) > (v.age >>> 0)) oldR = v; }
      else if ((oldU.age >>> 0) > (v.age >>> 0)) oldU = v;
    }
    if (!chosen) chosen = oldR.released ? oldR : oldU;
    const v = chosen;
    v.age = this.counter++;
    v.setKey(key);
    v.vel = powf(vel, this.velExp);
    v.released = false;
    v.glidePos = start;
    this.setGlide(v);
    v.noteOn();
    this.lastKey = key;
  }

  /** Mono note handler 0x630a4 (vel 0 = note off: glide back to the nearest held key, else release). */
  private monoNote(key: number, vel: number): void {
    const v = this.voices[0];
    if (vel !== 0) {
      let start = this.lastKey < 0 ? f32(key) : f32(this.lastKey);
      if ((this.glideMode | 2) === 3 && (v.key < 0 || v.released)) start = f32(key);
      const wasFree = v.key < 0, wasReleased = v.released;
      v.age = this.counter++;
      v.setKey(key);
      v.released = false;
      if (this.glideMode <= 1) v.glideRate = f32(12 / (this.sr * this.glideT));
      else if ((this.glideMode & 0xfe) === 2) v.glideRate = f32(Math.abs(f32(f32(key) - v.glidePos)) / (this.sr * this.glideT));
      if (wasFree || wasReleased) {
        v.vel = powf(vel, this.velExp);
        v.glidePos = start;
        if (this.glideT < 0.001) v.glidePos = f32(key);
        v.noteOn();
      }
      this.lastKey = key;
      return;
    }
    let best = 128, found = -1;
    for (let k = 0; k < 128; k++) {
      const d = Math.abs(key - k);
      if (this.held[k] && d < best) { best = d; found = k; }
    }
    if (found >= 0) {
      for (const w of this.voices) {
        if (w.key !== key) continue;
        w.age = this.counter++;
        w.setKey(found);
        w.glideRate = f32(12 / (this.sr * this.glideT));
        this.lastKey = found;
      }
    } else {
      for (const w of this.voices) if (w.key === key) { w.released = true; w.release(); }
    }
  }

  /** FL voice levels of a key (Gen_Render 0x68940): pan / volume -> L / R, pitch offset in semitones. */
  setKeyLevels(key: number, pan: number, vol: number, flPitchCents: number): void {
    computeLRVol(pan, vol, this.lr);
    const c = this.ctx;
    c.levL[key] = this.lr[0];
    c.levR[key] = this.lr[1];
    c.levPitch[key] = f32(fmaD(f32(flPitchCents), 0.01, 60 - key));
  }

  /** Master gain target of a channel (0x634d0). */
  target(ch: number): number {
    const c = this.ctx;
    const s1 = f32(f32(this.master * 0.5) * c.cc[7]);
    if (!(s1 > 0)) return 0;
    let p = f32(((c.cc[10] + -0.5) + 0.5) * 2);
    if (!(p > 0)) p = 0;
    if (p > 2) p = 2;
    if (ch === 0) return p <= 1 ? s1 : f32(f32(2 - p) * s1);
    return p < 1 ? f32(p * s1) : s1;
  }

  /** Render n samples into L / R at off (they must hold zeros): voices, effects, master gain. */
  render(L: Float32Array, R: Float32Array, off: number, n: number): void {
    for (const v of this.voices) if (v.key >= 0) v.render(L, R, off, n);
    if (this.fx.active()) this.fx.process(L, R, off, n); // all off: the chain is bit-transparent
    const tL = this.target(0), tR = this.target(1);
    let gL = this.gL, gR = this.gR;
    for (let i = off; i < off + n; i++) {
      L[i] = f32(L[i] * gL);
      R[i] = f32(R[i] * gR);
      gL = f32(fmaD(f32(tL - gL), 0.005, gL));
      gR = f32(fmaD(f32(tR - gR), 0.005, gR));
    }
    this.gL = gL;
    this.gR = gR;
  }

  /** Any voice sounding. */
  active(): boolean {
    for (const v of this.voices) if (v.key >= 0) return true;
    return false;
  }

  /** The master gain glide still moves (a step that returns its input holds until the target changes). */
  gainMoving(): boolean {
    const tL = this.target(0), tR = this.target(1), gL = this.gL, gR = this.gR;
    return f32(fmaD(f32(tL - gL), 0.005, gL)) !== gL || f32(fmaD(f32(tR - gR), 0.005, gR)) !== gR;
  }

  /** Kill every voice now (panic / reset). */
  killAll(): void {
    for (const v of this.voices) v.kill();
    this.held.fill(0);
    this.keyVel.fill(0);
  }
}

