// FL Keys' engine, ported from FL Studio 2026's FL Keys_x64.dylib (arm64 slice, class TTestPlug, no symbols;
// docs/research/gen/flkeys.md): Paul Kellett's mda Piano / ePiano voice model (integer-position wavetable
// voices with a key-group lookup, one decay envelope, a muffling low-pass, a velocity-dependent hardness
// shift, stereo comb simulation, treble boost, tremolo / autopan, overdrive) generalised by Image-Line to
// any wavetable (key groups, velocity layers, loop points) and run in single precision like FL's code.
//
// Addresses (arm64): TriggerVoice 0x60010, Gen_Render 0x60d30, per-voice pitch update 0x61770, Voice_Release
// 0x60b00, derived parameters 0x5fc40, ProcessParam 0x5ec60, Dispatcher 0x5dd90 (SetSampleRate).

import type { GenVoiceParams } from '../../types';
import { PITCH_C5 } from '../../levels';
import { flComputeLRVol, flLR } from '../boobass/flhost';
import type { KeysTable } from './table';

const f = Math.fround;

/** FL's control ranges of the 15 parameters (wheel Min / Max, the form's Tag = parameter index). */
export const KEYS_MIN = [-1000, -1000, -1000, -1000, 0, 0, -1000, 0, -1000, 0, -500, -1000, -1000, 0, 0];
export const KEYS_MAX = [1000, 1000, 1000, 1000, 1000, 2000, 1000, 2000, 1000, 500, 500, 1000, 1000, 65536, 1000];

/** Voices end when their envelope falls below this (FL's SILENCE, 0.0001f). */
const SILENCE = f(0.0001);
/** The treble boost's two one-pole coefficients (FL stores 1 - exp(-14000 / 44100) / 1 - exp(-5000 / 44100) as constants). */
const TFRQ_HI = f(0.2720044255256653);
const TFRQ_LO = f(0.10718750208616257);
const INV_LN11 = f(1 / Math.log(11));
const FF_MAX = 2;

/** Round to nearest, ties to even (FRINTX with FPCR round-to-nearest). */
function rne(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && (r & 1) !== 0 ? r - 1 : r;
}

/** Delphi's Power(Base, Exponent) (Math unit) as FL's code uses it. */
function pasPower(b: number, e: number): number {
  if (e === 0) return 1;
  if (b === 0 && e > 0) return 0;
  if (e === Math.trunc(e) && Math.abs(e) <= 1024) {
    // IntPower
    let n = Math.abs(e), x = b, r = 1;
    while (n > 0) {
      while ((n & 1) === 0) { n >>= 1; x *= x; }
      n--;
      r *= x;
    }
    return e < 0 ? 1 / r : r;
  }
  return Math.exp(e * Math.log(b));
}

/** A voice (FL's 0x68-byte voice record). */
export class KeysVoice {
  params: GenVoiceParams | null = null;
  /** FL's `done` flag (byte 0x14): the voice is finished and removed after this block. */
  done = true;
  /** Held by the channel (between triggerVoice and kill). */
  held = false;
  /** 6000 + FinalLevels.Pitch at the last pitch update (0x18). */
  cents = 0;
  delta = 0; frac = 0; pos = 0; end = 0; loop = 0;
  env = 0; dec = 1;
  f0L = 0; f1L = 0; f0R = 0; f1R = 0;
  ff = 0; outl = 0; outr = 0;
  /** The note 0..127 as float (0x54). */
  note = 0;
  /** The velocity sensitivity exponent (0x58). */
  vsens = 1;
  lvol = 0; rvol = 0;
  /** The key (editor keyboard highlight). */
  key = 0;
  constructor(readonly index: number) {}
}

/** The plugin's parameter-derived fields (this+0x130..0x190, set by 0x5fc40). */
export class KeysEngine {
  readonly sr: number;
  iFs: number;
  table: KeysTable | null = null;
  // parameters in FL's control units and their normalised floats (this+0x1fc / this+0x238)
  readonly pv = new Int32Array(15);
  readonly p = new Float32Array(15);
  // derived (this+...)
  size = 0;        // 0x154: hardness shift in semitones
  sizevel = 0;     // 0x170
  muffvel = 0;     // 0x16c
  treb = 0;        // 0x190
  tfrq = 0;        // 0x194
  lmod = 0;        // 0x188
  rmod = 0;        // 0x18c
  dlfo = 0;        // 0x184
  velsens = 1;     // 0x174
  fine = 0;        // 0x158
  random = 0;      // 0x15c
  stretch = 0;     // 0x160
  overdrive = 0;   // 0x164
  cdep = 0;        // 0x148
  vcomp = 0;       // 0x150 (volume compensation of the stereo width)
  width = 0;       // 0x14c
  readonly volume = f(0.2);   // 0x178
  readonly muff = f(160);     // 0x168
  // post-processing state
  tl = 0; tr = 0;             // 0x198 / 0x19c
  lfo0 = 0; lfo1 = 1;         // 0x17c / 0x180
  cpos = 0;                   // 0x134
  readonly cmax = 127;        // 0x138
  readonly comb = new Float32Array(256);
  /** FPE_MaxPoly (0 = unlimited; DefPoly 32 at creation). */
  poly = 32;
  /** Voices FL's list holds (triggered, not yet killed), in trigger order. */
  readonly list: KeysVoice[] = [];

