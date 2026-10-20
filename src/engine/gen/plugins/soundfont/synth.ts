// FL's SoundFont Player synth (Sobanth TSynth): the voices of the selected preset, MIDI-style channel state, the
// event queue (note events at sample offsets inside the block), exclusive classes, the decaying "tail" of voices that
// end abruptly, and the reverb / chorus send buses. One MIDI channel is played (FL plays the notes on channel 0, or on
// channel 9 for percussion banks). See docs/research/gen/soundfont.md.

import type { Sf2Hydra } from '../../../../model/gen/plugins/soundfont/sf2';
import { defaultControls, type SfControls } from './mod';
import { sincTables, tapsOfMode } from './interp';
import { OVR_NONE, SfVoice, type SfSynthCtx } from './voice';
import { buildPreset, type SfPreset, type SfZone } from './zone';

/** FL's synth: 512 voices (SetMaxVoices 0x200). */
const MAX_VOICES = 512;
const PREALLOCATED_VOICES = 32;
/** The synth renders a call in pieces of at most this many frames (0x1f01d0; the pieces are also cut at the note events). */
const SEGMENT = 4096;

/** Per-sample decay of the voice-end tail: 0.001^(1 / (sr 0.0195)) (-60 dB in 19.5 ms, 0.992 at 44.1 kHz). */
function tailRate(sr: number): number {
  return Math.pow(0.001, 1 / (sr * 0.01950138117913832));
}

/** The plugin's private pitch message carries the offset in millionths of a semitone; the synth reads it as 0.0001 cent units. */
const pitchCents = (semitones: number): number => Math.round(semitones * 1000000) * 9.999999747378752e-5;

interface SfEvent {
  frame: number;
  kind: 0 | 1 | 2; // note on, note off, kill
  id: number;
  key: number;
  vel: number;
  vol: number;
  pan: number;
  pitch: number;
}

export class SfSynth {
  readonly ctx: SfSynthCtx;
  private readonly voices: SfVoice[] = [];
  private hydra: Sf2Hydra | null = null;
  private pcm: Float32Array | null = null;
  private ratio = 1;
  private preset: SfPreset | null = null;
  private presetKey = '';
  /** The percussion channel plays: MIDI note offs are ignored there (drums ring on until their envelope ends; measured). */
  private drum = false;
  private linkCache: Int32Array | null = null;
  private seq = 0;
  private events: SfEvent[] = [];
  private evFree: SfEvent[] = [];
  // decaying tails (FL: the channel's +0x120 / +0x128 / +0x130 accumulators): dry, chorus, reverb
  private tailL = 0; private tailR = 0;
  private tailCL = 0; private tailCR = 0;
  private tailRL = 0; private tailRR = 0;
  private readonly tailR_: number;
  /** Send buses of the block (stereo), the dry sums of the voices' sends. */
  revL = new Float32Array(0); revR = new Float32Array(0);
  chorL = new Float32Array(0); chorR = new Float32Array(0);

  constructor(readonly sr: number) {
    this.tailR_ = tailRate(sr);
    const ovr = new Int32Array(64);
    ovr.fill(OVR_NONE);
    this.ctx = { sr, emu: true, mode: 4, taps: 8, tables: null, ovr, ignoreLinks: true, revLevel: -1, chorLevel: -1, ctl: defaultControls() };
    // the worklet should not allocate while playing: a first set of voices exists up front, more are added on demand
    for (let i = 0; i < PREALLOCATED_VOICES; i++) this.voices.push(new SfVoice());
  }

  // ------------------------------------------------------------------ configuration
  setFont(hydra: Sf2Hydra | null, pcm: Float32Array | null, ratio: number): void {
    if (hydra === this.hydra && pcm === this.pcm && ratio === this.ratio) return;
    this.hydra = hydra; this.pcm = pcm; this.ratio = ratio;
    this.linkCache = null;
    this.presetKey = '';
    this.preset = null;
    // the voices of the old font stop; notes that are already queued play on the new one
    this.killVoices();
  }

  setResampling(mode: number): void {
    const c = this.ctx;
    if (c.mode === mode && (mode === 1 || c.tables)) return;
    c.mode = mode;
    c.taps = mode === 1 ? 2 : tapsOfMode(mode);
    c.tables = mode === 1 ? null : sincTables(c.taps);
  }

