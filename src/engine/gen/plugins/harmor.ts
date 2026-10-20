// Harmor (FL: Harmor) engine: FL's Gen_Render instrument with its own voices
// ('events'), ported from Harmor_x64 (docs/research/gen/harmor.md): an additive
// / resynthesis synth with two parts; every note starts one voice per enabled
// part and unison voice, each a bank of up to 520 sine oscillators (sub-harmonics
// + 516 harmonics) whose levels the part's timbres, unit chain (filters, phaser,
// harmonizer, prism, blur, pluck, protection, clipping) and articulators shape
// once per control block; voices mix into an effects bus and a dry bus, the
// effects bus runs through the global effects (distortion, chorus, delay,
// reverb, compression) and the dry bus joins at its place in the effect order.

import type { GenContext, GenInstance, GenModule, GenNote } from '../types';
import type { FxMonitor } from '../../effects/types';
import type { FxParams } from '../../../model/fx/types';
import { normalizeHarmor, harmorPart, harmorGlobal } from '../../../model/gen/plugins/harmor/state';
import { HARMOR_PARAMS, PARAM_COUNT } from '../../../model/gen/plugins/harmor/params';
import type { HPart, HGlobal } from '../../../model/gen/plugins/harmor/types';
import { PlugDsp, PartDsp } from './harmor/core';
import { HVoice, RenderCtx, type VoiceNote } from './harmor/voice';
import { ArtPart } from './harmor/art';
import { randUniform32f, tone32f } from './harmor/ipp';
import { HarmorFx } from './harmor/fx';

