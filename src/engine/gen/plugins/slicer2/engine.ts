// Fruity Slicer 2's engine (FL 2026, Fruity Slicer 2/engine.dylib, arm64 slice): the slicer
// instance with its 16 voices, ported from FL's code in its single precision, fused
// multiply-adds and operation order (addresses in docs/research/gen/slicer2.md).
//
// - Instance (0xf868 per sample): voices (newest first), the global filter (control
//   update every sr / 4410 samples), the instance gains from FL's MIDI volume and panning
//   (smoothed per sample) into the output.
// - Voice (0xe980 per sample): every sr / 4410 samples the playback rate (transpose,
//   detune, chromatic offset, pitch levels; Resample: x tempo / sample tempo), the slice
//   filter's coefficients (cutoff / res smoothed by 0.0508 per update), the envelope's
//   times and the pan / gain target; then the 4-point cubic (Catmull-Rom) read of the
//   sample, the slice filter (Cytomic SVF, LP / HP / BP 12 dB), the envelope x velocity
//   curve and the smoothed pan gains.
// - Envelope (0x5af0 / 0x567c..0x58d0): delay / attack / hold / decay / sustain / release
//   stages, attack and release times 2^(15 v) ms, curves exp(6.45 x) (fixed shape),
//   a note-off release and a fixed 1 ms release (slice end, mono, stolen voices); FL
//   computes its times at 44.1 kHz whatever the sample rate (FL quirk, kept).
// - Stretch mode: FL runs zplane's elastique pro (statically linked, proprietary) per
//   voice; replaced here by a granular pitch shifter keeping FL's contract (position
//   advance and pitch factor). Approximation: see the research note.

import { fma32 } from '../drumpad/libm';
import { exp2f, logf } from '../poizone/applemath';
import { expf, tanf } from './libm';

const f32 = Math.fround;
const dv = new DataView(new ArrayBuffer(4));
function u2f(u: number): number {
  dv.setUint32(0, u);
  return dv.getFloat32(0);
}

// --------------------------------------------------------------------------- laws
const POLY_A = f32(0.98435), POLY_B = f32(-0.231573), POLY_C = f32(0.247223);
/** 10^0.3 (engine: a static float 0x3fff64c2). */
const VOL_K = u2f(0x3fff64c2);
const PAN_A = u2f(0x3fe9fbe7), PAN_B = u2f(0xbf53f7cf), PAN_K = u2f(0x3fb50bf3);

/** FL's velocity curve (engine 0xe094): 0.98435 v^3 - 0.231573 v^2 + 0.247223 v. */
export function velCurve(v: number): number {
  const s1 = f32(f32(v * POLY_A) * v);
  const s2 = f32(f32(v * POLY_B) * v);
  return fma32(v, POLY_C, fma32(s1, v, s2));
}
/** FL's volume / gain curve (engine 0xd0ac): the velocity curve x 10^0.3 (+6 dB at 1). */
export function volCurve(v: number): number {
  return f32(velCurve(v) * VOL_K);
}
/** FL's pan law (engine 0xdfdc / 0xed1c): side gain for x = 1 - pan (left) or pan (right). */
function panSide(x: number): number {
  return f32(f32(x * fma32(x, PAN_B, PAN_A)) * PAN_K);
}
const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);

// --------------------------------------------------------------------------- envelope
const ENV_SR = 44100;
const EXP_C = f32(8.755737304687500);

/** FL's envelope curve object (0x93c8 / 0x94f4); every curve of the voice envelope is c = -1. */
class Curve {
  k = 0; inv = 0; lg = 0;
  set(c: number): void {
    let s = f32(expf(f32(Math.abs(c) * EXP_C)) - 1);
    if (!(c > 0)) s = -s;
    const k = f32(s * f32(0.1));
    if (k === this.k) return;
    this.k = k;
    if (k === 0) return;
    const a = Math.abs(k);
    this.inv = f32(1 / a);
    this.lg = logf1p(a);
  }
  at(x: number): number {
    if (this.k === 0) return x;
    if (this.k > 0) return fma32(-f32(expf(f32(f32(1 - x) * this.lg)) - 1), this.inv, 1);
    return f32(this.inv * f32(expf(f32(this.lg * x)) - 1));
  }
}
function logf1p(a: number): number {
  return logf(f32(a + 1));
}

