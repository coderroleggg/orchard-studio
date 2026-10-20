// BeepMap editor: every form control of FL (Tag 0..6 and the Max bitmap height) is
// bound, the panel renders for the default state and every preset, the window
// menu offers the bitmap actions, and "Import FL content..." / dropped files load
// bitmaps into the instrument's state (an original synthetic BMP and .fst here:
// FL's own files are never part of the repository).
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

/** A 24-bit bottom-up BMP of w x h pixels, pixel (x, y) = `at(x, y)` as 0xRRGGBB. */
function bmp24(w: number, h: number, at: (x: number, y: number) => number): Uint8Array {
  const stride = Math.floor((w * 24 + 31) / 32) * 4;
  const out = new Uint8Array(54 + stride * h);
  const dv = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  dv.setUint32(2, out.length, true); dv.setUint32(10, 54, true); dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true); dv.setInt32(22, h, true); dv.setUint16(26, 1, true); dv.setUint16(28, 24, true);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = at(x, y), o = 54 + (h - 1 - y) * stride + 3 * x;
      out[o] = v & 255; out[o + 1] = (v >>> 8) & 255; out[o + 2] = (v >>> 16) & 255;
    }
  }
  return out;
}

/** A version-0 BeepMap .fst holding `bmp` with Max bitmap height `maxH`. */
function fstWith(bmp: Uint8Array, maxH: number): Uint8Array {
  const ints = [0, 7200, 2048, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, maxH];
  const blob = new Uint8Array(ints.length * 4 + 4 + bmp.length);
  const dv = new DataView(blob.buffer);
  ints.forEach((v, i) => dv.setInt32(4 * i, v, true));
  dv.setInt32(ints.length * 4, bmp.length, true);
  blob.set(bmp, ints.length * 4 + 4);
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

/** A File of bytes (TypeScript's typed arrays are not BlobParts without the cast). */
const file = (b: Uint8Array, name: string) => new File([b as BlobPart], name);

describe('BeepMap editor', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { FxEditorContext } = await import('../../src/ui/plugins/kit');
  const { editor } = await import('../../src/ui/plugins/gen/beepmap');
  const load = await import('../../src/ui/plugins/gen/beepmap/load');
  const { decodeBitmap, bitmapOf, standinBitmap } = await import('../../src/model/gen/plugins/beepmap/image');
  const { genDef } = await import('../../src/model/gen/registry');

  function setup() {
    const id = A.addGenChannel('beepmap');
    const slotId = 'ch:' + id;
    const params = () => store.project.channels.find((c) => c.id === id)!.plugin!.params as Record<string, unknown>;
    const render = () => {
      rec.keys.clear();
      const ctx = { slotId, plugin: 'beepmap', params: params(), trackName: 'BeepMap', pluginName: 'BeepMap' };
      return renderToStaticMarkup(React.createElement(FxEditorContext.Provider, { value: ctx }, React.createElement(editor.Editor)));
    };
    return { id, slotId, params, render };
  }

  it("binds FL's controls (Tag 0..6) and places them at FL's form coordinates", () => {
    const { render } = setup();
    const html = render();
    expect(html.length).toBeGreaterThan(1000);
    for (const k of ['freq', 'length', 'scale', 'blue', 'grainy', 'loop', 'widen']) expect(rec.keys.has(k), k).toBe(true);
    // FREQ (7,15) and LENGTH (59,15) 40 x 40, the scale combo (117,22) 98 x 28, Open (6,85) 50 x 31, the bitmap panel (6,124) 368 x 40, Max height (336,89) 37 x 25
    for (const s of ['left:7px;top:15px;width:40px;height:40px', 'left:59px;top:15px;width:40px;height:40px', 'left:117px;top:22px;width:98px;height:28px',
      'left:6px;top:85px;width:50px;height:31px', 'left:6px;top:124px;width:368px;height:40px', 'left:336px;top:89px;width:37px;height:25px',
      'left:228px;top:23px', 'left:301px;top:23px', 'left:228px;top:41px', 'left:301px;top:41px']) expect(html).toContain(s);
    for (const s of ['Use Blue', 'Grainy', 'Loop', 'Widen', 'FREQ', 'LENGTH', 'SCALE', 'Open', 'Copy', 'Paste', 'Log', 'BEEP · MAP', '>23<']) expect(html).toContain(s);
  });

  it('renders every factory preset and offers the bitmap actions in the plugin menu', () => {
    const { slotId, render } = setup();
    for (const p of genDef('beepmap')!.presets!) {
      A.editFx(slotId, 'preset', (q) => { Object.assign(q, p.params); });
      expect(render().length).toBeGreaterThan(1000);
    }
    const labels = editor.menu!(slotId).map((m) => m.label);
    expect(labels).toEqual(expect.arrayContaining(['Open bitmap...', 'Copy bitmap', 'Paste bitmap', 'Stand-in bitmap', 'Import FL content (files)...', 'Import FL content (folder)...']));
    expect(editor.size).toBeUndefined();
    expect(genDef('beepmap')!.width).toBe(380);
  });

  it("loads a picture into the state in one undo step, fitted to the Max bitmap height (FL's rules)", () => {
    const { slotId, params } = setup();
    expect(load.hasBitmap(slotId)).toBe(false);
    expect(load.currentBitmap(slotId)).toBe(standinBitmap());
    const b = { w: 4, h: 50, px: new Uint32Array(200).fill(0x336699) };
    expect(load.loadBitmap(slotId, b, 'Load bitmap')).toMatchObject({ w: 4, h: 23 });
    expect(load.hasBitmap(slotId)).toBe(true);
    expect(decodeBitmap(params().bmp)).toMatchObject({ w: 4, h: 23 });
    expect(store.historyLabels().past.at(-1)).toBe('Load bitmap');
    // fewer than 3 rows: refused, the bitmap stays
    expect(load.loadBitmap(slotId, { w: 5, h: 2, px: new Uint32Array(10) }, 'Load bitmap')).toBeNull();
    expect(decodeBitmap(params().bmp)).toMatchObject({ w: 4, h: 23 });
    // a taller Max bitmap height keeps more rows
    A.editFx(slotId, 'Max bitmap height', (p) => { p.maxH = 64; });
    load.loadBitmap(slotId, b, 'Load bitmap');
    expect(decodeBitmap(params().bmp)).toMatchObject({ w: 4, h: 50 });
    store.undo();
    expect(decodeBitmap(params().bmp)).toMatchObject({ w: 4, h: 23 });
    load.resetBitmap(slotId);
    expect(params().bmp).toBe('');
    expect(bitmapOf(params().bmp)).toBe(standinBitmap());
  });

  it("imports FL's own bitmap: the preset file named like the current preset, its saved bitmap as it is", async () => {
    const { slotId, params } = setup();
    // FL's factory bitmap of a preset is within its Max bitmap height (here 5 rows, height 8): taken as it is
    const img = bmp24(6, 5, (x, y) => (x * 40 << 16) | (y * 50 << 8) | 7);
    A.editFx(slotId, 'preset', (p) => { p.__preset = 'Ambiance'; p.maxH = 23; });
    const files = [
      file(fstWith(bmp24(2, 3, () => 0x111111), 9), 'Other.fst'),
      file(fstWith(img, 8), 'Ambiance.fst'),
      file(bmp24(7, 9, () => 0xabcdef), 'Ambiance.bmp'),
      new File([new Uint8Array([1, 2, 3])], 'notes.txt'),
    ];
    const msg = await load.importFlContent(slotId, files);
    expect(msg).toContain('imported 6 x 5');
    const b = decodeBitmap(params().bmp)!;
    expect([b.w, b.h, b.px[0], b.px[6 * 4 + 5]]).toEqual([6, 5, 0x000007, (5 * 40 << 16 & 0xff0000) | (4 * 50 << 8) | 7]);
    expect(params().maxH).toBe(8);
    // a saved bitmap taller than its own Max bitmap height is resampled on loading, as FL does
    expect(await load.importFlContent(slotId, [file(fstWith(img, 3), 'Ambiance.fst')])).toContain('imported 6 x 3');
    expect(decodeBitmap(params().bmp)).toMatchObject({ w: 6, h: 3 });
    expect(params().maxH).toBe(3);
    // without the preset file the image named like the preset is read and resampled to the height
    A.editFx(slotId, 'preset', (p) => { p.maxH = 4; p.bmp = ''; });
    const m2 = await load.importFlContent(slotId, files.filter((f) => f.name !== 'Ambiance.fst'));
    expect(m2).toContain('Ambiance.bmp');
    expect(decodeBitmap(params().bmp)).toMatchObject({ w: 7, h: 4 });
    // nothing matches: a message, the state is kept
    A.editFx(slotId, 'preset', (p) => { p.__preset = 'Nope'; });
    const before = params().bmp;
    expect(await load.importFlContent(slotId, [files[0], files[2]])).toContain('Nope');
    expect(params().bmp).toBe(before);
    expect(await load.importFlContent(slotId, [files[3]])).toContain('no FL preset');
    // a single picked file is taken whatever its name
    expect(await load.importFlContent(slotId, [files[0]])).toContain('imported');
    expect(decodeBitmap(params().bmp)).toMatchObject({ w: 2, h: 3 });
  });

  it("imports for a new instance what FL inserts: the plugin database's BeepMap.fst, then Default", async () => {
    const { slotId, params } = setup();
    expect(params().__preset).toBeUndefined();
    const files = [file(fstWith(bmp24(3, 3, () => 0x222222), 9), 'Default.fst'), file(fstWith(bmp24(4, 5, () => 0x333333), 7), 'BeepMap.fst'), file(bmp24(6, 6, () => 0x444444), 'Default.bmp')];
    expect(await load.importFlContent(slotId, files)).toContain('4 x 5 from beepmap');
    expect(decodeBitmap(params().bmp)).toMatchObject({ w: 4, h: 5 });
    expect(params().maxH).toBe(7);
    A.editFx(slotId, 'reset', (p) => { p.bmp = ''; });
    expect(await load.importFlContent(slotId, files.slice(0, 1).concat(files.slice(2)))).toContain('3 x 3 from default');
    expect(await load.importFlContent(slotId, files.slice(2).concat(files.slice(2)))).toContain('Default.bmp');
  });

  it('loads a dropped BMP and ignores dropped files that are no pictures', async () => {
    const { slotId, params } = setup();
    await load.dropFiles(slotId, [file(new Uint8Array(10), 'x.wav')]);
    expect(params().bmp).toBe('');
    await load.dropFiles(slotId, [file(bmp24(5, 40, (x, y) => (x << 16) | y), 'pic.bmp')]);
    expect(decodeBitmap(params().bmp)).toMatchObject({ w: 5, h: 23 });
    const dec = await load.decodeImage(file(bmp24(3, 3, () => 0x010203), 'p.bmp'));
    expect(dec).toMatchObject({ w: 3, h: 3 });
    expect(await load.decodeImage(file(new Uint8Array(0), 'e.bmp'))).toBeNull();
  });
});
