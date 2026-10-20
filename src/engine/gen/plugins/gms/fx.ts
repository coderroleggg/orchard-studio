// GMS's performance effects (FL 2026 GMS_x64, FXControl: ctor 0x6f94, setSampleRate 0x7380,
// process 0x7828), one object per effect, processed in the order 0..9: Distortion, Crusher,
// Flanger, Phaser, Low Pass, Hi Pass, Delay, Reverb, Panner, Trancer. Each has X / Y (0..1),
// an LFO (rate in beats or bars, amount -1..1 squared, shape sine / triangle / saw / square,
// phase locked to the song position while the host plays) and a bypass flag; most fade their
// wet part in / out (one-pole 0.01 per sample) and keep running until it is below 1e-4. The
// last object also holds the post-effects EQ (five RBJ bands at 80 / 220 / 1200 / 6000 /
// 12000 Hz, low shelf, three peaks, high shelf, +-12 dB) when it is enabled.

import { f32, fmaD, PzCut, PzShelf } from '../poizone/dsp';
import { exp2f } from '../poizone/applemath';
import { TxReverb } from '../toxicbiohazard/reverb';
import { GmsTape } from './tape';

const T4 = f32(9.999999747378752e-05);
const F01 = f32(0.009999999776482582);
const TWO_PI = 6.283185307179586;
const EQ_F = [80, 220, 1200, 6000, 12000];
const EQ_BW = [1, 2.5, f32(2.799999952316284), 2.5, 2];

export class GmsFx {
  readonly type: number;
  active = false;
  sr = 44100;
  x = 0;
  y = 0;
  /** LFO rate in beats (FL +0x14), period in seconds (+0x18), amount (+0x1c), shape (+0x20) */
  rate = 0;
  period = 0;
  lfoAmt = 0;
  lfoShape = 0;
  bypass = false;
  /** LFO phase (double, +0x28) and increment per sample (+0x30) */
  phase = 0;
  inc = 0;
  wet = 0;
  tail = 0;
  // effect state
  readonly lp: PzCut[] = [];
  readonly hp: PzCut[] = [];
  tapes: GmsTape[] = [];
  reverb: TxReverb | null = null;
  crushCount = 0;
  crushL = 0;
  crushR = 0;
  tranceG = 0;
  readonly ph = new Float32Array(14);
  phCenter = -1;
  // EQ (enabled on the last object)
  eqOn = false;
  readonly eqGain = new Float32Array(5).fill(0.5);
  readonly eqDirty = new Uint8Array(5).fill(1);
  readonly eqL: PzShelf[] = [];
  readonly eqR: PzShelf[] = [];

  constructor(type: number) {
    this.type = type;
    for (let k = 0; k < 8; k++) { this.lp.push(new PzCut(false)); this.hp.push(new PzCut(true)); }
    for (let b = 0; b < 5; b++) {
      for (const arr of [this.eqL, this.eqR]) {
        const s = new PzShelf();
        s.type = b === 0 ? 0 : b === 4 ? 2 : 1;
        s.freq = EQ_F[b]; s.bw = EQ_BW[b]; s.gain = 0; s.dirty = true;
        arr.push(s);
      }
    }
  }

  setX(v: number): void { this.x = Math.min(Math.max(v, 0), 1); }
  setY(v: number): void { this.y = Math.min(Math.max(v, 0), 1); }
  setRate(v: number): void { this.rate = Math.max(v, 0); }

