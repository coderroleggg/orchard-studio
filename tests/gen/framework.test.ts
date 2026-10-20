// Instrument plugin channels in the engine (docs/gen-framework.md): voices per
// note through FL's channel note handling, levels, MISC features, INS, kind /
// plugin switches, automation of instrument parameters, 'events' plugins,
// MIDI Out port input, controller outputs, editor monitors and the export flag.
import { describe, it, expect } from 'vitest';
import {
  SR, makeEngine, play, rms, peak, firstNonZero, genChannel, DcGen, EventGen,
} from './util';
import { velocityGain } from '../../src/model/sampler';
import { channelVolumeToGain } from '../../src/model/scales';
import { createChannel, createMidiOutChannel, createNote, createPattern, createGenChannel } from '../../src/model/defaults';
import { defaultLfo, type AutomationChannel, type AutomationTarget } from '../../src/model/automation';
import { GenChannel } from '../../src/engine/GenChannel';
import { SamplerChannel } from '../../src/engine/Sampler';
import { PITCH_C5, computeLRVol, pitchToHz } from '../../src/engine/gen/levels';
import type { Clip } from '../../src/model/types';
import type { FromEngine } from '../../src/engine/protocol';

const G = channelVolumeToGain(1);
const C = Math.SQRT1_2; // circular pan law at the centre
const last = () => DcGen.all[DcGen.all.length - 1];

describe('voice instruments: one voice per note', () => {
  it('triggers a voice per note at its sample and releases it at the note end', () => {
    const e = makeEngine();
    const ch = genChannel('test-dc');
    const [L, R] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 24, key: 60 }, { pos: 96, len: 48, key: 64, vel: 64 }] }, SR);
    const dc = last();
    expect(dc.voices.length).toBe(2);
    // unity voice x velocity x channel volume, circular pan law at the centre
    expect(L[0]).toBeCloseTo(0.5 * G * C, 6);
    expect(R[0]).toBeCloseTo(0.5 * G * C, 6);
    expect(L[5999]).toBeCloseTo(0.5 * G * C, 6);
    // the note off (6000 samples) releases the voice; this one ends at its release
    expect(L[6000]).toBe(0);
    expect(dc.voices[0].releasedAt).toBe(6000);
    expect(dc.voices[0].killedAt).toBe(6000);
    // second note: beat 2 (24000), velocity 64, key 64
    expect(firstNonZero(L, 6001)).toBe(24000);
    expect(L[24000]).toBeCloseTo(0.5 * G * velocityGain(64) * C, 6);
    const v = dc.voices[1];
    expect(v.key).toBe(64);
    expect(v.velocity).toBe(64);
    expect(v.length).toBe(12000);
    expect(v.initPitch).toBe(PITCH_C5 + 400);
    expect(v.releasedAt).toBe(12000);
  });

  it('gives voices FL-style levels: pitch with the channel pitch knob, panning, volume, Mod X / Y', () => {
    const e = makeEngine();
    const ch = genChannel('test-dc');
    ch.pitch = 0.5; // x range 2 semitones = +100 cents
    ch.pan = -0.5;
    ch.sampler.adjModX = 0.25;
    const [L, R] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 96, key: 62, pan: 96, modY: 192 }] }, 4000);
    const v = last().voices[0];
    expect(v.initPitch).toBe(PITCH_C5 + 200);
    const [, pitch, vol, pan, fcut, fres] = v.levels[1];
    expect(pitch).toBeCloseTo(PITCH_C5 + 300, 9);
    expect(vol).toBeCloseTo(G, 9);
    // note pan +0.5 (96 of 0..128) + channel pan -0.5
    expect(pan).toBeCloseTo(0, 9);
    expect(v.initPan).toBeCloseTo(0.5, 9);
    expect(fcut).toBeCloseTo(0.25, 9);
    expect(fres).toBeCloseTo(0.5, 9);
    // the channel applies the volume and pan law to the unity voice
    const g = { l: 0, r: 0 };
    computeLRVol(pan, vol, g);
    expect(L[100]).toBeCloseTo(0.5 * g.l, 6);
    expect(R[100]).toBeCloseTo(0.5 * g.r, 6);
    expect(pitchToHz(PITCH_C5)).toBeCloseTo(523.2511306, 6); // FL: key 60 plays 523.25 Hz (3x Osc, test host)
    expect(pitchToHz(PITCH_C5 - 300)).toBeCloseTo(440, 9);
  });

  it('root key moves the pitch; "Add to key" moves the key the plugin gets', () => {
    const e = makeEngine();
    const a = genChannel('test-dc');
    a.sampler.rootKey = 62;
    const b = genChannel('test-dc');
    b.sampler.rootKey = 62;
    b.sampler.addToKey = true;
    play(e, [a, b], { [a.id]: [{ pos: 0, len: 24, key: 60 }], [b.id]: [{ pos: 0, len: 24, key: 60 }] }, 2000);
    const [va, vb] = DcGen.all.slice(-2).map((d) => d.voices[0]);
    expect(va.initPitch).toBe(PITCH_C5 - 200);
    expect(vb.initPitch).toBe(PITCH_C5 - 200);
    expect(va.key).toBe(60);
    expect(vb.key).toBe(58);
  });

  it('lets plugins apply their levels themselves (def.levels "plugin")', () => {
    const e = makeEngine();
    const ch = genChannel('test-dc-own');
    ch.pan = 1;
    const [L, R] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 24 }] }, 2000);
    // no channel gain or pan law: the voice's own output passes
    expect(L[50]).toBeCloseTo(0.5, 9);
    expect(R[50]).toBeCloseTo(0.5, 9);
    expect(last().voices[0].levels[1][3]).toBe(1);
  });
});

