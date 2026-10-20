// Fruity Slicer's offline sample processing (FL 2026, Fruity Slicer_x64.dylib, arm64):
// the loaded sample + slices + settings -> the processed sample the voices play, in FL's
// order and arithmetic. Pure functions, used by the engine and the editor display.
// See docs/research/gen/slicer.md.
//
// FL's chain after slicing (0x63810): slice layout (0x64570), reverse (0x648e0 -> 0x77d70),
// declick (0x65220 -> 0x78790 -> 0x6d4c0, amount 0.7), stretch (0x65490: TS / PS) and fades
// (0x652d0 -> 0x78160). The sample is float32 (FL converts it on load).

import { fillGapsI16, floatToI16, i16ToFloat } from './fillgaps';

const f32 = Math.fround;

export interface SliceIn {
  /** Slice start in frames of the original sample. */
  pos: number;
  /** REV: the slice plays backwards (its frames are reversed in the processed sample). */
  rev: boolean;
}

export interface ProcOptions {
  /** TS wheel -20000..20000: stretch factor 2^(ts / 10000). */
  ts: number;
  /** PS wheel -1200..1200 cents. */
  ps: number;
  /** Stretching method 0..7 (0 Fill gaps, 1 Alternate fill gaps, 2..7 elastique modes). */
  method: number;
  declick: boolean;
  /** ATT / DEC 0..100 ms. */
  fadeIn: number;
  fadeOut: number;
}

export interface ProcSlice {
  /** Start in the processed sample. */
  pos: number;
  /** Length in the processed sample (FL slice +0x28). */
  len: number;
  /** Length before stretching (FL slice +0x20). */
  srcLen: number;
}

export interface Processed {
  channels: Float32Array[];
  sampleRate: number;
  slices: ProcSlice[];
}

/**
 * Time stretching / pitch shifting of one slice with FL's elastique modes (FL calls its
 * proprietary Shared/elastique_x64.dylib): `input` = the slice frames, `outLen` = frames to
 * produce, `pitch` = frequency factor 2^(PS / 1200), `mode` = FL's mode code.
 */
export type ElastiqueFn = (input: readonly Float32Array[], outLen: number, pitch: number, mode: number, sampleRate: number) => Float32Array[];

/** Round half to even (ARM frintx). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** FL's stretch factor of the TS wheel (0x60d20): f32(exp(f32(ts / 10000) * ln 2)). */
export function stretchFactor(ts: number): number {
  return f32(Math.exp(f32(f32(ts) / 10000) * 0.6931471805599453));
}

/** FL's TS value for a stretch ratio (0x60d60): ln(ratio) * 10000 / ln 2, float32. */
export function tsForRatio(ratio: number): number {
  return f32((Math.log(f32(ratio)) * 10000) / 0.6931471805599453);
}

/**
 * FL's slice layout (0x64570): slices at or past the end are dropped (from the first such
 * slice on), an empty list becomes one slice at 0; each slice runs to the next one (at
 * least 1 frame), the last to the end.
 */
export function sliceLayout(frames: number, positions: readonly number[]): { pos: number; len: number }[] {
  if (frames <= 0) return [];
  let n = positions.length;
  for (let i = 0; i < positions.length; i++) if (!(frames > positions[i])) { n = i; break; }
  const pos = n > 0 ? positions.slice(0, n) : [0];
  return pos.map((p, i) => ({ pos: p, len: i + 1 < pos.length ? Math.max(1, pos[i + 1] - p) : frames - p }));
}

// ------------------------------------------------------------------ declick
/**
 * FL's declicker on the end of a range (0x6d4c0 with the reverse flag, as Slicer calls it):
 * from the last non-zero frame back over round(sr * 0.04 * amount) frames, a one-pole
 * low-pass whose coefficient rises exponentially from 2 / sr to 1 is subtracted (the tail
 * converges to 0) and the last millisecond fades out with a half cosine. Per channel.
 */
