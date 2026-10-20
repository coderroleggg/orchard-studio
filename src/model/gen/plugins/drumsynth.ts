// DrumSynth Live (FL: Fruity DrumSynth Live, Plugin database > Generators >
// Drum): FL's version of Maxim Digital Audio's DrumSynth (engine by Paul
// Kellett, conversion by Frederic Vanmol, interface by Didier Dambrin): 120 drum
// patches, one per key C0..B9, each with two oscillators, a noise / sample
// generator, a re-trigger envelope, a tone filter, morphing toward another
// patch, panning, level and a send to a mixer track
// (docs/research/gen/drumsynth.md).
//
// From FL 2026's binaries (Fruity DrumSynth Live_x64.dylib: editor form 580 x
// 358, parameter list, value texts; libDrumSynth_Eng_x64.dylib: the engine):
// 4560 parameters = 120 patches x 38, in FL's order (blocks C4..B5, C0..B3,
// C6..B9), named "<key> - <parameter>"; every value text matches FL's for all
// values (test host sweeps). Factory presets: Default and Extra (24 patches each,
// repeated over the five 2-octave blocks as FL's loader does); a new instance
// gets the Default kit.

import type { GenPluginDef } from '../types';

/** FL's 38 parameters of a patch: key suffix, FL name, range, kind. */
export const DS_LOCAL: { k: string; name: string; min: number; max: number }[] = [
  { k: 'level', name: 'Patch Level', min: 0, max: 128 },
  { k: 'pan', name: 'Patch Pan', min: -64, max: 64 },
  { k: 'tone', name: 'Tone Filter: Bass <> Trebble', min: -50, max: 50 },
  { k: 'harm', name: 'Osc1 Harmonics: Odd <> Even', min: -50, max: 50 },
  { k: 'f1', name: 'Osc1 Frequency', min: 0, max: 1000 },
  { k: 'sweep', name: 'Osc1 Sweep Start', min: 0, max: 127 },
  { k: 'sweepT', name: 'Osc1 Sweep Time', min: 0, max: 127 },
  { k: 'dec1', name: 'Osc1 Envelope Decay Time', min: 0, max: 127 },
  { k: 'mix1', name: 'Osc1 Output Level', min: 0, max: 127 },
  { k: 'shape2', name: 'Osc2 Envelope Shape: Exp <> Lin', min: 0, max: 127 },
  { k: 'f2', name: 'Osc2 Frequency', min: 0, max: 1000 },
  { k: 'bw2', name: 'Osc2 Bandwidth', min: 0, max: 127 },
  { k: 'att2', name: 'Osc2 Envelope Attack Time', min: 0, max: 127 },
  { k: 'dec2', name: 'Osc2 Decay Time', min: 0, max: 127 },
  { k: 'mix2', name: 'Osc2 Output Level', min: 0, max: 127 },
  { k: 'wave', name: 'Waveform Select', min: -1, max: 17 },
  { k: 'tune', name: 'Wave Tuning', min: -50, max: 50 },
  { k: 'wmix', name: 'Waveform Mix: Noise <> Wave', min: 0, max: 127 },
  { k: 'rcount', name: 'Envelope Re-Trigger Count', min: 0, max: 100 },
  { k: 'rrate', name: 'Envelope Re-Trigger Rate', min: 0, max: 127 },
  { k: 'rdec', name: 'Envelope Re-Trigger Decay', min: 0, max: 127 },
  { k: 'rel', name: 'Envelope Release Time', min: 0, max: 127 },
  { k: 'inv', name: 'Osc1 Phase Invert', min: 0, max: 1 },
  { k: 'click', name: 'DC Click At Note-On', min: 0, max: 100 },
  { k: 'mode', name: 'Voice Mode: Mono/Poly/Group', min: 0, max: 5 },
  { k: 'vF1', name: 'Vel. > Osc1 Frequency', min: -50, max: 50 },
  { k: 'vL1', name: 'Vel. > Osc1 Output Level', min: -50, max: 50 },
  { k: 'vF2', name: 'Vel. > Osc2 Frequency', min: -50, max: 50 },
  { k: 'vL2', name: 'Vel. > Osc2 Output Level', min: -50, max: 50 },
  { k: 'vTune', name: 'Vel. > Waveform Tuning', min: -50, max: 50 },
  { k: 'vTone', name: 'Vel. > Tone Filter', min: -50, max: 50 },
  { k: 'vHarm', name: 'Vel. > Osc1 Harmonics', min: -50, max: 50 },
  { k: 'noise1', name: 'Osc1 Mode: Swept Tone / Noise Band', min: 0, max: 1 },
  { k: 'ring', name: 'Osc1 > Osc2 Ring Modulation', min: 0, max: 127 },
  { k: 'morph', name: 'Morph To', min: 0, max: 119 },
  { k: 'sendLvl', name: 'Send level', min: 0, max: 128 },
  { k: 'sendTrk', name: 'Send track number', min: -125, max: 125 },
  { k: 'morphMod', name: 'Morph To Modulation', min: 0, max: 128 },
];

