// Sakura's engine ("CSakuraSynth" + "CSakuraKey" of FL 2026's Sakura engine library), ported by static
// analysis of the arm64 code (function addresses in comments are FL's offsets in engine.dylib).
// Sakura renders silence in FL's test host because of FL's licence check; the check was neither patched
// nor faked, so no FL render exists and none of this could be compared with FL's output: the port
// follows FL's instruction order and float / double precision (fused multiply-adds emulated), see
// docs/research/gen/sakura.md.
//
// Structure: 99 "keys" (string voices, one per sounding note) are rendered at 48 kHz in groups of four
// (FL's NEON loop 0x1a110); the 48 kHz stereo result is resampled linearly to the host rate (0x19278),
// then the effect chain (fx.ts), the CC 7 / CC 10 output gain and the peak meters.

import { f32, fma, fms, fmaD, PzEnv } from '../poizone/dsp';
import { exp10f, powf } from '../poizone/applemath';
import { SkFx } from './fx';

export const SK_ENGINE_COUNT = 114;
export const SK_KEYS = 99;
const N48 = 48000;
const TWO_PI_SK = 6.283185306;
const THR = f32(9.99999993922529e-9);
const LCG_A = 0x0bb38435;
const LCG_C = 0x3619636b;
const lcg = (s: number): number => (Math.imul(s, LCG_A) + LCG_C) >>> 0;
const U32F = f32(2.3283064365386963e-10);
const F005 = f32(0.05);
const F0001 = f32(0.001);
const OCT = [27.5, 55, 110, 1760, 440, 880, 1760];

/** The engine-wide LCG (FL: one static, initial 1935757395) shared by all instances of the module. */
let SEED = 1935757395;
export function skResetSeed(): void { SEED = 1935757395; }

const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);
const dnT = f32(9.999999717180685e-10);

/**
 * One string voice (FL: CSakuraKey, 0x2f8 bytes). All per-lane vectors are four lanes: the two rails of
 * string 1 (lanes 0, 1) and of string 2 (lanes 2, 3).
 */
export class SkKey {
  readonly s: SkSynth;
  /** allocation order (FL +0x44) */
  seq = 0;
  /** FL +0x48: set by the note on, cleared by the reset (makes the block copy targets to current values) */
  flag48 = false;
  envVal = 0; lfoVal = 0; vel = 0;
  keyD = 0; relFlag = 0; key = 0;
  readonly env = new PzEnv();
  noiseThr = 0; drive = 0;
  /** amplitude one-pole: rate, target, value (FL +0xf8, +0xfc, +0x100) */
  ampRate = 0; ampTarget = 0; amp = 0;
  /** string iterations: fractional accumulator and iterations per output sample (FL +0x108, +0x110) */
  frac = 0; iter = 0;
  /** frequency (+0x118), transposed frequency (+0x120), 48000 / length (+0x128) */
  freq = 0; freqT = 0; ratio = 0;
  outPL = 0; outNL = 0; outPR = 0; outNR = 0;
  age = 0; relAge = -1;
  /** Hi-Cut ladder states (FL +0x158 B, +0x15c C, +0x160 D, +0x164 E, +0x170 A) and its coefficients */
  ladB = 0; ladC = 0; ladD = 0; ladE = 0; ladA = 0;
  c168 = 0; c16c = 0; c174 = 0; c178 = 0;
  n17c = 0; n180 = 0;
  /** Lo-Cut high-pass: x[n-2], x[n-1], y[n-2], y[n-1] (FL +0x184 .. +0x190) and coefficients */
  hpA = 0; hpB = 0; hpC = 0; hpD = 0;
  c194 = 0; c198 = 0; c19c = 0;
  active = false;
  /** ring buffers: string 1 rails A, B and comb C, string 2 rails D, E and comb F; positions and lengths */
  bufA: Float32Array | null = null;
  bufB: Float32Array | null = null;
  bufC: Float32Array | null = null;
  bufD: Float32Array | null = null;
  bufE: Float32Array | null = null;
  bufF: Float32Array | null = null;
  pA = 0; pB = 0; pC = 0; pD = 0; pE = 0; pF = 0;
  eA = 0; eB = 0; eC = 0; eD = 0; eE = 0; eF = 0;
  combLevel = 0; combFb = 0; sat = 0;
  readonly va = new Float32Array(4);
  readonly vb = new Float32Array(4);
  readonly vc = new Float32Array(4);
  readonly q288 = new Float32Array(4);
  readonly q298 = new Float32Array(4);
  readonly t18 = new Float32Array(4);
  readonly cur18 = new Float32Array(4);
  readonly t19 = new Float32Array(4);
  readonly cur19 = new Float32Array(4);
  noiseHold = 0; inv1 = 0; inv2 = 0;
  silence = -1;

  constructor(s: SkSynth) {
    this.s = s;
    this.reset();
  }