  constructor(sr: number) {
    this.sr = sr;
    this.iFs = f(1 / sr);
    for (let i = 0; i < 15; i++) this.pv[i] = 0;
    this.setParams(this.pv);
  }

  /** The 15 control values (FL's wheel units); recomputes every derived field (0x5fc40 with index -1). */
  setParams(v: ArrayLike<number>): void {
    for (let i = 0; i < 15; i++) {
      const x = Math.round(Math.min(KEYS_MAX[i], Math.max(KEYS_MIN[i], Number.isFinite(v[i]) ? v[i] : 0)));
      this.pv[i] = x;
      this.p[i] = f((x - KEYS_MIN[i]) / (KEYS_MAX[i] - KEYS_MIN[i]));
    }
    const p = this.p, iFs = this.iFs;
    this.size = rne(f(f(12 * p[2]) - 6)) | 0;
    this.sizevel = f(0.12 * p[3]);
    this.muffvel = f(f(p[5] * p[5]) * 5);
    this.treb = f(f(f(4 * p[11]) * p[11]) - 1);
    this.tfrq = p[11] > 0.5 ? TFRQ_HI : TFRQ_LO;
    this.rmod = f(f(p[12] + p[12]) - 1);
    this.lmod = this.rmod;
    if (p[12] < 0.5) this.rmod = -this.rmod;
    // doubles in FL: d0 = exp(9.22 x double(p13) - 4.61), d1 = 6.283 x double(iFs), dlfo = float(d1 x d0)
    this.dlfo = f(6.283 * iFs * Math.exp(9.22 * p[13] - 4.61));
    this.velsens = f(f(1 + p[6]) + p[6]);
    if (p[6] < 0.25) this.velsens = f(this.velsens - f(0.75 - f(3 * p[6])));
    this.fine = f(f(p[8] + p[8]) - 1);
    this.random = f(0.077 * p[9] * p[9]);
    this.stretch = f(0.000434 * f(p[10] - 0.5));
    this.overdrive = f(1.8 * p[14]);
    this.cdep = f(p[7] * p[7]);
    this.vcomp = f(1 - 0.53 * this.cdep);
    this.width = f(0.04 * p[7]);
    if (this.width > 0.03) this.width = f(0.03);
  }

  setTable(t: KeysTable | null): void {
    this.table = t;
  }

  /** FL's velocity from InitLevels.Vol (0x60010: round(ln(10 vol + 1) / ln 11 x 100), at most 127). */
  private velocityOf(p: GenVoiceParams): number {
    const x = f(f(f(p.init.vol) * 10) + 1);
    const v = rne(f(f(Math.log(x) * INV_LN11) * 100));
    return v > 127 ? 127 : v;
  }

  /** The note (0..127, float) of a voice's pitch cents. */
  private static noteOf(cents: number): number {
    let n = f(cents * f(0.01));
    if (!(n >= 0)) n = 0; else if (n > 127) n = 127;
    return n;
  }

  /** Key group index and playback increment of a note (shared by TriggerVoice and the pitch update). */
  private pickGroup(t: KeysTable, noteForGroup: number, note: number, vel: number, k: number): { g: number; delta: number } {
    let l = f(this.fine + f(this.random * f(f(k % 13) - 6.5)));
    if (note > 60) l = f(l + f(this.stretch * k));
    let s = this.size;
    if (vel > 40) s = (rne(f(this.sizevel * f(vel - 40))) + s) | 0;
    const n = t.root.length;
    let g = 0;
    while (noteForGroup > f(s + t.high[g]) && g + t.layers < n) g += t.layers;
    // velocity layers (the group's index + the number of layers whose threshold the velocity exceeds)
    for (let w = 1; w < t.layers; w++) {
      if (vel > t.thr[w] && g + 1 < n) g++; else break;
    }
    const ratio = Math.exp(0.05776226505 * f(l + f(note - t.root[g])));
    const delta = rne(f(65536 * f(f(f(t.rate) * this.iFs) * ratio))) | 0;
    return { g, delta };
  }

