// Harmor editor: FL's form bindings (every control with a parameter Tag binds
// a real parameter of the displayed part; Tag -1 / negative controls edit
// settings that exist in the state), the editor rendered in a test store for
// every page and both parts (part switching rebinds the controls), FL's combo
// Value semantics (separators skipped), the editor target / articulator part
// lists, curve edits yielding valid HEnv curves that normalisation keeps, the
// chorus / reverb presets and the panel size.
import { describe, it, expect, vi } from 'vitest';
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

describe('Harmor editor', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const { editor } = await import('../../src/ui/plugins/gen/harmor');
  const { FORM } = await import('../../src/ui/plugins/gen/harmor/form');
  const bind = await import('../../src/ui/plugins/gen/harmor/bind');
  const curve = await import('../../src/ui/plugins/gen/harmor/curve');
  const { PART_PAGE_CONTROLS } = await import('../../src/ui/plugins/gen/harmor/PartPage');
  const { GLOBAL_CONTROLS } = await import('../../src/ui/plugins/gen/harmor/Global');
  const { IMG_CONTROLS, FX_CONTROLS, ADV_CONTROLS } = await import('../../src/ui/plugins/gen/harmor/Pages');
  const { writeCurve } = await import('../../src/ui/plugins/gen/harmor/EnvPage');
  const { chorusMenu, reverbMenu, CHORUS_PRESETS } = await import('../../src/ui/plugins/gen/harmor/menus');
  const { comboMenu } = await import('../../src/ui/plugins/gen/harmor/widgets');
  const { HARMOR_PARAMS } = await import('../../src/model/gen/plugins/harmor/params');
  const { BASE, normalizeHarmor } = await import('../../src/model/gen/plugins/harmor/state');
  const { LABELS } = await import('../../src/ui/plugins/gen/harmor/labels');
  type HEnv = import('../../src/model/gen/plugins/harmor/types').HEnv;
  type HPart = import('../../src/model/gen/plugins/harmor/types').HPart;

  const PARAM = new Map(HARMOR_PARAMS.map((p) => [p.key, p]));

  /** A Harmor channel in the test store. */
  function setup() {
    const id = A.addGenChannel('harmor');
    const slotId = 'ch:' + id;
    const params = () => store.project.channels.find((c) => c.id === id)!.plugin!.params as Record<string, unknown>;
    const render = () => {
      rec.keys.clear();
      const ctx = { slotId, plugin: 'harmor', params: params(), trackName: 'Harmor', pluginName: 'Harmor' };
      return renderToStaticMarkup(React.createElement(FxEditorContext.Provider, { value: ctx }, React.createElement(editor.Editor)));
    };
    const view = (patch: Record<string, number>) => A.setFxStateNoHistory(slotId, 'view', (d) => { Object.assign(d.hView as object, patch); });
    return { id, slotId, params, render, view };
  }

  it('binds every FL control with a parameter Tag to a real parameter of the displayed part', () => {
    const bound = [...PART_PAGE_CONTROLS, ...GLOBAL_CONTROLS, ...IMG_CONTROLS, ...FX_CONTROLS, ...ADV_CONTROLS];
    let params = 0;
    for (const n of bound) {
      const c = FORM[n];
      expect(c, n).toBeTruthy();
      if (bind.SETTINGS[n] || bind.RES_TYPE[n]) continue;
      for (const p of ['a', 'b'] as const) {
        const key = bind.tagKey(c.tag, p);
        expect(key, `${n} (Tag ${c.tag})`).not.toBeNull();
        const def = PARAM.get(key!);
        expect(def, `${n} -> ${key}`).toBeTruthy();
        // FL's form range is the parameter range, except the harmonizer gap offset (Tag 32): FL's wheel stops
        // at 8, but FL's state load and DSP accept 9 (two factory presets store 9), so the parameter goes to 9
        if (c.max !== undefined && c.k !== 'combo' && c.k !== 'switch' && c.k !== 'check' && c.k !== 'button') {
          expect([def!.min, def!.max], n).toEqual([c.min ?? 0, c.tag === 32 ? c.max + 1 : c.max]);
        }
        if (p === 'b' && (c.tag ?? 0) < 10000) expect(key!.startsWith('b_'), n).toBe(true);
      }
      params++;
    }
    expect(params).toBeGreaterThan(130);
    // FL's Tag blocks: 10000 + i = parameter 772 + i, 20000 + i = 789 + i, part B = part A + 386
    expect(bind.tagKey(10000, 'a')).toBe('modX');
    expect(bind.tagKey(10016, 'a')).toBe('invArp');
    expect(bind.tagKey(20000, 'a')).toBe('distAmt');
    expect(bind.tagKey(20035, 'a')).toBe('compHigh');
    expect(PARAM.get(bind.tagKey(52, 'b')!)!.index).toBe(PARAM.get(bind.tagKey(52, 'a')!)!.index! + 386);
    // the envelope / LFO wheels (Tags 0..7) bind the target's articulator fields
    expect(bind.envWheelKey('a', 1, FORM.EnvAttWheel.tag!)).toBe('a_art1_att');
    expect(bind.envWheelKey('b', 4, FORM.LFOPWWheel.tag!)).toBe('b_art4_lfoPw');
    expect(bind.envWheelKey('a', 31, 0)).toBeNull();
  });

  it('edits settings that exist in the state for the Tag -1 / negative controls', () => {
    for (const [n, s] of Object.entries(bind.SETTINGS)) {
      expect(FORM[n], n).toBeTruthy();
      const src = (s.scope === 'part' ? BASE.A : BASE.G) as unknown as Record<string, unknown>;
      expect(typeof src[s.field], `${n} -> ${s.scope}.${s.field}`).toBe('number');
      const v = (src[s.field] as number) / (s.scale ?? 1);
      expect(v, n).toBeGreaterThanOrEqual(s.min);
      expect(v, n).toBeLessThanOrEqual(s.max);
    }
  });

  it('renders every page of both parts, rebinding the part controls', () => {
    const t = setup();
    for (const part of [0, 1]) {
      for (const page of [0, 1, 2, 3]) {
        t.view({ part, page });
        const html = t.render();
        expect(html.length).toBeGreaterThan(1000);
        const keys = [...rec.keys].filter((k) => !k.startsWith('__'));
        for (const k of keys) expect(PARAM.has(k), `bound key ${k}`).toBe(true);
        const own = part ? 'b_' : 'a_', other = part ? 'a_' : 'b_';
        expect(keys.some((k) => k.startsWith(own))).toBe(true);
        expect(keys.filter((k) => k.startsWith(other)), `page ${page} part ${part}`).toEqual([]);
        expect(keys).toContain(`${own}f1Freq`);
        expect(keys).toContain('preVol');
        if (page === 0) {
          // the default target (Volume) shows its envelope knobs and smoothing
          expect(keys).toContain(`${own}art1_att`);
          expect(keys).toContain(`${own}art1_smooth`);
        }
        if (page === 2) expect(keys).toContain('revWet');
        if (page === 3) expect(keys).toContain(`${own}predelay`);
      }
    }
    // the LFO page binds the LFO fields of the target
    t.view({ part: 0, page: 0, target: 4, artPart: 1 });
    t.render();
    expect([...rec.keys]).toContain('a_art4_lfoSpd');
    expect([...rec.keys]).toContain('a_art4_lfoPw');
  });

  it('uses FL combo Values: selectable items only (separators and headers skipped)', () => {
    const f = FORM.F1TypeSelect.items!;
    expect(bind.itemText(f, 0)).toBe('Classic low pass');
    expect(bind.itemText(f, 4)).toBe('Crude low pass');
    expect(bind.itemText(f, 18)).toBe('Custom shape 2');
    const r = FORM.F1ResTypeSelect.items!;
    expect(bind.itemText(r, 108 - 100)).toBe('Lowpass');
    expect(bind.itemText(r, 111 - 100)).toBe('Custom shape 2');
    expect(bind.itemText(FORM.PhaserTypeSelect.items!, 9)).toBe('Freq');
    expect(bind.itemText(FORM.DistModeSelect.items!, 1)).toBe('Classic');
    expect(bind.itemText(FORM.FatTypeSelect.items!, 4)).toBe('Hz');
    expect(bind.itemText(FORM.HarmBlendSelect.items!, 5)).toBe('Pluck');
    const menu = comboMenu(FORM.CompTypeSelect.items!, 2, () => undefined);
    expect(menu.map((m) => (m.separator ? '-' : m.label))).toEqual(['Off', '-', 'Limiting', 'Warming', 'Heating', 'Burning']);
    expect(menu.find((m) => m.checked)!.label).toBe('Warming');
    expect(menu.find((m) => m.label === 'Special' || m.header)).toBeUndefined();
    const blend = comboMenu(FORM.HarmBlendSelect.items!, 5, () => undefined);
    expect(blend.find((m) => m.header)!.label).toBe('Special');
    expect(blend.find((m) => m.checked)!.label).toBe('Pluck');
  });

  it('maps editor targets and articulator parts to curves', () => {
    expect(bind.TARGETS.length).toBe(70);
    expect(bind.targetName(1)).toBe('Volume');
    expect(bind.targetName(43)).toBe('Local EQ');
    expect(bind.targetName(69)).toBe('Image selected column');
    expect(bind.curvePath(1, 0)).toEqual(['arts', 1, 'e']);
    expect(bind.curvePath(4, 1)).toEqual(['arts', 4, 'l']);
    expect(bind.curvePath(4, 2)).toEqual(['arts', 4, 'k', 0]);
    expect(bind.curvePath(31, 0)).toEqual(['arts', 31, 'k', 0]);
    expect(bind.curvePath(45, 0)).toEqual(['maps', 2]);
    expect(bind.curvePath(69, 0)).toBeNull();
    expect(bind.envSelectItems(1).filter((s) => !bind.isSeparator(s))).toHaveLength(11);
    expect(bind.envSelectItems(35)).toHaveLength(9);
    expect(bind.envSelectItems(50)).toEqual(['Mapping']);
    for (const t of [1, 31, 50]) for (let ap = 0; ap <= 10; ap++) {
      const c = bind.clampArtPart(t, ap);
      expect(bind.valueToArtPart(t, bind.artPartToValue(t, c))).toBe(c);
    }
    expect(bind.curveAt(BASE.A, ['arts', 1, 'e'])!.p).toHaveLength(4);
  });

  it('edits curves into valid HEnv that normalisation keeps', () => {
    const env: HEnv = structuredClone(BASE.A.arts[1].e);
    let e = curve.addPoint(env, 2.0, 0.8, 'env').e;
    expect(curve.validCurve(e)).toBe(true);
    expect(e.p).toHaveLength(5);
    // markers after the new point shift with it
    expect(e.m[curve.M_SUSTAIN]).toBe(env.m[curve.M_SUSTAIN] + 1);
    e = curve.movePoint(e, 1, 0.9, 0.95, { kind: 'env', slide: true });
    expect(curve.points(e)[1].x).toBeCloseTo(0.9, 9);
    expect(curve.points(e)[1].y).toBeCloseTo(0.95, 9);
    e = curve.setTension(e, 2, -0.5);
    e = curve.setSeg(e, 2, 9);
    e = curve.toggleMarker(e, curve.M_LOOP, 1);
    e = curve.deletePoint(e, 3, 'env');
    e = curve.setEnabled(e, true);
    e = curve.setFlag(e, curve.F_TEMPO, true);
    expect(curve.validCurve(e)).toBe(true);
    expect(e.m[curve.M_ENABLED]).toBe(-1);
    expect(curve.hasFlag(e, curve.F_TEMPO)).toBe(true);
    // mappings keep x 0..1 (their deltas sum to 1)
    let m = structuredClone(BASE.A.maps[0]);
    m = curve.addPoint(m, 0.3, 0.9, 'map').e;
    m = curve.addPoint(m, 0.7, 0.1, 'map').e;
    m = curve.movePoint(m, 1, 0.5, 0.5, { kind: 'map' });
    m = curve.movePoint(m, 3, 0.2, 1, { kind: 'map' });
    expect(curve.length(m)).toBeCloseTo(1, 9);
    expect(curve.deletePoint(m, m.p.length - 1, 'map').p).toHaveLength(m.p.length);
    // written through the editor, normalisation keeps the curves as they are
    const t = setup();
    writeCurve(t.slotId, 0, ['arts', 1, 'e'], e, 'move point');
    writeCurve(t.slotId, 1, ['maps', 0], m, 'move point');
    const p = t.params();
    expect((p.hA as HPart).arts[1].e).toEqual(e);
    expect((p.hB as HPart).maps[0]).toEqual(m);
    const n = normalizeHarmor(structuredClone(p));
    expect((n.hA as HPart).arts[1].e).toEqual(e);
    expect((n.hB as HPart).maps[0]).toEqual(m);
    // one undo step per edit
    A.undo();
    expect((t.params().hB as HPart).maps[0]).toEqual(BASE.B.maps[0]);
  });

  it('applies FL\'s chorus and reverb presets', () => {
    const t = setup();
    chorusMenu(t.slotId).find((m) => m.label === 'Thick')!.onClick!();
    const p = t.params();
    expect(['chOrder', 'chDepth', 'chSpeed', 'chDelay', 'chSpread', 'chCross', 'chMix'].map((k) => p[k])).toEqual(CHORUS_PRESETS[1]);
    reverbMenu(t.slotId).find((m) => m.label === 'Cathedral')!.onClick!();
    const q = t.params();
    expect([q.revOn, q.revRoom, q.revDecay, q.revColor]).toEqual([1, 90, 550, 3]);
    reverbMenu(t.slotId).find((m) => m.label === 'Off')!.onClick!();
    expect(t.params().revOn).toBe(0);
  });

  it('sizes the panel like FL: 1024 x 680, 612 high without the keyboard, wider with visual feedback', () => {
    const t = setup();
    expect(editor.size!(t.params())).toEqual({ w: 1024, h: 680 });
    t.view({ kb: 0 });
    expect(editor.size!(t.params())).toEqual({ w: 1024, h: 612 });
    t.view({ kb: 1, vis: 1 });
    expect(editor.size!(t.params()).w).toBeGreaterThan(1024);
    expect(editor.menu!(t.slotId).some((m) => m.label === 'Show keyboard')).toBe(true);
  });

  it('carries FL\'s painted captions with their anchors', () => {
    const texts = LABELS.map((l) => l[0]);
    for (const s of ['Timbre', 'PHASE', 'BLUR', 'TREM', 'Prism', 'Harmonizer', 'Unison', 'PITCH', 'Pluck', 'Phaser', 'EQ', 'Global', 'Strum', 'Distortion', 'Chorus', 'Delay', 'Reverb', 'Compression']) {
      expect(texts, s).toContain(s);
    }
    for (const l of LABELS) {
      expect(l[3]).toBeGreaterThan(0);
      expect(l[4]).toBeGreaterThan(0);
    }
  });
});
