// PoiZone synthesizer core, ported from FL 2026's PoiZone engine library
// (PoiZoneSynth on Image-Line's CSynth / CVoiceGenerator classes):
// - 1024 voice generators in a pool (+1 spare), created with random oscillator
//   phases from a global 32-bit LCG (seed 22222) that also drives the noise;
//   a note takes the first free generator among the first "max voices"
//   (polyphony x unison), else the oldest released one, else the oldest;
// - everything runs at 8x the sample rate in blocks of 8 x 64 samples: per
//   block the envelopes (amp, EG), the LFO, glide and all modulations are
//   evaluated once (values at the block's end), oscillator levels and the
//   stereo gains ramp linearly over the block;
// - per sample: two naive saw / pulse oscillators (descending phase, pulse =
//   difference of two phases, hard sync, ring mod), noise, a Moog-style
//   4-pole filter (musicdsp "Moog VCF") with a soft clip of negative input,
//   LP / BP / HP taps, a DC tracker, smoothed stereo gains (unison pan,
//   FL's per-note pan / volume);
// - generators are rendered one at a time (one active voice) or four at a
//   time (FL's NEON code: other rounding, gains one sample later) - both
//   paths are ported;
// - decimation by one biquad low-pass per channel, a +5 dB / 12 kHz high
//   shelf, the trance gate, chorus, delay, master gain / pan;
// - arpeggiator (up, down, up/down, random over the held notes x octaves),
//   mono / legato / glide modes, octaver, unison (detune, pan), sustain pedal,
//   MIDI-learn CC map, mod wheel.

import {
  f32, fma, fms, fnms, fmaD, dn, PzEnv, PzLfo, PzRand64, PzDelay, PzChorus, PzShelf,
} from './dsp';
import { exp2f, exp10f } from './applemath';

const OSR = 8;
const MAXN = 64;
const LCG_A = 0x0bb38435;
const LCG_C = 0x3619636b;
const U32 = 2.3283064365386963e-10; // float 2^-32 (generator phases)
const NOISE_SCALE = 2.3283064370807974e-10;
const NEG042 = f32(-0.42);
const C1E4 = f32(1e-4);
const C004 = f32(0.04);
const C0005 = f32(0.005);
const INV12 = 0.08333333333333333;
const lcg = (s: number): number => (Math.imul(s, LCG_A) + LCG_C) >>> 0;

/** PoiZone's internal parameter ids 74..80 (hidden GUI settings, saved in the state). */
export const PZ_UNISON_STEPS = [1, 2, 3, 4, 8, 12, 16];
export const PZ_SPEED_STEPS = [0.5, 1, 2, 3, 4, 8, 16];
export const PZ_LFO_SYNC = [-1, 1, 2, 3, 4, 8, 12, 16, 32, 64];

/** CVoiceGenerator / PoiZoneGenerator. */
export class PzGen {
  readonly synth: PzSynth;
  readonly id: number;
  note = -1;
  uniIdx = 0;
  uniCnt = 1;
  det = 0;
  vel = 0;
  released = false;
  glideRate = 0;
  glide = 0;
  age = 0;
  // oscillators
  pa = 0; ia = 0; pa2 = 0; lA = 0; sA = 0;
  pb = 0; ib = 0; pb2 = 0; lB = 0; sB = 0;
  // filter
  ox = 0; oy1 = 0; oy2 = 0; oy3 = 0; y1 = 0; y2 = 0; y3 = 0; y4 = 0;
  fp = 0; fk = 0; fr = 0; m0 = 0; m1 = 0; m2 = 0;
  nl = 0; ns = 0;
  gL = 0; sgL = 0; gR = 0; sgR = 0; smL = 0; smR = 0; dc = 0;
  readonly amp = new PzEnv();
  readonly eg = new PzEnv();
  readonly lfo = new PzLfo();

  constructor(synth: PzSynth, id: number) {
    this.synth = synth;
    this.id = id;
    let s = lcg(synth.seed);
    const a = Math.min(f32(s * U32), 1);
    s = lcg(s);
    synth.seed = s;
    const b = Math.min(f32(s * U32), 1);
    this.pa = a; this.pa2 = a;
    this.pb = b; this.pb2 = b;
    this.kill(0);
  }

  setNote(n: number): void {
    const u = this.synth.use;
    if (this.note >= 0 && this.note <= 127 && u[this.note] - 1 >= 0) u[this.note]--;
    this.note = n;
    if (n >= 0 && n <= 127) u[n]++;
  }

  freeNote(): void {
    const u = this.synth.use;
    if (this.note >= 0 && this.note <= 127 && u[this.note] - 1 >= 0) u[this.note]--;
    this.note = -1;
  }

  /** CVoiceGenerator pitch (semitones, MIDI note scale) and frequency. */
  pitch(): number {
    const S = this.synth;
    let oct = 0;
    if (S.octaver) oct = (this.uniIdx & 1) === 0 ? 0 : 12;
    let det = 0;
    if (this.uniCnt >= 2) {
      const d = S.uniDetune;
      det = fma(d, -0.5, f32(f32(d * this.uniIdx) / (this.uniCnt - 1)));
    }
    let s = f32(det + oct);
    s = f32(s + this.glide);
    s = f32(S.notePitch[this.note & 127] + s);
    s = f32(s + f32(S.tune + this.det));
    s = fma(S.bendRange, S.bend, s);
    return s;
  }

  freq(): number {
    return f32(Math.pow(2, fmaD(this.pitch(), INV12, -4.75)) * 220);
  }

  /** Unison pan x FL's per-note gain (0 left, 1 right) x 0.5. */
  private uniGain(right: boolean): number {
    const S = this.synth;
    let sp = 0;
    if (this.uniCnt >= 2) sp = f32(f32(f32(this.uniIdx + this.uniIdx) / (this.uniCnt - 1)) + -1);
    const s1 = f32(S.uniPan * sp);
    const g = right ? Math.min(Math.max(f32(1 - s1), 0), 1) : Math.min(Math.max(f32(s1 + 1), 0), 1);
    const nv = right ? S.noteR[this.note & 127] : S.noteL[this.note & 127];
    return f32(nv * f32(g * 0.5));
  }

  /** Slot 3: start (envelopes, LFO copy). */
  trigger(): void {
    const S = this.synth;
    this.amp.setup(0, S.ampA, S.ampD, S.ampS, 0, 0, -2.5, -2.5, S.sr8, this.vel);
    this.eg.reset();
    this.eg.setup(0, S.egA, S.egD, S.egS, 0, -2, -2, -2, S.sr8, 1);
    this.lfo.copyFrom(S.lfo);
    if (this.lfo.retrig) this.lfo.phase = 0;
    S.dirty = true;
  }

  /** Slot 4: note off. */
  noteOff(): void {
    const S = this.synth;
    this.amp.setRelease(S.ampR);
    this.eg.setRelease(S.egR);
    this.amp.release();
    this.eg.release();
  }

  /** Slot 2: voice ends. */
  stop(): void {
    this.sA = 0; this.sB = 0; this.ns = 0;
    this.gR = 0; this.sgR = 0; this.smL = 0; this.smR = 0;
    this.gL = 0; this.sgL = 0;
    this.amp.reset();
    this.eg.reset();
    this.freeNote();
    this.synth.dirty = true;
  }