  setOptions(emu: boolean, velFc: boolean, ignoreLinks = true): void {
    const c = this.ctx;
    c.ignoreLinks = ignoreLinks;
    if (c.emu !== emu) { c.emu = emu; this.recomputeAll(); }
    if (c.ctl.velFc !== velFc) {
      c.ctl.velFc = velFc;
      for (const v of this.voices) if (v.active) { v.updateMods(c); v.recompute(c); }
    }
  }

  /** Select the playing preset: FL's bank / program (`drum`: the percussion channel). Unknown presets play nothing. */
  selectPreset(bank: number, program: number, drum: boolean): void {
    this.drum = drum;
    const key = `${bank}.${program}.${drum ? 1 : 0}`;
    if (key === this.presetKey && this.preset !== undefined) return;
    this.presetKey = key;
    this.preset = null;
    const h = this.hydra;
    if (!h) return;
    for (let i = 0; i + 1 < h.presets.length; i++) {
      const p = h.presets[i];
      if (p.bank !== bank || p.program !== program) continue;
      // melodic presets sound on channel 0, percussion (bank 128) on channel 9
      if ((bank === 128) !== drum) continue;
      this.preset = buildPreset(h, i);
      break;
    }
  }

  /** FL's overrides of generator `dest` (OVR_NONE = off); every voice follows. */
  setOverride(dest: number, value: number): void {
    if (this.ctx.ovr[dest] === value) return;
    this.ctx.ovr[dest] = value;
    for (const v of this.voices) if (v.active) v.applyOverride(this.ctx, dest);
  }

  setSendLevels(rev: number, chor: number): void {
    this.ctx.revLevel = rev;
    this.ctx.chorLevel = chor;
  }

  /** MIDI controller 1 (the Modulation parameter). */
  setModWheel(v: number): void {
    const cc = this.ctx.ctl.cc;
    if (cc[1] === v) return;
    cc[1] = v;
    for (const vo of this.voices) if (vo.active) { vo.updateMods(this.ctx); vo.recompute(this.ctx); }
  }

  private recomputeAll(): void {
    for (const v of this.voices) if (v.active) v.recompute(this.ctx);
  }

  // ------------------------------------------------------------------ notes
  private ev(): SfEvent {
    return this.evFree.pop() ?? { frame: 0, kind: 0, id: 0, key: 0, vel: 0, vol: 1, pan: 0, pitch: 0 };
  }

  /** Queue a note on at a frame of the next render() call. `pitch` = semitones from the key. */
  noteOn(frame: number, id: number, key: number, vel: number, vol: number, pan: number, pitch: number): void {
    const e = this.ev();
    e.frame = frame; e.kind = 0; e.id = id; e.key = key; e.vel = vel; e.vol = vol; e.pan = pan; e.pitch = pitch;
    this.events.push(e);
  }

  noteOff(frame: number, id: number): void {
    const e = this.ev();
    e.frame = frame; e.kind = 1; e.id = id; e.key = 0; e.vel = 0; e.vol = 1; e.pan = 0; e.pitch = 0;
    this.events.push(e);
  }

  /** The note's levels changed (FL: Gen_Render sends them every block). */
  setNoteLevels(id: number, vol: number, pan: number, pitch: number): void {
    for (const v of this.voices) {
      if (!v.active || v.noteId !== id) continue;
      const cents = pitchCents(pitch);
      v.applyPendingVelocity(this.ctx);
      v.noteVol = vol; v.notePan = pan;
      if (Math.abs(v.pitchOffset - cents) > 1e-9) { v.pitchOffset = cents; v.recompute(this.ctx); }
    }
  }

  /** Stop a note at a frame of the next render() call (polyphony limit, panic): FL's Voice_Kill ends the voices at once. */
  killNote(frame: number, id: number): void {
    const e = this.ev();
    e.frame = frame; e.kind = 2; e.id = id; e.key = 0; e.vel = 0; e.vol = 1; e.pan = 0; e.pitch = 0;
    this.events.push(e);
  }

  private killVoices(): void {
    for (const v of this.voices) v.active = false;
    this.tailL = this.tailR = this.tailCL = this.tailCR = this.tailRL = this.tailRR = 0;
  }

  killAll(): void {
    this.killVoices();
    this.events.length = 0;
  }

