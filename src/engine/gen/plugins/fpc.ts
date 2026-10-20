// FPC (FL: FPC): a port of FL 2026's FPC_x64.dylib voice engine
// (docs/research/gen/fpc.md), in its single / double precision and operation order:
//
// - TriggerVoice: velocity = round(FPV_GetVelocity x 128) clamped to 127; every pad on
//   the note's key (not muted, or soloed while a solo is active) plays its layers whose
//   velocity range holds it (lo <= v < hi, hi 127 also takes 127), or one of the
//   overlapping ones (Random, Random avoid previous, Cycle, Cycle backward: FL's
//   Mersenne Twister). New pad voices cut the sounding pad voices whose cut-by group is
//   their cut group (not those started at the same instant).
// - Gains: pad and layer volumes (21.527^(v / 127) - 1) / 10 in single precision, three
//   ComputeLRVol pan laws (pad, layer + pan envelope, the note's FinalLevels) multiplied
//   with the volume envelope; without "scale volume with velocity" the note's InitLevels
//   volume is divided out. Updated every control period (48 samples at 44.1 kHz) and
//   ramped linearly over it; cut voices and finished envelopes ramp to 0 and stop.
// - Pitch: FinalLevels pitch + 100 (60 - key) + 9.375 x (pad + layer tune) cents and the
//   sample's rate ratio; FL's resampler (./fpc/resampler.ts); the voice ends with its sample.
// - Note offs only release the envelopes; samples play to their end (one shot).
// - Outputs: each pad voice mixes into the buffer of its output offset; offset 0 is the
//   channel's track, others go to mixer track (channel track + offset) via ctx.out.
// - Voice lists keep FL's order (unordered TList deletes move the last item into the
//   hole) and render from the last to the first, as FL sums them.

import type { GenContext, GenEnv, GenInstance, GenModule, GenNote } from '../types';
import type { FxMonitor } from '../../effects/types';
import type { InterpMode } from '../../../model/sampler';
import {
  FPC_ENV_KEYS, FPC_PADS_N, fpcEmptyPad, fpcKey, fpcNormPad, type FpcLayer, type FpcPad,
} from '../../../model/gen/plugins/fpc/state';
import { flLRVol } from './drumpad/voice';
import { FlResampler, ResScratch, roundEven } from './fpc/resampler';
import { EnvShape, EnvState } from './fpc/envelope';
import { mixConst, mixRamp, addBuf } from './fpc/mix';
import { Mt19937 } from './fpc/mt';

const f32 = Math.fround;
const MAX_SV = 256;
const MAX_PV = 256;
const MAX_LV = 512;
const MAX_EVENTS = 512;
const MAX_FRAMES = 8192;
/** (11^1.28 - 1) as FL's single-precision constant, + 1 (the volume curve's base). */
const VOL_BASE = f32(f32(20.526958465576172) + 1);
const LN_VOL_BASE = Math.log(VOL_BASE);
const INV128 = 0.0078125;
/** 2^-32 as FL's single-precision constant (FL's random draw: float(u32) x 2^-32). */
const RND_SCALE = f32(2.3283064365386963e-10);

/** FL's layer / pad volume curve (single precision result). */
export function fpcVolGain(v: number): number {
  const x = f32(v / 127);
  return f32(f32(Math.exp(LN_VOL_BASE * x) - 1) / 10);
}

interface Sample { L: Float32Array; R: Float32Array | null; rate: number }

class LayerVoice {
  pv: PadVoice | null = null;
  res: FlResampler;
  rate = 44100;
  gain = 0;
  pan = 0;
  tune = 0;
  vel = true;
  finished = false;
  counter = 0;
  tL = 1; tR = 1; cL = -1; cR = -1; sL = 1; sR = 1;
  envGain = 1;
  panOfs = 0;
  vOn = false; pOn = false;
  readonly vs = new EnvState();
  readonly ps = new EnvState();
  layer = 0;
  constructor(sc: ResScratch) { this.res = new FlResampler(sc); }
}

