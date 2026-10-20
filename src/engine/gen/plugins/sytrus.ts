// Sytrus (FL: Sytrus) engine: FL's Gen_Render instrument with its own voices
// ('events'), ported from Sytrus_x64 (docs/research/gen/sytrus.md): per note
// up to 9 unison voices (x2 with SUB), each with six table operators (FM /
// RM matrix, noise, pluck), three filters and articulators evaluated every
// control tick; the voices mix into a main bus and an FX bus; the FX bus goes
// through chorus, three delays and reverb into the main bus; EQ and global DC
// removal follow. With the patch's oversampling setting (live / render
// quality) the voices run at 2^n x the rate and FL's polyphase IIR halfband
// decimators bring the buses back down (the effects run at up to 4x).
//
// Each host block is split at note events like FL's host does, and every
// segment runs the whole Gen_Render (voices, global LFOs, effects).

import type { GenContext, GenInstance, GenModule, GenNote } from '../types';
import type { SyState } from '../../../model/gen/plugins/sytrus/types';
import { normalizeSy } from '../../../model/gen/plugins/sytrus/normalize';
import { compilePatch, type Patch, CENT_NP } from './sytrus/patch';
import { SyVoice, startVoice, releaseVoice, renderVoice, FpcRandom, type SyCtx, type VoiceLevels } from './sytrus/voice';
import { lfoIncrement, roundEven, type LfoShape } from './sytrus/env';
import { SyEffects } from './sytrus/fx';
import { svfTables } from './sytrus/filter';

const MAX_VOICES = 256;
const UNI_DETUNE = [
  [0.877, 1.069, 0.929, 1.181, 1.031, 1.129, 0.887, 1.117, 0.977],
  [0.877, 1.069, 0.929, 1.181, 1.031, 1.129, 0.887, 1.117, 0.977],
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
  [0.890472, 1.076426, 0.911577, 1.102536, 1.034126, 1.166861, 0.853971, 1.206273, 1.0],
];
const UNI_ENV = [0.9877, 1.0069, 0.9929, 1.0181, 1.0031, 1.0129, 0.9887, 1.0117, 0.9977];
const MAX_OS_LG = 5;
/** FL's halfband decimator coefficients (polyphase IIR, two 3-allpass branches; 0x1f60). */
const HB = [0.1473771136010466, 0.039151597734460045, 0.48246854276970014, 0.3026468483284934, 0.8830050257693731, 0.6746159185469639];
const TINY = 5.960464477539063e-8;

interface PendingEvent { kind: 0 | 1 | 2; note: GenNote; off: number }

/** One decimation stage (FL's 0xc0-byte TPolyphase stage, stereo). */
class Halfband {
  s = new Float64Array(24); // [L: a1y a2y a3y b1y b2y b3y a1x a2x a3x b1x b2x b3x, R: ...]
  reset(): void { this.s.fill(0); }
  /** 2n samples in -> n out (in place allowed). */
  run(x: Float32Array, y: Float32Array, n: number, ch: number): void {
    const s = this.s, o = ch * 12;
    let a1y = s[o], a2y = s[o + 1], a3y = s[o + 2], b1y = s[o + 3], b2y = s[o + 4], b3y = s[o + 5];
    let a1x = s[o + 6], a2x = s[o + 7], a3x = s[o + 8], b1x = s[o + 9], b2x = s[o + 10], b3x = s[o + 11];
    for (let i = 0; i < n; i++) {
      const x0 = x[2 * i], x1 = x[2 * i + 1];
      const a1 = (x0 - a1y) * HB[0] + a1x; a1x = x0; a1y = a1;
      const b1 = (x1 - b1y) * HB[1] + b1x; b1x = x1; b1y = b1;
      const a2 = (a1 - a2y) * HB[2] + a2x; a2x = a1; a2y = a2;
      const b2 = (b1 - b2y) * HB[3] + b2x; b2x = b1; b2y = b2;
      const a3 = (a2 - a3y) * HB[4] + a3x; a3x = a2; a3y = a3;
      const b3 = (b2 - b3y) * HB[5] + b3x; b3x = b2; b3y = b3;
      y[i] = Math.fround((a3 + b3) * 0.5);
    }
    const f = (v: number) => (Math.abs(v) < TINY ? 0 : v);
    s[o] = f(a1y); s[o + 1] = f(a2y); s[o + 2] = f(a3y); s[o + 3] = f(b1y); s[o + 4] = f(b2y); s[o + 5] = f(b3y);
    s[o + 6] = f(a1x); s[o + 7] = f(a2x); s[o + 8] = f(a3x); s[o + 9] = f(b1x); s[o + 10] = f(b2x); s[o + 11] = f(b3x);
  }
}

