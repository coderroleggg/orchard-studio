// Toxic Biohazard voice (CToxicGenerator), ported from FL 2026's Toxic
// Biohazard on IL's CVoiceGenerator base (note, unison index, glide, FL's
// per-note levels):
// - blocks of 128 samples (independent of the host blocks): per block the
//   envelopes, LFO phases, velocity smoothing, the oscillator setup of every
//   enabled operator and unison voice, and the filter targets;
// - envelopes are one-poles: attack towards 5.0 (clamped at 1) with the rate
//   8.82 / (39.441975 t sr), decay / release towards sustain / the init level
//   with 8.82 / (t sr), retrigger fades for sr / 11025 blocks (147 / sr);
//   their timeline counts n / 44100 per block (FL's constant, any sample rate);
// - operator amplitude = the one-pole level x a Catmull-Rom cubic through the
//   last per-block values of velocity x LFO 1 / 2 amount (two blocks behind);
// - unison: geometric frequency spread ratio^(u - (U - 1) / 2), the voice's
//   unison pan law, FM between the operators of the same unison voice;
// - filter: four bilinear one-poles per channel with FL's coefficient table
//   (65536 cutoff steps, exp2 / exp fits), resonance feedback k x y4 with a
//   cubic soft clip of the input, LP (y4) / BP (y3 - y4) / HP (x - y4)
//   mixes smoothed 0.005 per sample, cutoff ramped per sample;
// - output: master envelope (one-pole, value before the update) into L / R.

import { f32, fmaD } from '../poizone/dsp';
import { TxBank } from './osc';
import type { TxSynth } from './synth';

const C147 = f32(147);
const F1E7 = f32(1e-7);
const F1E9 = f32(1e-9);
const F0999 = f32(0.9999989867210388);
const DEC = f32(9.070294618140906e-5);

let filterTable: Float32Array | null = null;

/** FL's filter coefficient table (65536 x {A, B, C}), built once like FL's static table. */
export function txFilterTable(): Float32Array {
  if (filterTable) return filterTable;
  const t = new Float32Array(65536 * 3);
  const K9 = 0.0001373311970702678, K1 = 1.5259021896696422e-05;
  for (let i = 0; i < 65536; i++) {
    const x = i;
    const u = x * K1;
    const a = fmaD(x, K9, 5);
    const e = Math.pow(2, a);
    const w = fmaD(e, 0.00016326530612244898, e * e * -3.290809899167528e-09);
    const ex = Math.exp(fmaD(w, -0.6931245, 1.386249));
    const b = fmaD(x, 5.08634063223214e-05, -2.333333333333333);
    let c = b * b * 0.08;
    if (0.7 >= u) c = -0;
    const s = Math.sqrt(1 - u);
    const s2 = s + s;
    let r = fmaD(ex, 0.95, c);
    r = r + fmaD(-s2, u, s2);
    r = r * 0.98;
    t[i * 3] = w + -1;
    t[i * 3 + 1] = w * 0.5;
    t[i * 3 + 2] = r;
  }
  filterTable = t;
  return t;
}

export class TxGen {
  readonly synth: TxSynth;
  readonly id: number;
  // CVoiceGenerator
  note = -1;
  uniIdx = 0;
  uniCnt = 1;
  det = 0;
  sr = 0;
  vel = 0;
  released = false;
  seqT = 0;
  glideRate = 0;
  glide = 0;
  age = 0;
  // CToxicGenerator
  readonly bank = new TxBank();
  nOsc = 0;
  readonly buf = new Float32Array(1024);
  mTgt = 0; mLvl = 0; mCoef = 0;
  fTgt = 0; fLvl = 0; fCoef = 0; egAmt = 0;
  relT = -1; time = 0;
  readonly h0 = new Float32Array(6);
  readonly h1 = new Float32Array(6);
  readonly h2 = new Float32Array(6);
  readonly h3 = new Float32Array(6);
  readonly en = new Uint8Array(6);
  readonly atk = new Float32Array(6);
  readonly dec = new Float32Array(6);
  readonly sus = new Float32Array(6);
  readonly rel = new Float32Array(6);
  readonly init = new Float32Array(6);
  mAtk = 0; mDec = 0; mRel = 0; mSus = 0; fAtk = 0; fDec = 0; fRel = 0; fSus = 0;
  U = 0;
  readonly velSens = new Float32Array(6);
  velSm = -20;
  /** filter states: L u, y1..y3 previous inputs (0..3), L y1..y4 (4..7), R the same (8..15) */
  readonly fs = new Float32Array(16);
  readonly mixT = new Float32Array(4);
  readonly mix = new Float32Array(4).fill(-20);
  lfo1P = 0; lfo2P = 0; lfo1V = 0; lfo2V = 0;
  cutPos = -1; cutInc = 0; res = 0;
  trig = 1;
  declick = 0;
  left = 128;
  // scratch
  private readonly amts = new Float32Array(6);
  private readonly srcs = new Int32Array(6);

