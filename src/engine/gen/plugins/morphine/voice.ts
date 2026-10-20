// A Morphine voice (CMorGenerator, vtable 0x873a8): FL 2026 Morphine_x64.dylib
// ported operation for operation (float32 via Math.fround, fused multiply-adds
// where the arm64 code uses them, doubles where it uses doubles, macOS libm).
// .flref/morphine/NOTES.md section 4 describes the algorithms; the addresses
// below are the binary's.
//
// Per voice: the master ADSR (doubles), the modulation processor (4 looping
// envelopes + the 12-slot matrix into 48 targets), the morph processor (morph
// path -> corner weights of generators A..D), per generator its zone, its
// timeline processor (breakpoint interpolation, loops, release snapshot) and
// PWM, the oscillator bank (osc.ts) and the noise layer with its filter. The
// voice runs on its own control grid: blocks of trunc(sr * 0.0029) samples
// from the note start; spectra are recomputed at blocks 0, 1, 4, 7, ...

import { exp10f, exp2f } from '../poizone/applemath';
import { cos, sin } from '../harmor/fx-libm';
import { exp10, exp2, fmaD } from '../../../../model/gen/plugins/morphine/libm';
import { NP } from '../../../../model/gen/plugins/morphine/state';
import { OscBank, fmaf } from './osc';
import type { CGen, CNoise, CProgram, CZone } from './program';

const f32 = Math.fround;
/** float fused multiply-add (exact, osc.ts). */
const fma = fmaf;
/** float32 threshold of unset modulation targets (-999.9f). */
const UNSET = f32(-999.9);
const FL1E9 = f32(1e-9);
const C12 = 0.08333333333333333; // 0x3fb5555555555555
const C5_12 = 0.41666666666666669; // 0x3fdaaaaaaaaaaaab
const KEY120 = 0.008333333333333333; // 0x3f81111111111111
const TWO_PI = 6.283185307179586;

/** Synth-wide values the voices read (CMorSynth fields). */
export interface SynthCtx {
  prog: CProgram;
  /** Program parameter floats 0..122. */
  f: Float32Array;
  /** MIDI CC values / 127 (synth+0x1268; CC7 = 1, CC10 = 0.5 initially). */
  cc: Float32Array;
  /** Channel aftertouch (synth+0x166c) and pitch wheel (synth+0x1468). */
  at: number;
  wheel: number;
  /** Tempo as the voices see it (float BPM). */
  tempo: number;
  /** Per key: FL left / right volume and pitch offset in semitones (Gen_Render 0x68940). */
  levL: Float32Array;
  levR: Float32Array;
  levPitch: Float32Array;
  /** trunc(48 f4 - 24) (key tracking transpose) and transpose + 0.01 fine (pitch). */
  transpInt: number;
  transpFine: number;
  /** trunc(12 f3). */
  bendRange: number;
  /** Synth voice count per key (synth+0xa20). */
  keyVoices: Int32Array;
}

// ------------------------------------------------------------------ shared line helpers

/** Loop a time (0x585d4 / 0x5cea8 / 0x49bf4): modes 0 none, 1 forward, 2 backward, 3 ping-pong. */
function loopT(lm: number, ls: number, le: number, t: number): number {
  if (lm === 0) return t;
  const len = (le - ls) | 0;
  const dle = le;
  if (len === 0 && !(dle > t)) return dle;
  if (lm === 3) {
    if (dle > t) return t;
    let d = t - dle;
    const k = Math.trunc(d / len) | 0;
    d = d - Math.imul(len, k);
    return (k & 1) === 0 ? dle - d : d + ls;
  }
  if (lm === 2) {
    if (dle >= t) return t;
    const d1 = dle - t;
    if (d1 >= ls) return d1;
    let w = Math.trunc(-t) | 0;
    if (w < 0) w = -w;
    const q = (w / len) | 0;
    return d1 + Math.imul(q, len);
  }
  if (lm === 1) {
    if (dle >= t) return t;
    const k = Math.trunc((t - ls) / len) | 0;
    return t - Math.imul(len, k);
  }
  return t;
}

/** Evaluate a line (envelope levels / morph axis): walk by dt, interpolate in double (0x58194 / 0x497c0). */
function evalLine(v: Float32Array, dt: Int32Array, n: number, t: number, rel: number, relVal: number): number {
  let i = 0;
  while (i + 1 < n) {
    const d = dt[i];
    if (t < d) break;
    t -= d;
    i++;
  }
  if (i + 1 < n) {
    const from = i === rel ? relVal : v[i];
    const to = i + 1 === rel ? relVal : v[i + 1];
    return f32(((to - from) * t) / dt[i] + from);
  }
  return i === rel ? relVal : v[i];
}

/** First point whose start time is >= le (0x590bc / 0x5dad4): [index or -1, its start time]. */
function findRelease(dt: Int32Array, n: number, le: number, out: Int32Array): void {
  let start = 0, i = 0;
  while (i < n) {
    if (start >= le) break;
    start = (start + dt[i]) | 0;
    i++;
  }
  out[0] = i < n ? i : -1;
  out[1] = start;
}

// ------------------------------------------------------------------ ADSR (voice+0x48, 0x72ab4..0x72db4)

class Adsr {
  sr = 44100;
  peak = 1;
  end = 0;
  atkStart = 0;
  incA = 0;
  incD = 0;
  sus = 0;
  incR = 0;
  stage = 0;
  ph = 0;
  done = true;
  value = 0;
  relStart = 0;
  cA = 0;
  cD = -2;
  cR = -2;

