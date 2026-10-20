// Harmor "Import FL content...": the defensive parser of FL's Harmor states
// (versions 11, 12, 16, 17 and 0x130003) against synthetic states (old
// version conversions, truncated / hostile input), the fill of the dense
// curves into a state (HPart.missing), the image plane sample encoding, and,
// when the user's FL installation and the FL re-saves (.flref/harmor/states,
// FL's own saves of every factory preset, decoded by hstate.py) are present:
// every factory .fst parses to what FL itself loads, the model form equals
// the factory bank's curves, and the import fills every missing curve and
// image from the user's files in a test store.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as I from '../../src/model/gen/plugins/harmor/import';
import { BASE, H_PRESET_NAMES, expandDiff, harmorBank, normalizeHarmor } from '../../src/model/gen/plugins/harmor/state';
import { HARMOR_KEYS } from '../../src/model/gen/plugins/harmor/params';
import type { HEnv, HPart } from '../../src/model/gen/plugins/harmor/types';

const FL_DIR = '/Applications/FL Studio 2026.app/Contents/Resources/FL/Data/Patches/Plugin presets/Generators/Harmor';
const STATES = join(__dirname, '../../.flref/harmor/states');
const HAVE_FL = existsSync(join(FL_DIR, 'Default.fst'));
const HAVE_STATES = existsSync(join(STATES, '000.state'));

const read = (p: string) => new Uint8Array(readFileSync(p));
const flFile = (name: string) => join(FL_DIR, name + '.fst');
const reSave = (i: number) => join(STATES, String(i).padStart(3, '0') + '.state');

// ------------------------------------------------------------ state writer

/** Little-endian writer for synthetic states (FL's layout, any version). */
class W {
  b: number[] = [];
  private dv = new DataView(new ArrayBuffer(8));
  i32(v: number) { this.dv.setInt32(0, v, true); for (let i = 0; i < 4; i++) this.b.push(this.dv.getUint8(i)); return this; }
  f32(v: number) { this.dv.setFloat32(0, v, true); for (let i = 0; i < 4; i++) this.b.push(this.dv.getUint8(i)); return this; }
  f64(v: number) { this.dv.setFloat64(0, v, true); for (let i = 0; i < 8; i++) this.b.push(this.dv.getUint8(i)); return this; }
  u8(v: number) { this.b.push(v & 255); return this; }
  bytes(a: ArrayLike<number>) { for (let i = 0; i < a.length; i++) this.b.push(a[i]); return this; }
  out() { return new Uint8Array(this.b); }
}

interface Pt { x: number; y: number; t: number; b?: number[] }
function curve(w: W, type: number, ver: number, pts: Pt[], extra: { a?: number[]; l?: number[]; ph?: number } = {}) {
  w.i32(type).i32(ver).i32(pts.length);
  for (const p of pts) {
    if (ver < 2) w.f32(p.x).f32(p.y); else w.f64(p.x).f64(p.y);
    w.f32(p.t);
    if (ver >= 1) w.bytes(p.b ?? [0, 0, 0, 0]);
  }
  for (const m of [0, -1, -1, -1, -1]) w.i32(m);
  if (type === 1) for (const v of extra.a ?? [10, 20, 30, 40]) w.i32(v);
  if (type === 2) { for (const v of extra.l ?? [1, 2, 3, 4]) w.i32(v); if (ver >= 3) w.i32(extra.ph ?? 7); }
}

/** n points; mappings span x 0..1 (FL rescales other lengths on load). */
const dense = (n: number): Pt[] => Array.from({ length: n }, (_, i) => ({ x: i ? 1 / (n - 1) : 0, y: (i % 17) / 16, t: 0, b: [i % 3, 0, 0, 2] }));
const few: Pt[] = [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 0.25 }];

