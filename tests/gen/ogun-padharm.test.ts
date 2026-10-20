// Ogun's pad harmonics tool: the model (src/model/gen/plugins/ogun/padharm.ts), the bins editor's mouse handling and the tool's use on a
// map (padsession.ts). The model was compared with FL's own code (Ogun_x64.dylib run in a test host: the bins functions 0xf0a80 /
// 0xf28d0 / 0xf0c00, the tool's build 0xf1f00 and the window evaluation 0x264ce0); the digests below are the SHA-256 of what FL
// produced for the inputs of the tests (numbers computed by FL's functions; no FL files are involved).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import './util';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
import {
  PAD_BINS, PAD_FULL, copyBins, defaultLevel, defaultWidth, defaultWindow, humanizeBins, newBins, padHarmonics, padMap, padMapLoaded, padMapRaw, padSpectrum,
  padUnit, prepareWindow, randomPadMap, randomWidthValue, randomizeBins, resetBins, windowPreset, type PadBins, type PadRng,
} from '../../src/model/gen/plugins/ogun/padharm';
import { dragBins, binHint, binIndexAt, binPixel, binValueAt, isOctaveBin, newBinDrag, BIN_PX } from '../../src/ui/plugins/gen/ogun/padbins';
import type { OgEnv } from '../../src/model/gen/plugins/ogun/types';

const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 24);

/** FL's Mersenne twister (Tmt19937: 0x26db20 init_genrand, 0x26dcf0 genrand_int32: the standard generator but the second twist loop starts at 226). */
class FlMt {
  idx = 624;
  mt = new Uint32Array(624);
  constructor(seed: number) {
    const mt = this.mt;
    mt[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) { const p = mt[i - 1] ^ (mt[i - 1] >>> 30); mt[i] = (Math.imul(p, 1812433253) + i) >>> 0; }
  }
  next(): number {
    const mt = this.mt;
    if (this.idx >= 624) {
      const mag = (y: number) => (y & 1 ? 0x9908b0df : 0);
      let k = 0;
      for (; k <= 226; k++) { const y = (mt[k] & 0x80000000) | (mt[k + 1] & 0x7fffffff); mt[k] = mt[k + 397] ^ (y >>> 1) ^ mag(y); }
      for (k = 226; k < 623; k++) {
        const y = (mt[k] & 0x80000000) | (mt[k + 1] & 0x7fffffff);
        mt[k] = (k < 227 ? this.idx : mt[k - 227]) ^ (y >>> 1) ^ mag(y);
      }
      const y = (mt[623] & 0x80000000) | (mt[0] & 0x7fffffff);
      mt[623] = mt[396] ^ (y >>> 1) ^ mag(y);
      this.idx = 0;
    }
    let y = mt[this.idx++];
    y ^= y >>> 11; y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= y >>> 18;
    return y >>> 0;
  }
}

/** The bins as FL keeps them in memory: (level, width) int32 pairs. */
const binBytes = (b: PadBins): Buffer => {
  const out = Buffer.alloc(8 * PAD_BINS);
  for (let i = 0; i < PAD_BINS; i++) { out.writeInt32LE(b.level[i], 8 * i); out.writeInt32LE(b.width[i], 8 * i + 4); }
  return out;
};
/** A curve's points as FL keeps them: x (double), y (float), tension (float), four bytes. */
const pointBytes = (rows: number[][]): Buffer => {
  const out = Buffer.alloc(20 * rows.length);
  rows.forEach((r, i) => { const o = 20 * i; out.writeDoubleLE(r[0], o); out.writeFloatLE(r[1], o + 8); out.writeFloatLE(r[2], o + 12); for (let k = 0; k < 4; k++) out[o + 16 + k] = r[3 + k]; });
  return out;
};

