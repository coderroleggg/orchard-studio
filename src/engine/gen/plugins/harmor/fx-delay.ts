// Harmor's global DELAY (FX unit id 2), ported from FL Studio 2026's
// Harmor_x64.dylib (arm64 slice). Addresses are that binary's.
//
// State: the record D = plug+0x2978 (x[D] = TDelay_32FS object, D+0x8 / D+0x80 the
// low cut (type 4 high pass) and high cut (type 1 low pass) biquad records, D+0xf8
// feedback mode, D+0xfc / D+0x100 the L / R write offsets, D+0x104 the stereo
// offset in ms, D+0x108 the input gain ramp, D+0x131 damping).
//
// Deferred updater 0xe9c90 (run by 0xe8080 at the next render call after one of
// params 811..820 changed, or after a tempo change while the time is > 0):
//   creates / frees the TDelay_32FS (0x461ab0: ring of stereo float frames, read
//   and write pointers, feedback target +0x30 = 0.5, current +0x34 = 0); time
//   (>= 0: time * 0.3125 / tempo s, < 0: (2^(-time/96) - 1) / 15 s) and offsets
//   in samples; 0x4617f0 reallocates and clears the ring (and sets the current
//   feedback to the target) only when its total size changes; feedback target;
//   input gain = vol^3 with FL's pan law (0x460e20 / 0x19c0, pan negated in the
//   ping-pong modes); filters at 16.35 Hz * 2^(v/100), RBJ with alpha = sin w.
// Unit 0xeac50, in chunks of up to 384 frames: input = bus * gains (0x4604a0),
//   filtered (unless damping), added into the ring at write + offset (0x461f40 /
//   0x461ef0); the feedback kernels (0x462070 / 0x4621e0 / 0x462350 for modes 0 /
//   1 / 2) read the ring, clear the read frame, add read * feedback at the write
//   frame (feedback ramped per segment with FL's 0x1031e0, at most 0.001 * 44100 /
//   sr per sample), with damping the filters run in place on the ring segment
//   first; the output (mode 0 straight, 1 swapped, 2 swapped with cross feedback)
//   is added to bus 0. While the FX tail is inactive no input is written.

import { F001, FlBiquad, FlRamp, FlRate, LN2, NOTE0_HZ, SQRT2F, bitsOf, f32, rint } from './fx-util';
import { cos, exp, sin } from './fx-libm';

const MAXCHUNK = 384;

export class HarmorDelay {
  private readonly rate: FlRate;
  /** x[D] != null */
  private exists = false;
  /** D+0xf8 */
  private mode = 0;
  /** D+0xfc / D+0x100 (frames; FL keeps bytes) */
  private offL = 0;
  private offR = 0;
  /** D+0x104 stereo offset in ms (float32), set by ProcessParam 815 (0xd30c8). */
  private ofsMs = 0;
  /** D+0x108 */
  private readonly inRamp = new FlRamp();
  /** D+0x131 */
  private damp = false;
  private readonly flt = [new FlBiquad(), new FlBiquad()];
  // TDelay_32FS
  private ring = new Float32Array(0);
  /** ring size in frames (FL +0x28 = 8 * size bytes) */
  private size = 0;
  private rd = 0;
  private wr = 0;
  /** +0x30 target / +0x34 current feedback */
  private fbT = 0.5;
  private fbC = 0;
  private readonly s: Float32Array;

  constructor(rate: FlRate, maxBlock: number) {
    this.rate = rate;
    this.inRamp.k = rate.k15;
    this.s = new Float32Array(2 * Math.max(MAXCHUNK, 1));
    void maxBlock;
  }

  get active(): boolean {
    return this.exists;
  }

  /** ProcessParam 0xd30c8 for param 815 (stereo offset), before the flag is set. */
  setOffsetParam(v: number): void {
    const a = v < 0 ? -v : v;
    this.ofsMs = f32((exp(a * 0.015625 * LN2) - 1) * 1.9607843137254901);
  }

