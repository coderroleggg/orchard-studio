// Kepler / Kepler Exo Juno-style chorus (engine.dylib 0xe8d8 process, 0xe554 constructor, 0xe794 sample rate,
// 0x9f38 mode switch): the stereo input is summed to mono, high-passed at 50 Hz and low-passed by two 7 kHz
// biquads, written to a pair of delay lines whose read positions follow two low-frequency oscillators (a triangle
// or sine, the right one offset in phase), fed back (the Juno modes use no feedback) and mixed equal-power with
// the dry signal; the optional chorus noise is a filtered LCG noise whose peaking-filter gain follows the LFOs.

import { f32, fma32 } from './fmath';
import { sinf } from './applemath';
import { OnePole } from './onepole';
import { Biquad, BQ } from './biquad';

/** 0x35dc / 0x366c / 0x36a4: a 32768-point delay line with a cubic interpolating read. */
class DelayLine {
  readonly buf = new Float32Array(0x8000);
  idx = 0;
  readonly mask = 0x7fff;

  write(x: number): void {
    this.buf[this.idx] = x;
    this.idx = (this.idx + 1) & this.mask;
  }

  /** Read `d` samples back (fractional). */
  read(d: number): number {
    const b = this.buf, m = this.mask, i = this.idx;
    const di = Math.trunc(d);
    const i12 = (i - di) | 0;
    const y0 = b[i12 & m];
    const y1 = b[(i + ~di) & m];
    const y2 = b[(i12 - 2) & m];
    const y3 = b[(i12 - 3) & m];
    const fr = f32(d - di);
    const c = f32(f32(y2 - y0) * 0.5);
    const a = f32(y1 - y2);
    const s6 = f32(a + c);
    let s3 = f32(a + s6);
    s3 = fma32(f32(y3 - y1), 0.5, s3);
    const s4 = f32(s6 + s3);
    s3 = fma32(s3, fr, -s4);
    const s1 = fma32(s3, fr, c);
    return fma32(s1, fr, y1);
  }

  clear(): void { this.buf.fill(0); this.idx = 0; }
}

/** 0xfc18 / 0xfc4c: the noise gate that closes the hiss when the signal is quiet. */
class NoiseGate {
  threshold = f32(0.0024999999441206455);   // @0
  hold = 440;                               // @4
  counter = 440;                            // @8
  gain = f32(1);                            // @0xc
  decay = f32(0.9996519684791565);          // @0x10

  process(io: Float32Array): void {
    const a = Math.abs(io[0]), b = Math.abs(io[1]), t = this.threshold;
    let n: number;
    if (a < t && b < t) n = this.counter;
    else { n = this.hold; this.counter = n; this.gain = 1; }
    n -= 1;
    if (n < 0) this.gain = f32(this.decay * this.gain);
    else this.counter = n;
    const g = this.gain;
    io[0] = f32(g * io[0]);
    io[1] = f32(g * io[1]);
  }
}

const TWO_PI = f32(6.2831854820251465);
const INV_2_31 = f32(4.656612873077393e-10);
/** FL hands every new chorus the next seed of a process-wide counter (@ed79c, 333784 for the first); an instance here always gets the first */
const SEED0 = 333784;

export class JunoChorus {
  mono = true;                     // @0
  shape = 0;                       // @0x10 (1 = sine, else triangle)
  inc = f32(9.070295163837727e-06); // @0x14
  phase = 0;                       // @0x18
  phOff = f32(0.5);                // @0x1c
  base = f32(0.00107999995816499); // @0x20
  max = f32(0.005229999776929617); // @0x24
  range = 0;                       // @0x28
  readonly dl = new DelayLine();   // @0x30
  readonly dr = new DelayLine();   // @0x50
  readonly hpIn = new OnePole();   // @0x70
  readonly lpOut = new OnePole();  // @0xa8
  readonly bq1 = new Biquad();     // @0xe0
  readonly bq2 = new Biquad();     // @0x12c
  readonly bqNoise = new Biquad(); // @0x190
  readonly gate = new NoiseGate(); // @0x1e0
  feedback = 0;                    // @0x178
  fbL = 0; fbR = 0;                // @0x17c / 0x180
  seedL: number; seedR: number;    // @0x184 / 0x188
  noiseLevel = f32(0.009999999776482582); // @0x18c
  gateOn = false;                  // @0x1dc
  gainTarget = 1;                  // @0x200
  polarity = 1;                    // @0x204
  mixTarget = 0.5;                 // @0x208
  mixCur = 0;                      // @0x20c
  gainCur = 0;                     // @0x210
  m214 = 0;                        // @0x214
  coef = 0;                        // @0x218
  tL = f32(0.009999999776482582); tR = f32(0.009999999776482582); // @0x21c / 0x220
  sr = 44100; invSr = f32(1 / 44100); // @0x230 / 0x234
  counter = 16;                    // @0x238
  private readonly n = new Float32Array(2);

  constructor() {
    this.seedL = SEED0 | 0;
    this.seedR = (SEED0 + 0x1099e) | 0;
  }

  /** 0xe794 */
  setSampleRate(sr: number): void {
    this.coef = f32(1 - Math.pow(0.09999999999999998, 1 / (sr * 0.05)));
    const s = f32(sr);
    this.sr = s;
    this.invSr = f32(1 / s);
    this.counter = 16;
    this.hpIn.setSampleRate(s);
    this.lpOut.setSampleRate(s);
    this.bq1.setSampleRate(s);
    this.bq2.setSampleRate(s);
    this.hpIn.setHighpass(50);
    this.lpOut.setLowpass(7000);
    this.bq1.designLeft(BQ.LOW_PASS, 7000, f32(0.7070000171661377), 0, false);
    this.bq2.copyFrom(this.bq1);
    this.bqNoise.setSampleRate(s);
  }

