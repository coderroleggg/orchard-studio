// FL's "fxReverb" (Ultrafunk's plate, the C++ version inside the Transistor
// Bass, Sawer and Kepler Exo engines; this is the Transistor Bass port, which Kepler Exo's
// reverb matches: the same integer parameter laws and the same ctor state), decoded from FL 2026's binary and transcribed with
// its integer parameters, buffer layout, decrementing write indices,
// coefficient laws and float arithmetic:
// mono input -> one-pole high cut -> allpass-based low cut -> four input
// diffusers (FL's mixed coefficients) -> early-reflection line (one tap per
// side: FL's code zeroes the other seven gains) -> predelay with feedback ->
// Dattorro's figure-eight tank (stage gains, damping, bass shelf, allpasses)
// -> 7 + 7 output taps with stage-blended gains -> wet (slewed) + ER, M/S
// width, dry. Parameters (FL's ids): 0 input dB, 1 low cut, 2 high cut,
// 3 predelay (ms), 4 predelay feedback, 5 room, 6 diffusion, 7 bass (x 10),
// 8 crossover, 9 decay (tenths of s), 10 damping, 11 dry, 12 ER, 13 wet (tenths
// of dB), 14 width (%), 15..18 mutes (input, dry, ER, wet).

import { f32, fma32, fms32 } from './fmath';
import { cosf, exp10f, expf, powf, tanf } from './applemath';
const BASE = [142, 107, 379, 277, 672, 4453, 1800, 3720, 908, 4217, 2656, 3163];
const TAP_A = [266, 2974, 1913, 2496, 1690, 187, 1566];
const TAP_B = [353, 3627, 1728, 3173, 1811, 335, 621];
const ER_L = [1102, 2904, 3784, 4873, 5878, 7470, 9062, 9263];
const ER_R = [837, 1423, 2865, 3938, 5278, 5978, 7532, 9263];
const DENORM = f32(1.0000000031710769e-30);
const DENORM20 = f32(9.999999682655225e-21);

/** FL's parameter -> integer conversion (round half up). */
function rnd(x: number): number { return Math.floor(f32(f32(x) + 0.5)); }

