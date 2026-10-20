// Newtime's edit model: warp markers (source position -> output position),
// marker types (warp, downbeat, groove, shift), the Groove and Shift knobs,
// groove templates, quantising, marker detection and the renderer.
//
// Output positions are in samples of the sample's own tempo; with tempo-sync
// the whole output is scaled by sampleTempo / projectTempo. The sample start
// and end are fixed anchors; moving a marker stretches the audio on both
// sides of it (WSOLA, see wsola.ts).

import { monoMix } from './util';
import { beatPositions, detectTransients, estimateTempo, onsetEnvelope } from './onsets';
import { warpAudio } from './wsola';

export const MK_WARP = 0;
export const MK_DOWNBEAT = 1;
export const MK_GROOVE = 2;
export const MK_SHIFT = 3;

export interface NtmMarker {
  id: number;
  /** Source position (samples). */
  src: number;
  /** Output position (samples at the sample tempo). */
  dst: number;
  type: number;
  /** Groove markers: the groove template position (output samples). */
  g?: number;
}

export interface TimeKnobs {
  /** Groove knob -16384..16384. */
  groove: number;
  /** Shift knob -16384..16384 (full scale = half a beat). */
  shift: number;
}

/** Snap divisions per beat for FL's Snap menu (0 = off). */
export const SNAP_OPTIONS: { label: string; div: number }[] = [
  { label: 'Beat', div: 1 }, { label: '1/2 beat', div: 2 }, { label: '1/3 beat', div: 3 }, { label: '1/4 beat', div: 4 },
  { label: '1/6 beat', div: 6 }, { label: '1/8 beat', div: 8 }, { label: 'Off', div: 0 },
];

export function beatLen(bpm: number, sr: number): number {
  return (60 / Math.max(10, bpm)) * sr;
}

/** Bar grid origin: the downbeat marker's output position (else 0). */
export function gridOrigin(markers: readonly NtmMarker[], bpm: number, sr: number): number {
  const d = markers.find((m) => m.type === MK_DOWNBEAT);
  if (!d) return 0;
  const bar = 4 * beatLen(bpm, sr);
  return ((d.dst % bar) + bar) % bar;
}

/** Snap an output position to the grid (div per beat; 0 = no snap). */
export function snapPos(pos: number, div: number, bpm: number, sr: number, origin = 0): number {
  if (!div) return pos;
  const step = beatLen(bpm, sr) / div;
  return origin + Math.round((pos - origin) / step) * step;
}

/** Effective output position of a marker with the knobs applied. */
export function markerPos(m: NtmMarker, k: TimeKnobs, bpm: number, sr: number): number {
  if (m.type === MK_GROOVE && m.g !== undefined) return m.dst + (k.groove / 16384) * (m.g - m.dst);
  if (m.type === MK_SHIFT) return m.dst + (k.shift / 16384) * 0.5 * beatLen(bpm, sr);
  return m.dst;
}

/** Warp anchors: start, markers (sorted by source position, kept monotonic), end. */
export function timeAnchors(markers: readonly NtmMarker[], k: TimeKnobs, srcLen: number, bpm: number, sr: number): { src: number; dst: number }[] {
  const ms = markers.filter((m) => m.src > 0 && m.src < srcLen).slice().sort((a, b) => a.src - b.src);
  const out: { src: number; dst: number }[] = [{ src: 0, dst: 0 }];
  const minGap = 0.002 * sr;
  for (let i = 0; i < ms.length; i++) {
    const prev = out[out.length - 1];
    let d = markerPos(ms[i], k, bpm, sr);
    // leave room for the remaining markers before the end
    const room = srcLen - minGap * (ms.length - i);
    d = Math.max(prev.dst + minGap, Math.min(room, d));
    if (ms[i].src - prev.src < 1) continue;
    out.push({ src: ms[i].src, dst: d });
  }
  out.push({ src: srcLen, dst: Math.max(out[out.length - 1].dst + minGap, srcLen) });
  return out;
}

export interface TimeAnalysis {
  bpm: number;
  markers: NtmMarker[];
}

/** Marker detection: 0 = transients, 1 = tempo (beats), 2 = none. */
export function analyzeTime(ch: Float32Array[], sr: number, mode: number, bpmIn = 0): TimeAnalysis {
  const mono = monoMix(ch);
  const len = mono.length;
  const env = onsetEnvelope(mono, sr);
  const bpm = bpmIn > 0 ? bpmIn : estimateTempo(env, sr, len / sr);
  const edge = Math.round(0.005 * sr);
  let pos: number[] = [];
  if (mode === 0) pos = detectTransients(mono, sr, {}, env);
  else if (mode === 1) {
    const tr = detectTransients(mono, sr, {}, env);
    const tol = 0.03 * sr;
    pos = beatPositions(env, sr, bpm, len).map((b) => {
      let best = b, bd = tol;
      for (const t of tr) { const dd = Math.abs(t - b); if (dd < bd) { bd = dd; best = t; } }
      return best;
    });
  }
  const markers: NtmMarker[] = [];
  let id = 1;
  for (const p of pos) {
    if (p < edge || p > len - edge) continue;
    if (markers.length && p - markers[markers.length - 1].src < edge) continue;
    markers.push({ id: id++, src: p, dst: p, type: MK_WARP });
  }
  return { bpm, markers };
}

