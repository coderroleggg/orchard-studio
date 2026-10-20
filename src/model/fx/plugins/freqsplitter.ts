// Frequency Splitter: two or three band crossover whose bands go to the main
// output (levels, mute / solo) and to sends (levels, mute / solo, target mixer
// track per band). Form: 770 x 340; 14 parameters in FL's order (Tags 0-13).
// Mute / solo switches, send targets and view options are state.
// Mappings measured on FL's binary (docs/research/fx/freqsplitter.md).

import type { FxPluginDef } from '../types';

export const FS_SLOPES = [6, 12, 18, 24, 36, 48, 72, 96];
export const FS_QUALITY = ['Lowest', 'Low', 'Medium', 'High', 'Higher', 'Highest'];

/** Crossover frequency for a 0..65536 wheel: 30 * (16000 / 30)^t Hz. */
export function fsFreqHz(v: number): number {
  return 30 * Math.pow(16000 / 30, Math.min(65536, Math.max(0, v)) / 65536);
}

/** Inverse of fsFreqHz. */
export function fsFreqValue(hz: number): number {
  return Math.round((Math.log(Math.max(30, Math.min(16000, hz)) / 30) / Math.log(16000 / 30)) * 65536);
}

/** Band level gain: linear to 0 below the centre (-inf at -1800), up to +18 dB above. */
export function fsGain(v: number): number {
  const t = Math.min(1800, Math.max(-1800, v)) / 1800;
  return t <= 0 ? 1 + t : 1 + t * (Math.pow(10, 18 / 20) - 1);
}

export function fsGainText(v: number): string {
  const g = fsGain(v);
  return g <= 0 ? '-inf' : `${(20 * Math.log10(g)).toFixed(1)} dB`;
}

/** Linear phase modulation speed: 2 * 100^t ms. */
export function fsSpeedMs(v: number): number {
  return 2 * Math.pow(100, Math.min(65536, Math.max(0, v)) / 65536);
}

/** Effective crossover frequencies: in 3 band mode the two points cannot cross. */
export function fsCrossovers(p: Record<string, number>): [number, number] {
  const a = fsFreqHz(p.f1 ?? 19800), b = fsFreqHz(p.f2 ?? 48065);
  return (p.bands ?? 1) >= 1 ? [Math.min(a, b), Math.max(a, b)] : [a, b];
}

export interface FsState {
  /** Main / send band switches (1 = on); solo = band index or -1. */
  mainOn: number[]; sendOn: number[];
  mainSolo: number; sendSolo: number;
  /** Send target mixer track per band (-1 = none). */
  sendTarget: number[];
}

export const fsDefaultState = (): FsState => ({ mainOn: [1, 1, 1], sendOn: [1, 1, 1], mainSolo: -1, sendSolo: -1, sendTarget: [-1, -1, -1] });

export function fsNormalizeState(s: unknown): FsState {
  const d = fsDefaultState();
  if (!s || typeof s !== 'object') return d;
  const o = s as Partial<FsState>;
  const arr = (a: unknown, def: number[], f: (v: number) => number) => (Array.isArray(a) ? def.map((x, i) => (typeof a[i] === 'number' && Number.isFinite(a[i]) ? f(a[i]) : x)) : def);
  return {
    mainOn: arr(o.mainOn, d.mainOn, (v) => (v ? 1 : 0)),
    sendOn: arr(o.sendOn, d.sendOn, (v) => (v ? 1 : 0)),
    mainSolo: typeof o.mainSolo === 'number' && o.mainSolo >= 0 && o.mainSolo <= 2 ? Math.round(o.mainSolo) : -1,
    sendSolo: typeof o.sendSolo === 'number' && o.sendSolo >= 0 && o.sendSolo <= 2 ? Math.round(o.sendSolo) : -1,
    sendTarget: arr(o.sendTarget, d.sendTarget, (v) => (v >= 0 ? Math.round(v) : -1)),
  };
}

const lvl = (key: string, name: string, index: number) => ({ key, name, index, min: -1800, max: 1800, def: 0, format: fsGainText, bipolar: true });

const DEF = { f1: 19800, f2: 48065, s1: 3, s2: 3, lin: 0, bands: 1, quality: 2, speed: 45820, sLow: 0, sMid: 0, sHigh: 0, mLow: 0, mMid: 0, mHigh: 0 };
const preset = (name: string, p: Partial<typeof DEF>, mainOn = [1, 1, 1]) => ({ name, params: { ...DEF, ...p, fs: { ...fsDefaultState(), mainOn } } });

