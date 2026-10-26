// The offline stretcher behind the non-Resample stretch modes of Audio Clips (src/audio/stretch.ts) and the
// buffer an Audio Clip channel plays (src/audio/audioClipSample.ts).
import { describe, it, expect } from 'vitest';
import { detectOnsets, stretchSample } from '../src/audio/stretch';
import { prepareAudioClipSample, isAudioClipPrepared } from '../src/audio/audioClipSample';
import { addRaw } from '../src/audio/samples';
import { createAudioClipChannel } from '../src/model/defaults';
import type { StretchMode } from '../src/model/sampler';

const SR = 48000;

const sine = (freq: number, frames: number, amp = 0.8): Float32Array =>
  Float32Array.from({ length: frames }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / SR));

/** Frequency from the positive-going zero crossings of a stretch of signal. */
function freqOf(x: Float32Array, a: number, b: number): number {
  let n = 0, first = -1, last = -1;
  for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) { if (first < 0) first = i; last = i; n++; }
  return n > 1 ? ((n - 1) * SR) / (last - first) : 0;
}

const rms = (x: Float32Array, a = 0, b = x.length): number => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };

/** Noise bursts with a fast decay at the given frames (a drum loop). */
function drums(frames: number, hits: number[]): Float32Array {
  const x = new Float32Array(frames);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  for (const h of hits) for (let t = 0; t < 4000 && h + t < frames; t++) x[h + t] += rnd() * 1.6 * Math.exp(-t / 500);
  return x;
}

const MODES: StretchMode[] = ['stretch', 'e3generic', 'e3mono', 'slicestretch', 'slicemap', 'auto'];

describe('stretcher: time stretching keeps pitch and level', () => {
  for (const mode of ['stretch', 'e3generic', 'e3mono', 'slicestretch', 'auto'] as StretchMode[]) {
    it(`${mode}: a sine lasts twice as long and keeps its frequency and level`, () => {
      const [y] = stretchSample({ channels: [sine(440, SR)], sampleRate: SR, outFrames: 2 * SR, pitchCents: 0, mode });
      expect(y.length).toBe(2 * SR);
      expect(freqOf(y, 20000, 80000)).toBeGreaterThan(440 * 0.985);
      expect(freqOf(y, 20000, 80000)).toBeLessThan(440 * 1.015);
      expect(rms(y, 10000, 86000)).toBeGreaterThan(0.8 * 0.707 * 0.9);
      expect(rms(y, 10000, 86000)).toBeLessThan(0.8 * 0.707 * 1.1);
    });

    it(`${mode}: a sine lasts half as long and keeps its frequency`, () => {
      const [y] = stretchSample({ channels: [sine(220, SR)], sampleRate: SR, outFrames: SR / 2, pitchCents: 0, mode });
      expect(y.length).toBe(SR / 2);
      expect(freqOf(y, 4000, 20000)).toBeGreaterThan(220 * 0.97);
      expect(freqOf(y, 4000, 20000)).toBeLessThan(220 * 1.03);
    });
  }

  it('returns the input when there is nothing to do, and a result of exactly the requested length otherwise', () => {
    const x = [sine(300, 5000)];
    expect(stretchSample({ channels: x, sampleRate: SR, outFrames: 5000, pitchCents: 0, mode: 'e3generic' })).toBe(x);
    for (const mode of MODES) {
      for (const out of [1, 777, 4999, 5001, 20000]) {
        const y = stretchSample({ channels: x, sampleRate: SR, outFrames: out, pitchCents: 0, mode });
        expect(y[0].length, `${mode} ${out}`).toBe(out);
        expect(y[0].every(Number.isFinite), `${mode} ${out} finite`).toBe(true);
      }
    }
  });

  it('stretches both channels together and keeps silence silent', () => {
    const l = sine(440, SR), r = sine(660, SR);
    const y = stretchSample({ channels: [l, r], sampleRate: SR, outFrames: 3 * SR / 2, pitchCents: 0, mode: 'e3generic' });
    expect(y).toHaveLength(2);
    expect(freqOf(y[0], 10000, 60000)).toBeGreaterThan(430);
    expect(freqOf(y[0], 10000, 60000)).toBeLessThan(450);
    expect(freqOf(y[1], 10000, 60000)).toBeGreaterThan(650);
    expect(freqOf(y[1], 10000, 60000)).toBeLessThan(670);
    const z = stretchSample({ channels: [new Float32Array(SR)], sampleRate: SR, outFrames: 2 * SR, pitchCents: 0, mode: 'auto' });
    expect(rms(z[0])).toBe(0);
  });
});

describe('stretcher: pitch shifting keeps the duration', () => {
  it('shifts a sine by an octave up and down', () => {
    const up = stretchSample({ channels: [sine(440, SR)], sampleRate: SR, outFrames: SR, pitchCents: 1200, mode: 'e3generic' })[0];
    expect(up.length).toBe(SR);
    expect(freqOf(up, 8000, 40000)).toBeGreaterThan(880 * 0.985);
    expect(freqOf(up, 8000, 40000)).toBeLessThan(880 * 1.015);
    const down = stretchSample({ channels: [sine(440, SR)], sampleRate: SR, outFrames: SR, pitchCents: -1200, mode: 'e3mono' })[0];
    expect(down.length).toBe(SR);
    expect(freqOf(down, 8000, 40000)).toBeGreaterThan(220 * 0.985);
    expect(freqOf(down, 8000, 40000)).toBeLessThan(220 * 1.015);
  });

  it('shifts a seventh of an octave and stretches in one go', () => {
    const y = stretchSample({ channels: [sine(400, SR)], sampleRate: SR, outFrames: 2 * SR, pitchCents: 700, mode: 'e3generic' })[0];
    expect(y.length).toBe(2 * SR);
    const want = 400 * Math.pow(2, 700 / 1200);
    expect(freqOf(y, 20000, 80000)).toBeGreaterThan(want * 0.985);
    expect(freqOf(y, 20000, 80000)).toBeLessThan(want * 1.015);
  });
});

