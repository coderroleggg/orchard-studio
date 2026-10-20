// Edison's edit operations as pure functions over audio channels
// (Float32Array per channel, all the same length). Ranges are half-open
// [a, b) in sample frames. Every function returns new arrays and leaves its
// input untouched (the editor keeps old versions for undo).
//
// Semantics follow Edison's script API (FL's Audio scripts/Reference.txt):
// PasteFromTo modes insert / replace / mix, NormalizeFromTo, AmpFromTo,
// SilenceFromTo, CenterFromTo (DC offset), ReverseFromTo,
// ReversePolarityFromTo, SwapChannelsFromTo, InsertSilence, NoiseFromTo,
// DeleteFromTo, TrimFromTo and ConvertToMono (merge / left / right).

import type { EdMarker } from '../../../../model/fx/plugins/edison';

export type Chans = Float32Array[];

/** Click-free editing crossfade (FL's state holds 0.00408 s = 180 samples at 44.1 kHz). */
export const CLICK_FREE_S = 0.00408;

export function frames(ch: Chans): number {
  return ch.length ? ch[0].length : 0;
}

export function clampRange(ch: Chans, a: number, b: number): [number, number] {
  const n = frames(ch);
  let x = Math.round(Math.min(a, b)), y = Math.round(Math.max(a, b));
  x = Math.min(Math.max(0, x), n);
  y = Math.min(Math.max(0, y), n);
  return [x, y];
}

export function cloneChans(ch: Chans): Chans {
  return ch.map((c) => new Float32Array(c));
}

export function emptyLike(ch: Chans, n: number): Chans {
  return Array.from({ length: Math.max(1, ch.length) }, () => new Float32Array(Math.max(0, n)));
}

// ------------------------------------------------------------ clipboard / cut
export function copyRange(ch: Chans, a: number, b: number): Chans {
  const [x, y] = clampRange(ch, a, b);
  return ch.map((c) => c.slice(x, y));
}

/**
 * Delete [a, b). With `xfade` frames the splice is click-free: the deleted
 * audio fades out over the first frames after the junction while the
 * following audio fades in (the length stays len - (b - a)).
 */
export function deleteRange(ch: Chans, a: number, b: number, xfade = 0): Chans {
  const [x, y] = clampRange(ch, a, b);
  const n = frames(ch), cut = y - x;
  if (cut <= 0) return cloneChans(ch);
  return ch.map((c) => {
    const out = new Float32Array(n - cut);
    out.set(c.subarray(0, x), 0);
    out.set(c.subarray(y), x);
    const xf = Math.min(xfade, cut, n - y);
    for (let i = 0; i < xf; i++) {
      const t = (i + 0.5) / xf;
      out[x + i] = c[y + i] * t + c[x + i] * (1 - t);
    }
    return out;
  });
}

export function cutRange(ch: Chans, a: number, b: number, xfade = 0): { result: Chans; clip: Chans } {
  return { result: deleteRange(ch, a, b, xfade), clip: copyRange(ch, a, b) };
}

/** Keep [a, b) only (TrimFromTo). */
export function trimTo(ch: Chans, a: number, b: number): Chans {
  return copyRange(ch, a, b);
}

/** Zero [a, b) (Clear / SilenceFromTo); click-free fades inside the range edges. */
export function silenceRange(ch: Chans, a: number, b: number, xfade = 0): Chans {
  const [x, y] = clampRange(ch, a, b);
  return ch.map((c) => {
    const out = new Float32Array(c);
    const xf = Math.min(xfade, Math.floor((y - x) / 2));
    for (let i = x + xf; i < y - xf; i++) out[i] = 0;
    for (let i = 0; i < xf; i++) {
      const t = (i + 0.5) / xf;
      out[x + i] = c[x + i] * (1 - t);
      out[y - 1 - i] = c[y - 1 - i] * (1 - t);
    }
    return out;
  });
}

/** Insert `count` frames of silence at `at` (InsertSilence). */
export function insertSilence(ch: Chans, at: number, count: number): Chans {
  const n = frames(ch);
  const p = Math.min(Math.max(0, Math.round(at)), n), k = Math.max(0, Math.round(count));
  return ch.map((c) => {
    const out = new Float32Array(n + k);
    out.set(c.subarray(0, p), 0);
    out.set(c.subarray(p), p + k);
    return out;
  });
}

