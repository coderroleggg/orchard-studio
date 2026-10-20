// Toxic Biohazard effect slot, ported from FL 2026's Toxic Biohazard: one of
// six effects (0 delay, 1 chorus, 2 reverb, 3 flanger, 4 phaser, 5 lo-fi),
// switched at the next block; the input fades in (0.995 / 0.005 one-pole) after
// every reset, disabling fades the wet part out (x 0.995 per sample) and resets
// the effect below 1e-5. Delay, chorus and flanger run on IL's CTapeDelay (the
// tape PoiZone's delay / chorus use): the delay is three cascaded tapes per
// side (2 s, 63 % / 41 % or 76 % / 54 % long, feedback -0.99 v, "blur" wets),
// tempo-synced times optional; the chorus three modulated tapes on the mono
// sum (22 / 17.08 / 20 ms, rates x 0.896 / 1 / 0.689, wet -v^2); the flanger
// one 12 ms tape per side (rates x 1 / 1.1). The phaser is six first-order
// allpasses per side with feedback (cbrt), a cosine LFO and smoothed
// frequency / mix; the lo-fi a sample-and-hold quantizer through a 2-pole
// low-pass, added to the input.

import { f32, fmaD, PzTape, PzCut } from '../poizone/dsp';
import { cosf } from '../poizone/applemath';
import { TxReverb } from './reverb';

const F995 = 0.9950000001117587;
const F005 = 0.004999999888241291;
const G995 = f32(0.995);
const Q5 = f32(1e-5);
const SYNC = [1, 0.06666666666666667, 0.03333333333333333, 0.022222222222222223, 0.016666666666666666,
  0.008333333333333333, 0.005555555555555556, 0.004166666666666667, 0.0020833333333333333, 0.0010416666666666667];

export class TxSlot {
  pending = 0;
  type = -1;
  bypass = true;
  active = false;
  sr = 0;
  readonly tapes: (PzTape | null)[] = [null, null, null, null, null, null];
  readonly rev = new TxReverb();
  readonly fl = new PzCut(false);
  readonly fr = new PzCut(false);
  // parameters (FL: slot +0x4c..+0xbc)
  flDelay = 0; flFb = 0; flMix = 0; flDepth = 0; flRate = 0; flInvMix = 0; flInvFb = 0;
  chDepth = 0; chRate = 0; chMix = 0;
  dlTime = 0; dlSync = 0; dlFb = 0; dlRate = 0; dlDepth = 0; dlBlur = 0; dlMix = 0;
  rvMix = 0; rvDecay = 0; rvDamp = 0; rvHiCut = 0;
  lfBits = 0; lfSmp = 0; lfFlt = 0;
  phRate = 0; phDepth = 0; phFb = 0; phMix = 0; phFreq = 0;
  // state
  hold = 0; heldL = 0; heldR = 0;
  readonly ap = new Float32Array(14);
  phPhase = 0; phFreqSm = -1; phMixSm = -1;
  fadeIn = 0; wetG = 0;

  constructor() {
    this.fl.f = 100; this.fl.q = 1; this.fl.sr = 44100;
    this.fr.f = 100; this.fr.q = 1; this.fr.sr = 44100;
  }

  setType(t: number): void { this.pending = t; }

  setBypass(b: boolean): void {
    if (this.bypass === b) return;
    if (!b) this.wetG = 1;
    this.bypass = b;
  }

  setParam(id: number, v: number): void {
    if (!(v >= 0)) v = 0;
    const p = id >= 304 ? 304 : 238 + ((id - 238) & ~1);
    switch (p) {
      case 238: this.flDelay = v; break;
      case 240: this.flFb = v; break;
      case 242: this.flDepth = v; break;
      case 244: this.flRate = v; break;
      case 246: this.flMix = v; break;
      case 248: this.flInvFb = v; break;
      case 250: this.flInvMix = v; break;
      case 252: this.chDepth = v; break;
      case 254: this.chRate = v; break;
      case 256: this.chMix = v; break;
      case 258: this.rvMix = Math.min(v, 1); break;
      case 260: this.rvDecay = Math.min(v, 1); break;
      case 262: this.rvDamp = v; break;
      case 264: this.rvHiCut = v; break;
      case 266: this.dlTime = v; break;
      case 268: this.dlFb = v; break;
      case 270: this.dlRate = v; break;
      case 272: this.dlDepth = v; break;
      case 274: this.dlBlur = v; break;
      case 276: this.dlMix = v; break;
      case 278: this.lfBits = v; break;
      case 280: this.lfSmp = v; break;
      case 282: this.lfFlt = v; break;
      case 284: this.phFreq = v; break;
      case 286: this.phRate = v; break;
      case 288: this.phDepth = v; break;
      case 290: this.phFb = v; break;
      case 292: this.phMix = v; break;
      case 304: this.dlSync = v; break;
    }
    this.update();
  }