  /** Slot 5: hard reset (oscillator increments, levels, filter). */
  kill(_sr: number): void {
    this.ia = 0; this.ib = 0; this.lA = 0; this.lB = 0;
    this.ox = 0; this.oy1 = 0; this.oy2 = 0; this.oy3 = 0; this.y1 = 0; this.y2 = 0; this.y3 = 0; this.y4 = 0;
    this.fp = 0; this.fk = 0; this.fr = 0; this.m0 = 0; this.m1 = 0; this.m2 = 0; this.nl = 0;
    this.stop();
  }

  /** Block setup (PoiZoneGenerator render: envelopes, LFO, modulation, ramps). */
  prep(N: number): void {
    const S = this.synth;
    // glide
    const tgt = this.note;
    let cur = this.glide;
    if (!(cur >= tgt)) {
      cur = fma(this.glideRate, N, cur);
      this.glide = cur;
      if (cur > tgt) this.glide = tgt;
    } else if (cur > tgt) {
      cur = fms(this.glideRate, N, cur);
      this.glide = cur;
      if (cur < tgt) this.glide = tgt;
    }
    if (this.amp.done) { this.stop(); return; }
    const eg = this.eg.tick(N);
    const L = this.lfo;
    L.rate = Math.max(S.lfo.rate, 0);
    L.shape = S.lfo.shape;
    L.sync = S.lfo.sync;
    let lfo = L.tick(S.sr8, S.tempoF, N, S.rand64);
    if (S.mwDest === 1) lfo = f32(f32(S.smMw * lfo) * S.cc[1]);
    const amp10 = f32(this.amp.tick(N) * 10);
    let pan = 0.5;
    if (S.lfoDest === 5) pan = f32(fmaD(f32(S.smLfo * lfo), 0.5, 0.5));
    pan = Math.min(Math.max(pan, 0), 1);
    const nf = N;
    const gl = f32(this.uniGain(false) * amp10);
    this.sgL = f32(fnms(gl, pan, this.gL) / nf);
    const gr = f32(this.uniGain(true) * amp10);
    const oldR = this.gR;
    this.sgR = f32(f32(fmaD(-pan, gr, gr) - oldR) / nf);
    this.gL = dn(this.gL);
    this.sgL = dn(this.sgL);
    this.gR = dn(oldR);
    this.sgR = dn(this.sgR);
    this.smL = dn(this.smL);
    this.smR = dn(this.smR);
    const nlOld = this.nl;
    this.ns = dn(f32(f32(S.smNoise - nlOld) / nf));
    this.nl = dn(nlOld);
    this.oscA(N, eg, lfo);
    this.oscB(N, eg, lfo);
    this.filter(eg, lfo);
  }

  private oscA(N: number, eg: number, lfo: number): void {
    const S = this.synth;
    let fq = this.freq();
    let pw = S.smPwA;
    const ed = S.egDest;
    if (ed === 1 || ed === 2) {
      const st = Math.trunc(S.smEg * 24);
      fq = f32(Math.pow(2, f32(st * eg) * INV12) * fq);
    } else if (ed === 3 || ed === 4) pw = fma(S.smEg, eg, pw);
    const ld = S.lfoDest;
    if (ld === 1 || ld === 2) {
      const a = S.smLfo;
      let q = f32(a * a);
      q = f32(q * q);
      const e = a > 0 ? f32(lfo * f32(q + q)) : f32(f32(lfo * -2) * q);
      fq = f32(exp2f(e) * fq);
    } else if (ld === 3 || ld === 4) pw = fma(S.smLfo, lfo, pw);
    const md = S.mwDest;
    if (md === 2) {
      const a = S.smMw;
      let q = f32(a * f32(a * a));
      q = f32(q + q);
      fq = f32(exp2f(f32(S.cc[1] * q)) * fq);
    } else if (md === 3 || md === 4) pw = fma(S.cc[1], S.smMw, pw);
    pw = Math.min(Math.max(pw, 0), 1);
    let f = Math.max(fq, 0);
    const ny = S.sr8 * 0.5;
    if (ny < f) f = f32(ny);
    const inc = f32(f / S.sr8);
    this.ia = inc;
    const t3 = f32(1 - S.smOscBal);
    const tgt = f32(fmaD(-S.smNoise, t3, t3));
    const lOld = this.lA;
    let sl = f32(f32(tgt - lOld) / N);
    this.sA = dn(sl);
    this.lA = dn(lOld);
    const off = f32(fmaD(pw, 0.49, -0.99));
    const pa = this.pa;
    const s3 = f32(pa + off);
    const v = s3 < 0 ? f32(s3 + 1) : s3;
    this.pa2 = v;
    this.ia = dn(inc);
    this.pa = dn(pa);
    this.pa2 = dn(v);
  }

  private oscB(N: number, eg: number, lfo: number): void {
    const S = this.synth;
    const base = this.freq();
    let fq = f32(Math.pow(2, f32(S.detuneB + S.semiB) * INV12) * base);
    let pw = S.smPwB;
    const ed = S.egDest;
    if (ed === 4) pw = fma(S.smEg, eg, pw);
    else if (ed === 2) {
      const st = Math.trunc(S.smEg * 24);
      fq = f32(Math.pow(2, f32(st * eg) * INV12) * fq);
    }
    const ld = S.lfoDest;
    if (ld === 4) pw = fma(S.smLfo, lfo, pw);
    else if (ld === 2) {
      const a = S.smLfo;
      let q = f32(a * a);
      q = f32(q * q);
      const e = a > 0 ? f32(lfo * f32(q + q)) : f32(f32(lfo * -2) * q);
      fq = f32(exp2f(e) * fq);
    }
    if (S.mwDest === 4) pw = fma(S.cc[1], S.smMw, pw);
    pw = Math.min(Math.max(pw, 0), 1);
    let f = Math.max(fq, 0);
    const ny = S.sr8 * 0.5;
    if (ny < f) f = f32(ny);
    const inc = f32(f / S.sr8);
    this.ib = inc;
    const ob = S.smOscBal;
    const tgt = f32(fmaD(-S.smNoise, ob, ob));
    const lOld = this.lB;
    let sl = f32(f32(tgt - lOld) / N);
    this.sB = dn(sl);
    this.lB = dn(lOld);
    const off = f32(fmaD(pw, 0.49, -0.99));
    const pb = this.pb;
    const s3 = f32(pb + off);
    const v = s3 < 0 ? f32(s3 + 1) : s3;
    this.pb2 = v;
    this.ib = dn(inc);
    this.pb = dn(pb);
    this.pb2 = dn(v);
  }

