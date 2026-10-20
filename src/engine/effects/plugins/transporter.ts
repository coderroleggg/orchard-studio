// Transporter (FL Studio 2026). Measured on FL's plugin with flfxhost (see
// docs/research/fx/transporter.md):
// - The input is written into a 960000-sample ring. Loop A plays the left
//   input and loop B the right input (Stereo-to-stereo; Mono-to-stereo feeds
//   both with (L+R)/2).
// - A trigger at time t is effective for a loop when at least its minimum
//   length has passed since that loop's previous effective trigger tPrev
//   (B's minimum = A's / A-B ratio). The loop then plays the audio from tPrev
//   (Auto / Adaptive: [tPrev, t], repeated; Bouncing: cycles starting at the
//   minimum length, multiplied by exp(-rate/2) each cycle and stopping below
//   20 ms; Tempo: cycles of the tempo ratio length). New segments start one
//   lookahead (5 ms, the reported latency) after the trigger, aligned with the
//   delayed dry signal; with Lookahead on, each jump and wrap is softened by a
//   2.5 ms fade-out, a 2.25 ms gap and a 2.5 ms fade-in (FL's dip).
// - Per event: reverse (reads backwards from the end), octave shift (speed 2
//   or 1/2, the cycle keeps its length) and ignore are drawn with the bias
//   probabilities: a seeded random generator (Probabilistic) or a hash of the
//   loop's position in the buffer (Deterministic).
// - Spread > 0 pans A left and B right (linear); < 0 is a sine auto-pan at
//   20*|spread| Hz. Levels follow FL's (11^x - 1) / 10 law.
// - Transient detection: fast / slow envelope ratio of the high-passed source
//   against a sensitivity-dependent threshold (approximation of FL's).

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';

export const BUF = 960000;
const OVERVIEW = 1024;
const SEED = 0x2545f491;

/** Onset detector: fast / slow envelopes of the high-passed source compared in dB. */
class OnsetDetector {
  private hpA = 0; private hx = 0; private hy = 0;
  private fast = 0; private slow = 0;
  private fa = 0; private fr = 0; private sa = 0; private srl = 0;
  private th = 12; private readonly eps = 1e-3;
  private since = 1e9; private gap = 441;
  configure(sr: number, sens: number): void {
    this.hpA = Math.exp((-2 * Math.PI * 200) / sr);
    this.fa = Math.exp(-1 / (0.0001 * sr)); this.fr = Math.exp(-1 / (0.005 * sr));
    this.sa = Math.exp(-1 / (0.02 * sr)); this.srl = Math.exp(-1 / (0.2 * sr));
    this.th = 10.5 - 9 * Math.min(1, Math.max(0, sens));
    this.gap = Math.round(0.01 * sr);
  }
  reset(): void { this.hx = this.hy = this.fast = this.slow = 0; this.since = 1e9; }
  trigger(x: number): boolean {
    const y = this.hpA * (this.hy + x - this.hx);
    this.hx = x; this.hy = y;
    const r = y < 0 ? -y : y;
    this.fast = r + (r > this.fast ? this.fa : this.fr) * (this.fast - r);
    this.slow = r + (r > this.slow ? this.sa : this.srl) * (this.slow - r);
    this.since++;
    const d = 20 * Math.log10((this.fast + this.eps) / (this.slow + this.eps));
    // rises and sudden drops (hard stops) both count, as in FL
    if (this.since >= this.gap && (d > this.th || d < -this.th - 6)) {
      this.since = 0;
      return true;
    }
    return false;
  }
  flush(): void {
    if (Math.abs(this.hy) < 1e-25) this.hy = 0;
    if (this.fast < 1e-25) this.fast = 0;
    if (this.slow < 1e-25) this.slow = 0;
  }
}

const num = (q: Record<string, unknown>, k: string, d: number, lo: number, hi: number) => {
  const v = Number(q[k] ?? d);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
};
const n32 = (v: number, min: number, max: number) => Math.fround((v - min) / (max - min));
const levelGain = (v: number) => { const x = n32(v, 0, 12800); return x <= 0 ? 0 : (Math.pow(11, x) - 1) / 10; };

/** Note value of a tempo ratio item in beats (1/1 = 4 beats). */
function ratioBeats(i: number): number {
  const k = Math.max(0, Math.min(20, Math.round(i)));
  const base = [4, 2, 1, 0.5, 0.25, 0.125];
  if (k <= 5) return base[k];
  if (k <= 10) return base[k - 6] * 1.5;
  if (k <= 15) return (base[k - 11] * 2) / 3;
  return (base[k - 16] * 4) / 5;
}

