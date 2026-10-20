// Ogun's articulators: FL's TOpArticulator (VMT 0x2eae30; TArticulator 0x358e08) as Ogun_x64 (FL 2026, arm64) runs them.
// Each of the 13 modulation targets (volume, filter frequency / resonance, pitch, unison pitch / phase, timbre pre-decay /
// decay / release / fullness / morphing / rotation, EQ shift) has an envelope (TMEnvelope), an LFO (TMLFO) and four mappings
// (keyboard, velocity, Mod X, Mod Y; TMMap): a note's value is `base`, then the keyboard and velocity mappings combine at
// the note start (mode 0 multiply, 1 add), the X / Y mapping tables are sampled at the note's Mod X / Y, and the first five
// targets run their envelope and LFO once per control block.
//
// FL addresses in brackets: value at a note start 0x267b30, per-voice state init 0x2674f0, per-block process 0x267600,
// X / Y table build 0x70be0, per-target setup 0x6a570.

import type { OgArt, OgEnv } from '../../../../model/gen/plugins/ogun/types';
import {
  OgCurve, OgState, ogCompile, ogEnvEval, ogEnvNoteOn, ogEnvRelease, ogLfoEval, ogLfoNoteOn, ogMapConstant, ogMapFill32, ogMapValue,
  ogSetSpeed,
} from './ogcurve';

const f32 = Math.fround;

/** Articulator modes per target (TArticulator +0x08): 1 = add, 0 = multiply [0x6a570]. */
export const ART_MODE = [0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1];
/** Curve flags FL gives an articulator's envelope / LFO / mappings. */
const ENV_FLAGS = 0x2d, LFO_FLAGS = 0x27, MAP_FLAGS = 0x20;
/** Entries of the Mod X / Mod Y mapping tables (0x70be0). */
export const XY_RES = 513;

/** The five targets with a per-block envelope and LFO. */
export const LIVE_ARTS = 5;

/** One compiled articulator (the FL object). */
export class OgunArt {
  readonly mode: number;
  /** +0x20 base value, +0x24 envelope amount, +0x28 LFO amount (all 0 / 1 / 1 in FL's presets). */
  base = 0;
  ea = 1;
  la = 1;
  env = new OgCurve(1);
  lfo = new OgCurve(2);
  readonly maps: OgCurve[] = [];
  /** +0x50 / +0x58 Mod X / Y tables (513 floats), null when the mapping is at its default level (no table lookup). */
  xTab: Float32Array | null = null;
  yTab: Float32Array | null = null;
  private srcE: OgEnv | null = null;
  private srcL: OgEnv | null = null;
  private readonly srcK: (OgEnv | null)[] = [null, null, null, null];
  private keyA = '';
  private keyL = '';
  private time = 0;
  private tempo = 0;

  constructor(readonly index: number) {
    this.mode = ART_MODE[index];
    for (let j = 0; j < 4; j++) this.maps.push(new OgCurve(3));
  }

  /**
   * Compile from the state (a curve recompiles only when its source object or its live knobs changed). `adsr` = attack, decay,
   * sustain offset, release scales and `lfo` = speed, tension, skew, pulse width of the flat parameters (null: the curves' own).
   */
  setup(a: OgArt, adsr: number[] | null, lfo: number[] | null): void {
    this.base = f32(a.mode);
    this.ea = f32(a.ea);
    this.la = f32(a.la);
    const off = this.mode === 1 ? 0.5 : 0;
    const ka = adsr ? adsr.join(',') : '', kl = lfo ? lfo.join(',') : '';
    if (this.srcE !== a.e || this.keyA !== ka) {
      this.env = ogCompile(adsr ? { ...a.e, a: adsr } : a.e, 'env', { flags: ENV_FLAGS, offset: off });
      if (this.time) ogSetSpeed(this.env, this.time, this.tempo);
      this.srcE = a.e;
      this.keyA = ka;
    }
    if (this.srcL !== a.l || this.keyL !== kl) {
      this.lfo = ogCompile(lfo ? { ...a.l, l: lfo } : a.l, 'lfo', { flags: LFO_FLAGS });
      if (this.time) ogSetSpeed(this.lfo, this.time, this.tempo);
      this.srcL = a.l;
      this.keyL = kl;
    }
    for (let j = 0; j < 4; j++) {
      if (this.srcK[j] !== a.k[j]) {
        this.maps[j] = ogCompile(a.k[j], 'map', { flags: MAP_FLAGS, res: 0, offset: off });
        this.srcK[j] = a.k[j];
        if (j >= 2) this.xyTable(j);
      }
    }
  }