  /** TriggerVoice (0x60010). */
  trigger(v: KeysVoice, p: GenVoiceParams): boolean {
    const t = this.table;
    if (!t) return false;
    this.steal();
    v.params = p;
    v.key = p.key;
    v.cents = f(6000 + f(p.levels.pitch - PITCH_C5));
    const note = KeysEngine.noteOf(v.cents);
    const vel = this.velocityOf(p);
    const k = rne(f(f(note - 60) * f(note - 60))) | 0;
    const { g, delta } = this.pickGroup(t, note, note, vel, k);
    v.delta = delta; v.frac = 0;
    v.pos = t.pos[g]; v.end = t.end[g]; v.loop = t.loop[g];
    v.env = t.vf;
    v.vsens = this.velsens;
    // muffling filter coefficient
    let l = f(f(50 + f(f(this.p[4] * this.p[4]) * this.muff)) + f(this.muffvel * f(vel - 64)));
    const lo = 55 + 0.4 * note;
    if (l < lo) l = f(lo);
    if (l > 210) l = 210;
    v.ff = f(f(l * l) * this.iFs);
    // finite-output safeguard: the coefficient exceeds 2 below 22.05 kHz at the brightest settings (l = 210), where FL's
    // one-pole filter diverges to NaN; 2 keeps it bounded (identical to FL wherever FL's output is finite)
    if (v.ff > FF_MAX) v.ff = FF_MAX;
    v.note = note;
    let nc = note;
    if (nc < 12) nc = 12;
    if (nc > 108) nc = 108;
    const vol = f(this.volume * this.vcomp);
    const w = f(vol * this.width);
    v.outr = f(vol + f(w * f(nc - 60)));
    v.outl = f(f(vol + vol) - v.outr);
    if (nc < 44) nc = 44;
    const pd = this.p[0];
    if (pd === 0) v.dec = 1;
    else {
      let s = f(pd * 2);
      if (s < 1) s = f(f(s + 0.25) - f(0.5 * pd));
      v.dec = f(Math.exp(-this.iFs * Math.exp(-0.6 + 0.033 * nc - s)));
    }
    v.f0L = v.f1L = v.f0R = v.f1R = 0;
    v.done = false;
    this.list.push(v);
    return true;
  }

  /** The poly limit's stealing at the top of TriggerVoice: the quietest live voice is finished. */
  private steal(): void {
    const poly = this.poly | 0;
    if (poly <= 0 || this.list.length < poly) return;
    let n = 0, q = f(3.4028234663852886e38), victim: KeysVoice | null = null;
    for (const v of this.list) {
      if (v.done) continue;
      n++;
      if (v.env < q) { q = v.env; victim = v; }
    }
    if (poly <= n && victim) victim.done = true;
  }

  /** Voice_Release (0x60b00). */
  release(v: KeysVoice): void {
    const t = this.table;
    const rel = this.p[1];
    const note = v.note;
    // releasehighnotes (or a note of 94 and above) uses the e-piano law, other notes the piano law
    const useA = !!t && (t.relHigh || !(note < 94 || note === 128));
    if (useA) v.dec = f(Math.exp(-this.iFs * Math.exp(6 + 0.01 * note - f(5 * rel))));
    else v.dec = f(Math.exp(-this.iFs * Math.exp(2 + 0.017 * note - f(2 * rel))));
  }

  /** The per-block voice setup of Gen_Render: pitch change, level gains. */
  private blockSetup(v: KeysVoice): void {
    const p = v.params!;
    const cents = f(6000 + f(p.levels.pitch - PITCH_C5));
    if (cents !== v.cents) this.updatePitch(v, cents);
    let vol = f(p.levels.vol);
    if (vol < 0) vol = 0;
    vol = f(pasPower(vol, v.vsens));
    flComputeLRVol(f(p.levels.pan), vol);
    v.lvol = flLR.l;
    v.rvol = flLR.r;
  }

  /** The voice's pitch changed (0x61770): the same note maths with the current levels, the key group stays. */
  private updatePitch(v: KeysVoice, cents: number): void {
    const t = this.table;
    if (!t) return;
    const p = v.params!;
    v.cents = cents;
    const note = KeysEngine.noteOf(cents);
    const vel = this.velocityOf(p);
    const k = rne(f(f(note - 60) * f(note - 60))) | 0;
    const { delta } = this.pickGroup(t, v.note, note, vel, k);
    v.delta = delta;
  }