describe('MISC features on instrument channels', () => {
  it('max polyphony stops the oldest voice (declick fade, then kill)', () => {
    const e = makeEngine();
    const ch = genChannel('test-dc');
    ch.sampler.polyMax = 2;
    const [L] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 96 }, { pos: 4, len: 96 }, { pos: 8, len: 96 }] }, 6000);
    const [v0, v1, v2] = last().voices;
    // the third note (2000) starts the oldest voice's 10 ms fade (480 samples)
    expect(v0.killedAt).toBeGreaterThanOrEqual(2000 + 470);
    expect(v0.killedAt).toBeLessThanOrEqual(2000 + 500);
    expect(v1.killedAt).toBe(-1);
    expect(v2.killedAt).toBe(-1);
    expect(L[3000]).toBeCloseTo(2 * 0.5 * G * C, 6);
  });

  it('mono releases the sounding voice and glides into the new note', () => {
    const e = makeEngine();
    const ch = genChannel('test-dc');
    ch.sampler.mono = true;
    play(e, [ch], { [ch.id]: [{ pos: 0, len: 48, key: 60 }, { pos: 24, len: 48, key: 67 }] }, 16000);
    const [v0, v1] = last().voices;
    expect(v0.releasedAt).toBe(6000);
    // the new voice starts at the old pitch and slides up to its own
    const p0 = v1.levels[0][1];
    expect(p0).toBeLessThan(PITCH_C5 + 50);
    const end = v1.levels[v1.levels.length - 1][1];
    expect(end).toBeCloseTo(PITCH_C5 + 700, 6);
  });

  it('porta glides from the previous note', () => {
    const e = makeEngine();
    const ch = genChannel('test-dc');
    ch.sampler.porta = true;
    play(e, [ch], { [ch.id]: [{ pos: 0, len: 12, key: 60 }, { pos: 48, len: 48, key: 72 }] }, 24000);
    const v1 = last().voices[1];
    expect(v1.levels[0][1]).toBeLessThan(PITCH_C5 + 100);
    expect(v1.levels[v1.levels.length - 1][1]).toBeCloseTo(PITCH_C5 + 1200, 6);
  });

  it('the arpeggiator plays held chords as single voices', () => {
    const e = makeEngine();
    const ch = genChannel('test-dc');
    ch.sampler.arp = { direction: 'up', time: 1, gate: 0.5, range: 1, repeat: 1, chord: 'auto', slide: false };
    play(e, [ch], { [ch.id]: [{ pos: 0, len: 96, key: 60 }, { pos: 0, len: 96, key: 64 }, { pos: 0, len: 96, key: 67 }] }, 24000);
    const keys = last().voices.map((v) => v.key);
    expect(keys.slice(0, 4)).toEqual([60, 64, 67, 60]);
    // gate 50% of a step
    expect(last().voices[0].releasedAt).toBe(3000);
  });

  it('echo delay adds voices with cumulative pitch and decaying volume', () => {
    const e = makeEngine();
    const ch = genChannel('test-dc');
    ch.sampler.echo = { feed: 0.25, pan: 0, cut: 0.1, res: 0, pitch: 100, time: 1, count: 2, pingPong: false, fat: false };
    const [L] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 6 }] }, 16000);
    const vs = last().voices;
    expect(vs.map((v) => v.initPitch)).toEqual([PITCH_C5, PITCH_C5 + 100, PITCH_C5 + 200]);
    expect(vs[1].levels[0][2]).toBeCloseTo(G * 0.5, 9);
    expect(vs[2].levels[0][2]).toBeCloseTo(G * 0.25, 9);
    expect(vs[2].levels[0][4]).toBeCloseTo(0.2, 9);
    expect(L[6000]).toBeCloseTo(0.5 * G * 0.5 * C, 6);
  });

  it('cut groups release the cut channel\'s voices; key range drops notes outside it', () => {
    const e = makeEngine();
    const open = genChannel('test-dc');
    open.sampler.cutBy = 1;
    open.sampler.keyLo = 50;
    open.sampler.keyHi = 70;
    const closed = genChannel('test-dc');
    closed.sampler.cutGroup = 1;
    closed.volume = 0;
    play(e, [open, closed], { [open.id]: [{ pos: 0, len: 384 }, { pos: 0, len: 384, key: 80 }], [closed.id]: [{ pos: 24, len: 0 }] }, 10000);
    const vs = DcGen.all[DcGen.all.length - 2].voices;
    expect(vs.length).toBe(1); // key 80 is outside the key range
    expect(vs[0].releasedAt).toBe(6000);
  });

  it('time shift delays every note', () => {
    const e = makeEngine();
    const ch = genChannel('test-dc');
    ch.sampler.shift = 0.5;
    const [L] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 24 }] }, 6000);
    expect(firstNonZero(L)).toBe(3000);
  });
});

