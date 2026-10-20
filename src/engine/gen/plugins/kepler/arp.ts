// Kepler / Kepler Exo arpeggiator (engine.dylib, object at MyPlugin +0x1c850: 0x31588 next step, 0x31a9c clock,
// 0x312b0 / 0x3147c notes, 0x3140c start, 0x31248 enable). Held keys are kept in four lists of different
// order (as played, newest first, ascending, descending); the clock steps through one of them over the
// octave range with FL's direction rules (up, up/down, down, three random modes, the same three in
// "as played" order) and plays them through the sink (the engine's note on / off).
//
// The clock counts in seconds (free) or beats (tempo sync): it gates a note off after the gate length and
// starts the next step once a period has passed; a note that starts the arpeggio is optionally quantised to the grid.

import { f32, fma32 } from './fmath';

export interface ArpSink {
  noteOn(key: number, vel: number): void;
  noteOff(key: number, vel: number): void;
}

/** 0x34768 etc.: a list of (key, velocity) that keeps one entry per key, in one of four orders. */
export class NoteList {
  readonly keys: number[] = [];
  readonly vels: number[] = [];
  readonly order: 0 | 1 | 2 | 3;
  constructor(order: 0 | 1 | 2 | 3) { this.order = order; }

  get count(): number { return this.keys.length; }

  /** Insert unless the key is already there; false = it was. */
  add(key: number, vel: number): boolean {
    if (this.keys.indexOf(key) >= 0) return false;
    let at: number;
    const n = this.keys.length;
    switch (this.order) {
      case 0: at = n; break;                                   // as played
      case 1: at = 0; break;                                   // newest first
      case 2: {                                                // ascending: after the last key that is not above
        let i = n - 1;
        while (i >= 0 && this.keys[i] > key) i--;
        at = i + 1;
        break;
      }
      default: {                                               // descending: before the first key that is not above
        let i = 0;
        while (i < n && this.keys[i] > key) i++;
        at = i;
      }
    }
    this.keys.splice(at, 0, key);
    this.vels.splice(at, 0, vel);
    return true;
  }

  remove(key: number): void {
    const i = this.keys.indexOf(key);
    if (i >= 0) { this.keys.splice(i, 1); this.vels.splice(i, 1); }
  }

  indexOf(key: number): number { return this.keys.indexOf(key); }
  clear(): void { this.keys.length = 0; this.vels.length = 0; }
}

export class Arp {
  readonly a = new NoteList(0);   // @0x00 as played
  readonly b = new NoteList(1);   // @0x28 newest first
  readonly c = new NoteList(2);   // @0x50 ascending
  readonly d = new NoteList(3);   // @0x78 descending
  running = false;                // @0xa0
  step = -1;                      // @0xa4
  oct = 0;                        // @0xa8
  key = -1;                       // @0xac
  out = -1;                       // @0xb0 the key playing now
  vel = -1;                       // @0xb4
  dir = 1;                        // @0xb8 1 up, 2 down
  c0 = 0; c8 = 0;                 // @0xc0 / 0xc8 (doubles)
  startReq = true;                // @0xd0
  rng = 1;                        // @0xd4
  startMode = 0;                  // @0xe8 0 none, 1 start now, 2 quantised
  f0 = 0; f8 = 0; f100 = 0;       // @0xf0 / 0xf8 / 0x100 (doubles)
  enabled = false;                // @0x108
  buggy = true;                   // @0x109
  mode = 0;                       // @0x10c
  range = 1;                      // @0x110
  period = f32(0.8109999895095825); // @0x118
  gateFrac = 1;                   // @0x120
  gateLen = f32(0.8109999895095825); // @0x128

  readonly sink: ArpSink;
  constructor(sink: ArpSink, seed: number) { this.sink = sink; this.rng = seed >>> 0; }

  /** 0xa483c: the engine's LCG as a double in [0, 1). */
  private rand(): number {
    this.rng = (Math.imul(this.rng, 0x0bb38435) + 0x3619636b) >>> 0;
    return f32(this.rng * 2.3283064365386963e-10);
  }

  /** 0x31248 */
  enable(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    this.running = on ? this.a.count >= 1 : false;
  }

  /** 0x3121c: gate length as a fraction of the period. */
  setGate(g: number): void { this.gateFrac = g; this.gateLen = this.period * g; }

  /** 0x3122c: the period (seconds or beats). */
  setPeriod(p: number): void { this.period = p; this.gateLen = this.gateFrac * p; }

  clearLists(): void { this.a.clear(); this.b.clear(); this.c.clear(); this.d.clear(); }

  /** 0x3140c */
  private start(): void {
    this.startReq = true;
    this.running = this.a.count > 0;
    this.step = -1;
    const down = this.mode === 8 || this.mode === 2;
    this.oct = down ? this.range - 1 : 0;
    this.dir = down ? 2 : 1;
  }

  /** 0x3194c: stop the sounding note, forget the keys and start over (the sync switch changed). */
  stop(): void {
    if (this.out >= 0) { this.sink.noteOff(this.out, 0); this.out = -1; }
    this.clearLists();
    this.running = false;
    this.start();
    this.startMode = 0;
  }

  /** 0x312b0 */
  noteOn(key: number, vel: number, first: boolean, quant: boolean): void {
    if (!this.enabled) { this.sink.noteOn(key, vel); return; }
    if (this.c.indexOf(key) >= 0) return;
    this.b.add(key, vel); this.a.add(key, vel); this.c.add(key, vel); this.d.add(key, vel);
    if (first) {
      this.startMode = quant ? 2 : 1;
      this.start();
      return;
    }
    if (!this.buggy) return;
    if (this.dir === 2 && this.d.indexOf(key) <= this.step) { this.step++; return; }
    if (this.dir === 1 && this.c.indexOf(key) <= this.step) this.step++;
  }

