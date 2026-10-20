// BassDrum (FL: BassDrum, by Maxx Claster): a kick synthesizer. Reproduces
// FL 2026's own engine (BassDrum/engine.dylib: BassDrumSynth / BassDrumGen,
// docs/research/gen/bassdrum.md) in its single precision and operation order.
//
// BassDrum is monophonic: FL's synth has one voice and every note retriggers it
// (the drive and noise filter states and the resampler's look-ahead samples
// carry over); FL's voice handles only lend it their levels. So it is an
// 'events' plugin here: it plays its voice itself and applies the newest note's
// volume and panning (FL's pan law) and pitch once per block, as FL does per
// Gen_Render. The key does not change the sound. The voice synthesizes at a
// fixed internal rate of 44100 Hz:
// - Main and slave oscillators read FL's 1024-point single-cycle kick waveform
//   (BD_WAVE, linear interpolation) from a quarter cycle in; frequency =
//   base x (1 + peak x env^4), env falling by the slide rate each sample,
//   clamped to [0, 0.5] cycles per sample. The slave's base / peak / slide are
//   the main's x 2^variation, and it starts Variation phase^2 x 350 samples later.
// - Click: one pass through the same waveform from phase 0.75 + 0.25 cut^(1/8)
//   to 1 at 2^(14 v) Hz, added (x 25 amount^5) to both oscillators' phases.
// - Sample layer: the noise sample (linear interpolation, rate 2^(4 pitch - 2)),
//   four one-pole low-passes (coefficient filter^2), an attack / decay /
//   sustain envelope raised to the 16th power, x 2 mix^2; Noise start shifts
//   it by 4410 (2 start - 1)^3 samples (positive: the oscillators wait).
// - Amplitude: attack (a one-pole to 1, rate 1 / (1 + 10^5 A^8), squared) x
//   duration (a linear fall over Duration^3 s + 1 ms, shaped 7x / (7x + 1),
//   smoothed by 0.005 per sample). No release: note offs are ignored.
// The internal signal is resampled to the host rate with linear interpolation
// at Sampling ratio x 2^(semitones / 12) x 44100 / rate (the ratio and the
// note's pitch levels transpose by resampling, as in FL: semitones = final
// pitch / 100 + 60 - key, i.e. the channel pitch and fine tuning, not the key),
// then: a drive stage (three x / (1 + drive |x|^k) saturators on the signal
// minus a one-pole low-pass, normalised at 0.5), the sub-bass filter (FL's
// 42 Hz biquad with Q = 0.5 + 6 sub^2) and gain 0.4 x velocity x output level.
// The voice stops once its output stayed below 1e-5 for 1024 samples (checked
// per block, as FL). Velocity is the plugin's (MIDI velocity / 127 from the
// note's volume level, FL leaves it out of the voice volume). All parameters
// are read when a note starts, except Sampling ratio (per block).

import type { GenContext, GenEnv, GenInstance, GenModule, GenNote } from '../types';
import { computeLRVol } from '../levels';

const f32 = Math.fround;
const fma = (a: number, b: number, c: number) => f32(a * b + c);
const INV_44100 = f32(2.2675737e-5);
/** The slide-rate constant (per sample at 44.1 kHz for a slide time in s). */
const SLIDE_K = 0.0002;
const SIZE = 1024;
/** Longest stretch rendered at once (frames); FL renders up to 512. */
const STEP_MAX = 128;
/** Note-ons queued per block. */
const MAX_EVENTS = 256;

/**
 * FL's single-cycle kick waveform (BassDrum's "sounddata", 1024 points). FL's
 * file is not copied: the table is rebuilt from its first 16 harmonics
 * (measured; rms difference -87 dB). Exported so tests can inspect it.
 */