class Sytrus implements GenInstance {
  private readonly sr: number;
  private readonly bs: number;
  private patch: Patch | null = null;
  private params: Record<string, number> = {};
  private sy: SyState | null = null;
  private readonly voices: SyVoice[] = [];
  private readonly c: SyCtx;
  private readonly events: PendingEvent[] = [];
  private readonly noteVoices = new Map<number, SyVoice[]>();
  private readonly liveNotes = new Map<number, GenNote>();
  /** Global LFOs (flag 2): free-running shared phases (FL's TMLFO +0xa8, advanced per block in Gen_Render). */
  private readonly gLfo = new Map<number, { phase: number; inc: number }>();
  private fx: SyEffects;
  private age = 0;
  private tickFor = -1;
  /** Oversampling: log2 factor, voice rate, FX rate. */
  private osLg = 0;
  private rateV: number;
  private rateF: number;
  private readonly decMain: Halfband[] = [];
  private readonly decFx: Halfband[] = [];
  private cLpL = 0; private cVelL = 0; private cLpR = 0; private cVelR = 0;
  tail = 0.2;

  constructor(sampleRate: number, blockSize: number) {
    this.sr = sampleRate;
    this.rateV = sampleRate;
    this.rateF = sampleRate;
    this.bs = Math.max(blockSize, 128);
    // the pool grows on demand up to MAX_VOICES (most patches never need more than a few dozen)
    for (let i = 0; i < 16; i++) this.voices.push(new SyVoice());
    for (let i = 0; i < MAX_OS_LG; i++) { this.decMain.push(new Halfband()); this.decFx.push(new Halfband()); }
    const big = this.bs << MAX_OS_LG;
    this.c = {
      sampleRate, patch: null as unknown as Patch, tick: 96, unitAbs: 0, unitTempo: 0,
      maxGainStep: 0, maxParamStep: 0, smooth: 0.95, rendering: false,
      rng: { s: 0 }, random: new FpcRandom(), globalPhase: 0,
      osFactor: 1, svf: svfTables(sampleRate), declickLen: 96, dcK: 0,
      globalLfo: (u, a, shape, ph, speed, unit) => this.globalLfo(u, a, shape, ph, speed, unit),
      outL: new Float32Array(big), outR: new Float32Array(big), fxL: new Float32Array(big), fxR: new Float32Array(big),
    };
    this.setRates(0);
    this.fx = new SyEffects(this.rateF, this.bs << 2);
    this.setParams({});
  }

  /** Rates for an oversampling setting (FL's 0x71aa0 / 0x718d0); constants of the voice renderer. */
  private setRates(lg: number): void {
    this.osLg = lg;
    const os = 1 << lg;
    this.rateV = this.sr * os;
    this.rateF = this.sr * Math.min(os, 4);
    const c = this.c, r = this.rateV;
    c.sampleRate = r;
    c.osFactor = 1;
    c.svf = svfTables(r);
    c.maxGainStep = Math.fround(0.001 * (44100 / r));
    c.maxParamStep = Math.fround(c.maxGainStep * 10);
    c.declickLen = Math.fround(96 / ((44100 / r) * (44100 / r)));
    c.dcK = Math.fround(2.2835e-5 * (44100 / r));
    for (const h of this.decMain) h.reset();
    for (const h of this.decFx) h.reset();
    this.tickFor = -1;
  }