/** Bring a clip to `n` channels (mono -> both, stereo -> mono by averaging). */
export function matchChannels(clip: Chans, n: number): Chans {
  if (clip.length === n) return clip;
  if (n === 1) {
    const m = new Float32Array(frames(clip));
    for (const c of clip) for (let i = 0; i < m.length; i++) m[i] += c[i] / clip.length;
    return [m];
  }
  return Array.from({ length: n }, (_, k) => clip[Math.min(k, clip.length - 1)]);
}

/** Paste insert: the clip goes in at `at`; everything from there moves after it. */
export function pasteInsert(ch: Chans, at: number, clip: Chans): Chans {
  const src = matchChannels(clip, Math.max(1, ch.length));
  const n = frames(ch), k = frames(src);
  const p = Math.min(Math.max(0, Math.round(at)), n);
  if (!ch.length) return src.map((c) => new Float32Array(c));
  return ch.map((c, ci) => {
    const out = new Float32Array(n + k);
    out.set(c.subarray(0, p), 0);
    out.set(src[ci], p);
    out.set(c.subarray(p), p + k);
    return out;
  });
}

/** Paste replace: the clip overwrites from `at` for its own length (the sample grows if needed). */
export function pasteReplace(ch: Chans, at: number, clip: Chans): Chans {
  const src = matchChannels(clip, Math.max(1, ch.length));
  const n = frames(ch), k = frames(src);
  const p = Math.min(Math.max(0, Math.round(at)), n);
  const len = Math.max(n, p + k);
  const base = ch.length ? ch : emptyLike(src, 0);
  return base.map((c, ci) => {
    const out = new Float32Array(len);
    out.set(c, 0);
    out.set(src[ci], p);
    return out;
  });
}

/** Paste mix: the clip is added from `at` for its own length (the sample grows if needed). */
export function pasteMix(ch: Chans, at: number, clip: Chans, gain = 1): Chans {
  const src = matchChannels(clip, Math.max(1, ch.length));
  const n = frames(ch), k = frames(src);
  const p = Math.min(Math.max(0, Math.round(at)), n);
  const len = Math.max(n, p + k);
  const base = ch.length ? ch : emptyLike(src, 0);
  return base.map((c, ci) => {
    const out = new Float32Array(len);
    out.set(c, 0);
    const s = src[ci];
    for (let i = 0; i < k; i++) out[p + i] += s[i] * gain;
    return out;
  });
}

// ------------------------------------------------------------ sample processing
function mapRange(ch: Chans, a: number, b: number, fn: (c: Float32Array, out: Float32Array, x: number, y: number, ci: number) => void): Chans {
  const [x, y] = clampRange(ch, a, b);
  return ch.map((c, ci) => {
    const out = new Float32Array(c);
    if (y > x) fn(c, out, x, y, ci);
    return out;
  });
}

export function reverseRange(ch: Chans, a: number, b: number): Chans {
  return mapRange(ch, a, b, (c, out, x, y) => { for (let i = x; i < y; i++) out[i] = c[x + y - 1 - i]; });
}

/** Reverse polarity. */
export function invertRange(ch: Chans, a: number, b: number): Chans {
  return mapRange(ch, a, b, (c, out, x, y) => { for (let i = x; i < y; i++) out[i] = -c[i]; });
}

export function peakRange(ch: Chans, a: number, b: number): number {
  const [x, y] = clampRange(ch, a, b);
  let m = 0;
  for (const c of ch) for (let i = x; i < y; i++) { const v = c[i] < 0 ? -c[i] : c[i]; if (v > m) m = v; }
  return m;
}

export function ampRange(ch: Chans, a: number, b: number, gain: number): Chans {
  return mapRange(ch, a, b, (c, out, x, y) => { for (let i = x; i < y; i++) out[i] = c[i] * gain; });
}

/** Normalize the peak of [a, b) to `vol` (NormalizeFromTo; `onlyIfAbove`: only reduce). */
export function normalizeRange(ch: Chans, a: number, b: number, vol = 1, onlyIfAbove = false): Chans {
  const pk = peakRange(ch, a, b);
  if (pk <= 0 || (onlyIfAbove && pk <= vol)) return cloneChans(ch);
  return ampRange(ch, a, b, vol / pk);
}

/**
 * Amp tool (FL's Amplitude tool): left / right volume (1 = unity), panning
 * (-1 left .. 1 right, linear balance) and stereo separation (-1 merged
 * (mono) .. 0 unchanged .. 1 wider), on stereo audio.
 */
