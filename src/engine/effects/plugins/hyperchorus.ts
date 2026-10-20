// Hyper Chorus (FL: Hyper Chorus). Calibrated against FL's binary (flfxhost);
// nulls -55..-90 dB against FL's renders. See docs/research/fx/hyperchorus.md:
// - 4 or 8 delay lines per channel, each a comb whose feedback (0.7 x Feedback)
//   re-enters one sample late; read with Catmull-Rom interpolation at
//   base x (1 + depth psin(LFO)) + 1 samples, base = c + r x Delay (ms, per line),
//   depth = 2 % + 12 % a + 18 % a^2 (a = Modulation), psin = FL's parabolic sine;
// - LFO rate lo + (hi - lo) x Mod rate (Hz, per line), phases accumulated in
//   single precision from fixed start phases; the right channel's LFOs lead by
//   90 degrees x Phase dif^3;
// - movement balances each line's input by sqrt(1 -+ p), p = 0.998 x Movement x
//   psin(pan LFO), pan rates lo + (hi - lo) x Mov rate (per line);
// - wet = 2.25 / lines x w(mix) x sum, then two first-order low passes and two
//   first-order high passes (bilinear; the high pass is off at its minimum);
//   dry x w(1 - mix), w the measured mix law;
// - a new instance starts from FL's constructor values and glides (one-pole
//   21.7 ms) to the first settings, as FL does; later changes apply at once.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import { hyperLowPassHz, hyperHighPassHz, hyperMixShare } from '../../../model/fx/plugins/hyperchorus';

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const F = Math.fround;

// per-line constants measured from FL (lines 0-3 are also the 4-line set)
const BASE_MS = [2.0, 3.5, 5.0, 6.5, 7.1, 8.3, 9.1, 9.6];
const RANGE_MS = [4.0, 4.75, 7.8, 3.5, 9.5, 8.5, 6.0, 8.1];
// LFO rates (Hz) at 0 and 100 % Mod rate / Mov rate; FL accumulates the phases
// in single precision, which shifts the effective rates slightly (matched to 1e-5 Hz)
const RATE_LO = [1.5, 1.57, 1.29, 0.38, 3.41, 3.01, 2.47, 3.3];
const RATE_HI = [2.47, 3.41, 3.68, 3.64, 5.03, 6.02, 5.37, 6.5];
// start phases (degrees); lines 5-8 only run while active and FL activates them
// 15 ms after start-up, so theirs are the phases at that moment
const PHASE0 = [0.0029, 47.3536, 165.1139, 272.0179, 244.5467, 138.0608, 336.4894, 186.9899].map((d) => F(d / 360));
const PAN_LO = [0.33, 0.29, 0.14, 0.26, 0.44, 0.93, 0.66, 0.41];
const PAN_HI = [3.56, 2.66, 2.98, 3.78, 5.06, 6.02, 8.08, 10.22];
const PAN_PHASE0 = [191.796, 78.825, 244.391, 16.936, 299.1474, 19.246, 12.4459, 190.692].map((d) => F(d / 360));
/** Wet sum gain at 100 % wet (FL: 9/16 per line of 4, 9/32 of 8). */
const WET_GAIN = 2.25;
const SCOPE = 2048;
/** FL's constructor state (differs from the Default preset in six controls). */
const CTOR = { delay: 400, feedback: 500, modRate: 400, modAmount: 400, movement: 300, movementRate: 300, lines: 0, lowPass: 22000, highPass: 120, mix: 500, phaseDiff: 100 };
/** Start-up glide (FL: one-pole, 21.7 ms, snapping within 1e-4 of the target). */
const GLIDE = 0.021715;
const SNAP = 1e-4;
/** At start-up FL switches the number of lines 15 ms late (at sample 663 at 44.1 kHz). */
const LINES_DEFER = 0.015;

/** FL's parabolic sine (peak 1 at a quarter cycle; 3.7 % third harmonic). */
function psin(p: number): number {
  return p < 0.5 ? 16 * p * (0.5 - p) : -16 * (p - 0.5) * (1 - p);
}

const k1 = (f: number, sr: number) => Math.tan((Math.PI * Math.min(f, sr * 0.4999)) / sr);

/** Glided settings: delay, amount, mod rate, movement, mov rate, feedback, mix, phase dif, low / high pass. */
const NP = 10;
const P_DELAY = 0, P_AMT = 1, P_RATE = 2, P_MOV = 3, P_PRATE = 4, P_FB = 5, P_MIX = 6, P_DIFF = 7, P_LP = 8, P_HP = 9;

