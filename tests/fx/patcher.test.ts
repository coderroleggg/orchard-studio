import { describe, it, expect } from 'vitest';
import { createEffect, registerEffect } from '../../src/engine/effects';
import type { EffectInstance } from '../../src/engine/effects/types';
import { defaultFxParams, fxDef, normalizeFxParams } from '../../src/model/fx/registry';
import {
  GRAPH_KEY, IN, OUT, addModule, autoArrange, compensate, connect, connectError, defaultGraph, disconnect,
  disconnectNode, levelText, normalizeGraph, pathTail, processPlan, removeModules, shownOuts, wouldCycle,
  type PatcherGraph,
} from '../../src/model/fx/plugins/patcher';
import { makeCtx, render } from './util';
import { getPath, setPath } from '../../src/model/automation';

// test modules: a pure gain, an N-sample latency (reported for PDC), a ringing tail, a generator
registerEffect({
  id: 'pt-gain', create: () => {
    let g = 1;
    return {
      setParams(p: unknown) { g = Number((p as { g?: number }).g ?? 1); }, reset() {},
      process(L: Float32Array, R: Float32Array, n: number) { for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; } },
    } as EffectInstance;
  },
});
registerEffect({
  id: 'pt-delay', create: (_sr, bs) => {
    let d = 0;
    let bl = new Float32Array(bs), br = new Float32Array(bs), w = 0;
    const fx = {
      latency: 0,
      setParams(p: unknown) {
        d = Number((p as { d?: number }).d ?? 0);
        fx.latency = d;
        bl = new Float32Array(d + bs); br = new Float32Array(d + bs); w = 0;
      },
      reset() { bl.fill(0); br.fill(0); },
      process(L: Float32Array, R: Float32Array, n: number) {
        for (let i = 0; i < n; i++) {
          bl[w] = L[i]; br[w] = R[i];
          let r = w - d; if (r < 0) r += bl.length;
          L[i] = bl[r]; R[i] = br[r];
          if (++w >= bl.length) w = 0;
        }
      },
    } as EffectInstance & { latency: number };
    return fx;
  },
});
registerEffect({ id: 'pt-tail', create: () => ({ tail: 2, setParams() {}, reset() {}, process() {} } as EffectInstance) });

// a note recorder: [on/off, key, absolute frame, velocity]
type NoteRec = [string, number, number, number];
const recorders: { ev: NoteRec[]; t: number }[] = [];
registerEffect({
  id: 'pt-notes', create: () => {
    const r = { ev: [] as NoteRec[], t: 0 };
    recorders.push(r);
    return {
      setParams() {}, reset() {},
      process(_L: Float32Array, _R: Float32Array, n: number) { r.t += n; },
      noteOn(key: number, vel: number, f: number) { r.ev.push(['on', key, r.t + f, vel]); },
      noteOff(key: number, f: number) { r.ev.push(['off', key, r.t + f, 0]); },
    } as EffectInstance;
  },
});

function graphWith(build: (g: PatcherGraph) => void): Record<string, unknown> {
  const g = defaultGraph();
  g.links = [];
  build(g);
  return { [GRAPH_KEY]: g };
}

function run(state: Record<string, unknown>, input: Float32Array, block = 128): Float32Array {
  const fx = createEffect('patcher', 48000, block);
  fx.setParams(state);
  fx.reset();
  return render(fx, input, input, block)[0];
}

const ones = (n: number, v = 1) => new Float32Array(n).fill(v);

