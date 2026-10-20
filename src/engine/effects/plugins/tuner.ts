// Tuner: passes audio through untouched and tracks the pitch of the (mono)
// input while the editor is open: a 4th-order low-pass and 2x decimation
// (at 32 kHz and above), then the McLeod pitch method (normalised square
// difference function through an FFT autocorrelation, first key maximum
// above 0.9 x the highest, parabolic interpolation) every 20 ms over a
// 50 ms window (100 ms and 40 ms hops in Bass mode, which reaches an octave
// lower). Reactivity sets the pitch smoothing and the upper detection limit
// (E7 when slow .. C10 when fast, FL's note names).

import { bilinear, prototype, type BiquadCoefs } from '../../dsp/biquad';
import { getFFT, type FFT } from '../../dsp/fft';
import { tunerRange } from '../../../model/fx/plugins/tuner';
import type { EffectInstance, EffectModule, FxMonitor } from '../types';

const GATE = 0.0005; // window RMS below this (-66 dBFS) = no pitch
const CLARITY = 0.75; // minimum NSDF peak to accept a pitch
const KEY_CUTOFF = 0.9;

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

class Biquad {
  private z1 = 0;
  private z2 = 0;
  constructor(private c: BiquadCoefs) {}
  run(x: number): number {
    const c = this.c;
    const y = c.b0 * x + this.z1;
    this.z1 = c.b1 * x - c.a1 * y + this.z2;
    this.z2 = c.b2 * x - c.a2 * y;
    return y;
  }
  reset(): void { this.z1 = this.z2 = 0; }
}

export class TunerDsp implements EffectInstance {
  private readonly dec: number;
  private readonly rate: number; // analysis sample rate
  private readonly lp: Biquad[];
  private decPhase = 0;
  private readonly ring: Float32Array;
  private ringPos = 0;
  private filled = 0;
  private sinceHop = 0;
  // analysis buffers (sized for Bass mode)
  private readonly win: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly nsdf: Float64Array;
  private readonly keysT = new Int32Array(64);
  private readonly keysV = new Float64Array(64);
  private readonly ffts: { normal: FFT; bass: FFT };
  // settings
  private bass = false;
  private react = 0.5;
  private lo = 21.8;
  private hi = 3300;
  // tracker state
  private cents = 0; // smoothed pitch in cents above A4 (440 Hz)
  private has = false;
  private pendingCents = 0;
  private pendingCount = 0;
  private silentFor = 0; // seconds without a pitch
  private lastClarity = 0;
  private lastLevel = 0;
  private fresh = false;
  private watch: number;

