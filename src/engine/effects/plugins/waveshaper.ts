// WaveShaper (FL: Fruity WaveShaper): an FL envelope used as a transfer
// curve, rendered into FL's int16 table and applied with FL's kernels,
// optionally oversampled with FL's own half-band filters, then FL's
// "Center" DC remover. Translated from FL's plugin code; see
// docs/research/fx/waveshaper.md.
//
//   table: unipolar 16384 points over |x| in 0..1 (rint(y * 32767)),
//          bipolar  32768 points over x in -1..1 (rint((y - 0.5) * 65535))
//   out = x * dry + T(x * mul) * wet / 32768
//   mul = (4^(pre/128) - 1) / 3, post = (11^(post/128) - 1) / 10,
//   wet = mix/128 * post, dry = (1 - mix/128) * post^2 * mul
//   HQ off: truncating lookup (FL's "-85 dB" dead zone), HQ on: interpolating
//   oversampling 2^k with FL's 6-coefficient polyphase half-bands (HIIR, transition 0.1)
//   Smooth off: the gains change at the next block (FL steps them, no de-zipping)
//   Smooth on: gains glide 5 ms to -20 dB per (oversampled) frame, in single
//     precision, from where they were the last time Smooth ran (0 for a new
//     plugin: FL's state load fades in from silence)
//   Export (FxContext.rendering = FL's "HQ for all plugins"): interpolating
//     lookup, and any oversampling becomes 16x (1x stays 1x), as FL measured

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import { wsAutoPoints, wsCurve, wsCurveValue, wsPostGain, wsPreGain, type WsPoint } from '../../../model/fx/plugins/waveshaper';
import { Downsampler, FL_HALFBAND, Upsampler } from './distructor/oversample';

const TINY = 5.960464477539063e-8;
const f32 = Math.fround;

