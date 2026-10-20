// Fast Dist DSP core (FL: Fruity Fast Dist), shared with Distructor.
//
// FL's Fast Dist does no DSP itself: on every change of pre amp / mix / post
// its ProcessParam computes three single-precision gains, and Eff_Render
// hands the block to the host's DistWave_32FM (the "TS404" table distortion
// in FLEngine). The table and the two kernels are ported from the bit-exact
// reimplementation in the scratchpad test host (reverse-engineered from
// FLEngine_x64.dylib; see docs/research/fx/fastdist.md):
//
//   tables[type][thres] : 8192 int16 points of a curve on |x| in [0, 1]
//     type A (0): above -25 dB the level is compressed by (k+1)/10, then
//                 (9-k)*1.6 dB of make-up gain;      k = 10 - thres
//     type B (1): the attenuation in dB is raised to 0.8 + 0.02 k
//   out = x * dry + sign(x) * T(|x| * mul) * wet / 32768
//
// FL's host truncates the table index during playback and interpolates
// linearly when it exports with "HQ for all plugins" (FxContext.rendering).
// Both kernels run in FL's single precision with FL's operation order, so
// the output is FL's bit for bit. No smoothing, no oversampling: gain, type
// and threshold changes apply at the next block, as in FL.

const SIZE = 8191;
const TO_DB = 8.685889638065035;
const FROM_DB = 0.1151292546497023;
const f32 = Math.fround;
const LN11 = f32(Math.log(11));
const TENTH = f32(0.1);
const INV32768 = 3.0517578125e-5;

/** Round half to even (the C rint FL's table generator uses). */
function rint(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

const tables: (Int16Array | undefined)[] = new Array(20);

/** FL's curve for type 0 (A) / 1 (B) and threshold 1..10: entries 0..8191 plus a guard copy at 8192. */
export function distTable(type: number, thres: number): Int16Array {
  const ty = type >= 1 ? 1 : 0;
  const th = Math.max(1, Math.min(10, Math.round(thres)));
  const key = ty * 10 + th - 1;
  const hit = tables[key];
  if (hit) return hit;
  const k = 10 - th;
  const comp = (k + 1) * 0.1;
  const gain = (9 - k) * 1.6;
  const ex = 0.8 + k * 0.02;
  const t = new Int16Array(SIZE + 2);
  for (let j = 0; j <= SIZE; j++) {
    const x = j / SIZE;
    if (ty === 0) {
      let db = x === 0 ? -10000 : Math.log(x) * TO_DB;
      if (!(db < -25)) db = -25 + (db + 25) * comp;
      if (!(db > -gain)) db += gain;
      t[j] = rint(Math.exp(db * FROM_DB) * 32767);
    } else {
      const db2 = x === 0 ? -1000 : Math.log(x) * TO_DB;
      const base = -db2;
      const pw = base === 0 ? 0 : Math.exp(ex * Math.log(base));
      t[j] = rint(Math.exp(-pw * FROM_DB) * 32767);
    }
  }
  t[SIZE + 1] = t[SIZE];
  tables[key] = t;
  return t;
}

/**
 * FL's knob law for the 0..128 (and 64..192) gain wheels, (11^(v/128) - 1) / 10,
 * as Fast Dist computes it: single precision except the exp, exactly 1 at 128.
 */
export function fastDistGain(v: number): number {
  const s = f32(v * 0.0078125);
  if (s === 1) return 1;
  return f32((Math.exp(f32(s * LN11)) - 1) * TENTH);
}

/** FL's gains for the raw pre amp / mix / post values: [dry, wet, mul]. */
export function fastDistGains(preAmp: number, mix: number, post: number, out: Float64Array): Float64Array {
  const mul = fastDistGain(preAmp), pg = fastDistGain(post), mx = fastDistGain(mix);
  const wet = f32(mx * pg);
  out[0] = f32(f32(f32(pg - wet) * mul) * pg);
  out[1] = wet;
  out[2] = mul;
  return out;
}

/** low 32 bits (signed) of the int64 conversion FL's kernels use (truncation, saturating). */
function int32Of(s: number): number {
  if (s >= 9223372036854775807) return -1;
  if (s <= -9223372036854775808) return 0;
  return s | 0; // NaN -> 0
}

/** FL's live DistWave kernel (truncating lookup), in place. */
export function distWaveLQ(buf: Float32Array, n: number, t: Int16Array, dry: number, wet: number, mul: number): void {
  const m = f32(mul * SIZE), w = f32(wet * INV32768), d = f32(dry);
  for (let i = 0; i < n; i++) {
    const x = buf[i];
    const a = f32((x < 0 ? -x : x) * m);
    let idx = a >= 9223372036854775807 ? SIZE : Math.trunc(a);
    if (idx > SIZE) idx = SIZE;
    const v = t[idx];
    const y = x < 0 && v !== 0 ? -v : v;
    buf[i] = f32(f32(x * d) + f32(y * w));
  }
}

/** FL's export DistWave kernel (linear interpolation), in place. */
export function distWaveHQ(buf: Float32Array, n: number, t: Int16Array, dry: number, wet: number, mul: number): void {
  const m = f32(mul * SIZE), w = f32(wet * INV32768), d = f32(dry);
  for (let i = 0; i < n; i++) {
    const x = buf[i];
    const s3 = f32(x * m);
    let k = int32Of(s3);
    const frac = f32(s3 - f32(k));
    const dp = f32(x * d);
    let y: number;
    if (k < 0) {
      let kk = -k;
      if (kk > SIZE) kk = SIZE;
      const a = t[kk];
      y = f32(0 - f32(a - f32(f32(t[kk + 1] - a) * frac)));
    } else {
      if (k > SIZE) k = SIZE;
      const a = t[k];
      y = f32(a + f32(f32(t[k + 1] - a) * frac));
    }
    buf[i] = f32(dp + f32(y * w));
  }
}

const one = new Float32Array(1);

/** One static transfer value (the editor's curve): FL's interpolating kernel by default. */
export function fastDistCurve(x: number, type: number, thres: number, dry: number, wet: number, mul: number, hq = true): number {
  one[0] = x;
  (hq ? distWaveHQ : distWaveLQ)(one, 1, distTable(type, thres), dry, wet, mul);
  return one[0];
}

export interface FastDistParams {
  /** FL's raw values: pre amp 64..192, threshold 1..10, type 0/1, mix 0..128, post 0..128. */
  preAmp: number;
  thres: number;
  type: number;
  mix: number;
  post: number;
}

export class FastDistCore {
  private tab: Int16Array = distTable(0, 10);
  private readonly g = new Float64Array(3);

  set(p: FastDistParams): void {
    fastDistGains(clamp(Math.round(p.preAmp), 64, 192), clamp(Math.round(p.mix), 0, 128), clamp(Math.round(p.post), 0, 128), this.g);
    this.tab = distTable(p.type >= 0.5 ? 1 : 0, clamp(Math.round(p.thres), 1, 10));
  }

  /** In place, both channels (FL runs the interleaved block as one stream; the kernel is memoryless). */
  process(L: Float32Array, R: Float32Array, n: number, hq: boolean): void {
    for (let i = 0; i < n; i++) {
      // NaN / Inf input -> 0 (keeps the output finite; FL would pass NaN on)
      if (L[i] - L[i] !== 0) L[i] = 0;
      if (R[i] - R[i] !== 0) R[i] = 0;
    }
    const kernel = hq ? distWaveHQ : distWaveLQ;
    const g = this.g;
    kernel(L, n, this.tab, g[0], g[1], g[2]);
    kernel(R, n, this.tab, g[0], g[1], g[2]);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
