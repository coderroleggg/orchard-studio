// Parametric EQ 2 band designs, measured against FL Studio's own plugin with
// the command-line plugin host (docs/research/fx/peq2.md). Shared by the
// audio engine and the editor's curve display.
//
// - Knob laws: f = 20 * 1000^x Hz; BW x = 0..1. Peaking uses BW = 0.1 + 4.9x
//   octaves (RBJ bandwidth form, pre-warped), band pass BW * 10^-0.15 and
//   notch BW * 10^0.15 (same form), low / high pass Q = (0.1 + 9.9 (1-x)^3)/sqrt2,
//   shelves the RBJ slope S = (117 - 98x) / 57 (S = 1 at the 61 % default).
// - Orders (n = 1 + |order| sections): LP/HP Steep = section Qs c_i Q^(1/n)
//   (measured table), Gentle = n sections of 2^(-(n-1)/2n) Q^(1/n). Shelves:
//   gain / n per section, Gentle = same S, Steep = S d_i (table). Peaking:
//   Gentle = n sections of gain / n; Steep = staggered sections (offsets,
//   widths and gains below). Band pass / notch: Steep = Gentle = n identical
//   sections with BW * sqrt(n) (band pass) or BW / sqrt(n) (notch).
// - Draft (HQ off): RBJ cookbook biquads at the host rate; peaking clamped
//   to 0.35 fs, pass / shelf types to 0.4995 fs, band pass / notch bypassed
//   at or above Nyquist (staggered Steep peaking sections: 0.4 fs). Legacy /
//   Enhanced HQ use the same designs at 2 fs.
// - HQ+ ("decramped"): biquads that match the analog prototype's magnitude
//   at characteristic frequencies (see hqSection).

import type { BiquadCoefs } from '../engine/dsp/biquad';

export type SecKind = 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peaking' | 'lowshelf' | 'highshelf';

/** One second-order section: q for LP/HP, bw (octaves, RBJ form) for peaking / BP / notch, s (RBJ slope) for shelves. */
export interface SectionSpec {
  kind: SecKind;
  f0: number;
  q: number;
  bw: number;
  s: number;
  gainDb: number;
  /** Staggered section of a Steep peaking band (draft limit 0.4 fs instead of 0.35 fs). */
  stagger?: boolean;
}

const LN2 = Math.LN2;
const PI = Math.PI;
const SQRT1_2 = Math.SQRT1_2;

/** Steep LP / HP section Q factors relative to Q^(1/n), n = 2..4 (measured). */
const STEEP_PASS: number[][] = [[], [], [0.630012034, 1.667834833], [0.551022694, 0.858401573, 2.097781639], [0.505166204, 0.80557539, 0.880402756, 2.757819462]];
/** Steep shelf section slopes relative to S, n = 2..4 (measured). */
const STEEP_SHELF: number[][] = [[], [], [0.6156446, 2.630447], [0.5098683, 1.1092702, 5.1612291], [0.5529989, 0.6940295, 1.514437, 10.3191216]];

export function knobHz(x: number): number {
  return 20 * Math.pow(1000, x);
}
/** Peaking bandwidth in octaves. */
export function peakOct(x: number): number {
  return 0.1 + 4.9 * x;
}
/** Low / high pass resonance. */
export function passQ(x: number): number {
  const r = 1 - x;
  return (0.1 + 9.9 * r * r * r) / Math.SQRT2;
}
/** Shelf slope (RBJ S). */
export function shelfS(x: number): number {
  return (117 - 98 * x) / 57;
}
/** Analog Q of a bandwidth in octaves. */
export function octQ(oct: number): number {
  return 1 / (2 * Math.sinh((LN2 / 2) * oct));
}
function shelfQ(S: number, A: number): number {
  return 1 / Math.sqrt(Math.max(1e-12, (A + 1 / A) * (1 / S - 1) + 2));
}