class HyperChorus implements EffectInstance {
  readonly tail = 1.5;
  private readonly sr: number;
  private readonly bufs: Float32Array[] = [];   // [line * 2 + ch]
  private readonly mask: number;
  private readonly wp = new Int32Array(8);     // write positions (a line not in use stands still)
  private readonly ph = new Float64Array(8);    // single-precision values
  private readonly pph = new Float64Array(8);
  private readonly inc = new Float64Array(8);
  private readonly pinc = new Float64Array(8);
  private readonly filt = new Float64Array(16); // direct form I states [x1, y1] x 4 sections x 2 channels
  private readonly last = new Float64Array(16); // previous line outputs (feedback is one sample late)
  // wet filter coefficients (bilinear first-order sections)
  private lb0 = 1; private lb1 = 0; private la1 = 0;
  private hb0 = 1; private hb1 = 0; private ha1 = 0;
  private lpV = -1; private hpV = -1;
  /** High pass share: FL fades it in / out over 10 ms when it leaves / reaches its minimum
   * (where the dry line sum passes); off, the section rests. */
  private hpMix = 0;
  private readonly scope = new Float32Array(SCOPE * 2);
  private sp = 0;
  private lines = 4;
  private readonly tgt = new Float64Array(NP);
  private readonly cur = new Float64Array(NP);
  private readonly next = new Float64Array(NP);
  private linesNext = 4;
  private switchIn = 0;                          // samples until a deferred line switch
  private gliding = true;
  private started = false;
  private incKey = NaN; private pincKey = NaN;
  private mixC = -1; private wetS = 0; private dryS = 0;