  /**
   * Updater 0xe9c90. raw: Harmor plug parameters (index = FL parameter index);
   * tempo: FL's plug+0xe44 (float32 BPM). Returns true when the unit list must be
   * rebuilt (object created or freed).
   */
  update(raw: ArrayLike<number>, tempo: number): boolean {
    const r = this.rate;
    let rebuild = false;
    if (raw[811] <= 0) {
      if (this.exists) rebuild = true;
      this.exists = false;
      this.ring = new Float32Array(0);
      this.size = 0;
      this.flt[0].type = 0;
      this.flt[1].type = 0;
      // FL: FreeAndNil + rebuild flag even if it was already nil
      return true;
    }
    if (!this.exists) {
      // TDelay_32FS.Create (0x461ab0)
      this.exists = true;
      this.size = 0;
      this.rd = 0;
      this.wr = 0;
      this.fbT = 0.5;
      this.fbC = 0;
      rebuild = true;
    }
    this.mode = raw[812] | 0;
    this.offL = rint(this.ofsMs * 0.001 * r.sr);
    this.offR = 0;
    const t = raw[814];
    let sec: number;
    if (t >= 0) sec = f32(t * 0.3125 / tempo);
    else sec = f32((exp(t * -0.010416666666666666 * LN2) - 1) * 0.066666666666666666);
    const delay = rint(f32(sec * f32(r.sr)));
    this.setSize(this.offL + MAXCHUNK, delay);
    if (raw[815] > 0) {
      const a = this.offL;
      this.offL = this.offR;
      this.offR = a;
    }
    this.fbT = f32(f32(raw[813]) * F001);
    const vol = f32(f32(raw[816]) * F001);
    let pan = f32(f32(raw[817]) * f32(0.0078125));
    if (this.mode > 0) pan = -pan;
    this.setInputGains(pan, f32(f32(vol * vol) * vol));
    this.damp = raw[820] > 0;
    const maxF = r.nyq;
    for (let i = 0; i < 2; i++) {
      const b = this.flt[i];
      const v = raw[818 + i];
      if (v === 1050 * i) {
        b.type = 0;
        continue;
      }
      if (b.type === 0) {
        b.type = i === 0 ? 4 : 1;
        b.resetState();
      }
      b.freq = f32(exp(f32(f32(v) * f32(0.01)) * LN2) * NOTE0_HZ);
      if (b.freq > maxF) b.freq = maxF;
      const x = b.freq * r.w;
      const s = sin(x), c = cos(x);
      b.design(0, s, s, c);
    }
    return rebuild;
  }

  /** 0x4617f0(obj, extra, delay): reallocate + clear only when the total size changes. */
  private setSize(extra: number, delay: number): void {
    const d = delay < 1 ? 1 : delay;
    const total = extra + d;
    if (total === this.size) return;
    // 0x461740: ReallocMem, virtual Clear (zero + current feedback := target), pointers
    if (this.ring.length < 2 * total) this.ring = new Float32Array(2 * total + 2 * 4096);
    else this.ring.fill(0, 0, 2 * total);
    this.size = total;
    this.fbC = this.fbT;
    this.rd = 0;
    this.wr = d;
  }

  /** 0x460e20(ramp, 0, pan, vol) with the pan law 0x19c0. */
  private setInputGains(pan: number, vol: number): void {
    if (bitsOf(pan) === 0) {
      this.inRamp.set(vol, vol);
      return;
    }
    if (vol === 0) {
      this.inRamp.set(0, 0);
      return;
    }
    const g = f32(vol * SQRT2F);
    const a = f32(f32(pan + 1) * 0.7853981633974483);
    // ___sincosf_stret (float32 libm); see fx.ts notes on libm
    const sn = f32(Math.sin(a)), cs = f32(Math.cos(a));
    this.inRamp.set(f32(cs * g), f32(sn * g));
  }

