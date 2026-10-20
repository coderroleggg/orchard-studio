// Slicex's default data, from FL 2026: the plugin database state FL loads for a new instance
// (Plugin database/Generators/Drum/Slicex.fst, decoded; all 8 articulators are identical), the
// new-region record (0x7f770) and the option block (+0x1304, 47 bytes).

import type { SxArt, SxCurve, SxDeck, SxRegion, SxSettings, SxTarget } from './types';

type Pt = number[];
const flat = (y: number): SxCurve => ({ t: 3, p: [[0, y, 0, 0, 0, 0, 0], [1, y, 0, 0, 0, 0, 2]], m: [0, -1, -1, -1, -1] });
const dot = (y: number): Pt[] => [[0, y, 0, 0, 0, 0, 0]];
const lfo0 = (): SxCurve => ({ t: 2, p: dot(1), m: [3, 0, -1, -1, -1], l: [31102, 0, 0, 0], ph: 0 });
const decay = (y0: number, dx: number, t: number): Pt[] => [[0, y0, 0, 0, 0, 0, 0], [dx, 0, t, 0, 0, 0, 1]];

/** FL's default targets (pan, vol, cutoff, resonance, speed, start). */
function defTargets(): SxTarget[] {
  const tg = (env: SxCurve, lfo: SxCurve, map: number): SxTarget => ({ b: 0, ea: 1, la: 1, env, lfo, maps: [flat(map), flat(map), flat(map), flat(map)] });
  const env = (p: Pt[], m: number[]): SxCurve => ({ t: 1, p, m, a: [128, 128, 0, 128] });
  return [
    tg(env(dot(0.5), [0, 0, -1, -1, -1]), lfo0(), 0.5),
    tg(env(decay(1, 1, 0.17500010132789612), [0, 0, -1, -1, 1]), lfo0(), 1),
    tg(env(decay(1, 1, 0.17500010132789612), [0, 0, -1, -1, 1]), lfo0(), 0.5),
    tg(env(dot(0.5), [0, 0, -1, -1, -1]), lfo0(), 0.5),
    tg(env(decay(0.5, 1.2000000000000002, 0.20000000298023224), [0, 0, -1, -1, 1]), lfo0(), 1),
    tg(
      env([[0, 0, 0, 0, 0, 0, 0], [0.75, 1, 0.20000000298023224, 0, 0, 0, 1], [1.5, 0.5, 0.20000000298023224, 0, 0, 0, 1],
        [0.25, 0, 0.20000000298023224, 0, 0, 0, 1]], [0, 0, 1, -1, 2]),
      { t: 2, p: [[0, 0.5, 0, 0, 0, 0, 0], [1, 0.5, 0, 0, 0, 0, 2], [0.25, 1, 0, 0, 0, 0, 2], [1, 0.5, 0, 0, 0, 0, 2]], m: [0, 0, -1, -1, 2], l: [40000, 0, 0, 0], ph: 0 },
      0.5),
  ];
}

export function defaultArt(): SxArt {
  return { ft: 0, fb: [0, 0, 0], fo: 0, t: defTargets() };
}

export function defaultArts(): SxArt[] {
  return Array.from({ length: 8 }, defaultArt);
}

/** A new region's record (FL 0x7f770): unity volume, centred, every section on articulator 1 at 100 %. */
export function defaultRegion(s = 0, e = -1): SxRegion {
  return {
    s, e, name: '', info: '', pur: 2, note: -1,
    cut: 0, out: 0, pan: 0, vol: 8000, aArt: 0, aAmt: 12800, fc: 128, fr: 128, fArt: 0, fAmt: 12800, pitch: 0, sArt: 0, sAmt: 12800,
    delay: 0, ofs: 0, oArt: 0, oAmt: 12800,
  };
}

export function emptyDeck(): SxDeck {
  return { title: '', file: '', tempo: 0, beats: 0, regions: [] };
}

/** FL's option block of the plugin database state. */
export const DEFAULT_SETTINGS_RAW = [0, 0, 0, 0, 3, 0, 0, 0, 5, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 1,
  1, 1, 0, 0, 0, 1, 1, 0, 0];

/** Named settings from FL's raw option block. */
export function settingsFromRaw(raw: number[]): SxSettings {
  const b = (o: number) => (raw[o - 0x1304] ?? 0) & 0xff;
  const w = (o: number) => (b(o) | (b(o + 1) << 8) | (b(o + 2) << 16) | (b(o + 3) << 24)) | 0;
  return {
    lmode: w(0x1304), xfade: w(0x1308), sameDeck: !!b(0x132e), smooth: !!b(0x1329), startWhole: !!b(0x132c), velVol: !!b(0x132f),
    loopHalf: !!b(0x1331), hqEnv: !!b(0x132d), autoDump: !!b(0x132a), lockAudio: true, noEmbed: !!b(0x1332),
    loop: !!b(0x1325), kbShown: !!b(0x1330), noAutoScroll: !!b(0x1326), dual: !!b(0x132b), dispMode: w(0x1314), raw: raw.slice(0, 47),
  };
}

export function defaultSettings(): SxSettings {
  return settingsFromRaw(DEFAULT_SETTINGS_RAW);
}
