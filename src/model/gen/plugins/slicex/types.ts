// Slicex's state (FL 2026, Slicex_x64.dylib; docs/research/gen/slicex.md "State"): two decks
// (sample + regions), 8 articulator groups (filter + 6 modulation targets each), the master
// section's settings and the editor's view. FL keeps all of it in its state blob (version
// 0x00060003, SaveRestoreState 0x73450): the regions inside each deck's WAV (cue / LIST adtl /
// tlst chunks: start, end, name, info, purpose, trigger note) plus Slicex's 68-byte record per
// region, then per articulator a 20-byte header and 6 targets (TGroupArticulator: base, envelope
// and LFO amounts, envelope, LFO and 4 mapping curves).

/**
 * An envelope editor curve (FL's TMEnvelope / TMLFO / TMMap, saved as type, version 3, points,
 * five marker ints). `p`: points [dx, level, tension, b0, b1, b2, b3]: dx the time since the previous
 * point (double; 1.0 = half a second, or a beat with tempo sync; maps: x 0..1), level 0..1,
 * tension -1..1, then FL's four point bytes (+0x10..+0x13 of the 36-byte record: curve type ...).
 * `m`: FL's markers [flags (bit 0 tempo sync, bit 1 global), enabled (-1 on, 0 off), decay point,
 * loop start, sustain point] (-1 = none). Envelopes also save their attack / decay / sustain /
 * release ints (`a`, 128 = 100 %), LFOs their speed, tension, skew, pulse width ints (`l`) and start
 * phase (`ph`); for targets 0..4 the automatable parameters hold the live values of `a` / `l`.
 */
export interface SxCurve {
  t: number;
  p: number[][];
  m: number[];
  a?: number[];
  l?: number[];
  ph?: number;
}

/** One modulation target of an articulator (FL's TGroupArticulator). */
export interface SxTarget {
  /** Base value (float, FL +0x20). */
  b: number;
  /** Envelope amount (float, +0x24). */
  ea: number;
  /** LFO amount (float, +0x28). */
  la: number;
  env: SxCurve;
  lfo: SxCurve;
  /** Mappings in FL's save order: MOD X, MOD Y, VEL, RAND. */
  maps: SxCurve[];
}

/** An articulator group (FL +0xdd0 + 0x50 n): filter header and 6 targets. */
export interface SxArt {
  /** Filter type byte (header +0xc): 0 off, 1..4 (LP, BP, BS, HP order of FL's selector). */
  ft: number;
  /** Header bytes +0xd..+0xf (kept). */
  fb: number[];
  /** Filter slope (header +0x10): number of filter stages (0 = none). */
  fo: number;
  /** Targets: pan, vol, cutoff, resonance, speed, start. */
  t: SxTarget[];
}

/** A region (slice) of a deck: FL's TWAVSample region plus Slicex's 68-byte record. */
export interface SxRegion {
  /** First frame. */
  s: number;
  /** Last frame (inclusive); -1 = marker (the region runs to the next region's start or the end). */
  e: number;
  name: string;
  info: string;
  /** Purpose (FL's ltxt code index: 0 loop, 1 rgn, 2 beat, 3 dwnb, 4 trak, 5 indx, 6 wtsc, 7 none). */
  pur: number;
  /** Trigger note 0..127, -1 = automatic (base note + region index). */
  note: number;
  // ---- Slicex's region record (17 ints, record +0x00..+0x40)
  /** Cut group 0..99. */
  cut: number;
  /** Output track offset -99..99. */
  out: number;
  /** Panning -6400..6400. */
  pan: number;
  /** Volume 0..16000 (8000 = 1.0). */
  vol: number;
  /** Amp articulator group (-1 none, 0..7) and amount 0..12800. */
  aArt: number;
  aAmt: number;
  /** Filter cutoff / resonance 0..256. */
  fc: number;
  fr: number;
  /** Filter articulator group and amount. */
  fArt: number;
  fAmt: number;
  /** Pitch, cents -1200..1200. */
  pitch: number;
  /** Speed articulator group and amount. */
  sArt: number;
  sAmt: number;
  /** Delay 0..12800. */
  delay: number;
  /** Sample start 0..12800. */
  ofs: number;
  /** Sample start articulator group and amount. */
  oArt: number;
  oAmt: number;
}

/** A deck (A or B): the sample (pool id under the state key `sampleA` / `sampleB`) and its regions. */
export interface SxDeck {
  /** Title (WAV INFO INAM / file name). */
  title: string;
  /** Source file name as loaded. */
  file: string;
  /** Tempo (BPM, from the WAV's acid chunk or detection; 0 = unknown) and length in beats. */
  tempo: number;
  beats: number;
  regions: SxRegion[];
}

/** Master / option settings (FL's 47-byte block at +0x1304, named where Slicex uses them). */
export interface SxSettings {
  /** Drum layering mode (+0x1304): 0 All, 1 All (gain-compensated), 2 Velocity-, 3 Mod X-, 4 Mod Y-mapped, 5 Random, 6 Cycle, 7 Song time-synced. */
  lmode: number;
  /** Crossfade curve (+0x1308): 0 None, 1 Linear, 2 Balanced, 3 Unbalanced, 4 Adding. */
  xfade: number;
  /** Layer regions of the same deck only (+0x132e). */
  sameDeck: boolean;
  /** Smooth up modulation (+0x1329). */
  smooth: boolean;
  /** Sample start covers whole length (+0x132c). */
  startWhole: boolean;
  /** Link velocity to volume (+0x132f). */
  velVol: boolean;
  /** Loop half of regions (+0x1331). */
  loopHalf: boolean;
  /** HQ envelopes (+0x132d). */
  hqEnv: boolean;
  /** Dump deck A to piano roll after editing (+0x132a). */
  autoDump: boolean;
  /** Lock audio data (FL +0x1341, outside the saved block: kept here as a plain flag, on by default). */
  lockAudio: boolean;
  /** Deck transport loop (+0x1325), keyboard shown (+0x1330), no auto-scroll (+0x1326), dual deck display (+0x132b). */
  loop: boolean;
  kbShown: boolean;
  noAutoScroll: boolean;
  dual: boolean;
  /** Display mode (DispModeSelect, +0x1314): 0 full .. 3 compact. */
  dispMode: number;
  /** Leave unedited audio data on disk (+0x1332). */
  noEmbed: boolean;
  /** FL's raw block (47 bytes, kept for the fields Orchard does not model). */
  raw: number[];
}

export const SX_ARTS = 8;
export const SX_TARGETS = 6;
/** Target names in FL's order (EnvTargetSelect). */
export const SX_TARGET_NAMES = ['PAN', 'VOL', 'CUT', 'RES', 'SPEED', 'START'] as const;
/** Articulator parts (EnvSelect): envelope, LFO and the four mappings, in the editor's order. */
export const SX_PART_NAMES = ['ENV', 'LFO', 'VEL', 'MOD X', 'MOD Y', 'RAND'] as const;
/** Index of each editor part in `SxTarget.maps` (-1: env / lfo). */
export const SX_PART_MAP = [-1, -1, 2, 0, 1, 3] as const;
