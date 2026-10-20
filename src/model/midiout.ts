// MIDI Out (FL: plugin database Generators > MIDI > MIDI Out): a channel that
// makes no sound. It sends its notes (steps, piano roll, typing keyboard and
// live preview) as MIDI on its output port; effects listening on that port
// receive them (FL: a plugin's MIDI input port, Pitcher's own port, Patcher's
// "From FL Studio" port outputs; see docs/research/midiout.md).
//
// FL's editor form (SynthEditorForm 558 x 389): Channel 1..16, Patch (General
// MIDI, "(none)"), Bank coarse / fine (-1..127, "⋯" = none), Port 0..255,
// 8 pages of 9 controller knobs (0..127) with Page names, Reset, Deactivate
// all, Send pan / volume and pitch, Map note color to MIDI channel, the
// transport flush Options menu and Multi-touch; each knob has FL's Control
// settings (full / short name, controller number and type CC / RPN / NRPN /
// AFT / Note, range, channel override, note off value). FL's plugin publishes
// 73 parameters: "General MIDI patch" (0..128, 0 = "(none)") and the 72 knobs.

export const MIDI_PORT_MAX = 255;
export const MO_PAGES = 8;
export const MO_KNOBS = 9;
export const MO_CONTROLS = MO_PAGES * MO_KNOBS;

/** Control settings > Controller type (FL's TypeSelect items and hints). */
export const MO_TYPES = ['CC', 'RPN', 'NRPN', 'AFT', 'Note'];
export const MO_TYPE_HINTS = ['Continuous Controller', 'Registered Parameter', 'Non-Registered Parameter', 'Channel aftertouch', 'Midi note'];
export const MO_NOTE = 4;

/** One knob's Control settings. */
export interface MidiOutControl {
  /** Full name (hint bar) and short name (label next to the knob). */
  name: string;
  short: string;
  /** Controller number; -1 = not configured (FL shows the gear icon instead of the label). */
  ctrl: number;
  /** MO_TYPES index. */
  type: number;
  /** Range (Note controls: the note range). */
  min: number;
  max: number;
  /** MIDI channel override 1..16, 0 = the channel's own (FL: "⋯"). */
  chan: number;
  /** Note controls: the knob value that sends a note off. */
  noteOff: number;
  /** Activated (orange label): the control transmits. */
  active: boolean;
}

/** Options menu: what MIDI Out sends when FL resets (transport start / stop). */
export interface MidiOutFlush {
  programChange: boolean;
  pan: boolean;
  volume: boolean;
  pitch: boolean;
  pitchBendRange: boolean;
  cutNotes: boolean;
}

export interface MidiOutSettings {
  /** Output port 0..255: effects listening on the same port receive the notes. */
  port: number;
  /** MIDI channel 1..16. */
  channel: number;
  /** General MIDI patch 0..127, -1 = "(none)". */
  patch: number;
  /** Bank select coarse (CC #0) / fine (CC #32), -1 = none. */
  bankMSB: number;
  bankLSB: number;
  /** Visible page of controllers 0..7 and the page names. */
  page: number;
  pageNames: string[];
  /** Knob values 0..127 (FL parameters 1..72, page-major). */
  values: number[];
  controls: MidiOutControl[];
  sendPanVolPitch: boolean;
  mapColorToChannel: boolean;
  flush: MidiOutFlush;
  multiTouch: boolean;
}

export function defaultMidiOutControl(): MidiOutControl {
  return { name: '', short: '', ctrl: -1, type: 0, min: 0, max: 127, chan: 0, noteOff: 0, active: false };
}

/** A new MIDI Out (FL's plugin database state: channel 1, port 0, no patch / bank, all controls unassigned). */
export function defaultMidiOut(): MidiOutSettings {
  return {
    port: 0,
    channel: 1,
    patch: -1,
    bankMSB: -1,
    bankLSB: -1,
    page: 0,
    pageNames: Array.from({ length: MO_PAGES }, (_, i) => `Page ${i + 1}`),
    values: new Array(MO_CONTROLS).fill(0),
    controls: Array.from({ length: MO_CONTROLS }, defaultMidiOutControl),
    sendPanVolPitch: false,
    mapColorToChannel: false,
    flush: { programChange: true, pan: true, volume: true, pitch: true, pitchBendRange: true, cutNotes: true },
    multiTouch: false,
  };
}

const int = (v: unknown, d: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v.slice(0, 64) : d);

