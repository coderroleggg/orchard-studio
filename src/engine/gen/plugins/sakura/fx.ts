// Sakura's effect section ("Resonance" + "Acoustics"), ported from FL 2026's Sakura engine
// library (static analysis of the arm64 code; Sakura renders silence in FL's test host because of
// FL's licence check, so none of this could be compared with FL's output). The container (FL:
// 0x3f024..0x3f4f8) runs, per host block: two 32 Hz high-pass filters (one per side), the
// 8-resonator bank, the three-tape chorus (IL's CChorus: PoiZone's code), the plate reverb
// (IL's fxReverb, the class of Toxic Biohazard / Sawer) when on, and the delay when on (six
// CTapeDelay tapes: three in series per side).

import { f32, fmaD, dn, PzChorus, PzCut, PzTape } from '../poizone/dsp';
import { powf } from '../poizone/applemath';
import { TxReverb } from '../toxicbiohazard/reverb';

/** IL's chorus with the depth law in float (v^3), as the Sawer engine's. */
export class SkChorus extends PzChorus {
  override setDepth(v: number): void {
    this.depthP = v;
    const d = f32(f32(v * v) * v);
    this.A?.setDepth(d); this.B?.setDepth(d); this.C?.setDepth(d);
  }
}

/** One tape buffer of a string delay: values and positions with 10 entries of history in front. */
class SdBuf {
  readonly v: Float32Array;
  readonly p: Float64Array;
  count = 0;
  read = 0;
  constructor(n: number) { this.v = new Float32Array(n + 10); this.p = new Float64Array(n + 10); }
  clear(): void { this.v.fill(0); this.p.fill(0); this.count = 0; this.read = 0; }
}

/**
 * CStringDelay (FL 0xb214 ..): a variable-rate delay ("tape") like CTapeDelay without LFO and
 * filters: the read head plays the tape one length behind (linear interpolation), the speed
 * follows the resonator's frequency law, the output is smoothed by a one-pole (a = 0.5) and
 * fed back with the gain `g`.
 */
export class SkSd {
  readonly len: number;
  private wr: SdBuf;
  private rd: SdBuf;
  pos = 0;
  speed: number;
  readonly minSpeed: number;
  /** smoothed output (FL +0xc) */
  z = 0;
  /** smoothing factor (FL +8) and feedback gain (FL +0x14) */
  a = 0;
  g = 0;

  constructor(length: number) {
    const len = Math.max(length, 4);
    this.len = len;
    this.wr = new SdBuf(len + 256);
    this.rd = new SdBuf(len + 256);
    this.minSpeed = 1 / len;
    this.speed = Math.max(Math.min(1 / ((this.minSpeed + 0.5) * len), 0.2), this.minSpeed);
  }

  reset(): void {
    this.z = 0;
    this.pos = 0;
    this.wr.clear();
    this.rd.clear();
  }

  /** FL 0xaab8 (inlined in the bank's loop): speed from the coefficient t (0 .. 0.99). */
  setSpeed(t: number): void {
    const d2 = 2 / this.len;
    let s = Math.min(1 / ((fmaD(-d2, t, t) + d2) * this.len), 0.2);
    if (s < this.minSpeed) s = this.minSpeed;
    this.speed = s;
  }

  /** The sample one tape length behind (before the flush of tiny values). */
  read(): number {
    const rd = this.rd;
    if (rd.count === 0 || rd.read > rd.count) return 0;
    const target = this.pos;
    let i = rd.read;
    for (;;) {
      if (!(target > rd.p[i + 10])) {
        const v1 = rd.v[i + 10];
        const p1 = f32(rd.p[i + 10]);
        const v0 = rd.v[i + 9];
        const p0 = f32(rd.p[i + 9]);
        let fr = 0;
        if (p0 < p1) fr = (target - p0) / f32(p1 - p0);
        return f32(fmaD(fr, f32(v1 - v0), v0));
      }
      i++;
      rd.read = i;
      if (i - 1 === rd.count) return 0;
    }
  }

