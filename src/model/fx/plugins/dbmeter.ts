// dB Meter (FL: Fruity dB Meter): a large stereo peak meter on a dB scale
// (+6 .. -36 dB, 6 px per dB). No parameters. Form: 100 x 270; ruler ticks
// (TVectorSlider, Left 25, Top 8, 15 x 255, -36..6) and labels on the left,
// a two-bar TWAVVolumeter (Left 40, 60 x 270) on the right.

import type { FxPluginDef } from '../types';

/** Geometry shared by the editor and the tests (FL's runtime layout at 100%). */
export const DBM = {
  /** Panel height (FL's volumeter height). */
  H: 270,
  /** Ruler: top edge and height (ticks span Height - 1). */
  rulerTop: 8,
  rulerH: 255,
  /** Highest and lowest scale marks (dB). */
  top: 6,
  bottom: -36,
} as const;

/** Pixels per label interval (6 dB): FL computes (Ruler.Height - 1) / 7. */
export const DBM_STEP = (DBM.rulerH - 1) / 7;
/** Pixels per dB. */
export const DBM_PX_PER_DB = DBM_STEP / 6;
/** Pixels from the bottom of the meter to 0 dB (FL rounds the 0 dB line). */
export const DBM_ZERO_FROM_BOTTOM = DBM.H - Math.round(DBM.rulerTop + DBM_STEP);
/** y of the -6 dB line: bars are orange above it. */
export const DBM_ORANGE_Y = Math.round(DBM.rulerTop + 2 * DBM_STEP);

/** Bar height in pixels (from the bottom) for a linear peak value; 0 for silence. */
export function dbmLevelPx(peak: number): number {
  if (!(peak > 0)) return 0;
  return 20 * Math.log10(peak) * DBM_PX_PER_DB + DBM_ZERO_FROM_BOTTOM;
}

/** FL's hover text for a mouse y inside the meter: "-6.0dB". */
export function dbmHoverText(y: number): string {
  const yy = Math.max(0, Math.min(DBM.H - 1, Math.floor(y)));
  const v = (DBM.H - DBM_ZERO_FROM_BOTTOM - yy) / DBM_PX_PER_DB;
  const s = v.toFixed(1);
  return (s === '-0.0' ? '0.0' : s) + 'dB';
}

export const def: FxPluginDef = {
  id: 'dbmeter',
  name: 'dB Meter',
  category: 'Visual',
  width: 100,
  height: 270,
  description: 'Large-display stereo peak meter in dB',
  params: [],
};
