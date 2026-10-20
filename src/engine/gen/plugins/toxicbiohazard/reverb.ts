// Toxic Biohazard's reverb: FL's "fxReverb" (Ultrafunk's plate, the version
// built into Toxic Biohazard), ported from FL 2026's binary. Same topology as
// the Transistor Bass / Sawer engines' fxReverb (../transistorbass/reverb.ts):
// mono input -> one-pole high cut -> allpass low cut -> four diffusers ->
// early-reflection line (one tap per side) -> predelay -> Dattorro's
// figure-eight tank (stage gains, bass shelf, damping, allpasses) -> 7 + 7
// output taps -> wet (slewed) + ER, M/S width, dry. This build differs:
// 18 parameters (no predelay feedback), fused multiply-adds throughout,
// float libm coefficient laws (tanf / cosf / expf / exp10f), wet x 0.3,
// partial buffer clears.
// Parameters (normalized 0..1 -> FL's integers): 0 input (tenths of dB),
// 1 low cut (Hz), 2 high cut, 3 predelay (ms), 4 room, 5 diffusion (%),
// 6 bass, 7 crossover (Hz), 8 decay (tenths of s), 9 damping, 10 dry,
// 11 ER, 12 wet (tenths of dB), 13 width (%), 14..17 mutes.

import { f32 } from '../poizone/dsp';
import { exp10f, cosf, tanf, expf } from '../poizone/applemath';

const BASE = [142, 107, 379, 277, 672, 4453, 1800, 3720, 908, 4217, 2656, 3163];
const TAP_A = [266, 2974, 1913, 2496, 1690, 187, 1566];
const TAP_B = [353, 3627, 1728, 3173, 1811, 335, 621];
const ER_L = [1102, 2904, 3784, 4873, 5878, 7470, 9062, 9263];
const ER_R = [837, 1423, 2865, 3938, 5278, 5978, 7532, 9263];
const DEFAULTS = [0.8574821949005127, 0.018785642459988594, 0.16203702986240387, 0, 0.49494948983192444, 1,
  0.2857142984867096, 0.2405063360929489, 0.07035175710916519, 0.16203702986240387, 0.8574821949005127,
  0.7743467688560486, 0.5724465847015381, 0.5, 0, 0, 0, 0];
const PI_F = f32(Math.PI);
const D30 = f32(1.0000000031710769e-30);
const D20 = f32(9.999999682655225e-21);

/** f32 fused multiply-add a * b + c. */
const fma = (a: number, b: number, c: number): number => f32(a * b + c);
/** f32 fused c - a * b. */
const fms = (a: number, b: number, c: number): number => f32(c - a * b);


export class TxReverb {
  sr = 44100;
  readonly ip = new Int32Array(18);
  readonly cap = new Int32Array(12);
  readonly len = new Int32Array(12);
  readonly idx = new Int32Array(12);
  buf: Float32Array[] = [];
  pd = new Float32Array(1);
  er = new Float32Array(2);
  pdLen = 1;
  pdIdx = 0;
  erSize = 2;
  erIdx = 0;
  readonly tapA = new Int32Array(7);
  readonly tapB = new Int32Array(7);
  readonly erTL = new Int32Array(8);
  readonly erTR = new Int32Array(8);
  gL0 = 0; gR0 = 0;
  roomCache = 0;
  dirty = true;
  // coefficients
  inGain = 0; lc = 0; hc = 1; g1 = 0; g2 = 0; gAp1 = 0; gAp2 = 0; gStage = 0; shelfK = 0; shelfC = 0;
  damp = 1; dry = 0; erG = 0; wet = 0; wetCur = f32(-1000);
  // states
  hcY = 0; lcY = 0; lcX = 0; dampL = 0; dampR = 0; shL1 = 0; shL2 = 0; shR1 = 0; shR2 = 0;

  constructor() {
    this.alloc(44100);
    for (let i = 0; i < 18; i++) this.setParam(i, DEFAULTS[i]);
  }

  /** FL's normalized parameter -> integer. */
  setParam(i: number, v: number): void {
    v = f32(v);
    const fl = (k: number, o: number): number => Math.floor(f32(v * k + o));
    switch (i) {
      case 0: case 10: case 11: case 12: this.ip[i] = fl(421, -360.5); break;
      case 1: this.ip[1] = fl(2981, 19.5); break;
      case 2: case 9: this.ip[i] = fl(216, 5.5); break;
      case 3: this.ip[3] = fl(250, 0.5); break;
      case 4: this.ip[4] = fl(99, 1.5); break;
      case 5: this.ip[5] = fl(100, 0.5); break;
      case 6: this.ip[6] = fl(28, 2.5); break;
      case 7: this.ip[7] = fl(1975, 25.5); break;
      case 8: this.ip[8] = fl(199, 1.5); break;
      case 13: this.ip[13] = fl(200, 0.5); break;
      default: if (i >= 14 && i <= 17) this.ip[i] = Math.floor(f32(v + 0.5)); else return;
    }
    this.dirty = true;
  }

