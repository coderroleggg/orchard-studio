// Sytrus voice: one note (one unison sub-voice), ported from Sytrus_x64's
// TriggerVoice (0x796e0) / voice init (0x7a3b0), control-rate block (0x80f40)
// and audio render (0x7f740 with the per-sample FM / RM kernel 0x7f050 and the
// plain table oscillator 0x7f430). Control ticks every `tick` samples (96 at
// 44.1 kHz, 8 with HQ envelopes) evaluate the articulators; per-sample linear
// ramps follow (volume, modulation depth, phase articulator, output gains,
// with FL's maximum ramp rates).

import type { Patch, ArtCfg, OpCfg } from './patch';
import { CENT_NP } from './patch';
import { EnvState, envEval, envStart, envRelease, lfoIncrement, LfoShape, curve } from './env';
import { TABLE_SIZE } from './shape';
import { FilterUnit } from './filter';
import { FpcRandom } from './random';
export { FpcRandom };

export interface VoiceLevels {
  pan: number;
  vol: number;
  pitch: number;
  fcut: number;
  fres: number;
}

/** Per-voice state of one articulator (FL's 0xc8-byte record). */
export class ArtVoice {
  env = new EnvState();
  lfo = new EnvState();
  /** Base value from the key / velocity / random / unison mappings. */
  base = 0;
  /** Final value this tick. */
  value = 0;
  cfg: ArtCfg | null = null;
  lfoShape = new LfoShape();
  lfoInc = 0;
}

/** Per-voice state of one unit (operator, filter or the effects unit; FL's 0xa38-byte record). */
export class UnitVoice {
  idx = 0;
  arts: ArtVoice[] = [];
  // operator
  phase = 0;
  baseInc = 0;
  pitchMul = 1;
  /** Global PITCH factor of operators 2..6 (op 1's pitch articulator). */
  pitchMul2 = 1;
  table: Float32Array | null = null;
  tsize = TABLE_SIZE;
  mask = TABLE_SIZE - 1;
  h1 = 0x7fffffff;
  h2 = 0x7fffffff;
  invSize = 1 / TABLE_SIZE;
  /** Phase increment in table samples for the current chunk. */
  incF = 0;
  vol = 0;
  volInc = 0;
  volEnd = 0;
  mod = 0;
  modInc = 0;
  modEnd = 0;
  phaseArt = 0;
  phaseArtInc = 0;
  fmAcc = 0;
  rmAcc = 0;
  /** FM targets (unit index, gain in table units of the target) and RM targets (unit index, g, b). */
  fmTo: number[] = [];
  fmG: number[] = [];
  /** FM gains scaled by the target's table size (set when the target picks its table). */
  fmGs: number[] = [];
  rmTo: number[] = [];
  rmG: number[] = [];
  rmB: number[] = [];
  perSample = false;
  active = false;
  /** Noise: wave gain, noise gain, offset. */
  nsWave = 1;
  nsGain = 0;
  nsOfs = 0;
  /** Declick / soften: smoothing whose coefficient ramps 0 -> 1 over fadeLeft samples (0x7fbd4). */
  fadeLeft = -1;
  fadeStep = 0;
  fadePos = 0;
  fadeLast = 0;
  /** CENTER: DC tracker state (0x8ca80). */
  dcLp = 0;
  dcVel = 0;
  /** Output gains (current, increment) for the main and FX buses. */
  oL = 0; oR = 0; oLt = 0; oRt = 0;
  xL = 0; xR = 0; xLt = 0; xRt = 0;
  buf: Float32Array;
  flt: FilterUnit | null = null;
  /** Plucked string (0x78f50): delay line with a one-pole loop filter, read at the note's rate. */
  pluckBuf: Float32Array | null = null;
  pluckLen = 0;
  pluckPtr = 0;
  pluckZ = 0;
  pluckA = 0;
  pluckB = 0;
  /** Loop gain the period was computed for ([+0x128]) and the period in delay-line samples per cycle ([+0x12c]). */
  pluckBc = 0;
  pluckPer = 0;
  /** Read rate: integer and 32-bit fraction per output sample, fraction accumulator, pending steps. */
  pluckInt = 0;
  pluckFracInc = 0;
  pluckFrac = 0;
  pluckPend = 0;
  pluckCur = 0;
  pluckPrev = 0;
  /** Pitch (cycles / sample) of the last chunk ([+0x36c]). */
  pitchCache = 0;
  /** The unit's audio for the current chunk (scratch shared by every voice: voices render one after another). */
  constructor(idx: number) { this.idx = idx; this.buf = UNIT_BUFS[idx]; }
}

/** Longest audio chunk of a voice (a control tick is split into chunks of at most this many samples). */
export const MAX_CHUNK = 1024;
const UNIT_BUFS = Array.from({ length: 10 }, () => new Float32Array(MAX_CHUNK));
/** Operator outputs of OSC unison voices before they are added to the sum in UNIT_BUFS (FL's second buffer set). */
const OSC_BUFS = Array.from({ length: 6 }, () => new Float32Array(MAX_CHUNK));
const IDX_BUF = new Int32Array(MAX_CHUNK + 4);
const FR_BUF = new Float32Array(MAX_CHUNK + 4);

export class SyVoice {
  free = true;
  /** Linked unison sub-voices share the note. */
  noteId = -1;
  key = 60;
  keyF = 0.5;
  vel = 0.78125;
  stage = 0;
  released = false;
  tickLeft = 0;
  first = true;
  units: UnitVoice[] = [];
  levels: VoiceLevels = { pan: 0, vol: 1, pitch: 0, fcut: 0, fres: 0 };
  liveLevels: VoiceLevels | null = null;
  // unison
  uPan = 0.5;
  uVol = 1;
  uPitch = 1;
  uPhase = 0;
  uPos = 0.5;
  uEnvVar = 1 / 128;
  sub = false;
  modXs = 256;
  modYs = 256;
  xIdx = 256;
  yIdx = 256;
  volLvl = 1;
  age = 0;
  /** Samples since the voice became silent after its release (end detection). */
  silent = 0;
  /** Portamento: pitch distance from the previous note in cents (0 = none). */
  portaDiff = 0;
  /**
   * OSC unison (TriggerVoice 0x79e04): 0 off; 1 first linked voice (its operators start the sum, x gain);
   * 2 further linked voices (add their operators x gain); 3 the note's master voice (adds its own, then runs
   * filters / output on the sum). Linked voices are rendered by their master, before it.
   */
  oscMode = 0;
  /** Unison volume applied to the operators in OSC unison ([+0x34]). */
  oscGain = 1;
  links: SyVoice[] = [];
  master: SyVoice | null = null;

