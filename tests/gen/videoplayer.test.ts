// Video Player (FL: Fruity Video Player): registration (FL's parameter list,
// flags, form size, factory preset), the state helpers (time displays, play
// range mapping), and the engine plugin: the video's decoded audio is played
// sample accurately from the song position (several tempi, seeks, loops, start
// offset / delay, range end), with Volume / Mute / Enable audio, the player's
// own playback while Link transport is off, resampling, WAV export, project
// state round trip. The file / picture side (the <video> element) lives in the
// editor and needs a browser.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  genDef, genInCategory, genPresetState, defaultGenParams, normalizeGenParams, formatParam,
} from '../../src/model/gen/registry';
import {
  VP_TIME_MODES, fieldsToTime, formatVideoTime, frameToTimecode, lastFieldMax, playRange, snapFps, ticksToSeconds, timeDialogTitle,
  timeFields, timeModeFps, timeModeLabel, timecodeToFrame, videoMap, volumeGain, vpState,
} from '../../src/model/gen/plugins/videoplayer';
import { createGen, hasGen } from '../../src/engine/gen';
import type { GenContext, GenEnv } from '../../src/engine/gen/types';
import { createGenChannel, createPattern, createNote } from '../../src/model/defaults';
import { slotSampleRefs } from '../../src/audio/engineSamples';
import { createDefaultProject } from '../../src/model/defaults';
import type { FromEngine } from '../../src/engine/protocol';
import { defaultLfo, type AutomationChannel } from '../../src/model/automation';
import type { Clip } from '../../src/model/types';
import { makeEngine, firstNonZero, peak, rms, SR } from './util';

const D = genDef('videoplayer')!;
const ONE = 1 << 20;

// ------------------------------------------------------------------ helpers

interface Smp { channels: Float32Array[]; sampleRate: number }

/** A stereo test sample whose value tells its frame: L[k] = k / 2^20, R[k] = -k / 2^21 (frames < 2^20). */
function ramp(frames: number, rate = SR): Smp {
  const l = new Float32Array(frames), r = new Float32Array(frames);
  for (let k = 0; k < frames; k++) { l[k] = k / ONE; r[k] = -k / (2 * ONE); }
  return { channels: [l, r], sampleRate: rate };
}

/** The frame number of an output value of a ramp sample played at unity gain. */
const frameOf = (v: number): number => Math.round(v * ONE);

function makePlayer(params: Record<string, unknown>, samples: Record<string, Smp> = {}) {
  const env: GenEnv = { sample: (id) => samples[id] };
  const inst = createGen('videoplayer', SR, 128, env)!;
  inst.setParams({ ...defaultGenParams('videoplayer'), ...params });
  return { inst, env };
}

/** A transport the tests drive: 120 BPM, 96 ppq = 192 ticks per second by default. */
class Song {
  tempo = 120;
  ppq = 96;
  playing = true;
  pos = 0;
  get tps(): number { return (this.tempo * this.ppq) / 60; }
  ctx(n: number, extra: Partial<GenContext> = {}): GenContext {
    return { sampleRate: SR, blockSize: 128, tempo: this.tempo, ppq: this.ppq, playing: this.playing, pos: this.pos, songMode: false, track: 0, ...extra };
  }
  /** Position (ticks) of `sec` seconds into the song at the current tempo. */
  at(sec: number): number { return sec * this.tps; }
  advance(n: number): void { if (this.playing) this.pos += (n * this.tps) / SR; }
}

/** Render `frames` frames in blocks of `block`, the song advancing as the engine's does; `each` runs before every block. */
function run(inst: ReturnType<typeof makePlayer>['inst'], song: Song, frames: number, block = 128, each?: (blockStart: number) => void): [Float32Array, Float32Array] {
  const L = new Float32Array(frames), R = new Float32Array(frames);
  const bl = new Float32Array(block), br = new Float32Array(block);
  for (let o = 0; o < frames; o += block) {
    each?.(o);
    const n = Math.min(block, frames - o);
    bl.fill(0); br.fill(0);
    inst.render!(bl, br, n, song.ctx(n));
    L.set(bl.subarray(0, n), o);
    R.set(br.subarray(0, n), o);
    song.advance(n);
  }
  return [L, R];
}

const LINKED = { link: true, sampleId: 's', duration: 20 };

// ------------------------------------------------------------------ registration

describe('Video Player: registration', () => {
  it('is FL\'s Fruity Video Player: Generators > Visual, three parameters, form size 410 x 453', () => {
    expect(D.name).toBe('Video Player');
    expect(D.category).toBe('Visual');
    expect(genInCategory('Visual').map((d) => d.id)).toContain('videoplayer');
    expect(D.notes).toBe('events');
    expect(D.noAudio).toBeUndefined();
    expect(D.ins).toBeUndefined();
    expect([D.width, D.height]).toEqual([410, 453]);
    expect(D.description).toBe('A video file player');
    expect(hasGen('videoplayer')).toBe(true);
    expect(D.params.map((q) => [q.index, q.key, q.name, q.min, q.max, q.def])).toEqual([
      [0, 'volume', 'Volume', 0, 127, 127],
      [1, 'mute', 'Mute audio', 0, 1, 0],
      [2, 'play', 'P lay / pause', 0, 1, 0],
    ]);
  });

  it('writes value texts (FL reports none: the Volume wheel shows its percentage, the buttons On / Off)', () => {
    const [vol, mute, play] = D.params;
    expect(formatParam(vol, 127)).toBe('100%');
    expect(formatParam(vol, 100)).toBe('79%');
    expect(formatParam(vol, 0)).toBe('0%');
    expect(vol.parse!(50)).toBe(64);
    expect(formatParam(mute, 0)).toBe('Off');
    expect(formatParam(mute, 1)).toBe('On');
    expect(formatParam(play, 1)).toBe('On');
  });

  it('has FL\'s one factory preset (Default: Volume 100); loading it keeps the video and the window', () => {
    expect(D.presets!.map((p) => p.name)).toEqual(['Default']);
    const def = defaultGenParams('videoplayer');
    expect(def).toMatchObject({ volume: 127, mute: 0, play: 0, link: true, audio: true, dock: true, loop: false });
    const loaded = { ...def, file: 'a.mp4', videoKey: 'k', videoType: 'video/mp4', sampleId: 's1', duration: 12.5, fps: 25, start: 2, end: 9, pos: 3, seek: 4, detached: true, rect: [1, 2, 300, 200], loop: true, volume: 20, aspect: false };
    const st = genPresetState('videoplayer', D.presets![0], loaded);
    expect(st).toMatchObject({ volume: 100, loop: false, aspect: true, __preset: 'Default' });
    expect(st).toMatchObject({ file: 'a.mp4', videoKey: 'k', sampleId: 's1', duration: 12.5, start: 2, end: 9, detached: true, rect: [1, 2, 300, 200] });
  });

  it('names the pool sample under a key containing "sample" so the engine receives it', () => {
    const p = createDefaultProject({}, {});
    const c = createGenChannel('videoplayer');
    p.channels.push(c);
    p.samples.vid = { id: 'vid', name: 'clip', frames: 10, sampleRate: 48000, channels: 2, source: { kind: 'user', key: 'vid' } };
    expect(slotSampleRefs(p).has('vid')).toBe(false);
    c.plugin!.params.sampleId = 'vid';
    expect(slotSampleRefs(p).has('vid')).toBe(true);
  });

  it('normalises stored states: ranges, types, never starts playing by itself', () => {
    const n = normalizeGenParams('videoplayer', { volume: 400, mute: 5, play: 1, timeMode: 99, start: 'x', end: -3, rect: [1, 2], duration: -1, loop: 'yes', fps: NaN });
    expect(n).toMatchObject({ volume: 127, mute: 1, play: 0, timeMode: 0, start: 0, end: 0, duration: 0, loop: false, fps: 0 });
    expect(n.rect).toEqual([180, 90, 565, 473]);
    const again = normalizeGenParams('videoplayer', JSON.parse(JSON.stringify(n)));
    expect(again).toEqual(n);
    const s = vpState({ volume: 50.4, start: -5, end: 7, timeMode: 6, link: false, rect: [10, 20, 400, 300] });
    expect(s).toMatchObject({ volume: 50, start: -5, end: 7, timeMode: 6, link: false, rect: [10, 20, 400, 300] });
  });
});

