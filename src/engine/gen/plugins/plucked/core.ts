// Plucked! voice: a line-by-line port of FL Studio's Plucked! (FPC plugin
// Plucked!_x64.dylib, FL 2026 arm64 addresses in brackets), in FL's single
// precision (FPC rounds every single operation; no fused multiply-add).
// See docs/research/gen/plucked.md.
//
// - Init [0x5d530] (TriggerVoice): the pitch, rounded to cents and folded
//   into -37..36 semitones, sets an integer delay length N = round(rate /
//   (523.25 Hz x 2^((p - 1200) / 1200))) (no fractional delay); the line is
//   filled with a square wave (+-(1 - colour) / 2) or the channel sample's
//   shape (x (1 - colour)), plus colour x white noise from FPC's Random; Widen
//   gives a second line (other noise) for the right channel.
// - Decay [0x5e120]: feedback g = 0.95 + 0.0499 ln(Decay + Mod X + 1) / ln 257,
//   raised to 1 / (frequency ratio) with Normalize decay; coefficient g / 2.
// - Render [0x5e230]: Karplus-Strong: out = x[n], x[n] <- g/2 (x[n] + x[n-1]);
//   levels through FL's pan law and AddWave ramp; with Short release a note
//   off ramps the gains to 0 and ends the voice; otherwise it ends when its
//   peak over a 256+ sample window drops below 0.004.

import { f } from '../boobass/f32';
import { FlRamp, flComputeLRVol, flLR } from '../boobass/flhost';
import { fpcRandom } from './fpcrandom';

const INV1200 = Math.fround(1 / 1200);
const C5 = 523.251130601197;
const LN257 = 5.54907608489522;
const DECAY_SPAN = 0.049900000000000055;
const END_PEAK = Math.fround(0.004);

/** Round half to even (arm64 frintx with the default rounding mode). */
function rint(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && (r & 1) !== 0 ? r - 1 : r;
}

/** FPC's IntPower (binary exponentiation in double). */
function intPower(b0: number, n0: number): number {
  let b = b0, n = n0;
  if (b === 0 && n === 0) return 1;
  if (n < 0) { b = 1 / b; n = -n; }
  let r = 1;
  while (n > 0) {
    while ((n & 1) === 0) { n >>= 1; b = b * b; }
    n -= 1;
    r = r * b;
  }
  return r;
}

/** FPC's Math.Power(Single, Single) [0x144ea0]. */
export function fpcPowerS(base: number, e: number): number {
  if (e === 0) return 1;
  if (base === 0 && e > 0) return 0;
  if (f(Math.trunc(f(e + 0.5))) === e) {
    const n = rint(e);
    if (n === 0) return 1;
    if (base === 0 && n > 0) return 0;
    return f(intPower(base, n));
  }
  return f(Math.exp(e * Math.log(base)));
}

/** Delay length and frequency ratio for FL's final pitch (cents, 0 = C5). */
export function pluckTuning(pitch: number, sr: number): { n: number; ratio: number } {
  let p = rint(pitch);
  if (p < -3600) p = ((p + 100) % 1200) - 2500;
  else if (p >= 3600) p = (p % 1200) + 2400;
  const ratio = fpcPowerS(2, f(1 + f(f(p - 2400) * INV1200)));
  return { n: rint(sr / (ratio * C5)) | 0, ratio };
}

export class PluckVoice {
  /** FL's voice record fields. */
  n = 0;
  readonly buf: Float32Array;
  pos = 0;
  /** Previous read sample of the left / right line (+0x24 / +0x28). */
  y1 = 0; y2 = 0;
  /** Mod X the decay was computed for (+0x30) and the coefficient g / 2 (+0x34). */
  fcut = 0;
  coef = 0;
  /** Normalize decay (+0x4c) with 1 / ratio (+0x2c), Widen (+0x4e). */
  norm = false;
  invRatio = 1;
  widen = false;
  /** Running peak (+0x38), the last window's peak (+0x3c), samples counted (+0x40, -1 = first render). */
  peak = 0;
  lastPeak = 1;
  count = -1;
  /** AddWave's last gains (+0x44, +0x48). */
  lastL = 0; lastR = 0;
  /** Released (+0x4d): gains ramp to 0, then the voice ends. */
  released = false;
  /** Still sounding (FL has not killed it). */
  alive = false;
  /** The current block's ramp and peak. */
  private readonly ramp = new FlRamp();
  private blockPeak = 0;

  constructor(maxLen: number) {
    this.buf = new Float32Array(maxLen * 2);
  }

