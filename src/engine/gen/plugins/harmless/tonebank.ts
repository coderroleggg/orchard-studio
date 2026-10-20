// Harmless's sine bank: FL's DSP_FastToneBank (TFastToneBank, Harmless_x64.dylib
// 0x1fa040..0x1fb840). The rendering core (refresh 0x1fa9e0, slot swap
// 0x1fac30, activation 0x1faf30, compaction 0x1faff0, render 0x1fb250 and its
// kernels) is instruction for instruction the same unit as Harmor's (0x4326c0,
// 0x432930, 0x432c30, 0x432cf0, 0x433000), whose port it follows
// (../harmor/sinebank.ts); the set-up differs: 528 oscillators (4 special slots
// + 524 harmonics), band limiting gains (0x1fa450), the lane reset 0x1fa2f0 /
// kernel 0x4dd0 (only amplitude, smoothing, mask and lane index are reset),
// targets 0x1fa580 and phase alignment of new oscillators 0x1fb110.
//
// Oscillators are recursive float32 sines (y' = c*y - y1, c = 2 cos w) in groups
// of 8 lanes; each lane's amplitude glides to its target per sample
// (amp = target + smooth * (amp - target)); phases are tracked in double cycles
// and an oscillator is re-synced from them every round(f * 8192) samples or when
// its frequency changes.

import { f32, rint } from './fl';
import type { Sin32 } from '../harmor/sinebank';

export const BANK_LANES = 528;

/** float32 2^-24: activity threshold of the lane check (0x5bd4). */
const TINY = 5.960464477539063e-8;
const TWO_PI = 6.283185307179586;

export class ToneBank {
  /** TB+0x8 oscillator count (multiple of 8), TB+0x10 active slots, TB+0x14 groups to render. */
  count = 0;
  active = 0;
  groups = 0;
  /** Lane fields (FL's 256-byte groups: +0x00 amp, y, y1, coef, +0x80 target, +0xa0 smooth, +0xc0 mask, +0xe0 lane). */
  readonly amp = new Float32Array(BANK_LANES);
  readonly y = new Float32Array(BANK_LANES);
  readonly y1 = new Float32Array(BANK_LANES);
  readonly coef = new Float32Array(BANK_LANES);
  readonly target = new Float32Array(BANK_LANES);
  readonly smooth = new Float32Array(BANK_LANES);
  readonly mask = new Int32Array(BANK_LANES);
  readonly lane = new Int32Array(BANK_LANES);
  /** Per oscillator: TB+0x30 countdown, +0x38 dirty, +0x40 slot. */
  readonly countdown = new Int32Array(BANK_LANES);
  readonly dirty = new Int32Array(BANK_LANES);
  readonly slot = new Int32Array(BANK_LANES);
  /** Per oscillator: TB+0xb8 phase (cycles), +0xc0 frequency (cycles per sample), double. */
  readonly phase = new Float64Array(BANK_LANES);
  readonly freq = new Float64Array(BANK_LANES);
  /** TB+0xc8 amplitude targets as the voice set them (before band gains). */
  readonly amps = new Float32Array(BANK_LANES);
  /** TB+0x28 band-limiting gains (when TB+0x79). */
  readonly band = new Float32Array(BANK_LANES);
  /** TB+0x58.. band limits: low fade [lo0, lo1], high fade [hi0, hi1] in cycles per sample, inverse widths. */
  lo1 = 0; lo0 = 0; loK = 0; hi0 = 0; hi1 = 0; hiK = 0;
  /** TB+0x79 band limiting on. */
  bandOn = false;
  /** TB+0x70: the last oscillator's phase when the bank was (re)phased (0x1fb110). */
  phase70 = 0;
  /** TB+0x80 samples to the next activity check, TB+0x7c lanes went silent, TB+0x78 snap, TB+0x4c no snap. */
  check = 0;
  private silent = 0;
  snap = false;
  /** TB+0x4d: set by the constructor (0x1f9e30): FL's banks never snap. */
  noSnap = true;
  /** TB+0x48: 0 = ippsSin_32f_A21, >= 1 A24, >= 2 also zero every countdown on refresh. */
  precision = 0;
  /** Activation threshold (FL's global 0x2cf0b8: -96 dB at quality 0, 2^-24 otherwise). */
  act = 1.5848931980133057e-5;
  private readonly acc: Float32Array;
  private readonly scratchPh = new Float64Array(BANK_LANES * 3);
  private readonly scratchIn = new Float32Array(BANK_LANES * 3);
  private readonly scratchOut = new Float32Array(BANK_LANES * 3);
  private readonly tmp = new Float64Array(BANK_LANES);

  constructor(maxBlock: number, private readonly sinA21: Sin32, private readonly sinA24: Sin32) {
    this.acc = new Float32Array(maxBlock * 4);
    for (let i = 0; i < BANK_LANES; i++) { this.slot[i] = i; this.lane[i] = i; }
  }