// ------------------------------------------------------------------ time

describe('Video Player: time displays', () => {
  it('shows hours:minutes:seconds:milliseconds like FL', () => {
    expect(formatVideoTime(0, 0, 25)).toBe('0:00:00:000');
    expect(formatVideoTime(6.262, 0, 25)).toBe('0:00:06:262');
    expect(formatVideoTime(30.495, 0, 25)).toBe('0:00:30:495');
    expect(formatVideoTime(7200 + 180 + 4.005, 0, 25)).toBe('2:03:04:005');
    expect(formatVideoTime(131.125, 0, 25)).toBe('0:02:11:125');
    // a delayed start is negative
    expect(formatVideoTime(-5, 0, 25)).toBe('-0:00:05:000');
    expect(formatVideoTime(59.9996, 0, 25)).toBe('0:01:00:000');
  });

  it('shows SMPTE frame numbers: non-drop, drop-frame, Auto', () => {
    expect(formatVideoTime(6.5, 3, 0)).toBe('0:00:06:12'); // 25 fps
    expect(formatVideoTime(0.5, 2, 0)).toBe('0:00:00:12'); // 24 fps
    expect(formatVideoTime(3661.5, 5, 0)).toBe('1:01:01:15'); // 30 fps
    expect(formatVideoTime(1, 14, 0)).toBe('0:00:01:000'); // 120 fps: three digits
    expect(formatVideoTime(1, 6, 25)).toBe('0:00:01:00'); // Auto uses the clip's rate
    expect(formatVideoTime(1.5, 6, 0)).toBe('0:00:01:12'); // unknown clip rate: 25
    expect(timeModeFps(6, 50)).toBe(50);
    expect(timeModeFps(0, 50)).toBe(0);
    // drop frame: 00:00:59;29 is followed by 00:01:00;02
    expect(frameToTimecode(1799, 30000 / 1001, true)).toEqual([0, 0, 59, 29]);
    expect(frameToTimecode(1800, 30000 / 1001, true)).toEqual([0, 1, 0, 2]);
    expect(frameToTimecode(17982, 30000 / 1001, true)).toEqual([0, 10, 0, 0]);
    expect(frameToTimecode(1800, 30000 / 1001, false)).toEqual([0, 1, 0, 0]);
    expect(frameToTimecode(3600, 60000 / 1001, true)).toEqual([0, 1, 0, 4]);
    expect(formatVideoTime(1800 / (30000 / 1001), 4, 0)).toBe('0:01:00;02');
    for (const drop of [false, true]) {
      for (const fps of [24000 / 1001, 25, 30000 / 1001, 60000 / 1001]) {
        if (drop && fps !== 30000 / 1001 && fps !== 60000 / 1001) continue;
        for (const n of [0, 1, 29, 30, 1799, 1800, 1801, 17981, 17982, 107892, 215784]) {
          const [h, m, s, f] = frameToTimecode(n, fps, drop);
          expect(timecodeToFrame(h, m, s, f, fps, drop), `${drop} ${fps} ${n}`).toBe(n);
        }
      }
    }
  });

  it('has FL\'s menu: 15 entries in the form\'s order with its tags and captions', () => {
    expect(VP_TIME_MODES.map((m) => m.tag)).toEqual([0, 1, 2, 3, 4, 7, 5, 8, 9, 10, 11, 13, 12, 14, 6]);
    expect(VP_TIME_MODES[0].label).toBe('Hours:Minutes:Seconds:Ms');
    expect(VP_TIME_MODES[7].label).toBe('SMPTE (48fps NONDROP)');
    expect(timeModeLabel(VP_TIME_MODES[14], 25)).toBe('SMPTE (Auto : 25 fps)');
    expect(timeModeLabel(VP_TIME_MODES[14], 29.97)).toBe('SMPTE (Auto : 29.97 fps)');
    expect(timeModeLabel(VP_TIME_MODES[14], 0)).toBe('SMPTE (Auto : 25 fps)');
    expect(timeDialogTitle('Start', 0)).toBe('Start time (H:M:S:MS)');
    expect(timeDialogTitle('End', 3)).toBe('End time (H:M:S:Frame)');
    expect(timeDialogTitle('Current', 0)).toBe('Current time (H:M:S:MS)');
  });

  it('converts to and from the Set time dialog\'s fields', () => {
    expect(timeFields(131.125, 0, 25)).toEqual([0, 2, 11, 125]);
    expect(fieldsToTime(0, 2, 11, 125, 0, 25)).toBeCloseTo(131.125, 9);
    expect(timeFields(-5.5, 0, 25)).toEqual([0, 0, 5, 500]);
    expect(timeFields(6.5, 3, 0)).toEqual([0, 0, 6, 12]);
    expect(fieldsToTime(0, 0, 6, 12, 3, 0)).toBeCloseTo(6.48, 9);
    expect(lastFieldMax(0, 25)).toBe(999);
    expect(lastFieldMax(3, 0)).toBe(24);
    expect(lastFieldMax(4, 0)).toBe(29);
    expect(snapFps(29.9701)).toBeCloseTo(30000 / 1001, 9);
    expect(snapFps(25.01)).toBe(25);
    expect(snapFps(15)).toBe(15);
    expect(snapFps(0)).toBe(0);
  });
});