describe('Patcher', () => {
  it('is registered as a Patcher-category plugin with a default patch that passes audio', () => {
    const d = fxDef('patcher')!;
    expect(d.category).toBe('Patcher');
    expect(d.width).toBe(1001);
    expect(d.height).toBe(591);
    const p = defaultFxParams('patcher');
    const g = p[GRAPH_KEY] as PatcherGraph;
    expect(Object.keys(g.modules)).toHaveLength(0);
    expect(g.links).toEqual([expect.objectContaining({ kind: 'audio', from: IN, to: OUT, level: 1, mute: false })]);
    const out = run(p, ones(256, 0.5));
    expect(out[200]).toBeCloseTo(0.5, 6);
  });

  it('routes audio through a chain of modules', () => {
    const state = graphWith((g) => {
      const a = addModule(g, 'pt-gain', { g: 0.5 }, 200, 200, 'A');
      const b = addModule(g, 'pt-gain', { g: 0.25 }, 400, 200, 'B');
      connect(g, 'audio', IN, 0, a.id, 0);
      connect(g, 'audio', a.id, 0, b.id, 0);
      connect(g, 'audio', b.id, 0, OUT, 0);
    });
    const out = run(state, ones(512));
    expect(out[300]).toBeCloseTo(0.125, 6);
  });

  it('sums a parallel split at the output and fans one output out to several inputs', () => {
    const state = graphWith((g) => {
      const a = addModule(g, 'pt-gain', { g: 0.5 }, 200, 100, 'A');
      const b = addModule(g, 'pt-gain', { g: 0.2 }, 200, 300, 'B');
      connect(g, 'audio', IN, 0, a.id, 0); // the input fans out to A and B
      connect(g, 'audio', IN, 0, b.id, 0);
      connect(g, 'audio', a.id, 0, OUT, 0); // To FL Studio sums both
      connect(g, 'audio', b.id, 0, OUT, 0);
    });
    const out = run(state, ones(512));
    expect(out[300]).toBeCloseTo(0.7, 6);
  });

  it('processes real hosted plugins with their own state (Balance inside Patcher)', () => {
    const params = { ...defaultFxParams('balance'), vol: 128, pan: -64 };
    const state = graphWith((g) => {
      const a = addModule(g, 'balance', params, 200, 200, 'Balance');
      connect(g, 'audio', IN, 0, a.id, 0);
      connect(g, 'audio', a.id, 0, OUT, 0);
    });
    // the same plugin processed on its own (whatever Balance's own laws are)
    const solo = createEffect('balance', 48000, 128);
    solo.setParams(params);
    solo.reset();
    const inL = ones(1024, 0.5), inR = ones(1024, 0.25);
    const [refL, refR] = render(solo, inL, inR, 128);
    const fx = createEffect('patcher', 48000, 128);
    fx.setParams(state);
    fx.reset();
    const [outL, outR] = render(fx, inL, inR, 128);
    expect(Math.abs(refL[900] - 0.5) + Math.abs(refR[900] - 0.25)).toBeGreaterThan(0.01); // Balance did something
    expect(outL[900]).toBeCloseTo(refL[900], 6);
    expect(outR[900]).toBeCloseTo(refR[900], 6);
  });

  it('rejects links that would close a feedback loop', () => {
    const g = defaultGraph();
    g.links = [];
    const a = addModule(g, 'pt-gain', {}, 0, 0, 'A');
    const b = addModule(g, 'pt-gain', {}, 0, 0, 'B');
    const c = addModule(g, 'pt-gain', {}, 0, 0, 'C');
    expect(connect(g, 'audio', a.id, 0, b.id, 0)).not.toBeNull();
    expect(connect(g, 'audio', b.id, 0, c.id, 0)).not.toBeNull();
    expect(wouldCycle(g, c.id, a.id)).toBe(true);
    expect(connectError(g, 'audio', c.id, 0, a.id, 0)).toMatch(/loop/i);
    expect(connect(g, 'audio', c.id, 0, a.id, 0)).toBeNull();
    expect(connect(g, 'audio', a.id, 0, a.id, 0)).toBeNull(); // self loop
    expect(connect(g, 'audio', OUT, 0, a.id, 0)).toBeNull(); // To FL Studio has no outputs
    expect(connect(g, 'audio', a.id, 0, IN, 0)).toBeNull(); // From FL Studio has no inputs
    expect(connect(g, 'audio', a.id, 0, b.id, 0)).toBeNull(); // duplicate
    expect(g.links).toHaveLength(2);
  });

  it('ignores a feedback link in a corrupted state instead of hanging or blowing up', () => {
    const state = graphWith((g) => {
      const a = addModule(g, 'pt-gain', { g: 0.5 }, 0, 0, 'A');
      const b = addModule(g, 'pt-gain', { g: 0.5 }, 0, 0, 'B');
      connect(g, 'audio', IN, 0, a.id, 0);
      connect(g, 'audio', a.id, 0, b.id, 0);
      connect(g, 'audio', b.id, 0, OUT, 0);
      g.links.push({ id: 'bad', kind: 'audio', from: b.id, fromPort: 0, to: a.id, toPort: 0, level: 1, mute: false });
    });
    const plan = processPlan(state[GRAPH_KEY] as PatcherGraph);
    expect(plan.order).toEqual(['m2', 'm3']);
    const out = run(state, ones(512));
    expect(out[400]).toBeCloseTo(0.25, 6);
    // normalizing a stored state drops the loop
    const fixed = normalizeGraph(state[GRAPH_KEY]);
    expect(fixed.links.some((l) => l.id === 'bad')).toBe(false);
  });

  it('compensates latency between parallel paths and reports the longest path', () => {
    const state = graphWith((g) => {
      const d = addModule(g, 'pt-delay', { d: 100 }, 0, 0, 'Delay');
      const e = addModule(g, 'pt-delay', { d: 30 }, 0, 0, 'Delay 2');
      connect(g, 'audio', IN, 0, d.id, 0);
      connect(g, 'audio', d.id, 0, e.id, 0);
      connect(g, 'audio', e.id, 0, OUT, 0); // 130 samples
      connect(g, 'audio', IN, 0, OUT, 0); // dry path, delayed by 130 to line up
    });
    const fx = createEffect('patcher', 48000, 128);
    fx.setParams(state);
    fx.reset();
    expect(fx.latency).toBe(130);
    const imp = new Float32Array(1024);
    imp[10] = 1;
    const [out] = render(fx, imp, imp, 128);
    expect(out[140]).toBeCloseTo(2, 6); // both paths arrive together
    let other = 0;
    for (let i = 0; i < out.length; i++) if (i !== 140) other += Math.abs(out[i]);
    expect(other).toBeLessThan(1e-6);
  });

  it('computes compensation delays and tails along the longest path', () => {
    const g = defaultGraph();
    g.links = [];
    const a = addModule(g, 'x', {}, 0, 0, 'A');
    const b = addModule(g, 'x', {}, 0, 0, 'B');
    const c = addModule(g, 'x', {}, 0, 0, 'C');
    connect(g, 'audio', IN, 0, a.id, 0);
    connect(g, 'audio', IN, 0, b.id, 0);
    connect(g, 'audio', a.id, 0, c.id, 0);
    connect(g, 'audio', b.id, 0, c.id, 0);
    connect(g, 'audio', c.id, 0, OUT, 0);
    const plan = processPlan(g);
    const lat: Record<string, number> = { [a.id]: 64, [b.id]: 16, [c.id]: 8 };
    const comp = compensate(plan, (id) => lat[id] ?? 0);
    expect(comp.total).toBe(72);
    const bToC = g.links.find((l) => l.from === b.id && l.to === c.id)!;
    expect(comp.delays.get(bToC.id)).toBe(48);
    const tails: Record<string, number> = { [a.id]: 1, [b.id]: 3, [c.id]: 0.5 };
    expect(pathTail(plan, (id) => tails[id] ?? 0)).toBeCloseTo(3.5, 9);
    expect(plan.depth.get(c.id)).toBe(2);
  });

  it('reports the hosted tails to the mixer (Infinity for generators)', () => {
    const fx = createEffect('patcher', 48000, 128);
    fx.setParams(graphWith((g) => {
      const t = addModule(g, 'pt-tail', {}, 0, 0, 'T');
      connect(g, 'audio', IN, 0, t.id, 0);
      connect(g, 'audio', t.id, 0, OUT, 0);
    }));
    expect(fx.tail).toBeCloseTo(2, 6);
  });

  it('applies link levels and mutes with a ramp (no zipper)', () => {
    const g = defaultGraph();
    const fx = createEffect('patcher', 48000, 128);
    fx.setParams({ [GRAPH_KEY]: g });
    fx.reset();
    const g2 = structuredClone(g);
    g2.links[0].mute = true;
    fx.setParams({ [GRAPH_KEY]: g2 });
    const L = ones(128), R = ones(128);
    fx.process(L, R, 128, makeCtx());
    expect(L[0]).toBeCloseTo(1, 2);
    expect(L[64]).toBeCloseTo(0.5, 2);
    expect(L[127]).toBeLessThan(0.02);
    const g3 = structuredClone(g);
    g3.links[0].level = 0.5;
    fx.setParams({ [GRAPH_KEY]: g3 });
    fx.process(L.fill(1), R.fill(1), 128, makeCtx());
    fx.process(L.fill(1), R.fill(1), 128, makeCtx());
    expect(L[100]).toBeCloseTo(0.5, 6);
    expect(levelText(1)).toBe('100% (0.0 dB)');
    expect(levelText(0.5)).toBe('50% (-6.0 dB)');
  });

  it('keeps module instances (and their state) across edits and drops removed ones', () => {
    const g = defaultGraph();
    g.links = [];
    const a = addModule(g, 'pt-delay', { d: 10 }, 0, 0, 'A');
    connect(g, 'audio', IN, 0, a.id, 0);
    connect(g, 'audio', a.id, 0, OUT, 0);
    const fx = createEffect('patcher', 48000, 128);
    fx.setParams({ [GRAPH_KEY]: g });
    expect(fx.latency).toBe(10);
    const g2 = structuredClone(g);
    removeModules(g2, [a.id]);
    expect(g2.links).toHaveLength(0);
    fx.setParams({ [GRAPH_KEY]: g2 });
    expect(fx.latency).toBe(0);
    const L = ones(128), R = ones(128);
    fx.process(L, R, 128, makeCtx());
    expect(L[50]).toBe(0); // nothing reaches To FL Studio
  });

  it('automates hosted module parameters at their own paths, focused or not', () => {
    const g = defaultGraph();
    g.links = [];
    const a = addModule(g, 'pt-gain', { g: 1 }, 0, 0, 'A');
    const b = addModule(g, 'pt-gain', { g: 1 }, 0, 0, 'B');
    connect(g, 'audio', IN, 0, a.id, 0);
    connect(g, 'audio', a.id, 0, b.id, 0);
    connect(g, 'audio', b.id, 0, OUT, 0);
    g.focus = a.id;
    // what the engine does for an automation clip: setPath on its copy of the slot, then setParams
    const slot = { params: structuredClone({ [GRAPH_KEY]: g }) as Record<string, unknown> };
    expect(setPath(slot, `params.${GRAPH_KEY}.modules.${b.id}.params.g`, 0.25)).toBe(true);
    const fx = createEffect('patcher', 48000, 128);
    fx.setParams(slot.params);
    fx.reset();
    const L = ones(128), R = ones(128);
    fx.process(L, R, 128, makeCtx());
    expect(L[10]).toBeCloseTo(0.25, 6); // B is not focused
    expect(getPath(slot, `params.${GRAPH_KEY}.modules.${b.id}.params.g`)).toBe(0.25);
  });

  it('stays finite when a module misbehaves', () => {
    registerEffect({ id: 'pt-nan', create: () => ({ setParams() {}, reset() {}, process(L: Float32Array) { L.fill(NaN); } } as EffectInstance) });
    const state = graphWith((g) => {
      const a = addModule(g, 'pt-nan', {}, 0, 0, 'A');
      connect(g, 'audio', IN, 0, a.id, 0);
      connect(g, 'audio', a.id, 0, OUT, 0);
    });
    const out = run(state, ones(256));
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('takes notes on From FL Studio\'s MIDI port outputs and the slot\'s port, and plays them through VFX modules', () => {
    recorders.length = 0;
    const g = defaultGraph();
    const km = addModule(g, 'vfxkeymapper', { ...defaultFxParams('vfxkeymapper'), map: [[0, 4, 7], ...Array.from({ length: 11 }, (_, i) => [i + 1])] }, 300, 200, 'Key Mapper');
    const rec = addModule(g, 'pt-notes', {}, 600, 200, 'Rec');
    const direct = addModule(g, 'pt-notes', {}, 600, 400, 'Rec 2');
    g.io.in.ports = [5];
    g.links.push({ id: 'e1', kind: 'events', from: IN, fromPort: 1 + 5, to: km.id, toPort: 0, level: 1, mute: false });
    g.links.push({ id: 'e2', kind: 'events', from: km.id, fromPort: 0, to: rec.id, toPort: 0, level: 1, mute: false });
    g.links.push({ id: 'e3', kind: 'events', from: IN, fromPort: 0, to: direct.id, toPort: 0, level: 1, mute: false });
    expect(shownOuts(g, IN, 'events')).toEqual([0, 6]);
    const fx = createEffect('patcher', 48000, 128);
    fx.setMidiPort?.(3);
    fx.setParams({ [GRAPH_KEY]: g });
    expect(fx.midiPorts?.()).toEqual([5]);
    const [r, d] = recorders;
    const c = makeCtx({ playing: false });
    const blk = () => fx.process(new Float32Array(128), new Float32Array(128), 128, c);
    blk();
    // port 5 -> Key Mapper (C -> C E G) -> recorder, at the note's sample
    fx.noteOn?.(60, 100, 10, 5, 1);
    blk();
    fx.noteOff?.(60, 20, 5, 1);
    blk();
    expect(r.ev).toEqual([['on', 60, 138, 100], ['on', 64, 138, 100], ['on', 67, 138, 100], ['off', 60, 276, 0], ['off', 64, 276, 0], ['off', 67, 276, 0]]);
    // the slot's MIDI input port (3) feeds "Notes"; other ports reach nothing
    fx.noteOn?.(70, 90, 5, 3, 1);
    fx.noteOn?.(71, 90, 6, 9, 1);
    blk();
    expect(d.ev).toEqual([['on', 70, 389, 90]]);
    expect(r.ev).toHaveLength(6);
  });

  it('keeps a VFX module\'s counters from note to note (Key Mapper cycle up)', () => {
    recorders.length = 0;
    const g = defaultGraph();
    const km = addModule(g, 'vfxkeymapper', { ...defaultFxParams('vfxkeymapper'), mode: 3, map: [[0, 4, 7], ...Array.from({ length: 11 }, (_, i) => [i + 1])] }, 300, 200, 'Key Mapper');
    const rec = addModule(g, 'pt-notes', {}, 600, 200, 'Rec');
    g.links.push({ id: 'e1', kind: 'events', from: IN, fromPort: 0, to: km.id, toPort: 0, level: 1, mute: false });
    g.links.push({ id: 'e2', kind: 'events', from: km.id, fromPort: 0, to: rec.id, toPort: 0, level: 1, mute: false });
    const fx = createEffect('patcher', 48000, 128);
    fx.setMidiPort?.(0);
    fx.setParams({ [GRAPH_KEY]: g });
    const c = makeCtx({ playing: false });
    for (let k = 0; k < 4; k++) {
      fx.noteOn?.(60, 100, 0, 0, 1);
      fx.process(new Float32Array(128), new Float32Array(128), 128, c);
      fx.noteOff?.(60, 0, 0, 1);
      fx.process(new Float32Array(128), new Float32Array(128), 128, c);
    }
    expect(recorders[0].ev.filter((e) => e[0] === 'on').map((e) => e[1])).toEqual([60, 64, 67, 60]);
  });

  it('arpeggiates held chords live with VFX Sequencer (one pattern for the whole chord)', () => {
    recorders.length = 0;
    const g = defaultGraph();
    // the initial program plays N1 on every step: make the steps walk the chord (N1 N2 N3 ...)
    const sp: Record<string, unknown> = { ...defaultFxParams('vfxsequencer') };
    for (let i = 0; i < 16; i++) sp[`key${i + 1}`] = (i % 3) + 1;
    const seq = addModule(g, 'vfxsequencer', sp, 300, 200, 'Sequencer');
    const rec = addModule(g, 'pt-notes', {}, 600, 200, 'Rec');
    g.links.push({ id: 'e1', kind: 'events', from: IN, fromPort: 0, to: seq.id, toPort: 0, level: 1, mute: false });
    g.links.push({ id: 'e2', kind: 'events', from: seq.id, fromPort: 0, to: rec.id, toPort: 0, level: 1, mute: false });
    const fx = createEffect('patcher', 48000, 128);
    fx.setMidiPort?.(0);
    fx.setParams({ [GRAPH_KEY]: g });
    const [r] = recorders;
    // 120 BPM, PPQ 96, playing from tick 0: a 1/16 step = 24 ticks = 6000 samples
    const c = makeCtx({ playing: true, pos: 0, tempo: 120, ppq: 96 });
    for (let i = 0; i < 48000; i += 128) {
      if (i === 0) for (const k of [60, 64, 67]) fx.noteOn?.(k, 100, 0, 0, 1);
      if (i === 128 * 280) for (const k of [60, 64, 67]) fx.noteOff?.(k, 0, 0, 1); // released at 35840
      fx.process(new Float32Array(128), new Float32Array(128), 128, c);
      c.pos += (128 / 48000) * 2 * 96;
    }
    const ons = r.ev.filter((e) => e[0] === 'on');
    expect(ons.length).toBeGreaterThanOrEqual(4);
    // one note per step on the 1/16 grid (not three parallel patterns), only while held
    const times = ons.map((e) => e[2]);
    for (let k = 1; k < times.length; k++) expect(times[k] - times[k - 1]).toBeGreaterThanOrEqual(5900);
    expect(times.every((t) => t % 6000 < 2 || t % 6000 > 5998)).toBe(true);
    expect(Math.max(...times)).toBeLessThan(35840);
    expect(new Set(ons.map((e) => e[1])).size).toBeGreaterThan(1);
    // every note ends
    expect(r.ev.filter((e) => e[0] === 'off').length).toBe(ons.length);
  });

  it('gives effects inside Patcher a notes input and mirrors their own state changes', () => {
    const g = defaultGraph();
    const gb = addModule(g, 'grossbeat', defaultFxParams('grossbeat'), 300, 200, 'Gross Beat');
    expect(connect(g, 'events', IN, 0, gb.id, 0)).not.toBeNull();
    const fx = createEffect('patcher', 48000, 128);
    fx.setMidiPort?.(1);
    fx.setParams({ [GRAPH_KEY]: g });
    fx.noteOn?.(62, 100, 0, 1, 1); // time slot 3
    fx.process(new Float32Array(128), new Float32Array(128), 128, makeCtx({ playing: false }));
    expect(fx.takeStateChanges?.()).toEqual([[`${GRAPH_KEY}.modules.${gb.id}.params.tslot`, 2]]);
    expect(fx.takeStateChanges?.()).toBeNull();
  });

  it('edits the graph: disconnect, node ports, auto-arrange and normalization', () => {
    const g = defaultGraph();
    const v = addModule(g, 'vfxcolormapper', {}, 0, 0, 'Color Mapper');
    expect(shownOuts(g, v.id, 'events')).toEqual([0, 1, 2, 3]);
    expect(connect(g, 'audio', IN, 0, v.id, 0)).toBeNull(); // VFX modules have no audio ports
    const e = connect(g, 'events', IN, 0, v.id, 0)!;
    expect(e).not.toBeNull();
    expect(connect(g, 'events', v.id, 9, OUT, 0)).toBeNull(); // To FL Studio takes audio only
    disconnect(g, e.id);
    expect(g.links.some((l) => l.id === e.id)).toBe(false);
    connect(g, 'events', IN, 0, v.id, 0);
    disconnectNode(g, v.id);
    expect(g.links.filter((l) => l.to === v.id)).toHaveLength(0);
    const a = addModule(g, 'pt-gain', {}, 900, 900, 'A');
    connect(g, 'audio', IN, 0, a.id, 0);
    connect(g, 'audio', a.id, 0, OUT, 0);
    autoArrange(g, 1000, 560);
    expect(g.io.in.x).toBeLessThan(g.modules[a.id].x);
    expect(g.modules[a.id].x).toBeLessThan(g.io.out.x);
    const n = normalizeFxParams('patcher', { [GRAPH_KEY]: { modules: { m7: { plugin: 'pt-gain' } }, links: [{ kind: 'audio', from: 'in', to: 'm7' }] } });
    const ng = n[GRAPH_KEY] as PatcherGraph;
    expect(ng.modules.m7.name).toBe('pt-gain');
    expect(ng.links).toHaveLength(1);
    expect(ng.next).toBeGreaterThan(7);
  });
});
