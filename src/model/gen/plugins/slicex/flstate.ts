// FL Slicex state blobs (SaveRestoreState 0x73450, versions up to 0x00060003: FL's .fst presets,
// project states) to Orchard's Slicex state. Used to import the user's own FL presets and by the
// tests (FL's saved states after loading test audio). The decks' embedded WAVs are returned as bytes
// for the caller to put in the sample pool: Orchard never ships them.
//
// Layout: int32 version; int32 x 8 master parameters; the option block (47 bytes, 46 before
// version 2); 12 editor bytes; per deck: u8 "audio left on disk" (version > 1), the file name
// (u8 length / 0xff + int32, UTF-8), unless left on disk int32 size + the WAV, 76 view bytes, the
// 4 mixdown envelopes, int32 count + 68-byte region records; per articulator: 20 header bytes and
// 6 targets (int32 3, base / envelope / LFO amount floats, envelope, LFO, 4 maps).

import type { FxParams } from '../../../fx/types';
import { defaultArt, defaultRegion, settingsFromRaw } from './defaults';
import { sxFieldKey, sxHdrKey } from './params';
import type { SxArt, SxCurve, SxDeck, SxRegion, SxTarget } from './types';
import { parseSxWav } from './wav';

class Rd {
  p = 0;
  readonly dv: DataView;
  constructor(readonly b: Uint8Array) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  need(n: number): void { if (this.p + n > this.b.length) throw new Error('truncated Slicex state'); }
  i32(): number { this.need(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  f32(): number { this.need(4); const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  f64(): number { this.need(8); const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  u8(): number { this.need(1); return this.b[this.p++]; }
  bytes(n: number): Uint8Array { this.need(n); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  str(): string {
    let n = this.u8();
    if (n === 0xff) n = this.i32();
    const s = this.bytes(n);
    try { return new TextDecoder().decode(s); } catch { return ''; }
  }
}

function curve(r: Rd, kind: 'env' | 'lfo' | 'map' | 'other'): SxCurve {
  const t = r.i32(), ver = r.i32();
  if (ver !== 3) throw new Error(`unsupported curve version ${ver}`);
  const n = r.i32();
  if (n < 0 || n > 100000) throw new Error('bad curve');
  const p: number[][] = [];
  for (let i = 0; i < n; i++) {
    const dx = r.f64(), y = r.f64(), ten = r.f32();
    const b = r.bytes(4);
    p.push([dx, y, ten, b[0], b[1], b[2], b[3]]);
  }
  const m = [r.i32(), r.i32(), r.i32(), r.i32(), r.i32()];
  const c: SxCurve = { t, p, m };
  if (kind === 'env') c.a = [r.i32(), r.i32(), r.i32(), r.i32()];
  if (kind === 'lfo') { c.l = [r.i32(), r.i32(), r.i32(), r.i32()]; c.ph = r.i32() >>> 0; }
  return c;
}

function target(r: Rd): SxTarget {
  if (r.i32() !== 3) throw new Error('unsupported articulator version');
  const b = r.f32(), ea = r.f32(), la = r.f32();
  const env = curve(r, 'env'), lfo = curve(r, 'lfo');
  const maps = [curve(r, 'map'), curve(r, 'map'), curve(r, 'map'), curve(r, 'map')];
  return { b, ea, la, env, lfo, maps };
}

export interface FlSlicexState {
  /** Orchard state fields (parameters by key, decks, arts, opt; sample ids left null). */
  state: FxParams;
  /** The decks' embedded WAVs (null when absent or left on disk) and file names. */
  wavs: (Uint8Array | null)[];
  files: string[];
}

/** Decode an FL Slicex state blob. Throws on malformed data. */
export function decodeFlSlicex(blob: Uint8Array): FlSlicexState {
  const r = new Rd(blob);
  let ver = r.i32();
  if (ver > 0x00060003 || ver < 0) throw new Error('unknown Slicex state version');
  if (ver >= 0x10000) ver = (ver >>> 16) & 0xffff;
  const master = Array.from({ length: 8 }, () => r.i32());
  const raw = Array.from(r.bytes(ver <= 1 ? 46 : 47));
  while (raw.length < 47) raw.push(0);
  r.bytes(12);
  const decks: SxDeck[] = [];
  const wavs: (Uint8Array | null)[] = [];
  const files: string[] = [];
  for (let d = 0; d < 2; d++) {
    const onDisk = ver > 1 ? r.u8() : 0;
    const file = onDisk || ver >= 3 ? r.str() : '';
    let wav: Uint8Array | null = null;
    if (!onDisk) {
      const n = r.i32();
      if (n > 0) wav = r.bytes(n).slice();
    }
    r.bytes(76);
    for (let k = 0; k < 4; k++) curve(r, 'other');
    const n = r.i32();
    const recs: number[][] = [];
    for (let i = 0; i < n; i++) recs.push(Array.from({ length: 17 }, () => r.i32()));
    const parsed = wav ? parseSxWav(wav) : null;
    const regions: SxRegion[] = (parsed?.regions ?? []).map((wr, i) => {
      const rec = recs[i];
      const rg: SxRegion = { ...defaultRegion(wr.s, wr.e), name: wr.name, info: wr.info, pur: wr.pur, note: wr.note };
      if (rec) {
        [rg.cut, rg.out, rg.pan, rg.vol, rg.aArt, rg.aAmt, rg.fc, rg.fr, rg.fArt, rg.fAmt, rg.pitch, rg.sArt, rg.sAmt, rg.delay, rg.ofs, rg.oArt, rg.oAmt] = rec;
      }
      return rg;
    });
    decks.push({ title: parsed?.title ?? '', file, tempo: parsed?.tempo ?? 0, beats: parsed?.beats ?? 0, regions });
    wavs.push(wav && parsed && parsed.channels[0].length > 0 ? wav : null);
    files.push(file);
  }
  const arts: SxArt[] = [];
  const params: Record<string, number> = {
    play: master[0], livesel: master[1], master: master[2], rand: master[3], lfo: master[4], pitch: master[5], modx: master[6], mody: master[7],
  };
  for (let g = 0; g < 8; g++) {
    const h = r.bytes(20);
    const hv = new DataView(h.buffer, h.byteOffset, 20);
    const a: SxArt = { ...defaultArt(), ft: h[12], fb: [h[13], h[14], h[15]], fo: hv.getInt32(16, true), t: [] };
    for (let i = 0; i < 3; i++) params[sxHdrKey(g, i)] = hv.getInt32(4 * i, true);
    for (let t = 0; t < 6; t++) {
      const tg = target(r);
      a.t.push(tg);
      if (t < 5) {
        for (let f = 0; f < 4; f++) params[sxFieldKey(g, t, f)] = tg.env.a?.[f] ?? 0;
        for (let f = 0; f < 4; f++) params[sxFieldKey(g, t, 4 + f)] = tg.lfo.l?.[f] ?? 0;
      }
    }
    arts.push(a);
  }
  const state: FxParams = { ...params, deckA: decks[0], deckB: decks[1], arts, opt: settingsFromRaw(raw), sampleA: null, sampleB: null };
  return { state, wavs, files };
}
