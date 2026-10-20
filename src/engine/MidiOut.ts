// MIDI Out channels in the engine (FL: MIDI Out). A MIDI Out channel makes no
// sound: the notes it plays (pattern / song notes, live notes from the typing
// keyboard, the preview keyboards and MIDI controllers, and its "Note" type
// controller knobs) become note events on its MIDI port. Every block the
// engine collects them, sample-accurately, and the mixer hands them to the
// effect slots listening on that port (MixerEngine.deliverNotes).

import type { Channel, Id } from '../model/types';
import { MO_CONTROLS, MO_NOTE, midiOutControlNote, midiOutNoteChannel, type MidiOutControl } from '../model/midiout';
import type { SeqNote } from './Sequencer';

/** A note event on a MIDI port at a frame of the current block (0 <= frame < block length). */
export interface PortNote {
  port: number;
  frame: number;
  on: boolean;
  key: number;
  /** FL note velocity 0..128 (note-offs: 0). */
  vel: number;
  /** MIDI channel 1..16. */
  chan: number;
}

export type PortNoteSink = (port: number, frame: number, on: boolean, key: number, vel: number, chan: number) => void;

/** A scheduled event; `at` counts frames from the start of the next block to render. */
interface QItem {
  at: number;
  on: boolean;
  key: number;
  vel: number;
  chan: number;
  port: number;
  /** Note identity: a note-off only ends the note that started with the same id. */
  id: number;
  seq: number;
}

/** Ids of live notes (negative, from the host's tags) and of the Note type controls. */
const liveId = (tag: number) => -1 - tag;
const ctlId = (i: number) => -1e9 - i;

export class MidiOutChannel {
  readonly id: Id;
  enabled = true;
  mixerTrack = 0;
  port = 0;
  private chan = 1;
  private mapColor = false;
  private values: number[] = [];
  private controls: MidiOutControl[] = [];
  private configured = false;
  private q: QItem[] = [];
  private due: QItem[] = [];
  private nextId = 1;
  private seq = 0;
  /** Per key: the id of the note holding it (0 = off), its port and channel. */
  private onId = new Float64Array(128);
  private onPort = new Int16Array(128);
  private onChan = new Uint8Array(128);
  /** Per Note control: the key it holds (-1 = none). */
  private ctlKey = new Int16Array(MO_CONTROLS).fill(-1);
  private peak = 0;

  constructor(id: Id) {
    this.id = id;
  }

  apply(c: Channel): void {
    const s = c.midiOut;
    const wasEnabled = this.enabled;
    this.enabled = c.enabled;
    this.mixerTrack = c.mixerTrack;
    if (s) {
      this.port = Math.max(0, Math.min(255, Math.round(s.port)));
      this.chan = Math.max(1, Math.min(16, Math.round(s.channel)));
      this.mapColor = !!s.mapColorToChannel;
      // "Note" type controller knobs: a changed value plays its note (or a note off)
      const prev = this.values;
      this.controls = s.controls ?? [];
      this.values = (s.values ?? []).slice();
      if (this.configured && this.enabled) {
        for (let i = 0; i < Math.min(MO_CONTROLS, this.controls.length); i++) {
          const ct = this.controls[i];
          const v = this.values[i] ?? 0;
          if (!ct || !ct.active || ct.type !== MO_NOTE || ct.ctrl < 0) {
            if (this.ctlKey[i] >= 0) this.controlOff(i);
            continue;
          }
          if (v === prev[i]) continue;
          if (this.ctlKey[i] >= 0) this.controlOff(i);
          const key = midiOutControlNote(ct, v);
          if (key < 0) continue;
          const chan = ct.chan > 0 ? ct.chan : this.chan;
          const vel = ct.ctrl > 0 ? Math.min(128, Math.round((ct.ctrl * 128) / 127)) : 100;
          this.push(0, true, key, vel, chan, this.port, ctlId(i));
          this.ctlKey[i] = key;
        }
      }
    }
    this.configured = true;
    if (wasEnabled && !this.enabled) this.allNotesOff();
  }

  private controlOff(i: number): void {
    const key = this.ctlKey[i];
    this.ctlKey[i] = -1;
    if (key >= 0) this.push(0, false, key, 0, this.onChan[key] || this.chan, this.onPort[key], ctlId(i));
  }

  private push(at: number, on: boolean, key: number, vel: number, chan: number, port: number, id: number): void {
    if (key < 0 || key > 127) return;
    this.q.push({ at: Math.max(0, at), on, key, vel, chan, port, id, seq: this.seq++ });
  }

  /** A pattern / song note: note on at `frame` of the current block, note off `lenSamples` later. */
  scheduleNote(n: SeqNote, frame: number, lenSamples: number): void {
    if (!this.enabled) return;
    const id = this.nextId++;
    const chan = midiOutNoteChannel({ channel: this.chan, mapColorToChannel: this.mapColor }, n.color);
    this.push(frame, true, n.key, n.vel, chan, this.port, id);
    this.push(frame + Math.max(1, lenSamples), false, n.key, 0, chan, this.port, id);
  }

  liveNoteOn(key: number, vel: number, tag: number): void {
    if (!this.enabled) return;
    this.push(0, true, key, vel, this.chan, this.port, liveId(tag));
  }

  liveNoteOff(key: number, tag: number): void {
    this.push(0, false, key, 0, this.chan, this.port, liveId(tag));
  }

  /** Release every sounding note at the start of the next block and drop the scheduled ones. */
  allNotesOff(): void {
    this.q.length = 0;
    this.ctlKey.fill(-1);
    for (let k = 0; k < 128; k++) {
      if (this.onId[k] !== 0) this.push(0, false, k, 0, this.onChan[k], this.onPort[k], this.onId[k]);
    }
  }

  /** Something to emit or a note sounding. */
  isActive(): boolean {
    if (this.q.length) return true;
    for (let k = 0; k < 128; k++) if (this.onId[k] !== 0) return true;
    return false;
  }

  /** Note activity for the channel rack LED (the velocity of the last notes). */
  takePeak(): number {
    const p = this.peak;
    this.peak = 0;
    return p;
  }

  /**
   * Emit the events that fall into the next `n` frames, in time order (at one
   * frame: note offs first), then move the rest one block closer.
   */
  collect(n: number, sink: PortNoteSink): void {
    const q = this.q;
    if (!q.length) return;
    const due = this.due;
    due.length = 0;
    let w = 0;
    for (let i = 0; i < q.length; i++) {
      const e = q[i];
      if (e.at < n) due.push(e);
      else { e.at -= n; q[w++] = e; }
    }
    q.length = w;
    if (!due.length) return;
    if (due.length > 1) due.sort((a, b) => a.at - b.at || (a.on === b.on ? a.seq - b.seq : a.on ? 1 : -1));
    for (const e of due) {
      const k = e.key;
      const frame = Math.max(0, Math.min(n - 1, Math.floor(e.at)));
      if (e.on) {
        // a key that is already on is retriggered: the older note ends here
        if (this.onId[k] !== 0) sink(this.onPort[k], frame, false, k, 0, this.onChan[k]);
        this.onId[k] = e.id;
        this.onPort[k] = e.port;
        this.onChan[k] = e.chan;
        sink(e.port, frame, true, k, e.vel, e.chan);
        const v = e.vel / 128;
        if (v > this.peak) this.peak = v;
      } else if (this.onId[k] === e.id) {
        this.onId[k] = 0;
        sink(this.onPort[k], frame, false, k, 0, this.onChan[k]);
      }
    }
    due.length = 0;
  }
}
