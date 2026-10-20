// Slicex editor without a browser: the editor renders (server side) for the default state, a state with
// regions on both decks and every display mode, with FL's controls at the form's coordinates; the panel
// size follows the display mode; the sample window, play heads and envelope displays draw on a stand-in
// canvas without non-finite coordinates; the curve edits keep FL's rules; the deck commands edit the
// plugin state through the store (one undo step each).
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import './util';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
g.document ??= { body: {}, getElementById: () => null };
g.getComputedStyle ??= () => ({ fontFamily: 'sans-serif' });

/** A canvas context that accepts every call (and counts them). */
function fakeCtx() {
  const calls: Record<string, number> = {};
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
      return (...a: unknown[]) => { calls[k] = (calls[k] ?? 0) + 1; for (const x of a) if (typeof x === 'number' && !Number.isFinite(x)) throw new Error(`non-finite argument to ${k}`); return undefined; };
    },
    set(t, k: string, v) { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

/** A drum-loop-like test signal: decaying noise bursts every quarter of a second. */
function loop(sr = 44100, sec = 2): Float32Array[] {
  const n = sr * sec;
  const l = new Float32Array(n), r = new Float32Array(n);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const t = (i % (sr / 4)) / sr;
    const v = ((seed / 0x7fffffff) * 2 - 1) * Math.exp(-t * 30) * 0.8;
    l[i] = v; r[i] = v * 0.9;
  }
  return [l, r];
}

const px = (v: number) => (v === 0 ? '0' : `${v}px`);
const box = (x: number, y: number, w: number, h: number) => `left:${px(x)};top:${px(y)};width:${px(w)};height:${px(h)}`;

