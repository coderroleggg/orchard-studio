// Harmor's articulators: FL's TOpArticulator (VMT 0x601fb0; TArticulator
// 0x83b2c0) as Harmor_x64 (FL 2026, arm64) runs them, ported exactly. Each of
// a part's 43 modulation targets (ART_TARGETS) has an envelope (TMEnvelope),
// an LFO (TMLFO) and 9 mappings (TMMap; inputs Keyboard, Velocity, Mod X, Mod
// Y, Mod Z, Random, Unison index, Held index, Mod X speed) combined by a chain
// FL compiles from the curves (Update 0xef4e0) and evaluated per voice once per
// control block (0xef000) with an output one-pole smoother.
//
// API (the voice engine drives the FL sequence; FL addresses in brackets):
// - `ArtPart.setup(arts, params, part, tempo, sampleRate, blockLen)`: compile a
//   part's 43 articulators from the state (`hA` / `hB` arts) and parameters
//   (`<p>_art<t>_<att|dec|sus|rel|lfoSpd|lfoTns|lfoSkw|lfoPw|smooth>`, the
//   live values; FL keeps the first eight in the curves, HEnv.a / HEnv.l): modes
//   (fixed per target [bitsets 0x571af8 / 0x571b00]), curves, chains, smoothing
//   [ProcessParam 0xd1220], the two evaluation lists `listA` (targets 31..42,
//   FL part+0x920) and `listB` (targets 0..30, part+0x8a0) [0xee390] and the
//   time base [0xee620]. Re-run on every state / parameter change: unchanged
//   curves (same HEnv objects) are not recompiled. `setTimeBase()` alone for
//   tempo / sample rate / block changes (then `ArtVoice.rescale` on live voices).
// - `ArtVoice` (one per Harmor voice, FL voice+0x2e8 + i*0x120):
//   `trigger(p, rnd, randCount, uni, velAttScale, shared)` [TriggerVoice
//   0xda2d0: 0xeed50 for all 43, 0xeeea0 for listB then listA, filter
//   envelope amounts, velocity attack scale]; per control block
//   `process(p, p.listA, inputs)`, on the voice's first block `snap(p,
//   p.listA)` and `applyGlobal(p, velAtt)` [0xe20e0..0xe23ec], then
//   `process(p, p.listB, inputs)` and on the first block `snap(p, p.listB)`
//   [voice render 0xe1b60]; `release(p, relTime)` [Voice_Release 0xdc1f0];
//   `setArp(p, idx, count)` [Gen_Render 0xe8ba0]; `scalePolyRelease(p, f)`
//   [TriggerVoice 0xda938: in each enabled part with a poly release scale
//   != 1, EVERY released (V+0x224 == 6), not yet scaled voice, whatever its
//   part, with THAT part's ArtPart and factor]; `rescale(p)`. Voices FL does
//   not render (V+0x224 == 10, V+0x38 > 0) get no blocks; with predelay the
//   first block restarts after the delay (listA processed and snapped again).
//   `trigger`'s random table: FL's TriggerVoice draws one per note (per part
//   / per unison voice with "Voice randomness" 2 / 3) and voices that do not
//   draw read the last drawn table. Legato hand-overs keep the states.
//   Outputs: `out[i]` (FL state+4), the envelope / LFO states `env[i]` /
//   `lfo[i]` (`env[1].stage` is FL's V+0x410 volume envelope stage, `env[4/5]
//   .out` the filter envelopes V+0x79c / V+0x8bc), `finished(i)` [0xef280].
// - Global LFOs (curve flag m[0] bit 1): `ArtPart.syncGlobalLfo(blocks)` on
//   transport start / position change while playing [0xee250] and
//   `ArtPart.advanceGlobalLfo(frames)` after rendering each block [0xe8fc0].
// - `ArtInputs`: the per-block input record FL builds on the render stack
//   (sp+0x118): `first` (+0x00 double: 0 on the voice's first block, 1 after;
//   the envelope / LFO step), `lfoSpeed` (+0x08 double: articulator 39
//   output), `map[0..8]` (+0x10..+0x30 float32: key (pitch + 6000) / 12000,
//   velocity, X, Y, Z, random (+0x24, trigger only), unison position (+0x28,
//   trigger only), held index / 32, X speed), `lfoAmt` (+0x34: articulator 38
//   output x Main LFO amount). FL fills +0x00 / +0x08 / +0x34 only before
//   listB: listA sees the previous block's values (they only matter if a
//   target 31..42 has its envelope or LFO on, which FL's editor does not offer).
// - Mapping tables: `mapValue(curve, x)` (TMMap y(x), float32) and the readers
//   in ./env.ts (`mapFill32`, `mapFill64`, `mapAt`, `mapIterInit/Next`).
//
// Time base: envelope / LFO time advances `first` ticks per control block,
// one tick = blockLen samples; curve unit 1.0 = 0.5 s (speed = 2 * blockLen /
// sampleRate per tick), or one beat with tempo sync (blockLen / sampleRate *
// bpm / 60). blockLen = FL's envelope granularity (`harmorBlockLen`).