  init(a: number, d: number, s: number, sr: number): void {
    this.sr = sr;
    this.peak = 1;
    this.end = 0;
    this.atkStart = this.done ? 0 : this.value;
    this.done = false;
    this.stage = 0;
    this.ph = 0;
    this.sus = s;
    this.cA = 0;
    this.cD = -2;
    this.cR = -2;
    this.incA = 1 / (Math.max(a, 0.001) * sr);
    this.incD = 1 / (Math.max(d, 0.001) * sr);
    this.incR = 1 / (0.001 * sr);
  }

  setRelease(r: number): void {
    if (this.stage !== 2) this.incR = 1 / (Math.max(r, 0.001) * this.sr);
  }

  release(): void {
    if (this.stage !== 2) { this.relStart = this.value; this.stage = 2; this.ph = 0; }
  }

  private seg(from: number, to: number, c: number): number {
    const ph = this.ph;
    if (c === 0) return fmaD(to - from, ph, from);
    const e = exp10(c * ph);
    return fmaD(fmaD(ph, e, -e) + 1, to - from, from);
  }

  next(n: number): number {
    let v = 0;
    this.value = 0;
    if (this.stage === 0) {
      this.ph = fmaD(this.incA, n, this.ph);
      if (this.ph >= 1) { this.stage = 1; this.ph = 0; v = this.peak; }
      else v = this.seg(this.atkStart, this.peak, this.cA);
    } else if (this.stage === 1) {
      this.ph = fmaD(this.incD, n, this.ph);
      if (this.ph >= 1) {
        v = this.sus;
        if (v === 0 && this.end === 0) { this.stage = 2; this.done = true; }
        this.ph = 1;
      } else v = this.seg(this.peak, this.sus, this.cD);
    } else if (this.stage === 2) {
      this.ph = fmaD(this.incR, n, this.ph);
      if (this.ph >= 1) { this.done = true; this.ph = 1; v = this.end; }
      else v = this.seg(this.relStart, this.end, this.cR);
    } else return 0;
    if (v < 0) v = 0;
    this.value = v;
    return f32(v);
  }
}

// ------------------------------------------------------------------ modulation (CModProcessor, 0x251fc..0x258c0)

class EnvProc {
  t = 0;
  released = false;
  rl = false;
  gain = 1;
  relVal = 0;
  rel = -1;
}

const REL = new Int32Array(2);

class ModProc {
  key = 0;
  vel = 0;
  readonly eg = new Float32Array(4);
  readonly tg = new Float32Array(48).fill(-1000);
  readonly envs = [new EnvProc(), new EnvProc(), new EnvProc(), new EnvProc()];

  constructor(private readonly s: SynthCtx) {}

  /** Clamped modulated value (0x257a8): clamp(target + base, 0, 1). */
  clamped(k: number, base: number): number {
    let t = this.tg[k];
    if (t < UNSET) t = 0;
    const v = f32(t + base);
    return v > 0 ? (v < 1 ? v : 1) : 0;
  }

  /** Raw target (0x258c0), 0 when unset. */
  target(k: number): number {
    const t = this.tg[k];
    return t < UNSET ? 0 : t;
  }

  noteOn(key: number, vel: number): void {
    this.key = key;
    this.vel = vel;
    this.eg.fill(0);
    const f = this.s.f;
    for (let e = 0; e < 4; e++) {
      const ep = this.envs[e];
      ep.rel = -1;
      ep.t = 0;
      ep.rl = f[99 + 6 * e] !== 0;
      const V = f[104 + 6 * e];
      ep.gain = f32(fmaD(vel, V, -V) + 1);
      ep.released = false;
    }
    this.matrix();
  }

  release(): void {
    const prog = this.s.prog;
    for (let e = 0; e < 4; e++) {
      const ep = this.envs[e], l = prog.envs[e];
      if (ep.rl && l.lm !== 0) {
        findRelease(l.dt, l.n, l.le, REL);
        if (REL[0] >= 0) {
          ep.rel = REL[0];
          const tt = loopT(l.lm, l.ls, l.le, ep.t);
          ep.relVal = evalLine(l.x, l.dt, l.n, tt, -1, 0);
          ep.t = REL[1];
        }
      }
      ep.released = true;
    }
  }

  reset(): void {
    for (const ep of this.envs) { ep.t = 0; ep.released = false; ep.rel = -1; }
  }

  /** ModProc_VoiceProcess 0x251fc: the 4 envelopes for n samples, then the matrix. */
  process(n: number, sr: number, tempo: number): void {
    const f = this.s.f, prog = this.s.prog;
    const keyD = f32(this.key + -48) * C12;
    const velD = this.vel + -0.5;
    for (let e = 0; e < 4; e++) {
      const b = 99 + 6 * e;
      const kt = f32(2 * f[b + 3] + -1), vt = f32(2 * f[b + 4] + -1);
      const rate = this.clamped(41 + 2 * e, f[b + 2]);
      const d0 = fmaD(fmaD(velD, vt, rate), 8, fmaD(kt, keyD, -4));
      const sp = exp2(d0);
      const U = f[b + 1] !== 0 ? tempo * C5_12 : 100;
      const step = ((U * n) * sp) / sr;
      // EnvProc advance 0x168f4
      const ep = this.envs[e], l = prog.envs[e];
      ep.t = ep.t + step;
      const tt = ep.released && ep.rl ? ep.t : loopT(l.lm, l.ls, l.le, ep.t);
      let v = evalLine(l.x, l.dt, l.n, tt, ep.rel, ep.relVal);
      if (l.extra) v = f32(f32(v + v) + -1);
      v = f32(v * ep.gain);
      const amp = this.tg[40 + 2 * e];
      this.eg[e] = f32((amp < UNSET ? 1 : amp) * v);
    }
    this.matrix();
  }