export const DS_PATCHES = 120;
export const DS_WAVES = ['808 Cymbal', '808 Cowbell', '606 Cymbal', '909 Closed Hi-Hat', '909 Open Hi-Hat', '909 Crash', '909 Ride',
  'Linn Kick', 'Linn Snare', 'Linn Rim Shot', 'Linn Hat', 'Linn Tamb', 'Linn Conga', 'Real 1', 'Real 2', 'Real 3', 'Real 4', 'Real 5'];
const MODES = ['Mono', 'Poly', 'Group 1', 'Group 2', 'Group 3', 'Group 4'];
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** FL's key name of a patch (key 60 = C5). */
export function dsKeyName(patch: number): string {
  return `${NOTE[patch % 12]}${Math.floor(patch / 12)}`;
}

/** Parameter key of patch p's local parameter i. */
export function dsKey(patch: number, local: number): string {
  return `${DS_LOCAL[local].k}_${patch}`;
}

/** FL's parameter block of a patch (FL lists C4..B5 first, then C0..B3, then C6..B9). */
export function dsBlock(patch: number): number {
  return patch >= 48 && patch < 72 ? patch - 48 : patch < 48 ? patch + 24 : patch;
}

/** Round half to even (FL's Delphi Round). */
function roundEven(x: number): number {
  const f = Math.floor(x), d = x - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
}

/** FL's value texts (test host sweeps, all values). */
export function dsText(local: number, v: number): string {
  const r = Math.round;
  switch (local) {
    case 0: case 35: case 37: return `${r((v * 100) / 128)}%`;
    case 1: return v === 0 ? 'Centered' : `${roundEven((Math.abs(v) * 100) / 64)}% ${v < 0 ? 'left' : 'right'}`;
    case 2: case 3: case 25: case 26: case 27: case 28: case 29: case 30: return `${v * 2}%`;
    case 31: return v === 0 ? 'Off' : `${v * 2}%`;
    case 4: case 10: case 18: return `${v}`;
    case 5: case 9: case 11: case 17: return `${r((v * 100) / 127)}%`;
    case 8: case 14: return v === 0 ? 'Off' : `${r((v * 100) / 127)}%`;
    case 21: return v / 127 >= 0.95 ? 'Off' : `${r((v * 100) / 127)}%`;
    case 6: return v === 127 ? 'Off' : Math.exp(9.210341 * v * 0.007874015748031496).toFixed(1);
    case 7: case 13: case 20: return Math.exp(9.210341 * v * 0.007874015748031496).toFixed(1);
    case 12: case 19: return Math.exp(8.5169 * v * 0.007874015748031496 - 2.3022).toFixed(1);
    case 15: return v < 0 ? 'NO WAVE' : DS_WAVES[v] ?? 'NO WAVE';
    case 16: return (v * 0.02 * 12).toFixed(2);
    case 22: return v ? 'Inverted' : 'Normal';
    case 23: return v > 90 ? 'Random' : `${v}%`;
    case 24: return MODES[v] ?? 'Mono';
    case 32: return v ? 'Noise Band' : 'Swept Tone';
    case 33: case 34: return `${v}%`;
    case 36: return v === 0 ? 'None' : `${v}`;
    default: return `${v}`;
  }
}

