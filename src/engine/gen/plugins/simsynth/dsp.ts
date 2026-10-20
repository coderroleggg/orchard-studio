// SimSynth: the engine's unit generators, ported from SimSynth_eng_x64.dylib (arm64):
// p_env (linear ADSR, 0x3918..0x3c3c, tick inlined at 0x420c), p_lfo (0x2f54..0x31d4),
// the oscillators p_loop (0x27a8..), p_loopquality (0x2970.., the 2x oversampled
// table oscillator FL uses) and p_noise (0x31d8..), and p_filt (0x32ac..0x3530,
// the double precision two-stage state variable filter). Float32 everywhere except
// p_filt's double states, with FL's fused multiply-adds (fmath.ts).

import { CLAMP, G, INC, nextNoise } from './tables';
import { cvtzs, cvtzu, f32, fma, fmaf } from './fmath';

const LONG = 0x4fffffff;
const INV255 = f32(0.003921568859368563); // 0x3b808081
const INV65280 = f32(1.5318628356908448e-5); // 0x37808081
const LFO_K = f32(0.0010010009864345193); // 0x3a833405
const MIN_CUT = f32(9.999999747378752e-5); // 0x38d1b717
const NOISE_K0 = f32(0.30250000953674316); // 0x3e9ae148
const N09 = f32(0.8999999761581421), N01 = f32(0.10000000149011612); // 0x3f666666, 0x3dcccccd

/** p_env: five linear stages (attack, decay, sustain, release, done) with per-stage lengths in samples. */
export class PEnv {
  stage = 0;
  left = 0;
  inc = 0;
  readonly lens = new Int32Array(5);
  readonly incs = new Float32Array(5);
  readonly targets = new Float32Array(5);
  readonly levels = new Float32Array(5);
  /** Stage times in ms (FL keeps them as unsigned ints). */
  readonly times = new Int32Array(5);
  value = 0;

  /** p_env::init (0x3954): times in ms, levels in 1/65280. */
  init(times: ArrayLike<number>, lv: ArrayLike<number>): void {
    for (let i = 0; i < 5; i++) this.levels[i] = f32(f32(lv[i] & 0xffff) * INV65280);
    for (let i = 0; i < 5; i++) this.times[i] = times[i] | 0;
    const spm = G.spm;
    const n0 = cvtzs(f32(spm * f32(times[0] >>> 0)));
    this.targets[0] = 1;
    this.lens[0] = n0;
    this.incs[0] = n0 ? f32(1 / f32(n0)) : 0;
    const s2 = this.levels[2];
    const n1 = cvtzs(f32(spm * f32(times[1] >>> 0)));
    this.targets[1] = s2;
    this.lens[1] = n1;
    this.incs[1] = n1 ? f32(f32(s2 - 1) / f32(n1)) : 0;
    this.lens[2] = LONG;
    this.incs[2] = 0;
    this.targets[2] = s2;
    const n3 = cvtzs(f32(spm * f32(times[3] >>> 0)));
    this.targets[3] = 0;
    this.lens[3] = n3;
    this.incs[3] = n3 ? f32(-s2 / f32(n3)) : 0;
    this.lens[4] = LONG;
    this.targets[4] = 0;
    this.incs[4] = 0;
    this.stage = 0;
    this.left = n0;
    this.inc = this.incs[0];
    this.value = 0;
  }

  /** The inlined tick (0x420c). */
  tick(): void {
    for (;;) {
      if (this.left !== 0) {
        this.left = (this.left - 1) | 0;
        this.value = f32(this.value + this.inc);
        return;
      }
      const s0 = this.targets[this.stage];
      this.value = s0;
      const st = this.stage + 1;
      this.stage = st;
      this.left = st < 5 ? this.lens[st] : 0;
      this.inc = st < 5 ? this.incs[st] : 0;
      if (st !== 2 || s0 !== 0) continue;
      // decayed to a zero sustain: done
      this.stage = 4;
      this.left = -1;
      this.inc = 0;
      return;
    }
  }

  /** patch::Release for one envelope (0x5ad0): a linear ramp from the current value over the release length. */
  release(): void {
    if ((this.stage >>> 0) > 2) return;
    const n = this.lens[3] !== 0 ? this.lens[3] : 1;
    this.inc = f32(-this.value / f32(n >>> 0));
    this.stage = 3;
    this.left = n;
  }

