// Fruity Granulizer renders of FL 2026 (the test host, Fruity Granulizer_x64.dylib) pinned as fingerprints:
// FNV-1a of the float32 bits of the left and right output (tests/gen/granulizer-signals.ts `fingerprint`)
// for notes on the code-generated test signals, 44.1 kHz host unless `sr`, 512-sample blocks split at the notes
// and at the song ticks (130 BPM unless `bpm`), channel volume 100 % (raw), the interpolation points `points`
// of FPD_ProcessMode (none = linear) and, for the random scenarios, the clock FL's Randomize read (`epoch`,
// the host's --fixed-time). `state` holds the parameters FL's state blob carried (control units, `trigger` =
// KEY TO, `trans` = TRANSIENTS source). Every case is bit-exact with the engine.

export interface GranGolden {
  name: string;
  sig: 'ramp' | 'dc' | 'pulse' | 'sweep' | 'burst';
  rate?: number;
  state: Record<string, number>;
  notes: [number, number, number][];
  sr?: number;
  bpm?: number;
  points?: number;
  epoch?: number;
  /** Channel pan / pitch ramps (the host's --chan-ramp: key, from s, to s, a, b) and the host's control rate. */
  ramps?: [string, number, number, number, number][];
  ctl?: number;
  frames: number;
  hash: string;
}

