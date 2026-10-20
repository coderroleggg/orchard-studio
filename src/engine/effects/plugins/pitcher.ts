// Pitcher (FL: Pitcher): real-time pitch correction and harmonization.
// Behaviour measured on FL's plugin through the FL test host:
// - FL detects the period as a whole number of samples: the detected pitch is
//   sr / round(sr / f), and the correction ratio is target / detected. The
//   corrected output therefore keeps FL's small residual detuning (up to
//   +-9 cents at 440 Hz, 44.1 kHz). Detection covers periods of >= 45 samples
//   (about 980 Hz at 44.1 kHz) down to the Min frequency (default 110 Hz).
//   Here: YIN (cumulative mean normalised difference, FFT autocorrelation)
//   with integer lags, like FL.
// - Target: the nearest enabled note (A3 tuning), unless that note's bypass
//   switch is on; plus the fine tune (+-100 cents).
// - The correction glides in cents with a one-pole time constant
//   348 * (1 - speed)^3 ms (FL: 348 ms at 0, 144 at 25%, 43 at 50%, ~instant at 100%).
// - With FORMANT off (FL's default) the shift is a resampling one: formants
//   move with the pitch, as in FL (a -30 cent correction moved the spectral
//   centroid by -31 cents). It runs as a pitch-synchronous delay-line shifter
//   (read head at the correction ratio, splices by whole detected periods
//   with a short crossfade): the output starts after a few samples (FL: 9),
//   no latency is reported (FL reports none).
// - FORMANT on: time-domain PSOLA (grains every detected period, re-spaced to
//   the corrected period, read at the GENDER factor: +-100 = +-7 semitones of
//   formant shift).
// - Reference Left (FL's default: the right channel follows the left
//   channel's correction), Right, or Both (each channel corrected on its own).
// - MIDI / OCTAVES / HARMONIZE follow MIDI notes (FL: a MIDI Out channel on
//   Pitcher's own "MIDI Input Port Number", or the slot's MIDI input port),
//   applied at their sample: MIDI = the last note pressed, in the octave
//   nearest the input; OCTAVES = the note and octave played; HARMONIZE = up to
//   four notes (the four last pressed; highest note = voice 1, panned by the
//   voice pans x stereo spread, replacing or mixed with the input; VEL with
//   OCTAVES off scales each voice by its velocity). Without notes held the
//   automatic correction applies.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import { getFFT, type FFT } from '../../dsp/fft';
import { PIT_MIN_HZ, pitSpeedTau } from '../../../model/fx/plugins/pitcher';

const RING = 1 << 15;
const MASK = RING - 1;
const HOP = 256;
const MIN_LAG = 45;
const YIN_THR = 0.15;
const YIN_MAX = 0.35;

interface P {
  speed: number; stereo: number; gender: number; fine: number; bypass: boolean; byp: boolean[]; pans: number[];
  notes: boolean[]; a3: number; minHz: number; ref: number; formant: boolean;
  midi: boolean; octaves: boolean; harmonize: boolean; replace: boolean; vel: boolean; port: number;
}

/** Note events queued for the next process() call (sample offsets in that block). */
const EVQ = 256;

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function readParams(raw: unknown): P {
  const q = (raw ?? {}) as Record<string, unknown>;
  const byp: boolean[] = [];
  for (let i = 0; i < 12; i++) byp.push(num(q[`byp${i}`], 0) > 0);
  const notes = Array.isArray(q.notes) && q.notes.length === 12 ? (q.notes as unknown[]).map((x) => !!x) : new Array(12).fill(true);
  return {
    speed: Math.min(256, Math.max(0, num(q.speed, 256))),
    stereo: Math.min(256, Math.max(0, num(q.stereo, 256))) / 256,
    gender: (Math.min(256, Math.max(0, num(q.gender, 128))) - 128) / 128,
    fine: ((Math.min(256, Math.max(0, num(q.fine, 128))) - 128) / 128) * 100,
    bypass: num(q.bypass, 0) > 0,
    byp,
    pans: [1, 2, 3, 4].map((k) => (Math.min(256, Math.max(0, num(q[`pan${k}`], 128))) - 128) / 128),
    notes,
    a3: Math.min(480, Math.max(400, num(q.a3, 440))),
    minHz: PIT_MIN_HZ[Math.min(PIT_MIN_HZ.length - 1, Math.max(0, Math.round(num(q.minHz, 3))))],
    ref: Math.min(2, Math.max(0, Math.round(num(q.ref, 0)))),
    formant: !!q.formant,
    midi: !!q.midi, octaves: !!q.octaves, harmonize: !!q.harmonize,
    replace: q.replace === undefined ? true : !!q.replace,
    vel: !!q.vel,
    port: Math.min(255, Math.max(-1, Math.round(num(q.port, -1)))),
  };
}

