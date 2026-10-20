// FL's windowed-sinc resampling kernel (TResampler mode 3; arm64 drivers 0x200710 / 0x200bd0, NEON
// kernels 0x2bb8 / 0x2cbc), emulated lane by lane in single precision:
//
// - Per output frame (double): f = max(fraction, 1e-25) (ippsThreshold_LT_64f_I), window phases
//   a0 = pi/2 - f pi/N, a1 = a0 - pi/N, sinc phases b0 = f pi/S, b1 = b0 + pi/S (S = speed when it is above
//   1, else 1); their sines (vvsin); two more terms of each by the recurrence s' = 2 cos(d) s - s_prev;
//   x = f pi, x - pi, x - 2 pi, x + pi as floats.
// - N / 2 iterations of 4 taps (k + 1 + 2j, k - 2j, k + 2 + 2j, k - 1 - 2j): reciprocal of x by FRECPE and
//   two Newton steps (FRECPS fused), weight (0.36 + c + 0.64 c^2)(s_sinc / x) with c the window term,
//   forward and backward taps summed separately, then (forward + backward) x 0.5.

import type { FlResampler } from './resampler';

const f32 = Math.fround;

export interface SincState { piN: number; c2N: number; piS: number; c2S: number }
export function sincInit(): SincState { return { piN: 0, c2N: 0, piS: Math.PI, c2S: -2 }; }

// ----------------------------------------------------------- NEON emulation

const fb = new Float32Array(1);
const ib = new Uint32Array(fb.buffer);

/** ARM FRECPE (single precision, 8-bit estimate, round to nearest, denormals not flushed). */
export function frecpe(x: number): number {
  fb[0] = x;
  const u = ib[0];
  const sign = u & 0x80000000;
  const exp = (u >>> 23) & 0xff;
  let frac = u & 0x7fffff;
  if (exp === 0xff) { if (frac !== 0) return NaN; ib[0] = sign; return fb[0]; }
  // zero, or so small that the reciprocal overflows (|x| < 2^-128): infinity
  if (exp === 0 && frac < 0x200000) { ib[0] = (sign | 0x7f800000) >>> 0; return fb[0]; }
  let e = exp;
  if (e === 0) {
    if ((frac & 0x400000) === 0) { e = -1; frac = (frac << 2) & 0x7fffff; } else frac = (frac << 1) & 0x7fffff;
  }
  const a = (256 + (frac >>> 15)) * 2 + 1;
  const est = (Math.floor(524288 / a) + 1) >>> 1; // 256..511
  let re = 253 - e;
  let rf = (est & 0xff) << 15;
  if (re === 0) rf = 0x400000 | (rf >>> 1);
  else if (re === -1) { rf = 0x200000 | (rf >>> 2); re = 0; }
  ib[0] = (sign | (re << 23) | rf) >>> 0;
  return fb[0];
}

/** ARM FRECPS: 2 - a b with one rounding (0 x inf gives 2). */
export function frecps(a: number, b: number): number {
  if ((a === 0 && !Number.isFinite(b) && !Number.isNaN(b)) || (b === 0 && !Number.isFinite(a) && !Number.isNaN(a))) return 2;
  // a b is exact in double for floats; 2 - a b is exact too while a b stays near 1 (always here); else fall back
  return f32(2 - a * b);
}

/** FL's reciprocal: estimate plus two Newton steps (the kernel's frecpe / frecps / fmul / fadd / fsub). */
function recip(x: number): number {
  const e = frecpe(x);
  const r1 = f32(e * frecps(e, x));
  const p = f32(x * r1);
  const q = f32(r1 * p);
  return f32(f32(r1 + r1) - q);
}

const P2F = f32(-6.2831854820251465);
const W36 = f32(0.36000001430511475);
const W64 = f32(0.6399999856948853);
const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;

const W = new Float32Array(1024);

