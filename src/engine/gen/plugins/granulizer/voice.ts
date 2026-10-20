// Fruity Granulizer's voice (FL 2026, Fruity Granulizer_x64.dylib, arm64): the grain engine of
// Voice_Render (0x64b00) with AddGrain (0x645c0) and TriggerVoice (0x63b20), followed by FL's
// channel sampler processing compiled into the plugin (the release declick, the voice levels). See
// docs/research/gen/granulizer.md.
//
// A voice schedules grains in the order FL does: every `spacing` samples a grain starts at the
// voice's source position (a float32 that advances by the wave spacing per grain, with the LFO,
// the randomness and the loop / end handling); a grain fades in over the attack time, holds, and
// fades out (linear gain ramps accumulated in float32 per mixed segment); its samples come from a
// TResampler at the grain's pitch and are added to the voice's output with the grain's panning
// gains (odd / even grains alternate sides by the stereo separation).

import type { GenVoice, GenVoiceParams } from '../../types';
import { PITCH_C5 } from '../../levels';
import { GrainReader, type GranSample } from './reader';
import { RELEASE_GAINS } from './release';
import { appleExp, appleSin } from './libm';
import type { FpcRandom } from './random';
import type { GranulizerState } from '../../../../model/gen/plugins/granulizer/state';

const f32 = Math.fround;
/** FL's level ramp: at most this gain change per sample. */
const MAX_STEP = f32(0.001);
/** Gains below 2^-24 snap to 0 after a clamped ramp (FL 0x6f460). */
const TINY = f32(5.960464477539063e-8);
/** The release declick: 441 samples at any sample rate (FL's INS processor). */
export const RELEASE_LEN = 441;
/** The grains' stereo compensation passed to ComputeLRVol (FL 0x1f05f0). */
const GRAIN_PAN_VOL = f32(1.42);
/** The release declick's gain of sample k (FL's table, ./release.ts); setReleaseTable replaces it (tests). */
let releaseTable: Float32Array = RELEASE_GAINS;
export function setReleaseTable(t: Float32Array | null): void {
  releaseTable = t ?? RELEASE_GAINS;
}
function releaseGain(k: number): number {
  return releaseTable[k];
}
/** Largest block voice.block() renders at once. */
export const MAX_BLOCK = 1024;

/** Round half to even (ARM frintx). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** int32 wrap-around of an integer sum. */
function i32(x: number): number {
  return x | 0;
}

/** The plugin's derived values (FL's TTestPlug fields recalculated by 0x62580 on every parameter change). */
export interface GranConfig {
  s: GranulizerState;
  sample: GranSample | null;
  /** Sample length - 1 (FL +0x120), 0 without a sample. */
  last: number;
  /** FL +0x168: the loop region's length (the sample length). */
  len: number;
  hostRate: number;
  /** FL +0x180 / 0x184 / 0x188 / 0x18c: attack, hold, transient hold, attack + hold in samples (float32). */
  att: number;
  hold: number;
  tHold: number;
  sum: number;
  /** +0x190 1 / (attack + hold), +0x194 grain spacing in samples, +0x19c wave step per grain, +0x1a0 (attack + hold) / max(step, 1). */
  inv: number;
  spacing: number;
  step: number;
  stepRatio: number;
  /** +0x1a4 LFO amount, +0x1a8 LFO phase step. */
  depth: number;
  lfo: number;
  /** +0x198 sample start in frames. */
  start: number;
  /** +0x1cc: looping. */
  looping: boolean;
  /** Song tempo (+0x1b4) and fit time in beats (+0x1b0, 0 = none). */
  tempo: number;
  fit: number;
  /** Transient positions (frames) of the sample, ascending, for the transient logic and the Transient key mode. */
  transients: readonly number[];
  /** FPD_ProcessMode interpolation points. */
  points: number;
  rnd: FpcRandom;
}

class Grain {
  readonly reader = new GrainReader();
  /** Current gain and its slope per sample (FL +0x08, +0x0c). */
  g = 0;
  slope = 0;
  /** Pan gains of the left / right output (+0x10, +0x14). */
  gl = 0;
  gr = 0;
  /** Position counter, hold end, fade-out end, start delay in the block (+0x18, +0x1c, +0x20, +0x24). */
  pos = 0;
  holdEnd = 0;
  end = 0;
  delay = 0;
}