  constructor() {
    for (let u = 0; u < 10; u++) {
      const uv = new UnitVoice(u);
      const n = u < 6 ? 6 : u < 9 ? 8 : 2;
      for (let a = 0; a < n; a++) uv.arts.push(new ArtVoice());
      if (u >= 6 && u < 9) uv.flt = new FilterUnit(MAX_CHUNK);
      this.units.push(uv);
    }
  }
}

/** Shared engine context the voices read. */
export interface SyCtx {
  sampleRate: number;
  patch: Patch;
  tick: number;
  /** Envelope time units per tick: absolute (0.5 s) and tempo (beats). */
  unitAbs: number;
  unitTempo: number;
  /** Max output-gain change per sample (0.001 x 44100 / sr) and per-sample ramp limit for unit params (x10). */
  maxGainStep: number;
  maxParamStep: number;
  smooth: number;
  rendering: boolean;
  rng: { s: number };
  /** FL's Pascal Random (random mappings). */
  random: FpcRandom;
  globalPhase: number;
  /** Global oversampling factor (1 live unless the patch asks for more) and the SVF coefficient tables for that rate. */
  osFactor: number;
  svf: [Float32Array, Float32Array];
  /** DECLICK length unit (96 x (rate / 44100)^2) and the CENTER tracker coefficient. */
  declickLen: number;
  dcK: number;
  /** Shared phase of a global LFO (unit, articulator), created at its start phase on first use. */
  globalLfo(u: number, a: number, shape: LfoShape, ph: number, speed: number, unit: number): number;
  outL: Float32Array;
  outR: Float32Array;
  fxL: Float32Array;
  fxR: Float32Array;
}

function combine(bip: boolean, v: number, m: number): number {
  return bip ? v + m : v * m;
}

/** Start a sub-voice for a note (FL's TriggerVoice + nested init 0x7a3b0). */
export function startVoice(
  v: SyVoice, c: SyCtx, lv: VoiceLevels, vel: number,
  uni: { pos: number; pan: number; vol: number; pitch: number; phase: number; envVar: number; sub: boolean },
  porta: { diff: number; keyPitch: number } | null = null,
): void {
  const P = c.patch;
  v.free = false;
  v.released = false;
  v.stage = 0;
  v.first = true;
  v.silent = 0;
  v.levels.pan = lv.pan; v.levels.vol = lv.vol; v.levels.pitch = lv.pitch; v.levels.fcut = lv.fcut; v.levels.fres = lv.fres;
  const pitchCents = lv.pitch + P.masterPitch;
  // with porta key tracking the key mappings follow the previous note (TriggerVoice 0x798b0)
  v.keyF = Math.max(0, (porta ? porta.keyPitch : pitchCents) * 0.01 + 60);
  // unison sub voices map an octave lower (0x7a224)
  if (uni.sub) v.keyF = Math.max(0, Math.fround(Math.fround(v.keyF) - 12));
  v.portaDiff = porta ? porta.diff : 0;
  v.key = roundEven(v.keyF);
  v.vel = vel;
  v.uPos = uni.pos; v.uPan = uni.pan; v.uVol = uni.vol; v.uPitch = uni.pitch; v.uPhase = uni.phase; v.uEnvVar = uni.envVar; v.sub = uni.sub;
  v.tickLeft = -c.tick;
  v.modXs = P.modX; v.modYs = P.modY;
  v.xIdx = clampIdx(v.modXs + lv.fcut * 256);
  v.yIdx = clampIdx(v.modYs + lv.fres * 256);
  for (let u = 0; u < 10; u++) {
    const uv = v.units[u];
    const arts = P.arts[u];
    for (let a = 0; a < arts.length; a++) {
      const av = uv.arts[a];
      const cfg = arts[a];
      av.cfg = cfg;
      initArt(av, cfg, c, v, u, a);
    }
  }
  // operators
  for (let o = 0; o < 6; o++) {
    const uv = v.units[o];
    const op = P.ops[o];
    uv.active = P.uOut[o] !== 0 || P.uFx[o] !== 0 || anyRow(P, o) || anyFilterSend(P, o);
    uv.baseInc = baseInc(c, op.ratioInc, op.ofsInc, pitchCents, v.uPitch);
    uv.pitchMul = Math.fround(Math.exp(Math.fround(uv.arts[3].value * op.pe2)));
    uv.vol = 0; uv.volEnd = 0; uv.volInc = 0;
    const volTarget = uv.arts[1].value * op.vol;
    uv.vol = volTarget; uv.volEnd = volTarget; uv.volInc = 0;
    const m = clamp01(uv.arts[2].value);
    uv.mod = m; uv.modEnd = m; uv.modInc = 0;
    uv.phaseArt = uv.arts[4].value;
    uv.phaseArtInc = 0;
    let ph = op.phase + v.uPhase + uv.phaseArt;
    if (op.glob) ph += c.globalPhase * uv.baseInc;
    ph = ph + (64 - roundEven(ph));
    uv.phase = ph;
    uv.fmAcc = 0;
    uv.rmAcc = uv.mod;
    uv.table = null;
    uv.h1 = uv.h2 = 0x7fffffff;
    // noise
    const s = op.ns * 0.0078125;
    let s8 = 0;
    if (op.ns > 0) s8 = s === 1 ? 1 : Math.fround(Math.fround(Math.exp(Math.fround(s * 2.397895336151123)) - 1) * Math.fround(0.1));
    uv.nsWave = Math.fround(1 - s8);
    let g = s8;
    if (!op.pluck) g = Math.fround(g * Math.sqrt(c.sampleRate / 44100));
    uv.nsOfs = g;
    uv.nsGain = op.pluck ? 0 : Math.fround(g * 4.656612873077393e-10);
    // pitch of the first chunk ([+0x36c]) and the plucked string
    uv.pitchCache = Math.fround(uv.baseInc * uv.pitchMul);
    if (P.g.gPitch && o > 0) uv.pitchCache = Math.fround(uv.pitchCache * v.units[0].pitchMul);
    uv.pluckLen = 0;
    if (op.pluck && uv.active) pluckInit(uv, op, c);
    // declick / soften (0x7b518): length 96 x (sr / 44100)^2 samples for DECLICK, plus SOFTEN x (0.775 - velocity)
    const unit = c.declickLen;
    let fade = 0;
    if (P.g.soften > 0) {
      fade = Math.fround(unit * Math.fround((0.775 - Math.fround(v.vel)) * P.g.soften));
      if (!(fade > 0)) fade = 0;
    }
    if (op.declick) fade = Math.fround(fade + unit);
    const len = roundEven(fade);
    uv.fadeLeft = len > 0 && (op.declick || P.g.soften > 0) ? len : -1;
    uv.fadeStep = uv.fadeLeft > 0 ? Math.fround(1 / uv.fadeLeft) : 0;
    uv.fadePos = 0;
    uv.fadeLast = 0;
    uv.dcLp = 0; uv.dcVel = 0;
    uv.oL = uv.oR = 0;
    uv.xL = uv.xR = 0;
  }
  for (let f = 0; f < 3; f++) {
    const uv = v.units[6 + f];
    // a filter runs when it has an input (FL's routing 0x7c320): an operator send or the previous filter's NEXT
    let has = false;
    for (let o = 0; o < 6; o++) if (P.fm[(6 + f) * 9 + o] !== 0) { has = true; break; }
    if (!has && f > 0 && v.units[5 + f].active && P.flt[f - 1].next !== 0) has = true;
    uv.active = has;
    uv.flt!.reset(P.flt[f], c, uv.arts[1].value, uv.arts[7].value);
    uv.oL = uv.oR = 0;
    uv.xL = uv.xR = 0;
  }
  buildRouting(v, P);
}