  /** p_env::modrealtime_sus (0x3b94): a live sustain change (level 0..255). */
  modSustain(level: number): void {
    const s0 = f32(f32(level) * INV255);
    this.levels[1] = s0;
    this.levels[2] = s0;
    const spm = G.spm;
    let n = cvtzs(f32(spm * f32(this.times[1])));
    this.targets[1] = s0;
    if (n) { this.lens[1] = n; this.incs[1] = f32(f32(s0 - this.levels[0]) / f32(n)); } else { this.lens[1] = 0; this.incs[1] = 0; }
    const s2 = this.levels[3];
    n = cvtzs(f32(spm * f32(this.times[3])));
    this.targets[3] = s2;
    if (n) { this.lens[3] = n; this.incs[3] = f32(f32(s2 - s0) / f32(n)); } else { this.lens[3] = 0; this.incs[3] = 0; }
    if (this.stage === 2) this.value = s0;
  }

  /** patch::ChangeAttackRate (0x5794): stage 0 from the stage-0 level. */
  setAttack(ms: number): void {
    this.times[0] = ms | 0;
    const s0 = this.levels[0];
    const n = cvtzs(f32(G.spm * f32(ms | 0)));
    this.targets[0] = s0;
    if (n) { this.lens[0] = n; this.incs[0] = f32(s0 / f32(n)); } else { this.lens[0] = 0; this.incs[0] = 0; }
  }

  /** patch::ChangeDecayRate (0x57dc). */
  setDecay(ms: number): void {
    this.times[1] = ms | 0;
    const s0 = this.levels[0], s1 = this.levels[1];
    const n = cvtzs(f32(G.spm * f32(ms | 0)));
    this.targets[1] = s1;
    if (n) { this.lens[1] = n; this.incs[1] = f32(f32(s1 - s0) / f32(n)); } else { this.lens[1] = 0; this.incs[1] = 0; }
  }

  /** patch::ChangeReleaseRate (0x5830; minimum 2 ms) / ChangeReleaseRate2 (0x5928; minimum 1 ms). */
  setRelease(ms: number, min: number): void {
    const t = ms > min ? ms | 0 : min;
    this.times[3] = t;
    const s0 = this.levels[2], s1 = this.levels[3];
    const n = cvtzs(f32(G.spm * f32(t)));
    this.targets[3] = s1;
    if (n) { this.lens[3] = n; this.incs[3] = f32(f32(s1 - s0) / f32(n)); } else { this.lens[3] = 0; this.incs[3] = 0; }
  }
}

/** p_lfo: a ramp per half period, shaped into two outputs (filter A, pitch B), with a delayed fade-in. */
export class PLfo {
  /** 0x8: shape 0 square, 1 saw, 2 triangle, 3 random. */
  shape = 0;
  /** 0xc: samples left in this half period. */
  cnt = 0;
  /** 0x10: half period (samples, >= 64). */
  len = 0;
  /** 0x14: 1 / len. */
  step = 0;
  /** 0x18: which half. */
  half = 0;
  /** 0x1c: the ramp 1 -> 0. */
  ramp = 0;
  /** 0x20: random value (new each half period). */
  rnd = 0;
  /** 0x24 / 0x28 / 0x2c: delay fade gain, its increment, samples left. */
  fade = 0;
  fadeInc = 0;
  fadeLeft = 0;
  /** 0x30: delay setting 0..100 (x 3528 samples). */
  delay = 0;
  /** 0x34: retrigger switch. */
  retrig = 0;
  /** 0x38 / 0x3c: outputs (A: filter, B: pitch). */
  outA = 0;
  outB = 0;

  /** p_lfo::setfrq (0x3168): rate 0..999 -> half period 4 s (1 - rate/999)^3, at least 64 samples. */
  setfrq(rate: number): void {
    const s0 = f32(rate & 0xffff);
    const r = f32(s0 * LFO_K);
    let x = fmaf(-s0, LFO_K, 1);
    x = fmaf(-r, x, x);
    x = f32(x * 4);
    x = fmaf(-r, x, x);
    let n = cvtzu(f32(x * G.grate));
    if (!(n > 64)) n = 64;
    const fn = f32(n);
    this.step = f32(1 / fn);
    this.cnt = cvtzu(f32(this.ramp * fn));
    this.len = n;
  }

  /** p_lfo::sync (0x2fa0): restart (t = 0, also the delay) or jump to sample t of the cycle. */
  sync(t: number): void {
    t >>>= 0;
    if (t === 0) {
      this.fadeLeft = 0;
      if (this.delay !== 0) {
        const n = Math.imul(this.delay, 3528) | 0;
        this.fadeLeft = n;
        this.fade = 0;
        this.fadeInc = f32(1 / f32(n));
      }
    }
    const n = this.len >>> 0;
    const q = n ? Math.floor(t / n) : 0;
    this.half = q & 1;
    const rem = (t - q * n) >>> 0;
    const s1 = f32(rem);
    const s2 = f32(this.step * s1);
    this.ramp = fmaf(-this.step, s1, 1);
    const fn = f32(n);
    this.cnt = cvtzu(fmaf(-s2, fn, fn));
    if (rem === 0) this.rnd = nextNoise();
  }