  /** The matrix 0x25604. */
  matrix(): void {
    const tg = this.tg, prog = this.s.prog, s = this.s;
    tg.fill(-1000);
    for (let k = 0; k < 12; k++) {
      const src = prog.src[k], dst = prog.dst[k];
      if (src === 0 || dst === 0) continue;
      let cur = tg[dst];
      if (cur < UNSET) { tg[dst] = 0; cur = 0; }
      let sv = 0;
      switch (src) {
        case 1: sv = f32(f32(this.key) * KEY120); break;
        case 2: sv = this.vel; break;
        case 3: sv = s.wheel; break;
        case 4: sv = s.at; break;
        case 5: case 6: case 7: case 8: sv = this.eg[src - 5]; break;
        default: sv = s.cc[(src + 0x77) & 0x7f];
      }
      let v = f32(sv * f32(2 * prog.amt[k] + -1));
      if (v < -1) v = -1;
      else if (v > 1) v = 1;
      tg[dst] = f32(v + cur);
    }
  }
}

// ------------------------------------------------------------------ generators (per voice: 0x25d8..0x34e4, PWM 0x1ade0..0x1b2a0)

class GenProc {
  initialized = false;
  sr = 44100;
  tempo = 0;
  /** U / sr of the zone's timeline (gp+0x18). */
  ups = 0;
  // PWM (gp+0x20)
  readonly pwmPh = new Float64Array(NP);
  pwmRate = 0.25;
  pwmSr = 44100;
  pwmInc = 0.25 / 44100;
  pwmMode = 0;
  // zone and timeline processor (gp+0x8b8)
  zone: CZone | null = null;
  zoneVer = 0;
  key = 0;
  vel = 0;
  zg = 1;
  t = 0;
  released = false;
  rl = false;
  rel = -1;
  readonly snapA = new Float32Array(NP);
  readonly snapP = new Float32Array(NP);
  readonly snapD = new Float32Array(NP);
  snapL = 0;
  // output (amplitude, pan, ratio)
  readonly amp = new Float32Array(NP);
  readonly pan = new Float32Array(NP);
  readonly ratio = new Float32Array(NP);

  constructor(private readonly s: SynthCtx, private readonly mod: ModProc, private readonly g: number) {}

  private get gen(): CGen { return this.s.prog.gens[this.g]; }
  /** Timeline values of the zone: its own, or FL's parameters 43..47 for the current zone. */
  private zp(z: CZone, k: number): number {
    if (z.idx === this.gen.cz && this.gen.zones[z.idx] === z) return this.s.f[43 + 10 * this.g + k];
    return k === 0 ? z.rl : k === 1 ? z.sync : k === 2 ? z.rate : k === 3 ? z.vt : z.kt;
  }

  private pwmSetRate(r: number): void {
    if (this.pwmRate !== r) { this.pwmRate = r; this.pwmInc = r / this.pwmSr; }
  }

  private pwmResetPhases(ph: number): void {
    const c = ph > 0 ? (ph < 1 ? ph : 1) : 0;
    for (let k = 0; k < NP; k++) {
      const v = (k + 1) * c;
      this.pwmPh[k] = 1 > v ? v : v - Math.trunc(v);
    }
  }

  private uRecalc(): void {
    const z = this.zone;
    if (!z) return;
    this.ups = (this.zp(z, 1) ? this.tempo * C5_12 : 100) / this.sr;
  }

  setSr(sr: number): void {
    this.sr = sr;
    if (this.pwmSr !== sr) { this.pwmSr = sr; this.pwmInc = this.pwmRate / sr; }
    this.uRecalc();
  }

  setTempo(tempo: number): void {
    this.tempo = tempo;
    this.uRecalc();
  }

  /** PWM ctor / reset state (0x1aeb8). */
  pwmInit(): void {
    this.pwmMode = 0;
    this.pwmRate = 0.25;
    this.pwmInc = 0.25 / this.pwmSr;
    this.pwmPh.fill(0);
  }

  private selectZone(): void {
    const zones = this.gen.zones;
    let key = this.key, i = 0;
    while (i + 1 < zones.length) {
      key = (key - zones[i].w) | 0;
      if (key < 0) break;
      i++;
    }
    const z = zones[i];
    this.zone = z;
    this.zoneVer = this.s.prog.version;
    this.zg = z.zg;
    this.uRecalc();
  }

  noteOn(key: number, vel: number): void {
    this.key = key;
    this.vel = vel;
    const f = this.s.f, b = 43 + 10 * this.g;
    if (!this.initialized) {
      this.pwmSetRate(f32(this.mod.clamped(14, f[b + 6]) * 0.25));
      this.pwmMode = Math.trunc(f32(f32(this.gen.pwm * 0.5 * 2) + 0.5));
      if (f[b + 5] === 0) this.pwmResetPhases(f[b + 7]);
    }
    this.initialized = true;
    this.selectZone();
    // timeline note on 0x2ae20
    this.rel = -1;
    this.t = 0;
    this.released = false;
    this.rl = this.zp(this.zone!, 0) !== 0;
  }

