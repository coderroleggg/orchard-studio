// GMS synthesizer core, ported from FL 2026's GMS_x64 (GMSynth / GMSynthVoice on IL's CSynth
// framework) by static analysis only: GMS renders silence in FL's test host (licence check),
// so nothing here could be compared with FL's output.
// - 212 internal values (FL's parameters view them, see the model's gmsInternal); MIDI
//   velocity / mod wheel / aftertouch add (2 amount - 1) x source to one destination each;
// - 99 voices (polyphony = min(99, host max)): note on takes the last free voice of the first
//   "polyphony" ones, else the oldest; mono uses voice 0; note off releases every voice of
//   the key; the voice ends when its amplitude envelope is below 1e-4 with target 0;
// - per block (at most 508 samples): LFO rates (free 0.01..25 Hz or 1/8 beat .. 8 bars,
//   phase locked to the song while the host plays unless retriggered), per voice the pitch
//   (note + channel pitch + octave + slide, EG / LFO pitch modulation, bend), unison
//   (1..16 voices, detune 2^(0.16 d^2 (u / (n - 1) - 1 / 2)), stereo spread, phase offsets),
//   three oscillators from the band-limited wave tables with the level for their frequency,
//   oscillator 1 synced / FM'd / ring-modulated by oscillator 2, the mix weights;
// - per sample: two exponential envelopes (attack to 1, decay to 0) and the ADSR amplitude
//   envelope (attack towards 5), two global LFOs, slide, the dithered table lookups (the
//   global LCG also makes the noise), the amplitude, then per voice a 4-pole ladder run four
//   times per sample with x / (1 + 0.04 x^2) saturation (LP / BP / HP), cutoff from a 65536-
//   entry exp table, the voice level; then the ten effects, channel level (-60..20 dB) and pan.

import { f32 } from '../poizone/dsp';
import { exp2f, exp10f } from '../poizone/applemath';
import { GmsFx } from './fx';
import { GMS_LEVELS, GMS_TABLE } from './waves';

const NV = 99;
const MAXB = 512;
const LCG_A = 0x0bb38435;
const LCG_C = 0x3619636b;
/** GMS's global LCG (one per process in FL, initial 0; shared by every instance). */
export const gmsSeed = { v: 0 };
const rnd = (): number => { gmsSeed.v = (Math.imul(gmsSeed.v, LCG_A) + LCG_C) >>> 0; return gmsSeed.v; };
const U32 = 2.3283064365386963e-10;
const F01 = f32(0.009999999776482582);
const T4 = f32(9.999999747378752e-05);
const SYNC_BEATS = [0.25, 0.375, 0.5, 0.75, 1, 2, 4];

/** FL 0xe534: beats of a rate value (trunc(9 v): 1/8 .. 8). */
export function gmsBeats(v: number): number {
  const n = Math.trunc(f32(v * 9));
  if (n - 1 < 0) return 0.125;
  if (n > 7) return 8;
  return SYNC_BEATS[n - 1];
}

/** FL 0xe404: phase offset (cycles, as FL's (x + 64) x 4194303 << 8). */
function phaseOfs(ph: number, d: number): number {
  const t = Math.trunc(fmaDD(d, 4194303, 268435392));
  return (ph + ((t * 256) >>> 0)) >>> 0;
}
function fmaDD(a: number, b: number, c: number): number { return a * b + c; }

/** FL 0xe3c4: 32-bit phase increment of frequency f. */
function phaseInc(f: number, sr: number): number {
  let x = Math.max(f, 0);
  x = Math.min(x, f32(sr * f32(0.4999000132083893)));
  const r = f32(x / sr);
  return Math.trunc(r * 4294967295) >>> 0;
}

/** FL 0xe42c: the table level for frequency f (level trunc(sr / 2f), 511 at most). */
function levelOf(f: number, sr: number): number {
  if (f32(sr * 0.0009765625) >= f) return (GMS_LEVELS - 1) * GMS_TABLE;
  const k = Math.max(Math.trunc(sr / (f + f)), 0);
  return k > 511 ? (GMS_LEVELS - 1) * GMS_TABLE : k * GMS_TABLE;
}

/** FL 0xe4ac: LFO shapes (sine bipolar; triangle, saw down, square unipolar). */
function lfoShape(shape: number, p: number): number {
  if (shape === 2) return f32(1 - p);
  if (shape === 1) { const d = f32(p + p); return d > 1 ? f32(2 - d) : d; }
  if (shape === 0) return f32(Math.sin(p * 6.283185307179586));
  return p < 0.5 ? 1 : 0;
}