  /** 0x9f38 (chorus part): a mode 1..3 sets the LFO, delay range, shape and phase offset. */
  setMode(mode: number): void {
    if (mode === 0) return;
    if (mode === 3) {
      this.inc = f32(8 / this.sr);
      this.mixTarget = f32(0.5);
      this.polarity = 1;
      this.feedback = 0;
      this.hpIn.setHighpass(f32(0.5));
      this.phOff = f32(0.028611112385988235);
      this.shape = 1;
      this.base = f32(0.002850000048056245); this.range = f32(this.max - this.base);
      this.max = f32(0.003370000049471855); this.range = f32(this.max - this.base);
    } else {
      this.inc = f32((mode === 1 ? f32(0.4000000059604645) : f32(0.6000000238418579)) / this.sr);
      this.mixTarget = f32(0.5);
      this.polarity = 1;
      this.feedback = 0;
      this.hpIn.setHighpass(f32(0.5));
      this.phOff = f32(0.5);
      this.shape = 0;
      this.base = f32(0.00107999995816499); this.range = f32(this.max - this.base);
      this.max = f32(0.005229999776929617); this.range = f32(this.max - this.base);
    }
  }

  /** 0xed1c: the noise level (parameter 70 cubed); the gate opens above 8 times that. */
  setNoise(v3: number): void {
    this.noiseLevel = f32(v3 * f32(0.20000000298023224));
    this.gate.threshold = f32(this.noiseLevel * 8);
  }

  setGate(on: boolean): void { this.gateOn = on; }

  clear(): void {
    this.dl.clear(); this.dr.clear();
    this.hpIn.clear(); this.lpOut.clear(); this.bq1.clear(); this.bq2.clear(); this.bqNoise.clear();
    this.fbL = 0; this.fbR = 0;
  }

  private tri(p: number): number {
    const a = p >= 0.75 ? f32(f32(p + -0.75) * 2) : f32(f32(1.5 - p) - p);
    return p >= 0.25 ? a : fma32(p, 2, 0.5);
  }

  /** 0xe8d8: one stereo sample in place. */
  process(io: Float32Array): void {
    if (this.mono) {
      const s = f32(f32(io[0] + io[1]) * 0.5);
      io[0] = s; io[1] = s;
    }
    const p0 = this.phase;
    const q = f32(p0 + this.phOff);
    let p1 = f32(q - Math.trunc(q));
    let s8: number, s9: number;
    if (this.shape === 1) {
      s8 = fma32(sinf(f32(p0 * TWO_PI)), 0.5, 0.5);
      s9 = fma32(sinf(f32(p1 * TWO_PI)), 0.5, 0.5);
    } else {
      s8 = this.tri(p0);
      s9 = this.tri(p1);
    }
    const tl = fma32(this.range, s8, this.base);
    const tr = fma32(this.range, s9, this.base);
    this.tL = fma32(f32(tl - this.tL), this.coef, this.tL);
    this.tR = fma32(f32(tr - this.tR), this.coef, this.tR);
    const np = f32(p0 + this.inc);
    this.phase = f32(np - Math.trunc(np));
    // feedback, then the input filters (50 Hz high-pass, two 7 kHz low-pass biquads)
    const io2 = this.io2;
    io2[0] = fma32(this.feedback, this.fbL, io[0]);
    io2[1] = fma32(this.feedback, this.fbR, io[1]);
    this.hpIn.process(io2);
    this.bq1.process(io2);
    this.bq2.process(io2);
    this.dl.write(io2[0]);
    let oL = this.dl.read(f32(this.tL * this.sr));
    this.dr.write(io2[1]);
    let oR = this.dr.read(f32(this.tR * this.sr));
    this.fbL = oL; this.fbR = oR;
    if (this.noiseLevel > 0) {
      const a = (Math.imul(this.seedL, 0x0bb38435) + 0x3619636b) | 0;
      const b = (Math.imul(this.seedR, 0x0bb38435) + 0x3619636b) | 0;
      this.seedL = a; this.seedR = b;
      const n = this.n;
      n[0] = f32(f32(a) * INV_2_31);
      n[1] = f32(f32(b) * INV_2_31);
      if (this.counter++ >= 15) {
        this.counter = 0;
        this.bqNoise.designLeft(BQ.PEAK, 6500, f32(0.25), fma32(s8, 2, 1), false);
        this.bqNoise.designRight(BQ.PEAK, 6500, f32(0.25), fma32(s9, 2, 1), false);
      }
      this.bqNoise.processDual(n);
      oL = fma32(n[0], this.noiseLevel, oL);
      oR = fma32(n[1], this.noiseLevel, oR);
    }
    io2[0] = oL; io2[1] = oR;
    this.lpOut.process(io2);
    // the smoothed mix and output gain
    this.mixCur = fma32(f32(this.mixTarget - this.mixCur), this.coef, this.mixCur);
    this.gainCur = fma32(f32(this.gainTarget - this.gainCur), this.coef, this.gainCur);
    this.m214 = fma32(f32(this.gainTarget - this.m214), this.coef, this.m214);
    const mix = this.mixCur;
    const s0 = f32(Math.sqrt(f32(1 - mix)));
    const s1 = f32(Math.sqrt(mix));
    io[0] = fma32(io[0], s0, f32(f32(s1 * io2[0]) * this.polarity));
    io[1] = fma32(io[1], s0, f32(f32(s1 * io2[1]) * this.polarity));
    if (this.gateOn) this.gate.process(io);
    io[0] = f32(this.gainCur * io[0]);
    io[1] = f32(this.gainCur * io[1]);
  }

  private readonly io2 = new Float32Array(2);
}
