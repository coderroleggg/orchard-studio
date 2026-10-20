// Limiter (FL: Fruity Limiter). Reverse-engineered against FL's own plugin
// (sample-exact on DC steps, noise, sines; see docs/research/fx/limiter.md):
//
//  compressor: boxcar RMS of (L²+R²)/2 over the RMS window (sidechain input if
//    selected) -> N = curve cascaded one-poles (per-stage attack/release,
//    coef = exp(-ln(100)·√N / time)) -> static curve (threshold, ratio, knee).
//  limiter: input peak max(|L|,|R|) -> running max over max(peak window,
//    look-ahead) -> N = release curve cascaded one-poles (instant attack per
//    stage, coef = exp(-ln(100)·√N / release)) = env.
//  total gain = min(gain · compGain, ceiling·0.975 / env); while env is under
//    the noise threshold the gate swaps in the noise gain (one-pole release,
//    still capped by the ceiling term); then N = attack curve symmetric
//    one-poles (coef = exp(-ln(10^2.5)·√N / lookahead)) smooth it, and it
//    multiplies the input delayed by the look-ahead (= attack time = latency).
//  output stage per channel: SAT at 0 dB hard-clips at ±ceiling; otherwise
//    x > th -> th + d·(1 - e^(-(x-th)/d)), d = max(0, min(1, ceiling) - th).

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import {
  LIM_LONG_MS, LIM_SHORT_MS, LIMITER_PARAMS, limCeil, limCompThres, limGain, limRatio, limTime,
} from '../../../model/fx/plugins/limiter';

const LN100 = Math.log(100);
const LN_ATT = Math.log(Math.pow(10, 2.5));
const MAX_STAGES = 8;
/** Display slice length (samples) for the scrolling envelope view. */
export const LIM_SLICE = 64;
const SLICES = 1024;
/** Parameter ramp length for static gains/thresholds (samples). */
const RAMP = 256;

// ramped scalars
const R_GAIN = 0, R_CEIL = 1, R_CEFF = 2, R_SAT = 3, R_CT = 4, R_INVR = 5, R_NG = 6, R_NT = 7, NR = 8;

interface P {
  [k: string]: unknown;
}

const num = (p: P, k: string, d: number): number => {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
};

const DEF: Record<string, number> = Object.fromEntries(LIMITER_PARAMS.map((q) => [q.key, q.def]));

/** Knee shaping of the over-threshold amount o (dB): FL curve on u = o + 1. */
function kneeShape(o: number, kneeSign: number, lnB: number, bm1: number, invLnB: number): number {
  if (kneeSign === 0) return o;
  const u = o + 1;
  if (kneeSign > 0) return Math.log(1 + u * bm1) * invLnB - 1;
  const e = Math.exp(u * lnB);
  return (e - 1) / bm1 - 1;
}