  private filter(eg: number, lfo: number): void {
    const S = this.synth;
    const p = this.pitch();
    let s0 = f32(p + -56);
    s0 = f32(s0 * S.keytrack);
    let d0 = s0 * 0.0084;
    d0 = fmaD(S.veltrack * 0.5, this.vel + -0.5, d0);
    d0 += S.noteCut[this.note & 127];
    if (S.egDest === 0) {
      const a = S.smEg;
      const q = f32(f32(a * a) * eg);
      d0 = a <= 0 ? d0 - q : d0 + q;
    }
    if (S.lfoDest === 0) {
      const a = S.smLfo;
      const q = f32(f32(a * a) * lfo);
      d0 = a <= 0 ? d0 - q : d0 + q;
    }
    if (S.mwDest === 0) {
      const a = S.smMw;
      const q = f32(f32(a * a) * S.cc[1]);
      d0 = a <= 0 ? d0 - q : d0 + q;
    }
    d0 = fmaD(S.smCut, 1.1, d0);
    const x = Math.min(Math.max(d0, 0), 0.91);
    const res = Math.min(Math.max(S.reso + S.noteRes[this.note & 127], 0), 1);
    const f = Math.pow(2, fmaD(x, 10, 6)) / S.sr8;
    const k = f32(fmaD(fmaD(f, -1.6, 3.6), f, -1));
    this.fp = f32(fmaD(k, 0.5, 0.5));
    this.fk = k;
    const r2 = res * 2.05344;
    const e = Math.exp(fmaD(x, -1.5233505494505493, 1.386249));
    this.fr = f32(fmaD(e, r2, r2));
    const m = S.filterMode;
    const d1 = m === 0 ? 1 : 0;
    const d2 = m === 1 ? 3 : 0;
    const s3 = m === 2 ? 1 : 0;
    this.m0 = f32(d2 + d1 - s3);
    this.m1 = d2 === 0 ? -0 : -3;
    this.m2 = s3;
  }
}

/** The arpeggiator (CArpeggiator): steps = held notes ascending, repeated per octave. */
class PzArp {
  readonly synth: PzSynth;
  speed = 1;
  steps = 0;
  mode = 0;
  velScale = 1;
  range = 1;
  swing = 0;
  idle = true;
  phase = 0;
  swingFlag = false;
  trig = true;
  idx = -2;
  up = true;
  readonly sNote = new Int32Array(128 * 8).fill(-1);
  readonly sVel = new Float32Array(128 * 8).fill(1);
  readonly prev = new Int32Array(8).fill(-1);

  constructor(synth: PzSynth) { this.synth = synth; }

  private allOff(): void {
    for (let i = 0; i < 8; i++) {
      if (this.prev[i] >= 0) { this.synth.playNote(this.prev[i] & 255, 0); this.prev[i] = -1; }
    }
  }

  private restart(): void {
    this.phase = 0; this.idx = -2; this.up = true; this.swingFlag = false; this.trig = true;
    this.prev.fill(-1);
  }

  reset(): void { this.restart(); }

  stop(): void {
    if (this.idle) return;
    this.idle = true;
    this.allOff();
    this.restart();
  }

  /** Held notes changed (FL rebuilds the table from the held velocities). */
  update(): void {
    const S = this.synth;
    const nts: number[] = [], vls: number[] = [];
    for (let n = 0; n < 128; n++) if (S.vel01[n] !== 0) { nts.push(n); vls.push(S.vel01[n]); }
    const cnt = nts.length;
    if (cnt > 0) {
      if (this.idle) {
        this.idle = false;
        this.allOff();
        this.restart();
      }
      const r = this.range;
      if (r >= 1) {
        for (let i = 0; i < cnt; i++) {
          for (let o = 0; o < r; o++) {
            const st = Math.min(Math.max(i + o * cnt, 0), 127);
            this.sNote[st * 8] = nts[i] + 12 * o;
            this.sVel[st * 8] = vls[i];
          }
        }
      }
      const tot = Math.min(Math.max(cnt * r, 1), 128);
      this.steps = tot;
    } else if (!this.idle) {
      this.idle = true;
      this.allOff();
      this.restart();
    }
  }

  process(sr: number, tempo: number, n: number): void {
    if (this.idle) return;
    if (this.trig) {
      this.trig = false;
      const cnt = this.steps;
      let i = this.idx;
      switch (this.mode) {
        case 0: if (i < 0 || i >= cnt) i = 0; break;
        case 1: if (i < 0) i = cnt - 1; break;
        case 2:
          if (i < -1) { i = 0; this.up = true; } else if (i < 0) { i = 1; this.up = true; }
          if (i >= cnt) { i = cnt - 2; this.up = false; if (cnt <= 1) i = 0; }
          if (i >= cnt) i = cnt - 1;
          break;
        default: {
          const r = this.synth.rand32();
          i = Math.max(Math.trunc(f32(r * cnt)), 0);
          if (i >= cnt) i = cnt - 1;
        }
      }
      this.idx = i;
      for (let k = 0; k < 8; k++) {
        const raw = this.sNote[i * 8 + k];
        const nt = raw < 127 ? raw : 127;
        if ((nt & 255) === 0xfe) continue;
        if (this.prev[k] >= 0) this.synth.playNote(this.prev[k] & 255, 0);
        const b = ((nt & 255) << 24) >> 24;
        this.prev[k] = b;
        if (b >= 0) this.synth.playNote(nt & 255, f32(this.sVel[i * 8 + k] * this.velScale));
      }
      if (this.mode === 2) this.idx = this.up ? this.idx + 1 : this.idx - 1;
      else if (this.mode === 1) this.idx--;
      else if (this.mode === 0) this.idx++;
    }
    const den = sr * 15 * this.speed;
    const lim = (this.swingFlag ? -this.swing : this.swing) + 1;
    let p = this.phase + (n * tempo) / den;
    this.phase = p;
    if (p >= lim) {
      let fl = this.swingFlag;
      do { p -= lim; fl = !fl; } while (p >= lim);
      this.phase = p;
      this.trig = true;
      this.swingFlag = fl;
    }
  }
}

/** The trance gate: 16 steps, tempo synced, one-pole smoothing towards 1 - mix (off steps). */
class PzGate {
  mix = 0;
  coef = f32(0.0101);
  readonly step = new Float32Array(16).fill(1);
  speed = 0.5;
  phase = 0;
  gain = 1;
  cur = 0;

  setMix(v: number): void { this.mix = f32(Math.min(Math.max(v, 0), 1)); }
  setSmooth(v: number): void {
    const s = Math.min(Math.max(v, 0), 1);
    const q = 1 - s;
    const t = fmaD(-s, q, q);
    this.coef = f32(fmaD(t, 0.009999999776482582, 9.99999974737875e-05));
  }
  setStep(i: number, v: number): void { if (i <= 16) this.step[i] = f32(1 - v); }
  idle(): void {
    this.phase = 0;
    this.gain = fms(this.mix, this.step[0], 1);
    this.cur = 0;
  }
  resync(beats: number): void {
    const d = (beats * 4) / this.speed;
    this.cur = Math.trunc(d) & 15;
    this.phase = d - Math.trunc(d);
  }
  process(sr: number, tempo: number, L: Float32Array, R: Float32Array, n: number): void {
    if (this.mix < f32(0.001)) return;
    const rate = this.speed > 0 ? tempo / (this.speed * 15) : 1;
    const inc = rate / sr;
    let ph = this.phase;
    const T = f32(1e-6);
    for (let i = 0; i < n; i++) {
      ph += inc;
      if (ph > 1) {
        ph += -1;
        this.cur = this.cur > 14 ? 0 : this.cur + 1;
      }
      const g0 = this.gain;
      const t1 = fma(this.mix, this.step[this.cur], g0);
      const t2 = fms(t1, this.coef, this.coef);
      let g = f32(t2 + g0);
      if (g > -T && g < T) g = 0;
      this.gain = g;
      L[i] = f32(g * L[i]);
      R[i] = f32(R[i] * g);
    }
    this.phase = ph;
  }
}

