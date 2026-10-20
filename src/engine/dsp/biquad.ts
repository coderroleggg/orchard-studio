// Biquad design and processing.
//
// Analog second-order prototypes are described as rational functions of the
// normalised Laplace variable p = s / w0. Two discretisations are provided:
//  - bilinear transform with pre-warping at w0 (the "Audio EQ Cookbook" shapes)
//  - magnitude-matched design (poles mapped exactly, numerator matched to the
//    analog magnitude at DC, at the centre frequency and at Nyquist), which
//    removes the cramping of the bilinear transform near Nyquist.

export interface BiquadCoefs {
  b0: number; b1: number; b2: number;
  a1: number; a2: number; // a0 normalised to 1
}

export function identity(): BiquadCoefs {
  return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
}

/** Analog prototype H(p) = (n2 p^2 + n1 p + n0) / (d2 p^2 + d1 p + d0), p = s / w0. */
export interface Analog2 {
  n2: number; n1: number; n0: number;
  d2: number; d1: number; d0: number;
}

export type ProtoKind = 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peaking' | 'lowshelf' | 'highshelf' | 'allpass';

/** Cookbook prototypes. `q` is the analog Q; gainDb used by peaking / shelves. */
export function prototype(kind: ProtoKind, q: number, gainDb = 0): Analog2 {
  const A = Math.pow(10, gainDb / 40);
  const iq = 1 / Math.max(1e-6, q);
  switch (kind) {
    case 'lowpass': return { n2: 0, n1: 0, n0: 1, d2: 1, d1: iq, d0: 1 };
    case 'highpass': return { n2: 1, n1: 0, n0: 0, d2: 1, d1: iq, d0: 1 };
    case 'bandpass': return { n2: 0, n1: iq, n0: 0, d2: 1, d1: iq, d0: 1 }; // 0 dB peak
    case 'notch': return { n2: 1, n1: 0, n0: 1, d2: 1, d1: iq, d0: 1 };
    case 'allpass': return { n2: 1, n1: -iq, n0: 1, d2: 1, d1: iq, d0: 1 };
    case 'peaking': return { n2: 1, n1: A * iq, n0: 1, d2: 1, d1: iq / A, d0: 1 };
    case 'lowshelf': {
      const sA = Math.sqrt(A);
      return { n2: A, n1: A * sA * iq, n0: A * A, d2: A, d1: sA * iq, d0: 1 };
    }
    case 'highshelf': {
      const sA = Math.sqrt(A);
      return { n2: A * A, n1: A * sA * iq, n0: A, d2: 1, d1: sA * iq, d0: A };
    }
  }
}

/** |H(j x)|^2 of an analog prototype at normalised frequency x = f / f0. */
export function analogMag2(h: Analog2, x: number): number {
  const x2 = x * x;
  const nr = h.n0 - h.n2 * x2, ni = h.n1 * x;
  const dr = h.d0 - h.d2 * x2, di = h.d1 * x;
  return (nr * nr + ni * ni) / (dr * dr + di * di);
}