  constructor(synth: TxSynth, id: number) {
    this.synth = synth;
    this.id = id;
    txFilterTable();
  }

  setNote(n: number): void {
    const u = this.synth.use;
    if (this.note >= 0 && this.note <= 127 && u[this.note] - 1 >= 0) u[this.note]--;
    this.note = n;
    if (n >= 0 && n <= 127) u[n]++;
  }

  /** Slot 2: the voice ends. */
  stop(): void {
    const u = this.synth.use;
    if (this.note >= 0 && this.note <= 127 && u[this.note] - 1 >= 0) u[this.note]--;
    this.note = -1;
  }

  /** CVoiceGenerator pitch (semitones) and frequency. */
  pitch(): number {
    const S = this.synth;
    let oct = 0;
    if (S.octaver) oct = (this.uniIdx & 1) === 0 ? 0 : 12;
    let det = 0;
    if (this.uniCnt >= 2) {
      const d = S.uniDtn;
      det = f32(d * -0.5 + f32(f32(d * this.uniIdx) / (this.uniCnt - 1)));
    }
    let s = f32(det + oct);
    s = f32(s + this.glide);
    s = f32(S.notePitch[this.note & 127] + s);
    s = f32(s + f32(S.transpose + this.det));
    s = f32(S.bendRange * S.bend + s);
    return f32(s + this.seqT);
  }

  freq(): number {
    return f32(Math.pow(2, fmaD(this.pitch(), 0.08333333333333333, -4.75)) * 220);
  }

  /** Unison pan law x FL's per-note gain (0 left, 1 right) x 0.5. */
  uniGain(right: boolean): number {
    const S = this.synth;
    let sp = 0;
    if (this.uniCnt >= 2) sp = f32(f32(f32(this.uniIdx + this.uniIdx) / (this.uniCnt - 1)) + -1);
    const s1 = f32(S.uniPan * sp);
    let g = right ? f32(1 - s1) : f32(s1 + 1);
    if (!(g >= 0)) g = 0;
    if (g > 1) g = 1;
    const nv = right ? S.noteR[this.note & 127] : S.noteL[this.note & 127];
    return f32(nv * f32(g * 0.5));
  }

  glideStep(n: number): void {
    const tgt = this.note;
    let cur = this.glide;
    if (!(cur >= tgt)) {
      cur = f32(this.glideRate * n + cur);
      this.glide = cur;
      if (cur > tgt) this.glide = tgt;
    } else if (cur > tgt) {
      cur = f32(cur - this.glideRate * n);
      this.glide = cur;
      if (cur < tgt) this.glide = tgt;
    }
  }

  /** Slot 5: hard reset (sample rate, envelopes, filter, oscillator schedule). */
  kill(sr: number): void {
    if (sr !== 0) this.sr = f32(sr);
    this.stop();
    this.mLvl = 0;
    this.fLvl = 0;
    this.fs.fill(0);
    this.cutPos = -1; this.cutInc = 0;
    this.mix.fill(-20);
    this.velSm = -20;
    this.h0.fill(0); this.h1.fill(0); this.h2.fill(0); this.h3.fill(0);
    this.trig = 1;
    this.left = 128;
    this.time = 0;
  }

