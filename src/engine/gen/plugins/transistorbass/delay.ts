// Transistor Bass delay: the ILDelay3 engine (FL Delay 3's C++ core) in the
// configuration Transistor Bass's engine uses, decoded from FL 2026's binary:
// mono input (L + R) / 2 x Amount, two crossfade slots (time / right-tap
// pairs: slot 0 reads interpolated, slot 1 reads whole samples, as FL),
// feedback through a 10 Hz DC blocker (44.1 kHz coefficients at any rate), a
// double-sampled Chamberlin low-pass (cutoff = Tone through FL's 270..22000 Hz
// table, updated every 4 samples), FL's soft saturation (drive 0.1, ceiling
// 10.03), the envelope limiter and a 65-sample allpass slot (diffusion 0 =
// a plain delay) before the line. Outputs: the main taps (left) and right
// taps through 20 Hz one-pole high-passes, mixed by Stereo.

import { OnePole } from './engine';

const f32 = Math.fround;
const LP_T = [270, 480, 1300, 7000, 22000];

class Ring {
  readonly buf: Float32Array;
  readonly mask: number;
  pos = 0;
  constructor(size: number) { this.buf = new Float32Array(size); this.mask = size - 1; }
  write(x: number): void { this.buf[this.pos] = x; this.pos = (this.pos + 1) & this.mask; }
  readInt(d: number): number { return this.buf[(this.pos - d) & this.mask]; }
  readFrac(d: number): number {
    const i = Math.trunc(d);
    const fr = f32(d - i);
    const a = this.buf[(this.pos - i) & this.mask];
    const b = this.buf[(this.pos - i - 1) & this.mask];
    return f32(a * f32(1 - fr) + f32(fr * b));
  }
  clear(): void { this.buf.fill(0); this.pos = 0; }
}

/** Double-sampled Chamberlin state-variable filter (musicdsp, A. Simper), FL's floats. */
class Svf {
  drive = 0; mLow = 1; mHigh = 0; mBand = 0;
  fc = -1; q = -1; f = 0; damp = 0; sr = 44100;
  notch = 0; low = 0; high = 0; band = 0;
  set(fc: number, q: number): void {
    let f = this.f;
    if (fc !== this.fc) {
      const x = Math.min(f32(fc / f32(this.sr + this.sr)), 0.25);
      f = f32(f32(Math.sin(f32(x * f32(Math.PI)))) * 2);
      this.f = f;
      this.fc = fc;
    } else if (q === this.q) return;
    const a = f32(f32(1 - f32(Math.pow(q, 0.25))) * 2);
    const b = Math.min(f32(f32(f * -0.5) + f32(2 / f)), 2);
    this.damp = a < b ? a : b;
    this.q = q;
  }
  tick(x: number): number {
    const f = this.f, d = this.damp;
    let band = this.band;
    let notch = f32(x - f32(d * band));
    let low = f32(f32(f * band) + this.low);
    let high = f32(notch - low);
    let nb = f32(f32(f * high) + band);
    nb = f32(f32(f32(f32(band * -this.drive) * band) * band) + nb);
    band = nb;
    const o1 = f32(f32(f32(f32(high * this.mHigh) + f32(low * this.mLow)) + f32(band * this.mBand)) * 0.5);
    notch = f32(x - f32(d * band));
    low = f32(f32(f * band) + low);
    this.notch = notch; this.low = low;
    high = f32(notch - low);
    nb = f32(f32(f * high) + band);
    nb = f32(f32(f32(f32(band * -this.drive) * band) * band) + nb);
    this.high = high; this.band = nb;
    const o2 = f32(f32(f32(high * this.mHigh) + f32(low * this.mLow)) + f32(nb * this.mBand));
    return f32(f32(o2 * 0.5) + o1);
  }
  clear(): void { this.notch = this.low = this.high = this.band = 0; }
}

export class TbDelay {
  sr = 44100;
  readonly line = new Ring(1 << 18);
  readonly ap = new Ring(1 << 15);
  readonly apLen = 65;
  readonly svf = new Svf();
  readonly dc = new OnePole();
  readonly toneL = new OnePole();
  readonly toneR = new OnePole();
  limEnv = 0;
  readonly limAtt = f32(0.005207657814025879);
  readonly limRel = f32(0.0005220174789428711);
  // engine fields
  input = f32(0.5);
  feedback = f32(0.99);
  cutoff = f32(0.5);
  res = 0;
  drive = f32(0.10000000149011612);
  ceil = f32(10.029618263244629);
  dry = 1;
  wet = 1;
  st0 = 1;
  st1 = 0;
  times = [f32(0.1), f32(0.1)];
  taps = [f32(0.5), f32(0.5)];
  d = new Float32Array(2);
  r = new Float32Array(2);
  updCount = 0;

