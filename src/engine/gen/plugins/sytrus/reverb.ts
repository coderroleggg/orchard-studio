// Sytrus reverb: FL's TFruityReverb (Sytrus_x64 0x77cf0 parameters, 0x27b900
// allocation, 0x27be80 coefficients) driving BaseReverb::Process_Fruity_32FM_32FS
// of FL's libreverb (a Dattorro-style plate): input high cut / low cut,
// four input allpass diffusers, predelay, a two-half tank (damping, colour
// shelf, two decay diffusers and two delays per half, cross-fed) and seven
// output taps per channel with decay-dependent weights. Delay lengths are
// FL's table (in samples at 20 kHz) scaled by the sample rate and ROOM SIZE.
// docs/research/gen/sytrus.md "Reverb".

import type { SyReverb as SyReverbState } from '../../../../model/gen/plugins/sytrus/types';

const f32 = Math.fround;
/** Line lengths at 20 kHz: 4 input diffusers, tank A (diffuser, delay, diffuser, delay), tank B (same). */
const T1 = [142, 107, 379, 277, 672, 4453, 1800, 3720, 908, 4217, 2656, 3163];
const TAP_L = [266, 2974, 1913, 2496, 1690, 187, 1566];
const TAP_R = [353, 3627, 1728, 3173, 1811, 335, 621];
const LN_001 = -6.907755278982137;
const COLOR = [0.2, 0.6, 1, 1.5, 3];
const DC = f32(1e-30);

function mulDiv(a: number, b: number, c: number): number {
  return Math.trunc((a * b) / c);
}

export class SyReverb {
  private bufs: Float32Array[] = [];
  private len = new Int32Array(13);
  private idx = new Int32Array(13);
  private tapL = new Int32Array(7);
  private tapR = new Int32Array(7);
  private roomMemo = -1;
  private predelay = -1;
  private changed = true;
  // parameters (TFruityReverb fields)
  private lc = 75; private hc = 40; private pd = 0; private rs = 40; private df = 100; private deS = 0; private hd = 40; private col = 2;
  // coefficients
  private lcC = 0; private g = 0; private apA = 0; private apB = 0; private inC = 0; private hcC = 1; private dmp = 1; private colC = 0; private colG = 0;
  // states
  private lp = 0; private ap1 = 0; private ap1x = 0;
  private dA = 0; private dB = 0;
  private cAx = 0; private cAy = 0; private cBx = 0; private cBy = 0;

  constructor(private readonly sr: number, bs: number) {
    void bs;
  }

  /** TFruityReverb parameter update (0x77cf0). */
  set(rv: SyReverbState, tempo: number): void {
    const sr = this.sr;
    let d = sr * rv.pd;
    d = rv.tempo ? (d * 0.3125) / f32(tempo) : d / 384;
    const pd = roundEven(d);
    if (pd !== this.predelay) { this.predelay = pd; this.alloc(); }
    this.deS = f32((rv.de * sr) / 10);
    this.lc = rv.lc === 19 ? 0 : rv.lc;
    this.hc = rv.hc === 221 ? 0 : rv.hc;
    this.hd = rv.hd === 221 ? 0 : rv.hd;
    this.rs = rv.rs;
    this.df = rv.df;
    this.col = rv.col;
    this.changed = true;
  }

  tailSeconds(): number {
    return Math.min(30, this.deS / this.sr + this.predelay / this.sr + 0.2);
  }

  /** Allocation (0x27b900 / 0x27bb90 / 0x27b710): lines at their full length for this rate, cleared. */
  private alloc(): void {
    const sr = this.sr;
    this.bufs = [];
    for (let i = 0; i < 12; i++) {
      const n = Math.max(1, mulDiv(T1[i], sr, 20000));
      this.bufs.push(new Float32Array(n + 1));
      this.len[i] = n;
      this.idx[i] = 0;
    }
    this.len[12] = Math.max(1, this.predelay);
    this.idx[12] = 0;
    this.bufs.push(new Float32Array(this.len[12] + 1));
    for (let i = 0; i < 7; i++) { this.tapL[i] = mulDiv(TAP_L[i], sr, 20000); this.tapR[i] = mulDiv(TAP_R[i], sr, 20000); }
    this.lp = this.ap1 = this.ap1x = 0;
    this.dA = this.dB = 0;
    this.cAx = this.cAy = this.cBx = this.cBy = 0;
    this.roomMemo = -1;
    this.changed = true;
  }