class PadVoice {
  sv: SuperVoice | null = null;
  pad = 0;
  gain = 0;
  pan = 0;
  out = 0;
  cut = false;
  fresh = true;
  readonly lv: LayerVoice[] = [];
}

class SuperVoice {
  /** The note while the channel holds it; its levels are copied at the note off (the channel reuses the object). */
  note: GenNote | null = null;
  readonly pv: PadVoice[] = [];
  pitchOfs = 0;
  killed = false;
  /** FL's voice tag (a host voice): freed through the host's Voice_Kill after the render. */
  tagged = false;
  pitch = 0; vol = 1; pan = 0; ivol = 1;
}

class OutBuf {
  idx = 0;
  L = new Float32Array(MAX_FRAMES);
  R = new Float32Array(MAX_FRAMES);
  /** Accumulated block for a routed output (offset != 0). */
  bL = new Float32Array(MAX_FRAMES);
  bR = new Float32Array(MAX_FRAMES);
  usedBlock = false;
}

/** A pad's settings as the engine reads them. */
interface PadRt {
  pad: FpcPad;
  /** The state object the pad was normalised from (immer keeps unchanged pads). */
  src: unknown;
  vol: number; pan: number; mute: boolean; solo: boolean; tune: number;
  venv: EnvShape; penv: EnvShape;
  /** Per layer: the sample (null = none / missing). */
  smp: (Sample | null)[];
  /** FL's +0x49: the last layer played (random modes). */
  last: number;
  blocked: boolean;
}

class Fpc implements GenInstance {
  private readonly sr: number;
  private readonly env: GenEnv;
  private readonly sc = new ResScratch(MAX_FRAMES);
  /** FL's control period (self + 0x130) and envelope step per tick. */
  private readonly period: number;
  private readonly envInc: number;
  private readonly pads: PadRt[] = [];
  private readonly mt = new Mt19937(5489);
  /** Interpolation half width (FL's FPD_ProcessMode bits 8..23). */
  private quality = 12;
  // voices: FL's pooled lists
  private readonly svs: SuperVoice[] = [];
  private svUsed = 0;
  private readonly lvFree: LayerVoice[] = [];
  private readonly pvFree: PadVoice[] = [];
  private readonly kills: SuperVoice[] = [];
  private nKills = 0;
  // outputs in order of first use (FL's per-output buffer list)
  private readonly outs: OutBuf[] = [];
  private outUsed = 0;
  private readonly tmpL = new Float32Array(MAX_FRAMES);
  private readonly tmpR = new Float32Array(MAX_FRAMES);
  private readonly lr = { l: 0, r: 0 };
  // events
  private readonly evFrame = new Int32Array(MAX_EVENTS);
  private readonly evNote: (GenNote | null)[] = new Array(MAX_EVENTS).fill(null);
  private readonly evOn = new Uint8Array(MAX_EVENTS);
  private evCount = 0;
  private readonly revCache = new Map<string, Sample>();
  private readonly flash = new Uint8Array(FPC_PADS_N);
  private readonly adsr = new Float64Array(8);
  /** Scratch: the pad voices a note creates (FL's local list). */
  private readonly newPv: PadVoice[] = [];