  /** FL 0x617c: back to the idle state (the constructor does the same). */
  reset(): void {
    this.active = false;
    this.flag48 = false;
    this.env.reset();
    this.frac = 0;
    this.amp = 0; this.ampRate = 0; this.ampTarget = 0;
    this.outPL = 0; this.outNL = 0; this.outPR = 0; this.outNR = 0;
    this.ladB = 0; this.ladC = 0; this.ladD = 0; this.ladE = 0;
    this.c168 = 0; this.c16c = 0; this.ladA = 0; this.c174 = 0; this.c178 = 0;
    this.hpA = 0; this.hpB = 0; this.hpC = 0; this.hpD = 0;
    this.c194 = 0; this.c198 = 0; this.c19c = 0;
    if (this.bufA) {
      this.bufA.fill(0); this.bufB!.fill(0); this.bufD!.fill(0); this.bufE!.fill(0);
      this.bufC!.fill(0); this.bufF!.fill(0);
    }
    this.pA = this.pB = this.pC = this.pD = this.pE = this.pF = 0;
    this.drive = 0;
    this.va.fill(0); this.vb.fill(0); this.vc.fill(0);
    this.q288.fill(0); this.q298.fill(0); this.t18.fill(0);
    this.t19.fill(0); this.cur19.fill(0);
    this.silence = -1;
    this.iter = 0;
    this.envVal = 0; this.lfoVal = 0;
  }

  /** FL 0x6338: start the note (key = MIDI note, vel = velocity / 127). */
  noteOn(key: number, vel: number): void {
    if (!this.bufA) {
      this.bufA = new Float32Array(N48); this.bufB = new Float32Array(N48);
      this.bufC = new Float32Array(N48); this.bufD = new Float32Array(N48);
      this.bufE = new Float32Array(N48); this.bufF = new Float32Array(N48);
    }
    const S = this.s;
    this.key = key;
    this.keyD = key;
    const e = Math.pow(2, fmaD(f32(key), 0.08333333333333333, -4.75));
    const f1 = e * 220;
    this.freq = f1;
    this.age = 0; this.relAge = -1;
    this.relFlag = 0;
    this.vel = f32(vel);
    this.flag48 = true;
    let ft = f1;
    const w9 = Math.trunc(S.transpose * 6);
    if (w9 >= 0 && w9 <= 6 && ((0x77 >> w9) & 1) !== 0) ft = e * OCT[w9];
    this.freqT = ft;
    const l1raw = Math.trunc(48000 / ft);
    let w10 = l1raw | 0;
    let w11: number;
    switch (S.s2Ratio) {
      case 0: { const m = w10 < 0 ? w10 + 3 : w10; w11 = m >> 2; w10 = m & ~3; break; }
      case 1: { const m = Math.trunc(w10 / 3); w11 = m; w10 = m * 3; break; }
      case 2: { const m = w10 < 0 ? w10 + 1 : w10; w11 = m >> 1; w10 = m & ~1; break; }
      case 3: w11 = w10; break;
      case 4: w11 = w10 << 1; break;
      case 5: w11 = w10 + (w10 << 1); break;
      case 6: w11 = w10 << 2; break;
      default: w11 = w10; break;
    }
    const L1 = Math.min(w10, N48);
    this.ratio = 48000 / L1;
    this.eA = L1; this.eB = L1;
    const L2 = Math.min(w11 > 1 ? w11 : 1, N48);
    this.eD = L2; this.eE = L2;
    this.inv1 = f32(1 / L1);
    this.inv2 = f32(1 / L2);
    const cr = S.combRatio;
    const m12 = Math.trunc(f32(cr * f32(L1)));
    this.eC = Math.min(m12 > 1 ? m12 : 1, N48);
    const m16 = Math.trunc(f32(cr * f32(L2)));
    this.eF = Math.min(m16 > 1 ? m16 : 1, N48);
    this.env.setup(0, S.egA, S.egD, S.egS, 0, 0, 0, 0, 48000, 1);
    this.hpA = 0; this.hpB = 0; this.hpC = 0; this.hpD = 0;
    this.active = true;
  }

  /** FL 0x65e8. */
  noteOff(): void {
    this.relFlag = 1;
    this.env.setRelease(this.s.egR);
    this.env.release();
    this.relAge = 0;
  }

  /** FL 0x6f4c: the modulation matrix for one destination. */
  getMod(dest: number): number {
    const S = this.s;
    const p = S.p;
    let acc = 0;
    let any = 0;
    for (let i = 0; i < 8; i++) {
      const b = 79 + 4 * i;
      const am = p[b + 1];
      const am2 = f32(am * am);
      const g = p[b + 2] !== 0 ? -am2 : am2;
      const dst = Math.trunc(p[b + 3]);
      if (dst !== dest) continue;
      const src = Math.trunc(p[b]);
      if (src !== 0) any = 1;
      if (src < 1 || src > 8) continue;
      switch (src) {
        case 1: acc = fma(this.envVal, g, acc); break;
        case 2: acc = fma(this.lfoVal, g, acc); break;
        case 3: acc = fma(S.cc[1], g, acc); break;
        case 4: acc = fma(S.bend, g, acc); break;
        case 5: acc = fma(S.chanAT, g, acc); break;
        case 6: acc = fma(this.vel, g, acc); break;
        case 7: acc = f32(fmaD(g, 0.0125 * this.keyD, acc)); break;
        default: acc = fma(this.relFlag, g, acc); break;
      }
    }
    return (dest !== 0 || any !== 0) && (dest !== 1 || any !== 0) ? acc : 1;
  }

