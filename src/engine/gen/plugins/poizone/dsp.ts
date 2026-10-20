// PoiZone DSP building blocks, ported from FL 2026's PoiZone engine library
// (Image-Line's C++ plug-in framework shared with Sawer): float32 arithmetic
// emulated with Math.fround, fused multiply-adds as the arm64 code computes
// them, double precision where the original uses doubles.
// - PzEnv: the ADSR (doubles; exponential curves 1 - (1 - x) 10^(c x)),
//   evaluated once per block at the block's end;
// - PzLfo: the LFO (saw, pulse, triangle, sine, sample & hold; free or tempo
//   synced), advanced once per block;
// - PzTape: CTapeDelay, the variable-speed "tape" delay line behind the delay
//   and the chorus: samples are written with their tape position, the read
//   head plays the position one tape length behind (linear interpolation),
//   delay-time changes glide the tape speed, a smoothstep-shaped triangle LFO
//   modulates the speed, feedback through 2-pole high / low cuts;
// - PzDelay: the stereo delay (two tapes, times in quarter beats);
// - PzChorus: three modulated tapes fed with the mono sum;
// - PzShelf: the RBJ shelving biquad on the output (+5 dB above 12 kHz).

import { cosf, sinf, sincosf, exp2f, exp10f } from './applemath';

export const f32 = Math.fround;
const SC = [0, 0];
/** float fused multiply-add: a * b + c (one rounding). */
export const fma = (a: number, b: number, c: number): number => f32(a * b + c);
/** float fused c - a * b (arm64 fmsub). */
export const fms = (a: number, b: number, c: number): number => f32(c - a * b);
/** float fused a * b - c (arm64 fnmsub). */
export const fnms = (a: number, b: number, c: number): number => f32(a * b - c);

const SPLIT = 134217729; // 2^27 + 1
const ROV = new DataView(new ArrayBuffer(8));
/** x + y rounded to odd (exact sum if representable, else the neighbour with an odd last bit). */
function addRO(x: number, y: number): number {
  const s = x + y;
  const bb = s - x;
  const e = (x - (s - bb)) + (y - bb);
  if (e === 0 || !Number.isFinite(s)) return s;
  ROV.setFloat64(0, s);
  const lo = ROV.getUint32(4);
  if ((lo & 1) !== 0) return s;
  // even and inexact: step one ulp towards the exact value
  const up = (e > 0) === (s > 0);
  let hi = ROV.getUint32(0), l = lo;
  if (up) { l = (l + 1) >>> 0; if (l === 0) hi = (hi + 1) >>> 0; }
  else { if (l === 0) hi = (hi - 1) >>> 0; l = (l - 1) >>> 0; }
  ROV.setUint32(0, hi); ROV.setUint32(4, l);
  return ROV.getFloat64(0);
}
/** double fused multiply-add a * b + c, correctly rounded (exact product and sums, round-to-odd before the last rounding). */
export function fmaD(a: number, b: number, c: number): number {
  const p = a * b;
  if (!Number.isFinite(p) || p === 0) return p + c;
  let t = SPLIT * a;
  const ah = t - (t - a), al = a - ah;
  t = SPLIT * b;
  const bh = t - (t - b), bl = b - bh;
  const e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
  const s = p + c;
  let bb = s - p;
  const err = (p - (s - bb)) + (c - bb);
  const u = err + e;
  bb = u - err;
  const v = (err - (u - bb)) + (e - bb);
  const w = s + u;
  bb = w - s;
  const z = (s - (w - bb)) + (u - bb);
  return w + addRO(z, v);
}

/** FL's denormal guard: |x| < 1e-9 (float) -> 0. */
export const TINY = f32(1e-9);
export const dn = (x: number): number => (x < TINY && x > -TINY ? 0 : x);

/** CEnvelope: attack / decay / sustain / release, doubles. */
export class PzEnv {
  sr = 0;
  lvl = 0;
  end = 0;
  start = 0;
  aR = 0;
  dR = 0;
  sus = 0;
  rR = 0;
  state = 0;
  pos = 0;
  done = true;
  val = 0;
  rel = 0;
  cA = 0;
  cD = 0;
  cR = 0;