describe('Pad harmonics tool: bins', () => {
  it("has FL's default bins: level ln(100 / n + 1) / ln 101 and widths growing to the full scale", () => {
    const b = newBins();
    expect(b.level[0]).toBe(PAD_FULL);
    expect(b.width[0]).toBe(0);
    expect(b.width[63]).toBe(PAD_FULL);
    expect(b.level[1]).toBe(defaultLevel(1));
    expect(defaultWidth(31)).toBe(Math.round((31 * 65536) / 63));
    expect(sha(binBytes(b))).toBe('142f1fac2321ff9d08d95c4a');
  });

  it("reproduces FL's Mersenne twister (every twist, with its quirk)", () => {
    const m = new FlMt(12345);
    expect([m.next(), m.next(), m.next()]).toEqual([0xedfb51e2, 0xe3e12de5, 0x50fdfd1d]);
    for (let i = 0; i < 1400; i++) m.next(); // crosses two twists
  });

  const GOLD_RAND = [
    '9b1a8885180d1556024d6537', 'a210e38dbaf6a2a6af06085f', '1e755def89a37cae20ee8553', 'd4d80696f1c23c020c27d098', '0e1fe945a15c9f16d64427e6',
    '48e5b6c70a098433bd5de098', '8e43ec30c3f96634a944637c', 'eac2e4fd5fbba853dcd5acd0', '959e80dbc5cd12791f5a5919', 'd877cd8eded19f54cf88c644',
    'd4ec8baaca7ccf3545e2de88', '222d40045a10c39432dfb13e', 'df2f2c13b5c81059c57abc1e', '87bfd7dafbe054620ae77760', '79557c385c9c3cb5f334f853',
    'a8d7fee7149ac3398065e098',
  ];
  it("randomizes and humanizes the bins exactly like FL's buttons (every switch, one twister, 16 steps)", () => {
    const mt = new FlMt(20240611);
    const rng: PadRng = () => mt.next();
    const bins = newBins();
    const steps: (() => void)[] = [];
    for (const walk of [false, true]) for (const steep of [false, true]) for (const mask of [1, 2, 3]) steps.push(() => randomizeBins(bins, mask, rng, { steep, walk }));
    steps.push(() => humanizeBins(bins, 0, rng), () => humanizeBins(bins, 1, rng), () => randomizeBins(bins, 3, rng, { steep: true }), () => humanizeBins(bins, 0, rng));
    expect(steps.length).toBe(GOLD_RAND.length);
    steps.forEach((s, k) => { s(); expect(sha(binBytes(bins)), `step ${k}`).toBe(GOLD_RAND[k]); });
  });

  it('keeps the bins in range and resets only the selected array', () => {
    const mt = new FlMt(7);
    const rng: PadRng = () => mt.next();
    const b = newBins();
    for (let i = 0; i < 20; i++) { randomizeBins(b, 3, rng, { steep: i % 2 === 0, walk: i % 3 === 0 }); humanizeBins(b, (i & 1) as 0 | 1, rng); }
    for (const v of [...b.level, ...b.width]) expect(v >= 0 && v <= PAD_FULL && Number.isInteger(v)).toBe(true);
    expect(b.level[PAD_BINS - 1]).toBeGreaterThanOrEqual(0);
    const c = copyBins(b);
    resetBins(c, 1);
    expect(c.level).toEqual(newBins().level);
    expect(c.width).toEqual(b.width);
    expect(randomWidthValue(() => 0)).toBe(0);
    expect(randomWidthValue(() => 2147483648)).toBe(500);
    expect(randomWidthValue(() => 4294967295)).toBe(1000); // the draw can reach 1001 (float32 rounding): the knob keeps it at its maximum
  });
});

describe('Pad harmonics tool: window shape', () => {
  it("evaluates the default, hat and tent shapes exactly like FL's curve library (257 positions each)", () => {
    const gold: Record<string, string> = { default: 'c1cf1ade29f574d5291511c0', hat: '2c8eff6bc96100477831a23a', tent: '2032ba1edec9043de3977a36' };
    for (const k of ['default', 'hat', 'tent'] as const) {
      const w = prepareWindow(k === 'default' ? defaultWindow() : windowPreset(k));
      expect(w.length).toBe(1);
      const v = new Float64Array(257).map((_, i) => w.at(i / 256));
      expect(sha(Buffer.from(v.buffer)), k).toBe(gold[k]);
    }
    // the default shape is a raised cosine: 0 at the edges, 1 in the middle, 0.5 at a quarter
    const d = prepareWindow(defaultWindow());
    expect(d.at(0)).toBeCloseTo(0, 12);
    expect(d.at(0.5)).toBeCloseTo(1, 12);
    expect(d.at(0.25)).toBeCloseTo(0.5, 6);
    expect(d.at(1)).toBeCloseTo(0, 12);
  });
});

