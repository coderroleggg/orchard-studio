// Transient Processor (FL: Transient Processor). Signal flow (FL's flowchart):
//   in -> 1st-order split: highpass (wet) / complementary lowpass (dry)
//   wet -> transient gain (attack + release) -> saturation (Drive)
//   out = (dry * dryGain + wet * wetGain) * Gain
// The transient gain comes from envelope followers on |HP L| + |HP R| (linked).
// Each section (attack, release) has one detector per direction; its signed
// contribution is a^2 * D (a = amount in -1..1), the two sections add, and the
// sum s maps to the gain as 1 + s (boost) or 1 / (1 - s) (cut). All time
// constants, clamps and laws were measured on FL's plugin (see
// docs/research/fx/transient.md); constants are 48 kHz samples, scaled to the
// running sample rate.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';

// ---- measured constants (index = shape: 0 Sharp, 1 Mid, 2 Slow) ----
// Fitted on FL's output for drums and stepped tones (gain-curve error
// 0.15-0.4 dB rms; the release cut path is exact).
/** Attack cut: slow follower attack (fast follower is instant); shared release. */
const AN_ATT = [41.38, 84.42, 172.52];
const AN_REL = 4000;
/** Attack boost: follower attacks, release and ratio scale. */
const AP_ATT1 = [3.27, 3.55, 4.99];
const AP_ATT2 = [39.57, 74.02, 154.56];
const AP_REL = [4255.8, 4140.8, 4118.7];
const AP_K = [0.9781, 0.97424, 0.96343];
const AP_MAX = 2.24;
/** Release cut: slow / fast release of two instant-attack followers (exact). */
const RN_REL1 = 83469;
const RN_REL2 = [1042.3, 2084.7, 4168.8];
/** Release boost: alpha * (slow / fast - 1) - beta, slightly smoothed fast follower. */
const RP_REL1 = [88423, 88334, 84560];
const RP_REL2 = [1156.9, 2306.9, 4612.2];
const RP_SM = [1.397, 1.09, 0.874];
const RP_ALPHA = [0.443, 0.43932, 0.45622];
const RP_BETA = [0.09234, 0.09511, 0.10378];
const RP_MAX = 6.6;
/** A block whose detector peak is below this is silence (FL waits for signal before priming its followers). */
const SILENCE = 1.5e-6;
const TINY = 1e-24;
/** FL's parameter smoothing: one-pole on the control values, ~17.3 ms (measured). */
const SMOOTH_SEC = 0.0173;

/** Saturation drive factor k: y = S(k x) / k (unity small-signal gain, ceiling 1/k). */
export function driveK(v: number): number {
  const d = Math.min(1, Math.max(0, v / 160));
  return d <= 0.1 ? 0.1 + 9 * d : Math.pow(15, (d - 0.1) / 0.9);
}

/** FL's soft clipper: the rational tanh approximation, clamped at |u| = 3. */
export function satCurve(u: number): number {
  if (u >= 3) return 1;
  if (u <= -3) return -1;
  const u2 = u * u;
  return (u * (27 + u2)) / (27 + 9 * u2);
}

interface ShapeCoefs {
  anAtt: number; apAtt1: number; apAtt2: number; apRel: number; apK: number;
  rnRel2: number; rpRel1: number; rpRel2: number; rpSm: number; rpAlpha: number; rpBeta: number;
}

const attCoef = (tau48: number, sr: number) => 1 - Math.exp(-1 / Math.max(1e-6, (tau48 * sr) / 48000));
const relCoef = (tau48: number, sr: number) => Math.exp(-1 / Math.max(1e-6, (tau48 * sr) / 48000));

const CHUNK = 64; // samples per graph column (at 48 kHz, scaled)
const HIST = 2048;

class TransientProcessor implements EffectInstance {
  readonly tail = 2; // followers keep decaying through short silences, as in FL
  private sr: number;
  private shapes: ShapeCoefs[] = [];
  private aRel: number;
  private rnRel1: number;
  // control-value targets (FL units) and their smoothed values
  private tAtt = 80; private tRel = 80; private tDrive = 0; private tBal = 80; private tGain = 80; private tSplit = 80; private tOn = 1;
  private vAtt = 80; private vRel = 80; private vDrive = 0; private vBal = 80; private vGain = 80; private vSplit = 80; private vOn = 1;
  private attShape = 1; private relShape = 1;
  // physical values at the end of the current block
  private att = 0; private rel = 0;
  private k = 0.1; private dry = 1; private wet = 1; private out = 1; private on = 1; private fcoef = 0;
  // ramp state (values at the end of the previous block)
  private att0 = 0; private rel0 = 0; private k0 = 0.1; private dry0 = 1; private wet0 = 1; private out0 = 1; private on0 = 1; private fcoef0 = 0;
  // split filters (TPT one-pole lowpass state)
  private sL = 0; private sR = 0;
  // followers
  private primed = false;
  private anF = 0; private anS = 0; private ap1 = 0; private ap2 = 0;
  private rn1 = 0; private rn2 = 0; private rp1 = 0; private rp2a = 0; private rp2 = 0;
  // monitor
  private pkInL = 0; private pkInR = 0; private pkOutL = 0; private pkOutR = 0; private satMax = 0;
  private chunkLen: number; private chunkPos = 0;
  private cIn = 0; private cOut = 0; private cGain = 0;
  private hIn = new Float32Array(HIST); private hOut = new Float32Array(HIST); private hGain = new Float32Array(HIST);
  private hWrite = 0; private hRead = 0;

