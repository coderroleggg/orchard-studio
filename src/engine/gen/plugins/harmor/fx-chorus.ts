// Harmor's global CHORUS effect (FX unit id 1): a bit-exact port of FL Studio
// Harmor's TStereoFlanger (FL 2026 Harmor_x64, arm64 slice; every address below
// is a file offset in that slice).
//
// FL code ported:
//   unit                0xeab40  bus 0 in chunks of min(rest, 384) frames: with the
//                                object and plug+0x295c > 0 ("tail active"): ring write
//                                0x468c00, render through the method pointer obj+0x60
//                                (= 0x468f70, installed by the constructor, never changed)
//                                into REND+0x20, bus *= dry (ippsMulC_32f_I, skipped when
//                                dry is exactly 1.0f), bus += wet (ippsAdd_32f_I); with the
//                                tail inactive only 0x468ba0 (phase += m * inc per voice)
//   deferred updater    0xea490  (chorus part) params 804..810 -> object fields, dry /
//                                wet law, 0x468430(obj, 384, sr); order <= 0 frees the object
//                                (0x765b0 FreeAndNil), order > 0 creates it when missing
//                                (constructor 0x468210: fresh state)
//   flanger update      0x468430  voice setup (helpers 0x468ac0, nested lerp 0x468a70), buffer
//                                sizing 0x4617f0 / 0x461740, reset 0x468b30 (+ VMT+0xc8 =
//                                0x461700: zero the ring)
//   render              0x468f70  voice 0 by 0x468ce0 (stores), voices 1..high by 0x468e20
//                                (adds), then the read pointer advances by m frames
//   reset               0xc6490 (FL's flush / state-load reset) calls 0x468b30 on the object
//   table               0x9049f8  20 float32 per-voice factors
//
// Algorithm. order k (1..9) gives 2k voices: voices 0..k-1 read the input's left channel
// (initial LFO phase 0, output gains L = 1, R = cross s), voices k..2k-1 the right channel
// (initial phase 2^31, gains L = cross s, R = 1), with s = 1 - j/k for the voice's rank j
// (0 = outermost). Per voice (float32 unless noted, ratio = f32(44100/sr)):
//   depthS = f32(f32(exp(depth ln11) - 1) * 109.25)       (0x468ac0, depth = p805 / 1024)
//   delayS = f32(f32(exp(delay ln11) - 1) * 441)          (delay = p807 / 128)
//   rateK  = 2^31 / (50000 + 75000 f32(exp((1 - speed) ln101) - 1)) * 500      (double)
//   st     = f32((exp(spread ln1001) - 1) / 1000), lerp(a, b) = a st + b f32(1 - st) (double)
//   q      = f32(lerp(table[i % 20]^2, 1))                 (table: 20 floats near 1, two near 0.1)
//   b0     = f32(10 + depthS s);  base = b0 / ratio        (LFO swing in samples)
//   inc    = round(lerp(rateK q / b0, rateK / f32(10 + depthS)) ratio)   (int32 phase step,
//            2^32 = one LFO cycle: the deeper the voice, the slower its LFO)
//   center = base + max(f32(lerp(delayS s q, delayS)) / ratio, 8)
//   phase0 = (round(s st 2^23) << 8) + (0 left | 2^31 right);  A = sqrt(4 base)
//   gains *= mix_wet * (1 - (1001^(1 - 1/sum|gains|) - 1) / 1000)
// The ring holds the input (interleaved stereo, 384 + round(max(center + base)) + 8 frames;
// tail = that length). Per sample and voice: x = f32(phase) A 2^-31, t = |x| - A/2 (a
// triangle), phase += inc, d = t (A - |t|) + center (a parabolic sine, swing +-base),
// i = round(d) (ties to even), fr = d - i, y = r[-i] + fr (r[-i-1] - r[-i]) (linear
// interpolation, extrapolating when fr < 0, as FL does), out += y * gain per channel.
// Mix: m = f32(|p810| 0.001f); dry = f32(1 - f32(f32(5^m - 1) 0.25)); wet = sign(p810) *
// f32(1 - f32(f32(5^(1-m) - 1) 0.25)). Output = f32(f32(bus dry) + wet sum).
// A spread change or a ring size change resets the phases to phase0 and clears the ring;
// growing the voice array without a reset starts the new voices at phase 0 (FPC SetLength
// zero-fills), as in FL.
//
// Exactness: FL's operation order and precision throughout (float32 via Math.fround where
// FL uses float32, double where FL uses double; no FMA: FL uses separate fmul / fadd).
// Checked bit for bit against FL's own machine code: (1) Harmor's dylib loaded in a test
// harness calling 0xea490 / 0xeab40 / 0x468b30 directly (700 random scenarios with parameter
// changes, resets, tail on / off and odd block sizes at 22.05..192 kHz, every value of every
// parameter at 44.1 / 48 / 96 kHz, renders of up to 60 s): voice records, ring offsets, tail
// length and every output sample equal; (2) FL test host renders (chorus on vs. the FX-off
// render fed through this class, FL's blocks and tail flag, automation of order / spread /
// mix / delay including free and re-create, 22.05..96 kHz, blocks 37..1024): every sample equal.
// exp is fx-libm's port of macOS libm exp (FL's 0xbc00 stub), equal to libm on all 6623
// arguments the chorus laws can produce (V8's Math.exp differs on 634 of them by 1 ulp in
// double, though none of those would change a float32 result).
//
// Deviations (none audible, none reachable from FL's controls):
// - raw parameters are clamped to the controls' ranges (order 0..9, depth / speed 0..1024,
//   delay / spread 0..128, cross -128..128, mix -1000..1000) so that the preallocated voice
//   and ring buffers always suffice; FL's code does not clamp (its controls never exceed them).
// - FL reads FPCR as set by its host: if the host enables flush-to-zero, denormal results
//   (|x| < 2^-126) would be flushed in FL; JavaScript keeps them.
// - The tail base (plug+0x2958 = round((30 or 530 ms) sr), 0xea490's first lines) and the
//   rebuild flag plug+0x2960 belong to the FX chain (fx.ts); this class reports only the
//   chorus's own contribution (tailSamples).

