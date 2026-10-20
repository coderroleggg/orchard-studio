// The effect presets of Ogun's options menu (FL: Unison / Chorus / Reverb submenus). FL's handlers copy a row of the
// plugin's tables into the plugin's parameter block (UPres1MenuClick 0x75970 -> 0x65980 copies 20 bytes to plug+0x16c,
// CPres1MenuClick 0x759b0 -> 0x65a10 copies 24 bytes to plug+0x188, RPres1MenuClick 0x762c0 -> 0x65aa0 copies 36 bytes to
// plug+0x1b8; the tables are at 0x370b50 / 0x370bdc / 0x370cf4): the unison preset sets parameters 12..16, the chorus preset
// parameters 19..24 (not the mix), the reverb preset 31..39 and switches the reverb on (tag != 6) with tempo-based
// predelay off. The menu item's Tag selects the row.

/** [caption, tag, values] of the unison presets: order, panning, volume, pitch, phase (parameters 12..16). */
export const UNISON_PRESETS: [string, number[]][] = [
  ['Default', [4, 128, 100, 128, 16]],
  ['Detuned', [6, 128, 128, 220, 0]],
  ['Flanged', [4, 100, 128, 50, 0]],
  ['Stereo presence', [2, 128, 128, 0, 128]],
  ['Stereoized', [2, 128, 128, 80, 10]],
  ['Fat', [9, 100, 128, 180, 0]],
  ['None', [1, 128, 100, 128, 16]],
];
export const UNISON_KEYS = ['uniOrd', 'uniPan', 'uniVol', 'uniPit', 'uniPhs'];

/** Chorus presets: order, depth, speed, delay, spread, cross (parameters 19..24). FL's table has a 7th value (mix) it never copies. */
export const CHORUS_PRESETS: [string, number[]][] = [
  ['Default', [4, 512, 768, 8, 128, -32]],
  ['Deep chorus', [7, 600, 320, 110, 128, 84]],
  ['Fast flanger', [6, 228, 848, 0, 0, -50]],
  ['Flanger', [6, 636, 836, 0, 0, 50]],
  ['Alt flanger', [1, 130, 300, 0, 0, 128]],
  ['Modulation', [1, 0, 800, 0, 0, 0]],
  ['Stereoized', [2, 128, 640, 0, 0, 0]],
  ['Surround flanger', [9, 84, 204, 0, 0, -55]],
  ['Vibration', [6, 24, 1024, 0, 0, 0]],
  ['None', [0, 512, 768, 8, 128, -32]],
];
export const CHORUS_KEYS = ['choOrd', 'choDep', 'choSpd', 'choDel', 'choSpr', 'choCrs'];

/** Reverb presets: low cut, high cut, predelay, room size, diffusion, decay, high damping, color, wet (parameters 31..39). */
export const REVERB_PRESETS: [string, number[]][] = [
  ['Default', [75, 40, 0, 40, 100, 15, 40, 2, 25]],
  ['Drum room', [100, 36, 0, 35, 100, 6, 36, 2, 42]],
  ['The venue', [400, 60, 31, 60, 65, 23, 37, 1, 32]],
  ['Cathedral', [34, 21, 27, 90, 100, 45, 31, 3, 50]],
  ['Large hall', [0, 115, 18, 40, 100, 22, 50, 2, 50]],
  ['Small studio', [100, 60, 0, 17, 100, 5, 30, 2, 42]],
  ['None', [75, 40, 0, 40, 100, 15, 40, 2, 25]],
];
export const REVERB_KEYS = ['revLow', 'revHigh', 'revPre', 'revRoom', 'revDiff', 'revDec', 'revDamp', 'revCol', 'revWet'];
