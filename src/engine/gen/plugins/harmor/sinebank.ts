// Harmor's sine bank (FL 2026 Harmor_x64, arm64; render 0x433000, refresh
// 0x4326c0 / 0x432460 / 0x432370 / 0x432540, activation 0x432c30, slot swap
// 0x432930, compaction 0x432cf0, activity check 0x5bd4, kernels 0x5b34 /
// 0x5a8c, lane sum 0x59ac, phase advance 0x432f60). One bank per voice: up to
// 520 oscillators (4 sub-harmonic slots + 516 harmonics) run as recursive
// float32 sine oscillators, y' = c*y - y1 with c = 2 cos(w), in groups of 8
// lanes. Each lane's amplitude glides to its target with a per-sample one-pole
// (amp = target + smooth*(amp - target), applied after the sample is output).
// Only active slots are rendered: an oscillator is activated (moved to the end
// of the active range) when its target rises above -96 dB, and every 512
// samples lanes whose amplitude and target fell below 2^-24 are compacted out.
// Phases are tracked in double (cycles) and each oscillator is re-synced from
// its phase (float32 sine of the phase, FL's IPP sin) every round(f*8192)
// samples and whenever its frequency changes. Output order (which oscillator
// sits in which lane) follows FL's slot moves, so the float32 sums match.

const TINY = 5.960464477539063e-8; // 2^-24: activity threshold (0x5bd4)
const ACT = 1.5848931980133057e-5; // 0x3784f354: -96 dB activation threshold
const TWO_PI = 6.283185307179586;
const f32 = Math.fround;

/** Float32 sine of `n` phases (radians, float32) from src into dst (FL: ippsSin_32f_A21 / A24). */
export type Sin32 = (src: Float32Array, dst: Float32Array, n: number, srcOff?: number, dstOff?: number) => void;

export class SineBank {
  /** Oscillator count (FL +0x8, a multiple of 8, <= cap). */
  count = 0;
  /** Active slot count (+0x10) and groups to render (+0x14 = ceil(active / 8)). */
  active = 0;
  groups = 0;
  /** Lane data, 8 floats per field per group (FL's 256-byte groups). */
  readonly amp: Float32Array;
  readonly y: Float32Array;
  readonly y1: Float32Array;
  readonly coef: Float32Array;
  readonly target: Float32Array;
  readonly smooth: Float32Array;
  /** Lane activity mask (-1 / 0, FL +0xc0) and oscillator index per lane (+0xe0). */
  readonly mask: Int32Array;
  readonly lane: Int32Array;
  /** Per oscillator: refresh countdown (+0x30), coefficient dirty flag (+0x38), slot of the oscillator (+0x40). */
  readonly countdown: Int32Array;
  readonly dirty: Int32Array;
  readonly slot: Int32Array;
  /** Per oscillator: phase in cycles (+0xb8) and frequency in cycles per sample (+0xc0), double. */
  readonly phase: Float64Array;
  readonly freq: Float64Array;
  /** Per oscillator amplitude targets the voice writes (+0xc8). */
  readonly amps: Float32Array;
  /** Samples until the next activity check (+0x80) and "lanes went silent" flag (+0x7c). */
  check = 512;
  private silent = 0;
  /** Jump amplitudes to their targets before the next render (+0x78), unless `noSnap` (+0x4d). */
  snap = false;
  noSnap = false;
  /** Refresh accuracy: 0 = FL's ippsSin_32f_A21, >= 1 = A24 (+0x48), and the "zero all countdowns" level (>= 2). */
  precision = 0;
  /** 4-lane accumulator for one render call (FL +0xa0). */
  private acc: Float32Array;
  private scratchPh: Float64Array;
  private scratchIn: Float32Array;
  private scratchOut: Float32Array;
  private sinA21: Sin32;
  private sinA24: Sin32;

