// FL's gain ramp (shared FL DSP code, 0x28-byte struct: targets +0x4 / +0x8,
// current +0x14 / +0x18, coefficient +0x24): per-sample one-pole glide of a
// stereo gain pair. Harmor uses it for the voices' bus gains (voice +0x22c /
// +0x254), the tremolo depth (part +0x624) and the post-FX volume (plug +0x10ac).

const f = Math.fround;
const TINY = 5.960464477539063e-8;
const PI_4 = 0.7853981633974483;
const SQRT2F = f(Math.SQRT2);

export class GainRamp {
  tL = 0; tR = 0; cL = 0; cR = 0;
  coef = 0;
  /** 0x461610. */
  reset(coef: number): void { this.tL = this.tR = this.cL = this.cR = 0; this.coef = coef; }
  /** 0x460e20 with mode 0: equal-power pan law 0x19c0 with gain * sqrt 2. */
  set(pan: number, gain: number): void {
    if (pan === 0) { this.tL = this.tR = f(gain); return; }
    if (gain === 0) { this.tL = this.tR = 0; return; }
    const g = f(gain * SQRT2F);
    const a = f(f(pan + 1) * PI_4);
    this.tL = f(f(Math.cos(a)) * g);
    this.tR = f(f(Math.sin(a)) * g);
  }
  /** 0x460c90: silent (targets and current all zero). */
  silent(): boolean { return this.tL === 0 && this.tR === 0 && this.cL === 0 && this.cR === 0; }
  /** 0x460af0: still gliding (else current snaps to the targets). */
  private gliding(): boolean {
    if (Math.abs(this.cR - this.tR) > TINY || Math.abs(this.cL - this.tL) > TINY) return true;
    this.cL = this.tL; this.cR = this.tR;
    return false;
  }
  /** 0x460410: add mono src * gains into interleaved stereo dst. */
  mixMono(src: Float32Array, dst: Float32Array, n: number, so: number, dsto: number): void {
    if (this.gliding()) {
      let dL = f(this.cL - this.tL), dR = f(this.cR - this.tR);
      const c = this.coef;
      for (let i = 0; i < n; i++) {
        dL = f(dL * c); dR = f(dR * c);
        const x = src[so + i], k = dsto + 2 * i;
        dst[k] = f(dst[k] + f(x * f(dL + this.tL)));
        dst[k + 1] = f(dst[k + 1] + f(x * f(dR + this.tR)));
      }
      this.cL = f(dL + this.tL); this.cR = f(dR + this.tR);
      return;
    }
    if (this.tL === 0 && this.tR === 0) return;
    const gL = this.tL, gR = this.tR;
    for (let i = 0; i < n; i++) {
      const x = src[so + i], k = dsto + 2 * i;
      dst[k] = f(dst[k] + f(x * gL));
      dst[k + 1] = f(dst[k + 1] + f(x * gR));
    }
  }
  /** 0x460370: add interleaved stereo src * gains into dst. */
  mixStereo(src: Float32Array, dst: Float32Array, n: number, so: number, dsto: number): void {
    if (this.gliding()) {
      let dL = f(this.cL - this.tL), dR = f(this.cR - this.tR);
      const c = this.coef;
      for (let i = 0; i < n; i++) {
        dL = f(dL * c); dR = f(dR * c);
        const k = 2 * i;
        dst[dsto + k] = f(dst[dsto + k] + f(src[so + k] * f(dL + this.tL)));
        dst[dsto + k + 1] = f(dst[dsto + k + 1] + f(src[so + k + 1] * f(dR + this.tR)));
      }
      this.cL = f(dL + this.tL); this.cR = f(dR + this.tR);
      return;
    }
    if (this.tL === 0 && this.tR === 0) return;
    const gL = this.tL, gR = this.tR;
    for (let i = 0; i < n; i++) {
      const k = 2 * i;
      dst[dsto + k] = f(dst[dsto + k] + f(src[so + k] * gL));
      dst[dsto + k + 1] = f(dst[dsto + k + 1] + f(src[so + k + 1] * gR));
    }
  }
  /** 0x4604a0: multiply interleaved stereo src by the gains into dst (in place allowed). */
  mulStereo(src: Float32Array, dst: Float32Array, n: number, so = 0, dsto = 0): void {
    if (this.gliding()) {
      let dL = f(this.cL - this.tL), dR = f(this.cR - this.tR);
      const c = this.coef;
      for (let i = 0; i < n; i++) {
        dL = f(dL * c); dR = f(dR * c);
        const k = 2 * i;
        dst[dsto + k] = f(src[so + k] * f(dL + this.tL));
        dst[dsto + k + 1] = f(src[so + k + 1] * f(dR + this.tR));
      }
      this.cL = f(dL + this.tL); this.cR = f(dR + this.tR);
      return;
    }
    const gL = this.tL, gR = this.tR;
    if (gL === 0 && gR === 0) { dst.fill(0, dsto, dsto + 2 * n); return; }
    for (let i = 0; i < n; i++) {
      const k = 2 * i;
      dst[dsto + k] = f(src[so + k] * gL);
      dst[dsto + k + 1] = f(src[so + k + 1] * gR);
    }
  }
}
