// Harmor voice (FL's voice object, 0x3360 bytes): one per part and unison voice.
// Port of TriggerVoice's per-voice setup (0xda2d0, unison loop 0xdaab4..0xdb47c)
// and the voice render 0xe1b60: per control block (plug.blk samples) the
// articulators run, the pitch / partial count / frequencies / phases / timbre are
// (re)computed, the part's unit chain shapes the partial levels, the levels go to
// the sine bank as targets and the bank renders the block; the mono output is
// panned into the two stereo buses (bus 0 = effects input, bus 1 = dry) through
// FL's gain ramps (0x460e20 / 0x460410).
//
// Field comments give the FL voice offsets (V+0x...).

import { exp as lexp, log as llog, sin as lsin, cos as lcos } from './fx-libm';
import { SineBank } from './sinebank';
import { sin32fA21, sin32fA24, randUniform32f, randUniform64f, ln32fA11, exp32fA11 } from './ipp';
import { PlugDsp, PartDsp, SLOTS, K580, noteLog2Hz, INV_LN2, LN2, LN2_1200 } from './core';
import { mulV, mulCI, mulCV, mixV, sumSq, mul4, roundEven, trunc32 } from './vec';
import { ArtPart, ArtVoice, ArtInputs } from './art';
import { GainRamp } from './ramp';
import { vectorSlope32f } from './ipp';
import { applyUnit, blurKernelShape, prismAmount, type UnitCtx } from './units';
import { unitsTrigger, unitChain } from './partials';

const f = Math.fround;
/** G[0xa97148]: lowest partial frequency (C0, Hz). */
export const C0_HZ = f(16.351598739624023);
/** G[0xa97150]: sub-harmonic roll-off scale (0xd9bb0). */
const SUB_ROLL = f(0.008736586198210716);
/** G[0xa97128]: 1 / ln 2 (float32). */
const INV_LN2F = f(1.4426950408889634);
/** Scratch: the part's unit chain (0xca920). */
const UNITS = new Int32Array(12);
/** G[0xa97120]: raised-cosine taper of slots 456..519 (0xc7dd0). */
const TAPER = (() => {
  const t = new Float32Array(64);
  for (let i = 0; i < 64; i++) t[i] = f((lcos((i - 1) * 0.0483321946706122) + 1) * 0.5);
  return t;
})();

/** Shared scratch of the render context (FL REND = voice+0x30) and per-block unit inputs. */
export class RenderCtx implements UnitCtx {
  readonly w20 = new Float32Array(SLOTS * 2 + 8);
  readonly w28 = new Float32Array(SLOTS * 2 + 8);
  readonly d20 = new Float64Array(SLOTS);
  readonly mono: Float32Array;
  /** +0x30 stereo voice buffer (tremolo path) and the fade ramps (+0x20 / +0x28). */
  readonly stereo: Float32Array;
  readonly fw: Float32Array;
  readonly fw2: Float32Array;
  /** +0x7c recompute frequencies. */
  recalc = false;
  /** +0x80 filter mix sign (0 = filter 1 only... see unit 4/5), +0x84 filter unit index, +0x88, +0x8c |filter mix|. */
  fmixSign = 0;
  fmixUnit = 0;
  f88 = 1;
  fmixAmt = 0;
  /** +0x9c resonance oscillator frequency (Hz), +0xa4 / +0xa8 (filter outputs kept per voice). */
  resHz = 0;
  ra4 = 0;
  ra8 = 0;
  /** +0xac resonance oscillator level, +0xb4 envelope gain, +0xb8 slot 0 gain. */
  ac = 0;
  envGain = 1;
  b8 = 1;
  // --- filters fields --- (filters.ts)
  /** REND+0x38 mask gains, +0x58 the filter mix copy; noise seed scratch. */
  readonly w38 = new Float32Array(SLOTS + 8);
  readonly w58 = new Float32Array(SLOTS + 8);
  readonly nseed = new Uint32Array(1);
  constructor(maxBlock: number) {
    this.mono = new Float32Array(maxBlock);
    this.stereo = new Float32Array(maxBlock * 2);
    this.fw = new Float32Array(maxBlock * 2);
    this.fw2 = new Float32Array(maxBlock * 2);
  }
}

/** Per-note data the voice reads (FL TVoiceParams FinalLevels and the note). */
export interface VoiceNote {
  /** InitLevels pitch (100 x key). */
  initPitch: number;
  /** FinalLevels: pan, vol, pitch (cents, 0 = root key), Mod X / Y (fcut / fres). */
  pan: number;
  vol: number;
  pitch: number;
  fcut: number;
  fres: number;
  /** FPV_GetVelocity (velocity / 128) and FPV_GetRelTime (2 x release velocity / 128). */
  vel: number;
  rel: number;
}