/** Second-order sections of a band. `level` in dB; empty when the band is a pass-through. */
export function bandSpecs(kind: SecKind, freqX: number, bwX: number, level: number, order: number): SectionSpec[] {
  const f0 = knobHz(freqX);
  const x = Math.min(1, Math.max(0, bwX));
  const o = Math.max(-3, Math.min(3, Math.round(order)));
  const n = 1 + Math.abs(o);
  const steep = o < 0;
  const out: SectionSpec[] = [];
  const add = (k: SecKind, f: number, q: number, bw: number, s: number, g: number) => out.push({ kind: k, f0: f, q, bw, s, gainDb: g, stagger: steep && n > 1 && k === 'peaking' });
  switch (kind) {
    case 'lowpass':
    case 'highpass': {
      const Q = passQ(x);
      const r = Math.pow(Q, 1 / n);
      for (let i = 0; i < n; i++) {
        const c = n === 1 ? 1 : steep ? STEEP_PASS[n][i] : Math.pow(2, -(n - 1) / (2 * n));
        add(kind, f0, c * r, 0, 0, 0);
      }
      break;
    }
    case 'bandpass':
      for (let i = 0; i < n; i++) add(kind, f0, 0, peakOct(x) * Math.pow(10, -0.15) * Math.sqrt(n), 0, 0);
      break;
    case 'notch':
      for (let i = 0; i < n; i++) add(kind, f0, 0, (peakOct(x) * Math.pow(10, 0.15)) / Math.sqrt(n), 0, 0);
      break;
    case 'lowshelf':
    case 'highshelf': {
      const S = shelfS(x);
      for (let i = 0; i < n; i++) add(kind, f0, 0, 0, S * (n === 1 || !steep ? 1 : STEEP_SHELF[n][i]), level / n);
      break;
    }
    case 'peaking': {
      const bw = peakOct(x);
      if (n === 1 || !steep) {
        for (let i = 0; i < n; i++) add(kind, f0, 0, bw, 0, level / n);
      } else if (n === 2) {
        const g = (0.6625 - 0.01 * bw) * level;
        add(kind, f0 * Math.pow(2, -bw / 8), 0, bw / 2, 0, g);
        add(kind, f0 * Math.pow(2, bw / 8), 0, bw / 2, 0, g);
      } else if (n === 3) {
        const g = 0.4884 * level, d = (19 / 120) * bw;
        add(kind, f0 * Math.pow(2, -d), 0, bw / 3, 0, g);
        add(kind, f0, 0, (bw * PI) / 6, 0, g);
        add(kind, f0 * Math.pow(2, d), 0, bw / 3, 0, g);
      } else {
        const g = 0.42889 * level, d1 = (3 / 40) * bw, d2 = (31 / 160) * bw;
        add(kind, f0 * Math.pow(2, -d2), 0, bw / 4, 0, g);
        add(kind, f0 * Math.pow(2, -d1), 0, (bw * PI) / 8, 0, g);
        add(kind, f0 * Math.pow(2, d1), 0, (bw * PI) / 8, 0, g);
        add(kind, f0 * Math.pow(2, d2), 0, bw / 4, 0, g);
      }
      break;
    }
  }
  return out;
}

// ------------------------------------------------------------------ draft (RBJ)

const IDENT: BiquadCoefs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };

