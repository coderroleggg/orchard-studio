// BeepMap (FL: BeepMap, Plugin database > Generators > Synth special): "an image
// synth": a vertical line scans a bitmap from left to right; every pixel row is
// a sine, red = its amplitude on the left channel, green = on the right, the
// row's height sets its frequency, optional blue = the row's frequency range.
//
// A port of FL Studio 2026's plugin (BeepMap_x64.dylib, TTestPlug, arm64:
// ProcessParam 0x5e3c0, TriggerVoice 0x5eae0, Voice_Render 0x5f4b0, the column
// setup 0x5f150, the row speeds 0x5ed30, the sine kernels 0x60080 / 0x60160 /
// 0x60230, the bitmap load 0x5f780) and of the channel-sampler voice engine
// linked into it (the same code as 3x Osc's: release fade, gain ramp, pan law),
// in FL's arithmetic. See docs/research/gen/beepmap.md.
//
// Per voice and FL render block (here: the channel's audio block):
// - the voice owns one sine per bitmap row: a 32-bit phase (the left channel's;
//   TriggerVoice draws it at random, Random(2^24) << 8) and, with Widen, a random
//   offset for the right channel; a pixel lasts `pixel duration` samples
//   (64 + 256 (e^(3.4965 v / 4096) - 1), v = LENGTH); at the start of every
//   pixel (column) each row's target amplitudes are the pixel's red / green
//   bytes x 1 / (255 sqrt(rows)), and the amplitudes glide linearly from where
//   they were (the previous column's) to the targets over the pixel;
// - the rows' phase increments: Log scale: pitch (cents) minus FREQ x (blue
//   scale) x (2 y - (rows - 1)) / (512 (rows - 1)), clamped to +-4800 cents around
//   C5; Linear: the same in Hz around the note's frequency (range x 1.5), 40 Hz
//   .. a quarter of the sample rate; Harmonics: row y plays harmonic (rows - y) of
//   the note two octaves down (spacing 9 - blue / 32), fading out above FREQ's
//   Hz limit;
// - each row is read from FL's host sine table at (phase >> 18) (left) and
//   (phase + offset) >> 18 (right: without wrapping, so offsets past one cycle
//   read the table that follows the sine in FL's memory, the triangle), the
//   rows are summed in double and stored in single precision per block,
//   Grainy multiplies the block by a sine of one cycle per pixel;
// - the voice ends when the column counter passes the bitmap's width (Loop off:
//   after the last pixel a silent one follows) and, like every FL voice, with
//   its release fade.
//
// The voice is then scaled by FL's pan law of its pan / volume levels (the
// velocity, channel volume and INS envelopes arrive in the levels:
// def.levels 'plugin'), ramped from block to block (at most 0.001 per sample),
// and a note off starts FL's 441-sample cosine fade (10 ms built at 44.1 kHz).