  /** FL 0x6630: per-block coefficient update for n internal samples (48 kHz). */
  prepare(n: number): void {
    if (!this.active) return;
    const S = this.s;
    const sat = S.sat;
    this.sat = f32(f32(sat * sat) * f32(sat * 100));
    this.iter = this.freqT / this.ratio;
    const m3 = this.getMod(3);
    const kk = Math.trunc(this.keyD);
    const pa = f32(m3 * f32(0.16666667));
    const arg = fma(f32(S.tune + S.notePitch[kk]), f32(0.083333336), pa);
    this.iter = Math.pow(2, arg) * this.iter;
    this.envVal = this.env.tick(n);
    const lfoc = S.lfoCos;
    this.lfoVal = f32(this.getMod(0) * lfoc);
    const nm = this.getMod(14);
    const x = clamp01(f32(nm + S.noiseRate));
    this.noiseThr = f32(Math.sqrt(Math.sqrt(1 - x)) * 0.996);
    this.drive = S.drive;
    const t = S.noiseMix;
    this.n17c = f32(t * t);
    this.n180 = f32(1 - t);
    // Hi-Cut envelope (attack / decay / sustain of the ladder's cutoff scaling)
    const hA = S.hiA;
    const mA = this.getMod(6);
    const hD = S.hiD;
    const mD = this.getMod(7);
    if (this.relAge > -1) {
      this.c168 = f32(0.001999999862164259);
      this.c16c = 0;
    } else {
      const a = clamp01(f32(mA + hA));
      const a2 = f32(a * a);
      const half = f32(a2 * 0.5);
      if (this.age > half) {
        const d = clamp01(f32(mD + hD));
        const d3 = f32(d * f32(d * d));
        this.c168 = f32(0.0002 / f32(fmaD(d3, 3, 0.001)));
        this.c16c = f32(S.hiS * S.hiS);
      } else {
        this.c168 = half < f32(0.001) ? 1 : f32(f32(0.0004) / a2);
        this.c16c = 1;
      }
    }
    // Hi-Cut filter (cutoff scale, resonance feedback)
    const l2 = S.hiCut;
    const m5 = this.getMod(5);
    const m3b = f32(fmaD(m5, 0.5, l2));
    const m4 = Math.min(f32(m3b * m3b), 1);
    this.c174 = m4;
    const l6 = S.hiRes;
    const r10 = l6 * 10;
    this.c178 = Math.max(f32(fmaD(m4, r10, -r10)), -4);
    // Lo-Cut filter (2-pole high-pass)
    const l7 = S.loCut;
    const m4b = this.getMod(4);
    const lc = clamp01(f32(fmaD(m4b, 0.5, l7)));
    const w = Math.pow(2, fmaD(lc, 9.3, 5)) * 0.0001308996938995747;
    const l9 = S.loRes;
    const m10 = f32(fmaD(l9, 10, 1));
    const sn = Math.sin(w), cs = Math.cos(w);
    const m11 = sn + m10;
    this.c194 = f32((cs + 1) / (sn / m10 + 2));
    this.c198 = f32((m10 * -2 * cs) / m11);
    this.c19c = f32((m10 - sn) / m11);
    // string 1 damping, decay
    const l12 = S.s1DampSharp;
    const h1 = f32(l12 * -0.5);
    const l13 = S.s1DampAmt;
    const a13 = this.getMod(13);
    const a11 = this.getMod(11);
    const d14 = clamp01(f32(l13 + f32(a13 + a11)));
    const c14 = f32(f32(d14 * d14) * d14);
    const m15 = f32(f32(Math.pow(2, fmaD(-c14, 5.0766486427023638, 14.50471040772104))) * f32(4.5351473e-05));
    const m15c = Math.min(m15, 1);
    this.q288[0] = m15c;
    this.q298[0] = fms(m15c, h1, h1);
    const l17 = S.s1DampOff;
    const m18 = Math.min(fms(l17, m15, m15), 1);
    this.q288[1] = m18;
    this.q298[1] = fms(m18, h1, h1);
    const l19 = S.s1Decay;
    const a10 = this.getMod(10);
    const a8 = this.getMod(8);
    const pw1 = powf(clamp01(f32(l19 + f32(a10 + a8))), F005);
    const sg1 = S.s1Inv ? -pw1 : pw1;
    this.t18[0] = sg1; this.t18[1] = sg1;
    // string 2
    const l23 = S.s2DampSharp;
    const h2 = f32(l23 * -0.5);
    const l24 = S.s2DampAmt;
    const b13 = this.getMod(13);
    const b12 = this.getMod(12);
    const d25 = clamp01(f32(l24 + f32(b13 + b12)));
    const c25 = f32(f32(d25 * d25) * d25);
    const m26 = f32(f32(Math.pow(2, fmaD(-c25, 5.0766486427023638, 14.50471040772104))) * f32(4.5351473e-05));
    const m26c = Math.min(m26, 1);
    this.q288[2] = m26c;
    this.q298[2] = fms(m26c, h2, h2);
    const l28 = S.s2DampOff;
    const m29 = Math.min(fms(l28, m26, m26), 1);
    this.q288[3] = m29;
    this.q298[3] = fms(m29, h2, h2);
    const l30 = S.s2Decay;
    const c10 = this.getMod(10);
    const c9 = this.getMod(9);
    const pw2 = powf(clamp01(f32(l30 + f32(c10 + c9))), F005);
    const sg2 = S.s2Inv ? -pw2 : pw2;
    this.t18[2] = sg2; this.t18[3] = sg2;
    // pan and level
    const l34 = S.stereo;
    const pm = this.getMod(2);
    const m35 = clamp01(f32(pm + l34));
    const lm = this.getMod(1);
    const e10 = exp10f(f32(lm + lm));
    const l37 = S.mix;
    const m38 = f32(e10 * F005);
    const m39 = fms(l37, m38, m38);
    const gl = S.noteL[kk], gr = S.noteR[kk];
    this.t19[0] = f32(fmaD(-m35, m39, m39) * gl);
    this.t19[1] = f32(m39 * f32(m35 * gr));
    const pm2 = this.getMod(2);
    const m45 = clamp01(f32(f32(1 - l34) + pm2));
    const lm2 = this.getMod(1);
    const e10b = exp10f(f32(lm2 + lm2));
    const m48 = f32(f32(e10b * F005) * l37);
    this.t19[2] = f32(fmaD(-m45, m48, m48) * gl);
    this.t19[3] = f32(m45 * f32(m48 * gr));
    // comb filter
    this.combFb = S.combFbInv ? -S.combFb : S.combFb;
    this.combLevel = S.combLevelInv ? -S.combLevel : S.combLevel;
    // amplitude envelope (one-pole segments evaluated per sample in process4)
    const dt = n * 2.0833333333333333e-05;
    if (this.relAge <= -1) {
      const att = S.ampA;
      if (this.age < att) {
        this.ampTarget = 5;
        this.ampRate = f32(4.6587423677440092e-06 / att);
      } else {
        this.ampRate = f32(0.00018374999999999999 / S.ampD);
        this.ampTarget = S.ampS;
      }
    } else {
      const rel = S.ampR;
      if (this.relAge > rel) { this.reset(); return; }
      this.ampTarget = 0;
      this.ampRate = f32(0.00018374999999999999 / rel);
      this.relAge = this.relAge + dt;
    }
    if (this.flag48) {
      this.cur18.set(this.t18);
      this.cur19.set(this.t19);
    }
    this.age = this.age + dt;
  }
}

