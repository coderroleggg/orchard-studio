// Harmless's global effects: chorus, delay, reverb and compression, ported from
// FL Studio 2026's Harmless_x64.dylib (arm64 slice; every address below is a
// file offset in that slice) to reproduce FL's output sample for sample.
//
// Gen_Render (0x72f90), after the voices are mixed into the render context's
// stereo buffer (interleaved, REND+0x38):
//   tail   0x72fdc  voices in the list (checked before they render): PL+0x7c8 :=
//                   PL+0x7cc; else while PL+0x7c8 > 0: PL+0x7c8 -= n
//   chorus 0x733fc  (object PL+0x7d0) PL+0x7c8 > 0: ring write 0x205420, render
//                   obj+0x60 (= 0x205790) into REND+0x20, mix *= PL+0x7d8 (skipped
//                   when exactly 1.0f), mix += REND+0x20; else phase advance 0x2053c0
//   delay  0x7349c  (record PL+0x7e0) PL+0x7c8 > 0: REND+0x20 = mix * PL+0x7f4,
//                   added into the ring at write + PL+0x7ec (L) / + PL+0x7f0 (R)
//                   (0x201e50); then always the feedback kernel (PL+0x7e8 == 0:
//                   obj+0x40 = 0x202020, else obj+0x60 = 0x202300) into REND+0x20,
//                   mix += REND+0x20
//   reverb 0x73578  (object PL+0x800) always: mono = L + R (G[2fba50] = 0x450c),
//                   TFruityReverb 0x204990 into REND+0x28, mix += REND+0x28 * PL+0x808
//                   (ippsAddProductC_32f = vDSP_vsma: fused multiply-add)
//   comp   0x735d8  (PL+0x810 plugin list) always: the hosted SGv2's Eff_Render in place
// The units have no dry/wet ramps: every gain is applied as set.
//
// Updaters (run at once, under the plugin lock):
//   ProcessParam 0x6a070 (jump table 0x6b6b0): 90 / 91 -> chorus 0x73df0; 92..95 ->
//   delay 0x73870; 96 / 97 -> reverb 0x73ab0; 98 -> SGv2 param 5 (when loaded).
//   FPE_Tempo (0x69ff0) -> delay; FPD_SetBlockSize (0x63e34: PL+0x2e4) -> delay +
//   chorus; FPD_SetSampleRate -> chorus, delay, reverb. The compression combo
//   (extras[3], editor 0x62cf0) -> 0x740d0. SaveRestoreState (0x652..) reads the
//   100 parameters raw, sets the combos (compression updater), then sends every
//   parameter through ProcessParam in index order.
//   FPD_Flush (0x63da4): PL+0x7c8 := 0, delay cleared (VMT+0xc8 = 0x201dd0),
//   reverb flushed (0x2034c0), chorus reset (0x205350); the compressor is not reset.
//
// Parameter laws (P = raw parameter, table records below):
//   chorus 0x73df0: PL+0x7cc = rint(0.004 sr) (+ the flanger's ring length); type
//     record -> TStereoFlanger fields (order, depth / 1024, speed / 1024, delay / 128,
//     spread / 128, cross / 128); m = f32(P91 * 0.001f), dry PL+0x7d8 = 1 - (5^m - 1) / 4,
//     wet obj+0x50 = 1 - (5^(1-m) - 1) / 4; 0x204c50(obj, PL+0x2e4, sr).
//   delay 0x73870: type record (stereo offset ms, cross-feedback flag); offset =
//     rint(|ms| 0.001 sr) frames on L (R when ms > 0); time = rint(sr P95 0.3125 / tempo)
//     samples (P95 in 1/48 beat); ring = offset + block size + time frames
//     (0x201950); feedback target = f32(P94 * 0.001f); input gain = volLaw(P93).
//   reverb 0x73ab0: type record -> TFruityReverb record: predelay rint(sr r2 / 384),
//     decay sr r5 / 10 samples, lowcut r0 Hz, highcut r1 * 100 Hz, room r3, diffusion
//     r4, high damping r6 * 100 Hz, color r7; wet = volLaw(P97) * 0.5f.
//   volLaw(P) (0x73a04): x = f32(P * 0.001f); x == 1 ? 1 :
//     f32((exp(f32(x * ln11f)) - 1) * 0.1f) (FL's LogVol; ln11f = G[2fb9d4], set at 0x7bb88).
//   comp 0x740d0: type 1..4 loads Shared/SGv2_x64.dylib (once) and its state from
//     Harmless/Data/Compression/<type>.fst, then ProcessParam(98); type 0 unloads it.
//
// The FL units are the same code as Harmor's (function bodies compared instruction
// by instruction: TStereoFlanger 0x204a30 / 0x204c50 / 0x205350 / 0x2053c0 / 0x205420 /
// 0x205500 / 0x205640 / 0x205790 = Harmor 0x468210 / 0x468430 / 0x468b30 / 0x468ba0 /
// 0x468c00 / 0x468ce0 / 0x468e20 / 0x468f70; TFruityReverb 0x2046f0 / 0x2034c0 /
// 0x2036b0 / 0x203940 / 0x203c30 / 0x204990 = Harmor 0x467e90 / 0x465510 / 0x466e50 /
// 0x4670e0 / 0x4673d0 / 0x468130), so this file reuses ../harmor/fx-chorus.ts
// (HarmorChorus, driven with a Harmor parameter image), ../harmor/fx-comp-sg.ts
// (SgEngine) and copies the reverb core of ../harmor/fx-reverb.ts (HlReverb below:
// Harmless sets the record directly). Harmless's TDelay_32FS (0x201950..0x202460) is
// an older, simpler class than Harmor's and is ported here (HlDelay).
//
// Fidelity (FL test host vs the engine core + this file; harness in
// .flref/harmless/harness: runfx.ts, fxsweep.py, fxbatch.py, fxat.py, modfx.ts, sgtest.ts):
// bit-exact wherever FL's own render is deterministic: every chorus type x mix 0 / 250 /
// 500 / 1000, delay type x five level / feedback / time sets, reverb type x wet 0 / 137 /
// 500 / 1000, compression type x level 0 / 77 / 500 / 1000, all four units together, notes
// up to 2.5 s with 3 s tails, automation of every FX parameter (types switched, freed and
// re-created), tempos 60.5..174 BPM, 22.05..96 kHz, block sizes 256..1000, and through the
// module (harmless.ts). The four compression states against the real SGv2 (sghost, block
// sizes 37 / 100 / 512, silence gaps): bit-exact. Factory presets: exact or at FL's
// run-to-run noise (multi-voice presets; FL's threaded voice rendering).

