// Kepler Exo "Enhanced Oscillators" (Options menu): the engine's class "JunoOscEx", two per voice (engine.dylib 0x3978c constructor,
// 0x39800 table, 0x3992c tick, 0x39a84 saw, 0x39bec pulse, 0x39f60 pulse wrap, 0x3a074 sub oscillator, 0x39858 band-limited step,
// 0x39ed8 read-out, 0x39f50 hard sync request; the step table is made by 0x31ac0 / 0x31db8 when the first engine is created).
//
// A residual-corrected naive oscillator: three rings of 32 samples (saw, pulse, sub) receive the naive waveform at the write
// position and a band-limited step (the table row of the step's sub-sample position, scaled by the step's height) at the read
// position; the read position trails the write position by 15 samples. The sub oscillator is a square wave that toggles once per
// cycle (half the frequency), hard sync resets the slave at the master's wrap. The classic oscillators of slaveosc.ts run when the
// option is off; FL keeps both objects up to date with every parameter, only one of them runs.

import { f32, fma32, fmaD } from './fmath';

/** Taps per step and positions per sample of the shared step table (the engine builds one at start-up). */
export const EX_L = 32;
const EX_ROWS = 16384;
const EX_MASK = EX_L - 1;

let table: Float32Array | null = null;

/**
 * 0x31ac0 (the generator) and 0x31db8 (the layout): a Hann-windowed sinc with cut-off 0.707 integrated to a step response, the
 * step's second half shifted down by one and mirrored (anti-symmetric), 16385 rows of 32 single-precision taps stored twice.
 * Row r holds source points r + j x 16384 (j = 0..31).
 */
export function exTable(): Float32Array {
  if (table) return table;
  const L = EX_L, rows = EX_ROWS, N = L * rows, size = N + 1, half = size >> 1;
  const a = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const d1 = ((i - half) / rows) * 0.707;
    let d0 = 1;
    if (d1 !== 0) { const d9 = d1 * Math.PI; d0 = Math.sin(d9) / d9; }
    a[i] = d0 * 0.707;
  }
  for (let i = 0; i < size; i++) a[i] = a[i] * ((1 - Math.cos((i * 6.283185307179586) / N)) * 0.5);
  { let acc = a[0]; for (let k = 1; k < size; k++) { acc = acc + a[k]; a[k] = acc; } }
  a[0] = 0;
  const inv = 1 / rows;
  for (let i = 0; i < size; i++) a[i] = inv * a[i];
  for (let i = half; i <= N; i++) a[i] = a[i] + -1;
  for (let x = 0; x < half; x++) a[half + x] = -a[half - 1 - x];
  a[N] = 0;
  const t = new Float32Array((rows + 1) * 2 * L);
  for (let r = 0; r <= rows; r++) {
    for (let j = 0; j < L; j++) {
      const v = f32(a[r + j * rows]);
      t[r * 2 * L + j] = v;
      t[r * 2 * L + L + j] = v;
    }
  }
  table = t;
  return t;
}

export class JunoOscEx {
  out0 = 0;                    // @0x08 band-limited output
  out1 = 0;                    // @0x0c naive output (the cross-modulation / FM source "DCO out")
  sawLevel = 1;                // @0x10
  pulseLevel = 1;              // @0x14
  subLevel = 1;                // @0x18
  thrPw = 0.5;                 // @0x1c pulse width threshold
  thrSub = 0.5;                // @0x20 threshold at which the sub oscillator toggles
  phase = 0;                   // @0x28 (double)
  inc = 0.1;                   // @0x30 (double)
  slave: JunoOscEx | null = null;  // @0x38 hard sync target
  private pulseHigh = 0;       // @0x58
  private subCrossed = 0;      // @0x5c
  private subSign = -1;        // @0x60
  private readonly ringSaw = new Float32Array(EX_L);    // @0x64
  private readonly ringPulse = new Float32Array(EX_L);  // @0x464
  private readonly ringSub = new Float32Array(EX_L);    // @0x864
  private syncFrac = 0;        // @0xc64 sub-sample position of the sync event
  private syncPending = false; // @0xc68
  private w = (EX_L >> 1) - 1; // @0xc6c write index
  private r = 0;               // @0xc70 read index

