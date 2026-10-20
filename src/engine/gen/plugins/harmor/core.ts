// Harmor plugin / part state of the engine: FL's TTestPlug fields the voice
// engine reads (plug = TTestPlug instance, part = plug + 0x11f8 + p * 0xb70),
// filled from the parameters by a port of ProcessParam (0xd1220) and the part
// update functions (sample rate setup 0xd0190, part gain 0xcac00, pitch
// 0xcad90, partial count bases 0xcae50, unison table 0xcaf90, ratio table
// 0xe67e0, timbre / phase tables 0xe5d60). Field comments give FL's offsets;
// float32 fields are rounded with Math.fround exactly where FL stores floats.

import { exp as lexp, log as llog, sin as lsin, cos as lcos } from './fx-libm';
import type { HPart, HGlobal } from '../../../../model/gen/plugins/harmor/types';
import { PARAM_COUNT, PART_PARAMS, GLOBAL_FIRST } from '../../../../model/gen/plugins/harmor/params';
import { roundEven } from './vec';
import { GainRamp } from './ramp';
import { cos32fA11 } from './ipp';
import { mainShape, filterSetup, filterRange, resSetup, phaserTempo, PartShapes } from './filters';
import { mapTables } from './partials';
import { compileCurve, mapFill32, mapFill64, mapAt, curveLength, mapConstant, mapIterInit, mapIterNext, CurveState, type Curve } from './env';

const f = Math.fround;

/** Slots of a voice's sine bank: 0 resonance oscillator, 1..3 sub-harmonics, 4..519 harmonics 1..516. */
export const SLOTS = 520;
/** Runtime constants FL computes at load (__common): ln 2, 1 / ln 2, ln 2 / 1200, log2(440), ln 3 (f32), ln 11 (f32). */
export const LN2 = 0.6931471805599453;
export const INV_LN2 = 1.4426950408889634;
export const LN2_1200 = 0.0005776226504666211;
export const LOG2_440 = 8.781359713524658;
export const LN3F = f(llog(3));
export const LN11F = f(llog(11));
/** G[0xa2d26c]: ln 7 (float32). */
export const LN7F = f(llog(7));
/** G[0xa35580]: numerator of FL's one-pole coefficients exp(K / (time * rate)): ln 0.01. */
export const K580 = llog(0.01);

/** FL's level law (0xcac00, 0xd2560): x == 1 ? 1 : f32((exp(f32(x * ln3f)) - 1) * 0.5). */
export function law3(x: number): number {
  const s = f(x);
  if (s === 1) return 1;
  return f((lexp(f(s * LN3F)) - 1) * 0.5);
}

/** Note (semitones, 60 = C5) to Hz (0xfcb10 / 0xfcac0: 2^((n - 57) / 12 + log2 440)). */
export function noteLog2Hz(n: number): number {
  return (n - 57) / 12 + LOG2_440;
}

/** Filter object (part + 0x3e8 / + 0x4a8, 0xc0 bytes): the fields ProcessParam writes. */
export class FilterDsp {
  /** +0x7c envelope amount (param 56 / 68, v * 0.001). */
  env = 0;
  /** +0x80 base and +0x88 scale of the frequency control (set by the shape setup 0xcb430). */
  base = 0;
  scale = 1;
  /** +0xa0 frequency control: base + v / 8192 * scale (param 52 / 64). */
  freq = 0;
  /** +0xa4 = 2^(+0xa8), +0xa8 resonance offset in octaves (param 60 / 72, v / 1200). */
  resOfsMul = 1;
  resOfs = 0;
  /** +0xb0 resonance width (param 59 / 71, v * 0.004). */
  resWidth = 0;
  /** +0xbc adaptive (param 51 / 63 > 0). */
  adapt = false;
  /** Shape types (+0x8 of the shape objects: f1Type / r1Type ...). */
  type = 0;
  resType = 0;
  // --- filters fields ---
  /** +0x0 parameter base (part offset + 12 * filter), +0xac width (param 54 / 66 * 0.004). */
  pofs = 0;
  width = 0;
  /** +0x84 top, +0x8c 2 * scale, +0x90 1 / scale, +0x94 centre, +0x98 scale / 2 of the frequency range (0xcb430). */
  top = 0;
  scale2 = 0;
  inv = 0;
  center = 0;
  half = 0;
  /** +0xb4 resonance index scale, +0xb8 (0xcb6e0). */
  b4 = 0;
  b8 = 0;
}

