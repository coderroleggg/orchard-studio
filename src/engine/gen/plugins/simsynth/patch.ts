// SimSynth: one voice of FL's engine (class `patch`, 0x340 bytes, SimSynth_eng_x64.dylib):
// three oscillators (+ ring modulation), the amplitude and filter envelopes, the LFO,
// the filter, and patch::FillBuff (0x3da0), the per-sample render FL's Voice::Render
// calls. Every method is a line-by-line port (addresses in the comments).

import { G, nextNoise, setTableRate } from './tables';
import { cvtzs, cvtzu, f32, fmaf } from './fmath';
import { OSC_LOOP, OSC_NOISE, OSC_QUALITY, Osc, OscLoop, OscNoise, OscQuality, PEnv, PFilt, PLfo } from './dsp';
import { makeSamp, type Synth } from './synth';

const INV255 = f32(0.003921568859368563); // 0x3b808081
const LFO_K = f32(0.0010010009864345193); // 0x3a833405
const INV12700 = f32(7.874015864217654e-5); // 0x38a5214d
const K001 = f32(0.009999999776482582); // 0x3c23d70a
const K003 = f32(0.029999999329447746); // 0x3cf5c28f
const TINY = f32(5.960465188081798e-8); // 0x33800001
const INV128 = 0.0078125;
const HALF_PI_255 = 0.006159985595274104; // (pi / 2) / 255
const SVF_OFF = 0x2253;

/** The engine's table rate: 2 x the sample rate in quality mode (FL's setting after creation). */
export function tableRate(sy: Synth): number {
  return sy.quality !== 0 && sy.render === 0 ? f32(G.grate + G.grate) : G.grate;
}

export class Patch {
  /** 0xc / 0xd: quality / render copied from the synth; 0x10, 0x8, 0x20: bookkeeping. */
  quality = 0;
  render = 0;
  x10 = 1;
  x8 = 0;
  /** 0x24 / 0xc0: amplitude and filter envelopes. */
  readonly env1 = new PEnv();
  readonly env2 = new PEnv();
  /** 0x14 / 0x160 / 0x164: double 40 squared, VCA Velo and the trigger velocity / 255 (all unused by FillBuff). */
  x14 = 0;
  vca = 0;
  vel = 0;
  /** 0x15c: TRACK AMP off. */
  trackAmpOff = 0;
  /** 0x170: the smoothed amplitude (one pole, 0.03). */
  amp = 0;
  /** 0x178: ring modulation 1x2. */
  ring = 0;
  /** 0x180..: the oscillator objects and their classes (0x198..). */
  readonly osc: (Osc | null)[] = [null, null, null];
  readonly cls = new Int32Array(3);
  /** 0x1a8..: the active oscillators (copies of osc[], null when off). */
  readonly act: (Osc | null)[] = [null, null, null];
  /** 0x1c0: LFO active; 0x1c8: the LFO. */
  lfoOn = 0;
  readonly lfo = new PLfo();
  /** 0x238.. / 0x244..: per-oscillator LFO / envelope pitch amounts (cents). */
  readonly lfoAmt = new Float32Array(3);
  readonly envAmt = new Float32Array(3);
  /** 0x250: the note's pitch index; 0x254..: coarse + fine; 0x25a..: full pitch per oscillator (16 bit). */
  note = 0;
  readonly cf = new Int32Array(3);
  readonly full = new Int32Array(3);
  /** 0x260: pitch bend (cents), 0x264: filter offset (Mod X + key tracking). */
  bend = 0;
  fmod = 0;
  /** 0x268: samples since the note started (the control rate counts 32 from it). */
  pos = 0;
  /** 0x26c: filter active; 0x270: the filter; 0x324..0x332: its envelope / LFO amounts and switches. */
  filtOn = 0;
  readonly filt = new PFilt();
  fEnvAmt2 = 0;
  fEnvAmt = 0;
  fLfoAmt = 0;
  fEnvOn = 0;
  fLfoOn = 0;
  flagB0 = 0;
  /** 0x33c: this voice's detune (cents, from Preset::SetNumVoices). */
  detune = 0;
  constructor(readonly sy: Synth) {}