/** 4-point Hermite read of a ring at fractional position pos (absolute sample index). */
function readRing(r: Float32Array, pos: number): number {
  const i = Math.floor(pos), f = pos - i;
  const xm1 = r[(i - 1) & MASK], x0 = r[i & MASK], x1 = r[(i + 1) & MASK], x2 = r[(i + 2) & MASK];
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}

/** YIN pitch detector with integer lags (FL detects whole-sample periods). */
class Detector {
  private fft: FFT | null = null;
  private re = new Float64Array(0);
  private im = new Float64Array(0);
  private cum = new Float64Array(0);
  private d = new Float64Array(0);
  /** Returns the detected lag in samples (0 = unvoiced). */
  detect(ring: Float32Array, end: number, minLag: number, maxLag: number): number {
    const W = Math.max(1024, 2 * maxLag);
    let N = 1;
    while (N < 2 * W) N <<= 1;
    if (!this.fft || this.fft.n !== N) {
      this.fft = getFFT(N);
      this.re = new Float64Array(N); this.im = new Float64Array(N);
      this.cum = new Float64Array(W + 1); this.d = new Float64Array(maxLag + 2);
    }
    if (this.d.length < maxLag + 2) this.d = new Float64Array(maxLag + 2);
    if (this.cum.length < W + 1) this.cum = new Float64Array(W + 1);
    const re = this.re, im = this.im, cum = this.cum;
    const start = end - W;
    cum[0] = 0;
    let e = 0;
    for (let j = 0; j < W; j++) {
      const x = ring[(start + j) & MASK];
      re[j] = x; im[j] = 0;
      e += x * x;
      cum[j + 1] = e;
    }
    for (let j = W; j < N; j++) { re[j] = 0; im[j] = 0; }
    if (e / W < 1e-9) return 0; // below -90 dBFS: unvoiced
    this.fft.transform(re, im, false);
    for (let j = 0; j < N; j++) { re[j] = re[j] * re[j] + im[j] * im[j]; im[j] = 0; }
    this.fft.transform(re, im, true);
    const inv = 1 / N;
    // difference function over the frame and its cumulative mean normalisation
    const d = this.d;
    let run = 0;
    let best = 0, bestV = 1e9, first = 0;
    for (let tau = 1; tau <= maxLag; tau++) {
      const r = re[tau] * inv;
      const e0 = cum[W - tau], e1 = cum[W] - cum[tau];
      const dv = Math.max(0, e0 + e1 - 2 * r);
      run += dv;
      const nd = run > 0 ? (dv * tau) / run : 1;
      d[tau] = nd;
      if (tau >= minLag) {
        if (nd < bestV) { bestV = nd; best = tau; }
        if (!first && nd < YIN_THR) first = tau;
      }
    }
    // the dip must be a true local minimum (a period just below the range is not detected, as in FL)
    if (first) {
      let t = first;
      while (t + 1 <= maxLag && d[t + 1] < d[t]) t++;
      if (d[t - 1] >= d[t] && (t + 1 > maxLag || d[t + 1] >= d[t])) return t;
      return 0;
    }
    if (bestV < YIN_MAX && d[best - 1] >= d[best] && (best + 1 > maxLag || d[best + 1] >= d[best])) return best;
    return 0;
  }
}

