// Fruity Slicer's slicing (FL 2026, Fruity Slicer_x64.dylib, arm64 slice): auto-slicing
// with FL's beat detector (class TBeatDetector, unit DSP_BeatDetection), beat-division
// slicing and the zero-crossing search, ported from FL's code. Pure functions on the
// sample's float channels (FL converts the loaded sample to float before slicing).
// See docs/research/gen/slicer.md.
//
// Auto-slicing (FL 0x64ec0 -> 0x64ad0, detector 0x80a00 / 0x80d40 / 0x81000 / 0x81ca0):
// - analysis copy of the sample: peak-normalised to 1 (0x77b20), mixed to mono (0x73eb0),
//   resampled to 44.1 kHz (0x76d30), then 4 passes of a "spring" high-pass (0x6d3e0:
//   y += v += k (x - y), v *= 0.96, out = x - y, k = 9.134e-5);
// - 128-point frames every 16 samples, Hamming window (0x6eca0 type 3) normalised by its
//   sum, real FFT (IPP ippsFFTFwd_RToPack_32f), magnitudes of bins 1..63 (ippsMagnitude),
//   squared; low band = RMS of bins 1..5, high band = RMS of bins 6..63 (0x81350);
// - per band an envelope (20 / 15 ms forward max-hold, instant attack, 15 / 10 ms
//   exponential release) and its relative rise per frame scaled by the AUTO LOW / HIGH
//   threshold factor 2^(wheel/100) - 1 (0x81410 / 0x815f0); the two curves' maximum is the
//   onset curve;
// - peaks: wherever the curve reaches 1, the slice goes back to the earliest frame within
//   28 frames above 0.75, then on the original sample forward to the first point louder
//   than 5 % of the peak and back to the nearest zero crossing within 20 ms (0x81830 /
//   0x81ae0); slices closer than 60 ms to the end are dropped, the next search starts 60 ms
//   after the slice.
// FL computes the FFT, magnitudes and sums with Intel IPP (FL's Shared/dsp_ippv2): here in
// double precision rounded to FL's float32 steps (differences are at the float rounding
// level and only matter for onsets exactly at a threshold).

const f32 = Math.fround;

/** Analysis rate (FL resamples the analysis copy to 44.1 kHz). */
const ANALYSIS_RATE = 44100;
const FRAME = 128;
const HOP = 16;
/** Frames per millisecond at the analysis rate (44100 / 16 / 1000). */
const FRAMES_PER_MS = f32(2.75625);

/** Round half to even (ARM frintx). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** FL's Hamming window (0x6eca0, type 3): 0.53836 - 0.46164 cos(2 pi i / (N - 1)), float32. */
const WINDOW = (() => {
  const w = new Float32Array(FRAME);
  const d = 6.283185307179586 / (FRAME - 1);
  for (let i = 0; i < FRAME; i++) w[i] = 0.53836 - 0.46164 * Math.cos(d * i);
  return w;
})();
/** 1 / window sum (FL: ippsSum_32f accurate, then f32(1 / f32(sum))). */
const WINDOW_NORM = (() => {
  let s = 0;
  for (let i = 0; i < FRAME; i++) s += WINDOW[i];
  return f32(1 / f32(s));
})();

// ------------------------------------------------------------------ 128-point real FFT
const FFT_COS = new Float64Array(FRAME / 2);
const FFT_SIN = new Float64Array(FRAME / 2);
for (let i = 0; i < FRAME / 2; i++) {
  FFT_COS[i] = Math.cos((2 * Math.PI * i) / FRAME);
  FFT_SIN[i] = -Math.sin((2 * Math.PI * i) / FRAME);
}
const BITREV = (() => {
  const r = new Uint8Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    let x = i, y = 0;
    for (let b = 0; b < 7; b++) { y = (y << 1) | (x & 1); x >>= 1; }
    r[i] = y;
  }
  return r;
})();

