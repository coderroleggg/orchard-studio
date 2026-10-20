// Ogun editor: FL's form (every control of the form at its coordinates, every FL parameter bound by Tag), the settings and menu items
// wired to the state fields FL's handlers write, the options menu, the effect presets, curve edits and the keyboard toggle; "Import FL
// content" with synthetic FL files (FL's own files are never part of the repository) and, when the FL install and the re-saved states
// exist (.flref), the FL state parser against all 229 factory presets.
import { describe, it, expect, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import type { OgFlState } from '../../src/model/gen/plugins/ogun/flstate';
import './util';

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

/** FL's form (Ogun_x64.dylib TSynthEditorForm): [component, Left, Top, Width, Height] of the main panel's controls. */
const LAYOUT: [string, number, number, number, number][] = [
  ['FatPitchWheel', 339, 116, 20, 78],
  ['FatOrderSelect', 247, 174, 25, 19],
  ['FatPanWheel', 285, 116, 20, 78],
  ['FatVolWheel', 312, 116, 20, 78],
  ['FatPhaseWheel', 366, 116, 20, 78],
  ['MixEQLevel3Slider', 528, 276, 20, 85],
  ['MixEQFreq1Wheel', 459, 364, 30, 30],
  ['MixEQFreq2Wheel', 491, 364, 30, 30],
  ['MixEQFreq3Wheel', 523, 364, 30, 30],
  ['MixEQBW1Wheel', 459, 397, 30, 30],
  ['MixEQBW2Wheel', 491, 397, 30, 30],
  ['MixEQBW3Wheel', 523, 397, 30, 30],
  ['FCutWheel', 462, 148, 46, 46],
  ['FResWheel', 515, 158, 36, 36],
  ['FullnessWheel', 120, 116, 20, 78],
  ['PreDecayWheel', 39, 116, 20, 78],
  ['RandAmtWheel', 154, 116, 20, 78],
  ['DecayWheel', 66, 116, 20, 78],
  ['ReleaseWheel', 93, 116, 20, 78],
  ['TimbreSeedWheel', 187, 174, 40, 19],
  ['MainVolSlider', 11, 2, 20, 70],
  ['MainCPitchSlider', 44, 2, 20, 70],
  ['ArtSelect', 10, 221, 164, 19],
  ['EnvSelect', 206, 221, 164, 19],
  ['MenuBtn', 534, 41, 19, 19],
  ['KbBtn', 534, 66, 19, 19],
  ['ChDepthWheel', 36, 452, 20, 83],
  ['ChSpeedWheel', 58, 452, 20, 83],
  ['ChDelayWheel', 80, 452, 20, 83],
  ['ChSpreadWheel', 102, 452, 20, 83],
  ['ChCrossWheel', 124, 452, 20, 83],
  ['ChWetWheel', 146, 452, 20, 83],
  ['RevEnableBtn', 469, 435, 34, 17],
  ['RevVolWheel', 534, 452, 20, 83],
  ['RevHDWheel', 511, 452, 20, 83],
  ['RevDecWheel', 489, 452, 20, 83],
  ['RevDiffWheel', 467, 452, 20, 83],
  ['RevRoomWheel', 445, 452, 20, 83],
  ['RevDelWheel', 423, 452, 20, 83],
  ['RevHCWheel', 401, 452, 20, 83],
  ['RevLCWheel', 379, 452, 20, 83],
  ['RevColWheel', 348, 460, 23, 21],
  ['RevTempoBtn', 505, 435, 56, 17],
  ['DelModeSelect', 186, 458, 51, 50],
  ['DelEnableBtn', 248, 435, 33, 17],
  ['DelTempoBtn', 283, 435, 56, 17],
  ['DelFBWheel', 245, 452, 20, 83],
  ['DelTimeWheel', 267, 452, 20, 83],
  ['DelTimeOfsWheel', 289, 452, 20, 83],
  ['DelVolWheel', 311, 452, 20, 83],
  ['FFlatBtn', 409, 181, 40, 30],
  ['FTypeSelect', 464, 101, 88, 18],
  ['FOrderSelect', 464, 120, 88, 18],
  ['ModXWheel', 184, 31, 24, 24],
  ['ModYWheel', 184, 59, 24, 24],
  ['ModSmoothBtn', 237, 66, 69, 17],
  ['MixEQLevel2Slider', 496, 276, 20, 85],
  ['MixEQLevel1Slider', 464, 276, 20, 85],
  ['MixEQType1Select', 464, 256, 22, 17],
  ['MixEQType2Select', 495, 256, 22, 17],
  ['MixEQType3Select', 527, 256, 22, 17],
  ['DeClickBtn', 95, 101, 61, 13],
  ['TimbreSeed2Wheel', 187, 135, 40, 19],
  ['RichnessWheel', 12, 116, 20, 78],
  ['MainFPitchSlider', 67, 2, 20, 70],
  ['EQCombSelect', 400, 221, 38, 20],
  ['AltDecayBtn', 162, 101, 67, 13],
  ['RandPadBtn', 534, 8, 19, 19],
  ['ModVisual', 99, 8, 77, 77],
  ['ModXWheelLabel', 208, 36, 17, 15],
  ['ModYWheelLabel', 208, 64, 17, 15],
  ['InfoEditBevel', 319, 7, 209, 79],
  ['TimbreSeed2Wheel2Label', 215, 158, 11, 10],
  ['TimbreSeedWheel2Label', 215, 197, 11, 10],
  ['ChOrderSelect', 7, 460, 23, 21],
  ['RandAmtWheelLabel1', 150, 197, 11, 10],
  ['RandAmtWheelLabel2', 170, 197, 11, 10],
  ['InfoEdit', 320, 8, 206, 76],
  ['MIDIKb', 0, 554, 560, 85],
];

describe('Ogun editor', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const { editor, PARAM_CONTROLS } = await import('../../src/ui/plugins/gen/ogun');
  const { genEditorFor } = await import('../../src/ui/plugins/genRegistry');
  const { FORM } = await import('../../src/ui/plugins/gen/ogun/form');
  const S = await import('../../src/ui/plugins/gen/ogun/settings');
  const menus = await import('../../src/ui/plugins/gen/ogun/menus');
  const P = await import('../../src/ui/plugins/gen/ogun/presets');
  const curve = await import('../../src/ui/plugins/gen/ogun/curve');
  const use = await import('../../src/ui/plugins/gen/ogun/use');
  const art = await import('../../src/ui/plugins/gen/ogun/ArtEditor');
  const { genDef } = await import('../../src/model/gen/registry');
  const { OGUN_KEYS, ART_TARGETS } = await import('../../src/model/gen/plugins/ogun/params');
  const { ogunBank, entryToState, freshState, normalizeOgun } = await import('../../src/model/gen/plugins/ogun/state');
  const FS = await import('../../src/model/gen/plugins/ogun/flstate');
  const FI = await import('../../src/model/gen/plugins/ogun/flimport');
  const imp = await import('../../src/ui/plugins/gen/ogun/flimport');

  function setup() {
    const id = A.addGenChannel('ogun');
    const slotId = 'ch:' + id;
    const params = () => store.project.channels.find((c) => c.id === id)!.plugin!.params as Record<string, any>;
    const render = () => {
      rec.keys.clear();
      const ctx = { slotId, plugin: 'ogun', params: params(), trackName: 'Ogun', pluginName: 'Ogun' };
      return renderToStaticMarkup(React.createElement(FxEditorContext.Provider, { value: ctx }, React.createElement(editor.Editor)));
    };
    return { id, slotId, params, render };
  }
  /** React writes a zero length without its unit. */
  const px = (v: number) => (v === 0 ? '0' : `${v}px`);
  const has = (html: string, x: number, y: number, w: number, h: number) => html.includes(`left:${px(x)};top:${px(y)};width:${px(w)};height:${px(h)}`);

  it("is registered like the other instrument editors and sized like FL's form", () => {
    expect(editor.id).toBe('ogun');
    expect(genEditorFor('ogun')).toBe(editor);
    const d = genDef('ogun')!;
    expect([d.width, d.height]).toEqual([560, 640]);
    expect(editor.size!({})).toEqual({ w: 560, h: 640 });
    expect(editor.size!({ view: { kb: 0 } })).toEqual({ w: 560, h: 554 });
    expect(d.viewState).toContain('view');
  });

  it("places every control of FL's form at its coordinates and binds all 89 FL parameters", () => {
    const { render, slotId, params } = setup();
    const html = render();
    expect(html.length).toBeGreaterThan(5000);
    // the generated form table equals FL's form dump
    const wrong = LAYOUT.filter(([n, x, y, w, h]) => { const c = FORM[n]; return !c || c.x !== x || c.y !== y || c.w !== w || c.h !== h; });
    expect(wrong.map((m) => m[0])).toEqual([]);
    // every control that has a binding (Tag or setting) is drawn at FL's position
    const skip = new Set(['InfoEdit', 'ModXWheelLabel', 'ModYWheelLabel', 'TimbreSeed2Wheel2Label', 'TimbreSeedWheel2Label', 'RandAmtWheelLabel1', 'RandAmtWheelLabel2', 'QuickLabel1', 'QuickLabel2',
      'QuickLabel3', 'EqTitleLabel', 'TimbreTitleLabelIcon', 'UnisonTitleLabelIcon', 'FatOrderSelectLabel', 'ModulationTitleLabel', 'ChOrderSelectLabel', 'RevColWheelLabel', 'InfoEditBevel',
      'TimbreSeedWheelLabel', 'TimbreSeed2WheelLabel', 'MainVolSliderLabel', 'MainCPitchSliderLabel', 'RandAmtWheelLabel', 'MIDIKb', 'EQCombSelect', 'ModVisual', 'ArtSelect', 'EnvSelect']);
    for (const [n, x, y, w, h] of LAYOUT.filter(([n]) => !skip.has(n))) expect(has(html, x, y, w, h), `${n} at ${x},${y}`).toBe(true);
    expect(has(html, 99, 8, 77, 77), 'ModVisual').toBe(true);
    expect(has(html, 0, 554, 560, 85), 'MIDIKb').toBe(true);
    expect(has(html, 10, 221, 164, 19), 'ArtSelect').toBe(true);
    expect(has(html, 206, 221, 164, 19), 'EnvSelect').toBe(true);
    expect(has(html, 9, 245, 429, 145), 'EnvVisual').toBe(true);
    // parameters 0..48 sit on the main panel, 49..88 (the ADSR / LFO knobs) in the articulator editor of the first five targets
    const keys = new Set(rec.keys);
    for (let t = 0; t <= 4; t++) for (const part of [0, 1]) {
      A.setFxStateNoHistory(slotId, 'view', (d) => { d.view = { ...S.viewOf(d), target: t, part }; });
      render();
      for (const k of rec.keys) keys.add(k);
    }
    expect(OGUN_KEYS.filter((k) => !keys.has(k))).toEqual([]);
    expect(params().view.target).toBe(4);
    expect(PARAM_CONTROLS.length).toBe(49);
  });

  it("keeps FL's control kinds, the keyboard range and the knob ranges", () => {
    const kinds = Object.fromEntries(Object.values(FORM).map((c) => [c.n, c.k]));
    expect(kinds).toMatchObject({ FatPitchWheel: 'slider', FCutWheel: 'wheel', FatOrderSelect: 'digi', DelModeSelect: 'cells', FTypeSelect: 'cells', ArtSelect: 'combo', ModVisual: 'xyz', MIDIKb: 'keyboard' });
    expect(FORM.MIDIKb).toMatchObject({ minKey: 36, maxKey: 83, whiteWidth: 20, blackWidth: 13 });
    expect(FORM.FCutWheel).toMatchObject({ min: 0, max: 256, def: 128, tag: 17 });
    expect(FORM.RichnessWheel).toMatchObject({ min: 1, max: 11, def: 9 });
    expect(FORM.ArtSelect.items!.length).toBe(20);
  });

  // ------------------------------------------------------------ settings

  const base = () => freshState() as Record<string, any>;
  const xiAfter = (name: string, v: number) => { const d = base(); S.SETTINGS[name].set(d, v); return d; };

  it("wires FL's settings controls to the state fields its handlers write", () => {
    const b = base();
    expect(b.xi).toEqual([1, 3, -1, 15, 1, 1, 65793, 0, 16777472, 0, 0, 4, 0, 0, 430]);
    expect(b.b3).toEqual([1, 0, 0]);
    expect(b.i2).toEqual([0, 1, 2]);
    // reads of the constructor state
    expect(Object.fromEntries(Object.entries(S.SETTINGS).map(([k, s]) => [k, s.get(b)]))).toEqual({
      FTypeSelect: 1, FOrderSelect: 3, FFlatBtn: 1, RichnessWheel: 10, RevEnableBtn: 1, RevTempoBtn: 0, ModSmoothBtn: 1, DeClickBtn: 0, AltDecayBtn: 0,
      DelEnableBtn: 0, DelTempoBtn: 1, MixEQType1Select: 0, MixEQType2Select: 1, MixEQType3Select: 2,
    });
    // FTypeSelect / FOrderSelect: ints 49 / 50; FFlatBtn: int 51 = -1 / 0; RichnessWheel: int 52 = value + 5
    expect(xiAfter('FTypeSelect', 3).xi[0]).toBe(3);
    expect(xiAfter('FOrderSelect', 0).xi[1]).toBe(0);
    expect(xiAfter('FFlatBtn', 0).xi[2]).toBe(0);
    expect(xiAfter('FFlatBtn', 1).xi[2]).toBe(-1);
    expect(xiAfter('RichnessWheel', 5).xi[3]).toBe(10);
    // the reverb switches are bytes 0 / 1 of int 53 (plug+0x210 / 0x211), the delay's are plug+0x369 (enable) / 0x368 (tempo)
    expect(xiAfter('RevEnableBtn', 0).xi[4]).toBe(0);
    expect(xiAfter('RevTempoBtn', 1).xi[4]).toBe(0x101);
    expect(xiAfter('DelEnableBtn', 1).b3).toEqual([1, 1, 0]);
    expect(xiAfter('DelTempoBtn', 0).b3).toEqual([0, 0, 0]);
    // smooth modulation: plug+0x218, attack click removal plug+0x21e, alternate decay plug+0x234
    expect(xiAfter('ModSmoothBtn', 0).xi[6]).toBe(65792);
    expect(xiAfter('DeClickBtn', 1).xi[7]).toBe(0x10000);
    expect(xiAfter('AltDecayBtn', 1).xi[13]).toBe(1);
    // the three EQ band types are three ints (plug+0x398 / 0x418 / 0x498)
    expect(xiAfter('MixEQType3Select', 1).i2).toEqual([0, 1, 1]);
    expect(xiAfter('MixEQType1Select', 2).i2).toEqual([2, 1, 2]);
    // a state with a short or missing array still takes the writes
    const d: Record<string, any> = {};
    S.SETTINGS.DeClickBtn.set(d, 1);
    S.SETTINGS.MixEQType2Select.set(d, 0);
    expect(d.xi.length).toBe(15);
    expect(d.xi[7]).toBe(0x10000);
    expect(d.i2).toEqual([0, 0, 2]);
  });

  it("wires the options menu's switches like TSynthResModule's handlers", () => {
    const m = (id: string, v: number) => { const d = base(); S.MENU_SETTINGS[id].set(d, v); return d; };
    // portamento: bytes of int 57 (plug+0x220 enable, 0x221 variable time, 0x222 limit, 0x223 natural EQ scale)
    expect(m('porta', 1).xi[8]).toBe(16777473);
    expect(m('portaVar', 0).xi[8]).toBe(16777216);
    expect(m('portaLimit', 3).xi[8]).toBe(16777472 + (3 << 16));
    expect(m('octEQScale', 0).xi[8]).toBe(256);
    // key / velocity: int 55 (smooth, one voice per key, velocity -> volume, key -> pitch), int 56 (key -> seed, velocity bits, click removal, release link)
    expect(m('keyPitch', 1).xi[6]).toBe(0x01010101);
    expect(m('monoKey', 0).xi[6]).toBe(65537);
    expect(m('velVol', 0).xi[6]).toBe(257);
    expect(m('keySeed', 1).xi[7]).toBe(1);
    expect(m('velAttLength', 1).xi[7]).toBe(0x100); // bit 0 of plug+0x21d
    expect(m('velAttTime', 1).xi[7]).toBe(0x200); // bit 1
    expect(m('releaseLink', 1).xi[7]).toBe(0x01000000);
    // quality: int 54; auto loudness / natural EQ weighting: plug+0x235 / 0x236
    expect(m('quality', 4).xi[5]).toBe(4);
    expect(m('autoLoudness', 1).xi[13]).toBe(256);
    expect(m('natWeight', 1).xi[13]).toBe(65536);
    // both velocity switches
    const d = base();
    S.MENU_SETTINGS.velAttLength.set(d, 1);
    S.MENU_SETTINGS.velAttTime.set(d, 1);
    expect(d.xi[7]).toBe(0x300);
    expect(S.MENU_SETTINGS.velAttLength.get(d)).toBe(1);
    S.MENU_SETTINGS.velAttLength.set(d, 0);
    expect(d.xi[7]).toBe(0x200);
    // the harmonic combs of the four shaping maps are ints 58..61
    expect(S.combSetting(12)).toBeNull();
    for (let t = 13; t <= 16; t++) { const e = base(); S.combSetting(t)!.set(e, 5); expect(e.xi[9 + t - 13]).toBe(5); }
  });

  it('lists the options menu like FL and every item changes the state it names', () => {
    const { slotId, params } = setup();
    const find = (items: any[], label: string): any => {
      for (const it of items) {
        if (it.label === label) return it;
        const r = it.submenu ? find(it.submenu, label) : null;
        if (r) return r;
      }
      return null;
    };
    const click = (label: string) => { const it = find(menus.ogunMenu(slotId), label); expect(it, label).toBeTruthy(); it.onClick(); };
    const labels = menus.ogunMenu(slotId).map((i: any) => i.label);
    for (const l of ['Copy preset', 'Paste preset', 'Generate random preset', 'Enter random preset number...', 'Effects', 'Unison', 'Chorus', 'Reverb', 'Tone', 'Portamento', 'Key', 'Velocity',
      'Processing quality', 'Link timbre release to volume decay', 'Natural EQ mapping scale', 'Natural EQ mapping weighting', 'Auto loudness', 'Resynthesis', 'Analyze timbre...', 'Import FL content...']) {
      expect(labels, l).toContain(l);
    }
    expect(find(menus.ogunMenu(slotId), 'Alt flanger')).toBeTruthy();
    expect(menus.PORTA_LIMITS).toEqual(['No limit', 'Octave wrap', '4 semitones limit', '3 semitones limit', '2 semitones limit', '1 semitone limit']);
    expect(menus.QUALITY_NAMES).toEqual(['Draft', 'Average', 'High', 'Pristine', 'Huge waste of CPU']);
    // the checks start at the constructor state and toggle their field
    click('Enable portamento');
    expect(params().xi[8]).toBe(16777473);
    expect(find(menus.ogunMenu(slotId), 'Enable portamento').checked).toBe(true);
    click('Enable portamento');
    expect(params().xi[8]).toBe(16777472);
    click('Variable time');
    expect(params().xi[8]).toBe(16777216);
    click('2 semitones limit');
    expect(params().xi[8]).toBe(16777216 + (4 << 16));
    expect(find(menus.ogunMenu(slotId), '2 semitones limit').checked).toBe(true);
    click('Link key to pitch');
    click('Link key to timbre seed 1');
    click('Limit to 1 voice per key');
    click('Link velocity to volume');
    click('Link velocity to attack time');
    click('Link velocity to attack length');
    expect([params().xi[6], params().xi[7]]).toEqual([0x01000001, 0x301]);
    click('Draft');
    expect(params().xi[5]).toBe(0);
    click('Huge waste of CPU');
    expect(params().xi[5]).toBe(4);
    click('Link timbre release to volume decay');
    click('Natural EQ mapping scale');
    click('Natural EQ mapping weighting');
    click('Auto loudness');
    expect(params().xi[7]).toBe(0x01000301);
    expect(params().xi[8]).toBe(4 << 16);
    expect(params().xi[13]).toBe(0x10100);
  });

  // ------------------------------------------------------------ presets, views, curves

  it("applies the unison / chorus / reverb presets like FL's handlers (parameters 12..16, 19..24 without the mix, 31..39)", () => {
    const { slotId, params } = setup();
    expect([P.UNISON_PRESETS.length, P.CHORUS_PRESETS.length, P.REVERB_PRESETS.length]).toEqual([7, 10, 7]);
    const read = (keys: string[]) => keys.map((k) => params()[k]);
    menus.applyUnison(slotId, 5); // Fat
    expect(read(P.UNISON_KEYS)).toEqual([9, 100, 128, 180, 0]);
    menus.applyUnison(slotId, 0); // Default: volume 100
    expect(read(P.UNISON_KEYS)).toEqual([4, 128, 100, 128, 16]);
    A.setFxParam(slotId, 'choMix', -40);
    menus.applyChorus(slotId, 4); // Alt flanger
    expect(read(P.CHORUS_KEYS)).toEqual([1, 130, 300, 0, 0, 128]);
    expect(params().choMix).toBe(-40); // FL's handler copies only six values
    menus.applyReverb(slotId, 3); // Cathedral: switches the reverb on, tempo-based predelay off
    expect(read(P.REVERB_KEYS)).toEqual([34, 21, 27, 90, 100, 45, 31, 3, 50]);
    expect(params().xi[4] & 0xffff).toBe(1);
    menus.applyReverb(slotId, 4); // Large hall: low cut 0 is below the control's minimum 19
    expect(params().revLow).toBe(19);
    menus.applyReverb(slotId, 6); // None
    expect(params().xi[4] & 0xffff).toBe(0);
    expect(read(P.REVERB_KEYS)).toEqual([75, 40, 0, 40, 100, 15, 40, 2, 25]);
    // one undo step per preset
    const before = store.historyLabels().past.length;
    menus.applyChorus(slotId, 1);
    expect(store.historyLabels().past.length).toBe(before + 1);
    expect(store.historyLabels().past.at(-1)).toBe('Chorus: Deep chorus');
  });

  it("selects the editor target and articulator part like FL's combos (mapping targets have four parts, the EQ maps one)", () => {
    expect(S.TARGET_NAMES.length).toBe(17);
    expect(S.TARGET_NAMES[4]).toBe('Unison pitch');
    expect(S.TARGET_NAMES[13]).toBe('Timbre forced harmonics');
    expect(S.partsOf(0)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(S.partsOf(7)).toEqual([2, 3, 4, 5]);
    expect(S.partsOf(14)).toEqual([-1]);
    expect(S.clampPart(7, 0)).toBe(2);
    expect(S.partToValue(7, 4)).toBe(2);
    expect(S.valueToPart(7, 2)).toBe(4);
    expect(S.viewOf({})).toEqual({ target: 0, part: 0, kb: 1 });
    expect(S.viewOf({ view: { target: 99, part: 9, kb: 0 } })).toEqual({ target: 16, part: -1, kb: 0 });
    expect(S.partFor({ target: 0, part: 0, kb: 1, parts: [1, 0, 0, 0, 0, 0, 0, 5] }, 7)).toBe(5);
    expect(S.curvePath(0, 0)).toEqual(['arts', 0, 'e']);
    expect(S.curvePath(3, 1)).toEqual(['arts', 3, 'l']);
    expect(S.curvePath(3, 4)).toEqual(['arts', 3, 'k', 2]);
    expect(S.curvePath(15, -1)).toEqual(['maps', 2]);
    expect(S.missingKey(['maps', 1])).toBe('m1');
    expect(S.missingKey(['arts', 3, 'k', 2])).toBe('a3k2');
    expect(S.missingKey(['arts', 12, 'e'])).toBe('a12e');
    expect(S.knobKey(2, 6)).toBe('resLfoSkw');
    expect(S.knobKey(5, 0)).toBeNull();
    // FL's combo item lists
    expect(S.ART_ITEMS.filter((s) => s.startsWith('-'))).toEqual(['-Articulation', '-Mapping', '-Timbre equalization']);
    expect(S.PART_ITEMS.length).toBe(6);
  });

  it('writes curve edits into the state, drops the missing mark of an edited curve and keeps the curve valid', () => {
    const { slotId, params } = setup();
    A.editFx(slotId, 'prepare', (d) => { d.missing = ['m1', 'a0e']; });
    const path = S.curvePath(14, -1);
    const c = use.curveAt(params(), path)!;
    expect(c.t).toBe(3);
    const next = curve.addPoint(c, 0.4, 0.8, 'map').e;
    expect(curve.validCurve(next)).toBe(true);
    use.writeCurve(slotId, path, next, 'add point');
    expect(params().maps[1].p.length).toBe(c.p.length + 1);
    expect(params().missing).toEqual(['a0e']);
    // the articulator's envelope curve
    const e = use.curveAt(params(), S.curvePath(0, 0))!;
    use.writeCurve(slotId, S.curvePath(0, 0), curve.setEnabled(e, true), 'enable');
    expect(params().arts[0].e.m[1]).toBe(-1);
    expect(params().missing).toEqual([]);
    // an edit is one undo step
    const n = store.historyLabels().past.length;
    use.writeCurve(slotId, path, curve.flip(next), 'flip');
    expect(store.historyLabels().past.length).toBe(n + 1);
    store.undo();
    expect(params().maps[1].p.length).toBe(c.p.length + 1);
  });

  it('shows and hides the testing keyboard (view state, no undo entry) and keeps the info memo text', () => {
    const { slotId, params, render } = setup();
    expect(has(render(), 0, 554, 560, 85)).toBe(true);
    const n = store.historyLabels().past.length;
    use.setView(slotId, 'Keyboard', { kb: 0 });
    expect(params().view.kb).toBe(0);
    expect(store.historyLabels().past.length).toBe(n);
    expect(has(render(), 0, 554, 560, 85)).toBe(false);
    expect(editor.size!(params())).toEqual({ w: 560, h: 554 });
    // the info text (lines separated by CR) shows as lines in the memo
    use.editState(slotId, 'Info / comments', (d) => { d.info = 'My preset\rAuthor'; });
    expect(render()).toContain('My preset\nAuthor');
    // the menu of the plugin window carries the options and the keyboard switch
    const labels = editor.menu!(slotId).map((i: any) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['Copy preset', 'Import FL content...', 'Show testing keyboard']));
  });

  it('copies a preset as text and pastes only known state keys', () => {
    const st = freshState() as Record<string, any>;
    const text = menus.presetText({ ...st, view: { target: 3 }, __preset: 'x' });
    expect(text).not.toContain('"view"');
    const back = menus.parsePresetText(text)!;
    expect(back.xi).toEqual(st.xi);
    expect((back.arts as unknown[]).length).toBe(13);
    expect(menus.parsePresetText('{"ogun":1,"state":{"evil":1,"level":99}}')).toEqual({ level: 99 });
    expect(menus.parsePresetText('not json')).toBeNull();
    expect(menus.parsePresetText('{"ogun":2,"state":{}}')).toBeNull();
  });

  it('knows the shape of FL curves: the LFO speed knob in cycles per curve unit (TMLFO 0x450b70)', () => {
    expect(art.lfoCyclesPerUnit(512)).toBeGreaterThan(0);
    expect(art.lfoCyclesPerUnit(40000)).toBeCloseTo(0.4408, 3);
    expect(art.lfoCyclesPerUnit(65536)).toBeCloseTo(16, 0);
  });

  // ------------------------------------------------------- synthetic FL states and files

  class Bytes {
    a: number[] = [];
    i32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); this.a.push(...b); return this; }
    f32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this.a.push(...b); return this; }
    f64(v: number) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); this.a.push(...b); return this; }
    u8(v: number) { this.a.push(v & 255); return this; }
    raw(b: ArrayLike<number>) { for (let i = 0; i < b.length; i++) this.a.push(b[i]); return this; }
  }
  type Env = { t: number; p: number[][]; m: number[]; a?: number[]; l?: number[]; ph?: number };
  /** A curve in FL's stream (curve version 3: doubles, point bytes, markers, ADSR / LFO values). */
  function curveBytes(c: Env, ver = 3): Bytes {
    const w = new Bytes().i32(c.t).i32(ver).i32(c.p.length);
    for (const q of c.p) {
      if (ver >= 2) w.f64(q[0]).f64(q[1]); else w.f32(q[0]).f32(q[1]);
      w.f32(q[2]);
      if (ver >= 1) w.u8(q[3] ?? 0).u8(q[4] ?? 0).u8(q[5] ?? 0).u8(q[6] ?? 0);
    }
    for (const v of c.m) w.i32(v);
    if (c.t === 1) for (const v of c.a!) w.i32(v);
    if (c.t === 2) { for (const v of c.l!) w.i32(v); if (ver >= 3) w.i32(c.ph ?? 0); }
    return w;
  }
  const artBytes = (a: { mode: number; ea: number; la: number; e: Env; l: Env; k: Env[] }, ver = 3): Bytes => {
    const w = new Bytes().i32(3).f32(a.mode).f32(a.ea).f32(a.la);
    w.raw(curveBytes(a.e, ver).a).raw(curveBytes(a.l, ver).a);
    for (const k of a.k) w.raw(curveBytes(k, ver).a);
    return w;
  };
  /** FL's RTF of an info text (RichEdit: every line ends with \par). */
  const rtf = (lines: string[]) => new TextEncoder().encode(`{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fnil\\fcharset0 Arial;}}\r\n{\\colortbl ;\\red192\\green198\\blue201;}\r\n\\viewkind4\\uc1\\pard\\cf1\\b\\fs18 ${lines.join('\\par ')}\\par }\r\n\0`);
  interface St { version: number; ints: number[]; b3: number[]; eq: number[]; info: string[]; arts: any[]; maps: Env[] }
  /** A plugin state blob: u32 version + zlib(settings, EQ types, info, articulators, maps), as FL's SaveRestoreState lays it out. */
  function stateBlob(o: St, curveVer = 3): Uint8Array {
    const ver = o.version >= 0x10000 ? o.version >>> 16 : o.version;
    const w = new Bytes();
    for (let i = 0; i < (ver >= 8 ? 3 : 2); i++) w.i32(o.ints[i]);
    let n2 = 244;
    for (const [v, k] of [[1, 1], [2, 3], [7, 1], [9, 16], [11, 1], [12, 1], [13, 6]] as const) if (ver < v) n2 -= k;
    const region = new Uint8Array(244), dv = new DataView(region.buffer);
    for (let i = 0; i < 46; i++) dv.setInt32(4 * i, o.ints[3 + i], true);
    for (let k = 0; k < 15; k++) dv.setInt32(0x200 - 0x148 + 4 * k, o.ints[49 + k], true);
    w.raw(region.subarray(0, n2));
    w.raw(o.b3);
    for (const e of o.eq) w.i32(e);
    if (ver < 18) { const r = rtf(o.info); w.i32(r.length).raw(r); } else { const t = o.info.join('\r'); w.u8(t.length); for (const ch of t) w.u8(ch.charCodeAt(0)).u8(ch.charCodeAt(0) >> 8); }
    // what a version does not store: articulators 4 / 5 (< 4), 11 / 12 (< 10), the forced harmonics map (< 5)
    o.arts.forEach((a, i) => { if (!((ver < 4 && (i === 4 || i === 5)) || (ver < 10 && (i === 11 || i === 12)))) w.raw(artBytes(a, curveVer).a); });
    o.maps.forEach((m, j) => { if (!(ver < 5 && j === 0)) w.raw(curveBytes(m, curveVer).a); });
    const z = deflateSync(Uint8Array.from(w.a));
    const out = new Uint8Array(4 + z.length);
    new DataView(out.buffer).setUint32(0, o.version, true);
    out.set(z, 4);
    return out;
  }
  /** An FL preset file: FLhd, FLdt and event 213 (the plugin state). */
  function fst(blob: Uint8Array): Uint8Array {
    const ev = [0xd5];
    let n = blob.length;
    do { const b = n & 0x7f; n >>>= 7; ev.push(n ? b | 0x80 : b); } while (n);
    const out = new Uint8Array(22 + ev.length + blob.length);
    const o = new DataView(out.buffer);
    out.set([0x46, 0x4c, 0x68, 0x64]); o.setUint32(4, 6, true);
    out.set([0x46, 0x4c, 0x64, 0x74], 14); o.setUint32(18, ev.length + blob.length, true);
    out.set(ev, 22); out.set(blob, 22 + ev.length);
    return out;
  }
  const file = (b: Uint8Array, name: string) => new File([b as BlobPart], name);
  /** The rule FL applies to the kind byte of every point but the first. */
  const kindOf = (t: number) => (t === 0 ? 2 : t > 0 ? 1 : 255);
  const env = (xs: [number, number, number][], extra: Partial<Env> = {}): Env => ({
    t: 1, m: [0, 0, 1, -1, 2], a: [128, 128, 0, 128], ...extra,
    p: xs.map(([x, y, t], i) => [x, y, t, 0, 0, 0, i === 0 ? 0 : kindOf(t)]),
  });
  const lfo = (): Env => ({ t: 2, m: [0, 0, -1, -1, 2], l: [40000, 0, 0, 0], ph: 12345, p: [[0, 0.5, 0, 0, 0, 0, 0], [1, 0.5, 0, 0, 0, 0, 2], [0.25, 1, 0, 0, 0, 0, 2]] });
  const map = (ys: number[]): Env => ({ t: 3, m: [0, -1, -1, -1, -1], p: ys.map((y, i) => [i === 0 ? 0 : 1 / (ys.length - 1), y, 0, 0, 0, 0, i === 0 ? 0 : 2]) });
  const sampleArt = (i: number) => ({ mode: 0, ea: 1, la: 1, e: env([[0, 0, 0], [0.5, 1, 0.25], [1, 0.5, -0.5]]), l: lfo(), k: [0, 1, 2, 3].map(() => map([0.5, i ? 0.5 : 0.25, 0.5])) });
  const sample = (version: number): St => ({
    version,
    ints: [200, 3, -5, 500, 600, 700, 3000, 2000, 100, 400, 7, 9, 3, 128, 100, 130, 60, 100, 150, 2, 300, 700, 12, 100, -20, 70, 60, 100, 30, 50, 1, 1000, 30, 4, 50, 90, 10, 50, 3, 40, 10, 20, 30, 9000, 30000, 50000, 18000, 17000, 16000,
      2, 3, -1, 12, 1, 2, 0x01010101, 0x00020301, 0x00030201, 3, 4, 5, 6, 0x00010100, 777],
    b3: [1, 1, 0], eq: [1, 0, 2], info: ['Title', 'Author', 'Info'],
    arts: Array.from({ length: 13 }, (_, i) => sampleArt(i)), maps: [map([0, 0, 0]), map([0.5, 1, 0.25, 0.75]), map([1, 0.5]), map([0.2, 0.2])],
  });

  it('reads the newest FL state: settings, EQ types, UTF-16 info, 13 articulators and 4 maps', () => {
    const st = sample(0x130003);
    const got = FS.parseOgunState(stateBlob(st));
    expect(got.version).toBe(19);
    expect(got.ints).toEqual(st.ints);
    expect(got.b3).toEqual([1, 1, 0]);
    expect(got.eq).toEqual([1, 0, 2]);
    expect(got.info).toBe('Title\rAuthor\rInfo');
    expect(got.arts.length).toBe(13);
    expect(got.arts[3].e).toEqual(st.arts[3].e);
    expect(got.arts[3].l).toEqual(st.arts[3].l);
    expect(got.arts[12].k[2].p).toEqual(st.arts[12].k[2].p);
    expect(got.maps[1]).toEqual(st.maps[1]);
    expect(got.defaulted).toEqual([]);
    // the same file as an .fst
    expect(FS.parseOgunFile(fst(stateBlob(st)))!.ints).toEqual(st.ints);
    expect(FS.parseOgunFile(stateBlob(st))!.ints).toEqual(st.ints); // a raw state blob is taken as it is
  });

  it('reads the older state versions: RTF info, shorter settings blocks with FL\'s defaults, articulators and maps FL did not store', () => {
    // version 14: everything of the newest layout but the info text is RTF
    const v14 = FS.parseOgunState(stateBlob(sample(14)));
    expect(v14.version).toBe(14);
    expect(v14.info).toBe('Title\rAuthor\rInfo');
    expect(v14.ints.slice(49)).toEqual(sample(14).ints.slice(49));
    // version 9: no alternate decay / auto loudness / natural weighting (ints 62 / 63 keep FL's defaults: magic dust 430)
    const v9 = FS.parseOgunState(stateBlob(sample(9)));
    expect(v9.ints.slice(49, 62)).toEqual(sample(9).ints.slice(49, 62));
    expect(v9.ints[62]).toBe(0);
    expect(v9.ints[63]).toBe(430);
    expect(v9.defaulted).toEqual(['a11', 'a12']);
    expect(v9.arts[11]).toEqual(FS.defaultArt(11));
    expect(v9.arts[11].k[0].p[0][1]).toBe(0.5);
    // version 7: no combs (ints 58..61 are 0), no master fine pitch (parameter 2: since version 8)
    const v7 = FS.parseOgunState(stateBlob(sample(7)));
    expect(v7.ints.slice(58, 62)).toEqual([0, 0, 0, 0]);
    expect(v7.ints[2]).toBe(0);
    expect(v7.ints.slice(3, 49)).toEqual(sample(7).ints.slice(3, 49));
    expect(FS.parseOgunState(stateBlob(sample(8))).ints[2]).toBe(-5);
    // version 4 has articulators 4 / 5 (only versions < 4 lack them) but no forced harmonics map
    const v4 = FS.parseOgunState(stateBlob(sample(4)));
    expect(v4.defaulted).toEqual(['a11', 'a12', 'm0']);
    expect(v4.maps[0]).toEqual(FS.defaultForcedMap());
    // version 0: two parameters before the block (no fine pitch), articulators 4 / 5 and 11 / 12 default, the maps are converted
    const st0 = sample(0);
    const v0 = FS.parseOgunState(stateBlob(st0, 2));
    expect(v0.ints[2]).toBe(0);
    expect(v0.defaulted).toEqual(['a4', 'a5', 'a11', 'a12', 'm0']);
    expect(v0.converted).toEqual(['m1', 'm2', 'm3']);
    expect((v0.ints[57] >>> 24) & 255).toBe(1); // the natural EQ mapping scale is switched on by the conversion
    for (const m of v0.maps) expect(m.p[0][0]).toBe(0);
    for (const m of v0.maps.slice(1)) {
      // FL's octave scale: points at k / 15, a flat run keeps its ends, the last point sits at 1
      const total = m.p.reduce((s, q) => s + q[0], 0);
      expect(total).toBeCloseTo(1, 6);
      expect(m.p.length).toBeLessThanOrEqual(16);
    }
  });

  it('turns FL\'s RTF info into plain text like the RichEdit does (paragraphs joined by CR)', () => {
    const t = (s: string) => FS.rtfToText(new TextEncoder().encode(s));
    expect(t('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\pard A\\par B\\par C\\par }\0')).toBe('A\rB\rC');
    expect(t('{\\rtf1\\ansi\\pard A\\par B\\par \\par }')).toBe('A\rB\r');
    expect(t("{\\rtf1\\ansi caf\\'e9 \\u8364? \\{x\\}\\par }")).toBe('café € {x}');
    expect(t('plain text\0')).toBe('plain text');
  });

  it('refuses damaged, hostile and unknown FL states without throwing out of the file reader', () => {
    const good = stateBlob(sample(0x130003));
    expect(FS.parseOgunFile(good.subarray(0, 40))).toBeNull();
    expect(FS.parseOgunFile(good.subarray(0, good.length - 30))).toBeNull();
    expect(FS.parseOgunFile(new Uint8Array(0))).toBeNull();
    expect(FS.parseOgunFile(new Uint8Array(1000).fill(7))).toBeNull();
    const newer = good.slice();
    new DataView(newer.buffer).setUint32(0, 0x140003, true);
    expect(() => FS.parseOgunState(newer)).toThrow();
    // a decompression bomb stays below the cap
    const z = deflateSync(Buffer.alloc(150_000_000));
    const bomb = new Uint8Array(4 + z.length);
    new DataView(bomb.buffer).setUint32(0, 0x130003, true);
    bomb.set(z, 4);
    expect(() => FS.parseOgunState(bomb)).toThrow(/too large/);
    // absurd counts and lengths are refused before anything is allocated
    const hostile = (mut: (w: Bytes) => void) => {
      const w = new Bytes();
      for (let i = 0; i < 3; i++) w.i32(0);
      w.raw(new Uint8Array(244)); w.raw([0, 0, 0]); w.i32(0).i32(1).i32(2);
      w.u8(0); // empty info (version 18+)
      mut(w);
      const z = deflateSync(Uint8Array.from(w.a));
      const out = new Uint8Array(4 + z.length);
      new DataView(out.buffer).setUint32(0, 0x130003, true);
      out.set(z, 4);
      return out;
    };
    expect(() => FS.parseOgunState(hostile((w) => w.i32(3).i32(3).i32(0x7fffffff)))).toThrow(); // wrong curve type first
    expect(() => FS.parseOgunState(hostile((w) => w.i32(3).f32(0).f32(1).f32(1).i32(1).i32(3).i32(0x7fffffff)))).toThrow(/point count/);
    expect(() => FS.parseOgunState(hostile((w) => w.i32(3).f32(0).f32(1).f32(1).i32(1).i32(9).i32(0)))).toThrow(/curve version/);
    expect(() => FS.parseOgunState(hostile((w) => w.i32(3).f32(0).f32(1).f32(1).i32(2).i32(3).i32(0)))).toThrow(/curve type/);
  });

  // ------------------------------------------------------------ import into a state

  const { genPresetState } = await import('../../src/model/gen/registry');
  const presetNames = genDef('ogun')!.presets!.map((p) => p.name);
  const pf = (path: string, b: Uint8Array) => {
    const f = new File([b as BlobPart], path.split('/').pop()!);
    Object.defineProperty(f, 'webkitRelativePath', { value: path });
    return f;
  };
  /** A dense map like FL's resynthesis maps: `n` points, x = 1 / (n - 1) apart. */
  const dense = (n: number, seed: number): Env => ({
    t: 3, m: [0, -1, -1, -1, -1],
    p: Array.from({ length: n }, (_, i) => [i === 0 ? 0 : 1 / (n - 1), Math.fround(0.5 + 0.4 * Math.sin(i * 0.37 + seed)), 0, 0, 0, 0, i === 0 ? 0 : 2]),
  });
  /** The FL state of a model preset (its settings, EQ types and info), with dense maps for the curves the model leaves out. */
  function flOf(index: number, version = 0x130003): { st: St; bytes: Uint8Array; state: Record<string, any> } {
    const entry = ogunBank()[index];
    const state = entryToState(entry) as Record<string, any>;
    const ints = [...OGUN_KEYS.slice(0, 49).map((k) => state[k] as number), ...(state.xi as number[])];
    const maps: Env[] = state.maps.map((m: Env, j: number) => (entry.x.includes(`m${j}`) ? dense(3000 + j * 500, j) : m));
    const st: St = { version, ints, b3: state.b3, eq: state.i2, info: (state.info as string).split('\r'), arts: state.arts, maps };
    return { st, bytes: stateBlob(st), state };
  }
  const withMissing = ogunBank().findIndex((e) => e.x.includes('m1'));
  /** The preset (not `withMissing`) whose file agrees least with `state`: a file that is not the preset's own. */
  function otherThan(state: Record<string, any>): number {
    let best = -1, low = 2;
    for (let i = 0; i < ogunBank().length; i += 3) {
      if (i === withMissing) continue;
      const f = flOf(i).st;
      const score = FI.matchScore(state, { ...f, info: f.info.join('\r') } as unknown as OgFlState);
      if (score < low) { low = score; best = i; }
    }
    expect(low).toBeLessThan(FI.SCAN_SCORE);
    return best;
  }

  function loadPreset(slotId: string, index: number): Record<string, any> {
    const fresh = genPresetState('ogun', genDef('ogun')!.presets![index]);
    A.editFx(slotId, 'preset', (p) => { for (const k of Object.keys(p)) delete p[k]; Object.assign(p, fresh); });
    return fresh as Record<string, any>;
  }

  it('imports the dense maps of the preset named like the state, in one undo step, from the picked FL folder', async () => {
    expect(withMissing).toBeGreaterThan(0);
    const { slotId, params } = setup();
    const fresh = loadPreset(slotId, withMissing);
    const keys: string[] = fresh.missing;
    expect(keys).toContain('m1');
    expect(params().__preset).toBe(presetNames[withMissing]);
    expect(params().maps[1].p.length).toBeLessThan(10); // the stand-in
    const { bytes, st } = flOf(withMissing);
    const read = FS.parseOgunState(bytes); // what FL's loader makes of the file (the x values are scaled to the curve's length in double)
    const other = flOf(otherThan(fresh));
    const name = presetNames[withMissing];
    const files = [pf(`Ogun/Default.fst`, fst(other.bytes)), pf(`Ogun/${name}.fst`, fst(bytes)), pf('Ogun/readme.txt', new Uint8Array(4))];
    const n = store.historyLabels().past.length;
    const msg = await imp.importFlContent(slotId, files);
    expect(msg).toMatch(new RegExp(`imported ${keys.filter((k) => k.startsWith('m')).length} curve`));
    for (const k of keys) if (/^m\d$/.test(k)) expect(params().maps[+k[1]]).toEqual(read.maps[+k[1]]);
    expect(params().missing.filter((k: string) => /^m\d$/.test(k))).toEqual([]);
    expect(store.historyLabels().past.length).toBe(n + 1);
    // undo gives the stand-ins and the missing marks back
    store.undo();
    expect(params().missing).toEqual(keys);
    expect(params().maps[1].p.length).toBeLessThan(10);
    // the imported state is a valid state: normalisation keeps the dense curves
    await imp.importFlContent(slotId, files);
    expect(params().maps[1].p.length).toBe(st.maps[1].p.length);
  });

  it('finds the preset by comparing the picked files when the state has no preset name, and says so when nothing matches', async () => {
    const { slotId, params } = setup();
    loadPreset(slotId, withMissing);
    A.editFx(slotId, 'rename', (p) => { delete p.__preset; });
    const mine = flOf(withMissing), other = flOf(otherThan(params()));
    const msg = await imp.importFlContent(slotId, [pf('Ogun/a.fst', fst(other.bytes)), pf('Ogun/b.fst', fst(mine.bytes))]);
    expect(msg).toContain('imported');
    expect(msg).toContain('from b');
    expect(params().maps[1].p.length).toBe(mine.st.maps[1].p.length);
    // nothing alike among the files
    loadPreset(slotId, withMissing);
    expect(await imp.importFlContent(slotId, [pf('Ogun/a.fst', fst(other.bytes))])).toMatch(/no FL preset like/);
    expect(await imp.importFlContent(slotId, [pf('Ogun/a.txt', new Uint8Array(3))])).toMatch(/no FL preset \(\.fst\)/);
    expect(params().missing).toContain('m1');
    // a state without missing content has nothing to import
    A.editFx(slotId, 'clear', (p) => { p.missing = []; });
    expect(await imp.importFlContent(slotId, [pf('Ogun/b.fst', fst(mine.bytes))])).toMatch(/nothing|no FL content/);
  });

  it("fills missing envelope / LFO curves: knobs still at the stand-in's defaults follow the file, knobs the user turned stay; refuses curves that are no FL content", () => {
    const state = freshState() as Record<string, any>;
    state.missing = ['a0e', 'a1l', 'a5e', 'm0'];
    state.volAtt = 77; // the first articulator keeps its knobs as flat parameters: turned by the user
    state.fltLfoTns = 5; // the same for the filter LFO
    state.arts[5].e.a = [128, 100, 0, 128]; // the others in the curve
    const st = { ...FS.parseOgunState(stateBlob(sample(0x130003))) };
    const dense = (n: number) => Array.from({ length: n }, (_, i) => [i === 0 ? 0 : 0.1, (i % 5) / 5, 0] as [number, number, number]);
    st.arts = st.arts.slice();
    st.arts[0] = { ...st.arts[0], e: env(dense(40), { a: [1, 2, 3, 4] }) };
    st.arts[1] = { ...st.arts[1], l: { ...lfo(), p: dense(20).map((q, i) => [...q, 0, 0, 0, i === 0 ? 0 : 2]), l: [111, 222, 333, 444], ph: 999 } };
    st.arts[5] = { ...st.arts[5], e: env(dense(30), { a: [9, 8, 7, 6] }) };
    const r = FI.fillMissing(state, st);
    expect(r.filled).toEqual(['a0e', 'a1l', 'a5e']);
    expect(r.absent).toEqual(['m0']); // the file's map is as small as the stand-in
    expect(state.arts[0].e.p.length).toBe(40);
    expect(state.arts[0].e.a).toEqual([77, 2, 3, 4]);
    expect(['volAtt', 'volDec', 'volSus', 'volRel'].map((k) => state[k])).toEqual([77, 2, 3, 4]);
    expect(state.arts[1].l.l).toEqual([111, 5, 333, 444]);
    expect(['fltLfoSpd', 'fltLfoTns', 'fltLfoSkw', 'fltLfoPw'].map((k) => state[k])).toEqual([111, 5, 333, 444]);
    expect(state.arts[1].l.ph).toBe(999);
    expect(state.arts[5].e.a).toEqual([9, 100, 7, 6]);
    expect(state.missing).toEqual(['m0']);
    expect(FI.flCurveFor(st, 'a3k2')).toBe(st.arts[3].k[2]);
    expect(FI.flCurveFor(st, 'nonsense')).toBeNull();
    // file names: FL's folder / preset names
    expect(FI.presetFileMatches('Ogun/Atmospheric/300 Ft Glass Bowl.fst', 'Atmospheric/300 Ft Glass Bowl')).toBe(true);
    expect(FI.presetFileMatches('C:\\FL\\Plugin presets\\Generators\\Ogun\\Default (pad).fst', 'Default (pad)')).toBe(true);
    expect(FI.presetFileMatches('Ogun/Bass/Bass.fst', 'Bass')).toBe(true);
    expect(FI.presetFileMatches('Ogun/Cymbal/Bass.fst', 'Bass/Bass')).toBe(false);
    expect(FI.presetFileMatches('Ogun/Bass/Bass.txt', 'Bass/Bass')).toBe(false);
  });

  // ----------------------------------------- FL's factory presets (when the FL install and the re-saved states are present)

  const FL = '/Applications/FL Studio 2026.app/Contents/Resources/FL/Data/Patches/Plugin presets/Generators/Ogun';
  const REF = `${process.cwd()}/.flref/special/ogun/presets`;
  const haveFl = existsSync(`${FL}/Default.fst`) && existsSync(`${REF}/index.tsv`);
  const refIndex = haveFl ? readFileSync(`${REF}/index.tsv`, 'utf8').trim().split('\n').map((l) => l.split('\t')) : [];
  const refState = (i: string) => FS.parseOgunState(new Uint8Array(readFileSync(`${REF}/${i}.state`)), true);
  const flFile = (name: string) => new Uint8Array(readFileSync(`${FL}/${name}.fst`));

  /** First difference between two curves (exact, double for double), null when equal. */
  function diffCurve(a: Env, b: Env): string | null {
    if (a.t !== b.t || JSON.stringify(a.m) !== JSON.stringify(b.m) || JSON.stringify(a.a ?? null) !== JSON.stringify(b.a ?? null) || JSON.stringify(a.l ?? null) !== JSON.stringify(b.l ?? null) || (a.ph ?? 0) !== (b.ph ?? 0)) return 'header';
    if (a.p.length !== b.p.length) return `length ${a.p.length} / ${b.p.length}`;
    for (let i = 0; i < a.p.length; i++) for (let j = 0; j < 7; j++) if (!Object.is(a.p[i][j], b.p[i][j])) return `point ${i} field ${j}`;
    return null;
  }

  it.skipIf(!haveFl)('reads all 229 factory .fst files bit-equal to the states FL\'s own plugin re-saved (every version FL wrote: 0 .. 14 and 18)', () => {
    expect(refIndex.length).toBe(229);
    const bad: string[] = [];
    const versions = new Set<number>();
    for (const [i, name] of refIndex) {
      const got = FS.parseOgunFile(flFile(name));
      if (!got) { bad.push(`${name}: not parsed`); continue; }
      versions.add(got.version);
      const ref = refState(i);
      const diffs: string[] = [];
      if (JSON.stringify(got.ints) !== JSON.stringify(ref.ints)) diffs.push('ints');
      if (JSON.stringify(got.b3) !== JSON.stringify(ref.b3)) diffs.push('b3');
      if (JSON.stringify(got.eq) !== JSON.stringify(ref.eq)) diffs.push('eq');
      if (got.info !== ref.info) diffs.push('info');
      got.arts.forEach((a, k) => {
        const r = ref.arts[k];
        if (![a.mode === r.mode, a.ea === r.ea, a.la === r.la].every(Boolean)) diffs.push(`art ${k} header`);
        for (const [n, x, y] of [['e', a.e, r.e], ['l', a.l, r.l], ...a.k.map((c, j) => [`k${j}`, c, r.k[j]])] as [string, Env, Env][]) { const d = diffCurve(x, y); if (d) diffs.push(`a${k}${n}: ${d}`); }
      });
      got.maps.forEach((m, j) => { const d = diffCurve(m, ref.maps[j]); if (d) diffs.push(`m${j}: ${d}`); });
      if (diffs.length) bad.push(`${name}: ${diffs.slice(0, 3).join(', ')}`);
    }
    expect(bad).toEqual([]);
    expect([...versions].sort((a, b) => a - b)).toEqual([0, 1, 4, 7, 8, 9, 11, 12, 13, 14, 18]);
  }, 240_000);

  it("generates a random preset like FL: the instance's counter + 1, or the typed number - 1, keeping the editor view; no undo detour", async () => {
    const R = await import('../../src/ui/plugins/gen/ogun/random');
    const G = await import('../../src/model/gen/plugins/ogun/random');
    const { slotId, params } = setup();
    expect(R.ogunGenerator()).toBe(G.generateOgun);
    use.setView(slotId, 'View', { target: 3 });
    const start = R.randomSeedOf(params(), slotId);
    expect(R.randomSeedOf(params(), slotId)).toBe(start); // stable for the instance
    R.generateRandom(slotId, params());
    const seed = (start + 1) >>> 0;
    expect(params().view.rn).toBe(seed);
    expect(params().view.target).toBe(3);
    const want = G.generateOgun(seed) as Record<string, any>;
    expect(params().info).toBe(want.info);
    expect(params().xi).toEqual(want.xi);
    expect(params().arts).toEqual(want.arts);
    expect(R.presetNumber(seed)).toBe(seed + 1);
    // the next press is the next number
    R.generateRandom(slotId, params());
    expect(params().view.rn).toBe((seed + 1) >>> 0);
    // typed numbers run from 1 to 4294967296
    const asked = vi.fn();
    g.prompt = (...a: unknown[]) => { asked(...a); return '4294967296'; };
    R.enterRandomNumber(slotId, params());
    expect(params().view.rn).toBe(4294967295);
    expect(params().info).toBe((G.generateOgun(4294967295) as Record<string, any>).info);
    g.prompt = () => '0';
    R.enterRandomNumber(slotId, params());
    expect(params().view.rn).toBe(4294967295); // not a preset number: unchanged
    g.prompt = () => '12';
    R.enterRandomNumber(slotId, params());
    expect(params().view.rn).toBe(11);
    expect(params().info).toBe((G.generateOgun(11) as Record<string, any>).info);
  });

  it.skipIf(!haveFl)('imports the missing curves of every factory preset from its own file: bit-equal to FL\'s, found by the preset name', () => {
    const byName = new Map(refIndex.map(([i, n]) => [n, i]));
    let filledTotal = 0, presetsWithMissing = 0;
    const bad: string[] = [];
    presetNames.forEach((name, idx) => {
      const refI = byName.get(name);
      if (refI === undefined) { bad.push(`${name}: no re-saved state`); return; }
      expect(FI.presetFileMatches(`Ogun/${name}.fst`, name)).toBe(true);
      const state = genPresetState('ogun', genDef('ogun')!.presets![idx]) as Record<string, any>;
      const missing: string[] = state.missing.slice();
      if (!missing.length) return;
      presetsWithMissing++;
      const st = FS.parseOgunFile(flFile(name))!;
      const score = FI.matchScore(state, st);
      if (score < 0.99) bad.push(`${name}: score ${score}`);
      const r = FI.fillMissing(state, st);
      const ref = refState(refI);
      for (const key of r.filled) {
        const want = FI.flCurveFor(ref, key)!;
        const got = FI.stateCurveFor(state, key)!;
        // the curve of the state = FL's (the state's own ADSR / LFO values stay: they are the same numbers)
        const d = diffCurve(got, want);
        if (d) bad.push(`${name} ${key}: ${d}`);
        // the flat knob parameters of the first five articulators follow the curve (the engine and the automation read those)
        const g = /^a(\d+)e$/.test(key) ? +/^a(\d+)/.exec(key)![1] : -1;
        if (g >= 0 && g < 5) ['Att', 'Dec', 'Sus', 'Rel'].forEach((s, j) => { if (state[ART_TARGETS[g][0] + s] !== want.a![j]) bad.push(`${name} ${key}: ${s} ${state[ART_TARGETS[g][0] + s]} != ${want.a![j]}`); });
      }
      filledTotal += r.filled.length;
      // the imported curves are valid for the state: normalisation leaves them as they are
      const norm = normalizeOgun(state) as Record<string, any>;
      for (let m = 0; m < 4; m++) if (norm.maps[m] !== state.maps[m]) bad.push(`${name}: map ${m} is repaired by normalizeOgun`);
      if (r.absent.length) bad.push(`${name}: ${r.absent.join(',')} not in the file`);
      if (state.missing.length) bad.push(`${name}: still missing ${state.missing.join(',')}`);
    });
    expect(bad).toEqual([]);
    expect(presetsWithMissing).toBe(141);
    expect(filledTotal).toBeGreaterThan(141);
  }, 240_000);
});
