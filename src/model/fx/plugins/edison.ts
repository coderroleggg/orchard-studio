// Edison (FL: Edison): the audio recorder / wave editor that lives in a mixer
// slot. Form: SynthPanel 744 x 487. FL exposes three automatable parameters
// (flfxhost: 0 "Play / pause", 1 "Record", 2 "Live selection", all 0..1 with
// an empty value text); everything else is plugin state.
//
// The edited audio is never stored in the slot state: it is a sample in the
// project's sample pool (`sample` holds its id; the engine finds it with
// env.sample(ED_PREFIX + id)). Edison's undo history is a list of pool sample
// ids with the regions / loop points of each step (`hist`, `hpos`). The
// transport talks to the DSP through `cmd` (a numbered command), `scrub`
// (the scrub target) and the Play / Record parameters (rising and falling
// edges, so automation works as in FL).
//
// Defaults from FL's own state blob (flfxhost --save-state, state version 13):
// record mode "On input", duration "5 minutes", Append off, Slave playback off,
// key link "Auto", gate threshold 0.02. The duration combo lists FL's items
// without its separators (value 2 = "3 minutes", as the "3 min audio logger"
// presets store).

import type { FxPluginDef, FxPreset } from '../types';

/** Engine sample id prefix for Edison's audio (env.sample(ED_PREFIX + id)). */
export const ED_PREFIX = 'edison:';

/** FL's RecModeSel items (value = index) and their hints. */
export const ED_REC_MODES = ['Now', 'On input', 'Input', 'On play'];
export const ED_REC_MODE_HINTS = [
  'Start recording immediately',
  'Start recording when input is detected',
  'Record detected input',
  'Record when host is playing',
];

/** FL's RecMaxTimeSelect items without the separators (value = index). */
export const ED_REC_MAX = [
  'Forever', '1 minute', '3 minutes', '5 minutes', '10 minutes', '30 minutes', '60 minutes',
  '50 MB', '100 MB', '200 MB', '500 MB', '1 GB',
];
/** Items of ED_REC_MAX that FL's list precedes with a separator. */
export const ED_REC_MAX_SEPARATED = [1, 7];

/**
 * Longest recording Edison keeps (seconds). FL records until RAM runs out;
 * here the audio lives in the browser tab, so "Forever" and the settings
 * above it stop (Forever) or wrap (the others) at 10 minutes.
 */
export const ED_MAX_SECONDS = 600;

/** Edison's undo depth (FL lists the last 10 actions; older steps are dropped after 20). */
export const ED_UNDO_LEVELS = 20;

/** Samples above this many bytes (32-bit float) keep no undo unless "Enable undo for large samples" is on (FL: 16 MB). */
export const ED_LARGE_UNDO_BYTES = 16 * 1024 * 1024;

/** Default gate / trigger threshold (linear peak, from FL's state). */
export const ED_DEFAULT_THRESHOLD = 0.02;

/** Short text of the duration combo (FL shows 5' for 5 minutes). */
export function edRecMaxText(i: number): string {
  const s = ED_REC_MAX[i] ?? ED_REC_MAX[0];
  if (i === 0) return 'Ever';
  const m = /^(\d+) minutes?$/.exec(s);
  if (m) return `${m[1]}'`;
  return s.replace(' ', '');
}

/**
 * Recording length limit for a duration setting: `frames` before the
 * recording wraps (FL: "Edison will wrap and overwrite the previously
 * recorded sample") or, for Forever, stops.
 */
export function edRecLimit(i: number, sampleRate: number): { frames: number; wrap: boolean } {
  const cap = Math.round(ED_MAX_SECONDS * sampleRate);
  const s = ED_REC_MAX[i];
  if (!s || i === 0) return { frames: cap, wrap: false };
  let frames = cap;
  const min = /^(\d+) minute/.exec(s);
  const mb = /^(\d+) MB$/.exec(s);
  if (min) frames = Number(min[1]) * 60 * sampleRate;
  else if (mb) frames = (Number(mb[1]) * 1048576) / 8; // 32-bit float stereo: 8 bytes per frame
  else if (s === '1 GB') frames = 1073741824 / 8;
  return { frames: Math.max(1, Math.min(cap, Math.round(frames))), wrap: true };
}