export const GRAN_GOLDEN: GranGolden[] = [
  { name: 'default dc', sig: 'dc', state: {}, notes: [[60, 0, 1]], frames: 66150, hash: 'bab63fd5' },
  { name: 'default ramp', sig: 'ramp', state: {}, notes: [[60, 0, 1]], frames: 66150, hash: 'ed6b61ee' },
  { name: 'default pulse', sig: 'pulse', state: {}, notes: [[60, 0, 1.5]], frames: 88200, hash: '2c115d7f' },
  { name: 'wave 50', sig: 'ramp', state: { wave: 410 }, notes: [[60, 0, 1]], frames: 66150, hash: '8e027495' },
  { name: 'wave 200', sig: 'ramp', state: { wave: 750 }, notes: [[60, 0, 1]], frames: 66150, hash: 'e627e044' },
  { name: 'backwards', sig: 'ramp', state: { wave: -613, attack: 188, hold: 0 }, notes: [[60, 0, 1]], frames: 66150, hash: '1f981a6b' },
  { name: 'spacing 413', sig: 'ramp', state: { spacing: 413 }, notes: [[60, 0, 1]], frames: 66150, hash: '503e43ad' },
  { name: 'spacing 1000 att 100', sig: 'ramp', state: { spacing: 1000, attack: 100, hold: 30 }, notes: [[60, 0, 1]], frames: 66150, hash: '8e285647' },
  { name: 'stereo 26', sig: 'pulse', state: { stereo: 26, wave: 107 }, notes: [[60, 0, 1]], frames: 66150, hash: 'eb71ce77' },
  { name: 'stereo 64', sig: 'pulse', state: { stereo: 64 }, notes: [[60, 0, 1]], frames: 66150, hash: 'a21a3b07' },
  { name: 'depth 200 speed 100', sig: 'pulse', state: { depth: 200, speed: 100 }, notes: [[60, 0, 1.5]], frames: 88200, hash: 'f201b72e' },
  { name: 'random 128', sig: 'ramp', state: { random: 128 }, notes: [[60, 0, 1]], epoch: 1700000000, frames: 66150, hash: 'aa1f8db7' },
  { name: 'random 256', sig: 'ramp', state: { random: 256 }, notes: [[60, 0, 1]], epoch: 1700000001, frames: 66150, hash: 'ea86b2cb' },
  { name: 'loop', sig: 'pulse', state: { loop: 1 }, notes: [[60, 0, 4]], frames: 198450, hash: 'c24e98fd' },
  { name: 'hold button', sig: 'ramp', state: { holdSound: 1, start: 1000 }, notes: [[60, 0, 1]], frames: 66150, hash: '43b0cbf3' },
  { name: 'start 1000', sig: 'ramp', state: { start: 1000 }, notes: [[60, 0, 1]], frames: 66150, hash: 'a5d85be6' },
  { name: 'key 64 linear', sig: 'sweep', state: {}, notes: [[64, 0, 1]], frames: 66150, hash: '259eff75' },
  { name: 'key 48 linear', sig: 'sweep', state: {}, notes: [[48, 0, 1]], frames: 66150, hash: '3ee95c71' },
  { name: 'key 64 sinc 12', sig: 'sweep', state: {}, notes: [[64, 0, 1]], points: 12, frames: 66150, hash: '5d5fc311' },
  { name: 'key 72 sinc 12 stereo', sig: 'pulse', state: {}, notes: [[72, 0, 1]], points: 12, frames: 66150, hash: '70b4781b' },
  { name: 'key 64 sinc 32', sig: 'sweep', state: {}, notes: [[64, 0, 1]], points: 32, frames: 66150, hash: '81bf33e5' },
  { name: 'key 67 loop linear', sig: 'pulse', state: { loop: 1 }, notes: [[67, 0, 3]], frames: 154350, hash: '42d88649' },
  { name: 'key 40 loop linear', sig: 'pulse', state: { loop: 1 }, notes: [[40, 0, 4]], frames: 198450, hash: 'a8507d87' },
  { name: 'key 52 to the end', sig: 'sweep', state: {}, notes: [[52, 0, 7]], frames: 352800, hash: '7a1c95e5' },
  { name: 'host 48k', sig: 'pulse', state: {}, notes: [[60, 0, 1.5]], sr: 48000, frames: 96000, hash: '30b59385' },
  { name: 'host 48k random', sig: 'pulse', state: { random: 90 }, notes: [[60, 0, 1]], sr: 48000, epoch: 1700000011, frames: 72000, hash: 'f086315d' },
  { name: 'host 96k key 67', sig: 'sweep', state: {}, notes: [[67, 0, 1]], sr: 96000, frames: 144000, hash: '8716c875' },
  { name: 'sample 22k', sig: 'pulse', rate: 22050, state: {}, notes: [[60, 0, 1]], frames: 66150, hash: '17b661d2' },
  { name: 'percent keys', sig: 'ramp', state: { trigger: 1, start: 1000 }, notes: [[60, 0, 0.3], [64, 0.4, 0.3], [71, 0.8, 0.3], [84, 1.2, 0.3], [90, 1.6, 0.3]], frames: 105840, hash: 'e90f5700' },
  { name: 'step bpm 100', sig: 'ramp', state: { trigger: 2 }, notes: [[62, 0, 0.5], [68, 0.6, 0.5]], bpm: 100, frames: 70560, hash: '8a664443' },
  { name: 'step bpm 200', sig: 'ramp', state: { trigger: 2, start: 500 }, notes: [[65, 0, 0.5], [75, 0.6, 0.5]], bpm: 200, frames: 70560, hash: 'dc4be962' },
  { name: 'detect keys', sig: 'burst', state: { trigger: 3, trans: 2 }, notes: [[60, 0, 0.01], [61, 0.03, 0.01], [62, 0.06, 0.01], [63, 0.09, 0.01], [64, 0.12, 0.01], [65, 0.15, 0.01], [66, 0.18, 0.01], [67, 0.21, 0.01], [68, 0.24, 0.01], [69, 0.27, 0.01], [70, 0.3, 0.01], [71, 0.33, 0.01], [72, 0.36, 0.01], [73, 0.39, 0.01], [74, 0.42, 0.01], [75, 0.45, 0.01], [76, 0.48, 0.01], [77, 0.51, 0.01], [78, 0.54, 0.01], [79, 0.57, 0.01], [80, 0.6, 0.01], [81, 0.63, 0.01], [82, 0.66, 0.01], [83, 0.69, 0.01]], frames: 35280, hash: '0c4a5dce' },
  { name: 'detect pitch', sig: 'burst', state: { trans: 2 }, notes: [[60, 0, 3]], frames: 154350, hash: '959725fc' },
  { name: 'detect hold 300 att 100', sig: 'burst', state: { trans: 2, transHold: 300, attack: 100, hold: 20 }, notes: [[60, 0, 3]], frames: 154350, hash: '08db4900' },
  { name: 'detect key 64', sig: 'burst', state: { trans: 2 }, notes: [[64, 0, 2]], frames: 110250, hash: '7aa5dee0' },
  { name: 'detect wave 50', sig: 'burst', state: { trans: 2, wave: 410 }, notes: [[60, 0, 3]], frames: 154350, hash: '9b80b0a3' },
  { name: 'detect backwards', sig: 'burst', state: { trans: 2, wave: -613 }, notes: [[60, 0, 2]], frames: 110250, hash: 'a30d2d7c' },
  { name: 'detect loop', sig: 'burst', state: { trans: 2, loop: 1 }, notes: [[60, 0, 6]], frames: 286650, hash: '40fc2e27' },
  { name: 'detect random', sig: 'burst', state: { trans: 2, random: 100 }, notes: [[60, 0, 2]], epoch: 1700000005, frames: 110250, hash: '34c2fe9b' },
  { name: 'key 84 sinc 12 host 48k', sig: 'sweep', state: {}, notes: [[84, 0, 1]], sr: 48000, points: 12, frames: 72000, hash: 'be54bff5' },
  { name: 'key 90 sinc 12', sig: 'sweep', state: {}, notes: [[90, 0, 1]], points: 12, frames: 66150, hash: '4f947c2d' },
  { name: 'key 90 sinc 32 host 48k', sig: 'pulse', state: {}, notes: [[90, 0, 1]], sr: 48000, points: 32, frames: 72000, hash: '4dea185c' },
  { name: 'sample 48k sinc 12', sig: 'sweep', rate: 48000, state: {}, notes: [[60, 0, 1]], points: 12, frames: 66150, hash: '845d69e5' },
  { name: 'sample 48k key 72 sinc 32', sig: 'pulse', rate: 48000, state: {}, notes: [[72, 0, 1]], points: 32, frames: 66150, hash: '2fe024eb' },
  { name: 'sample 22k key 71 sinc 32', sig: 'sweep', rate: 22050, state: {}, notes: [[71, 0, 1]], points: 32, frames: 66150, hash: '7d10d0ad' },
  { name: 'key 18 linear', sig: 'sweep', state: {}, notes: [[18, 0, 2]], frames: 110250, hash: 'ed2087f1' },
  { name: 'key 36 sinc 12 loop', sig: 'sweep', state: { loop: 1 }, notes: [[36, 0, 3]], points: 12, frames: 154350, hash: 'a11ed0e1' },
  { name: 'key 64 hermite', sig: 'sweep', state: {}, notes: [[64, 0, 1]], points: 3, frames: 66150, hash: '7d914be5' },
  { name: 'key 40 hermite loop', sig: 'pulse', state: { loop: 1 }, notes: [[40, 0, 4]], points: 3, frames: 198450, hash: '29b82d5a' },
  { name: 'sample 22k hermite host 48k', sig: 'pulse', rate: 22050, state: {}, notes: [[67, 0, 1]], sr: 48000, points: 3, frames: 72000, hash: '99673dbb' },
  { name: 'key 52 hermite to the end', sig: 'sweep', state: {}, notes: [[52, 0, 7]], points: 3, frames: 352800, hash: '12f4957d' },
  { name: 'hermite random detect', sig: 'burst', state: { trans: 2, random: 100 }, notes: [[60, 0, 2], [71, 0.5, 1]], points: 3, epoch: 1700000077, frames: 110250, hash: '38c5bff2' },
  { name: 'pitch ramp up', sig: 'sweep', state: {}, notes: [[60, 0, 1.4]], ramps: [['pitch', 0.1, 1.1, 0, 700]], frames: 79380, hash: 'e9501479' },
  { name: 'pitch ramp down sinc 12', sig: 'sweep', state: {}, notes: [[64, 0, 1.4]], points: 12, ramps: [['pitch', 0.2, 1, 0, -1500]], frames: 79380, hash: 'e2a3da39' },
  { name: 'pan ramp with stereo 30', sig: 'pulse', state: { stereo: 30 }, notes: [[60, 0, 1.4]], ramps: [['pan', 0.2, 1, -1, 1]], frames: 79380, hash: '1cf5fac0' },
  { name: 'pan and pitch ramps, two notes', sig: 'ramp', state: {}, notes: [[60, 0, 1.2], [67, 0.3, 0.9]], ramps: [['pan', 0, 1.2, 0.8, -0.8], ['pitch', 0.1, 0.9, 200, -200]], frames: 70560, hash: '27b9b7da' },
  { name: 'pitch ramp with RAND', sig: 'burst', state: { random: 90 }, notes: [[60, 0, 1.5], [55, 0.4, 0.8]], epoch: 1700000042, ramps: [['pitch', 0.1, 1.2, 0, 1200]], frames: 83790, hash: 'eec15d51' },
  { name: 'pitch ramp at control rate 16', sig: 'sweep', state: {}, notes: [[60, 0, 1]], ramps: [['pitch', 0.1, 0.9, 0, 400]], ctl: 16, frames: 61740, hash: '636bc2fd' },
];