  release(): void {
    const z = this.zone;
    if (!z) return;
    this.released = true;
    if (this.rl && z.lm !== 0) {
      findRelease(z.times, z.n, z.le, REL);
      if (REL[0] >= 0) {
        this.rel = REL[0];
        this.snapshot(loopT(z.lm, z.ls, z.le, this.t));
        this.t = REL[1];
      }
    }
  }

  reset(): void {
    this.initialized = false;
    if (this.zone) { this.released = false; this.t = 0; this.rel = -1; }
    this.zone = null;
    if (this.s.f[43 + 10 * this.g + 5] === 0) this.pwmResetPhases(this.s.f[43 + 10 * this.g + 7]);
  }

  /** Release snapshot 0x5c8e0: the spectrum at the (looped) time t becomes the release segment's start. */
  private snapshot(t: number): void {
    const z = this.zone!;
    let i = 0;
    while (i + 1 < z.n) {
      const d = z.times[i];
      if (t < d) break;
      t -= d;
      i++;
    }
    const o0 = i * NP;
    if (i + 1 < z.n) {
      const fr = t / z.times[i], g = 1 - fr, o1 = o0 + NP;
      for (let k = 0; k < NP; k++) {
        let v = f32(fmaD(fr, z.amp[o1 + k], g * z.amp[o0 + k]));
        this.snapA[k] = v > -FL1E9 && v < FL1E9 ? 0 : v;
        v = f32(fmaD(fr, z.pan[o1 + k], g * z.pan[o0 + k]));
        this.snapP[k] = v > -FL1E9 && v < FL1E9 ? 0 : v;
        v = f32(fmaD(fr, z.det[o1 + k], g * z.det[o0 + k]));
        this.snapD[k] = v > -FL1E9 && v < FL1E9 ? 0 : v;
      }
      this.snapL = f32(fmaD(fr, z.levels[i + 1], g * z.levels[i]));
    } else {
      this.snapA.set(z.amp.subarray(o0, o0 + NP));
      this.snapP.set(z.pan.subarray(o0, o0 + NP));
      this.snapD.set(z.det.subarray(o0, o0 + NP));
      this.snapL = z.levels[i];
    }
  }

  /** Generator compute 0x2b94: the zone's spectrum for the coming n samples into amp / pan / ratio. */
  compute(n: number): void {
    if (!this.zone) return;
    if (this.zoneVer !== this.s.prog.version) {
      // the program changed under the voice (0x15e1c): pick the zone again, keep the timeline time
      const t = this.t, rel = this.released;
      this.selectZone();
      this.t = t;
      this.released = rel;
      this.rel = -1;
    }
    const z = this.zone, f = this.s.f, b = 43 + 10 * this.g, mod = this.mod;
    // rate speed 0x30d4
    const kt = f32(2 * this.zp(z, 4) + -1), vt = f32(2 * this.zp(z, 3) + -1);
    const rate = mod.clamped(13 + 4 * this.g, this.zp(z, 2));
    const keyD = f32(this.key + -48) * C12;
    const speed = exp2(fmaD(fmaD(this.vel + -0.5, vt, rate), 8, fmaD(keyD, kt, -4)));
    const step = this.ups * speed;
    // timeline evaluation 0x2b054
    let tt = this.released && this.rl ? this.t : loopT(z.lm, z.ls, z.le, this.t);
    let i = 0;
    while (i + 1 < z.n) {
      const d = z.times[i];
      if (tt < d) break;
      tt -= d;
      i++;
    }
    const hasNext = i + 1 < z.n;
    const curSnap = this.rel >= 0 && i === this.rel;
    const nextSnap = this.rel >= 0 && i + 1 === this.rel;
    let w0: number, w1: number, W0: number, W1: number;
    if (hasNext) {
      const fr = tt / z.times[i];
      w0 = f32(1 - fr);
      w1 = f32(fr);
      const L0 = curSnap ? this.snapL : z.levels[i];
      const L1 = nextSnap ? this.snapL : z.levels[i + 1];
      W0 = f32(fmaD(-fr, L0, L0));
      W1 = f32(fr * L1);
    } else {
      w0 = 1; w1 = 0; W0 = curSnap ? this.snapL : z.levels[i]; W1 = 0;
    }
    this.t = fmaD(n, step, this.t);
    const zg = this.zg;
    W0 = f32(zg * W0); W1 = f32(W1 * zg); w0 = f32(w0 * zg); w1 = f32(w1 * zg);
    let D = mod.clamped(15 + 4 * this.g, f[b + 8]), P = mod.clamped(16 + 4 * this.g, f[b + 9]);
    D = f32(D * D);
    P = f32(P * P);
    const vm1 = f32(this.vel + -1);
    const amp = this.amp, pan = this.pan, ratio = this.ratio, ca = z.ca, cb = z.cb;
    const A0 = curSnap ? this.snapA : z.amp, P0 = curSnap ? this.snapP : z.pan, D0 = curSnap ? this.snapD : z.det;
    const o0 = curSnap ? 0 : i * NP;
    if (hasNext) {
      const A1 = nextSnap ? this.snapA : z.amp, P1 = nextSnap ? this.snapP : z.pan, D1 = nextSnap ? this.snapD : z.det;
      const o1 = nextSnap ? 0 : (i + 1) * NP;
      for (let k = 0; k < NP; k++) {
        let a = f32(A0[o0 + k] * W0);
        a = fma(A1[o1 + k], W1, a);
        const sq = f32(a * a), cav = f32(ca[k] * vm1);
        const a3 = f32(sq * f32(a * cb[k]));
        amp[k] = fma(a3, cav, a3);
        let p = f32(P0[o0 + k] * w0);
        p = fma(P1[o1 + k], w1, p);
        pan[k] = f32(p * P);
        let d = f32(D0[o0 + k] * w0);
        d = fma(D1[o1 + k], w1, d);
        ratio[k] = fma(d, D, k + 1);
      }
    } else {
      const s2 = f32(w0 * P), s3 = f32(w0 * D);
      for (let k = 0; k < NP; k++) {
        const a = f32(A0[o0 + k] * W0);
        const sq = f32(a * a), cav = f32(ca[k] * vm1);
        const a3 = f32(sq * f32(a * cb[k]));
        amp[k] = fma(a3, cav, a3);
        pan[k] = f32(P0[o0 + k] * s2);
        ratio[k] = fma(D0[o0 + k], s3, k + 1);
      }
    }
    // PWM 0x1af30 (the rate's modulation target is 14 for all generators: FL's bug)
    this.pwmSetRate(f32(mod.clamped(14, f[b + 6]) * 0.25));
    this.pwmMode = Math.trunc(f32(f32(this.gen.pwm * 0.5 * 2) + 0.5));
    const mode = this.pwmMode;
    if (mode === 1 || mode === 2) {
      const step2 = this.pwmInc * n;
      for (let k = 0; k < NP; k++) {
        let ph = fmaD(step2, ratio[k], this.pwmPh[k]);
        if (ph > 1) ph -= Math.trunc(ph);
        this.pwmPh[k] = ph;
        const c = cos(ph * TWO_PI);
        amp[k] = f32(amp[k] * f32(mode === 2 ? 1 - c : c));
      }
    }
  }
}