  /** Slot 3: note start (FL copies the envelope settings and the LFO phases). */
  trigger(): void {
    const S = this.synth;
    S.velMod = this.vel;
    S.applyMods();
    this.declick = 0;
    if (this.time !== 0) this.declick = Math.trunc(f32(this.sr * DEC)) & 255;
    this.relT = -1;
    this.time = 0;
    const m1 = f32(0.001);
    this.mAtk = Math.max(f32(S.mAtk), m1);
    this.mDec = Math.max(f32(S.mDec), m1);
    this.mSus = f32(S.mSus);
    this.fAtk = Math.max(f32(S.fAtk), m1);
    this.fDec = Math.max(f32(S.fDec), m1);
    this.fSus = f32(S.fSus);
    this.U = S.uniCount;
    for (let k = 0; k < 6; k++) {
      const o = S.ops[k];
      this.en[k] = o.enable ? 1 : 0;
      this.init[k] = o.init;
      this.atk[k] = Math.max(o.atk, m1);
      this.dec[k] = Math.max(o.dec, m1);
      this.sus[k] = o.sus;
      this.velSens[k] = o.velSens;
    }
    this.lfo1P = S.lfo1Phase;
    this.lfo2P = S.lfo2Phase;
  }

  /** Slot 4: note off (release times, release clock starts). */
  noteOff(): void {
    const S = this.synth;
    const r = f32(S.mRel);
    this.mRel = r < 0.01 ? f32(0.01) : r;
    const m1 = f32(0.001);
    this.fRel = Math.max(f32(S.fRel), m1);
    for (let k = 0; k < 6; k++) this.rel[k] = Math.max(S.ops[k].rel, m1);
    this.relT = 0;
  }

  /** Attack / decay rate of a one-pole envelope (FL's 8.82 / (t x sr) form). */
  private rate(t: number): number { return f32(8.82 / f32(this.sr * t)); }
  private atkRate(t: number): number { return f32(8.82 / (t * 39.441975 * this.sr)); }

  /** Slot 6: per-block setup (n = 128). */
  prep(n: number): void {
    const S = this.synth;
    this.glideStep(n);
    const B = this.bank;
    B.k = f32(44100 / this.sr);
    B.t = 0;
    B.dt = f32(1 / n);
    let p = fmaD(S.lfo1Inc, n, this.lfo1P);
    if (!(p < 1)) p += -1;
    this.lfo1P = p;
    this.lfo1V = S.waves[6].lfo(f32(p));
    p = fmaD(S.lfo2Inc, n, this.lfo2P);
    if (!(p < 1)) p += -1;
    this.lfo2P = p;
    this.lfo2V = S.waves[7].lfo(f32(p));
    if (this.trig) {
      let idx = 0;
      for (let k = 0; k < 6; k++) {
        if (!this.en[k]) continue;
        const o = S.ops[k];
        for (let u = 0; u < this.U; u++) B.initOsc(idx++, this.init[k], o.freeRun ? -1 : o.phase);
      }
    }
    let v = this.vel;
    const vs = this.velSm;
    if (vs >= 0) v = f32(fmaD(f32(v - vs), 0.05, vs));
    if (v > -F1E9 && v < F1E9) v = 0;
    this.velSm = v;
    const dt = n * 2.2675736961451248e-05;
    if (this.declick) {
      this.mTgt = 0;
      this.mCoef = f32(C147 / this.sr);
    } else if (this.relT > -1) {
      if (this.relT > this.mRel) { this.kill(0); return; }
      this.mCoef = this.rate(this.mRel);
      this.relT += dt;
      this.mTgt = F1E7;
    } else if (this.time < this.mAtk) {
      this.mTgt = 5;
      this.mCoef = this.atkRate(this.mAtk);
    } else {
      this.mTgt = this.mSus;
      this.mCoef = this.rate(this.mDec);
      if (this.mTgt < F1E7) this.mTgt = F1E7;
    }
    if (this.note < 0) return;
    this.opSetup(n);
    this.filterSetup(n);
    if (this.declick) {
      if (this.nOsc === 0) this.kill(0);
      this.trig = 0;
      this.declick--;
      return;
    }
    this.time += dt;
    if (this.nOsc === 0) this.kill(0);
    this.trig = 0;
  }

