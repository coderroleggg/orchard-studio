// Kepler / Kepler Exo voice filters. FL's engine keeps one filter object per group of four voices
// (SIMD lanes); each lane is an independent filter, so the port runs the lanes one by one with the
// same single-precision (and fused) operations. Decoded from engine.dylib 0x3a640 (sample rate),
// 0x3a680 (coefficients), 0x3a7a0 (process), 0xfd24 (tan approximation), 0xfd60 (tanh approximation).
//
// Type 0 is the 4-stage transistor ladder in Zavalishin's TPT form with tanh at the input and at every
// stage, and a selectable output tap (6 / 12 / 18 / 24 dB per octave).

import { f32, fma32 } from './fmath';

/** 0xfd24: tan(x) approximation for the filter's frequency warping. */
export function tanApprox(x: number): number {
  const x2 = f32(x * x);
  let v = fma32(f32(-0.18975968658924103), x2, f32(2.4716885089874268));
  v = f32(v * x);
  return f32(v / f32(f32(2.4674010276794434) - x2));
}

/** 0xfd60: tanh as a clamped rational function. */
export function tanhApprox(x: number): number {
  x = x < -5 ? -5 : x > 5 ? 5 : x;
  const x2 = f32(x * x);
  const a = f32(x2 + 378);
  const b = fma32(x2, a, 17325);
  const c = fma32(x2, b, 135135);
  const num = f32(x * c);
  const d = fma32(28, x2, 3150);
  const e = fma32(x2, d, 62370);
  const den = fma32(x2, e, 135135);
  return f32(num / den);
}

const F20 = f32(20);
const K42 = f32(4.199999809265137);

/** Filter type 0: the transistor ladder, four lanes. */
export class LadderBank {
  readonly cutoff = new Float32Array(4);   // @0x00 Hz
  readonly res = new Float32Array(4);      // @0x10
  readonly input = new Float32Array(4);    // @0x20
  readonly out = new Float32Array(4);      // @0x30
  drive = f32(2.744999885559082);          // @0x40
  drivePre = f32(0.36430);                 // @0x50 (1 / drive, set by the constructor)
  readonly G = new Float32Array(4);        // @0x60 g / (1 + g)
  readonly A = new Float32Array(4);        // @0x70 1 / (1 + g)
  readonly G4 = new Float32Array(4);       // @0x80
  readonly k = new Float32Array(4);        // @0x90 4.2 res
  readonly res1 = new Float32Array(4).fill(1); // @0xa0 res + 1
  readonly norm = new Float32Array(4).fill(1); // @0xb0 1 / (1 + G4 k)
  readonly st: Float32Array[] = [new Float32Array(4), new Float32Array(4), new Float32Array(4), new Float32Array(4)]; // @0xc0..0xf0
  omega = 0;                               // @0x100 pi / (sr os)
  maxFc = 0;                               // @0x110 sr os / 2 * 0.999
  tap = 0;                                 // @0x120 output stage 0..3

  constructor() {
    this.drivePre = f32(1 / this.drive);
  }

  /** 0x3a640: srOs = sample rate * oversampling. */
  setSampleRate(srOs: number): void {
    this.maxFc = f32(f32(srOs * 0.5) * 0.999);
    this.omega = f32(f32(1 / srOs) * f32(3.1415927410125732));
  }

  /** 0x3a680: stage coefficients from the cutoff and resonance of every lane. */
  coeffs(): void {
    for (let l = 0; l < 4; l++) {
      const r = this.res[l];
      this.k[l] = f32(r * K42);
      this.res1[l] = f32(r + 1);
      let fc = this.cutoff[l];
      fc = fc < this.maxFc ? fc : this.maxFc;
      fc = fc > F20 ? fc : F20;
      const g = tanApprox(f32(fc * this.omega));
      const a = f32(1 / f32(g + 1));
      const G = f32(g * a);
      this.G[l] = G;
      this.A[l] = a;
      const g2 = f32(G * G);
      const g4 = f32(g2 * g2);
      this.G4[l] = g4;
      this.norm[l] = f32(1 / fma32(g4, this.k[l], 1));
    }
  }

  /** 0x3a7a0: one sample for the four lanes. */
  process(): void {
    const t = new Float32Array(4);
    for (let l = 0; l < 4; l++) {
      const A = this.A[l], G = this.G[l];
      const s0 = this.st[0][l], s1 = this.st[1][l], s2 = this.st[2][l], s3 = this.st[3][l];
      const t1 = f32(s0 * A), t2 = f32(A * s1), t3 = f32(A * s2), t4 = f32(A * s3);
      const t2f = fma32(t1, G, t2);
      const t3f = fma32(t2f, G, t3);
      const S = fma32(t3f, G, t4);
      const u0 = fma32(this.input[l], this.res1[l], f32(S * -this.k[l]));
      const u = f32(this.drivePre * u0);
      let x = f32(f32(tanhApprox(u) * this.drive) * this.norm[l]);
      t[0] = t1; t[1] = t2; t[2] = t3; t[3] = t4;
      for (let s = 0; s < 4; s++) {
        const st = this.st[s][l];
        const th = tanhApprox(f32(x - st));
        const v = f32(G * th);
        const o = fma32(x, G, t[s]);
        this.st[s][l] = f32(f32(v + v) + st);
        if (s === this.tap) this.out[l] = o;
        x = o;
      }
    }
  }
}