/** The factory kits: 24 patches (C4..B5) each, repeated over the five 2-octave blocks by FL's loader. */
const KITS: Record<string, { names: string[]; rows: number[][] }> = {
  Default: {
    names: ["808 Bongo H", "808 Bongo L", "808 Bongo M", "808 Clap", "808 Clave", "808 Cowbell", "808 Hat", "808 Kick", "808 Maracas", "808 Ride", "808 Rim", "808 Snare", "808 Tom H", "808 Tom L", "808 Tom M", "909 Crash", "909 Hat C", "909 Hat O", "909 Hat P", "909 Kick L", "909 Kick S", "909 Kick", "909 Ride", "909 Snare"],
    rows: [
    [91,13,0,0,460,71,0,60,89,0,480,0,64,46,0,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,-1,0,7,48,50,0,64],
    [91,-13,0,0,370,81,0,74,85,0,440,0,64,36,0,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,0,0,0,49,50,0,64],
    [91,13,0,0,410,71,0,60,89,0,480,0,64,46,0,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,0,0,0,50,50,0,64],
    [100,0,20,0,730,90,127,57,67,38,596,61,0,80,44,-1,0,100,2,70,23,127,0,0,0,0,0,0,0,0,0,-1,1,0,51,50,0,64],
    [90,15,0,0,730,64,64,41,88,0,900,0,0,27,30,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,0,0,0,52,50,0,64],
    [100,32,0,0,570,88,127,78,39,0,511,85,0,53,55,1,0,127,1,32,25,127,0,0,0,0,0,0,0,0,0,0,1,0,53,50,0,64],
    [85,-10,0,0,200,64,127,70,0,0,895,51,0,59,66,0,0,127,1,72,25,127,0,0,2,0,0,0,0,0,0,0,0,0,54,50,0,64],
    [100,0,-28,0,178,84,30,80,86,0,490,127,0,13,0,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,0,0,0,55,50,0,64],
    [100,0,0,0,250,64,32,32,0,0,898,63,86,36,59,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,0,0,0,56,50,0,64],
    [97,-26,16,0,908,63,127,84,43,0,770,64,76,102,35,0,0,127,1,32,25,127,1,0,0,0,0,0,0,0,0,-2,1,2,57,50,0,64],
    [89,-31,24,0,481,64,52,44,104,0,675,0,0,19,127,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,0,0,0,58,50,0,64],
    [100,0,15,0,340,70,33,42,84,0,772,78,0,60,51,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,-1,0,0,59,50,0,64],
    [100,-1,-14,0,355,78,0,59,83,0,334,64,38,61,65,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,0,0,0,60,50,0,64],
    [98,-1,-16,0,245,84,0,72,85,0,291,62,44,72,62,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,0,0,0,61,50,0,64],
    [91,-1,-10,0,308,88,0,66,83,0,312,64,41,72,69,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,-1,0,0,62,50,0,64],
    [79,26,0,0,870,51,127,99,0,0,972,127,0,94,64,5,0,127,1,32,25,127,0,0,0,0,0,0,0,0,0,-1,0,0,63,50,0,64],
    [84,9,0,0,879,33,127,51,0,0,1000,127,0,72,42,3,0,127,1,32,25,127,0,0,2,0,0,0,0,0,0,0,1,0,64,50,0,64],
    [70,9,0,0,905,46,127,67,0,39,952,127,8,85,45,4,0,127,1,32,25,127,0,0,2,0,0,0,0,0,0,0,1,0,65,50,0,64],
    [73,11,0,0,905,46,127,67,0,0,960,127,26,63,60,3,0,127,1,32,25,127,0,0,2,0,0,0,0,0,0,-1,1,0,66,50,0,64],
    [99,0,-1,-18,171,81,53,82,91,0,296,127,0,9,89,-1,0,100,1,32,25,64,0,50,0,0,0,0,0,0,0,0,0,0,67,50,0,64],
    [100,0,13,-10,166,80,50,74,88,0,306,127,0,60,65,-1,0,100,1,32,25,127,0,0,3,0,0,0,0,0,0,0,0,0,68,50,0,64],
    [99,0,-1,-18,171,81,53,82,91,0,296,127,0,9,89,-1,0,100,1,32,25,64,0,50,0,0,0,0,0,0,0,-1,0,0,69,50,0,64],
    [75,26,0,0,858,63,127,86,0,0,973,127,0,91,53,6,0,127,1,32,25,127,0,0,0,0,0,0,0,0,0,0,1,0,70,50,0,64],
    [100,0,12,0,319,83,23,50,94,0,841,93,0,65,47,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,0,0,0,71,50,0,64],
  ],
  },
  Extra: {
    names: ["Bright Snare", "CR78 Clave", "CR78 Closed Hat", "CR78 Cowbell", "CR78 Guiro Fast", "CR78 Guiro", "CR78 Kick", "CR78 Open Hat", "CR78 Ride", "CR78 Snare 2", "CR78 Snare", "CR78 Snare 2", "CR78 Snare", "CR78 Squeak", "Dark Snare", "Rhythm Ace Closed Hat", "Rhythm Ace High Tom", "Rhythm Ace Snare", "Rhythm Ace Kick", "Rhythm Ace Low Tom", "Rhythm Ace Open Hat", "Rhythm Ace Rim", "Snappy Kick", "Syn Tom"],
    rows: [
    [117,0,10,50,269,74,22,48,96,0,839,95,0,66,44,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,0,1,17,48,50,0,64],
    [128,0,0,0,529,64,64,46,87,0,851,0,0,27,0,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,1,1,0,49,50,0,64],
    [119,0,0,2,428,64,64,27,1,0,913,28,0,54,62,0,0,127,1,32,25,127,0,0,2,0,0,0,0,0,0,0,1,0,50,50,0,64],
    [128,0,0,27,468,0,127,50,103,0,513,0,0,57,38,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,1,0,0,51,50,0,64],
    [100,-17,0,0,250,64,32,32,0,0,851,34,13,21,69,-1,0,100,8,74,38,127,0,0,0,0,0,0,0,0,0,-1,1,0,52,50,0,64],
    [100,-17,0,0,250,62,32,32,0,0,851,30,13,21,67,-1,0,100,5,80,46,127,0,0,0,0,0,0,0,0,0,-1,0,0,53,50,0,64],
    [128,0,-25,-1,178,66,32,66,100,0,440,0,64,36,0,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,-1,1,0,54,50,0,64],
    [102,0,0,2,944,49,127,27,48,0,913,29,0,76,62,-1,0,100,1,32,25,127,0,0,2,0,0,0,0,0,0,-2,0,0,55,50,0,64],
    [112,0,30,0,860,73,127,70,38,0,827,14,0,71,60,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,0,0,0,56,50,0,64],
    [73,0,0,2,428,64,64,27,92,84,1000,99,0,53,71,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,-1,1,0,57,50,0,64],
    [73,0,0,2,428,64,64,27,92,84,1000,99,0,53,71,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,2,1,0,58,50,0,64],
    [73,0,0,2,428,64,64,27,92,84,1000,99,0,53,71,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,-1,1,0,59,50,0,64],
    [73,0,0,2,428,64,64,27,92,84,1000,99,0,53,71,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,2,1,0,60,50,0,64],
    [128,-1,45,0,844,0,127,0,72,0,858,0,67,0,87,-1,0,100,10,35,18,127,0,0,0,0,0,0,0,0,0,0,1,0,61,50,0,64],
    [94,0,10,50,222,78,24,47,93,99,877,95,0,58,35,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,-2,1,0,62,50,0,64],
    [126,0,-5,-50,250,64,32,32,0,0,898,47,16,42,56,0,0,77,1,32,25,127,0,0,0,0,0,0,0,0,0,-1,0,0,63,50,0,64],
    [128,32,-25,-7,389,0,127,48,67,0,570,85,0,55,74,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,-1,0,0,64,50,0,64],
    [82,0,0,32,332,64,24,25,92,0,833,86,0,57,69,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,-1,1,0,65,50,0,64],
    [128,0,-28,-5,166,69,35,92,87,0,440,0,64,36,0,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,-1,1,0,66,50,0,64],
    [128,32,-25,0,349,0,127,49,118,0,570,85,0,55,22,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,0,0,0,67,50,0,64],
    [128,0,-8,0,900,51,127,41,45,0,934,51,0,73,30,0,0,77,1,32,25,127,0,0,0,0,0,0,0,0,0,0,0,0,68,50,0,64],
    [91,26,-15,0,482,0,127,29,72,0,712,0,0,15,89,-1,0,100,1,32,25,127,0,0,0,0,0,0,0,0,0,0,0,0,69,50,0,64],
    [128,0,13,-10,150,79,45,53,94,0,614,127,0,29,78,-1,0,100,1,32,25,127,0,0,3,0,0,0,0,0,0,0,1,0,70,50,0,64],
    [113,0,0,11,91,92,95,71,101,0,782,106,64,64,0,-1,0,100,1,34,25,127,0,0,0,37,0,0,0,0,0,-22,1,0,71,50,0,64],
  ],
  },
};

