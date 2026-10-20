// Low Lifter (FL: Low Lifter, DSP by Dario Sanfilippo). Signal flow, after
// FL's flowchart and measurements on FL's binary (docs/research/fx/lowlifter.md):
//   input -> LR4 crossover (20..120 Hz)
//   low band:  [multiband: LR4 split at fc/4 and fc/2, per band:]
//              pre-shaping boost -> 0 dBFS limiter (10 ms look-ahead, or instant)
//              -> Chebyshev shaper T1 + w T2 + w^2 T3, normalised by 1 + 2w
//              -> 20 Hz DC blocker -> low gain -> polarity -> diffuser
//              (4 allpass sections, total delay 1/fc, crossfaded by Mix)
//   high band: high gain
//   sum -> low cut (2nd-order high-pass) = wet
//   dry = crossover allpass -> first-order allpass at the low cut (phase-matched)
//   out = linear dry/wet crossfade (Enabled off = dry). Latency 10 ms with look-ahead.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';

const LOOKAHEAD_SEC = 0.01;
const DC_HZ = 20;
/** Limiter: per channel (and per band), gain smoothing in the log domain, 4 one-poles. */
const LIM_HOLD_SEC = 0.0471;
const LIM_ATT_SEC = 0.00065; // per pole, look-ahead mode (instant attack without look-ahead)
const LIM_REL_SEC = 0.0069; // per pole
/** Diffuser allpass delays as fractions of the crossover period (sum ~1). */
const DIFF_R = [0.5, 0.2061, 0.1581, 0.133];
/** Multiband: 1/16 of the top band (fc/2..fc) also feeds the middle band's limiter and shaper in FL. */
const MB_LEAK = 1 / 16;
/** FL smooths gains and mixes with a ~8 ms one-pole. */
const SMOOTH_SEC = 0.008;
/** Analyzer feed: decimated mono input/output for the editor's spectrum (20 Hz - 1 kHz). */
const AN_RATE = 4000;
const AN_BUF = 8192;

const f32 = Math.fround;

// Value laws (mirror src/model/fx/plugins/lowlifter.ts)
function nx(v: number): number { return f32(Math.min(10000, Math.max(0, v)) / 10000); }
export function llFreq(v: number): number { return 20 + 100 * Math.pow(nx(v), 2.0043374); }
function lowGainLin(v: number): number { return v <= 0 ? 0 : Math.pow(10, (132 * Math.pow(nx(v), 1 / 7.275) - 120) / 20); }
function slopeW(v: number): number { return Math.pow(10, (60 * (Math.pow(nx(v), 1 / 3.105) - 1)) / 20); }
function highGainLin(v: number): number { return v <= 0 ? 0 : Math.pow(10, (120 * (Math.pow(nx(v), 0.2) - 1)) / 20); }
function preGainLin(v: number): number { return Math.pow(10, (nx(v) * 18) / 20); }
function diffCoef(v: number): number { return f32(f32(0.99) * f32(2 * nx(v) - 1)); }

/** The harmonics shaper: Chebyshev series with weights 1, w, w^2 (the T2 constant is dropped: the DC blocker removes it). */
export function llShape(u: number, w: number): number {
  const u2 = u * u;
  return (u + w * 2 * u2 + w * w * (4 * u2 - 3) * u) / (1 + 2 * w);
}

class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; z1 = 0; z2 = 0;
  run(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  clear(): void { this.z1 = this.z2 = 0; }
  flush(): void { if (Math.abs(this.z1) < 1e-25) this.z1 = 0; if (Math.abs(this.z2) < 1e-25) this.z2 = 0; }
  /** Butterworth 2nd order (bilinear, prewarped): kind 0 low-pass, 1 high-pass, 2 the LR4 allpass (LP4 + HP4). */
  design(fc: number, sr: number, kind: number): void {
    const K = Math.tan((Math.PI * Math.min(fc, sr * 0.45)) / sr), K2 = K * K;
    const a0 = 1 + Math.SQRT2 * K + K2;
    this.a1 = (2 * (K2 - 1)) / a0;
    this.a2 = (1 - Math.SQRT2 * K + K2) / a0;
    if (kind === 0) { this.b0 = K2 / a0; this.b1 = 2 * this.b0; this.b2 = this.b0; }
    else if (kind === 1) { this.b0 = 1 / a0; this.b1 = -2 / a0; this.b2 = 1 / a0; }
    else { this.b0 = this.a2; this.b1 = this.a1; this.b2 = 1; }
  }
  copy(o: Biquad): void { this.b0 = o.b0; this.b1 = o.b1; this.b2 = o.b2; this.a1 = o.a1; this.a2 = o.a2; }
}

