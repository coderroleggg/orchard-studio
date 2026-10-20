// An Ogun voice: TriggerVoice (0x6dff0), the per-block voice processing (0x6fa00), the release (0x6f5c0 / 0x6f360) of
// Ogun_x64.dylib (FL 2026, arm64). One voice owns an FftOsc (the additive timbre with its unison read positions), the
// five live articulators (volume, filter frequency / resonance, pitch, unison pitch), the 3-stage biquad filter and
// the declick / gain ramps. FL's voice fields in brackets (V = voice object, O = V+0xe50 the oscillator).

import type { GenVoice, GenVoiceParams } from '../../types';
import { FftOsc, seedHash } from './fftsynth';
import { OgunPlug, seedHash0 } from './plug';
import { OgArtState } from './art';
import { ogEnvEval, ogEnvSkipAttack, ogSusSetup, ogSetStartOfs } from './ogcurve';
import { Biquad } from './biquad';
import { rint } from '../harmor/fx-util';
import { noteVolume } from '../../levels';
import { exp as lexp, log as llog, sin as lsin, cos as lcos } from '../harmor/fx-libm';

const f32 = Math.fround;
const LN2 = 0.6931471805599453;
const LN2_1200 = 0.0005776226504666211;
const LN2_2 = 0.34657359027997264;
const PI = 3.141592653589793;
/** 0x370f68: detune weights of the unison voices. */
const UNI_TAB = new Float32Array([0.877, 1.069, 0.929, 1.181, 1.031, 1.129, 0.887, 1.117, 0.977, 0, 0, 0].map(Math.fround));
/** 0x370f08: biquad type of the four filter types (low pass, band pass, notch, high pass). */
const FILTER_TYPE = [1, 2, 3, 4];
const SQRT2F = f32(1.4142135381698608);
const FC_MAX = 2.849517146113191;

/** FL's integer power (0x11a0b0): binary exponentiation. */
function intPower(b: number, n: number): number {
  if (b === 0 && n === 0) return 1;
  if (n < 0) { b = 1 / b; n = -n; }
  let r = 1;
  while (n > 0) {
    if ((n & 1) === 0) { n >>= 1; b = b * b; } else { n--; r = r * b; }
  }
  return r;
}

/** Equal-power pan (G[3f4960]): out[0] = cos((pan + 1) pi/4) g, out[1] = sin(...) g. */
function panLaw(pan: number, g: number, out: Float32Array, o: number): void {
  const th = f32(f32(pan + 1) * 0.7853981633974483);
  out[o] = f32(f32(Math.cos(th)) * g);
  out[o + 1] = f32(f32(Math.sin(th)) * g);
}

/** The 4 stereo mixing gains of a pan and volume (0xaf920, mode 0): out = [LL, RR, RL, LR] as the mixer reads them. */
function panGains(g: Float32Array, o: number, pan: number, vol: number): void {
  if (pan === 0 && !Object.is(pan, -0)) { g[o] = vol; g[o + 1] = vol; g[o + 2] = 0; g[o + 3] = 0; return; }
  if (vol === 0) { g[o] = 0; g[o + 1] = 0; g[o + 2] = 0; g[o + 3] = 0; return; }
  panLaw(pan, f32(vol * SQRT2F), g, o);
  let s0 = 0, s2 = 0;
  if (pan > 0) s0 = f32(1 - f32(g[o] / vol));
  else s2 = f32(1 - f32(g[o + 1] / vol));
  s2 = f32(s2 * 0.5);
  g[o + 2] = f32(g[o] * s2);
  g[o] = f32(g[o] * f32(1 - s2));
  s0 = f32(s0 * 0.5);
  g[o + 3] = f32(g[o + 1] * s0);
  g[o + 1] = f32(g[o + 1] * f32(1 - s0));
}

const LN11F = f32(2.3978952727983707);

/**
 * FPV_GetVelocity as FL's host computes it (FLEngine 0x42d0b4): the note's velocity is turned into InitLevels.Vol by FL's volume
 * law (float32) and read back as 0.78125 ln(10 Vol + 1) / ln 11, so it differs from velocity / 128 in the last float bits.
 */
