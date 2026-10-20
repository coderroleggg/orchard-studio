// Ogun's effects chain: the part of Gen_Render (0x706b0 of Ogun_x64.dylib, FL 2026 arm64) after the voices. The summed voices
// (the plugin's mix, interleaved stereo at the processing rate: the host rate times the oversampling of the quality) go through
//
//   3-band EQ (0x705f0) -> chorus (0xaf460 / 0xaf7d0) -> delay (0x268270 + feedback kernels) -> reverb (mono sum, libreverb)
//   -> halfband downsampler (0xb0230, only at the qualities that oversample) -> added to the host's buffer.
//
// The chorus, the delay's ring and kernels and the reverb are the library classes Harmor's FX use (TStereoFlanger, TDelay_32FS,
// TFruityReverb + libreverb: function for function the same machine code, checked by instruction listings), so they are the
// Harmor ports driven with Ogun's own parameter laws. What is Ogun's own: the parameter refreshes (0x6d970 chorus, 0x6d3f0
// delay, 0x6d6d0 reverb, 0x6dd60 EQ band), the EQ bands, the input/output handling (the delay's input is not filtered or
// gain-staged, its wet and the reverb's wet are added with vDSP_vsma = a fused multiply-add) and the halfband decimator.
//
// FL's plugin fields by offset in brackets (plug.*): tail counter +0x5c4 / base +0x5c8, EQ bands +0x398 + 0x80 k, delay record
// +0x368, chorus +0x358 (dry gain +0x360), reverb +0x388 (wet gain +0x390), downsampler +0x548.

import { HarmorChorus } from '../harmor/fx-chorus';
import { HarmorReverb } from '../harmor/fx-reverb';
import { FlRate, f32, rint } from '../harmor/fx-util';
import { cos, exp, log, sin } from '../harmor/fx-libm';
import { Biquad } from './biquad';
import { isSilent } from './fftsynth';

const LN101 = 4.6151205168412597;
const LN1001 = 6.9087547793152204;
const LN5 = 1.6094379124341003;
/** G[3f4824]: float32 ln 11 (the delay volume law). */
const LN11F = f32(2.3978952727983707);
const F001 = f32(0.01);
/** 0.1f: the delay volume law's float32 constant, widened to double. */
const F01F = f32(0.1);

// ---------------------------------------------------------------------------------------------------------------- helpers

/**
 * float32 fused multiply-add c + a * b with one rounding (vDSP_vsma, behind ippsAddProductC_32f): a * b is exact in double;
 * s = a * b + c is the correctly rounded double of the exact sum, so rounding s to float32 is right unless s lies exactly
 * halfway between two floats; then the exact error of s (TwoSum) decides the direction.
 */
export function fma32(a: number, b: number, c: number): number {
  const p = a * b;
  const s = p + c;
  const r = f32(s);
  if (r === s || r - r !== 0) return r;
  const m = 2 * s - r;
  if (f32(m) !== m) return r;
  const t = s - p;
  const e = p - (s - t) + (c - t);
  if (e > 0) return r > m ? r : m;
  if (e < 0) return r < m ? r : m;
  return r;
}

/** FPC's integer power (0x11a0b0): binary exponentiation. */
function intPower(b: number, n: number): number {
  if (b === 0 && n === 0) return 1;
  if (n < 0) {
    b = 1 / b;
    n = -n;
  }
  let r = 1;
  while (n > 0) {
    if ((n & 1) === 0) {
      n >>= 1;
      b = b * b;
    } else {
      n--;
      r = r * b;
    }
  }
  return r;
}

/** FL's float power (0x1d5f60): integer exponents (as trunc(y + 0.5) == y) by the integer power, else exp(y log x). */
function powF(x: number, y: number): number {
  if (y === 0) return 1;
  if (x === 0 && y > 0) return 0;
  if (Math.trunc(f32(y + 0.5)) === y) return f32(intPower(x, Math.trunc(y)));
  return f32(exp(y * log(x)));
}