/** Repair stored MIDI Out settings (missing fields, out-of-range values). */
export function normalizeMidiOut(raw: unknown): MidiOutSettings {
  const d = defaultMidiOut();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<MidiOutSettings>;
  const ctl = (c: unknown): MidiOutControl => {
    const x = (c && typeof c === 'object' ? c : {}) as Partial<MidiOutControl>;
    const type = int(x.type, 0, 0, MO_TYPES.length - 1);
    const hi = type === 1 || type === 2 ? 16383 : 127;
    return {
      name: str(x.name, ''), short: str(x.short, ''),
      ctrl: int(x.ctrl, -1, -1, hi), type,
      min: int(x.min, 0, 0, hi), max: int(x.max, 127, 0, hi),
      chan: int(x.chan, 0, 0, 16), noteOff: int(x.noteOff, 0, 0, 127), active: bool(x.active, false),
    };
  };
  const fl = (r.flush && typeof r.flush === 'object' ? r.flush : {}) as Partial<MidiOutFlush>;
  return {
    port: int(r.port, d.port, 0, MIDI_PORT_MAX),
    channel: int(r.channel, d.channel, 1, 16),
    patch: int(r.patch, d.patch, -1, 127),
    bankMSB: int(r.bankMSB, d.bankMSB, -1, 127),
    bankLSB: int(r.bankLSB, d.bankLSB, -1, 127),
    page: int(r.page, 0, 0, MO_PAGES - 1),
    pageNames: Array.from({ length: MO_PAGES }, (_, i) => str(Array.isArray(r.pageNames) ? r.pageNames[i] : undefined, d.pageNames[i])),
    values: Array.from({ length: MO_CONTROLS }, (_, i) => int(Array.isArray(r.values) ? r.values[i] : undefined, 0, 0, 127)),
    controls: Array.from({ length: MO_CONTROLS }, (_, i) => ctl(Array.isArray(r.controls) ? r.controls[i] : undefined)),
    sendPanVolPitch: bool(r.sendPanVolPitch, d.sendPanVolPitch),
    mapColorToChannel: bool(r.mapColorToChannel, d.mapColorToChannel),
    flush: {
      programChange: bool(fl.programChange, true), pan: bool(fl.pan, true), volume: bool(fl.volume, true),
      pitch: bool(fl.pitch, true), pitchBendRange: bool(fl.pitchBendRange, true), cutNotes: bool(fl.cutNotes, true),
    },
    multiTouch: bool(r.multiTouch, false),
  };
}

/** MIDI channel (1..16) a note goes out on: the channel, or the note colour with "Map note color to MIDI channel". */
export function midiOutNoteChannel(s: Pick<MidiOutSettings, 'channel' | 'mapColorToChannel'>, color: number): number {
  return s.mapColorToChannel ? (Math.max(0, Math.min(15, Math.round(color))) + 1) : s.channel;
}

/** Note controls: the key a knob value sends (the value mapped into the control's note range), or -1 for a note off. */
export function midiOutControlNote(c: MidiOutControl, value: number): number {
  if (Math.round(value) === c.noteOff) return -1;
  const lo = Math.min(c.min, c.max), hi = Math.max(c.min, c.max);
  return Math.max(0, Math.min(127, Math.round(lo + ((hi - lo) * Math.max(0, Math.min(127, value))) / 127)));
}

/** The knob label: the short name, else the full name, else "-" (FL's caption of an unnamed control). */
export function midiOutControlLabel(c: MidiOutControl): string {
  return c.short || c.name || '-';
}

/** FL's text of a port selector: the number, or "⋯" when none is set. */
export function portText(port: number | undefined | null): string {
  return port === undefined || port === null || port < 0 ? '⋯' : String(port);
}

/** General MIDI Level 1 instrument names (MIDI Out's Patch list; index 0 = "(none)"). */
export const GM_PATCHES = [
  '(none)',
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano', 'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavi',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)', 'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass', 'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'SynthStrings 1', 'SynthStrings 2', 'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'SynthBrass 1', 'SynthBrass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)', 'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)', 'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)', 'FX 5 (brightness)', 'FX 6 (goblin)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bag pipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
];

/**
 * Effects whose plugin window offers the slot's MIDI input port (the wrapper's
 * "Input port"). Pitcher takes notes too but, as in FL, on its own MIDI Input
 * Port Number in its editor; a slot port set anyway still works.
 */
export const NOTE_INPUT_FX = new Set(['vocodex', 'grossbeat', 'patcher']);
