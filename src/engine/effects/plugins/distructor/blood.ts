// Blood Overdrive DSP core (FL: Fruity Blood Overdrive), shared with
// Distructor's Blood overdrive model. A line-by-line port of FL's plugin code
// (arm64: Eff_Render 0x5d7f0, parameter update 0x5dc70, shaper lookup
// 0x5dda0, table built in the constructor; see
// docs/research/fx/bloodoverdrive.md), in FL's single precision with FL's
// operation order (every step rounded to float32, no fused multiply-add), so
// the output is FL's bit for bit:
//
//   x -> SVF1 (Chamberlin, damping 1, f = color^3)       "pre band"
//     -> in2 = gain * ((high1 + low1) * (1 - preBand) + band1)
//     -> SVF2 (Chamberlin, damping 1, f = 0.25)            3-band split
//     -> each band through FL's 65536-entry sine table, summed
//     -> * postGain^2 -> clip +-0.99995
//     -> two one-pole low-passes, a = 0.2 + 0.7 * postFilter (switches at once, as in FL)
//
// gain = 1 + 25 * preAmp^3 (x 2500 with x100). gain, 1 - preBand,
// postGain^2 and color^3 follow FL's one-pole smoothing (0.99975 per frame).
// The SVF states are flushed below 2^-24 at the start of every block (FL).
// The filter coefficients are per-sample constants, so the voicing follows
// the sample rate exactly like FL's plugin (and Distructor's oversampling).
//
// Table: T[32768 + i] = f32(sin(i pi / 65536)), T[32767 - i] = -T[32768 + i]
// (i = 0..32767); lookup T[trunc(f32(u * 32767)) + 32768] with FL's integer
// wrap and clamp to 0..65535 (so |u| >= 1 reads +-sin(32767 pi / 65536), and
// u >= 65537 wraps to entry 0, about -1, exactly as FL does).
//
// Departures, each keeping the output finite: NaN / Inf input samples are
// replaced by 0; non-finite filter states are cleared.

const f32 = Math.fround;
const SM = f32(0.99975);
const SMI = f32(0.00025);
const CLIP = f32(0.99995);
const A07 = f32(0.7);
const A02 = f32(0.2);
/** FL flushes the SVF states below 2^-24 once per block. */
const TINY = 5.960464477539063e-8;

/** FL's shaper table (65536 single-precision entries). */
const TABLE = (() => {
  const t = new Float32Array(65536);
  for (let i = 0; i <= 32767; i++) {
    const v = f32(Math.sin(i * Math.PI * (1 / 65536)));
    t[32767 - i] = -v;
    t[32768 + i] = v;
  }
  return t;
})();

/** FL's overdrive curve: the table lookup of a single-precision input (exact, including the integer wrap). */
export function bloodShape(u: number): number {
  const s = f32(u * 32767);
  let w: number;
  if (s > -2147450880 && s < 2147450880) w = Math.trunc(s) + 32768;
  else if (s !== s) w = 32768; // NaN converts to 0
  else if (s >= 9223372036854775807) w = 32767; // int64 saturation, then + 32768 wraps
  else if (s <= -9223372036854775808) w = 32768;
  else w = ((Math.trunc(s) % 4294967296) + 32768) | 0; // low 32 bits, signed
  return TABLE[w < 0 ? 0 : w > 65535 ? 65535 : w];
}

export interface BloodParams {
  /** FL's raw control values: 0..10000 (x100: 0 / 1). */
  preBand: number;
  color: number;
  preAmp: number;
  x100: number;
  postFilter: number;
  postGain: number;
}

/** FL's control value -> the plugin's single-precision 0..1 value. */
function unit(v: number, range: number): number {
  const u = v / range;
  return f32(u > 0 ? (u < 1 ? u : 1) : 0);
}

export class BloodCore {
  /** Smoothing iterations run after a state load (see the constructor). */
  private readonly settle: number;
  // targets, pre-multiplied by (1 - 0.99975) as FL stores them
  private gS = 0;
  private nbS = 0;
  private pgS = 0;
  private fS = 0;
  // post filter (FL: not smoothed)
  private a = A02;
  private b = f32(1 - A02);
  // smoothed values
  private gain = 1;
  private nb = 1;
  private pg = 1;
  private f = 0;
  private gT = 1;
  private nbT = 1;
  private pgT = 1;
  private fT = 0;
  private first = true;
  // per channel: low1, band1, low2, band2, lp1, lp2
  private st = new Float32Array(12);

  /**
   * settle: smoothing iterations run when a state is loaded. The standalone
   * plugin's SaveRestoreState runs its sample rate's worth (so a loaded state
   * is practically settled at once); Distructor's module runs none (its Blood
   * glides from the constructor values after loading, measured).
   */
  constructor(settle = 0) {
    this.settle = Math.max(0, Math.round(settle));
  }

