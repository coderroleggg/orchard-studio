// A voice of FL's SoundFont Player (Sobanth TVoice, Process 0x1df980, parameters 0x1d7fb0): one SF2 zone playing
// a key. Everything is evaluated per 32-sample control block counted from the voice's own start (envelopes,
// LFOs, gain, pitch, filter coefficients); inside a block the sample is resampled (FL's banded sinc kernels),
// filtered, and mixed with linearly ramped left / right gains. See docs/research/gen/soundfont.md.

import { G } from '../../../../model/gen/plugins/soundfont/gens';
import { clampF } from './num';
import { SfEnv, ENV_ATTACK, ENV_DONE, ENV_RELEASE } from './env';
import { SfFilter } from './filter';
import type { SincTables } from './interp';
import { modValue, type SfControls } from './mod';
import type { SfZone } from './zone';

export const BLOCK = 32;
const BLOCK_INV = 1 / BLOCK;
const TWO32 = 4294967296;
export const OVR_NONE = -2147483648;
const NUM_DEST = 64;
const EMPTY = new Float32Array(0);
const f32 = Math.fround;
const C1200 = 0.0008333333535119891;
const LN2 = 0.6931471805599453;
/** exp((x c) ln2) with FL's single-precision 1/1200, as the destination handlers compute it (the operation order matters at step 1). */
const pow2c = (x: number): number => Math.exp(((x < -120000 ? -120000 : x > 120000 ? 120000 : x) * C1200) * LN2);

/** The synth-level settings a voice reads. */
export interface SfSynthCtx {
  sr: number;
  emu: boolean;
  /** FL's resampling mode (1, 4, 6, 8) and its kernel tables (null for linear). */
  mode: number;
  taps: number;
  tables: SincTables | null;
  /** Generator overrides of FL's parameters 5..12 (OVR_NONE = none), indexed by destination. */
  ovr: Int32Array;
  /** "Ignore sample links": left / right samples play on both sides and their linked partners do not play along. */
  ignoreLinks: boolean;
  /** Reverb / chorus send level overrides (< 0 = off: the zone's / modulator's send). */
  revLevel: number;
  chorLevel: number;
  ctl: SfControls;
}

const triangle = (x: number): number => 1 - Math.abs((x + 0.25 - Math.floor(x + 0.25) - 0.5) * 4);

/** One LFO (FL's slots at voice +0x370 / +0x3c8): the phase advances once per block after the delay. */
class Lfo {
  phase = 0;
  value = 0;
  inc = 0;
  delay = 0;
  reset(): void { this.phase = 0; this.value = 0; this.inc = 0; this.delay = 0; }
  tick(age: number): void {
    if (age >= this.delay) {
      const p = this.phase + this.inc;
      this.phase = p - Math.trunc(p);
    }
    this.value = triangle(this.phase);
  }
}


export class SfVoice {
  active = false;
  noteId = 0;
  key = 60;
  vel = 100;
  exclusive = 0;
  zone: SfZone | null = null;
  // sample: pool data, pool index of the sample start, length, sample rate (scaled to the decoded pool), loop (relative indices)
  pcm: Float32Array = EMPTY;
  base = 0;
  len = 0;
  sRate = 44100;
  ratio = 1;
  rootCents = 6000;
  ls = 0;
  le = 0;
  startOff = 0;
  endOff = 0;
  looping = false;
  guard = 9;
  released = false;
  /** Note levels (FL: FinalLevels.Vol / Pan, pitch offset in cents) and the start order (stealing). */
  /** The played key (modulator source) and a velocity override that takes effect with the next level update (-1: none). */
  noteKey = 60;
  pendingVel = -1;
  noteVol = 1;
  notePan = 0;
  pitchOffset = 0;
  seq = 0;

