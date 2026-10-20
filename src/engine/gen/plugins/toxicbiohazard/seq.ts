// Toxic Biohazard's step sequencer, ported from FL 2026's Toxic Biohazard:
// TxArp is IL's CSynth arpeggiator (the code PoiZone uses), TxSeq the
// pattern logic that fills the arpeggiator's step table from the held notes
// and the 64-step pattern (steps -26..24: "---" off, otherwise a transpose).

import { f32 } from '../poizone/dsp';
import { txChord } from './chords';
import type { TxSynth } from './synth';

export class TxArp {
  readonly synth: TxSynth;
  speed = 1;
  steps = 0;
  mode = 0;
  velScale = 1;
  range = 1;
  swing = 0;
  idle = true;
  phase = 0;
  swingFlag = false;
  trig = true;
  idx = -2;
  up = true;
  readonly sNote = new Int32Array(128 * 8).fill(-1);
  readonly sVel = new Float32Array(128 * 8).fill(1);
  readonly prev = new Int32Array(8).fill(-1);

  constructor(synth: TxSynth) { this.synth = synth; }

  allOff(): void {
    for (let i = 0; i < 8; i++) {
      if (this.prev[i] >= 0) { this.synth.playNote(this.prev[i] & 255, 0); this.prev[i] = -1; }
    }
  }

  private restart(): void {
    this.phase = 0; this.idx = -2; this.up = true; this.swingFlag = false; this.trig = true;
    this.prev.fill(-1);
  }

  reset(): void { this.restart(); }

  stop(): void {
    if (this.idle) return;
    this.idle = true;
    this.allOff();
    this.restart();
  }

  /** Leave the idle state (FL 0x2fde8). */
  start(): void {
    if (!this.idle) return;
    this.idle = false;
    this.allOff();
    this.restart();
  }

  setSteps(n: number): void { this.steps = n > 1 ? (n < 128 ? n : 128) : 1; }
  setMode(m: number): void { this.mode = m > 0 ? (m < 3 ? m : 3) : 0; }

  /** Set a whole step: notes[0..7] (-1 off, -2 tie), velocities. */
  setStep(i: number, notes: ArrayLike<number>, vels: ArrayLike<number>): void {
    const st = i > 0 ? (i < 127 ? i : 127) : 0;
    for (let k = 0; k < 8; k++) { this.sNote[st * 8 + k] = notes[k]; this.sVel[st * 8 + k] = vels[k]; }
  }

  setVelScale(v: number): void { this.velScale = v < 0 ? 0 : v > 1 ? 1 : v; }
  setSwing(v: number): void { this.swing = v < 0 ? 0 : v > 0.75 ? 0.75 : v; }

  /** Held notes changed (FL rebuilds the table from the held velocities). */
  update(): void {
    const S = this.synth;
    const nts: number[] = [], vls: number[] = [];
    for (let n = 0; n < 128; n++) if (S.vel01[n] !== 0) { nts.push(n); vls.push(S.vel01[n]); }
    const cnt = nts.length;
    if (cnt > 0) {
      if (this.idle) {
        this.idle = false;
        this.allOff();
        this.restart();
      }
      const r = this.range;
      if (r >= 1) {
        for (let i = 0; i < cnt; i++) {
          for (let o = 0; o < r; o++) {
            const st = Math.min(Math.max(i + o * cnt, 0), 127);
            this.sNote[st * 8] = nts[i] + 12 * o;
            this.sVel[st * 8] = vls[i];
          }
        }
      }
      this.steps = Math.min(Math.max(cnt * r, 1), 128);
    } else if (!this.idle) {
      this.idle = true;
      this.allOff();
      this.restart();
    }
  }