import { HarmorChorus } from '../harmor/fx-chorus';
import { SgEngine, type SgPoint, type SgPreset } from '../harmor/fx-comp-sg';
import { cos, exp, log, sin } from '../harmor/fx-libm';
import { fma32 } from '../harmor/ipp';
import { bitsF, f32, fbits, rint } from './fl';

/** G[2fb9d4] (0x7bb88: 0x4019771e): float32 ln 11. */
const LN11F = bitsF(0x4019771e);
/** @2cc3d4: 0.001f. */
const F0001 = f32(0.001);
/** @2cc3cc: 0.1f, used as a double. */
const F01D = f32(0.1);
/** G[2fb99c] (0x7bb00): 2^-24 as float bits, FL's "tiny" (0x7ac70). */
const TINY_BITS = 0x33800000;

/** FL's LogVol of a 0..1000 parameter (delay 0x73a04, reverb 0x73d30). */
function volLaw(p: number): number {
  const x = f32(f32(p) * F0001);
  if (fbits(x) === 0x3f800000) return x;
  return f32((exp(f32(x * LN11F)) - 1) * F01D);
}

/** Chorus types 1..9 (0x2c4b54, 8 int32 each; 0x73df0 reads the first six). */
const CH_TYPES: readonly (readonly number[])[] = [
  [4, 512, 768, 8, 128, -32],
  [5, 1024, 856, 0, 128, 68],
  [7, 512, 512, 128, 128, 54],
  [6, 561, 854, 0, 0, 38],
  [1, 136, 312, 0, 0, 128],
  [2, 86, 632, 0, 0, 0],
  [1, 42, 944, 0, 0, -22],
  [9, 81, 170, 0, 0, -66],
  [7, 19, 985, 0, 0, 0],
];
/** Delay types 1..3 (0x2c4a7c): stereo offset in ms, cross feedback (kernel 0x202300 when != 0). */
const DEL_TYPES: readonly (readonly number[])[] = [
  [0, 0],
  [1, 2],
  [-20, 2],
];
/**
 * Reverb types 1..6 (0x2c4a94, 8 int32 each): lowcut Hz, highcut / 100, predelay in
 * 1/384 s, room, diffusion, decay in 1/10 s, high damping / 100, color.
 */
const REV_TYPES: readonly (readonly number[])[] = [
  [75, 40, 0, 40, 100, 15, 40, 2],
  [0, 115, 18, 40, 100, 22, 50, 2],
  [34, 21, 27, 90, 100, 45, 31, 3],
  [400, 60, 31, 60, 65, 23, 37, 1],
  [100, 36, 0, 35, 100, 6, 36, 2],
  [100, 60, 0, 17, 100, 5, 30, 2],
];

// ======================================================================= delay

/**
 * Harmless's TDelay_32FS (VMT 0x2b6090): a ring of stereo float frames with read and
 * write pointers; constructor 0x201ba0 (feedback target +0x30 = 0.5, current +0x34 = 0),
 * size 0x201950 / 0x2018d0 (reallocate, clear, current := target, read = start, write =
 * read + time, only when the total size changes), ring add 0x201e50 (kernel 0x201e00),
 * feedback ramp 0x7ac70 per call, kernels 0x201f20 (straight) / 0x202200 (swapped output,
 * cross feedback).
 */
class HlDelay {
  private readonly sr: number;
  /** FL rate record +0x3c: f32(0.001 * 44100 / sr), the feedback ramp's largest step. */
  private readonly maxStep: number;
  exists = false;
  private ring = new Float32Array(0);
  /** frames (FL keeps bytes at +0x28) */
  private size = 0;
  /** read (+0x10) / write (+0x18) frame */
  private rd = 0;
  private wr = 0;
  private fbT = 0.5;
  private fbC = 0;
  /** PL+0x7e8 */
  private cross = false;
  /** PL+0x7ec / PL+0x7f0 in frames */
  private offL = 0;
  private offR = 0;
  /** PL+0x7f4 */
  private gain = 0;

  constructor(sr: number) {
    this.sr = sr;
    this.maxStep = f32((0.001 * 44100) / sr);
  }

