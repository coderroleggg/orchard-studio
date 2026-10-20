// Sytrus default state: FL's factory "Default" patch (Default.fst, what FL
// loads into a new Sytrus): six sine operators at ratio 2 (the note's pitch),
// operator 1 to the output at 100 %, every articulator disabled with FL's
// default ADSR / LFO / flat mappings, filters off, effects off.

import type { SyArtFull, SyEnv, SyFilter, SyGlobal, SyOp, SyState } from './types';
import { UNIT_ARTS, artIsBipolar } from './types';

/** FL's default envelope (ADSR), disabled: decay point 1, sustain point 2. */
export function defaultEnv(): SyEnv {
  return { p: [[0, 0, 0], [0.75, 1, 0.2], [1.5, 0.5, 0.2], [0.25, 0, 0.2]], m: [0, 0, 1, -1, 2] };
}

/** FL's default LFO curve, disabled. */
export function defaultLfo(): SyEnv {
  return { p: [[0, 0.5, 0], [1, 0.5, 0], [0.25, 1, 0], [1, 0.5, 0]], m: [0, 0, -1, -1, 2], ph: 0 };
}

/** A flat mapping at level y (2 points; the unison map has 3). */
export function flatMap(y: number, unison = false): SyEnv {
  return unison
    ? { p: [[0, y, 0], [0.5, y, 0], [0.5, y, 0]], m: [0, -1, -1, -1, -1] }
    : { p: [[0, y, 0], [1, y, 0]], m: [0, -1, -1, -1, -1] };
}

/** Default articulator of unit `unit`, articulator `art` (maps centred for bipolar targets). */
export function defaultArt(unit: number, art: number): SyArtFull {
  const y = artIsBipolar(unit, art) ? 0.5 : 1;
  const e: SyEnv[] = [defaultEnv(), defaultLfo()];
  for (let j = 0; j < 5; j++) e.push(flatMap(y));
  e.push(flatMap(y, true));
  // operators' plucked damp: FL's default damp key mapping
  if (unit < 6 && art === 5) e[2] = { p: [[0, 0.0625, 0], [1, 0.9375, 0.125]], m: [0, -1, -1, -1, -1] };
  return { ea: 1, la: 1, e };
}

const DEFAULT_ARTS: SyArtFull[][] = UNIT_ARTS.map((arts, u) => arts.map((_, a) => defaultArt(u, a)));

/** The default curve of slot j of articulator (unit, art) (shared: do not modify). */
export function defaultArtEnv(unit: number, art: number, j: number): SyEnv {
  return DEFAULT_ARTS[unit][art].e[j];
}

/** Curve j of articulator (unit, art) of a (compact) state, defaults resolved (do not modify the result). */
export function artEnv(sy: SyState, unit: number, art: number, j: number): SyEnv {
  return sy.arts[unit]?.[art]?.e[j] ?? DEFAULT_ARTS[unit][art].e[j];
}

/** Articulator (unit, art) of a (compact) state with every curve resolved (a fresh copy). */
export function resolveArt(sy: SyState, unit: number, art: number): SyArtFull {
  const a = sy.arts[unit]?.[art];
  const d = DEFAULT_ARTS[unit][art];
  return { ea: a ? a.ea : d.ea, la: a ? a.la : d.la, e: d.e.map((de, j) => structuredClone(a?.e[j] ?? de)) };
}

export function defaultOp(): SyOp {
  return {
    ratio: 20000, ofs: 0, ns: 0, sh: 0, tn: 0, sk: 0, sn: 0, fl: 128,
    half: 0, even: 0, abs: 0, glob: 0, center: 0, declick: 0, pluck: 0, blimit: 0,
    amp: [1], ph: [],
  };
}

export function defaultFilter(): SyFilter {
  return { type: 0, hq: 0, flat: 0, ws: 0, wsBip: 0, wsMap: { p: [[0, 0, 0], [1, 0.75, 0.75]], m: [0, -1, -1, -1, -1] } };
}

export function defaultGlobal(): SyGlobal {
  return {
    dqEnv: 0, rqEnv: 1, dqOver: 0, rqOver: 3, modSmooth: 1, rand: 1, gPitch: 0, monoKey: 0, x792: 0, x796: 1,
    sendTrack: -1, soften: 0, oscUni: 0, gCenter: 0, gibbs: 0, arpInv: 0, portaVar: 1, portaTrack: 0, portaLimit: 0,
    velVol: 1, velAtt: 0, relRel: 1, uniDist: 1, eqMode: 0, eqType: [0, 1, 2], x510: 1, hqWs: 0,
  };
}

export function defaultSyState(): SyState {
  const fm = new Array(81).fill(0);
  fm[8] = 256; // operator 1 -> output
  return {
    fm,
    rm: new Array(81).fill(0),
    mute: new Array(162).fill(0),
    ops: Array.from({ length: 6 }, defaultOp),
    flt: Array.from({ length: 3 }, defaultFilter),
    arts: UNIT_ARTS.map((arts) => arts.map(() => null)),
    g: defaultGlobal(),
    del: Array.from({ length: 3 }, () => ({ tempo: 1, serial: 0, on: 0 })),
    rev: { lc: 75, hc: 40, pd: 0, rs: 40, df: 100, de: 15, hd: 40, col: 2, vol: 25, on: 0, tempo: 0 },
    info: 'Patch name    | author\rPatch details',
  };
}