// ---------------------------------------------------------------------------------------------------------------- EQ

/** One EQ band (record +0x398 + 0x80 k): type 0 low shelf / 1 peaking / 2 high shelf, the countdown, the biquad. */
class EqBand {
  /** +0x00 type. */
  type = 0;
  /** +0x04 samples left to process (-1: always, 0: off). */
  count = 0;
  /** +0x08 the biquad record (type = band type + 6). */
  readonly bq = new Biquad();
  /** +0x0c gain in dB, +0x10 frequency, +0x14 width (float32). */
  gain = 0;
  freq = 0;
  width = 0;
}

/** 0x7f4f0 for the shelves and the peaking band: the biquad coefficients from the band's gain, frequency and width. */
function eqDesign(b: EqBand, rate: FlRate): void {
  if (b.freq > rate.nyq) b.freq = rate.nyq;
  const x = b.freq * rate.w;
  const s = sin(x), c = cos(x);
  const bq = b.bq;
  const A = powF(10, f32(b.gain * 0.025));
  let d1: number;
  if (bq.type === 7) {
    const wl = f32(exp(b.width * log(1001)) - 1);
    const d8 = 0.1 + wl * 0.0999;
    d1 = s / (2 * d8);
  } else {
    const d8 = 0.1 + b.width * 1.9;
    const t = A - 1;
    d1 = Math.sqrt((A * A + 1) / d8 - t * t);
  }
  bq.design(A, d1, s, c);
}

// ---------------------------------------------------------------------------------------------------------------- halfband

/** The six allpass coefficients of the halfband decimator (doubles: low word, high word). */
const HB = new Float64Array(
  new Uint32Array([
    0xd58c3526, 0x3fc2dd40, 0x9fb6183a, 0x3fa40bad, 0xbd22db5f, 0x3fdee0c3, 0xe2f3bc08, 0x3fd35e90, 0xc17c4250, 0x3fec4193,
    0x1f70a58f, 0x3fe59674,
  ]).buffer,
);

/**
 * FL's oversampling stage (0xb0230 with the kernel G[3fe808]): a polyphase IIR halfband, two branches of three first-order
 * allpass sections in doubles, 24 doubles of state per stage (6 q-registers of outputs, then 6 of inputs). While the input
 * and the first 12 state doubles read as float32 are all within 1e-6, the stage is skipped: the block is only counted down.
 */
export class OgunHalfband {
  private readonly st: Float64Array[] = [];
  private readonly view: Float32Array[] = [];

  constructor(readonly stages: number) {
    for (let k = 0; k < stages; k++) {
      const s = new Float64Array(24);
      this.st.push(s);
      this.view.push(new Float32Array(s.buffer));
    }
  }

  /** 0xb00a0: zero the stages. */
  clear(): void {
    for (const s of this.st) s.fill(0);
  }

  /** Downsample the interleaved block in place by 2^stages; returns the number of frames left. */
  process(buf: Float32Array, n: number): number {
    const hi = this.stages - 1;
    if (hi < 0) return n;
    // 0xb0190: silent input and silent states: only the count
    if (isSilent(buf, 2 * n, 1e-6)) {
      let sil = true;
      for (let k = hi; k >= 0 && sil; k--) if (!isSilent(this.view[k], 24, 1e-6)) sil = false;
      if (sil) return n >>> (hi + 1);
    }
    for (let k = hi; k >= 0; k--) {
      n >>>= 1;
      const s = this.st[k];
      this.lane(s, 0, buf, n);
      this.lane(s, 1, buf, n);
      // G[3f4980](stage, 12): doubles below 2^-24 become 0
      for (let i = 0; i < 12; i++) if (Math.abs(s[i]) < 5.960464477539063e-8) s[i] = 0;
    }
    return n;
  }

