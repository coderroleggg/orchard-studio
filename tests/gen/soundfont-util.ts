// Test helpers for the SoundFont Player: a small SoundFont 2 writer (own code; the tests build their fonts with it, nothing
// is copied from FL), sample generators, and a block-by-block engine render like the sequencer's.
import { createGen } from '../../src/engine/gen';
import { newLevels } from '../../src/engine/gen/levels';
import type { GenNote } from '../../src/engine/gen/types';
import { G } from '../../src/model/gen/plugins/soundfont/gens';
import { importSf2 } from '../../src/model/gen/plugins/soundfont/import';
import { defaultGenParams } from '../../src/model/gen/registry';

export { G };

/** A generator value: an amount, or a (low, high) range for the key / velocity range generators. */
export type SfGenValue = number | [number, number];
/** A modulator: source, destination, amount, amount source, transform. */
export type SfModDef = [src: number, dest: number, amount: number, amtSrc?: number, trans?: number];
export interface SfZoneDef { gens: Record<number, SfGenValue>; mods?: SfModDef[] }
export interface SfSampleDef {
  name?: string;
  /** 16 bit sample points (24 bit values when the writer's `sm24` is set). */
  data: ArrayLike<number>;
  rate?: number;
  root?: number;
  corr?: number;
  /** Loop points inside `data`. */
  loop?: [number, number];
  /** sfSampleType: 1 mono, 2 right, 4 left, 8 linked. */
  type?: number;
  link?: number;
  /** Points cut from the end of the sample header's end address (end inside the data). */
  endcut?: number;
}

/** Modulator source word (SF2 spec 8.2): index, CC flag, direction, polarity, curve type. */
export function modSrc(index: number, o: { cc?: boolean; neg?: boolean; bipolar?: boolean; type?: number } = {}): number {
  return index | (o.cc ? 0x80 : 0) | (o.neg ? 0x100 : 0) | (o.bipolar ? 0x200 : 0) | ((o.type ?? 0) << 10);
}
export const MOD_VEL = 2, MOD_KEY = 3, MOD_POLY_PRESSURE = 10, MOD_CHAN_PRESSURE = 13, MOD_PITCH_WHEEL = 14, MOD_PITCH_SENS = 16;

const le16 = (v: number): number[] => [v & 255, (v >> 8) & 255];
const le32 = (v: number): number[] => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const asc = (s: string, n: number): number[] => {
  const b = new Array<number>(n).fill(0);
  for (let i = 0; i < Math.min(s.length, n - 1); i++) b[i] = s.charCodeAt(i) & 255;
  return b;
};
const tag = (s: string): number[] => [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];
const chunk = (id: string, body: number[]): number[] => [...tag(id), ...le32(body.length), ...body, ...(body.length & 1 ? [0] : [])];
const list = (id: string, body: number[]): number[] => [...tag('LIST'), ...le32(body.length + 4), ...tag(id), ...body];
const s16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v))) & 0xffff;
const push = (a: number[], b: number[]): void => { for (let i = 0; i < b.length; i++) a.push(b[i]); };

/** A SoundFont 2 writer: samples, instruments (zones with generators and modulators), presets. */
export class Sf2Writer {
  name = 'Test font';
  version: [number, number] = [2, 1];
  sm24 = false;
  readonly samples: SfSampleDef[] = [];
  readonly insts: { name: string; zones: SfZoneDef[] }[] = [];
  readonly presets: { name: string; program: number; bank: number; zones: SfZoneDef[] }[] = [];

  addSample(def: SfSampleDef): number { this.samples.push(def); return this.samples.length - 1; }
  addInstrument(name: string, zones: SfZoneDef[]): number { this.insts.push({ name, zones }); return this.insts.length - 1; }
  addPreset(name: string, program: number, bank: number, zones: SfZoneDef[]): number {
    this.presets.push({ name, program, bank, zones });
    return this.presets.length - 1;
  }

