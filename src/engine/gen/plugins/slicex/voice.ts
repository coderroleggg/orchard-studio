// A Slicex voice (FL's 0x984-byte voice object: TriggerVoice 0x79860, render 0x7bf50,
// Voice_Release 0x7b350, quick release 0x7b540, Voice_Kill 0x7b650), single precision where FL
// keeps floats. One note can start several voices (layered regions); they are linked to the
// first one, which stands for the note.

import type { GenNote } from '../../types';
import { DeclickState } from './declick';
import { SxResampler } from './resampler';
import { TargetState } from './art';
import { FilterStage } from './filter';

/** Region record floats (FL 0x7f7e0) plus the integer fields the voice uses. */
export class RegionRec {
  cut = 0; out = 0;
  /** +0x44 pan (-1..1), +0x48 gain (volume curve), +0x4c amp amount. */
  pan = 0; gain = 1; aAmt = 1;
  /** +0x50 / +0x54 cutoff and resonance (0..1), +0x58 filter amount. */
  fc = 0.5; fr = 0.5; fAmt = 1;
  /** +0x5c pitch (cents), +0x60 speed amount x 8, +0x64 delay, +0x68 start, +0x6c start amount x 2. */
  pitch = 0; sAmt8 = 8; delay = 0; ofs = 0; oAmt2 = 2;
  aArt = 0; fArt = 0; sArt = 0; oArt = 0;
}

export class Voice {
  active = false;
  /** The note it plays and the voice that stands for the note (null: this one). */
  note: GenNote | null = null;
  parent: Voice | null = null;
  next: Voice | null = null;
  children = 0;
  deck = 0;
  region = 0;
  key = 60;
  readonly rec = new RegionRec();
  /** FL's voice +0x88: 1 playing, 5.. released, 9 ending (release declick), 10 done. */
  state = 0;
  /** Delay countdown (frames), control tick countdown, first tick flag. */
  delay = 0;
  tick = 0;
  first = 1;
  /** Mod X / Y (smoothed) and their table indexes 0..512. */
  modX = 0;
  modY = 0;
  ix = 256;
  iy = 256;
  /** Speed modulation active (+0xf8), base speed (+0xb4), current speed (+0xb0). */
  speedMod = false;
  baseSpeed = 1;
  speed = 1;
  /** Scratch gain: last position (+0xa0), threshold (+0xa8) and its inverse (+0xac). */
  lastPos = -2147483647;
  scrTh = 0;
  scrInv = 0;
  /** Gains: new [0..3], ramp state cur [0..3] / inc [4..7] / target [8..11]. */
  readonly gNew = new Float32Array(4);
  readonly g = new Float32Array(12);
  /** Initial target values (+0x7ac) and target states (+0x164 + 0x108 t). */
  readonly base = new Float64Array(6);
  readonly ts: TargetState[] = [];
  /** Target articulator groups (-1: none) per target. */
  readonly tg = new Int8Array(6);
  /** Filter: type (+0x800), stages - 1 (+0x804), gain scale (+0x808 / +0x80c), stages. */
  ftype = 0;
  fst = -1;
  fexp = 1;
  fscale = 1;
  readonly stages: FilterStage[] = [];
  readonly dc = new DeclickState();
  readonly res: SxResampler;

  constructor(maxBlock: number) {
    this.res = new SxResampler(maxBlock);
    for (let t = 0; t < 6; t++) this.ts.push(new TargetState());
    for (let s = 0; s < 3; s++) this.stages.push(new FilterStage());
  }
}