/** A synthetic part block: version `ver`, map 2 (513 points) and articulator 5's mapping 3 (257 points) dense, image planes 4 x 6. */
function part(ver: number, opts: { src?: string; image?: boolean; half?: boolean } = {}): number[] {
  const w = new W();
  const n = ver < 16 ? 385 : 386;
  for (let i = 0; i < n; i++) w.i32(i < 343 ? i : 500);
  for (let i = 0; i < 12; i++) w.i32(i);
  for (let i = 0; i < 17; i++) w.i32(100 + i);
  for (let i = 0; i < 7; i++) w.u8(i);
  const cv = ver >= 17 ? 3 : ver >= 16 ? 2 : ver >= 12 ? 1 : 0;
  for (let t = 0; t < 43; t++) {
    if (ver < 16 && t === 33) continue;
    w.i32(3).f32(1).f32(0.5).f32(0.25);
    curve(w, 1, cv, few, { a: [t, 2, 3, 4] });
    curve(w, 2, cv, few, { l: [t, 6, 7, 8], ph: 9 });
    for (let j = 0; j < 9; j++) curve(w, 3, cv, t === 5 && j === 3 ? dense(257) : few);
  }
  for (let i = 0; i < 26; i++) curve(w, 3, cv, i === 2 ? dense(513) : i === 0 && opts.half ? [few[0], { x: 0.5, y: 1, t: 0 }] : few);
  w.i32(0).i32(opts.image === false ? 1 : 0).i32(3).i32(4).f64(-1).f64(2.5).f64(-1).i32(4).i32(6);
  if (opts.image !== false) {
    w.i32(24); for (let i = 0; i < 24; i++) w.f32(i * 10);
    w.i32(24); for (let i = 0; i < 24; i++) w.f32((i - 12) / 10);
    w.i32(0);
  }
  const src = new TextEncoder().encode(opts.src ?? '');
  w.u8(src.length).bytes(src);
  return [...new W().i32(w.b.length).out(), ...w.b];
}

function state(ver: number, flags = 7, opts: { src?: string; image?: boolean; half?: boolean } = {}): Uint8Array {
  const w = new W();
  w.i32(ver === 19 ? I.H_STATE_VERSION : ver).i32(flags);
  if (flags & 1) w.bytes(part(ver, opts));
  if (flags & 2) w.bytes(part(ver, opts));
  if (flags & 4) {
    for (let i = 0; i < 53; i++) w.i32(i);
    for (let i = 0; i < 6; i++) w.i32(i);
    for (let i = 0; i < 14; i++) w.i32(i);
    for (let i = 0; i < 5; i++) w.u8(i);
    if (ver < 18) w.i32(3).bytes([72, 105, 33]);
    else w.u8(3).bytes([72, 0, 105, 0, 33, 0]);
    if (ver > 18) w.u8(2);
  }
  return w.out();
}

/** An FL event file (.fst) around a plugin state. */
function fst(blob: Uint8Array): Uint8Array {
  const w = new W();
  w.bytes([70, 76, 104, 100]).i32(6).bytes([0, 0, 1, 0, 96, 0]);
  const body = new W();
  body.u8(199).u8(5).bytes([50, 48, 46, 57, 0]); // event 199: version text
  body.u8(213);
  let n = blob.length;
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; body.u8(b); } while (n);
  body.bytes(blob);
  w.bytes([70, 76, 100, 116]).i32(body.b.length).bytes(body.b);
  return w.out();
}

// ------------------------------------------------------------ synthetic

