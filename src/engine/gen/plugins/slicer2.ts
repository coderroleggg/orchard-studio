// Fruity Slicer 2 (FL: Fruity Slicer 2): FL's engine.dylib (docs/research/gen/slicer2.md).
// The plugin layer here is FL's C++ wrapper (MyPlugin): it turns FL voices into note on /
// off events of the slicer instance (./slicer2/engine.ts) and forwards the voices' levels:
//
// - TriggerVoice (0x87f8): key = the note's key (FL: InitLevels.Pitch / 100), velocity =
//   trunc(127 ln(10 InitLevels.Vol + 1) / ln 21) (FL velocity 100 -> 100); a second note
//   on the same MIDI channel (note colour) and key first releases the key; then the note
//   on, and InitLevels pan / Mod X / Mod Y go to every voice of the instance.
// - Every Gen_Render (0x8428; here at every block and note event): for each held note the
//   changed FinalLevels (Mod X -> slice filter cutoff offset, Mod Y -> res offset, pitch
//   relative to the key -> pitch offset, pan) go to every voice (the last note wins).
// - Voice_Release (0x8b1c): note off for the key (Hold slices keep playing); the FL voice
//   ends at once and the slicer plays the release itself. Voice_Kill (polyphony limit)
//   only forgets the note: the slice plays on to its end, as in FL.
// - The channel volume / panning reach FL's engine as FPE_MIDI_Vol / FPE_MIDI_Pan (the
//   plugin has FPF_MIDIOut): the instance gain is FL's volume curve of vol / 127 and its pan
//   law, smoothed per sample. They are derived here from the notes' levels (velocity
//   'plugin': levels.vol is the channel's part), FL's knob -> event value formulas.
// FL renders its engine one sample at a time with the events at their sample.

import type { GenContext, GenInstance, GenModule, GenNote } from '../types';
import { logf } from './poizone/applemath';
import { fma32 } from './drumpad/libm';
import { Instance, SliceRec, removeAt, type SampleData } from './slicer2/engine';
import { SL2_BLOCKS, SL2_BLOCK_RANGE, sl2Key, sl2Norm, type Slicer2Slice } from '../../../model/gen/plugins/slicer2/state';

const f32 = Math.fround;
const LN21 = f32(3.044522523880005);
const MAX_EVENTS = 512;
const PITCH_C5 = 6000;

/** FL's LogVol of a note velocity (InitLevels.Vol, FLEngine; float32). */
function flVelVol(vel: number): number {
  const x = f32(vel * f32(0.01));
  if (x === 1) return 1;
  const s = f32(x * f32(2.397895336151123));
  return f32((Math.exp(s) - 1) * f32(0.1));
}

/** MyPlugin 0x8854: the MIDI velocity FL's engine gets for InitLevels.Vol. */
export function midiVelocity(vol: number): number {
  let s = f32(f32(f32(logf(f32(f32(vol * 10) + 1)) / LN21)) * 127);
  if (s < 0) s = 0; else if (s > 127) s = 127;
  return Math.trunc(s);
}

interface Held {
  note: GenNote;
  /** The note's id when triggered (the channel reuses its note objects). */
  id: number;
  ch: number;
  key: number;
  /** Last levels sent: fcut, fres, pitch, pan (FL caches them per note, -10000 at the start). */
  c: Float32Array;
}

const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);

class Slicer2 implements GenInstance {
  readonly inst: Instance;
  private readonly env: { sample(id: string): { channels: Float32Array[]; sampleRate: number } | undefined };
  private sampleId = '';
  private readonly recs: SliceRec[] = [];
  private readonly held: Held[] = [];
  private readonly heldPool: Held[] = [];
  // events
  private readonly evFrame = new Int32Array(MAX_EVENTS);
  private readonly evType = new Uint8Array(MAX_EVENTS); // 1 on, 2 off, 3 kill
  private readonly evNote: (GenNote | null)[] = new Array(MAX_EVENTS).fill(null);
  private evCount = 0;
  private readonly out = new Float32Array(2);
  // FL's MIDI volume / pan events (values last derived)
  private midiVol = -1;
  private midiPan = -999;

  constructor(sr: number, env: Slicer2['env']) {
    this.env = env;
    this.inst = new Instance(sr);
    for (let i = 0; i < 128; i++) this.recs.push(new SliceRec());
    for (let i = 0; i < 64; i++) this.heldPool.push({ note: null as unknown as GenNote, id: 0, ch: 0, key: 0, c: new Float32Array(4) });
  }

