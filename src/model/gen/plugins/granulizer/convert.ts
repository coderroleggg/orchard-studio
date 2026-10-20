// Fruity Granulizer's parameter conversions (FL 2026, Fruity Granulizer_x64.dylib, arm64):
// the control values -> milliseconds / percent maps of its value texts and DSP (0x62460,
// 0x624e0, 0x6cfb0) with FL's float32 / double steps. See docs/research/gen/granulizer.md.

const f32 = Math.fround;

/** Round half to even (ARM frintx). */
export function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Round half away from zero (FL's percent texts). */
export function roundAway(x: number): number {
  const r = Math.floor(Math.abs(x) + 0.5);
  return x < 0 ? -r : r;
}

/**
 * Time controls (grain attack / hold, transient hold; 0..500) -> whole milliseconds (FL 0x62460):
 * 10 (51^(v / 500) - 1), exponential from 0 to 500 ms.
 */
export function msOf(v: number): number {
  const x = f32(v * 0.002);
  const d = f32(Math.exp(x * 3.9318256327243257) - 1.0);
  return roundEven(f32(d * 10.0));
}

/**
 * Spacing controls (grain spacing 125..1000, wave spacing -1000..1000) -> FL's integer scale where
 * 256 = 100 % (FL 0x624e0): 76.8 (11^(|v| / 1000) - 1) with the control's sign.
 */
export function spacingOf(v: number): number {
  const a = Math.abs(v);
  const x = f32(a * 0.001);
  const d = f32(Math.exp(x * 2.3978952727983707) - 1.0);
  const r = roundEven(d * 76.8);
  return v < 0 ? -r : r;
}

/** Milliseconds -> samples as FL's ms-to-samples conversion (0x6cfb0): float32 of ms x rate x f32(0.001). */
export function msToSamples(ms: number, rate: number): number {
  return f32(ms * rate * 0.0010000000474974513);
}

/** Percent text of v out of max (FL: v x 100 / max rounded half away from zero). */
export function percentText(v: number, max: number): string {
  const p = roundAway((v * 100) / max);
  return `${p === 0 ? 0 : p}%`;
}

/** Typed-in percentage -> control value. */
export const fromPct = (max: number) => (typed: number) => Math.round((typed / 100) * max);

/** Time text: whole milliseconds. */
export function msText(v: number): string {
  return `${msOf(v)}ms`;
}

/** Typed-in milliseconds -> control value (FL 0x63490 / 0x634f0: 500 ln(1 + ms / 10) / ln 51). */
export function msParse(typed: number): number {
  const t = Math.min(500, Math.max(0, typed));
  return Math.round((Math.log(t * 0.1 + 1) / 3.9318256327243257) * 500);
}

/** Spacing text: the scale / 256 as a percentage. */
export function spacingText(v: number): string {
  return percentText(spacingOf(v), 256);
}

/** Typed-in spacing percentage -> control value (inverse of spacingOf). */
export function spacingParse(typed: number): number {
  const f = (Math.abs(typed) / 100) * 256;
  const v = Math.round((Math.log(f / 76.8 + 1) / 2.3978952727983707) * 1000);
  return typed < 0 ? -v : v;
}