  setup(d0: number, att: number, dec: number, sus: number, rel: number, cA: number, cD: number, cR: number, sr: number, lvl: number): void {
    this.sr = sr;
    this.lvl = lvl;
    const e = lvl * d0;
    this.end = e;
    this.start = this.done ? e : this.val;
    this.done = false;
    this.state = 0;
    this.pos = 0;
    this.sus = lvl * sus;
    this.cA = cA;
    this.cD = cD;
    this.cR = cR;
    this.aR = 1 / (Math.max(att, 0.001) * sr);
    this.dR = 1 / (Math.max(dec, 0.001) * sr);
    this.rR = 1 / (Math.max(rel, 0.001) * sr);
  }

  setRelease(t: number): void {
    if (this.state !== 2) this.rR = 1 / (Math.max(t, 0.001) * this.sr);
  }

  release(): void {
    if (this.state !== 2) {
      this.rel = this.val;
      this.state = 2;
      this.pos = 0;
    }
  }

  reset(): void { this.done = true; }

  private curve(pos: number, s: number, e: number, c: number): number {
    if (c === 0) return fmaD(e - s, pos, s);
    const x = Math.pow(10, c * pos);
    const t = fmaD(pos, x, -x) + 1;
    return fmaD(t, e - s, s);
  }

  /** Advance by n samples; the value at the end of the block. */
  tick(n: number): number {
    this.val = 0;
    let v = 0;
    if (this.state === 0) {
      const pos = fmaD(this.aR, n, this.pos);
      this.pos = pos;
      if (pos >= 1) {
        this.state = 1;
        this.pos = 0;
        v = this.lvl;
      } else v = this.curve(pos, this.start, this.lvl, this.cA);
    } else if (this.state === 1) {
      const pos = fmaD(this.dR, n, this.pos);
      this.pos = pos;
      if (pos >= 1) {
        v = this.sus;
        if (v === 0 && this.end === 0) {
          this.state = 2;
          this.done = true;
        }
        this.pos = 1;
      } else v = this.curve(pos, this.lvl, this.sus, this.cD);
    } else if (this.state === 2) {
      const pos = fmaD(this.rR, n, this.pos);
      this.pos = pos;
      if (pos >= 1) {
        this.done = true;
        this.pos = 1;
        v = this.end;
      } else v = this.curve(pos, this.rel, this.end, this.cR);
    }
    if (v < 0) v = 0;
    this.val = v;
    return f32(v);
  }

  copyFrom(o: PzEnv): void {
    this.sr = o.sr; this.lvl = o.lvl; this.end = o.end; this.start = o.start; this.aR = o.aR; this.dR = o.dR;
    this.sus = o.sus; this.rR = o.rR; this.state = o.state; this.pos = o.pos; this.done = o.done; this.val = o.val;
    this.rel = o.rel; this.cA = o.cA; this.cD = o.cD; this.cR = o.cR;
  }
}

/** 64-bit LCG shared by the LFOs' sample & hold (FL: initial 2222, x * 0x0bb38435 + 0x3619636b). */
export class PzRand64 {
  s = 2222n;
  next(): number {
    this.s = (this.s * 0x0bb38435n + 0x3619636bn) & 0xffffffffffffffffn;
    return Number(this.s) * 2.3283064370807974e-10;
  }
}

/** CLFO: rate (Hz), phase 0..1, shape 0 saw / 1 pulse / 2 triangle / 3 sine / 4 random, sync (sixteenths, <= 0 free). */
export class PzLfo {
  rate = 1;
  phase = 0;
  rnd = 0;
  shape = 2;
  retrig = false;
  sync = -1;

  copyFrom(o: PzLfo): void {
    this.rate = o.rate; this.phase = o.phase; this.rnd = o.rnd; this.shape = o.shape; this.retrig = o.retrig; this.sync = o.sync;
  }

  tick(sr: number, tempo: number, n: number, rng: PzRand64): number {
    const r = this.sync > 0 ? tempo / (this.sync * 15) : this.rate;
    const old = this.phase;
    let p = (r * n) / sr + old;
    p -= Math.trunc(p);
    this.phase = p;
    switch (this.shape) {
      case 0: return f32(p);
      case 1: return p >= 0.5 ? 0 : 1;
      case 2: {
        const t = p + p;
        return f32(t > 1 ? 2 - t : t);
      }
      case 3: return f32(Math.cos(p * 6.283185307179586));
      case 4:
        if (old > p) this.rnd = rng.next();
        return f32(this.rnd);
      default: return 0;
    }
  }
}

