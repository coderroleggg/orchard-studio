// Note segmentation for Newtone: splits a pitch track into notes.
// 1. Voiced runs (small unvoiced gaps bridged).
// 2. Inside a run, a vibrato-free contour (median then moving average over
//    ~120 ms) is followed with hysteresis: when it leaves the current note's
//    centre by more than 70 cents for 40 ms, the note ends at the steepest
//    point of the transition.
// 3. Re-articulations of the same pitch (a level dip of 9 dB or more between
//    two louder parts) also split.
// 4. Notes shorter than 50 ms merge into the neighbour closest in pitch.
// For each note: the average pitch (median of the steady middle), default
// pitch ramps (the glide into / out of the note) and the natural vibrato rate.

import type { PitchTrack } from './pitch';
import { hzToCents, median } from './util';

export interface SegNote {
  /** First and one-past-last frame. */
  a: number;
  z: number;
  /** Average pitch, MIDI cents. */
  p0: number;
  /** Pitch ramp in / out, frames. */
  ri: number;
  ro: number;
  /** Natural vibrato rate (Hz, 0 = none) and depth (cents, peak). */
  vr: number;
  vd: number;
  /** Peak RMS of the note (linear). */
  peak: number;
}

export interface SegmentOptions {
  /** Pitch change (cents) that starts a new note. */
  jump?: number;
  /** Shortest note (seconds). */
  minNote?: number;
}

function smoothContour(c: Float64Array, a: number, z: number, medHalf: number, avgHalf: number): Float64Array {
  const n = z - a;
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) m[i] = median(c, Math.max(a, a + i - medHalf), Math.min(z, a + i + medHalf + 1));
  const s = new Float64Array(n);
  let acc = 0, cnt = 0;
  // moving average via running sum
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + m[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - avgHalf), hi = Math.min(n, i + avgHalf + 1);
    acc = pre[hi] - pre[lo];
    cnt = hi - lo;
    s[i] = acc / cnt;
  }
  return s;
}

/** Note analysis of frames a..z of a cents track. */
export function describeNote(c: Float64Array, rms: Float32Array, a: number, z: number, fps: number): SegNote {
  const len = z - a;
  const q0 = a + Math.floor(len * 0.2), q1 = Math.max(q0 + 1, z - Math.floor(len * 0.2));
  const mid: number[] = [];
  for (let i = q0; i < q1; i++) if (Number.isFinite(c[i])) mid.push(c[i]);
  if (!mid.length) for (let i = a; i < z; i++) if (Number.isFinite(c[i])) mid.push(c[i]);
  const p0 = mid.length ? median(mid) : NaN;
  // ramps: the part at each end that is further than 50 cents from the centre
  const capR = Math.max(1, Math.floor(len * 0.4));
  let ri = 0;
  while (ri < capR && !(Math.abs(c[a + ri] - p0) < 50 && Math.abs(c[a + ri + 1] - p0) < 50)) ri++;
  let ro = 0;
  while (ro < capR && !(Math.abs(c[z - 1 - ro] - p0) < 50 && Math.abs(c[z - 2 - ro] - p0) < 50)) ro++;
  ri = Math.max(1, Math.min(ri, Math.round(0.15 * fps)));
  ro = Math.max(1, Math.min(ro, Math.round(0.15 * fps)));
  // natural vibrato: zero crossings of the detrended contour in the steady part
  let vr = 0, vd = 0;
  const sa = a + ri, sz = z - ro;
  if (sz - sa > 0.25 * fps) {
    const half = Math.max(2, Math.round(0.09 * fps));
    const tr = smoothContour(c, sa, sz, 1, half);
    let zc = 0, prev = 0, ss = 0, cnt = 0;
    for (let i = sa; i < sz; i++) {
      const dv = c[i] - tr[i - sa];
      if (!Number.isFinite(dv)) continue;
      ss += dv * dv; cnt++;
      const sg = dv > 3 ? 1 : dv < -3 ? -1 : 0;
      if (sg && prev && sg !== prev) zc++;
      if (sg) prev = sg;
    }
    const rmsDev = cnt ? Math.sqrt(ss / cnt) : 0;
    const rate = zc / 2 / ((sz - sa) / fps);
    if (rmsDev > 12 && rate >= 3 && rate <= 10) { vr = rate; vd = rmsDev * Math.SQRT2; }
  }
  let peak = 0;
  for (let i = a; i < z; i++) peak = Math.max(peak, rms[i] ?? 0);
  return { a, z, p0, ri, ro, vr, vd, peak };
}

