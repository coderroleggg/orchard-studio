// Mersenne Twister MT19937 (FL's random generator class in FPC_x64.dylib, 0x2879e0: the standard
// generator and tempering; FL seeds its global instance from the clock, each instance here starts
// from a fixed seed).

export class Mt19937 {
  private readonly mt = new Uint32Array(624);
  private mti = 625;

  constructor(seed: number) { this.seed(seed); }

  seed(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) {
      const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(p, 1812433253) + i) >>> 0;
    }
    this.mti = 624;
  }

  /** The next 32-bit output (unsigned). */
  next(): number {
    const mt = this.mt;
    if (this.mti >= 624) {
      let k = 0;
      for (; k < 624 - 397; k++) {
        const y = (mt[k] & 0x80000000) | (mt[k + 1] & 0x7fffffff);
        mt[k] = mt[k + 397] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      for (; k < 623; k++) {
        const y = (mt[k] & 0x80000000) | (mt[k + 1] & 0x7fffffff);
        mt[k] = mt[k + 397 - 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      const y = (mt[623] & 0x80000000) | (mt[0] & 0x7fffffff);
      mt[623] = mt[396] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      this.mti = 0;
    }
    let y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
}
