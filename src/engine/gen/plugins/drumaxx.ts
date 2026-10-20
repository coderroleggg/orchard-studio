// Drumaxx (FL: Drumaxx, by Maxx Claster): 16 Drumpad voices (one per pad, the
// same engine code as Drumpad's, docs/research/gen/drumaxx.md) with FL's
// mixer, cut groups, mixer track routing, 8-band EQ, limiter, master level and
// performance sequencer, reproduced from FL 2026's engine (DMSynth) in its
// single precision and operation order.
//
// - A note triggers every pad whose Key is the note (not muted; with a solo
//   active only soloed pads), velocity = MIDI velocity / 127 (linear; Drumpad
//   uses its square root). A pad retriggers its own voice (the membrane carries
//   over); pads sharing a cut group end each other's hold.
// - Pad gains per block: 2 vol^2 (1 - pan) and 2 vol^2 pan times FL's levels of
//   the pad's key (or of the pattern's trigger note while a pattern plays):
//   FL's per-slot level arrays as in Drumpad. The voices ramp to them by 0.001
//   per sample.
// - Pads with a mixer track offset go to that track (channel track + offset),
//   the others to the master section: EQ (80 Hz low shelf, 160 ... 5120 Hz
//   peaking, 10240 Hz high shelf, Q 2, 16 v - 8 dB, FL's RBJ variant, bands 8
//   to 1), limiter (gain 10^(1.5 v), instant attack, recovery 3 rel^2 + 2 per s
//   along t^4), then the master level 10^(1.6 v) / 8 (ramped 0.005 per sample).
//   With no master pad sounding, FL resets the EQ and limiter.
// - Sequencer: 16 patterns (16 tracks x up to 64 steps, velocities); a
//   pattern's trigger key starts it while held (or the Play button), steps of
//   a 16th at the host tempo, swing lengthens even and shortens odd steps by
//   15 x swing / 2.
// FL keeps its levels per key: notes are forgotten one block after their note
// off once no pad of their key sounds.

import type { GenContext, GenInstance, GenModule, GenNote } from '../types';
import type { FxMonitor } from '../../effects/types';
import { DX_GLOBAL, dxKeyOf, dxRaw, dxSteps, type DxPattern } from '../../../model/gen/plugins/drumaxx/keys';
import { exp10f, exp2f, fma32, fmaD } from './drumpad/libm';
import { DP_ENGINE_DEFAULTS, DpVoice, Rbj, flLRVol } from './drumpad/voice';

const f32 = Math.fround;
const fma = fma32;
const PADS = 16;
const NPARAM = 720;
const CHUNK = 512;
const MAX_EVENTS = 256;
const F_1E9 = f32(1e-9);
const G005 = f32(0.005);
const INV127 = f32(1 / 127);
const EQ_FREQ = [80, 160, 320, 640, 1280, 2560, 5120, 10240];

/** The value FL's gain ramp (x += (target - x) 0.005 per sample, single precision) stalls at. */
function settle(x: number, tgt: number): number {
  for (let i = 0; i < 20000; i++) {
    const y = fma32(f32(tgt - x), G005, x);
    if (y === x) break;
    x = y;
  }
  return x;
}

/** FL's EQ band tick (biquad with FL's tiny-value flush on input and output). */
function eqTick(f: Rbj, x: number): number {
  const xi = x > -F_1E9 && x < F_1E9 ? 0 : x;
  const s0 = fma(f.b0, xi, f32(f.b1 * f.x1));
  let y = f32(f32(s0 + f32(f.b2 * f.x2)) - f32(f32(f.a1 * f.y1) + f32(f.a2 * f.y2)));
  if (y > -F_1E9 && y < F_1E9) y = 0;
  f.x2 = f.x1; f.x1 = xi; f.y2 = f.y1; f.y1 = y;
  return y;
}

interface Slot { note: GenNote | null; pan: number; vol: number; pitch: number }
interface Pat { len: number; key: number; steps: Uint8Array }