export class GmsVoice {
  active = false;
  released = false;
  note = -1;
  pitch = 0;
  glide = 0;
  vel = 0;
  age = 0;
  retrig2 = false;
  eg1Amt = 0; eg2Amt = 0; lfo1Amt = 0; lfo2Amt = 0;
  readonly p1 = new Uint32Array(16); readonly pm = new Uint32Array(16); readonly p2 = new Uint32Array(16); readonly p3 = new Uint32Array(16);
  readonly i1 = new Uint32Array(16); readonly im = new Uint32Array(16); readonly i2 = new Uint32Array(16); readonly i3 = new Uint32Array(16);
  readonly o1L = new Float32Array(16); readonly o1R = new Float32Array(16); readonly o2L = new Float32Array(16); readonly o2R = new Float32Array(16);
  readonly o3L = new Float32Array(16); readonly o3R = new Float32Array(16); readonly nL = new Float32Array(16); readonly nR = new Float32Array(16);
  lv1 = 0; lv2 = 0; lv3 = 0;
  amp = 0; ampT = 0; ampC = 0; ampAtk = 0; ampDec = 0; ampSus = 0; ampRel = 0;
  eg1 = 0; eg1T = 0; eg1C = 0; eg1Atk = 0; eg1Dec = 0;
  eg2 = 0; eg2T = 0; eg2C = 0; eg2Atk = 0; eg2Dec = 0;
  res = 0; cutOfs = 0;
  readonly fl = new Float32Array(4);
  readonly fr = new Float32Array(4);
  lvl = -1; lvlT = 1;
  l1 = 0; l2 = 0;
  readonly bufL = new Float32Array(MAXB);
  readonly bufR = new Float32Array(MAXB);
  readonly cut = new Float32Array(MAXB);
  readonly gain = new Float32Array(MAXB);

  /** FL 0x39af0 (slot 5): stop; states cleared, new random phases (93 LCG draws per unison voice). */
  reset(): void {
    this.active = false; this.released = false; this.note = -1;
    this.lvl = -1; this.lvlT = 1;
    this.fl.fill(0); this.fr.fill(0);
    this.amp = 0; this.eg1 = 0; this.eg2 = 0;
    for (let u = 0; u < 16; u++) {
      const a = rnd();
      this.pm[u] = a; this.p1[u] = a;
      let r = 0;
      for (let k = 0; k < 31; k++) r = rnd();
      this.p2[u] = r;
      for (let k = 0; k < 31; k++) r = rnd();
      this.p3[u] = r;
      for (let k = 0; k < 30; k++) rnd();
    }
  }
}

export class GmsSynth {
  sr = 44100;
  tempo = 120;
  songPos = 0;
  playing = false;
  readonly iv = new Float32Array(212);
  readonly sel = [0, 0, 0];
  // CSynth: held keys, per-key levels from the wrapper
  readonly vel01 = new Float32Array(128);
  readonly noteL = new Float32Array(128);
  readonly noteR = new Float32Array(128);
  readonly notePitch = new Float32Array(128);
  /** FL's per-key "sounding" flags (synth +0xa20). */
  readonly use = new Int32Array(128);
  readonly cc = new Float32Array(128);
  maxPolyHost = 0;
  polyCfg = NV;
  readonly voices: GmsVoice[] = [];
  readonly fx: GmsFx[] = [];
  tables: Float32Array[] = [new Float32Array(GMS_LEVELS * GMS_TABLE), new Float32Array(GMS_LEVELS * GMS_TABLE), new Float32Array(GMS_LEVELS * GMS_TABLE)];
  // block state (FL synth +0x47b8 ...)
  modKind = 0;
  lfoPh1 = 0; lfoPh2 = 0; lfoInc1 = 0; lfoInc2 = 0;
  uniCount = 1;
  modS = -1;
  cutT = 0; cutS = -1;
  filterType = 0;
  osc2Ofs = 0;
  eg1Dest = 0; eg2Dest = 0; lfo1Dest = 0; lfo2Dest = 0; lfo1Shape = 0; lfo2Shape = 0;
  lastVel = 0;
  lastPitch = -1;
  ageCtr = 1;
  modWheel = 0;
  aftertouch = 0;
  bend = 0;
  sounding = false;
  fxPressed = false;
  gainL = -1; gainR = -1;
  private readonly fT = new Float32Array(65536 * 2);
  private readonly aCut = new Float32Array(MAXB);
  private readonly aMod = new Float32Array(MAXB);
  private readonly aL1 = new Float32Array(MAXB);
  private readonly aL2 = new Float32Array(MAXB);
  private readonly aDepth = new Float32Array(MAXB);
  private readonly aAmp = new Float32Array(MAXB);

