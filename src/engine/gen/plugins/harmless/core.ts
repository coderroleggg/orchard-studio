// Harmless's engine core: the plugin state FL's ProcessParam (0x6a070) derives
// from the parameters, the voices (TriggerVoice 0x6cc30, voice render 0x6ed10,
// release 0x6db70, kill 0x6de10 / 0x6dd50) and Gen_Render (0x72f90), ported
// from FL Studio 2026's Harmless_x64.dylib (arm64 slice; addresses are that
// binary's). Field comments give FL's offsets: PL+x on the plugin, V+x on a
// voice. Float32 operations are rounded after every step (f32) as FL's code
// does; doubles stay doubles. See docs/research/gen/harmless.md.

import {
  abs32f, add64fI, addC32fI, convert32f64f, convert64f32f, exp32f, fma32, ln32f, mul32f, mul32fI, mulC32f,
  mulC32fI, powx32f, randUniform32f, randUniform64f, sin32fA21, sum32f, thresholdGT32fI, thresholdGTVal32fI,
  thresholdLT32fI, thresholdLTVal32fI, vectorSlope32f,
} from '../harmor/ipp';
import { Curve, buildCurve, mapClamped, mapPeriodic } from './curves';
import {
  INV_LN2, INV_LN2F, LN001, LN11F, LN2, LN2_1200, LN2_12, LN3F, LOG2_440, TINY, TWO_PI_F, bitsF, cos, exp, f32, fbits,
  frac, law11, law3, log, rint, sin,
} from './fl';
import { cosf, sinf } from '../poizone/applemath';
import { HARMONIZER, NHARM, NOSC, UNISON_TABLE, baseRatios, globalTables, timbreOf } from './tables';
import { ToneBank } from './tonebank';
import { tone32fc } from './tone';
import { MersenneTwister } from './mt';

/** What a voice reads from FL's TVoiceParams (InitLevels / FinalLevels) and FPV_ queries. */
export interface HlNoteLevels {
  /** FinalLevels: pan -1..1, vol (FL's float), pitch in cents (0 = C5 at the root), Mod X / Y. */
  pan: number;
  vol: number;
  pitch: number;
  fcut: number;
  fres: number;
}

/** A voice's slope shaping record (PL+0x710 attack, PL+0x71c decay): {k0, 1/|k0|, ln(|k0| + 1)} (0x1aaff0). */
class Slope {
  k0 = 0;
  k1 = 0;
  k2 = 0;
  set(k: number): void {
    this.k0 = f32(k);
    if (this.k0 !== 0) {
      this.k1 = f32(1 / Math.abs(this.k0));
      this.k2 = f32(log(f32(Math.abs(this.k0) + 1)));
    }
  }
  /** The shaped envelope (voice render 0x6f050). */
  shape(e: number): number {
    if (this.k0 === 0) return e;
    if (fbits(this.k0) >= 0) return 1 - (exp((1 - e) * this.k2) - 1) * this.k1;
    return (exp(e * this.k2) - 1) * this.k1;
  }
}

/** FL's ramp record (0x1a4ba0 / 0x1a4b60 / 0x1a4c40): one-pole follower with rise / fall coefficients. */
class Ramp {
  up = 0;
  down = 0;
  state = 0;
  /** 0x1a4ba0: t <= 0 instant, else to 1 % in max(t, 1) samples. */
  setTime(t: number): void {
    if (!(t > 0)) { this.up = 0; this.down = 0; return; }
    if (!(t > 1)) t = 1;
    this.up = exp(LN001 / t);
    this.down = this.up;
  }
  /** 0x1a4b60: hold. */
  hold(): void {
    this.up = 1;
    this.down = 1;
  }
  /** 0x1a4c40: buf[i] = f32(state), following buf[i]. */
  run(buf: Float32Array, n: number, off: number): void {
    let s = this.state;
    for (let i = 0; i < n; i++) {
      const x = buf[off + i];
      if (x > s) s = x + (s - x) * this.up;
      else s = x + (s - x) * this.down;
      buf[off + i] = f32(s);
    }
    if (Math.abs(s) < 5.960464477539063e-8) s = 0;
    this.state = s;
  }
}

/** FL's ComputeLRVol (FLEngine 0x3a8420, circular law) with float32 steps. */
function computeLRVol(pan: number, vol: number, out: Float32Array, o: number): void {
  let p = f32(pan);
  if (!(p >= -1)) p = -1;
  else if (p > 1) p = 1;
  const a = f32(f32(p + 1) * 0.7853981633974483);
  out[o] = f32(cosf(a) * vol);
  out[o + 1] = f32(sinf(a) * vol);
}

/** Per-render scratch (FL's TRenderer buffers R+0x18 .. R+0x38). */
export class Scratch {
  readonly r18: Float32Array;
  readonly r20: Float32Array;
  readonly r28: Float32Array;
  readonly r30: Float32Array;
  readonly mix: Float32Array;
  readonly d20: Float64Array;
  readonly frac: Float32Array;
  constructor(maxBlock: number) {
    const m = Math.max(0x21c, maxBlock) * 2 + 16;
    this.r18 = new Float32Array(m);
    this.r20 = new Float32Array(m);
    this.r28 = new Float32Array(m);
    this.r30 = new Float32Array(m);
    this.mix = new Float32Array(m);
    this.d20 = new Float64Array(m);
    this.frac = new Float32Array(m);
  }
}

/** 3.4e38: the "not yet" marker (V+0x1b0, the cutoff voice's track). */
const FLAG_UNSET = bitsF(0x7f7fc99e);
/** Voice fields FL's swap (0x6e7b0) leaves in place (the first 0x28 bytes; relTime is the host's per-tag answer). */
const KEPT = new Set(['lv', 'vel', 'tag', 't0', 'rel', 'noteId', 'relTime']);

export class HlVoice {
  /** V+0x0 TVoiceParams: the note's levels (read every render). */
  lv: HlNoteLevels = { pan: 0, vol: 1, pitch: 0, fcut: 0, fres: 0 };
  /** V+0x8 velocity (FPV_GetVelocity, <= 1), V+0x10 host tag (note id), V+0x18 start sample, V+0x20 keyboard note. */
  vel = 0;
  tag = 0;
  t0 = 0;
  /** V+0x24 velocity / release factor for the porta time. */
  rel = 1;
  /** V+0x28 type: 0 sounding, 1 colour 16 filter note, 2 mono note (silent, glides the sounding voice). */
  type = 0;
  /** V+0x2c samples to the next control step. */
  countdown = 0;
  /** V+0x30 age for stealing (Infinity = released / linked). */
  age = Infinity;
  /** V+0x38 first render, V+0x3c colour, V+0x40 output written. */
  first = true;
  color = 0;
  hasAudio = false;
  /** V+0x44 linear glide factor, V+0x48 exponential glide factor, V+0x4c glide steps (> 0 linear, < 0 exponential). */
  glideLin = 0;
  glideExp = 0;
  glideN = 0;
  /** V+0x50..0x64 glide offsets: pan, vol, pitch, Mod X, Mod Y, velocity; V+0x68 linear increments. */
  readonly ofs = new Float32Array(6);
  readonly inc = new Float32Array(6);
  /** V+0x80 tremolo fade-in samples. */
  tremN = 0;
  /** V+0xa0 next unison voice, V+0xa8 the note's first voice, V+0xb0 linked count / -1. */
  next: HlVoice | null = null;
  master: HlVoice | null = null;
  linked = 0;
  /** V+0xb8 LFO phase (cycles), V+0xc0 / 0xc4 LFO value bipolar / unipolar, V+0xc8 LFO fade-in, V+0xcc random. */
  lfoPhase = 0;
  lfo = 0;
  lfoU = 0;
  lfoAtt = 0;
  rand = 0;
  /** V+0xd0 the sine bank, V+0xd8 random seed. */
  readonly bank: ToneBank;
  readonly seed = new Uint32Array(1);
  /** V+0xe0 harmonic frequencies (Hz), V+0xe8 log2, V+0xf0 amplitudes, V+0x110 pluck gains, V+0x118 pluck decay. */
  readonly hz = new Float32Array(0x21c + 8);
  readonly lhz = new Float32Array(0x21c + 8);
  readonly amps = new Float32Array(0x21c + 8);
  readonly pluckG = new Float32Array(0x21c + 8);
  readonly pluckD = new Float32Array(0x21c + 8);
  /** V+0xf8 pitch of the last frequency update (float bits), V+0xfc frequency (Hz), V+0x100 log2 frequency, V+0x104 vibrato fade-in. */
  lastPitch = 0;
  freq = 0;
  oct = 0;
  vibAtt = 0;
  /** V+0x108 pluck steps, V+0x10c pluck harmonics initialised, V+0x120 pluck set-up due, V+0x121 pluck on. */
  pluckN = 0;
  pluckInit = 0;
  pluckDue = true;
  pluckOn = false;
  /** Volume envelope: V+0x124 stage, V+0x128 position, V+0x12c end, V+0x130 attack slope, V+0x138 last value. */
  stage = 1;
  pos = 0;
  end = 0;
  slope = 0;
  envLast = 0;
  /** V+0x13c / 0x140 gains (ComputeLRVol), V+0x144 / 0x148 the ramp's current gains. */
  readonly gains = new Float32Array(4);
  /** V+0x150 envelope smoother, V+0x178 decay / release follower. */
  readonly rampA = new Ramp();
  readonly rampB = new Ramp();
  /** V+0x1a0 cutoff (smoothed), V+0x1a4 resonance, V+0x1a8 filter envelope, V+0x1ac its rate, V+0x1b0 tracked cutoff. */
  cut = 0;
  res = 0;
  fenv = 0;
  fenvRate = 0;
  track = 0;
  /** V+0x1b8: the slope record in use (attack, then decay). */
  slopeRec: Slope;
  /** The host's FPV_GetRelTime for the note (2 - 2 * release velocity), read when the release starts. */
  relTime = 1;
  /** V+0x1c0 noise seed, V+0x1c8 noise phase. */
  readonly noiseSeed = new Uint32Array(1);
  noisePhase = 0;
  /** V+0x1d0 key to phaser offset, unison: V+0x1d4 phase, 0x1d8 pan, 0x1dc gain, 0x1e0 detune, 0x1e4 attack factor, 0x1e8 LFO phase offset, 0x1ec position x table, 0x1f0 position / 128. */
  phKey = 0;
  uPhase = 0.5;
  uPan = 0;
  uGain = 1;
  uDetune = 0;
  uAtt = 1;
  uLfo = 0;
  uPos2 = 0;
  uPos = 0;
  /** V+0x98 the voice's interleaved stereo output. */
  readonly out: Float32Array;
  /** The note this voice plays (Orchard: note id), released flag for the host side. */
  noteId = -1;

