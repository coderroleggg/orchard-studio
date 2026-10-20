// Fruit Kick (FL: Fruit Kick, Plugin database > Generators > Drum): a simple
// kick drum synthesizer. The framework's reference instrument (see
// docs/gen-framework.md, docs/research/gen/fruitkick.md).
//
// FL's manual: "a sine wave with a fast volume envelope and a quickly falling
// initial pitch"; MAX = start sweep frequency, MIN = end ("sweep to")
// frequency, DEC = pitch sweep time, A. DEC = amplitude decay length, CLICK
// "adds phase offset to the kick sound to produce a click", DIST "applies hard
// clipping to the sine wave oscillator".
// From FL 2026's binary: the form (SynthPanel 380 x 80; wheels MaxFreqWheel
// Tag 0 -2400..3600 def 0, FreqMinWheel Tag 1 -1200..1200 def -600,
// FreqSpeedWheel Tag 2 0..256 def 64, DecayWheel Tag 3 0..256 def 128,
// ClickWheel Tag 4 0..64 def 32, DistWheel Tag 5 0..128 def 0), the test
// host's parameter list and value texts (names "Max freq", "Min freq", "Freq
// decay", "Amp decay", "Click", "Distortion"; every text is v x 100 / max
// rounded half away from zero, also below zero: Max freq -2400 reads -67%),
// the plugin info flags and the eight factory presets (.fst state version 0:
// the six values and the end-frequency increment FL computes from Min freq,
// which it recomputes on load).

import type { GenPluginDef } from '../types';

/** Round half away from zero (FL's texts). */
function roundAway(x: number): number {
  const r = Math.floor(Math.abs(x) + 0.5);
  return x < 0 ? -r : r;
}

/** FL's "percent" value text: v x 100 / max, rounded half away from zero (measured with the test host's sweep). */
export function percentText(v: number, max: number): string {
  const p = roundAway((v * 100) / max);
  return `${p === 0 ? 0 : p}%`;
}

const pct = (max: number) => (v: number) => percentText(v, max);
/** Typed-in percentage -> control value. */
const fromPct = (max: number) => (typed: number) => Math.round((typed / 100) * max);

export const def: GenPluginDef = {
  id: 'fruitkick',
  name: 'Fruit Kick',
  category: 'Drum',
  notes: 'voices',
  ins: true,
  width: 380,
  height: 80,
  description: 'Kick synthesizer',
  params: [
    { key: 'max', name: 'Max freq', index: 0, min: -2400, max: 3600, def: 0, format: pct(3600), parse: fromPct(3600) },
    { key: 'min', name: 'Min freq', index: 1, min: -1200, max: 1200, def: -600, format: pct(1200), parse: fromPct(1200) },
    { key: 'freqDecay', name: 'Freq decay', index: 2, min: 0, max: 256, def: 64, format: pct(256), parse: fromPct(256) },
    { key: 'ampDecay', name: 'Amp decay', index: 3, min: 0, max: 256, def: 128, format: pct(256), parse: fromPct(256) },
    { key: 'click', name: 'Click', index: 4, min: 0, max: 64, def: 32, format: pct(64), parse: fromPct(64) },
    { key: 'dist', name: 'Distortion', index: 5, min: 0, max: 128, def: 0, format: pct(128), parse: fromPct(128) },
  ],
  // earlier versions kept FL's saved end increment as `seed`; FL recomputes it from Min freq
  normalize: (p) => { if (!('seed' in p)) return p; const q = { ...p }; delete q.seed; return q; },
  presets: [
    { name: 'Classic', params: { max: -2400, min: -432, freqDecay: 176, ampDecay: 128, click: 30, dist: 0 } },
    { name: 'Clicky', params: { max: 512, min: -1200, freqDecay: 43, ampDecay: 133, click: 64, dist: 0 } },
    { name: 'Default', params: { max: 0, min: -600, freqDecay: 64, ampDecay: 128, click: 32, dist: 0 } },
    { name: 'High', params: { max: -304, min: -1200, freqDecay: 96, ampDecay: 91, click: 25, dist: 128 } },
    { name: 'Low', params: { max: -2400, min: -832, freqDecay: 143, ampDecay: 127, click: 0, dist: 0 } },
    { name: 'Punchy', params: { max: 624, min: -8, freqDecay: 42, ampDecay: 86, click: 64, dist: 20 } },
    { name: 'Pure click', params: { max: -1216, min: -1200, freqDecay: 0, ampDecay: 0, click: 64, dist: 0 } },
    { name: 'SciFi', params: { max: 3600, min: -1200, freqDecay: 158, ampDecay: 256, click: 0, dist: 0 } },
  ],
};
