// Audio Clips (docs/audio-clips.md): the model (Audio Clip channel, 'audio' clips, gain and fade laws, the
// time mapping), project IO with migration of older projects, the addAudioClip action, and (below) the engine.
import { describe, it, expect } from 'vitest';
import {
  createAudioClipChannel, createChannel, createDefaultProject, createMixerTrack, normalizeChannel, normalizeProject, uid,
} from '../src/model/defaults';
import {
  AUDIO_CLIP_VOLUME_DEFAULT, CLIP_GAIN_MAX_DB, CLIP_GAIN_MIN_DB, audioClipTicks, clipGainLinear, clipSeconds, fadeShape, normalizeAudioClip,
  resampleSpeed, sourceSeconds, stretcherActive, trimmedFrames,
} from '../src/model/audioclip';
import { defaultSampler, stretchMultiplier } from '../src/model/sampler';
import { channelVolumeToGain } from '../src/model/scales';
import type { Channel, Clip, Project, SampleInfo } from '../src/model/types';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };

const info = (frames: number, sampleRate = 48000): SampleInfo => ({
  id: 's1', name: 'Loop', frames, sampleRate, channels: 2, source: { kind: 'user', key: 's1' },
});

function audioClip(partial: Partial<Clip> & { channelId: string }): Clip {
  return { id: uid('k'), track: 0, kind: 'audio', patternId: '', start: 0, length: 384, offset: 0, muted: false, ...partial };
}

describe('Audio Clip model', () => {
  it('creates an Audio Clip channel that plays at 100% and holds its sample', () => {
    const c = createAudioClipChannel('Loop', 's1', 3);
    expect(c.kind).toBe('audioclip');
    expect(c.sampler.sampleId).toBe('s1');
    expect(c.mixerTrack).toBe(3);
    expect(c.volume).toBe(AUDIO_CLIP_VOLUME_DEFAULT);
    expect(channelVolumeToGain(c.volume)).toBe(1); // the Sampler's default is -5.2 dB, an Audio Clip plays the original level
    expect(c.pan).toBe(0);
    expect(c.enabled).toBe(true);
    expect(createChannel('Kick', null).volume).toBeLessThan(1);
  });

  it('maps the clip gain (dB) and keeps it in range', () => {
    expect(clipGainLinear(undefined)).toBe(1);
    expect(clipGainLinear(0)).toBe(1);
    expect(clipGainLinear(-6)).toBeCloseTo(0.5012, 4);
    expect(clipGainLinear(CLIP_GAIN_MAX_DB)).toBeCloseTo(3.981, 3);
    expect(clipGainLinear(CLIP_GAIN_MIN_DB)).toBe(0);
    expect(clipGainLinear(-200)).toBe(0);
  });

  it('shapes fades: linear at tension 0, slow start for positive tension', () => {
    expect(fadeShape(0.25, 0)).toBeCloseTo(0.25, 9);
    expect(fadeShape(0, 0.7)).toBe(0);
    expect(fadeShape(1, -0.7)).toBe(1);
    expect(fadeShape(0.5, 0.5)).toBeLessThan(0.5);
    expect(fadeShape(0.5, -0.5)).toBeGreaterThan(0.5);
  });

  it('measures the sample as the channel plays it (SMP START / LENGTH trim)', () => {
    const s = defaultSampler('s1');
    expect(trimmedFrames(48000, s)).toBe(48000);
    expect(sourceSeconds(info(48000), s)).toBe(1);
    s.smpStart = 0.25;
    s.length = 0.75;
    expect(trimmedFrames(48000, s)).toBe(24000);
    expect(sourceSeconds(info(48000), s)).toBeCloseTo(0.5, 9);
  });

  it('gives a clip the length of the sample in ticks, rounded up, and follows the stretch settings', () => {
    // 120 BPM, PPQ 96: 192 ticks a second
    const s = defaultSampler('s1');
    expect(audioClipTicks(info(48000), s, 120, 96)).toBe(192);
    expect(audioClipTicks(info(48001), s, 120, 96)).toBe(193); // never cuts the tail
    expect(audioClipTicks(info(24000), s, 120, 96)).toBe(96);
    // TIME = 4 beats at 120 BPM = 2 s whatever the sample is
    s.stretchTimeBeats = 4;
    expect(audioClipTicks(info(24000), s, 120, 96)).toBe(384);
    expect(clipSeconds(0.5, s, 120)).toBe(2);
    expect(clipSeconds(0.5, s, 60)).toBe(4); // tempo sync: half the tempo, twice the time
    // MUL doubles the duration (knob 0.5 = 100%)
    s.stretchTimeBeats = 0;
    s.stretchMul = 0.5 + Math.log(2) / Math.log(16);
    expect(stretchMultiplier(s.stretchMul)).toBeCloseTo(2, 9);
    expect(audioClipTicks(info(48000), s, 120, 96)).toBe(384);
    // the header pitch (resample speed): +12 st plays twice as fast
    s.stretchMul = 0.5;
    expect(audioClipTicks(info(48000), s, 120, 96, 1200)).toBe(96);
  });

  it('plays at a speed that makes the sample last TIME beats in Resample mode only', () => {
    const s = defaultSampler('s1');
    expect(resampleSpeed(0.5, s, 120)).toBe(1);
    s.stretchTimeBeats = 4; // 2 s at 120 BPM for a 0.5 s sample: 1/4 speed
    expect(resampleSpeed(0.5, s, 120)).toBeCloseTo(0.25, 9);
    expect(resampleSpeed(0.5, s, 60)).toBeCloseTo(0.125, 9);
    s.stretchMode = 'e3generic'; // the stretcher renders the Playlist duration: the engine plays it at speed 1
    expect(resampleSpeed(0.5, s, 120)).toBe(1);
    expect(stretcherActive(s)).toBe(true);
    s.stretchTimeBeats = 0;
    expect(stretcherActive(s)).toBe(false);
    s.stretchPitch = 200;
    expect(stretcherActive(s)).toBe(true);
  });

  it('sanitises the audio fields of a clip and leaves defaults out', () => {
    const c = normalizeAudioClip(audioClip({ channelId: 'a', length: 96, fadeIn: 200, fadeOut: -5, fadeInTension: 4, gain: 99 }));
    expect(c.fadeIn).toBe(96); // within the clip
    expect(c.fadeOut).toBeUndefined();
    expect(c.fadeInTension).toBe(1);
    expect(c.gain).toBe(CLIP_GAIN_MAX_DB);
    const plain = normalizeAudioClip(audioClip({ channelId: 'a', fadeIn: 0, gain: 0, fadeOutTension: 0 }));
    expect('fadeIn' in plain || 'gain' in plain || 'fadeOutTension' in plain).toBe(false);
    // other clip kinds carry no audio fields
    const pat = normalizeAudioClip({ ...audioClip({ channelId: 'a', fadeIn: 5 }), kind: 'pattern', patternId: 'p' });
    expect(pat.channelId).toBeUndefined();
    expect(pat.fadeIn).toBeUndefined();
  });
});

