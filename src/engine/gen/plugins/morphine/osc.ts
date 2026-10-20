// Morphine's per-voice oscillator bank (CMorGenerator voice+0xd0; Osc_SetPartials
// 0xf420 per spectrum update, renderers 0x8658..0xf218 per chunk, gain spline
// 0xfb70 per control block): up to 128 "magic circle" sine oscillators
//   A -= B*W; GL += dGL; GR += dGR; accL += A*GL; accR += A*GR; B += A*W; W += dW
// in float32 with fused multiply-adds, mixed with the voice amplitude spline.
// Active partials are compacted in partial order into slots; the slot count
// rounded up to a multiple of 16 selects one of 8 NEON renderers, which sum
// the 4-lane products in a renderer-specific vector order (ORDER below,
// extracted from the binary by symbolic execution: .flref/morphine/port/symacc.py)
// and then add the lanes as (l1 + l0) + (l2 + l3).

import { cos, sin } from '../harmor/fx-libm';
import { fmaD } from '../../../../model/gen/plugins/morphine/libm';

const f32 = Math.fround;
const NP = 128;
/**
 * Resolve the double-rounding ties of the emulated float FMAs exactly (bit-exact with FL; about 2.4x the
 * oscillator cost). Off: plain rounding, about once in 10^9 operations 1 float ulp off (inaudible).
 * Morphine turns it off for live playback only (GenContext.rendering === false) and keeps it on for
 * project export and direct renders, so exports stay bit-exact while live playback stays light.
 */
let exactFma = true;

/** Exact FMA tie resolution on (export, tests) or off (live playback). Shared by every oscillator in this realm. */
export function setExactFma(on: boolean): void {
  exactFma = on;
}

/**
 * float fused multiply-add a * b + c (arm64 FMADD Sd) for float inputs: a * b is exact in double, so
 * a * b + c rounds once to double and rounding that to float is exact unless the double lies exactly
 * halfway between two floats (then o = 2s - r is a float): the exact sum decides (fmaTie).
 */
export function fmaf(a: number, b: number, c: number): number {
  const s = a * b + c, r = f32(s);
  if (r === s) return r;
  const o = s + s - r;
  return f32(o) === o ? fmaTie(a, b, c) : r;
}

function fmaTie(a: number, b: number, c: number): number {
  const p = a * b, s = p + c, r = f32(s);
  if (r === s) return r;
  const o = 2 * s - r;
  if (f32(o) !== o) return r;
  const bb = s - p;
  const e = (p - (s - bb)) + (c - bb);
  if (e === 0) return r;
  return (e > 0) === (o > r) ? o : r;
}

/** Vector accumulation order of the renderers for 4..32 vectors (16..128 slots). */
const ORDER: Int32Array[] = [];
ORDER[4] = Int32Array.from([0, 1, 2, 3]);
ORDER[8] = Int32Array.from([2, 1, 3, 4, 0, 5, 6, 7]);
ORDER[12] = Int32Array.from([3, 4, 2, 5, 6, 1, 7, 8, 0, 9, 10, 11]);
ORDER[16] = Int32Array.from([5, 4, 6, 7, 3, 8, 2, 9, 10, 1, 11, 12, 0, 13, 14, 15]);
ORDER[20] = Int32Array.from([6, 7, 5, 8, 9, 4, 10, 11, 3, 12, 2, 13, 14, 1, 15, 16, 0, 17, 18, 19]);
ORDER[24] = Int32Array.from([8, 7, 9, 10, 6, 11, 5, 12, 13, 4, 14, 15, 3, 16, 2, 17, 18, 1, 19, 20, 0, 21, 22, 23]);
ORDER[28] = Int32Array.from([9, 10, 8, 11, 12, 7, 13, 14, 6, 15, 5, 16, 17, 4, 18, 19, 3, 20, 2, 21, 22, 1, 23, 24, 0, 25, 26, 27]);
ORDER[32] = Int32Array.from([11, 10, 12, 13, 9, 14, 8, 15, 16, 7, 17, 18, 6, 19, 5, 20, 21, 4, 22, 23, 3, 24, 2, 25, 26, 1, 27, 28, 0, 29, 30, 31]);
/** Slot order (4v + lane) per vector count, flattened. */
const SLOTS: Int32Array[] = [];
for (const n of [4, 8, 12, 16, 20, 24, 28, 32]) {
  const s = new Int32Array(n * 4);
  for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) s[i * 4 + j] = ORDER[n][i] * 4 + j;
  SLOTS[n] = s;
}

