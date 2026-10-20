// Job messages shared by the Newtone / Newtime worker and its inline
// fallback (no DOM, no store: also loaded inside the worker).

import type { AnalysisResult, NtAnalysis, NtNote, ToneKnobs } from '../../../../engine/effects/plugins/newtools/tonemodel';
import type { NtmMarker, TimeAnalysis, TimeKnobs } from '../../../../engine/effects/plugins/newtools/timemodel';

export type JobReq =
  | { kind: 'analyzeTone' }
  | { kind: 'renderTone'; an: NtAnalysis; notes: NtNote[]; knobs: ToneKnobs; ratio: number }
  | { kind: 'analyzeTime'; mode: number; bpm: number }
  | { kind: 'renderTime'; markers: NtmMarker[]; knobs: TimeKnobs; bpm: number; sync: boolean; tempo: number };

export type JobMsg = JobReq & { id: number; src: string; sr: number; ch?: Float32Array[] };

export interface JobFns {
  analyzeToneGen: (ch: Float32Array[], sr: number) => Generator<number, AnalysisResult, void>;
  renderToneGen: (ch: Float32Array[], an: NtAnalysis, notes: readonly NtNote[], k: ToneKnobs, ratio?: number) => Generator<number, Float32Array[], void>;
  analyzeTime: (ch: Float32Array[], sr: number, mode: number, bpm?: number) => TimeAnalysis;
  renderTime: (ch: Float32Array[], sr: number, markers: readonly NtmMarker[], k: TimeKnobs, bpm: number, sync: boolean, tempo: number) => Float32Array[];
}

function drive<T>(g: Generator<number, T, void>, progress: (p: number) => void): T {
  let last = -1;
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    if (r.value - last >= 0.05) { last = r.value; progress(r.value); }
  }
}

export function execJob(m: JobMsg, ch: Float32Array[], f: JobFns, progress: (p: number) => void): unknown {
  switch (m.kind) {
    case 'analyzeTone': return drive(f.analyzeToneGen(ch, m.sr), progress);
    case 'renderTone': return drive(f.renderToneGen(ch, m.an, m.notes, m.knobs, m.ratio), progress);
    case 'analyzeTime': return f.analyzeTime(ch, m.sr, m.mode, m.bpm);
    case 'renderTime': return f.renderTime(ch, m.sr, m.markers, m.knobs, m.bpm, m.sync, m.tempo);
  }
}