/** The voice envelope (engine 0x58d4 ff.). */
export class Env {
  level = 0;
  phase = 0;
  relStart = 0;
  atkStart = 0;
  atkSpan = 1;
  state = 7;
  counter = 0;
  delayN = 0;
  holdN = 0;
  atkRate = 1;
  decRate = 1;
  relRate = 1;
  sus = 0.5;
  readonly fastRate: number;
  readonly ca = new Curve();
  readonly cd = new Curve();
  readonly cr = new Curve();
  constructor() {
    this.ca.set(-1); this.cd.set(-1); this.cr.set(-1);
    this.fastRate = f32(1 / f32(f32(ENV_SR) * f32(0.001)));
    this.setTime(1, 0); this.setTime(4, 0); this.setTime(7, 0);
  }
  /** Parameter 1 attack, 3 hold, 4 decay, 6 sustain, 7 release (0x5af0), value 0..1. */
  setTime(idx: number, v: number): void {
    switch (idx) {
      case 1: {
        let r = 1;
        if (v !== 0) {
          const t = f32(exp2f(f32(v * 15)) * 0.001);
          if (t !== 0) r = f32(1 / f32(t * ENV_SR));
        }
        this.atkRate = r;
        break;
      }
      case 3: this.holdN = Math.trunc(ENV_SR * f32(v * 10)); break;
      case 4: case 7: {
        let r = 1;
        if (v !== 0) {
          const t = f32(exp2f(f32(v * 15)) * f32(0.001));
          if (t !== 0) r = f32(1 / f32(t * ENV_SR));
        }
        if (idx === 4) this.decRate = r; else this.relRate = r;
        break;
      }
      case 6:
        this.sus = v;
        if (this.state === 4) { this.phase = v; this.level = v; }
        break;
    }
  }
  gateOn(): void {
    this.level = 0;
    this.atkStart = 0;
    this.atkSpan = 1;
    this.phase = 0;
    this.state = this.delayN < 1 ? 1 : 0;
    this.counter = 0;
  }
  /** Note-off release (0x5e8c). */
  noteOff(): void {
    if (this.state >= 5) return;
    this.phase = 1;
    this.relStart = this.level;
    this.state = 5;
  }
  /** 1 ms release (0x5e4c): slice end, mono hand-over. */
  fast(): void {
    if (this.state >= 6) return;
    if (this.state !== 5) { this.phase = 1; this.relStart = this.level; }
    this.state = 6;
  }
  done(): boolean {
    return this.state === 7;
  }
  tick(): number {
    if (this.state === 0) {
      if (++this.counter < this.delayN) return this.level;
      this.state = 1; this.counter = 0;
    }
    switch (this.state) {
      case 1: {
        const ph = this.phase + this.atkRate;
        this.phase = ph;
        if (ph < 1) this.level = fma32(this.atkSpan, this.ca.at(f32(ph)), this.atkStart);
        else { this.state = 2; this.counter = 0; this.level = 1; }
        break;
      }
      case 2: {
        const c = this.counter++;
        if (c >= this.holdN) { this.phase = 1; this.state = 3; }
        break;
      }
      case 3: {
        const ph = this.phase - this.decRate;
        this.phase = ph;
        const s = this.sus;
        if (!(ph >= 0)) { this.level = s; this.state = 4; } else this.level = fma32(f32(1 - s), this.cd.at(f32(ph)), s);
        break;
      }
      case 4: this.phase = this.sus; this.level = this.sus; break;
      case 5: case 6: {
        let ph = this.phase - (this.state === 5 ? this.relRate : this.fastRate);
        if (!(ph > 0)) ph = 0;
        this.phase = ph;
        const l = f32(this.cr.at(f32(ph)) * this.relStart);
        if (l < 9.999999974752427e-7) { this.level = 0; this.state = 7; } else this.level = l;
        break;
      }
    }
    return this.level;
  }
}

// --------------------------------------------------------------------------- filter
const PI = 3.141592653589793;
const CUT_A = f32(10.583333015441895), CUT_B = f32(14.350000381469727), RES_A = f32(0.7225000262260437), RES_B = f32(-0.9900000095367432);