function anyRow(P: Patch, o: number): boolean {
  for (let r = 0; r < 6; r++) if (P.fm[r * 9 + o] !== 0 || P.rm[r * 9 + o] !== 0) return true;
  return false;
}

function anyFilterSend(P: Patch, o: number): boolean {
  for (let r = 6; r < 9; r++) if (P.fm[r * 9 + o] !== 0) return true;
  return false;
}

function clampIdx(x: number): number {
  const i = roundEven(x);
  return i < 0 ? 0 : i > 512 ? 512 : i;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Base phase increment (cycles / sample) of an operator (0x80ea0). */
function baseInc(c: SyCtx, ratioInc: number, ofsInc: number, cents: number, uPitch: number): number {
  void c;
  // FL's 0x80ea0: exp(cents) x ratio (double) x unison detune + offset, stored as float
  const v = Math.fround(Math.exp(Math.fround(cents) * CENT_NP) * ratioInc * Math.fround(uPitch) + ofsInc);
  return v > 0 ? v : 0;
}

/** Plucked string start (0x78f50): one cycle of the waveform (2 x 44100 / f samples, mixed with noise by NS), DC removed. */
function pluckInit(uv: UnitVoice, op: OpCfg, c: SyCtx): void {
  const f = Math.fround(uv.baseInc * Math.fround(c.sampleRate));
  let len = roundEven(Math.fround(88200 / f));
  if (!(len >= 2)) len = 2;
  if (len > 65536) len = 65536;
  uv.pluckLen = len;
  if (!uv.pluckBuf || uv.pluckBuf.length < len) uv.pluckBuf = new Float32Array(Math.max(len, 1024));
  uv.pluckBc = 2147483648;
  pluckRetune(uv);
  const buf = uv.pluckBuf;
  let noise = 0, wave = 0;
  if (op.ns !== 0) {
    const sv = Math.fround(op.ns * 0.0078125);
    const s9 = sv === 1 ? 1 : Math.fround((Math.exp(Math.fround(sv * 2.397895336151123)) - 1) * Math.fround(0.1));
    wave = Math.fround(1 - s9);
    noise = Math.fround(s9 * 1.5);
  }
  let ph = roundEven(uv.phase * 4294967296) % 4294967296;
  if (ph < 0) ph += 4294967296;
  const step = roundEven(Math.fround(4294967296 / uv.pluckPer)) >>> 0;
  const t = op.shape!.table;
  if (noise !== 0) {
    // ippsRandUniform_Direct_32f(buf, len, -1, 1, seed = start phase) as FL's IPP library computes it: four
    // LCG lanes (x 1664525 + 1013904223) seeded from the seed, 23-bit uniforms u, written as u x (high - low) - low
    const st = PLUCK_RNG;
    st[0] = (ph ^ 0x1000000) >>> 0; st[1] = (ph ^ 0x10000) >>> 0; st[2] = (ph ^ 8) >>> 0; st[3] = ph >>> 0;
    for (let i = 0; i < len; i += 4) {
      for (let l = 0; l < 4; l++) {
        st[l] = (Math.imul(st[l], 1664525) + 1013904223) >>> 0;
        if (i + l < len) buf[i + l] = Math.fround((st[l] >>> 9) * 1.1920928955078125e-7 * 2 + 1);
      }
    }
  }
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const i0 = ph >>> 18, i1 = ((ph + 0x40000) >>> 0) >>> 18;
    const s0 = t[i0];
    const d = Math.fround(Math.fround(t[i1] - s0) * Math.fround(ph & 0x3ffff));
    let x = Math.fround(s0 + d * 3.814697265625e-6);
    if (noise !== 0) x = Math.fround(Math.fround(buf[i] * noise) + Math.fround(x * wave));
    buf[i] = x;
    sum = Math.fround(sum + x);
    ph = (ph + step) >>> 0;
  }
  const mean = Math.fround(sum / len);
  for (let i = 0; i < len; i++) buf[i] = Math.fround(buf[i] - mean);
  uv.pluckZ = buf[len - 1];
  uv.pluckPtr = 0;
  uv.pluckFrac = 0;
  uv.pluckPend = 1;
  uv.pluckCur = 0;
  uv.pluckPrev = 0;
}

const PLUCK_RNG = new Uint32Array(4);

