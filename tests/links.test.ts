// Remote control links: controller plugin outputs driving parameters (model/links.ts, Engine.applyLinks).
import { describe, it, expect } from 'vitest';
import { Engine } from '../src/engine/Engine';
import { registerEffect } from '../src/engine/effects';
import type { EffectInstance } from '../src/engine/effects/types';
import { createChannel, createDefaultProject, createMixerTrack, createNote, createPattern, normalizeProject } from '../src/model/defaults';
import { defaultLfo, targetKey, type AutomationTarget } from '../src/model/automation';
import { mapLinkValue, normalizeLinks, MAPPING_PRESETS, type ControllerLink } from '../src/model/links';
import type { FxSlot, Project } from '../src/model/types';
import type { EngineStatus, FromEngine } from '../src/engine/protocol';

const SR = 48000;

// a controller whose output is its parameter `v` (0..1), and a second output 1 - v
registerEffect({
  id: 'test-ctrl',
  create: () => {
    const out = new Float64Array(2);
    return {
      tail: Infinity,
      setParams(p: unknown) { const v = Number((p as { v?: number }).v ?? 0); out[0] = v; out[1] = 1 - v; },
      process() {},
      reset() {},
      controls: () => out,
    } as EffectInstance;
  },
});

function ctrlSlot(v: number, id = 'ctl'): FxSlot {
  return { id, plugin: 'test-ctrl', name: 'Test ctrl', enabled: true, mix: 1, params: { v } };
}

