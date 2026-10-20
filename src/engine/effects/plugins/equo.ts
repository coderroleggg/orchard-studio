// EQUO. Measured sample-exact against FL's binary through its plugin state
// (docs/research/fx/equo.md):
// - 31 RBJ band passes at 20 * 2^(j/3) Hz with the RBJ digital bandwidth of
//   BW / 300 octaves, peak gain 10^(-3/20) * 100 / BW (so the bank sums about
//   flat). The top three bands run at twice the rate on a linearly
//   interpolated input (RBJ designed at 2x), unless OVERSAMPLE is on; bands at
//   or above the internal Nyquist frequency are silent. OVERSAMPLE runs the
//   whole bank at 2x (HIIR halfbands, as Love Philter) and reports no latency.
// - Curves: per bank, band mix scales the deviation from neutral, band shift
//   moves the curve by up to 30 bands (linear interpolation of the gains -
//   of the values for pan -, edge values beyond the ends), then the morph
//   blends the two banks' band values; volume / send gain (3^v - 1) / 2. The
//   master bank multiplies the gains and adds its pan offsets; pan is a linear
//   balance. Band modes (off / locked) only affect editing.
// - ADD MODE outputs x + sum (gain - 1) band; SEND ONLY passes the dry input
//   (the EQ'd signal only goes to the send track). Output volume
//   (11^(x/128) - 1) / 10, moved linearly across each block by at most
//   44.1 / s, as FL.
// - Like FL, processing stops after 0.2 s of digital silence (states frozen).
// - Motion smoothness glides the band gains: FL's curve updates are driven by
//   its editor and cannot be measured with the test host, the time constant
//   is a model.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import {
  EQUO_BANDS, EQUO_BANKS, EQUO_ONE, equoFreq, equoGain, equoKey, equoNormalizeState, equoVol, type EquoState,
} from '../../../model/fx/plugins/equo';

const LN3 = Math.log(3);
const HB0 = [0.039151597734460045, 0.3026468483284934, 0.6746159185469639];
const HB1 = [0.1473771136010466, 0.48246854276970014, 0.8830050257693731];

class Allpass3 {
  private x = new Float64Array(3);
  private y = new Float64Array(3);
  constructor(private readonly c: number[]) {}
  tick(v: number): number {
    for (let k = 0; k < 3; k++) { const a = this.c[k]; const o = a * v + this.x[k] - a * this.y[k]; this.x[k] = v; this.y[k] = o; v = o; }
    return v;
  }
  clear(): void { this.x.fill(0); this.y.fill(0); }
}

class Equo implements EffectInstance {
  latency = 0;
  tail = 0.25;
  private readonly sr: number;
  private p: Record<string, number> = {};
  private st: EquoState = equoNormalizeState(null);
  private rate = 0;
  private bwKey = -1;
  // band pass coefficients (shared), states [ch][band][2]
  private readonly b0 = new Float64Array(EQUO_BANDS);
  private readonly a1 = new Float64Array(EQUO_BANDS);
  private readonly a2 = new Float64Array(EQUO_BANDS);
  private readonly on = new Uint8Array(EQUO_BANDS);
  private readonly x2 = new Uint8Array(EQUO_BANDS);
  private readonly xp = new Float64Array(2); // previous bank input per channel (top bands)
  private readonly s = [new Float64Array(EQUO_BANDS * 2), new Float64Array(EQUO_BANDS * 2)];
  // target and smoothed per-band weights: left / right gains and send gain
  private readonly tL = new Float64Array(EQUO_BANDS); private readonly tR = new Float64Array(EQUO_BANDS); private readonly tS = new Float64Array(EQUO_BANDS);
  private readonly cL = new Float64Array(EQUO_BANDS); private readonly cR = new Float64Array(EQUO_BANDS); private readonly cS = new Float64Array(EQUO_BANDS);
  private readonly dL = new Float64Array(EQUO_BANDS); private readonly dR = new Float64Array(EQUO_BANDS); private readonly dS = new Float64Array(EQUO_BANDS);
  private readonly runW = new Float64Array(EQUO_BANDS); private readonly runS = new Float64Array(EQUO_BANDS);
  private vol = 1;
  private vCur = 1;
  private fresh = true;
  private quiet = 0; // samples of digital silence at the input
  private readonly cur = new Float64Array(EQUO_BANDS * 3); // curve values after mix / shift / morph (volume, pan, send)
  private readonly shf = new Float64Array(EQUO_BANDS); // one bank's curve before the shift
  // oversampling
  private readonly up = [[new Allpass3(HB0), new Allpass3(HB1)], [new Allpass3(HB0), new Allpass3(HB1)]];
  private readonly down = [[new Allpass3(HB0), new Allpass3(HB1)], [new Allpass3(HB0), new Allpass3(HB1)]];
  private readonly downS = [[new Allpass3(HB0), new Allpass3(HB1)], [new Allpass3(HB0), new Allpass3(HB1)]];
  private readonly sendL: Float32Array; private readonly sendR: Float32Array;
  // band levels for the editor (input band outputs, mean square since the last monitor call)
  private readonly pw = new Float64Array(EQUO_BANDS);
  private pwN = 0;
  private readonly lev = new Float32Array(EQUO_BANDS).fill(-120);