import type { HArt, HEnv } from '../../../../model/gen/plugins/harmor/types';
import {
  Curve, CurveState, TYPE_ENV, TYPE_LFO, TYPE_MAP, envEval, envNoteOn, envRelease, envSkipAttack, lfoAddPhase, lfoEval,
  lfoAdvanceGlobal, lfoNoteOn, lfoResetGlobal, mapConstant, mapValue, rne, setArp, setScale, setSpeed, setStartOfs, susSetup,
} from './env';

export { mapValue } from './env';

const f32 = Math.fround;
export const ART_COUNT = 43;
const LN_001 = -4.605170185988091; // G[a35580] = ln(0.01)
const FINISHED = 5.960464477539063e-8; // G[9047d0]

/** Articulator modes per target: bit set = add (mode 1) [0x571af8]; second set = bipolar multiply (mode 2) [0x571b00]. */
const MODE_ADD = [0x35, 0xf0, 0x86, 0x79, 0xd2, 0x07];
const MODE_BIP = [0x04, 0x40, 0x80, 0x50, 0xc0, 0x06];
const bit = (tab: number[], i: number): number => (tab[i >> 3] >> (i & 7)) & 1;

/** Map table resolutions FL gives an articulator's mappings (TMMap +0xb8, 0xee7c0): Mod X / Y / Z 513, Held index 33. */
const MAP_RES = [0, 0, 513, 513, 513, 0, 0, 33, 0];

const scratchF = new Float32Array(1);
const scratchU = new Uint32Array(scratchF.buffer);
const fbits = (x: number): number => { scratchF[0] = x; return scratchU[0]; };
const fbitsI = (x: number): number => { scratchF[0] = x; return scratchU[0] | 0; };

/** FL's control block length for a sample rate and envelope granularity (0xd0190; `hq`: FL's 0.5 ms mode). */
export function harmorBlockLen(sampleRate: number, grain: number, hq = false): number {
  const ms = hq ? 0.5 : f32(f32(grain) * f32(0.01));
  let n = rne(ms * 0.001 * sampleRate * 0.25) * 4;
  if (n < 4) n = 4;
  return n | 0;
}

/** Smoothing coefficient of an "Articulator output smoothing" value 0..1001 (ProcessParam 0xd1388 + 0xef2e0). */
export function smoothCoef(v: number, sampleRate: number, blockLen: number): number {
  let d8: number;
  if (v > 1000) d8 = -1;
  else d8 = (sampleRate * (Math.exp(v * 0.0089999999999999993 * 0.6931471805599453) - 1)) / (51.100000000000001 * blockLen);
  if (!(d8 >= 0) && d8 === d8) return 1;
  if (d8 > 0) return f32(Math.exp(LN_001 / d8));
  return 0;
}

/** One compiled articulator (FL's TOpArticulator object). */
export class ArtDef {
  /** +0x08 mode: 0 multiply, 1 add, 2 bipolar multiply (x2). */
  mode = 0;
  /** +0x20 base value (1 multiply, 0 add, with flat mappings folded in), +0x24 / +0x28 envelope / LFO amounts (note-on only). */
  base = 1;
  ea = 1;
  la = 1;
  /** +0x78: evaluation chain (0 envelope, 1 LFO, t >= 2 mapping t - 2; -1 ends: output smoothing). */
  readonly chain = new Int32Array(12);
  /** +0xa8 output smoothing coefficient. */
  smooth = 0;
  /** +0xa0 / +0xa4: Random / Unison index mappings applied once at note on. */
  rndOn = 0;
  uniOn = 0;
  readonly env = new Curve(TYPE_ENV);
  readonly lfo = new Curve(TYPE_LFO);
  readonly maps: Curve[] = [];
  /** Source objects the curves were compiled from (recompile on change). */
  srcE: HEnv | null = null;
  srcL: HEnv | null = null;
  readonly srcK: (HEnv | null)[] = [];