describe('Slicex editor', async () => {
  const { def } = await import('../../src/model/gen/plugins/slicex');
  const { defaultRegion } = await import('../../src/model/gen/plugins/slicex/defaults');
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const { addRaw } = await import('../../src/audio/samples');
  const mod = await import('../../src/ui/plugins/gen/slicex');
  const { sxLayout } = mod;
  const { sxSetOption } = await import('../../src/ui/plugins/gen/slicex/model');
  /** The state's option block with FL's display settings changed (display mode, dual deck, keyboard). */
  type Opt = Parameters<typeof sxSetOption>[0];
  const withOpt = (p: Record<string, unknown>, ch: Record<string, number | boolean>): Opt =>
    Object.entries(ch).reduce<Opt>((o, [k, v]) => sxSetOption(o, k as keyof Opt, v), p.opt as Opt);

  const base = () => ({ ...Object.fromEntries(def.params.map((p) => [p.key, p.def])), ...def.state!() }) as Record<string, unknown>;
  const render = (params: Record<string, unknown>) => renderToStaticMarkup(
    createElement(FxEditorContext.Provider, { value: { slotId: 'ch:test', plugin: 'slicex', params, trackName: 'Slicex', pluginName: 'Slicex' } }, createElement(mod.editor.Editor)),
  );
  addRaw({ id: 'sx-test-a', name: 'loop', channels: loop(), sampleRate: 44100 });
  addRaw({ id: 'sx-test-b', name: 'loop b', channels: [loop(44100, 1)[0]], sampleRate: 44100 });
  const withRegions = () => {
    const p = base();
    p.sampleA = 'sx-test-a';
    p.sampleB = 'sx-test-b';
    p.deckA = { title: 'Breakbeat', file: 'breakbeat.wav', tempo: 120, beats: 4, regions: [0, 11025, 22050, 33075, 44100, 55125, 66150, 77175].map((s, i) => ({ ...defaultRegion(s, -1), name: i % 2 ? 'Snare' : 'Kick' })) };
    p.deckB = { title: 'Hats', file: 'hats.wav', tempo: 0, beats: 0, regions: [{ ...defaultRegion(0, 20000), note: 72 }, defaultRegion(22050, -1)] };
    p.vRegion = 2;
    p.vSel = [11025, 22049];
    return p;
  };

  it('renders the default state at FL\'s form coordinates (714 x 625)', () => {
    const html = render(base());
    expect(sxLayout(base()).h).toBe(625);
    // master panel: sliders, X / Y pad and wheels, layering, crossfade, display modes
    for (const b of [box(22, 5, 20, 75), box(46, 5, 20, 75), box(71, 5, 20, 75), box(95, 5, 20, 75), box(132, 9, 77, 77), box(215, 33, 24, 24), box(215, 62, 24, 24),
      box(343, 67, 20, 20), box(424, 9, 132, 19), box(345, 35, 83, 15), box(477, 35, 80, 16), box(480, 71, 83, 15), box(589, 12, 118, 45), box(574, 61, 25, 30),
      box(604, 61, 108, 30)]) expect(html).toContain(b);
    for (const t of ['MODULATION', 'LAYERING', 'CROSSFADE', 'SMOOTH', 'SAME DECK', 'AUTO-DUMP', 'All']) expect(html).toContain(t);
    // articulation panel (ArtPanel at 0,99): an empty deck shows the load mask; articulator, filter, targets, parts, envelope editor
    expect(html).toContain(box(0, 99, 714, 197));
    expect(html).toContain('Click to load a sample');
    for (const b of [box(175, 32, 136, 24), box(244, 84, 84, 18), box(244, 103, 84, 18), box(191, 143, 36, 36), box(231, 133, 46, 46), box(281, 143, 36, 36),
      box(338, 8, 367, 15), box(338, 24, 367, 15), box(338, 40, 367, 153)]) expect(html).toContain(b);
    for (const t of ['ARTICULATOR', 'FILTER', 'LP', 'BP', 'BS', 'HP', 'OFF', 'x1', 'x3', 'PAN', 'VOL', 'SPEED', 'START', 'ENV', 'LFO', 'VEL', 'MOD X', 'MOD Y', 'RAND']) expect(html).toContain(t);
    // FL's default part: VOL's envelope with its strip (ATT / DEC / SUS / REL, TEMPO, GLOBAL); the LFO's strip
    for (const t of ['ATT', 'DEC', 'SUS', 'REL', 'TEMPO', 'GLOBAL']) expect(html).toContain(t);
    for (const t of ['SPD', 'TNS', 'SKEW', 'PW']) expect(render({ ...base(), vPart: 1 })).toContain(t);
    // FL's default dual deck view: deck B's display below deck A's sample window
    expect(html).toContain(box(0, 528, 714, 43));
    // deck panel (0,296) and its buttons, the sample window (362), the keyboard (571)
    expect(html).toContain(box(0, 296, 714, 66));
    for (const b of [box(9, 1, 31, 30), box(38, 1, 31, 30), box(67, 1, 31, 30), box(160, 2, 24, 34), box(368, 2, 24, 34), box(427, 2, 24, 34), box(603, 2, 24, 34),
      box(627, 2, 24, 34), box(683, 2, 24, 34), box(224, 45, 31, 18), box(621, 43, 18, 21), box(693, 43, 18, 21)]) expect(html).toContain(b);
    for (const t of ['SAMPLERATE', 'FORMAT', 'TEMPO', 'DECK', 'TITLE', 'LENGTH / SEL', '(empty)']) expect(html).toContain(t);
    expect(render({ ...base(), opt: withOpt(base(), { dual: false }) })).toContain(box(0, 362, 714, 209));
    expect(html).toContain(box(0, 362, 714, 163));
    expect(html).toContain(box(0, 571, 714, 54));
    expect(html).toContain(box(3, 3, 21, 50));
    expect(html).toContain(box(27, 0, 676, 54));
    for (const t of ['C0', 'C1', 'C2', 'C3', 'F3']) expect(html).toContain(t);
  });

  it('renders a state with regions: the region settings at FL\'s coordinates', () => {
    const p = withRegions();
    const html = render(p);
    expect(html).not.toContain('Click to load a sample</div></div><div');
    for (const t of ['REGION SETTINGS', 'OUT', 'CUT', 'AMP', 'FILTER', 'SPEED', 'START', 'ART', 'Kick', 'Breakbeat', '44100Hz', '120BPM', '11025 to 22049']) expect(html).toContain(t);
    for (const b of [box(13, 11, 18, 19), box(14, 32, 150, 19), box(50, 58, 27, 23), box(121, 58, 27, 23), box(46, 86, 23, 23), box(72, 86, 23, 23), box(121, 86, 19, 23),
      box(143, 86, 23, 23), box(46, 114, 23, 23), box(72, 114, 23, 23), box(72, 142, 23, 23), box(46, 170, 23, 23), box(72, 170, 23, 23), box(143, 170, 23, 23)]) expect(html).toContain(b);
    // every target and part of the envelope editor renders (START's wheels edit the curve itself)
    for (let t = 0; t < 6; t++) for (let part = 0; part < 6; part++) {
      const h = render({ ...p, vTarget: t, vPart: part, vArt: (t + part) % 8 });
      expect(h).toContain(box(338, 40, 367, 153));
      if (part === 0) for (const s of ['ATT', 'DEC', 'SUS', 'REL']) expect(h).toContain(s);
    }
    // dual deck view: the second deck below
    expect(render({ ...p, opt: withOpt(p, { dual: true }) })).toContain(box(0, 528, 714, 43));
    expect(render({ ...p, opt: withOpt(p, { dual: false }) })).not.toContain(box(0, 528, 714, 43));
    // deck B current
    expect(render({ ...p, vDeck: 1, vRegion: 0 })).toContain('Hats');
  });

  it('follows the display mode and the keyboard switch (FL\'s DispModeSelect / KbBtn)', () => {
    const h = (disp: number, kb: number) => mod.editor.size!({ ...base(), opt: withOpt(base(), { dispMode: disp, kbShown: !!kb }) }).h;
    expect([h(0, 1), h(1, 1), h(2, 1), h(3, 1)]).toEqual([625, 350, 428, 153]);
    expect([h(0, 0), h(1, 0), h(2, 0), h(3, 0)]).toEqual([571, 296, 374, 99]);
    for (let disp = 0; disp < 4; disp++) {
      const html = render({ ...withRegions(), opt: withOpt(base(), { dispMode: disp, kbShown: disp % 2 === 1 }) });
      expect(html.includes(box(0, 99, 714, 197))).toBe(disp <= 1);
      expect(html.includes('LENGTH / SEL')).toBe(disp === 0 || disp === 2);
      expect(html).toContain('LAYERING');
    }
  });

  it('draws the sample window, the play heads and the envelope displays', async () => {
    const { drawWave, drawHeads, drawEnv, envPoints } = await import('../../src/ui/plugins/gen/slicex/draw');
    const ch = loop();
    const regions = [{ s: 0, end: 11024, region: false, name: 'Kick' }, { s: 11025, end: 30000, region: true, name: 'Snare' }];
    for (const view of [[0, ch[0].length], [1000, 1200], [5000, 5020]] as [number, number][]) {
      for (const spectrum of [false, true]) {
        const { ctx, calls } = fakeCtx();
        drawWave(ctx, 714, 173, { ch, sr: 44100, view, sel: [100, 20000], regions, cur: 1, showRegions: true, tempo: spectrum ? 0 : 120, spectrum, empty: '' });
        expect((calls.fillRect ?? 0) + (calls.stroke ?? 0)).toBeGreaterThan(4);
      }
    }
    const e = fakeCtx();
    drawWave(e.ctx, 714, 43, { ch: null, sr: 44100, view: [0, 1], sel: null, regions: [], cur: -1, showRegions: true, tempo: 0, spectrum: false, empty: 'Click to load a sample', compact: true });
    expect(e.calls.fillText).toBe(1);
    const hd = fakeCtx();
    drawHeads(hd.ctx, 714, 173, [0, 88200], [[0, 11024]], [500, 30000]);
    expect(hd.calls.fillRect).toBeGreaterThan(2);
    const st = def.state!() as { arts: { t: { env: { p: number[][]; m: number[] }; lfo: { p: number[][]; m: number[] }; maps: { p: number[][] }[] }[] }[] };
    for (const t of st.arts[0].t) {
      for (const [c, map] of [[t.env, false], [t.lfo, false], [t.maps[0], true]] as const) {
        const { ctx, calls } = fakeCtx();
        drawEnv(ctx, 365, 116, {
          pts: envPoints(c.p), v0: 0, v1: map ? 1 : 4, map, enabled: true, tempo: false, decay: 0, loop: -1, sus: c.p.length - 1, selected: new Set([0]),
          handles: true, lfo: map ? null : (x) => Math.sin(x * 6), line: map ? 0.5 : null, marquee: { x0: 1, y0: 1, x1: 20, y1: 20 },
        });
        expect(calls.stroke).toBeGreaterThan(0);
      }
    }
  });
});