function declickEnd(ch: Float32Array, a: number, b: number, sr: number, amount: number): void {
  const n = b - a + 1;
  const len = roundEven(sr * f32(0.04) * f32(amount));
  // skip trailing zeros
  let last = b, left = n;
  for (let i = 0; i < n; i++) {
    if (ch[b - i] !== 0) { last = b - i; left = n - i; break; }
    if (i === n - 1) return;
  }
  const m = Math.min(len, left);
  if (m <= 0) return;
  const d8 = (10.001067880874992 / (0.6931471805599453 * m)) * 0.6931471805599453;
  const d9 = 2 / sr;
  let lp = 0;
  let w22 = Math.min(roundEven(sr * 0.001), m);
  const d10 = 1 / (w22 + 1);
  w22 = m - w22;
  let g = 1;
  let p = last - (m - 1);
  for (let i = 1; i <= m; i++, p++) {
    let c = d9 * Math.exp(i * d8);
    if (!(c < 1)) c = 1;
    const x = ch[p];
    lp = lp + c * (x - lp);
    if (i > w22) g = (Math.cos((i - w22) * d10 * 3.141592653589793) + 1) * 0.5;
    ch[p] = f32((x - lp) * g);
  }
}

// ------------------------------------------------------------------ volume ramps (fades)
/**
 * FL's volume ramp (0x78190) over frames [a, b] from `from` to `to`; mode 2 linear, 3
 * logarithmic-like curve (`curve`, FL passes 10 for DEC), 4 half cosine (used instead when
 * the range lasts at most 50 ms, flag 0x100).
 */
function ramp(chs: Float32Array[], sr: number, a: number, b: number, from: number, to: number, curve: number, flags: number): void {
  const len = chs[0].length;
  let mode = flags & 0xff;
  if (flags & 0x100) {
    const ms = ((b - a + 1) * 1000) / sr;
    if (!(ms > 50)) mode = 4;
  }
  const d14 = 1 / (b - a + 2);
  const d10 = f32(to - from);
  let d13 = 0, down = false, neg = false;
  if (mode === 3) {
    if (curve === 0) curve = 10;
    neg = curve < 0;
    curve = Math.abs(curve);
    d13 = 1 / curve;
    down = to < from;
  }
  const lo = Math.max(0, a), hi = Math.min(b, len - 1);
  const fromD = f32(from);
  const cf = f32(curve);
  const lnc = Math.log(f32(cf + 1));
  for (let i = lo; i <= hi; i++) {
    let t = (i - a + 1) * d14;
    if (mode === 4) t = (Math.cos((1 - t) * 3.141592653589793) + 1) * 0.5;
    else if (mode === 3) {
      if (down) t = 1 - t;
      if (neg) t = f32(Math.log(f32(f32(t * curve) + 1)) / lnc);
      else t = f32(Math.exp(f32(t) * lnc) - 1) * d13;
      if (down) t = 1 - t;
    }
    const gain = t * d10 + fromD;
    for (const ch of chs) ch[i] = f32(ch[i] * gain);
  }
}

// ------------------------------------------------------------------ pipeline
/**
 * The processed sample (FL's 0x648e0, 0x65220, 0x65490, 0x652d0 after loading / any
 * change): reversed slices, declick, TS / PS stretching, fades.
 */