  constructor(sampleRate: number, blockSize: number) {
    this.sr = sampleRate;
    const n = Math.max(1024, blockSize);
    this.sendL = new Float32Array(n); this.sendR = new Float32Array(n);
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const o: Record<string, number> = {};
    for (const k in q) { const v = q[k]; if (typeof v === 'number' && Number.isFinite(v)) o[k] = v; }
    this.p = o;
    this.st = equoNormalizeState(q.eq);
    const rate = this.sr * (this.st.os ? 2 : 1);
    if (rate !== this.rate || this.st.bw !== this.bwKey) { this.rate = rate; this.bwKey = this.st.bw; this.design(); }
    this.targets();
    if (this.fresh) { this.cL.set(this.tL); this.cR.set(this.tR); this.cS.set(this.tS); this.vCur = this.vol; this.fresh = false; }
  }

  private design(): void {
    const N = this.st.bw / 300; // octaves
    const peak = (100 / this.st.bw) * Math.pow(10, -3 / 20);
    for (let j = 0; j < EQUO_BANDS; j++) {
      const f = equoFreq(j);
      this.on[j] = f < this.rate / 2 ? 1 : 0;
      // the top three bands run at twice the rate on a linearly interpolated input
      const x2 = j >= EQUO_BANDS - 3 && !this.st.os;
      this.x2[j] = x2 ? 1 : 0;
      const r = x2 ? 2 * this.rate : this.rate;
      const w0 = (2 * Math.PI * Math.min(f, r * 0.49)) / r, sw = Math.sin(w0), cw = Math.cos(w0);
      const al = sw * Math.sinh(((Math.LN2 / 2) * N * w0) / sw);
      const ia = 1 / (1 + al);
      this.b0[j] = al * ia * peak; this.a1[j] = -2 * cw * ia; this.a2[j] = (1 - al) * ia;
    }
  }

  /** Band value of bank b (-1 master), kind, band j (0..2). */
  private val(b: number, kind: 'v' | 'p' | 's', j: number): number {
    const v = this.p[equoKey(b, kind, j)];
    return (v === undefined ? EQUO_ONE : v) / EQUO_ONE;
  }

