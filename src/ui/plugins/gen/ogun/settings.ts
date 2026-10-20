// Ogun's editor settings: the state fields behind FL's controls that are not FL parameters (Tag < 0) and behind the
// options menu items. Every assignment was read from FL's own handlers (Ogun_x64.dylib: TSynthEditorForm.* click / change
// handlers and TSynthResModule.OptionsMenuPopup 0x75820 / VelToVolMenuClick 0x75c70 / PortaVariableMenuClick 0x759f0 /
// Q0MenuClick 0x76270 / OctEQScaleMenuClick 0x757a0 / AutoLoudnessMenuClick 0x75ee0), see docs/research/gen/ogun.md.
//
// State: `xi` = FL's ints 49..63 (plug+0x200 + 4 k), `b3` = plug+0x368 (3 bytes), `i2` = the three EQ band types
// (plug+0x398 / +0x418 / +0x498), `info` the info text (lines separated by CR), `view` the editor page.
//
//   xi[0]  filter type (0 LP, 1 BP, 2 BS, 3 HP)          xi[1]  filter mode (0 off, 1 single, 2 dual, 3 triple)
//   xi[2]  alternate resonance (-1 on)                    xi[3]  timbre richness + 5 (6..16)
//   xi[4]  byte0 reverb enabled, byte1 reverb tempo-based predelay
//   xi[5]  processing quality 0..4
//   xi[6]  byte0 smooth up modulation, byte1 one voice per key, byte2 velocity -> volume, byte3 key -> pitch
//   xi[7]  byte0 key -> timbre seed 1, byte1 velocity link bits (bit0 attack length, bit1 attack time),
//          byte2 attack click removal, byte3 timbre release linked to the volume decay
//   xi[8]  byte0 portamento, byte1 variable time, byte2 limit (0 none, 1 octave wrap, 2..5 = 4..1 semitones),
//          byte3 natural (octave) EQ mapping scale
//   xi[9..12] harmonic comb of the forced / impulse / decay / release EQ maps (0..7)
//   xi[13] byte0 alternate decay, byte1 auto loudness, byte2 natural EQ weighting
//   xi[14] magic dust (Autogun)
//   b3[0] delay tempo-based time, b3[1] delay enabled

export type Params = Record<string, unknown>;

/** The values of FL's int / byte settings, tolerant of a missing or short array. */
export function xiOf(p: Params): number[] {
  const x = p.xi;
  return Array.isArray(x) ? (x as number[]) : [];
}

/** Byte k (0 = lowest) of an int. */
export const byteOf = (v: number | undefined, k: number): number => (((v ?? 0) | 0) >>> (8 * k)) & 255;
/** The int with byte k replaced. */
export const withByte = (v: number | undefined, k: number, b: number): number => ((((v ?? 0) | 0) & ~(255 << (8 * k))) | ((b & 255) << (8 * k))) | 0;

/** Write xi[i] of a (draft) state, growing the array to FL's 15 ints when needed. */
export function setXi(d: Params, i: number, v: number): void {
  let x = d.xi as number[] | undefined;
  if (!Array.isArray(x)) { x = []; d.xi = x; }
  while (x.length < 15) x.push(0);
  x[i] = v | 0;
}

function setByte(d: Params, i: number, k: number, b: number): void {
  const x = d.xi as number[] | undefined;
  setXi(d, i, withByte(Array.isArray(x) ? x[i] : 0, k, b));
}

export interface Setting {
  /** FL's name (hint, undo label). */
  label: string;
  min: number;
  max: number;
  def: number;
  get(p: Params): number;
  set(d: Params, v: number): void;
}

const xiSetting = (label: string, i: number, min: number, max: number, def: number, scale: { off: number } = { off: 0 }): Setting => ({
  label, min, max, def,
  get: (p) => (xiOf(p)[i] ?? def + scale.off) - scale.off,
  set: (d, v) => setXi(d, i, Math.round(v) + scale.off),
});

const byteSetting = (label: string, i: number, k: number, min: number, max: number, def: number): Setting => ({
  label, min, max, def,
  get: (p) => byteOf(xiOf(p)[i], k),
  set: (d, v) => setByte(d, i, k, Math.round(v)),
});

const bitSetting = (label: string, i: number, k: number, bit: number): Setting => ({
  label, min: 0, max: 1, def: 0,
  get: (p) => (byteOf(xiOf(p)[i], k) >> bit) & 1,
  set: (d, v) => {
    const x = (d.xi as number[] | undefined) ?? [];
    const cur = byteOf(x[i], k);
    setByte(d, i, k, v ? cur | (1 << bit) : cur & ~(1 << bit));
  },
});