  setParams(p: unknown): void {
    const s = (p ?? {}) as Record<string, unknown>;
    const g = this.inst.g;
    g.mono = sl2Norm(num(s.mono, 0), 0, 1) >= 0.5;
    g.cut = sl2Norm(num(s.cutoff, 100000), 0, 100000);
    g.res = sl2Norm(num(s.res, 0), 0, 100000);
    g.transpose = Math.trunc(f32(sl2Norm(num(s.transpose, 0), -24, 24) * 48)) - 24;
    g.detune = sl2Norm(num(s.detune, 100), 0, 200);
    g.mode = Math.round(num(s.stretch, 0));
    g.ftype = Math.round(num(s.gftype, 0));
    g.tempo = f32(num(s.tempo, 120));
    g.baseKey = Math.round(num(s.baseKey, 60));
    const chrom = Math.round(num(s.chromatic, -1));
    if (chrom !== g.chromatic) { g.chromatic = chrom; this.inst.killAll(); }
    const slices = (Array.isArray(s.slices) ? s.slices : []) as Slicer2Slice[];
    const n = Math.min(128, slices.length);
    for (let i = 0; i < n; i++) {
      const r = this.recs[i], d = slices[i];
      r.start = d.start; r.end = d.end; r.key = d.key; r.mode = d.mode; r.ftype = d.ftype;
      r.fade = f32(d.fade); r.hold = f32(d.hold); r.decay = f32(d.decay); r.sustain = f32(d.sustain);
      for (const b of SL2_BLOCKS) {
        const [min, max, def] = SL2_BLOCK_RANGE[b];
        const v = sl2Norm(num(s[sl2Key(b, i)], def), min, max);
        switch (b) {
          case 't': r.transpose = Math.trunc(f32(v * 48)) - 24; break;
          case 'd': r.detune = v; break;
          case 'g': r.gain = v; break;
          case 'p': r.pan = v; break;
          case 'a': r.attack = v; break;
          case 'r': r.release = v; break;
          case 'c': r.cut = v; break;
          case 'q': r.res = v; break;
        }
      }
    }
    this.inst.slices = this.recs.slice(0, n);
    const id = typeof s.sample === 'string' ? s.sample : '';
    if (id !== this.sampleId) {
      this.sampleId = id;
      this.inst.killAll();
      this.inst.smp = null;
    }
    this.ensureSample();
  }

  /** The pool sample (it may reach the engine after the state): looked up again until found. */
  private ensureSample(): void {
    if (this.inst.smp || !this.sampleId) return;
    const smp = this.env.sample(this.sampleId);
    if (smp && smp.channels.length && smp.channels[0].length) {
      const data: SampleData = { ch: smp.channels.slice(0, 2), rate: smp.sampleRate, len: smp.channels[0].length };
      this.inst.smp = data;
    }
  }

  reset(): void {
    this.inst.killAll();
    this.held.length = 0;
    this.evCount = 0;
  }

  private queue(type: number, note: GenNote, frame: number): void {
    if (this.evCount >= MAX_EVENTS) return;
    this.evFrame[this.evCount] = frame;
    this.evType[this.evCount] = type;
    this.evNote[this.evCount] = note;
    this.evCount++;
  }
  noteOn(note: GenNote, frameOffset: number): void { this.queue(1, note, frameOffset); }
  noteOff(note: GenNote, frameOffset: number): void { this.queue(2, note, frameOffset); }
  killNote(note: GenNote): void { this.queue(3, note, 0); }

  allNotesOff(): void {
    this.held.length = 0;
    this.evCount = 0;
    this.inst.killAll();
  }

  isActive(): boolean {
    return this.inst.active.length > 0 || this.evCount > 0 || !this.inst.settled();
  }

  private findHeld(note: GenNote): number {
    for (let i = 0; i < this.held.length; i++) if (this.held[i].note === note && this.held[i].id === note.id) return i;
    return -1;
  }

