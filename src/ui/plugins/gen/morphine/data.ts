// Morphine editor data helpers: the state's program structure (model/gen/
// plugins/morphine/state.ts), its spectra rows in the sample pool, the editor's
// view state and undoable structure edits.

import { useEffect, useState } from 'react';
import * as A from '../../../../store/actions';
import { getRaw, onSamplesChanged } from '../../../../audio/samples';
import { NP, type MBp, type MEnv, type MGen, type MMod, type MMorph, type MZone } from '../../../../model/gen/plugins/morphine/state';
import { bpSpectrum, zoneCurves, type RowSource } from '../../../../model/gen/plugins/morphine/mrp';

export interface MView {
  /** Page: 0 morphing, 1 modulation, 2..5 generator A..D (FL's page column order). */
  page: number;
  /** Selected breakpoint per generator. */
  bp: number[];
  /** Partial view: 0 amplitude, 1 panning, 2 detune, 3 velocity, 4 window. */
  view: number;
  /** Drawing tool (FL's TOOL menu). */
  tool: number;
  /** Selected envelope 0..3. */
  env: number;
}

export function viewOf(p: Record<string, unknown>): MView {
  const v = (p.mView && typeof p.mView === 'object' ? p.mView : {}) as Partial<MView>;
  const bp = Array.isArray(v.bp) ? v.bp.slice(0, 4).map((x) => Math.max(0, Math.trunc(Number(x) || 0))) : [];
  while (bp.length < 4) bp.push(0);
  const n = (x: unknown, d: number, hi: number) => Math.max(0, Math.min(hi, Math.trunc(Number(x ?? d)) || 0));
  return { page: n(v.page, 2, 5), bp, view: n(v.view, 0, 4), tool: n(v.tool, 0, 9), env: n(v.env, 0, 3) };
}

/** Write view state (no undo step). */
export function setView(slotId: string, patch: Partial<MView>): void {
  A.setFxStateNoHistory(slotId, 'View', (d) => {
    const cur = viewOf(d as Record<string, unknown>);
    d.mView = { ...cur, ...patch };
  });
}

export const gensOf = (p: Record<string, unknown>): MGen[] => (Array.isArray(p.gens) ? (p.gens as MGen[]) : []);
export const morphOf = (p: Record<string, unknown>): MMorph => (p.morph as MMorph) ?? { pts: [[0, 1, 100]], ls: 100, le: 110, lm: 0, solo: 0 };
export const envsOf = (p: Record<string, unknown>): MEnv[] => (Array.isArray(p.envs) ? (p.envs as MEnv[]) : []);
export const modOf = (p: Record<string, unknown>): MMod => (p.mod as MMod) ?? { src: new Array(12).fill(0), dst: new Array(12).fill(0), amt: new Array(12).fill(0.5) };

/** Re-render when the sample pool changes (imported spectra / noise arrive). */
export function usePoolVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => onSamplesChanged(() => setV((x) => x + 1)), []);
  return v;
}

/** The state's spectra rows (spectraSample in the pool: rows of 128 floats). */
export function rowsOf(p: Record<string, unknown>): RowSource {
  const id = typeof p.spectraSample === 'string' ? p.spectraSample : '';
  const d = id ? getRaw(id)?.channels[0] : undefined;
  if (!d) return null;
  return (r) => ((r + 1) * NP <= d.length ? d.subarray(r * NP, (r + 1) * NP) : null);
}

/** A breakpoint's [amp, pan, detune] as the engine plays it. */
export function spectrumOf(p: Record<string, unknown>, g: number, bp: MBp): [Float32Array, Float32Array, Float32Array] {
  const out: [Float32Array, Float32Array, Float32Array] = [new Float32Array(NP), new Float32Array(NP), new Float32Array(NP)];
  bpSpectrum(bp, g, p.spectraMissing === 1, rowsOf(p), out);
  return out;
}

/** A zone's velocity / window curves. */
export function curvesOf(p: Record<string, unknown>, z: MZone): [Float32Array, Float32Array] {
  const ca = new Float32Array(NP), cb = new Float32Array(NP);
  zoneCurves(z, rowsOf(p), ca, cb);
  return [ca, cb];
}

/** The current zone of generator g and its selected breakpoint index (clamped). */
export function currentOf(p: Record<string, unknown>, g: number, view: MView): { gen: MGen; zone: MZone; zi: number; bi: number } | null {
  const gen = gensOf(p)[g];
  if (!gen) return null;
  const zi = Math.min(gen.cz, gen.zones.length - 1);
  const zone = gen.zones[zi];
  const bi = Math.min(view.bp[g] ?? 0, zone.bp.length - 1);
  return { gen, zone, zi, bi };
}

/** Undoable edit of generator g's current zone (the recipe mutates the zone draft). */
export function editZone(slotId: string, label: string, g: number, fn: (z: MZone) => void): void {
  A.editFx(slotId, label, (d) => {
    const gen = (d.gens as MGen[] | undefined)?.[g];
    if (!gen) return;
    fn(gen.zones[Math.min(gen.cz, gen.zones.length - 1)]);
  });
}

/** Undoable edit of the whole state draft (edits sharing `mergeKey` within 1.5 s form one undo step). */
export function editState(slotId: string, label: string, fn: (d: Record<string, unknown>) => void, mergeKey?: string): void {
  A.editFx(slotId, label, (d) => { fn(d as Record<string, unknown>); }, mergeKey);
}

/** Total time of a point list (sum of the durations to the next point). */
export function startsOf(durations: number[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const d of durations) { out.push(t); t += d; }
  out.push(t);
  return out;
}
