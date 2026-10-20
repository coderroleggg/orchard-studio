// Fruity Slicer's "Fill gaps" / "Alternate fill gaps" stretching (FL 0x1ff8b0, unit
// BeatSlicer_Tools: Peter Segerdahl's BeatSlicer gap filling), for slices made longer by TS
// with the stretching methods 0 and 1. FL runs it on 16-bit data. See
// docs/research/gen/slicer.md.

const f32 = Math.fround;

/** Round half to even (ARM frintx). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** int16 of a float as FL's gap filling stores it: clamp(round(x * 32768)). */
function toI16(x: number): number {
  const v = roundEven(f32(x * 32768));
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

/**
 * Fill `dst` (dstLen frames, interleaved int16 values as numbers) from the slice `src`
 * (srcLen frames, interleaved int16), `ch` channels, at `sampleRate`; `method` 0 = Fill
 * gaps, 1 = Alternate fill gaps. FL 0x1ff8b0:
 * - a slice whose last 10 ms hold no sample above 1/32768 is copied, the gap stays silent;
 * - else per channel the part after the slice's middle loops back and forth (ping-pong)
 *   between its first and last local peaks of |x|, and the gap (up to the slice length
 *   again) fades with (1 - t)^3 mixed towards a floor of 0.275 (method 0) or a curve going
 *   to 0 (method 1); method 0 ends with a 2 ms fade.
 */
export function fillGapsI16(src: Int16Array, dst: Int16Array, srcLen: number, dstLen: number, ch: number, sampleRate: number, method: number): void {
  const sf = new Float32Array(srcLen * ch);
  for (let i = 0; i < srcLen * ch; i++) sf[i] = f32(src[i] * 3.0517578125e-05);
  const df = new Float32Array(dstLen * ch);
  const limit = srcLen * 2;
  // silent tail (last 10 ms): only values above +1/32768 count as sound
  let silent = true;
  const w10 = Math.trunc((sampleRate * 10 + 500) / 1000);
  for (let i = srcLen * ch - 1, lo = ch * Math.max(0, srcLen - w10); i >= lo; i--) {
    if (sf[i] > 3.0517578125e-05) { silent = false; break; }
  }
  if (silent) {
    const n = Math.min(srcLen * ch, dstLen * ch);
    for (let i = 0; i < n; i++) dst[i] = toI16(sf[i]);
    for (let i = srcLen * ch; i < dstLen * ch; i++) dst[i] = 0;
    return;
  }
  const w20 = Math.max(1, Math.trunc((sampleRate * 20 + 500) / 1000));
  for (let c = 0; c < ch; c++) {
    let start = (srcLen + 1) >> 1, end = srcLen - 1, first = true;
    for (let i = Math.max(0, start - w20), last = srcLen - 2; i <= last; i++) {
      const a = Math.abs(sf[(i - 1) * ch + c] ?? 0), b = Math.abs(sf[i * ch + c]), d = Math.abs(sf[(i + 1) * ch + c]);
      if (a < b && !(b < d)) {
        if (first) { first = false; start = i; }
        end = i;
      }
    }
    const period = Math.max(1, end - start);
    for (let i = 0; i < dstLen; i++) {
      let v: number;
      if (i < start) v = sf[i * ch + c];
      else {
        const k = (period + i - start) % (2 * period);
        v = sf[(start + Math.abs(k - period)) * ch + c];
      }
      if (i >= limit) v = 0;
      else if (i >= srcLen && limit > srcLen) {
        const t = f32((i - srcLen) / (limit - srcLen));
        const om = f32(1 - t);
        let g = f32(f32(om * om) * om);
        if (method & 1) {
          if (t > 0.5) {
            const u = f32(1 - f32(f32(t - 0.5) * 2));
            const d2 = f32(1 - f32(f32(u * u) * u));
            g = f32(g + (0.1375 - g) * d2);
            const u2 = f32(f32(t - 0.5) * 2);
            g = f32(g * f32(1 - f32(f32(u2 * u2) * u2)));
          }
        } else if (t > 0.5) {
          const u = f32(1 - f32(f32(t - 0.5) * 2));
          const d2 = f32(1 - f32(f32(u * u) * u));
          g = f32(g + (0.275 - g) * d2);
        }
        v = f32(v * g);
      }
      df[i * ch + c] = v;
    }
  }
  if ((method & 1) === 0) {
    const end = Math.min(limit, dstLen);
    const w2 = Math.max(0, Math.min(end - 1, Math.trunc((sampleRate * 2 + 500) / 1000)));
    if (w2 > 0) {
      const den = Math.max(1, f32(w2 - 1));
      for (let c = 0; c < ch; c++) {
        for (let i = end - w2; i <= end - 1; i++) {
          let t = f32(f32(i - (end - w2)) / den);
          if (!(t > 0)) t = 0;
          if (!(t < 1)) t = 1;
          const g = f32(1 - t);
          df[i * ch + c] = f32(df[i * ch + c] * g);
        }
      }
    }
  }
  for (let i = 0; i < dstLen * ch; i++) dst[i] = toI16(df[i]);
}

/** FL's float -> int16 sample conversion (0x73eb0 to 16 bit): clamp to +-1, round(x * 32767). */
export function floatToI16(x: number): number {
  const c = x < -1 ? -1 : x > 1 ? 1 : x;
  return roundEven(f32(c * 32767));
}

/** FL's int16 -> float conversion (ippsConvert_16s32f_Sfs, scale 2^-15). */
export function i16ToFloat(v: number): number {
  return f32(v * 3.0517578125e-05);
}