describe('Slicex curve edits', async () => {
  const ops = await import('../../src/ui/plugins/gen/slicex/curveOps');
  const env = () => ({ t: 1, p: [[0, 1, 0, 0, 0, 0, 2], [1, 0.5, 0.2, 0, 0, 0, 1], [1, 0, 0, 0, 0, 0, 2]], m: [0, -1, -1, 1, 2], a: [128, 128, 0, 128] });
  const map = () => ({ t: 3, p: [[0, 0.5, 0, 0, 0, 0, 0], [1, 0.5, 0, 0, 0, 0, 2]], m: [0, -1, -1, -1, -1] });

  it('moves points as FL: first point at 0, slide moves the following ones, a mapping keeps its ends', () => {
    const c = env();
    expect(ops.timesOf(ops.movePoint(c, 0, 5, 0.3, false))).toEqual([0, 1, 2]);
    expect(ops.movePoint(c, 0, 5, 0.3, false).p[0][1]).toBeCloseTo(0.3);
    expect(ops.timesOf(ops.movePoint(c, 1, 1.5, 0.5, false))).toEqual([0, 1.5, 2]);
    expect(ops.timesOf(ops.movePoint(c, 1, 3, 0.5, false))).toEqual([0, 2, 2]);
    expect(ops.timesOf(ops.movePoint(c, 1, 1.5, 0.5, true))).toEqual([0, 1.5, 2.5]);
    const m = ops.insertPoint(map(), 0.25, 1);
    expect(m.index).toBe(1);
    expect(ops.timesOf(m.curve)).toEqual([0, 0.25, 1]);
    expect(ops.timesOf(ops.movePoint(m.curve, 2, 0.5, 0.2, true))).toEqual([0, 0.25, 1]);
    expect(ops.timesOf(ops.movePoint(m.curve, 1, 2, 0.2, true))).toEqual([0, 1, 1]);
  });

  it('keeps the section markers on their points when points come and go', () => {
    const c = env();
    const ins = ops.insertPoint(c, 0.5, 0.8);
    expect(ins.index).toBe(1);
    expect(ins.curve.m.slice(2)).toEqual([-1, 2, 3]);
    const del = ops.deletePoints(c, [1]);
    expect(del.p.length).toBe(2);
    expect(del.m.slice(2)).toEqual([-1, -1, 1]);
    expect(ops.timesOf(del)).toEqual([0, 2]);
    expect(ops.deletePoints(c, [0]).p.length).toBe(3);
    expect(ops.toggleMarker(c, 2, 1).m[2]).toBe(1);
    expect(ops.toggleMarker(ops.toggleMarker(c, 2, 1), 2, 1).m[2]).toBe(-1);
    expect(ops.makeAllLoop(c).m.slice(3)).toEqual([0, 2]);
  });

  it('copies, pastes, flips and flags', () => {
    const c = env();
    const clip = ops.copyPoints(c, new Set([1, 2]))!;
    expect(clip.span).toBe(1);
    const r = ops.pastePoints(c, clip, 3, false);
    expect(r.curve.p.length).toBe(5);
    expect(ops.timesOf(r.curve)).toEqual([0, 1, 2, 3, 4]);
    expect(r.added).toEqual([3, 4]);
    expect(ops.flipLevels(c).p.map((q) => q[1])).toEqual([0, 0.5, 1]);
    expect(ops.setEnabled(c, false).m[1]).toBe(0);
    expect(ops.isEnabled(ops.setEnabled(c, true))).toBe(true);
    expect(ops.setFlag(c, 1, true).m[0]).toBe(1);
    expect(ops.setFlag(ops.setFlag(c, 1, true), 2, true).m[0]).toBe(3);
    expect(ops.setTension(c, 1, 2).p[1][2]).toBe(1);
    expect(ops.setPointField(c, 1, 3, 10).p[1][3]).toBe(10);
    expect(ops.allSmooth(c).p.slice(1).every((q) => q[3] === 10)).toBe(true);
  });
});