describe('Pad harmonics tool: the map', () => {
  // the inputs of the digests (all run on FL's own code): bins from the twister seeded 777, windows, width, scale
  const mt = new FlMt(777);
  const rng: PadRng = () => mt.next();
  const rb = (mask: number, steep = false): PadBins => { const b = newBins(); randomizeBins(b, mask, rng, { steep }); return b; };
  interface Case { name: string; order: number; natural: boolean; width: number; normalize: boolean; bins: PadBins; shape: 'default' | 'hat' | 'tent'; n: number; sha: string }
  const cases: Case[] = [
    { name: 'default bins, richness 14', order: 14, natural: false, width: 500, normalize: true, bins: newBins(), shape: 'default', n: 6708, sha: '9f5338e94a25acf6833d6848' },
    { name: 'no normalize', order: 14, natural: false, width: 500, normalize: false, bins: newBins(), shape: 'default', n: 6708, sha: '27120202db54a3e5e98c1008' },
    { name: 'width 0', order: 14, natural: false, width: 0, normalize: true, bins: newBins(), shape: 'default', n: 195, sha: 'f829c3c26adbc0397abfd3b5' },
    { name: 'width 1000', order: 14, natural: false, width: 1000, normalize: true, bins: newBins(), shape: 'default', n: 7826, sha: '3181fb7360396b7f6480aeca' },
    { name: 'random bins', order: 14, natural: false, width: 300, normalize: true, bins: rb(3), shape: 'default', n: 3244, sha: '90ba7a707edb7f18a9010489' },
    { name: 'random bins, hat', order: 13, natural: false, width: 700, normalize: true, bins: rb(3, true), shape: 'hat', n: 3538, sha: '4a8fbe22bb2a50ddd82995ad' },
    { name: 'random bins, tent', order: 15, natural: false, width: 123, normalize: false, bins: rb(3), shape: 'tent', n: 1899, sha: '19fa22fdcb88850149e4f4db' },
    { name: 'natural scale', order: 14, natural: true, width: 500, normalize: true, bins: newBins(), shape: 'default', n: 3, sha: '7abcc149213a932725293b07' },
    { name: 'richness 10', order: 10, natural: false, width: 500, normalize: true, bins: rb(3), shape: 'default', n: 416, sha: '9d183645df5b7b68d65d16d0' },
    { name: 'richness 7', order: 7, natural: false, width: 900, normalize: true, bins: rb(3), shape: 'hat', n: 67, sha: 'f41f7a2b2a741eee7ad91bb1' },
    { name: 'richness 16', order: 16, natural: false, width: 500, normalize: true, bins: rb(3), shape: 'default', n: 24148, sha: 'd0468d7e65d4002da3533d25' },
    { name: 'richness 6 (too few harmonics)', order: 6, natural: false, width: 500, normalize: true, bins: newBins(), shape: 'default', n: 3, sha: '89c50bc998bbe747a00eb01f' },
  ];
  it("builds the same curve as FL's tool for 12 settings (point for point: distance, level, tension, bytes)", () => {
    for (const c of cases) {
      const win = c.shape === 'default' ? defaultWindow() : windowPreset(c.shape);
      const spec = padSpectrum(c.bins, prepareWindow(win), { width: c.width, normalize: c.normalize, n: padHarmonics(c.order) });
      const rows = padMapLoaded(padMapRaw(spec, padUnit(c.natural)));
      expect(rows.length, c.name).toBe(c.n);
      expect(sha(pointBytes(rows)), c.name).toBe(c.sha);
    }
  });

  it('stores the map as a mapping curve the state accepts as it is: a first point at 0, distances summing to 1, redundant points gone', async () => {
    const { normalizeOgun, freshState } = await import('../../src/model/gen/plugins/ogun/state');
    const win = prepareWindow(defaultWindow());
    const spec = padSpectrum(newBins(), win, { width: 500, normalize: true, n: padHarmonics(14) });
    const rows = padMap(spec, padUnit(false));
    expect(rows[0][0]).toBe(0);
    expect(rows.reduce((s, r) => s + r[0], 0)).toBeCloseTo(1, 12);
    expect(rows[0][6]).toBe(0);
    expect(rows.slice(1).every((r) => r[6] === 2 && r[2] === 0 && r[3] === 0)).toBe(true);
    // normalize loudness: the loudest harmonic is at most 4 on FL's scale (the map's 1.0), lower when many bins share the energy
    expect(Math.max(...spec)).toBeLessThanOrEqual(4 * (1 + 1e-6));
    expect(Math.max(...rows.map((r) => r[1]))).toBeGreaterThan(0.5);
    expect(rows.every((r) => r[1] >= 0 && r[1] <= 1)).toBe(true);
    // runs of equal levels are kept as their two end points (what FL's tool leaves before the stored curve gets its first point)
    const raw = padMapRaw(spec, padUnit(false));
    for (let i = 1; i + 1 < raw.length; i++) expect(raw[i - 1][1] === raw[i][1] && raw[i][1] === raw[i + 1][1], `point ${i}`).toBe(false);
    expect(rows.length).toBe(raw.length + 1);
    const st = freshState() as Record<string, unknown>;
    const maps = (st.maps as OgEnv[]).slice();
    maps[1] = { t: 3, m: [0, -1, -1, -1, -1], p: rows };
    const back = normalizeOgun({ ...st, maps });
    expect((back.maps as OgEnv[])[1].p).toBe(rows); // untouched: nothing to repair
  });

  it("matches FL's behaviour on the natural EQ mapping scale: a point is an octave, so only the first octaves are filled", () => {
    const spec = padSpectrum(newBins(), prepareWindow(defaultWindow()), { width: 500, normalize: true, n: padHarmonics(14) });
    expect(padMap(spec, padUnit(true)).length).toBe(3);
    expect(padUnit(true)).toBe(1 / 15);
    expect(padUnit(false)).toBe(1 / 32767);
    expect(padHarmonics(14)).toBe(8192);
  });
});