  constructor() {
    for (let v = 0; v < NV; v++) this.voices.push(new GmsVoice());
    for (let k = 0; k < 10; k++) this.fx.push(new GmsFx(k));
    // the filter table: 65536 x (g, k) (FL ctor 0x157f4)
    const c = f32(0.00014913368795532733);
    for (let i = 0; i < 65536; i++) {
      const g = f32(exp2f(f32(i * c)) * 0.0005);
      const k = f32(f32(g * 7.5 + 5) * 0.756525);
      this.fT[2 * i] = g;
      this.fT[2 * i + 1] = k;
    }
    this.iv[0] = 0.75;
  }

  setTable(osc: number, t: Float32Array | null): void {
    this.tables[osc] = t ?? new Float32Array(GMS_LEVELS * GMS_TABLE);
  }

  /** FL 0x19d78: an internal value with the MIDI modulations that target it. */
  mod(id: number): number {
    const iv = this.iv;
    let v = iv[id];
    const tgt = (code: number): boolean => {
      switch (code) {
        case 1: return id === 12;
        case 2: return id === 13;
        case 4: return id === 50;
        case 6: return id === 20;
        case 7: return id === 22;
        case 8: return id === 16;
        case 10: return id === 21;
        case 11: return id === 23;
        case 12: return id === 17;
        case 14: return id === 34;
        case 15: return id === 28;
        case 17: return id === 35;
        case 18: return id === 29;
        case 20: return id === 4;
        case 21: return id === 5;
        default: return false;
      }
    };
    const add = (destId: number, amtId: number, src: number): void => {
      if (iv[destId] === 0) return;
      if (!tgt(Math.trunc(iv[destId]))) return;
      const d = f32(f32(iv[amtId] * 2 * src - src) + v);
      v = Math.min(Math.max(d, 0), 1);
    };
    add(199, 198, this.lastVel);
    add(202, 201, this.modWheel);
    add(204, 203, this.aftertouch);
    return v;
  }

  setMaxPoly(n: number): void { this.maxPolyHost = n !== 0 ? n : NV; }
  private poly(): number { return Math.min(this.polyCfg, this.maxPolyHost || NV); }

  // ------------------------------------------------------------- MIDI
  noteOn(n: number, vel127: number): void {
    this.vel01[n] = f32(vel127 * f32(1 / 127));
    if (vel127 === 0) { this.noteOff(n); return; }
    this.lastVel = this.vel01[n];
    let v: GmsVoice | null = null;
    if (this.mod(40) !== 0) v = this.voices[0];
    else {
      const p = this.poly();
      if (p < 1) return;
      for (let i = 0; i < p; i++) if (!this.voices[i].active) v = this.voices[i];
      if (!v) {
        let best = 0xffffffff;
        for (let i = 0; i < p; i++) if (this.voices[i].age >>> 0 < best) { best = this.voices[i].age >>> 0; v = this.voices[i]; }
      }
    }
    if (!v) return;
    v.note = n;
    v.pitch = n + Math.trunc(f32(this.mod(2) * 48 - 24));
    v.pitch = Math.trunc(this.mod(44) * 4) * 12 + v.pitch - 24;
    v.vel = this.lastVel;
    v.age = this.ageCtr++ >>> 0;
    this.start(v);
    this.lastPitch = v.pitch;
  }

  /** FL 0x1a064: voice start. */
  private start(v: GmsVoice): void {
    const sr = this.sr;
    v.released = false;
    v.active = true;
    v.l1 = 0; v.l2 = 0;
    const lvl = f32(this.mod(8) * this.mod(8));
    v.lvlT = lvl;
    if (v.lvl < 0) v.lvl = lvl;
    const a = this.mod(4), d = this.mod(5);
    const ta = f32(f32(f32(a * a) * a) * 50), td = f32(f32(f32(d * d) * f32(d * d)) * 50);
    v.ampAtk = f32(8.82 / ((ta + 0.001) * sr));
    v.ampDec = f32(8.82 / ((td + 0.001) * sr));
    v.ampRel = 0;
    v.ampSus = this.mod(6);
    v.ampC = v.ampAtk;
    v.ampT = 5;
    const eg = (atk: number, dec: number): [number, number] => {
      const dd = f32(f32(dec * f32(0.800000011920929)) + f32(0.20000000298023224));
      const ca = f32(f32(f32(atk * atk) * f32(atk * atk)) * f32(atk * 300));
      const cd = f32(f32(f32(dd * dd) * f32(dd * dd)) * f32(dd * 70));
      return [f32(8.82 / ((ca + 0.001) * sr)), f32(8.82 / ((cd + 0.001) * sr))];
    };
    // FL stores the double 2048.0 over (value, target): value 0, target 5
    [v.eg1Atk, v.eg1Dec] = eg(this.mod(20), this.mod(22));
    v.eg1C = v.eg1Atk; v.eg1 = 0; v.eg1T = 5;
    [v.eg2Atk, v.eg2Dec] = eg(this.mod(21), this.mod(23));
    v.eg2C = v.eg2Atk; v.eg2 = 0; v.eg2T = 5;
    if (this.mod(11) !== 0 && this.lastPitch !== -1) v.glide = this.lastPitch;
    if (this.mod(47) !== 0) {
      const ph = f32(this.mod(46) * 4);
      for (let u = 0; u < 16; u++) {
        const p = phaseOfs(0, f32(ph * u));
        v.p1[u] = p; v.pm[u] = p; v.p2[u] = p; v.p3[u] = p;
      }
      v.retrig2 = false;
    } else v.retrig2 = this.mod(53) !== 0;
    if (this.mod(26) !== 0) this.lfoPh1 = 0;
    if (this.mod(27) !== 0) this.lfoPh2 = 0;
  }