export function flVelocity(vel: number): number {
  const x = f32(vel * f32(0.01));
  const vol = x === 1 ? 1 : f32((lexp(f32(x * LN11F)) - 1) * f32(0.1));
  const s = f32(f32(vol * 10) + 1);
  const r = f32(llog(s) * f32(1 / LN11F));
  return f32(r * 0.78125);
}

/** FL's float power (0x1d5f60). */
function powF(a: number, e: number): number {
  if (e === 0) return 1;
  if (a === 0 && e > 0) return 0;
  const r = Math.trunc(f32(e + 0.5));
  if (r === e) return f32(Math.pow(a, e));
  return f32(lexp(e * llog(a)));
}

export class OgunVoice implements GenVoice {
  /** +0x10 state: 1 playing, 5 released, 9 ending, 10 done. */
  state = 1;
  private w14 = 9;
  /** +0x18 samples to the next control update (negative: first). */
  private w18: number;
  private first = true;
  readonly key: number;
  private readonly keyF: number;
  private readonly d80 = new Float64Array(13);
  private readonly st: OgArtState[] = [];
  private readonly live: boolean[] = [];
  private readonly mod = new Float32Array(2);
  private xi = 0;
  private yi = 0;
  private pitch = 0;
  private uniScale = 0;
  private vol = 0;
  private readonly g = new Float32Array(4);
  private readonly prev = new Float32Array(4);
  private readonly cur = new Float32Array(4);
  private readonly inc = new Float32Array(4);
  private readonly osc: FftOsc;
  private readonly uni: Float32Array;
  private relStarted = false;
  private relLink = false;
  private fade = -1;
  private fadeC = 0;
  private fadeStep = 0;
  private fadePrev = new Float32Array(2);
  private readonly stages: Biquad[] = [];
  private fType = 0;
  private fC3c = 0;
  private fC40 = 0;
  private fC44 = 0;
  private fAlt = 0;
  private unlinkVel = false;
  private lastD8 = NaN;
  private lastD9 = NaN;
  private readonly version: number;
  private buf = new Float32Array(64);
  private buf2 = new Float32Array(128);
  private firstGain = true;
  /** O.w44 reached 0 / voice never produced a block yet. */
  private dead = false;

