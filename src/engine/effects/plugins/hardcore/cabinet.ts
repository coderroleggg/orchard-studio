// Hardcore's cabinet models as designed filter cascades: a second-order high
// pass, two second-order low passes and seven peaking bands per model (analog
// prototypes, magnitude-matched to the sample rate), fitted to the magnitude
// responses of FL's Model A..T measured through the plugin (flfxhost, impulse
// with only the cabinet active, 1/6-octave smoothing; 0.4-1.1 dB rms error).
// `makeup` is the model's absolute gain, so levels match FL. No impulse
// response is used. A-E keep the full low end and roll off from ~150 Hz, F-L
// are tight, mid-scooped boxes and M-T dark mic'd cabinets (FL plays M-T about
// 23 ms late, an uncompensated IR delay that is not reproduced here).
// Changing model crossfades between the old and new cascades.

import { Biquad2, design } from './dsp';

type Sec = [kind: 'hp' | 'lp' | 'pk', f: number, q: number, g: number];
interface CabModel { makeup: number; s: Sec[] }

const MODELS: CabModel[] = [
  { makeup: 12.37, s: [['hp', 51, 0.81, 0.0], ['lp', 5515, 3.61, 0.0], ['lp', 6000, 0.30, 0.0], ['pk', 3756, 3.33, -26.3], ['pk', 651, 0.45, -26.5], ['pk', 8808, 3.30, -7.0], ['pk', 11620, 8.00, -13.4], ['pk', 14080, 4.78, 11.0], ['pk', 4097, 8.00, -3.9], ['pk', 2945, 8.00, 2.8]] }, // Model A (rms err 0.56 dB)
  { makeup: 8.65, s: [['hp', 40, 0.70, 0.0], ['lp', 5006, 1.12, 0.0], ['lp', 6281, 0.55, 0.0], ['pk', 4868, 3.88, -21.9], ['pk', 582, 0.60, -21.3], ['pk', 1788, 2.11, -14.0], ['pk', 4264, 4.50, -10.3], ['pk', 6539, 4.67, 6.2], ['pk', 8469, 8.00, -4.3], ['pk', 1090, 5.82, 3.5]] }, // Model B (rms err 0.72 dB)
  { makeup: 10.69, s: [['hp', 47, 0.86, 0.0], ['lp', 3880, 0.35, 0.0], ['lp', 8946, 0.77, 0.0], ['pk', 585, 0.69, -26.9], ['pk', 7818, 2.74, -12.7], ['pk', 3975, 4.62, -7.7], ['pk', 2063, 2.21, -5.7], ['pk', 5295, 5.29, 4.9], ['pk', 3019, 5.02, 3.6], ['pk', 14525, 8.00, 7.0]] }, // Model C (rms err 0.67 dB)
  { makeup: 6.40, s: [['hp', 44, 0.94, 0.0], ['lp', 5562, 0.63, 0.0], ['lp', 7220, 0.93, 0.0], ['pk', 613, 0.58, -19.9], ['pk', 4056, 1.46, -13.1], ['pk', 9014, 4.36, -7.3], ['pk', 2382, 4.20, -5.4], ['pk', 11458, 7.41, -8.0], ['pk', 1132, 5.29, 2.7], ['pk', 818, 4.44, -1.8]] }, // Model D (rms err 0.43 dB)
  { makeup: 8.61, s: [['hp', 45, 0.83, 0.0], ['lp', 5672, 4.27, 0.0], ['lp', 7948, 0.30, 0.0], ['pk', 659, 0.59, -23.8], ['pk', 3781, 1.83, -18.3], ['pk', 9188, 5.62, -14.1], ['pk', 2569, 3.81, -7.1], ['pk', 1294, 3.28, 4.2], ['pk', 14408, 8.00, 7.1], ['pk', 11841, 8.00, -8.5]] }, // Model E (rms err 0.53 dB)
  { makeup: -1.61, s: [['hp', 129, 2.33, 0.0], ['lp', 3851, 1.98, 0.0], ['lp', 10126, 0.30, 0.0], ['pk', 5140, 7.30, 7.0], ['pk', 562, 2.39, -7.7], ['pk', 684, 4.42, 6.5], ['pk', 1546, 2.36, -4.8], ['pk', 8058, 3.17, -5.1], ['pk', 40, 2.13, -14.0], ['pk', 1140, 8.00, 3.5]] }, // Model F (rms err 0.82 dB)
  { makeup: 0.17, s: [['hp', 126, 2.33, 0.0], ['lp', 3570, 1.10, 0.0], ['lp', 13437, 0.30, 0.0], ['pk', 4672, 7.09, 9.3], ['pk', 5592, 8.00, -8.5], ['pk', 498, 5.53, -7.8], ['pk', 1349, 7.34, -6.2], ['pk', 565, 8.00, 5.9], ['pk', 3745, 5.70, -6.1], ['pk', 1718, 8.00, -4.6]] }, // Model G (rms err 0.72 dB)
  { makeup: -2.56, s: [['hp', 117, 4.96, 0.0], ['lp', 5055, 1.42, 0.0], ['lp', 10429, 0.55, 0.0], ['pk', 542, 5.00, -9.2], ['pk', 7390, 3.37, -10.7], ['pk', 1066, 2.98, -5.6], ['pk', 5597, 8.00, 3.5], ['pk', 6246, 8.00, -7.1], ['pk', 33, 1.75, -13.7], ['pk', 394, 4.97, -2.9]] }, // Model H (rms err 0.91 dB)
  { makeup: -2.93, s: [['hp', 117, 4.05, 0.0], ['lp', 4796, 1.83, 0.0], ['lp', 17357, 0.33, 0.0], ['pk', 557, 8.00, -7.5], ['pk', 1063, 2.43, -6.1], ['pk', 8479, 3.14, -9.1], ['pk', 32, 1.44, -13.1], ['pk', 6275, 8.00, -5.4], ['pk', 425, 2.90, -2.8], ['pk', 2190, 8.00, 2.1]] }, // Model I (rms err 0.89 dB)
  { makeup: -2.63, s: [['hp', 115, 4.19, 0.0], ['lp', 5116, 2.25, 0.0], ['lp', 15293, 0.30, 0.0], ['pk', 558, 8.00, -6.5], ['pk', 1034, 2.04, -6.0], ['pk', 6852, 4.42, -10.2], ['pk', 430, 2.97, -4.5], ['pk', 33, 0.97, -14.2], ['pk', 2757, 8.00, -3.8], ['pk', 8888, 8.00, -5.5]] }, // Model J (rms err 0.89 dB)
  { makeup: 0.09, s: [['hp', 115, 4.65, 0.0], ['lp', 4331, 1.72, 0.0], ['lp', 11745, 0.30, 0.0], ['pk', 556, 8.00, -6.8], ['pk', 1053, 1.88, -6.8], ['pk', 6205, 8.00, -7.0], ['pk', 34, 0.98, -14.2], ['pk', 2812, 6.75, -5.6], ['pk', 431, 3.53, -4.0], ['pk', 8904, 3.92, -5.6]] }, // Model K (rms err 0.91 dB)
  { makeup: -2.32, s: [['hp', 118, 4.43, 0.0], ['lp', 5269, 2.46, 0.0], ['lp', 16647, 0.30, 0.0], ['pk', 556, 8.00, -7.3], ['pk', 1062, 2.07, -6.2], ['pk', 6912, 3.73, -12.2], ['pk', 32, 1.18, -14.3], ['pk', 425, 2.20, -3.8], ['pk', 2768, 8.00, -3.7], ['pk', 8560, 8.00, -4.8]] }, // Model L (rms err 0.88 dB)
  { makeup: 7.41, s: [['hp', 81, 1.52, 0.0], ['lp', 3510, 1.55, 0.0], ['lp', 2175, 0.36, 0.0], ['pk', 5515, 3.63, 9.2], ['pk', 7552, 6.19, -7.4], ['pk', 578, 0.48, -7.7], ['pk', 6065, 8.00, -7.3], ['pk', 930, 3.52, -3.7], ['pk', 2732, 7.66, -3.3], ['pk', 626, 4.11, 3.1]] }, // Model M (rms err 0.64 dB)
  { makeup: -0.80, s: [['hp', 55, 1.29, 0.0], ['lp', 2178, 0.54, 0.0], ['lp', 4750, 1.97, 0.0], ['pk', 2141, 2.11, 6.7], ['pk', 7034, 8.00, -3.8], ['pk', 8211, 8.00, -2.1], ['pk', 103, 1.75, 5.5], ['pk', 636, 6.53, 3.9], ['pk', 5187, 8.00, 3.1], ['pk', 172, 5.97, 3.0]] }, // Model N (rms err 0.62 dB)
  { makeup: 11.60, s: [['hp', 53, 0.95, 0.0], ['lp', 3196, 2.45, 0.0], ['lp', 1191, 0.30, 0.0], ['pk', 4952, 2.20, 7.8], ['pk', 2810, 6.25, -9.0], ['pk', 6442, 8.00, 6.8], ['pk', 363, 0.94, -7.2], ['pk', 7182, 3.52, -3.8], ['pk', 4216, 8.00, -4.2], ['pk', 836, 2.94, -3.6]] }, // Model O (rms err 0.58 dB)
  { makeup: 13.39, s: [['hp', 56, 1.04, 0.0], ['lp', 3355, 2.60, 0.0], ['lp', 1412, 0.30, 0.0], ['pk', 4977, 3.21, 8.0], ['pk', 531, 0.35, -9.9], ['pk', 6992, 4.40, -7.9], ['pk', 980, 3.61, -5.6], ['pk', 2738, 5.59, -6.4], ['pk', 4184, 8.00, -4.4], ['pk', 360, 2.87, -2.8]] }, // Model P (rms err 0.53 dB)
  { makeup: 2.36, s: [['hp', 86, 1.80, 0.0], ['lp', 3399, 3.32, 0.0], ['lp', 2043, 0.30, 0.0], ['pk', 5578, 2.84, 14.1], ['pk', 6644, 8.00, -10.3], ['pk', 9678, 2.37, 6.9], ['pk', 141, 1.32, 8.1], ['pk', 281, 6.92, 3.8], ['pk', 142, 8.00, -6.4], ['pk', 4150, 8.00, -2.7]] }, // Model Q (rms err 1.08 dB)
  { makeup: 8.03, s: [['hp', 69, 1.35, 0.0], ['lp', 4513, 2.36, 0.0], ['lp', 1310, 0.30, 0.0], ['pk', 1988, 3.17, 7.7], ['pk', 3280, 5.96, 6.8], ['pk', 725, 1.11, -5.2], ['pk', 7968, 4.87, -6.5], ['pk', 15047, 1.72, 8.0], ['pk', 2755, 5.42, -3.5], ['pk', 8629, 8.00, -0.9]] }, // Model R (rms err 0.55 dB)
  { makeup: -0.35, s: [['hp', 62, 2.44, 0.0], ['lp', 2956, 0.30, 0.0], ['lp', 3427, 3.13, 0.0], ['pk', 7548, 2.60, 8.2], ['pk', 4894, 4.94, 3.7], ['pk', 2283, 3.83, 5.3], ['pk', 5833, 8.00, -4.6], ['pk', 129, 0.95, 5.4], ['pk', 889, 2.99, 3.4], ['pk', 6354, 8.00, 2.8]] }, // Model S (rms err 0.64 dB)
  { makeup: 9.97, s: [['hp', 83, 1.25, 0.0], ['lp', 1167, 0.31, 0.0], ['lp', 4623, 2.44, 0.0], ['pk', 6850, 8.00, -14.0], ['pk', 2215, 2.81, 5.9], ['pk', 402, 1.53, -6.2], ['pk', 8084, 5.47, -5.0], ['pk', 2652, 8.00, -5.3], ['pk', 1401, 6.10, -4.1], ['pk', 617, 8.00, 2.1]] }, // Model T (rms err 0.61 dB)
];