  constructor(sr: number, env: GenEnv) {
    this.sr = sr;
    this.env = env;
    // FL 0x5b900 with 48: period = max(4, 4 round(sr 48 / 44100 / 4)); envelope step = period x 2 / sr (FL's double chain)
    const t1 = (sr * 48) / 44100;
    let p = roundEven(t1 * 0.25) * 4;
    if (p < 4) p = 4;
    this.period = p;
    const t2 = (p * 48) / (t1 * 96);
    this.envInc = ((t2 * 96) / 44100) * 2;
    for (let i = 0; i < MAX_LV; i++) this.lvFree.push(new LayerVoice(this.sc));
    for (let i = 0; i < MAX_PV; i++) this.pvFree.push(new PadVoice());
    for (let k = 0; k < FPC_PADS_N; k++) {
      const pad = fpcEmptyPad(60 + (k & 15));
      const v = new EnvShape(false), pe = new EnvShape(true);
      v.inc = pe.inc = this.envInc;
      this.pads.push({ pad, src: null, vol: 127, pan: 0, mute: false, solo: false, tune: 0, venv: v, penv: pe, smp: [null], last: -1, blocked: false });
    }
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    const pads = Array.isArray(q.pads) ? q.pads : [];
    const n = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
    for (let k = 0; k < FPC_PADS_N; k++) {
      const rt = this.pads[k];
      const src = pads[k] as FpcPad | undefined;
      if (src && src !== rt.src) {
        rt.src = src;
        rt.pad = fpcNormPad(src, k);
        rt.smp = rt.pad.layers.map((l) => this.sampleOf(l));
      } else {
        // samples the pool delivers later
        const ls = rt.pad.layers;
        for (let i = 0; i < ls.length; i++) if (ls[i].sample && !rt.smp[i]) rt.smp[i] = this.sampleOf(ls[i]);
      }
      rt.vol = Math.round(n(q[fpcKey('vol', k)], 127));
      rt.pan = Math.round(n(q[fpcKey('pan', k)], 0));
      rt.mute = n(q[fpcKey('mute', k)], 0) >= 0.5;
      rt.solo = n(q[fpcKey('solo', k)], 0) >= 0.5;
      rt.tune = Math.round(n(q[fpcKey('tune', k)], 0));
      const adsr = this.adsr;
      for (let j = 0; j < 8; j++) { const e = FPC_ENV_KEYS[j]; adsr[j] = Math.round(n(q[fpcKey(e, k)], e.endsWith('s') ? 0 : 128)); }
      rt.venv.set(rt.pad.venv, adsr.subarray(0, 4));
      rt.penv.set(rt.pad.penv, adsr.subarray(4));
    }
  }

  private sampleOf(l: FpcLayer): Sample | null {
    if (!l.sample) return null;
    const s = this.env.sample(l.sample);
    if (!s || !s.channels.length || !s.channels[0].length) return null;
    const L = s.channels[0], R = s.channels.length > 1 ? s.channels[1] : null;
    if (!l.rev) return { L, R, rate: s.sampleRate };
    const key = l.sample;
    let r = this.revCache.get(key);
    if (!r || r.L.length !== L.length) {
      const rl = L.slice().reverse(), rr = R ? R.slice().reverse() : null;
      r = { L: rl, R: rr, rate: s.sampleRate };
      this.revCache.set(key, r);
    }
    return r;
  }

  /** The interpolation setting as FL's half width (1 linear, 3 hermite, 12 = 24-point sinc, ...). */
  setQuality(halfWidth: number): void { this.quality = halfWidth; }

  /** The project's resampling quality: FL sends its setting's half width (FL's table: 1, 3, 12, 32, 64, 128, 256). */
  setInterpolation(m: InterpMode): void {
    this.quality = m === 'linear' ? 1 : m === 'hermite6' ? 3 : m === 'sinc24' ? 12 : m === 'sinc64' ? 32 : m === 'sinc128' ? 64 : m === 'sinc256' ? 128 : 256;
  }

  reset(): void {
    while (this.svUsed > 0) this.freeSv(this.svs[this.svUsed - 1]);
    this.evCount = 0; this.evNote.fill(null);
    for (const rt of this.pads) rt.last = -1;
  }

  allNotesOff(): void { this.reset(); }

  noteOn(note: GenNote, frameOffset: number): void { this.queue(note, frameOffset, 1); }
  noteOff(note: GenNote, frameOffset: number): void { this.queue(note, frameOffset, 0); }
  killNote(note: GenNote): void {
    for (let i = 0; i < this.evCount; i++) if (this.evNote[i] === note && this.evOn[i] === 1) this.evNote[i] = null;
    const sv = this.findSv(note);
    if (sv) { sv.killed = true; this.freeSv(sv); }
  }

