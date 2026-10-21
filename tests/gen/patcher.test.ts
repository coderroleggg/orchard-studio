// Patcher as an instrument (docs/research/gen/patcher.md): registration and default state, generators
// hosted in the patch playing exactly like the same generator on a channel of its own, effects after
// them, note routing (VFX modules, MIDI Out ports), hosted ids / automation / editors in the store,
// and save / load.
import { describe, it, expect } from 'vitest';
import { SR, makeEngine, play, rms, peak, firstNonZero, genChannel, DcGen, EventGen, type VoiceLog } from './util';
import { registerEffect } from '../../src/engine/effects';
import type { EffectInstance } from '../../src/engine/effects/types';
import { defaultFxParams } from '../../src/model/fx/registry';
import { defaultGenParams, genDef, genInCategory, normalizeGenParams } from '../../src/model/gen/registry';
import {
  GRAPH_KEY, IN, OUT, addModule, connect, defaultGraph, isGenModule, nodePorts, normalizeGraph, shownOuts,
  type PatcherGraph,
} from '../../src/model/fx/plugins/patcher';
import type { Channel } from '../../src/model/types';
import { createMidiOutChannel, createNote, createPattern } from '../../src/model/defaults';
import { velocityGain } from '../../src/model/sampler';
import { GenChannel } from '../../src/engine/GenChannel';

// a pure gain effect for the modules after the generators
registerEffect({
  id: 'pg-gain', create: () => {
    let g = 1;
    return {
      setParams(p: unknown) { g = Number((p as { g?: number }).g ?? 1); }, reset() {},
      process(L: Float32Array, R: Float32Array, n: number) { for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; } },
    } as EffectInstance;
  },
});

/** A Patcher channel whose patch `build` fills in (the channel starts from the instrument's default state). */
function patcherChannel(build: (g: PatcherGraph) => void, mixerTrack = 0): Channel {
  const c = genChannel('patcher', mixerTrack);
  const g = c.plugin!.params[GRAPH_KEY] as PatcherGraph;
  build(g);
  return c;
}

/** Notes -> a hosted generator -> To FL Studio. */
function oneGen(plugin: string, state: Record<string, unknown> = {}): (g: PatcherGraph) => void {
  return (g) => {
    const m = addModule(g, plugin, { ...defaultGenParams(plugin), ...state }, 300, 200, plugin, true);
    connect(g, 'events', IN, 0, m.id, 0);
    connect(g, 'audio', m.id, 0, OUT, 0);
  };
}

const velocityRatio = (a: number, b: number) => velocityGain(a) / velocityGain(b);

const maxDiff = (a: Float32Array, b: Float32Array) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

function sameVoices(a: VoiceLog[], b: VoiceLog[]): void {
  expect(b.length).toBe(a.length);
  for (let i = 0; i < a.length; i++) {
    const { levels: la, ...ra } = a[i];
    const { levels: lb, ...rb } = b[i];
    expect(rb).toEqual(ra);
    expect(lb.length).toBe(la.length);
    for (let k = 0; k < la.length; k++) for (let j = 0; j < 6; j++) expect(lb[k][j]).toBeCloseTo(la[k][j], 9);
  }
}

