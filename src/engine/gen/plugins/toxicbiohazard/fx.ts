// Toxic Biohazard's effect chain, ported from FL 2026's Toxic Biohazard:
// distortion (exponential waveshaper 1 - (1 - x) 10^(-d x), drive 20 v^2
// smoothed 0.01 per sample, gain compensation 0.7 (1 - d / 16)^8 + 0.3) and a
// DC blocker (0.003) on every sample, then the two effect slots and the 8-band
// EQ; while the input is silent the effects keep running until the output has
// been below 1e-5 for 2.1 s, then they are reset and skipped.

import { f32, fmaD } from '../poizone/dsp';
import { exp10f } from '../poizone/applemath';
import { TxSlot } from './fxslot';
import { TxEq } from './eq';

const Q5 = f32(1e-5);
const F1E9 = f32(1e-9);
const F003 = f32(0.003);

export class TxFx {
  readonly slot: [TxSlot, TxSlot] = [new TxSlot(), new TxSlot()];
  readonly eq = new TxEq();
  eqBypass = true;
  drive = 0;
  driveT = 0;
  dcL = 0;
  dcR = 0;
  tempo = 120;
  resetDone = false;
  signal = false;
  quiet = 0;
  limit = 92610;

  setDrive(v: number): void { this.driveT = f32(f32(v * v) * 20); }
  eqOn(bypass: boolean): void { this.eqBypass = bypass; this.eq.setBypass(bypass); }
  setBand(k: number, v: number): void { this.eq.setBand(k, v); }

  setSampleRate(sr: number): void {
    this.limit = Math.trunc(sr * 2.1);
    this.slot[0].setSampleRate(sr);
    this.slot[1].setSampleRate(sr);
    this.eq.setSampleRate(sr);
  }

  reset(): void {
    this.slot[0].reset();
    this.slot[1].reset();
    this.eq.reset();
    this.drive = this.driveT;
    this.dcL = 0; this.dcR = 0;
    this.resetDone = true;
  }

  private distort(L: Float32Array, R: Float32Array, n: number): void {
    this.signal = false;
    for (let i = 0; i < n; i++) {
      let xl = L[i], xr = R[i];
      if (!(xr >= -Q5 && xl >= -Q5 && xl <= Q5 && xr <= Q5)) this.signal = true;
      const cur = f32(fmaD(f32(this.driveT - this.drive), 0.01, this.drive));
      this.drive = cur;
      if (cur < 0.001 && this.driveT < 0.001) {
        this.drive = 0; this.driveT = 0;
      } else {
        let yl: number, yr: number;
        if (xl >= 0) { const e = exp10f(f32(-xl * cur)); yl = fmaD(xl, e, -e) + 1; }
        else { const e = exp10f(f32(xl * cur)); yl = fmaD(xl, e, e) + -1; }
        if (xr >= 0) { const e = exp10f(f32(-xr * cur)); yr = fmaD(xr, e, -e) + 1; }
        else { const e = exp10f(f32(xr * cur)); yr = fmaD(xr, e, e) + -1; }
        let g = f32(fmaD(cur, -0.0625, 1));
        g = f32(g * g); g = f32(g * g); g = f32(g * g);
        g = f32(fmaD(g, 0.7, 0.3));
        xl = f32(yl * g);
        xr = f32(yr * g);
      }
      let d = f32(f32(xl - this.dcL) * F003 + this.dcL);
      if (d < F1E9 && d > -F1E9) d = 0;
      this.dcL = d;
      d = f32(f32(xr - this.dcR) * F003 + this.dcR);
      if (d < F1E9 && d > -F1E9) d = 0;
      this.dcR = d;
      L[i] = f32(xl - this.dcL);
      R[i] = f32(xr - this.dcR);
    }
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    this.distort(L, R, n);
    if (this.signal) { this.quiet = 0; this.resetDone = false; }
    if (this.signal || !this.resetDone) {
      this.slot[0].process(L, R, n, this.tempo);
      this.slot[1].process(L, R, n, this.tempo);
      if (!this.eqBypass) this.eq.process(L, R, n);
    }
    let loud = false;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      if (l > Q5 || r > Q5 || l < -Q5 || r < -Q5) { loud = true; break; }
    }
    if (loud) this.quiet = 0;
    else if (n > 0) this.quiet = (this.quiet === 0 ? 1 : this.quiet) + n;
    if (this.signal) return;
    if (this.quiet > this.limit && !this.resetDone) this.reset();
  }
}