  constructor(sr: number) {
    this.sr = sr;
    this.aRel = relCoef(AN_REL, sr);
    this.rnRel1 = relCoef(RN_REL1, sr);
    for (let s = 0; s < 3; s++) {
      this.shapes.push({
        anAtt: attCoef(AN_ATT[s], sr), apAtt1: attCoef(AP_ATT1[s], sr), apAtt2: attCoef(AP_ATT2[s], sr), apRel: relCoef(AP_REL[s], sr), apK: AP_K[s],
        rnRel2: relCoef(RN_REL2[s], sr), rpRel1: relCoef(RP_REL1[s], sr), rpRel2: relCoef(RP_REL2[s], sr),
        rpSm: attCoef(RP_SM[s], sr), rpAlpha: RP_ALPHA[s], rpBeta: RP_BETA[s],
      });
    }
    this.chunkLen = Math.max(16, Math.round((CHUNK * sr) / 48000));
    this.setParams({});
    this.reset();
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number) => { const v = q[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d; };
    const cl = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    this.tAtt = cl(num('attack', 80), 0, 160);
    this.tRel = cl(num('release', 80), 0, 160);
    this.attShape = cl(Math.round(num('attackShape', 1)), 0, 2);
    this.relShape = cl(Math.round(num('releaseShape', 1)), 0, 2);
    this.tDrive = cl(num('drive', 0), 0, 160);
    this.tBal = cl(num('splitBal', 80), 0, 160);
    this.tGain = cl(num('gain', 80), 0, 160);
    this.tSplit = cl(num('splitFreq', 80), 0, 160);
    this.tOn = num('effect', 1) >= 0.5 ? 1 : 0;
  }

  /** Physical values from the smoothed control values. */
  private derive(): void {
    this.att = (this.vAtt - 80) / 80;
    this.rel = (this.vRel - 80) / 80;
    this.k = driveK(this.vDrive);
    this.dry = Math.min(1, (160 - this.vBal) / 80);
    this.wet = Math.min(1, this.vBal / 80);
    this.out = Math.pow(10, (((this.vGain - 80) / 80) * 9) / 20);
    this.on = this.vOn;
    const t = this.vSplit / 160;
    const fc = Math.min(5 + 995 * t * t, this.sr * 0.45);
    const g = Math.tan((Math.PI * fc) / this.sr);
    this.fcoef = g / (1 + g);
  }

  /** Advance the parameter smoothers by n samples and derive this block's end values. */
  private smooth(n: number): void {
    const c = 1 - Math.exp(-n / (SMOOTH_SEC * this.sr));
    const st = (v: number, t: number) => { const d = t - v; return Math.abs(d) < 1e-4 ? t : v + d * c; };
    this.vAtt = st(this.vAtt, this.tAtt); this.vRel = st(this.vRel, this.tRel); this.vDrive = st(this.vDrive, this.tDrive);
    this.vBal = st(this.vBal, this.tBal); this.vGain = st(this.vGain, this.tGain); this.vSplit = st(this.vSplit, this.tSplit);
    this.vOn = st(this.vOn, this.tOn);
    this.derive();
  }