/** FL's state variable filter (engine 0xc160 ff.: Cytomic / Simper SVF), stereo. */
export class Svf {
  piSr = f32(PI / 44100);
  a1 = 0; a2 = 0; a3 = 0; m0 = 0; m1 = 0; m2 = 0;
  l1 = 0; l2 = 0; r1 = 0; r2 = 0;
  setRate(sr: number): void { this.piSr = f32(PI / sr); }
  reset(): void { this.l1 = this.l2 = this.r1 = this.r2 = 0; }
  /** type 0 LP, 1 HP, 2 BP (0xc1cc with gain 1). */
  set(type: number, freq: number, k: number): void {
    const g = tanf(f32(this.piSr * freq));
    const a1 = f32(1 / fma32(g, f32(g + k), 1));
    const a2 = f32(g * a1);
    this.a1 = a1; this.a2 = a2; this.a3 = f32(g * a2);
    if (type === 0) { this.m0 = 0; this.m1 = 0; this.m2 = 1; } else if (type === 1) { this.m0 = 1; this.m1 = f32(-k); this.m2 = -1; } else { this.m0 = 0; this.m1 = 1; this.m2 = 0; }
  }
  /** FL's coefficients from the normalised cutoff / res (0xe28c / 0xf7bc). */
  setNorm(type: number, cut: number, res: number): void {
    const freq = f32(exp2f(f32(cut * CUT_A)) * CUT_B);
    this.set(type, freq, fma32(f32(res * RES_A), RES_B, 1));
  }
  /** 0xc4f4: processes io[0] (left) and io[1] (right) in place. */
  run(io: Float32Array): void {
    const { a1, a2, a3, m0, m1, m2 } = this;
    let x = io[0];
    let v3 = f32(x - this.l2);
    let v1 = fma32(a1, this.l1, f32(v3 * a2));
    let v2 = fma32(a3, v3, fma32(a2, this.l1, this.l2));
    this.l1 = f32(2 * v1 - this.l1); this.l2 = f32(2 * v2 - this.l2);
    io[0] = fma32(m2, v2, fma32(m0, x, f32(v1 * m1)));
    x = io[1];
    v3 = f32(x - this.r2);
    v1 = fma32(a1, this.r1, f32(v3 * a2));
    v2 = fma32(a3, v3, fma32(a2, this.r1, this.r2));
    this.r1 = f32(2 * v1 - this.r1); this.r2 = f32(2 * v2 - this.r2);
    io[1] = fma32(m2, v2, fma32(m0, x, f32(v1 * m1)));
  }
}

// --------------------------------------------------------------------------- data
/** A loaded sample (FL's sample object: channels zero-padded on both sides). */
export interface SampleData { ch: Float32Array[]; rate: number; len: number }

/** A slice record (engine record at S + 0x60 + 0x60 i), engine values (normalised floats). */
export class SliceRec {
  start = 0; end = 0; key = -1; mode = 0; ftype = 0;
  transpose = 0; detune = 0.5; gain = f32(0.7694); pan = 0.5; attack = 0; release = f32(0.1);
  cut = 1; res = 0; fade = 0; hold = 0; decay = 0.5; sustain = 1;
}

/** The instance's global values (engine S and the array object A). */
export class Globals {
  transpose = 0;
  detune = 0.5;
  /** Time stretching mode (S+0x10): 0 None, 1 Resample, 2 Stretch. */
  mode = 0;
  mono = false;
  ftype = 0;
  cut = 1;
  res = 0;
  /** Original sample tempo (S+0x48, float32). */
  tempo = 120;
  /** Chromatic slice (S+0x50). */
  chromatic = -1;
  /** First slice key (A+0x28). */
  baseKey = 60;
  /** Pitch bend in semitones (A+0x10, FPE_MIDI_Pitch). */
  bend = 0;
}

const CTRL_COEF = u2f(0x3d50605b); // 0.0508

// --------------------------------------------------------------------------- voice
const GRAIN = 2048;

export class Voice {
  pitchOfs = 0; fcut = 0; fres = 0; panOfs = 0;
  hold = false;
  to = 0;
  dir = 1;
  pos = 0;
  rate = 0;
  stretchInc = 0;
  key = 0;
  chromOfs = 0;
  slice = 0;
  mode = 0;
  rec: SliceRec = new SliceRec();
  smp: SampleData | null = null;
  counter = 0;
  period = 10;
  readonly env = new Env();
  cutS = 1; resS = 0;
  readonly svf = new Svf();
  velGain = 0;
  panTL = 0; panCL = 0; panTR = 0; panCR = 0;
  panCoef = 0;
  /** 0 free, 1 playing, 2 released. */
  state = 0;
  rendered = false;
  age = 0;
  private sr = 44100;
  // stretch stand-in (granular pitch shifter)
  private gPh = 0;
  private gStart0 = 0; private gStart1 = 0; private gOrg0 = 0;
  private pitch = 1;
  private readonly io = new Float32Array(2);