describe('project IO: audio clips and migration of older projects', () => {
  const project = (): Project => createDefaultProject({}, {});

  it('keeps Audio Clip channels and audio clips through a save / load round trip', () => {
    const p = project();
    const ch = createAudioClipChannel('Loop', 's1', 2);
    ch.volume = 0.9;
    ch.pan = -0.25;
    ch.sampler.stretchMode = 'e3generic';
    ch.sampler.stretchTimeBeats = 4;
    p.samples.s1 = info(96000);
    p.channels.push(ch);
    p.playlist.clips.push(audioClip({ channelId: ch.id, start: 96, length: 768, offset: 24, fadeIn: 48, fadeOut: 24, fadeOutTension: -0.5, gain: -3, track: 4 }));
    const back = normalizeProject(JSON.parse(JSON.stringify(p)) as Project);
    const c2 = back.channels.find((c) => c.id === ch.id) as Channel;
    expect(c2.kind).toBe('audioclip');
    expect(c2.volume).toBe(0.9);
    expect(c2.pan).toBe(-0.25);
    expect(c2.mixerTrack).toBe(2);
    expect(c2.sampler.stretchMode).toBe('e3generic');
    expect(c2.sampler.sampleId).toBe('s1');
    const k = back.playlist.clips.find((x) => x.kind === 'audio')!;
    expect(k).toMatchObject({ channelId: ch.id, start: 96, length: 768, offset: 24, track: 4, fadeIn: 48, fadeOut: 24, fadeOutTension: -0.5, gain: -3 });
    expect(back.samples.s1.frames).toBe(96000);
  });

  it('loads a project saved before audio clips existed (clips without a kind, no audio fields)', () => {
    const p = project();
    const old = JSON.parse(JSON.stringify(p)) as Project;
    old.playlist.clips = [{ id: 'k1', track: 1, patternId: p.patterns[0].id, start: 0, length: 384, offset: 0, muted: false } as unknown as Clip];
    const back = normalizeProject(old);
    expect(back.playlist.clips).toEqual([{ id: 'k1', track: 1, kind: 'pattern', patternId: p.patterns[0].id, start: 0, length: 384, offset: 0, muted: false }]);
    expect(back.channels.every((c) => c.kind === 'sampler')).toBe(true);
  });

  it('drops audio clips whose Audio Clip channel is gone, and clips that point at a Sampler', () => {
    const p = project();
    const sampler = p.channels[0];
    p.playlist.clips.push(audioClip({ channelId: 'missing' }), audioClip({ channelId: sampler.id }));
    expect(normalizeProject(p).playlist.clips.filter((c) => c.kind === 'audio')).toHaveLength(0);
  });

  it('normalises a stored Audio Clip channel like any channel (missing sampler fields are filled in)', () => {
    const stored = { ...createAudioClipChannel('A', 's1'), sampler: { sampleId: 's1' } } as unknown as Channel;
    const c = normalizeChannel(stored);
    expect(c.kind).toBe('audioclip');
    expect(c.sampler.stretchMode).toBe('resample');
    expect(c.sampler.declick).toBe('out');
    expect(c.midiOut).toBeUndefined();
  });
});

