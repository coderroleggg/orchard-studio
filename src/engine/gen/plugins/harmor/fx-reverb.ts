// Harmor's global reverb (FX page "Reverb", FX unit 3): an exact port of FL Studio
// 2026's code. Two binaries are involved (arm64 slices; addresses are theirs):
//
// Harmor_x64.dylib (FPC):
//   0xea080  deferred updater (FL runs it at the start of the next render call after
//            any of parameters 794..803 changed, flag plug+0x2ae0; ProcessEvent
//            0xd0eb0 also sets the flag on FPE_Tempo when revPredelay (797) > 0):
//            update() below
//   0xeaf70  the unit: mono = L + R of bus 0 (NEON kernel 0x3ca8 -> REND+0x20), the
//            reverb (0x468130 -> REND+0x28), wet add 0x460370 with the ramp at
//            plug+0x2ab8 into bus 0, then plug+0x295c = 0x7fffffff (fx.ts does that).
//            It does not test the tail flag: process() below
//   TFruityReverb (VMT 0x843400, parent TBaseReverb 0x843230, instance 0xa0 bytes):
//            constructor 0x467e90 / 0x465320, init 0x466e50 (VMT+0xc8: line lengths,
//            taps, one memory block), 0x4670e0 (VMT+0xd0: line pointers), flush
//            0x465510, update 0x4673d0 (coefficients, run by 0x468130 while the
//            dirty byte obj+0x20 is set), FPC Math.Power 0x465160, Math.Tan 0x1677f0
//            (= sin / cos), MulDiv 0x2986d0 (int64 mul + truncating div)
//   0xc6490  plugin reset (dispatcher / state load): flush + wet ramp cur := tgt
// libreverb_x64.dylib (FL/Shared, C++, clang -O, loaded by TBaseReverb 0x465030 via
//   CreateReverbInstance; the engine object's ReverbData at +0x10 is filled by Harmor):
//   BaseReverb::Process_Fruity_32FM_32FS 0x2b44 (vtable+0x10): the DSP, engine() below.
//
// Algorithm (a Dattorro / Griesinger figure-eight plate). Line lengths at 20 kHz,
// scaled by MulDiv(len, sr * (room + 15) / 115, 20000): input allpasses 142, 107,
// 379, 277; tank half A: allpass 672, delay 4453, allpass 1800, delay 3720; half B:
// 908, 4217, 2656, 3163; then a predelay line max(predelay samples, 1).
//   x  = in + 1e-30f
//   lp = one-pole lowpass (highcut), u = lowcut on ? fma((lp - ap1(lp)) * 0.5 + 1e-30)
//        : lp  (ap1 = first-order allpass, coefficient (tan - 1) / (tan + 1))
//   u -> 4 Schroeder allpasses (y = d - c u, store u + c y; all four use the
//        diffusion-1 gain) -> predelay line -> pd
//   half A: fb = g * lineB2.out; v = fb + pd + k (fb + ap(fb)) (low shelf "color"),
//        one-pole lowpass (high damping), allpass (dd1), delay, * g, allpass (dd2),
//        delay A2 (written, then read at its next write position: length - 1);
//        half B the same from g * lineA2.out, ending in line B2 (read before write).
//   out L / R: 7 taps each from the tank lines (at their next write positions) with
//        gains gw = g + (1 - g) w: L = t0 + g.6 t4 - (g.25 t1 + g.7 t2 + g.2 t3) + t5
//        + g.5 t6, R = r0 + g.25 r1 + r5 + g.5 r6 - (g.7 r2 + g.2 r3 + g.6 r4).
//   g = (0.001^(sum of the 4 tank delays / decay samples))^(1/4); the shelf gain
//   compares g with the same for decay * color factor (0.2, 0.6, 1, 1.5, 3).
//
// Parameter laws (updater 0xea080, raw FL values): decay = 0.1 * 2^(p800/100) s;
// lowcut = 16.3516 * 2^(p795/100) Hz (p795 <= 0: off); highcut and high damping the
// same law (p796 / p801 >= 1050: off); predelay p797 >= 0: p797/192 beat at the host
// tempo, < 0: (2^(-p797/64) - 1) / 63 s, in samples rounded half to even (a change
// re-initialises the reverb: lines and states cleared); room p798 scales the lines
// by (room + 15) / 115 (a change clears the 12 lines); diffusion p799: allpass gains
// for an RT60 of p799 % of 0.07 / 0.11 / 0.35 / 0.51 s; color p802 0..4; wet
// 0.5 * (p803 / 1000)^3 (signed); p794 <= 0 frees the reverb (a fresh one next time).
// All in float32 with libreverb's fused multiply-adds (fma() below: a correctly
// rounded float32 fmadd emulated in double), the coefficients in FL's float32 /
// double mix with FL's macOS libm exp / log / sin / cos (./fx-libm). Line positions
// run downwards and wrap after each access, as in FL.
//
// Verified bit-exact (local harness in .flref/harmor/fxw/reverb, not committed): the
// engine against FL's own libreverb called natively (random input, 22.05..96 kHz);
// the whole unit against the FL test host (ReverbData after every render call and
// every engine output sample, 4 sample rates, all ten parameters at their extremes,
// positive / negative predelay, automation of room, predelay, on / off, wet, decay,
// color, diffusion, cut and damping, render calls of 1..512 frames) and end to end
// (FL's FX-off render through process() = FL's reverb-on render); the mono kernel
// and the wet add against FL's code called natively; the coefficient laws on the
// full room x decay x color grid (with diffusion, cuts and damping swept) at 22.05,
// 44.1, 48 and 96 kHz against FL's laws evaluated with macOS libm.
//
// Deviations (none reachable with FL's parameter ranges and tempos 10..522 BPM):
// - memory is preallocated for a predelay up to 12 s (384 ticks at 10 BPM); longer
//   predelays (tempo < 10 BPM) are clamped to that;
// - room size is clamped to 1..100 (FL's range; beyond 100 FL's lines overrun their
//   block, below -14 its taps read before it);
// - FL's audio thread runs with FPCR.FZ off (FLEngine only sets the rounding mode
//   and the exception masks), like JS: denormals are kept in both (with the host's
//   --ftz the results differ only in denormal states of extreme settings).

