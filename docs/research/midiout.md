# MIDI Out and MIDI input of effects

How FL Studio sends notes to effects, and how Orchard Studio does it. Files:
`src/model/midiout.ts` (settings, defaults, GM patch names), `src/engine/MidiOut.ts`
(MIDI Out channels in the engine), `src/engine/Mixer.ts` (`deliverNotes`, per-port
note state), `src/engine/effects/types.ts` (the effect MIDI API),
`src/ui/channelsettings/MidiOutEditor.tsx` (editor), `tests/midiout.test.ts`.

## Sources

- FL manual pages *MIDI Out*, *Plugin Wrapper* (wrapper.htm), *Pitcher*, *Gross Beat*,
  *Patcher* ("Events or MIDI to FX plugins"), *Vocodex* (carrier / inputs),
  *ZGameEditor Visualizer* (fetched from cluster.image-line.com, 2026-10).
- FL 2026's MIDI Out binary (`Plugins/Fruity/Generators/MIDI Out`): its editor forms
  (`SynthEditorForm`, `CtrlSetForm`, the Options and wheel menus) extracted with
  `extract_forms.py`, and the plugin itself in the FL test host (`flfxhost info` loads
  it): flags `0x10604050` = note input + MIDI out + no audio processing, 73 parameters:
  `General MIDI patch` (0..128, value text `(none)` at 0) and `Unnamed parameter 1..72`
  (0..127, the 8 x 9 knobs).
- FL's plugin database: MIDI Out is in `Generators/MIDI` (simple and full databases);
  its database state (`MIDI Out.fst`, plugin state v4) has page names `Page 1..8`, no
  patch / bank (-1) and all knob values 0.