/** Processing position of slot w for a slot count (4 x vectors): the inverse of SLOTS. */
const POS: Int32Array[] = [];
for (const n of [4, 8, 12, 16, 20, 24, 28, 32]) {
  const p = new Int32Array(n * 4);
  for (let i = 0; i < n * 4; i++) p[SLOTS[n][i]] = i;
  POS[n] = p;
}

const TWO_PI = 6.283185307179586;
const PI = 3.141592653589793;
const FMAX = 0.4535;
const TILT = -1.323042998897464;
const T1E6 = 1e-6;
const FL1E9 = f32(1e-9);

export class OscBank {
  /** FL L / R volume of the voice's key (osc+0 / +4). */
  gL = 1;
  gR = 1;
  /** Slot of each partial (-1 = inactive). */
  readonly slot = new Int16Array(NP).fill(-1);
  /** Rounded active slot count (16..128, 0 = silent). */
  count = 0;
  /** Theoretical phase of each partial (double, cycles). */
  readonly phase = new Float64Array(NP);
  /**
   * Oscillator state, two sets swapped at each update (FL's +0x4d0 / +0x4f8 sets): per slot
   * [A, B, W, GL, GR, dGL, dGR, dW], stored in the renderer's processing order (POS) rather than
   * slot order, so the render loop runs straight through.
   */
  private readonly st = [new Float32Array(NP * 8), new Float32Array(NP * 8)];
  private cur = 0;
  /** All per-sample increments of the current update are 0 (static spectrum). */
  private still = false;
  // per-update scratch, indexed by slot
  private readonly tA = new Float32Array(NP);
  private readonly tB = new Float32Array(NP);
  private readonly tW = new Float32Array(NP);
  private readonly tGL = new Float32Array(NP);
  private readonly tGR = new Float32Array(NP);
  private readonly tdGL = new Float32Array(NP);
  private readonly tdGR = new Float32Array(NP);
  private readonly tdW = new Float32Array(NP);
  // amplitude spline (Catmull-Rom over the control-block values)
  private y0 = 0;
  private y1 = 0;
  private y2 = 0;
  private y3 = 0;
  private c0 = 0;
  private c1 = 0;
  private c2 = 0;
  private c3 = 0;
  private dt = 0;
  private t = 0;

  constructor() {
    this.reset();
  }

  /** Osc_Reset 0x84b8. */
  reset(): void {
    this.count = 0;
    this.y0 = this.y1 = this.y2 = this.y3 = 0;
    this.c0 = this.c1 = this.c2 = this.c3 = 0;
    this.dt = this.t = 0;
    this.slot.fill(-1);
    this.phase.fill(0);
    this.st[0].fill(0);
    this.st[1].fill(0);
    this.still = false;
  }

  /** Osc_SetGainCatmull 0xfb70: the voice amplitude of the coming control block. */
  setGain(v: number, n: number): void {
    const y0 = this.y1, y1 = this.y2, y2 = this.y3, y3 = v;
    this.y0 = y0; this.y1 = y1; this.y2 = y2; this.y3 = y3;
    this.c0 = y1;
    const c1 = f32(f32(y2 - y0) * 0.5);
    this.c1 = c1;
    const c3 = f32(f32(y1 - y2) * 1.5 + f32(y3 - y0) * 0.5);
    this.c3 = c3;
    this.c2 = f32(f32(y0 + c1) - f32(y1 + c3));
    this.t = 0;
    this.dt = f32(1 / n);
  }