  // ------------------------------------------------------------ set-up (synth::f_generate)

  /** synth::f_generate (0x5ba0): rebuild the voice from the synth; arg 0 leaves it silent. */
  generate(arg: number): void {
    const sy = this.sy;
    setTableRate(tableRate(sy));
    this.quality = sy.quality;
    this.render = sy.render;
    this.x10 = sy.renderInt;
    this.rethinkEnvs();
    this.rethinkLfo();
    this.rethinkOscs();
    for (let k = 0; k < 3; k++) if (sy.osc[k].off === 0) makeSamp(sy, k);
    this.ring = sy.osc[0].ring !== 0 ? 1 : 0;
    this.rethinkFilter();
    if (this.filtOn) this.clearFilter();
    this.x14 = sy.d40sq;
    this.vca = sy.vca;
    this.start();
    this.x8 = 1;
    if (arg === 0) { this.env1.stage = 4; this.env2.stage = 4; }
  }

  private clearFilter(): void {
    const t = this.filt;
    t.x70 = 0; t.low2 = 0; t.high2 = 0; t.band2 = 0; t.low1 = 0; t.high1 = 0; t.band1 = 0;
  }

  /** patch::start (0x3ce0). */
  start(): void {
    this.pos = 0;
    this.restartPitches(false);
    this.lfo.sync(0);
    this.bend = 0;
    this.fmod = 0;
    this.amp = 0;
  }

  /** The pitch / phase part of patch::start and patch::retrigger (osc 2 four cents down, osc 3 four up). */
  private restartPitches(sync: boolean): void {
    const b0 = this.full[0] & 0xffff;
    const b1 = (this.full[1] - 4) & 0xffff;
    const b2 = (this.full[2] + 4) & 0xffff;
    this.cf[0] = b0; this.cf[1] = b1; this.cf[2] = b2;
    if (sync) for (let k = 0; k < 3; k++) this.act[k]?.sync();
    for (let k = 0; k < 3; k++) {
      const o = this.act[k];
      if (!o) continue;
      o.base = k === 0 ? b0 : k === 1 ? b1 : b2;
      o.setfrq(0);
    }
  }

  /** patch::RethinkEnvs (0x5660). */
  rethinkEnvs(): void {
    const sy = this.sy;
    if (sy.env1Times[3] <= 1) sy.env1Times[3] = 2;
    this.env1.init(sy.env1Times, levels16(sy.env1Lv));
    this.trackAmpOff = sy.trackAmpOff;
    if (sy.env2Times[3] <= 0) sy.env2Times[3] = 1;
    this.env2.init(sy.env2Times, levels16(sy.env2Lv));
  }

  /** patch::RethinkLFO (0x5980). */
  rethinkLfo(): void {
    const r = this.sy.osc[3];
    this.lfoOn = 0;
    this.lfo.outA = 0;
    if (r.off !== 0) return;
    this.lfoOn = 1;
    const l = this.lfo;
    l.shape = r.type;
    l.setfrq(r.coarse & 0xffff);
    l.retrig = r.warm;
    l.half = 0;
    l.delay = r.f10 & 0xffff;
    l.sync(0);
  }

  /** patch::SetLFOFrq (0x5a0c): a live rate change (its own float order, x 4 sample rate). */
  setLfoFrq(): void {
    const r = this.sy.osc[3];
    if (r.off !== 0) { this.lfo.outA = 0; this.lfoOn = 0; return; }
    const l = this.lfo;
    const s0 = f32(r.coarse & 0xffff);
    const K = LFO_K;
    const rr = f32(s0 * K);
    let x = fmaf(-s0, K, 1);
    const s1 = f32(G.grate * 4);
    x = fmaf(-rr, x, x);
    x = f32(x * s1);
    x = fmaf(-rr, x, x);
    let n = cvtzu(x);
    if (!(n > 64)) n = 64;
    l.len = n;
    const fn = f32(n);
    l.step = f32(1 / fn);
    l.cnt = cvtzu(f32(l.ramp * fn));
    this.lfoOn = 1;
  }