  /** 0x39f50: the master's wrap asks this oscillator to restart at fraction s0 of the sample. */
  syncRequest(frac: number): void { this.syncPending = true; this.syncFrac = frac; }

  /** 0x39858: add the band-limited step of height `scale` at sub-sample position `frac` to a ring. */
  private addBlep(frac: number, scale: number, ring: Float32Array): void {
    const x = f32(f32(EX_ROWS) * frac);
    let row = Number.isNaN(x) ? 0 : Math.trunc(x);
    if (EX_ROWS < row) row = EX_ROWS;
    if (!(row > 0)) row = 0;
    const t = exTable();
    const base = 2 * EX_L * row + EX_L - this.r;
    if (scale === 1) for (let j = 0; j < EX_L; j++) ring[j] = f32(t[base + j] + ring[j]);
    else if (scale === -1) for (let j = 0; j < EX_L; j++) ring[j] = f32(ring[j] - t[base + j]);
    else for (let j = 0; j < EX_L; j++) ring[j] = fma32(scale, t[base + j], ring[j]);
  }

  /** 0x39ed8: one band-limited sample from the three rings (and clear them behind). */
  private readOut(): number {
    const r = this.r;
    const s0 = f32(f32(this.ringSaw[r] + -0.5) * this.sawLevel);
    const s2 = f32(f32(this.ringPulse[r] + -0.5) * this.pulseLevel);
    const s1 = f32(f32(this.ringSub[r] + -0.5) * this.subLevel);
    this.ringSaw[r] = 0; this.ringPulse[r] = 0; this.ringSub[r] = 0;
    this.r = (r + 1) & EX_MASK;
    this.w = (this.w + 1) & EX_MASK;
    const m = f32(s0 + s2);
    const n = f32(m + s1);
    return f32(n + n);
  }

  /** 0x3992c: one sample. */
  tick(): void {
    const phase0 = this.phase, frac0 = this.syncFrac, pend0 = this.syncPending;
    this.sawStep();
    this.phase = phase0; this.syncFrac = frac0; this.syncPending = pend0;
    this.pulseStep();
    this.syncFrac = frac0; this.syncPending = pend0;
    if (this.subSign > 0) this.ringSub[this.w] = f32(this.ringSub[this.w] + 1);
    if (pend0) {
      this.phase = fmaD(f32(1 - this.syncFrac), this.inc, phase0);
      this.subStep();
      const s1 = this.subSign;
      if (s1 !== -1) { this.addBlep(this.syncFrac, -s1, this.ringSub); this.subSign = -1; }
      this.subCrossed = 0;
      this.phase = this.inc * this.syncFrac;
      this.syncPending = false; this.syncFrac = 0;
    } else this.phase = phase0 + this.inc;
    this.subStep();
    const rd = this.readOut();
    const saw = f32(this.sawLevel * fma32(f32(this.phase), 2, -1));
    const sq = f32(saw + (this.pulseHigh === 1 ? this.pulseLevel : -this.pulseLevel));
    this.out0 = f32(rd * f32(1.1220184564590454));
    this.out1 = fma32(this.subLevel, this.subSign, sq);
  }

  /** 0x39a84: the saw ring. */
  private sawStep(): void {
    const w = this.w;
    this.ringSaw[w] = f32(this.ringSaw[w] + f32(1 - f32(this.phase)));
    const inc = this.inc;
    if (this.syncPending) {
      const frac = this.syncFrac;
      let d0 = fmaD(1 - frac, inc, this.phase);
      this.phase = d0;
      if (!(d0 < 1)) {
        d0 = d0 + -1; this.phase = d0;
        const s8 = f32(frac + f32(d0 / inc));
        this.addBlep(s8, 1, this.ringSaw);
        if (this.slave) this.slave.syncRequest(s8);
      }
      this.addBlep(this.syncFrac, f32(this.phase), this.ringSaw);
      this.phase = this.inc * this.syncFrac;
      this.syncPending = false; this.syncFrac = 0;
    } else {
      const d0 = this.phase + inc;
      this.phase = d0;
      if (!(d0 < 1)) {
        const d1 = d0 + -1; this.phase = d1;
        const s8 = f32(this.syncFrac + f32(d1 / inc));
        this.addBlep(s8, 1, this.ringSaw);
        if (this.slave) this.slave.syncRequest(s8);
      }
    }
  }