  constructor(readonly index: number) {
    for (let j = 0; j < 9; j++) {
      const m = new Curve(TYPE_MAP);
      m.flags |= 0x60;
      m.enabled = -1;
      m.res = MAP_RES[j];
      this.maps.push(m);
      this.srcK.push(null);
    }
    this.env.flags |= 0x40;
    this.lfo.flags |= 0x40;
    // per-target setup (0xede50): mode / offsets
    const add = bit(MODE_ADD, index);
    this.setMode(add);
    if (bit(MODE_BIP, index)) {
      this.mode = 2;
      for (const m of this.maps) m.def = 1;
    }
    if (index === 27) {
      this.env.flags |= 0x80;
      this.env.clamp = 0;
    }
  }

  /** SetMode (0xef390): mode, envelope and mapping offsets 0.5 * mode. */
  private setMode(mode: number): void {
    this.mode = mode;
    const ofs = f32(0.5 * mode);
    this.env.offset = ofs;
    for (const m of this.maps) {
      m.offset = ofs;
      m.def = f32(1 - ofs);
    }
  }

  get envOn(): boolean {
    return this.env.enabled !== 0;
  }

  get lfoOn(): boolean {
    return this.lfo.enabled !== 0;
  }

  /** Update (0xef4e0): base value, chain, note-on mappings. */
  update(): void {
    this.base = f32(this.mode !== 1 ? 1 : 0);
    let n = 0;
    if (this.env.enabled !== 0) this.chain[n++] = 0;
    if (this.lfo.enabled !== 0) this.chain[n++] = 1;
    for (let t = 2; t <= 10; t++) {
      const m = this.maps[t - 2];
      const c = mapConstant(m);
      let flat = c !== null;
      if (t === 7) {
        this.rndOn = !flat && m.enabled !== 0 ? 1 : 0;
        if (m.enabled === 0) flat = false;
      } else if (t === 8) {
        this.uniOn = flat ? 0 : 1;
      } else if (!flat) {
        this.chain[n++] = t;
      }
      if (flat) this.base = applyMode(this.mode, this.base, f32((c as number) - m.offset));
    }
    this.chain[n] = -1;
  }
}

/** Mapping combination by mode (0 multiply, 1 add, else x2 multiply). */
function applyMode(mode: number, a: number, v: number): number {
  if (mode === 0) return f32(a * v);
  if (mode === 1) return f32(a + v);
  return f32(f32(a * v) * 2);
}

const ADSR_KEYS = ['att', 'dec', 'sus', 'rel'];
const LFO_KEYS = ['lfoSpd', 'lfoTns', 'lfoSkw', 'lfoPw'];

/** A part's 43 compiled articulators and evaluation lists. */
export class ArtPart {
  readonly arts: ArtDef[] = [];
  /** Evaluation lists (-1 terminated): targets 31..42 (FL part+0x920) and 0..30 (part+0x8a0) with a non-empty chain. */
  readonly listA = new Int32Array(13);
  readonly listB = new Int32Array(32);
  /** Highest target with a note-on Random mapping (FL's plug+0x2d28 is the max over both parts, 0 with "Same random input"). */
  randMax = 0;
  /** A listB envelope / LFO has arpeggio points (FL part+0x620; plug+0x114d = either part): voices need `setArp`. */
  hasArp = false;
  /** listB articulators with a "global" LFO (FL's plug+0x2d20 list, part A's then part B's). */
  readonly globalLfo = new Int32Array(32);
  sampleRate = 0;
  blockLen = 0;
  tempo = 0;
  /** The last setup / setTimeBase changed the time base: rescale live voices (`ArtVoice.rescale`). */
  timeChanged = false;