/** Quantise marker output positions to the grid. */
export function quantize(markers: readonly NtmMarker[], div: number, bpm: number, sr: number, only?: Set<number>): NtmMarker[] {
  const o = gridOrigin(markers, bpm, sr);
  const d = div || 4;
  return markers.map((m) => (only && !only.has(m.id) ? m : { ...m, dst: snapPos(m.dst, d, bpm, sr, m.type === MK_DOWNBEAT ? 0 : o) }));
}

// ------------------------------------------------------------ grooves
export interface GroovePattern {
  name: string;
  beats: number;
  /** Positions in beats within one bar. */
  pos: number[];
}

const sixteenths = (swing: number): number[] => {
  const p: number[] = [];
  for (let b = 0; b < 4; b++) for (let s = 0; s < 4; s++) p.push(b + s * 0.25 + (s % 2 ? swing : 0));
  return p;
};
const eighths = (swing: number): number[] => {
  const p: number[] = [];
  for (let b = 0; b < 4; b++) { p.push(b); p.push(b + 0.5 + swing); }
  return p;
};

/** Built-in groove patterns (the Load menu). */
export const GROOVES: GroovePattern[] = [
  { name: 'Straight 1/16', beats: 4, pos: sixteenths(0) },
  { name: 'Swing 1/16 54%', beats: 4, pos: sixteenths(0.02) },
  { name: 'Swing 1/16 58%', beats: 4, pos: sixteenths(0.04) },
  { name: 'Swing 1/16 62%', beats: 4, pos: sixteenths(0.06) },
  { name: 'Swing 1/16 66%', beats: 4, pos: sixteenths(1 / 12) },
  { name: 'Swing 1/8 58%', beats: 4, pos: eighths(0.08) },
  { name: 'Swing 1/8 66%', beats: 4, pos: eighths(1 / 6) },
  { name: 'Push 1/16', beats: 4, pos: sixteenths(-0.04) },
  { name: 'Laid back 1/16', beats: 4, pos: sixteenths(0).map((p, i) => p + (i % 4 === 0 ? 0 : 0.03)) },
];

/**
 * Apply a groove: warp markers within 1/4 beat of a template position become
 * groove markers that the Groove knob moves toward that position.
 */
export function applyGroove(markers: readonly NtmMarker[], g: GroovePattern, bpm: number, sr: number): NtmMarker[] {
  const bl = beatLen(bpm, sr);
  const o = gridOrigin(markers, bpm, sr);
  const barB = g.beats || 4;
  return markers.map((m) => {
    if (m.type === MK_DOWNBEAT) return m;
    const b = (m.dst - o) / bl;
    const bar = Math.floor(b / barB);
    let best = NaN, bd = 0.25;
    for (const p of g.pos) {
      for (const k of [bar - 1, bar, bar + 1]) {
        const t = k * barB + p;
        const dd = Math.abs(t - b);
        if (dd < bd) { bd = dd; best = t; }
      }
    }
    if (Number.isFinite(best)) return { ...m, type: MK_GROOVE, g: o + best * bl };
    return m.type === MK_GROOVE ? { ...m, type: MK_WARP, g: undefined } : m;
  });
}

/** A groove pattern from the markers in the first bar (Save groove pattern). */
export function grooveFromMarkers(markers: readonly NtmMarker[], bpm: number, sr: number, name: string): GroovePattern {
  const bl = beatLen(bpm, sr);
  const o = gridOrigin(markers, bpm, sr);
  const pos = markers.map((m) => (m.dst - o) / bl).filter((b) => b >= 0 && b < 4).sort((a, b) => a - b);
  return { name, beats: 4, pos: pos.map((p) => Math.round(p * 10000) / 10000) };
}

export function parseGroove(text: string, name: string): GroovePattern | null {
  try {
    const j = JSON.parse(text) as Partial<GroovePattern>;
    if (!Array.isArray(j.pos)) return null;
    const pos = j.pos.filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
    return { name: typeof j.name === 'string' ? j.name : name, beats: typeof j.beats === 'number' && j.beats > 0 ? j.beats : 4, pos };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ render
/** Output length (samples) with tempo-sync applied. */
export function timeOutLen(srcLen: number, bpm: number, sync: boolean, projectTempo: number): number {
  const ratio = sync && bpm > 0 && projectTempo > 0 ? bpm / projectTempo : 1;
  return Math.max(1, Math.round(srcLen * ratio));
}

export function renderTime(ch: Float32Array[], sr: number, markers: readonly NtmMarker[], k: TimeKnobs, bpm: number, sync: boolean, projectTempo: number): Float32Array[] {
  const srcLen = ch[0]?.length ?? 0;
  if (!srcLen) return ch.map(() => new Float32Array(0));
  const ratio = sync && bpm > 0 && projectTempo > 0 ? bpm / projectTempo : 1;
  const anchors = timeAnchors(markers, k, srcLen, bpm, sr).map((a) => ({ src: a.src, dst: a.dst * ratio }));
  const outLen = timeOutLen(srcLen, bpm, sync, projectTempo);
  anchors[anchors.length - 1].dst = outLen;
  const identity = anchors.every((a) => Math.abs(a.dst - a.src) < 0.5);
  if (identity) return ch.map((c) => Float32Array.from(c));
  return warpAudio(ch, sr, anchors, outLen);
}

/** Edit fingerprint input for Newtime. */
export function timeEditKey(sampleId: string, markers: readonly NtmMarker[], k: TimeKnobs, bpm: number, sync: boolean, projectTempo: number): string {
  return JSON.stringify([sampleId, markers, k.groove, k.shift, bpm, sync, sync ? projectTempo : 0]);
}
