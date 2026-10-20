// Kepler / Kepler Exo envelope (FL engine class at +0x28 bytes inside Voice): a 3-stage envelope
// - stage 0 attack: v += (1.7 - v) * a until v >= 1 (then v = 1, stage 1),
// - stage 1 decay: d *= decayMul; v = sustain + (1 - sustain) * d,
// - stage 2 release: v *= releaseMul (never stops by itself).
// Time constants: attack a = 1 - 0.41176472^(1 / (t sr)) (v reaches 1 after t), decay / release multiplier
// 0.1^(1 / (t sr)) (-20 dB per t). Decoded from engine.dylib 0x2ca94 (tick), 0x2c958 / 0x2c9b8 / 0x2ca04 /
// 0x2c9f4 (setters), 0x2ca40 (constructor).

import { f32, fma32 } from './fmath';
import { powf } from './applemath';

export class KEnv {
  value = 0;          // +0x00 output
  stage = 2;          // +0x04 0 attack, 1 decay / sustain, 2 release
  decayState = 0;     // +0x08
  decayMul = f32(0.9998955726623535);    // +0x0c
  attackCoef = f32(0.000402324105380103); // +0x10
  sustain = 0.5;      // +0x14
  sustainInv = 0.5;   // +0x18 (1 - sustain)
  releaseMul = f32(0.9994779825210571);  // +0x1c
  invSr = f32(2.2675736545352265e-05);   // +0x20
  sr = 44100;         // +0x24

  setSampleRate(sr: number): void {
    const s = f32(sr);
    this.invSr = f32(1 / s);
    this.sr = s;
  }
  /** Attack time (s): 0 = instant (coefficient 1). */
  setAttack(t: number): void {
    let c = 1;
    if (t !== 0) {
      const x = f32(t) * this.sr; // double product of the float time and the float rate
      c = f32(1 - Math.pow(0.4117647223819081, 1 / x));
    }
    this.attackCoef = c;
  }
  setDecay(t: number): void {
    const s = f32(this.sr * f32(t));
    this.decayMul = powf(f32(0.10000000149011612), f32(1 / s));
  }
  setSustain(s: number): void {
    this.sustain = s;
    this.sustainInv = f32(1 - s);
  }
  setRelease(t: number): void {
    const s = f32(this.sr * f32(t));
    this.releaseMul = powf(f32(0.10000000149011612), f32(1 / s));
  }
  noteOn(): void { this.stage = 0; this.decayState = 1; }
  noteOff(): void { this.stage = 2; }
  reset(): void { this.value = 0; this.stage = 2; }
  /** One sample. */
  tick(): void {
    if (this.stage === 2) { this.value = f32(this.releaseMul * this.value); return; }
    if (this.stage === 1) {
      this.decayState = f32(this.decayMul * this.decayState);
      this.value = fma32(this.sustainInv, this.decayState, this.sustain);
      return;
    }
    if (this.stage === 0) {
      const v = fma32(f32(f32(1.7000000476837158) - this.value), this.attackCoef, this.value);
      if (v < 1) { this.value = v; return; }
      this.value = 1;
      this.stage = 1;
    }
  }
}
