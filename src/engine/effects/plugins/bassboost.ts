// Bass Boost (FL: Fruity Bass Boost), transcribed from FL's binary and
// bit-exact against it (44.1 / 48 kHz renders, all parameter ranges).
// Per channel, in double precision, a resonant two-pole low-pass of the
// input is added to it:
//   d = (x - pos)·A;  vel += d;  pos += vel;  vel *= B;  out = x + amt·pos
// with c = float32(cos(2π·f / sr)) for the whole-Hz frequency f (20..100):
//   A = float32(2 - 2c),  B = float32(1 + √2·sqrt(-(c-1)^3) / (0.5(c-1)))
// (= 1 - 2√2·sqrt(1 - c)), and amt = float32(11^x - 1) / 2. The low-pass has
// unity gain at DC, so this is a low shelf of 1 + amt (+10.9 dB by default;
// +4.2 dB at f) with a shallow dip about an octave above f (-1.8 dB at
// 120 Hz by default) where the low-pass turns out of phase. Coefficients
// change at once (no smoothing); the state starts at zero.

import type { EffectInstance, EffectModule } from '../types';
import { bassBoostGain, bassBoostHz } from '../../../model/fx/plugins/bassboost';

class BassBoost implements EffectInstance {
  private readonly sr: number;
  private A = 0;
  private B = 0;
  private amt = 0;
  private hz = -1;
  private pL = 0;
  private vL = 0;
  private pR = 0;
  private vR = 0;
  readonly tail = 0.25;

  constructor(sampleRate: number) {
    this.sr = Math.max(1, Math.round(sampleRate)); // FL passes the integer sample rate
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const hz = bassBoostHz(Number(q.freq ?? 512));
    if (hz !== this.hz) {
      this.hz = hz;
      const c = Math.fround(Math.cos((2 * Math.PI * hz) / this.sr));
      this.A = Math.fround(2 - Math.fround(2 * c));
      const t = Math.fround(Math.min(c - 1, -1e-12)); // c < 1 for any audio rate; guards 0/0
      const h = Math.fround(0.5 * t);
      this.B = Math.fround((Math.SQRT2 * Math.sqrt(-(t * (t * t))) + h) / h);
    }
    this.amt = bassBoostGain(Number(q.amount ?? 768));
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (n <= 0) return;
    const A = this.A, B = this.B, amt = this.amt;
    let pL = this.pL, vL = this.vL, pR = this.pR, vR = this.vR;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      vL += (l - pL) * A; pL += vL; vL *= B;
      vR += (r - pR) * A; pR += vR; vR *= B;
      L[i] = pL * amt + l;
      R[i] = pR * amt + r;
    }
    // denormal / non-finite guard (FL has none; the decaying state would
    // otherwise sink into subnormals after the input stops)
    if (!(Math.abs(pL) + Math.abs(vL) > 1e-30) || !Number.isFinite(pL + vL)) { pL = 0; vL = 0; }
    if (!(Math.abs(pR) + Math.abs(vR) > 1e-30) || !Number.isFinite(pR + vR)) { pR = 0; vR = 0; }
    this.pL = pL; this.vL = vL; this.pR = pR; this.vR = vR;
  }

  reset(): void {
    this.pL = this.vL = this.pR = this.vR = 0;
  }
}

export const effect: EffectModule = {
  id: 'bassboost',
  create: (sampleRate) => new BassBoost(sampleRate),
};