/** Loop filter from the damp articulator and the read rate from the pitch (0x79310). */
function pluckRetune(uv: UnitVoice): void {
  const damp = clamp01(uv.arts[5].value);
  uv.pluckA = Math.fround(0.01 + damp * 0.99);
  uv.pluckB = Math.fround(1 - uv.pluckA);
  if (uv.pluckBc !== uv.pluckB) {
    uv.pluckBc = uv.pluckB;
    // period = line length + the loop filter's delay
    const x = 1 / uv.pluckLen, b = uv.pluckB;
    uv.pluckPer = Math.fround(uv.pluckLen * (1 + (b * Math.sin(x)) / (1 - b * Math.cos(x))));
  }
  const p = uv.pitchCache > 0 ? uv.pitchCache : 0;
  const r = Math.fround(uv.pluckPer * p);
  const v = Math.trunc(r * 4294967296);
  uv.pluckInt = Math.floor(v / 4294967296);
  uv.pluckFracInc = v - uv.pluckInt * 4294967296;
}

/** FM / RM destination lists (0x7c320). */
function buildRouting(v: SyVoice, P: Patch): void {
  for (let s = 0; s < 6; s++) {
    const src = v.units[s];
    src.fmTo.length = 0; src.fmG.length = 0; src.fmGs.length = 0;
    src.rmTo.length = 0; src.rmG.length = 0; src.rmB.length = 0;
    for (let t = 0; t < 6; t++) {
      const f = P.fm[t * 9 + s];
      if (f !== 0) {
        src.fmTo.push(t);
        src.fmG.push(t === s ? Math.fround(Math.fround(f * 35) * 0.0078125) : Math.fround(f * 4));
        src.fmGs.push(0);
      }
      const r = P.rm[t * 9 + s];
      if (r !== 0) {
        src.rmTo.push(t);
        src.rmG.push(r);
        src.rmB.push(1 - Math.abs(r));
      }
    }
    src.perSample = src.fmTo.length > 0 || src.rmTo.length > 0 || src.nsGain !== 0 || P.ops[s].pluck;
  }
  // receivers of FM / RM are per-sample too
  for (let s = 0; s < 6; s++) {
    for (const t of v.units[s].fmTo) v.units[t].perSample = true;
    for (const t of v.units[s].rmTo) v.units[t].perSample = true;
  }
}

/** Articulator voice init (0x279340 + ADSR offsets / velocity of 0x7a3b0). */
function initArt(av: ArtVoice, cfg: ArtCfg, c: SyCtx, v: SyVoice, u: number, a: number): void {
  const P = c.patch;
  const env = cfg.env, lfo = cfg.lfo;
  // base: key map (key / 120), velocity map, random, unison
  const ctr = cfg.bip ? 0.5 : 0;
  let base = cfg.maps[0].readAt(v.keyF / 120) - ctr;
  base = combine(cfg.bip, base, cfg.maps[1].readAt(v.vel) - ctr);
  if (P.g.rand) {
    const m = cfg.maps[4];
    if (!isFlat(m)) {
      const x = c.random.random();
      base = combine(cfg.bip, base, m.readAt(x) - ctr);
    }
  }
  base = combine(cfg.bip, base, cfg.maps[5].readAt(v.uPos) - ctr);
  av.base = base;
  const unitE = env.flags & 1 ? c.unitTempo : c.unitAbs;
  // envelope time scales and the main page ADSR offsets
  const sc = [cfg.p[0] / 128, cfg.p[1] / 128, cfg.p[2] / 128, cfg.p[3] / 128];
  if (env.enabled && cfg.adsr >= 0) {
    const o = cfg.adsr * 4;
    const f = env.flags & 2 ? 1 / 128 : v.uEnvVar;
    sc[0] = Math.fround(sc[0] * P.adsr[o] * f);
    sc[1] = Math.fround(sc[1] * P.adsr[o + 1] * (0.015625 - f));
    sc[2] = Math.fround(sc[2] + P.adsr[o + 2] * 0.0078125);
    sc[3] = Math.fround(sc[3] * P.adsr[o + 3] * 0.0078125);
  }
  if (env.enabled && P.g.velAtt & 1) sc[0] *= 2 - v.vel * 2;
  // portamento (0x7aa18): the operators' pitch envelopes start offset by the distance from the previous
  // note (1 octave = 0.5), which the point weights fade out over the attack; PORTA VAR scales the attack
  let ofs = 0;
  if (u < 6 && a === 3 && v.portaDiff !== 0 && P.ops[u].pe !== 0) {
    let d = v.portaDiff;
    const lim = P.g.portaLimit | 0;
    const sign = d === 0 ? 0 : d < 0 ? -1 : 1;
    if (lim >= 2) {
      const m = Math.fround((6 - lim) * 100);
      d = Math.fround(sign * (Math.abs(d) < m ? Math.abs(d) : m));
    } else if (lim === 1) {
      const step = sign * 1200;
      while (Math.abs(d) > 1250) d = Math.fround(d - step);
    }
    if (d !== 0) {
      ofs = Math.fround(d * 0.0004166666666666667);
      if (P.g.portaVar) sc[0] = Math.fround(Math.fround(Math.fround(sc[0] * Math.abs(d)) * P.ops[u].pe) * 6.944444444444445e-7);
    }
  }
  av.env.reset();
  if (env.enabled) envStart(env, av.env, sc, unitE, ofs);
  if (env.enabled && (P.g.velAtt & 2) && env.decay >= 0) {
    const t = env.timeTo(env.decay) * sc[0] * v.vel;
    if (t > 0) envEval(env, av.env, t / unitE, unitE);
  }
  av.lfo.reset();
  if (lfo.enabled) {
    // TMLFO init (0x277db0): global LFOs (flag 2) start at the free-running shared phase
    const unitL = lfo.flags & 1 ? c.unitTempo : c.unitAbs;
    envStart(lfo, av.lfo, [1, 1, 0, 1], unitL);
    av.lfoShape.setup(cfg.p[5], cfg.p[6], cfg.p[7], !!(lfo.flags & 4));
    av.lfoInc = lfo.flags & 8 ? 0 : lfoIncrement(cfg.p[4], unitL);
    if (lfo.flags & 2) av.lfo.phase = c.globalLfo(u, a, av.lfoShape, lfo.ph, cfg.p[4], unitL);
    else av.lfo.phase = (av.lfoShape.startPhase() + lfo.ph) >>> 0;
    av.lfo.lfoOut = 0;
  }
  av.value = computeArt(av, cfg, v);
}