describe('Video Player: the song position drives the video', () => {
  it('plays the range from the song start; a negative start delays the video', () => {
    const { lo, hi } = playRange(0, 0, 10);
    expect([lo, hi]).toEqual([0, 10]);
    expect(videoMap(0, lo, hi, false, 3)).toEqual({ t: 3, on: true });
    expect(videoMap(0, lo, hi, false, 10)).toEqual({ t: 10, on: false });
    expect(videoMap(0, lo, hi, true, 13)).toEqual({ t: 3, on: true });
    // delayed by 2 s: the first frame waits, the video starts at song second 2
    const d = playRange(-2, 0, 10);
    expect(d).toEqual({ lo: 0, hi: 10 });
    expect(videoMap(-2, d.lo, d.hi, false, 1)).toEqual({ t: 0, on: false });
    expect(videoMap(-2, d.lo, d.hi, false, 2)).toEqual({ t: 0, on: true });
    expect(videoMap(-2, d.lo, d.hi, false, 5)).toEqual({ t: 3, on: true });
    // trimmed: starts at 5 s and ends at 8 s
    const r = playRange(5, 8, 10);
    expect(videoMap(5, r.lo, r.hi, false, 0)).toEqual({ t: 5, on: true });
    expect(videoMap(5, r.lo, r.hi, false, 3)).toEqual({ t: 8, on: false });
    expect(videoMap(5, r.lo, r.hi, true, 4)).toEqual({ t: 6, on: true });
    expect(playRange(0, 99, 10).hi).toBe(10);
    expect(ticksToSeconds(960, 120, 96)).toBe(5);
    expect(ticksToSeconds(960, 60, 96)).toBe(10);
  });

  it('scales the audio linearly with Volume (127 = the file\'s own level)', () => {
    expect(volumeGain(127)).toBe(1);
    expect(volumeGain(0)).toBe(0);
    expect(volumeGain(100)).toBeCloseTo(100 / 127, 12);
    expect(volumeGain(999)).toBe(1);
  });
});

// ------------------------------------------------------------------ engine: following the song