export const BD_WAVE = (() => {
  const A = [-0.1326, 0.078039, 0.018496, 0.01342, 0.0030536, 0.0038487, 0.003064, 0.00086656, 0.00018161, 1.52e-05, -0.00019207,
    0.00013965, 5.9172e-05, 0.00014321, 0.00013597, -7.7625e-05, -8.1209e-06, -5.8822e-05, 1.6618e-05, 9.6557e-05, 4.2668e-05, 8.482e-05,
    8.8665e-06, 3.9945e-06, 2.6517e-05, 7.9181e-07, 4.3663e-05, 1.6763e-05, 1.2096e-05, 7.8664e-06, -2.3422e-05, 4.7024e-06, -6.4336e-06];
  const B = [0, 0.85153, -0.0012781, 0.0041319, 0.00019932, 0.001414, 0.001939, 0.0010524, 0.00087025, 0.00011675, 0.00011088,
    0.00026156, 0.00014032, 0.0002284, -1.3965e-05, -2.3459e-05, -2.3412e-05, -9.4291e-05, 7.8355e-06, -3.2656e-05, 7.616e-06, -4.2004e-06,
    -5.2177e-05, 1.8908e-06, -2.4225e-05, 5.6186e-06, 1.3632e-05, -7.1373e-06, 2.0293e-05, -1.3774e-05, -3.5755e-06, -3.4319e-06, -1.6087e-05];
  const t = new Float32Array(SIZE + 1);
  for (let n = 0; n < SIZE; n++) {
    let v = A[0];
    for (let k = 1; k < A.length; k++) {
      const w = (2 * Math.PI * k * n) / SIZE;
      v += A[k] * Math.cos(w) + B[k] * Math.sin(w);
    }
    t[n] = v;
  }
  t[SIZE] = t[0];
  return t;
})();

/** FL's table read: frac(p) x N, linear interpolation, wrapping at the end. */
function waveAt(t: Float32Array, p: number): number {
  let x = f32(p - Math.trunc(p));
  if (x < 0) x = f32(x + 1);
  x = f32(x * SIZE);
  let i = Math.trunc(x);
  if (i < 0) i = 0;
  if (i >= SIZE) i = SIZE - 1;
  const fr = f32(x - i);
  const a = t[i];
  const b = t[i === SIZE - 1 ? 0 : i + 1];
  return fma(fr, f32(b - a), a);
}

/** The parameters as FL's engine holds them (0..1 control / 256, mapped like BassDrumSynth). */
interface BdParams {
  level: number; ratio: number; dur: number; sub: number; drive: number; attack: number;
  base: number; peak: number; slide: number; varBase: number; varPeak: number; varSlide: number; varPhase: number;
  clickCut: number; clickFreq: number; clickAmt: number;
  nA: number; nD: number; nS: number; nStart: number; nPitch: number; nMix: number; nFilter: number;
}

/** The noise sample as FL's engine reads it (mono, 1 guard sample; frames per internal sample). */
interface Noise { data: Float32Array; len: number; rate: number }

class BdVoice {
  /** Playing (FL's voice flag). */
  active = false;
  // ---- internal synth (44.1 kHz)
  ph = 0.25; env = 1; inc = 0; peak = 0; rate = 0;
  ph2 = 0.25; env2 = 1; inc2 = 0; peak2 = 0; rate2 = 0;
  delay2 = 0;
  clickPh = 1; clickInc = 0; clickAmt = 0;
  durLevel = 1; durDec = 1; durSmooth = 1; att = 0; attRate = 1;
  nDelay = 0; nPos = 0; nRate = 1; nMix = 0; nF = 0;
  lp0 = 0; lp1 = 0; lp2 = 0; lp3 = 0;
  nLevel = 0; nTarget = 1; nRateCur = 0; nDecay = 0; nSus = 0;
  // ---- resampler (FL's: linear, buffer of rendered internal samples)
  readonly buf: Float32Array;
  fill = 0; pos = 0;
  // ---- output stage
  y1 = 0; drive = 0; s9 = 0.5; s10 = 1; gain = 0;
  fb0 = 0; fb1 = 0; fb2 = 0; x1 = 0; x2 = 0; yy1 = 0; yy2 = 0;
  silent = 0;

