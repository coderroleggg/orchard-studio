// GMS (FL: GMS, Groove Machine Synth): registration (FL's 205 parameters and their mapping
// onto the engine's 212 internal values, value texts checked against test-host sweeps, 306
// factory presets, insertion state), the wave tables and the import of FL's Synth Waves, and
// the engine's behaviour. GMS renders silence in FL's test host (licence check), so the DSP
// (ported by static analysis) cannot be compared with FL's output; these tests check the
// port's invariants.
import { describe, it, expect, vi } from 'vitest';
import { genDef, genPresetState } from '../../src/model/gen/registry';
import { GmsPlugin, gmsPackWave, gmsUnpackWave } from '../../src/engine/gen/plugins/gms/plugin';
import { gmsSeed, gmsBeats } from '../../src/engine/gen/plugins/gms/core';
import { GMS_SYNTH_WAVES, gmsBuildTable, gmsSubstitute, gmsResample } from '../../src/engine/gen/plugins/gms/waves';
import { GMS_PRESET_NAMES, cfix, gmsChunkToState, gmsInsertState, gmsInternal, gmsMirror, type GmsStateLike } from '../../src/model/gen/plugins/gms/data';
import { newLevels } from '../../src/engine/gen/levels';
import type { GenEnv, GenNote } from '../../src/engine/gen/types';

// DSP renders: generous time when the whole suite runs concurrently
vi.setConfig({ testTimeout: 120_000 });

const D = genDef('gms')!;
const SR = 44100;

