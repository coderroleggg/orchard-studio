// Vintage Phaser (FL: Vintage Phaser, an Electro-Harmonix Small Stone model by
// Daniel Schaack, OTA filter DSP by Dario Sanfilippo). Form: 747 x 277 (with
// the advanced section). Parameters, ranges and texts from FL's binary
// (flfxhost info/sweep); the DSP was measured from FL's renders, see
// docs/research/fx/vphaser.md. Defaults are FL's "Default" preset (= the
// constructor state).

import type { FxPluginDef } from '../types';

const pos = (v: number, min: number, max: number) => Math.max(0, Math.min(1, (v - min) / (max - min)));
const F = Math.fround;
/** Control position computed in single precision like FL's texts. */
const posF = (v: number, min: number, max: number) => F(F(Math.max(min, Math.min(max, v)) - min) / (max - min));

/** Phaser frequency (Hz) of the Min / Max / Manual controls (125..2048000): 1.25 Hz x 16384^x. */
export function vphaserFreq(v: number): number {
  return 1.25 * Math.pow(16384, pos(v, 125, 2048000));
}

/** Rate frequency 1 / 2 controls (25..150000): 0.025 + 149.975 x^4 Hz. */
export function vphaserRateFreq(v: number): number {
  const x = pos(v, 25, 150000);
  return 0.025 + 149.975 * x * x * x * x;
}

/** LFO speed (Hz): exponential between the two rate frequencies. */
export function vphaserSpeedHz(v: number, rate1 = 25, rate2 = 150000): number {
  const r1 = vphaserRateFreq(rate1), r2 = vphaserRateFreq(rate2);
  return r1 * Math.pow(r2 / r1, pos(v, 1, 245760));
}

/** Tempo-synced LFO period in ticks (48 per step), as in Vintage Chorus. */
export function vphaserSyncTicks(v: number): number {
  const g = Math.pow(128, 1 - pos(v, 1, 245760)) - 1;
  return Math.max(1, Math.floor((6143 / 127) * g + 1.1));
}

const stepsTicks = (ticks: number) => `${Math.floor(ticks / 48)}:${ticks % 48}`;

/** FL's text for a tempo-synced Speed. */
export const vphaserSyncText = (v: number) => stepsTicks(vphaserSyncTicks(v));

/** Delay time in ms (1..768 -> 0..1000 ms). */
export const vphaserDelayMs = (v: number) => ((Math.max(1, Math.min(768, v)) - 1) / 767) * 1000;

/** Tempo-synced delay time: the control value is the number of ticks (48 per step). */
export const vphaserDelaySyncText = (v: number) => stepsTicks(Math.round(Math.max(1, Math.min(768, v))));

/** Delay feedback filters: low pass 320 Hz x 64^x, high pass 20 Hz x 1024^x. */
export const vphaserDelayLpHz = (v: number) => 320 * Math.pow(64, pos(v, 3200, 204800));
export const vphaserDelayHpHz = (v: number) => 20 * Math.pow(1024, pos(v, 2000, 204800));

/** Input / feedback high-pass (2000..80000): 5 + 195 x^3 Hz. */
export function vphaserHpHz(v: number): number {
  const x = pos(v, 2000, 80000);
  return 5 + 195 * x * x * x;
}

/** Colour low shelf frequency (5000..650000): 50 + 600 x Hz. */
export const vphaserColorHz = (v: number) => 50 + 600 * pos(v, 5000, 650000);

/** Noise level (linear) for the Noise control: -90..-40 dB, off at 0. */
export function vphaserNoise(v: number): number {
  if (v <= 0) return 0;
  return Math.pow(10, (-90 + (50 * Math.min(6000, v)) / 6000) / 20);
}

