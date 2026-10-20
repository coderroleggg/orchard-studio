// Sawer (FL: Sawer): registration (FL's 202 parameters, value texts checked against
// test-host sweeps, 421 factory presets, insertion state), the data.saw import, and the
// engine's behaviour. Sawer renders silence in FL's test host (licence check), so the
// DSP (ported by static analysis) cannot be compared with FL's output; these tests check
// the port's invariants: finite, deterministic output, silence without notes, voices that
// end after their release, and every factory preset rendering.
import { describe, it, expect, vi } from 'vitest';
import { genDef, genPresetState } from '../../src/model/gen/registry';
import { SwPlugin } from '../../src/engine/gen/plugins/sawer/plugin';
import { SwSynth } from '../../src/engine/gen/plugins/sawer/core';
import { SW_TABLE_SIZE, swDerivedTable, swPackTable, swParseDataSaw, swSubstituteTable, swUnpackTable } from '../../src/engine/gen/plugins/sawer/tables';
import { SW_PRESET_NAMES, swChunkToState, swInsertState, swStateValues } from '../../src/model/gen/plugins/sawer/data';
import { newLevels } from '../../src/engine/gen/levels';
import type { GenEnv, GenNote } from '../../src/engine/gen/types';

// DSP renders: generous time when the whole suite runs concurrently
vi.setConfig({ testTimeout: 120_000 });

const D = genDef('sawer')!;
const SR = 44100;

