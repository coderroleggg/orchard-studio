// Bit-exact port of FL Studio 2026's Shared/SGv2_x64.dylib (Soundgoodizer v2 = the
// Maximus engine) as Harmor's COMPRESSION unit drives it: Eff_Render 0x6ac10 and
// the parameter / state code it depends on, for the four states Harmor loads
// (System/Compression/1..4.fst) and the parameters Harmor forwards (5 LMH mix,
// 8 / 21 / 34 band pre gains). Validated sample for sample against the real
// dylib (scratchpad harmor/fxw/comp/sghost).
//
// Signal flow of Eff_Render (n frames, interleaved stereo, in place):
//  - silence gate (0x75ee0): a block whose samples are all within +-1e-6 counts
//    down +0x800 (reloaded to 1.5 s + latency by any other block); once it
//    runs out the engine resets (0x6cb70) and passes the input through.
//  - optional 2x polyphase oversampling of the LOW / MID / HIGH section
//    (0x24dc20 / 0x24dd00, the kernels of Harmor's distortion).
//  - crossover (0x6c1d0): LOW = LP(f1)^(s0+1) [then AP(f2) if s2 > 0]; the
//    HP(f1)^(s0+1) sections of MID run in place on the input, which then feeds
//    MID = LP(f2)^(s2+1) and HIGH = HP(f2)^(s2+1); RBJ biquads (0x1eeee0,
//    kernel 0x1ef5a0) with Q 0.5 (12 dB) / 0.7071 (24 dB).
//  - per band (LOW, MID, HIGH, then MASTER on the sum): stereo matrix with
//    4 per-block ramps (0x77be0, kernel 0x47c4); detector (sliding peak of
//    max(|L|,|R|) 0x241ed0 or windowed RMS 0x242430); release stages
//    (0x1deae0); curve table lookup (curve -> gain, 0x6cda0); attack stages;
//    lookahead delay (0x74aa0); gain; saturation A (table 0x68a70, kernel
//    0x76a20); LMH mix with the delayed dry band, band sign; accumulation.

import { cos, exp, log, sin } from './fx-libm';
import { Polyphase } from './fx-dist';
import { FlRate, rint } from './fx-util';
import { fma32, sqrtf1 } from './ipp';

const f32 = Math.fround;

const F001 = f32(0.001);
const F0001 = f32(0.0001);
const LN7F = f32(1.945910096168518);
const SIXTH = f32(1 / 6);
const LN001 = -4.605170185988091;
const EPS24 = 5.960464477539063e-8;
const SAFETY = f32(0.975);
const INV_LN9 = 0.45511961331341866;
const LN9 = 2.1972245773362196;
const LN101 = 4.61512051684126;
const LN501 = 6.2166061010848646;
const LN5 = 1.6094379124341003;
const XO_K = 0.00013822774794088088;
const LN2 = 0.6931471805599453;
const BW_ALPHA = 0.7071067811865475;
/** f32 sin / cos of f32(pi / 4) (the matrix's centred pan) times f32(sqrt 2): both 1. */
const PAN_C = f32(f32(0.7071067690849304) * f32(1.4142135381698608));
const SIGN = [0, -1, 1];
const SILENT = -0x3fffffff;

const fbuf = new Float32Array(1);
const ibuf = new Int32Array(fbuf.buffer);
function bits(x: number): number {
  fbuf[0] = x;
  return ibuf[0];
}

/** Band pre / post / ceiling law: (7^(raw / 1000) - 1) / 6. */
function gainLaw(raw: number): number {
  const s = f32(f32(raw) * F001);
  if (s === 1) return s;
  return f32((exp(f32(s * LN7F)) - 1) * SIXTH);
}

/** 0x76d00(raw * 1e-4, 500): 501^x - 1 (ms). */
function timeLaw(raw: number): number {
  const x = f32(f32(raw) * F0001);
  return f32(exp(x * log(501)) - 1);
}

/** 0x67fd0: sustain window (ms). */
function susLaw(raw: number): number {
  const x = f32(f32(raw) * F0001);
  return f32(exp(x * LN501) - 1) * 2;
}

/** 0x1de980: one-pole coefficient for a time in samples. */
function stageCoef(t: number): number {
  if (!(t > 0)) return 0;
  return exp(LN001 / (t > 1 ? t : 1));
}

/** FPC Math.Power (0xf5570). */
function fpcPower(base: number, e: number): number {
  if (e === 0) return 1;
  if (base === 0 && e > 0) return 0;
  if (Math.abs(e) <= 2147483647 && e === Math.trunc(e)) {
    // 0xf5650 IntPower: square and multiply
    let n = Math.abs(e), b = base, r = 1;
    while (n > 0) {
      if (n & 1) r *= b;
      b *= b;
      n = Math.floor(n / 2);
    }
    return e < 0 ? 1 / r : r;
  }
  return exp(e * log(base));
}

// ------------------------------------------------------------------ building blocks

/** TBiquad record (0x78 bytes): type, freq, 8 doubles state, b0 b1 b2 a1 a2. */
class SgBiquad {
  type = 1;
  freq = 0;
  readonly st = new Float64Array(8);
  b0 = 0;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;