  /**
   * Osc_SetPartials 0xf420: targets for the next n samples from the voice
   * spectrum (amp, pan -1..1, ratio), base frequency hz (double, pitch factor
   * included), pan modulation and sample rate.
   */
  setPartials(amp: Float32Array, pan: Float32Array, ratio: Float32Array, n: number, hz: number, panMod: number, sr: number): void {
    const old = this.st[this.cur];
    const oldPos = this.count >= 16 ? POS[this.count >> 2] : null;
    const { tA, tB, tW, tGL, tGR, tdGL, tdGR, tdW } = this;
    const slot = this.slot, phase = this.phase;
    const fmax = FMAX * sr, dn = n, invSr = 1 / sr, invN = f32(1 / f32(n));
    const gL = this.gL, gR = this.gR;
    let w = 0, still = true;
    for (let k = 0; k < NP; k++) {
      const s = slot[k];
      const a = amp[k];
      let p = f32(f32(pan[k] + panMod) * 0.5 + 0.5); // fmadd (x*0.5 exact)
      if (!(p > 0)) p = 0;
      if (p > 1) p = 1;
      const la = f32(gL * a);
      let tl = fmaf(-p, la, la);
      let tr = f32(f32(gR * a) * p);
      let fr = ratio[k] * hz;
      if (!(fr >= 1)) fr = 1;
      if (fr > fmax) { tl = 0; tr = 0; fr = fmax; }
      const oldPh = phase[k];
      const ph = fmaD(fr * dn, invSr, oldPh);
      phase[k] = ph >= 1 ? ph - Math.trunc(ph) : ph;
      const o8 = s >= 0 && oldPos ? oldPos[s] * 8 : -1;
      let sGL = 0, sGR = 0;
      if (o8 >= 0) { sGL = old[o8 + 3]; sGR = old[o8 + 4]; }
      const tilt = f32(fmaD(fr * TILT, invSr, 1));
      tl = f32(tl * tilt);
      tr = f32(tr * tilt);
      if (Math.abs(tl) < T1E6 && Math.abs(tr) < T1E6 && Math.abs(sGL) < T1E6 && Math.abs(sGR) < T1E6) {
        slot[k] = -1;
        continue;
      }
      // W target 2 sin(pi f / sr) (FL computes it for every partial; only active ones use it)
      const sn = f32(sin(fr * PI * invSr));
      const wt = f32(sn + sn);
      let A: number, B: number, W: number;
      if (o8 >= 0) { A = old[o8]; B = old[o8 + 1]; W = old[o8 + 2]; }
      else { const x = oldPh * TWO_PI; A = f32(cos(x)); B = f32(sin(x)); W = wt; }
      let d = f32(f32(tl - sGL) * invN);
      d = d > -FL1E9 && d < FL1E9 ? 0 : d;
      tdGL[w] = d;
      let e = f32(f32(tr - sGR) * invN);
      e = e > -FL1E9 && e < FL1E9 ? 0 : e;
      tdGR[w] = e;
      let g = f32(f32(wt - W) * invN);
      g = g > -FL1E9 && g < FL1E9 ? 0 : g;
      tdW[w] = g;
      if (d !== 0 || e !== 0 || g !== 0) still = false;
      tGL[w] = sGL; tGR[w] = sGR; tW[w] = W; tA[w] = A; tB[w] = B;
      slot[k] = w;
      w++;
    }
    let cnt = 0;
    if (w) { cnt = w & ~15; if (cnt < w) cnt += 16; if (cnt > 128) cnt = 128; }
    this.count = cnt;
    this.cur ^= 1;
    if (cnt) {
      const nw = this.st[this.cur], pos = POS[cnt >> 2];
      for (let i = 0; i < w; i++) {
        const b = pos[i] * 8;
        nw[b] = tA[i]; nw[b + 1] = tB[i]; nw[b + 2] = tW[i]; nw[b + 3] = tGL[i];
        nw[b + 4] = tGR[i]; nw[b + 5] = tdGL[i]; nw[b + 6] = tdGR[i]; nw[b + 7] = tdW[i];
      }
      for (let i = w; i < cnt; i++) nw.fill(0, pos[i] * 8, pos[i] * 8 + 8);
    }
    this.still = still;
  }

