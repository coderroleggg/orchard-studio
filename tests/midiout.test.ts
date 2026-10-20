// MIDI Out channels: their notes reach the effects listening on their MIDI
// port, sample-accurately, and nothing else (FL: MIDI Out + a plugin's MIDI
// input port).

import { describe, it, expect } from 'vitest';
import { Engine } from '../src/engine/Engine';
import { registerEffect } from '../src/engine/effects';
import type { EffectInstance } from '../src/engine/effects/types';
import {
  createChannel, createMidiOutChannel, createMixerTrack, createNote, createPattern, createDefaultProject, normalizeProject, createFxSlot,
} from '../src/model/defaults';
import { defaultMidiOut, normalizeMidiOut, MO_NOTE } from '../src/model/midiout';
import type { Channel, MixerTrack, Pattern, Project } from '../src/model/types';

const SR = 48000;
// 120 BPM, PPQ 96: 250 samples per tick, a step (24 ticks) = 6000 samples

type Ev = [string, number, number, number]; // kind, key, absolute frame, port

/** A test effect that records the note events it gets with their absolute frame. */
class Recorder implements EffectInstance {
  static all: Recorder[] = [];
  events: Ev[] = [];
  /** Frames processed so far = the absolute frame of the block being delivered. */
  t = 0;
  port = -1;
  own: number[] = [];
  constructor() { Recorder.all.push(this); }
  setParams(p: unknown): void { const q = p as { own?: number[] }; this.own = Array.isArray(q?.own) ? q.own : []; }
  process(_L: Float32Array, _R: Float32Array, n: number): void { this.t += n; }
  reset(): void {}
  noteOn(key: number, _vel: number, offset: number, port: number): void { this.events.push(['on', key, this.t + offset, port]); }
  noteOff(key: number, offset: number, port: number): void { this.events.push(['off', key, this.t + offset, port]); }
  midiPorts(): number[] { return this.own; }
  setMidiPort(p: number): void { this.port = p; }
  allNotesOff?(): void;
  tail = Infinity; // always processed, so `t` follows the engine's frames
}
registerEffect({ id: 'test-midi-rec', create: () => new Recorder() });

function track(index: number, slots: { port?: number; own?: number[]; enabled?: boolean }[]): MixerTrack {
  const t = createMixerTrack(index);
  slots.forEach((s, k) => {
    const sl = createFxSlot('peq2');
    t.slots[k] = { ...sl, plugin: 'test-midi-rec', name: 'Rec', params: { own: s.own ?? [] }, enabled: s.enabled ?? true, ...(s.port !== undefined ? { midiPort: s.port } : {}) };
  });
  return t;
}

function setup(port: number, notes: { pos: number; len: number; key: number; vel?: number }[], tracks: MixerTrack[]) {
  Recorder.all = [];
  const e = new Engine({ sampleRate: SR, blockSize: 128 });
  e.handle({ t: 'globals', g: { tempo: 120, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } });
  for (let i = 0; i < 127; i++) e.handle({ t: 'mixerTrack', tr: tracks.find((t) => t.index === i) ?? createMixerTrack(i) });
  const ch = createMidiOutChannel('MIDI Out');
  ch.midiOut!.port = port;
  e.handle({ t: 'channel', c: ch });
  const pat: Pattern = createPattern(1);
  pat.notes[ch.id] = notes.map((n) => createNote(n));
  e.handle({ t: 'pattern', p: pat });
  e.handle({ t: 'mode', song: false, patternId: pat.id });
  return { e, ch, pat };
}

const sorted = (ev: Ev[]) => [...ev].sort((a, b) => a[2] - b[2] || (a[0] === b[0] ? a[1] - b[1] : a[0] === 'off' ? -1 : 1));