describe('addAudioClip (the recording and drop interface)', async () => {
  const { store } = await import('../src/store');
  const A = await import('../src/store/actions');
  const kick = 'builtin:kick';

  it('creates an Audio Clip channel for a pool sample and a clip of the sample length at the start', () => {
    const before = store.project;
    const smp = before.samples[kick];
    expect(smp).toBeTruthy();
    const { channelId, clipId } = A.addAudioClip(kick, 192);
    const p = store.project;
    const ch = p.channels.find((c) => c.id === channelId)!;
    const clip = p.playlist.clips.find((c) => c.id === clipId)!;
    expect(ch.kind).toBe('audioclip');
    expect(ch.name).toBe(smp.name);
    expect(ch.sampler.sampleId).toBe(kick);
    expect(ch.mixerTrack).toBe(0);
    expect(clip).toMatchObject({ kind: 'audio', channelId, start: 192, offset: 0, muted: false, patternId: '' });
    expect(clip.length).toBe(audioClipTicks(smp, ch.sampler, p.tempo, p.ppq));
    expect(clip.length).toBeGreaterThanOrEqual((smp.frames / smp.sampleRate) * (p.tempo * p.ppq) / 60);
    // one undo step
    expect(store.historyLabels().past.at(-1)).toBe('Add audio clip');
    store.undo();
    expect(store.project.channels.some((c) => c.id === channelId)).toBe(false);
    expect(store.project.playlist.clips.some((c) => c.id === clipId)).toBe(false);
    store.redo();
    expect(store.project.playlist.clips.some((c) => c.id === clipId)).toBe(true);
  });

  it('honours track, mixer track and name; picks the first free track when the track is omitted', () => {
    const a = A.addAudioClip(kick, 0, { track: 7, mixerTrack: 5, name: 'Take 1' });
    const p = store.project;
    expect(p.playlist.clips.find((c) => c.id === a.clipId)!.track).toBe(7);
    const ch = p.channels.find((c) => c.id === a.channelId)!;
    expect(ch.name).toBe('Take 1');
    expect(ch.mixerTrack).toBe(5);
    // omitted: a track with no clip over the range
    const b = A.addAudioClip(kick, 0);
    const bt = store.project.playlist.clips.find((c) => c.id === b.clipId)!;
    const clash = store.project.playlist.clips.filter((c) => c.id !== b.clipId && c.track === bt.track && c.start < bt.start + bt.length && c.start + c.length > bt.start);
    expect(clash).toHaveLength(0);
    // out of range tracks are clamped
    const c = A.addAudioClip(kick, 0, { track: 9999 });
    expect(store.project.playlist.clips.find((k) => k.id === c.clipId)!.track).toBe(store.project.playlist.tracks.length - 1);
  });

  it('registers a pool sample the project does not know yet (a recording)', async () => {
    const { addRaw } = await import('../src/audio/samples');
    const data = new Float32Array(48000).fill(0.25);
    addRaw({ id: 'rec-1', name: 'Recording 1', channels: [data, data], sampleRate: 48000 });
    expect(store.project.samples['rec-1']).toBeUndefined();
    const { channelId, clipId } = A.addAudioClip('rec-1', 96, { name: 'Recording 1' });
    const p = store.project;
    expect(p.samples['rec-1']).toMatchObject({ frames: 48000, sampleRate: 48000, channels: 2, source: { kind: 'user' } });
    const clip = p.playlist.clips.find((c) => c.id === clipId)!;
    expect(clip.length).toBe(Math.ceil((1 * p.tempo * p.ppq) / 60 - 1e-6));
    expect(p.channels.find((c) => c.id === channelId)!.sampler.sampleId).toBe('rec-1');
  });

  it('deletes the clips of a deleted Audio Clip channel, and instances share the channel', () => {
    const { channelId, clipId } = A.addAudioClip(kick, 0, { track: 10 });
    const second = A.addAudioClipInstance(11, channelId, 384)!;
    expect(store.project.playlist.clips.filter((c) => c.channelId === channelId).map((c) => c.id).sort()).toEqual([clipId, second].sort());
    A.deleteChannels([channelId]);
    expect(store.project.playlist.clips.some((c) => c.channelId === channelId)).toBe(false);
    expect(store.project.channels.some((c) => c.id === channelId)).toBe(false);
    store.undo();
    expect(store.project.playlist.clips.filter((c) => c.channelId === channelId)).toHaveLength(2);
  });

  it('a mixer-track helper keeps the 127-track mixer shape (sanity for the test project)', () => {
    expect(createMixerTrack(3).index).toBe(3);
  });
});

// ------------------------------------------------------------------ engine
import { Engine } from '../src/engine/Engine';
import { createPlaylistTrack } from '../src/model/defaults';
import type { FromEngine } from '../src/engine/protocol';
import { flGain } from '../src/model/scales';
import { clipGainLinear as dbGain } from '../src/model/audioclip';

const SR = 48000;
// 120 BPM, PPQ 96: 250 frames a tick, 24000 frames a beat
const TICK = 250;

interface Rig {
  e: Engine;
  ch: Channel;
  clips: Clip[];
  tracks: ReturnType<typeof createPlaylistTrack>[];
  push(): void;
  render(frames: number): [Float32Array, Float32Array];
}

/** An engine with one Audio Clip channel playing `data` (mono) through clips in song mode. */
function rig(data: Float32Array | Float32Array[], clips: Partial<Clip>[], opts: { tempo?: number; channel?: (c: Channel) => void; post?: (m: FromEngine) => void; interp?: boolean } = {}): Rig {
  const e = new Engine({ sampleRate: SR, blockSize: 128, post: opts.post });
  e.handle({ t: 'globals', g: { tempo: opts.tempo ?? 120, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } });
  for (let i = 0; i < 127; i++) e.handle({ t: 'mixerTrack', tr: createMixerTrack(i) });
  if (opts.interp !== false) e.handle({ t: 'interp', mode: 'linear' });
  const chans = Array.isArray(data) ? data : [data];
  e.handle({ t: 'sample', id: 'smp', data: chans, sampleRate: SR });
  const ch = createAudioClipChannel('A', 'smp');
  opts.channel?.(ch);
  e.handle({ t: 'channel', c: ch });
  const tracks = Array.from({ length: 8 }, (_, i) => createPlaylistTrack(i));
  const list: Clip[] = clips.map((c) => audioClip({ channelId: ch.id, ...c }));
  const r: Rig = {
    e, ch, clips: list, tracks,
    push: () => e.handle({ t: 'playlist', tracks, clips: list }),
    render: (frames) => e.renderOffline(frames),
  };
  r.push();
  e.handle({ t: 'mode', song: true, patternId: '' });
  return r;
}