  constructor() {
    for (let i = 0; i < ART_COUNT; i++) this.arts.push(new ArtDef(i));
    this.listA[0] = -1;
    this.listB[0] = -1;
  }

  /** Compile from the part's state and the plugin parameters (see the header). */
  setup(arts: HArt[], params: Record<string, unknown>, part: 'a' | 'b', tempo: number, sampleRate: number, blockLen: number): void {
    const num = (k: string): number | undefined => {
      const v = params[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    };
    for (let i = 0; i < ART_COUNT; i++) {
      const a = this.arts[i];
      const h = arts[i];
      if (!h) continue;
      a.ea = f32(h.ea);
      a.la = f32(h.la);
      let dirty = false;
      if (h.e !== a.srcE) {
        a.env.load(h.e);
        a.srcE = h.e;
        dirty = true;
      }
      if (h.l !== a.srcL) {
        a.lfo.load(h.l);
        a.srcL = h.l;
        dirty = true;
      }
      for (let j = 0; j < 9; j++) {
        const k = h.k[j];
        if (k && k !== a.srcK[j]) {
          a.maps[j].load(k);
          a.srcK[j] = k;
          dirty = true;
        }
      }
      if (i < 31) {
        let env = false, lfo = false;
        for (let f = 0; f < 4; f++) {
          const v = num(`${part}_art${i}_${ADSR_KEYS[f]}`);
          if (v !== undefined && a.env.adsrI[f] !== (v | 0)) { a.env.adsrI[f] = v | 0; env = true; }
          const w = num(`${part}_art${i}_${LFO_KEYS[f]}`);
          if (w !== undefined && a.lfo.lfoI[f] !== (w | 0)) { a.lfo.lfoI[f] = w | 0; lfo = true; }
        }
        if (env) a.env.envScales();
        if (lfo) a.lfo.changed();
      }
      a.smooth = smoothCoef(num(`${part}_art${i}_smooth`) ?? 0, sampleRate, blockLen);
      if (dirty) a.update();
    }
    this.timeChanged = this.setTimeBase(tempo, sampleRate, blockLen);
    this.buildLists();
  }

  /**
   * Time base of all articulators (0xee620: SetSpeed 0x4500e0 + LFO Changed per
   * articulator). Returns true when it differs from the previous one: then
   * call `ArtVoice.rescale` for the part's live voices (FL does it right here).
   */
  setTimeBase(tempo: number, sampleRate: number, blockLen: number): boolean {
    const changed = tempo !== this.tempo || sampleRate !== this.sampleRate || blockLen !== this.blockLen;
    this.tempo = tempo;
    this.sampleRate = sampleRate;
    this.blockLen = blockLen;
    const d0 = blockLen * (1 / sampleRate);
    const time = d0 * 2;
    const beat = d0 * f32(tempo) * 0.016666666666666666;
    for (const a of this.arts) {
      setSpeed(a.env, time, beat);
      setSpeed(a.lfo, time, beat);
    }
    return changed;
  }

  /** The evaluation lists and the random input count (0xee390). */
  buildLists(): void {
    let n = 0;
    for (let i = 0; i <= 30; i++) if (this.arts[i].chain[0] >= 0) this.listB[n++] = i;
    this.listB[n] = -1;
    n = 0;
    for (let i = 31; i <= 42; i++) if (this.arts[i].chain[0] >= 0) this.listA[n++] = i;
    this.listA[n] = -1;
    let r = 0;
    for (let i = 0; i < ART_COUNT; i++) if (this.arts[i].rndOn > 0 && i > r) r = i;
    this.randMax = r;
    let g = 0;
    this.hasArp = false;
    for (let k = 0; this.listB[k] >= 0; k++) {
      const a = this.arts[this.listB[k]];
      if (a.lfo.enabled !== 0 && a.lfo.m0 & 2) this.globalLfo[g++] = this.listB[k];
      if (a.env.hasArp || a.lfo.hasArp) this.hasArp = true;
    }
    this.globalLfo[g] = -1;
  }

  /**
   * Global LFOs to the song position (0xee250; FL runs it while playing on
   * transport start, position changes and time base changes): `blocks` = song
   * position in control blocks (FL: pos * sampleRate * 240 / (tempo * PPQ *
   * blockLen * 4) with pos in ticks).
   */
  syncGlobalLfo(blocks: number): void {
    for (let k = 0; this.globalLfo[k] >= 0; k++) {
      const c = this.arts[this.globalLfo[k]].lfo;
      lfoResetGlobal(c);
      lfoAdvanceGlobal(c, blocks);
    }
  }

  /** Advance the global LFOs after a render call of `frames` samples (Gen_Render 0xe8fc0, after all voices). */
  advanceGlobalLfo(frames: number): void {
    const t = frames / this.blockLen;
    for (let k = 0; this.globalLfo[k] >= 0; k++) lfoAdvanceGlobal(this.arts[this.globalLfo[k]].lfo, t);
  }
}

/** The per-block input record (see the header; FL render stack sp+0x118). */
export class ArtInputs {
  /** +0x00: 0 on the voice's first control block, 1 after. */
  first = 0;
  /** +0x08: articulator 39 (Global LFO speed) output. */
  lfoSpeed = 1;
  /** +0x10..+0x30: mapping inputs (float32). */
  readonly map = new Float32Array(9);
  /** +0x34: articulator 38 output x Main LFO amount. */
  lfoAmt = 1;
}

/** One voice's articulator states (FL voice+0x2e8, 0x120 bytes each). */
export class ArtVoice {
  /** +0x00 static base (with the note-on mappings), +0x04 output, +0xc8 chain result, +0x118 envelope amount. */
  readonly base = new Float32Array(ART_COUNT);
  readonly out = new Float32Array(ART_COUNT);
  readonly target = new Float32Array(ART_COUNT);
  readonly envAmt = new Float32Array(ART_COUNT);
  /** +0xd0: mapping caches (last input, last output) per articulator and mapping. */
  readonly mapIn = new Float32Array(ART_COUNT * 9);
  readonly mapOut = new Float32Array(ART_COUNT * 9);
  /** +0x08 / +0x68: envelope and LFO states. */
  readonly env: CurveState[] = [];
  readonly lfo: CurveState[] = [];
  /** FL V+0x3348: global envelopes continued another voice's states at note on. */
  sharedEnv = false;