/** Resampling pitch shifter: a read head at `ratio` behind the write head, spliced by whole periods. */
class DelayShifter {
  D = 4;
  private oldD = 0;
  private xf = 0;
  private xfLen = 1;
  reset(): void { this.D = 4; this.xf = 0; }
  /** One output sample: `w` = absolute index of the newest input sample. */
  tick(ring: Float32Array, w: number, ratio: number, period: number, sr: number): number {
    const step = 1 - ratio;
    const xfl = Math.max(16, Math.min(Math.round(period), Math.round(0.012 * sr)));
    const lo = 3 + Math.max(0, ratio - 1) * xfl + 1;
    const hi = lo + period + Math.max(0, 1 - ratio) * xfl;
    this.D += step;
    if (this.xf <= 0 && (this.D < lo || this.D > hi)) {
      let nd = this.D;
      let guard = 0;
      while (nd < lo && guard++ < 64) nd += period;
      while (nd > hi && guard++ < 128) nd -= period;
      if (nd < 3) nd = 3;
      this.oldD = this.D; this.D = nd; this.xf = xfl; this.xfLen = xfl;
    }
    let y = readRing(ring, w - this.D);
    if (this.xf > 0) {
      this.oldD += step;
      const od = Math.max(2, this.oldD);
      const a = this.xf / this.xfLen; // 1 -> 0
      const g0 = Math.sin(a * Math.PI * 0.5), g1 = Math.cos(a * Math.PI * 0.5);
      y = readRing(ring, w - od) * g0 * g0 + y * g1 * g1;
      this.xf--;
    }
    return y;
  }
}

/** TD-PSOLA with formant (gender) scaling: grains every analysis period, re-spaced to the target period. */
class Psola {
  private readonly ola: Float32Array;
  private readonly mask: number;
  private pos = 0;
  private toNext = 0;
  private aMark = 0;
  constructor(len: number) {
    let n = 1;
    while (n < len) n <<= 1;
    this.ola = new Float32Array(n);
    this.mask = n - 1;
  }
  reset(): void { this.ola.fill(0); this.pos = 0; this.toNext = 0; this.aMark = 0; }
  tick(ring: Float32Array, w: number, ratio: number, period: number, g: number): number {
    const pout = Math.max(8, period / ratio);
    const reach = Math.ceil(pout * g) + 3;
    // analysis marks follow the input every period (the newest whose grain is fully available)
    if (w - this.aMark > 2 * period + reach || w < this.aMark) this.aMark = w - reach - period;
    while (this.aMark + period <= w - reach) this.aMark += period;
    if (this.toNext <= 0) {
      const half = Math.max(4, Math.round(pout));
      const c = this.aMark;
      const n = 2 * half;
      const ola = this.ola, m = this.mask;
      for (let j = 0; j < n; j++) {
        const wv = 0.5 - 0.5 * Math.cos((Math.PI * 2 * (j + 0.5)) / n);
        ola[(this.pos + j) & m] += wv * readRing(ring, c + (j - half) * g);
      }
      this.toNext += pout;
    }
    this.toNext -= 1;
    const y = this.ola[this.pos & this.mask];
    this.ola[this.pos & this.mask] = 0;
    this.pos++;
    return y;
  }
}

/** One corrected voice: glide state + shifters for up to two channels. */
class Voice {
  shift = 0; // cents, smoothed
  target = 0;
  readonly ds = [new DelayShifter(), new DelayShifter()];
  readonly ps: Psola[];
  constructor(sr: number) {
    this.ps = [new Psola(Math.ceil(sr * 0.2)), new Psola(Math.ceil(sr * 0.2))];
  }
  reset(): void { this.shift = 0; this.target = 0; this.ds[0].reset(); this.ds[1].reset(); this.ps[0].reset(); this.ps[1].reset(); }
}

class Pitcher implements EffectInstance {
  latency = 0;
  tail = 0.25;
  private readonly sr: number;
  private p: P = readParams({});
  private readonly ringL = new Float32Array(RING);
  private readonly ringR = new Float32Array(RING);
  private readonly ringM = new Float32Array(RING);
  private w = 0; // absolute index of the next sample to write
  private hopCnt = 0;
  private readonly detL = new Detector();
  private readonly detR = new Detector();
  private lagL = 0; private lagR = 0;
  private perL = 441; private perR = 441;
  private readonly main: Voice;
  private readonly mainR: Voice; // independent right channel (reference "Both")
  private readonly voices: Voice[];
  private mixG = 1; // dry/processed crossfade (bypass)
  private modeFade = 1;
  private lastFormant = false;
  // monitor
  private monIn = 0; private monOut = 0; private monVoiced = false;