  constructor(private readonly sampleRate: number) {
    this.dec = sampleRate >= 32000 ? 2 : 1;
    this.rate = sampleRate / this.dec;
    const fc = Math.min(0.45 * this.rate, 11000);
    this.lp = [0.5412, 1.3066].map((q) => new Biquad(bilinear(prototype('lowpass', q), fc, sampleRate)));
    const wBass = Math.ceil(0.1 * this.rate);
    this.ring = new Float32Array(nextPow2(wBass * 2));
    this.win = new Float64Array(wBass);
    const nBass = nextPow2(2 * wBass);
    this.re = new Float64Array(nBass);
    this.im = new Float64Array(nBass);
    this.nsdf = new Float64Array(wBass);
    this.ffts = { normal: getFFT(nextPow2(2 * Math.ceil(0.05 * this.rate))), bass: getFFT(nBass) };
    this.watch = sampleRate;
    this.setParams({});
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as { react?: number; bass?: number | boolean };
    const react = typeof q.react === 'number' ? q.react : 3000;
    this.react = Math.max(0, Math.min(1, react / 6000));
    this.bass = !!q.bass;
    const r = tunerRange(react, this.bass);
    this.lo = r.lo;
    this.hi = Math.min(r.hi, 0.45 * this.rate);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.watch <= 0) return;
    this.watch -= n;
    const ring = this.ring, mask = ring.length - 1;
    const lp0 = this.lp[0], lp1 = this.lp[1];
    const hop = Math.round((this.bass ? 0.04 : 0.02) * this.rate);
    for (let i = 0; i < n; i++) {
      let x = (L[i] + R[i]) * 0.5;
      if (!(x === x && x - x === 0)) x = 0;
      const y = lp1.run(lp0.run(x));
      if (++this.decPhase < this.dec) continue;
      this.decPhase = 0;
      ring[this.ringPos] = y;
      this.ringPos = (this.ringPos + 1) & mask;
      if (this.filled < ring.length) this.filled++;
      if (++this.sinceHop >= hop) {
        this.sinceHop = 0;
        this.analyse(hop / this.rate);
      }
    }
  }

  /** One pitch estimate over the latest window; updates the smoothed pitch. */
  private analyse(dt: number): void {
    const W = Math.ceil((this.bass ? 0.1 : 0.05) * this.rate);
    if (this.filled < W) return;
    const fft = this.bass ? this.ffts.bass : this.ffts.normal;
    const N = fft.n;
    const ring = this.ring, mask = ring.length - 1, x = this.win;
    const start = (this.ringPos - W) & mask;
    let mean = 0;
    for (let j = 0; j < W; j++) { x[j] = ring[(start + j) & mask]; mean += x[j]; }
    mean /= W;
    let energy = 0;
    for (let j = 0; j < W; j++) { x[j] -= mean; energy += x[j] * x[j]; }
    const level = Math.sqrt(energy / W);
    this.lastLevel = level;
    let found = 0, clarity = 0;
    if (level > GATE) {
      // autocorrelation r(tau) through the FFT (zero-padded to N >= 2W)
      const re = this.re, im = this.im;
      for (let j = 0; j < N; j++) { re[j] = j < W ? x[j] : 0; im[j] = 0; }
      fft.transform(re, im);
      for (let j = 0; j < N; j++) { re[j] = re[j] * re[j] + im[j] * im[j]; im[j] = 0; }
      fft.transform(re, im, true);
      // NSDF n(tau) = 2 r(tau) / m(tau), m(tau) = sum of x[j]^2 + x[j+tau]^2
      const nsdf = this.nsdf;
      const tauMax = Math.min(Math.floor(0.75 * W), Math.ceil(this.rate / this.lo));
      const tauMin = Math.max(2, Math.floor(this.rate / this.hi));
      let m = 2 * energy;
      nsdf[0] = 1;
      for (let t = 1; t <= tauMax + 1 && t < W; t++) {
        m -= x[t - 1] * x[t - 1] + x[W - t] * x[W - t];
        nsdf[t] = m > 1e-12 ? (2 * re[t]) / N / m : 0;
      }
      // key maxima: the highest point of each positive lobe after the first negative crossing
      let t = 1;
      while (t < tauMax && nsdf[t] > 0) t++;
      let best = 0;
      const keysT = this.keysT, keysV = this.keysV;
      let nk = 0;
      while (t < tauMax && nk < keysT.length) {
        while (t < tauMax && nsdf[t] <= 0) t++;
        let mt = t, mv = -1;
        while (t < tauMax && nsdf[t] > 0) { if (nsdf[t] > mv) { mv = nsdf[t]; mt = t; } t++; }
        if (mv > 0) {
          // interpolated peak height (integer lags undersample high pitches)
          const a = nsdf[mt - 1], c = nsdf[mt + 1], den = a - 2 * mv + c;
          const shift = Math.abs(den) > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
          const pv = Math.min(1, mv - 0.25 * (a - c) * shift);
          keysT[nk] = mt; keysV[nk] = pv; nk++;
          if (pv > best) best = pv;
        }
      }
      if (nk > 0 && best >= CLARITY) {
        const cut = KEY_CUTOFF * best;
        for (let k = 0; k < nk; k++) {
          if (keysV[k] < cut) continue;
          const t1 = this.peak(keysT[k]);
          // a fundamental above the range is rejected (not reported as a sub-harmonic)
          if (t1 < tauMin) break;
          // refine on the furthest period multiple that is still a strong maximum (precision at high pitches)
          let tau = t1;
          for (let j = nk - 1; j > k; j--) {
            const mult = Math.round(keysT[j] / t1);
            if (mult < 2 || keysV[j] < cut || Math.abs(keysT[j] - mult * t1) > 0.25 * t1) continue;
            tau = this.peak(keysT[j]) / mult;
            break;
          }
          found = this.rate / tau;
          clarity = keysV[k];
          break;
        }
      }
    }
    this.lastClarity = clarity;
    this.track(found, dt);
  }

  /** Parabolic interpolation of the NSDF maximum at integer lag `t`. */
  private peak(t: number): number {
    const n = this.nsdf;
    const a = n[t - 1], b = n[t], c = n[t + 1];
    const den = a - 2 * b + c;
    const shift = Math.abs(den) > 1e-12 ? (0.5 * (a - c)) / den : 0;
    return t + Math.max(-0.5, Math.min(0.5, shift));
  }

  /** Smooth the estimates: big jumps need two agreeing frames, small moves are low-passed by Reactivity. */
  private track(hz: number, dt: number): void {
    if (!(hz >= this.lo * 0.97 && hz <= this.hi * 1.03)) {
      this.silentFor += dt;
      this.pendingCount = 0;
      return;
    }
    this.silentFor = 0;
    const c = 1200 * Math.log2(hz / 440);
    if (!this.has || Math.abs(c - this.cents) > 60) {
      if (this.pendingCount > 0 && Math.abs(c - this.pendingCents) < 40) {
        this.pendingCount++;
        this.pendingCents = c;
      } else {
        this.pendingCount = 1;
        this.pendingCents = c;
      }
      const need = this.react > 0.85 ? 1 : 2;
      if (this.pendingCount >= need) {
        this.cents = c;
        this.has = true;
        this.pendingCount = 0;
        this.fresh = true;
      }
      return;
    }
    this.pendingCount = 0;
    // time constant: 300 ms (slow) .. 8 ms (fast)
    const tau = 0.3 * Math.pow(0.008 / 0.3, this.react);
    this.cents += (c - this.cents) * (1 - Math.exp(-dt / tau));
    this.fresh = true;
  }

  reset(): void {
    this.lp.forEach((b) => b.reset());
    this.ring.fill(0);
    this.ringPos = 0;
    this.filled = 0;
    this.sinceHop = 0;
    this.has = false;
    this.pendingCount = 0;
  }

  /** {hz, on}: the tracked pitch (0 before the first detection) and whether a pitch is present now. */
  monitor(): FxMonitor | null {
    this.watch = this.sampleRate;
    if (!this.fresh && this.silentFor > 0.3) return null;
    this.fresh = false;
    const hz = this.has ? 440 * Math.pow(2, this.cents / 1200) : 0;
    return { hz, on: this.has && this.silentFor < 0.25, clarity: this.lastClarity, level: this.lastLevel };
  }
}

export const effect: EffectModule = {
  id: 'tuner',
  create: (sr) => new TunerDsp(sr),
};