  noteOff(n: number): void {
    this.vel01[n] = 0;
    const r = this.mod(7);
    const t = f32(fmaD2(r, 0.55, 0.1));
    const x = f32(f32(f32(t * t) * f32(t * 25)));
    const c = f32(8.82 / ((x + 0.001) * this.sr));
    for (const v of this.voices) {
      if (v.note !== n) continue;
      v.released = true;
      v.ampRel = c;
      v.ampC = c;
      v.ampT = 0;
    }
  }

  controlChange(c: number, v127: number): void {
    this.cc[c] = f32(v127 * f32(1 / 127));
    if (c === 1) this.modWheel = this.cc[1];
  }

  setAftertouch(v127: number): void { this.aftertouch = f32(v127 * f32(1 / 127)); }

  // ------------------------------------------------------------- host side
  /** FL 0x16f88 (+ CSynth): sample rate; effects and voices reset. */
  setSampleRate(sr: number): void {
    if (sr > 0) this.sr = sr;
    this.gainL = -1; this.gainR = -1;
    for (const f of this.fx) f.setSampleRate(this.sr);
    for (const v of this.voices) v.reset();
    this.lfoPh1 = 0; this.lfoPh2 = 0;
    this.ageCtr = 1;
    this.lastPitch = -1;
    this.cutS = -1; this.modS = -1;
  }

  /** One block of at most 508 samples into L / R (zeroed by the caller). */
  process(L: Float32Array, R: Float32Array, n: number): void {
    this.blockSetup(n);
    // per voice: ladder filter, level, mix (FL 0x18580)
    for (const v of this.voices) {
      if (!v.active) continue;
      const type = this.filterType, res = v.res, fT = this.fT;
      const fl = v.fl, fr = v.fr;
      let l1 = fl[0], l2 = fl[1], l3 = fl[2], l4 = fl[3];
      let r1 = fr[0], r2 = fr[1], r3 = fr[2], r4 = fr[3];
      for (let i = 0; i < n; i++) {
        let idx = Math.trunc(v.cut[i] * 65536);
        idx = idx < 0 ? 0 : idx > 65535 ? 65535 : idx;
        const g = fT[2 * idx], kk = fT[2 * idx + 1];
        const fb = f32(kk * res);
        const xl = v.bufL[i], xr = v.bufR[i];
        let ul = 0, ur = 0;
        for (let pass = 0; pass < 4; pass++) {
          ul = f32(xl - fb * l4);
          ul = f32(ul / f32(f32(ul * ul) * f32(0.03999999910593033) + 1));
          l1 = f32(f32(ul - l1) * g + l1); l2 = f32(f32(l1 - l2) * g + l2); l3 = f32(f32(l2 - l3) * g + l3); l4 = f32(f32(l3 - l4) * g + l4);
          ur = f32(xr - fb * r4);
          ur = f32(ur / f32(f32(ur * ur) * f32(0.03999999910593033) + 1));
          r1 = f32(f32(ur - r1) * g + r1); r2 = f32(f32(r1 - r2) * g + r2); r3 = f32(f32(r2 - r3) * g + r3); r4 = f32(f32(r3 - r4) * g + r4);
        }
        const ol = type === 2 ? f32(ul - l4) : type === 1 ? f32(l3 - l4) : l4;
        const or = type === 2 ? f32(ur - r4) : type === 1 ? f32(r3 - r4) : r4;
        const a = v.gain[i];
        L[i] = f32(a * ol + L[i]);
        R[i] = f32(a * or + R[i]);
      }
      fl[0] = l1; fl[1] = l2; fl[2] = l3; fl[3] = l4;
      fr[0] = r1; fr[1] = r2; fr[2] = r3; fr[3] = r4;
    }
    // effects: an effect may only be forced to bypass while nothing before it sounds
    let on = this.sounding;
    for (let k = 0; k < 10; k++) {
      const f = this.fx[k];
      if (!on) f.bypass = true;
      f.process(L, R, n, f32(this.tempo));
      on = on || f.active;
    }
    // channel level and pan (FL: dB(80 v - 60), [1 - p, p], at least 1e-4, smoothed 0.01)
    const lv = f32(this.iv[0] * 80 - 60);
    const g0 = lv < -80 ? 0 : exp10f(f32(lv * f32(0.05000000074505806)));
    const p = this.iv[1];
    const tl = Math.max(f32(Math.min(Math.max(f32(1 - p), 0), 1) * g0), T4);
    const tr = Math.max(f32(Math.min(Math.max(p, 0), 1) * g0), T4);
    if (!on) { this.gainL = tl; this.gainR = tr; return; }
    let gl = this.gainL, gr = this.gainR;
    if (gl < 0) gl = tl;
    if (gr < 0) { gl = tr; gr = 0; } // FL initialises the left gain with the right target here
    else { if (gl < T4) gl = 0; if (gr < T4) gr = 0; }
    for (let i = 0; i < n; i++) {
      gl = f32(f32(tl - gl) * F01 + gl);
      gr = f32(f32(tr - gr) * F01 + gr);
      L[i] = f32(L[i] * gl);
      R[i] = f32(R[i] * gr);
    }
    this.gainL = gl; this.gainR = gr;
  }