function norm(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): BiquadCoefs {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** RBJ cookbook section at rate fs with FL's frequency limits. */
export function draftSection(s: SectionSpec, fs: number): BiquadCoefs {
  let f = s.f0;
  if (s.kind === 'peaking') f = Math.min(f, (s.stagger ? 0.4 : 0.35) * fs);
  else if (s.kind === 'bandpass' || s.kind === 'notch') {
    if (f >= 0.5 * fs) return { ...IDENT };
  } else f = Math.min(f, 0.4995 * fs);
  const w = (2 * PI * f) / fs;
  const c = Math.cos(w), sn = Math.sin(w);
  const A = Math.pow(10, s.gainDb / 40);
  let al: number;
  if (s.kind === 'lowpass' || s.kind === 'highpass') al = sn / (2 * s.q);
  else if (s.kind === 'lowshelf' || s.kind === 'highshelf') al = (sn / 2) * Math.sqrt(Math.max(1e-12, (A + 1 / A) * (1 / s.s - 1) + 2));
  else al = sn * Math.sinh((LN2 / 2) * s.bw * (w / sn));
  switch (s.kind) {
    case 'lowpass': return norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
    case 'highpass': return norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
    case 'bandpass': return norm(al, 0, -al, 1 + al, -2 * c, 1 - al);
    case 'notch': return norm(1, -2 * c, 1, 1 + al, -2 * c, 1 - al);
    case 'peaking': return norm(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
    case 'lowshelf': {
      const t = 2 * Math.sqrt(A) * al;
      return norm(A * (A + 1 - (A - 1) * c + t), 2 * A * (A - 1 - (A + 1) * c), A * (A + 1 - (A - 1) * c - t),
        A + 1 + (A - 1) * c + t, -2 * (A - 1 + (A + 1) * c), A + 1 + (A - 1) * c - t);
    }
    case 'highshelf': {
      const t = 2 * Math.sqrt(A) * al;
      return norm(A * (A + 1 + (A - 1) * c + t), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - t),
        A + 1 - (A - 1) * c + t, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - t);
    }
  }
}

// ------------------------------------------------------------------ HQ+ (decramped)
//
// Digital |H|^2 in the phi basis (p0 = cos^2 w/2, p1 = sin^2 w/2, p2 = 4 p0 p1):
//   |H|^2 = (B0 p0 + B1 p1 + B2 p2) / (p0 + A1 p1 + A2 p2)
// Each type fixes the coefficients by matching its analog prototype:
//   LP  Q > 1/sqrt2: value + curvature at DC, Nyquist, resonance peak (value, position)
//       Q <= 1/sqrt2: value + curvature at DC, Nyquist, value at min(w0, pi/2), B2 = 0
//   HP  numerator g (1 - z^-1)^2, asymptote |H|^2 ~ (w / w0)^4; peak below Nyquist:
//       peak value and position; otherwise Nyquist and min(w0, pi/2)
//   BP  impulse-invariant poles, zero at DC, unity peak exactly at w0
//   notch: impulse-invariant poles, zeros at w0, unity DC gain
//   peaking: DC, Nyquist, center value and extremum, lower half-gain edge (a
//       centre above Nyquist is matched just below Nyquist, prototype unchanged)
//   shelves: Q^2 > 0.6 and both analog extrema below Nyquist: DC + both extrema
//       (value, position); otherwise impulse-invariant poles and the numerator
//       matched at DC, min(w0, pi/5) and Nyquist

const phi = (w: number): [number, number, number] => {
  const s = Math.sin(w / 2), c = Math.cos(w / 2);
  const p1 = s * s, p0 = c * c;
  return [p0, p1, 4 * p0 * p1];
};
const dphi = (w: number): [number, number, number] => {
  const s = Math.sin(w);
  return [-s / 2, s / 2, 2 * s * Math.cos(w)];
};

/** Minimum-phase biquad from phi-basis magnitude coefficients (A0 = 1). */
function fromPhi(A1: number, A2: number, B0: number, B1: number, B2: number): BiquadCoefs {
  const sa1 = Math.sqrt(Math.max(0, A1));
  let r: number;
  if (Math.abs(A2) < 1e-300) r = 2 / (1 + sa1);
  else r = (-(1 + sa1) + Math.sqrt(Math.max(0, (1 + sa1) * (1 + sa1) + 4 * A2))) / A2;
  const s = r * r;
  const a2 = (-s * A2) / 4;
  const a1 = r - 1 - a2;
  const sb0 = Math.sqrt(Math.max(0, B0)), sb1 = Math.sqrt(Math.max(0, B1));
  const W = 0.5 * (sb0 + sb1);
  const b1 = 0.5 * (sb0 - sb1) * r;
  const b0 = 0.5 * (r * W + Math.sqrt(Math.max(0, s * (W * W + B2))));
  const b2 = r * W - b0;
  return { b0, b1, b2, a1, a2 };
}

/** Solves M u = v for 4 unknowns (Gaussian elimination, partial pivoting). */
function solve4(M: number[][], v: number[]): number[] {
  const n = 4;
  const a = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c] || 1e-300;
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / d;
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  const u = [0, 0, 0, 0];
  for (let r = n - 1; r >= 0; r--) {
    let s = a[r][n];
    for (let k = r + 1; k < n; k++) s -= a[r][k] * u[k];
    u[r] = s / (a[r][r] || 1e-300);
  }
  return u;
}

type Cond = ['nyq', number] | ['val', number, number] | ['ext', number, number] | ['curv0', number];

