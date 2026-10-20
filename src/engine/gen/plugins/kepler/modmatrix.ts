// Kepler / Kepler Exo modulation matrix (engine.dylib class "ModMatrixDSP", 0x3080c rebuild, 0x30988 tick,
// 0x30770 destination test). A route table of up to eight (source, destination) pairs is shared by the engine
// (global destinations: LFO rates, effects, volume...) and by every voice (per-voice destinations). A matrix
// groups the routes by destination: its value is the destination's base parameter plus, for every route,
// source * amount, clamped to 0..1, and it is delivered to the parameter once per control period (44 samples).
// Kepler uses two fixed routes (Mod X -> cutoff, Mod Y -> resonance); Exo exposes all eight.

import { fma32 } from './fmath';

/** FL's table entry is invalid when its high bit is set (a stored -1). */
export const NO_ROUTE = -1;

export interface Routes { src: number[]; dst: number[] }

export const NSLOT = 8;

/** Parameter ids the engine itself owns (0x8ef8): everything else is per voice. 92..99 (matrix amounts) belong to both. */
const GLOBAL = new Uint8Array(260);
for (const id of [
  36, 48, 50, 51, 54, 56, 57, 58, 69, 70, 72, 74, 75, 76, 77, 78, 79, 80, 84, 85, 86, 87, 88, 89, 90, 91, 100, 101, 102, 103, 104,
  105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 118, 119, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132,
  133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150,
]) GLOBAL[id] = 1;
for (let id = 92; id <= 99; id++) GLOBAL[id] = 1;

export const isGlobal = (id: number): boolean => id >= 0 && id < 260 && GLOBAL[id] === 1;

/** 0x30770: is `id` the destination of a valid route? (then the parameter reaches its target through the matrix only) */
export function isRouted(r: Routes, id: number): boolean {
  for (let k = 0; k < NSLOT; k++) if (r.dst[k] === id && r.dst[k] >= 0 && r.src[k] >= 0) return true;
  return false;
}

interface Entry {
  dst: number;
  base: () => number;
  srcs: (() => number)[];
  amts: (() => number)[];
}

export class ModMatrix {
  private entries: Entry[] = [];

  /**
   * 0x3080c: collect the routes by destination. The accessors say where a destination's base value, a source's
   * value and a slot's amount live.
   */
  rebuild(
    r: Routes,
    canAdd: (dst: number) => boolean,
    base: (dst: number) => () => number,
    source: (src: number) => () => number,
    amount: (slot: number) => () => number,
  ): void {
    this.entries = [];
    const seen: number[] = [];
    for (let k = 0; k < NSLOT; k++) {
      const dst = r.dst[k], src = r.src[k];
      if (dst < 0 || src < 0) continue;
      if (seen.indexOf(dst) >= 0) continue;
      if (!canAdd(dst)) continue;
      seen.push(dst);
      const e: Entry = { dst, base: base(dst), srcs: [], amts: [] };
      for (let j = 0; j < NSLOT; j++) {
        if (r.dst[j] !== dst || r.src[j] < 0) continue;
        e.amts.push(amount(j));
        e.srcs.push(source(r.src[j]));
      }
      this.entries.push(e);
    }
  }

  /** 0x30988: deliver every destination's modulated value. */
  tick(apply: (dst: number, v: number) => void): void {
    const es = this.entries;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      let v = e.base();
      for (let j = 0; j < e.srcs.length; j++) v = fma32(e.amts[j](), e.srcs[j](), v);
      // fmaxnm / fminnm: a NaN becomes the other operand
      v = v > 0 ? v : 0;
      v = v < 1 ? v : 1;
      apply(e.dst, v);
    }
  }
}