  /** 0x70be0: the Mod X / Y mapping as a 513-entry table (none while the map is at its default level). */
  private xyTable(j: number): void {
    const m = this.maps[j];
    const k = ogMapConstant(m);
    let tab: Float32Array | null = null;
    if (!(k !== null && k === m.def)) {
      tab = new Float32Array(XY_RES);
      ogMapFill32(m, tab, XY_RES, 0.001953125);
    }
    if (j === 2) this.xTab = tab; else this.yTab = tab;
  }

  /** Time base of the control block (0x267720): `time` per tick (2 * block / sampleRate), `tempo` per tick with tempo sync. */
  setSpeed(time: number, tempo: number): void {
    this.time = time;
    this.tempo = tempo;
    ogSetSpeed(this.env, time, tempo);
    ogSetSpeed(this.lfo, time, tempo);
  }

  /** Value at a note start from the keyboard (key / 120) and velocity mappings [0x267b30]; float32. */
  noteValue(key: number, vel: number): number {
    let v = ogMapValue(this.maps[0], f32(key) * 0.0083333333333333332);
    const w = ogMapValue(this.maps[1], f32(vel));
    if (this.mode === 0) v = v * w;
    else if (this.mode === 1) v = v + w;
    else v = v * w * 2;
    return f32(v);
  }

  /** Apply a Mod X / Y table entry to a value, per the articulator's mode. */
  applyTable(v: number, tab: Float32Array | null, idx: number): number {
    if (!tab) return v;
    const t = tab[idx];
    if (this.mode === 0) return v * t;
    if (this.mode === 1) return v + t;
    return v * t * 2;
  }

  /** Whether the envelope or the LFO runs (FL's per-voice flag, voice+0x74+i). */
  get live(): boolean {
    return this.env.enabled !== 0 || this.lfo.enabled !== 0;
  }

  /** Per-voice state init (0x2674f0): envelope and LFO note-on (the output is set by the caller). */
  noteOn(st: OgArtState): void {
    ogEnvNoteOn(this.env, st.env);
    ogLfoNoteOn(this.lfo, st.lfo);
  }

  /** Per-block evaluation (TOpArticulator.Process 0x660f0) of the trigger value `v`: advance `step` ticks. */
  process(st: OgArtState, v: number, step: number): void {
    if (this.env.enabled !== 0) {
      ogEnvEval(this.env, st.env, step);
      if (this.mode === 1) v = v + st.env.out * this.ea;
      else v = v * st.env.out * this.ea;
    }
    if (this.lfo.enabled !== 0) {
      ogLfoEval(this.lfo, st.lfo, step);
      if (this.mode === 1) v = v + st.lfo.lfoOut * this.la;
      else v = v * (st.lfo.lfoOut * this.la * 2 + 1);
    }
    st.out = v;
  }

  /** Note off (0x6f5c0): both states to their release. */
  release(st: OgArtState): void {
    ogEnvRelease(this.env, st.env);
    ogEnvRelease(this.lfo, st.lfo);
  }
}

/** The per-voice state of an articulator (FL voice+0xe8+0x108*i). */
export class OgArtState {
  env = new OgState();
  lfo = new OgState();
  /** +0x100 the articulator's output. */
  out = 0;

  /** Finish both curves (0x6f6d0: stages 9). */
  kill(): void {
    this.env.stage = 9; this.env.mode = 9;
    this.lfo.stage = 9; this.lfo.mode = 9;
  }
}