  readonly volEnv = new SfEnv();
  readonly modEnv = new SfEnv();
  readonly lfoMod = new Lfo();
  readonly lfoVib = new Lfo();
  readonly filter = new SfFilter();
  /**
   * The voice has three low-pass filters in series (FL's slots +0x120 / +0x1d8 / +0x290); the SF2 voice drives the first. The other two
   * keep their default cutoff of 13500 cents (19.9 kHz) and no resonance: bypassed while the cutoff is above 0.45 sample rate, i.e.
   * up to 44249 Hz; from 44250 Hz they filter at 19.9 kHz and add 2 x 1.505 dB (the RBJ gain 1 / sqrt(Q) at Q 0): +3.01 dB
   * (= sqrt 2) and a roll-off above 8 kHz at 48 kHz.
   */
  readonly filter2 = new SfFilter();
  readonly filter3 = new SfFilter();
  readonly modsum = new Float64Array(NUM_DEST);
  /**
   * The generator overrides (FL's parameters 5..12) this voice has seen: a voice takes the synth's at its start and follows a
   * change only for the destinations a modulator of the voice targets (FL's ProcessParam updates the modulator destinations of
   * the voices, 0x1ddff0), i.e. in practice the cutoff and the LFO amount, not the envelope times or the LFO speed / delay.
   */
  readonly ovr = new Int32Array(NUM_DEST);
  private readonly modDest = new Uint8Array(NUM_DEST);

  // derived parameters
  att = 0; tune = 0; revSend = 0; chorSend = 0; panL = 1; panR = 1; rootNorm = 1;
  fcBase = 13500; qBase = 0;
  modLfoPitch = 0; vibLfoPitch = 0; modEnvPitch = 0; modLfoFc = 0; modEnvFc = 0; modLfoVol = 0;
  // block state
  age = 0;
  blockLeft = 0;
  curL = 0; curR = 0; incL = 0; incR = 0; rampLeft = 0;
  revNow = 0; chorNow = 0;
  step = 1;
  stepHi = 1; stepLo = 0; stepMix = 0;
  posHi = 0; posLo = 0;
  /** The voice has looped (FL +0x534); the chunk reads the loop guard zones (FL +0x538). */
  wrapped = false; useGuard = false;
  /** Resampling path of the block: 0 nearest, 1 exact copy, 2 linear, 3 sinc kernel. */
  path = 3;
  prevKernel = false;
  lastL = 0; lastR = 0;
  private kernel: Float32Array | null = null;
  private kernelBand = -1;
  private kernelOf: SincTables | null = null;
  private readonly tmp = new Float32Array(BLOCK);

  // ------------------------------------------------------------------ start
  start(z: SfZone, ctx: SfSynthCtx, pcm: Float32Array, ratio: number, id: number, key: number, vel: number, seq: number): boolean {
    const s = z.sample;
    // a sample whose data is not in the pool (damaged header) is never played; its end is cut to the pool
    const base = Math.round(s.start * ratio);
    if (!(base >= 0 && base < pcm.length)) return false;
    this.zone = z;
    this.noteId = id; this.seq = seq;
    // The keynum generator replaces the played key in the tuning and the envelope key scaling, but the modulators keep seeing the
    // played key. The velocity generator reaches the modulators one render block late (FL refreshes them with the next level
    // update): the first block plays with the played velocity (measured with the test host at several block sizes).
    const gk = z.gens[G.keynum], gv = z.gens[G.velocity];
    this.key = gk >= 0 ? Math.min(127, Math.trunc(gk)) : key;
    this.noteKey = key;
    this.vel = vel;
    this.pendingVel = gv >= 0 ? Math.min(127, Math.trunc(gv)) : -1;
    this.exclusive = z.exclusive;
    this.pcm = pcm;
    this.ratio = ratio;
    this.base = base;
    this.len = Math.min(Math.max(0, Math.round((s.end - s.start) * ratio)) + 1, pcm.length - base);
    this.sRate = Math.max(1, s.rate) * ratio;
    this.released = false;
    this.volEnv.reset(); this.modEnv.reset();
    this.lfoMod.reset(); this.lfoVib.reset();
    this.filter.reset(); this.filter2.reset(); this.filter3.reset();
    this.age = 0; this.blockLeft = 0;
    this.curL = 0; this.curR = 0; this.incL = 0; this.incR = 0; this.rampLeft = 0;
    this.lastL = 0; this.lastR = 0;
    this.prevKernel = false;
    this.kernel = null; this.kernelBand = -1; this.kernelOf = null;
    this.noteVol = 1; this.notePan = 0; this.pitchOffset = 0;
    this.revNow = 0; this.chorNow = 0;
    this.ovr.set(ctx.ovr);
    this.modDest.fill(0);
    for (const m of z.mods) if (m.dest >= 0 && m.dest < NUM_DEST) this.modDest[m.dest] = 1;
    this.updateMods(ctx);
    this.recompute(ctx);
    this.posHi = this.startOff; this.posLo = 0;
    this.wrapped = false; this.useGuard = false;
    this.active = true;
    return true;
  }