  /** One channel of the kernel over n output frames, in place (input frame pairs 2i, 2i + 1 -> output frame i). */
  private lane(st: Float64Array, j: number, buf: Float32Array, n: number): void {
    const c0 = HB[0], c1 = HB[1], c2 = HB[2], c3 = HB[3], c4 = HB[4], c5 = HB[5];
    let s0 = st[j], s1 = st[2 + j], s2 = st[4 + j], s3 = st[6 + j], s4 = st[8 + j], s5 = st[10 + j];
    let s6 = st[12 + j], s7 = st[14 + j], s8 = st[16 + j], s9 = st[18 + j], s10 = st[20 + j], s11 = st[22 + j];
    for (let i = 0; i < n; i++) {
      const x0 = buf[4 * i + j], x1 = buf[4 * i + 2 + j];
      const yA1 = s6 + (x0 - s0) * c0;
      s6 = x0;
      s0 = yA1;
      const yB1 = s9 + (x1 - s3) * c1;
      const yA2 = s7 + (yA1 - s1) * c2;
      const yB2 = s10 + (yB1 - s4) * c3;
      s9 = x1;
      s10 = yB1;
      const yA3 = s8 + (yA2 - s2) * c4;
      s7 = yA1;
      s8 = yA2;
      s1 = yA2;
      s2 = yA3;
      s3 = yB1;
      s4 = yB2;
      const yB3 = s11 + (yB2 - s5) * c5;
      s11 = yB2;
      s5 = yB3;
      buf[2 * i + j] = (yA3 + yB3) * 0.5;
    }
    st[j] = s0; st[2 + j] = s1; st[4 + j] = s2; st[6 + j] = s3; st[8 + j] = s4; st[10 + j] = s5;
    st[12 + j] = s6; st[14 + j] = s7; st[16 + j] = s8; st[18 + j] = s9; st[20 + j] = s10; st[22 + j] = s11;
  }
}

// ---------------------------------------------------------------------------------------------------------------- delay

/**
 * Ogun's delay: the TDelay_32FS (a ring of stereo frames with a read and a write pointer and a feedback kernel per mode) of
 * Harmor's delay without its filters and gains. The input is added to the ring at the write position plus the channel's
 * offset (while the plugin's tail is active), the kernel reads and clears the read frame, feeds it back into the write frame
 * and stores it in the wet block (mode 0 straight, 1 swapped, 2 swapped with cross feedback).
 */
class OgunDelay {
  exists = false;
  /** D+0x18: the wet gain (signed), D+0x1c: the stereo offset in 1/100 ms (float32). */
  level = 0;
  ofsMs = 0;
  private ring = new Float32Array(0);
  private size = 0;
  private rd = 0;
  private wr = 0;
  private fbT = 0.5;
  private fbC = 0;
  private offL = 0;
  private offR = 0;
  private fbStart = 0;
  private fbStep = 0;

  constructor(private readonly rate: FlRate) {}

  free(): void {
    this.exists = false;
    this.ring = new Float32Array(0);
    this.size = 0;
  }

  /** 0x6d3f0 after the stereo offset law. `time` = parameter 27, `ofs` = 28, `vol` = 29, `fb` = 26. */
  refresh(sync: boolean, time: number, ofs: number, vol: number, fb: number, tempo: number, chunk: number): void {
    const r = this.rate;
    this.ofsMs = f32(f32(exp(f32(Math.abs(ofs) * 0.001953125) * LN1001) - 1) * 50);
    if (!this.exists) {
      this.exists = true;
      this.size = 0;
      this.rd = 0;
      this.wr = 0;
      this.fbT = 0.5;
      this.fbC = 0;
    }
    this.offL = rint(f32(f32(this.ofsMs * f32(r.sr)) / 100000));
    this.offR = 0;
    let d = r.sr * time;
    d = sync ? (d * 0.3125) / f32(tempo) : d / 384;
    this.setSize(this.offL + chunk, rint(d));
    if (ofs > 0) {
      const a = this.offL;
      this.offL = this.offR;
      this.offR = a;
    }
    this.fbT = f32(fb * 0.0078125);
    // the wet gain law: |v| / 128, v == 1 ? 1 : (exp(v ln 11) - 1) 0.1, times the sign
    const s8 = f32(vol * 0.0078125);
    const a8 = Math.abs(s8);
    const s9 = a8 === 1 ? a8 : f32((exp(f32(a8 * LN11F)) - 1) * F01F);
    this.level = f32(s9 * (s8 === 0 ? 0 : s8 < 0 ? -1 : 1));
  }