describe('Video Player engine: Link transport', () => {
  it('plays the video\'s audio from the song start, sample accurately (stereo, unity gain)', () => {
    const { inst } = makePlayer(LINKED, { s: ramp(200000) });
    const [L, R] = run(inst, new Song(), 5000);
    for (const f of [0, 1, 127, 128, 129, 2047, 4999]) {
      expect(frameOf(L[f]), `L ${f}`).toBe(f);
      expect(R[f], `R ${f}`).toBeCloseTo(-f / (2 * ONE), 12);
    }
  });

  it('starts where the song is: the song position in seconds is the video\'s time', () => {
    for (const tempo of [60, 90, 120, 150, 180]) {
      const { inst } = makePlayer(LINKED, { s: ramp(48000 * 20) });
      const song = new Song();
      song.tempo = tempo;
      song.pos = song.at(5); // 5 s into the song
      const [L] = run(inst, song, 2000);
      expect(frameOf(L[0]), `tempo ${tempo}`).toBe(5 * SR);
      expect(frameOf(L[1999]), `tempo ${tempo}`).toBe(5 * SR + 1999);
    }
  });

  it('keeps real time: a tempo change does not speed the video up or make it jump', () => {
    const { inst } = makePlayer(LINKED, { s: ramp(48000 * 20) });
    const song = new Song();
    const [L] = run(inst, song, 48000, 128, (o) => { if (o === 128 * 100) song.tempo = 180; });
    for (let f = 0; f < 48000; f += 1) if (frameOf(L[f]) !== f) { expect(f, 'first deviating frame').toBe(-1); break; }
    expect(frameOf(L[47999])).toBe(47999);
    // 90 BPM then 200 BPM: same
    const b = makePlayer(LINKED, { s: ramp(48000 * 20) });
    const s2 = new Song();
    s2.tempo = 90;
    const [M] = run(b.inst, s2, 60000, 128, (o) => { if (o === 128 * 200) s2.tempo = 200; });
    expect(frameOf(M[59999])).toBe(59999);
  });

  it('does not depend on the block size', () => {
    const a = makePlayer(LINKED, { s: ramp(100000) });
    const b = makePlayer(LINKED, { s: ramp(100000) });
    const [A] = run(a.inst, new Song(), 9000, 128);
    const [B] = run(b.inst, new Song(), 9000, 37);
    expect(Array.from(B)).toEqual(Array.from(A));
    expect(frameOf(B[8999])).toBe(8999);
  });

  it('is silent while the song is stopped and resumes at the song position', () => {
    const { inst } = makePlayer(LINKED, { s: ramp(48000 * 20) });
    const song = new Song();
    run(inst, song, 128 * 10);
    expect(song.pos).toBeCloseTo((1280 * 192) / SR, 9);
    song.playing = false;
    const [S] = run(inst, song, 1000);
    expect(peak(S)).toBe(0);
    // pause: the position stays; playing again continues where the song stands
    song.playing = true;
    const [L] = run(inst, song, 256);
    expect(frameOf(L[0])).toBe(1280);
    expect(frameOf(L[255])).toBe(1280 + 255);
  });

  it('follows seeks while playing and re-anchors a pattern / song loop wrap', () => {
    const { inst } = makePlayer(LINKED, { s: ramp(48000 * 20) });
    const song = new Song();
    const [L] = run(inst, song, 128 * 40, 128, (o) => { if (o === 128 * 20) song.pos = song.at(3); });
    expect(frameOf(L[128 * 20 - 1])).toBe(128 * 20 - 1);
    expect(frameOf(L[128 * 20])).toBe(3 * SR);
    expect(frameOf(L[128 * 40 - 1])).toBe(3 * SR + 128 * 20 - 1);
    // a loop wrap back to the start
    const b = makePlayer(LINKED, { s: ramp(48000 * 20) });
    const s2 = new Song();
    s2.pos = s2.at(1);
    const [W] = run(b.inst, s2, 128 * 10, 128, (o) => { if (o === 128 * 5) s2.pos = 0; });
    expect(frameOf(W[0])).toBe(SR);
    expect(frameOf(W[128 * 5])).toBe(0);
    expect(frameOf(W[128 * 10 - 1])).toBe(128 * 5 - 1);
  });

  it('start trims the beginning, a negative start delays the video, end stops it (Loop wraps)', () => {
    const smp = { s: ramp(48000 * 20) };
    // start 2 s: the song start shows the video at 2 s
    const a = makePlayer({ ...LINKED, start: 2 }, smp);
    expect(frameOf(run(a.inst, new Song(), 10)[0][0])).toBe(2 * SR);
    // delayed by 1 s: silence, then the video's first frame at song second 1
    const b = makePlayer({ ...LINKED, start: -1 }, smp);
    const [D1] = run(b.inst, new Song(), SR + 1000);
    expect(peak(D1, 0, SR)).toBe(0);
    expect(D1[SR]).toBe(0); // the video's frame 0 is silent in a ramp
    expect(frameOf(D1[SR + 1])).toBe(1);
    expect(frameOf(D1[SR + 999])).toBe(999);
    // end 1 s: the audio ends at the end of the range
    const c = makePlayer({ ...LINKED, end: 1 }, smp);
    const [E] = run(c.inst, new Song(), SR + 5000);
    expect(frameOf(E[SR - 1])).toBe(SR - 1);
    expect(peak(E, SR, SR + 5000)).toBe(0);
    // Loop: the range repeats (start 0.5 .. end 1)
    const d = makePlayer({ ...LINKED, start: 0.5, end: 1, loop: true }, smp);
    const [P] = run(d.inst, new Song(), SR);
    const half = SR / 2;
    expect(frameOf(P[0])).toBe(half);
    expect(frameOf(P[half - 1])).toBe(2 * half - 1);
    expect(frameOf(P[half])).toBe(half); // wrapped at sample accuracy, inside a block
    expect(frameOf(P[SR - 1])).toBe(2 * half - 1);
  });

  it('wraps a looped range at the exact frame even when it falls inside a block', () => {
    const { inst } = makePlayer({ ...LINKED, start: 0, end: 1000 / SR, loop: true }, { s: ramp(48000 * 20) });
    const [L] = run(inst, new Song(), 3000);
    for (let f = 0; f < 3000; f++) if (frameOf(L[f]) !== f % 1000) { expect(`${f}: ${frameOf(L[f])}`).toBe(`${f}: ${f % 1000}`); break; }
  });

  it('applies Volume, Mute audio and Enable audio', () => {
    const smp = { s: { channels: [new Float32Array(10000).fill(0.5)], sampleRate: SR } };
    const at = (params: Record<string, unknown>) => run(makePlayer({ ...LINKED, ...params }, smp).inst, new Song(), 1000)[0][999];
    expect(at({})).toBe(0.5);
    expect(at({ volume: 127 })).toBe(0.5);
    expect(at({ volume: 64 })).toBeCloseTo(0.5 * (64 / 127), 6);
    expect(at({ volume: 0 })).toBe(0);
    expect(at({ mute: 1 })).toBe(0);
    expect(at({ audio: false })).toBe(0);
    // mono audio plays on both sides
    const [L, R] = run(makePlayer(LINKED, smp).inst, new Song(), 100);
    expect(L[50]).toBe(R[50]);
    expect(L[50]).toBe(0.5);
  });

  it('ramps a gain change over one block (no step)', () => {
    const smp = { s: { channels: [new Float32Array(48000).fill(1)], sampleRate: SR } };
    const { inst } = makePlayer(LINKED, smp);
    const song = new Song();
    const [L] = run(inst, song, 128 * 4, 128, (o) => { if (o === 128 * 2) inst.setParams({ ...defaultGenParams('videoplayer'), ...LINKED, mute: 1 }); });
    expect(L[128 * 2 - 1]).toBe(1);
    expect(L[128 * 2]).toBeLessThan(1);
    expect(L[128 * 2]).toBeGreaterThan(0.98);
    expect(L[128 * 3 - 1]).toBeCloseTo(0, 6);
    expect(L[128 * 3]).toBe(0);
    for (let f = 128 * 2; f < 128 * 3; f++) expect(L[f]).toBeLessThanOrEqual(L[f - 1] + 1e-9);
  });

  it('resamples audio at another rate (a 1 kHz sine keeps its pitch and level)', () => {
    const rate = 44100;
    const frames = rate * 3;
    const sine = new Float32Array(frames);
    for (let k = 0; k < frames; k++) sine[k] = 0.8 * Math.sin((2 * Math.PI * 1000 * k) / rate);
    const { inst } = makePlayer({ ...LINKED, duration: 3 }, { s: { channels: [sine], sampleRate: rate } });
    const song = new Song();
    song.pos = song.at(0.25);
    const [L] = run(inst, song, SR);
    // compare against the ideal sine of the video's time at every 97th frame
    let worst = 0;
    for (let f = 200; f < SR - 200; f += 97) {
      const t = 0.25 + f / SR;
      worst = Math.max(worst, Math.abs(L[f] - 0.8 * Math.sin(2 * Math.PI * 1000 * t)));
    }
    expect(worst).toBeLessThan(0.02);
    expect(rms(L, 1000, SR - 1000)).toBeCloseTo(0.8 * Math.SQRT1_2, 2);
    // the end of the audio is silence, not garbage
    const b = makePlayer({ ...LINKED, duration: 3 }, { s: { channels: [sine], sampleRate: rate } });
    const s2 = new Song();
    s2.pos = s2.at(2.99);
    const [E] = run(b.inst, s2, 2000);
    expect(peak(E, 1200, 2000)).toBe(0);
    for (const v of E) expect(Number.isFinite(v)).toBe(true);
  });

  it('is rendered while a clip is loaded and idle without one; a missing sample is silent', () => {
    expect(makePlayer({}).inst.tail).toBe(0);
    expect(makePlayer({ duration: 12 }).inst.tail).toBe(Infinity);
    expect(makePlayer({ sampleId: 'gone', duration: 5 }).inst.tail).toBe(Infinity);
    const { inst } = makePlayer({ sampleId: 'gone', duration: 5 });
    const [L, R] = run(inst, new Song(), 1000);
    expect(peak(L)).toBe(0);
    expect(peak(R)).toBe(0);
    // the audio arrives later: it plays in sync from then on
    const smps: Record<string, Smp> = {};
    const b = makePlayer({ ...LINKED }, smps);
    const song = new Song();
    run(b.inst, song, 128 * 10);
    smps.s = ramp(48000 * 20);
    const [A] = run(b.inst, song, 128 * 40);
    expect(frameOf(A[128 * 40 - 1])).toBe(128 * 50 - 1);
  });

  it('ignores the player\'s own Play, pos and seek while Link transport is on', () => {
    const { inst } = makePlayer({ ...LINKED, pos: 3 }, { s: ramp(48000 * 20) });
    const song = new Song();
    song.playing = false;
    inst.setParams({ ...defaultGenParams('videoplayer'), ...LINKED, pos: 5, seek: 1, play: 1 });
    expect(peak(run(inst, song, 1000)[0])).toBe(0);
    expect(inst.takeStateChanges!()).toBeNull();
    // the song decides: it starts at its own position, not at pos
    song.playing = true;
    expect(frameOf(run(inst, song, 100)[0][0])).toBe(0);
  });

  it('reports the video time to the editor', () => {
    const { inst } = makePlayer(LINKED, { s: ramp(48000 * 20) });
    const song = new Song();
    run(inst, song, 128 * 10);
    expect(inst.monitor!()).toMatchObject({ playing: true, link: true, audio: true });
    expect(Number(inst.monitor!()!.vt)).toBeCloseTo(1280 / SR, 9);
    song.playing = false;
    song.pos = song.at(7);
    run(inst, song, 128);
    expect(inst.monitor!()).toMatchObject({ playing: false });
    expect(Number(inst.monitor!()!.vt)).toBeCloseTo(7, 9);
  });
});