  /** 0x1ef490 + 0x1eeee0 (types 1 low pass, 4 high pass, 5 all pass). */
  design(order: number, r: FlRate): void {
    if (this.freq > r.nyq) this.freq = r.nyq;
    const w = this.freq * r.w;
    const s = sin(w), c = cos(w);
    const alpha = order === 0 ? s : order === 1 ? s * BW_ALPHA : s / (2 * fpcPower(0.5, 1 / (order + 1)));
    this.setAlpha(alpha, c);
  }

  /** 0x1eeee0 for an explicit alpha (cosine c). */
  setAlpha(alpha: number, c: number): void {
    const k = 1 / (1 + alpha);
    this.a1 = k * (-2 * c);
    this.a2 = k * (1 - alpha);
    if (this.type === 1) {
      this.b1 = k * (1 - c);
      this.b0 = this.b1 * 0.5;
      this.b2 = this.b0;
    } else if (this.type === 4) {
      this.b1 = k * -(1 + c);
      this.b0 = -this.b1 * 0.5;
      this.b2 = this.b0;
    } else {
      this.b1 = this.a1;
      this.b0 = this.a2;
      this.b2 = 1;
    }
  }

  /** Kernel 0x3ef8: src -> dst (n stereo frames, may alias). */
  run(src: Float32Array, dst: Float32Array, n: number): void {
    const s = this.st;
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    let x1l = s[0], x1r = s[1], x2l = s[2], x2r = s[3];
    let y1l = s[4], y1r = s[5], y2l = s[6], y2r = s[7];
    for (let i = 0, j = 0; i < n; i++, j += 2) {
      const xl = src[j], xr = src[j + 1];
      const yl = (b2 * x2l + b1 * x1l - a1 * y1l - a2 * y2l) + b0 * xl;
      const yr = (b2 * x2r + b1 * x1r - a1 * y1r - a2 * y2r) + b0 * xr;
      dst[j] = yl;
      dst[j + 1] = yr;
      x2l = x1l; x1l = xl; y2l = y1l; y1l = yl;
      x2r = x1r; x1r = xr; y2r = y1r; y1r = yr;
    }
    s[0] = x1l; s[1] = x1r; s[2] = x2l; s[3] = x2r;
    s[4] = y1l; s[5] = y1r; s[6] = y2l; s[7] = y2r;
  }
}

/** Envelope stage (0x28 bytes): rise / fall coefficients, double state (0x1deae0). */
class SgStage {
  rise = 0;
  fall = 0;
  s = 0;

  run(buf: Float32Array, n: number): void {
    const cr = this.rise, cf = this.fall;
    let s = this.s;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      s = x > s ? x + (s - x) * cr : x + (s - x) * cf;
      buf[i] = s;
    }
    this.s = Math.abs(s) < EPS24 ? 0 : s;
  }
}

/** Peak detector (class 0x338120): max(|L|, |R|) (0x4c04), then a sliding maximum (0x241ed0). */
class PeakDet {
  len = 0;
  pos = 0;
  head = 1;
  tail = 0;
  count = 0;
  buf = new Int32Array(1);
  dq = new Int32Array(1);

  setLength(n: number): void {
    if (n < 1) n = 1;
    if (this.len === n) return;
    this.len = n;
    this.buf = new Int32Array(n);
    this.dq = new Int32Array(n);
    this.reset();
  }

  reset(): void {
    this.buf[0] = 0;
    this.pos = 0;
    this.head = 1;
    this.tail = 0;
    this.count = 0;
  }

  run(x: Float32Array, lvl: Float32Array, lvlI: Int32Array, n: number): void {
    for (let i = 0, j = 0; i < n; i++, j += 2) {
      const a = Math.abs(x[j]), b = Math.abs(x[j + 1]);
      lvl[i] = a > b ? a : b;
    }
    const len = this.len;
    if (len < 2) return;
    const buf = this.buf, dq = this.dq;
    let pos = this.pos, head = this.head, tail = this.tail, count = this.count;
    for (let i = 0; i < n; i++) {
      const w5 = pos;
      pos = pos + 1;
      if (len <= pos) pos = 0;
      const curMax = count > 0 ? buf[dq[head]] : buf[w5];
      const v = lvlI[i];
      if (buf[w5] >= v) {
        tail = tail + 1;
        if (tail >= len) tail = 0;
        dq[tail] = w5;
        const w9 = dq[head] - 1;
        if (pos === w9 || len + w9 === pos) {
          head = head + 1;
          if (head >= len) head = 0;
        } else count = count + 1;
      } else {
        while (count > 0) {
          if (buf[dq[tail]] < v) {
            count = count - 1;
            tail = tail - 1;
            if (tail < 0) tail = len - 1;
            continue;
          }
          const w9 = dq[head] - 1;
          if (pos === w9 || len + w9 === pos) {
            count = count - 1;
            head = head + 1;
            if (head >= len) head = 0;
          }
          break;
        }
      }
      buf[pos] = v;
      if (v < curMax) lvlI[i] = curMax;
    }
    this.pos = pos;
    this.head = head;
    this.tail = tail;
    this.count = count;
  }
}

