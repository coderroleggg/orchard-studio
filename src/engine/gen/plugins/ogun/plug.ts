// Ogun's plugin object (FL's TTestPlug, Ogun_x64.dylib, FL 2026 arm64): the parameters and settings of the state turned into
// the values the voices and the effects read (ProcessParam 0x6bc70 and its handlers, UpdateAll 0x68490), the synthesizer
// (TFFTSynth) with its four shaping maps, the 13 articulators and the sample-rate / quality dependent timing.
//
// Plugin fields by FL offset in brackets: master gain +0x5cc, master pitch +0x5d0, timbre scalars +0x258..+0x268, seed hashes
// +0x24c / +0x250, filter base +0x540 / +0x544, control block +0x594, hop +0x248.

import type { FxParams } from '../../../../model/fx/types';
import { OGUN_KEYS, ART_TARGETS } from '../../../../model/gen/plugins/ogun/params';
import type { OgArt, OgEnv } from '../../../../model/gen/plugins/ogun/types';
import { FftSynth, seedHash } from './fftsynth';
import { OgunArt, LIVE_ARTS } from './art';
import { OgCurve, OgState, ogCompile, ogMapConstant, ogReaderAdvance, ogReaderInit } from './ogcurve';
import { OgunFx } from './fx';
import { rint } from '../harmor/fx-util';
import { exp as lexp, log as llog } from '../harmor/fx-libm';

const f32 = Math.fround;
const LN3F = f32(1.0986123085021973);
const MAP_FLAGS = 0x20;
/** Mapping defaults of the four shaping maps (forced harmonics, impulse, decay, release EQ). */
const MAP_DEF = [0, 0.5, 0.5, 0.5];
const MAX_POS = 0x8000;

/** Resampler byte, S shift, hop ms, control-block scale and the effects oversampling flag of the five processing qualities [0x69f20]. */
const QUALITY = [
  { res: 1, shift: 0, hopMs: 50, scale: 96, hq: 0 },
  { res: 2, shift: 0, hopMs: 50, scale: 96, hq: 0 },
  { res: 2, shift: 1, hopMs: 50, scale: 48, hq: 1 },
  { res: 2, shift: 2, hopMs: 25, scale: 24, hq: 1 },
  { res: 6, shift: 2, hopMs: 25, scale: 8, hq: 1 },
];

/** FL's master level curve (0x6dc20): (3^x - 1) / 2 with x = level / 128. */
export function masterGain(level: number): number {
  const x = f32(level * 0.0078125);
  if (x === 1) return x;
  return f32((lexp(f32(x * LN3F)) - 1) * 0.5);
}

export class OgunPlug {
  /** Host sample rate; `srp` = sr * os is the processing rate FL's plugin object reports (plug+0xd0 +8): the qualities
   *  above Average run the plugin at twice the host rate (plug+0x5bc) and downsample the mix at the end. */
  sr = 44100;
  os = 1;
  srp = 44100;
  tempo = 140;
  /** The 49 global parameters (plug+0x13c + 4 i). */
  readonly pi = new Int32Array(49);
  readonly S = new FftSynth();
  readonly arts: OgunArt[] = [];
  /** The four shaping maps (plug objects 13..16). */
  readonly maps: OgCurve[] = [];
  private srcMaps: (OgEnv | null)[] = [null, null, null, null];
  private srcArts: (OgArt | null)[] = new Array(13).fill(null);
  private knobKey: string[] = new Array(LIVE_ARTS).fill('');