describe('Video Player engine: randomised scripts against a frame-by-frame reference', () => {
  /** mulberry32: a small seeded generator. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (let seed = 1; seed <= 150; seed++) {
    it(`script ${seed}: seeks, pauses, range, delay and loop`, () => {
      const r = rng(seed * 7919);
      const durF = SR * 8;
      const startF = [0, 0, 5000, 24000, -7000, -48000, 100][Math.floor(r() * 7)];
      const endChoices = [0, 30000, 96000, 150000, 200000];
      let endF = endChoices[Math.floor(r() * endChoices.length)];
      const loF = Math.max(0, startF);
      if (endF > 0 && endF <= loF + 1000) endF = 0;
      const hiF = endF > 0 ? Math.min(endF, durF) : durF;
      const loop = r() < 0.5;
      const bs = [128, 128, 100, 64, 37][Math.floor(r() * 5)];
      const { inst } = makePlayer({ ...LINKED, duration: 8, start: startF / SR, end: endF / SR, loop }, { s: ramp(durF) });

      const song = new Song(); // 120 BPM, 96 ppq: 250 frames per tick
      const total = 20480;
      const blocks = Math.ceil(total / bs);
      const L = new Float32Array(bs * blocks);
      const expected = new Float32Array(bs * blocks);
      let anchor: number | null = null; // video frame at the next output frame while playing (unwrapped)
      let pauseLeft = 0;
      let wasPlaying = false;
      const bl = new Float32Array(bs), br = new Float32Array(bs);
      for (let b = 0; b < blocks; b++) {
        if (r() < 0.06) { song.pos = Math.floor(r() * 3000); anchor = null; }
        if (pauseLeft > 0) pauseLeft--;
        else if (r() < 0.04) pauseLeft = 1 + Math.floor(r() * 4);
        song.playing = pauseLeft === 0;
        if (song.playing) {
          if (!wasPlaying || anchor === null) anchor = startF + Math.round(song.pos * 250);
          for (let i = 0; i < bs; i++) {
            const ux = anchor + i;
            let k = -1;
            if (ux >= loF && ux < hiF) k = ux;
            else if (ux >= hiF && loop && hiF > loF) k = loF + ((ux - loF) % (hiF - loF));
            expected[b * bs + i] = k >= 0 && k < durF ? k / ONE : 0;
          }
          anchor += bs;
        }
        wasPlaying = song.playing;
        bl.fill(0); br.fill(0);
        inst.render!(bl, br, bs, song.ctx(bs));
        L.set(bl, b * bs);
        song.advance(bs);
      }
      for (let f = 0; f < L.length; f++) {
        if (L[f] !== expected[f]) { expect(`frame ${f}: ${frameOf(L[f])}`).toBe(`frame ${f}: ${frameOf(expected[f])}`); }
      }
    });
  }
});

// ------------------------------------------------------------------ engine: the player's own playback

describe('Video Player engine: Link transport off', () => {
  const FREE = { link: false, sampleId: 's', duration: 20 };
  const params = (p: Record<string, unknown>) => ({ ...defaultGenParams('videoplayer'), ...FREE, ...p });

  it('plays by itself from pos while P lay / pause is on, whatever the song does', () => {
    const { inst } = makePlayer({ ...FREE, pos: 2 }, { s: ramp(48000 * 20) });
    const song = new Song();
    song.playing = false;
    expect(peak(run(inst, song, 1000)[0])).toBe(0);
    inst.setParams(params({ pos: 2, play: 1 }));
    const [L] = run(inst, song, 5000);
    expect(frameOf(L[0])).toBe(2 * SR);
    expect(frameOf(L[4999])).toBe(2 * SR + 4999);
    // the song starting or seeking changes nothing
    song.playing = true;
    song.pos = 12345;
    const [M] = run(inst, song, 1000);
    expect(frameOf(M[0])).toBe(2 * SR + 5000);
  });

  it('pauses where it is and reports the position; the next Play continues from there', () => {
    const { inst } = makePlayer({ ...FREE, pos: 1 }, { s: ramp(48000 * 20) });
    const song = new Song();
    inst.setParams(params({ pos: 1, play: 1 }));
    run(inst, song, 128 * 20);
    expect(inst.takeStateChanges!()).toBeNull();
    inst.setParams(params({ pos: 1, play: 0 }));
    const ch = inst.takeStateChanges!()!;
    expect(ch.map((c) => c[0])).toEqual(['pos']);
    expect(Number(ch[0][1])).toBeCloseTo(1 + 2560 / SR, 9);
    expect(peak(run(inst, song, 500)[0])).toBe(0);
    expect(inst.takeStateChanges!()).toBeNull();
    // the editor stored pos; Play resumes there
    inst.setParams(params({ pos: ch[0][1], play: 1 }));
    const [L] = run(inst, song, 100);
    expect(frameOf(L[0])).toBe(SR + 2560);
  });

  it('jumps when pos and seek change, also while playing', () => {
    const { inst } = makePlayer({ ...FREE, pos: 0 }, { s: ramp(48000 * 20) });
    const song = new Song();
    inst.setParams(params({ pos: 0, play: 1 }));
    run(inst, song, 128 * 4);
    inst.setParams(params({ pos: 9, play: 1, seek: 1 }));
    const [L] = run(inst, song, 128);
    expect(frameOf(L[0])).toBe(9 * SR);
    // seeking to the same time again (the counter changes) restarts there
    run(inst, song, 128 * 10);
    inst.setParams(params({ pos: 9, play: 1, seek: 2 }));
    expect(frameOf(run(inst, song, 128)[0][0])).toBe(9 * SR);
    // while paused a seek only moves the resting position
    inst.setParams(params({ pos: 9, play: 0, seek: 2 }));
    inst.takeStateChanges!();
    inst.setParams(params({ pos: 4, play: 0, seek: 3 }));
    expect(peak(run(inst, song, 300)[0])).toBe(0);
    expect(Number(inst.monitor!()!.vt)).toBe(4);
    inst.setParams(params({ pos: 4, play: 1, seek: 3 }));
    expect(frameOf(run(inst, song, 100)[0][0])).toBe(4 * SR);
  });

  it('Stop (the position first, then Play off) pauses at the new position', () => {
    const { inst } = makePlayer({ ...FREE, start: 2, pos: 5 }, { s: ramp(48000 * 20) });
    const song = new Song();
    inst.setParams(params({ start: 2, pos: 5, play: 1 }));
    run(inst, song, 128 * 30);
    // the editor writes pos = start of the range with a new seek, then play = 0
    inst.setParams(params({ start: 2, pos: 2, seek: 1, play: 1 }));
    inst.setParams(params({ start: 2, pos: 2, seek: 1, play: 0 }));
    expect(inst.takeStateChanges!()).toEqual([['pos', 2]]);
    expect(peak(run(inst, song, 300)[0])).toBe(0);
    inst.setParams(params({ start: 2, pos: 2, seek: 1, play: 1 }));
    expect(frameOf(run(inst, song, 10)[0][0])).toBe(2 * SR);
  });

  it('stops at the end of the range and reports it (play = 0, pos = end); Play again restarts at the start', () => {
    const { inst } = makePlayer({ ...FREE, start: 1, end: 1.5 }, { s: ramp(48000 * 20) });
    const song = new Song();
    inst.setParams(params({ start: 1, end: 1.5, pos: 0, play: 1 }));
    const [L] = run(inst, song, SR);
    // pos 0 is outside the range: playing starts at its start
    expect(frameOf(L[0])).toBe(SR);
    expect(frameOf(L[24000 - 1])).toBe(SR + 24000 - 1);
    expect(peak(L, 24000, SR)).toBe(0);
    const ch = inst.takeStateChanges!()!;
    expect(ch).toEqual([['play', 0], ['pos', 1.5]]);
    expect(inst.monitor!()).toMatchObject({ playing: false });
    // the editor mirrors play = 0 and pos; pressing Play restarts from the start of the range
    inst.setParams(params({ start: 1, end: 1.5, pos: 1.5, play: 0 }));
    inst.setParams(params({ start: 1, end: 1.5, pos: 1.5, play: 1 }));
    expect(frameOf(run(inst, song, 10)[0][0])).toBe(SR);
  });

  it('does not run without a clip: Play switches itself off again', () => {
    const { inst } = makePlayer({ link: false, sampleId: '', duration: 0 });
    inst.setParams(params({ sampleId: '', duration: 0, play: 1 }));
    run(inst, new Song(), 300);
    expect(inst.takeStateChanges!()).toEqual([['play', 0], ['pos', 0]]);
    expect(inst.monitor!()).toMatchObject({ playing: false });
  });

  it('loops its range with Loop', () => {
    const { inst } = makePlayer({ ...FREE }, { s: ramp(48000 * 20) });
    inst.setParams(params({ start: 0, end: 0.25, loop: true, pos: 0, play: 1 }));
    const [L] = run(inst, new Song(), 30000);
    for (let f = 0; f < 30000; f++) if (frameOf(L[f]) !== f % 12000) { expect(`${f}: ${frameOf(L[f])}`).toBe(`${f}: ${f % 12000}`); break; }
    expect(inst.takeStateChanges!()).toBeNull();
  });

  it('linking a player that runs by itself stops it where it is (Play off), unlinking does not restart it', () => {
    const { inst } = makePlayer({ ...FREE, pos: 2 }, { s: ramp(48000 * 20) });
    const song = new Song();
    song.playing = false;
    inst.setParams(params({ pos: 2, play: 1 }));
    run(inst, song, 128 * 10);
    inst.setParams(params({ pos: 2, play: 1, link: true }));
    const ch = inst.takeStateChanges!()!;
    expect(ch.map((c) => c[0])).toEqual(['play', 'pos']);
    expect(ch[0][1]).toBe(0);
    expect(Number(ch[1][1])).toBeCloseTo(2 + 1280 / SR, 9);
    expect(peak(run(inst, song, 300)[0])).toBe(0);
    // the editor mirrored play = 0 and pos; unlinking leaves the player resting
    inst.setParams(params({ pos: 2 + 1280 / SR, play: 0, link: true }));
    inst.setParams(params({ pos: 2 + 1280 / SR, play: 0, link: false }));
    expect(peak(run(inst, song, 300)[0])).toBe(0);
    inst.setParams(params({ pos: 2 + 1280 / SR, play: 1, link: false }));
    expect(frameOf(run(inst, song, 10)[0][0])).toBe(2 * SR + 1280);
  });

  it('switching Link transport on and off hands the playback over', () => {
    const { inst } = makePlayer({ ...LINKED }, { s: ramp(48000 * 20) });
    const song = new Song();
    run(inst, song, 128 * 10);
    // unlinked while the song plays: the player's own Play decides (off: it stops where it is)
    inst.setParams(params({ pos: 0, play: 0, link: false }));
    expect(inst.takeStateChanges!()!.map((c) => c[0])).toEqual(['pos']);
    expect(peak(run(inst, song, 300)[0])).toBe(0);
    inst.setParams(params({ pos: 0, play: 0, link: true }));
    // linked again: follows the song position
    const [L] = run(inst, song, 100);
    expect(frameOf(L[0])).toBe(128 * 10 + 300);
  });
});

describe('Video Player engine: the player\'s own playback against a frame-by-frame reference', () => {
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (let seed = 1; seed <= 80; seed++) {
    it(`script ${seed}: play from a position, the end of the range or its loop`, () => {
      const r = rng(seed * 104729);
      const durF = SR * 8;
      const startF = [0, 0, 5000, 24000, 100][Math.floor(r() * 5)];
      const endChoices = [0, 30000, 96000, 150000];
      let endF = endChoices[Math.floor(r() * endChoices.length)];
      if (endF > 0 && endF <= startF + 1000) endF = 0;
      const loF = startF;
      const hiF = endF > 0 ? Math.min(endF, durF) : durF;
      const loop = r() < 0.4;
      const posF = Math.floor(r() * (durF + 5000));
      const bs = [128, 100, 64, 37][Math.floor(r() * 4)];
      const base = { ...defaultGenParams('videoplayer'), link: false, sampleId: 's', duration: 8, start: startF / SR, end: endF / SR, loop };
      const { inst } = makePlayer(base, { s: ramp(durF) });
      inst.setParams({ ...base, pos: posF / SR, play: 1 });
      const total = 20480, blocks = Math.ceil(total / bs);
      const song = new Song();
      const bl = new Float32Array(bs), br = new Float32Array(bs);
      let x = posF >= loF && posF < hiF ? posF : loF; // the player's Play starts at pos, or at the range's start
      let running = true;
      const changes: [string, unknown][] = [];
      const reported: [string, unknown][] = [];
      for (let b = 0; b < blocks; b++) {
        bl.fill(0); br.fill(0);
        inst.render!(bl, br, bs, song.ctx(bs));
        for (let i = 0; i < bs; i++) {
          let want = 0;
          if (running) {
            if (x >= hiF) {
              if (loop) x = loF + ((x - loF) % (hiF - loF));
              else { running = false; changes.push(['play', 0], ['pos', hiF / SR]); }
            }
            if (running) { want = x / ONE; x++; }
          }
          if (bl[i] !== want) expect(`block ${b} frame ${i}: ${frameOf(bl[i])}`).toBe(`block ${b} frame ${i}: ${frameOf(want)}`);
        }
        const got = inst.takeStateChanges!();
        if (got) reported.push(...got);
        song.advance(bs);
      }
      // the end of the range is reported once, with the end time as the position
      expect(reported).toEqual(changes);
    });
  }
});

// ------------------------------------------------------------------ engine: robustness

describe('Video Player engine: robustness', () => {
  it('stays finite with garbage state, non-finite audio and extreme settings', () => {
    const bad = new Float32Array(5000);
    bad.fill(0.5);
    bad[100] = NaN; bad[101] = Infinity; bad[102] = -Infinity;
    const states: Record<string, unknown>[] = [
      { ...LINKED, volume: NaN, start: Infinity, end: -Infinity, pos: NaN, seek: NaN },
      { ...LINKED, start: -1e9, end: 1e9, loop: true },
      { ...LINKED, start: 1e-12, end: 1e-9, loop: true },
      { link: false, sampleId: 's', duration: 1e12, play: 1, pos: 1e12, loop: true, end: 1e-6 },
      { link: false, sampleId: 's', duration: 0, play: 1 },
    ];
    for (const st of states) {
      const { inst } = makePlayer(st, { s: { channels: [bad], sampleRate: 44100 } });
      const song = new Song();
      song.tempo = 20;
      const [L, R] = run(inst, song, 4000);
      for (let i = 0; i < L.length; i++) expect(Number.isFinite(L[i]) && Number.isFinite(R[i]), JSON.stringify(st)).toBe(true);
      inst.setParams(null);
      inst.setParams({ ...st, play: 1, sampleId: 5 });
      song.tempo = 0;
      run(inst, song, 300);
      song.tempo = 5000;
      run(inst, song, 300);
    }
    // the sampled non-finite values were replaced by silence
    const { inst } = makePlayer(LINKED, { s: { channels: [bad], sampleRate: SR } });
    const [L] = run(inst, new Song(), 300);
    expect([L[99], L[100], L[101], L[102], L[103]]).toEqual([0.5, 0, 0, 0, 0.5]);
  });

  it('reset() goes back to the resting position and silence', () => {
    const { inst } = makePlayer({ link: false, sampleId: 's', duration: 20, pos: 3, play: 1 }, { s: ramp(48000 * 20) });
    inst.setParams({ ...defaultGenParams('videoplayer'), link: false, sampleId: 's', duration: 20, pos: 3, play: 0 });
    inst.setParams({ ...defaultGenParams('videoplayer'), link: false, sampleId: 's', duration: 20, pos: 3, play: 1 });
    run(inst, new Song(), 1280);
    inst.reset();
    expect(peak(run(inst, new Song(), 300)[0])).toBe(0);
    expect(inst.takeStateChanges!()).toBeNull();
  });

  it('JSON round trip of every state the editor writes', () => {
    const st = { ...defaultGenParams('videoplayer'), file: 'clip.mp4', videoKey: 'v1-abc', videoType: 'video/mp4', sampleId: 's42', duration: 83.4, fps: 29.97, start: -2.5, end: 60, pos: 12.25, seek: 7, rect: [10, 20, 640, 480], timeMode: 4, loop: true, link: false, dock: false, aspect: false, audio: false, detached: true };
    const back = JSON.parse(JSON.stringify(st));
    expect(normalizeGenParams('videoplayer', back)).toEqual({ ...st, play: 0 });
    expect(vpState(st)).toMatchObject({ file: 'clip.mp4', fps: 29.97, start: -2.5, link: false, timeMode: 4 });
  });
});

// ------------------------------------------------------------------ through the engine's channel

describe('Video Player in the engine', () => {
  /** An engine with one Video Player channel playing a ramp / impulse sample from the song start. */
  function setup(params: Record<string, unknown>, smp: Smp, opts: { rendering?: boolean; post?: (m: FromEngine) => void; bars?: number; tempo?: number } = {}) {
    const e = makeEngine({ rendering: opts.rendering, post: opts.post });
    if (opts.tempo) e.handle({ t: 'globals', g: { tempo: opts.tempo, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } });
    const ch = createGenChannel('videoplayer');
    ch.plugin!.params = { ...defaultGenParams('videoplayer'), link: true, sampleId: 'vid', duration: smp.channels[0].length / smp.sampleRate, ...params };
    e.handle({ t: 'sample', id: 'vid', data: smp.channels, sampleRate: smp.sampleRate });
    e.handle({ t: 'channel', c: ch });
    const pat = createPattern(1);
    pat.lengthSteps = (opts.bars ?? 32) * 16;
    e.handle({ t: 'pattern', p: pat });
    e.handle({ t: 'mode', song: false, patternId: pat.id });
    return { e, ch };
  }

  /** A mono sample of silence with an impulse at `at` seconds. */
  const impulse = (at: number, secs = 20, rate = SR): Smp => {
    const a = new Float32Array(Math.round(secs * rate));
    a[Math.round(at * rate)] = 1;
    return { channels: [a], sampleRate: rate };
  };

  it('plays the audio from the song start through the channel\'s mixer track', () => {
    const { e } = setup({}, impulse(1.25));
    e.handle({ t: 'play' });
    const [L, R] = e.renderOffline(SR * 2);
    expect(firstNonZero(L)).toBe(Math.round(1.25 * SR));
    expect(firstNonZero(R)).toBe(Math.round(1.25 * SR));
    expect(peak(L, 0, Math.round(1.25 * SR))).toBe(0);
  });

  it('follows a seek, whatever the tempo (position in ticks -> seconds)', () => {
    for (const tempo of [70, 120, 155]) {
      const { e } = setup({}, impulse(6), { tempo });
      e.handle({ t: 'seek', tick: (4 * tempo * 96) / 60 }); // song second 4
      e.handle({ t: 'play' });
      const [L] = e.renderOffline(SR * 3);
      expect(firstNonZero(L), `tempo ${tempo}`).toBe(2 * SR);
    }
  });

  it('is stopped by the transport and does not sound while the song is stopped', () => {
    const { e } = setup({}, impulse(0.5));
    const [S] = e.renderOffline(SR);
    expect(peak(S)).toBe(0);
    e.handle({ t: 'play' });
    expect(firstNonZero(e.renderOffline(SR)[0])).toBe(SR / 2);
    e.handle({ t: 'pause' });
    expect(peak(e.renderOffline(SR)[0])).toBe(0);
  });

  it('re-anchors at the pattern loop: the video restarts with the loop', () => {
    // one bar at 120 BPM = 2 s; the impulse at 0.5 s sounds again in the second bar
    const { e } = setup({}, impulse(0.5), { bars: 1 });
    e.handle({ t: 'play' });
    const [L] = e.renderOffline(SR * 4);
    const hits: number[] = [];
    for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > 1e-6) hits.push(i);
    expect(hits.length).toBe(2);
    expect(hits[0]).toBe(SR / 2);
    // block granularity: the loop wrap is found at the next block (within 128 frames of the loop point)
    expect(hits[1] - 2 * SR - SR / 2).toBeGreaterThanOrEqual(0);
    expect(hits[1] - 2 * SR - SR / 2).toBeLessThanOrEqual(128);
  });

  it('renders the same in a WAV export engine (the export flag changes nothing)', () => {
    const live = setup({ start: 0.25 }, impulse(1));
    live.e.handle({ t: 'play' });
    const a = live.e.renderOffline(SR * 2)[0];
    const ex = setup({ start: 0.25 }, impulse(1), { rendering: true });
    ex.e.handle({ t: 'play' });
    const b = ex.e.renderOffline(SR * 2)[0];
    expect(firstNonZero(a)).toBe(Math.round(0.75 * SR));
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('plays by itself when unlinked and mirrors its own state changes to the project', () => {
    const msgs: FromEngine[] = [];
    const { e, ch } = setup({ link: false, pos: 1, end: 1.5 }, impulse(1.25), { post: (m) => msgs.push(m) });
    // not playing: nothing, whatever the song does
    e.handle({ t: 'play' });
    expect(peak(e.renderOffline(SR)[0])).toBe(0);
    e.handle({ t: 'pause' });
    ch.plugin!.params = { ...ch.plugin!.params, play: 1 };
    e.handle({ t: 'channel', c: ch });
    const [L] = e.renderOffline(SR);
    expect(firstNonZero(L)).toBe(Math.round(0.25 * SR));
    const states = msgs.filter((m): m is Extract<FromEngine, { t: 'fxState' }> => m.t === 'fxState').flatMap((m) => m.items);
    expect(states).toEqual([[`ch:${ch.id}`, 'play', 0], [`ch:${ch.id}`, 'pos', 1.5]]);
  });

  it('keeps its audio when a project is re-created from its JSON state', () => {
    const { ch } = setup({ file: 'v.mp4', start: 1 }, impulse(1));
    const copy = JSON.parse(JSON.stringify(ch));
    copy.plugin.params = normalizeGenParams('videoplayer', copy.plugin.params);
    const e = makeEngine();
    e.handle({ t: 'sample', id: 'vid', data: impulse(2).channels, sampleRate: SR });
    e.handle({ t: 'channel', c: copy });
    const pat = createPattern(1);
    pat.lengthSteps = 512;
    e.handle({ t: 'pattern', p: pat });
    e.handle({ t: 'mode', song: false, patternId: pat.id });
    e.handle({ t: 'play' });
    expect(firstNonZero(e.renderOffline(SR * 2)[0])).toBe(SR);
  });

  /** Song mode with an automation clip driving one of the player's parameters (normalised value `v` from the start). */
  function automated(key: string, min: number, max: number, v: number, params: Record<string, unknown>, smp: Smp) {
    const { e, ch } = setup(params, smp);
    const a: AutomationChannel = {
      id: 'a1', name: key, color: '#888', enabled: true, length: 3840, loop: false, min: 0, max: 1, lfo: defaultLfo(),
      target: { scope: 'channel', id: ch.id, path: `plugin.params.${key}`, min, max, step: 1, label: `Video Player - ${key}` },
      points: [{ pos: 0, value: v, tension: 0, mode: 'single' }, { pos: 3840, value: v, tension: 0, mode: 'single' }],
    };
    const pat = createPattern(1);
    pat.notes[ch.id] = [createNote({ pos: 0, len: 384 })];
    e.handle({ t: 'pattern', p: pat });
    const clips: Clip[] = [
      { id: 'p', track: 0, kind: 'pattern', patternId: pat.id, start: 0, length: 3840, offset: 0, muted: false },
      { id: 'c', track: 1, kind: 'automation', patternId: '', autoId: 'a1', start: 0, length: 3840, offset: 0, muted: false },
    ];
    const tracks = [0, 1].map((i) => ({ id: 't' + i, name: 'T', color: '#485156', height: 1, enabled: true, locked: false }));
    e.handle({ t: 'automation', list: [a], init: [] });
    e.handle({ t: 'playlist', tracks, clips });
    e.handle({ t: 'mode', song: true, patternId: pat.id });
    return e;
  }

  it('Mute audio and Volume are automatable parameters', () => {
    const dc: Smp = { channels: [new Float32Array(48000 * 6).fill(0.5)], sampleRate: SR };
    const run1 = (key: string, v: number) => {
      const e = automated(key, 0, key === 'volume' ? 127 : 1, v, {}, dc);
      e.handle({ t: 'play' });
      return e.renderOffline(8000)[0];
    };
    const open = run1('mute', 0);
    expect(peak(open, 4000)).toBeGreaterThan(0.01);
    expect(peak(run1('mute', 1), 4000)).toBe(0);
    // Volume at half the range: half the level of the file's own
    const half = run1('volume', 64 / 127);
    expect(half[7000] / open[7000]).toBeCloseTo(64 / 127, 3);
    expect(peak(run1('volume', 0), 4000)).toBe(0);
  });

  it('P lay / pause is automatable while the player runs by itself', () => {
    const e = automated('play', 0, 1, 1, { link: false, pos: 1 }, impulse(1.1));
    e.handle({ t: 'play' });
    // the automation switches Play on at the song start: the video starts from pos (1 s) and the impulse is 0.1 s in
    const [L] = e.renderOffline(SR / 2);
    expect(firstNonZero(L)).toBeGreaterThan(SR / 10 - 400);
    expect(firstNonZero(L)).toBeLessThan(SR / 10 + 400);
  });

  it('ignores notes (FL\'s TriggerVoice returns no voice)', () => {
    const { e, ch } = setup({}, impulse(1.5));
    const pat = createPattern(2);
    pat.lengthSteps = 512;
    pat.notes[ch.id] = [createNote({ pos: 0, len: 24, key: 60 }), createNote({ pos: 96, len: 24, key: 72, vel: 128 })];
    e.handle({ t: 'pattern', p: pat });
    e.handle({ t: 'mode', song: false, patternId: pat.id });
    e.handle({ t: 'play' });
    const [L] = e.renderOffline(SR * 2);
    expect(firstNonZero(L)).toBe(Math.round(1.5 * SR));
    expect(peak(L, 0, Math.round(1.5 * SR))).toBe(0);
  });
});

// ------------------------------------------------------------------ worklet safety

describe('Video Player: worklet-safe code', () => {
  it('uses no DOM, timers, network or storage in the model or the engine plugin', () => {
    for (const f of ['src/engine/gen/plugins/videoplayer.ts', 'src/model/gen/plugins/videoplayer.ts']) {
      const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const bad of ['window', 'document', 'setTimeout', 'setInterval', 'fetch(', 'performance', 'localStorage', 'indexedDB', 'structuredClone', 'requestAnimationFrame', 'new Audio', 'AudioContext']) {
        expect(src.includes(bad), `${f} uses ${bad}`).toBe(false);
      }
    }
  });
});
