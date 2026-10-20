// Ogun's "Create pad harmonics" tool (FL: TMEHarmToolForm of Ogun / Autogun, opened from the articulator editor's menu while a shaping
// map is edited; RE of Ogun_x64.dylib: build 0xf1f00, bins 0xf0a80 / 0xf28d0 / 0xf0c00). Pure model, no UI: the 64 harmonic bins
// (a level and a width each, 0 .. 65536), the bin window shape (a mapping curve), the width knob (0 .. 1000) and "normalize loudness"
// make a spectrum of the synthesizer's harmonics (PADsynth-like: every bin is a bell of nearby harmonics), which becomes the dense map
// the tool writes into the edited shaping map. The random generator of the plugin ("Generate random preset") uses the same code with
// its own switches, so the randomizer takes the random numbers from a callback (the plugin's Mersenne twister draws u32 values).
//
// Arithmetic follows the binary: float32 (Math.fround) where FL keeps singles, double elsewhere, frintx (round half to even) and
// 32-bit truncation; exp / log are libm calls in FL.

import { ogCompile, ogMapAt } from '../../../../engine/gen/plugins/ogun/ogcurve';
import { pointKind } from './flstate';
import type { OgEnv } from './types';

const f32 = Math.fround;

export const PAD_BINS = 64;
/** Full scale of a bin level / width. */
export const PAD_FULL = 65536;
/** Range of the width knob (FL: 0 .. 1000, default 500). */
export const PAD_WIDTH_MAX = 1000;
export const PAD_WIDTH_DEFAULT = 500;
/** x distance of one harmonic on the map: the linear EQ mapping scale (position i / 32767) and a step of the natural (octave) scale. */
export const PAD_UNIT_LINEAR = 1 / 32767;
export const PAD_UNIT_NATURAL = 1 / 15;
/** Loudest value of the spectrum (the log mapping to the map's 0..1 range ends there). */
export const PAD_PEAK = 4;

/** A source of random u32 values (FL: Tmt19937.genrand_int32). */
export type PadRng = () => number;

const LN101 = 4.6151205168412597;
const LN3 = 1.0986122886681098;
const LN21 = 3.044522437723423;
const TWO_M32 = 2.3283064370807974e-10;
const TWO_M32_F = 2.32830644e-10;
const TWO_M16 = 1.52587890625e-05;
/** FL keeps ln 3 as a single (G[3f482c] = 0x3f8c9f54) and 1 / ln 3 as the next global. */
const LN3_F = f32(1.0986123085021973);
const INV_LN3_F = f32(1 / LN3_F);

