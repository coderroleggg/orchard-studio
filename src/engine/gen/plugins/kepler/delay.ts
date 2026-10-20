// Kepler Exo delay (engine.dylib: 0x3e50 wrapper process, 0x3b3c parameters, 0x3dfc / 0x14474 sample rate,
// 0x1396c core process, 0x13d20 filter update, 0x143dc / 0x14428 taps). FL's delay engine (the C++ class behind
// Delay 3) in the configuration Kepler Exo uses: mono input (L + R) / 2 x Amount, two cross-fade slots (a time change
// glides by moving to the other slot over 1000 samples), a DC-blocked feedback through a filter (state-variable low /
// high pass, or a band-pass biquad), FL's soft saturator, the limiter and a 65-sample allpass in front of the line,
// four extra feedback "blur" rings (taps at 0.63 / 0.76 / 0.41 / 0.54 of the delay time), a first-order tone filter per
// side and the stereo mix. The time is re-evaluated every sr / 500 samples (a tempo-synced time follows the host
// tempo). The arithmetic is single precision with the multiply-adds fused where FL's code fuses them.

import { f32, fma32, fms32, fmaD } from './fmath';
import { tanf, sinf, sincosf, powf } from './applemath';
import { quant } from './voice';

const RING_BITS = 18;
const RING = 1 << RING_BITS;
const MASK = RING - 1;
const LP_TABLE = [270, 480, 1300, 7000, 22000];
const HP_TABLE = [20, 90, 400, 1300, 4200];
/** Tempo-synced times in beats / 4 (FL's table; entry 7 is FL's 1/3 quirk). */
const SYNC_TABLE = [0.015625, 0.03125, 0.041666666666666664, 0.046875, 0.0625, 0.08333333333333333, 0.09375, 0.3333333333333333,
  0.125, 0.16666666666666666, 0.1875, 0.25, 0.3333333333333333, 0.375, 0.5, 0.6666666666666666, 0.75, 1.0];
const PI_F = f32(3.1415927410125732);
const MINUS_9999 = f32(-0.9998999834060669);

/** 0x3350 / 0x3334 / 0x3398: a power-of-two delay line with a linearly interpolating read. */
class Ring {
  readonly buf = new Float32Array(RING);
  w = 0;
  write(x: number): void { this.buf[this.w] = x; this.w = (this.w + 1) & MASK; }
  readInt(n: number): number { return this.buf[(this.w - n) & MASK]; }
  readFrac(d: number): number {
    const i = d > 0 ? Math.min(Math.trunc(d), 0xffffffff) : 0;   // fcvtzu
    const f = f32(d - i);
    const a = this.buf[(this.w - i) & MASK];
    const b = this.buf[(this.w + ~i) & MASK];
    return fma32(a, f32(1 - f), f32(f * b));
  }
  clear(): void { this.buf.fill(0); this.w = 0; }
}

/** 0x2ccec: linear interpolation in a table. */
function lerpTable(t: number[], x: number): number {
  const i = Math.trunc(x);
  const f = f32(x - i);
  return fma32(f32(1 - f), t[i], f32(f * t[i + 1]));
}

/** 0x3b08c: y = b0 x + b1 x1 + a y1 (the coefficients of a first-order filter), 0x3af94 / 0x3afe8 design low / high pass. */
class Pole {
  y = 0; x1 = 0;
  c10 = 0; c14 = 0; c18 = 0;      // @0x10 0x14 0x18
  type = 0;                        // @0x2c (0 low-pass, 1 high-pass)
  fc = 100;                        // @0x30
  k = f32(7.123792602214962e-05);  // @0x34: pi / sr
  /** FL's first-order filters are unstable above the Nyquist frequency: they stay just below it (never changes 44.1 kHz or more) */
  private maxFc = 22049;

  tick(x: number): number {
    const r = fma32(this.y, this.c18, fma32(x, this.c10, f32(this.x1 * this.c14)));
    this.y = r; this.x1 = x;
    return r;
  }

