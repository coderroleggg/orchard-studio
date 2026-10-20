// Flangus (FL: Fruity Flangus), measured against FL's binary. Each channel runs
// Order (1..9) flanger voices. Voice j (position p = j/N) has its own factor r
// from a fixed 18-entry table (left voice j uses r[N-j], right voice j uses
// r[N+j-1]); Spread s blends every voice from a common setting (s = 0) to its
// own one with w = (B^(s/128) - 1) / (B - 1), B = 1001.25 (fitted):
//   base delay  = max(8 samples, D0 * (1 - w (1 - p (1 + w (r - 1)))))
//   sweep       = Amin + S * p                    (Depth span S, scaled by p)
//   rate        = R0(Speed) * ((1 - w) Amin / (Amin + S) + w (1 + w (r - 1)) Amin / (Amin + S p))
//   start phase = 0.75 (left) or 0.25 (right) + 0.5 p w
//   delay(t)    = base + sweep * (1 + psin(phase))  (psin = FL's parabolic sine)
// D0 = 100 ms * (11^(Delay/128) - 1) / 10, S = 24.77 ms * (11^(Depth/1024) - 1) / 10,
// Amin = 10 samples at 44.1 kHz. The read uses FL's rounding interpolator (tap
// round(d), fraction d - round(d) in [-0.5, 0.5), so half the time it
// extrapolates). Voice outputs are scaled by a normalisation that depends on
// the effective voice count N + |cross| (N + 1) / 2; Cross feeds each voice to
// the other side with weight cross * p. Dry and Wet use the 11^x law, signed.
// As in FL, Order, Depth, Delay or Spread changes restart the LFOs with empty
// delay lines (clicks), Speed, Cross and the normalisation switch at once, and
// Dry and Wet slew at 0.001 per sample from 0 (the output fades in over ~1000
// samples after creation).

import type { EffectInstance, EffectModule } from '../types';
import { flangusExp, flangusLevel } from '../../../model/fx/plugins/flangus';

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Per-voice factors (FL's table, measured). */
const R = [
  0.935088, 1.07952, 1.042441, 0.010264, 0.95453, 1.067087, 0.994011, 0.942841, 1.125715,
  0.896814, 1.062961, 0.010182, 1.12999, 0.908209, 0.98209, 1.100402, 0.96632, 1.104601,
];

/** LFO rate (Hz) at Spread 0 and Depth 0 for Speed = 0, 32, ..., 1024 (measured). */
const RATE = [
  0.146031, 0.168772, 0.19507, 0.225487, 0.260669, 0.301396, 0.348513, 0.403087, 0.46628, 0.539499,
  0.62439, 0.722842, 0.837117, 0.96984, 1.12414, 1.30369, 1.51289, 1.75695, 2.04214, 2.37604,
  2.76779, 3.22863, 3.77236, 4.41622, 5.18187, 6.09693, 7.19721, 8.52797, 10.1578, 12.1686,
  14.6852, 17.8874, 22.0501,
];
const LN_RATE = RATE.map(Math.log);

/** Per-voice wet gain versus the effective voice count (measured). */
const NORM_N = [1, 1.125, 1.25, 1.5, 1.75, 2, 2.1875, 2.375, 2.75, 3, 3.25, 3.5, 4, 4.5, 5, 5.25, 6, 6.5, 7, 7.75, 8, 9, 9.5, 10.25, 11, 11.5, 12.5, 13.375, 14];
const NORM_G = [0.96918, 0.95438, 0.93769, 0.90077, 0.86179, 0.82289, 0.79457, 0.76717, 0.7159, 0.68448, 0.65517, 0.62786, 0.57891, 0.53641, 0.49934, 0.48253, 0.4381, 0.41264, 0.3899, 0.35999, 0.351, 0.31907, 0.30514, 0.28639, 0.26977, 0.25973, 0.2417, 0.22786, 0.21889];

function catmull(y: ArrayLike<number>, i: number, t: number): number {
  const n = y.length;
  const y0 = y[Math.max(0, i - 1)], y1 = y[i], y2 = y[Math.min(n - 1, i + 1)], y3 = y[Math.min(n - 1, i + 2)];
  return y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0)));
}

/** Base LFO rate for a Speed value (log-domain Catmull-Rom through the measured points). */
export function flangusRate(speed: number): number {
  const x = Math.max(0, Math.min(1024, speed)) / 32;
  const i = Math.min(31, Math.floor(x));
  return Math.exp(catmull(LN_RATE, i, x - i));
}

