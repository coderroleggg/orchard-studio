// Fruity Granulizer's plugin state: FL's 12 parameters (control units, parameter indices 0..11),
// the trigger mode and transient source FL saves with them, and the sample reference. Read
// defensively by the engine and the editor. See docs/research/gen/granulizer.md.

/** KEY TO modes (FL's TriggerModeSelect): what the keys control. */
export const TRIGGER_MODES = ['Pitch', 'Percent', 'Step', 'Transient'] as const;
export const TRIGGER_HINTS = [
  'Key to pitch', 'Key to start (sample time, C5 to C7)', 'Key to start (song time)', 'Key to start (transient time)',
] as const;
/** TRANSIENTS source (FL's TransModeSelect). */
export const TRANSIENT_MODES = ['OFF', 'USE REGIONS', 'DETECT'] as const;

export interface GranulizerState {
  /** GRAIN attack time 50..500 (exponential: 5 .. 500 ms). */
  attack: number;
  /** GRAIN hold time 0..500 (exponential: 0 .. 500 ms). */
  hold: number;
  /** Grain spacing 125..1000 (256 = 100 %). */
  spacing: number;
  /** Wave spacing -1000..1000 (256 = 100 %, negative plays the grains backwards). */
  wave: number;
  /** Effect depth 0..384: amplitude of the LFO on the wave position. */
  depth: number;
  /** Effect speed 4..200. */
  speed: number;
  /** Randomness 0..256. */
  random: number;
  /** Stereo separation 0..64 (odd / even grains alternate sides). */
  stereo: number;
  /** Repeat sound (LOOP). */
  loop: number;
  /** Hold sound (HOLD): the playing position stays. */
  holdSound: number;
  /** Sample start 0..4096. */
  start: number;
  /** Transient hold time 0..500. */
  transHold: number;
  /** Pool sample id of the channel's audio ('' = none). */
  sample: string;
  /** The file name the editor shows. */
  file: string;
  /** Frame positions of the sample file's regions (TRANSIENTS: USE REGIONS). */
  regions: number[];
  /** Transient frames the editor detected for the sample (TRANSIENTS: DETECT); the engine detects them itself when missing. */
  detected: number[];
  /** What `detected` belongs to: "<sample id>|<frames>|<rate>". */
  detectedFor: string;
  /** KEY TO mode 0..3. */
  trigger: number;
  /** TRANSIENTS source 0..2. */
  trans: number;
  /** TEMPO LOCKED (FL's tempo-lock mode; needs the channel's fit time). */
  tempoLocked: boolean;
  /** Waveform view: 0 waveform, 1 spectrum, 2 multichannel (editor). */
  view: number;
}

export const GRAN_DEFAULTS = {
  attack: 204, hold: 50, spacing: 611, wave: 611, depth: 0, speed: 180, random: 0, stereo: 0, loop: 0, holdSound: 0, start: 0, transHold: 228,
} as const;

/** The plugin database state (FL's new instance: version 5, no sample). */
export function defaultGranulizerState(): Record<string, unknown> {
  return { ...GRAN_DEFAULTS, sample: '', file: '', regions: [], detected: [], detectedFor: '', trigger: 0, trans: 0, tempoLocked: false, view: 0 };
}

const RANGES: Record<string, [number, number]> = {
  attack: [50, 500], hold: [0, 500], spacing: [125, 1000], wave: [-1000, 1000], depth: [0, 384], speed: [4, 200],
  random: [0, 256], stereo: [0, 64], loop: [0, 1], holdSound: [0, 1], start: [0, 4096], transHold: [0, 500],
  trigger: [0, 3], trans: [0, 2], view: [0, 2],
};

function num(v: unknown, def: number, lo: number, hi: number): number {
  const x = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def;
  return x < lo ? lo : x > hi ? hi : x;
}

/** A typed state from anything stored (missing / invalid fields take the defaults, numbers are clamped to FL's ranges). */
export function granulizerState(p: unknown): GranulizerState {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const d = defaultGranulizerState() as unknown as GranulizerState;
  const out = { ...d } as unknown as Record<string, unknown>;
  for (const k of Object.keys(RANGES)) {
    const [lo, hi] = RANGES[k];
    out[k] = num(o[k], (d as unknown as Record<string, number>)[k], lo, hi);
  }
  // FL's TriggerModeSelectChange (0x60050, also run when a state is restored): KEY TO Transient with TRANSIENTS OFF
  // switches the source to DETECT
  if (out.trigger === 3 && out.trans === 0) out.trans = 2;
  out.sample = typeof o.sample === 'string' ? o.sample : '';
  out.file = typeof o.file === 'string' ? o.file : '';
  out.tempoLocked = o.tempoLocked === true;
  const frames = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0).slice(0, 8192).map(Math.floor) : []);
  out.regions = frames(o.regions);
  out.detected = frames(o.detected);
  out.detectedFor = typeof o.detectedFor === 'string' ? o.detectedFor : '';
  return out as unknown as GranulizerState;
}