  /** Advance the tape by one sample and record the value `w`. */
  write(w: number): void {
    let pos = this.pos + this.speed;
    this.pos = pos;
    let wr = this.wr;
    if (pos >= 1) {
      const r = this.rd;
      const c = r.count;
      wr.v[9] = r.v[c + 9]; wr.p[9] = r.p[c + 9] - 1;
      wr.v[8] = r.v[c + 8]; wr.p[8] = r.p[c + 8] - 1;
      wr.v[7] = r.v[c + 7]; wr.p[7] = r.p[c + 7] - 1;
      wr.v[wr.count + 10] = w;
      wr.p[wr.count + 10] = pos;
      wr.read = 0;
      pos -= 1;
      this.pos = pos;
      this.wr = r;
      this.rd = wr;
      wr = r;
      wr.count = 0;
    }
    wr.v[wr.count + 10] = w;
    wr.p[wr.count + 10] = pos;
    wr.count++;
  }
}

/** The 8-resonator bank (FL 0xa370 ..): two string delays per resonator, mono input, stereo output. */
export class SkRes {
  /** frequency coefficients 1 - v^0.1 (FL +0), feedback gains (FL +0x20), on flags (FL +0x40) */
  readonly coef = new Float32Array(8);
  readonly fb = new Float32Array(8);
  readonly on = new Float32Array(8);
  private readonly A: (SkSd | null)[] = new Array(8).fill(null);
  private readonly B: (SkSd | null)[] = new Array(8).fill(null);
  private readonly hpL = new PzCut(true);
  private readonly hpR = new PzCut(true);

  setSampleRate(sr: number): void {
    const len = Math.trunc(sr * 0.1);
    for (let i = 0; i < 8; i++) {
      this.A[i] = new SkSd(len);
      this.B[i] = new SkSd(len);
    }
    this.hpL.set(32, 1, f32(sr));
    this.hpR.set(32, 1, f32(sr));
  }

  setFreq(i: number, v: number): void { this.coef[i] = f32(1 - powf(v, f32(0.1))); }
  setFeedback(i: number, v: number): void { this.fb[i] = f32(f32(Math.sqrt(v)) * 0.9999); }
  setOn(i: number, v: number): void {
    this.on[i] = v !== 0 ? 1 : v;
    if (v !== 0) { this.A[i]?.reset(); this.B[i]?.reset(); }
  }

  reset(): void {
    for (let i = 0; i < 8; i++) { this.A[i]?.reset(); this.B[i]?.reset(); }
    this.hpL.reset();
    this.hpR.reset();
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      const s = f32(R[i] + L[i]);
      const xin = dn(s);
      let accL = 0, accR = 0;
      for (let r = 0; r < 8; r++) {
        if (this.on[r] === 0) continue;
        const a = this.A[r], b = this.B[r];
        if (!a || !b) continue;
        const t = this.coef[r];
        a.setSpeed(Math.max(Math.min(t, 0.99), 0));
        b.setSpeed(Math.max(Math.min(t * 1.05, 0.99), 0));
        a.g = this.fb[r]; b.g = this.fb[r];
        a.a = 0.5; b.a = 0.5;
        // first string delay: input = the mono sum
        const oa = dn(a.read());
        const za = f32(f32(oa - a.z) * a.a + a.z);
        a.z = za;
        const wa = f32(za * a.g + xin);
        a.write(wa);
        // second string delay: input = minus the first one's output
        const ob = dn(b.read());
        const zb = f32(f32(ob - b.z) * b.a + b.z);
        b.z = zb;
        const wb = f32(zb * b.g + (oa < 9.999999717180685e-10 && oa > -9.999999717180685e-10 ? 0 : -oa));
        b.write(wb);
        // stereo placement: odd resonators 1.25 / 0.75, even 0.75 / 1.25
        const odd = r & 1;
        accL = f32(fmaD(0.75 + 0.5 * odd, ob, accL));
        accR = f32(fmaD(0.75 + 0.5 * (odd === 0 ? 1 : 0), ob, accR));
      }
      L[i] = f32(L[i] + this.hpL.process(accL));
      R[i] = f32(R[i] + this.hpR.process(accR));
    }
  }
}

/** Delay-time sync factors per sync index (tempo x factor; FL 0x3f8cc). */
const SYNC = [0, 0.06666666666666667, 0.03333333333333333, 0.022222222222222223, 0.016666666666666666,
  0.008333333333333333, 0.005555555555555556, 0.004166666666666667, 0.0020833333333333333, 0.0010416666666666667];