  get activeVoices(): number {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  private allocate(): SfVoice {
    for (const v of this.voices) if (!v.active) return v;
    if (this.voices.length < MAX_VOICES) {
      const v = new SfVoice();
      this.voices.push(v);
      return v;
    }
    // steal: the oldest released voice, else the oldest
    let best: SfVoice | null = null;
    for (const v of this.voices) {
      if (!best || (v.released && !best.released) || (v.released === best.released && v.seq < best.seq)) best = v;
    }
    this.flushVoice(best!);
    return best!;
  }

  /**
   * Sample links as FL's font loader resolves them (0x1fa44c / 0x1fa518): left, right and linked samples point to the sample
   * their link names; each sample's chain (at most 9 samples, until it returns to the start) must be balanced - as many left
   * as right samples, mono samples counting for both and not mixed with stereo ones - else the sample has no link at all.
   */
  private links(): Int32Array {
    if (this.linkCache) return this.linkCache;
    const h = this.hydra!;
    const n = h.samples.length;
    const ptr = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const s = h.samples[i];
      if ((s.type & 1) === 0 && (s.type & 0xe) !== 0 && s.link < n) ptr[i] = s.link;
    }
    const out = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      let left = 0, right = 0, flags = 0, hops = 0;
      let cur = i;
      do {
        const t = h.samples[cur].type;
        flags |= t & 1 ? 1 : 0;
        if (t & 1) { left++; right++; }
        if (t & 4) { left++; flags |= 2; }
        if (t & 2) { right++; flags |= 4; }
        hops++;
        cur = ptr[cur];
      } while (cur !== i && cur >= 0 && hops < 9);
      const valid = left === right && !((flags & 1) !== 0 && (flags & 6) !== 0);
      if (valid) out[i] = ptr[i];
    }
    this.linkCache = out;
    return out;
  }

  private startNote(e: SfEvent): void {
    const p = this.preset, pcm = this.pcm, h = this.hydra;
    if (!p || !pcm || !h) return;
    const vel = Math.max(1, Math.min(127, e.vel));
    const ctx = this.ctx;
    for (const z of p.zones) {
      if (e.key < z.keyLo || e.key > z.keyHi || vel < z.velLo || vel > z.velHi) continue;
      // samples without a type FL can play (not mono / right / left / linked) are never loaded: the layer is silent
      if ((z.sample.type & 0xf) === 0) continue;
      if (z.exclusive) {
        for (const o of this.voices) if (o.active && o.exclusive === z.exclusive && o.noteId !== e.id) o.cut(ctx);
      }
      this.startVoice(z, e, vel);
      if (!ctx.ignoreLinks) {
        // "Ignore sample links" off: the samples linked to the layer's sample play with the same layer (up to 9 hops)
        const lk = this.links();
        let next = lk[z.sampleIndex];
        for (let n = 0; n < 9 && next >= 0 && next !== z.sampleIndex; n++) {
          const ls = h.samples[next];
          if (ls && (ls.type & 0xf) !== 0 && ls.end > ls.start) this.startVoice({ ...z, sample: ls, sampleIndex: next }, e, vel);
          next = lk[next];
        }
      }
    }
  }

  private startVoice(z: SfZone, e: SfEvent, vel: number): void {
    const ctx = this.ctx;
    const v = this.allocate();
    if (!v.start(z, ctx, this.pcm!, this.ratio, e.id, e.key, vel, ++this.seq)) return;
    v.noteVol = e.vol; v.notePan = e.pan;
    const cents = pitchCents(e.pitch);
    if (cents !== 0) { v.pitchOffset = cents; v.recompute(ctx); }
  }

  // ------------------------------------------------------------------ rendering
  /** A voice ends: its last output decays into the tail accumulators (FL 0x1d6b10). */
  private flushVoice(v: SfVoice): void {
    this.tailL += v.lastL; this.tailR += v.lastR;
    this.tailCL += v.lastL * v.chorNow; this.tailCR += v.lastR * v.chorNow;
    this.tailRL += v.lastL * v.revNow; this.tailRR += v.lastR * v.revNow;
    v.lastL = v.lastR = 0;
    v.active = false;
  }

  /** Add the decaying tails of the accumulators for `n` samples at offset `o`. */
  private addTails(L: Float32Array, R: Float32Array, o: number, n: number): void {
    const r = this.tailR_;
    if (this.tailL !== 0 || this.tailR !== 0) {
      let a = this.tailL, b = this.tailR;
      for (let k = 0; k < n; k++) { a = Math.fround(a * r); b = Math.fround(b * r); L[o + k] += a; R[o + k] += b; }
      this.tailL = a; this.tailR = b;
    }
    if (this.tailCL !== 0 || this.tailCR !== 0) {
      let a = this.tailCL, b = this.tailCR;
      for (let k = 0; k < n; k++) { a = Math.fround(a * r); b = Math.fround(b * r); this.chorL[o + k] += a; this.chorR[o + k] += b; }
      this.tailCL = a; this.tailCR = b;
    }
    if (this.tailRL !== 0 || this.tailRR !== 0) {
      let a = this.tailRL, b = this.tailRR;
      for (let k = 0; k < n; k++) { a = Math.fround(a * r); b = Math.fround(b * r); this.revL[o + k] += a; this.revR[o + k] += b; }
      this.tailRL = a; this.tailRR = b;
    }
  }

  /** FL's top level render (0x1f01d0) cuts a call at the note events and into segments of at most 4096 frames; the voices are asked for the rest of the segment (the chunk the loop guard is decided for: it matters for short loops). */
  private run(L: Float32Array, R: Float32Array, o: number, n: number): void {
    while (n > 0) {
      const k = n < SEGMENT ? n : SEGMENT;
      this.segment(L, R, o, k);
      o += k; n -= k;
    }
  }

  private segment(L: Float32Array, R: Float32Array, o: number, n: number): void {
    if (n <= 0) return;
    const ctx = this.ctx;
    this.addTails(L, R, o, n);
    const r = this.tailR_;
    for (const v of this.voices) {
      if (!v.active) continue;
      const done = v.process(ctx, n, L, R, this.revL, this.revR, this.chorL, this.chorR, o);
      if (!v.active) {
        // the voice ended inside the segment: its last output decays over the rest of it, then into the accumulators
        let a = v.lastL, b = v.lastR;
        const cs = v.chorNow, rs = v.revNow;
        let ca = a * cs, cb = b * cs, ra = a * rs, rb = b * rs;
        for (let k = done; k < n; k++) {
          a = Math.fround(a * r); b = Math.fround(b * r);
          L[o + k] += a; R[o + k] += b;
          if (cs !== 0) { ca = Math.fround(ca * r); cb = Math.fround(cb * r); this.chorL[o + k] += ca; this.chorR[o + k] += cb; }
          if (rs !== 0) { ra = Math.fround(ra * r); rb = Math.fround(rb * r); this.revL[o + k] += ra; this.revR[o + k] += rb; }
        }
        this.tailL += a; this.tailR += b;
        this.tailCL += ca; this.tailCR += cb;
        this.tailRL += ra; this.tailRR += rb;
        v.lastL = v.lastR = 0;
      }
    }
  }

  /** Render a block: the voices add into L / R (the buses collect the sends); events are applied at their frames. */
  render(L: Float32Array, R: Float32Array, n: number): void {
    if (this.revL.length < n) {
      this.revL = new Float32Array(n); this.revR = new Float32Array(n);
      this.chorL = new Float32Array(n); this.chorR = new Float32Array(n);
    } else {
      this.revL.fill(0, 0, n); this.revR.fill(0, 0, n); this.chorL.fill(0, 0, n); this.chorR.fill(0, 0, n);
    }
    const evs = this.events;
    if (evs.length > 1) evs.sort((a, b) => a.frame - b.frame);
    let pos = 0;
    let i = 0;
    while (i < evs.length) {
      const e = evs[i];
      const f = Math.max(pos, Math.min(n, e.frame));
      this.run(L, R, pos, f - pos);
      pos = f;
      if (e.kind === 0) this.startNote(e);
      else if (e.kind === 1) { if (!this.drum) for (const v of this.voices) { if (v.active && v.noteId === e.id) v.noteOff(this.ctx); } }
      else for (const v of this.voices) { if (v.active && v.noteId === e.id) v.kill(this.ctx); }
      this.evFree.push(e);
      i++;
    }
    evs.length = 0;
    this.run(L, R, pos, n - pos);
  }
}
