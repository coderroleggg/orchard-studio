// TD-PSOLA resynthesis (pitch-synchronous overlap-add) for Newtone.
// Analysis: pitch marks one period apart in voiced parts (the first mark of
// a voiced run on the waveform peak, the next ones placed by normalised
// cross-correlation with the previous period so they stay phase-locked),
// fixed ~4.5 ms steps in unvoiced parts.
// Synthesis: output marks are spaced by the target period (source period /
// pitch ratio); each takes the nearest source mark's two-period Hann grain
// (resampled by the formant factor, so pitch and formants move separately),
// read through a time map (output position -> source position) so notes can
// also be moved and stretched. Unvoiced grains follow the time map exactly
// with jittered spacing (no buzz when stretched). The overlap-added result is
// normalised by the summed windows.

import { readCubic, rng, trackAt } from './util';

export interface Marks {
  /** Mark positions (source samples), increasing. */
  pos: Float64Array;
  /** Local period (voiced) or step (unvoiced), samples. */
  per: Float32Array;
  voiced: Uint8Array;
  count: number;
}

/**
 * Pitch marks for a mono signal and its pitch track (`f0` Hz per frame,
 * frame k centred on sample k * hop, 0 = unvoiced).
 */
export function pitchMarks(x: Float32Array, sr: number, f0: ArrayLike<number>, hop: number): Marks {
  const n = x.length;
  const cap = Math.ceil(n / Math.max(8, sr / 1600)) + 16;
  let pos = new Float64Array(cap), per = new Float32Array(cap), vo = new Uint8Array(cap);
  let count = 0;
  const push = (p: number, T: number, v: number) => {
    if (count >= pos.length) {
      const m = pos.length * 2;
      const np = new Float64Array(m), nt = new Float32Array(m), nv = new Uint8Array(m);
      np.set(pos); nt.set(per); nv.set(vo);
      pos = np; per = nt; vo = nv;
    }
    pos[count] = p; per[count] = T; vo[count] = v; count++;
  };
  const frames = f0.length;
  const periodAt = (t: number): number => {
    const fp = t / hop;
    const i = Math.floor(fp);
    if (i < 0 || i >= frames) return 0;
    const a = f0[i], b = i + 1 < frames ? f0[i + 1] : 0;
    if (a > 0 && b > 0) return sr / (a + (b - a) * (fp - i));
    const near = fp - i < 0.5 ? a : b;
    return near > 0 ? sr / near : 0;
  };
  const stepU = Math.max(16, Math.round(0.0045 * sr));
  const rand = rng(0x5eed);
  let t = 0;
  let prev = -1e9, prevV = false;
  while (t < n) {
    const T = periodAt(t);
    if (T > 0) {
      let m: number;
      if (!prevV) {
        // first mark of a voiced run: the largest peak within one period
        let best = -Infinity;
        m = Math.round(t);
        const z = Math.min(n, Math.round(t + T));
        for (let i = Math.max(0, Math.round(t)); i < z; i++) if (x[i] > best) { best = x[i]; m = i; }
      } else {
        // phase-lock to the previous period by normalised cross-correlation,
        // to sub-sample precision (integer marks would drift and detune)
        const L = Math.max(4, Math.round(T / 2));
        const dl = Math.max(1, Math.round(0.15 * T));
        const pred = Math.round(t);
        const p0 = prev;
        const tmpl = new Float32Array(2 * L + 1);
        for (let j = -L; j <= L; j++) tmpl[j + L] = readCubic(x, p0 + j);
        const sc = new Float64Array(2 * dl + 1);
        let bi = -1, best = -Infinity;
        for (let q = 0; q <= 2 * dl; q++) {
          const cnd = pred - dl + q;
          if (cnd <= p0 + 0.5 * T) { sc[q] = -Infinity; continue; }
          let s = 0, e = 0;
          for (let j = -L; j <= L; j++) {
            const ib = cnd + j;
            const vb = ib >= 0 && ib < n ? x[ib] : 0;
            s += tmpl[j + L] * vb;
            e += vb * vb;
          }
          sc[q] = e > 1e-12 ? s / Math.sqrt(e) : -Infinity;
          if (sc[q] > best) { best = sc[q]; bi = q; }
        }
        m = pred;
        if (bi >= 0) {
          let off = 0;
          if (bi > 0 && bi < 2 * dl && Number.isFinite(sc[bi - 1]) && Number.isFinite(sc[bi + 1])) {
            const a = sc[bi - 1], b = sc[bi], c = sc[bi + 1];
            const den = a - 2 * b + c;
            if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
          }
          m = pred - dl + bi + off;
        }
      }
      if (m <= prev) m = prev + 1;
      if (m >= n) break;
      push(m, T, 1);
      prev = m; prevV = true;
      const Tn = periodAt(m) || T;
      t = m + Tn;
    } else {
      const m = Math.max(t, prev + 1);
      push(m, stepU, 0);
      prev = m; prevV = false;
      t = m + stepU * (0.8 + 0.4 * rand());
    }
  }
  // voiced periods = the actual distance to the next mark, so unshifted
  // synthesis marks land exactly on the analysis marks
  for (let k = 0; k + 1 < count; k++) {
    if (!vo[k] || !vo[k + 1]) continue;
    const gap = pos[k + 1] - pos[k];
    if (gap > 0.7 * per[k] && gap < 1.4 * per[k]) per[k] = gap;
  }
  return { pos: pos.subarray(0, count), per: per.subarray(0, count), voiced: vo.subarray(0, count), count };
}