/**
 * The factory presets as FL loads them (`flfxhost render ... --preset NAME`), fingerprints of the render of the notes
 * [60, 0 s, 1.2 s], [64, 0.5, 0.8], [72, 1.0, 0.5], [63, 1.3, 0.4] on the burst and pulse signals (2.3 s, the host's clock
 * 1700000123 for the random preset), linear interpolation.
 */
export const GRAN_PRESET_NOTES: [number, number, number][] = [[60, 0, 1.2], [64, 0.5, 0.8], [72, 1.0, 0.5], [63, 1.3, 0.4]];
export const GRAN_PRESET_EPOCH = 1700000123;
export const GRAN_PRESET_GOLDEN: Record<string, { burst: string; pulse: string }> = {
  'Backwards': { burst: '632b1afa', pulse: '69218a1d' },
  'Default': { burst: 'cfff279b', pulse: '9b80d813' },
  'Drumloops': { burst: '06408586', pulse: '149a79d7' },
  'Rearranging drumloops': { burst: '9a114a16', pulse: '1bbf82cb' },
  'Stutter': { burst: '8022e224', pulse: '71fa5dc5' },
  'Time stretch - twice faster': { burst: '9fc1279b', pulse: '0c8eca8c' },
  'Time stretch - twice slower': { burst: '9c5e15ec', pulse: '2d04e760' },
  'Weird language': { burst: 'c2d8306c', pulse: '9201f12a' },
};