export class HVoice {
  readonly sb: SineBank;
  readonly arts = new ArtVoice();
  readonly inp = new ArtInputs();
  part!: PartDsp;
  plug!: PlugDsp;
  ap!: ArtPart;
  note!: VoiceNote;
  /** Unison index. */
  uni = 0;
  /** +0x38 kind (0 normal, 1/2 mono / legato children), +0x3c block countdown (negative = first block), +0x48 predelay countdown, +0x4c first block (1, 2 = after predelay, 0). */
  kind = 0;
  countdown = 0;
  predelay = 0;
  first = 1;
  /** +0x8 velocity, +0x28 held index, +0x64 note pitch (InitLevels, cents). */
  vel = 0;
  held = 0;
  pitch0 = 0;
  /** +0x70 glide lanes (porta / legato): +0x70 steps, +0x90 values = level offsets (pan, vol, pitch, X, Y, velocity, -, -), +0xb0 coefficients; +0x6c linear block count (< 0: exponential); +0x68. */
  readonly gStep = new Float32Array(8);
  readonly gVal = new Float32Array(8);
  readonly gCoef = new Float32Array(8);
  gCount = 0;
  /** +0x24 velocity porta scale. */
  velPorta = 1;
  get o90(): number { return this.gVal[0]; }
  get o94(): number { return this.gVal[1]; }
  get o98(): number { return this.gVal[2]; }
  get o9c(): number { return this.gVal[3]; }
  get oa0(): number { return this.gVal[4]; }
  get oa4(): number { return this.gVal[5]; }
  /** +0xd0 prism amount, +0xd4 cached prism control. */
  prismAmt = 0;
  prismCtl = 2147483648;
  /** +0xd8 randomness gains {ptr, offset, count}. */
  readonly rnd = new Float32Array(SLOTS).fill(1);
  rndOfs = 0;
  rndCount = 0;
  /** +0xe8 tremolo fade-in countdown. */
  fade = 0;
  /** +0x158 / +0x15c random seeds; +0x128 random table (articulator random inputs at +0x820). */
  readonly seed = new Uint32Array(1);
  seed0 = 0;
  readonly rtab = new Float32Array(48);
  /** The random-input table this voice's articulators used (its own or the drawing voice's). */
  usedRtab: Float32Array | null = null;
  /** +0x198 / +0x19c cached timbre mix / pluck mix. */
  tmixC = -1;
  pluckC = -1;
  /** +0x1a0 partial frequencies (Hz, float), +0x1a8 log2 Hz, +0x1b0 timbre levels; +0x1b8 derived level (0 none, 1 Hz, 2 log). */
  readonly hz = new Float32Array(SLOTS);
  readonly logf = new Float32Array(SLOTS);
  readonly tamp = new Float32Array(SLOTS);
  derived = 0;
  /** +0x1bc pitch (cents), +0x1c0 pitch + unison, +0x1c4 cached pitch, +0x1c8 Hz, +0x1cc log2 Hz, +0x1d0 Hz / sr, +0x1d4 glide pitch. */
  pitchC = 0;
  pitchU = 0;
  pitchCache = 2147483648;
  fHz = 0;
  fLog = 0;
  fNorm = 0;
  glide = 0;
  /** +0x1e0, +0x1e8 (float[2]: [1] slot 0 gain). */
  e1e0 = 0;
  /** +0x200 blur kernel, +0x208 / +0x20c blur control, +0x210 kernel norm, +0x214 kernel half width. */
  readonly kern = new Float32Array(SLOTS * 2 + 8);
  blurCtl = -1;
  blurNew = 1;
  blurNorm = 1;
  blurW = 0;
  /** +0x224 state (1 playing .. 6 released .. 9 / 10 dead), +0x228. */
  state = 1;
  i228 = 0;
  /** +0x22c / +0x254 output ramps (bus 0 / bus 1). */
  readonly ramp0 = new GainRamp();
  readonly ramp1 = new GainRamp();
  /** +0x2bc phaser phase (from part+0x5a0), +0x2c0 unison distribution, +0x2c4 unison phase position, +0x2c8 pan, +0x2cc volume, +0x2d0 pitch (cents), +0x2d4 cached, +0x2d8 position, +0x2dc spread. */
  phPh = 0;
  uniMode = 0;
  uniPh = -1;
  uniPanO = 0;
  uniVolO = 1;
  uniCents = 0;
  uniCache = 2147483648;
  uniPosV = 0;
  uniSpread = 0;
  /** +0x2e0 per-partial random detune table (unison Hz mode). */
  readonly uniTab = new Float32Array(SLOTS);
  /** +0x334c.. X / Y / Z and X at trigger (+0x3358). */
  mx = 0; my = 0; mz = 0; mx0 = 0;
  /** +0xf0 declicker attack position, +0xf4 release position (-1 = not releasing), +0xf8 release delay. */
  attPos = 0x7fffffff;
  relPos = -1;
  relDelay = 0;
  /** +0x40 age stamp (head voices: trigger time; unison children: Infinity; released heads: -Infinity side). */
  stamp = Infinity;
  /** Released (Voice_Release seen) and finished. */
  released = false;
  dead = false;
  /** Vibrato phase of this render call (FL's sp+0x78 from part+0x4c); position in the render call. */
  private vibPh = 0;
  private callPos = 0;