const impulse = (len: number, at = 0): Float32Array => { const d = new Float32Array(len); d[at] = 1; return d; };
const dc = (len: number, v = 1): Float32Array => new Float32Array(len).fill(v);
const ramp = (len: number): Float32Array => Float32Array.from({ length: len }, (_, i) => i / len);
const firstNonZero = (b: Float32Array, from = 0): number => { for (let i = from; i < b.length; i++) if (Math.abs(b[i]) > 1e-9) return i; return -1; };

describe('Audio Clips in the engine: timing', () => {
  it('starts a clip at its tick, sample accurately, at the sample\'s own level', () => {
    const r = rig(impulse(2000), [{ start: 96, length: 96 }]);
    r.e.handle({ t: 'play' });
    const [L, R] = r.render(SR);
    expect(L[24000]).toBe(1); // 96 ticks = 0.5 s = frame 24000; Audio Clips play at 0 dB, centred
    expect(R[24000]).toBe(1);
    expect(L[23999]).toBe(0);
    expect(L[24001]).toBe(0);
    expect(firstNonZero(L)).toBe(24000);
  });

  it('places clips at fractional frames of a tempo that does not divide the sample rate', () => {
    // 130 BPM: a tick is 240.4 frames of 48 kHz; the clip starts at the nearest frame
    const r = rig(impulse(500), [{ start: 100, length: 50 }], { tempo: 130 });
    r.e.handle({ t: 'play' });
    const [L] = r.render(40000);
    const at = Math.round((100 * 60 * SR) / (130 * 96));
    expect(firstNonZero(L)).toBe(at);
  });

  it('starts the sample `offset` ticks in (slip)', () => {
    const data = new Float32Array(20000);
    data[0] = 0.5; data[6000] = 1; data[6100] = 0.25;
    const r = rig(data, [{ start: 48, length: 96, offset: 24 }]); // 24 ticks = 6000 frames
    r.e.handle({ t: 'play' });
    const [L] = r.render(SR);
    expect(L[12000]).toBe(1); // clip start 48 ticks = 12000 frames, playing from sample frame 6000
    expect(L[12100]).toBeCloseTo(0.25, 6);
    expect(L[12000 - 6000]).toBe(0); // nothing of the part before the offset
  });

  it('ends a clip at its end tick: fades out the cut and is silent from there, even if the sample goes on', () => {
    const r = rig(dc(48000), [{ start: 0, length: 40 }]); // 40 ticks = 10000 frames
    r.e.handle({ t: 'play' });
    const [L] = r.render(20000);
    expect(L[0]).toBe(1);
    expect(L[8000]).toBe(1); // before the declick fade (10 ms = 480 frames)
    expect(L[9999]).toBeGreaterThan(0);
    expect(L[9999]).toBeLessThan(0.01);
    for (let i = 10000; i < 12000; i++) expect(L[i]).toBe(0);
    // the fade is monotonic
    for (let i = 9520; i < 9999; i++) expect(L[i + 1]).toBeLessThanOrEqual(L[i] + 1e-9);
  });

  it('bleeding declick modes carry the sound past the clip end while it fades out; a clip with a fade out of its own does not', () => {
    const r = rig(dc(48000), [{ start: 0, length: 40 }], { channel: (c) => { c.sampler.declick = 'generic'; } }); // 20 ms = 960 frames
    r.e.handle({ t: 'play' });
    const [L] = r.render(20000);
    expect(L[9999]).toBe(1); // no fade inside the clip
    expect(L[10000]).toBeCloseTo(1, 3);
    expect(L[10480]).toBeCloseTo(0.5, 2);
    expect(L[10959]).toBeGreaterThan(0);
    expect(L[10959]).toBeLessThan(0.001);
    expect(L[10960]).toBe(0);
    // a bleeding voice stops with the song loop and with the sample's end as the others
    const r2 = rig(dc(48000), [{ start: 0, length: 40, fadeOut: 8 }], { channel: (c) => { c.sampler.declick = 'generic'; } });
    r2.e.handle({ t: 'play' });
    const [M] = r2.render(20000);
    expect(M[9999]).toBeLessThan(0.01); // its own fade out of 8 ticks reaches 0 at the end
    expect(M[10000]).toBe(0);
  });

  it('plays a sample that is shorter than its clip once and then nothing (no loop)', () => {
    const r = rig(dc(1000), [{ start: 0, length: 96 }]);
    r.e.handle({ t: 'play' });
    const [L] = r.render(30000);
    expect(L[999]).toBe(1);
    expect(L[1000]).toBe(0);
    expect(firstNonZero(L, 1000)).toBe(-1);
  });

  it('does not fade a clip that plays its sample to the end', () => {
    const r = rig(dc(1000), [{ start: 0, length: 96 }]);
    r.e.handle({ t: 'play' });
    const [L] = r.render(2000);
    expect(L[998]).toBe(1);
    expect(L[999]).toBe(1);
  });

  it('plays several clips of one channel and adds overlapping clips', () => {
    const r = rig(impulse(100), [{ start: 0, length: 48 }, { start: 48, length: 48 }, { start: 48, length: 48, track: 1 }]);
    r.e.handle({ t: 'play' });
    const [L] = r.render(20000);
    expect(L[0]).toBe(1);
    expect(L[12000]).toBe(2);
  });

  it('follows the song: a clip does not play in pattern mode, and plays again after a stop and play', () => {
    const r = rig(impulse(100), [{ start: 0, length: 48 }]);
    r.e.handle({ t: 'mode', song: false, patternId: '' });
    r.e.handle({ t: 'play' });
    expect(Math.max(...r.render(2000)[0])).toBe(0);
    r.e.handle({ t: 'stop' });
    r.e.handle({ t: 'mode', song: true, patternId: '' });
    r.e.handle({ t: 'play' });
    expect(r.render(500)[0][0]).toBe(1);
  });

  it('starts in the middle of a clip when playback starts or is relocated inside it', () => {
    const data = ramp(48000);
    const r = rig(data, [{ start: 0, length: 192 }]);
    r.e.handle({ t: 'seek', tick: 40 }); // 10000 frames in
    r.e.handle({ t: 'play' });
    const [L] = r.render(2000);
    // the default declick mode (Out only) has no fade in: the ramp plays from sample frame 10000 at once
    expect(L[0]).toBeCloseTo(data[10000], 6);
    expect(L[500]).toBeCloseTo(data[10500], 6);
    expect(L[1999]).toBeCloseTo(data[11999], 6);
    // relocating while playing does the same
    r.e.handle({ t: 'seek', tick: 80 });
    const [M] = r.render(2000);
    expect(M[500]).toBeCloseTo(data[20500], 6);
  });

  it('fades a clip in that starts inside its sample when the declick mode has a fade in', () => {
    const data = dc(96000);
    const r = rig(data, [{ start: 0, length: 192 }], { channel: (c) => { c.sampler.declick = 'generic'; } }); // 20 ms = 960 frames
    r.e.handle({ t: 'seek', tick: 40 });
    r.e.handle({ t: 'play' });
    const [L] = r.render(2000);
    expect(L[0]).toBe(0);
    expect(L[480]).toBeCloseTo(0.5, 2);
    expect(L[960]).toBeCloseTo(1, 3);
    // a clip that starts at the start of its sample is not faded in
    const r2 = rig(data, [{ start: 0, length: 192 }], { channel: (c) => { c.sampler.declick = 'generic'; } });
    r2.e.handle({ t: 'play' });
    expect(r2.render(100)[0][0]).toBe(1);
  });

  it('keeps time through tempo changes: the clip window is in ticks', () => {
    const r = rig(dc(96000), [{ start: 0, length: 96 }]);
    r.e.handle({ t: 'play' });
    r.render(1000);
    r.e.handle({ t: 'globals', g: { tempo: 240, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } });
    const [L] = r.render(20000);
    // 4 of the 96 ticks were played at 120 BPM; the remaining 92 ticks last 92 x 125 = 11500 frames at 240 BPM
    expect(L[10000]).toBe(1);
    expect(L[11499]).toBeGreaterThan(0);
    expect(L[11499]).toBeLessThan(0.01);
    expect(L[11500]).toBe(0);
    expect(Math.max(...L.subarray(11500))).toBe(0);
  });
});

