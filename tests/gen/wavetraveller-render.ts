// Host-like renderer for tests/gen/wavetraveller.test.ts: drives the Wave Traveller instance the way FL's test
// host does (voices triggered and released at their sample, 512-frame blocks, 130 BPM, the plugin's own
// pan/volume from FinalLevels) and the way the channel does (16-sample control steps).

import { gen } from '../../src/engine/gen/plugins/wavetraveller';
import type { GenVoice, GenVoiceParams } from '../../src/engine/gen/types';
import type { InterpMode } from '../../src/model/sampler';

const f32 = Math.fround;

/** numpy's round (half to even), as the Python tool that wrote the host's input WAVs rounds to 16 bit. */
function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** One channel of the deterministic test noise: a 32-bit LCG, `amp` x [-1, 1), as 16-bit PCM / 32768 (the host's input WAVs). */
export function lcgNoise(n: number, seed: number, amp: number): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const v = (((s >>> 8) & 0xffff) / 65536) * 2 - 1;
    out[i] = roundEven(v * amp * 32767) / 32768;
  }
  return out;
}

export type WtAudioName = 'lcg' | 'mono22' | 'st48' | 'tiny';

/** The test audio of the golden cases (identical to the WAV files the reference renders used). */
export function testAudio(name: WtAudioName): { channels: Float32Array[]; sampleRate: number } {
  switch (name) {
    case 'lcg': return { channels: [lcgNoise(88200, 12345, 0.5), lcgNoise(88200, 54321, 0.5)], sampleRate: 44100 };
    case 'mono22': return { channels: [lcgNoise(33075, 777, 0.4)], sampleRate: 22050 };
    case 'st48': return { channels: [lcgNoise(96000, 4242, 0.5), lcgNoise(96000, 99, 0.5)], sampleRate: 48000 };
    case 'tiny': {
      const l = new Float32Array(37);
      const r = new Float32Array(37);
      for (let i = 0; i < 37; i++) {
        l[i] = roundEven((-0.5 + (i * 1) / 36) * 32767) / 32768;
        r[i] = roundEven((0.3 - (i * 0.6) / 36) * 32767) / 32768;
      }
      return { channels: [l, r], sampleRate: 44100 };
    }
  }
}

export interface WtCase {
  name: string;
  /** Plugin state (without the sample id). */
  state: Record<string, unknown>;
  /** KEY:VEL:START:DUR[:opt=value] in seconds. */
  notes: string;
  /** Seconds to render. */
  secs: number;
  /** Project rate (default 44.1 kHz) and tempo (default 130). */
  sr?: number;
  tempo?: number;
  interp?: InterpMode;
  rendering?: boolean;
  /** Channel pitch offset in cents (FinalLevels.Pitch beyond the key) and panning. */
  pitch?: number;
  pan?: number;
  /** The channel's root key (default C5 = 60). */
  root?: number;
}

export interface WtAudio {
  channels: Float32Array[];
  sampleRate: number;
}

/** FL's LogVol of a velocity (InitLevels.Vol). */
export function flLogVol(x: number): number {
  const v = f32(x);
  if (v === 1) return 1;
  return f32((Math.exp(f32(v * f32(2.397895336151123))) - 1) * f32(0.1));
}

export function renderWt(c: WtCase, au: WtAudio): { L: Float32Array; R: Float32Array } {
  const sr = c.sr ?? 44100;
  const block = 512;
  const tempo = c.tempo ?? 130;
  const g = gen.create(sr, block, { sample: (id) => (id === 'S' ? au : undefined) });
  if (c.interp) g.setInterpolation?.(c.interp);
  g.setParams({ ...c.state, sample: 'S' });
  const N = Math.round(c.secs * sr);
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  type Ev = { on: number; off: number; p: GenVoiceParams; v: GenVoice | null; alive: boolean };
  const evs: Ev[] = c.notes.split(',').filter(Boolean).map((s) => {
    const parts = s.split(':');
    const [k, vel, t0, d] = parts.slice(0, 4).map(Number);
    const opt: Record<string, number> = {};
    for (const q of parts.slice(4)) { const [x, y] = q.split('='); opt[x] = Number(y); }
    const rel = 100 * (k - (c.root ?? 60)) + (c.pitch ?? 0);
    const lv = { pan: opt.pan ?? 0, vol: flLogVol(f32(vel * f32(0.01))), pitch: 6000 + rel, fcut: 0, fres: 0 };
    const p: GenVoiceParams = {
      key: k, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0,
      init: { ...lv }, levels: { ...lv, pan: (c.pan ?? 0) + lv.pan },
    };
    return { on: Math.round(t0 * sr), off: Math.round((t0 + d) * sr), p, v: null, alive: false };
  });
  const ctx = {
    sampleRate: sr, blockSize: block, tempo, ppq: 96, playing: true, pos: 0, songMode: false, track: 5, rendering: !!c.rendering,
  };
  const bl = new Float32Array(block);
  const br = new Float32Array(block);
  const vl = new Float32Array(16);
  const vr = new Float32Array(16);
  for (let b0 = 0; b0 < N;) {
    const n = Math.min(block, N - b0);
    bl.fill(0); br.fill(0);
    // events inside the block split the control steps
    let t = 0;
    while (t < n) {
      let chunk = Math.min(16, n - t);
      for (const e of evs) {
        for (const at of [e.on, e.off]) if (at > b0 + t && at < b0 + t + chunk) chunk = at - (b0 + t);
      }
      const abs = b0 + t;
      for (const e of evs) {
        if (e.off === abs && e.alive) e.v?.release();
        if (e.on === abs) { e.v = g.triggerVoice!(e.p, ctx); e.alive = !!e.v; }
      }
      for (const e of evs) {
        if (!e.alive || !e.v) continue;
        vl.fill(0, 0, chunk); vr.fill(0, 0, chunk);
        const alive = e.v.render(vl, vr, chunk);
        for (let i = 0; i < chunk; i++) { bl[t + i] += vl[i]; br[t + i] += vr[i]; }
        if (!alive) { e.v.kill(); e.alive = false; }
      }
      t += chunk;
    }
    g.render!(bl, br, n, ctx);
    L.set(bl.subarray(0, n), b0);
    R.set(br.subarray(0, n), b0);
    b0 += n;
  }
  return { L, R };
}