  /** FL's channel volume / panning events, derived from a note's levels. */
  private channelEvents(note: GenNote): void {
    // a velocity-0 note carries no channel volume (levels.vol is 0 for it)
    if (!(note.velocity > 0)) return;
    const lv = note.levels;
    const vol = lv.vol > 0 ? Math.min(127, Math.floor(128 * (Math.log(10 * lv.vol + 1) / Math.log(11)) + 1e-6)) : 0;
    const cp = lv.pan - note.init.pan;
    let flags = Math.trunc(cp * 64 + (cp >= 0 ? 1e-6 : -1e-6));
    flags = flags < -64 ? -64 : flags > 64 ? 64 : flags;
    let changed = false;
    if (vol !== this.midiVol) { this.midiVol = vol; this.inst.vol = f32(vol / 127); changed = true; }
    if (flags !== this.midiPan) { this.midiPan = flags; this.inst.pan = f32(f32(f32(flags * 0.015625) + 1) * 0.5); changed = true; }
    if (changed) this.inst.computeGains();
  }

  /** TriggerVoice (0x87f8). */
  private trigger(note: GenNote): void {
    const inst = this.inst;
    this.ensureSample();
    const ch = note.color & 15;
    const key = note.key < 0 ? 0 : note.key > 127 ? 127 : Math.round(note.key);
    // FL runs the instance all the time: with no voice sounding its smoothing has converged
    const idle = inst.active.length === 0;
    this.channelEvents(note);
    if (idle) inst.settle();
    const vel = midiVelocity(flVelVol(note.velocity));
    for (let i = 0; i < this.held.length; i++) {
      const h = this.held[i];
      if (h.ch === ch && h.key === key) {
        inst.noteOff(key);
        this.heldPool.push(h);
        removeAt(this.held, i);
        break;
      }
    }
    inst.noteOn(key, f32(vel / 127));
    inst.setPan(f32(note.init.pan));
    inst.setFCut(f32(note.init.fcut));
    inst.setFRes(f32(note.init.fres));
    const h = this.heldPool.pop() ?? { note, id: note.id, ch, key, c: new Float32Array(4) };
    h.note = note; h.id = note.id; h.ch = ch; h.key = key;
    h.c.fill(-10000);
    this.held.push(h);
  }

  /** Gen_Render's level loop (0x8520). */
  private levels(): void {
    const inst = this.inst;
    for (const h of this.held) {
      const lv = h.note.levels, c = h.c;
      const fc = f32(lv.fcut), fr = f32(lv.fres), pan = f32(lv.pan);
      const pitch = f32(lv.pitch - PITCH_C5);
      if (fc !== c[0]) { c[0] = fc; inst.setFCut(fc); }
      if (fr !== c[1]) { c[1] = fr; inst.setFRes(fr); }
      if (pitch !== c[2]) { c[2] = pitch; inst.setPitch(f32(fma32(f32(h.key - 60), -100, pitch) * f32(0.01))); }
      if (pan !== c[3]) { c[3] = pan; inst.setPan(pan); }
    }
    if (this.held.length) this.channelEvents(this.held[this.held.length - 1].note);
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    const tempo = f32(ctx.tempo);
    let e = 0;
    let i = 0;
    const out = this.out, inst = this.inst;
    while (i < n) {
      while (e < this.evCount && this.evFrame[e] <= i) {
        const note = this.evNote[e]!;
        const t = this.evType[e];
        if (t === 1) this.trigger(note);
        else {
          const k = this.findHeld(note);
          if (k >= 0) {
            const h = this.held[k];
            if (t === 2) inst.noteOff(h.key);
            removeAt(this.held, k);
            this.heldPool.push(h);
          }
        }
        this.evNote[e] = null;
        e++;
      }
      this.levels();
      const end = e < this.evCount ? Math.min(n, this.evFrame[e]) : n;
      for (; i < end; i++) {
        inst.renderSample(tempo, out);
        L[i] = f32(L[i] + out[0]);
        R[i] = f32(R[i] + out[1]);
      }
    }
    // events at or after the block end (none expected) are applied now
    for (; e < this.evCount; e++) {
      const note = this.evNote[e]!;
      if (this.evType[e] === 1) this.trigger(note);
      else { const k = this.findHeld(note); if (k >= 0) { if (this.evType[e] === 2) inst.noteOff(this.held[k].key); this.heldPool.push(removeAt(this.held, k)); } }
      this.evNote[e] = null;
    }
    this.evCount = 0;
  }

  monitor() {
    const inst = this.inst;
    const pos: number[] = [];
    for (const v of inst.active) if (v.state === 1) pos.push(v.slice, Math.round(v.pos));
    return { voices: pos };
  }
}

export const gen: GenModule = {
  id: 'slicer2',
  create: (sampleRate, _bs, env) => new Slicer2(sampleRate, env),
};
