// FL's biquad record (the 0x78-byte record of Ogun_x64: type, state, coefficients) with its two routines: the design
// function 0x7ef40 (RBJ forms for types 1..8) and the stereo direct form I in doubles (library entry G[3f49d0]).
// Used by the voice filter (types 1..4) and the three EQ bands (6 low shelf, 7 peaking, 8 high shelf).

const f32 = Math.fround;

export class Biquad {
  /** +0x00 type: 1 low pass, 2 band pass, 3 notch, 4 high pass, 5 all pass, 6 low shelf, 7 peaking, 8 high shelf. */
  type = 1;
  /** +0x10..+0x4f state: previous inputs, outputs (two channels). */
  readonly x1 = new Float64Array(2);
  readonly x2 = new Float64Array(2);
  readonly y1 = new Float64Array(2);
  readonly y2 = new Float64Array(2);
  /** +0x50 b0, +0x58 b1, +0x60 b2, +0x68 a1, +0x70 a2 */
  b0 = 0; b1 = 0; b2 = 0; a1 = 0; a2 = 0;

  clearState(): void {
    this.x1.fill(0); this.x2.fill(0); this.y1.fill(0); this.y2.fill(0);
  }

  /**
   * 0x7ef40(rec, A, d1, sin, cos): `d1` is alpha for types 1..5 and 7, and 2 sqrt(A) alpha / sin for the shelves.
   * Every operation in double, in the binary's order.
   */
  design(A: number, d1: number, sin: number, cos: number): void {
    switch (this.type) {
      case 1: {
        const d5 = 1 / (1 + d1);
        this.a1 = d5 * (-2 * cos);
        this.a2 = d5 * (1 - d1);
        this.b1 = d5 * (1 - cos);
        this.b0 = this.b1 * 0.5;
        this.b2 = this.b0;
        break;
      }
      case 2: {
        const d5 = 1 / (1 + d1);
        this.a1 = d5 * (-2 * cos);
        this.a2 = d5 * (1 - d1);
        this.b1 = 0;
        this.b0 = d5 * d1;
        this.b2 = d5 * -d1;
        break;
      }
      case 3: {
        const d5 = 1 / (1 + d1);
        this.a1 = d5 * (-2 * cos);
        this.a2 = d5 * (1 - d1);
        this.b1 = this.a1;
        this.b0 = d5;
        this.b2 = d5;
        break;
      }
      case 4: {
        const d5 = 1 / (1 + d1);
        this.a1 = d5 * (-2 * cos);
        this.a2 = d5 * (1 - d1);
        this.b1 = d5 * -(1 + cos);
        this.b0 = -this.b1 * 0.5;
        this.b2 = this.b0;
        break;
      }
      case 5: {
        const d5 = 1 / (1 + d1);
        this.a1 = d5 * (-2 * cos);
        this.a2 = d5 * (1 - d1);
        this.b1 = this.a1;
        this.b0 = this.a2;
        this.b2 = 1;
        break;
      }
      case 6: {
        const d4 = (A - 1) * cos;
        const d6 = d1 * sin;
        const d5 = 1 / (A + 1 + d4 + d6);
        this.a1 = d5 * (-2 * (A - 1 + (A + 1) * cos));
        this.a2 = d5 * (A + 1 + d4 - d6);
        this.b1 = d5 * (2 * A * (A - 1 - (A + 1) * cos));
        this.b0 = d5 * (A * (A + 1 - d4 + d6));
        this.b2 = d5 * (A * (A + 1 - d4 - d6));
        break;
      }
      case 7: {
        const d4 = d1 / A;
        const d5 = 1 / (1 + d4);
        this.a1 = d5 * (-2 * cos);
        this.a2 = d5 * (1 - d4);
        this.b1 = this.a1;
        const e = d1 * A;
        this.b0 = d5 * (1 + e);
        this.b2 = d5 * (1 - e);
        break;
      }
      case 8: {
        const d4 = (A - 1) * cos;
        const d6 = d1 * sin;
        const d5 = 1 / (A + 1 - d4 + d6);
        this.a1 = d5 * (2 * (A - 1 - (A + 1) * cos));
        this.a2 = d5 * (A + 1 - d4 - d6);
        this.b1 = d5 * (-2 * A * (A - 1 + (A + 1) * cos));
        this.b0 = d5 * (A * (A + 1 + d4 + d6));
        this.b2 = d5 * (A * (A + 1 + d4 - d6));
        break;
      }
    }
  }

  /** Direct form I in doubles on n interleaved stereo float frames, in place (G[3f49d0] entry 0). */
  process(io: Float32Array, n: number, off = 0): void {
    const { b0, b1, b2, a1, a2 } = this;
    let x1l = this.x1[0], x1r = this.x1[1], x2l = this.x2[0], x2r = this.x2[1];
    let y1l = this.y1[0], y1r = this.y1[1], y2l = this.y2[0], y2r = this.y2[1];
    for (let i = 0; i < n; i++) {
      const o = 2 * (off + i);
      const il = io[o], ir = io[o + 1];
      let t = b2 * x2l + b1 * x1l;
      t = t - a1 * y1l;
      let y = t - a2 * y2l;
      y = y + b0 * il;
      io[o] = f32(y);
      y2l = y1l; x2l = x1l; x1l = il; y1l = y;
      t = b2 * x2r + b1 * x1r;
      t = t - a1 * y1r;
      let z = t - a2 * y2r;
      z = z + b0 * ir;
      io[o + 1] = f32(z);
      y2r = y1r; x2r = x1r; x1r = ir; y1r = z;
    }
    this.x1[0] = x1l; this.x1[1] = x1r; this.x2[0] = x2l; this.x2[1] = x2r;
    this.y1[0] = y1l; this.y1[1] = y1r; this.y2[0] = y2l; this.y2[1] = y2r;
  }
}