  /** FL 0xe56c: an LFO's frequency (Hz); locks the phase to the song when given. */
  private lfoHz(rate: number, sync: number, lockPhase: boolean, which: 1 | 2): number {
    const mode = Math.trunc(f32(sync + sync));
    if (mode === 0) {
      let r = Math.min(Math.max(f32(1 - rate), 0), 1);
      r = f32(f32(r * r) * 25);
      return f32(r + 0.01);
    }
    let b = gmsBeats(rate);
    if (mode === 2) b = f32(b * 4);
    if (lockPhase) {
      const s = f32(this.songPos * 4);
      if (s >= 0) { const ph = f32(f32(s * 0.25) / b); if (which === 1) this.lfoPh1 = ph; else this.lfoPh2 = ph; }
    }
    if (!(this.tempo > 0)) return 0;
    const per = f32((b * 60) / this.tempo);
    return per === 0 ? 0 : f32(1 / per);
  }

  /** FL 0x191cc + 0x1a498 + 0x1aeb8: block setup, per-voice parameters, envelopes / LFOs / oscillators. */
  private blockSetup(n: number): void {
    const sr = this.sr;
    this.sounding = false;
    // LFO rates (locked to the song position while playing, unless retriggered)
    this.lfoInc1 = f32(this.lfoHz(this.mod(34), this.mod(36), this.playing && this.mod(26) === 0, 1) / sr);
    this.lfoInc2 = f32(this.lfoHz(this.mod(35), this.mod(37), this.playing && this.mod(27) === 0, 2) / sr);
    // effects
    for (let k = 0; k < 10; k++) {
      const f = this.fx[k];
      const act = this.mod(147 + k) !== 0 || (this.fxPressed && this.sel[0] === k);
      f.bypass = !act;
      if (!act) continue;
      f.setX(this.mod(117 + k));
      f.setY(this.mod(127 + k));
      const s = f32(this.mod(177 + k) * 2), s1 = f32(s - 1);
      f.lfoAmt = s1 < 0 ? f32(s1 - s * s1) : f32(s * s1 - s1);
      f.lfoShape = Math.min(Math.max(Math.trunc(f32(this.mod(157 + k) * 3)), 0), 4);
      let r = gmsBeats(this.mod(137 + k));
      if (this.mod(167 + k) !== 0) r = f32(r * 4);
      f.setRate(r);
      if (this.playing) {
        const ph = f.rate > 0 ? (this.songPos * 4) / (f.rate * 4) : f.phase;
        f.phase = ph - Math.trunc(ph);
      }
    }
    const eqFx = this.fx[9];
    eqFx.eqOn = this.mod(206) !== 0;
    if (eqFx.eqOn) for (let b = 0; b < 5; b++) eqFx.setEqBand(b, Math.min(Math.max(this.mod(207 + b), 0), 1));
    this.use.fill(0);
    for (const v of this.voices) if (v.active && v.note >= 0 && v.note < 128) this.use[v.note] = 1;
    this.eg1Dest = Math.trunc(f32(this.mod(24) * 3));
    this.eg2Dest = Math.trunc(f32(this.mod(25) * 3));
    this.lfo1Dest = Math.trunc(f32(this.mod(38) * 3));
    this.lfo2Dest = Math.trunc(f32(this.mod(39) * 3));
    this.lfo1Shape = Math.trunc(f32(this.mod(32) * 3));
    this.lfo2Shape = Math.trunc(f32(this.mod(33) * 3));
    this.voiceParams();
    this.render(n);
  }

