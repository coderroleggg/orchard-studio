// Toxic Biohazard engine (ToxicSynth on IL's CSynth framework), ported from
// FL 2026's Toxic Biohazard plugin:
// - 340 internal parameters (0..293 = FL's parameters, 294..339 hidden:
//   unison, polyphony, glide mode, LFO sync / free run, operator / LFO shapes,
//   effect types, MIDI modulation matrix); every change goes through the
//   modulation matrix (source x amount added, clamped to 0..1) and the
//   section handlers;
// - 256 generators allocated by CSynth (FL voice -> MIDI note, mono / legato,
//   glide held / bend, variable / static time), one generator per note, the
//   unison voices live inside the generator's oscillator bank;
// - per block (<= 64 samples): filter parameter smoothing (4410 / sr per
//   block), operator frequency-shift smoothing, global LFO phases (free run
//   or reset while no voice sounds; free Hz or tempo synced), LFO-sourced
//   modulations, voices, effects (distortion + DC blocker, 2 effect slots,
//   8-band EQ), master gain smoothed 0.005 per sample;
// - CSynth's note handling, sustain, CC map and arpeggiator (driven by the
//   step sequencer) are the code PoiZone uses (see ../poizone/core.ts).

import { f32, fmaD } from '../poizone/dsp';
import { exp10f, powf } from '../poizone/applemath';
import { TxGen } from './gen';
import { TxWave, builtinHarmonics } from './wave';
import { TxFx } from './fx';
import { TxArp, TxSeq } from './seq';

const U32 = 2.3283064365386963e-10;
const lcg = (s: number): number => (Math.imul(s, 0x0bb38435) + 0x3619636b) >>> 0;

/** FL's integer conversion of a 0..1 value: clamp(trunc(lo + (hi - lo) v), lo, hi), fused in float. */
export function txInt(v: number, lo: number, hi: number): number {
  const r = Math.trunc(f32((hi - lo) * v + lo));
  return r > lo ? (r < hi ? r : hi) : lo;
}
/** Envelope times: max(50 v^4, 0.00101) seconds. */
export function txTime(v: number): number {
  const d = v * v;
  return Math.max(d * d * 50, 0.00101);
}
/** Frequency shift: 4000 s^5 Hz, s = 2 v - 1. */
export function txShift(v: number): number {
  const s = f32(v + v - 1);
  const s2 = s * s;
  return s2 * s2 * (s * 4000);
}
const pct2 = (v: number): number => { const q = f32(Math.trunc(v * 100) * 0.01); return f32(q * q); };

export class TxOp {
  coarse = 0; fine = 0; shift = 0; shiftSm = 0;
  mix = 0; pan = 0.5; phase = 0; freeRun = false; enable = false;
  velSens = 0; init = 0; atk = 0; dec = 1; sus = 0; rel = 0;
  readonly fm = new Float32Array(6);
  lfo1 = 0; lfo2 = 0;
}