  setRate(sr: number): void {
    this.sr = sr;
    this.period = Math.trunc(sr / 4410);
    this.panCoef = f32(1 - Math.pow(0.1, 1 / (sr * 0.01)));
    this.svf.setRate(sr);
  }

  /** 0xdfdc: pan / gain target from the slice's pan and gain and the voice's pan offset. */
  computePan(): void {
    const p = clamp01(clamp01(f32(this.rec.pan + this.panOfs)));
    const q = f32(1 - p);
    const g = volCurve(this.rec.gain);
    this.panTL = f32(g * panSide(q));
    this.panTR = f32(g * panSide(p));
  }

  /** 0xe07c: start the voice on slice `idx`. */
  start(g: Globals, smp: SampleData, rec: SliceRec, idx: number, vel: number, key: number, chromOfs: number): void {
    this.rendered = false;
    this.velGain = velCurve(vel);
    this.pitchOfs = 0; this.fcut = 0; this.fres = 0; this.panOfs = 0;
    this.slice = idx;
    this.mode = g.mode;
    this.state = 1;
    this.chromOfs = chromOfs;
    this.rec = rec;
    this.smp = smp;
    this.computePan();
    this.panCL = this.panTL; this.panCR = this.panTR;
    this.key = key;
    const len = smp.len;
    const m = rec.mode;
    let from: number, to: number;
    if (m & 4) { from = rec.end; to = m & 2 ? 0 : rec.start; } else { from = rec.start; to = m & 2 ? len : rec.end; }
    this.hold = (m & 1) !== 0;
    from = Math.min(Math.max(from, 0), len);
    to = Math.min(Math.max(to, 0), len);
    this.to = to;
    this.dir = from <= to ? 1 : -1;
    this.pos = from;
    this.counter = 0;
    this.svf.reset();
    this.rate = 0; this.stretchInc = 0;
    this.cutS = clamp01(f32(rec.cut + this.fcut));
    this.resS = clamp01(f32(rec.res + this.fres));
    this.env.gateOn();
    this.gPh = GRAIN >> 1; this.gStart0 = from; this.gOrg0 = GRAIN >> 1; this.gStart1 = from;
  }

  /** 0xe3c4: the voice's transposition in semitones without the pitch levels. */
  private semis(g: Globals): number {
    let s = f32(f32(g.detune - 0.5) + this.rec.detune);
    s = f32(s - 0.5);
    s = f32(s + s);
    s = f32(s + (this.rec.transpose + g.transpose));
    return f32(s + this.chromOfs);
  }

  /** 0xe40c: playback rate (frames per output sample). */
  private computeRate(g: Globals, tempo: number): void {
    const smp = this.smp;
    if (!smp) { this.rate = 0; return; }
    const b = f32(g.bend + this.pitchOfs);
    const d9 = smp.rate / this.sr;
    const e = exp2f(f32(f32(b + this.semis(g)) / 12));
    let r = d9 * e;
    if (g.mode === 1) r *= tempo / f32(g.tempo);
    this.rate = r;
  }

  /** 0xe28c: slice filter coefficients and cutoff / res smoothing. */
  private filterUpdate(): void {
    const rec = this.rec;
    if (rec.ftype === 0) return;
    if (rec.ftype <= 3) this.svf.setNorm(rec.ftype - 1, this.cutS, this.resS);
    const tc = clamp01(f32(rec.cut + this.fcut)), tr = clamp01(f32(rec.res + this.fres));
    this.cutS = fma32(f32(tc - this.cutS), CTRL_COEF, this.cutS);
    this.resS = fma32(f32(tr - this.resS), CTRL_COEF, this.resS);
  }

  /** 0xe344: envelope times from the slice. */
  private envUpdate(): void {
    const r = this.rec, e = this.env;
    e.setTime(1, r.attack); e.setTime(3, r.hold); e.setTime(4, r.decay); e.setTime(6, r.sustain); e.setTime(7, r.release);
  }

  /** Release by note off (0xf404: not for Hold slices unless forced). */
  noteOff(force: boolean): void {
    if (!force && this.hold) return;
    this.state = 2;
    this.env.noteOff();
  }
  /** 1 ms release (mono hand-over, 0xf344). */
  fastRelease(): void {
    this.state = 2;
    this.env.fast();
  }