  /** 0x4617f0 / 0x461740: reallocate and clear only when the total size changes. */
  private setSize(extra: number, delay: number): void {
    const d = delay < 1 ? 1 : delay;
    const total = extra + d;
    if (total === this.size) return;
    if (this.ring.length < 2 * total) this.ring = new Float32Array(2 * total + 8192);
    else this.ring.fill(0, 0, 2 * total);
    this.size = total;
    this.fbC = this.fbT;
    this.rd = 0;
    this.wr = d;
  }

  /** The ring's clear (VMT +0xc8): zeros, current feedback to the target. */
  clear(): void {
    if (this.size > 0) this.ring.fill(0, 0, 2 * this.size);
    this.fbC = this.fbT;
  }

  /** 0x268270 twice (L, R), then the mode's kernel: `wet` receives the n frames. */
  process(src: Float32Array, wet: Float32Array, n: number, tailActive: boolean, mode: number): void {
    if (tailActive) {
      this.ringAdd(src, 0, n, this.wr + this.offL, 0);
      this.ringAdd(src, 1, n, this.wr + this.offR, 1);
    }
    this.fbRamp(n);
    let fb = this.fbStart;
    const step = this.fbStep;
    const ring = this.ring, size = this.size;
    let r = this.rd, w = this.wr;
    for (let i = 0; i < n; i++) {
      const rl = ring[2 * r], rr = ring[2 * r + 1];
      const o = 2 * i;
      let fl: number, fr: number;
      if (mode === 0) {
        wet[o] = rl;
        wet[o + 1] = rr;
        fl = rl;
        fr = rr;
      } else if (mode === 1) {
        wet[o] = rr;
        wet[o + 1] = rl;
        fl = rl;
        fr = rr;
      } else {
        wet[o] = rr;
        wet[o + 1] = rl;
        fl = rr;
        fr = rl;
      }
      ring[2 * r] = 0;
      ring[2 * r + 1] = 0;
      let v = ring[2 * w] + f32(fl * fb);
      ring[2 * w] = v === 0 ? 0 : v;
      v = ring[2 * w + 1] + f32(fr * fb);
      ring[2 * w + 1] = v === 0 ? 0 : v;
      fb = f32(fb + step);
      r++;
      w++;
      if (r >= size) r = 0;
      if (w >= size) w = 0;
    }
    this.rd = r;
    this.wr = w;
  }

  /** ring[pos.., ch] += src[.., ch] (one channel, n frames, with wrap): 0x268270. */
  private ringAdd(src: Float32Array, ch: number, n: number, pos: number, rch: number): void {
    const ring = this.ring, size = this.size;
    if (pos >= size) pos -= size;
    let first = size - pos;
    let si = ch;
    if (n > first) {
      for (let i = 0; i < first; i++) {
        const j = 2 * (pos + i) + rch;
        ring[j] = ring[j] + src[si];
        si += 2;
      }
      n -= first;
      pos = 0;
    }
    for (let i = 0; i < n; i++) {
      const j = 2 * (pos + i) + rch;
      ring[j] = ring[j] + src[si];
      si += 2;
    }
  }

