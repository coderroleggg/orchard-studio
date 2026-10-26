// The Record flow: the Recorder (main thread) driving a real engine with simulated
// input buffers, from arming tracks to the finished takes, with the application
// around it stubbed (docs/recording.md).

import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../src/engine/Engine';
import { Recorder, MAX_REC_SECONDS, punchMarkers, type FinishedTake, type RecEnv, type SessionInfo } from '../src/audio/Recorder';
import { createChannel, createDefaultProject, createMixerTrack } from '../src/model/defaults';
import { defaultRecSettings, type RecSettings } from '../src/model/recording';
import type { Project } from '../src/model/types';
import type { FromEngine, ToEngine } from '../src/engine/protocol';

const SR = 48000;
const BLOCK = 128;

function ramp(frames: number): Float32Array {
  const a = new Float32Array(frames);
  for (let i = 0; i < frames; i++) a[i] = (i + 1) * 1e-6;
  return a;
}
const frameOf = (v: number): number => Math.round(v * 1e6) - 1;

/** The Recorder, an engine behind it and the stubbed application around them. */
function rig(opts: { tempo?: number; inputReady?: boolean; inputStatus?: string; songMode?: boolean } = {}) {
  const project: Project = createDefaultProject({}, {});
  project.tempo = opts.tempo ?? 120;
  project.songMode = !!opts.songMode;
  const settings: RecSettings = { ...defaultRecSettings(), latencyComp: false };
  const hints: string[] = [];
  const committed: { takes: FinishedTake[]; session: SessionInfo }[] = [];
  const armedCalls: boolean[] = [];
  const edison: string[] = [];
  const messages: ToEngine[] = [];
  const states: string[] = [];
  let ready = opts.inputReady ?? true;
  let status = opts.inputStatus ?? 'ready';
  let resumed = 0;

  const e = new Engine({ sampleRate: SR, blockSize: BLOCK, post: (m: FromEngine) => rec.onEngine(m) });
  e.handle({ t: 'globals', g: { tempo: project.tempo, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } });
  for (const t of project.mixer.tracks) e.handle({ t: 'mixerTrack', tr: t });
  e.handle({ t: 'mode', song: !!opts.songMode, patternId: project.currentPatternId });

  const env: RecEnv = {
    send: (m) => { messages.push(m); e.handle(m); },
    project: () => project,
    settings: () => settings,
    sampleRate: () => SR,
    resume: async () => { resumed++; },
    input: {
      get ready() { return ready; },
      ensureOpen: async () => ready,
      describe: () => (status === 'off' ? 'No audio input selected' : 'The browser did not give access to the audio input'),
      get state() { return { status }; },
    },
    updateLatency: () => e.handle({ t: 'recLatency', input: 0, output: 0 }),
    startTick: () => e.pos,
    hint: (t) => { hints.push(t); },
    commit: (takes, session) => { committed.push({ takes, session }); },
    setArmed: (on) => { armedCalls.push(on); },
    edisonStart: (tracks) => { edison.push('start ' + tracks.join(',')); },
    edisonStop: (tracks) => { edison.push('stop ' + tracks.join(',')); },
    onState: (s) => { states.push(s.state); },
  };
  const rec = new Recorder(env);

  /** Edit a mixer track in the project and the engine. */
  const track = (i: number, patch: Partial<Project['mixer']['tracks'][number]>) => {
    project.mixer.tracks[i] = { ...createMixerTrack(i), ...project.mixer.tracks[i], ...patch };
    e.handle({ t: 'mixerTrack', tr: project.mixer.tracks[i] });
  };
  const input = [ramp(SR * 20)];
  let at = 0;
  /** Run the engine for `frames` frames of the simulated input. */
  const run = (frames: number) => {
    const bL = new Float32Array(BLOCK), bR = new Float32Array(BLOCK);
    for (let off = 0; off < frames; off += BLOCK) {
      const n = Math.min(BLOCK, frames - off);
      e.process(bL, bR, n, [input[0].subarray(at, at + n)]);
      at += n;
    }
  };
  return {
    e, rec, project, settings, hints, committed, armedCalls, edison, messages, states, track, run, input,
    get at() { return at; },
    setInput(r: boolean, s = 'ready') { ready = r; status = s; },
    get resumed() { return resumed; },
  };
}