/** Part state (FL part record). */
export class PartDsp {
  /** +0x8: parameter offset (0 or 386). */
  readonly pofs: number;
  readonly idx: 0 | 1;
  /** +0xc: part enabled. */
  on = false;
  /** +0x10 pitch envelope amount (param 44: v * 2). */
  pitchAmt = 0;
  /** +0x14 part gain (0xcac00). */
  gain = 0;
  /** +0x18 envelope volume law (param 12). */
  envVol = 0;
  /** +0x1c part mix (param 782). */
  mix = 0.5;
  /** +0x20 -log2(harmonic ratio). */
  f20 = 0;
  /** +0x28 total pitch offset (cents, double) = +0x38 + +0x30. */
  pitchSum = 0;
  /** +0x30 frequency multiplier offset (cents, double). */
  f30 = 0;
  /** +0x38 main pitch (param 786, cents, double). */
  mainPitch = 0;
  /** +0x40 harmonic ratio (double): param 42 / (param 43 * 10000). */
  ratio = 1;
  /** +0x48 resonance oscillator pitch offset. TODO(units): written by the filter setup. */
  f48 = 0;
  /** +0x4c vibrato phase (cycles, shared by the part's voices; advanced per render call). */
  vibPh = 0;
  /** +0x50 vibrato phase increment per sample, +0x54 vibrato depth (cents). */
  vibSpeed = 0;
  vibDepth = 0;
  /** +0x58 portamento speed. */
  porta = 0;
  /** +0x5c image mode (0 none, 1 image, 2 resynthesis...). */
  imgMode = 0;
  /** +0x60 timbre blending mode, +0x64 sub-harmonic mode. */
  blend = 0;
  subMode = 0;
  /** +0x68 slot levels of slots 0..3 (resonance oscillator, subs). */
  readonly subAmp = new Float32Array(4);
  /** +0x70 unison pitch table (map 8) or null; +0x78 formant table (map 9) or null. */
  uniPitchTab: Float32Array | null = null;
  formantTab: Float32Array | null = null;
  /** +0x80 local EQ table {ptr, offset, count} (map 0). */
  readonly localEq = new Float32Array(SLOTS).fill(1);
  localEqOfs = 0;
  localEqCount = 0;
  /** +0x90 protection table (map 5) {+0x98 offset, +0x9c count}. */
  readonly protectTab = new Float32Array(SLOTS);
  protectOfs = 0;
  protectCount = 0;
  /** +0xa0 randomness table (map 4) {+0xa8 offset, +0xac count}. */
  readonly randTab = new Float32Array(SLOTS);
  randOfs = 0;
  randCount = 0;
  /** +0xb0 clipping table (map 6) {+0xb8 offset, +0xbc count}; +0xc0 clipping mode. */
  readonly clipTab = new Float32Array(SLOTS);
  clipOfs = 0;
  clipCount = 0;
  clipMode = 0;
  /** +0xc8 / +0xd0 timbre 1 / 2 tables (after blending / local EQ), +0xd8 raw timbre 1. */
  readonly t1 = new Float32Array(SLOTS);
  readonly t2 = new Float32Array(SLOTS);
  readonly t1raw = new Float32Array(SLOTS);
  /** +0xe0 partial pitch mode (0 oct, 1 Hz). */
  pitchMode = 0;
  /** +0xe8 frequency ratio per slot (double); +0xf0 phase per slot (double, cycles + 1). */
  readonly ratios = new Float64Array(SLOTS);
  readonly phaseTab = new Float64Array(SLOTS);
  /** +0xf8 prism table (map 7, double); +0x100 prism mode; +0x104 prism from level. */
  readonly prismTab = new Float64Array(SLOTS);
  prismMode = 0;
  prismVol = 0;
  /** +0x110 ratio table dirty. */
  dirty = true;
  /** +0x114 prism amount (param 26 * 0.001). */
  prism = 0;
  /** +0x120 phase randomness (sign * (v/1000)^2), +0x124 starting phase (v * 0.001), +0x128 random seed. */
  phaseRand = 0;
  phaseOfs = 0;
  seed = 0;
  /** +0x198 / +0x19c partial count bases (0xcae50). */
  p198 = 0;
  p19c = 0;
  /** +0x1a0 predelay (samples), +0x1a4 polyphonic release. */
  predelay = 0;
  polyRel = 0;
  /** +0x1a8 highest partial frequency (Hz) from the main shape (0xcc010 type 300). */
  maxFreq = 17637.515625;
  /** +0x1b8 unison distribution, +0x1bc order, +0x1c0 pitch (cents), +0x1c4 phase, +0x1c8 volume compensation, +0x1cc 1/n, +0x1d0 1/(n-1), +0x1d4 0.5/(n-0.5), +0x1d8 panning. */
  uniDist = 0;
  uniN = 1;
  uniPitch = 0;
  uniPhase = 0;
  uniVol = 1;
  uniInv = 1;
  uniInv1 = 0;
  uniD4 = 1;
  uniPan = 0;
  /** +0x1e0 unison voice positions (double[16]). */
  readonly uniPos = new Float64Array(16);
  /** +0x228 sine bank amplitude smoothing, +0x22c ramping factor (cfb20). */
  smooth = 0;
  rampK = 0;
  /** +0x230 protection, +0x234 auto gain, +0x238 auto gain mode, +0x23c side. */
  protect = 0;
  autoGain = 0;
  agMode = 0;
  side = false;
  /** +0x248 clipping threshold, +0x250 pluck (double). */
  clip = 0;
  pluck = 0;
  /** +0x258 pluck shape (map 14). */
  readonly pluckTab = new Float32Array(SLOTS).fill(1);
  /** +0x260..+0x26c harmonic blur bottom / top {ln(e), 1/(e-1)}. */
  readonly hblur = new Float32Array(4);
  /** +0x270 / +0x274 blur attack / decay coefficients, +0x278 pluck replaces blur decay, +0x27c blur mix. */
  blurAtt = 0;
  blurDec = 0;
  pluckBlur = false;
  blurMix = 0;
  /** +0x280 blur mask (map 24). */
  readonly blurMask = new Float32Array(SLOTS).fill(1);
  /** +0x290 timbre mix. */
  tmix = 0;
  /** +0x2c8 global EQ mix. */
  eqMix = 0;
  /** Filters 1 / 2 (+0x3e8 / +0x4a8). */
  readonly flt = [new FilterDsp(), new FilterDsp()];
  /** +0x484 / +0x544 filter keyboard tracking (v * 0.001). */
  readonly fKey = new Float32Array(2);
  /** +0x488 resonance oscillator pitch, +0x48c resonance oscillator frequency factor. TODO(units). */
  resPitch = 0;
  resFreq = 1;
  /** +0x548 resonance oscillator count / flag. TODO(units). */
  i548 = 0;
  /** +0x570 phaser type (+200), +0x5a0 phaser phase, +0x5a8 phaser speed, +0x5b0 tempo base, +0x5c0 phaser offset. */
  phType = 0;
  phPhase = 0;
  phSpeed = 0;
  phTempo = 0;
  phOfs = 0;
  /** +0x5c4 harmonizer width, +0x5cc harmonizer strength. */
  hzWidth = 0;
  hzStr = 0;
  /** +0x624 tremolo depth ramp (targets +0x628 / +0x62c = param 17), +0x64c tremolo phase (cycles), +0x650 speed (cycles / sample), +0x654 stereo gap. */
  readonly tremRamp = new GainRamp();
  tremPh = 0;
  tremSpeed = 0;
  tremGap = 0;
  /** +0x658 tremolo gains of the current render call (interleaved stereo), valid while tremOn. */
  trem: Float32Array = new Float32Array(0);
  tremOn = false;
  /** +0x660 declicker (FL's shared TDeclicker): attack window (raised cosine, (declick/1000)^2 * 25 ms, only with declicking) and the 10 ms release window. */
  readonly declAtt = new Float32Array(48000);
  declAttLen = 0;
  readonly declRel = new Float32Array(4800);
  declRelLen = 0;
  /** +0x668 declicking, +0x66c ramping (part setting). */
  declick = 0;
  ramp = 0;
  /** +0xa6c unit order, +0xb60 last unit index, +0xb64 filter unit flag, +0xb68 unit 0 first. */
  readonly order = new Int32Array(12);
  unitCount = 0;
  b64 = 0;
  b68 = false;
  /** Model state (curves) of the part and its 26 compiled shaping maps (part+0x7c8 + 8 i). */
  st: HPart | null = null;
  maps: Curve[] = [];