  setSampleRate(sr: number): void {
    if (this.sr === sr) return;
    this.sr = sr;
    this.rev.setSampleRate(f32(sr));
    const t = this.type;
    this.type = -1;
    this.applyType(t);
  }

  private applyType(t: number): void {
    if (t < 0 || t > 5 || this.type === t) return;
    this.type = t;
    this.tapes.fill(null);
    this.active = false;
    const sr = this.sr;
    const T = (init: number, len: number): PzTape => new PzTape(init, len);
    if (t === 3) {
      const len = Math.max(0, Math.trunc(sr * 0.012));
      this.tapes[0] = T(0, len); this.tapes[1] = T(0, len);
      this.active = true;
    }
    if (t === 1) {
      const d8 = sr * 0.02, d9 = Math.trunc(d8);
      this.tapes[0] = T(0, Math.round(d9 * 1.1));
      this.tapes[1] = T(0.467, Math.round(d9 * 0.854));
      this.tapes[2] = T(0.778, Math.trunc(d8));
      this.active = true;
    }
    if (t === 0) {
      const d8 = sr + sr, len = Math.trunc(d8), d = Math.trunc(d8);
      this.tapes[0] = T(0, len);
      this.tapes[1] = T(0.27, Math.round(d * 0.63));
      this.tapes[2] = T(0.4, Math.round(d * 0.41));
      this.tapes[3] = T(0.3, len);
      this.tapes[4] = T(0.62, Math.round(d * 0.76));
      this.tapes[5] = T(0.87, Math.round(d * 0.54));
      this.active = true;
    }
    if (t === 2 || t === 4 || t === 5) this.active = true;
    this.reset();
    this.update();
  }

  reset(): void {
    this.fadeIn = 0;
    this.wetG = this.bypass ? 0 : 1;
    if (!this.active) return;
    for (const tp of this.tapes) if (tp) tp.reset();
    this.ap.fill(0);
    this.rev.reset();
    this.fl.reset(); this.fr.reset();
    this.hold = 0;
    this.phPhase = 0; this.phFreqSm = -1; this.phMixSm = -1;
  }

  /** Derived values of the current effect (FL 0x32bc8). */
  private update(): void {
    if (!this.active) return;
    const tp = this.tapes, sr = this.sr;
    switch (this.type) {
      case 3: {
        const a = tp[0]!, b = tp[1]!;
        const d = f32(this.flDelay * this.flDelay);
        a.setTime(d); b.setTime(d);
        const fb0 = f32(this.flFb * 0.99);
        const fb = fb0 < f32(1e-4) ? 0 : this.flInvFb !== 0 ? -fb0 : fb0;
        a.setFeedback(fb); b.setFeedback(fb);
        const r = f32(f32(this.flRate * this.flRate) * 10);
        a.setLfoRate(r, sr); b.setLfoRate(r * 1.1, sr);
        const dp = f32(this.flDepth * this.flDepth);
        a.setDepth(dp); b.setDepth(dp);
        const m = this.flMix;
        const w = m < 0.0001 ? f32(1e-4) : this.flInvMix !== 0 ? -m : m;
        a.setWet(w); b.setWet(w);
        break;
      }
      case 1: {
        const r = f32(fmaD(this.chRate, 5, 0.1));
        tp[0]!.setLfoRate(r * 0.896, sr);
        tp[1]!.setLfoRate(r, sr);
        tp[2]!.setLfoRate(r * 0.689, sr);
        const w = f32(this.chMix * -this.chMix);
        for (let k = 0; k < 3; k++) tp[k]!.setWet(w);
        const dp = f32(f32(this.chDepth * this.chDepth) * this.chDepth);
        for (let k = 0; k < 3; k++) tp[k]!.setDepth(dp);
        break;
      }
      case 0: {
        const rate = f32(f32(this.dlRate * this.dlRate) * 20);
        const dp = f32(f32(this.dlDepth * this.dlDepth) * f32(this.dlDepth * this.dlDepth));
        const time = f32(f32(this.dlTime * this.dlTime) + 0.01);
        const fb = this.dlFb * -0.99;
        for (let k = 0; k < 6; k++) {
          const t = tp[k]!;
          t.setLfoRate(k & 1 ? rate * 1.1 : rate, sr);
          t.setTime(time);
          t.setFeedback(fb);
          t.setDepth(dp);
        }
        const m2 = f32(this.dlMix * this.dlMix);
        const mb = f32(m2 * this.dlBlur);
        const bm = f32(this.dlBlur * this.dlMix);
        const bm2 = f32(bm * bm);
        tp[0]!.setWet(m2); tp[1]!.setWet(mb); tp[2]!.setWet(bm2);
        tp[3]!.setWet(m2); tp[4]!.setWet(mb); tp[5]!.setWet(bm2);
        break;
      }
      case 2: {
        const R = this.rev;
        R.setParam(9, f32(Math.abs(1 - this.rvDamp)));
        R.setParam(8, f32(f32(f32(this.rvDecay * this.rvDecay) * this.rvDecay) * 0.6));
        R.setParam(12, f32(f32(this.rvMix * f32(0.999)) + 0.001));
        R.setParam(2, f32(f32(this.rvHiCut * this.rvHiCut) * this.rvHiCut));
        R.setParam(5, 1);
        break;
      }
      case 5: {
        let f = f32(Math.pow(2, this.lfFlt * 9.3) * 30);
        const lim = sr * 0.47619047619047616;
        if (lim < f) f = f32(lim);
        this.fl.set(f, 1, f32(sr));
        this.fr.set(f, 1, f32(sr));
        break;
      }
    }
  }