  isActive(): boolean { return this.svUsed > 0 || this.evCount > 0; }

  private queue(note: GenNote, frame: number, on: number): void {
    if (this.evCount >= MAX_EVENTS) return;
    this.evFrame[this.evCount] = frame; this.evNote[this.evCount] = note; this.evOn[this.evCount++] = on;
  }

  private findSv(note: GenNote): SuperVoice | null {
    for (let i = 0; i < this.svUsed; i++) if (this.svs[i].note === note) return this.svs[i];
    return null;
  }

  // ------------------------------------------------------------ voices

  /** FL's random layer choice (0x526b0) among the layers first..last that hold the velocity; -1 = none. */
  private randomLayer(k: number, vel: number, first: number, last: number): number {
    const rt = this.pads[k];
    const cand = this.sc.idx; // scratch (the positions are rebuilt by every render)
    let n = 0, pos = -1;
    for (let i = first; i <= last; i++) {
      const l = rt.pad.layers[i];
      if (vel < l.lo) continue;
      if (!(l.hi > vel || (vel === 127 && l.hi === 127))) continue;
      cand[n] = i;
      if (i === rt.last) pos = n;
      n++;
    }
    if (n === 1) pos = 0;
    else if (n > 0) {
      const mode = rt.pad.rmode;
      if (mode === 0) pos = Math.trunc(f32(f32(f32(this.mt.next()) * RND_SCALE) * f32(n)));
      else if (mode === 1) {
        let r = Math.trunc(f32(f32(f32(this.mt.next()) * RND_SCALE) * f32(n - 1)));
        if (pos <= r && pos >= 0 && n - 1 > pos) r++;
        pos = r;
      } else if (mode === 2) { pos--; if (pos < 0) pos = n - 1; }
      else if (mode === 3) { pos++; if (pos >= n) pos = 0; }
      if (pos >= n) pos = n - 1; // (FL reads past its list when the float draw rounds up to 1)
    }
    if (pos < 0) return -1;
    rt.last = cand[pos];
    return rt.last;
  }

  /** FL's TriggerVoice + voice creation (0x604b0, 0x62dc0). */
  private trigger(note: GenNote): void {
    const vel = Math.min(127, Math.max(0, roundEven(note.velocity)));
    const key = Math.max(0, Math.min(131, Math.trunc(note.key)));
    let solo = false;
    for (const rt of this.pads) if (rt.solo) solo = true;
    let any = false;
    for (const rt of this.pads) {
      if (rt.pad.key !== key) continue;
      rt.blocked = (rt.mute && !rt.solo) || (solo && !rt.solo);
      if (!rt.blocked) any = true;
    }
    if (!any || this.svUsed >= MAX_SV) return;
    const newPv = this.newPv;
    newPv.length = 0;
    for (let k = 0; k < FPC_PADS_N; k++) {
      const rt = this.pads[k];
      if (rt.pad.key !== key) continue;
      let first = 0, last = rt.pad.layers.length - 1;
      if (rt.pad.random && first < last) {
        const r = this.randomLayer(k, vel, first, last);
        if (r >= 0) first = last = r;
      }
      let pv: PadVoice | null = null;
      for (let i = first; i <= last; i++) {
        const l = rt.pad.layers[i];
        if (vel < l.lo || !(l.hi > vel || (vel === 127 && l.hi === 127))) continue;
        const smp = rt.smp[i];
        if (!smp || rt.blocked) continue;
        const lv = this.lvFree.pop();
        if (!lv) break;
        if (!pv) {
          pv = this.pvFree.pop() ?? null;
          if (!pv) { this.lvFree.push(lv); break; }
          pv.lv.length = 0;
        }
        this.initLayer(lv, rt, l, smp, i, note);
        lv.pv = pv;
        pv.lv.push(lv);
      }
      if (!pv) continue;
      pv.gain = fpcVolGain(rt.vol);
      pv.pan = rt.pan;
      pv.pad = k;
      pv.cut = false;
      pv.out = rt.pad.out;
      pv.fresh = true;
      this.flash[k] = 1;
      newPv.push(pv);
    }
    if (!newPv.length) return;
    // cut groups: sounding pad voices cut by the new pads' groups
    for (let s = 0; s < this.svUsed; s++) {
      const sv = this.svs[s];
      for (const pv of sv.pv) {
        if (pv.cut) continue;
        const by = this.pads[pv.pad].pad.cutBy;
        for (const np of newPv) {
          if (by === this.pads[np.pad].pad.cut && by !== -1 && !pv.fresh) { pv.cut = true; break; }
        }
      }
    }
    let sv: SuperVoice;
    if (this.svs.length > this.svUsed) sv = this.svs[this.svUsed];
    else { sv = new SuperVoice(); this.svs.push(sv); }
    this.svUsed++;
    sv.note = note;
    sv.tagged = true;
    sv.killed = false;
    sv.pv.length = 0;
    for (const pv of newPv) { pv.sv = sv; sv.pv.push(pv); }
    sv.pitchOfs = (60 - key) * 100;
  }