  // --- units fields --- (partials.ts; stubs added by the lead to keep the build compiling)
  /** Pluck: per-partial decay coefficients and gains, filled count, on flag, rate and the control it was built for. */
  readonly pluckCoef = new Float32Array(SLOTS);
  readonly pluckGain = new Float32Array(SLOTS);
  pluckFill = 0;
  pluckOn = false;
  pluckRate = -1;
  pluckS = -1;
  /** Harmonic blur (time) state and its reset flag. */
  readonly blurState = new Float32Array(SLOTS);
  blurReset = 1;

  // --- filters fields --- (filters.ts)
  /** V+0x27c / +0x280 smoothed filter frequency targets, V+0x28c / +0x290 filter frequencies (log2 Hz). */
  readonly fTgt = new Float32Array(2);
  readonly fCur = new Float32Array(2);
  /** V+0x294 noise seed, +0x298 cached noise width, +0x2a0 noise phase, +0x2a8 noise rate, +0x2b0 noise scale (double), +0x2b8 phaser key offset. */
  nSeed = 0;
  nWidth = -1;
  nPhase = 0;
  nRate = 0;
  nScale = 0;
  phKey = 0;
  constructor(maxBlock: number) {
    this.sb = new SineBank(SLOTS, maxBlock, sin32fA21, sin32fA24);
  }

  /**
   * TriggerVoice per-voice setup (unison loop body 0xdaab4..0xdb47c). `seed` is
   * TriggerVoice's shared IPP random seed (sp+0x28, advanced by every table it
   * draws), `vseed` this voice's own Mersenne Twister value (V+0x15c), `newRand`
   * FL's sp+0xa8 (the voice draws new random inputs) and `seedCarry` the phase
   * seed of the previous voice (sp+0x70) used when it doesn't.
   */
  trigger(plug: PlugDsp, part: PartDsp, ap: ArtPart, note: VoiceNote, uni: number, seed: Uint32Array, vseed: number,
    newRand: boolean, seedCarry: number, randCount: number, randoms: Float32Array | null, shared: HVoice | null,
    rtabIn: Float32Array | null = null): number {
    this.plug = plug; this.part = part; this.ap = ap; this.note = note; this.uni = uni;
    const n = part.uniN, P = plug.p, o = part.pofs;
    this.kind = 0;
    this.countdown = -plug.blk;
    this.uniMode = part.uniDist;
    this.vel = note.vel;
    this.velPorta = plug.p[778] > 0 ? f(f(1 - note.vel * 0.85) * f(1 - note.vel * 0.85)) : 1;
    this.gStep.fill(0); this.gVal.fill(0); this.gCoef.fill(0); this.gCount = 0;
    this.pitch0 = note.initPitch;
    this.held = 0;
    this.predelay = 0;
    this.state = 1;
    this.released = false;
    this.dead = false;
    this.mx = plug.mod[0]; this.my = plug.mod[1]; this.mz = plug.mod[2]; this.mx0 = plug.mod[3];
    const s10 = n === 1 ? 0.5 : f(uni * part.uniInv1);
    // declicker voice state (0x46c5c0)
    this.attPos = part.declAttLen > 0 ? 0 : 0x7fffffff;
    this.relPos = -1;
    this.relDelay = 0;
    // FL draws one random-input table per TriggerVoice into the drawing voice's buffer (sp+0x78 keeps
    // pointing at it): voices that don't draw read that table
    let rtab = rtabIn ?? this.rtab;
    if (newRand || !rtabIn) { randUniform32f(this.rtab, randCount + 1, 0, 1, seed); rtab = this.rtab; }
    this.usedRtab = rtab;
    this.arts.env[1].stage = 9; this.arts.env[1].mode = 9; // V+0x410 / +0x418
    const velAtt = P[o + 15] !== 0 ? f(2 - 2 * Math.min(note.vel, 1)) : NaN;
    this.arts.trigger(ap, rtab, randCount, s10, velAtt, shared ? shared.arts : null);
    if (this.arts.sharedEnv && shared) this.countdown = -Math.abs(shared.countdown);
    this.first = 1;
    this.uniVolO = part.uniVol;
    if (n === 1) {
      this.uniSpread = 0; this.uniPanO = 0; this.uniPosV = 0; this.uniCents = 0; this.uniPh = -1;
    } else {
      if (P[o + 36] > 0 && ((part.idx + uni) & 1) === 1) this.uniVolO = -this.uniVolO;
      this.uniPh = f(uni * part.uniInv);
      this.uniSpread = f(f(s10 * 2) - 1);
      const pp = f(this.uniSpread * part.uniPan);
      this.uniPanO = pp < -1 ? -1 : pp > 1 ? 1 : pp;
      this.uniPosV = f(part.uniPos[uni]);
      if (this.uniMode === 3 && randoms) this.uniPosV = f(this.uniPosV + randoms[uni]);
      else if (this.uniMode === 4) {
        randUniform32f(this.uniTab, SLOTS, -part.uniInv, part.uniInv, seed);
        for (let i = 0; i < SLOTS; i++) this.uniTab[i] = f(this.uniTab[i] + this.uniPosV);
        this.uniPosV = 1;
      }
      this.uniCents = f(this.uniPosV * part.uniPitch);
    }
    this.i228 = 0;
    this.fade = plug.fadeLen;
    this.seed0 = vseed >>> 0;
    const carry = newRand ? this.seed0 : seedCarry;
    this.seed[0] = carry >>> 0;
    this.nSeed = carry | 0; this.nPhase = 0; this.nWidth = -1; // filters: noise state V+0x294 / +0x2a0 / +0x298 (0xdb188)
    this.e1e0 = plug.f110c;
    unitsTrigger(this);
    // randomness gains (+0xd8): exp(rand * table) over the table's range
    this.rndOfs = part.randOfs; this.rndCount = part.randCount;
    this.rnd.fill(1);
    if (this.rndCount > 0) {
      const r = this.kern;
      randUniform32f(r, this.rndCount, 0, 1, seed);
      for (let i = 0; i < this.rndCount; i++) r[i] = f(part.randTab[this.rndOfs + i] * r[i]);
      exp32fA11(r, this.rnd, this.rndCount, 0, this.rndOfs);
    }
    this.blurCtl = -1;
    this.blurW = 0;
    this.prismCtl = 2147483648;
    this.pitchCache = 2147483648;
    this.uniCache = 2147483648;
    this.tmixC = -1;
    this.pluckC = -1;
    // sine bank init (0x4317c0): lanes cleared, smoothing part+0x228, snap pending (+0x78) unless
    // the declicker is off (+0x4d: then the levels glide in from 0)
    this.sb.reset();
    this.sb.precision = plug.precision;
    this.sb.smooth.fill(part.smooth);
    this.sb.noSnap = part.declick === 0;
    this.sb.snap = true;
    this.sb.freq[0] = 1;
    this.glide = part.pitchSum;
    this.derived = 0;
    this.ramp0.reset(plug.rampCoef);
    this.ramp1.reset(plug.rampCoef);
    return carry;
  }