  constructor(cap: number, maxBlock: number, sinA21: Sin32, sinA24: Sin32) {
    const lanes = Math.ceil(cap / 8) * 8;
    this.amp = new Float32Array(lanes);
    this.y = new Float32Array(lanes);
    this.y1 = new Float32Array(lanes);
    this.coef = new Float32Array(lanes);
    this.target = new Float32Array(lanes);
    this.smooth = new Float32Array(lanes);
    this.mask = new Int32Array(lanes);
    this.lane = new Int32Array(lanes);
    this.countdown = new Int32Array(lanes);
    this.dirty = new Int32Array(lanes);
    this.slot = new Int32Array(lanes);
    this.phase = new Float64Array(lanes);
    this.freq = new Float64Array(lanes);
    this.amps = new Float32Array(lanes);
    this.acc = new Float32Array(maxBlock * 4);
    this.scratchPh = new Float64Array(lanes * 3);
    this.scratchIn = new Float32Array(lanes * 3);
    this.scratchOut = new Float32Array(lanes * 3);
    this.sinA21 = sinA21;
    this.sinA24 = sinA24;
    for (let i = 0; i < lanes; i++) { this.slot[i] = i; this.lane[i] = i; this.mask[i] = -1; }
  }

  /** Clear for a new voice (FL creates the bank with zeroed lanes and an identity slot map). */
  reset(): void {
    this.count = 0; this.active = 0; this.groups = 0; this.check = 512; this.silent = 0; this.snap = false;
    this.amp.fill(0); this.y.fill(0); this.y1.fill(0); this.coef.fill(0); this.target.fill(0); this.smooth.fill(0);
    this.countdown.fill(0); this.dirty.fill(0); this.phase.fill(0); this.freq.fill(0); this.amps.fill(0);
    for (let i = 0; i < this.slot.length; i++) { this.slot[i] = i; this.lane[i] = i; this.mask[i] = -1; }
  }

  /** Set the oscillator count (multiple of 8). */
  setCount(n: number): void {
    this.count = n;
  }

  /** Force every oscillator to re-sync phase and coefficient on the next render (0x432250). */
  invalidate(): void {
    for (let i = 0; i < this.count; i++) { this.countdown[i] = 0; this.dirty[i] = 1; }
  }

  /** Swap two slots (0x432930): oscillator map entries, all lane fields; slot b ends cleared and inactive, a inactive. */
  private swap(a: number, b: number): void {
    const oa = this.lane[a], ob = this.lane[b];
    const t = this.slot[oa]; this.slot[oa] = this.slot[ob]; this.slot[ob] = t;
    const sw = (arr: Float32Array | Int32Array) => { const x = arr[a]; arr[a] = arr[b]; arr[b] = x; };
    sw(this.amp); sw(this.y); sw(this.y1); sw(this.coef); sw(this.target); sw(this.smooth); sw(this.mask); sw(this.lane);
    this.amp[b] = 0; this.y[b] = 0; this.y1[b] = 0; this.mask[b] = 0;
    this.mask[a] = 0;
  }

  /** Activate oscillator `osc` (0x432c30): move it to slot `active`, mark it active, schedule its re-sync. */
  private activate(osc: number): void {
    const s = this.slot[osc];
    if (s !== this.active) this.swap(s, this.active);
    this.mask[this.active] = -1;
    this.countdown[osc] = 0;
    this.active++;
    this.groups = (this.active + 7) >>> 3;
  }

  /** Targets and smoothing coefficients from the voice (0x432100); activates oscillators that became audible. */
  setTargets(amps: Float32Array, smooth: Float32Array | null): void {
    for (let i = 0; i < this.count; i++) {
      const s = this.slot[i];
      this.target[s] = amps[i];
      if (smooth) this.smooth[s] = smooth[i];
      if (s >= this.active && Math.abs(amps[i]) >= ACT) this.activate(i);
    }
  }

  /** Compact inactive lanes out of the active range (0x432cf0). */
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

  /** Lane activity check of one group (0x5bd4): new masks; returns whether a lane went silent. */
  private checkGroup(g: number): boolean {
    let went = false;
    for (let l = g * 8, e = l + 8; l < e; l++) {
      const on = Math.abs(this.amp[l]) >= TINY || Math.abs(this.target[l]) >= TINY ? -1 : 0;
      if (this.mask[l] !== 0 && on === 0) went = true;
      this.mask[l] = on;
    }
    return went;
  }