describe('INS tab on instrument channels', () => {
  it('shapes voices of INS plugins with the volume envelope; other plugins ignore the INS settings', () => {
    const e = makeEngine();
    const ins = genChannel('test-dc-ins');
    const plain = genChannel('test-dc', 1);
    for (const c of [ins, plain]) {
      const env = c.sampler.envlfo.vol.env;
      env.enabled = true;
      env.attack = 0.3; // a slow attack
    }
    const [L] = play(e, [ins], { [ins.id]: [{ pos: 0, len: 96 }] }, 4000);
    expect(Math.abs(L[100])).toBeLessThan(0.5 * G * C * 0.2);
    expect(Math.abs(L[3500])).toBeGreaterThan(Math.abs(L[100]));
    const e2 = makeEngine();
    const [L2] = play(e2, [plain], { [plain.id]: [{ pos: 0, len: 96 }] }, 4000);
    expect(L2[100]).toBeCloseTo(0.5 * G * C, 6);
  });

  it('applies the INS filter and envelope release to INS plugin voices', () => {
    const e = makeEngine();
    const ch = genChannel('test-dc-ins');
    ch.sampler.envlfo.vol.env.enabled = true;
    ch.sampler.envlfo.vol.env.attack = 0; // a step: the high-pass lets its transient through
    ch.sampler.envlfo.vol.env.release = 0.1;
    ch.sampler.filterType = 'hp';
    ch.sampler.modX = 0.5;
    const [L] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 24 }] }, 24000);
    // a high-pass removes the DC voice after its transient
    expect(Math.abs(L[5000])).toBeLessThan(1e-3);
    expect(peak(L, 0, 500)).toBeGreaterThan(0.01);
    // with the INS volume envelope on, its release is the voice's: the plugin voice is not
    // released and sounds until the envelope's release (~19 ms) ends
    const v = last().voices[0];
    expect(v.releasedAt).toBe(-1);
    expect(v.killedAt).toBeGreaterThan(6000 + 800);
    expect(v.killedAt).toBeLessThan(6000 + 1100);
  });
});

