// VFX Level Scaler: note processing only (audio passes through). Each note
// property is normalised (velocity / release / pan / 128, fine pitch / 240,
// mod X / Y / 255), mapped by its curve (lsMap) and written back rounded to
// FL's integer note-property steps.

import type { EffectInstance, EffectModule } from '../types';
import { LS_TARGETS, lsChannel, lsMap } from '../../../model/fx/plugins/vfxlevelscaler';
import type { VfxContext, VfxNote } from '../../../model/fx/plugins/vfx/notes';

type P = Record<string, unknown>;

/** Note field and full scale for each Level Scaler target (LS_TARGETS order). */
const FIELDS: { f: 'vel' | 'rel' | 'fine' | 'pan' | 'modX' | 'modY'; full: number }[] = [
  { f: 'vel', full: 128 }, { f: 'rel', full: 128 }, { f: 'fine', full: 240 },
  { f: 'pan', full: 128 }, { f: 'modX', full: 255 }, { f: 'modY', full: 255 },
];

export function processNotes(notes: VfxNote[], p: P, ctx?: VfxContext): VfxNote[] {
  const chans = LS_TARGETS.map((_, i) => lsChannel(p, i));
  const rnd = ctx?.random ?? Math.random;
  return notes.map((n) => {
    const o = { ...n };
    FIELDS.forEach(({ f, full }, i) => {
      const c = chans[i];
      const r = c.hum > 0 ? rnd() : 0.5;
      o[f] = Math.round(lsMap(n[f] / full, c, r) * full);
    });
    return o;
  });
}

class LevelScaler implements EffectInstance {
  private p: P = {};
  setParams(p: unknown): void { this.p = (p ?? {}) as P; }
  process(): void { /* audio passes through */ }
  reset(): void {}
  notes(n: VfxNote[], ctx?: VfxContext): VfxNote[] { return processNotes(n, this.p, ctx); }
}

export const effect: EffectModule = { id: 'vfxlevelscaler', create: () => new LevelScaler() };