  /** 0x73870 for type > 0 (the caller frees the object for type <= 0). */
  update(type: number, vol: number, fb: number, time: number, tempo: number, block: number): void {
    if (!this.exists) {
      this.exists = true;
      this.size = 0;
      this.rd = this.wr = 0;
      this.fbT = 0.5;
      this.fbC = 0;
    }
    const rec = DEL_TYPES[Math.min(type, DEL_TYPES.length) - 1];
    this.cross = rec[1] !== 0;
    const ms = rec[0];
    let offL = rint((ms < 0 ? -ms : ms) * 0.001 * this.sr) | 0;
    const d = rint((this.sr * time * 0.3125) / tempo) | 0;
    // allocate room for tempos down to 60 BPM: tempo changes (render path) then do not allocate
    const dMax = Math.max(d, rint((this.sr * time * 0.3125) / 60) | 0);
    this.setSize(offL + block, d, offL + block + dMax);
    let offR = 0;
    if (ms > 0) {
      offR = offL;
      offL = 0;
    }
    this.offL = offL;
    this.offR = offR;
    this.fbT = f32(f32(fb) * F0001);
    this.gain = volLaw(vol);
  }

  /** 0x201950 (cap: frames to allocate when the ring must grow). */
  private setSize(extra: number, delay: number, cap: number): void {
    const d = delay < 1 ? 1 : delay;
    const total = (extra + d) | 0;
    if (total === this.size) return;
    // 0x2018d0: ReallocMem, VMT+0xc8 (zero, current := target), read = start
    const n = total > 0 ? total : 0;
    if (this.ring.length < 2 * n) this.ring = new Float32Array(2 * Math.max(n, cap));
    else this.ring.fill(0, 0, 2 * n);
    this.size = n;
    this.fbC = this.fbT;
    this.rd = 0;
    this.wr = d;
  }

  /** Gen_Render 0x7349c: mix += delay output; tmp = REND+0x20 scratch. */
  process(mix: Float32Array, tmp: Float32Array, n: number, tail: boolean): void {
    const ring = this.ring, size = this.size;
    if (tail) {
      const g = this.gain;
      for (let i = 0; i < 2 * n; i++) tmp[i] = f32(mix[i] * g);
      this.ringAdd(tmp, 0, n, this.wr + this.offL, 0);
      this.ringAdd(tmp, 1, n, this.wr + this.offR, 1);
    }
    // 0x7ac70: feedback start / step for this call
    const start = this.fbC;
    let step = f32(this.fbT - start);
    if (fbits(step) !== 0) {
      this.fbC = this.fbT;
      step = f32(step / n);
      if (Math.abs(step) > this.maxStep) {
        step = fbits(step) < 0 ? -this.maxStep : this.maxStep;
        this.fbC = f32(start + f32(step * n));
        if ((fbits(this.fbC) & 0x7fffffff) < TINY_BITS) {
          this.fbC = 0;
          step = f32(-start / n);
        }
      }
    }
    let fb = start;
    let r = this.rd, w = this.wr;
    const cross = this.cross;
    for (let i = 0; i < n; i++) {
      const l = ring[2 * r], rr = ring[2 * r + 1];
      let fl: number, fr: number;
      if (cross) {
        tmp[2 * i] = rr;
        tmp[2 * i + 1] = l;
        fl = rr;
        fr = l;
      } else {
        tmp[2 * i] = l;
        tmp[2 * i + 1] = rr;
        fl = l;
        fr = rr;
      }
      ring[2 * r] = 0;
      ring[2 * r + 1] = 0;
      let v = f32(f32(fl * fb) + ring[2 * w]);
      ring[2 * w] = v === 0 ? 0 : v; // FL's denormal test only turns -0 into +0
      v = f32(f32(fr * fb) + ring[2 * w + 1]);
      ring[2 * w + 1] = v === 0 ? 0 : v;
      fb = f32(fb + step);
      if (++r >= size) r = 0;
      if (++w >= size) w = 0;
    }
    this.rd = r;
    this.wr = w;
    for (let i = 0; i < 2 * n; i++) mix[i] = f32(mix[i] + tmp[i]);
  }

  /** 0x201e50: ring[pos.., rch] += src[.., ch] for n frames, wrapping once. */
  private ringAdd(src: Float32Array, ch: number, n: number, pos: number, rch: number): void {
    const ring = this.ring, size = this.size;
    if (pos >= size) pos -= size;
    let si = ch;
    const first = size - pos;
    if (n > first) {
      for (let i = 0; i < first; i++, si += 2) ring[2 * (pos + i) + rch] = f32(ring[2 * (pos + i) + rch] + src[si]);
      n -= first;
      pos = 0;
    }
    for (let i = 0; i < n; i++, si += 2) ring[2 * (pos + i) + rch] = f32(ring[2 * (pos + i) + rch] + src[si]);
  }

  /** VMT+0xc8 (0x201dd0): zero the ring, current feedback := target (pointers kept). */
  clear(): void {
    this.ring.fill(0, 0, 2 * this.size);
    this.fbC = this.fbT;
  }
}

// ====================================================================== reverb
// TFruityReverb + libreverb's Process_Fruity_32FM_32FS, copied from
// ../harmor/fx-reverb.ts (HarmorReverb: create / init / flush / coefs / engine, same
// FL code in both plugins); only the record setter (0x73ab0) and the wet add are
// Harmless's. See that file for the algorithm and its verification.

const LN0001 = -6.907755278982137;
const DC = f32(1e-30);
const F02 = f32(0.2);
const F06 = f32(0.6);
const F07 = f32(0.7);
const RV_TBL = [142, 107, 379, 277, 672, 4453, 1800, 3720, 908, 4217, 2656, 3163];
const RV_TAPL = [266, 2974, 1913, 2496, 1690, 187, 1566];
const RV_TAPR = [353, 3627, 1728, 3173, 1811, 335, 621];
const RV_COLOR = [F02, F06, 1, 1.5, 3];