- The manual's MIDI Out screenshot (FL 2026, 1.53x) for colours and the control look.
- Effect flags read with `flfxhost info`: Gross Beat, Vocodex, Pitcher, Edison and
  Newtone carry bit 15 (not in the public SDK's list; the effects that take MIDI), the
  VFX plugins `FPF_GetNoteInput`; Patcher and ZGameEditor Visualizer neither (they
  have their own port settings).
- FL 2026 strings (FLEngine translation table): `|MIDI input port number`,
  `|MIDI output port number`, `No input port set (click to auto assign)`.

## FL's mechanism (confirmed)

- **MIDI Out** (Generators > MIDI) makes no sound; it sends the notes of its channel
  (step sequencer, piano roll, live keyboard: the channel's notes, even when FL is
  stopped since 22291) as MIDI on its **Port** (0..255, default 0) and **Channel**
  (1..16). "Matching port numbers on MIDI Out and the target creates the link."
- The target's **input port**: the plugin wrapper's *Settings > MIDI > Input port /
  Output port* (manual: shown for VST / AU wrappers); **Pitcher** has its own *MIDI
  Input Port Number* display ("..." = none) in its editor; **ZGameEditor Visualizer**
  has a MIDI port in its Settings tab; **Patcher** in an effect slot exposes MIDI ports
  as *From FL Studio > Outputs > Events > Port N* outputs, wired by event links to its
  modules (the manual's way to get MIDI Out notes to plugins inside an effect Patcher).
  FL's native Gross Beat and Vocodex document MIDI from a focused controller, and
  notes from the piano roll through Patcher; the manual does not show a wrapper port
  for native effects (an April 2026 forum thread asks for one for FL's synths).
- MIDI Out editor (558 x 389): Channel, Patch (General MIDI list), Bank coarse /
  fine (CC #0 / #32, -1 = "⋯"), Port; Page combo + rename; 9 knobs per page with
  labels (orange = activated, click to toggle; a gear opens the Control settings of an
  unassigned knob) and values; Reset (CC #121), Deactivate all, Send pan, volume and
  pitch, Map note color to MIDI channel, the Options menu (Send all control values
  now; On reset: Send program change / pan / volume / pitch / pitch bend range, Cut
  playing notes; all on) and Multi-touch. Control settings (238 x 286): Full name,
  Short name, Controller number + type (CC, RPN, NRPN, AFT, Note), Range, Channel
  override, Note off value; Reset, Copy, Paste, Accept.

## Orchard Studio

- **Data**: `Channel.kind` = `'sampler' | 'midiout'`, `Channel.midiOut`
  (`MidiOutSettings`: port, channel, patch, banks, page + names, 72 knob values and
  control settings, the switches and flush options). `FxSlot.midiPort` (0..255,
  absent = none) is the wrapper's input port. Old projects normalize to samplers and
  slots without a port.
- **Engine**: `MidiOutChannel` turns its notes into port events: pattern and song
  notes (note on at the note's frame, note off after its length; swing, shift and
  mute as for any channel), live notes (`noteOn` / `noteOff` messages from the
  typing keyboard, preview keyboards, piano roll previews and MIDI controllers), and
  "Note" type knobs (a changed value sends its note, the note off value a note off).
  A key that is already on is retriggered (note off first); stop, pause, seek, mute,
  panic and removing the channel release its notes. Each block the engine merges the
  channels' events in time order and `MixerEngine.deliverNotes` hands them to every
  slot listening on the event's port (on any track): the slot's `midiPort` plus the
  plugin's own `midiPorts()`. A slot gets its events right before it processes, at
  their frame (`noteOn(key, velocity, frameOffset, port, channel)`). The mixer keeps
  the held notes per port: a bypassed slot that missed events is brought up to date
  when it runs again (offs / ons at offset 0), a slot whose ports change releases the
  notes of the old port, held notes keep an otherwise silent track running and new
  events wake it. Plugins report state they change by themselves
  (`takeStateChanges`: Gross Beat's slot, Vocodex's latched notes, hosted modules in
  Patcher); the engine keeps it in its slot copy and posts `fxState`, which the host
  mirrors into the project without an undo step.
- **UI**: Channel Rack Add menu and "+" (Sampler, MIDI Out), the Browser's Plugin
  database > Generators > MIDI > MIDI Out (and Sampler > Sampler); a MIDI Out
  channel's settings window shows the header row (ON, PAN, VOL, PITCH, RANGE, TRACK)
  and the MIDI Out editor at FL's form coordinates. Effect windows of Vocodex, Gross
  Beat and Patcher (Pitcher keeps FL's own port in its editor) have a PORT box in the title bar
  (drag / wheel; "⋯" = none, click it to auto-assign the selected or first MIDI Out
  channel's port) and a *MIDI input port* submenu (None, Auto assign, the ports of the
  project's MIDI Out channels, Type in port...). The knobs are automatable
  (`midiOut.values.N`).
- **Plugins**: Pitcher listens on its own port and the slot port (MIDI / OCTAVES /
  HARMONIZE / VEL from notes); Vocodex plays its carrier from notes with FL's
  controller latching; Gross Beat selects slots from notes (C5.. time, C2.. volume,
  trigger sync, Link, Key-held); Patcher routes notes along event links (see
  `fx/patcher.md`).

## Differences / not implemented

- The clone offers the wrapper input port on the windows of Vocodex, Gross Beat and
  Patcher (FL documents the wrapper port for VST / AU only; its native Gross Beat and
  Vocodex get MIDI from a focused controller or through Patcher; Patcher's slot port
  feeds From FL Studio's "Notes"). Pitcher's own port and Patcher's From FL Studio port
  outputs work as in FL.
- Controller data (CC / RPN / NRPN / aftertouch, program and bank changes, pan /
  volume / pitch, Reset, Send all control values, the flush options) has no receiver
  here (no external MIDI devices or VST plugins): stored and shown only.
- Effects receive no MIDI channel filtering; note release velocity is not sent.
- Live notes from a hardware controller go to the selected channel only (FL's
  "steal MIDI input when focused" for effects is not reproduced).
- FL's MIDI Out state layout was not decoded field by field; the clone stores its own
  JSON. The "Note" control's velocity uses the controller number (1..127, else 100)
  and the knob value maps into the note range: an interpretation.