/** A kit's state: every patch's parameters plus the patch names. */
export function dsKitState(kit: string): Record<string, unknown> {
  const k = KITS[kit];
  const out: Record<string, unknown> = {};
  for (let p = 0; p < DS_PATCHES; p++) {
    const row = k.rows[p % 24];
    for (let i = 0; i < 38; i++) out[dsKey(p, i)] = row[i];
  }
  out.names = Array.from({ length: DS_PATCHES }, (_, p) => k.names[p % 24]);
  return out;
}

const DEFAULT_KIT = dsKitState('Default');

const params: GenPluginDef['params'] = [];
for (let b = 0; b < DS_PATCHES; b++) {
  const patch = b < 24 ? b + 48 : b < 72 ? b - 24 : b;
  DS_LOCAL.forEach((q, i) => {
    const options = i === 15 ? ['NO WAVE', ...DS_WAVES] : i === 24 ? MODES : i === 22 ? ['Normal', 'Inverted'] : i === 32 ? ['Swept Tone', 'Noise Band'] : undefined;
    params.push({
      key: dsKey(patch, i), name: `${dsKeyName(patch)} - ${q.name}`, index: b * 38 + i, min: q.min, max: q.max,
      def: DEFAULT_KIT[dsKey(patch, i)] as number, format: (v: number) => dsText(i, v), options,
      bipolar: q.min < 0 && i !== 15 && i !== 36,
    });
  });
}