  /** 0x1031e0: feedback start / step for a segment of n frames. */
  private fbRamp(n: number): number {
    const start = this.fbC;
    let step = f32(this.fbT - start);
    this.fbStart = start;
    if (bitsOf(step) === 0) {
      this.fbStep = step;
      return start;
    }
    this.fbC = this.fbT;
    step = f32(step / n);
    const maxStep = this.rate.step;
    if (Math.abs(step) > maxStep) {
      step = step < 0 || (step === 0 && 1 / step < 0) ? -maxStep : maxStep;
      this.fbC = f32(start + f32(step * n));
      if ((bitsOf(this.fbC) & 0x7fffffff) < 0x33800000) {
        this.fbC = 0;
        step = f32(-start / n);
      }
    }
    this.fbStep = step;
    return start;
  }
  private fbStart = 0;
  private fbStep = 0;

  /** Unit 0xeac50 on interleaved bus 0 (in place). */
  process(bus: Float32Array, n: number, tailActive: boolean): void {
    if (!this.exists) return;
    const s = this.s;
    let off = 0;
    let rem = n;
    while (rem > 0) {
      const m = rem > MAXCHUNK ? MAXCHUNK : rem;
      const bo = 2 * off;
      if (tailActive) {
        this.inRamp.gain(bus, bo, s, 0, m);
        if (!this.damp) {
          if (this.flt[0].type !== 0) this.flt[0].process(s, 0, m);
          if (this.flt[1].type !== 0) this.flt[1].process(s, 0, m);
        }
        this.ringAdd(s, 0, m, this.wr + this.offL, 0);
        this.ringAdd(s, 1, m, this.wr + this.offR, 1);
      } else {
        this.inRamp.cur[0] = this.inRamp.tgt[0];
        this.inRamp.cur[1] = this.inRamp.tgt[1];
      }
      let left = m;
      let oo = 0;
      do {
        let cnt = this.wr - this.rd;
        if (cnt <= 0) cnt = this.size - this.rd;
        if (cnt > left) cnt = left;
        if (this.damp) {
          if (this.flt[0].type !== 0) this.flt[0].process(this.ring, 2 * this.rd, cnt);
          if (this.flt[1].type !== 0) this.flt[1].process(this.ring, 2 * this.rd, cnt);
        }
        this.feedback(s, oo, cnt);
        left -= cnt;
        oo += cnt;
      } while (left > 0);
      for (let i = 0; i < 2 * m; i++) bus[bo + i] = bus[bo + i] + s[i];
      rem -= m;
      off += m;
    }
  }

  /** 0x461f40 + 0x461ef0: ring[pos.., ch] += src[.., ch] (one channel, n frames, with wrap). */
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
    first = n;
    for (let i = 0; i < first; i++) {
      const j = 2 * (pos + i) + rch;
      ring[j] = ring[j] + src[si];
      si += 2;
    }
  }

  /** The mode's feedback kernel over cnt frames (output into out[2oo..]). */
  private feedback(out: Float32Array, oo: number, cnt: number): void {
    this.fbRamp(cnt);
    let fb = this.fbStart;
    const step = this.fbStep;
    const ring = this.ring, size = this.size;
    let r = this.rd, w = this.wr;
    const mode = this.mode;
    for (let i = 0; i < cnt; i++) {
      const rl = ring[2 * r], rr = ring[2 * r + 1];
      const o = 2 * (oo + i);
      let fl: number, fr: number;
      if (mode === 0) {
        out[o] = rl; out[o + 1] = rr;
        fl = rl; fr = rr;
      } else if (mode === 1) {
        out[o] = rr; out[o + 1] = rl;
        fl = rl; fr = rr;
      } else {
        out[o] = rr; out[o + 1] = rl;
        fl = rr; fr = rl;
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

  reset(): void {
    if (this.size > 0) this.ring.fill(0, 0, 2 * this.size);
    this.fbC = this.fbT;
    for (const b of this.flt) b.resetState();
    this.inRamp.snap();
  }
}
