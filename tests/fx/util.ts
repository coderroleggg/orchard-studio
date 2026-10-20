// Helpers for effect DSP tests.
import type { FxContext } from '../../src/engine/effects/types';

export function makeCtx(over: Partial<FxContext> = {}): FxContext {
  return {
    sampleRate: 48000, blockSize: 128, tempo: 120, ppq: 96, playing: true, pos: 0, songMode: true, track: 1,
    sidechain: [], sendTo: () => {}, ...over,
  };
}

/** Run an effect over whole buffers in blocks; returns the processed copies. */
export function render(
  fx: { process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void },
  inL: Float32Array, inR: Float32Array = inL, block = 128, ctx: Partial<FxContext> = {},
): [Float32Array, Float32Array] {
  const L = Float32Array.from(inL), R = Float32Array.from(inR);
  const c = makeCtx({ blockSize: block, ...ctx });
  for (let i = 0; i < L.length; i += block) {
    const n = Math.min(block, L.length - i);
    fx.process(L.subarray(i, i + n), R.subarray(i, i + n), n, c);
    c.pos += (n / c.sampleRate) * (c.tempo / 60) * c.ppq;
  }
  return [L, R];
}

export function sine(freq: number, seconds: number, amp = 0.5, sr = 48000): Float32Array {
  const n = Math.round(seconds * sr), b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.sin((2 * Math.PI * freq * i) / sr) * amp;
  return b;
}

export function rms(b: Float32Array, a = 0, z = b.length): number {
  let s = 0;
  for (let i = a; i < z; i++) s += b[i] * b[i];
  return Math.sqrt(s / Math.max(1, z - a));
}

export function peak(b: Float32Array, a = 0, z = b.length): number {
  let m = 0;
  for (let i = a; i < z; i++) m = Math.max(m, Math.abs(b[i]));
  return m;
}
