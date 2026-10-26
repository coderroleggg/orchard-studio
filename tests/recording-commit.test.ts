// Recording -> pool sample -> Playlist clip with the application's store, the Record
// button and the recording options (docs/recording.md).

import { describe, it, expect, vi } from 'vitest';
import type { FinishedTake, SessionInfo } from '../src/audio/Recorder';
import { defaultRecSettings } from '../src/model/recording';
import { encodeWav } from '../src/project/wav';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };

const SR = 48000;

function take(over: Partial<FinishedTake> = {}): FinishedTake {
  const L = new Float32Array(SR).map((_, i) => Math.sin(i / 50) * 0.5);
  return { take: 1, takes: 1, track: 5, startTick: 192, L, R: L.slice(), sampleRate: SR, name: 'Guitar', peak: 0.5, ...over };
}
function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return { tracks: [5], songMode: true, settings: defaultRecSettings(), cancelled: false, ...over };
}

describe('committing a recording', async () => {
  const { store, host } = await import('../src/store');
  const A = await import('../src/store/actions');
  const R = await import('../src/audio/recording');
  const { getRaw } = await import('../src/audio/samples');

  const clipsOf = (channelId: string) => store.project.playlist.clips.filter((c) => c.kind === 'audio' && c.channelId === channelId);

  it('a take becomes a pool sample kept like a user file and an Audio Clip with a Playlist clip at its start tick', () => {
    A.setMixer(5, 'armed', true, 'Arm');
    R.commitRecording([take()], session({ settings: { ...defaultRecSettings(), autoUnarm: false } }));
    const p = store.project;
    const ch = p.channels.find((c) => c.name === 'Guitar' && c.kind === 'audioclip')!;
    expect(ch).toBeTruthy();
    expect(ch.mixerTrack).toBe(5); // routed to the recorded mixer track
    const id = ch.sampler.sampleId!;
    expect(p.samples[id]).toMatchObject({ frames: SR, sampleRate: SR, channels: 2, source: { kind: 'user', key: id } });
    const raw = getRaw(id)!;
    expect(raw.channels).toHaveLength(2);
    expect(raw.channels[0].length).toBe(SR);
    expect(raw.channels[0][1000]).toBeCloseTo(Math.sin(1000 / 50) * 0.5, 6);
    const [clip] = clipsOf(ch.id);
    expect(clip).toMatchObject({ kind: 'audio', start: 192, muted: false, offset: 0 });
    // one second at 130 BPM, 96 PPQ: 208 ticks
    expect(clip.length).toBeGreaterThanOrEqual(208);
    expect(clip.length).toBeLessThanOrEqual(209);
    expect(store.historyLabels().past.at(-1)).toBe('Record audio');
  });

  it('is a single undo step, and undo / redo bring the recording back and forth', () => {
    const before = store.project.channels.length;
    const labels = store.historyLabels().past.length;
    R.commitRecording([take({ name: 'Undo me', startTick: 384 })], session());
    expect(store.project.channels.length).toBe(before + 1);
    expect(store.historyLabels().past.length).toBe(labels + 1);
    store.undo();
    expect(store.project.channels.length).toBe(before);
    expect(store.project.channels.some((c) => c.name === 'Undo me')).toBe(false);
    expect(store.project.playlist.clips.some((c) => c.start === 384 && c.kind === 'audio')).toBe(false);
    store.redo();
    expect(store.project.channels.some((c) => c.name === 'Undo me')).toBe(true);
  });

  it('Auto-unarm releases the recorded tracks in the same step; off keeps them armed', () => {
    A.setMixer(6, 'armed', true, 'Arm');
    R.commitRecording([take({ track: 6, name: 'Unarm' })], session({ tracks: [6] }));
    expect(store.project.mixer.tracks[6].armed).toBe(false);
    store.undo();
    expect(store.project.mixer.tracks[6].armed).toBe(true); // armed again with the recording gone
    store.redo();
    A.setMixer(7, 'armed', true, 'Arm');
    R.commitRecording([take({ track: 7, name: 'Stay' })], session({ tracks: [7], settings: { ...defaultRecSettings(), autoUnarm: false } }));
    expect(store.project.mixer.tracks[7].armed).toBe(true);
  });

  it('loop takes: all clips are placed, the ones before the last take are muted, a clip per track', () => {
    const takes = [1, 2, 3].map((n) => take({ take: n, takes: 3, track: 8, name: `Loop take ${n}`, startTick: 384 }));
    R.commitRecording(takes, session({ tracks: [8] }));
    const chans = takes.map((t) => store.project.channels.find((c) => c.name === t.name)!);
    const muted = chans.map((c) => clipsOf(c.id)[0].muted);
    expect(muted).toEqual([true, true, false]);
    // they do not sit on top of each other
    const tracks = chans.map((c) => clipsOf(c.id)[0].track);
    expect(new Set(tracks).size).toBe(3);
  });

  it('each recorded mixer track gets its own Playlist track', () => {
    R.commitRecording([take({ track: 9, name: 'Multi A', startTick: 768 }), take({ track: 10, name: 'Multi B', startTick: 768 })], session({ tracks: [9, 10] }));
    const a = clipsOf(store.project.channels.find((c) => c.name === 'Multi A')!.id)[0];
    const b = clipsOf(store.project.channels.find((c) => c.name === 'Multi B')!.id)[0];
    expect(a.track).not.toBe(b.track);
    expect(store.project.channels.find((c) => c.name === 'Multi B')!.mixerTrack).toBe(10);
  });

  it('pattern mode, or Auto-create audio clip off: the recording is an Audio Clip channel, no Playlist clip', () => {
    const clips = store.project.playlist.clips.length;
    R.commitRecording([take({ name: 'Pattern take' })], session({ songMode: false }));
    const ch = store.project.channels.find((c) => c.name === 'Pattern take')!;
    expect(ch.kind).toBe('audioclip');
    expect(ch.mixerTrack).toBe(5);
    expect(store.project.samples[ch.sampler.sampleId!]).toMatchObject({ frames: SR, source: { kind: 'user' } });
    expect(store.project.playlist.clips.length).toBe(clips);
    R.commitRecording([take({ name: 'No auto clip' })], session({ settings: { ...defaultRecSettings(), autoClip: false } }));
    expect(store.project.channels.some((c) => c.name === 'No auto clip')).toBe(true);
    expect(store.project.playlist.clips.length).toBe(clips);
  });

  it('Auto name playlist tracks names the Playlist track after the mixer track', () => {
    A.setMixer(11, 'name', 'Vocals', 'Rename');
    R.commitRecording([take({ track: 11, name: 'Vocals', startTick: 1152 })], session({ tracks: [11], settings: { ...defaultRecSettings(), autoName: true } }));
    const ch = store.project.channels.find((c) => c.name === 'Vocals' && c.kind === 'audioclip')!;
    const clip = clipsOf(ch.id)[0];
    expect(store.project.playlist.tracks[clip.track].name).toBe('Vocals');
  });

  it('a loop take of a whole bar gets a clip of exactly the bar, not one tick more', () => {
    // 130 BPM at 48 kHz: a bar is 88615.38 frames, so the takes are 88615 or 88616 frames long
    for (const frames of [88615, 88616]) {
      const L = new Float32Array(frames).fill(0.1);
      R.commitRecording([take({ name: `Bar ${frames}`, L, R: L.slice(), startTick: 1536 })], session());
      const ch = store.project.channels.find((c) => c.name === `Bar ${frames}`)!;
      expect(clipsOf(ch.id)[0].length).toBe(384);
    }
    // a take that is not a whole number of ticks keeps the length of its audio
    const L = new Float32Array(50000).fill(0.1);
    R.commitRecording([take({ name: 'Odd', L, R: L.slice(), startTick: 1920 })], session());
    const odd = clipsOf(store.project.channels.find((c) => c.name === 'Odd')!.id)[0];
    expect(odd.length).toBeGreaterThanOrEqual(216);
    expect(odd.length).toBeLessThanOrEqual(217);
  });

  it('a recording with no takes stores nothing', () => {
    const n = store.project.channels.length;
    const labels = store.historyLabels().past.length;
    R.commitRecording([], session());
    expect(store.project.channels.length).toBe(n);
    expect(store.historyLabels().past.length).toBe(labels);
  });
});