  setParams(raw: unknown): void {
    const p = (raw ?? {}) as Record<string, unknown>;
    const params: Record<string, number> = {};
    for (const [k, v] of Object.entries(p)) if (typeof v === 'number') params[k] = v;
    this.params = params;
    this.sy = normalizeSy(p.sy);
    this.compile(this.c.rendering);
  }

  private compile(rendering: boolean): void {
    const sy = this.sy!;
    const lg = Math.max(0, Math.min(MAX_OS_LG, (rendering ? sy.g.rqOver : sy.g.dqOver) | 0));
    if (lg !== this.osLg || !this.patch) {
      const rateFOld = this.rateF;
      this.setRates(lg);
      if (this.rateF !== rateFOld && this.fx) this.fx = new SyEffects(this.rateF, this.bs << 2);
    }
    this.patch = compilePatch(this.params, sy, this.rateV);
    this.c.patch = this.patch;
    if (!this.patch.porta) this.lastPitch = NaN; // FL forgets the last note when PORTA is off (0x76300)
    this.tickFor = -1;
    this.fx.setPatch(this.patch, 1 << this.osLg);
    this.tail = this.fx.tailSeconds();
  }

  private setupTick(rendering: boolean, tempo: number): void {
    if (rendering !== this.c.rendering) {
      this.c.rendering = rendering;
      const sy = this.sy!;
      if ((sy.g.rqOver | 0) !== (sy.g.dqOver | 0)) this.compile(rendering);
    }
    const P = this.patch!;
    const hq = rendering ? P.g.rqEnv : P.g.dqEnv;
    const key = (hq ? 1 : 0) + (rendering ? 2 : 0) + tempo * 4 + this.osLg * 1e9;
    if (key === this.tickFor) return;
    this.tickFor = key;
    const r = this.rateV;
    const base = hq ? 8 : 96;
    const tick = Math.max(4, roundEven(((r * base) / 44100) * 0.25) * 4);
    const c = this.c;
    c.tick = tick;
    const tickSec = tick / r;
    c.unitAbs = tickSec * 2;
    c.unitTempo = (tickSec * tempo) / 60;
    // Mod X / Y smoothing per tick (FL's plug +0x43c)
    const t62e0 = (tick * 44100) / (r * 96);
    c.smooth = Math.fround(Math.exp((-4.605170185988091 * t62e0) / 96));
  }

  noteOn(note: GenNote, frameOffset: number): void {
    this.events.push({ kind: 0, note, off: frameOffset });
  }

  noteOff(note: GenNote, frameOffset: number): void {
    this.events.push({ kind: 1, note, off: frameOffset });
  }

  killNote(note: GenNote): void {
    this.events.push({ kind: 2, note, off: 0 });
  }

  isActive(): boolean {
    for (const v of this.voices) if (!v.free) return true;
    return this.fx.active();
  }

  /** Pitch of the last note in cents (portamento start; NaN = none yet). */
  private lastPitch = NaN;
  /** Voices FL renders itself, in trigger order (OSC unison: the masters only); newest first (0x82548), each for the whole block. */
  private playing: SyVoice[] = [];

  allNotesOff(): void {
    this.lastPitch = NaN;
    for (const v of this.voices) { v.free = true; v.links.length = 0; v.master = null; }
    this.playing.length = 0;
    this.noteVoices.clear();
    this.liveNotes.clear();
    this.events.length = 0;
    this.fx.reset();
    for (const h of this.decMain) h.reset();
    for (const h of this.decFx) h.reset();
  }

  reset(): void {
    this.allNotesOff();
  }

  private allocVoice(): SyVoice {
    let best: SyVoice | null = null;
    for (const v of this.voices) {
      if (v.free) return v;
      if (!best || v.age < best.age) best = v;
    }
    if (this.voices.length < MAX_VOICES) {
      const v = new SyVoice();
      this.voices.push(v);
      return v;
    }
    // steal the oldest
    this.dropVoice(best!);
    best!.free = true;
    return best!;
  }

