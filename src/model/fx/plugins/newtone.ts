// Newtone (FL: Newtone): pitch correction and time editing of a loaded
// sample, an offline editor living in a mixer slot. FL's editor panel is
// 727 x 582 (88 px toolbar + piano roll). FL exposes one automatable
// parameter, the Play / pause button (Tag 0, 0..1, empty value text; the
// binary reports its name as "Space lay / pause", a hint-parsing quirk of
// '|^b^a^^Space ^Play / pause').
//
// Everything else is editor state saved with the slot: the source sample
// (project sample pool), the analysis (pitch / level tracks, base64), the
// notes and their edits, the Center / Variation / Transition wheels (FL's
// form: 0..8192 default 0, 0..16384 default 8192 = 100 %, 0..16384 at
// 16384), the rendered result (a pool sample the DSP plays), the transport
// (loop, play region, slave) and the editor modes. The DSP plays the render
// while Play is on and always passes the live input through.

import type { FxPluginDef } from '../types';
import type { SampleInfo } from '../../types';

/** Engine sample id prefix of a Newtone render. */
export const NT_SAMPLE_PREFIX = 'newtone:';

export interface NtRenderRef {
  /** Pool sample id of the render. */
  id: string;
  /** Edit fingerprint the render was made from. */
  hash: string;
  frames: number;
  sr: number;
}

export interface NewtoneState {
  play: number;
  sample: SampleInfo | null;
  /** Analysis (see engine/effects/plugins/newtools/tonemodel.ts NtAnalysis). */
  an: unknown;
  notes: unknown[];
  nextId: number;
  center: number;
  vari: number;
  trans: number;
  out: NtRenderRef | null;
  loop: boolean;
  slave: boolean;
  autoScroll: boolean;
  /** Play region (render samples; pend 0 = to the end) and seek counter. */
  pstart: number;
  pend: number;
  seek: number;
  snapScale: boolean;
  /** Scale: 0..11 major on C..B, 12..23 minor on C..B. */
  scale: number;
  /** Snap to grid divisions per beat (0 = off). */
  snap: number;
  /** Sample tempo (0 = unknown) and tempo-sync to the project. */
  bpm: number;
  sync: boolean;
  cutMode: boolean;
  /** Advanced edit button and kind (0 = pitch, 1 = vibrato). */
  adv: boolean;
  advKind: number;
  ignoreHostSel: boolean;
  ignoreOwnSel: boolean;
  ignoreSpace: boolean;
  projTempoOnLoad: boolean;
}

export const NT_CENTER_MAX = 8192;
export const NT_VARI_MAX = 16384;
export const NT_TRANS_MAX = 16384;

const pct = (v: number, full: number) => `${Math.round((v / full) * 100)}%`;
export const centerText = (v: number) => pct(v, NT_CENTER_MAX);
export const variText = (v: number) => pct(v, NT_VARI_MAX / 2);
export const transText = (v: number) => pct(v, NT_TRANS_MAX);

export function newtoneState(): NewtoneState {
  return {
    play: 0, sample: null, an: null, notes: [], nextId: 1,
    center: 0, vari: 8192, trans: 16384, out: null,
    loop: false, slave: false, autoScroll: true, pstart: 0, pend: 0, seek: 0,
    snapScale: false, scale: 0, snap: 4, bpm: 0, sync: false,
    cutMode: false, adv: false, advKind: 0,
    ignoreHostSel: false, ignoreOwnSel: false, ignoreSpace: false, projTempoOnLoad: false,
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const def: FxPluginDef = {
  id: 'newtone',
  name: 'Newtone',
  category: 'Misc',
  width: 727,
  height: 582,
  description: 'Pitch correction and time editing of a sample',
  params: [
    { key: 'play', name: 'Play / pause', index: 0, min: 0, max: 1, def: 0, format: () => '' },
  ],
  state: () => {
    const s = newtoneState() as unknown as Record<string, unknown>;
    delete s.play;
    return s;
  },
  normalize: (p) => {
    const d = newtoneState() as unknown as Record<string, unknown>;
    const o: Record<string, unknown> = { ...d, ...p };
    for (const k of ['play', 'nextId', 'center', 'vari', 'trans', 'pstart', 'pend', 'seek', 'scale', 'snap', 'bpm', 'advKind']) if (!isNum(o[k])) o[k] = d[k];
    o.center = Math.min(NT_CENTER_MAX, Math.max(0, o.center as number));
    o.vari = Math.min(NT_VARI_MAX, Math.max(0, o.vari as number));
    o.trans = Math.min(NT_TRANS_MAX, Math.max(0, o.trans as number));
    if (!Array.isArray(o.notes)) o.notes = [];
    const sm = o.sample as SampleInfo | null;
    if (!(sm && typeof sm === 'object' && typeof sm.id === 'string')) { o.sample = null; o.an = null; o.notes = []; }
    const out = o.out as NtRenderRef | null;
    if (!(out && typeof out === 'object' && typeof out.id === 'string')) o.out = null;
    for (const k of ['loop', 'slave', 'autoScroll', 'snapScale', 'sync', 'cutMode', 'adv', 'ignoreHostSel', 'ignoreOwnSel', 'ignoreSpace', 'projTempoOnLoad']) o[k] = !!o[k];
    return o;
  },
};
