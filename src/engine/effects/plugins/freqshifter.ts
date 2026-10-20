// Frequency Shifter: single-sideband frequency shifting and ring modulation,
// calibrated against FL's binary (docs/research/fx/freqshifter.md).
//
// The wet path starts with FL's band filters (2nd-order high-pass 23.75 Hz,
// Q 0.56, and low-pass 0.4531 fs, Q 0.5, both measured). Shifter: a Hilbert
// transformer (two cascades of four allpass sections, coefficients fitted to
// FL's measured I / Q phase responses, Q one sample late) gives the analytic
// signal I + jQ; the output is I cos(phi) - s Q sin(phi), so every component
// moves by the shift (s = Sideband 100%), by minus it (s = -100%) or splits
// into both sidebands (s = 0). The right oscillator leads by the L/R phase
// (0..90 degrees); both restart at the Start phase (+-180 degrees) when the
// transport starts. HQ band-limits the input first (16th-order Butterworth:
// a low-pass below Nyquist minus the shift for upward shifts, a high-pass at
// the shift for downward ones), so nothing folds back at Nyquist or 0 Hz.
// Ring modulator: input times a cosine at sqrt(fmax * f) (FL's ring
// frequency curve), or times a sidechain input; negative values leave the
// input unmodulated. Feedback returns the wet output one sample later with
// FL's effective loop gain (0.51 at 50%, 0.94 at 100%). Mix: dry and wet
// each at full level up to the middle (FL). Stereo narrows the wet signal.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import { getFFT } from '../../dsp/fft';
import { fsHz, fsRingHz } from '../../../model/fx/plugins/freqshifter';

/** Hilbert pair fitted to FL's measured phase responses (squared pole radii of z^-2 allpass sections). */
const HIL_I = [0.1624204785, 0.7332318739, 0.9450011347, 0.9912190590];
const HIL_Q = [0.4804438540, 0.8756940930, 0.9768542627, 0.9978390442];

/** Cascade of allpass sections y[n] = c (x[n] + y[n-2]) - x[n-2]. */
class Allpass2 {
  private x1 = new Float64Array(4);
  private x2 = new Float64Array(4);
  private y1 = new Float64Array(4);
  private y2 = new Float64Array(4);
  constructor(private c: number[]) {}
  run(x: number): number {
    const c = this.c, x1 = this.x1, x2 = this.x2, y1 = this.y1, y2 = this.y2;
    for (let k = 0; k < c.length; k++) {
      const y = c[k] * (x + y2[k]) - x2[k];
      x2[k] = x1[k]; x1[k] = x;
      y2[k] = y1[k]; y1[k] = y;
      x = y;
    }
    return x;
  }
  flush(): void {
    for (const a of [this.x1, this.x2, this.y1, this.y2]) for (let k = 0; k < 4; k++) if (a[k] < 1e-25 && a[k] > -1e-25) a[k] = 0;
  }
  reset(): void { this.x1.fill(0); this.x2.fill(0); this.y1.fill(0); this.y2.fill(0); }
}

class Hilbert {
  private a = new Allpass2(HIL_I);
  private b = new Allpass2(HIL_Q);
  private qd = 0;
  i = 0;
  q = 0;
  run(x: number): void {
    this.i = this.a.run(x);
    const q = this.b.run(x);
    this.q = this.qd;
    this.qd = q;
  }
  flush(): void { this.a.flush(); this.b.flush(); if (this.qd < 1e-25 && this.qd > -1e-25) this.qd = 0; }
  reset(): void { this.a.reset(); this.b.reset(); this.qd = this.i = this.q = 0; }
}

/** Biquad cascade (transposed direct form II), coefficients per section [b0, b1, b2, a1, a2]. */
class Cascade {
  readonly c: Float64Array;
  private s1: Float64Array;
  private s2: Float64Array;
  constructor(public n: number) {
    this.c = new Float64Array(n * 5);
    this.s1 = new Float64Array(n);
    this.s2 = new Float64Array(n);
    for (let k = 0; k < n; k++) this.c[k * 5] = 1;
  }
  run(x: number): number {
    const c = this.c, s1 = this.s1, s2 = this.s2;
    for (let k = 0; k < this.n; k++) {
      const o = k * 5;
      const y = c[o] * x + s1[k];
      s1[k] = c[o + 1] * x - c[o + 3] * y + s2[k];
      s2[k] = c[o + 2] * x - c[o + 4] * y;
      x = y;
    }
    return x;
  }
  flush(): void {
    for (let k = 0; k < this.n; k++) {
      if (!(Math.abs(this.s1[k]) > 1e-25)) this.s1[k] = 0;
      if (!(Math.abs(this.s2[k]) > 1e-25)) this.s2[k] = 0;
    }
  }
  reset(): void { this.s1.fill(0); this.s2.fill(0); }
}