  /** Evaluate the modulator list (spec 9.5.3) into the destination sums. */
  updateMods(ctx: SfSynthCtx): void {
    const z = this.zone!;
    const c = ctx.ctl;
    const sv = c.velocity, sk = c.key;
    c.velocity = this.vel; c.key = this.noteKey;
    this.modsum.fill(0);
    for (const m of z.mods) {
      const d = m.dest;
      if (d >= 0 && d < NUM_DEST) this.modsum[d] += modValue(m, c);
    }
    c.velocity = sv; c.key = sk;
  }

  /** The synth's override of generator `gen` changed: the voice follows it when one of its modulators targets that destination. */
  applyOverride(ctx: SfSynthCtx, gen: number): void {
    if (gen < 0 || gen >= NUM_DEST || !this.modDest[gen] || this.ovr[gen] === ctx.ovr[gen]) return;
    this.ovr[gen] = ctx.ovr[gen];
    this.recompute(ctx);
  }

  /** The velocity generator's override reaches the modulators (the first level update after the note started). */
  applyPendingVelocity(ctx: SfSynthCtx): void {
    if (this.pendingVel < 0) return;
    this.vel = this.pendingVel;
    this.pendingVel = -1;
    this.updateMods(ctx);
    this.recompute(ctx);
  }

  /** destSum (0x1d7ee0): the generator (or FL's override) times the scale plus the modulators. */
  private ds(ctx: SfSynthCtx, scale: number, d: number): number {
    const o = this.ovr[d];
    const g = o !== OVR_NONE ? o : this.zone!.gens[d];
    return g * scale + this.modsum[d];
  }

  /** A time in samples from timecents the way the handlers do it: the single precision clamp, then the double precision cuts. */
  private timeSamples(sr: number, tc: number, hi: number): number {
    let v = clampF(tc, -12000, hi);
    v = v < -12000 ? -12000 : v > hi ? hi : v;
    return sr * pow2c(v);
  }

  /** The hold / decay time of 0x1d6f10: double precision cuts only. */
  private timeSamplesD(sr: number, tc: number, hi: number): number {
    const v = tc < -12000 ? -12000 : tc > hi ? hi : tc;
    return sr * pow2c(v);
  }

