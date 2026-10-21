// FL Keys' wavetables as the plugin lists them (FL: the .wti files of FL Keys/Wavtables, matched by name; an
// unknown name loads the first entry, the default). Each has a state key holding the pool sample of the
// user's imported FL data (empty: the synthesized stand-in of the same layout plays). The [parameters]
// defaults are numbers of the wavetable descriptors FL applies when the user picks the table (0..1, null:
// the table sets none).

/** The plugin state keys of FL's 15 parameters, in FL's parameter order (the form's Tag). */
export const KEYS_PARAM_KEYS = [
  'decay', 'release', 'hardness', 'velHardness', 'muffle', 'velMuffle', 'velSens', 'stereo', 'tune', 'detune',
  'stretch', 'treble', 'panTrem', 'lfoRate', 'overdrive',
] as const;

export interface KeysCatalogEntry {
  /** Name in the list and in the state. */
  name: string;
  /** Plugin state key of the pool sample with the imported FL data. */
  key: string;
  /** FL's descriptor file, for the importer. */
  file: string;
  /** Default parameter values the table applies (0..1 per parameter, null = unchanged). */
  defaults: readonly (number | null)[];
}

const NONE = Array<number | null>(15).fill(null);
const set = (o: Record<number, number>) => NONE.map((_, i) => (i in o ? o[i] : null));

export const KEYS_CATALOG: readonly KeysCatalogEntry[] = [
  { name: 'mda Piano', key: 'samplePiano', file: 'mda Piano.wti', defaults: NONE },
  { name: 'Grand Piano', key: 'sampleGrand', file: 'Grand Piano.wti', defaults: set({ 0: 0, 1: 0.41796875, 7: 0 }) },
  {
    name: 'Rhodes (mda ePiano)', key: 'sampleRhodes', file: 'Rhodes.wti',
    defaults: set({ 0: 0, 1: 0.5, 2: 0.5, 3: 0.5, 4: 0.19000244140625, 5: 0.639999389648438, 6: 0.25, 7: 0.5, 8: 0.5, 9: 0.246002197265625, 10: 0, 11: 0.5, 12: 0.199996948242187, 13: 0.649993896484375, 14: 0 }),
  },
  {
    name: 'Roto Organ', key: 'sampleOrgan', file: 'Roto Organ.wti',
    defaults: set({ 0: 0, 1: 0.5, 2: 0.1, 3: 0.1, 4: 0.875, 5: 0.251, 6: 0.376, 7: 0.5, 8: 0.5, 9: 0.1, 10: 0.5, 14: 0 }),
  },
];

/** The catalogue entry of a name (case-insensitive); the first one for an unknown name, like FL. */
export function keysEntry(name: unknown): KeysCatalogEntry {
  const n = typeof name === 'string' ? name.trim().toLowerCase() : '';
  return KEYS_CATALOG.find((e) => e.name.toLowerCase() === n) ?? KEYS_CATALOG[0];
}