// ---------------------------------------------------------------------------------------------------
// FL 0x1a110: four keys in lock-step (lane section: exciter, Lo-Cut, Hi-Cut ladder; then each key's string
// iterations, output interpolation, silence counter and amplitude one-pole).

const ex = new Float32Array(4);
const lA = new Float32Array(4), lB = new Float32Array(4), lC = new Float32Array(4), lD = new Float32Array(4), lE = new Float32Array(4);
const hpa = new Float32Array(4), hpb = new Float32Array(4), hpc = new Float32Array(4), hpd = new Float32Array(4);
const rr = new Float32Array(4);
const rnd = new Float32Array(4);

/** Process n samples of four keys into L / R (offset off); first = overwrite, else accumulate. */
function process4(S: SkSynth, ks: SkKey[], L: Float32Array, R: Float32Array, off: number, n: number, first: boolean): void {
  for (let k = 0; k < 4; k++) {
    const K = ks[k];
    lA[k] = K.ladA; lB[k] = K.ladB; lC[k] = K.ladC; lD[k] = K.ladD; lE[k] = K.ladE;
    hpa[k] = K.hpA; hpb[k] = K.hpB; hpc[k] = K.hpC; hpd[k] = K.hpD;
  }
  const satc = ks[0].sat;
  for (let i = 0; i < n; i++) {
    // engine-wide noise: four draws per sample, one per lane
    const s0 = SEED, s1 = lcg(s0), s2 = lcg(s1), s3 = lcg(s2), s4 = lcg(s3);
    SEED = s4;
    rnd[0] = f32(f32(s0) * U32F); rnd[1] = f32(f32(s1) * U32F);
    rnd[2] = f32(f32(s2) * U32F); rnd[3] = f32(f32(s3) * U32F);
    for (let k = 0; k < 4; k++) if (rnd[k] > ks[k].noiseThr) ks[k].noiseHold = rnd[k];
    for (let k = 0; k < 4; k++) {
      const K = ks[k];
      // exciter: noise * (1 - click)^2 + click, through the Lo-Cut high-pass and the Hi-Cut ladder
      const exc = fma(K.noiseHold, K.n17c, K.n180);
      const x2 = f32(f32(hpa[k] - f32(hpb[k] + hpb[k])) + exc);
      const inner = fms(hpc[k], K.c19c, f32(hpd[k] * -K.c198));
      const y = fma(x2, K.c194, inner);
      const A2 = fma(f32(K.c16c - lA[k]), K.c168, lA[k]);
      const g = f32(A2 * K.c174);
      const t1 = fma(lE[k], K.c178, -lB[k]);
      const B2 = fma(f32(t1 + y), g, lB[k]);
      const C2 = fma(f32(B2 - lC[k]), g, lC[k]);
      const D2 = fma(f32(C2 - lD[k]), g, lD[k]);
      const E2 = fma(f32(D2 - lE[k]), g, lE[k]);
      const q = f32(E2 * E2);
      ex[k] = f32(E2 / fma(q, K.drive, 1));
      hpa[k] = hpb[k]; hpb[k] = exc; hpc[k] = hpd[k]; hpd[k] = y;
      lA[k] = A2; lB[k] = B2; lC[k] = C2; lD[k] = D2; lE[k] = ex[k];
    }
    let sumL = 0, sumR = 0, started = false;
    for (let k = 0; k < 4; k++) {
      const K = ks[k];
      if (!K.active) continue;
      const exc = ex[k];
      const acc = K.frac + K.iter;
      let w30 = Math.trunc(acc);
      const fr = acc - w30;
      K.frac = fr;
      let newL = K.outNL, newR = K.outNR;
      if (w30 !== 0) {
        const bA = K.bufA!, bB = K.bufB!, bC = K.bufC!, bD = K.bufD!, bE = K.bufE!, bF = K.bufF!;
        let pA = K.pA, pB = K.pB, pC = K.pC, pD = K.pD, pE = K.pE, pF = K.pF;
        const va = K.va, vb = K.vb, vc = K.vc, q288 = K.q288, q298 = K.q298;
        const cur18 = K.cur18, cur19 = K.cur19, t18 = K.t18, t19 = K.t19;
        const c0 = K.inv1, c2 = K.inv2;
        const cl = K.combLevel, cf = K.combFb;
        while (w30 > 0) {
          K.outPL = newL; K.outPR = newR;
          if (pA >= K.eA) pA = 0;
          if (pB >= K.eB) pB = 0;
          if (pD >= K.eD) pD = 0;
          if (pE >= K.eE) pE = 0;
          if (pC >= K.eC) pC = 0;
          if (pF >= K.eF) pF = 0;
          rr[0] = bA[pA]; rr[1] = bB[pB]; rr[2] = bD[pD]; rr[3] = bE[pE];
          for (let l = 0; l < 4; l++) {
            const cin = l < 2 ? c0 : c2;
            vc[l] = fma(f32(exc - vc[l]), cin, vc[l]);
            const t = fma(vb[l], q298[l], -va[l]);
            const s1n = fma(f32(t + rr[l]), q288[l], va[l]);
            va[l] = s1n;
            const vbn = fma(f32(s1n - vb[l]), q288[l], vb[l]);
            const sv = f32(vbn / fma(f32(vbn * vbn), satc, 1));
            vb[l] = sv;
            const wv = fma(sv, cur18[l], f32(exc - vc[l]));
            if (l === 0) bA[pA] = wv; else if (l === 1) bB[pB] = wv; else if (l === 2) bD[pD] = wv; else bE[pE] = wv;
          }
          pA++; pB++; pD++; pE++;
          const cC = bC[pC];
          const m15 = fma(cl, cC, rr[0]);
          const cF = bF[pF];
          const m18 = fma(cF, cl, rr[2]);
          const pk1 = Math.abs(f32(m15 * f32(cur19[0] + cur19[1])));
          if (pk1 > S.peak1) S.peak1 = pk1;
          const pk2 = Math.abs(f32(m18 * f32(cur19[2] + cur19[3])));
          if (pk2 > S.peak2) S.peak2 = pk2;
          bC[pC] = fma(cf, cC, rr[1]);
          bF[pF] = fma(cf, cF, rr[3]);
          pC++; pF++;
          newL = fma(m18, cur19[2], f32(m15 * cur19[0]));
          newR = fma(m18, cur19[3], f32(m15 * cur19[1]));
          for (let l = 0; l < 4; l++) {
            cur18[l] = fma(f32(t18[l] - cur18[l]), F005, cur18[l]);
            cur19[l] = fma(f32(t19[l] - cur19[l]), F0001, cur19[l]);
          }
          K.outNL = newL; K.outNR = newR;
          w30--;
        }
        K.pA = pA; K.pB = pB; K.pC = pC; K.pD = pD; K.pE = pE; K.pF = pF;
      }
      // output: linear interpolation between the last two string outputs, times the amplitude one-pole
      const amp = K.amp;
      const oL = f32(fmaD(fr, f32(newL - K.outPL), K.outPL) * amp);
      const oR = f32(fmaD(fr, f32(newR - K.outPR), K.outPR) * amp);
      if (Math.abs(oL) < THR && Math.abs(oR) < THR) {
        if (K.silence >= 0) K.silence = K.silence + 1;
      } else K.silence = 0;
      if (!started) { sumL = oL; sumR = oR; started = true; } else { sumL = f32(sumL + oL); sumR = f32(sumR + oR); }
      K.amp = Math.min(fma(f32(K.ampTarget - amp), K.ampRate, amp), 1);
    }
    if (first) { L[off + i] = sumL; R[off + i] = sumR; }
    else { L[off + i] = f32(L[off + i] + sumL); R[off + i] = f32(R[off + i] + sumR); }
  }
  for (let k = 0; k < 4; k++) {
    const K = ks[k];
    K.ladA = lA[k]; K.ladB = lB[k]; K.ladC = lC[k]; K.ladD = lD[k]; K.ladE = lE[k];
    K.hpA = hpa[k]; K.hpB = hpb[k]; K.hpC = hpc[k]; K.hpD = hpd[k];
  }
}

