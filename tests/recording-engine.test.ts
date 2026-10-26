// Audio input and recording in the engine: monitoring, arming, pickup points,
// and sample-accurate capture with simulated input buffers (docs/recording.md).

import { describe, it, expect } from 'vitest';
import { Engine } from '../src/engine/Engine';
import { REC_CHUNK } from '../src/engine/Recording';
import type { FromEngine } from '../src/engine/protocol';
import { createChannel, createMixerTrack, createNote, createPattern } from '../src/model/defaults';
import type { MixerTrack } from '../src/model/types';
import type { RecStartOptions } from '../src/model/recording';
import { faderToGain } from '../src/model/scales';
import { defaultFxParams } from '../src/model/fx/registry';

const SR = 48000;
const BLOCK = 128;

function rig(opts: { tempo?: number } = {}) {
  const msgs: FromEngine[] = [];
  const e = new Engine({ sampleRate: SR, blockSize: BLOCK, post: (m) => msgs.push(m) });
  e.handle({ t: 'globals', g: { tempo: opts.tempo ?? 120, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } });
  for (let i = 0; i < 127; i++) e.handle({ t: 'mixerTrack', tr: createMixerTrack(i) });
  const pat = createPattern(1);
  e.handle({ t: 'pattern', p: pat });
  e.handle({ t: 'mode', song: false, patternId: pat.id });
  const track = (i: number, patch: Partial<MixerTrack>) => e.handle({ t: 'mixerTrack', tr: { ...createMixerTrack(i), ...patch } });
  return { e, msgs, track, pat };
}

/** A device input whose sample `i` identifies the frame: a ramp, channel `c` offset by c. */
function ramp(frames: number, channels = 1): Float32Array[] {
  return Array.from({ length: channels }, (_, c) => {
    const a = new Float32Array(frames);
    for (let i = 0; i < frames; i++) a[i] = (i + 1) * 1e-6 + c * 0.5;
    return a;
  });
}

/** The input frame a ramp value (channel 0) stands for. */
const frameOf = (v: number): number => Math.round(v * 1e6) - 1;

interface Got { take: number; track: number; frames: number; tick0: number; L: Float32Array; R: Float32Array }

/** The takes a session posted, assembled from the chunks. */
function takes(msgs: FromEngine[]): Got[] {
  const out = new Map<string, Got>();
  const chunks = new Map<string, { off: number; L: Float32Array; R: Float32Array }[]>();
  for (const m of msgs) {
    if (m.t === 'recData') {
      const k = `${m.take}:${m.track}`;
      if (!chunks.has(k)) chunks.set(k, []);
      chunks.get(k)!.push({ off: m.off, L: m.L, R: m.R });
    }
  }
  for (const m of msgs) {
    if (m.t !== 'recTake') continue;
    const k = `${m.take}:${m.track}`;
    const L = new Float32Array(m.frames), R = new Float32Array(m.frames);
    for (const c of chunks.get(k) ?? []) {
      for (let i = 0; i < c.L.length && c.off + i < m.frames; i++) { L[c.off + i] = c.L[i]; R[c.off + i] = c.R[i]; }
    }
    out.set(k, { take: m.take, track: m.track, frames: m.frames, tick0: m.tick0, L, R });
  }
  return [...out.values()].sort((a, b) => a.take - b.take || a.track - b.track);
}

const OPTS: RecStartOptions = { countdownBars: 0, waitForInput: false, loop: false, latencyComp: true };

function run(e: Engine, frames: number, input?: Float32Array[], from = 0) {
  const bL = new Float32Array(BLOCK), bR = new Float32Array(BLOCK);
  const L = new Float32Array(frames), R = new Float32Array(frames);
  for (let off = 0; off < frames; off += BLOCK) {
    const n = Math.min(BLOCK, frames - off);
    e.process(bL, bR, n, input?.map((c) => c.subarray(from + off, from + off + n)));
    L.set(bL.subarray(0, n), off);
    R.set(bR.subarray(0, n), off);
  }
  return [L, R];
}