describe('Harmor FL state parser', () => {
  it('parses version 0x130003 states (both parts, global)', () => {
    const st = I.parseHarmorState(state(19, 7, { src: 'C:\\FL\\Samples\\Aaah.wv' }));
    expect(st.version).toBe(19);
    expect(st.rest).toBe(0);
    const a = st.parts[0]!;
    expect(a.params.length).toBe(386);
    expect(a.params[342]).toBe(342);
    expect(a.fields.slice(15)).toEqual([115, 116, 0, 1, 2, 3, 4, 5, 6]);
    expect(a.arts.every(Boolean)).toBe(true);
    expect(a.maps[2].p.length).toBe(513);
    expect(a.arts[5]!.k[3].p.length).toBe(257);
    expect(a.arts[7]!.l.ph).toBe(9);
    expect(a.img).toMatchObject({ mode: 0, a58: 3, a100: 4, d: [-1, 2.5, -1], rows: 4, cols: 6 });
    expect(a.img.planes.map((p) => p?.length ?? 0)).toEqual([24, 24, 0]);
    expect(a.src).toBe('C:\\FL\\Samples\\Aaah.wv');
    expect(st.global).toMatchObject({ info: 'Hi!', flags: 2 });
    expect(st.global!.params.length).toBe(53);
  });

  it('converts the old versions like FL (385 parameters, 42 articulators, old smoothing, old curves)', () => {
    for (const ver of [11, 12, 16, 17]) {
      const st = I.parseHarmorState(state(ver));
      expect(st.version, `v${ver}`).toBe(ver);
      expect(st.rest).toBe(0);
      const a = st.parts[0]!;
      expect(a.params.length).toBe(386);
      expect(a.arts[33] === null, `v${ver}`).toBe(ver < 16);
      if (ver < 16) expect(a.params[376]).toBe(0);
      // smoothing 343..385: versions < 12 are converted
      expect(a.params[350], `v${ver}`).toBe(ver < 12 ? I.oldSmoothing(500) : 500);
      // curves: float32 points (< 2), no point bytes (< 1), LFO phase only from version 3
      expect(a.arts[7]!.l.ph).toBe(ver >= 17 ? 9 : 0);
      expect(a.maps[2].p[3]).toEqual([Math.fround(1 / 512), Math.fround(3 / 16), 0, 0, 0, 0, ver < 12 ? 0 : 2]);
      expect(st.global!.info).toBe('Hi!');
      expect(st.global!.flags).toBe(0);
    }
    expect(I.oldSmoothing(0)).toBe(0);
    expect(I.oldSmoothing(1000)).toBe(Math.round(Math.log2(Math.fround(Math.exp(Math.fround(1) * 3.713572066704308) - 1) * 37.5 * 0.0511 + 1) * 111.11111111111111));
  });

  it('rescales mappings to length 1 like FL does after loading (the values as saved on request)', () => {
    const blob = state(19, 1, { half: true });
    expect(I.parseHarmorState(blob).parts[0]!.maps[0].p[1][0]).toBe(1);
    expect(I.parseHarmorState(blob, true).parts[0]!.maps[0].p[1][0]).toBe(0.5);
    // envelopes / LFOs keep their times
    expect(I.parseHarmorState(blob).parts[0]!.arts[0]!.e.p[1][0]).toBe(1);
  });

  it('parses single-part states and FL event files', () => {
    const b = I.parseHarmorState(state(19, 2));
    expect(b.parts[0]).toBeNull();
    expect(b.parts[1]!.maps.length).toBe(26);
    expect(b.global).toBeNull();
    const f = I.parseHarmorFile(fst(state(16)))!;
    expect(f.version).toBe(16);
    expect(I.flPluginState(new Uint8Array([70, 76, 104, 100, 255, 255, 255, 127]))).toBeNull();
    expect(I.parseHarmorFile(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('rejects truncated and hostile input with HarmorStateError only', () => {
    const blob = state(19);
    let lenient = 0;
    for (let n = 0; n < blob.length; n += 97) {
      // a cut in the global block leaves the parts usable
      try {
        const st = I.parseHarmorState(blob.subarray(0, n));
        expect([st.global, st.rest], `cut at ${n}`).toEqual([null, -1]);
        lenient++;
      } catch (e) {
        expect(e, `cut at ${n}`).toBeInstanceOf(I.HarmorStateError);
      }
    }
    expect(lenient).toBeLessThan(5);
    // huge counts / sizes are refused before any allocation
    const bad = (patch: (dv: DataView) => void) => {
      const b = blob.slice();
      patch(new DataView(b.buffer));
      return () => I.parseHarmorState(b);
    };
    expect(bad((dv) => dv.setInt32(0, 0x140000, true))).toThrow(I.HarmorStateError);
    expect(bad((dv) => dv.setInt32(8, 0x7fffffff, true))).toThrow(I.HarmorStateError);
    expect(bad((dv) => dv.setInt32(8, -5, true))).toThrow(I.HarmorStateError);
    // the first articulator's envelope point count
    const firstCurve = 12 + 386 * 4 + 12 * 4 + 17 * 4 + 7 + 16;
    expect(bad((dv) => dv.setInt32(firstCurve + 8, 1 << 30, true))).toThrow(I.HarmorStateError);
    expect(bad((dv) => dv.setInt32(firstCurve, 9, true))).toThrow(I.HarmorStateError);
    // random bytes never throw anything else
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
    for (let k = 0; k < 200; k++) {
      const b = blob.slice();
      for (let j = 0; j < 8; j++) b[(rnd() * 256 + rnd()) % b.length] = rnd();
      try { I.parseHarmorState(b); } catch (e) { expect(e).toBeInstanceOf(I.HarmorStateError); }
      expect(() => I.parseHarmorFile(b)).not.toThrow();
    }
  });

  it('converts curves to the model form (shortest float32 numbers, point kind dropped)', () => {
    expect(I.f32num(0.1)).toBe(0.1);
    expect(I.f32num(Math.fround(0.3))).toBe(0.3);
    expect(I.f32num(1 / 512)).toBe(0.001953125);
    expect(I.f32num(-0)).toBe(0);
    expect(Object.is(I.f32num(-0), 0)).toBe(true);
    const c = I.modelCurve({ t: 2, v: 3, p: [[0, 1, 0, 0, 0, 0, 2], [Math.fround(0.7), 0.5, -0.25, 3, 1, 0, 1]], m: [1, -1, -1, -1, -1], l: [1, 2, 3, 4], ph: 5 });
    expect(c).toEqual({ t: 2, p: [[0, 1], [0.7, 0.5, -0.25, 3, 1]], m: [1, -1, -1, -1, -1], l: [1, 2, 3, 4], ph: 5 });
    expect(I.sameCurve(c, { ...c, p: [[0, 1, 0, 0], [0.7, 0.5, -0.25, 3, 1, 0]] })).toBe(true);
    expect(I.sameCurve(c, { ...c, ph: 4 })).toBe(false);
  });
});

describe('Harmor FL content fill', () => {
  /** BASE part A with map 2, articulator 5's mapping 3 and the image marked missing (like a factory preset). */
  function lacking(): HPart {
    const hp = structuredClone(BASE.A);
    hp.missing = ['m2', 'a5k3', 'a33e'];
    hp.img = { ...hp.img, mode: 0, h: 4, w: 6, planes: 3, missing: true };
    return hp;
  }

  it('fills the missing curves and keeps those the file lacks listed', () => {
    const raw = I.parseHarmorState(state(12)).parts[0]!;
    const hp = lacking();
    const r = I.fillCurves(hp, raw);
    expect(r.filled).toEqual(['m2', 'a5k3']);
    expect(r.absent).toEqual(['a33e']); // version 12 has no articulator 33
    expect(hp.missing).toEqual(['a33e']);
    expect(hp.maps[2].p.length).toBe(513);
    expect(hp.arts[5].k[3].p.length).toBe(257);
    expect(hp.arts[5].k[3].p[4]).toEqual([0.00390625, 0.25, 0, 1]);
    // the state keeps them through normalisation
    const st = normalizeHarmor({ ...expandDiff({}), hA: hp });
    expect((st.hA as HPart).maps[2].p.length).toBe(513);
    expect((st.hA as HPart).missing).toEqual(['a33e']);
    const all = lacking();
    all.missing = ['m2'];
    I.fillCurves(all, raw);
    expect(all.missing).toBeUndefined();
  });

  it('encodes image planes as an exact float sample', () => {
    const raw = I.parseHarmorState(state(19)).parts[0]!;
    const hp = lacking();
    const im = I.imageFor(hp, raw)!;
    expect(im).toBeTruthy();
    expect(I.imageFor({ ...hp, img: { ...hp.img, w: 7 } }, raw)).toBeNull();
    const s = I.imagePlanesSample(im);
    expect(s.length).toBe(72);
    expect(Math.max(...s.map(Math.abs))).toBeLessThanOrEqual(1);
    const back = I.samplePlanes(s, 4, 6)!;
    expect([...back[0]]).toEqual([...im.planes[0]!]);
    expect([...back[1]]).toEqual([...im.planes[1]!]);
    expect([...back[2]]).toEqual(new Array(24).fill(0));
    // the WAV the pool stores: IEEE float, mono, 44.1 kHz, the exact values
    const wav = new DataView(I.floatWav(s));
    expect([wav.getUint16(20, true), wav.getUint16(22, true), wav.getUint32(24, true), wav.getUint32(40, true)]).toEqual([3, 1, 44100, 288]);
    expect(wav.getFloat32(44 + 4 * 5, true)).toBe(s[5]);
    const h2 = structuredClone(hp.img);
    I.markImage(h2);
    expect(h2.missing).toBeUndefined();
  });

  it('matches saved FL paths to picked files by their longest common suffix', () => {
    const files: [string[], string][] = [
      ['harmor/samples/aaah.wv', 'A'], ['other/aaah.wv', 'B'], ['harmor/samples/paah.wv', 'C'],
    ].map(([p, f]) => [I.pathParts(p), f]);
    expect(I.matchPath('/Applications/FL Studio 2026.app/Contents/Resources/FL/Data/Patches/Plugin presets/Generators/Harmor/Samples/Aaah.wv', files)).toBe('A');
    expect(I.matchPath('%FLStudioFactoryData%\\Data\\Patches\\Plugin presets\\Generators\\Harmor\\Samples\\PAAH.wv', files)).toBe('C');
    expect(I.matchPath('C:\\x\\none.ogg', files)).toBeNull();
    expect(I.matchPath('', files)).toBeNull();
  });
});

// ------------------------------------------------------------ FL's files

const modelCurveOf = (hp: HPart, key: string): HEnv => I.curveFor(hp, key)!;
/** The two whole-bank tests read and parse all 325 factory .fst files from the FL install (~3 s idle; suites run concurrently here). */
const BANK_TIMEOUT = 5000 + 20 * H_PRESET_NAMES.length;

describe.skipIf(!HAVE_FL || !HAVE_STATES)("Harmor FL content (the user's FL installation)", () => {
  it('parses every factory preset to what FL itself loads (its re-save)', () => {
    const versions = new Map<number, number>();
    H_PRESET_NAMES.forEach((name, i) => {
      const orig = I.parseHarmorFile(read(flFile(name)));
      const fl = I.parseHarmorState(read(reSave(i)), true);
      expect(orig, name).not.toBeNull();
      versions.set(orig!.version, (versions.get(orig!.version) ?? 0) + 1);
      expect(orig!.rest, name).toBe(0);
      expect(fl.rest, name).toBe(0);
      for (let p = 0; p < 2; p++) {
        const a = orig!.parts[p]!, b = fl.parts[p]!;
        expect(a.params, `${name} ${p} params`).toEqual(b.params);
        expect(a.order, name).toEqual(b.order);
        a.arts.forEach((art, t) => {
          if (!art) return;
          const ref = b.arts[t]!;
          expect(I.modelArt(art), `${name} ${p} art ${t}`).toEqual(I.modelArt(ref));
        });
        a.maps.forEach((m, k) => expect(I.modelCurve(m), `${name} ${p} map ${k}`).toEqual(I.modelCurve(b.maps[k])));
        expect([a.img.mode, a.img.rows, a.img.cols], name).toEqual([b.img.mode, b.img.rows, b.img.cols]);
        a.img.planes.forEach((pl, k) => expect(pl ? [...pl] : null, `${name} plane ${k}`).toEqual(b.img.planes[k] ? [...b.img.planes[k]!] : null));
      }
    });
    expect([...versions.keys()].sort((a, b) => a - b)).toEqual([11, 12, 16, 17, 19]);
  }, BANK_TIMEOUT);

  it('gives the factory bank curves and fills every missing curve and image of the bank', () => {
    let filled = 0, images = 0;
    harmorBank().forEach((d, i) => {
      const name = H_PRESET_NAMES[i];
      const st = expandDiff(d);
      const raw = I.parseHarmorFile(read(flFile(name)))!;
      (['hA', 'hB'] as const).forEach((k, p) => {
        const hp = structuredClone(st[k]) as HPart;
        const rp = raw.parts[p]!;
        const miss = new Set(hp.missing ?? []);
        for (const key of I.CURVE_KEYS) {
          const c = I.rawCurveFor(rp, key);
          if (!c || miss.has(key)) continue;
          expect(I.sameCurve(modelCurveOf(hp, key), I.modelCurve(c)), `${name} ${k} ${key}`).toBe(true);
        }
        const params = (j: number) => st[HARMOR_KEYS[p * 386 + j]];
        expect(I.partScore(hp, params, rp), `${name} ${k}`).toBe(1);
        const r = I.fillCurves(hp, rp);
        expect(r.absent, `${name} ${k}`).toEqual([]);
        expect(hp.missing).toBeUndefined();
        for (const key of r.filled) expect(modelCurveOf(hp, key).p.length, `${name} ${key}`).toBeGreaterThan(64);
        filled += r.filled.length;
        if (hp.img.missing) {
          expect(I.imageFor(hp, rp), `${name} ${k} image`).not.toBeNull();
          images++;
        }
      });
    });
    expect(filled).toBeGreaterThan(200);
    expect(images).toBeGreaterThan(20);
  }, BANK_TIMEOUT);
});

describe.skipIf(!HAVE_FL)('Harmor "Import FL content" in a test store', async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { genDef, genPresetState } = await import('../../src/model/gen/registry');
  const { importFlContent, IMG_SAMPLE_KEYS, reportText } = await import('../../src/ui/plugins/gen/harmor/flimport');
  const { getRaw } = await import('../../src/audio/samples');

  /** The user's pick of FL's Harmor preset folder (relative paths like the browser's folder picker gives). */
  const files = (() => {
    if (!HAVE_FL) return [];
    const out: File[] = [];
    for (const rel of readdirSync(FL_DIR, { recursive: true }) as string[]) {
      const path = join(FL_DIR, rel);
      if (!statSync(path).isFile()) continue;
      const f = new File([readFileSync(path)], rel.split('/').pop()!);
      Object.defineProperty(f, 'webkitRelativePath', { value: 'Harmor/' + rel });
      out.push(f);
    }
    return out;
  })();

  function setup(i: number, keepName = true) {
    const id = A.addGenChannel('harmor');
    const slotId = 'ch:' + id;
    const params = () => store.project.channels.find((c) => c.id === id)!.plugin!.params as Record<string, unknown>;
    const st = structuredClone(genPresetState('harmor', genDef('harmor')!.presets![i], params()));
    if (!keepName) delete st.__preset;
    A.setFxStateNoHistory(slotId, 'load', (d) => { for (const k of Object.keys(d)) delete d[k]; Object.assign(d, st); });
    return { slotId, params };
  }

  const bank = harmorBank().map((d) => expandDiff(d));
  const lacks = (st: Record<string, unknown>, k: 'hA' | 'hB') => st[k] as HPart;
  const withImage = bank.findIndex((st) => lacks(st, 'hA').missing && lacks(st, 'hA').img.missing);
  const resynth = bank.findIndex((st) => lacks(st, 'hA').img.mode === 1 && lacks(st, 'hA').src.includes('/Harmor/Samples/'));

  it('imports the named preset: every missing curve, the image planes (one undo step)', async () => {
    const { slotId, params } = setup(withImage);
    const before = [lacks(params(), 'hA').missing!.length, lacks(params(), 'hB').missing?.length ?? 0];
    const r = (await importFlContent(slotId, files))!;
    expect(r.notes).toEqual([]);
    expect(r.curves).toBe(before[0] + before[1]);
    expect(r.images).toBeGreaterThanOrEqual(1);
    expect(r.from).toEqual(['Harmor/' + H_PRESET_NAMES[withImage]]);
    expect(reportText(r)).toMatch(/^Harmor: imported \d+ curves?, \d+ images? from /);
    const st = params(), hp = lacks(st, 'hA');
    expect(hp.missing).toBeUndefined();
    expect(hp.img.missing).toBeUndefined();
    // the curves are FL's (what FL loads from the preset) and normalisation keeps them
    const raw = I.parseHarmorFile(read(flFile(H_PRESET_NAMES[withImage])))!;
    expect(normalizeHarmor(st).hA).toEqual(hp);
    // the image planes: a float sample of 3 planes, exact after unscaling
    const id = st[IMG_SAMPLE_KEYS[0]] as string;
    expect(store.project.samples[id]).toMatchObject({ frames: 3 * hp.img.h * hp.img.w, sampleRate: 44100, channels: 1 });
    const planes = I.samplePlanes(getRaw(id)!.channels[0], hp.img.h, hp.img.w)!;
    raw.parts[0]!.img.planes.forEach((pl, k) => { if (pl) expect([...planes[k]], `plane ${k}`).toEqual([...pl]); });
    // one undo step brings the lacking state back
    store.undo();
    expect(lacks(params(), 'hA').missing!.length).toBe(before[0]);
    expect(params()[IMG_SAMPLE_KEYS[0]]).toBeUndefined();
  });

  it('finds the preset by comparing the parts when the state has no preset name', async () => {
    const { slotId, params } = setup(withImage, false);
    const r = (await importFlContent(slotId, files))!;
    expect(r.from).toEqual(['Harmor/' + H_PRESET_NAMES[withImage]]);
    expect(lacks(params(), 'hA').missing).toBeUndefined();
    // a second import has nothing left to do
    expect(await importFlContent(slotId, files)).toBeNull();
  });

  it('refuses presets that do not match and reports what is left', async () => {
    const { slotId, params } = setup(withImage);
    const other = files.filter((f) => f.name === 'Default.fst');
    const r = (await importFlContent(slotId, other))!;
    expect(r.curves).toBe(0);
    expect(r.notes.join()).toMatch(/no FL preset with part A/);
    expect(lacks(params(), 'hA').missing!.length).toBeGreaterThan(0);
  });

  it('offers the import in the plugin menu', async () => {
    await import('../../src/ui/plugins/gen/harmor');
    const { harmorMenu } = await import('../../src/ui/plugins/gen/harmor/menus');
    const item = harmorMenu('ch:none').find((m) => m.label === 'Import FL content');
    expect(item?.disabled).toBe(false);
    expect(item?.submenu?.map((m) => m.label)).toEqual(["From FL's Harmor preset folder...", 'From files (.fst, samples)...']);
  });

  it('finds the resynthesis sample a preset refers to', async () => {
    expect(resynth).toBeGreaterThan(0);
    const { slotId } = setup(resynth);
    const r = (await importFlContent(slotId, files))!;
    // found by its saved path; the test environment has no audio decoder
    const name = lacks(bank[resynth], 'hA').src.split('/').pop()!;
    expect(r.notes.join()).toContain(`"${name}" could not be decoded`);
  });
});