  build(): Uint8Array {
    const info: number[] = [];
    push(info, chunk('ifil', [...le16(this.version[0]), ...le16(this.version[1])]));
    push(info, chunk('isng', asc('EMU8000', 8)));
    push(info, chunk('INAM', asc(this.name, this.name.length + 1)));
    // sample data: every sample followed by 46 zero points (spec 7.10)
    const smpl: number[] = [], sm24: number[] = [], shdr: number[] = [];
    let pos = 0;
    for (const s of this.samples) {
      const n = s.data.length;
      for (let i = 0; i < n; i++) {
        const v = s.data[i];
        if (this.sm24) {
          const v24 = Math.max(-8388608, Math.min(8388607, Math.round(v)));
          push(smpl, le16(s16(v24 >> 8))); sm24.push(v24 & 255);
        } else push(smpl, le16(s16(v)));
      }
      for (let i = 0; i < 46; i++) { push(smpl, [0, 0]); if (this.sm24) sm24.push(0); }
      const [ls, le] = s.loop ?? [0, 0];
      push(shdr, asc(s.name ?? 'smp', 20));
      push(shdr, [...le32(pos), ...le32(pos + n - (s.endcut ?? 0)), ...le32(pos + ls), ...le32(pos + le), ...le32(s.rate ?? 44100),
        s.root ?? 60, (s.corr ?? 0) & 255, ...le16(s.link ?? 0), ...le16(s.type ?? 1)]);
      pos += n + 46;
    }
    push(shdr, asc('EOS', 20));
    push(shdr, new Array<number>(26).fill(0));
    const sdta: number[] = [];
    push(sdta, chunk('smpl', smpl));
    if (this.sm24) push(sdta, chunk('sm24', sm24));

    const zones = (zs: SfZoneDef[], gens: number[], mods: number[], bags: number[], gi0: number, mi0: number): [number, number] => {
      let gi = gi0, mi = mi0;
      for (const z of zs) {
        push(bags, [...le16(gi), ...le16(mi)]);
        // key / velocity ranges first, the terminal generator (instrument / sampleID) last
        const order: number[] = [];
        const keys = Object.keys(z.gens).map(Number).sort((a, b) => a - b);
        if (G.keyRange in z.gens) order.push(G.keyRange);
        if (G.velRange in z.gens) order.push(G.velRange);
        const last: number[] = [G.instrument, G.sampleID].filter((g) => g in z.gens);
        for (const g of keys) if (!order.includes(g) && !last.includes(g)) order.push(g);
        order.push(...last);
        for (const g of order) {
          const v = z.gens[g];
          if (Array.isArray(v)) push(gens, [...le16(g), v[0] & 255, v[1] & 255]);
          else push(gens, [...le16(g), ...le16(s16(v))]);
          gi++;
        }
        for (const m of z.mods ?? []) {
          push(mods, [...le16(m[0]), ...le16(m[1]), ...le16(s16(m[2])), ...le16(m[3] ?? 0), ...le16(m[4] ?? 0)]);
          mi++;
        }
      }
      return [gi, mi];
    };
    const phdr: number[] = [], pbag: number[] = [], pmod: number[] = [], pgen: number[] = [];
    let gi = 0, mi = 0, bi = 0;
    for (const p of this.presets) {
      push(phdr, [...asc(p.name, 20), ...le16(p.program), ...le16(p.bank), ...le16(bi), ...le32(0), ...le32(0), ...le32(0)]);
      [gi, mi] = zones(p.zones, pgen, pmod, pbag, gi, mi);
      bi += p.zones.length;
    }
    push(phdr, [...asc('EOP', 20), ...le16(0), ...le16(0), ...le16(bi), ...le32(0), ...le32(0), ...le32(0)]);
    push(pbag, [...le16(gi), ...le16(mi)]);
    push(pmod, new Array<number>(10).fill(0));
    push(pgen, [0, 0, 0, 0]);
    const inst: number[] = [], ibag: number[] = [], imod: number[] = [], igen: number[] = [];
    gi = 0; mi = 0; bi = 0;
    for (const it of this.insts) {
      push(inst, [...asc(it.name, 20), ...le16(bi)]);
      [gi, mi] = zones(it.zones, igen, imod, ibag, gi, mi);
      bi += it.zones.length;
    }
    push(inst, [...asc('EOI', 20), ...le16(bi)]);
    push(ibag, [...le16(gi), ...le16(mi)]);
    push(imod, new Array<number>(10).fill(0));
    push(igen, [0, 0, 0, 0]);
    const pdta: number[] = [];
    for (const [id, body] of [['phdr', phdr], ['pbag', pbag], ['pmod', pmod], ['pgen', pgen], ['inst', inst], ['ibag', ibag],
      ['imod', imod], ['igen', igen], ['shdr', shdr]] as [string, number[]][]) push(pdta, chunk(id, body));
    const body = [...tag('sfbk'), ...list('INFO', info), ...list('sdta', sdta), ...list('pdta', pdta)];
    return Uint8Array.from([...tag('RIFF'), ...le32(body.length), ...body]);
  }
}

