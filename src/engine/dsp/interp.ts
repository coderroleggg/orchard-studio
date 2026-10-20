// Sample interpolation kernels used by the sampler voices.

/** 4-point, 3rd-order Hermite (Catmull-Rom) interpolation. */
export function hermite4(xm1: number, x0: number, x1: number, x2: number, t: number): number {
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * t + c2) * t + c1) * t + x0;
}

/**
 * 6-point, 5th-order "optimal" style Hermite polynomial (Niemitalo's 6-point
 * 3rd-order Hermite generalisation). Slightly cleaner top end than 4-point.
 */
export function hermite6(
  ym2: number, ym1: number, y0: number, y1: number, y2: number, y3: number, x: number,
): number {
  // 6-point, 3rd-order Hermite (x-form), from "Polynomial Interpolators for
  // High-Quality Resampling of Oversampled Audio" (O. Niemitalo).
  const c0 = y0;
  const c1 = (1 / 12) * (ym2 - y2) + (2 / 3) * (y1 - ym1);
  const c2 = (5 / 4) * ym1 - (7 / 3) * y0 + (5 / 3) * y1 - (1 / 2) * y2 + (1 / 12) * y3 - (1 / 6) * ym2;
  const c3 = (1 / 12) * (ym2 - y3) + (7 / 12) * (y2 - ym1) + (4 / 3) * (y0 - y1);
  return ((c3 * x + c2) * x + c1) * x + c0;
}

/**
 * Windowed-sinc interpolator with a precomputed polyphase table. `taps` points
 * (even), `phases` fractional positions. Cutoff can be lowered when the read
 * increment is > 1 to avoid aliasing (pitching up).
 */
export class SincTable {
  readonly taps: number;
  readonly phases: number;
  readonly table: Float32Array;

  constructor(taps = 16, phases = 256) {
    this.taps = taps;
    this.phases = phases;
    this.table = new Float32Array((phases + 1) * taps);
    const half = taps / 2;
    for (let p = 0; p <= phases; p++) {
      const frac = p / phases;
      let sum = 0;
      for (let i = 0; i < taps; i++) {
        const x = i - half + 1 - frac; // distance from the tap to the read point
        const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        // Blackman-Harris window over [-half, half]
        const n = (x + half) / taps;
        const w = n <= 0 || n >= 1 ? 0 :
          0.35875 - 0.48829 * Math.cos(2 * Math.PI * n) + 0.14128 * Math.cos(4 * Math.PI * n) - 0.01168 * Math.cos(6 * Math.PI * n);
        const v = s * w;
        this.table[p * taps + i] = v;
        sum += v;
      }
      // normalise DC gain per phase
      for (let i = 0; i < taps; i++) this.table[p * taps + i] /= sum;
    }
  }

  /** Interpolate `data` at fractional index `pos` (no bounds wrap, zero outside). */
  read(data: Float32Array, pos: number): number {
    const ip = Math.floor(pos);
    const frac = pos - ip;
    const p = Math.round(frac * this.phases);
    const half = this.taps / 2;
    const base = p * this.taps;
    let acc = 0;
    const start = ip - half + 1;
    const n = data.length;
    if (start >= 0 && start + this.taps <= n) {
      for (let i = 0; i < this.taps; i++) acc += data[start + i] * this.table[base + i];
    } else {
      for (let i = 0; i < this.taps; i++) {
        const j = start + i;
        if (j >= 0 && j < n) acc += data[j] * this.table[base + i];
      }
    }
    return acc;
  }
}
