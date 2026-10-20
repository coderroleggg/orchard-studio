// Drumaxx (FL: Drumaxx): registration (FL's parameters, value texts, 131 kits,
// the plugin database state), the sound pinned to FL 2026's renders (test host,
// 44.1 kHz, 130 BPM, raw channel: the engine renders FL's output bit for bit,
// docs/research/gen/drumaxx.md), mixer routing and the editor.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { genDef, genPresetState, defaultGenParams, formatParam, genInCategory } from '../../src/model/gen/registry';
import { createGen } from '../../src/engine/gen';
import { newLevels, setInitLevels } from '../../src/engine/gen/levels';
import type { GenNote } from '../../src/engine/gen/types';
import { createGenChannel } from '../../src/model/defaults';
import { makeEngine, play, rms } from './util';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
g.document ??= { body: {}, getElementById: () => null };

const D = genDef('drumaxx')!;
const SR = 44100;
const P = (key: string) => D.params.find((q) => q.key === key)!;

let ids = 0;
function note(key: number, vel = 100): GenNote {
  const init = newLevels(), levels = newLevels();
  setInitLevels(init, (key - 60) * 100, vel, 0, 0, 0);
  Object.assign(levels, init);
  levels.vol = 1;
  return { id: ++ids, key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

/** Notes as FL's test host plays them: [key, velocity, start s, duration s]. */
type N = [number, number, number, number];

/** Render like FL's test host: blocks of 512 frames, restarted at every note event. */
function render(params: Record<string, unknown>, notes: N[], frames: number, out?: (t: number, l: Float32Array, r: Float32Array, n: number) => void): [Float32Array, Float32Array] {
  const gen = createGen('drumaxx', SR, 512, { sample: () => undefined })!;
  gen.setParams(params);
  const evs = notes.map(([k, v, s, d]) => ({ n: note(k, v), at: Math.round(s * SR), off: Math.round((s + d) * SR) }));
  const outL = new Float32Array(frames), outR = new Float32Array(frames);
  const L = new Float32Array(512), R = new Float32Array(512);
  const times = [...new Set(evs.flatMap((e) => [e.at, e.off]))].sort((a, b) => a - b);
  for (let b = 0; b < frames;) {
    let n = Math.min(512, frames - b);
    for (const t of times) if (t > b && t < b + n) { n = t - b; break; }
    for (const e of evs) {
      if (e.off === b) gen.noteOff!(e.n, 0);
      if (e.at === b) gen.noteOn!(e.n, 0);
    }
    L.fill(0); R.fill(0);
    gen.render!(L, R, n, { sampleRate: SR, blockSize: 512, tempo: 130, ppq: 96, playing: true, pos: 0, songMode: false, track: 7, out });
    outL.set(L.subarray(0, n), b); outR.set(R.subarray(0, n), b);
    b += n;
  }
  return [outL, outR];
}

const kit = (name: string) => genPresetState('drumaxx', D.presets!.find((p) => p.name === name)!) as Record<string, unknown>;
const expectAt = (x: Float32Array, idx: number[], fl: number[]) => idx.forEach((i, j) => expect(x[i]).toBeCloseTo(fl[j], 8));

describe('Drumaxx: registration', () => {
  it('has FL\'s parameters: 16 pads x 43, then the master section', () => {
    expect(D.name).toBe('Drumaxx');
    expect(genInCategory('Drum').map((d) => d.id)).toContain('drumaxx');
    expect(D.notes).toBe('events');
    expect([D.width, D.height]).toEqual([762, 614]);
    expect(D.params.length).toBe(16 * 43 + 14);
    expect(P('p1_vol')).toMatchObject({ name: 'Channel 1: Volume', index: 0, min: 0, max: 256 });
    expect(P('p1_key')).toMatchObject({ name: 'Channel 1: Key', index: 4, max: 126 });
    expect(P('p16_velValue4')).toMatchObject({ name: 'Channel 16: Velocity mod 4 value', index: 44 * 15 + 42 });
    expect(P('master')).toMatchObject({ name: 'Master Level', index: 705 });
    expect(P('limRelease')).toMatchObject({ name: 'Limiter Release', index: 718 });
  });

  it('writes FL\'s value texts (FL\'s readout of the Cinematikit 2 FG kit)', () => {
    const t = (k: string, v: number) => formatParam(P(k), v);
    expect([t('p1_vol', 158.72), t('p1_pan', 179.2), t('p1_tension', 103.04), t('p1_midLevel', 128), t('p1_velValue1', 179.84)]).toEqual(['61.7%', '39.8%', '40.2%', '0.0%', '69.9%']);
    expect([t('p1_key', 48), t('p2_key', 47), t('p1_key', 60), t('p1_key', 84)]).toEqual(['C4 - Hi-Mid Tom', 'B3 - Low-Mid Tom', 'C5 - Hi Bongo', 'C7']);
    expect([t('p1_retrig', 85.33333587646484), t('p9_retrig', 170.6666717529297), t('p1_retrig', 256), t('p1_malletRetrig', 256)]).toEqual(['0', 'II', 'III', 'On']);
    expect([t('p1_velTarget1', 1), t('p1_velTarget3', 2), t('p1_velTarget2', 0)]).toEqual([' Mallet Amplitude', ' Mallet Decay', ' ---']);
    expect([t('master', 71.68), t('swing', 64), t('eqOn', 256), t('eq1', 143.36), t('eq2', 153.6), t('limOn', 0), t('limGain', 11.26), t('limRelease', 256)])
      .toEqual(['27.7%', '25.0%', 'On', '11.7%', '19.5%', 'Off', '4.3%', '100.0%']);
  });

  it('has FL\'s 131 kits; a fresh instance is FL\'s plugin database Default Kit', () => {
    expect(D.presets!.length).toBe(131);
    expect(new Set(D.presets!.map((p) => p.name.split('/')[0]))).toEqual(new Set(['Acoustic', 'Dance', 'Drum and Bass', 'Electro', 'Hip Hop', 'Industrial', 'Lo-Fi', 'Percussion', 'Special']));
    const s = defaultGenParams('drumaxx');
    expect([s.p1_key, s.p2_key, s.p9_key, (s.padNames as string[])[0], (s.patterns as { key: number }[])[0].key]).toEqual([36, 38, 37, 'Bassdrum', 60]);
    // version 3 kits store Retrig as a count: FL's loader scales it by 1/3
    expect(kit('Special/Cinematikit 2 FG').p1_retrig).toBe(Math.fround(1 / 3) * 256);
    expect(kit('Acoustic/Funky MC').p9_retrig).toBe(Math.fround(2 * Math.fround(1 / 3)) * 256);
    expect(kit('Dance/Garage Stylee FG').p6_retrig).toBe(256);
    expect(kit('Special/Default').p9_retrig).toBe(Math.fround(2 / 3) * 256);
  });
});

describe('Drumaxx: sound (FL\'s renders)', () => {
  it('a fresh instance: pads, layered keys, velocities, note offs', () => {
    const [L, R] = render(defaultGenParams('drumaxx'), [[36, 100, 0, 0.5], [38, 80, 0.25, 0.3], [42, 127, 0.5, 0.2]], 30001);
    const idx = [100, 700, 1500, 3000, 6000, 11100, 11500, 14000, 22100, 23000, 30000];
    expectAt(L, idx, [0, -0.0483038276, -0.140939653, -0.183695287, 0.0302822702, -0.00781256519, 0.0776637197, -0.00325620407, 0.00138343871, -0.0165824406, -0.00137496553]);
    expectAt(R, idx, [0, -0.0483038276, -0.140939653, -0.183695287, 0.0302822702, -0.00781256519, 0.0718050897, -0.00299687102, 0.00160599675, -0.0194869731, -0.00204486051]);
  });

  it('pad 1\'s retrigger settings for every pad (FL\'s engine), a version 3 kit\'s Retrig, the EQ', () => {
    const [L, R] = render(kit('Special/Cinematikit 2 FG'), [[36, 100, 0, 0.3]], 20001);
    const fl = [-0.0691491887, -0.0753655136, 0.0594001524, -0.0216258168, -0.00374103943, 0.000855182996, -0.026404541, -0.00794650242];
    expectAt(L, [2000, 5000, 9000, 10749, 11219, 12000, 13000, 20000], fl);
    expectAt(R, [2000, 5000, 9000, 10749, 11219, 12000, 13000, 20000], fl);
  });

  it('the sequencer: a trigger key plays its pattern (swing, tempo)', () => {
    const [L, R] = render(kit('Special/Cinematikit 2 FG'), [[60, 100, 0, 2]], 88001);
    const idx = [3000, 10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000, 88000];
    expectAt(L, idx, [-0.0205303561, -0.0812789872, 0.0487752743, 0.0444035307, -0.0332584381, -0.0136978058, -0.0313367322, 0.0327608883, -0.0468332618, 0.0608533435]);
    expectAt(R, idx, [-0.00880066305, -0.0349027067, 0.0449447408, 0.044338312, -0.0230906811, -0.00472126901, 0.00785810873, -0.0317823067, -0.0780819952, 0.039351847]);
  });

  it('cut groups, the limiter, EQ and a pattern together', () => {
    const [L, R] = render(kit('Dance/Dance 05 MC'), [[36, 110, 0, 0.3], [38, 90, 0.1, 0.2], [42, 100, 0.2, 0.1], [60, 100, 0.4, 1]], 70001);
    const idx = [500, 3000, 6000, 9000, 12000, 20000, 30000, 45000, 60000, 70000];
    const fl = [-0.194409192, -0.0779310167, -0.00935326051, -0.00536654703, 0.00196221354, 0.106924713, 0.00782020856, -3.24828507e-05, 0.0644607618, -0.00628790632];
    expectAt(L, idx, fl);
    expectAt(R, idx, fl);
  });

  it('routes pads to mixer tracks (current track + offset, clamped) and plays every extreme finite', () => {
    const s = { ...defaultGenParams('drumaxx'), offsets: [2, -10, ...Array(14).fill(0)] };
    const tracks = new Set<number>();
    let routed = 0;
    const [L] = render(s, [[36, 100, 0, 0.2], [38, 100, 0, 0.2]], 6000, (t, l, _r, n) => { tracks.add(t); for (let i = 0; i < n; i++) routed += Math.abs(l[i]); });
    expect([...tracks].sort((a, b) => a - b)).toEqual([0, 9]);
    expect(routed).toBeGreaterThan(1);
    expect(rms(L, 0, 6000)).toBe(0);
    const lo: Record<string, unknown> = { ...defaultGenParams('drumaxx') }, hi: Record<string, unknown> = { ...lo };
    D.params.forEach((q) => { lo[q.key] = q.min; hi[q.key] = q.max; });
    for (const p of [lo, hi]) {
      const [X] = render(p, [[0, 127, 0, 0.1], [126, 1, 0.05, 0.1], [60, 100, 0, 0.3]], 20000);
      for (let i = 0; i < X.length; i++) expect(Number.isFinite(X[i])).toBe(true);
    }
  });

  it('works in a channel', () => {
    const e = makeEngine();
    const ch = createGenChannel('drumaxx');
    ch.volume = 1;
    const [CL] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 4, key: 36 }] }, 12000);
    expect(rms(CL, 0, 6000)).toBeGreaterThan(0.01);
  });
});

describe('Drumaxx / Drumpad editors', () => {
  it('render their pages for every bank and pad (server side)', async () => {
    const { FxEditorContext } = await import('../../src/ui/plugins/kit');
    const dx = await import('../../src/ui/plugins/gen/drumaxx');
    const dp = await import('../../src/ui/plugins/gen/drumpad');
    const html = (plugin: string, Editor: () => unknown, params: Record<string, unknown>) => renderToStaticMarkup(
      createElement(FxEditorContext.Provider, { value: { slotId: 'ch:test', plugin, params, trackName: 'Drums', pluginName: plugin } }, createElement(Editor as never)),
    );
    const base = defaultGenParams('drumaxx');
    const a = html('drumaxx', dx.editor.Editor as never, base);
    expect(a).toContain('DRUMSET SELECT');
    expect(a).toContain('Bassdrum');
    expect(a).toContain('Pattern 1');
    const b = html('drumaxx', dx.editor.Editor as never, { ...kit('Special/Cinematikit 2 FG'), bank: 1, sel: 9, pat: 3, bar: 2, play: 3 });
    expect(b).toContain('TRACK<br/>10');
    expect(html('drumpad', dp.editor.Editor as never, defaultGenParams('drumpad'))).toContain('MEMBRANE');
  });
});