export const CAB_MODELS = MODELS.length;
const SECS = 10;

/** One cascade (8 stereo biquads + makeup gain). */
class Cascade {
  readonly f: Biquad2[] = Array.from({ length: SECS }, () => new Biquad2());
  gain = 1;
  load(m: CabModel, sr: number): void {
    for (let i = 0; i < SECS; i++) {
      const [kind, f, q, g] = m.s[i];
      // sections above Nyquist are dropped (identity)
      if (f >= sr * 0.475) { this.f[i].set({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }); continue; }
      this.f[i].set(design(kind === 'pk' ? 'peaking' : kind === 'hp' ? 'highpass' : 'lowpass', f, q, g, sr));
    }
    this.gain = Math.pow(10, m.makeup / 20);
  }
  reset(): void { for (const b of this.f) b.reset(); }
  process(L: Float32Array, R: Float32Array, n: number): void {
    for (let i = 0; i < SECS; i++) this.f[i].process(L, R, n);
    const g = this.gain;
    for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  }
}

/** Cabinet stage: model 0 = off, 1..20 = Model A..T. */
export class Cabinet {
  private a = new Cascade();
  private b = new Cascade();
  private cur = 0; // model in cascade a
  private prev = 0; // model in cascade b while fading
  private fade = 0; // 1 -> 0: crossfade from b to a
  private readonly fadeStep: number;
  private readonly tmpL: Float32Array;
  private readonly tmpR: Float32Array;
  private readonly sr: number;