/** One gain ramp (FL 0x6f460): the step; `t` holds the target (moved when the slope is clamped). */
function rampStep(t: { v: number }, last: number, len: number): number {
  let step = f32(t.v - last);
  if (step === 0 && 1 / step > 0) return 0;
  step = f32(step / len);
  if (Math.abs(step) > MAX_STEP) {
    step = step < 0 || Object.is(step, -0) ? -MAX_STEP : MAX_STEP;
    t.v = f32(last + f32(step * len));
    if (Math.abs(t.v) < TINY) { t.v = 0; step = f32(-last / len); }
  }
  return step;
}

/** FL's circular pan law (ComputeLRVol): left / right gains of a pan (-1..1) at volume `vol`, float32. */
function lrGains(pan: number, vol: number, out: Float32Array): void {
  const p = pan < -1 ? -1 : pan > 1 ? 1 : pan;
  const a = f32(f32(p + 1) * 0.7853981633974483);
  out[0] = f32(f32(Math.cos(a)) * vol);
  out[1] = f32(f32(Math.sin(a)) * vol);
}

/** NEON kernel 0x5a34: dst += src x [gl, gr] for n frames (interleaved). */
function addGain(src: Float32Array, so: number, dst: Float32Array, dof: number, n: number, gl: number, gr: number): void {
  for (let i = 0; i < n; i++) {
    const a = 2 * (so + i), b = 2 * (dof + i);
    dst[b] = f32(f32(src[a] * gl) + dst[b]);
    dst[b + 1] = f32(f32(src[a + 1] * gr) + dst[b + 1]);
  }
}

/**
 * NEON ramp kernel 0x5d14: dst += src x gains, the gains starting at [gl, gr] and stepping by [dl, dr]:
 * frame pairs are stepped by two steps in groups of 8 frames; the remaining frames step left by the
 * right step and vice versa.
 */
function addRamp(src: Float32Array, so: number, dst: Float32Array, dof: number, n: number, gl: number, gr: number, dl: number, dr: number): void {
  let g0 = gl, g1 = gr, g2 = f32(gl + dl), g3 = f32(gr + dr);
  let i = 0;
  if (n >= 8) {
    const d0 = f32(dl + dl), d1 = f32(dr + dr);
    for (; n - i >= 8;) {
      for (let k = 0; k < 4; k++, i += 2) {
        let a = 2 * (so + i), b = 2 * (dof + i);
        dst[b] = f32(f32(src[a] * g0) + dst[b]);
        dst[b + 1] = f32(f32(src[a + 1] * g1) + dst[b + 1]);
        a += 2; b += 2;
        dst[b] = f32(f32(src[a] * g2) + dst[b]);
        dst[b + 1] = f32(f32(src[a + 1] * g3) + dst[b + 1]);
        g0 = f32(d0 + g0); g1 = f32(d1 + g1); g2 = f32(d0 + g2); g3 = f32(d1 + g3);
      }
    }
  }
  for (; i < n; i++) {
    const a = 2 * (so + i), b = 2 * (dof + i);
    dst[b] = f32(f32(src[a] * g0) + dst[b]);
    dst[b + 1] = f32(f32(src[a + 1] * g1) + dst[b + 1]);
    g0 = f32(dr + g0); g1 = f32(dl + g1);
  }
}

export class GranVoice implements GenVoice {
  free = true;
  released = false;
  private params: GenVoiceParams | null = null;
  private cfg: GranConfig | null = null;
  // ---- the plugin's voice record (FL 0x3e bytes)
  /** +0x08 pitch offset in cents that cancels the key in the other KEY TO modes. */
  private pitchOfs = 0;
  /** +0x1c grains created (its parity picks the side). */
  private counter = 0;
  /** +0x20 start time of the next grain, +0x24 samples rendered. */
  private nextGrain = 0;
  private time = 0;
  /** +0x28 last transient found. */
  private lastTransient = -1;
  /** +0x2c source position, +0x30 LFO phase (float32). */
  private position = 0;
  private phase = 0;
  /** +0x34 the source position ran out, +0x35 it wrapped around the loop. */
  private exhausted = false;
  private wrapped = false;
  private grains: Grain[] = [];
  private count = 0;
  private pool: Grain[] = [];
  // ---- buffers
  private readonly raw = new Float32Array(2 * MAX_BLOCK);
  private readonly tmp = new Float32Array(2 * MAX_BLOCK);
  private readonly pan2 = new Float32Array(2);
  // ---- FL's channel sampler stage
  private rel = -1;
  private lastL = NaN;
  private lastR = NaN;
  private readonly t = { v: 0 };
  /** Grain engine finished (Voice_Render returned 1). */
  private done = false;

