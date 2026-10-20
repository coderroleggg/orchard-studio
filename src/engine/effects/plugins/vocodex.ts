// Vocodex (FL: Vocodex). Channel vocoder modelled on measurements of FL's
// plugin through the FL test host (see docs/research/fx/vocodex.md):
// - band k of n sits at the band-distribution level u_k = env(k/(n-1)) on FL's
//   frequency scale (vcxScaleHz); its octave width is
//   max(1/30, bandWidth% * local spacing * width envelope);
// - carrier bands: two RBJ band-pass sections, each width/(1 + flat/2) wide,
//   detuned by +-flat * sectionWidth / 2 (the flatness);
// - modulator detection: order-dependent sections (order 2 = the carrier
//   shape) centred at f_k * 2^(-pitch/1200), widened by the modulator width
//   multiplier m (gain m^-1/2);
// - envelope: peak with hold (or 2.25 x RMS over the hold window), one-pole
//   attack / release reaching 99% in the set time, MIN TIMES = hold >= 25 ms
//   (50 ms RMS window), attack >= 2 ms, release >= 3.6 ms;
// - band output = 69.65 / (width * sqrt(n)) * envelope * carrier band, with the
//   mapping envelopes (gain (9^y-1)/2, additive offset, linear pan law, noise
//   threshold, saturation, per-band hold/attack/release/width/pitch);
// - unison: n+1 modulator voices detuned across +-shift*1200 cents, panned;
// - mixer: wet (7^x-1)/6, modulator pass-through (4th-order high-pass) and
//   carrier pass-through (4th-order low-pass) at (11^x-1)/10, added uniform
//   noise (7^x-1)/6 high-passed, consonant / carrier contours;
// - soundgoodizer: (1-s) x + s * three-band maximizer, into a 3.47 ms
//   look-ahead limiter (FL's 153 samples at 44.1 kHz). The latency is reported
//   constantly so delay compensation never changes with the SG knob.
// The internal carrier synthesizer plays the latched keyboard notes (FL's
// tones are Sytrus patches; these are approximations). MIDI notes (a MIDI Out
// channel on the slot's MIDI input port) latch like FL's controller input: a
// note pressed while no other is held clears the chord, notes pressed while
// one is held join it, releases change nothing. They apply at their sample and
// are mirrored into the keyboard's state (takeStateChanges).

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import {
  VCX_ENV, VCX_TONES, vcxBandWidth, vcxCurve7, vcxCurve11, vcxCurveExp, vcxDefaultEnvelopes, vcxEnvAt, vcxFilterHz,
  vcxModBwMul, vcxScaleHz, vcxScaleU, vcxTime, type VcxPoint,
} from '../../../model/fx/plugins/vocodex';

const MAXB = 100;
const MAXV = 5;
const MAXS = 4; // detection sections
const LN100 = Math.log(100);
const HALF_LN2 = Math.LN2 / 2;
const G_NORM = 69.65;
const OFFSET_K = 0.1028;
const LOOKAHEAD_S = 153 / 44100;
const SMOOTH_S = 0.015;
const CHUNK = 32; // RMS window granularity (samples)
const MAXCHUNKS = 512;

interface P {
  wet: number; sg: number; modLvl: number; modHp: number; carLvl: number; carLp: number; noise: number; noiseHp: number;
  hold: number; att: number; attCurve: number; rel: number; relCurve: number; freeze: boolean;
  bw: number; flat: number; modBw: number; pitch: number; uniShift: number; uniPan: number;
  bands: number; order: number; unison: number; holdMode: number; minTimes: boolean; lr: boolean;
  contToMod: boolean; contToNoise: boolean; contFromCar: boolean; contFromCons: boolean;
  modIn: number; carIn: number; envs: VcxPoint[][]; pitchFollow: boolean[]; tone: number; notes: number[];
  subDenoise: boolean; detectReq: number;
}

function n(v: unknown, d: number, lo = -Infinity, hi = Infinity): number {
  const x = typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d;
  return Math.min(hi, Math.max(lo, x));
}
function b(v: unknown, d: boolean): boolean {
  return typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : d;
}

function readParams(raw: unknown): P {
  const q = (raw ?? {}) as Record<string, unknown>;
  const defEnv = vcxDefaultEnvelopes();
  const envsIn = Array.isArray(q.envs) ? (q.envs as unknown[]) : [];
  const envs = defEnv.map((d, i) => {
    const e = envsIn[i];
    if (!Array.isArray(e) || e.length === 0) return d;
    const out: VcxPoint[] = [];
    let px = 0;
    for (const p of e as unknown[]) {
      if (!Array.isArray(p)) continue;
      const x = Math.min(1, Math.max(px, n(p[0], 0)));
      out.push([x, n(p[1], 0, 0, 1), n(p[2], 0, -1, 1)]);
      px = x;
    }
    return out.length ? out : d;
  });
  const pf = Array.isArray(q.pitchFollow) ? (q.pitchFollow as unknown[]) : [];
  return {
    wet: n(q.wet, 1000, 0, 2000), sg: n(q.sg, 150, 0, 1000), modLvl: n(q.modLvl, 12800, 0, 16000), modHp: n(q.modHp, 55000, 0, 65536),
    carLvl: n(q.carLvl, 0, 0, 16000), carLp: n(q.carLp, 28000, 0, 65536), noise: n(q.noise, 0, 0, 12800), noiseHp: n(q.noiseHp, 55000, 0, 65536),
    hold: n(q.hold, 1666, 0, 10000), att: n(q.att, 1115, 0, 10000), attCurve: n(q.attCurve, 0, 0, 2000), rel: n(q.rel, 3500, 0, 10000),
    relCurve: n(q.relCurve, 0, 0, 2000), freeze: n(q.freeze, 0) >= 0.5,
    bw: n(q.bw, 349, 5, 1000), flat: n(q.flat, 100, 0, 100), modBw: n(q.modBw, 2000, 0, 4000), pitch: n(q.pitch, 0, -1200, 1200),
    uniShift: n(q.uniShift, 250, 0, 1000), uniPan: n(q.uniPan, 128, -256, 256),
    bands: Math.round(n(q.bands, 47, 5, MAXB)), order: Math.round(n(q.order, 2, 1, 4)), unison: Math.round(n(q.unison, 0, 0, 4)),
    holdMode: Math.round(n(q.holdMode, 0, 0, 1)), minTimes: b(q.minTimes, true), lr: b(q.lr, false),
    contToMod: b(q.contToMod, true), contToNoise: b(q.contToNoise, true), contFromCar: b(q.contFromCar, false), contFromCons: b(q.contFromCons, true),
    modIn: Math.round(n(q.modIn, 1, -1, 64)), carIn: Math.round(n(q.carIn, 0, -1, 64)),
    envs, pitchFollow: defEnv.map((_, i) => (typeof pf[i] === 'boolean' ? (pf[i] as boolean) : i === 3 || i === 4)),
    tone: Math.round(n(q.tone, 0, 0, VCX_TONES.length - 1)),
    notes: Array.isArray(q.notes) ? (q.notes as unknown[]).filter((x): x is number => typeof x === 'number' && x >= 0 && x < 128).slice(0, 16) : [60],
    subDenoise: b(q.subDenoise, false), detectReq: n(q.detectReq, 0),
  };
}

/** SVF band-pass coefficients (constant 0 dB peak) for f Hz and an RBJ octave width. */
function svfBp(f: number, oct: number, sr: number, out: Float64Array, o: number): void {
  const fc = Math.min(Math.max(f, 5), sr * 0.4999);
  const w0 = (2 * Math.PI * fc) / sr;
  let k = 2 * Math.sinh(HALF_LN2 * Math.max(oct, 1e-4) * (w0 / Math.sin(w0)));
  if (!(k > 1e-5)) k = 1e-5;
  if (k > 20) k = 20;
  const g = Math.tan(w0 / 2);
  const a1 = 1 / (1 + g * (g + k));
  out[o] = a1; out[o + 1] = g * a1; out[o + 2] = g * g * a1; out[o + 3] = k;
}

/** Flush denormal / non-finite filter state to zero. */
function flush30(x: number): number {
  return (x > 1e-30 || x < -1e-30) && x - x === 0 ? x : 0;
}

/** Magnitude of an SVF band-pass section (coefs at c[o..o+3]) at f Hz. */
function svfMag(c: Float64Array, o: number, f: number, sr: number): number {
  const a1 = c[o], a2 = c[o + 1], k = c[o + 3];
  const g = a2 / a1; // a2 = g * a1
  const w = Math.tan((Math.PI * Math.min(f, sr * 0.4999)) / sr) / g;
  // H(s) = k s / (s^2 + k s + 1) at s = j w
  const re = 1 - w * w, im = k * w;
  return (k * w) / Math.sqrt(re * re + im * im);
}

/** Biquad (TDF2) Butterworth high/low-pass section coefficients. */
function butter2(f: number, q: number, sr: number, high: boolean, c: Float64Array, o: number): void {
  const w0 = (2 * Math.PI * Math.min(Math.max(f, 5), sr * 0.49)) / sr;
  const cw = Math.cos(w0), al = Math.sin(w0) / (2 * q), a0 = 1 + al;
  const b1 = high ? -(1 + cw) : 1 - cw;
  const b0 = high ? (1 + cw) / 2 : (1 - cw) / 2;
  c[o] = b0 / a0; c[o + 1] = b1 / a0; c[o + 2] = b0 / a0; c[o + 3] = (-2 * cw) / a0; c[o + 4] = (1 - al) / a0;
}

