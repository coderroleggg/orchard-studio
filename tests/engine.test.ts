import { describe, it, expect } from 'vitest';
import { Engine } from '../src/engine/Engine';
import { createChannel, createMixerTrack, createNote, createPattern } from '../src/model/defaults';
import type { Channel, Pattern } from '../src/model/types';
import { velocityGain } from '../src/model/sampler';
import { channelVolumeToGain } from '../src/model/scales';

const SR = 48000;

function setup(opts: { tempo?: number; notes?: { pos: number; len: number; key?: number; vel?: number }[]; sample?: Float32Array; channel?: (c: Channel) => void } = {}) {
  const e = new Engine({ sampleRate: SR, blockSize: 128 });
  e.handle({ t: 'globals', g: { tempo: opts.tempo ?? 120, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } });
  for (let i = 0; i < 127; i++) e.handle({ t: 'mixerTrack', tr: createMixerTrack(i) });
  const smp = opts.sample ?? (() => { const s = new Float32Array(2000); s[0] = 1; return s; })();
  e.handle({ t: 'sample', id: 'imp', data: [smp], sampleRate: SR });
  const ch = createChannel('Test', 'imp');
  ch.volume = 1;
  opts.channel?.(ch);
  e.handle({ t: 'channel', c: ch });
  const pat: Pattern = createPattern(1);
  pat.notes[ch.id] = (opts.notes ?? [{ pos: 0, len: 24 }, { pos: 96, len: 24 }]).map((n) => createNote(n));
  e.handle({ t: 'pattern', p: pat });
  e.handle({ t: 'mode', song: false, patternId: pat.id });
  return { e, ch, pat };
}

describe('engine sequencing', () => {
  it('triggers steps at sample-accurate positions', () => {
    const { e } = setup();
    e.handle({ t: 'play' });
    const [L] = e.renderOffline(SR * 2);
    const g = velocityGain(100) * channelVolumeToGain(1) * Math.SQRT1_2; // circular pan law: -3 dB at centre
    expect(L[0]).toBeCloseTo(g, 5);
    // beat 2 at 120 BPM = 0.5 s
    expect(L[SR / 2]).toBeCloseTo(g, 5);
    expect(L[SR / 2 - 1]).toBeCloseTo(0, 6);
    expect(L[SR / 2 + 1]).toBeCloseTo(0, 6);
  });

  it('loops the pattern at its length (1 bar)', () => {
    const { e } = setup();
    e.handle({ t: 'play' });
    const [L] = e.renderOffline(SR * 2 + 10);
    // bar 2 starts at 2.0 s
    expect(Math.abs(L[SR * 2])).toBeGreaterThan(0.1);
  });

  it('plays the first step on every loop when the loop end falls between two samples', () => {
    // 130 BPM: one bar = 88615.38 frames at 48 kHz
    const { e } = setup({ tempo: 130, notes: [{ pos: 0, len: 0 }, { pos: 96, len: 0 }] });
    e.handle({ t: 'play' });
    const bar = (384 * 60 * SR) / (130 * 96);
    const [L] = e.renderOffline(Math.ceil(bar * 3) + 10);
    for (let k = 0; k < 3; k++) {
      const at = Math.round(k * bar);
      let pk = 0;
      for (let i = at - 2; i <= at + 2; i++) pk = Math.max(pk, Math.abs(L[Math.max(0, i)]));
      expect(pk, `bar ${k + 1}`).toBeGreaterThan(0.1);
    }
  });

  it('pattern length grows to whole bars with notes', () => {
    const { e } = setup({ notes: [{ pos: 0, len: 24 }, { pos: 384 + 96, len: 24 }] });
    expect(e.currentPatternLength()).toBe(768);
  });

  it('pitches the sample by key relative to the root note', () => {
    // sine at 1 kHz for 0.1 s; play an octave up -> 2 kHz
    const len = SR / 10;
    const s = new Float32Array(len);
    for (let i = 0; i < len; i++) s[i] = Math.sin((2 * Math.PI * 1000 * i) / SR);
    const { e } = setup({ sample: s, notes: [{ pos: 0, len: 96, key: 72 }] });
    e.handle({ t: 'play' });
    const [L] = e.renderOffline(len);
    // count zero crossings in the first 0.04 s (sample is 0.05 s long at double speed)
    let zc = 0;
    const n = Math.floor(SR * 0.04);
    for (let i = 1; i < n; i++) if ((L[i - 1] < 0) !== (L[i] < 0)) zc++;
    const freq = zc / 2 / 0.04;
    expect(freq).toBeGreaterThan(1950);
    expect(freq).toBeLessThan(2050);
  });

  it('stops and returns to the start', () => {
    const { e } = setup();
    e.handle({ t: 'play' });
    e.renderOffline(5000);
    e.handle({ t: 'stop' });
    expect(e.pos).toBe(0);
    expect(e.playing).toBe(false);
  });
});
