// Multiband Compressor (FL: Fruity Multiband Compressor). Everything below was
// measured on FL Studio 2026's plugin with flfxhost (docs/research/fx/mbcompressor.md):
//
// - Band split, "BW IIR": low = 4th-order Butterworth low-pass at L Freq, mid =
//   Butterworth low-pass at M Freq H into high-pass at M Freq L, high = high-pass
//   at H Freq (two prewarped bilinear biquads, Q 0.5412 / 1.3066 each, direct
//   form I), simply summed; latency 0.
// - "LP FIR": 105-tap linear phase low-passes (latency 52 at every rate): an ideal
//   trapezoid low-pass (sinc(2fc k) sinc(0.17 * 2fc k)) under a Kaiser window
//   (beta = 0.1102 (55 - 8.7), 105 points). low = LP(L Freq), mid = LP(M Freq H) -
//   LP(M Freq L), high = delayed input - LP(H Freq).
// - Each band: stereo-linked peak detector y = max(|x|, y * exp(-1 / (release sr))),
//   smoothed by a prewarped bilinear one-pole low-pass (cut-off from the attack),
//   gain = 1 / (1 + ratio * s) with s = (level - t) / t above the threshold t and
//   a quadratic soft knee over t +- (0.005 + r t); then the band output gain. Muted bands
//   are silent, bypassed bands keep the output gain.
// - Sum * master volume, then the limiter (per channel: the same detector with a
//   17 kHz attack and 15 ms release, threshold -1.2 dB, ratio 4:1, knee 0.195),
//   output scaled by 0.99999 and clipped at +-0.99999.
//
// FL applies parameter changes instantly (at the next block), and so do we.

import type { EffectInstance, EffectModule, FxMonitor } from '../types';
import {
  mbMasterGain, mbOutGain, mbThresDb, mbRatioX, mbAttackHz, mbReleaseSec, mbKneeRel, mbFreqHz, MB_KEYS,
} from '../../../model/fx/plugins/mbcompressor';

export const MB_FIR_HALF = 52;
export const MB_FIR_LEN = 2 * MB_FIR_HALF + 1;
const FIR_BETA = 0.1102 * (55 - 8.7);
const FIR_TRANS = 0.17;
const Q1 = 1 / (2 * Math.cos(Math.PI / 8));
const Q2 = 1 / (2 * Math.cos((3 * Math.PI) / 8));
/** Limiter constants (fitted to FL: rms error 2e-5 on steps and ramps). */
export const MB_LIMITER = { thres: Math.pow(10, -1.2 / 20), ratio: 0.75, knee: 0.195 * Math.pow(10, -1.2 / 20), attackHz: 17000, release: 0.015, ceil: 0.99999 };
/** Samples per visual history chunk (input and output peaks). */
export const MB_CHUNK = 256;
const HIST = 512;

function besselI0(x: number): number {
  let s = 1, t = 1;
  for (let k = 1; k < 60; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; if (t < 1e-17 * s) break; }
  return s;
}