  constructor(private readonly plug: OgunPlug, private readonly P: GenVoiceParams) {
    const pl = plug;
    this.version = pl.version;
    const S = pl.S;
    const hostPitch = P.levels.pitch - 6000;
    const s12 = f32(f32(hostPitch) + f32(pl.masterPitch));
    this.keyF = Math.max(0, f32(f32(f32(hostPitch) * f32(0.01)) + 60));
    this.key = rint(this.keyF);
    const vel = flVelocity(P.velocity);
    this.w18 = -pl.ctrl;
    this.mod[0] = pl.pi[3];
    this.mod[1] = pl.pi[4];
    const velBits = pl.velLink;
    // portamento: a note of colour 14 xor the "always" setting glides from the previous note's pitch (0x6e0d4)
    const glide = ((P.color === 14) !== (pl.glideAlways !== 0)) && pl.lastPitch !== null;
    let s11 = 0, s9 = 0;
    if (velBits > 0) { s11 = f32(2 - f32(vel * 2)); s9 = vel; }
    this.updateXY();
    // articulators' trigger values (6e458)
    for (let i = 0; i < 13; i++) {
      this.st.push(new OgArtState());
      this.live.push(false);
    }
    for (let i = 0; i < 13; i++) {
      if (i === 8) continue;
      const art = pl.arts[i];
      this.d80[i] = art.noteValue(this.keyF, vel);
      if (i >= 5) {
        if (art.xTab) this.d80[i] = art.applyTable(this.d80[i], art.xTab, this.xi);
        if (art.yTab) this.d80[i] = art.applyTable(this.d80[i], art.yTab, this.yi);
        continue;
      }
      if (i === 3) {
        this.d80[3] = this.d80[3] * 4;
        if (!pl.linkKeyPitch) this.d80[3] = this.d80[3] - hostPitch * 0.0008333333333333334;
        this.pitch = f32(s12 + this.d80[3] * 1200);
      }
      const st = this.st[i];
      art.noteOn(st);
      this.live[i] = art.live;
      // initial value (0x2674f0): base + envelope * amount (+ LFO)
      let o = art.base;
      if (art.env.enabled !== 0) o = o + st.env.out * art.ea;
      if (art.lfo.enabled !== 0) {
        if (art.mode === 1) o = o + st.lfo.lfoOut * art.la;
        else o = o * (st.lfo.lfoOut * art.la * 2 + 1);
      }
      st.out = o;
      if (!this.live[i]) { st.out = this.d80[i]; continue; }
      if (glide && i === 3) {
        // portamento (0x6e6a8): the pitch envelope starts at the interval to the previous note and glides to 0
        let d = f32((pl.lastPitch as number) - this.pitch);
        const gm = pl.glideMode;
        if (gm > 0) {
          const sgn = d === 0 ? 0 : d < 0 || Object.is(d, -0) ? -1 : 1;
          if (gm >= 2) {
            const lim = f32((6 - gm) * 100);
            const a = Math.abs(d);
            d = f32(sgn * (a < lim ? a : lim));
          } else {
            const s8 = f32(sgn * 1200);
            while (Math.abs(d) > 1250) d = f32(d - s8);
          }
        }
        if (d !== 0) {
          ogSetStartOfs(art.env, st.env, f32(d * 0.0008333333333333334));
          if (pl.glideVariable) st.env.scale[0] = f32(f32(st.env.scale[0] * Math.abs(d)) * 0.0008333333333333334);
          ogSusSetup(art.env, st.env);
          ogSetStartOfs(art.env, st.env, st.env.ofs);
        }
      } else if (velBits > 0 && art.env.enabled !== 0) {
        if (velBits & 1) {
          st.env.scale[0] = f32(st.env.scale[0] * s11);
          ogSusSetup(art.env, st.env);
          ogSetStartOfs(art.env, st.env, st.env.ofs);
        }
        if (velBits & 2) ogEnvSkipAttack(art.env, st.env, s9);
      }
      const v = this.d80[i];
      st.out = art.mode === 0 ? st.out * v : art.mode === 1 ? st.out + v : st.out * v * 2;
    }
    this.relLink = pl.linkRelease !== 0 && pl.arts[0].env.enabled !== 0 && pl.arts[0].env.decay >= 0;
    this.fade = pl.clickRemoval ? rint(pl.declick) : -1;
    if (this.fade > 0) { this.fadeStep = f32(1 / this.fade); this.fadeC = 0; this.fadePrev[0] = 0; this.fadePrev[1] = 0; }
    // the oscillator (6ea98 ..)
    const uniN = pl.pi[12];
    const f20 = f32(pl.pi[15] * this.st[4].out);
    this.uniStore = f20;
    this.uniScale = f32(f32(f32(lexp(f32(f20 * 0.00390625) * 2.3978952727983707) - 1) * 5) * LN2_1200);
    const pt = f32(1 - f32(f32(pl.pi[16]) * 0.0078125) * this.d80[5]);
    const pe = f32(lexp(pt * 4.6151205168412597) - 1);
    const phaseAtten = f32(intPower(f32(1 - f32(pe * f32(0.01))), S.order));
    const uniVol = f32(pl.pi[14] * 0.0078125);
    let seedA = pl.hash1;
    if (pl.linkKeySeed) seedA = seedHash0(this.key + pl.pi[10] + 20, 173);
    let seedB = pl.hash2;
    if (seedB < 0) { seedB = seedHash0(pl.counter + 20, 307); pl.counter++; }
    // decay time in samples (6ec60)
    let decay: number;
    if (pl.fDec < 0) decay = -1;
    else {
      const e = f32(lexp(pl.fDec * 3.044522437723423) - 1);
      const ms = f32(50 + e * 997.5 * f32(this.d80[7]));
      decay = f32(ms * 0.001 * pl.srp);
    }
    const full = Math.max(-1, Math.min(1, f32(pl.fFull + this.d80[9] * 2)));
    const rot = Math.max(-0.5, Math.min(0.5, f32(this.d80[12])));
    const rate = lexp(f32(this.pitch) * 0.0008333333333333334 * LN2);
    this.osc = new FftOsc(S, {
      hop: pl.hop, seedA, seedB, morph: f32(pl.fMorph * this.d80[10]), preDecay: pl.fPre * this.d80[6], decay, fullness: full,
      quality: pl.resByte, rate, unison: uniN, rotation: rot, shift: f32(this.d80[11]),
    });
    this.uni = new Float32Array(uniN);
    // unison voices (6eef8)
    const n = uniN;
    const volN = n > 2 ? f32(1 / Math.sqrt(n)) : 1;
    const s14 = f32((n - 1) / n * 0.5);
    const gl = new Float32Array(2);
    for (let i = 0; i < n; i++) {
      let rt: number, ph: number, glv: number, grv: number;
      if (n === 1) {
        this.uni[0] = 0;
        rt = 1; ph = 0; glv = f32(0.3); grv = f32(0.3);
      } else {
        const s8 = f32(i / n);
        ph = f32(f32(s8 - s14) * phaseAtten);
        const s13 = f32(i / (n - 1));
        let p = f32(f32(s13 * 2) - 1);
        const s12 = f32(f32(p * 0.0078125) * pl.pi[13]);
        p = Math.abs(p);
        const s2 = f32(1 - p);
        const s15 = f32(f32(volN * 2) * s2);
        let s9: number;
        if (n === 2) s9 = f32(0.3);
        else s9 = f32(f32(f32(volN * uniVol) + f32(s15 * f32(1 - uniVol))) * 0.3);
        panLaw(s12, s9, gl, 0);
        // FL passes (pan, gain) to G[3f4960] with the outputs in [sp], [sp+4]
        let q = p;
        if (i & 1) q = -q;
        if ((n & 1) === 1 && i * 2 > n) q = -q;
        const w = f32(q * UNI_TAB[i]);
        this.uni[i] = w;
        rt = f32(lexp(f32(w * this.uniScale)));
        glv = gl[0]; grv = gl[1];
      }
      this.osc.setSlot(i, rt, ph, glv, grv);
    }
    // filter (6f130)
    const stages = pl.filterStages;
    this.fType = pl.filterType;
    this.fAlt = pl.filterAlt;
    this.fC44 = f32(pl.hostD28);
    if (pl.filt2x) this.fC44 = f32(this.fC44 * 0.5);
    this.fC3c = stages > 0 ? f32(1 / stages) : 0;
    let c40 = f32(stages);
    if (this.fType === 2) c40 = f32(1 / c40);
    this.fC40 = f32(c40 * LN2_2);
    for (let k = 0; k < stages; k++) this.stages.push(new Biquad());
    pl.lastPitch = this.pitch;
    // velocity is unlinked from the host's volume (FPV_SetLinkVelocity 0: the plugin applies it itself)
    this.unlinkVel = pl.velToVolume === 0;
  }