  /** Coefficients (0x27be80). */
  private recompute(): void {
    const sr = this.sr;
    const s13 = f32(sr), inv = f32(1 / sr);
    if (this.lc !== 0) {
      let fc = f32(this.lc);
      if (!(fc < f32(s13 * 0.5))) fc = f32(s13 * 0.5);
      const t = f32(Math.tan(Math.PI * fc * inv));
      this.lcC = f32(f32(t - 1) / f32(t + 1));
    } else this.lcC = 0;
    this.hcC = this.cosCoef(this.hc, s13, inv);
    const scale = mulDiv(sr, this.rs + 15, 115);
    for (let i = 0; i < 12; i++) {
      let n = mulDiv(T1[i], scale, 20000);
      if (n < 1) n = 1;
      this.len[i] = Math.min(n, this.bufs[i].length - 1);
      this.idx[i] = this.idx[i] % this.len[i];
    }
    for (let i = 0; i < 7; i++) { this.tapL[i] = mulDiv(TAP_L[i], scale, 20000); this.tapR[i] = mulDiv(TAP_R[i], scale, 20000); }
    if (this.rs !== this.roomMemo) {
      this.roomMemo = this.rs;
      for (let i = 0; i < 12; i++) this.bufs[i].fill(0, 0, this.len[i]);
    }
    const s11 = f32(this.df * 0.01);
    const s2 = f32(0.5 * inv);
    const L = this.len;
    const s1 = f32((L[0] + L[1]) * s2);
    const s8 = f32((L[4] + L[8]) * s2), s9 = f32((L[6] + L[10]) * s2);
    if (s11 !== 0) {
      this.inC = f32(Math.exp((LN_001 * s1) / (s11 * 0.07)));
      this.apA = f32(Math.exp((LN_001 * s8) / (s11 * 0.35)));
      this.apB = f32(Math.exp((LN_001 * s9) / (s11 * 0.51)));
    } else { this.inC = 0; this.apA = 0; this.apB = 0; }
    const tank = f32(L[5] + L[7] + L[9] + L[11]);
    const de = this.deS;
    this.g = f32(Math.pow(Math.exp((LN_001 * tank) / de), 0.25));
    this.dmp = this.cosCoef(this.hd, s13, inv);
    const c = this.col >= 0 && this.col <= 4 ? COLOR[this.col] : 1;
    const s2c = f32(de * f32(c));
    let r = f32(f32(Math.pow(Math.exp((LN_001 * tank) / s2c), 0.25)) / this.g);
    this.colG = f32(f32(r - 1) * 0.5);
    if (r > 1) r = 1;
    const t = f32(Math.tan(Math.PI * 500 * inv));
    this.colC = f32(f32(t - r) / f32(t + r));
    this.changed = false;
  }

  /** One-pole coefficient from a frequency in 200 Hz units (high cut / damping). */
  private cosCoef(v: number, s13: number, inv: number): number {
    if (v === 0) return 1;
    let fc = f32(v);
    if (!(fc < f32(s13 * 0.5))) fc = f32(s13 * 0.5);
    const s12 = f32(2 - Math.cos(f32(200 * fc) * Math.PI * inv));
    return f32(1 - f32(s12 - f32(Math.sqrt(f32(f32(s12 * s12) - 1)))));
  }