// ---------------------------------------------------------------------------------------------------

/** CSakuraSynth. */
export class SkSynth {
  sr = 44100;
  tempo = 120;
  songPos = 0;
  playing = false;
  /** the engine's 114 values (FL's parameter table; the editor's hidden values 78..113 live here too) */
  readonly p = new Float32Array(SK_ENGINE_COUNT);
  // CSynthesizer's MIDI state
  readonly vel01 = new Float32Array(128);
  readonly cc = new Float32Array(128);
  readonly polyAT = new Float32Array(128);
  bend = 0;
  chanAT = 0;
  /** per-key FinalLevels copied in by the FL wrapper (FL: synth +0x20 / +0x220 / +0x420 / +0x620 / +0x820) */
  readonly noteL = new Float32Array(128);
  readonly noteR = new Float32Array(128);
  readonly notePitch = new Float32Array(128);
  readonly noteCut = new Float32Array(128);
  readonly noteRes = new Float32Array(128);
  readonly keys: SkKey[] = [];
  readonly sentinel: SkKey;
  readonly fx = new SkFx();
  /** polyphony setting (FL +0x38e4) and the host's maximum (+0x38ec) */
  polySet = SK_KEYS;
  polyHost = SK_KEYS;
  seqCtr = 0;
  count = 0;
  readonly use = new Int32Array(128);
  // parameters (set by setParameter, FL +0x3bb4 ..)
  masterGain = 0; tune = 0; ampA = 0; ampD = 0; ampS = 0; ampR = 0;
  s1Decay = 0; s1Inv = false; s1DampOff = 0; s1DampAmt = 0; s1DampSharp = 0;
  s2Decay = 0; s2Inv = false; s2DampOff = 0; s2DampAmt = 0; s2DampSharp = 0;
  sat = 0; mix = 0; stereo = 0; combRatio = 0; combFb = 0; combFbInv = false; combLevel = 0; combLevelInv = false;
  loCut = 0; loRes = 0; hiA = 0; hiD = 0; hiS = 0; hiCut = 0; hiRes = 0;
  noiseMix = 0; noiseRate = 0; drive = 0;
  egA = 0; egD = 0; egS = 0; egR = 0;
  lfoRate = 0; lfoPhase = 0; lfoCos = 0;
  s2Ratio = 3; transpose = 0.5;
  // meters (FL +0x47c4 / +0x47c8 / +0x47cc)
  peak1 = 0; peak2 = 0; outPeak = 0;
  // resampler state (FL +0x47b8 position, +0x47c0 carried count, ring buffers at +0x3fb8 / +0x43b8)
  private rpos = 0;
  private carry = 0;
  private readonly ring1 = new Float32Array(1024);
  private readonly ring2 = new Float32Array(1024);
  /** the rings from index 1 (where the 48 kHz render writes) */
  private readonly ring1l = this.ring1.subarray(1);
  private readonly ring2l = this.ring2.subarray(1);
  private readonly list: SkKey[] = [];
  private readonly grp: SkKey[] = [];