export function ampTool(ch: Chans, a: number, b: number, o: { volL: number; volR: number; pan: number; sep: number }): Chans {
  if (ch.length < 2) {
    const g = (o.volL + o.volR) / 2;
    return ampRange(ch, a, b, g);
  }
  const [x, y] = clampRange(ch, a, b);
  const L = new Float32Array(ch[0]), R = new Float32Array(ch[1]);
  const gl = o.volL * (o.pan > 0 ? 1 - o.pan : 1);
  const gr = o.volR * (o.pan < 0 ? 1 + o.pan : 1);
  const w = 1 + o.sep; // side gain: 0 = mono, 1 = unchanged, 2 = double width
  for (let i = x; i < y; i++) {
    const l = ch[0][i], r = ch[1][i];
    const m = (l + r) * 0.5, s = (l - r) * 0.5 * w;
    L[i] = (m + s) * gl;
    R[i] = (m - s) * gr;
  }
  return [L, R, ...ch.slice(2).map((c) => new Float32Array(c))];
}

/** Fade in curve: FL ramps "using a logarithmic curve" (fast rise, as its icon shows). */
export function fadeInGain(t: number): number {
  const u = 1 - Math.min(1, Math.max(0, t));
  return 1 - u * u;
}

/** Fade out curve: fast drop first (FL's icon), the complement of the fade in. */
export function fadeOutGain(t: number): number {
  const u = 1 - Math.min(1, Math.max(0, t));
  return u * u;
}

export function fadeInRange(ch: Chans, a: number, b: number): Chans {
  return mapRange(ch, a, b, (c, out, x, y) => {
    const n = y - x;
    for (let i = 0; i < n; i++) out[x + i] = c[x + i] * fadeInGain(n > 1 ? i / (n - 1) : 1);
  });
}

export function fadeOutRange(ch: Chans, a: number, b: number): Chans {
  return mapRange(ch, a, b, (c, out, x, y) => {
    const n = y - x;
    for (let i = 0; i < n; i++) out[x + i] = c[x + i] * fadeOutGain(n > 1 ? i / (n - 1) : 0);
  });
}

/** Declick in: a very short linear fade-in at `a` (FL: "works by creating a very fast fade-in"). */
export function declickIn(ch: Chans, a: number, count: number): Chans {
  return mapRange(ch, a, a + count, (c, out, x, y) => {
    const n = y - x;
    for (let i = 0; i < n; i++) out[x + i] = c[x + i] * (i / n);
  });
}

/** Declick out: a very short linear fade-out ending at `b`. */
export function declickOut(ch: Chans, b: number, count: number): Chans {
  return mapRange(ch, b - count, b, (c, out, x, y) => {
    const n = y - x;
    for (let i = 0; i < n; i++) out[x + i] = c[x + i] * ((n - 1 - i) / n);
  });
}

/** Center (remove DC offset): subtract each channel's mean over [a, b). */
export function removeDC(ch: Chans, a: number, b: number): Chans {
  return mapRange(ch, a, b, (c, out, x, y) => {
    let m = 0;
    for (let i = x; i < y; i++) m += c[i];
    m /= y - x;
    for (let i = x; i < y; i++) out[i] = c[i] - m;
  });
}

export function swapChannels(ch: Chans, a = 0, b = Infinity): Chans {
  if (ch.length < 2) return cloneChans(ch);
  const [x, y] = clampRange(ch, a, Math.min(b, frames(ch)));
  const L = new Float32Array(ch[0]), R = new Float32Array(ch[1]);
  for (let i = x; i < y; i++) { L[i] = ch[1][i]; R[i] = ch[0][i]; }
  return [L, R, ...ch.slice(2).map((c) => new Float32Array(c))];
}

/** ConvertToMono: 0 merge left/right, 1 left, 2 right. */
export function toMono(ch: Chans, mode: 0 | 1 | 2 = 0): Chans {
  if (ch.length < 2) return cloneChans(ch);
  if (mode === 1) return [new Float32Array(ch[0])];
  if (mode === 2) return [new Float32Array(ch[1])];
  const m = new Float32Array(ch[0].length);
  for (let i = 0; i < m.length; i++) m[i] = (ch[0][i] + ch[1][i]) * 0.5;
  return [m];
}

