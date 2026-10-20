// Display model of a Newtone slot: the decoded analysis, the change curves,
// the output time map (with tempo-sync) and helpers mapping source samples,
// output samples and seconds. Built once per state change.

import {
  decodeAnalysis, noteCenter, outputPitch, sortedNotes, toneCurves, toneTimeMap,
  type DecodedAnalysis, type NtAnalysis, type NtNote, type ToneCurves, type ToneKnobs,
} from '../../../../engine/effects/plugins/newtools/tonemodel';
import type { TimeMap } from '../../../../engine/effects/plugins/newtools/psola';
import { KW, RH, RULER, RW, SB, type View } from './roll';

export interface ToneModel {
  sr: number;
  hop: number;
  d: DecodedAnalysis | null;
  notes: NtNote[];
  knobs: ToneKnobs;
  curves: ToneCurves | null;
  outCents: Float32Array | null;
  map: TimeMap | null;
  /** Output length (unscaled output samples) and the tempo-sync ratio. */
  outLen: number;
  ratio: number;
  srcLen: number;
  /** Loudest frame level (dB). */
  peakDb: number;
  /** Output seconds of an (unscaled) output sample position, and back. */
  sec(dst: number): number;
  dst(sec: number): number;
  /** Output position of a source position, and back. */
  dstOfSrc(src: number): number;
  srcOfDst(dst: number): number;
  center(n: NtNote): number;
  /** Total output duration (seconds). */
  dur: number;
}

export function buildModel(an: NtAnalysis | null, notesIn: readonly NtNote[], knobs: ToneKnobs, srcLen: number, ratio: number): ToneModel {
  const d = an ? decodeAnalysis(an) : null;
  const sr = d?.sr ?? 44100;
  const hop = d?.hop ?? 220;
  const notes = sortedNotes(notesIn);
  const len = srcLen > 0 ? srcLen : d ? d.cents.length * hop : 0;
  const curves = d ? toneCurves(d, notes, knobs) : null;
  const outCents = d && curves ? outputPitch(d, curves) : null;
  const tm = d ? toneTimeMap(notes, len) : null;
  let peakDb = -120;
  if (d) for (let i = 0; i < d.db.length; i++) if (d.db[i] > peakDb) peakDb = d.db[i];
  const r = ratio > 0 ? ratio : 1;
  const m: ToneModel = {
    sr, hop, d, notes, knobs, curves, outCents, map: tm?.map ?? null, outLen: tm?.outLen ?? len, ratio: r, srcLen: len, peakDb,
    sec: (dst) => (dst * r) / sr,
    dst: (sec) => (sec * sr) / r,
    dstOfSrc: (src) => (tm ? tm.map.dstAt(src) : src),
    srcOfDst: (dst) => (tm ? tm.map.srcAt(dst) : dst),
    center: (n) => noteCenter(n, knobs),
    dur: ((tm?.outLen ?? len) * r) / sr,
  };
  return m;
}

const GW = RW - SB - KW, GH = RH - SB - RULER;

/** Zoom to show the whole sample and the pitch range of its notes. */
export function fitView(m: ToneModel): View {
  const pps = GW / Math.max(0.25, m.dur * 1.03);
  const live = m.notes.filter((n) => !n.del);
  let lo = 60, hi = 72;
  if (live.length) {
    lo = Infinity; hi = -Infinity;
    for (const n of live) { const c = m.center(n) / 100; lo = Math.min(lo, c); hi = Math.max(hi, c); }
  }
  const span = hi - lo + 7;
  const rowH = Math.max(6, Math.min(30, GH / span));
  const rows = GH / rowH;
  const top = Math.min(127.5, (lo + hi) / 2 + rows / 2);
  return { t0: 0, pps, top, rowH };
}