  constructor() {
    for (let i = 0; i < SK_KEYS; i++) this.keys.push(new SkKey(this));
    this.sentinel = new SkKey(this);
    for (let i = 0; i < SK_KEYS + 3; i++) this.list.push(this.sentinel);
    for (let i = 0; i < 4; i++) this.grp.push(this.sentinel);
    this.cc[7] = 1;
    this.cc[10] = 0.5;
  }

  /** FL 0x191e4 (d0 > 0 sets the sample rate and rebuilds the effects, d0 = 0 flushes). */
  setSampleRate(sr: number): void {
    if (sr > 0) this.sr = sr;
    this.lfoPhase = 0;
    for (const k of this.keys) { k.reset(); k.seq = 0; }
    this.ring1.fill(0);
    this.ring2.fill(0);
    this.rpos = 0;
    this.carry = 0;
    this.peak1 = 0; this.peak2 = 0; this.outPeak = 0; this.seqCtr = 0;
    if (sr !== 0) this.fx.setSampleRate(sr); else this.fx.reset();
    this.count = 0;
    this.use.fill(0);
  }

  /** FL 0x5b50: every parameter to the engine's default (table at 0x44414). */
  resetToDefaults(): void {
    for (let i = 0; i < SK_ENGINE_COUNT; i++) this.setParameter(i, SK_DEFAULTS[i]);
  }

  /** FL 0x1b3d0 (FPE_MaxPoly: 0 = the engine's default maximum, 99 keys). */
  setMaxPoly(n: number): void { this.polyHost = n !== 0 ? n : SK_KEYS; }

