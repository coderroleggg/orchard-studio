// VFX Key Mapper (FL: VFX Key Mapper): a note input -> output matrix used
// inside Patcher. Each of the 12 input pitch classes (rows) plays any set of
// output notes over three octaves (columns -12..+23 semitones from the C of
// the input's octave). Form: SynthPanel 775 x 373; MapVisual 8,16 759x239.
// Parameters (FL order, Tags): Enable 0..1 (on), Base key 0..11 (only labels
// the input axis), Offset (transpose) -12..12 (moves the matrix, i.e. the
// root of a key signature), How multiple notes are played 0..4, Pitch sliding
// time 0..192 (ticks at FL's 96 PPQ). The plugin reports no value texts.
// Factory presets: decoded from FL's .fst files (state version 2: the five
// parameters, then per row a count and the output entries).

import type { FxPluginDef, FxPreset } from '../types';

export const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const MULTI_MODES = ['All', 'All (gain-compensated)', 'Random', 'Cycle up', 'Cycle down'];
/** Output columns: -12 .. +23 semitones from the input octave's C. */
export const MAP_LO = -12;
export const MAP_HI = 23;

export type KeyMap = number[][];

export function identityMap(): KeyMap {
  return Array.from({ length: 12 }, (_, i) => [i]);
}

/** Repair a stored matrix: 12 rows of unique integer entries in range. */
export function normalizeMap(m: unknown): KeyMap {
  const rows = Array.isArray(m) ? m : [];
  return Array.from({ length: 12 }, (_, i) => {
    const r = Array.isArray(rows[i]) ? (rows[i] as unknown[]) : [i];
    const out: number[] = [];
    for (const v of r) if (typeof v === 'number' && Number.isFinite(v)) { const k = Math.round(v); if (k >= MAP_LO && k <= MAP_HI && !out.includes(k)) out.push(k); }
    return out;
  });
}