  /** Derived parameters from the generators (the destination handlers of 0x1d7fb0). */
  recompute(ctx: SfSynthCtx): void {
    const z = this.zone!;
    const sr = ctx.sr;
    this.att = clampF(this.ds(ctx, ctx.emu ? 0.4 : 1, G.initialAttenuation), 0, 1440);
    // the sample header's root key 255 means unpitched: key 60 (measured; other values above 127 are used as they are)
    const root = z.gens[G.overridingRootKey] >= 0 ? z.gens[G.overridingRootKey] : z.sample.pitch === 255 ? 60 : z.sample.pitch;
    this.rootCents = f32(root * 100 - z.sample.correction);
    // the note's base pitch (0x1dd9e0): the root key's cents through FL's tuning table (the semitone value is the root cents
    // times a single precision 0.01, so the root lies a hair below its note), blended to the played key's cents by the
    // scale tuning generator (also times the single precision 0.01)
    const x = this.rootCents * 0.009999999776482582;
    const n = Math.trunc(x), fr = x - n;
    const rootT = (fr === 0 || n >= 126 ? n : n * (1 - fr) + (n + 1) * fr) * 100;
    const base = rootT + (z.gens[G.scaleTuning] * 0.009999999776482582) * (this.key * 100 - rootT);
    this.tune = (base + (100 * this.ds(ctx, 1, G.coarseTune) + this.ds(ctx, 1, G.fineTune))) + this.pitchOffset;
    this.revSend = clampF(this.ds(ctx, 1, G.reverbEffectsSend) * 0.001, 0, 1);
    this.chorSend = clampF(this.ds(ctx, 1, G.chorusEffectsSend) * 0.001, 0, 1);
    const th = (500 + this.ds(ctx, 1, G.pan)) * 0.0015707963267948967;
    this.panL = Math.cos(th); this.panR = Math.sin(th);
    this.rootNorm = 1 / (((440 * pow2c(this.rootCents - 6900)) * sr) / this.sRate);
    this.fcBase = this.ds(ctx, 1, G.initialFilterFc);
    this.qBase = f32(this.ds(ctx, 1, G.initialFilterQ));
    this.modLfoPitch = clampF(this.ds(ctx, 1, G.modLfoToPitch), -12000, 12000);
    this.vibLfoPitch = clampF(this.ds(ctx, 1, G.vibLfoToPitch), -12000, 12000);
    this.modEnvPitch = clampF(this.ds(ctx, 1, G.modEnvToPitch), -12000, 12000);
    this.modLfoFc = clampF(this.ds(ctx, 1, G.modLfoToFilterFc), -12000, 12000);
    this.modEnvFc = clampF(this.ds(ctx, 1, G.modEnvToFilterFc), -12000, 12000);
    this.modLfoVol = clampF(this.ds(ctx, 1, G.modLfoToVolume), -960, 960);
    this.lfoMod.delay = Math.trunc(this.timeSamples(sr, this.ds(ctx, 1, G.delayModLFO), 5000));
    this.lfoVib.delay = Math.trunc(this.timeSamples(sr, this.ds(ctx, 1, G.delayVibLFO), 5000));
    this.lfoMod.inc = (BLOCK * (8.175798915643707 * pow2c(clampF(this.ds(ctx, 1, G.freqModLFO), -16000, 4500)))) / sr;
    this.lfoVib.inc = (BLOCK * (8.175798915643707 * pow2c(clampF(this.ds(ctx, 1, G.freqVibLFO), -16000, 4500)))) / sr;
    // envelopes: times in control blocks (0x1d7fb0 handlers 0x21..0x26 / 0x19..0x1e, hold / decay with key scaling 0x1d6f10)
    // 0x1d6f10: the hold time below -32768 is zero; the decay time is cut to -12000 (about a millisecond) instead
    const hold = (td: number, kd: number, hi: number, zeroBelow: boolean): number => {
      const v = this.ds(ctx, 1, kd) * (60 - this.key) + this.ds(ctx, 1, td);
      return zeroBelow && !(v > -32768) ? 0 : Math.trunc(this.timeSamplesD(sr, v, hi));
    };
    const sus = (g: number): number => clampF(1 - 0.001 * this.ds(ctx, 1, g), 0, 1);
    this.volEnv.setup(
      Math.trunc(this.timeSamples(sr, this.ds(ctx, 1, G.delayVolEnv), 5000) * BLOCK_INV),
      Math.trunc(this.timeSamples(sr, this.ds(ctx, 1, G.attackVolEnv), 8000) * BLOCK_INV) + 1,
      Math.trunc(hold(G.holdVolEnv, G.keynumToVolEnvHold, 5000, true) * BLOCK_INV + 0.5),
      Math.trunc(hold(G.decayVolEnv, G.keynumToVolEnvDecay, 8000, false) * BLOCK_INV + 0.5),
      sus(G.sustainVolEnv),
      Math.trunc(this.timeSamples(sr, this.ds(ctx, 1, G.releaseVolEnv), 8000) * BLOCK_INV) + 1,
    );
    this.modEnv.setup(
      Math.trunc(this.timeSamples(sr, this.ds(ctx, 1, G.delayModEnv), 5000) * BLOCK_INV),
      Math.trunc(this.timeSamples(sr, this.ds(ctx, 1, G.attackModEnv), 8000) * BLOCK_INV) + 1,
      Math.trunc(hold(G.holdModEnv, G.keynumToModEnvHold, 5000, true) * BLOCK_INV + 0.5),
      Math.trunc(hold(G.decayModEnv, G.keynumToModEnvDecay, 8000, false) * BLOCK_INV + 0.5),
      sus(G.sustainModEnv),
      Math.trunc(this.timeSamples(sr, this.ds(ctx, 1, G.releaseModEnv), 8000) * BLOCK_INV) + 1,
    );
    // sample addresses (relative to the sample start)
    const len = this.len;
    const rel = (v: number): number => (v < 0 ? 0 : v > len ? len : v);
    this.startOff = rel(Math.trunc(32768 * this.ds(ctx, 1, G.startAddrsCoarseOffset) + this.ds(ctx, 1, G.startAddrsOffset)));
    this.endOff = rel(Math.trunc(32768 * this.ds(ctx, 1, G.endAddrsCoarseOffset) + this.ds(ctx, 1, G.endAddrsOffset)) + len);
    this.ls = rel(Math.trunc(32768 * this.ds(ctx, 1, G.startloopAddrsCoarseOffset) + this.ds(ctx, 1, G.startloopAddrsOffset)) + Math.round((z.sample.loopStart - z.sample.start) * this.ratio));
    this.le = rel(Math.trunc(32768 * this.ds(ctx, 1, G.endloopAddrsCoarseOffset) + this.ds(ctx, 1, G.endloopAddrsOffset)) + Math.round((z.sample.loopEnd - z.sample.start) * this.ratio));
    this.setupLoop(ctx);
  }

