// Parametric EQ (FL: Fruity Parametric EQ). A port of FL's plugin code (arm64:
// Eff_Render 0x5c1a0, band update 0x5b7a0, coefficient routines 0x176a20 /
// 0x176470, stereo biquad kernel 0x2350; see docs/research/fx/peq.md):
//
//   main level first: x * (11^(v/128) - 1) / 10 (single precision; a copy at 128)
//   then seven bands in series, each FL's stereo direct form I biquad in double
//   precision, y = ((b1 x1 + b2 x2) - a1 y1 - a2 y2) + b0 x, the output rounded
//   to single between bands.
//   frequency: f32(10 + 159.9 f32(101^t - 1)), t = wheel/65536, clamped to 0.4999 fs
//   low/band/high pass, notch: RBJ, Q = 0.1 + 18.9 t
//   peaking: RBJ, Q = 0.1 + 0.0999 (1001^t - 1), A = 10^(dB/40) (single)
//   shelves: RBJ slope form, S = 0.1 + 1.9 t
//
// Parameter changes act like FL's: new coefficients from the next block (no
// smoothing; the band state is kept), a type change clears the band's state,
// a disabled band stops at once (its state stays), and a 0 dB peaking / shelf
// band keeps running for fs/5 samples with 0 dB coefficients (so it rings
// out), then its state is cleared and it is skipped.
//
// Departure (keeps the output finite): non-finite filter states are cleared.

import type { EffectInstance, EffectModule } from '../types';
import type { BiquadCoefs } from '../../dsp/biquad';
import { PEQ_BANDS, PEQ_DEF_FREQ, PEQ_DEF_TYPE, PEQ_DEF_WIDTH, PEQ_LSHELF, PEQ_PEAK, PEQ_HSHELF } from '../../../model/fx/plugins/peq';

const f32 = Math.fround;
const LN11 = f32(Math.log(11));
const TENTH = f32(0.1);
const HUNDREDTH = f32(0.01);
/** FL's type value -> its filter library code (1 LP, 2 BP, 3 notch, 4 HP, 6 low shelf, 7 peaking, 8 high shelf). */
const CODE = [0, 1, 2, 4, 3, 6, 7, 8];

/** True for the band types that use the level (peaking and shelves). */
export function peqUsesLevel(type: number): boolean {
  return type === PEQ_LSHELF || type === PEQ_PEAK || type === PEQ_HSHELF;
}

/** FPC's Math.Power for single precision. */
function power32(base: number, e: number): number {
  if (e === 0) return 1;
  if (base === 0 && e > 0) return 0;
  if (Math.trunc(e) === e) {
    let r = 1, b = base, n = Math.abs(e);
    while (n > 0) { if (n & 1) r = f32(r * b); b = f32(b * b); n >>= 1; }
    return e < 0 ? f32(1 / r) : r;
  }
  return f32(Math.exp(e * Math.log(base)));
}

/** Main level gain as FL computes it (single precision except the exp; exactly 1 at 128). */
function mainGain(v: number): number {
  const s = f32(v * 0.0078125);
  if (s === 1) return 1;
  return f32((Math.exp(f32(s * LN11)) - 1) * TENTH);
}

/** Band frequency (Hz, single precision) for a wheel value. */
function bandFreq(v: number): number {
  const t = f32(v * 1.52587890625e-5);
  const s = f32(Math.exp(t * 4.61512051684126) - 1);
  return f32(s * 159.9 + 10);
}

/**
 * FL's coefficients of one band into `c` (no allocation). `levelDb` is the
 * level in dB (wheel / 100). Returns false when FL does not run the band at
 * all (disabled); a 0 dB peak / shelf returns true with 0 dB coefficients.
 */
