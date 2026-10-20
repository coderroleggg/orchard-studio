// Emphasizer (FL: Emphasizer). Measured on FL's binary (docs/research/fx/emphasizer.md):
//   input gain -> 2 ms look-ahead (the plugin's latency)
//   stage 1 (clean, stereo-linked): at Emphasis 0 a look-ahead peak limiter to
//     -0.1 dBFS; above 0 a slow servo that takes over sustained gain reduction,
//     after a dead time and with a time constant that grow with Emphasis, and
//     leaves the clipper a fixed overshoot (-0.1 .. 5.93 dB at 0 .. 100 %).
//     Release: 20 ms hold, ~70 dB/s for 80 ms, then ~20 dB/s.
//   stage 2: static clipper at 0 dBFS, hard or soft (linear to 0.86, rational knee)
//   -> output gain (attenuation only), level matching (inverse input gain), bypass.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';

const LOOKAHEAD_SEC = 0.002;
const HOLD_SEC = 0.02;
const FAST_GAP_DB = 6.5; // fast recovery while the reduction exceeds its target by more than this ...
const FAST_SEC = 0.08; // ... and only during the first 80 ms after the hold
const FAST_RATE = 70; // dB/s
const SLOW_RATE = 20; // dB/s
const ATT_A_SEC = 0.00035; // look-ahead component attack (dB domain)
const CD_REL_DB_S = 400; // level envelope fall (dB/s); the release hold covers in-cycle dips the release hold covers in-cycle dips the release hold covers in-cycle dips // clip-depth envelope fall (holds through a cycle)
const SOFT_T = 0.86;
const SOFT_N = 1.65;

// Emphasis 0, 0.1, 0.25, 0.5, 0.75, 1 -> clipper overshoot (dB), servo dead time (s), servo time constant (s)
const E_PTS = [0, 0.1, 0.25, 0.5, 0.75, 1];
const O_INF = [-0.1, -0.06, 0.18, 1.06, 2.77, 5.93];
const DEAD = [0, 0, 0.008, 0.05, 0.145, 0.45];
const TAU = [0.0005, 0.006, 0.037, 0.15, 0.42, 0.75];

function interp(tab: number[], e: number): number {
  const x = Math.min(1, Math.max(0, e));
  for (let i = 1; i < E_PTS.length; i++) {
    if (x <= E_PTS[i]) {
      const t = (x - E_PTS[i - 1]) / (E_PTS[i] - E_PTS[i - 1]);
      return tab[i - 1] + (tab[i] - tab[i - 1]) * t;
    }
  }
  return tab[tab.length - 1];
}

/** Emphasizer's clipper: hard at 1, or soft (linear to 0.86, then a rational knee toward 1). */
export function ezClip(u: number, soft: boolean): number {
  const a = u < 0 ? -u : u;
  if (!soft) return a > 1 ? (u < 0 ? -1 : 1) : u;
  if (a <= SOFT_T) return u;
  const d = (a - SOFT_T) / (1 - SOFT_T);
  const y = SOFT_T + (1 - SOFT_T) * d / Math.pow(1 + Math.pow(d, SOFT_N), 1 / SOFT_N);
  return u < 0 ? -y : y;
}

class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0; x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
  clear(): void { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
}

/** BS.1770 K-weighting (shelf + RLB high-pass) for any sample rate. */
function kWeighting(sr: number): [Biquad, Biquad] {
  const s = new Biquad(), h = new Biquad();
  {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / sr), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    s.b0 = (Vh + (Vb * K) / Q + K * K) / a0; s.b1 = (2 * (K * K - Vh)) / a0; s.b2 = (Vh - (Vb * K) / Q + K * K) / a0;
    s.a1 = (2 * (K * K - 1)) / a0; s.a2 = (1 - K / Q + K * K) / a0;
  }
  {
    const f0 = 38.13547087602444, Q = 0.5003270373238773;
    const K = Math.tan((Math.PI * f0) / sr), a0 = 1 + K / Q + K * K;
    h.b0 = 1; h.b1 = -2; h.b2 = 1; h.a1 = (2 * (K * K - 1)) / a0; h.a2 = (1 - K / Q + K * K) / a0;
  }
  return [s, h];
}

const LUFS_BINS = 760;

