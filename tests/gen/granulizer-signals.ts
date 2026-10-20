// Test signals for the Granulizer's FL-pinned renders: built from exact IEEE operations only (integer
// arithmetic, +, -, *, /, floor), so the engine tests and the host renders that produced the golden
// checksums (tests/gen/granulizer-golden.ts) see the same float32 samples.

export const SIG_RATE = 44100;

/** xorshift32 noise in [-1, 1). */
function noise(state: { x: number }): number {
  let x = state.x;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  state.x = x;
  return (x / 4294967296) * 2 - 1;
}

/** Stereo ramp: left = position code (-1 .. 1 over the sample), right = a sawtooth every 2000 frames. */
export function rampSignal(n = 4 * SIG_RATE): Float32Array[] {
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = (i / n) * 2 - 1; R[i] = ((i % 2000) / 2000) * 2 - 1; }
  return [L, R];
}

/** DC 0.5 mono (the grain windows' sum). */
export function dcSignal(n = 2 * SIG_RATE): Float32Array[] {
  return [new Float32Array(n).fill(0.5)];
}

/** Stereo pulses: a triangle tone with a linear decay every half second and a click at each start. */
export function pulseSignal(n = 2 * SIG_RATE): Float32Array[] {
  const L = new Float32Array(n), R = new Float32Array(n);
  const tri = (i: number, p: number) => Math.abs(((i % p) / p) * 4 - 2) - 1;
  for (let i = 0; i < n; i++) {
    const ph = (i % 22050) / 22050;
    const env = 1 - ph;
    const click = i % 22050 < 90 ? 0.6 : 0;
    L[i] = 0.5 * env * tri(i, 200) + 0.2 * env * tri(i, 67) + click;
    R[i] = 0.5 * env * tri(i, 134) + 0.2 * env * tri(i, 44);
  }
  return [L, R];
}

/** Mono sweep: a triangle wave with a rising frequency and noise bursts. */
export function sweepSignal(n = 3 * SIG_RATE): Float32Array[] {
  const X = new Float32Array(n);
  const st = { x: 2463534242 };
  let ph = 0, f = 200 / SIG_RATE;
  for (let i = 0; i < n; i++) {
    ph += f; f += 150 / SIG_RATE / SIG_RATE;
    const p = ph - Math.floor(ph);
    const env = 1 - ((i % 11025) / 11025);
    X[i] = 0.4 * (Math.abs(p * 4 - 2) - 1) + 0.2 * noise(st) * env * env;
  }
  return [X];
}

/** Stereo noise bursts on a faint floor with a position-code right channel (transient detection and positions). */
export function burstSignal(n = 4 * SIG_RATE): Float32Array[] {
  const L = new Float32Array(n), R = new Float32Array(n);
  const st = { x: 88172645 };
  const bursts = [0.2, 0.9, 1.5, 2.2, 3.1].map((t) => Math.round(t * SIG_RATE));
  const len = Math.round(0.06 * SIG_RATE);
  for (let i = 0; i < n; i++) {
    let v = 0.003 * noise(st);
    for (const b of bursts) if (i >= b && i < b + len) v += 0.8 * noise(st) * (1 - (i - b) / len) * (1 - (i - b) / len);
    L[i] = v;
    R[i] = (i / n) * 2 - 1;
  }
  return [L, R];
}

/** FNV-1a over the float32 bits of the channels (a bit-exact fingerprint). */
export function fingerprint(chs: ArrayLike<number>[], n?: number): string {
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  let h = 0x811c9dc5;
  const len = n ?? chs[0].length;
  for (const c of chs) {
    for (let i = 0; i < len; i++) {
      f[0] = c[i];
      const x = u[0];
      for (let k = 0; k < 4; k++) { h ^= (x >>> (8 * k)) & 255; h = Math.imul(h, 0x01000193) >>> 0; }
    }
  }
  return h.toString(16).padStart(8, '0');
}
