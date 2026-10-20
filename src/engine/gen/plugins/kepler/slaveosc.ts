// Kepler / Kepler Exo DCO (engine.dylib class "SlaveOsc", object at Voice +0x12a0 (DCO1) and +0x2018
// (DCO2)): a band-limited impulse oscillator with hard sync. A phase accumulator (double) raises
// events (pulse edges at two thresholds, the cycle wrap); each event adds a band-limited impulse
// (the table of blep.ts, positioned by the event's sub-sample fraction) to a ring buffer, and a leaky
// integrator turns the impulse train into the saw / pulse sum. Decoded from 0x38410 (tick), 0x384b8
// (advance with hard sync), 0x38654 (events), 0x38184 (constructor).

import { f32, fma32 } from './fmath';
import { blepTable } from './blep';

export class SlaveOsc {
  /** pulse falling edge position / second threshold */
  thrA = 0.5;                 // @0x00 f32
  /** pulse rising edge position */
  thrB = 0;                   // @0x04 f32
  /** saw level */
  sawLevel = 1;               // @0x08 f32
  /** constant (sub / offset) level */
  offLevel = 0;               // @0x0c f32
  /** pulse level */
  pulseLevel = 0;             // @0x10 f32
  /** another oscillator's hard sync target */
  slave: SlaveOsc | null = null; // @0x20 ptr
  isSyncSource = false;       // @0x18 u8 (the slave takes sync only when this is set on the slave)
  outSaw = 0;                 // @0x28 f32
  outPulse = 0;               // @0x2c f32
  inc = 0.01;                 // @0x30 f64 phase increment per sample
  phase = 0;                  // @0x38 f64
  syncReq = false;            // @0x40 u8
  syncFrac = 0;               // @0x44 f32
  prevSaw = 0;                // @0x48 f32
  prevOff = 0;                // @0x4c f32
  carry = 0;                  // @0x54 f32
  /** cap of the integrator leak (voice sets it) */
  leakCap = 0;                // @0x14 f32
  leak = f32(0.999);          // @0x58 f32
  integ = 0.5;                // @0x5c f32
  idx = 0;                    // @0x60 i32 ring index
  readonly ring = new Float32Array(32); // @0x64 (8 n points used)
  e4 = 0;                     // @0xe4 u8 first threshold crossed this cycle
  e5 = 0;                     // @0xe5 u8 second threshold crossed this cycle
  polarity = 1;               // @0xe8 f32
  n = 4;                      // @0xec i32 kernel size selector (2: 16 points, 4: 32 points)
  mask = 31;                  // @0xf0 i32 ring mask

  /** 0x38258: kernel size n (the voice's oversampling factor): ring of 8 n points. */
  setN(n: number): void { this.n = n; this.mask = (n << 3) - 1; }
  /** 0x383cc: the integrator's leak follows the phase increment: min(1 - 0.26794898 inc, cap). */
  updateLeak(): void {
    const s0 = fma32(f32(this.inc), -0.2679489850997925, 1);
    this.leak = s0 < this.leakCap ? s0 : this.leakCap;
  }

  private addBlep(fr: number, gain: number): void {
    const n = this.n;
    if (n < 1) return;
    let r: number;
    if (fr < 0) r = Math.trunc(fr);
    else r = Math.trunc(Math.min(fr, 1) * 1024);
    const tab = blepTable(n === 2 ? 2 : 4);
    const L = n === 2 ? 16 : 32;
    const stride = L * 2;
    const base = r * stride + L - this.idx;
    const ring = this.ring;
    const cnt = n * 2 * 4 > 0 ? (n << 1) * 4 : 0; // 4 floats per vector step, 2 n steps
    for (let i = 0; i < cnt; i++) { const v = tab[base + i]; ring[i] = f32(ring[i] + f32((v === undefined ? 0 : v) * gain)); }
  }