  constructor() {
    for (let i = 0; i < ART_COUNT; i++) {
      this.env.push(new CurveState());
      this.lfo.push(new CurveState());
    }
  }

  /**
   * Note on (TriggerVoice 0xda2d0). `rnd`: the voice's random values (FL's
   * ippsRandUniform_Direct_32f table; articulator i reads rnd[min(i,
   * randCount)]), `uni`: unison position (0.5 without unison, else u / (n - 1)
   * ... FL: u * part+0x1d0), `velAttScale`: volume envelope attack scale factor
   * when "Velocity to volume envelope attack scale" is on (FL: 2 - 2 * min(vel,
   * 1)), NaN when off; `shared`: the voice whose states "global" envelopes
   * continue (FL: the first live, unreleased voice of the part), or null.
   */
  trigger(p: ArtPart, rnd: ArrayLike<number>, randCount: number, uni: number, velAttScale: number, shared: ArtVoice | null): void {
    this.env[1].kill(); // FL 0xdabe4: V+0x410 / +0x418 = 9, start / delta / out 0
    let k = 0;
    for (let i = 0; i < ART_COUNT; i++) {
      const a = p.arts[i];
      const r = f32(rnd[k] ?? 0);
      k = k + 1 > randCount ? randCount : k + 1;
      // 0xeed50
      let b = a.base;
      if (a.rndOn > 0) b = applyMode(a.mode, b, mapValue(a.maps[5], r));
      if (a.uniOn > 0) b = applyMode(a.mode, b, mapValue(a.maps[6], f32(uni)));
      this.base[i] = b;
      this.out[i] = b;
    }
    this.env[4].out = 0;
    this.env[5].out = 0;
    this.sharedEnv = false;
    for (let n = 0; p.listB[n] >= 0; n++) {
      const i = p.listB[n];
      const e = p.arts[i].env;
      e.shared = null;
      if (e.enabled !== 0 && e.m0 & 2 && shared) {
        e.shared = shared.env[i];
        this.sharedEnv = true;
      }
      this.noteOn(p, i);
    }
    for (let n = 0; p.listA[n] >= 0; n++) this.noteOn(p, p.listA[n]);
    this.envAmt[4] = 0;
    this.envAmt[5] = 0;
    if (velAttScale === velAttScale && p.arts[1].env.enabled !== 0) {
      const s = this.env[1];
      s.scale[0] = f32(s.scale[0] * velAttScale);
      susSetup(p.arts[1].env, s);
      setStartOfs(p.arts[1].env, s, s.ofs);
    }
  }