/**
 * 0 dBFS peak limiter: sliding maximum over (look-ahead + hold), gain
 * reduction smoothed in nepers by four one-poles (attack / release), signal
 * delayed by the look-ahead.
 */
class Limiter {
  private dl: Float64Array;
  private dp = 0;
  private ld = 0;
  private qv: Float64Array;
  private qt: Float64Array;
  private qh = 0;
  private qn = 0;
  private cap: number;
  private t = 0;
  private win = 1;
  private e0 = 0; private e1 = 0; private e2 = 0; private e3 = 0;
  private ca = 1;
  private cr = 0;
  /** Current gain reduction (nepers), for metering. */
  gr = 0;
  constructor(maxLd: number, maxWin: number) {
    this.dl = new Float64Array(maxLd + 1);
    this.cap = maxWin + 2;
    this.qv = new Float64Array(this.cap);
    this.qt = new Float64Array(this.cap);
  }
  configure(ld: number, hold: number, ca: number, cr: number): void {
    if (ld !== this.ld) { this.ld = ld; this.dl.fill(0); this.dp = 0; }
    this.win = Math.min(this.cap - 2, ld + hold + 1);
    this.ca = ca; this.cr = cr;
  }
  clear(): void {
    this.dl.fill(0); this.dp = 0; this.qh = 0; this.qn = 0; this.t = 0;
    this.e0 = this.e1 = this.e2 = this.e3 = 0; this.gr = 0;
  }
  run(u: number): number {
    const cap = this.cap, t = this.t++;
    const a = u < 0 ? -u : u;
    while (this.qn > 0 && this.qv[(this.qh + this.qn - 1) % cap] <= a) this.qn--;
    { const k = (this.qh + this.qn) % cap; this.qv[k] = a; this.qt[k] = t; this.qn++; }
    while (this.qt[this.qh] <= t - this.win) { this.qh = (this.qh + 1) % cap; this.qn--; }
    const env = this.qv[this.qh];
    // delayed signal
    let d = u;
    if (this.ld > 0) {
      const len = this.ld + 1, p = this.dp;
      this.dl[p] = u;
      const r = p + 1 >= len ? 0 : p + 1;
      d = this.dl[r];
      this.dp = r;
    }
    const x = env > 1 ? Math.log(env) : 0;
    if (x === 0 && this.e3 === 0 && this.e0 === 0) return d;
    const ca = this.ca, cr = this.cr;
    this.e0 += (x > this.e0 ? ca : cr) * (x - this.e0);
    this.e1 += (this.e0 > this.e1 ? ca : cr) * (this.e0 - this.e1);
    this.e2 += (this.e1 > this.e2 ? ca : cr) * (this.e1 - this.e2);
    this.e3 += (this.e2 > this.e3 ? ca : cr) * (this.e2 - this.e3);
    if (this.e3 < 1e-12 && x === 0 && this.e0 < 1e-12) { this.e0 = this.e1 = this.e2 = this.e3 = 0; return d; }
    this.gr = this.e3;
    return d * Math.exp(-this.e3);
  }
}

/** Allpass section (c + z^-D) / (1 + c z^-D). */
class DiffAp {
  private buf: Float64Array;
  private p = 0;
  d = 1;
  constructor(max: number) { this.buf = new Float64Array(max + 1); }
  clear(): void { this.buf.fill(0); this.p = 0; }
  run(x: number, c: number): number {
    const len = this.buf.length;
    let r = this.p - this.d; if (r < 0) r += len;
    const vd = this.buf[r];
    const v = x - c * vd;
    this.buf[this.p] = Math.abs(v) < 1e-25 ? 0 : v;
    this.p = this.p + 1 >= len ? 0 : this.p + 1;
    return c * v + vd;
  }
}