  /** 4-point cubic read (0xe518) at position `pos` of channel c (zeros outside the sample). */
  private interp(c: Float32Array, len: number, pos: number): number {
    const i = Math.trunc(pos);
    const x = f32(pos - i);
    const ym = i - 1 >= 0 && i - 1 < len ? c[i - 1] : 0;
    const y0 = i >= 0 && i < len ? c[i] : 0;
    const y1 = i + 1 >= 0 && i + 1 < len ? c[i + 1] : 0;
    const y2 = i + 2 >= 0 && i + 2 < len ? c[i + 2] : 0;
    const c1 = f32(f32(y1 - ym) * 0.5);
    let s4 = f32(y0 - y1);
    const s7 = f32(s4 + c1);
    s4 = f32(s4 + s7);
    const a = fma32(f32(y2 - y0), 0.5, s4);
    const b = f32(s7 + a);
    const t = fma32(a, x, -b);
    return fma32(fma32(t, x, c1), x, y0);
  }

  /** The sample frame at the current position, then the position advances (0xe518). */
  private fetch(io: Float32Array): void {
    io[0] = 0; io[1] = 0;
    const smp = this.smp!;
    const pos = this.pos;
    if (this.dir >= 0 ? pos >= this.to : !(pos >= this.to)) {
      this.state = 2;
      this.env.fast();
      return;
    }
    const l = this.interp(smp.ch[0], smp.len, pos);
    io[0] = l;
    io[1] = smp.ch.length === 1 ? l : this.interp(smp.ch[1], smp.len, pos);
    this.pos = this.dir > 0 ? pos + this.rate : pos - this.rate;
    this.endFade(io);
  }

  /** 0xe698: fade-out over the slice's last `fade` seconds (forward play only). */
  private endFade(io: Float32Array): void {
    const fade = this.rec.fade;
    if (!(fade > 0) || this.dir < 0) return;
    const fl = this.smp!.rate * fade;
    const st = this.to - fl;
    if (!(this.pos >= st)) return;
    let g = f32((this.pos - st) / fl);
    if (g > 1) g = 1;
    g = f32(1 - g);
    io[0] = f32(g * io[0]); io[1] = f32(g * io[1]);
  }

  /** Stretch mode stand-in: the read position advances at the tempo ratio (FL's elastique
   * contract), a two-grain pitch shifter (2048-frame Hann grains, 50 % overlap) applies the
   * pitch factor; the first grain starts at its peak so the slice's attack is kept. */
  private fetchStretch(io: Float32Array, g: Globals): void {
    io[0] = 0; io[1] = 0;
    const smp = this.smp!;
    if (this.dir >= 0 ? this.pos >= this.to : !(this.pos >= this.to)) {
      this.state = 2;
      this.env.fast();
      return;
    }
    if (this.counter === 1) this.pitch = exp2f(f32(f32(g.bend + this.pitchOfs + this.semis(g)) / 12)) / (this.sr / smp.rate);
    const half = GRAIN >> 1;
    const ph0 = this.gPh, ph1 = (this.gPh + half) % GRAIN;
    if (ph0 === 0) { this.gStart0 = this.pos; this.gOrg0 = 0; }
    if (ph1 === 0) this.gStart1 = this.pos;
    const w0 = 0.5 - 0.5 * Math.cos((2 * PI * ph0) / GRAIN), w1 = 1 - w0;
    const p0 = this.gStart0 + this.dir * (ph0 - this.gOrg0) * this.pitch, p1 = this.gStart1 + this.dir * ph1 * this.pitch;
    const c0 = smp.ch[0], c1 = smp.ch.length > 1 ? smp.ch[1] : c0;
    io[0] = f32(w0 * this.interp(c0, smp.len, p0) + w1 * this.interp(c0, smp.len, p1));
    io[1] = f32(w0 * this.interp(c1, smp.len, p0) + w1 * this.interp(c1, smp.len, p1));
    this.gPh = (this.gPh + 1) % GRAIN;
    this.pos = this.dir > 0 ? this.pos + this.stretchInc : this.pos - this.stretchInc;
  }