  /** patch::SetLFODelay (0x5aa0). */
  setLfoDelay(): void {
    const r = this.sy.osc[3];
    if (r.off !== 0) { this.lfo.outA = 0; this.lfoOn = 0; return; }
    this.lfo.delay = r.f10 & 0xffff;
    this.lfoOn = 1;
  }

  /** patch::GetOscType (0x5180). */
  private oscType(k: number): number {
    const sy = this.sy;
    if (sy.osc[k].type === 3) return OSC_NOISE;
    if (k === 2 && sy.osc[1].off === 0 && sy.osc[1].type !== 3 && sy.osc[2].ring !== 0) return 6;
    if (this.render !== 0) return 7;
    return this.quality !== 0 ? OSC_QUALITY : OSC_LOOP;
  }

  /** patch::CreateOscType (0x4f5c): a new object when the class changes (keeping the phase of table oscillators). */
  private createOsc(k: number): number {
    const c = this.oscType(k);
    if (this.cls[k] === c) return c;
    const old = this.cls[k] !== 0 ? this.osc[k] : null;
    let ph = 0;
    if (old && (old.cls === OSC_LOOP || old.cls === OSC_QUALITY)) ph = (old as OscLoop | OscQuality).phase;
    this.cls[k] = c;
    let o: Osc | null = null;
    if (c === OSC_LOOP) { const n = new OscLoop(this.sy.waves[k]); n.phase = ph; n.phase2 = ph; o = n; }
    else if (c === OSC_QUALITY) { const n = new OscQuality(this.sy.waves[k]); n.phase = ph; n.phase2 = ph; o = n; }
    else if (c === OSC_NOISE) o = new OscNoise();
    // classes 6 (syncer) and 7 (render) are unreachable after FL's creation sequence
    this.osc[k] = o;
    return c;
  }

  /** patch::RethinkOscs (0x4bbc). */
  rethinkOscs(): void {
    const sy = this.sy;
    for (let k = 0; k < 3; k++) this.cf[k] = (sy.osc[k].coarse + sy.osc[k].fine) & 0xffff;
    this.act[0] = this.act[1] = this.act[2] = null;
    for (let k = 0; k < 3; k++) {
      const r = sy.osc[k];
      this.envAmt[k] = 0;
      this.lfoAmt[k] = 0;
      if (r.off !== 0) {
        this.osc[k] = null;
        this.cls[k] = 0;
        continue;
      }
      const c = this.createOsc(k);
      const pitch = (r.coarse + this.note + r.fine) & 0xffff;
      const o = this.osc[k];
      if (c === OSC_LOOP && o) {
        const q = o as OscLoop;
        q.idx = pitch; q.base = pitch; q.level = 0.5; q.out = 0; q.fixed = 0;
        q.table = sy.waves[k];
        q.phase2 = q.phase;
        q.warm = r.warm;
        q.setfrq(1);
        q.phase = (q.phase + cvtzs(nextNoise() * 2147483648)) >>> 0;
        q.phase2 = q.phase;
        q.detune = k + this.detune;
      } else if (c === OSC_QUALITY && o) {
        const q = o as OscQuality;
        q.idx = pitch; q.base = pitch; q.level = 0.5; q.out = 0; q.fixed = 0;
        q.table = sy.waves[k];
        q.phase2 = q.phase;
        q.warm = r.warm;
        q.setfrq(1);
        q.setfrq(4800);
        q.phase = cvtzs(nextNoise() * 2147483648) >>> 0;
        q.phase2 = q.phase;
        q.detune = k + this.detune;
      } else if (c === OSC_NOISE && o) {
        o.idx = pitch; o.base = pitch; o.level = 1; o.out = 0; o.fixed = 0;
      }
      if (r.lfo !== 0) this.lfoAmt[k] = f32(r.lfo * 12);
      if (r.env !== 0) this.envAmt[k] = f32(r.env * 12);
    }
    for (let k = 0; k < 3; k++) {
      const o = this.osc[k];
      this.act[k] = o;
      if (o) this.full[k] = o.base;
    }
    this.recalcAmps();
  }