  /** 0x3b2b0: the sample rate (then the filter is designed again). */
  setSampleRate(sr: number): void {
    this.k = f32(f32(1 / sr) * PI_F);
    this.maxFc = f32(sr * 0.49995);
    const t = tanf(f32(this.k * Math.min(this.fc, this.maxFc)));
    const s1 = f32(t + 1);
    if (this.type !== 0) { this.type = 1; const g = f32(1 / s1); this.c10 = g; this.c14 = -g; }
    else { this.type = 0; const g = f32(t / s1); this.c10 = g; this.c14 = g; }
    this.c18 = f32(f32(-f32(t + -1)) / s1);
  }

  lowpass(fc: number): void {
    this.fc = fc; this.type = 0;
    const t = tanf(f32(this.k * Math.min(fc, this.maxFc)));
    const s1 = f32(t + 1);
    const g = f32(t / s1);
    this.c10 = g; this.c14 = g;
    this.c18 = f32(f32(-f32(t + -1)) / s1);
  }

  highpass(fc: number): void {
    this.fc = fc; this.type = 1;
    const t = tanf(f32(this.k * Math.min(fc, this.maxFc)));
    const s2 = f32(t + 1);
    const g = f32(1 / s2);
    this.c10 = g; this.c14 = -g;
    this.c18 = f32(f32(-f32(t + -1)) / s2);
  }

  /** 0x3b33c: the coefficients, type and frequency of another filter (the states stay). */
  copyDesign(o: Pole): void { this.c10 = o.c10; this.c14 = o.c14; this.c18 = o.c18; this.type = o.type; this.fc = o.fc; }

  clear(): void { this.y = 0; this.x1 = 0; }
}

/** 0x2fad0 (tick), 0x2f9a0 (tune), 0x2fa64 / 0x2fa80 (low / high pass): FL's double-sampled Chamberlin state-variable filter. */
class Svf {
  drive = 0;                       // @0x00
  mLow = 1; mHigh = 0; mBand = 0;  // @0x04 0x08 0x0c
  fcCache = -1; qCache = 0;        // @0x1c 0x20
  f = 0; damp = 0;                 // @0x24 0x28
  low = 0; high = 0; band = 0;     // @0x30 0x34 0x38
  sr = 44100;                      // @0x3c

  constructor() { this.tune(1000, 0); }

  setSampleRate(sr: number): void {
    const had = this.fcCache >= 0 && this.qCache >= 0;
    this.fcCache = -1; this.qCache = -1;
    this.sr = f32(sr);
    if (had) this.tune(-1, -1);
  }

  /** 0x2f9a0 */
  tune(fc: number, q: number): void {
    let f = this.f;
    if (this.fcCache !== fc) {
      const x = Math.min(f32(fc / f32(this.sr + this.sr)), 0.25);
      const s = sinf(f32(x * PI_F));
      f = f32(s + s);
      this.f = f; this.fcCache = fc;
    } else if (this.qCache === q) return;
    const a = f32(f32(1 - powf(q, 0.25)) * 2);
    const b = Math.min(fma32(f, -0.5, f32(2 / f)), 2);
    this.damp = a < b ? a : b;
    this.qCache = q;
  }

  lowpass(fc: number, q: number): void { this.mLow = 1; this.mHigh = 0; this.mBand = 0; this.tune(fc, f32(q * 0.25)); }
  highpass(fc: number, q: number): void { this.mLow = 0; this.mHigh = 1; this.mBand = 0; this.tune(fc, f32(q * 0.25)); }

  tick(x: number): number {
    const f = this.f, damp = this.damp, nd = -this.drive;
    let band = this.band;
    let notch = fms32(damp, band, x);
    let low = fma32(f, band, this.low);
    let high = f32(notch - low);
    let nb = fma32(f, high, band);
    nb = fma32(f32(band * f32(band * nd)), band, nb);
    const o1 = f32(fma32(nb, this.mBand, fma32(low, this.mLow, f32(high * this.mHigh))) * 0.5);
    notch = fms32(damp, nb, x);
    low = fma32(f, nb, low);
    this.low = low;
    high = f32(notch - low);
    const nb2 = fma32(f32(nb * f32(nb * nd)), nb, fma32(f, high, nb));
    this.high = high; this.band = nb2;
    const o2 = fma32(nb2, this.mBand, fma32(low, this.mLow, f32(this.mHigh * high)));
    return fma32(o2, 0.5, o1);
  }