/** In-place biquad over buf[0..len) with state s[so], s[so+1]. */
function biq(buf: Float64Array, len: number, c: Float64Array, co: number, s: Float64Array, so: number): void {
  const b0 = c[co], b1 = c[co + 1], b2 = c[co + 2], a1 = c[co + 3], a2 = c[co + 4];
  let z1 = s[so], z2 = s[so + 1];
  for (let i = 0; i < len; i++) {
    const x = buf[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    buf[i] = y;
  }
  s[so] = z1 > 1e-30 || z1 < -1e-30 ? z1 : 0;
  s[so + 1] = z2 > 1e-30 || z2 < -1e-30 ? z2 : 0;
}

const Q4A = 0.5411961, Q4B = 1.3065630; // 4th-order Butterworth sections

// detection filter per order: [n sections, width factor at flat 0, at flat 1, stagger step / section width at flat 1, centre gains at flat 0 / .5 / 1]
const DET: [number, number, number, number, number, number, number][] = [
  [0, 0, 0, 0, 0, 0, 0],
  [1, 0.5, 0.5, 0, 1, 1, 1],
  [2, 1, 2 / 3, 1, 1, 1, 1],
  [3, 0.945, 0.659, 0.9, 1.777, 0.9995, 0.636],
  [4, 1.173, 0.735, 0.827, 3.998, 1.158, 0.699],
];

// unison voice pans (fraction of the panning knob), by voice count
const EMPTY_SC: { source: number; L: Float32Array; R: Float32Array }[] = [];
const SG_GAINS = [6.27, 2.03, 6.89];
const SG_THR = [-10, -5, -17];
const SG_RATIO = [1.6, 2, 1.6];
/** Per-stage time factor so a cascade of n one-poles reaches 99% in the set time. */
const CASCADE_X = [0, Math.log(100), 6.638352, 8.405667, 10.045118];

const UNI_PAN: number[][] = [[0], [0], [-1, 1], [1, -1, 0], [0.15, -1, 1, -0.15], [-0.3, -1, 0.3, 1, 0]];

// ---------------- internal carrier synthesizer ----------------

interface ToneDef { osc: number; voices: number; detune: number; sub: number; pw: number; fx: number; rate: number; depth: number; drive: number }
// osc: 0 saw, 1 pulse, 2 square, 3 organ, 4 fm, 5 triangle; fx: 0 none, 1 vibrato, 2 flanger, 3 phaser, 4 chorus, 5 pwm, 6 am, 7 autopan, 8 ring
const TONE_DEFS: Record<string, ToneDef> = {
  'Bright': { osc: 0, voices: 2, detune: 12, sub: 0, pw: 0.5, fx: 4, rate: 0.6, depth: 0.3, drive: 0 },
  'Car horn': { osc: 2, voices: 2, detune: 400, sub: 0, pw: 0.5, fx: 0, rate: 0, depth: 0, drive: 0.4 },
  'Chip': { osc: 1, voices: 1, detune: 0, sub: 0, pw: 0.25, fx: 0, rate: 0, depth: 0, drive: 0 },
  'Elderly': { osc: 0, voices: 1, detune: 0, sub: 0, pw: 0.5, fx: 1, rate: 5.5, depth: 35, drive: 0 },
  'Ensemble': { osc: 0, voices: 3, detune: 14, sub: 0, pw: 0.5, fx: 4, rate: 0.8, depth: 0.5, drive: 0 },
  'Flanged pulse': { osc: 1, voices: 1, detune: 0, sub: 0, pw: 0.3, fx: 2, rate: 0.25, depth: 0.8, drive: 0 },
  'Flanged saw': { osc: 0, voices: 1, detune: 0, sub: 0, pw: 0.5, fx: 2, rate: 0.25, depth: 0.8, drive: 0 },
  'Gargling': { osc: 0, voices: 1, detune: 0, sub: 0, pw: 0.5, fx: 6, rate: 11, depth: 0.7, drive: 0 },
  'Growling': { osc: 0, voices: 2, detune: 8, sub: 1, pw: 0.5, fx: 5, rate: 2.2, depth: 0.35, drive: 0.3 },
  'Harsh': { osc: 0, voices: 1, detune: 0, sub: 0, pw: 0.5, fx: 0, rate: 0, depth: 0, drive: 0.9 },
  'Machine': { osc: 1, voices: 1, detune: 0, sub: 0, pw: 0.4, fx: 8, rate: 2.5, depth: 0.6, drive: 0 },
  'Machine 2': { osc: 2, voices: 1, detune: 0, sub: 0, pw: 0.5, fx: 8, rate: 1.5, depth: 0.6, drive: 0 },
  'Organ': { osc: 3, voices: 1, detune: 0, sub: 0, pw: 0.5, fx: 4, rate: 6, depth: 0.15, drive: 0 },
  'Panner': { osc: 0, voices: 1, detune: 0, sub: 0, pw: 0.5, fx: 7, rate: 2, depth: 0.8, drive: 0 },
  'Phased': { osc: 0, voices: 2, detune: 7, sub: 0, pw: 0.5, fx: 3, rate: 0.3, depth: 0.9, drive: 0 },
  'Phased 2': { osc: 1, voices: 1, detune: 0, sub: 0, pw: 0.35, fx: 3, rate: 0.5, depth: 0.9, drive: 0 },
  'Power': { osc: 0, voices: 2, detune: 700, sub: 1, pw: 0.5, fx: 0, rate: 0, depth: 0, drive: 0.2 },
  'Pulse': { osc: 1, voices: 1, detune: 0, sub: 0, pw: 0.25, fx: 0, rate: 0, depth: 0, drive: 0 },
  'PWM': { osc: 1, voices: 1, detune: 0, sub: 0, pw: 0.5, fx: 5, rate: 0.8, depth: 0.4, drive: 0 },
  'Robot saw': { osc: 0, voices: 1, detune: 0, sub: 0, pw: 0.5, fx: 6, rate: 8, depth: 0.25, drive: 0.5 },
  'Saw': { osc: 0, voices: 1, detune: 0, sub: 0, pw: 0.5, fx: 0, rate: 0, depth: 0, drive: 0 },
  'Scythe': { osc: 0, voices: 2, detune: 1200, sub: 0, pw: 0.5, fx: 2, rate: 0.12, depth: 0.5, drive: 0.6 },
  'Supersaw': { osc: 0, voices: 7, detune: 22, sub: 0, pw: 0.5, fx: 0, rate: 0, depth: 0, drive: 0 },
  'Tube': { osc: 2, voices: 1, detune: 0, sub: 0, pw: 0.5, fx: 0, rate: 0, depth: 0, drive: 0.8 },
  'Weird': { osc: 4, voices: 1, detune: 0, sub: 0, pw: 0.5, fx: 1, rate: 3.3, depth: 60, drive: 0 },
};

function polyblep(t: number, dt: number): number {
  if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
  if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
  return 0;
}

class CarrierSynth {
  private readonly sr: number;
  private phase = new Float64Array(16 * 8);
  private sub = new Float64Array(16);
  private lfo = 0;
  private gain = 0;
  private fxBuf: Float32Array;
  private fxPos = 0;
  private ap = new Float64Array(12);
  constructor(sr: number) {
    this.sr = sr;
    this.fxBuf = new Float32Array(Math.ceil(sr * 0.03) + 4);
    for (let i = 0; i < this.phase.length; i++) this.phase[i] = (i * 0.618034) % 1;
  }
  reset(): void { this.gain = 0; this.lfo = 0; this.fxBuf.fill(0); this.ap.fill(0); }
  /** Adds the synth to L/R (len samples). */
  render(tone: number, notes: number[], L: Float64Array, R: Float64Array, len: number): void {
    const name = VCX_TONES[tone];
    const d = name ? TONE_DEFS[name] : undefined;
    const target = d && notes.length ? 1 : 0;
    if (!d) { this.gain = 0; return; }
    const sr = this.sr;
    const nn = Math.min(16, notes.length);
    const amp = 0.28 / Math.sqrt(Math.max(1, nn)) / Math.sqrt(d.voices);
    const lfoInc = d.rate / sr;
    const gStep = 1 / (0.01 * sr);
    for (let i = 0; i < len; i++) {
      this.gain += target > this.gain ? Math.min(gStep, target - this.gain) : Math.max(-gStep, target - this.gain);
      if (this.gain <= 0 && target === 0) continue;
      this.lfo += lfoInc; if (this.lfo >= 1) this.lfo -= 1;
      const ls = Math.sin(2 * Math.PI * this.lfo);
      const vib = d.fx === 1 ? Math.pow(2, (ls * d.depth) / 1200) : 1;
      const pw = d.fx === 5 ? Math.min(0.95, Math.max(0.05, d.pw + ls * d.depth)) : d.pw;
      let sl = 0, srr = 0;
      for (let k = 0; k < nn; k++) {
        const f0 = 440 * Math.pow(2, (notes[k] - 69) / 12) * vib;
        for (let v = 0; v < d.voices; v++) {
          const det = d.voices > 1 ? (v / (d.voices - 1) - 0.5) * 2 : 0;
          const f = d.detune >= 300 ? (v === 0 ? f0 : f0 * Math.pow(2, d.detune / 1200)) : f0 * Math.pow(2, (det * d.detune) / 1200);
          const dt = Math.min(0.45, f / sr);
          const idx = k * 8 + v;
          let t = this.phase[idx] + dt;
          if (t >= 1) t -= 1;
          this.phase[idx] = t;
          let s: number;
          switch (d.osc) {
            case 0: s = 2 * t - 1 - polyblep(t, dt); break;
            case 1: case 2: {
              const w = d.osc === 2 ? 0.5 : pw;
              let t2 = t + (1 - w); if (t2 >= 1) t2 -= 1;
              s = (t < w ? 1 : -1) + polyblep(t, dt) - polyblep(t2, dt);
              break;
            }
            case 3: s = 0.5 * Math.sin(2 * Math.PI * t) + 0.35 * Math.sin(4 * Math.PI * t) + 0.25 * Math.sin(6 * Math.PI * t) + 0.18 * Math.sin(8 * Math.PI * t) + 0.12 * Math.sin(12 * Math.PI * t); break;
            case 4: s = Math.sin(2 * Math.PI * t + 2.2 * Math.sin(2 * Math.PI * ((t * 3.5) % 1))); break;
            default: s = 4 * Math.abs(t - 0.5) - 1;
          }
          const pan = d.voices > 1 ? det * 0.6 : 0;
          sl += s * (1 - pan) * 0.5; srr += s * (1 + pan) * 0.5;
        }
        if (d.sub) {
          let t = this.sub[k] + Math.min(0.45, (f0Sub(notes[k], vib)) / sr);
          if (t >= 1) t -= 1;
          this.sub[k] = t;
          const s = t < 0.5 ? 0.6 : -0.6;
          sl += s * 0.5; srr += s * 0.5;
        }
      }
      let l = sl * amp, r = srr * amp;
      if (d.drive > 0) { const k = 1 + 6 * d.drive; l = Math.tanh(l * k) / Math.tanh(k * 0.5) * 0.5; r = Math.tanh(r * k) / Math.tanh(k * 0.5) * 0.5; }
      switch (d.fx) {
        case 2: { // flanger
          const dly = (0.001 + 0.004 * (0.5 + 0.5 * ls * d.depth)) * sr;
          const N = this.fxBuf.length;
          this.fxBuf[this.fxPos] = (l + r) * 0.5;
          let rp = this.fxPos - dly; while (rp < 0) rp += N;
          const i0 = Math.floor(rp), fr = rp - i0;
          const dv = this.fxBuf[i0 % N] * (1 - fr) + this.fxBuf[(i0 + 1) % N] * fr;
          this.fxPos = (this.fxPos + 1) % N;
          l = (l + dv * 0.8) * 0.7; r = (r + dv * 0.8) * 0.7;
          break;
        }
        case 3: { // phaser: 6 first-order allpasses
          const fc = 300 * Math.pow(12, 0.5 + 0.5 * ls * d.depth);
          const tn = Math.tan((Math.PI * Math.min(fc, sr * 0.45)) / sr);
          const a = (tn - 1) / (tn + 1);
          let x = (l + r) * 0.5;
          for (let k = 0; k < 6; k++) { const y = a * x + this.ap[k]; this.ap[k] = x - a * y; x = y; }
          l = (l + x) * 0.6; r = (r + x) * 0.6;
          break;
        }
        case 4: { // chorus
          const dly = (0.008 + 0.006 * (0.5 + 0.5 * ls * d.depth)) * sr;
          const N = this.fxBuf.length;
          this.fxBuf[this.fxPos] = (l + r) * 0.5;
          let rp = this.fxPos - dly; while (rp < 0) rp += N;
          const i0 = Math.floor(rp), fr = rp - i0;
          const dv = this.fxBuf[i0 % N] * (1 - fr) + this.fxBuf[(i0 + 1) % N] * fr;
          this.fxPos = (this.fxPos + 1) % N;
          l = (l + dv * 0.6) * 0.75; r = (r - dv * 0.6) * 0.75;
          break;
        }
        case 6: { const m = 1 - d.depth * (0.5 + 0.5 * ls); l *= m; r *= m; break; }
        case 7: { const p = ls * d.depth; l *= 1 - p * 0.5; r *= 1 + p * 0.5; break; }
        case 8: { const m = (1 - d.depth) + d.depth * Math.sin(2 * Math.PI * this.lfo * 40); l *= m; r *= m; break; }
      }
      L[i] += l * this.gain;
      R[i] += r * this.gain;
    }
  }
}

function f0Sub(note: number, vib: number): number {
  return 220 * Math.pow(2, (note - 69) / 12) * vib;
}

// ---------------- the vocoder ----------------

/** Note events queued for the next process() call. */
const EVQ = 256;

class Vocodex implements EffectInstance {
  latency: number;
  tail = 2;
  // ---- carrier notes: the keyboard's latched notes, also played by MIDI ----
  /** The notes the carrier synth plays. */
  private notes: number[] = [];
  /** params.notes as last received (a new value from the editor replaces the latched notes). */
  private paramNotesKey = '';
  /** MIDI keys held down right now. */
  private readonly down = new Uint8Array(128);
  private nDown = 0;
  private notesChanged = false;
  private readonly evFrame = new Int32Array(EVQ);
  private readonly evKey = new Int16Array(EVQ);
  private readonly evOn = new Uint8Array(EVQ);
  private nEv = 0;

  private readonly sr: number;
  private readonly bs: number;
  private p: P = readParams({});
  private configured = false;
  private nB = 47; private order = 2; private nV = 1;
  // smoothed continuous parameters
  private sBw = 349; private sFlat = 100; private sModBw = 2000; private sPitch = 0; private sUni = 250;
  private dirty = true;
  // band layout
  private readonly fB = new Float64Array(MAXB);
  private readonly uB = new Float64Array(MAXB);
  private readonly bwB = new Float64Array(MAXB);
  private readonly gNorm = new Float64Array(MAXB);
  // per band mapping values
  private readonly mGain = new Float64Array(MAXB);
  private readonly mOff = new Float64Array(MAXB);
  private readonly mPan = new Float64Array(MAXB);
  private readonly mThr = new Float64Array(MAXB);
  private readonly mPass = new Float64Array(MAXB);
  private readonly mHold = new Float64Array(MAXB);
  private readonly mAtt = new Float64Array(MAXB);
  private readonly mRel = new Float64Array(MAXB);
  private readonly mSatMix = new Float64Array(MAXB);
  private satCurve: VcxPoint[] = [[0, 0, 0], [1, 1, 0]];
  private satIdentity = true;
  // carrier filters: band * 2 sections * 4 coefs
  private readonly cc = new Float64Array(MAXB * 2 * 4);
  private readonly cs = new Float64Array(MAXB * 2 * 2 * 2); // band, section, channel, state(2)
  // detection filters: (voice * MAXB + band) * MAXS sections
  private readonly dc = new Float64Array(MAXV * MAXB * MAXS * 4);
  private readonly ds = new Float64Array(MAXV * MAXB * MAXS * 2);
  private readonly dGain = new Float64Array(MAXV * MAXB);
  private nSec = 2;
  // envelope followers per voice-band
  private readonly peak = new Float64Array(MAXV * MAXB);
  private readonly holdCnt = new Int32Array(MAXV * MAXB);
  /** Follower cascade states (up to 4 one-poles per voice-band; curves 1..4 use 1..4 stages). */
  private readonly es = new Float64Array(MAXV * MAXB * 4);
  private readonly rmsSum = new Float64Array(MAXV * MAXB);
  private readonly rmsPart = new Float64Array(MAXV * MAXB);
  private readonly rmsRing: Float32Array;
  private rmsPos = 0; private rmsCnt = 0; private rmsW = 1;
  private readonly envOut = new Float64Array(MAXV * MAXB);
  private readonly envPeak = new Float32Array(MAXB);
  private readonly voicePanL = new Float64Array(MAXV);
  private readonly voicePanR = new Float64Array(MAXV);
  private readonly voiceW = new Float64Array(MAXV);
  // band gains reached at the end of the last block (L / R) and targets
  private readonly gL = new Float64Array(MAXB); private readonly gR = new Float64Array(MAXB);
  private readonly tL = new Float64Array(MAXB); private readonly tR = new Float64Array(MAXB);
  // filters for the mixer section
  private readonly hpC = new Float64Array(10); private readonly hpS = new Float64Array(8);
  private readonly lpC = new Float64Array(10); private readonly lpS = new Float64Array(8);
  private readonly nzC = new Float64Array(5); private readonly nzS = new Float64Array(4);
  private readonly consC = new Float64Array(5); private readonly consS = new Float64Array(2);
  private consEnvHp = 0; private consEnvAll = 0; private carEnv = 0; private contour = 0;
  private noiseSeed = 22222;
  // smoothed mixer gains
  private wetG = 1; private modG = 0; private carG = 0; private noiseG = 0; private sgS = 0;
  // soundgoodizer
  private readonly sgC = new Float64Array(25); // crossover sections: LP 200, HP 200, LP 3k, HP 3k, allpass 3k
  private readonly sgS2 = new Float64Array(2 * 24 + 4);
  private readonly sgEnv = new Float64Array(6);
  private readonly sgGain = new Float64Array(6).fill(1);
  private sgTick = 0;
  private readonly dlyL: Float32Array; private readonly dlyR: Float32Array;
  private dlyPos = 0; private readonly dlyLen: number;
  private limGain = 1;
  private readonly peakBuf: Float32Array; private peakPos = 0;
  // synth
  private readonly synth: CarrierSynth;
  // noise detection
  private detectSeq = 0; private detectLeft = 0; private readonly detectAcc = new Float64Array(MAXB); private detectN = 0;
  private noiseProfile: Float32Array | null = null; private noiseProfileSeq = 0;
  // meters
  private mMod = 0; private mCar = 0; private mOut = 0;
  // scratch
  private readonly modL: Float64Array; private readonly modR: Float64Array;
  private readonly carL: Float64Array; private readonly carR: Float64Array;
  private readonly modM: Float64Array;
  private readonly tmp: Float64Array; private readonly tmp2: Float64Array; private readonly envB: Float64Array;
  private readonly outL: Float64Array; private readonly outR: Float64Array;
  private readonly passB: Float64Array;
  private readonly monBands = new Float32Array(MAXB);
  private readonly monFreqs = new Float32Array(MAXB);

  constructor(sr: number, bs: number) {
    this.sr = sr;
    this.bs = Math.max(1, bs);
    this.latency = Math.round(LOOKAHEAD_S * sr);
    this.dlyLen = this.latency + 1;
    this.dlyL = new Float32Array(this.dlyLen);
    this.dlyR = new Float32Array(this.dlyLen);
    this.peakBuf = new Float32Array(this.dlyLen);
    this.rmsRing = new Float32Array(MAXV * MAXB * MAXCHUNKS);
    const m = this.bs;
    this.modL = new Float64Array(m); this.modR = new Float64Array(m); this.carL = new Float64Array(m); this.carR = new Float64Array(m);
    this.modM = new Float64Array(m); this.tmp = new Float64Array(m); this.tmp2 = new Float64Array(m); this.envB = new Float64Array(m);
    this.outL = new Float64Array(m); this.outR = new Float64Array(m); this.passB = new Float64Array(m);
    this.synth = new CarrierSynth(sr);
    butter2(9920, Math.SQRT1_2, sr, true, this.consC, 0);
    // soundgoodizer crossovers at 200 Hz and 2.8 kHz (Linkwitz-Riley 4th order)
    butter2(200, Math.SQRT1_2, sr, false, this.sgC, 0);
    butter2(200, Math.SQRT1_2, sr, true, this.sgC, 5);
    butter2(3000, Math.SQRT1_2, sr, false, this.sgC, 10);
    butter2(3000, Math.SQRT1_2, sr, true, this.sgC, 15);
    {
      // RBJ allpass at 3 kHz, Q = 0.7071 (the Linkwitz-Riley sum)
      const w0 = (2 * Math.PI * 3000) / sr, al = Math.sin(w0) / (2 * Math.SQRT1_2), a0 = 1 + al, cw = Math.cos(w0);
      const c = this.sgC;
      c[20] = (1 - al) / a0; c[21] = (-2 * cw) / a0; c[22] = 1; c[23] = (-2 * cw) / a0; c[24] = (1 - al) / a0;
      c[22] = (1 + al) / a0;
    }
  }

  setParams(raw: unknown): void {
    const q = readParams(raw);
    const prev = this.p;
    this.p = q;
    const key = q.notes.join(',');
    if (key !== this.paramNotesKey) {
      // the keyboard was edited (or MIDI latched notes came back from the project): play these
      this.paramNotesKey = key;
      this.notes = q.notes.slice();
    }
    const structural = !this.configured || q.bands !== this.nB || q.order !== this.order || q.unison + 1 !== this.nV;
    if (structural) {
      this.nB = q.bands; this.order = q.order; this.nV = q.unison > 0 ? q.unison + 1 : 1;
      if (!this.configured) { this.snap(); this.configured = true; }
      this.resetBands();
    }
    if (q.detectReq !== prev.detectReq && this.configured && q.detectReq > 0) {
      this.detectLeft = Math.round(2 * this.sr); this.detectAcc.fill(0); this.detectN = 0; this.detectSeq = q.detectReq;
    }
    this.computeLayout();
    this.computeMapping();
    this.computeVoices();
    this.dirty = true;
    this.computeFilters();
    this.updateMixerFilters();
    this.updateTail();
  }

  private snap(): void {
    const q = this.p;
    this.sBw = q.bw; this.sFlat = q.flat; this.sModBw = q.modBw; this.sPitch = q.pitch; this.sUni = q.uniShift;
    this.wetG = vcxCurve7(q.wet / 1000); this.modG = vcxCurve11(q.modLvl / 12800); this.carG = vcxCurve11(q.carLvl / 12800);
    this.noiseG = vcxCurve7(q.noise / 12800); this.sgS = q.sg / 1000;
  }

  private resetBands(): void {
    this.cs.fill(0); this.ds.fill(0); this.peak.fill(0); this.holdCnt.fill(0); this.es.fill(0);
    this.rmsSum.fill(0); this.rmsPart.fill(0); this.rmsRing.fill(0); this.rmsPos = 0; this.rmsCnt = 0;
    this.envOut.fill(0); this.gL.fill(0); this.gR.fill(0);
  }

  reset(): void {
    this.resetBands();
    this.hpS.fill(0); this.lpS.fill(0); this.nzS.fill(0); this.consS.fill(0); this.sgS2.fill(0); this.sgEnv.fill(0);
    this.dlyL.fill(0); this.dlyR.fill(0); this.peakBuf.fill(0); this.limGain = 1;
    this.consEnvAll = this.consEnvHp = this.carEnv = this.contour = 0;
    this.synth.reset();
    this.snap();
    this.computeFilters();
    this.dirty = false;
  }

  private computeLayout(): void {
    const N = this.nB, env = this.p.envs[VCX_ENV.distribution];
    for (let k = 0; k < N; k++) {
      const u = vcxEnvAt(env, N > 1 ? k / (N - 1) : 0.5);
      this.uB[k] = u;
      this.fB[k] = Math.min(vcxScaleHz(u), this.sr * 0.49);
    }
  }

  private computeMapping(): void {
    const N = this.nB, e = this.p.envs, pf = this.p.pitchFollow;
    const shiftU = (k: number, i: number) => (pf[i] ? vcxScaleU(this.fB[k] * Math.pow(2, -this.p.pitch / 1200)) : this.uB[k]);
    for (let k = 0; k < N; k++) {
      const gy = vcxEnvAt(e[VCX_ENV.gain], shiftU(k, 0));
      this.mGain[k] = (Math.pow(9, gy) - 1) / 2;
      const oy = vcxEnvAt(e[VCX_ENV.offset], shiftU(k, 2));
      const d = Math.min(1, 2 * Math.abs(oy - 0.5));
      this.mOff[k] = (oy < 0.5 ? -1 : 1) * OFFSET_K * Math.max(0, Math.pow(10, 3 * (d - 1)) - 1e-3);
      this.mPan[k] = 2 * vcxEnvAt(e[VCX_ENV.pan], shiftU(k, 1)) - 1;
      const ny = 2 * vcxEnvAt(e[VCX_ENV.noise], shiftU(k, 3)) - 1;
      this.mThr[k] = ny <= 0 ? 0 : Math.pow(10, (ny - 1) * 4.5);
      const py = vcxEnvAt(e[VCX_ENV.modPass], shiftU(k, 4));
      this.mPass[k] = (Math.pow(9, py) - 1) / 2;
      this.mHold[k] = Math.pow(8, 2 * vcxEnvAt(e[VCX_ENV.hold], shiftU(k, 5)) - 1);
      this.mAtt[k] = Math.pow(8, 2 * vcxEnvAt(e[VCX_ENV.attack], shiftU(k, 6)) - 1);
      this.mRel[k] = Math.pow(8, 2 * vcxEnvAt(e[VCX_ENV.release], shiftU(k, 7)) - 1);
      this.mSatMix[k] = vcxEnvAt(e[VCX_ENV.satMix], shiftU(k, 11));
    }
    this.satCurve = e[VCX_ENV.satCurve];
    this.satIdentity = this.satCurve.length === 2 && this.satCurve[0][1] === 0 && this.satCurve[1][1] === 1 && this.satCurve[0][0] === 0 && this.satCurve[1][0] === 1;
  }

  private computeVoices(): void {
    const V = this.nV;
    const pans = UNI_PAN[Math.min(5, V)];
    const amt = this.p.uniPan / 256;
    const w = V > 1 ? (0.75 / Math.sqrt(V)) * Math.pow(2 / V, 0.55) : 1;
    for (let v = 0; v < V; v++) {
      const pn = Math.max(-1, Math.min(1, (pans[v] ?? 0) * amt));
      this.voicePanL[v] = Math.min(1, 1 - pn);
      this.voicePanR[v] = Math.min(1, 1 + pn);
      this.voiceW[v] = w;
    }
  }

  /** Band filters from the smoothed parameters. */
  private computeFilters(): void {
    const N = this.nB, sr = this.sr, q = this.p;
    const pct = vcxBandWidth(this.sBw);
    const phi = this.sFlat / 100;
    const m = vcxModBwMul(this.sModBw);
    const det = DET[this.order];
    this.nSec = det[0];
    const detW = det[1] + (det[2] - det[1]) * phi;
    const detStep = det[3] * phi;
    const g0 = phi <= 0.5 ? det[4] + (det[5] - det[4]) * (phi / 0.5) : det[5] + (det[6] - det[5]) * ((phi - 0.5) / 0.5);
    // order 2: FL's 2^flat make-up; orders 3 / 4: level corrections fitted on broadband material at full flatness
    const fit = this.order === 3 ? 1 + 0.48 * phi : this.order === 4 ? 1 + 0.7 * phi : 1;
    const detGain = (g0 / Math.sqrt(m)) * (this.order === 2 ? Math.pow(2, phi) : fit);
    const wEnv = q.envs[VCX_ENV.width], pEnv = q.envs[VCX_ENV.pitch];
    const V = this.nV;
    const uniCents = (this.sUni / 1000) * 1200;
    const sqrtN = Math.sqrt(N);
    for (let k = 0; k < N; k++) {
      const f = this.fB[k];
      const lo = k > 0 ? this.fB[k - 1] : f, hi = k < N - 1 ? this.fB[k + 1] : f;
      let sp = Math.abs(Math.log2(Math.max(hi, 1) / Math.max(lo, 1))) / (k > 0 && k < N - 1 ? 2 : 1);
      if (!Number.isFinite(sp)) sp = 0;
      const wm = Math.pow(8, 2 * vcxEnvAt(wEnv, q.pitchFollow[9] ? vcxScaleU(f * Math.pow(2, -this.sPitch / 1200)) : this.uB[k]) - 1);
      const bw = Math.max(1 / 30, pct * sp * wm);
      this.bwB[k] = bw;
      // FL makes up the centre loss of the detuned sections with 2^flatness
      this.gNorm[k] = (G_NORM / (bw * sqrtN)) * Math.pow(2, phi);
      // carrier: two staggered sections
      const bs = bw / (1 + phi / 2);
      const off = (phi * bs) / 2;
      svfBp(f * Math.pow(2, -off), bs, sr, this.cc, (k * 2) * 4);
      svfBp(f * Math.pow(2, off), bs, sr, this.cc, (k * 2 + 1) * 4);
      // detection per voice
      const pitchK = this.sPitch + (2 * vcxEnvAt(pEnv, this.uB[k]) - 1) * 1200;
      for (let v = 0; v < V; v++) {
        const dv = V > 1 ? uniCents * ((2 * v) / (V - 1) - 1) : 0;
        const fd = f * Math.pow(2, -(pitchK + dv) / 1200);
        const ws = bw * detW * m;
        const base = (v * MAXB + k) * MAXS;
        let centre = 1;
        for (let s = 0; s < det[0]; s++) {
          const o = det[0] > 1 ? (s - (det[0] - 1) / 2) * detStep * ws : 0;
          svfBp(fd * Math.pow(2, o), ws, sr, this.dc, (base + s) * 4);
          centre *= svfMag(this.dc, (base + s) * 4, fd, sr);
        }
        // orders 1, 3, 4: unit centre gain times FL's measured centre gain; order 2: FL's 2^flat make-up
        this.dGain[v * MAXB + k] = this.order === 2 ? detGain : detGain / Math.max(1e-6, centre);
      }
    }
  }

  private updateMixerFilters(): void {
    const q = this.p, sr = this.sr;
    if (q.modHp > 0) { const f = vcxFilterHz(q.modHp); butter2(f, Q4A, sr, true, this.hpC, 0); butter2(f, Q4B, sr, true, this.hpC, 5); }
    if (q.carLp < 65536) { const f = vcxFilterHz(q.carLp); butter2(f, Q4A, sr, false, this.lpC, 0); butter2(f, Q4B, sr, false, this.lpC, 5); }
    if (q.noiseHp > 0) butter2(vcxFilterHz(q.noiseHp), Math.SQRT1_2, sr, true, this.nzC, 0);
  }

  private updateTail(): void {
    const q = this.p;
    const rel = vcxTime(q.rel, 2000) / 1000 * 8;
    const hold = vcxTime(q.hold, 250) / 1000 * 8;
    let ring = 0;
    for (let k = 0; k < this.nB; k++) ring = Math.max(ring, 2.2 / (Math.max(1e-3, 2 * Math.sinh(HALF_LN2 * this.bwB[k])) * Math.max(20, this.fB[k])));
    this.tail = q.tone > 0 && this.notes.length ? Infinity : Math.min(30, 0.1 + 1.5 * rel + hold + 2 * ring);
  }

  private glide(len: number): void {
    const q = this.p;
    const a = 1 - Math.exp(-len / (SMOOTH_S * this.sr));
    let moving = false;
    let d = q.bw - this.sBw; if (Math.abs(d) > 0.05) { this.sBw += d * a; moving = true; } else this.sBw = q.bw;
    d = q.flat - this.sFlat; if (Math.abs(d) > 0.01) { this.sFlat += d * a; moving = true; } else this.sFlat = q.flat;
    d = q.modBw - this.sModBw; if (Math.abs(d) > 0.5) { this.sModBw += d * a; moving = true; } else this.sModBw = q.modBw;
    d = q.pitch - this.sPitch; if (Math.abs(d) > 0.05) { this.sPitch += d * a; moving = true; } else this.sPitch = q.pitch;
    d = q.uniShift - this.sUni; if (Math.abs(d) > 0.05) { this.sUni += d * a; moving = true; } else this.sUni = q.uniShift;
    this.computeFilters();
    this.dirty = moving;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (this.nEv === 0) {
      for (let off = 0; off < n; off += this.bs) this.block(L, R, off, Math.min(this.bs, n - off), ctx);
      return;
    }
    // MIDI notes take effect at their sample: process up to each event, then apply it
    let off = 0, e = 0;
    const nEv = this.nEv;
    while (off < n) {
      while (e < nEv && this.evFrame[e] <= off) { this.applyNote(this.evKey[e], this.evOn[e] === 1); e++; }
      const next = e < nEv ? Math.min(n, this.evFrame[e]) : n;
      const end = Math.min(next, off + this.bs);
      this.block(L, R, off, end - off, ctx);
      off = end;
    }
    while (e < nEv) { this.applyNote(this.evKey[e], this.evOn[e] === 1); e++; }
    this.nEv = 0;
  }

  // ---- MIDI input ----
  noteOn(key: number, _velocity: number, frameOffset: number): void { this.queueNote(key, frameOffset, true); }

  noteOff(key: number, frameOffset: number): void { this.queueNote(key, frameOffset, false); }

  allNotesOff(): void {
    this.nEv = 0;
    this.down.fill(0);
    this.nDown = 0;
  }

  takeStateChanges(): [string, unknown][] | null {
    if (!this.notesChanged) return null;
    this.notesChanged = false;
    this.paramNotesKey = this.notes.join(',');
    return [['notes', this.notes.slice()]];
  }

  private queueNote(key: number, frame: number, on: boolean): void {
    if (key < 0 || key > 127) return;
    if (this.nEv >= EVQ) { this.applyNote(key, on); return; }
    const i = this.nEv++;
    this.evFrame[i] = Math.max(0, frame | 0); this.evKey[i] = key; this.evOn[i] = on ? 1 : 0;
  }

  /** FL's controller latching: the first key pressed clears the chord, keys pressed while one is held join it. */
  private applyNote(key: number, on: boolean): void {
    if (!on) {
      if (this.down[key]) { this.down[key] = 0; this.nDown--; }
      return;
    }
    if (this.down[key]) return;
    if (this.nDown === 0) this.notes.length = 0;
    this.down[key] = 1;
    this.nDown++;
    if (!this.notes.includes(key) && this.notes.length < 16) this.notes.push(key);
    this.notesChanged = true;
    this.updateTail();
  }

  private nextNoise(): number {
    // xorshift32 -> uniform [-0.5, 0.5)
    let s = this.noiseSeed;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.noiseSeed = s;
    return (s >>> 0) / 4294967296 - 0.5;
  }

  private block(L: Float32Array, R: Float32Array, off: number, len: number, ctx: FxContext): void {
    const q = this.p, sr = this.sr;
    const modL = this.modL, modR = this.modR, carL = this.carL, carR = this.carR, modM = this.modM;
    // ---- inputs ----
    const sc = ctx && ctx.sidechain ? ctx.sidechain : EMPTY_SC;
    let mSrcL: Float32Array | null = null, mSrcR: Float32Array | null = null, mOff = off;
    let cSrcL: Float32Array | null = null, cSrcR: Float32Array | null = null, cOff = off;
    if (q.lr) { mSrcL = L; mSrcR = L; cSrcL = R; cSrcR = R; }
    else {
      if (q.modIn === 0) { mSrcL = L; mSrcR = R; }
      else if (q.modIn > 0) { const s = sc[q.modIn - 1]; if (s) { mSrcL = s.L; mSrcR = s.R; mOff = off; } else { mSrcL = L; mSrcR = R; } }
      if (q.carIn === 0) { cSrcL = L; cSrcR = R; }
      else if (q.carIn > 0) { const s = sc[q.carIn - 1]; if (s) { cSrcL = s.L; cSrcR = s.R; cOff = off; } else { cSrcL = L; cSrcR = R; } }
    }
    let pkM = this.mMod, pkC = this.mCar;
    for (let i = 0; i < len; i++) {
      let a = mSrcL ? mSrcL[mOff + i] : 0, c = mSrcR ? mSrcR[mOff + i] : 0;
      a = a - a === 0 ? a : 0; c = c - c === 0 ? c : 0;
      modL[i] = a; modR[i] = c; modM[i] = (a + c) * 0.5;
      let x = cSrcL ? cSrcL[cOff + i] : 0, y = cSrcR ? cSrcR[cOff + i] : 0;
      x = x - x === 0 ? x : 0; y = y - y === 0 ? y : 0;
      carL[i] = x; carR[i] = y;
      const am = Math.abs(modM[i]); if (am > pkM) pkM = am;
    }
    // internal carrier synth
    if (q.tone > 0) this.synth.render(q.tone, this.notes, carL, carR, len);
    for (let i = 0; i < len; i++) { const ac = Math.max(Math.abs(carL[i]), Math.abs(carR[i])); if (ac > pkC) pkC = ac; }
    this.mMod = pkM; this.mCar = pkC;

    if (this.dirty) this.glide(len);
    const invLen = 1 / len;

    // ---- contours (consonants, carrier envelope) ----
    const fromAny = q.contFromCar || q.contFromCons;
    let c0 = this.contour, c1 = c0;
    if (fromAny) {
      const tmp = this.tmp;
      for (let i = 0; i < len; i++) tmp[i] = modM[i];
      biq(tmp, len, this.consC, 0, this.consS, 0);
      const aF = Math.exp(-1 / (0.001 * sr)), rF = Math.exp(-1 / (0.03 * sr));
      let eh = this.consEnvHp, ea = this.consEnvAll, ec = this.carEnv;
      for (let i = 0; i < len; i++) {
        const h = Math.abs(tmp[i]), x = Math.abs(modM[i]), cv = Math.max(Math.abs(carL[i]), Math.abs(carR[i]));
        eh = h + (eh - h) * (h > eh ? aF : rF);
        ea = x + (ea - x) * (x > ea ? aF : rF);
        ec = cv + (ec - cv) * (cv > ec ? aF : rF);
      }
      this.consEnvHp = eh < 1e-30 ? 0 : eh; this.consEnvAll = ea < 1e-30 ? 0 : ea; this.carEnv = ec < 1e-30 ? 0 : ec;
      let c = 1;
      if (q.contFromCons) {
        const gate = Math.min(1, Math.max(0, (ea - 0.001) / 0.002));
        c *= ea > 1e-9 ? Math.min(1, (1.3 * eh) / ea) * gate : 0;
      }
      if (q.contFromCar) c *= Math.min(1, 4 * ec);
      c1 = c;
    }
    this.contour = c1;

    // ---- added noise into the carrier ----
    const nT = vcxCurve7(q.noise / 12800);
    const n0 = this.noiseG, n1 = nT;
    this.noiseG = n1;
    if (n0 > 0 || n1 > 0) {
      const tmp = this.tmp, tmp2 = this.tmp2;
      for (let i = 0; i < len; i++) {
        let g = n0 + (n1 - n0) * i * invLen;
        if (q.contToNoise && fromAny) g *= c0 + (c1 - c0) * i * invLen;
        tmp[i] = this.nextNoise() * g; tmp2[i] = this.nextNoise() * g;
      }
      if (q.noiseHp > 0) { biq(tmp, len, this.nzC, 0, this.nzS, 0); biq(tmp2, len, this.nzC, 0, this.nzS, 2); }
      for (let i = 0; i < len; i++) { carL[i] += tmp[i]; carR[i] += tmp2[i]; }
    }

    // ---- vocoder ----
    const outL = this.outL, outR = this.outR;
    for (let i = 0; i < len; i++) { outL[i] = 0; outR[i] = 0; }
    const N = this.nB, V = this.nV, ns = this.nSec;
    const stereoCar = !q.lr && !(cSrcL === cSrcR && q.tone === 0);
    const tmp = this.tmp, envB = this.envB, passB = this.passB;
    const holdBase = vcxTime(q.hold, 250) / 1000;
    const minHold = q.minTimes ? (q.holdMode === 1 ? 0.05 : 0.025) : 0;
    const attBase = Math.max(q.minTimes ? 0.002 : 0, vcxTime(q.att, 1000) / 1000);
    const relBase = Math.max(q.minTimes ? 0.0036 : 0, vcxTime(q.rel, 2000) / 1000);
    const ac = vcxCurveExp(q.attCurve), rc = vcxCurveExp(q.relCurve);
    const freeze = q.freeze, rmsMode = q.holdMode === 1;
    let passOn = false;
    for (let k = 0; k < N; k++) if (this.mPass[k] > 0) { passOn = true; break; }
    if (passOn) for (let i = 0; i < len; i++) passB[i] = 0;
    // RMS window (chunks); running sums are rebuilt when the window changes
    if (rmsMode) {
      const W = Math.max(1, Math.min(MAXCHUNKS - 1, Math.round((Math.max(minHold, holdBase) * sr) / CHUNK)));
      if (W !== this.rmsW) {
        this.rmsW = W;
        const last = (this.rmsPos - 1 + MAXCHUNKS) % MAXCHUNKS;
        for (let vb = 0; vb < MAXV * MAXB; vb++) {
          let sum = 0;
          for (let j = 0; j < W; j++) sum += this.rmsRing[vb * MAXCHUNKS + ((last - j + MAXCHUNKS) % MAXCHUNKS)];
          this.rmsSum[vb] = sum;
        }
      }
    }
    for (let k = 0; k < N; k++) {
      // envelope sum over voices (panned): accumulate L/R envelope products later
      let anyEnv = false;
      for (let i = 0; i < len; i++) envB[i] = 0;
      const tmpR = this.tmp2; // right envelope accumulator when unison pans differ
      for (let i = 0; i < len; i++) tmpR[i] = 0;
      const holdS = Math.max(minHold, holdBase * this.mHold[k]);
      const holdN = Math.round(holdS * sr);
      // attack / release cascades: curve c uses round(c) one-poles timed to reach 99% in the set time
      const nA = Math.max(1, Math.min(4, Math.round(ac))), nR = Math.max(1, Math.min(4, Math.round(rc)));
      const aA = Math.exp(-CASCADE_X[nA] / Math.max(1, attBase * this.mAtt[k] * sr));
      const aR = Math.exp(-CASCADE_X[nR] / Math.max(1, relBase * this.mRel[k] * sr));
      const nStages = Math.max(nA, nR);
      for (let v = 0; v < V; v++) {
        const vb = v * MAXB + k;
        const base = vb * MAXS;
        if (ns === 2) {
          // two sections in one pass (the default order)
          const c0 = base * 4, c1 = (base + 1) * 4, s0o = base * 2, s1o = (base + 1) * 2;
          const dc = this.dc, dsx = this.ds;
          const p1 = dc[c0], p2 = dc[c0 + 1], p3 = dc[c0 + 2], pk0 = dc[c0 + 3];
          const q1 = dc[c1], q2 = dc[c1 + 1], q3 = dc[c1 + 2], qk = dc[c1 + 3];
          let x1 = dsx[s0o], x2 = dsx[s0o + 1], z1 = dsx[s1o], z2 = dsx[s1o + 1];
          for (let i = 0; i < len; i++) {
            let v3 = modM[i] - x2, v1 = p1 * x1 + p2 * v3, v2 = x2 + p2 * x1 + p3 * v3;
            x1 = 2 * v1 - x1; x2 = 2 * v2 - x2;
            const y = pk0 * v1;
            v3 = y - z2; v1 = q1 * z1 + q2 * v3; v2 = z2 + q2 * z1 + q3 * v3;
            z1 = 2 * v1 - z1; z2 = 2 * v2 - z2;
            tmp[i] = qk * v1;
          }
          const fl = flush30;
          dsx[s0o] = fl(x1); dsx[s0o + 1] = fl(x2); dsx[s1o] = fl(z1); dsx[s1o + 1] = fl(z2);
        } else for (let i = 0; i < len; i++) tmp[i] = modM[i];
        for (let s = 0; ns !== 2 && s < ns; s++) {
          const co = (base + s) * 4, so = (base + s) * 2;
          const a1 = this.dc[co], a2 = this.dc[co + 1], a3 = this.dc[co + 2], kk = this.dc[co + 3];
          let ic1 = this.ds[so], ic2 = this.ds[so + 1];
          for (let i = 0; i < len; i++) {
            const v3 = tmp[i] - ic2;
            const v1 = a1 * ic1 + a2 * v3;
            const v2 = ic2 + a2 * ic1 + a3 * v3;
            ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
            tmp[i] = kk * v1;
          }
          this.ds[so] = (ic1 > 1e-30 || ic1 < -1e-30) && ic1 - ic1 === 0 ? ic1 : 0;
          this.ds[so + 1] = (ic2 > 1e-30 || ic2 < -1e-30) && ic2 - ic2 === 0 ? ic2 : 0;
        }
        const dg = this.dGain[vb];
        if (passOn && v === 0) { const pg = this.mPass[k] * dg; for (let i = 0; i < len; i++) passB[i] += tmp[i] * pg; }
        // detector + follower
        let pk = this.peak[vb], hc = this.holdCnt[vb];
        const eo = vb * 4;
        let s0 = this.es[eo], s1 = this.es[eo + 1], s2 = this.es[eo + 2], s3 = this.es[eo + 3];
        const thr = this.mThr[k], sub = q.subDenoise, satMix = this.mSatMix[k];
        const wL = this.voiceW[v] * this.voicePanL[v], wR = this.voiceW[v] * this.voicePanR[v];
        let rs = this.rmsSum[vb], rp = this.rmsPart[vb];
        const ringBase = vb * MAXCHUNKS;
        let rmsDet = 2.25 * Math.sqrt(Math.max(0, rs) / (this.rmsW * CHUNK));
        for (let i = 0; i < len; i++) {
          const x = tmp[i] * dg;
          let det: number;
          if (rmsMode) {
            rp += x * x;
            const done = this.rmsCnt + i + 1;
            if ((done & (CHUNK - 1)) === 0) {
              const pos = (this.rmsPos + ((done / CHUNK) | 0) - 1) % MAXCHUNKS;
              const old = this.rmsRing[ringBase + ((pos - this.rmsW + MAXCHUNKS) % MAXCHUNKS)];
              this.rmsRing[ringBase + pos] = rp;
              rs += rp - old; if (rs < 0) rs = 0;
              rp = 0;
              rmsDet = 2.25 * Math.sqrt(rs / (this.rmsW * CHUNK));
            }
            det = rmsDet;
          } else {
            // peak hold: every peak within -3 dB of the held value restarts the hold (sampled sine
            // peaks vary from cycle to cycle), so a steady tone holds steadily and the release
            // starts one hold time after the level drops, as FL's does
            const ax = x < 0 ? -x : x;
            if (ax >= pk) { pk = ax; hc = holdN; }
            else if (ax >= pk * 0.7) hc = holdN;
            else if (hc > 0) hc--;
            else pk = ax;
            det = pk;
          }
          if (!freeze) {
            s0 = det + (s0 - det) * (det > s0 ? aA : aR);
            if (nStages > 1) {
              s1 = s0 + (s1 - s0) * (s0 > s1 ? (nA >= 2 ? aA : 0) : (nR >= 2 ? aR : 0));
              if (nStages > 2) {
                s2 = s1 + (s2 - s1) * (s1 > s2 ? (nA >= 3 ? aA : 0) : (nR >= 3 ? aR : 0));
                if (nStages > 3) s3 = s2 + (s3 - s2) * (s2 > s3 ? (nA >= 4 ? aA : 0) : (nR >= 4 ? aR : 0));
                else s3 = s2;
              } else { s2 = s1; s3 = s1; }
            } else { s1 = s0; s2 = s0; s3 = s0; }
          }
          let e = s3;
          if (thr > 0) e = sub ? Math.max(0, e - thr) : e < thr ? 0 : e;
          if (satMix > 0 && !this.satIdentity) e += (vcxEnvAt(this.satCurve, Math.min(1, e)) - e) * satMix;
          envB[i] += e * wL; tmpR[i] += e * wR;
          anyEnv = anyEnv || e > 0;
        }
        this.peak[vb] = pk; this.holdCnt[vb] = hc;
        this.es[eo] = s0 < 1e-30 ? 0 : s0; this.es[eo + 1] = s1 < 1e-30 ? 0 : s1;
        this.es[eo + 2] = s2 < 1e-30 ? 0 : s2; this.es[eo + 3] = s3 < 1e-30 ? 0 : s3;
        this.rmsSum[vb] = rs; this.rmsPart[vb] = rp;
        this.envOut[vb] = this.es[eo + 3];
      }
      // display / noise detection use the first voice
      const ev = this.envOut[k];
      if (ev > this.envPeak[k]) this.envPeak[k] = ev;
      if (this.detectLeft > 0) this.detectAcc[k] = Math.max(this.detectAcc[k], ev);
      // gains
      const gm = this.mGain[k], offs = this.mOff[k];
      const pn = this.mPan[k];
      const panL = Math.min(1, 1 - pn), panR = Math.min(1, 1 + pn);
      const G = this.gNorm[k];
      this.tL[k] = G * panL; this.tR[k] = G * panR;
      const gl0 = this.gL[k], gl1 = this.tL[k], gr0 = this.gR[k], gr1 = this.tR[k];
      this.gL[k] = gl1; this.gR[k] = gr1;
      const silent = !anyEnv && offs <= 0;
      // carrier band (left / right): always filtered so the band history matches when it reopens;
      // both sections and both channels run in one pass
      const c0o = (k * 2) * 4, c1o = (k * 2 + 1) * 4;
      const cc = this.cc, cs = this.cs;
      const a1a = cc[c0o], a2a = cc[c0o + 1], a3a = cc[c0o + 2], ka = cc[c0o + 3];
      const a1b = cc[c1o], a2b = cc[c1o + 1], a3b = cc[c1o + 2], kb = cc[c1o + 3];
      const sLa = ((k * 2) * 2) * 2, sLb = ((k * 2 + 1) * 2) * 2, sRa = sLa + 2, sRb = sLb + 2;
      let la1 = cs[sLa], la2 = cs[sLa + 1], lb1 = cs[sLb], lb2 = cs[sLb + 1];
      let ra1 = cs[sRa], ra2 = cs[sRa + 1], rb1 = cs[sRb], rb2 = cs[sRb + 1];
      const envR = this.tmp2;
      const dl = (gl1 - gl0) * invLen, dr = (gr1 - gr0) * invLen;
      if (stereoCar) {
        for (let i = 0; i < len; i++) {
          let v3 = carL[i] - la2, v1 = a1a * la1 + a2a * v3, v2 = la2 + a2a * la1 + a3a * v3;
          la1 = 2 * v1 - la1; la2 = 2 * v2 - la2;
          let y = ka * v1;
          v3 = y - lb2; v1 = a1b * lb1 + a2b * v3; v2 = lb2 + a2b * lb1 + a3b * v3;
          lb1 = 2 * v1 - lb1; lb2 = 2 * v2 - lb2;
          const yl = kb * v1;
          v3 = carR[i] - ra2; v1 = a1a * ra1 + a2a * v3; v2 = ra2 + a2a * ra1 + a3a * v3;
          ra1 = 2 * v1 - ra1; ra2 = 2 * v2 - ra2;
          y = ka * v1;
          v3 = y - rb2; v1 = a1b * rb1 + a2b * v3; v2 = rb2 + a2b * rb1 + a3b * v3;
          rb1 = 2 * v1 - rb1; rb2 = 2 * v2 - rb2;
          const yr = kb * v1;
          if (!silent) {
            const el = envB[i] * gm + offs, er = envR[i] * gm + offs;
            if (el > 0) outL[i] += (gl0 + dl * i) * el * yl;
            if (er > 0) outR[i] += (gr0 + dr * i) * er * yr;
          }
        }
      } else {
        for (let i = 0; i < len; i++) {
          let v3 = carL[i] - la2, v1 = a1a * la1 + a2a * v3, v2 = la2 + a2a * la1 + a3a * v3;
          la1 = 2 * v1 - la1; la2 = 2 * v2 - la2;
          const y = ka * v1;
          v3 = y - lb2; v1 = a1b * lb1 + a2b * v3; v2 = lb2 + a2b * lb1 + a3b * v3;
          lb1 = 2 * v1 - lb1; lb2 = 2 * v2 - lb2;
          const c = kb * v1;
          if (!silent) {
            const el = envB[i] * gm + offs, er = envR[i] * gm + offs;
            if (el > 0) outL[i] += (gl0 + dl * i) * el * c;
            if (er > 0) outR[i] += (gr0 + dr * i) * er * c;
          }
        }
      }
      const fl = flush30;
      cs[sLa] = fl(la1); cs[sLa + 1] = fl(la2); cs[sLb] = fl(lb1); cs[sLb + 1] = fl(lb2);
      cs[sRa] = fl(ra1); cs[sRa + 1] = fl(ra2); cs[sRb] = fl(rb1); cs[sRb + 1] = fl(rb2);
    }
    if (rmsMode) {
      const total = this.rmsCnt + len;
      this.rmsPos = (this.rmsPos + ((total / CHUNK) | 0)) % MAXCHUNKS;
      this.rmsCnt = total & (CHUNK - 1);
    }
    if (this.detectLeft > 0) {
      this.detectLeft -= len;
      if (this.detectLeft <= 0) {
        const prof = new Float32Array(N);
        for (let k = 0; k < N; k++) prof[k] = this.detectAcc[k];
        this.noiseProfile = prof; this.noiseProfileSeq = this.detectSeq;
      }
    }

    // ---- mixer ----
    const wT = vcxCurve7(q.wet / 1000), mT = vcxCurve11(q.modLvl / 12800), cT = vcxCurve11(q.carLvl / 12800);
    const w0 = this.wetG, m0 = this.modG, k0 = this.carG;
    this.wetG = wT; this.modG = mT; this.carG = cT;
    // modulator pass-through (stereo, high-passed, contour)
    if (m0 > 0 || mT > 0) {
      const tl = this.tmp, tr = this.tmp2;
      for (let i = 0; i < len; i++) { tl[i] = modL[i]; tr[i] = modR[i]; }
      if (q.modHp > 0) { biq(tl, len, this.hpC, 0, this.hpS, 0); biq(tl, len, this.hpC, 5, this.hpS, 2); biq(tr, len, this.hpC, 0, this.hpS, 4); biq(tr, len, this.hpC, 5, this.hpS, 6); }
      const useC = q.contToMod && fromAny;
      for (let i = 0; i < len; i++) {
        let g = m0 + (mT - m0) * i * invLen;
        if (useC) g *= c0 + (c1 - c0) * i * invLen;
        // vocoded part is scaled by wet below; add pass-through after wet scaling
        tl[i] *= g; tr[i] *= g;
      }
      for (let i = 0; i < len; i++) {
        const wg = w0 + (wT - w0) * i * invLen;
        outL[i] = outL[i] * wg + tl[i]; outR[i] = outR[i] * wg + tr[i];
      }
    } else {
      for (let i = 0; i < len; i++) { const wg = w0 + (wT - w0) * i * invLen; outL[i] *= wg; outR[i] *= wg; }
    }
    if (passOn) for (let i = 0; i < len; i++) { outL[i] += passB[i]; outR[i] += passB[i]; }
    // carrier pass-through (low-passed)
    if (k0 > 0 || cT > 0) {
      const tl = this.tmp, tr = this.tmp2;
      for (let i = 0; i < len; i++) { tl[i] = carL[i]; tr[i] = carR[i]; }
      if (q.carLp < 65536) { biq(tl, len, this.lpC, 0, this.lpS, 0); biq(tl, len, this.lpC, 5, this.lpS, 2); biq(tr, len, this.lpC, 0, this.lpS, 4); biq(tr, len, this.lpC, 5, this.lpS, 6); }
      for (let i = 0; i < len; i++) { const g = k0 + (cT - k0) * i * invLen; outL[i] += tl[i] * g; outR[i] += tr[i] * g; }
    }

    // ---- soundgoodizer + look-ahead limiter (constant latency) ----
    this.soundgoodize(outL, outR, len);

    let pkO = this.mOut;
    for (let i = 0; i < len; i++) {
      let l = outL[i], r = outR[i];
      l = l === l && l < 1e6 && l > -1e6 ? l : 0;
      r = r === r && r < 1e6 && r > -1e6 ? r : 0;
      L[off + i] = l; R[off + i] = r;
      const a = Math.max(Math.abs(l), Math.abs(r)); if (a > pkO) pkO = a;
    }
    this.mOut = pkO;
  }

  /** (1 - s) x + s * three-band maximizer, through the look-ahead limiter (delay always applied). */
  private soundgoodize(L: Float64Array, R: Float64Array, len: number): void {
    const s1 = this.p.sg / 1000, s0 = this.sgS;
    this.sgS = s1;
    const sr = this.sr;
    const D = this.dlyLen, dl = this.dlyL, dr = this.dlyR;
    const active = s0 > 0 || s1 > 0;
    const C = this.sgC, S = this.sgS2, env = this.sgEnv;
    const atk = Math.exp(-1 / (0.01 * sr)), relc = Math.exp(-1 / (0.15 * sr));
    const limRel = Math.exp(-1 / (0.06 * sr));
    const ceil = Math.pow(10, -0.35 / 20);
    let lg = this.limGain;
    for (let i = 0; i < len; i++) {
      let xl = L[i], xr = R[i];
      if (active) {
        const s = s0 + (s1 - s0) * (i / len);
        for (let ch = 0; ch < 2; ch++) {
          const x = ch === 0 ? xl : xr;
          // Linkwitz-Riley 4th-order 3-band split (200 Hz / 3 kHz): low = LP1^2, rest = HP1^2, mid = LP2^2(rest), high = HP2^2(rest)
          const so = ch * 24;
          let lo = x, rest = x;
          for (let st = 0; st < 2; st++) { const sb = so + st * 2; const y = C[0] * lo + S[sb]; S[sb] = C[1] * lo - C[3] * y + S[sb + 1]; S[sb + 1] = C[2] * lo - C[4] * y; lo = y; }
          for (let st = 0; st < 2; st++) { const sb = so + 4 + st * 2; const y = C[5] * rest + S[sb]; S[sb] = C[6] * rest - C[8] * y + S[sb + 1]; S[sb + 1] = C[7] * rest - C[9] * y; rest = y; }
          // low band through the 3 kHz Linkwitz-Riley allpass so the three bands (and the dry signal) stay in phase
          { const sb = so + 16; const y = C[20] * lo + S[sb]; S[sb] = C[21] * lo - C[23] * y + S[sb + 1]; S[sb + 1] = C[22] * lo - C[24] * y; lo = y; }
          let mid = rest, hi = rest;
          for (let st = 0; st < 2; st++) { const sb = so + 8 + st * 2; const y = C[10] * mid + S[sb]; S[sb] = C[11] * mid - C[13] * y + S[sb + 1]; S[sb + 1] = C[12] * mid - C[14] * y; mid = y; }
          for (let st = 0; st < 2; st++) { const sb = so + 12 + st * 2; const y = C[15] * hi + S[sb]; S[sb] = C[16] * hi - C[18] * y + S[sb + 1]; S[sb + 1] = C[17] * hi - C[19] * y; hi = y; }
          const dry = lo + mid + hi;
          let y = 0;
          for (let bnd = 0; bnd < 3; bnd++) {
            const v = (bnd === 0 ? lo : bnd === 1 ? mid : hi) * SG_GAINS[bnd];
            const ei = ch * 3 + bnd;
            const a = v < 0 ? -v : v;
            env[ei] = a + (env[ei] - a) * (a > env[ei] ? atk : relc);
            // gentle per-band compression (soft 8 dB knee), fitted to FL's static curves
            if ((this.sgTick & 7) === 0) {
              const e = env[ei];
              const edb = e > 1e-9 ? 20 * Math.log10(e) : -180;
              const over = edb - SG_THR[bnd];
              const slope = 1 - 1 / SG_RATIO[bnd];
              let gr = 0;
              if (over > 4) gr = over * slope;
              else if (over > -4) gr = ((over + 4) * (over + 4) / 16) * slope;
              this.sgGain[ei] = gr > 0 ? Math.pow(10, -gr / 20) : 1;
            }
            y += v * this.sgGain[ei];
          }
          if (ch === 0) xl = (1 - s) * dry + s * y; else xr = (1 - s) * dry + s * y;
        }
        this.sgTick++;
      }
      // delay line + peak look-ahead limiter
      const pos = this.dlyPos;
      const outPos = (pos + 1) % D;
      dl[pos] = xl; dr[pos] = xr;
      const a = Math.max(Math.abs(xl), Math.abs(xr));
      this.peakBuf[pos] = a;
      this.dlyPos = outPos;
      let yl = dl[outPos], yr = dr[outPos];
      if (active) {
        if ((pos & 15) === 0) {
          let mx = 0;
          for (let j = 0; j < D; j++) if (this.peakBuf[j] > mx) mx = this.peakBuf[j];
          this.sgMax = mx;
        } else if (a > this.sgMax) this.sgMax = a;
        const need = this.sgMax > ceil ? ceil / this.sgMax : 1;
        lg = need < lg ? lg + (need - lg) * 0.25 : need + (lg - need) * limRel;
        yl *= lg; yr *= lg;
      } else lg = 1;
      L[i] = yl; R[i] = yr;
    }
    this.limGain = lg;
  }
  private sgMax = 0;

  monitor(): FxMonitor {
    const N = this.nB;
    const bands = this.monBands.subarray(0, N), freqs = this.monFreqs.subarray(0, N);
    for (let k = 0; k < N; k++) {
      bands[k] = this.envPeak[k];
      this.envPeak[k] = this.envOut[k];
      freqs[k] = this.fB[k];
    }
    const m: FxMonitor = {
      n: N, bands: Float32Array.from(bands), freqs: Float32Array.from(freqs),
      mod: this.mMod, car: this.mCar, out: this.mOut, detecting: this.detectLeft > 0,
    };
    this.mMod = 0; this.mCar = 0; this.mOut = 0;
    if (this.noiseProfile) { m.noiseProfile = this.noiseProfile; m.noiseSeq = this.noiseProfileSeq; this.noiseProfile = null; }
    return m;
  }
}

export const effect: EffectModule = {
  id: 'vocodex',
  create: (sampleRate, blockSize) => new Vocodex(sampleRate, blockSize),
};