  constructor(private readonly s: BassDrum) {
    // the next control step's internal samples at the highest ratio (4) plus FL's 2 guard samples
    this.buf = new Float32Array(Math.ceil((STEP_MAX * 4 * 44100) / s.sampleRate) + 8);
  }

  /** FL's voice reset (end of a voice, construction): clears what a retrigger keeps. */
  reset(): void {
    this.active = false;
    this.y1 = 0;
    this.lp0 = this.lp1 = this.lp2 = this.lp3 = 0;
    this.fill = 0; this.pos = 0;
    this.x1 = this.x2 = this.yy1 = this.yy2 = 0;
    this.silent = 0;
  }

  /** FL's note on (BassDrumGen trigger): everything except the drive / noise filter states and the resampler. */
  start(velocity: number): void {
    const s = this.s, q = s.p;
    this.active = true;
    // velocity: MIDI velocity / 127 (FL 128 -> 127), raised to the curve (1)
    this.gain = f32(f32(velocity / 127) * s.levelGain);
    this.drive = f32(f32(f32(q.drive * q.drive) * f32(q.drive * q.drive)) * 2560);
    this.durLevel = 1; this.durSmooth = 1; this.att = 0;
    this.durDec = q.dur > 0 ? f32(1 / (q.dur * 44100 + 44.1)) : 1;
    const a2 = f32(q.attack * q.attack), a4 = f32(a2 * a2), a8 = f32(a4 * a4);
    this.attRate = f32(1 / fma(a8, 100000, 1));
    const base = f32(INV_44100 * s.baseHz);
    this.inc = base;
    this.peak = s.peakMul;
    this.rate = f32(SLIDE_K / s.slideS);
    this.ph = 0.25; this.env = 1; this.ph2 = 0.25; this.env2 = 1;
    this.inc2 = f32(f32(Math.pow(2, q.varBase)) * base);
    this.peak2 = f32(f32(Math.pow(2, q.varPeak)) * s.peakMul);
    this.rate2 = f32(SLIDE_K / f32(f32(Math.pow(2, q.varSlide)) * s.slideS));
    this.delay2 = Math.trunc(f32(f32(q.varPhase * q.varPhase) * 350));
    this.clickPh = f32(f32(Math.pow(q.clickCut, 0.125)) * 0.25 + 0.75);
    this.clickInc = f32(s.clickHz * INV_44100);
    this.clickAmt = f32(25 * s.clickPow5);
    // sample layer
    const st = f32(q.nStart + q.nStart), c1 = f32(st - 1), c2 = fma(st, c1, -c1), c3 = fma(st, c2, -c2);
    this.nDelay = f32(c3 * 4410);
    this.nPos = 0;
    this.nRate = Math.pow(2, q.nPitch * 4 - 2);
    this.nMix = f32(f32(q.nMix * q.nMix) * 2);
    const d2 = f32(q.nD * q.nD), d4 = f32(d2 * d2), d6 = f32(d2 * d4);
    this.nDecay = f32(1 / (d6 * 44100 + 44.1));
    this.nSus = q.nS;
    if (q.nA < f32(1e-4)) {
      this.nLevel = f32(0.99); this.nTarget = q.nS; this.nRateCur = this.nDecay;
    } else {
      const e2 = f32(q.nA * q.nA), e4 = f32(e2 * e2), e6 = f32(e2 * e4);
      const r = f32(f32(1 / e6) * INV_44100);
      this.nLevel = 0; this.nTarget = 1; this.nRateCur = r;
    }
    this.nF = f32(q.nFilter * q.nFilter);
    // output stage
    const dr = this.drive;
    let t = f32(0.5 / fma(dr, 0.5, 1));
    t = f32(t / fma(f32(t * t), dr, 1));
    const t3 = Math.abs(f32(f32(t * t) * t));
    this.s9 = f32(t / fma(t3, dr, 1));
    const s9_4 = f32(f32(this.s9 * this.s9) * f32(this.s9 * this.s9));
    this.s10 = fma(s9_4, dr, 1);
    this.setSub(0.5 + 6 * f32(q.sub));
    this.x1 = this.x2 = this.yy1 = this.yy2 = 0;
    this.silent = 0;
  }

