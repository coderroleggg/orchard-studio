// Mobile Rack stereo modules: Spacer, Spreader and Stereoizer. Measured on FL's
// binary (left-only / right-only impulses through flfxhost):
//  - Spacer: L/R delay up to 300 ms (positive delays the left channel), pan
//    (balance), separation (mid / side gains: +100 % mono, -100 % mid 0.5 and
//    side 1.5), L/R inversion, M/S delay up to 100 ms (positive delays the
//    mid), M/S inversion and the stereo mode (standard, output M/S, input M/S).
//  - Stereoizer: adds +-s to left / right, s = strength^2 x filter(delay(L + R));
//    delay 0.5 + 49.5 timbre^3 ms; focus > 0 high-passes the added signal
//    (x - one-pole low pass with coefficient focus^3), focus < 0 low-passes it
//    (coefficient 1 - |focus|^(1/3)); L/R delay up to 25 ms; balance.
//  - Spreader: only partly identified (FL's Width showed no effect in the
//    host); band split at Low Bypass, side gain from Separation, a Haas-style
//    6.3 ms side signal from the mid scaled by Width, optional mono bass.

import { DelayLine } from '../hardcore/dsp';
import { mrMap } from '../../../../model/fx/plugins/mobilerack/modules';
import { Sm, clamp, fl, smoothK, type MrModule } from './common';

const trunc = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.trunc(v * (n - 1) + 1e-7)));

export class Spacer implements MrModule {
  private readonly sr: number;
  private readonly dl: DelayLine;
  private readonly dr: DelayLine;
  private readonly dm: DelayLine;
  private readonly ds: DelayLine;
  private readonly lrD: Sm;
  private readonly msD: Sm;
  private readonly gL: Sm;
  private readonly gR: Sm;
  private readonly gm: Sm;
  private readonly gs: Sm;
  private invL = 1; private invR = 1; private invM = 1; private invS = 1;
  private mode = 0;

  constructor(sr: number) {
    this.sr = sr;
    this.dl = new DelayLine(0.31 * sr); this.dr = new DelayLine(0.31 * sr);
    this.dm = new DelayLine(0.11 * sr); this.ds = new DelayLine(0.11 * sr);
    const k = smoothK(30, sr), kg = smoothK(10, sr);
    this.lrD = new Sm(0, k); this.msD = new Sm(0, k);
    this.gL = new Sm(1, kg); this.gR = new Sm(1, kg); this.gm = new Sm(1, kg); this.gs = new Sm(1, kg);
  }

  set(p: Float64Array): void {
    const a = 2 * p[1] - 1;
    this.lrD.set(Math.sign(a) * 0.3 * Math.abs(a * a * a) * this.sr);
    const pan = p[2];
    this.gL.set(Math.min(1, 2 * (1 - pan))); this.gR.set(Math.min(1, 2 * pan));
    const s = 2 * p[3] - 1;
    if (s >= 0) { this.gm.set(1); this.gs.set(1 - s); } else { this.gm.set(1 + 0.5 * s); this.gs.set(1 - 0.5 * s); }
    const inv = trunc(p[4], 4);
    this.invL = inv === 1 || inv === 3 ? -1 : 1; this.invR = inv === 2 || inv === 3 ? -1 : 1;
    const b = 2 * p[5] - 1;
    this.msD.set(Math.sign(b) * 0.1 * Math.pow(Math.abs(b), 5) * this.sr);
    const msi = trunc(p[6], 4);
    this.invM = msi === 1 || msi === 3 ? -1 : 1; this.invS = msi === 2 || msi === 3 ? -1 : 1;
    this.mode = trunc(p[7], 3);
  }

  snap(): void { this.lrD.snap(); this.msD.snap(); this.gL.snap(); this.gR.snap(); this.gm.snap(); this.gs.snap(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const maxLR = this.dl.size - 2, maxMS = this.dm.size - 2;
    for (let i = 0; i < n; i++) {
      let l = L[i], r = R[i];
      if (this.mode === 2) { const mm = l, ss = r; l = mm + ss; r = mm - ss; } // input is M/S
      // L/R delay
      const d = this.lrD.next();
      this.dl.write(l); this.dr.write(r);
      if (d > 0.5) l = this.dl.read(clamp(d, 1, maxLR) + 1);
      else if (d < -0.5) r = this.dr.read(clamp(-d, 1, maxLR) + 1);
      l *= this.invL; r *= this.invR;
      // mid / side
      let m = 0.5 * (l + r), s = 0.5 * (l - r);
      const md = this.msD.next();
      this.dm.write(m); this.ds.write(s);
      if (md > 0.5) m = this.dm.read(clamp(md, 1, maxMS) + 1);
      else if (md < -0.5) s = this.ds.read(clamp(-md, 1, maxMS) + 1);
      m *= this.gm.next() * this.invM; s *= this.gs.next() * this.invS;
      if (this.mode === 1) { l = m; r = s; } else { l = m + s; r = m - s; }
      L[i] = l * this.gL.next(); R[i] = r * this.gR.next();
    }
  }

  reset(): void { this.dl.clear(); this.dr.clear(); this.dm.clear(); this.ds.clear(); }
  tail(): number { return 0.45; }
}

// ---------------------------------------------------------------------------

export class Stereoizer implements MrModule {
  private readonly sr: number;
  private readonly dline: DelayLine;
  private readonly dl: DelayLine;
  private readonly dr: DelayLine;
  private readonly amt: Sm;
  private readonly tD: Sm;
  private readonly lrD: Sm;
  private readonly gL: Sm;
  private readonly gR: Sm;
  private fk = 0.125;
  private fmode = 1; // 1 high pass, -1 low pass, 0 none
  private s = 0;

