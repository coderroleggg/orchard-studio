// Envelope Controller DSP, after FL's Fruity Envelope Controller
// (docs/research/gen/envctrl.md). Every statement here was measured against the
// real plugin in the test host (a Python model of these rules reproduces the
// plugin's controller output sample-exactly on FL's presets and on randomised
// states):
//
// - FL runs the plugin once per song tick (NewTick: PPQ ticks per beat at the
//   current tempo, also while stopped). A note triggers a "voice" for every
//   articulator whose key range holds the key; an articulator follows its
//   newest voice (a new note takes it over), other articulators are untouched.
//   The first tick after the note ends its first step; the output of an
//   articulator is sent only when it changes.
// - Envelope time: one step per tick of 1/PPQ beat (TEMPO on) or of 2 x tick
//   seconds (units of 0.5 s). Segments before the D marker are scaled by ATT,
//   those from D to S by DEC, those after S by REL (without an S marker the
//   envelope plays through once: ATT up to D, DEC after it). SUS offsets the
//   points from D to the loop start (or S), ramped over the unscaled time. The
//   S marker holds its point's level until the note off, then the points after
//   S play with the value reached tilted into them (down from the current value
//   over the whole release; with D = S the release starts at S and the missed
//   distance tilts it downwards). L loops L..S (or L..end without S) while the
//   note is held, restarting from the loop end's level.
// - The LFO runs a trapezoid wave (skew, pulse width, tension) scaled by its
//   modifier envelope (2 y - 1); GLOBAL runs it on the tick count.
// - Combining: bipolar o = 1/2 + (base - 1/2) + E (e - 1/2) + L w / 2 + sum (m - 1/2);
//   unipolar o = (base + E e) (1 + L w) prod m; clamped to 0..1. The maps m are
//   evaluated at: key / 120, velocity x 0.007748626, Mod X = global X + (note + channel
//   Mod X) / 2, Mod Y likewise, a random value per note. A flat Mod X / Y map counts twice (plugin quirk).
//   Without a voice, with "Continuous output" on, the outputs follow the global X / Y alone.