  /** FL 0x7380 (and 0x71ec): sample rate, delay lines / reverb sized for it, states cleared. */
  setSampleRate(sr: number): void {
    if (sr !== 0 && sr !== this.sr) {
      this.sr = sr;
      this.tapes = [];
      this.reverb = null;
    }
    const t = this.type;
    if (this.tapes.length === 0) {
      if (t === 2) for (let k = 0; k < 6; k++) this.tapes.push(new GmsTape(Math.trunc(this.sr * 0.002)));
      else if (t === 8) for (let k = 0; k < 2; k++) this.tapes.push(new GmsTape(Math.trunc(this.sr * 0.002)));
      else if (t === 6) for (let k = 0; k < 2; k++) this.tapes.push(new GmsTape(Math.trunc(this.sr * 1.5)));
    }
    if (t === 7 && !this.reverb) { this.reverb = new TxReverb(); this.reverb.setSampleRate(f32(this.sr)); }
    for (const tp of this.tapes) tp.reset();
    for (const c of this.lp) c.reset();
    for (const c of this.hp) c.reset();
    this.ph.fill(0);
    this.phCenter = -1;
    if (this.reverb) this.reverb.reset();
    this.crushCount = 0; this.crushL = 0; this.crushR = 0; this.tranceG = 0;
    for (let b = 0; b < 5; b++) {
      for (const arr of [this.eqL, this.eqR]) { arr[b].reset(); arr[b].dirty = true; }
      this.eqDirty[b] = 1;
    }
    this.phase = 0;
    this.wet = 0;
    this.tail = 0;
    this.active = false;
  }

  /** The block's LFO value (FL 0x945c): sampled once, the phase advanced by n increments. */
  private blockLfo(n: number): number {
    const p = this.phase, inc = this.inc;
    let v: number, np: number;
    if (this.lfoShape === 0) {
      v = f32(this.lfoAmt * f32(Math.sin(p * TWO_PI)));
      np = inc + p; np -= Math.trunc(np);
    } else {
      np = p + inc; np -= Math.trunc(np);
      const q = f32(np);
      if (this.lfoShape === 2) v = f32(this.lfoAmt * q);
      else if (this.lfoShape === 1) { const d = f32(q + q); v = f32((d > 1 ? f32(2 - d) : d) * this.lfoAmt); }
      else v = q > 0.5 ? this.lfoAmt : 0;
    }
    const d = inc * (n - 1) + np;
    this.phase = d - Math.trunc(d);
    return v;
  }

  /** The per-sample LFO of the flanger / phaser / panner. */
  private sampleLfo(): number {
    const p = this.phase;
    if (this.lfoShape === 0) {
      const v = f32(Math.sin(p * TWO_PI));
      const d = this.inc + p;
      this.phase = d - Math.trunc(d);
      return f32(this.lfoAmt * v);
    }
    const d = p + this.inc;
    this.phase = d - Math.trunc(d);
    const q = f32(this.phase);
    if (this.lfoShape === 2) return f32(this.lfoAmt * q);
    if (this.lfoShape === 1) { const t = f32(q + q); return f32(this.lfoAmt * (t > 1 ? f32(2 - t) : t)); }
    return q > 0.5 ? this.lfoAmt : 0;
  }

  private stepWet(): number {
    const w = f32((this.bypass ? 0 : 1) - this.wet);
    this.wet = f32(w * F01 + this.wet);
    return this.wet;
  }

  process(L: Float32Array, R: Float32Array, n: number, tempo: number): void {
    if (!(this.sr >= 1 && tempo >= 1)) return;
    this.active = false;
    this.period = f32((this.rate * 60) / tempo);
    this.inc = this.period === 0 ? 0 : 1 / f32(this.sr * this.period);
    switch (this.type) {
      case 0: this.distortion(L, R, n); break;
      case 1: this.crusher(L, R, n); break;
      case 2: this.flanger(L, R, n); break;
      case 3: this.phaser(L, R, n); break;
      case 4: this.filter(L, R, n, false); break;
      case 5: this.filter(L, R, n, true); break;
      case 6: this.delay(L, R, n); break;
      case 7: this.doReverb(L, R, n); break;
      case 8: this.panner(L, R, n); break;
      default: this.trancer(L, R, n);
    }
    if (this.eqOn) this.eq(L, R, n);
  }

  private faded(): boolean { return this.bypass && this.wet < T4; }