  /** 0xdfbb0: porta / legato glide from the levels in `rec` (pan, vol, pitch, X, Y, velocity). */
  portaFrom(rec: Float32Array, limit: boolean, all: boolean): void {
    const part = this.part, P = this.plug.p, o = part.pofs, note = this.note;
    let sp = f(part.porta * this.velPorta);
    const S = this.gStep, Vl = this.gVal;
    let X: Float32Array;
    if (sp > 0) { for (let k = 0; k < 8; k++) Vl[k] = f(Vl[k] - S[k]); X = S; } else X = Vl;
    if (!all) { X[0] = 0; X[1] = 0; X[5] = 0; }
    else {
      X[0] = f(f(X[0] + rec[0]) - note.pan);
      X[1] = f(f(X[1] + rec[1]) - note.vol);
      X[5] = f(f(X[5] + rec[5]) - this.vel);
    }
    X[2] = f(f(X[2] + rec[2]) - note.pitch);
    X[3] = f(f(X[3] + rec[3]) - note.fcut);
    X[4] = f(f(X[4] + rec[4]) - note.fres);
    const lim = P[o + 50];
    if (lim > 0 && limit) {
      if (lim < 1200) { if (Math.abs(X[2]) >= lim) X[2] = f((X[2] < 0 ? -1 : 1) * lim); }
      else while (Math.abs(X[2]) > 1250) X[2] = f(X[2] - (X[2] < 0 ? -1200 : 1200));
    }
    if (P[o + 48] !== 0) sp = f(f(sp * Math.abs(X[2])) * 0.0008333333333333334);
    if (sp <= 0) {
      this.gCount = 1 - roundEven(sp);
      const k = f(-1 / this.gCount);
      for (let i = 0; i < 8; i++) S[i] = f(Vl[i] * k);
    } else {
      this.gCount = -0x7fffffff;
      this.gCoef.fill(f(lexp(K580 / (sp * 0.7071067811865476))));
      for (let i = 0; i < 8; i++) Vl[i] = f(Vl[i] + S[i]);
    }
  }

