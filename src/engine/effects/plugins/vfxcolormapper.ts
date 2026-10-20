// VFX Color Mapper: note processing only. Audio passes through untouched (in
// FL a VFX does nothing in a mixer slot). `processNotes` routes each note to
// the voice output of its colour group and gives it the mapped colour group.

import type { EffectInstance, EffectModule } from '../types';
import { COLOR_GROUPS, colKey, outKey } from '../../../model/fx/plugins/vfxcolormapper';
import { clamp, type VfxContext, type VfxNote } from '../../../model/fx/plugins/vfx/notes';

type P = Record<string, unknown>;

const num = (p: P, k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);

/** Each note goes to voice output `out<colour>` (0-based port) with colour group `col<colour>`. */
export function processNotes(notes: VfxNote[], p: P, _ctx?: VfxContext): VfxNote[] {
  return notes.map((n) => {
    const c = clamp(Math.round(n.color), 0, COLOR_GROUPS - 1);
    return { ...n, port: clamp(Math.round(num(p, outKey(c), c)), 0, 15), color: clamp(Math.round(num(p, colKey(c), c)), 0, 15) };
  });
}

class ColorMapper implements EffectInstance {
  private p: P = {};
  setParams(p: unknown): void { this.p = (p ?? {}) as P; }
  process(): void { /* audio passes through */ }
  reset(): void {}
  /** Note processing with the current parameters (not called by the engine yet). */
  notes(n: VfxNote[], ctx?: VfxContext): VfxNote[] { return processNotes(n, this.p, ctx); }
}

export const effect: EffectModule = { id: 'vfxcolormapper', create: () => new ColorMapper() };
