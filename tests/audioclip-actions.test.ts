// The edit actions of audio clips (src/store/audioClipActions.ts) and the Playlist's drawing helpers
// (src/ui/playlist/audioClip.ts).
import { describe, it, expect } from 'vitest';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };

describe('audio clip edit actions', async () => {
  const { store } = await import('../src/store');
  const A = await import('../src/store/actions');
  const AC = await import('../src/store/audioClipActions');
  const { addRaw } = await import('../src/audio/samples');
  const clipOf = (id: string) => store.project.playlist.clips.find((c) => c.id === id)!;
  const chanOf = (id: string) => store.project.channels.find((c) => c.id === id)!;
  let n = 0;
  /** A fresh audio clip: a 4-beat sample (2 s at 120 BPM) so lengths are round. */
  const fresh = (opts: { track?: number } = {}) => {
    const id = `ac-test-${n++}`;
    const data = Float32Array.from({ length: 96000 }, (_, i) => Math.sin(i * 0.05) * 0.5);
    addRaw({ id, name: `Loop ${n}`, channels: [data, data], sampleRate: 48000 });
    A.setTempo(120);
    return A.addAudioClip(id, 0, { track: opts.track ?? 20 + n });
  };

  it('sets fades and gain within their ranges, merges a drag into one undo step, and resets them', () => {
    const { clipId } = fresh();
    expect(clipOf(clipId).length).toBe(384); // 2 s at 120 BPM
    AC.setAudioClipFields([clipId], 'Clip fade', { fadeIn: 96, fadeOut: 9999, gain: 99, fadeInTension: 5 });
    const c = clipOf(clipId);
    expect(c).toMatchObject({ fadeIn: 96, fadeOut: 384, gain: 12, fadeInTension: 1 });
    AC.setAudioClipFields([clipId], 'Clip gain', { gain: -3 }, 'g');
    AC.setAudioClipFields([clipId], 'Clip gain', { gain: -4 }, 'g');
    expect(store.historyLabels().past.filter((l) => l === 'Clip gain')).toHaveLength(1);
    expect(clipOf(clipId).gain).toBe(-4);
    AC.setAudioClipFields([clipId], 'Reset gain', { gain: 0 });
    expect('gain' in clipOf(clipId)).toBe(false);
    AC.resetFades([clipId]);
    expect(clipOf(clipId)).not.toHaveProperty('fadeIn');
    expect(clipOf(clipId)).not.toHaveProperty('fadeOut');
    // pattern clips are not touched
    const pid = A.addClip(3, store.project.patterns[0].id, 0);
    AC.setAudioClipFields([pid], 'Clip gain', { gain: -3 });
    expect(clipOf(pid)).not.toHaveProperty('gain');
  });

  it('slices a clip into two windows over the same sample, keeping the fade in on the first and the fade out on the second', () => {
    const { clipId, channelId } = fresh();
    AC.setAudioClipFields([clipId], 'Fades', { fadeIn: 48, fadeOut: 48, fadeOutTension: 0.5 });
    const second = AC.sliceAudioClip(clipId, 100)!;
    const a = clipOf(clipId), b = clipOf(second);
    expect(a).toMatchObject({ start: 0, length: 100, offset: 0, fadeIn: 48, channelId });
    expect(a).not.toHaveProperty('fadeOut');
    expect(b).toMatchObject({ start: 100, length: 284, offset: 100, fadeOut: 48, fadeOutTension: 0.5, channelId });
    expect(b).not.toHaveProperty('fadeIn');
    expect(AC.sliceAudioClip(clipId, 0)).toBeNull(); // not inside
    expect(AC.sliceAudioClip(clipId, 100)).toBeNull();
    store.undo();
    expect(store.project.playlist.clips.some((c) => c.id === second)).toBe(false);
    expect(clipOf(clipId).length).toBe(384);
  });

  it('chops clips at every beat, bar and step that falls inside them', () => {
    const { clipId } = fresh();
    AC.chopClips([clipId], 96); // beats: cuts at 96, 192, 288
    const parts = store.project.playlist.clips.filter((c) => c.channelId === store.project.playlist.clips.find((x) => x.id === clipId)!.channelId).sort((x, y) => x.start - y.start);
    expect(parts.map((c) => [c.start, c.length, c.offset])).toEqual([[0, 96, 0], [96, 96, 96], [192, 96, 192], [288, 96, 288]]);
    const lone = fresh();
    AC.chopClips([lone.clipId], 384); // a bar: nothing inside
    expect(store.project.playlist.clips.filter((c) => c.channelId === lone.channelId)).toHaveLength(1);
    AC.chopClips([lone.clipId], 0);
    expect(store.project.playlist.clips.filter((c) => c.channelId === lone.channelId)).toHaveLength(1);
  });

  it('makes a clip unique (a copy of its channel) and points clips at another source channel', () => {
    const a = fresh(), b = fresh();
    store.update('Set pan', (d) => { const c = d.channels.find((x) => x.id === a.channelId); if (c) c.pan = 0.3; });
    const copy = AC.makeAudioClipUnique(a.clipId)!;
    expect(copy).not.toBe(a.channelId);
    expect(clipOf(a.clipId).channelId).toBe(copy);
    expect(chanOf(copy)).toMatchObject({ kind: 'audioclip', pan: 0.3 });
    expect(chanOf(copy).sampler.sampleId).toBe(chanOf(a.channelId).sampler.sampleId);
    expect(chanOf(copy).name).toMatch(/ #2$/);
    AC.setAudioClipSource([a.clipId], b.channelId);
    expect(clipOf(a.clipId).channelId).toBe(b.channelId);
    // a Sampler channel is not a source
    AC.setAudioClipSource([a.clipId], store.project.channels[0].id);
    expect(clipOf(a.clipId).channelId).toBe(b.channelId);
  });

  it('reverses and pitches the channels of the selected clips, as the SMP tab does', () => {
    const { clipId, channelId } = fresh();
    AC.reverseAudioClips([clipId]);
    expect(chanOf(channelId).sampler.reverse).toBe(true);
    AC.reverseAudioClips([clipId]);
    expect(chanOf(channelId).sampler.reverse).toBe(false);
    AC.pitchAudioClips([clipId], 100);
    expect(chanOf(channelId).sampler.stretchPitch).toBe(100);
    expect(chanOf(channelId).sampler.stretchMode).toBe('auto'); // FL: PITCH in Resample mode switches to Auto
    AC.pitchAudioClips([clipId], -300);
    expect(chanOf(channelId).sampler.stretchPitch).toBe(-200);
    AC.pitchAudioClips([clipId], -5000);
    expect(chanOf(channelId).sampler.stretchPitch).toBe(-1200);
  });

  it('fits a clip to the tempo and detects the loop length in beats', () => {
    expect(AC.detectedBeats(2, 120)).toBe(4);
    expect(AC.detectedBeats(1.9, 120)).toBe(4);
    expect(AC.detectedBeats(3.4, 120)).toBe(8);
    expect(AC.detectedBeats(0.4, 100)).toBe(0.5); // 0.67 beats: nearest power of two
    expect(AC.detectedBeats(0.5, 120)).toBe(1);
    const { clipId, channelId } = fresh();
    A.setTempo(100); // the 2 s sample is 3.33 beats: nearest power of two is 4
    AC.fitClipToTempo(clipId);
    expect(chanOf(channelId).sampler.stretchTimeBeats).toBe(4);
    expect(chanOf(channelId).sampler.stretchMode).toBe('stretch');
    expect(clipOf(clipId)).toMatchObject({ offset: 0, length: 384 });
    A.setTempo(120);
  });

  it('re-times a channel by a duration in beats (stretch on resize), with MUL taken into account', () => {
    const { channelId } = fresh();
    AC.setStretchDuration(channelId, 8);
    expect(chanOf(channelId).sampler.stretchTimeBeats).toBe(8);
    expect(AC.channelDurationBeats(store.project, chanOf(channelId))).toBeCloseTo(8, 6);
    AC.setStretchDuration(channelId, 0);
    AC.setStretchDuration(channelId, NaN);
    expect(chanOf(channelId).sampler.stretchTimeBeats).toBe(8);
  });

  it('sends a sample to the playlist as an audio clip at the time selection or the playhead, as one undo step', () => {
    const before = store.project.playlist.clips.length;
    const info = { id: 'sent-1', name: 'Rendered', frames: 48000, sampleRate: 48000, channels: 1, source: { kind: 'user' as const, key: 'sent-1' } };
    addRaw({ id: 'sent-1', name: 'Rendered', channels: [new Float32Array(48000)], sampleRate: 48000 });
    A.setUi((u) => { u.playlist.timeSel = { start: 768, end: 1152 }; });
    const r = AC.sendToPlaylist(info);
    A.setUi((u) => { u.playlist.timeSel = null; });
    expect(store.project.playlist.clips).toHaveLength(before + 1);
    expect(clipOf(r.clipId).start).toBe(768);
    expect(store.project.samples['sent-1']).toBeTruthy();
    expect(store.project.channels.find((c) => c.id === r.channelId)).toMatchObject({ kind: 'audioclip', name: 'Rendered' });
    expect(store.ui.playlist.selected).toEqual([r.clipId]);
    expect(store.historyLabels().past.at(-1)).toBe('Send to playlist as audio clip');
    store.undo();
    expect(store.project.playlist.clips).toHaveLength(before);
    expect(store.project.samples['sent-1']).toBeUndefined();
  });

  it('renders a clip as it sounds into a sample of its own', () => {
    const { clipId, channelId } = fresh();
    store.update('Set up', (d) => {
      const c = d.channels.find((x) => x.id === channelId)!;
      c.sampler.reverse = true;
      c.sampler.stretchTimeBeats = 2; // Resample: half the duration, twice the speed
      c.volume = 0.6;
    });
    const copy = AC.makeUniqueAsSample(clipId)!;
    const ch = chanOf(copy);
    expect(clipOf(clipId).channelId).toBe(copy);
    expect(ch.volume).toBe(0.6);
    expect(ch.sampler.reverse).toBe(false); // baked in
    expect(ch.sampler.stretchTimeBeats).toBe(0);
    const info = store.project.samples[ch.sampler.sampleId!];
    expect(info.frames).toBeGreaterThan(47000);
    expect(info.frames).toBeLessThan(49000); // 2 beats at 120 BPM = 1 s
    expect(info.name).toMatch(/\(unique\)$/);
  });

  it('lets the clips that show the whole sample follow a change of its length, and leaves trimmed or resized clips alone', () => {
    const a = fresh(); // 384 ticks (2 s) at 120 BPM
    const trimmed = A.addAudioClipInstance(30, a.channelId, 0)!;
    store.update('Trim', (d) => { const k = d.playlist.clips.find((x) => x.id === trimmed)!; k.offset = 48; k.length = 200; });
    const resized = A.addAudioClipInstance(31, a.channelId, 0)!;
    store.update('Resize', (d) => { d.playlist.clips.find((x) => x.id === resized)!.length = 100; });
    A.setSampler(a.channelId, 'Stretch time', (s) => { s.stretchTimeBeats = 8; }); // 4 s
    expect(clipOf(a.clipId).length).toBe(768);
    expect(clipOf(trimmed).length).toBe(200);
    expect(clipOf(resized).length).toBe(100);
    A.setSampler(a.channelId, 'Time multiplier', (s) => { s.stretchMul = 0.5 + Math.log(0.5) / Math.log(16); }); // 50%: 2 s again
    expect(clipOf(a.clipId).length).toBe(384);
    // the header PITCH re-times a Resample channel: +12 st at a range of 12 plays twice as fast
    A.setSampler(a.channelId, 'Stretch time', (s) => { s.stretchTimeBeats = 0; s.stretchMul = 0.5; s.pitchRange = 12; });
    expect(clipOf(a.clipId).length).toBe(384);
    A.setChannel(a.channelId, 'pitch', 1, 'Channel pitch');
    expect(clipOf(a.clipId).length).toBe(192);
    // one undo step brings the length back with the setting
    store.undo();
    expect(clipOf(a.clipId).length).toBe(384);
    // fades stay inside the clip
    AC.setAudioClipFields([a.clipId], 'Fade', { fadeOut: 300 });
    A.setChannel(a.channelId, 'pitch', 1, 'Channel pitch');
    expect(clipOf(a.clipId).fadeOut).toBe(192);
  });

  it('finds and deletes the Audio Clip channels no clip plays', () => {
    const used = fresh();
    const lone = fresh();
    A.deleteClips([lone.clipId]);
    expect(AC.unusedAudioClipChannels()).toContain(lone.channelId);
    expect(AC.unusedAudioClipChannels()).not.toContain(used.channelId);
    const n = AC.deleteUnusedAudioClips();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(store.project.channels.some((c) => c.id === lone.channelId)).toBe(false);
    expect(store.project.channels.some((c) => c.id === used.channelId)).toBe(true);
    expect(AC.deleteUnusedAudioClips()).toBe(0);
  });

  it('switches Audio Clip channels to a stretch mode', () => {
    const a = fresh(), b = fresh();
    AC.setStretchMode([a.channelId], 'e3mono');
    expect(chanOf(a.channelId).sampler.stretchMode).toBe('e3mono');
    expect(chanOf(b.channelId).sampler.stretchMode).toBe('resample');
    AC.setStretchMode('all', 'slicemap');
    expect(chanOf(b.channelId).sampler.stretchMode).toBe('slicemap');
    expect(store.project.channels.filter((c) => c.kind === 'sampler').every((c) => c.sampler.stretchMode === 'resample')).toBe(true);
  });
});

describe('Playlist drawing helpers for audio clips', async () => {
  const { minMax, sourceMap, zoneAt, handlesOf, mapTicks, effectiveFades, HANDLES_MIN_W } = await import('../src/ui/playlist/audioClip');
  const { createAudioClipChannel, createPlaylistTrack } = await import('../src/model/defaults');
  const { addRaw } = await import('../src/audio/samples');

  it('finds the extremes of any range of a sample through the peak pyramid', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
    const data = Float32Array.from({ length: 200000 }, () => rnd());
    const mm: [number, number] = [0, 0];
    for (let k = 0; k < 120; k++) {
      const a = Math.floor(Math.abs(rnd()) * 190000 * 2), len = 1 + Math.floor(Math.abs(rnd()) * 30000 * (k % 3 === 0 ? 1 : k % 3 === 1 ? 0.01 : 0.0003) * 2);
      const b = Math.min(data.length, a + len);
      let lo = Infinity, hi = -Infinity;
      for (let i = a; i < b; i++) { if (data[i] < lo) lo = data[i]; if (data[i] > hi) hi = data[i]; }
      minMax(data, a, b, mm);
      expect(mm[0], `min ${a}..${b}`).toBe(lo);
      expect(mm[1], `max ${a}..${b}`).toBe(hi);
    }
    minMax(data, 10, 10, mm);
    expect(mm).toEqual([0, 0]);
    minMax(data, -50, 3, mm); // clamped to the sample
    expect(mm[0]).toBe(Math.min(data[0], data[1], data[2]));
  });

  it('maps the clip window to the sample: trim, speed and reverse', () => {
    addRaw({ id: 'map-1', name: 'M', channels: [new Float32Array(48000).fill(0.25)], sampleRate: 48000 });
    const ch = createAudioClipChannel('M', 'map-1');
    let m = sourceMap(ch, 120)!;
    expect(m).toMatchObject({ startFrame: 0, frames: 48000, fps: 48000, reverse: false });
    expect(mapTicks(m, 120, 96)).toBeCloseTo(192, 6);
    ch.sampler.smpStart = 0.25;
    ch.sampler.length = 0.75;
    m = sourceMap(ch, 120)!;
    expect(m).toMatchObject({ startFrame: 12000, frames: 24000 });
    ch.sampler.reverse = true;
    ch.sampler.stretchTimeBeats = 4; // 24000 frames (0.5 s) over 2 s: a quarter of the speed
    m = sourceMap(ch, 120)!;
    expect(m.reverse).toBe(true);
    expect(m.fps).toBeCloseTo(12000, 6);
    // a stretch mode keeps the pitch, the window follows its duration
    ch.sampler.stretchMode = 'e3generic';
    expect(sourceMap(ch, 120)!.fps).toBeCloseTo(12000, 6);
    expect(sourceMap(createAudioClipChannel('none', null), 120)).toBeNull();
  });

  it('measures the sample as the precomputed tools keep it: trailing silence is trimmed', () => {
    const d = new Float32Array(48000);
    d.fill(0.5, 0, 24000); // the second half is digital silence
    addRaw({ id: 'map-2', name: 'T', channels: [d], sampleRate: 48000 });
    const ch = createAudioClipChannel('T', 'map-2');
    expect(sourceMap(ch, 120)!.frames).toBe(24000);
    // TIME measures the kept part: 24000 frames over 2 beats at 120 BPM (1 s) play at half the speed
    ch.sampler.stretchTimeBeats = 2;
    expect(sourceMap(ch, 120)!.fps).toBeCloseTo(24000, 6);
    // the TRIM threshold trims quiet tails too
    const q = new Float32Array(48000);
    q.fill(0.5, 0, 20000);
    q.fill(0.0005, 20000, 48000); // -66 dB
    addRaw({ id: 'map-3', name: 'Q', channels: [q], sampleRate: 48000 });
    const c2 = createAudioClipChannel('Q', 'map-3');
    expect(sourceMap(c2, 120)!.frames).toBe(48000);
    c2.sampler.trim = 0.5; // -60 dB threshold
    expect(sourceMap(c2, 120)!.frames).toBe(20000);
  });

  it('puts the fade and gain handles at the corners and the middle, and finds them', () => {
    const c = { id: 'k', track: 0, kind: 'audio' as const, patternId: '', channelId: 'x', start: 0, length: 100, offset: 0, muted: false, fadeIn: 20, fadeOut: 10 };
    const hd = handlesOf(c, 100, 50, 200, 80, 2); // 200 px wide, 2 px a tick
    expect(hd.fadeIn.x).toBe(100 + 40);
    expect(hd.fadeOut.x).toBe(100 + 200 - 20);
    expect(hd.gain.x).toBe(200);
    expect(hd.gain.y).toBe(hd.fadeIn.y);
    expect(zoneAt(c, 100, 50, 200, 80, 2, hd.fadeIn.x + 1, hd.fadeIn.y - 1)).toBe('fadeIn');
    expect(zoneAt(c, 100, 50, 200, 80, 2, hd.fadeOut.x, hd.fadeOut.y)).toBe('fadeOut');
    expect(zoneAt(c, 100, 50, 200, 80, 2, hd.gain.x, hd.gain.y + 2)).toBe('gain');
    expect(zoneAt(c, 100, 50, 200, 80, 2, 150, 120)).toBeNull();
    // too narrow to show handles
    expect(zoneAt(c, 100, 50, HANDLES_MIN_W - 1, 80, 2, 100, hd.gain.y)).toBeNull();
    // a clip without fades has its handles at the corners
    const plain = { ...c, fadeIn: undefined, fadeOut: undefined };
    expect(handlesOf(plain, 0, 0, 200, 80, 2).fadeIn.x).toBeLessThan(10);
    expect(handlesOf(plain, 0, 0, 200, 80, 2).fadeOut.x).toBeGreaterThan(190);
  });

  it('computes the fades audio clips play with, crossfades included', () => {
    const tracks = Array.from({ length: 3 }, (_, i) => createPlaylistTrack(i));
    const mk = (id: string, start: number, length: number, track = 0, extra = {}) => ({ id, track, kind: 'audio' as const, patternId: '', channelId: 'x', start, length, offset: 0, muted: false, ...extra });
    const f = effectiveFades([mk('a', 0, 100), mk('b', 60, 100), mk('c', 70, 100, 1), mk('d', 300, 50, 0, { muted: true })], tracks);
    expect(f.get('a')).toMatchObject({ fadeIn: 0, fadeOut: 40 });
    expect(f.get('b')).toMatchObject({ fadeIn: 40, fadeOut: 0 });
    expect(f.get('c')).toMatchObject({ fadeIn: 0, fadeOut: 0 });
    expect(f.has('d')).toBe(false);
  });
});
