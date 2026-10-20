// Layer channels in the engine (FL: Layer). A Layer makes no sound: the notes
// it plays (pattern / song notes, live notes from the typing keyboard, the
// preview keyboards, the piano roll and MIDI input) are handed on to its child
// channels at the same frame, with the same key, velocity, pan, fine pitch,
// Mod X / Y, colour, slide / porta flags and length, as if they were played on
// the child (the child's own key range, time shift, arpeggiator, echo, cut
// groups and polyphony apply). The Layer's own levels adjustment (channel VOL,
// PAN, PITCH, MISC PAN / VOL / MOD X / MOD Y, fine tune) and the crossfade
// reach the children as a LayerTap per child: the voices a layer starts follow
// it live (FL: a voice's final levels are its own plus its parent channel's).
//
// Which children play: every child (default), one random child per note
// (Random), the next child in the stored order (Sequential) or, with Crossfade,
// every child at the level the FADE wheel gives it. Slide notes go to every
// child (the one that has a sounding voice slides it). See docs/research/layer.md.
//
// There is no per-block work: the layer has no voices and no render step. The
// note paths allocate nothing for pattern notes; live notes remember which
// children they started (a Map entry per held key) so their note off finds them.

import type { Channel, Id } from '../model/types';
import { crossfadeGain } from '../model/layer';
import { adjVolGain } from '../model/sampler';
import { channelVolumeToGain } from '../model/scales';
import { LayerTap, type InstrumentChannel } from './InstrumentChannel';
import type { MidiOutChannel } from './MidiOut';
import type { SeqNote } from './Sequencer';

/** What a layer needs of the engine: the channels its children are, and how to play a pattern note on one. */
export interface LayerIO {
  /** Sampler and instrument channel engines by channel id. */
  channels: Map<Id, InstrumentChannel>;
  /** MIDI Out channel engines by channel id (a MIDI Out can be a child: FL lists it among the generators). */
  midiOuts: Map<Id, MidiOutChannel>;
  /** Play a pattern / song note on an instrument channel: cut groups, then its own note handling (Engine.playOn). */
  play(ch: InstrumentChannel, n: SeqNote, frame: number, lenSamples: number, tap: LayerTap): void;
}

/** The children a live note started (`ids`), kept until its note off. */
interface HeldNote {
  key: number;
  ids: Id[];
}

export class LayerChannel {
  readonly id: Id;
  /** The ON switch: pattern / song notes of a muted layer play nothing (live notes still do, as for any instrument channel). */
  enabled = true;
  private readonly io: LayerIO;
  private readonly rng: () => number;
  private childIds: Id[] = [];
  private taps = new Map<Id, LayerTap>();
  /** The taps of `childIds`, same order. */
  private tapList: LayerTap[] = [];
  private random = false;
  private sequential = false;
  private crossfade = false;
  private fade = 0;
  private keyLo = 0;
  private keyHi = 131;
  /** Sequential's counter: the next note goes to child `seq` modulo the number of children. */
  private seq = 0;
  private peak = 0;
  private held = new Map<number, HeldNote>();

  /** `rng` returns 0 <= x < 1 (Random's pick; injected so tests are deterministic). */
  constructor(id: Id, io: LayerIO, rng: () => number = Math.random) {
    this.id = id;
    this.io = io;
    this.rng = rng;
  }

  /** New channel settings (the project model's channel). */
  apply(c: Channel): void {
    const L = c.layer;
    const s = c.sampler;
    this.enabled = c.enabled;
    this.random = !!L?.random;
    this.sequential = !!L?.sequential;
    this.crossfade = !!L?.crossfade;
    this.fade = L?.fade ?? 0;
    this.keyLo = s.keyLo;
    this.keyHi = s.keyHi;

    const kids = L?.children ?? [];
    let same = kids.length === this.childIds.length;
    for (let i = 0; same && i < kids.length; i++) if (kids[i] !== this.childIds[i]) same = false;
    if (!same) {
      // Set children (or a child went): the round robin starts over; taps of children that stay are kept
      this.seq = 0;
      this.childIds = kids.slice();
      const old = this.taps;
      this.taps = new Map();
      this.tapList = this.childIds.map((id) => {
        const t = old.get(id) ?? new LayerTap();
        this.taps.set(id, t);
        return t;
      });
    }

    // the levels the children's voices follow: channel VOL x MISC VOL multiplier, PAN, PITCH x RANGE + fine tune, MOD X / Y
    const gain = channelVolumeToGain(c.volume) * adjVolGain(s.adjVol);
    const pan = c.pan + s.adjPan;
    const cents = c.pitch * s.pitchRange * 100 + s.fineTune;
    const n = this.childIds.length;
    for (let i = 0; i < n; i++) {
      const t = this.tapList[i];
      t.gain = gain * (this.crossfade ? crossfadeGain(i, n, this.fade) : 1);
      t.pan = pan;
      t.cents = cents;
      t.modX = s.adjModX;
      t.modY = s.adjModY;
    }
  }