  /** 0x7ccc0: the feedback's start and per-frame step for a block of n frames (at most the host's maximum step). */
  private fbRamp(n: number): void {
    const start = this.fbC;
    let step = f32(this.fbT - start);
    this.fbStart = start;
    if (step === 0) {
      this.fbStep = step;
      return;
    }
    this.fbC = this.fbT;
    step = f32(step / n);
    const maxStep = this.rate.step;
    if (Math.abs(step) > maxStep) {
      step = step < 0 ? -maxStep : maxStep;
      this.fbC = f32(start + f32(step * n));
      if (Math.abs(this.fbC) < 5.960464477539063e-8) {
        this.fbC = 0;
        step = f32(-start / n);
      }
    }
    this.fbStep = step;
  }
}

// ---------------------------------------------------------------------------------------------------------------- the chain

/** Everything the chain reads from the plugin (OgunPlug has these fields). */
export interface OgunFxState {
  readonly pi: Int32Array;
  /** FPD_SetBlockSize (plug+0x554): the host's largest block in frames; blocks are rendered whole up to it. */
  readonly block: number;
  readonly os: number;
  readonly srp: number;
  readonly tempo: number;
  readonly delayOn: boolean;
  readonly delaySync: boolean;
  readonly reverbOn: boolean;
  readonly reverbSync: boolean;
  readonly eqType: number[];
}

export class OgunFx {
  private rate = new FlRate(44100);
  private os = 1;
  private readonly eq = [new EqBand(), new EqBand(), new EqBand()];
  private chorus: HarmorChorus | null = null;
  private delay: OgunDelay;
  private reverb: HarmorReverb | null = null;
  private revLevel = 0;
  private hb = new OgunHalfband(0);
  /** plug+0x5c8 / +0x5c4: the tail base and the counter of samples the chain still takes input for. */
  tailBase = 100;
  private tailCnt = 0;
  /** plug+0x5a4: processing rate / 5 (samples an EQ band at 0 dB keeps running). */
  private eqHold = 0;
  private readonly prev = new Int32Array(49);
  private prevDelayOn = false;
  private prevDelaySync = false;
  private prevReverbOn = false;
  private prevReverbSync = false;
  private prevEq = [0, 0, 0];
  private prevTempo = 0;
  private ready = false;
  /** plug+0x554 * os: the longest block in processing frames, which the chorus and delay buffers are sized for. */
  private chunk = 0;
  private work = new Float32Array(0);
  private wet = new Float32Array(0);
  private mono = new Float32Array(0);
  private rev = new Float32Array(0);

  constructor() {
    this.delay = new OgunDelay(this.rate);
  }

  /** Whether the delay or the reverb exist (FL then renders the chain every block). */
  get open(): boolean {
    return this.delay.exists || this.reverb !== null;
  }

  /** Seconds the chain keeps sounding after the last voice (Infinity while the delay or the reverb run). */
  tailSeconds(): number {
    if (this.open) return Infinity;
    return this.tailBase / this.rate.sr;
  }

