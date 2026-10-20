// Fitting a picture to BeepMap's limits when it is loaded: FL keeps at most
// "Max bitmap height" rows (each row is a sine of every voice) and refuses a
// bitmap shorter than 3 rows; a taller bitmap is resampled to that height.
//
// FL 2026 for macOS resamples with Apple's vImageScale (FL's IPP-compatible
// library forwards ippiResize_8u_C4R to it, flags EdgeExtend | DoNotTile): a
// Lanczos-3 kernel stretched by the reduction factor s, centres aligned, taps
// beyond the edges folded onto the edge pixels, weights normalised, result
// rounded to 8 bits. Measured with the test host (single-row probes of 6 sizes
// and random pictures of 40): the output position is quantised to 1 / P of a
// source row (floor) with P = 64 for s <= 2, 32 for s <= 4, 16 for s <= 8, else
// 8, which reproduces most sizes to the rounding (mean difference 0.005 / 255 on
// the sizes that fit) and the rest within 0.5 / 255 on average (the probes'
// largest difference is 2 / 255). It is an empirical model of Apple's code, in
// double precision. Widths are kept (a bitmap wider than the engine's limit is
// box-averaged: Orchard's own limit, not FL's).

import { MAXH_MAX, MAXH_MIN, MAX_PIXELS, MAX_W, type Bitmap } from './image';

const A = 3;

function sinc(x: number): number {
  if (x === 0) return 1;
  const p = Math.PI * x;
  return Math.sin(p) / p;
}

function lanczos(x: number): number {
  return Math.abs(x) < A ? sinc(x) * sinc(x / A) : 0;
}

/** Weights (taps folded onto the edge pixels, normalised) of output sample `k` of `dst` from `src` samples. */
function taps(k: number, src: number, dst: number): { lo: number; w: Float64Array } {
  const s = src / dst;
  const P = s <= 2 ? 64 : s <= 4 ? 32 : s <= 8 ? 16 : 8;
  const c = Math.floor(((k + 0.5) * s - 0.5) * P) / P;
  const lo = Math.floor(c - A * s), hi = Math.ceil(c + A * s);
  const first = Math.max(0, lo), last = Math.min(src - 1, hi);
  const w = new Float64Array(last - first + 1);
  let tot = 0;
  for (let j = lo; j <= hi; j++) {
    const v = lanczos((j - c) / s);
    w[Math.min(src - 1, Math.max(0, j)) - first] += v;
    tot += v;
  }
  for (let i = 0; i < w.length; i++) w[i] /= tot;
  return { lo: first, w };
}

/** The rows of `b` resampled to `h` rows (width kept). */
export function resizeRows(b: Bitmap, h: number): Bitmap {
  if (h === b.h) return b;
  const px = new Uint32Array(b.w * h);
  for (let k = 0; k < h; k++) {
    const { lo, w } = taps(k, b.h, h);
    for (let x = 0; x < b.w; x++) {
      let r = 0, g = 0, bl = 0;
      for (let i = 0; i < w.length; i++) {
        const c = b.px[(lo + i) * b.w + x];
        r += w[i] * ((c >>> 16) & 255); g += w[i] * ((c >>> 8) & 255); bl += w[i] * (c & 255);
      }
      const q = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.floor(v + 0.5));
      px[k * b.w + x] = ((q(r) << 16) | (q(g) << 8) | q(bl)) >>> 0;
    }
  }
  return { w: b.w, h, px };
}

/** The columns of `b` box-averaged down to `w` columns (Orchard's width limit). */
function shrinkColumns(b: Bitmap, w: number): Bitmap {
  const px = new Uint32Array(w * b.h);
  const s = b.w / w;
  for (let y = 0; y < b.h; y++) {
    for (let k = 0; k < w; k++) {
      const a = k * s, z = (k + 1) * s;
      let r = 0, g = 0, bl = 0, tot = 0;
      for (let j = Math.floor(a); j < Math.min(b.w, Math.ceil(z)); j++) {
        const f = Math.min(z, j + 1) - Math.max(a, j);
        const c = b.px[y * b.w + j];
        r += f * ((c >>> 16) & 255); g += f * ((c >>> 8) & 255); bl += f * (c & 255); tot += f;
      }
      px[y * w + k] = ((Math.floor(r / tot + 0.5) << 16) | (Math.floor(g / tot + 0.5) << 8) | Math.floor(bl / tot + 0.5)) >>> 0;
    }
  }
  return { w, h: b.h, px };
}

/**
 * The bitmap BeepMap keeps for a loaded picture: at most `maxH` rows (FL's
 * "Max bitmap height", 3..999), at most MAX_W columns and MAX_PIXELS pixels;
 * null for a picture of fewer than 3 rows (FL ignores it and keeps its
 * bitmap).
 */
export function fitBitmap(b: Bitmap, maxH: number): Bitmap | null {
  if (b.w < 1 || b.h < MAXH_MIN) return null;
  const mh = Math.max(MAXH_MIN, Math.min(MAXH_MAX, Math.round(maxH)));
  let out = b;
  if (out.h > mh) out = resizeRows(out, mh);
  const maxW = Math.max(1, Math.min(MAX_W, Math.floor(MAX_PIXELS / out.h)));
  if (out.w > maxW) out = shrinkColumns(out, maxW);
  return out;
}