  /** patch::ReInitOsc (0x5248): an octave / warm switch: the oscillator restarts at a new random phase. */
  reInitOsc(k: number): void {
    const sy = this.sy;
    const c = this.oscType(k);
    if (c !== this.cls[k]) { this.rethinkOscs(); return; }
    if (!this.act[k]) return;
    const r = sy.osc[k];
    this.lfoAmt[k] = f32(r.lfo * 12);
    this.envAmt[k] = f32(r.env * 12);
    const o = this.osc[k]!;
    if (c === OSC_LOOP) {
      const q = o as OscLoop;
      const base = q.base, lv = q.level;
      q.idx = base; q.base = base; q.level = lv; q.out = 0; q.fixed = 0;
      q.table = sy.waves[k];
      q.phase2 = q.phase;
      q.warm = r.warm;
      q.setfrq(1);
      q.phase = (q.phase + cvtzs(nextNoise() * 2147483648)) >>> 0;
      q.phase2 = q.phase;
    } else if (c === OSC_QUALITY) {
      const q = o as OscQuality;
      const base = q.base, lv = q.level;
      q.idx = base; q.base = base; q.level = lv; q.out = 0; q.fixed = 0;
      q.table = sy.waves[k];
      q.phase2 = q.phase;
      q.warm = r.warm;
      q.setfrq(1);
      q.setfrq(4800);
      q.phase = cvtzs(nextNoise() * 2147483648) >>> 0;
      q.phase2 = q.phase;
    } else if (c === OSC_NOISE) {
      o.idx = o.base; o.out = 0; o.fixed = 0;
    }
    this.setOscFrq(k, r.coarse, r.fine);
  }

  /** patch::RecalcOscAmps (0x5110): level (0..100 x 0.01) squared. */
  recalcAmps(): void {
    for (let k = 0; k < 3; k++) {
      const o = this.act[k];
      if (!o) continue;
      const x = f32(f32(this.sy.osc[k].level) * K001);
      o.level = f32(x * x);
    }
  }

  /** patch::SetOscFrq (0x4854): coarse + fine (16-bit sums) for one oscillator. */
  setOscFrq(k: number, coarse: number, fine: number): void {
    const o = this.act[k];
    if (!o) return;
    const cf = (((coarse << 16) >> 16) + ((fine << 16) >> 16)) & 0xffff;
    this.cf[k] = cf;
    const p = (cf + this.note) & 0xffff;
    o.base = p;
    this.full[k] = p;
    if (o.fixed !== 0) o.base = cf;
  }

  /** patch::ChangeOscLfo / ChangeOscEnv (0x5220 / 0x51f8). */
  changeOscLfo(k: number): void { this.lfoAmt[k] = f32(this.sy.osc[k].lfo * 12); }
  changeOscEnv(k: number): void { this.envAmt[k] = f32(this.sy.osc[k].env * 12); }

  /** patch::SetOscKnob (0x48d8): the coarse knob value to the oscillator (the noise colour). */
  setOscKnob(v: number, k: number): void { this.act[k]?.setknob(v); }

  /** patch::RethinkFilter (0x4668). */
  rethinkFilter(): void {
    const sy = this.sy;
    this.filtOn = 0;
    if (((sy.svfOff << 16) >> 16) === SVF_OFF) return;
    const t = this.filt;
    const emph = sy.emph & 0xffff;
    t.cut = f32(f32(sy.cut & 0xffff) * INV255);
    t.angA = (sy.high & 0xffff) * HALF_PI_255;
    t.angB = (sy.band & 0xffff) * HALF_PI_255;
    const sa = Math.sin(t.angA), ca = Math.cos(t.angA);
    const sb = Math.sin(t.angB), cb = Math.cos(t.angB);
    t.mixHigh = cb * sa;
    t.mixLow = cb * ca;
    t.mixBand = sb;
    this.flagB0 = (sy.b15c & 0xff) === 1 ? 1 : 0;
    t.emph = emph;
    t.setQ(emph);
    this.filtOn = 1;
    this.fEnvOn = 0;
    this.fLfoOn = 0;
    if (sy.fEnv !== 0) { const a = f32(sy.fEnv * INV128); this.fEnvAmt = a; this.fEnvAmt2 = a; this.fEnvOn = 1; }
    if (sy.fLfo !== 0) { this.fLfoAmt = f32(sy.fLfo * INV128); this.fLfoOn = 1; }
  }