/** A marker (no `end`) or a region (marker plus end point), in sample frames. */
export interface EdMarker {
  pos: number;
  end?: number;
  name: string;
  info?: string;
  /** Trigger note (MIDI key), -1 or missing = none. */
  key?: number;
  /** Purpose: 0 Basic, 1 Beat, 2 Downbeat, 3 CD track, 4 CD index, 5 Single cycle. */
  purpose?: number;
}

/** One step of Edison's undo history: the audio (pool sample id) plus regions and loop points. */
export interface EdHist {
  id: string | null;
  label: string;
  markers: EdMarker[];
  loopPts: [number, number] | null;
}

/** Transport command for the DSP; executed once per new `n`. Positions in sample frames. */
export interface EdCmd {
  n: number;
  op: 'play' | 'pause' | 'stop' | 'seek';
  pos: number;
  /** Play range [a, b) (b <= a: the whole sample). */
  a: number;
  b: number;
}

/** Envelope point: [frame, value 0..1]. */
export type EdEnvPoint = [number, number];

export interface EdEnvelopes {
  pan: EdEnvPoint[];
  vol: EdEnvPoint[];
  sep: EdEnvPoint[];
  ap: EdEnvPoint[];
}

export interface EdState {
  // FL's parameters
  play: number;
  rec: number;
  livesel: number;
  // audio
  sample: string | null;
  hist: EdHist[];
  hpos: number;
  markers: EdMarker[];
  loopPts: [number, number] | null;
  sel: [number, number] | null;
  // recording options
  recMode: number;
  recMax: number;
  append: boolean;
  mute: boolean;
  threshold: number;
  // transport
  loop: boolean;
  sync: boolean;
  syncNoHostSel: boolean;
  syncNoOwnSel: boolean;
  keyLink: number;
  cmd: EdCmd;
  scrub: { n: number; pos: number } | null;
  // sample properties (Format / Tempo / Sampler / Info)
  title: string;
  comments: string;
  bits: 16 | 24 | 32;
  tempo: number;
  tsync: boolean;
  root: number;
  fine: number;
  // feature switches and view
  envSel: number;
  envs: EdEnvelopes;
  autoScroll: boolean;
  spec: boolean;
  dual: boolean;
  noiseView: boolean;
  regionsView: boolean;
  loopView: boolean;
  freeze: boolean;
  clickFree: boolean;
  step: boolean;
  snap: boolean;
  snapMode: number;
  slide: boolean;
  timeSamples: boolean;
  fancy: boolean;
  chanView: number;
  /** View > Misc > Background gradient. */
  gradient: number;
  /** Spectrum gradient: 12 dB steps, Charcoal, Furnace, Deeper furnace, Glacier, Temperature, The Matrix. */
  specGrad: number;
  /** Spectrum natural (logarithmic) frequency scale. */
  natural: boolean;
  undoLarge: boolean;
  /** Edit > Transport keystrokes to host (Space plays the song, not Edison). */
  keysToHost: boolean;
}

function freshState(): Omit<EdState, 'play' | 'rec' | 'livesel'> {
  return {
    sample: null,
    hist: [{ id: null, label: 'New', markers: [], loopPts: null }],
    hpos: 0,
    markers: [],
    loopPts: null,
    sel: null,
    recMode: 1,
    recMax: 3,
    append: false,
    mute: false,
    threshold: ED_DEFAULT_THRESHOLD,
    loop: false,
    sync: false,
    syncNoHostSel: false,
    syncNoOwnSel: false,
    keyLink: 3,
    cmd: { n: 0, op: 'stop', pos: 0, a: 0, b: 0 },
    scrub: null,
    title: '',
    comments: '',
    bits: 32,
    tempo: 0,
    tsync: true,
    root: 60,
    fine: 0,
    envSel: 0,
    envs: { pan: [], vol: [], sep: [], ap: [] },
    autoScroll: true,
    spec: false,
    dual: false,
    noiseView: true,
    regionsView: true,
    loopView: true,
    freeze: false,
    clickFree: true,
    step: false,
    snap: true,
    snapMode: 3,
    slide: false,
    timeSamples: false,
    fancy: false,
    chanView: 1,
    gradient: 1,
    specGrad: 2,
    natural: false,
    undoLarge: false,
    keysToHost: false,
  };
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : d);
const pair = (v: unknown): [number, number] | null =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && Number.isFinite(v[0]) && Number.isFinite(v[1]) && v[1] > v[0]
    ? [v[0], v[1]] : null;