  /** FL's sub-bass biquad (42 Hz at the host rate). */
  private setSub(qIn: number): void {
    const Q = f32(qIn);
    const w = f32((42 * 6.283185307179586) / this.s.sampleRate);
    const sn = f32(Math.sin(w)), cs = f32(Math.cos(w));
    const den = f32(sn + Q);
    const flush = (v: number) => (v < 1e-9 && v > -1e-9 ? 0 : v);
    this.fb0 = flush(f32(f32(cs + 1) / f32(f32(sn / Q) + 2)));
    this.fb1 = flush(f32((Q * -2 * cs) / den));
    this.fb2 = flush(f32(f32(Q - sn) / den));
  }

  /** One internal (44.1 kHz) sample. */
  private synth(noise: Noise | null): number {
    let s13 = 0;
    let nd = this.nDelay;
    if (!(nd > 0)) {
      // click
      let click = 0;
      const cp = this.clickPh;
      if (cp < 1) {
        click = f32(this.clickAmt * waveAt(this.s.wave, cp));
        this.clickPh = f32(cp + this.clickInc);
      }
      // main oscillator
      const e = f32(this.env - this.rate * this.env);
      const e4 = f32(f32(e * e) * f32(e * e));
      let fi = fma(f32(e4 * this.peak), this.inc, this.inc);
      fi = fi > 0 ? (fi < 0.5 ? fi : 0.5) : 0;
      let ph = f32(fi + this.ph);
      if (ph > 1) ph = f32(ph - 1);
      this.ph = ph; this.env = e;
      s13 = waveAt(this.s.wave, f32(ph + click));
      if (this.delay2 > 0) {
        this.delay2--;
      } else {
        const g = f32(this.env2 - this.rate2 * this.env2);
        const g4 = f32(f32(g * g) * f32(g * g));
        let gi = fma(f32(g4 * this.peak2), this.inc2, this.inc2);
        gi = gi > 0 ? (gi < 0.5 ? gi : 0.5) : 0;
        let p2 = f32(gi + this.ph2);
        if (p2 > 1) p2 = f32(p2 - 1);
        this.ph2 = p2; this.env2 = g;
        s13 = f32(waveAt(this.s.wave, f32(p2 + click)) + s13);
      }
    }
    // sample layer
    if (noise && !(nd < 0)) {
      const pos = this.nPos;
      const i = Math.floor(pos);
      const fr = f32(pos - Math.trunc(pos));
      let x = 0;
      if (i < noise.len) { const a = noise.data[i]; x = fma(f32(noise.data[i + 1] - a), fr, a); }
      this.nPos = pos + this.nRate * noise.rate;
      const f = this.nF;
      this.lp0 = fma(f32(x - this.lp0), f, this.lp0);
      this.lp1 = fma(f32(this.lp0 - this.lp1), f, this.lp1);
      this.lp2 = fma(f32(this.lp1 - this.lp2), f, this.lp2);
      this.lp3 = fma(f32(this.lp2 - this.lp3), f, this.lp3);
      let l = fma(f32(this.nTarget - this.nLevel), this.nRateCur, this.nLevel);
      this.nLevel = l;
      if (l > f32(0.99)) {
        l = f32(0.99);
        this.nLevel = l; this.nTarget = this.nSus; this.nRateCur = this.nDecay;
      }
      const l2 = f32(l * l), l4 = f32(l2 * l2), l8 = f32(l4 * l4), l16 = f32(l8 * l8);
      s13 = fma(l16, f32(this.nMix * this.lp3), s13);
    }
    // the noise delay counts toward 0 from either side
    if (nd < 0) { nd = f32(nd + 1); this.nDelay = nd >= 0 ? 0 : nd; }
    else if (nd > 0) { nd = f32(nd - 1); this.nDelay = nd > 0 ? nd : 0; }
    // amplitude: attack x smoothed duration envelope
    let shaped = 0, lvl = 0;
    const dec = this.durDec;
    if (!(dec >= 1)) {
      const s3 = this.durLevel;
      if (s3 > 0) {
        const x7 = f32(s3 * 7);
        shaped = f32(x7 / (x7 + 1));
        lvl = f32(s3 - dec);
      }
    }
    this.durLevel = lvl;
    const att = this.att;
    let out = f32(s13 * f32(att * att));
    this.durSmooth = fma(f32(shaped - this.durSmooth), f32(0.005), this.durSmooth);
    this.att = fma(f32(1 - att), this.attRate, att);
    out = f32(out * this.durSmooth);
    return out;
  }