  /**
   * Loop configuration (0x1e1184 ff): sample mode 1 loops, modes 2 and 3 loop until the note is released; any other value
   * plays the sample once. A loop of 8 points or less (a loop end before the start is no loop either) is ignored; the
   * points are cut to the sample, swapped when they cross, and a loop shorter than 3 points is dropped.
   */
  private setupLoop(ctx: SfSynthCtx): void {
    const mode = Math.trunc(this.zone!.gens[G.sampleModes]);
    let loop = mode === 1 || ((mode === 2 || mode === 3) && !this.released);
    let ls = this.ls, le = this.le;
    if (le - ls <= 8) loop = false;
    if (loop) {
      if (le > this.endOff) le = this.endOff;
      if (le < ls) { const t = ls; ls = le; le = t; }
      if (le - ls < 3) loop = false;
    }
    this.looping = loop;
    this.ls = ls; this.le = le;
    this.guard = ctx.taps + 1;
  }

  // ------------------------------------------------------------------ note off / cut
  noteOff(ctx: SfSynthCtx): void {
    if (this.released) return;
    this.released = true;
    const ve = this.volEnv;
    if (ve.stage === ENV_ATTACK) {
      // the linear attack value is converted to the dB domain (0x1d53a0; the modulation LFO's volume term enters and cancels out)
      const d8 = this.lfoMod.value * -this.modLfoVol;
      const a = Math.exp((d8 * -0.004999999888241291) * 2.302585092994046);
      const v = -(((-200 * Math.log(a * ve.out)) * 0.43429448190325176 - d8) * 0.0010416667209938169 - 1);
      ve.value = !(v >= 0) ? 0 : v > 1 ? 1 : v;
    }
    ve.release();
    this.modEnv.release();
    const mode = Math.trunc(this.zone!.gens[G.sampleModes]);
    if (mode === 2 || mode === 3) this.setupLoop(ctx);
  }

  /**
   * FL's Voice_Kill: the volume envelope is sent into a release of the shortest time (-12000 timecents: 2 control blocks at 44.1 kHz),
   * whatever the voice was doing, also when it is releasing already; the voice ends with it (measured at 22 .. 100 kHz with the
   * host's polyphony limit).
   */
  kill(ctx: SfSynthCtx): void {
    const ve = this.volEnv;
    if (ve.stage >= ENV_DONE) return;
    if (!this.released) this.noteOff(ctx);
    const n = Math.trunc(this.timeSamples(ctx.sr, -12000, 8000) * BLOCK_INV) + 1;
    ve.count[ENV_RELEASE] = n;
    ve.b[ENV_RELEASE] = -1 / n;
    ve.stage = ENV_RELEASE;
    ve.pos = 0;
  }

  /** Exclusive class cut: a release of FL's fixed -200 timecents. */
  cut(ctx: SfSynthCtx): void {
    const n = Math.trunc(this.timeSamples(ctx.sr, -200, 8000) * BLOCK_INV) + 1;
    this.volEnv.count[5] = n;
    this.volEnv.b[5] = -1 / n;
    this.noteOff(ctx);
  }