describe('audio input: tracks and monitoring', () => {
  it('a mono input plays on both sides of a monitored track', () => {
    const { e, track } = rig();
    track(1, { input: { ch: 0, mono: true }, monitor: 'on' });
    const x = new Float32Array(1024).fill(0.25);
    const [L, R] = run(e, 1024, [x]);
    const g = faderToGain(0.8); // the default fader: 0 dB
    expect(L[600]).toBeCloseTo(0.25 * g, 5);
    expect(R[600]).toBeCloseTo(0.25 * g, 5);
  });

  it('a stereo pair keeps its channels apart', () => {
    const { e, track } = rig();
    track(1, { input: { ch: 2 }, monitor: 'on', pan: 0 });
    const ch = [new Float32Array(1024), new Float32Array(1024), new Float32Array(1024).fill(0.2), new Float32Array(1024).fill(-0.4)];
    const [L, R] = run(e, 1024, ch);
    expect(L[700]).toBeCloseTo(0.2, 4);
    expect(R[700]).toBeCloseTo(-0.4, 4);
  });

  it('two tracks can share an input, a track without an input stays silent', () => {
    const { e, track } = rig();
    track(1, { input: { ch: 0, mono: true }, monitor: 'on' });
    track(2, { input: { ch: 0, mono: true }, monitor: 'on' });
    track(3, { monitor: 'on' });
    const x = new Float32Array(1024).fill(0.1);
    const [L] = run(e, 1024, [x]);
    expect(L[700]).toBeCloseTo(0.2, 4);
  });

  it('monitoring: Off is silent, When armed follows the arm switch, On always plays', () => {
    const level = (monitor: 'off' | 'armed' | 'on', armed: boolean) => {
      const { e, track } = rig();
      track(1, { input: { ch: 0, mono: true }, monitor, armed });
      const [L] = run(e, 1024, [new Float32Array(1024).fill(0.3)]);
      return L[900];
    };
    expect(level('off', true)).toBe(0);
    expect(level('armed', false)).toBe(0);
    expect(level('armed', true)).toBeGreaterThan(0.2);
    expect(level('on', false)).toBeGreaterThan(0.2);
  });

  it('no input device: monitored tracks are silent and nothing breaks', () => {
    const { e, track } = rig();
    track(1, { input: { ch: 0, mono: true }, monitor: 'on', armed: true });
    const [L] = run(e, 1024);
    expect(Math.max(...L.map(Math.abs))).toBe(0);
  });

  it('a missing channel of a pair is silence', () => {
    const { e, track } = rig();
    track(1, { input: { ch: 0 }, monitor: 'on' });
    const [L, R] = run(e, 512, [new Float32Array(512).fill(0.5)]);
    expect(L[300]).toBeGreaterThan(0.4);
    expect(R[300]).toBe(0);
  });

  it('Always show external input levels meters an unmonitored input', () => {
    const { e, track } = rig();
    track(1, { input: { ch: 0, mono: true }, monitor: 'off' });
    e.handle({ t: 'inputLevels', on: true });
    run(e, 512, [new Float32Array(512).fill(0.5)]);
    const pk = new Float32Array(127 * 2);
    e.mixer.takePeaks(pk);
    expect(pk[2]).toBeCloseTo(0.5, 4);
    // without the option the meter stays at rest
    const r2 = rig();
    r2.track(1, { input: { ch: 0, mono: true }, monitor: 'off' });
    run(r2.e, 512, [new Float32Array(512).fill(0.5)]);
    const pk2 = new Float32Array(127 * 2);
    r2.e.mixer.takePeaks(pk2);
    expect(pk2[2]).toBe(0);
  });
});

describe('recording: armed tracks and capture', () => {
  it('records armed tracks only, each with its own input', () => {
    const { e, msgs, track } = rig();
    track(1, { input: { ch: 0, mono: true }, armed: true });
    track(2, { input: { ch: 1, mono: true }, armed: false });
    track(3, { input: { ch: 1, mono: true }, armed: true });
    const inp = ramp(BLOCK * 20, 2);
    run(e, BLOCK * 4, inp);
    e.handle({ t: 'recLatency', input: 0, output: 0 });
    e.handle({ t: 'recStart', o: { ...OPTS, latencyComp: false } });
    run(e, BLOCK * 8, inp, BLOCK * 4);
    e.handle({ t: 'recStop' });
    run(e, BLOCK * 4, inp, BLOCK * 12);
    const got = takes(msgs);
    expect(got.map((g) => g.track)).toEqual([1, 3]);
    expect(msgs.some((m) => m.t === 'recDone' && !m.cancelled)).toBe(true);
    // the first recorded frame is the first frame of the recording
    expect(frameOf(got[0].L[0])).toBe(BLOCK * 4);
    expect(frameOf(got[1].L[0] - 0.5)).toBe(BLOCK * 4);
    expect(got[0].frames).toBe(BLOCK * 8);
  });

  it('a mono input is recorded as a stereo take (the same signal on both sides)', () => {
    const { e, msgs, track } = rig();
    track(1, { input: { ch: 0, mono: true }, armed: true });
    const inp = ramp(BLOCK * 10);
    e.handle({ t: 'recStart', o: { ...OPTS, latencyComp: false } });
    run(e, BLOCK * 5, inp);
    e.handle({ t: 'recStop' });
    run(e, BLOCK * 2, inp, BLOCK * 5);
    const [g] = takes(msgs);
    expect(g.L[100]).toBe(g.R[100]);
    expect(frameOf(g.L[100])).toBe(100);
  });

  it('a track armed without an input and EXT pickup records nothing; the session reports it', () => {
    const { e, msgs, track } = rig();
    track(1, { armed: true });
    e.handle({ t: 'recStart', o: OPTS });
    expect(msgs.some((m) => m.t === 'recDone' && m.cancelled)).toBe(true);
    expect(e.rec.active).toBe(false);
  });

  it('starts the transport and the capture on the same frame, in the middle of a block', () => {
    // a step on the first tick: the transport's first frame is the recording's first frame
    const { e, msgs, track, pat } = rig({ tempo: 133 });
    const ch = createChannel('click', 'imp');
    ch.volume = 1;
    e.handle({ t: 'sample', id: 'imp', data: [Float32Array.of(1, 0, 0, 0)], sampleRate: SR });
    e.handle({ t: 'channel', c: ch });
    pat.notes[ch.id] = [createNote({ pos: 0, len: 24 })];
    e.handle({ t: 'pattern', p: pat });
    track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    const frames = SR * 4;
    const inp = ramp(frames);
    run(e, BLOCK * 3 + 17, inp); // 17 frames into a block (the engine cuts blocks, not messages)
    const x = e.frame;
    e.handle({ t: 'recLatency', input: 0, output: 0 });
    // a one bar count-in at 133 BPM: 86616.5 frames, not a multiple of the block size
    e.handle({ t: 'recStart', o: { ...OPTS, countdownBars: 1, latencyComp: false } });
    const [L] = run(e, frames - x, inp, x);
    const start = x + Math.round((4 * SR * 60) / 133);
    // the transport started on that frame: its first step sounds there
    let first = -1;
    for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > 0.4) { first = i + x; break; } // the count-in clicks stay below 0.35
    expect(first).toBe(start);
    e.handle({ t: 'recStop' });
    run(e, BLOCK * 4, inp, 0);
    const [g] = takes(msgs);
    expect(g).toBeDefined();
    expect(frameOf(g.L[0])).toBe(start); // input frame `start`
    expect(g.tick0).toBe(0);
  });
});