  constructor(maxBlock: number, attack: Slope) {
    this.bank = new ToneBank(maxBlock, sin32fA21, sin32fA21);
    this.out = new Float32Array(maxBlock * 2);
    this.slopeRec = attack;
  }
}

/**
 * FPV_GetVelocity (FLEngine 0x42d0b4) of a note: 0.78125 ln(10 InitLevels.Vol + 1) / ln 11 in float, the
 * velocity a plugin gets back from FL's velocity law (not exactly velocity / 128: 120 -> 0.937499..).
 */
export function flVelocity(initVol: number): number {
  const s = f32(f32(f32(initVol) * 10) + 1);
  const r = f32(log(s) * f32(1 / 2.397895336151123));
  return f32(r * 0.78125);
}

export class HlCore {
  readonly sr: number;
  readonly maxBlock: number;
  /** x[PL+0xd0]: the sample-rate record: +0x8 rate, +0x20 1 / rate, +0x28 rate / 44100, +0x3c ramp limit. */
  readonly invSr: number;
  readonly srRatio: number;
  readonly rampMax: number;
  /** PL+0x138 raw parameters. */
  readonly P = new Int32Array(100);
  /** "Multithreaded": FL renders the voices of a block in parallel, so a voice's fade-out
   * (kill) reaches the other voices of its note from the next block on. */
  threaded = true;
  private readonly pendingKills: HlVoice[] = [];
  private deferKills = false;
  /** Extra controls: filter / res / phaser / comp type, timbre, threaded, quality. */
  filterType = 4;
  resType = 0;
  phaserType = 0;
  compType = 0;
  timbre = 0;
  quality = 0;
  /** PL+0x598 custom timbre (n amps then n phases) or null. */
  custom: Float32Array | null = null;

  // ---- derived state (PL+...)
  period = 88; // 0x2d8
  tempo = 120; // 0x2dc
  maxFreq = 17000; // 0x2e0
  mainPitchC = -1200; // 0x2ec
  pitchLfo = 0; // 0x2f0
  mainVol = 0; // 0x2f4
  vibPhase = 0; // 0x320
  vibRate = 0; // 0x324
  vibFade = 0; // 0x328
  vibDepth = 0; // 0x32c
  sumHint = 1; // 0x334
  bankPrecision = 0; // 0x338
  counter = 0; // 0x340 (int64)
  cutoffVoice: HlVoice | null = null; // 0x348
  portaTime = 0; // 0x558
  lfoPhase = 0; // 0x560
  lfoRate = 0; // 0x568
  lfoAttRate = 0; // 0x570
  lfoPitchOfs = 1200; // 0x574
  lfoShape = 0; // 0x578
  grit = 0; // 0x5bc
  phaseRand = 0; // 0x5c8
  counter32 = 0; // 0x5cc
  uniOrder = 1; // 0x5d0
  uniPitch = 0; // 0x5d4
  uniPhase = 0; // 0x5d8
  uniGain = 1; // 0x5dc
  attackMin = 0; // 0x5e0
  volA = 0; // 0x5e8
  volD = -1; // 0x5f0
  volR = 0; // 0x5f8
  killThresh = 0; // 0x600
  killFade = 0; // 0x604
  bankSmooth = 0; // 0x608
  lowProt = 0; // 0x60c
  pluckDec = -1; // 0x610
  pluckBase = 0; // 0x618
  pluckDelayMin = 0; // 0x620
  readonly eq = new Float32Array(6); // 0x62c..0x640
  maskMix = 0; // 0x624
  maskMixLfo = 0; // 0x628
  fenvA = 0; // 0x648
  fenvD = 0; // 0x650
  adaptive = false; // 0x658
  fenvAmt = 0; // 0x6b4
  fLfo = 0; // 0x6b8
  lowHz = 0; // 0x6bc
  highHz = 17000; // 0x6c0
  lo = 0; // 0x6c4
  hi = 0; // 0x6c8
  range = 0; // 0x6cc
  invRange = 0; // 0x6d0
  mid = 0; // 0x6d4
  halfRange = 0; // 0x6d8
  keyFcut = 0; // 0x6dc
  fcut = 0; // 0x6e0
  cutSmooth = 0; // 0x6e4
  trackSmooth = 0; // 0x6e8
  cutoffOfs = 0; // 0x6ec
  resOfsRatio = 1; // 0x6f0
  resOfsOct = 0; // 0x6f4
  fWidth = 100; // 0x6f8
  resWidth = 1024; // 0x6fc
  resK = -0.125; // 0x700
  readonly attackSlope = new Slope(); // 0x710
  readonly decaySlope = new Slope(); // 0x71c
  noiseRate = 0; // 0x728
  noiseLen = 0; // 0x730
  keyTrackOfs = -7; // 0x708
  phMotion = 0; // 0x760
  phMotionRate = 0; // 0x768
  tempoRate = 0; // 0x770
  phOfsLfo = 0; // 0x778
  phWidthLfo = 0; // 0x77c
  phWidth = 0; // 0x780
  hzWidth = 0; // 0x784
  hzWidthLfo = 0; // 0x788
  hzStrength = 0; // 0x78c
  tremDepth = 0; // 0x7ac
  tremCur = 0; // 0x7b0
  tremRate = 0; // 0x7b4
  tremFadeStep = 0; // 0x7b8
  tremFadeLen = 0; // 0x7bc
  tremBuf: Float32Array | null = null; // 0x7c0
  /** The tremolo tone's phase ([sp] of Gen_Render, recomputed from the sample counter every call). */
  private readonly tremPhase = new Float32Array(1);

  /** PL+0x7a0 harmonic mask (12), PL+0x588 timbre amps, PL+0x580 after EQ, PL+0x590 [self-osc, sub1, sub3, sub4]. */
  readonly mask = new Float32Array(12);
  readonly timbreAmps = new Float32Array(NOSC);
  readonly eqAmps = new Float32Array(NOSC);
  readonly subs = new Float32Array(4);
  /** PL+0x5a0 ratios, PL+0x5a8 timbre phases, PL+0x5b0 grittiness sines. */
  readonly ratios = baseRatios();
  readonly phases = new Float64Array(NOSC);
  readonly gritSin = new Float64Array(NOSC);
  eqDirty = true; // 0x5b8
  detuneDirty = true; // 0x5b9
  /** PL+0x660 filter, 0x688 resonance, 0x738 phaser curves. */
  readonly fCurve = new Curve();
  readonly rCurve = new Curve();
  readonly pCurve = new Curve();
  /** PL+0x350 + 32 c: per colour (mono / porta slot) the sounding voice and the last levels (pan, vol, pitch, Mod X, Mod Y, velocity). */
  readonly slotVoice: (HlVoice | null)[] = new Array(16).fill(null);
  readonly slotLv: Float32Array[] = Array.from({ length: 16 }, () => new Float32Array(6));
  readonly slotSet = new Uint8Array(16);
  /** PL+0x2c8 voices, PL+0x2d0 free voices. */
  readonly voices: HlVoice[] = [];
  private readonly free: HlVoice[] = [];
  /** PL+0xe4 max polyphony (FPE_MaxPoly, 0 = none). */
  maxPoly = 0;
  /** PL+0x550 FL's Mersenne twister. */
  readonly mt: MersenneTwister;
  readonly scratch: Scratch;
  private readonly tmpT = new Float32Array(2);
  private readonly tmp528 = new Float32Array(NOSC + 8);
  private readonly tmp528d = new Float64Array(NOSC + 8);
  private readonly tones = new Float32Array(24);
  private readonly tones2 = new Float32Array(24);

  constructor(sr: number, maxBlock: number, seed: number) {
    this.sr = sr;
    this.maxBlock = maxBlock;
    this.invSr = 1 / sr;
    // the host object's +0x28 factor: 44100 / sr (so the control period gets shorter at higher rates)
    this.srRatio = 44100 / sr;
    this.rampMax = f32(0.001 * 44100 / sr);
    this.mt = new MersenneTwister(seed);
    this.scratch = new Scratch(maxBlock);
    globalTables();
    this.lowHz = f32(440 * exp((26 - 57) * LN2_12));
    this.killThresh = f32(exp(f32(-80 * f32(0.1151292546497023))));
    for (let i = 0; i < 8; i++) this.free.push(new HlVoice(maxBlock, this.attackSlope));
  }

  // ------------------------------------------------------------------ parameters

  /** The whole state; FL order: extras (combo handlers), then ProcessParam 0..99. */
  setState(P: ArrayLike<number>, ex: { filterType: number; resType: number; phaserType: number; compType: number; timbre: number; quality: number; threaded?: number }, custom: Float32Array | null): void {
    const first = this.fCurve.type === 0x7fffffff;
    this.threaded = (ex.threaded ?? 1) > 0;
    let timbreChanged = first || ex.timbre !== this.timbre || custom !== this.custom;
    const qualityChanged = first || ex.quality !== this.quality;
    this.timbre = ex.timbre;
    this.custom = custom;
    this.compType = ex.compType;
    if (qualityChanged) this.setQuality(ex.quality);
    const curvesChanged = first || ex.filterType !== this.filterType || ex.resType !== this.resType || ex.phaserType !== this.phaserType;
    this.filterType = ex.filterType;
    this.resType = ex.resType;
    this.phaserType = ex.phaserType;
    const changed: number[] = [];
    for (let i = 0; i < 100; i++) {
      const v = P[i] | 0;
      if (first || this.P[i] !== v || qualityChanged) { this.P[i] = v; changed.push(i); }
    }
    if (curvesChanged) {
      if (this.fCurve.type !== this.filterType) { buildCurve(this.fCurve, this.filterType); this.fCurve.mode = this.quality; this.filterRange(); }
      buildCurve(this.rCurve, this.resType + 100); this.rCurve.mode = this.quality;
      buildCurve(this.pCurve, this.phaserType + 200); this.pCurve.mode = this.quality;
    }
    if (timbreChanged) { this.computeTimbre(); timbreChanged = false; }
    for (const i of changed) this.param(i);
  }