  process(L: Float32Array, R: Float32Array, n: number, _ctx: FxContext): void {
    void _ctx;
    if (n <= 0) return;
    this.smooth(n);
    const inv = 1 / n;
    const a0 = this.att0, da = (this.att - a0) * inv;
    const r0 = this.rel0, dr = (this.rel - r0) * inv;
    const k0 = this.k0, dk = (this.k - k0) * inv;
    const y0 = this.dry0, dy = (this.dry - y0) * inv;
    const w0 = this.wet0, dw = (this.wet - w0) * inv;
    const o0 = this.out0, dout = (this.out - o0) * inv;
    const b0 = this.on0, db = (this.on - b0) * inv;
    const f0 = this.fcoef0, df = (this.fcoef - f0) * inv;

    if (!this.primed) {
      // FL starts its followers on the first non-silent block, at that block's level
      let pk = 0, sL = this.sL, sR = this.sR;
      for (let i = 0; i < n; i++) {
        const G = f0 + df * i;
        const hl = L[i] - (sL + (L[i] - sL) * G), hr = R[i] - (sR + (R[i] - sR) * G);
        const vl = (L[i] - sL) * G; sL += 2 * vl;
        const vr = (R[i] - sR) * G; sR += 2 * vr;
        const a = Math.abs(hl) + Math.abs(hr);
        if (a > pk) pk = a;
      }
      if (pk >= SILENCE) {
        this.primed = true;
        this.anF = this.anS = this.ap1 = this.ap2 = pk;
        this.rn1 = this.rn2 = this.rp1 = this.rp2a = this.rp2 = pk;
      }
    }

    const A = this.shapes[this.attShape], Rs = this.shapes[this.relShape];
    const aRel = this.aRel, anAtt = A.anAtt, apAtt1 = A.apAtt1, apAtt2 = A.apAtt2, apRel = A.apRel, apK = A.apK;
    const rnRel1 = this.rnRel1, rnRel2 = Rs.rnRel2, rpRel1 = Rs.rpRel1, rpRel2 = Rs.rpRel2, rpSm = Rs.rpSm;
    const rpAlpha = Rs.rpAlpha, rpBeta = Rs.rpBeta;
    const primed = this.primed;
    let sL = this.sL, sR = this.sR;
    let anF = this.anF, anS = this.anS, ap1 = this.ap1, ap2 = this.ap2;
    let rn1 = this.rn1, rn2 = this.rn2, rp1 = this.rp1, rp2a = this.rp2a, rp2 = this.rp2;
    let pkInL = this.pkInL, pkInR = this.pkInR, pkOutL = this.pkOutL, pkOutR = this.pkOutR, satMax = this.satMax;
    let cIn = this.cIn, cOut = this.cOut, cGain = this.cGain, chunkPos = this.chunkPos;
    const chunkLen = this.chunkLen;

    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      // split: TPT one-pole lowpass, highpass = input - lowpass (exactly complementary)
      const G = f0 + df * i;
      const vl = (xl - sL) * G, lpl = sL + vl; sL = lpl + vl;
      const vr = (xr - sR) * G, lpr = sR + vr; sR = lpr + vr;
      const hpl = xl - lpl, hpr = xr - lpr;

      let gain = 1;
      if (primed) {
        const a = (hpl < 0 ? -hpl : hpl) + (hpr < 0 ? -hpr : hpr);
        // attack section followers
        anF = a > anF ? a : anF * aRel;
        anS = a > anS ? anS + anAtt * (a - anS) : anS * aRel;
        ap1 = a > ap1 ? ap1 + apAtt1 * (a - ap1) : ap1 * apRel;
        ap2 = a > ap2 ? ap2 + apAtt2 * (a - ap2) : ap2 * apRel;
        // release section followers
        rn1 = a > rn1 ? a : rn1 * rnRel1;
        rn2 = a > rn2 ? a : rn2 * rnRel2;
        rp1 = a > rp1 ? a : rp1 * rpRel1;
        rp2a = a > rp2a ? a : rp2a * rpRel2;
        rp2 += rpSm * (rp2a - rp2);

        const at = a0 + da * i, rl = r0 + dr * i;
        let s = 0;
        if (at > 0) {
          let d = (apK * (ap1 + TINY)) / (ap2 + TINY) - 1;
          if (d > AP_MAX) d = AP_MAX;
          s += at * at * d;
        } else if (at < 0) {
          s -= at * at * ((anF + TINY) / (anS + TINY) - 1);
        }
        if (rl > 0) {
          let d = rpAlpha * ((rp1 + TINY) / (rp2 + TINY) - 1) - rpBeta;
          if (d > RP_MAX) d = RP_MAX;
          s += rl * rl * d;
        } else if (rl < 0) {
          s -= rl * rl * ((rn1 + TINY) / (rn2 + TINY) - 1);
        }
        gain = s >= 0 ? 1 + s : 1 / (1 - s);
      }

      // saturation (Drive) on the processed highpass part
      const kk = k0 + dk * i, ik = 1 / kk;
      const ul = kk * hpl * gain, ur = kk * hpr * gain;
      const au = Math.max(ul < 0 ? -ul : ul, ur < 0 ? -ur : ur);
      if (au > satMax) satMax = au;
      const wl = satCurve(ul) * ik, wr = satCurve(ur) * ik;

      const og = o0 + dout * i, dg = (y0 + dy * i) * og, wg = (w0 + dw * i) * og;
      const pl = lpl * dg + wl * wg, pr = lpr * dg + wr * wg;
      const on = b0 + db * i;
      const ol = on >= 1 ? pl : on <= 0 ? xl : xl + (pl - xl) * on;
      const or = on >= 1 ? pr : on <= 0 ? xr : xr + (pr - xr) * on;
      L[i] = ol; R[i] = or;

      // meters and graph
      const il = xl < 0 ? -xl : xl, ir = xr < 0 ? -xr : xr, al = ol < 0 ? -ol : ol, ar = or < 0 ? -or : or;
      if (il > pkInL) pkInL = il;
      if (ir > pkInR) pkInR = ir;
      if (al > pkOutL) pkOutL = al;
      if (ar > pkOutR) pkOutR = ar;
      const mi = il > ir ? il : ir, mo = al > ar ? al : ar;
      if (mi > cIn) cIn = mi;
      if (mo > cOut) cOut = mo;
      const gd = gain - 1, gm = cGain - 1;
      if ((gd < 0 ? -gd : gd) > (gm < 0 ? -gm : gm)) cGain = gain;
      if (++chunkPos >= chunkLen) {
        const w = this.hWrite;
        this.hIn[w] = cIn; this.hOut[w] = cOut; this.hGain[w] = cGain;
        this.hWrite = (w + 1) % HIST;
        if (this.hWrite === this.hRead) this.hRead = (this.hRead + 1) % HIST;
        cIn = 0; cOut = 0; cGain = 1; chunkPos = 0;
      }
    }

