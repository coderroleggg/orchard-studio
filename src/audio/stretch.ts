// Offline time stretching and pitch shifting for the non-Resample stretch modes
// of the Sampler's SMP tab (Stretch, E3 Generic, E3 Mono, Slice stretch, Slice
// map, Auto), used by Audio Clips (docs/audio-clips.md). FL renders these with
// zplane's elastique library, which is not ported: the modes here are stand-ins
// that keep FL's contract (the output lasts the requested time, the pitch moves
// by the requested cents, the same sample comes out for the same settings).
//
//  - WSOLA (waveform-similarity overlap-add) stretches without changing pitch:
//    Hann grains, each placed where the input best continues the previous
//    grain; one alignment for all channels (found on the mono mix), so the
//    stereo image keeps together.
//  - Transients are kept: the sample is cut at detected onsets and every piece
//    is stretched on its own from its onset, so drum hits are not smeared or
//    doubled. Slice stretch cuts at every onset it finds, E3 Generic only at
//    strong ones, E3 Mono (monophonic material: voice, bass) not at all.
//  - Slice map moves the pieces to their stretched positions without
//    stretching them (gaps when slowing down, truncated pieces when speeding up).
//  - Pitch: the sample is time stretched by `ratio x pitch` and then resampled
//    by the pitch factor, which gives the length back.
//
// Pure functions on Float32Arrays: no DOM, usable in tests and workers.

import type { StretchMode } from '../model/sampler';
import { getSincKernel } from '../engine/dsp/sinc';

export interface StretchRequest {
  channels: Float32Array[];
  sampleRate: number;
  /** Length of the result in frames (the sample's duration in the Playlist). */
  outFrames: number;
  /** Pitch shift in cents; the duration is kept. */
  pitchCents: number;
  mode: StretchMode;
}

/** Time stretch + pitch shift. A request with nothing to do returns the input arrays. */
export function stretchSample(req: StretchRequest): Float32Array[] {
  const { channels: chs, sampleRate: sr, pitchCents, mode } = req;
  const n = chs[0]?.length ?? 0;
  if (n === 0) return chs;
  const outFrames = Math.max(1, Math.round(req.outFrames));
  const p = Math.pow(2, pitchCents / 1200);
  const shifted = Math.abs(p - 1) > 1e-9;
  if (!shifted && outFrames === n) return chs;
  // the pitch-preserving stretch makes `mid` frames, the resample by p brings them to outFrames
  const mid = shifted ? Math.max(1, Math.round(outFrames * p)) : outFrames;
  let y = mid === n ? chs : timeStretch(chs, sr, mid, mode);
  if (shifted) y = y.map((c) => resampleStep(c, p, outFrames));
  return y;
}

/** Read `src` at `i * step` for i < outLen (windowed sinc, band limited when step > 1). */
function resampleStep(src: Float32Array, step: number, outLen: number): Float32Array {
  const out = new Float32Array(outLen);
  const k = getSincKernel(32);
  for (let i = 0; i < outLen; i++) out[i] = k.read(src, i * step, step);
  return out;
}

// ---------------------------------------------------------------------- modes
function timeStretch(chs: Float32Array[], sr: number, outLen: number, mode: StretchMode): Float32Array[] {
  const n = chs[0].length;
  const mono = monoMix(chs);
  const ratio = outLen / n;
  switch (mode) {
    case 'e3mono':
      return sliceStretch(chs, mono, sr, outLen, [], 0.05, 0.014);
    case 'slicestretch':
      return sliceStretch(chs, mono, sr, outLen, detectOnsets(mono, sr, true), 0.025, 0.008);
    case 'slicemap':
      return sliceMap(chs, sr, outLen, detectOnsets(mono, sr, true));
    case 'auto': {
      // loops that need to get shorter keep their slices intact in shorter slots (stretched); loops that need to get longer
      // get their slices moved apart; anything without clear onsets is stretched as a whole
      const on = detectOnsets(mono, sr, true);
      if (on.length < 2) return sliceStretch(chs, mono, sr, outLen, [], 0.03, 0.01);
      return ratio <= 1 ? sliceStretch(chs, mono, sr, outLen, on, 0.025, 0.008) : sliceMap(chs, sr, outLen, on);
    }
    default: // 'stretch', 'e3generic'
      return sliceStretch(chs, mono, sr, outLen, detectOnsets(mono, sr, false), 0.03, 0.01);
  }
}