/** Magnitude-matched biquad: rows over unknowns [A1, A2, B1, B2]; B0 = DC target. */
function matchPhi(B0: number, conds: Cond[]): BiquadCoefs {
  const M: number[][] = [], v: number[] = [];
  for (const c of conds) {
    if (c[0] === 'nyq') { M.push([-c[1], 0, 1, 0]); v.push(0); }
    else if (c[0] === 'val') {
      const [p0, p1, p2] = phi(c[1]); const h = c[2];
      M.push([-h * p1, -h * p2, p1, p2]); v.push(h * p0 - B0 * p0);
    } else if (c[0] === 'ext') {
      const [d0, d1, d2] = dphi(c[1]); const h = c[2];
      M.push([-h * d1, -h * d2, d1, d2]); v.push(h * d0 - B0 * d0);
    } else { M.push([-B0 / 4, -B0, 0.25, 1]); v.push(c[1]); }
  }
  const [A1, A2, B1, B2] = solve4(M, v);
  return fromPhi(A1, A2, B0, B1, B2);
}

/** Impulse-invariant poles of s^2 + s w/Q + w^2 (w in rad / sample). */
function iiPoles(w: number, Q: number): [number, number] {
  const z = 1 / (2 * Q);
  const r = Math.exp(-z * w);
  const a1 = z < 1 ? -2 * r * Math.cos(Math.sqrt(1 - z * z) * w) : -(Math.exp(-z * w + Math.sqrt(z * z - 1) * w) + Math.exp(-z * w - Math.sqrt(z * z - 1) * w));
  return [a1, r * r];
}

const lpMag2 = (x: number, Q: number) => { const u = x * x; return 1 / ((1 - u) * (1 - u) + u / (Q * Q)); };
const hpMag2 = (x: number, Q: number) => { const u = x * x; return (u * u) / ((1 - u) * (1 - u) + u / (Q * Q)); };
const peakMag2 = (x: number, Q: number, A: number) => {
  const u = x * x, d = (1 - u) * (1 - u);
  return (d + (A * A * u) / (Q * Q)) / (d + u / (A * A * Q * Q));
};
/** Analog RBJ shelf |H|^2 at x = f / f0 (high shelf = A^4 / low shelf). */
function shelfMag2(low: boolean, x: number, A: number, Q: number): number {
  const u = x * x, k = A / (Q * Q);
  const n = (A - u) * (A - u) + k * u, d = (1 - A * u) * (1 - A * u) + k * u;
  return low ? (A * A * n) / d : (A * A * d) / n;
}

function hqLowpass(w0: number, Q: number): BiquadCoefs {
  const hn = lpMag2(PI / w0, Q);
  const c2 = (2 - 1 / (Q * Q)) / (w0 * w0);
  if (Q > SQRT1_2) {
    const xp = Math.sqrt(1 - 1 / (2 * Q * Q)), wp = w0 * xp, hp = lpMag2(xp, Q);
    return matchPhi(1, [['nyq', hn], ['curv0', c2], ['val', wp, hp], ['ext', wp, hp]]);
  }
  // first-order numerator: B1 = A1 hn, A2 = A1 (hn - 1) / 4 - c2, value at wm
  const wm = Math.min(w0, PI / 2), hm = lpMag2(wm / w0, Q);
  const [p0, p1, p2] = phi(wm);
  const A1 = (hm * p0 - hm * p2 * c2 - p0) / (hn * p1 - hm * p1 - (hm * p2 * (hn - 1)) / 4);
  const A2 = (A1 * (hn - 1)) / 4 - c2;
  return fromPhi(A1, A2, 1, A1 * hn, 0);
}

function hpFrom(G: number, A1: number, A2: number): BiquadCoefs {
  const d = fromPhi(A1, A2, 1, 1, 0);
  const g = Math.sqrt(G / 16) * (1 + d.a1 + d.a2);
  return { b0: g, b1: -2 * g, b2: g, a1: d.a1, a2: d.a2 };
}