  /** 0x69e60 (quality) with 0x69b70 (sample-rate set-up). */
  private setQuality(q: number): void {
    this.quality = Math.max(0, Math.min(2, q | 0));
    const tab = [88, 44, 8];
    let per = (rint(tab[this.quality] * 0.25 * this.srRatio) | 0) << 2;
    if (per < 4) per = 4;
    this.period = per;
    const sr = this.sr;
    this.killFade = rint(0.03 * sr) | 0;
    this.bankSmooth = f32(exp(LN001 / (0.01 * sr)));
    this.cutSmooth = f32(exp(LN001 / ((0.1 * sr) / per)));
    this.trackSmooth = f32(exp(LN001 / ((1.25 * sr) / per)));
    this.pluckBase = LN001 * per * this.invSr;
    this.pluckDelayMin = 1 - (rint((0.002 * sr) / per) | 0);
    this.attackMin = 0.2 * sr;
    this.vibRate = f32(6 / sr);
    this.vibFade = f32(3 / sr);
    this.tremRate = f32(2.5 / f32(sr));
    this.tremFadeLen = rint(0.1 * sr) | 0;
    this.tremFadeStep = f32(1 / (this.tremFadeLen + 1));
    this.tempoRate = f32(this.tempo / f32(sr * 60 * 64));
    this.fCurve.mode = this.quality;
    this.rCurve.mode = this.quality;
    this.pCurve.mode = this.quality;
    this.sumHint = this.quality >= 2 ? 2 : 1;
    this.bankPrecision = this.quality > 0 ? this.quality + 1 : 0;
    const act = this.quality >= 1 ? TINY : f32(exp(f32(-96 * bitsF(0x3debc8e3))));
    for (const v of this.voices) { v.bank.precision = this.bankPrecision; v.bank.act = act; }
    for (const v of this.free) { v.bank.precision = this.bankPrecision; v.bank.act = act; }
  }

  /** Tempo (FPE_Tempo -> PL+0x2dc, 0x69ac0). */
  setTempo(bpm: number): void {
    if (f32(bpm) === this.tempo) return;
    this.tempo = f32(bpm);
    this.tempoRate = f32(this.tempo / f32(this.sr * 60 * 64));
    this.param(77);
    this.param(89);
  }

  /** 0x66620: the filter's frequency range from the curve's extents and the width. */
  private filterRange(): void {
    const k = f32(682.66666666666663 / this.fWidth);
    const a = f32(k * this.fCurve.e1), b = f32(k * this.fCurve.e2);
    const sgn = (x: number) => (x === 0 ? 0 : fbits(x) < 0 ? -1 : 1);
    const s8 = f32(a - f32(sgn(a) * (a >= 1 ? 1 : a)));
    const s9 = f32(b - f32(sgn(b) * (b >= 1 ? 1 : b)));
    this.lo = f32(log(this.lowHz) * INV_LN2 - s8);
    this.hi = f32(log(this.highHz) * INV_LN2 + s9);
    this.range = f32(this.hi - this.lo);
    this.invRange = f32(1 / this.range);
    this.halfRange = f32(this.range * 0.5);
    this.mid = f32(f32(this.lo + this.hi) * 0.5);
    this.param(54);
    this.param(52);
    this.param(58);
  }

  /** FL's ProcessParam for parameter i (the derived values). */
  param(i: number): void {
    const v = this.P[i];
    const sr = this.sr;
    const x = () => f32(f32(v) * f32(0.001));
    const sgn = (n: number) => (n === 0 ? 0 : n < 0 ? -1 : 1);
    const fsgn = (n: number) => (fbits(n) << 1 === 0 ? 0 : fbits(n) < 0 ? -1 : 1);
    switch (i) {
      case 0: { const d = x(); this.phaseRand = f32(d * d * sgn(v)); break; }
      case 1: this.lowProt = law11(f32(f32(v) * f32(0.0009765625))); break;
      case 2: case 3: case 4: this.subs[i - 1] = f32(v * 0.0009765625); break;
      case 5: case 6: case 7: case 8: case 9: case 10:
        this.eq[i - 5] = law3(f32(f32(v + 0x400) * f32(0.0009765625)));
        this.eqDirty = true;
        break;
      case 11: case 12: case 13: case 14: case 15: case 16: case 17: case 18: case 19: case 20: case 21: case 22: {
        const s = x();
        const a = law11(Math.abs(s));
        this.mask[i - 11] = f32(a * fsgn(s));
        break;
      }
      case 23: this.maskMix = x(); break;
      case 24: this.maskMixLfo = x(); break;
      case 25: this.tremDepth = x(); break;
      case 26: this.volA = f32(f32(sr) * f32(exp(x() * 4.6151205168412597) - 1)) * 0.050000000000000003; break;
      case 27: this.volD = v >= 1000 ? -1 : sr * (0.050000000000000003 + f32(exp(x() * 6.9087547793152204) - 1) * 0.11995); break;
      case 28: this.volR = sr * (0.01 + f32(exp(x() * 4.6151205168412597) - 1) * 0.024900000000000002); break;
      case 31:
        this.pluckDec = v >= 1000 ? -1 : f32(f32(exp(x() * 6.9087547793152204) - 1) * f32(0.119750001));
        this.pluckChanged();
        break;
      case 33: case 34: this.pluckChanged(); break;
      case 36: this.mainVol = f32(law3(x()) * 0.75); break;
      case 38: this.mainPitchC = v - 1200; break;
      case 39: this.detuneDirty = true; break;
      case 40: {
        const s = f32(f32(this.P[40]) * f32(0.001));
        const e = f32(exp(Math.abs(s) * 4.1743872698956368) - 1);
        this.grit = f32(f32(e * fsgn(s)) * 0.00078125000000000004 * -16);
        for (const w of this.voices) w.lastPitch = bitsF(0x4f000000);
        break;
      }
      case 41: this.vibDepth = f32(v * 0.074999999999999997); break;
      case 42: {
        const s = x();
        const e = f32(exp(Math.abs(s) * 4.6151205168412597) - 1);
        this.pitchLfo = f32(f32(e * fsgn(s)) * 12);
        break;
      }
      case 43: if (v > 0) this.slotSet.fill(0); break;
      case 45: {
        const s9 = f32(sr * sgn(v));
        const e = f32(exp(f32(f32(Math.abs(v)) * f32(0.001)) * 3.713572066704308) - 1);
        this.portaTime = f32(f32(s9 * e) / f32(f32(26.666666) * f32(this.period)));
        break;
      }
      case 47:
        this.adaptive = v > 0;
        this.param(52);
        this.param(58);
        break;
      case 48: this.fenvA = v >= 1000 ? 0 : 1 / (f32(f32(sr) * f32(exp(x() * 6.9087547793152204) - 1)) * 0.12 + 1); break;
      case 49: this.fenvD = v >= 1000 ? 0 : -1 / (sr * (f32(exp(x() * 6.9087547793152204) - 1) * 0.12) + 1); break;
      case 50: case 51: {
        const s = x();
        const e = f32(exp(Math.abs(s) * 13.815511557963774) - 1);
        (i === 50 ? this.attackSlope : this.decaySlope).set(f32(e * fsgn(s)));
        break;
      }
      case 52: {
        let d = x();
        if (!this.adaptive) d = d * f32(this.hi - this.lo);
        this.fenvAmt = f32(d);
        break;
      }
      case 54: this.fcut = f32(this.lo + v * 0.0001220703125 * this.range); break;
      case 56:
        this.fWidth = f32(exp((1 - v * 0.0040000000000000001) * LN2) * 1024);
        this.filterRange();
        break;
      case 57: this.keyFcut = x(); break;
      case 58: this.fLfo = f32(x() * 6); break;
      case 60: case 63: this.resScale(); break;
      case 61: {
        this.resOfsOct = f32(v * 0.00083333333333333339);
        this.resOfsRatio = f32(exp(this.resOfsOct * LN2));
        const e = exp(f32((v + 0x960) * 0.00020833333333333335) * 5.3033049080590757);
        this.noiseLen = 1.9954648526077097 + f32(e - 1) * 2.4900226757369612;
        this.noiseRate = this.period / (this.noiseLen * 0.001 * sr);
        break;
      }
      case 62: this.subs[0] = f32(v * 0.00390625); break;
      case 65:
        this.uniOrder = v;
        this.uniGain = v > 1 ? f32(1 - f32(f32(exp(f32(1 - 1 / v) * 1.0986122886681098) - 1) * 0.5)) : 1;
        this.unisonChanged();
        break;
      case 66: this.unisonChanged(); break;
      case 67:
        this.uniPitch = f32(f32(exp(f32(v * 0.00390625) * 3.713572066704308) - 1) * 1.875);
        this.unisonChanged();
        break;
      case 68: this.uniPhase = f32(v * 0.0078125); break;
      case 73: this.phWidth = f32(v * 0.0001); break;
      case 74: this.phWidthLfo = f32(v * 0.00050000002); break;
      case 76: this.phOfsLfo = f32(v * 0.00050000002); break;
      case 77: case 89: {
        const s = f32(f32(Math.abs(v)) * f32(0.001));
        const r = sgn(v) * exp(s * LN2) * this.tempoRate;
        if (i === 77) this.phMotionRate = r;
        else { this.lfoRate = r; this.lfoPitchOfs = f32(v * 0.59999999999999998 + 1200); }
        break;
      }
      case 80: this.hzWidth = x(); break;
      case 81: this.hzWidthLfo = x(); break;
      case 83: this.hzStrength = f32(exp(f32(v * 0.00390625) * LN2) * 1.3310003559094952); break;
      case 86: this.lfoShape = v; break;
      case 88: this.lfoAttRate = f32(1 / (f32(f32(sr) * f32(exp(x() * 4.6151205168412597) - 1)) * 0.050000000000000003 + 1)); break;
      default: break;
    }
  }