  /**
   * TriggerVoice's init [0x5d530] and decay [0x5e120]: pitch / Mod X / Mod Y
   * are FL's FinalLevels at the trigger; `shape` = the channel sample's
   * 16384-point shape or null. Returns false when the line would not fit.
   */
  start(pitch: number, fcut: number, fres: number, p: PluckParams, sr: number, shape: Float32Array | null): boolean {
    const t = pluckTuning(pitch, sr);
    const n = t.n;
    if (n < 1 || n > this.buf.length / 2) return false;
    this.n = n;
    this.norm = p.norm > 0;
    if (this.norm) this.invRatio = f(1 / t.ratio);
    this.widen = p.widen > 0;
    let c = rint(f(fres * 128)) + p.color;
    c = c > 0 ? (c > 128 ? 128 : c) : 0;
    const color = f(c * 0.0078125);
    let amp = f(1 - color);
    const b = this.buf;
    if (shape) {
      const step = Math.floor(4294967296 / n);
      let x = 0;
      for (let j = 0; j < n; j++) {
        const i0 = Math.floor(x / 262144);
        const s4 = shape[i0 & 16383];
        const s1 = f(shape[(i0 + 1) & 16383] - s4);
        const fr = f((x % 262144) * 3.814697265625e-6);
        b[j] = f(f(s4 + f(s1 * fr)) * amp);
        x += step;
      }
    } else {
      amp = f(amp * 0.5);
      const h = n >> 1;
      b.fill(amp, 0, h);
      b.fill(-amp, h, n);
    }
    if (this.widen) for (let j = 0; j < n; j++) b[n + j] = f(b[j] + (fpcRandom() * 2 - 1) * color);
    for (let j = 0; j < n; j++) b[j] = f(b[j] + (fpcRandom() * 2 - 1) * color);
    this.pos = 0;
    this.y1 = 0; this.y2 = 0;
    this.peak = 0; this.lastPeak = 1; this.count = -1;
    this.released = false;
    this.alive = true;
    this.fcut = fcut;
    this.decay(p);
    return true;
  }

  /** Decay coefficient [0x5e120] from the Decay parameter and Mod X. */
  decay(p: PluckParams): void {
    let d = rint(f(this.fcut * 256)) + p.decay;
    d = d > 0 ? (d > 256 ? 256 : d) : 0;
    const g = f(0.95 + f(Math.log(f(d + 1)) / LN257) * DECAY_SPAN);
    this.coef = f((this.norm ? fpcPowerS(g, this.invRatio) : g) * 0.5);
  }

  /**
   * Start of an FL Gen_Render block of n samples [0x5e230]: decay update
   * (Mod X changed, or the Decay parameter since the last block), the levels
   * through FL's pan law (0 once released) and the AddWave ramp setup.
   */
  begin(n: number, pan: number, vol: number, fcut: number, recompute: boolean, p: PluckParams, sr: number): void {
    if (fcut !== this.fcut) { this.fcut = fcut; this.decay(p); } else if (recompute) this.decay(p);
    let lv = 0, rv = 0;
    if (!this.released) { flComputeLRVol(pan, vol); lv = flLR.l; rv = flLR.r; }
    if (this.count < 0) { this.lastL = lv; this.lastR = rv; this.count = 0; }
    this.ramp.begin(lv, rv, n, this, sr);
    this.blockPeak = 0;
  }

  /** The next m samples of the block (Karplus-Strong loop, AddWave), added to L / R at `off`; `tmp` >= 2m. */
  part(L: Float32Array, R: Float32Array, off: number, m: number, tmp: Float32Array): void {
    const b = this.buf, len = this.n, c = this.coef;
    let pos = this.pos;
    if (this.widen) {
      let s9 = this.y1, s1 = this.y2;
      for (let i = 0; i < m; i++) {
        const x = b[pos];
        tmp[2 * i] = x;
        b[pos] = f(c * f(x + s9));
        s9 = x;
        const x2 = b[pos + len];
        tmp[2 * i + 1] = x2;
        b[pos + len] = f(c * f(x2 + s1));
        s1 = x2;
        if (++pos >= len) pos = 0;
      }
      this.y1 = s9; this.y2 = s1;
    } else {
      let s9 = this.y1;
      for (let i = 0; i < m; i++) {
        const x = b[pos];
        tmp[i] = x;
        b[pos] = f(c * f(x + s9));
        s9 = x;
        if (++pos >= len) pos = 0;
      }
      this.y1 = s9;
    }
    this.pos = pos;
    this.ramp.add(tmp, L, R, off, m, this.widen);
    if (!this.released) {
      let pk = this.blockPeak;
      const k = this.widen ? 2 * m : m;
      for (let i = 0; i < k; i++) { const a = Math.abs(tmp[i]); if (a > pk) pk = a; }
      this.blockPeak = pk;
    }
  }

  /** End of the block (n samples long): a released voice ends once its gains reached 0, else the peak window check. */
  end(n: number): void {
    if (this.released) {
      if (this.lastL === 0 && this.lastR === 0) this.alive = false;
      return;
    }
    if (this.blockPeak > this.peak) this.peak = this.blockPeak;
    this.count += n;
    if (this.count > 256) {
      this.count = 0;
      this.lastPeak = this.peak;
      if (this.peak < END_PEAK) this.alive = false;
      else this.peak = 0;
    }
  }
}

/** The plugin parameters a voice reads (FL's +0x130..+0x140). */
export interface PluckParams { decay: number; color: number; norm: number; gate: number; widen: number }