/** Per-channel processing state. */
class Chan {
  lp = [new Biquad(), new Biquad()];
  hp = [new Biquad(), new Biquad()];
  // multiband split
  mbLp2 = [new Biquad(), new Biquad()];
  mbHp2 = [new Biquad(), new Biquad()];
  mbLp4 = [new Biquad(), new Biquad()];
  mbHp4 = [new Biquad(), new Biquad()];
  mbAp4 = new Biquad();
  // multiband mode also routes the high band through HP4(fc/2) + AP(fc/4), and the dry through AP(fc/2) + AP(fc/4)
  hiHp2 = [new Biquad(), new Biquad()];
  hiAp4 = new Biquad();
  dryAp2 = new Biquad();
  dryAp4 = new Biquad();
  lim: Limiter[];
  dc = new Biquad();
  lowCut = new Biquad();
  diff: DiffAp[];
  // dry: first-order allpass state (phase match to the low cut)
  apX = 0; apY = 0;
  hiDl: Float64Array; dryDl: Float64Array; dp = 0;
  private all: Biquad[];
  constructor(maxLd: number, maxWin: number, maxDiff: number[]) {
    this.lim = [new Limiter(maxLd, maxWin), new Limiter(maxLd, maxWin), new Limiter(maxLd, maxWin)];
    this.diff = maxDiff.map((m) => new DiffAp(m));
    this.hiDl = new Float64Array(maxLd + 1);
    this.dryDl = new Float64Array(maxLd + 1);
    this.all = [...this.lp, ...this.hp, ...this.mbLp2, ...this.mbHp2, ...this.mbLp4, ...this.mbHp4, this.mbAp4,
      ...this.hiHp2, this.hiAp4, this.dryAp2, this.dryAp4, this.dc, this.lowCut];
  }
  clear(): void {
    for (const b of this.all) b.clear();
    for (const l of this.lim) l.clear();
    this.clearDiff();
    this.apX = this.apY = 0;
    this.hiDl.fill(0); this.dryDl.fill(0); this.dp = 0;
  }
  clearDiff(): void { for (const d of this.diff) d.clear(); }
  flush(): void {
    for (let i = 0; i < this.all.length; i++) this.all[i].flush();
    if (Math.abs(this.apY) < 1e-25) this.apY = 0;
  }
}

class LowLifterFx implements EffectInstance {
  private sr: number;
  private ldN: number;
  private holdN: number;
  private ca: number;
  private cr: number;
  private ch: Chan[];
  // targets
  private on = 1; private dw = 1; private lowG = 1; private w = 0.47; private la = true; private inv = false;
  private pre = 2.818; private dMix = 0; private dC = 0; private highG = 1; private fc = 99.53; private lc = 20; private mb = false;
  // smoothed values
  private sOn = 1; private sDw = 1; private sLow = 1; private sW = 0.47; private sSign = 1; private sPre = 2.818;
  private sMix = 0; private sC = 0; private sHigh = 1; private sFc = 99.53; private sLc = 20;
  private kS: number;
  private curFc = -1; private curLc = -1; private curLd = -1;
  private apC = 0;
  private diffOn = false;
  // analyzer
  private anIn: Float32Array; private anOut: Float32Array; private anW = 0; private anR = 0;
  private anDec: number; private anCnt = 0;
  private anLpI = [new Biquad(), new Biquad()]; private anLpO = [new Biquad(), new Biquad()];
  private grMax = 0; private pkIn = 0; private pkOut = 0;

  constructor(sr: number) {
    this.sr = sr;
    this.ldN = Math.max(1, Math.round(LOOKAHEAD_SEC * sr));
    this.holdN = Math.round(LIM_HOLD_SEC * sr);
    this.ca = 1 - Math.exp(-1 / (LIM_ATT_SEC * sr));
    this.cr = 1 - Math.exp(-1 / (LIM_REL_SEC * sr));
    this.kS = 1 - Math.exp(-1 / (SMOOTH_SEC * sr));
    const maxDiff = DIFF_R.map((r) => Math.ceil((sr / 20) * r) + 2);
    this.ch = [new Chan(this.ldN, this.ldN + this.holdN + 2, maxDiff), new Chan(this.ldN, this.ldN + this.holdN + 2, maxDiff)];
    this.anDec = Math.max(1, Math.round(sr / AN_RATE));
    this.anIn = new Float32Array(AN_BUF); this.anOut = new Float32Array(AN_BUF);
    for (const b of [...this.anLpI, ...this.anLpO]) b.design(Math.min(1100, (0.3 * sr) / this.anDec), sr, 0);
    this.setParams({});
    this.reset();
  }