import { cos, exp, log, sin } from './fx-libm';
import { F001, F01, FlRamp, LN2, NOTE0_HZ, f32, rint } from './fx-util';

/** FL a9e358: ln(0.001) (double), the -60 dB decay reference. */
const LN0001 = -6.907755278982137;
/** libreverb's denormal guard 1e-30f, added to every input sample and after the lowcut. */
const DC = f32(1e-30);
const F02 = f32(0.2);
const F06 = f32(0.6);
const F07 = f32(0.7);
/** Line lengths at 20 kHz (0x904950). */
const TBL = [142, 107, 379, 277, 672, 4453, 1800, 3720, 908, 4217, 2656, 3163];
/** Output taps at 20 kHz, left (0x904980) and right (0x90499c). */
const TAPL = [266, 2974, 1913, 2496, 1690, 187, 1566];
const TAPR = [353, 3627, 1728, 3173, 1811, 335, 621];
/** Decay factor of the low shelf for color 0..4 (0x5c0888..0x5c0894, else 1). */
const COLOR = [F02, F06, 1, 1.5, 3];

/**
 * float32 fused multiply-add c + a * b with one rounding (ARM fmadd; fmsub = fma(-a, b, c))
 * for float32 operands: a * b is exact in double; s = a * b + c is the correctly rounded
 * double of the exact sum, so rounding s to float32 is right unless s lies exactly halfway
 * between two floats; then the exact error of s (TwoSum) decides the direction.
 */
function fma(a: number, b: number, c: number): number {
  const p = a * b;
  const s = p + c;
  const r = f32(s);
  if (r === s || r - r !== 0) return r; // exact, infinite or NaN
  const m = 2 * s - r; // the other neighbour when s is a midpoint
  if (f32(m) !== m) return r;
  const t = s - p;
  const e = p - (s - t) + (c - t);
  if (e > 0) return r > m ? r : m;
  if (e < 0) return r < m ? r : m;
  return r;
}

/** FL's MulDiv (0x7da4: int64 product, truncating division); exact in double for these sizes. */
function muldiv(a: number, b: number, c: number): number {
  return Math.trunc((a * b) / c) | 0;
}

/** FPC Math.Tan (0x1677f0): sincos, then sin / cos. */
function tanFpc(x: number): number {
  return sin(x) / cos(x);
}

/** FPC Math.Power(b, 0.25) (0x465160): 0 for b = 0, else exp(0.25 ln b). */
function pow025(b: number): number {
  return b === 0 ? 0 : exp(0.25 * log(b));
}

