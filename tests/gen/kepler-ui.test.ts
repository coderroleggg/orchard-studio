// Kepler and Kepler Exo editors without a browser: every form control of FL (class by class, at FL's Left / Top / Width / Height)
// is rendered server side at its coordinates and binds a real parameter, the effect pages / matrix / themes / presets render,
// the Options menus map onto the model's option keys, the chorus buttons, matrix destinations and wheel menu "Set" follow FL's
// logic, the EQ and saturation displays are finite, and "Import FL content..." stores the tables as a pool sample (tables found
// by the engine's fingerprint scan are mocked: nothing of FL's data is in the repository).
import { describe, it, expect, vi, type Mock } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };

const rec = vi.hoisted(() => ({ keys: new Set<string>() }));
vi.mock('../../src/ui/plugins/kit/context', async (orig) => {
  const m = await orig<typeof import('../../src/ui/plugins/kit/context')>();
  return {
    ...m,
    useParam: (key: string, over?: Parameters<typeof m.useParam>[1]) => {
      rec.keys.add(key);
      return m.useParam(key, over);
    },
  };
});
vi.mock('../../src/engine/gen/plugins/kepler/fltables', async (orig) => {
  const m = await orig<typeof import('../../src/engine/gen/plugins/kepler/fltables')>();
  return { ...m, kpFindTables: vi.fn(m.kpFindTables) };
});
vi.mock('../../src/audio/samples', async (orig) => {
  const m = await orig<typeof import('../../src/audio/samples')>();
  return { ...m, storeUserSample: vi.fn(async () => {}) };
});

type Box = [number, number, number, number];

// FL's forms (Kepler.txt, Kepler Exo.txt): Left, Top, Width, Height of the visible controls, by class
const KEPLER = {
  slider: [[896, 93, 25, 104], [869, 93, 25, 104], [952, 93, 25, 104], [924, 93, 25, 104], [598, 92, 25, 104], [750, 93, 25, 104], [723, 93, 25, 104], [778, 93, 25, 104], [666, 93, 25, 104], [639, 93, 25, 104], [557, 92, 25, 104], [527, 92, 28, 104], [345, 93, 25, 104], [318, 93, 25, 104], [178, 93, 23, 104], [204, 93, 25, 104], [139, 93, 23, 104], [279, 93, 23, 104]],
  lever: [[698, 120, 18, 33], [819, 120, 37, 33], [375, 120, 37, 48], [236, 120, 37, 33], [102, 120, 31, 48], [60, 120, 34, 48]],
  pad: [[995, 128, 33, 33], [1030, 128, 33, 33], [17, 128, 33, 33], [237, 179, 33, 17], [416, 128, 33, 33], [452, 128, 33, 33], [488, 128, 33, 33], [11, 18, 37, 19], [851, 17, 26, 21]],
  led: [[142, 65, 18, 16], [180, 65, 18, 16], [424, 101, 18, 16], [460, 101, 18, 16], [496, 101, 18, 16], [281, 65, 18, 16]],
  seg: [[85, 18, 60, 18]],
} satisfies Record<string, Box[]>;