function biquad(out: Float64Array, o: number, type: 'lp' | 'hp', fc: number, q: number, sr: number): void {
  const w0 = (2 * Math.PI * Math.min(0.4999 * sr, Math.max(1, fc))) / sr;
  const cs = Math.cos(w0), al = Math.sin(w0) / (2 * q);
  const a0 = 1 + al;
  if (type === 'lp') {
    out[o] = (1 - cs) / 2 / a0; out[o + 1] = (1 - cs) / a0; out[o + 2] = (1 - cs) / 2 / a0;
  } else {
    out[o] = (1 + cs) / 2 / a0; out[o + 1] = -(1 + cs) / a0; out[o + 2] = (1 + cs) / 2 / a0;
  }
  out[o + 3] = (-2 * cs) / a0;
  out[o + 4] = (1 - al) / a0;
}

/** 16th-order Butterworth as 8 biquads. */
function butterworth(out: Float64Array, type: 'lp' | 'hp', fc: number, sr: number): void {
  const n = 16;
  for (let k = 0; k < n / 2; k++) {
    const q = 1 / (2 * Math.cos((Math.PI * (2 * k + 1)) / (2 * n)));
    biquad(out, k * 5, type, fc, q, sr);
  }
}

const SPEC_N = 1024;
const SCOPE_N = 256;

class FrequencyShifter implements EffectInstance {
  tail = 0.3;
  private sr: number;
  private hL = new Hilbert();
  private hR = new Hilbert();
  private bandL = new Cascade(2);
  private bandR = new Cascade(2);
  private hqL = new Cascade(8);
  private hqR = new Cascade(8);
  private hqActive = false;
  private hqHz = NaN;

  // parameters
  private type = 0;
  private freqRaw = 70000;
  private range = 1;
  private lrPhase = 0;
  private shapeL = 1;
  private shapeR = 1;
  private feedback = 0;
  private stereo = 1;
  private start = 0;
  private mix = 1;
  private sidechain = 0;

  // smoothed state
  private phase = 0;
  private hz = 0;
  private hzT = 0;
  private dryS = 0;
  private wetS = 1;
  private sL = 1;
  private sR = 1;
  private fbS = 0;
  private stS = 1;
  private lrS = 0;
  private kSmooth: number;
  private fbL = 0;
  private fbR = 0;
  private wasPlaying = false;
  private tempo = 120;