export class TxSynth {
  // host
  sr = 44100;
  tempo = 120;
  songPos = -1;
  playing = false;
  // CSynth (offsets as in FL: shared with PoiZone)
  readonly gens: TxGen[] = [];
  readonly use = new Int32Array(128);
  readonly noteL = new Float32Array(128);
  readonly noteR = new Float32Array(128);
  readonly notePitch = new Float32Array(128);
  readonly noteCut = new Float32Array(128);
  readonly noteRes = new Float32Array(128);
  readonly vel01 = new Float32Array(128);
  readonly cc = new Float32Array(128);
  readonly vel127 = new Uint8Array(128);
  bend = 0;
  at = 0;
  transpose = 0;
  detAmt = 0;
  glideTime = f32(1e-4);
  glideMode = 0;
  velCurve = 1;
  bendRange = 0;
  mono = false;
  octaver = false;
  poly = 0;
  maxPolyCfg = 32;
  maxPoly = 32;
  uniCountC = 1;
  uniMax = 8;
  uniDtn = f32(0.1);
  uniPan = 0;
  gain = 1;
  pan = 0.5;
  ageCtr = 0;
  lastNote = -1;
  seed2 = 2222;
  mgL = 0; mgR = 0;
  arpOn = false;
  readonly arp: TxArp;
  readonly seq: TxSeq;
  // ToxicSynth
  readonly params = new Float32Array(340);
  readonly waveAmp: Float32Array[] = [];
  readonly wavePh: Float32Array[] = [];
  readonly waves: TxWave[] = [];
  readonly waveSel = new Int32Array(8).fill(-1);
  /** FL's built-in harmonic tables imported from the user's FL install (null: synthesized substitutes). */
  tables: Float32Array[] | null = null;
  readonly ops: TxOp[] = [];
  mAtk = 0; mDec = 0; mSus = 0; mRel = 0;
  fAtk = 0; fDec = 0; fSus = 0; fRel = 0;
  cutT = 0.5; resT = 0; keyT = 0; velT = 0; egT = 0; lfoT = 0;
  cutSm = 0; resSm = 0; keySm = 0; velSmF = 0; egSm = 0; lfoSm = 0;
  filterMode = 0;
  lfo2Pitch = 0; egfPitch = 0;
  lfo1Sync = 0; lfo2Sync = 0; lfo1Free = false; lfo2Free = false;
  lfo1Speed = 1; lfo2Speed = 1;
  lfo1Phase = 0; lfo2Phase = 0; lfo1Inc = 0; lfo2Inc = 0;
  uniCount = 1;
  readonly modSrc = new Uint16Array(8);
  readonly modDst = new Int16Array(8).fill(-1);
  readonly modAmt = new Float32Array(8);
  velMod = 0;
  readonly ccMap = new Uint8Array(294).fill(0xff);
  name = '';
  readonly fx: TxFx;

  constructor() {
    for (let i = 0; i < 8; i++) {
      this.waveAmp.push(new Float32Array(128));
      this.wavePh.push(new Float32Array(128));
      this.waves.push(new TxWave());
    }
    for (let k = 0; k < 6; k++) this.ops.push(new TxOp());
    for (let i = 0; i < 256; i++) this.gens.push(new TxGen(this, i));
    this.arp = new TxArp(this);
    this.seq = new TxSeq(this);
    this.fx = new TxFx();
    this.cc[7] = 1;
    this.cc[10] = 0.5;
    this.setPoly(this.maxPolyCfg);
  }

  rand32(): number {
    this.seed2 = lcg(this.seed2);
    return f32(this.seed2 * U32);
  }

  /** Apple's powf (FL calls libsystem_m's, which is not correctly rounded). */
  powf(x: number, y: number): number { return powf(x, y); }

  // ------------------------------------------------------------- parameters
  setParameter(id: number, v: number): void {
    if (id < 0) return;
    if (id < 340) this.params[id] = f32(v);
    this.apply(id);
  }

  /** The modulation matrix (FL 0x28a4c): FL parameters get source x amount added, clamped to 0..1. */
  private modulated(id: number, v: number): number {
    if (id >= 294) return v;
    for (let k = 0; k < 8; k++) {
      const src = this.modSrc[k];
      if (src === 0 || this.modDst[k] !== id) continue;
      let s = 0;
      if (src === 2) s = this.waves[6].lfo(f32(this.lfo1Phase));
      else if (src === 3) s = this.waves[7].lfo(f32(this.lfo2Phase));
      else if (src === 1) s = this.velMod;
      else if (src === 4) s = this.at;
      else if (src === 5) s = this.bend;
      else if (src >= 7 && src - 7 <= 0x7f) s = this.cc[(src + 0xf9) & 0xff];
      v = f32(this.modAmt[k] * s + v);
    }
    if (!(v >= 0)) v = 0;
    if (v > 1) v = 1;
    return v;
  }

  /** Re-apply every modulated parameter (FL: after note on, CC, aftertouch, pitch bend). */
  applyMods(): void {
    for (let k = 0; k < 8; k++) {
      if (this.modSrc[k] === 0 || this.modDst[k] < 0) continue;
      this.apply(this.modDst[k] & 0xffff);
    }
  }

  private applyLfoMods(): void {
    for (let k = 0; k < 8; k++) {
      const s = this.modSrc[k];
      if ((s === 2 || s === 3) && this.modDst[k] >= 0) this.apply(this.modDst[k] & 0xffff);
    }
  }