/** Bilinear transform with frequency pre-warping so that p = 1 maps to f0. */
export function bilinear(h: Analog2, f0: number, fs: number): BiquadCoefs {
  const w0 = (2 * Math.PI * Math.min(f0, fs * 0.49999)) / fs;
  const K = 1 / Math.tan(w0 / 2); // p = K (1 - z^-1)/(1 + z^-1)
  const K2 = K * K;
  const b0 = h.n2 * K2 + h.n1 * K + h.n0;
  const b1 = 2 * (h.n0 - h.n2 * K2);
  const b2 = h.n2 * K2 - h.n1 * K + h.n0;
  const a0 = h.d2 * K2 + h.d1 * K + h.d0;
  const a1 = 2 * (h.d0 - h.d2 * K2);
  const a2 = h.d2 * K2 - h.d1 * K + h.d0;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * Magnitude-matched second-order design (after M. Vicanek, "Matched Second
 * Order Digital Filters", 2016): poles by impulse invariance, numerator from
 * the analog magnitude at DC, f0 and Nyquist.
 */
export function matched(h: Analog2, f0: number, fs: number): BiquadCoefs {
  const w0 = (2 * Math.PI * f0) / fs;
  // poles of the denominator d2 p^2 + d1 p + d0 (in units of w0)
  let a1: number, a2: number;
  if (h.d2 === 0) {
    // first-order denominator: pole at -d0/d1
    const pr = -h.d0 / h.d1;
    a1 = -Math.exp(pr * w0);
    a2 = 0;
  } else {
    const wp = Math.sqrt(h.d0 / h.d2); // natural frequency (normalised)
    const zeta = h.d1 / (2 * Math.sqrt(h.d0 * h.d2));
    const w = wp * w0;
    const e = Math.exp(-zeta * w);
    a1 = zeta <= 1 ? -2 * e * Math.cos(Math.sqrt(1 - zeta * zeta) * w) : -2 * e * Math.cosh(Math.sqrt(zeta * zeta - 1) * w);
    a2 = e * e;
  }
  // squared magnitude of the denominator on the unit circle in the phi basis
  const A0 = (1 + a1 + a2) * (1 + a1 + a2);
  const A1 = (1 - a1 + a2) * (1 - a1 + a2);
  const A2 = -4 * a2;
  const s = Math.sin(Math.min(w0, Math.PI * 0.99999) / 2);
  const phi1 = s * s, phi0 = 1 - phi1, phi2 = 4 * phi0 * phi1;
  const nyq = fs / 2 / f0; // analog frequency (normalised) that Nyquist represents
  const H0 = analogMag2(h, 0);
  const Hn = analogMag2(h, nyq);
  const Hc = analogMag2(h, 1);
  const B0 = A0 * H0;
  const B1 = A1 * Hn;
  const R = (A0 * phi0 + A1 * phi1 + A2 * phi2) * Hc;
  let B2 = (R - B0 * phi0 - B1 * phi1) / phi2;
  const sB0 = Math.sqrt(Math.max(0, B0)), sB1 = Math.sqrt(Math.max(0, B1));
  const W = 0.5 * (sB0 + sB1);
  if (W * W + B2 < 0) B2 = -W * W; // keep the numerator realisable
  const b0 = 0.5 * (W + Math.sqrt(W * W + B2));
  const b1 = 0.5 * (sB0 - sB1);
  const b2 = b0 !== 0 ? -B2 / (4 * b0) : 0;
  return { b0, b1, b2, a1, a2 };
}

/** Exact notch: zeros on the unit circle at w0, matched poles, unity DC gain. */
export function matchedNotch(q: number, f0: number, fs: number): BiquadCoefs {
  const m = matched(prototype('notch', q), f0, fs);
  const w0 = (2 * Math.PI * Math.min(f0, fs * 0.4999)) / fs;
  const c = Math.cos(w0);
  const g = (1 + m.a1 + m.a2) / (2 - 2 * c);
  return { b0: g, b1: -2 * c * g, b2: g, a1: m.a1, a2: m.a2 };
}

/** Complex response of a biquad at frequency f: returns [magnitude, phase]. */
export function response(c: BiquadCoefs, f: number, fs: number): [number, number] {
  const w = (2 * Math.PI * f) / fs;
  const cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cw + c.b2 * c2, ni = -(c.b1 * sw + c.b2 * s2);
  const dr = 1 + c.a1 * cw + c.a2 * c2, di = -(c.a1 * sw + c.a2 * s2);
  const mag = Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  const ph = Math.atan2(ni, nr) - Math.atan2(di, dr);
  return [mag, ph];
}

export function magnitude(c: BiquadCoefs, f: number, fs: number): number {
  return response(c, f, fs)[0];
}

/** Transposed direct form II state (one channel). */
export class BiquadState {
  z1 = 0;
  z2 = 0;
  reset(): void { this.z1 = 0; this.z2 = 0; }

  process(c: BiquadCoefs, buf: Float32Array | Float64Array, start: number, end: number): void {
    let z1 = this.z1, z2 = this.z2;
    const b0 = c.b0, b1 = c.b1, b2 = c.b2, a1 = c.a1, a2 = c.a2;
    for (let i = start; i < end; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    this.z1 = Math.abs(z1) < 1e-25 ? 0 : z1;
    this.z2 = Math.abs(z2) < 1e-25 ? 0 : z2;
  }
}