  // --- units fields --- (partials.ts; stubs added by the lead to keep the build compiling)
  /** part+0xb69: harmonizer energy mode flag (0xca920). */
  b69 = false;
  /** Blur mask range (map 24 table part+0x280). */
  blurMaskOfs = 0;
  blurMaskCount = 0;
  /** Flat clipping map value (or -1 / NaN as FL encodes it). */
  clipFlat = -1;
  /** Formant (map 9) and unison pitch (map 8) table storage. */
  readonly formantBuf = new Float32Array(SLOTS);
  readonly uniPitchBuf = new Float32Array(SLOTS);
  /** Harmonizer distribution (map 16, part+0x5dc) and mask (map 23, part+0x610 {ofs, count}). */
  readonly hzDist = new Float32Array(16);
  readonly hzMask = new Float32Array(SLOTS).fill(1);
  hzMaskOfs = 0;
  hzMaskCount = 0;
  /** Image frequency mask (map 25, part+0x180 {ofs, count}). */
  readonly imgMask = new Float32Array(SLOTS).fill(1);
  imgMaskOfs = 0;
  imgMaskCount = 0;
  /** Flat prism map value (or -1). */
  prismFlat = -1;
  // --- filters fields ---
  /** Shape objects (main part+0x298, masks +0x2d0.., filter / resonance shapes in the filter objects, phaser +0x568). */
  readonly shp = new PartShapes();

  constructor(idx: 0 | 1) {
    this.idx = idx;
    this.pofs = idx * PART_PARAMS;
  }

  /**
   * Main shape gains per partial (0xcbb40 on the shape object part+0x298, type 300):
   * table read over log2 Hz (./filters.ts).
   */
  shapeGains(logf: Float32Array, out: Float32Array, n: number): void {
    mainShape(this, logf, out, n);
  }
}