describe('Audio Clips in the engine: song loops and the transport', () => {
  it('repeats a clip every time the song loops (song length = last clip end rounded to a bar)', () => {
    const r = rig(impulse(100), [{ start: 0, length: 384 }]); // one bar = 2 s
    r.e.handle({ t: 'play' });
    const [L] = r.render(SR * 5);
    expect(L[0]).toBe(1);
    expect(L[SR * 2]).toBe(1);
    expect(L[SR * 4]).toBe(1);
    expect(L[SR * 2 - 1]).toBe(0);
  });

  it('cuts a clip at a time-selection loop end and restarts the clips under way at the loop start', () => {
    const data = ramp(96000);
    const r = rig(data, [{ start: 0, length: 384 }]);
    r.e.handle({ t: 'loop', start: 96, end: 192 }); // beats 2 .. 3: frames 24000 .. 48000
    r.e.handle({ t: 'seek', tick: 96 });
    r.e.handle({ t: 'play' });
    const [L] = r.render(60000);
    expect(L[300]).toBeCloseTo(data[24300], 5);
    // the loop wraps at frame 24000 of the render: the clip is cut with a 10 ms fade (it bleeds past the wrap) and the
    // clip under way at the loop start plays again from sample frame 24000
    expect(L[23999]).toBeCloseTo(data[47999], 5);
    expect(L[24000]).toBeCloseTo(data[24000] + data[48000] * 1, 5); // new voice + the tail of the old one starting at full level
    expect(L[24000 + 600]).toBeCloseTo(data[24600], 5);
    expect(L[24000 + 20000]).toBeCloseTo(data[44000], 5);
    // and again at the next wrap
    expect(L[48000 + 600]).toBeCloseTo(data[24600], 5);
  });

  it('fades the clips out when playback stops or pauses', () => {
    const r = rig(dc(96000), [{ start: 0, length: 384 }]);
    r.e.handle({ t: 'play' });
    r.render(5000);
    r.e.handle({ t: 'pause' });
    const [L] = r.render(2000);
    expect(L[0]).toBeGreaterThan(0.99); // the fade starts at once
    expect(L[200]).toBeLessThan(L[0]);
    expect(L[600]).toBe(0); // 10 ms later it is silent
    expect(Math.max(...L.subarray(600))).toBe(0);
  });
});