/** fcvtzs x, d (saturating int64) then the low 32 bits, of an integral double. */
function lo32(x: number): number {
  if (x !== x) return 0;
  if (x >= 9223372036854775807) return -1;
  if (x <= -9223372036854775808) return 0;
  return x | 0;
}

/** One-pole lowpass coefficient of the highcut / high damping (0x4673d0). */
function onePole(s15: number, half: number, isr: number): number {
  if (s15 === 0) return 1;
  if (!(s15 < half)) s15 = half;
  const c = cos(f32(200 * s15) * Math.PI * isr);
  const s12 = f32(2 - c);
  return f32(1 - f32(s12 - f32(Math.sqrt(f32(f32(s12 * s12) - 1)))));
}

export class HarmorReverb {
  private readonly sr: number;
  private readonly maxBlock: number;
  /** FL's single GetMem block (obj+0x18): the 12 lines, then the predelay line. */
  private readonly mem: Float32Array;
  /** Predelay line capacity (samples). */
  private readonly pdCap: number;
  /** REND+0x20 (mono input) and REND+0x28 (engine output, interleaved). */
  private readonly mono: Float32Array;
  private readonly wet: Float32Array;
  /** plug+0x2ab8: wet gain (survives the reverb object, as in FL). */
  private readonly ramp = new FlRamp();
  /** plug+0x2ab0 != nil. */
  private on = false;
  /** obj+0x20: run the update (0x4673d0) before the next block. */
  private dirty = false;

  // TFruityReverb record (obj+0x38..0x54)
  private lowcut = 0; // +0x38 Hz (float32)
  private highcut = 0; // +0x3c Hz / 100 (float32), 0 = off
  private predelay = 0; // +0x40 samples
  private room = 0; // +0x44
  private diff = 0; // +0x48
  private decay = 0; // +0x4c samples (float32)
  private damp = 0; // +0x50 Hz / 100 (float32), 0 = off
  private color = 0; // +0x54

  // libreverb ReverbData (engine+0x10; RD offsets)
  private zLp = 0; // +0x0 highcut lowpass state
  private zApY = 0; // +0x4 lowcut allpass output state
  private zApX = 0; // +0x8 lowcut allpass input state
  private cLc = 0; // +0xc lowcut allpass coefficient (0 = off)
  private g = 0; // +0x10 tank gain
  private dd1 = 0; // +0x14 tank allpass 1 gain
  private dd2 = 0; // +0x18 tank allpass 2 gain
  private id1 = 0; // +0x1c input allpass gain (all four)
  private id2 = 0; // +0x20 (computed, unused by the Fruity algorithm)
  private cHc = 0; // +0x24 highcut coefficient
  private cDamp = 0; // +0x28 high damping coefficient
  private zDampA = 0; // +0x2c
  private zDampB = 0; // +0x30
  private shA = 0; // +0x34 shelf allpass coefficient
  private shK = 0; // +0x38 shelf gain
  private shXA = 0; // +0x3c
  private shYA = 0; // +0x40
  private shXB = 0; // +0x44
  private shYB = 0; // +0x48
  private total = 0; // +0x4c
  private readonly ptr = new Int32Array(13); // +0x50 (offsets into mem)
  private readonly pos = new Int32Array(13); // +0xc0
  private readonly len = new Int32Array(13); // +0xf8
  private readonly tap = new Int32Array(14); // +0x130
  private lastRoom = 0; // +0x1e8

  constructor(sampleRate: number, maxBlock: number) {
    this.sr = sampleRate | 0;
    this.maxBlock = Math.max(1, maxBlock | 0);
    let lines = 0;
    for (let i = 0; i < 12; i++) lines += muldiv(TBL[i], this.sr, 20000);
    this.pdCap = Math.max(1, Math.ceil(12 * this.sr) + 1);
    this.mem = new Float32Array(lines + this.pdCap);
    this.mono = new Float32Array(this.maxBlock);
    this.wet = new Float32Array(2 * this.maxBlock);
  }

  /** The reverb object exists (FL puts the unit in the chain). */
  get active(): boolean {
    return this.on;
  }