  /** Re-sync oscillators whose countdown ran out and update changed coefficients (0x4326c0). */
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
        this.countdown[osc] = roundEven(this.freq[osc] * 8192);
      }
    }
  }

  /**
   * Render `n` samples (n <= maxBlock) into out (overwritten), then advance the
   * phases (0x433000).
   */
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
    // phase += freq * n (0x432f60, double)
    const fn = n;
    for (let i = 0; i < this.count; i++) this.phase[i] = this.phase[i] + this.freq[i] * fn;
  }

  /** Amplitudes jump to their targets (render with +0x78 set). */
  private snapAll(): void {
    for (let i = 0; i < this.count; i++) {
      const s = this.slot[i];
      this.amp[s] = this.target[s];
    }
  }

  /** One group of 8 lanes for n samples (0x5b34 first group writes, 0x5a8c accumulates). */
  private kernel(g: number, acc: Float32Array, n: number, add: boolean): void {
    const b = g * 8;
    const amp = this.amp, y = this.y, y1 = this.y1, c = this.coef, tg = this.target, sm = this.smooth;
    for (let l = 0; l < 4; l++) {
      const la = b + l, lb = b + l + 4;
      let aa = amp[la], ab = amp[lb], ya = y[la], yb = y[lb], pa = y1[la], pb = y1[lb];
      const ca = c[la], cb = c[lb], ta = tg[la], tb = tg[lb], sa = sm[la], sb = sm[lb];
      // amplitudes that already sit on their targets stay there exactly (t + s * (t - t) = t): skip the glide
      const still = aa === ta && ab === tb && (aa !== 0 || Object.is(aa, ta)) && (ab !== 0 || Object.is(ab, tb));
      if (still) {
        if (add) {
          for (let i = 0, o = l; i < n; i++, o += 4) {
            const na = f32(f32(ca * ya) - pa);
            const nb = f32(f32(cb * yb) - pb);
            acc[o] = f32(f32(f32(aa * na) + acc[o]) + f32(ab * nb));
            pa = ya; ya = na; pb = yb; yb = nb;
          }
        } else {
          for (let i = 0, o = l; i < n; i++, o += 4) {
            const na = f32(f32(ca * ya) - pa);
            const nb = f32(f32(cb * yb) - pb);
            acc[o] = f32(f32(aa * na) + f32(ab * nb));
            pa = ya; ya = na; pb = yb; yb = nb;
          }
        }
      } else if (add) {
        for (let i = 0, o = l; i < n; i++, o += 4) {
          const na = f32(f32(ca * ya) - pa);
          const nb = f32(f32(cb * yb) - pb);
          acc[o] = f32(f32(f32(aa * na) + acc[o]) + f32(ab * nb));
          aa = f32(ta + f32(sa * f32(aa - ta)));
          ab = f32(tb + f32(sb * f32(ab - tb)));
          pa = ya; ya = na; pb = yb; yb = nb;
        }
      } else {
        for (let i = 0, o = l; i < n; i++, o += 4) {
          const na = f32(f32(ca * ya) - pa);
          const nb = f32(f32(cb * yb) - pb);
          acc[o] = f32(f32(aa * na) + f32(ab * nb));
          aa = f32(ta + f32(sa * f32(aa - ta)));
          ab = f32(tb + f32(sb * f32(ab - tb)));
          pa = ya; ya = na; pb = yb; yb = nb;
        }
      }
      amp[la] = aa; amp[lb] = ab; y[la] = ya; y[lb] = yb; y1[la] = pa; y1[lb] = pb;
    }
  }
}

/** Round half to even (ARM frintx in the default rounding mode), then to int32. */
export function roundEven(x: number): number {
  const r = Math.round(x);
  return (r - x === 0.5 && r % 2 !== 0 ? r - 1 : r) | 0;
}
