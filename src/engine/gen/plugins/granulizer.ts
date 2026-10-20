// Granulizer (FL: Fruity Granulizer, Plugin database > Generators > Sampler), FL 2026's binary
// (Fruity Granulizer_x64.dylib, arm64, TTestPlug) ported: the channel's sample is played as
// overlapping grains by a voice (./granulizer/voice.ts) through FL's TResampler and FL's channel
// sampler processing; the parameter conversions are FL's (../../../model/gen/plugins/granulizer/
// convert.ts). FL's INS envelopes, LFOs and filter are the channel's INS settings (def.ins). See
// docs/research/gen/granulizer.md.

import type { InterpMode } from '../../../model/sampler';
import type { FxMonitor } from '../../effects/types';
import type { GenContext, GenEnv, GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import { granulizerState } from '../../../model/gen/plugins/granulizer/state';
import { msOf, msToSamples, roundEven, spacingOf } from '../../../model/gen/plugins/granulizer/convert';
import { detectTransients } from '../../../model/gen/plugins/granulizer/detect';
import { FpcRandom } from './granulizer/random';
import type { GranSample } from './granulizer/reader';
import { GranVoice, type GranConfig } from './granulizer/voice';

const f32 = Math.fround;

/** As many voices as a channel holds (a voice is never reused while the channel renders it). */
const MAX_VOICES = 128;

/** FL's interpolation points per project setting (half widths: 1 linear, 3 hermite, 12 = 24-point sinc ...). */
export function pointsOf(m: InterpMode): number {
  return m === 'linear' ? 1 : m === 'hermite6' ? 3 : m === 'sinc24' ? 12 : m === 'sinc64' ? 32 : m === 'sinc128' ? 64 : m === 'sinc256' ? 128 : 256;
}

/** FL's Random is one stream for the whole plugin runtime (all instances). */
export const granRandom = new FpcRandom();

/** The fields FL recalculates on every parameter change (0x62580, 0x628a0, 0x65e60, 0x62840). */
export function recalc(cfg: GranConfig): void {
  const s = cfg.s;
  const rate = cfg.hostRate;
  cfg.att = msToSamples(msOf(s.attack), rate);
  cfg.hold = msToSamples(msOf(s.hold), rate);
  cfg.tHold = msToSamples(msOf(s.transHold), rate);
  cfg.sum = f32(cfg.att + cfg.hold);
  const sp = f32(f32(cfg.sum * f32(spacingOf(s.spacing))) * 0.00390625);
  cfg.spacing = 5.0 <= sp ? sp : 5.0;
  const fitSmp = roundEven(f32(f32(f32(cfg.fit * 60) * rate) / cfg.tempo));
  cfg.looping = s.loop > 0;
  const lock = s.tempoLocked && cfg.fit > 0;
  if (lock) {
    cfg.step = f32(f32(cfg.spacing * f32(cfg.last + 1)) / f32(fitSmp));
    cfg.looping = true;
  } else {
    const w = f32(cfg.sum * f32(spacingOf(s.wave)));
    const ratio = (cfg.sample ? cfg.sample.rate : 44100) * (1 / rate);
    cfg.step = f32(w * ratio * f32(0.00390625));
  }
  cfg.inv = f32(1.0 / cfg.sum);
  cfg.stepRatio = f32(cfg.sum / (cfg.step > 1.0 ? cfg.step : 1.0));
  cfg.depth = f32(s.depth * 0.00390625);
  cfg.lfo = f32(Math.PI / (204 - s.speed));
  cfg.start = Math.floor((s.start * cfg.last) / 4096);
}

class Granulizer implements GenInstance {
  private readonly voices: GranVoice[] = [];
  private readonly cfg: GranConfig;
  private sampleId = '';
  /** The sample the state refers to is not in the pool yet: retry. */
  private pending = false;
  private readonly detCache = new Map<string, number[]>();

  constructor(private readonly sampleRate: number, private readonly env: GenEnv) {
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new GranVoice());
    this.cfg = {
      s: granulizerState({}), sample: null, last: 0, len: 0, hostRate: sampleRate, att: 0, hold: 0, tHold: 0, sum: 0, inv: 0,
      spacing: 0, step: 0, stepRatio: 0, depth: 0, lfo: 0, start: 0, looping: false, tempo: 130, fit: 0, transients: [],
      points: pointsOf('sinc24'), rnd: granRandom,
    };
    recalc(this.cfg);
  }

  setParams(p: unknown): void {
    const s = granulizerState(p);
    this.cfg.s = s;
    if (s.sample !== this.sampleId || this.pending) {
      this.sampleId = s.sample;
      this.loadSample();
    }
    this.cfg.transients = this.transientsOf(s);
    recalc(this.cfg);
  }

  /** The sample's transients for the TRANSIENTS source: the file's regions, or FL's detector (the editor's result, else detected here once). */
  private transientsOf(s: ReturnType<typeof granulizerState>): readonly number[] {
    const sm = this.cfg.sample;
    if (!sm || s.trans === 0) return [];
    if (s.trans === 1) return [...s.regions].sort((a, b) => a - b);
    const key = `${s.sample}|${sm.len}|${sm.rate}`;
    if (s.detected.length && s.detectedFor === key) return s.detected;
    let t = this.detCache.get(key);
    if (!t) {
      t = detectTransients([sm.L, sm.R === sm.L ? sm.L : sm.R].slice(0, sm.R === sm.L ? 1 : 2), sm.rate);
      if (this.detCache.size >= 4) this.detCache.delete(this.detCache.keys().next().value as string);
      this.detCache.set(key, t);
    }
    return t;
  }

  private loadSample(): void {
    const cfg = this.cfg;
    this.pending = false;
    cfg.sample = null;
    cfg.last = 0;
    cfg.len = 0;
    if (!this.sampleId) return;
    const src = this.env.sample(this.sampleId);
    if (!src || !src.channels.length || !src.channels[0].length) { this.pending = true; return; }
    const L = src.channels[0];
    const sm: GranSample = { L, R: src.channels[1] ?? L, len: L.length, rate: src.sampleRate };
    cfg.sample = sm;
    cfg.len = sm.len;
    cfg.last = sm.len - 1;
    cfg.transients = this.transientsOf(cfg.s);
  }

  triggerVoice(p: GenVoiceParams, ctx?: GenContext): GenVoice | null {
    // the song tempo (FL's FPE_Tempo) for the Step KEY TO mode
    if (ctx && ctx.tempo > 0 && ctx.tempo !== this.cfg.tempo) { this.cfg.tempo = ctx.tempo; recalc(this.cfg); }
    if (this.pending) { this.loadSample(); recalc(this.cfg); }
    if (!this.cfg.sample) return null;
    for (const v of this.voices) {
      if (!v.free) continue;
      v.start(p, this.cfg);
      return v;
    }
    return null;
  }

  setInterpolation(m: InterpMode): void {
    this.cfg.points = pointsOf(m);
  }

  reset(): void {
    for (const v of this.voices) v.kill();
  }

  /** Editor data: the voices' positions in the sample (0..1). */
  monitor(): FxMonitor | null {
    const sm = this.cfg.sample;
    if (!sm) return null;
    const pos: number[] = [];
    for (const v of this.voices) if (v.active) pos.push(v.cursor / sm.len);
    return { pos };
  }
}

export const gen: GenModule = {
  id: 'granulizer',
  create: (sampleRate, _blockSize, env) => new Granulizer(sampleRate, env),
};