  /** 0xeeea0: chain result, envelope / LFO note on (0x4527b0), mapping caches, envelope amount. */
  private noteOn(p: ArtPart, i: number): void {
    const a = p.arts[i];
    this.target[i] = this.base[i];
    const es = this.env[i], ls = this.lfo[i];
    if (a.chain[0] >= 0) {
      envNoteOn(a.env, es);
      lfoNoteOn(a.lfo, ls);
      let t = a.base;
      if (a.env.enabled !== 0) t = f32(t + f32(es.out * a.ea));
      if (a.lfo.enabled !== 0) {
        if (a.mode === 1) t = f32(t + f32(ls.lfoOut * a.la));
        else t = f32(t * f32(f32(f32(ls.lfoOut * a.la) * 2) + 1));
      }
      this.target[i] = t;
      this.mapIn.fill(65536, i * 9, i * 9 + 9);
      this.mapOut.fill(65536, i * 9, i * 9 + 9);
      this.envAmt[i] = a.mode === 2 ? 2 : 1;
    } else {
      es.kill();
      ls.kill();
    }
  }

  /** Evaluate the articulators of a list for one control block (0xef000 each). */
  process(p: ArtPart, list: Int32Array, inp: ArtInputs): void {
    for (let n = 0; list[n] >= 0; n++) this.evalArt(p.arts[list[n]], list[n], inp);
  }

  private evalArt(a: ArtDef, i: number, inp: ArtInputs): void {
    let t = this.base[i];
    const ch = a.chain;
    for (let k = 0; k < 12; k++) {
      const sl = ch[k];
      if (sl === -1) {
        this.target[i] = t;
        this.out[i] = f32(t + f32(f32(this.out[i] - t) * a.smooth));
        return;
      }
      if (sl === 0) {
        const s = this.env[i];
        envEval(a.env, s, inp.first);
        if (a.mode === 1) t = f32(t + f32(s.out * this.envAmt[i]));
        else t = f32(f32(t * s.out) * this.envAmt[i]);
      } else if (sl === 1) {
        const s = this.lfo[i];
        lfoEval(a.lfo, s, inp.first, inp.lfoSpeed);
        if (a.mode === 1) t = f32(t + f32(s.lfoOut * inp.lfoAmt));
        else t = f32(t * f32(f32(f32(s.lfoOut * inp.lfoAmt) * 2) + 1));
      } else {
        const j = sl - 2;
        const x = inp.map[j];
        const c = i * 9 + j;
        let v: number;
        if (fbits(x) === fbits(this.mapIn[c])) v = this.mapOut[c];
        else {
          this.mapIn[c] = x;
          v = mapValue(a.maps[j], x);
          this.mapOut[c] = v;
        }
        t = applyMode(a.mode, t, v);
      }
      this.target[i] = t;
    }
  }

  /** Jump the outputs of a list to their chain results (0xef370; the voice's first block). */
  snap(p: ArtPart, list: Int32Array): void {
    for (let n = 0; list[n] >= 0; n++) this.out[list[n]] = this.target[list[n]];
  }