  constructor(sr: number, maxBlock: number) {
    this.sr = sr;
    this.fadeStep = 1 / Math.max(1, Math.round(0.03 * sr));
    this.tmpL = new Float32Array(maxBlock);
    this.tmpR = new Float32Array(maxBlock);
  }

  set(model: number): void {
    const m = Math.max(0, Math.min(CAB_MODELS, Math.round(model) || 0));
    if (m === this.cur) return;
    // the current cascade becomes the fading one; the new model loads into the other
    const t = this.a; this.a = this.b; this.b = t;
    this.prev = this.cur;
    this.cur = m;
    if (m > 0) { this.a.load(MODELS[m - 1], this.sr); this.a.reset(); }
    this.fade = 1;
  }

  reset(): void { this.a.reset(); this.b.reset(); this.fade = 0; }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.fade <= 0) {
      if (this.cur > 0) this.a.process(L, R, n);
      return;
    }
    // crossfade: tmp = old model output, L/R = new model output
    const tL = this.tmpL, tR = this.tmpR;
    for (let i = 0; i < n; i++) { tL[i] = L[i]; tR[i] = R[i]; }
    if (this.prev > 0) this.b.process(tL, tR, n);
    if (this.cur > 0) this.a.process(L, R, n);
    let f = this.fade;
    const st = this.fadeStep;
    for (let i = 0; i < n; i++) {
      L[i] = L[i] * (1 - f) + tL[i] * f;
      R[i] = R[i] * (1 - f) + tR[i] * f;
      f = f > st ? f - st : 0;
    }
    this.fade = f;
  }
}
