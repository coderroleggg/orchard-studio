// Free Pascal's Random (FL's Plucked! is an FPC plugin; its RTL is linked into
// Plucked!_x64.dylib, FL 2026 arm64: genrand_MT19937 0x18070, sgenrand
// 0x17e50, the twist 0x17ed0, Random: Double 0x18220, Randomize 0x20230).
// MT19937 with FPC's reseeding rule: whenever RandSeed differs from the seed
// used last time, the generator is reseeded from RandSeed and RandSeed is
// inverted (FPC's "not RandSeed"). Randomize sets RandSeed to time(NULL)
// once, when the plugin library loads, so FL's noise differs per FL session
// and is shared by all Plucked! instances (one stream per process).

const N = 624;
const mt = new Int32Array(N);
let mti = N + 1;
let randSeed = 0;
let oldRandSeed = 0;
let seeded = false;

function sgenrand(seed: number): void {
  mt[0] = seed | 0;
  for (let i = 1; i < N; i++) {
    const p = mt[i - 1];
    mt[i] = (Math.imul(1812433253, p ^ (p >>> 30)) + i) | 0;
  }
  mti = N;
}

function twist(): void {
  const mag = (y: number) => (y & 1 ? 0x9908b0df : 0);
  let kk = 0;
  for (; kk < N - 397; kk++) {
    const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
    mt[kk] = mt[kk + 397] ^ (y >>> 1) ^ mag(mt[kk + 1]);
  }
  for (; kk < N - 1; kk++) {
    const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
    mt[kk] = mt[kk + (397 - N)] ^ (y >>> 1) ^ mag(mt[kk + 1]);
  }
  const y = (mt[N - 1] & 0x80000000) | (mt[0] & 0x7fffffff);
  mt[N - 1] = mt[396] ^ (y >>> 1) ^ mag(mt[0]);
  mti = 0;
}

/** FPC's genrand_MT19937: the next 32-bit value (unsigned). */
function genrand(): number {
  if (!seeded) randomize();
  let i = mti;
  mti = i + 1;
  if (randSeed !== oldRandSeed || i >= N + 1) {
    sgenrand(randSeed);
    randSeed = ~randSeed;
    oldRandSeed = randSeed;
    i = N;
  }
  if (i === N) {
    twist();
    i = 0;
    mti = 1;
  }
  let y = mt[i];
  y ^= y >>> 11;
  y ^= (y << 7) & 0x9d2c5680;
  y ^= (y << 15) & 0xefc60000;
  y ^= y >>> 18;
  return y >>> 0;
}

/** FPC's Random: Double = genrand x 2^-32 (0 <= x < 1). */
export function fpcRandom(): number {
  return genrand() * 2.3283064365386963e-10;
}

/** FPC's Randomize: RandSeed = time(NULL) (32 bits); `epoch` overrides the clock (tests: the test host's --fixed-time). */
export function randomize(epoch?: number): void {
  const t = epoch ?? Math.floor(Date.now() / 1000);
  randSeed = t | 0;
  seeded = true;
}

/** Restart the stream as a freshly loaded FL plugin library with the clock at `epoch` seconds. */
export function resetFpcRandom(epoch: number): void {
  mti = N + 1;
  oldRandSeed = 0;
  randomize(epoch);
}
