// Slicex (FL: Slicex, Generators > Drum): FL's beat slicer, reproduced from FL 2026's
// Slicex_x64.dylib (arm64 slice; docs/research/gen/slicex.md):
//
// - Notes (TriggerVoice 0x79860): the key (InitLevels pitch / 100) and the note colour's deck
//   (colour & 1; colours 15 / 16 play backwards) select the deck's key list (regions on that key,
//   0x7d3f0); every region on the key starts a voice, weighted by the layering mode and crossfade
//   curve; a region's cut group quick-releases the voices of its group; the voices of one note are
//   linked to the first one.
// - A voice (render 0x7bf50) reads its region with FL's TResampler (./slicex/resampler.ts) at the
//   region pitch, the note's pitch level (minus the key's own pitch: slices keep their pitch) and
//   the master pitch, through the articulator targets (envelope, LFO, maps: ./slicex/art.ts) every
//   control block (48 samples at 44.1 kHz, 4 with HQ envelopes or while rendering), the filter
//   (./slicex/filter.ts), FL's declicker (start inside the sample, end of the voice:
//   ./slicex/declick.ts), and mixes with FL's pan matrix and gain ramps (./slicex/mix.ts).
// - The voice ends after the note off once its envelopes are done, at the region end, or when
//   reverse playback reaches the region start: 20 ms release declick, then it is freed.

import type { GenContext, GenEnv, GenInstance, GenModule, GenNote } from '../types';
import type { FxMonitor } from '../../effects/types';
import type { InterpMode } from '../../../model/sampler';
import type { SxDeck, SxSettings, SxArt } from '../../../model/gen/plugins/slicex/types';
import { sxKeyLists, sxRegionEnd } from '../../../model/gen/plugins/slicex/state';
import { sxMasterGain, sxSignedLog } from '../../../model/gen/plugins/slicex/params';
import { ArtGroup } from './slicex/art';
import { Declicker } from './slicex/declick';
import { filterCoefs } from './slicex/filter';
import { mixRamp, panGains, rampTo } from './slicex/mix';
import { Voice } from './slicex/voice';
import { Curve, envRelease, mapAt } from './slicex/env';
import { exp, log, cos } from './slicex/libm';

const f32 = Math.fround;
const MAX_VOICES = 192;
const MAX_EVENTS = 256;
const LN2_HALF = 0.34657359027997264;
const OUTS = 8;
const EMPTY_DECK: SxDeck = { title: '', file: '', tempo: 0, beats: 0, regions: [] };
/** The 43 parameter keys of each articulator group. */
const ART_KEYS: string[][] = Array.from({ length: 8 }, (_, g) => {
  const out = [`g${g + 1}_fenv`, `g${g + 1}_fcut`, `g${g + 1}_fres`];
  for (const t of ['pan', 'vol', 'cut', 'res', 'spd']) for (const f of ['att', 'dec', 'sus', 'rel', 'lspd', 'lten', 'lskw', 'lpw']) out.push(`g${g + 1}_${t}_${f}`);
  return out;
});

interface DeckRT {
  L: Float32Array | null;
  R: Float32Array | null;
  rate: number;
  frames: number;
  regions: SxDeck['regions'];
  deck: SxDeck | null;
  /** Region record floats per region (FL 0x7f7e0). */
  recs: Float32Array;
  /** Cycle counters per key (layering mode Cycle). */
  readonly cycle: Int32Array;
}

/** Region record floats: pan, gain, amp amount, cut, res, filter amount, pitch, speed amount x 8, delay, start, start amount x 2. */
const RF = 11;

class Slicex implements GenInstance {
  private readonly sr: number;
  private readonly env: GenEnv;
  private readonly maxBlock: number;
  private readonly decks: DeckRT[] = [];
  private keyLists: number[][][] = [[], []];
  private readonly arts: ArtGroup[] = [];
  private opt: SxSettings | null = null;
  private sampleIds: (string | null)[] = [null, null];
  private readonly artSrc: unknown[] = new Array(8).fill(null);
  private readonly artParams: Float64Array[] = Array.from({ length: 8 }, () => new Float64Array(43).fill(NaN));
  private params: Record<string, unknown> = {};
  // master (FL +0x1090 .. +0x109c, +0x168 / +0x16c)
  private mGain = 1;
  private mPitch = 0;
  private randLevel = 1;
  private lfoLevel = 1;
  private modX = 256;
  private modY = 256;
  // rate dependent (FL +0x1060 control block, +0x1050 mod smoothing; rate object +0x20 / +0x28 / +0x40)
  private ctl = 48;
  private ctlK = 0;
  private smoothK = 1;
  private readonly invRate: number;
  private readonly isr: number;
  private readonly rampMax: number;
  private hqBase = 48;
  private tempo = 130;
  private interp = 1;
  private readonly declicker: Declicker;
  // voices (FL's voice list: creation order; rendered newest first)
  private readonly pool: Voice[] = [];
  private readonly list: Voice[] = [];
  private listN = 0;
  private readonly vbL: Float32Array;
  private readonly vbR: Float32Array;
  private readonly outL: Float32Array[] = [];
  private readonly outR: Float32Array[] = [];
  private readonly outOfs = new Int32Array(OUTS);
  private outUsed = 0;
  // events
  private readonly evFrame = new Int32Array(MAX_EVENTS);
  private readonly evNote: (GenNote | null)[] = new Array(MAX_EVENTS).fill(null);
  private readonly evOn = new Uint8Array(MAX_EVENTS);
  private evCount = 0;
  private rng = 0x2545f491;
  private globals: Curve[] = [];
  private wasPlaying = false;
  /** Velocity (0..1, FL's FPV_GetVelocity) of the last triggered note, for the editor's VEL map. */
  private lastVel = 0;
  /** Song position (beats) of the event being handled. */
  private evBeats = 0;
  private nextPos = 0;
  private lastKey = -1;