  /** Unlink a voice that is reused (its master's chain, the playing list, its note's list). */
  private dropVoice(v: SyVoice): void {
    const drop = (x: SyVoice) => {
      for (const [id, list] of this.noteVoices) {
        const i = list.indexOf(x);
        if (i >= 0) { list.splice(i, 1); if (!list.length) this.noteVoices.delete(id); }
      }
    };
    if (v.master) {
      const l = v.master.links, i = l.indexOf(v);
      if (i >= 0) l.splice(i, 1);
      v.master = null;
    } else {
      for (const x of v.links) { x.free = true; x.master = null; drop(x); }
      v.links.length = 0;
      const i = this.playing.indexOf(v);
      if (i >= 0) this.playing.splice(i, 1);
    }
    drop(v);
  }

  private startNote(note: GenNote): void {
    const P = this.patch!;
    const g = P.g;
    const lv: VoiceLevels = {
      pan: note.levels.pan, vol: note.levels.vol, pitch: note.levels.pitch - 6000, fcut: note.levels.fcut, fres: note.levels.fres,
    };
    if (!g.velVol && note.init.vol > 0) lv.vol = note.levels.vol / note.init.vol;
    const vel = note.velocity / 128;
    // portamento from the previous note's pitch (TriggerVoice 0x79828; FL's "porta" note flag is not used)
    const notePitch = Math.fround(lv.pitch + P.masterPitch);
    let porta: { diff: number; keyPitch: number } | null = null;
    if (P.porta && !Number.isNaN(this.lastPitch)) {
      porta = { diff: Math.fround(this.lastPitch - notePitch), keyPitch: g.portaTrack ? this.lastPitch : notePitch };
    }
    this.lastPitch = notePitch;
    if (g.monoKey) {
      const key = roundEven(Math.max(0, (lv.pitch + P.masterPitch) * 0.01 + 60));
      for (const v of this.voices) if (!v.free && v.key === key && !v.released) releaseVoice(v, this.c, 1);
    }
    const u = P.uni;
    const order = u.order;
    const dist = g.uniDist;
    const s10 = dist === 0
      ? Math.fround(Math.fround(Math.exp(Math.fround(u.pitch * 0.00390625) * 2.3978952727983707) - 1) * 5 * CENT_NP)
      : Math.fround(Math.fround(Math.exp(Math.fround(u.pitch * 0.00390625) * 3.713572066704308) - 1) * 1.875 * CENT_NP);
    const s9 = Math.fround(u.phase * 0.0078125), s11 = Math.fround(u.vol * 0.0078125);
    let s12 = Math.fround(1 / order);
    if (order > 1) s12 = Math.fround(1 - Math.fround(Math.exp((1 - s12) * 1.0986122886681098) - 1) * 0.5);
    const vols = [s12, 0];
    if (u.sub !== 0) { const sb = Math.fround(u.sub * 0.0078125); vols[0] = Math.fround(s12 * (1 - sb)); vols[1] = Math.fround(s12 * sb); }
    const groups = u.sub !== 0 ? 2 : 1;
    const list: SyVoice[] = [];
    // OSC unison (0x79c98): the note's voices sum their operators into the first voice, which alone
    // runs the filters and the output (centred, at unison volume 1)
    const osc = !!g.oscUni && (order > 1 || u.sub !== 0);
    let master: SyVoice | null = null;
    for (let gi = 0; gi < groups; gi++) {
      for (let i = 0; i < order; i++) {
        const v = this.allocVoice();
        const v54 = vols[gi];
        let pan = 0.5, uvol = v54, pitchMul = 1, phase = 0, pos = 0.5, envVar = 1 / 128;
        if (order > 1) {
          phase = Math.fround(Math.fround(i / order) * s9);
          pos = Math.fround(i / (order - 1));
          let sp = Math.fround(pos * 2 - 1);
          const panPos = osc ? 0 : Math.fround(sp * 0.00390625);
          pan = Math.fround(0.5 + panPos * u.pan);
          sp = Math.abs(sp);
          const v58 = dist > 0 && order === 2 ? v54 : Math.fround(v54 * 2 * (1 - sp));
          uvol = Math.fround(v54 * s11 + v58 * (1 - s11));
          if (i & 1) sp = -sp;
          if (dist > 0 && (order & 1) && i * 2 > order) sp = -sp;
          const k = (gi + i) % 9;
          const det = Math.fround(sp * UNI_DETUNE[dist][k]);
          pitchMul = Math.fround(Math.exp(det * s10));
          if (dist === 3) {
            let d = Math.fround(s9 * s9);
            d = d * d;
            let x = Math.fround(100000 * pitchMul) * d * d;
            if (gi > 0) x *= 0.5;
            phase = x - Math.trunc(x);
          }
          envVar = Math.fround(Math.fround(1 + Math.fround(Math.fround(Math.fround(Math.abs(sp) - 0.5) * u.env) * UNI_ENV[k]) * 0.0078125) * 0.0078125);
        }
        if (gi > 0) pitchMul *= 0.5;
        v.age = ++this.age;
        v.noteId = note.id;
        v.links.length = 0;
        v.master = null;
        v.oscGain = uvol;
        v.oscMode = 0;
        if (!osc) this.playing.push(v);
        else if (!master) {
          master = v;
          v.oscMode = 3;
          uvol = 1;
          this.playing.push(v);
        } else {
          // rendered by the master, chunk by chunk (0x81a94)
          v.master = master;
          v.oscMode = master.links.length === 0 ? 1 : 2;
          master.links.push(v);
        }
        startVoice(v, this.c, lv, vel, { pos, pan, vol: uvol, pitch: pitchMul, phase, envVar, sub: gi > 0 }, porta);
        v.liveLevels = { pan: lv.pan, vol: lv.vol, pitch: lv.pitch, fcut: lv.fcut, fres: lv.fres };
        list.push(v);
      }
    }
    this.noteVoices.set(note.id, list);
    this.liveNotes.set(note.id, note);
  }

