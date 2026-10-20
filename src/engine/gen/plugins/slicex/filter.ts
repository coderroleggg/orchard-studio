// Slicex's articulator filter (FL: coefficients 0x7b760 per filter type, FL's RBJ biquad setup
// 0x216c00, the NEON stereo biquad 0x4b44 (direct form I in double, float in / out)). One to three
// identical stages; the cutoff wheel maps exponentially, frequencies are referenced to 44.1 kHz
// (FL's 44100 / rate factor) and clamped below 0.907 pi.

import { exp, log, sin, cos } from './libm';
const f32 = Math.fround;
const OM_MAX = 2.849517146113191;

/** Biquad types of FL's table 0x3ace00 for the filter types 0 LP, 1 BP, 2 BS, 3 HP. */
const BQ_TYPE = [1, 2, 3, 4];

export class FilterStage {
  type = 1;
  b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  /** Memory per channel: x1, x2, y1, y2. */
  xl1 = 0; xl2 = 0; yl1 = 0; yl2 = 0;
  xr1 = 0; xr2 = 0; yr1 = 0; yr2 = 0;

  reset(): void {
    this.xl1 = this.xl2 = this.yl1 = this.yl2 = 0;
    this.xr1 = this.xr2 = this.yr1 = this.yr2 = 0;
  }

  /** FL 0x216c00 for the four types Slicex uses (alpha, sin and cos of the angle). */
  setup(alpha: number, cs: number): void {
    const a0 = 1 / (1 + alpha);
    this.a1 = a0 * (-2 * cs);
    this.a2 = a0 * (1 - alpha);
    switch (this.type) {
      case 1:
        this.b1 = a0 * (1 - cs);
        this.b0 = this.b1 * 0.5;
        this.b2 = this.b0;
        break;
      case 2:
        this.b1 = 0;
        this.b0 = a0 * alpha;
        this.b2 = a0 * -alpha;
        break;
      case 3:
        this.b1 = this.a1;
        this.b0 = a0;
        this.b2 = a0;
        break;
      default:
        this.b1 = a0 * -(1 + cs);
        this.b0 = -this.b1 * 0.5;
        this.b2 = this.b0;
    }
  }

  /** FL's stereo biquad kernel over n frames in place. */
  process(L: Float32Array, R: Float32Array, o: number, n: number): void {
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    let x1 = this.xl1, x2 = this.xl2, y1 = this.yl1, y2 = this.yl2;
    for (let i = o; i < o + n; i++) {
      const x = L[i];
      const y = (b2 * x2 + b1 * x1) - a1 * y1 - a2 * y2 + b0 * x;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      L[i] = f32(y);
    }
    this.xl1 = x1; this.xl2 = x2; this.yl1 = y1; this.yl2 = y2;
    x1 = this.xr1; x2 = this.xr2; y1 = this.yr1; y2 = this.yr2;
    for (let i = o; i < o + n; i++) {
      const x = R[i];
      const y = (b2 * x2 + b1 * x1) - a1 * y1 - a2 * y2 + b0 * x;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      R[i] = f32(y);
    }
    this.xr1 = x1; this.xr2 = x2; this.yr1 = y1; this.yr2 = y2;
  }
}

/** FPC's Power(single, single) for a non-integer exponent (0x1a4960): exp(b ln a) in double. */
function powF(a: number, b: number): number {
  return f32(exp(f32(b) * log(f32(a))));
}

/**
 * FL 0x7b760: the stages' coefficients from cutoff and resonance (0..1 plus modulation).
 * `fexp` = 1 / stages, `fscale` = stages (BS: 1 / stages) x ln 2 / 2, `isr` = 44100 / rate.
 */
export function filterCoefs(st: FilterStage[], count: number, ftype: number, cut: number, res: number, fexp: number, fscale: number, isr: number): void {
  let c: number, q: number, ofs: number, alphaBw = false;
  if (ftype === 0 || ftype === 3) {
    const k = ftype === 0 ? 0.0006646666666666667 : 0.00039993333333333331;
    if (!(cut > 0)) c = 0;
    else {
      c = f32(exp(f32(cut) * 7.3138868316334618) - 1) * k;
      if (ftype === 3 && c > 0.60009999999999997) c = 0.60009999999999997;
    }
    if (!(res > 0)) q = 0.1;
    else if (res >= 1) q = 50;
    else q = f32(exp(f32(res) * 7.6014023345837334) - 1) * 0.02495 + 0.1;
    if (count > 1) q = powF(q, fexp);
    q = 0.5 / q;
    ofs = ftype === 0 ? 0.003 : 0.0001;
  } else if (ftype === 1 || ftype === 2) {
    if (!(cut > 0)) c = 0;
    else {
      c = f32(exp(f32(cut) * 7.3138868316334618) - 1) * 0.00039993333333333331;
      if (c > 1.0001) c = 1.0001;
    }
    if (!(res > 0)) q = 0.01;
    else if (res >= 1) q = 12;
    else q = f32(exp(f32(res) * 4.6151205168412597) - 1) * 0.1199 + 0.01;
    q = q * fscale;
    ofs = 0.0001;
    alphaBw = true;
  } else return;
  const w = isr * 3.141592653589793 * 2;
  for (let i = 0; i < count; i++) {
    const s = st[i];
    s.type = BQ_TYPE[ftype];
    let om = (ofs + c) * w;
    if (om > OM_MAX) om = OM_MAX;
    else if (!(om >= 0)) om = 0;
    const sn = sin(om), cs = cos(om);
    const x = (q * om) / sn;
    const alpha = alphaBw ? sn * (0.5 * (exp(x) - exp(-x))) : sn * q;
    s.setup(alpha, cs);
  }
}
