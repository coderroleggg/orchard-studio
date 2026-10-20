// Slicex's articulators (FL: TArticulator 0x38d300 / TGroupArticulator 0x31bb78 /
// TScratchGroupArticulator 0x31bc88): per group 6 targets (pan, vol, cutoff, resonance, speed,
// start), each an envelope, an LFO and four mappings (MOD X, MOD Y, velocity, random). Target
// modes from the plugin constructor (0x747a0): volume and speed multiply (mode 0), the others add
// (mode 1, curves offset by 0.5); speed is the scratch articulator (envelope + LFO times the value).

import type { SxArt, SxTarget } from '../../../../model/gen/plugins/slicex/types';
import {
  Curve, CurveState, T_ENV, T_LFO, T_MAP, envEval, envNoteOn, lfoEval, lfoNoteOn, mapTable,
} from './env';

const f32 = Math.fround;

/** A voice's state of one target (FL voice +0x164 + 0x108 t: envelope, LFO, value). */
export class TargetState {
  readonly env = new CurveState();
  readonly lfo = new CurveState();
  value = 0;

  kill(): void {
    this.env.kill();
    this.lfo.kill();
  }
}

export class ArtTarget {
  readonly mode: number;
  readonly scratch: boolean;
  /** Base value, envelope and LFO amounts (FL floats +0x20 / +0x24 / +0x28). */
  base = 0;
  ea = 1;
  la = 1;
  readonly env = new Curve(T_ENV);
  readonly lfo = new Curve(T_LFO);
  /** MOD X, MOD Y, velocity and random mappings. */
  readonly maps = [new Curve(T_MAP), new Curve(T_MAP), new Curve(T_MAP), new Curve(T_MAP)];
  /** FL's 513-entry MOD X / Y tables (+0x50 / +0x58), null while the map is at its default. */
  tabX: Float32Array | null = null;
  tabY: Float32Array | null = null;
  private readonly bufX = new Float32Array(513);
  private readonly bufY = new Float32Array(513);
  velOn = false;
  randOn = false;

  constructor(t: number) {
    this.mode = t === 1 || t === 4 ? 0 : 1;
    this.scratch = t === 4;
    // SetMode (0x7f050 -> 0x27f880 / 0x27f8e0): clamping on for the adding modes, envelope and map
    // offsets 0.5 * mode; the LFO keeps its constructor's 0.5. Speed: envelope and LFO offsets 0.5.
    const o = 0.5 * this.mode;
    this.env.clamp = this.mode;
    this.lfo.clamp = this.mode;
    this.env.offset = t === 4 ? 0.5 : o;
    this.lfo.offset = 0.5;
    for (const m of this.maps) { m.offset = o; m.def = 1 - o; }
    // class flags: envelope without bits 1 and 4, LFO without bit 4 (TGroupArticulator constructor 0x7ead0)
    this.env.flags &= ~0x12;
    this.lfo.flags &= ~0x10;
  }

  /** Load the target's curves; `adsr` / `lfo` (ints) override the stored values when given (parameters). */
  load(t: SxTarget, adsr: ArrayLike<number> | null, lfoI: ArrayLike<number> | null, speedTime: number, speedTempo: number): void {
    this.base = f32(t.b);
    this.ea = f32(t.ea);
    this.la = f32(t.la);
    const e = adsr ? { ...t.env, a: Array.from(adsr) } : t.env;
    const l = lfoI ? { ...t.lfo, l: Array.from(lfoI) } : t.lfo;
    this.env.load(e);
    this.lfo.load(l);
    this.env.setSpeed(speedTime, speedTempo);
    this.lfo.setSpeed(speedTime, speedTempo);
    this.env.changed();
    this.lfo.changed();
    for (let i = 0; i < 4; i++) this.maps[i].load(t.maps[i]);
    this.tabX = this.maps[0].isDefault() ? null : (mapTable(this.maps[0], this.bufX), this.bufX);
    this.tabY = this.maps[1].isDefault() ? null : (mapTable(this.maps[1], this.bufY), this.bufY);
    this.velOn = !this.maps[2].isDefault();
    this.randOn = !this.maps[3].isDefault();
  }