  private targets(): void {
    const p = this.p, B = EQUO_BANDS, c = this.cur, sh = this.shf;
    const morph = Math.min(7, Math.max(0, (p.morph ?? 0) / 1000));
    const b0 = Math.min(EQUO_BANKS - 1, Math.floor(morph)), b1 = Math.min(EQUO_BANKS - 1, b0 + 1), t = morph - b0;
    const mix = (p.mix ?? 128) / 128;
    const shift = ((p.shift ?? 0) / 12000) * 30;
    const kinds = ['v', 'p', 's'] as const;
    // Per bank: mix (deviation from neutral), shift (linear interpolation of
    // the gains - of the values for pan - with edge values beyond the ends),
    // back to band values; then morph between the two banks (values), gains.
    for (let k = 0; k < 3; k++) {
      for (let side = 0; side < 2; side++) {
        const bank = side === 0 ? b0 : b1;
        for (let j = 0; j < B; j++) {
          const v = 1 + (this.val(bank, kinds[k], j) - 1) * mix;
          sh[j] = k === 1 ? v : equoGain(v);
        }
        for (let j = 0; j < B; j++) {
          const x = Math.min(B - 1, Math.max(0, j - shift));
          const i = Math.min(B - 2, Math.floor(x)), f = x - i;
          const y = sh[i] + (sh[i + 1] - sh[i]) * f;
          const v = k === 1 ? y : Math.log(2 * Math.max(0, y) + 1) / LN3;
          if (side === 0) c[k * B + j] = v;
          else c[k * B + j] += (v - c[k * B + j]) * t;
        }
        if (b1 === b0 || t === 0) break;
      }
    }
    // master bank: gains multiply, pans add (then a linear balance)
    for (let j = 0; j < B; j++) {
      const g = equoGain(c[j]) * equoGain(this.val(-1, 'v', j));
      const pt = Math.min(2, Math.max(0, c[B + j] + this.val(-1, 'p', j) - 1));
      this.tL[j] = g * Math.min(1, 2 - pt);
      this.tR[j] = g * Math.min(1, pt);
      this.tS[j] = equoGain(c[2 * B + j]) * equoGain(this.val(-1, 's', j));
    }
    this.vol = equoVol(p.vol ?? 128);
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (n <= 0) return;
    const max = this.sendL.length;
    if (n > max) {
      for (let o = 0; o < n; o += max) { const m = Math.min(max, n - o); this.process(L.subarray(o, o + m), R.subarray(o, o + m), m, ctx); }
      return;
    }
    const st = this.st;
    // FL stops processing after 0.2 s of digital silence at the input (whole
    // blocks; the filter states are frozen and resume with the next sound)
    let silent = true;
    for (let i = 0; i < n; i++) if (L[i] !== 0 || R[i] !== 0) { silent = false; break; }
    if (silent) {
      if (this.quiet >= 0.2 * this.sr) return;
      this.quiet += n;
    } else this.quiet = 0;
    // band weights glide toward their targets (motion smoothness: model) and
    // ramp linearly across the block
    const sm = (this.p.smooth ?? 170) / 1024;
    const tau = 0.002 + sm * sm * 0.5;
    const a = 1 - Math.exp(-n / (tau * this.sr));
    const inv = 1 / n;
    for (let j = 0; j < EQUO_BANDS; j++) {
      this.dL[j] = (this.tL[j] - this.cL[j]) * a * inv;
      this.dR[j] = (this.tR[j] - this.cR[j]) * a * inv;
      this.dS[j] = (this.tS[j] - this.cS[j]) * a * inv;
    }
    // output volume: FL ramps it linearly over the block, by at most 44.1 / s
    const vmax = (44.1 * n) / this.sr;
    const v0 = this.vCur, v1 = v0 + Math.min(vmax, Math.max(-vmax, this.vol - v0));
    const dv = (v1 - v0) * inv;
    // no sends from the master track (FL: avoids a feedback loop)
    const target = st.sendTarget >= 0 && ctx.track !== 0 && st.sendTarget !== ctx.track ? st.sendTarget : -1;
    const add = !!st.add, os = !!st.os, mute = !!st.sendOnly;
    const ws = this.runS;
    for (let ch = 0; ch < 2; ch++) {
      const buf = ch === 0 ? L : R;
      const send = ch === 0 ? this.sendL : this.sendR;
      const w = this.runW;
      w.set(ch === 0 ? this.cL : this.cR); ws.set(this.cS);
      const dw = ch === 0 ? this.dL : this.dR;
      const s = this.s[ch];
      for (let i = 0; i < n; i++) {
        const x = buf[i];
        let out: number, sn: number;
        if (os) {
          const xa = this.up[ch][0].tick(x), xb = this.up[ch][1].tick(x);
          const r = this.bank(xa, ch, s, w, ws, add, null, null);
          const o0 = r.o, s0 = r.s;
          this.bank(xb, ch, s, w, ws, add, dw, this.dS);
          out = 0.5 * (this.down[ch][0].tick(r.o) + this.down[ch][1].tick(o0));
          sn = 0.5 * (this.downS[ch][0].tick(r.s) + this.downS[ch][1].tick(s0));
        } else {
          const r = this.bank(x, ch, s, w, ws, add, dw, this.dS);
          out = r.o; sn = r.s;
        }
        const g = v0 + dv * i;
        buf[i] = (mute ? x : out) * g;
        send[i] = sn * g;
      }
      for (let j = 0; j < s.length; j++) if (!(Math.abs(s[j]) < 1e9)) { s.fill(0); break; } else if (Math.abs(s[j]) < 1e-25) s[j] = 0;
    }
    for (let j = 0; j < EQUO_BANDS; j++) {
      this.cL[j] += this.dL[j] * n; this.cR[j] += this.dR[j] * n; this.cS[j] += this.dS[j] * n;
    }
    this.vCur = v1;
    this.pwN += 2 * n * (os ? 2 : 1);
    if (target >= 0) ctx.sendTo(target, this.sendL, this.sendR, n, 1, 1);
  }