  /** Add n frames (n <= STEP_MAX) at `step` internal samples per frame, gains gl / gr (FL's pan law x volume). */
  render(L: Float32Array, R: Float32Array, off: number, n: number, step: number, gl: number, gr: number): void {
    const noise = this.s.noise;
    const buf = this.buf;
    // FL's resampler: render the internal samples the next n outputs need
    const need = Math.trunc(this.pos + n * step) + 2;
    for (let k = this.fill; k < need; k++) buf[k] = this.synth(noise);
    this.fill = need;
    const dr = this.drive, s9 = this.s9, s10 = this.s10;
    const g = f32(f32(0.4) * this.gain);
    let pos = this.pos;
    for (let i = 0; i < n; i++) {
      const k = Math.trunc(pos);
      const fr = f32(pos - k);
      const a = buf[k];
      const x = fma(f32(buf[k + 1] - a), fr, a);
      pos += step;
      // drive stage
      const y1 = fma(f32(x - this.y1), f32(0.7), this.y1);
      this.y1 = y1;
      const d = f32(x - y1);
      let v = f32(d / fma(Math.abs(d), dr, 1));
      v = f32(v / fma(f32(v * v), dr, 1));
      v = f32(v / fma(Math.abs(f32(f32(v * v) * v)), dr, 1));
      const v4 = f32(f32(v * v) * f32(v * v));
      v = f32(f32(v * s10) / fma(f32(v4 * dr), s9, s9));
      v = f32(v + y1);
      // sub-bass biquad
      if (v < 1e-9 && v > -1e-9) v = 0;
      let y = f32(f32(f32(v - f32(this.x1 + this.x1)) + this.x2) * this.fb0 - fma(this.yy1, this.fb1, f32(this.yy2 * this.fb2)));
      if (y < 1e-9 && y > -1e-9) y = 0;
      this.x2 = this.x1; this.x1 = v; this.yy2 = this.yy1; this.yy1 = y;
      const o = f32(y * g);
      L[off + i] = fma(o, gl, L[off + i]);
      R[off + i] = fma(o, gr, R[off + i]);
      if (Math.abs(o) < f32(1e-5)) this.silent++; else this.silent = 0;
    }
    // keep the samples the next read needs
    const used = Math.trunc(pos);
    for (let k = used; k < this.fill; k++) buf[k - used] = buf[k];
    this.fill -= used;
    this.pos = pos - used;
  }
}