import type { GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import { PITCH_C5 } from '../levels';
import { FL_TABLES, FADE, FADE_LEN } from './3xosc/tables';
import { rng } from './beepmap/rng';
import { bitmapOf, standinBitmap } from '../../../model/gen/plugins/beepmap/image';

export { seedBeepMapRandom } from './beepmap/rng';

const fr = Math.fround;
/** As many voices as a channel holds, so a voice the channel still renders is never reused. */
const MAX_VOICES = 128;
/** 2^32 x FL's C5 (523.2511 Hz): speed = f32(C / rate) x 2^(cents / 1200). */
const C5_SPEED = 2247346493527.166;
/** ln 2 / 1200, as FL computes it (ln 2 / 12 / 100 in double). */
const K_CENTS = 0.057762265046662105 / 100;
/** FL's voice gain ramp limit per sample. */
const MAX_STEP = fr(0.001);
const PI_4 = 0.7853981633974483;
const INT_MAX = 0x7fffffff;
/**
 * The sine table as FL's sine kernels read it: FL's host wavetables are one
 * 0x10000-byte step apart, so reads past the 16384-point sine (the right
 * channel's phase + offset can reach twice the range) land in the triangle.
 */
const TAB = new Float32Array(32768);
TAB.set(FL_TABLES[0], 0);
TAB.set(FL_TABLES[1], 16384);

/** FL's pan law (ComputeLRVol / the voice engine's pan law): f32 gains for a pan -1..1 and volume. */
function lrVol(pan: number, vol: number, out: { l: number; r: number }): void {
  const p = pan >= -1 ? (pan > 1 ? 1 : pan) : -1; // NaN -> -1 (FL's ComputeLRVol)
  const a = fr(fr(p + 1) * PI_4);
  out.l = fr(fr(Math.cos(a)) * vol);
  out.r = fr(fr(Math.sin(a)) * vol);
}

/** Round to nearest, ties to even (FPC's frintx). */
function rint(v: number): number {
  const r = Math.round(v);
  return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** FL's pitch -> phase increment (0x1c2460): a 32-bit unsigned speed. */
function speedOf(e8: number, cents: number): number {
  const v = e8 * Math.exp(cents * K_CENTS);
  if (!(v === v)) return 0;
  if (!(v < 9223372036854775808)) return 0xffffffff;
  return (rint(v) % 4294967296) >>> 0;
}

/** FL's Hz -> phase increment (0x1c24b0): (hz << 32) div rate, a 32-bit unsigned speed. */
function hzSpeed(hz: number, rate: number): number {
  const a = hz * 4294967296;
  let q = Math.floor(a / rate);
  if (q * rate > a) q--; else if ((q + 1) * rate <= a) q++;
  return (q % 4294967296 + 4294967296) % 4294967296;
}

/** FL's ramp step (the voice engine's 0x71480): step over `len` samples from `last` to `target`, clamped to +-max (then the target follows). */
function rampStep(target: number, len: number, last: number, out: { step: number; target: number }): void {
  let step = fr(target - last);
  out.target = target;
  if (Object.is(step, 0)) { out.step = 0; return; }
  step = fr(step / len);
  if (Math.abs(step) > MAX_STEP) {
    step = step < 0 ? -MAX_STEP : MAX_STEP;
    let t = fr(last + fr(step * len));
    if (Math.abs(t) < 5.960464477539063e-8) { t = 0; step = fr(-last / len); }
    out.target = t;
  }
  out.step = step;
}

/** A bitmap row's sine (FL's 0x30-byte records at voice + 0x30), as parallel arrays. */
class Rows {
  cap = 0;
  /** Left phase (+0), right phase offset (+4), phase increment (+8). */
  phase = new Uint32Array(0);
  off = new Uint32Array(0);
  inc = new Uint32Array(0);
  /** Frequency in Hz of the row (+0xc, Linear / Harmonics), blue scale (+0x28). */
  hz = new Int32Array(0);
  blue = new Int32Array(0);
  /** Amplitudes (+0x10 / +0x14), slopes (+0x18 / +0x1c), targets (+0x20 / +0x24), [left, right] per row. */
  amp = new Float32Array(0);
  slope = new Float32Array(0);
  tgt = new Float32Array(0);
  /** The row sounds (+0x2c: any of amplitude / target non-zero). */
  act = new Uint8Array(0);

  ensure(n: number): void {
    if (n <= this.cap) return;
    this.cap = n;
    this.phase = new Uint32Array(n);
    this.off = new Uint32Array(n);
    this.inc = new Uint32Array(n);
    this.hz = new Int32Array(n);
    this.blue = new Int32Array(n);
    this.amp = new Float32Array(2 * n);
    this.slope = new Float32Array(2 * n);
    this.tgt = new Float32Array(2 * n);
    this.act = new Uint8Array(n);
  }
}

class BeepVoice implements GenVoice {
  params: GenVoiceParams | null = null;
  free = true;
  readonly r = new Rows();
  /** The bitmap generation this voice was triggered with (a new bitmap kills the voices: FL's 0x5ecb0). */
  epoch = 0;
  private n = 0;
  // FL's voice record (+0x10 .. +0x24)
  private lastPitch = INT_MAX;
  private col = -1;
  private pos = 0;
  private next = 0;
  private gPhase = 0;
  private gInc = 0;
  private finished = false;
  /** Frames of the voice's blocks rendered so far (to end a block at the note off of a sequenced note, as FL's events do). */
  private elapsed = 0;
  /** The current FL block's sine bank output (FL renders a voice's whole block before the engine mixes it). */
  bufL: Float32Array;
  bufR: Float32Array;
  /** Release fade position (-1 = not released). */
  private fade = -1;
  private first = true;
  /** Frames left in the current FL block, and the position in it. */
  private remain = 0;
  private bpos = 0;
  // the current block's gain ramp (FL: last / target gains, steps, kernel accumulators)
  private lastL = 0;
  private lastR = 0;
  private tgtL = 0;
  private tgtR = 0;
  private stepL = 0;
  private stepR = 0;
  private ramp = false;
  private evenL = 0;
  private evenR = 0;
  private oddL = 0;
  private oddR = 0;
  private tailStart = 0;

  constructor(private readonly k: BeepMap, size: number) {
    this.bufL = new Float32Array(size);
    this.bufR = new Float32Array(size);
  }

  /** FREQ changed: recompute the rows' speeds at the next block (FL's ProcessParam 0 resets the voice's pitch cache). */
  invalidatePitch(): void {
    this.lastPitch = INT_MAX;
  }

  start(p: GenVoiceParams): void {
    const k = this.k;
    this.params = p;
    this.free = false;
    this.epoch = k.epoch;
    this.fade = -1;
    this.first = true;
    this.remain = 0;
    this.finished = false;
    this.elapsed = 0;
    // TriggerVoice (0x5eae0)
    const n = this.n = k.rows;
    const r = this.r;
    r.ensure(n);
    this.lastPitch = INT_MAX;
    this.col = -1;
    this.pos = 0;
    this.next = 0;
    this.gPhase = 0;
    this.gInc = 0;
    for (let i = 0; i < n; i++) {
      r.phase[i] = (rng.random(0x1000000) << 8) >>> 0;
      r.off[i] = k.widen ? (rng.random(0x1000000) << 8) >>> 0 : 0;
      r.amp[2 * i] = 0;
      r.amp[2 * i + 1] = 0;
      // not initialised by FL until the first column setup
      r.blue[i] = 256;
      r.hz[i] = 0;
      r.inc[i] = 0;
    }
  }

  /** The rows' phase increments (0x5ed30) for the voice's pitch (lastPitch, cents relative to C5) and the rows' blue scales. */
  private speeds(): void {
    const k = this.k, r = this.r, n = this.n;
    const n1 = n - 1;
    const w23 = (n1 * 512) | 0;
    const rate = k.sampleRate;
    const pitch = this.lastPitch | 0;
    if (k.scale === 0) {
      for (let i = 0; i < n; i++) {
        const prod = Math.imul(r.blue[i], k.freq) * (2 * i - n1);
        const q = w23 === 0 ? 0 : Math.trunc(prod / w23);
        let x = pitch - q;
        if (x < -4800) x = -4800;
        if (x > 4800) x = 4800;
        r.inc[i] = speedOf(k.e8, x);
      }
    } else if (k.scale === 1 || k.scale === 2) {
      const harm = k.scale === 2;
      let w24 = Math.trunc(rate / 4);
      let f0 = rint(523.25113060119702 * Math.exp((harm ? pitch - 2400 : pitch) * K_CENTS));
      if (f0 > w24) f0 = w24;
      if (f0 !== 0) w24 = Math.trunc(w24 / f0) * f0;
      const w21 = Math.trunc((k.freq * 3) / 2);
      for (let i = 0; i < n; i++) {
        let hz: number;
        if (harm) {
          const x2 = f0 * (n - i);
          const sh = 9 - Math.trunc(r.blue[i] / 32);
          hz = (sh * x2) | 0;
        } else {
          const w22 = Math.imul(r.blue[i], w21);
          const prod = w22 * (2 * i - n1);
          const q = w23 === 0 ? 0 : Math.trunc(prod / w23);
          hz = (f0 - q) | 0;
        }
        r.hz[i] = hz;
        let x2 = hz > 40 ? hz : 40;
        if (x2 > w24) x2 = w24;
        r.inc[i] = hzSpeed(x2, rate);
      }
    }
  }

  /** The start of a pixel (0x5f150): targets from the bitmap column, the speeds, the glide slopes. */
  private column(): void {
    const k = this.k, r = this.r, n = this.n;
    // Harmonics: the frequency (Hz) above which rows fade out
    let limit = INT_MAX;
    if (k.scale === 2) {
      let d = fr(k.freq * 0.00010416666666666667);
      d = fr(Math.exp(d * 2.3978952727983707) - 1);
      limit = rint(d * 1102.5) | 0;
    }
    let rows = n;
    const w = k.imgW;
    if (w <= this.col) {
      if (k.loop) this.col = 0; else rows = -1;
      if (w === 0) rows = -1;
    }
    const col = this.col;
    const px = k.px;
    const sc = k.ampScale;
    for (let i = 0; i < n; i++) {
      // flush a vanished amplitude (0x169b30)
      if (Math.abs(r.amp[2 * i]) < 5.960464477539063e-8) r.amp[2 * i] = 0;
      if (Math.abs(r.amp[2 * i + 1]) < 5.960464477539063e-8) r.amp[2 * i + 1] = 0;
      r.blue[i] = 256;
      r.tgt[2 * i] = 0;
      r.tgt[2 * i + 1] = 0;
      if (i < rows) {
        const c = px[i * w + col];
        r.tgt[2 * i] = fr(((c >>> 16) & 255) * sc);
        r.tgt[2 * i + 1] = fr(((c >>> 8) & 255) * sc);
        if (k.blue) r.blue[i] = 256 - (c & 255);
      }
    }
    this.speeds();
    const inv = k.pixInv;
    for (let i = 0; i < n; i++) {
      if (r.hz[i] > limit) {
        const t = fr(1 - (r.hz[i] - limit) * 0.0020833333333333333);
        const s2 = t >= 0 ? t : 0;
        r.tgt[2 * i] = fr(r.tgt[2 * i] * s2);
        r.tgt[2 * i + 1] = fr(r.tgt[2 * i + 1] * s2);
      }
      r.slope[2 * i] = fr(fr(r.tgt[2 * i] - r.amp[2 * i]) * inv);
      r.slope[2 * i + 1] = fr(fr(r.tgt[2 * i + 1] - r.amp[2 * i + 1]) * inv);
      r.act[i] = r.amp[2 * i] !== 0 || r.amp[2 * i + 1] !== 0 || r.tgt[2 * i] !== 0 || r.tgt[2 * i + 1] !== 0 ? 1 : 0;
    }
    this.gInc = Math.floor(4294967296 / k.pixLen) >>> 0;
  }

  /** One row's sine into the block (0x60160 writes, 0x60080 adds): `n` frames from `o`, amplitudes in double. */
  private sine(i: number, o: number, n: number, write: boolean): void {
    const r = this.r;
    const L = this.bufL, R = this.bufR;
    let ph = r.phase[i];
    const inc = r.inc[i], off = r.off[i];
    let aL = r.amp[2 * i], aR = r.amp[2 * i + 1];
    const sL = r.slope[2 * i], sR = r.slope[2 * i + 1];
    if (write) {
      for (let j = 0; j < n; j++) {
        L[o + j] = TAB[ph >>> 18] * aL;
        R[o + j] = TAB[Math.floor((ph + off) / 262144)] * aR;
        aL += sL; aR += sR;
        ph = (ph + inc) >>> 0;
      }
    } else {
      for (let j = 0; j < n; j++) {
        L[o + j] = L[o + j] + TAB[ph >>> 18] * aL;
        R[o + j] = R[o + j] + TAB[Math.floor((ph + off) / 262144)] * aR;
        aL += sL; aR += sR;
        ph = (ph + inc) >>> 0;
      }
    }
    r.phase[i] = ph;
    r.amp[2 * i] = aL;
    r.amp[2 * i + 1] = aR;
  }

  /** FL's Voice_Render for `len` frames into bufL / bufR (0x5f4b0); true once the voice has passed the end of the bitmap. */
  private voiceRender(len: number): boolean {
    const k = this.k, p = this.params!, r = this.r, n = this.n;
    const pitch = rint(fr(p.levels.pitch - PITCH_C5)) | 0;
    if (pitch !== this.lastPitch) {
      this.lastPitch = pitch;
      this.speeds();
    }
    const L = this.bufL, R = this.bufR;
    L.fill(0, 0, len);
    R.fill(0, 0, len);
    const end = (this.pos + len) | 0;
    let o = 0;
    while (this.pos < end) {
      if (this.pos === this.next) {
        this.next = (this.next + k.pixLen) | 0;
        this.col = (this.col + 1) | 0;
        this.column();
      }
      const stop = Math.min(end, this.next);
      const m = stop - this.pos;
      this.pos = stop;
      this.sine(0, o, m, true);
      for (let i = 1; i < n; i++) {
        if (r.act[i]) this.sine(i, o, m, false);
        else r.phase[i] = (r.phase[i] + Math.imul(m, r.inc[i])) >>> 0;
      }
      if (k.grainy) {
        let ph = this.gPhase;
        const inc = this.gInc;
        for (let j = 0; j < m; j++) {
          const t = TAB[ph >>> 18];
          L[o + j] = L[o + j] * t;
          R[o + j] = R[o + j] * t;
          ph = (ph + inc) >>> 0;
        }
        this.gPhase = ph;
      }
      o += m;
    }
    return k.imgW < this.col;
  }

  /**
   * A new FL block of `len` frames (FL: Voice_Render then the engine's mix): the
   * sine bank for the whole block, and the gain ramp toward the current pan /
   * volume levels.
   */
  private beginBlock(p: GenVoiceParams, len: number): void {
    const k = this.k;
    // FL splits its blocks at the note off: a sequenced note's release (its length) ends a block
    const toOff = p.length - this.elapsed;
    if (toOff > 0 && toOff < len) len = toOff;
    this.elapsed += len;
    if (!this.first) { this.lastL = this.tgtL; this.lastR = this.tgtR; }
    if (this.voiceRender(len)) this.finished = true;
    const g = k.lr;
    const vol = fr(p.levels.vol);
    lrVol(fr(p.levels.pan), vol === vol ? vol : 0, g);
    if (this.first) {
      this.first = false;
      this.lastL = this.tgtL = g.l;
      this.lastR = this.tgtR = g.r;
      this.stepL = this.stepR = 0;
      this.ramp = false;
    } else {
      const rs = k.rs;
      rampStep(g.l, len, this.lastL, rs); this.stepL = rs.step; this.tgtL = rs.target;
      rampStep(g.r, len, this.lastR, rs); this.stepR = rs.step; this.tgtR = rs.target;
      this.ramp = !(Object.is(this.stepL, 0) && Object.is(this.stepR, 0));
    }
    this.evenL = this.lastL;
    this.evenR = this.lastR;
    this.oddL = fr(this.lastL + this.stepL);
    this.oddR = fr(this.lastR + this.stepR);
    this.tailStart = len - (len % 8);
    this.remain = len;
    this.bpos = 0;
  }

  render(L: Float32Array, R: Float32Array, n: number): boolean {
    const p = this.params;
    if (!p || this.epoch !== this.k.epoch) return false;
    const k = this.k;
    for (let j = 0; j < n;) {
      if (this.remain === 0) {
        // FL blocks follow the channel's blocks: the first one ends with the current block
        const len = this.first ? Math.max(1, Math.min(this.bufL.length, k.flBlock - p.frame - j)) : Math.min(this.bufL.length, k.flBlock);
        this.beginBlock(p, len);
      }
      const m = Math.min(n - j, this.remain);
      const bl = this.bufL, br = this.bufR;
      let f = this.bpos;
      const end = f + m;
      // release fade (FL's out declick: the voice ends with it)
      if (this.fade >= 0) {
        for (let i = f; i < end; i++) {
          const q = this.fade++;
          if (q < FADE_LEN) { const t = FADE[q]; bl[i] *= t; br[i] *= t; }
          else { bl[i] = 0; br[i] = 0; }
        }
      }
      // voice gain: constant, or FL's ramp kernel (pairs of samples: even / odd accumulators; tail with crossed steps)
      if (!this.ramp) {
        const gl = this.tgtL, gr = this.tgtR;
        for (let i = f, o = j; i < end; i++, o++) { L[o] += fr(bl[i] * gl); R[o] += fr(br[i] * gr); }
      } else {
        const s2L = fr(this.stepL + this.stepL), s2R = fr(this.stepR + this.stepR);
        for (let o = j; f < end; f++, o++) {
          if (f < this.tailStart) {
            if ((f & 1) === 0) {
              L[o] += fr(bl[f] * this.evenL); R[o] += fr(br[f] * this.evenR);
            } else {
              L[o] += fr(bl[f] * this.oddL); R[o] += fr(br[f] * this.oddR);
              this.evenL = fr(this.evenL + s2L); this.evenR = fr(this.evenR + s2R);
              this.oddL = fr(this.oddL + s2L); this.oddR = fr(this.oddR + s2R);
            }
          } else {
            L[o] += fr(bl[f] * this.evenL); R[o] += fr(br[f] * this.evenR);
            const el = fr(this.evenL + this.stepR);
            this.evenR = fr(this.evenR + this.stepL);
            this.evenL = el;
          }
        }
      }
      this.bpos += m;
      this.remain -= m;
      j += m;
    }
    // the voice ends after the FL block in which the bitmap ended or the fade ran out
    return !(this.fade >= FADE_LEN || (this.finished && this.remain === 0));
  }

  release(): void {
    if (this.fade < 0) this.fade = 0;
  }

  kill(): void {
    this.free = true;
    this.params = null;
  }
}

const num = (q: Record<string, unknown>, key: string, d: number, lo: number, hi: number): number => {
  const v = Number(q[key] ?? d);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;
};

class BeepMap implements GenInstance {
  readonly sampleRate: number;
  /** f32(2^32 x 523.2511 / rate) (FL: plugin +0xe8). */
  readonly e8: number;
  /** Length of an FL render block for the voice gain ramp (the channel's audio block). */
  flBlock: number;
  // FL's plugin fields (+0x130 ..): the parameters
  freq = 7200;
  length = 2048;
  scale = 0;
  blue = false;
  grainy = false;
  loop = true;
  widen = true;
  /** Pixel length in samples (+0x18c) and its reciprocal (+0x190). */
  pixLen = 1;
  pixInv = 1;
  /** The bitmap: rows, columns, pixels (0xRRGGBB, row-major), amplitude scale 1 / (255 sqrt(rows)) (+0x16c). */
  rows = 1;
  imgW = 1;
  px: Uint32Array = new Uint32Array(1);
  ampScale = 1;
  /** Bitmap generation: voices of an older one end (FL kills them when a bitmap is loaded). */
  epoch = 0;
  readonly lr = { l: 0, r: 0 };
  readonly rs = { step: 0, target: 0 };
  private readonly voices: BeepVoice[] = [];
  /** The state's bitmap text last decoded. */
  private bmpText = '';

  constructor(sampleRate: number, blockSize: number) {
    this.sampleRate = sampleRate;
    this.e8 = fr(C5_SPEED / sampleRate);
    this.flBlock = Math.max(1, blockSize | 0);
    const size = Math.max(16, this.flBlock);
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new BeepVoice(this, size));
    this.setBitmap(standinBitmap());
    this.derivePixel();
    this.setParams({});
  }

  /** Test hook (FL test host parity): the length of the next FL blocks. */
  setBlockLength(n: number): void {
    this.flBlock = Math.max(1, n | 0);
    for (const v of this.voices) {
      if (v.bufL.length >= this.flBlock) continue;
      const a = new Float32Array(this.flBlock), b = new Float32Array(this.flBlock);
      a.set(v.bufL); b.set(v.bufR);
      v.bufL = a; v.bufR = b;
    }
  }

  /** Test hook: play this bitmap (w x h, 0xRRGGBB, top row first) instead of the state's. */
  setBitmap(b: { w: number; h: number; px: Uint32Array }): void {
    this.imgW = b.w;
    this.rows = b.h;
    this.px = b.px;
    this.ampScale = fr(1 / (255 * Math.sqrt(b.h)));
    this.epoch++;
  }

  /** FL's pixel duration (ProcessParam 1, 0x5e3c0): 64 + 256 (e^(3.4965 v / 4096) - 1) samples at 44.1 kHz, scaled to the rate. */
  private derivePixel(): void {
    const d = fr(this.length * 0.000244140625);
    const w24 = rint(fr(fr(Math.exp(d * 3.4965075614664802) - 1) * 256)) + 64;
    const len = Math.trunc((this.sampleRate * w24) / 44100);
    this.pixLen = len < 1 ? 1 : len;
    this.pixInv = fr(1 / this.pixLen);
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    // the state's bitmap (FL: a new bitmap kills the voices; an unchanged text is not decoded again)
    const text = typeof q.bmp === 'string' ? q.bmp : '';
    if (text !== this.bmpText) { this.bmpText = text; this.setBitmap(bitmapOf(text)); }
    const freq = num(q, 'freq', 7200, 24, 9600);
    if (freq !== this.freq) for (const v of this.voices) if (!v.free) v.invalidatePitch();
    this.freq = freq;
    const length = num(q, 'length', 2048, 0, 4096);
    this.scale = num(q, 'scale', 0, 0, 2);
    this.blue = num(q, 'blue', 0, 0, 1) > 0;
    this.grainy = num(q, 'grainy', 0, 0, 1) > 0;
    this.loop = num(q, 'loop', 1, 0, 1) > 0;
    this.widen = num(q, 'widen', 1, 0, 1) > 0;
    if (length !== this.length) { this.length = length; this.derivePixel(); }
  }

  triggerVoice(p: GenVoiceParams): GenVoice | null {
    for (const v of this.voices) {
      if (!v.free) continue;
      v.start(p);
      return v;
    }
    return null;
  }

  reset(): void {
    for (const v of this.voices) v.kill();
  }
}

export const gen: GenModule = {
  id: 'beepmap',
  create: (sampleRate, blockSize) => new BeepMap(sampleRate, blockSize),
};