  // display
  private inBuf = new Float32Array(SPEC_N);
  private outBuf = new Float32Array(SPEC_N);
  private bufW = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.kSmooth = 1 - Math.exp(-1 / (0.02 * sampleRate));
    biquad(this.bandL.c, 0, 'hp', 23.75, 0.56, sampleRate);
    biquad(this.bandL.c, 5, 'lp', 0.4531 * sampleRate, 0.5, sampleRate);
    this.bandR.c.set(this.bandL.c);
  }

  setParams(p: unknown): void {
    const q = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
    this.mix = clamp(num(q.mix, 10000) / 10000, 0, 1);
    this.type = Math.round(clamp(num(q.type, 0), 0, 2));
    this.freqRaw = clamp(num(q.freq, 70000), -70000, 70000);
    this.range = Math.round(clamp(num(q.range, 1), 0, 2));
    this.lrPhase = (clamp(num(q.lrphase, 0), 0, 10000) / 10000) * (Math.PI / 2);
    this.shapeL = clamp((num(q.lshape, 10000) - 5000) / 5000, -1, 1);
    this.shapeR = clamp((num(q.rshape, 10000) - 5000) / 5000, -1, 1);
    const fb = clamp((num(q.feedback, 5000) - 5000) / 5000, -1, 1);
    this.feedback = Math.sign(fb) * 0.94 * Math.pow(Math.abs(fb), 0.88);
    this.stereo = clamp(num(q.stereo, 10000) / 10000, 0, 1);
    this.start = clamp((num(q.start, 5000) - 5000) / 5000, -1, 1) * Math.PI;
    this.sidechain = Math.round(num(q.sidechain, 0));
    this.updateHz();
  }

  private updateHz(): void {
    // ring modulator: FL's own curve (geometric mean with the range's top); negative = no modulation
    const hz = this.type === 2 ? fsRingHz(this.freqRaw, this.range, this.tempo) : fsHz(this.freqRaw, this.range, this.tempo);
    this.hzT = Math.max(-0.49 * this.sr, Math.min(0.49 * this.sr, hz));
  }

  /** HQ band limits for a shift (Hz): fitted to FL's measured edges. */
  private updateHq(hz: number): void {
    const sr = this.sr;
    if (Math.abs(hz) < 1) { this.hqActive = false; return; }
    this.hqActive = true;
    if (Math.abs(hz - this.hqHz) < Math.max(0.5, Math.abs(hz) * 0.002)) return;
    this.hqHz = hz;
    if (hz > 0) {
      const fc = Math.max(100, Math.min(20500 - 0.5 * hz, 22900 - 1.1 * hz, 0.5 * sr - hz - 100, 0.45 * sr));
      butterworth(this.hqL.c, 'lp', fc, sr);
    } else {
      butterworth(this.hqL.c, 'hp', Math.min(0.45 * sr, 1.04 * -hz), sr);
    }
    this.hqR.c.set(this.hqL.c);
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (ctx.tempo > 0 && ctx.tempo !== this.tempo) { this.tempo = ctx.tempo; if (this.range === 2) this.updateHz(); }
    if (ctx.playing && !this.wasPlaying) this.phase = this.start;
    this.wasPlaying = ctx.playing;
    const ring = this.type === 2;
    const hq = this.type === 0;
    let sc: { L: Float32Array; R: Float32Array } | null = null;
    if (ring && this.sidechain > 0) sc = ctx.sidechain.find((s) => s.source === this.sidechain) ?? null;
    const k = this.kSmooth;
    // per-block glide of the frequency (the HQ filters follow it)
    let hz = this.hz;
    const hzEnd = hz + (this.hzT - hz) * (1 - Math.pow(1 - k, n));
    if (hq && !ring) this.updateHq(hzEnd);
    const dHz = (hzEnd - hz) / n;
    const w = (2 * Math.PI) / this.sr;
    const dryT = Math.min(1, 2 * (1 - this.mix)), wetT = Math.min(1, 2 * this.mix);
    let phase = this.phase;
    let dryS = this.dryS, wetS = this.wetS, sL = this.sL, sR = this.sR, fbS = this.fbS, stS = this.stS, lrS = this.lrS;
    let fbL = this.fbL, fbR = this.fbR;
    const sLT = this.shapeL, sRT = this.shapeR, fbT = this.feedback, stT = this.stereo, lrT = this.lrPhase;
    const hL = this.hL, hR = this.hR, bL = this.bandL, bR = this.bandR, qL = this.hqL, qR = this.hqR;
    const useHq = hq && !ring && this.hqActive;
    let bw = this.bufW;
    for (let i = 0; i < n; i++) {
      hz += dHz;
      dryS += (dryT - dryS) * k;
      wetS += (wetT - wetS) * k;
      sL += (sLT - sL) * k;
      sR += (sRT - sR) * k;
      fbS += (fbT - fbS) * k;
      stS += (stT - stS) * k;
      lrS += (lrT - lrS) * k;
      const xL = L[i], xR = R[i];
      let inL = bL.run(xL + fbS * fbL), inR = bR.run(xR + fbS * fbR);
      let wL: number, wR: number;
      if (ring) {
        if (sc) { wL = inL * sc.L[i]; wR = inR * sc.R[i]; } else { wL = inL * Math.cos(phase); wR = inR * Math.cos(phase + lrS); }
      } else {
        if (useHq) { inL = qL.run(inL); inR = qR.run(inR); }
        hL.run(inL); hR.run(inR);
        const c0 = Math.cos(phase), s0 = Math.sin(phase);
        const c1 = Math.cos(phase + lrS), s1 = Math.sin(phase + lrS);
        wL = hL.i * c0 - sL * hL.q * s0;
        wR = hR.i * c1 - sR * hR.q * s1;
      }
      phase += w * hz;
      if (phase > Math.PI) phase -= 2 * Math.PI; else if (phase < -Math.PI) phase += 2 * Math.PI;
      const m = 0.5 * (wL + wR), d = 0.5 * (wL - wR) * stS;
      wL = m + d; wR = m - d;
      // the feedback path saturates softly so 100% stays bounded
      fbL = wL >= 1.5 ? 1 : wL <= -1.5 ? -1 : wL - (wL * wL * wL) / 6.75;
      fbR = wR >= 1.5 ? 1 : wR <= -1.5 ? -1 : wR - (wR * wR * wR) / 6.75;
      const oL = xL * dryS + wL * wetS, oR = xR * dryS + wR * wetS;
      L[i] = Number.isFinite(oL) ? oL : 0;
      R[i] = Number.isFinite(oR) ? oR : 0;
      this.inBuf[bw] = 0.5 * (xL + xR);
      this.outBuf[bw] = 0.5 * (L[i] + R[i]);
      bw = (bw + 1) % SPEC_N;
    }
    hL.flush(); hR.flush(); bL.flush(); bR.flush(); qL.flush(); qR.flush();
    if (!Number.isFinite(fbL) || !Number.isFinite(fbR) || !Number.isFinite(phase)) {
      fbL = fbR = 0; phase = 0;
      hL.reset(); hR.reset(); bL.reset(); bR.reset(); qL.reset(); qR.reset();
    }
    this.phase = phase; this.hz = hz;
    this.dryS = dryS; this.wetS = wetS; this.sL = sL; this.sR = sR; this.fbS = fbS; this.stS = stS; this.lrS = lrS;
    this.fbL = Math.abs(fbL) < 1e-20 ? 0 : fbL;
    this.fbR = Math.abs(fbR) < 1e-20 ? 0 : fbR;
    this.bufW = bw;
  }

  reset(): void {
    this.hL.reset(); this.hR.reset(); this.bandL.reset(); this.bandR.reset(); this.hqL.reset(); this.hqR.reset();
    this.fbL = this.fbR = 0;
    this.phase = this.start;
    this.hz = this.hzT;
    this.hqHz = NaN;
    this.dryS = Math.min(1, 2 * (1 - this.mix)); this.wetS = Math.min(1, 2 * this.mix);
    this.sL = this.shapeL; this.sR = this.shapeR;
    this.fbS = this.feedback; this.stS = this.stereo; this.lrS = this.lrPhase;
    this.inBuf.fill(0); this.outBuf.fill(0);
  }

  /** Spectrum (input and output, 64 log bands, dB) and an oscilloscope of the output. */
  monitor(): FxMonitor {
    const fft = getFFT(SPEC_N);
    const bands = (src: Float32Array): number[] => {
      const re = new Float64Array(SPEC_N), im = new Float64Array(SPEC_N);
      for (let i = 0; i < SPEC_N; i++) {
        const wv = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SPEC_N - 1));
        re[i] = src[(this.bufW + i) % SPEC_N] * wv;
      }
      fft.transform(re, im);
      const out: number[] = [];
      const nb = 64, fmin = 30, fmax = Math.min(20000, this.sr / 2);
      for (let b = 0; b < nb; b++) {
        const f0 = fmin * Math.pow(fmax / fmin, b / nb), f1 = fmin * Math.pow(fmax / fmin, (b + 1) / nb);
        const k0 = Math.max(1, Math.floor((f0 * SPEC_N) / this.sr)), k1 = Math.max(k0 + 1, Math.ceil((f1 * SPEC_N) / this.sr));
        let m = 0;
        for (let kk = k0; kk < k1 && kk < SPEC_N / 2; kk++) m = Math.max(m, re[kk] * re[kk] + im[kk] * im[kk]);
        out.push(10 * Math.log10(m / ((SPEC_N / 4) * (SPEC_N / 4)) + 1e-12));
      }
      return out;
    };
    const scope: number[] = [];
    for (let i = 0; i < SCOPE_N; i++) scope.push(this.outBuf[(this.bufW - SCOPE_N + i + SPEC_N) % SPEC_N]);
    return { specIn: bands(this.inBuf), specOut: bands(this.outBuf), scope };
  }
}

export const effect: EffectModule = {
  id: 'freqshifter',
  create: (sampleRate) => new FrequencyShifter(sampleRate),
};