/** Complex FFT in place (double precision), size FRAME. */
function fft128(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < FRAME; i++) {
    const j = BITREV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= FRAME; size <<= 1) {
    const half = size >> 1, step = FRAME / size;
    for (let s = 0; s < FRAME; s += size) {
      for (let k = 0; k < half; k++) {
        const c = FFT_COS[k * step], sn = FFT_SIN[k * step];
        const a = s + k, b = a + half;
        const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

// ------------------------------------------------------------------ zero crossings
/** The sign FL's zero-crossing search uses (|x| < 2^-14 counts as zero). */
function signOf(x: number): number {
  if (Math.abs(x) < 6.103515625e-05) return 0;
  return x < 0 || Object.is(x, -0) ? -1 : 1;
}

/**
 * FL's zero-crossing search around `pos` within [lo, hi] (0x77070 -> 0x6df90 stereo /
 * 0x6e360 mono): the nearest crossing below and above (both channels at once preferred
 * for stereo, else one channel), else the quietest frame. Returns the frame.
 */
export function zeroCrossIn(channels: readonly Float32Array[], pos: number, lo: number, hi: number): number {
  const len = channels[0]?.length ?? 0;
  if (len <= 0) return pos;
  pos = Math.max(0, Math.min(len - 1, pos));
  lo = Math.max(0, Math.min(pos, lo));
  hi = Math.min(len - 1, Math.max(hi, pos));
  const loOfs = lo - pos, hiOfs = hi - pos;
  const MAXINT = 0x7fffffff;
  const closer = (best: number, cand: number) => (Math.abs(best) > Math.abs(cand) ? cand : best);
  if (channels.length >= 2) {
    const L = channels[0], R = channels[1];
    let best2 = MAXINT, best1 = MAXINT, minPos = 0, minRms = 2147483648;
    let s0 = 0, s1 = 0;
    const evalAt = (k: number) => {
      const a = L[pos + k], b = R[pos + k];
      s0 = signOf(a); s1 = signOf(b);
      const rms = f32(Math.sqrt(f32(f32(f32(0 + f32(a * a)) + f32(b * b)) * 0.5)));
      if (rms < minRms) { minRms = rms; minPos = k; }
    };
    const crossing = (k: number) => {
      const o0 = s0, o1 = s1;
      evalAt(k);
      return (-o0 === s0 || o0 === 0 ? 1 : 0) + (-o1 === s1 || o1 === 0 ? 1 : 0);
    };
    evalAt(0);
    if (loOfs <= -1) {
      let k = 0;
      do {
        k--;
        const t = crossing(k);
        if (t > 0) {
          if (t === 2) { best2 = closer(best2, k + 1); break; }
          best1 = closer(best1, k + 1);
        }
      } while (k > loOfs);
    }
    evalAt(0);
    if (hiOfs >= 1) {
      let k = 0;
      do {
        k++;
        const t = crossing(k);
        if (t > 0) {
          if (t === 2) { best2 = closer(best2, k - 1); break; }
          best1 = closer(best1, k - 1);
        }
      } while (k < hiOfs);
    }
    return pos + (best2 !== MAXINT ? best2 : best1 !== MAXINT ? best1 : minPos);
  }
  const X = channels[0];
  let best = MAXINT, minPos = 0, minAbs = 2147483648, s = 0;
  const evalAt = (k: number) => {
    const a = X[pos + k];
    s = signOf(a);
    const m = Math.abs(a);
    if (m < minAbs) { minAbs = m; minPos = k; }
  };
  const crossing = (k: number) => {
    const o = s;
    evalAt(k);
    return -o === s || o === 0;
  };
  evalAt(0);
  if (loOfs <= -1) {
    let k = 0;
    do { k--; if (crossing(k)) { best = closer(best, k + 1); break; } } while (k > loOfs);
  }
  evalAt(0);
  if (hiOfs >= 1) {
    let k = 0;
    do { k++; if (crossing(k)) { best = closer(best, k - 1); break; } } while (k < hiOfs);
  }
  return pos + (best !== MAXINT ? best : minPos);
}

/** FL's "Zero-cross check slices" for one slice (0x77260): nearest crossing within +-50 ms. */
export function zeroCross(channels: readonly Float32Array[], sampleRate: number, pos: number): number {
  const w = roundEven(sampleRate * 0.05);
  return zeroCrossIn(channels, pos, pos - w, pos + w);
}

// ------------------------------------------------------------------ beat detector
/** FL's peak (0x753c0): the largest |x| over all channels. */
function peakOf(channels: readonly Float32Array[]): number {
  let p = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > p) p = a; }
  return p;
}

/** The mono, normalised, 44.1 kHz, high-passed analysis signal (FL 0x80d40). */
function analysisSignal(channels: readonly Float32Array[], sampleRate: number): { data: Float32Array; peak: number } {
  const len = channels[0].length;
  const peak = f32(peakOf(channels));
  const g = peak > 0 ? f32(1 / peak) : 1;
  let data: Float32Array = new Float32Array(len);
  if (channels.length >= 2) {
    const L = channels[0], R = channels[1];
    for (let i = 0; i < len; i++) data[i] = f32(f32(f32(L[i] * g) + f32(R[i] * g)) * 0.5);
  } else {
    const X = channels[0];
    for (let i = 0; i < len; i++) data[i] = f32(X[i] * g);
  }
  if (sampleRate !== ANALYSIS_RATE) data = resampleTo44k(data, ANALYSIS_RATE / sampleRate);
  // 4 passes of FL's spring high-pass (0x6d3e0), state reset per pass
  const k = f32(9.134e-05), damp = f32(0.96);
  for (let pass = 0; pass < 4; pass++) {
    let y = 0, v = 0;
    for (let i = 0; i < data.length; i++) {
      const x = data[i];
      v += (x - y) * k;
      y += v;
      v *= damp;
      data[i] = f32(x - y);
    }
  }
  return { data, peak };
}

/** FL's 6-point polynomial kernel (TResampler kernel 2, 0x1a58c0), coefficients 0x2a45d0. */
const K2 = new Float32Array([
  -0.0416666679084301, 0.2083333283662796, -0.4166666567325592, 0.02083333395421505, -0.0625, 0.0416666679084301,
  0.1041666641831398, -0.6875, 1.5416666269302368, -0.0520833320915699, 0.40625, -0.3541666567325592,
  -0.0234375, 0.1588541716337204, -1.359375, 0.01171875, -0.09765625, 0.5859375,
]);

/** Kernel 2 at frame k + f of `x` (taps k-2..k+3; outside the data the first / last frame). */
function kernel2(x: Float32Array, k: number, f: number): number {
  const last = x.length - 1;
  const at = (j: number) => x[j < 0 ? 0 : j > last ? last : j];
  const pm2 = at(k - 2), pm1 = at(k - 1), p0 = at(k), p1 = at(k + 1), p2 = at(k + 2), p3 = at(k + 3);
  const t = f - 0.5;
  const s2 = f32(pm2 + p3), s3 = f32(pm2 - p3), s4 = f32(pm1 + p2), s5 = f32(pm1 - p2), s6 = f32(p0 + p1), s7 = f32(p0 - p1);
  const odd = (i: number) => f32(f32(f32(K2[i] * s3) + f32(K2[i + 1] * s5)) + f32(K2[i + 2] * s7));
  const even = (i: number) => f32(f32(f32(K2[i] * s2) + f32(K2[i + 1] * s4)) + f32(K2[i + 2] * s6));
  let h = f32(odd(0) * t);
  h = f32(f32(even(3) + h) * t);
  h = f32(f32(odd(6) + h) * t);
  h = f32(f32(even(9) + h) * t);
  h = f32(f32(odd(12) + h) * t);
  return f32(even(15) + h);
}

/**
 * Resampling of the analysis copy to 44.1 kHz (FL 0x76d30 -> 0x766e0, mode 2): FL's TResampler
 * with kernel 2 at speed sr / 44100 over round(length x 44100 / sr) frames, in blocks of 1024
 * (positions pos + i x speed inside, per sample near the edges).
 */
function resampleTo44k(x: Float32Array, ratio: number): Float32Array {
  const n = roundEven(x.length * ratio);
  const y = new Float32Array(Math.max(0, n));
  const speed = 1 / ratio;
  const len = x.length;
  let pos = 0;
  for (let o = 0; o < n; o += 1024) {
    const m = Math.min(1024, n - o);
    const fast = roundEven(pos) >= 5 && pos + m * speed < len - 6;
    for (let i = 0; i < m; i++) {
      const p = fast ? pos + i * speed : pos;
      const k = Math.trunc(p);
      y[o + i] = kernel2(x, k, p - k);
      if (!fast) pos += speed;
    }
    if (fast) pos += m * speed;
  }
  return y;
}

/** Per-frame band levels (FL 0x81000): [low, high] per frame. */
function bandLevels(data: Float32Array): { frames: number; low: Float32Array; high: Float32Array } {
  const frames = Math.trunc((data.length + FRAME + HOP - 1) / HOP);
  const need = (frames - 1) * HOP + FRAME;
  let x = data;
  if (need > data.length) { x = new Float32Array(need); x.set(data); }
  const low = new Float32Array(frames), high = new Float32Array(frames);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  const pw = new Float32Array(63);
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    for (let j = 0; j < FRAME; j++) { re[j] = f32(x[o + j] * WINDOW[j]); im[j] = 0; }
    fft128(re, im);
    for (let b = 1; b <= 63; b++) {
      const mag = f32(Math.sqrt(re[b] * re[b] + im[b] * im[b]));
      const s = f32(mag * WINDOW_NORM);
      pw[b - 1] = f32(s * s);
    }
    let sl = 0;
    for (let b = 0; b < 5; b++) sl += pw[b];
    let sh = 0;
    for (let b = 5; b < 63; b++) sh += pw[b];
    low[f] = f32(Math.sqrt(f32(f32(sl) / 5)));
    high[f] = f32(Math.sqrt(f32(f32(sh) / 58)));
  }
  return { frames, low, high };
}