  constructor(sr: number) {
    this.sr = sr;
    this.main = new Voice(sr);
    this.mainR = new Voice(sr);
    this.voices = [new Voice(sr), new Voice(sr), new Voice(sr), new Voice(sr)];
  }

  setParams(raw: unknown): void {
    this.p = readParams(raw);
    this.ports = this.p.port >= 0 ? [this.p.port] : [];
  }

  // ---- MIDI notes (FL: from a MIDI Out channel on Pitcher's port) ----
  /** Pitcher's own MIDI input port. */
  private ports: number[] = [];
  /** Notes held, in the order they were pressed, and their velocities (MIDI 0..127). */
  private readonly order: number[] = [];
  private readonly vel = new Float32Array(128);
  /** The notes the voices follow: up to four (the last pressed), highest first (voice 1 = highest note). */
  private readonly sortedHeld = new Int32Array(4);
  private readonly heldGain = new Float32Array(4);
  private nHeld = 0;
  /** The note MIDI mode follows (the last pressed). */
  private lastNote = 60;
  private readonly evFrame = new Int32Array(EVQ);
  private readonly evKey = new Int16Array(EVQ);
  private readonly evVel = new Float32Array(EVQ);
  private readonly evOn = new Uint8Array(EVQ);
  private nEv = 0;

  midiPorts(): readonly number[] { return this.ports; }

  noteOn(key: number, velocity: number, frameOffset: number): void { this.queue(key, velocity, frameOffset, true); }

  noteOff(key: number, frameOffset: number): void { this.queue(key, 0, frameOffset, false); }

  allNotesOff(): void {
    this.nEv = 0;
    this.order.length = 0;
    this.vel.fill(0);
    this.updateHeld();
    this.computeTargets();
  }

  private queue(key: number, velocity: number, frame: number, on: boolean): void {
    if (key < 0 || key > 127) return;
    if (this.nEv >= EVQ) { this.apply(key, velocity, on); return; } // queue full (never in practice): apply at once
    const i = this.nEv++;
    this.evFrame[i] = Math.max(0, frame | 0); this.evKey[i] = key; this.evVel[i] = velocity; this.evOn[i] = on ? 1 : 0;
  }

  private applyEvent(i: number): void {
    this.apply(this.evKey[i], this.evVel[i], this.evOn[i] === 1);
  }

  private apply(key: number, velocity: number, on: boolean): void {
    const at = this.order.indexOf(key);
    if (at >= 0) this.order.splice(at, 1);
    if (on) {
      this.order.push(key);
      this.vel[key] = Math.min(127, Math.round((velocity * 127) / 128));
    } else this.vel[key] = 0;
    this.updateHeld();
  }

  private readonly last4 = new Int32Array(4);

  private updateHeld(): void {
    const len = this.order.length, n = Math.min(4, len), t = this.last4;
    for (let k = 0; k < n; k++) t[k] = this.order[len - n + k];
    for (let a = 1; a < n; a++) { // highest first
      const v = t[a];
      let b = a - 1;
      while (b >= 0 && t[b] < v) { t[b + 1] = t[b]; b--; }
      t[b + 1] = v;
    }
    this.nHeld = n;
    for (let k = 0; k < 4; k++) {
      this.sortedHeld[k] = k < n ? t[k] : 60;
      this.heldGain[k] = k < n ? this.vel[t[k]] / 127 : 0;
    }
    if (len) this.lastNote = this.order[len - 1];
  }

  reset(): void {
    this.ringL.fill(0); this.ringR.fill(0); this.ringM.fill(0);
    this.w = 0; this.hopCnt = 0; this.lagL = this.lagR = 0;
    this.main.reset(); this.mainR.reset();
    for (const v of this.voices) v.reset();
    this.mixG = this.p.bypass ? 0 : 1;
  }