/** Split a pitch track into notes. */
export function segmentNotes(t: PitchTrack, opt: SegmentOptions = {}): SegNote[] {
  const jump = opt.jump ?? 70;
  const fps = t.sr / t.hop;
  const minNote = Math.max(2, Math.round((opt.minNote ?? 0.05) * fps));
  const n = t.f0.length;
  const c = new Float64Array(n);
  for (let i = 0; i < n; i++) c[i] = t.f0[i] > 0 ? hzToCents(t.f0[i]) : NaN;
  // voiced runs, bridging gaps up to 15 ms
  const gap = Math.max(1, Math.round(0.015 * fps));
  const runs: [number, number][] = [];
  let i = 0;
  while (i < n) {
    if (!Number.isFinite(c[i])) { i++; continue; }
    let j = i + 1;
    let last = i;
    while (j < n) {
      if (Number.isFinite(c[j])) { last = j; j++; continue; }
      if (j - last > gap) break;
      j++;
    }
    runs.push([i, last + 1]);
    i = last + 1;
  }
  // fill bridged gaps by interpolation so the contour is continuous inside a run
  for (const [a, z] of runs) {
    let k = a;
    while (k < z) {
      if (Number.isFinite(c[k])) { k++; continue; }
      let e = k;
      while (e < z && !Number.isFinite(c[e])) e++;
      const v0 = c[k - 1], v1 = c[e];
      for (let q = k; q < e; q++) c[q] = v0 + ((v1 - v0) * (q - k + 1)) / (e - k + 1);
      k = e;
    }
  }
  const out: [number, number][] = [];
  const medHalf = Math.max(1, Math.round(0.02 * fps));
  const avgHalf = Math.max(1, Math.round(0.09 * fps));
  const sustain = Math.max(2, Math.round(0.04 * fps));
  for (const [a, z] of runs) {
    if (z - a < minNote) { out.push([a, z]); continue; }
    // m: outliers removed, steps kept sharp; s: vibrato removed (detection only)
    const m = smoothContour(c, a, z, medHalf, 0);
    const s = smoothContour(c, a, z, medHalf, avgHalf);
    let start = a;
    let sum = 0, cnt = 0;
    let cand = -1;
    for (let k = a; k < z; k++) {
      const v = s[k - a];
      const ref = cnt ? sum / cnt : v;
      if (cnt > 0 && Math.abs(v - ref) > jump) {
        if (cand < 0) cand = k;
        if (k - cand + 1 >= sustain) {
          // the new level (the sharp contour after the transition) and the
          // boundary where it crosses half way between the two levels
          const la0 = Math.min(z - a - 1, k - a + avgHalf);
          const newLevel = median(m, la0, Math.min(z - a, la0 + sustain + 1));
          const mid = 0.5 * (ref + newLevel);
          const up = newLevel > ref;
          let b = -1;
          const qEnd = Math.min(z - 1, k + 2 * avgHalf);
          for (let q = Math.max(start + 1, cand - 2 * avgHalf); q <= qEnd; q++) {
            const mv = m[q - a];
            if (up ? mv >= mid : mv <= mid) { b = q; break; }
          }
          if (b < 0) b = cand;
          if (b - start >= minNote) {
            out.push([start, b]);
            start = b;
          }
          // follow the new note from its settled level, past the smoothed ramp
          sum = newLevel * 4; cnt = 4;
          cand = -1;
          k = Math.max(k, b + avgHalf);
        }
      } else {
        cand = -1;
        sum += v; cnt++;
      }
    }
    out.push([start, z]);
  }
  // re-articulations: level dips inside long notes
  const split: [number, number][] = [];
  const db = (v: number) => 20 * Math.log10(Math.max(1e-9, v));
  for (const [a, z] of out) {
    let s0 = a;
    if (z - a >= 3 * minNote) {
      let k = a + minNote;
      while (k < z - minNote) {
        const here = db(t.rms[k]);
        let before = -200, after = -200;
        for (let q = Math.max(s0, k - Math.round(0.1 * fps)); q < k; q++) before = Math.max(before, db(t.rms[q]));
        for (let q = k + 1; q < Math.min(z, k + Math.round(0.1 * fps)); q++) after = Math.max(after, db(t.rms[q]));
        let isMin = true;
        for (let q = k - 2; q <= k + 2; q++) if (q !== k && t.rms[q] < t.rms[k]) isMin = false;
        if (isMin && before - here > 9 && after - here > 6 && k - s0 >= minNote && z - k >= minNote) {
          split.push([s0, k]);
          s0 = k;
          k += minNote;
          continue;
        }
        k++;
      }
    }
    split.push([s0, z]);
  }
  // merge too-short notes into the closer neighbour
  const notes = split.map(([a, z]) => describeNote(c, t.rms, a, z, fps));
  let merged = true;
  while (merged) {
    merged = false;
    for (let k = 0; k < notes.length; k++) {
      const nt = notes[k];
      if (nt.z - nt.a >= minNote || notes.length < 2) continue;
      const prev = notes[k - 1], next = notes[k + 1];
      const adjPrev = prev && prev.z === nt.a, adjNext = next && next.a === nt.z;
      if (!adjPrev && !adjNext) continue;
      const dPrev = adjPrev ? Math.abs(prev.p0 - nt.p0) : Infinity;
      const dNext = adjNext ? Math.abs(next.p0 - nt.p0) : Infinity;
      if (dPrev <= dNext) notes.splice(k - 1, 2, describeNote(c, t.rms, prev.a, nt.z, fps));
      else notes.splice(k, 2, describeNote(c, t.rms, nt.a, next.z, fps));
      merged = true;
      break;
    }
  }
  return notes.filter((nt) => Number.isFinite(nt.p0) && nt.z - nt.a >= 2);
}