describe('the Record button and the mixer track actions', async () => {
  const { store, host } = await import('../src/store');
  const A = await import('../src/store/actions');
  const R = await import('../src/audio/recording');
  const { live } = await import('../src/audio/live');

  it('arms a track (with an undo step) and gives it an input', () => {
    R.armTrack(12, true);
    expect(store.project.mixer.tracks[12].armed).toBe(true);
    R.setTrackInput(12, { ch: 2 });
    expect(store.project.mixer.tracks[12].input).toEqual({ ch: 2 });
    expect(store.historyLabels().past.at(-1)).toBe('Mixer track input');
    R.setTrackInput(12, undefined);
    expect(store.project.mixer.tracks[12].input).toBeUndefined();
    R.armTrack(12, false);
    expect(store.project.mixer.tracks[12].armed).toBe(false);
    // the master and the Current track have no arm switch
    R.armTrack(0, true);
    R.armTrack(126, true);
    expect(store.project.mixer.tracks[0].armed).toBeFalsy();
    expect(store.project.mixer.tracks[126].armed).toBeFalsy();
  });

  it('R arms Record and R again releases it; playing starts nothing on its own', async () => {
    R.setRec({ startsPlayback: false });
    live.playing = false;
    await R.toggleRecord();
    expect(store.ui.recording).toBe(true);
    await R.toggleRecord();
    expect(store.ui.recording).toBe(false);
  });

  it('Play with Record on and no armed track plays normally and lets Record go, with a hint', async () => {
    host.resume = async () => {};
    store.updateUi((u) => { u.recording = true; });
    for (const t of store.project.mixer.tracks) if (t.armed) A.setMixer(t.index, 'armed', false, 'Disarm');
    const ok = await host.beforePlay!();
    expect(ok).toBe(false);
    expect(store.ui.recording).toBe(false);
  });

  it('Play with Record on and an armed track with an input asks the engine for a recording session', async () => {
    host.resume = async () => {};
    const latency = vi.fn();
    host.updateLatency = latency; // the audio context does not exist in Node
    host.input.ensureOpen = async () => true;
    host.input.state = { ...host.input.state, status: 'ready', channels: 2, deviceId: 'default' };
    R.armTrack(13, true);
    R.setTrackInput(13, { ch: 0 });
    R.setRec({ countdown: true, countdownBars: 2, loop: true, latencyComp: true, waitForInput: false });
    store.updateUi((u) => { u.recording = true; });
    const queue = (host as unknown as { queue: { t: string; o?: Record<string, unknown> }[] }).queue;
    queue.length = 0;
    const ok = await host.beforePlay!();
    expect(ok).toBe(true);
    const start = queue.find((m) => m.t === 'recStart')!;
    expect(start.o).toMatchObject({ countdownBars: 2, loop: true, latencyComp: true, waitForInput: false });
    expect(latency).toHaveBeenCalled(); // the device latency goes to the engine before the session starts
    // a Play pressed again meanwhile does not start a second session
    queue.length = 0;
    expect(await host.beforePlay!()).toBe(true);
    expect(queue.some((m) => m.t === 'recStart')).toBe(false);
    R.recorder.cancel();
  });

  it('recording options are kept across sessions', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('document', {}); // the browser: local storage is there
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } });
    R.setRec({ countdown: true, countdownBars: 2, bits: 24, audioTo: 'edison' });
    expect(JSON.parse(data.get('orchard-recording')!)).toMatchObject({ countdown: true, countdownBars: 2, bits: 24, audioTo: 'edison' });
    return import('../src/audio/recSettings').then(({ loadRecSettings }) => {
      expect(loadRecSettings()).toMatchObject({ countdown: true, countdownBars: 2, bits: 24, audioTo: 'edison', loop: true });
      vi.unstubAllGlobals();
    });
  });
});