  // ------------------------------------------------------------------ control block
  private attGain(ctx: SfSynthCtx): number {
    const a = this.att;
    if (a < 0) return 1;
    if (a >= 1441) return 0;
    return Math.exp(a * (ctx.emu ? -0.005 : -0.0018814356859432296) * 2.302585092994046);
  }

  /** Per-block setup (0x1df980 up to the sample processing). False when the voice has ended. */
  private startBlock(ctx: SfSynthCtx): boolean {
    const sr = ctx.sr;
    const ve = this.volEnv;
    if (ve.stage >= 6) return false;
    ve.tick();
    this.modEnv.tick();
    this.lfoMod.tick(this.age);
    this.lfoVib.tick(this.age);

    const attG = this.attGain(ctx);
    const lfoAtt = -(this.lfoMod.value * this.modLfoVol);
    let g1: number;
    if (ve.stage === ENV_ATTACK) {
      const gl = lfoAtt < 0 ? 1 : lfoAtt >= 961 ? 0 : Math.exp(lfoAtt * -0.004999999888241291 * 2.302585092994046);
      g1 = attG * gl * ve.out;
    } else {
      const a = 960 * (1 - ve.out) + lfoAtt;
      const gl = a < 0 ? 1 : a >= 961 ? 0 : Math.exp(a * -0.004999999888241291 * 2.302585092994046);
      g1 = attG * gl;
    }
    // inaudible voices release themselves (past the attack, not released, gain below 3e-5)
    if (ve.stage > ENV_ATTACK && !this.released && Math.abs(g1) < 3e-5) this.noteOff(ctx);

    const gain = g1 * this.noteVol;
    let tl = this.panL * gain, tr = this.panR * gain;
    if (!ctx.ignoreLinks) {
      // left / right samples (SF2 sample types 4 / 2) play on their side only
      const ty = this.zone!.sample.type;
      if (ty & 4) tr *= 0; else if (ty & 2) tl *= 0;
    }
    if (Math.abs(this.notePan) > 1e-15) {
      const th = (this.notePan + 1) * 0.25 * 3.141592653589793;
      tl *= Math.cos(th) * 1.414213562373095;
      tr *= Math.sin(th) * 1.414213562373095;
    }
    if (Math.abs(tl - this.curL) > 1e-18 || Math.abs(tr - this.curR) > 1e-18) {
      this.rampLeft = BLOCK;
      this.incL = f32((tl - this.curL) * BLOCK_INV);
      this.incR = f32((tr - this.curR) * BLOCK_INV);
    }

    const cents = this.tune + this.lfoMod.value * this.modLfoPitch + this.lfoVib.value * this.vibLfoPitch + this.modEnv.out * this.modEnvPitch;
    let step = (440 * pow2c(cents - 6900)) * this.rootNorm;
    if (!(step > 0)) step = 1;
    this.step = step;

    const fc = this.fcBase + this.lfoMod.value * this.modLfoFc + this.modEnv.out * this.modEnvFc;
    this.filter.update(fc, this.qBase, sr, BLOCK_INV, BLOCK);
    this.filter2.update(13500, 0, sr, BLOCK_INV, BLOCK);
    this.filter3.update(13500, 0, sr, BLOCK_INV, BLOCK);

    this.revNow = ctx.revLevel >= 0 ? ctx.revLevel : this.revSend;
    this.chorNow = ctx.chorLevel >= 0 ? ctx.chorLevel : this.chorSend;

    this.age += BLOCK;
    this.blockLeft = BLOCK;
    this.selectPath(ctx);
    return true;
  }

  /** The resampling path and kernel band of the block (0x1e0e8c ff). */
  private selectPath(ctx: SfSynthCtx): void {
    const step = this.step;
    const hi = Math.trunc(step);
    const lo = Math.trunc((step - hi) * TWO32);
    this.stepHi = hi; this.stepLo = lo;
    const full = hi * TWO32 + lo;
    this.stepMix = (lo % 1048576) / 1048576;
    if (full === TWO32) { this.path = 1; this.prevKernel = false; return; }
    if (step >= 0.9994225441413808 && step <= 1.0005777895065548 && !this.prevKernel) { this.path = 0; return; }
    if (ctx.mode === 1) { this.path = 2; return; }
    this.path = 3;
    this.prevKernel = true;
    const v = Math.floor(Math.log(full / TWO32) * 17.31234049066756);
    const band = v < 0 ? 0 : v > 63 ? 63 : v;
    if (this.kernelOf !== ctx.tables || this.kernelBand !== band) {
      this.kernel = ctx.tables!.band(band);
      this.kernelBand = band;
      this.kernelOf = ctx.tables;
    }
  }