  /**
   * The plugin's parameters changed (ProcessParam handlers 0x6d970 chorus 19..25, 0x6d3f0 delay 26..30, 0x6d6d0 reverb 31..39,
   * 0x6dd60 EQ band 40..48) or the rate / quality did (0x682b0: all of them, the objects built anew).
   */
  apply(s: OgunFxState): void {
    const pi = s.pi;
    const rebuild = !this.ready || s.srp !== this.rate.sr || s.os !== this.os || s.block * s.os !== this.chunk;
    if (rebuild) {
      this.rate = new FlRate(s.srp);
      this.os = s.os;
      this.chunk = s.block * s.os;
      this.work = new Float32Array(2 * this.chunk);
      this.wet = new Float32Array(2 * this.chunk);
      this.mono = new Float32Array(this.chunk);
      this.rev = new Float32Array(2 * this.chunk);
      this.delay = new OgunDelay(this.rate);
      this.chorus = null;
      this.reverb = null;
      this.hb = new OgunHalfband(s.os > 1 ? 1 : 0);
      this.eqHold = Math.trunc(s.srp / 5);
      this.tailCnt = 0;
      for (let k = 0; k < 3; k++) {
        const b = this.eq[k];
        b.type = s.eqType[k];
        b.bq.type = b.type + 6;
        b.count = 0;
        b.bq.clearState();
      }
      this.prevTempo = s.tempo;
    }
    const changed = (a: number, b: number): boolean => {
      for (let i = a; i <= b; i++) if (pi[i] !== this.prev[i]) return true;
      return false;
    };
    if (rebuild || changed(19, 25)) this.refreshChorus(pi, s);
    if (rebuild || changed(26, 30) || s.delayOn !== this.prevDelayOn || s.delaySync !== this.prevDelaySync) this.refreshDelay(pi, s);
    if (rebuild || changed(31, 39) || s.reverbOn !== this.prevReverbOn || s.reverbSync !== this.prevReverbSync) this.refreshReverb(pi, s);
    for (let k = 0; k < 3; k++) {
      if (rebuild || changed(40 + k, 40 + k) || changed(43 + k, 43 + k) || changed(46 + k, 46 + k) || s.eqType[k] !== this.prevEq[k]) {
        if (s.eqType[k] !== this.eq[k].type) {
          this.eq[k].type = s.eqType[k];
          this.eq[k].bq.type = s.eqType[k] + 6;
        }
        this.refreshBand(k, pi);
      }
    }
    this.prev.set(pi);
    this.prevDelayOn = s.delayOn;
    this.prevDelaySync = s.delaySync;
    this.prevReverbOn = s.reverbOn;
    this.prevReverbSync = s.reverbSync;
    this.prevEq = s.eqType.slice(0, 3);
    this.ready = true;
  }

  /** FPE_Tempo (0x6b1d0): the delay is refreshed, the reverb when its predelay is tempo-based. */
  setTempo(s: OgunFxState): void {
    if (!this.ready || s.tempo === this.prevTempo) return;
    this.prevTempo = s.tempo;
    this.refreshDelay(s.pi, s);
    if (s.reverbSync) this.refreshReverb(s.pi, s);
  }

  // ---- refreshes

  /** 0x6d970. */
  private refreshChorus(pi: Int32Array, s: OgunFxState): void {
    let base = Math.trunc((100 * s.srp) / 44100);
    const order = pi[19];
    if (!(order > 0) || s.os <= 0) {
      this.chorus = null;
    } else {
      if (!this.chorus) this.chorus = new HarmorChorus(s.srp, 0, this.chunk);
      const m = f32(Math.abs(pi[25]) * 0.0078125);
      const dry = f32(1 - f32(f32(exp(m * LN5) - 1) * 0.25));
      const sgn = pi[25] === 0 ? 0 : pi[25] < 0 ? -1 : 1;
      const wet = f32(sgn * f32(1 - f32(f32(exp(f32(1 - m) * LN5) - 1) * 0.25)));
      this.chorus.setFields(
        order, f32(pi[20] * 0.0009765625), f32(pi[21] * 0.0009765625), f32(pi[22] * 0.0078125), f32(pi[23] * 0.0078125),
        f32(pi[24] * 0.0078125), dry, wet,
      );
      base += this.chorus.tailSamples;
    }
    this.tailBase = base;
  }

  /** 0x6d3f0. */
  private refreshDelay(pi: Int32Array, s: OgunFxState): void {
    if (!s.delayOn) {
      this.delay.free();
      return;
    }
    this.delay.refresh(s.delaySync, pi[27], pi[28], pi[29], pi[26], s.tempo, this.chunk);
  }