  /** 0x728d0: resonance width / curvature from the scale and adaptive switches. */
  private resScale(): void {
    const hz = (n: number) => 440 * exp((n - 57) * LN2_12);
    if (this.P[60] === 0) {
      if (this.P[63] > 0) { this.resWidth = f32(1024 * hz(30)); this.resK = bitsF(0x3f600000); }
      else { this.resWidth = bitsF(0x44800000); this.resK = bitsF(0xbe000000); }
    } else if (this.P[63] > 0) { this.resWidth = f32(0.38400000000000001 * hz(42)); this.resK = 0.5; }
    else { this.resWidth = bitsF(0x3ec49ba6); this.resK = bitsF(0xbfc00000); }
  }

  /** 0x6df70: voices re-set their pluck. */
  private pluckChanged(): void {
    for (const w of this.voices) {
      w.pluckDue = true;
      if (this.pluckDec >= 0 && (this.P[35] === 0 || w.stage >= 6)) w.pluckOn = true;
    }
  }

  /** 0x6e010: voices follow unison panning / pitch thickness. */
  private unisonChanged(): void {
    for (const w of this.voices) {
      w.uPan = f32(w.uPos * f32(this.P[66]));
      w.uDetune = f32(w.uPos2 * this.uniPitch);
    }
  }

  /** 0x71a20: the timbre colour's amplitudes and phases. */
  computeTimbre(): void {
    const t = this.tmpT;
    const amps = this.timbreAmps, ph = this.phases;
    for (let k = 0; k < NHARM; k++) {
      timbreOf(this.timbre, k, this.custom, t);
      amps[k + 4] = t[0];
      ph[k + 4] = t[1];
    }
    amps[0] = 1; ph[0] = 0;
    amps[1] = amps[4]; ph[1] = ph[4];
    timbreOf(this.timbre, 0.5, this.custom, t); amps[2] = t[0]; ph[2] = t[1];
    timbreOf(this.timbre, 1.5, this.custom, t); amps[3] = t[0]; ph[3] = t[1];
    this.eqDirty = true;
  }

  /** 0x72300: timbre amplitudes x the timbre EQ. */
  private applyEq(): void {
    this.eqDirty = false;
    const g = globalTables();
    const tmp = this.tmp528, a = this.timbreAmps, o = this.eqAmps;
    const b5 = g.eq[5];
    for (let i = 0; i < NOSC; i++) tmp[i] = f32(a[i] * b5.w[i]);
    for (let i = 0; i < NOSC; i++) o[i] = f32(tmp[i] * this.eq[5]);
    for (let b = 0; b < 5; b++) {
      const e = g.eq[b];
      if (e.count <= 0) continue;
      for (let i = e.start; i < e.start + e.count; i++) tmp[i] = f32(a[i] * e.w[i]);
      for (let i = e.start; i < e.start + e.count; i++) o[i] = fma32(tmp[i], this.eq[b], o[i]);
    }
    if (this.P[33] > 0) this.pluckChanged();
  }

  /** 0x724f0: detuned ratios and the grittiness sines. */
  private applyDetune(): void {
    this.detuneDirty = false;
    const e = exp(this.P[39] * 0.00083333333333333339 * LN2);
    const r = this.ratios;
    for (let i = 0; i < NHARM; i++) r[4 + i] = i * e + 1;
    r[2] = 1 + e * 0.5;
    r[3] = 1 + e * 1.5;
    const s = this.gritSin;
    for (let i = 0; i < NOSC; i++) s[i] = sin((r[i] + -1) * 0.41887902047863906);
    s[0] = 0;
    for (const w of this.voices) w.lastPitch = bitsF(0x4f000000);
    this.pluckChanged();
  }

  // ------------------------------------------------------------------ notes

  /** 0x6d850: a voice from the pool. */
  private allocVoice(): HlVoice {
    const v = this.free.pop() ?? new HlVoice(this.maxBlock, this.attackSlope);
    v.bank.precision = this.bankPrecision;
    v.bank.act = this.quality >= 1 ? TINY : f32(exp(f32(-96 * bitsF(0x3debc8e3))));
    return v;
  }

  private releaseToPool(v: HlVoice): void {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    this.free.push(v);
    if (this.cutoffVoice === v) this.pickCutoffVoice();
  }

  /** 0x72670: the latest colour 16 note sets the cutoff offset. */
  private pickCutoffVoice(): void {
    this.cutoffOfs = 0;
    this.cutoffVoice = null;
    let best = -Infinity;
    for (const w of this.voices) if (w.type === 1 && w.t0 > best) { best = w.t0; this.cutoffVoice = w; }
  }

  /**
   * TriggerVoice (0x6cc30) for a note: colour 0..15, velocity (FPV_GetVelocity),
   * the level object (kept by reference: FL re-reads FinalLevels every render).
   * Returns the note's first voice.
   */
  trigger(noteId: number, color: number, vel: number, lv: HlNoteLevels): HlVoice | null {
    const velc = vel < 1 ? vel : 1;
    // FL's colour variable: "inverted legato / porta" (colours 13 / 14) play in slot 0 when the mode is off,
    // and the voices made after that check carry colour 0 (0x6ce00, 0x6cfa0)
    let c = color;
    const mk = (type: number): HlVoice => {
      const v = this.allocVoice();
      v.noteId = noteId;
      v.tag = noteId;
      v.lv = lv;
      v.color = c;
      v.vel = f32(velc);
      v.t0 = this.counter;
      v.hasAudio = false;
      if (this.P[46] > 0) { const r = f32(1 - v.vel * 0.84999999999999998); v.rel = f32(r * r); } else v.rel = 1;
      v.type = type;
      v.next = null; v.master = null; v.linked = 0;
      v.age = Infinity;
      return v;
    };
    if (c === 15) {
      const v = mk(1);
      this.voices.push(v);
      this.cutoffVoice = v;
      return v;
    }
    if ((this.P[44] > 0) !== (c === 13)) {
      if (this.P[44] === 0) c = 0;
      const held = this.slotVoice[c];
      if (held) {
        const v = mk(2);
        this.voices.push(v);
        this.monoRelease(held, false);
        return v;
      }
    }
    // FPE_MaxPoly: the oldest note (released ones first) fades out
    if (this.maxPoly > 0) {
      let oldest: HlVoice | null = null, cnt = 0, t = Infinity;
      for (const w of this.voices) {
        if (w.age === Infinity) continue;
        cnt++;
        if (w.age < t) { t = w.age; oldest = w; }
      }
      if (this.maxPoly <= cnt && oldest) this.killFadeVoice(oldest);
    }
    let porta = (this.P[43] > 0) !== (c === 14);
    if (porta) {
      if (this.P[43] === 0) c = 0;
      porta = this.slotSet[c] !== 0;
    }
    const slot = c;
    let rnd = FLAG_UNSET;
    if (this.P[87] > 0) rnd = f32(this.mt.next() * 2.3283064370807974e-10);
    let first: HlVoice | null = null;
    let prev: HlVoice | null = null;
    const order = this.uniOrder;
    for (let u = 0; u < order; u++) {
      const v = mk(0);
      this.initVoice(v, u, order, rnd);
      if (!first) {
        first = v;
        v.age = v.t0;
        this.slotVoice[slot] = v;
      } else {
        prev!.next = v;
        v.master = first;
        first.linked++;
        v.linked = -1;
        v.age = Infinity;
      }
      prev = v;
      this.voices.push(v);
    }
    if (first) {
      const rec = this.slotLv[first.color];
      if (porta) this.glide(first, rec, true, true);
      this.saveLevels(first, rec);
      this.slotSet[first.color] = 1;
    }
    return first;
  }

  /** The per-voice set-up of TriggerVoice (unison voice u of `order`). */
  private initVoice(v: HlVoice, u: number, order: number, rnd: number): void {
    v.ofs.fill(0);
    v.glideN = 0;
    v.first = true;
    v.uGain = this.uniGain;
    if (order === 1) {
      v.uPos = 0; v.uPan = 0; v.uPos2 = 0; v.uDetune = 0; v.uPhase = 0.5; v.uAtt = 1; v.uLfo = 0;
    } else {
      let s8 = f32(u / order);
      v.uPhase = f32(s8 * this.uniPhase);
      const s9 = f32(u / (order - 1));
      s8 = f32(f32(s9 * 2) - 1);
      v.uPos = f32(s8 * 0.0078125);
      v.uPan = f32(v.uPos * f32(this.P[66]));
      s8 = Math.abs(s8);
      if ((u & 1) === 1) s8 = -s8;
      if ((order & 1) === 1 && u * 2 > order) s8 = -s8;
      const type = Math.max(0, Math.min(2, this.P[70]));
      v.uPos2 = f32(s8 * UNISON_TABLE[type][u]);
      v.uDetune = f32(v.uPos2 * this.uniPitch);
      if (type === 2) {
        let d10 = f32(this.uniPhase * this.uniPhase);
        d10 = d10 * d10;
        v.uPhase = f32(100000 * exp(v.uDetune * LN2_1200) * d10 * d10);
      }
      v.uPhase = f32(f32(0.5 + v.uPhase) - f32(rint(v.uPhase)));
      const sv = f32(f32(f32(Math.abs(s8) - 1) * f32(this.P[69])) * 0.0078125);
      v.uAtt = f32(exp(sv * 3 * LN2));
      v.uLfo = f32(f32(s8 * f32(this.P[69])) * 0.00390625);
    }
    v.stage = 1;
    let att = this.volA * v.uAtt;
    if (this.P[29] > 0) {
      let s12 = f32(v.vel * 1.125);
      if (!(s12 < 1)) s12 = 1;
      att = att * f32(1 - s12);
    }
    const start = att <= 0 ? 1 : 0;
    const smooth = this.killFade < att ? this.killFade : att;
    v.rampA.setTime(smooth);
    v.pos = 1;
    if (att < this.attackMin) {
      let r = 1 - att / this.attackMin;
      r = r * r;
      v.pos = (rint(this.attackMin * r) | 0) + 1;
      att = this.attackMin;
    }
    v.end = (rint(att + smooth) | 0) + 1;
    v.slope = 1 / (att + 1);
    v.rampA.state = start;
    v.envLast = f32(v.pos * v.slope);
    v.fenv = 0;
    v.fenvRate = f32(this.fenvA * this.period);
    v.slopeRec = this.attackSlope;
    v.track = FLAG_UNSET;
    v.countdown = 0;
    v.lfoPhase = 0;
    v.rand = rnd === FLAG_UNSET ? f32(this.mt.next() * 2.3283064370807974e-10) : rnd;
    v.lfoAtt = this.lfoAttRate;
    v.vibAtt = this.vibFade;
    v.tremN = this.tremFadeLen;
    v.seed[0] = this.mt.next();
    v.noiseSeed[0] = v.seed[0];
    v.noisePhase = 0;
    v.pluckInit = 0;
    v.pluckG[1] = 1;
    v.pluckDue = true;
    v.pluckOn = this.pluckDec >= 0 && this.P[35] === 0;
    // the pluck starts after the attack, at least 2 ms after the note (0x6d618)
    let pn = -(rint(this.volA / this.period) | 0);
    if (this.pluckDelayMin < pn) pn = this.pluckDelayMin;
    v.pluckN = pn;
    v.lastPitch = bitsF(0x4f000000);
    const b = v.bank;
    b.setBand(32 * this.invSr, 16 * this.invSr, 16000 * this.invSr, f32(this.maxFreq * this.invSr));
    b.reset(this.bankSmooth);
    b.freq[0] = 1;
    v.res = 0;
    v.cut = 0;
  }