/** frintx: round half to even. */
export function rne(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// ------------------------------------------------------------------------------------------------------------------ the bins

/** The 64 harmonic bins: the level and the width of each (0 .. 65536). */
export interface PadBins {
  level: number[];
  width: number[];
}

/** Default level of bin i (0xf0a80 with mask 1): ln(100 / (i + 1) + 1) / ln 101, i.e. the amplitude 1 / (i + 1) on the log scale. */
export function defaultLevel(i: number): number {
  const a = f32((1 / (i + 1)) * 100);
  const l = Math.log(f32(a + 1)) / LN101;
  return rne(f32(f32(l) * 65536)) | 0;
}

/** Default width of bin i (mask 2): grows linearly from 0 to the full scale. */
export function defaultWidth(i: number): number {
  return rne((i * 65536) / 63) | 0;
}

export function newBins(): PadBins {
  return {
    level: Array.from({ length: PAD_BINS }, (_, i) => defaultLevel(i)),
    width: Array.from({ length: PAD_BINS }, (_, i) => defaultWidth(i)),
  };
}

export function copyBins(b: PadBins): PadBins {
  return { level: b.level.slice(), width: b.width.slice() };
}

/** Reset the arrays selected by the mask (bit 0 levels, bit 1 widths) to their defaults. */
export function resetBins(b: PadBins, mask: number): void {
  for (let i = 0; i < PAD_BINS; i++) {
    if (mask & 1) b.level[i] = defaultLevel(i);
    if (mask & 2) b.width[i] = defaultWidth(i);
  }
}

/** FL's power function (0x1d5f60) on singles. */
function powf(base: number, e: number): number {
  if (e === 0) return 1;
  if (base === 0 && e > 0) return 0;
  return f32(Math.exp(e * Math.log(base)));
}

/** u32 -> float32 (ucvtf s, w) times 2^-32 in float32: the "random 0 .. 1" of the tool. */
const unit32 = (r: number): number => f32(f32(r >>> 0) * TWO_M32_F);

export interface PadRandomOptions {
  /** The spectral tilt is steeper (the exponent 2 instead of 1 times 0.75 .. 1.75): every target but the impulse EQ (form field 0xa10). */
  steep: boolean;
  /** Plateau mode of the plugin's random preset generator (form field 0xa14): a level is drawn anew only with the probability 1 / bin. */
  walk?: boolean;
}

/**
 * Randomize the arrays selected by the mask (0xf28d0, the "Randomize" buttons): first reset, then every bin 0 .. 62 gets a random level
 * falling with its number (bin 63 stays silent) and every width is a random value below 1.5 times its default.
 */
export function randomizeBins(b: PadBins, mask: number, rng: PadRng, o: PadRandomOptions): void {
  resetBins(b, mask);
  let d9 = 0;
  let d8 = o.steep ? 2 : 1;
  d8 *= 0.75 + (rng() >>> 0) * TWO_M32;
  for (let i = 0; i < PAD_BINS; i++) {
    if (mask & 1) {
      b.level[i] = 0;
      if (i < PAD_BINS - 1) {
        const j = i + 1;
        let redraw = true;
        if (o.walk) redraw = Math.trunc(f32(unit32(rng()) * f32(j))) === 0;
        if (redraw) {
          const x = f32((rng() >>> 0) * TWO_M32);
          const e = f32(Math.exp(x * LN3) - 1);
          d9 = o.walk ? f32(e * 0.5) : f32(f32(2 - e) * 0.75);
        }
        d9 /= powf(j, f32(d8));
        const v = rne(f32(f32(Math.log(f32(f32(d9 * 100) + 1)) / LN101) * 65536));
        b.level[i] = Math.min(v, PAD_FULL) | 0;
      }
    }
    if (mask & 2) {
      const lim = Math.trunc((b.width[i] * 3) / 2);
      const v = Math.trunc(f32(unit32(rng()) * f32(lim)));
      b.width[i] = Math.min(v, PAD_FULL) | 0;
    }
  }
}

/** The width knob's random value of "Randomize" (0xf2810): 0 .. 1000 (the knob takes the draw 0 .. 1001 and keeps it in its range). */
export function randomWidthValue(rng: PadRng): number {
  return Math.min(PAD_WIDTH_MAX, Math.trunc(f32(unit32(rng()) * f32(PAD_WIDTH_MAX + 1))));
}

/** "Humanize" (0xf0c00): every value of the array `tab` (0 levels, 1 widths) moves by up to -5 .. +5 percent of the full scale. */
export function humanizeBins(b: PadBins, tab: 0 | 1, rng: PadRng): void {
  const a = tab === 0 ? b.level : b.width;
  for (let i = 0; i < PAD_BINS; i++) {
    const r = Math.trunc(f32(unit32(rng()) * 6554));
    a[i] = Math.max(0, Math.min(PAD_FULL, a[i] - 0xccc + r));
  }
}

// ---------------------------------------------------------------------------------------------------------------- the window

/** The default bin window shape: a raised cosine (two half-wave segments, as FL's default shape file). */
export function defaultWindow(): OgEnv {
  return {
    t: 3, m: [0, -1, -1, -1, -1],
    p: [[0, 0, 0, 0, 0, 0, 0], [0.5, 1, -1, 6, 0, 0, pointKind(-1, 6)], [0.5, 0, -1, 6, 0, 0, pointKind(-1, 6)]],
  };
}

/** Built-in alternatives to the default window shape (FL ships "hat" and "tent" shape files): a flat-topped bell and a pointed one. */
export function windowPreset(kind: 'default' | 'hat' | 'tent'): OgEnv {
  const type = kind === 'hat' ? 8 : kind === 'tent' ? 7 : 6;
  const t2 = kind === 'tent' ? 1 : -1;
  return {
    t: 3, m: [0, -1, -1, -1, -1],
    p: [[0, 0, 0, 0, 0, 0, 0], [0.5, 1, -1, type, 0, 0, pointKind(-1, type)], [0.5, 0, t2, type, 0, 0, pointKind(t2, type)]],
  };
}

/** A prepared window: value at a position 0 .. length. */
export interface PadWindow {
  at(t: number): number;
  length: number;
}

/** Prepare a window curve for evaluation: FL's curve library as compiled into Ogun (the exact port of the engine), value at a position. */
export function prepareWindow(c: OgEnv): PadWindow {
  const curve = ogCompile(c, 'map');
  return { length: curve.len, at: (t: number) => ogMapAt(curve, t) };
}

// ---------------------------------------------------------------------------------------------------------- the spectrum

export interface PadSpectrumOptions {
  /** Width knob 0 .. 1000. */
  width: number;
  /** "Normalize loudness". */
  normalize: boolean;
  /** Number of harmonics + 1 (the synthesizer's harmonic count + 1: 2 ^ (richness order - 1)). */
  n: number;
}

/**
 * The spectrum of the bins (0xf1f00): bin j is centred on the harmonic index binSize * (j + 1) - 1 (binSize = n / 64), has the
 * amplitude (101 ^ level - 1) / 100 and the half width binSize * (21 ^ (width / 1000) - 1) * 0.4 * its width value; the window shape
 * gives the amplitude of the harmonics around the centre; the bins add up. "Normalize loudness" scales the peak (at least 8 times the
 * rms of the bins' contributions per bin) to 4.
 */
export function padSpectrum(bins: PadBins, window: PadWindow, o: PadSpectrumOptions): Float32Array {
  const n = o.n;
  const buf = new Float32Array(n);
  const binSize = Math.trunc(n / PAD_BINS);
  const wk = f32(o.width * f32(0.001));
  const reach = f32(binSize * f32(Math.exp(wk * LN21) - 1)) * 0.4;
  let sumSq = 0;
  for (let j = 0; j < PAD_BINS; j++) {
    const center = binSize * (j + 1) - 1;
    const lv = f32(bins.level[j] * TWO_M16);
    const amp = f32(Math.exp(lv * LN101) - 1) * 0.01;
    let scale = reach * bins.width[j] * TWO_M16;
    const k = Math.trunc(scale);
    if (scale > 0) scale = 1 / scale;
    for (let d = -k; d <= k; d++) {
      const idx = d + center;
      if (idx < 0 || idx > n - 1) continue;
      const v = window.at((window.length + d * scale) * 0.5) * amp;
      buf[idx] = buf[idx] + v;
      sumSq += v * v;
    }
  }
  if (o.normalize) {
    let mx = 0;
    for (let i = 0; i < n; i++) if (buf[i] > mx) mx = buf[i];
    const rms = Math.sqrt(sumSq / PAD_BINS) * 8;
    if (rms > mx) mx = f32(rms);
    if (mx > 0) {
      const g = f32(PAD_PEAK / mx);
      for (let i = 0; i < n; i++) buf[i] = buf[i] * g;
    }
  }
  return buf;
}

// ----------------------------------------------------------------------------------------------------------------- the curve

/** Insert a point at absolute position `pos` (TCustomMEnvelope.AddPoint 0x25fca0, rows [distance, y, tension, ...]); returns its index. */
function addPointAt(rows: number[][], length: number, pos: number, y: number, tension: number): number {
  const at = pos >= 0 ? (pos > length ? length : pos) : 0;
  let ins = rows.length;
  let prev = 0;
  if (rows.length > 0) {
    let acc = rows[0][0];
    prev = acc;
    for (let i = 1; i < rows.length; i++) {
      acc += rows[i][0];
      if (acc > at) { ins = i; break; }
      prev = acc;
    }
  }
  const dx = f32(at - prev);
  rows.splice(ins, 0, [dx > 0 ? dx : 0, y, tension, 0, 0, 0, 0]);
  if (ins < rows.length - 1) rows[ins + 1][0] -= rows[ins][0];
  return ins;
}

/** The point whose absolute position is `pos` (within 2^-24), or -1 (0x264fd0). */
function findPointAt(rows: number[][], pos: number): number {
  let acc = 0;
  for (let i = 0; i < rows.length; i++) {
    acc += rows[i][0];
    if (Math.abs(acc - pos) < 5.960464477539063e-8) return i;
  }
  return -1;
}

/** Linear value of plain rows (all the pad curve's points have the single curve type with zero tension). */
function linearAt(rows: number[][], pos: number): number {
  let x = 0;
  for (let i = 0; i < rows.length; i++) {
    const nx = x + rows[i][0];
    if (pos <= nx || i === rows.length - 1) {
      if (i === 0) return rows[0][1];
      const span = rows[i][0];
      const u = span > 0 ? (pos - x) / span : 1;
      return rows[i - 1][1] + (rows[i][1] - rows[i - 1][1]) * Math.max(0, Math.min(1, u));
    }
    x = nx;
  }
  return 0;
}

/** The map's 0 .. 1 value of a spectrum amplitude 0 .. 4: log3(2 a + 1) / 2 on singles. */
function toMapLevel(a: number): number {
  const s = f32(f32(a * 2) + 1);
  const v = f32(Math.log(s) * INV_LN3_F) * f32(0.5);
  return f32(v >= 0 ? (v > 1 ? 1 : v) : 0);
}

/**
 * Delete the redundant points of a curve (TCustomMEnvelope 0x25f3a0 + 0x25f560): an inner point whose neighbours have its level (or
 * a pair of "hold" points) goes, unless a point at or next to it has the arp-break byte or a marker (decay / loop / sustain) on it;
 * the distance of a deleted point is added to the next kept one.
 */
function removeRedundant(rows: number[][], markers: readonly number[]): number[][] {
  const last = rows.length - 1;
  const del = new Uint8Array(rows.length);
  for (let i = 1; i <= last - 1; i++) {
    let prot = false;
    for (let j = i - 1; j <= i + 1 && !prot; j++) prot = rows[j][4] !== 0 || markers.includes(j);
    if (prot) continue;
    const y = rows[i][1];
    if (rows[i - 1][1] !== y) continue;
    if (rows[i][4] !== 0) continue;
    if (rows[i + 1][1] === y || (rows[i + 1][3] === 2 && rows[i][3] === 2)) del[i] = 1;
  }
  const out: number[][] = [];
  let carry = 0;
  for (let i = 0; i < rows.length; i++) {
    if (del[i]) carry += rows[i][0];
    else {
      const r = rows[i].slice();
      r[0] = r[0] + carry;
      carry = 0;
      out.push(r);
    }
  }
  return out;
}

/**
 * The shaping map of a spectrum as the tool builds it (0xf1f00 after the bins): every harmonic is a point `unit` apart (the first at
 * `unit`), followed by a closing point and one at the map's length; redundant points go; the amplitudes 0 .. 4 go through toMapLevel.
 */
export function padMapRaw(spectrum: Float32Array, unit: number, length = 1, markers: readonly number[] = [-1, -1, -1]): number[][] {
  let rows: number[][] = [];
  for (let i = 0; i < spectrum.length; i++) {
    const y = spectrum[i];
    rows.push([unit, y >= 0 ? (y > PAD_PEAK ? PAD_PEAK : y) : 0, 0, 0, 0, 0, 0]);
  }
  rows.push([unit, 0, 0, 0, 0, 0, 0]);
  addPointAt(rows, length, length, 0, 0);
  // the closing point at the length (the curve ends there: points beyond are cut)
  let end = findPointAt(rows, length);
  if (end < 0) end = addPointAt(rows, length, length, f32(linearAt(rows, length)), 0);
  if (end < rows.length - 1) rows.length = end + 1;
  rows = rows.length >= 3 ? removeRedundant(rows, markers) : rows;
  for (let i = 0; i < rows.length; i++) rows[i][1] = toMapLevel(rows[i][1]);
  return rows;
}

/**
 * The curve after FL stored it in the editor (a save / load round trip, 0x25c7e0): a curve whose first point starts later gets a
 * copy of that point at the same position (the fixed-length update of a mapping, 0x25f850), the distances are scaled to sum to the
 * length and the point kinds are set.
 */
export function padMapLoaded(tool: number[][], length = 1): number[][] {
  const rows = tool.map((r) => r.slice());
  if (rows.length && rows[0][0] > 0) addPointAt(rows, length, 0, rows[0][1], 0);
  let total = 0;
  for (const r of rows) total += r[0];
  if (total > 0) {
    const k = length / total;
    if (k !== 1) for (const r of rows) r[0] = r[0] * k;
  }
  for (let i = 0; i < rows.length; i++) rows[i][6] = i === 0 ? 0 : pointKind(rows[i][2], rows[i][3]);
  return rows;
}

/** The same in the form the state keeps (the first point at 0, like a loaded map's first point). */
export function padMap(spectrum: Float32Array, unit: number, length = 1, markers: readonly number[] = [-1, -1, -1]): number[][] {
  const rows = padMapLoaded(padMapRaw(spectrum, unit, length, markers), length);
  if (rows.length > 1 && rows[0][0] > 0 && rows[1][0] === 0) {
    rows[1][0] = rows[0][0];
    rows[0][0] = 0;
  }
  return rows;
}

/** The unit (x distance of one harmonic) of the edited map: the natural scale puts a harmonic octave 1/15 apart. */
export function padUnit(natural: boolean): number {
  return natural ? PAD_UNIT_NATURAL : PAD_UNIT_LINEAR;
}

/** Number of harmonics + 1 of a richness order (xi[3] of the state: harmonics = 2 ^ (order - 1) - 1; FL's slider allows 6 .. 16). */
export function padHarmonics(order: number): number {
  return 2 ** (Math.max(1, Math.min(16, Math.round(order) || 1)) - 1);
}

export interface PadSettings {
  bins: PadBins;
  width: number;
  normalize: boolean;
  window: OgEnv;
}

export function newPadSettings(): PadSettings {
  return { bins: newBins(), width: PAD_WIDTH_DEFAULT, normalize: true, window: defaultWindow() };
}

/** The whole tool: settings -> the shaping map written into the edited target (a copy of `base` with the new points). */
export function buildPadCurve(base: OgEnv, s: PadSettings, order: number, natural: boolean): OgEnv {
  const spec = padSpectrum(s.bins, prepareWindow(s.window), { width: s.width, normalize: s.normalize, n: padHarmonics(order) });
  return { ...base, t: 3, m: base.m.slice(), p: padMap(spec, padUnit(natural), 1, base.m.slice(2, 5)) };
}

export interface RandomPadOptions extends PadRandomOptions {
  /** Harmonics + 1 the tool works with (richness order of the state: padHarmonics(xi[3]); the generator may use fewer). */
  n: number;
  /** x distance of one harmonic of the edited map (padUnit). */
  unit: number;
}

/**
 * What the plugin's random preset generator does with the tool (0xf2c90 on a tool that was never opened): all settings reset (default
 * bins, width 500, loudness normalized, default window shape), then the width and both bin arrays randomized, then the map built.
 * `base` is the map being replaced (its markers and flags are kept).
 */
export function randomPadMap(base: OgEnv, rng: PadRng, o: RandomPadOptions): { curve: OgEnv; settings: PadSettings } {
  const settings = newPadSettings();
  settings.width = randomWidthValue(rng);
  randomizeBins(settings.bins, 3, rng, o);
  const spec = padSpectrum(settings.bins, prepareWindow(settings.window), { width: settings.width, normalize: settings.normalize, n: o.n });
  return { curve: { ...base, t: 3, m: base.m.slice(), p: padMap(spec, o.unit, 1, base.m.slice(2, 5)) }, settings };
}

