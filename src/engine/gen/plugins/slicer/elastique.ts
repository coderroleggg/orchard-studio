// Stand-in for FL's elastique time stretching / pitch shifting (Fruity Slicer's methods "Pro
// default" .. "Speech" and any PS setting). FL calls zplane's proprietary elastique library
// (FL's Shared/elastique_x64.dylib) per slice; it is not ported. This approximation keeps
// FL's contract (output length, pitch factor) with WSOLA time stretching (waveform-similarity
// overlap-add, Hann windows) followed by linear-interpolation resampling for the pitch.
// See docs/research/gen/slicer.md (Fidelity: elastique modes are approximations).

import type { ElastiqueFn } from './process';

/** WSOLA stretch of one channel to `outLen` frames. */
function wsola(x: Float32Array, outLen: number, sr: number): Float32Array {
  const y = new Float32Array(outLen);
  const n = x.length;
  if (n === 0 || outLen === 0) return y;
  if (n === outLen) { y.set(x); return y; }
  const win = Math.max(64, Math.min(4096, Math.round((sr * 0.025) / 2) * 2));
  const hop = win >> 1;
  const search = Math.round(sr * 0.006);
  const ratio = n / outLen;
  const w = new Float32Array(win);
  for (let i = 0; i < win; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);
  const norm = new Float32Array(outLen);
  let prev = 0;
  for (let o = 0; o < outLen; o += hop) {
    let center = Math.round(o * ratio);
    if (o > 0) {
      // the input frame most similar to the continuation of the previous one
      const nat = prev + hop;
      let best = center, bestC = -Infinity;
      for (let d = -search; d <= search; d += 2) {
        const c0 = center + d;
        if (c0 < 0 || c0 + win > n) continue;
        let c = 0;
        for (let i = 0; i < win; i += 4) c += x[c0 + i] * (nat + i < n ? x[nat + i] : 0);
        if (c > bestC) { bestC = c; best = c0; }
      }
      center = best;
    }
    center = Math.max(0, Math.min(Math.max(0, n - 1), center));
    for (let i = 0; i < win; i++) {
      const oi = o + i, xi = center + i;
      if (oi >= outLen) break;
      const v = xi < n ? x[xi] : 0;
      y[oi] += v * w[i];
      norm[oi] += w[i];
    }
    prev = center;
  }
  for (let i = 0; i < outLen; i++) if (norm[i] > 1e-6) y[i] /= norm[i];
  return y;
}

/** Resample by `pitch` (frequency factor) keeping `outLen` frames. */
function repitch(x: Float32Array, outLen: number, pitch: number): Float32Array {
  const y = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const p = i * pitch, k = Math.floor(p), f = p - k;
    const a = k < x.length ? x[k] : 0, b = k + 1 < x.length ? x[k + 1] : 0;
    y[i] = a + (b - a) * f;
  }
  return y;
}

export const elastique: ElastiqueFn = (input, outLen, pitch, _mode, sampleRate) => {
  const p = pitch > 0 && Number.isFinite(pitch) ? pitch : 1;
  return input.map((ch) => {
    if (p === 1) return wsola(ch, outLen, sampleRate);
    const stretched = wsola(ch, Math.max(1, Math.round(outLen * p)), sampleRate);
    return repitch(stretched, outLen, p);
  });
};