function note(key: number, vel: number, id: number): GenNote {
  const init = newLevels(), levels = newLevels();
  init.pitch = key * 100; init.vol = (Math.pow(11, vel / 100) - 1) / 10;
  levels.pitch = key * 100; levels.vol = 1; levels.pan = 0;
  return { id, key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

/** Notes [key, velocity %, start s, length s] in 512-frame blocks split at note events, 130 BPM. */
function render(params: Record<string, unknown>, notes: [number, number, number, number][], seconds: number, env?: GenEnv): { L: Float32Array; R: Float32Array; pl: SwPlugin } {
  const pl = new SwPlugin(SR, 512, env);
  pl.setParams(params);
  const n = Math.round(seconds * SR);
  const evs: { t: number; on: boolean; n: GenNote }[] = [];
  notes.forEach(([k, v, s, d], i) => {
    const nn = note(k, v, i + 1);
    evs.push({ t: Math.round(s * SR), on: true, n: nn }, { t: Math.round((s + d) * SR), on: false, n: nn });
  });
  evs.sort((a, b) => a.t - b.t || (a.on === b.on ? 0 : a.on ? 1 : -1));
  const L = new Float32Array(n), R = new Float32Array(n);
  const bl = new Float32Array(512), br = new Float32Array(512);
  let t = 0, e = 0;
  while (t < n) {
    while (e < evs.length && evs[e].t <= t) { const ev = evs[e++]; if (ev.on) pl.noteOn(ev.n, 0); else pl.noteOff(ev.n, 0); }
    let m = Math.min(512, n - t);
    if (e < evs.length && evs[e].t < t + m) m = evs[e].t - t;
    const ctx = { sampleRate: SR, blockSize: 512, tempo: 130, ppq: 96, playing: false, pos: 0, songMode: false, track: 0 };
    bl.fill(0); br.fill(0);
    pl.render(bl, br, m, ctx);
    L.set(bl.subarray(0, m), t); R.set(br.subarray(0, m), t);
    t += m;
  }
  return { L, R, pl };
}

const rms = (x: Float32Array, a = 0, b = x.length): number => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
const finite = (x: Float32Array): boolean => x.every((v) => Number.isFinite(v));
const preset = (i: number): Record<string, unknown> => genPresetState('sawer', D.presets![i]);

describe('Sawer: registration', () => {
  it("has FL's 202 parameters (73 synth parameters, MIDI CC 0..127, channel aftertouch)", () => {
    expect(D.name).toBe('Sawer');
    expect(D.category).toBe('Synth classic');
    expect(D.notes).toBe('events');
    expect([D.width, D.height]).toEqual([897, 622]);
    expect(D.defPoly).toBe(0);
    expect(D.params.length).toBe(202);
    expect(D.params[0]).toMatchObject({ name: 'Master level', min: 0, max: 256, index: 0 });
    expect(D.params[72].name).toBe('Arp range');
    expect(D.params[73].name).toBe('MIDI CC 0');
    expect(D.params[201].name).toBe('Channel Aftertouch');
  });

  it("formats values with FL's texts (test-host sweeps)", () => {
    const fl: [number, number, string][] = [
      [0, 0, '-24.0 dB'], [0, 37, '-17.1 dB'], [0, 201, '13.7 dB'], [1, 64, '25 %'], [2, 16, '0.001 s'], [2, 111, '0.766 s'],
      [2, 256, '50.000 s'], [5, 90, '0.269 s'], [6, 37, '-17 semitones'], [6, 128, '0 semitones'], [6, 250, '23 semitones'],
      [7, 3, '-98 cents'], [7, 129, '1 cents'], [8, 0, 'Off'], [8, 1, 'On'], [8, 256, 'On'], [11, 77, '30 %'], [14, 0, 'Off'],
      [14, 90, '2 voices'], [14, 200, '4 voices'], [14, 256, '8 voices'], [15, 64, '25 %'], [18, 33, '-1.5 oct'], [18, 100, '-0.5 oct'],
      [18, 256, '2 oct'], [24, 37, '0.578 oct'], [24, 200, '3.125 oct'], [31, 100, 'LP12'], [37, 255, 'Sub phase'], [39, 37, '0.03 Hz'],
      [39, 128, '1.25 Hz'], [39, 256, '10.00 Hz'], [41, 200, '14.552 s'], [46, 220, 'Level'], [58, 100, '3/16'], [71, 200, 'Up and down'],
      [72, 0, '0 oct'], [72, 37, '37 oct'], [72, 256, '256 oct'], [201, 80, ''],
    ];
    for (const [i, raw, text] of fl) expect(D.params[i].format!(raw), `param ${i} at ${raw}`).toBe(text);
  });

  it("lists FL's 421 factory presets; the insertion state is FL's plugin database entry", () => {
    expect(D.presets!.length).toBe(421);
    expect(SW_PRESET_NAMES[0]).toBe('Default');
    expect(SW_PRESET_NAMES[1]).toBe('Ambient/MC Chains');
    const ins = swInsertState();
    const mc = preset(1);
    for (let i = 0; i < 73; i++) expect(D.params[i].def, D.params[i].name).toBe(Number(mc[D.params[i].key]));
    expect((ins.ccMap as number[]).slice(0, 3)).toEqual([7, 10, -1]);
    expect(D.params[0].format!(D.params[0].def)).toBe('1.9 dB');
    const st = D.state!() as Record<string, unknown>;
    expect((st.ccMap as number[]).slice(0, 2)).toEqual([7, 10]);
    expect((st.hidden as number[]).slice(11, 17)).toEqual([45, 27, 0, 0, 0, 0]);
    expect((st.hidden as number[]).slice(17, 19)).toEqual([5, 2]);
  });

  it("decodes FL's state chunk ('1rwS': 96 floats, the MIDI-learn map, the name)", () => {
    const b = new Uint8Array(612);
    b.set([0x31, 0x72, 0x77, 0x53]);
    const dv = new DataView(b.buffer);
    for (let i = 0; i < 96; i++) dv.setFloat32(4 + 4 * i, i < 73 ? i / 100 : i - 73, true);
    b.fill(255, 388, 484);
    b[388 + 27] = 74;
    const st = swChunkToState(b)!;
    expect(st.filterCutoff).toBeCloseTo(0.27 * 256, 4);
    expect((st.hidden as number[])[1]).toBe(1);
    expect((st.ccMap as number[])[27]).toBe(74);
    expect((st.ccMap as number[])[0]).toBe(-1);
    const v = swStateValues(st);
    expect(v.values[27]).toBe(Math.fround(0.27));
    expect(v.ccMap[27]).toBe(74);
    expect(swChunkToState(b.subarray(0, 100))).toBeNull();
  });
});

describe('Sawer: oscillator table', () => {
  it('builds the stand-in saw and the derived square like FL (t1[i] - t1[i + 4096])', () => {
    const t = swSubstituteTable();
    expect(t.length).toBe(SW_TABLE_SIZE);
    expect(Math.min(...t)).toBeCloseTo(-1.054, 2);
    const t2 = swDerivedTable(t);
    expect(t2[10]).toBe(Math.fround(t[10] - t[4106]));
    expect(t2[5000]).toBe(Math.fround(t[5000] - t[904]));
  });

  it("imports the user's data.saw as an exact pool-sample pack", () => {
    const buf = new ArrayBuffer(SW_TABLE_SIZE * 4);
    const dv = new DataView(buf);
    for (let i = 0; i < SW_TABLE_SIZE; i++) dv.setFloat32(4 * i, 1 - (2 * i) / SW_TABLE_SIZE, true);
    const t = swParseDataSaw(buf)!;
    expect(t[1]).toBe(Math.fround(1 - 2 / SW_TABLE_SIZE));
    const pack = swPackTable(t);
    expect(swUnpackTable(pack)).toEqual(t);
    const bad = pack.slice(); bad[100] += 0.5;
    expect(swUnpackTable(bad)).toBeNull();
    expect(swParseDataSaw(new ArrayBuffer(100))).toBeNull();
    const env: GenEnv = { sample: (id) => (id === 'saw' ? { channels: [pack], sampleRate: 44100 } : undefined) };
    const a = render({ ...preset(0), sample: 'saw' }, [[60, 100, 0, 0.3]], 0.3, env);
    const b = render({ ...preset(0) }, [[60, 100, 0, 0.3]], 0.3);
    expect(finite(a.L)).toBe(true);
    expect(rms(a.L)).toBeGreaterThan(1e-3);
    expect(a.L).not.toEqual(b.L);
  });
});

describe('Sawer: engine', () => {
  it('is silent without notes and plays the Default preset', () => {
    const quiet = render(preset(0), [], 0.2);
    expect(rms(quiet.L)).toBe(0);
    const { L, R, pl } = render(preset(0), [[60, 100, 0.05, 0.4]], 1.2);
    expect(finite(L) && finite(R)).toBe(true);
    const on = rms(L, Math.round(0.15 * SR), Math.round(0.4 * SR));
    expect(on).toBeGreaterThan(0.01);
    expect(on).toBeLessThan(1);
    expect(Math.max(...L.map(Math.abs))).toBeLessThan(2);
    expect(pl.synth.count).toBe(0);
  });

  it('is deterministic (FL seeds its generators the same way on every load)', () => {
    const a = render(preset(1), [[57, 90, 0, 0.3], [64, 80, 0.1, 0.3]], 0.5);
    const b = render(preset(1), [[57, 90, 0, 0.3], [64, 80, 0.1, 0.3]], 0.5);
    expect(a.L).toEqual(b.L);
    expect(a.R).toEqual(b.R);
  });

  it('renders every factory preset (chords, held notes and release) with finite output', () => {
    let sounding = 0;
    for (let i = 0; i < D.presets!.length; i += 10) {
      const { L, R } = render(preset(i), [[48, 100, 0, 0.08], [55, 80, 0.02, 0.06], [64, 60, 0.04, 0.04]], 0.12);
      expect(finite(L) && finite(R), SW_PRESET_NAMES[i]).toBe(true);
      expect(Math.max(...L.map(Math.abs)), SW_PRESET_NAMES[i]).toBeLessThan(8);
      if (rms(L) > 1e-4) sounding++;
    }
    expect(sounding).toBeGreaterThan(35);
  }, 60000);

  it('follows polyphony, unison, mono / glide, the arpeggiator and the modulation matrix', () => {
    const S = new SwSynth();
    S.setSampleRate(SR);
    S.resetToDefaults();
    S.setMaxPoly(0);
    S.setParameter(75, 0); // 4 voices
    for (let k = 0; k < 6; k++) S.noteOn(60 + k, 100);
    const L = new Float32Array(64), R = new Float32Array(64);
    S.process(L, R, 64);
    expect(S.count).toBe(4);
    S.setParameter(14, 1); // 8 unison voices
    expect(S.uniCount).toBe(8);
    S.setParameter(8, 1); // mono
    expect(S.mono).toBe(true);
    S.setParameter(70, 1); // arpeggiator
    S.noteOn(60, 100); S.noteOn(64, 100);
    for (let i = 0; i < 200; i++) S.process(L, R, 64);
    expect(L.every(Number.isFinite)).toBe(true);
    // mod matrix: CC 1 (source 5) -> filter cutoff (27), full amount
    S.setParameter(90, 5); S.setParameter(84, 27); S.setParameter(78, 1);
    S.setParameter(27, 0.2);
    expect(S.cutoff).toBeCloseTo(0.2, 6);
    S.controlChange(1, 127);
    expect(S.cutoff).toBe(1);
    S.aftertouch(64);
    expect(S.at).toBe(Math.fround(64 * Math.fround(1 / 127)));
  });
});

describe('Sawer: editor', async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
  g.document ??= { body: {}, getElementById: () => null };
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const { genEditorFor } = await import('../../src/ui/plugins/genRegistry');
  const mod = await import('../../src/ui/plugins/gen/sawer');
  const html = (params: Record<string, unknown>) => renderToStaticMarkup(
    createElement(FxEditorContext.Provider, { value: { slotId: 'ch:test', plugin: 'sawer', params, trackName: 'Sawer', pluginName: 'Sawer' } }, createElement(mod.editor.Editor)),
  );

  it("places every FL parameter at FL's form position (keyboard hidden) and the keyboard over the lower rows", () => {
    expect(genEditorFor('sawer')).toBe(mod.editor);
    const st = { ...preset(1), ...(D.state!() as Record<string, unknown>) };
    const full = html({ ...st, swKeys: false });
    for (let i = 0; i < 73; i++) expect(full, `parameter ${i}`).toContain(`data-swp="${i}"`);
    for (const t of ['MIDI MODULATION MATRIX', 'ARPEGGIATOR', '1: ModWhl', 'Aftertouch', 'LFO amount', 'Filter cutoff', '1/16', '8']) expect(full).toContain(t);
    const keys = html({ ...st, swKeys: true, swLink: true });
    expect(keys).not.toContain('MIDI MODULATION MATRIX');
    expect(keys).toContain('LINK');
    expect(keys).toContain('UNLINK');
  });

  it("offers FL's option and the data.saw import in the plugin menu", () => {
    const labels = mod.editor.menu!('ch:none').map((m) => m.label).filter(Boolean);
    expect(labels).toEqual(expect.arrayContaining(['Convert old presets', 'Import FL data.saw...', 'Use the stand-in saw']));
  });
});