  /** patch::SetFilterFrq (0x5510). */
  setFilterFrq(v: number): void { this.filt.cut = f32(f32(v) * INV255); }
  /** patch::SetFilterQ (0x5528). */
  setFilterQ(v: number): void { this.filt.emph = v & 0xffff; this.filt.setQ(v); }
  /** patch::SetFilterEnvModAmt / SetFilterLfoModAmt (0x5564 / 0x557c). */
  setFilterEnvAmt(v: number): void { const a = f32(v * INV128); this.fEnvAmt = a; this.fEnvAmt2 = a; }
  setFilterLfoAmt(v: number): void { this.fLfoAmt = f32(v * INV128); }
  /** patch::OffsetFilterQ (0x4b60): Mod Y moves the emphasis. */
  offsetFilterQ(o: number): void {
    let e = (this.filt.emph + o) | 0;
    if (!(e < 255)) e = 255;
    if (!(e > 0)) e = 0;
    this.filt.setQ(e);
  }

  // ------------------------------------------------------------ notes

  /** patch::ChngNote (0x47b0): the note's pitch index (Voice::Change: final pitch + 7200). */
  chngNote(p: number): void {
    const sy = this.sy;
    const n = (p + 2400) | 0;
    this.note = n;
    for (let k = 0; k < 3; k++) {
      const o = this.act[k];
      if (!o) continue;
      const cf = (sy.osc[k].coarse + sy.osc[k].fine) & 0xffff;
      const full = (cf + n) & 0xffff;
      this.cf[k] = cf;
      o.base = full;
      this.full[k] = full;
      if (o.fixed !== 0) o.base = cf;
    }
  }

  /** patch::Gate (0x4a74): a note on. */
  gate(pitch: number, vel: number, time: number, fcut: number, fres: number): void {
    this.chngNote(pitch);
    const v = f32(f32(vel) * INV255);
    let e = (cvtzs(f32(fres * 255)) + this.filt.emph) | 0;
    if (!(e < 255)) e = 255;
    if (!(e > 0)) e = 0;
    this.filt.setQ(e);
    this.vel = v;
    this.fmod = fmaf(f32(f32(pitch) * INV12700), this.sy.kb, fcut);
    this.retrigger(time);
  }

  /** patch::retrigger (0x4918). */
  retrigger(time: number): void {
    this.pos = 0;
    if (this.env1.value === 0 && this.filtOn) this.clearFilter();
    const e1 = this.env1, e2 = this.env2;
    e1.stage = 0; e1.left = e1.lens[0]; e1.inc = e1.incs[0];
    e1.value = 0;
    e2.stage = 0; e2.left = e2.lens[0]; e2.inc = e2.incs[0];
    e2.value = 0;
    this.restartPitches(true);
    if (this.lfoOn === 1) this.lfo.sync(this.lfo.retrig === 0 ? time : 0);
    this.amp = 0;
  }

  /** patch::Release (0x5ad0). */
  release(): void {
    this.env1.release();
    this.env2.release();
  }

  /** patch::ShutTheFuckUp (0x4bac). */
  mute(): void {
    this.env1.stage = 4;
    this.env2.stage = 4;
  }

  /** Voice::FiltMod (0x80c4): Mod X plus key tracking (pitch index 0.0..) into the filter offset. */
  filtMod(fcut: number, pitchF: number, transpose: number): void {
    let s1 = f32(f32(transpose) + pitchF);
    if (!(s1 >= 100)) s1 = 100;
    this.fmod = fmaf(f32(this.sy.kb * INV12700), s1, fcut);
  }

  // ------------------------------------------------------------ render