import { exp } from './fx-libm';

const F = Math.fround;

/** FL's 20 per-voice factors (0x9049f8). */
const TABLE = new Float32Array(new Uint32Array([
  0x3f778d50, 0x3f84fdf4, 0x3f82b021, 0x3dcf7660, 0x3f7a1cac, 0x3f843958, 0x3f7f3b64, 0x3f789375, 0x3f87ced9, 0x3f726e98,
  0x3f83f7cf, 0x3dcea4a9, 0x3f881062, 0x3f73f7cf, 0x3f7db22d, 0x3f8645a2, 0x3f7ba5e3, 0x3f86872b, 0x3f826e98, 0x3f88d4fe,
]).buffer);

/** FL's chunk / the ring's extra length (0xeab40: 0x180, 0xea490 passes 0x180 to 0x468430). */
const CHUNK = 384;
const MAX_ORDER = 9;
const MAXV = 2 * MAX_ORDER;

const LN11 = 2.3978952727983707; // 0x5c0920
const LN101 = 4.6151205168412597; // 0x5c08b8
const LN1001 = 6.9087547793152204; // 0x5c08e8
const LN5 = 1.6094379124341003; // 0x5719c8
const F0001 = F(0.001); // 0x8f6e9c (float32)
const INV2P31 = 4.6566128730773926e-10; // 0x5c0910, 2^-31 (double)

/** frintx (round to nearest, ties to even) + fcvtzs, low 32 bits (FPC Round). */
function rne32(x: number): number {
  let r = Math.round(x);
  if (r - x === 0.5 && (r & 1) !== 0) r -= 1;
  return r | 0;
}

/** 0x468ac0: f32(f32(exp(x ln11) - 1) * f32(scale / 10)). */
function law11(x: number, scale: number): number {
  return F(F(exp(x * LN11) - 1) * F(scale / 10));
}

function clampI(v: number, lo: number, hi: number): number {
  v |= 0;
  return v < lo ? lo : v > hi ? hi : v;
}