  /** p_lfo::tick (0x3044). */
  tick(): void {
    let s0: number;
    let half: number;
    this.ramp = f32(this.ramp - this.step);
    this.cnt = (this.cnt - 1) >>> 0;
    if (this.cnt !== 0) {
      half = this.half;
      s0 = this.ramp;
    } else {
      this.cnt = this.len;
      half = 1 & ~this.half;
      this.half = half;
      this.ramp = 1;
      this.rnd = nextNoise();
      s0 = 1;
    }
    const idx = this.shape | (half << 2);
    if ((idx >>> 0) <= 7) {
      switch (idx) {
        case 0: this.outA = 0; this.outB = 0; break;
        case 1: case 5: this.outA = s0; this.outB = s0; break;
        case 2: { const t1 = f32(1 - s0); const x = s0 > 0.5 ? t1 : s0; this.outA = t1; this.outB = f32(x * -2); break; }
        case 3: case 7: this.outA = this.rnd; this.outB = this.rnd; break;
        case 4: this.outA = 1; this.outB = 1; break;
        case 6: { const t1 = f32(1 - s0); const x = s0 > 0.5 ? t1 : s0; this.outB = f32(x + x); this.outA = s0; break; }
      }
    }
    if (this.fadeLeft !== 0) {
      this.outA = f32(this.outA * this.fade);
      this.outB = f32(this.outB * this.fade);
      this.fade = f32(this.fadeInc + this.fade);
      this.fadeLeft = (this.fadeLeft - 1) | 0;
    }
  }
}

/** Oscillator classes as FL's patch numbers them (patch::GetOscType). */
export const OSC_LOOP = 1, OSC_QUALITY = 2, OSC_NOISE = 4;

/** p_obj fields shared by every oscillator. */
export abstract class Osc {
  abstract readonly cls: number;
  /** 0x8: last output x level (display), 0xc: fixed pitch flag (always 0 here). */
  out = 0;
  fixed = 0;
  /** 0x10: current table index, 0x12: base pitch (both 16 bit). */
  idx = 0;
  base = 0;
  /** 0x14: level (osc level knob squared). */
  level = 0;
  abstract tick(): number;
  abstract setfrq(d: number): void;
  sync(): void {}
  setknob(_v: number): void {}
}

/** p_loop (non-quality table oscillator, used only while FL's quality switch is off at creation). */
export class OscLoop extends Osc {
  readonly cls = OSC_LOOP;
  table: Float32Array;
  inc = 0;
  phase = 0;
  inc2 = 0;
  phase2 = 0;
  warm = 0;
  detune = 0;
  constructor(table: Float32Array) { super(); this.table = table; }
  tick(): number {
    const t = this.table;
    let s = t[this.phase >>> 20];
    this.phase = (this.phase + this.inc) >>> 0;
    if (this.warm !== 0) {
      s = f32(t[this.phase2 >>> 20] + s);
      this.phase2 = (this.phase2 + this.inc2) >>> 0;
    }
    return s;
  }
  setfrq(d: number): void {
    const w = (this.base + d) & 0xffff;
    if (this.idx === w) return;
    const k = this.detune + w + 32;
    const t = CLAMP[Math.min(65567, Math.max(0, k))];
    this.idx = t;
    this.inc = INC[t];
    this.inc2 = INC[t + 20];
  }
  sync(): void { this.phase2 = this.phase; }
}

/** 0x3eaaaa9f, the quality oscillator's averaging weight. */
const THIRD = f32(0.33333298563957214);

