// Granulizer test helpers: an engine with a sample and a render like FL's test host (blocks of at most 512
// samples split at the notes' on / off and at the song ticks, FL's Gen_Render over the plugin's voice list: voices in
// order of their notes, a finished voice replaced by the last one; channel pan / pitch ramps like --chan-ramp).
import { createGen } from '../../src/engine/gen';
import { granRandom } from '../../src/engine/gen/plugins/granulizer';
import { newLevels } from '../../src/engine/gen/levels';
import type { GenInstance, GenVoice, GenVoiceParams } from '../../src/engine/gen/types';
import type { InterpMode } from '../../src/model/sampler';
import { burstSignal, dcSignal, pulseSignal, rampSignal, sweepSignal } from './granulizer-signals';

export const SIGNALS: Record<string, () => Float32Array[]> = { ramp: rampSignal, dc: dcSignal, pulse: pulseSignal, sweep: sweepSignal, burst: burstSignal };

export interface GNote { key: number; start: number; dur: number; vel?: number }

export function params(key: number, vel = 100): GenVoiceParams {
  const init = newLevels(), levels = newLevels();
  init.pitch = 6000 + (key - 60) * 100; init.vol = 1;
  levels.pitch = init.pitch; levels.vol = 1;
  return { key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

/** The Granulizer on a sample (pool id 'S'). */
export function granulizer(state: Record<string, unknown>, channels: Float32Array[], rate = 44100, sr = 44100, interp: InterpMode = 'linear'): GenInstance {
  const g = createGen('granulizer', sr, 512, { sample: (id) => (id === 'S' ? { channels, sampleRate: rate } : undefined) })!;
  g.setInterpolation?.(interp);
  g.setParams({ sample: 'S', ...state });
  return g;
}

export const POINTS_MODE: Record<number, InterpMode> = { 1: 'linear', 3: 'hermite6', 12: 'sinc24', 32: 'sinc64' };

/** A channel knob ramped over time like the host's --chan-ramp: [key 'pan' (-1..1) | 'pitch' (cents), from s, to s, a, b]. */
export type ChanRamp = [string, number, number, number, number];

const f32 = Math.fround;

/**
 * Render notes like the test host: output [L, R] of `frames` frames. `ramps` move the channel's pan / pitch knobs over
 * time: at every block start (and at most `ctl` samples apart, the host's --ctl 64) FinalLevels are recomputed in float32
 * as the host does (pan: (knob - 6400) / 6400 as float; pitch: Init + (knob - 6000)).
 */
export function renderLikeHost(g: GenInstance, notes: GNote[], frames: number, sr = 44100, bpm = 130, epoch?: number, ramps: ChanRamp[] = [], ctl = 64): [Float32Array, Float32Array] {
  if (epoch !== undefined) granRandom.reset(epoch);
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const ev = notes.map((n) => ({ n, on: Math.round(n.start * sr), off: Math.round((n.start + n.dur) * sr) }));
  const spt = (sr * 60) / (bpm * 96);
  const voices: { v: GenVoice; p: GenVoiceParams; off: number; released: boolean; dead: boolean }[] = [];
  const rs = ramps.map(([key, t0, t1, a, b]) => ({ key, t0: Math.round(t0 * sr), t1: Math.round(t1 * sr), a, b }));
  const knobs = { pan: 6400, pitch: 0 };
  const apply = (p: GenVoiceParams): void => {
    if (!rs.length) return;
    p.levels.pitch = 6000 + f32(f32(p.key * 100 + f32(knobs.pitch - 6000)) + 0);
    p.levels.pan = f32(f32(knobs.pan - 6400) * f32(0.00015625));
  };
  const ctx = { sampleRate: sr, blockSize: 512, tempo: bpm, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
  const bl = new Float32Array(512), br = new Float32Array(512);
  let tick = 0;
  for (let t = 0; t < frames;) {
    for (const e of ev) {
      if (e.on === t) {
        const p = params(e.n.key, e.n.vel ?? 100);
        apply(p);
        const v = g.triggerVoice!(p, ctx);
        if (v) voices.push({ v, p, off: e.off, released: false, dead: false });
      }
    }
    for (const x of voices) if (!x.released && !x.dead && x.off === t) { x.v.release(); x.released = true; }
    while (Math.floor(tick * spt) <= t) tick++;
    let changed = false;
    for (const r of rs) {
      if (t < r.t0) continue;
      const x = r.t1 > r.t0 ? Math.min(1, (t - r.t0) / (r.t1 - r.t0)) : 1;
      const v = r.a + (r.b - r.a) * x;
      if (r.key === 'pan') knobs.pan = 6400 + v * 6400; else knobs.pitch = v;
      changed = true;
    }
    if (changed) for (const x of voices) if (!x.dead) apply(x.p);
    let n = Math.min(512, frames - t);
    for (const e of ev) for (const q of [e.on, e.off]) if (q > t && q < t + n) n = q - t;
    if (Math.floor(tick * spt) < t + n) n = Math.floor(tick * spt) - t;
    if (rs.length) n = Math.min(n, ctl);
    if (n <= 0) n = 1;
    bl.fill(0, 0, n); br.fill(0, 0, n);
    for (const x of voices) {
      if (x.dead) continue;
      if (!x.v.render(bl.subarray(0, n), br.subarray(0, n), n)) { x.dead = true; x.v.kill(); }
    }
    // FL's plugin keeps its voices in an unordered list (Voice_Kill: TList.Delete moves the last voice into the hole)
    for (let i = voices.length - 1; i >= 0; i--) if (voices[i].dead) { voices[i] = voices[voices.length - 1]; voices.pop(); }
    L.set(bl.subarray(0, n), t); R.set(br.subarray(0, n), t);
    t += n;
  }
  return [L, R];
}