const onOff = ['Off', 'On'];
// FL rounds decimal halves up ("5.0%" for 4.95)
const pct1 = (scale: number) => (v: number) => `${((v * scale) / 6000 + 1e-9).toFixed(1)}%`;
const deg = (v: number) => `${((v / 6000) * 360).toFixed(2)}°`;
// texts computed in single precision like FL
const freqText = (v: number) => `${F(1.25 * F(Math.pow(2, F(14 * posF(v, 125, 2048000))))).toFixed(2)} Hz`;
const F0025 = F(0.025), F149975 = F(149.975);
const rateText = (v: number) => { const x = posF(v, 25, 150000), x2 = F(x * x); return `${F(F0025 + F(F149975 * F(x2 * x2))).toFixed(3)} Hz`; };
const hpText = (v: number) => { const x = posF(v, 2000, 80000); return `${F(5 + F(195 * F(F(x * x) * x))).toFixed(2)} Hz`; };
const lpDelayText = (v: number) => `${F(320 * F(Math.pow(2, F(6 * posF(v, 3200, 204800))))).toFixed(1)} Hz`;
const hpDelayText = (v: number) => `${F(20 * F(Math.pow(2, F(10 * posF(v, 2000, 204800))))).toFixed(1)} Hz`;
const speedText = (v: number) => `${F(F0025 * F(Math.pow(6000, posF(v, 1, 245760)))).toFixed(3)} Hz`;
/** Speed text for a state: synced steps:ticks, or Hz over the advanced rate range (FL's exact text at the default range). */
function speedTextFor(v: number, st?: Record<string, unknown>): string {
  if (Number(st?.sync) >= 0.5) return vphaserSyncText(v);
  const r1 = Number(st?.rate1 ?? 25), r2 = Number(st?.rate2 ?? 150000);
  return r1 === 25 && r2 === 150000 ? speedText(v) : `${vphaserSpeedHz(v, r1, r2).toFixed(3)} Hz`;
}
const hz2 = (f: (v: number) => number) => (v: number) => `${f(v).toFixed(2)} Hz`;
const freqParse = (hz: number) => 125 + (2048000 - 125) * (Math.log(Math.max(1.25, Math.min(20480, hz)) / 1.25) / Math.log(16384));

function stereoText(v: number): string {
  if (Math.abs(v - 3000) < 1e-9) return 'center';
  return v < 3000 ? `${((3000 - v) / 30).toFixed(1)} left` : `${((v - 3000) / 30).toFixed(1)} right`;
}

