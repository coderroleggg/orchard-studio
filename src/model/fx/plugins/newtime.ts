// Newtime (FL: Newtime): time warping of a loaded sample, an offline editor
// living in a mixer slot. FL's editor panel is 727 x 582 (88 px toolbar +
// waveform with warp markers). FL exposes one automatable parameter, the
// Play / pause button (Tag 0, 0..1, empty value text; the binary reports
// "Space lay / pause", from the hint '|^b^a^^Space ^Play / pause').
//
// Editor state saved with the slot: the source sample, the warp markers
// (source position -> output position; types warp, downbeat, groove, shift),
// the sample tempo and tempo-sync, the Groove and Shift wheels (FL's form:
// -16384..16384, default 0), the groove pattern name, marker detection mode,
// snap, the rendered result (a pool sample the DSP plays) and the transport.
// The DSP plays the render while Play is on and passes the live input through.

import type { FxPluginDef } from '../types';
import type { SampleInfo } from '../../types';

/** Engine sample id prefix of a Newtime render. */
export const NTM_SAMPLE_PREFIX = 'newtime:';

export const NTM_KNOB_MAX = 16384;

export interface NewtimeState {
  play: number;
  sample: SampleInfo | null;
  /** True once markers were detected for the sample (render enabled). */
  analyzed: boolean;
  markers: unknown[];
  nextId: number;
  /** Sample tempo (BPM) and tempo-sync to the project tempo. */
  bpm: number;
  sync: boolean;
  groove: number;
  shift: number;
  grooveName: string;
  out: { id: string; hash: string; frames: number; sr: number } | null;
  loop: boolean;
  slave: boolean;
  autoScroll: boolean;
  pstart: number;
  pend: number;
  seek: number;
  /** Snap divisions per beat (0 = off). */
  snap: number;
  /** Marker detection: 0 transient, 1 tempo, 2 none. */
  detect: number;
  ignoreHostSel: boolean;
  ignoreOwnSel: boolean;
  ignoreSpace: boolean;
  projTempoOnLoad: boolean;
}

/** Knob text: percent of full scale, signed. */
export const knobText = (v: number) => `${v > 0 ? '+' : ''}${Math.round((v / NTM_KNOB_MAX) * 100)}%`;

export function newtimeState(): NewtimeState {
  return {
    play: 0, sample: null, analyzed: false, markers: [], nextId: 1, bpm: 120, sync: false,
    groove: 0, shift: 0, grooveName: '', out: null, loop: false, slave: false, autoScroll: true,
    pstart: 0, pend: 0, seek: 0, snap: 4, detect: 0,
    ignoreHostSel: false, ignoreOwnSel: false, ignoreSpace: false, projTempoOnLoad: false,
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const def: FxPluginDef = {
  id: 'newtime',
  name: 'Newtime',
  category: 'Misc',
  width: 727,
  height: 582,
  description: 'Time warping of a sample with warp markers',
  params: [
    { key: 'play', name: 'Play / pause', index: 0, min: 0, max: 1, def: 0, format: () => '' },
  ],
  state: () => {
    const s = newtimeState() as unknown as Record<string, unknown>;
    delete s.play;
    return s;
  },
  normalize: (p) => {
    const d = newtimeState() as unknown as Record<string, unknown>;
    const o: Record<string, unknown> = { ...d, ...p };
    for (const k of ['play', 'nextId', 'bpm', 'groove', 'shift', 'pstart', 'pend', 'seek', 'snap', 'detect']) if (!isNum(o[k])) o[k] = d[k];
    o.groove = Math.min(NTM_KNOB_MAX, Math.max(-NTM_KNOB_MAX, o.groove as number));
    o.shift = Math.min(NTM_KNOB_MAX, Math.max(-NTM_KNOB_MAX, o.shift as number));
    if (!((o.bpm as number) > 0)) o.bpm = 120;
    if (!Array.isArray(o.markers)) o.markers = [];
    const sm = o.sample as SampleInfo | null;
    if (!(sm && typeof sm === 'object' && typeof sm.id === 'string')) { o.sample = null; o.markers = []; o.analyzed = false; }
    const out = o.out as { id?: unknown } | null;
    if (!(out && typeof out === 'object' && typeof out.id === 'string')) o.out = null;
    if (typeof o.grooveName !== 'string') o.grooveName = '';
    for (const k of ['analyzed', 'sync', 'loop', 'slave', 'autoScroll', 'ignoreHostSel', 'ignoreOwnSel', 'ignoreSpace', 'projTempoOnLoad']) o[k] = !!o[k];
    return o;
  },
};
