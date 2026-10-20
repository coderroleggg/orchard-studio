// Toxic Biohazard (FL: Toxic Biohazard): registration (FL's 423 parameters, value
// texts from FL's own text code checked against test-host sweeps, 790 factory
// presets, insertion state), the Apple libm functions FL calls, the sequencer's
// chord detection, the optional import of FL's built-in harmonic tables, and the
// DSP against FL's own renders (flfxhost, 44.1 kHz, FPE_MaxPoly 0): factory presets
// that use the built-in shapes 1..5 and custom harmonics (piano with phaser and
// reverb, a chord-following sequence with lo-fi and delay, an 8-voice unison lead,
// a mono 303-style sequence, flute with phaser / reverb, Default). Bit-exact.
import { describe, it, expect, vi } from 'vitest';
import { genDef, genPresetState } from '../../src/model/gen/registry';
import { TxPlugin } from '../../src/engine/gen/plugins/toxicbiohazard/plugin';
import { txChord } from '../../src/engine/gen/plugins/toxicbiohazard/chords';
import { findToxicTables } from '../../src/engine/gen/plugins/toxicbiohazard/wave';
import { txSeed } from '../../src/engine/gen/plugins/toxicbiohazard/osc';
import { tanf, expf, powf } from '../../src/engine/gen/plugins/poizone/applemath';
import { TX_PRESET_NAMES } from '../../src/model/gen/plugins/toxicbiohazard/data';
import { newLevels } from '../../src/engine/gen/levels';
import type { GenNote } from '../../src/engine/gen/types';

// DSP renders: generous time when the whole suite runs concurrently
vi.setConfig({ testTimeout: 120_000 });

const D = genDef('toxicbiohazard')!;
const SR = 44100;

