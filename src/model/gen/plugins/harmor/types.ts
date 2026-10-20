// Harmor's non-automatable state (FL keeps it in the plugin state blob next to
// the 825 parameters, docs/research/gen/harmor.md "State"): per part the
// editor settings (timbre blending, filter / resonance / phaser types, unit
// order...), the 43 articulators (envelope, LFO and 9 mappings each), the 26
// shaping maps and the image; global settings (FX order, monophonic mode,
// quality settings, info text). Stored under the plugin state keys `hA`, `hB`
// (parts) and `hG` (global); view settings under `hView`.

/**
 * An envelope editor curve (FL's TMEnvelope / TMLFO / TMMap, saved as type,
 * version 3, points, five marker ints). `p`: points [dx, y, tension, segment
 * type, arpeggio break, b2, kind] with dx the time since the previous point
 * (1.0 = 0.5 s, or a beat with tempo sync; mappings: x position 0..1), y the
 * level 0..1, tension -1..1. `m`: FL's markers [flags (bit 0 tempo sync, bit 1
 * global), enabled (-1 on, 0 off), decay point,
 * loop start, sustain point] (-1 = none). Envelopes also save their attack /
 * decay / sustain / release scales (`a`), LFOs their speed, tension, skew,
 * pulse width (`l`) and start phase (`ph`); for the articulation targets the
 * automatable parameters hold the live values.
 */
export interface HEnv {
  t: number;
  p: number[][];
  m: number[];
  a?: number[];
  l?: number[];
  ph?: number;
}

/** An articulator (one modulation target of a part). */
export interface HArt {
  /** FL's articulator mode (0 = bipolar / offset target, 1 = multiplying target; saved as a float). */
  mode: number;
  /** Envelope amount (float). */
  ea: number;
  /** LFO amount (float). */
  la: number;
  /** Envelope. */
  e: HEnv;
  /** LFO. */
  l: HEnv;
  /** The 9 mappings (FL's "Articulator part" list after Envelope and LFO): Keyboard, Velocity, Mod X, Mod Y, Mod Z, Random, Unison index, Held index, Mod X speed. */
  k: HEnv[];
}

/** A part's image (FL's TBMP object: image synthesis / resynthesis data). */
export interface HImage {
  /** 0 = image planes stored in the state, 1 = resynthesized from the sample file `src`. */
  mode: number;
  /** FL's image header fields (+0x58, +0x100: loop mode and flags). */
  a58: number;
  a100: number;
  /** Three doubles of FL's header (+0xe8, +0xf0, +0xf8: loop / selection marks, -1 = none). */
  d: number[];
  /** Image size (FL's TBMP): `h` rows = time frames, `w` columns = partials; 0 = no image. */
  h: number;
  w: number;
  /** Planes present (bit 0 gain, bit 1 freq, bit 2 third plane). */
  planes: number;
  /**
   * The image planes are FL content: they are not part of the converted presets
   * and come from the user's own FL installation (plugin menu "Import images from
   * FL presets...") into the sample pool (`a_imgSample` / `b_imgSample`).
   */
  missing?: boolean;
}