  private envState(k: number, out: number[]): void {
    if (this.declick) { out[0] = this.init[k]; out[1] = f32(C147 / this.sr); return; }
    if (this.relT > -1) { out[0] = this.init[k]; out[1] = this.rate(this.rel[k]); return; }
    if (this.time < this.atk[k]) { out[0] = 5; out[1] = this.atkRate(this.atk[k]); return; }
    out[0] = this.sus[k];
    out[1] = this.rate(this.dec[k]);
  }

  /** Oscillator setup of every enabled operator and unison voice (FL 0x6e74). */
  private opSetup(n: number): void {
    const S = this.synth;
    const B = this.bank;
    B.resetRouting();
    const U = this.U;
    const ratio = f32(S.uniDtn / (U * 12) + 1);
    const pw = S.powf(ratio, f32(f32(U - 1) * -0.5));
    this.nOsc = 0;
    const es = [0, 0];
    for (let k = 0; k < 6; k++) {
      if (!this.en[k]) continue;
      this.envState(k, es);
      const target = es[0], coef = es[1];
      const o = S.ops[k];
      const vf = f32(f32(this.velSm + -0.5) * this.velSens[k] + 0.5);
      let d3 = fmaD(this.lfo1V, o.lfo1, 1);
      d3 = fmaD(this.lfo2V, o.lfo2, d3);
      let m = f32(d3 * vf);
      if (!o.enable) m = f32(1e-5);
      let p0: number, p1: number, p2: number;
      if (this.trig) {
        this.h0[k] = 0; this.h1[k] = 0; this.h2[k] = m;
        p0 = 0; p1 = 0; p2 = m;
      } else {
        p2 = this.h3[k];
        p0 = this.h1[k];
        this.h0[k] = p0;
        p1 = this.h2[k];
        this.h1[k] = p1;
        this.h2[k] = p2;
      }
      this.h3[k] = m;
      const gLm = f32(fmaD(-o.pan, o.mix + o.mix, o.mix + o.mix));
      const gRm = f32(o.mix * f32(o.pan + o.pan));
      const c1 = f32(f32(p2 - p0) * 0.5);
      const c3 = f32(f32(m - p0) * 0.5 + f32(p1 - p2) * 1.5);
      const c2 = f32(f32(p0 + c1) - f32(p1 + c3));
      const f0 = this.freq();
      let d0 = f32(o.fine + o.coarse) * 0.08333333333333333;
      d0 = fmaD(S.lfo2Pitch, this.lfo2V, d0);
      d0 = fmaD(S.egfPitch, this.fLvl, d0);
      const d10 = f0 * pw * Math.pow(2, d0);
      const W = S.waves[k];
      const tab = W.tableFor(d10 + o.shiftSm, this.sr);
      this.uniCnt = U;
      this.uniIdx = 0;
      const first = this.nOsc;
      let gl = f32(this.uniGain(false) * gLm);
      let gr = f32(this.uniGain(true) * gRm);
      B.setOsc(first, gl, gr, target, coef, p1, c1, c2, c3, W.tab, tab, n, o.shiftSm + d10, this.sr);
      this.uniCnt = 1;
      this.routes(k, first, 0);
      this.nOsc++;
      let r = ratio;
      for (let u = 1; u < U; u++) {
        this.uniCnt = U;
        this.uniIdx = u;
        gl = f32(this.uniGain(false) * gLm);
        gr = f32(this.uniGain(true) * gRm);
        const fu = fmaD(d10, r, o.shiftSm);
        B.setOsc(this.nOsc, gl, gr, target, coef, p1, c1, c2, c3, W.tab, tab, n, fu, this.sr);
        this.uniIdx = 0; this.uniCnt = 1;
        this.routes(k, this.nOsc, u);
        this.nOsc++;
        r = f32(r * ratio);
      }
    }
    let pad = this.nOsc & 3;
    if (pad !== 0) {
      let i = this.nOsc;
      while (pad < 4) { B.initOsc(i++, 0, 0); pad++; }
    }
  }