describe('Pad harmonics tool: the random preset generator\'s use', () => {
  it('resets, randomizes width and bins (in that order of draws) and builds the map', () => {
    const base: OgEnv = { t: 3, m: [0, -1, -1, -1, -1], p: [[0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 2]] };
    const run = (seed: number) => {
      const mt = new FlMt(seed);
      return randomPadMap(base, () => mt.next(), { n: padHarmonics(13), unit: padUnit(false), steep: true, walk: true });
    };
    const a = run(5), b = run(5), c = run(6);
    expect(a.curve.p).toEqual(b.curve.p);
    expect(a.curve.p).not.toEqual(c.curve.p);
    // the same draws by hand
    const mt = new FlMt(5);
    const rng: PadRng = () => mt.next();
    const width = randomWidthValue(rng);
    const bins = newBins();
    randomizeBins(bins, 3, rng, { steep: true, walk: true });
    expect(a.settings.width).toBe(width);
    expect(a.settings.bins).toEqual(bins);
    const spec = padSpectrum(bins, prepareWindow(defaultWindow()), { width, normalize: true, n: padHarmonics(13) });
    expect(a.curve.p).toEqual(padMap(spec, padUnit(false)));
    expect(a.curve.m).toEqual(base.m);
  });
});

describe('Pad harmonics tool: the bins editor', () => {
  const bins = () => newBins();
  const at = (bin: number, y: number, o: { left?: boolean; shift?: boolean; alt?: boolean } = {}) => ({ x: bin * BIN_PX + 3, y, left: o.left ?? true, shift: !!o.shift, alt: !!o.alt });

  it('maps pixel rows to values like FL (full scale at the top, 0 at the bottom of a 102 px range)', () => {
    expect(binValueAt(1)).toBe(PAD_FULL);
    expect(binValueAt(1 + 102)).toBe(0);
    expect(binValueAt(52)).toBeCloseTo(PAD_FULL / 2, 0);
    expect(binPixel(PAD_FULL)).toBe(1);
    expect(binPixel(0)).toBe(103);
    expect(binIndexAt(-3)).toBe(-1);
    expect(binIndexAt(7.9)).toBe(0);
    expect(binIndexAt(8)).toBe(1);
  });

  /** The value FL gives a bar for a pointer row (FL works with y - 1). */
  const val = (y: number) => Math.min(PAD_FULL, Math.max(0, Math.round(binValueAt(y))));
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;

  it('sets the bar under the pointer and interpolates between the positions of a left drag', () => {
    const b = bins(), d = newBinDrag();
    expect(dragBins(b, 0, d, at(10, 52))).toBe(true);
    expect(near(b.level[10], val(51))).toBe(true);
    expect(b.level[9]).toBe(newBins().level[9]);
    // a fast move to bin 14 at the top: the bars follow the line from the last position (10, 51) to (14, 1)
    expect(dragBins(b, 0, d, at(14, 2))).toBe(true);
    [51, 38.5, 26, 13.5, 1].forEach((y, i) => expect(near(b.level[10 + i], val(y)), `bar ${10 + i}`).toBe(true));
    expect(b.level[15]).toBe(newBins().level[15]);
    // the width tab leaves the levels alone
    const before = b.level.slice();
    dragBins(b, 1, newBinDrag(), at(3, 40));
    expect(b.level).toEqual(before);
    expect(near(b.width[3], val(39))).toBe(true);
  });

  it('draws a ramp with the right button: the first position stays the anchor', () => {
    const b = bins(), d = newBinDrag();
    dragBins(b, 0, d, at(20, 90, { left: false }));
    dragBins(b, 0, d, at(30, 10, { left: false }));
    // bars 20 .. 30 form a straight line from (20, 89) to (30, 9)
    for (let i = 0; i <= 10; i++) expect(near(b.level[20 + i], val(89 - 8 * i)), `bar ${20 + i}`).toBe(true);
    // dragging back keeps the anchor: a shorter ramp from the same start
    dragBins(b, 0, d, at(25, 50, { left: false }));
    expect(near(b.level[25], val(49))).toBe(true);
    expect(near(b.level[20], val(89))).toBe(true);
  });

  it('Shift + left drag changes one bar only, Alt sets the full scale; values stay in range outside the visual', () => {
    const b = bins(), d = newBinDrag();
    dragBins(b, 0, d, at(40, 30));
    const keep = b.level.slice();
    dragBins(b, 0, d, { ...at(50, 80), shift: true });
    expect(b.level[50]).toBe(keep[50]);
    expect(near(b.level[40], val(79))).toBe(true);
    dragBins(b, 0, newBinDrag(), at(5, 95, { alt: true }));
    expect(b.level[5]).toBe(PAD_FULL);
    // far outside (the pointer is captured): only the bars inside change, nothing throws
    const c = bins(), e = newBinDrag();
    dragBins(c, 0, e, { x: -40, y: -20, left: true, shift: false, alt: false });
    dragBins(c, 0, e, { x: 900, y: 500, left: true, shift: false, alt: false });
    for (const x of c.level) expect(x >= 0 && x <= PAD_FULL && Number.isInteger(x)).toBe(true);
    expect(c.level[0]).toBeGreaterThan(60000);
    expect(c.level[63]).toBe(0);
  });

  it('hints the harmonic and its octave, and shades the octave columns', () => {
    expect(binHint(0)).toBe('Harmonic 1');
    expect(binHint(11)).toBe('Harmonic 12 (+3 oct)');
    expect(binHint(63)).toBe('Harmonic 64 (+6 oct)');
    expect(binHint(-1)).toBe('');
    expect(binHint(64)).toBe('');
    expect([...Array(64).keys()].filter(isOctaveBin)).toEqual([0, 1, 3, 7, 15, 31, 63]);
  });
});