  constructor() {
    this.dc.setSampleRate(44100);
    this.dc.setHP(10);
    this.setSampleRate(44100);
  }

  setSampleRate(sr: number): void {
    this.sr = sr;
    this.svf.sr = sr; this.svf.fc = -1; this.svf.q = -1;
    this.toneL.setSampleRate(sr); this.toneL.setHP(20);
    this.toneR.setSampleRate(sr); this.toneR.setHP(20);
    for (let s = 0; s < 2; s++) this.updateSlot(s);
    this.clear();
  }

  private updateSlot(s: number): void {
    const srf = f32(this.sr);
    const D = f32(f32(this.times[s] * srf) + 1);
    this.d[s] = D;
    const tap = this.taps[s];
    const e = f32(D + f32(-0.9998999834060669));
    this.r[s] = f32(f32(e * f32(1 - f32(tap * 0.5))) + 1);
  }

  /** Slot time in seconds (FL's 0x77a0). */
  setTime(slot: number, sec: number): void { this.times[slot] = f32(sec); this.updateSlot(slot); }
  /** Slot right-tap point 0..1 (FL's 0x77ec). */
  setTap(slot: number, tap: number): void { this.taps[slot] = f32(tap); this.updateSlot(slot); }
  setStereo(v: number): void { this.st0 = f32(f32(v * 0.5) + 0.5); this.st1 = f32(1 - this.st0); }

  private updateFilter(): void {
    if (this.updCount === 0) {
      let c = f32(f32(0.5 * 0) + this.cutoff);
      c = c < 0 ? 0 : Math.min(c, 1);
      let q = f32(f32(0.5 * 0) + this.res);
      q = q < 0 ? 0 : Math.min(q, 1);
      const x = f32(c * f32(3.999000072479248));
      const i = Math.trunc(x);
      const fr = f32(x - i);
      const fc = i >= 4 ? LP_T[4] : f32(f32(fr * LP_T[i + 1]) + f32(f32(1 - fr) * LP_T[i]));
      this.svf.mLow = 1; this.svf.mHigh = 0; this.svf.mBand = 0;
      this.svf.set(fc, f32(q * 0.25));
    }
    this.updCount = (this.updCount + 1) & 3;
  }

  /** One sample in place: gA / gB are the slot crossfade gains. */
  process(io: Float32Array, gA: number, gB: number): void {
    const xL = io[0], xR = io[1];
    const fbGain = f32(this.feedback / Math.max(f32(this.drive * this.ceil), 1));
    const inp = f32(this.input * f32(f32(xL + xR) * 0.5));
    this.updateFilter();
    let main = f32(this.line.readFrac(this.d[0]) * gA);
    const sec0 = this.line.readFrac(this.r[0]);
    main = f32(f32(this.line.readInt(Math.trunc(this.d[1])) * gB) + main);
    const sec1 = this.line.readInt(Math.trunc(this.r[1]));
    let x = f32(inp + this.dc.tick(f32(fbGain * main)));
    x = this.svf.tick(x);
    if (this.drive !== 1) {
      let s = f32(x * this.drive);
      if (s < -3) s = -1;
      else if (s > 3) s = 1;
      else s = f32(f32(s * f32(f32(s * s) + 27)) / f32(f32(f32(s * 9) * s) + 27));
      x = f32(s * this.ceil);
    }
    const sec = f32(f32(sec1 * gB) + f32(sec0 * gA));
    // limiter
    const ax = Math.abs(x);
    const env = this.limEnv;
    this.limEnv = f32(f32(f32(ax - env) * (ax < env ? this.limRel : this.limAtt)) + env);
    x = f32(x / Math.max(this.limEnv, 1));
    // allpass slot (coefficient 0: a 65-sample delay)
    const w = this.ap.readInt(this.apLen);
    this.ap.write(x);
    this.line.write(w);
    const oL = this.toneL.tick(main);
    const oR = this.toneR.tick(sec);
    io[0] = f32(f32(xL * this.dry) + f32(this.wet * f32(f32(oL * this.st0) + f32(oR * this.st1))));
    io[1] = f32(f32(xR * this.dry) + f32(this.wet * f32(f32(oR * this.st0) + f32(oL * this.st1))));
  }

  clear(): void {
    this.line.clear(); this.ap.clear(); this.svf.clear();
    this.dc.reset(); this.toneL.reset(); this.toneR.reset();
    this.limEnv = 0; this.updCount = 0;
  }
}