/** RMS detector (class 0x338210): L^2 + R^2 over a window of 2 * len values (0x242430), sqrt (vvsqrtf). */
class RmsDet {
  len = 0;
  pos = 0;
  sum = 0;
  scale = 0;
  buf = new Float32Array(1);

  setLength(n: number): void {
    if (n < 1) n = 1;
    if (this.len === n) return;
    this.len = n;
    this.buf = new Float32Array(n);
    this.scale = f32(1 / (n * 2));
    this.reset();
  }

  reset(): void {
    this.buf.fill(0);
    this.pos = 0;
    this.sum = 0;
  }

  run(x: Float32Array, lvl: Float32Array, n: number): void {
    const buf = this.buf, len = this.len, sc = this.scale;
    let pos = this.pos, sum = this.sum;
    for (let i = 0, j = 0; i < n; i++, j += 2) {
      const l = x[j], r = x[j + 1];
      const v = f32(f32(l * l) + f32(r * r));
      pos = pos + 1;
      if (pos >= len) pos = 0;
      sum = (sum - buf[pos]) + v;
      buf[pos] = v;
      const m = f32(sum * sc);
      lvl[i] = sqrtf1(m > 0 ? m : 0);
    }
    this.sum = sum;
    this.pos = pos;
  }
}

/** Lookahead delay of stereo frames (0x74aa0). */
class SgDelay {
  n = 0;
  pos = 0;
  buf = new Float32Array(0);

  setLength(d: number): void {
    if (d < 0) d = 0;
    if (this.buf.length < 2 * d) this.buf = new Float32Array(2 * d);
    this.n = d;
    this.reset();
  }

  reset(): void {
    this.buf.fill(0);
    this.pos = 0;
  }

  run(x: Float32Array, frames: number): void {
    const d = this.n;
    if (d === 0) return;
    const b = this.buf;
    let p = this.pos;
    for (let i = 0, j = 0; i < frames; i++, j += 2) {
      const l = b[2 * p], r = b[2 * p + 1];
      b[2 * p] = x[j];
      b[2 * p + 1] = x[j + 1];
      x[j] = l;
      x[j + 1] = r;
      if (++p >= d) p = 0;
    }
    this.pos = p;
  }
}

// ------------------------------------------------------------------ curve / saturation tables

/** One point of a band curve as SGv2 holds it (TEnvelope point, 0x24 bytes). */
export interface SgPoint {
  /** +0x00 distance from the previous point */
  dx: number;
  /** +0x08 value */
  y: number;
  /** +0x10 shape (0 exponential, 7 "single curve 2") */
  mode: number;
  /** +0x13 1 curved, 2 straight */
  flag: number;
  /** +0x14..+0x1c precomputed shape values */
  c0: number;
  c1: number;
  c2: number;
}

interface CurveTable {
  table: Float32Array;
  tmax: number;
  /** curve output at level 4 (+0x48) */
  top: number;
  /** curve maximum / 0.975 (+0x50) */
  peak: number;
}

/** 0x24a750: advance the curve evaluation by d (envelope state 0x249580). */
class CurveEval {
  idx = 0;
  pos = 0;
  rate = 0;
  y0 = 0;
  dy = 0;
  out = 0;
  constructor(private readonly pts: SgPoint[]) {
    this.idx = 0;
    if (pts[0].dx === 0) {
      this.rate = 1;
      this.pos = 1;
    } else {
      this.rate = 1 / pts[0].dx;
      this.pos = 0;
    }
    this.y0 = pts[0].y;
    this.dy = 0;
    this.out = this.y0;
  }

  step(d: number): void {
    const pts = this.pts, n = pts.length - 1;
    if (!(this.idx >= 0 && this.idx <= n)) return;
    this.pos = this.pos + d * this.rate;
    // loop while the double's high word >= 0x3ff00000 (pos >= 1 or negative)
    while (this.pos >= 1 || this.pos < 0 || Object.is(this.pos, -0) || this.pos !== this.pos) {
      const w21 = this.idx;
      if (this.rate === 0) this.pos = d;
      else this.pos = (this.pos - 1) / this.rate;
      this.y0 = pts[this.idx].y;
      if (this.idx < n) this.idx++;
      this.dy = pts[this.idx].y - this.y0;
      if (this.idx === w21) {
        this.pos = 0;
        this.rate = 0;
      } else {
        const dx = pts[this.idx].dx;
        if (dx > 0) {
          this.rate = 1 / dx;
          this.pos = this.pos * this.rate;
        } else {
          this.rate = 1;
          this.pos = this.pos + 1;
        }
      }
    }
    const t = this.pos;
    let v: number;
    if (!(this.idx >= 0 && this.idx <= n)) v = 0;
    else {
      const p = pts[this.idx];
      if (p.flag === 2) v = t;
      else if (p.mode === 0) {
        if (bits(p.c0) === 0) v = t;
        else if (p.c0 > 0 || Object.is(p.c0, 0)) v = 1 - (exp((1 - t) * p.c2) - 1) * p.c1;
        else v = (exp(t * p.c2) - 1) * p.c1;
      } else if (p.mode === 7) {
        const u = p.flag > 0 ? 1 - t : t;
        const u3 = u * u * u;
        v = t - (u3 * u3 - u) * p.c0;
      } else throw new Error('SGv2 curve mode ' + p.mode + ' not ported');
    }
    this.out = this.y0 + v * this.dy;
  }
}

