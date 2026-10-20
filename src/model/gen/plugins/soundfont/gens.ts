// SoundFont 2 generators (SF2 spec 8.1.2): indices, defaults, legal ranges and which generators add between
// the preset and the instrument level. Shared by the engine (voices) and the editor.

export const G = {
  startAddrsOffset: 0, endAddrsOffset: 1, startloopAddrsOffset: 2, endloopAddrsOffset: 3, startAddrsCoarseOffset: 4,
  modLfoToPitch: 5, vibLfoToPitch: 6, modEnvToPitch: 7, initialFilterFc: 8, initialFilterQ: 9,
  modLfoToFilterFc: 10, modEnvToFilterFc: 11, endAddrsCoarseOffset: 12, modLfoToVolume: 13,
  chorusEffectsSend: 15, reverbEffectsSend: 16, pan: 17,
  delayModLFO: 21, freqModLFO: 22, delayVibLFO: 23, freqVibLFO: 24,
  delayModEnv: 25, attackModEnv: 26, holdModEnv: 27, decayModEnv: 28, sustainModEnv: 29, releaseModEnv: 30,
  keynumToModEnvHold: 31, keynumToModEnvDecay: 32,
  delayVolEnv: 33, attackVolEnv: 34, holdVolEnv: 35, decayVolEnv: 36, sustainVolEnv: 37, releaseVolEnv: 38,
  keynumToVolEnvHold: 39, keynumToVolEnvDecay: 40,
  instrument: 41, keyRange: 43, velRange: 44, startloopAddrsCoarseOffset: 45, keynum: 46, velocity: 47,
  initialAttenuation: 48, endloopAddrsCoarseOffset: 50, coarseTune: 51, fineTune: 52, sampleID: 53, sampleModes: 54,
  scaleTuning: 56, exclusiveClass: 57, overridingRootKey: 58,
} as const;

export const NUM_GENS = 60;

/** Generator defaults (SF2 spec): everything 0 except these. */
export function defaultGens(): Float64Array {
  const g = new Float64Array(NUM_GENS);
  g[G.initialFilterFc] = 13500;
  for (const d of [G.delayModLFO, G.delayVibLFO, G.delayModEnv, G.attackModEnv, G.holdModEnv, G.decayModEnv, G.releaseModEnv,
    G.delayVolEnv, G.attackVolEnv, G.holdVolEnv, G.decayVolEnv, G.releaseVolEnv]) g[d] = -12000;
  g[G.freqModLFO] = 0; // absolute cents: 8.176 Hz
  g[G.freqVibLFO] = 0;
  g[G.keynum] = -1;
  g[G.velocity] = -1;
  g[G.scaleTuning] = 100;
  g[G.overridingRootKey] = -1;
  return g;
}

/** Legal ranges [min, max] of the generators (spec 8.1.3), for reference: FL does not clamp the instrument + preset sum (its voice handlers clamp what they use). */
export const GEN_RANGES: Record<number, [number, number]> = {
  [G.modLfoToPitch]: [-12000, 12000], [G.vibLfoToPitch]: [-12000, 12000], [G.modEnvToPitch]: [-12000, 12000],
  [G.initialFilterFc]: [1500, 13500], [G.initialFilterQ]: [0, 960],
  [G.modLfoToFilterFc]: [-12000, 12000], [G.modEnvToFilterFc]: [-12000, 12000], [G.modLfoToVolume]: [-960, 960],
  [G.chorusEffectsSend]: [0, 1000], [G.reverbEffectsSend]: [0, 1000], [G.pan]: [-500, 500],
  [G.delayModLFO]: [-12000, 5000], [G.freqModLFO]: [-16000, 4500], [G.delayVibLFO]: [-12000, 5000], [G.freqVibLFO]: [-16000, 4500],
  [G.delayModEnv]: [-12000, 5000], [G.attackModEnv]: [-12000, 8000], [G.holdModEnv]: [-12000, 5000], [G.decayModEnv]: [-12000, 8000],
  [G.sustainModEnv]: [0, 1000], [G.releaseModEnv]: [-12000, 8000], [G.keynumToModEnvHold]: [-1200, 1200], [G.keynumToModEnvDecay]: [-1200, 1200],
  [G.delayVolEnv]: [-12000, 5000], [G.attackVolEnv]: [-12000, 8000], [G.holdVolEnv]: [-12000, 5000], [G.decayVolEnv]: [-12000, 8000],
  [G.sustainVolEnv]: [0, 1440], [G.releaseVolEnv]: [-12000, 8000], [G.keynumToVolEnvHold]: [-1200, 1200], [G.keynumToVolEnvDecay]: [-1200, 1200],
  [G.initialAttenuation]: [0, 1440], [G.coarseTune]: [-120, 120], [G.fineTune]: [-99, 99], [G.scaleTuning]: [0, 1200],
};

/**
 * Generators that only exist at the instrument level (SF2 spec 9.4: a preset zone cannot set them, they are
 * ignored there): sample addresses, key / velocity overrides, sample modes, exclusive class and the root key.
 */
export const INSTRUMENT_ONLY: ReadonlySet<number> = new Set([
  G.startAddrsOffset, G.endAddrsOffset, G.startloopAddrsOffset, G.endloopAddrsOffset, G.startAddrsCoarseOffset,
  G.endAddrsCoarseOffset, G.startloopAddrsCoarseOffset, G.endloopAddrsCoarseOffset, G.keynum, G.velocity,
  G.sampleModes, G.exclusiveClass, G.overridingRootKey,
]);