import type { GenContext, GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import type { FxMonitor } from '../../effects/types';
import { curveShape, evalEnvelope, type AutoPoint, type CurveMode } from '../../../model/automation';
import {
  EC_ARTS, EC_KEY_OPEN, EC_KEY_SPAN, EC_VEL_X, ecKey, ecLfoHz, ecLfoOrigin, ecLfoWave, ecNormalizeShape, ecDefaultState,
  type EcArt, type EcShape,
} from '../../../model/gen/plugins/envctrl';

const MAX_VOICES = 128;
const MAX_EVENTS = 2 * MAX_VOICES + 16;
const EPS = 1e-9;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

let random: () => number = Math.random;
/** Replace the random source (tests). */
export function setEnvelopeControllerRandom(fn: (() => number) | null): void {
  random = fn ?? Math.random;
}

// ---------------------------------------------------------------- shapes

/** A compiled envelope: the model's shape as plain arrays plus what the player needs. */
interface Shape {
  n: number;
  pos: Float64Array;
  val: Float64Array;
  ten: Float64Array;
  mode: CurveMode[];
  on: boolean;
  tempo: boolean;
  global: boolean;
  d: number;
  l: number;
  s: number;
  /** All points share one value (Mod X / Y maps then count twice). */
  flat: boolean;
  /** The points as AutoPoints (maps are evaluated straight on them). */
  pts: AutoPoint[];
}

function compileShape(sh: EcShape): Shape {
  const n = sh.pts.length;
  const pos = new Float64Array(n), val = new Float64Array(n), ten = new Float64Array(n);
  const mode: CurveMode[] = [];
  const pts: AutoPoint[] = [];
  let flat = true;
  for (let i = 0; i < n; i++) {
    const p = sh.pts[i];
    pos[i] = p.pos; val[i] = p.value; ten[i] = p.tension; mode.push(p.mode);
    pts.push({ pos: p.pos, value: p.value, tension: p.tension, mode: p.mode });
    if (p.value !== sh.pts[0].value) flat = false;
  }
  return { n, pos, val, ten, mode, on: sh.on, tempo: sh.tempo, global: sh.global, d: sh.d, l: sh.l, s: sh.s, flat, pts };
}

// ---------------------------------------------------------- envelope player

/** Plays one envelope (the articulator's ENV or its LFO modifier envelope) for a note. */
class EnvPlayer {
  done = true;
  value = 0;
  private shape: Shape | null = null;
  private S = -1;
  private D = 0;
  private L = -1;
  private Lmark = -1;
  private X = new Float64Array(0);
  private Y = new Float64Array(0);
  private pts: AutoPoint[] = [];
  private rp: AutoPoint[] = [];
  private T = 0;
  private released = false;
  private releasing = false;
  private rT = 0;
  private rR = 0;
  private looping = false;
  private loopXl = 0;
  private loopXl1 = 0;
  private loopVp = 0;
  private isEnv = true;
  private decScale = 1;
  private relScale = 1;
  private rescaled = false;

  /** Start a note: scale the times (att / dec / rel) and tilt the sustain offset into the points. */
  start(sh: Shape, att: number, dec: number, rel: number, sus: number, isEnv: boolean, noSustain = false): void {
    const n = sh.n;
    this.shape = sh;
    this.isEnv = isEnv;
    this.decScale = dec;
    this.relScale = rel;
    this.rescaled = false;
    this.S = !noSustain && sh.s >= 0 && sh.s < n ? sh.s : -1;
    this.D = sh.d >= 0 && sh.d < n ? sh.d : 0;
    if (this.S >= 0 && this.D > this.S) this.D = 0;
    const S = this.S, D = this.D;
    const end = S >= 0 ? S : n - 1;
    this.L = sh.l >= 0 && sh.l < end && sh.pos[sh.l] < sh.pos[end] ? sh.l : -1; // a loop needs some length
    this.Lmark = this.L;
    if (this.X.length !== n) {
      this.X = new Float64Array(n);
      this.Y = new Float64Array(n);
      this.pts = [];
      for (let i = 0; i < n; i++) this.pts.push({ pos: 0, value: 0, tension: 0, mode: 'single' });
    }
    const rn = S >= 0 ? n - S : 1;
    if (this.rp.length !== rn) {
      this.rp = [];
      for (let i = 0; i < rn; i++) this.rp.push({ pos: 0, value: 0, tension: 0, mode: 'single' });
    }
    const X = this.X, Y = this.Y, xs = sh.pos, ys = sh.val;
    X[0] = xs[0];
    for (let i = 1; i < n; i++) {
      const f = S >= 0 ? (i <= D ? att : i <= S ? dec : rel) : i <= D ? att : dec;
      X[i] = X[i - 1] + (xs[i] - xs[i - 1]) * f;
    }
    if (this.L >= 0 && X[this.L] >= X[end]) this.L = -1; // scaled to nothing: no loop
    for (let i = 0; i < n; i++) Y[i] = ys[i];
    if (isEnv && S >= 0 && sus !== 0) {
      if (S === 0 && sh.d < 0) {
        // a corner of the plugin: S on the first point without a D marker tilts the whole envelope the other way
        const span = xs[n - 1] - xs[0];
        for (let i = 1; i < n; i++) Y[i] = clamp01(ys[i] - sus * (span > 0 ? (xs[i] - xs[0]) / span : 0));
      } else if (S > D) {
        // the offset ramps in over the decay (D .. L, or D .. S without a loop), stays up to S; measured on the unscaled time
        const le = sh.l >= 0 && sh.l < n ? sh.l : S;
        const span = le > D ? xs[le] - xs[D] : 0;
        for (let i = D + 1; i <= S; i++) {
          const w = le <= D || i > le ? 1 : span > 0 ? (xs[i] - xs[D]) / span : 0;
          Y[i] = clamp01(ys[i] + sus * w);
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const q = this.pts[i];
      q.pos = X[i]; q.value = Y[i]; q.tension = sh.ten[i]; q.mode = sh.mode[i];
    }
    this.T = 0;
    this.value = 0;
    this.hasValue = false;
    this.done = false;
    this.released = false;
    this.releasing = false;
    this.looping = false;
  }

  private hasValue = false;

  /** One tick of `dT` envelope units; returns the value. */
  step(dT: number): number {
    const sh = this.shape;
    if (!sh || this.done) return this.value;
    if (this.releasing) {
      this.rT += dT;
      if (this.rT >= this.rR - 1e-12) {
        this.done = true;
        this.value = this.rp[this.rp.length - 1].value;
      } else this.value = evalEnvelope(this.rp, this.rT);
      return this.value;
    }
    const n = sh.n, S = this.S, X = this.X, Y = this.Y;
    this.T += dT;
    const E = S >= 0 ? S : n - 1;
    if (this.T > X[E] + EPS && this.L >= 0 && !(S < 0 && this.released)) {
      // loop: wrap to the loop start, continuing from the loop end's level
      let over = this.T - X[E];
      if (!this.rescaled && this.L < this.D && this.D < E) {
        // after the first pass the attack stage is over: the looped segments before D are scaled by DEC as well (only with a decay stage, D < E)
        this.rescaled = true;
        for (let i = this.L + 1; i < n; i++) {
          X[i] = X[i - 1] + (sh.pos[i] - sh.pos[i - 1]) * (i <= E || S < 0 ? this.decScale : this.relScale);
          this.pts[i].pos = X[i];
        }
      }
      const ll = X[E] - X[this.L];
      if (ll > 0) over %= ll;
      this.T = X[this.L] + over;
      this.looping = true;
      this.loopXl = X[this.L];
      this.loopXl1 = X[this.L + 1];
      this.loopVp = Y[E];
    } else if (S >= 0) {
      if (this.T >= X[S] - EPS) {
        this.T = X[S];
        this.value = Y[S];
        this.hasValue = true;
        return this.value;
      }
    } else if (this.T >= X[n - 1] - EPS) {
      this.T = X[n - 1];
      this.value = Y[n - 1];
      // a loop marker keeps the envelope on its last level until the note off
      if (!(this.Lmark >= 0 && !this.released)) this.done = true;
      return this.value;
    }
    if (this.looping) {
      if (this.T < this.loopXl1 - EPS && this.loopXl1 > this.loopXl) {
        const b = this.pts[this.L + 1];
        const u = (this.T - this.loopXl) / (this.loopXl1 - this.loopXl);
        this.value = clamp01(this.loopVp + (b.value - this.loopVp) * curveShape(b.mode, u, b.tension));
        this.hasValue = true;
        return this.value;
      }
      this.looping = false;
    }
    this.value = evalEnvelope(this.pts, this.T);
    this.hasValue = true;
    return this.value;
  }

  /** Note off. */
  release(): void {
    if (this.released) return;
    this.released = true;
    const sh = this.shape;
    if (!sh || this.done) return;
    if (this.S < 0) {
      // no sustain marker: a note off switches to the decay stage, the segments after the running one are scaled by DEC
      const n = sh.n, X = this.X;
      let c = 0;
      for (let i = 0; i < n - 1; i++) if (X[i] <= this.T + EPS) c = i;
      for (let i = c + 2; i < n; i++) {
        X[i] = X[i - 1] + (sh.pos[i] - sh.pos[i - 1]) * this.decScale;
        this.pts[i].pos = X[i];
      }
      return;
    }
    const n = sh.n, S = this.S, X = this.X, Y = this.Y;
    const base = X[S], R = X[n - 1] - base;
    const vcur = this.hasValue ? this.value : Y[S];
    const yS = sh.val[S];
    const rp = this.rp;
    // no decay section (D and S at the same time): the release starts at the sustain level
    const zeroDecay = this.isEnv && sh.pos[this.D] === sh.pos[S];
    const dOnS = zeroDecay && this.D === S;
    rp[0].pos = 0;
    rp[0].value = zeroDecay ? Y[S] : vcur;
    rp[0].tension = sh.ten[S];
    rp[0].mode = sh.mode[S];
    for (let i = S + 1; i < n; i++) {
      const t = X[i] - base;
      const q = rp[i - S];
      q.pos = t;
      // the value reached tilts the points after S: down over the whole release when D is on S, else from the current value to none at the end
      q.value = dOnS ? clamp01(Y[i] - (vcur - Y[S]) * (R > 0 ? t / R : 1)) : clamp01(Y[i] + (vcur - yS) * (R > 0 ? 1 - t / R : 0));
      q.tension = sh.ten[i];
      q.mode = sh.mode[i];
    }
    // (a release without length ends at the first step, on the last release point)
    this.rR = R;
    this.rT = 0;
    this.releasing = true;
    this.looping = false;
  }
}

// ----------------------------------------------------------------- state

/** An articulator's compiled settings plus its running voice. */
class Art {
  polar = true;
  lo = 0;
  hi = EC_KEY_OPEN;
  base = 0.5;
  lenv = 1;
  llfo = 0.5;
  att = 1;
  dec = 1;
  sus = 0;
  rel = 1;
  speed = 40000;
  tn = 0;
  sk = 0;
  pw = 0;
  env!: Shape;
  lfo!: Shape;
  maps: Shape[] = [];
  // the running note
  cur: EcVoice | null = null;
  envOn = false;
  lfoOn = false;
  tempoEnv = false;
  tempoLfo = false;
  /** The running note's LFO runs on the global tick clock (cleared when a waiting LFO starts at the note off). */
  global = false;
  /** The LFO's modifier envelope sustains on its first point: the LFO stays silent until the note off. */
  lfoWait = false;
  /** Global tick count at the note on. */
  gt0 = 0;
  phase = 0;
  readonly envP = new EnvPlayer();
  readonly lfoP = new EnvPlayer();
  /** The last value sent (FL sends an output when it changes; the initial value is 0). */
  last = 0;
  /** The last note this articulator took (the editor's mapping lines): key, velocity, random value, note + channel Mod X / Y. */
  lastKey = NaN;
  lastVel = NaN;
  lastRand = NaN;
  lastFx = 0;
  lastFy = 0;
}

class EcVoice implements GenVoice {
  /** 0 = free, 1 = triggered (queued or running), 2 = ended. */
  state = 0;
  serial = 0;
  params: GenVoiceParams | null = null;
  key = 0;
  vel = 0;
  rand = 0;
  /** Articulators following this voice. */
  refs = 0;

  constructor(private readonly ec: EnvelopeController) {}

  /** The voice lives while an articulator follows it (the controller makes no sound). */
  render(): boolean {
    return this.state === 1;
  }

  release(): void {
    this.ec.queueOff(this);
  }

  kill(): void {
    this.ec.queueKill(this);
  }
}

class EnvelopeController implements GenInstance {
  /** A controller runs all the time. */
  readonly tail = Infinity;
  private readonly sr: number;
  private arts: Art[] = [];
  private gx = 0.5;
  private gy = 0.5;
  private cont = false;
  // voices
  private readonly voices: EcVoice[] = [];
  private serial = 0;
  // events of the current block, applied in time order by render()
  private readonly evFrame = new Int32Array(MAX_EVENTS);
  private readonly evKind = new Uint8Array(MAX_EVENTS); // 1 note on, 2 note off, 3 kill
  private readonly evVoice: (EcVoice | null)[] = new Array(MAX_EVENTS).fill(null);
  private readonly order = new Int32Array(MAX_EVENTS);
  private nEv = 0;
  // outputs
  private readonly out = new Float64Array(EC_ARTS).fill(NaN);
  // tick clock (free running while the song does not play)
  private tickLeft = 0;
  private gtick = 0;
  private dtSec = 0;
  private ppq = 96;

  constructor(sr: number) {
    this.sr = sr;
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new EcVoice(this));
    for (let a = 0; a < EC_ARTS; a++) this.arts.push(new Art());
    this.setParams({});
  }

  // ------------------------------------------------------------ parameters

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    const dflt = ecDefaultState();
    const dArts = dflt.arts as EcArt[];
    const rawArts = Array.isArray(q.arts) ? (q.arts as Partial<EcArt>[]) : [];
    const num = (k: string, d: number, lo: number, hi: number) => {
      const v = Number(q[k] ?? d);
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
    };
    for (let a = 0; a < EC_ARTS; a++) {
      const art = this.arts[a];
      const r = rawArts[a] ?? dArts[a];
      const fb = dArts[a];
      art.polar = r.polar === undefined ? fb.polar : !!r.polar;
      art.lo = Math.round(Number.isFinite(r.lo) ? (r.lo as number) : fb.lo);
      art.hi = Math.round(Number.isFinite(r.hi) ? (r.hi as number) : fb.hi);
      art.base = num(ecKey(a, 'base'), 128, 0, 256) / 256;
      art.lenv = num(ecKey(a, 'env'), 256, -256, 256) / 256;
      art.llfo = num(ecKey(a, 'lfo'), 128, -256, 256) / 256;
      art.att = num(ecKey(a, 'att'), 128, 0, 256) / 128;
      art.dec = num(ecKey(a, 'dec'), 128, 0, 256) / 128;
      art.sus = num(ecKey(a, 'sus'), 0, -128, 128) / 128;
      art.rel = num(ecKey(a, 'rel'), 128, 0, 256) / 128;
      art.speed = num(ecKey(a, 'spd'), 40000, 512, 65536);
      art.tn = num(ecKey(a, 'tns'), 0, -128, 128);
      art.sk = num(ecKey(a, 'skw'), 0, -128, 128);
      art.pw = num(ecKey(a, 'pw'), 0, -112, 112);
      art.env = compileShape(ecNormalizeShape(r.env, fb.env));
      art.lfo = compileShape(ecNormalizeShape(r.lfo, fb.lfo));
      art.maps = fb.maps.map((m, k) => compileShape(ecNormalizeShape(r.maps?.[k], m)));
    }
    this.gx = num('modx', 32768, 0, 65536) / 65536;
    this.gy = num('mody', 32768, 0, 65536) / 65536;
    this.cont = !!q.cont;
  }

  // ----------------------------------------------------------------- voices

  triggerVoice(p: GenVoiceParams): GenVoice | null {
    const key = Math.round(p.key);
    let any = false;
    for (let a = 0; a < EC_ARTS; a++) {
      const art = this.arts[a];
      if (key >= art.lo && key <= art.hi) { any = true; break; }
    }
    if (!any) return null;
    let v: EcVoice | null = null;
    for (const c of this.voices) if (c.state === 0) { v = c; break; }
    if (!v) return null;
    v.state = 1;
    v.serial = ++this.serial;
    v.params = p;
    v.key = key;
    v.vel = p.velocity;
    v.rand = random();
    v.refs = 0;
    this.push(1, v, p.frame);
    return v;
  }

  queueOff(v: EcVoice): void {
    if (v.state !== 1) return;
    this.push(2, v, v.params ? v.params.frame : 0);
  }

  queueKill(v: EcVoice): void {
    if (v.state === 0) return;
    this.push(3, v, v.params ? v.params.frame : 0);
  }

  private push(kind: number, v: EcVoice, frame: number): void {
    if (this.nEv >= MAX_EVENTS) { this.apply(kind, v); return; }
    const i = this.nEv++;
    this.evFrame[i] = Math.max(0, Math.floor(frame));
    this.evKind[i] = kind;
    this.evVoice[i] = v;
  }

  private dropArt(art: Art): void {
    const v = art.cur;
    art.cur = null;
    if (!v) return;
    v.refs--;
    if (v.refs <= 0 && v.state === 1) this.endVoice(v);
  }

  private endVoice(v: EcVoice): void {
    v.state = 2;
    v.params = null;
  }

  /** A note on / off / kill reaches the articulators (at its tick). */
  private apply(kind: number, v: EcVoice): void {
    if (kind === 1) {
      if (v.state !== 1) return;
      for (let a = 0; a < EC_ARTS; a++) {
        const art = this.arts[a];
        if (v.key < art.lo || v.key > art.hi) continue;
        if (art.cur) this.dropArt(art);
        art.cur = v;
        v.refs++;
        art.lastKey = v.key; art.lastVel = v.vel; art.lastRand = v.rand;
        art.lastFx = v.params ? v.params.levels.fcut : 0; art.lastFy = v.params ? v.params.levels.fres : 0;
        this.startArt(art);
      }
      if (v.refs === 0) this.endVoice(v);
    } else if (kind === 2) {
      for (let a = 0; a < EC_ARTS; a++) {
        const art = this.arts[a];
        if (art.cur !== v) continue;
        if (art.envOn) art.envP.release();
        if (art.lfoOn) this.releaseLfo(art);
      }
    } else {
      for (let a = 0; a < EC_ARTS; a++) if (this.arts[a].cur === v) this.dropArt(this.arts[a]);
      v.state = 0;
      v.params = null;
    }
  }

  /** Note off for the LFO: a waiting LFO (modifier envelope sustaining on its first point) starts now, from the beginning. */
  private releaseLfo(art: Art): void {
    if (!art.lfoWait) { art.lfoP.release(); return; }
    art.lfoWait = false;
    if (art.global) {
      // a global LFO continues from the global phase of the note on
      const hz = ecLfoHz(art.speed);
      const inc = art.tempoLfo ? hz / (2 * this.ppq) : hz * this.dtSec;
      art.phase = art.gt0 * inc - ecLfoOrigin(art.sk, art.pw);
      art.global = false;
    } else art.phase = 0;
    art.lfoP.start(art.lfo, 1, 1, 1, 0, false, true);
  }

  private startArt(art: Art): void {
    art.envOn = art.env.on;
    art.lfoOn = art.lfo.on;
    art.tempoEnv = art.env.tempo;
    art.tempoLfo = art.lfo.tempo;
    art.global = art.lfo.global;
    art.lfoWait = art.lfoOn && art.lfo.s === 0;
    art.gt0 = this.gtick;
    art.phase = 0;
    if (art.envOn) art.envP.start(art.env, art.att, art.dec, art.rel, art.sus, true);
    if (art.lfoOn) art.lfoP.start(art.lfo, 1, 1, 1, 0, false);
  }

  // ----------------------------------------------------------------- ticks

  private mapValue(art: Art, k: number, x: number): number {
    return evalEnvelope(art.maps[k].pts, x);
  }

  /** The combined output of an articulator (FL's sources: see the header). */
  private combine(art: Art, e: number, hasEnv: boolean, w: number, hasLfo: boolean, voice: EcVoice | null): number {
    let o: number;
    if (voice) {
      const lv = voice.params ? voice.params.levels : null;
      const fx = lv ? lv.fcut : 0, fy = lv ? lv.fres : 0;
      const mkb = this.mapValue(art, 0, voice.key / EC_KEY_SPAN);
      const mvel = this.mapValue(art, 1, voice.vel * EC_VEL_X);
      const mx = this.mapValue(art, 2, this.gx + fx / 2);
      const my = this.mapValue(art, 3, this.gy + fy / 2);
      const mr = this.mapValue(art, 4, voice.rand);
      const dx = art.maps[2].flat, dy = art.maps[3].flat;
      if (art.polar) {
        o = art.base + (hasEnv ? art.lenv * (e - 0.5) : 0) + (hasLfo ? (art.llfo * w) / 2 : 0);
        o += mkb - 0.5 + (mvel - 0.5) + (mx - 0.5) * (dx ? 2 : 1) + (my - 0.5) * (dy ? 2 : 1) + (mr - 0.5);
      } else {
        o = art.base + (hasEnv ? art.lenv * e : 0);
        if (hasLfo) o *= 1 + art.llfo * w;
        o *= mkb * mvel * mx * (dx ? mx : 1) * my * (dy ? my : 1) * mr;
      }
    } else {
      // no voice (continuous output): the global Mod X / Y only
      const mx = this.mapValue(art, 2, this.gx), my = this.mapValue(art, 3, this.gy);
      if (art.polar) o = art.base + (mx - 0.5) + (my - 0.5);
      else o = art.base * mx * my;
    }
    return clamp01(o);
  }

  private tickArt(art: Art, a: number): void {
    const v = art.cur;
    let val = NaN;
    if (v) {
      let e = 0, w = 0, alive = false;
      if (art.envOn) {
        e = art.envP.step(art.tempoEnv ? 1 / this.ppq : 2 * this.dtSec);
        if (!art.envP.done) alive = true;
      }
      let lfoRun = art.lfoOn;
      if (art.lfoWait) { lfoRun = false; alive = true; }
      if (lfoRun) {
        const y = art.lfoP.step(art.tempoLfo ? 1 / this.ppq : 2 * this.dtSec);
        const hz = ecLfoHz(art.speed);
        const inc = art.tempoLfo ? hz / (2 * this.ppq) : hz * this.dtSec;
        let ph: number;
        if (art.global) ph = this.gtick * inc - ecLfoOrigin(art.sk, art.pw);
        else { art.phase += inc; ph = art.phase; }
        w = ecLfoWave(ph, art.tn, art.sk, art.pw) * (2 * y - 1);
        if (!art.lfoP.done) alive = true;
      }
      val = this.combine(art, e, art.envOn, w, lfoRun, v);
      if (!alive) this.dropArt(art);
    } else if (this.cont) val = this.combine(art, 0, false, 0, false, null);
    if (val === val) {
      const f = Math.fround(val);
      if (f !== art.last) { art.last = f; this.out[a] = f; }
    }
  }

  private tick(): void {
    this.gtick++;
    for (let a = 0; a < EC_ARTS; a++) this.tickArt(this.arts[a], a);
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    void L; void R;
    const tempo = ctx.tempo > 0 ? ctx.tempo : 120;
    const ppq = ctx.ppq > 0 ? ctx.ppq : 96;
    this.ppq = ppq;
    const spt = (this.sr * 60) / (tempo * ppq);
    this.dtSec = 60 / (tempo * ppq);
    // tick boundaries of this block: aligned to the song's ticks while it plays
    let t: number;
    if (ctx.playing) {
      const frac = ctx.pos - Math.floor(ctx.pos + 1e-9);
      t = frac > 1e-7 ? (1 - frac) * spt : 0;
    } else t = this.tickLeft;
    // events in time order (stable insertion sort: blocks hold few of them)
    const ne = this.nEv;
    const order = this.order;
    for (let i = 0; i < ne; i++) {
      let j = i;
      while (j > 0 && this.evFrame[order[j - 1]] > this.evFrame[i]) { order[j] = order[j - 1]; j--; }
      order[j] = i;
    }
    let e = 0;
    // a tick sits at floor(position): the epsilon keeps a tick that falls exactly on a block boundary
    // (float error of the position) in the block that starts there
    for (let f = Math.floor(t + 1e-6); f < n; f = Math.floor(t + 1e-6)) {
      while (e < ne && this.evFrame[order[e]] <= f + 1) { const i = order[e++]; this.apply(this.evKind[i], this.evVoice[i] as EcVoice); }
      this.tick();
      t += spt;
    }
    while (e < ne) { const i = order[e++]; this.apply(this.evKind[i], this.evVoice[i] as EcVoice); }
    for (let i = 0; i < ne; i++) this.evVoice[i] = null;
    this.nEv = 0;
    this.tickLeft = t - n;
  }

  controls(): ArrayLike<number> {
    return this.out;
  }

  /** Editor data: per articulator the last note (key, velocity, random value, Mod X, Mod Y) and the global X / Y. */
  monitor(): FxMonitor {
    const last: number[] = [];
    for (const art of this.arts) last.push(art.lastKey, art.lastVel, art.lastRand, art.lastFx, art.lastFy);
    return { last, gx: this.gx, gy: this.gy };
  }

  allNotesOff(): void {
    for (const art of this.arts) art.cur = null;
    for (const v of this.voices) { v.state = 0; v.params = null; v.refs = 0; }
    this.nEv = 0;
  }

  reset(): void {
    this.allNotesOff();
    this.out.fill(NaN);
    for (const art of this.arts) { art.last = 0; art.lastKey = NaN; art.lastVel = NaN; art.lastRand = NaN; }
    this.tickLeft = 0;
    this.gtick = 0;
  }
}

export const gen: GenModule = {
  id: 'envctrl',
  create: (sampleRate) => new EnvelopeController(sampleRate),
};
