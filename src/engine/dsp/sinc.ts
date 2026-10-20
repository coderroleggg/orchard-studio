// Windowed-sinc interpolation with band limiting for pitch-up playback.
// "N-point sinc" uses N/2 zero crossings on each side of the read position.

export interface SincKernel {
  readonly points: number;
  /** Interpolate `data` at fractional `pos`; `inc` > 1 lowers the cutoff to avoid aliasing. */
  read(data: Float32Array, pos: number, inc: number): number;
}

const RES = 256; // table points per zero crossing

class WindowedSinc implements SincKernel {
  readonly points: number;
  private half: number;
  private table: Float32Array;

  constructor(points: number) {
    this.points = points;
    this.half = points / 2;
    const n = Math.ceil(this.half * RES) + 2;
    this.table = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i / RES;
      if (x >= this.half) { this.table[i] = 0; continue; }
      const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      // Blackman-Harris window over [-half, half]
      const u = 0.5 + x / (2 * this.half);
      const w = 0.35875 - 0.48829 * Math.cos(2 * Math.PI * u) + 0.14128 * Math.cos(4 * Math.PI * u) - 0.01168 * Math.cos(6 * Math.PI * u);
      this.table[i] = s * w;
    }
  }

  private k(x: number): number {
    const ax = (x < 0 ? -x : x) * RES;
    const i = ax | 0;
    if (i >= this.table.length - 1) return 0;
    const f = ax - i;
    return this.table[i] + (this.table[i + 1] - this.table[i]) * f;
  }

  read(data: Float32Array, pos: number, inc: number): number {
    const scale = inc > 1 ? (inc < 6 ? inc : 6) : 1;
    const reach = this.half * scale;
    const j0 = Math.ceil(pos - reach), j1 = Math.floor(pos + reach);
    const n = data.length;
    const inv = 1 / scale;
    let acc = 0, norm = 0;
    for (let j = j0; j <= j1; j++) {
      const w = this.k((j - pos) * inv);
      norm += w;
      if (j >= 0 && j < n) acc += data[j] * w;
    }
    return norm !== 0 ? acc / norm : 0;
  }
}

const cache = new Map<number, SincKernel>();

export function getSincKernel(points: number): SincKernel {
  let k = cache.get(points);
  if (!k) {
    k = new WindowedSinc(points);
    cache.set(points, k);
  }
  return k;
}

/** Offline high-quality resampling (used to pre-resample samples to the engine rate). */
export function resampleBuffer(data: Float32Array, fromRate: number, toRate: number, points = 64): Float32Array {
  if (fromRate === toRate) return data;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.round(data.length / ratio));
  const out = new Float32Array(outLen);
  const k = getSincKernel(points);
  for (let i = 0; i < outLen; i++) out[i] = k.read(data, i * ratio, ratio);
  return out;
}