  /** 0x1fa450: band limits (cycles per sample); band limiting is on when lo1 > 0 or hi0 < 1. */
  setBand(lo1: number, lo0: number, hi0: number, hi1: number): void {
    this.lo1 = f32(lo1); this.lo0 = f32(lo0);
    let k = f32(this.lo1 - this.lo0);
    if (k !== 0) k = f32(1 / k);
    this.loK = k;
    this.hi0 = f32(hi0); this.hi1 = f32(hi1);
    k = f32(this.hi1 - this.hi0);
    if (k !== 0) k = f32(1 / k);
    this.hiK = k;
    this.bandOn = this.lo1 > 0 || !(this.hi0 >= 1);
  }

  /** 0x1fa2f0 (layout A): lanes cleared (amplitude, mask), smoothing set, identity slot map, count 8. */
  reset(smooth: number): void {
    const s = f32(smooth);
    for (let i = 0; i < BANK_LANES; i++) {
      this.amp[i] = 0; this.smooth[i] = s; this.mask[i] = 0; this.lane[i] = i; this.slot[i] = i;
    }
    this.snap = true;
    this.silent = 0;
    this.check = 0;
    this.setCount(5);
  }

  /** 0x1fa540. */
  setCount(n: number): void {
    this.count = (n + 7) & ~7;
    this.active = 0;
    this.groups = 0;
  }

  /** Swap two lane slots (0x1fac30). */
  private swap(a: number, b: number): void {
    const oa = this.lane[a], ob = this.lane[b];
    const t = this.slot[oa]; this.slot[oa] = this.slot[ob]; this.slot[ob] = t;
    const sw = (arr: Float32Array | Int32Array) => { const x = arr[a]; arr[a] = arr[b]; arr[b] = x; };
    sw(this.amp); sw(this.y); sw(this.y1); sw(this.coef); sw(this.target); sw(this.smooth); sw(this.mask); sw(this.lane);
    this.amp[b] = 0; this.y[b] = 0; this.y1[b] = 0; this.mask[b] = 0;
    this.mask[a] = 0;
  }

  /** Activate oscillator `osc` (0x1faf30). */
  activate(osc: number): void {
    const s = this.slot[osc];
    if (s !== this.active) this.swap(s, this.active);
    this.mask[this.active] = -1;
    this.countdown[osc] = 0;
    this.active++;
    this.groups = (this.active + 7) >>> 3;
  }

  /** Set oscillator `osc`'s lane target, activating it when it becomes audible (FL's inline code in 0x1fa580 / the voice). */
  setTarget(osc: number, v: number): void {
    const s = this.slot[osc];
    this.target[s] = v;
    if (s >= this.active && Math.abs(v) >= this.act) this.activate(osc);
  }

  /** 0x1fa580: amps -> TB+0xc8, times the band gains (in place on `amps`), lane targets. */
  setTargets(amps: Float32Array): void {
    const n = this.count;
    for (let i = 0; i < n; i++) this.amps[i] = amps[i];
    if (this.bandOn) for (let i = 0; i < n; i++) amps[i] = f32(amps[i] * this.band[i]);
    for (let i = 0; i < n; i++) this.setTarget(i, amps[i]);
  }

  /** The band gain of oscillator i from its frequency (the voice's frequency update). */
  bandGain(i: number): void {
    const f = f32(this.freq[i]);
    let g: number;
    if (f > this.hi0) {
      if (f > this.hi1) g = 0;
      else { const x = f32(1 - f32(f32(f - this.hi0) * this.hiK)); g = f32(x * x); }
    } else if (f < this.lo1) {
      if (f < this.lo0) g = 0;
      else { const x = f32(1 - f32(f32(this.lo1 - f) * this.loK)); g = f32(x * x); }
    } else g = 1;
    this.band[i] = g;
  }

  /** 0x1fb110: align the phases of oscillators k+1..count-1 that just became part of the bank. */
  alignNew(k: number): void {
    const fk = this.freq[k];
    if (!(fk > 0)) return;
    const m = this.count - (k + 1);
    const t = (this.phase[k] - this.phase70) / fk;
    for (let i = 0; i < m; i++) this.tmp[i] = this.freq[k + 1 + i] * t;
    this.phase70 = this.phase[this.count - 1];
    for (let i = 0; i < m; i++) this.phase[k + 1 + i] = this.phase[k + 1 + i] + this.tmp[i];
  }

  /** Compact inactive lanes out of the active range (0x1faff0). */
  private compact(): void {
    for (let i = 0; i < this.active; i++) {
      if (this.mask[i] !== 0) continue;
      this.active--;
      while (this.active > i && this.mask[this.active] === 0) this.active--;
      if (this.active > i) {
        this.swap(i, this.active);
        this.mask[this.active] = -1;
      }
    }
    this.groups = (this.active + 7) >>> 3;
    this.silent = 0;
  }

