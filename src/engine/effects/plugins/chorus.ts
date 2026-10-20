// Chorus (FL: Fruity Chorus, a Smart Electronix port), measured against FL's
// binary: three delay voices per channel, each swept between Delay and
// Delay + Depth by its own free-running LFO (the right channel's LFOs lead by
// Stereo, 0..180 degrees), read with linear interpolation. The voices are fed
// with one band of a cross-over filter (a bilinear one-pole low-pass: "Process
// LF" chorus the low band, "Process HF" the rest) while the dry signal stays
// full band. Output = 0.7 dry (unless Wet only) + 0.42 per voice. No feedback.
// As in FL, every parameter change applies at once (no glides; Delay jumps click).

import type { EffectInstance, EffectModule } from '../types';
import { chorusCutoffHz, chorusDelayMs, chorusDepthMs, chorusLfoHz, chorusProcessLF, chorusWave, chorusWetOnly } from '../../../model/fx/plugins/chorus';

const DRY = 0.7;
const VOICE = 0.42;
/** FL clamps the cross-over cutoff just below a quarter of the sample rate. */
const MAX_CUT = 0.24396;

// multi-sin = (sin x + (sin 2x + sin 3x) / 3) normalised to a peak of 1 (true sines, unlike "sin")
const TAB = 4096;
const MULTI = new Float32Array(TAB + 2);
{
  const K = 1 / 1.2761423749153966;
  for (let i = 0; i <= TAB + 1; i++) {
    const a = (2 * Math.PI * i) / TAB;
    MULTI[i] = K * (Math.sin(a) + (Math.sin(2 * a) + Math.sin(3 * a)) / 3);
  }
}

/** FL's "sin" LFO: a parabolic sine approximation (x in cycles, 0..1). */
function psin(x: number): number {
  return x < 0.5 ? 16 * x * (0.5 - x) : -16 * (x - 0.5) * (1 - x);
}

function multi(x: number): number {
  const p = x * TAB;
  const i = p | 0;
  const f = p - i;
  return MULTI[i] + (MULTI[i + 1] - MULTI[i]) * f;
}