/** Plugin state (FL TTestPlug). */
export class PlugDsp {
  readonly sr: number;
  /** +0xe40 control block length (88 at 44.1 kHz, envelope granularity 200). */
  blk = 88;
  /** +0xe44 tempo (BPM). */
  tempo = 120;
  /** +0x148: the 825 parameters as FL holds them (int). */
  readonly p = new Int32Array(PARAM_COUNT);
  readonly parts = [new PartDsp(0), new PartDsp(1)];
  /** +0x1118 mod X / Y / Z (params 772..774: v / 512) and +0x1124 = X (reference of the X speed input). */
  readonly mod = new Float32Array(4);
  /** +0x1128..+0x1134 per-block smoothing of the voices' X / Y / Z (100 ms with Smooth modulation, else 0) and of the X reference (1.25 s). */
  readonly modK = new Float32Array(4);
  modSmooth = false;
  /** +0x10e4 highest slot count (520). */
  maxSlots = SLOTS;
  /** +0x10e8 monophonic mode, +0x10a4 voice randomness, +0x10a8 same random. */
  mono = 0;
  voiceRand = 0;
  sameRand = false;
  /** +0x10ec frequency ceiling (normalized): 1048576 / sr. */
  freqCeil = 0;
  /** +0x10f0 global LFO amount, +0x10f4 block * 0.0005, +0x10f8 legato limit. */
  lfoAmt = 0;
  f10f4 = 0;
  legatoLimit = 0x7fffffff;
  /** +0x1100 glide coefficient (40 ms), +0x1104 / +0x1108 tremolo fade, +0x110c, +0x1110. */
  glide = 0;
  fadeStep = 0;
  fadeLen = 0;
  f110c = 0;
  f1110 = 0;
  /** +0x113c strum mode, +0x1140 strum time (samples), +0x1148 strum tension, +0x114c strum off. */
  strumMode = 0;
  strumTime = 0;
  strumTension = 1;
  /** +0x1150 precision (0 average, 1 high, 2 perfect); +0x1158 sine bank precision. */
  precision = 0;
  /** Gain ramp coefficient (plug+0xd0 object +0x48): exp(ln 0.01 / (15 ms * sr)), measured at 22.05..96 kHz. */
  rampCoef = 0;
  /** plug+0xea4 + color * 32: levels of the last note per colour (porta source; pitch NaN = none). */
  readonly lastNote = Array.from({ length: 16 }, () => new Float32Array([0, 0, NaN, 0, 0, 0]));
  /** Global settings (model). */
  g: HGlobal | null = null;

  constructor(sr: number) {
    this.sr = sr;
    this.setRate(200, false);
  }

  /** 0xd0190 (the part of it the voices use): block length from the envelope granularity. */
  setRate(grain: number, hq: boolean): void {
    const sr = this.sr;
    const g = hq ? 0.5 : f(grain * f(0.01));
    this.blk = Math.max(4, roundEven(g * 0.001 * sr * 0.25) * 4);
    const blk = this.blk;
    this.glide = f(lexp(K580 / ((0.04 * sr) / blk)));
    this.fadeLen = roundEven(0.1 * sr);
    this.fadeStep = f(1 / (this.fadeLen + 1));
    this.f1110 = (K580 * blk) / sr;
    this.f110c = 1 - roundEven((0.002 * sr) / blk);
    this.f10f4 = f(blk * 0.0005);
    this.freqCeil = f(1048576 / sr);
    this.rampCoef = f(lexp(K580 / (0.015 * sr)));
    // 0xd00a0 / 0xd0758: X / Y / Z smoothing coefficients
    const k = this.modSmooth ? f(lexp(K580 / ((0.1 * sr) / blk))) : 0;
    this.modK[0] = this.modK[1] = this.modK[2] = k;
    this.modK[3] = f(lexp(K580 / ((1.25 * sr) / blk)));
    // The highest partial frequency (part+0x1a8) comes from the main shape (filters.ts, 0xcc010 type 300).
    for (const pt of this.parts) {
      phaserTempo(this, pt); // 0xcfa60
      pt.tremRamp.coef = this.rampCoef;
      this.rampSetup(pt);
      this.countBases(pt);
    }
  }

  /** Tempo change (FL re-applies the tempo-dependent parameters): predelay, porta, phaser speed base. */
  setTempo(tempo: number): void {
    if (tempo === this.tempo) return;
    this.tempo = tempo;
    for (const pt of this.parts) {
      this.param(pt.pofs + 2, this.p[pt.pofs + 2]);
      this.param(pt.pofs + 49, this.p[pt.pofs + 49]);
      phaserTempo(this, pt); // 0xcfa60 (re-applies param 80)
    }
  }

  /** 0xcfb20: sine bank smoothing (part+0x228) and ramping factor (part+0x22c) from the part's ramping setting. */
  rampSetup(pt: PartDsp): void {
    const s = f(Math.abs(pt.ramp) * f(0.001));
    const s8 = s === 1 ? s : f((lexp(f(s * LN7F)) - 1) * 0.1666666716337204);
    let d8 = f(s8 * 25) * 0.001 * this.sr;
    if (!(d8 > 1)) d8 = 1;
    pt.smooth = f(lexp(K580 / d8));
    pt.rampK = pt.ramp > 0 ? f(K580 / (d8 * lexp(noteLog2Hz(60) * LN2) * 0.699999988079071)) : 0;
    this.declickSetup(pt);
  }

  /** 0xcfce0 / 0x46bc70 / 0x46bec0 (type 3 windows): declicker attack and release tables. */
  declickSetup(pt: PartDsp): void {
    const sr = this.sr;
    const win = (tab: Float32Array, ms: number, rel: boolean): number => {
      const len = Math.min(tab.length, Math.max(1, roundEven(ms * 0.001 * sr)));
      // VectorSlope (1, 1) or (len, -1), x (1 / (len + 1)) * pi, ippsCos_32f_A11, + 1, x 0.5
      const c = f((1 / (len + 1)) * Math.PI);
      for (let i = 0; i < len; i++) tab[i] = f((rel ? i + 1 : len - i) * c);
      cos32fA11(tab, tab, len);
      for (let i = 0; i < len; i++) tab[i] = f(f(tab[i] + 1) * 0.5);
      return len;
    };
    if (pt.declick !== 0) {
      const x = f(pt.declick * f(0.001));
      pt.declAttLen = win(pt.declAtt, x * x * 25, false);
    } else pt.declAttLen = 0;
    pt.declRelLen = win(pt.declRel, 10, true);
  }