  /** Cents (MIDI note x 100) of a frequency for the A3 tuning. */
  private toCents(f: number): number {
    return 6900 + 1200 * Math.log2(f / this.p.a3);
  }

  /** Automatic target (cents) for a detected pitch: nearest enabled note, or the pitch itself when bypassed. */
  private autoTarget(c: number): number {
    const q = this.p;
    const n0 = Math.round(c / 100);
    let best = -1e9, bd = 1e9;
    for (let d = -6; d <= 6; d++) {
      const n = n0 + d;
      const pc = ((n % 12) + 12) % 12;
      if (!q.notes[pc]) continue;
      const dist = Math.abs(n * 100 - c);
      if (dist < bd) { bd = dist; best = n; }
    }
    if (best === -1e9) return c;
    if (q.byp[((best % 12) + 12) % 12]) return c;
    return best * 100 + q.fine;
  }

  /** Target for a held note: OCTAVES = the note itself, otherwise its pitch class nearest the input. */
  private noteTarget(note: number, c: number): number {
    if (this.p.octaves) return note * 100 + this.p.fine;
    const pc = note % 12;
    let n = Math.round((c / 100 - pc) / 12) * 12 + pc;
    if (Math.abs(n * 100 - c) > 600) n += n * 100 > c ? -12 : 12;
    return n * 100 + this.p.fine;
  }

  private analyse(): void {
    const q = this.p, sr = this.sr;
    const minLag = Math.min(MIN_LAG, Math.round(sr / 1000));
    const maxLag = Math.min(4000, Math.round(sr / q.minHz));
    const lagMin = Math.max(minLag, MIN_LAG);
    const refRing = q.ref === 2 ? this.ringR : q.ref === 0 ? this.ringL : this.ringL;
    this.lagL = this.detL.detect(refRing, this.w, lagMin, maxLag);
    if (this.lagL) this.perL = this.lagL;
    if (q.ref === 1) {
      this.lagR = this.detR.detect(this.ringR, this.w, lagMin, maxLag);
      if (this.lagR) this.perR = this.lagR;
    } else { this.lagR = this.lagL; this.perR = this.perL; }
    this.computeTargets();
  }

  /** Correction targets (cents of shift) from the last detected pitch and the held notes. */
  private computeTargets(): void {
    const q = this.p, sr = this.sr;
    const heldOn = (q.midi || q.harmonize) && this.nHeld > 0;
    if (!heldOn) {
      this.main.target = this.lagL ? this.autoTarget(this.toCents(sr / this.lagL)) - this.toCents(sr / this.lagL) : 0;
      this.mainR.target = this.lagR ? this.autoTarget(this.toCents(sr / this.lagR)) - this.toCents(sr / this.lagR) : 0;
    } else if (!q.harmonize) {
      const note = this.lastNote;
      this.main.target = this.lagL ? this.noteTarget(note, this.toCents(sr / this.lagL)) - this.toCents(sr / this.lagL) : 0;
      this.mainR.target = this.lagR ? this.noteTarget(note, this.toCents(sr / this.lagR)) - this.toCents(sr / this.lagR) : 0;
    } else {
      const c = this.lagL ? this.toCents(sr / this.lagL) : 0;
      for (let k = 0; k < 4; k++) {
        const v = this.voices[k];
        v.target = k < this.nHeld && this.lagL ? this.noteTarget(this.sortedHeld[k], c) - c : 0;
      }
    }
    if (this.lagL) {
      const c = this.toCents(sr / this.lagL);
      this.monIn = c;
      this.monOut = c + this.main.shift;
      this.monVoiced = true;
    } else this.monVoiced = false;
  }