describe('Patcher instrument: registration and default state', () => {
  it('is a Patcher-folder generator with the effect\'s form size and the events interface', () => {
    const d = genDef('patcher')!;
    expect(d.name).toBe('Patcher');
    expect(d.category).toBe('Patcher');
    expect(d.notes).toBe('events');
    expect([d.width, d.height]).toEqual([1001, 591]);
    expect(genInCategory('Patcher').map((x) => x.id)).toContain('patcher');
  });

  it('starts as FL\'s generator Default: no audio input, no link, no module', () => {
    const g = defaultGenParams('patcher')[GRAPH_KEY] as PatcherGraph;
    expect(g.gen).toBe(true);
    expect(g.links).toEqual([]);
    expect(Object.keys(g.modules)).toHaveLength(0);
    expect(nodePorts(g, IN)).toEqual({ audioIn: 0, audioOut: 0, eventsIn: 0, eventsOut: 257 });
    expect(shownOuts(g, IN, 'audio')).toEqual([]);
    expect(shownOuts(g, IN, 'events')).toEqual([0]);
    expect(nodePorts(g, OUT)!.audioIn).toBe(1);
    // the effect keeps its audio link from input to output
    const fx = defaultGraph();
    expect(fx.gen).toBeUndefined();
    expect(fx.links).toHaveLength(1);
    expect(nodePorts(fx, IN)!.audioOut).toBe(1);
  });

  it('is silent until a generator is linked, and normalises damaged states into the instrument default', () => {
    const e = makeEngine();
    const c = genChannel('patcher');
    const [L, R] = play(e, [c], { [c.id]: [{ pos: 0, len: 24, key: 60 }] }, 4000);
    expect(peak(L)).toBe(0);
    expect(peak(R)).toBe(0);
    const n = normalizeGenParams('patcher', { [GRAPH_KEY]: 'garbage' })[GRAPH_KEY] as PatcherGraph;
    expect(n.gen).toBe(true);
    expect(n.links).toEqual([]);
    const m = normalizeGenParams('patcher', { [GRAPH_KEY]: { modules: { g5: { plugin: 'test-dc' }, m6: { plugin: 'pg-gain' } }, links: [{ kind: 'events', from: 'in', to: 'g5' }, { kind: 'audio', from: 'in', to: 'm6' }] } })[GRAPH_KEY] as PatcherGraph;
    expect(Object.keys(m.modules).sort()).toEqual(['g5', 'm6']);
    expect(m.next).toBeGreaterThan(6);
    // From FL Studio has no audio output in the instrument: that link is dropped
    expect(m.links.map((l) => l.kind)).toEqual(['events']);
  });

  it('tells generator modules from effects by their ids', () => {
    const g = defaultGraph(true);
    const a = addModule(g, 'test-dc', {}, 0, 0, 'A', true);
    const b = addModule(g, 'pg-gain', {}, 0, 0, 'B');
    expect(isGenModule(a.id)).toBe(true);
    expect(isGenModule(b.id)).toBe(false);
    expect(nodePorts(g, a.id)).toEqual({ audioIn: 0, audioOut: 1, eventsIn: 1, eventsOut: 0 });
    expect(nodePorts(g, b.id)!.audioIn).toBe(1);
    expect(connect(g, 'audio', IN, 0, b.id, 0)).toBeNull();
    expect(connect(g, 'events', IN, 0, a.id, 0)).not.toBeNull();
    expect(connect(g, 'events', IN, 0, b.id, 0)).toBeNull(); // pg-gain takes no notes
  });
});

