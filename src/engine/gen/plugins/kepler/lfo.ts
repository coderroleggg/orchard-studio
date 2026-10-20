// Kepler / Kepler Exo low frequency oscillators (engine.dylib 0x2d058: LFO1, 0x2d188: LFO2, setters
// 0x2d018 / 0x2d020 / 0x2d04c / 0x2d174). Both run once per output sample with the song time passed in
// (tempo-synced rates use its difference per sample).
//
// LFO1 outputs a triangle (out18, +-0.5), its unipolar copy (out10) and a table sine (out14); LFO2 outputs
// one of six shapes in out18 / out10. The sine table is a 2170-point shape stored in FL's engine (an
// analog-looking sine with a slight phase offset and 2nd / 3rd harmonics); it is FL content, so a
// synthesised sine of that character stands in unless the user's table is imported (setLfoTable).

import { f32, fma32 } from './fmath';
import { sinf } from './applemath';

const N_SINE = 2170;
let sineTable: Float32Array = buildSubstituteSine();
/** the table instances start with: the stand-in, or what setLfoTable installed (tests, the user's import) */
let defaultSine: Float32Array = sineTable;

function buildSubstituteSine(): Float32Array {
  // an analog-looking sine: the fundamental with a 3 % second and a 1.3 % third harmonic (the shape of FL's table within 1 %)
  const pts = new Float64Array(N_SINE);
  for (let i = 0; i < N_SINE; i++) {
    const x = (2 * Math.PI * i) / N_SINE;
    pts[i] = Math.round(31800 * (Math.sin(x - 0.014) + 0.0304 * Math.sin(2 * x + 1.075) + 0.0128 * Math.sin(3 * x + 0.074)));
  }
  return normalise(pts);
}

/** The sine table of FL's 2170 signed 16-bit points, normalised like the engine does (0x2ce6c); null = the stand-in. */
export function buildSineTable(pts: ArrayLike<number> | null): Float32Array {
  if (!pts || pts.length < N_SINE) return defaultSine;
  return normalise(pts);
}

/** 0x2ce6c: the points scaled to +-1 around the middle of their range, with two guard entries for the interpolation. */
function normalise(pts: ArrayLike<number>): Float32Array {
  const k = f32(1 / 32768);
  let mx = 0, mn = 0;
  const s = new Float32Array(N_SINE);
  for (let i = 0; i < N_SINE; i++) {
    const v = f32(pts[i] * k);
    s[i] = v;
    if (v > mx) mx = v;
    if (v < mn) mn = v;
  }
  const mid = f32(f32(mn + mx) * 0.5);
  const r = f32(1 / f32(mx - mid));
  const t = new Float32Array(N_SINE + 2);
  for (let i = 0; i < N_SINE; i++) t[i] = f32(r * f32(f32(s[i] * 1) - mid));
  t[N_SINE] = t[0];
  t[N_SINE + 1] = t[1];
  return t;
}

/** Process-wide default table (tests / the engine's default); instances can carry their own (KLfo1.sine). */
export function setLfoTable(pts: ArrayLike<number> | null): void {
  defaultSine = pts && pts.length >= N_SINE ? buildSineTable(pts) : sineTable;
}

/** Common LFO state (object layout shared by both classes). */
export class KLfo {
  inc = 0;            // @0x00 f64 phase increment per sample (cycles)
  rate = 0;           // @0x08 f64 tempo-sync scale (cycles per time unit)
  out10 = 0;          // @0x10 f32 unipolar copy
  out14 = 0;          // @0x14 f32 table sine / 2 (LFO1)
  out18 = 0;          // @0x18 f32 shape value (+-0.5)
  resync = false;     // @0x1c u8 (re-read the song time at the next tick)
  sync = false;       // @0x1d u8 tempo sync
  wrapped = false;    // @0x1e u8 phase wrapped at the last tick
  lastTime = 0;       // @0x20 f64
  rnd0 = 0;           // @0x28 f32 smooth random from
  rnd1 = 0;           // @0x2c f32 smooth random to
  seed = 22222;       // @0x30 u32 random seed (LCG)
  shape = 0;          // @0x34 i32 (LFO2)
  phase = 0;          // @0x38 f64