class BassDrum implements GenInstance {
  readonly sampleRate: number;
  readonly env: GenEnv;
  p: BdParams = {} as BdParams;
  levelGain = 1; baseHz = 21.1; peakMul = 6.4; slideS = 1.281; clickHz = 128; clickPow5 = 0;
  /** Sampling ratio 2^(4 v - 2) (internal samples per output sample: ratio x 44100 / rate). */
  ratioF = 1;
  readonly silentMax: number;
  noise: Noise | null = null;
  private noiseId = '';
  /** The oscillators' waveform: the built-in substitute or FL's own, imported (waveSample). */
  wave: Float32Array = BD_WAVE;
  private waveId = '';
  private readonly voice: BdVoice;
  /** The newest note: its levels drive the voice's gains and transposition. */
  private owner: GenNote | null = null;
  private ownerKey = 60;
  private readonly evFrame = new Int32Array(MAX_EVENTS);
  private readonly evNote: (GenNote | null)[] = new Array(MAX_EVENTS).fill(null);
  private evCount = 0;
  private readonly lr = { l: 0, r: 0 };

  constructor(sampleRate: number, env: GenEnv) {
    this.sampleRate = sampleRate;
    this.env = env;
    this.silentMax = Math.trunc(sampleRate * 0.023219954648526078);
    this.voice = new BdVoice(this);
    this.setParams({});
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    // FL's wrapper hands the engine control / 256
    const v = (key: string, d: number) => {
      const x = Number(q[key] ?? d);
      return f32(Number.isFinite(x) ? Math.max(0, Math.min(256, x)) / 256 : d / 256);
    };
    const p: BdParams = {
      level: v('level', 128), ratio: v('ratio', 128), dur: f32(0), sub: v('sub', 0), drive: v('drive', 0), attack: v('attack', 0),
      base: v('base', 25.6), peak: v('peak', 102.4), slide: v('slide', 102.4),
      varBase: 0, varPeak: 0, varSlide: 0, varPhase: v('varPhase', 0),
      clickCut: v('clickCut', 128), clickFreq: v('clickFreq', 128), clickAmt: v('clickAmt', 0),
      nA: v('noiseA', 0), nD: v('noiseD', 256), nS: v('noiseS', 256), nStart: v('noiseStart', 128),
      nPitch: v('noisePitch', 128), nMix: v('noiseMix', 0), nFilter: v('noiseFilter', 256),
    };
    const dur = v('duration', 128);
    p.dur = f32(f32(dur * dur) * dur);
    p.sub = f32(p.sub * p.sub);
    p.varBase = f32(f32(v('varBase', 128) * 2) - 1);
    p.varPeak = f32(f32(v('varPeak', 128) * 2) - 1);
    p.varSlide = f32(f32(v('varSlide', 128) * 2) - 1);
    this.p = p;
    this.levelGain = f32(Math.pow(10, f32(f32(p.level * 2) - 1)));
    this.baseHz = f32(Math.pow(2, f32(p.base * 4 + 4)));
    const pk = f32(p.peak * p.peak);
    this.peakMul = f32(pk * f32(100 * p.peak));
    const sl = f32(p.slide * p.slide);
    this.slideS = f32(f32(sl * p.slide) * 20 + 0.001);
    this.clickHz = f32(Math.pow(2, f32(p.clickFreq * 14)));
    const c = p.clickAmt, c2 = c * c;
    this.clickPow5 = f32(c * (c2 * c2));
    this.ratioF = f32(Math.pow(2, p.ratio * 4 - 2));
    // the sample layer's sample and FL's imported waveform (pool ids; they may arrive later)
    const id = typeof q.noiseSample === 'string' ? q.noiseSample : '';
    if (id !== this.noiseId) { this.noiseId = id; this.noise = null; this.loadNoise(); }
    const wid = typeof q.waveSample === 'string' ? q.waveSample : '';
    if (wid !== this.waveId) { this.waveId = wid; this.wave = BD_WAVE; this.loadWave(); }
  }

  private loadNoise(): void {
    const smp = this.noiseId ? this.env.sample(this.noiseId) : undefined;
    const ch = smp?.channels[0];
    if (!smp || !ch || !ch.length) return;
    const data = new Float32Array(ch.length + 1);
    data.set(ch);
    // FL's samples are 44.1 kHz and read 1 frame per internal sample; other rates keep their timing
    this.noise = { data, len: ch.length, rate: smp.sampleRate > 0 ? smp.sampleRate / 44100 : 1 };
  }

