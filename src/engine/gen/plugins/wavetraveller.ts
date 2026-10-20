// Wave Traveller (FL: Wave Traveller, Plugin database > Generators > Sampler), FL 2026's binary
// (Wave Traveller_x64.dylib, arm64 slice, TTestPlug / CWWarper) ported: a note picks the patch of its key,
// whose WAVE spline moves the play position over the loaded sample (the sample is played like a record under
// the hand), the VOL spline and the mutes shape the volume. See docs/research/gen/wavetraveller.md.

import type { FxMonitor } from '../../effects/types';
import type { InterpMode } from '../../../model/sampler';
import type { GenContext, GenEnv, GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import {
  WT_KEYS, WT_TABLE, buildTable, defaultPatch, wtState, type WtPatch, type WtState,
} from '../../../model/gen/plugins/wavetraveller/state';
import { WtVoice, type WtRuntimePatch, type WtSample, type WtShared } from './wavetraveller/voice';

const f32 = Math.fround;

/** As many voices as a channel holds (a voice is never reused while the channel renders it). */
const MAX_VOICES = 128;

/** A patch ready to play: both spline tables, the mutes and the controls (FL's patch object after CWWarper 0x6c740). */
export function buildRuntime(p: WtPatch): WtRuntimePatch {
  const tabA = new Float32Array(WT_TABLE);
  const tabB = new Float32Array(WT_TABLE);
  const infoA = buildTable(p.wave, tabA);
  const infoB = buildTable(p.vol, tabB);
  const muteOn = new Uint8Array(p.mutes.length);
  const muteT = new Float32Array(p.mutes.length);
  p.mutes.forEach((m, i) => { muteOn[i] = m[0] ? 1 : 0; muteT[i] = m[1]; });
  return {
    tabA, infoA, tabB, infoB, muteOn, muteT,
    start: p.start, end: p.end, steps: p.steps, speed: p.speed, attack: p.attack, release: p.release, mode: p.mode,
  };
}

/** The host's 16-bit stereo copy of a sample, as the plugin holds it (LoadSample asks for 16-bit stereo, x 1/32768). */
export function toWtSample(channels: readonly Float32Array[], fileRate: number, hostRate: number): WtSample | null {
  const l = channels[0];
  if (!l || !l.length) return null;
  const r = channels.length > 1 ? channels[1] : l;
  const frames = l.length;
  const data = new Float32Array(2 * (frames + 1));
  const q = (x: number): number => {
    const v = f32(x * 32767);
    let k = v < 0 ? -Math.round(-v) : Math.round(v);
    if (k > 32767) k = 32767; else if (k < -32768) k = -32768;
    return k / 32768;
  };
  for (let i = 0; i < frames; i++) {
    const a = l[i];
    const b = r[i];
    data[2 * i] = Number.isFinite(a) ? q(a) : 0;
    data[2 * i + 1] = Number.isFinite(b) ? q(b) : 0;
  }
  // FL pads the buffer with its first right sample (never read by the voices)
  data[2 * frames] = data[1];
  data[2 * frames + 1] = data[1];
  return { data, frames, rateConv: fileRate / hostRate };
}

/** FL's interpolation points of the project setting (FPD_ProcessMode bits 8..23: 1 linear, 3 hermite, 12 = 24-point sinc ...). */
function interpPoints(m: InterpMode): number {
  switch (m) {
    case 'linear': return 1;
    case 'hermite6': return 3;
    case 'sinc24': return 12;
    case 'sinc64': return 32;
    case 'sinc128': return 64;
    case 'sinc256': return 128;
    default: return 256;
  }
}

class WaveTraveller implements GenInstance {
  private readonly voices: WtVoice[] = [];
  private readonly shared: WtShared;
  private state: WtState = wtState({});
  private readonly runtime = new Map<string, { sig: string; rt: WtRuntimePatch }>();
  private defaultRt: WtRuntimePatch | null = null;
  private sampleKey: { ch: Float32Array | null; len: number; id: string } = { ch: null, len: 0, id: '' };
  private pending = false;
  private ip = 12;
  private rendering = false;

  constructor(private readonly sampleRate: number, private readonly env: GenEnv) {
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new WtVoice());
    const sr = Math.round(sampleRate);
    this.shared = {
      sample: null, sampleRate: sr, tempo: 120,
      dcR: f32(1 - 126 / sr), mode: 1, taps: 64, generation: 0,
    };
  }

  setParams(p: unknown): void {
    const s = wtState(p);
    this.state = s;
    this.syncSample();
    // rebuild the tables of the patches that changed
    const seen = new Set<string>();
    for (const k of Object.keys(s.patches)) {
      seen.add(k);
      const sig = JSON.stringify(s.patches[k]);
      const cur = this.runtime.get(k);
      if (!cur || cur.sig !== sig) this.runtime.set(k, { sig, rt: buildRuntime(s.patches[k]) });
    }
    for (const k of [...this.runtime.keys()]) if (!seen.has(k)) this.runtime.delete(k);
  }

  /** Load the pool sample the state names (LoadSample kills the running voices). */
  private syncSample(): void {
    const id = this.state.sample;
    if (!id) {
      if (this.shared.sample) { this.shared.sample = null; this.shared.generation++; }
      this.sampleKey = { ch: null, len: 0, id: '' };
      this.pending = false;
      return;
    }
    const src = this.env.sample(id);
    if (!src || !src.channels.length) {
      // not in the pool (yet): silent until it arrives
      if (this.shared.sample) { this.shared.sample = null; this.shared.generation++; }
      this.pending = true;
      return;
    }
    this.pending = false;
    const ch = src.channels[0];
    const k = this.sampleKey;
    if (k.id === id && k.ch === ch && k.len === ch.length && this.shared.sample) return;
    this.sampleKey = { ch, len: ch.length, id };
    this.shared.sample = toWtSample(src.channels, src.sampleRate, this.sampleRate);
    this.shared.generation++;
  }

  triggerVoice(p: GenVoiceParams, ctx?: GenContext): GenVoice | null {
    if (ctx) this.sync(ctx);
    if (this.pending) this.syncSample();
    if (!this.shared.sample) return null;
    // FL: the key is round(InitLevels.Pitch / 100); keys outside 0..119 get a silent dummy voice
    const key = p.key;
    if (!(key >= 0 && key < WT_KEYS)) return null;
    let rt = this.runtime.get(String(key))?.rt;
    if (!rt) rt = this.defaultRt ??= buildRuntime(defaultPatch());
    for (const v of this.voices) {
      if (!v.free) continue;
      return v.start(p, this.shared, rt, key, this.shared.tempo) ? v : null;
    }
    return null;
  }

  /** The tempo (FPE_Tempo) and the export state (FPD_ProcessMode) of the block. */
  private sync(ctx: GenContext): void {
    if (ctx.tempo > 0) this.shared.tempo = f32(ctx.tempo);
    const rendering = !!ctx.rendering;
    if (rendering !== this.rendering) { this.rendering = rendering; this.applyProcessMode(); }
  }

  /** Per block, after the voices. */
  render(_L: Float32Array, _R: Float32Array, _n: number, ctx: GenContext): void {
    this.sync(ctx);
  }

  /** FL's FPD_ProcessMode handler (0x634e0): HQ sinc kernel only while exporting with the hermite / sinc settings it knows. */
  private applyProcessMode(): void {
    const sh = this.shared;
    if (!this.rendering) { sh.mode = 1; return; }
    switch (this.ip) {
      case 1: case 2: sh.mode = 1; break;
      case 3: sh.taps = 64; sh.mode = 2; break;
      case 4: sh.taps = 128; sh.mode = 2; break;
      case 5: sh.taps = 256; sh.mode = 2; break;
      default: break;
    }
  }

  setInterpolation(m: InterpMode): void {
    this.ip = interpPoints(m);
    if (this.rendering) this.applyProcessMode();
  }

  reset(): void {
    for (const v of this.voices) v.kill();
  }

  allNotesOff(): void {
    this.reset();
  }

  /** Editor data: the playing voices as [key, phrase position 0..1, sample position 0..1] triples. */
  monitor(): FxMonitor {
    const play: number[] = [];
    const smp = this.shared.sample;
    for (const v of this.voices) {
      if (v.free) continue;
      play.push(v.key, v.phrase(), smp ? v.playhead() : 0);
    }
    return { play };
  }
}

export const gen: GenModule = {
  id: 'wavetraveller',
  create: (sampleRate, _blockSize, env) => new WaveTraveller(sampleRate, env),
};
