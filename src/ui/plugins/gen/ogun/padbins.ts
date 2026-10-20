// The harmonic bins editor of the pad harmonics tool (FL: TMEHarmToolForm.LevelVisual, 512 x 105: 64 columns of 8 px, one bar each;
// the "Bin level" and the "Bin width" tab show one of the two arrays). Mouse handling decoded from LevelVisualMouseDown / Move / Up
// (0xf12b0, 0xf1350, 0xf16d0), value <-> pixel from 0xf1af0 / 0xf1b40, hint from 0xf1b90; the drawing is original.

import { PAD_BINS, PAD_FULL, rne, type PadBins } from '../../../../model/gen/plugins/ogun/padharm';

const f32 = Math.fround;

/** Pixels per bin, the margin around a bar and the height of the value range (FL's metrics at 100 % scale). */
export const BIN_PX = 8;
export const BIN_PAD = 1;
export const BIN_W = BIN_PX * PAD_BINS;
export const BIN_H = 105;
const RANGE_H = BIN_H - 3;

/** Colour of a tab's bars (FL's per-tab colour record). */
export const TAB_COLORS = ['#5595ff', '#55ffaa'] as const;
export const TAB_NAMES = ['Bin level', 'Bin width'] as const;

/** Value of a bar at pixel row `y` (single precision like FL): the top of the range is the full scale. */
export function binValueAt(y: number): number {
  const s = f32(f32(1) - f32(f32(y - BIN_PAD) / RANGE_H));
  return f32(s * PAD_FULL);
}

/** Pixel row of a value (the top of its bar). */
export function binPixel(v: number): number {
  return BIN_PAD + (1 - v / PAD_FULL) * RANGE_H;
}

export function binIndexAt(x: number): number {
  return Math.floor(x / BIN_PX);
}

/** The state of a drag: the position the next interpolation starts from (null before the first move). */
export interface BinDrag {
  anchor: { bin: number; y: number } | null;
}

export interface BinPointer {
  /** Pointer position in the visual (px); y is the row of the pointer (FL works with y - 1). */
  x: number;
  y: number;
  /** The left button is down (ssLeft), Shift and Alt (ssShift, ssAlt). */
  left: boolean;
  shift: boolean;
  alt: boolean;
}

export const newBinDrag = (): BinDrag => ({ anchor: null });

/**
 * One mouse move while dragging (0xf1350): the bars between the last position and this one get the pointer's height (interpolated
 * between the two positions); Shift + left drag keeps the bin of the last position (vertical only), Alt sets the full scale; with
 * the right button the first position stays the anchor, so dragging draws a ramp. Returns true when a value changed.
 */
export function dragBins(bins: PadBins, tab: 0 | 1, d: BinDrag, p: BinPointer): boolean {
  const arr = tab === 0 ? bins.level : bins.width;
  let bin = binIndexAt(p.x);
  const yy = p.y - 1;
  if (!d.anchor) d.anchor = { bin, y: yy };
  const a = d.anchor.bin;
  if (p.shift && p.left) bin = a;
  const steps = bin - a;
  const dy = yy - d.anchor.y;
  const dir = steps < 0 ? -1 : 1;
  let changed = false;
  for (let i = a; ; i += dir) {
    let s8: number;
    if (steps !== 0) s8 = f32((dy * (i - bin)) / steps);
    else s8 = p.left ? 0 : f32(-dy);
    let v: number;
    if (p.alt) v = PAD_FULL;
    else v = Math.min(PAD_FULL, Math.max(0, rne(binValueAt(f32(yy + s8)))));
    if (i >= 0 && i < PAD_BINS && arr[i] !== v) { arr[i] = v; changed = true; }
    if (i === bin) break;
  }
  if (p.left) d.anchor = { bin, y: yy };
  return changed;
}

/** The hint of a bar (FL: "Harmonic n", with the octave of the bin in front). */
export function binHint(bin: number): string {
  if (bin < 0 || bin >= PAD_BINS) return '';
  let oct = 0;
  for (let k = 1; k <= 8; k++) if (bin + 1 >= 1 << k) oct = k;
  return `Harmonic ${bin + 1}${oct ? ` (+${oct} oct)` : ''}`;
}

/** Bins whose number + 1 is a power of two get a darker column (FL shades the octave marks). */
export const isOctaveBin = (i: number): boolean => ((i + 1) & i) === 0;

const mix = (c: string, d: string, k: number): string => {
  const n = (s: string, o: number) => parseInt(s.slice(1 + o, 3 + o), 16);
  const ch = (o: number) => Math.round(n(c, o) * (1 - k) + n(d, o) * k);
  return `rgb(${ch(0)},${ch(2)},${ch(4)})`;
};
const darken = (c: string, v: number): string => {
  const ch = (o: number) => Math.max(0, parseInt(c.slice(1 + o, 3 + o), 16) - v);
  return `rgb(${ch(0)},${ch(2)},${ch(4)})`;
};

/** Draw the bins of a tab (original drawing after the layout of FL's visual). */
export function drawBins(g: CanvasRenderingContext2D, bins: PadBins, tab: 0 | 1): void {
  const arr = tab === 0 ? bins.level : bins.width;
  g.fillStyle = '#1c2226';
  g.fillRect(0, 0, BIN_W, BIN_H);
  const base = BIN_H - BIN_PAD;
  for (let i = 0; i < PAD_BINS; i++) {
    const oct = isOctaveBin(i);
    const bg = oct ? darken('#2d3337', 5) : '#2d3337';
    let col = oct ? darken(TAB_COLORS[tab], 5) : TAB_COLORS[tab];
    if (tab === 1 && bins.level[i] === 0) col = mix(TAB_COLORS[1], '#2d3337', 0.75);
    const x0 = i * BIN_PX + BIN_PAD, x1 = (i + 1) * BIN_PX - BIN_PAD;
    g.fillStyle = bg;
    g.fillRect(x0, BIN_PAD, x1 - x0, base - BIN_PAD);
    g.strokeStyle = '#3a4247';
    g.lineWidth = 1;
    g.strokeRect(x0 + 0.5, BIN_PAD + 0.5, x1 - x0 - 1, base - BIN_PAD - 1);
    const v = arr[i];
    const top = binPixel(v);
    const bottom = v >= PAD_FULL / 2 ? base : base - 1;
    if (bottom > top) {
      g.fillStyle = col;
      g.fillRect(x0 + 1, top, x1 - x0 - 2, bottom - top);
    }
  }
}