  get active(): boolean {
    return !this.free;
  }

  /** The voice's source position in frames (the editor's cursor). */
  get cursor(): number {
    return this.position;
  }

  /** FL's TriggerVoice (0x63b20): the voice's first position from the KEY TO mode and the sample start. */
  start(p: GenVoiceParams, cfg: GranConfig): void {
    const s = cfg.s;
    this.params = p;
    this.cfg = cfg;
    this.free = false;
    this.released = false;
    this.done = false;
    this.rel = -1;
    this.lastL = NaN;
    this.lastR = NaN;
    this.nextGrain = 0;
    this.time = 0;
    this.lastTransient = -1;
    this.counter = 0;
    this.phase = 0;
    this.exhausted = false;
    this.wrapped = false;
    for (let i = 0; i < this.count; i++) this.freeGrain(this.grains[i]);
    this.count = 0;
    this.position = f32(cfg.start);
    this.pitchOfs = 0;
    if (s.trigger > 0) {
      const key = p.key;
      this.pitchOfs = f32(-(key - 60) * 100);
      const k = Math.max(key - 60, 0);
      let off = 0;
      if (s.trigger === 1) off = (cfg.last * k) / 24;
      else if (s.trigger === 2) {
        off = k * 0.25;
        if (cfg.fit > 0) off = (cfg.last * off) / cfg.fit;
        else off = (off * 60 * (cfg.sample ? cfg.sample.rate : 0)) / cfg.tempo;
      } else if (s.trigger === 3) {
        off = cfg.transients.length ? cfg.transients[k % cfg.transients.length] : 0;
      }
      const base = roundEven(this.position + off);
      this.position = f32(base % (cfg.last + 1));
    }
  }

  private newGrain(): Grain {
    const g = this.pool.pop() ?? new Grain();
    if (this.count === this.grains.length) this.grains.push(g); else this.grains[this.count] = g;
    this.count++;
    return g;
  }

  private freeGrain(g: Grain): void {
    g.reader.stop();
    this.pool.push(g);
  }

  /** FL's AddGrain (0x645c0). */
  private addGrain(pos: number, delay: number, att: number, hold: number): void {
    const cfg = this.cfg!;
    const s = cfg.s;
    if (pos > cfg.last) return;
    const g = this.newGrain();
    this.counter = i32(this.counter + 1);
    const sample = cfg.sample!;
    const loop = cfg.looping;
    // the reader: speed of FinalLevels.Pitch (+ the key offset) at the sample / host rate ratio
    const cents = f32(f32(this.params!.levels.pitch - PITCH_C5) + this.pitchOfs);
    const ratio = sample.rate * (1 / cfg.hostRate);
    let speed: number;
    if (cents === 0 && ratio === 1) speed = 1; else speed = appleExp(cents * 0.0005776226504666211) * ratio;
    if (!Number.isFinite(speed) || speed <= 0) speed = 1;
    g.reader.start(sample, loop, pos, speed, cfg.points);
    g.pos = i32(-att);
    g.holdEnd = hold;
    g.end = i32(att + hold);
    g.delay = delay;
    g.slope = f32(1.0 / att);
    g.g = g.slope;
    const pan = f32(s.stereo * 0.015625);
    lrGains(pan, GRAIN_PAN_VOL, this.pan2);
    if ((this.counter & 1) === 0) { g.gl = this.pan2[0]; g.gr = this.pan2[1]; } else { g.gr = this.pan2[0]; g.gl = this.pan2[1]; }
  }