/** The tape's 2-pole cut filters (FL's simplified RBJ, coefficients from one call each). */
export class PzCut {
  f = 100;
  q = 1;
  sr = 44100;
  b0 = 0;
  a1 = 0;
  a2 = 0;
  x2 = 0;
  x1 = 0;
  y2 = 0;
  y1 = 0;
  readonly hp: boolean;
  constructor(hp: boolean) { this.hp = hp; }

  set(fr: number, q: number, sr: number): void {
    if (this.f === fr && this.q === q && this.sr === sr) return;
    this.f = fr; this.q = q; this.sr = sr;
    const w = f32((fr * 6.283185307179586) / sr);
    sincosf(w, SC);
    const s = SC[0], c = SC[1];
    const sq = f32(s + q);
    const num = this.hp ? f32(c + 1) : f32(1 - c);
    const b0 = f32(num / f32(f32(s / q) + 2));
    const a1 = f32((q * -2 * c) / sq);
    const a2 = f32(f32(q - s) / sq);
    this.b0 = dn(b0);
    this.a1 = dn(a1);
    this.a2 = dn(a2);
  }

  reset(): void { this.x2 = 0; this.x1 = 0; this.y2 = 0; this.y1 = 0; }

  process(xin: number): number {
    const x = dn(xin);
    const x1 = this.x1, x2 = this.x2;
    let t: number;
    if (this.hp) t = f32(f32(x - f32(x1 + x1)) + x2);
    else t = f32(x + f32(f32(x1 + x1) + x2));
    let y = fnms(t, this.b0, fma(this.y1, this.a1, f32(this.y2 * this.a2)));
    y = dn(y);
    this.x2 = x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** One tape buffer: values and positions with 10 entries of history in front. */
class TapeBuf {
  readonly v: Float32Array;
  readonly p: Float64Array;
  count = 0;
  read = 0;
  constructor(n: number) { this.v = new Float32Array(n + 10); this.p = new Float64Array(n + 10); }
  clear(): void { this.v.fill(0); this.p.fill(0); this.count = 0; }
}

/** CTapeDelay. */
export class PzTape {
  readonly len: number;
  readonly init: number;
  private bufA: TapeBuf;
  private bufB: TapeBuf;
  private wr: TapeBuf;
  private rd: TapeBuf;
  lfo = 0;
  lfoInc = 0;
  wet = 0;
  speed = 0;
  speedS = 0;
  pos = 0;
  minSpeed = 0;
  fb = 0;
  wetT = 1;
  depth = 0;
  readonly hi = new PzCut(false);
  readonly lo = new PzCut(true);
  hiOn = false;
  loOn = false;

  constructor(init: number, length: number) {
    const len = Math.max(length, 4);
    this.len = len;
    this.init = init;
    this.bufA = new TapeBuf(len + 256);
    this.bufB = new TapeBuf(len + 256);
    this.wr = this.bufA;
    this.rd = this.bufB;
    this.speed = 1 / ((1 / len + 0.5) * len);
    this.minSpeed = 1 / len;
    this.hi.set(f32(1000), 1, f32(44100));
    this.lo.set(f32(1000), 1, f32(44100));
    this.speedS = this.speed;
    this.pos = init;
  }

  setTime(t: number): void {
    const x = Math.max(Math.min(t, 0.99), 0);
    const len = this.len;
    const d2 = 2 / len;
    const d = fmaD(-d2, x, x) + d2;
    this.speed = 1 / (d * len);
  }

  setLfoRate(rate: number, sr: number): void { this.lfoInc = Math.max(rate, 0) / sr; }
  setFeedback(v: number): void { this.fb = f32(v); }
  setWet(v: number): void { this.wetT = f32(v); }
  setDepth(v: number): void { this.depth = f32(Math.max(Math.min(v, 1), 0)); }

  setHiCut(fr: number, q: number, sr: number): void {
    let f = Math.max(fr, 10);
    const lim = sr * 0.47619049781574513;
    if (lim < f) f = f32(lim);
    this.hi.set(f32(f), Math.max(q, 0), f32(sr));
  }

  setLoCut(fr: number, q: number, sr: number): void {
    let f = Math.max(fr, 10);
    const lim = sr * 0.47619049781574513;
    if (lim < f) f = f32(lim);
    this.lo.set(f32(f), Math.max(q, 0), f32(sr));
  }

  enableHi(on: boolean): void { if (this.hiOn !== on) { this.hiOn = on; this.hi.reset(); } }
  enableLo(on: boolean): void { if (this.loOn !== on) { this.loOn = on; this.lo.reset(); } }

  reset(): void {
    this.wet = 0;
    this.pos = this.init;
    this.speedS = this.speed;
    this.lfo = 0;
    this.bufA.clear();
    this.bufB.clear();
    this.hi.reset();
    this.lo.reset();
  }

  process(xin: number): number {
    const x = dn(xin);
    // LFO: smoothstep of a triangle -> speed factor 1 + depth tri^2 (3 - 2 tri)
    const ph = this.lfo;
    const tri = ph < 0.5 ? ph + ph : 2 - (ph + ph);
    const k3 = 3 - (tri + tri);
    const m = tri * tri * this.depth;
    let np = this.lfoInc + ph;
    np -= np < 1 ? 0 : Math.trunc(np);
    this.lfo = np;
    // read the sample one tape length behind
    let out = 0;
    const rd = this.rd;
    if (rd.count !== 0 && rd.read <= rd.count) {
      // scans up to index count inclusive: the entry there is the sample written at the swap (position >= 1)
      const target = this.pos;
      let i = rd.read;
      let found = false;
      for (;;) {
        if (!(target > rd.p[i + 10])) { found = true; break; }
        i++;
        rd.read = i;
        if (i - 1 === rd.count) break;
      }
      if (found) {
        const v1 = rd.v[i + 10];
        const p1 = f32(rd.p[i + 10]);
        const v0 = rd.v[i + 9];
        const p0 = f32(rd.p[i + 9]);
        let fr = 0;
        if (p0 < p1) fr = (target - p0) / f32(p1 - p0);
        out = f32(fmaD(fr, f32(v1 - v0), v0));
      }
    }
    const mod = fmaD(m, k3, 1);
    out = dn(out);
    if (this.hiOn) out = this.hi.process(out);
    const sp = Math.max(mod, 1);
    if (this.loOn) out = this.lo.process(out);
    const w = fma(this.fb, out, x);
    let s = this.speedS * sp;
    s = Math.min(s, 0.2);
    s = Math.max(s, this.minSpeed);
    let pos = this.pos + s;
    this.pos = pos;
    const wetOld = this.wet;
    let wr = this.wr;
    if (pos >= 1) {
      const r = this.rd;
      const c = r.count;
      wr.v[9] = r.v[c + 9]; wr.p[9] = r.p[c + 9] - 1;
      wr.v[8] = r.v[c + 8]; wr.p[8] = r.p[c + 8] - 1;
      wr.v[7] = r.v[c + 7]; wr.p[7] = r.p[c + 7] - 1;
      // the finished buffer gets the sample too (position >= 1), then the roles swap
      wr.v[wr.count + 10] = w;
      wr.p[wr.count + 10] = pos;
      wr.read = 0;
      pos -= 1;
      this.pos = pos;
      this.wr = r;
      this.rd = wr;
      wr = r;
      wr.count = 0;
    }
    wr.v[wr.count + 10] = w;
    wr.p[wr.count + 10] = pos;
    wr.count++;
    this.wet = dn(f32(fmaD(f32(this.wetT - wetOld), 0.01, wetOld)));
    const y = f32(wetOld * out);
    this.speedS = fmaD(this.speed - this.speedS, 0.005, this.speedS);
    return y;
  }
}

/** The stereo delay: two tapes (the right one starts 0.7 into its tape), times (k + 1) / 4 beats. */
export class PzDelay {
  tempo = 120;
  sr = 0;
  timeL = 0.5;
  timeR = 0.5;
  fbP = 0;
  depthP = 0;
  wetP = 0;
  on = false;
  hiCut = 1000;
  loCut = 10;
  L: PzTape | null = null;
  R: PzTape | null = null;

  private time(v: number): number {
    const d = fmaD(Math.trunc(v * 7), 30, 30) / (this.tempo * 4);
    return Math.max(Math.min(d, 1), 0);
  }

  setSampleRate(sr: number): void {
    this.sr = sr;
    const n = Math.trunc(sr + sr);
    this.L = new PzTape(0, n);
    this.R = new PzTape(0.7, n);
    this.L.setLfoRate(1, sr);
    this.R.setLfoRate(0.876, sr);
    const w = f32(this.wetP * this.wetP);
    this.L.setWet(w); this.R.setWet(w);
    const dp = f32(f32(this.depthP * this.depthP) * 0.01);
    this.L.setDepth(dp); this.R.setDepth(dp);
    const fb = f32(this.fbP * 0.84);
    this.L.setFeedback(fb); this.R.setFeedback(fb);
    this.L.setTime(this.time(this.timeL));
    this.R.setTime(this.time(this.timeR));
    this.L.enableHi(true); this.L.enableLo(true); this.R.enableHi(true); this.R.enableLo(true);
    this.L.setHiCut(this.hiCut, 1, sr); this.L.setLoCut(this.loCut, 1, sr);
    this.R.setHiCut(this.hiCut, 1, sr); this.R.setLoCut(this.loCut, 1, sr);
    this.L.reset(); this.R.reset();
  }

  setTempo(t: number): void {
    this.tempo = t;
    if (this.L) this.L.setTime(this.time(this.timeL));
    if (this.R) this.R.setTime(this.time(this.timeR));
  }

  setOn(v: number): void {
    this.L?.reset(); this.R?.reset();
    this.on = v !== 0;
  }

  setTimeL(v: number): void { this.timeL = v; if (this.L) this.L.setTime(this.time(v)); }
  setTimeR(v: number): void { this.timeR = v; if (this.R) this.R.setTime(this.time(v)); }
  setFeedback(v: number): void { this.fbP = v; const fb = f32(v * 0.84); this.L?.setFeedback(fb); this.R?.setFeedback(fb); }
  setDepth(v: number): void { this.depthP = v; const d = f32(f32(v * v) * 0.01); this.L?.setDepth(d); this.R?.setDepth(d); }
  setWet(v: number): void { this.wetP = v; const w = f32(v * v); this.L?.setWet(w); this.R?.setWet(w); }
  setLoCut(v: number): void {
    this.loCut = f32(exp2f(f32(v * 10)) * 10);
    this.L?.setLoCut(this.loCut, 1, this.sr); this.R?.setLoCut(this.loCut, 1, this.sr);
  }
  setHiCut(v: number): void {
    this.hiCut = f32(exp2f(f32(v * f32(6.6))) * 200);
    this.L?.setHiCut(this.hiCut, 1, this.sr); this.R?.setHiCut(this.hiCut, 1, this.sr);
  }
  reset(): void { this.L?.reset(); this.R?.reset(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (!this.on || !this.L || !this.R) return;
    const tl = this.L, tr = this.R;
    for (let i = 0; i < n; i++) {
      L[i] = f32(L[i] + tl.process(L[i]));
      R[i] = f32(R[i] + tr.process(R[i]));
    }
  }
}

/** The chorus: three speed-modulated tapes (11, 8.5, 10 ms) on the mono sum, added to both sides. */
export class PzChorus {
  depthP = 0;
  /** FL keeps the wet amount negated here; a sample-rate change hands it to the tapes and negates it again. */
  wetNeg = 0;
  rateP = 0;
  on = false;
  sr = 0;
  A: PzTape | null = null;
  B: PzTape | null = null;
  C: PzTape | null = null;

  private rates(): void {
    const d = fmaD(this.rateP, 5, 0.1);
    this.A?.setLfoRate(d * 0.896, this.sr);
    this.B?.setLfoRate(d, this.sr);
    this.C?.setLfoRate(d * 0.689, this.sr);
  }

  setSampleRate(sr: number): void {
    this.sr = sr;
    this.A = new PzTape(0, Math.trunc(sr * 0.021999999508261682));
    this.B = new PzTape(0.467, Math.trunc(sr * 0.01707999961823225));
    this.C = new PzTape(0.778, Math.trunc(sr * 0.019999999552965164));
    const w = this.wetNeg;
    this.wetNeg = f32(-w);
    this.A.setWet(w); this.B.setWet(w); this.C.setWet(w);
    this.rates();
    this.A.setDepth(1); this.B.setDepth(1); this.C.setDepth(1);
    this.A.reset(); this.B.reset(); this.C.reset();
  }

  setRate(v: number): void { this.rateP = v; this.rates(); }
  setDepth(v: number): void {
    this.depthP = v;
    const d = v * v * v;
    this.A?.setDepth(d); this.B?.setDepth(d); this.C?.setDepth(d);
  }
  setWet(v: number): void { this.wetNeg = f32(-v); this.A?.setWet(v); this.B?.setWet(v); this.C?.setWet(v); }
  setOn(v: number): void { this.on = v !== 0; }
  reset(): void { this.A?.reset(); this.B?.reset(); this.C?.reset(); }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (!this.on || !this.A || !this.B || !this.C) return;
    const a = this.A, b = this.B, c = this.C;
    for (let i = 0; i < n; i++) {
      const m = f32(R[i] + L[i]);
      const ya = a.process(m);
      const yc = c.process(m);
      const yb = b.process(m);
      L[i] = f32(f32(yb + ya) + L[i]);
      R[i] = f32(f32(yb + yc) + R[i]);
    }
  }
}

/** RBJ shelving / peaking biquad (FL's: A = 10^(dB / 20), S-style bandwidth). The output uses a +5 dB high shelf at 12 kHz. */
export class PzShelf {
  x1 = 0;
  x2 = 0;
  y1 = 0;
  y2 = 0;
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  sr = 44100;
  gain = 0;
  freq = 1000;
  bw = 1;
  dirty = true;
  type = 1;

  setSampleRate(sr: number): void {
    const s = f32(sr);
    if (this.sr !== s) this.dirty = true;
    this.sr = s;
    if (!this.dirty) return;
    this.dirty = false;
    const A = exp10f(f32(this.gain * f32(0.05)));
    let w = f32((this.freq * 6.283185) / this.sr);
    w = Math.max(Math.min(w, 3), 0);
    const d11 = this.bw * 0.3465736 * w;
    const sn = sinf(w);
    const sh = f32(2 * Math.sinh(d11 / sn));
    const g2 = f32(f32(Math.sqrt(A)) * sh);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    if (this.type === 2 || this.type === 0) {
      const p1 = f32(A + 1), m1 = f32(A - 1);
      const cs = cosf(w);
      const s4 = f32(sn * g2);
      if (this.type === 2) {
        const s3 = fnms(A, cs, cs);
        const s2 = f32(s3 + p1);
        b0 = f32(f32(s2 + s4) * A);
        const s5 = fma(A, cs, cs);
        b1 = f32(f32(A * -2) * f32(s5 + m1));
        b2 = f32(f32(s2 - s4) * A);
        a0 = f32(f32(p1 - s3) + s4);
        a1 = f32(f32(m1 - s5) * 2);
        a2 = f32(p1 - f32(s4 + s3));
      } else {
        const s2 = fnms(A, cs, cs);
        const s3 = f32(s2 + p1);
        a0 = f32(s3 + s4);
        b0 = f32(f32(f32(p1 - s2) + s4) * A);
        const s5 = fma(A, cs, cs);
        b1 = f32(A * f32(f32(m1 - s5) * 2));
        b2 = f32(f32(p1 - f32(s4 + s2)) * A);
        a1 = f32(f32(s5 + m1) * -2);
        a2 = f32(s3 - s4);
      }
    } else if (this.type === 1) {
      const t = f32(f32(sh * 0.5) * sn);
      const s12 = f32(t / A);
      a0 = f32(s12 + 1);
      const s8 = f32(t * A);
      b0 = f32(s8 + 1);
      const cs = cosf(w);
      b1 = f32(cs * -2);
      a1 = b1;
      b2 = f32(1 - s8);
      a2 = f32(1 - s12);
    } else {
      b0 = this.b0; b1 = this.b1; b2 = this.b2; a0 = 0; a1 = this.a1; a2 = this.a2;
    }
    const r = f32(1 / a0);
    this.b0 = dn(f32(b0 * r));
    this.b1 = dn(f32(b1 * r));
    this.b2 = dn(f32(b2 * r));
    this.a1 = dn(f32(a1 * r));
    this.a2 = dn(f32(a2 * r));
  }

  reset(): void { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }

  process(xin: number): number {
    const x = dn(xin);
    const s0 = fma(this.b0, x, f32(this.b1 * this.x1));
    const p = f32(s0 + f32(this.b2 * this.x2));
    const q = f32(f32(this.a1 * this.y1) + f32(this.a2 * this.y2));
    const y = dn(f32(p - q));
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}