/** PoiZoneSynth. Parameters are the engine's internal ids 0..155 (floats). */
export class PzSynth {
  sr = 44100;
  sr8 = 352800;
  tempo = 120;
  tempoF = 120;
  songPos = -1;
  playing = false;
  seed = 22222;
  seed2 = 2222;
  readonly rand64 = new PzRand64();
  readonly gens: PzGen[] = [];
  readonly spare: PzGen;
  readonly list: PzGen[] = [];
  count = 0;
  dirty = true;
  readonly use = new Int32Array(128);
  /** FL's per-note levels (wrapper): L / R gains, pitch offset (semitones), Mod X, Mod Y. */
  readonly noteL = new Float32Array(128);
  readonly noteR = new Float32Array(128);
  readonly notePitch = new Float32Array(128);
  readonly noteCut = new Float32Array(128);
  readonly noteRes = new Float32Array(128);
  /** MIDI state (CPluginInstance): note velocities, CCs, pitch bend, held bytes. */
  readonly vel01 = new Float32Array(128);
  readonly cc = new Float32Array(128);
  readonly vel127 = new Uint8Array(128);
  bend = 0;
  readonly params = new Float32Array(156);
  get mw(): number { return this.cc[1]; }
  readonly ccMap = new Int8Array(74).fill(-1);
  // voice settings
  shapeA = 0; pwA = 1; syncA = false; ringA = false; shapeB = 0; pwB = 1; semiB = 0; detuneB = 0;
  oscBal = 0; noiseBal = 0; egAmt = 0; egA = 0.005; egD = 50; egS = 1; egR = 50;
  gain = 1; fine = 0; transpose = 0; tune = 0; cut = 1; reso = 0; keytrack = 0; veltrack = 0;
  ampA = 0.001; ampD = 20; ampS = 1; ampR = 0.015; lfoAmt = 0; mwAmt = 0;
  egDest = 0; filterMode = 0; lfoDest = 0; mwDest = 0;
  uniDetune = 0; uniPan = 0; uniCount = 1;
  glideTime = 1e-4; glideMode = 0;
  mono = false; octaver = false;
  poly = 13; maxPolyCfg = 64; maxPoly = 0;
  velCurve = 1;
  pan = 0.5;
  bendRange = 1;
  lastNote = -1;
  ageCtr = 0;
  // per-process smoothed values (0.04 per block)
  smPwA = 1; smPwB = 1; smOscBal = 0; smNoise = 0; smLfo = 0; smEg = 0; smMw = 0; smCut = 1;
  coefG = f32(0.003);
  readonly lfo = new PzLfo();
  readonly gate = new PzGate();
  readonly arp: PzArp;
  arpOn = false;
  readonly delay = new PzDelay();
  readonly chorus = new PzChorus();
  readonly shL = new PzShelf();
  readonly shR = new PzShelf();
  // decimator
  dg = 0; db1 = 0; db2 = 0;
  readonly dz = new Float32Array(8);
  mgL = 0; mgR = 0;
  readonly b8L = new Float32Array(OSR * MAXN);
  readonly b8R = new Float32Array(OSR * MAXN);

  constructor() {
    for (let i = 0; i < 1024; i++) this.gens.push(new PzGen(this, i));
    this.spare = new PzGen(this, 1024);
    this.arp = new PzArp(this);
    for (const s of [this.shL, this.shR]) {
      s.setSampleRate(44100);
      s.type = 2; s.bw = f32(0.99); s.gain = 5; s.freq = 12000; s.dirty = true;
    }
    this.cc[7] = 1;
    this.cc[10] = 0.5;
    this.setParameter(76, 11);
    this.resetToDefaults();
  }

  rand32(): number {
    this.seed2 = lcg(this.seed2);
    return f32(this.seed2 * U32);
  }

  /** FL's default value of an internal parameter. */
  static defaultParam(id: number): number {
    const one = [1, 5, 12, 13, 14, 18, 23, 24, 37, 49, 51, 53, 54, 55, 57, 59, 61, 62, 63, 77];
    const half = [6, 10, 15, 16, 17, 26, 34, 38, 40, 41, 43, 68];
    if (one.includes(id)) return 1;
    if (half.includes(id)) return 0.5;
    switch (id) {
      case 28: return f32(0.2);
      case 29: return f32(0.1);
      case 32: case 33: return f32(0.4285714328289032);
      case 35: return f32(0.3);
      case 42: return f32(0.4);
      case 76: return 12;
    }
    return id >= 81 && id <= 154 ? -1 : 0;
  }

  resetToDefaults(): void {
    for (let id = 0; id < 156; id++) this.setParameter(id, PzSynth.defaultParam(id));
  }

  /** State load (FL's setChunk): defaults first, then every internal id in order. */
  loadState(v: ArrayLike<number>): void {
    this.resetToDefaults();
    for (let id = 0; id < 156; id++) this.setParameter(id, id < v.length ? v[id] : PzSynth.defaultParam(id));
  }

  private allNotesOff(): void {
    const sus = this.cc[64];
    this.cc[64] = 0;
    for (let n = 0; n < 128; n++) this.noteOff(n);
    this.cc[64] = sus;
  }

