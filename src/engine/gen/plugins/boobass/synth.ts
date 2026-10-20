// Synthesized substitutes for BooBass's 12 PCM tables. FL's engine plays
// recordings of a bass guitar embedded in its binary (six plucks at 16 kHz on
// B0, E1, B1, E2, B2, E3 and one single cycle per zone); Orchard does not ship
// them. These generic stand-ins (a stiff plucked string: harmonic series with
// a pluck-position comb, faster decay of higher partials, a short noise
// transient) give the engine the same structure and similar levels, so the
// plugin plays a plausible bass out of the box; FL's exact sound needs the
// user's FL data (docs/research/gen/boobass.md, "Data").

import type { BooPcm } from './tables';

/** Zone centre frequencies: FL's 16.3547 Hz x 2^(cents / 1200) at 1100, 1600, 2300, 2800, 3500, 4000 cents. */
const F_BASE = 267955.84375 / 16384;
const CENTS = [1100, 1600, 2300, 2800, 3500, 4000];
const SR = 16000;

/** Deterministic noise (LCG) in -1..1. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2147483648 - 1;
  };
}

/** Harmonic amplitude of the plucked string (before decay). */
function harm(h: number, f0: number): number {
  const comb = Math.abs(Math.sin(Math.PI * h * 0.21)) + 0.08;
  return (comb / Math.pow(h, 1.15)) * Math.exp((-h * f0) / 1800);
}

function toInt16(x: Float64Array, scale: number): Int16Array {
  const o = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) o[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * scale)));
  return o;
}

function rms(x: Float64Array, n = x.length): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, n));
}

/** One cycle of the zone's sustained tone (the wavetable source). */
function cycle(z: number): Int16Array {
  const f0 = F_BASE * Math.pow(2, CENTS[z] / 1200);
  const n = Math.round(SR / f0);
  const x = new Float64Array(n);
  const H = Math.min(40, Math.floor(3800 / f0));
  for (let h = 1; h <= H; h++) {
    const a = harm(h, f0) * Math.exp((-h * f0) / 900);
    const ph = (h * 1.7) % (2 * Math.PI);
    for (let i = 0; i < n; i++) x[i] += a * Math.sin((2 * Math.PI * h * i) / n + ph);
  }
  return toInt16(x, (0.62 / rms(x)) * 32767);
}

/** The zone's pluck (the strike): about 1.7 s at 16 kHz. */
function pluck(z: number): Int16Array {
  const f0 = F_BASE * Math.pow(2, CENTS[z] / 1200);
  const n = 27200 - z * 600;
  const x = new Float64Array(n);
  const H = Math.min(48, Math.floor(6000 / f0));
  const B = 0.00018;
  for (let h = 1; h <= H; h++) {
    const fh = h * f0 * Math.sqrt(1 + B * h * h);
    if (fh >= SR * 0.45) break;
    const a0 = harm(h, f0);
    const tau = 1 / (0.25 + fh / 700);
    const w = (2 * Math.PI * fh) / SR;
    const cw = Math.cos(w), sw = Math.sin(w);
    const dk = Math.exp(-1 / (tau * SR));
    let c = Math.cos(h * 0.9), s = Math.sin(h * 0.9), a = a0;
    for (let i = 0; i < n; i++) {
      x[i] += a * s;
      const c2 = c * cw - s * sw;
      s = s * cw + c * sw;
      c = c2;
      a *= dk;
    }
  }
  // finger / pick transient: a short band-limited noise burst
  const rnd = noise(0x1b0b + z);
  let lp = 0;
  const burst = Math.round(0.006 * SR);
  for (let i = 0; i < burst * 4; i++) {
    lp += 0.35 * (rnd() - lp);
    x[i] += 0.5 * lp * Math.exp(-i / burst) * Math.min(1, i / 16);
  }
  // the string starts at rest: fade the first millisecond in
  for (let i = 0; i < 16; i++) x[i] *= i / 16;
  // recorded plucks keep a nearly constant level over the strike (the engine's envelope decays it):
  // a slow gain riding the level, interpolated between 50 ms segments
  const seg = 800;
  const ref = rms(x, 6400);
  const nseg = Math.ceil(n / seg);
  const gs = new Float64Array(nseg);
  for (let k = 0; k < nseg; k++) {
    let s = 0;
    const o = k * seg, e = Math.min(n, o + seg);
    for (let i = o; i < e; i++) s += x[i] * x[i];
    const r = Math.sqrt(s / (e - o)) || 1e-9;
    gs[k] = Math.min(6, Math.pow(ref / r, 0.85));
  }
  for (let i = 0; i < n; i++) {
    const pos = (i - seg / 2) / seg;
    const k0 = Math.max(0, Math.min(nseg - 1, Math.floor(pos)));
    const k1 = Math.min(nseg - 1, k0 + 1);
    const t = Math.max(0, Math.min(1, pos - k0));
    x[i] *= gs[k0] + (gs[k1] - gs[k0]) * t;
  }
  return toInt16(x, (0.5 / rms(x, 6400)) * 32767);
}

let cache: BooPcm | null = null;

/** The synthesized tables (built once). */
export function synthPcm(): BooPcm {
  if (!cache) {
    const strikes: Int16Array[] = [], waves: Int16Array[] = [];
    for (let z = 0; z < 6; z++) { strikes.push(pluck(z)); waves.push(cycle(z)); }
    cache = { strikes, waves };
  }
  return cache;
}