describe('stretcher: transients', () => {
  const hits = [0, 12000, 24000, 36000];
  const loop = drums(48000, hits);

  it('detects the onsets of a drum loop', () => {
    const on = detectOnsets(loop, SR, true);
    for (const h of hits.slice(1)) expect(on.some((o) => Math.abs(o - h) < 300), `onset near ${h}`).toBe(true);
    expect(on.length).toBeLessThanOrEqual(hits.length + 2);
    expect(detectOnsets(new Float32Array(SR), SR, true)).toEqual([]);
  });

  it('Slice stretch keeps each hit crisp and moves it to its stretched position', () => {
    const y = stretchSample({ channels: [loop], sampleRate: SR, outFrames: 72000, pitchCents: 0, mode: 'slicestretch' })[0];
    // the loop is 1.5x as long: the hits sit at 18000, 36000, 54000
    for (const h of [18000, 36000, 54000]) {
      let pk = 0, at = -1;
      for (let i = h - 400; i < h + 400; i++) if (Math.abs(y[i]) > pk) { pk = Math.abs(y[i]); at = i; }
      expect(pk, `peak near ${h}`).toBeGreaterThan(0.4);
      expect(Math.abs(at - h)).toBeLessThan(120);
      // quiet right before the hit: no pre-echo from a smeared grain
      expect(rms(y, h - 900, h - 300)).toBeLessThan(0.03);
    }
  });

  it('Slice map keeps the slices as they are and leaves gaps when the loop gets longer', () => {
    const y = stretchSample({ channels: [loop], sampleRate: SR, outFrames: 72000, pitchCents: 0, mode: 'slicemap' })[0];
    const on = detectOnsets(loop, SR, true);
    const a0 = on[0];
    const o0 = Math.round((a0 * 72000) / 48000);
    for (let t = 0; t < 2000; t += 97) expect(y[o0 + t]).toBeCloseTo(loop[a0 + t], 6);
    // the slice (12000 frames long) leaves the room up to the next slot silent after its tail: the tail of the burst is
    // inaudible long before, so the gap shows as silence just before the next hit
    expect(rms(y, o0 + 9000, o0 + 11000)).toBeLessThan(0.01);
  });

  it('Auto stretches loops with slices and plain material as a whole', () => {
    const a = stretchSample({ channels: [loop], sampleRate: SR, outFrames: 36000, pitchCents: 0, mode: 'auto' })[0];
    expect(a.length).toBe(36000);
    expect(Math.max(...a.subarray(8900, 9300).map(Math.abs))).toBeGreaterThan(0.4); // the second hit at 12000 x 0.75
  });
});

describe('the buffer an Audio Clip channel plays', () => {
  const smp = sine(440, SR);
  addRaw({ id: 'stretch-test', name: 'Sine', channels: [smp, smp], sampleRate: SR });

  it('is the prepared sample in Resample mode, whatever TIME and MUL say', () => {
    const c = createAudioClipChannel('A', 'stretch-test');
    c.sampler.stretchTimeBeats = 4;
    const p = prepareAudioClipSample(c, 120, SR)!;
    expect(p.data[0].length).toBe(SR);
    expect(p.sampleRate).toBe(SR);
    expect(p.key).not.toContain('|st:');
  });

  it('is rendered to TIME beats at the project tempo in the other modes, and again when the tempo changes', () => {
    const c = createAudioClipChannel('A', 'stretch-test');
    c.sampler.stretchMode = 'e3generic';
    c.sampler.stretchTimeBeats = 2;
    expect(isAudioClipPrepared(c, 120, SR)).toBe(false);
    const a = prepareAudioClipSample(c, 120, SR)!;
    expect(a.data[0].length).toBe(SR); // 2 beats at 120 BPM = 1 s
    expect(isAudioClipPrepared(c, 120, SR)).toBe(true);
    expect(isAudioClipPrepared(c, 60, SR)).toBe(false);
    const b = prepareAudioClipSample(c, 60, SR)!;
    expect(b.data[0].length).toBe(2 * SR);
    expect(b.key).not.toBe(a.key);
    expect(prepareAudioClipSample(c, 60, SR)!.data).toBe(b.data); // cached
    expect(freqOf(b.data[0], 10000, 80000)).toBeGreaterThan(430);
    expect(freqOf(b.data[0], 10000, 80000)).toBeLessThan(450);
  });

  it('applies the pitch shift and the precomputed tools before the stretch', () => {
    const c = createAudioClipChannel('A', 'stretch-test');
    c.sampler.stretchMode = 'e3generic';
    c.sampler.stretchPitch = 1200;
    c.sampler.reversePolarity = true;
    const p = prepareAudioClipSample(c, 120, SR)!;
    expect(p.data[0].length).toBe(SR); // no TIME / MUL: same duration
    expect(freqOf(p.data[0], 8000, 40000)).toBeGreaterThan(870);
    // reverse polarity: the sine starts going down
    expect(p.data[0][SR / 4 / 2 | 0]).not.toBe(0);
  });

  it('has no sample for an empty channel', () => {
    const c = createAudioClipChannel('A', null);
    expect(prepareAudioClipSample(c, 120, SR)).toBeNull();
    expect(isAudioClipPrepared(c, 120, SR)).toBe(true);
  });
});