  /** 0x6d6d0. */
  private refreshReverb(pi: Int32Array, s: OgunFxState): void {
    if (!s.reverbOn) {
      this.reverb = null;
      return;
    }
    const sr = this.rate.sr;
    if (!this.reverb) this.reverb = new HarmorReverb(sr, this.chunk);
    let d = sr * pi[33];
    d = s.reverbSync ? (d * 0.3125) / f32(s.tempo) : d / 384;
    this.reverb.setFields({
      predelay: rint(d),
      decay: f32((pi[36] * sr) / 10),
      lowcut: pi[31] === 19 ? 0 : pi[31],
      highcut: pi[32] === 221 ? 0 : pi[32],
      damp: pi[37] === 221 ? 0 : pi[37],
      room: pi[34],
      diff: pi[35],
      color: pi[38],
    });
    this.revLevel = f32(f32(pi[39]) * 0.00390625);
  }

  /** 0x6dd60: EQ band k from the level, frequency and width parameters. */
  private refreshBand(k: number, pi: Int32Array): void {
    const b = this.eq[k];
    const fq = f32(pi[43 + k] * 1.52587890625e-05);
    b.freq = f32(10 + f32(exp(fq * LN101) - 1) * 159.9);
    b.width = f32(pi[46 + k] * 1.52587890625e-05);
    b.gain = f32(f32(pi[40 + k]) * F001);
    b.count = pi[40 + k] !== 0 ? -1 : this.eqHold;
    eqDesign(b, this.rate);
  }

  // ---- processing

  /**
   * One Gen_Render over `n` processing frames of the plugin's mix (interleaved, starting at float index `o`; cleared on
   * return). `active`: voices existed at the start of the block (the tail counter is reloaded); `mode`: the delay's
   * feedback mode (parameter 30). Returns the number of output frames, which are in `out()`.
   */
  process(mix: Float32Array, o: number, n: number, active: boolean, mode: number): number {
    if (!this.ready) {
      mix.fill(0, o, o + 2 * n);
      return 0;
    }
    const w = this.work;
    for (let j = 0; j < 2 * n; j++) w[j] = mix[o + j];
    mix.fill(0, o, o + 2 * n);
    if (active) this.tailCnt = this.tailBase;
    else if (this.tailCnt > 0) this.tailCnt -= n;
    const tailActive = this.tailCnt > 0;
    // EQ (0x705f0)
    for (let k = 0; k < 3; k++) {
      const b = this.eq[k];
      if (b.count === 0) continue;
      b.bq.process(w, n);
      if (b.count > 0) {
        b.count -= n;
        if (b.count <= 0) {
          b.count = 0;
          b.bq.clearState();
        }
      }
    }
    // chorus
    const ch = this.chorus;
    if (ch) ch.process(w, n, tailActive);
    // delay
    if (this.delay.exists) {
      const wet = this.wet;
      this.delay.process(w, wet, n, tailActive, mode);
      const lv = this.delay.level;
      if (lv === 1) for (let j = 0; j < 2 * n; j++) w[j] = w[j] + wet[j];
      else for (let j = 0; j < 2 * n; j++) w[j] = fma32(wet[j], lv, w[j]);
    }
    // reverb
    const rv = this.reverb;
    if (rv) {
      const mono = this.mono, rev = this.rev;
      for (let i = 0; i < n; i++) mono[i] = w[2 * i] + w[2 * i + 1];
      rv.runMono(mono, rev, n);
      const lv = this.revLevel;
      for (let j = 0; j < 2 * n; j++) w[j] = fma32(rev[j], lv, w[j]);
    }
    // downsampling
    return this.hb.stages > 0 ? this.hb.process(w, n) : n;
  }

  /** The block the last process() left (interleaved). */
  out(): Float32Array {
    return this.work;
  }

  /** FPD_Flush (ProcessEvent 0x66498..): the delay, reverb, chorus, halfband stages and EQ states are cleared. */
  reset(): void {
    if (!this.ready) return;
    this.delay.clear();
    this.reverb?.reset();
    this.chorus?.reset();
    this.hb.clear();
    for (const b of this.eq) {
      if (b.count > 0) b.count = 0;
      b.bq.clearState();
    }
    this.tailCnt = 0;
  }
}