describe('channel kind and plugin switches', () => {
  it('creates the right engine for each kind and switches cleanly', () => {
    const e = makeEngine();
    const smp = new Float32Array(48000).fill(0.25);
    e.handle({ t: 'sample', id: 's', data: [smp], sampleRate: SR });
    const ch = createChannel('X', 's');
    ch.volume = 1;
    e.handle({ t: 'channel', c: ch });
    expect(e.channels.get(ch.id)).toBeInstanceOf(SamplerChannel);
    // sampler -> instrument
    const asGen = { ...ch, kind: 'plugin' as const, plugin: { id: 'test-dc', params: { level: 0.5, releaseFrames: 0 } } };
    e.handle({ t: 'channel', c: asGen });
    const g1 = e.channels.get(ch.id);
    expect(g1).toBeInstanceOf(GenChannel);
    expect((g1 as GenChannel).plugin).toBe('test-dc');
    e.handle({ t: 'noteOn', ch: ch.id, key: 60, vel: 100, tag: 1 });
    const [L1] = e.renderOffline(512);
    expect(L1[10]).toBeCloseTo(0.5 * G * C, 6);
    // another plugin: a new engine; the old voice fades out within 50 ms
    const other = { ...asGen, plugin: { id: 'test-dc-ins', params: { level: 0.25, releaseFrames: 0 } } };
    e.handle({ t: 'channel', c: other });
    const g2 = e.channels.get(ch.id) as GenChannel;
    expect(g2).not.toBe(g1);
    expect(g2.plugin).toBe('test-dc-ins');
    const [L2] = e.renderOffline(4800);
    expect(Math.abs(L2[4000])).toBeLessThan(1e-9);
    // instrument -> MIDI Out -> sampler
    e.handle({ t: 'channel', c: { ...createMidiOutChannel('M'), id: ch.id } });
    expect(e.channels.has(ch.id)).toBe(false);
    expect(e.midiOuts.has(ch.id)).toBe(true);
    e.handle({ t: 'channel', c: ch });
    expect(e.channels.get(ch.id)).toBeInstanceOf(SamplerChannel);
    expect(e.midiOuts.has(ch.id)).toBe(false);
  });

  it('an unknown plugin id gives a silent channel', () => {
    const e = makeEngine();
    const ch = createGenChannel('no-such-plugin');
    const [L] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 24 }] }, 2000);
    expect(peak(L)).toBe(0);
    expect(e.channels.get(ch.id)).toBeInstanceOf(GenChannel);
  });
});

describe('instrument parameters in automation', () => {
  it('automation clips drive plugin.params.<key> through the channel scope', () => {
    const e = makeEngine();
    const ch = genChannel('test-dc');
    e.handle({ t: 'channel', c: ch });
    const target: AutomationTarget = { scope: 'channel', id: ch.id, path: 'plugin.params.level', min: 0, max: 1, label: 'Test DC - Level' };
    const a: AutomationChannel = {
      id: 'a1', name: 'Level', color: '#888', enabled: true, target, length: 384, loop: false, min: 0, max: 1, lfo: defaultLfo(),
      points: [{ pos: 0, value: 0.2, tension: 0, mode: 'single' }, { pos: 384, value: 0.2, tension: 0, mode: 'single' }],
    };
    const pat = createPattern(1);
    pat.notes[ch.id] = [createNote({ pos: 0, len: 384 })];
    e.handle({ t: 'pattern', p: pat });
    const clips: Clip[] = [
      { id: 'p', track: 0, kind: 'pattern', patternId: pat.id, start: 0, length: 384, offset: 0, muted: false },
      { id: 'c', track: 1, kind: 'automation', patternId: '', autoId: 'a1', start: 0, length: 384, offset: 0, muted: false },
    ];
    const tracks = [0, 1].map((i) => ({ id: 't' + i, name: 'T', color: '#485156', height: 1, enabled: true, locked: false }));
    e.handle({ t: 'automation', list: [a], init: [] });
    e.handle({ t: 'playlist', tracks, clips });
    e.handle({ t: 'mode', song: true, patternId: pat.id });
    e.handle({ t: 'play' });
    const [L] = e.renderOffline(4000);
    const dc = last();
    expect(dc.params.level).toBeCloseTo(0.2, 9);
    expect(L[2000]).toBeCloseTo(0.2 * G * C, 6);
  });
});

