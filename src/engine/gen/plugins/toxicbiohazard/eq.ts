// Toxic Biohazard's 8-band EQ, ported from FL 2026's Toxic Biohazard: octave
// bands at 62.5 Hz .. 8 kHz (low shelf, six peaks, high shelf; IL's RBJ biquad
// class, the one PoiZone uses for its output shelf), gain (36 v - 18) |2 v - 1|
// dB per band, the same coefficients for both channels.

import { f32, fmaD } from '../poizone/dsp';
import { PzShelf } from '../poizone/dsp';

export class TxEq {
  readonly bl: PzShelf[] = [];
  readonly br: PzShelf[] = [];
  sr = 0;

  constructor() {
    for (let c = 0; c < 2; c++) {
      const arr = c === 0 ? this.bl : this.br;
      for (let k = 0; k < 8; k++) {
        const b = new PzShelf();
        b.type = 1; b.sr = 44100; b.gain = 0; b.freq = 1000; b.bw = 1; b.dirty = true;
        b.setSampleRate(44100);
        b.reset();
        b.freq = 62.5 * (1 << k);
        b.type = k === 0 ? 0 : k === 7 ? 2 : 1;
        b.dirty = true;
        arr.push(b);
      }
    }
  }

  setBypass(_b: boolean): void { this.reset(); }

  setBand(k: number, v: number): void {
    const d1 = Math.abs(v + v - 1);
    const g = f32(fmaD(v, 36, -18) * d1);
    for (const b of [this.bl[k], this.br[k]]) {
      if (b.gain !== g) b.dirty = true;
      b.gain = g;
      b.setSampleRate(f32(this.sr));
    }
  }

  setSampleRate(sr: number): void {
    this.sr = sr;
    for (let k = 0; k < 8; k++) { this.bl[k].setSampleRate(f32(sr)); this.br[k].setSampleRate(f32(sr)); }
    this.reset();
  }

  reset(): void { for (let k = 0; k < 8; k++) { this.bl[k].reset(); this.br[k].reset(); } }

  process(L: Float32Array, R: Float32Array, n: number): void {
    for (let k = 0; k < 8; k++) {
      const a = this.bl[k], b = this.br[k];
      for (let i = 0; i < n; i++) {
        L[i] = a.process(L[i]);
        R[i] = b.process(R[i]);
      }
    }
  }
}