export const def: FxPluginDef = {
  id: 'vphaser',
  name: 'Vintage Phaser',
  category: 'Flanger',
  width: 747,
  height: 277,
  description: 'Small Stone style 4-stage OTA phaser with LFO shaping, delay and noise',
  // the gear's advanced strip (shown, as in FL's form); a view setting kept across presets
  state: () => ({ advanced: true }),
  viewState: ['advanced'],
  params: [
    { key: 'minFreq', name: 'Min Frequency', index: 0, min: 125, max: 2048000, def: 896070, format: freqText, parse: freqParse },
    { key: 'maxFreq', name: 'Max Frequency', index: 1, min: 125, max: 2048000, def: 1588996, format: freqText, parse: freqParse },
    { key: 'feedback', name: 'Feedback', index: 2, min: 0, max: 6000, def: 3000, format: pct1(99), parse: (pc) => (pc / 99) * 6000 },
    { key: 'manual', name: 'Manual frequency', index: 3, min: 0, max: 1, def: 0, options: onOff },
    { key: 'manualFreq', name: 'Manual Frequency', index: 4, min: 125, max: 2048000, def: 125, format: freqText, parse: freqParse },
    { key: 'hq', name: 'High quality', index: 5, min: 0, max: 1, def: 0, options: onOff },
    { key: 'speed', name: 'Speed', index: 6, min: 1, max: 245760, def: 1, format: speedTextFor, parse: (hz) => 1 + 245759 * (Math.log(Math.max(0.025, Math.min(150, hz)) / 0.025) / Math.log(6000)) },
    { key: 'sync', name: 'Tempo sync', index: 7, min: 0, max: 1, def: 0, options: onOff },
    { key: 'lfoType', name: 'LFO type', index: 8, min: 0, max: 1, def: 0, options: ['Triangle', 'Sine'] },
    { key: 'tension', name: 'Tension', index: 9, min: 0, max: 6000, def: 0, format: pct1(99), parse: (pc) => (pc / 99) * 6000 },
    { key: 'startPhase', name: 'Start phase', index: 10, min: 0, max: 6000, def: 0, format: deg, parse: (d) => (d / 360) * 6000 },
    { key: 'lrPhase', name: 'LR Phase', index: 11, min: 0, max: 6000, def: 0, format: deg, parse: (d) => (d / 360) * 6000 },
    { key: 'delayOn', name: 'Delay active', index: 12, min: 0, max: 1, def: 0, options: onOff },
    { key: 'keepPitch', name: 'Delay keep pitch', index: 13, min: 0, max: 1, def: 0, options: onOff },
    { key: 'delayMix', name: 'Delay mix', index: 14, min: 0, max: 6000, def: 0, format: pct1(100), parse: (pc) => (pc / 100) * 6000 },
    { key: 'delayStereo', name: 'Delay Stereo', index: 15, min: 0, max: 6000, def: 3000, format: stereoText, bipolar: true, parse: (pc) => 3000 + pc * 30 },
    { key: 'delayTime', name: 'Delay Time', index: 16, min: 1, max: 768, def: 1,
      format: (v, st) => (Number(st?.delaySync) >= 0.5 ? vphaserDelaySyncText(v) : `${vphaserDelayMs(v).toFixed(1)} ms`), parse: (ms) => 1 + (767 * ms) / 1000 },
    { key: 'delaySync', name: 'Tempo sync', index: 17, min: 0, max: 1, def: 0, options: onOff },
    { key: 'delayFeedback', name: 'Delay feedback', index: 18, min: 0, max: 6000, def: 0, format: pct1(100), parse: (pc) => (pc / 100) * 6000 },
    { key: 'delayLp', name: 'Delay low pass', index: 19, min: 3200, max: 204800, def: 3200, format: lpDelayText, parse: (hz) => 3200 + 201600 * (Math.log(Math.max(320, hz) / 320) / Math.log(64)) },
    { key: 'delayHp', name: 'Delay high pass', index: 20, min: 2000, max: 204800, def: 2000, format: hpDelayText, parse: (hz) => 2000 + 202800 * (Math.log(Math.max(20, hz) / 20) / Math.log(1024)) },
    { key: 'mix', name: 'Mix', index: 21, min: 0, max: 100, def: 50, format: (v) => `${100 - Math.round(v)}% Dry / ${Math.round(v)}% Wet`, bipolar: true, parse: (w) => w },
    { key: 'mono', name: 'Mono input', index: 22, min: 0, max: 1, def: 0, options: onOff },
    { key: 'noise', name: 'Noise', index: 23, min: 0, max: 6000, def: 0, format: (v) => (v <= 0 ? '-∞' : `${(-90 + (50 * v) / 6000 - 1e-9).toFixed(1)} dB`), parse: (db) => ((db + 90) / 50) * 6000 },
    { key: 'gate', name: 'Noise gate', index: 24, min: 0, max: 1, def: 0, options: onOff },
    { key: 'colorGain', name: 'Color low shelf gain', index: 25, min: 0, max: 6000, def: 0, format: (v) => `${((v * 30) / 6000 + 1e-9).toFixed(2)} dB`, parse: (db) => (db / 30) * 6000 },
    { key: 'colorFreq', name: 'Color low shelf frequency', index: 26, min: 5000, max: 650000, def: 5000, format: hz2(vphaserColorHz), parse: (hz) => 5000 + ((hz - 50) / 600) * 645000 },
    { key: 'inputHp', name: 'Input HP Frequency', index: 27, min: 2000, max: 80000, def: 2000, format: hpText, parse: (hz) => 2000 + 78000 * Math.cbrt(Math.max(0, hz - 5) / 195) },
    { key: 'feedbackHp', name: 'Feedback HP frequency', index: 28, min: 2000, max: 80000, def: 2000, format: hpText, parse: (hz) => 2000 + 78000 * Math.cbrt(Math.max(0, hz - 5) / 195) },
    { key: 'rate1', name: 'Rate frequency', index: 29, min: 25, max: 150000, def: 25, format: rateText, parse: (hz) => 25 + 149975 * Math.pow(Math.max(0, hz - 0.025) / 149.975, 0.25) },
    { key: 'rate2', name: 'Rate frequency 2', index: 30, min: 25, max: 150000, def: 150000, format: rateText, parse: (hz) => 25 + 149975 * Math.pow(Math.max(0, hz - 0.025) / 149.975, 0.25) },
    { key: 'lfoScale', name: 'LFO max depth scale', index: 31, min: 0, max: 6000, def: 6000, format: pct1(100), parse: (pc) => (pc / 100) * 6000 },
    { key: 'lfoPull', name: 'LFO max depth pull down', index: 32, min: 0, max: 6000, def: 0, format: pct1(100), parse: (pc) => (pc / 100) * 6000 },
    { key: 'engine', name: 'Engine', index: 33, min: 0, max: 1, def: 1, options: ['V1', 'V2'] },
    { key: 'drive', name: 'Drive', index: 34, min: 5000, max: 650000, def: 5000, format: (v) => `${(pos(v, 5000, 650000) * 30).toFixed(2)} dB`, parse: (db) => 5000 + (db / 30) * 645000 },
    { key: 'invertFb', name: 'Invert Feedback', index: 35, min: 0, max: 1, def: 0, options: onOff },
  ],
  // FL's factory presets (values read from FL with flfxhost, clamped to the control
  // ranges; a few legacy presets store out-of-range values; omitted = Default)
  presets: [
    { name: 'Classic cycle mono', params: { minFreq: 550525, maxFreq: 1577840, feedback: 0, hq: 1, speed: 113280, delayStereo: 0, mix: 51, colorGain: 1958, rate2: 75180, lfoScale: 0 } },
    { name: 'Classic cycle stereo', params: { minFreq: 550525, maxFreq: 1577840, feedback: 0, hq: 1, speed: 113280, lrPhase: 3000, delayStereo: 0, mix: 51, colorGain: 1958, rate2: 75180, lfoScale: 0 } },
    { name: 'Crusty phaser', params: { minFreq: 125, maxFreq: 1625600, feedback: 6000, speed: 14016, tension: 2370, startPhase: 3000, lrPhase: 3000, delayOn: 1, keepPitch: 1, delayMix: 2796, delayStereo: 6000, delayTime: 192, delaySync: 1, delayFeedback: 2184, delayLp: 16384, delayHp: 68048, noise: 2952, gate: 1, colorGain: 403, colorFreq: 650000, inputHp: 44100, feedbackHp: 80000, rate1: 120600, rate2: 23278, lfoScale: 1308, lfoPull: 6000, drive: 338000 } },
    { name: 'Deep cycle', params: { minFreq: 432, maxFreq: 1763604, feedback: 3252, manualFreq: 4680, hq: 1, speed: 49152, tension: 2118, delayOn: 1, delayMix: 6000, delayStereo: 5616, delayTime: 96, delaySync: 1, delayFeedback: 3348, delayLp: 71158, colorGain: 774, colorFreq: 6000, feedbackHp: 5040, rate1: 648, rate2: 3138, lfoScale: 1374, lfoPull: 198 } },
    { name: 'Default', params: {} },
    { name: 'Delay phaser mono', params: { minFreq: 550525, maxFreq: 1577840, feedback: 0, hq: 1, speed: 113280, delayOn: 1, keepPitch: 1, delayMix: 1932, delayTime: 129, delaySync: 1, delayFeedback: 3852, delayLp: 40320, mix: 51, colorGain: 1958, rate2: 83993, lfoScale: 0 } },
    { name: 'Delay phaser stereo', params: { minFreq: 550525, maxFreq: 1577840, feedback: 0, hq: 1, speed: 113280, lrPhase: 3000, delayOn: 1, keepPitch: 1, delayMix: 1932, delayStereo: 1380, delayTime: 129, delaySync: 1, delayFeedback: 3852, delayLp: 40320, mix: 51, colorGain: 1958, rate2: 83993, lfoScale: 0 } },
    { name: 'EP diver', params: { minFreq: 125, maxFreq: 1633405, feedback: 4896, hq: 1, speed: 177024, tension: 6000, lrPhase: 3000, feedbackHp: 80000, rate1: 19527, rate2: 56281, drive: 650000, invertFb: 1 } },
    { name: 'Lowgrounder', params: { minFreq: 716925, maxFreq: 2048000, feedback: 1320, manualFreq: 1182845, lfoType: 1, tension: 3030, keepPitch: 1, delayStereo: 864, delayLp: 31616, delayHp: 5328, mix: 100, colorGain: 2145, colorFreq: 77200, inputHp: 58100, feedbackHp: 80000, rate1: 66220, rate2: 25, lfoScale: 0 } },
    { name: 'Motionaire', params: { minFreq: 125, maxFreq: 6000, feedback: 3540, manualFreq: 3474, hq: 1, speed: 58944, lrPhase: 3000, delayOn: 1, keepPitch: 1, delayMix: 2352, delayStereo: 1800, delayTime: 192, delaySync: 1, delayFeedback: 3684, delayLp: 3276, delayHp: 3192, mix: 100, feedbackHp: 4932, rate1: 1848, rate2: 648 } },
    { name: 'Oxygene', params: { minFreq: 432, maxFreq: 4884, feedback: 3636, manualFreq: 4680, speed: 50257, delayOn: 1, delayMix: 6000, delayStereo: 5406, delayTime: 77, delaySync: 1, delayFeedback: 3348, delayLp: 5622, mix: 100, colorGain: 774, colorFreq: 6000, feedbackHp: 5040, rate1: 648, rate2: 3138, lfoScale: 1374, lfoPull: 198 } },
    { name: 'Radio Schaack', params: { minFreq: 666, maxFreq: 710, feedback: 5031, manual: 1, manualFreq: 3781, lfoType: 1, lrPhase: 3137, delayStereo: 0, delayHp: 204800, mix: 100, colorFreq: 650000, feedbackHp: 80000, lfoScale: 0 } },
    { name: 'Senseviber', params: { minFreq: 1272445, maxFreq: 125, feedback: 6000, hq: 1, speed: 49152, tension: 6000, lrPhase: 3000, inputHp: 7900, feedbackHp: 52800, rate1: 19902, rate2: 73304, lfoScale: 1308, lfoPull: 2076, drive: 509000, invertFb: 1 } },
    { name: 'Sidebander', params: { minFreq: 376445, maxFreq: 2048000, feedback: 1656, hq: 1, speed: 131185, lfoType: 1, tension: 1458, lrPhase: 3000, delayOn: 1, keepPitch: 1, delayMix: 4332, delayStereo: 0, delayTime: 96, delaySync: 1, delayFeedback: 2088, delayLp: 83584, delayHp: 113104, mix: 51, noise: 1400, rate1: 42967, rate2: 22152, lfoScale: 0, lfoPull: 5928 } },
    { name: 'Slow and simple', params: { minFreq: 125, maxFreq: 1892720, feedback: 0, hq: 1, speed: 49152, lfoType: 1, lrPhase: 3000, delayStereo: 0, mix: 51, rate2: 75180, lfoScale: 0 } },
    { name: 'Upper Glare', params: { minFreq: 535405, maxFreq: 993280, feedback: 0, manualFreq: 1584, hq: 1, speed: 116657, tension: 4386, startPhase: 3000, lrPhase: 2639, delayOn: 1, keepPitch: 1, delayMix: 3058, delayStereo: 4260, delayTime: 192, delaySync: 1, delayFeedback: 3353, delayLp: 54912, delayHp: 204800, mix: 47, colorGain: 259, colorFreq: 346000, inputHp: 47400, feedbackHp: 70100, rate2: 119247, lfoScale: 1560, lfoPull: 3396 } },
  ],
};