  setParameter(id: number, v: number): void {
    v = f32(v);
    if (id >= 0 && id < 156) this.params[id] = v;
    if (id >= 81 && id <= 154) { this.ccMap[id - 81] = (Math.trunc(v) << 24) >> 24; return; }
    switch (id) {
      case 0: this.shapeA = v !== 0 ? 1 : 0; break;
      case 1: this.pwA = v; break;
      case 2: this.syncA = v !== 0; break;
      case 3: this.ringA = v !== 0; break;
      case 4: this.shapeB = v !== 0 ? 1 : 0; break;
      case 5: this.pwB = v; break;
      case 6: this.semiB = Math.trunc(f32(v * 48)) - 24; break;
      case 7: this.detuneB = f32(v * 0.5); break;
      case 8: this.oscBal = v; break;
      case 9: this.noiseBal = v; break;
      case 10: this.egAmt = f32(f32(v + v) + -1); break;
      case 11: this.egA = egTime(v, 49995, 5, 50000); break;
      case 12: this.egD = egTime(v, 49995, 5, 50000); break;
      case 13: this.egS = v; break;
      case 14: this.egR = egTime(v, 49995, 5, 50000); break;
      case 15: this.gain = exp10f(fma(v, 1.5, -1)); break;
      case 16: this.fine = f32(v * 2 - 1); this.tune = f32(this.transpose + this.fine); break;
      case 17: this.transpose = Math.trunc(v * 48) - 24; this.tune = f32(this.transpose + this.fine); break;
      case 18: this.cut = v; break;
      case 19: this.reso = v; break;
      case 20: this.keytrack = v; break;
      case 21: this.veltrack = v; break;
      case 22: this.ampA = egTime(v, 4999, 1, 5000); break;
      case 23: this.ampD = egTime(v, 19995, 5, 20000); break;
      case 24: this.ampS = Math.min(f32(v * v), 1); break;
      case 25: this.ampR = egTime(v, 9985, 15, 10000); break;
      case 26: this.lfoAmt = f32(v * 2 - 1); break;
      case 27: this.lfo.retrig = v !== 0; break;
      case 28: {
        const q = f32(v * v);
        const r = f32(f32(q * q) * f32(v * 30));
        this.lfo.rate = Math.max(Math.min(Math.max(r, 0), 30), 0);
        break;
      }
      case 29: this.uniDetune = f32(v * 1.5); break;
      case 30: this.uniPan = Math.min(Math.max(v, 0), 1); break;
      case 31: this.delay.setOn(v); break;
      case 32: this.delay.setTimeL(v); break;
      case 33: this.delay.setTimeR(v); break;
      case 34: this.delay.setFeedback(v); break;
      case 35: this.delay.setDepth(v); break;
      case 36: this.delay.setLoCut(v); break;
      case 37: this.delay.setHiCut(v); break;
      case 38: this.delay.setWet(v); break;
      case 39: this.chorus.setOn(v); break;
      case 40: this.chorus.setRate(v); break;
      case 41: this.chorus.setDepth(v); break;
      case 42: this.chorus.setWet(v); break;
      case 43: this.mwAmt = f32(v * 2 - 1); break;
      case 44: this.setMono(v !== 0); break;
      case 45: this.octaver = v !== 0; break;
      case 46: {
        const g = f32(Math.min(Math.max(f32(f32(v * v) * v), 0), 1) * 2);
        this.glideTime = g < 1e-4 ? f32(1e-4) : g;
        break;
      }
      case 47: this.gate.setMix(v); break;
      case 48: this.gate.setSmooth(v); break;
      case 65: this.egDest = clampI(fma(v, 4, f32(0.0004)), 4); break;
      case 66: this.filterMode = clampI(f32(f32(v + v) + f32(0.0002)), 2); break;
      case 67: this.lfoDest = clampI(fma(v, 5, f32(0.0005)), 5); break;
      case 68: this.lfo.shape = clampI(fma(v, 4, f32(0.0004)), 4); break;
      case 69: {
        const m = clampI(fma(v, 4, f32(0.0004)), 4);
        if (m === 0) this.setArp(false);
        else { this.setArp(true); this.arp.mode = Math.min(Math.max(m - 1, 0), 3); }
        break;
      }
      case 70: this.arp.range = Math.min(Math.max(clampI(fma(v, 3, f32(0.0003)), 3) + 1, 1), 4); break;
      case 71: this.mwDest = clampI(fma(v, 4, f32(0.0004)), 4); break;
      case 72: case 73: {
        const h = this.params[72], s = this.params[73];
        this.glideMode = (h !== 0 ? 1 : 0) + (s !== 0 ? 2 : 0);
        break;
      }
      case 75: {
        const i = Math.trunc(v);
        if (i >= 0 && i <= 6) this.uniCount = Math.min(Math.max(PZ_UNISON_STEPS[i], 1), 16);
        break;
      }
      case 76: {
        const w = Math.trunc(v) + 1;
        this.poly = this.maxPolyCfg >= w && w >= 1 ? w : this.maxPolyCfg;
        break;
      }
      case 77: {
        const i = Math.trunc(v);
        if (i >= 0 && i <= 6) this.arp.speed = Math.max(PZ_SPEED_STEPS[i], 0.25);
        break;
      }
      case 78: this.bendRange = Math.trunc(v) + 1; break;
      case 79: {
        const i = Math.trunc(v);
        if (i >= 0 && i <= 6) this.gate.speed = PZ_SPEED_STEPS[i];
        break;
      }
      case 80: {
        const i = Math.max(Math.trunc(v), 0);
        this.lfo.sync = i <= 9 ? PZ_LFO_SYNC[i] : 128;
        break;
      }
      case 157: this.cc[1] = v; break;
      case 158: this.bend = f32(f32(v + v) - 1); break;
      default:
        if (id >= 49 && id <= 64) this.gate.setStep(id - 49, Math.trunc(v));
    }
  }

  /** FPE_MaxPoly (0 = FL's default: the engine's cap). Without it PoiZone plays every note on its first generator. */
  setMaxPoly(n: number): void { this.maxPoly = n !== 0 ? n : this.maxPolyCfg; }

  private setMono(on: boolean): void {
    if (this.mono === on) return;
    this.mono = on;
    this.allNotesOff();
  }

  private setArp(on: boolean): void {
    if (this.arpOn === on) return;
    const sus = this.cc[64];
    this.cc[64] = 0;
    for (let n = 0; n < 128; n++) this.noteOff(n);
    this.cc[64] = sus;
    this.arpOn = on;
  }

  private maxVoices(): number {
    const v = Math.min(this.poly, this.maxPoly) * this.uniCount;
    return Math.min(v, 1024);
  }

  // ------------------------------------------------------------- MIDI input
  /** CPluginInstance note on (velocity 0..127). */
  noteOn(n: number, vel: number): void {
    this.vel01[n] = f32(vel * f32(1 / 127));
    if (vel === 0) { this.noteOff(n); return; }
    this.vel127[n] = Math.trunc(f32(this.vel01[n] * 127));
    if (this.arpOn) this.arp.update();
    else this.playNote(n, this.vel01[n]);
  }

  noteOff(n: number): void {
    this.vel01[n] = 0;
    if (this.cc[64] !== 0) return;
    this.vel127[n] = 0;
    if (this.arpOn) this.arp.update();
    else this.playNote(n, 0);
  }

  controlChange(c: number, v127: number): void {
    this.cc[c] = f32(v127 * f32(1 / 127));
    if (c === 64) {
      if (this.cc[64] === 0) {
        for (let n = 0; n < 128; n++) if (this.vel01[n] === 0 && this.vel127[n] !== 0) this.noteOff(n);
      }
    } else if (c === 121) {
      this.cc.fill(0);
      this.cc[7] = 1; this.cc[10] = 0.5;
    } else if (c === 123) {
      this.allNotesOff();
    } else {
      for (let p = 0; p < 74; p++) if (this.ccMap[p] === c) this.setParameter(p, this.cc[c]);
    }
  }