  /** FL's deferred updater 0xea080: raw = the 825 plug parameters, tempo in BPM (FL's float32 plug+0xe44). */
  update(raw: Int32Array, tempo: number): void {
    if (raw[794] <= 0) {
      this.on = false; // FreeAndNil: the next enable starts from a fresh object
      return;
    }
    if (!this.on) this.create();
    const sr = this.sr;
    const pd = raw[797];
    let d8: number;
    if (pd >= 0) d8 = (pd * 0.3125) / f32(tempo); // 1/192 beat
    else d8 = (exp(pd * -0.015625 * LN2) - 1) * 0.015873015873015872; // (2^(-pd/64) - 1) / 63 s
    const smp = lo32(rint(d8 * sr));
    if (smp !== this.predelay) {
      this.predelay = smp;
      this.init(); // reallocates: all lines and filter states cleared
    }
    this.dirty = true;
    this.decay = f32(exp(f32(raw[800] * F01) * LN2) * 0.1 * sr);
    this.lowcut = raw[795] > 0 ? f32(exp(f32(raw[795] * F01) * LN2) * NOTE0_HZ) : 0;
    this.highcut = raw[796] < 1050 ? f32(exp(f32(raw[796] * F01) * LN2) * NOTE0_HZ * F01) : 0;
    this.damp = raw[801] < 1050 ? f32(exp(f32(raw[801] * F01) * LN2) * NOTE0_HZ * F01) : 0;
    const room = raw[798];
    this.room = room < 1 ? 1 : room > 100 ? 100 : room;
    this.diff = raw[799];
    this.color = raw[802];
    const w = f32(raw[803] * F001);
    const gain = f32(w * w * w * 0.5);
    this.ramp.set(gain, gain);
  }

  /**
   * Direct entry for plugins that run the same TFruityReverb with their own parameter laws (Ogun_x64's refresh 0x6d6d0):
   * predelay in samples (a change re-initialises the lines), decay in samples (float32), low cut in Hz (0 = off), high cut
   * and high damping in Hz / 100 (0 = off), room size 1..100, diffusion, colour 0..4.
   */
  setFields(f: { predelay: number; decay: number; lowcut: number; highcut: number; damp: number; room: number; diff: number; color: number }): void {
    if (!this.on) this.create();
    const smp = Math.max(0, f.predelay | 0);
    if (smp !== this.predelay) {
      this.predelay = smp;
      this.init(); // reallocates: all lines and filter states cleared
    }
    this.dirty = true;
    this.decay = f32(f.decay);
    this.lowcut = f32(f.lowcut);
    this.highcut = f32(f.highcut);
    this.damp = f32(f.damp);
    this.room = f.room < 1 ? 1 : f.room > 100 ? 100 : f.room | 0;
    this.diff = f.diff | 0;
    this.color = f.color | 0;
  }

  /** The libreverb call of a plugin that does its own mono sum and wet add (Ogun's 0x26adb0): coefficients when dirty, then the engine. */
  runMono(mono: Float32Array, wet: Float32Array, n: number): void {
    if (!this.on || n <= 0) return;
    if (this.dirty) this.coefs();
    this.engine(mono, wet, n);
  }

  /** FL's unit 0xeaf70 on interleaved bus 0 (n frames, in place). */
  process(bus: Float32Array, n: number): void {
    if (!this.on) return;
    let off = 0;
    do {
      const m = Math.min(n - off, this.maxBlock);
      const mono = this.mono;
      for (let i = 0; i < m; i++) mono[i] = bus[2 * (off + i)] + bus[2 * (off + i) + 1];
      if (this.dirty) this.coefs();
      this.engine(mono, this.wet, m);
      this.ramp.addGain(this.wet, 0, bus, 2 * off, m);
      off += m;
    } while (off < n);
  }

  /** FL's plugin reset 0xc6490 (reverb part): lines and filter states cleared, wet ramp snapped. */
  reset(): void {
    if (this.on) this.flush();
    this.ramp.snap();
  }

  // ------------------------------------------------------------ TFruityReverb

  /** TFruityReverb.Create (0x467e90 / 0x465320) with a fresh engine (ReverbData zeroed). */
  private create(): void {
    this.on = true;
    this.lowcut = 75;
    this.highcut = 40;
    this.predelay = 0;
    this.room = 50;
    this.diff = 100;
    this.decay = 15;
    this.damp = 40;
    this.color = 2;
    this.cLc = this.g = this.dd1 = this.dd2 = this.id1 = this.id2 = 0;
    this.cHc = this.cDamp = this.shA = this.shK = 0;
    this.lastRoom = 0;
    // FL initialises at 44.1 kHz, then again at the host rate: same final state
    this.init();
    this.dirty = true;
  }