  private initLayer(lv: LayerVoice, rt: PadRt, l: FpcLayer, smp: Sample, i: number, note: GenNote): void {
    lv.gain = fpcVolGain(l.vol);
    lv.vel = l.vel;
    lv.tL = 1; lv.tR = 1; lv.cL = -1; lv.cR = -1; lv.sL = 1; lv.sR = 1;
    lv.pan = l.pan;
    lv.tune = f32((l.tune + rt.tune) * 9.375);
    lv.layer = i;
    lv.rate = smp.rate;
    lv.res.setQuality(this.quality);
    lv.res.setSample(smp.L, smp.R, 0, -1);
    lv.vOn = false; lv.pOn = false;
    lv.counter = -this.period;
    lv.envGain = 1;
    lv.panOfs = 0;
    lv.finished = false;
    if (rt.venv.on) { rt.venv.noteOn(lv.vs); lv.vOn = true; lv.envGain = lv.vs.value; }
    if (rt.penv.on) { rt.penv.noteOn(lv.ps); lv.pOn = true; lv.panOfs = f32(2 * lv.ps.value); }
    void note;
  }

  private freeLv(pv: PadVoice, idx: number): void {
    const lv = pv.lv[idx];
    const last = pv.lv.length - 1;
    if (idx < last) pv.lv[idx] = pv.lv[last];
    pv.lv.length = last;
    lv.pv = null;
    this.lvFree.push(lv);
  }

  private freePv(sv: SuperVoice, idx: number): void {
    const pv = sv.pv[idx];
    const last = sv.pv.length - 1;
    if (idx < last) sv.pv[idx] = sv.pv[last];
    sv.pv.length = last;
    for (let i = pv.lv.length - 1; i >= 0; i--) this.freeLv(pv, i);
    pv.sv = null;
    this.pvFree.push(pv);
  }

  /** FL's 0x54220: free a super voice and recycle its slot (the last active one moves into its place). */
  private freeSv(sv: SuperVoice): void {
    const i = this.svs.indexOf(sv);
    if (i < 0 || i >= this.svUsed) return;
    for (let p = sv.pv.length - 1; p >= 0; p--) this.freePv(sv, p);
    sv.note = null;
    sv.tagged = false;
    this.svUsed--;
    if (i < this.svUsed) { this.svs[i] = this.svs[this.svUsed]; this.svs[this.svUsed] = sv; }
  }