describe('MIDI Out channels', () => {
  it('sends pattern notes to the effects on its port, sample-accurately, and not to other ports', () => {
    const { e } = setup(3, [
      { pos: 0, len: 48, key: 60 },
      { pos: 24, len: 0, key: 62 }, // a step: one step long
      { pos: 50, len: 10, key: 64 }, // 12500 samples: inside block 97 (offset 84)
    ], [track(1, [{ port: 3 }, { port: 4 }])]);
    e.handle({ t: 'play' });
    e.renderOffline(16000);
    const [on3, on4] = Recorder.all;
    expect(sorted(on3.events)).toEqual([
      ['on', 60, 0, 3],
      ['on', 62, 6000, 3],
      ['off', 60, 12000, 3],
      ['off', 62, 12000, 3],
      ['on', 64, 12500, 3],
      ['off', 64, 15000, 3],
    ]);
    expect(on4.events).toEqual([]);
    // the slot's port reaches the plugin
    expect(on3.port).toBe(3);
    expect(on4.port).toBe(4);
  });

  it('delivers to every slot listening on the port, on any track, and to plugins listening by themselves', () => {
    const { e } = setup(7, [{ pos: 96, len: 24, key: 72 }], [
      track(2, [{ port: 7 }]),
      track(5, [{ own: [7] }, { own: [8] }]),
    ]);
    e.handle({ t: 'play' });
    e.renderOffline(SR);
    const [a, b, c] = Recorder.all;
    const want: Ev[] = [['on', 72, 24000, 7], ['off', 72, 30000, 7]];
    expect(a.events).toEqual(want);
    expect(b.events).toEqual(want);
    expect(c.events).toEqual([]);
  });

  it('plays live notes (typing keyboard / preview) while stopped, and muting the channel releases them', () => {
    const { e, ch } = setup(0, [], [track(1, [{ port: 0 }])]);
    e.renderOffline(1280);
    e.handle({ t: 'noteOn', ch: ch.id, key: 65, vel: 90, tag: 1 });
    e.renderOffline(256);
    e.handle({ t: 'noteOff', ch: ch.id, key: 65, tag: 1 });
    e.renderOffline(256);
    e.handle({ t: 'noteOn', ch: ch.id, key: 67, vel: 90, tag: 2 });
    e.renderOffline(128);
    // muting the channel releases its notes
    e.handle({ t: 'channel', c: { ...ch, enabled: false } });
    e.renderOffline(128);
    const [r] = Recorder.all;
    expect(r.events).toEqual([['on', 65, 1280, 0], ['off', 65, 1536, 0], ['on', 67, 1792, 0], ['off', 67, 1920, 0]]);
    // panic: the plugins forget their notes (allNotesOff) and no stale note offs follow
    let panics = 0;
    r.allNotesOff = () => { panics++; };
    e.handle({ t: 'channel', c: ch });
    e.handle({ t: 'noteOn', ch: ch.id, key: 69, vel: 90, tag: 3 });
    e.renderOffline(128);
    e.handle({ t: 'allNotesOff' });
    e.renderOffline(256);
    expect(panics).toBe(1);
    expect(r.events.slice(4)).toEqual([['on', 69, 2048, 0]]);
  });

  it('a stopped transport and removed channel release held notes; a muted channel sends nothing', () => {
    const { e, ch, pat } = setup(1, [{ pos: 0, len: 384, key: 50 }], [track(1, [{ port: 1 }])]);
    e.handle({ t: 'play' });
    e.renderOffline(1000);
    e.handle({ t: 'stop' });
    e.renderOffline(256);
    const [r] = Recorder.all;
    // the transport stops after 1000 frames: the note off comes at the start of the next block
    expect(r.events).toEqual([['on', 50, 0, 1], ['off', 50, 1000, 1]]);
    r.events = [];
    e.handle({ t: 'channel', c: { ...ch, enabled: false } });
    e.handle({ t: 'pattern', p: pat });
    e.handle({ t: 'play' });
    e.renderOffline(2000);
    expect(r.events).toEqual([]);
    e.handle({ t: 'channel', c: ch });
    e.handle({ t: 'stop' });
    e.handle({ t: 'play' });
    e.renderOffline(512);
    e.handle({ t: 'channelRemove', id: ch.id });
    e.renderOffline(256);
    expect(r.events.map((x) => x[0])).toEqual(['on', 'off']);
  });

  it('brings a bypassed slot up to date when it runs again, and follows port changes', () => {
    const t = track(1, [{ port: 2, enabled: false }]);
    const { e, ch } = setup(2, [], [t]);
    e.handle({ t: 'noteOn', ch: ch.id, key: 60, vel: 100, tag: 1 });
    e.renderOffline(256);
    const [r] = Recorder.all;
    expect(r.events).toEqual([]);
    // enabled again: the held note arrives at the start of the first block it runs
    // (the recorder counts the frames it processed: 0 so far)
    const t2: MixerTrack = { ...t, slots: t.slots.map((s) => (s ? { ...s, enabled: true } : s)) };
    e.handle({ t: 'mixerTrack', tr: t2 });
    e.renderOffline(128);
    expect(r.events).toEqual([['on', 60, 0, 2]]);
    // the slot moves to another port: the note of the old port is released
    const t3: MixerTrack = { ...t2, slots: t2.slots.map((s) => (s ? { ...s, midiPort: 9 } : s)) };
    e.handle({ t: 'mixerTrack', tr: t3 });
    e.renderOffline(128);
    expect(r.events).toEqual([['on', 60, 0, 2], ['off', 60, 128, 2]]);
    expect(r.port).toBe(9);
  });

  it('plays "Note" type controller knobs', () => {
    const { e, ch } = setup(4, [], [track(1, [{ port: 4 }])]);
    const mo = ch.midiOut!;
    mo.controls[0] = { ...mo.controls[0], ctrl: 100, type: MO_NOTE, active: true, min: 0, max: 127, noteOff: 0 };
    e.handle({ t: 'channel', c: ch });
    e.renderOffline(128);
    e.handle({ t: 'channel', c: { ...ch, midiOut: { ...mo, values: [60, ...mo.values.slice(1)] } } });
    e.renderOffline(128);
    e.handle({ t: 'channel', c: { ...ch, midiOut: { ...mo, values: [0, ...mo.values.slice(1)] } } });
    e.renderOffline(128);
    const [r] = Recorder.all;
    expect(r.events).toEqual([['on', 60, 128, 4], ['off', 60, 256, 4]]);
  });

  it('delays notes like the audio of a track whose input waits for delay compensation', () => {
    registerEffect({ id: 'test-midi-lat', create: () => ({ latency: 100, tail: Infinity, setParams() {}, reset() {}, process() {} } as EffectInstance) });
    const t2 = createMixerTrack(2);
    t2.slots[0] = { ...createFxSlot('peq2'), plugin: 'test-midi-lat', name: 'Latency', params: {} };
    t2.sends = { 3: 0.8 };
    const t3 = track(3, [{ port: 6 }]);
    const { e } = setup(6, [{ pos: 2, len: 4, key: 60 }], [t2, t3]);
    e.handle({ t: 'play' });
    e.renderOffline(4000);
    const [r] = Recorder.all;
    // track 3's input arrives 100 samples late (track 2's latency): so do its notes
    expect(r.events).toEqual([['on', 60, 500 + 100, 6], ['off', 60, 1500 + 100, 6]]);
  });

  it('mirrors what plugins change by themselves (Gross Beat\'s slot from a note) to the host and its own copy', () => {
    const msgs: unknown[] = [];
    const e = new Engine({ sampleRate: SR, blockSize: 128, post: (m) => msgs.push(m) });
    e.handle({ t: 'globals', g: { tempo: 120, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } });
    const tr = createMixerTrack(1);
    const gb = { ...createFxSlot('grossbeat'), midiPort: 2 };
    tr.slots[0] = gb;
    for (let i = 0; i < 127; i++) e.handle({ t: 'mixerTrack', tr: i === 1 ? tr : createMixerTrack(i) });
    const ch = createMidiOutChannel();
    ch.midiOut!.port = 2;
    e.handle({ t: 'channel', c: ch });
    e.handle({ t: 'noteOn', ch: ch.id, key: 61, vel: 100, tag: 1 }); // C#5: time slot 2
    e.renderOffline(2000);
    const st = msgs.find((m) => (m as { t: string }).t === 'fxState') as { items: [string, string, unknown][] } | undefined;
    expect(st?.items).toEqual([[gb.id, 'tslot', 1]]);
    expect((tr.slots[0]!.params as Record<string, unknown>).tslot).toBe(1);
  });

  it('keeps samplers making sound alongside', () => {
    const { e } = setup(3, [{ pos: 0, len: 24, key: 60 }], [track(1, [{ port: 3 }])]);
    const smp = new Float32Array(100); smp[0] = 1;
    e.handle({ t: 'sample', id: 'imp', data: [smp], sampleRate: SR });
    const s: Channel = createChannel('Kick', 'imp');
    e.handle({ t: 'channel', c: s });
    const pat = createPattern(2);
    pat.notes[s.id] = [createNote({ pos: 0, len: 24 })];
    e.handle({ t: 'pattern', p: pat });
    e.handle({ t: 'mode', song: false, patternId: pat.id });
    e.handle({ t: 'play' });
    const [L] = e.renderOffline(256);
    expect(Math.abs(L[0])).toBeGreaterThan(0.1);
  });
});

