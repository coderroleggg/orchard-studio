// Project export with Audio Clips (src/project/io.ts exportWav): the render plays the clips where the Playlist has
// them, with the channel's stretch, volume and pan, and the project survives a save / load round trip.
import { describe, it, expect } from 'vitest';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };

let blob: Blob | null = null;
let fileName = '';
g.document = { createElement: () => { const a = { href: '', download: '', click() { fileName = a.download; } }; return a; } };
(URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => { blob = b; return 'blob:test'; };
(URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};

/** Float WAV / PCM data of an exported file: [left, right, sampleRate]. */
async function readWav(b: Blob): Promise<[Float32Array, Float32Array, number]> {
  const v = new DataView(await b.arrayBuffer());
  const fmt = v.getUint16(20, true), nch = v.getUint16(22, true), sr = v.getUint32(24, true), bits = v.getUint16(34, true);
  const size = v.getUint32(40, true), frames = size / (nch * (bits / 8));
  const L = new Float32Array(frames), R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const o = 44 + (i * nch + c) * (bits / 8);
      let x: number;
      if (fmt === 3) x = v.getFloat32(o, true);
      else if (bits === 16) x = v.getInt16(o, true) / 32768;
      else x = ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16)) << 8 >> 8) / 8388608;
      (c === 0 ? L : R)[i] = x;
    }
  }
  return [L, R, sr];
}

describe('export with audio clips', async () => {
  const { store } = await import('../src/store');
  const A = await import('../src/store/actions');
  const io = await import('../src/project/io');
  const { addRaw } = await import('../src/audio/samples');

  it('renders the audio clips of the song at their positions, as the engine plays them', async () => {
    // 1 s of a 0.5-amplitude 441 Hz sine at 44.1 kHz: 100 periods in 44100 frames
    const data = Float32Array.from({ length: 44100 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 441 * i) / 44100));
    addRaw({ id: 'exp-1', name: 'Tone', channels: [data], sampleRate: 44100 });
    A.setTempo(120);
    const { clipId, channelId } = A.addAudioClip('exp-1', 192, { track: 0 }); // 1 s into the song (192 ticks at 120 BPM)
    store.update('Song', (d) => { d.songMode = true; });
    blob = null;
    await io.exportWav();
    expect(blob).not.toBeNull();
    const [L, R, sr] = await readWav(blob!);
    expect(sr).toBe(44100);
    // 2 s long clip window ends at tick 192 + 192 = 384: one bar; the render holds the song plus a 2 s tail
    expect(L.length).toBeGreaterThanOrEqual(44100 * 2);
    // silent before the clip, the sine from frame 44100 on (the first clip start), at the original level
    let pre = 0;
    for (let i = 0; i < 44000; i++) pre = Math.max(pre, Math.abs(L[i]));
    expect(pre).toBeLessThan(1e-6);
    let pk = 0;
    for (let i = 44100; i < 88200; i++) pk = Math.max(pk, Math.abs(L[i]));
    expect(pk).toBeGreaterThan(0.45);
    expect(pk).toBeLessThan(0.52);
    // both sides alike for a centred mono sample
    for (let i = 50000; i < 50100; i++) expect(R[i]).toBeCloseTo(L[i], 6);
    // the clip is the project's: a plain deleteChannels takes it away
    A.deleteChannels([channelId]);
    expect(store.project.playlist.clips.some((c) => c.id === clipId)).toBe(false);
    expect(fileName).toMatch(/\.wav$/);
  });

  it('applies the channel volume, pan and stretch in the render', async () => {
    const data = new Float32Array(44100).fill(0.5);
    addRaw({ id: 'exp-2', name: 'DC', channels: [data, data], sampleRate: 44100 });
    A.setTempo(120);
    const { channelId } = A.addAudioClip('exp-2', 0, { track: 1 });
    store.update('Setup', (d) => {
      d.songMode = true;
      const c = d.channels.find((x) => x.id === channelId)!;
      c.pan = -1;
      c.volume = 0.5;
      c.sampler.stretchMode = 'e3generic';
      c.sampler.stretchTimeBeats = 4; // 2 s at 120 BPM: the 1 s sample lasts twice as long
      for (const k of d.playlist.clips) if (k.channelId === channelId) k.length = 384; // and the clip is as long
    });
    // only this clip plays
    store.update('Others off', (d) => { for (const k of d.playlist.clips) if (k.channelId !== channelId) k.muted = true; });
    blob = null;
    await io.exportWav();
    const [L, R, sr] = await readWav(blob!);
    const gain = (Math.pow(11, 0.5) - 1) / 10;
    expect(L[sr]).toBeCloseTo(0.5 * gain, 2); // a second in: still sounding (stretched to 2 s)
    expect(R[sr]).toBeCloseTo(0, 6);
    expect(Math.abs(L[Math.round(sr * 1.5)])).toBeGreaterThan(0.1);
    expect(Math.abs(L[Math.round(sr * 2.4)])).toBeLessThan(0.001); // the clip ends after 2 s
  });

  it('survives a save and load of the project file', async () => {
    const json = JSON.stringify(io.serialize());
    const back = await io.deserialize(JSON.parse(json));
    const kinds = back.playlist.clips.filter((c) => c.kind === 'audio');
    expect(kinds.length).toBeGreaterThan(0);
    for (const k of kinds) expect(back.channels.some((c) => c.id === k.channelId && c.kind === 'audioclip')).toBe(true);
    expect(back.playlist.autoCrossfades).toBe(true);
  });
});