function note(key: number, vel: number, id: number): GenNote {
  const init = newLevels(), levels = newLevels();
  init.pitch = key * 100; init.vol = (Math.pow(11, vel / 100) - 1) / 10;
  levels.pitch = key * 100; levels.vol = 1; levels.pan = 0;
  return { id, key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
}

/**
 * FL's test host: a fresh process (the oscillators' random start phases come from one plugin-wide
 * seed), preset state, 0.25 s preroll, 512-frame blocks split at note events, 130 BPM.
 */
function render(preset: number, notes: [number, number, number, number][], seconds: number): Float32Array[] {
  txSeed.v = 22222;
  const pl = new TxPlugin(SR, 512);
  pl.setParams(genPresetState('toxicbiohazard', D.presets![preset]));
  const pre = Math.round(0.25 * SR), n = Math.round(seconds * SR), total = pre + n;
  const evs: { t: number; on: boolean; n: GenNote }[] = [];
  notes.forEach(([k, v, s, d], i) => {
    const nn = note(k, v, i + 1);
    evs.push({ t: pre + Math.round(s * SR), on: true, n: nn }, { t: pre + Math.round((s + d) * SR), on: false, n: nn });
  });
  evs.sort((a, b) => a.t - b.t || (a.on === b.on ? 0 : a.on ? 1 : -1));
  const L = new Float32Array(n), R = new Float32Array(n);
  const bl = new Float32Array(512), br = new Float32Array(512);
  let t = 0, e = 0;
  while (t < total) {
    while (e < evs.length && evs[e].t <= t) { const ev = evs[e++]; if (ev.on) pl.noteOn(ev.n, 0); else pl.noteOff(ev.n, 0); }
    let m = Math.min(512, total - t);
    if (e < evs.length && evs[e].t < t + m) m = evs[e].t - t;
    const ctx = { sampleRate: SR, blockSize: 512, tempo: 130, ppq: 96, playing: false, pos: 0, songMode: false, track: 0 };
    bl.fill(0); br.fill(0);
    pl.render(bl, br, m, ctx);
    if (t >= pre) { L.set(bl.subarray(0, m), t - pre); R.set(br.subarray(0, m), t - pre); }
    else if (t + m > pre) { L.set(bl.subarray(pre - t, m), 0); R.set(br.subarray(pre - t, m), 0); }
    t += m;
  }
  return [L, R];
}

describe('Toxic Biohazard: registration', () => {
  it("has FL's 423 parameters (294 synth parameters, MIDI CC 0..127, channel aftertouch)", () => {
    expect(D.name).toBe('Toxic Biohazard');
    expect(D.category).toBe('Synth classic');
    expect(D.notes).toBe('events');
    expect([D.width, D.height]).toEqual([910, 594]);
    expect(D.defPoly).toBe(32);
    expect(D.params.length).toBe(423);
    expect(D.params[0]).toMatchObject({ name: 'Gain', min: 0, max: 256, index: 0 });
    expect(D.params[157].name).toBe('Seq Play');
    expect(D.params[293].name).toBe('Phas2 Mix');
    expect(D.params[294].name).toBe('MIDI CC 0');
    expect(D.params[422].name).toBe('Chn. Aftertouch');
  });

  it("formats values with FL's texts (test-host sweeps)", () => {
    const fl: [number, number, string][] = [
      [0, 0, '-30.0 dB'], [0, 80, '-11.2 dB'], [0, 160, '7.5 dB'], [0, 240, '26.2 dB'], [2, 48, '-15 %'], [2, 128, '0 %'],
      [3, 16, '0.001 s'], [3, 96, '0.989 s'], [3, 176, '11.170 s'], [3, 256, '50.000 s'], [6, 64, '0.088 s'], [6, 224, '10.278 s'],
      [13, 32, '0.05 Hz'], [13, 112, '1.68 Hz'], [13, 192, '8.45 Hz'], [23, 0, '-100.00 %'], [23, 80, '-14.06 %'], [23, 240, '76.56 %'],
      [31, 48, '-61 %'], [31, 208, '61 %'], [43, 16, '-2051.64 Hz'], [43, 96, '-3.91 Hz'], [43, 256, '4000.00 Hz'],
      [97, 64, '-25 %'], [97, 144, '6 %'], [145, 32, '-74 %'], [152, 0, '-99 %'], [152, 240, '87 %'], [162, 48, '12 %'],
      [163, 16, '-22 %'], [163, 256, '24 %'], [163, 0, '--- %'], [228, 64, '-9.0 dB'], [228, 144, '2.2 dB'],
      [236, 112, '43 %'], [422, 80, '39'], [422, 240, '119'],
    ];
    for (const [i, raw, text] of fl) expect(D.params[i].format!(raw), `param ${i} at ${raw}`).toBe(text);
  });

  it("lists FL's 790 factory presets; the insertion state is AquaTone ToTc", () => {
    expect(D.presets!.length).toBe(790);
    expect(TX_PRESET_NAMES[0]).toBe('Default');
    expect(TX_PRESET_NAMES[1]).toBe('Ambient Textures/AquaTone ToTc');
    const st = genPresetState('toxicbiohazard', D.presets![1]);
    expect(D.params[0].def).toBeCloseTo(Number(st.gain), 3);
    expect(D.params[0].format!(D.params[0].def)).toBe('-11.5 dB');
    expect(D.params[13].format!(D.params[13].def)).toBe('1.08 Hz');
    expect(D.params[43].format!(D.params[43].def)).toBe('210.63 Hz');
  });
});

describe('Toxic Biohazard: support code', () => {
  it("reproduces Apple's tanf / expf / powf (not correctly rounded)", () => {
    expect(tanf(0.9946295022964478)).toBe(1.5391634702682495);
    expect(tanf(-1.0056180953979492)).toBe(-1.5768227577209473);
    expect(tanf(0.35641899704933167)).toBe(0.3723199963569641);
    expect(expf(-0.9059499502182007)).toBe(0.40415775775909424);
    expect(expf(13.60783576965332)).toBe(812471.1875);
    expect(powf(0.7186832427978516, 2.661384105682373)).toBe(0.41513678431510925);
    expect(powf(0.3037223815917969, 4.368801116943359)).toBe(0.005483325570821762);
  });

  it("detects the held chord like FL's sequencer (case << 4 | root)", () => {
    expect(txChord(0b10010001)).toBe((1 << 4) | 0); // C major
    expect(txChord(0b10001001)).toBe((0 << 4) | 0); // C minor
    expect(txChord(0b1)).toBe(7 << 4); // one note: chromatic
    expect(txChord(0b10010010001)).toBe((6 << 4) | 4); // C7: E diminished first
    expect(txChord(0b100010010001)).toBe((5 << 4) | 0); // Cmaj7
  });

  it('finds harmonic tables in a plugin binary (optional import of FL waveforms)', () => {
    const buf = new ArrayBuffer(64 + 28 * 0x400);
    const dv = new DataView(buf);
    for (let k = 0; k < 27; k++) {
      const o = 64 + k * 0x400;
      for (let i = 0; i < 128; i++) {
        dv.setFloat32(o + i * 4, i % (k + 2) === 0 ? 0.5 / (i + 1) : 0, true);
        dv.setFloat32(o + 0x200 + i * 4, Math.fround(Math.round(((i * 37) % 256) / 256 * 1e6) / 1e6), true);
      }
    }
    const t = findToxicTables(buf);
    expect(t).not.toBeNull();
    expect(t!.length).toBe(27);
    expect(t![0][0]).toBe(0.5);
    expect(findToxicTables(new ArrayBuffer(4096))).toBeNull();
  });
});

describe('Toxic Biohazard: DSP vs FL renders', () => {
  const NOTES: [number, number, number, number][] = [[48, 100, 0, 1.0], [60, 100, 0, 1.0], [64, 90, 0.05, 0.9], [67, 80, 0.1, 0.8]];
  const IDX = [100, 1000, 5000, 10000, 20000, 30000, 44100, 60000];
  const FL: [number, string, number[], number[], number][] = [
    [132, 'Best/Iron Piano', [0.04568794369697571, -0.07290447503328323, 0.06175226345658302, 0.011525539681315422, -0.01837790198624134, -0.0043175010941922665, -0.0005523887812159956, -0.00020626424520742148], [-0.19656160473823547, 0.14069372415542603, 0.028886882588267326, 0.07205884903669357, 0.013383418321609497, 0.00730036711320281, 0.009395016357302666, 0.0012719499645754695], 0.049658478713351814],
    [116, 'Best/8SEQ Swingers ToTc', [-0.1193358302116394, 0.012386023998260498, 0.03669345751404762, 0.00571039691567421, 0.04139554500579834, 0.009044152684509754, 0.009533760137856007, 0.005467244423925877], [-0.1193358302116394, 0.012386023998260498, 0.03669345751404762, 0.0005682458286173642, 0.03572389855980873, -0.010370291769504547, 0.005904234480112791, 0.0013130533043295145], 0.053305515044721495],
    [325, 'Leads/T-III Super Saw ToTc', [0.014555908739566803, -0.035874877125024796, -0.10256688296794891, -0.030045686289668083, -0.10696396231651306, 0.06815104931592941, 0.0725388452410698, 0.02645215578377247], [-0.019463347271084785, -0.07823935151100159, -0.07912620902061462, -0.06981103867292404, 0.08981146663427353, 0.1921008974313736, 0.0026515857316553593, 0.02109738625586033], 0.0860598615708251],
    [528, 'Sequences/T-303 ToTc', [-2.1209332771832123e-05, -0.06930233538150787, 0.23834416270256042, 0.2801266014575958, 0.42984074354171753, -0.2832889258861542, 0.19850359857082367, 0.0], [-2.1209332771832123e-05, -0.06930233538150787, 0.23834416270256042, 0.2801266014575958, 0.42984074354171753, -0.2832889258861542, 0.19850359857082367, 0.0], 0.2512801952710401],
    [783, 'X Nucleon/SYN Binary Flute NUC', [-0.02368566207587719, -0.013137787580490112, 0.03164685517549515, -0.47463569045066833, 0.034778937697410583, 0.034190621227025986, 0.1380476951599121, 4.228834586683661e-05], [-0.0011763627408072352, 0.05715002864599228, 0.04638059437274933, -0.10322114080190659, -0.1947118490934372, 0.034108564257621765, 0.13108572363853455, -1.1408671525714453e-05], 0.12577581946370717],
    [0, 'Default', [-0.054755426943302155, -0.1517987996339798, -0.0647856593132019, -0.01345042698085308, -0.04353504627943039, 0.1028226688504219, -0.18944786489009857, 0.0], [-0.054755426943302155, -0.1517987996339798, -0.0647856593132019, -0.01345042698085308, -0.04353504627943039, 0.1028226688504219, -0.18944786489009857, 0.0], 0.14379636851520533],
  ];
  for (const [i, name, fl, fr, flRms] of FL) {
    it(`renders "${name}" sample for sample like FL`, () => {
      expect(TX_PRESET_NAMES[i]).toBe(name);
      const [L, R] = render(i, NOTES, 1.5);
      IDX.forEach((k, j) => {
        expect(L[k], `L[${k}]`).toBe(fl[j]);
        expect(R[k], `R[${k}]`).toBe(fr[j]);
      });
      let s = 0;
      for (let k = 0; k < L.length; k++) s += L[k] * L[k] + R[k] * R[k];
      expect(Math.sqrt(s / (2 * L.length))).toBeCloseTo(flRms, 9);
    });
  }
});

describe('Toxic Biohazard: editor', async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
  g.document ??= { body: {}, getElementById: () => null };
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const { genEditorFor } = await import('../../src/ui/plugins/genRegistry');
  const { TX_UI, TX_FX } = await import('../../src/ui/plugins/gen/toxicbiohazard/layout');
  const mod = await import('../../src/ui/plugins/gen/toxicbiohazard');
  const html = (params: Record<string, unknown>) => renderToStaticMarkup(
    createElement(FxEditorContext.Provider, { value: { slotId: 'ch:test', plugin: 'toxicbiohazard', params, trackName: 'Toxic', pluginName: 'Toxic Biohazard' } }, createElement(mod.editor.Editor)),
  );

  it("places every FL parameter on FL's editor layout", () => {
    expect(genEditorFor('toxicbiohazard')).toBe(mod.editor);
    const placed = new Set<number>(TX_UI.map((c) => c[1]));
    for (const t of Object.keys(TX_FX)) for (const c of TX_FX[+t]) if (c[1] >= 0) { placed.add(c[1]); placed.add(c[1] + 1); }
    for (const p of [248, 249, 250, 251]) placed.add(p); // the flanger's inverted feedback / mix texts
    for (let i = 0; i < 294; i++) expect(placed.has(i), `parameter ${i}`).toBe(true);
    for (const c of TX_UI) expect(c[2] + c[4] <= 910 && c[3] + c[5] <= 594, `control ${c[1]}`).toBe(true);
  });

  it('renders the default state and factory presets with every effect type', () => {
    const presets = genDef('toxicbiohazard')!.presets!;
    for (const i of [1, 116, 528, 700]) {
      const st = genPresetState('toxicbiohazard', presets[i]);
      for (let t = 0; t < 6; t++) {
        const h = (st.hidden as number[]).slice();
        h[314 - 294] = t; h[315 - 294] = 5 - t;
        const out = html({ ...st, hidden: h });
        expect(out).toContain('TOXIC III');
        expect(out).toContain(['TIME', 'DEPTH', 'DECAY', 'DELAY', 'FREQ', 'BITS'][t]);
      }
      expect(html({ ...st, txPage: 1 })).toContain('TARGET');
      expect(html({ ...st, txPage: 2 })).toContain('STEPS');
    }
  });

  it("offers FL's options and the FL waveform import in the plugin menu", () => {
    const labels = mod.editor.menu!('ch:none').map((m) => m.label).filter(Boolean);
    expect(labels).toEqual(expect.arrayContaining(['Load Program...', 'Swap Effects', 'Reset Sequencer', 'Import FL waveforms...', 'Use synthesized waveforms']));
  });
});