  process(L: Float32Array, R: Float32Array, n: number, tempo: number): void {
    if (this.pending >= 0) this.applyType(this.pending);
    this.pending = -1;
    if (!this.active) return;
    if (this.bypass) {
      if (this.wetG === 0) return;
      if (this.wetG < Q5) { this.reset(); return; }
    }
    const tp = this.tapes;
    if (this.type === 0) {
      const s = Math.trunc(this.dlSync);
      if (s !== 0) {
        const k = s >= 1 && s <= 9 ? tempo * SYNC[s] : 1;
        const t = f32(0.5 / k);
        for (let i = 0; i < 6; i++) tp[i]!.setTime(t);
      }
    }
    switch (this.type) {
      case 0: {
        for (let i = 0; i < n; i++) {
          const g0 = this.fadeIn;
          let x = L[i];
          x = f32(tp[0]!.process(f32(g0 * x)) * this.wetG + x);
          x = f32(tp[1]!.process(f32(g0 * x)) * this.wetG + x);
          L[i] = f32(tp[2]!.process(f32(g0 * x)) * this.wetG + x);
          x = R[i];
          x = f32(tp[3]!.process(f32(g0 * x)) * this.wetG + x);
          x = f32(tp[4]!.process(f32(g0 * x)) * this.wetG + x);
          R[i] = f32(tp[5]!.process(f32(g0 * x)) * this.wetG + x);
          this.fadeIn = f32(fmaD(g0, F995, F005));
          if (this.bypass) this.wetG = f32(this.wetG * G995);
        }
        break;
      }
      case 1: {
        for (let i = 0; i < n; i++) {
          const g0 = this.fadeIn;
          const x = f32(f32(R[i] + L[i]) * g0);
          this.fadeIn = f32(fmaD(g0, F995, F005));
          const y1 = tp[0]!.process(x), y3 = tp[2]!.process(x), y2 = tp[1]!.process(x);
          L[i] = f32(this.wetG * f32(y2 + y1) + L[i]);
          R[i] = f32(this.wetG * f32(y2 + y3) + R[i]);
          if (this.bypass) this.wetG = f32(this.wetG * G995);
        }
        break;
      }
      case 2: {
        if (!this.bypass) this.wetG = f32(5e-6);
        this.fadeIn = 1;
        this.rev.process(L, R, n);
        break;
      }
      case 3: {
        for (let i = 0; i < n; i++) {
          const g0 = this.fadeIn;
          L[i] = f32(this.wetG * tp[0]!.process(f32(g0 * L[i])) + L[i]);
          R[i] = f32(this.wetG * tp[1]!.process(f32(this.fadeIn * R[i])) + R[i]);
          this.fadeIn = f32(fmaD(g0, F995, F005));
          if (this.bypass) this.wetG = f32(this.wetG * G995);
        }
        break;
      }
      case 4: this.phaser(L, R, n); break;
      case 5: {
        if (!this.bypass) this.wetG = f32(5e-6);
        this.fadeIn = 1;
        for (let i = 0; i < n; i++) {
          let hl: number, hr: number;
          if (this.hold === 0) {
            const b2 = f32(this.lfBits * this.lfBits);
            const q = Math.trunc(f32(f32(b2 * b2) * 1024 + 4));
            hl = f32(Math.trunc(f32(L[i] * q)) / q);
            hr = f32(Math.trunc(f32(R[i] * q)) / q);
            this.heldL = hl; this.heldR = hr;
          } else { hl = this.heldL; hr = this.heldR; }
          const lim = Math.trunc(f32(this.lfSmp * 40));
          this.hold = this.hold >= lim ? 0 : this.hold + 1;
          const yl = this.fl.process(hl);
          const yr = this.fr.process(this.heldR);
          void hr;
          L[i] = f32(L[i] + yl);
          R[i] = f32(R[i] + yr);
        }
        break;
      }
    }
  }

