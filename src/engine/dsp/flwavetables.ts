// FL Studio's shared plugin wavetables (TFruityPlugHost.WaveTables), 16384
// samples each, as FL builds them at startup: 0 sine, 1 triangle, 2 square,
// 3 saw (rising), 5 noise (Mersenne Twister seeded with 19650218, uniform
// -1..1). Controller LFOs read them with a 32-bit phase (index = phase >> 18).

export const WAVE_SIZE = 16384;

function build(): Float32Array[] {
  const N = WAVE_SIZE;
  const sine = new Float32Array(N), tri = new Float32Array(N), sq = new Float32Array(N), saw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    sine[i] = Math.sin((2 * i * Math.PI) / N);
    sq[i] = i < N / 2 ? 1 : -1;
    saw[i] = -1 + (2 * i) / N;
  }
  // triangle: rises -1..1 over the first half from index 3N/4, i.e. 0 at index 0, +1 at N/4
  for (let i = 0; i < N / 2; i++) tri[(i + (3 * N) / 4) % N] = -1 + (4 * i) / N;
  for (let i = N / 2; i < N; i++) tri[(i + (3 * N) / 4) % N] = 1 - (4 * (i - N / 2)) / N;
  const noise = new Float32Array(N);
  const mt = new MersenneTwister(19650218);
  for (let i = 0; i < N; i++) noise[i] = mt.next() * (1 / 4294967295) * 2 - 1;
  return [sine, tri, sq, saw, noise];
}

/** MT19937 (32-bit), as used by FL for its noise table. */
export class MersenneTwister {
  private mt = new Uint32Array(624);
  private i = 625;
  constructor(seed: number) {
    const mt = this.mt;
    mt[0] = seed >>> 0;
    for (let k = 1; k < 624; k++) {
      const s = mt[k - 1] ^ (mt[k - 1] >>> 30);
      mt[k] = (Math.imul(s, 1812433253) + k) >>> 0;
    }
    this.i = 624;
  }
  next(): number {
    const mt = this.mt;
    if (this.i >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.i = 0;
    }
    let y = mt[this.i++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
}

/** [sine, triangle, square, saw, noise] (the Peak Controller's LFO shapes, in its order). */
export const FL_WAVES: Float32Array[] = build();