/** Piecewise-linear monotonic map between output and source positions. */
export class TimeMap {
  readonly dst: Float64Array;
  readonly src: Float64Array;
  private k = 0;
  /** Anchor pairs (dst, src), both increasing. */
  constructor(pairs: [number, number][]) {
    const p = pairs.length ? pairs : [[0, 0], [1, 1]] as [number, number][];
    this.dst = Float64Array.from(p.map((q) => q[0]));
    this.src = Float64Array.from(p.map((q) => q[1]));
  }
  /** Source position for an output position (extrapolates with slope 1 outside). */
  srcAt(t: number): number {
    const d = this.dst, s = this.src, n = d.length;
    if (n === 1 || t <= d[0]) return s[0] + (t - d[0]);
    if (t >= d[n - 1]) return s[n - 1] + (t - d[n - 1]);
    let k = this.k;
    if (k >= n - 1 || d[k] > t) k = 0;
    while (k < n - 2 && d[k + 1] <= t) k++;
    this.k = k;
    const span = d[k + 1] - d[k];
    return span > 0 ? s[k] + ((s[k + 1] - s[k]) * (t - d[k])) / span : s[k + 1];
  }
  /** Output position for a source position. */
  dstAt(t: number): number {
    const d = this.dst, s = this.src, n = s.length;
    if (n === 1 || t <= s[0]) return d[0] + (t - s[0]);
    if (t >= s[n - 1]) return d[n - 1] + (t - s[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= t) lo = m; else hi = m; }
    const span = s[hi] - s[lo];
    return span > 0 ? d[lo] + ((d[hi] - d[lo]) * (t - s[lo])) / span : d[hi];
  }
}

export interface PsolaControl {
  /** Source position for an output position. */
  srcAt(tOut: number): number;
  /** Output position for a source position (inverse of srcAt; keeps unshifted parts phase-aligned). */
  dstAt?(tSrc: number): number;
  /** Pitch factor at a source position (2 = an octave up). */
  ratioAt(tSrc: number): number;
  /** Formant factor (spectral envelope scaling, 1 = unchanged). */
  formantAt?(tSrc: number): number;
  /** Linear gain. */
  gainAt?(tSrc: number): number;
}