  /** 0x72700: remember a voice's levels for the next porta / legato. */
  private saveLevels(v: HlVoice, rec: Float32Array): void {
    const lv = v.lv;
    rec[0] = f32(lv.pan); rec[1] = f32(lv.vol); rec[2] = f32(lv.pitch); rec[3] = f32(lv.fcut); rec[4] = f32(lv.fres); rec[5] = v.vel;
  }

  /** 0x6e8a0: glide voice v (and its unison chain) from `rec` to its own levels. */
  private glide(v: HlVoice | null, rec: Float32Array, wrap: boolean, newNote: boolean): void {
    for (; v; v = v.next) {
      const o = v.ofs, lv = v.lv;
      if (newNote) { o[0] = 0; o[1] = 0; o[5] = 0; }
      else {
        o[0] = f32(f32(o[0] + rec[0]) - f32(lv.pan));
        o[1] = f32(f32(o[1] + rec[1]) - f32(lv.vol));
        o[5] = f32(f32(o[5] + rec[5]) - v.vel);
      }
      o[2] = f32(f32(o[2] + rec[2]) - f32(lv.pitch));
      o[3] = f32(f32(o[3] + rec[3]) - f32(lv.fcut));
      o[4] = f32(f32(o[4] + rec[4]) - f32(lv.fres));
      if (wrap) {
        const k = f32((o[2] === 0 ? 0 : fbits(o[2]) < 0 ? -1 : 1) * 1200);
        while (Math.abs(o[2]) > 1250) o[2] = f32(o[2] - k);
      }
      const s8 = f32(this.portaTime * v.rel);
      if (!(s8 > 0)) {
        v.glideN = 1 - (rint(s8) | 0);
        v.glideLin = f32(-1 / v.glideN);
        for (let i = 0; i < 6; i++) v.inc[i] = f32(o[i] * v.glideLin);
      } else {
        v.glideN = -0x7fffffff;
        v.glideExp = f32(exp(LN001 / s8));
      }
    }
  }

  /** 0x72750: a mono slot's sounding voice hands over to the newest held note of its colour. */
  private monoRelease(v: HlVoice, copyRel: boolean): boolean {
    const c = v.color;
    if (this.slotVoice[c] !== v) return false;
    this.slotVoice[c] = null;
    let best = -Infinity, found = false;
    for (const w of this.voices) {
      if (w.color === c && w.type === 2 && w.t0 > best) { best = w.t0; this.slotVoice[c] = w; found = true; }
    }
    if (!found) return false;
    const n = this.slotVoice[c]!;
    if (copyRel) n.rel = v.rel;
    this.swapVoices(v, n);
    this.saveLevels(v, this.slotLv[c]);
    this.glide(n, this.slotLv[c], false, false);
    this.saveLevels(n, this.slotLv[c]);
    return true;
  }

  /**
   * 0x6e7b0: exchange the sounding state of two voices: everything after the
   * first 0x28 bytes (levels, velocity, tag, start, keyboard note, release
   * factor stay); the unison chain then follows its new first voice.
   */
  private swapVoices(a: HlVoice, b: HlVoice): void {
    const A = a as unknown as Record<string, unknown>, B = b as unknown as Record<string, unknown>;
    for (const k of Object.keys(A)) {
      if (KEPT.has(k)) continue;
      const t = A[k]; A[k] = B[k]; B[k] = t;
    }
    for (let w = b.next; w; w = w.next) { w.lv = b.lv; w.vel = b.vel; w.tag = b.tag; w.t0 = b.t0; w.rel = b.rel; w.noteId = b.noteId; w.master = b; }
  }

  /** Voice_Release (0x6db70) for every voice of the note. */
  release(noteId: number, relVel: number): void {
    for (const v of this.voices.slice()) if (v.noteId === noteId) this.releaseVoice(v, relVel);
  }

  private releaseVoice(v: HlVoice, relVel: number): void {
    v.relTime = f32(2 - relVel * 2);
    if (!v.master) {
      if (this.P[46] > 0) {
        let r = relVel;
        if (!(r < 1)) r = 1;
        const x = f32(1 - r * 0.84999999999999998);
        v.rel = f32(x * x);
      } else v.rel = 1;
      this.monoRelease(v, true);
    }
    if (v.type > 0) { this.killNow(v); return; }
    if (v.stage < 6) {
      v.stage = 6;
      v.end = -1;
      this.fenvRelease(v);
      if (this.pluckDec >= 0 && (this.P[35] !== 0 ? v.stage >= 6 : true)) {
        v.pluckOn = true;
        if (v.pluckN < 0) v.pluckN = 0;
      }
      if (v.age !== Infinity) v.age = this.counter - 1e15;
    }
    if (v.next) this.releaseVoice(v.next, relVel);
  }

  /** 0x6e080: the filter envelope leaves its attack at the same shaped level. */
  private fenvRelease(v: HlVoice): void {
    if (!(v.fenvRate > 0)) return;
    const y = v.slopeRec.shape(v.fenv);
    v.fenvRate = f32(this.fenvD * this.period);
    v.slopeRec = this.decaySlope;
    const S = this.decaySlope;
    let e: number;
    if (S.k0 === 0) e = y;
    else if (fbits(S.k0) >= 0) e = 1 - log((1 - y) * Math.abs(S.k0) + 1) / S.k2;
    else e = log(y * Math.abs(S.k0) + 1) / S.k2;
    v.fenv = f32(e);
  }

  /** 0x6dd50: fade out over 30 ms (stage 9), then the voice ends. */
  private killFadeVoice(v: HlVoice): void {
    if (!v.master) this.monoRelease(v, false);
    if (v.type > 0) { this.killNow(v); return; }
    if (v.stage < 9) {
      v.stage = 9;
      v.pos = 0;
      v.end = this.killFade;
      v.rampA.setTime(this.killFade);
      v.rampB.setTime(0);
      v.age = Infinity;
      if (v.next) this.killFadeVoice(v.next);
    }
  }

  /** Voice_Kill (0x6de10): the voice goes at once. */
  private killNow(v: HlVoice): void {
    if (!v.master) this.monoRelease(v, false);
    if (v.next) this.killNow(v.next);
    this.releaseToPool(v);
  }

  /** The host's Voice_Kill for a note (polyphony limit / panic). */
  kill(noteId: number): void {
    for (const v of this.voices.slice()) if (v.noteId === noteId && !v.master) this.killNow(v);
  }

  allNotesOff(): void {
    for (const v of this.voices.slice()) if (!v.master) this.killNow(v);
    this.slotVoice.fill(null);
    this.slotSet.fill(0);
  }

  get voiceCount(): number { return this.voices.length; }

  // ------------------------------------------------------------------ render

  /** Gen_Render (0x72f90) for n samples: adds the voices into out (interleaved stereo). Returns the FX input / dry mix. */
  render(n: number): Float32Array {
    const S = this.scratch;
    this.tremBuf = null;
    if (this.tremDepth !== 0 || this.tremCur !== 0) {
      if (this.voices.length > 0) this.tremolo(n);
      else this.tremCur = this.tremDepth;
    }
    if (this.eqDirty) this.applyEq();
    if (this.detuneDirty) this.applyDetune();
    if (this.cutoffVoice) {
      const p = f32(f32(f32(this.cutoffVoice.lv.pitch) * f32(0.01)) + 84);
      this.cutoffOfs = f32((LOG2_440 + (p - 57) * 0.083333333333333329) - this.mid);
    }
    this.deferKills = this.threaded && this.voices.length > 1;
    for (const v of this.voices.slice()) this.renderVoice(v, n);
    this.deferKills = false;
    for (const v of this.pendingKills) this.killFadeVoice(v);
    this.pendingKills.length = 0;
    const mix = S.mix;
    mix.fill(0, 0, n * 2);
    for (let k = this.voices.length - 1; k >= 0; k--) {
      const v = this.voices[k];
      if (v.hasAudio) { const o = v.out; for (let i = 0; i < n * 2; i++) mix[i] = f32(mix[i] + o[i]); v.hasAudio = false; }
    }
    // 0x73340: finished voices go (FL asks the host to kill them; a kill can take several)
    for (let k = this.voices.length - 1; k >= 0; k--) {
      const v = this.voices[k];
      if (v && v.type === 0 && v.stage === 10 && v.linked === 0) this.killNow(v);
    }
    this.phMotion = frac((this.phMotion + this.phMotionRate * n) * 0.25) * 4;
    this.lfoPhase = this.lfoPhase + this.lfoRate * n;
    this.vibPhase = f32(frac(f32(this.vibPhase + f32(this.vibRate * f32(n)))));
    this.counter32 = (this.counter32 + n) | 0;
    this.counter += n;
    return mix;
  }

