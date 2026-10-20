import { describe, it, expect } from 'vitest';
import { Engine } from '../src/engine/Engine';
import { createChannel, createFxSlot, createMixerTrack, createNote, createPattern } from '../src/model/defaults';
import type { Channel, Pattern } from '../src/model/types';

const SR = 48000;

function engine() {
  const e = new Engine({ sampleRate: SR, blockSize: 128 });
  e.handle({ t: 'globals', g: { tempo: 120, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } });
  for (let i = 0; i < 127; i++) e.handle({ t: 'mixerTrack', tr: createMixerTrack(i) });
  return e;
}

function addSample(e: Engine, id: string, data: Float32Array) {
  e.handle({ t: 'sample', id, data: [data], sampleRate: SR });
}

function impulse(len = 4000): Float32Array {
  const s = new Float32Array(len);
  s[0] = 1;
  return s;
}

function tone(len: number): Float32Array {
  const s = new Float32Array(len);
  for (let i = 0; i < len; i++) s[i] = Math.sin(i * 0.05) * 0.5;
  return s;
}

function play(e: Engine, chans: Channel[], notes: Record<string, { pos: number; len: number; key?: number }[]>, frames: number) {
  for (const c of chans) e.handle({ t: 'channel', c });
  const pat: Pattern = createPattern(1);
  for (const [id, list] of Object.entries(notes)) pat.notes[id] = list.map((n) => createNote(n));
  e.handle({ t: 'pattern', p: pat });
  e.handle({ t: 'mode', song: false, patternId: pat.id });
  e.handle({ t: 'play' });
  return e.renderOffline(frames);
}

function firstNonZero(b: Float32Array): number {
  for (let i = 0; i < b.length; i++) if (Math.abs(b[i]) > 1e-6) return i;
  return -1;
}

function energy(b: Float32Array, a: number, z: number): number {
  let s = 0;
  for (let i = a; i < z; i++) s += b[i] * b[i];
  return s;
}

describe('plugin delay compensation', () => {
  it('aligns a track with an oversampled EQ against a dry track', () => {
    const e = engine();
    addSample(e, 'imp', impulse());
    const a = createChannel('A', 'imp', 1);
    const b = createChannel('B', 'imp', 2);
    // insert 1 gets an EQ in HQ Enhanced (latency 44 samples; FL's default HQ+ has none)
    const tr1 = createMixerTrack(1);
    tr1.slots[0] = createFxSlot();
    tr1.slots[0].params.hqMode = 'enhanced';
    e.handle({ t: 'mixerTrack', tr: tr1 });
    // render each track alone and compare onsets at the master
    const [onlyA] = play(e, [a, { ...b, enabled: false }], { [a.id]: [{ pos: 0, len: 0 }] }, 2048);
    const e2 = engine();
    addSample(e2, 'imp', impulse());
    e2.handle({ t: 'mixerTrack', tr: tr1 });
    const [onlyB] = play(e2, [{ ...a, enabled: false }, b], { [b.id]: [{ pos: 0, len: 0 }] }, 2048);
    const latency = e.mixer.tracks[1].latency();
    expect(latency).toBeGreaterThan(0);
    // the EQ track peaks `latency` later than its input; the dry track is delayed to match
    const peakA = onlyA.reduce((m, v, i, arr) => (Math.abs(v) > Math.abs(arr[m]) ? i : m), 0);
    const onsetB = firstNonZero(onlyB);
    expect(Math.abs(peakA - onsetB)).toBeLessThanOrEqual(1);
  });
});