  private release(note: GenNote): void {
    const sv = this.findSv(note);
    if (!sv) return;
    // the channel frees its note at the note off: keep the levels the voice reached
    sv.pitch = f32(note.levels.pitch - 6000); sv.vol = f32(note.levels.vol); sv.pan = f32(note.levels.pan); sv.ivol = f32(note.init.vol);
    sv.note = null;
    for (const pv of sv.pv) {
      const rt = this.pads[pv.pad];
      for (const lv of pv.lv) {
        if (rt.venv.on) rt.venv.release(lv.vs);
        if (rt.penv.on) rt.penv.release(lv.ps);
      }
    }
  }

  // ------------------------------------------------------------ render

  private outBuf(idx: number, n: number): OutBuf {
    for (let i = 0; i < this.outUsed; i++) if (this.outs[i].idx === idx) return this.outs[i];
    let b: OutBuf;
    if (this.outs.length > this.outUsed) b = this.outs[this.outUsed];
    else { b = new OutBuf(); this.outs.push(b); }
    this.outUsed++;
    b.idx = idx;
    b.L.fill(0, 0, n); b.R.fill(0, 0, n);
    return b;
  }

  /** FL's pad voice render (0x61040): every layer voice from the last, into the output buffer. */
  private renderPad(pv: PadVoice, b: OutBuf, n: number): void {
    const sv = pv.sv!;
    const note = sv.note;
    const P = this.period;
    const fp = note ? f32(note.levels.pitch - 6000) : sv.pitch;
    const fv = note ? f32(note.levels.vol) : sv.vol;
    const fpan = note ? f32(note.levels.pan) : sv.pan;
    const iv = note ? f32(note.init.vol) : sv.ivol;
    const rt = this.pads[pv.pad];
    for (let i = pv.lv.length - 1; i >= 0; i--) {
      const lv = pv.lv[i];
      const tL = this.tmpL, tR = this.tmpR;
      tL.fill(0, 0, n); tR.fill(0, 0, n);
      const cents = f32(f32(f32(sv.pitchOfs) + fp) + lv.tune);
      lv.res.setPitch(cents, lv.rate * (1 / this.sr));
      const got = lv.res.render(tL, tR, n);
      let rem = got, o = 0;
      do {
        if (lv.counter <= 0) {
          lv.counter = P;
          if (lv.vOn) {
            lv.envGain = lv.vs.value;
            rt.venv.tick(lv.vs, 1);
            if (lv.vs.stage >= 9) lv.finished = lv.ps.stage >= 9 || !lv.pOn;
          }
          if (lv.pOn) {
            lv.panOfs = f32(2 * lv.ps.value);
            rt.penv.tick(lv.ps, 1);
          }
          let pan = f32(lv.panOfs + lv.pan * INV128);
          pan = pan < -1 ? -1 : pan > 1 ? 1 : pan;
          flLRVol(f32(pv.pan * INV128), pv.gain, this.lr);
          const pl = this.lr.l, pr = this.lr.r;
          flLRVol(pan, lv.gain, this.lr);
          const ll = this.lr.l, lr = this.lr.r;
          flLRVol(fpan, fv, this.lr);
          let gl = f32(f32(f32(this.lr.l * pl) * ll) * lv.envGain);
          let gr = f32(f32(f32(this.lr.r * pr) * lr) * lv.envGain);
          if (!lv.vel && iv !== 0) { gl = f32(gl / iv); gr = f32(gr / iv); }
          lv.tL = gl; lv.tR = gr;
          if (lv.cL === -1) { lv.cL = gl; lv.cR = gr; }
          if (pv.cut || lv.finished) { lv.tL = 0; lv.tR = 0; }
          lv.sL = P === 0 ? 0 : f32(f32(lv.tL - lv.cL) / P);
          lv.sR = P === 0 ? 0 : f32(f32(lv.tR - lv.cR) / P);
        }
        const m = rem < lv.counter ? rem : lv.counter;
        if (lv.sL === 0 && !Object.is(lv.sL, -0)) mixConst(tL, tR, o, b.L, b.R, o, m, lv.tL, lv.tR);
        else {
          mixRamp(tL, tR, o, b.L, b.R, o, m, lv.cL, lv.cR, lv.sL, lv.sR);
          lv.cL = f32(lv.cL + f32(m * lv.sL));
          lv.cR = f32(lv.cR + f32(m * lv.sR));
        }
        o += m; rem -= m; lv.counter -= m;
      } while (rem > 0);
      if (lv.res.ended()) this.freeLv(pv, i);
      else if ((pv.cut || lv.finished) && lv.cL === 0 && !Object.is(lv.cL, -0) && lv.cR === 0 && !Object.is(lv.cR, -0)) this.freeLv(pv, i);
    }
  }

