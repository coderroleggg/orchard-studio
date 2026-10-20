// Slicer (FL: Fruity Slicer, Plugin database > Generators > Drum), FL 2026's binary
// (Fruity Slicer_x64.dylib, arm64 slice, TTestPlug) ported: the loaded sample is processed
// offline into the sample the voices play (slice reverse, declick, TS / PS stretching, ATT /
// DEC fades: ./slicer/process.ts) and each note plays the slice mapped to its key through
// FL's resampler and FL's channel sampler processing (./slicer/voice.ts). FL's INS
// envelopes, LFOs and filter are the channel's INS settings (def.ins). See
// docs/research/gen/slicer.md.

import type { FxMonitor } from '../../effects/types';
import type { GenEnv, GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import { slicerState, sliceKeyMap, type SlicerState } from '../../../model/gen/plugins/slicer/state';
import { processSlices, type Processed } from './slicer/process';
import { SlicerVoice } from './slicer/voice';
import { elastique } from './slicer/elastique';

/** As many voices as a channel holds (a voice is never reused while the channel renders it). */
const MAX_VOICES = 128;

/**
 * FL's interpolation points for pitched slices (FPD_ProcessMode bits 8..23, FL's resampling
 * setting; 24 = FL's default 24-point sinc; <= 2 = linear, as the test host's process mode 0).
 */
let interpPoints = 24;
export function setSlicerInterpolation(points: number): void {
  interpPoints = Math.max(0, Math.min(512, Math.round(points)));
}

/** The processing inputs of a state (the processed sample changes only with these). */
export function processKey(s: SlicerState): string {
  let k = `${s.sample}|${s.ts}|${s.ps}|${s.method}|${s.declick ? 1 : 0}|${s.fadeIn}|${s.fadeOut}|`;
  for (const sl of s.slices) k += `${sl.pos}${sl.rev ? 'r' : ''},`;
  return k;
}

class Slicer implements GenInstance {
  private readonly voices: SlicerVoice[] = [];
  private readonly keyMap = new Int32Array(125);
  private state: SlicerState = slicerState({});
  private procKey = '';
  private proc: Processed | null = null;
  /** The sample id the processed sample came from is not in the pool yet: retry. */
  private pending = false;
  /** What the voices read (reused: no allocation per note). */
  private readonly src: { channels: readonly Float32Array[]; rateRatio: number } = { channels: [], rateRatio: 1 };

  constructor(private readonly sampleRate: number, private readonly env: GenEnv) {
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new SlicerVoice());
    this.keyMap.fill(-1);
  }

  setParams(p: unknown): void {
    const s = slicerState(p);
    this.state = s;
    sliceKeyMap(s.slices, s.baseKey, this.keyMap);
    const key = processKey(s);
    if (key !== this.procKey || this.pending) {
      this.procKey = key;
      this.process();
    }
  }

  private process(): void {
    const s = this.state;
    this.pending = false;
    if (!s.sample) { this.proc = null; return; }
    const src = this.env.sample(s.sample);
    if (!src || !src.channels.length) { this.proc = null; this.pending = true; return; }
    this.proc = processSlices(src, s.slices, s, elastique);
  }

  triggerVoice(p: GenVoiceParams): GenVoice | null {
    if (this.pending) this.process();
    const proc = this.proc;
    if (!proc) return null;
    // FL keys 0..124 (TriggerVoice 0x62af0: round(InitLevels.Pitch / 100), i.e. the played key)
    const key = p.key;
    if (!(key >= 0 && key <= 124)) return null;
    const idx = this.keyMap[key];
    if (idx < 0 || idx >= proc.slices.length) return null;
    const sl = proc.slices[idx];
    const total = proc.channels[0].length;
    // FL: TResampler end = max(1, len - 1) + 1 (play to end: from the slice to the sample end)
    const len = Math.max(1, (this.state.playToEnd ? total - sl.pos : sl.len) - 1) + 1;
    for (const v of this.voices) {
      if (!v.free) continue;
      this.src.channels = proc.channels;
      this.src.rateRatio = proc.sampleRate / this.sampleRate;
      v.start(p, this.src, idx, sl.pos, Math.min(len, total - sl.pos), key, interpPoints);
      return v;
    }
    return null;
  }

  reset(): void {
    for (const v of this.voices) v.kill();
  }

  /** Editor data: the slices playing (FL's ANIMATE display). */
  monitor(): FxMonitor {
    const playing: number[] = [];
    for (const v of this.voices) if (!v.free && v.slice >= 0 && !playing.includes(v.slice)) playing.push(v.slice);
    return { playing };
  }
}

export const gen: GenModule = {
  id: 'slicer',
  create: (sampleRate, _blockSize, env) => new Slicer(sampleRate, env),
};