  /** New control rate / tempo: curve time per tick (FL 0x7d070 -> 0x27f800 -> 0x27d3e0). */
  setSpeed(time: number, tempo: number): void {
    this.env.setSpeed(time, tempo);
    this.lfo.setSpeed(time, tempo);
    this.lfo.changed();
  }

  /** FL 0x27f5d0: envelope and LFO note on, value = base + envelope (+ LFO by mode). */
  noteOn(s: TargetState): void {
    envNoteOn(this.env, s.env);
    lfoNoteOn(this.lfo, s.lfo);
    s.value = this.base;
    if (this.env.enabled !== 0) s.value = s.value + s.env.out * this.ea;
    if (this.lfo.enabled !== 0) {
      if (this.mode === 1) s.value = s.value + s.lfo.lfoOut * this.la;
      else s.value = s.value * (s.lfo.lfoOut * this.la * 2 + 1);
    }
  }

  /** One control tick (FL 0x7ee40 / scratch 0x7ef90); s.value holds the voice's base value. */
  process(s: TargetState, step: number): void {
    if (this.scratch) {
      let d = 0;
      if (this.env.enabled !== 0) { envEval(this.env, s.env, step); d = d + s.env.out; }
      if (this.lfo.enabled !== 0) { lfoEval(this.lfo, s.lfo, step); d = d + s.lfo.lfoOut * this.la; }
      s.value = s.value * d;
      return;
    }
    if (this.env.enabled !== 0) {
      envEval(this.env, s.env, step);
      if (this.mode === 1) s.value = s.value + s.env.out * this.ea;
      else s.value = s.value * s.env.out;
    }
    if (this.lfo.enabled !== 0) {
      lfoEval(this.lfo, s.lfo, step);
      if (this.mode === 1) s.value = s.value + s.lfo.lfoOut * this.la;
      else s.value = s.value * (s.lfo.lfoOut * this.la * 2 + 1);
    }
  }
}


/** A compiled articulator group. */
export class ArtGroup {
  /** Filter type (0 LP, 1 BP, 2 BS, 3 HP) and stages (0 = no filter). */
  ftype = 0;
  fstages = 0;
  /** Cutoff / resonance offsets from the group's knobs ((knob - 128) / 256, FL +0x48 / +0x4c). */
  fcOfs = 0;
  frOfs = 0;
  readonly t: ArtTarget[] = [];

  constructor() {
    for (let i = 0; i < 6; i++) this.t.push(new ArtTarget(i));
  }

  load(a: SxArt, params: (key: string) => number, g: number, lfoLevel: number, speedTime: number, speedTempo: number): void {
    this.ftype = a.ft;
    this.fstages = a.fo;
    const fenv = params(`g${g + 1}_fenv`), fcut = params(`g${g + 1}_fcut`), fres = params(`g${g + 1}_fres`);
    this.fcOfs = f32((fcut - 128) * 0.00390625);
    this.frOfs = f32((fres - 128) * 0.00390625);
    const tk = ['pan', 'vol', 'cut', 'res', 'spd'];
    const fk = ['att', 'dec', 'sus', 'rel', 'lspd', 'lten', 'lskw', 'lpw'];
    for (let i = 0; i < 6; i++) {
      const tt = this.t[i];
      if (i < 5) {
        const p = (f: number) => params(`g${g + 1}_${tk[i]}_${fk[f]}`);
        tt.load(a.t[i], [p(0), p(1), p(2), p(3)], [p(4), p(5), p(6), p(7)], speedTime, speedTempo);
      } else tt.load(a.t[i], null, null, speedTime, speedTempo);
      tt.la = lfoLevel;
    }
    // the filter envelope amount knob (ProcessParam 0x76054.. for the header fields)
    const c = this.t[2];
    c.ea = f32(fenv * 0.0078125);
    c.la = f32(c.ea * lfoLevel);
  }
}