  /** FL's waveform imported from the user's FL install (BassDrum/sounddata: 1024 points). */
  private loadWave(): void {
    const w = this.waveId ? this.env.sample(this.waveId) : undefined;
    const ch = w?.channels[0];
    if (!ch || ch.length < 2) return;
    const t = new Float32Array(SIZE + 1);
    if (ch.length === SIZE) t.set(ch);
    else for (let k = 0; k < SIZE; k++) { const x = (k * ch.length) / SIZE, i = Math.floor(x), f = x - i; t[k] = ch[i] + f * (ch[(i + 1) % ch.length] - ch[i]); }
    t[SIZE] = t[0];
    this.wave = t;
  }

  noteOn(note: GenNote, frameOffset: number): void {
    if (this.evCount >= MAX_EVENTS) return;
    this.evFrame[this.evCount] = frameOffset;
    this.evNote[this.evCount++] = note;
  }

  /** No release stage (FL ignores note offs). */
  noteOff(): void {}

  /** Voice_Kill of the note that owns the voice: FL forgets its levels; the sound stops. */
  killNote(note: GenNote): void {
    for (let i = 0; i < this.evCount; i++) if (this.evNote[i] === note) this.evNote[i] = null;
    if (note === this.owner) { this.owner = null; this.voice.reset(); }
  }

  isActive(): boolean {
    return this.voice.active || this.evCount > 0;
  }

  /** The voice's MIDI velocity from the note's volume level, as FL's wrapper computes it. */
  private static velocityOf(n: GenNote): number {
    const v = Math.trunc(f32(f32(Math.log(fma(f32(n.init.vol), 10, 1))) * f32(41.714256)));
    return v < 0 ? 0 : v > 127 ? 127 : v;
  }

  /** Gains and resampling step from the owning note's levels (FL: once per Gen_Render). */
  private levels(): number {
    const o = this.owner;
    let ratio = this.ratioF;
    if (o) {
      computeLRVol(o.levels.pan, o.levels.vol, this.lr);
      const semis = f32((o.levels.pitch - 6000) * 0.01 + (60 - this.ownerKey));
      ratio = f32(f32(Math.pow(2, f32(semis * 0.083333336))) * ratio);
    } else { this.lr.l = this.lr.r = 0; }
    return (Math.min(4, Math.max(0.25, ratio)) * 44100) / this.sampleRate;
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    void ctx;
    if (this.noiseId && !this.noise) this.loadNoise();
    if (this.waveId && this.wave === BD_WAVE) this.loadWave();
    const v = this.voice;
    let step = this.levels();
    let e = 0, i = 0;
    while (i < n) {
      // note-ons at this frame: the newest retriggers the voice
      let started = false;
      while (e < this.evCount && this.evFrame[e] <= i) {
        const note = this.evNote[e++];
        if (!note) continue;
        this.owner = note;
        this.ownerKey = Math.min(127, Math.max(0, Math.trunc(note.key)));
        v.start(BassDrum.velocityOf(note));
        started = true;
      }
      if (started) step = this.levels();
      let end = n;
      if (e < this.evCount && this.evFrame[e] < end) end = Math.max(i + 1, this.evFrame[e]);
      if (end - i > STEP_MAX) end = i + STEP_MAX;
      if (v.active) v.render(L, R, i, end - i, step, this.lr.l, this.lr.r);
      i = end;
    }
    this.evCount = 0;
    // FL stops the voice after 1024 silent samples (checked once per block)
    if (v.active && v.silent > this.silentMax) { v.reset(); this.owner = null; }
  }

  allNotesOff(): void {
    this.evCount = 0;
    this.owner = null;
    this.voice.reset();
  }

  reset(): void {
    this.allNotesOff();
  }
}

export const gen: GenModule = {
  id: 'bassdrum',
  create: (sampleRate, _blockSize, env) => new BassDrum(sampleRate, env),
};