  /** The stereo tremolo (Gen_Render 0x73040): 1 + depth (|1.25 cos|, |1.25 sin| - 1), depth ramped. */
  private tremolo(n: number): void {
    const S = this.scratch;
    const buf = S.r30;
    this.tremBuf = buf;
    let ph = f32(frac(f32(f32(this.counter) * this.tremRate)) * TWO_PI_F);
    if (ph >= TWO_PI_F) ph = f32(ph - TWO_PI_F);
    this.tremPhase[0] = ph;
    tone32fc(S.r18, n, 1.25, this.tremRate, this.tremPhase);
    abs32f(S.r18, buf, n * 2);
    addC32fI(-1, buf, n * 2);
    this.rampGain(buf, n, this.tremDepth);
    addC32fI(1, buf, n * 2);
  }

  /** 0x1af7a0: buf *= the depth ramped from tremCur to `target` (FL's step 0x7ac70, kernel 0x796d0). */
  private rampGain(buf: Float32Array, n: number, target: number): void {
    const start = this.tremCur;
    let step = f32(target - start);
    let cur: number;
    if (fbits(step) !== 0) {
      cur = target;
      step = f32(step / f32(n));
      if (Math.abs(step) > this.rampMax) {
        step = fbits(step) < 0 ? -this.rampMax : this.rampMax;
        cur = f32(start + f32(step * f32(n)));
        if (Math.abs(cur) < TINY) { cur = 0; step = f32(-start / f32(n)); }
      }
    } else cur = start;
    this.tremCur = cur;
    if (fbits(step) === 0) {
      if (start === 0) buf.fill(0, 0, n * 2);
      else if (start !== 1) mulC32fI(start, buf, n * 2);
      return;
    }
    // TODO(test host): kernel 0x796d0 (ramped stereo gain); per-pair accumulation as 0x47f8
    let g = start;
    for (let i = 0; i < n; i++) {
      buf[2 * i] = f32(buf[2 * i] * g);
      buf[2 * i + 1] = f32(buf[2 * i + 1] * g);
      g = f32(g + step);
    }
  }

  /** The voice render (0x6ed10): n samples into v.out. */
  private renderVoice(v: HlVoice, n: number): void {
    if (v.type > 0) return;
    const S = this.scratch;
    const lv = v.lv;
    let motion = f32(this.phMotion); // [sp+0x14]
    if (this.P[87] > 0) v.lfoPhase = this.lfoPhase;
    let vib = this.vibPhase; // [sp+0x18]
    const cut0 = f32(this.fcut + this.cutoffOfs); // [sp+0x1c]
    const pitch0 = f32(f32(lv.pitch) + f32(this.mainPitchC)); // [sp+0x20]
    const pan = f32(f32(f32(lv.pan) + v.ofs[0]) + v.uPan);
    const vol = f32(f32(this.mainVol * f32(f32(lv.vol) + v.ofs[1])) * v.uGain);
    computeLRVol(pan, vol, v.gains, 0);
    if (v.first) { v.gains[2] = v.gains[0]; v.gains[3] = v.gains[1]; v.cut = cut0; }
    let left = n;
    let outPos = 0;
    const bank = v.bank;
    while (left > 0) {
      if (v.countdown <= 0) {
        v.countdown = this.period;
        this.control(v, S, cut0, pitch0, motion, vib);
      }
      const m = Math.min(v.countdown, left);
      bank.render(S.r18, m, outPos);
      outPos += m;
      v.countdown -= m;
      left -= m;
      motion = f32(motion + this.phMotionRate * m);
      v.lfoPhase = v.lfoPhase + this.lfoRate * m;
      vib = f32(vib + f32(this.vibRate * f32(m)));
      let la = f32(v.lfoAtt + f32(this.lfoAttRate * f32(m)));
      if (!(la < 1)) la = 1;
      v.lfoAtt = la;
      let va = f32(v.vibAtt + f32(this.vibFade * f32(m)));
      if (!(va < 1)) va = 1;
      v.vibAtt = va;
      v.first = false;
    }
    this.envelope(v, S, n);
    mul32fI(S.r20, S.r18, n);
    this.stereoOut(v, S.r18, n);
    if (v.stage < 9 && this.slotVoice[v.color] !== v && v.stage >= 3 && S.r20[n - 1] < this.killThresh) {
      if (this.deferKills) this.pendingKills.push(v);
      else this.killFadeVoice(v);
    }
    if (this.tremBuf) {
      if (v.tremN > 0) {
        const t = S.r20, t2 = S.r28;
        vectorSlope32f(t, n, f32(1 - f32(f32(v.tremN) * this.tremFadeStep)), this.tremFadeStep);
        thresholdGT32fI(t, n, 1);
        for (let i = 0; i < n; i++) { t2[2 * i] = t[i]; t2[2 * i + 1] = t[i]; }
        mul32f(t2, this.tremBuf, t, n * 2);
        for (let i = 0; i < n * 2; i++) t2[i] = f32(1 - t2[i]);
        for (let i = 0; i < n * 2; i++) t[i] = f32(t[i] + t2[i]);
        mul32fI(t, v.out, n * 2);
        v.tremN -= n;
      } else mul32fI(this.tremBuf, v.out, n * 2);
    }
    v.hasAudio = true;
  }

  /** The control step (voice render 0x6eeb8 .. 0x7121c). */
  private control(v: HlVoice, S: Scratch, cut0: number, pitch0: number, motion: number, vib: number): void {
    const P = this.P, lv = v.lv, bank = v.bank;
    const d15 = bank.freq[0];
    if (v.glideN !== 0) {
      if (v.glideN > 0) { for (let i = 0; i < 6; i++) v.ofs[i] = f32(v.ofs[i] + v.inc[i]); v.glideN--; }
      else for (let i = 0; i < 6; i++) v.ofs[i] = f32(v.ofs[i] * v.glideExp);
    }
    // filter envelope
    v.fenv = f32(v.fenv + v.fenvRate);
    if (fbits(v.fenv) >= 0x3f800000 && fbits(v.fenvRate) > 0) {
      v.fenv = f32(1 - f32(f32(1 - v.fenv) / v.fenvRate) * this.fenvD * this.period);
      v.fenvRate = f32(this.fenvD * this.period);
      v.slopeRec = this.decaySlope;
    }
    if (fbits(v.fenv) < 0) v.fenv = 0;
    const shaped = f32(v.slopeRec.shape(v.fenv)); // [sp+0x30]
    v.cut = f32(cut0 + f32(f32(v.cut - cut0) * this.cutSmooth));
    let pitch = f32(pitch0 + v.ofs[2]); // [sp+0x4]
    if (P[41] !== 0) pitch = f32(pitch + sin(f32(vib * TWO_PI_F)) * this.vibDepth * v.vibAtt * v.vibAtt);
    this.lfoValue(v, shaped, pitch);
    pitch = f32(pitch + f32(this.pitchLfo * v.lfo));
    if (P[99] > 0) pitch = f32(pitch + f32(v.uDetune * f32(v.vel + v.ofs[5])));
    else pitch = f32(pitch + v.uDetune);
    const n = (): number => bank.count;
    let freqChanged = fbits(pitch) !== fbits(v.lastPitch);
    const oldCount = bank.count;
    if (freqChanged) {
      v.oct = f32(LOG2_440 + (f32(f32(pitch * f32(0.01)) + 60) - 57) * 0.083333333333333329);
      v.freq = f32(exp(v.oct * LN2));
      let k = this.harmonicCount(v.freq);
      if (k > 0x210) k = 0x210;
      k = (k + 7) & ~7;
      if (bank.count < k) bank.count = k;
      const f = v.freq * this.invSr;
      for (let i = 0; i < bank.count; i++) bank.freq[i] = this.ratios[i] * f;
      if (this.grit !== 0) {
        const g = f32(v.freq * this.grit) * this.invSr;
        for (let i = 0; i < bank.count; i++) bank.freq[i] = bank.freq[i] + this.gritSin[i] * g;
      }
      convert64f32f(bank.freq, v.hz, bank.count);
      mulC32fI(f32(this.sr), v.hz, bank.count);
      ln32f(v.hz, v.lhz, bank.count);
      mulC32fI(INV_LN2F, v.lhz, bank.count);
    }
    const cnt = n();
    // harmonic mask
    if (P[34] === 0) this.applyMask(v, this.eqAmps, v.amps);
    else for (let i = 0; i < cnt; i++) v.amps[i] = this.eqAmps[i];
    if (P[85] === 0 && P[79] !== 0) this.harmonize(v, S);
    // filter
    const kt = f32((v.oct + this.keyTrackOfs) * this.keyFcut);
    const lo = f32(this.lo + kt), hi = this.hi;
    let c = f32(f32(v.cut + kt) + f32(f32(f32(lv.fcut) + v.ofs[3]) * this.halfRange));
    c = c < lo ? lo : c > hi ? hi : c;
    let rr = f32(f32(f32(P[59]) * f32(0.001)) + f32(f32(f32(lv.fres) + v.ofs[4]) * 0.5));
    rr = rr < 0 ? 0 : rr > 1 ? 1 : rr;
    v.res = f32(law11(rr) * 0.25);
    if (fbits(this.fLfo) > 0) {
      let m = f32(hi - c);
      if (!(this.fLfo >= m)) m = this.fLfo;
      c = f32(c + f32(v.lfoU * m));
    } else {
      let m = f32(lo - c);
      if (this.fLfo > m) m = this.fLfo;
      c = f32(c + f32(v.lfoU * m));
    }
    let amt = this.fenvAmt;
    if (P[53] > 0) amt = f32(amt * f32(v.vel + v.ofs[5]));
    if (this.adaptive) {
      if (fbits(amt) > 0) c = f32(c + f32(f32(f32(hi - c) * shaped) * amt));
      else c = f32(c - f32(f32(f32(lo - c) * shaped) * amt));
    } else c = f32(c + f32(f32(shaped - 0.5) * amt));
    const fc = exp(c * LN2);
    const C = this.fCurve;
    if (P[55] === 0) mapClamped(C, v.lhz, S.r20, S.r28, cnt, this.fWidth, f32(C.c - f32(c * this.fWidth)));
    else {
      const w9 = f32(this.fWidth * 0.90000000000000002);
      mapClamped(C, v.hz, S.r20, S.r28, cnt, f32(w9 / fc), f32(C.c - w9));
    }
    mul32fI(S.r20, v.amps, cnt);
    if (P[64] !== 0) {
      if (v.track === FLAG_UNSET) v.track = c;
      else v.track = f32(c + f32(f32(v.track - c) * this.trackSmooth));
      const d = Math.abs(f32(c - v.track));
      let m = f32(d * d);
      if (!(m < 1)) m = 1;
      v.res = f32(v.res * m);
    }
    if (fbits(v.res) > 0) this.resonance(v, S, c, fc, cnt);
    if (P[85] === 1 && P[79] !== 0) this.harmonize(v, S);
    if (P[71] !== 0) { if (this.phaser(v, S, motion, cnt)) freqChanged = true; }
    if (P[85] === 2 && P[79] !== 0) this.harmonize(v, S);
    if (v.pluckOn) this.pluck(v, S, cnt);
    if (P[85] === 3 && P[79] !== 0) this.harmonize(v, S);
    // low harmonics protection and the special slots
    const g = globalTables();
    for (let i = 0; i < 8; i++) v.amps[i] = f32(v.amps[i] + f32(f32(this.eqAmps[i] - v.amps[i]) * f32(g.lowProt[i] * this.lowProt)));
    for (let i = 0; i < 4; i++) v.amps[i] = f32(v.amps[i] * this.subs[i]);
    if (bank.count > 0x1d0) {
      const m = bank.count - 0x1d0;
      // FL multiplies the bank's amplitude store (TB+0xc8), which setTargets overwrites below
      for (let i = 0; i < m; i++) bank.amps[0x1d0 + i] = f32(bank.amps[0x1d0 + i] * g.topFade[i]);
    }
    if (freqChanged) {
      const cntB = bank.count;
      for (let i = 1; i < cntB; i++) {
        bank.bandGain(i);
        let a = bank.amps[i];
        if (bank.bandOn) a = f32(a * bank.band[i]);
        bank.setTarget(i, a);
        bank.countdown[i] = 0;
        bank.dirty[i] = 1;
      }
      if (oldCount < bank.count) bank.alignNew(oldCount - 1);
    }
    if (v.first) this.initPhases(v);
    v.amps[0] = f32(f32(this.subs[0] * v.res) * v.pluckG[1]);
    const d10 = fc * this.resOfsRatio * this.invSr;
    bank.freq[0] = d15;
    if (d15 !== d10) {
      bank.freq[0] = d10;
      bank.bandGain(0);
      let a = bank.amps[0];
      if (bank.bandOn) a = f32(a * bank.band[0]);
      bank.setTarget(0, a);
      bank.countdown[0] = 0;
      bank.dirty[0] = 1;
    }
    bank.setTargets(v.amps);
    v.lastPitch = pitch;
  }