function isFlat(m: { pts: { y: number }[] }): boolean {
  const y = m.pts[0].y;
  for (const p of m.pts) if (p.y !== y) return false;
  return true;
}

/** Final articulator value: base, Mod X / Y maps, envelope, LFO (0x80f40 + TOpArticulator.Process). */
function computeArt(av: ArtVoice, cfg: ArtCfg, v: SyVoice): number {
  let x = av.base;
  if (cfg.xTab) x = combine(cfg.bip, x, cfg.xTab[v.xIdx]);
  if (cfg.yTab) x = combine(cfg.bip, x, cfg.yTab[v.yIdx]);
  if (cfg.env.enabled) {
    const e = av.env.out;
    x = cfg.bip ? x + (e - 0.5) * cfg.ea : x * e * cfg.ea;
  }
  if (cfg.lfo.enabled) {
    const l = av.lfo.lfoOut;
    x = cfg.bip ? x + l * cfg.la : x * (l * cfg.la * 2 + 1);
  }
  return x;
}

/** Note off (Voice_Release 0x7baa0). */
export function releaseVoice(v: SyVoice, c: SyCtx, relTime: number): void {
  if (v.released) return;
  v.released = true;
  if (v.stage < 5) v.stage = 5;
  const P = c.patch;
  for (let u = 0; u < 10; u++) {
    const uv = v.units[u];
    for (let a = 0; a < uv.arts.length; a++) {
      const av = uv.arts[a], cfg = av.cfg!;
      if (P.g.relRel) { av.env.scale[3] *= relTime; av.lfo.scale[3] *= relTime; }
      if (cfg.env.enabled) envRelease(cfg.env, av.env);
      if (cfg.lfo.enabled) envRelease(cfg.lfo, av.lfo);
    }
  }
}

/** One control tick for a voice (0x80f40). step: 0 at the first tick, 1 after. */
function controlTick(v: SyVoice, c: SyCtx, step: number): void {
  const P = c.patch;
  const T = c.tick;
  // Mod X / Y smoothing
  if (P.g.modSmooth) {
    v.modXs = P.modX + (v.modXs - P.modX) * c.smooth;
    v.modYs = P.modY + (v.modYs - P.modY) * c.smooth;
  } else { v.modXs = P.modX; v.modYs = P.modY; }
  const lv = v.liveLevels ?? v.levels;
  v.xIdx = clampIdx(v.modXs + lv.fcut * 256);
  v.yIdx = clampIdx(v.modYs + lv.fres * 256);
  // every unit's used articulators run, active or not; once released the voice ends when all of
  // their envelopes and LFO amplitude curves have finished (0x81178 / 0x814c8)
  let allDone = true;
  for (let u = 0; u < 10; u++) {
    const uv = v.units[u];
    for (let a = 0; a < uv.arts.length; a++) {
      const av = uv.arts[a], cfg = av.cfg!;
      if (cfg.env.enabled) {
        envEval(cfg.env, av.env, step, cfg.env.flags & 1 ? c.unitTempo : c.unitAbs);
        if (av.env.stage < 9) allDone = false;
      }
      if (cfg.lfo.enabled) {
        // TMLFO eval (0x277e60): the phase only runs once the amplitude curve has left its first point
        const ls = av.lfo;
        let ps = step;
        if (ls.cur === 0 && ls.stage < 9 && ls.pos < 1) { ps = step + (ls.pos - 1) / ls.inc; if (!(ps > 0)) ps = 0; }
        envEval(cfg.lfo, ls, step, cfg.lfo.flags & 1 ? c.unitTempo : c.unitAbs);
        if (!(ls.cur === 0 && ls.stage < 9 && ls.pos < 1)) {
          ls.phase = (ls.phase + roundEven(ps * av.lfoInc)) >>> 0;
          // the LFO amplitude curve is centred at 0.5 for every articulator (TMLFO constructor)
          ls.lfoOut = Math.fround(av.lfoShape.value(ls.phase) * Math.fround(ls.out - 0.5));
        }
        if (ls.stage < 9) allDone = false;
      }
      av.value = computeArt(av, cfg, v);
    }
  }
  if (v.released && allDone && v.stage < 9) v.stage = 9;
  const lvVol = lv.vol * P.masterVol;
  v.volLvl = lvVol;
  // operators
  const gpMul = P.g.gPitch ? Math.fround(Math.exp(Math.fround(v.units[0].arts[3].value * P.ops[0].pe2))) : 1;
  for (let o = 0; o < 6; o++) {
    const uv = v.units[o];
    if (!uv.active) continue;
    const op = P.ops[o];
    const mTarget = clamp01(uv.arts[2].value);
    rampTo(uv, 'mod', mTarget, T, c.maxParamStep);
    uv.pitchMul = Math.fround(Math.exp(Math.fround(uv.arts[3].value * op.pe2)));
    uv.pitchMul2 = o > 0 && P.g.gPitch ? gpMul : 1;
    const pa = uv.arts[4].value;
    uv.phaseArtInc = (pa - uv.phaseArt) / T;
    uv.phaseArt = pa;
    const vTarget = uv.arts[1].value * op.vol;
    rampTo(uv, 'vol', vTarget, T, c.maxParamStep);
    // plucked damp articulator (0x81634): new loop filter
    if (uv.pluckLen > 0) {
      const dc = uv.arts[5].cfg!;
      if (dc.env.enabled || dc.lfo.enabled || dc.xTab || dc.yTab) pluckRetune(uv);
    }
  }
  // output and FX gains (circular pan law)
  const fxU = v.units[9];
  const fxPanArt = fxU.arts[0].value, fxVolArt = fxU.arts[1].value;
  for (let u = 0; u < 9; u++) {
    const uv = v.units[u];
    if (!uv.active) continue;
    const panArt = uv.arts[0].value;
    let gl = 0, gr = 0;
    if (P.uOut[u] !== 0 && v.stage < 9) {
      let p = (lv.pan * 0.5 + v.uPan + P.uPan[u] + panArt) * 2 - 1;
      p = p < -1 ? -1 : p > 1 ? 1 : p;
      const g = lvVol * v.uVol * P.uOut[u];
      const ang = (p + 1) * 0.7853981633974483;
      gl = Math.cos(ang) * g; gr = Math.sin(ang) * g;
    }
    setGain(uv, 0, gl, gr, v.first);
    gl = 0; gr = 0;
    if (P.uFx[u] !== 0 && v.stage < 9) {
      let p = (lv.pan * 0.5 + v.uPan + P.uPan[u] + P.fxPan + panArt + fxPanArt) * 2 - 1;
      p = p < -1 ? -1 : p > 1 ? 1 : p;
      const g = lvVol * v.uVol * P.uFx[u] * fxVolArt;
      const ang = (p + 1) * 0.7853981633974483;
      gl = Math.cos(ang) * g; gr = Math.sin(ang) * g;
    }
    setGain(uv, 1, gl, gr, v.first);
  }
  v.first = false;
}