  constructor(sr: number) {
    this.sr = sr;
    this.dline = new DelayLine(0.052 * sr);
    this.dl = new DelayLine(0.027 * sr); this.dr = new DelayLine(0.027 * sr);
    const k = smoothK(20, sr), kg = smoothK(10, sr);
    this.amt = new Sm(0, kg); this.tD = new Sm(1, k); this.lrD = new Sm(0, k);
    this.gL = new Sm(1, kg); this.gR = new Sm(1, kg);
  }

  set(p: Float64Array): void {
    this.amt.set(p[1] * p[1]);
    const t = p[2];
    this.tD.set(((0.5 + 49.5 * t * t * t) / 1000) * this.sr);
    const f = 2 * p[3] - 1;
    if (Math.abs(f) < 1e-4) { this.fmode = 0; this.fk = 1; }
    else if (f > 0) { this.fmode = 1; this.fk = Math.min(1, f * f * f); }
    else { this.fmode = -1; this.fk = Math.max(0.0005, 1 - Math.cbrt(-f)); }
    const a = 2 * p[4] - 1;
    this.lrD.set(-a * 0.025 * this.sr); // negative values delay the left channel
    const pan = p[5];
    this.gL.set(Math.min(1, 2 * (1 - pan))); this.gR.set(Math.min(1, 2 * pan));
  }

  snap(): void { this.amt.snap(); this.tD.snap(); this.lrD.snap(); this.gL.snap(); this.gR.snap(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const maxT = this.dline.size - 2, maxLR = this.dl.size - 2;
    for (let i = 0; i < n; i++) {
      const sum = L[i] + R[i];
      const t = this.tD.next();
      const dsum = this.dline.read(clamp(t, 1, maxT));
      this.dline.write(sum);
      let x = dsum;
      if (this.fmode !== 0) {
        this.s += (x - this.s) * this.fk;
        this.s = fl(this.s);
        x = this.fmode > 0 ? x - this.s : this.s;
      }
      const add = this.amt.next() * x;
      let l = L[i] + add, r = R[i] - add;
      // FL's L/R delay is one sample short of its nominal time
      const d = this.lrD.next();
      this.dl.write(l); this.dr.write(r);
      if (d > 0.5) l = this.dl.read(clamp(d, 1, maxLR));
      else if (d < -0.5) r = this.dr.read(clamp(-d, 1, maxLR));
      L[i] = l * this.gL.next(); R[i] = r * this.gR.next();
    }
  }

  reset(): void { this.dline.clear(); this.dl.clear(); this.dr.clear(); this.s = 0; }
  tail(): number { return 0.1; }
}

// ---------------------------------------------------------------------------

export class Spreader implements MrModule {
  private readonly sr: number;
  private readonly haas: DelayLine;
  private lpL = 0; private lpR = 0;
  private k = 0.001;
  private readonly width: Sm;
  private readonly side: Sm;
  private monoBass = false;
  private readonly hD: number;

  constructor(sr: number) {
    this.sr = sr;
    this.hD = Math.round(0.0063 * sr);
    this.haas = new DelayLine(this.hD + 8);
    this.width = new Sm(0, smoothK(20, sr));
    this.side = new Sm(1, smoothK(20, sr));
  }

  set(p: Float64Array): void {
    this.width.set(p[1]);
    this.k = 1 - Math.exp((-2 * Math.PI * mrMap.spreaderLowHz(p[2])) / this.sr);
    this.monoBass = p[3] >= 0.5;
    this.side.set(2 * p[4]);
  }

  snap(): void { this.width.snap(); this.side.snap(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      // first-order split: low bands bypassed (or summed to mono), highs widened
      this.lpL += (l - this.lpL) * this.k; this.lpR += (r - this.lpR) * this.k;
      const loL = this.lpL, loR = this.lpR;
      const hiL = l - loL, hiR = r - loR;
      const m = 0.5 * (hiL + hiR);
      let s = 0.5 * (hiL - hiR) * this.side.next();
      const hm = this.haas.read(this.hD);
      this.haas.write(m);
      s += this.width.next() * 0.7 * hm;
      let outLoL = loL, outLoR = loR;
      if (this.monoBass) { const lm = 0.5 * (loL + loR); outLoL = lm; outLoR = lm; }
      L[i] = outLoL + m + s; R[i] = outLoR + m - s;
    }
    this.lpL = fl(this.lpL); this.lpR = fl(this.lpR);
  }

  reset(): void { this.haas.clear(); this.lpL = this.lpR = 0; }
  tail(): number { return 0.02; }
}
