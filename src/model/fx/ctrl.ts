// Maths shared by FL's controller plugins (Peak, X-Y, X-Y-Z Controller).

/** Tension knob (-128..128) -> FL's tension speed k = (1001^(|t|/128) - 1) / 10 (0 at the centre, 100 at the ends). */
export function tensionSpeed(t: number): number {
  return (Math.pow(1001, Math.abs(t) / 128) - 1) * 0.1;
}

/**
 * FL's tension curve with speed k and direction sign: t > 0 rises fast,
 * t < 0 slowly (the formula language's Tension(x, +-k)); straight at sign 0.
 */
export function tensionCurve(x: number, sign: number, k: number): number {
  if (sign === 0 || k <= 0) return x;
  return sign > 0 ? (k + 1 - Math.pow(k + 1, 1 - x)) / k : (Math.pow(k + 1, x) - 1) / k;
}

/** FL's controller resolution: values are sent as integers of 2^30. */
export const CTRL_FULL = 1073741824;