  get latency(): number { return this.la ? this.ldN : 0; }

  get tail(): number {
    // filters + limiter release, plus the diffuser's ring time (-60 dB) when it is mixed in
    let t = 0.15 + (this.la ? this.ldN / this.sr : 0);
    if (this.dMix > 0 && Math.abs(this.dC) > 1e-6) {
      const per = (this.sr / this.fc) * DIFF_R[0];
      t += Math.min(30, ((per / this.sr) * Math.log(1000)) / -Math.log(Math.abs(this.dC)));
    }
    return t;
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number) => { const v = q[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d; };
    this.on = num('enabled', 1) >= 0.5 ? 1 : 0;
    this.dw = nx(num('dryWet', 10000));
    this.lowG = num('lowBand', 1) >= 0.5 ? lowGainLin(num('lowGain', 4999)) : 0;
    this.w = slopeW(num('slope', 6993));
    this.la = num('lookahead', 1) >= 0.5;
    this.inv = num('invert', 0) >= 0.5;
    this.pre = preGainLin(num('preGain', 4998));
    this.dMix = nx(num('diffMix', 0));
    this.dC = diffCoef(num('diffDepth', 5000));
    this.highG = num('highBand', 1) >= 0.5 ? highGainLin(num('highGain', 10000)) : 0;
    this.fc = llFreq(num('crossover', 8920));
    this.lc = llFreq(num('lowCut', 0));
    this.mb = num('multiband', 0) >= 0.5;
  }

  reset(): void {
    this.sOn = this.on; this.sDw = this.dw; this.sLow = this.lowG; this.sW = this.w; this.sSign = this.inv ? -1 : 1;
    this.sPre = this.pre; this.sMix = this.dMix; this.sC = this.dC; this.sHigh = this.highG; this.sFc = this.fc; this.sLc = this.lc;
    for (const c of this.ch) c.clear();
    this.curFc = -1; this.curLc = -1; this.curLd = -1;
    this.updateFilters(true);
    this.anIn.fill(0); this.anOut.fill(0); this.anW = 0; this.anR = 0; this.anCnt = 0;
    for (const b of [...this.anLpI, ...this.anLpO]) b.clear();
    this.diffOn = false;
    this.grMax = 0; this.pkIn = 0; this.pkOut = 0;
  }

  private updateFilters(force: boolean): void {
    const sr = this.sr;
    const ld = this.la ? this.ldN : 0;
    if (force || ld !== this.curLd) {
      this.curLd = ld;
      for (const c of this.ch) { for (const l of c.lim) l.configure(ld, this.holdN, ld > 0 ? this.ca : 1, this.cr); c.hiDl.fill(0); c.dryDl.fill(0); c.dp = 0; }
    }
    if (force || Math.abs(this.sFc - this.curFc) > 1e-4 * this.curFc) {
      const fc = this.sFc; this.curFc = fc;
      const c0 = this.ch[0];
      c0.lp[0].design(fc, sr, 0); c0.hp[0].design(fc, sr, 1);
      c0.mbLp2[0].design(fc / 2, sr, 0); c0.mbHp2[0].design(fc / 2, sr, 1);
      c0.mbLp4[0].design(fc / 4, sr, 0); c0.mbHp4[0].design(fc / 4, sr, 1);
      c0.mbAp4.design(fc / 4, sr, 2);
      c0.dryAp2.design(fc / 2, sr, 2);
      const per = sr / fc;
      for (const c of this.ch) {
        for (let k = 0; k < 2; k++) {
          c.lp[k].copy(c0.lp[0]); c.hp[k].copy(c0.hp[0]);
          c.mbLp2[k].copy(c0.mbLp2[0]); c.mbHp2[k].copy(c0.mbHp2[0]);
          c.mbLp4[k].copy(c0.mbLp4[0]); c.mbHp4[k].copy(c0.mbHp4[0]);
          c.hiHp2[k].copy(c0.mbHp2[0]);
        }
        c.mbAp4.copy(c0.mbAp4); c.hiAp4.copy(c0.mbAp4); c.dryAp4.copy(c0.mbAp4); c.dryAp2.copy(c0.dryAp2);
        for (let i = 0; i < DIFF_R.length; i++) c.diff[i].d = Math.max(1, Math.round(per * DIFF_R[i]));
        c.dc.design(DC_HZ, sr, 1);
      }
    }
    if (force || Math.abs(this.sLc - this.curLc) > 1e-4 * this.curLc) {
      const lc = this.sLc; this.curLc = lc;
      for (const c of this.ch) c.lowCut.design(lc, sr, 1);
      const K = Math.tan((Math.PI * lc) / sr);
      this.apC = (K - 1) / (K + 1);
    }
  }