/** LFO value in -1..1 for wave w (0 sin, 1 sin^3, 2 multi-sin, 3 multi-sin^3) at phase x (cycles). */
function lfo(w: number, x: number): number {
  switch (w) {
    case 0: return psin(x);
    case 1: { const s = psin(x); return s * s * s; }
    case 2: return multi(x);
    default: { const m = multi(x); return m * m * m; }
  }
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const F = Math.fround;

class Chorus implements EffectInstance {
  readonly tail = 0.04;
  private readonly sr: number;
  private readonly bufL: Float32Array;
  private readonly bufR: Float32Array;
  private readonly mask: number;
  private w = 0;
  // settings (FL applies Delay, Depth, Stereo, the LFOs and Wet only at once)
  private dly = 0;          // samples
  private dep = 0;
  private st = 0;           // cycles
  private dry = DRY;
  private readonly inc = new Float64Array(3);
  private readonly ph = new Float64Array(3);
  private readonly wave = new Int8Array(3);
  // cross-over (band 1 = low, cut-off Hz), also switched at once
  private lf = 0; private cut = 320;
  private p = 0; private b = 0;
  private lpL = 0; private lpR = 0; private x1L = 0; private x1R = 0;

  constructor(sr: number) {
    this.sr = sr;
    let len = 1;
    while (len < Math.ceil(0.0365 * sr) + 8) len <<= 1;
    this.bufL = new Float32Array(len);
    this.bufR = new Float32Array(len);
    this.mask = len - 1;
    this.setParams({});
    this.coef(this.cut);
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const ms = this.sr / 1000;
    this.dly = chorusDelayMs(num(q.delay, 512)) * ms;
    this.dep = chorusDepthMs(num(q.depth, 2250)) * ms;
    this.st = (num(q.stereo, 341) / 1024) * 0.5;
    const rates = [num(q.lfo1Freq, 1500), num(q.lfo2Freq, 2500), num(q.lfo3Freq, 3500)];
    const waves = [num(q.lfo1Wave, 23), num(q.lfo2Wave, 0), num(q.lfo3Wave, 0)];
    for (let v = 0; v < 3; v++) {
      // FL accumulates the LFO phases in single precision (rate drift of up to ~0.1 %)
      this.inc[v] = F(chorusLfoHz(rates[v]) / this.sr);
      this.wave[v] = chorusWave(waves[v]);
    }
    this.dry = chorusWetOnly(num(q.wetOnly, 0)) ? 0 : DRY;
    this.lf = chorusProcessLF(num(q.crossType, 0)) ? 1 : 0;
    const cut = Math.min(chorusCutoffHz(num(q.crossCutoff, 2500)), MAX_CUT * this.sr);
    if (cut !== this.cut) { this.cut = cut; this.coef(cut); }
  }

  /** Bilinear one-pole low-pass: y = b (x + x[-1]) + p y[-1]. */
  private coef(fc: number): void {
    const t = Math.tan((Math.PI * fc) / this.sr);
    this.p = (1 - t) / (1 + t);
    this.b = (1 - this.p) * 0.5;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const bufL = this.bufL, bufR = this.bufR, mask = this.mask;
    const maxD = mask - 2;
    let w = this.w, lpL = this.lpL, lpR = this.lpR, x1L = this.x1L, x1R = this.x1R;
    const dly = this.dly, dep = this.dep, st = this.st, g = this.dry;
    const ph = this.ph, inc = this.inc, wave = this.wave;
    const p = this.p, b = this.b, lfw = this.lf;

    for (let i = 0; i < n; i++) {
      const il = L[i], ir = R[i];
      const xl = il - il === 0 ? il : 0, xr = ir - ir === 0 ? ir : 0;   // NaN / Inf -> 0
      // cross-over: band = HP + lf * (LP - HP)
      lpL = b * (xl + x1L) + p * lpL; x1L = xl;
      lpR = b * (xr + x1R) + p * lpR; x1R = xr;
      const hpL = xl - lpL, hpR = xr - lpR;
      bufL[w] = hpL + lfw * (lpL - hpL);
      bufR[w] = hpR + lfw * (lpR - hpR);

      let wl = 0, wr = 0;
      for (let v = 0; v < 3; v++) {
        let x = F(ph[v] + inc[v]);
        if (x >= 1) x = F(x - 1);
        ph[v] = x;
        let xR = x + st;
        if (xR >= 1) xR -= 1;
        const uL = lfo(wave[v], x), uR = lfo(wave[v], xR);
        // left voice
        let d = dly + dep * (uL + 1) * 0.5;
        if (d > maxD) d = maxD; else if (d < 0) d = 0;
        let pos = w - d + mask + 1;
        let ip = pos | 0;
        let fr = pos - ip;
        let s0 = bufL[ip & mask];
        wl += s0 + (bufL[(ip + 1) & mask] - s0) * fr;
        // right voice
        d = dly + dep * (uR + 1) * 0.5;
        if (d > maxD) d = maxD; else if (d < 0) d = 0;
        pos = w - d + mask + 1;
        ip = pos | 0;
        fr = pos - ip;
        s0 = bufR[ip & mask];
        wr += s0 + (bufR[(ip + 1) & mask] - s0) * fr;
      }
      L[i] = g * xl + VOICE * wl;
      R[i] = g * xr + VOICE * wr;
      w = (w + 1) & mask;
    }
    // denormal flush / recovery from non-finite input
    if (!(Math.abs(lpL) > 1e-30)) lpL = 0;
    if (!(Math.abs(lpR) > 1e-30)) lpR = 0;
    if (!Number.isFinite(x1L + x1R)) { x1L = x1R = 0; this.bufL.fill(0); this.bufR.fill(0); }
    this.w = w; this.lpL = lpL; this.lpR = lpR; this.x1L = x1L; this.x1R = x1R;
  }

  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.lpL = this.lpR = this.x1L = this.x1R = 0;
  }
}

export const effect: EffectModule = {
  id: 'chorus',
  create: (sr) => new Chorus(sr),
};