/** 0x6cda0: output / input level table of a band curve, input levels 0..4 in steps of 1/8192. */
function buildCurveTable(pts: SgPoint[]): CurveTable {
  const tab = new Float32Array(32770);
  const ev = new CurveEval(pts);
  const k = f32(SAFETY * 0.5);
  let prev = 0, last = 0, top = 0, peak = 0;
  for (let i = 0; i <= 32768; i++) {
    const x = (i > 1 ? i : 1) * 0.0001220703125;
    const p0 = prev;
    prev = log(x * 2 + 1) * INV_LN9;
    ev.step(prev - p0);
    let y = (exp(ev.out * LN9) - 1) * k;
    if (Math.abs(y - SAFETY) < EPS24) y = SAFETY;
    else last = i;
    top = y;
    peak = peak > y ? peak : y;
    tab[i] = y / x;
  }
  tab[last + 1] = tab[last];
  return { table: tab.slice(0, last + 2), tmax: last, top, peak: peak / SAFETY };
}

interface SatTable {
  table: Float32Array;
  /** +0xe8 output scale */
  outScale: number;
  /** +0xec input scale */
  inScale: number;
}

/** 0x68a70, saturation type A (threshold < 0): 65537 points (vvpows / vvatan). */
function buildSatTable(thres: number, ceilRaw: number, post: number, d58: number): SatTable {
  let d9 = d58 * post;
  const d10 = gainLaw(ceilRaw);
  if (!(d9 >= d10)) d9 = d10;
  const d8 = thres * -0.1;
  const d13 = f32(20 - f32(f32(log(f32(f32(d8) + 1)) / LN101) * 19));
  const d11 = 1 / d13;
  const d12 = d10 > 0 ? d9 / (65536 * d10) : 1;
  const d14 = 1 / fpcPower(Math.atan(fpcPower(65536 * d12, d13)), d11);
  const table = new Float32Array(65538);
  for (let i = 0; i <= 65536; i++) {
    let v = Math.pow(i * d12, d13);
    v = Math.atan(v);
    v = Math.pow(v, d11) * d14;
    table[i] = v < EPS24 ? 0 : v;
  }
  table[65537] = table[65536];
  return { table, outScale: f32(d10), inScale: f32(1 / d9) };
}

// The tables depend only on the curve / the band's saturation settings (not on the
// sample rate or the forwarded parameters): built once per process.
const curveCache = new Map<string, CurveTable>();
const satCache = new Map<string, SatTable>();

function curveTable(pts: SgPoint[]): CurveTable {
  const key = pts.map((p) => [p.dx, p.y, p.mode, p.flag, p.c0, p.c1, p.c2].join(',')).join(';');
  let t = curveCache.get(key);
  if (!t) {
    t = buildCurveTable(pts);
    curveCache.set(key, t);
  }
  return t;
}

// ------------------------------------------------------------------ engine

/** A Maximus state as Harmor loads it. */
export interface SgPreset {
  /** the 59 parameters (FL order) */
  params: number[];
  /** per band (LOW, MID, HIGH, MASTER): curve points, the first at (0, 0) */
  curves: SgPoint[][];
  /** oversampling (0 off, 1 = 2x) */
  oversample: number;
}

class SgBand {
  mode = 0;
  pre = 1;
  post = 1;
  sign = 1;
  gain0 = 0;
  curve: CurveTable | null = null;
  d58 = 0;
  freq = 0;
  slope = 0;
  filters: SgBiquad[] = [];
  att: SgStage[] = [];
  rel: SgStage[] = [];
  readonly delay = new SgDelay();
  rms = false;
  readonly peak = new PeakDet();
  readonly rmsDet = new RmsDet();
  sat: SatTable | null = null;
  readonly mTgt = new Float32Array(4);
  readonly mCur = new Float32Array(4);
  constructor(readonly idx: number) {}
}

/** The low cut's stage factors (0x3632d8): alpha = sin(w) * factor. */
const LOWCUT_Q = [f32(0.19771184027194977), f32(0.61932772397995), f32(0.6768445372581482), f32(1.0793569087982178)];

export class SgEngine {
  readonly sr: number;
  private readonly maxBlock: number;
  private readonly bands = [new SgBand(0), new SgBand(1), new SgBand(2), new SgBand(3)];
  private readonly params = new Int32Array(59);
  private preset: SgPreset | null = null;
  private os = 1;
  private rBand: FlRate;
  private readonly rBase: FlRate;
  private first = 1;
  /** low cut (parameter 6 >= 0, 0x68220): four high-pass stages before the bands; Soundgoodizer's own state (Autogun) uses it */
  private lowCut: SgBiquad[] | null = null;
  private mix = 1;
  private mixOn = false;
  private counter = SILENT;
  private reload = 0;
  private snap = true;
  /** reported latency (FHD_SetLatency) */
  latency = 0;
  private readonly upP = new Polyphase();
  private readonly downP = new Polyphase();
  // Eff_Render's scratch (+0x360 .. +0x388)
  private readonly up: Float32Array;
  private readonly upTmp: Float32Array;
  private readonly acc: Float32Array;
  private readonly tmp: Float32Array;
  private readonly lvl: Float32Array;
  private readonly lvlI: Int32Array;
  private readonly dry: Float32Array;
  private readonly start = new Float32Array(4);
  private readonly delta = new Float32Array(4);