  /** FL 0x1a498: per-voice block parameters. */
  private voiceParams(): void {
    const sr = this.sr;
    const un = Math.trunc(f32(this.mod(41) * 15));
    this.uniCount = un < 0 ? 1 : Math.min(un + 1, 16);
    const det = f32(this.mod(42) * 0.4);
    const m2 = f32(this.mod(48) * this.mod(48)), m3 = f32(this.mod(49) * this.mod(49));
    const nz = f32(this.mod(45) * this.mod(45));
    const s11 = f32(f32(1 - m3) - nz * f32(1 - m3));
    this.cutT = this.iv[12];
    if (this.cutS < 0) this.cutS = this.cutT;
    const w1 = f32(s11 - m2 * s11), w2 = f32(s11 * m2), w3 = f32(m3 - nz * m3);
    const detSq = f32(det * det);
    this.filterType = Math.trunc(f32(this.mod(15) + this.mod(15)));
    this.osc2Ofs = phaseOfs(0, f32(this.mod(52) + this.mod(52)));
    this.modKind = Math.trunc(f32(this.mod(51) + this.mod(51)));
    for (const v of this.voices) {
      if (!v.active) continue;
      if (v.note >= 0 && v.note < 128) this.use[v.note] = 1;
      this.lastVel = v.vel;
      v.eg1Amt = f32(this.mod(16) * this.mod(16)); if (this.mod(18) !== 0) v.eg1Amt = -v.eg1Amt;
      v.eg2Amt = f32(this.mod(17) * this.mod(17)); if (this.mod(19) !== 0) v.eg2Amt = -v.eg2Amt;
      v.lfo1Amt = f32(this.mod(28) * this.mod(28)); if (this.mod(30) !== 0) v.lfo1Amt = -v.lfo1Amt;
      v.lfo2Amt = f32(this.mod(29) * this.mod(29)); if (this.mod(31) !== 0) v.lfo2Amt = -v.lfo2Amt;
      if (v.amp < T4 && v.ampT === 0) { v.reset(); continue; }
      v.cutOfs = this.mod(14) !== 0 ? f32(f32(v.glide * 0.0078125 - 0.4453125) * this.mod(14)) : 0;
      let lvl = f32(this.mod(8) * 50 - 25);
      lvl = f32((lvl < -80 ? 0 : exp10f(f32(lvl * f32(0.05000000074505806)))) * 200);
      if (this.mod(200) !== 0) lvl = f32(lvl * v.vel);
      v.lvlT = lvl;
      v.cutOfs = f32(f32(this.mod(12) - this.cutT) + v.cutOfs);
      v.res = this.mod(13);
      v.pitch = v.note + Math.trunc(f32(this.mod(2) * 48 - 24));
      v.pitch = Math.trunc(this.mod(44) * 4) * 12 + v.pitch - 24;
      let base: number;
      if (this.mod(11) !== 0) base = v.glide;
      else { base = v.pitch; v.glide = base; }
      const np = this.notePitch[v.note & 127];
      const range = Math.trunc(f32(this.mod(205) * 12));
      const eg2p = this.eg2Dest === 2 ? 1 : 0, eg1p = this.eg1Dest === 2 ? 1 : 0;
      const l1p = this.lfo1Dest === 2 ? 1 : 0, l2p = this.lfo2Dest === 2 ? 1 : 0;
      let sync = 1;
      if (this.modKind === 0) {
        let m = this.mod(50);
        m = f32(m + f32(f32(f32((this.eg1Dest === 1 ? v.eg1Amt : 0) * v.eg1) + f32((this.eg2Dest === 1 ? v.eg2Amt : 0) * v.eg2))
          + f32(f32(this.lfo1Dest === 1 ? v.l1 : 0) + f32(this.lfo2Dest === 1 ? v.l2 : 0))));
        m = Math.min(Math.max(m, 0), 1);
        sync = f32(m * 3 + 1);
      }
      const egP = f32(f32(v.eg2Amt * eg2p) * v.eg2 + f32(f32(v.eg1Amt * eg1p) * v.eg1));
      const lfoP = f32(v.l2 * l2p + f32(v.l1 * l1p));
      let s0 = f32(f32(f32(base) - 57) + np);
      s0 = f32(this.bend * range + s0);
      s0 = f32(egP * 24 + s0);
      const pitchSemis = f32(lfoP * 12 + s0);
      const off = (p: number, c: number): number => f32(Math.trunc(f32(this.mod(c) * 100 - 50)) * 0.01 + Math.trunc(f32(this.mod(p) * 72 - 36)));
      const o1 = off(55, 56), o2 = off(57, 58), o3 = off(59, 60);
      const k12 = f32(0.0833333358168602);
      const f0 = f32(exp2f(f32(pitchSemis * k12)) * 220);
      const f1 = f32(exp2f(f32(o1 * k12)) * f0);
      const f2 = f32(exp2f(f32(o2 * k12)) * f0);
      const f3 = f32(exp2f(f32(o3 * k12)) * f0);
      const f1s = f32(sync * f1);
      v.lv1 = levelOf(f1s, sr); v.lv2 = levelOf(f2, sr); v.lv3 = levelOf(f3, sr);
      const cnt = this.uniCount;
      for (let u = 0; u < 16; u++) {
        let dt = 1;
        if (cnt >= 2) dt = exp2f(f32(detSq * f32(f32(u / (cnt - 1)) - 0.5)));
        v.i1[u] = phaseInc(f32(dt * f1s), sr);
        v.im[u] = phaseInc(f32(dt * f1), sr);
        v.i2[u] = phaseInc(f32(dt * f2), sr);
        v.i3[u] = phaseInc(f32(dt * f3), sr);
        const sign = (u & 1) === 0 ? 1 : -1;
        const spread = (cnt & (u === 0 ? 1 : 0)) !== 0 ? 0 : sign;
        const st = f32(spread * this.mod(43));
        let gl = Math.min(Math.max(f32(1 - st), 0), 1);
        let gr = Math.min(Math.max(f32(st + 1), 0), 1);
        gl = f32(gl * this.noteL[v.note & 127]);
        gr = f32(gr * this.noteR[v.note & 127]);
        const norm = f32(f32(0.004999999888241291) / f32(f32(cnt - 1) * f32(0.15000000596046448) + 1));
        gl = f32(gl * norm); gr = f32(gr * norm);
        v.o1L[u] = f32(gl * w1); v.o1R[u] = f32(gr * w1);
        v.o2L[u] = f32(gl * w2); v.o2R[u] = f32(gr * w2);
        v.o3L[u] = f32(gl * w3); v.o3R[u] = f32(gr * w3);
        v.nL[u] = f32(gl * nz); v.nR[u] = f32(gr * nz);
        if (v.retrig2) {
          v.p1[u] = 0; v.p2[u] = 0;
          const k = (rnd() + 1) & 0x1ff;
          v.p1[u] = Math.imul(k, v.i1[u]) >>> 0;
          v.p2[u] = Math.imul(k, v.i2[u]) >>> 0;
          v.pm[u] = v.p1[u];
        }
      }
      v.retrig2 = false;
    }
  }

