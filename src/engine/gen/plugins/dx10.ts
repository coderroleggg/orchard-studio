// DX10 (FL: Fruity DX10): FL's port of Paul Kellett's mda DX10 FM synthesizer
// (a carrier with a 5th-order sine-like waveshaper, frequency-modulated by two sine
// modulators with their own envelopes), ported line by line from FL 2026's binary
// (Fruity DX10_x64.dylib, arm64, TTestPlug: update 0x5e260, TriggerVoice 0x5e830,
// Voice_Release 0x5ece0, Voice_Render 0x5eed0, pitch update 0x5f2b0) in FL's
// single precision. See docs/research/gen/dx10.md.
//
// FL's plugin also contains FL's channel sampler processing (the INS envelopes,
// LFOs and filter: the channel's INS settings here, off by default). With them off
// it only applies the voice levels: FL's float32 circular pan law on FinalLevels
// (pan, volume) and a per-block ramp from the previous gains, at most 0.001 per
// sample, mixed by FL's NEON kernel (including its quirk of swapping the left /
// right steps for the frames after the last group of 8). The voice does that here
// (def.levels 'plugin') per control step, where the channel updates the levels.
// FL checks a voice after each processing block (end below silence, modulator
// envelopes cleared) and kills finished voices there: here once per channel render
// call, which is FL's block (bit-exact with FL's block structure).

