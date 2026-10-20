// Ogun FL content import (pure part). 141 of the 229 factory presets leave out dense resynthesis maps (state.missing: "m1", "m2",
// ... the analysed harmonic spectra, FL content): the user imports them from their own FL installation
// (Data/Patches/Plugin presets/Generators/Ogun/<folder>/<name>.fst; the plugin window's "Import FL content..."). This file picks the
// preset file by the preset's name, checks that it belongs to the state and moves the missing curves into the state; reading the
// file itself is flstate.ts. Nothing of FL's is stored anywhere but in the user's own project.

import type { FxParams } from '../../../fx/types';
import { OGUN_KEYS, ART_TARGETS } from './params';
import type { OgArt, OgEnv } from './types';
import type { OgFlState } from './flstate';

const KEY_RE = /^(?:m(\d+)|a(\d+)(?:(e)|(l)|k(\d+)))$/;

/** The curve of an FL state behind a `missing` key (m<map>, a<art>e, a<art>l, a<art>k<map>); null when the key is not valid. */
export function flCurveFor(st: OgFlState, key: string): OgEnv | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  if (m[1] !== undefined) return st.maps[+m[1]] ?? null;
  const art = st.arts[+m[2]];
  if (!art) return null;
  return m[3] ? art.e : m[4] ? art.l : art.k[+m[5]] ?? null;
}

/** The curve of a plugin state by missing key. */
export function stateCurveFor(p: FxParams, key: string): OgEnv | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  if (m[1] !== undefined) return (p.maps as OgEnv[] | undefined)?.[+m[1]] ?? null;
  const art = (p.arts as OgArt[] | undefined)?.[+m[2]];
  if (!art) return null;
  return m[3] ? art.e : m[4] ? art.l : art.k[+m[5]] ?? null;
}

export interface FillResult {
  /** Keys filled from the FL state. */
  filled: string[];
  /** Keys the FL state has no real curve for (it is as small as the stand-in). */
  absent: string[];
}

/** A curve with its own copy of the arrays (the state's curves are plain JSON). */
function copyCurve(e: OgEnv): OgEnv {
  const c: OgEnv = { t: e.t, p: e.p.map((q) => q.slice()), m: e.m.slice() };
  if (e.a) c.a = e.a.slice();
  if (e.l) c.l = e.l.slice();
  if (e.ph !== undefined) c.ph = e.ph;
  return c;
}

/** Number of points a curve of a state must have to count as FL content rather than a stand-in. */
const STAND_IN_POINTS = 8;

/** The knob values of the stand-in curves the state holds for a curve it leaves out (state.ts: FL's default envelope / LFO). */
const STAND_IN_ADSR = [128, 128, 0, 128];
const STAND_IN_LFO = [40000, 0, 0, 0];
const FLAT_ADSR = ['Att', 'Dec', 'Sus', 'Rel'];
const FLAT_LFO = ['LfoSpd', 'LfoTns', 'LfoSkw', 'LfoPw'];

/**
 * The knob values (ADSR or LFO) of an imported curve. A state leaves out the whole curve, its knob values with it, so the stand-in
 * carries FL's defaults; a value that still is the default takes the file's, a value the user has turned since stays. The first five
 * articulators keep their knobs as flat parameters (the engine and the automation read those), the others in the curve itself.
 */
function mergeKnobs(state: FxParams, art: number, flat: string[], own: number[] | undefined, standIn: number[], fl: number[]): number[] {
  const prefix = art < ART_TARGETS.length ? ART_TARGETS[art][0] : null;
  return fl.map((v, j) => {
    const flatV = prefix ? state[prefix + flat[j]] : undefined;
    const cur = typeof flatV === 'number' ? flatV : own?.[j];
    const out = cur === undefined || cur === standIn[j] ? v : cur;
    if (prefix) state[prefix + flat[j]] = out;
    return out;
  });
}

/**
 * Fill the missing curves of a (draft) plugin state from an FL state (one preset file): each key of `state.missing` whose curve the
 * FL state holds gets that curve and leaves the list. The knob values of an envelope or LFO (the ADSR / LFO values) follow the file
 * where the state still holds the stand-in's defaults and stay where the user has turned them (see mergeKnobs).
 */