  /** 0x72420: harmonics below FL's 17 kHz limit (+4 special slots). */
  private harmonicCount(freq: number): number {
    if (this.quality >= 2) return 0x210;
    const e = exp(this.P[39] * 0.00083333333333333339 * LN2);
    let s = f32(f32(this.maxFreq / freq) / e);
    if (this.quality >= 1) s = f32(s * 1.5);
    let k = rint(s);
    if (k < 1) k = 1;
    return (k + 4) | 0;
  }

  /** The voice's LFO / modulation source (voice render 0x6f1d8). */
  private lfoValue(v: HlVoice, shaped: number, pitch: number): void {
    const shape = this.lfoShape;
    const a2 = (y: number) => { v.lfo = f32(f32(y * v.lfoAtt) * v.lfoAtt); v.lfoU = f32(f32(v.lfo + 1) * 0.5); };
    switch (shape) {
      case 9: v.lfo = f32(f32(shaped * v.lfoAtt) * v.lfoAtt); v.lfoU = v.lfo; return;
      case 10: v.lfo = f32(f32(f32(f32(v.cut - this.lo) * this.invRange) * v.lfoAtt) * v.lfoAtt); v.lfoU = v.lfo; return;
      case 11: v.lfoU = f32(f32(v.rand * v.lfoAtt) * v.lfoAtt); v.lfo = f32(f32(v.lfoU * 2) - 1); return;
      case 12: v.lfo = f32(f32(f32(v.vel + v.ofs[5]) * v.lfoAtt) * v.lfoAtt); v.lfoU = v.lfo; return;
      case 13: {
        let s = f32(f32(pitch + this.lfoPitchOfs) * 0.00027777777777777778);
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        v.lfo = f32(f32(s * v.lfoAtt) * v.lfoAtt);
        v.lfoU = f32(f32(v.lfo + 1) * 0.5);
        return;
      }
      default: break;
    }
    let d8 = v.lfoPhase + v.uLfo;
    let y: number;
    switch (shape) {
      case 1: {
        d8 = d8 - rint(d8);
        const t = f32(d8 * TWO_PI_F);
        const ms = globalTables().multisine;
        mulC32f(ms, t, this.tones, 12);
        sin32fA21(this.tones, this.tones2, 12);
        mul32fI(ms.subarray(12), this.tones2, 12);
        y = sum32f(this.tones2, 12);
        break;
      }
      case 2: {
        d8 = d8 - rint(d8);
        const s2 = f32(sin((d8 + 0.5) * TWO_PI_F));
        let a = f32(1 - Math.abs(s2));
        a = f32(f32(a * a) * a);
        const sg = (fbits(s2) << 1) === 0 ? 0 : fbits(s2) < 0 ? -1 : 1;
        y = f32(sg * f32(1 - f32(a * a)));
        break;
      }
      case 3: { const p = d8 - 0.5; y = f32((p - rint(p)) * 2); break; }
      case 4: y = (((rint(d8 * 2 - 0.5) & 1) << 1) - 1); break;
      case 5: { const r = rint(d8 * 3 - 0.5); y = (r - Math.trunc(r / 3) * 3) - 1; break; }
      case 6: { const p = d8 + 0.25; y = f32(Math.abs((p - rint(p - 0.5)) * 4 - 2) - 1); break; }
      case 7: {
        const p = d8 - 0.5;
        const t = f32((p - rint(p)) + 0.5);
        y = f32(f32(f32(f32(t * t) * t) * 2) - 1);
        break;
      }
      case 8: {
        const a = (d8 + 0.5) * TWO_PI_F;
        y = f32((sin(a) + sin((a + 7) * 0.20000000000000001)) * 0.5);
        break;
      }
      default: {
        d8 = d8 - rint(d8);
        y = f32(sin((d8 + 0.5) * TWO_PI_F));
        break;
      }
    }
    a2(y);
  }

  /** 0x6e260: timbre x harmonic mask (12-periodic) -> dst. */
  private applyMask(v: HlVoice, src: Float32Array, dst: Float32Array): void {
    let m = this.maskMix;
    if (fbits(this.maskMixLfo) > 0) {
      let k = f32(1 - m);
      if (!(this.maskMixLfo >= k)) k = this.maskMixLfo;
      m = f32(m + f32(v.lfoU * k));
    } else {
      let k = -m;
      if (this.maskMixLfo > k) k = this.maskMixLfo;
      m = f32(m + f32(v.lfoU * k));
    }
    const cnt = v.bank.count;
    if (fbits(m) <= 0) {
      if (src !== dst) for (let i = 0; i < cnt; i++) dst[i] = src[i];
      return;
    }
    if (src !== dst) for (let i = 0; i < 4; i++) v.amps[i] = this.eqAmps[i];
    const c = f32(1 - m);
    const w = this.mask;
    const groups = Math.trunc((cnt - 4 + 12 - 1) / 12);
    for (let g = 0; g < groups; g++) {
      for (let j = 0; j < 12; j++) {
        const i = 4 + g * 12 + j;
        dst[i] = f32(src[i] * f32(f32(w[j] * m) + c));
      }
    }
  }

  /** 0x6e470: the harmonizer adds copies of the spectrum at harmonic multiples. */
  private harmonize(v: HlVoice, S: Scratch): void {
    let w = this.hzWidth;
    if (this.P[82] > 0) w = f32(w * f32(v.vel + v.ofs[5]));
    if (fbits(this.hzWidthLfo) > 0) {
      let k = f32(1 - w);
      if (!(this.hzWidthLfo >= k)) k = this.hzWidthLfo;
      w = f32(w + f32(v.lfoU * k));
    } else {
      let k = -w;
      if (this.hzWidthLfo > k) k = this.hzWidthLfo;
      w = f32(w + f32(v.lfoU * k));
    }
    if (fbits(w) <= 0) return;
    const T = HARMONIZER[Math.max(0, Math.min(4, this.P[84]))];
    const s8 = f32(1 / f32(1 + f32(w * f32(T[3]))));
    let step = f32(1 - s8);
    const s9 = f32(f32(f32(this.P[79]) * f32(0.001)) * f32(f32(this.P[79]) * f32(0.001)));
    let k = 2;
    const n4 = v.bank.count - 4;
    const dst = v.amps, src = S.r28;
    for (let i = 0; i < n4; i++) src[i] = dst[4 + i];
    let sum = 1;
    while (fbits(step) > 0) {
      let g = f32(f32(f32(f32(step * step) * step) * this.hzStrength));
      if (!(g < 1)) g = 1;
      g = f32(g * s9);
      sum = f32(sum + g);
      const off = T[0] + k;
      const cnt = Math.trunc((n4 - 1 - off) / k) + 1;
      if (cnt > 0 && off < n4) {
        for (let i = 0; i < cnt; i++) {
          const d = 4 + off + i * k;
          dst[d] = f32(dst[d] + f32(src[i] * g));
        }
      }
      k = T[1] + T[2] * k;
      step = f32(step - s8);
    }
    mulC32fI(f32(1 / sum), dst, n4, 4);
  }

