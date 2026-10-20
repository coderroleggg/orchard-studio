// SimSynth: the shared patch data FL's engine calls `synth` (one per plugin: the
// three oscillator records, the LFO record, both envelopes, the filter settings
// and the three 4096-point oscillator wavetables) and synth::MakeSamp (0x5e7c),
// which builds an oscillator's table from its shape, pulse width and octave switches.

import { SAW, SINE, SINE4, TRI } from './tables';
import { f32, fmaf } from './fmath';

/** An oscillator record (0xc008 + 0x34 k; k = 3 is the LFO record at 0xc0a4). */
export class OscRec {
  /** +0x00 LFO amount -100..100 (LFO record: unused). */
  lfo = 0;
  /** +0x04 pulse width 2..98. */
  pw = 0;
  /** +0x08 coarse in cents (-2400..2400 by 100; LFO record: rate 0..999). */
  coarse = 0;
  /** +0x0c fine -100..100 cents. */
  fine = 0;
  /** +0x10 (LFO record: delay 0..100). */
  f10 = 0;
  /** +0x14 level 0..100. */
  level = 0;
  /** +0x18 envelope amount -100..100. */
  env = 0;
  /** +0x1c off switch (1 = off). */
  off = 0;
  /** +0x20 / +0x24 +1 / +2 octave switches. */
  oct1 = 0;
  oct2 = 0;
  /** +0x28 warm (LFO record: retrigger). */
  warm = 0;
  /** +0x2c shape: 0 square, 1 saw, 2 triangle, 3 noise, 4 sine (LFO: 0..3). */
  type = 0;
  /** +0x30 osc 1: ring modulation 1x2; osc 3: sync (never set). */
  ring = 0;
}

export class Synth {
  /** 0xc000 / 0xc001 / 0xc004: quality, render (FL: always 1, 0 after creation). */
  quality = 0;
  render = 0;
  renderInt = 0;
  readonly osc: OscRec[] = [new OscRec(), new OscRec(), new OscRec(), new OscRec()];
  /** 0xc0d8 / 0xc0ec: amplitude envelope stage times (ms) and levels (0..255). */
  readonly env1Times = new Int32Array(5);
  readonly env1Lv = new Int32Array(5);
  /** 0xc100 / 0xc114: filter envelope. */
  readonly env2Times = new Int32Array(5);
  readonly env2Lv = new Int32Array(5);
  /** 0xc128: TRACK AMP off (the filter follows the filter envelope instead of the amplitude envelope). */
  trackAmpOff = 0;
  /** synth_filt (0xc12c): cutoff 0..255, envelope / LFO amounts -127..127, emphasis, high / band / low 0..255. */
  cut = 0;
  fEnv = 0;
  fLfo = 0;
  emph = 0;
  high = 0;
  band = 0;
  low = 0;
  /** 0xc15c (int 15, unused), 0xc160 (double 31, unused), 0xc164 keyboard tracking 0..1. */
  b15c = 0;
  f160 = 0;
  kb = 0;
  /** 0xc178: 0x2253 = SVF off. */
  svfOff = 0;
  /** 0xc194: double 40 squared (unused by the renderer), 0xc19c: VCA Velo. */
  d40sq = 0;
  vca = 0;
  readonly waves = [new Float32Array(4096), new Float32Array(4096), new Float32Array(4096)];
  /** What each table was built from (-1: rebuild). */
  readonly waveKey = new Float64Array([-1, -1, -1]);

  /** synth::synth (0x61dc). */
  constructor() {
    for (let k = 0; k < 4; k++) {
      const r = this.osc[k];
      r.lfo = 0; r.pw = 50; r.coarse = k === 3 ? 12 : 0; r.fine = 0; r.level = 255; r.env = 0;
      r.off = k === 1 || k === 2 ? 1 : 0; r.oct1 = 0; r.oct2 = 0; r.warm = 0; r.type = k === 3 ? 2 : 1; r.ring = 0;
    }
    this.env1Times.set([0, 400, 0, 0, 2]);
    this.env1Lv.set([255, 0, 0, 0, 0]);
    this.env2Times.set([0, 64, 0, 0, 2]);
    this.env2Lv.set([255, 0, 0, 0, 0]);
    this.cut = 64; this.fEnv = 64; this.emph = 0; this.high = 255; this.band = 0; this.low = 0;
    this.svfOff = 0x2254;
    this.vca = 0;
  }
}