export class HarmorChorus {
  private readonly sr: number;
  /** plug+0x2968 exists. */
  private exists = false;
  // TStereoFlanger fields (offsets in FL's object)
  private order = 4; // +0x38
  private depth = 1; // +0x3c
  private speed = 1; // +0x40
  private delay = 0; // +0x44
  private spread = 0; // +0x48
  private cross = 1; // +0x4c
  private mix = 1; // +0x50 (wet gain after 0xea490)
  private lastSpread = 0; // +0x30
  private size = 0; // +0x28 ring size in bytes (8 per frame, +0x2c)
  private len = 0; // +0x54
  /** Length of FL's voice dynamic array (+0x58; high = nv - 1 at +0x34). */
  private nv = 0;
  // voice records (0x2c bytes each in FL)
  private readonly vBase = new Float32Array(MAXV); // +0x00 (kept for inspection; render uses A / center)
  private readonly vGL = new Float32Array(MAXV); // +0x04
  private readonly vGR = new Float32Array(MAXV); // +0x08
  private readonly vCenter = new Float32Array(MAXV); // +0x0c
  private readonly vPhase = new Int32Array(MAXV); // +0x10
  private readonly vPhase0 = new Int32Array(MAXV); // +0x14
  private readonly vInc = new Int32Array(MAXV); // +0x18
  private readonly vCh = new Int32Array(MAXV); // +0x1c / 4 (0 = left, 1 = right input)
  private readonly vScale = new Float32Array(MAXV); // +0x20
  private readonly vA = new Float32Array(MAXV); // +0x24
  private readonly vHalfA = new Float32Array(MAXV); // +0x28
  /** The ring (interleaved stereo); FL's buffer is the first ringN floats. */
  private readonly ring: Float32Array;
  private ringN = 0;
  /** Read (+0x10) and write (+0x18) positions as float indices into the ring. */
  private rd = 0;
  private wr = 0;
  /** plug+0x2970. */
  private dry = 1;
  /** REND+0x20 (one chunk). */
  private readonly wet = new Float32Array(2 * CHUNK);

  constructor(sampleRate: number, maxBlock: number) {
    void maxBlock; // FL chunks by 384 frames whatever the block size
    this.sr = sampleRate | 0;
    // largest ring for the controls' ranges: max(center + base) <= (2 * 1102.5 + 4410 * 1.069^2) / ratio + 8
    const ratio = F(44100 / this.sr);
    const maxD = (2 * 1102.5 + 4410 * 1.1428) / ratio + 8;
    const frames = CHUNK + Math.ceil(maxD * 1.001) + 16;
    this.ring = new Float32Array(2 * frames);
  }

  /** The chorus object exists (order > 0 at the last update). */
  get active(): boolean {
    return this.exists;
  }

  /** The chorus's tail contribution obj[+0x28] / obj[+0x2c] (frames), 0 without the object. */
  get tailSamples(): number {
    return this.exists ? (this.size / 8) | 0 : 0;
  }

  /** FL's 0xea490 (chorus part): raw = Harmor's 825 plug parameters. */
  update(raw: Int32Array, tempo: number): void {
    void tempo;
    const order = clampI(raw[804], 0, MAX_ORDER);
    if (order <= 0) {
      this.exists = false; // FreeAndNil(plug+0x2968)
      return;
    }
    if (!this.exists) this.create();
    this.order = order;
    this.depth = F(clampI(raw[805], 0, 1024) * 0.0009765625);
    this.speed = F(clampI(raw[806], 0, 1024) * 0.0009765625);
    this.delay = F(clampI(raw[807], 0, 128) * 0.0078125);
    this.spread = F(clampI(raw[808], 0, 128) * 0.0078125);
    this.cross = F(clampI(raw[809], -128, 128) * 0.0078125);
    const mx = clampI(raw[810], -1000, 1000);
    const m = F(F(mx < 0 ? -mx : mx) * F0001);
    this.dry = F(1 - F(F(exp(m * LN5) - 1) * 0.25));
    const sgn = mx === 0 ? 0 : mx < 0 ? -1 : 1;
    this.mix = F(sgn * F(1 - F(F(exp(F(1 - m) * LN5) - 1) * 0.25)));
    this.flangerUpdate();
  }