  /** 0xe980: one sample of the voice added to mix[0] / mix[1]. */
  render(g: Globals, tempo: number, mix: Float32Array): void {
    this.rendered = true;
    if (this.counter === 0) {
      if (this.mode === 2) this.stretchInc = (this.smp!.rate / this.sr) * (tempo / f32(g.tempo));
      else this.computeRate(g, tempo);
      this.filterUpdate();
      this.envUpdate();
      this.computePan();
    }
    this.counter = this.counter + 1 === this.period ? 0 : this.counter + 1;
    const io = this.io;
    if (this.mode === 2) this.fetchStretch(io, g); else this.fetch(io);
    if (this.rec.ftype !== 0) this.svf.run(io);
    const e = f32(this.env.tick() * this.velGain);
    let l = f32(io[0] * e), r = f32(e * io[1]);
    if (this.state === 2 && this.env.done()) this.state = 0;
    this.panCL = fma32(f32(this.panTL - this.panCL), this.panCoef, this.panCL);
    this.panCR = fma32(f32(this.panTR - this.panCR), this.panCoef, this.panCR);
    l = f32(this.panCL * l); r = f32(this.panCR * r);
    mix[0] = f32(l + mix[0]);
    mix[1] = f32(r + mix[1]);
  }
}

// --------------------------------------------------------------------------- instance
export const MAX_VOICES = 16;

/** Remove element i keeping the order, without allocating (Array.prototype.splice returns an array). */
export function removeAt<T>(a: T[], i: number): T {
  const x = a[i];
  for (let k = i; k + 1 < a.length; k++) a[k] = a[k + 1];
  a.length--;
  return x;
}

/** The slicer instance (engine object S, 0x3408 bytes). */
export class Instance {
  readonly g = new Globals();
  slices: SliceRec[] = [];
  smp: SampleData | null = null;
  /** Active voices in start order, and the free pool (a stack). */
  readonly active: Voice[] = [];
  private readonly pool: Voice[] = [];
  private ageCounter = 0;
  // MIDI volume / pan (S+0x327c / 0x3280) and the instance gains (target / current)
  vol = f32(0.7694);
  pan = 0.5;
  gTL = 1; gTR = 1; gCL = 1; gCR = 1;
  private gainCoef = 0;
  // global filter
  readonly svf = new Svf();
  gCut = 0; gRes = 0;
  private fCounter = 0;
  private fPeriod = 10;
  private readonly mix = new Float32Array(2);
  sr = 44100;

  constructor(sr: number) {
    for (let i = 0; i < MAX_VOICES; i++) this.pool.push(new Voice());
    this.setRate(sr);
    this.computeGains();
  }

  setRate(sr: number): void {
    this.sr = sr;
    this.killAll();
    this.svf.setRate(sr);
    for (const v of this.pool) v.setRate(sr);
    this.fPeriod = Math.trunc(sr / 4410);
    this.gainCoef = f32(1 - Math.pow(0.1, 1 / (sr * 0.01)));
  }

  /** 0xed1c: instance gains from the MIDI volume and panning. */
  computeGains(): void {
    const p = clamp01(this.pan), q = f32(1 - p);
    const vg = volCurve(this.vol);
    this.gTL = f32(panSide(q) * vg);
    this.gTR = f32(panSide(p) * vg);
  }

  killAll(): void {
    while (this.active.length) { const v = this.active.pop()!; v.state = 0; this.pool.push(v); }
  }

  /** 0xf3a4 / 0xf640: a free voice, or the oldest one stolen. */
  private alloc(): Voice {
    let v: Voice;
    if (this.active.length < MAX_VOICES) v = this.pool.pop()!;
    else {
      let best = 0;
      for (let i = 1; i < this.active.length; i++) if (this.active[i].age < this.active[best].age) best = i;
      v = removeAt(this.active, best);
    }
    v.age = ++this.ageCounter;
    return v;
  }

  private monoRelease(): void {
    for (const v of this.active) v.fastRelease();
  }

  /** The key of slice i (record key, or base key + index). */
  sliceKey(i: number): number {
    const k = this.slices[i].key;
    return k >= 0 ? k : this.g.baseKey + i;
  }

  /** 0xf19c: note on (velocity 0..1). */
  noteOn(key: number, vel: number): void {
    const smp = this.smp;
    if (!smp) return;
    const g = this.g;
    if (g.chromatic >= 0 && g.chromatic < this.slices.length) {
      if (g.mono) this.monoRelease();
      const v = this.alloc();
      v.start(g, smp, this.slices[g.chromatic], g.chromatic, vel, key, key - this.sliceKey(g.chromatic));
      this.active.push(v);
      return;
    }
    if (g.mono) this.monoRelease();
    for (let i = 0; i < this.slices.length; i++) {
      if (this.sliceKey(i) !== key) continue;
      if (g.mono) this.monoRelease();
      const v = this.alloc();
      v.start(g, smp, this.slices[i], i, vel, key, 0);
      this.active.push(v);
    }
  }