  /** FL 0x18884. */
  setParameter(i: number, v: number): void {
    if (i < 0 || i >= SK_ENGINE_COUNT) return;
    v = f32(v);
    this.p[i] = v;
    const fx = this.fx;
    const v2 = f32(v * v);
    const v5 = (): number => f32(v * f32(v2 * v2));
    switch (i) {
      case 0: this.masterGain = exp10f(fma(v, f32(4.8), f32(-1.8))); break;
      case 1: {
        let w = Math.trunc(fma(v, 198, -99));
        if (!(w > -99)) w = -99;
        if (!(w < 99)) w = 99;
        this.tune = f32(w * 0.01);
        break;
      }
      case 2: this.ampA = f32(fmaD(v5(), 35, 0.001)); break;
      case 3: this.ampD = f32(fmaD(v5(), 50, 0.001)); break;
      case 4: this.ampS = v2; break;
      case 5: this.ampR = f32(fmaD(v5(), 10, 0.1)); break;
      case 6: this.s1Decay = v; break;
      case 7: this.s1Inv = v !== 0; break;
      case 8: this.s1DampOff = v2; break;
      case 9: this.s1DampAmt = v; break;
      case 10: this.s1DampSharp = v2; break;
      case 11: this.s2Decay = v; break;
      case 12: this.s2Inv = v !== 0; break;
      case 13: this.s2DampOff = v2; break;
      case 14: this.s2DampAmt = v; break;
      case 15: this.s2DampSharp = v2; break;
      case 16: this.sat = v2; break;
      case 17: this.mix = v; break;
      case 18: this.stereo = v; break;
      case 19: this.combRatio = v; break;
      case 20: this.combFb = f32(Math.sqrt(v)); break;
      case 21: this.combFbInv = v !== 0; break;
      case 22: this.combLevel = v; break;
      case 23: this.combLevelInv = v !== 0; break;
      case 24: this.loCut = v; break;
      case 25: this.loRes = v; break;
      case 26: this.hiA = v; break;
      case 27: this.hiD = v; break;
      case 28: this.hiS = v; break;
      case 29: this.hiCut = v; break;
      case 30: this.hiRes = v; break;
      case 31: this.noiseMix = f32(1 - v); break;
      case 32: this.noiseRate = v; break;
      case 33: this.drive = f32(f32(v2 * v2) * 1000); break;
      case 34: this.egA = f32(fmaD(f32(v * v2), 10, 0.001)); break;
      case 35: this.egD = f32(fmaD(v5(), 50, 0.001)); break;
      case 36: this.egS = v2; break;
      case 37: this.egR = f32(fmaD(v5(), 50, 0.1)); break;
      case 38: this.lfoRate = f32(fmaD(f32(v * v2), 10, 0.01)); break;
      case 55: case 56: case 57: case 58: case 59: case 60: case 61: case 62: fx.res.setOn(i - 55, v); break;
      case 63: fx.delayOn = v !== 0; break;
      case 64: fx.dTime = v; break;
      case 65: fx.dFb = v; break;
      case 66: fx.dSpeed = v; break;
      case 67: fx.dDepth = v; break;
      case 68: fx.dBlur = v; break;
      case 69: fx.dWet = v; break;
      case 70: fx.chorus.setOn(v); break;
      case 71: fx.chorus.setRate(v); break;
      case 72: fx.chorus.setDepth(v); break;
      case 73: fx.chorus.setWet(v); break;
      case 74: fx.reverbOn = v !== 0; break;
      case 75: fx.reverb.setParam(12, fma(v, f32(0.999), f32(0.001))); break;
      case 76: fx.reverb.setParam(8, f32(f32(v2 * f32(0.6)) * v)); break;
      case 77: fx.reverb.setParam(2, f32(v2 * v)); break;
      case 111: this.s2Ratio = Math.trunc(v); break;
      case 112: fx.dSync = v; break;
      case 113: this.transpose = v; break;
      default:
        if (i >= 39 && i <= 46) fx.res.setFreq(i - 39, v);
        else if (i >= 47 && i <= 54) fx.res.setFeedback(i - 47, v);
        break;
    }
  }

  getParameter(i: number): number { return i >= 0 && i < SK_ENGINE_COUNT ? this.p[i] : 0; }

  /** FL's chunk: engine values 0..113 in order. */
  loadState(values: ArrayLike<number>): void {
    for (let i = 0; i < SK_ENGINE_COUNT; i++) this.setParameter(i, values[i]);
  }

  // ------------------------------------------------------------------ MIDI (CSynthesizer + CSakuraSynth)
  /** CSynthesizer::noteOn (0x5ca0): velocity 1..127 plays, 0 releases. */
  noteOn(n: number, vel127: number): void {
    this.vel01[n & 127] = f32(f32(vel127) * f32(0.007874015718698502));
    if (vel127 !== 0) this.playNote(n); else this.releaseNote(n);
  }

  noteOff(n: number): void {
    this.vel01[n & 127] = 0;
    this.releaseNote(n);
  }

  controlChange(c: number, v127: number): void { this.cc[c & 127] = f32(f32(v127) * f32(0.007874015718698502)); }
  aftertouch(v127: number): void { this.chanAT = f32(f32(v127) * f32(0.007874015718698502)); }
  pitchBend(v: number): void { this.bend = f32(v); }

  /** FL 0x19e98: allocate a key (free, else the oldest) and start it. */
  private playNote(key: number): void {
    const lim = Math.min(this.polySet, this.polyHost) - 1;
    if (lim < 0) return;
    const vel = this.vel01[key & 127];
    const cnt = Math.min(lim, 98) + 1;
    let K: SkKey | null = null;
    for (let i = 0; i < cnt; i++) if (!this.keys[i].active) { K = this.keys[i]; break; }
    if (!K) {
      for (let i = 0; i < cnt; i++) {
        const c = this.keys[i];
        if (K === null) K = c; else if (!(c.seq > K.seq)) K = c;
      }
      if (!K) return;
      K.reset();
    }
    K.noteOn(key, vel);
    K.seq = this.seqCtr;
    this.seqCtr = (this.seqCtr + 1) >>> 0;
  }

  /** FL 0x19f90: release every active key playing the note. */
  private releaseNote(key: number): void {
    for (const K of this.keys) if (K.key === key && K.active) K.noteOff();
  }

  /** All keys released at once (panic). */
  allNotesOff(): void {
    for (const K of this.keys) if (K.active) K.noteOff();
  }