  constructor(sampleRate: number, blockSize: number, env: GenEnv) {
    this.sr = sampleRate;
    this.env = env;
    this.maxBlock = Math.max(16, blockSize);
    this.invRate = 1 / sampleRate;
    this.isr = f32(44100 / sampleRate);
    // FL's rate info +0x40 (10 x the f32 1 ms at 44.1 kHz step): gain ramps' largest step per frame
    this.rampMax = f32(f32(0.001 * (44100 / sampleRate)) * 10);
    this.declicker = new Declicker(sampleRate);
    this.vbL = new Float32Array(this.maxBlock);
    this.vbR = new Float32Array(this.maxBlock);
    for (let i = 0; i < OUTS; i++) { this.outL.push(new Float32Array(this.maxBlock)); this.outR.push(new Float32Array(this.maxBlock)); }
    for (let d = 0; d < 2; d++) {
      this.decks.push({ L: null, R: null, rate: sampleRate, frames: 0, regions: [], deck: null, recs: new Float32Array(0), cycle: new Int32Array(128) });
    }
    for (let i = 0; i < 8; i++) this.arts.push(new ArtGroup());
    for (let i = 0; i < MAX_VOICES; i++) { this.pool.push(new Voice(this.maxBlock)); this.list.push(this.pool[i]); }
    this.listN = 0;
    this.setCtl(false);
  }

  // ------------------------------------------------------------------ parameters