  /** 0xf404: note off (all voices of the key, Hold slices only when forced). */
  noteOff(key: number, force = false): void {
    for (const v of this.active) if (v.key === key) v.noteOff(force);
  }

  // per-voice level setters (0xf4b4 / 0xf508 / 0xf55c / 0x10ba8): FL applies them to every voice
  setPitch(semis: number): void { for (const v of this.active) v.pitchOfs = semis; }
  setFCut(x: number): void {
    for (const v of this.active) { v.fcut = x; if (!v.rendered) v.cutS = clamp01(f32(v.rec.cut + x)); }
  }
  setFRes(x: number): void {
    for (const v of this.active) { v.fres = x; if (!v.rendered) v.resS = clamp01(f32(v.rec.res + x)); }
  }
  setPan(x: number): void {
    for (const v of this.active) {
      v.panOfs = x;
      if (!v.rendered) { v.computePan(); v.panCL = v.panTL; v.panCR = v.panTR; }
    }
  }

  /** 0xf7bc: global filter coefficients and smoothing (every sr / 4410 samples while on). */
  private globalFilterUpdate(): void {
    const g = this.g;
    if (g.ftype === 0) return;
    if (g.ftype <= 3) this.svf.setNorm(g.ftype - 1, this.gCut, this.gRes);
    this.gCut = fma32(f32(g.cut - this.gCut), CTRL_COEF, this.gCut);
    this.gRes = fma32(f32(g.res - this.gRes), CTRL_COEF, this.gRes);
  }

  /** Whether the smoothed values have reached their float32 fixed points. */
  settled(): boolean {
    const g = this.g;
    if (fma32(f32(this.gTL - this.gCL), this.gainCoef, this.gCL) !== this.gCL) return false;
    if (fma32(f32(this.gTR - this.gCR), this.gainCoef, this.gCR) !== this.gCR) return false;
    if (g.ftype !== 0 && (fma32(f32(g.cut - this.gCut), CTRL_COEF, this.gCut) !== this.gCut || fma32(f32(g.res - this.gRes), CTRL_COEF, this.gRes) !== this.gRes)) return false;
    return true;
  }

  /** FL runs the instance all the time: after an idle time its smoothing has converged. */
  settle(): void {
    const g = this.g;
    for (let i = 0; i < 100000; i++) {
      const l = fma32(f32(this.gTL - this.gCL), this.gainCoef, this.gCL), r = fma32(f32(this.gTR - this.gCR), this.gainCoef, this.gCR);
      if (l === this.gCL && r === this.gCR) break;
      this.gCL = l; this.gCR = r;
    }
    if (g.ftype !== 0) {
      for (let i = 0; i < 100000; i++) {
        const c = fma32(f32(g.cut - this.gCut), CTRL_COEF, this.gCut), q = fma32(f32(g.res - this.gRes), CTRL_COEF, this.gRes);
        if (c === this.gCut && q === this.gRes) break;
        this.gCut = c; this.gRes = q;
      }
      if (g.ftype <= 3) this.svf.setNorm(g.ftype - 1, this.gCut, this.gRes);
    }
  }

  /** 0xf868: one output sample into out[0] (left) / out[1] (right). */
  renderSample(tempo: number, out: Float32Array): void {
    const mix = this.mix;
    mix[0] = 0; mix[1] = 0;
    const g = this.g;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const v = this.active[i];
      v.render(g, tempo, mix);
      if (v.state === 0) { removeAt(this.active, i); this.pool.push(v); }
    }
    if (this.fCounter === 0) this.globalFilterUpdate();
    this.fCounter = this.fCounter + 1 === this.fPeriod ? 0 : this.fCounter + 1;
    if (g.ftype !== 0) this.svf.run(mix);
    this.gCL = fma32(f32(this.gTL - this.gCL), this.gainCoef, this.gCL);
    this.gCR = fma32(f32(this.gTR - this.gCR), this.gainCoef, this.gCR);
    out[0] = f32(mix[0] * this.gCL);
    out[1] = f32(mix[1] * this.gCR);
  }
}
