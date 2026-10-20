// 3x Osc (FL: 3x Osc, Plugin database > Generators > Synth classic): three
// oscillators (sine, triangle, square, saw, rounded saw, noise or the
// channel's custom shape) with coarse / fine pitch, panning, stereo phase
// offset and detune, mix levels, inversion, AM by oscillator 3, stereo phase
// randomness and the HQ (anti-aliased) oscillators.
//
// A port of FL Studio 2026's plugin (3x Osc_x64.dylib, TTestPlug, arm64:
// ProcessParam 0x5d550, levels 0x5d3c0, pans 0x5d350, stereo flag 0x5d4b0,
// TriggerVoice 0x5dec0, Voice_Render 0x5e2b0, oscillator kernels
// 0x5e150 / 0x5e1b0 / 0x5e210, export anti-aliasing 0x5e7a0, pitch -> speed
// 0x6ca70) and of the channel-sampler voice code linked into it (render /
// mix 0x1ccdd0, gain ramp 0x71480 and kernels 0x3488 / 0x3768, pan law
// 0x2ba0, release fade 0x1d3950), in FL's single precision. The HQ
// oscillators are engine.dylib (./3xosc/hq.ts). See docs/research/gen/3xosc.md.
//
// Per voice and FL render block (here: the channel's audio block):
// - each oscillator's 32-bit phase advances by speed = round(f32(2^32 x
//   523.2511 Hz / rate) x e^(cents x ln2 / 1200)) (cents = the voice's pitch
//   level + coarse x 100 + fine, + detune for the right channel), read once
//   per block; the non-HQ shapes read FL's host wavetables at phase >>> 18
//   (no interpolation); noise reads the noise table at a random speed drawn
//   per block (FPC's Random);
// - oscillator 1 is written, 2 and 3 added (osc 3 multiplies instead with AM
//   on: out - out x osc3); an oscillator at level 0 is skipped (its phase
//   still advances); levels: l3 = mix3 / 128, l2 = (1 - l3) x mix2 / 128
//   (1 x mix2 / 128 with AM), l1 = (1 - l3) - l2 (1 - l2), negated when
//   inverted, panned with FL's pan law (0.7071 each side at the centre);
// - mono (the right channel copies the left) unless some oscillator pans,
//   detunes, offsets its phase, plays noise, or phase randomness is on (then
//   the voice stays stereo);
// - the voice is then scaled by FL's pan law of its pan / volume levels
//   (velocity, channel volume and the INS envelopes arrive in the levels:
//   def.levels 'plugin'), ramped from block to block at most 0.001 per sample
//   (FL's ramp kernel, even / odd sample accumulators), without a ramp at the
//   voice's start;
// - a note off starts FL's 441-sample cosine fade (10 ms built at 44.1 kHz,
//   at every rate); the voice ends with it. The plugin never ends a voice by
//   itself otherwise (the INS volume envelope, when on, does).
// - FL's export ("HQ for all plugins", ctx.rendering) averages the non-sine,
//   non-noise shapes over max(1, speed >>> 22) phase offsets within each
//   sample (box anti-aliasing) unless HQ is on.