  clear(): void { this.low = 0; this.high = 0; this.band = 0; }
}

/** 0xb9cc (tick), 0xc734 (band-pass design): the biquad of the band-pass feedback filter. */
class Biquad {
  sr = 44100; invSr = f32(1 / 44100);
  c10 = 0; c14 = 0; c18 = 0; c1c = 0; c20 = 0;
  x2 = 0; x1 = 0; y2 = 0; y1 = 0;   // @0x24 0x28 0x2c 0x30

  setSampleRate(sr: number): void { this.sr = sr; this.invSr = f32(1 / sr); }

  /** 0xc734 */
  bandpass(fc: number, q: number): void {
    fc = Math.min(fc, f32(this.sr * 0.49995));
    const s8 = f32(f32(q * q) * 4);
    const w = f32(f32(fc * f32(6.2829999923706055)) * this.invSr);
    const sc = SC; sincosf(w, sc);
    const sin = sc[0], cos = sc[1];
    const alpha = f32(sin / f32(s8 + s8));
    const a0 = f32(1 / f32(alpha + 1));
    this.c18 = 0;
    this.c10 = f32(alpha * a0);
    this.c14 = f32(f32(cos + cos) * a0);
    this.c1c = f32(-alpha * a0);
    this.c20 = f32(-f32(1 - alpha) * a0);
  }

  tick(x: number): number {
    let y = f32(this.c18 * this.x1);
    y = fma32(this.c10, x, y);
    y = fma32(this.c1c, this.x2, y);
    y = fma32(this.c14, this.y1, y);
    y = fma32(this.c20, this.y2, y);
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }

  clear(): void { this.x2 = this.x1 = this.y2 = this.y1 = 0; }
}
const SC: number[] = [0, 0];

/** 0x10030: allpass with FL's coefficient c * 0.499 over a ring of `len` samples; returns the allpass output. */
class Allpass {
  len = 65;                  // @0x00
  c = 0;                     // @0x04
  readonly buf = new Float32Array(0x8000);
  w = 0;
  tick(x: number): number {
    const c = f32(this.c * f32(0.49900001287460327));
    const y = this.buf[(this.w - this.len) & 0x7fff];
    this.buf[this.w] = fms32(y, c, x);
    this.w = (this.w + 1) & 0x7fff;
    return fma32(x, c, f32(y * fms32(c, c, 1)));
  }
  clear(): void { this.buf.fill(0); this.w = 0; }
}

/** 0x30dac: the output limiter (envelope follower, attack / release per sample). */
class Limiter {
  env = 0; att = f32(0.005207657814025879); rel = f32(0.0005220174789428711);
  tick(x: number): number {
    const a = Math.abs(x), e = this.env;
    const ne = fma32(f32(a - e), a < e ? this.rel : this.att, e);
    this.env = ne;
    return f32(x / (ne > 1 ? ne : 1));
  }
  clear(): void { this.env = 0; }
}

export class KDelay {
  // ---- wrapper (3e50)
  on = true;                           // @0x45c
  sync = false;                        // @0x45d
  beats = f32(0.5);                    // @0x450 (synced time in beats)
  freeTime = f32(0.5);                 // @0x454 (seconds)
  curTime = 0;                         // @0x458
  xfading = false;                     // @0x45e
  slot = 0;                            // @0x460
  newSlot = 1;                         // @0x464
  readonly xfLen = 1000;               // @0x468
  readonly xfStep = f32(0.0010000000474974513); // @0x46c
  xfPos = 0;                           // @0x470
  gA = 1; gB = 0;                      // @0x478 / 0x47c
  tapCur = 0; tapTarget = 0;           // @0x480 / 0x484
  counter = 0; period = 10;            // @0x488 / 0x48c
  tempo = 120;                         // @0x490

