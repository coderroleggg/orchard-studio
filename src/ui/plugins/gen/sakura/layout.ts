// Sakura editor layout: FL's form (TWPControlForm SynthPanel, 855 x 532) at the form's Left / Top /
// Width / Height. Controls are keyed by the form's Tag = the FL parameter index (0..77, SK_PARAM_KEYS);
// the editor-only settings (tags 79..113 in the form, which overlap FL's MIDI CC parameter numbers)
// are addressed by their index into the state's `hidden` array (model data.ts, SK_H_*).
// Captions are the texts FL's editor code paints (manual: Touch / Vibration / String interaction /
// Resonance / Acoustics, the modulation matrix, Delay / Chorus / Reverb).

import {
  SK_H_AMOUNT, SK_H_DEST, SK_H_PHASE, SK_H_SOURCE, SK_H_DELAY_SYNC, SK_H_S2_RATIO, SK_H_TRANSPOSE, skOctaves, skSlotIndex,
} from '../../../../model/gen/plugins/sakura/data';

export const W = 855;
export const H = 532;

/** Looks of FL's TVectorWheel in Sakura's skin: chrome knobs, dark knobs with a gold cap, the modulation strip's arc knobs. */
export type KnobSkin = 'chrome' | 'dark' | 'darkPink' | 'strip';

export interface KnobSpec { tag: number; x: number; y: number; w: number; h?: number; skin: KnobSkin }

const knob = (tag: number, x: number, y: number, w: number, skin: KnobSkin, h?: number): KnobSpec => ({ tag, x, y, w, skin, h });

/** TVectorWheel controls bound to FL parameters (Tag, Left, Top, Width, Height from the form). */
export const KNOBS: KnobSpec[] = [
  // top bar
  knob(0, 695, 16, 36, 'chrome'), // MasterLevellKnob (no Tag: parameter 0)
  knob(1, 634, 23, 28, 'chrome', 26), // MasterFineTuneKnob
  // Touch: exciter noise rate, hi-cut, lo-cut
  knob(32, 19, 300, 26, 'chrome'), // NoiseCutKnob
  knob(29, 86, 106, 45, 'dark'), // FilterAmountKnob (Hi-Cut cutoff)
  knob(26, 146, 106, 45, 'dark'), // FilterAttackKnob
  knob(30, 86, 166, 45, 'dark'), // FilterResonanceKnob
  knob(27, 146, 166, 45, 'dark'), // FilterDecayKnob
  knob(33, 86, 226, 45, 'dark'), // ImpulseOverdriveKnob (Hi-Cut drive)
  knob(28, 146, 226, 45, 'dark'), // FilterSustainKnob
  knob(24, 86, 286, 45, 'dark'), // LoCutFreqKnob
  knob(25, 146, 286, 45, 'dark'), // LoCutResonanceKnob
  // Vibration: string decay, damping, comb filter
  knob(6, 224, 109, 38, 'chrome'), // String1DecayKnob
  knob(11, 224, 289, 38, 'chrome'), // String2DecayKnob
  knob(9, 284, 109, 38, 'chrome'), // String1DampAmountKnob
  knob(10, 349, 119, 28, 'chrome'), // String1DampSharpnessKnob
  knob(8, 438, 110, 28, 'chrome'), // String1UnstabilityKnob (damp offset)
  knob(14, 284, 289, 38, 'chrome'), // String2DampAmountKnob
  knob(15, 349, 288, 28, 'chrome'), // String2DampSharpnessKnob
  knob(13, 438, 295, 28, 'chrome'), // String2UnstabilityKnob
  knob(22, 494, 109, 38, 'chrome'), // CombFilterAmountKnob (comb level)
  knob(20, 494, 289, 38, 'chrome'), // CombFilterResonanceKnob (comb feedback)
  // String interaction and amp envelope
  knob(17, 566, 106, 45, 'dark'), // StringBalanceKnob (String mix)
  knob(16, 566, 286, 45, 'dark'), // StringSaturationKnob
  knob(2, 626, 106, 45, 'dark'), // MasterAttackKnob
  knob(3, 626, 166, 45, 'dark'), // MasterDecayKnob
  knob(4, 626, 226, 45, 'dark'), // MasterSustainKnob
  knob(5, 626, 286, 45, 'dark'), // MasterReleaseKnob
  // Resonator feedback (ResonatorFdbk1..8Knob)
  ...[110, 138, 166, 194, 224, 250, 278, 306].map((y, k) => knob(47 + k, 703, y, 20, 'chrome')),
  // Modulation strip: free envelope and LFO
  knob(34, 16, 388, 33, 'strip'), // FreeEgAttackKnob
  knob(35, 56, 388, 33, 'strip'),
  knob(36, 96, 388, 33, 'strip'),
  knob(37, 136, 388, 33, 'strip'),
  knob(38, 189, 388, 33, 'strip'), // LFORateKnob
  // Acoustics: delay, chorus, reverb
  knob(64, 25, 464, 47, 'darkPink'), // DelayTimeKnob
  knob(65, 144, 464, 47, 'darkPink'), // DelayFdbkKnob
  knob(66, 204, 464, 47, 'darkPink'), // DelaySpeedKnob
  knob(67, 264, 464, 47, 'darkPink'), // DelayDepthKnob
  knob(68, 324, 464, 47, 'darkPink'), // DelayBlurKnob
  knob(69, 384, 464, 47, 'darkPink'), // DelayWetKnob
  knob(72, 464, 464, 47, 'darkPink'), // ChorusDelayKnob (Chorus depth)
  knob(71, 524, 464, 47, 'darkPink'), // ChorusRateKnob
  knob(73, 585, 464, 47, 'darkPink'), // ChorusWetKnob
  knob(76, 663, 464, 47, 'darkPink'), // ReverbDecayKnob
  knob(77, 724, 464, 47, 'darkPink'), // ReverbColorKnob
  knob(75, 785, 464, 47, 'darkPink'), // ReverbMixKnob
];