function makeEngine(post?: (m: FromEngine) => void) {
  const e = new Engine({ sampleRate: SR, blockSize: 128, post });
  e.handle({ t: 'globals', g: { tempo: 120, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } });
  for (let i = 0; i < 127; i++) e.handle({ t: 'mixerTrack', tr: createMixerTrack(i) });
  const len = SR * 4;
  const s = new Float32Array(len);
  for (let i = 0; i < len; i++) s[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
  e.handle({ t: 'sample', id: 'tone', data: [s], sampleRate: SR });
  return e;
}

function rms(b: Float32Array, a = 0, z = b.length): number {
  let s = 0;
  for (let i = a; i < z; i++) s += b[i] * b[i];
  return Math.sqrt(s / Math.max(1, z - a));
}

/** A tone channel playing a long note in pattern mode, routed to `track`. */
function tone(e: Engine, track = 0) {
  const ch = createChannel('Tone', 'tone', track);
  ch.volume = 1;
  e.handle({ t: 'channel', c: ch });
  const pat = createPattern(1);
  pat.notes[ch.id] = [createNote({ pos: 0, len: 384 * 8 })];
  e.handle({ t: 'pattern', p: pat });
  e.handle({ t: 'mode', song: false, patternId: pat.id });
  return ch;
}

function link(target: AutomationTarget, formula = 'Input', output = 0, slotId = 'ctl', id = 'l1'): ControllerLink {
  return { id, target, source: { slotId, output }, formula };
}

describe('mapping formulas', () => {
  it('maps the controller value through the formula and clamps to 0..1', () => {
    expect(mapLinkValue('Input', 0.3)).toBeCloseTo(0.3, 12);
    expect(mapLinkValue('1-Input', 0.3)).toBeCloseTo(0.7, 12);
    expect(mapLinkValue('Input*2', 0.8)).toBe(1);
    expect(mapLinkValue('Input-1', 0.3)).toBe(0);
    expect(mapLinkValue('not a formula (', 0.4)).toBeCloseTo(0.4, 12); // invalid: 1:1
    expect(mapLinkValue('Input/0', 0.5)).toBe(1); // +inf clamps
    expect(mapLinkValue('0/0', 0.5)).toBe(0); // NaN -> 0
  });

  it("has FL's presets with valid formulas", () => {
    const byName = Object.fromEntries(MAPPING_PRESETS.map((p) => [p.label, p.formula]));
    expect(byName['Log scale']).toBe('Tension(Input,10)');
    expect(byName['Steppy']).toBe('Int(Input*9)/8');
    expect(mapLinkValue(byName['Switch'], 0.49)).toBe(0);
    expect(mapLinkValue(byName['Switch'], 0.51)).toBe(1);
    expect(mapLinkValue(byName['First half'], 1)).toBeCloseTo(0.5, 12);
    expect(mapLinkValue(byName['Last half'], 0)).toBeCloseTo(0.5, 12);
    for (const p of MAPPING_PRESETS) expect(Number.isFinite(mapLinkValue(p.formula, 0.37, undefined, true)), p.label).toBe(true);
  });
});

describe('controller links in the engine', () => {
  it('a controller output drives a linked channel volume through a formula, in pattern mode', () => {
    const e = makeEngine();
    const tr = createMixerTrack(5);
    tr.slots[0] = ctrlSlot(1);
    e.handle({ t: 'mixerTrack', tr });
    const ch = tone(e);
    const vol: AutomationTarget = { scope: 'channel', id: ch.id, path: 'volume', min: 0, max: 1, label: 'Tone - Channel volume' };
    e.handle({ t: 'links', list: [link(vol, '1-Input')] });
    e.handle({ t: 'play' });
    const [A] = e.renderOffline(SR / 2);
    // controller at 1 -> 1 - 1 = 0: silent after the first block
    expect(rms(A, 512, A.length)).toBeLessThan(1e-4);
    expect(e.linkCurrent.get(targetKey(vol))).toBe(0);
    // the controller moves: the volume follows (0.25 -> 0.75)
    e.handle({ t: 'mixerTrack', tr: { ...tr, slots: [ctrlSlot(0.25), ...tr.slots.slice(1)] } });
    const [B] = e.renderOffline(SR / 2);
    expect(rms(B, 2048, B.length)).toBeGreaterThan(0.05);
    expect(e.linkCurrent.get(targetKey(vol))).toBeCloseTo(0.75, 9);
  });

  it('drives a mixer EQ band gain, while stopped', () => {
    const e = makeEngine();
    const tr = createMixerTrack(5);
    tr.slots[0] = ctrlSlot(0);
    e.handle({ t: 'mixerTrack', tr });
    const band: AutomationTarget = { scope: 'mixer', id: '2', path: 'eq.1.gain', min: -18, max: 18, label: 'Insert 2 - EQ band 2 gain' };
    // Input*0.5: controller 0 -> -18 dB, 1 -> 0 dB
    e.handle({ t: 'links', list: [link(band, 'Input*0.5')] });
    e.renderOffline(1024);
    expect(e.linkCurrent.get(targetKey(band))).toBeCloseTo(-18, 9);
    e.handle({ t: 'mixerTrack', tr: { ...tr, slots: [ctrlSlot(1), ...tr.slots.slice(1)] } });
    e.renderOffline(1024);
    expect(e.linkCurrent.get(targetKey(band))).toBeCloseTo(0, 9);
    // the engine's model of insert 2 carries the linked value
    const m = (e as unknown as { mxModels: { eq: { gain: number }[] }[] }).mxModels[2];
    expect(m.eq[1].gain).toBeCloseTo(0, 9);
  });

  it('the EQ band link changes the sound of a routed channel', () => {
    const e = makeEngine();
    const tr = createMixerTrack(5);
    tr.slots[0] = ctrlSlot(1);
    e.handle({ t: 'mixerTrack', tr });
    tone(e, 2);
    // band 2 (peaking) centred on the 440 Hz tone: -18 dB vs 0 dB
    const band: AutomationTarget = { scope: 'mixer', id: '2', path: 'eq.1.gain', min: -18, max: 18, label: 'band' };
    e.handle({ t: 'mixerTrack', tr: { ...createMixerTrack(2), eq: [{ gain: 0, freq: 0.0882, width: 0.267 }, { gain: 0, freq: 0.282854, width: 0.267 }, { gain: 0, freq: 0.8518, width: 0.267 }] } });
    e.handle({ t: 'play' });
    const [A] = e.renderOffline(SR / 4);
    e.handle({ t: 'links', list: [link(band, '1-Input')] }); // controller 1 -> 0 -> -18 dB
    e.renderOffline(SR / 8);
    const [B] = e.renderOffline(SR / 4);
    expect(rms(B)).toBeLessThan(rms(A, 2048) * 0.7);
  });

  it('removing the link stops it; the parameter keeps its last value', () => {
    const e = makeEngine();
    const tr = createMixerTrack(5);
    tr.slots[0] = ctrlSlot(0.5);
    e.handle({ t: 'mixerTrack', tr });
    const ch = tone(e);
    const vol: AutomationTarget = { scope: 'channel', id: ch.id, path: 'volume', min: 0, max: 1, label: 'vol' };
    e.handle({ t: 'links', list: [link(vol)] });
    e.renderOffline(512);
    expect(e.linkCurrent.get(targetKey(vol))).toBeCloseTo(0.5, 9);
    e.handle({ t: 'links', list: [] });
    e.handle({ t: 'mixerTrack', tr: { ...tr, slots: [ctrlSlot(0.9), ...tr.slots.slice(1)] } });
    e.renderOffline(512);
    expect(e.linkCurrent.size).toBe(0);
    const model = (e as unknown as { chModels: Map<string, { volume: number }> }).chModels.get(ch.id)!;
    expect(model.volume).toBeCloseTo(0.5, 9);
  });

  it('follows the second output of a controller and reports values to the UI', () => {
    const status: EngineStatus[] = [];
    const e = makeEngine((m) => { if (m.t === 'status') status.push(m); });
    const tr = createMixerTrack(5);
    tr.slots[0] = ctrlSlot(0.2);
    e.handle({ t: 'mixerTrack', tr });
    const pan: AutomationTarget = { scope: 'mixer', id: '1', path: 'pan', min: -1, max: 1, label: 'Insert 1 - Panning' };
    e.handle({ t: 'links', list: [link(pan, 'Input', 1)] }); // output 1 = 1 - 0.2 = 0.8 -> pan +0.6
    e.renderOffline(SR / 10);
    const reported = status.flatMap((s) => s.auto ?? []).filter(([k]) => k === targetKey(pan));
    expect(reported.length).toBe(1); // sent once: the value does not change
    expect(reported[0][1]).toBeCloseTo(0.6, 9);
  });

  it('a linked control follows the controller: its automation clips are ignored', () => {
    const e = makeEngine();
    const tr = createMixerTrack(5);
    tr.slots[0] = ctrlSlot(1);
    e.handle({ t: 'mixerTrack', tr });
    const ch = tone(e);
    const vol: AutomationTarget = { scope: 'channel', id: ch.id, path: 'volume', min: 0, max: 1, label: 'vol' };
    // a clip holding the volume at 0 for the whole song
    e.handle({ t: 'automation', list: [{ id: 'a', name: 'vol', color: '#888', enabled: true, target: vol, points: [{ pos: 0, value: 0, tension: 0, mode: 'single' }, { pos: 3840, value: 0, tension: 0, mode: 'single' }], length: 3840, loop: false, min: 0, max: 1, lfo: defaultLfo() }], init: [] });
    const tracks = Array.from({ length: 2 }, (_, i) => ({ id: 't' + i, name: 'T', color: '#485156', height: 1, enabled: true, locked: false }));
    const pat = createPattern(2);
    pat.notes[ch.id] = [createNote({ pos: 0, len: 3840 })];
    e.handle({ t: 'pattern', p: pat });
    e.handle({ t: 'playlist', tracks, clips: [
      { id: 'p', track: 0, kind: 'pattern', patternId: pat.id, start: 0, length: 3840, offset: 0, muted: false },
      { id: 'c', track: 1, kind: 'automation', patternId: '', autoId: 'a', start: 0, length: 3840, offset: 0, muted: false },
    ] });
    e.handle({ t: 'links', list: [link(vol)] });
    e.handle({ t: 'mode', song: true, patternId: pat.id });
    e.handle({ t: 'play' });
    const [A] = e.renderOffline(SR / 2);
    expect(rms(A, 2048)).toBeGreaterThan(0.05); // the controller (1) wins over the clip (0)
    expect(e.automation.isLinked(targetKey(vol))).toBe(true);
    // unlinked: the clip drives the control again
    e.handle({ t: 'links', list: [] });
    e.handle({ t: 'seek', tick: 0 });
    const [B] = e.renderOffline(SR / 2);
    expect(rms(B, 2048)).toBeLessThan(1e-3);
  });

  it('smoothing glides toward the mapped value', () => {
    const e = makeEngine();
    const tr = createMixerTrack(5);
    tr.slots[0] = ctrlSlot(0);
    e.handle({ t: 'mixerTrack', tr });
    const vol: AutomationTarget = { scope: 'mixer', id: '3', path: 'volume', min: 0, max: 1, label: 'v' };
    e.handle({ t: 'links', list: [{ ...link(vol), smooth: true, smoothTime: 469 }] });
    e.renderOffline(256);
    e.handle({ t: 'mixerTrack', tr: { ...tr, slots: [ctrlSlot(1), ...tr.slots.slice(1)] } });
    e.renderOffline(SR / 100); // 10 ms of a 200 ms glide
    const mid = e.linkCurrent.get(targetKey(vol))!;
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(0.5);
    e.renderOffline(SR); // settled
    expect(e.linkCurrent.get(targetKey(vol))).toBeCloseTo(1, 4);
  });
});

describe('sidechain ducking with the Peak Controller', () => {
  it("a Peak Controller on a track ducks another track's volume while the signal plays", () => {
    const e = makeEngine();
    // the tone plays into insert 2, which carries a Peak Controller (muted: only its output is used)
    const tr2 = createMixerTrack(2);
    tr2.slots[0] = { id: 'pk', plugin: 'peakctrl', name: 'Peak Controller', enabled: true, mix: 1, params: { base: 0, vol: 179, tension: 0, decay: 128, lfoBase: 0, lfoVol: 0, lfoTension: 0, lfoSpeed: 32950, lfoShape: 0, lfoPhase: 0, mute: true, ramp: false } };
    e.handle({ t: 'mixerTrack', tr: tr2 });
    const ch = tone(e, 2);
    const vol: AutomationTarget = { scope: 'mixer', id: '3', path: 'volume', min: 0, max: 1, label: 'Insert 3 - Volume' };
    e.handle({ t: 'links', list: [link(vol, '1-Input', 1, 'pk')] });
    e.renderOffline(SR / 4); // stopped: the note does not play, insert 3 stays up
    expect(e.linkCurrent.get(targetKey(vol))).toBe(1);
    e.handle({ t: 'play' });
    e.renderOffline(SR / 4); // the tone (0.5, about 0.35 per side after the centre pan law): volume = 1 - peak
    const ducked = e.linkCurrent.get(targetKey(vol))!;
    expect(ducked).toBeGreaterThan(0.55);
    expect(ducked).toBeLessThan(0.75);
    e.handle({ t: 'channel', c: { ...ch, volume: 0 } }); // the signal stops; the peak decays at full speed
    e.renderOffline(SR / 4);
    expect(e.linkCurrent.get(targetKey(vol))).toBe(1);
  });
});

describe('links in projects', () => {
  function project(): Project {
    const p = createDefaultProject({}, {});
    p.mixer.tracks[5].slots[0] = ctrlSlot(0.5);
    p.links = [link({ scope: 'mixer', id: '1', path: 'volume', min: 0, max: 1, label: 'Insert 1 - Volume' }, 'Tension(Input,10)')];
    return p;
  }

  it('survive save (JSON) and normalize', () => {
    const p = normalizeProject(JSON.parse(JSON.stringify(project())) as Project);
    expect(p.links).toHaveLength(1);
    expect(p.links![0]).toMatchObject({ id: 'l1', source: { slotId: 'ctl', output: 0 }, formula: 'Tension(Input,10)', smoothTime: 469 });
    expect(p.links![0].target).toMatchObject({ scope: 'mixer', id: '1', path: 'volume', min: 0, max: 1 });
  });

  it('old saves get an empty list; links to removed controllers and malformed entries are dropped', () => {
    const old = project() as Partial<Project>;
    delete old.links;
    expect(normalizeProject(old as Project).links).toEqual([]);
    const p = project();
    p.mixer.tracks[5].slots[0] = null;
    expect(normalizeProject(p).links).toEqual([]);
    expect(normalizeLinks([{ id: 'x' }, null, { id: 'y', target: { scope: 'mixer', id: '1', path: 'pan', min: -1, max: 1, label: '' }, midi: { port: -1, chan: 3, ctrl: 7 } }], () => false))
      .toEqual([{ id: 'y', target: { scope: 'mixer', id: '1', path: 'pan', min: -1, max: 1, label: '' }, midi: { port: -1, chan: 3, ctrl: 7, omni: false, mode: 0 }, formula: 'Input', smoothTime: 469 }]);
  });
});
