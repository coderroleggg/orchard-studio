// Stereo Enhancer (FL: Fruity Stereo Enhancer), modelled on FL's binary:
// - a 2x2 matrix, s = sep/128 (-0.75..0.75), v = (11^(vol/256) - 1) / 10:
//     L' = gL · v(1 - s/2) · (L + s·R)      R' = gR · v(1 - s/2) · (R + s·L)
//   gL = 1 - pan (pan > 0) and -1 when LEFT is inverted; gR = 1 + pan
//   (pan < 0) and -1 when RIGHT is inverted (pan is a balance attenuator,
//   pan = raw/128). The coefficients ramp once per block at most 44.1/sr per
//   sample and start from zero when the plugin is created (fade-in);
// - phase offset: an integer delay of round((1001^(|v|/512) - 1) · 50 ·
//   sr/100000) samples (0..500 ms) on the right channel for v > 0, the left
//   one for v < 0, applied before (PRE) or after (POST) the matrix. Changing
//   the offset clears the delay line, as FL does; offset 0 bypasses it.

import type { EffectInstance, EffectModule } from '../types';

const f32 = Math.fround;

function rint(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

function volGain(v: number): number {
  const s = v / 256;
  if (s === 1) return 1;
  return Math.max(0, (Math.pow(11, s) - 1) * 0.1);
}

/** FL's phase-offset delay in samples for a wheel value. */
export function enhancerDelaySamples(v: number, sampleRate: number): number {
  const x = f32(Math.abs(Math.round(v)) * 0.001953125);
  const units = f32(f32(Math.exp(x * 6.90875477931522) - 1) * 50);
  return Math.max(0, rint(f32(units * f32(sampleRate / 100000))));
}

class StereoEnhancer implements EffectInstance {
  private readonly maxRate: number;
  private readonly sr: number;
  private pan = 0;
  private vol = 1;
  private sep = 0;
  private inv = 0;
  private pos = 1;
  private phase = NaN;
  private dirty = true;
  private readonly cur = new Float64Array(4);
  private readonly tgt = new Float64Array(4);
  // phase-offset delay (one channel)
  private readonly buf: Float32Array;
  private len = 0;
  private wr = 0;
  private ch = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.maxRate = Math.fround(44.1 / sampleRate); // FL: the host's float32 smoothing rate
    this.buf = new Float32Array(enhancerDelaySamples(512, sampleRate) + 2);
    this.setParams({});
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number, lo: number, hi: number) => {
      const v = Number(q[k] ?? d);
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;
    };
    this.pan = f32(num('pan', 0, -128, 128) * 0.0078125);
    this.vol = volGain(num('vol', 256, 0, 320));
    this.sep = f32(num('sep', 0, -96, 96) * 0.0078125);
    this.inv = num('inv', 0, 0, 2);
    this.pos = num('pos', 1, 0, 1);
    const ph = num('phase', 0, -512, 512);
    if (ph !== this.phase) {
      // FL reallocates (and clears) the delay line on every offset change
      this.phase = ph;
      this.len = Math.min(this.buf.length, enhancerDelaySamples(ph, this.sr));
      this.buf.fill(0, 0, this.len);
      this.wr = 0;
      this.ch = ph > 0 ? 1 : 0;
    }
    this.dirty = true;
  }

  private matrix(): void {
    const t = this.tgt;
    const base = f32(this.vol * f32(1 - f32(this.sep * 0.5)));
    let ll = base, rr = base, rl = f32(base * this.sep), lr = rl;
    if (this.pan >= 0) { const g = f32(1 - this.pan); ll = f32(ll * g); rl = f32(rl * g); }
    else { const g = f32(1 + this.pan); rr = f32(rr * g); lr = f32(lr * g); }
    if (this.inv === 1) { ll = -ll; rl = -rl; } else if (this.inv === 2) { rr = -rr; lr = -lr; }
    t[0] = ll; t[1] = rr; t[2] = rl; t[3] = lr;
    this.dirty = false;
  }

  private delay(L: Float32Array, R: Float32Array, n: number): void {
    const b = this.buf, len = this.len, x = this.ch ? R : L;
    let w = this.wr;
    for (let i = 0; i < n; i++) {
      const o = b[w];
      b[w] = x[i];
      x[i] = o;
      if (++w >= len) w = 0;
    }
    this.wr = w;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (n <= 0) return;
    const phaseOn = this.len > 0;
    if (phaseOn && this.pos === 0) this.delay(L, R, n);
    if (this.dirty) this.matrix();
    const cur = this.cur, tgt = this.tgt, rate = this.maxRate;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, d0 = 0, d1 = 0, d2 = 0, d3 = 0;
    for (let k = 0; k < 4; k++) {
      const start = cur[k];
      let d = (tgt[k] - start) / n;
      if (d > rate || d < -rate) {
        d = d > 0 ? rate : -rate;
        let c = start + d * n;
        if (Math.abs(c) < 5.960464477539063e-8) { c = 0; d = -start / n; } // FL: |c| < 2^-24 snaps to 0
        cur[k] = c;
      } else cur[k] = tgt[k];
      if (k === 0) { s0 = start; d0 = d; } else if (k === 1) { s1 = start; d1 = d; } else if (k === 2) { s2 = start; d2 = d; } else { s3 = start; d3 = d; }
    }
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      L[i] = (s0 + d0 * i) * l + (s2 + d2 * i) * r;
      R[i] = (s1 + d1 * i) * r + (s3 + d3 * i) * l;
    }
    if (phaseOn && this.pos === 1) this.delay(L, R, n);
  }

  reset(): void {
    if (this.dirty) this.matrix();
    this.cur.set(this.tgt);
    this.buf.fill(0);
    this.wr = 0;
  }

  get tail(): number {
    return this.len / this.sr;
  }
}

export const effect: EffectModule = {
  id: 'stereoenhancer',
  create: (sampleRate) => new StereoEnhancer(sampleRate),
};