/** The transpose wheel (form tag 113, a hidden setting): Min -3, Max 3. */
export const TRANSPOSE = { x: 574, y: 23, w: 28, h: 26 };

/**
 * The stored transpose value (a float 0..1 whose octave shift is trunc(v * 6) - 3, default 0.5) for a wheel
 * position of -3..3 octaves: the middle of the octave's range, so no float rounding can change the shift
 * (the default 0.5 for 0, 1 for +3).
 */
export const octaveStored = (c: number): number => (c === 0 ? 0.5 : c >= 3 ? 1 : (c + 3.5) / 6);
/** The wheel position (-3..3) of a stored transpose value. */
export const storedOctave = (v: number): number => skOctaves(v);

export type SliderKind = 'slot' | 'res' | 'comb';

export interface SliderSpec { tag: number; x: number; y: number; w: number; h: number; kind: SliderKind }

const RES_FREQ_Y = [110, 138, 166, 194, 222, 250, 278, 306];
/** TVectorSlider controls (vertical 27 x 88 / 27 x 86 slots, horizontal 87 x 20 and 106 x 20). */
export const SLIDERS: SliderSpec[] = [
  { tag: 31, x: 18, y: 173, w: 27, h: 88, kind: 'slot' }, // ImpulseClickSlider (Exciter noise level)
  { tag: 18, x: 575, y: 177, w: 27, h: 86, kind: 'slot' }, // StringStereoSlider
  { tag: 19, x: 369, y: 209, w: 106, h: 20, kind: 'comb' }, // CombFilterRatioSlider
  ...RES_FREQ_Y.map((y, k): SliderSpec => ({ tag: 39 + k, x: 739, y, w: 87, h: 20, kind: 'res' })), // ResonatorFreq1..8Slider
];

export interface ToggleSpec { tag: number; x: number; y: number; w: number; h: number; kind: 'led' | 'power' | 'lever' }

