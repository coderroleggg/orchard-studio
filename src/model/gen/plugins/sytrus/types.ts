// Sytrus state model (FL Studio's Sytrus, Plugin database > Generators >
// Synth classic). The automatable parameters are FL's 597 parameters (flat
// keys, see paramKeys()); everything else FL keeps in its plugin state blob
// (operators' waveforms and harmonics, the FM / RM matrix, filter types, the
// articulators' envelopes / LFO shapes / mappings, effect switches) lives in
// one JSON object under the state key `sy` (SyState). Field meanings and the
// layout of FL's saved state are in docs/research/gen/sytrus.md.

/**
 * An envelope editor curve (FL's TMEnvelope / TMLFO / TMMap): points
 * [dt, y, tension, segment type?, arp break?, flag?] where dt is the time
 * since the previous point (1.0 = 0.5 s, or a beat with TEMPO on), y the
 * level 0..1, tension -1..1; the last three default to 0. `m` = FL's five
 * marker ints: [flags, enabled (0 / -1), decay point, loop start, sustain
 * point] (-1 = none). `ph` = LFO start phase offset (LFO curves only).
 */
export interface SyEnv {
  p: number[][];
  m: number[];
  ph?: number;
}

/**
 * An articulator (one modulation target): envelope / LFO amounts and its 8 curves.
 * Stored compactly: a curve equal to FL's default for its slot is `null`
 * (defaults.ts defaultArt), and a whole articulator at its defaults is `null`
 * in SyState.arts; read curves through artEnv() / resolveArt().
 */
export interface SyArt {
  /** Envelope amount (FL's articulator +0x24; 1 = full). */
  ea: number;
  /** LFO amount (+0x28; set from Master LFO, PE, filter ENV). */
  la: number;
  /** [envelope, LFO, key map, velocity map, mod X map, mod Y map, random map, unison map]; null = default. */
  e: (SyEnv | null)[];
}

/** An articulator with every curve present (defaults resolved). */
export interface SyArtFull extends SyArt {
  e: SyEnv[];
}

/** An operator's waveform and pitch settings (FL's operator page, not automatable). */
export interface SyOp {
  /** Frequency ratio x10000 (20000 = "2", the note's pitch). */
  ratio: number;
  /** Frequency offset (Hz x100). */
  ofs: number;
  /** NS noise 0..128. */
  ns: number;
  /** SH shape 0..512, TN tension -128..128, SK skew 0..128, SN sine shaper 0..128, FL pre-filter 0..128. */
  sh: number;
  tn: number;
  sk: number;
  sn: number;
  fl: number;
  /** Switches (0 / 1): half, even (half silent), absolute, global phase, center, declick, pluck, band limit. */
  half: number;
  even: number;
  abs: number;
  glob: number;
  center: number;
  declick: number;
  pluck: number;
  blimit: number;
  /** Harmonic amplitudes 0..1 (harmonic k+1; trailing zeros dropped). */
  amp: number[];
  /** Harmonic phases 0..1 (trailing zeros dropped). */
  ph: number[];
}

export interface SyFilter {
  /** Filter type 0..12 (FL's TYPE spinner). */
  type: number;
  /** HQ, FLAT, waveshaper ON, waveshaper bipolar (0 / 1). */
  hq: number;
  flat: number;
  ws: number;
  wsBip: number;
  /** Waveshaper curve (a mapping). */
  wsMap: SyEnv;
}

export interface SyDelay {
  tempo: number;
  serial: number;
  on: number;
}

export interface SyReverb {
  lc: number;
  hc: number;
  pd: number;
  rs: number;
  df: number;
  de: number;
  hd: number;
  col: number;
  vol: number;
  on: number;
  tempo: number;
}

/** Global switches and settings (main page, options menu, quality). */
export interface SyGlobal {
  dqEnv: number;
  rqEnv: number;
  dqOver: number;
  rqOver: number;
  modSmooth: number;
  rand: number;
  gPitch: number;
  monoKey: number;
  x792: number;
  x796: number;
  /** Send to effect track number - 1 (-1 = none). */
  sendTrack: number;
  soften: number;
  oscUni: number;
  gCenter: number;
  gibbs: number;
  arpInv: number;
  portaVar: number;
  portaTrack: number;
  portaLimit: number;
  velVol: number;
  /** bit 0 velocity -> attack length, bit 1 velocity -> attack time. */
  velAtt: number;
  relRel: number;
  /** Unison distribution: 0 original, 1 improved, 2 uniform, 3 blurred. */
  uniDist: number;
  /** EQ target: 0 off, 1 out+fx, 2 out, 3 fx. */
  eqMode: number;
  /** EQ band types (0 low shelf, 1 peaking, 2 high shelf). */
  eqType: number[];
  /** Editor's testing keyboard shown (view setting kept for FL parity). */
  x510: number;
  hqWs: number;
}