  // ---- core
  sr = 44100;
  private amount = f32(0.5);           // @0x58
  private fb = f32(0.99);              // @0x80
  private cutoff = f32(0.5);           // @0x64
  private res = 0;                     // @0x60
  private type = 0;                    // @0x30
  private st0 = 1; private st1 = 0;    // @0x98 / 0x9c
  private blur = 0;                    // @0x418
  private readonly drive = f32(0.10000000149011612); // @0x50
  private readonly ceil = f32(10.029618263244629);   // @0x54
  private readonly dry = 1; private readonly wetGain = 1; // @0x84 / 0x3d0
  private readonly timeSec = [f32(0.1), f32(0.1)];   // @0x70 / 0x74
  private readonly tapFrac = [f32(0.5), f32(0.5)];   // @0x78 / 0x7c
  private readonly tapMain = [0, 0];                  // @0x3b8 / 0x3bc
  private readonly tapRight = [0, 0];                 // @0x3c0 / 0x3c4
  private updCount = 0;                               // @0x34
  private line: Ring | null = null;
  private e1: Ring | null = null; private e2: Ring | null = null; private e3: Ring | null = null; private e4: Ring | null = null;
  private readonly dc = new Pole();                   // @0x298
  private readonly toneL = new Pole();                // @0x348
  private readonly toneR = new Pole();                // @0x380
  private readonly svf = new Svf();                   // @0x148
  private readonly bq = new Biquad();                 // @0x1c8
  private readonly ap = new Allpass();                // @0x3d8
  private readonly lim = new Limiter();               // @0x308
  readonly raw = new Float32Array(11);

  constructor() {
    this.dc.fc = 100;
    this.setSampleRate(44100);
    for (let i = 0; i < 11; i++) this.setParam(i, 0.5);
  }

  /** 0x3dfc / 0x14474 */
  setSampleRate(sr: number): void {
    this.sr = sr;
    this.period = Math.trunc(sr / 500);
    this.svf.setSampleRate(sr);
    this.bq.setSampleRate(sr);
    this.dc.setSampleRate(44100);
    this.dc.highpass(10);
    this.toneL.setSampleRate(sr);
    this.toneR.setSampleRate(sr);
    for (let s = 0; s < 2; s++) { this.setTime(s, this.timeSec[s]); }
  }

  setTempo(bpm: number): void { this.tempo = bpm; }

  /** 0x143dc */
  private setTime(slot: number, t: number): void {
    this.timeSec[slot] = t;
    const d = fma32(t, f32(this.sr), 1);
    this.tapMain[slot] = d;
    this.updateRight(slot, d);
  }

  /** 0x14428 */
  private setTap(slot: number, tap: number): void {
    this.tapFrac[slot] = tap;
    this.updateRight(slot, this.tapMain[slot]);
  }

  private updateRight(slot: number, d: number): void {
    const tap = this.tapFrac[slot];
    const e = f32(d + MINUS_9999);
    this.tapRight[slot] = fma32(e, fms32(tap, 0.5, 1), 1);
  }

  /** 0x3b3c: idx 0 on, 1 sync, 2 amount, 3 time, 4 right tap, 5 feedback, 6 cutoff, 7 filter type, 8 stereo, 9 blur, 10 tone. */
  setParam(idx: number, v: number): void {
    v = f32(v);
    this.raw[idx] = v;
    switch (idx) {
      case 0: this.on = v >= 0.5; break;
      case 1: this.sync = v >= 0.5; break;
      case 2: this.amount = v; break;
      case 3: {
        const d = this.raw[3];
        const i = Math.min(quant(d, 18), 17);
        this.beats = f32(SYNC_TABLE[i] * 4);
        this.freeTime = f32(fmaD(d, 0.49, 0.01));
        break;
      }
      case 4: this.tapTarget = v; break;
      case 5: this.fb = v; break;
      case 6: this.cutoff = v; break;
      case 7: this.type = quant(v, 4); break;
      case 8: { const s = fma32(v, 0.5, 0.5); this.st0 = s; this.st1 = f32(1 - s); break; }
      case 9: this.blur = v; break;
      case 10: {
        if (v < 0.5) {
          const fc = lerpTable(LP_TABLE, f32(f32(v + v) * f32(3.9999001026153564)));
          this.toneL.lowpass(fc);
        } else {
          const w = f32(v + -0.5);
          const fc = lerpTable(HP_TABLE, f32(f32(w + w) * f32(3.9999001026153564)));
          this.toneL.highpass(fc);
        }
        this.toneR.copyDesign(this.toneL);
        break;
      }
      default: break;
    }
  }