  /** Osc_RenderDispatch 0x8600: add n samples into L / R at off (out = fma(sum, spline, out)). */
  render(L: Float32Array, R: Float32Array, off: number, n: number): void {
    const cnt = this.count;
    if (cnt < 16) return;
    if (!exactFma) { this.renderFast(L, R, off, n); return; }
    const st = this.st[this.cur], end = cnt * 8, still = this.still;
    const c0 = this.c0, c1 = this.c1, c2 = this.c2, c3 = this.c3, dt = this.dt;
    let t = this.t;
    // Every fused op: s = x*y + z rounds once to double; f32(s) is the fused float result unless s is
    // exactly halfway between two floats (then o = 2s - r is a float): fmaTie decides from the exact sum.
    let s = 0, r = 0, o = 0, a = 0, ak = 0, bk = 0, wk = 0, gl = 0, gr = 0;
    for (let i = 0; i < n; i++) {
      let l0 = 0, l1 = 0, l2 = 0, l3 = 0, r0 = 0, r1 = 0, r2 = 0, r3 = 0;
      for (let b = 0; b < end; b += 32) {
        ak = st[b]; bk = st[b + 1]; wk = st[b + 2];
        s = ak - bk * wk; a = f32(s);
        if (a !== s) { o = s + s - a; if (f32(o) === o) a = fmaTie(-bk, wk, ak); }
        if (still) { gl = st[b + 3]; gr = st[b + 4]; } else { gl = f32(st[b + 3] + st[b + 5]); gr = f32(st[b + 4] + st[b + 6]); }
        s = a * gl + l0; r = f32(s); if (r !== s) { o = s + s - r; if (f32(o) === o) r = fmaTie(a, gl, l0); } l0 = r;
        s = a * gr + r0; r = f32(s); if (r !== s) { o = s + s - r; if (f32(o) === o) r = fmaTie(a, gr, r0); } r0 = r;
        s = a * wk + bk; r = f32(s); if (r !== s) { o = s + s - r; if (f32(o) === o) r = fmaTie(a, wk, bk); }
        st[b] = a; st[b + 1] = r;
        if (!still) { st[b + 2] = wk + st[b + 7]; st[b + 3] = gl; st[b + 4] = gr; }
        ak = st[b + 8]; bk = st[b + 9]; wk = st[b + 10];
        s = ak - bk * wk; a = f32(s);
        if (a !== s) { o = s + s - a; if (f32(o) === o) a = fmaTie(-bk, wk, ak); }
        if (still) { gl = st[b + 11]; gr = st[b + 12]; } else { gl = f32(st[b + 11] + st[b + 13]); gr = f32(st[b + 12] + st[b + 14]); }
        s = a * gl + l1; r = f32(s); if (r !== s) { o = s + s - r; if (f32(o) === o) r = fmaTie(a, gl, l1); } l1 = r;
        s = a * gr + r1; r = f32(s); if (r !== s) { o = s + s - r; if (f32(o) === o) r = fmaTie(a, gr, r1); } r1 = r;
        s = a * wk + bk; r = f32(s); if (r !== s) { o = s + s - r; if (f32(o) === o) r = fmaTie(a, wk, bk); }
        st[b + 8] = a; st[b + 9] = r;
        if (!still) { st[b + 10] = wk + st[b + 15]; st[b + 11] = gl; st[b + 12] = gr; }
        ak = st[b + 16]; bk = st[b + 17]; wk = st[b + 18];
        s = ak - bk * wk; a = f32(s);
        if (a !== s) { o = s + s - a; if (f32(o) === o) a = fmaTie(-bk, wk, ak); }
        if (still) { gl = st[b + 19]; gr = st[b + 20]; } else { gl = f32(st[b + 19] + st[b + 21]); gr = f32(st[b + 20] + st[b + 22]); }
        s = a * gl + l2; r = f32(s); if (r !== s) { o = s + s - r; if (f32(o) === o) r = fmaTie(a, gl, l2); } l2 = r;
        s = a * gr + r2; r = f32(s); if (r !== s) { o = s + s - r; if (f32(o) === o) r = fmaTie(a, gr, r2); } r2 = r;
        s = a * wk + bk; r = f32(s); if (r !== s) { o = s + s - r; if (f32(o) === o) r = fmaTie(a, wk, bk); }
        st[b + 16] = a; st[b + 17] = r;
        if (!still) { st[b + 18] = wk + st[b + 23]; st[b + 19] = gl; st[b + 20] = gr; }
        ak = st[b + 24]; bk = st[b + 25]; wk = st[b + 26];
        s = ak - bk * wk; a = f32(s);
        if (a !== s) { o = s + s - a; if (f32(o) === o) a = fmaTie(-bk, wk, ak); }
        if (still) { gl = st[b + 27]; gr = st[b + 28]; } else { gl = f32(st[b + 27] + st[b + 29]); gr = f32(st[b + 28] + st[b + 30]); }
        s = a * gl + l3; r = f32(s); if (r !== s) { o = s + s - r; if (f32(o) === o) r = fmaTie(a, gl, l3); } l3 = r;
        s = a * gr + r3; r = f32(s); if (r !== s) { o = s + s - r; if (f32(o) === o) r = fmaTie(a, gr, r3); } r3 = r;
        s = a * wk + bk; r = f32(s); if (r !== s) { o = s + s - r; if (f32(o) === o) r = fmaTie(a, wk, bk); }
        st[b + 24] = a; st[b + 25] = r;
        if (!still) { st[b + 26] = wk + st[b + 31]; st[b + 27] = gl; st[b + 28] = gr; }
      }
      // spline ((c3 t + c2) t + c1) t + c0 (fused) at t, then t += dt
      let p = fmaf(t, c3, c2);
      p = fmaf(p, t, c1);
      const tn = f32(dt + t);
      p = fmaf(p, t, c0);
      t = tn;
      const sl = f32(f32(l1 + l0) + f32(l2 + l3));
      L[off + i] = fmaf(sl, p, L[off + i]);
      const sr = f32(f32(r1 + r0) + f32(r2 + r3));
      R[off + i] = fmaf(sr, p, R[off + i]);
    }
    this.t = t;
  }