const PRESETS: [string, KeyMap, Record<string, number>][] = [
  ['Chords\\Minor progression', [[7,0,3],[0,3,8],[0,5,8],[3,7,10],[3,7,12],[3,12,8],[5,8,12],[10,7,14],[10,14,5],[15,7,10],[7,10,14],[7,11,14]], {  }],
  ['Chords\\Minor', [[0,3,7],[0,3,5],[2,5,8],[3,7,8],[3,7,10],[5,8,12],[5,8,10],[7,10,14],[8,12,14],[8,12,15],[10,14,15],[10,14,17]], {  }],
  ['Harmony\\Fifth down', [[-5,0],[1,-4],[2,-3],[3,-2],[4,-1],[5,0],[6,1],[7,2],[8,3],[9,4],[10,5],[11,6]], {  }],
  ['Harmony\\Fifth up', [[0,7],[1,8],[2,9],[3,10],[4,11],[5,12],[6,13],[7,14],[8,15],[9,16],[10,17],[11,18]], {  }],
  ['Harmony\\Octave down', [[0,-12],[1,-11],[2,-10],[3,-9],[4,-8],[5,-7],[6,-6],[7,-5],[8,-4],[9,-3],[10,-2],[11,-1]], {  }],
  ['Harmony\\Octave up', [[0,12],[1,13],[2,14],[3,15],[4,16],[5,17],[6,18],[7,19],[8,20],[9,21],[10,22],[11,23]], {  }],
  ['Harmony\\Triads wrap', [[0,4,7],[5,1,8],[2,6,9],[3,7,10],[4,8,11],[5,9,0],[6,10,1],[7,11,2],[8,0,3],[9,1,4],[10,2,5],[11,3,6]], {  }],
  ['Harmony\\Triads', [[0,4,7],[5,1,8],[2,6,9],[3,7,10],[4,8,11],[5,9,12],[6,10,13],[7,11,14],[8,12,15],[9,13,16],[10,14,17],[11,15,18]], {  }],
  ['Scales\\Arabic', [[0],[1],[1],[4],[4],[5],[7],[7],[8],[8],[11],[11]], {  }],
  ['Scales\\Blues', [[0],[0],[3],[3],[5],[5],[6],[7],[7],[10],[10],[10]], {  }],
  ['Scales\\Diminished', [[0],[0],[2],[3],[3],[5],[6],[6],[8],[9],[9],[11]], {  }],
  ['Scales\\Dominant Bebop', [[0],[0],[2],[2],[4],[5],[5],[7],[7],[9],[10],[11]], {  }],
  ['Scales\\Dorian', [[0],[0],[2],[3],[3],[5],[5],[7],[7],[9],[10],[10]], {  }],
  ['Scales\\Enigmatic', [[0],[1],[1],[4],[4],[6],[6],[8],[8],[10],[10],[11]], {  }],
  ['Scales\\Harmonic minor', [[0],[0],[2],[3],[3],[5],[5],[7],[8],[8],[11],[11]], {  }],
  ['Scales\\Hungarian minor', [[0],[0],[2],[3],[3],[6],[6],[7],[8],[8],[11],[11]], {  }],
  ['Scales\\Japanese insen', [[0],[1],[1],[5],[5],[5],[7],[7],[7],[10],[10],[10]], {  }],
  ['Scales\\Locrian', [[0],[1],[1],[3],[3],[5],[6],[6],[8],[8],[10],[10]], {  }],
  ['Scales\\Lydian', [[0],[0],[2],[2],[4],[4],[6],[7],[7],[9],[9],[11]], {  }],
  ['Scales\\Major bebop', [[0],[0],[2],[2],[4],[5],[5],[7],[8],[9],[9],[11]], {  }],
  ['Scales\\Major pentatonic', [[0],[0],[2],[2],[4],[4],[7],[7],[7],[9],[9],[9]], {  }],
  ['Scales\\Major', [[0],[0],[2],[2],[4],[5],[5],[7],[7],[9],[9],[11]], {  }],
  ['Scales\\Melodic minor', [[0],[0],[2],[3],[3],[5],[5],[7],[7],[9],[11],[11]], {  }],
  ['Scales\\Minor Natural (Aeolian)', [[0],[0],[2],[3],[3],[5],[5],[7],[8],[8],[10],[10]], {  }],
  ['Scales\\Minor pentatonic', [[0],[0],[3],[3],[5],[5],[7],[7],[7],[10],[10],[10]], {  }],
  ['Scales\\Mixolydian', [[0],[0],[2],[2],[4],[5],[5],[7],[7],[9],[9],[10]], {  }],
  ['Scales\\Neapolitan minor', [[0],[1],[3],[3],[5],[5],[7],[7],[8],[8],[11],[11]], {  }],
  ['Scales\\Neapolitan', [[0],[1],[3],[3],[5],[5],[7],[7],[9],[9],[11],[11]], {  }],
  ['Scales\\Phrygian', [[0],[1],[3],[3],[5],[5],[7],[7],[8],[8],[10],[10]], {  }],
  ['Scales\\Whole tone', [[0],[0],[2],[2],[4],[4],[6],[6],[8],[8],[10],[10]], {  }],
  ['Special\\Inverted', [[11],[10],[9],[8],[7],[6],[5],[4],[3],[2],[1],[0]], {  }],
  ['Special\\Random minor', [[0],[0,2],[2,0,3],[3,0,2,5],[3,0,2,5,7],[5,0,2,3,7],[5,2,3,7,9],[7,3,5,9,11],[7,5,9,11],[9,7,11],[11,9],[11]], { mode: 2 }],
  ['Special\\Slide down', [[-12],[-11],[-10],[-9],[-8],[-7],[-6],[-5],[-4],[-3],[-2],[-1]], { slide: 144 }],
  ['Default', [[0],[1],[2],[3],[4],[5],[6],[7],[8],[9],[10],[11]], {  }],
];

export const def: FxPluginDef = {
  id: 'vfxkeymapper',
  name: 'VFX Key Mapper',
  category: 'Patcher',
  width: 775,
  height: 373,
  description: 'Transpose, re-key, chord or remap notes with a note matrix (Patcher)',
  params: [
    { key: 'enable', name: 'Enable', index: 0, min: 0, max: 1, def: 1, options: ['Off', 'On'] },
    { key: 'base', name: 'Base key', index: 1, min: 0, max: 11, def: 0, options: KEY_NAMES },
    { key: 'offset', name: 'Offset (transpose)', index: 2, min: -12, max: 12, def: 0, bipolar: true, format: (v) => (v > 0 ? `+${v}` : String(v)) },
    { key: 'mode', name: 'How multiple notes are played', index: 3, min: 0, max: 4, def: 0, options: MULTI_MODES },
    { key: 'slide', name: 'Pitch sliding time', index: 4, min: 0, max: 192, def: 0, format: (v) => (v === 0 ? 'Off' : `${+(v / 24).toFixed(2)} steps`) },
  ],
  state: () => ({ map: identityMap() }),
  normalize: (p) => ({ ...p, map: normalizeMap(p.map) }),
  presets: PRESETS.map(([name, map, params]): FxPreset => ({ name, params: { ...params, map } })),
};
