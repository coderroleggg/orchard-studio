// Compressor (FL: Fruity Compressor). This is FL's own algorithm, read from the
// plugin's arm64 code and verified sample by sample against renders of FL's
// binary (max error 3e-5, float32 vs float64; see docs/research/fx/compressor.md):
//
//  input -> 3 Hz DC blocker (allpass-based: hp = (x - ap)/2) -> detector
//    max(|L|,|R|) (or the raw sidechain input) -> peak follower (attack
//    0.01 ms, release 1 ms) -> ln(level) -> gain computer (quadratic knee of
//    ±0/6/7/15 dB; Vintage: smoothstep curve that returns to 1:1 at
//    ln T + 1.25·R^¼) -> gain smoothing (attack / release; TCR blends the
//    release toward release/10 by the distance to a slow follower of the gain)
//    -> makeup gain -> 64-sample look-ahead limiter at -0.1 dBFS (smoothstep
//    attack ramp scheduled in a gain ring, 64-sample hold, accelerating release).
// Times use coef(T) = 0.1^(1 / (T·sr/1000)).

import type { EffectInstance, EffectModule, FxContext } from '../types';
import { COMPRESSOR_PARAMS } from '../../../model/fx/plugins/compressor';

const KNEE_DB = [0, 6, 7, 15];
const LA = 64; // limiter look-ahead (samples, at any rate)
const RING = LA * 2;
const CEIL = 0.9885531;
const TINY = 1e-30;

const coef = (ms: number, sr: number): number => (ms === 0 ? 0 : Math.pow(0.1, 1 / ((ms * sr) / 1000)));

interface Params { thr: number; ratio: number; gain: number; att: number; rel: number; type: number }

const DEF: Params = Object.fromEntries(COMPRESSOR_PARAMS.map((q) => [q.key, q.def])) as unknown as Params;

function readParams(raw: Record<string, unknown>): Params {
  const o = { ...DEF };
  for (const q of COMPRESSOR_PARAMS) {
    const v = raw[q.key];
    if (typeof v === 'number' && Number.isFinite(v)) (o as unknown as Record<string, number>)[q.key] = Math.min(q.max, Math.max(q.min, Math.round(v)));
  }
  return o;
}

