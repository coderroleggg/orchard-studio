// WSOLA time stretching (waveform-similarity overlap-add, Verhelst & Roelands
// 1993) for Newtime. The warp map is split at the markers into segments;
// every segment starts exactly on its marker (a 1.5 ms crossfade placed just
// before it), so attacks stay where they are and are not smeared, and the
// audio between markers is stretched by overlap-adding 40 ms Hann frames
// whose source positions are searched (+-12 ms, coarse-to-fine normalised
// cross-correlation on the mono mix) for the best continuation of the
// previous frame. Pitch is unchanged; stereo channels share the positions.

export interface WsolaOptions {
  /** Frame length (s). */
  winSec?: number;
  /** Search tolerance (s). */
  tolSec?: number;
  /** Crossfade before each segment start (s). */
  xfSec?: number;
}

function ncc(x: Float32Array, a: number, b: number, len: number, step: number): number {
  const n = x.length;
  let s = 0, e = 0;
  if (a >= 0 && b >= 0 && a + len < n && b + len < n) {
    for (let j = 0; j < len; j += step) {
      const vb = x[b + j];
      s += x[a + j] * vb;
      e += vb * vb;
    }
  } else {
    for (let j = 0; j < len; j += step) {
      const ia = a + j, ib = b + j;
      const va = ia >= 0 && ia < n ? x[ia] : 0;
      const vb = ib >= 0 && ib < n ? x[ib] : 0;
      s += va * vb;
      e += vb * vb;
    }
  }
  return e > 1e-12 ? s / Math.sqrt(e) : 0;
}

/**
 * Stretch source [a, b) into `outLen` samples. Returns `xf + outLen`
 * samples per channel: a fade-in pre-roll of `xf` samples (source a-xf..a),
 * then the segment, whose last `xf` samples fade out.
 */
export function wsolaSegment(ch: Float32Array[], mono: Float32Array, a: number, b: number, outLen: number, sr: number, opt: WsolaOptions = {}): Float32Array[] {
  const xf = Math.max(1, Math.round((opt.xfSec ?? 0.0015) * sr));
  const W = Math.max(64, 2 * Math.round(((opt.winSec ?? 0.04) * sr) / 2));
  const Hs = W / 2;
  const tol = Math.max(4, Math.round((opt.tolSec ?? 0.012) * sr));
  const total = xf + outLen;
  const out = ch.map(() => new Float32Array(total));
  const wsum = new Float32Array(total);
  const nch = ch.length;
  const inLen = Math.max(1, b - a);
  const alpha = outLen / inLen;
  const plain = Math.abs(alpha - 1) < 1e-9;
  const win = new Float32Array(W);
  for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / W);
  // frames read only this segment's audio (+ the crossfade): a transient
  // just after the segment must not leak into its tail
  const pMin = a - xf, pMax = Math.max(pMin, b + xf - W);
  let prevP = 0;
  for (let f = 0; ; f++) {
    const o = f * Hs - xf; // output position of the frame start, relative to the segment start
    if (o >= outLen) break;
    const nominal = o < 0 ? a + o : a + o / alpha;
    let p: number;
    if (f === 0 || plain) p = Math.round(f === 0 ? a - xf : nominal);
    else {
      const nat = prevP + Hs;
      const c0 = Math.round(nominal);
      // coarse search (every 4th lag, every 4th sample), then refine
      const lo = Math.max(pMin, c0 - tol), hi = Math.min(pMax, c0 + tol);
      let best = -Infinity, bp = Math.max(pMin, Math.min(pMax, c0));
      for (let cnd = lo; cnd <= hi; cnd += 4) {
        const sc = ncc(mono, nat, cnd, Hs, 4);
        if (sc > best) { best = sc; bp = cnd; }
      }
      const cc = bp;
      best = -Infinity;
      for (let cnd = Math.max(lo, cc - 4); cnd <= Math.min(hi, cc + 4); cnd++) {
        const sc = ncc(mono, nat, cnd, Hs, 1);
        if (sc > best) { best = sc; bp = cnd; }
      }
      p = bp;
    }
    prevP = p;
    const base = o + xf; // buffer index of the frame start
    for (let i = 0; i < W; i++) {
      const bi = base + i;
      if (bi < 0) continue;
      if (bi >= total) break;
      const w = f === 0 && i < Hs ? 1 : win[i]; // the first frame starts flat (exactly on the marker)
      const si = p + i;
      wsum[bi] += w;
      for (let c = 0; c < nch; c++) {
        const s = ch[c];
        out[c][bi] += si >= 0 && si < s.length ? w * s[si] : 0;
      }
    }
  }
  for (let i = 0; i < total; i++) {
    const s = wsum[i];
    if (s > 1e-6) { const k = 1 / Math.max(s, 0.5); for (let c = 0; c < nch; c++) out[c][i] *= k; }
  }
  // crossfades: fade-in over the pre-roll, fade-out over the last xf samples
  for (let i = 0; i < xf; i++) {
    const g = i / xf;
    for (let c = 0; c < nch; c++) out[c][i] *= g;
  }
  for (let i = 0; i < xf && i < outLen; i++) {
    const g = i / xf;
    const bi = total - 1 - i;
    for (let c = 0; c < nch; c++) out[c][bi] *= g;
  }
  return out;
}

/**
 * Warp a signal through anchor pairs (source sample, output sample), both
 * increasing; the output has `outLen` samples.
 */
export function warpAudio(ch: Float32Array[], sr: number, anchors: { src: number; dst: number }[], outLen: number, opt: WsolaOptions = {}): Float32Array[] {
  const nch = ch.length;
  const res = ch.map(() => new Float32Array(Math.max(0, outLen)));
  if (!nch || outLen <= 0) return res;
  const mono = nch === 1 ? ch[0] : (() => {
    const m = new Float32Array(ch[0].length);
    for (let i = 0; i < m.length; i++) m[i] = 0.5 * (ch[0][i] + ch[1][i]);
    return m;
  })();
  const pts = anchors.slice().sort((p, q) => p.dst - q.dst);
  for (let k = 0; k < pts.length - 1; k++) {
    const A = Math.round(pts[k].dst), B = Math.round(pts[k + 1].dst);
    const a = Math.round(pts[k].src), b = Math.round(pts[k + 1].src);
    const len = B - A;
    if (len <= 0) continue;
    if (b <= a) continue; // degenerate segment: leave silence
    const seg = wsolaSegment(ch, mono, a, b, len, sr, opt);
    const xf = seg[0].length - len;
    for (let c = 0; c < nch; c++) {
      const s = seg[c], d = res[c];
      for (let i = 0; i < s.length; i++) {
        const oi = A - xf + i;
        if (oi < 0) continue;
        if (oi >= outLen) break;
        d[oi] += s[i];
      }
    }
  }
  return res;
}