class EmphasizerFx implements EffectInstance {
  readonly latency: number;
  readonly tail: number;
  private sr: number;
  private W: number;
  // parameters
  private inDb = 0; private emph = 0.5013; private soft = false; private lm = 0; private byp = 0; private outG = 1;
  private lufsPaused = false; private lufsReset = 0;
  // smoothed (block ramps)
  private gIn = 1; private gIn0 = 1; private gOut = 1; private gOut0 = 1; private lmG = 1; private lmG0 = 1; private bp = 0; private bp0 = 0;
  // derived from Emphasis
  private oInf = 0; private oInst = 0; private deadN = 0; private kS = 0;
  // delay lines
  private dl: Float64Array; private dr: Float64Array; private dryL: Float64Array; private dryR: Float64Array; private pos = 0;
  // look-ahead sliding maximum (monotonic deque over the window)
  private qv: Float64Array; private qt: Float64Array; private qh = 0; private qn = 0; private t = 0;
  // stage 1 state (dB)
  private gA = 0; private relA = 0; private gS = 0; private relS = 0; private cdEnv = -200;
  private errBuf: Float64Array; private errPos = 0;
  private cA: number; private holdN: number; private fastN: number; private fastStep: number; private slowStep: number; private cdFall: number;
  // metering
  private kw: [Biquad, Biquad][];
  private subLen: number; private subPos = 0; private subAcc = 0; private subs = new Float64Array(4); private subW = 0; private subCount = 0;
  private binCount = new Float64Array(LUFS_BINS); private binPow = new Float64Array(LUFS_BINS);
  private pkL = 0; private pkR = 0; private rmsL = 0; private rmsR = 0; private rmsN = 0; private grMax = 0; private clipMax = 0;

  constructor(sr: number) {
    this.sr = sr;
    this.W = Math.max(1, Math.round(LOOKAHEAD_SEC * sr));
    this.latency = this.W;
    this.tail = this.W / sr + 0.05;
    this.dl = new Float64Array(this.W + 1); this.dr = new Float64Array(this.W + 1);
    this.dryL = new Float64Array(this.W + 1); this.dryR = new Float64Array(this.W + 1);
    this.qv = new Float64Array(this.W + 4); this.qt = new Float64Array(this.W + 4);
    this.errBuf = new Float64Array(Math.ceil(0.46 * sr) + 2);
    this.cA = 1 - Math.exp(-1 / (ATT_A_SEC * sr));
    this.holdN = Math.round(HOLD_SEC * sr);
    this.fastN = Math.round(FAST_SEC * sr);
    this.fastStep = FAST_RATE / sr;
    this.slowStep = SLOW_RATE / sr;
    this.cdFall = CD_REL_DB_S / sr;
    this.kw = [kWeighting(sr), kWeighting(sr)];
    this.subLen = Math.round(0.1 * sr);
    this.setParams({});
    this.reset();
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number) => { const v = q[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d; };
    const cl = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    this.inDb = (24 * cl(num('inputGain', 0), 0, 10000)) / 10000;
    this.emph = cl(num('emphasis', 5013), 0, 10000) / 10000;
    this.soft = num('clipping', 0) >= 0.5;
    this.lm = num('levelMatch', 0) >= 0.5 ? 1 : 0;
    this.byp = num('bypass', 0) >= 0.5 ? 1 : 0;
    this.outG = (Math.pow(11, cl(num('outputGain', 10000), 0, 10000) / 10000) - 1) / 10;
    this.lufsPaused = q.lufsPaused === true;
    const rs = num('lufsReset', 0);
    if (rs !== this.lufsReset) { this.lufsReset = rs; this.resetLufs(); }
    const e = this.emph;
    this.oInf = interp(O_INF, e);
    this.oInst = e <= 0 ? -0.1 : -0.1 + 200 * e;
    this.deadN = Math.min(this.errBuf.length - 1, Math.round(interp(DEAD, e) * this.sr));
    this.kS = 1 / Math.max(1, interp(TAU, e) * this.sr);
  }

  reset(): void {
    this.gIn = this.gIn0 = Math.pow(10, this.inDb / 20);
    this.gOut = this.gOut0 = this.outG;
    this.lmG = this.lmG0 = this.lm ? Math.pow(10, -this.inDb / 20) : 1;
    this.bp = this.bp0 = this.byp;
    this.dl.fill(0); this.dr.fill(0); this.dryL.fill(0); this.dryR.fill(0); this.pos = 0;
    this.qh = 0; this.qn = 0; this.t = 0;
    this.gA = 0; this.relA = 0; this.gS = 0; this.relS = 0; this.cdEnv = -200;
    this.errBuf.fill(-100); this.errPos = 0;
    for (const [a, b] of this.kw) { a.clear(); b.clear(); }
    this.resetLufs();
    this.pkL = this.pkR = this.rmsL = this.rmsR = 0; this.rmsN = 0; this.grMax = 0; this.clipMax = 0;
  }