/** "Convert mono signal to mono format": only when both channels are equal. */
export function monoIfEqual(ch: Chans): Chans | null {
  if (ch.length < 2) return null;
  const L = ch[0], R = ch[1];
  for (let i = 0; i < L.length; i++) if (Math.abs(L[i] - R[i]) > 1e-7) return null;
  return [new Float32Array(L)];
}

export function toStereo(ch: Chans): Chans {
  if (ch.length >= 2) return cloneChans(ch);
  const c = ch[0] ?? new Float32Array(0);
  return [new Float32Array(c), new Float32Array(c)];
}

/** Simple deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** NoiseFromTo: replace [a, b) with white noise (uniform or gaussian) at `vol`. */
export function noiseRange(ch: Chans, a: number, b: number, vol = 1, gaussian = false, seed = 1): Chans {
  const r = rng(seed);
  return mapRange(ch, a, b, (_c, out, x, y) => {
    for (let i = x; i < y; i++) {
      if (gaussian) {
        const u = Math.max(1e-12, r()), v = r();
        out[i] = Math.max(-1, Math.min(1, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * 0.25)) * vol;
      } else out[i] = (r() * 2 - 1) * vol;
    }
  });
}

/** SineFromTo: replace [a, b) with a sine (freq Hz, phase in cycles). */
export function sineRange(ch: Chans, a: number, b: number, sr: number, freq: number, phase = 0, vol = 1): Chans {
  return mapRange(ch, a, b, (_c, out, x, y) => {
    for (let i = x; i < y; i++) out[i] = Math.sin(2 * Math.PI * (freq * (i - x) / sr + phase)) * vol;
  });
}

// ------------------------------------------------------------------- noise
/** Peak envelope test: is frame i (any channel) at or above `thr`? */
function loudAt(ch: Chans, i: number, thr: number): boolean {
  for (const c of ch) { const v = c[i]; if (v >= thr || v <= -thr) return true; }
  return false;
}

/**
 * Segments of [a, b) where the audio stays above `thr`, bridging gaps
 * shorter than `hold` frames (zero crossings inside a sound).
 */
export function loudSegments(ch: Chans, a: number, b: number, thr: number, hold: number): [number, number][] {
  const [x, y] = clampRange(ch, a, b);
  const out: [number, number][] = [];
  let s = -1, last = -1;
  for (let i = x; i < y; i++) {
    if (loudAt(ch, i, thr)) {
      if (s < 0) s = i;
      else if (i - last > hold) { out.push([s, last + 1]); s = i; }
      last = i;
    }
  }
  if (s >= 0) out.push([s, last + 1]);
  return out;
}

/** Gate noise: force the parts of [a, b) below the threshold to silence (short ramps at the edges). */
export function gateNoise(ch: Chans, a: number, b: number, thr: number, hold: number, ramp: number): Chans {
  const [x, y] = clampRange(ch, a, b);
  const keep = new Float32Array(y - x);
  for (const [s, e] of loudSegments(ch, x, y, thr, hold)) for (let i = s; i < e; i++) keep[i - x] = 1;
  // ramps: smooth the 0/1 mask
  const g = new Float32Array(keep.length);
  if (ramp > 1) {
    let v = 0;
    const k = 1 / ramp;
    for (let i = 0; i < g.length; i++) { v = keep[i] > v ? Math.min(1, v + k) : keep[i] < v ? Math.max(0, v - k) : v; g[i] = v; }
    // look-ahead so attacks are not cut: run backwards too and take the max
    v = 0;
    for (let i = g.length - 1; i >= 0; i--) { v = keep[i] > v ? Math.min(1, v + k) : keep[i] < v ? Math.max(0, v - k) : v; if (v > g[i]) g[i] = v; }
  } else g.set(keep);
  return mapRange(ch, x, y, (c, out) => { for (let i = x; i < y; i++) out[i] = c[i] * g[i - x]; });
}

/** Trim side noise: cut what is below the threshold before the first and after the last loud frame. */
export function trimSideNoise(ch: Chans, a: number, b: number, thr: number): { result: Chans; start: number; end: number } {
  const [x, y] = clampRange(ch, a, b);
  let s = x, e = y;
  while (s < e && !loudAt(ch, s, thr)) s++;
  while (e > s && !loudAt(ch, e - 1, thr)) e--;
  if (s >= e) return { result: cloneChans(ch), start: 0, end: frames(ch) };
  // keep the outside of the range untouched: remove [x, s) and [e, y)
  const head = ch.map((c) => c.subarray(0, x));
  const mid = ch.map((c) => c.subarray(s, e));
  const tail = ch.map((c) => c.subarray(y));
  const result = ch.map((_, ci) => {
    const out = new Float32Array(head[ci].length + mid[ci].length + tail[ci].length);
    out.set(head[ci], 0);
    out.set(mid[ci], head[ci].length);
    out.set(tail[ci], head[ci].length + mid[ci].length);
    return out;
  });
  return { result, start: s, end: e };
}