  constructor(sampleRate: number, maxBlock: number) {
    this.sr = Math.round(sampleRate) | 0;
    this.maxBlock = Math.max(1, maxBlock | 0);
    this.rBase = new FlRate(this.sr);
    this.rBand = this.rBase;
    const m = this.maxBlock * 2;
    this.up = new Float32Array(2 * m);
    this.upTmp = new Float32Array(2 * m);
    this.acc = new Float32Array(2 * m);
    this.tmp = new Float32Array(2 * m);
    this.lvl = new Float32Array(m);
    this.lvlI = new Int32Array(this.lvl.buffer);
    this.dry = new Float32Array(2 * m);
    this.upP.setOrder(1);
    this.downP.setOrder(1);
  }

  /** SaveRestoreState of a preset: parameters, curves, crossover, bands, then the reset 0x6cb70. */
  load(p: SgPreset): void {
    this.preset = p;
    for (let i = 0; i < 59; i++) this.params[i] = p.params[i];
    this.os = p.oversample > 0 ? 2 : 1;
    this.rBand = this.os > 1 ? new FlRate(this.sr * this.os) : this.rBase;
    this.mix = f32(f32(this.params[5]) * F001);
    this.mixOn = this.mix !== 1;
    this.setLowCut(this.params[6]);
    for (const b of this.bands) {
      const base = 13 * b.idx;
      b.mode = this.params[base + 7];
      b.pre = gainLaw(this.params[base + 8]);
      b.post = gainLaw(this.params[base + 9]);
      b.rms = this.params[base + 19] !== 0;
      b.curve = curveTable(p.curves[b.idx]);
      b.d58 = b.rms || b.mode >= 1 ? 4 : b.curve.peak;
      this.matrix(b, f32(f32(this.params[base + 10]) * F001));
      b.att = [];
      b.rel = [];
    }
    this.crossover();
    for (const b of this.bands) {
      this.timing(b);
      this.satTable(b);
      b.gain0 = f32(f32(b.pre * b.post) * b.curve!.table[0]);
    }
    let lat = 0;
    for (let i = 0; i < 3; i++) lat = Math.max(lat, this.bands[i].delay.n);
    this.latency = Math.trunc(lat / this.os) + this.bands[3].delay.n;
    this.reload = rint(f32(1.5 * this.sr)) + this.latency;
    for (const b of this.bands) {
      if (b.rms) b.rmsDet.reset();
      else b.peak.reset();
    }
    this.reset();
  }

  get loaded(): boolean {
    return this.preset !== null;
  }

  /** ProcessParam 6 (0x68220 + 0x24d770): the low cut, off for a negative value, else 5 * 2^(raw / 16384) Hz. */
  setLowCut(raw: number): void {
    this.params[6] = raw;
    if (raw < 0) {
      this.lowCut = null;
      return;
    }
    const f = f32(5 * exp(raw * 6.103515625e-05 * LN2));
    const d8 = f32(f) * 0.8 * this.rBase.w;
    const s = sin(d8), c = cos(d8);
    const st: SgBiquad[] = [];
    for (let k = 0; k < 4; k++) {
      const q = new SgBiquad();
      q.type = 4;
      q.setAlpha(s * LOWCUT_Q[k], c);
      st.push(q);
    }
    this.lowCut = st;
  }

  /** ProcessParam 5: LMH mix. */
  setMix(raw: number): void {
    this.params[5] = raw;
    this.mix = f32(f32(raw) * F001);
    this.mixOn = this.mix !== 1;
  }

  /** ProcessParam 8 / 21 / 34: band pre gain. */
  setPre(band: number, raw: number): void {
    const b = this.bands[band];
    this.params[13 * band + 8] = raw;
    b.pre = gainLaw(raw);
    if (b.curve) b.gain0 = f32(f32(b.pre * b.post) * b.curve.table[0]);
  }

  /** 0x6cb70: stages, delays, filters, oversamplers, silence gate, crossover, ramp snap (not the detectors). */
  reset(): void {
    for (const b of this.bands) {
      for (const s of b.att) s.s = b.gain0;
      for (const s of b.rel) s.s = 0;
      b.delay.reset();
      for (const f of b.filters) f.st.fill(0);
    }
    this.upP.reset();
    this.downP.reset();
    if (this.lowCut) for (const q of this.lowCut) q.st.fill(0);
    this.counter = SILENT;
    this.crossover();
    this.snap = true;
  }

  /** Full DSP reset (transport): detectors too. */
  clear(): void {
    for (const b of this.bands) {
      b.peak.reset();
      b.rmsDet.reset();
    }
    this.reset();
  }