export function fillMissing(state: FxParams, st: OgFlState): FillResult {
  const miss = Array.isArray(state.missing) ? (state.missing as string[]) : [];
  const res: FillResult = { filled: [], absent: [] };
  const keep: string[] = [];
  for (const key of miss) {
    const src = flCurveFor(st, key);
    const dst = stateCurveFor(state, key);
    if (!src || !dst || src.t !== dst.t || src.p.length <= STAND_IN_POINTS) { res.absent.push(key); keep.push(key); continue; }
    const c = copyCurve(src);
    const m = KEY_RE.exec(key)!;
    if (m[3] && c.a) c.a = mergeKnobs(state, +m[2], FLAT_ADSR, dst.a, STAND_IN_ADSR, c.a);
    if (m[4] && c.l) {
      c.l = mergeKnobs(state, +m[2], FLAT_LFO, dst.l, STAND_IN_LFO, c.l);
      c.ph = dst.ph ? dst.ph : c.ph;
    }
    if (m[1] !== undefined) (state.maps as OgEnv[])[+m[1]] = c;
    else {
      const art = (state.arts as OgArt[])[+m[2]];
      if (m[3]) art.e = c;
      else if (m[4]) art.l = c;
      else art.k[+m[5]] = c;
    }
    res.filled.push(key);
  }
  state.missing = keep;
  return res;
}

/**
 * How much of a plugin state an FL state agrees with (0..1): the 64 state ints (parameters and settings), the delay bytes, the EQ
 * types and the info text. A preset the user has edited a little still scores high; another preset scores low.
 */
export function matchScore(state: FxParams, st: OgFlState): number {
  let total = 0, same = 0;
  const cmp = (a: unknown, b: number) => { total++; if (a === b) same++; };
  for (let i = 0; i < 49; i++) cmp(state[OGUN_KEYS[i]], st.ints[i]);
  for (let g = 0; g < ART_TARGETS.length; g++) {
    const a = st.arts[g].e.a ?? [], l = st.arts[g].l.l ?? [];
    ['Att', 'Dec', 'Sus', 'Rel'].forEach((s, j) => cmp(state[ART_TARGETS[g][0] + s], a[j]));
    ['LfoSpd', 'LfoTns', 'LfoSkw', 'LfoPw'].forEach((s, j) => cmp(state[ART_TARGETS[g][0] + s], l[j]));
  }
  const xi = Array.isArray(state.xi) ? (state.xi as number[]) : [];
  for (let k = 0; k < 15; k++) cmp(xi[k], st.ints[49 + k]);
  const b3 = Array.isArray(state.b3) ? (state.b3 as number[]) : [];
  for (let k = 0; k < 3; k++) cmp(b3[k], st.b3[k]);
  const i2 = Array.isArray(state.i2) ? (state.i2 as number[]) : [];
  for (let k = 0; k < 3; k++) cmp(i2[k] ?? (k === 2 ? 2 : undefined), st.eq[k]);
  total++;
  if (state.info === st.info) same++;
  return total ? same / total : 0;
}

/** Path parts of a picked file (folder separators of either kind), lower-cased. */
export function pathParts(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).map((s) => s.toLowerCase());
}

/**
 * Does the picked file path name the preset `name` ("Folder/Name" or "Name")? The path must end with the preset's folders and
 * name plus ".fst" (FL's "Plugin presets/Generators/Ogun/Atmospheric/300 Ft Glass Bowl.fst").
 */
export function presetFileMatches(path: string, name: string): boolean {
  const want = pathParts(name);
  const have = pathParts(path);
  if (!want.length || have.length < want.length) return false;
  if (!have[have.length - 1].endsWith('.fst')) return false;
  have[have.length - 1] = have[have.length - 1].slice(0, -4);
  for (let i = 0; i < want.length; i++) if (have[have.length - want.length + i] !== want[i]) return false;
  return true;
}

/** Lowest score of the named preset file / of a file found by comparing the picked presets. */
export const NAMED_SCORE = 0.5;
export const SCAN_SCORE = 0.85;