  /** Resonance (voice render 0x70150): noise or the resonance curve, added (kernel 0x4ab8). */
  private resonance(v: HlVoice, S: Scratch, c: number, fc: number, cnt: number): void {
    if (this.rCurve.type === 108) {
      const r = f32(v.res * 4);
      const k = f32((r * r * r * 9999) / this.noiseLen);
      const hi = f32(k + 1);
      const saved = v.noiseSeed[0];
      randUniform32f(S.r20, cnt, 0, hi, v.noiseSeed);
      const sq = f32(Math.sqrt(hi));
      // sparse random gains: below k -> 0, the rest -> sqrt(k + 1)
      thresholdLTVal32fI(S.r20, cnt, k, 0);
      thresholdGTVal32fI(S.r20, cnt, 0, sq);
      mul32fI(S.r20, v.amps, cnt);
      v.noisePhase = v.noisePhase + this.noiseRate;
      if (v.noisePhase >= 1) v.noisePhase = frac(v.noisePhase);
      else v.noiseSeed[0] = saved;
      return;
    }
    const w = this.P[63] > 0 ? f32(this.resWidth / v.freq) : this.resWidth;
    const C = this.rCurve;
    if (this.P[60] === 0) mapClamped(C, v.lhz, S.r20, S.r28, cnt, w, f32(C.c - f32(f32(c + this.resOfsOct) * w)));
    else mapClamped(C, v.hz, S.r20, S.r28, cnt, w, f32(C.c - fc * this.resOfsRatio * w));
    const s0 = f32(this.resK - v.oct), s1 = v.res;
    const m = cnt & ~7;
    for (let i = 0; i < m; i++) {
      let t = f32(f32(s0 + v.lhz[i]) * s1);
      if (!(t > 0)) t = t !== t ? t : 0;
      t = f32(f32(t * S.r20[i]) + 1);
      if (!(t > 0)) t = t !== t ? t : 0;
      v.amps[i] = f32(v.amps[i] * t);
    }
  }

  /** The phaser (voice render 0x70494); returns true when it moved the frequencies ("Freq" type). */
  private phaser(v: HlVoice, S: Scratch, motion: number, cnt: number): boolean {
    const C = this.pCurve, P = this.P;
    v.phKey = f32(f32(v.oct * f32(P[78])) * f32(0.001));
    const s2 = f32(f32(-P[75]) * f32(0.001));
    let d11 = f32(f32(f32(f32(f32(s2 - f32(v.lfo * this.phOfsLfo)) - v.uLfo) * C.s18) - f32(motion * C.s1c)));
    let d10: number;
    let src: Float32Array;
    const wexp = () => exp(f32(f32(f32(this.phWidth - 1) * 8) + f32(f32(v.lfo * this.phWidthLfo) * 2)) * LN2);
    if (P[72] === 0) {
      src = v.lhz;
      d10 = wexp() * 12 * C.s1c;
      d11 = d11 - v.phKey * d10;
    } else if (P[72] === 1) {
      src = v.hz;
      d10 = wexp() * 0.0050000000000000001 * C.s1c;
      d11 = d11 - f32(v.phKey * C.s18);
    } else {
      src = v.hz;
      d10 = f32(f32(f32(2 - f32(this.phWidth + f32(v.lfo * this.phWidthLfo))) * C.s1c) / v.freq);
      d11 = d11 - f32(v.phKey * C.s18);
    }
    mapPeriodic(C, src, S.r20, S.r28, cnt, f32(d10), f32(d11));
    const mix = f32(f32(P[71]) * f32(0.001));
    if (C.type === 209) {
      mulC32fI(f32(f32(f32(mix * mix) * mix) * LN2 * 0.25), S.r20, cnt);
      exp32f(S.r20, S.r28, cnt);
      mul32f(S.r28, v.hz, S.r20, cnt);
      mulC32fI(f32(this.invSr), S.r20, cnt);
      convert32f64f(S.r20, v.bank.freq, cnt);
      return true;
    }
    mulC32fI(mix, S.r20, cnt);
    addC32fI(f32(1 - mix), S.r20, cnt);
    mul32fI(S.r20, v.amps, cnt);
    return false;
  }

  /** The pluck (voice render 0x70998, set-up 0x6eb30). */
  private pluck(v: HlVoice, S: Scratch, cnt: number): void {
    if (v.pluckN >= 0) {
      if (v.pluckDue || v.pluckInit < cnt || this.P[34] > 0) this.pluckSetup(v, S, cnt);
      if (v.pluckInit < cnt) {
        const m = cnt - v.pluckInit;
        if (v.pluckN <= 0) v.pluckG.fill(1, v.pluckInit, cnt);
        else powx32f(v.pluckD, f32(v.pluckN), v.pluckG, m, v.pluckInit, v.pluckInit);
        v.pluckInit = cnt;
      }
      mul32fI(v.pluckG, v.amps, cnt);
      mul32fI(v.pluckD, v.pluckG, cnt);
    }
    v.pluckN++;
  }

  private pluckSetup(v: HlVoice, S: Scratch, cnt: number): void {
    if (this.pluckDec < 0) { v.pluckD.fill(1, 0, cnt); v.pluckDue = false; return; }
    let d = this.pluckDec;
    if (this.P[32] > 0) d = d * v.vel * v.vel;
    const s8 = f32(this.pluckBase / (0.25 + d));
    if (this.P[33] === 0) {
      convert64f32f(this.ratios, S.r20, cnt);
      mulC32fI(s8, S.r20, cnt);
    } else {
      abs32f(this.eqAmps, S.r20, cnt);
      thresholdLT32fI(S.r20, cnt, f32(0.00100000005));
      for (let i = 0; i < cnt; i++) S.r20[i] = f32(s8 / S.r20[i]);
    }
    if (this.P[34] > 0) this.applyMask(v, S.r20, S.r20);
    exp32f(S.r20, v.pluckD, cnt);
    v.pluckDue = false;
  }

  /** The first control step's phases (voice render 0x70e40). */
  private initPhases(v: HlVoice): void {
    const bank = v.bank;
    let d10 = v.uPhase;
    const d11 = bank.freq[4];
    if (fbits(this.phaseRand) < 0) {
      randUniform64f(bank.phase, NOSC, 0, -this.phaseRand, v.seed);
      add64fI(this.phases, bank.phase, NOSC);
      d10 = d10 + f32(this.phaseRand * this.phaseRand) * frac(d11 * 277 * this.counter32);
    } else {
      for (let i = 0; i < NOSC; i++) bank.phase[i] = this.phases[i];
      d10 = d10 + this.phaseRand * frac(d11 * 277 * this.counter32);
    }
    bank.phase70 = bank.phase[bank.count - 1];
    const k = d10 / d11;
    for (let i = 0; i < bank.count; i++) bank.phase[i] = bank.phase[i] + bank.freq[i] * k;
    for (let i = 0; i < 4; i++) bank.phase[i] = 0;
  }

  /** The volume envelope into scratch r20 (voice render 0x713e0). */
  private envelope(v: HlVoice, S: Scratch, n: number): void {
    const env = S.r20;
    let left = n, off = 0;
    while (left > 0) {
      if (v.pos >= v.end) {
        if (v.end === -1) {
          // "Release velocity -> release": FL asks the host (FPV_GetRelTime = 2 - 2 * release velocity)
          const r = this.P[30] > 0 ? v.relTime : 1;
          v.rampA.setTime(this.killFade);
          v.rampB.setTime(this.volR * r);
        } else if (v.stage >= 9) {
          v.stage = 10;
          if (v.master) v.master.linked--;
        } else {
          v.rampA.setTime(0.080000000000000002 * this.sr);
          if (this.volD < 0) v.rampB.hold();
          else v.rampB.setTime(this.volD);
          if (v.stage < 3) v.stage = 3;
        }
        v.rampB.state = v.envLast;
        v.end = 0x7fffffff;
      }
      let m = v.end - v.pos;
      if (m > left) m = left;
      if (v.stage >= 3) {
        env.fill(0, off, off + m);
        v.rampB.run(env, m, off);
      } else {
        vectorSlope32f(env, m, f32(v.pos * v.slope), f32(v.slope), off);
        thresholdGT32fI(env, m, 1, off);
      }
      v.envLast = env[off + m - 1];
      v.rampA.run(env, m, off);
      v.pos += m;
      left -= m;
      off += m;
    }
  }

  /** 0x1af690: mono -> interleaved stereo with FL's gain ramps (kernels 0x4080 / 0x47f8). */
  private stereoOut(v: HlVoice, src: Float32Array, n: number): void {
    const g = v.gains, o = v.out;
    const st = (cur: number, target: number): [number, number, number] => {
      const start = cur;
      let step = f32(target - start);
      let next = start;
      if (fbits(step) !== 0) {
        next = target;
        step = f32(step / f32(n));
        if (Math.abs(step) > this.rampMax) {
          step = fbits(step) < 0 ? -this.rampMax : this.rampMax;
          next = f32(start + f32(step * f32(n)));
          if (Math.abs(next) < TINY) { next = 0; step = f32(-start / f32(n)); }
        }
      }
      return [start, step, next];
    };
    const [sl, dl, nl] = st(g[2], g[0]);
    const [sr2, dr, nr] = st(g[3], g[1]);
    g[2] = nl; g[3] = nr;
    if (fbits(dl) === 0 && fbits(dr) === 0) {
      if (sl === 0 && sr2 === 0) { o.fill(0, 0, n * 2); return; }
      for (let i = 0; i < n; i++) { o[2 * i] = f32(src[i] * sl); o[2 * i + 1] = f32(src[i] * sr2); }
      return;
    }
    // kernel 0x47f8: even / odd gains advance by 2 steps per pair; the tail (n % 8) advances 2 steps per sample
    let gl0 = sl, gr0 = sr2, gl1 = f32(sl + dl), gr1 = f32(sr2 + dr);
    const dl2 = f32(dl + dl), dr2 = f32(dr + dr);
    const body = n >= 8 ? n & ~7 : 0;
    let i = 0;
    for (; i < body; i += 2) {
      o[2 * i] = f32(src[i] * gl0); o[2 * i + 1] = f32(src[i] * gr0);
      o[2 * i + 2] = f32(src[i + 1] * gl1); o[2 * i + 3] = f32(src[i + 1] * gr1);
      gl0 = f32(gl0 + dl2); gr0 = f32(gr0 + dr2); gl1 = f32(gl1 + dl2); gr1 = f32(gr1 + dr2);
    }
    for (; i < n; i++) {
      o[2 * i] = f32(src[i] * gl0); o[2 * i + 1] = f32(src[i] * gr0);
      gl0 = f32(gl0 + dl2); gr0 = f32(gr0 + dr2);
    }
  }
}

export { LN11F, LN3F, fma32 };
