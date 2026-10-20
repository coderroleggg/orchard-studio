// FL's single precision helpers shared by the SoundFont Player's voice and filter.

const f32 = Math.fround;

/**
 * FL's single precision clamp (FPC's EnsureRange on a single, used by most of the destination handlers 0x1d7fb0 and by the
 * filter): (|x - lo| + (lo + hi) - |x - hi|) * 0.5 with every step rounded to float32, so a fractional value (from a
 * modulator or the EMU scale) is quantised by the size of the range, e.g. to about 0.001 cents between -12000 and 12000.
 */
export function clampF(x: number, lo: number, hi: number): number {
  const s0 = f32(x);
  const s1 = f32(Math.abs(f32(s0 - lo)));
  const s2 = f32(Math.abs(f32(s0 - hi)));
  return f32(f32(f32(s1 + f32(lo + hi)) - s2) * 0.5);
}