export function peqDesign(c: BiquadCoefs, type: number, levelDb: number, freqWheel: number, widthWheel: number, fs: number): boolean {
  const code = CODE[Math.min(7, Math.max(0, Math.round(type)))];
  if (code === 0) { c.b0 = 1; c.b1 = 0; c.b2 = 0; c.a1 = 0; c.a2 = 0; return false; }
  const level = f32(f32(Math.round(levelDb * 100)) * HUNDREDTH);
  const width = f32(Math.min(65536, Math.max(0, Math.round(widthWheel))) * 1.52587890625e-5);
  let freq = bandFreq(Math.min(65536, Math.max(0, Math.round(freqWheel))));
  const fmax = f32(fs * 0.4999);
  if (freq > fmax) freq = fmax;
  const w0 = freq * (6.283185307179586 * (1 / fs)); // FL's TAudioRenderer: 2 pi (1 / fs)
  const sn = Math.sin(w0), cs = Math.cos(w0);
  let A = 0, k: number;
  if (code <= 5) {
    k = sn / (2 * (0.1 + 18.9 * width)); // alpha
  } else if (code === 7) {
    A = power32(10, f32(level * 0.025));
    const q = 0.1 + f32(Math.exp(width * Math.log(f32(1001))) - 1) * 0.0999;
    k = sn / (2 * q); // alpha
  } else {
    A = power32(10, f32(level * 0.025));
    const S = 0.1 + 1.9 * width;
    k = Math.sqrt((A * A + 1) / S - (A - 1) * (A - 1)); // beta (x sin below)
  }
  let d: number;
  switch (code) {
    case 1: d = 1 / (1 + k); c.a1 = d * (-2 * cs); c.a2 = d * (1 - k); c.b1 = d * (1 - cs); c.b0 = c.b1 * 0.5; c.b2 = c.b0; break;
    case 2: d = 1 / (1 + k); c.a1 = d * (-2 * cs); c.a2 = d * (1 - k); c.b1 = 0; c.b0 = d * k; c.b2 = d * -k; break;
    case 3: d = 1 / (1 + k); c.a1 = d * (-2 * cs); c.a2 = d * (1 - k); c.b1 = c.a1; c.b0 = d; c.b2 = d; break;
    case 4: d = 1 / (1 + k); c.a1 = d * (-2 * cs); c.a2 = d * (1 - k); c.b1 = d * -(1 + cs); c.b0 = -c.b1 * 0.5; c.b2 = c.b0; break;
    case 6: {
      const am = (A - 1) * cs, bs = k * sn;
      d = 1 / ((A + 1) + am + bs);
      c.a1 = d * (-2 * ((A - 1) + (A + 1) * cs));
      c.a2 = d * ((A + 1) + am - bs);
      c.b1 = d * ((2 * A) * ((A - 1) - (A + 1) * cs));
      c.b0 = d * (A * (((A + 1) - am) + bs));
      c.b2 = d * (A * (((A + 1) - am) - bs));
      break;
    }
    case 7: {
      const ka = k / A;
      d = 1 / (1 + ka);
      c.a1 = d * (-2 * cs); c.a2 = d * (1 - ka); c.b1 = c.a1;
      const kb = k * A;
      c.b0 = d * (1 + kb); c.b2 = d * (1 - kb);
      break;
    }
    default: {
      const am = (A - 1) * cs, bs = k * sn;
      d = 1 / (((A + 1) - am) + bs);
      c.a1 = d * (2 * ((A - 1) - (A + 1) * cs));
      c.a2 = d * (((A + 1) - am) - bs);
      c.b1 = d * ((-2 * A) * ((A - 1) + (A + 1) * cs));
      c.b0 = d * (A * (((A + 1) + am) + bs));
      c.b2 = d * (A * (((A + 1) + am) - bs));
    }
  }
  return true;
}

interface Band {
  type: number;
  level: number; freq: number; width: number;
  c: BiquadCoefs;
  /** FL's activity counter: -1 runs, 0 skipped, > 0 samples left before the state is cleared. */
  count: number;
  /** DF1 state: x1, x2, y1, y2 for L and R. */
  s: Float64Array;
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : d;
}

