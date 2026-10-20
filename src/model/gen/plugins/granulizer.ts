// Granulizer (FL: Fruity Granulizer, Plugin database > Generators > Sampler): granular sampler.
// It plays the channel's sample as overlapping grains (attack / hold / spacing), moves through the
// wave at its own rate (wave spacing: time stretching, backwards, freezing), with an LFO and
// randomness on the position, stereo separation of odd / even grains, KEY TO modes (pitch,
// start percent, start steps, transients) and transient detection. See
// docs/research/gen/granulizer.md.
//
// From FL 2026's binary (Fruity Granulizer_x64.dylib, arm64, TTestPlug), its form and the test host:
// - 12 parameters (indices 0..11; the INS block FL lists after them is the channel's INS tab: `ins`),
//   value texts: times 5..500 ms exponential, spacings in percent of 256, the rest percent of the
//   control's maximum (round half away from zero);
// - editor form: SynthPanel 392 x 429;
// - state (SaveRestoreState, version 7): the 12 values, the transients source, the trigger mode,
//   the tempo-lock mode and the INS settings. A new instance gets the plugin database state
//   (version 5: attack 204, hold 50, spacing / wave 611, speed 180, transient hold 228);
// - FL's channel sampler processing runs inside the plugin (levels, release declick): `levels: 'plugin'`.

import type { GenPluginDef } from '../types';
import { fromPct, msParse, msText, percentText, roundEven, spacingParse, spacingText } from './granulizer/convert';
import { defaultGranulizerState, GRAN_DEFAULTS, granulizerState } from './granulizer/state';

const pct = (max: number) => (v: number) => percentText(v, max);
const OFF_ON = ['Off', 'On'];

/**
 * Factory presets (FL's .fst files: state versions 1..5). Fields a version lacks keep FL's loader
 * values: the start 0 and the transient hold time 248 (the loader writes it before the stream
 * read; the test host's stream zero-fills, FL's own stream leaves it).
 */
const P = (name: string, v: Partial<Record<string, number>>) => ({
  name,
  params: { ...GRAN_DEFAULTS, transHold: 248, start: 0, trigger: 0, trans: 0, ...v },
});

export const def: GenPluginDef = {
  id: 'granulizer',
  name: 'Granulizer',
  category: 'Sampler',
  notes: 'voices',
  ins: true,
  levels: 'plugin',
  defPoly: 0,
  width: 392,
  height: 429,
  description: 'Granular sampler: time stretching, pitch shifting and granular effects',
  params: [
    { key: 'attack', name: 'Grain attack time', index: 0, min: 50, max: 500, def: 204, format: msText, parse: msParse },
    { key: 'hold', name: 'Grain hold time', index: 1, min: 0, max: 500, def: 50, format: msText, parse: msParse },
    { key: 'spacing', name: 'Grain spacing', index: 2, min: 125, max: 1000, def: 611, format: spacingText, parse: spacingParse },
    { key: 'wave', name: 'Wave spacing', index: 3, min: -1000, max: 1000, def: 611, format: spacingText, parse: spacingParse, bipolar: true },
    { key: 'depth', name: 'Effect depth', index: 4, min: 0, max: 384, def: 0, format: pct(384), parse: fromPct(384) },
    { key: 'speed', name: 'Effect speed', index: 5, min: 4, max: 200, def: 180, format: pct(200), parse: fromPct(200) },
    { key: 'random', name: 'Randomness', index: 6, min: 0, max: 256, def: 0, format: pct(256), parse: fromPct(256) },
    { key: 'stereo', name: 'Stereo separation', index: 7, min: 0, max: 64, def: 0, format: pct(64), parse: fromPct(64) },
    { key: 'loop', name: 'Repeat sound', index: 8, min: 0, max: 1, def: 0, options: OFF_ON },
    { key: 'holdSound', name: 'Hold sound', index: 9, min: 0, max: 1, def: 0, options: OFF_ON },
    { key: 'start', name: 'Sample start', index: 10, min: 0, max: 4096, def: 0, format: pct(4096), parse: fromPct(4096) },
    { key: 'transHold', name: 'Transient hold time', index: 11, min: 0, max: 500, def: 228, format: msText, parse: msParse },
  ],
  state: () => ({ ...defaultGranulizerState() } as Record<string, unknown>),
  normalize: (p) => ({ ...p, ...granulizerState(p) }) as Record<string, unknown>,
  // FL's GetName(FPN_Semitone) (0x63580): the keys' names depend on KEY TO (Percent: C5..B6 as the start percent,
  // Step: the step and its beat, Transient: "Slice #n")
  keyNames: (params) => {
    const s = granulizerState(params);
    const out: Record<number, string> = {};
    if (s.trigger === 1) {
      for (let k = 0; k < 24; k++) {
        const v = Math.fround(k * 4.166666666666667);
        if (v < 100) out[60 + k] = `${roundEven(v)}%`;
      }
    } else if (s.trigger === 2) {
      for (let k = 0; k < 72; k++) out[60 + k] = k % 4 === 0 ? `${k + 1} - Beat ${k / 4 + 1}` : `${k + 1}`;
    } else if (s.trigger === 3) {
      const n = s.trans === 1 ? s.regions.length : s.trans === 2 ? s.detected.length : 0;
      for (let k = 0; k < Math.min(n, 72); k++) out[60 + k] = `Slice #${k + 1}`;
    }
    return out;
  },
  // the sample belongs to the channel (not to a preset): preset loads keep it, and the editor's view settings
  viewState: ['sample', 'file', 'regions', 'detected', 'detectedFor', 'tempoLocked', 'view'],
  presets: [
    P('Backwards', { attack: 188, hold: 0, wave: -613 }),
    P('Default', { attack: 200 }),
    P('Drumloops', { attack: 190, hold: 118, transHold: 228, trans: 2 }),
    P('Rearranging drumloops', { attack: 50, hold: 172, stereo: 3, loop: 1, transHold: 242, trans: 2, trigger: 2 }),
    P('Stutter', { attack: 200, wave: 107, stereo: 26 }),
    P('Time stretch - twice faster', { attack: 200, spacing: 413 }),
    P('Time stretch - twice slower', { attack: 200, wave: 410 }),
    P('Weird language', { attack: 200, random: 256 }),
  ],
};