/** TVectorCheckBox (18 x 18) and TSwitchSelector (30 x 15) controls bound to on / off or + / - parameters. */
export const TOGGLES: ToggleSpec[] = [
  ...[111, 139, 167, 195, 223, 251, 279, 307].map((y, k): ToggleSpec => ({ tag: 55 + k, x: 830, y, w: 18, h: 18, kind: 'led' })), // ResonatorOn1..8CheckBox
  { tag: 63, x: 427, y: 508, w: 18, h: 18, kind: 'power' }, // DelayOnCheckBox
  { tag: 70, x: 627, y: 508, w: 18, h: 18, kind: 'power' }, // ChorusOnCheckBox
  { tag: 74, x: 827, y: 508, w: 18, h: 18, kind: 'power' }, // ReverbOnCheckBox
  { tag: 7, x: 228, y: 167, w: 30, h: 15, kind: 'lever' }, // String1DecaySwitch
  { tag: 12, x: 228, y: 250, w: 30, h: 15, kind: 'lever' }, // String2DecayInvSwitch
  { tag: 23, x: 494, y: 167, w: 30, h: 15, kind: 'lever' }, // CombFilterMixInvSwitch (Comb level inverted)
  { tag: 21, x: 494, y: 250, w: 30, h: 15, kind: 'lever' }, // CombFilterFdbkInvSwitch
];

/** Eight modulation matrix slots (form: ModAmountNKnob, ModAmountNegNSwitch, ModSourceNCombo, ModDestNCombo). */
export const SLOTS = [0, 1, 2, 3, 4, 5, 6, 7].map((s) => ({
  slot: s,
  knobX: [238, 314, 388, 464, 539, 613, 688, 764][s],
  negX: [276, 353, 426, 501, 575, 652, 725, 801][s],
  comboX: [239, 314, 389, 464, 539, 614, 689, 765][s],
  source: skSlotIndex(s, SK_H_SOURCE),
  amount: skSlotIndex(s, SK_H_AMOUNT),
  phase: skSlotIndex(s, SK_H_PHASE),
  dest: skSlotIndex(s, SK_H_DEST),
}));
export const SLOT_KNOB = { y: 388, w: 33 };
export const SLOT_NEG = { y: 397, w: 22, h: 14 };
export const SLOT_COMBO = { srcY: 372, dstY: 426, w: 70, h: 12 };

/** TVectorDigiWheel 33 x 17: String 2 frequency ratio (tag 111) and Delay time sync (tag 112). */
export const DIGI_S2 = { x: 226, y: 215, w: 33, h: 17, index: SK_H_S2_RATIO };
export const DIGI_SYNC = { x: 89, y: 485, w: 33, h: 17, index: SK_H_DELAY_SYNC };
export const HIDDEN_TRANSPOSE = SK_H_TRANSPOSE;

/** Painted areas of the form. */
export const HINT_BOX = { x: 274, y: 17, w: 207, h: 36 }; // HintLabel
export const METER_BOX = { x: 767, y: 17, w: 69, h: 37 }; // LevelVisual (TWAVVolumeter)
export const STRING_BOX = { x: 280, y: 168, w: 202, h: 99 }; // DampingPaintBox
export const MENU_BTN = { x: 504, y: 27, w: 18, h: 18 }; // MenuBtn "Options"

export type CapTone = 'dark' | 'light' | 'pink' | 'strip' | 'plate';

export interface Caption { x: number; y: number; t: string; tone: CapTone; title?: boolean }

const cap = (x: number, y: number, t: string, tone: CapTone, title = false): Caption => ({ x, y, t, tone, title });