  private resetLufs(): void {
    this.subPos = 0; this.subAcc = 0; this.subs.fill(0); this.subW = 0; this.subCount = 0;
    this.binCount.fill(0); this.binPow.fill(0);
  }

  /** Release law shared by both stage-1 components: 20 ms hold, then fast while far above the target, else slow. */
  private release(g: number, rel: number, gap: number): number {
    if (rel < this.holdN) return g;
    const r = g - (gap > FAST_GAP_DB && rel < this.holdN + this.fastN ? this.fastStep : this.slowStep);
    return r > 0 ? r : 0;
  }

  process(L: Float32Array, R: Float32Array, n: number, _ctx: FxContext): void {
    void _ctx;
    if (n <= 0) return;
    const k = 1 - Math.exp(-n / (0.02 * this.sr));
    this.gIn0 = this.gIn; this.gIn += (Math.pow(10, this.inDb / 20) - this.gIn) * k;
    this.gOut0 = this.gOut; this.gOut += (this.outG - this.gOut) * k;
    this.lmG0 = this.lmG; this.lmG += ((this.lm ? Math.pow(10, -this.inDb / 20) : 1) - this.lmG) * k;
    this.bp0 = this.bp; this.bp += (this.byp - this.bp) * k; if (Math.abs(this.bp - this.byp) < 1e-4) this.bp = this.byp;
    const inv = 1 / n;
    const dGi = (this.gIn - this.gIn0) * inv, dGo = (this.gOut - this.gOut0) * inv, dLm = (this.lmG - this.lmG0) * inv, dBp = (this.bp - this.bp0) * inv;
    const W = this.W, len = W + 1, soft = this.soft;
    const oInf = this.oInf, oInst = this.oInst, kS = this.kS, deadN = this.deadN, eb = this.errBuf, ebLen = eb.length;
    let gA = this.gA, relA = this.relA, gS = this.gS, relS = this.relS, cdEnv = this.cdEnv;

    for (let i = 0; i < n; i++) {
      const t = this.t++;
      const gi = this.gIn0 + dGi * i;
      const xl = L[i] * gi, xr = R[i] * gi;
      const w = this.pos, r = (w + 1) % len; // r = oldest = output position (delay W)
      this.dl[w] = xl; this.dr[w] = xr; this.dryL[w] = L[i]; this.dryR[w] = R[i];
      const ol = this.dl[r], or = this.dr[r], dryl = this.dryL[r], dryr = this.dryR[r];
      this.pos = r;

      // look-ahead peak (linked) over the window [output .. newest]
      const ax = Math.max(xl < 0 ? -xl : xl, xr < 0 ? -xr : xr);
      while (this.qn > 0 && this.qv[(this.qh + this.qn - 1) % (W + 4)] <= ax) this.qn--;
      { const kk = (this.qh + this.qn) % (W + 4); this.qv[kk] = ax; this.qt[kk] = t; this.qn++; }
      while (this.qn > 0 && this.qt[this.qh] < t - W) { this.qh = (this.qh + 1) % (W + 4); this.qn--; }
      const pk = this.qn > 0 ? this.qv[this.qh] : 0;

      // component A: look-ahead limiting beyond the instantaneous allowance
      const tA = pk > 1e-9 ? 20 * Math.log10(pk) - oInst : 0;
      if (tA > gA) { gA += (tA - gA) * this.cA; relA = 0; } else { gA = this.release(gA, relA, gA - (tA > 0 ? tA : 0)); relA++; }
      if (gA < 0) gA = 0;

      // component S: servo on the clipper's overshoot (dead time, then integration);
      // the overshoot is the input level envelope minus the current stage-1 reduction
      const g1 = gA > gS ? gA : gS;
      const pi = Math.max(ol < 0 ? -ol : ol, or < 0 ? -or : or);
      const lvl = pi > 1e-9 ? 20 * Math.log10(pi) : -200;
      cdEnv = lvl > cdEnv ? lvl : cdEnv - this.cdFall;
      const err = cdEnv - g1 - oInf;
      eb[this.errPos] = err;
      // FL reacts much faster to large overshoots: dead time and time constant shrink as (12 dB / err)^2
      const sp = err > 12 ? (144 / (err * err)) : 1;
      const errD = eb[(this.errPos - Math.round(deadN * sp) + ebLen) % ebLen];
      this.errPos = (this.errPos + 1) % ebLen;
      if (err > 0.02) {
        relS = 0;
        if (errD > 0) gS += (errD * kS) / sp;
      } else if (err < -0.05) { gS = this.release(gS, relS, -err); relS++; }
      if (gS > 60) gS = 60;

      // apply stage 1 and the clipper
      const g = Math.pow(10, -(gA > gS ? gA : gS) / 20);
      const ul = ol * g, ur = or * g;
      const yl = ezClip(ul, soft), yr = ezClip(ur, soft);
      const go = (this.gOut0 + dGo * i) * (this.lmG0 + dLm * i);
      let fl = yl * go, fr = yr * go;
      const b = this.bp0 + dBp * i;
      if (b > 0) { fl += (dryl - fl) * b; fr += (dryr - fr) * b; }
      L[i] = fl; R[i] = fr;

      // metering: total GR (stage 1 + clipper), output peaks / RMS, LUFS integrated
      const au = Math.max(ul < 0 ? -ul : ul, ur < 0 ? -ur : ur), ay = Math.max(yl < 0 ? -yl : yl, yr < 0 ? -yr : yr);
      const clipDb = au > 1e-9 && ay > 1e-9 ? 20 * Math.log10(au / ay) : 0;
      const tot = (gA > gS ? gA : gS) + clipDb;
      if (tot > this.grMax) this.grMax = tot;
      if (clipDb > this.clipMax) this.clipMax = clipDb;
      const afl = fl < 0 ? -fl : fl, afr = fr < 0 ? -fr : fr;
      if (afl > this.pkL) this.pkL = afl;
      if (afr > this.pkR) this.pkR = afr;
      this.rmsL += fl * fl; this.rmsR += fr * fr; this.rmsN++;
      if (!this.lufsPaused) {
        const kl = this.kw[0][1].run(this.kw[0][0].run(fl)), kr = this.kw[1][1].run(this.kw[1][0].run(fr));
        this.subAcc += kl * kl + kr * kr;
        if (++this.subPos >= this.subLen) this.endSubBlock();
      }
    }
    this.gA = Number.isFinite(gA) ? gA : 0; this.relA = relA;
    this.gS = Number.isFinite(gS) ? gS : 0; this.relS = relS;
    this.cdEnv = Number.isFinite(cdEnv) ? Math.max(-200, cdEnv) : -200;
  }