describe('Patcher instrument: a hosted generator sounds like a channel of its own', () => {
  const notes = [
    { pos: 0, len: 24, key: 60 },
    { pos: 96, len: 48, key: 64, vel: 64, pan: 96 },
    { pos: 192, len: 12, key: 67, vel: 120, modX: 200, modY: 40 },
    { pos: 240, len: 36, key: 62, vel: 90, fine: 130 },
  ];

  const settings = (c: Channel) => {
    c.volume = 0.6; c.pan = -0.3; c.pitch = 0.25; c.sampler.adjModX = 0.2; c.sampler.rootKey = 61;
    return c;
  };

  it('plays the same voices with the same levels and the same audio (voices instrument)', () => {
    const e1 = makeEngine();
    const a = settings(genChannel('test-dc'));
    DcGen.all.length = 0;
    const [L1, R1] = play(e1, [a], { [a.id]: notes }, 2 * SR);
    const base = DcGen.all[0].voices;
    expect(base).toHaveLength(4);

    const e2 = makeEngine();
    const p = settings(patcherChannel(oneGen('test-dc')));
    DcGen.all.length = 0;
    const [L2, R2] = play(e2, [p], { [p.id]: notes }, 2 * SR);
    expect(DcGen.all).toHaveLength(1);
    sameVoices(base, DcGen.all[0].voices);
    expect(maxDiff(L1, L2)).toBeLessThan(1e-7);
    expect(maxDiff(R1, R2)).toBeLessThan(1e-7);
    expect(peak(L2)).toBeGreaterThan(0.1);
  });

  it('plays real instruments exactly like their own channels (bit for bit; INS tab at its defaults for legacy generators)', () => {
    // deterministic instruments: voices (3x Osc, DX10, Sytrus, Harmor, PoiZone, BassDrum) and 'events' ones (Drumpad)
    for (const plugin of ['3xosc', 'dx10', 'sytrus', 'harmor', 'poizone', 'bassdrum', 'drumpad']) {
      const notes = [{ pos: 0, len: 48, key: 60 }, { pos: 0, len: 48, key: 36 }, { pos: 72, len: 24, key: 64, vel: 110, pan: 90 }];
      const e1 = makeEngine();
      const a = genChannel(plugin);
      const [L1, R1] = play(e1, [a], { [a.id]: notes }, 2 * SR);
      const e2 = makeEngine();
      const p = patcherChannel(oneGen(plugin));
      const [L2, R2] = play(e2, [p], { [p.id]: notes }, 2 * SR);
      expect(peak(L1), plugin).toBeGreaterThan(1e-3);
      expect(maxDiff(L1, L2), plugin).toBe(0);
      expect(maxDiff(R1, R2), plugin).toBe(0);
    }
  }, 60_000);

  it('keeps a voice\'s release (the plugin\'s own tail) and plays on after the channel\'s voice slot ended', () => {
    const e = makeEngine();
    const p = patcherChannel(oneGen('test-dc', { releaseFrames: 6000 }));
    const [L] = play(e, [p], { [p.id]: [{ pos: 0, len: 24, key: 60 }] }, 24000);
    const v = DcGen.all[DcGen.all.length - 1].voices[0];
    expect(v.releasedAt).toBe(6000);
    expect(v.killedAt).toBe(12000);
    expect(L[11999]).not.toBe(0);
    expect(L[12000]).toBe(0);
  });

  it('gives hosted instruments the channel\'s context: tempo, transport, mixer track and the export flag', () => {
    const e = makeEngine({ rendering: true });
    const p = patcherChannel(oneGen('test-ev'), 3);
    EventGen.all.length = 0;
    play(e, [p], { [p.id]: [{ pos: 0, len: 24, key: 60 }] }, 4000);
    const ctx = EventGen.all[0].ctxs[0];
    expect(ctx.track).toBe(3);
    expect(ctx.playing).toBe(true);
    expect(ctx.tempo).toBe(120);
    expect(ctx.ppq).toBe(96);
    expect(ctx.rendering).toBe(true);
    expect(ctx.blockSize).toBe(128);
  });

  it('handles an events instrument like its own channel (note on / off at the same samples)', () => {
    const run = (chans: (() => Channel)[]) => {
      const e = makeEngine();
      EventGen.all.length = 0;
      const cs = chans.map((f) => f());
      const [L] = play(e, cs, Object.fromEntries(cs.map((c) => [c.id, notes])), 2 * SR);
      return { ev: EventGen.all[EventGen.all.length - 1].events, L };
    };
    const a = run([() => genChannel('test-ev')]);
    const b = run([() => patcherChannel(oneGen('test-ev'))]);
    expect(b.ev).toEqual(a.ev);
    expect(a.ev.filter((x) => x[0] === 'on')).toHaveLength(4);
    expect(maxDiff(a.L, b.L)).toBeLessThan(1e-7);
  });
});