  /** Recompute everything from the parameters and the model state (state load / any edit). */
  applyAll(): void {
    const P = this.p;
    for (let i = GLOBAL_FIRST; i < PARAM_COUNT; i++) this.param(i, P[i]);
    for (const pt of this.parts) {
      for (let li = 0; li < 95; li++) this.param(pt.pofs + li, P[pt.pofs + li]);
      filterSetup(this, pt);
      mapTables(this, pt);
      this.ratioTable(pt);
      this.localEqTable(pt);
      this.timbre(pt, -1);
      this.timbre(pt, 0);
      if (pt.blend <= 0) this.timbre(pt, 1);
      this.pitch(pt);
      this.countBases(pt);
      this.unisonTable(pt);
      this.partGain(pt);
    }
  }

  /** ProcessParam (0xd1220): store the value and update the derived fields. */
  param(i: number, v: number): void {
    v |= 0;
    this.p[i] = v;
    if (i >= GLOBAL_FIRST) { this.globalParam(i, v); return; }
    const pt = this.parts[i < PART_PARAMS ? 0 : 1];
    const li = i - pt.pofs;
    if (li >= 95) return; // articulator parameters: ArtPart.setup
    this.partParam(pt, li, v);
  }

  private partParam(pt: PartDsp, li: number, v: number): void {
    const sr = this.sr, P = this.p, o = pt.pofs;
    const K001 = f(0.001), K1024 = f(1 / 1024);
    switch (li) {
      case 0: pt.phaseOfs = f(f(v) * K001); break;
      case 1: { const d = f(f(v) * K001); pt.phaseRand = f(d * d * (v === 0 ? 0 : v < 0 ? -1 : 1)); break; }
      case 2: {
        const s = v >= 0 ? f((v * 0.3125) / this.tempo) : f((lexp(v * -0.020833333333333332 * LN2) - 1) * 0.00392156862745098);
        pt.predelay = f(s * sr);
        break;
      }
      case 3: pt.polyRel = f(f(v) * K001); break;
      case 4: pt.tmix = f(f(v) * K001); break;
      case 5: case 6: case 7: pt.subAmp[li - 4] = f(f(v) * K1024); break;
      case 8: {
        const x = f(f(v) * K1024);
        pt.protect = x === 1 ? 1 : f((lexp(f(x * LN11F)) - 1) * 0.10000000149011612);
        break;
      }
      case 9: pt.clip = f(f(v) * K1024); break;
      case 11: this.partGain(pt); break;
      case 12: pt.envVol = law3(f(v) * K001); break;
      case 13: { const x = f(f(v) * K001); pt.autoGain = f(x * x); break; }
      case 17: pt.tremRamp.tL = pt.tremRamp.tR = f(f(v) * K001); break;
      case 18: pt.tremSpeed = f(lexp((6 - v * 0.001) * LN2) / sr); break;
      case 19: pt.tremGap = f(f(f(v) * K001) * Math.PI); break; // TODO(verify): 0x2a2e00 applied to v * 0.001
      case 20: pt.blurMix = f(v * v * 1e-6); break;
      case 21: case 22: {
        const x = ((lexp(v * 0.01 * LN2) - 1) * 0.001 * sr) / this.blk;
        const c = x > 0 ? f(lexp(K580 / x)) : 0;
        if (li === 21) pt.blurAtt = c; else pt.blurDec = c;
        break;
      }
      case 24: case 25: {
        // 0xd2fe0: e - 1 = f32(exp(v / 1000 * 13.815511557963774) - 1); {ln(e), 1 / (e - 1)}; v <= 0 clears ln(e) only
        const k = (li - 24) * 2;
        if (v <= 0) { pt.hblur[k] = 0; break; }
        const em1 = f(lexp(f(f(v) * K001) * 13.815511557963774) - 1);
        pt.hblur[k] = f(llog(em1 + 1));
        pt.hblur[k + 1] = f(1 / em1);
        break;
      }
      case 26: pt.prism = f(f(P[o + 26]) * K001); break;
      case 28: pt.hzWidth = f(f(v) * K001); break;
      case 29: pt.hzStr = f(lexp(f(f(v) * f(1 / 256)) * LN2) * 1.3310003559094952); break;
      case 34: {
        const n = Math.max(1, v);
        pt.uniN = n;
        pt.uniInv = f(1 / n);
        pt.uniInv1 = f(1 / (n - 1));
        pt.uniD4 = f(0.5 / (n - 0.5));
        pt.uniVol = n > 1 ? f(1 - (lexp((1 - 1 * pt.uniInv) * 1.0986122886681098) - 1) * 0.5) : 1;
        this.unisonTable(pt);
        break;
      }
      case 35: pt.uniDist = v; this.unisonTable(pt); break;
      case 37: pt.uniPan = v <= 192 ? f(v * 0.005208333333333333) : f(1 + (v - 192) * 0.046875); break;
      case 38: pt.uniPitch = f((lexp(f(f(v) * f(1 / 256)) * 3.713572066704308) - 1) * 1.875); break;
      case 39: pt.uniPhase = f(f(v) * K001); break;
      case 40: case 41: this.pitch(pt); break;
      case 42: case 43: {
        pt.ratio = P[o + 42] / (P[o + 43] * 10000);
        pt.f20 = f(-(llog(pt.ratio) * INV_LN2));
        pt.dirty = true;
        this.countBases(pt);
        this.pitch(pt);
        break;
      }
      case 44: pt.pitchAmt = f(v * 2); break;
      case 45: pt.vibDepth = f(v * 0.1); break;
      case 46: pt.vibSpeed = f(lexp((3 - f(v) * K001) * LN2) / sr); break;
      case 47: case 49: {
        // porta speed (0xd2130): negative portamento time = blocks of a linear glide, positive = tempo synced
        const pv = P[o + 49];
        let sp: number;
        if (pv < 0) sp = f((sr * (lexp(pv * -0.015625 * LN2) - 1)) / f(42 * this.blk));
        else sp = f(((sr * pv) * 0.3125) / f(this.tempo * this.blk));
        pt.porta = P[o + 47] === 0 ? f(-sp) : sp;
        break;
      }
      case 51: case 63: pt.flt[li === 63 ? 1 : 0].adapt = v > 0; break;
      case 52: case 64: { const F = pt.flt[li === 64 ? 1 : 0]; F.freq = f(F.base + v * 0.0001220703125 * F.scale); break; }
      case 54: case 66: filterRange(this, pt, li === 66 ? 1 : 0); break;
      case 58: case 61: case 70: case 73: resSetup(this, pt, li === 70 || li === 73 ? 1 : 0); break;
      case 55: case 67: pt.fKey[li === 67 ? 1 : 0] = f(f(v) * K001); break;
      case 56: case 68: pt.flt[li === 68 ? 1 : 0].env = f(f(v) * K001); break;
      case 59: case 71: pt.flt[li === 71 ? 1 : 0].resWidth = f(v * 0.004); break;
      case 60: case 72: {
        const F = pt.flt[li === 72 ? 1 : 0];
        F.resOfs = f(v * 0.0008333333333333334);
        F.resOfsMul = f(lexp(F.resOfs * LN2));
        if (li === 60) pt.resFreq = F.resOfsMul; // part+0x48c: resonance oscillator frequency factor
        break;
      }
      case 62: { const x = f(f(v) * K1024); pt.subAmp[0] = f(x * x); break; }
      case 75: pt.pluck = f(v) * K001; break;
      case 78: pt.phOfs = f(v * 0.0001); break;
      case 80: {
        // 0xd245c: sign(v) * 2^(|v| / 1000) * part+0x5b0 (double)
        const sg = v === 0 ? 0 : v < 0 ? -1 : 1;
        pt.phSpeed = sg * lexp(f(f(Math.abs(v)) * K001) * LN2) * pt.phTempo;
        break;
      }
      default: break;
    }
  }

