// Center (FL: Fruity Center), transcribed from FL's binary and bit-exact
// against it (44.1 / 48 / 96 kHz renders). Per channel, in double precision:
//   acc = (x - pos)·k1;  vel += acc;  pos += vel;  vel *= k2;  out = x - pos
// with k1 = float32(4.567e-6 · 44100 / sr) and k2 = float32(0.96): a slow,
// critically damped follower of the input whose subtraction removes DC.
// At the end of every block a state value below 2^-24 is flushed to zero.
// Status Off passes the input untouched and freezes the follower; the state
// starts at zero (and FL clears it on a flush).

import type { EffectInstance, EffectModule } from '../types';

const FLUSH = 5.960464477539063e-8; // float32(2^-24)

class Center implements EffectInstance {
  private on = true;
  private readonly k1: number;
  private readonly k2 = Math.fround(0.96);
  private pL = 0;
  private vL = 0;
  private pR = 0;
  private vR = 0;
  // the follower holds the DC level: after the input stops it decays over ~2 s
  readonly tail = 2.5;

  constructor(sampleRate: number) {
    this.k1 = Math.fround(4.567e-6 * (44100 / sampleRate));
  }

  setParams(p: unknown): void {
    const v = Number((p as Record<string, unknown> | null)?.status ?? 1);
    this.on = Number.isFinite(v) ? Math.round(v) !== 0 : true;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (!this.on || n <= 0) return;
    const k1 = this.k1, k2 = this.k2;
    let pL = this.pL, vL = this.vL, pR = this.pR, vR = this.vR;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      vL += (l - pL) * k1; pL += vL; vL *= k2;
      vR += (r - pR) * k1; pR += vR; vR *= k2;
      L[i] = l - pL;
      R[i] = r - pR;
    }
    // FL's end-of-block denormal flush; also recovers from a non-finite input
    if (!(Math.abs(pL) >= FLUSH) || !Number.isFinite(pL)) pL = 0;
    if (!(Math.abs(vL) >= FLUSH) || !Number.isFinite(vL)) vL = 0;
    if (!(Math.abs(pR) >= FLUSH) || !Number.isFinite(pR)) pR = 0;
    if (!(Math.abs(vR) >= FLUSH) || !Number.isFinite(vR)) vR = 0;
    this.pL = pL; this.vL = vL; this.pR = pR; this.vR = vR;
  }

  reset(): void {
    this.pL = this.vL = this.pR = this.vR = 0;
  }
}

export const effect: EffectModule = {
  id: 'center',
  create: (sampleRate) => new Center(sampleRate),
};