export const def: FxPluginDef = {
  id: 'freqsplitter',
  name: 'Frequency Splitter',
  category: 'Filter',
  width: 770,
  height: 340,
  description: 'Two or three band crossover with main output levels and band sends to mixer tracks',
  params: [
    { key: 'f1', name: 'Low/Mid Freq', index: 0, min: 0, max: 65536, def: 19800, format: (v) => `${fsFreqHz(v).toFixed(1)} Hz` },
    { key: 'f2', name: 'Mid/High Freq', index: 1, min: 0, max: 65536, def: 48065, format: (v) => `${fsFreqHz(v).toFixed(1)} Hz` },
    { key: 's1', name: 'Low/Mid Slope', index: 2, min: 0, max: 7, def: 3, options: FS_SLOPES.map((s) => `${s} dB`) },
    { key: 's2', name: 'Mid/High Slope', index: 3, min: 0, max: 7, def: 3, options: FS_SLOPES.map((s) => `${s} dB`) },
    { key: 'lin', name: 'Linear phase', index: 4, min: 0, max: 1, def: 0, options: ['Normal', 'FFT'] },
    { key: 'bands', name: 'Number of bands', index: 5, min: 0, max: 1, def: 1, options: ['2', '3'] },
    { key: 'quality', name: 'Linear Phase Quality', index: 6, min: 0, max: 5, def: 2, options: FS_QUALITY },
    { key: 'speed', name: 'Linear phase mod speed', index: 7, min: 0, max: 65536, def: 45820, format: (v) => `${fsSpeedMs(v).toFixed(1)} ms` },
    lvl('sLow', 'Low', 8), lvl('sMid', 'Mid', 9), lvl('sHigh', 'High', 10),
    lvl('mLow', 'Low main output', 11), lvl('mMid', 'Mid main output', 12), lvl('mHigh', 'High main output', 13),
  ],
  state: () => ({ fs: fsDefaultState(), fsView: { monitor: 2, mainBands: 1, mainCurve: 1, sendBands: 0, sendCurve: 0, link: 0 } }),
  normalize: (p) => ({ ...p, fs: fsNormalizeState(p.fs) }),
  viewState: ['fsView'],
  // FL's factory presets (values read from the .fst states with the test host; the main mute
  // switches come from the state's mute bit mask, bit 3 + band)
  presets: [
    preset('Default', {}),
    preset('Dual band 500Hz', { f1: 29365, s1: 5, bands: 0 }),
    preset('Gentle low roll off', { s1: 0, bands: 0 }, [0, 1, 1]),
    preset('Isolate below 200Hz', { f1: 19792, f2: 65536, s1: 5, bands: 0 }, [1, 0, 0]),
    preset('Isolate over 4kHz', { f1: 51069, f2: 65536, s1: 2, bands: 0 }, [0, 0, 1]),
    preset('Low boost', { mLow: 259 }),
    preset('Mastering curve', { s1: 0, s2: 0, mLow: 108, mMid: -529, mHigh: 108 }),
    preset('Steep 30Hz Cut', { f1: 0, s1: 7, bands: 0 }, [0, 1, 1]),
    preset('Steep tri band', { f2: 47819, s1: 7, s2: 7 }),
  ],
};

const SL_ORDER = [1, 1, 3, 2, 3, 4, 6, 8];
const SL_SQUARE = [1, 2, 1, 2, 2, 2, 2, 2];

/** Magnitudes of the low / mid / high bands at f (Hz) for the settings (display curves). */
export function fsBandMags(p: Record<string, number>, f: number, sr = 48000): [number, number, number] {
  const [f1, f2] = fsCrossovers(p);
  const three = (p.bands ?? 1) >= 1;
  const s1 = Math.min(7, Math.max(0, Math.round(p.s1 ?? 3))), s2 = Math.min(7, Math.max(0, Math.round(p.s2 ?? 3)));
  if ((p.lin ?? 0) >= 0.5) {
    const lg = (fc: number, k: number) => { const r = f / fc; return r <= 1 ? 1 - 0.5 * Math.pow(r, k) : 0.5 * Math.pow(r, -k); };
    const k = [1, 2, 3, 4, 6, 8, 12, 16];
    const l1 = lg(f1, k[s1]);
    if (!three) return [l1, 0, 1 - l1];
    const l2 = lg(f2, k[s2]);
    return [l1, (1 - l1) * l2, (1 - l1) * (1 - l2)];
  }
  // Butterworth magnitudes on the bilinear frequency axis, raised to the section count
  const w = Math.tan((Math.PI * Math.min(f, sr * 0.499)) / sr);
  const bw = (fc: number, s: number) => {
    const r = w / Math.tan((Math.PI * Math.min(fc, sr * 0.49)) / sr), n = SL_ORDER[s];
    const lp = 1 / Math.sqrt(1 + Math.pow(r, 2 * n)), hp = Math.pow(r, n) / Math.sqrt(1 + Math.pow(r, 2 * n));
    return [Math.pow(lp, SL_SQUARE[s]), Math.pow(hp, SL_SQUARE[s])];
  };
  const [lp1, hp1] = bw(f1, s1);
  if (!three) return [lp1, 0, hp1];
  const [lp2, hp2] = bw(f2, s2);
  return [lp1, hp1 * lp2, hp1 * hp2];
}