describe('project files', async () => {
  const { store } = await import('../src/store');
  const A = await import('../src/store/actions');
  const { serialize, deserialize } = await import('../src/project/io');

  it('keep the mixer track inputs, arming, pickups, delays and the recording markers; older projects load as before', async () => {
    A.setMixer(20, 'input', { ch: 2, mono: true }, 'x');
    A.setMixer(20, 'armed', true, 'x');
    A.setMixer(20, 'pickup', 'lvl', 'x');
    A.setMixer(20, 'monitor', 'off', 'x');
    A.setMixer(20, 'inputDelay', -12.5, 'x');
    A.setMixer(20, 'inputAdjust', false, 'x');
    A.setMixer(20, 'recordName', 'Takes', 'x');
    store.update('markers', (d) => { d.playlist.markers.push({ id: 'mk1', pos: 96, name: 'Start recording', kind: 'recStart' }); });
    const saved = JSON.parse(JSON.stringify(serialize(store.project)));
    const back = await deserialize(saved);
    const t = back.mixer.tracks[20];
    expect(t).toMatchObject({ input: { ch: 2, mono: true }, armed: true, pickup: 'lvl', monitor: 'off', inputDelay: -12.5, inputAdjust: false, recordName: 'Takes' });
    expect(back.playlist.markers.find((m) => m.id === 'mk1')).toMatchObject({ kind: 'recStart', pos: 96 });
    // a project from before audio recording has none of these fields: the defaults apply
    delete (saved.project.mixer.tracks[20] as Record<string, unknown>).input;
    for (const k of ['armed', 'pickup', 'monitor', 'inputDelay', 'inputAdjust', 'recordName']) delete (saved.project.mixer.tracks[20] as Record<string, unknown>)[k];
    const old = (await deserialize(saved)).mixer.tracks[20];
    expect(old.input).toBeUndefined();
    expect(old.armed).toBeFalsy();
    expect(old.pickup ?? 'ext').toBe('ext');
    expect(old.monitor ?? 'armed').toBe('armed');
  });
});