const b3Setting = (label: string, k: number, def: number): Setting => ({
  label, min: 0, max: 1, def,
  get: (p) => (Array.isArray(p.b3) ? ((p.b3 as number[])[k] ?? def) : def) & 1,
  set: (d, v) => {
    let b = d.b3 as number[] | undefined;
    if (!Array.isArray(b)) { b = [0, 0, 0]; d.b3 = b; }
    while (b.length < 3) b.push(0);
    b[k] = v ? 1 : 0;
  },
});

/** EQ band type k (0 low shelf, 1 peaking, 2 high shelf; FL keeps three ints, the third is 2 in every factory preset). */
const EQ_DEF = [0, 1, 2];
const eqSetting = (k: number): Setting => ({
  label: `EQ band ${k + 1} type`, min: 0, max: 2, def: EQ_DEF[k],
  get: (p) => (Array.isArray(p.i2) ? ((p.i2 as number[])[k] ?? EQ_DEF[k]) : EQ_DEF[k]),
  set: (d, v) => {
    let a = d.i2 as number[] | undefined;
    if (!Array.isArray(a)) { a = EQ_DEF.slice(); d.i2 = a; }
    while (a.length < 3) a.push(EQ_DEF[a.length]);
    a[k] = Math.round(v);
  },
});

/** The settings of the editor's controls by FL component name. */
export const SETTINGS: Record<string, Setting> = {
  FTypeSelect: xiSetting('Filter type', 0, 0, 3, 0),
  FOrderSelect: xiSetting('Filter mode', 1, 0, 3, 0),
  FFlatBtn: {
    label: 'Alternate resonance / bandwidth / mode', min: 0, max: 1, def: 0,
    get: (p) => (xiOf(p)[2] ? 1 : 0),
    set: (d, v) => setXi(d, 2, v ? -1 : 0),
  },
  RichnessWheel: xiSetting('Timbre richness', 3, 1, 11, 10, { off: 5 }),
  RevEnableBtn: byteSetting('Enable reverb', 4, 0, 0, 1, 1),
  RevTempoBtn: byteSetting('Tempo-based predelay', 4, 1, 0, 1, 0),
  ModSmoothBtn: byteSetting('Smooth up modulation', 6, 0, 0, 1, 1),
  DeClickBtn: byteSetting('Attack click removal', 7, 2, 0, 1, 0),
  AltDecayBtn: byteSetting("Alternate 'to target' decay mode", 13, 0, 0, 1, 0),
  DelEnableBtn: b3Setting('Enable delay', 1, 0),
  DelTempoBtn: b3Setting('Tempo-based time', 0, 1),
  MixEQType1Select: eqSetting(0),
  MixEQType2Select: eqSetting(1),
  MixEQType3Select: eqSetting(2),
};

/** The options menu's switches (FL: TSynthResModule menu items), by id. */
export const MENU_SETTINGS: Record<string, Setting> = {
  porta: byteSetting('Enable portamento', 8, 0, 0, 1, 0),
  portaVar: byteSetting('Variable time', 8, 1, 0, 1, 1),
  portaLimit: byteSetting('Portamento limit', 8, 2, 0, 5, 0),
  keyPitch: byteSetting('Link key to pitch', 6, 3, 0, 1, 0),
  keySeed: byteSetting('Link key to timbre seed 1', 7, 0, 0, 1, 0),
  monoKey: byteSetting('Limit to 1 voice per key', 6, 1, 0, 1, 1),
  velVol: byteSetting('Link velocity to volume', 6, 2, 0, 1, 1),
  velAttLength: bitSetting('Link velocity to attack length', 7, 1, 0),
  velAttTime: bitSetting('Link velocity to attack time', 7, 1, 1),
  quality: xiSetting('Processing quality', 5, 0, 4, 1),
  releaseLink: byteSetting('Link timbre release to volume decay', 7, 3, 0, 1, 0),
  octEQScale: byteSetting('Natural EQ mapping scale', 8, 3, 0, 1, 1),
  natWeight: byteSetting('Natural EQ mapping weighting', 13, 2, 0, 1, 0),
  autoLoudness: byteSetting('Auto loudness', 13, 1, 0, 1, 0),
};

// ------------------------------------------------------------------ targets

/** FL's editor targets (ArtSelect items; '-' prefixes are group captions that are not selectable). */
export const ART_ITEMS = ['-Articulation', 'Volume', 'Filter frequency', 'Filter resonance', 'Pitch', 'Unison pitch', '-Mapping', 'Unison phase',
  'Timbre pre-decay', 'Timbre decay time', 'Timbre release time', 'Timbre fullness', 'Timbre morphing', 'Timbre rotation', 'Timbre EQ shifting',
  '-Timbre equalization', 'Timbre forced harmonics', 'Timbre impulse EQ', 'Timbre decay EQ', 'Timbre release EQ'];
/** The articulator part list (EnvSelect items). */
export const PART_ITEMS = ['Envelope', 'LFO', 'Keyboard mapping', 'Velocity mapping', 'Modulation X mapping', 'Modulation Y mapping'];