export interface SyState {
  /** FM matrix int[9][9] (row = op1..6, F1..3; column = op1..6, pan, FX, output) and RM matrix. */
  fm: number[];
  rm: number[];
  /** Matrix mute flags byte[2][81] (FM, RM). */
  mute: number[];
  ops: SyOp[];
  flt: SyFilter[];
  /** Articulators per unit: ops 1-6 (6 each), filters 1-3 (8 each), effects (2); null = all defaults. */
  arts: (SyArt | null)[][];
  g: SyGlobal;
  del: SyDelay[];
  rev: SyReverb;
  info: string;
}

export const OP_ARTS = ['pan', 'vol', 'mod', 'pitch', 'phase', 'damp'] as const;
export const FLT_ARTS = ['pan', 'vol', 'cut', 'res', 'low', 'band', 'high', 'ws'] as const;
export const FX_ARTS = ['pan', 'vol'] as const;
export const ART_FIELDS = ['A', 'D', 'S', 'R', 'Spd', 'Ten', 'Skw', 'PW'] as const;
/** Articulators per unit (units 0-5 ops, 6-8 filters, 9 effects). */
export const UNIT_ARTS: readonly (readonly string[])[] = [
  OP_ARTS, OP_ARTS, OP_ARTS, OP_ARTS, OP_ARTS, OP_ARTS, FLT_ARTS, FLT_ARTS, FLT_ARTS, FX_ARTS,
];
/** Unit key prefixes for articulator parameter keys. */
export const UNIT_PREFIX = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'f1', 'f2', 'f3', 'fx'];

/** Articulators whose curves centre at 0.5 (bipolar, additive: pan, pitch, phase, cutoff, resonance). */
export function artIsBipolar(unit: number, art: number): boolean {
  const name = UNIT_ARTS[unit][art];
  return name === 'pan' || name === 'pitch' || name === 'phase' || name === 'cut' || name === 'res';
}

/** Parameter key of articulator field f (0..7: A, D, S, R, Spd, Ten, Skw, PW). */
export function artKey(unit: number, art: number, field: number): string {
  return UNIT_PREFIX[unit] + UNIT_ARTS[unit][art] + ART_FIELDS[field];
}

/** FL's 597 automatable parameters in index order (our keys). */
export function paramKeys(): string[] {
  const k = ['level', 'lfo', 'pitch', 'vA', 'vD', 'vS', 'vR', 'fA', 'fD', 'fS', 'fR',
    'uOrder', 'uPan', 'uVol', 'uPitch', 'uSub', 'uPhase', 'uEnv', 'modX', 'modY'];
  for (let n = 0; n < 6; n++) {
    k.push(`o${n + 1}phase`, `o${n + 1}vol`, `o${n + 1}pe`);
    for (let a = 0; a < 6; a++) for (let f = 0; f < 8; f++) k.push(artKey(n, a, f));
  }
  for (let n = 0; n < 3; n++) {
    for (const s of ['mode', 'env', 'cut', 'res', 'low', 'band', 'high', 'wsAmp', 'wsMix']) k.push(`f${n + 1}${s}`);
    if (n < 2) k.push(`f${n + 1}next`);
    for (let a = 0; a < 8; a++) for (let f = 0; f < 8; f++) k.push(artKey(6 + n, a, f));
  }
  k.push('fxPan', 'chOrder', 'chDepth', 'chSpeed', 'chDelay', 'chSpread', 'chCross', 'chVol', 'send');
  for (let n = 1; n <= 3; n++) for (const s of ['fb', 'time', 'ofs', 'vol', 'mode']) k.push(`d${n}${s}`);
  for (let a = 0; a < 2; a++) for (let f = 0; f < 8; f++) k.push(artKey(9, a, f));
  k.push('eq1lvl', 'eq2lvl', 'eq3lvl', 'eq1freq', 'eq2freq', 'eq3freq', 'eq1bw', 'eq2bw', 'eq3bw', 'porta');
  return k;
}