  process(L: Float32Array, R: Float32Array, n: number, _ctx: FxContext): void {
    void _ctx;
    if (n <= 0) return;
    // per-block smoothing of the frequencies (filter coefficients), per-sample for gains
    const kb = 1 - Math.exp(-n / (SMOOTH_SEC * this.sr));
    this.sFc += (this.fc - this.sFc) * kb; if (Math.abs(this.sFc - this.fc) < 1e-3) this.sFc = this.fc;
    this.sLc += (this.lc - this.sLc) * kb; if (Math.abs(this.sLc - this.lc) < 1e-3) this.sLc = this.lc;
    this.updateFilters(false);
    const k = this.kS;
    const ld = this.curLd, len = ld + 1;
    const mb = this.mb, apC = this.apC;
    const signT = this.inv ? -1 : 1;
    let sOn = this.sOn, sDw = this.sDw, sLow = this.sLow, sW = this.sW, sSign = this.sSign, sPre = this.sPre;
    let sMix = this.sMix, sC = this.sC, sHigh = this.sHigh;
    const tOn = this.on, tDw = this.dw, tLow = this.lowG, tW = this.w, tPre = this.pre, tMix = this.dMix, tC = this.dC, tHigh = this.highG;
    const c0 = this.ch[0], c1 = this.ch[1];
    // the diffuser runs while it is (or becomes) audible; it starts from silence
    const wantDiff = tMix > 0 || sMix > 1e-6;
    if (wantDiff && !this.diffOn) { c0.clearDiff(); c1.clearDiff(); }
    this.diffOn = wantDiff;
    const diffOn = wantDiff;
    let grMax = this.grMax, pkIn = this.pkIn, pkOut = this.pkOut;
    for (let i = 0; i < n; i++) {
      sOn += (tOn - sOn) * k; sDw += (tDw - sDw) * k; sLow += (tLow - sLow) * k; sW += (tW - sW) * k;
      sSign += (signT - sSign) * k; sPre += (tPre - sPre) * k; sMix += (tMix - sMix) * k; sC += (tC - sC) * k; sHigh += (tHigh - sHigh) * k;
      const norm = 1 / (1 + 2 * sW);
      const xl = L[i], xr = R[i];
      const al = xl < 0 ? -xl : xl, ar = xr < 0 ? -xr : xr;
      if (al > pkIn) pkIn = al; if (ar > pkIn) pkIn = ar;
      for (let c = 0; c < 2; c++) {
        const C = c === 0 ? c0 : c1;
        const x = c === 0 ? xl : xr;
        // crossover
        const lo = C.lp[1].run(C.lp[0].run(x));
        const hi = C.hp[1].run(C.hp[0].run(x));
        // dry: crossover allpass, then -AP1 at the low cut (HP1 - LP1)
        const apIn = lo + hi;
        const apOut = apC * apIn + C.apX - apC * C.apY;
        C.apX = apIn; C.apY = apOut;
        let dry = -apOut;
        let hiD = hi;
        if (mb) {
          dry = C.dryAp4.run(C.dryAp2.run(dry));
          hiD = C.hiAp4.run(C.hiHp2[1].run(C.hiHp2[0].run(hi)));
        }
        if (ld > 0) {
          const p = C.dp, r = p + 1 >= len ? 0 : p + 1;
          C.dryDl[p] = dry; C.hiDl[p] = hiD;
          dry = C.dryDl[r]; hiD = C.hiDl[r];
          C.dp = r;
        }
        // low band: boost -> limiter -> shaper (per band in multiband mode)
        let shaped: number;
        if (!mb) {
          const u = C.lim[0].run(lo * sPre);
          const u2 = u * u;
          shaped = (u + sW * 2 * u2 + sW * sW * (4 * u2 - 3) * u) * norm;
        } else {
          const l2 = C.mbLp2[1].run(C.mbLp2[0].run(lo));
          const b3 = C.mbAp4.run(C.mbHp2[1].run(C.mbHp2[0].run(lo)));
          const b1 = C.mbLp4[1].run(C.mbLp4[0].run(l2));
          const b2 = C.mbHp4[1].run(C.mbHp4[0].run(l2));
          const u1 = C.lim[0].run(b1 * sPre), u2b = C.lim[1].run((b2 + MB_LEAK * b3) * sPre), u3 = C.lim[2].run(b3 * sPre);
          const q1 = u1 * u1, q2 = u2b * u2b, q3 = u3 * u3;
          shaped = ((u1 + sW * 2 * q1 + sW * sW * (4 * q1 - 3) * u1)
            + (u2b + sW * 2 * q2 + sW * sW * (4 * q2 - 3) * u2b)
            + (u3 + sW * 2 * q3 + sW * sW * (4 * q3 - 3) * u3)) * norm;
        }
        let low = C.dc.run(shaped) * sLow * sSign;
        // diffuser (crossfade)
        if (diffOn) {
          let d = low;
          for (let s = 0; s < C.diff.length; s++) d = C.diff[s].run(d, sC);
          low += (d - low) * sMix;
        }
        const wet = C.lowCut.run(low + hiD * sHigh);
        const mixv = sOn * sDw;
        const y = dry + (wet - dry) * mixv;
        if (c === 0) L[i] = y; else R[i] = y;
      }
      const ol = L[i] < 0 ? -L[i] : L[i], or = R[i] < 0 ? -R[i] : R[i];
      if (ol > pkOut) pkOut = ol; if (or > pkOut) pkOut = or;
      // analyzer feed (decimated mono)
      const ai = this.anLpI[1].run(this.anLpI[0].run(0.5 * (xl + xr)));
      const ao = this.anLpO[1].run(this.anLpO[0].run(0.5 * (L[i] + R[i])));
      if (++this.anCnt >= this.anDec) {
        this.anCnt = 0;
        this.anIn[this.anW] = ai; this.anOut[this.anW] = ao;
        this.anW = (this.anW + 1) % AN_BUF;
        if (this.anW === this.anR) this.anR = (this.anR + 1) % AN_BUF;
      }
    }
    for (const C of this.ch) {
      C.flush();
      for (const l of C.lim) if (l.gr > grMax) grMax = l.gr;
    }
    this.sOn = sOn; this.sDw = sDw; this.sLow = sLow; this.sW = sW; this.sSign = sSign; this.sPre = sPre;
    this.sMix = sMix; this.sC = sC; this.sHigh = sHigh;
    this.grMax = grMax; this.pkIn = pkIn; this.pkOut = pkOut;
    this.anLpI[0].flush(); this.anLpI[1].flush(); this.anLpO[0].flush(); this.anLpO[1].flush();
  }

  monitor(): FxMonitor {
    const nAvail = (this.anW - this.anR + AN_BUF) % AN_BUF;
    const inp: number[] = new Array(nAvail), out: number[] = new Array(nAvail);
    for (let j = 0, r = this.anR; j < nAvail; j++, r = (r + 1) % AN_BUF) { inp[j] = this.anIn[r]; out[j] = this.anOut[r]; }
    this.anR = this.anW;
    const m: FxMonitor = {
      rate: this.sr / this.anDec, inp, out,
      gr: (this.grMax * 20) / Math.LN10, pkIn: this.pkIn, pkOut: this.pkOut,
    };
    this.grMax = 0; this.pkIn = 0; this.pkOut = 0;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'lowlifter',
  create: (sampleRate) => new LowLifterFx(sampleRate),
};