describe('Pad harmonics tool: what it remembers', () => {
  it('reads remembered state defensively', async () => {
    const { parseSaved } = await import('../../src/ui/plugins/gen/ogun/padsession');
    const d = parseSaved(null);
    expect(d.bins).toEqual(newBins());
    expect(d.tab).toBe(0);
    expect(parseSaved('not json').per).toEqual({});
    expect(parseSaved('{"bins":{"level":[1],"width":[2]}}').bins).toEqual(newBins());
    const good = { bins: { level: Array(64).fill(70000), width: Array(64).fill(-5) }, tab: 1, per: { 14: { width: 5000, normalize: false, window: defaultWindow() }, 3: { width: 1, normalize: true, window: defaultWindow() }, 15: { width: 10, window: { t: 3, m: [0, 0, 0, 0, 0], p: [[0, 0]] } } } };
    const p = parseSaved(JSON.stringify(good));
    expect(p.bins.level.every((v) => v === 65536)).toBe(true);
    expect(p.bins.width.every((v) => v === 0)).toBe(true);
    expect(p.tab).toBe(1);
    expect(Object.keys(p.per)).toEqual(['14']);
    expect(p.per[14].width).toBe(1000);
    expect(p.per[14].normalize).toBe(false);
  });
});

describe('Pad harmonics tool: one use on a map', () => {
  it('shows the map at once without an undo entry, accepts as one undo step and gives the map back when closed', async () => {
    const A = await import('../../src/store/actions');
    const { store } = await import('../../src/store');
    const { PadSession, resetSaved } = await import('../../src/ui/plugins/gen/ogun/padsession');
    resetSaved();
    const id = A.addGenChannel('ogun');
    const slotId = 'ch:' + id;
    const params = () => store.project.channels.find((c) => c.id === id)!.plugin!.params as Record<string, any>;
    // the natural scale is on in a new Ogun: switch it off like a pad patch has it
    A.editFx(slotId, 'linear scale', (d) => { (d.xi as number[])[8] &= 0x00ffffff; });
    const missing = ['m1'];
    A.editFx(slotId, 'mark missing', (d) => { d.missing = missing.slice(); });
    const before = structuredClone(params().maps[1]) as OgEnv;
    const marks = store.historyLabels().past.length;

    const s = new PadSession(slotId, 14);
    expect(s.natural).toBe(false);
    s.open();
    expect(params().maps[1].p.length).toBeGreaterThan(1000);
    expect(store.historyLabels().past.length).toBe(marks);
    s.state.width = 800;
    s.preview();
    const wide = params().maps[1].p.length;
    expect(wide).toBeGreaterThan(5000);
    expect(params().missing).toEqual(['m1']); // still the preview: the mark stays until it is accepted
    s.close();
    expect(params().maps[1]).toEqual(before); // closed: given back, no history
    expect(store.historyLabels().past.length).toBe(marks);

    // reopened: the tool remembers its width; accept
    const t = new PadSession(slotId, 14);
    expect(t.state.width).toBe(800);
    t.open();
    t.state.bins.level[5] = 65536;
    t.accept();
    expect(store.historyLabels().past.length).toBe(marks + 1);
    expect(store.historyLabels().past.at(-1)).toBe('Create pad harmonics');
    expect(params().maps[1].p.length).toBeGreaterThan(1000);
    expect(params().missing).toEqual([]);
    t.close(); // closing after accepting changes nothing
    expect(params().maps[1].p.length).toBeGreaterThan(1000);
    store.undo();
    expect(params().maps[1]).toEqual(before);
    expect(params().missing).toEqual(['m1']);
    store.redo();
    expect(params().maps[1].p.length).toBeGreaterThan(1000);

    // a map that is not there: nothing to do
    A.editFx(slotId, 'no maps', (d) => { d.maps = []; });
    const u = new PadSession(slotId, 13);
    expect(u.orig).toBeNull();
    u.open();
    u.accept();
    expect(params().maps).toEqual([]);
  });
});