/** A part's settings (FL: 0x30 + 0x4b bytes of the part block). */
export interface HPart {
  /** Part enabled (Enable part A / B). */
  on: number;
  /** Timbre blending mode (HarmBlendSelect.Value: 0 Fade, 1 Subtract, 2 Multiply, 3 Maximum, 4 Minimum, 5 Pluck). */
  blend: number;
  /** Transient declicking time 0..1000 (ADV). */
  declick: number;
  /** Ramping time -2000..2000 (ADV). */
  ramp: number;
  /** Prism add (0) / multiply (1) mode. */
  prismMode: number;
  /** Harmonic level to prism amount (GrittyFromVolSelect: 0 off, 1 on, 2 inverted). */
  prismVol: number;
  /** Clipping mode (High threshold, Soft low, Sharp low, Hard low, Subtraction). */
  clipMode: number;
  /** Sub-harmonic configuration (Around / Below fundamental). */
  subMode: number;
  /** Partial pitch distribution (HarmPitchModeSelect: 0 oct, 1 Hz). */
  pitchMode: number;
  /** Resynthesis method (Generic, High precision). */
  resynth: number;
  /** Denoising / thinning after resynthesis 0..1000. */
  denoise: number;
  /** Phaser type (FL stores PhaserTypeSelect.Value + 200; here the Value). */
  phType: number;
  /** Image display scale (BMPViewScaleSelect). */
  view: number;
  /** Global EQ mix 0..1 (wheel / 1000). */
  eqMix: number;
  /** Filter 1 / 2 shape (F1/F2TypeSelect.Value: selectable items only, headers not counted; FL Default 4 "Crude low pass" / 18 "Custom shape 2"). */
  f1Type: number;
  f2Type: number;
  /** Resonance 1 / 2 type (ResTypeSelect.Value + 100; FL Default 108 "Lowpass" / 111 "Custom shape 2"). */
  r1Type: number;
  r2Type: number;
  /** Side processing / invert right channel. */
  side: number;
  /** Pluck replaces blur decay. */
  pluckBlur: number;
  /** Auto-gain mode (Absolute, Relative). */
  agMode: number;
  /** FL part bytes +0x239..0x23b (unknown, saved). */
  x239: number;
  x23a: number;
  x23b: number;
  /** Unit processing order (12 unit ids). */
  order: number[];
  arts: HArt[];
  /** The 26 shaping maps (Local EQ, Harmonic phase, Timbre 1 / 2 harmonic level...). */
  maps: HEnv[];
  img: HImage;
  /** Resynthesis source sample (FL path as saved; '' = none). */
  src: string;
  /**
   * Curves that FL's preset holds as dense per-partial data (waveform import /
   * resynthesis: FL content, not in the converted presets; the default curve
   * stands in until the user imports them from FL): 'm<i>' shaping map i,
   * 'a<t>e' / 'a<t>l' / 'a<t>k<j>' articulator t's envelope / LFO / mapping j.
   */
  missing?: string[];
}

/** Global settings (FL: 0x18 + 0x3d bytes, info text, flags). */
export interface HGlobal {
  /** Effects processing order (6 unit ids). */
  fxOrder: number[];
  /** FL plug +0x11b8 / +0x11d0 (unknown, saved). */
  u11b8: number;
  u11d0: number;
  /** Monophonic (combo Value, separator not counted: 0 Off, 1 Kill same, 2 Kill all, 3 Release all). */
  mono: number;
  /** Voice randomness (combo Value, separator not counted: 0 Off, 1 Per voice, 2 Per part voice, 3 Per unison voice). */
  voiceRand: number;
  /** Highest partial count 3600..10800. */
  maxTones: number;
  /** Partials safety ceiling 0..2400. */
  safety: number;
  /** Envelope granularity 50..300. */
  grain: number;
  /** Computation precision (Average, High, Perfect). */
  precision: number;
  /** FL plug +0x1198 / +0x119c (saved view / monitoring settings). */
  u1198: number;
  u119c: number;
  /**
   * Distortion type: FL's combo Value, counting only selectable items (the "-"
   * separator shown in the menu is not counted): 0 Off, 1 Classic, 2 Hill, 3 Flat hat,
   * 4 Cube, 5 Log, 6 Softsat, 7 Rubber, 8 Ribbon, 9 Sincrush, 10 Bitcrush, 11 Bitjam.
   */
  distMode: number;
  /** Compression type (combo Value, separator not counted): 0 Off, 1 Limiting, 2 Warming, 3 Heating, 4 Burning. */
  compType: number;
  /** Same random input for all mappings. */
  sameRand: number;
  /** Smooth up XYZ modulation & filter frequency. */
  modSmooth: number;
  /** Threaded rendering. */
  threaded: number;
  /** Highest possible quality for offline rendering. */
  hq: number;
  /** GUI-link parts. */
  linkParts: number;
  /** FL's trailing flags byte (bit 0: plug +0x1190, bit 1: visual feedback scale). */
  flags: number;
  /** Info / comments text. */
  info: string;
}

/** View settings (not loaded by presets). */
export interface HView {
  /** Current part 0 = A, 1 = B. */
  part: number;
  /** Bottom page (ENV, IMG, FX, ADV). */
  page: number;
  /** Editor target (articulator / map index in FL's list order). */
  target: number;
  /** Articulator part (Envelope, LFO, mappings). */
  artPart: number;
  /** Keyboard shown. */
  kb: number;
  /** Visual feedback on. */
  vis: number;
}

export const H_ARTS = 43;
export const H_MAPS = 26;
export const H_ART_MAPS = 9;