  /** 0x38654: threshold and wrap events for the step that began at phase p0 (float). */
  private events(p0: number): void {
    const inc = f32(this.inc);
    const frac0 = (t: number) => f32(f32(t) / inc);
    if (!this.e4 && this.phase >= this.thrB) {
      this.e4 = 1;
      const b = this.thrB;
      const t = f32((b > p0 ? b : p0) - p0);
      const fr = f32(this.carry + frac0(t));
      this.addBlep(fr, -this.prevOff);
    }
    let d1 = this.phase;
    if (!this.e5 && d1 >= this.thrA) {
      this.e5 = 1;
      const t = frac0(f32(this.thrA - p0));
      this.polarity = -this.polarity;
      const fr = f32(t + this.carry);
      this.addBlep(fr, f32(this.pulseLevel * this.polarity));
    }
    d1 = this.phase;
    const w = Math.trunc(d1);
    if (w === 0) return;
    const d4 = d1 - w;
    this.phase = d4;
    const d2 = this.inc;
    const dd = d4 / d2;
    let s6 = this.sawLevel;
    let s5 = this.offLevel;
    this.prevSaw = s6; this.prevOff = s5;
    const s3 = this.carry;
    const s7 = f32(s3 + f32(1 - dd));
    s6 = f32(s5 + s6);
    this.addBlep(s7, s6);
    this.e4 = 0; this.e5 = 0;
    const b = this.thrB;
    if (d4 >= b) {
      this.e4 = 1;
      const q = f32(f32(f32(b + 1) - p0) / f32(d2));
      this.addBlep(f32(s3 + q), -s5);
    }
    const a = this.thrA;
    if (d4 >= a) {
      this.e5 = 1;
      const q = f32(f32(f32(a + 1) - p0) / f32(d2));
      this.polarity = -this.polarity;
      this.addBlep(f32(s3 + q), f32(this.pulseLevel * this.polarity));
    }
    const sl = this.slave;
    if (sl && sl.isSyncSource) { sl.syncReq = true; sl.syncFrac = f32(dd); }
  }

  /** 0x384b8: advance the phase by one sample, with hard sync. */
  private advance(): void {
    const d1 = this.phase;
    const s0 = f32(d1);
    if (this.syncReq) {
      this.syncReq = false;
      const s8 = f32(1 - this.syncFrac);
      const d2 = f32(s8 * f32(this.inc));
      this.phase = d1 + d2;
      this.events(s0);
      let o = f32(this.sawLevel * f32(this.phase));
      if (this.e4) { o = f32(o + this.prevOff); this.e4 = 0; }
      if (!(this.polarity < 0)) o = f32(o - this.pulseLevel);
      this.polarity = -1;
      this.e5 = 0;
      const s1 = f32(s8 + this.carry);
      this.addBlep(s1, o);
      this.carry = s8;
      this.phase = f32(f32(this.syncFrac) * f32(this.inc));
      this.events(0);
      this.carry = 0;
    } else {
      this.phase = d1 + this.inc;
      this.events(s0);
    }
  }

  /** 0x38410: one sample; the outputs are outSaw (integrated impulses) and outPulse. */
  tick(): void {
    this.advance();
    const d1 = this.phase;
    const s2 = this.sawLevel;
    const s4 = this.leak;
    let s0 = fma32(-f32(this.inc), s2, this.integ); // fms: integ - inc * A (fused)
    s0 = f32(s0 + this.ring[this.idx]);
    s0 = f32(s0 * s4);
    this.integ = s0;
    this.outSaw = f32(f32(s0 * 2) - s2);
    this.ring[this.idx] = 0;
    this.idx = this.mask & (this.idx + 1);
    const s2b = this.offLevel;
    const off = this.e4 === 0 ? -s2b : s2b;
    // out = pulse*polarity + saw * (2 phase - 1) + off
    const lin = fma32(f32(d1), 2, -1);
    this.outPulse = fma32(this.pulseLevel, this.polarity, f32(f32(this.sawLevel * lin) + off));
  }
}