/** One band's onset curve (FL 0x815f0). */
function bandOnset(feat: Float32Array, frames: number, a: number, decay: number, thr: number, win: number): Float32Array {
  const dst = new Float32Array(frames);
  const t = f32(thr * 5);
  const rel = f32(1 - decay);
  let env = 0;
  for (let i = 0; i < frames; i++) {
    const v = feat[i];
    const m = Math.min(win, frames - 1 - i);
    for (let j = 0; j < m; j++) if (dst[i + 1 + j] < v) dst[i + 1 + j] = v;
    const v2 = dst[i] > v ? dst[i] : v;
    env = v2 > env ? v2 : f32(f32(env * decay) + f32(v2 * rel));
    dst[i] = env;
  }
  const floor = f32(SILENCE / a);
  let prev = floor;
  for (let i = 0; i < frames; i++) {
    const x = dst[i];
    dst[i] = x >= prev ? f32(f32(f32(x / prev) - 1) * t) : 0;
    prev = x > floor ? x : floor;
  }
  return dst;
}

/** FL's -200 dB floor: f32(exp(f32(-200 * f32(ln 10 / 20)))). */
const SILENCE = f32(Math.exp(f32(-200 * f32(0.115129254758358))));

/** AUTO wheel 0..200 -> FL's threshold factor 2^(v/100) - 1 (0x64ad0). */
export function thresholdFactor(wheel: number): number {
  return f32(Math.exp(f32(f32(wheel) * f32(0.01)) * 0.6931471805599453) - 1);
}