  /** 0x13d20: the feedback filter's coefficients, every fourth sample. */
  private updateFilter(): void {
    if (this.updCount === 0) {
      const lfo = 0; // the modulation depths are 0
      let c = fma32(lfo, 0, this.cutoff);
      c = c < 0 ? 0 : Math.min(c, 1);
      let q = fma32(lfo, 0, this.res);
      q = q < 0 ? 0 : Math.min(q, 1);
      if (this.type === 0) {
        this.svf.lowpass(lerpTable(LP_TABLE, f32(c * f32(3.999000072479248))), q);
      } else if (this.type === 1) {
        this.svf.highpass(lerpTable(HP_TABLE, f32(c * f32(3.999000072479248))), q);
      } else if (this.type === 2) {
        const fc = lerpTable(LP_TABLE, f32(f32(c * f32(0.8199999928474426)) * f32(3.9999001026153564)));
        this.bq.bandpass(fc, fma32(q, f32(0.8799999952316284), f32(0.10000000149011612)));
      }
    }
    this.updCount = (this.updCount + 1) & 3;
  }

  private ensureRings(): Ring {
    if (!this.line) {
      this.line = new Ring(); this.e1 = new Ring(); this.e2 = new Ring(); this.e3 = new Ring(); this.e4 = new Ring();
    }
    return this.line;
  }

  /**
   * 0x1390c, what MyPlugin::reset clears of the core: the main line, the feedback filter, the allpass and the DC filter
   * (the four blur rings, the tone filters and the limiter keep their contents).
   */
  clearCore(): void {
    this.line?.clear();
    this.ap.clear();
    this.svf.clear();
    this.dc.clear();
  }

  /** 0x3e50: one stereo sample in place. */
  process(io: Float32Array): void {
    if (!this.on) return;
    const n = this.counter++;
    if (n >= this.period) {
      this.counter = 0;
      const s8 = this.sync ? f32((1 / (this.tempo / 60)) * this.beats) : this.freeTime;
      if (this.curTime === 0) {
        this.curTime = s8;
        this.setTime(0, s8); this.setTime(1, this.curTime);
        this.setTap(0, this.tapCur); this.setTap(1, this.tapCur);
      }
      if (!this.xfading) {
        if (this.curTime !== s8 || this.tapCur !== this.tapTarget) {
          this.xfading = true;
          this.xfPos = 0;
          this.newSlot = this.slot ^ 1;
          this.curTime = s8;
          this.tapCur = this.tapTarget;
          this.setTime(this.newSlot, s8);
          this.setTap(this.newSlot, this.tapTarget);
        }
      }
    }
    this.core(this.gA, this.gB, io);
    if (this.xfading) {
      const t = f32(this.xfStep * f32(this.xfPos));
      let a: number, b: number;
      if (this.slot === 0) { a = f32(1 - t); b = t; } else { a = t; b = f32(1 - t); }
      this.gA = a; this.gB = b;
      this.xfPos++;
      if (this.xfPos === this.xfLen) {
        this.xfading = false;
        this.gA = a < 0.5 ? 0 : 1;
        this.gB = b < 0.5 ? 0 : 1;
        this.slot = this.newSlot;
      }
    }
  }

