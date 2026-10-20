// Ogun / Autogun plugin state (FL Studio 2026, TTestPlug.SaveRestoreState 0x68750, state version 0x130003).
//
// FL's state: int version; zlib( int ints[64]; byte b3[3]; int c3[3] (the three EQ band types: 0 low shelf, 1 peaking, 2 high shelf);
// text (length byte, UTF-16 chars);
// 13 articulators; 4 shaping maps ). ints[0..48] are the global FL parameters (plug+0x13c + 4 i), ints[49..63] the
// plugin's other settings (plug+0x200..0x23b). An articulator (TOpArticulator): int version (3), float mode, float
// envelope amount, float LFO amount, the envelope curve, the LFO curve, four mapping curves (keyboard, velocity, X, Y).
// A curve (TCustomMEnvelope): int type (1 envelope, 2 LFO, 3 map), int version (3), int n, n points { double x, double y,
// float tension, byte b0..b3 }, int markers[5]; an envelope adds int a[4] (ADSR scales), an LFO int l[4] (speed, tension,
// skew, pulse width) and int phase. The curve model is Harmor's (src/model/gen/plugins/harmor/types.ts HEnv).
//
// The state in a project is the flat parameter keys (params.ts) plus the fields below.

export interface OgEnv {
  /** 1 envelope, 2 LFO, 3 mapping. */
  t: number;
  /** Points [x, y, tension, b0, b1, b2, b3] (x is the distance to the previous point; FL's float32 values). */
  p: number[][];
  m: number[];
  a?: number[];
  l?: number[];
  ph?: number;
}

/** An articulator: one modulation target with its envelope, LFO and mappings (keyboard, velocity, X, Y). */
export interface OgArt {
  mode: number;
  ea: number;
  la: number;
  e: OgEnv;
  l: OgEnv;
  k: OgEnv[];
}

/** Numbers of the 13 articulators (target order of FL's "Editor target" list). */
export const OG_ARTS = [
  'Volume', 'Filter frequency', 'Filter resonance', 'Pitch', 'Unison pitch',
  'Unison phase', 'Timbre pre-decay', 'Timbre decay time', 'Timbre release time', 'Timbre fullness',
  'Timbre morphing', 'Timbre rotation', 'Timbre EQ shifting',
] as const;
/** The four shaping maps: forced harmonics, impulse EQ, decay EQ, release EQ (FL objects 13..16). */
export const OG_MAPS = ['Timbre forced harmonics', 'Timbre impulse EQ', 'Timbre decay EQ', 'Timbre release EQ'] as const;
/** The four mapping parts of an articulator. */
export const OG_ART_MAPS = ['Keyboard mapping', 'Velocity mapping', 'Modulation X mapping', 'Modulation Y mapping'] as const;

/** A preset / base entry as generated (presets.ts, base.ts). */
export interface OgEntry {
  i: number[];
  b: number[];
  c: number[];
  t: string;
  a: unknown[][];
  m: unknown[][];
  x: string[];
}