  /** Mod X / Y indexes into the mapping tables from the base values and the host's levels (6e3b8). */
  private updateXY(): void {
    const lv = this.P.levels;
    const cl = (v: number): number => { let r = Math.round(v); if (r - v === 0.5 && r % 2 !== 0) r--; return r < 0 ? 0 : r > 512 ? 512 : r; };
    this.xi = cl(f32(this.mod[0] + f32(f32(lv.fcut) * 256)));
    this.yi = cl(f32(this.mod[1] + f32(f32(lv.fres) * 256)));
  }

  /** Timbre release (0x6f360): the release time articulator's value with the release velocity, then the oscillator's release. */
  private startRelease(vel: number): void {
    if (this.relStarted) return;
    this.relStarted = true;
    const pl = this.plug;
    const art = pl.arts[8];
    const v = vel < 0 ? 0 : vel > 1 ? 1 : vel;
    let d = art.noteValue(this.keyF, f32(v));
    if (art.xTab) d = art.applyTable(d, art.xTab, this.xi);
    if (art.yTab) d = art.applyTable(d, art.yTab, this.yi);
    this.d80[8] = d;
    const e = f32(lexp(pl.fRel * 3.044522437723423) - 1);
    const ms = f32(50 + e * 997.5 * f32(d));
    this.osc.release(ms * 0.001 * pl.srp);
  }