describe('a saved project with a recording', async () => {
  const { store } = await import('../src/store');
  const R = await import('../src/audio/recording');
  const { serialize, deserialize } = await import('../src/project/io');
  const { getRaw, removeRaw } = await import('../src/audio/samples');

  it('embeds the recorded audio like any user sample and brings it back with its clip', async () => {
    const L = new Float32Array(4800).map((_, i) => Math.sin(i / 17) * 0.4);
    R.commitRecording([take({ name: 'Saved take', L, R: L.map((v) => -v), startTick: 96 })], session());
    const ch = store.project.channels.find((c) => c.name === 'Saved take')!;
    const id = ch.sampler.sampleId!;
    const saved = JSON.parse(JSON.stringify(serialize(store.project)));
    expect(saved.samples[id]).toMatchObject({ name: 'Saved take', sampleRate: SR });
    removeRaw(id); // a fresh session: the pool is empty
    expect(getRaw(id)).toBeUndefined();
    const back = await deserialize(saved);
    const raw = getRaw(id)!;
    expect(Array.from(raw.channels[0].subarray(0, 50))).toEqual(Array.from(L.subarray(0, 50)));
    expect(raw.channels[1][100]).toBe(-L[100]);
    expect(back.samples[id]).toMatchObject({ source: { kind: 'user' } });
    const clip = back.playlist.clips.find((c) => c.kind === 'audio' && c.channelId === ch.id)!;
    expect(clip.start).toBe(96);
  });
});

describe('the recorded file', () => {
  it('32-bit float WAV keeps every sample exactly; 16 and 24 bit are PCM', () => {
    const L = Float32Array.of(0.5, -0.25, 1e-7, -1);
    const R = Float32Array.of(0.1, 0.2, 0.3, 0.4);
    const buf = encodeWav([L, R], 44100, 32);
    const v = new DataView(buf);
    const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(v.getUint16(20, true)).toBe(3); // IEEE float
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint16(34, true)).toBe(32);
    expect(tag(36)).toBe('fact');
    expect(tag(48)).toBe('data');
    expect(v.getUint32(52, true)).toBe(4 * 2 * 4);
    expect(buf.byteLength).toBe(56 + 32);
    const got = Array.from({ length: 8 }, (_, i) => v.getFloat32(56 + i * 4, true));
    expect(got).toEqual([L[0], R[0], L[1], R[1], L[2], R[2], L[3], R[3]]);
    expect(new DataView(encodeWav([L, R], 44100, 24)).getUint16(20, true)).toBe(1);
    expect(new DataView(encodeWav([L, R], 44100, 16)).getUint16(34, true)).toBe(16);
  });
});