describe('Record: starting', () => {
  it('records the armed tracks and hands the takes over when the engine is done', async () => {
    const r = rig();
    r.track(5, { input: { ch: 0, mono: true }, armed: true, name: 'Guitar' });
    r.run(BLOCK * 10);
    const x = r.at;
    expect(await r.rec.start()).toBe(true);
    expect(r.resumed).toBe(1);
    r.run(BLOCK * 40);
    r.rec.stop();
    r.run(BLOCK * 4);
    expect(r.committed).toHaveLength(1);
    const { takes, session } = r.committed[0];
    expect(takes).toHaveLength(1);
    const t = takes[0];
    expect(t).toMatchObject({ track: 5, take: 1, takes: 1, startTick: 0, name: 'Guitar', sampleRate: SR });
    expect(t.L.length).toBe(BLOCK * 40);
    expect(frameOf(t.L[0])).toBe(x);
    expect(frameOf(t.L[t.L.length - 1])).toBe(x + BLOCK * 40 - 1);
    expect(t.R).toEqual(t.L); // a mono input: both sides
    expect(t.peak).toBeGreaterThan(0);
    expect(session).toMatchObject({ tracks: [5], songMode: false, cancelled: false });
    // Record lets go when the recording is over ("Disarm on stop")
    expect(r.armedCalls).toEqual([false]);
    expect(r.rec.active).toBe(false);
  });

  it('the track name, or the name given with the arm button, names the take', async () => {
    const r = rig();
    r.track(6, { input: { ch: 0, mono: true }, armed: true });
    r.track(7, { input: { ch: 0, mono: true }, armed: true, recordName: 'Lead vocal' });
    await r.rec.start();
    r.run(BLOCK * 8);
    r.rec.stop();
    r.run(BLOCK * 2);
    expect(r.committed[0].takes.map((t) => [t.track, t.name])).toEqual([[6, 'Insert 6'], [7, 'Lead vocal']]);
  });

  it('names do not repeat: another recording on a track already used gets the next free name', async () => {
    const r = rig();
    r.track(5, { input: { ch: 0, mono: true }, armed: true });
    r.track(6, { input: { ch: 0, mono: true }, armed: true, recordName: 'Vox' });
    r.track(7, { input: { ch: 0, mono: true }, armed: true, recordName: 'Vox' }); // two tracks, one name
    r.project.channels.push(createChannel('Insert 5', null, 5)); // from an earlier recording
    const record = async () => {
      await r.rec.start();
      r.run(BLOCK * 6);
      r.rec.stop();
      r.run(BLOCK * 2);
      return r.committed.at(-1)!.takes.map((t) => [t.track, t.name]);
    };
    expect(await record()).toEqual([[5, 'Insert 5 2'], [6, 'Vox'], [7, 'Vox 2']]);
    // the takes of a loop recording count as using the name too
    r.project.channels.push(createChannel('Insert 5 2 take 1', null, 5));
    r.track(5, { armed: true }); r.track(6, { armed: true }); r.track(7, { armed: true });
    expect((await record()).map((x) => x[1])).toEqual(['Insert 5 3', 'Vox', 'Vox 2']);
  });

  it('nothing armed: says so and records nothing', async () => {
    const r = rig();
    r.track(5, { input: { ch: 0, mono: true } });
    expect(await r.rec.start()).toBe(false);
    expect(r.hints[0]).toMatch(/arm a mixer track/i);
    expect(r.messages).toHaveLength(0);
  });

  it("a track armed without an input says FL's words, and the others still record", async () => {
    const r = rig();
    r.track(5, { armed: true, name: 'Bass' });
    expect(await r.rec.start()).toBe(false);
    expect(r.hints).toContain("Bass won't record anything unless you select an input!");
    r.hints.length = 0;
    r.track(6, { input: { ch: 0, mono: true }, armed: true });
    expect(await r.rec.start()).toBe(true);
    expect(r.hints).toContain("Bass won't record anything unless you select an input!");
    r.run(BLOCK * 4);
    r.rec.stop();
    r.run(BLOCK * 2);
    expect(r.committed[0].takes.map((t) => t.track)).toEqual([6]);
  });

  it('a track picking up after its input stage records without an input', async () => {
    const r = rig();
    r.track(5, { armed: true, pickup: 'post' });
    expect(await r.rec.start()).toBe(true);
    r.run(BLOCK * 4);
    r.rec.stop();
    r.run(BLOCK * 2);
    expect(r.committed[0].takes[0].track).toBe(5);
  });

  it('no audio input open: asks for one (FL: please select an audio input first)', async () => {
    const r = rig({ inputReady: false, inputStatus: 'off' });
    r.track(5, { input: { ch: 0, mono: true }, armed: true });
    expect(await r.rec.start()).toBe(false);
    expect(r.hints.at(-1)).toMatch(/audio input needed/i);
    expect(r.messages).toHaveLength(0);
    // the browser refused the microphone
    const d = rig({ inputReady: false, inputStatus: 'denied' });
    d.track(5, { input: { ch: 0, mono: true }, armed: true });
    expect(await d.rec.start()).toBe(false);
    expect(d.hints.at(-1)).toMatch(/did not give access/i);
  });

  it('audio is not in the recording filter: nothing to record', async () => {
    const r = rig();
    r.settings.filterAudio = false;
    r.track(5, { input: { ch: 0, mono: true }, armed: true });
    expect(await r.rec.start()).toBe(false);
    expect(r.hints[0]).toMatch(/recording filter/);
  });

  it('a second start while recording does nothing', async () => {
    const r = rig();
    r.track(5, { input: { ch: 0, mono: true }, armed: true });
    expect(await r.rec.start()).toBe(true);
    expect(await r.rec.start()).toBe(false);
    expect(r.messages.filter((m) => m.t === 'recStart')).toHaveLength(1);
  });
});