  // ------------------------------------------------------------------ audio
  /** FL 0x1c8: output gain of one side (CC 7 x master level, balance from CC 10). */
  private outGain(right: boolean): number {
    const g = f32(this.cc[7] * this.masterGain);
    if (!(g > 0)) return 0;
    const p = Math.min(Math.max(f32(this.cc[10] + this.cc[10]), 0), 2);
    if (right) return p <= 1 ? g : f32(f32(2 - p) * g);
    return p >= 1 ? g : f32(p * g);
  }

  /** FL 0x19828: render n internal (48 kHz) samples into the ring buffers (offset 1). */
  private renderInternal(n: number): void {
    const keys = this.keys;
    for (let i = 0; i < SK_KEYS; i++) keys[i].prepare(n);
    const list = this.list;
    const lim = Math.min(this.polySet, this.polyHost) - 1;
    let w28 = 0;
    let w = 0;
    if (lim >= 0) {
      const cnt = Math.min(lim, 98) + 1;
      for (let i = 0; i < cnt; i++) if (keys[i].active) { list[w++] = keys[i]; w28++; }
    }
    if (w28 <= 98) for (let i = 0; i < SK_KEYS; i++) if (!keys[i].active) list[w++] = keys[i];
    list[w] = this.sentinel; list[w + 1] = this.sentinel; list[w + 2] = this.sentinel;
    if (w28 < 1) return;
    this.group(0, n, true);
    if (w28 >= 5) {
      let w25 = w28 + 4;
      let g = 4;
      for (;;) {
        this.group(g, n, false);
        w25 -= 4;
        g += 4;
        if (w25 <= 8) break;
      }
    }
  }

  private group(g: number, n: number, first: boolean): void {
    const ks = this.grp;
    for (let k = 0; k < 4; k++) ks[k] = this.list[g + k];
    process4(this, ks, this.ring1l, this.ring2l, 0, n, first);
    for (let k = 0; k < 4; k++) if (ks[k].silence >= 1001) ks[k].reset();
  }

  /** FL 0x19278: one host block (n <= 64 samples) into L / R. */
  process(L: Float32Array, R: Float32Array, n: number): void {
    // global LFO: cosine of the current phase, then the phase advances
    const ph = this.lfoPhase;
    this.lfoCos = f32(Math.cos(ph * TWO_PI_SK));
    const np = f32(f32(this.lfoRate * f32(n)) / this.sr + ph);
    this.lfoPhase = np > 1 ? f32(np - 1) : np;
    if (n > 0) {
      const step = 48000 / this.sr;
      let pos = this.rpos;
      let rem = n;
      let o = 0;
      const r1 = this.ring1, r2 = this.ring2;
      while (rem !== 0) {
        let chunk = Math.min(rem, 48);
        rem -= chunk;
        if (pos < 0) {
          const carry = this.carry;
          do {
            const d = pos + carry;
            const idx = Math.trunc(d);
            const fr = f32(d - idx);
            const a = r1[idx], b = r1[idx + 1];
            L[o] = fma(f32(b - a), fr, a);
            const c = r2[idx], e = r2[idx + 1];
            R[o] = fma(f32(e - c), fr, c);
            o++;
            pos += step;
            chunk--;
          } while (pos < 0 && chunk !== 0);
          this.rpos = pos;
          if (chunk === 0) continue;
        }
        const d0 = fmaD(step, chunk, pos);
        const t0 = Math.trunc(d0);
        const w27 = d0 > t0 ? t0 + 1 : t0;
        this.carry = w27;
        r1.fill(0, 1, 256);
        r2.fill(0, 1, 256);
        this.renderInternal(w27);
        pos = this.rpos;
        do {
          const idx = Math.trunc(pos);
          const fr = f32(pos - idx);
          const a = r1[idx], b = r1[idx + 1];
          L[o] = fma(f32(b - a), fr, a);
          const c = r2[idx], e = r2[idx + 1];
          R[o] = fma(f32(e - c), fr, c);
          o++;
          pos += step;
          chunk--;
        } while (chunk !== 0);
        const car = this.carry;
        this.rpos = pos - car;
        pos = this.rpos;
        r1[0] = r1[car];
        r2[0] = r2[car];
      }
    }
    // effects on the host-rate block, then the output gain and the meters
    this.fx.tempo = this.tempo;
    this.fx.process(L, R, n);
    const gl = this.outGain(false), gr = this.outGain(true);
    for (let i = 0; i < n; i++) {
      const l = f32(L[i] * gl), r = f32(R[i] * gr);
      L[i] = l; R[i] = r;
      const al = Math.abs(l);
      if (al > this.outPeak) this.outPeak = al;
      const ar = Math.abs(r);
      if (ar > this.outPeak) this.outPeak = ar;
    }
    let cnt = 0;
    this.use.fill(0);
    for (const K of this.keys) if (K.active) { cnt++; this.use[K.key & 127]++; }
    this.count = cnt;
  }
}

/** The engine's defaults (FL's table at 0x44414, 114 floats, written as float32 shortest literals). */
export const SK_DEFAULTS: number[] = [
  0.5, 0.5, 0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0.5,
  0.5, 0, 0, 0, 0, 0, 0, 0, 0.2, 0, 0.5, 0, 1, 0, 0, 0, 1, 1, 1,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0.5, 0.6, 0.24, 0.2, 0.5, 0.35, 0, 0.5, 0.5, 0.4, 0, 0.5,
  0.5, 0.5, 0, 6, 1, 0, 1, 4, 1, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0.5,
];