  release(): void {
    if (this.state < 5) this.state = 5;
    if (!this.relLink) this.startRelease(f32(this.P.release / 128));
    for (let i = 0; i < 5; i++) this.plug.arts[i].release(this.st[i]);
  }

  /** Force the voice to end (0x6f6d0: one voice per key, stolen voices). */
  force(): void {
    if (this.state < 9) this.state = 9;
    for (let i = 0; i < 5; i++) this.st[i].kill();
  }

  /** The channel drops the voice (FL's Voice_Kill 0x6f750): it leaves the plugin's voice list at once. */
  kill(): void {
    this.state = 10;
  }

  /**
   * The voice's contribution to the block's mix (interleaved, processing rate). FL's voices add into one shared buffer, newest
   * voice first; float addition is not associative, so each voice keeps its own and the instance adds them in FL's order.
   */
  out = new Float32Array(2 * 256);

  /** Write the voice buffer (interleaved, n frames) at frame `off` of `out` with the ramped gains (G[3f48b0]). */
  private mixOut(off: number, n: number): void {
    const b = this.buf, mix = this.out;
    let g0 = this.cur[0], g1 = this.cur[1], g2 = this.cur[2], g3 = this.cur[3];
    const i0 = this.inc[0], i1 = this.inc[1], i2 = this.inc[2], i3 = this.inc[3];
    for (let i = 0; i < n; i++) {
      const a = b[2 * i], c = b[2 * i + 1];
      const l = f32(f32(a * g0) + f32(c * g2));
      const r = f32(f32(c * g1) + f32(a * g3));
      const o = 2 * (off + i);
      mix[o] = l;
      mix[o + 1] = r;
      g0 = f32(g0 + i0); g1 = f32(g1 + i1); g2 = f32(g2 + i2); g3 = f32(g3 + i3);
    }
  }

  render(L: Float32Array, R: Float32Array, n: number): boolean {
    const pl = this.plug;
    if (this.state >= 10 || this.dead) return false;
    if (pl.version !== this.version) { this.dead = true; return false; }
    const lv = this.P.levels;
    let vg = 1;
    if (this.unlinkVel) { const g = noteVolume(this.P.velocity); vg = g > 1e-9 ? g : 0; }
    // the host's FinalLevels.Vol is a float32
    const ff30 = f32(f32(this.unlinkVel ? (vg > 0 ? lv.vol / vg : 0) : lv.vol) * pl.master);
    this.vol = ff30;
    const pan = lv.pan < -1 ? -1 : lv.pan > 1 ? 1 : f32(lv.pan);
    // the plugin runs at os x the host rate (FL's Gen_Render multiplies the block by plug+0x5bc)
    const N = n * pl.os;
    const base = this.P.frame * pl.os;
    if (this.buf.length < 2 * N) { this.buf = new Float32Array(2 * N); this.buf2 = new Float32Array(4 * N); }
    if (this.out.length < 2 * (base + N)) { const m = new Float32Array(2 * (base + N) + 512); m.set(this.out); this.out = m; }
    let remaining = N, off = 0;
    while (remaining > 0) {
      if (this.w18 <= 0) this.control(pan, ff30);
      // pitch (70000)
      const newPitch = f32(f32(f32(hostPitch(lv)) + f32(pl.masterPitch)) + this.st[3].out * 1200);
      if (newPitch !== this.pitch) {
        this.pitch = newPitch;
        const ratio = lexp(newPitch * 0.0008333333333333334 * LN2);
        this.osc.ratio = ratio * pl.S.d80;
      }
      const u = f32(pl.pi[15] * this.st[4].out);
      if (u !== this.uniStore) {
        this.uniStore = u;
        const s = f32(f32(f32(lexp(f32(u * 0.00390625) * 2.3978952727983707) - 1) * 5) * LN2_1200);
        for (let j = 0; j < this.osc.slots.length; j++) this.osc.slots[j].rate = lexp(f32(this.uni[j] * s));
      }
      const chunk = Math.min(remaining, this.w18);
      this.osc.render(this.buf, 0, chunk);
      if (this.osc.w44 <= 0 && this.state < 9) this.state = 9;
      // declick fade-in (701e8)
      if (this.fade > 0) {
        this.fade -= chunk;
        let k = chunk;
        if (this.fade < 0) k += this.fade;
        let c = this.fadeC;
        const step = this.fadeStep;
        let pl0 = this.fadePrev[0], pr0 = this.fadePrev[1];
        for (let i = 0; i < k; i++) {
          pl0 = f32(pl0 + f32(c * f32(this.buf[2 * i] - pl0)));
          this.buf[2 * i] = pl0;
          pr0 = f32(pr0 + f32(c * f32(this.buf[2 * i + 1] - pr0)));
          this.buf[2 * i + 1] = pr0;
          c = f32(c + step);
        }
        this.fadePrev[0] = pl0; this.fadePrev[1] = pr0;
        this.fadeC = f32(f32(step * k) + this.fadeC);
      }
      this.filter(chunk);
      this.mixOut(base + off, chunk);
      for (let k = 0; k < 4; k++) this.cur[k] = f32(this.cur[k] + f32(this.inc[k] * chunk));
      this.firstGain = false;
      off += chunk;
      this.w18 -= chunk;
      remaining -= chunk;
    }
    if (this.state >= 9 || this.w14 >= 9) {
      if (this.state < 10) {
        let z = true;
        for (let k = 0; k < 4; k++) if (this.cur[k] !== 0 || this.inc[k] !== 0) z = false;
        if (z) this.state = 10;
      }
    }
    return this.state < 10;
  }