function muldiv(a: number, b: number, c: number): number {
  return Math.trunc((a * b) / c) | 0;
}
function tanFpc(x: number): number {
  return sin(x) / cos(x);
}
function pow025(b: number): number {
  return b === 0 ? 0 : exp(0.25 * log(b));
}
function onePole(s15: number, half: number, isr: number): number {
  if (s15 === 0) return 1;
  if (!(s15 < half)) s15 = half;
  const c = cos(f32(200 * s15) * Math.PI * isr);
  const s12 = f32(2 - c);
  return f32(1 - f32(s12 - f32(Math.sqrt(f32(f32(s12 * s12) - 1)))));
}

class HlReverb {
  private readonly sr: number;
  /** FL's single GetMem block: the 12 lines, then the predelay line (allocated on first use). */
  private mem = new Float32Array(0);
  private readonly memLen: number;
  private readonly pdCap: number;
  exists = false;
  private dirty = false;
  // record (obj+0x38..0x54)
  private lowcut = 0;
  private highcut = 0;
  private predelay = 0;
  private room = 0;
  private diff = 0;
  private decay = 0;
  private damp = 0;
  private color = 0;
  // ReverbData
  private zLp = 0;
  private zApY = 0;
  private zApX = 0;
  private cLc = 0;
  private g = 0;
  private dd1 = 0;
  private dd2 = 0;
  private id1 = 0;
  private cHc = 0;
  private cDamp = 0;
  private zDampA = 0;
  private zDampB = 0;
  private shA = 0;
  private shK = 0;
  private shXA = 0;
  private shYA = 0;
  private shXB = 0;
  private shYB = 0;
  private total = 0;
  private readonly ptr = new Int32Array(13);
  private readonly pos = new Int32Array(13);
  private readonly len = new Int32Array(13);
  private readonly tap = new Int32Array(14);
  private lastRoom = 0;

  constructor(sr: number) {
    this.sr = sr;
    let lines = 0;
    for (let i = 0; i < 12; i++) lines += muldiv(RV_TBL[i], sr, 20000);
    let pd = 1;
    for (const r of REV_TYPES) pd = Math.max(pd, rint((sr * r[2]) / 384));
    this.pdCap = pd;
    this.memLen = lines + pd;
  }

  /** 0x73ab0 for type > 0 (the caller frees the object for type <= 0). */
  update(type: number): void {
    if (!this.exists) this.create();
    const rec = REV_TYPES[Math.min(type, REV_TYPES.length) - 1];
    const sr = this.sr;
    const pd = rint((sr * rec[2]) / 384) | 0;
    if (pd !== this.predelay) {
      this.predelay = pd;
      this.init();
    }
    this.decay = f32((sr * rec[5]) / 10);
    this.lowcut = rec[0];
    this.highcut = rec[1];
    this.damp = rec[6];
    this.room = rec[3];
    this.diff = rec[4];
    this.color = rec[7];
    this.dirty = true;
  }

  /** 0x2046f0 (= Harmor 0x467e90) + the sample-rate init. */
  private create(): void {
    if (this.mem.length === 0) this.mem = new Float32Array(this.memLen);
    this.exists = true;
    this.lowcut = 75;
    this.highcut = 40;
    this.predelay = 0;
    this.room = 50;
    this.diff = 100;
    this.decay = 15;
    this.damp = 40;
    this.color = 2;
    this.cLc = this.g = this.dd1 = this.dd2 = this.id1 = 0;
    this.cHc = this.cDamp = this.shA = this.shK = 0;
    this.lastRoom = 0;
    this.init();
    this.dirty = true;
  }