// ------------------------------------------------------------------ sample data
/** A sine with an integer period (so loops of whole periods are seamless). */
export function sineData(period = 100, cycles = 4, amp = 30000): number[] {
  const out: number[] = [];
  for (let i = 0; i < period * cycles; i++) out.push(Math.round(amp * Math.sin((2 * Math.PI * i) / period)));
  return out;
}

/** Deterministic white noise (a linear congruential generator), 16 bit. */
export function noiseData(n = 16384, seed = 11, amp = 12000): number[] {
  let x = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out.push(Math.round(((x >>> 8) / 8388608 - 1) * amp));
  }
  return out;
}

export interface SimpleFontOpts {
  data?: ArrayLike<number>;
  /** Instrument zone generators / modulators. */
  gens?: Record<number, SfGenValue>;
  mods?: SfModDef[];
  /** Preset zone generators. */
  pgens?: Record<number, SfGenValue>;
  rate?: number;
  root?: number;
  corr?: number;
  /** 'all' loops the whole sample (the default), [start, end] a part, null none. */
  loop?: 'all' | [number, number] | null;
  endcut?: number;
  name?: string;
}

/** One sample, one instrument zone, one preset (bank 0, program 0) with one zone. */
export function simpleFont(o: SimpleFontOpts = {}): Uint8Array {
  const data = o.data ?? sineData();
  const w = new Sf2Writer();
  w.name = o.name ?? 'Test font';
  const loop = o.loop === undefined || o.loop === 'all' ? [0, data.length] as [number, number] : o.loop ?? undefined;
  const s = w.addSample({ name: 'smp', data, rate: o.rate, root: o.root, corr: o.corr, loop, endcut: o.endcut });
  const i = w.addInstrument('inst', [{ gens: { ...(o.gens ?? {}), [G.sampleID]: s }, mods: o.mods }]);
  w.addPreset('preset', 0, 0, [{ gens: { ...(o.pgens ?? {}), [G.instrument]: i } }]);
  return w.build();
}

// ------------------------------------------------------------------ engine render
export interface RenderNote { key: number; vel: number; start: number; dur: number }
export interface RenderOpts {
  sr?: number;
  secs: number;
  /** State keys of the instrument (mod, resampling, revOn, ...). */
  params?: Record<string, unknown>;
  chanVol?: number;
  chanPan?: number;
  /** Pitch of the channel in cents on top of the key (FinalLevels.Pitch). */
  pitchOffset?: number;
  /** Idle frames rendered before the notes (see hostPreroll). */
  preroll?: number;
  /** Notes killed (polyphony limit) at a time: [index in the note list, seconds] - their note off is dropped. */
  kills?: [number, number][];
  /** Render block size in frames (the test host renders 512 frames per call; some FL behaviours depend on it). */
  block?: number;
  /** Rate the sample pool delivers the font at (the pool decodes at the audio context's rate). */
  poolRate?: number;
}
export interface Rendered { L: Float32Array; R: Float32Array }

