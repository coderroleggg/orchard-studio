// Half-band decimator of the Kepler / Kepler Exo oversampling (engine.dylib 0x51e4, constructor 0x508c,
// driver 0x9e78): a polyphase pair of six all-pass sections for left and right. Each call takes one
// stereo sample at the high rate; the second sample of a pair completes an output sample.

import { f32, fma32 } from './fmath';

const COEF: [number, number][] = [
  [0.03668150305747986, 0.13654762506484985],
  [0.2746317684650421, 0.4231386184692383],
  [0.5610989928245544, 0.6775400638580322],
  [0.7697418332099915, 0.839889645576477],
  [0.8922607898712158, 0.9315419793128967],
  [0.9620945453643799, 0.9878163933753967],
];

const L4 = 4;

export class HalfBand {
  /** memory image of the filter object in 4-lane vectors (the engine's layout, 0x1a0 bytes) */
  private readonly m = new Float32Array(0x1a0 / 4);

  constructor() {
    for (let s = 0; s < 6; s++) {
      const [a, b] = COEF[s];
      const o = [0x00, 0x60, 0xa0, 0xe0, 0x120, 0x160][s] / 4;
      this.m[o] = f32(a); this.m[o + 1] = f32(a); this.m[o + 2] = f32(b); this.m[o + 3] = f32(b);
    }
  }

  private v(off: number, lane: number): number { return this.m[off / 4 + lane]; }

  /** 0x51e4: one stereo sample in `io` (L, R); the result replaces it. */
  step(io: Float32Array): void {
    const m = this.m;
    const L = io[0], R = io[1];
    const x = [L, R, L, R];
    const out = new Float32Array(4);
    const c = (off: number) => off / 4;
    // stage 1
    const q1 = [m[c(0x40)], m[c(0x40) + 1], m[c(0x40) + 2], m[c(0x40) + 3]];
    const q3 = [m[c(0x50)], m[c(0x50) + 1], m[c(0x50) + 2], m[c(0x50) + 3]];
    const q5 = [m[c(0x20)], m[c(0x20) + 1], m[c(0x20) + 2], m[c(0x20) + 3]];
    const q6 = [m[c(0x30)], m[c(0x30) + 1], m[c(0x30) + 2], m[c(0x30) + 3]];
    const co = (off: number, l: number) => m[c(off) + l];
    const v5 = new Array<number>(4);
    for (let l = 0; l < L4; l++) v5[l] = fma32(f32(x[l] - q1[l]), co(0x00, l), q5[l]);
    // shift the delay lines of stage 1
    for (let l = 0; l < L4; l++) {
      m[c(0x10) + l] = q1[l]; m[c(0x20) + l] = q6[l];
      m[c(0x30) + l] = x[l]; m[c(0x40) + l] = q3[l];
      m[c(0x50) + l] = v5[l];
    }
    // stage 2
    const q2 = [0, 1, 2, 3].map((l) => m[c(0x80) + l]);
    const q3b = [0, 1, 2, 3].map((l) => m[c(0x90) + l]);
    const v1 = new Array<number>(4);
    for (let l = 0; l < L4; l++) v1[l] = fma32(f32(v5[l] - q2[l]), co(0x60, l), q1[l]);
    for (let l = 0; l < L4; l++) { m[c(0x70) + l] = q2[l]; m[c(0x80) + l] = q3b[l]; m[c(0x90) + l] = v1[l]; }
    // stage 3
    const q3c = [0, 1, 2, 3].map((l) => m[c(0xc0) + l]);
    const q4c = [0, 1, 2, 3].map((l) => m[c(0xd0) + l]);
    const v2 = new Array<number>(4);
    for (let l = 0; l < L4; l++) v2[l] = fma32(f32(v1[l] - q3c[l]), co(0xa0, l), q2[l]);
    for (let l = 0; l < L4; l++) { m[c(0xb0) + l] = q3c[l]; m[c(0xc0) + l] = q4c[l]; m[c(0xd0) + l] = v2[l]; }
    // stage 4
    const q1d = [0, 1, 2, 3].map((l) => m[c(0x100) + l]);
    const q4d = [0, 1, 2, 3].map((l) => m[c(0x110) + l]);
    const v3 = new Array<number>(4);
    for (let l = 0; l < L4; l++) v3[l] = fma32(f32(v2[l] - q1d[l]), co(0xe0, l), q3c[l]);
    for (let l = 0; l < L4; l++) { m[c(0xf0) + l] = q1d[l]; m[c(0x100) + l] = q4d[l]; m[c(0x110) + l] = v3[l]; }
    // stage 5
    const q2e = [0, 1, 2, 3].map((l) => m[c(0x140) + l]);
    const q4e = [0, 1, 2, 3].map((l) => m[c(0x150) + l]);
    const v1b = new Array<number>(4);
    for (let l = 0; l < L4; l++) v1b[l] = fma32(f32(v3[l] - q2e[l]), co(0x120, l), q1d[l]);
    for (let l = 0; l < L4; l++) { m[c(0x130) + l] = q2e[l]; m[c(0x140) + l] = q4e[l]; m[c(0x150) + l] = v1b[l]; }
    // stage 6
    const q3f = [0, 1, 2, 3].map((l) => m[c(0x180) + l]);
    const q4f = [0, 1, 2, 3].map((l) => m[c(0x190) + l]);
    const v2b = new Array<number>(4);
    for (let l = 0; l < L4; l++) v2b[l] = fma32(f32(v1b[l] - q3f[l]), co(0x160, l), q2e[l]);
    for (let l = 0; l < L4; l++) { m[c(0x170) + l] = q3f[l]; m[c(0x180) + l] = q4f[l]; m[c(0x190) + l] = v2b[l]; }
    // output: left = 0.5 (v2b[0] + q4_old[2]); right = 0.5 (v2b[1] + m[0x18c] (old q4 lane 3))
    const l2 = q4f[2];
    out[0] = f32(0.5 * f32(v2b[0] + l2));
    out[1] = f32(f32(v2b[1] + m[(0x18c) / 4]) * 0.5);
    io[0] = out[0];
    io[1] = out[1];
  }
}