  private uniStore = NaN;

  /** The control-rate update (6fad8..6ffe0): articulators, gains and their ramps. */
  private control(pan: number, ff30: number): void {
    const pl = this.plug;
    let first: number;
    if (this.w18 < 0) { this.w18 = -this.w18; first = 0; } else { this.w18 = pl.ctrl; first = 1; }
    this.w14 = 9;
    const lv = this.P.levels;
    for (let k = 0; k < 2; k++) {
      const base = f32(pl.pi[3 + k]);
      if (pl.smoothMod) this.mod[k] = f32(base + f32(f32(this.mod[k] - base) * pl.smooth));
      else this.mod[k] = base;
    }
    void lv;
    this.updateXY();
    for (let i = 0; i < 5; i++) {
      const art = pl.arts[i], st = this.st[i];
      let v = this.d80[i];
      if (art.xTab) v = art.applyTable(v, art.xTab, this.xi);
      if (art.yTab) v = art.applyTable(v, art.yTab, this.yi);
      if (this.live[i]) {
        art.process(st, v, first);
        const m = Math.min(st.env.stage, st.lfo.stage);
        if (m < this.w14) this.w14 = m;
      } else st.out = v;
    }
    if (this.state >= 9) panGains(this.g, 0, 0, 0);
    else panGains(this.g, 0, pan, f32(ff30 * this.st[0].out));
    if (this.firstGain) for (let k = 0; k < 4; k++) this.prev[k] = this.g[k];
    for (let k = 0; k < 4; k++) this.ramp(k, pl.ctrl, pl.maxStep);
    if (this.relLink && this.st[0].env.mode >= 3) this.startRelease(0.5);
  }

  /** 0x7ccc0: ramp from the previous target to the new gain over a control block, limited to the host's maximum step. */
  private ramp(k: number, n: number, maxStep: number): void {
    const cur = this.prev[k];
    this.cur[k] = cur;
    let inc = f32(this.g[k] - cur);
    this.inc[k] = inc;
    if (inc === 0) return;
    this.prev[k] = this.g[k];
    inc = f32(inc / n);
    this.inc[k] = inc;
    if (Math.abs(inc) > maxStep) {
      inc = inc < 0 ? -maxStep : maxStep;
      this.inc[k] = inc;
      this.prev[k] = f32(cur + f32(inc * n));
      if (Math.abs(this.prev[k]) < 5.960464477539063e-8) {
        this.prev[k] = 0;
        this.inc[k] = f32(-cur / n);
      }
    }
  }