  // ---- derived values (plug field offsets)
  /** +0x5cc master gain, +0x5d0 master pitch in cents. */
  master = 1;
  masterPitch = 0;
  /** +0x258 fullness, +0x25c pre-decay, +0x260 decay (-1: infinite), +0x264 release, +0x268 morph. */
  fFull = 0;
  fPre = 0;
  fDec = 0;
  fRel = 0;
  fMorph = 0;
  /** +0x24c / +0x250 seed hashes (int32; negative: none / random), +0x254 the random counter. */
  hash1 = -1;
  hash2 = -1;
  /** FPC's RandSeed at load (the clock in seconds): FL's Ogun hashes it with the note counter for a random timbre seed. */
  counter = typeof Date === 'object' || typeof Date === 'function' ? Math.floor(Date.now() / 1000) | 0 : 1;
  /** +0x540 / +0x544 filter base. */
  fltFreq = 0.5;
  fltRes = 0.5;
  /** +0x200.. settings. */
  filterType = 1;
  filterStages = 3;
  filterAlt = -1;
  richness = 14;
  quality = 1;
  smoothMod = 1;
  oneVoicePerKey = 1;
  linkKeyPitch = 1;
  /** b21a: velocity stays linked to the host's volume; b220: portamento on every note; b221: glide time scales with the interval; b222: limit mode. */
  velToVolume = 1;
  glideAlways = 0;
  glideVariable = 0;
  glideMode = 0;
  /** plug+0x5a8: the last note's pitch in cents (float32), null before the first note. */
  lastPitch: number | null = null;
  linkKeySeed = 0;
  velLink = 0;
  clickRemoval = 1;
  linkRelease = 0;
  naturalScale = 1;
  altDecay = 0;
  autoLoudness = 0;
  naturalWeight = 0;
  comb = [0, 0, 4, 0];
  // ---- timing (sample-rate and quality dependent)
  /** +0x248 hop, +0x594 control block, +0x598, +0x5c0 smoothing, +0x5a0 declick length, +0x5ac filter oversampling, +0x278 resampler byte. */
  hop = 2205;
  ctrl = 96;
  d598 = 1;
  smooth = 0.95;
  declick = 96;
  filt2x = true;
  resByte = 2;
  shiftQ = 0;
  hopMs = 50;
  scaleQ = 96;
  /** host.d28 = 44100 / sr, host +0x3c max gain step, host +0x30 */
  hostD28 = 1;
  maxStep = f32(0.001);
  // ---- position tables of the maps (+0x520 / +0x528)
  posTab = new Float64Array(0);
  weightTab: Float32Array | null = null;

  private lastOrder = -1;
  private lastShift = -1;
  private lastSr = 0;
  private lastQ = -1;
  private lastOs = 0;
  private ready = false;
  /** Bumped whenever the synthesizer was rebuilt (live voices keep their own copy of what they need). */
  version = 0;
  /** The voices' mix at the processing rate (interleaved stereo, plug+0x560), zeroed after every output block. */
  mix = new Float32Array(2 * 1024);
  /** The effects (EQ, chorus, delay, reverb, downsampler) and their switches: state bytes b3[0] / b3[1], xi[4] bytes 0 / 1, i2. */
  readonly fx = new OgunFx();
  delayOn = false;
  delaySync = false;
  reverbOn = false;
  reverbSync = false;
  eqType: number[] = [0, 1, 2];

  constructor() {
    for (let i = 0; i < 13; i++) this.arts.push(new OgunArt(i));
    for (let j = 0; j < 4; j++) this.maps.push(new OgCurve(3));
  }

  setSampleRate(sr: number): void {
    this.sr = sr;
  }

  /** FPD_SetBlockSize: the host's largest block (plug+0x554), which the effects' buffers are sized for. */
  block = 128;

  setBlockSize(n: number): void {
    this.block = n >= 1 && Number.isFinite(n) ? Math.min(n | 0, 1 << 16) : 128;
  }

  /** The mix holds at least `frames` processing frames. */
  ensureMix(frames: number): void {
    if (this.mix.length >= 2 * frames) return;
    const m = new Float32Array(2 * frames + 2048);
    m.set(this.mix);
    this.mix = m;
  }

  /** The quality setting of the state (plug+0x214); rendering offline overrides it with the highest (0x69f20). */
  qSetting = 1;
  rendering = false;
  private lastParams: FxParams | null = null;