function rint(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** FL's int16 curve table (guard copies at index 0 and size + 2; entry i at index i + 1). */
export function wsTable(curve: WsPoint[], bipolar: boolean): { tab: Int16Array; size: number } {
  const pts = wsAutoPoints(curve);
  const size = (bipolar ? 32768 : 16384) - 1;
  const scale = bipolar ? 65535 : 32767;
  const center = bipolar ? 0.5 : 0;
  const tab = new Int16Array(size + 3);
  const step = 1 / size;
  for (let i = 0; i <= size; i++) {
    const v = wsCurveValue(pts, i * step) - center;
    let q = rint(v * scale);
    if (q < -32768) q = -32768; else if (q > 32767) q = 32767;
    tab[i + 1] = q;
  }
  tab[0] = tab[1];
  tab[size + 2] = tab[size + 1];
  return { tab, size };
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d;
}

class WaveShaper implements EffectInstance {
  private sr: number;
  private tab: Int16Array;
  private size: number;
  private curveRef: unknown = null;
  private bipolar = false;
  private hq = false;
  private smooth = false;
  private center = false;
  private osIndex = -1;
  private F = 1;
  private up: Upsampler[] = [];
  private down: Downsampler[] = [];
  /** FL's export oversampling (16x, used when rendering with oversampling on). */
  private readonly up16 = [new Upsampler(16, FL_HALFBAND), new Upsampler(16, FL_HALFBAND)];
  private readonly down16 = [new Downsampler(16, FL_HALFBAND), new Downsampler(16, FL_HALFBAND)];
  private bufL: Float64Array;
  private bufR: Float64Array;
  // gains: targets (stepped per block without Smooth) and FL's smoothed values (0 at creation)
  private tDry = 0;
  private tWet = 1;
  private tMul = 1;
  private dry = 0;
  private wet = 0;
  private mul = 0;
  private kSmooth: number; // FL's 5 ms to -20 dB, per frame of the (oversampled) buffer
  // Center: FL's second-order DC tracker per channel
  private dcA: number;
  private dc = new Float64Array(4);
  // editor level display (FL: input peak x pre gain, held 2 s, then falls quadratically)
  private level = 0;
  private hold = 0;
  private monPeak = 0;

  constructor(sampleRate: number, blockSize: number) {
    this.sr = sampleRate;
    const t = wsTable(wsCurve(null), false);
    this.tab = t.tab;
    this.size = t.size;
    // FL: k = 1 - Power(0.1, 1 / (0.005 sr)) in double (FPC's exp(e ln b)), stored as single
    this.kSmooth = f32(1 - Math.exp((1 / (0.005 * sampleRate)) * Math.log(0.09999999999999998)));
    this.dcA = 2.2834999999999997e-5 * (44100 / sampleRate);
    this.bufL = new Float64Array(16 * Math.max(128, blockSize));
    this.bufR = new Float64Array(16 * Math.max(128, blockSize));
    this.setOversampling(0);
  }

  private setOversampling(index: number): void {
    const k = Math.max(0, Math.min(4, Math.round(index)));
    if (k === this.osIndex) return;
    this.osIndex = k;
    this.F = 1 << k;
    this.up = [new Upsampler(this.F, FL_HALFBAND), new Upsampler(this.F, FL_HALFBAND)];
    this.down = [new Downsampler(this.F, FL_HALFBAND), new Downsampler(this.F, FL_HALFBAND)];
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const bip = num(q.bipolar, 0) >= 0.5;
    if (q.curve !== this.curveRef || bip !== this.bipolar) {
      this.curveRef = q.curve;
      this.bipolar = bip;
      const t = wsTable(wsCurve(q.curve), bip);
      this.tab = t.tab;
      this.size = t.size;
    }
    this.hq = num(q.hq, 0) >= 0.5;
    this.smooth = num(q.smooth, 0) >= 0.5;
    this.center = num(q.center, 0) >= 0.5;
    this.setOversampling(num(q.oversample, 0));
    const mul = wsPreGain(Math.min(192, Math.max(64, num(q.pre, 128))));
    const post = wsPostGain(Math.min(128, Math.max(0, num(q.post, 128))));
    const mix = Math.min(128, Math.max(0, num(q.mix, 128))) / 128;
    this.tWet = f32(mix * post);
    this.tDry = f32((1 - mix) * post * post * mul);
    this.tMul = f32(mul);
  }

  reset(): void {
    for (const u of this.up) u.reset();
    for (const d of this.down) d.reset();
    for (const u of this.up16) u.reset();
    for (const d of this.down16) d.reset();
    this.dc.fill(0);
    this.level = this.hold = this.monPeak = 0;
  }

  /** One shaped sample (FL's four kernels). */
  private shape(x: number, dry: number, w: number, mul: number, hq: boolean): number {
    const tab = this.tab, size = this.size;
    if (!this.bipolar) {
      if (!hq) {
        let idx = Math.trunc((x < 0 ? -x : x) * mul * size);
        if (idx > size) idx = size;
        const y = tab[idx + 1];
        return x * dry + (x < 0 ? -y : y) * w;
      }
      const s = x * mul * size;
      const k = Math.trunc(s);
      const frac = s - k;
      if (k < 0) {
        let kk = -k;
        if (kk > size) kk = size;
        const a = tab[kk + 1];
        return x * dry - (a - (tab[kk + 2] - a) * frac) * w;
      }
      const kk = k > size ? size : k;
      const a = tab[kk + 1];
      return x * dry + (a + (tab[kk + 2] - a) * frac) * w;
    }
    const half = size * 0.5;
    if (!hq) {
      let idx = rint(x * mul * half + half);
      if (idx < 0) idx = 0; else if (idx > size) idx = size;
      return tab[idx + 1] * w + x * dry;
    }
    const s = x * mul * half + half;
    const k = Math.trunc(s);
    const kk = k < 0 ? 0 : k > size ? size : k;
    const frac = s - k;
    return (tab[kk + 1] * (1 - frac) + tab[kk + 2] * frac) * w + x * dry;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx?: FxContext): void {
    // FL's export ("HQ for all plugins"): interpolating lookup, oversampling forced to 16x
    const rendering = !!ctx?.rendering;
    const hq = this.hq || rendering;
    const os16 = rendering && this.F > 1;
    const F = os16 ? 16 : this.F;
    const ups = os16 ? this.up16 : this.up, downs = os16 ? this.down16 : this.down;
    // editor level: input peak x pre gain with FL's 2 s hold and quadratic fall
    let pk = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(L[i]), b = Math.abs(R[i]);
      if (a > pk) pk = a;
      if (b > pk) pk = b;
    }
    if (!(pk < 1e6)) pk = 0;
    if (pk >= this.level) { this.level = pk; this.hold = 2 * this.sr; }
    else if (this.level > 0) {
      this.hold -= n;
      if (this.hold < 0) {
        const t = -this.hold / this.sr;
        this.level = Math.max(0, this.level - (t * t) / 5);
      }
    }
    const lv = this.level * this.tMul;
    if (lv > this.monPeak) this.monPeak = lv;

    const m = n * F;
    if (this.bufL.length < m) { this.bufL = new Float64Array(m); this.bufR = new Float64Array(m); }
    const bl = this.bufL, br = this.bufR;
    if (F === 1) {
      for (let i = 0; i < n; i++) {
        const l = L[i], r = R[i];
        bl[i] = l > -1e6 && l < 1e6 ? l : 0;
        br[i] = r > -1e6 && r < 1e6 ? r : 0;
      }
    } else {
      const ul = ups[0], ur = ups[1];
      const tmp = this.tmpF(F);
      for (let i = 0; i < n; i++) {
        const l = L[i], r = R[i];
        ul.process(l > -1e6 && l < 1e6 ? l : 0, tmp);
        for (let j = 0; j < F; j++) bl[i * F + j] = tmp[j];
        ur.process(r > -1e6 && r < 1e6 ? r : 0, tmp);
        for (let j = 0; j < F; j++) br[i * F + j] = tmp[j];
      }
    }
    const tD = this.tDry, tW = this.tWet, tM = this.tMul;
    if (this.smooth) {
      // FL's Smooth: single-precision glide per (oversampled) frame
      const k = this.kSmooth;
      let dry = this.dry, wet = this.wet, mul = this.mul;
      for (let i = 0; i < m; i++) {
        mul = f32(mul + f32(f32(tM - mul) * k));
        wet = f32(wet + f32(f32(tW - wet) * k));
        dry = f32(dry + f32(f32(tD - dry) * k));
        const w = wet * (1 / 32768);
        bl[i] = this.shape(bl[i], dry, w, mul, hq);
        br[i] = this.shape(br[i], dry, w, mul, hq);
      }
      this.dry = dry; this.wet = wet; this.mul = mul;
    } else {
      // Smooth off: FL uses the current gains for the whole block
      const w = tW * (1 / 32768);
      for (let i = 0; i < m; i++) {
        bl[i] = this.shape(bl[i], tD, w, tM, hq);
        br[i] = this.shape(br[i], tD, w, tM, hq);
      }
    }
    if (F === 1) {
      for (let i = 0; i < n; i++) { L[i] = bl[i]; R[i] = br[i]; }
    } else {
      const dl = downs[0], dr = downs[1];
      for (let i = 0; i < n; i++) {
        L[i] = dl.processAt(bl, i * F);
        R[i] = dr.processAt(br, i * F);
      }
    }
    if (this.center) this.removeDc(L, R, n);
  }

  private tmp = new Float64Array(16);
  private tmpF(_F: number): Float64Array {
    return this.tmp;
  }

  /** FL's Center: x - LP2(x), the low-pass a damped integrator pair (a ~ 2.28e-5 at 44.1 kHz, damping 0.96). */
  private removeDc(L: Float32Array, R: Float32Array, n: number): void {
    const a = this.dcA, b = 0.96, st = this.dc;
    let p0 = st[0], v0 = st[1], p1 = st[2], v1 = st[3];
    for (let i = 0; i < n; i++) {
      const xl = L[i];
      v0 += (xl - p0) * a;
      p0 += v0;
      v0 *= b;
      L[i] = xl - p0;
      const xr = R[i];
      v1 += (xr - p1) * a;
      p1 += v1;
      v1 *= b;
      R[i] = xr - p1;
    }
    if (p0 < TINY && p0 > -TINY) p0 = 0;
    if (v0 < TINY && v0 > -TINY) v0 = 0;
    if (p1 < TINY && p1 > -TINY) p1 = 0;
    if (v1 < TINY && v1 > -TINY) v1 = 0;
    if (!Number.isFinite(p0 + v0 + p1 + v1)) { p0 = v0 = p1 = v1 = 0; }
    st[0] = p0; st[1] = v0; st[2] = p1; st[3] = v1;
  }

  monitor(): FxMonitor {
    const m = { level: this.monPeak };
    this.monPeak = 0;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'waveshaper',
  create: (sampleRate, blockSize) => new WaveShaper(sampleRate, blockSize),
};
