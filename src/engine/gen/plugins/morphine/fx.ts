// Morphine master effects chain: overdrive -> chorus -> delay -> reverb -> EQ.
//
// Ported op for op from Morphine 1.7.0 (arm64 Rev2653) through the C reference model
// .flref/morphine/tools/fx_model.c (RE notes: .flref/morphine/notes/fx.md). Addresses are VM
// addresses in morphine_arm64.dylib.
//
// Chain object (synth+0x60b8, ctor 0x5270): CChorus +0x0, CDelay +0x38, CReverb +0x70, EQ +0x1a0,
// overdrive target / smoothed drive +0x570 / +0x574. Fx_Chain_Process 0x53ec runs in place on the
// synth output: Overdrive 0x55dc -> Chorus 0x22584 -> Delay 0x554b4 -> Reverb 0x416fc -> EQ 0x201b0.
// Its sleep logic (+0x580..+0x584) is dead code (the silence counter is only ever written with 0),
// so every effect runs on every block, gated only by its own enable.
//
// Exactness (bit-identical to the C model, see .flref/morphine/port/fx/): every float32 operation is
// rounded with Math.fround; the float FMADD / FNMSUB of the binary use fmaf() below (exact, one
// rounding); double FMADD uses fmaD (exact) wherever the product is not exact in double (where it
// is exact, a plain a * b + c is the same single rounding), or fmaF() when the result is converted
// to float at once; Apple libm float functions (__exp10f, sinf, cosf, __sincosf_stret) use the
// bit-exact ports in poizone/applemath. sinh (EQ band setup, double) is Math.sinh: after the float
// rounding it equals Apple's for the band frequencies at the usual sample rates (checked).
// AudioWorklet code: deterministic, no allocation in process / setParam / reset.

import { exp10f, sinf, cosf, sincosf } from '../poizone/applemath';
import { fmaD } from '../poizone/dsp';

const f32 = Math.fround;
/** 1e-9f (0x3089705f): the denormal guard used everywhere in the chain. */
const TINY = f32(1e-9);
const flush = (x: number): number => (x > -TINY && x < TINY ? 0 : x);
/** fcvtzu: double -> size_t, truncating; negative / NaN -> 0. */
const toSize = (x: number): number => (x > 0 ? Math.floor(x) : 0);
/** fminnm / fmaxnm (operands are never NaN here). */
const minnm = (a: number, b: number): number => (a < b ? a : b);
const maxnm = (a: number, b: number): number => (a > b ? a : b);

/**
 * float fused multiply-add a * b + c with one rounding (arm64 FMADD Sd). a, b, c are float32 values.
 * a * b is exact in double, so a * b + c rounds once to double; rounding that to float is exact
 * unless the double is exactly halfway between two floats, which is resolved with the TwoSum error.
 */
function fmaf(a: number, b: number, c: number): number {
  const p = a * b;
  const s = p + c;
  const r = f32(s);
  if (r === s) return r;
  const o = 2 * s - r; // the other float neighbour if s is a float midpoint (exact)
  if (f32(o) !== o) return r;
  const bb = s - p;
  const e = (p - (s - bb)) + (c - bb); // exact sum = s + e
  if (e === 0) return r; // a true tie: ties-to-even, as fround did
  return (e > 0) === (o > r) ? o : r;
}

const EB = Math.pow(2, -50);
/**
 * (float)fma(a, b, c) for doubles (double FMADD, then FCVT). The plain a * b + c is within 2^-51 (|a b| + |a b + c|)
 * of the fused double, so when no float rounding boundary lies in a wider interval around it, both round to the
 * same float; otherwise (about once in 2^24 calls, or a zero result) the exact fmaD decides.
 */
function fmaF(a: number, b: number, c: number): number {
  const p = a * b;
  const s = p + c;
  if (p === 0) return f32(s); // exact product: a single rounding
  const eb = (Math.abs(p) + Math.abs(s)) * EB;
  const lo = f32(s - eb);
  if (lo === f32(s + eb) && lo !== 0) return lo;
  return f32(fmaD(a, b, c));
}

// ------------------------------------------------------------------------------------------------
// CTapeDelay (class 0x88680; ctor 0x63db0 -> 0x63980, process 0x63e50, reset 0x63d10): the
// variable-speed "tape" behind the chorus (3 instances) and the delay (2). Samples are written with
// their tape time t (advancing dt = 1/delay per sample, wrapping at 1); the read head plays the
// previous period at the same time stamp. Its 2-pole LP / HP feedback filters (+0x7c / +0xa4) are
// disabled in the ctor and never enabled (setters 0x64180 / 0x6419c have no callers).

/** One tape buffer: {float s[N+256]; double tm[N+256]; int count; int ridx}; element k at index k+10. */
class TapeBuf {
  readonly s: Float32Array;
  readonly t: Float64Array;
  count = 0;
  ridx = 0;
  constructor(len: number) {
    this.s = new Float32Array(len);
    this.t = new Float64Array(len);
  }
  clear(): void {
    this.s.fill(0);
    this.t.fill(0);
    this.count = 0;
    this.ridx = 0;
  }
}