  private filter(L: Float32Array, R: Float32Array, n: number, high: boolean): void {
    if (this.faded()) return;
    this.active = true;
    const x = this.x;
    let v = f32(this.blockLfo(n) + x);
    v = Math.min(Math.max(v, 0), 1);
    const q = f32(f32(f32(this.y * this.y) + f32(this.y * this.y)) + 1);
    const f = high ? exp2f(f32(v * f32(7.423999786376953) + 5)) : exp2f(f32(v * f32(8.279999732971191) + 6));
    const arr = high ? this.hp : this.lp;
    for (let k = 0; k < 8; k++) arr[k].set(f, q, f32(this.sr));
    for (let i = 0; i < n; i++) {
      const w = this.stepWet();
      let a = L[i];
      let o = arr[0].process(arr[1].process(arr[2].process(a)));
      L[i] = f32(f32(o - a) * w + a);
      a = R[i];
      o = arr[3].process(arr[4].process(arr[5].process(a)));
      R[i] = f32(f32(o - a) * this.wet + a);
    }
  }

  private distortion(L: Float32Array, R: Float32Array, n: number): void {
    if (this.faded()) return;
    this.active = true;
    const lfo = this.blockLfo(n);
    const fr = exp2f(f32(this.y * f32(4.28000020980835) + 10));
    const q = f32(0.9900000095367432);
    this.lp[0].set(fr, q, f32(this.sr));
    this.lp[1].set(fr, q, f32(this.sr));
    let d = Math.min(Math.max(f32(lfo + this.x), 0), 1);
    d = f32(d * d); d = f32(d * d);
    const k1 = f32(d * 1024), k2 = f32(d * 512 + 0.5);
    for (let i = 0; i < n; i++) {
      const w = this.stepWet();
      let a = L[i];
      let s = f32(f32(a * k2) / f32(Math.abs(a) * k1 + 1));
      L[i] = f32(w * f32(this.lp[0].process(s) - a) + a);
      a = R[i];
      s = f32(f32(a * k2) / f32(Math.abs(a) * k1 + 1));
      R[i] = f32(f32(this.lp[1].process(s) - a) * this.wet + a);
    }
  }

  private crusher(L: Float32Array, R: Float32Array, n: number): void {
    if (this.faded()) return;
    this.active = true;
    const lfo = this.blockLfo(n);
    const fr = exp2f(f32(this.y * f32(4.28000020980835) + 10));
    const q = f32(0.9900000095367432);
    this.lp[0].set(fr, q, f32(this.sr));
    this.lp[1].set(fr, q, f32(this.sr));
    let h = Math.min(Math.max(f32(f32(1 - this.x) + lfo), 0), 1);
    h = f32(f32(h * h) * 64 + 3);
    for (let i = 0; i < n; i++) {
      let c = this.crushCount;
      if (!(c > 0)) { this.crushL = L[i]; this.crushR = R[i]; c = h; }
      this.crushCount = f32(c - 1);
      const w = this.stepWet();
      let a = L[i];
      L[i] = f32(f32(this.lp[0].process(this.crushL) - a) * w + a);
      a = R[i];
      R[i] = f32(f32(this.lp[1].process(this.crushR) - a) * this.wet + a);
    }
  }