const K4096 = f32(40.959999084472656); // 0x4223d70a
const K065 = f32(0.6499999761581421); // 0x3f266666
const K02275 = f32(0.22749999165534973); // 0x3e68f5c2 (not the float nearest 0.2275)
const K96 = f32(0.010416666977107525); // 0x3c2aaaab

/** The engine's scratch tables (process globals at 0xbad14 / 0xbed14): a noise shape reuses the last table. */
const TMP = new Float32Array(4096);
const OCT2 = new Float32Array(4096);

/**
 * The base table last generated into TMP (FL rebuilds identical tables for every voice;
 * a repeat only refreshes TMP, which a noise shape copies).
 */
let tmpType = -1, tmpPw = -1;

function fillTmp(type: number, pw: number): void {
  if (type === tmpType && (pw === tmpPw || type === 1 || type === 2)) return;
  switch (type) {
    case 0: {
      // pulse: a one-pole step up to +0.65, down to -0.65 at the width, back toward 0 over the last 8 points
      const lim = f32(f32(pw) * K4096);
      let v = 0, i = 0;
      if (lim > 0) { do { v = fmaf(v, K065, K02275); TMP[i++] = v; } while (lim > f32(i)); }
      if (i <= 0xff7) {
        for (; i < 0xff8; i++) { v = fmaf(v, K065, -K02275); TMP[i] = v; }
      }
      if (i <= 0xfff) for (; i < 4096; i++) { v = f32(v * K065); TMP[i] = v; }
      break;
    }
    case 1: TMP.set(SAW); break;
    case 2: TMP.set(TRI); break;
    case 4: {
      // sine morphing toward sine^4 with the pulse width
      const m = f32(f32(pw + 2) * K96);
      for (let i = 0; i < 4096; i++) TMP[i] = fmaf(f32(SINE4[i] - SINE[i]), m, SINE[i]);
      break;
    }
    default: return;
  }
  tmpType = type;
  tmpPw = pw;
}

/** synth::MakeSamp (0x5e7c). */
export function makeSamp(sy: Synth, k: number): void {
  const r = sy.osc[k];
  const type = r.type, o1 = r.oct1, o2 = r.oct2;
  const pw = r.pw & 0xffff;
  if ((type >>> 0) <= 4 && type !== 3) fillTmp(type, pw);
  const w = sy.waves[k];
  // the same inputs give the same table (FL recomputes it for every voice)
  const key = type === 3 ? -1 : ((type * 65536 + pw) * 4 + (o1 !== 0 ? 1 : 0) + (o2 !== 0 ? 2 : 0)) * 2 + (sy.render === 0 ? 1 : 0);
  if (key >= 0 && sy.waveKey[k] === key) return;
  sy.waveKey[k] = key;
  w.set(TMP);
  if (o1 !== 0 && o2 !== 0) {
    for (let p = 0; p < 2; p++) for (let j = 0; j < 2048; j++) OCT2[p * 2048 + j] = TMP[2 * j];
    for (let q = 0; q < 4; q++) for (let j = 0; j < 1024; j++) w[q * 1024 + j] = f32(TMP[4 * j] + f32(OCT2[q * 1024 + j] + TMP[q * 1024 + j]));
  } else if (o1 !== 0) {
    for (let p = 0; p < 2; p++) for (let j = 0; j < 2048; j++) w[p * 2048 + j] = f32(TMP[p * 2048 + j] + TMP[2 * j]);
  } else if (o2 !== 0) {
    for (let q = 0; q < 4; q++) for (let j = 0; j < 1024; j++) w[q * 1024 + j] = f32(TMP[q * 1024 + j] + TMP[4 * j]);
  }
  if (sy.render === 0) {
    let a = w[0];
    for (let i = 0; i < 4095; i++) { const b = w[i + 1]; w[i] = f32(f32(a + b) * 0.5); a = b; }
  }
}

/** Tests: clear the shared scratch table (a freshly loaded engine library). */
export function resetScratch(): void {
  TMP.fill(0);
  OCT2.fill(0);
  tmpType = -1;
  tmpPw = -1;
}