  /** Voice_Release (0xdc1f0). */
  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.stamp !== Infinity) this.stamp -= 9.2e18; // 0xdc418: released heads become the oldest
    const relTime = this.plug.p[this.part.pofs + 16] !== 0 ? this.note.rel : 1;
    this.arts.release(this.ap, relTime);
    if (this.state < 6) this.state = 6;
  }

  /**
   * Render `n` samples (one FL render call) into the interleaved stereo buses
   * at frame offset `off`. Returns false once the voice is dead.
   */
  render(n: number, ctx: RenderCtx, bus0: Float32Array, bus1: Float32Array, off: number, used: boolean[]): boolean {
    if (this.dead) return false;
    const part = this.part, sb = this.sb;
    this.vibPh = part.vibPh;
    this.phPh = f(part.phPhase);
    let done = 0;
    // predelay: silence while it counts down
    if (this.predelay > 0) {
      const k = Math.min(this.predelay, n);
      this.predelay -= k;
      done = k;
      this.vibPh = f(this.vibPh + f(part.vibSpeed * k));
      this.phPh = f(this.phPh + part.phSpeed * k);
    }
    while (done < n) {
      if (this.countdown <= 0) {
        this.block(ctx);
        if (this.predelay > 0) {
          const k = Math.min(this.predelay, n - done);
          this.predelay -= k;
          done += k;
          continue;
        }
      }
      const m = Math.min(this.countdown, n - done);
      sb.render(ctx.mono, m, 0);
      this.declick(ctx.mono, m);
      this.callPos = done;
      this.output(ctx, m, bus0, bus1, off + done, used);
      if (this.first > 0) this.first = 0;
      this.countdown -= m;
      this.vibPh = f(this.vibPh + f(part.vibSpeed * m));
      this.phPh = f(this.phPh + part.phSpeed * m);
      done += m;
    }
    if (this.endCheck()) { this.dead = true; return false; }
    return true;
  }

  /** 0x46c9b0: declicker attack window from the note start, release window after the voice ended. */
  private declick(buf: Float32Array, n: number): void {
    const part = this.part;
    if (this.attPos < part.declAttLen) {
      const k = Math.min(n, part.declAttLen - this.attPos), T = part.declAtt, o = this.attPos;
      for (let i = 0; i < k; i++) buf[i] = f(buf[i] * T[o + i]);
      this.attPos += k;
    }
    if (this.relPos < 0) return;
    let s0 = 0;
    if (this.relDelay > 0) {
      s0 = Math.min(this.relDelay, n);
      this.relDelay -= s0;
      if (s0 >= n) return;
    }
    const len = part.declRelLen, T = part.declRel, o = this.relPos;
    const k = Math.max(0, Math.min(n - s0, len - o));
    for (let i = 0; i < k; i++) buf[s0 + i] = f(buf[s0 + i] * T[o + i]);
    for (let i = s0 + k; i < n; i++) buf[i] = 0;
    this.relPos += n - s0;
  }

  /** 0xdc520 / 0xdc460: the voice ended (or was stolen): start the declicker release, state 9. */
  end(): void {
    if (this.relPos < 0) { this.attPos = 0x7fffffff; this.relPos = 0; this.relDelay = 0; }
    if (this.state < 9) this.state = 9;
  }

  /** End of 0xe1b60 (0xe5afc..0xe5d44): voice end detection; true = killed (state 10). */
  private endCheck(): boolean {
    const ap = this.ap, A = this.arts;
    let done = ap.arts[1].envOn && A.envStage(1) >= 9;
    if (!done) {
      if (this.state < 6) return false;
      if (this.state < 9) {
        const sm = ap.arts[1].smooth;
        if (sm !== 0 && sm !== 1) done = false; // TODO(port): smoothed volume convergence test (V+0x408+0xc8)
        else done = A.envStage(1) >= 9;
        if (done) {
          const L = ap.listB;
          for (let k = 0; L[k] >= 0; k++) {
            const i = L[k], a = ap.arts[i];
            if (a.env.hasArp && A.env[i].stage < 9) { done = false; break; }
            if (a.lfo.hasArp && A.lfo[i].stage < 9) { done = false; break; }
          }
        }
        if (done) this.end();
        return false;
      }
    } else { this.end(); return false; }
    if (this.state < 10) {
      if (this.part.declRelLen <= this.relPos || this.predelay > 0) { this.state = 10; return true; }
    }
    return this.state >= 10;
  }

  private output(ctx: RenderCtx, m: number, bus0: Float32Array, bus1: Float32Array, off: number, used: boolean[]): void {
    const part = this.part, plug = this.plug, note = this.note, A = this.arts.out;
    const lvlPan = f(f(note.pan + this.o90) + this.uniPanO);
    const lvlVol = f(f(part.gain * f(note.vol + this.o94)) * this.uniVolO);
    const mixc = f(f(f(plug.p[part.pofs + 10]) * f(0.001)) * A[2]);
    let pan = f(lvlPan + f(A[0] * 4));
    pan = pan < -1 ? -1 : pan > 1 ? 1 : pan;
    const g = lvlVol;
    this.ramp0.set(pan, f(g * f(1 - Math.abs(mixc))));
    this.ramp1.set(pan, f(g * mixc));
    if (part.side) { this.ramp0.tR = -this.ramp0.tR; this.ramp1.tR = -this.ramp1.tR; }
    // tremolo (part+0x658, 0xe565c..0xe57f4): stereo voice x (1 - w + w * trem), w fading in over 100 ms
    const st = part.tremOn;
    if (st) {
      const S = ctx.stereo, T = part.trem, to = 2 * this.callPos;
      for (let i = 0; i < m; i++) S[2 * i] = S[2 * i + 1] = ctx.mono[i];
      if (this.fade > 0) {
        const W = ctx.fw, W2 = ctx.fw2;
        vectorSlope32f(W, m, f(1 - f(this.fade * plug.fadeStep)), plug.fadeStep);
        for (let i = 0; i < m; i++) if (W[i] > 1) W[i] = 1;
        for (let i = 0; i < m; i++) W2[2 * i] = W2[2 * i + 1] = W[i];
        for (let i = 0; i < 2 * m; i++) {
          const a = f(W2[i] * T[to + i]);
          const b = f(1 - W2[i]);
          S[i] = f(S[i] * f(b + a));
        }
        this.fade -= m;
      } else for (let i = 0; i < 2 * m; i++) S[i] = f(S[i] * T[to + i]);
    }
    for (let b = 0; b < 2; b++) {
      const r = b === 0 ? this.ramp0 : this.ramp1;
      if (this.first > 0) { r.cL = r.tL; r.cR = r.tR; }
      if (r.silent()) continue;
      used[b] = true;
      if (st) r.mixStereo(ctx.stereo, b === 0 ? bus0 : bus1, m, 0, off * 2);
      else r.mixMono(ctx.mono, b === 0 ? bus0 : bus1, m, 0, off * 2);
    }
  }

  /** One control block of 0xe1b60 (0xe1da0 .. 0xe55cc). */
  private block(ctx: RenderCtx): void {
    const plug = this.plug, part = this.part, note = this.note, sb = this.sb, A = this.arts.out, ap = this.ap;
    const P = plug.p, o = part.pofs, inp = this.inp;
    // glide lanes (0xe1db0: linear 0xd9da0 / exponential 0xd9e70)
    if (this.gCount !== 0) {
      const S = this.gStep, Vl = this.gVal, C = this.gCoef;
      if (this.gCount > 0) {
        for (let k = 0; k < 8; k++) Vl[k] = f(Vl[k] + S[k]);
        this.gCount--;
      } else {
        for (let k = 0; k < 8; k++) S[k] = f(S[k] * C[k]);
        for (let k = 0; k < 8; k++) Vl[k] = f(f(f(Vl[k] - S[k]) * C[k]) + S[k]);
      }
    }
    // glide (V+0x1d4)
    if (this.first > 0) this.glide = f(part.pitchSum);
    else this.glide = f(part.pitchSum + f(this.glide - part.pitchSum) * plug.glide);
    const pitch7c = f(note.pitch + this.glide);
    // 0xd9d00: the voice's X / Y / Z (and X reference) follow the globals
    {
      const T = plug.mod, K = plug.modK;
      const sm = (v: number, t: number, c: number): number => f(f(f(t + c) + f(f(v - t) * c)) - c);
      this.mx = sm(this.mx, T[0], K[0]); this.my = sm(this.my, T[1], K[1]);
      this.mz = sm(this.mz, T[2], K[2]); this.mx0 = sm(this.mx0, T[3], K[3]);
    }
    // articulator inputs (sp+0x118)
    const M = inp.map;
    M[0] = f((note.pitch + part.mainPitch + this.o98 + 6000) * 8.333333333333333e-5);
    M[1] = f(this.vel + this.oa4);
    M[2] = f(this.mx + f(f(note.fcut + this.o9c) * 0.5));
    M[3] = f(this.my + f(f(note.fres + this.oa0) * 0.5));
    M[4] = this.mz;
    M[7] = f(this.held * 0.03125);
    const xs = f(1 - Math.abs(f(this.mx - this.mx0)));
    M[8] = f(1 - f(xs * xs));
    this.arts.process(ap, ap.listA, inp);
    if (this.first > 0) {
      this.arts.snap(ap, ap.listA);
      const pd = f(A[42] * part.predelay);
      if (pd !== 0 && this.first === 1) {
        this.first = 2;
        this.predelay = Math.abs(roundEven(pd));
        return;
      }
      this.arts.applyGlobal(ap, P[o + 14] !== 0 ? this.vel : 0);
    }
    if (this.countdown < 0) { this.countdown = -this.countdown; inp.first = 0; }
    else { this.countdown = plug.blk; inp.first = 1; }
    inp.lfoAmt = f(A[38] * plug.lfoAmt);
    inp.lfoSpeed = A[39];
    this.arts.process(ap, ap.listB, inp);
    if (this.first > 0) this.arts.snap(ap, ap.listB);
    // pitch (V+0x1bc)
    this.pitchC = f(pitch7c + this.o98);
    if (P[o + 45] !== 0) this.pitchC = f(this.pitchC + lsin(f(this.vibPh * 6.2831854820251465)) * part.vibDepth * A[25]);
    this.blurKernel();
    const uniC = f(f(this.uniCents * A[26]) * A[26]);
    this.pitchC = f(this.pitchC + f(part.pitchAmt * A[24]));
    // prism amount (V+0xd0)
    const prismCtl = f(part.prism * A[23]);
    let recalc = false;
    if (prismCtl !== this.prismCtl) {
      this.prismCtl = prismCtl;
      this.prismAmt = prismAmount(part, prismCtl);
      recalc = true;
    } else recalc = this.pitchC !== this.pitchCache || uniC !== this.uniCache;
    ctx.recalc = recalc;
    const oldCount = sb.count;
    if (recalc) {
      this.pitchCache = this.pitchC;
      this.pitchU = f(this.pitchC + uniC);
      this.fLog = f(noteLog2Hz(this.pitchC * 0.009999999776482582 + 60));
      this.fHz = f(lexp(this.fLog * LN2));
      this.fNorm = f(this.fHz / plug.sr);
      this.uniCache = uniC;
      this.derived = 0;
      let cnt = Math.min(this.partialCount(), SLOTS);
      cnt = (cnt + 7) & ~7;
      if (sb.count < cnt) sb.setCount(cnt);
      if (sb.count !== oldCount) { this.tmixC = -1; this.pluckC = -1; }
      const N = sb.count;
      let fm = this.fNorm;
      const uniTab = this.uniMode === 4;
      if (this.uniMode < 4 && !part.uniPitchTab) fm = f(fm * f(lexp(uniC * 0.0008333333333333334 * LN2)));
      const F = sb.freq, R = part.ratios;
      for (let i = 0; i < N; i++) F[i] = R[i] * fm;
      if (part.pitchMode === 0) for (let i = 0; i < N; i++) if (F[i] > plug.freqCeil) F[i] = plug.freqCeil;
      if (uniTab) {
        // 0xe368c: freqs += table * k (x the unison pitch map table part+0x70 when there is one)
        const k = f(f(uniC * f(0.00666666683)) * this.fNorm);
        const W = ctx.w20, T = part.uniPitchTab;
        mulCV(this.uniTab, W, N, k);
        if (T) mulV(T, W, N);
        for (let i = 0; i < N; i++) F[i] += W[i];
      } else if (part.uniPitchTab) {
        // 0xe3704: freqs *= exp(map table * uniC / 1200 * ln 2) (plug+0x1160 vector exp)
        const W = ctx.w20, E = ctx.w28;
        mulCV(part.uniPitchTab, W, N, f(uniC * 0.0008333333333333334 * LN2));
        exp32fA11(W, E, N);
        for (let i = 0; i < N; i++) F[i] *= E[i];
      }
      if (this.first > 0) this.initPhases();
    }
    // timbre (0xdca70)
    this.timbreMix();
    const N = sb.count, amps = sb.amps;
    for (let i = 0; i < N; i++) amps[i] = this.tamp[i];
    // filter mix, envelope gain
    let fm = f(f(f(P[o + 74]) * f(0.001)) * A[14]);
    fm = fm < -1 ? -1 : fm > 1 ? 1 : fm;
    ctx.fmixAmt = Math.abs(fm);
    ctx.fmixSign = fm !== 1 ? (fm < 0 || Object.is(fm, -0) ? -1 : 1) : 0;
    ctx.f88 = 1;
    ctx.fmixUnit = part.b64;
    ctx.envGain = f(f(A[1] * A[1]) * part.envVol);
    ctx.b8 = 1;
    ctx.ac = 0;
    // unit chain (part+0xaa0)
    const nu = unitChain(part, UNITS);
    for (let u = 0; u < nu; u++) applyUnit(UNITS[u], this, ctx);
    recalc = ctx.recalc; // REND+0x7c (set by the phaser's frequency mode)
    if (this.derived < 2) this.deriveLog();
    // sub-harmonic roll-off (0xd9bb0)
    if (part.subMode > 0) for (let i = 0; i < 4; i++) {
      let s = f(this.hz[i] * SUB_ROLL);
      if (s > 1) s = 1;
      const s2 = f(s * s);
      amps[i] = f(amps[i] * f(s2 * s2));
    }
    // slot 0: resonance oscillator
    amps[0] = f(f(f(part.subAmp[0] * ctx.ac) * this.pluckGain[1]) * ctx.b8); // [V+0x1e8][1]: the pluck gains
    const r0 = f(ctx.resHz * part.resFreq);
    this.hz[0] = r0;
    this.logf[0] = f(llog(r0) * INV_LN2F); // 0xe5228: double log x f32(1 / ln 2)
    const r0n = r0 * (1 / plug.sr); // 0xe525c: x (1 / sr)
    if (sb.freq[0] !== r0n) {
      sb.freq[0] = r0n; sb.countdown[0] = 0; sb.dirty[0] = 1;
      if (!recalc && part.rampK !== 0) sb.smooth[sb.slot[0]] = f(lexp(f(r0 * part.rampK)));
    }
    if (N > 456) for (let i = 456; i < N; i++) amps[i] = f(amps[i] * TAPER[i - 456]);
    if (recalc) {
      if (part.pitchMode === 0) for (let i = 0; i < N; i++) if (sb.freq[i] > plug.freqCeil) sb.freq[i] = plug.freqCeil;
      sb.invalidate();
    }
    // main shape (0xcbb40 on part+0x298)
    part.shapeGains(this.logf, ctx.w20, N);
    mulV(ctx.w20, amps, N);
    // auto gain (0x2aa8)
    if (P[o + 13] !== 0) {
      const s = sumSq(amps, N);
      let g = 4096;
      if (s > 0) { g = f(Math.sqrt(f(1.6428421497344971 / s))); g = g < 0.000244140625 ? 0.000244140625 : g > 4096 ? 4096 : g; }
      ctx.envGain = f(ctx.envGain * f(f(f(part.autoGain * g) + 1) - part.autoGain));
    }
    if (ctx.envGain !== 1) mulCI(amps, N, ctx.envGain);
    // targets (0x432030), with per-partial ramping coefficients exp(Hz * part+0x22c) after a frequency change (0x432100)
    if (recalc && part.rampK !== 0) {
      const sm = ctx.w28;
      mulCV(this.hz, ctx.w20, N, part.rampK);
      exp32fA11(ctx.w20, sm, N);
      sb.setTargets(amps, sm);
    } else sb.setTargets(amps, null);
  }

  /** 0xe6690 partial count. */
  private partialCount(): number {
    const part = this.part;
    let x: number;
    if (part.pitchMode === 0) x = f((part.p198 - llog(this.fHz) * INV_LN2) * part.p19c);
    else x = f(part.p198 / this.fHz);
    if (part.prismMode > 0 && this.prismAmt !== 0) {
      let d = f(1 - Math.abs(this.prismAmt));
      if (d <= 0.009999999776482582) d = f(0.009999999776482582);
      x = f(x / d);
    }
    let n = roundEven(x) + this.blurW + 1;
    if (n < 1) n = 1;
    return Math.min(n + 4, this.plug.maxSlots);
  }

  /** Starting phases (first block, 0xe37bc..0xe3a74): phase table, offset, randomness. */
  private initPhases(): void {
    const part = this.part, sb = this.sb, ph = sb.phase, F = sb.freq;
    let rand = part.phaseRand;
    let ofs: number;
    if (this.uniPh === -1) ofs = part.phaseOfs;
    else {
      let s = f(part.uniPhase * this.arts.out[41]);
      if (this.uniMode === 4) s = -Math.abs(s);
      if (s > 0) {
        if (s === 1) { this.seed[0] = this.seed0; rand = -1; ofs = 0; }
        else {
          const a = lexp(f(s * 16) * LN2), b = lexp(this.uniCents * LN2_1200);
          const d = (a * 2 - 2) * b;
          ofs = part.phaseOfs + d - roundEven(d);
        }
      } else ofs = part.phaseOfs + this.uniPh * s;
    }
    const f4 = F[4];
    if (rand < 0) {
      randUniform64f(ph, SLOTS, 0, -rand, this.seed);
      for (let i = 0; i < SLOTS; i++) ph[i] += part.phaseTab[i];
    } else {
      for (let i = 0; i < SLOTS; i++) ph[i] = part.phaseTab[i];
      ofs += rand * frac(f4 * 277 * part.seed); // 0xcf60 = frac; part+0x128 = the part's sample counter
    }
    if (ofs !== 0 && f4 > 0) {
      const k = ofs / f4;
      for (let i = 0; i < SLOTS; i++) ph[i] += F[i] * k;
    }
    // 0xda260: slots 0 / 1 (and 2 / 3 with sub-harmonics below the fundamental) start at phase 0
    ph[0] = 0; ph[1] = 0;
    if (part.subMode > 0) { ph[2] = 0; ph[3] = 0; }
  }

  /** 0xdca70: timbre 1 / 2 mix into tamp (+0x1b0) and the sub-harmonic levels (0xd9b60). */
  private timbreMix(): void {
    const part = this.part, N = this.sb.count;
    let mix = f(part.tmix * this.arts.out[3]);
    mix = mix < 0 ? 0 : mix >= 1 ? 1 : mix;
    if (part.blend === 5) {
      if (mix !== this.pluckC) { this.blurNew = -1; this.pluckC = mix; }
      mix = 0;
    }
    if (mix === this.tmixC) return;
    this.tmixC = mix;
    if (mix <= 0) this.tamp.set(part.t1.subarray(0, N));
    else if (mix === 1) this.tamp.set(part.t2.subarray(0, N));
    else mixV((N + 7) >> 3, part.t1, part.t2, this.tamp, mix, f(1 - mix));
    mul4(part.subAmp, this.tamp);
  }

  /** 0xe6c90: partial Hz = max(f32(f) * sr, C0). */
  deriveHz(): void {
    const N = this.sb.count, F = this.sb.freq, sr = f(this.plug.sr);
    for (let i = 0; i < N; i++) { const v = f(f(F[i]) * sr); this.hz[i] = v > C0_HZ ? v : C0_HZ; }
    this.derived = 1;
  }

  /** 0xe6d50: log2 Hz (ln through the precision's Ln, times 1 / ln 2 in float32). */
  deriveLog(): void {
    if (this.derived < 1) this.deriveHz();
    const N = this.sb.count;
    ln32fA11(this.hz, this.logf, N); // plug+0x1168 (A11 / A24: the same vForce routine on macOS)
    mulCI(this.logf, N, INV_LN2F);
    this.derived = 2;
  }

  /** Harmonic blur control (+0x208 / +0x20c / +0x214, 0xe25b8..0xe29c0). */
  private blurKernel(): void {
    const part = this.part, hb = this.plug.p[part.pofs + 23];
    let c: number;
    if (hb === 0) c = 1;
    else {
      const s = f(f(hb * this.arts.out[22]) * 0.0001);
      c = f(1 + f(lexp(s * 2.8332133440562162) - 1) * 15.9375); // 0xe2620: e - 1 rounds once
    }
    if (c === this.blurCtl) return;
    this.blurCtl = c;
    const w = Math.min(Math.ceil(c) | 1, 0x101) >> 1; // 0x1681e0 = Ceil
    if (w !== this.blurW) { this.blurW = w; this.pitchCache = 2147483648; }
    if (w > 0) this.blurNorm = blurKernelShape(this.kern, w, c, part);
  }
}

/** 0xcf60: Frac (x - Int(x)). */
function frac(x: number): number {
  return x - Math.trunc(x);
}