/** Per-voice wet normalisation for an effective voice count. */
export function flangusNorm(n: number): number {
  const x = Math.max(1, Math.min(14, n));
  let i = 0;
  while (i < NORM_N.length - 2 && NORM_N[i + 1] <= x) i++;
  const t = (x - NORM_N[i]) / (NORM_N[i + 1] - NORM_N[i]);
  // non-uniform spacing: plain cubic Hermite with finite-difference slopes
  const n0 = NORM_N[i], n1 = NORM_N[i + 1], h = n1 - n0;
  const slope = (k: number) => {
    const a = Math.max(0, k - 1), b = Math.min(NORM_N.length - 1, k + 1);
    return (NORM_G[b] - NORM_G[a]) / (NORM_N[b] - NORM_N[a]);
  };
  const m0 = slope(i) * h, m1 = slope(i + 1) * h, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * NORM_G[i] + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * NORM_G[i + 1] + (t3 - t2) * m1;
}

/** FL's parabolic sine, x in cycles. */
function psin(x: number): number {
  return x < 0.5 ? 16 * x * (0.5 - x) : -16 * (x - 0.5) * (1 - x);
}

const MAXV = 9;
const SPREAD_B = 1001.25;

class Flangus implements EffectInstance {
  private readonly sr: number;
  private readonly buf: [Float32Array, Float32Array];
  private readonly mask: number;
  private w = 0;
  private n = 4;
  // per voice (channel c, voice j at index c * MAXV + j)
  private readonly lo = new Float64Array(2 * MAXV);
  private readonly amp = new Float64Array(2 * MAXV);
  private readonly inc = new Float64Array(2 * MAXV);
  private readonly ph = new Float64Array(2 * MAXV);
  private readonly ph0 = new Float64Array(2 * MAXV);
  private readonly pos = new Float64Array(MAXV);
  // levels: Dry and Wet slew at 0.001 per sample from 0 (FL); the voice
  // normalisation and Cross switch at once (FL)
  private dryT = 0; private dry = 0;
  private lvlT = 0; private lvl = 0;
  private wet = 0;
  private x = 0;
  private key = '';
  private speed = 768;
  private last: Record<string, number> = {};
  private primed = false;
  private tailSec = 0.2;

  constructor(sr: number) {
    this.sr = sr;
    let len = 1;
    while (len < Math.ceil(0.17 * sr) + 8) len <<= 1;
    this.buf = [new Float32Array(len), new Float32Array(len)];
    this.mask = len - 1;
    this.setParams({});
  }

  get tail(): number {
    return this.tailSec;
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const v = {
      order: Math.max(1, Math.min(9, Math.round(num(q.order, 4)))),
      depth: Math.max(0, Math.min(1024, num(q.depth, 512))),
      speed: Math.max(0, Math.min(1024, num(q.speed, 768))),
      delay: Math.max(0, Math.min(128, num(q.delay, 8))),
      spread: Math.max(0, Math.min(128, num(q.spread, 128))),
      cross: Math.max(-128, Math.min(128, num(q.cross, -32))),
      dry: Math.max(-128, Math.min(128, num(q.dry, 96))),
      wet: Math.max(-128, Math.min(128, num(q.wet, 96))),
    };
    this.last = v;
    this.dryT = flangusLevel(v.dry);
    this.lvlT = flangusLevel(v.wet);
    this.x = v.cross / 128;
    // Order / Depth / Delay / Spread re-initialise the voices: FL restarts their LFOs
    // and the delays jump (clicks); Speed only changes the rates
    const key = `${v.order}|${v.depth}|${v.delay}|${v.spread}`;
    if (!this.primed || key !== this.key) {
      this.key = key;
      this.n = v.order;
      this.voices(true);
      // FL re-initialises the voices with empty delay lines
      this.buf[0].fill(0); this.buf[1].fill(0);
    } else if (v.speed !== this.speed) this.voices(false);
    this.speed = v.speed;
    this.wet = this.wetGain(this.n);
  }

  /** Per-voice normalisation for the effective voice count. */
  private wetGain(order: number): number {
    const v = this.last;
    return flangusNorm(order + (Math.abs(v.cross) / 128) * (order + 1) / 2);
  }