  private globalParam(i: number, v: number): void {
    const K001 = f(0.001);
    switch (i) {
      case 772: case 773: case 774: this.mod[i - 772] = f(v * 0.001953125); this.mod[3] = this.mod[0]; break;
      case 775: this.legatoLimit = v > 0 ? v : 0x7fffffff; break;
      case 779: this.strumMode = v; break;
      case 780: this.strumTime = f(this.sr * (lexp(f(f(v) * K001) * 3.713572066704308) - 1) * f(0.00625)); break;
      case 781: this.strumTension = f(lexp(f(f(v) * K001) * LN2)); break;
      case 782: {
        const A = this.parts[0], B = this.parts[1];
        for (const pt of this.parts) {
          if (A.on && B.on) {
            let s = f(f(v) * K001);
            if (pt.idx === 1) s = f(1 - s);
            let c = f(lcos(s * Math.PI * 0.5));
            c = c < 0 ? 0 : c > 1 ? 1 : c;
            pt.mix = f(c * 0.5625);
          } else pt.mix = 0.5;
          this.partGain(pt);
        }
        break;
      }
      case 783: for (const pt of this.parts) this.partGain(pt); break;
      case 786: for (const pt of this.parts) this.pitch(pt); break;
      case 787: this.lfoAmt = f(f(v) * K001); break;
      default: break;
    }
  }

  /** 0xcac00: part gain = mix x law(pre-FX volume) x sign(vol) x law(|vol|). */
  partGain(pt: PartDsp): void {
    const K001 = f(0.001);
    const s8 = law3(f(this.p[783]) * K001);
    const s9 = f(pt.mix * s8);
    const x = f(f(this.p[pt.pofs + 11]) * K001);
    const s10 = law3(Math.abs(x));
    const sg = x === 0 ? 0 : x < 0 ? -1 : 1;
    pt.gain = f(s9 * f(s10 * sg));
  }

  /** 0xcad90: pitch offsets (cents). */
  pitch(pt: PartDsp): void {
    const P = this.p, o = pt.pofs;
    pt.mainPitch = P[786];
    let c = llog(P[o + 40] / (P[o + 41] * 10000)) * INV_LN2 * 1200;
    c = pt.imgMode === 2 ? c + 0 /* TODO(image): + image+0x148 */ : c - 1200;
    pt.f30 = c;
    pt.pitchSum = pt.mainPitch + c;
  }

  /** 0xcae50: partial count bases. */
  countBases(pt: PartDsp): void {
    if (pt.pitchMode === 0) {
      pt.p198 = pt.maxFreq;
      pt.p19c = f(lexp(pt.f20 * LN2) * 8);
    } else {
      pt.p198 = f(pt.maxFreq * lexp(f(F10E0 + pt.f20) * LN2));
    }
    if (pt.pitchMode === 0) pt.p198 = f(llog(pt.p198) * INV_LN2);
  }