  /** Process_Fruity_32FM_32FS: mono in, stereo out. */
  process(mono: Float32Array, outL: Float32Array, outR: Float32Array, n: number): void {
    if (!this.bufs.length) this.alloc();
    if (this.changed) this.recompute();
    const B = this.bufs, len = this.len, idx = this.idx;
    const g = this.g, inC = this.inC, apA = this.apA, apB = this.apB, hcC = this.hcC, lcC = this.lcC, dmp = this.dmp, colC = this.colC, colG = this.colG;
    const s6g = f32(1 - g);
    const k0 = f32(f32(s6g * f32(0.6)) + g), k1 = f32(f32(s6g * 0.25) + g), k2 = f32(f32(s6g * f32(0.7)) + g), k4 = f32(f32(s6g * 0.5) + g), k5 = f32(f32(s6g * f32(0.2)) + g);
    const b0 = B[0], b1 = B[1], b2 = B[2], b3 = B[3], b4 = B[4], b5 = B[5], b6 = B[6], b7 = B[7], b8 = B[8], b9 = B[9], b10 = B[10], b11 = B[11], b12 = B[12];
    let i0 = idx[0], i1 = idx[1], i2 = idx[2], i3 = idx[3], i4 = idx[4], i5 = idx[5], i6 = idx[6], i7 = idx[7], i8 = idx[8], i9 = idx[9], i10 = idx[10], i11 = idx[11], i12 = idx[12];
    const l5 = len[5], l6 = len[6], l7 = len[7], l9 = len[9], l10 = len[10], l11 = len[11];
    const tL = this.tapL, tR = this.tapR;
    let lp = this.lp, ap1 = this.ap1, ap1x = this.ap1x, dA = this.dA, dB = this.dB, cAx = this.cAx, cAy = this.cAy, cBx = this.cBx, cBy = this.cBy;
    const w = (k: number, l: number) => (k >= l ? k - l : k);
    for (let s = 0; s < n; s++) {
      // input: high cut (one pole), low cut (allpass-based high pass)
      let x = f32(mono[s] + DC);
      x = f32(f32(x - lp) * hcC + lp);
      const ap = f32(f32(x - ap1) * lcC + ap1x);
      lp = x; ap1 = ap; ap1x = x;
      let v = lcC !== 0 ? f32(f32(x - ap) * 0.5 + DC) : x;
      // four input diffusers
      let y = f32(b0[i0] - inC * v); b0[i0] = f32(y * inC + v); if (i0 <= 0) i0 = len[0];
      v = f32(b1[i1] - inC * y); b1[i1] = f32(v * inC + y); if (i1 <= 0) i1 = len[1];
      y = f32(b2[i2] - inC * v); b2[i2] = f32(y * inC + v); if (i2 <= 0) i2 = len[2];
      v = f32(b3[i3] - inC * y); b3[i3] = f32(v * inC + y); if (i3 <= 0) i3 = len[3];
      // predelay
      const pin = b12[i12]; b12[i12] = v; if (i12 <= 0) i12 = len[12];
      // tank half A (fed by line 11)
      let a = f32(g * b11[i11]);
      let cy = f32(f32(a - cAy) * colC + cAx);
      cAx = a; cAy = cy;
      a = f32(colG * f32(cy + a) + f32(a + pin));
      a = f32(f32(a - dA) * dmp + dA);
      dA = a;
      let u = f32(b4[i4] - apA * a); b4[i4] = f32(u * apA + a); if (i4 <= 0) i4 = len[4];
      let d = b5[i5]; b5[i5] = u; if (i5 <= 0) i5 = l5;
      let gd = f32(g * d);
      u = f32(b6[i6] - apB * gd); b6[i6] = f32(u * apB + gd); if (i6 <= 0) i6 = l6;
      b7[i7] = u; if (i7 <= 0) i7 = l7;
      i7--;
      // tank half B (fed by line 7)
      a = f32(g * b7[i7]);
      cy = f32(f32(a - cBy) * colC + cBx);
      cBx = a; cBy = cy;
      a = f32(colG * f32(cy + a) + f32(a + pin));
      a = f32(f32(a - dB) * dmp + dB);
      dB = a;
      u = f32(b8[i8] - apA * a); b8[i8] = f32(u * apA + a); if (i8 <= 0) i8 = len[8];
      d = b9[i9]; b9[i9] = u; if (i9 <= 0) i9 = l9;
      gd = f32(g * d);
      u = f32(b10[i10] - apB * gd); b10[i10] = f32(u * apB + gd); if (i10 <= 0) i10 = l10;
      i5--; i6--; i9--; i10--;
      b11[i11] = u; if (i11 <= 0) i11 = l11;
      i11--;
      // output taps
      const L0 = b9[w(tL[0] + i9, l9)], L1 = b9[w(tL[1] + i9, l9)], L2 = b10[w(tL[2] + i10, l10)], L3 = b11[w(tL[3] + i11, l11)];
      const L4 = b5[w(tL[4] + i5, l5)], L5 = b6[w(tL[5] + i6, l6)], L6 = b7[w(tL[6] + i7, l7)];
      const R0 = b5[w(tR[0] + i5, l5)], R1 = b5[w(tR[1] + i5, l5)], R2 = b6[w(tR[2] + i6, l6)], R3 = b7[w(tR[3] + i7, l7)];
      const R4 = b9[w(tR[4] + i9, l9)], R5 = b10[w(tR[5] + i10, l10)], R6 = b11[w(tR[6] + i11, l11)];
      let sl = f32(L1 * k1); sl = f32(L2 * k2 + sl); sl = f32(L3 * k5 + sl);
      let ol = f32(L4 * k0 + L0);
      ol = f32(ol - sl); ol = f32(ol + L5); ol = f32(L6 * k4 + ol);
      i0--; i1--; i2--; i3--; i12--; i4--; i8--;
      sl = f32(R2 * k2); sl = f32(R3 * k5 + sl); sl = f32(R4 * k0 + sl);
      let or = f32(R1 * k1 + R0);
      or = f32(or + R5); or = f32(R6 * k4 + or);
      or = f32(or - sl);
      outL[s] = ol; outR[s] = or;
    }
    idx[0] = i0; idx[1] = i1; idx[2] = i2; idx[3] = i3; idx[4] = i4; idx[5] = i5; idx[6] = i6; idx[7] = i7; idx[8] = i8; idx[9] = i9; idx[10] = i10; idx[11] = i11; idx[12] = i12;
    this.lp = lp; this.ap1 = ap1; this.ap1x = ap1x; this.dA = dA; this.dB = dB; this.cAx = cAx; this.cAy = cAy; this.cBx = cBx; this.cBy = cBy;
  }
}

function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