describe('Audio Clips in the engine: the channel and the clip', () => {
  it('applies the channel volume (FL volume law) and pan (a balance, 0 dB at the centre)', () => {
    const r = rig(impulse(100), [{ start: 0, length: 48 }], { channel: (c) => { c.volume = 0.5; c.pan = 0.5; } });
    r.e.handle({ t: 'play' });
    const [L, R] = r.render(1000);
    const v = flGain(0.5);
    expect(L[0]).toBeCloseTo(v * 0.5, 6);
    expect(R[0]).toBeCloseTo(v, 6);
    const r2 = rig(impulse(100), [{ start: 0, length: 48 }], { channel: (c) => { c.pan = -1; } });
    r2.e.handle({ t: 'play' });
    const [L2, R2] = r2.render(1000);
    expect(L2[0]).toBe(1);
    expect(R2[0]).toBe(0);
  });

  it('plays a stereo sample on both sides and a mono sample centred', () => {
    const r = rig([impulse(100), dc(100, 0.25)], [{ start: 0, length: 48 }]);
    r.e.handle({ t: 'play' });
    const [L, R] = r.render(1000);
    expect(L[0]).toBe(1);
    expect(R[0]).toBe(0.25);
  });

  it('applies the clip gain, per clip', () => {
    const r = rig(impulse(100), [{ start: 0, length: 48, gain: -6 }, { start: 48, length: 48, track: 1, gain: 6 }]);
    r.e.handle({ t: 'play' });
    const [L] = r.render(20000);
    expect(L[0]).toBeCloseTo(dbGain(-6), 6);
    expect(L[12000]).toBeCloseTo(dbGain(6), 6);
  });

  it('fades a clip in and out over the fade lengths with their curves', () => {
    const r = rig(dc(96000), [{ start: 0, length: 96, fadeIn: 40, fadeOut: 40, fadeOutTension: 0.5 }]);
    r.e.handle({ t: 'play' });
    const [L] = r.render(30000);
    expect(L[0]).toBe(0);
    expect(L[5000]).toBeCloseTo(0.5, 3); // halfway through the 10000-frame fade in
    expect(L[10000]).toBeCloseTo(1, 3);
    expect(L[12000]).toBe(1);
    // fade out from frame 14000 to 24000 with tension 0.5 (exponent 2^1.5)
    const k = Math.pow(2, 1.5);
    expect(L[19000]).toBeCloseTo(Math.pow(0.5, k), 3);
    expect(L[23999]).toBeLessThan(0.001);
  });

  it('routes the channel to its mixer track', () => {
    const r = rig(dc(96000), [{ start: 0, length: 96 }], { channel: (c) => { c.mixerTrack = 5; } });
    // insert 5 muted (the mixer ramps the mute over the first block that reaches the track): its channel input never reaches the master
    const t5 = createMixerTrack(5);
    t5.enabled = false;
    r.e.handle({ t: 'mixerTrack', tr: t5 });
    r.e.handle({ t: 'play' });
    expect(Math.max(...r.render(12000)[0].subarray(256))).toBe(0);
    r.e.handle({ t: 'stop' });
    r.e.handle({ t: 'mixerTrack', tr: createMixerTrack(5) });
    r.render(4800);
    r.e.handle({ t: 'play' });
    expect(r.render(12000)[0][10000]).toBe(1);
    // and an insert that does not send to the master keeps the sound away from it
    const t6 = createMixerTrack(6);
    t6.sends = {};
    const r2 = rig(dc(96000), [{ start: 0, length: 96 }], { channel: (c) => { c.mixerTrack = 6; } });
    r2.e.handle({ t: 'mixerTrack', tr: t6 });
    r2.e.handle({ t: 'play' });
    expect(Math.max(...r2.render(12000)[0])).toBe(0);
  });

  it('is silent while the channel, the clip or the playlist track is muted, and sounds again when unmuted', () => {
    const base = (): Rig => rig(impulse(100), [{ start: 0, length: 48 }]);
    const peak = (r: Rig) => { r.e.handle({ t: 'stop' }); r.e.handle({ t: 'play' }); return Math.max(...r.render(1000)[0]); };
    let r = base();
    expect(peak(r)).toBe(1);
    r.ch.enabled = false;
    r.e.handle({ t: 'channel', c: { ...r.ch } });
    expect(peak(r)).toBe(0);
    r.ch.enabled = true;
    r.e.handle({ t: 'channel', c: { ...r.ch } });
    expect(peak(r)).toBe(1);
    r = base();
    r.clips[0].muted = true;
    r.push();
    expect(peak(r)).toBe(0);
    r.clips[0].muted = false;
    r.push();
    expect(peak(r)).toBe(1);
    r = base();
    r.tracks[0].enabled = false; // playlist track mute (solo is mute of the others)
    r.push();
    expect(peak(r)).toBe(0);
    r.tracks[0].enabled = true;
    r.push();
    expect(peak(r)).toBe(1);
  });

  it('fades a sounding clip out when it is muted or deleted during playback', () => {
    const r = rig(dc(96000), [{ start: 0, length: 384 }]);
    r.e.handle({ t: 'play' });
    r.render(1000);
    r.clips[0].muted = true;
    r.push();
    const [L] = r.render(2000);
    expect(L[0]).toBeGreaterThan(0.9);
    expect(L[700]).toBe(0);
  });

  it('follows edits of a sounding clip: resizing moves its end', () => {
    const r = rig(dc(96000), [{ start: 0, length: 384 }]);
    r.e.handle({ t: 'play' });
    r.render(1000);
    r.clips[0].length = 48; // end at frame 12000
    r.push();
    const [L] = r.render(20000);
    expect(L[9000]).toBe(1);
    expect(L[10998]).toBeGreaterThan(0);
    expect(L[11000]).toBe(0); // relative to the render start: 12000 - 1000
  });
});