  // -------------------------------------------------------------- parameters

  /** 0xa4be0 (pan 0, volume 1): stereo separation matrix targets. */
  private matrix(b: SgBand, st: number): void {
    const m = b.mTgt;
    if (bits(st) === 0) {
      m[0] = 1; m[1] = 1; m[2] = 0; m[3] = 0;
      return;
    }
    let m0 = PAN_C, m1 = PAN_C, s10 = 0, s9 = 0;
    if (st !== 0) {
      if (st > 0) st = f32(f32(exp(st * LN5) - 1) * 0.25);
      s10 = f32(s10 + st);
      s9 = f32(s9 + st);
      if (s10 > 1) s10 = 1;
      if (s9 > 1) s9 = 1;
    }
    s10 = f32(s10 * 0.5);
    m[2] = f32(m0 * s10);
    m0 = f32(m0 * f32(1 - s10));
    s9 = f32(s9 * 0.5);
    m[3] = f32(m1 * s9);
    m1 = f32(m1 * f32(1 - s9));
    m[0] = m0;
    m[1] = m1;
  }

  /** 0x6c1d0: crossover frequencies, slopes, filter sections, band signs. */
  private crossover(): void {
    const P = this.params, B = this.bands, r = this.rBand;
    const lo = B[0], mid = B[1], hi = B[2];
    lo.freq = f32(30 * exp((P[0] * XO_K) * LN2));
    lo.slope = lo.mode === 3 ? -1 : P[1];
    hi.freq = f32(30 * exp((P[2] * XO_K) * LN2));
    hi.slope = hi.mode === 3 ? -1 : P[3];
    if (hi.slope >= 0 && lo.slope >= 0 && lo.freq > hi.freq) {
      const t = hi.freq;
      hi.freq = lo.freq;
      lo.freq = t;
    }
    this.first = 1;
    for (let b = 0; b < 3; b++) {
      if (B[b].mode !== 3) {
        this.first = b;
        break;
      }
    }
    const s0 = lo.slope, s2 = hi.slope;
    const nLo = s0 + (s2 > 0 ? 1 : 0) + 1;
    if (lo.filters.length !== nLo || hi.filters.length !== s2 + 1) {
      lo.filters = [];
      for (let j = 0; j < nLo; j++) {
        const f = new SgBiquad();
        f.type = j === nLo - 1 && s2 > 0 ? 5 : 1;
        lo.filters.push(f);
      }
      mid.filters = [];
      for (let j = 0; j < s0 + s2 + 2; j++) {
        const f = new SgBiquad();
        f.type = j <= s0 ? 4 : 1;
        mid.filters.push(f);
      }
      hi.filters = [];
      for (let j = 0; j < s2 + 1; j++) {
        const f = new SgBiquad();
        f.type = 4;
        hi.filters.push(f);
      }
    }
    let n0 = lo.filters.length - 1;
    if (n0 >= 0 && s2 > 0) {
      lo.filters[n0].freq = hi.freq;
      lo.filters[n0].design(0, r);
      n0--;
    }
    for (let j = 0; j <= n0; j++) {
      lo.filters[j].freq = lo.freq;
      lo.filters[j].design(s0, r);
    }
    lo.sign = SIGN[s0 + 1];
    for (let j = 0; j <= s0; j++) {
      mid.filters[j].freq = lo.freq;
      mid.filters[j].design(s0, r);
    }
    for (let j = s0 + 1; j < mid.filters.length; j++) {
      mid.filters[j].freq = hi.freq;
      mid.filters[j].design(s2, r);
    }
    for (const f of hi.filters) {
      f.freq = hi.freq;
      f.design(s2, r);
    }
    hi.sign = SIGN[s2 + 1];
  }

  /** 0x683c0: lookahead delay, attack / release stages, detector window. */
  private timing(b: SgBand): void {
    const P = this.params, base = 13 * b.idx, B = this.bands, sr = this.sr;
    const w21 = b.idx === 3 ? 1 : this.os;
    let delay = 0;
    const off = b.mode >= 2 || (b.idx === 3 && b.mode >= 1) || (b.idx < 3 && B[0].mode > 0 && B[1].mode > 0 && B[2].mode > 0);
    if (!off) {
      const raw = b.idx === 3 ? P[base + 13] : P[4];
      delay = w21 * rint(timeLaw(raw) * 2 * 0.001 * sr);
    }
    if (b.delay.n !== delay || b.delay.buf.length === 0) b.delay.setLength(delay);
    // attack stages
    const nAtt = P[base + 15];
    if (b.att.length !== nAtt) {
      b.att = [];
      for (let i = 0; i < nAtt; i++) {
        const s = new SgStage();
        s.s = 1;
        b.att.push(s);
      }
    }
    const attRaw = P[base + 13];
    let d8 = attRaw === 0 ? delay : timeLaw(attRaw) * 2 * 0.001 * sr * w21;
    d8 = (d8 * 0.8) / Math.sqrt(nAtt);
    const r2Raw = P[base + 14];
    const d9 = r2Raw === 0 ? d8 : (timeLaw(r2Raw) * 2 * 0.001 * sr * w21 * 2) / Math.sqrt(nAtt);
    for (const s of b.att) {
      s.rise = stageCoef(d9);
      s.fall = stageCoef(d8);
    }
    // detector window
    const win = Math.max(w21 * rint(susLaw(P[base + 18]) * 0.001 * sr), Math.max(delay, 1));
    if (b.rms) b.rmsDet.setLength(win);
    else b.peak.setLength(win);
    // release stages
    const rel = timeLaw(P[base + 16]) * 2 * 0.001 * sr * w21;
    if (!(rel > 0)) b.rel = [];
    else {
      const nRel = P[base + 17];
      if (b.rel.length !== nRel) {
        b.rel = [];
        for (let i = 0; i < nRel; i++) b.rel.push(new SgStage());
      }
      const t = (rel * 2) / Math.sqrt(b.rel.length);
      for (const s of b.rel) {
        s.rise = 0;
        s.fall = stageCoef(t);
      }
    }
  }