/** Kaiser window half (index 0 = centre). */
const KAISER = (() => {
  const w = new Float64Array(MB_FIR_HALF + 1), i0b = besselI0(FIR_BETA);
  for (let k = 0; k <= MB_FIR_HALF; k++) { const r = k / MB_FIR_HALF; w[k] = besselI0(FIR_BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0b; }
  return w;
})();

const sinc = (x: number): number => (Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

/** FL's linear phase low-pass kernel half (centre first) for cut-off fc. */
export function mbFirKernel(fc: number, sr: number, out: Float64Array = new Float64Array(MB_FIR_HALF + 1)): Float64Array {
  const fn = Math.min(1, (2 * fc) / sr);
  for (let k = 0; k <= MB_FIR_HALF; k++) out[k] = fn * sinc(fn * k) * sinc(FIR_TRANS * fn * k) * KAISER[k];
  return out;
}

/** One RBJ biquad section (direct form I, both channels). */
class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private xl1 = 0; private xl2 = 0; private yl1 = 0; private yl2 = 0;
  private xr1 = 0; private xr2 = 0; private yr1 = 0; private yr2 = 0;
  set(fc: number, q: number, sr: number, hp: boolean): void {
    const w0 = (2 * Math.PI * Math.min(fc, 0.49 * sr)) / sr, c = Math.cos(w0), s = Math.sin(w0), al = s / (2 * q), a0 = 1 + al;
    if (hp) { this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; } else { this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; }
    this.b2 = this.b0; this.a1 = (-2 * c) / a0; this.a2 = (1 - al) / a0;
  }
  l(x: number): number {
    const y = this.b0 * x + this.b1 * this.xl1 + this.b2 * this.xl2 - this.a1 * this.yl1 - this.a2 * this.yl2;
    this.xl2 = this.xl1; this.xl1 = x; this.yl2 = this.yl1; this.yl1 = y;
    return y;
  }
  r(x: number): number {
    const y = this.b0 * x + this.b1 * this.xr1 + this.b2 * this.xr2 - this.a1 * this.yr1 - this.a2 * this.yr2;
    this.xr2 = this.xr1; this.xr1 = x; this.yr2 = this.yr1; this.yr1 = y;
    return y;
  }
  flush(): void {
    if (Math.abs(this.yl1) + Math.abs(this.yl2) + Math.abs(this.xl1) + Math.abs(this.xl2) < 1e-25) this.xl1 = this.xl2 = this.yl1 = this.yl2 = 0;
    if (Math.abs(this.yr1) + Math.abs(this.yr2) + Math.abs(this.xr1) + Math.abs(this.xr2) < 1e-25) this.xr1 = this.xr2 = this.yr1 = this.yr2 = 0;
  }
  reset(): void { this.xl1 = this.xl2 = this.yl1 = this.yl2 = this.xr1 = this.xr2 = this.yr1 = this.yr2 = 0; }
}

/** 4th-order Butterworth (two biquads). */
class BW4 {
  private a = new Biquad();
  private b = new Biquad();
  private fc = -1;
  private hp: boolean;
  constructor(hp: boolean) { this.hp = hp; }
  set(fc: number, sr: number): void {
    if (fc === this.fc) return;
    this.fc = fc;
    this.a.set(fc, Q1, sr, this.hp);
    this.b.set(fc, Q2, sr, this.hp);
  }
  l(x: number): number { return this.b.l(this.a.l(x)); }
  r(x: number): number { return this.b.r(this.a.r(x)); }
  flush(): void { this.a.flush(); this.b.flush(); }
  reset(): void { this.a.reset(); this.b.reset(); }
}

/**
 * Gain computer: 1 / (1 + x s), s = (level - t) / t above the knee, a quadratic
 * blend over t +- W (W absolute) and 0 below.
 */
export function mbGain(level: number, t: number, x: number, W: number): number {
  const d = level - t;
  if (d <= -W) return 1;
  const s = d >= W ? d / t : ((d + W) * (d + W)) / (4 * W * t);
  return 1 / (1 + x * s);
}

/** Bilinear one-pole pole for a cut-off (Hz). */
export function mbPole(fc: number, sr: number): number {
  const k = Math.tan((Math.PI * Math.min(fc, 0.45 * sr)) / sr);
  return (1 - k) / (1 + k);
}

/** Smoothed peak detector of one band (or limiter channel). */
class Detector {
  y = 0; yp = 0; e = 0;
  p = 0; q = 0.5; aR = 0;
  set(attackHz: number, releaseSec: number, sr: number): void {
    this.p = mbPole(attackHz, sr);
    this.q = (1 - this.p) / 2;
    this.aR = Math.exp(-1 / (releaseSec * sr));
  }
  run(d: number): number {
    const r = this.aR * this.y;
    const y = d > r ? d : r;
    this.e = this.p * this.e + this.q * (y + this.yp);
    this.y = y; this.yp = y;
    return this.e;
  }
  flush(): void { if (this.y < 1e-30) this.y = 0; if (this.yp < 1e-30) this.yp = 0; if (Math.abs(this.e) < 1e-30) this.e = 0; }
  reset(): void { this.y = this.yp = this.e = 0; }
}

/** A linearly ramped value (one block). */
class Ramp {
  cur = 0; target = 0; step = 0; left = 0;
  init(v: number): void { this.cur = this.target = v; this.left = 0; this.step = 0; }
  to(v: number): void { this.target = v; }
  /** FL switches at the block start (no ramp). */
  begin(_n: number): void {
    this.cur = this.target; this.step = 0; this.left = 0;
  }
  next(): number {
    if (this.left > 0) { this.cur += this.step; if (--this.left === 0) this.cur = this.target; }
    return this.cur;
  }
}

interface BandCfg { state: number; t: number; x: number; w: number; out: number; att: number; rel: number }

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const BAND_ORDER = ['l', 'm', 'h'] as const;

class MultibandCompressor implements EffectInstance {
  private sr: number;
  private fir = false;
  private firReady = false;
  private limiterOn = false;
  // IIR split
  private lowLP = new BW4(false);
  private midHP = new BW4(true);
  private midLP = new BW4(false);
  private highHP = new BW4(true);
  // FIR split: mirrored input history and up to 4 distinct kernels
  private histL = new Float64Array(2 * 256);
  private histR = new Float64Array(2 * 256);
  private hpos = 0;
  private kern = [0, 1, 2, 3].map(() => new Float64Array(MB_FIR_HALF + 1));
  private kernFc = new Float64Array(4).fill(-1);
  /** Which kernel each cut-off uses: L Freq, M Freq L, M Freq H, H Freq. */
  private kmap = new Int32Array(4);
  private nk = 0;
  private lpL = new Float64Array(4);
  private lpR = new Float64Array(4);
  private freqs = new Float64Array(4).fill(-1);
  // dynamics
  private det = [new Detector(), new Detector(), new Detector()];
  private cfg: BandCfg[] = [0, 1, 2].map(() => ({ state: 0, t: 0.125, x: 0.5, w: 0.4, out: 1, att: 100, rel: 1000 }));
  private rT = [new Ramp(), new Ramp(), new Ramp()];
  private rX = [new Ramp(), new Ramp(), new Ramp()];
  private rW = [new Ramp(), new Ramp(), new Ramp()];
  private rOut = [new Ramp(), new Ramp(), new Ramp()];
  private rComp = [new Ramp(), new Ramp(), new Ramp()];
  private rOn = [new Ramp(), new Ramp(), new Ramp()];
  private rMaster = new Ramp();
  private limL = new Detector();
  private limR = new Detector();
  private detOn = [true, true, true];
  private first = true;
  // monitor accumulators
  private mIn = new Float64Array(2);
  private mOut = new Float64Array(2);
  private bIn = new Float64Array(6);
  private bOut = new Float64Array(6);
  private bGain = new Float64Array(3).fill(1);
  private chunkIn = 0;
  private chunkOut = 0;
  private chunkPos = 0;
  private vis = new Float32Array(HIST * 2);
  private visW = 0;
  private visR = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.limL.set(MB_LIMITER.attackHz, MB_LIMITER.release, sampleRate);
    this.limR.set(MB_LIMITER.attackHz, MB_LIMITER.release, sampleRate);
    this.setParams({});
    this.reset();
  }

  get latency(): number { return this.fir ? MB_FIR_HALF : 0; }
  get tail(): number { return (this.fir ? MB_FIR_HALF : 0) / this.sr + 0.1; }

  setParams(p: unknown): void {
    const q = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const sr = this.sr;
    const fir = num(q.filterType, 0) >= 0.5;
    if (fir !== this.fir) {
      this.fir = fir;
      // the other split starts from silence (FL glitches as well)
      this.lowLP.reset(); this.midHP.reset(); this.midLP.reset(); this.highHP.reset();
      this.histL.fill(0); this.histR.fill(0);
    }
    this.limiterOn = num(q.limiter, 0) >= 0.5;
    const fL = mbFreqHz(num(q.lFreq, 6500)), fML = mbFreqHz(num(q.mFreqL, 6500)), fMH = mbFreqHz(num(q.mFreqH, 17000)), fH = mbFreqHz(num(q.hFreq, 17000));
    this.lowLP.set(fL, sr); this.midHP.set(fML, sr); this.midLP.set(fMH, sr); this.highHP.set(fH, sr);
    const f = [fL, fML, fMH, fH];
    let changed = !this.firReady;
    for (let i = 0; i < 4; i++) if (f[i] !== this.freqs[i]) { this.freqs[i] = f[i]; changed = true; }
    if (changed) {
      // distinct kernels only (linked cut-offs share one)
      let nk = 0;
      for (let i = 0; i < 4; i++) {
        let j = 0;
        while (j < nk && this.kernFc[j] !== f[i]) j++;
        if (j === nk) { if (this.kernFc[nk] !== f[i]) { mbFirKernel(f[i], sr, this.kern[nk]); this.kernFc[nk] = f[i]; } nk++; }
        this.kmap[i] = j;
      }
      for (let j = nk; j < 4; j++) this.kernFc[j] = -1;
      this.nk = nk;
      this.firReady = true;
    }
    BAND_ORDER.forEach((b, i) => {
      const K = MB_KEYS[b];
      const c = this.cfg[i];
      c.state = Math.max(0, Math.min(2, Math.round(num(q[K.state], 0))));
      c.t = Math.pow(10, mbThresDb(num(q[K.thres], b === 'm' ? 48875 : 45875)) / 20);
      c.x = mbRatioX(num(q[K.ratio], 32768));
      c.w = mbKneeRel(num(q[K.knee], 52429));
      c.out = mbOutGain(num(q[K.out], 21845));
      const att = num(q[K.att], 100), rel = num(q[K.rel], 1000);
      if (att !== c.att || rel !== c.rel || this.first) { c.att = att; c.rel = rel; this.det[i].set(mbAttackHz(att), mbReleaseSec(rel), sr); }
      const comp = c.state === 0 ? 1 : 0, on = c.state === 1 ? 0 : 1;
      if (this.first) {
        this.rT[i].init(c.t); this.rX[i].init(c.x); this.rW[i].init(c.w); this.rOut[i].init(c.out); this.rComp[i].init(comp); this.rOn[i].init(on);
      } else {
        this.rT[i].to(c.t); this.rX[i].to(c.x); this.rW[i].to(c.w); this.rOut[i].to(c.out); this.rComp[i].to(comp); this.rOn[i].to(on);
      }
    });
    const mg = mbMasterGain(num(q.master, 32768));
    if (this.first) this.rMaster.init(mg); else this.rMaster.to(mg);
    this.first = false;
  }

  reset(): void {
    this.lowLP.reset(); this.midHP.reset(); this.midLP.reset(); this.highHP.reset();
    this.histL.fill(0); this.histR.fill(0); this.hpos = 0;
    for (const d of this.det) d.reset();
    this.limL.reset(); this.limR.reset();
    for (const r of [...this.rT, ...this.rX, ...this.rW, ...this.rOut, ...this.rComp, ...this.rOn, this.rMaster]) r.init(r.target);
    this.mIn.fill(0); this.mOut.fill(0); this.bIn.fill(0); this.bOut.fill(0); this.bGain.fill(1);
    this.chunkIn = this.chunkOut = 0; this.chunkPos = 0; this.visW = this.visR = 0;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const fir = this.fir;
    const det = this.det;
    for (let i = 0; i < 3; i++) { this.rT[i].begin(n); this.rX[i].begin(n); this.rW[i].begin(n); this.rOut[i].begin(n); this.rComp[i].begin(n); this.rOn[i].begin(n); }
    this.rMaster.begin(n);
    const hl = this.histL, hr = this.histR, km = this.kmap, nk = this.nk, kern = this.kern, lpL = this.lpL, lpR = this.lpR;
    const bIn = this.bIn, bOut = this.bOut, bGain = this.bGain;
    let mInL = this.mIn[0], mInR = this.mIn[1], mOutL = this.mOut[0], mOutR = this.mOut[1];
    const lim = this.limiterOn, limL = this.limL, limR = this.limR;
    const LT = MB_LIMITER.thres, LX = MB_LIMITER.ratio, LW = MB_LIMITER.knee, CEIL = MB_LIMITER.ceil;
    for (let s = 0; s < n; s++) {
      const xl = L[s], xr = R[s];
      const axl = Math.abs(xl), axr = Math.abs(xr);
      if (axl > mInL) mInL = axl;
      if (axr > mInR) mInR = axr;
      let lowL: number, lowR: number, midL: number, midR: number, highL: number, highR: number;
      if (!fir) {
        lowL = this.lowLP.l(xl); lowR = this.lowLP.r(xr);
        // FL's mid band: low-pass at M Freq H, then high-pass at M Freq L (the order shows on crossover changes)
        midL = this.midHP.l(this.midLP.l(xl)); midR = this.midHP.r(this.midLP.r(xr));
        highL = this.highHP.l(xl); highR = this.highHP.r(xr);
      } else {
        // mirrored history: the newest sample at p and p + 256
        const p = this.hpos;
        hl[p] = hl[p + 256] = xl;
        hr[p] = hr[p + 256] = xr;
        const c = p + 256 - MB_FIR_HALF; // centre tap (delayed input), window c-52 .. c+52 within the copy
        for (let j = 0; j < nk; j++) {
          const h = kern[j];
          let al = h[0] * hl[c], ar = h[0] * hr[c];
          for (let k = 1; k <= MB_FIR_HALF; k++) { const hk = h[k]; al += hk * (hl[c - k] + hl[c + k]); ar += hk * (hr[c - k] + hr[c + k]); }
          lpL[j] = al; lpR[j] = ar;
        }
        this.hpos = (p + 1) & 255;
        lowL = lpL[km[0]]; lowR = lpR[km[0]];
        midL = lpL[km[2]] - lpL[km[1]]; midR = lpR[km[2]] - lpR[km[1]];
        highL = hl[c] - lpL[km[3]]; highR = hr[c] - lpR[km[3]];
      }
      let sumL = 0, sumR = 0;
      for (let b = 0; b < 3; b++) {
        const bl = b === 0 ? lowL : b === 1 ? midL : highL;
        const br = b === 0 ? lowR : b === 1 ? midR : highR;
        const al = Math.abs(bl), ar = Math.abs(br);
        if (al > bIn[2 * b]) bIn[2 * b] = al;
        if (ar > bIn[2 * b + 1]) bIn[2 * b + 1] = ar;
        const t = this.rT[b].next(), x = this.rX[b].next(), w = this.rW[b].next();
        const og = this.rOut[b].next(), cm = this.rComp[b].next(), on = this.rOn[b].next();
        // FL runs a band's detector only while the band is ON (muted / bypassed bands hold it)
        if (cm > 0.5 && !this.detOn[b]) { det[b].reset(); }
        this.detOn[b] = cm > 0.5;
        const e = cm > 0.5 ? det[b].run(al > ar ? al : ar) : det[b].e;
        const g = mbGain(e, t, x, 0.005 + w * t);
        const gg = cm * g + (1 - cm);
        if (cm > 0.5 && g < bGain[b]) bGain[b] = g;
        const k = gg * og * on;
        const ol = bl * k, or = br * k;
        const aol = Math.abs(ol), aor = Math.abs(or);
        if (aol > bOut[2 * b]) bOut[2 * b] = aol;
        if (aor > bOut[2 * b + 1]) bOut[2 * b + 1] = aor;
        sumL += ol; sumR += or;
      }
      const mg = this.rMaster.next();
      let yl = sumL * mg, yr = sumR * mg;
      if (lim) {
        const ayl = Math.abs(yl), ayr = Math.abs(yr);
        yl *= CEIL * mbGain(limL.run(ayl), LT, LX, LW);
        yr *= CEIL * mbGain(limR.run(ayr), LT, LX, LW);
        if (yl > CEIL) yl = CEIL; else if (yl < -CEIL) yl = -CEIL;
        if (yr > CEIL) yr = CEIL; else if (yr < -CEIL) yr = -CEIL;
      }
      if (!(yl === yl) || !(yr === yr)) { yl = 0; yr = 0; }
      L[s] = yl; R[s] = yr;
      const ayl = Math.abs(yl), ayr = Math.abs(yr);
      if (ayl > mOutL) mOutL = ayl;
      if (ayr > mOutR) mOutR = ayr;
      // visual history (master input and output peaks per chunk)
      const ci = axl > axr ? axl : axr, co = ayl > ayr ? ayl : ayr;
      if (ci > this.chunkIn) this.chunkIn = ci;
      if (co > this.chunkOut) this.chunkOut = co;
      if (++this.chunkPos >= MB_CHUNK) {
        const w = this.visW;
        this.vis[2 * w] = this.chunkIn; this.vis[2 * w + 1] = this.chunkOut;
        this.visW = (w + 1) % HIST;
        if (this.visW === this.visR) this.visR = (this.visR + 1) % HIST;
        this.chunkIn = this.chunkOut = 0; this.chunkPos = 0;
      }
    }
    this.mIn[0] = mInL; this.mIn[1] = mInR; this.mOut[0] = mOutL; this.mOut[1] = mOutR;
    for (const d of det) d.flush();
    limL.flush(); limR.flush();
    this.lowLP.flush(); this.midHP.flush(); this.midLP.flush(); this.highHP.flush();
    // a non-finite input would poison the filters: start over
    if (!Number.isFinite(det[0].e + det[1].e + det[2].e)) this.reset();
  }

  monitor(): FxMonitor {
    const chunks: number[] = [];
    while (this.visR !== this.visW) { chunks.push(this.vis[2 * this.visR], this.vis[2 * this.visR + 1]); this.visR = (this.visR + 1) % HIST; }
    const out: FxMonitor = {
      mIn: [this.mIn[0], this.mIn[1]],
      mOut: [this.mOut[0], this.mOut[1]],
      bIn: Array.from(this.bIn),
      bOut: Array.from(this.bOut),
      gain: Array.from(this.bGain),
      chunks,
      latency: this.latency,
    };
    this.mIn.fill(0); this.mOut.fill(0); this.bIn.fill(0); this.bOut.fill(0); this.bGain.fill(1);
    return out;
  }
}

export const effect: EffectModule = {
  id: 'mbcompressor',
  create: (sr) => new MultibandCompressor(sr),
};