describe('recording: latency compensation', () => {
  /** A 1-second session from `X`, returns the first recorded value as an input frame index. */
  function firstFrame(setup: (r: ReturnType<typeof rig>) => void, o: Partial<RecStartOptions> = {}, lat = { input: 0, output: 0 }) {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    setup(r);
    const inp = ramp(SR * 3);
    run(r.e, BLOCK * 10, inp);
    const x = r.e.frame;
    r.e.handle({ t: 'recLatency', input: lat.input, output: lat.output });
    r.e.handle({ t: 'recStart', o: { ...OPTS, ...o } });
    run(r.e, SR, inp, x);
    r.e.handle({ t: 'recStop' });
    const stopAt = r.e.frame;
    run(r.e, SR, inp, stopAt);
    const [g] = takes(r.msgs);
    return { frame: frameOf(g.L[0]), x, stopAt, g };
  }

  it('moves the recording earlier by the input and output latency of the device', () => {
    const a = firstFrame(() => {}, { latencyComp: true }, { input: 100, output: 156 });
    expect(a.frame).toBe(a.x + 256);
    expect(a.g.frames).toBe(a.stopAt - a.x); // the take is as long as the recording, the content is later
    // the last recorded frame is the one that arrived 256 frames after the stop
    expect(frameOf(a.g.L[a.g.frames - 1])).toBe(a.stopAt + 256 - 1);
  });

  it('latency compensation off: no shift', () => {
    const a = firstFrame(() => {}, { latencyComp: false }, { input: 100, output: 156 });
    expect(a.frame).toBe(a.x);
  });

  it('applies the track input delay (positive: earlier, negative: later)', () => {
    const a = firstFrame((r) => r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off', inputDelay: 10 }), { latencyComp: false });
    expect(a.frame).toBe(a.x + 480);
    const b = firstFrame((r) => r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off', inputDelay: -5 }), { latencyComp: false });
    // later: the take starts with 240 frames of silence
    expect(b.g.L[0]).toBe(0);
    expect(b.g.L[239]).toBe(0);
    expect(frameOf(b.g.L[240])).toBe(b.x);
    expect(b.g.frames).toBe(b.stopAt - b.x);
  });

  it('the device latency adds to the input delay', () => {
    const a = firstFrame((r) => r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off', inputDelay: 1 }), { latencyComp: true }, { input: 64, output: 64 });
    expect(a.frame).toBe(a.x + 128 + 48);
  });
});

describe('recording: pickup points', () => {
  function tap(pickup: 'ext' | 'mix' | 'fx' | 'eq' | 'lvl' | 'post', patch: Partial<MixerTrack> = {}, withChannel = false) {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off', pickup, ...patch });
    if (withChannel) {
      r.e.handle({ t: 'sample', id: 'dc', data: [new Float32Array(SR).fill(0.2)], sampleRate: SR });
      const ch = createChannel('dc', 'dc', 1);
      ch.volume = 1;
      r.e.handle({ t: 'channel', c: ch });
      const pat = createPattern(1);
      pat.notes[ch.id] = [createNote({ pos: 0, len: 96 })];
      r.e.handle({ t: 'pattern', p: pat });
      r.e.handle({ t: 'mode', song: false, patternId: pat.id });
    }
    const inp = [new Float32Array(SR).fill(0.5)];
    r.e.handle({ t: 'recStart', o: { ...OPTS, latencyComp: false } });
    if (withChannel) r.e.handle({ t: 'play' });
    run(r.e, BLOCK * 40, inp);
    r.e.handle({ t: 'recStop' });
    run(r.e, BLOCK * 4, inp);
    const [g] = takes(r.msgs);
    return g;
  }

  it('EXT is the input itself, whatever the track does with it', () => {
    const g = tap('ext', { volume: 0.4, pan: 0.5, enabled: false });
    expect(g.L[3000]).toBeCloseTo(0.5, 6);
    expect(g.R[3000]).toBeCloseTo(0.5, 6);
  });

  it('MIX adds what is routed into the track, even if the input is not monitored', () => {
    const g = tap('mix', {}, true);
    expect(g.L[3000]).toBeCloseTo(0.5 + 0.2 * Math.SQRT1_2 * 1, 1); // the channel is panned with the circular law
  });

  it('FX and EQ are taken before the fader; LVL after volume and panning; POST after the mute', () => {
    const vol = faderToGain(0.4);
    const fx = tap('fx', { volume: 0.4, monitor: 'on' });
    const eq = tap('eq', { volume: 0.4, monitor: 'on' });
    const lvl = tap('lvl', { volume: 0.4, monitor: 'on' });
    expect(fx.L[3000]).toBeCloseTo(0.5, 5);
    expect(eq.L[3000]).toBeCloseTo(0.5, 5);
    expect(lvl.L[3000]).toBeCloseTo(0.5 * vol, 4);
    const muted = { volume: 0.4, enabled: false, monitor: 'on' as const };
    expect(tap('lvl', muted).L[3000]).toBeCloseTo(0.5 * vol, 4); // the mute switch is not applied yet
    expect(Math.abs(tap('post', muted).L[3000])).toBeLessThan(1e-6);
    expect(tap('post', { volume: 0.4, monitor: 'on' }).L[3000]).toBeCloseTo(0.5 * vol, 4);
  });

  it('a track with a pickup after the input stage records without an external input', () => {
    const g = tap('post', { input: undefined, monitor: 'on' }, true);
    expect(g.L[3000]).toBeGreaterThan(0.1);
  });
});

// ------------------------------------------------------------------ sessions
/** A pattern with a click on its first tick, so the frame the transport starts on is audible. */
function withClick(r: ReturnType<typeof rig>) {
  const ch = createChannel('click', 'imp');
  ch.volume = 1;
  r.e.handle({ t: 'sample', id: 'imp', data: [Float32Array.of(1, 0, 0, 0)], sampleRate: SR });
  r.e.handle({ t: 'channel', c: ch });
  r.pat.notes[ch.id] = [createNote({ pos: 0, len: 24 })];
  r.e.handle({ t: 'pattern', p: r.pat });
}

/** First frame of `L` whose level exceeds `thr`. */
function firstAbove(L: Float32Array, thr: number, from = 0): number {
  for (let i = from; i < L.length; i++) if (Math.abs(L[i]) > thr) return i;
  return -1;
}

describe('recording: count-in', () => {
  it('plays the metronome for the bars of the count-in, holds the transport, then starts it and the capture together', () => {
    const r = rig();
    withClick(r);
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    const inp = ramp(SR * 8);
    run(r.e, BLOCK * 8, inp);
    const x = r.e.frame;
    r.e.handle({ t: 'recStart', o: { ...OPTS, countdownBars: 1, latencyComp: false } });
    // 120 BPM: a beat is 24000 frames, the bar 96000
    expect(r.e.rec.state).toBe('countdown');
    const [L] = run(r.e, 96000 + 5000, inp, x);
    expect(r.e.playing).toBe(true);
    // four clicks in the bar, the first on the first frame
    for (let k = 0; k < 4; k++) {
      const seg = L.subarray(k * 24000, k * 24000 + 1500);
      expect(Math.max(...seg.map(Math.abs)), `beat ${k}`).toBeGreaterThan(0.1);
      const gap = L.subarray(k * 24000 + 6000, (k + 1) * 24000 - 100);
      if (k < 3) expect(Math.max(...gap.map(Math.abs)), `gap ${k}`).toBeLessThan(1e-3);
    }
    // each click begins on its beat to the frame (the click is a sine: its first sample is zero, the next is not)
    for (let k = 0; k < 4; k++) {
      const first = firstAbove(L.subarray(k * 24000, k * 24000 + 24000), 1e-4) + k * 24000;
      expect(first, `beat ${k}`).toBe(k * 24000 + 1);
    }
    // the transport starts on the downbeat after the count-in: the pattern's click
    expect(firstAbove(L.subarray(96000 - 100), 0.4) + 96000 - 100).toBe(96000);
    r.e.handle({ t: 'recStop' });
    run(r.e, BLOCK * 4, inp, x + 96000 + 5000);
    const [g] = takes(r.msgs);
    expect(frameOf(g.L[0])).toBe(x + 96000);
    expect(g.tick0).toBe(0);
    const states = r.msgs.filter((m) => m.t === 'recState').map((m) => (m as { state: string }).state);
    expect(states.slice(0, 2)).toEqual(['countdown', 'recording']);
    expect(states[states.length - 1]).toBe('idle');
  });

  it('2 bars: eight clicks', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    const inp = ramp(SR * 8);
    r.e.handle({ t: 'recStart', o: { ...OPTS, countdownBars: 2, latencyComp: false } });
    const [L] = run(r.e, 2 * 96000 - 1000, inp);
    let clicks = 0;
    for (let k = 0; k < 8; k++) if (Math.max(...L.subarray(k * 24000, k * 24000 + 1500).map(Math.abs)) > 0.1) clicks++;
    expect(clicks).toBe(8);
    expect(r.e.playing).toBe(false);
    expect(r.e.pos).toBe(0);
  });

  it('is skipped when the transport already plays (recording starts at once)', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    const inp = ramp(SR);
    r.e.handle({ t: 'play' });
    run(r.e, BLOCK * 10, inp);
    const x = r.e.frame;
    r.e.handle({ t: 'recStart', o: { ...OPTS, countdownBars: 2, latencyComp: false } });
    expect(r.e.rec.state).toBe('recording');
    run(r.e, BLOCK * 10, inp, x);
    r.e.handle({ t: 'recStop' });
    run(r.e, BLOCK * 2, inp, x + BLOCK * 10);
    const [g] = takes(r.msgs);
    expect(frameOf(g.L[0])).toBe(x);
    // the take starts where the playhead was (about 10 blocks in)
    expect(g.tick0).toBeCloseTo((x / SR) * 192, 6);
  });

  it('stopping the transport in the count-in cancels the recording', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    const inp = ramp(SR * 4);
    r.e.handle({ t: 'recStart', o: { ...OPTS, countdownBars: 1 } });
    run(r.e, 30000, inp);
    r.e.handle({ t: 'stop' });
    expect(r.e.rec.active).toBe(false);
    expect(r.msgs.some((m) => m.t === 'recDone' && m.cancelled)).toBe(true);
    // the count-in is over for good: the transport never starts and the clicks that were left are not played
    const [L] = run(r.e, 96000, inp, 30000);
    expect(r.e.playing).toBe(false);
    expect(takes(r.msgs)).toHaveLength(0);
    expect(Math.max(...L.subarray(4800).map(Math.abs))).toBe(0); // after the click that was sounding has died away
  });
});