  /** FL's 0xeab40 on bus 0 (interleaved stereo, n frames, in place). */
  process(bus: Float32Array, n: number, tailActive: boolean): void {
    let pos = 0;
    let rest = n;
    while (rest > 0) {
      const m = rest > CHUNK ? CHUNK : rest;
      if (this.exists) {
        if (tailActive) {
          this.ringWrite(bus, pos, m);
          this.render(m);
          const o = 2 * pos;
          const w = this.wet;
          const dry = this.dry;
          if (dry !== 1) for (let j = 0; j < 2 * m; j++) bus[o + j] = bus[o + j] * dry;
          for (let j = 0; j < 2 * m; j++) bus[o + j] = w[j] + bus[o + j];
        } else {
          // 0x468ba0
          for (let k = 0; k < this.nv; k++) this.vPhase[k] = (this.vPhase[k] + Math.imul(m, this.vInc[k])) | 0;
        }
      }
      rest -= m;
      pos += m;
    }
  }

  /** FL's reset (0xc6490 -> 0x468b30): phases back to their start values, ring cleared. */
  reset(): void {
    if (this.exists) this.resetState();
  }

  // ------------------------------------------------------------ FL internals

  /** 0x468210: a fresh TStereoFlanger (the updater overwrites the parameter fields). */
  private create(): void {
    this.exists = true;
    this.order = 4;
    this.depth = 1;
    this.speed = 1;
    this.delay = 0;
    this.spread = 0;
    this.cross = 1;
    this.mix = 1;
    this.lastSpread = 0;
    this.size = 0;
    this.len = 0;
    this.nv = 0;
    this.ringN = 0;
    this.rd = 0;
    this.wr = 0;
  }

  /** 0x468b30 (+ 0x461700): phase := phase0 for every voice, zero the ring. */
  private resetState(): void {
    for (let k = 0; k < this.nv; k++) this.vPhase[k] = this.vPhase0[k];
    this.ring.fill(0, 0, this.ringN);
  }

  /** 0x468430(obj, 384, sr). */
  private flangerUpdate(): void {
    if (this.order < 1) this.order = 1;
    const order = this.order;
    const depthS = law11(this.depth, 1092.5);
    const e1 = F(exp(F(1 - this.speed) * LN101) - 1);
    const rateK = (2147483648 / (50000 + e1 * 75000)) * 500;
    const delayS = law11(this.delay, 4410);
    const st = F(0 + F(F(F(exp(this.spread * LN1001) - 1) / 1000) * 1));
    const ost = F(1 - st);
    let maxD = 0;
    let gsum = 0;
    const nv = order * 2;
    if (nv !== this.nv) {
      for (let k = this.nv; k < nv; k++) this.vPhase[k] = 0; // SetLength zero-fills new records
      this.nv = nv;
    }
    const high = nv - 1;
    const ratio = F(44100 / this.sr);
    const fo = F(order);
    for (let i = 0; i <= high; i++) {
      let s8: number;
      let ch: number;
      let ph0: number;
      if (order > i) {
        s8 = i;
        ch = 0;
        ph0 = 0;
      } else {
        s8 = high - i;
        ch = 1;
        ph0 = -0x80000000;
      }
      s8 = F(1 - F(s8 / fo));
      const t9 = TABLE[i % 20];
      const s9 = F(F(t9 * t9) * st + 1 * ost);
      let gL = 1;
      let gR = F(this.cross * s8);
      if (ch > 0) {
        const t = gL;
        gL = gR;
        gR = t;
      }
      gsum = F(F(gsum + Math.abs(gL)) + Math.abs(gR));
      let base = F(10 + F(depthS * s8));
      const d11 = rateK / F(10 + depthS);
      const d13 = (rateK * s9) / base;
      const rate = d13 * st + d11 * ost;
      const c0 = F(F(delayS * s8) * s9);
      let center = F(c0 * st + delayS * ost);
      const p = rne32(F(F(F(s8 * st) * 2147483648) * 0.00390625));
      this.vPhase0[i] = ((p << 8) + ph0) | 0;
      this.vInc[i] = rne32(rate * ratio);
      base = F(base / ratio);
      let c = F(center / ratio);
      if (!(c > 8)) c = 8;
      center = F(base + c);
      const s1 = F(center + base);
      maxD = maxD > s1 ? maxD : s1;
      const A = F(Math.sqrt(F(F(base * 2) * 2)));
      this.vBase[i] = base;
      this.vCenter[i] = center;
      this.vGL[i] = gL;
      this.vGR[i] = gR;
      this.vCh[i] = ch;
      this.vScale[i] = F(A * INV2P31);
      this.vA[i] = A;
      this.vHalfA[i] = F(A * 0.5);
    }
    const s0 = F(1 - F(1 / gsum));
    const g = F(F(1 - F(F(exp(s0 * LN1001) - 1) / 1000)) * this.mix);
    for (let i = 0; i <= high; i++) {
      this.vGL[i] = F(this.vGL[i] * g);
      this.vGR[i] = F(this.vGR[i] * g);
    }
    this.len = (rne32(maxD) + 8) | 0;
    // 0x4617f0(obj, 384, len)
    const ln = this.len < 1 ? 1 : this.len;
    const bytes = 8 * (CHUNK + ln);
    const changed = bytes !== this.size;
    if (changed) {
      // 0x461740: ReAllocMem + clear, read = start, write = read + len frames
      if (bytes / 4 > this.ring.length) throw new Error('HarmorChorus: ring too small');
      this.size = bytes;
      this.ringN = bytes / 4;
      this.ring.fill(0, 0, this.ringN);
      this.rd = 0;
      this.wr = 2 * ln;
    }
    if (changed || this.spread !== this.lastSpread) {
      this.rd = this.wr;
      this.resetState();
      this.lastSpread = this.spread;
    }
  }

