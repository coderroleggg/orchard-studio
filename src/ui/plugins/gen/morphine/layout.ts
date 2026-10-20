// Morphine editor layout: FL's control positions from the plugin's GUI code
// (Morphine_x64.dylib, arm64: main editor 0x304d4, generator page 0x4186c /
// 0x41ec0, morph page 0x3d7ac, modulation page 0x1dc40 / 0x1e740; controls
// placed with SetBounds / SetPos and bound to parameter tags). The panel is
// 886 x 552 (the page backgrounds' size). Parameter numbers are FL's indices.

export const PANEL_W = 886;
export const PANEL_H = 552;

/** A 52 px hardware knob (top bar, effects): [param, x, y, caption]. */
export const BIG_KNOBS: [number, number, number, string][] = [
  [1, 427, 26, 'GLIDE'], [2, 484, 26, 'VEL CRV'], [30, 543, 26, 'ATTACK'], [31, 600, 26, 'DECAY'], [32, 657, 26, 'SUSTAIN'],
  [33, 714, 26, 'RELEASE'], [6, 773, 26, 'DRIVE'], [0, 830, 26, 'LEVEL'],
  [7, 6, 474, 'DEPTH'], [9, 63, 474, 'RATE'], [8, 120, 474, 'MIX'],
  [11, 179, 474, 'TIME'], [12, 236, 474, 'STEREO'], [14, 293, 474, 'FDBK'], [13, 350, 474, 'MOD DEPTH'], [15, 407, 474, 'MIX'],
  [17, 466, 474, 'DECAY'], [18, 523, 474, 'HI-CUT'], [19, 580, 474, 'MIX'],
];

/** Effect enable buttons (18 x 18): [param, x, y]. */
export const FX_ENABLES: [number, number, number][] = [[10, 48, 448], [16, 282, 448], [20, 509, 448], [29, 713, 448]];

/** The equalizer's faders (27 px): [param, x, y, caption]. */
export const EQ_FADERS: [number, number, number, string][] = [
  [21, 643, 467, '62'], [22, 673, 467, '125'], [23, 703, 467, '250'], [24, 733, 467, '500'],
  [25, 763, 467, '1K'], [26, 793, 467, '2K'], [27, 823, 467, '4K'], [28, 853, 467, '8K'],
];

/** Effect section titles: [text, centre x]. */
export const FX_TITLES: [string, number][] = [['CHORUS', 96], ['DELAY', 320], ['REVERB', 553], ['EQUALIZER', 772]];

/** The top bar's number boxes / menus: polyphony (internal 124), transpose (4), fine (5), glide mode (internal 125). */
export const TOP_BOXES = { poly: [15, 63, 55, 17], transp: [80, 63, 55, 17], fine: [145, 63, 55, 17], gmode: [210, 63, 55, 17] } as const;
export const GLIDE_MODES = ['Bend VT', 'Held VT', 'Bend ST', 'Held ST'];

/** Program name box, the options menu and the previous / next program buttons. */
export const PROGRAM_BOX = [16, 41, 238, 16] as const;
export const OPTIONS_MENU = [172, 15, 92, 18] as const;
export const PRG_PREV_NEXT = [[255, 39], [255, 49]] as const;

/** The page selector (left column): FL's six pages. */
export const PAGES = ['MORPHING', 'MODULATION', 'GENERATOR A', 'GENERATOR B', 'GENERATOR C', 'GENERATOR D'];
export const PAGE_TABS = [5, 105, 104, 140] as const;

/** Resynthesis box: charge sample button, sample name, note / detune numbers (internal 141 / 142), resolution (144), balance knob (143), test button. */
export const RESYNTH = {
  charge: [5, 271, 98, 23], name: [12, 295, 83, 14], note: [54, 316, 40, 14], detune: [54, 336, 40, 14],
  resolution: [65, 356, 29, 14], balance: [7, 378], test: [58, 390, 40, 22],
} as const;
export const RESOLUTIONS = ['Norm', 'High', 'Best'];

// ------------------------------------------------------------- generator page (one per generator g = 0..3)
/** Generator parameter g of FL's 10 per generator: index 43 + 10 g + k. */
export const genParam = (g: number, k: number) => 43 + 10 * g + k;
export const GEN = {
  bpMenu: [121, 115, 92, 18], bpInfo: [216, 116, 144, 18], tool: [400, 116, 36, 18], views: [442, 115, 315, 19],
  spectrum: [118, 136, 640, 75], tlMenu: [121, 221, 84, 18], loop: [248, 222, 75, 18], relLoop: [337, 221, 85, 19],
  sync: [424, 221, 85, 19], rate: [544, 221], keyTrk: [635, 221], velTrk: [726, 221],
  timeline: [120, 240, 639, 82], ruler: [121, 322, 632, 11], zoneMenu: [124, 342, 156, 12], zones: [121, 362, 633, 68],
  // control range (detune / pan range) and PWM filter (rate / phase) faders, PWM free and mode
  detune: [774, 134], pan: [849, 134], pwmRate: [774, 279], pwmPhase: [849, 279], pwmFree: [805, 371, 37, 24], pwmMode: [772, 411, 108, 14],
} as const;
export const PARTIAL_VIEWS = ['AMPLITUDE', 'PANNING', 'DETUNE', 'VELOCITY', 'WINDOW'];
export const TOOLS = ['One', 'Odd', 'Even', '3rds', '4ths', '5ths', 'Flt 1', 'Flt 2', 'Flt 3', 'Flt 4'];
export const LOOP_MODES = ['Off', 'Forward', 'Backward', 'Ping-Pong'];
export const PWM_MODES = ['OFF', 'ABS', 'POS'];