  /** One of FL's Gen_Render calls: n frames into the outputs at block offset `off`. */
  private segment(L: Float32Array, R: Float32Array, off: number, n: number): void {
    this.outUsed = 0;
    for (let s = this.svUsed - 1; s >= 0; s--) {
      const sv = this.svs[s];
      for (let p = sv.pv.length - 1; p >= 0; p--) {
        const pv = sv.pv[p];
        pv.fresh = false;
        const b = this.outBuf(pv.out, n);
        this.renderPad(pv, b, n);
        if (pv.lv.length === 0) this.freePv(sv, p);
      }
      if (sv.pv.length === 0) {
        if (!sv.tagged) this.freeSv(sv);
        else if (!sv.killed) { sv.killed = true; if (this.nKills < MAX_SV) this.kills[this.nKills++] = sv; }
      }
    }
    // the host's Voice_Kill call-backs follow the render
    for (let i = 0; i < this.nKills; i++) this.freeSv(this.kills[i]);
    this.nKills = 0;
    for (let i = 0; i < this.outUsed; i++) {
      const b = this.outs[i];
      if (b.idx === 0) {
        for (let j = 0; j < n; j++) { L[off + j] = f32(L[off + j] + b.L[j]); R[off + j] = f32(R[off + j] + b.R[j]); }
      } else {
        if (!b.usedBlock) { b.usedBlock = true; b.bL.fill(0); b.bR.fill(0); }
        for (let j = 0; j < n; j++) { b.bL[off + j] = f32(b.bL[off + j] + b.L[j]); b.bR[off + j] = f32(b.bR[off + j] + b.R[j]); }
      }
    }
  }

  private event(e: number): void {
    const note = this.evNote[e];
    if (!note) return;
    if (this.evOn[e]) this.trigger(note); else this.release(note);
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    let e = 0, i = 0;
    while (i < n) {
      while (e < this.evCount && this.evFrame[e] <= i) this.event(e++);
      let end = n;
      if (e < this.evCount && this.evFrame[e] < n) end = this.evFrame[e];
      if (end > i) this.segment(L, R, i, Math.min(end - i, MAX_FRAMES));
      i = end;
    }
    while (e < this.evCount) this.event(e++);
    this.evCount = 0;
    this.evNote.fill(null);
    for (const b of this.outs) {
      if (!b.usedBlock) continue;
      b.usedBlock = false;
      const track = Math.max(0, Math.min(500, ctx.track + b.idx));
      if (ctx.out) ctx.out(track, b.bL, b.bR, n);
      else addBuf(b.bL, b.bR, L, R, n);
    }
  }

  monitor(): FxMonitor {
    const lit: number[] = [];
    for (let k = 0; k < FPC_PADS_N; k++) { lit.push(this.flash[k]); this.flash[k] = 0; }
    const playing: number[] = new Array(FPC_PADS_N).fill(0);
    for (let s = 0; s < this.svUsed; s++) for (const pv of this.svs[s].pv) playing[pv.pad] = 1;
    return { hit: lit, pads: playing };
  }
}

export const gen: GenModule = {
  id: 'fpc',
  create: (sampleRate: number, _blockSize: number, env: GenEnv) => new Fpc(sampleRate, env),
};
