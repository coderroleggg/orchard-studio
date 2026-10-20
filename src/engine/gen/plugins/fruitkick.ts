// Fruit Kick (FL: Fruit Kick): "a sine wave with a fast volume envelope and a
// quickly falling initial pitch" (FL's manual). Reproduces FL 2026's own code
// (Fruit Kick_x64.dylib, TTestPlug: ProcessParam, TriggerVoice, Voice_Render;
// docs/research/gen/fruitkick.md), in FL's single precision and operation order:
//
// - A 32-bit phase reads FL's 16384-point host sine table (index = phase >> 18)
//   and advances by the rounded increment each sample.
// - TriggerVoice: start pitch = FinalLevels.Pitch / 2 + Max freq + 1200 cents
//   (relative to C5 = 523.25 Hz; the kick follows the key at half rate),
//   clamped to [Min freq - 3600, 4800]; the phase starts at Click << 24 (full
//   click = a quarter cycle: a cosine start); the amplitude starts at 1.5.
//   Later pitch changes (slides, the pitch knob) do not reach a running voice.
// - Per sample: out = sine x amp; amp *= Amp decay factor; the increment is
//   multiplied by the Freq decay factor until it reaches the end increment
//   (Min freq - 3600 cents, independent of the key), then held there.
// - Decay factors: x = 1 - v / 256, e = exp(x ln 1001) - 1 (0..1000), amp:
//   0.99998 - 4.98e-6 e, freq: 0.9997 - 9.7e-6 e, raised to 44100 / rate.
// - Distortion: FL's host DistWave_32FM (type A, threshold 10) on the voice,
//   dry 1 - d, wet 3.3 d (d = Distortion / 128), mul 0.1; the live kernel
//   truncates, the export kernel interpolates (FL's "HQ for all plugins").
// - The voice ends once its amplitude is below 0.0002 (checked per rendered
//   block, FL's Voice_Render result); a note off fades it out with FL's
//   sampler release: 441 samples of a raised cosine at any sample rate.
// - It renders at unity gain, centred: the channel applies velocity, volume and
//   FL's pan law (def.levels 'channel'), and its INS envelopes / filter.