  /** 0xe67e0: frequency ratio of every slot. */
  ratioTable(pt: PartDsp): void {
    pt.dirty = false;
    const R = pt.ratios;
    if (pt.pitchMode > 0) {
      for (let i = 0; i < 516; i++) R[4 + i] = 1 + i * pt.ratio; // VectorSlope_64f(1, ratio)
    } else {
      const c = f(Math.pow(2, f(pt.ratio * 0.125))); // 0x2cbf20 Power(2, f32(ratio * 0.125)), float result
      let d = 1;
      for (let i = 4; i < SLOTS; i++) { R[i] = d; d *= c; }
    }
    R[0] = 1;
    R[1] = 0.5;
    if (pt.subMode === 0) {
      R[2] = 1 + pt.ratio * 0.5;
      R[3] = 1 + pt.ratio * 1.5;
    } else {
      R[2] = 0.25;
      R[3] = 0.125;
    }
  }

  /** Load the part's model state: settings and compiled curves; rebuild the tables. */
  setPart(pt: PartDsp, st: HPart): void {
    pt.st = st;
    pt.on = st.on !== 0;
    pt.blend = st.blend | 0;
    pt.declick = st.declick | 0;
    pt.ramp = st.ramp | 0;
    pt.prismMode = st.prismMode | 0;
    pt.prismVol = st.prismVol | 0;
    pt.clipMode = st.clipMode | 0;
    pt.subMode = st.subMode | 0;
    pt.pitchMode = st.pitchMode | 0;
    pt.phType = st.phType | 0;
    pt.eqMix = f(st.eqMix);
    pt.side = st.side !== 0;
    pt.pluckBlur = st.pluckBlur !== 0;
    pt.agMode = st.agMode | 0;
    for (let i = 0; i < 12; i++) pt.order[i] = st.order[i] | 0;
    pt.maps = st.maps.map((m, i) => compileCurve(m, 'map', { offset: MAP_OFS[i] ?? 0 }));
    this.unitSetup(pt);
    this.rampSetup(pt);
  }

  /** 0xca920: unit chain from the unit order (unit 11 last = handled after the loop). */
  unitSetup(pt: PartDsp): void {
    pt.b68 = pt.order[0] === 0;
    let n = 12;
    pt.unitCount = n - 1;
    if (pt.order[n - 1] === 11) pt.unitCount--;
    // REND+0x84 start value: (u - 4) ^ 1 of the last filter unit in the order = index of the first filter run
    pt.b64 = 0;
    for (let i = 0; i < 12; i++) { const u = pt.order[i]; if (u === 4 || u === 5) pt.b64 = (u - 4) ^ 1; }
  }

  /**
   * 0xe00b0: a shaping map sampled per slot on a log-frequency axis (the map's
   * x range spans 9 octaves above harmonic 1): with `flag` slots 4..519 =
   * harmonics 1..516, slot 1 = slot 4, slots 2 / 3 at the sub-harmonic
   * positions, slot 0 = 1; without, 516 values from buf[0]. Flat maps fill y - offset.
   */
  mapLog(pt: PartDsp, c: Curve, buf: Float32Array, flag: boolean): void {
    const off = flag ? 4 : 0;
    const k = mapConstant(c);
    if (k !== null) {
      buf.fill(f(k - c.offset), 0, off + 516);
    } else {
      const d8 = curveLength(c) / 9;
      const st = MAPST;
      mapIterInit(c, st);
      let x = 0;
      for (let j = 0; j < 516; j++) {
        buf[off + j] = st.out;
        const nx = llog(j + 2) * INV_LN2 * d8;
        mapIterNext(c, st, nx - x);
        x = nx;
      }
      if (flag) {
        const sp = SUB_POS[pt.subMode ? 1 : 0];
        buf[2] = f(mapAt(c, llog(f(1 + sp[0])) * INV_LN2 * d8));
        buf[3] = f(mapAt(c, llog(f(1 + sp[1])) * INV_LN2 * d8));
      }
    }
    if (flag) {
      if (k === null) buf[1] = buf[4];
      buf[0] = 1;
    }
  }

  /** 0xe1070: local EQ table (map 0): Hz pitch mode (4v)^2 / harmonic (a saw baseline), else v^2; then both timbres. */
  localEqTable(pt: PartDsp): void {
    const c = pt.maps[0];
    if (!c) return;
    const buf = pt.localEq;
    this.mapLog(pt, c, buf, true);
    if (pt.pitchMode > 0) {
      for (let j = 0; j <= 515; j++) { const v = f(buf[4 + j] * 4); buf[4 + j] = f((v * v) / (j + 1)); }
      { const v = f(buf[1] * 4); buf[1] = f(v * v); }
      const sp = SUB_POS[pt.subMode ? 1 : 0];
      { const v = f(buf[2] * 4); buf[2] = f((v * v) / f(1 + sp[0])); }
      { const v = f(buf[3] * 4); buf[3] = f((v * v) / f(1 + sp[1])); }
    } else {
      for (let i = 0; i < SLOTS; i++) buf[i] = f(buf[i] * buf[i]);
    }
    pt.localEqOfs = 0;
    pt.localEqCount = SLOTS;
  }