function hqHighpass(w0: number, Q: number): BiquadCoefs {
  const G = 16 / (w0 * w0 * w0 * w0);
  if (Q > SQRT1_2) {
    const xp = 1 / Math.sqrt(1 - 1 / (2 * Q * Q)), wp = w0 * xp;
    if (wp < PI) {
      const h = hpMag2(xp, Q);
      const [p0, p1, p2] = phi(wp), [d0, d1, d2] = dphi(wp);
      // G p1^2 = h (p0 + A1 p1 + A2 p2) and its derivative
      const m11 = h * p1, m12 = h * p2, r1 = G * p1 * p1 - h * p0;
      const m21 = h * d1, m22 = h * d2, r2 = 2 * G * p1 * d1 - h * d0;
      const det = m11 * m22 - m12 * m21;
      return hpFrom(G, (r1 * m22 - m12 * r2) / det, (m11 * r2 - m21 * r1) / det);
    }
  }
  // no resonance below Nyquist: Nyquist value and the value at min(w0, pi/2)
  // (FL's design for a resonance above Nyquist is not identified; this is the closest fit)
  const A1 = G / hpMag2(PI / w0, Q);
  const wm = Math.min(w0, PI / 2), hm = hpMag2(wm / w0, Q);
  const [p0, p1, p2] = phi(wm);
  return hpFrom(G, A1, ((G * p1 * p1) / hm - p0 - A1 * p1) / p2);
}

function hqBandpass(w0: number, Q: number): BiquadCoefs {
  // impulse-invariant poles; |D|^2 in factored form (well conditioned at low w0)
  const z = 1 / (2 * Q);
  let a1: number, a2: number, D: (w: number) => number, Dp: (w: number) => number;
  if (z < 1) {
    const r = Math.exp(-z * w0), th = Math.sqrt(1 - z * z) * w0, q = (1 - r) * (1 - r);
    const fa = (w: number) => q + 4 * r * Math.sin((w - th) / 2) ** 2;
    const fb = (w: number) => q + 4 * r * Math.sin((w + th) / 2) ** 2;
    D = (w) => fa(w) * fb(w);
    Dp = (w) => 2 * r * Math.sin(w - th) * fb(w) + fa(w) * 2 * r * Math.sin(w + th);
    a1 = -2 * r * Math.cos(th); a2 = r * r;
  } else {
    const e = Math.sqrt(z * z - 1) * w0, p = Math.exp(-z * w0 + e), m = Math.exp(-z * w0 - e);
    const f = (c: number, w: number) => (1 - c) * (1 - c) + 4 * c * Math.sin(w / 2) ** 2;
    const fp = (c: number, w: number) => 2 * c * Math.sin(w);
    D = (w) => f(p, w) * f(m, w);
    Dp = (w) => fp(p, w) * f(m, w) + f(p, w) * fp(m, w);
    a1 = -(p + m); a2 = p * m;
  }
  // N = 4 q (U - V q), q = sin^2(w/2): N(w0) = D(w0), N'(w0) = D'(w0)
  const q0 = Math.sin(w0 / 2) ** 2, s0 = Math.sin(w0);
  const D0 = D(w0), D0p = Dp(w0);
  const V = (D0 / (4 * q0) - D0p / (2 * s0)) / q0;
  const U = D0 / (4 * q0) + V * q0;
  const sU = Math.sqrt(Math.max(0, U)), dd = Math.sqrt(Math.max(0, U - V));
  const c0 = (sU + dd) / 2, c1 = (sU - dd) / 2;
  return { b0: c0, b1: c1 - c0, b2: -c1, a1, a2 };
}

function hqNotch(w0: number, Q: number): BiquadCoefs {
  const [a1, a2] = iiPoles(w0, Q);
  const c = Math.cos(w0), g = (1 + a1 + a2) / (2 - 2 * c);
  return { b0: g, b1: -2 * c * g, b2: g, a1, a2 };
}

function hqPeak(w0: number, bw: number, gainDb: number): BiquadCoefs {
  const Q = octQ(bw), A = Math.pow(10, gainDb / 40);
  // a centre at or above Nyquist (staggered Steep sections) is matched just below it
  const wc = Math.min(w0, PI * (1 - 1e-8));
  const we = wc * Math.pow(2, -bw / 2);
  const an = (w: number) => peakMag2(w / w0, Q, A);
  return matchPhi(1, [['nyq', an(PI)], ['val', wc, an(wc)], ['ext', wc, an(wc)], ['val', we, an(we)]]);
}