/** Per-sample ramp toward the tick's target (FL's 0x8ec40: no end tracking, the kernels accumulate). */
function rampTo(uv: UnitVoice, which: 'vol' | 'mod', target: number, T: number, maxStep: number): void {
  target = Math.fround(target);
  if (Math.abs(target) < 5.960464477539063e-8) target = 0;
  if (which === 'vol') {
    if (Math.abs(uv.vol) < 5.960464477539063e-8) uv.vol = 0;
    let inc = Math.fround(target - uv.vol);
    if (inc !== 0) {
      inc = Math.fround(inc / T);
      if (Math.abs(inc) > maxStep) inc = inc < 0 ? -maxStep : maxStep;
    }
    uv.volInc = inc;
  } else {
    if (Math.abs(uv.mod) < 5.960464477539063e-8) uv.mod = 0;
    let inc = Math.fround(target - uv.mod);
    if (inc !== 0) {
      inc = Math.fround(inc / T);
      if (Math.abs(inc) > maxStep) inc = inc < 0 ? -maxStep : maxStep;
    }
    uv.modInc = inc;
  }
}

function setGain(uv: UnitVoice, bus: number, gl: number, gr: number, first: boolean): void {
  gl = Math.fround(gl); gr = Math.fround(gr);
  if (bus === 0) {
    if (first) { uv.oL = gl; uv.oR = gr; }
    uv.oLt = gl; uv.oRt = gr;
  } else {
    if (first) { uv.xL = gl; uv.xR = gr; }
    uv.xLt = gl; uv.xRt = gr;
  }
}


/** Render n samples of a voice into the engine buses (0x80f40 / 0x7f740). Returns false once finished. */
function tickIfDue(v: SyVoice, c: SyCtx): void {
  if (v.tickLeft > 0) return;
  let step = 1;
  if (v.tickLeft < 0) { v.tickLeft = -v.tickLeft; step = 0; } else v.tickLeft = c.tick;
  if (step === 0) { v.first = true; controlTick(v, c, 0); }
  else controlTick(v, c, 1);
}

export function renderVoice(v: SyVoice, c: SyCtx, off: number, n: number): boolean {
  let i = 0;
  const links = v.links;
  while (i < n) {
    tickIfDue(v, c);
    for (let k = 0; k < links.length; k++) tickIfDue(links[k], c);
    const cnt = Math.min(n - i, v.tickLeft, MAX_CHUNK);
    // OSC unison: the linked voices' operators first (0x82078), then the master (0x820a0)
    for (let k = 0; k < links.length; k++) {
      const l = links[k];
      audio(l, c, off + i, cnt);
      l.tickLeft -= cnt;
    }
    audio(v, c, off + i, cnt);
    v.tickLeft -= cnt;
    i += cnt;
  }
  if (!finished(v)) return true;
  for (let k = 0; k < links.length; k++) if (!finished(links[k])) return true;
  return false;
}

/** Finished: released envelopes done and the output gains at 0. */
function finished(v: SyVoice): boolean {
  if (v.stage < 9) return false;
  for (let u = 0; u < 9; u++) {
    const uv = v.units[u];
    if (!uv.active) continue;
    if (uv.oL !== 0 || uv.oR !== 0 || uv.xL !== 0 || uv.xR !== 0) return false;
  }
  return true;
}