import type { GenContext, GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import { flFinalPitch } from '../levels';
import { FL_WAVES } from '../../dsp/flwavetables';
import { distTable, distWaveHQ, distWaveLQ } from '../../effects/plugins/distructor/fastdist';

/** As many voices as a channel holds, so a voice the channel still renders is never reused. */
const MAX_VOICES = 128;
const f32 = Math.fround;
const SINE = FL_WAVES[0];
/** FL's C5 increment numerator: 523.2511306 Hz x 2^32. */
const C5_INC_SR = 2247346493527.166;
const CENT = Math.LN2 / 1200;
/** ln(1001): the decay knobs' exponential law. */
const LN1001 = 6.90875477931522;
const AMP_START = 1.5;
/** Voice_Render reports the end below this amplitude. */
const AMP_END = f32(0.0002);
/** FL's sampler release (note off without volume envelope): samples of the raised cosine. */
export const RELEASE_LEN = 441;
const DIST_TABLE = distTable(0, 10);
const DIST_MUL = f32(0.1);
/** Longest control step the channel renders (GenVoice.render n <= 16). */
const MAX_STEP = 16;

/** Round half to even (FL's frintx in the default rounding mode). */
function rint(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
}

/** FL's decay factor for a 0..256 knob: c0 - c1 (exp((1 - v/256) ln 1001) - 1), to the power 44100 / rate. */
export function decayFactor(v: number, c0: number, c1: number, srRatio: number): number {
  const x = f32(1 - f32(f32(v) * 0.00390625));
  const e = f32(Math.exp(x * LN1001) - 1);
  const d = f32(c0 - c1 * e);
  if (srRatio === 0) return 1;
  if (Number.isInteger(srRatio)) {
    let r = d;
    for (let i = 1; i < srRatio; i++) r = f32(r * d);
    return r;
  }
  return f32(Math.exp(srRatio * Math.log(d)));
}

class KickVoice implements GenVoice {
  free = true;
  phase = 0;
  inc = 0;
  amp = 0;
  /** Release fade position (0 = not released; 1..441 while fading). */
  rel = 0;
  /** The amplitude fell below the end level: the voice stops at the end of this block. */
  done = false;
  private p: GenVoiceParams | null = null;

  constructor(private readonly k: FruitKick) {}

  start(p: GenVoiceParams): void {
    const k = this.k;
    this.free = false;
    this.p = p;
    this.phase = (k.click << 24) >>> 0;
    const lo = k.min - 3600;
    const s1 = f32(f32(f32(flFinalPitch(p.levels) * 0.5) + k.max) + 1200);
    const c = s1 < lo ? lo : s1 > 4800 ? 4800 : s1;
    this.inc = f32(k.incOf(c));
    this.amp = f32(AMP_START);
    this.rel = 0;
    this.done = false;
  }

  render(L: Float32Array, R: Float32Array, n: number): boolean {
    const k = this.k;
    const buf = k.buf;
    const af = k.ampFactor, ff = k.freqFactor, mi = k.minIncF;
    let phase = this.phase, inc = this.inc, amp = this.amp;
    for (let i = 0; i < n; i++) {
      buf[i] = SINE[phase >>> 18] * amp;
      phase = (phase + rint(inc)) >>> 0;
      amp = f32(amp * af);
      inc = inc > mi ? f32(inc * ff) : mi;
    }
    this.phase = phase; this.inc = inc; this.amp = amp;
    if (k.dist > 0) (k.hq ? distWaveHQ : distWaveLQ)(buf, n, DIST_TABLE, k.distDry, k.distWet, DIST_MUL);
    let alive = true;
    if (this.rel > 0) {
      for (let i = 0; i < n; i++) {
        if (this.rel > RELEASE_LEN) { buf[i] = 0; alive = false; continue; }
        buf[i] *= 0.5 + 0.5 * Math.cos((Math.PI * this.rel) / (RELEASE_LEN + 1));
        this.rel++;
      }
      if (this.rel > RELEASE_LEN) alive = false;
    }
    for (let i = 0; i < n; i++) { L[i] += buf[i]; R[i] += buf[i]; }
    if (amp < AMP_END) this.done = true;
    // FL ends the voice after the block in which it fell silent (here: the engine block)
    if (this.done && (!this.p || this.p.frame + n >= k.blockSize)) alive = false;
    return alive;
  }

  /** Note off: FL's sampler fade (raised cosine, 441 samples). */
  release(): void {
    if (this.rel === 0) this.rel = 1;
  }

  kill(): void {
    this.free = true;
    this.p = null;
  }
}

class FruitKick implements GenInstance {
  readonly sampleRate: number;
  readonly blockSize: number;
  /** FL's C5 increment (single precision) and the decay exponent 44100 / rate. */
  private readonly incC5: number;
  private readonly srRatio: number;
  max = 0;
  min = -600;
  click = 32;
  dist = 0;
  distDry = 1;
  distWet = 0;
  ampFactor = 0;
  freqFactor = 0;
  /** End increment (FL keeps it as an integer, compares it as a float). */
  minIncF = 0;
  /** FL's export kernel for the distortion (ctx.rendering of the last block). */
  hq = false;
  readonly buf = new Float32Array(MAX_STEP);
  private readonly voices: KickVoice[] = [];

  constructor(sampleRate: number, blockSize: number) {
    this.sampleRate = sampleRate;
    this.blockSize = Math.max(1, blockSize | 0);
    this.incC5 = f32(C5_INC_SR / sampleRate);
    this.srRatio = f32(44100 / sampleRate);
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new KickVoice(this));
    this.setParams({});
  }

  /** FL's increment for a pitch in cents relative to C5 (rounded to an integer). */
  incOf(cents: number): number {
    return rint(this.incC5 * Math.exp(cents * CENT));
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    const num = (key: string, d: number, lo: number, hi: number) => {
      const v = Number(q[key] ?? d);
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;
    };
    this.max = num('max', 0, -2400, 3600);
    this.min = num('min', -600, -1200, 1200);
    this.freqFactor = decayFactor(num('freqDecay', 64, 0, 256), 0.9997, 9.700000000000043e-6, this.srRatio);
    this.ampFactor = decayFactor(num('ampDecay', 128, 0, 256), 0.99998, 4.9799999999999845e-6, this.srRatio);
    this.click = num('click', 32, 0, 64);
    this.dist = num('dist', 0, 0, 128);
    const d = f32(this.dist * 0.0078125);
    this.distDry = f32(1 - d);
    this.distWet = f32(d * 3.3);
    this.minIncF = f32(this.incOf(this.min - 3600));
  }

  triggerVoice(p: GenVoiceParams): GenVoice | null {
    for (const v of this.voices) {
      if (!v.free) continue;
      v.start(p);
      return v;
    }
    return null;
  }

  render(_L: Float32Array, _R: Float32Array, _n: number, ctx: GenContext): void {
    this.hq = !!ctx.rendering;
  }

  reset(): void {
    for (const v of this.voices) v.kill();
  }
}

export const gen: GenModule = {
  id: 'fruitkick',
  create: (sampleRate, blockSize) => new FruitKick(sampleRate, blockSize),
};