  /** The scheduling loop of Voice_Render: grains due before the end of this block. */
  private schedule(old: number): void {
    const cfg = this.cfg!;
    const s = cfg.s;
    const lastF = f32(cfg.last);
    while (this.nextGrain < this.time) {
      let norm = 1.0;
      const att = cfg.att;
      let hold = cfg.hold;
      let pos = roundEven(this.position);
      let randomized = false;
      if (s.random > 0 && !s.holdSound) {
        if (255 - cfg.rnd.random(256) < s.random) {
          pos += cfg.rnd.random(cfg.len);
          while (pos > cfg.last) pos -= cfg.len;
          randomized = true;
        }
      }
      if (!randomized && cfg.transients.length > 0 && cfg.step > 0) {
        // transient logic (FL 0x64ca0): a grain that would cross a transient is aligned to it
        const T = cfg.transients;
        const cents = f32(f32(this.params!.levels.pitch - PITCH_C5) + this.pitchOfs);
        // where the grain's fade-in ends in the source
        let end: number;
        if (cents === 0) end = f32(this.position + att);
        else end = f32(this.position + att * appleExp(cents * 0.0005776226504666211));
        const from = roundEven(f32(end - 0.5));
        for (let i = 0; i < T.length; i++) {
          if (T[i] < from) continue;
          let d = f32(f32(T[i]) - end);
          if (i !== this.lastTransient) {
            this.lastTransient = i;
            hold = cfg.tHold;
            d = f32(d * cfg.stepRatio);
            if (!(f32(att + hold) <= d)) hold = Math.max(0, f32(d - att));
          } else {
            const k = Math.max(1, roundEven(f32(d / cfg.step)));
            const walked = f32(f32(k) * cfg.step);
            const extra = f32(f32(f32(d - walked) * cfg.stepRatio) / f32(k));
            hold = Math.max(0, f32(hold + extra));
          }
          break;
        }
        norm = f32(f32(att + hold) * cfg.inv);
      }
      this.addGrain(pos, this.nextGrain - old, roundEven(att), roundEven(hold));
      // the first grain of a voice that starts at 0 skips its fade-in
      if (this.nextGrain === 0 && this.position === 0 && this.count > 0) {
        const g = this.grains[0];
        g.holdEnd = i32(g.holdEnd - g.pos);
        g.end = i32(g.end - g.pos);
        g.pos = 0;
        g.slope = 0;
        g.g = 1.0;
      }
      this.nextGrain = i32(this.nextGrain + roundEven(f32(cfg.spacing * norm)));
      if (!s.holdSound) {
        if (s.depth > 0) {
          const d = Math.abs(appleSin(this.phase)) * cfg.step * cfg.depth;
          this.position = f32(this.position - f32(roundEven(d)));
        }
        this.phase = f32(this.phase + cfg.lfo);
        this.position = f32(this.position + f32(cfg.step * norm));
        if (this.position > lastF) {
          if (!cfg.looping) {
            this.exhausted = true;
            if (this.count === 0) this.done = true;
          } else this.wrapped = true;
          let guard = 0;
          do { this.position = f32(this.position - f32(cfg.len)); } while (this.position > lastF && ++guard < 100000);
          if (guard >= 100000) this.position = 0;
        }
        if (this.wrapped) {
          let guard = 0;
          while (this.position < 0 && ++guard < 100000) this.position = f32(this.position + f32(cfg.len));
        } else {
          let guard = 0;
          while (this.position < 0 && ++guard < 100000) this.position = f32(f32(this.position + lastF) + 1.0);
        }
      }
    }
  }

  /**
   * Voice_Render (0x64b00) for n frames into this.raw (interleaved, zeroed first); returns FL's
   * "voice finished" flag.
   */
  block(n: number): boolean {
    const cfg = this.cfg!;
    const raw = this.raw, tmp = this.tmp;
    raw.fill(0, 0, 2 * n);
    if (!this.exhausted) {
      const old = this.time;
      this.time = i32(this.time + n);
      this.schedule(old);
    }
    let done = this.done;
    for (let gi = 0; gi < this.count;) {
      const g = this.grains[gi];
      let out = 0;
      let rem = n;
      if (g.delay > 0) { out += g.delay; rem -= g.delay; g.delay = 0; }
      rem = g.reader.read(tmp, rem);
      const ended = g.reader.ended;
      let src = 0;
      let destroyed = false;
      while (rem > 0) {
        const p = g.pos;
        let seg: number;
        if (p < 0) seg = Math.min(-p, rem);
        else if (p < g.holdEnd) seg = Math.min(g.holdEnd - p, rem);
        else seg = Math.min(g.end - p, rem);
        if (g.slope === 0) addGain(tmp, src, raw, out, seg, f32(g.g * g.gl), f32(g.g * g.gr));
        else {
          addRamp(tmp, src, raw, out, seg, f32(g.g * g.gl), f32(g.g * g.gr), f32(g.slope * g.gl), f32(g.slope * g.gr));
          g.g = f32(g.g + f32(f32(seg) * g.slope));
        }
        g.pos = i32(g.pos + seg);
        rem -= seg;
        if (g.pos >= g.end || (ended && rem <= 0)) {
          // the grain is over: it leaves the list and the next one takes its index
          // FL's unordered list: the last grain takes the deleted one's index (and is mixed next)
          this.freeGrain(g);
          this.count--;
          this.grains[gi] = this.grains[this.count];
          if (this.exhausted && this.count === 0) done = true;
          destroyed = true;
          break;
        }
        if (g.pos === g.holdEnd) g.slope = f32(-1.0 / (g.end - g.holdEnd));
        else if (g.pos === 0) g.slope = 0;
        src += seg;
        out += seg;
      }
      if (!destroyed) gi++;
    }
    this.done = done;
    return done;
  }