    // keep the followers finite and out of the denormal range
    const fl = (v: number) => (v > 1e-30 && v < 1e30 ? v : v >= 1e30 ? 1e30 : 0);
    this.sL = Number.isFinite(sL) ? sL : 0; this.sR = Number.isFinite(sR) ? sR : 0;
    this.anF = fl(anF); this.anS = fl(anS); this.ap1 = fl(ap1); this.ap2 = fl(ap2);
    this.rn1 = fl(rn1); this.rn2 = fl(rn2); this.rp1 = fl(rp1); this.rp2a = fl(rp2a); this.rp2 = fl(rp2);
    this.pkInL = pkInL; this.pkInR = pkInR; this.pkOutL = pkOutL; this.pkOutR = pkOutR; this.satMax = satMax;
    this.cIn = cIn; this.cOut = cOut; this.cGain = cGain; this.chunkPos = chunkPos;
    this.att0 = this.att; this.rel0 = this.rel; this.k0 = this.k; this.dry0 = this.dry; this.wet0 = this.wet;
    this.out0 = this.out; this.on0 = this.on; this.fcoef0 = this.fcoef;
  }

  reset(): void {
    this.vAtt = this.tAtt; this.vRel = this.tRel; this.vDrive = this.tDrive; this.vBal = this.tBal;
    this.vGain = this.tGain; this.vSplit = this.tSplit; this.vOn = this.tOn;
    this.derive();
    this.att0 = this.att; this.rel0 = this.rel; this.k0 = this.k; this.dry0 = this.dry; this.wet0 = this.wet;
    this.out0 = this.out; this.on0 = this.on; this.fcoef0 = this.fcoef;
    this.sL = this.sR = 0;
    this.primed = false;
    this.anF = this.anS = this.ap1 = this.ap2 = 0;
    this.rn1 = this.rn2 = this.rp1 = this.rp2a = this.rp2 = 0;
    this.pkInL = this.pkInR = this.pkOutL = this.pkOutR = this.satMax = 0;
    this.cIn = this.cOut = 0; this.cGain = 1; this.chunkPos = 0;
    this.hWrite = this.hRead = 0;
  }

  monitor(): FxMonitor {
    const n = (this.hWrite - this.hRead + HIST) % HIST;
    const gIn: number[] = new Array(n), gOut: number[] = new Array(n), gGain: number[] = new Array(n);
    for (let j = 0, r = this.hRead; j < n; j++, r = (r + 1) % HIST) { gIn[j] = this.hIn[r]; gOut[j] = this.hOut[r]; gGain[j] = this.hGain[r]; }
    this.hRead = this.hWrite;
    const m: FxMonitor = {
      inL: this.pkInL, inR: this.pkInR, outL: this.pkOutL, outR: this.pkOutR, sat: this.satMax,
      gIn, gOut, gGain, chunk: this.chunkLen / this.sr,
    };
    this.pkInL = this.pkInR = this.pkOutL = this.pkOutR = this.satMax = 0;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'transient',
  create: (sampleRate) => new TransientProcessor(sampleRate),
};