function monoMix(chs: Float32Array[]): Float32Array {
  const n = chs[0].length;
  if (chs.length === 1) return chs[0];
  const m = new Float32Array(n);
  const k = 1 / chs.length;
  for (const c of chs) for (let i = 0; i < n; i++) m[i] += c[i] * k;
  return m;
}

// ------------------------------------------------------------- onset detection
/**
 * Onsets (frame positions, ascending, not 0) from a short-time energy of the
 * high-passed signal: a hop whose energy rises well above the preceding ones.
 */
export function detectOnsets(mono: Float32Array, sr: number, sensitive: boolean): number[] {
  const n = mono.length;
  const hop = Math.max(32, Math.round(sr * 0.003));
  const frames = Math.floor(n / hop);
  if (frames < 8) return [];
  const e = new Float64Array(frames);
  let prev = 0;
  let maxE = 0;
  for (let j = 0; j < frames; j++) {
    let acc = 0;
    for (let i = j * hop; i < (j + 1) * hop; i++) {
      const hp = mono[i] - 0.95 * prev;
      prev = mono[i];
      acc += hp * hp;
    }
    e[j] = acc / hop;
    if (e[j] > maxE) maxE = e[j];
  }
  if (maxE <= 1e-12) return [];
  const mult = sensitive ? 2.2 : 4;
  const floor = maxE * (sensitive ? 0.004 : 0.02);
  const minGap = Math.round((sr * 0.045) / hop);
  const out: number[] = [];
  let last = -minGap;
  for (let j = 2; j < frames - 1; j++) {
    if (j - last < minGap) continue;
    let ref = 0;
    for (let k = 1; k <= 6 && j - k >= 0; k++) ref += e[j - k];
    ref /= Math.min(6, j);
    if (e[j] < floor || e[j] < mult * ref + floor * 0.1 || e[j] < e[j - 1]) continue;
    // the energy may still be climbing: the onset belongs to the hop where the climb ends
    let jj = j;
    while (jj + 1 < frames - 1 && e[jj + 1] > e[jj]) jj++;
    // refine to the first sample that gets loud inside the rise
    const a = Math.max(1, (j - 1) * hop), b = Math.min(n, (jj + 1) * hop);
    let pk = 0;
    for (let i = a; i < b; i++) pk = Math.max(pk, Math.abs(mono[i] - 0.95 * mono[i - 1]));
    let pos = a;
    for (let i = a; i < b; i++) if (Math.abs(mono[i] - 0.95 * mono[i - 1]) >= pk * 0.25) { pos = i; break; }
    pos = Math.max(1, pos - Math.round(sr * 0.001)); // include the attack
    if (pos > (out.length ? out[out.length - 1] : 0) + hop) out.push(pos);
    last = jj;
    j = jj;
  }
  return out;
}

// ------------------------------------------------------------------- stretching
const hannCache = new Map<number, Float32Array>();
function hann(len: number): Float32Array {
  let w = hannCache.get(len);
  if (!w) {
    w = new Float32Array(len);
    for (let i = 0; i < len; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / len); // never exactly 0
    hannCache.set(len, w);
  }
  return w;
}

/**
 * Stretch the sample to `outLen` frames: cut at `onsets`, every piece is
 * stretched by WSOLA to its share of the output (so the onsets move to their
 * stretched positions and each piece begins with its own unprocessed attack).
 */
function sliceStretch(
  chs: Float32Array[], mono: Float32Array, sr: number, outLen: number, onsets: number[], winSec: number, searchSec: number,
): Float32Array[] {
  const n = chs[0].length;
  const dst = chs.map(() => new Float32Array(outLen));
  const wsum = new Float32Array(outLen);
  const bounds = [0, ...onsets.filter((o) => o > 0 && o < n), n];
  const W = Math.max(64, Math.round((sr * winSec) / 2) * 2);
  const search = Math.max(8, Math.round(sr * searchSec));
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a0 = bounds[i], a1 = bounds[i + 1];
    const o0 = Math.round((a0 * outLen) / n), o1 = i + 2 === bounds.length ? outLen : Math.round((a1 * outLen) / n);
    stretchPiece(chs, mono, a0, a1, dst, wsum, o0, o1 - o0, W, search);
  }
  for (let i = 0; i < outLen; i++) if (wsum[i] > 1e-6) for (const d of dst) d[i] /= wsum[i];
  return dst;
}

