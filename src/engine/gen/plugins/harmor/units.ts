// Harmor's per-voice partial processing units: the part's unit chain (FL
// part+0xaa0, method pointers built by 0xca920 from the 12-entry unit order
// part+0xa6c), run once per control block on the voice's partial levels (the
// sine bank's target array: slot 0 resonance oscillator, 1..3 subs, 4..519
// harmonics 1..516) and frequencies:
//   0 dde00 local EQ          1 dda80 prism            2 dde30 randomness
//   3 dcbf0 harmonizer        4 / 5 ddea0 filter 1 / 2 6 def50 phaser
//   7 df500 pluck             8 dd670 harmonic blur    9 dd150 protection
//  10 dd190 clipping         11 dd0f0 envelope volume (folded after the loop)
// Units 4..6 live in ./filters.ts, the others in ./partials.ts.

import type { HVoice } from './voice';
import { mulV, mulCI } from './vec';
import { filterUnit, phaserUnit } from './filters';
import { prismUnit, randomUnit, harmonizerUnit, pluckUnit, blurUnit, protectionUnit, clippingUnit } from './partials';

export { blurKernelShape, prismAmount } from './partials';

/** Render-context fields the units read and write (FL REND = voice + 0x30). */
export interface UnitCtx {
  /** Work buffers (REND+0x20 / +0x28 float, a double buffer). */
  readonly w20: Float32Array;
  readonly w28: Float32Array;
  readonly d20: Float64Array;
  /** +0x7c frequencies were recomputed this block. */
  recalc: boolean;
  /** +0x80 filter mix sign, +0x84 filter unit flag (part+0xb64), +0x88, +0x8c |filter mix|. */
  fmixSign: number;
  fmixUnit: number;
  f88: number;
  fmixAmt: number;
  /** +0x9c resonance oscillator frequency (Hz), +0xa4 / +0xa8 (kept per voice at V+0x27c / +0x280). */
  resHz: number;
  ra4: number;
  ra8: number;
  /** +0xac resonance oscillator level, +0xb4 envelope gain (art1^2 * part+0x18), +0xb8 slot 0 gain. */
  ac: number;
  envGain: number;
  b8: number;
}

/** Run unit `id` of the chain on voice `v`. */
export function applyUnit(id: number, v: HVoice, ctx: UnitCtx): void {
  switch (id) {
    case 0: // dde00: local EQ, unless folded into the timbre tables (unit 0 first)
      if (!v.part.b68) mulV(v.part.localEq, v.sb.amps, v.sb.count);
      break;
    case 1: prismUnit(v, ctx); break;
    case 2: randomUnit(v, ctx); break;
    case 3: harmonizerUnit(v, ctx); break;
    case 4: filterUnit(v, ctx, 0); break;
    case 5: filterUnit(v, ctx, 1); break;
    case 6: phaserUnit(v, ctx); break;
    case 7: pluckUnit(v, ctx); break;
    case 8: blurUnit(v, ctx); break;
    case 9: protectionUnit(v, ctx); break;
    case 10: clippingUnit(v, ctx); break;
    case 11: // dd0f0: envelope volume mid-chain (FL drops it from the chain only when it is last)
      if (ctx.envGain !== 1) {
        mulCI(v.sb.amps, v.sb.count, ctx.envGain);
        ctx.b8 = ctx.envGain;
        ctx.envGain = 1;
      }
      break;
    default: break;
  }
}