class Drumaxx implements GenInstance {
  private readonly sr: number;
  readonly voices: DpVoice[] = [];
  /** Engine parameter values by FL index (control / 256; keys and velocity targets as they are). */
  readonly p = new Float32Array(NPARAM);
  private readonly pats: Pat[] = [];
  private patSrc: unknown = null;
  private readonly cuts = new Int32Array(PADS);
  private readonly offsets = new Int32Array(PADS);
  private readonly padVol = new Float32Array(PADS);
  private readonly padPan = new Float32Array(PADS);
  private masterG = 1;
  private gCurL = 0; private gCurR = 0;
  // FL's wrapper: notes per slot (key), voices per key, note velocities, per-slot levels
  private readonly slots: (Slot | null)[] = new Array(128).fill(null);
  private readonly counts = new Int32Array(128);
  private readonly noteVel = new Float32Array(128);
  private readonly eL = new Float32Array(128);
  private readonly eR = new Float32Array(128);
  private readonly eP = new Float32Array(128);
  private readonly lr = { l: 0, r: 0 };
  // sequencer (FL: DMSynth 0x6338..)
  private curPat = -1;
  private patNote = 0;
  private changed = true;
  private alive = false;
  private timer = 0;
  private step = 0;
  private play = -1;
  // master section
  private readonly eqL: Rbj[] = [];
  private readonly eqR: Rbj[] = [];
  private tL = 0; private mL = 1; private tR = 0; private mR = 1;
  private eqOn = false; private limOn = false;
  private readonly mixL = new Float32Array(CHUNK);
  private readonly mixR = new Float32Array(CHUNK);
  private padBuf: Float32Array[] = [];
  private readonly padUsed = new Uint8Array(PADS);
  private readonly status = new Uint8Array(PADS);
  // events
  private readonly evFrame = new Int32Array(MAX_EVENTS);
  private readonly evNote: (GenNote | null)[] = new Array(MAX_EVENTS).fill(null);
  private readonly evOn = new Uint8Array(MAX_EVENTS);
  private evCount = 0;
  private curPad = 0;
  private segOff = 0;
  /** FL resets the master gain ramp before playing (the state is set first). */
  private started = false;
  private curVel = 0;
  private readonly getp = (i: number): number => this.param(i);

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    for (let k = 0; k < PADS; k++) {
      const v = new DpVoice(k, this.counts, false);
      v.reset(f32(sampleRate));
      this.voices.push(v);
      this.pats.push({ len: 15, key: 127, steps: new Uint8Array(1024).fill(0x7f) });
      for (let j = 0; j < 38; j++) this.p[44 * k + 5 + j] = j >= 30 && j <= 33 ? 0 : DP_ENGINE_DEFAULTS[j];
      this.p[44 * k] = f32(0.73); this.p[44 * k + 1] = 0.5;
      this.setPadGain(k);
    }
    this.p[705] = 0.5;
    for (let b = 0; b < 8; b++) this.p[708 + b] = 0.5;
    this.masterG = f32(exp10f(f32(0.5 * f32(1.6))) * 0.25);
    for (let b = 0; b < 8; b++) {
      for (const list of [this.eqL, this.eqR]) {
        const f = new Rbj();
        f.type = b === 0 ? 0 : b === 7 ? 2 : 1;
        f.freq = EQ_FREQ[b]; f.q = 2; f.gain = 0; f.dirty = true;
        list.push(f);
      }
    }
    this.gCurL = this.gCurR = 0;
  }

  private setPadGain(k: number): void {
    const v = this.p[44 * k];
    this.padVol[k] = f32(f32(v * v) * 2);
    this.padPan[k] = this.p[44 * k + 1];
  }

  /**
   * FL ramps the master gain from 0 (0.005 per sample) while it runs, so it
   * settles where the single-precision ramp stalls, a little below the target:
   * the state a playing FL instance is in.
   */
  private resetGains(): void {
    const g = f32(this.masterG * 0.5);
    this.gCurL = this.gCurR = settle(this.gCurL, g);
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    for (let i = 0; i < 719; i++) {
      const key = dxKeyOf(i);
      if (!key) continue;
      const x = Number(q[key]);
      if (!Number.isFinite(x)) continue;
      const local = i < 704 ? i % 44 : -1;
      const v = local >= 0 && dxRaw(local) ? Math.round(Math.max(0, Math.min(local === 4 ? 126 : 28, x))) : f32(Math.max(0, Math.min(1, x / 256)));
      if (this.p[i] === v) continue;
      this.p[i] = v;
      if (local === 0 || local === 1) this.setPadGain(Math.floor(i / 44));
      else if (i === 705) { this.masterG = f32(exp10f(f32(v * f32(1.6))) * 0.25); if (!this.isActive()) this.resetGains(); }
      else if (i === 707) for (let b = 0; b < 8; b++) { const l = this.eqL[b], r = this.eqR[b]; l.x1 = l.x2 = l.y1 = l.y2 = r.x1 = r.x2 = r.y1 = r.y2 = 0; }
      else if (i === 716) { this.tL = 0; this.mL = 1; this.tR = 0; this.mR = 1; }
    }
    const cuts = q.cuts, offs = q.offsets;
    if (Array.isArray(cuts)) for (let k = 0; k < PADS; k++) this.cuts[k] = (Number(cuts[k]) | 0) & 0xff;
    if (Array.isArray(offs)) for (let k = 0; k < PADS; k++) this.offsets[k] = Number(offs[k]) | 0;
    if (q.patterns !== this.patSrc && Array.isArray(q.patterns)) {
      this.patSrc = q.patterns;
      const ps = q.patterns as DxPattern[];
      for (let p = 0; p < 16; p++) {
        const s = ps[p];
        if (!s) continue;
        this.pats[p].len = (Number(s.len) | 0) & 0xff;
        this.pats[p].key = (Number(s.key) | 0) & 0xff;
        this.pats[p].steps = typeof s.steps === 'string' ? dxSteps(s.steps) : this.pats[p].steps;
      }
    }
    // FL's Play button: the selected pattern plays (-1: stopped)
    const play = typeof q.play === 'number' && Number.isFinite(q.play) ? Math.max(-1, Math.min(15, Math.round(q.play))) : -1;
    if (play !== this.play) { this.play = play; this.curPat = play; this.changed = true; }
  }

  reset(): void {
    for (const v of this.voices) { v.reset(f32(this.sr)); v.pos = 0; v.cnt = 0; }
    this.slots.fill(null); this.counts.fill(0); this.noteVel.fill(0);
    this.curPat = this.play; this.changed = true; this.alive = false;
    for (let b = 0; b < 8; b++) { const l = this.eqL[b], r = this.eqR[b]; l.x1 = l.x2 = l.y1 = l.y2 = r.x1 = r.x2 = r.y1 = r.y2 = 0; }
    this.tL = 0; this.mL = 1; this.tR = 0; this.mR = 1;
    this.resetGains();
    this.evCount = 0; this.evNote.fill(null);
  }

  /**
   * FL's velocity-modulated getter for the pad being triggered (Drumpad indices). Mallet retrig
   * and Retrig (-1 / -2) are read from pad 1 for every pad, as FL's engine does.
   */
  private param(i: number): number {
    const b = 44 * this.curPad + 5;
    if (i === -1) return this.p[5];
    if (i === -2) return this.p[6];
    const base = this.p[b + i];
    let tgt = base;
    for (let m = 0; m < 4; m++) {
      const s = Math.trunc(this.p[b + 30 + m]);
      if (s !== 0 && s + 1 === i) tgt = this.p[b + 34 + m];
    }
    return fma(f32(tgt - base), this.curVel, base);
  }

  private queue(note: GenNote, frame: number, on: boolean): void {
    if (this.evCount >= MAX_EVENTS) return;
    this.evFrame[this.evCount] = frame; this.evNote[this.evCount] = note; this.evOn[this.evCount++] = on ? 1 : 0;
  }

  noteOn(note: GenNote, frameOffset: number): void { this.queue(note, frameOffset, true); }
  noteOff(note: GenNote, frameOffset: number): void { this.queue(note, frameOffset, false); }
  killNote(note: GenNote): void {
    for (let i = 0; i < this.evCount; i++) if (this.evNote[i] === note && this.evOn[i]) this.evNote[i] = null;
    this.release(note);
  }

  isActive(): boolean {
    if (this.evCount > 0 || this.curPat >= 0) return true;
    for (const v of this.voices) if (v.active) return true;
    return false;
  }

  /** FL's pad trigger: velocity, cut groups, the voice's note on. */
  private triggerPad(k: number, vel: number): void {
    const v = this.voices[k];
    v.vel = vel;
    v.note = k;
    const g = this.cuts[k];
    for (let j = 0; j < PADS; j++) if (j !== k && this.cuts[j] !== 0 && this.cuts[j] === g) this.voices[j].cut = true;
    this.curPad = k; this.curVel = vel;
    v.noteOn(this.getp);
  }

  /** FL's TriggerVoice + DMSynth's note on: pattern trigger keys, then the pads on this key. */
  private trigger(note: GenNote): void {
    const slot = Math.min(127, Math.max(0, Math.trunc(note.key)));
    const s = this.slots[slot];
    if (s) s.note = note; else this.slots[slot] = { note, pan: 0, vol: 0, pitch: 6000 };
    const lv = Math.trunc(f32(f32(Math.log(fma(f32(note.init.vol), 10, 1))) * f32(41.714256)));
    const vi = lv < 0 ? 0 : lv > 127 ? 127 : lv;
    const vel = f32(vi * f32(1 / 127));
    this.noteVel[slot] = vel;
    if (vi === 0) { this.stopPattern(slot); return; }
    for (let p = 0; p < 16; p++) {
      if (this.pats[p].key !== slot) continue;
      this.patNote = slot; this.curPat = p; this.changed = true; this.counts[slot] = 1;
    }
    let solo = false;
    for (let k = 0; k < PADS; k++) if (this.p[44 * k + 3] !== 0) solo = true;
    for (let k = 0; k < PADS; k++) {
      const on = Math.trunc(this.p[44 * k + 4]) === slot && this.p[44 * k + 2] === 0 && (!solo || this.p[44 * k + 3] !== 0);
      if (on) this.triggerPad(k, vel);
    }
  }

  /** FL's note off: a held pattern trigger key stops its pattern. */
  private stopPattern(slot: number): void {
    if ((this.patNote & 0xff) !== slot) return;
    if (this.curPat >= 0) this.alive = true;
    this.curPat = -1; this.changed = true;
  }

  private release(note: GenNote): void {
    const slot = Math.min(127, Math.max(0, Math.trunc(note.key)));
    const s = this.slots[slot];
    if (!s || s.note !== note) return;
    this.noteVel[slot] = 0;
    s.pan = note.levels.pan; s.vol = note.levels.vol; s.pitch = note.levels.pitch;
    s.note = null;
    this.stopPattern(slot);
  }

  /** FL's per-slot level arrays (all 128 filled from the nearest active slot; zeros without one). */
  private levels(): void {
    let any = false;
    for (let i = 0; i < 128; i++) {
      const s = this.slots[i];
      if (s) {
        const n = s.note;
        flLRVol(n ? n.levels.pan : s.pan, f32(n ? n.levels.vol : s.vol), this.lr);
        const pt = f32(fmaD(f32((n ? n.levels.pitch : s.pitch) - 6000), 0.01, 60 - i));
        if (!any) { any = true; for (let j = 0; j < i; j++) { this.eL[j] = this.lr.l; this.eR[j] = this.lr.r; this.eP[j] = pt; } }
        this.eL[i] = this.lr.l; this.eR[i] = this.lr.r; this.eP[i] = pt;
      } else if (any) { this.eL[i] = this.eL[i - 1]; this.eR[i] = this.eR[i - 1]; this.eP[i] = this.eP[i - 1]; }
      else if (this.play >= 0) { this.eL[i] = this.eR[i] = f32(Math.SQRT1_2); this.eP[i] = 0; }
      else { this.eL[i] = 0; this.eR[i] = 0; this.eP[i] = 0; }
    }
  }

  /** DMSynth's per-block voice update: voice counts per key, pad gains and pitch. */
  private padLevels(): void {
    this.counts.fill(0);
    let any = false;
    for (const v of this.voices) if (v.active) any = true;
    const pn = this.patNote;
    if (this.curPat >= 0) { this.counts[pn] = 1; if (this.alive) this.alive = any; }
    else { if (any && this.alive) this.counts[pn] = 1; if (this.alive) this.alive = any; }
    for (let k = 0; k < PADS; k++) {
      const v = this.voices[k];
      if (!v.active) continue;
      const key = Math.trunc(this.p[44 * k + 4]) & 0x7f;
      if (this.counts[key] === 0) this.counts[key] = 1;
      const slot = this.counts[pn] === 0 ? key : pn;
      const vol = this.padVol[k], pan = this.padPan[k];
      const l = fma(-pan, vol, vol), r = f32(vol * pan);
      v.tgtL = f32(l * this.eL[slot]);
      v.tgtR = f32(r * this.eR[slot]);
      let st = this.eP[slot];
      st = st > -12 ? st : -12;
      st = st < 12 ? st : 12;
      v.pitchRatio = exp2f(f32(st * f32(0.083333336)));
    }
  }

  /** FL's render (DMSynth 0x417e0): n frames from o, chunks of at most 512 (routed pads at block frame base + o). */
  private renderPads(L: Float32Array, R: Float32Array, o: number, n: number): void {
    const base = this.segOff;
    while (n > 0) {
      const c = n < CHUNK ? n : CHUNK;
      this.mixL.fill(0, 0, c); this.mixR.fill(0, 0, c);
      let master = false;
      for (let k = 0; k < PADS; k++) {
        const v = this.voices[k];
        const act = v.active;
        if (this.offsets[k] === 0) { if (act) master = true; v.process(this.mixL, this.mixR, 0, c); }
        else if (act) { this.padUsed[k] = 1; v.process(this.padBuf[2 * k], this.padBuf[2 * k + 1], base + o, c); }
      }
      if (master) this.masterFx(L, R, o, c);
      else {
        for (let b = 0; b < 8; b++) { const l = this.eqL[b], r = this.eqR[b]; l.x1 = l.x2 = l.y1 = l.y2 = r.x1 = r.x2 = r.y1 = r.y2 = 0; }
        this.tL = 0; this.mL = 1; this.tR = 0; this.mR = 1;
      }
      o += c; n -= c;
    }
  }

  /** FL's master section (DMSynth 0x41d04): EQ, limiter, added into the main output. */
  private masterFx(L: Float32Array, R: Float32Array, o: number, n: number): void {
    const fs = f32(this.sr);
    for (let b = 0; b < 8; b++) {
      const g = f32(fmaD(this.p[708 + b], 16, -8));
      for (const f of [this.eqL[b], this.eqR[b]]) { if (f.gain !== g) f.dirty = true; f.gain = g; f.update(fs); }
    }
    const eq = this.p[707] !== 0, lim = this.p[716] !== 0;
    const rel = this.p[718];
    const G = exp10f(f32(this.p[717] * 1.5));
    const rate = f32(fmaD(f32(rel * rel), 3, 2)) / this.sr;
    const eqL = this.eqL, eqR = this.eqR;
    for (let i = 0; i < n; i++) {
      let xl = this.mixL[i], xr = this.mixR[i];
      if (eq) {
        for (let b = 7; b >= 0; b--) xl = eqTick(eqL[b], xl);
        for (let b = 7; b >= 0; b--) xr = eqTick(eqR[b], xr);
      }
      if (lim) {
        let x = f32(xl * G), t = f32(this.tL * this.tL); t = f32(t * t);
        xl = f32(f32(fma(-this.mL, t, t) + this.mL) * x);
        if (Math.abs(xl) > 1) { this.tL = 0; this.mL = f32(1 / Math.abs(x)); xl = f32(this.mL * x); }
        this.tL = Math.min(f32(rate + this.tL), 1);
        x = f32(xr * G); t = f32(this.tR * this.tR); t = f32(t * t);
        xr = f32(f32(fma(-this.mR, t, t) + this.mR) * x);
        if (Math.abs(xr) > 1) { this.tR = 0; this.mR = f32(1 / Math.abs(x)); xr = f32(this.mR * x); }
        this.tR = Math.min(f32(rate + this.tR), 1);
      }
      L[o + i] = f32(L[o + i] + xl);
      R[o + i] = f32(R[o + i] + xr);
    }
  }

  /** The sequencer's steps (DMSynth 0x412a8): render between steps, fire each step's pads. */
  private sequence(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    const pat = this.pats[this.curPat];
    let sw = f32(this.p[706] * 0.5);
    sw = sw > 0 ? (sw < 0.5 ? sw : 0.5) : 0;
    const up = sw * 15, down = -(sw * 15);
    const tempo = ctx.tempo > 0 ? ctx.tempo : 120;
    let solo = false;
    for (let k = 0; k < PADS; k++) if (this.p[44 * k + 3] !== 0) solo = true;
    let o = 0;
    while (n > 0) {
      const w = Math.trunc(this.timer);
      const c = n < w ? n : w;
      n -= c;
      if (w === 0) {
        this.timer += (((this.step & 1) === 0 ? up : down) + 15) * this.sr / tempo;
        const s = this.step > 0 ? (this.step < 64 ? this.step : 64) : 0;
        for (let k = 0; k < PADS; k++) {
          const idx = 64 * k + s;
          const b = idx < 1024 ? pat.steps[idx] : pat.len; // FL reads on into the pattern record
          if (!(b & 0x80)) continue;
          if (this.p[44 * k + 2] !== 0 || (solo && this.p[44 * k + 3] === 0)) continue;
          this.triggerPad(k, f32((b & 0x7f) * INV127));
        }
        this.step = this.step >= pat.len ? 0 : this.step + 1;
        continue;
      }
      this.renderPads(L, R, o, c);
      this.timer -= c;
      o += c;
    }
  }

  private event(e: number): void {
    const note = this.evNote[e];
    if (!note) return;
    if (this.evOn[e]) this.trigger(note); else this.release(note);
  }

  /** One of FL's Gen_Render calls. */
  private segment(L: Float32Array, R: Float32Array, off: number, n: number, ctx: GenContext): void {
    this.levels();
    this.padLevels();
    if (this.changed) { this.changed = false; this.timer = 0; this.step = 0; }
    const l = off ? L.subarray(off, off + n) : L, r = off ? R.subarray(off, off + n) : R;
    this.segOff = off;
    if (this.curPat >= 0) this.sequence(l, r, n, ctx);
    else this.renderPads(l, r, 0, n);
    // the master level on the main output (CSynthesizer 0x33888)
    const g = f32(this.masterG * 0.5);
    for (let i = 0; i < n; i++) {
      l[i] = f32(l[i] * this.gCurL);
      r[i] = f32(r[i] * this.gCurR);
      this.gCurL = fma(f32(g - this.gCurL), G005, this.gCurL);
      this.gCurR = fma(f32(g - this.gCurR), G005, this.gCurR);
    }
    // FL's wrapper forgets the notes that are off and have no pad left
    for (let i = 0; i < 128; i++) if (this.slots[i] && this.counts[i] === 0 && this.noteVel[i] === 0) this.slots[i] = null;
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    if (!this.started) { this.started = true; this.resetGains(); }
    if (this.padBuf.length === 0 || this.padBuf[0].length < n) this.padBuf = Array.from({ length: 2 * PADS }, () => new Float32Array(Math.max(n, CHUNK)));
    let e = 0, i = 0;
    while (i < n) {
      while (e < this.evCount && this.evFrame[e] <= i) this.event(e++);
      let end = n;
      if (e < this.evCount && this.evFrame[e] < n) end = this.evFrame[e];
      if (end > i) this.segment(L, R, i, end - i, ctx);
      i = end;
    }
    while (e < this.evCount) this.event(e++);
    this.evCount = 0;
    this.evNote.fill(null);
    // routed pads (mixer track offsets) go to their tracks: FL's extra outputs, no master section
    for (let k = 0; k < PADS; k++) {
      if (!this.padUsed[k]) continue;
      this.padUsed[k] = 0;
      const bl = this.padBuf[2 * k], br = this.padBuf[2 * k + 1];
      if (ctx.out) ctx.out(Math.max(0, Math.min(500, ctx.track + this.offsets[k])), bl, br, n);
      else for (let j = 0; j < n; j++) { L[j] = f32(L[j] + bl[j]); R[j] = f32(R[j] + br[j]); }
      bl.fill(0, 0, n); br.fill(0, 0, n);
    }
  }

  monitor(): FxMonitor {
    const lit: number[] = [];
    for (let k = 0; k < PADS; k++) lit.push(this.voices[k].active ? 1 : 0);
    return { pads: lit, step: this.curPat >= 0 ? (this.step + 63) % 64 : -1, pattern: this.curPat };
  }
}

void DX_GLOBAL;

export const gen: GenModule = {
  id: 'drumaxx',
  create: (sampleRate: number) => new Drumaxx(sampleRate),
};