  process(sr: number, tempo: number, n: number): void {
    if (this.idle) return;
    if (this.trig) {
      this.trig = false;
      const cnt = this.steps;
      let i = this.idx;
      switch (this.mode) {
        case 0: if (i < 0 || i >= cnt) i = 0; break;
        case 1: if (i < 0) i = cnt - 1; break;
        case 2:
          if (i < -1) { i = 0; this.up = true; } else if (i < 0) { i = 1; this.up = true; }
          if (i >= cnt) { i = cnt - 2; this.up = false; if (cnt <= 1) i = 0; }
          if (i >= cnt) i = cnt - 1;
          break;
        default: {
          const r = this.synth.rand32();
          i = Math.max(Math.trunc(f32(r * cnt)), 0);
          if (i >= cnt) i = cnt - 1;
        }
      }
      this.idx = i;
      for (let k = 0; k < 8; k++) {
        const raw = this.sNote[i * 8 + k];
        const nt = raw < 127 ? raw : 127;
        if ((nt & 255) === 0xfe) continue;
        if (this.prev[k] >= 0) this.synth.playNote(this.prev[k] & 255, 0);
        const b = ((nt & 255) << 24) >> 24;
        this.prev[k] = b;
        if (b >= 0) this.synth.playNote(nt & 255, f32(this.sVel[i * 8 + k] * this.velScale));
      }
      if (this.mode === 2) this.idx = this.up ? this.idx + 1 : this.idx - 1;
      else if (this.mode === 1) this.idx--;
      else if (this.mode === 0) this.idx++;
    }
    const den = sr * 15 * this.speed;
    const lim = (this.swingFlag ? -this.swing : this.swing) + 1;
    let p = this.phase + (n * tempo) / den;
    this.phase = p;
    if (p >= lim) {
      let fl = this.swingFlag;
      do { p -= lim; fl = !fl; } while (p >= lim);
      this.phase = p;
      this.trig = true;
      this.swingFlag = fl;
    }
  }
}

export class TxSeq {
  readonly synth: TxSynth;
  readonly pattern = new Int32Array(64);
  steps = 16;
  dual = false;
  pingPong = false;
  random = false;
  swingOn = false;
  lastKey = -1;

  constructor(synth: TxSynth) { this.synth = synth; }

  setStep(i: number, v: number): void {
    if (i < 0 || i > 63) return;
    this.pattern[i] = v < 24 ? (v > -26 ? v : -26) : 24;
  }

  /**
   * Held notes / pattern changed: rebuild the arpeggiator's table (FL 0x50638).
   * The held chord picks a scale (degree -> semitone, the octave's first degree
   * may differ above the first octave) at the detected root, in the octave of
   * the lowest held note; the lowest note's velocity scales every step.
   */
  update(_on: boolean): void {
    const S = this.synth, A = S.arp;
    let low = -1;
    for (let n = 0; n < 128; n++) if (S.vel01[n] !== 0) { low = n; break; }
    if (low < 0) { A.stop(); return; }
    this.lastKey = low;
    A.setVelScale(S.vel01[low]);
    A.start();
    let pcs = 0;
    for (let n = low; n < 128; n++) if (S.vel01[n] !== 0) pcs |= 1 << (n % 12);
    const ch = txChord(pcs);
    const sc = TX_SCALES[ch >> 4], root = ch & 15;
    const oct = Math.trunc(low / 12);
    const notes = [0, -1, -1, -1, -1, -1, -1, -1], vels = [1, 1, 1, 1, 1, 1, 1, 1];
    for (let i = 0; i < 64; i++) {
      const v = this.pattern[i];
      let x: number;
      if (v === -26) x = -1;
      else if (v === -25) x = -2;
      else {
        const q = Math.floor(v / 12), d = v - 12 * q;
        const s = q !== 0 && d === 0 ? sc[12] : sc[d];
        x = (oct + q) * 12 + root + s;
        if (x < 0) x += 12 * (1 + Math.trunc((-x - 1) / 12));
        if (x >= 121) x = (x % 12) + 108;
      }
      notes[0] = x;
      A.setStep(i, notes, vels);
    }
    if (this.dual) {
      A.setSteps(this.steps < 32 ? this.steps : 32);
      for (let i = 0; i < 32; i++) {
        A.sNote[i * 8 + 1] = A.sNote[(i + 32) * 8];
        A.sVel[i * 8 + 1] = A.sVel[(i + 32) * 8];
      }
    } else A.setSteps(this.steps);
    A.setMode(0);
    if (this.pingPong) A.setMode(2);
    if (this.random) A.setMode(3);
    A.setSwing(this.swingOn ? 0.25 : 0);
  }
}

/** Degree -> semitone per detected chord (index 12: the first degree above the first octave). */
const TX_SCALES: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 3, 5, 6, 7, 8, 8, 10, 10, 0],
  [0, 1, 2, 4, 4, 5, 6, 7, 9, 9, 11, 11, 0],
  [0, 1, 2, 3, 3, 5, 6, 7, 8, 10, 10, 10, -2],
  [0, 1, 2, 4, 4, 5, 6, 7, 8, 10, 10, 10, -2],
  [0, 1, 2, 3, 3, 5, 6, 7, 8, 11, 11, 11, -1],
  [0, 1, 2, 4, 4, 5, 6, 7, 8, 11, 11, 11, -1],
  [0, 1, 2, 3, 3, 5, 6, 6, 8, 8, 10, 10, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0],
];