/** Stretch the input range [a0, a1) into dst[o0, o0 + outLen) (accumulating weighted grains and their weights). */
function stretchPiece(
  src: Float32Array[], mono: Float32Array, a0: number, a1: number, dst: Float32Array[], wsum: Float32Array,
  o0: number, outLen: number, W: number, search: number,
): void {
  const segLen = a1 - a0;
  if (segLen <= 0 || outLen <= 0) return;
  if (segLen < 2 * W || outLen < 2 * W) {
    // too short for grains: interpolate (the pitch of such a short piece moves a little)
    for (let i = 0; i < outLen; i++) {
      const p = a0 + (i * segLen) / outLen, k = Math.floor(p), f = p - k;
      for (let c = 0; c < src.length; c++) {
        const s = src[c];
        const x0 = k < a1 ? s[k] : 0, x1 = k + 1 < a1 ? s[k + 1] : x0;
        dst[c][o0 + i] += (x0 + (x1 - x0) * f) * 1;
      }
      wsum[o0 + i] += 1;
    }
    return;
  }
  const Hs = W >> 1;
  const win = hann(W);
  const ratio = segLen / outLen;
  const grains = Math.ceil((outLen - W) / Hs) + 1;
  let prev = a0;
  for (let k = 0; k < grains; k++) {
    let a: number;
    if (k === 0) a = a0;
    else {
      const nominal = a0 + Math.round(k * Hs * ratio);
      const natural = prev + Hs; // where the input goes on after the previous grain
      const lo = Math.max(a0, nominal - search), hi = Math.min(a1 - W, nominal + search);
      a = Math.min(a1 - W, Math.max(a0, nominal));
      if (lo <= hi && natural + Hs < a1) a = bestMatch(mono, natural, lo, hi, Hs);
    }
    a = Math.max(a0, Math.min(a1 - W, a));
    const o = o0 + k * Hs;
    const end = Math.min(W, o0 + outLen - o);
    for (let t = 0; t < end; t++) {
      const w = win[t];
      for (let c = 0; c < src.length; c++) dst[c][o + t] += src[c][a + t] * w;
      wsum[o + t] += w;
    }
    prev = a;
  }
}

/** The candidate start in [lo, hi] whose next `len` frames best match those at `ref` (normalised correlation on the mono mix). */
function bestMatch(m: Float32Array, ref: number, lo: number, hi: number, len: number): number {
  const stride = 2;
  const score = (c: number): number => {
    let d = 0, e = 1e-9;
    for (let i = 0; i < len; i += stride) {
      const x = m[c + i];
      d += x * m[ref + i];
      e += x * x;
    }
    return d / Math.sqrt(e);
  };
  let best = lo, bestS = -Infinity;
  const coarse = 4;
  for (let c = lo; c <= hi; c += coarse) {
    const s = score(c);
    if (s > bestS) { bestS = s; best = c; }
  }
  const f0 = Math.max(lo, best - coarse + 1), f1 = Math.min(hi, best + coarse - 1);
  for (let c = f0; c <= f1; c++) {
    const s = score(c);
    if (s > bestS) { bestS = s; best = c; }
  }
  return best;
}

/**
 * Slice map: every piece keeps its length and moves to its stretched position
 * (`start x outLen / length`). A piece that would run into the next one is
 * cut with a short fade; the room left when slowing down stays silent.
 */
function sliceMap(chs: Float32Array[], sr: number, outLen: number, onsets: number[]): Float32Array[] {
  const n = chs[0].length;
  const dst = chs.map(() => new Float32Array(outLen));
  const bounds = [0, ...onsets.filter((o) => o > 0 && o < n), n];
  const fade = Math.max(8, Math.round(sr * 0.004));
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a0 = bounds[i], a1 = bounds[i + 1];
    const o0 = Math.round((a0 * outLen) / n);
    // the slot of the piece ends where the next piece starts (the last piece: at the end)
    const slotEnd = i + 2 === bounds.length ? outLen : Math.round((a1 * outLen) / n);
    let len = Math.min(a1 - a0, outLen - o0);
    let cut = false;
    if (o0 + len > slotEnd) { len = Math.max(0, slotEnd - o0); cut = true; }
    for (let c = 0; c < chs.length; c++) {
      const s = chs[c], d = dst[c];
      for (let t = 0; t < len; t++) {
        const g = cut && t > len - fade ? Math.max(0, (len - t) / fade) : 1;
        d[o0 + t] += s[a0 + t] * g;
      }
    }
  }
  return dst;
}