describe('Patcher instrument: effects and note routing', () => {
  const one = [{ pos: 0, len: 24, key: 60 }, { pos: 96, len: 48, key: 62, vel: 80 }];
  const solo = (c: Channel, notes = one, frames = 2 * SR) => {
    const e = makeEngine();
    DcGen.all.length = 0;
    return play(e, [c], { [c.id]: notes }, frames);
  };

  it('runs the effects after a generator on its audio, and only along the links', () => {
    const [L0, R0] = solo(patcherChannel(oneGen('test-dc')));
    const [L1, R1] = solo(patcherChannel((g) => {
      const m = addModule(g, 'test-dc', defaultGenParams('test-dc'), 300, 200, 'DC', true);
      const fx = addModule(g, 'pg-gain', { g: 0.5 }, 500, 200, 'Gain');
      connect(g, 'events', IN, 0, m.id, 0);
      connect(g, 'audio', m.id, 0, fx.id, 0);
      connect(g, 'audio', fx.id, 0, OUT, 0);
    }));
    expect(peak(L0)).toBeGreaterThan(0.1);
    for (let i = 0; i < L0.length; i += 37) expect(L1[i]).toBeCloseTo(L0[i] * 0.5, 7);
    expect(maxDiff(R1, R0.map((v) => v * 0.5))).toBeLessThan(1e-7);
    // a generator that is not linked to To FL Studio is silent, one without notes plays nothing
    const [L2] = solo(patcherChannel((g) => {
      const m = addModule(g, 'test-dc', defaultGenParams('test-dc'), 300, 200, 'DC', true);
      connect(g, 'events', IN, 0, m.id, 0);
    }));
    expect(peak(L2)).toBe(0);
    const [L3] = solo(patcherChannel((g) => {
      const m = addModule(g, 'test-dc', defaultGenParams('test-dc'), 300, 200, 'DC', true);
      connect(g, 'audio', m.id, 0, OUT, 0);
    }));
    expect(peak(L3)).toBe(0);
  });

  it('sums parallel generators; each plays the notes of its own event link', () => {
    const [L0] = solo(patcherChannel(oneGen('test-dc')));
    const [L] = solo(patcherChannel((g) => {
      for (const lv of [0.5, 0.25]) {
        const m = addModule(g, 'test-dc', { ...defaultGenParams('test-dc'), level: lv }, 300, 200, 'DC', true);
        connect(g, 'events', IN, 0, m.id, 0);
        connect(g, 'audio', m.id, 0, OUT, 0);
      }
    }));
    expect(DcGen.all).toHaveLength(2);
    for (let i = 0; i < L.length; i += 41) expect(L[i]).toBeCloseTo(L0[i] * 1.5, 7);
  });

  it('plays what a VFX Key Mapper makes of the notes: a voice per output note at its own pitch and key', () => {
    const [L] = solo(patcherChannel((g) => {
      const km = addModule(g, 'vfxkeymapper', { ...defaultFxParams('vfxkeymapper'), map: [[0, 4, 7], ...Array.from({ length: 11 }, (_, i) => [i + 1])] }, 200, 200, 'Key Mapper');
      const m = addModule(g, 'test-dc', defaultGenParams('test-dc'), 400, 200, 'DC', true);
      connect(g, 'events', IN, 0, km.id, 0);
      connect(g, 'events', km.id, 0, m.id, 0);
      connect(g, 'audio', m.id, 0, OUT, 0);
    }));
    const v = DcGen.all[0].voices;
    // C -> C E G; D (62) is not in the map's first slot: plays alone
    const c = v.filter((x) => x.key === 60 || x.key === 64 || x.key === 67);
    expect(c.length).toBe(3);
    expect(c.map((x) => x.initPitch - 6000).sort((a, b) => a - b)).toEqual([0, 400, 700]);
    // the pitch level follows the key shift (the channel's own pitch part is unchanged)
    expect(c.map((x) => DcGen.all[0].voices.indexOf(x)).every((i) => i >= 0)).toBe(true);
    expect(peak(L)).toBeGreaterThan(0.1);
  });

  it('plays VFX Level Scaler velocities (volume follows the new velocity)', () => {
    const base = solo(patcherChannel(oneGen('test-dc')));
    const [L] = solo(patcherChannel((g) => {
      const ls = addModule(g, 'vfxlevelscaler', { ...defaultFxParams('vfxlevelscaler'), velMul: 4096 }, 200, 200, 'Level Scaler');
      const m = addModule(g, 'test-dc', defaultGenParams('test-dc'), 400, 200, 'DC', true);
      connect(g, 'events', IN, 0, ls.id, 0);
      connect(g, 'events', ls.id, 0, m.id, 0);
      connect(g, 'audio', m.id, 0, OUT, 0);
    }));
    const v = DcGen.all[0].voices;
    expect(v[0].velocity).toBeCloseTo(50, 3);
    expect(v[1].velocity).toBeCloseTo(40, 3);
    expect(L[100] / base[0][100]).toBeCloseTo(velocityRatio(50, 100), 5);
  });

  it('routes note colours to different generators through a VFX Color Mapper', () => {
    const colored = [{ pos: 0, len: 24, key: 60, color: 0 }, { pos: 48, len: 24, key: 62, color: 2 }];
    solo(patcherChannel((g) => {
      const cm = addModule(g, 'vfxcolormapper', defaultFxParams('vfxcolormapper'), 200, 200, 'Color Mapper');
      const a = addModule(g, 'test-dc', defaultGenParams('test-dc'), 400, 100, 'A', true);
      const b = addModule(g, 'test-dc', defaultGenParams('test-dc'), 400, 300, 'B', true);
      connect(g, 'events', IN, 0, cm.id, 0);
      connect(g, 'events', cm.id, 0, a.id, 0);   // voice output 1 (colour group 1)
      connect(g, 'events', cm.id, 2, b.id, 0);   // voice output 3 (colour group 3)
      connect(g, 'audio', a.id, 0, OUT, 0);
      connect(g, 'audio', b.id, 0, OUT, 0);
    }), colored);
    expect(DcGen.all).toHaveLength(2);
    expect(DcGen.all[0].voices.map((x) => x.key)).toEqual([60]);
    expect(DcGen.all[1].voices.map((x) => x.key)).toEqual([62]);
  });

  it('delivers the notes of MIDI Out ports to the generators linked to the activated "Port p" output (unity channel volume)', () => {
    const e = makeEngine();
    const c = patcherChannel((g) => {
      const m = addModule(g, 'test-dc', defaultGenParams('test-dc'), 300, 200, 'DC', true);
      g.io.in.ports = [5];
      connect(g, 'events', IN, 6, m.id, 0);
      connect(g, 'audio', m.id, 0, OUT, 0);
    });
    c.volume = 0.3; // the channel's volume knob does not reach notes that do not come from the channel
    const mo = createMidiOutChannel('MIDI Out');
    mo.midiOut!.port = 5;
    const other = createMidiOutChannel('MIDI Out 2');
    other.midiOut!.port = 6;
    DcGen.all.length = 0;
    const [L] = play(e, [c, mo, other], { [mo.id]: [{ pos: 50, len: 10, key: 70, vel: 90 }], [other.id]: [{ pos: 0, len: 10, key: 72 }], [c.id]: [{ pos: 0, len: 10, key: 65 }] }, 16000);
    const v = DcGen.all[0].voices;
    // the port's note only (the channel's own notes are not linked, port 6 is not activated)
    expect(v.map((x) => x.key)).toEqual([70]);
    expect(firstNonZero(L)).toBe(12500);
    expect(L[12500]).toBeCloseTo(0.5 * velocityGain(90) * Math.SQRT1_2, 6);
    expect(v[0].initPitch).toBe(6000 + 1000);
    expect(L[14999]).not.toBe(0);
    expect(L[15000]).toBe(0);
  });

  it('feeds "Notes" with the notes of the channel\'s MIDI input port as well', () => {
    const e = makeEngine();
    const c = patcherChannel(oneGen('test-dc'));
    c.plugin!.midiPort = 4;
    const mo = createMidiOutChannel('MIDI Out');
    mo.midiOut!.port = 4;
    DcGen.all.length = 0;
    const [L] = play(e, [c, mo], { [mo.id]: [{ pos: 50, len: 10, key: 66 }] }, 16000);
    expect(DcGen.all[0].voices.map((x) => x.key)).toEqual([66]);
    expect(firstNonZero(L)).toBe(12500);
  });

  it('stops hosted voices when the channel kills a note (polyphony limit, panic) with the channel\'s declick fade', () => {
    const e = makeEngine();
    const c = patcherChannel(oneGen('test-dc'));
    c.sampler.polyMax = 1;
    DcGen.all.length = 0;
    const [L] = play(e, [c], { [c.id]: [{ pos: 0, len: 96, key: 60 }, { pos: 24, len: 96, key: 62 }] }, 9000);
    const v = DcGen.all[0].voices;
    expect(v).toHaveLength(2);
    // the first note was stolen at 6000 (the block of the second note) and fades out over 10 ms (480 samples, unreleased), the second goes on
    expect(v[0].releasedAt).toBe(-1);
    expect(v[0].killedAt).toBeGreaterThan(6300);
    expect(v[0].killedAt).toBeLessThan(6600);
    expect(v[1].killedAt).toBe(-1);
    expect(L[8000]).not.toBe(0);
    e.handle({ t: 'allNotesOff' });
    const [L2] = e.renderOffline(2048);
    expect(peak(L2, 1024)).toBe(0);
    expect(DcGen.all[0].voices[1].killedAt).toBeGreaterThan(0);
  });

  it('plays a VFX Sequencer\'s arpeggio and lets the channel go idle once the chord and its outputs are over', () => {
    const e = makeEngine();
    const c = patcherChannel((g) => {
      const seq = addModule(g, 'vfxsequencer', defaultFxParams('vfxsequencer'), 200, 200, 'Sequencer');
      const m = addModule(g, 'test-dc', defaultGenParams('test-dc'), 400, 200, 'DC', true);
      connect(g, 'events', IN, 0, seq.id, 0);
      connect(g, 'events', seq.id, 0, m.id, 0);
      connect(g, 'audio', m.id, 0, OUT, 0);
    });
    DcGen.all.length = 0;
    // two beats of a held chord (96 ticks: sixteen 1/16 steps of the sequencer's program)
    const [L] = play(e, [c], { [c.id]: [{ pos: 0, len: 96, key: 60 }, { pos: 0, len: 96, key: 64 }] }, 4 * SR);
    expect(DcGen.all[0].voices.length).toBeGreaterThan(2);
    expect(peak(L)).toBeGreaterThan(0.05);
    // every output note ends: the channel stops rendering (released notes the batch remembers do not keep it busy)
    e.renderOffline(10 * SR);
    expect((e.channels.get(c.id) as GenChannel).isActive()).toBe(false);
  });

  it('keeps the channel rendering while a hosted voice rings out and while an effect behind it rings', () => {
    registerEffect({ id: 'pg-tail', create: () => ({ tail: 1, setParams() {}, reset() {}, process() {} } as EffectInstance) });
    const e = makeEngine();
    const c = patcherChannel((g) => {
      const m = addModule(g, 'test-dc', { ...defaultGenParams('test-dc'), releaseFrames: 9000 }, 300, 200, 'DC', true);
      const t = addModule(g, 'pg-tail', {}, 500, 200, 'Tail');
      connect(g, 'events', IN, 0, m.id, 0);
      connect(g, 'audio', m.id, 0, t.id, 0);
      connect(g, 'audio', t.id, 0, OUT, 0);
    });
    e.handle({ t: 'channel', c });
    const pat = createPattern(1);
    pat.notes[c.id] = [createNote({ pos: 0, len: 24 })];
    e.handle({ t: 'pattern', p: pat });
    e.handle({ t: 'mode', song: false, patternId: pat.id });
    e.handle({ t: 'play' });
    e.renderOffline(6000 + 9000 + 100);
    const ch = e.channels.get(c.id) as GenChannel;
    expect(ch.isActive()).toBe(true); // the tail of the effect: 1 s after the hosted voice ended
    e.renderOffline(30000);
    expect(ch.isActive()).toBe(true);
    e.renderOffline(30000);
    expect(ch.isActive()).toBe(false);
  });
});