  /** FPD_ProcessMode bit 16 (the project is being rendered): Ogun runs at its highest quality. */
  setRendering(b: boolean): void {
    if (b === this.rendering) return;
    this.rendering = b;
    if (this.ready && this.lastParams) this.apply(this.lastParams);
  }

  /** FPE_Tempo (0x6b1d0): the plugin keeps the tempo as a float32. */
  setTempo(t: number): void {
    t = f32(t);
    if (t > 0 && t !== this.tempo) {
      this.tempo = t;
      if (this.ready) {
        this.fx.setTempo(this);
        this.updateTimeBase();
      }
    }
  }

  /** Apply the whole state (setParams). */
  apply(p: FxParams): void {
    const raw = p as Record<string, unknown>;
    for (let i = 0; i < 49; i++) {
      const v = raw[OGUN_KEYS[i]];
      this.pi[i] = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
    }
    const xi = (raw.xi as number[]) ?? [];
    const x = (i: number): number => (typeof xi[i] === 'number' ? xi[i] : 0);
    const byte = (v: number, k: number): number => (v >> (8 * k)) & 255;
    this.filterType = byte(x(0), 0) & 3;
    this.filterStages = Math.max(0, x(1) | 0);
    this.filterAlt = x(2) | 0;
    this.richness = x(3) | 0;
    const q = Math.min(4, Math.max(0, x(5) | 0));
    this.qSetting = q;
    this.lastParams = p;
    this.smoothMod = byte(x(6), 0);
    this.oneVoicePerKey = byte(x(6), 1);
    this.velToVolume = byte(x(6), 2);
    this.linkKeyPitch = byte(x(6), 3);
    this.glideAlways = byte(x(8), 0);
    this.glideVariable = byte(x(8), 1);
    this.glideMode = byte(x(8), 2);
    this.linkKeySeed = byte(x(7), 0);
    this.velLink = byte(x(7), 1);
    this.clickRemoval = byte(x(7), 2);
    this.linkRelease = byte(x(7), 3);
    this.naturalScale = byte(x(8), 3);
    this.altDecay = byte(x(13), 0);
    this.autoLoudness = byte(x(13), 1);
    this.naturalWeight = byte(x(13), 2);
    this.comb = [x(9) | 0, x(10) | 0, x(11) | 0, x(12) | 0];
    this.reverbOn = byte(x(4), 0) !== 0;
    this.reverbSync = byte(x(4), 1) !== 0;
    const b3 = Array.isArray(raw.b3) ? (raw.b3 as number[]) : [];
    this.delaySync = ((b3[0] ?? 1) & 255) !== 0;
    this.delayOn = ((b3[1] ?? 1) & 255) !== 0;
    const i2 = Array.isArray(raw.i2) ? (raw.i2 as number[]) : [];
    this.eqType = [0, 1, 2].map((k) => (typeof i2[k] === 'number' ? Math.min(2, Math.max(0, Math.round(i2[k]) | 0)) : k));
    const pi = this.pi;
    this.master = masterGain(pi[0]);
    this.masterPitch = pi[1] * 100 + pi[2];
    this.fFull = f32(f32(pi[8]) * f32(0.001));
    this.fPre = f32(f32(pi[5]) * f32(0.001));
    this.fDec = pi[6] === 10000 ? -1 : f32(pi[6] * 0.0001);
    this.fRel = f32(pi[7] * 0.0001);
    this.fMorph = f32(f32(pi[9]) * f32(0.001));
    this.hash1 = pi[10] - 1 >= 0 ? seedHash(pi[10]) : -1;
    this.hash2 = pi[11] - 1 >= 0 ? seedHash(pi[11]) : -1;
    this.fltFreq = f32(f32(pi[17]) * 0.00390625);
    this.fltRes = f32(f32(pi[18]) * 0.00390625);

    this.configure(this.rendering ? 4 : q);
    this.compileArts(raw);
    this.compileMaps(raw);
    this.fx.apply(this);
    this.ready = true;
  }