  /** The pulse's threshold crossings after a wrap (a very high frequency can cross twice in one sample); true when it ends high. */
  private pulseCross(d0: number): boolean {
    const ring = this.ringPulse;
    let d1 = this.thrPw;
    for (;;) {
      this.addBlep(f32(this.syncFrac + f32((d0 - d1) / this.inc)), -1, ring);
      this.pulseHigh = 1;
      d0 = this.phase;
      if (d0 < 1) return true;
      d0 = d0 + -1; this.phase = d0;
      this.addBlep(f32(this.syncFrac + f32(d0 / this.inc)), 1, ring);
      this.pulseHigh = 0;
      d0 = this.phase; d1 = this.thrPw;
      if (!(d0 >= d1)) return false;
    }
  }

  /** 0x39f60: the pulse is high and the phase has advanced: a wrap ends it, a crossing of the threshold raises it again. */
  private pulseHighWrap(): void {
    let d0 = this.phase;
    if (d0 < 1) return;
    d0 = d0 + -1; this.phase = d0;
    this.addBlep(f32(this.syncFrac + f32(d0 / this.inc)), 1, this.ringPulse);
    this.pulseHigh = 0;
    d0 = this.phase;
    if (d0 < this.thrPw) return;
    this.pulseCross(d0);
  }

  /** 0x39bec: the pulse ring. */
  private pulseStep(): void {
    const st = this.pulseHigh;
    if (st !== 0) {
      if (!this.syncPending) { this.phase = this.inc + this.phase; this.pulseHighWrap(); return; }
    } else {
      const w = this.w;
      this.ringPulse[w] = f32(this.ringPulse[w] + 1);
      if (!this.syncPending) {
        const d0 = this.inc + this.phase;
        this.phase = d0;
        if (d0 < this.thrPw) return;
        this.pulseCross(d0);
        return;
      }
    }
    // a hard sync restart inside this sample: run up to the sync point, end the pulse there, restart after it
    const d0 = fmaD(f32(1 - this.syncFrac), this.inc, this.phase);
    this.phase = d0;
    if (st !== 0) {
      this.pulseHighWrap();
      if (this.pulseHigh === 1) { this.addBlep(this.syncFrac, 1, this.ringPulse); this.pulseHigh = 0; }
    } else if (d0 >= this.thrPw) {
      const high = this.pulseCross(d0);
      if (high) { this.addBlep(this.syncFrac, 1, this.ringPulse); this.pulseHigh = 0; }
    }
    const d1 = this.inc * this.syncFrac;
    this.phase = d1;
    this.syncPending = false; this.syncFrac = 0;
    if (d1 < this.thrPw) return;
    this.pulseCross(d1);
  }

  /** 0x3a074: the sub oscillator toggles at the threshold crossing, once per cycle. */
  private subStep(): void {
    const ring = this.ringSub;
    let d0 = this.phase;
    if (this.subCrossed !== 0) {
      if (d0 < 1) return;
      this.subCrossed = 0;
      d0 = d0 + -1; this.phase = d0;
    }
    let d2 = this.thrSub;
    if (d0 < d2) return;
    for (;;) {
      this.subCrossed = 1;
      this.subSign = -this.subSign;
      this.addBlep(f32(this.syncFrac + f32((d0 - d2) / this.inc)), this.subSign, ring);
      d0 = this.phase;
      if (d0 < 1) return;
      this.subCrossed = 0;
      d0 = d0 + -1; this.phase = d0;
      d2 = this.thrSub;
      if (!(d0 >= d2)) return;
    }
  }
}