// -------------------------------------------------------------- positioning
/** Nearest zero crossing to `pos` within `range` frames (first channel; falls back to pos). */
export function zeroCrossNear(ch: Chans, pos: number, range = 2048): number {
  const c = ch[0];
  if (!c || c.length < 2) return pos;
  const p = Math.min(Math.max(0, Math.round(pos)), c.length - 1);
  for (let d = 0; d <= range; d++) {
    for (const i of [p - d, p + d]) {
      if (i <= 0 || i >= c.length) continue;
      const u = c[i - 1], v = c[i];
      if (u === 0 || (u < 0 && v >= 0) || (u > 0 && v <= 0)) return Math.abs(u) < Math.abs(v) ? i - 1 : i;
    }
  }
  return p;
}

// ----------------------------------------------------------------- markers
/** Markers after an insert of `count` frames at `at` (markers at or after it move). */
export function markersAfterInsert(ms: EdMarker[], at: number, count: number): EdMarker[] {
  return ms.map((m) => {
    const o = { ...m };
    if (o.pos >= at) o.pos += count;
    if (o.end !== undefined && o.end > at) o.end += count;
    return o;
  });
}

/** Markers after deleting [a, b): markers inside go, regions are clipped, later ones move. */
export function markersAfterDelete(ms: EdMarker[], a: number, b: number): EdMarker[] {
  const k = b - a;
  const out: EdMarker[] = [];
  for (const m of ms) {
    const o = { ...m };
    const end = o.end;
    if (o.pos >= a && o.pos < b) {
      if (end === undefined || end <= b) continue;
      o.pos = a;
    } else if (o.pos >= b) o.pos -= k;
    if (end !== undefined) {
      let e = end;
      if (e > b) e -= k; else if (e > a) e = a;
      if (e > o.pos) o.end = e; else delete o.end;
    }
    out.push(o);
  }
  return out;
}

/** Markers after reversing [a, b): positions inside are mirrored. */
export function markersAfterReverse(ms: EdMarker[], a: number, b: number): EdMarker[] {
  return ms.map((m) => {
    const o = { ...m };
    if (o.end === undefined) { if (o.pos >= a && o.pos < b) o.pos = a + b - o.pos; }
    else if (o.pos >= a && o.end <= b) { const s = a + b - o.end, e = a + b - o.pos; o.pos = s; o.end = e; }
    return o;
  }).sort((p, q) => p.pos - q.pos);
}

/** Markers clipped to [0, len). */
export function markersClip(ms: EdMarker[], len: number): EdMarker[] {
  const out: EdMarker[] = [];
  for (const m of ms) {
    if (m.pos >= len) continue;
    const o = { ...m };
    if (o.end !== undefined) { o.end = Math.min(o.end, len); if (o.end <= o.pos) delete o.end; }
    out.push(o);
  }
  return out;
}

// --------------------------------------------------------------- resampling
/** Linear-phase-free cubic resampler (good enough for edits; tools that care use their own). */
export function resampleChans(ch: Chans, ratio: number): Chans {
  if (!(ratio > 0) || Math.abs(ratio - 1) < 1e-9) return cloneChans(ch);
  const n = frames(ch), m = Math.max(1, Math.round(n / ratio));
  return ch.map((c) => {
    const out = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const p = i * ratio, x = Math.floor(p), t = p - x;
      const xm1 = c[x - 1] ?? 0, x0 = c[x] ?? 0, x1 = c[x + 1] ?? 0, x2 = c[x + 2] ?? 0;
      const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
      out[i] = ((c3 * t + c2) * t + c1) * t + x0;
    }
    return out;
  });
}

/** Concatenate two pieces of audio (channel counts matched to the first). */
export function concatChans(a: Chans, b: Chans): Chans {
  if (!a.length || !frames(a)) return cloneChans(b);
  const src = matchChannels(b, a.length);
  return a.map((c, ci) => {
    const out = new Float32Array(c.length + src[ci].length);
    out.set(c, 0);
    out.set(src[ci], c.length);
    return out;
  });
}
