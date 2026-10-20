// Fruity Slicer 2's parameter value texts, as FL's wrapper formats them
// (Fruity Slicer 2_x64.dylib 0x6b630: the control value normalised to the engine's
// float32 0..1 value, then "%.1f%%", "%.1f dB", "%d ST", "%d Cents"; checked against
// the test host's sweeps of every parameter block).

const f32 = Math.fround;

/** FL's slice gain law (engine 0xd0ac, wrapper 0x6b410): 0.98435 v^3 - 0.231573 v^2 + 0.247223 v, x 10^0.3. */
export const GAIN_K = f32(Math.pow(10, 0.3));

/** One decimal like Delphi's Format('%.1f'): a value that rounds to zero has no minus sign. */
function fix1(x: number): string {
  const t = x.toFixed(1);
  return t === '-0.0' ? '0.0' : t;
}

/** "12.5%": the engine value x 100 (float32), one decimal. */
export function pctText(v: number): string {
  return `${fix1(f32(f32(v) * 100))}%`;
}

/** Pan: (v - 0.5) x 200 (float32), one decimal ("-100.0%" .. "100.0%"). */
export function panText(v: number): string {
  return `${fix1(f32(f32(f32(v) - 0.5) * 200))}%`;
}

/** Gain in dB as FL's wrapper shows it (polynomial in double, x 10^0.3 in float32, 20 log10 in double). */
export function gainDb(v: number): number {
  const d = f32(v);
  const p = f32(((0.98435 * d) * d) * d - (0.231573 * d) * d + 0.247223 * d);
  const g = f32(p * GAIN_K);
  return g === 0 ? -Infinity : f32(20 * Math.log10(g));
}

export function gainText(v: number): string {
  const db = gainDb(v);
  return db === -Infinity ? '-Inf dB' : `${fix1(db)} dB`;
}

/** Inverse of gainDb (typed-in values): FL's wrapper solves it with Newton steps (0x6b4e0). */
export function gainFromDb(db: number): number {
  if (!(db > -200)) return 0;
  const target = Math.pow(10, db / 20) / GAIN_K;
  let v = 0.5;
  for (let i = 0; i < 20; i++) {
    const f = ((0.98435 * v) * v) * v - (0.231573 * v) * v + 0.247223 * v - target;
    const df = 2.95305 * v * v - 0.463146 * v + 0.247223;
    v -= f / df;
    if (Math.abs(f) < 1e-6) break;
  }
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