/** The selectable editor targets, in FL's object order: 0..4 articulation, 5..12 mapping, 13..16 timbre equalization maps. */
export const TARGET_NAMES = ART_ITEMS.filter((s) => !s.startsWith('-'));

export type TargetKind = 'art' | 'map' | 'eq';
export const targetKind = (t: number): TargetKind => (t <= 4 ? 'art' : t <= 12 ? 'map' : 'eq');

/** The parts of a target: 0..5 for the articulation targets, 2..5 for the mapping targets, -1 (the map itself) for the EQ maps. */
export function partsOf(t: number): number[] {
  return t <= 4 ? [0, 1, 2, 3, 4, 5] : t <= 12 ? [2, 3, 4, 5] : [-1];
}
export function clampPart(t: number, part: number): number {
  const ps = partsOf(t);
  return ps.includes(part) ? part : ps[0];
}
/** EnvSelect's Value (item index) of a part of a target, and back. */
export const partToValue = (t: number, part: number): number => Math.max(0, partsOf(t).indexOf(clampPart(t, part)));
export const valueToPart = (t: number, v: number): number => partsOf(t)[Math.max(0, Math.min(partsOf(t).length - 1, v))];

export interface OgView {
  target: number;
  part: number;
  /** Testing keyboard shown (FL's default). */
  kb: number;
  /** The part last used with each target (FL remembers it per target). */
  parts?: number[];
  /** FL's random preset counter (plug+0x610: the seed of the last generated preset). */
  rn?: number;
}

/** The editor view of a state (defensive: a state from an older save or another source). */
export function viewOf(p: Params): OgView {
  const v = (p.view ?? {}) as Record<string, unknown>;
  const n = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : d);
  const target = Math.max(0, Math.min(16, n(v.target, 0)));
  const out: OgView = { target, part: clampPart(target, n(v.part, partsOf(target)[0])), kb: n(v.kb, 1) ? 1 : 0 };
  if (Array.isArray(v.parts)) out.parts = (v.parts as unknown[]).map((x, i) => clampPart(i, n(x, partsOf(i)[0]))).slice(0, 17);
  if (typeof v.rn === 'number' && Number.isFinite(v.rn)) out.rn = Math.max(0, Math.round(v.rn));
  return out;
}

/** The part to show when `target` is selected: the one last used with it. */
export function partFor(view: OgView, target: number): number {
  return clampPart(target, view.parts?.[target] ?? partsOf(target)[0]);
}

/** The curve of a target's part in the state (arts[t].e / .l / .k[part-2], maps[t-13]). */
export type CurvePath = ['maps', number] | ['arts', number, 'e' | 'l' | 'k', number?];
export function curvePath(t: number, part: number): CurvePath {
  if (t >= 13) return ['maps', t - 13];
  const p = clampPart(t, part);
  return p === 0 ? ['arts', t, 'e'] : p === 1 ? ['arts', t, 'l'] : ['arts', t, 'k', p - 2];
}

/** The key a curve has in the state's `missing` list: m<map>, a<art>e, a<art>l, a<art>k<map>. */
export function missingKey(path: CurvePath): string {
  return path[0] === 'maps' ? `m${path[1]}` : `a${path[1]}${path[2]}${path[2] === 'k' ? path[3] : ''}`;
}

/** The flat parameter of the knob `tag` (0..3 envelope ATT DEC SUS REL, 4..7 LFO SPD TNS SKEW PW) of a target with knobs (0..4). */
export const KNOB_KEYS = ['Att', 'Dec', 'Sus', 'Rel', 'LfoSpd', 'LfoTns', 'LfoSkw', 'LfoPw'];
export const TARGET_PREFIX = ['vol', 'flt', 'res', 'pit', 'upi'];
export function knobKey(t: number, tag: number): string | null {
  return t >= 0 && t <= 4 && tag >= 0 && tag <= 7 ? TARGET_PREFIX[t] + KNOB_KEYS[tag] : null;
}

// ------------------------------------------------------------------ comb

/** The comb of an EQ map target (13..16) lives in xi[9 + t - 13]. */
export const COMB_FACE = ['off', '-2', '-3', '-4', '-5', '+3', '+4', '+5'];
export const COMB_HINT = ['Off', 'Remove every 2', 'Remove every 3', 'Remove every 4', 'Remove every 5', 'Keep every 3', 'Keep every 4', 'Keep every 5'];
export function combSetting(t: number): Setting | null {
  if (t < 13 || t > 16) return null;
  return xiSetting('Harmonic comb', 9 + t - 13, 0, 7, 0);
}

/** The reverb colour digit wheel's face text (FL: RevColWheelGetText) and the text of the other digit wheels. */
export const REV_COLOR_FACE = ['B+', 'B', 'F', 'W', 'W+'];