// ------------------------------------------------------------------ morph (CMorphLineProcessor, 0x66748..0x67064)

class MorphProc {
  key = 0;
  vel = 0;
  t = 0;
  ups = 0;
  sr = 44100;
  tempo = 0;
  readonly gens: GenProc[];
  readonly amp = new Float32Array(NP);
  readonly pan = new Float32Array(NP);
  readonly ratio = new Float32Array(NP);

  constructor(private readonly s: SynthCtx, private readonly mod: ModProc) {
    this.gens = [0, 1, 2, 3].map((g) => new GenProc(s, mod, g));
  }

  private uRecalc(): void {
    this.ups = (this.s.f[83] !== 0 ? this.tempo * C5_12 : 100) / this.sr;
  }

  setSr(sr: number): void {
    for (const g of this.gens) g.setSr(sr);
    this.sr = sr;
    this.uRecalc();
  }

  setTempo(tempo: number): void {
    for (const g of this.gens) g.setTempo(tempo);
    this.tempo = tempo;
    this.uRecalc();
  }

  noteOn(key: number, vel: number): void {
    this.key = key;
    const v = f32(vel);
    this.vel = v;
    for (const g of this.gens) g.noteOn(key, v);
    this.t = 0;
  }

  release(): void { for (const g of this.gens) g.release(); }
  reset(): void { for (const g of this.gens) g.reset(); }

  /** Morph compute 0x668e4: the voice spectrum for the coming n samples. */
  compute(n: number): void {
    const s = this.s, f = s.f, mod = this.mod, ml = s.prog.morph;
    const lt = loopT(ml.lm, ml.ls, ml.le, this.t);
    const X = mod.clamped(30, evalLine(ml.x, ml.dt, ml.n, lt, -1, 0));
    const Y = mod.clamped(31, evalLine(ml.y, ml.dt, ml.n, lt, -1, 0));
    const mA = mod.clamped(32, f[87]), mB = mod.clamped(34, f[90]), mC = mod.clamped(36, f[93]), mD = mod.clamped(38, f[96]);
    let wA: number, wB: number, wC: number, wD: number, cA: number, cB: number, cC: number, cD: number;
    const solo = ml.extra;
    if (solo >= 1 && solo <= 4) {
      wA = solo === 1 ? 1 : 0; wB = solo === 2 ? 1 : 0; wC = solo === 3 ? 1 : 0; wD = solo === 4 ? 1 : 0;
      cA = wA; cB = wB; cC = wC; cD = wD;
    } else {
      const gD = f[98] !== 0 ? 0 : f32(mD * mD), gC = f[95] !== 0 ? 0 : f32(mC * mC);
      const gB = f[92] !== 0 ? 0 : f32(mB * mB), gA = f[89] !== 0 ? 0 : f32(mA * mA);
      const omx = 1 - X;
      wD = f32(fmaD(-Y, omx, omx));
      wC = f32(fmaD(-Y, X, X));
      wB = f32(Y * X);
      wA = f32(fmaD(-X, Y, Y));
      cA = f32(wA * gA); cB = f32(wB * gB); cC = f32(gC * wC); cD = f32(gD * wD);
    }
    const pA = f32(2 * mod.clamped(33, f[88]) + -1), pB = f32(2 * mod.clamped(35, f[91]) + -1);
    const pC = f32(2 * mod.clamped(37, f[94]) + -1), pD = f32(2 * mod.clamped(39, f[97]) + -1);
    const gs = this.gens, ga = gs[0], gb = gs[1], gc = gs[2], gd = gs[3];
    ga.compute(n); gb.compute(n); gc.compute(n); gd.compute(n);
    const amp = this.amp, pan = this.pan, ratio = this.ratio;
    for (let k = 0; k < NP; k++) {
      let a = f32(ga.amp[k] * cA);
      a = fma(gb.amp[k], cB, a);
      a = fma(gc.amp[k], cC, a);
      amp[k] = fma(gd.amp[k], cD, a);
      let p = f32(f32(ga.pan[k] + pA) * wA);
      p = fma(f32(gb.pan[k] + pB), wB, p);
      p = fma(f32(gc.pan[k] + pC), wC, p);
      pan[k] = fma(f32(gd.pan[k] + pD), wD, p);
      let r = f32(ga.ratio[k] * wA);
      r = fma(gb.ratio[k], wB, r);
      r = fma(gc.ratio[k], wC, r);
      ratio[k] = fma(gd.ratio[k], wD, r);
    }
    // advance the morph time
    const kt = f32(2 * f[85] + -1), vt = f32(2 * f[86] + -1);
    const rate = mod.clamped(29, f[84]);
    const keyD = f32(this.key + -48) * C12;
    const sp = exp2(fmaD(fmaD(this.vel + -0.5, vt, rate), 8, fmaD(keyD, kt, -4)));
    this.t = fmaD(this.ups * n, sp, this.t);
  }
}