  /** FL 0x284dc: a parameter's value (after modulation) to the engine. */
  apply(id: number): void {
    if (id < 0) return;
    const raw = id < 340 ? this.params[id] : 0;
    const v = this.modulated(id, raw);
    if (id >= 25 && id <= 156) { this.applyOp(id, v); return; }
    if (id >= 163 && id <= 226) { this.seq.setStep(id - 163, txInt(v, -26, 24)); this.seq.update(true); return; }
    if (id >= 316 && id <= 323) { this.modSrc[id - 316] = Math.trunc(v) & 0xffff; return; }
    if (id >= 324 && id <= 331) { this.modDst[id - 324] = ((Math.trunc(v) - 1) << 16) >> 16; return; }
    if (id >= 332 && id <= 339) { this.modAmt[id - 332] = f32(txInt(v, -99, 100) * 0.01); return; }
    if (id >= 306 && id <= 313) { this.selectWave(id - 306, Math.trunc(v)); return; }
    if (id >= 238 && id <= 293) { this.fx.slot[(id - 238) & 1].setParam(id, v); return; }
    switch (id) {
      case 0: this.gain = exp10f(f32(f32(v * 60 - 30) * f32(0.05))); break;
      case 1: this.fx.setDrive(v); break;
      case 2: this.transpose = txInt(v, -24, 24); break;
      case 3: this.mAtk = txTime(v); break;
      case 4: this.mDec = txTime(v); break;
      case 5: this.mSus = f32(v * v); break;
      case 6: this.mRel = fmaD(txTime(v), 0.35, 0.02); break;
      case 7: { const c = f32(v * 2 + 1); this.velCurve = c > 0 ? c : 0; break; }
      case 8: this.uniDtn = v; break;
      case 9: this.uniPan = v < 0 ? 0 : v > 1 ? 1 : v; break;
      case 10: { const g = f32(f32(v * v) * v); this.glideTime = g < 1e-4 ? f32(1e-4) : g; break; }
      case 11: this.egfPitch = txInt(v, -24, 24) * 0.08333333333333333; break;
      case 12: this.lfo2Pitch = f32(v * v) * 0.08333333333333333; break;
      case 13: this.lfo1Speed = fmaD(f32(f32(v * v) * v), 20, 0.01); break;
      case 14: this.lfo2Speed = fmaD(f32(f32(v * v) * v), 20, 0.01); break;
      case 15: this.cutT = v; break;
      case 16: this.resT = v; break;
      case 17: this.keyT = v; break;
      case 18: this.velT = v; break;
      case 19: this.fAtk = txTime(v); break;
      case 20: this.fDec = txTime(v); break;
      case 21: this.fSus = f32(v * v); break;
      case 22: this.fRel = txTime(v); break;
      case 23: { const s = f32(v + v - 1); this.egT = f32((s < 0 ? -s : s) * s); break; }
      case 24: {
        const r = f32(Math.sqrt(v));
        const a = f32(r * v);
        this.lfoT = f32(f32(a < 0 ? -a : a) * a);
        break;
      }
      case 157: this.setArp(v >= 0.5); break;
      case 158: this.seq.swingOn = v >= 0.5; this.seq.update(true); break;
      case 159: this.seq.pingPong = v >= 0.5; this.seq.update(true); break;
      case 160: this.seq.random = v >= 0.5; this.seq.update(true); break;
      case 161: this.seq.dual = v >= 0.5; this.seq.update(true); break;
      case 162: this.seq.steps = txInt(v, 1, 64); this.seq.update(true); break;
      case 227: this.fx.eqOn(v === 0); break;
      case 228: case 229: case 230: case 231: case 232: case 233: case 234: case 235: this.fx.setBand(id - 228, v); break;
      case 236: this.fx.slot[0].setBypass(v === 0); break;
      case 237: this.fx.slot[1].setBypass(v === 0); break;
      case 295: this.bendRange = txInt(v, 0, 12); break;
      case 296: this.lfo1Sync = Math.trunc(v); break;
      case 297: this.lfo1Free = v !== 0; break;
      case 298: this.lfo2Sync = Math.trunc(v); break;
      case 299: this.lfo2Free = v !== 0; break;
      case 300: { const m = Math.trunc(v); this.filterMode = m < 3 ? m : 3; break; }
      case 301: this.setPolyphony(Math.trunc(v)); break;
      case 302: { const u = Math.trunc(v); this.uniCount = u >= 0 ? (u + 1 >= 8 ? 8 : u + 1) : 1; break; }
      case 303: this.glideMode = Math.trunc(v) & 255; break;
      case 304: case 305: this.fx.slot[id - 304].setParam(id, v); break;
      case 314: case 315: this.fx.slot[id - 314].setType(Math.trunc(v)); break;
    }
  }