  // ------------------------------------------------------------------ resampling
  /**
   * Sample at a relative index (FL's sample buffer, 0x1d2c60): the data from the sample start to its end point inclusive
   * (`len` = end - start + 1), the first / last point repeated beyond both ends. While the chunk touches a loop boundary
   * (`useGuard`) FL reads the working copy whose guard zones hold the other end of the loop (0x1df980 ~ 0x1e1f7c): the
   * `guard` points before the loop start and the points from the loop end on repeat the loop.
   */
  private at(i: number): number {
    if (this.useGuard) {
      const ls = this.ls, le = this.le, g = this.guard;
      if (i >= le) { if (i <= le + g) i = ls + (i - le); }
      else if (i < ls && i >= ls - g) i = i + (le - ls);
    }
    const last = this.len - 1;
    return this.pcm[this.base + (i < 0 ? 0 : i > last ? last : i)];
  }

  /** One kernel evaluation: the taps of the 4096-phase table row of the position's top 12 fractional bits. */
  private dot(hi: number, lo: number, taps: number): number {
    const k = this.kernel!;
    const row = Math.floor(lo / 1048576) * taps;
    const s0 = hi - (taps >> 1);
    let acc = 0;
    const base = this.base;
    const pcm = this.pcm;
    const inside = this.useGuard
      ? (s0 >= this.ls && s0 + taps <= this.le) || (s0 >= 0 && s0 + taps <= this.ls - this.guard)
      : s0 >= 0 && s0 + taps <= this.len;
    if (inside) {
      const o = base + s0;
      for (let t = 0; t < taps; t++) acc += k[row + t] * pcm[o + t];
    } else {
      for (let t = 0; t < taps; t++) acc += k[row + t] * this.at(s0 + t);
    }
    return f32(acc);
  }

  /** Resample `n` samples into out: the position advances by the step (the chunk was cut at the loop / sample end). */
  private resample(ctx: SfSynthCtx, out: Float32Array, n: number): void {
    let hi = this.posHi, lo = this.posLo;
    const sh = this.stepHi, sl = this.stepLo;
    const path = this.path;
    const taps = ctx.taps;
    const mix = this.stepMix;
    for (let k = 0; k < n; k++) {
      let v: number;
      if (path === 1 || path === 0) v = this.at(hi);
      else if (path === 2) {
        const f = f32(lo / TWO32);
        v = f32(this.at(hi) * f32(1 - f) + f32(f * this.at(hi + 1)));
      } else {
        const a = this.dot(hi, lo, taps);
        if (mix === 0) v = a;
        else {
          // second evaluation one table phase on, blended by the step's low 20 bits
          let lo2 = lo + 1048576, hi2 = hi;
          if (lo2 >= TWO32) { lo2 -= TWO32; hi2++; }
          const b = this.dot(hi2, lo2, taps);
          const w = f32(mix);
          v = f32(f32(b * w) + f32(a * f32(1 - w)));
        }
      }
      out[k] = v;
      lo += sl;
      let carry = 0;
      if (lo >= TWO32) { lo -= TWO32; carry = 1; }
      hi += sh + carry;
    }
    this.posHi = hi; this.posLo = lo;
  }