  /** FL's parameter update (runs on every parameter change). */
  set(p: BloodParams): void {
    const pb = unit(p.preBand, 10000), c = unit(p.color, 10000), pre = unit(p.preAmp, 10000);
    const x100 = unit(p.x100, 1), pf = unit(p.postFilter, 10000), g = unit(p.postGain, 10000);
    const p3 = f32(f32(pre * pre) * pre);
    const c3 = f32(f32(c * c) * c);
    const k = x100 > 0.5 ? 2500 : 25;
    this.gT = f32(f32(k * p3) + 1);
    this.nbT = f32(1 - pb);
    this.pgT = f32(g * g);
    this.fT = c3;
    this.gS = f32(this.gT * SMI);
    this.nbS = f32(this.nbT * SMI);
    this.pgS = f32(this.pgT * SMI);
    this.fS = f32(c3 * SMI);
    this.a = f32(f32(pf * A07) + A02);
    this.b = f32(1 - this.a);
    // the first state is a state load
    if (this.first) { this.first = false; this.restart(); }
  }

  /**
   * A new FL processor with the current parameters loaded: cleared filters,
   * the smoothers at FL's constructor values (1, 1, 1, 0), then `settle`
   * iterations of the smoothing recursion.
   */
  restart(): void {
    this.st.fill(0);
    const gS = this.gS, nbS = this.nbS, pgS = this.pgS, fS = this.fS;
    let gain = 1, nb = 1, pg = 1, f = 0;
    for (let i = 0; i < this.settle; i++) {
      gain = f32(f32(gain * SM) + gS);
      nb = f32(f32(nb * SM) + nbS);
      pg = f32(f32(pg * SM) + pgS);
      f = f32(f32(f * SM) + fS);
    }
    this.gain = gain; this.nb = nb; this.pg = pg; this.f = f;
  }

  /** Clear the filters (the smoothers keep their values, as in FL). */
  reset(): void {
    this.st.fill(0);
  }

  /** In-place stereo processing (FL's Eff_Render). */
  process(L: Float32Array, R: Float32Array, n: number): void {
    const st = this.st;
    // FL: flush the SVF states once per block (the post filter states are not flushed)
    for (let i = 0; i < 12; i++) {
      if (i % 6 >= 4) continue;
      const v = st[i];
      if (v < TINY && v > -TINY) st[i] = 0;
    }
    let l1L = st[0], b1L = st[1], l2L = st[2], b2L = st[3], p1L = st[4], p2L = st[5];
    let l1R = st[6], b1R = st[7], l2R = st[8], b2R = st[9], p1R = st[10], p2R = st[11];
    if (!Number.isFinite(l1L + b1L + l2L + b2L + p1L + p2L + l1R + b1R + l2R + b2R + p1R + p2R)) {
      l1L = b1L = l2L = b2L = p1L = p2L = l1R = b1R = l2R = b2R = p1R = p2R = 0;
    }
    const gS = this.gS, nbS = this.nbS, pgS = this.pgS, fS = this.fS, a = this.a, b = this.b;
    let gain = this.gain, nb = this.nb, pg = this.pg, f = this.f;
    for (let i = 0; i < n; i++) {
      gain = f32(f32(gain * SM) + gS);
      nb = f32(f32(nb * SM) + nbS);
      pg = f32(f32(pg * SM) + pgS);
      f = f32(f32(f * SM) + fS);
      // left
      let x = L[i];
      if (x - x !== 0) x = 0; // NaN / Inf
      l1L = f32(l1L + f32(f * b1L));
      let h1 = f32(f32(x - l1L) - b1L);
      b1L = f32(b1L + f32(f * h1));
      l2L = f32(l2L + f32(b2L * 0.25));
      let in2 = f32(f32(f32(f32(h1 + l1L) * nb) + b1L) * gain);
      let h2 = f32(f32(in2 - l2L) - b2L);
      b2L = f32(b2L + f32(h2 * 0.25));
      let y = f32(f32(f32(bloodShape(l2L) + bloodShape(b2L)) + bloodShape(h2)) * pg);
      if (y > CLIP) y = CLIP;
      if (y < -CLIP) y = -CLIP;
      p1L = f32(f32(y * b) + f32(p1L * a));
      p2L = f32(f32(p1L * b) + f32(p2L * a));
      L[i] = p2L;
      // right
      x = R[i];
      if (x - x !== 0) x = 0;
      l1R = f32(l1R + f32(f * b1R));
      h1 = f32(f32(x - l1R) - b1R);
      b1R = f32(b1R + f32(f * h1));
      l2R = f32(l2R + f32(b2R * 0.25));
      in2 = f32(f32(f32(f32(h1 + l1R) * nb) + b1R) * gain);
      h2 = f32(f32(in2 - l2R) - b2R);
      b2R = f32(b2R + f32(h2 * 0.25));
      y = f32(f32(f32(bloodShape(l2R) + bloodShape(b2R)) + bloodShape(h2)) * pg);
      if (y > CLIP) y = CLIP;
      if (y < -CLIP) y = -CLIP;
      p1R = f32(f32(y * b) + f32(p1R * a));
      p2R = f32(f32(p1R * b) + f32(p2R * a));
      R[i] = p2R;
    }
    st[0] = l1L; st[1] = b1L; st[2] = l2L; st[3] = b2L; st[4] = p1L; st[5] = p2L;
    st[6] = l1R; st[7] = b1R; st[8] = l2R; st[9] = b2R; st[10] = p1R; st[11] = p2R;
    this.gain = gain; this.nb = nb; this.pg = pg; this.f = f;
  }
}