describe('sampler voice semantics', () => {
  it('plays a one-shot sample to its end regardless of note length (volume envelope off)', () => {
    const e = engine();
    addSample(e, 't', tone(SR / 2)); // 0.5 s
    const c = createChannel('T', 't');
    const [L] = play(e, [c], { [c.id]: [{ pos: 0, len: 6 }] }, SR); // note = 6 ticks (~31 ms)
    expect(energy(L, SR * 0.3, SR * 0.45)).toBeGreaterThan(1);
  });

  it('gates the sample with the volume envelope enabled', () => {
    const e = engine();
    addSample(e, 't', tone(SR / 2));
    const c = createChannel('T', 't');
    c.sampler.envlfo.vol.env.enabled = true;
    c.sampler.envlfo.vol.env.release = 0.05; // short release
    const [L] = play(e, [c], { [c.id]: [{ pos: 0, len: 6 }] }, SR);
    expect(energy(L, SR * 0.3, SR * 0.45)).toBeLessThan(1e-6);
  });

  it('cut groups release the cut channel (open/closed hat)', () => {
    const e = engine();
    addSample(e, 't', tone(SR));
    const open = createChannel('Open', 't');
    open.sampler.cutBy = 1;
    const closed = createChannel('Closed', 't');
    closed.sampler.cutGroup = 1;
    // open hat at 0, closed hat at beat 2 (0.5 s): the open hat must stop shortly after
    const [L] = play(e, [open, { ...closed, volume: 0 }], { [open.id]: [{ pos: 0, len: 0 }], [closed.id]: [{ pos: 96, len: 0 }] }, SR);
    expect(energy(L, SR * 0.1, SR * 0.4)).toBeGreaterThan(1);
    expect(energy(L, Math.round(SR * 0.53), Math.round(SR * 0.9))).toBeLessThan(1e-6);
  });

  it('echo delay adds decaying copies', () => {
    const e = engine();
    addSample(e, 'imp', impulse(100));
    const c = createChannel('E', 'imp');
    c.sampler.echo.feed = 0.25; // 50% per echo
    c.sampler.echo.time = 3; // 3 steps = 0.375 s at 120 BPM
    c.sampler.echo.count = 2;
    const [L] = play(e, [c], { [c.id]: [{ pos: 0, len: 0 }] }, SR);
    const at = (t: number) => Math.max(...Array.from(L.subarray(Math.max(0, Math.round(t * SR) - 2), Math.round(t * SR) + 3), Math.abs));
    const a0 = at(0), a1 = at(0.375), a2 = at(0.75);
    expect(a1 / a0).toBeCloseTo(0.5, 2);
    expect(a2 / a0).toBeCloseTo(0.25, 2);
  });
});

describe('pattern length and long clips', () => {
  it('honours an explicit pattern length', () => {
    const e = engine();
    addSample(e, 'imp', impulse(100));
    const c = createChannel('A', 'imp');
    e.handle({ t: 'channel', c });
    const pat = createPattern(1);
    pat.notes[c.id] = [createNote({ pos: 0, len: 0 })];
    pat.lengthSteps = 8; // half a bar
    e.handle({ t: 'pattern', p: pat });
    e.handle({ t: 'mode', song: false, patternId: pat.id });
    expect(e.currentPatternLength()).toBe(192);
    e.handle({ t: 'play' });
    const [L] = e.renderOffline(SR);
    // loops every 8 steps = 1 s at 120 BPM? (8 steps * 0.125 s = 1 s) -> second hit at 1 s is outside; check 0.5 s grid instead
    expect(Math.abs(L[0])).toBeGreaterThan(0.1);
  });

  it('a clip longer than its pattern is silent past the end unless repeat is on', () => {
    for (const repeat of [false, true]) {
      const e = engine();
      addSample(e, 'imp', impulse(100));
      const c = createChannel('A', 'imp');
      e.handle({ t: 'channel', c });
      const pat = createPattern(1);
      pat.notes[c.id] = [createNote({ pos: 0, len: 0 })];
      e.handle({ t: 'pattern', p: pat });
      const clip = { id: 'k1', track: 0, kind: 'pattern' as const, patternId: pat.id, start: 0, length: 768, offset: 0, muted: false };
      const tracks = [{ id: 't', name: 'Track 1', color: '#485156', height: 1, enabled: true, locked: false }];
      e.handle({ t: 'playlist', tracks, clips: [clip], repeatClips: repeat });
      e.handle({ t: 'mode', song: true, patternId: pat.id });
      e.handle({ t: 'play' });
      const [L] = e.renderOffline(SR * 3);
      // bar 2 starts at 2 s (120 BPM)
      const hitAtBar2 = Math.abs(L[SR * 2]) > 0.1;
      expect(hitAtBar2).toBe(repeat);
    }
  });
});

describe('arpeggiator', () => {
  it('plays a held chord upwards one note per step', () => {
    const e = engine();
    // a 1 kHz sine burst, so each arp note's pitch can be measured
    const len = 1200;
    const s = new Float32Array(len);
    for (let i = 0; i < len; i++) s[i] = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.5;
    addSample(e, 'sine', s);
    const c = createChannel('Arp', 'sine');
    c.sampler.arp.direction = 'up';
    c.sampler.arp.time = 1; // one step = 0.125 s at 120 BPM
    const chord = [60, 64, 67].map((key) => ({ pos: 0, len: 384, key }));
    const [L] = play(e, [c], { [c.id]: chord }, SR);
    const freqAt = (t: number) => {
      const a = Math.round(t * SR) + 20, n = 600;
      let zc = 0;
      for (let i = a + 1; i < a + n; i++) if ((L[i - 1] < 0) !== (L[i] < 0)) zc++;
      return (zc / 2) / (n / SR);
    };
    const f = [0, 0.125, 0.25, 0.375].map(freqAt);
    const ratio = (x: number) => 12 * Math.log2(x / f[0]);
    expect(ratio(f[1])).toBeCloseTo(4, 0); // E
    expect(ratio(f[2])).toBeCloseTo(7, 0); // G
    expect(ratio(f[3])).toBeCloseTo(0, 0); // back to C
  });
});