// ------------------------------------------------------------- morph page
export const MORPH = {
  xy: [156, 144, 252, 252], pathMenu: [462, 111, 209, 18], pathName: [675, 113, 196, 16],
  laneX: [459, 131, 412, 82], laneY: [459, 229, 412, 82], ruler: [461, 215, 410, 11],
  loop: [495, 312, 58, 18], sync: [557, 311, 71, 19], rate: [662, 311], keyTrk: [753, 311], velTrk: [844, 311],
  noiseName: [535, 339, 105, 14], noisePrev: [524, 338], noiseNext: [641, 338], bypass: [654, 340, 41, 22], mono: [696, 340, 41, 22],
  noiseLoop: [763, 339, 43, 14], noiseFlt: [831, 339, 35, 14],
} as const;
/** Generator corners on the morph page: [mix param, x, y, pan param, x, y, mute param, x, y, solo x, y, menu x, y]. */
export const MORPH_GENS: [number, number, number, number, number, number, number, number, number, number, number, number, number][] = [
  [87, 126, 159, 88, 126, 204, 89, 123, 233, 123, 252, 154, 116],
  [90, 419, 159, 91, 419, 204, 92, 414, 233, 414, 252, 305, 116],
  [93, 419, 306, 94, 419, 351, 95, 414, 381, 414, 400, 305, 402],
  [96, 126, 306, 97, 126, 351, 98, 123, 381, 123, 400, 154, 402],
];
/** The noise layer's small knobs: [param, x, y, caption]. */
export const NOISE_KNOBS: [number, number, number, string][] = [
  [34, 473, 365, 'MIX'], [35, 525, 365, 'PAN'], [39, 577, 365, 'RATIO'], [38, 629, 365, 'VEL'],
  [40, 708, 365, 'CUTOFF'], [41, 760, 365, 'RESO'], [42, 812, 365, 'FLT K-TRK'],
];
export const NOISE_LOOPS = ['Off', 'Forw', 'Backw', 'P-P'];
export const NOISE_FILTERS = ['Off', 'LP', 'BP', 'HP'];

// ------------------------------------------------------------- modulation page
export const MOD = {
  title: [320, 117, 365, 18], bend: [804, 119, 59, 18],
  rows: 6, rowY: 158, rowH: 23, num: [128, 26], src: [161, 118], amt: [297], dst: [316, 173], right: 375,
  envMenu: [121, 313, 84, 18], loop: [248, 314, 71, 18], relLoop: [337, 313, 85, 19], sync: [424, 313, 85, 19],
  bipolar: [511, 313, 56, 19], rate: [604, 313], keyTrk: [695, 313], velTrk: [786, 313], vel: [845, 313],
  env: [120, 334, 679, 82], ruler: [120, 418, 675, 11], egTabs: [805, 341, 61, 21],
} as const;
/** Envelope e's parameters: 99 + 6 e + k (release loop, tempo sync, rate, rate key track, rate velocity track, velocity). */
export const envParam = (e: number, k: number) => 99 + 6 * e + k;
export const MOD_SOURCES = ['---', 'Key Number', 'Velocity', 'Pitch Wheel', 'Chn. Aftertouch', 'Envelope 1', 'Envelope 2', 'Envelope 3', 'Envelope 4',
  ...Array.from({ length: 128 }, (_, i) => `CC ${i}`)];
export const MOD_TARGETS = ['---', 'Master Level', 'Master Pan', 'Master Pitch', 'Attack', 'Decay', 'Release', 'Sustain', 'Noise Mix', 'Noise Pan',
  'Noise Ratio', 'Noise FLT Cutoff', 'Noise FLT Resonance',
  ...['A', 'B', 'C', 'D'].flatMap((g) => [`Gen ${g}: Rate`, `Gen ${g}: PWM Rate`, `Gen ${g}: Detune Range`, `Gen ${g}: Pan Range`]),
  'Morphing Rate', 'Morphing X Offset', 'Morphing Y Offset',
  ...['A', 'B', 'C', 'D'].flatMap((g) => [`Gen ${g}: Mix`, `Gen ${g}: Pan`]),
  ...[1, 2, 3, 4].flatMap((e) => [`Eg${e}: Amplitude`, `Eg${e}: Rate`])];