/** Sakura's effect container (FL 0x3f024). */
export class SkFx {
  sr = 0;
  tempo = 120;
  readonly hpL = new PzCut(true);
  readonly hpR = new PzCut(true);
  readonly res = new SkRes();
  readonly chorus = new SkChorus();
  readonly reverb = new TxReverb();
  private tapes: PzTape[] = [];
  delayOn = false;
  reverbOn = false;
  /** delay parameters as stored by the engine (floats): time, feedback, mod speed, mod depth, blur, wet, sync */
  dTime = 0; dFb = 0; dSpeed = 0; dDepth = 0; dBlur = 0; dWet = 0; dSync = 0;

  /** FL 0x3f1a4. */
  setSampleRate(sr: number): void {
    this.sr = sr;
    this.chorus.setSampleRate(sr);
    this.reverb.setSampleRate(f32(sr));
    this.reverb.setParam(9, 1);
    this.reverb.setParam(5, 1);
    this.res.setSampleRate(sr);
    const len = Math.trunc(sr + sr);
    this.tapes = [
      new PzTape(0, len),
      new PzTape(0.27, Math.trunc(0.63 * len)),
      new PzTape(0.4, Math.trunc(0.41 * len)),
      new PzTape(0.3, len),
      new PzTape(0.62, Math.trunc(0.76 * len)),
      new PzTape(0.87, Math.trunc(0.54 * len)),
    ];
    this.hpL.set(32, 1, f32(sr));
    this.hpR.set(32, 1, f32(sr));
  }

  /** FL 0x3f45c: flush. */
  reset(): void {
    this.hpL.reset();
    this.hpR.reset();
    this.chorus.reset();
    this.reverb.reset();
    this.res.reset();
    for (const t of this.tapes) t.reset();
  }

  /** The delay: three tapes in series per side (each adds its output to the running sum). */
  private delay(L: Float32Array, R: Float32Array, n: number): void {
    const t = this.tapes;
    if (t.length < 6) return;
    const sp = this.dSpeed, dp = this.dDepth, ti = this.dTime, fb = this.dFb, bl = this.dBlur, wt = this.dWet;
    const r0 = f32(f32(sp * sp) * 20);
    const m4 = r0;
    const m5 = m4 * 1.1000000000000001;
    const m6 = f32(f32(ti * ti) + 0.01);
    const d2 = f32(dp * dp);
    const m7 = f32(d2 * d2);
    const sr = this.sr;
    const fbv = f32(fb * fb) * -0.98999999999999999;
    const rates = [m4, m5, m4, m5, m4, m5];
    for (let k = 0; k < 6; k++) {
      t[k].setLfoRate(rates[k], sr);
      t[k].setTime(m6);
      t[k].setFeedback(fbv);
      t[k].setDepth(m7);
    }
    const w2 = f32(wt * wt);
    t[0].setWet(w2);
    t[1].setWet(f32(w2 * bl));
    const bw = f32(bl * wt);
    t[2].setWet(f32(bw * bw));
    t[3].setWet(w2);
    t[4].setWet(f32(w2 * bl));
    t[5].setWet(f32(bw * bw));
    const sy = Math.trunc(this.dSync);
    if (sy !== 0) {
      // FL: 0.5 / (tempo x factor) for 1..9, 0.5 / 1 for any other non-zero index
      const m3 = f32(0.5 / (sy >= 1 && sy <= 9 ? this.tempo * SYNC[sy] : 1));
      for (let k = 0; k < 6; k++) t[k].setTime(m3);
    }
    for (let i = 0; i < n; i++) {
      const xl = L[i];
      const m3 = f32(t[0].process(xl) + xl);
      const m5l = f32(t[1].process(m3) + m3);
      L[i] = f32(t[2].process(m5l) + m5l);
      const xr = R[i];
      const n3 = f32(t[3].process(xr) + xr);
      const n5 = f32(t[4].process(n3) + n3);
      R[i] = f32(t[5].process(n5) + n5);
    }
  }

  /** FL 0x3f4f8: the whole chain in place. */
  process(L: Float32Array, R: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      L[i] = this.hpL.process(L[i]);
      R[i] = this.hpR.process(R[i]);
    }
    this.res.process(L, R, n);
    this.chorus.process(L, R, n);
    if (this.reverbOn) this.reverb.process(L, R, n);
    if (this.delayOn) this.delay(L, R, n);
  }
}