export class FxReverb {
  sr: number;
  /** Integer parameters (FL's ids 0..18, index 4 unused: predelay feedback is a float). */
  readonly ip = new Int32Array(19);
  pdFb = 0;
  dirty = true;
  private roomCache = -999999;
  // buffers
  private readonly mem: Float32Array;
  private readonly off = new Int32Array(14);
  private readonly cap = new Int32Array(14);
  private readonly len = new Int32Array(12);
  private readonly idx = new Int32Array(14);
  private pdLen = 1;
  private readonly erSize: number;
  private readonly tapA = new Int32Array(7);
  private readonly tapB = new Int32Array(7);
  private readonly erTapL = new Int32Array(8);
  private readonly erTapR = new Int32Array(8);
  private readonly erGL = new Float32Array(8);
  private readonly erGR = new Float32Array(8);
  // coefficients
  inGain = 1; dry = 1; er = 0; wet = 0; wetCur = f32(-1000);
  lc = 0; hc = 1; damp = 1;
  g1 = 0; g2 = 0; gAp1 = 0; gAp2 = 0; gStage = 0;
  shelfK = 0; shelfC = 0;
  // states
  hcY = 0; lcY = 0; lcX = 0; dampL = 0; dampR = 0;
  shL1 = 0; shL2 = 0; shR1 = 0; shR2 = 0;
  erL = 0; erR = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    const s = Math.trunc(sampleRate);
    let total = 0;
    for (let k = 0; k < 12; k++) {
      const n = Math.trunc((BASE[k] * s) / 20000);
      this.cap[k] = n;
      this.off[k] = total;
      total += n;
    }
    const pdMax = s >> 2;
    this.cap[12] = Math.max(1, pdMax);
    this.off[12] = total;
    total += this.cap[12];
    let w = Math.trunc((s * 13950) / 44100);
    let bits = 0;
    while (w >= 1) { w >>>= 1; bits++; }
    this.erSize = 2 << bits;
    this.cap[13] = this.erSize;
    this.off[13] = total;
    total += this.erSize;
    this.mem = new Float32Array(total);
    // FL's default preset ("[1] Default Reverb")
    const defs = [0.8574821949005127, 0.018785642459988594, 0.16203702986240387, 0.0, 0, 0.49494948983192444, 1.0,
      0.2857142984867096, 0.2405063360929489, 0.07035175710916519, 0.16203702986240387, 0.8574821949005127,
      0.7743467688560486, 0.5724465847015381, 0.5, 0, 0, 0, 0];
    for (let i = 0; i < 19; i++) if (i !== 4) this.setParam(i, defs[i]);
    this.reset();
  }

  /** FL's setParam(id, value 0..1). */
  setParam(id: number, v: number): void {
    v = f32(v);
    const ip = this.ip;
    switch (id) {
      case 0: case 11: case 12: case 13: ip[id] = rnd(f32(v * 421) + -361); break;
      case 1: ip[1] = rnd(f32(v * 2981) + 19); break;
      case 2: case 10: ip[id] = rnd(f32(v * 216) + 5); break;
      case 3: ip[3] = rnd(f32(v * 250)); break;
      case 4: this.pdFb = v; break;
      case 5: ip[5] = rnd(f32(v * 99) + 1); break;
      case 6: ip[6] = rnd(f32(v * 100)); break;
      case 7: ip[7] = rnd(f32(v * 28) + 2); break;
      case 8: ip[8] = rnd(f32(v * 1975) + 25); break;
      case 9: ip[9] = rnd(f32(v * 199) + 1); break;
      case 14: ip[14] = rnd(f32(v * 200)); break;
      default: if (id >= 15 && id <= 18) ip[id] = rnd(v); break;
    }
    this.dirty = true;
  }

  private dbGain(v: number): number {
    return v >= -360 ? exp10f(f32(v / 200)) : 0;
  }

  private onePoleLp(v: number, srf: number): number {
    if (v > 220) return 1;
    const c = cosf(f32(f32(f32(f32(v * 100) * 2) * f32(Math.PI)) / srf));
    const b = f32(2 - c);
    return f32(f32(f32(Math.sqrt(fma32(b, b, -1))) - b) + 1);
  }

  /** FL's coefficient update (0x15fd4). */
  private update(): void {
    const ip = this.ip;
    const srf = f32(this.sr);
    this.inGain = ip[15] ? 0 : this.dbGain(ip[0]);
    if (ip[1] >= 20) {
      const fc = Math.min(f32(srf * 0.5), ip[1]);
      const t = tanf(f32(f32(fc * f32(Math.PI)) / srf));
      this.lc = f32(f32(t + -1) / f32(t + 1));
    } else this.lc = 0;
    this.hc = this.onePoleLp(ip[2], srf);
    const s = Math.trunc(srf);
    let pd = Math.trunc((ip[3] * s) / 1000);
    if (pd < 1) pd = 1;
    this.pdLen = pd;
    this.idx[12] %= pd;
    const x10 = Math.trunc(((ip[5] + 15) * s) / 115);
    for (let k = 0; k < 12; k++) {
      const p = BASE[k] * x10;
      const n = p >= 20000 ? Math.trunc(p / 20000) : 1;
      this.len[k] = Math.min(n, this.cap[k]);
      this.idx[k] %= this.len[k];
    }
    for (let i = 0; i < 7; i++) {
      this.tapA[i] = Math.trunc((TAP_A[i] * x10) / 20000);
      this.tapB[i] = Math.trunc((TAP_B[i] * x10) / 20000);
    }
    const x9 = Math.trunc(((ip[5] + 3) * s) / 103);
    const x9f = f32(x9);
    let ref = 0;
    for (let i = 0; i < 8; i++) {
      const tl = f32(f32(f32(ER_L[i] * 1.5) * x9f) / f32(44100));
      const tr = f32(f32(f32(ER_R[i] * 1.5) * x9f) / f32(44100));
      const il = Math.trunc(tl), ir = Math.trunc(tr);
      this.erTapL[i] = il;
      this.erTapR[i] = ir;
      ref = i === 0 ? Math.min(il, ir) : 0;
      this.erGL[i] = f32(f32(ref * 0.5) / il);
      this.erGR[i] = f32(f32(ref * f32(0.36000001430511475)) / ir);
    }
    if (ip[5] !== this.roomCache) {
      this.roomCache = ip[5];
      this.mem.fill(0, 0, this.off[13] - this.cap[12]);
      this.mem.fill(0, this.off[13], this.off[13] + this.erSize);
    }
    const D = f32(ip[6] / 100);
    const L = this.len;
    const LN = f32(-6.907755374908447);
    if (D !== 0) {
      const t6 = f32(f32(f32(L[6] + L[10]) * 0.5) / srf);
      const t4 = f32(f32(f32(L[4] + L[8]) * 0.5) / srf);
      const t2 = f32(f32(f32(L[2] + L[3]) * 0.5) / srf);
      const t0 = f32(f32(f32(L[0] + L[1]) * 0.5) / srf);
      this.g1 = expf(f32(f32(t0 * LN) / f32(D * f32(0.07000000029802322))));
      this.g2 = expf(f32(f32(t2 * LN) / f32(D * f32(0.10999999940395355))));
      this.gAp1 = expf(f32(f32(t4 * LN) / f32(D * f32(0.3499999940395355))));
      this.gAp2 = expf(f32(f32(t6 * LN) / f32(D * f32(0.5099999904632568))));
    } else { this.g1 = this.g2 = this.gAp1 = this.gAp2 = 0; }
    const loop = f32(f32(L[5] + L[7] + L[9] + L[11]) / srf);
    const T = f32(ip[9] / 10);
    const e12 = f32(loop * LN);
    const g = powf(expf(f32(e12 / T)), f32(0.25));
    this.gStage = g;
    const gb = powf(expf(f32(e12 / f32(f32(T * ip[7]) / 10))), f32(0.25));
    const ratio = f32(gb / g);
    this.shelfK = f32(f32(ratio + -1) * 0.5);
    const r1 = Math.min(ratio, 1);
    const tc = tanf(f32(f32(ip[8] * f32(Math.PI)) / srf));
    this.shelfC = f32(f32(tc - r1) / f32(tc + r1));
    this.damp = this.onePoleLp(ip[10], srf);
    this.dry = ip[16] ? 0 : this.dbGain(ip[11]);
    this.er = ip[17] ? 0 : (ip[12] >= -360 ? f32(this.dbGain(ip[12]) * 0.5) : 0);
    this.wet = ip[18] ? 0 : (ip[13] >= -360 ? f32(f32(this.dbGain(ip[13]) * f32(0.6000000238418579)) * 0.5) : 0);
    this.dirty = false;
  }

  reset(): void {
    this.wetCur = f32(-1000);
    this.mem.fill(DENORM);
    this.hcY = this.lcY = this.lcX = 0;
    this.dampL = this.dampR = 0;
    this.shL1 = this.shL2 = this.shR1 = this.shR2 = 0;
  }

  /** 0x1066c / 0x10724 (MyPlugin::reset): the memory back to the idle pattern, the filter states cleared, the coefficients recomputed at the next block. */
  flReset(): void {
    this.reset();
    this.erL = this.erR = 0;
    this.roomCache = -999999;
    this.dirty = true;
  }

  /** Process `n` frames in place. */
  process(Lb: Float32Array, Rb: Float32Array, n: number): void {
    if (this.dirty) this.update();
    const m = this.mem, off = this.off, len = this.len, idx = this.idx;
    const g = this.gStage, gc = f32(1 - g);
    // FL's engine fuses every multiply-add (arm64 FMADD / FMSUB): fma32(a, b, c) = a * b + c, fms32(a, b, c) = c - a * b
    const s1 = fma32(gc, f32(0.6000000238418579), g);
    const s3 = fma32(gc, f32(0.699999988079071), g);
    const s2 = fma32(gc, 0.25, g);
    const s5 = fma32(gc, 0.5, g);
    const s6 = fma32(gc, f32(0.20000000298023224), g);
    const w = f32(f32(this.ip[14]) * f32(0.009999999776482582));
    const erMask = this.erSize - 1;
    const erOff = off[13];
    for (let i = 0; i < n; i++) {
      const xL = f32(Lb[i] * this.inGain);
      const xR = f32(this.inGain * Rb[i]);
      // high cut
      let x = fma32(f32(fma32(f32(xL + xR), 0.5, DENORM) - this.hcY), this.hc, this.hcY);
      this.hcY = x;
      // low cut: (x - allpass(x)) / 2
      const ap = fma32(f32(x - this.lcY), this.lc, this.lcX);
      this.lcY = ap;
      this.lcX = x;
      if (this.lc !== 0) x = fma32(f32(x - ap), 0.5, DENORM);
      // early reflections (before the diffusers write their output)
      if (this.er !== 0) {
        const p = idx[13];
        const eL = this.erTapL, eR = this.erTapR, gL = this.erGL, gR = this.erGR;
        let a = f32(m[erOff + ((eL[0] + p) & erMask)] * gL[0]);
        a = fma32(m[erOff + ((eL[1] + p) & erMask)], gL[1], a);
        a = fms32(m[erOff + ((eL[2] + p) & erMask)], gL[2], a);
        a = fma32(m[erOff + ((eL[3] + p) & erMask)], gL[3], a);
        a = fma32(m[erOff + ((eL[4] + p) & erMask)], gL[4], a);
        a = fma32(m[erOff + ((eL[5] + p) & erMask)], gL[5], a);
        a = fma32(m[erOff + ((eL[6] + p) & erMask)], gL[6], a);
        this.erL = a;
        let b = f32(m[erOff + ((eR[0] + p) & erMask)] * gR[0]);
        b = fms32(m[erOff + ((eR[1] + p) & erMask)], gR[1], b);
        b = fma32(m[erOff + ((eR[2] + p) & erMask)], gR[2], b);
        b = fma32(m[erOff + ((eR[3] + p) & erMask)], gR[3], b);
        b = fms32(m[erOff + ((eR[4] + p) & erMask)], gR[4], b);
        b = fma32(m[erOff + ((eR[5] + p) & erMask)], gR[5], b);
        b = fma32(m[erOff + ((eR[6] + p) & erMask)], gR[6], b);
        b = fms32(m[erOff + ((eR[7] + p) & erMask)], gR[7], b);
        this.erR = b;
      }
      const g1 = this.g1, g2 = this.g2;
      // diffuser 1
      let j = off[0] + idx[0];
      let v = fms32(g1, x, m[j]);
      m[j] = fma32(g1, v, x);
      if (idx[0] <= 0) idx[0] = len[0];
      // diffuser 2 (output g2, feedback g1)
      j = off[1] + idx[1];
      let u = fms32(g2, v, m[j]);
      m[j] = fma32(g1, u, v);
      if (idx[1] <= 0) idx[1] = len[1];
      // early-reflection line takes diffuser 1's output
      m[erOff + idx[13]] = v;
      const erNext = idx[13] < 1 ? this.erSize : idx[13];
      // diffuser 3
      j = off[2] + idx[2];
      v = fms32(g1, u, m[j]);
      m[j] = fma32(g1, v, u);
      if (idx[2] <= 0) idx[2] = len[2];
      // diffuser 4 (output g2, feedback g1)
      j = off[3] + idx[3];
      u = fms32(g2, v, m[j]);
      m[j] = fma32(g1, u, v);
      if (idx[3] <= 0) idx[3] = len[3];
      // predelay with feedback
      j = off[12] + idx[12];
      const pdOut = m[j];
      m[j] = fma32(pdOut, this.pdFb, u);
      const pdNext = idx[12] <= 0 ? this.pdLen : idx[12];
      const tin = f32(pdOut + DENORM20);
      // ---- left half: right half's end x stage gain -> bass shelf -> damping -> AP1 -> D1 -> AP2 -> D2
      let s = f32(m[off[11] + idx[11]] * g);
      let t = fma32(f32(s - this.shL2), this.shelfC, this.shL1);
      this.shL2 = t; this.shL1 = s;
      s = f32(tin + fma32(f32(s + t), this.shelfK, s));
      this.dampL = fma32(f32(s - this.dampL), this.damp, this.dampL);
      s = this.dampL;
      j = off[4] + idx[4];
      v = fms32(this.gAp1, s, m[j]);
      m[j] = fma32(this.gAp1, v, s);
      if (idx[4] <= 0) idx[4] = len[4];
      j = off[5] + idx[5];
      let d1 = m[j];
      m[j] = v;
      if (idx[5] <= 0) idx[5] = len[5];
      d1 = f32(d1 * g);
      j = off[6] + idx[6];
      v = fms32(this.gAp2, d1, m[j]);
      m[j] = fma32(this.gAp2, v, d1);
      if (idx[6] <= 0) idx[6] = len[6];
      j = off[7] + idx[7];
      m[j] = v;
      if (idx[7] <= 0) idx[7] = len[7];
      idx[7]--;
      s = f32(m[off[7] + idx[7]] * g);
      // ---- right half
      t = fma32(f32(s - this.shR2), this.shelfC, this.shR1);
      this.shR2 = t; this.shR1 = s;
      s = f32(tin + fma32(f32(s + t), this.shelfK, s));
      this.dampR = fma32(f32(s - this.dampR), this.damp, this.dampR);
      s = this.dampR;
      j = off[8] + idx[8];
      v = fms32(this.gAp1, s, m[j]);
      m[j] = fma32(this.gAp1, v, s);
      if (idx[8] <= 0) idx[8] = len[8];
      j = off[9] + idx[9];
      let d2 = m[j];
      m[j] = v;
      if (idx[9] <= 0) idx[9] = len[9];
      d2 = f32(d2 * g);
      j = off[10] + idx[10];
      v = fms32(this.gAp2, d2, m[j]);
      m[j] = fma32(this.gAp2, v, d2);
      if (idx[10] <= 0) idx[10] = len[10];
      idx[5]--; idx[6]--; idx[9]--; idx[10]--;
      m[off[11] + idx[11]] = v;
      if (idx[11] <= 0) idx[11] = len[11];
      idx[11]--;
      // ---- output taps
      const rd = (k: number, tap: number, base: number) => {
        let q = tap + base;
        if (q >= len[k]) q -= len[k];
        return m[off[k] + q];
      };
      const a0 = rd(9, this.tapA[0], idx[9]), a1 = rd(9, this.tapA[1], idx[9]);
      const a2 = rd(10, this.tapA[2], idx[10]), a3 = rd(11, this.tapA[3], idx[11]);
      const a4 = rd(5, this.tapA[4], idx[5]), a5 = rd(6, this.tapA[5], idx[6]);
      const a6 = rd(7, this.tapA[6], idx[7]);
      const b0 = rd(5, this.tapB[0], idx[5]), b1 = rd(5, this.tapB[1], idx[5]);
      const b2 = rd(6, this.tapB[2], idx[6]), b3 = rd(7, this.tapB[3], idx[7]);
      const b4 = rd(9, this.tapB[4], idx[9]), b5 = rd(10, this.tapB[5], idx[10]);
      const b6 = rd(11, this.tapB[6], idx[11]);
      let oL = fms32(a1, s2, a0);
      oL = fms32(a2, s3, oL);
      oL = fms32(a3, s6, oL);
      oL = fma32(a4, s1, oL);
      oL = f32(oL + a5);
      oL = fma32(a6, s5, oL);
      let oR = fma32(b1, s2, b0);
      oR = fms32(b2, s3, oR);
      oR = fms32(b3, s6, oR);
      oR = fms32(b4, s1, oR);
      oR = f32(oR + b5);
      oR = fma32(b6, s5, oR);
      // wet level slew
      let wc = this.wetCur;
      if (wc < -99) wc = this.wet;
      wc = fma32(f32(this.wet - wc), f32(0.0010000000474974513), wc);
      this.wetCur = wc;
      const lo = fma32(oL, wc, f32(this.erL * this.er));
      const ro = fma32(oR, wc, f32(this.erR * this.er));
      const M = f32(lo + ro), S = f32(lo - ro);
      Lb[i] = fma32(xL, this.dry, fma32(S, w, M));
      Rb[i] = fma32(xR, this.dry, fms32(S, w, M));
      // index steps
      idx[0]--; idx[1]--; idx[13] = erNext - 1; idx[2]--; idx[3]--; idx[12] = pdNext - 1; idx[4]--; idx[8]--;
    }
  }
}