describe("'events' instruments", () => {
  it('get note on / off events at their samples and render all their voices', () => {
    const e = makeEngine();
    const ch = genChannel('test-ev', 3);
    play(e, [ch], { [ch.id]: [{ pos: 0, len: 24, key: 60 }, { pos: 50, len: 10, key: 64, vel: 90 }] }, 16000);
    const ev = EventGen.all[EventGen.all.length - 1];
    expect(ev.events).toEqual([
      ['on', 60, 0, 100],
      ['off', 60, 6000, 0],
      ['on', 64, 12500, 90],
      ['off', 64, 15000, 0],
    ]);
    expect(ev.ctxs[0].track).toBe(3);
    expect(ev.ctxs[0].playing).toBe(true);
  });

  it('max polyphony and panic kill notes', () => {
    const e = makeEngine();
    const ch = genChannel('test-ev');
    ch.sampler.polyMax = 1;
    play(e, [ch], { [ch.id]: [{ pos: 0, len: 96, key: 60 }, { pos: 24, len: 96, key: 62 }] }, 9000);
    const ev = EventGen.all[EventGen.all.length - 1];
    expect(ev.events.filter((x) => x[0] === 'kill').map((x) => x[1])).toEqual([60]);
    e.handle({ t: 'allNotesOff' });
    e.renderOffline(256);
    expect(ev.events.filter((x) => x[0] === 'kill').map((x) => x[1])).toEqual([60, 62]);
  });
});

describe('note inputs', () => {
  it('live notes play instrument channels', () => {
    const e = makeEngine();
    const ch = genChannel('test-dc');
    e.handle({ t: 'channel', c: ch });
    e.renderOffline(256);
    e.handle({ t: 'noteOn', ch: ch.id, key: 65, vel: 100, tag: 9 });
    const [L] = e.renderOffline(256);
    e.handle({ t: 'noteOff', ch: ch.id, key: 65, tag: 9 });
    const [L2] = e.renderOffline(256);
    expect(L[0]).toBeCloseTo(0.5 * G * C, 6);
    expect(peak(L2)).toBe(0);
    expect(last().voices[0].key).toBe(65);
  });

  it('MIDI Out notes on the instrument\'s MIDI input port play it, sample-accurately', () => {
    const e = makeEngine();
    const ch = genChannel('test-dc');
    ch.plugin!.midiPort = 5;
    const mo = createMidiOutChannel('MIDI Out');
    mo.midiOut!.port = 5;
    const [L] = play(e, [ch, mo], { [mo.id]: [{ pos: 50, len: 10, key: 70 }] }, 16000);
    expect(firstNonZero(L)).toBe(12500);
    expect(L[14999]).not.toBe(0);
    expect(L[15000]).toBe(0);
    expect(last().voices[0].key).toBe(70);
  });
});

describe('controller outputs, monitors, export flag', () => {
  it('instrument controller outputs drive Link to controller targets ("ch:<id>" sources)', () => {
    const e = makeEngine();
    const ctl = genChannel('test-genctl');
    ctl.plugin!.params.v = 0.75;
    e.handle({ t: 'channel', c: ctl });
    const tone = genChannel('test-dc');
    e.handle({ t: 'channel', c: tone });
    e.handle({ t: 'links', list: [{ id: 'l1', target: { scope: 'channel', id: tone.id, path: 'volume', min: 0, max: 1, label: 'Vol' }, source: { slotId: 'ch:' + ctl.id, output: 0 }, formula: 'Input' }] });
    e.renderOffline(512);
    expect(e.linkCurrent.get(`channel:${tone.id}:volume`)).toBeCloseTo(0.75, 9);
  });

  it('posts editor monitor data for "ch:<id>" watchers and passes the export flag', () => {
    const posted: FromEngine[] = [];
    const e = makeEngine({ rendering: true, post: (m) => posted.push(m) });
    const ch = genChannel('test-ev');
    play(e, [ch], { [ch.id]: [{ pos: 0, len: 24 }] }, 512);
    const ev = EventGen.all[EventGen.all.length - 1];
    expect(ev.ctxs[0].rendering).toBe(true);
    // a monitor for the instrument
    const g = e.channels.get(ch.id) as GenChannel;
    (g.inst as EventGen & { monitor?: () => Record<string, number> }).monitor = () => ({ held: 1 });
    e.handle({ t: 'watchFx', ids: ['ch:' + ch.id] });
    e.renderOffline(SR / 10);
    const items = posted.filter((m) => m.t === 'fxMonitor').flatMap((m) => (m as { items: [string, Record<string, unknown>][] }).items);
    expect(items.some(([id, d]) => id === 'ch:' + ch.id && d.held === 1 && d.__active === true)).toBe(true);
  });

  it('stays finite and quiet without notes', () => {
    const e = makeEngine();
    const ch = genChannel('test-dc');
    e.handle({ t: 'channel', c: ch });
    const [L, R] = e.renderOffline(4096);
    expect(rms(L)).toBe(0);
    expect(rms(R)).toBe(0);
    expect(e.channels.get(ch.id)!.isActive()).toBe(false);
  });
});