export const def: GenPluginDef = {
  id: 'drumsynth',
  name: 'DrumSynth Live',
  category: 'Drum',
  notes: 'events',
  width: 580,
  height: 358,
  description: 'Multipatch drum synthesizer',
  params,
  // patch names; the editor's selected patch, keyboard octave and AUTO switch; FL's waves imported from the user's FL install
  state: () => ({ names: (DEFAULT_KIT.names as string[]).slice(), sel: 48, octave: 4, auto: false, wavesSample: '' }),
  viewState: ['sel', 'octave', 'auto', 'wavesSample'],
  normalize: (p) => {
    const names = Array.isArray(p.names) ? p.names.slice(0, DS_PATCHES).map((n) => (typeof n === 'string' ? n : '')) : [];
    while (names.length < DS_PATCHES) names.push('');
    const sel = Math.max(0, Math.min(DS_PATCHES - 1, Math.round(Number(p.sel ?? 48)) || 0));
    const octave = Math.max(0, Math.min(8, Math.round(Number(p.octave ?? 4)) || 0));
    return { ...p, names, sel, octave, auto: !!p.auto, wavesSample: typeof p.wavesSample === 'string' ? p.wavesSample : '' };
  },
  presets: Object.keys(KITS).map((name) => ({ name, params: dsKitState(name) })),
};