  constructor(sr: number) {
    this.sr = sr;
    let len = 1;
    while (len < Math.ceil(0.03 * sr) + 8) len <<= 1;
    this.mask = len - 1;
    for (let i = 0; i < 16; i++) this.bufs.push(new Float32Array(len));
    for (let j = 0; j < 8; j++) { this.ph[j] = PHASE0[j]; this.pph[j] = PAN_PHASE0[j]; }
    // FL's instance starts from its constructor values and glides to whatever is
    // set next (the Default preset on insertion), which also shifts the LFO phases
    this.setParams(CTOR);
    this.cur.set(this.tgt);
    this.lines = this.linesNext;
    this.switchIn = 0;
    this.updateFilters();
  }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    const lines = num(q.lines, 0) >= 0.5 ? 8 : 4;
    if (lines !== this.linesNext) {
      this.linesNext = lines;
      // once running, the switch is immediate
      if (this.started) this.setLines(lines);
      else this.switchIn = Math.round(LINES_DEFER * this.sr) + 2;
    }
    const t = this.tgt, nx = this.next;
    nx[P_DELAY] = clamp(num(q.delay, 500), 0, 1000) / 1000;
    nx[P_AMT] = clamp(num(q.modAmount, 500), 0, 1000) / 1000;
    nx[P_RATE] = clamp(num(q.modRate, 500), 0, 1000) / 1000;
    nx[P_MOV] = clamp(num(q.movement, 500), 0, 1000) / 1000;
    nx[P_PRATE] = clamp(num(q.movementRate, 500), 0, 1000) / 1000;
    nx[P_FB] = clamp(num(q.feedback, 500), 0, 1000) / 1000;
    nx[P_MIX] = clamp(num(q.mix, 500), 0, 1000) / 1000;
    nx[P_DIFF] = clamp(num(q.phaseDiff, 500), 0, 1000) / 1000;
    nx[P_LP] = (clamp(num(q.lowPass, 22000), 7140, 22000) - 7140) / 14860;
    nx[P_HP] = (clamp(num(q.highPass, 120), 120, 10900) - 120) / 10780;
    for (let i = 0; i < NP; i++) {
      if (nx[i] === t[i]) continue;
      t[i] = nx[i];
      // once running, FL applies changes at once (only the start-up glides)
      if (this.started) this.cur[i] = nx[i];
      else this.gliding = true;
    }
    this.updateFilters();
  }

  /** Switch the number of lines; lines that come back start empty (as FL). */
  private setLines(lines: number): void {
    this.lines = lines;
  }

  /** Wet filter coefficients from the (glided) settings. */
  private updateFilters(): void {
    const c = this.cur;
    if (c[P_LP] !== this.lpV) {
      this.lpV = c[P_LP];
      const k = k1(hyperLowPassHz(7140 + 14860 * this.lpV), this.sr);
      this.lb0 = k / (1 + k); this.lb1 = this.lb0; this.la1 = (k - 1) / (k + 1);
    }
    if (c[P_HP] !== this.hpV) {
      this.hpV = c[P_HP];
      const k = k1(hyperHighPassHz(120 + 10780 * this.hpV), this.sr);
      this.hb0 = 1 / (1 + k); this.hb1 = -this.hb0; this.ha1 = (k - 1) / (k + 1);
    }
  }

  /** Per-line phase increments (single precision, as FL). */
  private updateIncrements(): void {
    const c = this.cur, sr = this.sr;
    if (c[P_RATE] !== this.incKey) {
      this.incKey = c[P_RATE];
      const x = F(c[P_RATE]);
      for (let j = 0; j < 8; j++) this.inc[j] = F(F(RATE_LO[j] + F(F(RATE_HI[j] - RATE_LO[j]) * x)) / sr);
    }
    if (c[P_PRATE] !== this.pincKey) {
      this.pincKey = c[P_PRATE];
      const x = F(c[P_PRATE]);
      for (let j = 0; j < 8; j++) this.pinc[j] = F(F(PAN_LO[j] + F(F(PAN_HI[j] - PAN_LO[j]) * x)) / sr);
    }
  }

  private glide(k: number): void {
    const c = this.cur, t = this.tgt;
    let moving = false;
    for (let i = 0; i < NP; i++) {
      const d = t[i] - c[i];
      if (d === 0) continue;
      // FL snaps once within 1e-4 of the target (normalised units)
      if (Math.abs(d) < SNAP) c[i] = t[i];
      else { c[i] += d * k; moving = true; }
    }
    this.gliding = moving;
  }

  /** Low pass and high pass as biquads (each two equal first-order sections), direct form I;
   * hm = high pass share, run = the high pass section runs. */
  private sect(x: number, o: number, lb0: number, la1: number, hb0: number, ha1: number, hm: number, run: boolean): number {
    const f = this.filt;
    // LP: b = lb0^2 [1, 2, 1], a = [1, 2 la1, la1^2]
    const lB0 = lb0 * lb0, lA1 = 2 * la1, lA2 = la1 * la1;
    let y = lB0 * (x + 2 * f[o] + f[o + 1]) - lA1 * f[o + 2] - lA2 * f[o + 3];
    f[o + 1] = f[o]; f[o] = x; f[o + 3] = f[o + 2]; f[o + 2] = y; x = y;
    if (!run) return x;
    const hB0 = hb0 * hb0, hA1 = 2 * ha1, hA2 = ha1 * ha1;
    y = hB0 * (x - 2 * f[o + 4] + f[o + 5]) - hA1 * f[o + 6] - hA2 * f[o + 7];
    f[o + 5] = f[o + 4]; f[o + 4] = x; f[o + 7] = f[o + 6]; f[o + 6] = y;
    return hm >= 1 ? y : x + (y - x) * hm;
  }

  /** Catmull-Rom read d samples back from write position w. */
  private read(buf: Float32Array, w: number, d: number): number {
    const mask = this.mask;
    const pos = w - d + mask + 1;
    const ip = Math.floor(pos);
    const t = pos - ip;
    const xm1 = buf[(ip - 1) & mask], x0 = buf[ip & mask], x1 = buf[(ip + 1) & mask], x2 = buf[(ip + 2) & mask];
    const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * t + c2) * t + c1) * t + x0;
  }

  process(L: Float32Array, R: Float32Array, n: number, _ctx: FxContext): void {
    this.started = true;
    const sr = this.sr, mask = this.mask;
    let N = this.lines;
    const k = 1 - Math.exp(-1 / (GLIDE * sr));
    const msToS = sr / 1000;
    const f = this.filt, c = this.cur;
    let lb0 = this.lb0, la1 = this.la1, hb0 = this.hb0, ha1 = this.ha1;
    const bufs = this.bufs, ph = this.ph, pph = this.pph, last = this.last;
    const inc = this.inc, pinc = this.pinc;
    let wetScale = WET_GAIN / N;
    const hpStep = 1 / Math.round(0.01 * sr);
    this.updateIncrements();
    for (let i = 0; i < n; i++) {
      if (this.switchIn > 0 && --this.switchIn === 0) { this.setLines(this.linesNext); N = this.lines; wetScale = WET_GAIN / N; }
      if (this.gliding) {
        this.glide(k); this.updateIncrements(); this.updateFilters();
        lb0 = this.lb0; la1 = this.la1; hb0 = this.hb0; ha1 = this.ha1;
      }
      if (c[P_MIX] !== this.mixC) { this.mixC = c[P_MIX]; this.wetS = hyperMixShare(this.mixC); this.dryS = hyperMixShare(1 - this.mixC); }
      // NaN / Inf input -> 0 (keeps the delay lines finite)
      const il = L[i], ir = R[i];
      const xl = il - il === 0 ? il : 0, xr = ir - ir === 0 ? ir : 0;
      // feedback 0.7 x Feedback; movement swings 99.8 % at 100 %
      const x = c[P_DELAY], a = c[P_AMT], fb = 0.7 * c[P_FB], pm = 0.998 * c[P_MOV], dd = c[P_DIFF];
      const depth = 0.02 + 0.12 * a + 0.18 * a * a;
      const rOff = 0.25 * dd * dd * dd;
      let sl = 0, sr2 = 0;
      for (let j = 0; j < N; j++) {
        const base = (BASE_MS[j] + RANGE_MS[j] * x) * msToS;
        const phL = ph[j];
        let phR = phL + rOff; if (phR >= 1) phR -= 1;
        const dL = base * (1 + depth * psin(phL)) + 1;
        const dR = base * (1 + depth * psin(phR)) + 1;
        const bl = bufs[2 * j], br = bufs[2 * j + 1];
        const w = this.wp[j];
        const yl = this.read(bl, w, dL), yr = this.read(br, w, dR);
        // movement balances the line's input; the feedback re-enters one sample
        // later (loop delay = tap delay + 1)
        const pp = pm * psin(pph[j]);
        bl[w] = xl * Math.sqrt(1 - pp) + fb * last[2 * j]; last[2 * j] = yl;
        br[w] = xr * Math.sqrt(1 + pp) + fb * last[2 * j + 1]; last[2 * j + 1] = yr;
        this.wp[j] = (w + 1) & mask;
        sl += yl;
        sr2 += yr;
        let np = F(phL + inc[j]); if (np >= 1) np = F(np - 1); ph[j] = np;
        let pn = F(pph[j] + pinc[j]); if (pn >= 1) pn = F(pn - 1); pph[j] = pn;
      }
      // (as FL, lines not in use stand still, LFOs included)
      // the line sums (scaled by 2.25 / lines) through the wet filters, then the wet share
      // the high pass fades in from rest / out to the plain sum (10 ms, linear)
      const hpOn = c[P_HP] > 0, hm = this.hpMix, run = hpOn || hm > 0;
      const wl = this.wetS * this.sect(sl * wetScale, 0, lb0, la1, hb0, ha1, hm, run);
      const wr = this.wetS * this.sect(sr2 * wetScale, 8, lb0, la1, hb0, ha1, hm, run);
      if (hpOn) { if (hm < 1) this.hpMix = Math.min(1, hm + hpStep); }
      else if (hm > 0) {
        this.hpMix = Math.max(0, hm - hpStep);
        if (this.hpMix === 0) for (let q = 4; q < 8; q++) { f[q] = 0; f[q + 8] = 0; }
      }
      const ol = this.dryS * xl + wl, or = this.dryS * xr + wr;
      L[i] = ol; R[i] = or;
      const s = this.sp;
      this.scope[2 * s] = ol; this.scope[2 * s + 1] = or;
      this.sp = (s + 1) & (SCOPE - 1);
    }
    for (let j = 0; j < 16; j++) if (!(Math.abs(f[j]) > 1e-30)) f[j] = 0;
    if (!Number.isFinite(f[7] + f[15])) this.reset();
  }

  monitor(): FxMonitor {
    // the latest output pairs for the vectorscope, oldest first
    const out = new Float32Array(SCOPE * 2);
    const s = this.sp;
    out.set(this.scope.subarray(2 * s));
    out.set(this.scope.subarray(0, 2 * s), (SCOPE - s) * 2);
    return { scope: out };
  }

  reset(): void {
    for (const b of this.bufs) b.fill(0);
    this.filt.fill(0);
    this.last.fill(0);
  }
}

export const effect: EffectModule = {
  id: 'hyperchorus',
  create: (sr) => new HyperChorus(sr),
};