  /** The same with plain double-then-float rounding of the fused ops (exact FMA off: ~2.4x faster, rare 1-ulp ties). */
  private renderFast(L: Float32Array, R: Float32Array, off: number, n: number): void {
    const st = this.st[this.cur], end = this.count * 8;
    const c0 = this.c0, c1 = this.c1, c2 = this.c2, c3 = this.c3, dt = this.dt;
    let t = this.t, a = 0, gl = 0, gr = 0, wk = 0;
    for (let i = 0; i < n; i++) {
      let l0 = 0, l1 = 0, l2 = 0, l3 = 0, r0 = 0, r1 = 0, r2 = 0, r3 = 0;
      for (let b = 0; b < end; b += 32) {
        wk = st[b + 2]; a = f32(st[b] - st[b + 1] * wk); gl = f32(st[b + 3] + st[b + 5]); gr = f32(st[b + 4] + st[b + 6]);
        l0 = f32(a * gl + l0); r0 = f32(a * gr + r0);
        st[b + 1] = a * wk + st[b + 1]; st[b + 2] = wk + st[b + 7]; st[b] = a; st[b + 3] = gl; st[b + 4] = gr;
        wk = st[b + 10]; a = f32(st[b + 8] - st[b + 9] * wk); gl = f32(st[b + 11] + st[b + 13]); gr = f32(st[b + 12] + st[b + 14]);
        l1 = f32(a * gl + l1); r1 = f32(a * gr + r1);
        st[b + 9] = a * wk + st[b + 9]; st[b + 10] = wk + st[b + 15]; st[b + 8] = a; st[b + 11] = gl; st[b + 12] = gr;
        wk = st[b + 18]; a = f32(st[b + 16] - st[b + 17] * wk); gl = f32(st[b + 19] + st[b + 21]); gr = f32(st[b + 20] + st[b + 22]);
        l2 = f32(a * gl + l2); r2 = f32(a * gr + r2);
        st[b + 17] = a * wk + st[b + 17]; st[b + 18] = wk + st[b + 23]; st[b + 16] = a; st[b + 19] = gl; st[b + 20] = gr;
        wk = st[b + 26]; a = f32(st[b + 24] - st[b + 25] * wk); gl = f32(st[b + 27] + st[b + 29]); gr = f32(st[b + 28] + st[b + 30]);
        l3 = f32(a * gl + l3); r3 = f32(a * gr + r3);
        st[b + 25] = a * wk + st[b + 25]; st[b + 26] = wk + st[b + 31]; st[b + 24] = a; st[b + 27] = gl; st[b + 28] = gr;
      }
      let p = f32(t * c3 + c2);
      p = f32(p * t + c1);
      const tn = f32(dt + t);
      p = f32(p * t + c0);
      t = tn;
      const sl = f32(f32(l1 + l0) + f32(l2 + l3));
      L[off + i] = sl * p + L[off + i];
      const sr = f32(f32(r1 + r0) + f32(r2 + r3));
      R[off + i] = sr * p + R[off + i];
    }
    this.t = t;
  }
}