/** Captions (centred at x, baseline y). */
export const CAPTIONS: Caption[] = [
  // top bar
  cap(588, 63, 'TRANSPOSE', 'pink'), cap(648, 63, 'TUNE', 'pink'), cap(713, 63, 'VOLUME', 'pink'), cap(513, 63, 'OPTIONS', 'pink'), cap(801.5, 63, 'LEVEL', 'pink'),
  // section titles
  cap(31, 88, 'EXCITER', 'dark', true), cap(138, 88, 'HI-CUT', 'dark', true), cap(378, 90, 'STRING 1', 'dark', true),
  cap(588, 88, 'MIX', 'dark', true), cap(648, 88, 'ENVELOPE', 'dark', true), cap(784, 88, 'RESONATOR', 'dark', true),
  cap(138, 353, 'LO-CUT', 'dark', true), cap(378, 353, 'STRING 2', 'dark', true),
  // Touch
  // the slider balances click and noise (the manual: click at the top; the engine's exciter is click x v + noise x (1 - v)^2,
  // so 256 at the top is the click end, as in FL's thumbnail for the click-excited "Bowed 6" insertion preset)
  cap(31, 168, 'CLICK', 'light'), cap(31, 273, 'NOISE', 'light'), cap(32, 341, 'NOISE RATE', 'dark'),
  cap(108.5, 160, 'CUTOFF', 'dark'), cap(168.5, 160, 'A', 'dark'),
  cap(108.5, 220, 'RESO', 'dark'), cap(168.5, 220, 'D', 'dark'),
  cap(108.5, 280, 'OVERDRIVE', 'dark'), cap(168.5, 280, 'S', 'dark'),
  cap(108.5, 340, 'CUTOFF', 'dark'), cap(168.5, 340, 'RESO', 'dark'),
  // Vibration
  cap(243, 158, 'DECAY', 'light'), cap(243, 285, 'DECAY', 'light'), cap(243, 211, 'S2 RATIO', 'light'),
  cap(513, 158, 'LEVEL', 'light'), cap(513, 285, 'FEEDBACK', 'light'), cap(513, 213, 'COMB', 'light'), cap(513, 222, 'FILTER', 'light'),
  cap(378, 108, 'DAMPING', 'dark'), cap(378, 331, 'DAMPING', 'dark'),
  cap(303, 158, 'AMOUNT', 'dark'), cap(363, 158, 'SHARPNESS', 'dark'), cap(452, 158, 'OFFSET', 'dark'),
  cap(303, 285, 'AMOUNT', 'dark'), cap(363, 284, 'SHARPNESS', 'dark'), cap(452, 291, 'OFFSET', 'dark'),
  cap(422, 240, 'COMB RATIO', 'plate'),
  // String interaction and envelope
  cap(588, 159, 'STRING MIX', 'dark'), cap(588, 172, 'STEREO SPREAD', 'dark'), cap(588, 340, 'SATURATION', 'dark'),
  cap(648, 160, 'A', 'dark'), cap(648, 220, 'D', 'dark'), cap(648, 280, 'S', 'dark'), cap(648, 340, 'R', 'dark'),
  // Resonator
  cap(714, 335, 'FDBK', 'light'), cap(782, 336, 'FREQUENCY', 'dark'), cap(839, 336, 'ON', 'dark'),
  // modulation strip
  cap(92.5, 378, 'FREE ENVELOPE', 'strip', true),
  cap(32.5, 430, 'A', 'strip'), cap(72.5, 430, 'D', 'strip'), cap(112.5, 430, 'S', 'strip'), cap(152.5, 430, 'R', 'strip'),
  cap(205.5, 378, 'LFO', 'strip', true), cap(205.5, 430, 'RATE', 'strip'),
  // acoustics
  cap(230, 461, 'DELAY', 'pink', true), cap(548, 461, 'CHORUS', 'pink', true), cap(747, 461, 'REVERB', 'pink', true),
  cap(48.5, 521, 'TIME', 'pink'), cap(105.5, 483.5, 'SYNC', 'pink'), cap(167.5, 521, 'FEEDBACK', 'pink'), cap(227.5, 521, 'MOD SPEED', 'pink'),
  cap(287.5, 521, 'MOD DEPTH', 'pink'), cap(347.5, 521, 'BLUR', 'pink'), cap(407.5, 521, 'MIX', 'pink'),
  cap(487.5, 521, 'DEPTH', 'pink'), cap(547.5, 521, 'SPEED', 'pink'), cap(608.5, 521, 'MIX', 'pink'),
  cap(686.5, 521, 'DECAY', 'pink'), cap(747.5, 521, 'COLOR', 'pink'), cap(808.5, 521, 'MIX', 'pink'),
];

/** Hint names of the editor-only controls (FL's form hints). */
export const HINT = {
  amount: (s: number) => `Modulation amount ${s + 1}`,
  negative: 'Negative amount',
  source: (s: number) => `Modulation source ${s + 1}`,
  dest: (s: number) => `Modulation destination ${s + 1}`,
  s2Ratio: 'String 2 frequency ratio',
  delaySync: 'Delay time sync',
  transpose: 'Transpose',
};

/** Form default values of the editor-only controls (the wheels' DefaultValue: reset with Alt or middle click). */
export const FORM_DEFAULT = { amount: 128, phase: 0, source: 0, dest: 0, s2Ratio: 0, delaySync: 0, transpose: 0 };