  /** CSynth::playNote: allocate generators (poly) or move the mono voice. */
  playNote(n: number, vel: number): void {
    this.vel127[n] = Math.trunc(f32(vel * 127));
    if (this.mono) { this.monoNote(n, vel); return; }
    if (vel === 0) {
      for (const g of this.gens) if (g.note === n) { g.released = true; g.noteOff(); }
      return;
    }
    this.seed2 = lcg(this.seed2);
    const r = this.seed2;
    let from = this.lastNote < 0 ? n : this.lastNote;
    if ((this.glideMode | 2) === 3) {
      let best = 128, cand = n, found = false;
      for (let i = 0; i < 128; i++) {
        const d = Math.abs(n - i);
        if (this.vel127[i] !== 0 && i !== n && d < best) { best = d; cand = i; found = true; }
      }
      from = found ? cand : n;
    }
    const det = f32((f32(r * U32) * 2 - 2) * f32(0.01));
    const maxV = this.maxVoices();
    for (let u = 0; u < this.uniCount; u++) {
      let g: PzGen;
      if (maxV < 1) g = this.gens[0];
      else {
        // FL: x22 = x8 = head; free -> take; released: min age vs x22; else min age vs x8
        let oldR = this.gens[0], oldA = this.gens[0], pick: PzGen | null = null;
        for (let i = 0; i < maxV; i++) {
          const c = this.gens[i];
          if (c.note < 0) { pick = c; break; }
          if (c.released) { if (oldR.age > c.age) oldR = c; }
          else if (oldA.age > c.age) oldA = c;
        }
        g = pick ?? (oldR.released ? oldR : oldA);
      }
      g.age = this.ageCtr++ >>> 0;
      g.setNote(n);
      g.uniIdx = u;
      g.uniCnt = this.uniCount;
      g.det = det;
      g.vel = this.velCurve === 1 ? vel : f32(Math.pow(vel, this.velCurve));
      g.released = false;
      g.glide = from;
      if (this.glideTime < 0.001) g.glide = n;
      if (this.glideMode <= 1) g.glideRate = f32(12 / (this.sr * this.glideTime));
      else g.glideRate = f32(Math.abs(f32(n - g.glide)) / (this.sr * this.glideTime));
      g.trigger();
    }
    this.lastNote = n;
  }

  private monoNote(n: number, vel: number): void {
    if (vel === 0) {
      let best = 128, cand = n, found = false;
      for (let i = 0; i < 128; i++) {
        const d = Math.abs(n - i);
        if (this.vel127[i] !== 0 && d < best) { best = d; cand = i; found = true; }
      }
      if (found) {
        for (const g of this.gens) {
          if (g.note !== n) continue;
          g.age = this.ageCtr++ >>> 0;
          g.setNote(cand);
          g.glideRate = f32(12 / (this.sr * this.glideTime));
          this.lastNote = cand;
        }
      } else {
        for (const g of this.gens) if (g.note === n) { g.released = true; g.noteOff(); }
      }
      return;
    }
    this.seed2 = lcg(this.seed2);
    const r = this.seed2;
    const last = this.lastNote < 0 ? n : this.lastNote;
    let from = n;
    const g0 = this.gens[0];
    if ((this.glideMode | 2) === 3) { if (g0.note >= 0 && !g0.released) from = last; }
    else from = last;
    const det = f32((f32(r * U32) * 2 - 2) * f32(0.01));
    for (let u = 0; u < this.uniCount && u < this.gens.length; u++) {
      const g = this.gens[u];
      const wasNote = g.note, wasRel = g.released;
      g.age = this.ageCtr++ >>> 0;
      g.setNote(n);
      g.released = false;
      g.det = det;
      g.uniIdx = u;
      g.uniCnt = this.uniCount;
      if (this.glideMode <= 1) g.glideRate = f32(12 / (this.sr * this.glideTime));
      else g.glideRate = f32(Math.abs(f32(n - g.glide)) / (this.sr * this.glideTime));
      if (wasNote < 0 || wasRel) {
        g.vel = this.velCurve === 1 ? vel : f32(Math.pow(vel, this.velCurve));
        g.glide = from;
        if (this.glideTime < 0.001) g.glide = n;
        g.trigger();
      }
    }
    this.lastNote = n;
  }

  // ------------------------------------------------------------- host side
  /** Sample rate change / FPD_Flush (sr 0): notes off, smoothers snap, effects reset. */
  setSampleRate(sr: number): void {
    if (sr > 0) this.sr = sr;
    const sus = this.cc[64];
    this.cc[64] = 0;
    for (let n = 0; n < 128; n++) this.noteOff(n);
    this.cc[64] = sus;
    for (const g of this.gens) { g.kill(this.sr); g.glide = 48; }
    this.mgL = this.masterGain(false);
    this.mgR = this.masterGain(true);
    this.lastNote = -1;
    this.arp.reset();
    this.arp.stop();
    if (sr !== 0) {
      this.delay.setSampleRate(sr);
      this.chorus.setSampleRate(sr);
      this.shL.setSampleRate(sr);
      this.shR.setSampleRate(sr);
      this.shL.reset(); this.shR.reset();
      this.delay.reset();
      this.chorus.reset();
      this.sr8 = sr * OSR;
      this.coefG = f32(sr * 6.802721088435375e-08);
      const w = (sr * 0.2617993877991494) / this.sr;
      const s = Math.sin(w), c = Math.cos(w);
      this.dg = dn(f32((1 - c) / fmaD(s, 0.5, 2)));
      this.db1 = dn(f32((c * -4) / (s + 2)));
      this.db2 = dn(f32((2 - s) / (s + 2)));
    }
    this.lfo.phase = 0;
    this.smPwA = this.pwA; this.smPwB = this.pwB; this.smOscBal = this.oscBal; this.smNoise = this.noiseBal;
    this.smLfo = this.lfoAmt; this.smEg = this.egAmt; this.smMw = this.mwAmt; this.smCut = this.cut;
    this.dz.fill(0);
    this.shL.reset(); this.shR.reset();
    this.delay.reset();
    this.chorus.reset();
  }

  /** Master gain / pan (gain x 0.5 x CC 7, pan from CC 10). */
  private masterGain(right: boolean): number {
    const s1 = f32(f32(this.gain * 0.5) * this.cc[7]);
    if (!(s1 > 0)) return 0;
    let p = f32((this.cc[10] - 0.5 + this.pan) * 2);
    p = Math.min(Math.max(p, 0), 2);
    if (!right) return p <= 1 ? s1 : f32(f32(2 - p) * s1);
    return p < 1 ? f32(p * s1) : s1;
  }

  private rebuild(): void {
    this.dirty = false;
    let k = 0;
    for (const g of this.gens) if (g.note >= 0) this.list[k++] = g;
    this.count = k;
    for (const g of this.gens) if (g.note < 0) this.list[k++] = g;
    this.list[1024] = this.spare;
    this.list[1025] = this.spare;
    this.list[1026] = this.spare;
  }