  /** 0x466e50 + 0x4670e0: line lengths at the sample rate, one block, taps, flush. */
  private init(): void {
    const sr = this.sr;
    let total = 0;
    for (let i = 0; i < 12; i++) {
      this.pos[i] = 0;
      this.len[i] = muldiv(TBL[i], sr, 20000);
      total += this.len[i];
    }
    this.pos[12] = 0;
    let pl = this.predelay > 1 ? this.predelay : 1;
    if (pl > this.pdCap) pl = this.pdCap; // deviation: tempo < 10 BPM
    this.len[12] = pl;
    total += pl;
    this.total = total;
    let o = 0;
    for (let i = 0; i < 12; i++) {
      this.ptr[i] = o;
      o += this.len[i];
    }
    this.ptr[12] = o;
    for (let i = 0; i < 7; i++) {
      this.tap[i] = muldiv(TAPL[i], sr, 20000);
      this.tap[7 + i] = muldiv(TAPR[i], sr, 20000);
    }
    this.flush();
  }

  /** 0x465510: zero the block and the filter states (positions kept). */
  private flush(): void {
    this.mem.fill(0, 0, this.total);
    this.zLp = this.zApY = this.zApX = 0;
    this.shXA = this.shYA = this.shXB = this.shYB = 0;
    this.zDampA = this.zDampB = 0;
  }

  /** 0x4673d0: coefficients, room-scaled lengths and taps. */
  private coefs(): void {
    const sr = this.sr;
    const half = f32(f32(sr) * 0.5);
    const isr = f32(1 / sr);
    // lowcut: first-order allpass (the highpass is (x - ap(x)) / 2)
    let s15 = this.lowcut;
    if (s15 === 0) this.cLc = 0;
    else {
      if (!(s15 < half)) s15 = half;
      const t = f32(tanFpc(Math.PI * s15 * isr));
      this.cLc = f32(f32(t - 1) / f32(t + 1));
    }
    this.cHc = onePole(this.highcut, half, isr);
    // room size
    const rsr = muldiv(sr, this.room + 15, 0x73);
    const L = this.len;
    for (let i = 0; i < 12; i++) {
      let l = muldiv(TBL[i], rsr, 20000);
      if (l < 1) l = 1;
      L[i] = l;
      this.pos[i] = this.pos[i] % l;
    }
    for (let i = 0; i < 7; i++) {
      this.tap[i] = muldiv(TAPL[i], rsr, 20000);
      this.tap[7 + i] = muldiv(TAPR[i], rsr, 20000);
    }
    if (this.room !== this.lastRoom) {
      this.lastRoom = this.room;
      for (let i = 0; i < 12; i++) this.mem.fill(0, this.ptr[i], this.ptr[i] + L[i]);
    }
    // diffusion: allpass gains from the mean line time and an RT60 of diff% * k seconds
    const s11 = f32(this.diff * 0.01);
    const h = f32(0.5 * isr);
    const s1 = f32(f32(L[0] + L[1]) * h);
    const s10 = f32(f32(L[2] + L[3]) * h);
    const s8 = f32(f32(L[4] + L[8]) * h);
    const s9 = f32(f32(L[6] + L[10]) * h);
    if (s11 === 0) {
      this.id1 = this.id2 = this.dd1 = this.dd2 = 0;
    } else {
      this.id1 = f32(exp((LN0001 * s1) / (s11 * 0.07)));
      this.id2 = f32(exp((LN0001 * s10) / (s11 * 0.11)));
      this.dd1 = f32(exp((LN0001 * s8) / (s11 * 0.35)));
      this.dd2 = f32(exp((LN0001 * s9) / (s11 * 0.51)));
    }
    // decay: tank gain for -60 dB after `decay` samples
    const sum = f32(L[5] + L[7] + L[9] + L[11]);
    const dec = this.decay;
    this.g = f32(pow025(exp((LN0001 * sum) / dec)));
    this.cDamp = onePole(this.damp, half, isr);
    // color: low shelf (allpass based) towards the gain for decay * factor
    const col = this.color;
    const k = col >= 0 && col <= 4 ? COLOR[col] : 1;
    const t = f32(pow025(exp((LN0001 * sum) / f32(dec * k))));
    let r = f32(t / this.g);
    this.shK = f32(f32(r - 1) * 0.5);
    if (r > 1) r = 1;
    const t5 = f32(tanFpc(Math.PI * 500 * isr));
    this.shA = f32(f32(t5 - r) / f32(t5 + r));
    this.dirty = false;
  }