class Tape {
  readonly N: number; // +0x28 max(maxLen, 4)
  readonly invN: number; // +0x68 1/N
  readonly t0: number; // +0x60 write time after a reset
  private readonly a: TapeBuf; // +0x8
  private readonly b: TapeBuf; // +0x10
  private w: TapeBuf; // +0x18 write buffer
  private r: TapeBuf; // +0x20 read buffer
  private p = 0; // +0x30 LFO phase
  inc = 0; // +0x38 LFO phase increment
  private wetS = 0; // +0x40 smoothed wet (float)
  private invD: number; // +0x48 1/delay target
  private invDs: number; // +0x50 1/delay smoothed
  private t: number; // +0x58 write time
  fb = 0; // +0x70 feedback (float)
  wet = 1; // +0x74 wet target (float)
  depth = 0; // +0x78 LFO depth (float)
  // Not FL state: set once a glide step returned its input unchanged. The step is a pure function of (target,
  // value), so it stays put until the target changes or a reset; skipping it then is exact (saves an fmaD).
  private wetFixed = false;
  private invFixed = false;

  constructor(maxLen: number, t0: number) {
    // 0x63980
    const N = maxLen > 4 ? maxLen : 4;
    this.N = N;
    this.t0 = t0;
    this.a = new TapeBuf(N + 256);
    this.b = new TapeBuf(N + 256);
    this.w = this.a;
    this.r = this.b;
    const inv = 1 / N;
    this.invD = 1 / ((inv + 0.5) * N); // delay 1 + N/2
    this.invN = inv;
    this.invDs = this.invD;
    this.t = t0;
  }

  /** 0x63d10. W and R are not swapped back (both buffers are cleared, so it does not matter). */
  reset(): void {
    this.wetS = 0;
    this.t = this.t0;
    this.invDs = this.invD;
    this.p = 0;
    this.a.clear();
    this.b.clear();
    this.wetFixed = false;
    this.invFixed = false;
  }

  /** 0x63bf4: delay = 2 + d (N - 2) samples. */
  setTime(d: number): void {
    d = maxnm(minnm(d, 0.99), 0);
    const dN = this.N;
    const d2 = 2 / dN;
    let d0 = fmaD(-d2, d, d); // fmsub: d - d2 * d
    d0 = d0 + d2;
    d0 = d0 * dN;
    this.invD = 1 / d0;
    this.invFixed = false;
  }
  /** 0x63c58 */
  setRate(hz: number, sr: number): void {
    this.inc = maxnm(hz, 0) / sr;
  }
  /** 0x63cf4 */
  setDepth(d: number): void {
    this.depth = f32(maxnm(minnm(d, 1), 0));
  }
  /** 0x63c4c */
  setFeedback(d: number): void {
    this.fb = f32(d);
  }
  /** 0x63c40 */
  setWet(d: number): void {
    this.wet = f32(d);
    this.wetFixed = false;
  }