  private alloc(sr: number): void {
    const s = Math.trunc(sr);
    for (let k = 0; k < 12; k++) {
      const n = Math.trunc((BASE[k] * s) / 20000);
      this.cap[k] = n;
      this.len[k] = n;
      this.idx[k] = 0;
    }
    this.buf = Array.from(this.cap, (n) => new Float32Array(Math.max(n, 1)));
    this.pdLen = Math.trunc(s / 4);
    this.pdIdx = 0;
    this.pd = new Float32Array(Math.max(this.pdLen, 1));
    let w = Math.trunc(s * 0.3163265306122449), bits = 0;
    while (w >= 1) { w >>>= 1; bits++; }
    this.erSize = 2 << bits;
    this.er = new Float32Array(this.erSize);
    for (let i = 0; i < 7; i++) {
      this.tapA[i] = Math.trunc((TAP_A[i] * s) / 20000);
      this.tapB[i] = Math.trunc((TAP_B[i] * s) / 20000);
    }
  }

  setSampleRate(sr: number): void {
    this.sr = f32(sr);
    this.alloc(this.sr);
  }

  reset(): void {
    this.wetCur = f32(-1000);
    for (const b of this.buf) b.fill(D30);
    this.pd.fill(D30);
    this.er.fill(D30);
    this.hcY = 0; this.lcY = 0; this.lcX = 0;
    this.dampL = 0; this.dampR = 0;
    this.shL1 = 0; this.shL2 = 0; this.shR1 = 0; this.shR2 = 0;
  }

  private dbGain(v: number): number { return v >= -360 ? exp10f(f32(v * f32(0.005))) : 0; }

  private onePole(v: number, sr: number): number {
    if (v > 220) return 1;
    const c = cosf(f32(f32(v * f32(628.3185424804688)) / sr));
    const b = f32(2 - c);
    return f32(f32(c + -1) + f32(Math.sqrt(fma(b, b, -1))));
  }

  /** FL's coefficient update (0x42a60). */
  private update(): void {
    const ip = this.ip, sr = this.sr;
    this.inGain = ip[14] ? 0 : this.dbGain(ip[0]);
    if (ip[1] >= 20) {
      const fc = Math.min(f32(sr * 0.5), ip[1]);
      const t = tanf(f32(f32(fc * PI_F) / sr));
      this.lc = f32(f32(t + -1) / f32(t + 1));
    } else this.lc = 0;
    this.hc = this.onePole(ip[2], sr);
    const s = Math.trunc(sr);
    const x10 = Math.trunc(((ip[4] + 15) * s) / 115);
    const L = this.len;
    for (let k = 0; k < 12; k++) {
      const p = BASE[k] * x10;
      L[k] = p < 20000 ? 1 : Math.trunc(p / 20000);
      this.idx[k] %= L[k];
    }
    let pd = Math.trunc((ip[3] * s) / 1000);
    if (pd < 1) pd = 1;
    this.pdLen = pd;
    this.pdIdx %= pd;
    for (let i = 0; i < 7; i++) {
      this.tapA[i] = Math.trunc((TAP_A[i] * x10) / 20000);
      this.tapB[i] = Math.trunc((TAP_B[i] * x10) / 20000);
    }
    const x9 = Math.trunc(((ip[4] + 3) * s) / 103);
    const sc = f32(x9 * f32(3.4013602999038994e-05));
    for (let i = 0; i < 8; i++) {
      this.erTL[i] = Math.trunc(f32(ER_L[i] * sc));
      this.erTR[i] = Math.trunc(f32(ER_R[i] * sc));
    }
    const tl = this.erTL[0], tr = this.erTR[0];
    const ref = Math.min(tl, tr);
    this.gL0 = f32(f32(ref * 0.5) / tl);
    this.gR0 = f32(f32(ref * f32(0.36000001430511475)) / tr);
    if (ip[4] !== this.roomCache) {
      this.roomCache = ip[4];
      for (let k = 0; k < 12; k++) this.buf[k].fill(0, 0, L[k]);
      this.er.fill(0);
    }
    const D = f32(ip[5] * f32(0.01));
    if (D !== 0) {
      const K = f32(-3.4538776874542236);
      const sd = f32(sr * ip[5]);
      this.g1 = expf(f32(f32(f32(L[1] + L[0]) * K) / f32(sd * f32(0.000699999975040555))));
      this.g2 = expf(f32(f32(f32(L[3] + L[2]) * K) / f32(sd * f32(0.0010999999940395355))));
      this.gAp1 = expf(f32(f32(f32(L[8] + L[4]) * K) / f32(sd * f32(0.003499999875202775))));
      this.gAp2 = expf(f32(f32(f32(L[10] + L[6]) * K) / f32(sd * f32(0.0050999997183680534))));
    } else { this.g1 = 0; this.g2 = 0; this.gAp1 = 0; this.gAp2 = 0; }
    const loop = f32(L[5] + L[7] + L[9] + L[11]);
    const dec = f32(ip[8]);
    const e10 = f32(f32(loop * f32(-6.907755374908447)) / sr);
    let g = expf(f32(e10 / f32(dec * f32(0.1))));
    g = f32(Math.sqrt(f32(Math.sqrt(g))));
    this.gStage = g;
    let gb = expf(f32(e10 / f32(f32(dec * f32(0.010000000707805157)) * ip[6])));
    gb = f32(Math.sqrt(f32(Math.sqrt(gb))));
    const ratio = f32(gb / g);
    this.shelfK = fma(ratio, 0.5, -0.5);
    const r1 = Math.min(ratio, 1);
    const tc = tanf(f32(f32(ip[7] * PI_F) / sr));
    this.shelfC = f32(f32(tc - r1) / f32(r1 + tc));
    this.damp = this.onePole(ip[9], sr);
    this.dry = ip[15] ? 0 : this.dbGain(ip[10]);
    this.erG = ip[16] ? 0 : (ip[11] >= -360 ? f32(exp10f(f32(ip[11] * f32(0.005))) * 0.5) : 0);
    this.wet = ip[17] ? 0 : (ip[12] >= -360 ? f32(exp10f(f32(ip[12] * f32(0.005))) * f32(0.30000001192092896)) : 0);
    this.dirty = false;
  }