/** Vicanek numerator for fixed poles: |H|^2 matched at DC, wm and Nyquist. */
function vicanek(a1: number, a2: number, wm: number, H0: number, Hm: number, Hn: number): BiquadCoefs {
  const A0 = (1 + a1 + a2) ** 2, A1 = (1 - a1 + a2) ** 2, A2 = -4 * a2;
  const [p0, p1, p2] = phi(wm);
  const B0 = A0 * H0, B1 = A1 * Hn;
  const B2 = ((A0 * p0 + A1 * p1 + A2 * p2) * Hm - B0 * p0 - B1 * p1) / p2;
  const sB0 = Math.sqrt(Math.max(0, B0)), sB1 = Math.sqrt(Math.max(0, B1)), W = 0.5 * (sB0 + sB1);
  const b0 = 0.5 * (W + Math.sqrt(Math.max(0, W * W + B2)));
  return { b0, b1: 0.5 * (sB0 - sB1), b2: -B2 / (4 * b0), a1, a2 };
}

function hqShelf(low: boolean, w0: number, S: number, gainDb: number): BiquadCoefs {
  const A = Math.pow(10, gainDb / 40), Q = shelfQ(S, A);
  const an = (w: number) => shelfMag2(low, w / w0, A, Q);
  if (Q * Q > 0.6 && Math.abs(A - 1) > 1e-12) {
    // extrema at u and 1/u (u = x^2): (k - 2A) u^2 + 2 (1 + A^2) u + (k - 2A) = 0
    const k = A / (Q * Q), m = 2 * A - k;
    const disc = Math.sqrt(Math.max(0, (1 + A * A) ** 2 - m * m));
    const u1 = (1 + A * A - disc) / m, u2 = (1 + A * A + disc) / m;
    const w1 = w0 * Math.sqrt(Math.min(u1, u2)), w2 = w0 * Math.sqrt(Math.max(u1, u2));
    if (w2 < PI) {
      const h1 = an(w1), h2 = an(w2);
      return matchPhi(an(0), [['val', w1, h1], ['ext', w1, h1], ['val', w2, h2], ['ext', w2, h2]]);
    }
    // one extremum below Nyquist: FL's design is not identified; fall back to the matched design below
  }
  const [a1, a2] = iiPoles(low ? w0 / Math.sqrt(A) : w0 * Math.sqrt(A), Q);
  const wm = Math.min(w0, PI / 5);
  return vicanek(a1, a2, wm, an(0), an(wm), an(PI));
}

/** HQ+ section at rate fs. */
export function hqSection(s: SectionSpec, fs: number): BiquadCoefs {
  if (s.kind === 'peaking') return hqPeak((2 * PI * s.f0) / fs, s.bw, s.gainDb);
  const w0 = (2 * PI * Math.min(s.f0, 0.4995 * fs)) / fs;
  switch (s.kind) {
    case 'lowpass': return hqLowpass(w0, s.q);
    case 'highpass': return hqHighpass(w0, s.q);
    case 'bandpass': return s.f0 >= 0.5 * fs ? { ...IDENT } : hqBandpass(w0, octQ(s.bw));
    case 'notch': return s.f0 >= 0.5 * fs ? { ...IDENT } : hqNotch(w0, octQ(s.bw));
    case 'lowshelf': return hqShelf(true, w0, s.s, s.gainDb);
    case 'highshelf': return hqShelf(false, w0, s.s, s.gainDb);
  }
}

// ------------------------------------------------------------------ evaluation

/** |H(e^jw)| and phase of a biquad at frequency f. */
export function biquadResponse(c: BiquadCoefs, f: number, fs: number): [number, number] {
  const w = (2 * PI * f) / fs;
  const cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cw + c.b2 * c2, ni = -(c.b1 * sw + c.b2 * s2);
  const dr = 1 + c.a1 * cw + c.a2 * c2, di = -(c.a1 * sw + c.a2 * s2);
  return [Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di)), Math.atan2(ni, nr) - Math.atan2(di, dr)];
}

/** LIN mode converts the total response with 2^(dB/6): |H|^(20 log10(2) / 6). */
export const LIN_EXPONENT = (10 * Math.log10(2)) / 3;
