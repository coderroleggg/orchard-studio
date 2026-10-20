// In-place iterative radix-2 complex FFT.

export class FFT {
  readonly n: number;
  private cos: Float64Array;
  private sin: Float64Array;
  private rev: Uint32Array;

  constructor(n: number) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** Forward transform (inverse when `inverse`, unscaled). */
  transform(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step], wi = sgn * this.sin[k * step];
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

const cache = new Map<number, FFT>();
export function getFFT(n: number): FFT {
  let f = cache.get(n);
  if (!f) { f = new FFT(n); cache.set(n, f); }
  return f;
}
