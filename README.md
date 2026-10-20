# Orchard Studio — an FL Studio–style DAW core (web)

A pattern-based DAW modeled on FL Studio's workflow: Channel Rack with step
sequencer, Piano Roll, Playlist, Mixer, the **Sampler**, **29 of FL Studio's
stock instruments** (3x Osc, Sytrus, Harmor, Harmless, Morphine, FPC, Slicex,
Drumaxx, Toxic Biohazard, PoiZone and more) and **FL Studio's stock mixer
effects** (dynamics, delays and reverbs, distortion, filters and EQs,
modulation, stereo and gain tools, pitch and time tools, controllers,
visualizers and Patcher), on top of a sample-accurate audio engine that runs in
an AudioWorklet.

The UI follows FL Studio's layout and interaction conventions. All artwork is
drawn by code, and no Image-Line assets, logos or trademarks are used. Behavior,
parameter ranges, defaults and formulas come from the research notes in
`docs/research/`: the FL Studio manual, the scripting API, PyFLP, and decoded
factory files. Every fact there is tagged confirmed, inferred or uncertain.

## Run

```bash
npm install
npm run dev        # http://localhost:5199
npm test           # engine / DSP unit tests (vitest)
npm run build      # production build in dist/
```

Click anywhere once so the browser allows audio to start.

## Architecture

```
src/
  engine/            audio engine, pure TS (runs in the AudioWorklet, in Node tests and for offline export)
    Engine.ts        transport, pattern / song sequencing, sample-accurate event dispatch, metronome
    Sequencer.ts     pattern compilation, swing, song / clip windows
    Sampler.ts       sampler voices: levels, pan law, envelopes, LFOs, filter, mono/porta/slide, echo, arp, declick
    MidiOut.ts       MIDI Out channels: their notes become port events for the effects listening on the port
    Mixer.ts         125 inserts + master + current, FX slots, built-in EQ, pan/separation, sends, PDC
    Automation.ts    automation clips per target parameter, chasing, initialized controls
    effects/ParametricEQ2.ts   7-band EQ: draft / HQ+ (decramped) / 2x oversampled HQ modes / linear phase
    effects/plugins/ the DSP of every other effect plugin (one module per plugin, found automatically)
    gen/plugins/     the DSP of every instrument plugin; InstrumentChannel.ts / GenChannel.ts: FL's channel
                     note handling (arp, echo, porta, polyphony, INS envelopes) shared by Sampler and plugins
    dsp/             biquad design (bilinear + magnitude-matched), SVF, sinc interpolation, FFT
    worklet.ts       AudioWorkletProcessor wrapper
  model/             project data model + all FL value laws (scales.ts, sampler.ts, peq2.ts, automation.ts)
    fx/plugins/      effect plugin definitions: FL's parameters (ranges, defaults, value texts), presets, state
    gen/plugins/     instrument plugin definitions, the same way
  store/             immutable store with undo/redo, actions, UI state
  audio/             AudioHost (context, worklet, project -> engine sync), sample pool, starter kit synth
  project/           save / open (.orchard.json), autosave, WAV export
  ui/                React UI: toolbar, browser, windows (channel rack, piano roll, playlist, mixer,
                     channel settings, plugin editor, automation clip editor), shared widgets
                     (knob, fader, LED, LCD, menus)
    plugins/kit/     controls for effect editors (FL vector knobs, spinners, sliders, LEDs, displays, routing)
    plugins/fx/      one editor per effect, laid out at FL's form coordinates
    plugins/gen/     one editor per instrument (the channel window's PLUGIN tab)
docs/research/       the behavior specs this clone is built from (docs/research/fx: one note per effect)
docs/fx-framework.md how an effect plugin is built (definition, DSP, editor, tests)
docs/gen-framework.md how an instrument plugin is built; docs/research/gen: one note per instrument
tests/               unit tests (timing, sequencing, levels, pan law, EQ responses, PDC, sampler semantics,
                     and per effect / instrument: ranges, FL-measured behaviour, presets round trip,
                     silence, finiteness, worklet safety)
```

The main thread owns the project as immutable state. Every change is diffed by
reference and sent to the engine as small messages: a channel, a pattern, a
mixer track. The engine sends back the playback position, peak meters and
analyzer data.

## Implemented FL behaviors (highlights)

- **Timing:** PPQ 96, 4/4 with 4 steps per beat, tempo 10–522 BPM with 1/1000 fine
  part, default 130. A pattern runs to the end of its last bar with data. Song
  mode loops at the end of the last clip.