/** p_loopquality: the table read twice per sample (2x rate tables), averaged with the last output. */
export class OscQuality extends Osc {
  readonly cls = OSC_QUALITY;
  table: Float32Array;
  inc = 0;
  phase = 0;
  inc2 = 0;
  phase2 = 0;
  warm = 0;
  s1 = 0;
  s2 = 0;
  detune = 0;
  constructor(table: Float32Array) { super(); this.table = table; }
  tick(): number {
    const t = this.table;
    const inc = this.inc;
    let s0 = f32(this.s1 + t[this.phase >>> 20]);
    let p = (this.phase + inc) >>> 0;
    const p2 = (p + inc) >>> 0;
    s0 = f32(t[p >>> 20] + s0);
    s0 = f32(s0 * THIRD);
    this.s1 = s0;
    this.phase = p2;
    if (this.warm !== 0) {
      const inc2 = this.inc2;
      let s2 = f32(this.s2 + t[this.phase2 >>> 20]);
      p = (this.phase2 + inc2) >>> 0;
      const q2 = (p + inc2) >>> 0;
      s2 = f32(t[p >>> 20] + s2);
      this.s2 = f32(s2 * THIRD);
      this.phase2 = q2;
      return fmaf(s2, THIRD, s0);
    }
    return s0;
  }
  setfrq(d: number): void {
    const w = (this.base + d) & 0xffff;
    if (this.idx === w) return;
    const k = this.detune + w + 32;
    const t = CLAMP[Math.min(65567, Math.max(0, k))];
    this.idx = t;
    this.inc = (INC[t] + this.detune) >>> 0;
    this.inc2 = (INC[t + 20] + this.detune) >>> 0;
  }
  sync(): void { this.phase2 = this.phase; }
}

/** p_noise: the noise table through a two-state filter (band output x 16); "coarse" sets its colour. */
export class OscNoise extends Osc {
  readonly cls = OSC_NOISE;
  low = 0;
  band = 0;
  high = 0;
  f = NOISE_K0;
  tick(): number {
    const n = nextNoise();
    const k = this.f;
    const low = fmaf(this.band, k, this.low);
    const s4 = f32(this.band + low);
    const high = f32(n - s4);
    this.high = high;
    const band = fmaf(high, k, this.band);
    this.low = low;
    this.band = band;
    return f32(band * 16);
  }
  setfrq(_d: number): void {}
  setknob(v: number): void {
    const x = fmaf(f32(v), N09, N01);
    this.f = f32(x * x);
  }
}

/**
 * p_filt: two cascaded Chamberlin state variable filters (double precision);
 * each stage's input / output is the low / band / high mix (cos a cos b, sin b,
 * sin a cos b). Stage 1 runs at f^2, stage 2 at f (f = cutoff 1e-4..1 x 44100 / rate).
 */
export class PFilt {
  /** 0x8 / 0xc: current cutoff and the knob's base (cut / 255). */
  f = 0;
  cut = 0;
  /** 0x10: emphasis 0..255. */
  emph = 0;
  mixLow = 0;
  mixBand = 0;
  mixHigh = 0;
  angA = 0;
  angB = 0;
  low2 = 0;
  band2 = 0;
  high2 = 0;
  /** 0x58 / 0x60: stage 2 (f) and stage 1 (f^2) coefficients; 0x68: damping. */
  c2 = 0.5;
  c1 = 0.5;
  q = 0;
  x70 = 0;
  low1 = 0;
  band1 = 0;
  high1 = 0;
  a0 = 0;

  /** p_filt::setfrq (0x3460). */
  setfrq(m: number): void {
    let s0 = f32(this.cut + m);
    this.f = s0;
    if (s0 > 1 || !(s0 >= 1e-4)) {
      const lim = s0 > 1 ? 1 : MIN_CUT;
      this.f = lim;
      s0 = lim;
    }
    const rd = G.rateDiv;
    let s2 = f32(rd * s0);
    if (!(s2 <= 1)) s2 = s2 > 1 ? 1 : s2;
    let d0 = f32(s0 * s0) * rd;
    if (!(d0 <= 1)) d0 = d0 > 1 ? 1 : d0;
    this.c2 = s2;
    this.c1 = d0;
  }

  /** The damping from an emphasis value (patch::SetFilterQ / OffsetFilterQ / Gate). */
  setQ(e: number): void {
    const d0 = fma(e, -0.00392156862745098, 1);
    this.a0 = fma(-d0, d0, 1);
    this.q = fma(d0, d0, 0.10000000000000009);
  }

  /** p_filt::tick (0x34cc). FL fuses every multiply-add; plain double arithmetic gives the same float output (checked against FL's renders). */
  tick(x: number): number {
    const c1 = this.c1, c2 = this.c2, q = this.q;
    let b1 = this.band1;
    const l1 = b1 * c1 + this.low1;
    const h1 = x - (q * b1 + l1);
    b1 = h1 * c1 + b1;
    this.low1 = l1; this.band1 = b1; this.high1 = h1;
    const b2o = this.band2;
    const l2 = b2o * c2 + this.low2;
    const u = q * b2o + l2;
    const ml = this.mixLow, mb = this.mixBand, mh = this.mixHigh;
    const h2 = mh * h1 + (mb * b1 + (ml * l1 - u));
    const b2 = h2 * c2 + b2o;
    this.low2 = l2; this.band2 = b2; this.high2 = h2;
    return f32(b2 * mb + (h2 * mh + ml * l2));
  }
}