class ParametricEQ implements EffectInstance {
  latency = 0;
  tail = 0.25;
  private readonly fs: number;
  private bands: Band[] = [];
  private main = 1;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    for (let b = 0; b < PEQ_BANDS; b++) {
      this.bands.push({
        type: -1, level: NaN, freq: NaN, width: NaN,
        c: { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }, count: 0, s: new Float64Array(8),
      });
    }
  }

  /** FL's band update (after a level / frequency / width / type change). */
  private update(b: Band): void {
    const on = peqDesign(b.c, b.type, b.level / 100, b.freq, b.width, this.fs);
    if (!on) { b.count = 0; return; }
    b.count = peqUsesLevel(b.type) && f32(f32(b.level) * HUNDREDTH) === 0 ? Math.trunc(Math.trunc(this.fs) / 5) : -1;
  }

  /** Seconds the active bands ring (60 dB, from the pole radius), at most 5 s; plus FL's 0 dB ring-out. */
  private ringTail(): number {
    let t = 0.25;
    for (const b of this.bands) {
      if (b.count === 0) continue;
      const r2 = b.c.a2; // pole radius^2
      if (r2 > 0 && r2 < 1) t = Math.max(t, Math.min(5, (-6.907755 * 2) / (Math.log(r2) * this.fs)));
    }
    return t;
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    for (let i = 0; i < PEQ_BANDS; i++) {
      const b = this.bands[i];
      const type = Math.min(7, Math.max(0, num(q[`type${i + 1}`], PEQ_DEF_TYPE[i])));
      const level = Math.min(1800, Math.max(-1800, num(q[`level${i + 1}`], 0)));
      const freq = Math.min(65536, Math.max(0, num(q[`freq${i + 1}`], PEQ_DEF_FREQ[i])));
      const width = Math.min(65536, Math.max(0, num(q[`width${i + 1}`], PEQ_DEF_WIDTH[i])));
      if (type !== b.type) b.s.fill(0); // FL clears the band state when its type changes
      if (type !== b.type || level !== b.level || freq !== b.freq || width !== b.width) {
        b.type = type; b.level = level; b.freq = freq; b.width = width;
        this.update(b);
      }
    }
    this.main = mainGain(Math.min(256, Math.max(0, num(q.main, 128))));
    this.tail = this.ringTail();
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    // main level first (FL)
    const g = this.main;
    if (g !== 1) {
      for (let i = 0; i < n; i++) { L[i] = f32(L[i] * g); R[i] = f32(R[i] * g); }
    }
    for (let k = 0; k < PEQ_BANDS; k++) {
      const b = this.bands[k];
      if (b.count === 0) continue;
      const c = b.c, s = b.s;
      const b0 = c.b0, b1 = c.b1, b2 = c.b2, a1 = c.a1, a2 = c.a2;
      let x1l = s[0], x2l = s[1], y1l = s[2], y2l = s[3];
      let x1r = s[4], x2r = s[5], y1r = s[6], y2r = s[7];
      for (let i = 0; i < n; i++) {
        let x = L[i];
        let y = ((b1 * x1l + b2 * x2l) - a1 * y1l - a2 * y2l) + b0 * x;
        x2l = x1l; x1l = x; y2l = y1l; y1l = y;
        L[i] = y;
        x = R[i];
        y = ((b1 * x1r + b2 * x2r) - a1 * y1r - a2 * y2r) + b0 * x;
        x2r = x1r; x1r = x; y2r = y1r; y1r = y;
        R[i] = y;
      }
      if (!Number.isFinite(y1l + y2l + y1r + y2r + x1l + x1r)) { x1l = x2l = y1l = y2l = x1r = x2r = y1r = y2r = 0; }
      s[0] = x1l; s[1] = x2l; s[2] = y1l; s[3] = y2l;
      s[4] = x1r; s[5] = x2r; s[6] = y1r; s[7] = y2r;
      if (b.count > 0) {
        b.count -= n;
        if (b.count <= 0) { b.count = 0; s.fill(0); }
      }
    }
  }

  reset(): void {
    for (const b of this.bands) b.s.fill(0);
  }
}

export const effect: EffectModule = {
  id: 'peq',
  create: (sampleRate) => new ParametricEQ(sampleRate),
};
