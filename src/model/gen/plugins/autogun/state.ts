// Autogun's state (FL: Autogun_x64.dylib, the Ogun code base plus a hosted Soundgoodizer). FL's plugin keeps a complete Ogun patch
// and the number of the preset it was generated from; the patch is a pure function of that number (the plugin's random preset
// generator, 0x70170, is Ogun's with a different info text), so the state here is only what a user can change:
//
//   level    master level, FL parameter 0 (0 .. 256, 256 = 200 %)
//   dust     "magic dust" 0 .. 1000: the mix of the Soundgoodizer (plug+0x238, state int 63); 0 switches it off
//   n        the preset counter (plug+0x620, 0 .. 4294967295): the seed of the generated preset; the number shown is n + 1
//   quality  processing quality 0 .. 4 (state int 54: Draft .. Huge waste of CPU); a generated preset resets it to 1
//
// `ogunStateOf` expands that into the Ogun state the engine plays (src/engine/gen/plugins/autogun.ts).

import type { GenParamDef } from '../../types';
import type { FxParams } from '../../../fx/types';
import { OGUN_KEYS, OGUN_PARAMS } from '../ogun/params';
import { generateOgun } from '../ogun/random';
import { normalizeOgun } from '../ogun/state';

/** FL's parameter list: the master level only (NumParams 1); its text is Ogun's. */
export const AUTOGUN_PARAMS: GenParamDef[] = [{ ...OGUN_PARAMS[0], def: 256 }];

export const AG_DUST_DEFAULT = 430;
export const AG_DUST_MAX = 1000;
/** The quality a generated preset has (the template's). */
export const AG_QUALITY_DEFAULT = 1;
export const AG_QUALITIES = ['Draft', 'Average', 'High', 'Pristine', 'Huge waste of CPU'];
/** Numbers of presets: 1 .. 4294967296 (the 32 bit counter + 1). */
export const AG_PRESETS = 4294967296;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clampInt = (v: unknown, lo: number, hi: number, d: number): number => (isNum(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

/** The preset counter of a stored value (an unsigned 32 bit integer). */
export function counterOf(v: unknown): number {
  return isNum(v) ? Math.floor(v) % AG_PRESETS >>> 0 : 0;
}

/** FL's constructor draws the counter of a new instance at random (Random * 2^32, rounded). */
export function randomCounter(rnd: () => number = Math.random): number {
  return Math.round(rnd() * AG_PRESETS) >>> 0;
}

/** The number FL shows for a counter (and asks for in "Enter preset number...": the counter + 1). */
export const presetNumber = (n: number): number => counterOf(n) + 1;
/** The counter of a preset number 1 .. 4294967296. */
export const counterOfNumber = (num: number): number => (num - 1) >>> 0;

// the generated patches (Ogun states): large (up to 31 000 map points), so only a few are kept
const cache = new Map<number, FxParams>();
const CACHE = 4;

/** The Ogun patch Autogun generates for preset counter `n` (FL: master level / magic dust / quality are the plugin's own). Read only. */
export function autogunPatch(n: number): FxParams {
  n = counterOf(n);
  let p = cache.get(n);
  if (p) {
    cache.delete(n);
  } else {
    const g = generateOgun(n, true);
    p = normalizeOgun(g);
    // FL's state holds values the controls cannot take (the "Large hall" reverb preset has a low cut of 0, below the control's 19)
    for (let i = 0; i < 49; i++) p[OGUN_KEYS[i]] = g[OGUN_KEYS[i]];
    if (cache.size >= CACHE) cache.delete(cache.keys().next().value as number);
  }
  cache.set(n, p);
  return p;
}

/** A new Autogun: FL's constructor state (random preset, master level 256, magic dust 430, quality 1). */
export function freshState(counter: number = randomCounter()): FxParams {
  return { dust: AG_DUST_DEFAULT, n: counterOf(counter), quality: AG_QUALITY_DEFAULT };
}

/** Repair a stored state (the parameter itself is clamped by the framework). */
export function normalizeAutogun(p: FxParams): FxParams {
  return {
    ...p,
    dust: clampInt(p.dust, 0, AG_DUST_MAX, AG_DUST_DEFAULT),
    n: counterOf(p.n),
    quality: clampInt(p.quality, 0, 4, AG_QUALITY_DEFAULT),
  };
}

/**
 * The Ogun state a stored Autogun state plays: the patch of its preset counter (`patch`: already generated, for callers that hold it)
 * with the plugin's level, quality and magic dust.
 */
export function ogunStateOf(p: FxParams, patch?: FxParams): FxParams {
  const s = normalizeAutogun(p);
  const base = patch ?? autogunPatch(s.n as number);
  const xi = (base.xi as number[]).slice();
  xi[5] = s.quality as number; // state int 54
  xi[14] = s.dust as number; // state int 63
  return { ...base, level: clampInt(p.level, 0, 256, 256), xi };
}

/** The memo's style codes around the title (U+E427 .. U+E4FF) and the author (U+E5A0 .. U+E5FF) in a generated preset's info text. */
const MARK = /[]/g;

/** A preset's info text as the screen shows it: title, author and the description lines (generated text: "<title>\r<author>\r<lines>"). */
export function infoOf(info: string): { title: string; author: string; lines: string[] } {
  const rows = String(info ?? '').split('\r');
  const styled = (info ?? '').includes('');
  const clean = rows.map((r) => r.replace(MARK, ''));
  const title = clean[0] ?? '';
  const author = styled ? clean[1] ?? '' : '';
  return { title, author, lines: clean.slice(styled ? 2 : 1).filter((r) => r !== '') };
}

/** The info text of the preset with counter `n`. */
export function presetInfo(n: number): { title: string; author: string; lines: string[] } {
  return infoOf(autogunPatch(n).info as string);
}