export function processSlices(
  src: { channels: readonly Float32Array[]; sampleRate: number },
  slices: readonly SliceIn[],
  o: ProcOptions,
  elastique?: ElastiqueFn,
): Processed {
  const sr = src.sampleRate;
  const frames = src.channels[0]?.length ?? 0;
  let chs = src.channels.map((c) => Float32Array.from(c));
  const lay = sliceLayout(frames, slices.map((s) => s.pos));
  const out: ProcSlice[] = lay.map((l) => ({ pos: l.pos, len: l.len, srcLen: l.len }));
  const rev = lay.map((_, i) => !!slices[i]?.rev);
  if (frames <= 0) return { channels: chs, sampleRate: sr, slices: out };

  // reverse (0x648e0)
  for (let i = 0; i < out.length; i++) {
    if (!rev[i]) continue;
    const a = out[i].pos, b = a + out[i].len - 1;
    for (const ch of chs) for (let x = a, y = b; x < y; x++, y--) { const t = ch[x]; ch[x] = ch[y]; ch[y] = t; }
  }
  const declick = () => {
    if (!o.declick) return;
    for (const s of out) if (s.len > 0) for (const ch of chs) declickEnd(ch, s.pos, s.pos + s.len - 1, sr, 0.7);
  };
  declick();

  // stretch (0x65490)
  if (o.ts !== 0 || o.ps !== 0) {
    const factor = stretchFactor(o.ts);
    const gaps = o.method < 2 && o.ts !== 0;
    const nch = chs.length;
    const old = chs;
    const oldPos = out.map((s) => s.pos);
    const total = roundEven(frames * factor);
    for (let i = out.length - 1; i >= 0; i--) {
      const s = out[i];
      s.pos = roundEven(s.pos * factor);
      s.len = i + 1 < out.length ? Math.max(1, out[i + 1].pos - s.pos) : total - s.pos;
    }
    chs = old.map(() => new Float32Array(total));
    if (gaps) {
      // FL converts the sample to 16 bit, fills / copies each slice, converts back
      const src = new Int16Array(frames * nch);
      for (let c = 0; c < nch; c++) for (let f = 0; f < frames; f++) src[f * nch + c] = floatToI16(old[c][f]);
      const dst = new Int16Array(total * nch);
      for (let i = 0; i < out.length; i++) {
        const s = out[i];
        const n = Math.min(s.len, total - s.pos);
        if (n <= 0) continue;
        const sIn = src.subarray(oldPos[i] * nch, (oldPos[i] + s.srcLen) * nch);
        const dOut = dst.subarray(s.pos * nch, (s.pos + n) * nch);
        if (s.len > s.srcLen) fillGapsI16(sIn, dOut, s.srcLen, n, nch, sr, s.srcLen < 150 ? 0 : o.method);
        else dOut.set(src.subarray(oldPos[i] * nch, Math.min(src.length, (oldPos[i] + n) * nch)));
      }
      for (let c = 0; c < nch; c++) for (let f = 0; f < total; f++) chs[c][f] = i16ToFloat(dst[f * nch + c]);
    }
    if (o.method >= 2 || o.ps !== 0) {
      const pitch = Math.exp(o.ps * (0.057762265046662105 / 100));
      const mode = o.method >= 2 ? ELASTIQUE_MODES[o.method] ?? 0 : 0;
      // FL's input: the gap-filled slice, else the original slice (its new length with PS)
      const from = gaps ? chs.map((c) => Float32Array.from(c)) : old;
      for (let i = 0; i < out.length; i++) {
        const s = out[i];
        const at = gaps ? s.pos : oldPos[i];
        const inLen = Math.min(o.ps !== 0 ? s.len : s.srcLen, from[0].length - at);
        const input = from.map((c) => c.subarray(at, at + Math.max(0, inLen)));
        const n = Math.min(s.len, total - s.pos);
        const res = elastique ? elastique(input, n, pitch, mode, sr) : input;
        for (let c = 0; c < nch; c++) {
          const r = res[Math.min(c, res.length - 1)];
          chs[c].fill(0, s.pos, s.pos + n);
          chs[c].set(r.subarray(0, Math.min(n, r.length)), s.pos);
        }
      }
      declick();
    }
  }

  // fades (0x652d0)
  if (o.fadeIn !== 0 || o.fadeOut !== 0) {
    const perMs = f32(sr / 1000);
    const att = roundEven(f32(f32(o.fadeIn) * perMs));
    const dec = roundEven(f32(f32(o.fadeOut) * perMs));
    for (const s of out) {
      if (!(s.len > 0)) continue;
      let n = Math.min(att, s.len);
      ramp(chs, sr, s.pos, s.pos + n - 1, 0, 1, 0, 0x102);
      n = Math.min(dec, s.len);
      const a = s.pos + s.len - n;
      ramp(chs, sr, a, a + n - 1, 1, 0, 10, 0x103);
    }
  }
  return { channels: chs, sampleRate: sr, slices: out };
}

/**
 * FL's elastique mode codes for the stretching methods 2..7 (table 0x29ca7b + method; FL's
 * TTimeStretcher 0x7ee20 opens codes 6..9 with ElPro_CreateInstance and the byte at
 * 0x29ca72 + code, i.e. 0, 0, 2, 2, 4, 5 for the methods 2..7). The stand-in ignores it.
 */
export const ELASTIQUE_MODES: Record<number, number> = { 2: 6, 3: 6, 4: 7, 5: 7, 6: 8, 7: 9 };