  private globalLfo(u: number, a: number, shape: LfoShape, ph: number, speed: number, unit: number): number {
    const key = u * 8 + a;
    let g = this.gLfo.get(key);
    const inc = lfoIncrement(speed, unit);
    if (!g) { g = { phase: (shape.startPhase() + ph) >>> 0, inc }; this.gLfo.set(key, g); }
    g.inc = inc;
    return g.phase;
  }

  private endNote(note: GenNote, kill: boolean): void {
    const list = this.noteVoices.get(note.id);
    this.liveNotes.delete(note.id);
    if (!list) return;
    const relTime = 2 - (2 * (note.release ?? 64)) / 128;
    for (const v of list) {
      if (kill) { v.stage = 9; v.released = true; }
      else releaseVoice(v, this.c, relTime);
    }
    this.noteVoices.delete(note.id);
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    if (!this.patch) return;
    this.setupTick(!!ctx.rendering, ctx.tempo || 130);
    // live levels of held notes
    const P = this.patch;
    for (const [id, note] of this.liveNotes) {
      const list = this.noteVoices.get(id);
      if (!list) continue;
      let vol = note.levels.vol;
      if (!P.g.velVol && note.init.vol > 0) vol = note.levels.vol / note.init.vol;
      for (const v of list) {
        const l = v.liveLevels!;
        l.pan = note.levels.pan; l.vol = vol; l.fcut = note.levels.fcut; l.fres = note.levels.fres; l.pitch = note.levels.pitch - 6000;
      }
    }
    this.events.sort((a, b) => a.off - b.off);
    let pos = 0;
    let ei = 0;
    while (pos < n) {
      while (ei < this.events.length && this.events[ei].off <= pos) {
        const e = this.events[ei++];
        if (e.kind === 0) this.startNote(e.note);
        else this.endNote(e.note, e.kind === 2);
      }
      const end = ei < this.events.length ? Math.min(n, Math.max(pos + 1, this.events[ei].off)) : n;
      this.genRender(L, R, pos, end - pos, ctx);
      pos = end;
    }
    while (ei < this.events.length) {
      const e = this.events[ei++];
      if (e.kind === 0) this.startNote(e.note); else this.endNote(e.note, e.kind === 2);
    }
    this.events.length = 0;
  }