  /** One engine block (n <= 64 samples) into L / R (zeroed). */
  process(L: Float32Array, R: Float32Array, n: number): void {
    // per-block parameter smoothing
    this.smPwA = fma(f32(this.pwA - this.smPwA), C004, this.smPwA);
    this.smPwB = fma(f32(this.pwB - this.smPwB), C004, this.smPwB);
    this.smOscBal = fma(f32(this.oscBal - this.smOscBal), C004, this.smOscBal);
    this.smNoise = fma(f32(this.noiseBal - this.smNoise), C004, this.smNoise);
    this.smLfo = fma(f32(this.lfoAmt - this.smLfo), C004, this.smLfo);
    this.smEg = fma(f32(this.egAmt - this.smEg), C004, this.smEg);
    this.smMw = fma(f32(this.mwAmt - this.smMw), C004, this.smMw);
    this.smCut = fma(f32(this.cut - this.smCut), C004, this.smCut);
    if (this.dirty) this.rebuild();
    const N = n * OSR;
    const cnt = this.count;
    if (cnt >= 1) {
      const li = this.list;
      if (cnt === 1) {
        li[0].prep(N);
        this.renderOne(li[0], N, true);
      } else {
        for (let i = 0; i < 4; i++) if (li[i].note >= 0) li[i].prep(N);
        this.renderQuad(li[0], li[1], li[2], li[3], N, true);
        if (cnt >= 5) {
          let i = 4, r = cnt + 4;
          for (;;) {
            if (r === 9) {
              li[i].prep(N);
              this.renderOne(li[i], N, false);
              break;
            }
            for (let k = 0; k < 4; k++) if (li[i + k].note >= 0) li[i + k].prep(N);
            this.renderQuad(li[i], li[i + 1], li[i + 2], li[i + 3], N, false);
            i += 4;
            r -= 4;
            if (r <= 8) break;
          }
        }
      }
      this.decimate(L, R, n);
    }
    if (this.count !== 0) {
      if (this.playing) this.gate.resync(this.songPos);
      this.gate.process(this.sr, this.tempo, L, R, n);
    } else this.gate.idle();
    this.delay.setTempo(this.tempo);
    for (let i = 0; i < n; i++) {
      L[i] = this.shL.process(L[i]);
      R[i] = this.shR.process(R[i]);
    }
    this.chorus.process(L, R, n);
    this.delay.process(L, R, n);
    if (this.arpOn) this.arp.process(this.sr, this.tempo, n);
    const tL = this.masterGain(false), tR = this.masterGain(true);
    let gl = this.mgL, gr = this.mgR;
    for (let i = 0; i < n; i++) {
      L[i] = f32(L[i] * gl);
      R[i] = f32(R[i] * gr);
      gl = fma(f32(tL - gl), C0005, gl);
      gr = fma(f32(tR - gr), C0005, gr);
    }
    this.mgL = gl;
    this.mgR = gr;
    this.lfo.tick(this.sr, this.tempoF, n, this.rand64);
  }

  private decimate(L: Float32Array, R: Float32Array, n: number): void {
    const z = this.dz, g = this.dg, b1 = this.db1, b2 = this.db2;
    let lx2 = z[0], lx1 = z[1], ly2 = z[2], ly1 = z[3], rx2 = z[4], rx1 = z[5], ry2 = z[6], ry1 = z[7];
    const iL = this.b8L, iR = this.b8R;
    for (let o = 0; o < n; o++) {
      const base = o * OSR;
      for (let k = 0; k < OSR; k++) {
        const xl = iL[base + k];
        const tl = f32(f32(lx1 + lx1) + f32(xl + lx2));
        const yl = fnms(tl, g, fma(ly1, b1, f32(ly2 * b2)));
        lx2 = lx1; lx1 = xl; ly2 = ly1; ly1 = yl;
        const xr = iR[base + k];
        const tr = f32(f32(rx1 + rx1) + f32(xr + rx2));
        const yr = fnms(tr, g, fma(ry1, b1, f32(ry2 * b2)));
        rx2 = rx1; rx1 = xr; ry2 = ry1; ry1 = yr;
      }
      L[o] = ly1;
      R[o] = ry1;
      lx2 = dn(lx2); lx1 = dn(lx1); ly2 = dn(ly2); rx2 = dn(rx2); rx1 = dn(rx1); ry2 = dn(ry2);
      const yl = ly1, yr = ry1;
      ly1 = dn(yl); ry1 = dn(yr);
    }
    z[0] = lx2; z[1] = lx1; z[2] = ly2; z[3] = ly1; z[4] = rx2; z[5] = rx1; z[6] = ry2; z[7] = ry1;
  }

  /** One generator (FL's scalar loop). */
  private renderOne(g: PzGen, N: number, over: boolean): void {
    const oL = this.b8L, oR = this.b8R;
    const shA = this.shapeA, shB = this.shapeB, sync = this.syncA, ring = this.ringA, coef = this.coefG;
    let seed = this.seed;
    let pa = g.pa, pa2 = g.pa2, pb = g.pb, pb2 = g.pb2;
    const ia = g.ia, ib = g.ib;
    let nl = g.nl, lA = g.lA, lB = g.lB;
    let ox = g.ox, oy1 = g.oy1, oy2 = g.oy2, oy3 = g.oy3, y1 = g.y1, y2 = g.y2, y3 = g.y3, y4 = g.y4;
    const fp = g.fp, fk = g.fk, fr = g.fr, m0 = g.m0, m1 = g.m1, m2 = g.m2;
    let dc = g.dc, gL = g.gL, gR = g.gR, smL = g.smL, smR = g.smR;
    const sgL = g.sgL, sgR = g.sgR, ns = g.ns, sA = g.sA, sB = g.sB;
    for (let i = 0; i < N; i++) {
      pa = f32(pa - ia); pa2 = f32(pa2 - ia); pb = f32(pb - ib); pb2 = f32(pb2 - ib);
      if (pa < 0) pa = f32(pa + 1);
      if (pa2 < 0) pa2 = f32(pa2 + 1);
      let w = 0;
      if (pb < 0) { w = 1; pb = f32(pb + 1); }
      if (pb2 < 0) pb2 = f32(pb2 + 1);
      if (sync) {
        const t = f32(pa * w);
        pa2 = f32(pa2 - t);
        pa = f32(pa - t);
      }
      const A = fms(pa2, shA, pa);
      const B = fms(pb2, shB, pb);
      const mix = ring ? f32(fma(lA, A, lB) * B) : fma(lB, B, f32(lA * A));
      seed = (Math.imul(seed, LCG_A) + LCG_C) >>> 0;
      const nz = f32(f32(seed * NOISE_SCALE) + -0.125);
      let x = f32(f32(f32(nz * nl) + NEG042) + mix);
      x = fms(y4, fr, x);
      if (x < 0) x = f32(x / (f32(x * x) * 3 + 1));
      const t1 = f32(ox + x);
      const n1 = fnms(t1, fp, f32(y1 * fk));
      const t2 = f32(n1 + oy1);
      const n2 = fnms(t2, fp, f32(y2 * fk));
      const t3 = f32(n2 + oy2);
      const n3 = fnms(t3, fp, f32(y3 * fk));
      const kk = f32(fk * y4);
      const t4 = f32(n3 + oy3);
      const n4 = fnms(t4, fp, kk);
      y1 = n1; y2 = n2; y3 = n3; y4 = n4;
      ox = x; oy1 = n1; oy2 = n2; oy3 = n3;
      let out = fma(m2, x, fma(m1, n3, f32(m0 * n4)));
      const nd = fma(f32(out - dc), C1E4, dc);
      out = f32(out - nd);
      dc = dn(nd);
      nl = f32(ns + nl);
      lA = f32(lA + sA);
      lB = f32(lB + sB);
      gL = f32(sgL + gL);
      gR = f32(gR + sgR);
      smL = fma(f32(gL - smL), coef, smL);
      smR = fma(f32(gR - smR), coef, smR);
      if (over) { oL[i] = f32(smL * out); oR[i] = f32(smR * out); }
      else { oL[i] = fma(smL, out, oL[i]); oR[i] = fma(smR, out, oR[i]); }
    }
    this.seed = seed;
    g.pa = pa; g.pa2 = pa2; g.pb = pb; g.pb2 = pb2;
    g.nl = nl; g.lA = lA; g.lB = lB;
    g.ox = ox; g.oy1 = oy1; g.oy2 = oy2; g.oy3 = oy3; g.y1 = y1; g.y2 = y2; g.y3 = y3; g.y4 = y4;
    g.dc = dc; g.gL = gL; g.gR = gR; g.smL = smL; g.smR = smR;
  }