  /** FL 0x1aeb8: envelopes, LFOs and oscillators of every voice into its buffers. */
  private render(n: number): void {
    const sr = this.sr;
    const inv2 = this.mod(54) !== 0;
    const sl = this.mod(10);
    const slc = f32(8.82 / ((f32(f32(f32(sl * sl) * sl) * 2) + 0.001) * sr));
    const modT = f32(this.mod(50) * this.mod(50));
    if (this.modS < 0) this.modS = modT;
    const depthK = this.modKind === 1 ? 15 : 3;
    let first = true;
    const T1 = this.tables[0], T2 = this.tables[1], T3 = this.tables[2];
    for (const v of this.voices) {
      if (!v.active) continue;
      if (first && n !== 0) {
        for (let k = 0; k < n; k++) {
          this.cutS = f32(f32(this.cutT - this.cutS) * F01 + this.cutS);
          this.aCut[k] = this.cutS;
          this.modS = f32(f32(modT - this.modS) * F01 + this.modS);
          this.aMod[k] = this.modS;
          this.aL1[k] = lfoShape(this.lfo1Shape, this.lfoPh1);
          let p = f32(this.lfoPh1 + this.lfoInc1); this.lfoPh1 = f32(p - Math.trunc(p));
          this.aL2[k] = lfoShape(this.lfo2Shape, this.lfoPh2);
          p = f32(this.lfoPh2 + this.lfoInc2); this.lfoPh2 = f32(p - Math.trunc(p));
        }
      }
      first = false;
      v.bufL.fill(0, 0, n); v.bufR.fill(0, 0, n);
      this.sounding = true;
      let e1 = v.eg1, e2 = v.eg2, am = v.amp, lv = v.lvl;
      const pt = v.pitch;
      for (let k = 0; k < n; k++) {
        v.glide = f32(f32(pt - v.glide) * slc + v.glide);
        e1 = f32(f32(v.eg1T - e1) * v.eg1C + e1);
        e2 = f32(f32(v.eg2T - e2) * v.eg2C + e2);
        am = f32(f32(v.ampT - am) * v.ampC + am);
        lv = f32(f32(v.lvlT - lv) * F01 + lv);
        if (Math.trunc(e1) !== 0) { e1 = 1; v.eg1C = v.eg1Dec; v.eg1T = 0; }
        if (Math.trunc(e2) !== 0) { e2 = 1; v.eg2C = v.eg2Dec; v.eg2T = 0; }
        if (Math.trunc(am) !== 0) { am = 1; v.ampC = v.ampDec; v.ampT = v.ampSus; }
        v.gain[k] = lv;
        const l1 = f32(f32(this.aL1[k] * v.lfo1Amt) * (this.eg1Dest === 3 ? e1 : 1));
        const l2 = f32(f32(this.aL2[k] * v.lfo2Amt) * (this.eg2Dest === 3 ? e2 : 1));
        v.l1 = l1; v.l2 = l2;
        if (this.modKind === 1 || this.modKind === 2) {
          let m = this.aMod[k];
          if (this.eg1Dest === 1) m = f32(v.eg1Amt * e1 + m);
          if (this.eg2Dest === 1) m = f32(v.eg2Amt * e2 + m);
          m = f32(m + (this.lfo1Dest === 1 ? l1 : -0));
          m = f32(m + (this.lfo2Dest === 1 ? l2 : -0));
          this.aDepth[k] = f32(Math.max(m, 0) * depthK);
        }
        let a = f32(am * am);
        if (this.lfo1Dest === 3) a = f32(l1 + a);
        if (this.lfo2Dest === 3) a = f32(l2 + a);
        this.aAmp[k] = Math.max(a, 0);
        let c = f32(v.cutOfs + this.aCut[k]);
        if (this.eg1Dest === 0) c = f32(v.eg1Amt * e1 + c);
        if (this.eg2Dest === 0) c = f32(v.eg2Amt * e2 + c);
        if (this.lfo1Dest === 0) c = f32(l1 + c);
        if (this.lfo2Dest === 0) c = f32(l2 + c);
        v.cut[k] = c;
      }
      v.eg1 = e1; v.eg2 = e2; v.amp = am; v.lvl = lv;
      // oscillators per unison voice
      const cnt = this.uniCount, kind = this.modKind, ofs2 = this.osc2Ofs;
      const b1 = v.lv1, b2 = v.lv2, b3 = v.lv3;
      for (let u = 0; u < cnt; u++) {
        let p1 = v.p1[u], pm = v.pm[u], p2 = v.p2[u], p3 = v.p3[u];
        const i1 = v.i1[u], im = v.im[u], i2 = v.i2[u], i3 = v.i3[u];
        const g1l = v.o1L[u], g1r = v.o1R[u], g2l = v.o2L[u], g2r = v.o2R[u], g3l = v.o3L[u], g3r = v.o3R[u], gnl = v.nL[u], gnr = v.nR[u];
        for (let k = 0; k < n; k++) {
          let r = rnd();
          let o2 = T2[b2 + ((((r & 0x3fffff) + ((p2 + ofs2) >>> 0)) >>> 0) >>> 22)];
          if (inv2) o2 = -o2;
          let o1: number;
          if (kind === 1) {
            const ph = phaseOfs(p1, f32(this.aDepth[k] * o2));
            r = rnd();
            o1 = T1[b1 + ((((r & 0x3fffff) + ph) >>> 0) >>> 22)];
          } else if (kind === 0) {
            const nm = pm + im;
            pm = nm >>> 0;
            if (nm > 0xffffffff) p1 = pm;
            r = rnd();
            o1 = T1[b1 + ((((r & 0x3fffff) + p1) >>> 0) >>> 22)];
          } else {
            r = rnd();
            o1 = T1[b1 + ((((r & 0x3fffff) + p1) >>> 0) >>> 22)];
            if (kind === 2) o1 = f32(o1 - f32(this.aDepth[k] * o2) * o1);
          }
          r = rnd();
          const o3 = T3[b3 + ((((r & 0x3fffff) + p3) >>> 0) >>> 22)];
          const nzv = f32(f32(rnd() * U32) - 0.5);
          let s = f32(g1l * o1);
          s = f32(g2l * o2 + s);
          s = f32(g3l * o3 + s);
          s = f32(gnl * nzv + s);
          v.bufL[k] = f32(v.bufL[k] + s);
          s = f32(g1r * o1);
          s = f32(g2r * o2 + s);
          s = f32(g3r * o3 + s);
          s = f32(gnr * nzv + s);
          v.bufR[k] = f32(v.bufR[k] + s);
          p1 = (p1 + i1) >>> 0;
          p2 = (p2 + i2) >>> 0;
          p3 = (p3 + i3) >>> 0;
        }
        v.p1[u] = p1; v.pm[u] = pm; v.p2[u] = p2; v.p3[u] = p3;
      }
      for (let k = 0; k < n; k++) { v.bufL[k] = f32(v.bufL[k] * this.aAmp[k]); v.bufR[k] = f32(v.bufR[k] * this.aAmp[k]); }
    }
  }
}

function fmaD2(a: number, b: number, c: number): number { return a * b + c; }