  /** Quality, sample rate, order: the synthesizer and the timing values (0x69f20, 0x682b0, 0x69bb0, 0x71860). */
  private configure(q: number): void {
    const qs = QUALITY[q];
    this.os = qs.hq ? 2 : 1;
    this.srp = this.sr * this.os;
    const sr = this.srp;
    this.resByte = qs.res;
    this.shiftQ = qs.shift;
    this.hopMs = qs.hopMs;
    this.scaleQ = qs.scale;
    this.hostD28 = 44100 / sr;
    this.maxStep = f32(0.001 * this.hostD28);
    this.filt2x = sr < 88200;
    this.declick = f32(96 / (this.hostD28 * this.hostD28));
    this.hop = rint(qs.hopMs * 0.001 * sr);
    // control block (0x69bb0)
    let d598 = (sr * qs.scale) / 44100;
    let ctrl = rint(d598 * 0.25) * 4;
    if (ctrl < 4) ctrl = 4;
    this.ctrl = ctrl;
    d598 = (ctrl * qs.scale) / (d598 * 96);
    this.d598 = d598;
    this.smooth = f32(lexp((-4.6051701859880909 * d598) / 96));
    // synthesizer
    let shift = qs.shift;
    if (this.richness < 10 && sr < 88200 && shift < 1) shift = 1;
    const S = this.S;
    const rebuilt = this.lastOrder !== this.richness || this.lastShift !== shift;
    S.sr = sr;
    S.setRate(sr);
    if (rebuilt || this.lastSr !== this.sr || this.lastOs !== this.os) {
      this.lastOs = this.os;
      S.setOrder(this.richness, shift);
      this.buildPositions();
      this.lastOrder = this.richness;
      this.lastShift = shift;
      this.srcMaps = [null, null, null, null];
      this.version++;
    }
    S.setAlt(this.altDecay !== 0);
    S.enabled = this.autoLoudness !== 0;
    S.updateNorm();
    this.lastSr = this.sr;
    this.lastQ = q;
    this.updateTimeBase();
  }

  /** 0x69af0: the articulators' time base (time per tick, tempo per tick). */
  updateTimeBase(): void {
    const per = (this.d598 * 96) / 44100;
    const time = per * 2;
    const tempo = (per * this.tempo) / 60;
    for (const a of this.arts) a.setSpeed(time, tempo);
  }

  /** 0x6a0d0: harmonic positions in the maps (log2 scale or linear) and the natural weighting. */
  private buildPositions(): void {
    const hc = this.S.hcount;
    let len = hc + Math.trunc(hc / 2);
    if (len > MAX_POS) len = MAX_POS;
    this.posTab = new Float64Array(len);
    this.weightTab = null;
    this.fillPositions();
  }

  private fillPositions(): void {
    const len = this.posTab.length;
    const nat = this.naturalScale !== 0;
    for (let i = 0; i < len; i++) this.posTab[i] = nat ? (llog(i + 1) * 1.4426950408889634) / 15 : i / 32767;
    if (this.naturalWeight !== 0) {
      const w = new Float32Array(len);
      for (let i = 0; i < len; i++) w[i] = f32(1 / Math.sqrt(i + 1));
      this.weightTab = w;
    } else this.weightTab = null;
  }

