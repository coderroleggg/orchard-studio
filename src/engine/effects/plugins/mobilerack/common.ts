// Shared pieces of the FL Studio Mobile Rack module library: the module
// interface, transport context, LFO shapes, tempo sync and small helpers.

import { TAU, fl } from '../hardcore/dsp';

export { TAU, fl };

/** Per-block transport / tempo information for a module. */
export interface MrCtx {
  sr: number;
  tempo: number;
  playing: boolean;
  /** Song position (beats) at the start of the block. */
  beat: number;
}

export type MrMonitor = Record<string, number | boolean | string | number[] | Float32Array>;

/** One FL Studio Mobile effect module (stereo, in place). */
export interface MrModule {
  /** New parameter values (normalised 0..1; p[0] is the module Enable, handled by the rack). */
  set(p: Float64Array): void;
  process(L: Float32Array, R: Float32Array, n: number, ctx: MrCtx): void;
  reset(): void;
  /** Seconds of output after the input goes silent. */
  tail(): number;
  /** Jump smoothed settings to their targets (first parameters after creation). */
  snap?(): void;
  /** Editor display data (meters, spectra, pitch). */
  monitor?(): MrMonitor | null;
}

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
export const dbToLin = (db: number) => Math.pow(10, db / 20);
export const linToDb = (g: number) => (g > 1e-12 ? 20 * Math.log10(g) : -240);

/** One-pole smoothing coefficient for a time constant of `ms`. */
export function smoothK(ms: number, sr: number): number {
  return ms <= 0 ? 1 : 1 - Math.exp(-1 / (ms * 0.001 * sr));
}

/** Per-sample one-pole parameter smoother. */
export class Sm {
  v: number;
  t: number;
  k: number;
  constructor(v: number, k: number) { this.v = v; this.t = v; this.k = k; }
  set(t: number): void { this.t = t; }
  snap(): void { this.v = this.t; }
  next(): number { this.v += (this.t - this.v) * this.k; return this.v; }
}

/** Length of a tempo division (beats) in seconds. */
export function beatsToSec(beats: number, tempo: number): number {
  return (beats * 60) / Math.max(10, tempo || 120);
}

/**
 * FL Studio Mobile LFO waveforms (phase in cycles, output -1..1): 0 sine,
 * 1 rising saw, 2 square. Saw and square corners are slightly rounded, as
 * measured on FL's flanger.
 */
export function lfoShape(shape: number, ph: number): number {
  const p = ph - Math.floor(ph);
  if (shape === 1) {
    // rising ramp with a short (3 %) return
    return p < 0.97 ? -1 + (2 * p) / 0.97 : 1 - (2 * (p - 0.97)) / 0.03;
  }
  if (shape === 2) {
    // square with 2 % ramps
    if (p < 0.02) return -1 + p / 0.01;
    if (p < 0.5) return 1;
    if (p < 0.52) return 1 - (p - 0.5) / 0.01;
    return -1;
  }
  return Math.sin(TAU * p);
}

/**
 * LFO phase source: free running, or locked to the song position when a
 * tempo-synced LFO runs during playback.
 */
export class Phasor {
  ph = 0;
  /** Advance by n samples at `hz`; returns the phase at the block start. */
  advance(hz: number, n: number, sr: number): number {
    const start = this.ph;
    this.ph += (hz * n) / sr;
    this.ph -= Math.floor(this.ph);
    return start;
  }
  /** Phase locked to the transport for a period of `beats`. */
  sync(ctx: MrCtx, beats: number): void {
    if (ctx.playing) { const x = ctx.beat / beats; this.ph = x - Math.floor(x); }
  }
}

/** Flush-to-zero for state stored in typed arrays. */
export function flushArr(a: Float64Array): void {
  for (let i = 0; i < a.length; i++) a[i] = fl(a[i]);
}

/** Copy one block into scratch buffers. */
export function copyTo(src: Float32Array, dst: Float32Array, n: number): void {
  for (let i = 0; i < n; i++) dst[i] = src[i];
}

/**
 * FL Studio Mobile's delay lines read about 2.5 samples later than their
 * nominal time (measured on its tape delay, flanger and comb filter).
 */
export const FL_DELAY_EXTRA = 2.5;

/** Fixed latency (whole samples) applied to a stereo stream. */
export class Latency {
  private readonly bufL: Float32Array;
  private readonly bufR: Float32Array;
  private w = 0;
  readonly n: number;
  constructor(n: number) {
    this.n = Math.max(0, n | 0);
    this.bufL = new Float32Array(Math.max(1, this.n));
    this.bufR = new Float32Array(Math.max(1, this.n));
  }
  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.n === 0) return;
    const bl = this.bufL, br = this.bufR, len = this.n;
    let w = this.w;
    for (let i = 0; i < n; i++) {
      const l = bl[w], r = br[w];
      bl[w] = L[i]; br[w] = R[i];
      L[i] = l; R[i] = r;
      if (++w >= len) w = 0;
    }
    this.w = w;
  }
  reset(): void { this.bufL.fill(0); this.bufR.fill(0); this.w = 0; }
}

/** Mono analysis ring buffer for displays (filled in process, read in monitor). */
export class Scope {
  readonly buf: Float32Array;
  w = 0;
  constructor(n: number) { this.buf = new Float32Array(n); }
  push(L: Float32Array, R: Float32Array, n: number): void {
    const b = this.buf, len = b.length;
    let w = this.w;
    for (let i = 0; i < n; i++) { b[w] = 0.5 * (L[i] + R[i]); if (++w >= len) w = 0; }
    this.w = w;
  }
  /** Copy the latest `out.length` samples in time order. */
  latest(out: Float32Array): void {
    const b = this.buf, len = b.length, n = out.length;
    let r = (this.w - n + len * 2) % len;
    for (let i = 0; i < n; i++) { out[i] = b[r]; if (++r >= len) r = 0; }
  }
  clear(): void { this.buf.fill(0); this.w = 0; }
}