function markersOf(v: unknown): EdMarker[] {
  if (!Array.isArray(v)) return [];
  const out: EdMarker[] = [];
  for (const m of v) {
    if (!m || typeof m !== 'object') continue;
    const o = m as Record<string, unknown>;
    if (typeof o.pos !== 'number' || !Number.isFinite(o.pos)) continue;
    const e: EdMarker = { pos: Math.max(0, Math.round(o.pos)), name: typeof o.name === 'string' ? o.name : '' };
    if (typeof o.end === 'number' && Number.isFinite(o.end) && o.end > e.pos) e.end = Math.round(o.end);
    if (typeof o.info === 'string' && o.info) e.info = o.info;
    if (typeof o.key === 'number' && o.key >= 0) e.key = Math.round(o.key);
    if (typeof o.purpose === 'number' && o.purpose > 0) e.purpose = Math.round(o.purpose);
    out.push(e);
  }
  return out.sort((a, b) => a.pos - b.pos);
}

function envOf(v: unknown): EdEnvPoint[] {
  if (!Array.isArray(v)) return [];
  return v.filter((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => [Math.max(0, p[0] as number), Math.min(1, Math.max(0, p[1] as number))] as EdEnvPoint)
    .sort((a, b) => a[0] - b[0]);
}

/** Read a slot state with defaults (UI side; tolerant of older or partial states). */
export function edState(p: Record<string, unknown> | null | undefined): EdState {
  const q = (p ?? {}) as Record<string, unknown>;
  const f = freshState();
  const hist = Array.isArray(q.hist) && q.hist.length
    ? (q.hist as unknown[]).filter((h) => h && typeof h === 'object').map((h) => {
      const o = h as Record<string, unknown>;
      return { id: typeof o.id === 'string' ? o.id : null, label: typeof o.label === 'string' ? o.label : '', markers: markersOf(o.markers), loopPts: pair(o.loopPts) };
    })
    : f.hist;
  const envs = (q.envs && typeof q.envs === 'object' ? q.envs : {}) as Record<string, unknown>;
  const cmd = (q.cmd && typeof q.cmd === 'object' ? q.cmd : f.cmd) as EdCmd;
  const scrub = q.scrub && typeof q.scrub === 'object' ? q.scrub as { n: number; pos: number } : null;
  const bits = num(q.bits, 32);
  return {
    play: num(q.play, 0),
    rec: num(q.rec, 0),
    livesel: num(q.livesel, 0),
    sample: typeof q.sample === 'string' && q.sample ? q.sample : null,
    hist: hist.length ? hist : f.hist,
    hpos: Math.min(Math.max(0, Math.round(num(q.hpos, hist.length - 1))), Math.max(0, hist.length - 1)),
    markers: markersOf(q.markers),
    loopPts: pair(q.loopPts),
    sel: pair(q.sel),
    recMode: Math.min(3, Math.max(0, Math.round(num(q.recMode, f.recMode)))),
    recMax: Math.min(ED_REC_MAX.length - 1, Math.max(0, Math.round(num(q.recMax, f.recMax)))),
    append: bool(q.append, f.append),
    mute: bool(q.mute, f.mute),
    threshold: Math.min(1, Math.max(0.0005, num(q.threshold, f.threshold))),
    loop: bool(q.loop, f.loop),
    sync: bool(q.sync, f.sync),
    syncNoHostSel: bool(q.syncNoHostSel, false),
    syncNoOwnSel: bool(q.syncNoOwnSel, false),
    keyLink: Math.min(3, Math.max(0, Math.round(num(q.keyLink, f.keyLink)))),
    cmd: { n: num(cmd.n, 0), op: cmd.op ?? 'stop', pos: num(cmd.pos, 0), a: num(cmd.a, 0), b: num(cmd.b, 0) },
    scrub: scrub && Number.isFinite(scrub.pos) ? { n: num(scrub.n, 0), pos: scrub.pos } : null,
    title: typeof q.title === 'string' ? q.title : '',
    comments: typeof q.comments === 'string' ? q.comments : '',
    bits: bits === 16 || bits === 24 ? bits : 32,
    tempo: Math.max(0, num(q.tempo, 0)),
    tsync: bool(q.tsync, f.tsync),
    root: Math.min(127, Math.max(0, Math.round(num(q.root, f.root)))),
    fine: Math.min(100, Math.max(-100, num(q.fine, 0))),
    envSel: Math.min(4, Math.max(0, Math.round(num(q.envSel, 0)))),
    envs: { pan: envOf(envs.pan), vol: envOf(envs.vol), sep: envOf(envs.sep), ap: envOf(envs.ap) },
    autoScroll: bool(q.autoScroll, f.autoScroll),
    spec: bool(q.spec, f.spec),
    dual: bool(q.dual, f.dual),
    noiseView: bool(q.noiseView, f.noiseView),
    regionsView: bool(q.regionsView, f.regionsView),
    loopView: bool(q.loopView, f.loopView),
    freeze: bool(q.freeze, f.freeze),
    clickFree: bool(q.clickFree, f.clickFree),
    step: bool(q.step, f.step),
    snap: bool(q.snap, f.snap),
    snapMode: Math.min(4, Math.max(0, Math.round(num(q.snapMode, f.snapMode)))),
    slide: bool(q.slide, f.slide),
    timeSamples: bool(q.timeSamples, f.timeSamples),
    fancy: bool(q.fancy, f.fancy),
    chanView: Math.min(3, Math.max(0, Math.round(num(q.chanView, f.chanView)))),
    gradient: num(q.gradient, f.gradient) ? 1 : 0,
    specGrad: Math.min(6, Math.max(0, Math.round(num(q.specGrad, f.specGrad)))),
    natural: bool(q.natural, f.natural),
    undoLarge: bool(q.undoLarge, f.undoLarge),
    keysToHost: bool(q.keysToHost, f.keysToHost),
  };
}

const presets: FxPreset[] = [
  { name: '3 min audio logger (input)', params: { recMode: 2, append: false, recMax: 2, sync: false } },
  { name: '3 min audio logger (on play)', params: { recMode: 3, append: false, recMax: 2, sync: true } },
  { name: 'Default', params: { recMode: 1, append: false, recMax: 3, sync: false } },
  { name: 'Record on audio input', params: { recMode: 2, append: true, recMax: 3, sync: false } },
  { name: 'Record on song playback', params: { recMode: 3, append: true, recMax: 3, sync: true } },
];

export const def: FxPluginDef = {
  id: 'edison',
  name: 'Edison',
  category: 'Misc',
  width: 744,
  height: 487,
  description: 'An audio editor & recorder',
  params: [
    { key: 'play', name: 'Play / pause', index: 0, min: 0, max: 1, def: 0, format: () => '' },
    { key: 'rec', name: 'Record', index: 1, min: 0, max: 1, def: 0, format: () => '' },
    { key: 'livesel', name: 'Live selection', index: 2, min: 0, max: 1, def: 0, format: () => '' },
  ],
  state: () => freshState() as unknown as Record<string, unknown>,
  // Loading a project: the transport starts idle (not armed, not playing) and
  // the undo history restarts at the saved audio (older steps are not saved).
  normalize: (p) => {
    const s = edState(p);
    return {
      ...p,
      play: 0,
      rec: 0,
      scrub: null,
      hist: [{ id: s.sample, label: 'Open', markers: s.markers, loopPts: s.loopPts }],
      hpos: 0,
    };
  },
  presets,
};