  private compileArts(raw: Record<string, unknown>): void {
    const arts = raw.arts as OgArt[] | undefined;
    if (!arts) return;
    for (let i = 0; i < 13; i++) {
      const a = arts[i];
      if (!a) continue;
      let adsr: number[] | null = null, lfo: number[] | null = null;
      if (i < LIVE_ARTS) {
        const t = ART_TARGETS[i][0];
        adsr = ['Att', 'Dec', 'Sus', 'Rel'].map((s) => Number(raw[t + s] ?? 0));
        lfo = ['LfoSpd', 'LfoTns', 'LfoSkw', 'LfoPw'].map((s) => Number(raw[t + s] ?? 0));
      }
      const key = (adsr ? adsr.join(',') : '') + '|' + (lfo ? lfo.join(',') : '');
      if (this.srcArts[i] === a && (i >= LIVE_ARTS || this.knobKey[i] === key)) continue;
      this.arts[i].setup(a, adsr, lfo);
      this.srcArts[i] = a;
      if (i < LIVE_ARTS) this.knobKey[i] = key;
    }
  }

  private compileMaps(raw: Record<string, unknown>): void {
    const maps = raw.maps as OgEnv[] | undefined;
    if (!maps) return;
    const combKey = this.comb.join(',') + '|' + this.naturalScale + this.naturalWeight + this.altDecay;
    const redo = combKey !== this.mapKey;
    if (this.naturalScale !== this.lastScale || this.naturalWeight !== this.lastWeight) {
      this.fillPositions();
      this.lastScale = this.naturalScale;
      this.lastWeight = this.naturalWeight;
    }
    for (let j = 0; j < 4; j++) {
      if (this.srcMaps[j] !== maps[j] || redo) {
        if (this.srcMaps[j] !== maps[j]) {
          this.maps[j] = ogCompile(maps[j], 'map', { flags: MAP_FLAGS, res: 0, offset: 0 });
          this.srcMaps[j] = maps[j];
        }
        this.updateMap(13 + j);
      }
    }
    this.mapKey = combKey;
  }

  private mapKey = '';
  private lastScale = -1;
  private lastWeight = -1;

  /** 0x71910: sample a shaping map at the harmonic positions and upload it to the synthesizer (slot idx - 15). */
  updateMap(idx: number): void {
    const S = this.S, n0 = S.hcount;
    const c = this.maps[idx - 13];
    const slot = idx - 15;
    const k = ogMapConstant(c);
    if (idx === 13 && k !== null && k === 0) { S.setSlot(slot, null, 0); return; }
    const n = idx === 13 ? n0 : this.posTab.length;
    const buf = new Float32Array(Math.max(n, 1));
    const st = new OgState();
    ogReaderInit(c, st);
    const weighted = this.weightTab !== null && (this.altDecay + 14) >= idx;
    let d9 = 0;
    for (let i = 0; i < n; i++) {
      const d8 = this.posTab[i] + 5.9604644775390625e-8;
      ogReaderAdvance(c, st, d8 - d9);
      d9 = d8;
      let d10: number;
      const v = f32(st.out);
      const cl = v < 0 ? 0 : v > 1 ? 1 : v;
      if (idx === 13) d10 = cl;
      else {
        const s = f32(cl * 2);
        d10 = s === 1 ? s : f32((lexp(f32(s * LN3F)) - 1) * 0.5);
      }
      if (weighted) d10 = d10 * this.weightTab![i];
      buf[i] = d10;
    }
    const cb = this.comb[idx - 13];
    if (cb > 0) {
      const d0 = idx - 15 >>> 0 < 2 ? 1 : 0;
      if (cb < 5) {
        const m = cb + 1;
        for (let i = 0; i < n; i++) if (i % m === m - 1) buf[i] = d0;
      } else {
        const m = cb - 2;
        for (let i = 0; i < n; i++) if (i % m > 0) buf[i] = d0;
      }
    }
    S.setSlot(slot, buf, n);
  }

  /** The seed hash of a key-linked timbre seed 1 (TriggerVoice 0x6ec00). */
  keySeedHash(key: number, seed1: number): number {
    return seedHash0(key + seed1 + 20, 173);
  }
}

import { jenkins } from './fftsynth';

/** hash(a, b, 7919) as a uint32 kept as FL does (the abs of the zero-extended value is a no-op). */
export function seedHash0(a: number, b: number): number {
  return jenkins(a, b, 7919) | 0;
}