import type { GenContext, GenEnv, GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import { PITCH_C5 } from '../levels';
import { FL_TABLES, FADE, FADE_LEN, WAVE_SIZE } from './3xosc/tables';
import { rng } from './3xosc/rng';
import { HqOsc } from './3xosc/hq';

export { seed3xOscRandom } from './3xosc/rng';
export { resetHqNoise } from './3xosc/hq';

const fr = Math.fround;
/** As many voices as a channel holds, so a voice the channel still renders is never reused. */
const MAX_VOICES = 128;
/** 2^32 x FL's C5 (523.2511 Hz): speed = f32(C / rate) x 2^(cents / 1200). */
const C5_SPEED = 2247346493527.166;
/** ln 2 / 1200, as FL computes it (ln 2 / 12 / 100 in double). */
const K_CENTS = 0.057762265046662105 / 100;
/** Noise speed: Random(0x99326) + 0x99326 per block. */
const NOISE_SPEED = 0x99326;
/** FL's voice gain ramp limit per sample. */
const MAX_STEP = fr(0.001);
const PI_4 = 0.7853981633974483;
const SINE = FL_TABLES[0];
const NOISE = FL_TABLES[5];

/** FL's pan law (ComputeLRVol / the voice engine's 0x2ba0): f32 gains for a pan -1..1 and volume. */
function lrVol(pan: number, vol: number, out: { l: number; r: number }): void {
  const p = pan >= -1 ? (pan > 1 ? 1 : pan) : -1; // NaN -> -1 (FL's ComputeLRVol)
  const a = fr(fr(p + 1) * PI_4);
  out.l = fr(fr(Math.cos(a)) * vol);
  out.r = fr(fr(Math.sin(a)) * vol);
}

/** FL's pitch -> phase increment (0x6ca70): a 32-bit unsigned speed. */
function speedOf(e8: number, cents: number): number {
  const v = e8 * Math.exp(cents * K_CENTS);
  if (!(v === v)) return 0;
  if (!(v < 9223372036854775808)) return 0xffffffff;
  let r = Math.round(v);
  if (r - v === 0.5 && r % 2 !== 0) r -= 1; // frintx: ties to even
  return (r % 4294967296) >>> 0;
}

/** FL's ramp step (0x71480): step over `len` samples from `last` to `target`, clamped to +-max (then the target follows). */
function rampStep(target: number, len: number, last: number, out: { step: number; target: number }): void {
  let step = fr(target - last);
  out.target = target;
  if (Object.is(step, 0)) { out.step = 0; return; }
  step = fr(step / len);
  if (Math.abs(step) > MAX_STEP) {
    step = step < 0 ? -MAX_STEP : MAX_STEP;
    let t = fr(last + fr(step * len));
    if (Math.abs(t) < 5.960464477539063e-8) { t = 0; step = fr(-last / len); }
    out.target = t;
  }
  out.step = step;
}

/** Non-HQ oscillator kernels (0x5e150 add, 0x5e1b0 write, 0x5e210 AM): returns the new phase. */
function oscAdd(t: Float32Array, out: Float32Array, n: number, ph: number, sp: number, g: number): number {
  for (let k = 0; k < n; k++) { out[k] += fr(t[ph >>> 18] * g); ph = (ph + sp) >>> 0; }
  return ph;
}
function oscWrite(t: Float32Array, out: Float32Array, n: number, ph: number, sp: number, g: number): number {
  for (let k = 0; k < n; k++) { out[k] = t[ph >>> 18] * g; ph = (ph + sp) >>> 0; }
  return ph;
}
function oscAM(t: Float32Array, out: Float32Array, n: number, ph: number, sp: number, g: number): number {
  for (let k = 0; k < n; k++) { const d = out[k]; out[k] = d - fr(d * fr(t[ph >>> 18] * g)); ph = (ph + sp) >>> 0; }
  return ph;
}

/** One oscillator's derived values (FL's 0x28-byte records at plugin +0x190). */
interface Osc {
  /** Coarse x 100 + fine (cents). */
  pitch: number;
  /** Mix level (f32), negated when inverted. */
  level: number;
  /** Level is +0: the oscillator is skipped. */
  skip: boolean;
  gainL: number;
  gainR: number;
  /** Start phase of the right channel (stereo phase offset x 0x1ffffff). */
  phaseR: number;
  /** Stereo detune (cents, right channel). */
  detune: number;
  /** Non-HQ table (FL's host wavetable or the custom shape). */
  table: Float32Array;
  noise: boolean;
  /** Export anti-aliasing applies (not sine, not noise). */
  special: boolean;
  /** Shape handed to the HQ engine (custom without a sample plays the saw). */
  hqShape: number;
}

const newOsc = (): Osc => ({ pitch: 0, level: 0, skip: true, gainL: 0, gainR: 0, phaseR: 0, detune: 0, table: SINE, noise: false, special: false, hqShape: 0 });

class OscVoice implements GenVoice {
  params: GenVoiceParams | null = null;
  free = true;
  private readonly phL = new Uint32Array(3);
  private readonly phR = new Uint32Array(3);
  private readonly spL = new Uint32Array(3);
  private readonly spR = new Uint32Array(3);
  /** The current FL block's oscillator output (FL renders a voice's whole block before mixing it). */
  bufL: Float32Array;
  bufR: Float32Array;
  private stereo = false;
  /** Release fade position (-1 = not released). */
  private fade = -1;
  private first = true;
  /** Frames left in the current FL block, and the position in it. */
  private remain = 0;
  private pos = 0;
  // the current block's gain ramp (FL: last / target gains, steps, kernel accumulators)
  private lastL = 0;
  private lastR = 0;
  private tgtL = 0;
  private tgtR = 0;
  private stepL = 0;
  private stepR = 0;
  private ramp = false;
  private evenL = 0;
  private evenR = 0;
  private oddL = 0;
  private oddR = 0;
  private tailStart = 0;

  constructor(private readonly k: ThreeOsc, size: number) {
    this.bufL = new Float32Array(size);
    this.bufR = new Float32Array(size);
  }

  start(p: GenVoiceParams): void {
    const k = this.k;
    this.params = p;
    this.free = false;
    this.fade = -1;
    this.first = true;
    this.remain = 0;
    this.stereo = k.stereo;
    for (let i = 0; i < 3; i++) {
      let l = 0, r = k.osc[i].phaseR;
      if (k.randAmt !== 0) {
        const h = k.randAmt >>> 1;
        l = (l + ((rng.random(k.randAmt) - h) * 256)) >>> 0;
        r = (r + ((rng.random(k.randAmt) - h) * 256)) >>> 0;
      }
      this.phL[i] = l;
      this.phR[i] = r;
    }
  }

  /**
   * A new FL block of `len` frames (FL: Voice_Render then the engine's mix):
   * speeds from the pitch level (noise: random draws), the oscillators for
   * the whole block (left pass, then right pass or a copy), and the gain ramp
   * toward the current pan / volume levels.
   */
  private beginBlock(p: GenVoiceParams, len: number): void {
    const k = this.k;
    if (!this.first) { this.lastL = this.tgtL; this.lastR = this.tgtR; }
    const pitch = fr(p.levels.pitch - PITCH_C5);
    for (let i = 0; i < 3; i++) {
      const o = k.osc[i];
      this.spL[i] = o.noise ? rng.random(NOISE_SPEED) + NOISE_SPEED : speedOf(k.e8, fr(pitch + o.pitch));
    }
    this.pass(this.bufL, len, false);
    if (k.stereo) this.stereo = true;
    if (this.stereo) {
      for (let i = 0; i < 3; i++) {
        const o = k.osc[i];
        this.spR[i] = o.noise ? rng.random(NOISE_SPEED) + NOISE_SPEED : speedOf(k.e8, fr(fr(pitch + o.pitch) + o.detune));
      }
      this.pass(this.bufR, len, true);
    } else {
      const bl = this.bufL, br = this.bufR;
      for (let i = 0; i < len; i++) br[i] = bl[i];
      this.phR.set(this.phL);
    }
    const g = k.lr;
    const vol = fr(p.levels.vol);
    lrVol(fr(p.levels.pan), vol === vol ? vol : 0, g);
    if (this.first) {
      this.first = false;
      this.lastL = this.tgtL = g.l;
      this.lastR = this.tgtR = g.r;
      this.stepL = this.stepR = 0;
      this.ramp = false;
    } else {
      const rs = k.rs;
      rampStep(g.l, len, this.lastL, rs); this.stepL = rs.step; this.tgtL = rs.target;
      rampStep(g.r, len, this.lastR, rs); this.stepR = rs.step; this.tgtR = rs.target;
      this.ramp = !(Object.is(this.stepL, 0) && Object.is(this.stepR, 0));
    }
    this.evenL = this.lastL;
    this.evenR = this.lastR;
    this.oddL = fr(this.lastL + this.stepL);
    this.oddR = fr(this.lastR + this.stepR);
    this.tailStart = len - (len % 8);
    this.remain = len;
    this.pos = 0;
  }

  /** One channel pass of the three oscillators into `out` (FL: Voice_Render's loop). */
  private pass(out: Float32Array, n: number, right: boolean): void {
    const k = this.k;
    const ph = right ? this.phR : this.phL;
    const spd = right ? this.spR : this.spL;
    let first = true;
    for (let i = 0; i < 3; i++) {
      const o = k.osc[i];
      const sp = spd[i];
      if (o.skip) { ph[i] = ph[i] + Math.imul(sp, n); continue; }
      const g = right ? o.gainR : o.gainL;
      if (k.hq) {
        if (i === k.amOsc) ph[i] = k.hqOsc.add(o.hqShape, out, n, g, ph[i], sp, true);
        else {
          if (first) { out.fill(0, 0, n); first = false; }
          ph[i] = k.hqOsc.add(o.hqShape, out, n, g, ph[i], sp, false);
        }
      } else if (i === k.amOsc) {
        ph[i] = oscAM(o.table, out, n, ph[i], sp, g);
      } else if (k.hqAll && o.special) {
        // export anti-aliasing (0x5e7a0): max(1, speed >>> 22) copies, phase-spread over one sample
        const cnt = Math.max(1, sp >>> 22);
        const step = Math.trunc((sp | 0) / cnt) >>> 0;
        const gs = fr(g / cnt);
        let p0 = ph[i];
        if (first) { ph[i] = oscWrite(o.table, out, n, p0, sp, gs); first = false; }
        else ph[i] = oscAdd(o.table, out, n, p0, sp, gs);
        for (let j = 1; j < cnt; j++) { p0 = (p0 + step) >>> 0; oscAdd(o.table, out, n, p0, sp, gs); }
      } else if (first) {
        ph[i] = oscWrite(o.table, out, n, ph[i], sp, g);
        first = false;
      } else {
        ph[i] = oscAdd(o.table, out, n, ph[i], sp, g);
      }
    }
  }

  render(L: Float32Array, R: Float32Array, n: number): boolean {
    const p = this.params;
    if (!p) return false;
    const k = this.k;
    for (let j = 0; j < n;) {
      if (this.remain === 0) {
        // FL blocks follow the channel's blocks: the first one ends with the current block
        const len = this.first ? Math.max(1, Math.min(this.bufL.length, k.flBlock - p.frame - j)) : Math.min(this.bufL.length, k.flBlock);
        this.beginBlock(p, len);
      }
      const m = Math.min(n - j, this.remain);
      const bl = this.bufL, br = this.bufR;
      let f = this.pos;
      const end = f + m;
      // release fade (FL's out declick: the voice ends with it)
      if (this.fade >= 0) {
        for (let i = f; i < end; i++) {
          const q = this.fade++;
          if (q < FADE_LEN) { const t = FADE[q]; bl[i] *= t; br[i] *= t; }
          else { bl[i] = 0; br[i] = 0; }
        }
      }
      // voice gain: constant, or FL's ramp kernel (pairs of samples: even / odd accumulators; tail with crossed steps)
      if (!this.ramp) {
        const gl = this.tgtL, gr = this.tgtR;
        for (let i = f, o = j; i < end; i++, o++) { L[o] += fr(bl[i] * gl); R[o] += fr(br[i] * gr); }
      } else {
        const s2L = fr(this.stepL + this.stepL), s2R = fr(this.stepR + this.stepR);
        for (let o = j; f < end; f++, o++) {
          if (f < this.tailStart) {
            if ((f & 1) === 0) {
              L[o] += fr(bl[f] * this.evenL); R[o] += fr(br[f] * this.evenR);
            } else {
              L[o] += fr(bl[f] * this.oddL); R[o] += fr(br[f] * this.oddR);
              this.evenL = fr(this.evenL + s2L); this.evenR = fr(this.evenR + s2R);
              this.oddL = fr(this.oddL + s2L); this.oddR = fr(this.oddR + s2R);
            }
          } else {
            L[o] += fr(bl[f] * this.evenL); R[o] += fr(br[f] * this.evenR);
            const el = fr(this.evenL + this.stepR);
            this.evenR = fr(this.evenR + this.stepL);
            this.evenL = el;
          }
        }
      }
      this.pos += m;
      this.remain -= m;
      j += m;
    }
    return this.fade < FADE_LEN;
  }

  release(): void {
    if (this.fade < 0) this.fade = 0;
  }

  kill(): void {
    this.free = true;
    this.params = null;
  }
}

const num = (q: Record<string, unknown>, key: string, d: number, lo: number, hi: number): number => {
  const v = Number(q[key] ?? d);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;
};

/** The channel sample as FL's 16384-point custom shape (approximation: mono mix, linear resampling of the whole sample). */
function customShape(chs: Float32Array[]): Float32Array | null {
  const len = chs[0]?.length ?? 0;
  if (len < 1) return null;
  const out = new Float32Array(WAVE_SIZE);
  const nc = chs.length;
  const at = (i: number): number => {
    let s = 0;
    for (let c = 0; c < nc; c++) s += chs[c][i];
    return s / nc;
  };
  for (let i = 0; i < WAVE_SIZE; i++) {
    const x = (i * len) / WAVE_SIZE;
    const i0 = Math.floor(x), f = x - i0;
    const a = at(Math.min(len - 1, i0)), b = at(Math.min(len - 1, i0 + 1));
    out[i] = a + (b - a) * f;
  }
  return out;
}

class ThreeOsc implements GenInstance {
  readonly sampleRate: number;
  /** f32(2^32 x 523.2511 / rate) (FL: plugin +0xe8). */
  readonly e8: number;
  /** Length of an FL render block for the voice gain ramp (the channel's audio block). */
  flBlock: number;
  readonly osc: Osc[] = [newOsc(), newOsc(), newOsc()];
  /** Oscillator used as amplitude modulator (2 with AM on, else -1). */
  amOsc = -1;
  /** Phase randomness (rand << 18). */
  randAmt = 0;
  /** FL's stereo flag (+0x218). */
  stereo = false;
  hq = false;
  /** Export anti-aliasing ("HQ for all plugins": FL's PM_HQ_NonRealtime). */
  hqAll = false;
  readonly hqOsc = new HqOsc();
  readonly lr = { l: 0, r: 0 };
  readonly rs = { step: 0, target: 0 };
  private readonly voices: OscVoice[] = [];
  private custom: Float32Array | null = null;
  private customSrc: Float32Array | null = null;
  private sampleId = '';
  private last: Record<string, unknown> = {};

  constructor(sampleRate: number, blockSize: number, private readonly env: GenEnv) {
    this.sampleRate = sampleRate;
    this.e8 = fr(C5_SPEED / sampleRate);
    this.flBlock = Math.max(1, blockSize | 0);
    this.hqOsc.setSampleRate(sampleRate);
    const size = Math.max(16, this.flBlock);
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new OscVoice(this, size));
    this.setParams({});
  }

  /** Test hook (FL test host parity): the length of the next FL blocks. */
  setBlockLength(n: number): void {
    this.flBlock = Math.max(1, n | 0);
    for (const v of this.voices) {
      if (v.bufL.length >= this.flBlock) continue;
      const a = new Float32Array(this.flBlock), b = new Float32Array(this.flBlock);
      a.set(v.bufL); b.set(v.bufR);
      v.bufL = a; v.bufR = b;
    }
  }

  /** Pick up the custom shape sample once the pool delivers it. */
  private syncCustom(): void {
    const s = this.sampleId ? this.env.sample(this.sampleId) : undefined;
    const src = s?.channels[0] ?? null;
    if (src === this.customSrc) return;
    this.customSrc = src;
    this.custom = s && src ? customShape(s.channels) : null;
    this.hqOsc.setCustomWave(this.custom);
    this.derive(this.last);
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    this.last = q;
    const id = typeof q.sample === 'string' ? q.sample : '';
    if (id !== this.sampleId) { this.sampleId = id; this.customSrc = null; this.custom = null; this.hqOsc.setCustomWave(null); }
    this.derive(q);
    this.syncCustom();
  }

  private derive(q: Record<string, unknown>): void {
    const am = q.am === true;
    const mix2 = num(q, 'mix2', 64, 0, 128), mix3 = num(q, 'mix3', 64, 0, 128);
    // levels (0x5d3c0)
    const l3 = fr(mix3 * 0.0078125);
    const s0 = am ? 1 : fr(1 - l3);
    const l2 = fr(fr(s0 * mix2) * 0.0078125);
    const l1 = fr(s0 - l2);
    const lv = [l1, l2, l3];
    let stereo = false;
    const rand = num(q, 'rand', 0, 0, 64);
    if (rand !== 0) stereo = true;
    for (let i = 0; i < 3; i++) {
      const n = i + 1, o = this.osc[i];
      const shape = num(q, `shape${n}`, 0, 0, 6);
      const pan = num(q, `pan${n}`, 0, -64, 64);
      o.pitch = num(q, `coarse${n}`, 0, -24, 24) * 100 + num(q, `fine${n}`, 0, -100, 100);
      o.phaseR = Math.imul(num(q, `phase${n}`, 0, -64, 64), 0x1ffffff) >>> 0;
      o.detune = num(q, `detune${n}`, 0, -50, 50);
      o.table = shape > 5 ? (this.custom ?? FL_TABLES[3]) : FL_TABLES[shape];
      o.noise = shape === 5;
      o.special = !o.noise && o.table !== SINE;
      o.hqShape = shape > 5 && !this.custom ? 3 : shape;
      const level = q[`inv${n}`] === true ? -lv[i] : lv[i];
      o.level = level;
      o.skip = Object.is(level, 0);
      lrVol(fr(pan * 0.015625), level, this.lr);
      o.gainL = this.lr.l;
      o.gainR = this.lr.r;
      if (o.table === NOISE || o.phaseR !== 0 || o.detune !== 0 || pan !== 0) stereo = true;
    }
    this.amOsc = am ? 2 : -1;
    this.randAmt = (rand << 18) >>> 0;
    this.stereo = stereo;
    this.hq = q.hq === true;
    if (this.hq) for (const o of this.osc) this.hqOsc.prepare(o.hqShape);
  }

  triggerVoice(p: GenVoiceParams): GenVoice | null {
    if (this.sampleId) this.syncCustom();
    for (const v of this.voices) {
      if (!v.free) continue;
      v.start(p);
      return v;
    }
    return null;
  }

  render(_L: Float32Array, _R: Float32Array, _n: number, ctx: GenContext): void {
    this.hqAll = !!ctx.rendering;
  }

  reset(): void {
    for (const v of this.voices) v.kill();
  }
}

export const gen: GenModule = {
  id: '3xosc',
  create: (sampleRate, blockSize, env) => new ThreeOsc(sampleRate, blockSize, env),
};
