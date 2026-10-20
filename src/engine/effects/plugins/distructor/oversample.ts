// Polyphase IIR half-band oversampling (2x stages cascaded up to 16x).
//
// Each 2x stage is a pair of allpass chains in z^-2 (Laurent de Soras'
// "HIIR" structure, coefficients from his elliptic design formula). The
// first stage (base rate <-> 2x) is steep (passband to 0.4535 fs, about
// 20 kHz at 44.1 kHz); the outer stages only need to reject images far above
// the audio band and are cheaper. The filters are IIR: no reported latency;
// an up + down round trip delays low frequencies by about 2.4 base-rate
// samples at 2x and 3.2 samples at 4x.
//
// Used with FL's own design (FL_HALFBAND: Fruity WaveShaper's and Distructor's
// oversampler). Blood Overdrive and Fast Dist run at the base rate like FL.
// Allocation-free after construction.

function transitionParams(tbw: number): [number, number] {
  let k = Math.tan((1 - tbw * 2) * (Math.PI / 4));
  k *= k;
  const kksqrt = Math.pow(1 - k * k, 0.25);
  const e = (0.5 * (1 - kksqrt)) / (1 + kksqrt);
  const e4 = e * e * e * e;
  const q = e * (1 + e4 * (2 + e4 * (15 + 150 * e4)));
  return [k, q];
}

function accNum(q: number, order: number, c: number): number {
  let acc = 0;
  for (let i = 0, j = 1; i < 64; i++, j = -j) {
    const v = Math.pow(q, i * (i + 1)) * Math.sin(((i * 2 + 1) * c * Math.PI) / order) * j;
    acc += v;
    if (Math.abs(v) <= 1e-100) break;
  }
  return acc;
}

function accDen(q: number, order: number, c: number): number {
  let acc = 0;
  for (let i = 1, j = -1; i < 64; i++, j = -j) {
    const v = Math.pow(q, i * i) * Math.cos((i * 2 * c * Math.PI) / order) * j;
    acc += v;
    if (Math.abs(v) <= 1e-100) break;
  }
  return acc;
}

/** Allpass coefficients of a polyphase half-band filter: `n` coefficients, transition band `tbw` (of the high rate). */
export function halfbandCoefs(n: number, tbw: number): Float64Array {
  const [k, q] = transitionParams(tbw);
  const order = n * 2 + 1;
  const out = new Float64Array(n);
  for (let idx = 0; idx < n; idx++) {
    const c = idx + 1;
    const num = accNum(q, order, c) * Math.pow(q, 0.25);
    const den = accDen(q, order, c) + 0.5;
    const ww = num / den;
    const wwsq = ww * ww;
    const x = Math.sqrt((1 - wwsq * k) * (1 - wwsq / k)) / (1 + wwsq);
    out[idx] = (1 - x) / (1 + x);
  }
  return out;
}

// stage designs: steep first stage (about 80 dB image rejection at 0.4535 fs,
// more than 110 dB below 0.36 fs), cheaper outer stages
const STEEP = halfbandCoefs(6, 0.0464);
const MID = halfbandCoefs(3, 0.25);
const LIGHT = halfbandCoefs(2, 0.3);

/** FL's own design (Fruity WaveShaper's oversampler): 6 coefficients, transition 0.1, the same at every stage. */
export const FL_HALFBAND = halfbandCoefs(6, 0.1);

function stageCoefs(stage: number, design?: Float64Array): Float64Array {
  if (design) return design;
  return stage === 0 ? STEEP : stage === 1 ? MID : LIGHT;
}

/** One 2x stage: x / y hold the previous input / output of every allpass section. */
class Stage {
  readonly c: Float64Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  constructor(c: Float64Array) {
    this.c = c;
    this.x = new Float64Array(c.length);
    this.y = new Float64Array(c.length);
  }
  reset(): void {
    this.x.fill(0);
    this.y.fill(0);
  }
  /** Runs the two allpass chains (even coefficients on path 0, odd on path 1); returns path 0, path 1 in out[o], out[o+1]. */
  run(a: number, b: number, out: Float64Array, o: number): void {
    const c = this.c, x = this.x, y = this.y, n = c.length;
    let p0 = a, p1 = b;
    for (let i = 0; i < n; i += 2) {
      const t0 = p0;
      p0 = (t0 - y[i]) * c[i] + x[i];
      x[i] = t0;
      y[i] = p0;
      if (i + 1 < n) {
        const t1 = p1;
        p1 = (t1 - y[i + 1]) * c[i + 1] + x[i + 1];
        x[i + 1] = t1;
        y[i + 1] = p1;
      }
    }
    out[o] = p0;
    out[o + 1] = p1;
  }
}

function log2Factor(factor: number): number {
  let s = 0;
  while ((1 << s) < factor && s < 4) s++;
  return s;
}

/** Upsampler by 1, 2, 4, 8 or 16. */
export class Upsampler {
  readonly factor: number;
  private stages: Stage[];
  private bufA: Float64Array;
  private bufB: Float64Array;
  /** `design`: one coefficient set for every stage (default: our steep-first cascade). */
  constructor(factor: number, design?: Float64Array) {
    const k = log2Factor(factor);
    this.factor = 1 << k;
    this.stages = Array.from({ length: k }, (_, s) => new Stage(stageCoefs(s, design)));
    this.bufA = new Float64Array(this.factor);
    this.bufB = new Float64Array(this.factor);
  }
  reset(): void {
    for (const s of this.stages) s.reset();
  }
  /** Writes `factor` samples for input `x` into out[0 .. factor-1]. */
  process(x: number, out: Float64Array): void {
    const st = this.stages;
    if (st.length === 0) { out[0] = x; return; }
    let src = this.bufA, dst = this.bufB;
    src[0] = x;
    let len = 1;
    for (let s = 0; s < st.length; s++) {
      const stage = st[s];
      for (let i = 0; i < len; i++) stage.run(src[i], src[i], dst, 2 * i);
      len *= 2;
      const t = src; src = dst; dst = t;
    }
    for (let i = 0; i < len; i++) out[i] = src[i];
  }
}

/** Downsampler by 1, 2, 4, 8 or 16 (input: `factor` consecutive high-rate samples). */
export class Downsampler {
  readonly factor: number;
  private stages: Stage[];
  private a: Float64Array;
  private pair: Float64Array;
  constructor(factor: number, design?: Float64Array) {
    const k = log2Factor(factor);
    this.factor = 1 << k;
    // processed from the highest rate down: stages[0] is the outermost
    this.stages = Array.from({ length: k }, (_, s) => new Stage(stageCoefs(k - 1 - s, design)));
    this.a = new Float64Array(this.factor);
    this.pair = new Float64Array(2);
  }
  reset(): void {
    for (const s of this.stages) s.reset();
  }
  process(inp: ArrayLike<number>): number {
    return this.processAt(inp, 0);
  }
  /** Same as process() with the input block starting at inp[off] (no subarray allocation). */
  processAt(inp: ArrayLike<number>, off: number): number {
    const st = this.stages;
    if (st.length === 0) return inp[off];
    const a = this.a, pair = this.pair;
    let len = this.factor;
    for (let i = 0; i < len; i++) a[i] = inp[off + i];
    for (let s = 0; s < st.length; s++) {
      const stage = st[s];
      const half = len >> 1;
      for (let i = 0; i < half; i++) {
        stage.run(a[2 * i + 1], a[2 * i], pair, 0);
        a[i] = 0.5 * (pair[0] + pair[1]);
      }
      len = half;
    }
    return a[0];
  }
}