  /** The voice filter (6b350 + 7035x): coefficients every chunk, 2x oversampling below 88.2 kHz. */
  private filter(n: number): void {
    const pl = this.plug;
    const stages = this.stages.length;
    if (stages < 1) return;
    this.design(f32(pl.fltFreq) + this.st[1].out, f32(pl.fltRes) + this.st[2].out);
    const io = this.buf;
    if (pl.filt2x) {
      const up = this.buf2;
      for (let i = 0; i < n; i++) {
        up[4 * i] = io[2 * i]; up[4 * i + 1] = io[2 * i + 1];
        up[4 * i + 2] = io[2 * i]; up[4 * i + 3] = io[2 * i + 1];
      }
      for (let k = stages - 1; k >= 0; k--) this.stages[k].process(up, 2 * n);
      for (let i = 0; i < n; i++) {
        io[2 * i] = f32(f32(up[4 * i] * 0.5) + f32(up[4 * i + 2] * 0.5));
        io[2 * i + 1] = f32(f32(up[4 * i + 1] * 0.5) + f32(up[4 * i + 3] * 0.5));
      }
    } else {
      for (let k = stages - 1; k >= 0; k--) this.stages[k].process(io, n);
    }
  }

  /** 0x6b350: the biquad stages of the filter type from the frequency and resonance values. */
  private design(d8: number, d9: number): void {
    // the coefficients depend on these two values only (FL recomputes them every block)
    if (d8 === this.lastD8 && d9 === this.lastD9) return;
    this.lastD8 = d8;
    this.lastD9 = d9;
    const type = this.fType;
    const stages = this.stages.length;
    const ex = (x: number, c: number): number => f32(lexp(f32(x) * c) - 1);
    if (this.fAlt !== 0) d9 = d9 * (d8 + 1) * 0.5;
    let wOfs: number;
    if (type === 0 || type === 3) {
      if (!(d8 > 0)) d8 = 0;
      else d8 = ex(d8, 7.3138868316334618) * (type === 0 ? 0.0006646666666666667 : 0.00039993333333333331);
      if (type === 3 && d8 > 0.6001) d8 = 0.6001;
      if (!(d9 > 0)) d9 = 0.1;
      else if (d9 >= 1) d9 = 50;
      else d9 = 0.1 + ex(d9, 7.6014023345837334) * 0.02495;
      if (stages > 1) d9 = powF(f32(d9), this.fC3c);
      d9 = 0.5 / d9;
      wOfs = type === 0 ? 0.003 : 0.0001;
    } else {
      if (!(d8 > 0)) d8 = 0;
      else d8 = ex(d8, 7.3138868316334618) * 0.00039993333333333331;
      if (d8 > 1.0001) d8 = 1.0001;
      if (!(d9 > 0)) d9 = 0.01;
      else if (d9 >= 1) d9 = 12;
      else d9 = 0.01 + ex(d9, 4.6151205168412597) * 0.1199;
      d9 = d9 * this.fC40;
      wOfs = 0.0001;
    }
    const d10 = this.fC44 * PI * 2;
    for (let k = stages - 1; k >= 0; k--) {
      const s = this.stages[k];
      s.type = FILTER_TYPE[type];
      let w = (wOfs + d8) * d10;
      if (w > FC_MAX) w = FC_MAX;
      else if (w < 0) w = 0;
      const sin = lsin(w), cos = lcos(w);
      if (type === 0 || type === 3) s.design(0, sin * d9, sin, cos);
      else {
        const x = (d9 * w) / sin;
        const sh = 0.5 * (lexp(x) - lexp(-x));
        s.design(0, sin * sh, sin, cos);
      }
    }
  }
}

function hostPitch(lv: { pitch: number }): number {
  return lv.pitch - 6000;
}

void seedHash;
void ogEnvEval;