const EXO_MAIN = {
  slider: [[500, 279, 23, 104], [475, 279, 23, 104], [552, 279, 23, 104], [526, 279, 23, 104], [371, 279, 23, 104], [178, 279, 23, 104], [152, 279, 23, 104], [230, 279, 23, 104], [99, 279, 23, 104], [74, 279, 23, 104], [321, 108, 23, 104], [292, 108, 23, 104], [107, 108, 23, 104], [29, 108, 23, 104], [712, 279, 23, 104], [740, 279, 23, 104], [263, 453, 23, 104], [55, 108, 23, 104], [81, 108, 23, 104], [829, 108, 23, 104], [803, 108, 23, 104], [621, 108, 23, 104], [543, 108, 23, 104], [569, 108, 23, 104], [595, 108, 23, 104], [855, 108, 23, 104], [881, 108, 23, 104], [446, 108, 23, 104], [364, 108, 23, 104], [950, 108, 23, 104], [976, 108, 23, 104], [1002, 108, 23, 104], [1027, 108, 23, 104], [204, 279, 23, 104], [323, 279, 23, 104], [862, 279, 23, 104], [890, 279, 23, 104], [621, 279, 23, 104], [596, 279, 23, 104], [673, 279, 23, 104], [647, 279, 23, 104], [291, 453, 23, 104], [975, 279, 23, 104], [821, 279, 23, 104]],
  lever: [[130, 316, 18, 30], [417, 282, 37, 45], [138, 138, 37, 45], [774, 316, 37, 30], [154, 512, 29, 45], [650, 138, 37, 45], [478, 115, 49, 90], [395, 115, 49, 90], [260, 282, 62, 90], [26, 303, 44, 60], [928, 316, 37, 30], [1010, 282, 41, 90], [31, 461, 48, 30]],
  pad: [[560, 523, 33, 33], [595, 523, 33, 33], [151, 459, 33, 33], [179, 144, 33, 33], [215, 144, 33, 33], [251, 144, 33, 33], [27, 17, 33, 19], [617, 16, 25, 21], [691, 144, 33, 33], [727, 144, 33, 33], [763, 144, 33, 33], [30, 409, 48, 21], [510, 403, 30, 13]],
  led: [[267, 424, 14, 13], [716, 249, 14, 13], [187, 121, 14, 13], [223, 121, 14, 13], [259, 121, 14, 13], [699, 122, 14, 13], [735, 122, 14, 13], [771, 122, 14, 13], [539, 55, 20, 18], [865, 249, 14, 13], [32, 77, 14, 13], [58, 77, 14, 13], [546, 76, 14, 13], [572, 76, 14, 13], [825, 249, 14, 13], [979, 249, 14, 13], [914, 122, 14, 13], [82, 465, 40, 13], [82, 489, 40, 13], [82, 514, 46, 13], [82, 539, 52, 13], [603, 461, 14, 13], [412, 377, 14, 13], [375, 249, 14, 13]],
  seg: [[94, 17, 54, 18]],
  combo: [[4, 19, 89, 21], [96, 19, 89, 21], [4, 45, 89, 21], [96, 45, 89, 21], [4, 71, 89, 21], [96, 71, 89, 21], [4, 97, 89, 21], [96, 97, 89, 21]],
} satisfies Record<string, Box[]>;

// the effect panels' controls (coordinates relative to the panel at (640, 398), 420 x 164)
const EXO_PAGES: Record<number, Record<string, Box[]>> = {
  0: { slider: [[92, 55, 23, 104]], lever: [[44, 92, 37, 30]], led: [[44, 146, 14, 13]] },
  1: { slider: [[351, 55, 23, 104], [203, 55, 23, 104], [165, 55, 23, 104], [90, 55, 23, 104], [52, 55, 23, 104], [15, 55, 23, 104], [127, 55, 23, 104], [387, 55, 23, 104], [315, 55, 23, 104], [279, 55, 23, 104]], lever: [[240, 92, 30, 30]] },
  2: {},
  3: { slider: [[347, 55, 23, 104], [307, 55, 23, 104], [387, 55, 23, 104], [148, 55, 23, 104], [108, 55, 23, 104], [69, 55, 23, 104], [185, 55, 23, 104], [222, 55, 23, 104]], lever: [[257, 77, 44, 60]], led: [[111, 24, 17, 16]] },
  4: { slider: [[57, 55, 25, 104], [30, 55, 25, 104], [113, 55, 25, 104], [85, 55, 25, 104], [194, 55, 25, 104], [167, 55, 25, 104], [250, 55, 25, 104], [222, 55, 25, 104], [331, 55, 25, 104], [303, 55, 25, 104], [387, 55, 25, 104], [359, 55, 25, 104]] },
};
const EXO_TAB_LEDS: Box[] = [[172, 1, 20, 21], [88, 1, 20, 21], [256, 1, 20, 21], [4, 1, 20, 21], [340, 1, 20, 21]];

