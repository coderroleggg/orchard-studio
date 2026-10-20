// ippsTone_Direct_32fc as FL's IPP library computes it (Shared/dsp_ippv2_x64,
// arm64 0x1ee50): magn * (cos p + i sin p) for p = phase + i * w,
// w = float(rFreq * 2 pi in double). 16-sample groups run four NEON lanes
// (phases p, p + w, fma(2, w, p), fma(3, w, p), each vector + float(4w),
// re-wrapped after a group with fma(trunc(p / 2 pi), -2 pi, p)) through the
// library's cephes-style sincos (octant j = trunc(|p| 4 / pi), one fused pi / 4
// step, the cosine polynomial as ((z^2 P(z)) - z / 2) + 1, the sine polynomial
// fused); the n % 16 tail uses Apple's __sincosf_stret with phase += w and a
// double compare against 2 pi. phase[0] is updated. Harmless's stereo tremolo
// (Gen_Render 0x730dc) is its only user.

import { fma32 } from '../harmor/ipp';
import { sincosf } from '../poizone/applemath';
import { bitsF, f32 } from './fl';

const TN_4OPI = bitsF(0x3fa2f983), TN_PIO4 = bitsF(0x3f490fdb), TN_I2PI = bitsF(0x3e22f983), TN_N2PI = bitsF(0xc0c90fdb);
const TN_C0 = bitsF(0x37ccf5ce), TN_C1 = bitsF(0xbab6061a), TN_C2 = bitsF(0x3d2aaaa5);
const TN_S0 = bitsF(0x394ca1f9), TN_S1 = bitsF(0x3c08839e), TN_S2 = bitsF(0xbe2aaaa3);
const TWO_PI_D = 6.283185307179586;

const P = new Float32Array(4);
const SC = [0, 0];

/** One lane: [cos, sin] of p into out[o], out[o + 1] (times m). */
function lane(p: number, m: number, out: Float32Array, o: number): void {
  const a = Math.abs(p);
  const t = f32(a * TN_4OPI);
  const j = t !== t ? 0 : t >= 4294967295 ? 4294967295 : Math.trunc(t);
  const j1 = (j + 1) >>> 0;
  const y = (j1 & ~1) >>> 0;
  const x = fma32(-y, TN_PIO4, a);
  const z = f32(x * x);
  let c = fma32(z, TN_C0, TN_C1);
  c = fma32(c, z, TN_C2);
  let u = f32(f32(z * z) * c);
  u = fma32(-z, 0.5, u);
  const cp = f32(u + 1);
  let s = fma32(-z, TN_S0, TN_S1);
  s = fma32(s, z, TN_S2);
  const sp = fma32(f32(z * x), s, x);
  const sel = (j1 & 2) === 0;
  let sn = sel ? sp : cp;
  let cs = sel ? cp : sp;
  if (((j1 & 4) === 0) === (p < 0)) sn = -sn;
  if ((((j - 1) >>> 0) & 4) === 0) cs = -cs;
  out[o] = f32(cs * m);
  out[o + 1] = f32(sn * m);
}

export function tone32fc(dst: Float32Array, n: number, magn: number, rFreq: number, phase: Float32Array): void {
  const m = f32(magn);
  const w = f32(f32(rFreq) * TWO_PI_D);
  const p0 = phase[0];
  P[0] = p0; P[1] = f32(p0 + w); P[2] = fma32(2, w, p0); P[3] = fma32(3, w, p0);
  let i = 0;
  if (n >= 16) {
    const w4 = f32(w * 4);
    for (; n - i >= 16; i += 16) {
      for (let q = 0; q < 4; q++) {
        if (q > 0) for (let l = 0; l < 4; l++) P[l] = P[l] + w4;
        for (let l = 0; l < 4; l++) lane(P[l], m, dst, 2 * (i + 4 * q + l));
      }
      for (let l = 0; l < 4; l++) {
        const v = f32(P[l] + w4);
        P[l] = fma32(Math.trunc(f32(v * TN_I2PI)), TN_N2PI, v);
      }
    }
  }
  let s = P[0];
  for (; i < n; i++) {
    sincosf(s, SC);
    dst[2 * i] = f32(SC[1] * m);
    dst[2 * i + 1] = f32(SC[0] * m);
    const v = f32(s + w);
    s = v > TWO_PI_D ? f32(v - TWO_PI_D) : v;
  }
  phase[0] = s;
}