  /** Voice levels: float32 pan law of FinalLevels, ramp from the last gains, FL's mix kernel (the Slicer's). */
  private mix(L: Float32Array, R: Float32Array, n: number): void {
    const p = this.params!.levels;
    let pan = f32(p.pan);
    if (!(pan >= -1)) pan = -1; else if (pan > 1) pan = 1;
    const vol = f32(p.vol);
    const a = f32(f32(pan + 1) * 0.7853981633974483);
    let tl = f32(f32(Math.cos(a)) * vol);
    let tr = f32(f32(Math.sin(a)) * vol);
    if (!Number.isFinite(tl)) tl = 0;
    if (!Number.isFinite(tr)) tr = 0;
    if (this.lastL !== this.lastL) { this.lastL = tl; this.lastR = tr; }
    const t = this.t;
    t.v = tl;
    const sl = rampStep(t, this.lastL, n);
    tl = t.v;
    t.v = tr;
    const sr = rampStep(t, this.lastR, n);
    tr = t.v;
    const raw = this.raw;
    if (sl === 0 && sr === 0) {
      for (let i = 0; i < n; i++) {
        L[i] = f32(f32(raw[2 * i] * tl) + L[i]);
        R[i] = f32(f32(raw[2 * i + 1] * tr) + R[i]);
      }
    } else {
      let g0 = this.lastL, g1 = this.lastR, g2 = f32(this.lastL + sl), g3 = f32(this.lastR + sr);
      let i = 0;
      if (n >= 8) {
        const d0 = f32(sl + sl), d1 = f32(sr + sr);
        for (; n - i >= 8;) {
          for (let k = 0; k < 4; k++, i += 2) {
            L[i] = f32(f32(raw[2 * i] * g0) + L[i]);
            R[i] = f32(f32(raw[2 * i + 1] * g1) + R[i]);
            L[i + 1] = f32(f32(raw[2 * i + 2] * g2) + L[i + 1]);
            R[i + 1] = f32(f32(raw[2 * i + 3] * g3) + R[i + 1]);
            g0 = f32(d0 + g0); g1 = f32(d1 + g1); g2 = f32(d0 + g2); g3 = f32(d1 + g3);
          }
        }
      }
      for (; i < n; i++) {
        L[i] = f32(f32(raw[2 * i] * g0) + L[i]);
        R[i] = f32(f32(raw[2 * i + 1] * g1) + R[i]);
        g0 = f32(sr + g0); g1 = f32(sl + g1);
      }
    }
    this.lastL = tl;
    this.lastR = tr;
  }

  render(L: Float32Array, R: Float32Array, n: number): boolean {
    if (this.free || !this.params || !this.cfg) return false;
    if (n > MAX_BLOCK) {
      let alive = true;
      for (let o = 0; o < n && alive; o += MAX_BLOCK) alive = this.render(L.subarray(o, Math.min(n, o + MAX_BLOCK)), R.subarray(o, Math.min(n, o + MAX_BLOCK)), Math.min(MAX_BLOCK, n - o));
      return alive;
    }
    if (this.rel >= RELEASE_LEN) return false;
    const finished = this.block(n);
    const raw = this.raw;
    if (this.rel >= 0) {
      for (let i = 0; i < n; i++) {
        let g = 0;
        if (this.rel < RELEASE_LEN) {
          g = releaseGain(this.rel);
          this.rel++;
        }
        raw[2 * i] = f32(raw[2 * i] * g);
        raw[2 * i + 1] = f32(raw[2 * i + 1] * g);
      }
    }
    this.mix(L, R, n);
    return !finished && this.rel < RELEASE_LEN;
  }

  /** FL's Voice_Release: the INS processor's release declick starts (441 samples). */
  release(): void {
    if (this.free || this.released) return;
    this.released = true;
    this.rel = 0;
  }

  kill(): void {
    for (let i = 0; i < this.count; i++) this.freeGrain(this.grains[i]);
    this.count = 0;
    this.free = true;
    this.params = null;
    this.cfg = null;
  }
}