  /** FM targets of operator k's unison voice u: operator r gets fm[r] x 2 of k's output (enabled operators only). */
  private routes(k: number, dst: number, u: number): void {
    const S = this.synth;
    const o = S.ops[k];
    let cnt = 0, src = u;
    for (let r = 0; r < 6; r++) {
      if (!this.en[r]) continue;
      const a = o.fm[r];
      if (a > 1e-5) { this.amts[cnt] = f32(a + a); this.srcs[cnt] = src; cnt++; }
      src += this.U;
    }
    if (cnt) this.bank.addRoutes(dst, this.amts, this.srcs, cnt);
  }

  /** Filter envelope, cutoff ramp, resonance and mode mix targets (FL 0x664c). */
  private filterSetup(n: number): void {
    const S = this.synth;
    const res = S.resSm;
    this.egAmt = f32(S.egSm * 65535);
    let d0 = fmaD(this.lfo1V, S.lfoSm, S.cutSm);
    const vt = fmaD(this.velSm, 0.5, -0.5);
    const d9 = fmaD(vt, S.velSmF, d0);
    d0 = fmaD(this.pitch(), 0.01, -0.6);
    d0 = fmaD(d0, S.keySm, d9);
    if (this.declick) {
      this.fTgt = 0;
      this.fCoef = f32(C147 / this.sr);
    } else if (this.relT > -1) {
      this.fTgt = 0;
      this.fCoef = this.rate(this.fRel);
    } else if (this.time < this.fAtk) {
      this.fTgt = 5;
      this.fCoef = this.atkRate(this.fAtk);
    } else {
      this.fTgt = f32(this.fSus + F1E7);
      this.fCoef = this.rate(this.fDec);
    }
    const tp = d0 * 65535;
    if (this.cutPos < 0) this.cutPos = tp;
    this.cutInc = (tp - this.cutPos) / n;
    let r = res > 0 ? res : 0;
    if (r > 1) r = 1;
    this.res = r;
    const T = this.mixT;
    T[0] = 0; T[1] = 0; T[2] = 0; T[3] = 1;
    let a = 0, b = 0, c = 0, d = 1;
    switch (S.filterMode) {
      case 3: T[0] = 1; a = 1; b = 0; c = -1; d = F1E7; T[2] = c; T[3] = d; break;
      case 2: T[1] = 1; a = 0; b = 1; c = -1; d = F1E7; T[2] = c; T[3] = d; break;
      case 1: T[1] = 0; a = 0; b = 0; c = 1; d = F1E7; T[2] = c; T[3] = d; break;
    }
    const M = this.mix;
    if (M[0] < -2) M[0] = a;
    if (M[1] < -2) M[1] = b;
    if (M[2] < -2) M[2] = c;
    if (M[3] < -2) M[3] = d;
  }