  /**
   * The chunk's position handling (FL 0x1dcbc0, forward playback): wrap the position at the loop end (or end the voice at
   * the sample end), cut the chunk to the samples before the boundary and decide whether it touches a loop guard. Returns
   * the number of samples the chunk renders (0: the voice has ended).
   */
  private prepareChunk(ctx: SfSynthCtx, m: number): number {
    const looping = this.looping;
    const lower = looping ? this.ls : this.startOff;
    const upper = looping ? this.le : this.endOff;
    let hi = this.posHi;
    if (hi < lower) {
      if (!looping) { hi = lower; this.posLo = 0; }
    } else if (hi >= upper) {
      this.wrapped = true;
      if (!looping) return 0;
      hi = lower + (hi - upper);
    }
    this.posHi = hi;
    if (hi < 0 || hi >= this.endOff) return 0;
    // chunks are limited to 2^30 / (step + 1) samples (at least 2)
    const nmax = Math.max(2, Math.floor(1073741824 / (this.stepHi + 1)));
    let n = Math.min(m, nmax);
    const sh = this.stepHi, sl = this.stepLo;
    this.useGuard = false;
    // position of the chunk's last sample
    const lo0 = this.posLo;
    const sumLo = lo0 + (n - 1) * sl;
    const endHi = hi + (n - 1) * sh + Math.floor(sumLo / TWO32);
    if (looping) {
      // the sinc kernels read taps / 2 samples behind and taps / 2 - 1 ahead of the position: the chunks near the loop
      // boundaries read the working copy that holds the loop's other end in its guard zones (FL decides with the synth's
      // +0x90 / +0x94 constants taps / 2 - 2 and 1 - taps / 2: a chunk reads it from the loop start up to taps / 2 - 2
      // after it once the voice has looped, from taps / 2 - 1 before the loop end, and whenever the chunk it was asked
      // for reaches that far; the request is the rest of the synth's segment, see synth.ts)
      const a = ctx.mode === 1 ? -1 : (ctx.taps >> 1) - 2;
      const b = ctx.mode === 1 ? 0 : -((ctx.taps >> 1) - 1);
      const nearStart = hi >= lower && (hi < lower + a || (hi === lower + a && lo0 === 0));
      const nearEnd = hi >= upper + b && (hi < upper || (hi === upper && lo0 === 0));
      if ((nearStart && this.wrapped) || nearEnd || endHi >= upper + b) this.useGuard = true;
    }
    if (endHi >= upper) {
      const stepFull = sh * TWO32 + sl;
      const left = (upper - hi) * TWO32 - lo0 - 1;
      n = stepFull > 0 ? Math.floor(left / stepFull) + 1 : n;
      if (n < 1) n = 1;
    }
    return n;
  }

  // ------------------------------------------------------------------ rendering
  /**
   * Render up to `n` samples at output offset `o`: dry stereo into L / R, the sends into the reverb / chorus buses. Returns the
   * number of samples rendered (fewer when the voice ended: the caller adds the voice's decaying tail).
   */
  process(ctx: SfSynthCtx, n: number, L: Float32Array, R: Float32Array, rL: Float32Array, rR: Float32Array, cL: Float32Array, cR: Float32Array, o: number): number {
    let done = 0;
    while (done < n) {
      if (this.blockLeft <= 0 && !this.startBlock(ctx)) { this.active = false; return done; }
      // FL asks for the rest of the segment, then limits the chunk to the control block (the loop guard is decided for the
      // requested chunk, so short loops differ with the segment length)
      let m = this.prepareChunk(ctx, n - done);
      if (m <= 0) { this.active = false; return done; }
      if (m > this.blockLeft) m = this.blockLeft;
      this.resample(ctx, this.tmp, m);
      this.filter.process(this.tmp, m);
      this.filter2.process(this.tmp, m);
      this.filter3.process(this.tmp, m);
      let gl = this.curL, gr = this.curR;
      const il = this.incL, ir = this.incR;
      let ramp = this.rampLeft;
      const rs = this.revNow, cs = this.chorNow;
      let ll = 0, lr = 0;
      for (let k = 0; k < m; k++) {
        const x = this.tmp[k];
        if (ramp > 0) { gl = f32(gl + il); gr = f32(gr + ir); ramp--; }
        ll = f32(gl * x); lr = f32(gr * x);
        const j = o + done + k;
        L[j] += ll; R[j] += lr;
        if (rs !== 0) { rL[j] += ll * rs; rR[j] += lr * rs; }
        if (cs !== 0) { cL[j] += ll * cs; cR[j] += lr * cs; }
      }
      this.curL = gl; this.curR = gr; this.rampLeft = ramp;
      this.lastL = ll; this.lastR = lr;
      done += m;
      this.blockLeft -= m;
    }
    return done;
  }
}