  /** The layer's children (channel ids, stored order). */
  children(): readonly Id[] {
    return this.childIds;
  }

  /** The tap a child's voices follow (tests, editors). */
  tapOf(id: Id): LayerTap | undefined {
    return this.taps.get(id);
  }

  private present(id: Id): boolean {
    return this.io.channels.has(id) || this.io.midiOuts.has(id);
  }

  /**
   * The child that plays the next note, as an index into the stored children,
   * or -1 for "every child": Random picks among the children that exist now,
   * Sequential takes the next one in turn.
   */
  private pick(): number {
    if (!this.random && !this.sequential) return -1;
    const ids = this.childIds;
    let m = 0;
    for (let i = 0; i < ids.length; i++) if (this.present(ids[i])) m++;
    if (m === 0) return -2;
    let k: number;
    if (this.random) {
      k = Math.floor(this.rng() * m);
      if (!(k >= 0)) k = 0; // also NaN
      else if (k >= m) k = m - 1;
    } else {
      k = this.seq % m;
      this.seq = (this.seq + 1) % 1073741824;
    }
    for (let i = 0; i < ids.length; i++) {
      if (!this.present(ids[i])) continue;
      if (k-- === 0) return i;
    }
    return -2;
  }

  private playChild(i: number, n: SeqNote, frame: number, lenSamples: number): void {
    const id = this.childIds[i];
    const ch = this.io.channels.get(id);
    if (ch) { this.io.play(ch, n, frame, lenSamples, this.tapList[i]); return; }
    // a MIDI Out child sends the note on its port (it takes no levels)
    this.io.midiOuts.get(id)?.scheduleNote(n, frame, lenSamples);
  }

  /**
   * A pattern / song note: starts at `frame` of the current block (it can lie
   * past the block's end: the voices carry the delay into the next blocks) and
   * lasts `lenSamples`. The note is handed to the children at once.
   */
  scheduleNote(n: SeqNote, frame: number, lenSamples: number): void {
    if (n.key < this.keyLo || n.key > this.keyHi) return;
    const v = n.vel / 128;
    if (v > this.peak) this.peak = v;
    // a slide note bends sounding voices: every child gets it (only the one that sounds responds)
    const one = n.slide ? -1 : this.pick();
    if (one === -2) return;
    if (one >= 0) { this.playChild(one, n, frame, lenSamples); return; }
    for (let i = 0; i < this.childIds.length; i++) if (this.present(this.childIds[i])) this.playChild(i, n, frame, lenSamples);
  }

  /** A live note (typing keyboard, preview keyboards, piano roll previews, MIDI input): plays until its note off. */
  liveNoteOn(key: number, vel: number, tag: number): void {
    if (key < this.keyLo || key > this.keyHi) return;
    const v = vel / 128;
    if (v > this.peak) this.peak = v;
    // a note on with a tag that is still held ends the older note first
    const old = this.held.get(tag);
    if (old) this.liveNoteOff(old.key, tag);
    const one = this.pick();
    if (one === -2) return;
    const ids: Id[] = [];
    const start = (i: number) => {
      const id = this.childIds[i];
      const ch = this.io.channels.get(id);
      if (ch) ch.liveNoteOn(key, vel, tag, this.tapList[i]);
      else if (this.io.midiOuts.has(id)) this.io.midiOuts.get(id)!.liveNoteOn(key, vel, tag);
      else return;
      ids.push(id);
    };
    if (one >= 0) start(one);
    else for (let i = 0; i < this.childIds.length; i++) start(i);
    if (ids.length) this.held.set(tag, { key, ids });
  }

  /** The note off of a live note: it releases the children that note started (`key` is the held note's own). */
  liveNoteOff(key: number, tag: number): void {
    const h = this.held.get(tag);
    if (!h || h.key !== key) return;
    this.held.delete(tag);
    for (const id of h.ids) {
      const ch = this.io.channels.get(id);
      if (ch) ch.liveNoteOff(h.key, tag);
      else this.io.midiOuts.get(id)?.liveNoteOff(h.key, tag);
    }
  }

  /** Release the live notes the layer started (stop, pause, seek, panic, removal). */
  allNotesOff(): void {
    if (!this.held.size) return;
    for (const [tag, h] of this.held) {
      for (const id of h.ids) {
        const ch = this.io.channels.get(id);
        if (ch) ch.liveNoteOff(h.key, tag);
        else this.io.midiOuts.get(id)?.liveNoteOff(h.key, tag);
      }
    }
    this.held.clear();
  }

  /** Live notes are held. */
  isActive(): boolean {
    return this.held.size > 0;
  }

  /** Note activity for the channel rack LED (the velocity of the notes since the last call). */
  takePeak(): number {
    const p = this.peak;
    this.peak = 0;
    return p;
  }
}