  /** Slot 7: render n samples into L / R (added). */
  render(L: Float32Array, R: Float32Array, off: number, n: number): void {
    if (n === 0 || this.note < 0) return;
    const FT = txFilterTable();
    let left = n, pos = off;
    while (left > 0) {
      let m = this.left < left ? this.left : left;
      if (this.left === 128) {
        this.prep(128);
        if (this.note < 0) return;
        m = this.left < left ? this.left : left;
      }
      left -= m;
      this.left -= m;
      if (this.left === 0) this.left = 128;
      const buf = this.buf;
      this.bank.render(buf, buf.subarray(512), 0, m, this.nOsc);
      const fs = this.fs, M = this.mix, T = this.mixT;
      for (let i = 0; i < m; i++) {
        let xl = buf[i], xr = buf[512 + i];
        const g3 = M[3];
        if (g3 < F0999) {
          let d = this.cutPos + f32(this.fLvl * this.egAmt);
          let idx = Math.trunc(d);
          if (!(idx > 0)) idx = 0;
          if (idx > 65535) idx = 65535;
          const A = FT[idx * 3], Bc = FT[idx * 3 + 1], C = FT[idx * 3 + 2];
          const k = f32(C * this.res);
          this.cutPos += this.cutInc;
          // feedback and soft clip (both channels)
          const fbL = f32(fs[7] * k), fbR = f32(fs[15] * k);
          let uL = f32(xl - fbL), uR = f32(xr - fbR);
          let aL = f32(Math.abs(uL) * 0.06666666666666667), aR = f32(Math.abs(uR) * 0.06666666666666667);
          if (aL > 1) aL = 1;
          if (aR > 1) aR = 1;
          const shL = fmaD(4 - (aL + aL), aL, -3) * aL;
          const shR = fmaD(4 - (aR + aR), aR, -3) * aR;
          uL = f32(fmaD(uL, shL, uL));
          uR = f32(fmaD(uR, shR, uR));
          // stage 1..4: y = (x + x_prev) B - y_prev A
          const y1L = f32(f32(f32(fs[0] + uL) * Bc) - fs[4] * A);
          const y1R = f32(f32(f32(fs[8] + uR) * Bc) - fs[12] * A);
          const y2L = f32(f32(f32(y1L + fs[1]) * Bc) - fs[5] * A);
          const y2R = f32(f32(f32(y1R + fs[9]) * Bc) - fs[13] * A);
          const y3L = f32(f32(f32(y2L + fs[2]) * Bc) - fs[6] * A);
          const y3R = f32(f32(f32(y2R + fs[10]) * Bc) - fs[14] * A);
          const y4L = f32(f32(f32(y3L + fs[3]) * Bc) - fs[7] * A);
          const y4R = f32(f32(f32(y3R + fs[11]) * Bc) - fs[15] * A);
          const g0 = M[0], g1 = M[1], g2 = M[2];
          let oL = f32(uL * g0); oL = f32(y3L * g1 + oL); oL = f32(y4L * g2 + oL);
          let oR = f32(uR * g0); oR = f32(y3R * g1 + oR); oR = f32(y4R * g2 + oR);
          fs[0] = uL; fs[1] = y1L; fs[2] = y2L; fs[3] = y3L;
          fs[4] = y1L; fs[5] = y2L; fs[6] = y3L; fs[7] = y4L;
          fs[8] = uR; fs[9] = y1R; fs[10] = y2R; fs[11] = y3R;
          fs[12] = y1R; fs[13] = y2R; fs[14] = y3R; fs[15] = y4R;
          xl = f32(f32(xl - oL) * g3 + oL);
          xr = f32(f32(xr - oR) * g3 + oR);
        }
        // filter envelope
        let fl = f32(f32(this.fTgt - this.fLvl) * this.fCoef + this.fLvl);
        if (fl > 1) fl = 1;
        this.fLvl = fl;
        // mode mix smoothing
        const n0 = f32(f32(T[0] - M[0]) * 0.004999999888241291 + M[0]);
        const n1 = f32(f32(T[1] - M[1]) * 0.004999999888241291 + M[1]);
        const n2 = f32(f32(T[2] - M[2]) * 0.004999999888241291 + M[2]);
        const n3 = f32(f32(T[3] - M[3]) * 0.004999999888241291 + M[3]);
        M[0] = n0 < F1E9 && n0 > -F1E9 ? 0 : n0;
        M[1] = n1 < F1E9 && n1 > -F1E9 ? 0 : n1;
        M[2] = n2 < F1E9 && n2 > -F1E9 ? 0 : n2;
        M[3] = n3;
        // master envelope
        const old = this.mLvl;
        let ml = f32(f32(this.mTgt - old) * this.mCoef + old);
        if (ml > 1) ml = 1;
        this.mLvl = ml;
        L[pos + i] = f32(old * xl + L[pos + i]);
        R[pos + i] = f32(old * xr + R[pos + i]);
      }
      pos += m;
    }
  }
}