  private readonly res = { o: 0, s: 0 };

  /** One sample through the 31 band passes: weighted sum (o) and send sum (s); steps the weight ramps when given. */
  private bank(x: number, ch: number, s: Float64Array, w: Float64Array, ws: Float64Array, add: boolean, dw: Float64Array | null, dws: Float64Array | null): { o: number; s: number } {
    let o = add ? x : 0, sn = 0;
    const b0 = this.b0, a1 = this.a1, a2 = this.a2, on = this.on, x2 = this.x2, pw = this.pw;
    const xm = 0.5 * (this.xp[ch] + x);
    this.xp[ch] = x;
    for (let j = 0; j < EQUO_BANDS; j++) {
      if (!on[j]) continue;
      const k = j * 2;
      // TDF2 band pass (b = [b0, 0, -b0])
      if (x2[j]) {
        const ym = b0[j] * xm + s[k];
        s[k] = -a1[j] * ym + s[k + 1];
        s[k + 1] = -b0[j] * xm - a2[j] * ym;
      }
      const y = b0[j] * x + s[k];
      s[k] = -a1[j] * y + s[k + 1];
      s[k + 1] = -b0[j] * x - a2[j] * y;
      o += add ? (w[j] - 1) * y : w[j] * y;
      sn += ws[j] * y;
      pw[j] += y * y;
    }
    if (dw && dws) for (let j = 0; j < EQUO_BANDS; j++) { w[j] += dw[j]; ws[j] += dws[j]; }
    this.res.o = o; this.res.s = sn;
    return this.res;
  }

  /** Band levels (dB, input spectrum per band): `lev` with a falling hold (bars), `pow` since the last call (ANALYSE). */
  monitor(): FxMonitor {
    const n = this.pwN;
    const pow = new Float32Array(EQUO_BANDS);
    for (let j = 0; j < EQUO_BANDS; j++) {
      const db = n > 0 ? 10 * Math.log10(this.pw[j] / n + 1e-14) : -140;
      pow[j] = db;
      this.lev[j] = Math.max(db, this.lev[j] - 1.5);
      this.pw[j] = 0;
    }
    this.pwN = 0;
    return { lev: Float32Array.from(this.lev), pow, n };
  }

  sendTargets(): number[] {
    return this.st.sendTarget >= 0 ? [this.st.sendTarget] : [];
  }

  reset(): void {
    for (const s of this.s) s.fill(0);
    this.xp.fill(0);
    this.pw.fill(0); this.pwN = 0; this.quiet = 0;
    for (const a of [...this.up, ...this.down, ...this.downS]) for (const c of a) c.clear();
    this.cL.set(this.tL); this.cR.set(this.tR); this.cS.set(this.tS); this.vCur = this.vol;
  }
}

export const effect: EffectModule = {
  id: 'equo',
  create: (sampleRate, blockSize) => new Equo(sampleRate, blockSize),
};