  /** Four generators at once (FL's NEON loop: its own rounding order, gains applied before their update). */
  private renderQuad(a: PzGen, b: PzGen, c: PzGen, d: PzGen, N: number, over: boolean): void {
    const G = [a, b, c, d];
    const oL = this.b8L, oR = this.b8R;
    const shA = this.shapeA, shB = this.shapeB, sync = this.syncA, ring = this.ringA, coef = this.coefG;
    let seed = this.seed;
    const pa = G.map((g) => g.pa), pa2 = G.map((g) => g.pa2), pb = G.map((g) => g.pb), pb2 = G.map((g) => g.pb2);
    const ia = G.map((g) => g.ia), ib = G.map((g) => g.ib);
    const nl = G.map((g) => g.nl), lA = G.map((g) => g.lA), lB = G.map((g) => g.lB);
    const ox = G.map((g) => g.ox), oy1 = G.map((g) => g.oy1), oy2 = G.map((g) => g.oy2), oy3 = G.map((g) => g.oy3);
    const y1 = G.map((g) => g.y1), y2 = G.map((g) => g.y2), y3 = G.map((g) => g.y3), y4 = G.map((g) => g.y4);
    const fp = G.map((g) => g.fp), fk = G.map((g) => g.fk), fr = G.map((g) => g.fr);
    const m0 = G.map((g) => g.m0), m1 = G.map((g) => g.m1), m2 = G.map((g) => g.m2);
    const dc = G.map((g) => g.dc), gL = G.map((g) => g.gL), gR = G.map((g) => g.gR), smL = G.map((g) => g.smL), smR = G.map((g) => g.smR);
    const sgL = G.map((g) => g.sgL), sgR = G.map((g) => g.sgR), ns = G.map((g) => g.ns), sA = G.map((g) => g.sA), sB = G.map((g) => g.sB);
    const lo = [0, 0, 0, 0], ro = [0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      const s0 = (Math.imul(seed, LCG_A) + LCG_C) >>> 0;
      const s1 = (Math.imul(s0, LCG_A) + LCG_C) >>> 0;
      const s2 = (Math.imul(s1, LCG_A) + LCG_C) >>> 0;
      const s3 = (Math.imul(s2, LCG_A) + LCG_C) >>> 0;
      seed = s3;
      const seeds = [s0, s1, s2, s3];
      for (let l = 0; l < 4; l++) {
        let A1 = f32(pa[l] - ia[l]);
        let B1 = f32(pb[l] - ib[l]);
        A1 = f32((A1 <= 0 ? 1 : 0) + A1);
        const wB = B1 <= 0 ? 1 : 0;
        const t = sync ? f32(A1 * wB) : 0;
        let A2 = f32(pa2[l] - ia[l]);
        A2 = f32((A2 <= 0 ? 1 : 0) + A2);
        B1 = f32(wB + B1);
        let B2 = f32(pb2[l] - ib[l]);
        B2 = f32((B2 <= 0 ? 1 : 0) + B2);
        A2 = f32(A2 - t);
        A1 = f32(A1 - t);
        pa[l] = A1; pa2[l] = A2; pb[l] = B1; pb2[l] = B2;
        const oa = fms(A2, shA, A1);
        const obb = fms(B2, shB, B1);
        const mix = ring ? f32(fma(oa, lA[l], lB[l]) * obb) : fma(oa, lA[l], f32(obb * lB[l]));
        const nz = f32(f32(f32(seeds[l] * NOISE_SCALE) + -0.125) * nl[l]);
        const fb = fms(fr[l], y4[l], NEG042);
        let x = f32(f32(fb + nz) + mix);
        const den = fma(f32(x * x), x <= 0 ? 3 : 0, 1);
        x = f32(x / den);
        const k = fk[l], p = fp[l];
        const n1 = fms(y1[l], k, f32(f32(x + ox[l]) * p));
        const n2 = fms(y2[l], k, f32(f32(n1 + oy1[l]) * p));
        const n3 = fms(y3[l], k, f32(f32(n2 + oy2[l]) * p));
        const n4 = fms(y4[l], k, f32(f32(n3 + oy3[l]) * p));
        let out = fma(n4, m0[l], fma(n3, m1[l], f32(x * m2[l])));
        const nd = fma(f32(out - dc[l]), C1E4, dc[l]);
        dc[l] = nd;
        out = f32(out - nd);
        lo[l] = f32(out * smL[l]);
        ro[l] = f32(out * smR[l]);
        ox[l] = x; y1[l] = n1; y2[l] = n2; y3[l] = n3; y4[l] = n4; oy1[l] = n1; oy2[l] = n2; oy3[l] = n3;
      }
      const sL = f32(f32(lo[0] + lo[1]) + f32(lo[2] + lo[3]));
      const sR = f32(f32(ro[0] + ro[1]) + f32(ro[2] + ro[3]));
      if (over) { oL[i] = sL; oR[i] = sR; }
      else { oL[i] = f32(oL[i] + sL); oR[i] = f32(oR[i] + sR); }
      for (let l = 0; l < 4; l++) {
        gL[l] = f32(gL[l] + sgL[l]);
        gR[l] = f32(gR[l] + sgR[l]);
        nl[l] = f32(nl[l] + ns[l]);
        lA[l] = f32(lA[l] + sA[l]);
        lB[l] = f32(lB[l] + sB[l]);
        smL[l] = fma(f32(gL[l] - smL[l]), coef, smL[l]);
        smR[l] = fma(f32(gR[l] - smR[l]), coef, smR[l]);
      }
    }
    this.seed = seed;
    G.forEach((g, l) => {
      g.pa = pa[l]; g.pa2 = pa2[l]; g.pb = pb[l]; g.pb2 = pb2[l];
      // FL's NEON code stores the oscillator levels lane-reversed (generator i gets lane 3 - i's)
      g.nl = nl[l]; g.lA = lA[3 - l]; g.lB = lB[3 - l];
      g.ox = ox[l]; g.oy1 = oy1[l]; g.oy2 = oy2[l]; g.oy3 = oy3[l]; g.y1 = y1[l]; g.y2 = y2[l]; g.y3 = y3[l]; g.y4 = y4[l];
      g.dc = dc[l]; g.gL = gL[l]; g.gR = gR[l]; g.smL = smL[l]; g.smR = smR[l];
    });
  }
}

function egTime(v: number, span: number, lo: number, hi: number): number {
  const q = f32(v * v);
  const t = fma(f32(q * q), span, lo);
  return f32(Math.min(Math.max(t, lo), hi) * f32(0.001));
}

const clampI = (x: number, hi: number): number => Math.min(Math.max(Math.trunc(x), 0), hi);