describe('Patcher instrument: parameters of hosted plugins in links and automation', () => {
  it('Link to controller drives a hosted generator\'s parameter (channel-scoped path into the patch)', () => {
    const e = makeEngine();
    const ctl = genChannel('test-genctl');
    ctl.plugin!.params.v = 0.75;
    let gm = '';
    const p = patcherChannel((g) => { oneGen('test-dc')(g); gm = Object.keys(g.modules)[0]; });
    DcGen.all.length = 0;
    e.handle({ t: 'channel', c: ctl });
    e.handle({ t: 'channel', c: p });
    const target = { scope: 'channel' as const, id: p.id, path: `plugin.params.$graph.modules.${gm}.params.level`, min: 0, max: 1, label: 'Level' };
    e.handle({ t: 'links', list: [{ id: 'l1', target, source: { slotId: 'ch:' + ctl.id, output: 0 }, formula: 'Input' }] });
    e.renderOffline(512);
    expect(e.linkCurrent.get(`channel:${p.id}:plugin.params.$graph.modules.${gm}.params.level`)).toBeCloseTo(0.75, 9);
    expect(DcGen.all[0].params.level).toBeCloseTo(0.75, 9);
  });
});

describe('generators hosted in an effect slot\'s Patcher', () => {
  it('play the notes of the MIDI Out ports linked to them (no channel behind them: unity volume, centred)', async () => {
    const { createEffect } = await import('../../src/engine/effects');
    const { makeCtx } = await import('../fx/util');
    const g = defaultGraph();
    const m = addModule(g, 'test-dc', defaultGenParams('test-dc'), 300, 200, 'DC', true);
    g.io.in.ports = [5];
    connect(g, 'events', IN, 1 + 5, m.id, 0);
    g.links = g.links.filter((l) => l.kind === 'events');
    connect(g, 'audio', m.id, 0, OUT, 0);
    DcGen.all.length = 0;
    const fx = createEffect('patcher', 48000, 128);
    fx.setParams({ [GRAPH_KEY]: g });
    expect(fx.midiPorts?.()).toEqual([5]);
    const c = makeCtx({ playing: false });
    const blk = () => { const L = new Float32Array(128), R = new Float32Array(128); fx.process(L, R, 128, c); return [L, R]; };
    blk();
    fx.noteOn?.(64, 100, 10, 5, 1);
    const [L1] = blk();
    expect(L1[9]).toBe(0);
    expect(L1[10]).toBeCloseTo(0.5 * Math.SQRT1_2, 6); // the generator's DC x centred pan law, no channel volume
    expect(DcGen.all[0].voices[0].key).toBe(64);
    expect(DcGen.all[0].voices[0].initPitch).toBe(6000 + 400);
    fx.noteOff?.(64, 20, 5, 1);
    const [L2] = blk();
    expect(L2[19]).not.toBe(0);
    expect(L2[20]).toBe(0);
    // other ports reach nothing
    fx.noteOn?.(65, 100, 0, 6, 1);
    blk();
    expect(DcGen.all[0].voices).toHaveLength(1);
  });
});