  private p(k: string): number {
    const v = this.params[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }

  /** FL 0x7d300 / 0x7d200: control block from the rate and HQ, smoothing coefficient, curve speeds. */
  private setCtl(rendering: boolean): void {
    const base = rendering || (this.opt?.hqEnv ?? false) ? 4 : 48;
    this.hqBase = base;
    const t = (this.sr * base) / 44100;
    let c = roundEven(t * 0.25) * 4;
    if (c < 4) c = 4;
    this.ctl = c;
    const k = (c * base) / (t * 96);
    this.ctlK = k;
    this.smoothK = f32(exp((-4.6051701859880909 * k) / 96));
    this.applySpeeds();
  }

  /** Curve time per control tick (FL 0x7d070 from +0x1064 = ctl 44100 / (sr 96)): seconds x 2 and beats. */
  private speeds(): [number, number] {
    const d = (this.ctlK * 96) / 44100;
    return [d * 2, (d * f32(this.tempo)) / 60];
  }

  private applySpeeds(): void {
    const [time, tempo] = this.speeds();
    for (const a of this.arts) for (const t of a.t) t.setSpeed(time, tempo);
  }

  setParams(raw: unknown): void {
    const p = (raw ?? {}) as Record<string, unknown>;
    this.params = p;
    this.mGain = sxMasterGain(this.p('master'));
    this.randLevel = sxSignedLog(this.p('rand') * 0.00390625);
    const lfo = sxSignedLog(this.p('lfo') * 0.0078125);
    const lfoChanged = lfo !== this.lfoLevel;
    this.lfoLevel = lfo;
    this.mPitch = Math.trunc(this.p('pitch'));
    this.modX = Math.trunc(this.p('modx'));
    this.modY = Math.trunc(this.p('mody'));
    const opt = (p.opt as SxSettings | undefined) ?? null;
    const sameChanged = (opt?.sameDeck ?? false) !== (this.opt?.sameDeck ?? false);
    this.opt = opt;
    // decks
    const deckSrc = [p.deckA as SxDeck | undefined, p.deckB as SxDeck | undefined];
    const ids = [p.sampleA, p.sampleB].map((x) => (typeof x === 'string' && x ? x : null));
    let keysDirty = sameChanged;
    for (let d = 0; d < 2; d++) {
      const rt = this.decks[d];
      const dk = deckSrc[d] ?? null;
      if (ids[d] !== this.sampleIds[d] || (ids[d] && !rt.L)) {
        this.sampleIds[d] = ids[d];
        const s = ids[d] ? this.env.sample(ids[d]!) : undefined;
        rt.L = s ? s.channels[0] ?? null : null;
        rt.R = s && s.channels.length > 1 ? s.channels[1] : null;
        rt.rate = s ? s.sampleRate : this.sr;
        rt.frames = rt.L ? rt.L.length : 0;
      }
      if (dk !== rt.deck) {
        rt.deck = dk;
        rt.regions = dk ? dk.regions : [];
        rt.recs = new Float32Array(rt.regions.length * RF);
        rt.regions.forEach((rg, i) => recFloats(rt.recs, i * RF, rg));
        keysDirty = true;
      }
    }
    if (keysDirty) this.keyLists = sxKeyLists(this.decks.map((d) => d.deck ?? EMPTY_DECK), opt?.sameDeck ?? false);
    // articulators: reload a group when its data, its parameters or the LFO level change
    const arts = p.arts as SxArt[] | undefined;
    if (Array.isArray(arts)) {
      let any = false;
      for (let g = 0; g < 8; g++) {
        if (!arts[g]) continue;
        let dirty = lfoChanged || arts[g] !== this.artSrc[g];
        const pv = this.artParams[g];
        for (let i = 0; i < 43; i++) {
          const v = this.p(ART_KEYS[g][i]);
          if (pv[i] !== v) { pv[i] = v; dirty = true; }
        }
        if (!dirty) continue;
        this.artSrc[g] = arts[g];
        const [time, tempo] = this.speeds();
        this.arts[g].load(arts[g], (k) => this.p(k), g, this.lfoLevel, time, tempo);
        any = true;
      }
      if (any) {
        this.globals = [];
        for (const a of this.arts) for (const t of a.t) if (t.lfo.m0 & 2) this.globals.push(t.lfo);
      }
    }
  }

  setInterpolation(m: InterpMode): void {
    this.interp = m === 'linear' ? 1 : m === 'hermite6' ? 3 : m === 'sinc24' ? 12 : m === 'sinc64' ? 32 : m === 'sinc128' ? 64 : m === 'sinc256' ? 128 : 256;
  }

  /** FL's Random (a fixed-seed generator: FL seeds its own from the clock). */
  private random(): number {
    let x = this.rng;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 4294967296;
  }

  // ------------------------------------------------------------------ notes

  private queue(note: GenNote, frame: number, on: number): void {
    if (this.evCount >= MAX_EVENTS) return;
    this.evFrame[this.evCount] = frame; this.evNote[this.evCount] = note; this.evOn[this.evCount++] = on;
  }

  noteOn(note: GenNote, frameOffset: number): void { this.queue(note, frameOffset, 1); }
  noteOff(note: GenNote, frameOffset: number): void { this.queue(note, frameOffset, 0); }

  killNote(note: GenNote): void {
    for (let i = 0; i < this.evCount; i++) if (this.evNote[i] === note) this.evNote[i] = null;
    for (let i = this.listN - 1; i >= 0; i--) {
      const v = this.list[i];
      if (v.note === note && v.parent === null) this.kill(v);
    }
  }

  isActive(): boolean {
    return this.listN > 0 || this.evCount > 0;
  }

  allNotesOff(): void {
    while (this.listN > 0) this.free(this.list[this.listN - 1]);
    this.evCount = 0;
    this.evNote.fill(null);
  }

  reset(): void {
    this.allNotesOff();
    for (const d of this.decks) d.cycle.fill(0);
  }

  private alloc(): Voice | null {
    for (const v of this.pool) if (!v.active) return v;
    return null;
  }

  private free(v: Voice): void {
    v.active = false;
    v.note = null;
    v.parent = null;
    v.next = null;
    for (let i = 0; i < this.listN; i++) {
      if (this.list[i] === v) {
        for (let j = i; j < this.listN - 1; j++) this.list[j] = this.list[j + 1];
        this.listN--;
        this.list[this.listN] = v;
        break;
      }
    }
  }

  /** FL's Voice_Kill (0x7b650): the voice and the layers linked after it stop at once. */
  private kill(v: Voice): void {
    let w: Voice | null = v;
    while (w) {
      const n: Voice | null = w.next;
      this.free(w);
      w = n;
    }
  }

  /** FL's quick release (0x7b540): to the release declick now. */
  private quickRelease(v: Voice): void {
    if (v.state < 9) v.state = 9;
    for (const ts of v.ts) { ts.env.stage = 9; ts.env.mode = 9; ts.lfo.stage = 9; ts.lfo.mode = 9; }
    this.declicker.release(v.dc, 0);
  }

  /** FL's Voice_Release (0x7b350) along the voice's layer chain. */
  private release(v: Voice): void {
    let w: Voice | null = v;
    while (w) {
      if (w.state < 5) w.state = 5;
      for (let t = 0; t < 6; t++) {
        const g = w.tg[t];
        if (g < 0) continue;
        const at = this.arts[g].t[t];
        envRelease(at.env, w.ts[t].env);
        envRelease(at.lfo, w.ts[t].lfo);
      }
      if (w.delay > 0) {
        w.state = 10;
        if (w.parent) w.parent.children--;
      }
      w = w.next;
    }
  }

  /** FL 0x7ce30: a region with a cut group quick-releases the playing voices of that group. */
  private cutGroup(g: number): void {
    for (let i = this.listN - 1; i >= 0; i--) {
      const v = this.list[i];
      if (v.rec.cut === g && v.first === 0) this.quickRelease(v);
    }
  }

  /** FL's TriggerVoice (0x79860). */
  private trigger(note: GenNote): void {
    const key = roundEven(f32(note.init.pitch * f32(0.01)));
    this.lastKey = key;
    const color = note.color | 0;
    const vel = flVelocity(note.init.vol);
    this.lastVel = vel;
    const deck = color & 1;
    if (key < 0 || key > 127) return;
    const list = this.keyLists[deck]?.[key];
    if (!list || list.length === 0) return;
    const count = list.length;
    const opt = this.opt;
    const lmode = opt?.lmode ?? 0, xfade = opt?.xfade ?? 3;
    let gain = 1;
    let pos = 0;
    let sel = 0;
    if (count > 1) {
      switch (lmode) {
        case 1: gain = f32(1 / count); break;
        case 2: pos = vel; break;
        case 3: pos = this.modX * 0.001953125; break;
        case 4: pos = this.modY * 0.001953125; break;
        case 5: pos = this.random(); break;
        case 6: {
          const dk = this.decks[deck];
          pos = (dk.cycle[key] % count) / (count - 1);
          dk.cycle[key]++;
          break;
        }
        default: pos = 0;
      }
      sel = roundEven(pos * count - 0.5);
      if (sel < 0) sel = 0;
      if (sel > count - 1) sel = count - 1;
    }
    let head: Voice | null = null;
    let prev: Voice | null = null;
    for (let j = 0; j < count; j++) {
      const e = list[j];
      const vd = e >> 16, r = e & 0xffff;
      const dk = this.decks[vd];
      if (!dk.L || r >= dk.regions.length) continue;
      const rg = dk.regions[r];
      if (rg.cut > 0) this.cutGroup(rg.cut);
      let w = gain;
      if (count > 1 && lmode > 1) {
        if (lmode === 7) {
          w = this.songWeight(vd, r, w);
          if (w > 0) w = xfade === 0 ? roundEven(w) : xfade === 1 ? w : xfadeCurve(xfade, w);
        } else if (xfade > 0) {
          w = f32(1 - Math.abs(pos * (count - 1) - j));
          if (w > 0) w = xfadeCurve(xfade, w);
        } else w = j === sel ? 1 : 0;
      }
      // FL starts a layer voice only above 2^-24 (TriggerVoice 0x7a2b0)
      if (!(w > 5.960464477539063e-8)) continue;
      const v = this.alloc();
      if (!v) break;
      this.startVoice(v, note, vd, r, key, color, vel, w);
      if (!v.active) continue;
      if (!head) head = v;
      else { v.parent = head; head.children++; if (prev) prev.next = v; }
      prev = v;
    }
  }

  private startVoice(v: Voice, note: GenNote, deck: number, r: number, key: number, color: number, vel: number, layerGain: number): void {
    const dk = this.decks[deck];
    const rg = dk.regions[r];
    const rec = v.rec;
    const o = r * RF;
    rec.cut = rg.cut; rec.out = rg.out;
    rec.pan = dk.recs[o]; rec.gain = f32(dk.recs[o + 1] * layerGain); rec.aAmt = dk.recs[o + 2];
    rec.fc = dk.recs[o + 3]; rec.fr = dk.recs[o + 4]; rec.fAmt = dk.recs[o + 5];
    rec.pitch = dk.recs[o + 6]; rec.sAmt8 = dk.recs[o + 7]; rec.delay = dk.recs[o + 8]; rec.ofs = dk.recs[o + 9]; rec.oAmt2 = dk.recs[o + 10];
    rec.aArt = rg.aArt; rec.fArt = rg.fArt; rec.sArt = rg.sArt; rec.oArt = rg.oArt;
    v.active = true;
    v.note = note;
    v.parent = null; v.next = null; v.children = 0;
    v.deck = deck; v.region = r; v.key = key;
    v.modX = this.modX; v.modY = this.modY;
    v.ix = clamp512(roundEven(f32(v.modX + f32(note.levels.fcut * 256))));
    v.iy = clamp512(roundEven(f32(v.modY + f32(note.levels.fres * 256))));
    v.gNew.fill(0);
    v.g.fill(0);
    // targets by section
    v.tg[0] = v.tg[1] = rg.aArt >= 0 && rg.aArt < 8 ? rg.aArt : -1;
    v.fst = -1;
    v.tg[2] = v.tg[3] = -1;
    if (rg.fArt >= 0 && rg.fArt < 8) {
      const a = this.arts[rg.fArt];
      v.ftype = a.ftype;
      v.fst = a.fstages - 1;
      if (v.fst > 2) v.fst = 2;
      if (v.fst >= 0) {
        v.tg[2] = v.tg[3] = rg.fArt;
        for (let s = 0; s <= v.fst; s++) v.stages[s].reset();
        let k = f32(v.fst + 1);
        if (v.ftype === 2) k = f32(1 / k);
        v.fscale = f32(k * LN2_HALF);
        v.fexp = f32(1 / (v.fst + 1));
      }
    }
    v.tg[4] = rg.sArt >= 0 && rg.sArt < 8 ? rg.sArt : -1;
    v.tg[5] = rg.oArt >= 0 && rg.oArt < 8 ? rg.oArt : -1;
    v.speedMod = false;
    for (let t = 0; t < 6; t++) {
      v.base[t] = t === 1 ? 1 : 0;
      const ts = v.ts[t];
      const g = v.tg[t];
      if (g < 0) {
        ts.kill();
        ts.value = v.base[t];
        continue;
      }
      const at = this.arts[g].t[t];
      if (t === 4 && (at.env.enabled !== 0 || at.lfo.enabled !== 0)) { v.base[4] = 1; v.speedMod = true; }
      if (at.velOn) v.base[t] = mapAt(at.maps[2], vel);
      if (at.randOn) {
        const rv = mapAt(at.maps[3], this.random());
        if (at.maps[3].offset === 0.5) v.base[t] = v.base[t] + rv * this.randLevel;
        else v.base[t] = v.base[t] * (1 + (rv - 1) * this.randLevel);
      }
      if (t === 5) {
        if (at.tabX) v.base[5] = combine(at.mode, v.base[5], at.tabX[v.ix]);
        if (at.tabY) v.base[5] = combine(at.mode, v.base[5], at.tabY[v.iy]);
      }
      at.noteOn(ts);
      if (at.env.enabled === 0 && at.lfo.enabled === 0) ts.value = v.base[t];
      else ts.value = combine(at.mode, ts.value, v.base[t]);
    }
    if (v.speedMod && v.base[4] * rec.sAmt8 === 0) v.speedMod = false;
    // delay in beats of the host tempo
    v.delay = rec.delay > 0 ? roundEven(f32(f32(f32(rec.delay * this.sr) * 60) / f32(this.tempo))) : 0;
    // sample reader
    const res = v.res;
    const start = rg.s;
    const end = sxRegionEnd(dk.deck!, r, dk.frames);
    res.setQuality(this.interp);
    const frames = Math.max(0, Math.min(end, dk.frames - 1) - start + 1);
    if (this.opt?.loopHalf) {
      const w24 = end - start;
      res.setRegion(dk.L!, dk.R, start, frames, true, Math.trunc((w24 + 1) / 2), w24);
    } else res.setRegion(dk.L!, dk.R, start, frames, false, 0, 0);
    v.lastPos = -2147483647;
    v.scrTh = f32(0.001 * dk.rate * 0.001 * this.ctl);
    v.scrInv = f32(1 / v.scrTh);
    v.baseSpeed = f32(dk.rate * this.invRate);
    if (color >= 14) v.baseSpeed = -v.baseSpeed;
    v.speed = v.baseSpeed;
    // sample start
    let d12 = rec.ofs + rec.oAmt2 * v.base[5];
    if (d12 > 0) {
      const len = end - start + 1;
      if (this.opt?.startWhole) d12 = (d12 < 1 ? d12 : 1) * len;
      else {
        const lim = 0.1 * this.sr;
        d12 = d12 * (len >= lim ? lim : len);
      }
    } else d12 = 0;
    if (v.baseSpeed < 0) d12 = (end - start) - d12;
    res.pos = d12 < 0 ? 0 : d12 > res.end ? res.end : d12;
    res.setSpeed(1);
    v.tick = -this.ctl;
    this.declicker.init(v.dc, res.pos > 0);
    rec.pitch = f32(rec.pitch + f32((60 - key) * 100));
    v.state = 1;
    v.first = 1;
    // FL appends the voice to its list
    for (let i = 0; i < this.listN; i++) if (this.list[i] === v) return;
    for (let i = this.listN; i < MAX_VOICES; i++) {
      if (this.list[i] === v) {
        this.list[i] = this.list[this.listN];
        this.list[this.listN] = v;
        break;
      }
    }
    this.listN++;
  }

  // ------------------------------------------------------------------ rendering

  /** FL's voice render (0x7bf50) for n frames at `o` of the block. */
  private renderVoice(v: Voice, L: Float32Array, R: Float32Array, o: number, n: number, ctx: GenContext): void {
    if (v.state >= 10) return;
    if (v.delay > 0) {
      v.delay -= n;
      if (v.delay >= 0) return;
      o += v.delay + n;
      n = -v.delay;
      v.delay = 0;
    }
    const note = v.note!;
    const lv = note.levels;
    const pitch = f32(f32(v.rec.pitch + f32(lv.pitch)) + this.mPitch);
    const pan = f32(v.rec.pan + f32(lv.pan));
    const velVol = this.opt?.velVol ?? true;
    let vol = f32(lv.vol);
    if (!velVol) { const iv = f32(note.init.vol); vol = iv > 0 ? f32(vol / iv) : vol; }
    vol = f32(f32(v.rec.gain * vol) * this.mGain);
    const vb = this.vbL, vr = this.vbR;
    let rem = n;
    let at = o;
    while (rem > 0) {
      if (v.tick <= 0) this.tick(v, pan, vol);
      const m = v.tick < rem ? v.tick : rem;
      const res = v.res;
      res.setPitch(pitch, v.speed);
      const got = res.renderAt(vb, vr, 0, m);
      if (got === m) {
        if (!v.speedMod && !(res.pos > 0) && v.state < 9) {
          v.state = 9;
          this.declicker.release(v.dc, 0);
        }
      } else if (!v.speedMod && v.state < 9) {
        v.state = 9;
        this.declicker.release(v.dc, got);
      }
      if (v.fst >= 0) {
        let cut = v.rec.fc, rs = v.rec.fr;
        const g = v.tg[2];
        if (g >= 0) {
          const a = this.arts[g];
          cut = cut + (a.fcOfs + v.ts[2].value) * v.rec.fAmt;
          rs = rs + (a.frOfs + v.ts[3].value) * v.rec.fAmt;
        }
        filterCoefs(v.stages, v.fst + 1, v.ftype, cut, rs, v.fexp, v.fscale, this.isr);
        for (let s = 0; s <= v.fst; s++) v.stages[s].process(vb, vr, 0, m);
      }
      this.declicker.process(v.dc, vb, vr, 0, m);
      let dL = L, dR = R, dO = at;
      if (v.rec.out !== 0) {
        const k = this.outBuf(v.rec.out, ctx);
        if (k >= 0) { dL = this.outL[k]; dR = this.outR[k]; }
      }
      mixRamp(vb, vr, 0, dL, dR, dO, m, v.g);
      const g = v.g;
      for (let i = 0; i < 4; i++) g[i] = f32(g[i] + f32(g[4 + i] * m));
      v.first = 0;
      v.tick -= m;
      rem -= m;
      at += m;
    }
    if (v.state >= 9 && v.state < 10 && this.declicker.done(v.dc)) {
      v.state = 10;
      if (v.parent) v.parent.children--;
    }
  }

  /** The control tick of a voice: modulation, targets, gains (FL 0x7c058 .. 0x7c70c). */
  private tick(v: Voice, pan: number, vol: number): void {
    let step: number;
    if (v.tick < 0) { v.tick = -v.tick; step = 0; } else { v.tick = this.ctl; step = 1; }
    if (v.state >= 5) v.state = 9;
    const note = v.note!;
    if (this.opt?.smooth ?? true) {
      v.modX = f32(this.modX + f32(f32(v.modX - this.modX) * this.smoothK));
      v.modY = f32(this.modY + f32(f32(v.modY - this.modY) * this.smoothK));
    } else { v.modX = this.modX; v.modY = this.modY; }
    v.ix = clamp512(roundEven(f32(v.modX + f32(f32(note.levels.fcut) * 256))));
    v.iy = clamp512(roundEven(f32(v.modY + f32(f32(note.levels.fres) * 256))));
    for (let t = 0; t < 6; t++) {
      const g = v.tg[t];
      if (g < 0) continue;
      const at = this.arts[g].t[t];
      const ts = v.ts[t];
      ts.value = v.base[t];
      if (at.tabX) ts.value = combine(at.mode, ts.value, at.tabX[v.ix]);
      if (at.tabY) ts.value = combine(at.mode, ts.value, at.tabY[v.iy]);
      at.process(ts, step);
      if (v.state >= 5) {
        const s = ts.env.stage < ts.lfo.stage ? ts.env.stage : ts.lfo.stage;
        if (v.state > s) v.state = s;
      }
    }
    if (v.state >= 9) this.declicker.release(v.dc, 0);
    // gains
    let p = f32(pan + v.ts[0].value * 2 * v.rec.aAmt);
    if (p < -1) p = -1; else if (p > 1) p = 1;
    const vv = f32(vol * (1 + (v.ts[1].value - 1) * v.rec.aAmt));
    panGains(v.gNew, 0, p, vv);
    if (v.speedMod) {
      v.speed = f32((1 + v.ts[4].value * v.rec.sAmt8) * v.baseSpeed);
      if (v.dc.r < 0) {
        let d = f32(v.lastPos - v.res.pos);
        if (Math.abs(d) < v.scrTh) {
          d = f32(d * v.scrInv);
          for (let i = 0; i < 4; i++) v.gNew[i] = f32(v.gNew[i] * d);
        }
        v.lastPos = v.res.pos;
      }
    }
    if (v.first > 0) for (let i = 0; i < 4; i++) v.g[8 + i] = v.gNew[i];
    for (let i = 0; i < 4; i++) rampTo(v.g, i, v.gNew[i], this.ctl, this.rampMax);
  }

  /** An extra output buffer for a mixer track offset (FL's GetOutBuffer); -1 = main. */
  private outBuf(ofs: number, ctx: GenContext): number {
    if (!ctx.out) return -1;
    for (let i = 0; i < this.outUsed; i++) if (this.outOfs[i] === ofs) return i;
    if (this.outUsed >= OUTS) return -1;
    const k = this.outUsed++;
    this.outOfs[k] = ofs;
    this.outL[k].fill(0); this.outR[k].fill(0);
    return k;
  }

  private segment(L: Float32Array, R: Float32Array, o: number, n: number, ctx: GenContext): void {
    for (let i = this.listN - 1; i >= 0; i--) {
      const v = this.list[i];
      if (v.active) this.renderVoice(v, L, R, o, n, ctx);
    }
    // FL frees finished voices (the host's Voice_Kill after the plugin's request)
    for (let i = this.listN - 1; i >= 0; i--) {
      const v = this.list[i];
      if (v.state >= 10 && v.children <= 0 && v.parent === null) this.kill(v);
    }
    // global LFO phases run with time (Gen_Render's +0x1358 list)
    const d8 = n / this.ctl;
    for (const c of this.globals) c.gphase = (c.gphase + (roundEven(d8 * c.incU) >>> 0)) >>> 0;
  }

  /**
   * Song-time-synced layering (TriggerVoice 0x79d84): the song position folded into the deck's loop
   * (its length in beats at its tempo) weighs each layered region by its distance from the region's
   * start: inside the region 1 - (pos - start) / length, before it 1 - (start - pos) / (start -
   * previous start + 1). Decks without a tempo keep `w`.
   */
  private songWeight(d: number, r: number, w: number): number {
    const dk = this.decks[d], deck = dk.deck;
    if (!deck || !(deck.tempo > 0) || !dk.L) return w;
    const frames = dk.frames, rate = dk.rate;
    const loopBeats = (frames * deck.tempo) / (rate * 60);
    const k = Math.trunc(this.evBeats / loopBeats);
    const posBeats = this.evBeats - k * loopBeats;
    const pos = (posBeats * rate * 60) / deck.tempo;
    const regs = dk.regions;
    const prev = regs[Math.max(0, r - 1)].s, start = regs[r].s;
    const end = sxRegionEnd(deck, r, frames);
    return pos < start ? f32(1 - (start - pos) / (start - prev + 1)) : f32(1 - (pos - start) / (end - start + 1));
  }

  /**
   * FL re-syncs the global LFOs to the song position when playback starts or jumps (FPD_SetPlaying /
   * FPD_SongPosChanged / FPD_SetTimeSig -> 0x7fd40, only while playing): phase = start phase +
   * round(control ticks since the song start x increment) (0x27e030 / 0x7fec0).
   */
  private syncGlobals(ctx: GenContext): void {
    const den = f32(f32(f32(f32(this.tempo) * f32(ctx.ppq)) * f32(this.ctl)) * 4);
    const t = (ctx.pos * this.sr * 240) / den;
    for (const c of this.globals) c.gphase = (c.lfo.startPhase() + c.ph + (roundEven(t * c.incU) >>> 0)) >>> 0;
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    if (ctx.tempo !== this.tempo && ctx.tempo > 0) { this.tempo = ctx.tempo; this.applySpeeds(); }
    const hq = ctx.rendering || this.opt?.hqEnv ? 4 : 48;
    if (hq !== this.hqBase) { this.setCtl(!!ctx.rendering); this.artSrc.fill(null); }
    if (ctx.playing) {
      if (!this.wasPlaying || Math.abs(ctx.pos - this.nextPos) > 1) this.syncGlobals(ctx);
      this.nextPos = ctx.pos + (n * ctx.ppq * this.tempo) / (60 * this.sr);
    }
    this.wasPlaying = ctx.playing;
    this.outUsed = 0;
    let e = 0, i = 0;
    while (i < n) {
      while (e < this.evCount && this.evFrame[e] <= i) {
        // song position in beats at the event (FL: FHD_GetMixingTime, GT_Beats)
        this.evBeats = Math.max(0, (ctx.pos + (ctx.playing ? (this.evFrame[e] * ctx.ppq * this.tempo) / (60 * this.sr) : 0)) / (ctx.ppq || 96));
        this.event(e++);
      }
      let end = n;
      if (e < this.evCount && this.evFrame[e] < n) end = this.evFrame[e];
      if (end > i) this.segment(L, R, i, end - i, ctx);
      i = end;
    }
    while (e < this.evCount) {
      this.evBeats = Math.max(0, (ctx.pos + (ctx.playing ? (n * ctx.ppq * this.tempo) / (60 * this.sr) : 0)) / (ctx.ppq || 96));
      this.event(e++);
    }
    this.evCount = 0;
    this.evNote.fill(null);
    for (let k = 0; k < this.outUsed; k++) {
      if (ctx.out) ctx.out(Math.max(0, Math.min(500, ctx.track + this.outOfs[k])), this.outL[k], this.outR[k], n);
    }
  }

  private event(e: number): void {
    const note = this.evNote[e];
    if (!note) return;
    if (this.evOn[e]) this.trigger(note);
    else {
      for (let i = 0; i < this.listN; i++) {
        const v = this.list[i];
        if (v.note === note && v.parent === null) { this.release(v); break; }
      }
    }
  }

  monitor(): FxMonitor {
    const play: number[] = [];
    for (let i = 0; i < this.listN; i++) {
      const v = this.list[i];
      if (v.active && v.state < 10) play.push(v.deck, v.region, v.res.pos);
    }
    return { play, key: this.lastKey, vel: this.lastVel };
  }
}


/** Combine a value with a modulation by the target's mode (FL: 0 multiply, 1 add, else x 2). */
function combine(mode: number, v: number, m: number): number {
  if (mode === 0) return v * m;
  if (mode === 1) return v + m;
  return v * m * 2;
}

/** FL's crossfade curves (TriggerVoice): 1 linear, 2 balanced, 3 unbalanced, 4 adding. */
function xfadeCurve(mode: number, s: number): number {
  switch (mode) {
    case 2: return f32((cos(f32(1 - s) * Math.PI) + 1) * 0.5);
    case 3: return f32(1 - f32(f32(exp(f32(1 - s) * 2.1972245773362196) - 1) * 0.125));
    case 4: return s < 0.5 ? f32((cos(f32(1 - f32(s * 2)) * Math.PI) + 1) * 0.5) : 1;
    default: return s;
  }
}

/** Region record floats (FL 0x7f7e0). */
function recFloats(out: Float32Array, o: number, rg: SxDeck['regions'][number]): void {
  out[o] = f32(rg.pan * f32(0.000156249997));
  const v = f32(rg.vol * 0.000125);
  out[o + 1] = v === 1 ? 1 : f32((exp(f32(v * f32(1.0986123085021973))) - 1) * 0.5);
  out[o + 2] = f32(rg.aAmt * f32(7.81249983e-5));
  out[o + 3] = f32(rg.fc * 0.00390625);
  out[o + 4] = f32(rg.fr * 0.00390625);
  out[o + 5] = f32(rg.fAmt * f32(7.81249983e-5));
  out[o + 6] = f32(rg.pitch);
  out[o + 7] = f32(rg.sAmt * f32(f32(7.81249983e-5) * 8));
  out[o + 8] = f32(rg.delay * f32(7.81249983e-5));
  out[o + 9] = f32(rg.ofs * f32(7.81249983e-5));
  out[o + 10] = f32(rg.oAmt * f32(f32(7.81249983e-5) * 2));
}

/** FL's FPV_GetVelocity (FLEngine 0x42d0b4): 0.78125 ln(10 InitLevels.Vol + 1) / ln 11, in float. */
function flVelocity(vol: number): number {
  const s = f32(f32(f32(vol) * 10) + 1);
  const r = f32(log(s) * f32(1 / 2.397895336151123));
  return f32(r * 0.78125);
}

function clamp512(x: number): number {
  return x < 0 ? 0 : x > 512 ? 512 : x;
}

function roundEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export const gen: GenModule = {
  id: 'slicex',
  create: (sampleRate: number, blockSize: number, env: GenEnv) => new Slicex(sampleRate, blockSize, env),
};