  /** FL's Gen_Render (0x823a0) for `len` frames written at `off`. */
  private genRender(L: Float32Array, R: Float32Array, off: number, len: number, ctx: GenContext): void {
    const c = this.c;
    const lg = this.osLg;
    const nV = len << lg;
    c.outL.fill(0, 0, nV); c.outR.fill(0, 0, nV); c.fxL.fill(0, 0, nV); c.fxR.fill(0, 0, nV);
    // FL counts the voices before rendering them (the FX countdown, 0x82488)
    let voices = 0;
    for (const v of this.voices) if (!v.free) voices++;
    // newest voice first; an OSC unison master renders its linked voices before itself, chunk by chunk
    for (let k = this.playing.length - 1; k >= 0; k--) {
      const v = this.playing[k];
      if (!renderVoice(v, c, 0, nV)) {
        v.free = true;
        for (const x of v.links) { x.free = true; x.master = null; }
        v.links.length = 0;
        this.playing.splice(k, 1);
      }
    }
    c.globalPhase += nV;
    if (this.gLfo.size) {
      const d8 = nV / c.tick;
      for (const g of this.gLfo.values()) g.phase = (g.phase + roundEven(d8 * g.inc)) >>> 0;
    }
    // decimate to the effects rate (at most 4x)
    const keep = Math.min(lg, 2);
    let n = nV;
    for (let st = lg - 1; st >= keep; st--) {
      n >>= 1;
      this.decMain[st].run(c.outL, c.outL, n, 0); this.decMain[st].run(c.outR, c.outR, n, 1);
      this.decFx[st].run(c.fxL, c.fxL, n, 0); this.decFx[st].run(c.fxR, c.fxR, n, 1);
    }
    let fxOn = false;
    for (let u = 0; u < 9; u++) if (this.patch!.uFx[u] !== 0) fxOn = true;
    this.fx.process(c.outL, c.outR, c.fxL, c.fxR, n, ctx, voices, fxOn);
    for (let st = keep - 1; st >= 0; st--) {
      n >>= 1;
      this.decMain[st].run(c.outL, c.outL, n, 0); this.decMain[st].run(c.outR, c.outR, n, 1);
    }
    // global CENTER (plug 0x6348): DC tracker subtracted, at the output rate
    if (this.patch!.g.gCenter) {
      const k = Math.fround(2.2835e-5 * (44100 / this.sr)), damp = 0.9599999785423279;
      let lp = this.cLpL, vel = this.cVelL;
      for (let i = 0; i < len; i++) { const x = c.outL[i]; vel += (x - lp) * k; lp += vel; vel *= damp; c.outL[i] = Math.fround(x - lp); }
      this.cLpL = Math.abs(lp) < TINY ? 0 : lp; this.cVelL = Math.abs(vel) < TINY ? 0 : vel;
      lp = this.cLpR; vel = this.cVelR;
      for (let i = 0; i < len; i++) { const x = c.outR[i]; vel += (x - lp) * k; lp += vel; vel *= damp; c.outR[i] = Math.fround(x - lp); }
      this.cLpR = Math.abs(lp) < TINY ? 0 : lp; this.cVelR = Math.abs(vel) < TINY ? 0 : vel;
    }
    for (let i = 0; i < len; i++) { L[off + i] += c.outL[i]; R[off + i] += c.outR[i]; }
  }
}

export const gen: GenModule = {
  id: 'sytrus',
  create: (sampleRate, blockSize) => new Sytrus(sampleRate, blockSize),
};