  private applyOp(id: number, v: number): void {
    if (id >= 109 && id <= 144) {
      const r = Math.trunc((id - 109) / 6), k = (id - 109) % 6;
      this.ops[k].fm[r] = pct2(v);
      return;
    }
    if (id >= 145 && id <= 156) {
      // FL's six per-operator handlers were compiled differently: operators 1 and 5 round
      // (199 v - 99) toward zero (fused, float), operators 2, 3, 4 and 6 use trunc(199 v) - 99.
      const k = (id - 145) % 6;
      let n: number;
      if (k === 0 || k === 4) n = txInt(v, -99, 100);
      else {
        const t = v === v ? Math.trunc(v * 199) : 0;
        n = t > 199 ? 100 : (t > 0 ? t : 0) - 99;
      }
      const a = f32(n * f32(0.01));
      if (id <= 150) this.ops[k].lfo1 = a; else this.ops[k].lfo2 = a;
      return;
    }
    const sec = Math.trunc((id - 25) / 6), o = this.ops[(id - 25) % 6];
    switch (sec) {
      case 0: if (v > 0.5) o.enable = true; else o.enable = false; break;
      case 1: o.coarse = txInt(v, -99, 99); break;
      case 2: o.fine = f32(txInt(v, -99, 99) * 0.01); break;
      case 3: o.shift = txShift(v); break;
      case 4: o.freeRun = v !== 0; break;
      case 5: o.phase = v; break;
      case 6: o.velSens = v; break;
      case 7: o.init = f32(v * v); break;
      case 8: o.atk = f32(txTime(v)); break;
      case 9: o.dec = f32(txTime(v)); break;
      case 10: o.sus = f32(v * v); break;
      case 11: o.rel = f32(txTime(v)); break;
      case 12: o.pan = v; break;
      case 13: o.mix = f32(v * v); break;
    }
  }

  /** Operator / LFO shape (0 = custom harmonics from the state, 1..32 built-in). */
  selectWave(k: number, idx: number): void {
    if (k < 0 || k > 7 || idx < 0 || idx > 32) return;
    this.waveSel[k] = idx;
    if (idx === 0) this.waves[k].build(this.waveAmp[k], this.wavePh[k]);
    else { const [a, p] = builtinHarmonics(idx, this.tables ?? undefined); this.waves[k].build(a, p); }
  }

  /** Rebuild the built-in shapes (after importing FL's tables). */
  rebuildWaves(): void {
    for (let k = 0; k < 8; k++) if (this.waveSel[k] > 0) this.selectWave(k, this.waveSel[k]);
  }