  /** 0x68a70: saturation table (type A only; Harmor's states use no type B). */
  private satTable(b: SgBand): void {
    const base = 13 * b.idx;
    const thres = this.params[base + 11];
    b.sat = null;
    if (thres === 0) return;
    if (thres > 0) throw new Error('SGv2 saturation type B not ported');
    const k = [thres, this.params[base + 12], b.post, b.d58].join(',');
    let t = satCache.get(k);
    if (!t) {
      t = buildSatTable(thres, this.params[base + 12], b.post, b.d58);
      satCache.set(k, t);
    }
    b.sat = t;
  }

  // -------------------------------------------------------------- audio

  /** Eff_Render(bus, bus, n): interleaved stereo in place. */
  process(bus: Float32Array, n: number): void {
    if (!this.preset || n <= 0) return;
    // silence gate
    let silent = true;
    for (let i = 0, m = 2 * n; i < m; i++) {
      const v = bus[i];
      if (!(v <= 9.999999974752427e-7 && v >= -9.999999974752427e-7)) {
        silent = false;
        break;
      }
    }
    if (silent) this.counter -= n;
    else this.counter = this.reload;
    if (-n >= this.counter) {
      if (this.counter > SILENT) this.reset();
      this.counter = SILENT;
      return;
    }
    if (this.lowCut) for (const q of this.lowCut) q.run(bus, bus, n);
    const os = this.os;
    let N = n;
    let inBuf = bus;
    if (os > 1) {
      this.upP.up(bus, 0, this.up, this.upTmp, n);
      inBuf = this.up;
      N = 2 * n;
    }
    const B = this.bands;
    for (let b = 0; b < 3; b++) {
      const band = B[b];
      let w25 = 0x7fffffff;
      let inp = inBuf;
      let x27: Float32Array;
      const fl = band.filters;
      if (this.first === b) {
        x27 = this.acc;
        if (fl.length === 0) for (let i = 0, m = 2 * N; i < m; i++) x27[i] = inp[i];
      } else {
        x27 = this.tmp;
        if (b === 1) {
          x27 = inBuf;
          w25 = Math.min(B[0].slope + 1, fl.length - 1);
        }
      }
      for (let j = 0; j < fl.length; j++) {
        if (j >= w25) x27 = this.tmp;
        fl[j].run(inp, x27, N);
        inp = x27;
      }
      this.band(band, x27, N, inBuf);
    }
    if (os > 1) this.downP.down(this.up, bus, N);
    this.band(B[3], bus, n, bus);
    this.snap = false;
  }

  private band(band: SgBand, x: Float32Array, N: number, inBuf: Float32Array): void {
    const b = band.idx;
    const lvl = this.lvl;
    if (band.mode < 2) {
      if (this.snap) band.mCur.set(band.mTgt);
      this.ramps(band, N, b === 3 ? this.rBase.step : this.rBand.step);
      this.matrixRun(x, N);
    }
    if (band.mode === 0) {
      if (band.rms) band.rmsDet.run(x, lvl, N);
      else band.peak.run(x, lvl, this.lvlI, N);
      const rel = band.rel, att = band.att;
      for (let k = 0; k < rel.length; k++) rel[k].run(lvl, N);
      this.lookup(band, N);
      for (let k = 0; k < att.length; k++) att[k].run(lvl, N);
    }
    band.delay.run(x, N);
    const m2 = 2 * N;
    if (this.mixOn && b < 3) {
      const dry = this.dry;
      for (let i = 0; i < m2; i++) dry[i] = x[i];
    }
    if (band.mode === 0) {
      for (let i = 0, j = 0; i < N; i++, j += 2) {
        const g = lvl[i];
        x[j] = f32(x[j] * g);
        x[j + 1] = f32(x[j + 1] * g);
      }
    } else {
      const g = band.post;
      for (let i = 0; i < m2; i++) x[i] = f32(x[i] * g);
    }
    if (band.sat && band.mode < 2) satA(x, m2, band.sat);
    if (b === 3) {
      if (band.mode === 2) x.fill(0, 0, m2);
      return;
    }
    const acc = this.acc;
    if (band.mode < 2) {
      if (this.mixOn) {
        const g = f32(this.mix * band.sign), gd = f32(f32(1 - this.mix) * band.sign), dry = this.dry;
        for (let i = 0; i < m2; i++) x[i] = f32(x[i] * g);
        for (let i = 0; i < m2; i++) x[i] = fma32(dry[i], gd, x[i]);
      } else if (band.sign === -1) {
        for (let i = 0; i < m2; i++) x[i] = -x[i];
      }
      if (b === 2) {
        for (let i = 0; i < m2; i++) inBuf[i] = f32(x[i] + acc[i]);
      } else if (acc !== x) {
        for (let i = 0; i < m2; i++) acc[i] = f32(acc[i] + x[i]);
      }
    } else {
      if (acc === x) x.fill(0, 0, m2);
      if (b === 2) for (let i = 0; i < m2; i++) inBuf[i] = acc[i];
    }
  }

