// Sawer's arpeggiator: IL's CArpeggiator, the code PoiZone uses (FL's functions are identical
// in both engines; see ../poizone/core.ts): steps = held notes ascending, repeated per octave,
// up / down / up-and-down / random, tempo-synced at a speed in sixteenths.

import { f32 } from '../poizone/dsp';

export interface SwArpHost {
  readonly vel01: Float32Array;
  playNote(n: number, vel: number): void;
  rand32(): number;
}

export class PzArpLike {
  readonly synth: SwArpHost;
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

  constructor(synth: SwArpHost) { this.synth = synth; }

  setMode(m: number): void { this.mode = Math.min(Math.max(m, 0), 3); }

  private allOff(): void {
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