/** Resynthesise `ch` (same marks for every channel) into `outLen` samples. */
export function psola(ch: Float32Array[], marks: Marks, outLen: number, ctl: PsolaControl): Float32Array[] {
  const out = ch.map(() => new Float32Array(outLen));
  const wsum = new Float32Array(outLen);
  const nm = marks.count;
  const n = ch[0]?.length ?? 0;
  if (!nm || !n || outLen <= 0) return out;
  const rand = rng(0xbead);
  let tOut = 0;
  let k = 0;
  const nch = ch.length;
  let prevVoiced = false;
  while (tOut < outLen) {
    let tSrc = ctl.srcAt(tOut);
    // nearest mark (the time map is monotonic, so the pointer mostly moves forward)
    if (marks.pos[k] > tSrc) { while (k > 0 && marks.pos[k] > tSrc) k--; }
    while (k < nm - 1 && marks.pos[k + 1] <= tSrc) k++;
    let j = k;
    if (k < nm - 1 && Math.abs(marks.pos[k + 1] - tSrc) < Math.abs(marks.pos[k] - tSrc)) j = k + 1;
    const voiced = marks.voiced[j] === 1;
    const T = marks.per[j];
    const r = voiced ? Math.max(0.25, Math.min(4, ctl.ratioAt(tSrc))) : 1;
    // unshifted, unstretched voiced parts: put the output mark on the analysis
    // mark (start of a voiced run, or no pitch change), so the result stays
    // phase-aligned with the source
    if (voiced && ctl.dstAt && (!prevVoiced || Math.abs(r - 1) < 1e-6)) {
      const slope = (ctl.srcAt(tOut + T) - tSrc) / T;
      if (Math.abs(slope - 1) < 1e-6) {
        const want = ctl.dstAt(marks.pos[j]);
        if (Math.abs(want - tOut) < 0.75 * T && want >= 0) { tOut = want; tSrc = ctl.srcAt(tOut); }
      }
    }
    prevVoiced = voiced;
    const phi = ctl.formantAt ? Math.max(0.5, Math.min(2, ctl.formantAt(tSrc))) : 1;
    // overlapping grains of a shifted pitch partly cancel: a mild make-up gain
    const comp = r === 1 ? 1 : Math.pow(10, ((r < 1 ? 2 : 1.2) * Math.abs(Math.log2(r))) / 20);
    const g = (ctl.gainAt ? ctl.gainAt(tSrc) : 1) * comp;
    const Ts = voiced ? T / r : T * (0.8 + 0.4 * rand());
    const center = voiced ? marks.pos[j] : tSrc;
    // grain half-length: one source period (wider when the output spacing is larger)
    // (for big upward shifts the grains shrink toward the output spacing so
    // fewer misaligned periods overlap, which would cost level)
    const Lsrc = Math.min(2 * T, Math.max(r > 1 ? Math.max(0.7 * T, T / Math.sqrt(r)) : T * Math.min(1.25, 1 / r), 0.6 * Ts * phi));
    const Lout = Lsrc / phi;
    const i0 = Math.max(0, Math.ceil(tOut - Lout)), i1 = Math.min(outLen - 1, Math.floor(tOut + Lout));
    const inv = 1 / Lout;
    if (g > 1e-6) {
      for (let i = i0; i <= i1; i++) {
        const u = (i - tOut) * inv; // -1..1
        const w = 0.5 + 0.5 * Math.cos(Math.PI * u);
        const sp = center + (i - tOut) * phi;
        if (sp < -2 || sp > n + 2) { wsum[i] += w; continue; }
        const wg = w * g;
        for (let c = 0; c < nch; c++) out[c][i] += wg * readCubic(ch[c], sp);
        wsum[i] += w;
      }
    } else {
      for (let i = i0; i <= i1; i++) {
        const u = (i - tOut) * inv;
        wsum[i] += 0.5 + 0.5 * Math.cos(Math.PI * u);
      }
    }
    tOut += Math.max(1, Ts);
  }
  for (let i = 0; i < outLen; i++) {
    const s = wsum[i];
    const k2 = 1 / (s > 0.5 ? s : 0.5 + 0.5 * s);
    for (let c = 0; c < nch; c++) out[c][i] *= k2;
  }
  return out;
}

/** Convenience: constant pitch / formant change of a whole signal (tests, previews). */
export function shiftPitch(ch: Float32Array[], sr: number, f0: ArrayLike<number>, hop: number, semis: number, formantSemis = 0): Float32Array[] {
  const mono = ch[0];
  const marks = pitchMarks(mono, sr, f0, hop);
  const r = Math.pow(2, semis / 12), phi = Math.pow(2, formantSemis / 12);
  return psola(ch, marks, mono.length, { srcAt: (t) => t, dstAt: (t) => t, ratioAt: () => r, formantAt: () => phi });
}

/** Per-sample control from a frame track (frame k at sample k * hop). */
export function frameCtl(track: ArrayLike<number>, hop: number): (t: number) => number {
  return (t: number) => trackAt(track, t / hop);
}