  /** FL's state blob (TBi2 / TBio / TBiD chunk): modulation matrix, harmonics, 340 values, CC map, name. */
  loadState(b: Uint8Array): boolean {
    if (b.length < 5) return false;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const magic = dv.getUint32(0, true);
    if (magic !== 0x54426932 && magic !== 0x5442696f && magic !== 0x54426944) return false;
    let len = b.length - 4;
    if (len < 0x40) return false;
    for (let k = 0; k < 8; k++) this.modSrc[k] = dv.getUint16(4 + 2 * k, true);
    for (let k = 0; k < 8; k++) this.modDst[k] = dv.getInt16(0x14 + 2 * k, true);
    for (let k = 0; k < 8; k++) this.modAmt[k] = dv.getFloat32(0x24 + 4 * k, true);
    let p = 0x44;
    len = b.length - 0x44;
    if (len >= 0x2000) {
      for (let k = 0; k < 8; k++) {
        for (let i = 0; i < 128; i++) this.waveAmp[k][i] = dv.getFloat32(p + i * 4, true);
        p += 0x200;
        for (let i = 0; i < 128; i++) this.wavePh[k][i] = dv.getFloat32(p + i * 4, true);
        p += 0x200;
      }
      len -= 0x2000;
    }
    if (len >= 0x550) {
      for (let i = 0; i < 340; i++) this.params[i] = dv.getFloat32(p + i * 4, true);
      p += 0x550;
      len -= 0x550;
    }
    if (len >= 294) {
      for (let i = 0; i < 294; i++) this.ccMap[i] = b[p + i];
      p += 294;
      len -= 294;
      if (len >= 0x80) {
        let s = '';
        for (let i = 0; i < 0x80 && b[p + i]; i++) s += String.fromCharCode(b[p + i]);
        this.name = s;
      }
    }
    if (magic === 0x5442696f) {
      for (let k = 0; k < 8; k++) {
        const v = Math.trunc(this.params[316 + k]);
        if (v === 0) continue;
        const nv = (v > 2 ? v + 1 : v) + 3;
        this.params[316 + k] = nv;
        this.modSrc[k] = nv;
      }
    }
    for (let id = 0; id < 340; id++) this.apply(id);
    return true;
  }

  /** Decoded state (values 0..339, custom harmonics, CC map): FL's chunk load without the blob. */
  loadValues(v: ArrayLike<number>, waves: ([Float32Array, Float32Array] | null)[], ccMap: ArrayLike<number>): void {
    for (let i = 0; i < 340; i++) this.params[i] = f32(v[i] ?? 0);
    for (let k = 0; k < 8; k++) {
      const w = waves[k];
      if (w) { this.waveAmp[k].set(w[0].subarray(0, 128)); this.wavePh[k].set(w[1].subarray(0, 128)); }
      else { this.waveAmp[k].fill(0); this.wavePh[k].fill(0); }
    }
    for (let i = 0; i < 294; i++) this.ccMap[i] = (ccMap[i] ?? 0xff) & 0xff;
    for (let k = 0; k < 8; k++) {
      this.modSrc[k] = Math.trunc(this.params[316 + k]) & 0xffff;
      this.modDst[k] = ((Math.trunc(this.params[324 + k]) - 1) << 16) >> 16;
      this.modAmt[k] = f32(txInt(this.params[332 + k], -99, 100) * 0.01);
    }
    for (let id = 0; id < 340; id++) this.apply(id);
  }

  // ------------------------------------------------------------- CSynth
  setPoly(n: number): void { this.poly = this.maxPolyCfg >= n && n >= 1 ? n : this.maxPolyCfg; }

  private setPolyphony(n: number): void {
    this.setMono(n === 0);
    this.setPoly(n === 0 ? 1 : n);
  }

  setMaxPoly(n: number): void { this.maxPoly = n !== 0 ? n : this.maxPolyCfg; }

  private setMono(on: boolean): void {
    if (this.mono === on) return;
    this.mono = on;
    const sus = this.cc[64];
    this.cc[64] = 0;
    for (let n = 0; n < 128; n++) this.noteOff(n);
    this.cc[64] = sus;
  }

  private setArp(on: boolean): void {
    if (this.arpOn === on) return;
    const sus = this.cc[64];
    this.cc[64] = 0;
    for (let n = 0; n < 128; n++) this.noteOff(n);
    this.cc[64] = sus;
    this.arpOn = on;
  }

  private maxVoices(): number {
    const v = Math.min(this.poly, this.maxPoly) * this.uniCountC;
    return Math.min(v, this.gens.length);
  }

  /** ToxicSynth note on: CSynth's, then the sequencer update. */
  noteOn(n: number, vel: number): void {
    if (vel === 0) { this.noteOff(n); return; }
    this.noteOnCS(n, vel);
    this.seq.update(true);
  }

  noteOff(n: number): void {
    this.noteOffCS(n);
    this.seq.update(false);
  }