  // ------------------------------------------------------------ libreverb

  /** BaseReverb::Process_Fruity_32FM_32FS (libreverb 0x2b44): mono in, interleaved stereo out. */
  private engine(inp: Float32Array, out: Float32Array, n: number): void {
    if (n <= 0) return;
    const mem = this.mem;
    const P = this.ptr, L = this.len, T = this.tap, pos = this.pos;
    const g = this.g;
    const s6 = f32(1 - g);
    const gA = fma(s6, F06, g);
    const gB = fma(s6, 0.25, g);
    const gC = fma(s6, F07, g);
    const gD = fma(s6, 0.5, g);
    const gE = fma(s6, F02, g);
    const cHc = this.cHc, cLc = this.cLc, lcOn = cLc !== 0;
    const id = this.id1, dd1 = this.dd1, dd2 = this.dd2;
    const shA = this.shA, shK = this.shK, cD = this.cDamp;
    let zLp = this.zLp, zApY = this.zApY, zApX = this.zApX;
    let shXA = this.shXA, shYA = this.shYA, shXB = this.shXB, shYB = this.shYB;
    let zDA = this.zDampA, zDB = this.zDampB;
    const P0 = P[0], P1 = P[1], P2 = P[2], P3 = P[3], P4 = P[4], P5 = P[5], P6 = P[6];
    const P7 = P[7], P8 = P[8], P9 = P[9], P10 = P[10], P11 = P[11], P12 = P[12];
    const L0 = L[0], L1 = L[1], L2 = L[2], L3 = L[3], L4 = L[4], L5 = L[5], L6 = L[6];
    const L7 = L[7], L8 = L[8], L9 = L[9], L10 = L[10], L11 = L[11], L12 = L[12];
    const T0 = T[0], T1 = T[1], T2 = T[2], T3 = T[3], T4 = T[4], T5 = T[5], T6 = T[6];
    const T7 = T[7], T8 = T[8], T9 = T[9], T10 = T[10], T11 = T[11], T12 = T[12], T13 = T[13];
    let p0 = pos[0], p1 = pos[1], p2 = pos[2], p3 = pos[3], p4 = pos[4], p5 = pos[5], p6 = pos[6];
    let p7 = pos[7], p8 = pos[8], p9 = pos[9], p10 = pos[10], p11 = pos[11], p12 = pos[12];
    for (let i = 0; i < n; i++) {
      // input filters
      const x = f32(inp[i] + DC);
      const lp = fma(f32(x - zLp), cHc, zLp);
      const ap = fma(f32(lp - zApY), cLc, zApX);
      zLp = lp;
      zApY = ap;
      zApX = lp;
      let u = lcOn ? fma(f32(lp - ap), 0.5, DC) : lp;
      // input diffusers
      let j = P0 + p0;
      let y = fma(-id, u, mem[j]);
      mem[j] = fma(y, id, u);
      if (p0 <= 0) p0 = L0;
      u = y;
      j = P1 + p1;
      y = fma(-id, u, mem[j]);
      mem[j] = fma(y, id, u);
      if (p1 <= 0) p1 = L1;
      u = y;
      j = P2 + p2;
      y = fma(-id, u, mem[j]);
      mem[j] = fma(y, id, u);
      if (p2 <= 0) p2 = L2;
      u = y;
      j = P3 + p3;
      y = fma(-id, u, mem[j]);
      mem[j] = fma(y, id, u);
      if (p3 <= 0) p3 = L3;
      u = y;
      // predelay
      j = P12 + p12;
      const pd = mem[j];
      mem[j] = u;
      if (p12 <= 0) p12 = L12;
      // tank half A (fed by line B2)
      let fb = f32(g * mem[P11 + p11]);
      let a = fma(f32(fb - shYA), shA, shXA);
      shXA = fb;
      shYA = a;
      let v = fma(shK, f32(a + fb), f32(fb + pd));
      v = fma(f32(v - zDA), cD, zDA);
      zDA = v;
      j = P4 + p4;
      y = fma(-dd1, v, mem[j]);
      mem[j] = fma(y, dd1, v);
      if (p4 <= 0) p4 = L4;
      j = P5 + p5;
      const d5 = mem[j];
      mem[j] = y;
      if (p5 <= 0) p5 = L5;
      v = f32(g * d5);
      j = P6 + p6;
      y = fma(-dd2, v, mem[j]);
      mem[j] = fma(y, dd2, v);
      if (p6 <= 0) p6 = L6;
      mem[P7 + p7] = y;
      if (p7 <= 0) p7 = L7;
      p7--;
      // tank half B (fed by line A2, read at the next write position)
      fb = f32(g * mem[P7 + p7]);
      a = fma(f32(fb - shYB), shA, shXB);
      shXB = fb;
      shYB = a;
      v = fma(shK, f32(a + fb), f32(fb + pd));
      v = fma(f32(v - zDB), cD, zDB);
      zDB = v;
      j = P8 + p8;
      y = fma(-dd1, v, mem[j]);
      mem[j] = fma(y, dd1, v);
      if (p8 <= 0) p8 = L8;
      j = P9 + p9;
      const d9 = mem[j];
      mem[j] = y;
      if (p9 <= 0) p9 = L9;
      v = f32(g * d9);
      j = P10 + p10;
      y = fma(-dd2, v, mem[j]);
      mem[j] = fma(y, dd2, v);
      if (p10 <= 0) p10 = L10;
      p5--;
      p6--;
      p9--;
      p10--;
      mem[P11 + p11] = y;
      if (p11 <= 0) p11 = L11;
      p11--;
      // output taps (at the next write positions)
      let q = T0 + p9;
      if (q >= L9) q -= L9;
      const l0 = mem[P9 + q];
      q = T1 + p9;
      if (q >= L9) q -= L9;
      const l1 = mem[P9 + q];
      q = T2 + p10;
      if (q >= L10) q -= L10;
      const l2 = mem[P10 + q];
      q = T3 + p11;
      if (q >= L11) q -= L11;
      const l3 = mem[P11 + q];
      q = T4 + p5;
      if (q >= L5) q -= L5;
      const l4 = mem[P5 + q];
      q = T5 + p6;
      if (q >= L6) q -= L6;
      const l5 = mem[P6 + q];
      q = T6 + p7;
      if (q >= L7) q -= L7;
      const l6 = mem[P7 + q];
      q = T7 + p5;
      if (q >= L5) q -= L5;
      const r0 = mem[P5 + q];
      q = T8 + p5;
      if (q >= L5) q -= L5;
      const r1 = mem[P5 + q];
      q = T9 + p6;
      if (q >= L6) q -= L6;
      const r2 = mem[P6 + q];
      q = T10 + p7;
      if (q >= L7) q -= L7;
      const r3 = mem[P7 + q];
      q = T11 + p9;
      if (q >= L9) q -= L9;
      const r4 = mem[P9 + q];
      q = T12 + p10;
      if (q >= L10) q -= L10;
      const r5 = mem[P10 + q];
      q = T13 + p11;
      if (q >= L11) q -= L11;
      const r6 = mem[P11 + q];
      let s = fma(l3, gE, fma(l2, gC, f32(l1 * gB)));
      let o = fma(l6, gD, f32(f32(fma(l4, gA, l0) - s) + l5));
      out[2 * i] = o;
      s = fma(r4, gA, fma(r3, gE, f32(r2 * gC)));
      o = fma(r6, gD, f32(fma(r1, gB, r0) + r5));
      out[2 * i + 1] = o - s;
      p0--;
      p1--;
      p2--;
      p3--;
      p12--;
      p4--;
      p8--;
    }
    pos[0] = p0;
    pos[1] = p1;
    pos[2] = p2;
    pos[3] = p3;
    pos[4] = p4;
    pos[5] = p5;
    pos[6] = p6;
    pos[7] = p7;
    pos[8] = p8;
    pos[9] = p9;
    pos[10] = p10;
    pos[11] = p11;
    pos[12] = p12;
    this.zLp = zLp;
    this.zApY = zApY;
    this.zApX = zApX;
    this.shXA = shXA;
    this.shYA = shYA;
    this.shXB = shXB;
    this.shYB = shYB;
    this.zDampA = zDA;
    this.zDampB = zDB;
  }
}