  /** VMT+0xc8 0x2036b0 + VMT+0xd0 0x203940. */
  private init(): void {
    const sr = this.sr;
    let total = 0;
    for (let i = 0; i < 12; i++) {
      this.pos[i] = 0;
      this.len[i] = muldiv(RV_TBL[i], sr, 20000);
      total += this.len[i];
    }
    this.pos[12] = 0;
    let pl = this.predelay > 1 ? this.predelay : 1;
    if (pl > this.pdCap) pl = this.pdCap;
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
      this.tap[i] = muldiv(RV_TAPL[i], sr, 20000);
      this.tap[7 + i] = muldiv(RV_TAPR[i], sr, 20000);
    }
    this.flush();
  }

  /** 0x2034c0: zero the lines and the filter states (positions kept). */
  flush(): void {
    this.mem.fill(0, 0, this.total);
    this.zLp = this.zApY = this.zApX = 0;
    this.shXA = this.shYA = this.shXB = this.shYB = 0;
    this.zDampA = this.zDampB = 0;
  }

  /** Gen_Render 0x73578: mix += reverb(L + R) * wet. */
  process(mix: Float32Array, mono: Float32Array, out: Float32Array, n: number, wet: number): void {
    for (let i = 0; i < n; i++) mono[i] = f32(mix[2 * i] + mix[2 * i + 1]);
    if (this.dirty) this.coefs();
    this.engine(mono, out, n);
    for (let i = 0; i < 2 * n; i++) mix[i] = fma32(out[i], wet, mix[i]);
  }

  /** 0x203c30 (= Harmor 0x4673d0). */
  private coefs(): void {
    const sr = this.sr;
    const half = f32(f32(sr) * 0.5);
    const isr = f32(1 / sr);
    let s15 = this.lowcut;
    if (s15 === 0) this.cLc = 0;
    else {
      if (!(s15 < half)) s15 = half;
      const t = f32(tanFpc(Math.PI * s15 * isr));
      this.cLc = f32(f32(t - 1) / f32(t + 1));
    }
    this.cHc = onePole(this.highcut, half, isr);
    const rsr = muldiv(sr, this.room + 15, 0x73);
    const L = this.len;
    for (let i = 0; i < 12; i++) {
      let l = muldiv(RV_TBL[i], rsr, 20000);
      if (l < 1) l = 1;
      L[i] = l;
      this.pos[i] = this.pos[i] % l;
    }
    for (let i = 0; i < 7; i++) {
      this.tap[i] = muldiv(RV_TAPL[i], rsr, 20000);
      this.tap[7 + i] = muldiv(RV_TAPR[i], rsr, 20000);
    }
    if (this.room !== this.lastRoom) {
      this.lastRoom = this.room;
      for (let i = 0; i < 12; i++) this.mem.fill(0, this.ptr[i], this.ptr[i] + L[i]);
    }
    const s11 = f32(this.diff * 0.01);
    const h = f32(0.5 * isr);
    const s1 = f32(f32(L[0] + L[1]) * h);
    const s8 = f32(f32(L[4] + L[8]) * h);
    const s9 = f32(f32(L[6] + L[10]) * h);
    if (s11 === 0) {
      this.id1 = this.dd1 = this.dd2 = 0;
    } else {
      this.id1 = f32(exp((LN0001 * s1) / (s11 * 0.07)));
      this.dd1 = f32(exp((LN0001 * s8) / (s11 * 0.35)));
      this.dd2 = f32(exp((LN0001 * s9) / (s11 * 0.51)));
    }
    const sum = f32(L[5] + L[7] + L[9] + L[11]);
    const dec = this.decay;
    this.g = f32(pow025(exp((LN0001 * sum) / dec)));
    this.cDamp = onePole(this.damp, half, isr);
    const col = this.color;
    const k = col >= 0 && col <= 4 ? RV_COLOR[col] : 1;
    const t = f32(pow025(exp((LN0001 * sum) / f32(dec * k))));
    let r = f32(t / this.g);
    this.shK = f32(f32(r - 1) * 0.5);
    if (r > 1) r = 1;
    const t5 = f32(tanFpc(Math.PI * 500 * isr));
    this.shA = f32(f32(t5 - r) / f32(t5 + r));
    this.dirty = false;
  }

  /** libreverb BaseReverb::Process_Fruity_32FM_32FS: mono in, interleaved stereo out. */
  private engine(inp: Float32Array, out: Float32Array, n: number): void {
    if (n <= 0) return;
    const fma = fma32;
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
      const x = f32(inp[i] + DC);
      const lp = fma(f32(x - zLp), cHc, zLp);
      const ap = fma(f32(lp - zApY), cLc, zApX);
      zLp = lp;
      zApY = ap;
      zApX = lp;
      let u = lcOn ? fma(f32(lp - ap), 0.5, DC) : lp;
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
      j = P12 + p12;
      const pd = mem[j];
      mem[j] = u;
      if (p12 <= 0) p12 = L12;
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
      out[2 * i + 1] = f32(o - s);
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

// ================================================================= compression

type Pt = [number, number, number, number, number, number, number];

/**
 * Harmless/Data/Compression/1..4.fst (FL Studio 2026): the Maximus state blobs
 * (event 213, version 7), parameters at +4 (59 int32, FL order). Type 1's file is
 * byte-identical to Harmor's System/Compression/1.fst.
 */
const COMP_PARAMS: readonly (readonly number[])[] = [
  [19800, 0, 48065, 0, 1115, 1000, -1, 3, 1000, 1000, 0, 0, 1000, 1115, 0, 2, 5000, 3, 2882, 0, 1, 1000, 1000, 0, 0, 1000, 1115, 0, 2, 5000, 3, 2882, 0, 3, 1000, 1000, 0, 0, 1000, 1115, 0, 2, 5000, 3, 2882, 0, 0, 1000, 1000, 0, 0, 1000, 1115, 0, 2, 8440, 3, 2882, 0],
  [19800, 1, 48065, 1, 891, 1000, -1, 0, 1264, 1296, 500, -1000, 1284, 1115, 0, 2, 5736, 3, 2882, 0, 0, 1340, 1000, -348, 0, 1000, 1115, 0, 2, 5000, 3, 1570, 0, 0, 1364, 1152, 0, 0, 1000, 1115, 0, 2, 5000, 3, 1186, 0, 0, 1000, 1000, 0, 0, 1000, 1115, 4464, 2, 5000, 3, 1538, 0],
  [19800, 1, 48065, 1, 891, 0, 32768, 0, 1264, 1296, 1000, -1000, 1284, 1115, 0, 2, 5736, 3, 2882, 0, 0, 1340, 1000, -384, 0, 1000, 1115, 0, 2, 5000, 3, 1570, 0, 0, 1364, 1152, 0, -1000, 1000, 1115, 0, 2, 5000, 3, 1186, 0, 0, 1000, 1000, 0, -196, 1000, 1115, 4464, 2, 5000, 3, 1538, 0],
  [5848, 1, 35905, 0, 0, 1000, -1, 1, 1000, 2000, 0, -72, 688, 1115, 0, 1, 5000, 1, 2882, 1, 1, 1000, 2000, 0, -684, 392, 1115, 0, 1, 5000, 1, 2882, 1, 1, 1000, 2000, 0, -580, 380, 1115, 0, 1, 5000, 1, 2882, 1, 1, 1000, 1236, 0, -128, 1000, 1115, 0, 1, 5000, 1, 2882, 1],
];

/**
 * The band curves (LOW, MID, HIGH, MASTER) as SGv2 holds them after loading
 * ([dx, y, shape, flag, c0, c1, c2], see SgPoint). The files store per point dx, y
 * (double), tension (float) and the shape byte. Types 2 and 3 store exactly the
 * points of Harmor's Compression/3.fst and 4.fst, so their values are those of
 * ../harmor/fx-comp.ts; type 4's curves are straight lines (0, 0) -> (1, 1) (tension 0;
 * shape 7 on LOW / MID, 0 on HIGH / MASTER).
 */
const LINE: Pt[] = [[0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 2, 0, 0, 0], [0.5, 0.5, 0, 2, 0, 0, 0]];
const COMP_CURVES: readonly (readonly (readonly Pt[])[])[] = [
  [LINE, LINE, LINE, LINE],
  [
    [[0, 0, 0, 0, 0, 0, 0], [1, 0.550000011920929, 7, 1, 0.6399997472763062, 0, 0]],
    [[0, 0, 0, 0, 0, 0, 0], [0.3499999940395355, 0.3499999940395355, 0, 2, 0, 0, 0], [0.6500000059604645, 0.6000000238418579, 7, 1, 0.3600000739097595, 0, 0]],
    [[0, 0, 0, 0, 0, 0, 0], [1, 0.550000011920929, 7, 1, 0.6399997472763062, 0, 0]],
    [[0, 0, 0, 0, 0, 0, 0], [0.30000001192092896, 0.30000001192092896, 0, 2, 0, 0, 0], [0.699999988079071, 0.5, 7, 1, 0.5149999856948853, 0, 0]],
  ],
  [
    [[0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 1, 1.6302682161331177, 0.6133959889411926, 0.9670857787132263], [0.5, 0.5, 0, 2, 0, 0, 0]],
    [[0, 0, 0, 0, 0, 0, 0], [0.3999999940395357, 0.4000000059604645, 0, 2, 0, 0, 0], [0.6000000059604643, 0.6000000238418579, 0, 1, 12.803838729858398, 0.07810157537460327, 2.6249468326568604]],
    [[0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 1, 5.918312072753906, 0.1689670979976654, 1.9341717958450317], [0.5, 0.5, 0, 2, 0, 0, 0]],
    [[0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 2, 0, 0, 0], [0.5, 0.6000000238418579, 0, 1, 2.2359371185302734, 0.4472397565841675, 1.174318552017212]],
  ],
  [
    [[0, 0, 0, 0, 0, 0, 0], [1, 1, 7, 2, 0, 0, 0]],
    [[0, 0, 0, 0, 0, 0, 0], [1, 1, 7, 2, 0, 0, 0]],
    [[0, 0, 0, 0, 0, 0, 0], [1, 1, 0, 2, 0, 0, 0]],
    [[0, 0, 0, 0, 0, 0, 0], [1, 1, 0, 2, 0, 0, 0]],
  ],
];
/** SGv2's oversampling after loading each state (2x for none of Harmless's). */
/**
 * SGv2's 2x oversampling of LOW / MID / HIGH after loading each state: on for type 4
 * only (found by rendering the four files through the real SGv2, harmor/fxw/comp/sghost:
 * type 4 matches bit for bit with it on, as Harmor's type 2 does).
 */
const COMP_OVERSAMPLE = [0, 0, 0, 1];

let compPresets: SgPreset[] | null = null;
function compPreset(t: number): SgPreset {
  if (!compPresets) {
    compPresets = COMP_PARAMS.map((params, i) => ({
      params: params.slice(),
      oversample: COMP_OVERSAMPLE[i],
      curves: COMP_CURVES[i].map((pts) => pts.map(([dx, y, mode, flag, c0, c1, c2]): SgPoint => ({ dx, y, mode, flag, c0, c1, c2 }))),
    }));
  }
  return compPresets[t - 1];
}

/** SGv2 0x3632d8: the alpha factors of the low cut's four sections (float32). */
const LC_ALPHA = new Float32Array([0.19771184027194977, 0.61932772397995, 0.6768445372581482, 1.0793569087982178]);
/** SGv2 G[3c4910] * G[3c4958]: 2^-14 ln 2 (frequency law of parameter 6). */
const LC_K = 6.103515625e-5 * 0.6931471805599453;
/** SGv2's silence gate (fx-comp-sg.ts: SILENT, threshold). */
const SG_SILENT = -0x3fffffff;
const SG_EPS = 9.999999974752427e-7;

/**
 * SGv2's input low cut (Maximus "low cut", parameter 6 >= 0; only Harmless's type 3
 * uses it, 32768 = 20 Hz), which SgEngine does not implement: object +0x358 (class
 * 0x338db0, constructor 0x24d5f0: four type-4 RBJ high passes), design 0x68220 ->
 * 0x24d770 (f = f32(5 exp(p6 2^-14 ln 2)), w = f 0.8 2 pi / sr, alpha_i = sin(w) LC_ALPHA[i],
 * the biquad law 0x1eeee0), run by Eff_Render (0x6ad50, when the silence gate is open)
 * in place on the input before the bands, sections in order with kernel 0x3ef8
 * (= SgBiquad.run in ../harmor/fx-comp-sg.ts, copied), cleared by SGv2's reset 0x6cb70.
 */
class SgLowCut {
  on = false;
  private readonly c = new Float64Array(20); // per section b0 b1 b2 a1 a2
  private readonly st = new Float64Array(32); // per section x1l x1r x2l x2r y1l y1r y2l y2r

  design(p6: number, sr: number): void {
    this.on = p6 >= 0;
    if (!this.on) return;
    const f = f32(5 * exp(p6 * LC_K));
    const w = f * 0.8 * (6.283185307179586 * (1 / sr));
    const s = sin(w), co = cos(w);
    for (let i = 0; i < 4; i++) {
      const alpha = s * LC_ALPHA[i];
      const k = 1 / (1 + alpha);
      const b1 = k * -(1 + co);
      const b0 = -b1 * 0.5;
      const c = this.c, o = 5 * i;
      c[o] = b0;
      c[o + 1] = b1;
      c[o + 2] = b0;
      c[o + 3] = k * (-2 * co);
      c[o + 4] = k * (1 - alpha);
    }
  }

  reset(): void {
    this.st.fill(0);
  }

  run(buf: Float32Array, n: number): void {
    const c = this.c, s = this.st;
    for (let k = 0; k < 4; k++) {
      const o = 5 * k, q = 8 * k;
      const b0 = c[o], b1 = c[o + 1], b2 = c[o + 2], a1 = c[o + 3], a2 = c[o + 4];
      let x1l = s[q], x1r = s[q + 1], x2l = s[q + 2], x2r = s[q + 3];
      let y1l = s[q + 4], y1r = s[q + 5], y2l = s[q + 6], y2r = s[q + 7];
      for (let i = 0, j = 0; i < n; i++, j += 2) {
        const xl = buf[j], xr = buf[j + 1];
        const yl = (b2 * x2l + b1 * x1l - a1 * y1l - a2 * y2l) + b0 * xl;
        const yr = (b2 * x2r + b1 * x1r - a1 * y1r - a2 * y2r) + b0 * xr;
        buf[j] = yl;
        buf[j + 1] = yr;
        x2l = x1l; x1l = xl; y2l = y1l; y1l = yl;
        x2r = x1r; x1r = xr; y2r = y1r; y1r = yr;
      }
      s[q] = x1l; s[q + 1] = x1r; s[q + 2] = x2l; s[q + 3] = x2r;
      s[q + 4] = y1l; s[q + 5] = y1r; s[q + 6] = y2l; s[q + 7] = y2r;
    }
  }
}

/** The hosted SGv2 (PL+0x810's plugin list; ../harmor/fx-comp-sg.ts). */
class HlComp {
  private readonly sr: number;
  private readonly maxBlock: number;
  private engine: SgEngine | null = null;
  private readonly lowCut = new SgLowCut();
  /** SGv2's silence gate counter (+0x800) and reload (+0x7fc), kept for the low cut. */
  private gate = SG_SILENT;
  private reload = 0;
  type = 0;

  constructor(sr: number, maxBlock: number) {
    this.sr = sr;
    this.maxBlock = maxBlock;
  }

  /** 0x740d0: type 1..4 loads SGv2 (a fresh instance when none) and the type's state; 0 unloads. */
  setType(t: number, level: number): void {
    if (t < 1 || t > 4) {
      this.type = 0;
      this.engine = null;
      return;
    }
    if (!this.engine) this.engine = new SgEngine(this.sr, this.maxBlock);
    this.type = t;
    const p = compPreset(t);
    this.engine.load(p);
    this.lowCut.design(p.params[6], this.sr);
    this.lowCut.reset();
    this.gate = SG_SILENT;
    this.reload = rint(f32(1.5 * this.sr)) + this.engine.latency;
    this.engine.setMix(level);
  }

  /** ProcessParam 98 -> SGv2 param 5 (LMH mix), raw. */
  setLevel(level: number): void {
    if (this.engine && this.type > 0) this.engine.setMix(level);
  }

  process(mix: Float32Array, n: number): void {
    if (!this.engine || this.type <= 0) return;
    if (this.lowCut.on) {
      // Eff_Render 0x6ac9c: the gate decides on the unfiltered input. When it closes, FL
      // resets (0x6cb70, low cut included) and passes the block through; while it is open
      // the low cut filters the block, then the bands run. SgEngine's own gate sees the
      // filtered block, so the closing is done here (its counter is then SILENT like FL's).
      let silent = true;
      for (let i = 0; i < 2 * n; i++) {
        const v = mix[i];
        if (!(v <= SG_EPS && v >= -SG_EPS)) {
          silent = false;
          break;
        }
      }
      this.gate = silent ? this.gate - n : this.reload;
      if (-n >= this.gate) {
        if (this.gate > SG_SILENT) {
          this.lowCut.reset();
          this.engine.reset();
        }
        this.gate = SG_SILENT;
        return;
      }
      this.lowCut.run(mix, n);
    }
    this.engine.process(mix, n);
  }

  get latency(): number {
    return this.engine && this.type > 0 ? this.engine.latency : 0;
  }
}

// ==================================================================== the chain

/** HarmorChorus reads its parameters from Harmor's indices 804..810. */
const H_CH = 804;
/** Ring extra of HarmorChorus (Harmor passes 384 to 0x468430, Harmless PL+0x2e4). */
const H_CHUNK = 384;

export class HlFx {
  private readonly sr: number;
  /** PL+0x2e4: the host's block size (FPD_SetBlockSize), the ring extra of delay / chorus. */
  private readonly block: number;
  private readonly chorus: HarmorChorus;
  private readonly chRaw = new Int32Array(825);
  private readonly delay: HlDelay;
  private readonly reverb: HlReverb;
  private readonly comp: HlComp;
  private readonly tmp: Float32Array; // REND+0x20
  private readonly tmp2: Float32Array; // REND+0x28
  private readonly chunk: Float32Array;
  private readonly P = new Int32Array(100);
  private compType = 0;
  private loaded = false;
  private tempoKnown = false;
  private processed = false;
  /** PL+0x2dc (float32 BPM) */
  private tempo = 130;
  /** PL+0x7c8 / PL+0x7cc */
  private tailCnt = 0;
  private tailLen = 0;
  /** PL+0x808 */
  private revWet = 0;

  constructor(sr: number, maxBlock: number) {
    this.sr = Math.round(sr) | 0;
    this.block = Math.max(1, maxBlock | 0);
    this.chorus = new HarmorChorus(this.sr, this.block);
    this.delay = new HlDelay(this.sr);
    this.reverb = new HlReverb(this.sr);
    this.comp = new HlComp(this.sr, this.block);
    this.tmp = new Float32Array(2 * this.block);
    this.tmp2 = new Float32Array(2 * this.block);
    this.chunk = new Float32Array(2 * this.block);
    this.tailLen = rint(0.004 * this.sr);
  }

  /**
   * Parameters 0..99 (raw) and the compression type, on every state change: the
   * first call is a state load (compression updater, then all FX updaters), later
   * calls run the updaters of the parameters that changed (FL's ProcessParam).
   */
  setParams(P: ArrayLike<number>, compType: number): void {
    const o = this.P;
    const first = !this.loaded;
    const ch = first || P[90] !== o[90] || P[91] !== o[91];
    const de = first || P[92] !== o[92] || P[93] !== o[93] || P[94] !== o[94] || P[95] !== o[95];
    const rv = first || P[96] !== o[96] || P[97] !== o[97];
    const lv = first || P[98] !== o[98];
    for (let i = 0; i < 100; i++) o[i] = P[i] | 0;
    if (first || compType !== this.compType) {
      this.compType = compType | 0;
      this.comp.setType(this.compType, o[98]);
    }
    if (ch) this.chorusUpdate();
    if (de) this.delayUpdate();
    if (rv) this.reverbUpdate();
    if (lv) this.comp.setLevel(o[98]);
    this.loaded = true;
  }

  /** FPE_Tempo (0x69ff0): PL+0x2dc, then the delay updater. */
  setTempo(bpm: number): void {
    const t = f32(bpm);
    if (!(t > 0)) return;
    const first = !this.tempoKnown;
    this.tempoKnown = true;
    if (t === this.tempo) return;
    this.tempo = t;
    if (!this.loaded) return;
    if (first && !this.processed) {
      // FL knows the tempo before the state loads: build the delay as that load would have
      if (this.delay.exists) {
        this.delay.exists = false;
        this.delayUpdate();
      }
      return;
    }
    this.delayUpdate();
  }

  /** 0x73df0 */
  private chorusUpdate(): void {
    this.tailLen = rint(0.004 * this.sr);
    const t = this.P[90];
    const r = this.chRaw;
    if (t > 0) {
      const rec = CH_TYPES[Math.min(t, CH_TYPES.length) - 1];
      for (let i = 0; i < 6; i++) r[H_CH + i] = rec[i];
      r[H_CH + 6] = this.P[91];
      this.chorus.update(r, this.tempo);
      this.tailLen += this.chorus.tailSamples - H_CHUNK + this.block;
    } else {
      r[H_CH] = 0;
      this.chorus.update(r, this.tempo); // FreeAndNil
    }
  }

  /** 0x73870 */
  private delayUpdate(): void {
    const P = this.P;
    if (P[92] > 0) this.delay.update(P[92], P[93], P[94], P[95], this.tempo, this.block);
    else this.delay.exists = false; // FreeAndNil
  }

  /** 0x73ab0 */
  private reverbUpdate(): void {
    if (this.P[96] > 0) {
      this.reverb.update(this.P[96]);
      this.revWet = f32(volLaw(this.P[97]) * 0.5);
    } else this.reverb.exists = false; // FreeAndNil
  }

  /**
   * One Gen_Render's FX on the interleaved stereo mix (in place). voices: whether
   * Harmless had voices when the call started (before they rendered).
   */
  process(mix: Float32Array, n: number, voices: boolean): void {
    if (voices) this.tailCnt = this.tailLen;
    else if (this.tailCnt > 0) this.tailCnt -= n;
    this.processed = true;
    const tail = this.tailCnt > 0;
    if (n <= this.block) {
      this.units(mix, n, tail);
      return;
    }
    // longer than the block size FL announced (not done by Harmless's module): in pieces
    const c = this.chunk;
    for (let off = 0; off < n; off += this.block) {
      const m = Math.min(this.block, n - off);
      for (let i = 0; i < 2 * m; i++) c[i] = mix[2 * off + i];
      this.units(c, m, tail);
      for (let i = 0; i < 2 * m; i++) mix[2 * off + i] = c[i];
    }
  }

  private units(buf: Float32Array, n: number, tail: boolean): void {
    if (this.chorus.active) this.chorus.process(buf, n, tail);
    if (this.delay.exists) this.delay.process(buf, this.tmp, n, tail);
    if (this.reverb.exists) this.reverb.process(buf, this.tmp, this.tmp2, n, this.revWet);
    this.comp.process(buf, n);
  }

  /** FPD_Flush (0x63da4): tail counter, delay, reverb and chorus state cleared. */
  reset(): void {
    this.tailCnt = 0;
    if (this.delay.exists) this.delay.clear();
    if (this.reverb.exists) this.reverb.flush();
    this.chorus.reset();
  }

  /**
   * Whether the FX still sound without voices: the chorus while the tail counter runs;
   * delay, reverb and compression always (FL runs them in every Gen_Render call).
   */
  get active(): boolean {
    return (this.tailCnt > 0 && this.chorus.active) || this.delay.exists || this.reverb.exists || this.comp.type > 0;
  }

  /**
   * Seconds the FX sound after the last voice: Infinity while delay, reverb or
   * compression exist, else the chorus tail PL+0x7cc (4 ms + block size + the chorus's
   * longest delay), 0 without effects.
   */
  tailSeconds(): number {
    if (this.delay.exists || this.reverb.exists || this.comp.type > 0) return Infinity;
    return this.chorus.active ? this.tailLen / this.sr : 0;
  }

  /** SGv2's reported latency (not compensated by Harmless). */
  get latency(): number {
    return this.comp.latency;
  }
}
