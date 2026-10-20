// Free Pascal's System.Random as Sytrus calls it for its random mappings
// (genrand_MT19937 0x15d60, Random 0x15f10): a Mersenne Twister seeded from
// RandSeed on the first call. FL randomizes RandSeed when it loads (renders
// of a preset with random mappings differ from run to run, measured with the
// test host), so each instance starts from a random RandSeed; FL keeps one
// generator per process, ours is per instance.

const N = 624, M = 397;

export class FpcRandom {
  private readonly mt = new Int32Array(N);
  private mti = N + 1;
  private randSeed: number;
  private oldRandSeed = 0;

  constructor(seed?: number) {
    this.randSeed = seed ?? (Math.random() * 4294967296) | 0;
  }

  private seed(s: number): void {
    const mt = this.mt;
    mt[0] = s;
    for (let i = 1; i < N; i++) {
      const p = mt[i - 1];
      mt[i] = (Math.imul(1812433253, p ^ (p >>> 30)) + i) | 0;
    }
    this.mti = N;
  }

  /** genrand_MT19937: next 32-bit value (unsigned). */
  next(): number {
    const mt = this.mt;
    if (this.randSeed !== this.oldRandSeed || this.mti >= N + 1) {
      this.seed(this.randSeed);
      this.randSeed = ~this.randSeed;
      this.oldRandSeed = this.randSeed;
    }
    if (this.mti >= N) {
      let kk = 0, y: number;
      for (; kk < N - M; kk++) {
        y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      y = (mt[N - 1] & 0x80000000) | (mt[0] & 0x7fffffff);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      this.mti = 0;
    }
    let y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** Random: [0, 1) with 32-bit resolution. */
  random(): number {
    return this.next() * 2.3283064365386963e-10;
  }
}