describe('recording: loop recording and takes', () => {
  function loopRig(tempo: number, loop: boolean, latency = 0) {
    const r = rig({ tempo });
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    r.e.handle({ t: 'mode', song: true, patternId: r.pat.id });
    r.e.handle({ t: 'loop', start: 0, end: 384 }); // one bar
    r.e.handle({ t: 'recLatency', input: latency, output: 0 });
    return r;
  }

  it('cuts a take at every pass of the loop, with no gap and no overlap', () => {
    const r = loopRig(120, true);
    const inp = ramp(SR * 6);
    run(r.e, BLOCK * 3, inp);
    const x = r.e.frame;
    r.e.handle({ t: 'recStart', o: { ...OPTS, loop: true, latencyComp: false } });
    const total = 96000 * 2 + 48000;
    run(r.e, total, inp, x);
    r.e.handle({ t: 'recStop' });
    run(r.e, BLOCK * 2, inp, x + total);
    const got = takes(r.msgs);
    expect(got.map((g) => g.frames)).toEqual([96000, 96000, 48000]);
    expect(got.map((g) => g.tick0)).toEqual([0, 0, 0]);
    // together they are the input stream, in order
    expect(frameOf(got[0].L[0])).toBe(x);
    expect(frameOf(got[1].L[0])).toBe(x + 96000);
    expect(frameOf(got[2].L[0])).toBe(x + 192000);
    expect(frameOf(got[2].L[47999])).toBe(x + 192000 + 47999);
  });

  it('the takes follow the loop to the frame when the loop length is not a whole number of frames', () => {
    const r = loopRig(133, true);
    const inp = ramp(SR * 8);
    const x = r.e.frame;
    r.e.handle({ t: 'recStart', o: { ...OPTS, loop: true, latencyComp: false } });
    const loopFrames = (384 * 60 * SR) / (133 * 96); // 86616.54...
    const total = Math.round(loopFrames * 3.5);
    run(r.e, total, inp, x);
    r.e.handle({ t: 'recStop' });
    run(r.e, BLOCK * 2, inp, x + total);
    const got = takes(r.msgs);
    expect(got).toHaveLength(4);
    let at = x;
    got.forEach((g, k) => {
      expect(frameOf(g.L[0])).toBe(at);
      at += g.frames;
      if (k < 3) expect(Math.abs(at - x - (k + 1) * loopFrames)).toBeLessThanOrEqual(1);
    });
  });

  it('with latency compensation every take is moved by the same amount, so the boundaries move with it', () => {
    const r = loopRig(120, true, 300);
    const inp = ramp(SR * 6);
    const x = r.e.frame;
    r.e.handle({ t: 'recStart', o: { ...OPTS, loop: true, latencyComp: true } });
    run(r.e, 96000 + 50000, inp, x);
    r.e.handle({ t: 'recStop' });
    run(r.e, BLOCK * 6, inp, x + 146000);
    const got = takes(r.msgs);
    expect(got.map((g) => g.frames)).toEqual([96000, 50000]);
    expect(frameOf(got[0].L[0])).toBe(x + 300);
    expect(frameOf(got[1].L[0])).toBe(x + 96000 + 300);
  });

  it('without loop recording the take runs through the loop points', () => {
    const r = loopRig(120, false);
    const inp = ramp(SR * 6);
    const x = r.e.frame;
    r.e.handle({ t: 'recStart', o: { ...OPTS, loop: false, latencyComp: false } });
    run(r.e, 96000 * 2 + 1000, inp, x);
    r.e.handle({ t: 'recStop' });
    run(r.e, BLOCK * 2, inp, x + 96000 * 2 + 1000);
    const got = takes(r.msgs);
    expect(got).toHaveLength(1);
    expect(got[0].frames).toBe(96000 * 2 + 1000);
  });

  it('recording runs on past the end of the song instead of looping it', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    r.e.handle({ t: 'mode', song: true, patternId: r.pat.id }); // an empty song: 4 bars = 8 s, then it loops
    const inp = ramp(SR * 12);
    r.e.handle({ t: 'recStart', o: { ...OPTS, latencyComp: false } });
    run(r.e, SR * 10, inp);
    expect(r.e.pos).toBeCloseTo(10 * 192, 3); // 10 s at 120 BPM
    r.e.handle({ t: 'recStop' });
    run(r.e, BLOCK * 2, inp, SR * 10);
    const got = takes(r.msgs);
    expect(got).toHaveLength(1);
    expect(got[0].frames).toBe(SR * 10);
    // ... and plain playback still loops it
    const r2 = rig();
    r2.e.handle({ t: 'mode', song: true, patternId: r2.pat.id });
    r2.e.handle({ t: 'play' });
    run(r2.e, SR * 10);
    expect(r2.e.pos).toBeLessThan(1536);
  });

  it('in pattern mode the pattern loops and loop recording takes one pass at a time', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    const inp = ramp(SR * 6);
    r.e.handle({ t: 'recStart', o: { ...OPTS, loop: true, latencyComp: false } });
    run(r.e, 96000 * 2 + 10, inp);
    r.e.handle({ t: 'recStop' });
    run(r.e, BLOCK * 2, inp, 96000 * 2 + 10);
    expect(takes(r.msgs).map((g) => g.frames)).toEqual([96000, 96000, 10]);
  });

  it('moving the playhead while recording starts a new take at the new position', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    r.e.handle({ t: 'mode', song: true, patternId: r.pat.id });
    const inp = ramp(SR * 6);
    r.e.handle({ t: 'recStart', o: { ...OPTS, latencyComp: false } });
    run(r.e, BLOCK * 100, inp);
    r.e.handle({ t: 'seek', tick: 768 });
    run(r.e, BLOCK * 50, inp, BLOCK * 100);
    r.e.handle({ t: 'recStop' });
    run(r.e, BLOCK * 2, inp, BLOCK * 150);
    const got = takes(r.msgs);
    expect(got.map((g) => g.frames)).toEqual([BLOCK * 100, BLOCK * 50]);
    expect(got[0].tick0).toBe(0);
    expect(got[1].tick0).toBe(768);
  });
});

