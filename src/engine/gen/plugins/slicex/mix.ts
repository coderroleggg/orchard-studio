// Slicex's voice gains and mixing (FL: pan / volume to a 2 x 2 matrix 0x212550 with the circular
// pan law kernel 0x44dc, per-control-block ramps 0x1eb6f0, the NEON mixer 0x4c7c), in FL's
// single precision.

import { sincos, sincosf } from './libm';

const f32 = Math.fround;
const SQRT2_F = f32(1.41421354);
const QPI = 0.7853981633974483;
const TINY = 5.960464477539063e-8; // 0x33800000

/**
 * FL 0x212550 (pan law 0): gains [L->L, R->R, R->L, L->R] for panning p (-1..1) and volume v.
 * Centre: L and R at v; otherwise the circular law at v sqrt 2, the far channel blended into the near one.
 */
export function panGains(out: Float32Array, o: number, p: number, v: number): void {
  if (p === 0 && 1 / p > 0) {
    out[o] = v; out[o + 1] = v; out[o + 2] = 0; out[o + 3] = 0;
    return;
  }
  if (v === 0) {
    out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
    return;
  }
  const vv = f32(v * SQRT2_F);
  const a = f32(f32(p + 1) * QPI);
  sincosf(a);
  const gl = f32(sincos.c * vv);
  const gr = f32(sincos.s * vv);
  let s2 = 0, s0 = 0;
  if (p > 0) s0 = f32(1 - f32(gl / v));
  else s2 = f32(1 - f32(gr / v));
  s2 = f32(s2 * 0.5);
  out[o + 2] = f32(gl * s2);
  out[o] = f32(gl * f32(1 - s2));
  s0 = f32(s0 * 0.5);
  out[o + 3] = f32(gr * s0);
  out[o + 1] = f32(gr * f32(1 - s0));
}

/**
 * FL 0x1eb6f0: start a ramp from the previous target to `nv` over n frames, the step capped at
 * `max` per frame. cur / inc / tgt hold the 4 gains at i, 4 + i and 8 + i.
 */
export function rampTo(g: Float32Array, i: number, nv: number, n: number, max: number): void {
  const cur = g[8 + i];
  g[i] = cur;
  let inc = f32(nv - cur);
  g[4 + i] = inc;
  if (inc === 0) return;
  g[8 + i] = nv;
  inc = f32(inc / n);
  g[4 + i] = inc;
  if (Math.abs(inc) > max) {
    inc = inc < 0 ? -max : max;
    g[4 + i] = inc;
    const t = f32(cur + f32(inc * n));
    g[8 + i] = t;
    if (Math.abs(t) < TINY) {
      g[8 + i] = 0;
      g[4 + i] = f32(-cur / n);
    }
  }
}

/**
 * FL's mixer 0x4c7c: add n frames of the stereo voice (sL / sR from `s`) into dL / dR at `d` with the
 * gain matrix g[0..3] ramping by g[4..7] per frame (local; FL advances the stored gains separately).
 */
export function mixRamp(sL: Float32Array, sR: Float32Array, s: number, dL: Float32Array, dR: Float32Array, d: number, n: number, g: Float32Array): void {
  let c0 = g[0], c1 = g[1], c2 = g[2], c3 = g[3];
  const i0 = g[4], i1 = g[5], i2 = g[6], i3 = g[7];
  if (i0 !== 0 || i1 !== 0 || i2 !== 0 || i3 !== 0) {
    for (let k = 0; k < n; k++) {
      const l = sL[s + k], r = sR[s + k];
      const a = f32(c0 * l), b = f32(c1 * r), c = f32(c2 * r), e = f32(c3 * l);
      c0 = f32(c0 + i0); c1 = f32(c1 + i1); c2 = f32(c2 + i2); c3 = f32(c3 + i3);
      dL[d + k] = f32(dL[d + k] + f32(a + c));
      dR[d + k] = f32(dR[d + k] + f32(b + e));
    }
    return;
  }
  if (c2 === 0 && c3 === 0) {
    for (let k = 0; k < n; k++) {
      dL[d + k] = f32(dL[d + k] + f32(c0 * sL[s + k]));
      dR[d + k] = f32(dR[d + k] + f32(c1 * sR[s + k]));
    }
    return;
  }
  for (let k = 0; k < n; k++) {
    const l = sL[s + k], r = sR[s + k];
    dL[d + k] = f32(dL[d + k] + f32(f32(c0 * l) + f32(c2 * r)));
    dR[d + k] = f32(dR[d + k] + f32(f32(c1 * r) + f32(c3 * l)));
  }
}