describe('Slicex deck commands on the store', async () => {
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { addRaw } = await import('../../src/audio/samples');
  const C = await import('../../src/ui/plugins/gen/slicex/commands');
  const { deckEdit, paramsNow, loadPool } = await import('../../src/ui/plugins/gen/slicex/actions');
  const { deckOf, viewOf, sxMoveStart } = await import('../../src/ui/plugins/gen/slicex/model');

  function setup() {
    const id = A.addGenChannel('slicex');
    const slot = 'ch:' + id;
    addRaw({ id: 'sx-cmd', name: 'loop', channels: loop(), sampleRate: 44100 });
    store.update('pool', (d) => { d.samples['sx-cmd'] = { id: 'sx-cmd', name: 'loop', frames: 88200, sampleRate: 44100, channels: 2, source: { kind: 'user', key: 'sx-cmd' } }; });
    return { id, slot };
  }

  it('loads a pool sample into a deck with FL\'s slicing, one undo step, and dumps deck A', () => {
    const { id, slot } = setup();
    loadPool(slot, 0, 'sx-cmd');
    const p = paramsNow(slot);
    const deck = deckOf(p, 0);
    expect(p.sampleA).toBe('sx-cmd');
    expect(deck.title).toBe('loop');
    expect(deck.regions.length).toBeGreaterThan(2);
    expect(store.undoLabel()).toBe('Load sample');
    const notes = store.project.patterns.find((x) => x.id === store.project.currentPatternId)?.notes[id] ?? [];
    expect(notes.length).toBe(deck.regions.length);
  });

  it('edits regions: add / remove marker, region, select, move with re-sorting, cut groups', () => {
    const { slot } = setup();
    loadPool(slot, 0, 'sx-cmd');
    const ui = { ...C.DECK_UI };
    const n0 = deckOf(paramsNow(slot), 0).regions.length;
    C.setSel(slot, [1000, 1000]);
    C.addMarker(slot, ui);
    expect(deckOf(paramsNow(slot), 0).regions.length).toBe(n0 + 1);
    expect(store.undoLabel()).toBe('Add marker');
    expect(viewOf(paramsNow(slot)).region).toBe(deckOf(paramsNow(slot), 0).regions.findIndex((r) => r.s === 1000));
    C.addMarker(slot, ui, true);
    expect(deckOf(paramsNow(slot), 0).regions.length).toBe(n0);
    C.setSel(slot, [2000, 3000]);
    C.addRegion(slot, ui);
    const rg = deckOf(paramsNow(slot), 0).regions.find((r) => r.s === 2000)!;
    expect(rg.e).toBe(3000);
    C.setRegion(slot, 0);
    expect(viewOf(paramsNow(slot)).sel?.[0]).toBe(0);
    C.selectRegionStep(slot, 1);
    expect(viewOf(paramsNow(slot)).region).toBe(1);
    // a marker dragged past its neighbour is re-sorted and stays current
    const before = deckOf(paramsNow(slot), 0);
    expect(before.regions[2].e).toBe(-1);
    const idx = deckEdit(slot, 0, 'Move marker', (dk, _a, frames) => sxMoveStart(dk, 2, before.regions[3].s + 10, frames));
    expect(idx).toBe(3);
    expect(viewOf(paramsNow(slot)).region).toBe(3);
    C.setRegionField(slot, 0, 'Trigger note', 'note', 72);
    expect(deckOf(paramsNow(slot), 0).regions[0].note).toBe(72);
    // frozen regions refuse edits
    const n1 = deckOf(paramsNow(slot), 0).regions.length;
    C.addMarker(slot, { ...ui, lockRegions: true });
    expect(deckOf(paramsNow(slot), 0).regions.length).toBe(n1);
    store.undo();
    expect(deckOf(paramsNow(slot), 0).regions[0].note).not.toBe(72);
  });

  it('zooms and selects in frames (view state, no undo)', () => {
    const { slot } = setup();
    loadPool(slot, 0, 'sx-cmd');
    const label = store.undoLabel();
    C.zoomBy(slot, 0.5);
    expect(viewOf(paramsNow(slot)).zoom).toEqual([22050, 66150]);
    C.selectZoomed(slot);
    expect(viewOf(paramsNow(slot)).sel).toEqual([22050, 66149]);
    C.zoomFull(slot);
    expect(viewOf(paramsNow(slot)).zoom).toBeNull();
    C.setDeck(slot, 1);
    expect(viewOf(paramsNow(slot)).deck).toBe(1);
    expect(store.undoLabel()).toBe(label);
  });
});