class Limiter implements EffectInstance {
  private readonly sr: number;
  // delay line (look-ahead)
  private readonly dl0: Float32Array;
  private readonly dl1: Float32Array;
  private readonly dlSize: number;
  private w = 0;
  private L = 0;
  private fadeFrom = -1;
  private fadeN = 0;
  // peak window: monotonic deque (ring) of sample index / level
  private readonly qIdx: Float64Array;
  private readonly qVal: Float64Array;
  private readonly qSize: number;
  private qHead = 0;
  private qLen = 0;
  private H = 1;
  private n = 0; // running sample index
  // release cascade (limiter env) and attack cascade (gain)
  private readonly rs = new Float64Array(MAX_STAGES);
  private readonly as = new Float64Array(MAX_STAGES).fill(1);
  private Nr = 3;
  private Na = 3;
  private aRel = 0;
  private aAtt = 0;
  private gg = 1;
  private aGate = 0;
  // compressor
  private readonly rbuf: Float64Array;
  private readonly rSize: number;
  private rw = 0;
  private rsum = 0;
  private W = 1;
  private readonly cs = new Float64Array(MAX_STAGES);
  private Nc = 1;
  private ca = 0;
  private cr = 0;
  private compOn = false;
  private kneeSign = 0;
  private kneeLnB = 0;
  private kneeBm1 = 0;
  private kneeInvLnB = 0;
  private sidechain = 0;
  private safety = 0.975;
  // ramped scalars
  private readonly cur = new Float64Array(NR);
  private readonly tgt = new Float64Array(NR);
  private readonly stp = new Float64Array(NR);
  private ramp = 0;
  private inited = false;
  // derived (from cur)
  private ctLin = 1;
  private satD = 0;
  private satInvD = 0;
  private satOn = false;
  // display slices
  private readonly mon = new Float32Array(SLICES * 6);
  private monW = 0;
  private monCount = 0;
  private sPos = 0;
  private sIn = 0;
  private sOut = 0;
  private sG = 1e9;
  private sGc = 1e9;
  private sEnv = 0;
  private sCEnv = 0;
  private grMax = 1;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    const maxL = Math.ceil(sampleRate * (LIM_SHORT_MS / 1000)) + 2;
    this.dlSize = maxL + 1;
    this.dl0 = new Float32Array(this.dlSize);
    this.dl1 = new Float32Array(this.dlSize);
    this.qSize = maxL + 4;
    this.qIdx = new Float64Array(this.qSize);
    this.qVal = new Float64Array(this.qSize);
    this.rSize = maxL;
    this.rbuf = new Float64Array(this.rSize);
    this.setParams({});
    this.inited = false; // the host's first setParams snaps instead of ramping from the defaults
  }

  get latency(): number {
    return this.L;
  }

  /** Seconds the output keeps changing after the input stops: look-ahead flush plus envelope decay. */
  tail = 0.5;

  setParams(raw: unknown): void {
    const p = (raw && typeof raw === 'object' ? raw : {}) as P;
    const g = (k: string) => num(p, k, DEF[k]);
    const sr = this.sr;
    // limiter times
    const L = Math.max(0, Math.min(this.dlSize - 2, Math.round((limTime(g('att'), LIM_SHORT_MS) * sr) / 1000)));
    if (L !== this.L) {
      if (this.inited) { this.fadeFrom = this.L; this.fadeN = RAMP; }
      this.L = L;
    }
    const Wp = Math.round((limTime(g('sustain'), LIM_SHORT_MS) * sr) / 1000);
    this.H = Math.max(1, Math.min(this.qSize - 3, Math.max(Wp, L)));
    const Na = Math.max(1, Math.min(MAX_STAGES, Math.round(g('attCurve'))));
    const Nr = Math.max(1, Math.min(MAX_STAGES, Math.round(g('relCurve'))));
    for (let k = this.Na; k < Na; k++) this.as[k] = this.as[this.Na - 1];
    for (let k = this.Nr; k < Nr; k++) this.rs[k] = this.rs[this.Nr - 1];
    this.Na = Na; this.Nr = Nr;
    this.aAtt = L > 0 ? Math.exp((-LN_ATT * Math.sqrt(Na)) / L) : 0;
    const R = (limTime(g('rel'), LIM_LONG_MS) * sr) / 1000;
    this.aRel = R > 0 ? Math.exp((-LN100 * Math.sqrt(Nr)) / R) : 0;
    const Rg = (limTime(g('nRel'), LIM_LONG_MS) * sr) / 1000;
    this.aGate = Rg > 0 ? Math.exp(-LN100 / Rg) : 0;
    // compressor
    const cThres = g('cThres');
    this.compOn = cThres < 1000;
    const Nc = Math.max(1, Math.min(MAX_STAGES, Math.round(g('cCurve'))));
    for (let k = this.Nc; k < Nc; k++) this.cs[k] = this.cs[this.Nc - 1];
    this.Nc = Nc;
    const cA = (limTime(g('cAtt'), LIM_SHORT_MS) * sr) / 1000;
    const cR = (limTime(g('cRel'), LIM_LONG_MS) * sr) / 1000;
    this.ca = cA > 0 ? Math.exp((-LN100 * Math.sqrt(Nc)) / cA) : 0;
    this.cr = cR > 0 ? Math.exp((-LN100 * Math.sqrt(Nc)) / cR) : 0;
    this.setRmsWindow(Math.max(1, Math.min(this.rSize, Math.round((limTime(g('cSustain'), LIM_SHORT_MS) * sr) / 1000))));
    const knee = Math.round(g('cKnee'));
    const K = Math.abs(knee) / 1000;
    const F = (Math.pow(201, K) - 1) / 200;
    this.kneeSign = knee === 0 || F <= 0 ? 0 : Math.sign(knee);
    if (this.kneeSign > 0) {
      this.kneeBm1 = F; this.kneeLnB = Math.log(1 + F); this.kneeInvLnB = 1 / this.kneeLnB;
    } else if (this.kneeSign < 0) {
      this.kneeBm1 = 0.2 * F; this.kneeLnB = Math.log(1 + 0.2 * F); this.kneeInvLnB = 1 / this.kneeLnB;
    }
    this.sidechain = Math.max(0, Math.round(num(p, 'sidechain', 0)));
    this.safety = p.safety === false ? 1 : 0.975;
    // ramped scalars
    const ceil0 = limCeil(g('ceil'));
    const t = this.tgt;
    t[R_GAIN] = limGain(g('gain'));
    t[R_CEIL] = ceil0;
    t[R_CEFF] = ceil0 * this.safety;
    t[R_SAT] = limCeil(g('sat'));
    t[R_CT] = this.compOn ? limCompThres(cThres) : 1;
    t[R_INVR] = 1 / limRatio(Math.round(g('cRatio')));
    t[R_NG] = limGain(g('nGain'));
    t[R_NT] = limGain(g('nThres'));
    if (!this.inited) {
      this.cur.set(t);
      this.ramp = 0;
      this.inited = true;
    } else {
      let changed = false;
      for (let k = 0; k < NR; k++) if (t[k] !== this.cur[k]) changed = true;
      if (changed) {
        for (let k = 0; k < NR; k++) this.stp[k] = (t[k] - this.cur[k]) / RAMP;
        this.ramp = RAMP;
      }
    }
    this.derive();
    // tail: look-ahead flush + hold + slowest envelope (so the state settles before the mixer idles the track)
    const slow = Math.max(R * 1.2, cR * 1.2, Rg * 1.2);
    this.tail = (L + this.H + slow) / sr + 0.05;
  }

  private derive(): void {
    const c = this.cur;
    this.ctLin = c[R_CT];
    // saturation asymptote: min(1, ceiling); a threshold above it clamps at the threshold (FL)
    const A = Math.min(1, c[R_CEIL]);
    const th = c[R_SAT];
    this.satOn = th < 1;
    this.satD = Math.max(0, A - th);
    this.satInvD = this.satD > 0 ? 1 / this.satD : 0;
  }

  /** Change the RMS window length, keeping the running sum consistent. */
  private setRmsWindow(W: number): void {
    if (W === this.W) return;
    const size = this.rSize, buf = this.rbuf;
    if (W > this.W) {
      for (let k = this.W; k < W; k++) this.rsum += buf[(this.rw - 1 - k + size * 2) % size];
    } else {
      for (let k = W; k < this.W; k++) this.rsum -= buf[(this.rw - 1 - k + size * 2) % size];
    }
    if (this.rsum < 0) this.rsum = 0;
    this.W = W;
  }

  process(Lb: Float32Array, Rb: Float32Array, n: number, ctx: FxContext): void {
    const sc = this.sidechain > 0 ? ctx.sidechain[this.sidechain - 1] : undefined;
    const useSc = this.sidechain > 0;
    const cur = this.cur, tgt = this.tgt, stp = this.stp;
    const dl0 = this.dl0, dl1 = this.dl1, dlSize = this.dlSize;
    const qIdx = this.qIdx, qVal = this.qVal, qSize = this.qSize;
    const rs = this.rs, as = this.as, cs = this.cs, rbuf = this.rbuf, rSize = this.rSize;
    const Nr = this.Nr, Na = this.Na, Nc = this.Nc;
    const aRel = this.aRel, aAtt = this.aAtt, aGate = this.aGate, ca = this.ca, cr = this.cr;
    const L = this.L, H = this.H, W = this.W, invW = 1 / this.W;
    const mon = this.mon;
    const ST = 6;
    let w = this.w, idx = this.n, qHead = this.qHead, qLen = this.qLen;
    let rw = this.rw, rsum = this.rsum, gg = this.gg;
    let sPos = this.sPos, sIn = this.sIn, sOut = this.sOut, sG = this.sG, sGc = this.sGc, sEnv = this.sEnv, sCEnv = this.sCEnv;
    for (let i = 0; i < n; i++) {
      if (this.ramp > 0) {
        for (let k = 0; k < NR; k++) cur[k] += stp[k];
        if (--this.ramp === 0) cur.set(tgt);
        this.derive();
      }
      const gain = cur[R_GAIN];
      let x0 = Lb[i], x1 = Rb[i];
      if (!(x0 === x0) || Math.abs(x0) > 1e9) x0 = 0; // NaN / runaway guard
      if (!(x1 === x1) || Math.abs(x1) > 1e9) x1 = 0;
      // ---- compressor
      // the detector always runs (warm when the threshold leaves 0 dB); the curve only below 0 dB
      let gc = 1;
      let cEnv = 0;
      {
        let d0 = x0, d1 = x1;
        if (useSc) {
          if (sc) { d0 = sc.L[i]; d1 = sc.R[i]; if (!(d0 === d0)) d0 = 0; if (!(d1 === d1)) d1 = 0; } else { d0 = 0; d1 = 0; }
        }
        const e2 = 0.5 * (d0 * d0 + d1 * d1);
        const out = (rw - W + rSize) % rSize;
        rsum += e2 - rbuf[out];
        rbuf[rw] = e2;
        rw = rw + 1 === rSize ? 0 : rw + 1;
        let v = Math.sqrt(rsum > 0 ? rsum * invW : 0);
        for (let k = 0; k < Nc; k++) {
          let s = cs[k];
          s = v + (s - v) * (v > s ? ca : cr);
          if (s < 1e-30) s = 0;
          cs[k] = s; v = s;
        }
        cEnv = v;
        if (this.compOn && v > this.ctLin) {
          const o = 8.685889638065035 * Math.log(v / this.ctLin);
          const op = kneeShape(o, this.kneeSign, this.kneeLnB, this.kneeBm1, this.kneeInvLnB);
          const gdb = op * cur[R_INVR] - o;
          gc = Math.exp(gdb * 0.11512925464970229);
          if (!(gc < 1e6)) gc = 1e6;
        }
      }
      // ---- limiter detector: running max over H samples of the input peak (gain is applied in the gain domain)
      const a0 = x0 < 0 ? -x0 : x0, a1 = x1 < 0 ? -x1 : x1;
      const lvl = a0 > a1 ? a0 : a1;
      while (qLen > 0) {
        const back = (qHead + qLen - 1) % qSize;
        if (qVal[back] <= lvl) qLen--; else break;
      }
      {
        const pos = (qHead + qLen) % qSize;
        qIdx[pos] = idx; qVal[pos] = lvl; qLen++;
      }
      while (qIdx[qHead] <= idx - H) { qHead = qHead + 1 === qSize ? 0 : qHead + 1; qLen--; }
      let v = qVal[qHead];
      for (let k = 0; k < Nr; k++) {
        let s = rs[k];
        s = v >= s ? v : v + (s - v) * aRel;
        if (s < 1e-30) s = 0;
        rs[k] = s; v = s;
      }
      const env = v;
      // ---- total gain: gain x comp gain, capped by the limiter; the closed gate swaps in the noise gain (still capped)
      const ceff = cur[R_CEFF];
      const lim = env > 0 ? ceff / env : Infinity;
      if (env >= cur[R_NT]) { const go = gain * gc; gg = go < lim ? go : lim; }
      else { const ng = cur[R_NG]; gg = ng + (gg - ng) * aGate; if (gg < 1e-30) gg = 0; }
      // ---- attack smoothing
      let u = gg < lim ? gg : lim;
      for (let k = 0; k < Na; k++) {
        let s = u + (as[k] - u) * aAtt;
        if (s < 1e-30) s = 0;
        as[k] = s; u = s;
      }
      // ---- delay line
      dl0[w] = x0; dl1[w] = x1;
      let r = w - L; if (r < 0) r += dlSize;
      let y0 = dl0[r], y1 = dl1[r];
      if (this.fadeN > 0) {
        let r2 = w - this.fadeFrom; if (r2 < 0) r2 += dlSize;
        const f = this.fadeN / RAMP;
        y0 = y0 * (1 - f) + dl0[r2] * f;
        y1 = y1 * (1 - f) + dl1[r2] * f;
        if (--this.fadeN === 0) this.fadeFrom = -1;
      }
      w = w + 1 === dlSize ? 0 : w + 1;
      y0 *= u; y1 *= u;
      // ---- saturation (SAT at 0 dB: hard clip at the ceiling)
      if (this.satOn) {
        const th = cur[R_SAT], d = this.satD, id = this.satInvD;
        const b0 = y0 < 0 ? -y0 : y0;
        if (b0 > th) { const s = d > 0 ? th + d * (1 - Math.exp(-(b0 - th) * id)) : th; y0 = y0 < 0 ? -s : s; }
        const b1 = y1 < 0 ? -y1 : y1;
        if (b1 > th) { const s = d > 0 ? th + d * (1 - Math.exp(-(b1 - th) * id)) : th; y1 = y1 < 0 ? -s : s; }
      } else {
        const c0 = cur[R_CEIL];
        if (y0 > c0) y0 = c0; else if (y0 < -c0) y0 = -c0;
        if (y1 > c0) y1 = c0; else if (y1 < -c0) y1 = -c0;
      }
      Lb[i] = y0; Rb[i] = y1;
      idx++;
      // ---- display slice
      const ai = a0 > a1 ? a0 : a1;
      if (ai > sIn) sIn = ai;
      const ao = Math.max(y0 < 0 ? -y0 : y0, y1 < 0 ? -y1 : y1);
      if (ao > sOut) sOut = ao;
      if (u < sG) sG = u;
      const gcm = gain * gc;
      if (gcm < sGc) sGc = gcm;
      const envG = env * gain;
      if (envG > sEnv) sEnv = envG;
      if (cEnv > sCEnv) sCEnv = cEnv;
      if (++sPos === LIM_SLICE) {
        const o = this.monW * ST;
        mon[o] = sIn; mon[o + 1] = sOut; mon[o + 2] = sG; mon[o + 3] = sGc; mon[o + 4] = sEnv; mon[o + 5] = sCEnv;
        this.monW = (this.monW + 1) % SLICES;
        if (this.monCount < SLICES) this.monCount++;
        if (sG < this.grMax) this.grMax = sG;
        sPos = 0; sIn = 0; sOut = 0; sG = 1e9; sGc = 1e9; sEnv = 0; sCEnv = 0;
      }
    }
    // the release state must not keep sub-normal values around
    this.w = w; this.n = idx; this.qHead = qHead; this.qLen = qLen;
    this.rw = rw; this.rsum = rsum < 0 ? 0 : rsum; this.gg = gg;
    this.sPos = sPos; this.sIn = sIn; this.sOut = sOut; this.sG = sG; this.sGc = sGc; this.sEnv = sEnv; this.sCEnv = sCEnv;
    // keep the sample index small (deque indices are relative to it)
    if (this.n > 1e12) this.rebase();
  }

  private rebase(): void {
    const off = this.n - this.qSize * 2;
    for (let k = 0; k < this.qSize; k++) this.qIdx[k] -= off;
    this.n -= off;
  }

  reset(): void {
    this.dl0.fill(0); this.dl1.fill(0);
    this.w = 0; this.n = 0; this.qHead = 0; this.qLen = 0;
    this.rs.fill(0); this.as.fill(1); this.cs.fill(0);
    this.gg = 1; this.rbuf.fill(0); this.rsum = 0; this.rw = 0;
    this.fadeN = 0; this.fadeFrom = -1;
    this.cur.set(this.tgt); this.ramp = 0; this.derive();
    this.monW = 0; this.monCount = 0; this.sPos = 0; this.sIn = 0; this.sOut = 0; this.sG = 1e9; this.sGc = 1e9; this.sEnv = 0; this.sCEnv = 0;
  }

  /**
   * Display data: the slices written since the last call, 6 values each: input peak,
   * output peak, total gain, gain x comp gain, limiter envelope (gained), comp RMS envelope.
   */
  monitor(): FxMonitor {
    const cnt = this.monCount;
    const d = new Float32Array(cnt * 6);
    const start = (this.monW - cnt + SLICES) % SLICES;
    for (let k = 0; k < cnt; k++) {
      const s = ((start + k) % SLICES) * 6;
      d.set(this.mon.subarray(s, s + 6), k * 6);
    }
    this.monCount = 0;
    const gr = this.grMax;
    this.grMax = 1;
    return { slices: d, n: cnt, slice: LIM_SLICE, sr: this.sr, latency: this.L, gr };
  }
}

export const effect: EffectModule = {
  id: 'limiter',
  create: (sampleRate) => new Limiter(sampleRate),
};