describe('Audio Clips in the engine: pitch, speed and time', () => {
  it('plays an octave up twice as fast (channel PITCH)', () => {
    const data = ramp(96000);
    const r = rig(data, [{ start: 0, length: 96 }], { channel: (c) => { c.sampler.pitchRange = 12; c.pitch = 1; } });
    r.e.handle({ t: 'play' });
    const [L] = r.render(2000);
    expect(L[1000]).toBeCloseTo(data[2000], 5);
    expect(L[1500]).toBeCloseTo(data[3000], 5);
  });

  it('Resample mode with TIME plays the sample over that many beats and follows the tempo', () => {
    // a 1 s ramp, TIME = 1 beat: at 120 BPM it lasts 0.5 s (twice the speed), at 60 BPM 1 s (original speed)
    const data = ramp(SR);
    const mk = (tempo: number) => rig(data, [{ start: 0, length: 96 }], { tempo, channel: (c) => { c.sampler.stretchTimeBeats = 1; } });
    const a = mk(120);
    a.e.handle({ t: 'play' });
    const [L] = a.render(3000);
    expect(L[1000]).toBeCloseTo(data[2000], 5);
    const b = mk(60);
    b.e.handle({ t: 'play' });
    const [M] = b.render(3000);
    expect(M[1000]).toBeCloseTo(data[1000], 5);
  });

  it('MUL slows the sample down in Resample mode', () => {
    const data = ramp(SR);
    const r = rig(data, [{ start: 0, length: 192 }], { channel: (c) => { c.sampler.stretchMul = 0.5 + Math.log(2) / Math.log(16); } }); // 200%
    r.e.handle({ t: 'play' });
    const [L] = r.render(3000);
    expect(L[2000]).toBeCloseTo(data[1000], 5);
  });

  it('applies the main pitch when the channel follows it', () => {
    const data = ramp(96000);
    const r = rig(data, [{ start: 0, length: 192 }]);
    r.e.handle({ t: 'globals', g: { tempo: 120, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 1, swing: 0 } }); // +1200 cents
    r.e.handle({ t: 'play' });
    const [L] = r.render(2000);
    expect(L[1000]).toBeCloseTo(data[2000], 5);
  });
});

describe('Audio Clips in the engine: the rest of the engine', () => {
  it('sounds in the offline render of the project (rendering engine) and reports the channel activity', () => {
    const seen: FromEngine[] = [];
    const r = rig(dc(96000), [{ start: 0, length: 96 }], { post: (m) => seen.push(m) });
    r.e.handle({ t: 'play' });
    r.render(SR);
    const st = seen.filter((m): m is Extract<FromEngine, { t: 'status' }> => m.t === 'status');
    expect(st.length).toBeGreaterThan(0);
    const idx = st[0].channelIds.indexOf(r.ch.id);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(st.some((m) => m.channelPeaks[idx] > 0.5)).toBe(true);
    expect(st.some((m) => m.voices > 0)).toBe(true);
  });

  it('auditions the whole sample on a live note (Channel Rack preview)', () => {
    const r = rig(dc(3000), []);
    r.e.handle({ t: 'noteOn', ch: r.ch.id, key: 60, vel: 100, tag: 1 });
    const [L] = r.render(4000);
    expect(L[0]).toBe(1);
    expect(L[2999]).toBe(1);
    expect(L[3000]).toBe(0);
  });

  it('follows channel changes while a clip plays: a new sample keeps the place in the song', () => {
    const a = ramp(96000);
    const b = ramp(96000).map((x) => x + 0.5);
    const r = rig(a, [{ start: 0, length: 384 }]);
    r.e.handle({ t: 'play' });
    r.render(6000);
    r.e.handle({ t: 'sample', id: 'smp2', data: [b], sampleRate: SR });
    r.ch.sampler.sampleId = 'smp2';
    r.e.handle({ t: 'channel', c: { ...r.ch, sampler: { ...r.ch.sampler } } });
    const [L] = r.render(1000);
    expect(L[100]).toBeCloseTo(b[6100], 5);
  });

  it('does not start clips whose Audio Clip channel is gone, and fades out the voices of a removed channel', () => {
    const r = rig(dc(96000), [{ start: 0, length: 384 }]);
    r.e.handle({ t: 'play' });
    r.render(1000);
    r.e.handle({ t: 'channelRemove', id: r.ch.id });
    const [L] = r.render(4000);
    expect(L[0]).toBeGreaterThan(0.9);
    expect(L[700]).toBe(0);
    r.e.handle({ t: 'stop' });
    r.e.handle({ t: 'play' });
    expect(Math.max(...r.render(2000)[0])).toBe(0);
  });
});