describe('Pad harmonics tool: the dialog', () => {
  it("is laid out like FL's form (530 x 397: the bins at (9, 54), the window shape editor at (9, 236), the wheel at (484, 236), Accept at (469, 359))", async () => {
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const A = await import('../../src/store/actions');
    const { PadHarmonics } = await import('../../src/ui/plugins/gen/ogun/padharm');
    const id = A.addGenChannel('ogun');
    const html = renderToStaticMarkup(React.createElement(PadHarmonics, { slotId: 'ch:' + id, target: 14 }));
    const px = (v: number) => (v === 0 ? '0' : `${v}px`);
    const has = (x: number, y: number, w: number, h: number) => html.includes(`left:${px(x)};top:${px(y)};width:${px(w)};height:${px(h)}`);
    expect(html).toContain('Create pad harmonics');
    for (const t of ['Harmonic bins', 'Bin window shape', 'Bin level', 'Bin width', 'Randomize', 'Humanize', 'Accept', 'Normalize loudness', 'Width']) expect(html, t).toContain(t);
    expect(has(9, 54, 512, 105), 'LevelVisual').toBe(true);
    expect(has(9, 159, 120, 27), 'TargetSelect').toBe(true);
    expect(has(340, 159, 49, 27), 'ResetBtn').toBe(true);
    expect(has(389, 159, 69, 27), 'RandBtn').toBe(true);
    expect(has(458, 159, 63, 27), 'HumanizeBtn').toBe(true);
    expect(has(9, 236, 326, 85), 'EnvVisual').toBe(true);
    expect(has(484, 236, 36, 36), 'WidthWheel').toBe(true);
    expect(has(397, 324, 125, 16), 'NormBox').toBe(true);
    expect(has(8, 358, 60, 29), 'FullResetBtn').toBe(true);
    expect(has(82, 358, 79, 29), 'FullRandBtn').toBe(true);
    expect(has(469, 359, 60, 29), 'OkBtn').toBe(true);
    expect(has(15, 90, 530, 397), 'the form').toBe(true);
    // a new Ogun has the natural EQ mapping scale on: the dialog says what that does to the tool
    expect(html).toContain('Natural EQ mapping scale is on');
  });
});