  /** 0x3147c */
  noteOff(key: number, vel: number): void {
    const before = this.a.count;
    this.b.remove(key); this.a.remove(key); this.c.remove(key); this.d.remove(key);
    const after = this.a.count;
    if (!this.enabled) this.sink.noteOff(key, vel);
    if (before === 1 && after === 0) {
      if (this.out >= 0) { this.sink.noteOff(this.out, 0); this.out = -1; }
      this.running = false;
    }
  }

  /** 0x319d8: hold switched off: release every arpeggio key that is not held any more. */
  releaseUnheld(held: (key: number) => boolean): void {
    const keys = this.a.keys.slice();
    for (const k of keys) if (!held(k)) this.noteOff(k, 0);
  }

  /** 0x31588: the next step. */
  private advance(): void {
    const mode = this.mode;
    if (mode <= 8) {
      if (mode <= 2) this.stepSorted(this.c, this.d, 1, mode);
      else if (mode <= 5) { this.stepRandom(mode); this.play(); return; }
      else this.stepSorted(this.a, this.b, 7, mode);
    }
    this.play();
  }

  /** the up / up-down / down walks over the up list `up` and the down list `dn` (modes 0-2 and 6-8) */
  private stepSorted(up: NoteList, dn: NoteList, upDownMode: number, mode: number): void {
    const range = this.range;
    const step = this.step + 1;
    this.step = step;
    let list: NoteList;
    if (this.dir === 2) {
      if (step >= dn.count) {
        const oct = this.oct;
        this.step = 0; this.oct = oct - 1;
        if (oct <= 0) {
          if (mode !== upDownMode) this.oct = range - 1;
          else {
            this.dir = 1;
            if (up.count < 2) this.oct = Math.min(range, 2) - 1;
            else { this.step = 1; this.oct = 0; }
          }
        }
      }
    } else {
      if (step >= up.count) {
        const oct = this.oct + 1;
        this.step = 0; this.oct = oct;
        if (oct >= range) {
          if (mode !== upDownMode) this.oct = 0;
          else {
            this.dir = 2;
            if (dn.count < 2) this.oct = Math.max(range, 2) - 2;
            else { this.step = 1; this.oct = range - 1; }
          }
        }
      }
    }
    list = this.dir === 2 ? dn : up;
    this.key = list.keys[this.step];
    this.vel = list.vels[this.step];
  }

  /** modes 3-5: random key and octave from the ascending list */
  private stepRandom(mode: number): void {
    const prevKey = this.key, prevOct = this.oct;
    for (;;) {
      const n = this.c.count;
      const i = Math.trunc(this.rand() * n * 0.9999);
      this.key = this.c.keys[i]; this.vel = this.c.vels[i];
      this.oct = Math.trunc(this.rand() * this.range * 0.9999);
      if (mode === 4) {
        if (this.range * n < 2) return;
        if (this.key !== prevKey) return;
        if (prevOct !== this.oct) return;
        continue;
      }
      if (mode !== 5) return;
      if (n < 2) return;
      if (this.key === prevKey) continue;
      return;
    }
  }

  private play(): void {
    let o = this.oct * 12 + this.key;
    o = o < 127 ? o : 127;
    o = o > 0 ? o : 0;
    this.out = o;
    this.sink.noteOn(o, this.vel);
  }

  /** 0x31a9c: the clock, once per sample. */
  tick(time: number): void {
    if (!this.running) return;
    let d0 = this.f8;
    if (d0 < time) { d0 = time - d0; this.f0 = d0; } else d0 = this.f0;
    d0 = d0 + this.f100;
    this.f8 = time; this.f100 = d0;
    const d9 = time + -0.001;
    let req = this.startReq;
    for (;;) {
      if (req) {
        let d1: number, nxt: number;
        const sm = this.startMode;
        if (sm !== 0) {
          this.f8 = time; this.f100 = time;
          nxt = time;
          if (sm === 2) { const per = this.period; nxt = per * Math.ceil(d9 / per); }
          this.c0 = nxt; this.c8 = nxt;
          d1 = time;
          this.startMode = 0;
        } else {
          d1 = this.f100; nxt = this.c8;
        }
        if (d1 < nxt) return;
        this.advance();
        this.startReq = false;
        req = false;
      }
      const c8 = this.c8;
      if (this.f100 < c8 + this.gateLen) return;
      this.c8 = c8 + this.period;
      if (this.out >= 0) { this.sink.noteOff(this.out, 0); this.out = -1; }
      this.startReq = true;
      req = true;
    }
  }
}

const RATE_SECONDS = [0.8109999895095825, 0.7540000081062317, 0.574999988079071, 0.4099999964237213, 0.210999995470047, 0.14399999380111694, 0.10199999809265137, 0.07699999958276749, 0.05299999937415123, 0.029999999329447746, 0.020999999716877937].map(f32);
const SYNC_TICKS = [96, 72, 64, 48, 36, 32, 24, 18, 16, 12, 9, 8, 6];

/** 0x62dc: the arpeggio period for a rate parameter: seconds, or beats when synced to the tempo. */
export function arpPeriod(v: number, sync: boolean, quant: (v: number, n: number) => number): number {
  if (sync) return SYNC_TICKS[quant(v, 13)] / 96;
  const s0 = f32(v * 10);
  const i = Math.trunc(s0);
  if (i > 9) return 0.020999999716877937;
  const fr = f32(s0 - i);
  return fma32(RATE_SECONDS[i], f32(1 - fr), f32(fr * RATE_SECONDS[i + 1]));
}