  /** 0x2d018: LFO2 shape. */
  setShape(s: number): void { this.shape = s; }
  /** 0x2d174: tempo sync on/off. */
  setSync(on: boolean): void { if (this.sync !== on) this.sync = on; }
  /** 0x2d04c: re-read the song time at the next tick. */
  requestResync(): void { this.resync = true; }
  /** 0x2d020: restart at phase x (0..1). */
  setPhase(x: number): void {
    const m = f32(Math.min(x, 0.9999989867210388));
    this.phase = x < 0 ? f32(x) : m;
    this.wrapped = true;
  }

  protected common(time: number): void {
    if (this.sync) {
      let d = (time - this.lastTime) * this.rate;
      this.lastTime = time;
      if (d >= 0 && d >= 1) { /* keep the previous increment */ } else if (d >= 0) this.inc = d;
    }
    const ph = this.phase + this.inc;
    this.phase = ph;
    this.wrapped = ph >= 1;
    if (ph >= 1) this.phase = ph + -1;
  }
}

/** LFO1: triangle + table sine. */
export class KLfo1 extends KLfo {
  /** the sine table this LFO reads (FL's, or the stand-in) */
  sine: Float32Array = defaultSine;
  tick(time: number): void {
    if (this.resync) { this.lastTime = time; this.resync = false; }
    const ph = this.phase;
    const s3 = f32(ph);
    let tri: number;
    if (s3 >= 0.25) {
      tri = s3 >= 0.75 ? fma32(f32(s3 + -0.75), 4, -1) : fma32(f32(s3 + -0.25), -4, 1);
    } else tri = f32(s3 * 4);
    tri = f32(tri * 0.5);
    this.out18 = tri;
    // table sine, linear interpolation: p = s3 * 2170
    const p = f32(s3 * N_SINE);
    const i = Math.trunc(p);
    const fr = f32(p - i);
    const a = this.sine[i], b = this.sine[i + 1];
    this.out14 = f32(fma32(a, f32(1 - fr), f32(b * fr)) * 0.5);
    this.common(time);
    this.out10 = f32(this.out18 + 0.5);
  }
}

/** LFO2: six shapes. */
export class KLfo2 extends KLfo {
  tick(time: number): void {
    if (this.resync) { this.lastTime = time; this.resync = false; }
    const ph = this.phase;
    const s0 = f32(ph);
    let v: number;
    switch (this.shape) {
      case 0: // triangle
        if (s0 >= 0.25) v = s0 >= 0.75 ? fma32(f32(s0 + -0.75), 4, -1) : fma32(f32(s0 + -0.25), -4, 1);
        else v = f32(s0 * 4);
        v = f32(v * 0.5);
        break;
      case 1: v = f32(fma32(s0, 2, -1) * 0.5); break;      // saw up
      case 2: v = f32(fma32(s0, -2, 1) * 0.5); break;      // saw down
      case 3: v = f32(sinf(f32(s0 * f32(6.2831854820251465))) * 0.5); break; // sine
      case 4: // sample & hold: a new value when the previous tick wrapped, else unchanged
        if (this.wrapped) {
          this.seed = (Math.imul(this.seed, 0x0bb38435) + 0x3619636b) | 0;
          this.out18 = f32(f32(f32(this.seed) * f32(4.656612873077393e-10)) * 0.5); // 2^-31
        }
        v = this.out18;
        break;
      case 5: // smoothed random: ramp from the previous value to a new random target over a cycle
        if (this.wrapped) {
          this.seed = (Math.imul(this.seed, 0x0bb38435) + 0x3619636b) | 0;
          const r = f32(f32(this.seed) * f32(4.656612873077393e-10));
          const s1 = this.out18;
          this.rnd0 = s1;
          this.rnd1 = fma32(r, 0.5, -s1);
        }
        v = fma32(this.rnd1, s0, this.rnd0);
        break;
      default: v = 0;
    }
    this.out18 = v;
    this.common(time);
    this.out10 = f32(this.out18 + 0.5);
  }
}