/**
 * The idle frames of FL's test host before its first note: it renders 0.25 s (rounded to frames) of nothing, and the chorus LFO
 * (0.366 Hz) runs through it: 0.0915 cycles at every sample rate (bit exact on a click at 8 .. 96 kHz, 22.05 kHz included).
 */
export const hostPreroll = (sr: number): number => Math.round(0.25 * sr);

/** Render notes through the engine in blocks of `block` frames (128 by default), cut at the note events like the test host's; `sf2` null = no soundfont loaded. */
export function renderFont(sf2: Uint8Array | null, notes: RenderNote[], o: RenderOpts): Rendered {
  const sr = o.sr ?? 44100;
  const params = defaultGenParams('soundfont');
  const pool = new Map<string, { channels: Float32Array[]; sampleRate: number }>();
  if (sf2) {
    const imp = importSf2(sf2);
    if ('error' in imp) throw new Error(imp.error);
    pool.set('s1', { channels: [imp.pcm], sampleRate: o.poolRate ?? imp.font.rate });
    params.fonts = [{ ...imp.font, sample: 's1' }];
  }
  Object.assign(params, o.params ?? {});
  const inst = createGen('soundfont', sr, 128, { sample: (id) => pool.get(id) })!;
  inst.setParams(params);
  const total = Math.round(o.secs * sr);
  const L = new Float32Array(total), R = new Float32Array(total);
  interface Ev { frame: number; on: boolean; note: GenNote; kill?: boolean }
  const evs: Ev[] = [];
  notes.forEach((n, i) => {
    const lv = newLevels();
    lv.pitch = n.key * 100 + (o.pitchOffset ?? 0); lv.vol = o.chanVol ?? 1; lv.pan = o.chanPan ?? 0;
    const init = newLevels(); init.pitch = n.key * 100;
    const note: GenNote = { id: i + 1, key: n.key, velocity: n.vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels: lv };
    evs.push({ frame: Math.round(n.start * sr), on: true, note });
    const kt = (o.kills ?? []).find((k) => k[0] === i);
    if (kt) {
      if (n.start + n.dur < kt[1]) evs.push({ frame: Math.round((n.start + n.dur) * sr), on: false, note });
      evs.push({ frame: Math.round(kt[1] * sr), on: false, note, kill: true });
    } else evs.push({ frame: Math.round((n.start + n.dur) * sr), on: false, note });
  });
  evs.sort((a, b) => a.frame - b.frame);
  const BS = o.block ?? 128;
  const ctx = { sampleRate: sr, blockSize: BS, tempo: 130, ppq: 96, playing: false, pos: 0, songMode: false, track: 1 };
  const pre = o.preroll ?? 0;
  const z0 = new Float32Array(BS), z1 = new Float32Array(BS);
  for (let b = 0; b < pre; b += BS) { z0.fill(0); z1.fill(0); inst.render!(z0, z1, Math.min(BS, pre - b), ctx); }
  const bl = new Float32Array(BS), br = new Float32Array(BS);
  let ei = 0;
  // like the test host: a block of up to BS frames ends at a note event and the next block starts there
  let blockStart = 0;
  for (let b = 0; b < total;) {
    let n = Math.min(blockStart + BS - b, total - b);
    if (n <= 0) { blockStart = b; continue; }
    let cut = false;
    if (ei < evs.length && evs[ei].frame > b && evs[ei].frame < b + n) { n = evs[ei].frame - b; cut = true; }
    bl.fill(0); br.fill(0);
    while (ei < evs.length && evs[ei].frame < b + n) {
      const e = evs[ei++];
      const off = Math.max(0, e.frame - b);
      if (e.on) inst.noteOn!(e.note, off);
      else if (e.kill) { e.note.frame = off; inst.killNote!(e.note); } else inst.noteOff!(e.note, off);
    }
    inst.render!(bl, br, n, ctx);
    L.set(bl.subarray(0, n), b); R.set(br.subarray(0, n), b);
    b += n;
    if (cut) blockStart = b;
  }
  return { L, R };
}