  /** 0x1396c */
  private core(gA: number, gB: number, io: Float32Array): void {
    const line = this.ensureRings();
    const e1 = this.e1!, e2 = this.e2!, e3 = this.e3!, e4 = this.e4!;
    const L = io[0], R = io[1];
    const fb = this.fb, blur = this.blur;
    const s14 = f32(fb / Math.max(f32(this.drive * this.ceil), 1));
    const s15 = f32(this.amount * f32(f32(L + R) * 0.5));
    const s12 = 0;                                   // delay modulation (depth 0)
    this.updateFilter();
    const t0 = this.tapMain[0], t1 = this.tapMain[1];
    let s11 = f32(line.readFrac(f32(s12 + t0)) * gA);
    let s10 = line.readFrac(f32(s12 + this.tapRight[0]));
    let s13 = fma32(line.readFrac(f32(s12 + t1)), gB, s11);
    s11 = line.readFrac(f32(s12 + this.tapRight[1]));
    let s0 = f32(s15 + this.dc.tick(f32(s14 * s13)));
    s0 = this.type <= 1 ? this.svf.tick(s0) : this.bq.tick(s0);
    const drive = this.drive;
    if (drive !== 1) {
      s0 = f32(s0 * drive);
      let s1: number;
      if (s0 < -3) s1 = -1;
      else if (s0 > 3) s1 = 1;
      else {
        const num = f32(s0 * fma32(s0, s0, 27));
        s1 = f32(num / fma32(f32(s0 * 9), s0, 27));
      }
      s0 = f32(s1 * this.ceil);
    }
    s10 = fma32(s11, gB, f32(s10 * gA));
    s0 = this.lim.tick(s0);
    s0 = this.ap.tick(s0);
    line.write(s0);
    // blur rings: stage 1 (0.63 / 0.76), stage 2 (0.41 / 0.54)
    s13 = fma32(f32(e1.readFrac(fma32(t0, f32(0.6299999952316284), s12)) * gA), blur, s13);
    s10 = fma32(f32(e2.readFrac(fma32(t0, f32(0.7599999904632568), s12)) * gA), blur, s10);
    const r3 = f32(e1.readFrac(fma32(t1, f32(0.6299999952316284), s12)) * gB);
    const m1 = fma32(r3, blur, s13);
    const r4 = f32(e2.readFrac(fma32(t1, f32(0.7599999904632568), s12)) * gB);
    const m2 = fma32(r4, blur, s10);
    e1.write(f32(fb * -m1));
    e2.write(f32(fb * -m2));
    const a1 = f32(f32(e3.readFrac(fma32(t0, f32(0.4099999964237213), s12)) * gA) * blur);
    const m3 = fma32(a1, blur, m1);
    const a2 = f32(f32(e4.readFrac(fma32(t0, f32(0.5400000214576721), s12)) * gA) * blur);
    const m4 = fma32(a2, blur, m2);
    const a3 = f32(f32(e3.readFrac(fma32(t1, f32(0.4099999964237213), s12)) * gB) * blur);
    const lw0 = fma32(a3, blur, m3);
    const a4 = f32(f32(e4.readFrac(fma32(t1, f32(0.5400000214576721), s12)) * gB) * blur);
    const rw0 = fma32(a4, blur, m4);
    e3.write(f32(fb * -lw0));
    e4.write(f32(fb * -rw0));
    const lw = this.toneL.tick(lw0);
    const rw = this.toneR.tick(rw0);
    io[0] = fma32(L, this.dry, f32(this.wetGain * fma32(lw, this.st0, f32(rw * this.st1))));
    io[1] = fma32(R, this.dry, f32(this.wetGain * fma32(rw, this.st0, f32(lw * this.st1))));
  }

  /** The engine's reset: silence the lines and filters. */
  reset(): void {
    if (this.line) { this.line.clear(); this.e1!.clear(); this.e2!.clear(); this.e3!.clear(); this.e4!.clear(); }
    this.ap.clear(); this.lim.clear();
    this.dc.clear(); this.toneL.clear(); this.toneR.clear();
    this.svf.clear(); this.bq.clear();
  }
}
