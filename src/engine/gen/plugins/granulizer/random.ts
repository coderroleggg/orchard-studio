// The Free Pascal runtime's Random (FL's plugins are Free Pascal binaries; Fruity Granulizer_x64.dylib
// 0x18b70 / 0x18c80, Randomize 0x21230): MT19937 seeded by init_genrand(RandSeed) on first use with
// RandSeed = time(NULL) (Randomize runs when FL loads the plugin library, so the stream differs per
// session), Random(n) = floor(n x genrand_int32 / 2^32). The state is global to the plugin's runtime (all
// instances share one stream, as in FL).

const N = 624;
const M = 397;

export class FpcRandom {
  private readonly mt = new Uint32Array(N);
  private mti = N + 1;
  private seed = -1;

  /** The stream of a freshly loaded plugin library; `epoch` is the clock in seconds (tests: the test host's --fixed-time). */
  reset(epoch?: number): void {
    this.seed = epoch === undefined ? -1 : epoch >>> 0;
    this.mti = N + 1;
  }

  private init(seed: number): void {
    const mt = this.mt;
    mt[0] = seed >>> 0;
    for (let i = 1; i < N; i++) {
      const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(p, 1812433253) + i) >>> 0;
    }
    this.mti = N;
  }

  private twist(): void {
    const mt = this.mt;
    let kk = 0;
    for (; kk < N - M; kk++) {
      const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
      mt[kk] = mt[kk + M] ^ (y >>> 1) ^ ((y & 1) !== 0 ? 0x9908b0df : 0);
    }
    for (; kk < N - 1; kk++) {
      const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
      mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ ((y & 1) !== 0 ? 0x9908b0df : 0);
    }
    const y = (mt[N - 1] & 0x80000000) | (mt[0] & 0x7fffffff);
    mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ ((y & 1) !== 0 ? 0x9908b0df : 0);
    this.mti = 0;
  }

  /** genrand_int32 (FL 0x18b70). */
  next32(): number {
    if (this.mti >= N + 1) this.init(this.seed < 0 ? Math.floor(Date.now() / 1000) >>> 0 : this.seed);
    if (this.mti >= N) this.twist();
    let y = this.mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** Random(n) for 0 < n < 2^31 (FL 0x18c80): floor(n x r / 2^32). */
  random(n: number): number {
    if (n <= 0) return 0;
    const r = this.next32();
    const rh = r >>> 16, rl = r & 0xffff;
    return Math.floor((n * rh + Math.floor((n * rl) / 65536)) / 65536);
  }
}