  /** Compute voice settings; `restart` resets the LFO phases (FL behaviour). */
  private voices(restart: boolean): void {
    const v = this.last;
    const N = this.n, sr = this.sr;
    const s = v.spread;
    // spread weight (B^x - 1) / (B - 1), B fitted to FL's voices (about 1000)
    const w = (Math.pow(SPREAD_B, s / 128) - 1) / (SPREAD_B - 1);
    const D0 = 0.1 * flangusExp(v.delay / 128) * sr;
    const amin = (10 * sr) / 44100;
    const S = (1092.5 * sr) / 44100 * flangusExp(v.depth / 1024);
    const f0 = flangusRate(v.speed);
    let maxD = 0;
    for (let j = 1; j <= N; j++) {
      const p = j / N;
      this.pos[j - 1] = p;
      for (let c = 0; c < 2; c++) {
        const r = c === 0 ? R[N - j] : R[N + j - 1];
        const i = c * MAXV + j - 1;
        const md = 1 - w * (1 - p * (1 + w * (r - 1)));
        this.lo[i] = Math.max(8, D0 * md);
        this.amp[i] = amin + S * p;
        // rate: blend of the common rate (full sweep) and the voice's own one
        const own = (1 + w * (r - 1)) * (amin / (amin + S * p));
        this.inc[i] = (f0 * ((1 - w) * (amin / (amin + S)) + w * own)) / sr;
        this.ph0[i] = ((c === 0 ? 0.75 : 0.25) + 0.5 * p * w) % 1;
        if (restart) this.ph[i] = this.ph0[i];
        maxD = Math.max(maxD, this.lo[i] + 2 * this.amp[i]);
      }
    }
    this.tailSec = maxD / sr + 0.02;
  }

  process(L: Float32Array, R2: Float32Array, n: number): void {
    if (!this.primed) this.primed = true;
    const bufL = this.buf[0], bufR = this.buf[1], mask = this.mask;
    const N = this.n, maxD = mask - 3;
    const lo = this.lo, amp = this.amp, inc = this.inc, ph = this.ph, pos = this.pos;
    let w = this.w;
    const wet = this.wet, x = this.x;
    // FL slews Dry and Wet by at most 0.001 per sample: a linear ramp per block
    const slew = 0.001 * n;
    const dry0 = this.dry, dry1 = dry0 + Math.max(-slew, Math.min(slew, this.dryT - dry0)), dDry = (dry1 - dry0) / n;
    const lvl0 = this.lvl, lvl1 = lvl0 + Math.max(-slew, Math.min(slew, this.lvlT - lvl0)), dLvl = (lvl1 - lvl0) / n;
    for (let i = 0; i < n; i++) {
      const dry = dry0 + dDry * i;
      const lvl = lvl0 + dLvl * i;
      const il = L[i], ir = R2[i];
      const xl = il - il === 0 ? il : 0, xr = ir - ir === 0 ? ir : 0;   // NaN / Inf -> 0
      bufL[w] = xl;
      bufR[w] = xr;
      let dL = 0, dR = 0, cL = 0, cR = 0;
      for (let j = 0; j < N; j++) {
        // left voice
        let a = ph[j] + inc[j];
        if (a >= 1) a -= 1;
        ph[j] = a;
        let d = lo[j] + amp[j] * (1 + psin(a));
        if (d > maxD) d = maxD; else if (d < 0) d = 0;
        let t = Math.round(d);
        let f = d - t;
        let ip = (w - t) & mask;
        let y = bufL[ip] + (bufL[(ip - 1) & mask] - bufL[ip]) * f;
        dL += y; cL += pos[j] * y;
        // right voice
        const jr = MAXV + j;
        a = ph[jr] + inc[jr];
        if (a >= 1) a -= 1;
        ph[jr] = a;
        d = lo[jr] + amp[jr] * (1 + psin(a));
        if (d > maxD) d = maxD; else if (d < 0) d = 0;
        t = Math.round(d);
        f = d - t;
        ip = (w - t) & mask;
        y = bufR[ip] + (bufR[(ip - 1) & mask] - bufR[ip]) * f;
        dR += y; cR += pos[j] * y;
      }
      const g = lvl * wet;
      L[i] = dry * xl + g * (dL + x * cR);
      R2[i] = dry * xr + g * (dR + x * cL);
      w = (w + 1) & mask;
    }
    this.w = w; this.dry = dry1; this.lvl = lvl1;
  }

  reset(): void {
    this.buf[0].fill(0);
    this.buf[1].fill(0);
    this.voices(true);
  }
}

export const effect: EffectModule = {
  id: 'flangus',
  create: (sr) => new Flangus(sr),
};