import type { FxMonitor } from '../../effects/types';
import type { GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import { PITCH_C5 } from '../levels';

const f32 = Math.fround;
/** As many voices as a channel holds, so a voice the channel still renders is never reused. */
const MAX_VOICES = 128;
/** Carrier envelope level below which a voice has finished (FL: 0.0002f; mda: 0.0003). */
const SILENCE = f32(0.0002);
/** Modulator envelopes below this are cleared (2^-24). */
const MOD_SILENCE = f32(5.960464477539063e-8);
/** FL's level ramp: at most this gain change per sample (fixed, at any sample rate). */
const MAX_STEP = f32(0.001);
/** 10 x InitLevels.Vol of velocity 128 (FL's clamp before the velocity curve). */
const VEL_MAX = f32(20.55118179321289);
const LN_VEL_MAX = Math.log(f32(VEL_MAX + 1));
const F_001 = f32(0.01);

/** FL's host sine table (TFruityPlugHost.WaveTables[0]): 16384 points of sin(2 pi i / 16384), float32. */
const SINE = new Float32Array(16384);
for (let i = 0; i < 16384; i++) SINE[i] = Math.sin(i * 2 * Math.PI * 6.103515625e-05);

/** Round half to even (ARM frintx). */
function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** FPC float -> int64 conversion keeping the low 32 bits (as FL stores the phase increments). */
function low32(x: number): number {
  if (!Number.isFinite(x)) return 0;
  // exact for |x| < 2^53; the high bits drop like FL's ubfx #0, #32
  const m = x % 4294967296;
  return m | 0;
}

function coarseRatio(c: number): number {
  return Math.floor(40.1 * c * c);
}

function fineRatio(f: number): number {
  if (f < 0.5) return f32(0.2 * f * f);
  const i = roundEven(8.9 * f);
  return i === 4 ? 0.25 : i === 5 ? f32(0.33333333) : i === 6 ? 0.5 : i === 7 ? f32(0.66666667) : 0.75;
}

/** One gain ramp (FL 0x170370): returns the step; `t` holds the target (moved when the slope is clamped). */
function rampStep(t: { v: number }, last: number, len: number): number {
  let step = f32(t.v - last);
  if (step === 0 && 1 / step > 0) return 0;
  step = f32(step / len);
  if (Math.abs(step) > MAX_STEP) {
    step = step < 0 || Object.is(step, -0) ? -MAX_STEP : MAX_STEP;
    t.v = f32(last + f32(step * len));
    if (Math.abs(t.v) < MOD_SILENCE) { t.v = 0; step = f32(-last / len); }
  }
  return step;
}

class DX10Voice implements GenVoice {
  free = true;
  /** Note off received (the editor's keyboard shows unreleased keys). */
  released = false;
  /** The note's key (editor display). */
  key = 60;
  private params: GenVoiceParams | null = null;
  /** FinalLevels.Pitch the frequencies were computed for. */
  private pitch = 0;
  /** 1.2 / initial envelope (output normalisation). */
  private norm = 0;
  env = 0;
  private cenv = 0;
  private catt = 0;
  private cdec = 0;
  private car = 0;
  private dcar = 0;
  private mw = 0;
  private lfoCount = 0;
  /** FL's voice flag +0x14: finished (envelope below silence) or stolen. */
  finished = false;
  /** Stolen and not rendered since: FL still renders one block of it. */
  private stealFresh = false;
  /** Frame of the previous render call (a smaller one starts a new channel block = FL's block). */
  private lastFrame = -1;
  // modulators: phase (uint32 as int), increment, amplitude, envelope, target level, envelope coefficient
  private ph1 = 0; private inc1 = 0; private amp1 = 1; private menv1 = 0; private mlev1 = 0; private mdec1 = 0;
  private ph2 = 0; private inc2 = 0; private amp2 = 1; private menv2 = 0; private mlev2 = 0; private mdec2 = 0;
  // FL's sampler level ramp: last gains (NaN = not started)
  private lastL = NaN;
  private lastR = NaN;
  private readonly t = { v: 0 };
  private readonly raw = new Float32Array(16);

  constructor(private readonly s: DX10) {}

  /** FL's TriggerVoice. */
  start(p: GenVoiceParams): void {
    const s = this.s;
    this.params = p;
    this.free = false;
    this.released = false;
    this.key = p.key;
    const P = f32(p.levels.pitch - PITCH_C5);
    this.pitch = P;
    // note number with the fractional semitone (cents rounded to integers)
    const r = roundEven(P);
    const frac = f32((r % 100) * F_001);
    let note = Math.trunc(f32(f32(f32(P * F_001) - frac) + 60));
    note = note < 0 ? 0 : note > 127 ? 127 : note;
    const nf = f32(note + frac);
    // MIDI velocity from InitLevels.Vol: round(127 ln(10 vol + 1) / ln(11^1.28))
    let x = f32(f32(p.init.vol) * 10);
    if (x > VEL_MAX) x = VEL_MAX;
    x = f32(x + 1);
    let vel = roundEven(f32(f32(Math.log(x) / LN_VEL_MAX) * 127));
    vel = vel > 0 ? (vel > 1270 ? 1270 : vel) : 0;
    let l = f32(Math.exp(0.05776226505 * nf));
    this.car = 0;
    this.dcar = f32(f32(s.tune * s.pbend) * l);
    if (l > 50) l = 50;
    const dv = f32(vel - 64);
    const l1 = f32(l * f32(64 + f32(s.velsens1 * dv)));
    this.menv1 = f32(s.depth1 * l1);
    this.mlev1 = f32(s.dept21 * l1);
    this.mdec1 = s.mdec1;
    this.ph1 = 0;
    this.amp1 = 1;
    this.inc1 = low32(roundEven(f32(s.ratio1 * this.dcar)));
    const l2 = f32(l * f32(64 + f32(s.velsens2 * dv)));
    this.menv2 = f32(s.depth2 * l2);
    this.mlev2 = f32(s.dept22 * l2);
    this.mdec2 = s.mdec2;
    this.ph2 = 0;
    this.amp2 = 1;
    this.inc2 = low32(roundEven(f32(s.ratio2 * this.dcar)));
    this.env = f32(f32(1.5 - s.wave) * 0.0035 * f32(vel + 10));
    this.norm = f32(1.2 / this.env);
    this.catt = s.catt;
    this.cenv = 0;
    this.cdec = s.cdec;
    this.lfoCount = 0;
    this.mw = 0;
    this.finished = false;
    this.stealFresh = false;
    this.lastFrame = -1;
    this.lastL = NaN;
    this.lastR = NaN;
  }

  /** FL 0x5f2b0: new frequencies after a FinalLevels.Pitch change (envelopes and key scaling stay). */
  private repitch(P: number): void {
    const s = this.s;
    const r = roundEven(P);
    const frac = f32((r % 100) / 100);
    let note = Math.trunc(r / 100) + 60;
    note = note > 0 ? (note > 127 ? 127 : note) : 0;
    const l = f32(Math.exp(0.05776226505 * f32(note + frac)));
    this.dcar = f32(f32(s.tune * s.pbend) * l);
    this.inc1 = low32(roundEven(f32(s.ratio1 * this.dcar)));
    this.inc2 = low32(roundEven(f32(s.ratio2 * this.dcar)));
  }

  /** FL's Voice_Render loop for n samples into this.raw (the end-of-block checks are in blockEnd). */
  private voice(n: number): void {
    const s = this.s;
    const p = this.params!;
    const P = f32(p.levels.pitch - PITCH_C5);
    if (P !== this.pitch && Number.isFinite(P)) { this.pitch = P; this.repitch(P); }
    const rich = s.rich, modmix = s.modmix, raw = this.raw;
    let car = this.car;
    let dc = f32(this.dcar + this.mw);
    let env = this.env, cenv = this.cenv;
    const catt = this.catt, cdec = this.cdec, norm = this.norm;
    let menv1 = this.menv1, menv2 = this.menv2;
    const mlev1 = this.mlev1, mlev2 = this.mlev2, mdec1 = this.mdec1, mdec2 = this.mdec2;
    let ph1 = this.ph1, ph2 = this.ph2;
    const inc1 = this.inc1, inc2 = this.inc2, amp1 = this.amp1, amp2 = this.amp2;
    for (let i = 0; i < n; i++) {
      // FL steps the plugin's single LFO from every voice's own counter (each 101 samples)
      if (this.lfoCount === 0) {
        s.lfo0 = f32(s.lfo0 + f32(s.dlfo * s.lfo1));
        s.lfo1 = f32(s.lfo1 - f32(s.dlfo * s.lfo0));
        this.mw = f32(s.lfo1 * f32(s.modwheel + s.vibrato));
        dc = f32(this.dcar + this.mw);
        this.lfoCount = 100;
      } else this.lfoCount--;
      cenv = f32(cenv + f32(catt * f32(env - cenv)));
      env = f32(env * cdec);
      const x1 = f32(amp1 * SINE[ph1 >>> 18]);
      const c1 = f32(f32(car + dc) + f32(menv1 * x1));
      car = f32(c1 + f32(f32(menv2 * amp2) * SINE[ph2 >>> 18]));
      menv1 = f32(menv1 + f32(mdec1 * f32(mlev1 - menv1)));
      menv2 = f32(menv2 + f32(mdec2 * f32(mlev2 - menv2)));
      ph1 = (ph1 + inc1) | 0;
      ph2 = (ph2 + inc2) | 0;
      if (car > 1 || car < -1) {
        if (car < 0) { do car = f32(car + 2); while (car < -1); }
        else { do car = f32(car - 2); while (car > 1); }
      } else if (car !== car) car = 0; // keep output finite (FL would loop forever on NaN)
      const x2 = f32(car * car);
      const sh = f32(car + f32(f32(x2 * car) * f32(f32(rich * f32(x2 - 1)) - 1)));
      raw[i] = f32(f32(norm * cenv) * f32(f32(modmix * x1) + sh));
    }
    this.car = car;
    this.env = env; this.cenv = cenv;
    this.ph1 = ph1; this.ph2 = ph2;
    this.menv1 = menv1; this.menv2 = menv2;
  }

  /** FL's checks after a voice's block (end of Voice_Render): the voice finishes below silence, modulator envelopes clear below 2^-24. */
  private blockEnd(): void {
    if (this.env < SILENCE) { this.cdec = 1; this.finished = true; }
    if (this.menv1 < MOD_SILENCE) { this.menv1 = 0; this.mlev1 = 0; }
    if (this.menv2 < MOD_SILENCE) { this.menv2 = 0; this.mlev2 = 0; }
  }

  render(L: Float32Array, R: Float32Array, n: number): boolean {
    if (this.free || !this.params) return false;
    if (n > 16) {
      // the channel renders in steps of at most 16 samples; split longer calls the same way
      let alive = true;
      for (let o = 0; o < n && alive; o += 16) alive = this.render(L.subarray(o, Math.min(n, o + 16)), R.subarray(o, Math.min(n, o + 16)), Math.min(16, n - o));
      return alive;
    }
    // FL renders a voice block by block and checks it after each block, killing a finished
    // voice there: a channel render call is that block here (its first step starts at a lower
    // frame than the previous step)
    const fr = this.params.frame;
    if (this.lastFrame >= 0 && !(fr > this.lastFrame)) {
      this.blockEnd();
      if (this.finished && !this.stealFresh) return false;
    }
    this.lastFrame = fr;
    this.stealFresh = false;
    this.voice(n);
    this.mix(L, R, n);
    return true;
  }

  /** FL's sampler levels: float32 pan law of FinalLevels, ramp from the last gains, FL's mix kernel. */
  private mix(L: Float32Array, R: Float32Array, n: number): void {
    const p = this.params!.levels;
    let pan = f32(p.pan);
    if (!(pan >= -1)) pan = -1; else if (pan > 1) pan = 1;
    const vol = f32(p.vol);
    const a = f32(f32(pan + 1) * 0.7853981633974483);
    let tl = f32(f32(Math.cos(a)) * vol);
    let tr = f32(f32(Math.sin(a)) * vol);
    if (!Number.isFinite(tl)) tl = 0;
    if (!Number.isFinite(tr)) tr = 0;
    // the first block starts at the target (no fade-in)
    if (this.lastL !== this.lastL) { this.lastL = tl; this.lastR = tr; }
    const t = this.t;
    t.v = tl;
    const sl = rampStep(t, this.lastL, n);
    tl = t.v;
    t.v = tr;
    const sr = rampStep(t, this.lastR, n);
    tr = t.v;
    const raw = this.raw;
    if (sl === 0 && sr === 0) {
      for (let i = 0; i < n; i++) {
        L[i] = f32(f32(raw[i] * tl) + L[i]);
        R[i] = f32(f32(raw[i] * tr) + R[i]);
      }
    } else {
      // FL's NEON ramp kernel: frame pairs (gains for frames 2k, 2k+1) stepped by two steps in
      // groups of 8 frames; the remaining frames step left by the right step and vice versa
      let g0 = this.lastL, g1 = this.lastR, g2 = f32(this.lastL + sl), g3 = f32(this.lastR + sr);
      let i = 0;
      if (n >= 8) {
        const d0 = f32(sl + sl), d1 = f32(sr + sr);
        for (; n - i >= 8; ) {
          for (let k = 0; k < 4; k++, i += 2) {
            L[i] = f32(f32(raw[i] * g0) + L[i]);
            R[i] = f32(f32(raw[i] * g1) + R[i]);
            L[i + 1] = f32(f32(raw[i + 1] * g2) + L[i + 1]);
            R[i + 1] = f32(f32(raw[i + 1] * g3) + R[i + 1]);
            g0 = f32(d0 + g0); g1 = f32(d1 + g1); g2 = f32(d0 + g2); g3 = f32(d1 + g3);
          }
        }
      }
      for (; i < n; i++) {
        L[i] = f32(f32(raw[i] * g0) + L[i]);
        R[i] = f32(f32(raw[i] * g1) + R[i]);
        g0 = f32(sr + g0); g1 = f32(sl + g1);
      }
    }
    this.lastL = tl;
    this.lastR = tr;
  }

  /**
   * FL's voice stealing (0x5e760): the envelope target drops to 0 (the level falls
   * at the attack rate) and FL kills the voice after its next block.
   */
  steal(): void {
    this.finished = true;
    this.env = 0;
    this.stealFresh = true;
  }

  /** FL's Voice_Release: the carrier envelope releases from its current level, the modulators toward 0. */
  release(): void {
    if (this.free) return;
    this.released = true;
    const s = this.s;
    this.cdec = s.crel;
    this.env = this.cenv;
    this.catt = 1;
    this.mlev1 = 0;
    this.mdec1 = s.mrel1;
    this.mlev2 = 0;
    this.mdec2 = s.mrel2;
  }

  kill(): void {
    if (!this.free) this.s.unlist(this);
    this.free = true;
    this.params = null;
  }
}

class DX10 implements GenInstance {
  readonly sampleRate: number;
  /** Normalised wheels (float32), FL's parameter order. */
  private readonly p = new Float32Array(22);
  tune = 0;
  pbend = 1;
  ratio1 = 0; depth1 = 0; dept21 = 0; velsens1 = 0; mdec1 = 0; mrel1 = 0;
  ratio2 = 0; depth2 = 0; dept22 = 0; velsens2 = 0; mdec2 = 0; mrel2 = 0;
  vibrato = 0;
  catt = 0; cdec = 0; crel = 0;
  rich = 0; modmix = 0; wave = 0;
  dlfo = 0;
  /** The plugin's single vibrato LFO (sine / cosine pair) and FL's (unused) mod wheel. */
  lfo0 = 0;
  lfo1 = 1;
  modwheel = 0;
  private readonly voices: DX10Voice[] = [];
  /** FL's voice list (TList): trigger order, killed voices replaced by the last one. */
  private readonly list: DX10Voice[] = [];
  private count = 0;
  /**
   * FL's FPE_MaxPoly: the channel's max polyphony, which FL sends when the channel
   * gets the plugin (DefPoly 16) and whenever its polyphony changes (0 = no limit).
   */
  maxPoly = 16;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new DX10Voice(this));
    for (let i = 0; i < MAX_VOICES; i++) this.list.push(this.voices[i]);
    this.setParams({});
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    const p = this.p;
    for (let i = 0; i < 22; i++) {
      const lo = i === 21 ? -3 : 0, hi = i === 21 ? 3 : 65536;
      const d = DEF[i];
      let v = Number(q[KEYS[i]] ?? d);
      if (!Number.isFinite(v)) v = d;
      v = Math.round(Math.min(hi, Math.max(lo, v)));
      p[i] = f32((v - lo) / (hi - lo));
    }
    this.update();
  }

  /** FL's update (0x5e260). */
  private update(): void {
    const p = this.p;
    const sr = this.sampleRate;
    const ifs = f32(1 / sr);
    const s8 = f32(44100 / sr);
    this.tune = f32(8.175798915644 * ifs * 2 ** (Math.floor(6.9 * p[21]) - 2));
    this.ratio1 = f32(1073741824 * f32(coarseRatio(p[3]) + fineRatio(p[4])));
    this.depth1 = f32(0.0002 * s8 * p[5] * p[5]);
    this.dept21 = f32(0.0002 * s8 * p[7] * p[7]);
    this.velsens1 = p[9];
    this.ratio2 = f32(1073741824 * f32(coarseRatio(p[14]) + fineRatio(p[15])));
    this.depth2 = f32(0.0002 * s8 * p[16] * p[16]);
    this.dept22 = f32(0.0002 * s8 * p[18] * p[18]);
    this.velsens2 = p[20];
    this.vibrato = f32(0.001 * p[10] * p[10]);
    const nifs = -ifs;
    this.catt = f32(1 - Math.exp(nifs * Math.exp(f32(8 - f32(8 * p[0])))));
    this.cdec = p[1] > 0.98 ? 1 : f32(Math.exp(nifs * Math.exp(f32(5 - f32(8 * p[1])))));
    this.crel = f32(Math.exp(nifs * Math.exp(f32(5 - f32(5 * p[2])))));
    this.mdec1 = f32(1 - Math.exp(nifs * Math.exp(f32(6 - f32(7 * p[6])))));
    this.mrel1 = f32(1 - Math.exp(nifs * Math.exp(f32(5 - f32(8 * p[8])))));
    this.mdec2 = f32(1 - Math.exp(nifs * Math.exp(f32(6 - f32(7 * p[17])))));
    this.mrel2 = f32(1 - Math.exp(nifs * Math.exp(f32(5 - f32(8 * p[19])))));
    this.wave = p[11];
    this.rich = f32(0.5 - f32(f32(3 * p[11]) * p[11]));
    this.modmix = f32(f32(0.25 * p[12]) * p[12]);
    this.dlfo = f32(628.3 * ifs * 25 * p[13] * p[13]);
  }

  /** FL's FPE_MaxPoly event (see maxPoly). */
  setMaxPoly(n: number): void {
    this.maxPoly = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  }

  triggerVoice(params: GenVoiceParams): GenVoice | null {
    // FL (0x5e760): with max polyphony N, once N unfinished voices play, the quietest
    // of them (the oldest of equals) is silenced before the new one starts
    if (this.maxPoly > 0 && this.count >= this.maxPoly) {
      let n = 0, best: DX10Voice | null = null, bestEnv = 2;
      for (let i = 0; i < this.count; i++) {
        const v = this.list[i];
        if (v.finished) continue;
        n++;
        if (v.env < bestEnv) { bestEnv = v.env; best = v; }
      }
      if (n >= this.maxPoly && best) best.steal();
    }
    for (const v of this.voices) {
      if (!v.free) continue;
      v.start(params);
      this.list[this.count++] = v;
      return v;
    }
    return null;
  }

  /** FL's TList.Delete without order (the last voice takes the killed one's place). */
  unlist(v: DX10Voice): void {
    const i = this.list.indexOf(v);
    if (i < 0 || i >= this.count) return;
    this.list[i] = this.list[--this.count];
  }

  reset(): void {
    for (const v of this.voices) v.kill();
    this.count = 0;
    this.lfo0 = 0;
    this.lfo1 = 1;
  }

  /** Editor data: the keys of the voices held down (FL's editor keyboard shows them). */
  monitor(): FxMonitor {
    const keys: number[] = [];
    for (const v of this.voices) if (!v.free && !v.released && !keys.includes(v.key)) keys.push(v.key);
    return { keys };
  }
}

const KEYS = [
  'attack', 'decay', 'release', 'mod1Coarse', 'mod1Fine', 'mod1Init', 'mod1Decay', 'mod1Sustain', 'mod1Release', 'mod1Vel',
  'vibrato', 'waveform', 'modThru', 'lfoRate', 'mod2Coarse', 'mod2Fine', 'mod2Init', 'mod2Decay', 'mod2Sustain', 'mod2Release',
  'mod2Vel', 'octave',
];
/** FL's constructor state (the Default preset), used for missing values. */
const DEF = [0, 42598, 28901, 55181, 21561, 15073, 52429, 3277, 52429, 58982, 0, 29295, 0, 27132, 0, 0, 0, 0, 0, 0, 0, 0];

export const gen: GenModule = {
  id: 'dx10',
  create: (sampleRate) => new DX10(sampleRate),
};