/** Mersenne Twister MT19937 (FL's Tmt19937: init_genrand, genrand_int32). */
class MT19937 {
  private readonly mt = new Uint32Array(624);
  private i = 625;
  constructor(seed: number) {
    const mt = this.mt;
    mt[0] = seed >>> 0;
    for (let k = 1; k < 624; k++) {
      const x = mt[k - 1] ^ (mt[k - 1] >>> 30);
      mt[k] = (Math.imul(1812433253, x) + k) >>> 0;
    }
    this.i = 624;
  }
  next(): number {
    const mt = this.mt;
    if (this.i >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.i = 0;
    }
    let y = mt[this.i++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
}

const MAX_VOICES = 256;

function roundEvenF(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && (r & 1) !== 0 ? r - 1 : r;
}
const KILL_FADE = 64;

interface Pending { kind: 0 | 1 | 2; note: GenNote; off: number }

interface NoteVoices { note: GenNote; lv: VoiceNote; voices: HVoice[]; tag: number }

class Harmor implements GenInstance {
  private readonly sr: number;
  private readonly maxBlock: number;
  private readonly plug: PlugDsp;
  private readonly artParts = [new ArtPart(), new ArtPart()];
  private readonly pool: HVoice[] = [];
  private readonly free: HVoice[] = [];
  private readonly live: HVoice[] = [];
  private readonly notes = new Map<number, NoteVoices>();
  private readonly events: Pending[] = [];
  private readonly ctx: RenderCtx;
  private readonly bus0: Float32Array;
  private readonly bus1: Float32Array;
  private readonly used = [false, false];
  private st: FxParams | null = null;
  private rawA: unknown = null;
  private rawB: unknown = null;
  private rawG: unknown = null;
  private lastA: HPart | null = null;
  private lastB: HPart | null = null;
  private lastG: HGlobal | null = null;
  /** plug+0xe98: FL's Tmt19937 (seeded with 1 like the test host; FL seeds it from the clock). */
  private readonly mt = new MT19937(1);
  private readonly seed28 = new Uint32Array(1);
  private readonly uniRand = new Float32Array(64);
  private readonly tremL: Float32Array;
  private readonly tremR: Float32Array;
  private readonly tremP = new Float32Array(1);
  private readonly fx: HarmorFx;
  private readonly fxL: Float32Array;
  private readonly fxR: Float32Array;
  private readonly dryL: Float32Array;
  private readonly dryR: Float32Array;
  private rendering = false;
  private wasPlaying = false;
  private expectPos = 0;
  private tempo = 120;
  private arpDirty = false;
  private maxPoly = 0;
  /** plug+0xe78: rendered samples (voice age stamps). */
  private time = 0;
  private readonly arpKeys: number[] = [];
  tail = 2;

  constructor(sr: number, blockSize: number) {
    this.sr = sr;
    this.maxBlock = Math.max(blockSize, 128) * 4;
    this.plug = new PlugDsp(sr);
    this.ctx = new RenderCtx(this.maxBlock);
    this.bus0 = new Float32Array(this.maxBlock * 2);
    this.bus1 = new Float32Array(this.maxBlock * 2);
    this.tremL = new Float32Array(this.maxBlock);
    this.tremR = new Float32Array(this.maxBlock);
    this.fx = new HarmorFx(sr, this.maxBlock);
    this.fxL = new Float32Array(this.maxBlock);
    this.fxR = new Float32Array(this.maxBlock);
    this.dryL = new Float32Array(this.maxBlock);
    this.dryR = new Float32Array(this.maxBlock);
  }

  setParams(p: unknown): void {
    const raw = (p ?? {}) as FxParams;
    // Normalise (preset expansion, curve repair) only when the curve objects change;
    // parameter-only edits / automation read the values directly.
    let st = this.st;
    if (!st || typeof raw.__h === 'number' || raw.hA !== this.rawA || raw.hB !== this.rawB || raw.hG !== this.rawG) {
      st = normalizeHarmor(raw);
      this.st = st;
      this.rawA = raw.hA; this.rawB = raw.hB; this.rawG = raw.hG;
    }
    const src = typeof raw.__h === 'number' ? st : raw;
    const plug = this.plug, P = plug.p;
    for (let i = 0; i < PARAM_COUNT; i++) {
      const d = HARMOR_PARAMS[i];
      const v = src[d.key];
      P[i] = typeof v === 'number' && Number.isFinite(v) ? Math.max(d.min, Math.min(d.max, v)) | 0 : d.def | 0;
    }
    const g = harmorGlobal(st);
    if (g !== this.lastG) {
      this.lastG = g;
      plug.g = g;
      plug.precision = g.precision | 0;
      plug.mono = g.mono | 0;
      plug.voiceRand = g.voiceRand | 0;
      plug.sameRand = g.sameRand !== 0;
      plug.modSmooth = g.modSmooth !== 0;
      plug.setRate(g.grain | 0 || 200, false);
      this.lastA = this.lastB = null;
    }
    for (let k = 0; k < 2; k++) {
      const hp = harmorPart(st, k ? 'b' : 'a');
      const last = k ? this.lastB : this.lastA;
      if (hp !== last) {
        plug.setPart(plug.parts[k], hp);
        this.artParts[k].setup(hp.arts, src as Record<string, unknown>, k ? 'b' : 'a', plug.tempo, this.sr, plug.blk);
        if (k) this.lastB = hp; else this.lastA = hp;
      }
    }
    plug.applyAll();
    this.fx.setParams(src.hG ? src as Record<string, unknown> : { ...src, hG: st.hG });
    this.tail = this.fx.tail();
  }

  reset(): void {
    for (const v of this.live) this.freeVoice(v);
    this.live.length = 0;
    this.fx.reset();
    this.notes.clear();
    this.events.length = 0;
  }

  noteOn(note: GenNote, off: number): void { this.events.push({ kind: 0, note, off }); }
  noteOff(note: GenNote, off: number): void { this.events.push({ kind: 1, note, off }); }
  killNote(note: GenNote): void {
    const nv = this.notes.get(note.id);
    if (!nv) return;
    for (const v of nv.voices) v.release();
    this.notes.delete(note.id);
  }
  allNotesOff(): void { this.reset(); }
  setMaxPoly(n: number): void { this.maxPoly = n > 0 ? n : 0; }
  /** Editor data: playing keys and the partial levels of the most recent voice (FL's visual feedback). */
  monitor(): FxMonitor {
    const keys: number[] = [];
    for (const nv of this.notes.values()) if (!keys.includes(nv.note.key)) keys.push(nv.note.key);
    const partials: number[] = [];
    const v = this.live[this.live.length - 1];
    if (v) {
      const A = v.sb.amps, n = Math.min(v.sb.count, 520);
      for (let i = 4; i < n; i++) partials.push(Math.min(1, Math.abs(A[i])));
    }
    return { keys, partials };
  }

  isActive(): boolean { return this.live.length > 0 || this.events.length > 0 || this.fx.tail() === Infinity; }

  private alloc(): HVoice | null {
    let v = this.free.pop();
    if (!v) {
      if (this.pool.length >= MAX_VOICES) return null;
      v = new HVoice(this.maxBlock);
      this.pool.push(v);
    }
    return v;
  }

  private freeVoice(v: HVoice): void {
    v.dead = true;
    this.free.push(v);
  }

  /** TriggerVoice (0xda2d0): one voice per enabled part and unison voice. */
  private start(note: GenNote): void {
    const plug = this.plug;
    const lv: VoiceNote = {
      initPitch: note.init.pitch, pan: note.levels.pan, vol: note.levels.vol,
      pitch: note.levels.pitch - 6000, fcut: note.levels.fcut, fres: note.levels.fres,
      vel: note.velocity / 128, rel: (2 * note.release) / 128,
    };
    const nv: NoteVoices = { note, lv, voices: [], tag: note.color & 15 };
    // monophonic modes (0xda650): 1 kill same note, 2 kill all, 3 release all
    if (plug.mono > 0) {
      for (const v of this.live) {
        if (v.kind !== 0 || v.state >= 9) continue;
        if (plug.mono <= 1 && v.pitch0 !== lv.initPitch) continue;
        if (plug.mono === 3) { if (v.state < 6) v.release(); } else v.end();
      }
    }
    // FL's max polyphony (FPE_MaxPoly, 0xda768): count the voice heads, end the oldest
    if (this.maxPoly > 0) {
      let heads = 0, oldest: HVoice | null = null;
      for (const v of this.live) {
        if (v.stamp === Infinity || v.state >= 9) continue;
        heads++;
        if (!oldest || v.stamp < oldest.stamp) oldest = v;
      }
      if (heads >= this.maxPoly && oldest) {
        const nvo = [...this.notes.values()].find((x) => x.voices.includes(oldest!));
        for (const v of nvo ? nvo.voices : [oldest]) v.end();
      }
    }
    let color = note.color & 15;
    // legato (0xda4a0): Legato on XOR colour 13 (colour 0 then): the closest held note of the colour within the
    // legato pitch limit hands its voices over (FL swaps the voice bodies, 0xe75b0) and they glide to the new note
    const legato = (plug.p[776] > 0) !== (color === 13);
    if (legato && plug.p[776] === 0) color = 0;
    if (legato) {
      let lim = Math.fround(plug.legatoLimit);
      let held: NoteVoices | null = null;
      for (const o of this.notes.values()) {
        const v0 = o.voices[0];
        if (!v0 || v0.kind !== 0 || v0.state >= 6 || o.tag !== color) continue;
        const d = Math.abs(Math.fround(lv.initPitch - o.lv.initPitch));
        if (d <= lim) { held = o; lim = d; }
      }
      if (held) {
        const o = held.lv, v0 = held.voices[0];
        const rec = new Float32Array([o.pan, o.vol, o.pitch, o.fcut, o.fres, v0.vel]);
        for (const v of held.voices) {
          v.note = lv;
          v.vel = lv.vel;
          v.velPorta = plug.p[778] > 0 ? Math.fround(Math.fround(1 - lv.vel * 0.85) * Math.fround(1 - lv.vel * 0.85)) : 1;
          v.portaFrom(rec, false, false);
        }
        nv.voices = held.voices;
        held.voices = [];
        nv.tag = color;
        this.notes.set(note.id, nv);
        this.arpDirty = true;
        const r = plug.lastNote[color];
        r[0] = lv.pan; r[1] = lv.vol; r[2] = lv.pitch; r[3] = lv.fcut; r[4] = lv.fres; r[5] = lv.vel;
        return;
      }
    }
    // portamento (0xda840): Porta on XOR colour 14 (colour 0 then), from the colour's last note
    let porta = (plug.p[777] > 0) !== (color === 14);
    if (porta && plug.p[777] === 0) color = 0;
    const rec = plug.lastNote[color];
    porta = porta && rec[2] === rec[2];
    nv.tag = color;
    // plug+0x2d28: highest articulator with a note-on random mapping over both parts (0 with same random)
    const randCount = plug.sameRand ? 0 : Math.max(this.artParts[0].randMax, this.artParts[1].randMax);
    const seed = this.seed28;
    seed[0] = this.mt.next() >>> 1;
    let newRand = true;
    let carry = 0;
    let rtab: Float32Array | null = null;
    for (let k = 0; k < 2; k++) {
      const part = plug.parts[k];
      if (!part.on) continue;
      const n = Math.max(1, part.uniN);
      let randoms: Float32Array | null = null;
      if (part.uniDist === 3) {
        randoms = this.uniRand;
        randUniform32f(randoms, n, -part.uniD4, part.uniD4, seed);
      }
      // poly release scale (0xda938): released voices (any part) not yet scaled take this part's factor
      if (part.polyRel !== 1) {
        for (const v of this.live) {
          if (v.kind !== 0 || v.state !== 6 || v.i228 !== 0) continue;
          v.arts.scalePolyRelease(this.artParts[k], part.polyRel);
          v.i228 = 1;
        }
      }
      let shared: HVoice | null = null;
      for (const lvv of this.live) if (lvv.part === part && lvv.kind === 0 && lvv.state < 6) { shared = lvv; break; }
      for (let u = 0; u < n; u++) {
        const v = this.alloc();
        if (!v) break;
        // V+0x15c: the voice's own Mersenne Twister draw (0xdb15c)
        const vseed = this.mt.next() >>> 1;
        carry = v.trigger(plug, part, this.artParts[k], lv, u, seed, vseed, newRand, carry, randCount, randoms, shared, rtab);
        rtab = v.usedRtab;
        v.stamp = u === 0 ? this.time : Infinity;
        this.live.push(v);
        nv.voices.push(v);
        newRand = plug.voiceRand === 3; // per unison voice
      }
      newRand = plug.voiceRand >= 2; // per part voice
    }
    this.notes.set(note.id, nv);
    this.arpDirty = true;
    const first = nv.voices[0];
    if (first) {
      if (porta) for (const v of nv.voices) v.portaFrom(rec, true, true);
      // 0xe74a0: this note's levels become the colour's porta source
      rec[0] = lv.pan; rec[1] = lv.vol; rec[2] = lv.pitch; rec[3] = lv.fcut; rec[4] = lv.fres; rec[5] = first.vel;
    }
  }


  private stop(note: GenNote): void {
    const nv = this.notes.get(note.id);
    if (!nv) return;
    for (const v of nv.voices) v.release();
    this.notes.delete(note.id);
    this.arpDirty = true;
  }

  /**
   * Gen_Render 0xe8ba0: after a note started or was released (plug+0xea0) and a part
   * has arpeggio envelopes (plug+0x114d): each sounding voice's arpeggio index = the
   * rank of its note among the distinct sounding notes (descending with Invert arpeggiator).
   */
  private arpeggio(): void {
    this.arpDirty = false;
    if (!this.artParts[0].hasArp && !this.artParts[1].hasArp) return;
    const keys = this.arpKeys;
    keys.length = 0;
    for (const v of this.live) if (v.kind === 0 && v.state < 6 && !keys.includes(v.pitch0)) keys.push(v.pitch0);
    keys.sort((a, b) => a - b);
    if (this.plug.p[788] !== 0) keys.reverse();
    for (const v of this.live) if (v.state < 6) v.arts.setArp(v.ap, keys.indexOf(v.pitch0), keys.length);
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    if (ctx.tempo && ctx.tempo !== this.tempo) {
      this.tempo = ctx.tempo;
      this.plug.setTempo(Math.fround(ctx.tempo));
      for (let k = 0; k < 2; k++) {
        if (this.artParts[k].setTimeBase(Math.fround(ctx.tempo), this.sr, this.plug.blk)) {
          for (const v of this.live) if (v.ap === this.artParts[k]) v.arts.rescale(v.ap);
        }
      }
    }
    // global LFOs follow the song position while playing (0xee250 on transport start / position jumps)
    if (ctx.playing) {
      const jump = !this.wasPlaying || Math.abs(ctx.pos - this.expectPos) > 1;
      if (jump) {
        const blocks = (ctx.pos * this.sr * 240) / (this.tempo * (ctx.ppq || 96) * this.plug.blk * 4);
        this.artParts[0].syncGlobalLfo(blocks);
        this.artParts[1].syncGlobalLfo(blocks);
      }
      this.expectPos = ctx.pos + (n / this.sr) * (this.tempo / 60) * (ctx.ppq || 96);
    }
    this.wasPlaying = ctx.playing;
    const rendering = !!ctx.rendering;
    if (rendering !== this.rendering) { this.rendering = rendering; this.fx.setRendering(rendering); }
    this.events.sort((a, b) => a.off - b.off);
    let pos = 0;
    let ei = 0;
    while (pos < n) {
      while (ei < this.events.length && this.events[ei].off <= pos) {
        const e = this.events[ei++];
        if (e.kind === 0) this.start(e.note); else this.stop(e.note);
      }
      const end = ei < this.events.length ? Math.min(n, Math.max(pos + 1, this.events[ei].off)) : n;
      this.segment(L, R, pos, end - pos);
      pos = end;
    }
    while (ei < this.events.length) {
      const e = this.events[ei++];
      if (e.kind === 0) this.start(e.note); else this.stop(e.note);
    }
    this.events.length = 0;
    // refresh live levels of sounding notes
    for (const nv of this.notes.values()) {
      const l = nv.note.levels;
      nv.lv.pan = l.pan; nv.lv.vol = l.vol; nv.lv.pitch = l.pitch - 6000; nv.lv.fcut = l.fcut; nv.lv.fres = l.fres;
    }
  }

  /** Gen_Render 0xe82ec..0xe8530: the part's tremolo gains for this call (part+0x658). */
  private tremolo(pt: PartDsp, m: number): void {
    pt.tremOn = false;
    if (pt.tremRamp.silent()) return;
    if (this.live.length === 0) { pt.tremRamp.cL = pt.tremRamp.tL; pt.tremRamp.cR = pt.tremRamp.tR; return; }
    if (pt.trem.length < 2 * this.maxBlock) pt.trem = new Float32Array(2 * this.maxBlock);
    const TL = this.tremL, TR = this.tremR, T = pt.trem, ph = this.tremP;
    const TWO_PI_F = 6.2831854820251465;
    const s8 = Math.fround(pt.tremPh * TWO_PI_F);
    ph[0] = s8 >= TWO_PI_F ? Math.fround(s8 - TWO_PI_F) : s8;
    tone32f(TL, m, 0.550000011920929, pt.tremSpeed, ph);
    const p2 = Math.fround(s8 + Math.fround(pt.tremGap * 2));
    ph[0] = p2 >= TWO_PI_F ? Math.fround(p2 - TWO_PI_F) : p2;
    tone32f(TR, m, 0.550000011920929, pt.tremSpeed, ph);
    for (let i = 0; i < m; i++) { T[2 * i] = TL[i]; T[2 * i + 1] = TR[i]; }
    for (let i = 0; i < 2 * m; i++) {
      const a = Math.fround(T[i] + 0.550000011920929);
      T[i] = Math.fround(0.20999999344348907 - Math.fround(a * a));
    }
    pt.tremRamp.mulStereo(T, T, m);
    for (let i = 0; i < 2 * m; i++) T[i] = Math.fround(T[i] + 1);
    pt.tremOn = true;
  }

  /** One Gen_Render call: voices into the buses, buses through the effects, post volume. */
  private segment(L: Float32Array, R: Float32Array, off: number, n: number): void {
    const b0 = this.bus0, b1 = this.bus1;
    for (let done = 0; done < n; ) {
      const m = Math.min(n - done, this.maxBlock);
      b0.fill(0, 0, m * 2); b1.fill(0, 0, m * 2);
      this.used[0] = this.used[1] = false;
      if (this.arpDirty) this.arpeggio();
      for (const pt of this.plug.parts) if (pt.on) this.tremolo(pt, m);
      const voices = this.live.length;
      for (let i = 0; i < this.live.length; i++) {
        const v = this.live[i];
        if (!v.render(m, this.ctx, b0, b1, 0, this.used)) {
          this.freeVoice(v);
          this.live.splice(i, 1);
          i--;
        }
      }
      this.time += m;
      // global LFOs advance (0xe8fc0), then the end of Gen_Render (0xe9300)
      this.artParts[0].advanceGlobalLfo(m);
      this.artParts[1].advanceGlobalLfo(m);
      // vibrato phase (wrapped to -0.5..0.5), phaser / tremolo phases and the part sample counter
      for (const pt of this.plug.parts) {
        const ph = Math.fround(pt.vibPh + Math.fround(pt.vibSpeed * m));
        pt.vibPh = Math.fround(ph - roundEvenF(ph));
        pt.seed = (pt.seed + m) | 0;
        if (pt.on) {
          const q = (pt.phPhase + pt.phSpeed * m) * 0.25;
          pt.phPhase = (q - Math.trunc(q)) * 4;
          const t = Math.fround(Math.fround(pt.tremPh) + Math.fround(pt.tremSpeed * m));
          pt.tremPh = Math.fround(t - Math.trunc(t));
        }
      }
      // effects on bus 0 (the dry bus joins at its place in the FX order), post-FX volume
      const FL = this.fxL, FR = this.fxR;
      for (let i = 0; i < m; i++) { FL[i] = b0[2 * i]; FR[i] = b0[2 * i + 1]; }
      let dl: Float32Array | null = null, dr: Float32Array | null = null;
      if (this.used[1]) {
        dl = this.dryL; dr = this.dryR;
        for (let i = 0; i < m; i++) { dl[i] = b1[2 * i]; dr[i] = b1[2 * i + 1]; }
      }
      this.fx.process(FL, FR, m, this.tempo, dl, dr, voices);
      for (let i = 0; i < m; i++) { L[off + done + i] += FL[i]; R[off + done + i] += FR[i]; }
      done += m;
    }
  }
}

void KILL_FADE;

export const gen: GenModule = {
  id: 'harmor',
  create: (sampleRate, blockSize) => new Harmor(sampleRate, blockSize),
};