  /**
   * Gen_Render's sample loops for one voice (0x60ec4 / 0x61220): adds n frames to L / R. Returns false once the
   * voice is done (FL removes it after the block: the end of its sample, or its envelope below SILENCE).
   */
  renderVoice(v: KeysVoice, L: Float32Array, R: Float32Array, n: number): boolean {
    const t = this.table;
    if (v.done || !t) return false;
    this.blockSetup(v);
    const W = t.waves, st = t.stereo;
    const od = this.overdrive;
    const ff = v.ff, dec = v.dec, lg = f(v.lvol * v.outl), rg = f(v.rvol * v.outr);
    let pos = v.pos, frac = v.frac;
    const delta = v.delta, end = v.end, loop = v.loop;
    let env = v.env, f0L = v.f0L, f1L = v.f1L, f0R = v.f0R, f1R = v.f1R;
    for (let i = 0; i < n; i++) {
      frac = (frac + delta) | 0;
      pos = (pos + (frac >>> 16)) | 0;
      frac &= 0xffff;
      if (pos > end) {
        if (loop < end) { pos -= loop; if (pos > end) pos = end; } // (the clamp only guards degenerate loops shorter than the step)
        else { v.done = true; break; }
      }
      const fr = frac >>> 9;
      let xl: number, xr = 0;
      if (st) {
        const a = pos * 2;
        const l0 = W[a] * 32768, l1 = W[a + 2] * 32768, r0 = W[a + 1] * 32768, r1 = W[a + 3] * 32768;
        xl = f(env * ((l0 * 128 + (l1 - l0) * fr) * 2.384185791015625e-7));
        xr = f(env * ((r0 * 128 + (r1 - r0) * fr) * 2.384185791015625e-7));
      } else {
        const y0 = W[pos] * 32768, y1 = W[pos + 1] * 32768;
        xl = f(env * ((y0 * 128 + (y1 - y0) * fr) * 2.384185791015625e-7));
      }
      env = f(env * dec);
      if (xl > 0 && od !== 0) {
        xl = f(xl - f(f(od * xl) * xl));
        if (xl < 0) xl = f(xl + f(f(0.5 * xl) * xl));
      }
      if (st) {
        if (xr > 0 && od !== 0) {
          xr = f(xr - f(f(od * xr) * xr));
          if (xr < 0) xr = f(xr + f(f(0.5 * xr) * xr));
        }
        const nl = f(f0L + f(ff * f(f(xl + f1L) - f0L)));
        f0L = nl; f1L = xl;
        const nr = f(f0R + f(ff * f(f(xr + f1R) - f0R)));
        f0R = nr; f1R = xr;
        L[i] = f(L[i] + f(lg * f0L));
        R[i] = f(R[i] + f(rg * f0R));
      } else {
        const nl = f(f0L + f(ff * f(f(xl + f1L) - f0L)));
        f0L = nl; f1L = xl;
        f0R = f0L; f1R = f1L;
        L[i] = f(L[i] + f(lg * f0L));
        R[i] = f(R[i] + f(rg * f0R));
      }
    }
    v.pos = pos; v.frac = frac; v.env = env; v.f0L = f0L; v.f1L = f1L; v.f0R = f0R; v.f1R = f1R;
    // end of the FL block: the envelope fell below SILENCE
    if (!v.done && SILENCE > env) v.done = true;
    return !v.done;
  }

  /** Gen_Render's closing stage (0x614a4): treble boost, tremolo / autopan, comb stereo, on n frames. */
  post(L: Float32Array, R: Float32Array, from: number, to: number): void {
    const comb = this.comb, cmax = this.cmax;
    let tl = this.tl, tr = this.tr, lfo0 = this.lfo0, lfo1 = this.lfo1, cpos = this.cpos;
    const tfrq = this.tfrq, treb = this.treb, dlfo = this.dlfo, lmod = this.lmod, rmod = this.rmod, cdep = this.cdep;
    for (let i = from; i < to; i++) {
      const l = L[i], r = R[i];
      tl = f(tl + f(tfrq * f(l - tl)));
      tr = f(tr + f(tfrq * f(r - tr)));
      let rr = f(r + f(treb * f(r - tr)));
      let ll = f(l + f(treb * f(l - tl)));
      lfo0 = f(lfo0 + f(dlfo * lfo1));
      lfo1 = f(lfo1 - f(dlfo * lfo0));
      ll = f(ll + f(f(ll * lmod) * lfo1));
      rr = f(rr + f(f(rr * rmod) * lfo1));
      comb[cpos] = f(ll + rr);
      cpos = (cpos & cmax) + 1;
      const x = f(cdep * comb[cpos]);
      L[i] = f(ll + x);
      R[i] = f(rr - x);
    }
    if (Math.abs(tl) < 1e-10) tl = 0;
    if (Math.abs(tr) < 1e-10) tr = 0;
    this.tl = tl; this.tr = tr; this.lfo0 = lfo0; this.lfo1 = lfo1; this.cpos = cpos;
  }

  /** Forget everything (panic / reset): voices stay with the instance. */
  reset(): void {
    this.list.length = 0;
    this.tl = this.tr = 0;
    this.lfo0 = 0; this.lfo1 = 1;
    this.cpos = 0;
    this.comb.fill(0);
  }
}