  /** 0x63e50 */
  process(inp: number): number {
    const x = flush(inp);
    // LFO: triangle shaped by smoothstep (double)
    const p = this.p;
    const p2 = p + p;
    const tri = p < 0.5 ? p2 : 2 - p2;
    const c3 = 3 - (tri + tri);
    const tt = (tri * tri) * this.depth;
    const np = this.inc + p;
    const ip = np < 1 ? 0 : Math.trunc(np);
    this.p = np - ip;
    // read the previous period at the current write time (linear interpolation by time stamp)
    let y = 0;
    const R = this.r;
    const cnt = R.count;
    if (cnt !== 0) {
      let idx = R.ridx;
      if (!(idx > cnt)) {
        const t = this.t;
        const rt = R.t;
        let w13 = idx - 1;
        let d5 = 0;
        let found = true;
        for (;;) {
          d5 = rt[idx + 10];
          if (t <= d5) break;
          idx++;
          R.ridx = w13 + 2;
          w13++;
          if (cnt === w13) {
            found = false;
            break;
          }
        }
        if (found) {
          const rs = R.s;
          const s1 = rs[idx + 10];
          const t1 = f32(d5);
          const s0 = rs[idx + 9];
          const t0f = f32(rt[idx + 9]);
          let fr = 0;
          if (t0f < t1) fr = (t - t0f) / f32(t1 - t0f);
          y = fmaF(fr, f32(s1 - s0), s0);
        }
      }
    }
    const mod = fmaD(tt, c3, 1); // 1 + depth * smoothstep(tri)
    y = flush(y);
    const m = maxnm(mod, 1);
    const w = fmaf(this.fb, y, x); // written: in + fb * out
    let dt = this.invDs * m;
    dt = minnm(dt, 0.2);
    dt = maxnm(dt, this.invN);
    const wetOld = this.wetS;
    let t = dt + this.t;
    this.t = t;
    let W: TapeBuf;
    let wi: number;
    if (t < 1) {
      W = this.w;
      wi = W.count;
    } else {
      // period wrap: carry 3 history samples, store the wrap sample (count not incremented), swap
      const Wo = this.w;
      const Ro = this.r;
      const rc = Ro.count;
      const ws = Wo.s, wt = Wo.t, rs = Ro.s, rt = Ro.t;
      ws[9] = rs[rc + 9];
      wt[9] = rt[rc + 9] + -1.0;
      ws[8] = rs[rc + 8];
      wt[8] = rt[rc + 8] + -1.0;
      ws[7] = rs[rc + 7];
      wt[7] = rt[rc + 7] + -1.0;
      const wc = Wo.count;
      ws[wc + 10] = w;
      wt[wc + 10] = t;
      Wo.ridx = 0;
      t = t + -1.0;
      this.t = t;
      this.w = Ro;
      this.r = Wo;
      Ro.count = 0;
      W = Ro;
      wi = 0;
    }
    W.s[wi + 10] = w;
    W.t[wi + 10] = t;
    W.count = wi + 1;
    if (!this.wetFixed) {
      // wet glides one-pole at 0.01 per sample
      const ws = flush(fmaF(f32(this.wet - wetOld), 0.01, wetOld));
      if (ws === wetOld) this.wetFixed = true;
      this.wetS = ws;
    }
    const out = f32(wetOld * y);
    if (!this.invFixed) {
      // 1/delay glides one-pole at 0.005 per sample (double)
      const v = fmaD(this.invD - this.invDs, 0.005, this.invDs);
      if (v === this.invDs) this.invFixed = true;
      this.invDs = v;
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------------
// CChorus (chain+0x0; vtable 0x85c60, ctor 0x21fd8): three tapes fed with the mono sum; L gets
// voices 1+2, R gets 2+3; the wet is negative (-(w^2)) and added to the dry.

class Chorus {
  depth = 0; // +0x8 param f
  wet = 0; // +0xc stored wet (-(f^2); squared again by every SetSampleRate)
  rate = 0; // +0x10 param f
  en = false; // +0x14
  sr = 0; // +0x30
  t1!: Tape; // +0x18
  t2!: Tape; // +0x20
  t3!: Tape; // +0x28

  /** 0x222c0: recreates the tapes. QUIRK: squares the stored wet again (-(w^2) -> -(w^4)). */
  setSampleRate(sr: number): void {
    this.sr = sr;
    this.t1 = new Tape(toSize(sr * 0.021999999508261682), 0.0);
    this.t2 = new Tape(toSize(sr * 0.01707999961823225), 0.467);
    this.t3 = new Tape(toSize(sr * 0.019999999552965164), 0.778);
    this.wet = f32(this.wet * -this.wet);
    this.applyWet();
    this.applyRate();
    this.applyDepth();
    this.reset();
  }
  /** 0x22538 */
  reset(): void {
    this.t1.reset();
    this.t2.reset();
    this.t3.reset();
  }
  /** 0x221e0: each tape depth = f^3. */
  setDepth(f: number): void {
    this.depth = f;
    this.applyDepth();
  }
  /** 0x22250: stored wet = (-f) * f. */
  setWet(f: number): void {
    this.wet = f32(-f * f);
    this.applyWet();
  }
  /** 0x2212c: r = 5 f + 0.1 Hz; voice rates 0.896 r, r, 0.689 r. */
  setRate(f: number): void {
    this.rate = f;
    this.applyRate();
  }
  /** 0x22638: nothing is reset (off = frozen). */
  setEnable(f: number): void {
    this.en = f !== 0;
  }
  private applyDepth(): void {
    const f = this.depth;
    const d = f32(f32(f * f) * f);
    this.t1.setDepth(d);
    this.t2.setDepth(d);
    this.t3.setDepth(d);
  }
  private applyWet(): void {
    this.t1.setWet(this.wet);
    this.t2.setWet(this.wet);
    this.t3.setWet(this.wet);
  }
  private applyRate(): void {
    const r = fmaD(this.rate, 5, 0.1);
    this.t1.setRate(r * 0.896, this.sr);
    this.t2.setRate(r, this.sr);
    this.t3.setRate(r * 0.689, this.sr);
  }
  /** 0x22584 */
  process(L: Float32Array, R: Float32Array, off: number, end: number): void {
    if (!this.en) return;
    const t1 = this.t1, t2 = this.t2, t3 = this.t3;
    for (let i = off; i < end; i++) {
      const m = f32(R[i] + L[i]);
      const v1 = t1.process(m);
      const v3 = t3.process(m);
      const v2 = t2.process(m);
      L[i] = f32(f32(v2 + v1) + L[i]);
      R[i] = f32(f32(v2 + v3) + R[i]);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// CDelay (chain+0x38; vtable 0x87cb0, ctor 0x54d00): one tape per channel (2 s), feedback inside
// each tape; the output adds the wet tape to the dry.

class Delay {
  tL!: Tape; // +0x8 (t0 0, LFO 1 Hz)
  tR!: Tape; // +0x10 (t0 0.7, LFO 0.876 Hz)
  sr = 0; // +0x18
  time = 0.5; // +0x20
  stereo = 0; // +0x24
  fb = 0; // +0x28
  mod = 0; // +0x2c
  wet = 0; // +0x30
  on = false; // +0x34

  /** 0x55250: recreates the tapes (N = 2 sr), re-applies every param, resets. */
  setSampleRate(sr: number): void {
    this.sr = sr;
    const N = toSize(sr + sr);
    this.tL = new Tape(N, 0.0);
    this.tR = new Tape(N, 0.7);
    this.tL.setRate(1.0, sr);
    this.tR.setRate(0.876, sr);
    this.applyWet();
    this.applyMod();
    this.applyFeedback();
    this.applyTime();
    this.reset();
  }
  /** 0x54e64 */
  reset(): void {
    this.tL.reset();
    this.tR.reset();
  }
  /** 0x54ea0 */
  setTime(f: number): void {
    this.time = f;
    this.applyTime();
  }
  /** 0x5503c */
  setStereo(f: number): void {
    this.stereo = f;
    this.applyTime();
  }
  /** 0x55180 */
  setMod(f: number): void {
    this.mod = f;
    this.applyMod();
  }
  /** 0x5510c */
  setFeedback(f: number): void {
    this.fb = f;
    this.applyFeedback();
  }
  /** 0x551f8 */
  setWet(f: number): void {
    this.wet = f;
    this.applyWet();
  }
  /** 0x54e24: both tapes are reset on every call, in both directions. */
  setOn(f: number): void {
    this.on = f !== 0;
    this.reset();
  }
  /** 0x54f70: a = (0.95 time + 0.05)^2 / 2, b = (stereo - 0.5) a; tL = a + b, tR = a - b in [0.05, 1]. */
  private applyTime(): void {
    let a = fmaD(this.time, 0.95, 0.05);
    a = a * a;
    a = a * 0.5;
    const b = (this.stereo + -0.5) * a;
    this.tL.setTime(minnm(maxnm(b + a, 0.05), 1.0));
    this.tR.setTime(minnm(maxnm(a - b, 0.05), 1.0));
  }
  private applyMod(): void {
    const m = f32(f32(this.mod * this.mod) * 0.02);
    this.tL.setDepth(m);
    this.tR.setDepth(m);
  }
  private applyFeedback(): void {
    const v = f32(this.fb * 0.84);
    this.tL.setFeedback(v);
    this.tR.setFeedback(v);
  }
  private applyWet(): void {
    const v = f32(this.wet * this.wet);
    this.tL.setWet(v);
    this.tR.setWet(v);
  }
  /** 0x554b4 */
  process(L: Float32Array, R: Float32Array, off: number, end: number): void {
    if (!this.on) return;
    const tL = this.tL, tR = this.tR;
    for (let i = off; i < end; i++) {
      const a = tL.process(L[i]);
      L[i] = f32(L[i] + a);
      const b = tR.process(R[i]);
      R[i] = f32(R[i] + b);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Hpf2 (reverb input; ctor 0x61ec0, setup 0x61d64, process 0x61ee0, reset 0x61eb8): RBJ-like
// highpass whose a coefficient uses alpha = s/(2q) and b, c alpha = s/q (critically damped).

const SC = [0, 0];

class Hpf2 {
  // ctor 0x61ec0 values (0x7c8f0 / 0x7c930): (100 Hz, q 1, 44100) and its coefficients
  private f = 100;
  private q = 1;
  private sr = 44100;
  private a = f32(0.9928763508796692);
  private b = f32(-1.9717060327529907);
  private c = f32(0.9719060659408569);
  private x2 = 0;
  private x1 = 0;
  private y2 = 0;
  private y1 = 0;

  /** 0x61d64 (float args); returns early if (f, q, sr) are unchanged. */
  setup(f: number, q: number, sr: number): void {
    if (this.f === f && this.q === q && this.sr === sr) return;
    this.f = f;
    this.q = q;
    this.sr = sr;
    const w = f32((f * 6.283185307179586) / sr);
    sincosf(w, SC);
    const s = SC[0], co = SC[1];
    const sq = f32(s + q);
    const a = f32(f32(co + 1) / f32(f32(s / q) + 2));
    const b = f32(((q * -2.0) * co) / sq);
    const c = f32(f32(q - s) / sq);
    this.a = flush(a);
    this.b = flush(b);
    this.c = flush(c);
  }
  reset(): void {
    this.x2 = 0;
    this.x1 = 0;
    this.y2 = 0;
    this.y1 = 0;
  }
  process(inp: number): number {
    const x = flush(inp);
    const u = f32(f32(x - f32(this.x1 + this.x1)) + this.x2);
    const t = fmaf(this.y1, this.b, f32(this.y2 * this.c));
    const y = flush(fmaf(u, this.a, -t)); // fnmsub: u a - t
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

// ------------------------------------------------------------------------------------------------
// CReverb (chain+0x70; vtable 0x87610, ctor 0x41344 -> 0x411b8): per channel a Freeverb-like
// network (no input gain, no wet scaling) of 8 damped combs (summing the damped states) and 4
// allpasses (g 0.5) behind a 50 Hz Hpf2; dry + mix * wet. No cross-mix between channels.

/** Line lengths in seconds (double table 0x78080: L / R pairs interleaved); len = (int)(T * sr). */
const REV_T = [
  [0.025342403628117915, 0.03212698412698413, 0.02935827664399093, 0.03631746031746032, 0.032975056689342405,
    0.03968480725623583, 0.036342403628117914, 0.042827664399092975, 0.006210884353741497, 0.005238095238095238,
    0.0049387755102040815, 0.003616780045351474],
  [0.03033106575963719, 0.027138321995464853, 0.034346938775510205, 0.031328798185941045, 0.03796371882086168,
    0.034696145124716554, 0.04133106575963719, 0.037839002267573696, 0.006086167800453515, 0.005487528344671202,
    0.004439909297052154, 0.003866213151927438],
];

/** One channel network (12 lines {float* buf; float* ptr; int len; float st} + Hpf2 at +0x60). */
class RevNet {
  readonly hpf = new Hpf2();
  private readonly tab: number[];
  /** All 12 line buffers back to back; line j occupies [beg[j], end[j]). */
  private buf = new Float32Array(0);
  private readonly beg = new Int32Array(12);
  private readonly end = new Int32Array(12);
  private readonly ptr = new Int32Array(12);
  private readonly st = new Float32Array(12);

  constructor(tab: number[]) {
    this.tab = tab;
  }
  /** Part of 0x414e0: (re)allocate the lines for sr. */
  build(sr: number): void {
    let total = 0;
    for (let j = 0; j < 12; j++) {
      // fcvtzs; a length < 1 (sr below ~280 Hz) would be undefined in the binary: keep 1
      let len = Math.trunc(this.tab[j] * sr);
      if (!(len >= 1)) len = 1;
      this.beg[j] = total;
      total += len;
      this.end[j] = total;
    }
    this.buf = new Float32Array(total);
    this.reset();
  }
  /** 0x41048: st = 0, ptr = buf, zero the lines; Hpf2 reset. */
  reset(): void {
    this.buf.fill(0);
    this.st.fill(0);
    this.ptr.set(this.beg);
    this.hpf.reset();
  }
  /** 0x40b50 */
  process(x: Float32Array, off: number, end: number, mix: number, fbk: number, damp: number): void {
    const buf = this.buf, beg = this.beg, en = this.end, ptr = this.ptr, st = this.st, hpf = this.hpf;
    for (let i = off; i < end; i++) {
      const inp = hpf.process(x[i]);
      for (let j = 0; j < 8; j++) {
        // comb: st = flush(st + (o - st) damp); write st * fbk + in
        let p = ptr[j];
        if (!(p < en[j])) p = beg[j];
        const s0 = st[j];
        const s = flush(fmaf(f32(buf[p] - s0), damp, s0));
        st[j] = s;
        buf[p] = fmaf(s, fbk, inp);
        ptr[j] = p + 1;
      }
      // sum of the damped states, in the binary's order
      let v = f32(f32(f32(f32(st[0] + st[1]) + f32(st[2] + st[3])) + f32(f32(st[4] + st[5]) + st[6])) + st[7]);
      for (let j = 8; j < 12; j++) {
        // allpass g = 0.5: b = flush(*p); *p = (float)fma(b, 0.5, v) (b * 0.5 exact: one rounding); v = b - v
        let p = ptr[j];
        if (!(p < en[j])) p = beg[j];
        const bo = flush(buf[p]);
        buf[p] = f32(bo * 0.5 + v);
        ptr[j] = p + 1;
        v = f32(bo - v);
      }
      x[i] = f32(f32(v * mix) + x[i]);
    }
  }
}

class Reverb {
  // ctor 0x411b8 values: +0x8 mix 0.5, +0xc decay -0.9 (0x78070), +0x10 size 1, +0x14 off, +0x18 sr 44100
  mix = 0.5;
  decay = f32(-0.9);
  size = 1;
  en = false;
  sr = 44100;
  readonly nL = new RevNet(REV_T[0]); // +0x20
  readonly nR = new RevNet(REV_T[1]); // +0xa8

  constructor() {
    this.nL.hpf.setup(50, 1, 44100);
    this.nR.hpf.setup(50, 1, 44100);
    this.nL.build(44100);
    this.nR.build(44100);
  }
  /** 0x412c8: returns at once if sr is unchanged; else HPFs at (50 Hz, q 1, sr) and rebuild 0x414e0. */
  setSampleRate(sr: number): void {
    if (this.sr === sr) return;
    this.sr = sr;
    const s = f32(sr);
    this.nL.hpf.setup(50, 1, s);
    this.nR.hpf.setup(50, 1, s);
    this.nL.build(sr);
    this.nR.build(sr);
  }
  /** 0x416d4 */
  reset(): void {
    this.nL.reset();
    this.nR.reset();
  }
  /** 0x41494: comb feedback 0.3 + 0.67 c^(1/4), 0.3..0.97. */
  setDecay(f: number): void {
    const c = minnm(maxnm(f, 0), 1);
    this.decay = f32(fmaD(f32(Math.sqrt(f32(Math.sqrt(c)))), 0.67, 0.3));
  }
  /** 0x41444: comb damping coefficient min(0.2 + 0.8 c^(1/4), 1). */
  setSize(f: number): void {
    const c = minnm(maxnm(f, 0), 1);
    this.size = minnm(f32(fmaD(f32(Math.sqrt(f32(Math.sqrt(c)))), 0.8, 0.2)), 1);
  }
  /** 0x41408: mix 0.2 c^3. */
  setMix(f: number): void {
    const c = minnm(maxnm(f, 0), 1);
    this.mix = f32(f32(f32(c * c) * c) * 0.2);
  }
  /** 0x41780: both channel networks are reset on every call. */
  setEnable(f: number): void {
    this.en = f !== 0;
    this.reset();
  }
  /** 0x416fc */
  process(L: Float32Array, R: Float32Array, off: number, end: number): void {
    if (!this.en) return;
    this.nL.process(L, off, end, this.mix, this.decay, this.size);
    this.nR.process(R, off, end, this.mix, this.decay, this.size);
  }
}

// ------------------------------------------------------------------------------------------------
// EQ (chain+0x1a0; ctor 0x1ff58 -> 0x1fc54): 8 bands per channel in series, RBJ peaking / shelving
// biquads with A = 10^(dB/20) where RBJ uses 10^(dB/40) (so the applied gain is twice the dB).

const F005 = f32(0.05);

/** EQ band (0x3c bytes; ctor 0x626c4, setup 0x62398, process 0x62710, reset 0x626bc). */
class Band {
  x1 = 0; // +0x0
  x2 = 0; // +0x4
  y1 = 0; // +0x8
  y2 = 0; // +0xc
  b0 = 0; // +0x10 (normalized coefficients)
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  sr = 44100; // +0x24
  gain = 0; // +0x28 dB
  freq = 1000; // +0x2c
  bw = 1; // +0x30 octaves
  dirty = true; // +0x34
  type = 1; // +0x38: 0 low shelf, 1 peaking, 2 high shelf

  constructor() {
    this.setup(44100);
  }

  /** 0x62398 (sr float): recomputes only if dirty or sr changed. */
  setup(sr: number): void {
    if (this.sr !== sr) this.dirty = true;
    this.sr = sr;
    if (!this.dirty) return;
    this.dirty = false;
    const A = exp10f(f32(this.gain * F005));
    let w = f32((this.freq * 6.283185) / sr);
    w = minnm(w, 3);
    w = maxnm(w, 0);
    const d11 = (this.bw * 0.3465736) * w;
    const sn = sinf(w);
    const sh2 = f32(Math.sinh(d11 / sn) * 2);
    const s11 = f32(f32(Math.sqrt(A)) * sh2);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    if (this.type === 1) {
      // peaking
      const al = f32(f32(sh2 * 0.5) * sn);
      const s12 = f32(al / A);
      a0 = f32(s12 + 1);
      const s8 = f32(al * A);
      b0 = f32(s8 + 1);
      const co = cosf(w);
      a1 = b1 = f32(co * -2);
      b2 = f32(1 - s8);
      a2 = f32(1 - s12);
    } else if (this.type === 0) {
      // low shelf
      const p1 = f32(A + 1), m1 = f32(A + -1), co = cosf(w);
      const s2 = fmaf(A, co, -co), s3 = f32(s2 + p1), s4 = f32(sn * s11);
      a0 = f32(s3 + s4);
      b0 = f32(f32(f32(p1 - s2) + s4) * A);
      const s5 = fmaf(A, co, co);
      let t = f32(m1 - s5);
      t = f32(t + t);
      b1 = f32(A * t);
      b2 = f32(f32(p1 - f32(s4 + s2)) * A);
      a1 = f32(f32(s5 + m1) * -2);
      a2 = f32(s3 - s4);
    } else if (this.type === 2) {
      // high shelf
      const p1 = f32(A + 1), m1 = f32(A + -1), co = cosf(w);
      const s3 = fmaf(A, co, -co), s2 = f32(s3 + p1), s4 = f32(sn * s11);
      b0 = f32(f32(s2 + s4) * A);
      const s5 = fmaf(A, co, co);
      b1 = f32(f32(A * -2) * f32(s5 + m1));
      b2 = f32(f32(s2 - s4) * A);
      a0 = f32(f32(p1 - s3) + s4);
      const t = f32(m1 - s5);
      a1 = f32(t + t);
      a2 = f32(p1 - f32(s4 + s3));
    } else {
      return; // unreachable: the EQ only uses types 0..2
    }
    const r = f32(1 / a0);
    this.b0 = flush(f32(b0 * r));
    this.b1 = flush(f32(b1 * r));
    this.b2 = flush(f32(b2 * r));
    this.a1 = flush(f32(a1 * r));
    this.a2 = flush(f32(a2 * r));
  }

  reset(): void {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  process(x: Float32Array, off: number, end: number): void {
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    let x1 = this.x1, x2 = this.x2, y1 = this.y1, y2 = this.y2;
    for (let i = off; i < end; i++) {
      const xi = flush(x[i]);
      const p1 = f32(b1 * x1), p2 = f32(b2 * x2), q1 = f32(a1 * y1), q2 = f32(a2 * y2);
      const s = f32(fmaf(b0, xi, p1) + p2);
      const q = f32(q1 + q2);
      const y = flush(f32(s - q));
      x2 = x1;
      x1 = xi;
      y2 = y1;
      y1 = y;
      x[i] = y;
    }
    this.x1 = x1;
    this.x2 = x2;
    this.y1 = y1;
    this.y2 = y2;
  }
}

const EQ_FREQ = [62.5, 125, 250, 500, 1000, 2000, 4000, 8000];

class Eq {
  /** L band k at eq + k*0x3c, R band k at eq + 0x1e0 + k*0x3c. */
  readonly bL: Band[] = [];
  readonly bR: Band[] = [];
  sr = 0; // +0x3c0 (double)
  en = false; // +0x3c8

  constructor() {
    // 0x1fc54: band ctors, then 62.5 Hz .. 8 kHz, 1 octave; band 0 low shelf, band 7 high shelf
    for (let k = 0; k < 8; k++) this.bL.push(Eq.layout(new Band(), k));
    for (let k = 0; k < 8; k++) this.bR.push(Eq.layout(new Band(), k));
  }
  private static layout(B: Band, k: number): Band {
    if (B.freq !== EQ_FREQ[k]) B.dirty = true;
    B.freq = EQ_FREQ[k];
    const type = k === 0 ? 0 : k === 7 ? 2 : 1;
    if (B.type !== type) B.dirty = true;
    B.type = type;
    return B;
  }
  /** 0x1ff5c: setup every band at (float)sr, then reset. */
  setSampleRate(sr: number): void {
    this.sr = sr;
    const s = f32(sr);
    for (let k = 0; k < 8; k++) {
      this.bL[k].setup(s);
      this.bR[k].setup(s);
    }
    this.reset();
  }
  /** 0x20078 */
  reset(): void {
    for (let k = 0; k < 8; k++) {
      this.bL[k].reset();
      this.bR[k].reset();
    }
  }
  /** 0x2010c: gain dB = (24 f - 12) |2 f - 1| into L and R band k. */
  setBand(k: number, f: number): void {
    let u = f + f;
    u = u + -1.0;
    if (u < 0) u = -u;
    const g = f32(fmaD(f, 24, -12) * u);
    const s = f32(this.sr);
    const bl = this.bL[k], br = this.bR[k];
    if (bl.gain !== g) bl.dirty = true;
    bl.gain = g;
    if (br.gain !== g) br.dirty = true;
    br.gain = g;
    bl.setup(s);
    br.setup(s);
  }
  /** 0x205b4: disabling resets every band state. */
  setEnable(f: number): void {
    this.en = f !== 0;
    if (!this.en) this.reset();
  }
  /** 0x201b0: all 8 bands always run (a flat band is not bit-transparent). */
  process(L: Float32Array, R: Float32Array, off: number, end: number): void {
    if (!this.en) return;
    for (let k = 0; k < 8; k++) {
      this.bL[k].process(L, off, end);
      this.bR[k].process(R, off, end);
    }
  }
}

// ------------------------------------------------------------------------------------------------

/** Morphine's master effects chain (FL params 6..29). */
export class MorFx {
  private readonly ch = new Chorus();
  private readonly dl = new Delay();
  private readonly rv = new Reverb();
  private readonly eq = new Eq();
  private target = 0; // +0x570 overdrive target drive 16 f^3
  private drive = 0; // +0x574 smoothed drive
  /** Overdrive glide at a fixed point (not FL state: skips the step; also used by active()). */
  private odSettled = true;
  /** Make-up gain cache for the last drive value (not FL state). */
  private gS = NaN;
  private gV = 0;

  /** Chain ctor 0x5270 + SetSampleRate 0x5304 (an invalid sr builds at 44100: the tapes must exist). */
  constructor(sr: number) {
    this.setSampleRate(sr > 0 ? sr : 44100);
  }

  /**
   * Fx_Chain_SetSampleRate 0x5304 (sr stored at chain+0x578): each effect's SetSampleRate (the chorus
   * recreates its tapes and squares its stored wet again, the delay recreates its tapes, the reverb
   * rebuilds only if sr changed, the EQ recomputes its bands), then the chain reset 0x53a0. sr <= 0
   * only resets, as CMorSynth::SetSampleRate 0x713f4 does for 0. May allocate.
   */
  setSampleRate(sr: number): void {
    if (!(sr > 0)) {
      this.reset();
      return;
    }
    this.ch.setSampleRate(sr);
    this.dl.setSampleRate(sr);
    this.rv.setSampleRate(sr);
    this.eq.setSampleRate(sr);
    this.reset();
  }

  /** Fx_Chain_Reset 0x53a0: every effect's state cleared, smoothed drive = target. */
  reset(): void {
    this.ch.reset();
    this.dl.reset();
    this.rv.reset();
    this.eq.reset();
    this.drive = this.target;
    // drive == target is a fixed point of the glide unless the step's flush changes it (0 < target < 1e-9)
    this.odSettled = flush(this.drive) === this.drive;
  }

  /** Synth_OnParamChanged 0x70664 for FL params 6..29; f = the plugin's stored float (0..1). */
  setParam(index: number, f: number): void {
    f = f32(f);
    switch (index) {
      case 6: {
        // 0x57dc: target drive = (f f) (16 f)
        const t = f32(f32(f * f) * f32(16 * f));
        if (t !== this.target) this.odSettled = false;
        this.target = t;
        break;
      }
      case 7: this.ch.setDepth(f); break;
      case 8: this.ch.setWet(f); break;
      case 9: this.ch.setRate(f); break;
      case 10: this.ch.setEnable(f); break;
      case 11: this.dl.setTime(f); break;
      case 12: this.dl.setStereo(f); break;
      case 13: this.dl.setMod(f); break;
      case 14: this.dl.setFeedback(f); break;
      case 15: this.dl.setWet(f); break;
      case 16: this.dl.setOn(f); break;
      case 17: this.rv.setDecay(f); break;
      case 18: this.rv.setSize(f); break;
      case 19: this.rv.setMix(f); break;
      case 20: this.rv.setEnable(f); break;
      case 21: case 22: case 23: case 24: case 25: case 26: case 27: case 28:
        this.eq.setBand(index - 21, f);
        break;
      case 29: this.eq.setEnable(f); break;
      default: break;
    }
  }

  /** Fx_Chain_Process 0x53ec, in place on L / R [off, off + n). */
  process(L: Float32Array, R: Float32Array, off: number, n: number): void {
    if (n < 1) return;
    const end = off + n;
    this.overdrive(L, R, off, end);
    this.ch.process(L, R, off, end);
    this.dl.process(L, R, off, end);
    this.rv.process(L, R, off, end);
    this.eq.process(L, R, off, end);
  }

  /** True when process() can change the signal or its own future output (an effect is on, the drive is above the bypass threshold, or the drive glide is still moving). */
  active(): boolean {
    return this.ch.en || this.dl.on || this.rv.en || this.eq.en || this.drive > 0.01 || this.target > 0.01 || !this.odSettled;
  }

  /** Rough tail length in seconds after the input goes silent (to stop rendering silence; not FL behaviour). */
  tailSeconds(): number {
    const LN_FLOOR = Math.log(1e-4); // -80 dB
    let t = 0;
    if (this.eq.en) t += 0.1;
    if (this.ch.en) t += 0.05;
    if (this.dl.on) {
      let a = this.dl.time * 0.95 + 0.05;
      a = a * a * 0.5;
      const b = (this.dl.stereo - 0.5) * a;
      const d = 2 * Math.min(Math.max(Math.abs(b) + a, 0.05), 0.99) + 0.01; // ~2 t seconds
      const fb = this.dl.fb * 0.84;
      t += d * (1 + (fb > 1e-6 ? LN_FLOOR / Math.log(fb) : 0));
    }
    if (this.rv.en) {
      // comb loop gain |decay| (the ctor value is -0.9) per <= 43 ms loop, plus the allpasses
      const g = Math.abs(this.rv.decay);
      t += 0.043 * (g > 1e-6 && g < 1 ? LN_FLOOR / Math.log(g) : 1) + 0.02;
    }
    return Math.min(t, 60);
  }

  /** 0x55dc: drive one-pole at 0.01 per sample (runs when bypassed); odd curve when drive > 0.01. */
  private overdrive(L: Float32Array, R: Float32Array, off: number, end: number): void {
    const tgt = this.target;
    let s = this.drive;
    let settled = this.odSettled;
    for (let i = off; i < end; i++) {
      if (!settled) {
        // the step is a pure function of (target, drive): once it returns its input it stays put
        const ns = flush(fmaF(f32(tgt - s), 0.01, s));
        if (ns === s) settled = true;
        s = ns;
      }
      if (s <= 0.01) continue;
      const xl = flush(L[i]), xr = flush(R[i]);
      let yl: number, yr: number, e: number;
      // x < 0: (1 + x) 10^(x s) - 1; x >= 0: 1 - (1 - x) 10^(-x s) (x e exact in double: fma == a * b + c)
      if (xl < 0) {
        e = exp10f(f32(xl * s));
        yl = (xl * e + e) + -1.0;
      } else {
        e = exp10f(f32(xl * -s));
        yl = (xl * e - e) + 1.0;
      }
      if (xr >= 0) {
        e = exp10f(f32(xr * -s));
        yr = (xr * e - e) + 1.0;
      } else {
        e = exp10f(f32(xr * s));
        yr = (xr * e + e) + -1.0;
      }
      // make-up g = 0.3 + 0.7 (1 - s/16)^8, float (s * -0.0625 is exact)
      if (s !== this.gS) {
        let g1 = f32(s * -0.0625 + 1.0);
        g1 = f32(g1 * g1);
        g1 = f32(g1 * g1);
        g1 = f32(g1 * g1);
        this.gV = f32(fmaD(g1, 0.7, 0.3));
        this.gS = s;
      }
      const g = this.gV;
      L[i] = f32(yl * g);
      R[i] = f32(yr * g);
    }
    this.drive = s;
    this.odSettled = settled;
  }
}