describe('Audio Clips in the engine: automatic crossfades', () => {
  const overlap = (auto: boolean, tracks: [number, number] = [0, 0]): Rig => {
    const r = rig(dc(96000), [{ start: 0, length: 96, track: tracks[0] }, { start: 48, length: 96, track: tracks[1] }]);
    r.e.handle({ t: 'playlist', tracks: r.tracks, clips: r.clips, autoCrossfades: auto });
    r.e.handle({ t: 'play' });
    return r;
  };

  it('crossfades clips of one track over their overlap: the sum stays level', () => {
    const [L] = overlap(true).render(40000);
    expect(L[11000]).toBe(1); // before the overlap (frames 12000 .. 24000)
    expect(L[12000 + 3000]).toBeCloseTo(1, 3); // 25% in: 0.75 + 0.25
    expect(L[18000]).toBeCloseTo(1, 3);
    expect(L[22000]).toBeCloseTo(1, 3);
    expect(L[30000]).toBe(1); // after: the second clip alone
  });

  it('adds overlapping clips of one track when the crossfades are off', () => {
    const [L] = overlap(false).render(40000);
    expect(L[18000]).toBe(2);
  });

  it('does not crossfade clips on different tracks, or clips that do not overlap', () => {
    const [L] = overlap(true, [0, 1]).render(40000);
    expect(L[18000]).toBe(2);
    const r = rig(dc(96000), [{ start: 0, length: 48 }, { start: 48, length: 48 }]);
    r.e.handle({ t: 'playlist', tracks: r.tracks, clips: r.clips, autoCrossfades: true });
    r.e.handle({ t: 'play' });
    const [M] = r.render(30000);
    expect(M[11000]).toBeGreaterThan(0); // the first clip is not faded by a clip that starts as it ends
    expect(M[11000]).toBeLessThan(1.01);
  });

  it('keeps a longer fade the clip has already', () => {
    const r = rig(dc(96000), [{ start: 0, length: 96, fadeOut: 90 }, { start: 72, length: 96 }]); // overlap 24 ticks, fade out 90
    r.e.handle({ t: 'playlist', tracks: r.tracks, clips: r.clips, autoCrossfades: true });
    r.e.handle({ t: 'play' });
    const [L] = r.render(40000);
    // the first clip's own fade out (90 ticks = 22500 frames, from tick 6) is longer than the overlap and decides its level at tick 40
    expect(L[10000]).toBeCloseTo(1 - (10000 - 1500) / 22500, 2);
  });
});

describe('compiled audio clips', async () => {
  const { compileAudioClips } = await import('../src/engine/AudioClips');
  const tracks = Array.from({ length: 4 }, (_, i) => createPlaylistTrack(i));

  it('leaves out muted clips, clips on muted tracks and other clip kinds, sorted by start', () => {
    const t = tracks.map((x) => ({ ...x }));
    t[2].enabled = false;
    const list = compileAudioClips([
      audioClip({ channelId: 'a', start: 200, length: 10, id: 'late' }),
      audioClip({ channelId: 'a', start: 0, length: 10, id: 'early' }),
      audioClip({ channelId: 'a', start: 50, length: 10, id: 'muted', muted: true }),
      audioClip({ channelId: 'a', start: 60, length: 10, id: 'off', track: 2 }),
      { ...audioClip({ channelId: 'a' }), kind: 'pattern', id: 'pat', patternId: 'p' },
      audioClip({ channelId: 'a', start: 70, length: 0, id: 'empty' }),
    ], t);
    expect(list.map((c) => c.id)).toEqual(['early', 'late']);
    expect(list[0]).toMatchObject({ start: 0, end: 10, channelId: 'a', fadeIn: 0, fadeOut: 0, gain: 1 });
  });
});

describe('Audio Clips in the engine: slices play seamlessly', () => {
  it('tiles the clips of a slice on whole frames without overlap, gap or dip, at a tempo that does not divide the frame rate', () => {
    // 130 BPM: a tick is 240.4 frames; the slices meet at tick 100 = frame 24038.46, 200 = 48076.9
    const r = rig(dc(96000), [
      { start: 0, length: 100, offset: 0 },
      { start: 100, length: 100, offset: 100 },
      { start: 200, length: 100, offset: 200 },
    ], { tempo: 130 });
    r.e.handle({ t: 'play' });
    const [L] = r.render(70000);
    const end = Math.round((300 * 60 * SR) / (130 * 96));
    for (let i = 0; i < end - 480; i++) if (L[i] !== 1) throw new Error(`frame ${i} is ${L[i]}, not 1 (a seam must not dip or double)`);
    expect(L[Math.round((100 * 60 * SR) / (130 * 96)) - 1]).toBe(1);
    expect(L[Math.round((100 * 60 * SR) / (130 * 96))]).toBe(1);
    // the last clip's cut is faded out as usual
    expect(L[end - 1]).toBeLessThan(0.01);
    expect(L[end]).toBe(0);
  });

  it('plays a ramp through a slice without a skipped or repeated sample at a tempo with whole frames per tick', () => {
    const data = ramp(96000);
    const r = rig(data, [{ start: 0, length: 96 }, { start: 96, length: 96, offset: 96 }]);
    r.e.handle({ t: 'play' });
    const [L] = r.render(40000);
    for (let i = 0; i < 40000; i++) if (Math.abs(L[i] - data[i]) > 1e-7 && i < 48000 - 480) throw new Error(`frame ${i}: ${L[i]} vs ${data[i]}`);
  });

  it('is not a seam when the second clip starts elsewhere in the sample, or plays another channel: the first one fades out as a cut', () => {
    const r = rig(dc(96000), [{ start: 0, length: 40 }, { start: 40, length: 40, offset: 0 }]); // same place again: a repeat, not a seam
    r.e.handle({ t: 'play' });
    const [L] = r.render(30000);
    expect(L[9999]).toBeLessThan(0.01); // the first clip's cut is faded
    expect(L[10000]).toBe(1);
  });
});