/** Deterministic pseudo-random value in [0, 1) from an integer. */
function hash01(n: number, salt: number): number {
  let h = (Math.imul(n | 0, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca77)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

class Loop {
  active = false;
  /** Absolute sample time where the segment starts (tPrev). */
  start = 0;
  /** Region length t - tPrev (samples). */
  region = 0;
  /** Current cycle length (samples of output). */
  len = 0;
  dir = 1;
  speed = 1;
  /** Output samples elapsed in the current cycle. */
  c = 0;
  lastTrig = 0;
  /** Pending segment (applied at time `at`). */
  pend = false;
  at = 0;
  pStart = 0; pRegion = 0; pLen = 0; pDir = 1; pSpeed = 1;
  /** Time of the last jump (for the fade-in) and the next one (for the fade-out). */
  lastJump = -1e12;
  reset(now: number): void {
    this.active = false; this.pend = false; this.c = 0; this.lastTrig = now; this.lastJump = -1e12;
  }
}

class Transporter implements EffectInstance {
  private readonly sr: number;
  private readonly bufL = new Float32Array(BUF);
  private readonly bufR = new Float32Array(BUF);
  private now = 0; // absolute sample counter
  private base = 0; // absolute time of ring index 0 (after a flush)
  private validFrom = 0;
  private readonly D: number; // lookahead / latency (samples)
  private readonly R: number; // ramp
  private readonly G: number; // gap
  private readonly dlyL: Float32Array;
  private readonly dlyR: Float32Array;
  private dW = 0;
  private readonly det = new OnsetDetector();
  private readonly loops = [new Loop(), new Loop()];
  private rng = SEED;
  // parameters
  private dry = 1; private gA = 1; private gB = 1;
  private dryCur = 1; private gACur = 1; private gBCur = 1;
  private reverse = 0; private shift = 0; private downUp = 0; private ignoreBias = 0;
  private spread = 0;
  private minLen = 0.5; private ratio = 3; private sens = 0.5; private rate = 0;
  private ignoreTr = false; private mode = 0; private bypass = false; private deterministic = false;
  private tempoLen = 0; private tempoTrig = 21;
  private scIn = 0; private out = -1;
  private flushOnStop = true; private lookahead = true; private stereo = true; private source = 2;
  // edge-triggered buttons
  private prevFlush = 0; private prevUA = 0; private prevUB = 0; private prevUAB = 0;
  private pendFlush = false; private pendA = false; private pendB = false;
  private wasPlaying: boolean | null = null;
  private detDirty = true;
  // adaptive mode: average interval between detected transients
  private lastDet = 0; private avgInterval = 0.5;
  // tempo triggers
  private lastTempoSlot = NaN;
  private freeTempo = 0;
  // auto-pan LFO
  private lfo = 0;
  // display
  private readonly ovMax = new Float32Array(OVERVIEW);
  private ovCol = 0; private ovAcc = 0;
  private flashes = 0;
  private readonly sendL: Float32Array; private readonly sendR: Float32Array;
  readonly tail = 30; // loops keep repeating after the input stops (bounded)

  constructor(sr: number, blockSize: number) {
    this.sr = sr;
    this.D = Math.floor(0.005 * sr);
    this.R = Math.max(1, Math.round(0.0025 * sr));
    this.G = Math.max(0, Math.round(0.00225 * sr));
    this.dlyL = new Float32Array(this.D + 1);
    this.dlyR = new Float32Array(this.D + 1);
    const n = Math.max(1, blockSize | 0);
    this.sendL = new Float32Array(n); this.sendR = new Float32Array(n);
  }

  get latency(): number { return this.D; }

  setParams(p: unknown): void {
    const q = (p ?? {}) as Record<string, unknown>;
    this.dry = levelGain(num(q, 'dry', 12800, 0, 12800));
    this.gA = levelGain(num(q, 'levelA', 12800, 0, 12800));
    this.gB = levelGain(num(q, 'levelB', 12800, 0, 12800));
    this.reverse = n32(num(q, 'reverse', 0, 0, 10000), 0, 10000);
    this.shift = n32(num(q, 'shift', 0, 0, 10000), 0, 10000);
    this.downUp = n32(num(q, 'downUp', 0, 0, 10000), 0, 10000);
    this.ignoreBias = n32(num(q, 'ignoreBias', 0, 0, 10000), 0, 10000);
    this.spread = (n32(num(q, 'spread', 512, 0, 1024), 0, 1024) - 0.5) * 2;
    this.minLen = 0.02 + 1.98 * n32(num(q, 'minLen', 500, 20, 2000), 20, 2000);
    this.ratio = 1 + Math.round(num(q, 'ratio', 8, 0, 36)) / 4;
    const sens = n32(num(q, 'sens', 512, 0, 1024), 0, 1024);
    if (sens !== this.sens) { this.sens = sens; this.detDirty = true; }
    this.rate = (n32(num(q, 'bounce', 512, 0, 1024), 0, 1024) - 0.5) * 2;
    this.ignoreTr = num(q, 'ignoreTr', 0, 0, 1) >= 0.5;
    this.mode = Math.round(num(q, 'mode', 0, 0, 3));
    this.bypass = num(q, 'bypass', 0, 0, 1) >= 0.5;
    this.deterministic = num(q, 'prob', 0, 0, 1) >= 0.5;
    this.tempoLen = Math.round(num(q, 'tempoLen', 0, 0, 20));
    this.tempoTrig = Math.round(num(q, 'tempoTrig', 21, 0, 21));
    const fl = num(q, 'flush', 0, 0, 1) >= 0.5 ? 1 : 0;
    if (fl && !this.prevFlush) this.pendFlush = true;
    this.prevFlush = fl;
    const ua = num(q, 'updA', 0, 0, 1) >= 0.5 ? 1 : 0, ub = num(q, 'updB', 0, 0, 1) >= 0.5 ? 1 : 0, uab = num(q, 'updAB', 0, 0, 1) >= 0.5 ? 1 : 0;
    if (ua && !this.prevUA) this.pendA = true;
    if (ub && !this.prevUB) this.pendB = true;
    if (uab && !this.prevUAB) { this.pendA = true; this.pendB = true; }
    this.prevUA = ua; this.prevUB = ub; this.prevUAB = uab;
    const sc = Number(q.scIn ?? 0);
    this.scIn = Number.isInteger(sc) && sc > 0 ? sc : 0;
    const o = Number(q.out ?? -1);
    this.out = Number.isInteger(o) && o >= 0 ? o : -1;
    this.flushOnStop = q.flushOnStop !== false;
    this.lookahead = q.lookahead !== false;
    this.stereo = q.stereo !== false;
    this.source = Math.round(num(q, 'source', 2, 0, 2));
  }

  sendTargets(): number[] {
    return this.out >= 0 ? [this.out] : [];
  }

  reset(): void {
    this.now = 0; this.base = 0; this.validFrom = 0;
    this.dlyL.fill(0); this.dlyR.fill(0); this.dW = 0;
    this.det.reset();
    for (const l of this.loops) l.reset(0);
    this.ovMax.fill(0); this.ovCol = 0; this.ovAcc = 0;
    this.rng = SEED;
    this.lastDet = 0; this.avgInterval = 0.5;
    this.dryCur = this.dry; this.gACur = this.gA; this.gBCur = this.gB;
  }

  private flushNow(): void {
    this.base = this.now;
    this.validFrom = this.now;
    for (const l of this.loops) l.reset(this.now);
    this.ovMax.fill(0); this.ovCol = 0; this.ovAcc = 0;
  }

  private rand(): number {
    // xorshift32
    let x = this.rng;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 4294967296;
  }

  /** Minimum length (samples) for loop k at the current settings. */
  private minFor(k: number, tempo: number): number {
    const sr = this.sr;
    let a: number;
    if (this.mode === 3) a = (ratioBeats(this.tempoLen) * 60) / Math.max(10, tempo);
    else if (this.mode === 2) {
      // adaptive: follow the transient rate for short settings, oppose it for long ones
      const e = 1 - (2 * (this.minLen - 0.02)) / 1.98;
      a = Math.min(4, Math.max(0.02, this.minLen * Math.pow(Math.max(0.01, this.avgInterval) / 0.5, e)));
    } else a = this.minLen;
    return Math.max(1, Math.round((k === 0 ? a : a / this.ratio) * sr));
  }

  /** A trigger at the current time for loop k (manual triggers skip the minimum length). */
  private trigger(k: number, manual: boolean, tempo: number): void {
    const L = this.loops[k];
    const t = this.now;
    const min = this.minFor(k, tempo);
    if (!manual && t - L.lastTrig < min) return;
    const u0 = this.deterministic ? hash01(L.lastTrig - this.base, 11 + k) : this.rand();
    if (u0 < this.ignoreBias) return;
    const region = t - L.lastTrig;
    const tPrev = L.lastTrig;
    L.lastTrig = t;
    if (region < 2 || tPrev < this.validFrom) return;
    const u1 = this.deterministic ? hash01(tPrev - this.base, 23 + k) : this.rand();
    const u2 = this.deterministic ? hash01(tPrev - this.base, 37 + k) : this.rand();
    const u3 = this.deterministic ? hash01(tPrev - this.base, 51 + k) : this.rand();
    let len = region;
    if (this.mode === 1 || this.mode === 3) len = Math.min(region, min);
    L.pend = true;
    L.at = t + this.D;
    L.pStart = tPrev; L.pRegion = region; L.pLen = len;
    L.pDir = u1 < this.reverse ? -1 : 1;
    L.pSpeed = u2 < this.shift ? (u3 < this.downUp ? 2 : 0.5) : 1;
  }

  private read(buf: Float32Array, pos: number): number {
    // pos: absolute (fractional) time; zero outside the recorded range
    if (pos < this.validFrom || pos > this.now - 1 || this.now - pos >= BUF - 2) return 0;
    const i = Math.floor(pos), fr = pos - i;
    let a = (i - this.base) % BUF; if (a < 0) a += BUF;
    let b = a + 1; if (b >= BUF) b = 0;
    const x0 = buf[a];
    return fr > 0 && i + 1 <= this.now - 1 ? x0 + (buf[b] - x0) * fr : x0;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (n <= 0) return;
    const sr = this.sr;
    if (this.detDirty) {
      this.det.configure(sr, this.sens);
      this.detDirty = false;
    }
    // flush on start / stop of the transport
    if (this.wasPlaying !== null && this.wasPlaying !== ctx.playing && this.flushOnStop) this.flushNow();
    this.wasPlaying = ctx.playing;
    if (this.pendFlush) { this.flushNow(); this.pendFlush = false; }
    const tempo = ctx.tempo || 120;
    if (this.pendA) { this.trigger(0, true, tempo); this.pendA = false; }
    if (this.pendB) { this.trigger(1, true, tempo); this.pendB = false; }

    const sc = this.scIn > 0 ? ctx.sidechain[this.scIn - 1] : undefined;
    const srcL = sc ? sc.L : L, srcR = sc ? sc.R : R;
    // tempo triggers (Bouncing and Tempo modes)
    const tempoOn = this.tempoTrig < 21 && (this.mode === 1 || this.mode === 3);
    const trigBeats = tempoOn ? ratioBeats(this.tempoTrig) : 0;
    const samplesPerBeat = (60 / Math.max(10, tempo)) * sr;
    const beat0 = ctx.playing ? ctx.pos / Math.max(1, ctx.ppq) : this.freeTempo / samplesPerBeat;

    const D = this.D, Rr = this.R, G = this.G, la = this.lookahead;
    const blockStep = 1 - Math.exp(-n / (0.02 * sr));
    const dry1 = this.dry, a1 = this.gA, b1 = this.gB;
    const dryStep = (dry1 - this.dryCur) * blockStep / n, aStep = (a1 - this.gACur) * blockStep / n, bStep = (b1 - this.gBCur) * blockStep / n;
    const lfoInc = this.spread < 0 ? (2 * Math.PI * 20 * -this.spread) / sr : 0;
    const out = this.out >= 0 && this.out !== ctx.track;
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      // record
      const wi = ((this.now - this.base) % BUF + BUF) % BUF;
      if (this.stereo) { this.bufL[wi] = xl; this.bufR[wi] = xr; } else { const m = 0.5 * (xl + xr); this.bufL[wi] = m; this.bufR[wi] = m; }
      // overview (display): peak per column of the ring
      const ax = Math.max(xl < 0 ? -xl : xl, xr < 0 ? -xr : xr);
      const col = Math.floor((wi * OVERVIEW) / BUF);
      if (col !== this.ovCol) { this.ovCol = col; this.ovMax[col] = 0; }
      if (ax > this.ovMax[col]) this.ovMax[col] = ax;
      this.now++;
      // detection
      const ds = this.source === 0 ? srcL[i] : this.source === 1 ? srcR[i] : 0.5 * (srcL[i] + srcR[i]);
      if (this.det.trigger(ds) && !this.bypass) {
        this.flashes++;
        const iv = (this.now - this.lastDet) / sr;
        if (iv < 8) this.avgInterval += (iv - this.avgInterval) * 0.2;
        this.lastDet = this.now;
        if (!this.ignoreTr) { this.trigger(0, false, tempo); this.trigger(1, false, tempo); }
      }
      if (tempoOn) {
        const slot = Math.floor((beat0 + i / samplesPerBeat) / trigBeats);
        if (slot !== this.lastTempoSlot) {
          if (!Number.isNaN(this.lastTempoSlot)) { this.trigger(0, false, tempo); this.trigger(1, false, tempo); }
          this.lastTempoSlot = slot;
        }
      }
      // dry, delayed by the lookahead
      this.dlyL[this.dW] = xl; this.dlyR[this.dW] = xr;
      let ri = this.dW + 1; if (ri > D) ri = 0;
      const dl = this.dlyL[ri], dr = this.dlyR[ri];
      this.dW = ri;
      this.dryCur += dryStep; this.gACur += aStep; this.gBCur += bStep;
      if (this.bypass) { L[i] = dl; R[i] = dr; continue; }
      // loops
      let la0 = 0, lb0 = 0;
      for (let k = 0; k < 2; k++) {
        const lp = this.loops[k];
        const t = this.now;
        if (lp.pend && t >= lp.at) {
          lp.pend = false; lp.active = true;
          lp.start = lp.pStart; lp.region = lp.pRegion; lp.len = lp.pLen; lp.dir = lp.pDir; lp.speed = lp.pSpeed;
          lp.c = 0; lp.lastJump = t;
        }
        if (!lp.active) continue;
        // wrap at the end of the cycle (Bouncing: change the length)
        if (lp.c >= lp.len) {
          lp.c = 0; lp.lastJump = t;
          if (this.mode === 1) {
            const nl = Math.round(lp.len * Math.exp(-0.5 * this.rate));
            lp.len = Math.min(lp.region, nl);
            if (lp.len < 0.02 * sr) { lp.active = false; continue; }
          }
        }
        const pos = lp.dir > 0 ? lp.start + lp.c * lp.speed : lp.start + lp.len - 1 - lp.c * lp.speed;
        let v = this.read(k === 0 ? this.bufL : this.bufR, pos);
        if (la) {
          // fade in after the last jump; fade out before the next one (wrap or pending event)
          const sinceJ = t - lp.lastJump;
          let g = sinceJ < Rr ? sinceJ / Rr : 1;
          const toWrap = lp.len - lp.c;
          let toNext = toWrap;
          if (lp.pend) toNext = Math.min(toNext, lp.at - t);
          if (toNext <= G) g = 0;
          else if (toNext < G + Rr) g = Math.min(g, (toNext - G) / Rr);
          v *= g;
        }
        lp.c++;
        if (k === 0) la0 = v; else lb0 = v;
      }
      // spread / auto-pan (linear), levels
      let pA: number;
      if (this.spread >= 0) pA = this.spread;
      else { this.lfo += lfoInc; if (this.lfo > 2 * Math.PI) this.lfo -= 2 * Math.PI; pA = Math.sin(this.lfo); }
      const aL = 0.5 + 0.5 * pA, aR = 0.5 - 0.5 * pA;
      const ga = this.gACur * la0, gb = this.gBCur * lb0;
      let ol = this.dryCur * dl + ga * aL + gb * aR;
      let or = this.dryCur * dr + ga * aR + gb * aL;
      if (!(ol === ol) || ol > 1e6 || ol < -1e6) ol = 0;
      if (!(or === or) || or > 1e6 || or < -1e6) or = 0;
      if (out) { this.sendL[i] = ol; this.sendR[i] = or; L[i] = 0; R[i] = 0; } else { L[i] = ol; R[i] = or; }
    }
    if (!ctx.playing) this.freeTempo += n;
    if (out) ctx.sendTo(this.out, this.sendL, this.sendR, n, 1, 1);
    this.det.flush();
  }

  monitor(): FxMonitor {
    const ring = (t: number) => ((((t - this.base) % BUF) + BUF) % BUF) / BUF;
    const [a, b] = this.loops;
    const pos = (l: Loop) => (l.active ? ring(l.dir > 0 ? l.start + l.c * l.speed : l.start + l.len - 1 - l.c * l.speed) : -1);
    const tempo = 120;
    const m: FxMonitor = {
      wave: Float32Array.from(this.ovMax),
      write: ring(this.now),
      readA: pos(a), readB: pos(b),
      minA: ring(a.lastTrig + this.minFor(0, tempo)), minB: ring(b.lastTrig + this.minFor(1, tempo)),
      flash: this.flashes,
      filled: Math.min(1, (this.now - this.base) / BUF),
    };
    this.flashes = 0;
    return m;
  }
}

export const effect: EffectModule = {
  id: 'transporter',
  create: (sr, bs) => new Transporter(sr, bs),
};
