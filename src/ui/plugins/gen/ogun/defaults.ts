// FL's default curves (what the articulator editor's "Reset" gives): the default envelope and LFO of an articulator, its
// mappings at 1 (the unison articulators) or 0.5 (the centred targets), the forced harmonics map at 0, the EQ maps at 0.5.

import type { OgEnv } from '../../../../model/gen/plugins/ogun/types';
import { defaultArt, defaultForcedMap } from '../../../../model/gen/plugins/ogun/flstate';
import { clampPart, targetKind } from './settings';

/** The default curve of a target's part (a fresh copy). */
export function defaultCurveOf(t: number, part: number): OgEnv {
  if (t >= 13) {
    if (t === 13) return defaultForcedMap();
    const m = defaultForcedMap();
    for (const q of m.p) q[1] = 0.5;
    return m;
  }
  const a = defaultArt(t);
  const p = clampPart(t, part);
  if (targetKind(t) === 'map' && p < 2) return a.k[0];
  return p === 0 ? a.e : p === 1 ? a.l : a.k[p - 2];
}