// ------------------------------------------------------------------ measuring
export function rms(x: ArrayLike<number>, a = 0, b = x.length): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return b > a ? Math.sqrt(s / (b - a)) : 0;
}
export const dB = (v: number): number => (v > 1e-12 ? 20 * Math.log10(v) : -240);
export function peak(x: ArrayLike<number>, a = 0, b = x.length): number {
  let p = 0;
  for (let i = a; i < b; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}
/** Residual of `a` against the reference `ref`, relative to the reference's rms (dB). */
export function residualDb(a: ArrayLike<number>, ref: ArrayLike<number>): number {
  const n = Math.min(a.length, ref.length);
  let d = 0, r = 0;
  for (let i = 0; i < n; i++) { const e = a[i] - ref[i]; d += e * e; r += ref[i] * ref[i]; }
  return r > 0 ? dB(Math.sqrt(d / r)) : d > 0 ? 0 : -240;
}
export function allFinite(x: ArrayLike<number>): boolean {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false;
  return true;
}

// ------------------------------------------------------------------ a manual driver (pool delays, state changes while playing)
export interface Driver {
  inst: NonNullable<ReturnType<typeof createGen>>;
  pool: Map<string, { channels: Float32Array[]; sampleRate: number }>;
  /** The state of the last setParams. */
  params: Record<string, unknown>;
  setParams(p: Record<string, unknown>): void;
  on(id: number, key: number, vel: number, frame?: number): void;
  off(id: number, frame?: number): void;
  /** Render one block of n frames (events were given frame offsets inside it). */
  block(n?: number, out?: (track: number, l: Float32Array, r: Float32Array, n: number) => void): Rendered;
}

/** An engine instance with a sample pool the test fills itself. `sf2` is added to the pool unless `delayPool` is set. */
export function driver(sf2: Uint8Array | null, params: Record<string, unknown> = {}, o: { sr?: number; delayPool?: boolean; track?: number } = {}): Driver {
  const sr = o.sr ?? 44100;
  const pool = new Map<string, { channels: Float32Array[]; sampleRate: number }>();
  const base = defaultGenParams('soundfont');
  let font: Record<string, unknown> | null = null;
  let pcm: Float32Array | null = null;
  if (sf2) {
    const imp = importSf2(sf2);
    if ('error' in imp) throw new Error(imp.error);
    font = { ...imp.font, sample: 's1' };
    pcm = imp.pcm;
    if (!o.delayPool) pool.set('s1', { channels: [imp.pcm], sampleRate: imp.font.rate });
    base.fonts = [font];
  }
  const inst = createGen('soundfont', sr, 128, { sample: (id) => pool.get(id) })!;
  const d: Driver = {
    inst, pool, params: { ...base, ...params },
    setParams(p) { d.params = { ...d.params, ...p }; inst.setParams(d.params); },
    on(id, key, vel, frame = 0) {
      const lv = newLevels(); lv.pitch = key * 100; lv.vol = 1; lv.pan = 0;
      const init = newLevels(); init.pitch = key * 100;
      const note: GenNote = { id, key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels: lv };
      notes.set(id, note);
      inst.noteOn!(note, frame);
    },
    off(id, frame = 0) { const note = notes.get(id); if (note) inst.noteOff!(note, frame); },
    block(n = 128, out) {
      const L = new Float32Array(n), R = new Float32Array(n);
      const ctx = { sampleRate: sr, blockSize: 128, tempo: 130, ppq: 96, playing: false, pos: 0, songMode: false, track: o.track ?? 1, out };
      inst.render!(L, R, n, ctx);
      return { L, R };
    },
  };
  const notes = new Map<number, GenNote>();
  inst.setParams(d.params);
  void pcm;
  return d;
}
