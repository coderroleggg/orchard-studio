// FL's 6-point hermite resampling kernel (TResampler mode 2; arm64 0x1ff750 / 0x1ff990): a 5th-order
// polynomial in z = fraction - 0.5 over the even / odd sums of the samples k - 2 .. k + 3 (FL's
// coefficient table at 0x38cbc8), single precision with each Horner step multiplied by z in double.

import type { FlResampler } from './resampler';

const f32 = Math.fround;
const C = [-0.0416666679084301, 0.2083333283662796, -0.4166666567325592, 0.02083333395421505, -0.0625, 0.0416666679084301,
  0.1041666641831398, -0.6875, 1.5416666269302368, -0.0520833320915699, 0.40625, -0.3541666567325592, -0.0234375,
  0.1588541716337204, -1.359375, 0.01171875, -0.09765625, 0.5859375].map(f32);

function sum(a: number, p: number, q: number, s: number): number {
  return f32(f32(f32(C[a] * p) + f32(C[a + 1] * q)) + f32(C[a + 2] * s));
}

/** One output sample of channel c at index k with fraction x (edge: through FL's edge window). */
export function hermiteKernel(r: FlResampler, c: Float32Array, k: number, x: number, edge: boolean): number {
  const y0 = edge ? r.at(c, k - 2) : c[k - 2];
  const y1 = edge ? r.at(c, k - 1) : c[k - 1];
  const y2 = edge ? r.at(c, k) : c[k];
  const y3 = edge ? r.at(c, k + 1) : c[k + 1];
  const y4 = edge ? r.at(c, k + 2) : c[k + 2];
  const y5 = edge ? r.at(c, k + 3) : c[k + 3];
  const z = x - 0.5;
  const e1 = f32(y0 + y5), o1 = f32(y0 - y5);
  const e2 = f32(y1 + y4), o2 = f32(y1 - y4);
  const e3 = f32(y2 + y3), o3 = f32(y2 - y3);
  let t = f32(sum(0, o1, o2, o3) * z);
  t = f32(f32(sum(3, e1, e2, e3) + t) * z);
  t = f32(f32(sum(6, o1, o2, o3) + t) * z);
  t = f32(f32(sum(9, e1, e2, e3) + t) * z);
  t = f32(f32(sum(12, o1, o2, o3) + t) * z);
  return f32(sum(15, e1, e2, e3) + t);
}
