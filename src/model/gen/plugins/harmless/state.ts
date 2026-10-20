// Harmless state beyond the 100 parameters (FL SaveRestoreState 0x65280, version 12):
// int32 version, 100 x int32 parameters (99 before version 9), 7 x int32 extra
// controls (version >= 4: filter type, resonance type, phaser type, compression
// type, timbre colour, threaded, quality), int32 n + n x 2 float32 custom timbre
// colour (version >= 8; n = 524 amplitudes then 524 phases in cycles; before
// version 10 the phase half started 4 values later) and a keyboard-shown byte
// (version >= 12). FL's load also converts old versions (parameters 86, 61, 58).
//
// In Orchard Studio's state the extras are numbers under the keys below; the custom
// timbre colour lives in the sample pool (FL content: FL's waveform analysis, or the
// user's own) under `customSample` (mono, 1048 frames: amplitudes then phases).

import { HL_KEYS } from './params';

export const FILTER_TYPES = ['Classic low pass', 'Classic band pass', 'Classic band stop', 'Classic high pass',
  'Crude low pass', 'Crude band pass', 'Crude band stop', 'Crude high pass', 'Hill low pass', 'Leg low pass',
  'Hybrid low pass', 'Snake low pass', 'Fin low pass', 'Leaky low pass', 'Phaser', 'Band phaser', 'Flat band pass'];
export const RES_TYPES = ['Classic', 'Spring', 'Pedestal', 'Sedge hat', 'Wide bump', 'Double cone', 'Well', 'Wormhole', 'Noise'];
export const PHASER_TYPES = ['Classic', 'Triangle', 'Eggs', 'Deep', 'Deeper', 'Condom', 'Twins', 'Cascade', 'Box', 'Freq'];
export const COMP_TYPES = ['Off', 'Limiting', 'Warming', 'Heating', 'Distortion'];
export const TIMBRES = ['Saw', 'Bright saw', 'Brighter saw', 'Dephased saw', 'Dephased saw 2', 'Squaretooth',
  'Squaretooth 2', 'Mole', 'Double saw', 'Triple saw', 'Triple saw 2', 'Custom'];

/** The 7 extra controls in FL's save order, with their ranges (combo value = selectable item index). */
export const HL_EXTRAS = [
  { key: 'filterType', max: FILTER_TYPES.length - 1 },
  { key: 'resType', max: RES_TYPES.length - 1 },
  { key: 'phaserType', max: PHASER_TYPES.length - 1 },
  { key: 'compType', max: COMP_TYPES.length - 1 },
  { key: 'timbre', max: TIMBRES.length - 1 },
  { key: 'threaded', max: 1 },
  { key: 'quality', max: 2 },
] as const;

/** Index of the "Custom" timbre colour. */
export const TIMBRE_CUSTOM = 11;
/** Harmonics in a custom timbre colour (FL: 0x20c). */
export const CUSTOM_N = 524;

export interface HlDecoded {
  version: number;
  params: number[];
  extras: number[];
  /** n amplitudes then n phases (version-10 layout), when the state has a custom timbre. */
  custom?: Float32Array;
  kbShown: number;
}

/** The plugin data (event 0xd5) of an FL .fst preset file, or the bytes themselves when they are not an .fst. */
export function hlFstBlob(b: Uint8Array): Uint8Array | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length < 4 || tag(0) !== 'FLhd') return b;
  if (b.length < 22) return null;
  const hl = dv.getUint32(4, true);
  let p = 8 + hl;
  if (p + 8 > b.length || tag(p) !== 'FLdt') return null;
  const end = Math.min(b.length, p + 8 + dv.getUint32(p + 4, true));
  p += 8;
  while (p < end) {
    const ev = b[p++];
    if (ev < 64) p += 1;
    else if (ev < 128) p += 2;
    else if (ev < 192) p += 4;
    else {
      let n = 0, sh = 0;
      for (;;) { if (p >= end) return null; const c = b[p++]; n += (c & 0x7f) * 2 ** sh; sh += 7; if (!(c & 0x80)) break; }
      if (ev === 0xd5) return p + n <= end ? b.subarray(p, p + n) : null;
      p += n;
    }
  }
  return null;
}

/**
 * Decode FL's Harmless SaveRestoreState blob (defensive: null for anything that is not one).
 * The conversion of parameter 58 for versions < 11 needs engine values and is left to FL's
 * presets (the factory presets were converted by FL itself).
 */
export function hlDecodeBlob(b: Uint8Array): HlDecoded | null {
  if (b.length < 4) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = dv.getInt32(0, true);
  if (version < 2 || version > 64) return null;
  const np = version >= 9 ? 100 : 99;
  let p = 4;
  if (p + np * 4 > b.length) return null;
  const params: number[] = [];
  for (let i = 0; i < np; i++) params.push(dv.getInt32(p + i * 4, true));
  p += np * 4;
  if (np === 99) params.push(0);
  if (version < 5 && params[86] >= 10) params[86]++;
  if (version < 6) params[61] = Math.round(params[61] * 1.2);
  let extras = [4, 0, 0, 0, 0, 1, 0];
  if (version >= 4) {
    if (p + 28 > b.length) return null;
    extras = [];
    for (let i = 0; i < 7; i++) extras.push(dv.getInt32(p + i * 4, true));
    p += 28;
    if (version < 5 && extras[3] === 3) extras[3] = 4;
  }
  let custom: Float32Array | undefined;
  if (version >= 8 && p + 4 <= b.length) {
    const n = dv.getInt32(p, true);
    p += 4;
    if (n > 0 && n <= 4096 && p + n * 8 <= b.length) {
      const f = new Float32Array(n * 2);
      for (let i = 0; i < n * 2; i++) f[i] = dv.getFloat32(p + i * 4, true);
      p += n * 8;
      if (version < 10) f.copyWithin(n, n + 4, 2 * n);
      custom = f;
    }
  }
  const kbShown = version >= 12 && p < b.length ? b[p] : 1;
  return { version, params, extras, custom, kbShown };
}

/** A decoded FL state as an Orchard Studio state (custom timbre not included: it goes to the sample pool). */
export function hlStateFromDecoded(d: HlDecoded): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  HL_KEYS.forEach((k, i) => { o[k] = d.params[i]; });
  HL_EXTRAS.forEach((e, i) => { o[e.key] = d.extras[i]; });
  o.kbShown = d.kbShown ? 1 : 0;
  return o;
}