  /** 0xe5d60: harmonic phase table (which = -1), timbre 1 (0) / timbre 2 (1). */
  timbre(pt: PartDsp, which: -1 | 0 | 1): void {
    const SUBPOS = SUB_POS[pt.subMode ? 1 : 0];
    if (which < 0) {
      const c = pt.maps[1];
      if (!c) return;
      const buf = pt.phaseTab;
      mapFill64(c, buf, 4, 516, 0);
      buf[0] = 0;
      buf[1] = buf[4];
      const k = curveLength(c) / 515;
      buf[2] = mapAt(c, SUBPOS[0] * k);
      buf[3] = mapAt(c, SUBPOS[1] * k);
      for (let i = 0; i < 519; i++) buf[i] += 1;
      return;
    }
    const c = pt.maps[2 + which];
    if (!c) return;
    const buf = TMP;
    mapFill32(c, buf, 4, 516, 0);
    buf[0] = 1;
    buf[1] = buf[4];
    const k = curveLength(c) / 515;
    buf[2] = f(mapAt(c, SUBPOS[0] * k));
    buf[3] = f(mapAt(c, SUBPOS[1] * k));
    for (let i = 1; i < 519; i++) { const v = f(buf[i] * 4); buf[i] = f(v * v); }
    buf[1] = buf[4];
    if (which === 1 && pt.blend >= 1) {
      const T = pt.t1raw;
      switch (pt.blend) {
        case 1: for (let i = 0; i < SLOTS; i++) { const d = f(T[i] - buf[i]); buf[i] = d < 0 ? 0 : d; } break;
        case 2: for (let i = 0; i < SLOTS; i++) buf[i] = f(buf[i] * T[i]); break;
        case 3: for (let i = 0; i < SLOTS; i++) buf[i] = Math.max(buf[i], T[i]); break;
        case 4: for (let i = 0; i < SLOTS; i++) buf[i] = Math.min(buf[i], T[i]); break;
        case 5: {
          for (let i = 0; i < SLOTS; i++) buf[i] = f(buf[i] * pt.pluckTab[i]);
          const lo = f(lexp(-16 * LN2));
          for (let i = 0; i < SLOTS; i++) if (buf[i] < lo) buf[i] = lo;
          break;
        }
        default: break;
      }
    }
    if (which === 0) pt.t1raw.set(buf);
    if (pt.b68 && (which === 0 || pt.blend !== 5)) {
      const o = pt.localEqOfs, cnt = Math.min(SLOTS - o, pt.localEqCount);
      for (let i = 0; i < cnt; i++) buf[o + i] = f(buf[o + i] * pt.localEq[o + i]);
    }
    (which === 0 ? pt.t1 : pt.t2).set(buf);
    if (which === 0 && pt.blend > 0) this.timbre(pt, 1);
  }

  /** 0xcaf90: unison voice positions. */
  unisonTable(pt: PartDsp): void {
    const n = pt.uniN;
    if (n <= 1) return;
    const TAB = UNI_TAB;
    const mode = Math.min(pt.uniDist, 2);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      let d: number;
      if (pt.uniDist >= 3) {
        const s = pt.uniDist === 3
          ? f(Math.abs(f(f(f(i + 0.25) / f(n - 0.5)) * 2) - 1))
          : f(Math.abs(f(f(f(i + 0.5) * pt.uniInv) * 2) - 1));
        d = s;
        if (alt(i, n)) d = -d;
        pt.uniPos[i] = d;
        continue;
      }
      d = f(Math.abs(f(f(i * pt.uniInv1) * 2) - 1));
      if (alt(i, n)) d = -d;
      const t = TAB[mode][i % 9];
      pt.uniPos[i] = mode > 0 ? d * t : d + pt.uniInv1 * t;
      sum += pt.uniPos[i];
    }
    if (pt.uniDist < 2) {
      sum /= n;
      for (let i = 0; i < n; i++) pt.uniPos[i] -= sum;
    }
  }
}

/** Value offsets of the 26 shaping maps (TMMap d[+0x18], FL part constructor): bipolar maps 0.5. */
const MAP_OFS = [0, 0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
/** plug+0x10e0: partial count margin (octaves). */
const F10E0 = 0.0625;

/** Positions (in harmonic index units) of sub slots 2 / 3 per sub-harmonic mode (table 0x8ec4d0). */
const SUB_POS = [[0.5, 1.5], [0, 0]];
const TMP = new Float32Array(SLOTS);
const MAPST = new CurveState();

/** Unison distribution table (0x8ec3f8, 9 doubles per mode: Classic offsets, Blurred, Uniform). */
const UNI_TAB = [
  [0.3069306930693069, -0.2897196261682243, 0.3924050632911392, -0.22302158273381295, 0.5081967213114754, -0.2366412213740458, 0.43661971830985913, -0.34831460674157305, 0.2743362831858407],
  [0.8904719501335708, 1.0764262648008611, 0.9115770282588879, 1.1025358324145536, 1.0341261633919339, 1.1668611435239207, 0.8539709649871904, 1.2062726176115801, 1.0],
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
];

/** Alternation sign of unison voice i (0xcb098): odd index XOR (odd count and 2i > n). */
function alt(i: number, n: number): boolean {
  const odd = (i & 1) === 1;
  const late = (n & 1) === 1 && 2 * i > n;
  return odd !== late;
}