  /** 0x468c00: copy m input frames into the ring at the write position. */
  private ringWrite(bus: Float32Array, pos: number, m: number): void {
    const ring = this.ring;
    const N = this.ringN;
    let wr = this.wr;
    let src = 2 * pos;
    let rest = m;
    const room = (N - wr) >> 1;
    if (rest > room) {
      for (let j = 0; j < 2 * room; j++) ring[wr + j] = bus[src + j];
      wr = 0;
      rest -= room;
      src += 2 * room;
    }
    if (rest > 0) {
      for (let j = 0; j < 2 * rest; j++) ring[wr + j] = bus[src + j];
      wr += 2 * rest;
    }
    if (wr >= N) wr = 0;
    this.wr = wr;
  }

  /** 0x468f70: all voices into wet (voice 0 stores, the others add), then read += m frames. */
  private render(m: number): void {
    const ring = this.ring;
    const N = this.ringN;
    const wet = this.wet;
    for (let k = 0; k < this.nv; k++) {
      const scale = this.vScale[k];
      const halfA = this.vHalfA[k];
      const A = this.vA[k];
      const center = this.vCenter[k];
      const gL = this.vGL[k];
      const gR = this.vGR[k];
      const inc = this.vInc[k];
      let ph = this.vPhase[k];
      let src = this.rd + this.vCh[k];
      for (let j = 0; j < m; j++) {
        const x = F(F(ph) * scale);
        const t = F(Math.abs(x) - halfA);
        ph = (ph + inc) | 0;
        const d = F(F(t * F(A - Math.abs(t))) + center);
        let i = Math.round(d);
        if (i - d === 0.5 && (i & 1) !== 0) i -= 1;
        i |= 0;
        const fr = F(d - i);
        let a = src - 2 * i;
        if (a < 0) a += N;
        const r0 = ring[a];
        a -= 2;
        if (a < 0) a += N;
        const y = F(r0 + F(fr * F(ring[a] - r0)));
        src += 2;
        if (src > N) src -= N;
        if (k === 0) {
          wet[2 * j] = y * gL;
          wet[2 * j + 1] = y * gR;
        } else {
          wet[2 * j] = wet[2 * j] + F(y * gL);
          wet[2 * j + 1] = wet[2 * j + 1] + F(y * gR);
        }
      }
      this.vPhase[k] = ph;
    }
    let rd = this.rd + 2 * m;
    while (rd >= N) rd -= N;
    this.rd = rd;
  }
}