  /** patch::FillBuff (0x3da0) without its entry check (the caller skips finished voices like FL's Gen_Render). */
  fill(out: Float32Array, off: number, n: number): void {
    const o1 = this.act[0], o2 = this.act[1], o3 = this.act[2];
    const ringOn = !!o1 && !!o2 && this.ring !== 0;
    const l1 = o1 ? this.lfoAmt[0] : 0, e1a = o1 ? this.envAmt[0] : 0;
    const l2 = o2 ? this.lfoAmt[1] : 0, e2a = o2 ? this.envAmt[1] : 0;
    const l3 = o3 ? this.lfoAmt[2] : 0, e3a = o3 ? this.envAmt[2] : 0;
    const env1 = this.env1, env2 = this.env2, lfo = this.lfo, filt = this.filt;
    const trackOff = this.trackAmpOff !== 0, lfoOn = this.lfoOn === 1, filtOn = this.filtOn !== 0;
    const fEnvOn = this.fEnvOn !== 0, fLfoOn = this.fLfoOn !== 0;
    let s9 = this.amp;
    let pos = this.pos;
    let lfoA = 0, lfoB = 0;
    for (let i = 0; i < n; i++) {
      env1.tick();
      const ev = env1.value;
      const amp = f32((env1.stage === 0 ? 1 : ev) * ev);
      env2.tick();
      const fenv = trackOff ? env2.value : amp;
      if (lfoOn) { lfo.tick(); lfoA = lfo.outA; lfoB = lfo.outB; }
      let x = 0;
      if ((pos & 31) !== 0) {
        if (o1) { const t = o1.tick(); x = f32(o1.level * t); o1.out = x; }
        if (o2) {
          const t = o2.tick();
          const y = f32(o2.level * t);
          o2.out = y;
          x = ringOn ? f32(x * f32(y + y)) : f32(y + x);
        }
        if (o3) { const t = o3.tick(); o3.out = f32(o3.level * t); x = fmaf(o3.level, t, x); }
        if (filtOn) x = filt.tick(x);
      } else {
        if (o1) {
          let m = this.bend;
          if (l1 !== 0) m = fmaf(l1, lfoB, m);
          if (e1a !== 0) m = fmaf(e1a, amp, m);
          o1.setfrq(cvtzs(m));
          const t = o1.tick();
          x = f32(o1.level * t);
          o1.out = x;
        }
        if (o2) {
          let m = this.bend;
          if (l2 !== 0) m = fmaf(l2, lfoB, m);
          if (e2a !== 0) m = fmaf(e2a, amp, m);
          o2.setfrq(cvtzs(m));
          const t = o2.tick();
          const y = f32(o2.level * t);
          o2.out = y;
          x = ringOn ? f32(x * f32(y + y)) : f32(y + x);
        }
        if (o3) {
          let m = this.bend;
          if (l3 !== 0) m = fmaf(l3, lfoB, m);
          if (e3a !== 0) m = fmaf(e3a, amp, m);
          o3.setfrq(cvtzs(m));
          const t = o3.tick();
          o3.out = f32(o3.level * t);
          x = fmaf(o3.level, t, x);
        }
        if (filtOn) {
          let m = this.fmod;
          if (fEnvOn) m = fmaf(this.fEnvAmt, fenv, m);
          if (fLfoOn) m = fmaf(this.fLfoAmt, lfoA, m);
          filt.setfrq(m);
          x = filt.tick(x);
        }
      }
      let a = fmaf(amp, amp, -s9);
      a = fmaf(a, K003, s9);
      s9 = a > -TINY && a < TINY ? 0 : a;
      out[off + i] = f32(x * s9);
      pos = (pos + 1) | 0;
    }
    this.pos = pos;
    this.amp = s9;
  }
}

/** RethinkEnvs' 16-bit levels: L << 8 (L == 1 gives 1). */
const LV16 = new Int32Array(5);
function levels16(lv: Int32Array): Int32Array {
  for (let i = 0; i < 5; i++) {
    const w = (lv[i] << 8) & 0xffff;
    LV16[i] = (w & 0xff00) === 0x100 ? 1 : w;
  }
  return LV16;
}

