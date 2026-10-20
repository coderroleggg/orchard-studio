// Sawer's effect chain, ported from FL 2026's Sawer engine library (static analysis):
// chorus (IL's three-tape chorus: PoiZone's code, depth law in float here), phaser (six
// first-order all-pass stages per channel in a lattice form, cosine LFO, cube-root
// feedback, smoothed centre / mix, input fade-in), stereo tape delay (PoiZone's code),
// fxReverb (Toxic Biohazard's port: the same IL class), and the silence logic: after
// 2 s of output below 1e-5 every effect is reset once and the chain is skipped until
// sound returns.

import { f32, fma, fms, fmaD, PzChorus, PzDelay } from '../poizone/dsp';
import { cosf } from '../poizone/applemath';
import { TxReverb } from '../toxicbiohazard/reverb';

/** PoiZone's chorus with Sawer's depth law (v^3 in float; PoiZone computes it in double). */
export class SwChorus extends PzChorus {
  override setDepth(v: number): void {
    this.depthP = v;
    const d = f32(f32(v * v) * v);
    this.A?.setDepth(d); this.B?.setDepth(d); this.C?.setDepth(d);
  }
}

/** Sawer's phaser (FL 0x1ed4c). */
export class SwPhaser {
  rate = 0; depth = 0; feedback = 0; mix = 0; center = 0; on = false;
  /** all-pass states: left 6 + output, right 6 + output (FL +0x18 .. +0x4c) */
  readonly st = new Float32Array(14);
  phase = 0;
  centerSm = -1;
  mixSm = -1;
  fade = 0;
  sr = 44100;

  reset(): void {
    this.fade = 0;
    this.st.fill(0);
    this.phase = 0;
    this.centerSm = -1;
    this.mixSm = -1;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (!this.on) return;
    const sr = this.sr;
    const fbc = f32(Math.cbrt(this.feedback));
    const mixT = Math.max(this.mix, f32(1e-5));
    if (this.mixSm < 0) this.mixSm = mixT;
    const cenT = Math.max(f32(this.center * this.center), f32(1e-5));
    if (this.centerSm < 0) this.centerSm = cenT;
    if (n < 1) return;
    const r2 = f32(this.rate * this.rate);
    const rateN = f32((r2 * 44100) / sr);
    const h = 0.5 / sr;
    const lo = f32(h * 100);
    const hi = f32(h * 40000);
    const fb = f32(fbc * 0.98);
    const dep = f32(f32(f32(this.depth * this.depth) * 0.5) * this.depth);
    const inc = rateN * 0.0005;
    const span = f32(hi - lo);
    const s = this.st;
    const M1E6 = f32(-1e-6);
    for (let i = 0; i < n; i++) {
      const g = this.fade;
      const xl = fma(g, L[i], M1E6);
      const xr = fma(R[i], g, M1E6);
      this.fade = f32(fmaD(g, 0.99, 0.01));
      const ph = this.phase;
      const c = cosf(ph);
      let a = fma(c, dep, dep);
      let np = f32(ph + inc);
      const npw = f32(np + f32(-6.2831854820251465));
      const cen = this.centerSm, mixOld = this.mixSm;
      a = f32(a + cen);
      a = fma(a, span, lo);
      if (a > f32(0.499)) a = f32(0.499);
      const cenN = f32(fmaD(f32(cenT - cen), 0.001, cen));
      if (np > 6.2831853) np = npw;
      a = f32(f32(1 - a) / f32(a + 1));
      let s3 = fma(s[6], fb, xl);
      let s5 = fma(s[13], fb, xr);
      this.phase = np;
      this.centerSm = cenN;
      // left / right lattices, FL's instruction order
      let s0 = fms(s3, a, s[0]);
      let s16 = f32(s0 * a);
      let s4 = fms(s5, a, s[7]);
      s3 = f32(s16 + s3);
      let s17 = f32(s4 * a);
      s5 = f32(s17 + s5);
      let s2 = f32(s[1] - s16);
      s16 = f32(s2 * a);
      let s18 = s[8], s19 = s[9];
      s0 = f32(s16 + s0);
      s17 = f32(s18 - s17);
      s18 = f32(s17 * a);
      s4 = f32(s18 + s4);
      s[0] = s3; s[1] = s0;
      s0 = s[2]; s3 = s[3];
      s0 = f32(s0 - s16);
      s16 = f32(s0 * a);
      s18 = f32(s19 - s18);
      s2 = f32(s16 + s2);
      s19 = f32(s18 * a);
      s17 = f32(s19 + s17);
      s[8] = s4; s[9] = s17;
      s3 = f32(s3 - s16);
      s4 = f32(s3 * a);
      s0 = f32(s4 + s0);
      s16 = s[10]; s17 = s[11];
      s16 = f32(s16 - s19);
      s[2] = s2; s[3] = s0;
      s0 = f32(s16 * a);
      s2 = f32(s0 + s18);
      s18 = s[4]; s19 = s[5];
      s4 = f32(s18 - s4);
      s18 = f32(s4 * a);
      s3 = f32(s18 + s3);
      s0 = f32(s17 - s0);
      s17 = f32(s0 * a);
      s16 = f32(s17 + s16);
      s[10] = s2; s[11] = s16;
      s2 = f32(s19 - s18);
      let s7 = f32(s[12] - s17);
      s4 = fma(s2, a, s4);
      s0 = fma(s7, a, s0);
      s[4] = s3; s[5] = s4;
      s[6] = s2; s[7] = s5;
      s[12] = s0; s[13] = s7;
      this.mixSm = fma(f32(mixT - mixOld), f32(0.001), mixOld);
      L[i] = fma(mixOld, s2, L[i]);
      R[i] = fma(mixOld, s7, R[i]);
    }
  }
}

export class SwFx {
  readonly chorus = new SwChorus();
  readonly phaser = new SwPhaser();
  readonly delay = new PzDelay();
  readonly reverb = new TxReverb();
  revOn = false;
  quiet = 0;
  sr = 44100;
  resetDone = false;

  setSampleRate(sr: number): void {
    this.sr = sr;
    this.chorus.setSampleRate(sr);
    this.phaser.sr = sr;
    this.delay.setSampleRate(sr);
    this.reverb.setSampleRate(f32(sr));
    this.reverb.setParam(5, 1);
  }

  reset(): void {
    this.chorus.reset();
    this.phaser.reset();
    this.delay.reset();
    this.reverb.reset();
  }

  setReverbOn(on: boolean): void {
    if (this.revOn === on) return;
    this.revOn = on;
    if (on) this.reverb.reset();
  }

  setTempo(t: number): void { this.delay.setTempo(t); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const lim = Math.trunc(this.sr + this.sr);
    if (this.quiet > lim) {
      if (!this.resetDone) this.reset();
      this.resetDone = true;
    } else if (!this.resetDone) {
      this.chorus.process(L, R, n);
      this.phaser.process(L, R, n);
      this.delay.process(L, R, n);
      if (this.revOn) this.reverb.process(L, R, n);
    }
    const T = f32(1e-5);
    for (let i = 0; i < n; i++) {
      if (Math.abs(L[i]) > T || Math.abs(R[i]) > T) { this.quiet = 0; this.resetDone = false; }
      else this.quiet++;
    }
  }
}