/** Controls the form hides (Visible = False): the pitch bend range wheel and the Juno arpeggiator bug switch. */
const EXO_HIDDEN = ['bendRange', 'arpBug'];

/** The "left:Xpx;top:Ypx;width:Wpx;height:Hpx" boxes of a rendered editor. */
function boxes(html: string): Set<string> {
  const s = new Set<string>();
  for (const m of html.matchAll(/left:(-?[\d.]+)px;top:(-?[\d.]+)px;width:([\d.]+)px;height:([\d.]+)px/g)) s.add(`${+m[1]},${+m[2]},${+m[3]},${+m[4]}`);
  return s;
}

/** A canvas context that accepts every call and rejects non-finite numbers. */
function fakeCtx(): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...a: unknown[]) => { for (const x of a) if (typeof x === 'number' && !Number.isFinite(x)) throw new Error(`non-finite argument to ${k}`); return undefined; };
    },
    set(t, k: string, v) { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

describe('Kepler and Kepler Exo editors', async () => {
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const { genDef, genPresetState } = await import('../../src/model/gen/registry');
  const kepler = await import('../../src/ui/plugins/gen/kepler');
  const exo = await import('../../src/ui/plugins/gen/keplerexo');
  const { chorusClick } = await import('../../src/ui/plugins/gen/keplercommon/chorus');
  const menus = await import('../../src/ui/plugins/gen/keplercommon/menus');
  const fldata = await import('../../src/ui/plugins/gen/keplercommon/fldata');
  const { DEST_GROUPS, stepDest, stepSource, sourceName, destName } = await import('../../src/ui/plugins/gen/keplerexo/matrix');
  const displays = await import('../../src/ui/plugins/gen/keplerexo/displays');
  const skin = await import('../../src/ui/plugins/gen/keplercommon/skin');
  const exoData = await import('../../src/model/gen/plugins/keplerexo/data');
  const keplerData = await import('../../src/model/gen/plugins/kepler/data');
  const { getRaw } = await import('../../src/audio/samples');
  const fl = await import('../../src/engine/gen/plugins/kepler/fltables');

  function setup(plugin: 'kepler' | 'keplerexo') {
    const id = A.addGenChannel(plugin);
    const slotId = 'ch:' + id;
    const params = () => store.project.channels.find((c) => c.id === id)!.plugin!.params as Record<string, unknown>;
    const mod = plugin === 'kepler' ? kepler : exo;
    const render = (over: Record<string, unknown> = {}, page?: number) => {
      rec.keys.clear();
      if (page !== undefined) (g.__orchardKeplerExoPages as { pages: Map<string, number> }).pages.set(slotId, page);
      const ctx = { slotId, plugin, params: { ...params(), ...over }, trackName: 'Test', pluginName: plugin };
      return renderToStaticMarkup(createElement(FxEditorContext.Provider, { value: ctx }, createElement(mod.editor.Editor)));
    };
    return { id, slotId, params, render, mod };
  }

  describe('Kepler', () => {
    it('exports the editor of the kepler instrument with the options menu', () => {
      expect(kepler.editor.id).toBe('kepler');
      expect(typeof kepler.editor.menu).toBe('function');
      expect(genDef('kepler')!.width).toBe(1080);
      expect(genDef('kepler')!.height).toBe(217);
    });

    it('draws every control of FL\'s form at its coordinates and binds all 36 parameters', () => {
      const { render } = setup('kepler');
      const html = render();
      const have = boxes(html);
      for (const [kind, list] of Object.entries(KEPLER)) {
        for (const b of list as Box[]) expect(have.has(b.join(',')), `${kind} ${b.join(',')}`).toBe(true);
      }
      const def = genDef('kepler')!;
      for (const p of def.params) expect(rec.keys.has(p.key), p.key).toBe(true);
      for (const k of rec.keys) expect(def.params.some((p) => p.key === k), `unknown key ${k}`).toBe(true);
      // the volume wheel (24 x 24), headers and FL's captions
      expect(have.has('884,16,24,24')).toBe(true);
      for (const t of ['ARPEGGIO', 'LFO', 'DCO', 'HPF', 'VCF', 'VCA', 'ENV', 'CHORUS', 'KEPLER', 'HOLD', 'OCTAVE', 'TRIG MODE', 'DELAY', 'PHASE', 'KYBD']) expect(html).toContain(t);
    });

    it('renders factory presets and every state of the discrete controls', () => {
      const { render } = setup('kepler');
      const def = genDef('kepler')!;
      for (let i = 0; i < def.presets!.length; i += 23) {
        const st = genPresetState('kepler', def.presets![i]);
        expect(render(st).length).toBeGreaterThan(5000);
      }
      for (const mode of [0, 1, 2, 3]) expect(render({ chorusMode: mode })).toContain('KEPLER');
      for (const v of [0, 1, 2]) expect(render({ octave: v, arpMode: v, arpRange: v, dcoPwmSource: v }).length).toBeGreaterThan(5000);
      // extremes of every parameter render
      const lo: Record<string, number> = {}, hi: Record<string, number> = {};
      for (const p of def.params) { lo[p.key] = p.min; hi[p.key] = p.max; }
      expect(render(lo).length).toBeGreaterThan(5000);
      expect(render(hi).length).toBeGreaterThan(5000);
    });

    it('has FL\'s Options menu on the state option keys, plus Import FL content', () => {
      const { slotId, params } = setup('kepler');
      const items = () => kepler.editor.menu!(slotId);
      const labels = items().filter((m) => !m.separator).map((m) => m.label);
      expect(labels).toEqual([
        'Quantize first arpeggiator step', 'Velocity to volume', 'Align sub oscillator phase', 'Chorus noise', 'Chorus noise gate', 'HQ mode',
        'Import FL content...', 'Use the stand-in LFO and noise',
      ]);
      const checked = (label: string) => !!items().find((m) => m.label === label)!.checked;
      expect(checked('Velocity to volume')).toBe(true);
      expect(checked('HQ mode')).toBe(false);
      const keys: [string, string][] = [
        ['Quantize first arpeggiator step', 'arpQuantize'], ['Velocity to volume', 'velocityToVolume'], ['Align sub oscillator phase', 'alignSubPhase'],
        ['Chorus noise', 'chorusNoise'], ['Chorus noise gate', 'chorusNoiseGate'], ['HQ mode', 'hq'],
      ];
      for (const [label, key] of keys) {
        const was = params()[key] as boolean;
        items().find((m) => m.label === label)!.onClick!();
        expect(params()[key], key).toBe(!was);
        expect(checked(label)).toBe(!was);
      }
      expect(keplerData.keplerOptionsOf(params())).toMatchObject({ arpQuantize: true, velocityToVolume: false, alignSubPhase: true, chorusNoise: true, chorusNoiseGate: true, hq: true });
    });
  });

  describe('Kepler Exo', () => {
    it('exports the editor of the keplerexo instrument', () => {
      expect(exo.editor.id).toBe('keplerexo');
      expect(genDef('keplerexo')!.width).toBe(1080);
      expect(genDef('keplerexo')!.height).toBe(574);
    });

    it('draws the main panel at FL\'s coordinates', () => {
      const { render } = setup('keplerexo');
      const html = render(undefined, 2);
      const have = boxes(html);
      for (const [kind, list] of Object.entries(EXO_MAIN)) {
        for (const b of list as Box[]) expect(have.has(b.join(',')), `${kind} ${b.join(',')}`).toBe(true);
      }
      for (const b of EXO_TAB_LEDS) expect(have.has(b.join(',')), `effect LED ${b.join(',')}`).toBe(true);
      // the effects panel (640, 398, 420 x 164) and the matrix panel (329, 436, 220 x 128)
      expect(have.has('640,398,420,164')).toBe(true);
      expect(have.has('329,436,220,128')).toBe(true);
      for (const t of ['KEPLER EXO', 'DCO1', 'CROSS MOD', 'DCO2', 'DCO 1-2 MIXER', 'VCF', 'HPF', 'VCA', 'ENV1', 'ENV2', 'LFO1', 'LFO2', 'ARPEGGIATOR', 'MODULATION MATRIX', 'CHORUS',
        'LFO TRIG', 'PORTA MODE', 'PORTAMENTO', 'PLAY MODE', 'HARD', 'SYNC', 'FILTER FM', 'SAT', 'HYCHOR', 'EQ', 'DELAY', 'REVERB', 'SOURCE', 'DESTINATION']) expect(html).toContain(t);
    });

    it('draws each effect page at FL\'s coordinates', () => {
      const { render } = setup('keplerexo');
      for (const [page, kinds] of Object.entries(EXO_PAGES)) {
        const have = boxes(render(undefined, Number(page)));
        for (const [kind, list] of Object.entries(kinds)) {
          for (const b of list) expect(have.has(b.join(',')), `page ${page} ${kind} ${b.join(',')}`).toBe(true);
        }
      }
    });

    it('binds every parameter but the two hidden ones, and only real keys', () => {
      const { render } = setup('keplerexo');
      const def = genDef('keplerexo')!;
      const bound = new Set<string>();
      for (let page = 0; page < 5; page++) { render(undefined, page); for (const k of rec.keys) bound.add(k); }
      render({ modPage: 1 }, 2); // the matrix' second page: slots 5-8
      for (const k of rec.keys) bound.add(k);
      for (const p of def.params) expect(bound.has(p.key) || EXO_HIDDEN.includes(p.key), p.key).toBe(true);
      for (const k of EXO_HIDDEN) expect(bound.has(k), k).toBe(false);
      for (const k of bound) expect(def.params.some((p) => p.key === k), `unknown key ${k}`).toBe(true);
      expect(def.params.length).toBe(155);
    });

    it('renders presets, matrix pages, themes and extreme states', () => {
      const { render } = setup('keplerexo');
      const def = genDef('keplerexo')!;
      for (let i = 0; i < def.presets!.length; i += 19) {
        const st = genPresetState('keplerexo', def.presets![i]);
        for (const page of [0, 1]) expect(render({ ...st, modPage: page }, 2).length).toBeGreaterThan(20000);
      }
      // a matrix: source and destination names, both pages
      const mm = { src: [3, 6, 20, 0, 12, 21, 22, 23], dst: [37, 256, 62, 74, 113, 144, 147, 40] };
      const p1 = render({ modMatrix: mm, modPage: 0 }, 2);
      for (const t of ['Env2', 'ModX Bipolar', 'Key Follow Unipolar', 'LFO1 Bipolar Triangle', 'Cutoff', 'DCO1 Pitch', 'Env1 Decay', 'Pan']) expect(p1, t).toContain(t);
      const p2 = render({ modMatrix: mm, modPage: 1 }, 2);
      for (const t of ['LFO2 Unipolar', 'Random Bipolar', 'ModX Unipolar', 'ModY Unipolar', 'Delay Time', 'HyperChorus Delay Lines', 'HyperChorus Mix', 'Filter Slope']) expect(p2, t).toContain(t);
      expect(p2).not.toContain('Key Follow Unipolar');
      // the four themes
      const themes = [0, 1, 2, 3].map((t) => render({ theme: t }, 2));
      expect(new Set(themes).size).toBe(4);
      expect(themes[0]).toContain('#d6d6d6');
      expect(themes[3]).toContain('#b14c3e');
      for (const t of themes) expect(t.length).toBeGreaterThan(20000);
      const lo: Record<string, number> = {}, hi: Record<string, number> = {};
      for (const p of def.params) { lo[p.key] = p.min; hi[p.key] = p.max; }
      for (const page of [0, 1, 2, 3, 4]) { expect(render(lo, page).length).toBeGreaterThan(20000); expect(render(hi, page).length).toBeGreaterThan(20000); }
    });

    it('has FL\'s Options menu with the Theme submenu, plus Import FL content', () => {
      const { slotId, params } = setup('keplerexo');
      const items = () => exo.editor.menu!(slotId);
      expect(items().filter((m) => !m.separator).map((m) => m.label)).toEqual([
        'Arp 1st Step Quantize', 'HQ mode', 'Enhanced Oscillators', 'Theme', 'Import FL content...', 'Use the stand-in LFO and noise',
      ]);
      for (const [label, key] of [['Arp 1st Step Quantize', 'arpQuantize'], ['HQ mode', 'hq'], ['Enhanced Oscillators', 'enhancedOscillators']] as [string, string][]) {
        expect(!!params()[key]).toBe(false);
        items().find((m) => m.label === label)!.onClick!();
        expect(params()[key], key).toBe(true);
        expect(items().find((m) => m.label === label)!.checked).toBe(true);
      }
      const theme = items().find((m) => m.label === 'Theme')!;
      expect(theme.submenu!.map((m) => m.label)).toEqual(['Dark', 'Light', 'Colored', 'Two colors']);
      expect(theme.submenu!.find((m) => m.checked)!.label).toBe('Two colors'); // the stored default 0 is FL's default look
      theme.submenu!.find((m) => m.label === 'Dark')!.onClick!();
      expect(params().theme).toBe(1);
      expect(skin.exoTheme(params().theme).name).toBe('Dark');
      expect(exo.editor.menu!(slotId).find((m) => m.label === 'Theme')!.submenu!.find((m) => m.checked)!.label).toBe('Dark');
      for (const t of skin.EXO_THEME_MENU) expect(skin.exoTheme(t.value).name).toBe(t.label);
    });

    it('lists every valid matrix destination once, in FL\'s groups', () => {
      expect(DEST_GROUPS.map((x) => x.title)).toEqual(['Global', 'Oscillators', 'Cross Mod', 'Filters', 'Mix', 'Envelopes', 'LFOs', 'Mod Matrix', 'Effects']);
      const all = DEST_GROUPS.flatMap((x) => x.ids);
      expect(new Set(all).size).toBe(all.length);
      expect(all.length).toBe(155 + 2);
      for (const id of all) expect(exoData.keplerExoModDestValid(id), String(id)).toBe(true);
      for (let id = 0; id < 155; id++) expect(all.includes(id), String(id)).toBe(true);
      expect(all).toContain(256);
      expect(all).toContain(257);
      expect(destName(-1)).toBe('[NONE]');
      expect(destName(37)).toBe('Cutoff');
      expect(destName(256)).toBe('DCO1 Pitch');
      expect(sourceName(-1)).toBe('[NONE]');
      expect(sourceName(3)).toBe('Env2');
      expect(exoData.KEPLEREXO_MOD_SOURCES.length).toBe(24);
      // the wheel steps through the list, clamped at both ends
      expect(stepSource(-1, -1)).toBe(-1);
      expect(stepSource(-1, 1)).toBe(0);
      expect(stepSource(23, 1)).toBe(23);
      expect(stepDest(-1, 1)).toBe(DEST_GROUPS[0].ids[0]);
      expect(stepDest(DEST_GROUPS[0].ids[0], -1)).toBe(-1);
      const last = DEST_GROUPS[DEST_GROUPS.length - 1].ids.at(-1)!;
      expect(stepDest(last, 1)).toBe(last);
    });

    it('edits the matrix state and keeps its page in view state', () => {
      const { slotId, params } = setup('keplerexo');
      A.editFx(slotId, 'src', (p) => { const m = exoData.keplerExoNormalizeMatrix(p.modMatrix); m.src[5] = 7; m.dst[5] = 150; p.modMatrix = m; });
      expect(params().modMatrix).toMatchObject({ src: [-1, -1, -1, -1, -1, 7, -1, -1] });
      A.setFxStateNoHistory(slotId, 'page', (p) => { p.modPage = 1; });
      expect(params().modPage).toBe(1);
      expect(genDef('keplerexo')!.viewState).toContain('modPage');
      expect(genDef('keplerexo')!.viewState).toContain('theme');
    });

    it('paints the EQ response from the band settings and the saturation curve finitely', () => {
      const flat: Record<string, number> = {};
      for (const b of displays.EQ_BANDS) { flat[b.freq] = 8000; flat[b.gain] = 3000; flat[b.q] = 3000; }
      for (const f of [20, 100, 1000, 10000, 20000]) expect(Math.abs(displays.eqResponseDb(flat, f))).toBeLessThan(1e-6);
      // +16 dB low shelf (control 6000): full boost far below the corner, none far above; the peak band reaches its gain at its centre
      const eq = { ...flat, eqLoGain: 6000, eqLoFreq: 4990, eqMidGain: 6000, eqMidFreq: 10500 };
      expect(displays.eqResponseDb(eq, 20)).toBeGreaterThan(14);
      expect(displays.eqResponseDb(eq, 15000)).toBeLessThan(1);
      const midHz = displays.freqHz(10500);
      expect(displays.eqResponseDb({ ...flat, eqMidGain: 6000, eqMidFreq: 10500 }, midHz)).toBeCloseTo(16, 1);
      expect(displays.eqResponseDb({ ...flat, eqMidGain: 0, eqMidFreq: 10500 }, midHz)).toBeCloseTo(-16, 1);
      // frequency and gain scales are the model's (FL's value texts)
      for (const v of [0, 4990, 10500, 16429, 21000]) {
        expect(Math.round(displays.freqHz(v))).toBe(parseInt(exoData.keplerExoFormat(107, v), 10));
      }
      expect(displays.gainDb(6000)).toBe(16);
      expect(displays.gainDb(0)).toBe(-16);
      expect(displays.gainDb(3000)).toBe(0);
      const colors = { bg: '#000', grid: '#111', gridStrong: '#222', text: '#333', line: '#fff', fill: '#444' };
      for (const v of [flat, eq, { ...flat, eqLoGain: 0, eqHiGain: 6000, eqLoQ: 0, eqHiQ: 6000 }]) displays.drawEq(fakeCtx(), 273, 114, v, true, colors);
      for (const a of [0, 0.25, 1]) displays.drawSat(fakeCtx(), 276, 114, a, a > 0, colors);
      // the engine's shaper: the identity without drive, tanh(3 x g) / (3 tanh g) otherwise (a hard-driven input is held to 1/3)
      expect(displays.satCurve(0.5, 0)).toBeCloseTo(0.5, 12);
      expect(displays.satCurve(0.001, 0.01)).toBeCloseTo(0.00104, 5);
      expect(displays.satCurve(0.5, 1)).toBeCloseTo(1 / 3, 6);
      expect(displays.satCurve(-2, 1)).toBeCloseTo(-1 / 3, 6);
      const [x, y] = displays.eqNodeXY(flat, 1, 273, 114);
      expect(x).toBeCloseTo((8000 / 21000) * 273, 6);
      expect(y).toBeCloseTo(57, 6);
    });
  });

  describe('shared logic', () => {
    it('follows the Juno-6 chorus buttons: click selects or clears, Shift adds', () => {
      expect(chorusClick(0, 1, false)).toBe(1);
      expect(chorusClick(0, 2, false)).toBe(2);
      expect(chorusClick(1, 1, false)).toBe(0);
      expect(chorusClick(1, 2, false)).toBe(2);
      expect(chorusClick(1, 2, true)).toBe(3);
      expect(chorusClick(3, 1, false)).toBe(1);
      expect(chorusClick(3, 2, true)).toBe(1);
      expect(chorusClick(0, 1, true)).toBe(1);
    });

    it('has the wheel menu\'s Set note lengths with FL\'s control values', () => {
      expect(menus.SET_LENGTHS.length).toBe(14);
      expect(menus.SET_LENGTHS.map(([, v]) => v)).toEqual([245760, 244216, 211373, 190725, 164762, 134931, 199737, 176098, 147681, 116283, 220695, 203210, 180324, 152664]);
      const { slotId, params } = setup('keplerexo');
      const m = menus.setLengthMenu(slotId, 'lfo1Rate');
      expect(m).toHaveLength(1);
      expect(m[0].label).toBe('Set');
      const eighth = m[0].submenu!.find((i) => i.label === '1/8')!;
      eighth.onClick!();
      expect(params().lfo1Rate).toBe(190725);
      // the rate reads as beats:ticks once tempo sync is on: 1/8 note = 2 steps
      expect(genDef('keplerexo')!.params.find((p) => p.key === 'lfo1Rate')!.format!(190725, { lfo1Sync: 1 })).toBe('2:0');
    });
  });

  describe('Import FL content', () => {
    const tables = () => ({
      lfo: Int16Array.from({ length: fl.KP_LFO_N }, (_, i) => Math.round(30000 * Math.sin((2 * Math.PI * i) / fl.KP_LFO_N))),
      noise: Int16Array.from({ length: fl.KP_NOISE_N }, (_, i) => ((i * 7919) % 4001) - 2000),
    });

    it('stores the pack as an exact float WAV that reads back', () => {
      const pack = fl.kpPackTables(tables());
      const wav = fldata.packWav(pack);
      expect(wav.byteLength).toBe(44 + 4 * pack.length);
      const back = fldata.wavPack(wav);
      expect(back).not.toBeNull();
      expect(back!.length).toBe(pack.length);
      expect(back!.every((v, i) => v === pack[i])).toBe(true);
      expect(fl.kpUnpackTables(back)).not.toBeNull();
      // damaged or foreign data is refused
      expect(fldata.wavPack(new ArrayBuffer(20))).toBeNull();
      const bad = new Uint8Array(wav.slice(0));
      bad[100] ^= 0x55;
      expect(fldata.wavPack(bad.buffer)).toBeNull();
    });

    it('loads FL\'s tables into a pool sample referenced by flTablesSample, and switches back to the stand-ins', async () => {
      for (const plugin of ['kepler', 'keplerexo'] as const) {
        const { slotId, params } = setup(plugin);
        (fl.kpFindTables as Mock).mockReturnValueOnce(tables());
        const file = new File([new Uint8Array(4096)], 'engine.dylib');
        expect(fldata.usesTables(params())).toBe(false);
        expect(await fldata.importTables(slotId, plugin, file)).toBe(true);
        const id = params()[fldata.TABLES_KEY] as string;
        expect(typeof id).toBe('string');
        expect(id).not.toBe('');
        expect(fldata.usesTables(params())).toBe(true);
        expect(store.project.samples[id].name).toBe(fldata.FL_TABLES_NAME);
        expect(fl.kpUnpackTables(getRaw(id)!.channels[0])).not.toBeNull();
        expect(fldata.projectTables()?.name).toBe(fldata.FL_TABLES_NAME);
        const labels = menus.importItems(slotId, plugin);
        expect(labels.find((m) => m.label === 'Use the stand-in LFO and noise')!.checked).toBe(false);
        fldata.forgetTables(slotId);
        expect(params()[fldata.TABLES_KEY]).toBe('');
        expect(menus.importItems(slotId, plugin).find((m) => m.label === 'Use FL content from this project')).toBeTruthy();
        fldata.reuseTables(slotId);
        expect(params()[fldata.TABLES_KEY]).toBe(fldata.projectTables()!.id);
      }
    });

    it('refuses files that are not the engine library, with a message', async () => {
      const { slotId, params } = setup('kepler');
      const alert = vi.fn();
      (g.window as Record<string, unknown>).alert = alert;
      (fl.kpFindTables as Mock).mockReturnValueOnce(null);
      expect(await fldata.importTables(slotId, 'Kepler', new File([new Uint8Array(1024)], 'Kepler_x64.dylib'))).toBe(false);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(String(alert.mock.calls[0][0])).toContain('engine.dylib');
      expect(params()[fldata.TABLES_KEY] ?? '').toBe('');
      // oversized files are not even read
      const big = { size: 65 << 20, arrayBuffer: vi.fn() } as unknown as File;
      expect(await fldata.importTables(slotId, 'Kepler', big)).toBe(false);
      expect((big as unknown as { arrayBuffer: Mock }).arrayBuffer).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledTimes(2);
    });
  });
});