describe('recording: wait for input, punch in / out, stopping', () => {
  it('waits for sound on an armed input, then starts the transport and the capture on that frame', () => {
    const r = rig();
    withClick(r);
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    const start = BLOCK * 8 + 77;
    // silence, then a tone whose samples number the frames since it began
    const inp = [new Float32Array(SR * 2).map((_, i) => (i < start ? 0 : 0.3 + (i - start) * 1e-7))];
    r.e.handle({ t: 'recLatency', input: 200, output: 200 });
    r.e.handle({ t: 'recStart', o: { ...OPTS, waitForInput: true, latencyComp: true } });
    expect(r.e.rec.state).toBe('waiting');
    const [L] = run(r.e, SR, inp);
    expect(firstAbove(L, 0.4)).toBe(start); // the transport started on the first sound
    r.e.handle({ t: 'recStop' });
    run(r.e, BLOCK * 3, inp, SR);
    const [g] = takes(r.msgs);
    // the first sound starts the take: nothing is cut off, whatever the latency
    expect(g.L[0]).toBeCloseTo(0.3, 6);
    expect(Math.round((g.L[1000] - 0.3) * 1e7)).toBe(1000);
  });

  it('a session that only runs the transport (recording into Edison) waits for the armed inputs as well', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    const inp = [new Float32Array(SR).map((_, i) => (i < 5000 ? 0 : 0.2))];
    r.e.handle({ t: 'recStart', o: { ...OPTS, waitForInput: true, capture: false } });
    expect(r.e.rec.state).toBe('waiting');
    run(r.e, SR / 2, inp);
    expect(r.e.playing).toBe(true);
    expect(r.e.rec.state).toBe('recording');
    r.e.handle({ t: 'recStop' });
    run(r.e, BLOCK * 3, inp, SR / 2);
    expect(r.msgs.some((m) => m.t === 'recDone' && !m.cancelled)).toBe(true);
    expect(takes(r.msgs)).toHaveLength(0);
  });

  it('keeps waiting while the input is quiet', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    r.e.handle({ t: 'recStart', o: { ...OPTS, waitForInput: true } });
    run(r.e, SR, [new Float32Array(SR).fill(0.002)]);
    expect(r.e.playing).toBe(false);
    expect(r.e.rec.state).toBe('waiting');
  });

  it('count-in first, then wait for input', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    const inp = [new Float32Array(SR * 5).map((_, i) => (i < 110000 ? 0 : 0.3))];
    r.e.handle({ t: 'recStart', o: { ...OPTS, countdownBars: 1, waitForInput: true } });
    run(r.e, 100000, inp);
    expect(r.e.rec.state).toBe('waiting'); // the bar is over, no sound yet
    expect(r.e.playing).toBe(false);
    run(r.e, 20000, inp, 100000);
    expect(r.e.playing).toBe(true);
  });

  it('punch in / out: the take covers the span between the two positions only', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    r.e.handle({ t: 'mode', song: true, patternId: r.pat.id });
    r.e.handle({ t: 'loop', start: 0, end: 1536 });
    const inp = ramp(SR * 5);
    r.e.handle({ t: 'play' });
    run(r.e, BLOCK * 10, inp);
    const x = r.e.frame;
    r.e.handle({ t: 'recStart', o: { ...OPTS, latencyComp: false, punchIn: 192, punchOut: 384 } });
    expect(r.e.rec.state).toBe('waiting'); // armed, waiting for the punch-in position
    run(r.e, SR * 3, inp, x);
    const [g] = takes(r.msgs);
    // 120 BPM: tick 192 is at 1 s, tick 384 at 2 s
    expect(g.frames).toBe(SR);
    expect(frameOf(g.L[0])).toBe(SR);
    expect(g.tick0).toBeCloseTo(192, 3);
    expect(r.e.rec.active).toBe(false);
    expect(r.e.playing).toBe(true); // the transport keeps playing after the punch-out
  });

  it('markers made from the time selection (the selection loops too): recording stops where the loop wraps', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    r.e.handle({ t: 'mode', song: true, patternId: r.pat.id });
    r.e.handle({ t: 'loop', start: 384, end: 768 });
    r.e.handle({ t: 'seek', tick: 384 });
    const inp = ramp(SR * 6);
    r.e.handle({ t: 'recStart', o: { ...OPTS, latencyComp: false, punchIn: 384, punchOut: 768 } });
    expect(r.e.rec.state).toBe('recording'); // the transport starts inside the span
    run(r.e, SR * 4, inp);
    const [g] = takes(r.msgs);
    expect(takes(r.msgs)).toHaveLength(1);
    expect(g.frames).toBe(2 * SR); // 384 ticks at 120 BPM
    expect(g.tick0).toBe(384);
    expect(r.e.rec.active).toBe(false);
    expect(r.e.playing).toBe(true); // the transport loops on
  });

  it('starting past the punch span: the transport plays on and the recording opens when the span comes round again', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    r.e.handle({ t: 'mode', song: true, patternId: r.pat.id });
    r.e.handle({ t: 'loop', start: 0, end: 1536 });
    r.e.handle({ t: 'seek', tick: 1000 });
    const inp = ramp(SR * 10);
    r.e.handle({ t: 'recStart', o: { ...OPTS, latencyComp: false, punchIn: 384, punchOut: 768 } });
    expect(r.e.playing).toBe(true);
    expect(r.e.rec.state).toBe('waiting');
    run(r.e, SR * 9, inp);
    // from 1000 to the loop end at 1536 (2.79 s), then 384 ticks (2 s) to the Start marker: the take begins at 4.79 s
    const [g] = takes(r.msgs);
    expect(takes(r.msgs)).toHaveLength(1);
    expect(g.tick0).toBeCloseTo(384, 2);
    expect(g.frames).toBe(2 * SR);
    expect(frameOf(g.L[0])).toBeCloseTo((536 + 384) * (SR / 192), -1);
  });

  it('stop ends the recording and plays the tail out; Record off leaves the transport playing', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off', inputDelay: 50 }); // 2400 frames
    const inp = ramp(SR * 3);
    r.e.handle({ t: 'recStart', o: { ...OPTS, latencyComp: false } });
    run(r.e, BLOCK * 20, inp);
    r.e.handle({ t: 'recStop' });
    expect(r.e.playing).toBe(true);
    expect(r.msgs.some((m) => m.t === 'recDone')).toBe(false); // still waiting for the tail
    run(r.e, 2000, inp, BLOCK * 20);
    expect(r.msgs.some((m) => m.t === 'recDone')).toBe(false);
    run(r.e, 1000, inp, BLOCK * 20 + 2000);
    expect(r.msgs.some((m) => m.t === 'recDone' && !m.cancelled)).toBe(true);
    const [g] = takes(r.msgs);
    expect(g.frames).toBe(BLOCK * 20);
    expect(frameOf(g.L[0])).toBe(2400);
    expect(frameOf(g.L[g.frames - 1])).toBe(2400 + BLOCK * 20 - 1);
  });

  it('a new recording can start while the last one plays out its latency tail; the first keeps what it has', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off', inputDelay: 50 }); // 2400 frames of tail
    const inp = ramp(SR * 3);
    r.e.handle({ t: 'recStart', o: { ...OPTS, latencyComp: false } });
    run(r.e, BLOCK * 20, inp);
    r.e.handle({ t: 'recStop' });
    run(r.e, BLOCK * 2, inp, BLOCK * 20); // the tail is not over
    expect(r.msgs.some((m) => m.t === 'recDone')).toBe(false);
    r.e.handle({ t: 'recStart', o: { ...OPTS, latencyComp: false } });
    expect(r.msgs.filter((m) => m.t === 'recDone')).toHaveLength(1); // the first session is over
    run(r.e, BLOCK * 30, inp, BLOCK * 22);
    r.e.handle({ t: 'recStop' });
    run(r.e, 3000, inp, BLOCK * 52);
    // take numbers start again in every session: read the two apart
    const end = r.msgs.findIndex((m) => m.t === 'recDone');
    const first = takes(r.msgs.slice(0, end + 1)), second = takes(r.msgs.slice(end + 1));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // the first take has the frames its capture window had reached when the second session began: it opens 2400
    // frames after the start and had been fed up to block 22
    expect(first[0].frames).toBe(BLOCK * 22 - 2400);
    expect(frameOf(first[0].L[0])).toBe(2400);
    expect(second[0].frames).toBe(BLOCK * 30);
    expect(frameOf(second[0].L[0])).toBe(BLOCK * 22 + 2400);
  });

  it('pausing or stopping the transport ends a running recording', () => {
    for (const msg of ['pause', 'stop'] as const) {
      const r = rig();
      r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
      const inp = ramp(SR);
      r.e.handle({ t: 'recStart', o: { ...OPTS, latencyComp: false } });
      run(r.e, BLOCK * 10, inp);
      r.e.handle({ t: msg });
      run(r.e, BLOCK * 3, inp, BLOCK * 10);
      expect(r.e.rec.active).toBe(false);
      expect(takes(r.msgs)[0].frames).toBe(BLOCK * 10);
    }
  });

  it('cancel drops everything', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    r.e.handle({ t: 'recStart', o: { ...OPTS, latencyComp: false } });
    run(r.e, BLOCK * 10, ramp(BLOCK * 10));
    r.e.handle({ t: 'recCancel' });
    expect(r.e.rec.active).toBe(false);
    expect(takes(r.msgs)).toHaveLength(0);
    expect(r.msgs.some((m) => m.t === 'recDone' && m.cancelled)).toBe(true);
  });

  it('long recordings arrive in chunks that add up', () => {
    const r = rig();
    r.track(1, { input: { ch: 0, mono: true }, armed: true, monitor: 'off' });
    const inp = ramp(SR * 3);
    r.e.handle({ t: 'recStart', o: { ...OPTS, latencyComp: false } });
    run(r.e, SR * 2 + 100, inp);
    r.e.handle({ t: 'recStop' });
    run(r.e, BLOCK * 2, inp, SR * 2 + 100);
    const chunks = r.msgs.filter((m) => m.t === 'recData');
    expect(chunks.length).toBeGreaterThan(5);
    const [g] = takes(r.msgs);
    expect(g.frames).toBe(SR * 2 + 100);
    for (const i of [0, REC_CHUNK - 1, REC_CHUNK, REC_CHUNK * 3 + 1, 50000, SR * 2 + 99]) expect(frameOf(g.L[i])).toBe(i);
  });
});