- **Steps are zero-length notes** on C5. A Sampler with the volume envelope off
  plays the sample to its end (one-shot). With the envelope or a loop, note-off
  matters. Swing delays even steps by up to half a step.
- **Levels:** one volume curve `G(x) = (11^x − 1)/10` (the law in FL's own code) for the channel
  volume knob (78% = −5.2 dB), note velocity (100 = unity, 128 = +6.25 dB) and
  mixer faders (0.8 = 0 dB, max +5.6 dB). Channels use the circular pan law
  (−3 dB at centre). Mixer panning is merge & pan.
- **Mixer:** 125 inserts + Master + Current, 10 FX slots with mix and bypass,
  built-in 3-band EQ, polarity / swap, stereo separation, solo by muting,
  routing with cycle prevention, post-fader sends, and automatic plugin delay
  compensation.
- **Parametric EQ 2:** 7 bands, Level ±18 dB, Freq 20 Hz–20 kHz, BW 0.1–5
  octaves, 8 types, 7 slope modes (Steep / Gentle). Default bands at 63 Hz …
  6.3 kHz. FL's HQ modes: HQ+ (the default; magnitude-matched biquads), Legacy
  (2× half-band oversampling) and Enhanced (2×, 44 samples latency), plus LIN
  linear phase, a compare bank and an analyzer. Measured against FL's plugin:
  -105 .. -145 dB in the filter modes at 44.1 / 48 / 96 kHz.
- **Sampler:** precomputed sample processes, declick modes, loop / ping-pong,
  start offset, DAHDSR + tension envelopes, 5 LFOs, 8 filter types, velocity
  and key tracking, polyphony / mono / porta / slide notes, cut groups, gate,
  shift, swing mix, echo delay voices, arpeggiator, root key and fine tune.
  Live playback uses 24-point sinc interpolation by default.
- **Effects:** the effects FL Studio ships for mixer slots, under FL's names
  without the "Fruity" prefix, in each slot's menu and in Browser > Plugin
  database > Effects (FL's folders). Each has FL's parameters (ranges, defaults,
  value texts, and FL's parameter order for automation and links), its factory
  presets (preset arrows and menu in the plugin window), an editor laid out at
  FL's form coordinates, and DSP matched against the real plugin: renders of
  FL's own plugins, made with a test host, are compared sample by sample. Many
  match to float precision; [docs/fx-fidelity.md](docs/fx-fidelity.md) has the
  figures for every effect.
- **Effect routing:** as in FL, every track routed into a track is one of its
  sidechain inputs (in source order, at full level whatever the send level;
  *Sidechain to this track* makes a level-0 route). Send, Transmitter,
  Transporter, Stereo Shaper, Frequency Splitter, EQUO and Patcher send audio to
  routed tracks.
  Lookahead and linear-phase latency is compensated, and reverb / delay tails
  keep a track running after its input stops.
- **Patcher:** effect modules wired between *From FL Studio* and *To FL Studio*,
  with each module's own editor (as a live icon and in its own window), its
  presets, display data and automation; VFX modules get notes.
- **Link to controller:** the outputs of Peak Controller, Formula Controller,
  X-Y / X-Y-Z Controller and Control Surface drive any automatable control
  through FL's *Remote control settings* dialog, with FL's mapping formulas.
- **Instruments:** 29 of FL Studio's stock instruments as Channel Rack
  channels (the "+" menu, a channel's Replace / Insert menu, Browser > Plugin
  database > Generators): Synth classic (3x Osc, DX10, GMS, Harmless,
  MiniSynth, PoiZone, Sawer, SimSynth, Sytrus, Toxic Biohazard, Transistor
  Bass), Synth special (Harmor, Morphine, Plucked!), Drum (BassDrum, Drumaxx,
  Drumpad, DrumSynth Live, Fruit Kick, FPC, Fruity Slicer, Fruity Slicer 2,
  Slicex), Misc (BooBass, Voltage Controller), Controller (Envelope / Keyboard
  Controller), Visual (Fruity Dance, Video Player), plus the Layer channel.
  Each has FL's parameters, factory presets and editor, and FL's channel
  features apply to it (PLUGIN / INS / MISC tabs: arpeggiator, echo, porta,
  polyphony, envelopes). They were ported from FL's own plugin code and
  checked note by note against FL's real instruments; most are bit-exact or
  within -80 dB ([docs/gen-fidelity.md](docs/gen-fidelity.md)). Instruments
  whose sound comes from FL's sample content import it from your own FL
  installation (plugin menu > Import FL content...); none is shipped.
- **MIDI Out:** a MIDI Out channel (Channel Rack Add menu, Browser > Plugin database >
  Generators > MIDI) makes no sound and sends its notes (steps, piano roll, typing keyboard,
  previews, MIDI controller) on its port. Effects listening on that port (the PORT box /
  *MIDI input port* menu of their window, Pitcher's own port, Patcher's From FL Studio >
  Outputs > Events > Port N) get them sample-accurately: Pitcher's MIDI / harmonize modes,
  Vocodex's carrier synth, Gross Beat's slot triggering, and VFX modules inside Patcher.
- **Automation clips:** right-click any automatable control (channel, mixer,
  Parametric EQ 2, tempo, swing, main pitch) and choose *Create automation
  clip*. The clip spans the Playlist time selection or the whole song. It lands
  on the highest empty track in view and initializes the control with its
  current value. Edit in the clip body: right-click adds a point (keep holding
  to drag it), drag points (Shift/Ctrl lock an axis, Alt ignores snap), and drag
  tension handles (Ctrl: fine; right-click resets). Right-click a point for
  Delete, the 13 FL curve types, and Copy / Paste / Type in value. Right Alt+click
  deletes a point. The Step and Slide switches are there too. The title bar moves
  and resizes the clip and holds the clip menu (Select source channel, Channel
  settings, Articulator tools, Make unique, Select all similar, Delete).
  Double-click opens the clip settings: a large envelope editor, Min / Max, and
  the clip LFO (SPEED, TNS, SKEW, PW, AMT, Multiply). Clips show in the Channel
  Rack and the picker panel, and you can paint them like patterns. Playback
  follows FL: a control is driven only while a clip plays and keeps the last
  value after it. Seeking chases the value, and *Init song with this position*
  values apply when the song starts.
- **Editors:** FL tool sets (draw, paint, delete, mute, slip, slice, select, zoom,
  playback), snap (Main / Line / Cell / none / step / beat / bar fractions),
  the event editor, ghost notes, FL keyboard shortcuts, and the hint bar.

## Known differences / not yet implemented

- No pixel-for-pixel copy of FL's skin: the layout and colors are matched,
  but the artwork is original.
- The effects were measured against FL's own plugins with a test host, but the
  channel Sampler and the automation clips can't be measured that way, so
  some of their curves rest on community fits or placeholders. These are
  flagged `[U]` in the research notes and isolated in `src/model/*`: envelope
  time scale, tension shape, LFO Hz, filter cutoff and Q, the automation curve
  shapes (tension law, Single/Double curve 2 and 3, Half sine, Smooth) and the
  clip LFO's speed scale and wave morphs.
- Effects (details per plugin in [docs/fx-fidelity.md](docs/fx-fidelity.md)):
  most match FL's output to float precision or within -60 dB or better, but some
  are approximations: LuxeVerb (FL's reverb topology is unknown), Emphasis,
  Hardcore's cabinets, parts of Effector, Mobile Rack FX and Frequency Shifter,
  Transmitter and Transporter's detectors, Vocodex's higher filter orders.
  Newtone and Newtime use their own pitch / stretch engines instead of FL's
  zplane engine. Convolver ships no FL impulse files (it starts with a
  synthetic room; load your own impulses). ZGameEditor Visualizer has its own
  canvas effects instead of FL's shaders. VFX Script runs a Python subset.
  Patcher has no Surface tab or parameter links between modules. Reeverb 2
  matches FL's impulse response at 48 kHz but its wet sound differs at 44.1 kHz
  (-3 .. -8 dB residual).
- Instruments (details per plugin in [docs/gen-fidelity.md](docs/gen-fidelity.md)):
  FL's other stock instruments are not implemented: Autogun, BeepMap,
  DirectWave, FL Keys, FL Studio Mobile, FLEX, Granulizer, Kepler, Kepler Exo,
  Ogun, Sakura, SoundFont Player, Wave Traveller, Patcher as an instrument, the
  Audio Clip channel and the legacy Dashboard, FL Slayer, Wasp and Wasp XT.
  Of the implemented ones, Sawer and GMS could not be compared with FL (its
  licence check silences them in the test host), Harmor plays image /
  resynthesis presets without their image layer, the Slicers' élastique
  stretch modes are approximated, and instruments built on FL's sample
  content play substitutes until that content is imported.
- Not yet implemented: event automation (*Edit events*) and automation
  recording, the envelope tools' dialogs (Scale levels,
  Filter, Smooth up, Create sequence, Analyze audio file), audio clips,
  recording (audio/MIDI), time markers and channel looping. Time-stretch modes
  other than Resample are also missing.