describe('MIDI Out data', () => {
  it('normalizes old projects: every channel is a sampler, slots get no MIDI port', () => {
    const p = createDefaultProject({}, {});
    const old = JSON.parse(JSON.stringify(p)) as Project;
    for (const c of old.channels) delete (c as Partial<Channel>).kind;
    old.mixer.tracks[1].slots[0] = { ...createFxSlot('peq2') };
    const n = normalizeProject(old);
    expect(n.channels.every((c) => c.kind === 'sampler' && c.midiOut === undefined)).toBe(true);
    expect(n.mixer.tracks[1].slots[0]?.midiPort).toBeUndefined();
  });

  it('saves and reloads MIDI Out channels and slot ports', () => {
    const p = createDefaultProject({}, {});
    const mo = createMidiOutChannel('Synth port');
    mo.midiOut!.port = 12;
    mo.midiOut!.channel = 5;
    mo.midiOut!.pageNames[2] = 'Filter Bank';
    mo.midiOut!.controls[3] = { ...mo.midiOut!.controls[3], name: 'Cutoff', ctrl: 74, active: true };
    p.channels.push(mo);
    p.mixer.tracks[3].slots[0] = { ...createFxSlot('peq2'), midiPort: 12 };
    const saved = JSON.parse(JSON.stringify(p)) as Project;
    const n = normalizeProject(saved);
    const c = n.channels.find((x) => x.id === mo.id)!;
    expect(c.kind).toBe('midiout');
    expect(c.midiOut).toEqual(mo.midiOut);
    expect(n.mixer.tracks[3].slots[0]?.midiPort).toBe(12);
  });

  it('repairs stored MIDI Out settings', () => {
    const d = defaultMidiOut();
    expect(normalizeMidiOut(undefined)).toEqual(d);
    const r = normalizeMidiOut({ port: 300, channel: 0, values: [200, -5], controls: [{ ctrl: 999, type: 9 }] });
    expect(r.port).toBe(255);
    expect(r.channel).toBe(1);
    expect(r.values.slice(0, 2)).toEqual([127, 0]);
    expect(r.controls[0].ctrl).toBe(127);
    expect(r.controls[0].type).toBe(4);
    expect(r.values.length).toBe(72);
    // a slot port out of range is repaired
    const p = createDefaultProject({}, {});
    p.mixer.tracks[1].slots[0] = { ...createFxSlot('peq2'), midiPort: 999 };
    p.mixer.tracks[1].slots[1] = { ...createFxSlot('peq2'), midiPort: -3 };
    const n = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(n.mixer.tracks[1].slots[0]?.midiPort).toBe(255);
    expect(n.mixer.tracks[1].slots[1]?.midiPort).toBeUndefined();
  });
});