// ------------------------------------------------------------------ the voice

export class Voice {
  key = -1;
  sr = 44100;
  vel = 0;
  released = false;
  glideRate = 0;
  glidePos = 0;
  age = 0;
  blk = 127;
  private pos = 0;
  private upd = -1;
  private first = false;
  private doneCnt = 0;
  private amp = 0;
  private pitchF = 1;
  private panMod = 0;
  private readonly adsr = new Adsr();
  private readonly mod: ModProc;
  private readonly morph: MorphProc;
  private readonly osc = new OscBank();
  // noise layer (voice+0x118..0x154) and filter (voice+0xe8)
  private nPos = 0;
  private nInc = 0;
  private nGL = 0;
  private nGR = 0;
  private nDL = 0;
  private nDR = 0;
  private nLs = 0;
  private nLe = 0;
  private nLen = 0;
  private nDir = 1;
  private nMode = 0;
  private nMono = false;
  private fMode = 0;
  private fc0 = 0;
  private fc1 = 0;
  private fc2 = 0;
  private readonly fs = new Float32Array(8);
  private readonly dummy = new Float32Array(1);

  constructor(private readonly s: SynthCtx) {
    this.mod = new ModProc(s);
    this.morph = new MorphProc(s, this.mod);
    for (const g of this.morph.gens) g.pwmInit();
  }

  /** Per-key voice count bookkeeping (0x654b0). */
  setKey(key: number): void {
    const kv = this.s.keyVoices;
    if (this.key >= 0 && this.key < 128 && kv[this.key] > 0) kv[this.key]--;
    this.key = key;
    if (key >= 0 && key < 128) kv[key]++;
  }

  /** Free the voice (0x6542c). */
  private free(): void {
    const kv = this.s.keyVoices;
    if (this.key >= 0 && this.key < 128 && kv[this.key] > 0) kv[this.key]--;
    this.key = -1;
  }

  /** 0x3be00: optional sample rate, reset everything and free the voice. */
  kill(sr = 0): void {
    if (sr !== 0) {
      this.sr = f32(sr);
      this.blk = Math.trunc(this.sr * 0.0029);
      this.morph.setSr(this.sr);
    }
    this.free();
    this.adsr.done = true;
    this.osc.reset();
    this.morph.reset();
    this.mod.reset();
    this.pos = 0;
    this.upd = -1;
    this.nPos = 0; this.nInc = 0; this.nGL = 0; this.nGR = 0; this.nDL = 0; this.nDR = 0;
    this.nDir = 1;
    this.fs.fill(0);
  }

  /** Voice note on 0x3bcd8 (the synth has set key, velocity, glide). */
  noteOn(): void {
    const s = this.s, f = s.f, mod = this.mod;
    mod.noteOn(this.key, this.vel);
    const a = mod.clamped(4, f[30]);
    let A = f32(f32(Math.sqrt(a)) * f32(15 * f32(a * f32(a * a))));
    const d = mod.clamped(5, f[31]);
    let D = f32(f32(d * d) * f32(d * 30));
    const sv = mod.clamped(7, f[32]);
    const S = f32(sv * sv);
    const MIN = f32(0.003);
    if (!(A >= MIN)) A = MIN;
    if (!(D >= MIN)) D = MIN;
    this.adsr.init(A, D, S, this.sr);
    this.morph.noteOn(this.key + s.transpInt, this.vel);
    this.nPos = 0;
    this.doneCnt = 0;
    this.first = true;
  }

  /** Voice release 0x3c314. */
  release(): void {
    this.mod.release();
    this.morph.release();
    const r = this.mod.clamped(6, this.s.f[33]);
    let R = f32(f32(r * r) * f32(r * 10));
    const MIN = f32(0.003);
    if (!(R >= MIN)) R = MIN;
    this.adsr.setRelease(R);
    this.adsr.release();
  }