  /** Process n frames in place (FL 0x44070). */
  process(Lb: Float32Array, Rb: Float32Array, n: number): void {
    if (this.dirty) this.update();
    const B = this.buf, L = this.len, I = this.idx, er = this.er, pd = this.pd;
    const g = this.gStage;
    const c06 = f32(fms(g, f32(0.6000000238418579), f32(0.6000000238418579)) + g);
    const c025 = f32(fms(g, 0.25, 0.25) + g);
    const c07 = f32(fms(g, f32(0.699999988079071), f32(0.699999988079071)) + g);
    const c05 = f32(fms(g, 0.5, 0.5) + g);
    const c02 = f32(fms(g, f32(0.20000000298023224), f32(0.20000000298023224)) + g);
    const width = f32(this.ip[13] * f32(0.009999999776482582));
    const mask = this.erSize - 1;
    let erL = 0, erR = 0;
    const tap = (b: Float32Array, len: number, off: number, base: number): number => {
      let q = off + base;
      if (q >= len) q -= len;
      return b[q];
    };
    for (let i = 0; i < n; i++) {
      const xL = f32(this.inGain * Lb[i]);
      const xR = f32(Rb[i] * this.inGain);
      let x = fma(f32(xR + xL), 0.5, D30);
      x = fma(f32(x - this.hcY), this.hc, this.hcY);
      this.hcY = x;
      const ap = fma(f32(x - this.lcY), this.lc, this.lcX);
      this.lcY = ap;
      this.lcX = x;
      const xl = fma(f32(x - ap), 0.5, D30);
      if (this.lc !== 0) x = xl;
      const p = this.erIdx;
      if (this.erG !== 0) {
        erL = f32(this.gL0 * er[(this.erTL[0] + p) & mask]);
        erR = f32(this.gR0 * er[(this.erTR[0] + p) & mask]);
      }
      // diffusers
      let b = B[0], j = I[0];
      let v = fms(this.g1, x, b[j]);
      b[j] = fma(v, this.g1, x);
      if (j <= 0) I[0] = L[0];
      b = B[1]; j = I[1];
      let u = fms(this.g2, v, b[j]);
      b[j] = fma(u, this.g1, v);
      if (j <= 0) I[1] = L[1];
      er[p] = v;
      const erNext = p < 1 ? this.erSize : p;
      b = B[2]; j = I[2];
      v = fms(this.g1, u, b[j]);
      b[j] = fma(v, this.g1, u);
      if (j <= 0) I[2] = L[2];
      b = B[3]; j = I[3];
      u = fms(this.g2, v, b[j]);
      b[j] = fma(u, this.g1, v);
      if (j <= 0) I[3] = L[3];
      // predelay
      j = this.pdIdx;
      const pdo = pd[j];
      pd[j] = u;
      if (j <= 0) this.pdIdx = this.pdLen;
      const tin = f32(pdo + D20);
      // left half
      let s = f32(B[11][I[11]] * g);
      let t = fma(f32(s - this.shL2), this.shelfC, this.shL1);
      this.shL2 = t; this.shL1 = s;
      s = fma(this.shelfK, f32(t + s), f32(s + tin));
      s = fma(f32(s - this.dampL), this.damp, this.dampL);
      this.dampL = s;
      b = B[4]; j = I[4];
      v = fms(this.gAp1, s, b[j]);
      b[j] = fma(v, this.gAp1, s);
      if (j <= 0) I[4] = L[4];
      b = B[5]; j = I[5];
      let d = b[j];
      b[j] = v;
      if (j <= 0) I[5] = L[5];
      d = f32(g * d);
      b = B[6]; j = I[6];
      v = fms(this.gAp2, d, b[j]);
      b[j] = fma(v, this.gAp2, d);
      if (j <= 0) I[6] = L[6];
      b = B[7]; j = I[7];
      b[j] = v;
      if (j <= 0) I[7] = L[7];
      s = f32(b[I[7] - 1] * g);
      // right half
      t = fma(f32(s - this.shR2), this.shelfC, this.shR1);
      this.shR2 = t; this.shR1 = s;
      s = fma(this.shelfK, f32(t + s), f32(s + tin));
      s = fma(f32(s - this.dampR), this.damp, this.dampR);
      this.dampR = s;
      b = B[8]; j = I[8];
      v = fms(this.gAp1, s, b[j]);
      b[j] = fma(v, this.gAp1, s);
      if (j <= 0) I[8] = L[8];
      b = B[9]; j = I[9];
      d = b[j];
      b[j] = v;
      if (j <= 0) I[9] = L[9];
      d = f32(g * d);
      b = B[10]; j = I[10];
      v = fms(this.gAp2, d, b[j]);
      b[j] = fma(v, this.gAp2, d);
      if (j <= 0) I[10] = L[10];
      I[5]--; I[6]--; I[7]--; I[9]--; I[10]--;
      b = B[11]; j = I[11];
      b[j] = v;
      if (j <= 0) I[11] = L[11];
      I[11]--;
      // output taps
      const a0 = tap(B[9], L[9], this.tapA[0], I[9]), a1 = tap(B[9], L[9], this.tapA[1], I[9]);
      const a2 = tap(B[10], L[10], this.tapA[2], I[10]), a3 = tap(B[11], L[11], this.tapA[3], I[11]);
      const a4 = tap(B[5], L[5], this.tapA[4], I[5]), a5 = tap(B[6], L[6], this.tapA[5], I[6]);
      const a6 = tap(B[7], L[7], this.tapA[6], I[7]);
      const b0 = tap(B[5], L[5], this.tapB[0], I[5]), b1 = tap(B[5], L[5], this.tapB[1], I[5]);
      const b2 = tap(B[6], L[6], this.tapB[2], I[6]), b3 = tap(B[7], L[7], this.tapB[3], I[7]);
      const b4 = tap(B[9], L[9], this.tapB[4], I[9]), b5 = tap(B[10], L[10], this.tapB[5], I[10]);
      const b6 = tap(B[11], L[11], this.tapB[6], I[11]);
      let q = f32(a1 * c025);
      q = fma(a2, c07, q);
      q = fma(a3, c02, q);
      let oL = fma(a4, c06, a0);
      oL = f32(oL - q);
      oL = f32(oL + a5);
      oL = fma(a6, c05, oL);
      q = f32(b2 * c07);
      q = fma(b3, c02, q);
      q = fma(b4, c06, q);
      let oR = fma(b1, c025, b0);
      oR = f32(oR + b5);
      oR = fma(b6, c05, oR);
      oR = f32(oR - q);
      let wc = this.wetCur;
      if (wc < -99) wc = this.wet;
      wc = fma(f32(this.wet - wc), f32(0.0010000000474974513), wc);
      this.wetCur = wc;
      const lo = fma(wc, oL, f32(this.erG * erL));
      const ro = fma(wc, oR, f32(this.erG * erR));
      const M = f32(lo + ro), S = f32(lo - ro);
      const Sw = f32(width * S);
      Lb[i] = f32(fma(this.dry, xL, M) + Sw);
      Rb[i] = fma(this.dry, xR, f32(M - Sw));
      // index steps
      I[0]--; I[1]--; this.erIdx = erNext - 1; I[2]--; I[3]--; this.pdIdx--; I[4]--; I[8]--;
    }
  }
}
