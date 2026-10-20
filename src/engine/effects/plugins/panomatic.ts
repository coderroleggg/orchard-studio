// PanOMatic (FL: Fruity PanOMatic), modelled on FL's binary:
// - the output is a 2x2 matrix (merge pan x volume):
//     pan p >= 0:  L' = (1-p)·v·L            R' = v·(1-p/2)·R + v·(p/2)·L
//     pan p <  0:  L' = v·(1-a/2)·L + v·(a/2)·R   R' = (1-a)·v·R      (a = -p)
//   with v = (11^(vol/256) - 1) / 10;
// - the four coefficients ramp once per block toward their targets, at most
//   44.1/sr per sample (a full-scale change takes ~22.7 ms), starting from
//   zero when the plugin is created (fade-in);
// - the LFO is a 32-bit phase accumulator advanced once per block
//   (phase += inc·n, then sampled) reading FL's 16384-point wavetables; its
//   period is an integer number of samples:
//     P = round((50001^(w/65536) - 1) · w · 2048/sr),  w = 65536 - speed
//   (FL scales by 2048/sr, so the LFO frequency grows with sr^2 exactly as
//   in FL); inc = 2^32 div P. PAN: p = clamp(pan + lfo·amt/128, -1, 1);
//   VOL: v = max(0, v + lfo·amt/256). The phase only runs while a target is
//   selected.

import type { EffectInstance, EffectModule, FxMonitor } from '../types';

const TABLE_BITS = 14;
const TABLE_SIZE = 1 << TABLE_BITS;

/** FL's host wavetables used by the LFO: sine, triangle, square. */
const TABLES: Float32Array[] = (() => {
  const sine = new Float32Array(TABLE_SIZE), tri = new Float32Array(TABLE_SIZE), sq = new Float32Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) {
    const ph = i / TABLE_SIZE;
    sine[i] = Math.sin(2 * Math.PI * ph);
    tri[i] = ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
    sq[i] = ph < 0.5 ? 1 : -1;
  }
  return [sine, tri, sq];
})();

const f32 = Math.fround;

/** Delphi Round (half to even). */
function rint(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** FL's LFO period (samples) for a speed wheel value, with its float32 steps. */
export function panomaticLfoPeriod(speed: number, sampleRate: number): number {
  const w = 65536 - Math.max(0, Math.min(55000, Math.round(speed)));
  const x = f32(w * 1.52587890625e-5);
  const e = f32(Math.exp(x * 10.819798284210286) - 1); // 50001^x - 1
  const p = f32(f32(e * w) * f32(2048 / sampleRate));
  return Math.max(1, rint(p));
}

/** LFO frequency in Hz (for displays and tests). */
export function panomaticLfoHz(speed: number, sampleRate: number): number {
  const inc = Math.floor(4294967296 / panomaticLfoPeriod(speed, sampleRate));
  return (inc * sampleRate) / 4294967296;
}

function volGain(v: number): number {
  const s = v / 256;
  if (s === 1) return 1;
  return Math.max(0, (Math.pow(11, s) - 1) * 0.1);
}

class PanOMatic implements EffectInstance {
  private readonly sr: number;
  private readonly maxRate: number;
  // parameters
  private pan = 0;
  private vol = 1;
  private shape = 0;
  private target = 0;
  private amountRaw = 64;
  private amount = 0.5;
  private speed = -1;
  private inc = 0;
  private phase = 0;
  private dirty = true;
  // coefficients LL, RR, RL (R into L), LR (L into R): current and target
  private readonly cur = new Float64Array(4);
  private readonly tgt = new Float64Array(4);
  // effective (LFO-modulated) pan and volume, for the editor
  private effPan = 0;
  private effVol = 1;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.maxRate = Math.fround(44.1 / sampleRate); // FL: the host's float32 smoothing rate
    this.setParams({});
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number, lo: number, hi: number) => {
      const v = Number(q[k] ?? d);
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
    };
    this.pan = (Math.round(num('pan', 128, 0, 256)) - 128) / 128;
    this.vol = volGain(Math.round(num('vol', 256, 0, 320)));
    this.shape = Math.round(num('shape', 0, 0, 2));
    this.target = Math.round(num('target', 0, 0, 2));
    this.amountRaw = Math.round(num('amount', 64, 0, 128));
    this.amount = this.amountRaw * (this.target === 1 ? 1 / 128 : 1 / 256);
    const speed = Math.round(num('speed', 27500, 0, 55000));
    if (speed !== this.speed) {
      this.speed = speed;
      this.inc = Math.floor(4294967296 / panomaticLfoPeriod(speed, this.sr));
    }
    this.dirty = true;
  }

  /** FL's matrix for a pan (-1..1) and a linear volume. */
  private matrix(pan: number, vol: number): void {
    const t = this.tgt;
    this.effPan = pan;
    this.effVol = vol;
    if (pan >= 0) {
      const lr = pan * 0.5 * vol;
      t[0] = (1 - pan) * vol; t[1] = vol - lr; t[2] = 0; t[3] = lr;
    } else {
      const rl = -pan * 0.5 * vol;
      t[1] = (1 + pan) * vol; t[0] = vol - rl; t[2] = rl; t[3] = 0;
    }
    this.dirty = false;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (n <= 0) return;
    if (this.target > 0) {
      // one LFO step per block (FL: phase += inc * len, then read the table)
      this.phase = (this.phase + ((this.inc * n) % 4294967296)) % 4294967296;
      const lfo = TABLES[this.shape][this.phase >>> (32 - TABLE_BITS)] * this.amount;
      if (this.target === 1) this.matrix(Math.max(-1, Math.min(1, lfo + this.pan)), this.vol);
      else this.matrix(this.pan, Math.max(0, lfo + this.vol));
    } else if (this.dirty) {
      this.matrix(this.pan, this.vol);
    }
    // per-block ramps, rate-limited like FL's smoother
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
    if (d0 === 0 && d1 === 0 && d2 === 0 && d3 === 0) {
      for (let i = 0; i < n; i++) {
        const l = L[i], r = R[i];
        L[i] = s0 * l + s2 * r;
        R[i] = s1 * r + s3 * l;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const l = L[i], r = R[i];
        L[i] = (s0 + d0 * i) * l + (s2 + d2 * i) * r;
        R[i] = (s1 + d1 * i) * r + (s3 + d3 * i) * l;
      }
    }
  }

  reset(): void {
    // FL's reset: coefficients jump to their targets and the LFO restarts
    if (this.dirty) this.matrix(this.pan, this.vol);
    this.cur.set(this.tgt);
    this.phase = 0;
  }

  monitor(): FxMonitor {
    return { pan: this.effPan, vol: this.effVol, target: this.target };
  }
}

export const effect: EffectModule = {
  id: 'panomatic',
  create: (sampleRate) => new PanOMatic(sampleRate),
};
