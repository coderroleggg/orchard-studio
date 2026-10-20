// Stereo Shaper (FL: Fruity Stereo Shaper), modelled on FL's binary:
// - mixer matrix: L' = gLL·L + gRL·R, R' = gRR·R + gLR·L with each slider
//   g = sign(v)·(3^(|v|/12800) - 1)/2 (12800 = 1, 25600 = 4); coefficients
//   ramp once per block at most 44.1/sr per sample, from zero at creation;
// - effects, before ("pre mixer") or after ("post mixer", default) the
//   matrix: an integer delay of round((1001^(|d|/4096) - 1)·50·sr/100000)
//   samples on R (d > 0) or L (d < 0), cleared on every change; then an RBJ
//   all-pass biquad (Q = 0.5, direct form I in double) at
//   10 + 4.398·(5001^(1 - |p|/4096) - 1) Hz on R (p > 0) or L (p < 0),
//   bypassed (state cleared) at p = 0;
// - difference output: input - output, mixed into the selected track
//   (FL: the plugin output that the host routes to that track).

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';

const f32 = Math.fround;
const LN3 = f32(Math.log(3));

function rint(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** FL's signed slider gain (float32 steps as in the binary). */
export function shaperSliderGain(raw: number): number {
  const x = f32(raw * 7.8125e-5);
  const a = Math.abs(x);
  const g = a === 1 ? 1 : f32((Math.exp(f32(a * LN3)) - 1) * 0.5);
  return x === 0 ? 0 : x < 0 ? -g : g;
}

export function shaperDelaySamples(raw: number, sampleRate: number): number {
  const x = f32(Math.abs(Math.round(raw)) * 0.000244140625);
  const units = f32(f32(Math.exp(x * 6.90875477931522) - 1) * 50);
  return Math.max(0, rint(f32(units * f32(sampleRate / 100000))));
}

export function shaperAllpassFreq(raw: number): number {
  const s = f32(1 - Math.abs(Math.round(raw)) * 0.000244140625);
  const e = f32(Math.exp(s * 8.517393171418904) - 1);
  return f32(e * 4.398 + 10);
}

class StereoShaper implements EffectInstance {
  private readonly sr: number;
  private readonly maxRate: number;
  private readonly raw = new Int32Array([0, 12800, 12800, 0]);
  private dirty = true;
  private readonly cur = new Float64Array(4); // LL, RR, RL, LR
  private readonly tgt = new Float64Array(4);
  private fxpos = 1;
  private diff = -1;
  // delay
  private delayRaw = NaN;
  private readonly dbuf: Float32Array;
  private dlen = 0;
  private dpos = 0;
  private dch = 0;
  // all-pass (DF1 biquad, double)
  private apRaw = NaN;
  private apSign = 0;
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  // difference
  private readonly inL: Float32Array;
  private readonly inR: Float32Array;
  private peakDiff = 0;

  constructor(sampleRate: number, blockSize: number) {
    this.sr = sampleRate;
    this.maxRate = Math.fround(44.1 / sampleRate); // FL: the host's float32 smoothing rate
    this.dbuf = new Float32Array(shaperDelaySamples(4096, sampleRate) + 2);
    const n = Math.max(1, blockSize | 0);
    this.inL = new Float32Array(n);
    this.inR = new Float32Array(n);
    this.setParams({});
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number, lo: number, hi: number) => {
      const v = Number(q[k] ?? d);
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;
    };
    const keys = ['rl', 'lvol', 'rvol', 'lr'], defs = [0, 12800, 12800, 0];
    for (let k = 0; k < 4; k++) this.raw[k] = num(keys[k], defs[k], -25600, 25600);
    this.dirty = true;
    this.fxpos = Number(q.fxpos ?? 1) === 0 ? 0 : 1;
    const t = Number(q.diff ?? -1);
    this.diff = Number.isInteger(t) && t >= 0 ? t : -1;
    const d = num('delay', 0, -4096, 4096);
    if (d !== this.delayRaw) {
      this.delayRaw = d;
      this.dlen = Math.min(this.dbuf.length, shaperDelaySamples(d, this.sr));
      this.dbuf.fill(0, 0, this.dlen);
      this.dpos = 0;
      this.dch = d > 0 ? 1 : 0;
    }
    const ph = num('dephase', 0, -4096, 4096);
    if (ph !== this.apRaw) {
      this.apRaw = ph;
      this.apSign = Math.sign(ph);
      if (this.apSign === 0) {
        this.x1 = this.x2 = this.y1 = this.y2 = 0;
      } else {
        const fc = Math.min(shaperAllpassFreq(ph), f32(this.sr / 2));
        const w = fc * ((2 * Math.PI) / this.sr);
        const alpha = Math.sin(w), cs = Math.cos(w);
        const a0 = 1 / (1 + alpha);
        this.a1 = -2 * cs * a0;
        this.a2 = (1 - alpha) * a0;
        this.b0 = this.a2;
        this.b1 = this.a1;
        this.b2 = 1;
      }
    }
  }

  sendTargets(): number[] {
    return this.diff >= 0 ? [this.diff] : [];
  }

  private effects(L: Float32Array, R: Float32Array, n: number): void {
    if (this.dlen > 0) {
      const b = this.dbuf, len = this.dlen, x = this.dch ? R : L;
      let w = this.dpos;
      for (let i = 0; i < n; i++) {
        const o = b[w];
        b[w] = x[i];
        x[i] = o;
        if (++w >= len) w = 0;
      }
      this.dpos = w;
    }
    if (this.apSign !== 0) {
      const x = this.apSign > 0 ? R : L;
      const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
      let x1 = this.x1, x2 = this.x2, y1 = this.y1, y2 = this.y2;
      for (let i = 0; i < n; i++) {
        const xn = x[i];
        const y = b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = xn;
        y2 = y1; y1 = y;
        x[i] = y;
      }
      // the filter is stable; guard against non-finite input and flush denormals
      if (!(Math.abs(y1) < 1e30 && Math.abs(y2) < 1e30)) { x1 = x2 = y1 = y2 = 0; }
      else if (Math.abs(y1) < 1e-30 && Math.abs(y2) < 1e-30) { y1 = y2 = 0; }
      this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2;
    }
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (n <= 0) return;
    const sendDiff = this.diff >= 0 && this.diff !== ctx.track && n <= this.inL.length;
    if (sendDiff) { this.inL.set(L.subarray(0, n)); this.inR.set(R.subarray(0, n)); }
    if (this.fxpos === 0) this.effects(L, R, n);
    if (this.dirty) {
      const t = this.tgt, r = this.raw;
      t[0] = shaperSliderGain(r[1]); // left channel volume
      t[1] = shaperSliderGain(r[2]); // right channel volume
      t[2] = shaperSliderGain(r[0]); // right into left
      t[3] = shaperSliderGain(r[3]); // left into right
      this.dirty = false;
    }
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
    if (this.fxpos === 1) this.effects(L, R, n);
    if (sendDiff) {
      const a = this.inL, b = this.inR;
      let pk = this.peakDiff;
      for (let i = 0; i < n; i++) {
        const dl = a[i] - L[i], dr = b[i] - R[i];
        a[i] = dl; b[i] = dr;
        const m = Math.max(Math.abs(dl), Math.abs(dr));
        if (m > pk) pk = m;
      }
      this.peakDiff = pk;
      ctx.sendTo(this.diff, a, b, n, 1, 1);
    }
  }

  reset(): void {
    if (this.dirty) {
      const t = this.tgt, r = this.raw;
      t[0] = shaperSliderGain(r[1]); t[1] = shaperSliderGain(r[2]); t[2] = shaperSliderGain(r[0]); t[3] = shaperSliderGain(r[3]);
      this.dirty = false;
    }
    this.cur.set(this.tgt);
    this.dbuf.fill(0);
    this.dpos = 0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  get tail(): number {
    // delay line plus the all-pass ring-out (its lowest setting, 10 Hz, decays in ~0.2 s)
    return this.dlen / this.sr + (this.apSign !== 0 ? 0.25 : 0);
  }

  monitor(): FxMonitor {
    const m = { diffPeak: this.peakDiff };
    this.peakDiff = 0;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'stereoshaper',
  create: (sampleRate, blockSize) => new StereoShaper(sampleRate, blockSize),
};