describe('Slicex menus', async () => {
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { addRaw } = await import('../../src/audio/samples');
  const M = await import('../../src/ui/plugins/gen/slicex/menus');
  const C = await import('../../src/ui/plugins/gen/slicex/commands');
  const { loadPool, paramsNow } = await import('../../src/ui/plugins/gen/slicex/actions');
  const { deckOf, optOf } = await import('../../src/ui/plugins/gen/slicex/model');
  const { PropsDialog } = await import('../../src/ui/plugins/gen/slicex/dialogs');
  type Item = { label?: string; submenu?: Item[]; onClick?: () => void; disabled?: boolean };
  const labels = (items: Item[]): string[] => items.flatMap((i) => [i.label ?? '', ...(i.submenu ? labels(i.submenu) : [])]);
  const find = (items: Item[], label: string): Item | undefined => {
    for (const i of items) { if (i.label === label) return i; const s = i.submenu && find(i.submenu, label); if (s) return s; }
    return undefined;
  };

  function setup() {
    const id = A.addGenChannel('slicex');
    const slot = 'ch:' + id;
    addRaw({ id: 'sx-menu', name: 'loop', channels: loop(), sampleRate: 44100 });
    store.update('pool', (d) => { d.samples['sx-menu'] = { id: 'sx-menu', name: 'loop', frames: 88200, sampleRate: 44100, channels: 2, source: { kind: 'user', key: 'sx-menu' } }; });
    return slot;
  }

  it('lists FL\'s items for an empty and a loaded deck', () => {
    const slot = setup();
    const ctx = { slotId: slot, ui: { ...C.DECK_UI }, setUi: () => {} };
    const empty = labels(M.wavOptionsMenu(ctx) as Item[]);
    expect(empty).toContain('Load sample...');
    expect((find(M.regionsMenu(ctx) as Item[], 'Add marker...') as Item).disabled).toBe(true);
    loadPool(slot, 0, 'sx-menu');
    const all = labels(M.wavOptionsMenu(ctx) as Item[]);
    for (const l of ['New', 'Save sample as...', 'Edit properties...', '32Bit float', 'Stereo', 'Clear', 'Delete', 'Trim', 'Insert silence', 'Normalize', 'Fade in',
      'Reverse', 'Normalize all regions', 'Perfect all regions', 'Add region...', 'Add marker...', 'Rename all...', 'Assign all to', 'padKontrol pads',
      'Set all cut groups to...', 'Medium auto-slicing', 'Large grid-slicing', 'Zero-cross check all regions', 'Freeze all', 'Spectrum', 'Regions',
      'Snap to zero-crossing', 'Select next region', 'Zoom on selection']) expect(all).toContain(l);
    const rm = labels(M.regionMenu(ctx, 1, 62) as Item[]);
    for (const l of ['Delete', 'Clone as region', 'Turn into region', 'Rename...', 'Quick rename', 'Set info...', 'Purpose', 'Downbeat', 'Trigger note', 'Last hit (D5)', 'Select', 'Zoom on']) expect(rm).toContain(l);
    expect(labels(M.dumpMenu(ctx) as Item[])).toContain('Stutter (half)');
    const om = labels(M.optionsMenu(slot) as Item[]);
    for (const l of ['Assign both decks to whole keyboard', 'Layer homonymous regions', 'Assign deck B regions to articulator 2', 'Sample start covers whole length',
      'Link velocity to volume', 'Loop half of regions', 'HQ envelopes', 'Lock audio data', 'Leave unedited audio data on disk']) expect(om).toContain(l);
  });

  it('runs menu actions: assign all to C5, purpose, options, macro', () => {
    const slot = setup();
    loadPool(slot, 0, 'sx-menu');
    const ctx = { slotId: slot, ui: { ...C.DECK_UI }, setUi: () => {} };
    find(M.regionsMenu(ctx) as Item[], 'C5')!.onClick!();
    expect(deckOf(paramsNow(slot), 0).regions.every((r) => r.note === 60)).toBe(true);
    find(M.regionMenu(ctx, 0, -1) as Item[], 'Downbeat')!.onClick!();
    expect(deckOf(paramsNow(slot), 0).regions[0].pur).toBe(3);
    const vel = optOf(paramsNow(slot)).velVol;
    find(M.optionsMenu(slot) as Item[], 'Link velocity to volume')!.onClick!();
    expect(optOf(paramsNow(slot)).velVol).toBe(!vel);
    expect(store.undoLabel()).toBe('Link velocity to volume');
    find(M.optionsMenu(slot) as Item[], 'Assign deck A regions to articulator 1')!.onClick!();
    expect(deckOf(paramsNow(slot), 0).regions.every((r) => r.aArt === 0 && r.fArt === 0)).toBe(true);
  });

  it('renders the sample properties dialog', () => {
    const slot = setup();
    loadPool(slot, 0, 'sx-menu');
    const html = renderToStaticMarkup(createElement(PropsDialog, { slotId: slot, onClose: () => {} }));
    for (const t of ['Sample properties', 'Title', 'BPM', 'Length (beats)', 'Quick guess', 'Accept', '44100 Hz, stereo']) expect(html).toContain(t);
  });
});