describe('Record: count-in, loop recording, silence', () => {
  it('count-in: the states go countdown, recording, idle and the take starts after the bars', async () => {
    const r = rig();
    r.settings.countdown = true;
    r.settings.countdownBars = 2;
    r.track(5, { input: { ch: 0, mono: true }, armed: true });
    r.run(BLOCK * 3);
    const x = r.at;
    await r.rec.start();
    r.run(2 * 96000 + 4000);
    r.rec.stop();
    r.run(BLOCK * 3);
    expect(r.states).toContain('countdown');
    expect(r.states.indexOf('recording')).toBeGreaterThan(r.states.indexOf('countdown'));
    expect(r.states.at(-1)).toBe('idle');
    const t = r.committed[0].takes[0];
    expect(frameOf(t.L[0])).toBe(x + 2 * 96000);
    expect(t.L.length).toBe(4000);
  });

  it('loop recording: one take per pass, named by take, the clips start at the loop start', async () => {
    const r = rig({ songMode: true });
    r.settings.loop = true;
    r.track(5, { input: { ch: 0, mono: true }, armed: true, name: 'Keys' });
    r.e.handle({ t: 'loop', start: 384, end: 768 }); // bar 2
    r.e.handle({ t: 'seek', tick: 384 });
    await r.rec.start();
    r.run(96000 * 2 + 3000);
    r.rec.stop();
    r.run(BLOCK * 3);
    const takes = r.committed[0].takes;
    expect(takes.map((t) => [t.take, t.takes, t.name, t.startTick, t.L.length])).toEqual([
      [1, 3, 'Keys take 1', 384, 96000], [2, 3, 'Keys take 2', 384, 96000], [3, 3, 'Keys take 3', 384, 3000],
    ]);
  });

  it('a position between two ticks is kept: the clip starts on a tick and the audio carries the rest', async () => {
    const r = rig();
    r.track(5, { input: { ch: 0, mono: true }, armed: true });
    r.e.handle({ t: 'play' });
    r.run(BLOCK * 3); // 384 frames = 1.536 ticks at 120 BPM (250 frames a tick)
    const x = r.at;
    await r.rec.start();
    r.run(BLOCK * 20);
    r.rec.stop();
    r.run(BLOCK * 3);
    const t = r.committed[0].takes[0];
    expect(t.startTick).toBe(2);
    // the first frame played at tick 1.536; the clip starts at tick 2, 116 frames later: those frames are cut
    expect(frameOf(t.L[0])).toBe(x + 116);
    expect(t.L.length).toBe(BLOCK * 20 - 116);
  });

  it('a start position just after a tick pads the beginning with silence instead', async () => {
    const r = rig();
    r.track(5, { input: { ch: 0, mono: true }, armed: true });
    r.e.handle({ t: 'seek', tick: 10.3 });
    r.e.handle({ t: 'play' });
    r.run(BLOCK * 2); // not part of the take
    r.e.handle({ t: 'seek', tick: 10.3 });
    const x = r.at;
    await r.rec.start();
    r.run(BLOCK * 10);
    r.rec.stop();
    r.run(BLOCK * 3);
    const t = r.committed[0].takes[0];
    expect(t.startTick).toBe(10);
    expect(Array.from(t.L.subarray(0, 75)).every((v) => v === 0)).toBe(true); // 0.3 tick = 75 frames of silence
    expect(frameOf(t.L[75])).toBe(x);
    expect(t.L.length).toBe(BLOCK * 10 + 75);
  });

  it('take numbers start at 1 in every session', async () => {
    const r = rig();
    r.track(5, { input: { ch: 0, mono: true }, armed: true, name: 'Keys' });
    r.settings.loop = true;
    r.e.handle({ t: 'mode', song: true, patternId: r.project.currentPatternId });
    r.e.handle({ t: 'loop', start: 0, end: 384 });
    for (let session = 0; session < 2; session++) {
      await r.rec.start();
      r.run(96000 + 2000);
      r.rec.stop();
      r.run(BLOCK * 3);
      r.e.handle({ t: 'stop' });
    }
    expect(r.committed).toHaveLength(2);
    for (const c of r.committed) expect(c.takes.map((t) => [t.take, t.name])).toEqual([[1, 'Keys take 1'], [2, 'Keys take 2']]);
  });

  it('silent takes are ignored on request', async () => {
    const r = rig();
    r.settings.ignoreSilent = true;
    r.track(5, { input: { ch: 0, mono: true }, armed: true });
    r.input[0].fill(0, 0, SR * 2);
    await r.rec.start();
    r.run(BLOCK * 10);
    r.rec.stop();
    r.run(BLOCK * 3);
    expect(r.committed).toHaveLength(1);
    expect(r.committed[0].takes).toHaveLength(0);
    expect(r.hints.some((h) => /silent take/.test(h))).toBe(true);
  });

  it('cancel keeps nothing and lets Record go', async () => {
    const r = rig();
    r.track(5, { input: { ch: 0, mono: true }, armed: true });
    await r.rec.start();
    r.run(BLOCK * 10);
    r.rec.cancel();
    expect(r.committed).toHaveLength(0);
    expect(r.armedCalls).toEqual([false]);
    expect(r.rec.active).toBe(false);
  });

  it('keeps what it has when the engine never reports the end of a stopped recording', async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      r.track(5, { input: { ch: 0, mono: true }, armed: true, inputDelay: 2000 }); // a 2 s tail to play out
      await r.rec.start();
      r.run(BLOCK * 10);
      r.rec.stop();
      expect(r.rec.active).toBe(true); // the engine has not run again: no 'recDone' yet
      vi.advanceTimersByTime(9000);
      expect(r.rec.active).toBe(true);
      vi.advanceTimersByTime(2000);
      expect(r.rec.active).toBe(false);
      expect(r.committed).toHaveLength(1);
      expect(r.armedCalls).toEqual([false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops by itself at the length limit', async () => {
    expect(MAX_REC_SECONDS).toBe(600);
    const r = rig();
    r.track(5, { input: { ch: 0, mono: true }, armed: true });
    await r.rec.start();
    // feed a chunk the size of the limit through the engine message path
    r.rec.onEngine({ t: 'recData', take: 1, track: 5, off: MAX_REC_SECONDS * SR, L: new Float32Array(10), R: new Float32Array(10) });
    expect(r.hints.some((h) => /limit/.test(h))).toBe(true);
    expect(r.messages.some((m) => m.t === 'recStop')).toBe(true);
  });
});

describe('Record: into Edison, punch markers', () => {
  it('into Edison: Edison is armed on the recorded tracks, the engine only runs the transport side, nothing is stored', async () => {
    const r = rig();
    r.settings.audioTo = 'edison';
    r.track(5, { input: { ch: 0, mono: true }, armed: true });
    expect(await r.rec.start()).toBe(true);
    expect(r.edison).toEqual(['start 5']);
    const start = r.messages.find((m) => m.t === 'recStart') as { o: { capture?: boolean } };
    expect(start.o.capture).toBe(false);
    r.run(BLOCK * 10);
    expect(r.e.playing).toBe(true);
    r.rec.stop();
    r.run(BLOCK * 3);
    expect(r.edison).toEqual(['start 5', 'stop 5']);
    // nothing to store, but the session is reported so that the tracks are released
    expect(r.committed).toHaveLength(1);
    expect(r.committed[0].takes).toHaveLength(0);
    expect(r.committed[0].session).toMatchObject({ edison: true, tracks: [5], cancelled: false });
    expect(r.armedCalls).toEqual([false]);
  });

  it('recording markers punch in and out at the Start / Stop recording markers', async () => {
    const r = rig({ songMode: true });
    r.settings.markers = true;
    r.track(5, { input: { ch: 0, mono: true }, armed: true });
    r.project.playlist.markers = [
      { id: 'a', pos: 384, name: 'Start recording', kind: 'recStart' },
      { id: 'b', pos: 768, name: 'Stop recording', kind: 'recStop' },
      { id: 'c', pos: 100, name: 'A marker' },
    ];
    expect(punchMarkers(r.project)).toEqual({ start: 384, end: 768 });
    r.e.handle({ t: 'loop', start: 0, end: 1536 });
    await r.rec.start(); // the transport starts at 0 and waits for the punch-in
    r.run(SR * 6);
    // 120 BPM: tick 384 is at 2 s, tick 768 at 4 s
    expect(r.committed).toHaveLength(1);
    const t = r.committed[0].takes[0];
    expect(t.startTick).toBe(384);
    expect(t.L.length).toBe(2 * SR);
    expect(frameOf(t.L[0])).toBe(2 * SR);
  });

  it('recording markers enabled but none in the Playlist: says so and records as usual', async () => {
    const r = rig();
    r.settings.markers = true;
    r.track(5, { input: { ch: 0, mono: true }, armed: true });
    expect(await r.rec.start()).toBe(true);
    expect(r.hints.some((h) => /no Start recording \/ Stop recording pair/.test(h))).toBe(true);
    const start = r.messages.find((m) => m.t === 'recStart') as { o: { punchIn?: number } };
    expect(start.o.punchIn).toBeUndefined();
    expect(r.e.rec.state).toBe('recording');
  });

  it('markers need a start before the stop', () => {
    const p = createDefaultProject({}, {});
    p.playlist.markers = [{ id: 'b', pos: 100, name: 'Stop recording', kind: 'recStop' }, { id: 'a', pos: 400, name: 'Start recording', kind: 'recStart' }];
    expect(punchMarkers(p)).toBeNull();
    p.playlist.markers = [];
    expect(punchMarkers(p)).toBeNull();
  });
});