  /**
   * Global envelope / LFO modifiers on the voice's first block (render
   * 0xe20e0..0xe23ec), after listA: articulators 33 (attack time), 34..37
   * (attack / decay scale, sustain offset, release scale) and 40 (LFO phase)
   * modify listB's envelope / LFO states. `velAtt`: the volume articulator's
   * extra attack time (FL adds the voice velocity V+0x8 when "Velocity to volume
   * envelope attack time" is on), else 0.
   */
  applyGlobal(p: ArtPart, velAtt: number): void {
    const o = this.out;
    const sa = o[34], sd = o[35], ss = o[36], sr = o[37];
    const scales = !(fbits(sa) === 0x3f800000 && fbits(sd) === 0x3f800000 && fbits(ss) === 0 && fbits(sr) === 0x3f800000);
    const phase = o[40];
    const att = f32(o[33] * 2);
    const attVol = velAtt !== 0 ? f32(att + velAtt) : att;
    if (!scales && fbits(phase) === 0 && fbitsI(att) <= 0 && fbitsI(attVol) <= 0) return;
    for (let n = 0; p.listB[n] >= 0; n++) {
      const i = p.listB[n];
      const a = p.arts[i];
      if (a.env.enabled !== 0) {
        const s = this.env[i];
        if (scales) {
          s.scale[0] = f32(s.scale[0] * sa);
          s.scale[1] = f32(s.scale[1] * sd);
          s.scale[2] = f32(s.scale[2] + ss);
          s.scale[3] = f32(s.scale[3] * sr);
          susSetup(a.env, s);
          setStartOfs(a.env, s, s.ofs);
        }
        if (!(this.sharedEnv && a.env.m0 & 2)) {
          const tm = i === 1 ? attVol : att;
          if (fbitsI(tm) > 0) envSkipAttack(a.env, s, tm >= 1 || tm !== tm ? 1 : tm);
        }
      }
      if (fbits(phase) !== 0 && a.lfo.enabled !== 0) lfoAddPhase(this.lfo[i], phase);
    }
  }

  /** Note off (Voice_Release 0xdc1f0): release scale x relTime (FL's FPV_GetRelTime when "Release velocity to envelope release scale" is on, else 1), envelope / LFO release for listB. */
  release(p: ArtPart, relTime: number): void {
    for (let n = 0; p.listB[n] >= 0; n++) {
      const i = p.listB[n];
      const a = p.arts[i];
      const s = this.env[i];
      s.scale[3] = f32(s.scale[3] * relTime);
      envRelease(a.env, s);
      envRelease(a.lfo, this.lfo[i]);
    }
  }

  /** "Envelope release polyphonic scale" on a released voice when a new note starts (TriggerVoice 0xda9c4; once per voice). */
  scalePolyRelease(p: ArtPart, f: number): void {
    for (let n = 0; p.listB[n] >= 0; n++) {
      const i = p.listB[n];
      setScale(this.env[i], 3, f32(this.env[i].scale[3] * f));
      setScale(this.lfo[i], 3, f32(this.lfo[i].scale[3] * f));
    }
  }

  /** Rescale running listB states after `ArtPart.setTimeBase` (0xee620). */
  rescale(p: ArtPart): void {
    for (let n = 0; p.listB[n] >= 0; n++) {
      const i = p.listB[n];
      this.env[i].inc = this.env[i].inc * p.arts[i].env.ratio;
      this.lfo[i].inc = this.lfo[i].inc * p.arts[i].lfo.ratio;
    }
  }

  /**
   * Arpeggio position (0x44fab0 for listB's envelopes and LFOs). FL (Gen_Render
   * 0xe8ba0, when a note started or was released and `p.hasArp` for either
   * part) sorts the distinct V+0x64 note values of the live (V+0x38 == 0,
   * V+0x140 == 0), unreleased (V+0x224 < 6) voices, ascending (descending with
   * "Invert arpeggiator"), and gives every unreleased voice its note's index
   * and the count.
   */
  setArp(p: ArtPart, idx: number, count: number): void {
    for (let n = 0; p.listB[n] >= 0; n++) {
      const i = p.listB[n];
      setArp(p.arts[i].env, this.env[i], idx, count);
      setArp(p.arts[i].lfo, this.lfo[i], idx, count);
    }
  }

  /** Envelope stage of articulator i (FL state+0x8; 9 = finished). */
  envStage(i: number): number {
    return this.env[i].stage;
  }

  /** Articulator finished: envelope and LFO done and the output settled (0xef280). */
  finished(i: number): boolean {
    return this.env[i].stage >= 9 && this.lfo[i].stage >= 9 && Math.abs(f32(this.out[i] - this.target[i])) < FINISHED;
  }

  /** Reset to the state FL's zeroed voice memory has (before any trigger). */
  reset(): void {
    this.base.fill(0);
    this.out.fill(0);
    this.target.fill(0);
    this.envAmt.fill(0);
    for (const s of this.env) { stateKill(s); }
    for (const s of this.lfo) { stateKill(s); }
  }
}

function stateKill(s: CurveState): void {
  s.kill();
}