  private noteOnCS(n: number, vel: number): void {
    this.vel01[n] = f32(vel * f32(1 / 127));
    this.vel127[n] = Math.trunc(f32(this.vel01[n] * 127));
    if (this.arpOn) this.arp.update();
    else this.playNote(n, this.vel01[n]);
  }

  private noteOffCS(n: number): void {
    this.vel01[n] = 0;
    if (this.cc[64] !== 0) return;
    this.vel127[n] = 0;
    if (this.arpOn) this.arp.update();
    else this.playNote(n, 0);
  }

  controlChange(c: number, v127: number): void {
    this.cc[c] = f32(v127 * f32(1 / 127));
    if (c === 64) {
      if (this.cc[64] === 0) {
        for (let n = 0; n < 128; n++) if (this.vel01[n] === 0 && this.vel127[n] !== 0) this.noteOff(n);
      }
    } else if (c === 121) {
      this.cc.fill(0);
      this.cc[7] = 1; this.cc[10] = 0.5;
    } else if (c === 123) {
      const sus = this.cc[64];
      this.cc[64] = 0;
      for (let n = 0; n < 128; n++) this.noteOff(n);
      this.cc[64] = sus;
    } else {
      for (let p = 0; p < 294; p++) if (this.ccMap[p] === c) this.setParameter(p, this.cc[c]);
    }
    if (c !== 7 && c !== 10 && c !== 0x20) this.applyMods();
  }

  /** Channel aftertouch / pitch bend (FL re-applies the modulations). */
  aftertouch(v: number): void { this.at = v; this.applyMods(); }
  pitchBend(v: number): void { this.bend = v; this.applyMods(); }