function note(key: number, vel: number, id: number): GenNote {
  const init = newLevels(), levels = newLevels();
  init.pitch = key * 100; init.vol = (Math.pow(11, vel / 100) - 1) / 10;
  levels.pitch = key * 100; levels.vol = 1; levels.pan = 0;
  return { id, key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

function render(params: Record<string, unknown>, notes: [number, number, number, number][], seconds: number, env?: GenEnv): { L: Float32Array; R: Float32Array; pl: GmsPlugin } {
  gmsSeed.v = 0;
  const pl = new GmsPlugin(SR, 512, env);
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
const preset = (i: number): Record<string, unknown> => genPresetState('gms', D.presets![i]);
/** The state with internal values changed (the FL parameters that view them mirrored, as the editor does). */
const withIv = (p: Record<string, unknown>, set: Record<number, number>): Record<string, unknown> => {
  const iv = (p.iv as number[]).slice();
  for (const [k, v] of Object.entries(set)) iv[Number(k)] = v;
  const q: GmsStateLike = { ...p, iv };
  gmsMirror(q);
  return q;
};
const dry = (p: Record<string, unknown>): Record<string, unknown> => withIv(p, { 147: 0, 148: 0, 149: 0, 150: 0, 151: 0, 152: 0, 153: 0, 154: 0, 155: 0, 156: 0, 206: 0 });

describe('GMS: registration', () => {
  it("has FL's 205 parameters (76 synth parameters, MIDI CC 0..127, channel aftertouch)", () => {
    expect(D.name).toBe('GMS');
    expect(D.category).toBe('Synth classic');
    expect([D.width, D.height]).toEqual([964, 414]);
    expect(D.defPoly).toBe(16);
    expect(D.params.length).toBe(205);
    expect(D.params[0].name).toBe('FX 1');
    expect(D.params[20].name).toBe('CHN: Mix Level');
    expect(D.params[63].name).toBe('SYNTH: Mix Oscllator 2');
    expect(D.params[75].name).toBe('SYNTH: Osc 3 Detune');
    expect(D.params[76].name).toBe('MIDI CC 0');
    expect(D.params[204].name).toBe('Chn. Aftertouch');
  });

  it("formats values with FL's texts (test-host sweeps)", () => {
    const fl: [number, number, string][] = [
      [11, 0, '0.00 % '], [11, 32, '0.12 % '], [11, 96, '0.38 % '], [11, 200, '0.78 % '], [12, 0, '1/8 '], [12, 32, '1/4 '],
      [12, 128, '3/4 '], [12, 200, '4/1 '], [12, 256, '8/1 '], [20, 0, '-60.0 dB '], [20, 200, '2.5 dB '], [20, 256, '20.0 dB '],
      [21, 32, '-75.0 % '], [21, 128, '0.0 % '], [21, 200, '56.2 % '], [22, 32, '-18 '], [22, 200, '13 '], [28, 96, '-6.2 dB '],
      [28, 200, '14.1 dB '], [37, 128, '0.00 % '], [37, 256, '1.00 % '], [56, 0, '1 '], [56, 96, '6 '], [56, 256, '16 '],
      [70, 32, '-27 '], [70, 200, '20 '], [71, 96, '-12 '], [71, 200, '28 '], [0, 200, '0.00 % '], [14, 256, '0.00 % '],
      [77, 32, '15'], [204, 192, '95'],
    ];
    for (const [i, raw, text] of fl) expect(D.params[i].format!(raw), `param ${i} at ${raw}`).toBe(text);
    expect(cfix(0.125, 2)).toBe('0.12');
    expect(cfix(-0.04, 1)).toBe('-0.0');
  });

  it('maps the synth parameters onto the internal values (selected effect, envelope, LFO)', () => {
    expect(gmsInternal(20, [0, 0, 0])).toBe(0);
    expect(gmsInternal(36, [0, 0, 0])).toBe(15);
    expect(gmsInternal(40, [0, 1, 0])).toBe(21);
    expect(gmsInternal(45, [0, 0, 1])).toBe(35);
    expect(gmsInternal(18, [7, 0, 0])).toBe(124);
    expect(gmsInternal(11, [9, 0, 0])).toBe(156);
    expect(gmsInternal(75, [0, 0, 0])).toBe(60);
    for (const i of [0, 9, 10, 14, 16, 35, 37, 38, 44, 49, 51, 53]) expect(gmsInternal(i, [0, 0, 0])).toBe(-1);
  });

  it("lists FL's 306 presets; the insertion state is FL's plugin database entry", () => {
    expect(D.presets!.length).toBe(306);
    expect(GMS_PRESET_NAMES).toContain('Basses/Agressive TE');
    const ins = gmsInsertState();
    expect(ins.waves).toEqual(['Beast.wav', 'Sine.wav', 'Saw.wav']);
    expect((ins.iv as number[])[150]).toBe(1);
    expect((ins.iv as number[])[154]).toBe(1);
    expect(D.params[20].def).toBe(192);
    expect(D.params[20].format!(D.params[20].def)).toBe('0.0 dB ');
    const st = preset(GMS_PRESET_NAMES.indexOf('Basses/Talking Bass'));
    expect(st.waves).toEqual(['Saw.wav', 'Square Smooth.wav', 'Saw.wav']);
  });

  it("decodes FL's state chunk ('4nyS': wave paths, selections, 212 floats)", () => {
    const b = new Uint8Array(0x1360);
    b.set([0x34, 0x6e, 0x79, 0x53]);
    const path = 'C:\\FL\\Plugins\\Fruity\\Generators\\GMS\\Synth Waves\\Square.wav';
    for (let i = 0; i < path.length; i++) b[4 + i] = path.charCodeAt(i);
    const dv = new DataView(b.buffer);
    dv.setInt32(0xe04, 3, true); dv.setInt32(0xe08, 1, true); dv.setInt32(0xe0c, 1, true);
    for (let k = 0; k < 212; k++) dv.setFloat32(0xe10 + 4 * k, k / 1000, true);
    const st = gmsChunkToState(b)!;
    expect(st.waves).toEqual(['Square.wav', '', '']);
    expect(st.sel).toEqual([3, 1, 1]);
    expect((st.iv as number[])[12]).toBe(Math.fround(0.012));
    expect(st.cutoff).toBe(Math.trunc(Math.fround(0.012) * 256));
    expect(st.envAttack).toBe(Math.trunc(Math.fround(0.021) * 256));
    expect(gmsChunkToState(b.subarray(0, 100))).toBeNull();
  });
});

describe('GMS: waves', () => {
  it('builds band-limited levels (level k holds harmonics 1..k + 1 at half amplitude, DC dropped)', () => {
    const saw = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) saw[i] = 1 - (2 * i) / 1024 + 0.3;
    const t = gmsBuildTable(saw);
    expect(t.length).toBe(512 * 1024);
    // level 0: one sine of the fundamental (amplitude |X1| / N)
    let pk = 0, mean = 0;
    for (let i = 0; i < 1024; i++) { pk = Math.max(pk, Math.abs(t[i])); mean += t[i]; }
    expect(Math.abs(mean / 1024)).toBeLessThan(1e-4);
    expect(pk).toBeGreaterThan(0.3);
    expect(pk).toBeLessThan(0.33);
    expect(gmsResample(saw)[0]).toBeCloseTo(saw[1], 5);
  });

  it("has a stand-in for each of FL's 29 Synth Waves and packs imported waves exactly", () => {
    expect(GMS_SYNTH_WAVES.length).toBe(29);
    for (const w of GMS_SYNTH_WAVES) {
      const x = gmsSubstitute(w);
      expect(x.length, w).toBe(1024);
      expect(x.every(Number.isFinite), w).toBe(true);
      expect(Math.max(...x.map(Math.abs)), w).toBeGreaterThan(0.5);
    }
    const w = gmsSubstitute('Saw.wav');
    const pack = gmsPackWave(w);
    expect(gmsUnpackWave(pack)).toEqual(w);
    const bad = pack.slice(); bad[10] += 0.25;
    expect(gmsUnpackWave(bad)).toBeNull();
  });
});

describe('GMS: engine', () => {
  it('is silent without notes and plays the insertion state', () => {
    expect(rms(render(preset(0), [], 0.2).L)).toBe(0);
    const ins = { ...D.state!(), ...Object.fromEntries(D.params.map((p) => [p.key, p.def])) } as Record<string, unknown>;
    const { L, R, pl } = render(ins, [[48, 100, 0.02, 0.5]], 1.2);
    expect(finite(L) && finite(R)).toBe(true);
    expect(rms(L, 2000, 20000)).toBeGreaterThan(1e-4);
    const d = render(dry(ins), [[48, 100, 0.02, 0.5]], 1.2);
    expect(rms(d.L, 2000, 20000)).toBeGreaterThan(0.005);
    expect(rms(d.L, 2000, 20000)).toBeLessThan(0.5);
    expect(pl.synth.voices.filter((v) => v.active).length).toBe(0);
  });

  it('is deterministic (the global LCG restarts with the process)', () => {
    const a = render(preset(10), [[57, 90, 0, 0.3], [64, 80, 0.05, 0.3]], 0.5);
    const b = render(preset(10), [[57, 90, 0, 0.3], [64, 80, 0.05, 0.3]], 0.5);
    expect(a.L).toEqual(b.L);
  });

  it('renders every factory preset with finite output', () => {
    let sounding = 0;
    for (let i = 0; i < D.presets!.length; i += 8) {
      const { L, R } = render(preset(i), [[48, 100, 0, 0.1], [60, 80, 0.02, 0.08]], 0.15);
      expect(finite(L) && finite(R), GMS_PRESET_NAMES[i]).toBe(true);
      expect(Math.max(...L.map(Math.abs)), GMS_PRESET_NAMES[i]).toBeLessThan(10);
      if (rms(L) > 1e-5) sounding++;
    }
    expect(sounding).toBeGreaterThan(25);
  }, 60000);

  it('limits polyphony to 16 (FPE_MaxPoly), plays one voice in mono, routes velocity', () => {
    const notes: [number, number, number, number][] = Array.from({ length: 20 }, (_, k) => [40 + k, 100, 0, 0.3]);
    const r = render(dry(preset(5)), notes, 0.05);
    expect(r.pl.synth.voices.filter((v) => v.active).length).toBe(16);
    const mono = withIv(dry(preset(5)), { 40: 1 });
    const m = render(mono, notes.slice(0, 4), 0.05);
    expect(m.pl.synth.voices.filter((v) => v.active).length).toBe(1);
    const S = m.pl.synth;
    S.iv[199] = 1; S.iv[198] = 1; S.iv[12] = 0.2; S.lastVel = 0.5;
    expect(S.mod(12)).toBeCloseTo(0.7, 6);
    expect(gmsBeats(0)).toBe(0.125);
    expect(gmsBeats(0.6)).toBe(1);
    expect(gmsBeats(1)).toBe(8);
  });

  it('glues the effects in order and uses imported waves', () => {
    const base = dry(preset(0));
    const a = render(base, [[50, 100, 0, 0.3]], 0.3);
    const b = render(withIv(base, { 147: 1, 117: 1 }), [[50, 100, 0, 0.3]], 0.3); // distortion glued, full drive
    expect(a.L).not.toEqual(b.L);
    expect(finite(b.L)).toBe(true);
    const sq = new Float32Array(1024).map((_, i) => (i < 512 ? 0.8 : -0.8));
    const env: GenEnv = { sample: (id) => (id === 'w' ? { channels: [gmsPackWave(sq)], sampleRate: 44100 } : undefined) };
    const c = render({ ...base, wavePool: { [(base.waves as string[])[0]]: 'w' } }, [[50, 100, 0, 0.3]], 0.3, env);
    expect(finite(c.L)).toBe(true);
    expect(c.L).not.toEqual(a.L);
  });
});

describe('GMS: editor', async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
  g.document ??= { body: {}, getElementById: () => null };
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const { genEditorFor } = await import('../../src/ui/plugins/genRegistry');
  const mod = await import('../../src/ui/plugins/gen/gms');
  const html = (params: Record<string, unknown>) => renderToStaticMarkup(
    createElement(FxEditorContext.Provider, { value: { slotId: 'ch:test', plugin: 'gms', params, trackName: 'GMS', pluginName: 'GMS' } }, createElement(mod.editor.Editor)),
  );

  it('renders the synth screen, the MIDI / EQ screen and the effect section', () => {
    expect(genEditorFor('gms')).toBe(mod.editor);
    const st0 = preset(0);
    const iv0 = (st0.iv as number[]).slice(); iv0[197] = 0;
    const st = { ...st0, iv: iv0 };
    const a = html(st);
    for (const t of ['WAVESHAPE', 'UNISONO', 'FILTER', 'LEVEL EG', 'FX LFO', 'GLUE', 'DIST', 'TRNC']) expect(a).toContain(t);
    const iv = (st.iv as number[]).slice(); iv[197] = 1;
    const b = html({ ...st, iv });
    for (const t of ['VELOCITY', 'AFTERTOUCH', 'PITCH BEND', 'EQ']) expect(b).toContain(t);
  });

  it('offers the FL Synth Waves import in the plugin menu', () => {
    const labels = mod.editor.menu!('ch:none').map((m) => m.label).filter(Boolean);
    expect(labels).toEqual(expect.arrayContaining(['Import FL Synth Waves...', 'Use the stand-in waves']));
  });
});