class Compressor implements EffectInstance {
  private readonly sr: number;
  private p: Params = { ...DEF };
  private dirty = true;
  private first = true;
  private sidechain = 0;
  private report = true;
  // coefficients (update)
  private aDet = 0;
  private rDet = 0;
  private aAtt = 0;
  private rNorm = 0;
  private rFast = 0;
  private vintage = false;
  private lnT = 0;
  private lb = 0;
  private ub = 0;
  private kq = 0;
  private slope = 0;
  private gub = 1;
  private inv = 0;
  private s20 = 0;
  private s24 = 0;
  private dca = 0;
  // makeup gain (FL steps it at the parameter update)
  private mk = 1;
  // state
  private env = 0;
  private g = 1;
  private follow = 1;
  private rcoef = 0.5;
  private apL = TINY; private xL = TINY; private apR = TINY; private xR = TINY;
  // limiter
  private readonly gring = new Float64Array(RING);
  private readonly aring = new Float32Array(LA * 2);
  private posA = 0;
  private posG = 0;
  private target = 1;
  private applied = 1;
  private hold = 0;
  private rspeed = 0.01;
  // meters
  private grMin = 1;
  private inPk = 0;
  private outPk = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.reset();
    this.update();
  }

  get latency(): number {
    return this.report ? LA : 0;
  }

  tail = 1;

  setParams(raw: unknown): void {
    const q = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const np = readParams(q);
    const p = this.p;
    if (np.thr !== p.thr || np.ratio !== p.ratio || np.gain !== p.gain || np.att !== p.att || np.rel !== p.rel || np.type !== p.type) {
      this.p = np;
      this.dirty = true;
    }
    this.sidechain = Math.max(0, Math.round(Number(q.sidechain) || 0));
    this.report = q.reportLatency !== false;
    if (this.first) {
      this.first = false;
      this.update();
    }
    this.tail = LA / this.sr + (2 * this.p.rel) / 1000 + 1.5;
  }

  /** FL's parameter update: coefficients, curve constants; resets the limiter target and the TCR follower. */
  private update(): void {
    const p = this.p, sr = this.sr;
    this.follow = 1;
    this.aDet = coef(0.01, sr);
    this.rDet = coef(1, sr);
    this.aAtt = coef(p.att / 10, sr);
    const tcr = p.type >= 4;
    const kneeDb = KNEE_DB[p.type % 4];
    this.vintage = p.type % 4 === 2;
    this.rNorm = coef(p.rel, sr);
    this.rFast = tcr ? coef(p.rel * 0.1, sr) : this.rNorm;
    const T = Math.pow(10, p.thr / 200);
    const R = p.ratio / 10;
    this.mk = Math.pow(10, p.gain / 200);
    const kl = Math.pow(10, -kneeDb / 20);
    let slope = 1 / R - 1;
    this.lnT = Math.log(T);
    this.lb = Math.log(T * kl);
    this.ub = Math.log(T / kl);
    this.kq = this.ub !== this.lb ? 0.5 / (this.ub - this.lb) : Infinity;
    if (this.vintage) {
      const ub = this.lnT + 1.25 * Math.pow(R, 0.25);
      this.gub = Math.exp((ub - this.lnT) * slope);
      const ub2 = Math.log(Math.exp(ub) / kl);
      slope = ub2 !== this.lnT ? Math.log(this.gub) / (ub2 - this.lnT) : 0;
      this.ub = ub2;
    }
    this.slope = slope;
    this.inv = this.ub !== this.lb ? 1 / (this.ub - this.lb) : Infinity;
    this.s20 = (this.ub - this.lnT) * slope;
    this.s24 = Math.min(1, this.lnT - this.lb);
    this.target = 1;
    this.hold = 0;
    this.rspeed = 0.01;
    const t = Math.tan((3 * Math.PI) / sr);
    this.dca = (t - 1) / (t + 1);
    this.dirty = false;
  }

  process(Lb: Float32Array, Rb: Float32Array, n: number, ctx: FxContext): void {
    if (this.dirty) this.update();
    const sc = this.sidechain > 0 ? ctx.sidechain[this.sidechain - 1] : undefined;
    const scRaw = this.sidechain > 0 && !sc; // selected but not routed: FL reads its own raw input
    const gring = this.gring, aring = this.aring;
    const aDet = this.aDet, rDet = this.rDet, aAtt = this.aAtt, rNorm = this.rNorm, rFast = this.rFast;
    const lb = this.lb, ub = this.ub, lnT = this.lnT, kq = this.kq, slope = this.slope, inv = this.inv, s20 = this.s20, s24 = this.s24;
    const vintage = this.vintage, gub = this.gub, dca = this.dca, mk = this.mk;
    let env = this.env, g = this.g, follow = this.follow, rcoef = this.rcoef;
    let apL = this.apL, xL = this.xL, apR = this.apR, xR = this.xR;
    let posA = this.posA, posG = this.posG, target = this.target, applied = this.applied, hold = this.hold, rspeed = this.rspeed;
    let grMin = this.grMin, inPk = this.inPk, outPk = this.outPk;
    for (let i = 0; i < n; i++) {
      let x0 = Lb[i], x1 = Rb[i];
      if (!(x0 === x0) || Math.abs(x0) > 1e9) x0 = 0;
      if (!(x1 === x1) || Math.abs(x1) > 1e9) x1 = 0;
      let L = x0 + TINY, R = x1 + TINY;
      let dl = 0, dr = 0;
      if (sc) { dl = Math.abs(sc.L[i] + TINY); dr = Math.abs(sc.R[i] + TINY); if (!(dl < 1e9)) dl = 0; if (!(dr < 1e9)) dr = 0; }
      else if (scRaw) { dl = Math.abs(L); dr = Math.abs(R); }
      // DC blocker (3 Hz)
      let ap = (L - apL) * dca + xL; apL = ap; xL = L; L = (L - ap) * 0.5;
      ap = (R - apR) * dca + xR; apR = ap; xR = R; R = (R - ap) * 0.5;
      if (!sc && !scRaw) { dl = L < 0 ? -L : L; dr = R < 0 ? -R : R; }
      const pk = (dl > dr ? dl : dr);
      if (pk > inPk) inPk = pk;
      const s9 = pk + TINY;
      env = s9 + (env - s9) * (s9 > env ? aDet : rDet);
      const lv = Math.log(env);
      let s8 = 1;
      if (lv >= lb) {
        if (vintage) {
          if (lv >= ub) s8 = gub;
          else {
            const xx = (lv - lb) * inv;
            const ss = xx * xx * (3 - 2 * xx);
            s8 = Math.exp(s20 * (xx + (ss - xx) * s24));
          }
        } else if (lv >= ub) s8 = Math.exp((lv - lnT) * slope);
        else { const d = lv - lb; s8 = Math.exp(slope * d * d * kq); }
      }
      s8 = s8 > g ? s8 + (g - s8) * rcoef : s8 + (g - s8) * aAtt;
      g = s8;
      // transient controlled release
      let f = s8 + (follow - s8) * rNorm;
      if (f < s8) f = s8;
      follow = f;
      const dd = vintage ? (0.707 - s8) * 1.414 : f - s8;
      const rc = rNorm + (rFast - rNorm) * dd;
      rcoef = rc > 0 ? rc : 0;
      if (s8 < grMin) grMin = s8;
      // makeup
      s8 *= mk;
      const oL = L * s8, oR = R * s8;
      const s13 = Math.max(oL < 0 ? -oL : oL, oR < 0 ? -oR : oR);
      // look-ahead limiter
      if (s13 > 1) {
        const req = CEIL / s13;
        if (req < target) {
          target = req;
          const cur = applied;
          if (hold <= 0) gring.fill(cur);
          hold = LA;
          rspeed = 0;
          for (let j = 0; j < RING; j++) {
            const idx = (j + posG) % RING;
            const s10 = j + 1 < LA ? (j + 1) / LA : 1;
            const v = cur + (req - cur) * s10 * s10 * (3 - 2 * s10);
            if (v < gring[idx]) gring[idx] = v;
          }
        } else if (hold <= 0) {
          rspeed += (0.09 - rspeed) * 5e-5;
          target += (req - target) * rspeed;
        }
      } else if (hold <= 0) {
        rspeed += (0.09 - rspeed) * 5e-5;
        target += (1 - target) * rspeed;
      }
      if (hold > 0) hold--;
      applied = gring[posG];
      gring[posG] = target;
      const y0 = aring[posA] * applied, y1 = aring[posA + 1] * applied;
      aring[posA] = oL; aring[posA + 1] = oR;
      posA += 2; if (posA >= LA * 2) posA = 0;
      posG += 1; if (posG >= RING) posG = 0;
      Lb[i] = y0; Rb[i] = y1;
      const ao = Math.max(y0 < 0 ? -y0 : y0, y1 < 0 ? -y1 : y1);
      if (ao > outPk) outPk = ao;
    }
    this.env = env; this.g = g; this.follow = follow; this.rcoef = rcoef;
    this.apL = apL; this.xL = xL; this.apR = apR; this.xR = xR;
    this.posA = posA; this.posG = posG; this.target = target; this.applied = applied; this.hold = hold; this.rspeed = rspeed;
    this.grMin = grMin; this.inPk = inPk; this.outPk = outPk;
  }

  reset(): void {
    this.posA = 0; this.posG = 0;
    this.rcoef = 0.5; this.applied = 1; this.env = 0; this.g = 1; this.target = 1; this.hold = 0; this.follow = 1;
    this.gring.fill(1); this.aring.fill(0);
    this.apL = this.xL = this.apR = this.xR = TINY;
    this.dirty = true;
  }

  monitor() {
    const m = { gr: this.grMin, in: this.inPk, out: this.outPk };
    this.grMin = 1; this.inPk = 0; this.outPk = 0;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'compressor',
  create: (sampleRate) => new Compressor(sampleRate),
};