  /** Semitones of the voice pitch (0x655f8). */
  private semis(): number {
    const s = this.s;
    let x = f32(0 + this.glidePos);
    x = f32(s.levPitch[this.key & 127] + x);
    x = f32(x + f32(s.transpFine + 0));
    x = fma(s.bendRange, s.wheel, x);
    return f32(x + 0);
  }

  /** Frequency in Hz (0x65510): 220 * 2^(semi/12 - 4.75), float. */
  private hz(): number {
    return f32(exp2(fmaD(this.semis(), C12, -4.75)) * 220);
  }

  private glideStep(n: number): void {
    const target = f32(this.key);
    let p = this.glidePos;
    if (p < target) {
      p = fma(this.glideRate, f32(n), p);
      if (p > target) p = target;
    } else if (p > target) {
      p = fma(-this.glideRate, f32(n), p);
      if (p < target) p = target;
    }
    this.glidePos = p;
  }

  /** Spectrum update 0x3beb4. */
  private update(n: number): void {
    const s = this.s;
    this.glideStep(n);
    this.morph.setTempo(f32(s.tempo));
    this.morph.compute(n);
    this.osc.gL = s.levL[this.key & 127];
    this.osc.gR = s.levR[this.key & 127];
    const hz = this.pitchF * this.hz();
    this.osc.setPartials(this.morph.amp, this.morph.pan, this.morph.ratio, n, hz, this.panMod, this.sr);
  }

  private modBlock(n: number): void {
    this.mod.process(n, this.sr, f32(this.s.tempo));
    this.panMod = this.mod.target(2);
    const m = this.mod.target(3);
    this.pitchF = exp2f(f32(Math.abs(m) * m));
  }

  /** Noise control block 0x3c038. */
  private noiseBlock(n: number): void {
    const s = this.s, nz = s.prog.noise;
    if (!nz) return;
    const f = s.f, mod = this.mod;
    const m = mod.clamped(8, f[34]);
    let g = f32(m * m);
    g = f32(g * g);
    g = f32(g + g);
    if (f[36] !== 0) g = 0;
    const vs = f[38];
    const g2 = f32(fmaD(fmaD(this.vel, vs, -vs), g, g));
    const p0 = mod.clamped(9, f[35]);
    let p = f32(2 * p0 + (-1 + this.panMod));
    p = f32(fmaD(p, 0.5, 0.5));
    if (!(p > 0)) p = 0;
    if (p > 1) p = 1;
    const key = this.key & 127;
    const amp = this.amp;
    let d0 = amp * f32(s.levL[key] * 0.5);
    d0 = (g2 + g2) * d0;
    const tl = f32(fmaD(-p, d0, d0));
    const tr = f32(f32(g2 * f32(f32(amp + amp) * f32(s.levR[key] * 0.5))) * p);
    const fn = f32(n);
    this.nDL = f32(f32(tl - this.nGL) / fn);
    this.nDR = f32(f32(tr - this.nGR) / fn);
    const rr = f32(nz.rate / this.sr);
    this.nInc = exp2(mod.clamped(10, f[39]) * 4 - 2) * rr;
    this.nMode = s.prog.nzLoop;
    let ls = nz.ls, le = nz.le;
    const frames = nz.frames;
    if (ls < 0) ls = 0;
    if (ls >= frames) ls = frames - 1;
    if (le < 0) le = 0;
    if (le >= frames) le = frames - 1;
    if (le === ls) { ls = 0; le = frames - 1; }
    this.nLs = ls;
    this.nLe = le;
    this.nLen = le - ls;
    this.nMono = f[37] !== 0;
    this.filterSetup(mod.clamped(11, f[40]), mod.clamped(12, f[41]), f[42], s.prog.nzFlt, this.semis());
  }

  /** Noise filter setup 0x37fd8 (DF1 biquads, coefficients flushed at 1e-9). */
  private filterSetup(cut: number, res: number, kt: number, mode: number, pitch: number): void {
    this.fMode = mode;
    const ktd = fmaD(pitch * -0.017543859649122806, kt, kt);
    let w = (exp2((cut - ktd) * 9) * 219.9114857512855) / this.sr;
    let Q = fmaD(f32(res * res), 30, 1);
    if (!(w > 0)) w = 0;
    if (w > 3.1) w = 3.1;
    if (!(Q > 1)) Q = 1;
    if (Q > 31) Q = 31;
    let c0: number, c1: number, c2: number;
    if (mode === 1 || mode === 3) {
      const sn = sin(w), cs = cos(w);
      const d3 = sn + Q;
      const num = mode === 1 ? 1 - cs : cs + 1;
      c0 = f32(num / (sn / Q + 2));
      c1 = f32((Q * -2 * cs) / d3);
      c2 = f32((Q - sn) / d3);
    } else if (mode === 2) {
      const sn = sin(w), cs = cos(w);
      const al = sn / (Q + Q);
      const om = f32(1 - al), op = al + 1;
      c0 = f32(f32(sn * 0.5) / op);
      c1 = f32(f32(cs * 2) / op);
      c2 = f32(om / op);
    } else return;
    this.fc0 = c0 > -FL1E9 && c0 < FL1E9 ? 0 : c0;
    this.fc1 = c1 > -FL1E9 && c1 < FL1E9 ? 0 : c1;
    this.fc2 = c2 > -FL1E9 && c2 < FL1E9 ? 0 : c2;
  }

