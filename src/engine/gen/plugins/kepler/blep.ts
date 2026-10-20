// Band-limited impulse tables of the Kepler / Kepler Exo DCOs (engine.dylib 0x38268 with the kernel
// generator 0xfe9c). The DCO is a band-limited impulse oscillator: impulses are added into a
// ring buffer from a table of the impulse response of a 16th-order Butterworth low-pass (eight
// cascaded RBJ biquads, double precision), and a leaky integrator turns the impulse train into a
// saw / pulse (see slaveosc.ts).
//
// Table layout: 1025 rows (sub-sample positions k / 1024), each row holding the kernel sampled at
// j * 1024 - k, j = 0..L-1 (zero for a negative index), L = 8 n floats, stored twice in a row (2 L floats)
// so that a ring buffer read starting anywhere in the row needs no wrap. n = 2 ("eco": 16 points) and
// n = 4 (32 points) are built; the oscillators use n = 2 by default.

import { f32 } from './fmath';

/** Butterworth section Q factors of a 16th-order filter (engine.dylib 0xbf430). */
const Q = [0.50241929, 0.52249861, 0.56694403, 0.64682178, 0.78815462, 1.0606777, 1.7224471, 5.1011486];

/**
 * 0xfe9c: the impulse response of the filter cascade for omega0 = pi / div, `count` samples after `pre`
 * samples of pre-roll, scaled so that its maximum is `gain`, with the last `fade` samples faded out linearly.
 */
export function kernel(div: number, count: number, pre: number, fade: number, gain: number): Float32Array {
  const total = pre + count;
  const buf = new Float32Array(total);
  const w0 = (0.5 / div) * 6.283185307179586;
  const sn = Math.sin(w0), cs = Math.cos(w0);
  // per section: [x1, x2, y1, y2, b0, b1, b0', a1, a2]
  const st = new Float64Array(8 * 9);
  for (let s = 0; s < 8; s++) {
    const q2 = Q[s] + Q[s];
    const alpha = sn / q2;
    const a0 = alpha + 1;
    const om = 1 - cs;
    const b1 = om / a0;
    const b0 = (om * 0.5) / a0;
    const a1 = (cs * -2) / a0;
    const a2 = (1 - alpha) / a0;
    const o = s * 9;
    st[o + 4] = b0; st[o + 5] = b1; st[o + 6] = b0; st[o + 7] = a1; st[o + 8] = a2;
  }
  let mx = 0;
  for (let n = 0; n < total; n++) {
    let x = n === 0 ? 1 : 0;
    for (let s = 0; s < 8; s++) {
      const o = s * 9;
      const b0 = st[o + 4], b0c = st[o + 6], a1 = st[o + 7], a2 = st[o + 8];
      const x1 = st[o], x2 = st[o + 1], y1 = st[o + 2], y2 = st[o + 3];
      // d4 = b0 * x1; d4 = fma(b0, x, d4); d4 = fma(b0c, x2, d4); d4 = fnms(a1, y1, d4); y = fnms(a2, y2, d4)
      let d = b0 * x1;
      d = fmaD(b0, x, d);
      d = fmaD(b0c, x2, d);
      d = fmaD(-a1, y1, d);
      const y = fmaD(-a2, y2, d);
      st[o] = x; st[o + 1] = x1; st[o + 2] = y; st[o + 3] = y1;
      x = y;
    }
    if (mx < x) mx = x;
    buf[n] = f32(x);
  }
  const m = f32(mx);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = f32(f32(buf[pre + i] * gain) / m);
  const fm = Math.min(fade, count);
  if (fm >= 1) {
    const f = f32(fm);
    for (let i = 0; i < fm; i++) {
      const k = count - fm + i;
      out[k] = f32(f32(1 - f32(i / f)) * out[k]);
    }
  }
  return out;
}

import { fmaD } from './fmath';

/** 0x38268(n): the table for a kernel length of 8 n points. */
function buildTable(n: number): Float32Array {
  const L = n << 3;
  const half = n >>> 1;
  const N = n << 13;
  const pre = Math.trunc((half << 10) * 3 / 4);
  const k = kernel(half << 10, N, pre, 0x400, f32(1 / half));
  const rows = 1025;
  const stride = L * 2;
  const t = new Float32Array(rows * stride);
  for (let r = 0; r < rows; r++) {
    for (let j = 0; j < L; j++) {
      const idx = -r + j * 1024;
      const v = idx < 0 ? 0 : k[idx];
      t[r * stride + j] = v;
      t[r * stride + L + j] = v;
    }
  }
  return t;
}

let tab2: Float32Array | null = null;
let tab4: Float32Array | null = null;

/** The shared tables (built on first use, like the engine's static initialiser). */
export function blepTable(n: 2 | 4): Float32Array {
  if (n === 2) return (tab2 ??= buildTable(2));
  return (tab4 ??= buildTable(4));
}