describe('Edison on a track with an audio input', () => {
  function edisonRig(patch: Partial<MixerTrack>, rec: number) {
    const r = rig();
    const id = 'ed1';
    const params = { ...defaultFxParams('edison'), rec, recMode: 0 };
    const slots = [{ id, plugin: 'edison', name: 'Edison', enabled: true, mix: 1, params }, ...Array(9).fill(null)];
    r.track(1, { input: { ch: 0, mono: true }, slots, ...patch });
    r.e.handle({ t: 'watchFx', ids: [id] });
    return r;
  }
  /** What Edison has recorded so far (its monitor data in the engine's 'fxMonitor' messages). */
  function recorded(msgs: FromEngine[]): number[] {
    const out: number[] = [];
    for (const m of msgs) {
      if (m.t !== 'fxMonitor') continue;
      for (const [, d] of m.items) if (d.recL instanceof Float32Array) out.push(...d.recL);
    }
    return out;
  }

  it('records the input of the track, though the track is not armed (When armed counts an armed Edison)', () => {
    const r = edisonRig({ monitor: 'armed' }, 1);
    run(r.e, SR / 2, [new Float32Array(SR / 2).fill(0.25)]);
    const got = recorded(r.msgs);
    expect(got.length).toBeGreaterThan(SR / 4);
    expect(got[got.length - 1]).toBeCloseTo(0.25, 4);
  });

  it('an Edison that is not armed leaves the input unmonitored', () => {
    const r = edisonRig({ monitor: 'armed' }, 0);
    const [L] = run(r.e, SR / 4, [new Float32Array(SR / 4).fill(0.25)]);
    expect(Math.max(...L.map(Math.abs))).toBe(0);
    expect(recorded(r.msgs)).toHaveLength(0);
  });

  it('monitoring Off keeps the input out of the track', () => {
    const r = edisonRig({ monitor: 'off' }, 1);
    run(r.e, SR / 4, [new Float32Array(SR / 4).fill(0.25)]);
    expect(Math.max(0, ...recorded(r.msgs).map(Math.abs))).toBe(0);
  });

  it('records what the effects before it did to the input, as it does for any signal', () => {
    // a volume-less path: the input plays through slot 0 (a gain-neutral effect) and reaches Edison in slot 1
    const r = rig();
    const params = { ...defaultFxParams('edison'), rec: 1, recMode: 0 };
    const ed = { id: 'ed2', plugin: 'edison', name: 'Edison', enabled: true, mix: 1, params };
    r.track(2, { input: { ch: 1, mono: true }, monitor: 'on', slots: [ed, ...Array(9).fill(null)] });
    r.e.handle({ t: 'watchFx', ids: ['ed2'] });
    run(r.e, SR / 4, [new Float32Array(SR / 4), new Float32Array(SR / 4).fill(-0.5)]);
    const got = recorded(r.msgs);
    expect(got[got.length - 1]).toBeCloseTo(-0.5, 4);
  });
});