  private flanger(L: Float32Array, R: Float32Array, n: number): void {
    if (this.faded()) return;
    this.active = true;
    const fb = f32(this.y * -0.5);
    for (const t of this.tapes) t.fb = fb;
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      const lfo = this.sampleLfo();
      const t = f32(1 - f32(this.x + lfo));
      const w = this.stepWet();
      const tt = Math.max(Math.min(t, 0.99), 0);
      for (const tp of this.tapes) { tp.setTime(tt); tp.a = -w; }
      const ol = this.tapes[0].process(this.tapes[1].process(this.tapes[2].process(xl)));
      const or = this.tapes[3].process(this.tapes[4].process(this.tapes[5].process(xr)));
      L[i] = f32(xl + ol);
      R[i] = f32(xr + or);
    }
  }

  private phaser(L: Float32Array, R: Float32Array, n: number): void {
    if (this.faded()) return;
    this.active = true;
    const fb = f32(f32(Math.cbrt(f32(this.y * f32(0.6000000238418579)))) * f32(0.9800000190734863));
    const cenT = Math.max(f32(this.x * this.x), f32(9.999999747378752e-06));
    if (this.phCenter < 0) this.phCenter = cenT;
    const s = this.ph;
    const isr = f32(1 / this.sr);
    const M1E6 = f32(-9.999999974752427e-07);
    for (let i = 0; i < n; i++) {
      this.stepWet();
      const lfo = this.sampleLfo();
      const cen = this.phCenter;
      const xl = f32(L[i] + M1E6), xr = f32(R[i] + M1E6);
      let a = f32(lfo * f32(0.5 * cen) + cen);
      a = f32(f32(a * 19950 + 50) * isr);
      a = Math.min(a, f32(0.49900001287460327));
      if (a < 0.001) a = f32(0.0010000000474974513);
      this.phCenter = f32(fmaD(f32(cenT - cen), 0.001, cen));
      const g = f32(f32(1 - a) / f32(a + 1));
      // six first-order all-pass stages per channel in FL's lattice form (FL 0x8e18)
      const u = f32(s[6] * fb + xl);
      const v = f32(s[13] * fb + xr);
      let s3 = f32(s[0] - u * g);
      let s4 = f32(s3 * g);
      s[0] = f32(s4 + u);
      let s1 = f32(s[7] - v * g);
      let s5 = f32(s1 * g);
      s[7] = f32(s5 + v);
      let s2 = f32(s[1] - s4);
      s4 = f32(s2 * g);
      s3 = f32(s4 + s3);
      s[1] = s3;
      let t = f32(s[8] - s5);
      s5 = f32(t * g);
      s1 = f32(s5 + s1);
      s[8] = s1;
      s1 = f32(s[2] - s4);
      s4 = f32(s1 * g);
      s2 = f32(s4 + s2);
      s[2] = s2;
      s2 = f32(s[9] - s5);
      s5 = f32(s2 * g);
      t = f32(s5 + t);
      s[9] = t;
      t = f32(s[3] - s4);
      s4 = f32(t * g);
      s1 = f32(s4 + s1);
      s[3] = s1;
      s1 = f32(s[10] - s5);
      s5 = f32(s1 * g);
      s2 = f32(s5 + s2);
      s[10] = s2;
      s2 = f32(s[4] - s4);
      s4 = f32(s2 * g);
      t = f32(s4 + t);
      s[4] = t;
      t = f32(s[11] - s5);
      s5 = f32(t * g);
      s1 = f32(s5 + s1);
      s[11] = s1;
      const ol = f32(s[5] - s4);
      s[5] = f32(ol * g + s2);
      const or = f32(s[12] - s5);
      s[12] = f32(or * g + t);
      s[6] = ol;
      s[13] = or;
      L[i] = f32(this.wet * ol + L[i]);
      R[i] = f32(this.wet * or + R[i]);
    }
  }

  private delay(L: Float32Array, R: Float32Array, n: number): void {
    if (this.bypass && this.tail < 0) return;
    this.active = true;
    let t = f32(this.period * f32(0.6666666865348816));
    const fb = f32(this.x * this.x);
    const y2 = f32(this.y + this.y);
    const lpc = f32(Math.min(y2, 1) ** 2);
    const dcc = f32(Math.max(f32(y2 - 1), 0) ** 2);
    let td = t < 0.01 ? f32(0.009999999776482582) : t;
    td = Math.max(Math.min(td, 0.99), 0);
    void t;
    for (const tp of this.tapes) { tp.dc = dcc; tp.fb = fb; tp.lp = lpc; tp.setTime(td); }
    for (let i = 0; i < n; i++) {
      const w = this.stepWet();
      const g = f32(w * fb);
      this.tapes[0].a = g; this.tapes[1].a = g;
      const xl = L[i], xr = R[i];
      const ol = this.tapes[0].process(xl);
      const or = this.tapes[1].process(xr);
      if (Math.abs(ol) > T4 || Math.abs(or) > T4 || Math.abs(xl) > T4 || Math.abs(xr) > T4) this.tail = Math.trunc(this.sr * 1.5);
      else this.tail--;
      L[i] = f32(xl + ol);
      R[i] = f32(xr + or);
    }
  }

  private doReverb(L: Float32Array, R: Float32Array, n: number): void {
    if (this.bypass && this.tail < 1) return;
    const rv = this.reverb;
    if (!rv) return;
    this.active = true;
    for (let i = 0; i < n; i++) {
      const w = this.stepWet();
      L[i] = f32(w * L[i]);
      R[i] = f32(R[i] * w);
    }
    const x3 = f32(f32(this.x * this.x) * this.x);
    rv.setParam(9, f32(this.y * this.y));
    rv.setParam(8, f32(x3 * 0.75));
    rv.setParam(12, f32(x3 * f32(0.22500000894069672) + 0.5));
    rv.setParam(2, 1);
    rv.setParam(1, f32(0.10000000149011612));
    rv.setParam(5, 1);
    rv.setParam(4, 1);
    rv.setParam(3, 0);
    rv.setParam(10, 0);
    rv.setParam(16, 1);
    rv.process(L, R, n);
    for (let i = 0; i < n; i++) {
      if (Math.abs(L[i]) > T4 || Math.abs(R[i]) > T4) this.tail = Math.trunc(this.sr * 0.25);
      else this.tail--;
    }
  }

  private panner(L: Float32Array, R: Float32Array, n: number): void {
    if (this.bypass && this.tail < 1) return;
    this.active = true;
    for (const tp of this.tapes) { tp.a = 1; tp.fb = 0; }
    for (let i = 0; i < n; i++) {
      const lfo = this.sampleLfo();
      const s = f32(f32(lfo + this.x) * 2);
      const p = f32(s - 1);
      const dl = Math.max(Math.min(p, 1), 0);
      const dr = Math.min(p > 0 ? 0 : -p, 1);
      this.tapes[0].setTime(Math.max(Math.min(dl, 0.99), 0));
      this.tapes[1].setTime(Math.max(Math.min(dr, 0.99), 0));
      const y2 = f32(this.y + this.y);
      const k = f32(s * y2 - y2);
      const gl = Math.min(Math.max(f32(2 - k), 0), 1);
      const gr = Math.min(Math.max(f32(k + 2), 0), 1);
      L[i] = this.tapes[0].process(f32(gl * L[i]));
      R[i] = this.tapes[1].process(f32(gr * R[i]));
    }
  }

  private trancer(L: Float32Array, R: Float32Array, n: number): void {
    if (this.bypass) return;
    this.active = true;
    if (!(this.rate > 0) || n === 0) return;
    const r1 = f32(1 - this.x);
    const rel = f32(f32(r1 - this.x * r1) * 50 + 1);
    const dep = f32(1 - this.y * this.y);
    let p = this.phase;
    for (let i = 0; i < n; i++) {
      let env: number;
      if (p < 0.009999999776482582) env = f32(p * 100.00000223517424);
      else {
        let e = f32(p * 1.0101010003706326 - 0.010101009777931158);
        e = f32(e * e); e = f32(e * e); e = f32(e * rel);
        env = f32(1 - Math.min(e, 1));
      }
      const g0 = f32(f32(env - this.tranceG) * F01 + this.tranceG);
      this.tranceG = g0;
      const g = f32(g0 * dep);
      p += this.inc;
      p -= Math.trunc(p);
      L[i] = f32(L[i] - g * L[i]);
      R[i] = f32(R[i] - g * R[i]);
    }
    this.phase = p;
  }

  setEqBand(b: number, v: number): void {
    if (this.eqGain[b] !== v) this.eqDirty[b] = 1;
    this.eqGain[b] = v;
  }

  private eq(L: Float32Array, R: Float32Array, n: number): void {
    this.active = true;
    for (let b = 0; b < 5; b++) {
      if (this.eqDirty[b]) {
        this.eqDirty[b] = 0;
        const g = f32(fmaD(this.eqGain[b], 24, -12));
        for (const s of [this.eqL[b], this.eqR[b]]) {
          if (s.gain !== g) s.dirty = true;
          s.gain = g;
          s.setSampleRate(f32(this.sr));
        }
      }
      const a = this.eqL[b], c = this.eqR[b];
      for (let i = 0; i < n; i++) { L[i] = a.process(L[i]); R[i] = c.process(R[i]); }
    }
  }
}