/** The AUTO LOW / HIGH presets of the Slicing menu (Dull, Medium, Sharp). */
export const AUTO_PRESETS: readonly (readonly [number, number])[] = [[33, 33], [100, 100], [167, 167]];

/**
 * FL's auto-slicing: slice start frames of the sample for the AUTO LOW / HIGH wheels
 * (0..200). The positions are FL's detector output in order; FL's slice list check
 * (drop slices past the end, one slice at 0 when none) is the caller's.
 */
export function autoSlice(channels: readonly Float32Array[], sampleRate: number, low: number, high: number): number[] {
  const len = channels[0]?.length ?? 0;
  if (len <= 0) return [];
  const { data, peak } = analysisSignal(channels, sampleRate);
  const { frames, low: fl, high: fh } = bandLevels(data);
  const ratio = f32(sampleRate / ANALYSIS_RATE);
  // onset curves (0x81410): low band 15 ms release / 20 ms hold, high band 10 / 15 ms
  const d0 = f32(Math.exp(f32(-1 / f32(f32(FRAMES_PER_MS * 1) * 15))));
  const w0 = roundEven(f32(FRAMES_PER_MS * 20));
  const on = bandOnset(fl, frames, f32(1.8), d0, f32(thresholdFactor(low) * 0.9), w0);
  const d1 = f32(Math.exp(f32(-1 / f32(f32(FRAMES_PER_MS * 1) * 10))));
  const w1 = roundEven(f32(FRAMES_PER_MS * 15));
  const on1 = bandOnset(fh, frames, f32(20.34482765197754), d1, thresholdFactor(high), w1);
  for (let i = 0; i < frames; i++) if (!(on[i] > on1[i])) on[i] = on1[i];
  // peak picking (0x81830)
  const minDist = roundEven(60 * sampleRate * 0.001);
  const zcWin = roundEven(20 * sampleRate * 0.001);
  const thr = f32(0.05 * peak);
  const nch = channels.length;
  const rmsAt = (p: number) => {
    let s = 0;
    for (let c = 0; c < nch; c++) { const x = channels[c][p]; s = f32(s + f32(x * x)); }
    return f32(Math.sqrt(f32(s / nch)));
  };
  const toSource = (apos: number) => {
    const p = roundEven(f32(f32(apos - 64) * ratio));
    return p < 0 ? 0 : p > len - 1 ? len - 1 : p;
  };
  const out: number[] = [];
  let i = 0;
  while (i < frames) {
    if (!(on[i] >= 1)) { i++; continue; }
    let best = i;
    for (let j = i, lo = Math.max(0, i - 28); j >= lo; j--) if (on[j] > 0.75) best = j;
    // refine on the source (0x81ae0)
    let p = toSource(best * HOP + 64);
    if (p > 0) {
      while (len - 1 > p) {
        if (rmsAt(p) > thr) break;
        p++;
      }
      p = zeroCrossIn(channels, p, Math.max(0, p - zcWin), p);
    } else p = 0;
    if (len - minDist >= p) out.push(p);
    const next = roundEven((roundEven(f32(f32(p + minDist) / ratio)) + 64) * 0.0625);
    i = Math.max(i + 1, next);
  }
  return out;
}

// ------------------------------------------------------------------ beat divisions
/**
 * FL's beat-division slicing (0x64f60, menu Beat / 1/2 / 1/3 / 1/4 / 1/6 beat): slices
 * every (length / beats) / div frames (at least 16), named "k" and "k - Beat n".
 */
export function beatSlices(frames: number, beats: number, div: number): { pos: number; name: string }[] {
  const out: { pos: number; name: string }[] = [];
  if (frames <= 0 || !(beats > 0) || div <= 0) return out;
  let step = f32(f32(f32(frames) / f32(beats)) / f32(div));
  if (!(step > 16)) step = 16;
  let t = 0;
  for (let k = 0; frames > roundEven(t); k++) {
    out.push({ pos: roundEven(t), name: k % div === 0 ? `${k + 1} - Beat ${Math.trunc(k / div) + 1}` : `${k + 1}` });
    t = f32(t + step);
  }
  return out;
}