/** Audio for cnt samples of one voice (0x7f740). */
function audio(v: SyVoice, c: SyCtx, off: number, cnt: number): void {
  const P = c.patch;
  const sizeBL = c.rendering ? TABLE_SIZE : 4096;
  const bufs = v.units;
  // OSC unison voices other than the first render their operators into the second buffer set
  const second = v.oscMode >= 2;
  for (let o = 0; o < 6; o++) bufs[o].buf = second ? OSC_BUFS[o] : UNIT_BUFS[o];
  // table selection (0x79450, once per voice) and the per-chunk increment / phase wrap (0x7f86c)
  for (let o = 0; o < 6; o++) {
    const uv = bufs[o];
    if (!uv.active) continue;
    const op = P.ops[o];
    let pitch = Math.fround(uv.baseInc * uv.pitchMul);
    if (uv.pitchMul2 !== 1) pitch = Math.fround(pitch * uv.pitchMul2);
    if (pitch !== uv.pitchCache) {
      uv.pitchCache = pitch;
      if (uv.pluckLen > 0) pluckRetune(uv);
    }
    if (!uv.table) {
      let h1 = 0x7fffffff, h2 = 0x7fffffff;
      if (!op.pluck && op.blimit) {
        let f = Math.fround(pitch * Math.fround(c.sampleRate));
        if (!(f > 0.1)) f = Math.fround(0.1);
        const d3 = Math.fround(1 / f);
        const nyq = P.g.gibbs ? 22050 : Math.fround(c.sampleRate * 0.5);
        const dd = (nyq - 18000) * 0.25;
        h1 = Math.trunc((18000 + dd) * d3) + 1;
        h2 = Math.trunc((18000 + dd * 3) * d3) + 1;
      }
      uv.h1 = h1; uv.h2 = h2;
      const tab = op.shape!.tableFor(h1, h2, sizeBL);
      const size = tab.length - 1;
      uv.table = tab; uv.tsize = size; uv.mask = size - 1;
      uv.invSize = Math.fround(1 / size);
      uv.phase = uv.phase * size;
      // FM gains into this operator are kept in its table units
      for (let s2 = 0; s2 < 6; s2++) {
        const src = bufs[s2];
        for (let r = 0; r < src.fmTo.length; r++) if (src.fmTo[r] === o) src.fmGs[r] = Math.fround(src.fmG[r] * Math.fround(size));
      }
    }
    let inc = Math.fround(Math.fround(pitch + uv.phaseArtInc) * Math.fround(uv.tsize));
    const lim = Math.fround(uv.tsize >> 1);
    if (inc >= lim) inc = lim;
    uv.incF = inc;
    const k = roundEven(uv.phase * uv.invSize);
    uv.phase = uv.phase + uv.tsize * ((uv.perSample ? 64 : 1) - k);
  }
  // plain table operators, then the per-sample (FM / RM / noise) ones interleaved
  for (let o = 0; o < 6; o++) {
    const uv = bufs[o];
    if (!uv.active || uv.perSample) continue;
    plainOp(uv, cnt, IDX_BUF, FR_BUF);
  }
  let anyPS = false;
  for (let o = 0; o < 6; o++) if (bufs[o].active && bufs[o].perSample) { anyPS = true; break; }
  if (anyPS) {
    for (let i = 0; i < cnt; i++) {
      for (let o = 0; o < 6; o++) {
        const uv = bufs[o];
        if (!uv.active || !uv.perSample) continue;
        fmSample(v, uv, c, i);
      }
    }
  }
  // OSC unison (0x7fa54): operator outputs summed over the note's voices with their unison volumes
  const om = v.oscMode;
  if (om !== 0) {
    const g = v.oscGain;
    for (let o = 0; o < 6; o++) {
      const uv = bufs[o];
      if (!uv.active) continue;
      const sum = UNIT_BUFS[o];
      if (om === 1) {
        for (let i = 0; i < cnt; i++) sum[i] = Math.fround(sum[i] * g); // ippsMulC_32f
      } else {
        const b = uv.buf;
        for (let i = 0; i < cnt; i++) sum[i] = Math.fround(sum[i] + b[i] * g); // ippsAddProductC_32f (fused)
        uv.buf = sum;
      }
    }
    if (om !== 3) return;
  }
  // CENTER (DC tracker subtracted, 0x8ca80)
  for (let o = 0; o < 6; o++) {
    const uv = bufs[o];
    if (!uv.active || !P.ops[o].center) continue;
    const b = uv.buf, k = c.dcK, damp = 0.9599999785423279;
    let lp = uv.dcLp, vel = uv.dcVel;
    for (let i = 0; i < cnt; i++) {
      const x = b[i];
      vel += (x - lp) * k;
      lp += vel;
      vel *= damp;
      b[i] = Math.fround(x - lp);
    }
    uv.dcLp = Math.abs(lp) < 5.960464477539063e-8 ? 0 : lp;
    uv.dcVel = Math.abs(vel) < 5.960464477539063e-8 ? 0 : vel;
  }
  // declick / soften (0x7fbd4)
  for (let o = 0; o < 6; o++) {
    const uv = bufs[o];
    if (!uv.active || uv.fadeLeft <= 0) continue;
    const b = uv.buf;
    uv.fadeLeft -= cnt;
    let k = cnt;
    if (uv.fadeLeft < 0) k += uv.fadeLeft;
    let s0 = uv.fadeLast, g = uv.fadePos;
    const st = uv.fadeStep;
    for (let i = 0; i < k; i++) {
      s0 = Math.fround(s0 + Math.fround(g * Math.fround(b[i] - s0)));
      b[i] = s0;
      g = Math.fround(g + st);
    }
    uv.fadeLast = s0;
    uv.fadePos = Math.fround(uv.fadePos + Math.fround(st * k));
  }
  // filters: input = operator sends (+ previous filter x NEXT), then volume, filter, waveshaper
  for (let f = 0; f < 3; f++) {
    const uv = bufs[6 + f];
    if (!uv.active) continue;
    const b = uv.buf;
    let firstSrc = true;
    for (let o = 0; o < 7 + f; o++) {
      let g: number;
      if (o < 6) { g = P.fm[(6 + f) * 9 + o]; if (g === 0 || !bufs[o].active) continue; } else {
        if (o !== 5 + f || f === 0) continue;
        g = P.flt[f - 1].next;
        if (g === 0 || !bufs[o].active) continue;
      }
      const s = bufs[o].buf;
      if (firstSrc) { for (let i = 0; i < cnt; i++) b[i] = Math.fround(s[i] * g); firstSrc = false; }
      else for (let i = 0; i < cnt; i++) b[i] = Math.fround(b[i] + s[i] * g);
    }
    if (firstSrc) b.fill(0, 0, cnt);
    uv.flt!.process(uv, v, P, c, f, cnt);
  }
  // mix to the buses
  for (let u = 0; u < 9; u++) {
    const uv = bufs[u];
    if (!uv.active) continue;
    mixOut(uv, v, c, off, cnt);
  }
}

/** Plain table operator (0x7f430): positions as floats in groups of 4, linear interpolation, ramped volume. */
function plainOp(uv: UnitVoice, cnt: number, idxBuf: Int32Array, frBuf: Float32Array): void {
  const t = uv.table!, mask = uv.mask, b = uv.buf;
  const inc = uv.incF;
  const ph = uv.phase;
  uv.phase = ph + inc * cnt;
  let p0 = Math.fround(ph), p1 = Math.fround(ph + inc), p2 = Math.fround(ph + 2 * inc), p3 = Math.fround(ph + 3 * inc);
  const inc4 = 4 * inc;
  for (let i = 0; i < cnt; i += 4) {
    let k = Math.trunc(p0); idxBuf[i] = k & mask; frBuf[i] = Math.fround(p0 - k);
    k = Math.trunc(p1); idxBuf[i + 1] = k & mask; frBuf[i + 1] = Math.fround(p1 - k);
    k = Math.trunc(p2); idxBuf[i + 2] = k & mask; frBuf[i + 2] = Math.fround(p2 - k);
    k = Math.trunc(p3); idxBuf[i + 3] = k & mask; frBuf[i + 3] = Math.fround(p3 - k);
    p0 = Math.fround(p0 + inc4); p1 = Math.fround(p1 + inc4); p2 = Math.fround(p2 + inc4); p3 = Math.fround(p3 + inc4);
  }
  let vol = uv.vol;
  const vi = uv.volInc;
  for (let i = 0; i < cnt; i++) {
    vol = Math.fround(vol + vi);
    const k = idxBuf[i], fr = frBuf[i];
    b[i] = Math.fround(Math.fround(Math.fround(t[k] * Math.fround(1 - fr)) + Math.fround(t[k + 1] * fr)) * vol);
  }
  uv.vol = vol;
  // mod ramps continue for idle receivers
  uv.mod += uv.modInc * cnt;
}