  /** Noise filter 0x381e0 on one channel (state at o: x2, x1, y2, y1). */
  private filt(x: number, o: number): number {
    const st = this.fs, m = this.fMode;
    let y: number;
    const x2 = st[o], x1 = st[o + 1], y2 = st[o + 2], y1 = st[o + 3];
    if (m === 1 || m === 3) {
      const sum = m === 1 ? f32(f32(x1 + x1) + f32(x + x2)) : f32(f32(x - f32(x1 + x1)) + x2);
      const q = fma(y1, this.fc1, f32(y2 * this.fc2));
      y = fma(sum, this.fc0, -q);
    } else if (m === 2) {
      let v = f32(f32(x - x2) * this.fc0);
      v = fma(y1, this.fc1, v);
      y = fma(-y2, this.fc2, v);
    } else return x;
    st[o] = x1 > -FL1E9 && x1 < FL1E9 ? 0 : x1;
    st[o + 1] = x > -FL1E9 && x < FL1E9 ? 0 : x;
    st[o + 2] = y1 > -FL1E9 && y1 < FL1E9 ? 0 : y1;
    st[o + 3] = y > -FL1E9 && y < FL1E9 ? 0 : y;
    return y;
  }

  /** Wave_Hermite4 0x37b08: between x[idx+1] and x[idx+2]. */
  private static herm(c: Float32Array, i: number, t: number): number {
    const x0 = c[i], x1 = c[i + 1], x2 = c[i + 2], x3 = c[i + 3];
    const c1 = f32(f32(x2 - x0) * 0.5);
    const c3 = fma(f32(x3 - x0), 0.5, f32(f32(x1 - x2) * 1.5));
    const c2 = f32(f32(x0 + c1) - f32(x1 + c3));
    return fma(fma(fma(c3, t, c2), t, c1), t, x1);
  }

  /** Noise render 0x3c77c. */
  private noise(L: Float32Array, R: Float32Array, off: number, n: number): void {
    const nz: CNoise | null = this.s.prog.noise;
    if (!nz || n === 0) return;
    for (let i = 0; i < n; i++) {
      let l = 0, r = 0;
      const pos = this.nPos;
      const idx = pos >= 2147483647 ? 2147483647 : pos <= -2147483648 ? -2147483648 : Math.trunc(pos);
      if (idx >= 0 && idx < nz.frames) {
        const fr = f32(pos - Math.trunc(pos));
        l = Voice.herm(nz.ch[0], idx, fr);
        r = nz.channels === 2 ? Voice.herm(nz.ch[1], idx, fr) : l;
        if (this.nMono) { l = r = f32(f32(l + r) * 0.5); }
      }
      // position by loop mode
      const le = this.nLe, ls = this.nLs, inc = this.nInc;
      switch (this.nMode) {
        case 0: this.nPos = pos + inc; break;
        case 1: { let p = pos + inc; if (p >= le) p = p - this.nLen; this.nPos = p; break; }
        case 2: {
          let p: number;
          if (pos >= le) { this.nDir = -1; p = pos - inc; if (!(p > ls)) p = p + this.nLen; }
          else { p = fmaD(inc, this.nDir, pos); if (this.nDir < 0 && !(p > ls)) p = p + this.nLen; }
          this.nPos = p;
          break;
        }
        case 3: {
          let d: number;
          if (pos >= le) { this.nDir = -1; d = -1; if (!(pos > ls)) { this.nDir = 1; d = 1; } }
          else { d = this.nDir; if (d < 0 && !(pos > ls)) { this.nDir = 1; d = 1; } }
          this.nPos = fmaD(inc, d, pos);
          break;
        }
        default: break;
      }
      if (this.fMode >= 1 && this.fMode <= 3) { l = this.filt(l, 0); r = this.filt(r, 4); }
      L[off + i] = fma(this.nGL, l, L[off + i]);
      R[off + i] = fma(this.nGR, r, R[off + i]);
      this.nGL = f32(this.nGL + this.nDL);
      this.nGR = f32(this.nGR + this.nDR);
    }
  }

  /** Voice_Render 0x3c38c: add n samples at off. Returns false once the voice is free. */
  render(L: Float32Array, R: Float32Array, off: number, n: number): boolean {
    if (this.key < 0) return false;
    if (this.upd < 0) {
      this.modBlock(1);
      this.update(1);
      this.osc.render(this.dummy, this.dummy, 0, 1);
      this.upd = 0;
    }
    while (n > 0) {
      if (this.pos === 0) {
        const blk = this.blk;
        this.modBlock(blk);
        if (this.adsr.done) this.doneCnt++;
        if (this.doneCnt >= 2) { this.kill(); return false; }
        let v = this.adsr.next(blk);
        v = f32(v * exp10f(this.mod.target(1)));
        this.amp = v;
        this.osc.setGain(v, blk);
        this.noiseBlock(blk);
        const c = this.upd;
        let doUpd: boolean;
        if (c === 3) { this.upd = 1; doUpd = true; } else { this.upd = c + 1; doUpd = c === 0; }
        if (doUpd) this.update(this.first ? blk : 3 * blk);
        if (this.first) this.upd = 0;
        this.first = false;
      }
      const left = this.blk - this.pos;
      const m = left < n ? left : n;
      const np = this.pos + m;
      this.pos = np < this.blk ? np : 0;
      this.osc.render(L, R, off, m);
      this.noise(L, R, off, m);
      off += m;
      n -= m;
    }
    return true;
  }
}
