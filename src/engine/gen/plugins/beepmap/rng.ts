// BeepMap (FL: BeepMap): the Free Pascal runtime's Random(), which BeepMap uses
// for the start phases of its sine bank (TriggerVoice: two draws per bitmap
// row, Random(0x1000000) << 8, the second one only with Widen). It is FPC
// 3.2's genrand_MT19937 (BeepMap_x64.dylib 0x16d30) with the RTL's RandSeed /
// OldRandSeed bookkeeping, and Random(l) = (l * genrand) >> 32 (0x16e40).
//
// FL seeds it once per process with time(NULL) (Randomize at library load), and
// the generator is shared by every BeepMap in the process. Here it is shared by
// every BeepMap of the audio engine and starts from a fixed seed (renders repeat
// exactly); seedBeepMapRandom() sets the seed (the test host's --fixed-time T
// gives FL's sequence for seed T). Same code as the other FPC plugins' ports,
// but a stream of its own (every FL plugin library has its own RTL state).

const N = 624;

class FpcRandom {
  private readonly mt = new Uint32Array(N);
  private mti = N + 1;
  private randSeed = 0;
  private oldRandSeed = 0;

  seed(s: number): void {
    this.randSeed = s >>> 0;
    this.oldRandSeed = 0;
    this.mti = N + 1;
  }

  private sgenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) mt[i] = (Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i) >>> 0;
    this.mti = N;
  }

  private generate(): void {
    const mt = this.mt;
    let y: number;
    for (let kk = 0; kk < 227; kk++) {
      y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
      mt[kk] = mt[kk + 397] ^ (y >>> 1) ^ (mt[kk + 1] & 1 ? 0x9908b0df : 0);
    }
    for (let kk = 227; kk < 623; kk++) {
      y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
      mt[kk] = mt[kk - 227] ^ (y >>> 1) ^ (mt[kk + 1] & 1 ? 0x9908b0df : 0);
    }
    y = (mt[623] & 0x80000000) | (mt[0] & 0x7fffffff);
    mt[623] = mt[396] ^ (y >>> 1) ^ (mt[0] & 1 ? 0x9908b0df : 0);
    this.mti = 0;
  }

  /** genrand_MT19937: a 32-bit unsigned value. */
  next(): number {
    let i = this.mti;
    this.mti = i + 1;
    if (this.randSeed !== this.oldRandSeed || i >= N + 1) {
      this.sgenrand(this.randSeed);
      this.randSeed = ~this.randSeed >>> 0;
      this.oldRandSeed = this.randSeed;
      i = N;
    }
    if (i === N) {
      this.generate();
      i = 0;
      this.mti = 1;
    }
    let y = this.mt[i];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** FPC's Random(l) for 0 <= l < 2^31: floor(l * genrand / 2^32), exactly. */
  random(l: number): number {
    const g = this.next();
    const hi = l * (g >>> 16), lo = l * (g & 0xffff); // both < 2^47: exact
    const q1 = Math.floor(hi / 65536);
    return q1 + Math.floor(((hi - q1 * 65536) * 65536 + lo) / 4294967296);
  }
}

/** The generator every BeepMap instance draws from (FL: one per process). */
export const rng = new FpcRandom();
rng.seed(1700000000);

/** Restart BeepMap's random generator with RandSeed = seed (FL: time(NULL) at start-up). */
export function seedBeepMapRandom(seed: number): void {
  rng.seed(seed);
}