  private endSubBlock(): void {
    this.subs[this.subW] = this.subAcc / this.subLen;
    this.subW = (this.subW + 1) & 3;
    this.subAcc = 0; this.subPos = 0;
    if (this.subCount < 4) this.subCount++;
    if (this.subCount >= 4) {
      const p = (this.subs[0] + this.subs[1] + this.subs[2] + this.subs[3]) / 4;
      const l = p > 1e-20 ? -0.691 + 10 * Math.log10(p) : -Infinity;
      if (l > -70) {
        const bin = Math.min(LUFS_BINS - 1, Math.floor((l + 70) * 10));
        this.binCount[bin] += 1;
        this.binPow[bin] += p;
      }
    }
  }

  private integrated(): number {
    let c = 0, s = 0;
    for (let i = 0; i < LUFS_BINS; i++) { c += this.binCount[i]; s += this.binPow[i]; }
    if (c === 0) return -Infinity;
    const rel = -0.691 + 10 * Math.log10(s / c) - 10;
    const b0 = Math.max(0, Math.floor((rel + 70) * 10));
    c = 0; s = 0;
    for (let i = b0; i < LUFS_BINS; i++) { c += this.binCount[i]; s += this.binPow[i]; }
    return c > 0 ? -0.691 + 10 * Math.log10(s / c) : -Infinity;
  }

  monitor(): FxMonitor {
    const n = Math.max(1, this.rmsN);
    const m: FxMonitor = {
      gr: this.grMax, clip: this.clipMax, pkL: this.pkL, pkR: this.pkR,
      rmsL: Math.sqrt(this.rmsL / n), rmsR: Math.sqrt(this.rmsR / n), lufsI: this.integrated(),
    };
    this.grMax = 0; this.clipMax = 0; this.pkL = this.pkR = 0; this.rmsL = this.rmsR = 0; this.rmsN = 0;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'emphasizer',
  create: (sampleRate) => new EmphasizerFx(sampleRate),
};