  process(L: Float32Array, R: Float32Array, n: number, _ctx?: FxContext): void {
    const q = this.p, sr = this.sr;
    const tau = pitSpeedTau(q.speed);
    const a = tau > 0.05 ? Math.exp(-1 / ((tau / 1000) * sr)) : 0;
    const g = Math.pow(2, (q.gender * 7) / 12);
    let heldOn = (q.midi || q.harmonize) && this.nHeld > 0;
    let harm = q.harmonize && heldOn;
    const fadeStep = 1 / (0.01 * sr);
    if (q.formant !== this.lastFormant) { this.lastFormant = q.formant; this.modeFade = 0; }
    let ev = 0;
    const nEv = this.nEv;
    for (let i = 0; i < n; i++) {
      // MIDI notes take effect at their sample
      if (ev < nEv && this.evFrame[ev] <= i) {
        while (ev < nEv && this.evFrame[ev] <= i) this.applyEvent(ev++);
        this.computeTargets();
        heldOn = (q.midi || q.harmonize) && this.nHeld > 0;
        harm = q.harmonize && heldOn;
      }
      let xl = L[i], xr = R[i];
      xl = xl - xl === 0 ? xl : 0; xr = xr - xr === 0 ? xr : 0;
      const w = this.w;
      this.ringL[w & MASK] = xl; this.ringR[w & MASK] = xr; this.ringM[w & MASK] = 0.5 * (xl + xr);
      this.w = w + 1;
      if (++this.hopCnt >= HOP) { this.hopCnt = 0; this.analyse(); }
      // glide
      const m = this.main, mr = this.mainR;
      m.shift = m.target + (m.shift - m.target) * a;
      mr.shift = mr.target + (mr.shift - mr.target) * a;
      let yl: number, yr: number;
      if (!harm) {
        const rl = Math.pow(2, m.shift / 1200);
        const rr = q.ref === 1 ? Math.pow(2, mr.shift / 1200) : rl;
        const pl = this.perL, pr = q.ref === 1 ? this.perR : this.perL;
        if (q.formant) {
          yl = m.ps[0].tick(this.ringL, w, rl, pl, g);
          yr = (q.ref === 1 ? mr : m).ps[1].tick(this.ringR, w, rr, pr, g);
        } else {
          yl = m.ds[0].tick(this.ringL, w, rl, pl, sr);
          yr = (q.ref === 1 ? mr : m).ds[1].tick(this.ringR, w, rr, pr, sr);
        }
      } else {
        // harmonize: voices from the mono input, panned (voice pan x stereo spread)
        yl = 0; yr = 0;
        const velOn = q.vel && !q.octaves;
        for (let k = 0; k < this.nHeld; k++) {
          const v = this.voices[k];
          v.shift = v.target + (v.shift - v.target) * a;
          const r = Math.pow(2, v.shift / 1200);
          let s = q.formant ? v.ps[0].tick(this.ringM, w, r, this.perL, g) : v.ds[0].tick(this.ringM, w, r, this.perL, sr);
          if (velOn) s *= this.heldGain[k];
          const pan = Math.max(-1, Math.min(1, q.pans[k] * q.stereo));
          yl += s * Math.min(1, 1 - pan);
          yr += s * Math.min(1, 1 + pan);
        }
        if (!q.replace) { yl += xl; yr += xr; }
      }
      // mode switch declick and bypass crossfade
      if (this.modeFade < 1) { this.modeFade = Math.min(1, this.modeFade + fadeStep); yl *= this.modeFade; yr *= this.modeFade; }
      const target = q.bypass ? 0 : 1;
      if (this.mixG !== target) this.mixG = target > this.mixG ? Math.min(1, this.mixG + fadeStep) : Math.max(0, this.mixG - fadeStep);
      const mg = this.mixG;
      const ol = yl * mg + xl * (1 - mg), or = yr * mg + xr * (1 - mg);
      L[i] = ol === ol && ol < 1e6 && ol > -1e6 ? ol : 0;
      R[i] = or === or && or < 1e6 && or > -1e6 ? or : 0;
    }
    // events past the block end (none from the mixer) apply now
    while (ev < nEv) this.applyEvent(ev++);
    if (nEv) this.computeTargets();
    this.nEv = 0;
  }

  monitor(): FxMonitor {
    return { voiced: this.monVoiced, inCents: this.monIn, outCents: this.monOut, held: this.order.join(',') };
  }
}

export const effect: EffectModule = {
  id: 'pitcher',
  create: (sampleRate) => new Pitcher(sampleRate),
};