  /** 4 x 0x77be0: per-block linear ramps of the matrix toward its targets. */
  private ramps(band: SgBand, N: number, step: number): void {
    const cur = band.mCur, tgt = band.mTgt, start = this.start, delta = this.delta;
    const fn = f32(N);
    for (let k = 0; k < 4; k++) {
      const s = cur[k];
      start[k] = s;
      let d = f32(tgt[k] - s);
      if (bits(d) !== 0) {
        cur[k] = tgt[k];
        d = f32(d / fn);
        if (Math.abs(d) > step) {
          d = d < 0 || Object.is(d, -0) ? -step : step;
          const c = f32(s + f32(d * fn));
          if ((bits(c) & 0x7fffffff) < 0x33800000) {
            cur[k] = 0;
            d = f32(-s / fn);
          } else cur[k] = c;
        }
      }
      delta[k] = d;
    }
  }

  /** Kernel 0x47c4: L' = m0 L + m2 R, R' = m1 R + m3 L (m ramping by delta per frame). */
  private matrixRun(x: Float32Array, N: number): void {
    const d = this.delta, m = this.start;
    let m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
    if ((bits(d[0]) | bits(d[1]) | bits(d[2]) | bits(d[3])) !== 0) {
      const d0 = d[0], d1 = d[1], d2 = d[2], d3 = d[3];
      for (let i = 0, j = 0; i < N; i++, j += 2) {
        const l = x[j], r = x[j + 1];
        x[j] = f32(f32(m0 * l) + f32(m2 * r));
        x[j + 1] = f32(f32(m1 * r) + f32(m3 * l));
        m0 = f32(m0 + d0);
        m1 = f32(m1 + d1);
        m2 = f32(m2 + d2);
        m3 = f32(m3 + d3);
      }
    } else if ((bits(m2) | bits(m3)) !== 0) {
      for (let i = 0, j = 0; i < N; i++, j += 2) {
        const l = x[j], r = x[j + 1];
        x[j] = f32(f32(m0 * l) + f32(m2 * r));
        x[j + 1] = f32(f32(m1 * r) + f32(m3 * l));
      }
    } else if (m0 !== 1 || m1 !== 1) {
      for (let i = 0, j = 0; i < N; i++, j += 2) {
        x[j] = f32(m0 * x[j]);
        x[j + 1] = f32(m1 * x[j + 1]);
      }
    }
  }

  /** Eff_Render 0x6b404..0x6b55c: level -> gain through the curve table. */
  private lookup(band: SgBand, N: number): void {
    const lvl = this.lvl, ct = band.curve!, tab = ct.table, tmax = ct.tmax;
    const pm = f32(8192.25 * band.pre);
    const s5 = f32(ct.top * band.post);
    const s0 = f32(band.pre * band.post);
    for (let i = 0; i < N; i++) {
      const L = lvl[i];
      const P = f32(L * pm);
      // vDSP_vfix32 (truncation, saturating), then ippsThreshold_LT_32s_I(0)
      let I = P >= 2147483647 ? 2147483647 : P !== P ? 0 : Math.trunc(P);
      if (I < 0) I = 0;
      if (I > tmax) lvl[i] = f32(s5 / L);
      else {
        const t0 = tab[I];
        lvl[i] = f32(f32(t0 + f32(f32(tab[I + 1] - t0) * f32(P - I))) * s0);
      }
    }
  }
}

/** Kernel 0x76a20: odd table shaper with linear interpolation, 65536 steps. */
function satA(x: Float32Array, n: number, s: SatTable): void {
  const tab = s.table, so = s.outScale;
  const si = f32(s.inScale * 65536);
  for (let i = 0; i < n; i++) {
    const v = f32(x[i] * si);
    let k = Math.trunc(v) | 0;
    const fr = f32(v - f32(k));
    let y: number;
    if (k < 0) {
      k = -k | 0;
      if (k > 65536) k = 65536;
      const t0 = tab[k];
      y = 0 - f32(t0 - f32(f32(tab[k + 1] - t0) * fr));
    } else {
      if (k > 65536) k = 65536;
      const t0 = tab[k];
      y = f32(t0 + f32(f32(tab[k + 1] - t0) * fr));
    }
    x[i] = f32(y * so);
  }
}