/** One sample of an FM / RM / noise operator (0x7f050). */
function fmSample(v: SyVoice, uv: UnitVoice, c: SyCtx, i: number): void {
  let w: number;
  if (uv.pluckLen > 0) {
    // plucked string (0x7f1b8): advance the line by the read rate, filtering what is read, then interpolate
    let d3 = uv.pluckCur;
    const sum = uv.pluckFrac + uv.pluckFracInc;
    const carry = sum >= 4294967296 ? 1 : 0;
    uv.pluckFrac = carry ? sum - 4294967296 : sum;
    const n = uv.pluckInt + uv.pluckPend + carry;
    if (n !== 0) {
      const buf = uv.pluckBuf!, len = uv.pluckLen, a = uv.pluckA, b = uv.pluckB;
      let ptr = uv.pluckPtr, z = uv.pluckZ;
      for (let k = 0; k < n; k++) {
        uv.pluckPrev = Math.fround(d3);
        const x = buf[ptr];
        d3 = x;
        z = Math.fround(x * a + Math.fround(z * b));
        buf[ptr] = z;
        if (++ptr >= len) ptr = 0;
      }
      uv.pluckPtr = ptr; uv.pluckZ = z;
      uv.pluckCur = Math.fround(d3);
      uv.pluckPend = 0;
    }
    const prev = uv.pluckPrev;
    // the fraction is read as a signed 32-bit value
    const fr = Math.fround((uv.pluckFrac | 0) * 2.3283064365386963e-10);
    w = (d3 - prev) * fr + prev;
  } else {
    const t = uv.table!;
    const d9 = Math.fround(uv.fmAcc * uv.mod);
    const d10 = uv.phase;
    uv.phase = d10 + uv.incF;
    const pos = d9 + d10;
    uv.fmAcc = 0;
    const ip = roundEven(pos - 0.5);
    const k = ip & uv.mask;
    const a = t[k];
    w = (pos - ip) * (t[k + 1] - a) + a;
  }
  if (uv.nsGain !== 0) {
    // FL's global noise generator (zero at load, read as signed: 0x7f15c); the offset leaves a DC of -gain
    c.rng.s = (Math.imul(c.rng.s, 0x08088405) + 1) | 0;
    w = w * uv.nsWave + Math.fround(Math.fround(c.rng.s) * uv.nsGain) - uv.nsOfs;
  }
  const d12 = Math.fround(1 + uv.rmAcc);
  const d13 = uv.mod;
  uv.rmAcc = d13;
  uv.mod = Math.fround(d13 + uv.modInc);
  const out = w * (d12 - d13);
  for (let r = 0; r < uv.rmTo.length; r++) {
    const tgt = v.units[uv.rmTo[r]];
    tgt.rmAcc = Math.fround(tgt.rmAcc * (uv.rmB[r] + out * uv.rmG[r]));
  }
  const vol = Math.fround(uv.vol + uv.volInc);
  const o = out * vol;
  uv.vol = vol;
  uv.buf[i] = Math.fround(o);
  for (let r = 0; r < uv.fmTo.length; r++) {
    const tgt = v.units[uv.fmTo[r]];
    tgt.fmAcc = Math.fround(tgt.fmAcc + o * uv.fmGs[r]);
  }
}

/** FL's gain ramp for one audio chunk (0x8eb60): start = current, step = (target - start) / n limited to maxStep. */
const RAMP = new Float64Array(3); // [start, step, end]
function chunkRamp(cur: number, target: number, n: number, maxStep: number): void {
  RAMP[0] = cur;
  let inc = Math.fround(target - cur);
  let end = cur;
  if (inc !== 0) {
    end = target;
    const nf = Math.fround(n);
    inc = Math.fround(inc / nf);
    if (Math.abs(inc) > maxStep) {
      inc = inc < 0 ? -maxStep : maxStep;
      end = Math.fround(cur + Math.fround(inc * nf));
      if (Math.abs(end) < 5.960464477539063e-8) { end = 0; inc = Math.fround(-cur / nf); }
    }
  }
  RAMP[1] = inc; RAMP[2] = end;
}

/** Add a unit's chunk to a stereo bus with ramped gains (0xc09a0: kernels 0x8d200 / 0x28cc / 0x8d370). */
function mixBus(b: Float32Array, L: Float32Array, R: Float32Array, off: number, cnt: number, uv: UnitVoice, fx: boolean, maxStep: number): void {
  chunkRamp(fx ? uv.xL : uv.oL, fx ? uv.xLt : uv.oLt, cnt, maxStep);
  const sL = RAMP[0], iL = RAMP[1], eL = RAMP[2];
  chunkRamp(fx ? uv.xR : uv.oR, fx ? uv.xRt : uv.oRt, cnt, maxStep);
  const sR = RAMP[0], iR = RAMP[1], eR = RAMP[2];
  if (fx) { uv.xL = eL; uv.xR = eR; } else { uv.oL = eL; uv.oR = eR; }
  if (iL === 0 && iR === 0) {
    if (sL === 0 && sR === 0) return;
    if (sL === 1 && sR === 1) {
      for (let i = 0; i < cnt; i++) { L[off + i] += b[i]; R[off + i] += b[i]; }
    } else {
      for (let i = 0; i < cnt; i++) {
        L[off + i] = Math.fround(Math.fround(b[i] * sL) + L[off + i]);
        R[off + i] = Math.fround(Math.fround(b[i] * sR) + R[off + i]);
      }
    }
    return;
  }
  // gains in double, stepped after each sample
  let gl = sL, gr = sR;
  for (let i = 0; i < cnt; i++) {
    L[off + i] += b[i] * gl; gl += iL;
    R[off + i] += b[i] * gr; gr += iR;
  }
}

function mixOut(uv: UnitVoice, v: SyVoice, c: SyCtx, off: number, cnt: number): void {
  const maxStep = Math.fround(c.maxGainStep * v.uVol);
  mixBus(uv.buf, c.outL, c.outR, off, cnt, uv, false, maxStep);
  mixBus(uv.buf, c.fxL, c.fxR, off, cnt, uv, true, maxStep);
}


export { curve };