  /** Lane activity check of one group (kernel 0x5bd4). */
  private checkGroup(g: number): boolean {
    let went = false;
    for (let l = g * 8, e = l + 8; l < e; l++) {
      const on = Math.abs(this.amp[l]) >= TINY || Math.abs(this.target[l]) >= TINY ? -1 : 0;
      if (this.mask[l] !== 0 && on === 0) went = true;
      this.mask[l] = on;
    }
    return went;
  }

  /** Re-sync oscillators whose countdown ran out; recompute changed coefficients (0x1fa9e0). */
  private refresh(n: number): void {
    if (this.precision >= 2) this.countdown.fill(0, 0, this.count);
    const lanes = this.groups * 8;
    const ph = this.scratchPh;
    let k = 0;
    for (let j = 0; j < lanes; j++) {
      const osc = this.lane[j];
      this.countdown[osc] -= n;
      if (this.countdown[osc] > 0) continue;
      const f = this.freq[osc], p = this.phase[osc];
      const a = p - f;
      ph[k] = a; ph[k + 1] = a - f; k += 2;
      if (this.dirty[osc] > 0) ph[k++] = f + 0.25;
    }
    if (k > 0) {
      const src = this.scratchIn, dst = this.scratchOut;
      for (let i = 0; i < k; i++) {
        const d = ph[i];
        src[i] = f32((d - Math.trunc(d)) * TWO_PI);
      }
      (this.precision >= 1 ? this.sinA24 : this.sinA21)(src, dst, k);
      let q = 0;
      for (let j = 0; j < lanes; j++) {
        const osc = this.lane[j];
        if (this.countdown[osc] > 0) continue;
        this.y[j] = dst[q]; this.y1[j] = dst[q + 1]; q += 2;
        if (this.dirty[osc] > 0) { this.coef[j] = f32(2 * dst[q]); q++; this.dirty[osc] = 0; }
        this.countdown[osc] = rint(this.freq[osc] * 8192) | 0;
      }
    }
  }

  /** Render n samples (overwrite) at out[outOff..], then advance the phases (0x1fb250). */
  render(out: Float32Array, n: number, outOff = 0): void {
    this.check -= n;
    if (this.check <= 0) {
      this.check = 512;
      for (let g = 0; g < this.groups; g++) if (this.checkGroup(g)) this.silent = 1;
      if (this.silent) this.compact();
    }
    if (this.groups <= 0) {
      if (this.snap) { this.snap = false; if (!this.noSnap) this.snapAll(); }
      out.fill(0, outOff, outOff + n);
    } else {
      this.refresh(n);
      if (this.snap) { this.snap = false; if (!this.noSnap) this.snapAll(); }
      const acc = this.acc;
      this.kernel(0, acc, n, false);
      for (let g = 1; g < this.groups; g++) this.kernel(g, acc, n, true);
      for (let i = 0, a = 0; i < n; i++, a += 4) {
        out[outOff + i] = f32(f32(f32(acc[a] + acc[a + 1]) + acc[a + 2]) + acc[a + 3]);
      }
    }
    for (let i = 0; i < this.count; i++) this.phase[i] = this.phase[i] + this.freq[i] * n;
  }

  private snapAll(): void {
    for (let i = 0; i < this.count; i++) {
      const s = this.slot[i];
      this.amp[s] = this.target[s];
    }
  }

  /** One group of 8 lanes (kernels 0x5b34 first group, 0x5a8c accumulate). */
  private kernel(g: number, acc: Float32Array, n: number, add: boolean): void {
    const b = g * 8;
    const amp = this.amp, y = this.y, y1 = this.y1, c = this.coef, tg = this.target, sm = this.smooth;
    for (let l = 0; l < 4; l++) {
      const la = b + l, lb = b + l + 4;
      let aa = amp[la], ab = amp[lb], ya = y[la], yb = y[lb], pa = y1[la], pb = y1[lb];
      const ca = c[la], cb = c[lb], ta = tg[la], tb = tg[lb], sa = sm[la], sb = sm[lb];
      for (let i = 0, o = l; i < n; i++, o += 4) {
        const na = f32(f32(ca * ya) - pa);
        const nb = f32(f32(cb * yb) - pb);
        if (add) acc[o] = f32(f32(f32(aa * na) + acc[o]) + f32(ab * nb));
        else acc[o] = f32(f32(aa * na) + f32(ab * nb));
        aa = f32(ta + f32(sa * f32(aa - ta)));
        ab = f32(tb + f32(sb * f32(ab - tb)));
        pa = ya; ya = na; pb = yb; yb = nb;
      }
      amp[la] = aa; amp[lb] = ab; y[la] = ya; y[lb] = yb; y1[la] = pa; y1[lb] = pb;
    }
  }
}