  private phaser(L: Float32Array, R: Float32Array, n: number): void {
    const sr = this.sr;
    const fb = f32(Math.cbrt(this.phFb));
    let fT = f32(this.phFreq * this.phFreq), mT = this.phMix;
    if (!(fT >= Q5)) fT = Q5;
    if (!(mT >= Q5)) mT = Q5;
    if (this.phMixSm < 0) this.phMixSm = mT;
    if (this.phFreqSm < 0) this.phFreqSm = fT;
    const r2 = f32(this.phRate * this.phRate);
    const h = 0.5 / sr;
    const fmin = f32(h * 100), fmax = f32(h * 40000);
    const fbk = f32(fb * 0.98);
    const inc = f32((r2 * 44100) / sr) * 0.0005;
    const d3 = f32(f32(f32(this.phDepth * this.phDepth) * 0.5) * this.phDepth);
    const span = f32(fmax - fmin);
    const z = this.ap;
    const N1 = f32(-9.999999974752427e-7);
    const TWO_PI_F = f32(-6.2831854820251465);
    for (let i = 0; i < n; i++) {
      const g0 = this.fadeIn;
      const xl = f32(g0 * L[i] + N1);
      const xr = f32(R[i] * g0 + N1);
      this.fadeIn = f32(fmaD(g0, F995, F005));
      const ph = this.phPhase;
      const c = cosf(ph);
      const lfo = f32(c * d3 + d3);
      let np = f32(ph + inc);
      if (np > 6.2831853) np = f32(np + TWO_PI_F);
      this.phPhase = np;
      let inL = f32(z[6] * fbk + xl);
      let inR = f32(z[13] * fbk + xr);
      const fsm = this.phFreqSm, msm = this.phMixSm;
      let f = f32(f32(lfo + fsm) * span + fmin);
      if (f > f32(0.499)) f = f32(0.499);
      const a = f32(f32(1 - f) / f32(f + 1));
      // L chain: z[0..5], feedback z[6]; R chain z[7..12], feedback z[13]
      const tL1 = f32(z[0] - inL * a), pL1 = f32(tL1 * a); z[0] = f32(pL1 + inL);
      const tR1 = f32(z[7] - inR * a), pR1 = f32(tR1 * a); z[7] = f32(pR1 + inR);
      const tL2 = f32(z[1] - pL1), pL2 = f32(tL2 * a); z[1] = f32(pL2 + tL1);
      const tR2 = f32(z[8] - pR1), pR2 = f32(tR2 * a); z[8] = f32(pR2 + tR1);
      const tL3 = f32(z[2] - pL2), pL3 = f32(tL3 * a); z[2] = f32(pL3 + tL2);
      const tR3 = f32(z[9] - pR2), pR3 = f32(tR3 * a); z[9] = f32(pR3 + tR2);
      const tL4 = f32(z[3] - pL3), pL4 = f32(tL4 * a); z[3] = f32(pL4 + tL3);
      const tR4 = f32(z[10] - pR3), pR4 = f32(tR4 * a); z[10] = f32(pR4 + tR3);
      const tL5 = f32(z[4] - pL4), pL5 = f32(tL5 * a); z[4] = f32(pL5 + tL4);
      const tR5 = f32(z[11] - pR4), pR5 = f32(tR5 * a); z[11] = f32(pR5 + tR4);
      const tL6 = f32(z[5] - pL5); z[5] = f32(tL6 * a + tL5);
      const tR6 = f32(z[12] - pR5); z[12] = f32(tR6 * a + tR5);
      z[6] = tL6; z[13] = tR6;
      inL = 0; inR = 0;
      this.phFreqSm = f32(fmaD(f32(fT - fsm), 0.001, fsm));
      this.phMixSm = f32(fmaD(f32(mT - msm), 0.001, msm));
      L[i] = f32(f32(tL6 * msm) * this.wetG + L[i]);
      R[i] = f32(f32(tR6 * msm) * this.wetG + R[i]);
      if (this.bypass) this.wetG = f32(this.wetG * G995);
    }
  }
}