/** The frame's tap weights (FL's per-frame setup and the kernel's weight lanes) into W; returns N / 2. */
export function sincWeights(r: FlResampler, x: number): number {
  const st = r.sinc;
  const half = r.pts >> 1;
  const f = x < 1e-25 ? 1e-25 : x;
  const a0 = HALF_PI + f * -st.piN, a1 = a0 - st.piN;
  const b0 = f * st.piS, b1 = b0 + st.piS;
  const sa0 = Math.sin(a0), sa1 = Math.sin(a1), sb0 = Math.sin(b0), sb1 = Math.sin(b1);
  let d = st.c2N * sa0 - sa1;
  const sW1 = f32(d);
  const sW2 = f32(st.c2N * d - sa0);
  d = st.c2S * sb0 - sb1;
  const sB1 = f32(d);
  const sB2 = f32(st.c2S * d - sb0);
  const xp = f * PI;
  // lanes: x = [xp - pi, xp, xp - 2 pi, xp + pi]; q00 = [sB2, sin b1, sW2, sin a1]; q10 = [sB1, sin b0, sW1, sin a0]
  let x0 = f32(xp - PI), x1 = f32(xp), x2 = f32((xp - PI) - PI), x3 = f32(xp + PI);
  let a00 = sB2, a01 = f32(sb1), a02 = sW2, a03 = f32(sa1);
  let a10 = sB1, a11 = f32(sb0), a12 = sW1, a13 = f32(sa0);
  const c2S = f32(st.c2S), c2N = f32(st.c2N);
  const p2 = f32(6.2831854820251465);
  let o = 0;
  for (let j = 0; j < half; j++) {
    const r0 = recip(x0), r1 = recip(x1), r2 = recip(x2), r3 = recip(x3);
    // first half: taps k + 1 + 2j (lane 0) and k - 2j (lane 1), from q10
    const w0 = f32(f32(W36 + f32(a12 + f32(a12 * f32(W64 * a12)))) * f32(a10 * r0));
    const w1 = f32(f32(W36 + f32(a13 + f32(a13 * f32(W64 * a13)))) * f32(a11 * r1));
    const n0 = f32(f32(c2S * a00) - a10), n1 = f32(f32(c2S * a01) - a11), n2 = f32(f32(c2N * a02) - a12), n3 = f32(f32(c2N * a03) - a13);
    a10 = n0; a11 = n1; a12 = n2; a13 = n3;
    x0 = f32(P2F + x0); x1 = f32(p2 + x1); x2 = f32(P2F + x2); x3 = f32(p2 + x3);
    // second half: taps k + 2 + 2j (lane 0) and k - 1 - 2j (lane 1), from q00
    const u0 = f32(f32(W36 + f32(a02 + f32(a02 * f32(W64 * a02)))) * f32(a00 * r2));
    const u1 = f32(f32(W36 + f32(a03 + f32(a03 * f32(W64 * a03)))) * f32(a01 * r3));
    const m0 = f32(f32(c2S * a10) - a00), m1 = f32(f32(c2S * a11) - a01), m2 = f32(f32(c2N * a12) - a02), m3 = f32(f32(c2N * a13) - a03);
    a00 = m0; a01 = m1; a02 = m2; a03 = m3;
    W[o++] = w0; W[o++] = w1; W[o++] = u0; W[o++] = u1;
  }
  return half;
}

/** One output sample of channel c at index k with the frame's weights (edge: through FL's edge window). */
export function sincApply(r: FlResampler, c: Float32Array, k: number, edge: boolean, half: number): number {
  let fw = 0, bw = 0;
  for (let j = 0, o = 0; j < half; j++, o += 4) {
    const sf1 = edge ? r.at(c, k + 1 + 2 * j) : c[k + 1 + 2 * j];
    const sb1 = edge ? r.at(c, k - 2 * j) : c[k - 2 * j];
    fw = f32(fw + f32(sf1 * W[o]));
    bw = f32(bw + f32(sb1 * W[o + 1]));
    const sf2 = edge ? r.at(c, k + 2 + 2 * j) : c[k + 2 + 2 * j];
    const sb2 = edge ? r.at(c, k - 1 - 2 * j) : c[k - 1 - 2 * j];
    fw = f32(fw + f32(sf2 * W[o + 2]));
    bw = f32(bw + f32(sb2 * W[o + 3]));
  }
  return f32(f32(0.5) * f32(fw + bw));
}