  /** CSynth::playNote (identical to PoiZone's). */
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
    const det = f32((f32(r * U32) * 2 - 2) * this.detAmt);
    const maxV = this.maxVoices();
    for (let u = 0; u < this.uniCountC; u++) {
      let g: TxGen;
      if (maxV < 1) g = this.gens[0];
      else {
        let oldR = this.gens[0], oldA = this.gens[0], pick: TxGen | null = null;
        for (let i = 0; i < maxV; i++) {
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
      g.uniCnt = this.uniCountC;
      g.det = det;
      g.vel = this.velCurve === 1 ? vel : powf(vel, this.velCurve);
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
    const det = f32((f32(r * U32) * 2 - 2) * this.detAmt);
    for (let u = 0; u < this.uniCountC && u < this.gens.length; u++) {
      const g = this.gens[u];
      const wasNote = g.note, wasRel = g.released;
      g.age = this.ageCtr++ >>> 0;
      g.setNote(n);
      g.released = false;
      g.det = det;
      g.uniIdx = u;
      g.uniCnt = this.uniCountC;
      if (this.glideMode <= 1) g.glideRate = f32(12 / (this.sr * this.glideTime));
      else g.glideRate = f32(Math.abs(f32(n - g.glide)) / (this.sr * this.glideTime));
      if (wasNote < 0 || wasRel) {
        g.vel = this.velCurve === 1 ? vel : powf(vel, this.velCurve);
        g.glide = from;
        if (this.glideTime < 0.001) g.glide = n;
        g.trigger();
      }
    }
    this.lastNote = n;
  }

  /** Master gain / pan (gain x 0.5 x CC 7, pan from CC 10). */
  masterGain(right: boolean): number {
    const s1 = f32(f32(this.gain * 0.5) * this.cc[7]);
    if (!(s1 > 0)) return 0;
    let p = f32((this.cc[10] - 0.5 + this.pan) * 2);
    p = Math.min(Math.max(p, 0), 2);
    if (!right) return p <= 1 ? s1 : f32(f32(2 - p) * s1);
    return p < 1 ? f32(p * s1) : s1;
  }

  /** FPD_SetSampleRate (sr 0: FPD_Flush): smoothers snap, effects reset, CSynth reset. */
  setSampleRate(sr: number): void {
    this.cutSm = f32(this.cutT); this.resSm = f32(this.resT); this.keySm = f32(this.keyT); this.velSmF = f32(this.velT);
    this.egSm = f32(this.egT); this.lfoSm = f32(this.lfoT);
    for (const o of this.ops) o.shiftSm = o.shift;
    this.lfo1Phase = 0; this.lfo2Phase = 0;
    if (sr !== 0) this.fx.setSampleRate(sr);
    this.fx.reset();
    // CSynth reset
    if (sr > 0) this.sr = sr;
    const sus = this.cc[64];
    this.cc[64] = 0;
    for (let n = 0; n < 128; n++) this.noteOff(n);
    this.cc[64] = sus;
    for (const g of this.gens) { g.kill(this.sr); g.glide = 48; }
    this.mgL = this.masterGain(false);
    this.mgR = this.masterGain(true);
    this.lastNote = -1;
    this.arp.reset();
    this.arp.stop();
  }

  private lfoRate(sync: number, speed: number): number {
    const t = this.tempo;
    switch (sync) {
      case 1: return t * 0.06666666666666667;
      case 2: return t * 0.03333333333333333;
      case 3: return t * 0.022222222222222223;
      case 4: return t * 0.016666666666666666;
      case 5: return t * 0.008333333333333333;
      case 6: return t * 0.005555555555555556;
      case 7: return t * 0.004166666666666667;
      case 8: return t * 0.0020833333333333333;
      case 9: return t * 0.0010416666666666667;
    }
    return speed;
  }

  /** One engine block (n <= 64 samples) into L / R (zeroed). */
  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.arpOn) this.arp.process(this.sr, this.tempo, n);
    // filter parameter smoothing (4410 / sr per block)
    const MIN = 1.0000000116860974e-07;
    if (this.cutT < MIN) this.cutT = MIN;
    if (this.resT < MIN) this.resT = MIN;
    if (this.keyT < MIN) this.keyT = MIN;
    if (this.velT < MIN) this.velT = MIN;
    if (this.lfoT < MIN) this.lfoT = MIN;
    const c = f32(4410 / this.sr);
    const sm = (cur: number, t: number): number => {
      const v = f32(fmaD(t - cur, c, cur));
      return v < 1e-9 && v > -1e-9 ? 0 : v;
    };
    this.cutSm = sm(this.cutSm, this.cutT);
    this.resSm = sm(this.resSm, this.resT);
    this.keySm = sm(this.keySm, this.keyT);
    this.velSmF = sm(this.velSmF, this.velT);
    this.egSm = sm(this.egSm, this.egT);
    this.lfoSm = sm(this.lfoSm, this.lfoT);
    for (const o of this.ops) o.shiftSm = fmaD(o.shift - o.shiftSm, c, o.shiftSm);
    // global LFOs
    let any = false;
    for (const g of this.gens) if (g.note >= 0) { any = true; break; }
    const idle = !any;
    if (idle && !this.lfo1Free) this.lfo1Phase = 0;
    this.lfo1Inc = this.lfoRate(this.lfo1Sync, this.lfo1Speed) / this.sr;
    let p = fmaD(this.lfo1Inc, n, this.lfo1Phase);
    if (p > 1) p += -1;
    this.lfo1Phase = p;
    if (idle && !this.lfo2Free) this.lfo2Phase = 0;
    this.lfo2Inc = this.lfoRate(this.lfo2Sync, this.lfo2Speed) / this.sr;
    p = fmaD(this.lfo2Inc, n, this.lfo2Phase);
    if (p > 1) p += -1;
    this.lfo2Phase = p;
    this.applyLfoMods();
    // voices
    for (const g of this.gens) g.render(L, R, 0, n);
    // effects
    this.fx.tempo = this.tempo;
    this.fx.process(L, R, n);
    // master gain
    const tL = this.masterGain(false), tR = this.masterGain(true);
    let gl = this.mgL, gr = this.mgR;
    for (let i = 0; i < n; i++) {
      L[i] = f32(L[i] * gl);
      R[i] = f32(R[i] * gr);
      gl = f32(fmaD(f32(tL - gl), 0.005, gl));
      gr = f32(fmaD(f32(tR - gr), 0.005, gr));
    }
    this.mgL = gl;
    this.mgR = gr;
  }
}
