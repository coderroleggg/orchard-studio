# Instrument (generator) plugin framework

How FL Studio's stock instruments (Browser > Plugin database > Generators)
are built in Orchard Studio. It mirrors the effect framework
(docs/fx-framework.md): every instrument is a plugin of up to four files that
are discovered automatically (`import.meta.glob`), so adding one never edits a
shared registry, and instrument editors use the same editor kit as effects.

| Part | File | Exports |
|---|---|---|
| Definition (shared by engine and UI) | `src/model/gen/plugins/<id>.ts` | `def: GenPluginDef` |
| DSP (AudioWorklet and Node tests) | `src/engine/gen/plugins/<id>.ts` | `gen: GenModule` |
| Editor | `src/ui/plugins/gen/<id>.tsx` or `src/ui/plugins/gen/<id>/index.tsx` | `editor: FxEditorModule` |
| Tests | `tests/gen/<id>.test.ts` | vitest |
| Research notes | `docs/research/gen/<id>.md` | the plugin's spec |

The reference implementation is **Fruit Kick** (`fruitkick.ts` / `.tsx` in each
place; docs/research/gen/fruitkick.md). FL's generator forms are extracted in
`scratchpad/gen/forms/<FL folder name>.txt` (tool: `scratchpad/gen/tools/extract_gen_forms.py`),
FL's parameter lists and plugin flags in `scratchpad/fx/host/gen/flags/<name>.log`,
and the factory presets are in FL's `Data/Patches/Plugin presets/Generators/<name>/*.fst`
(`scratchpad/gen/tools/fst_dump.py` prints their parameter values).

## Channels

- `Channel.kind` is `'plugin'` and `Channel.plugin = { id, params, midiPort? }`:
  the instrument's state (like `FxSlot.params`, JSON-serialisable, normalised
  on load by `normalizeGenParams`), and the MIDI input port (see Note inputs).
- The channel keeps its `sampler` settings: the header's pitch range, the
  MISC tab and, for plugins FL shows the INS tab for, the INS tab. A plugin
  channel with a plugin id this version does not know keeps its stored state
  and stays silent.
- `createGenChannel(id)` / `A.addGenChannel(id)` (named after the plugin,
  `def.defPoly` as MISC max polyphony), `A.replaceGenerator(channelId, g)`
  (keeps notes, routing and channel settings; drops the old plugin's state and
  the links of its parameters / outputs), `A.insertGenerator(afterId, g)`,
  `A.addGenerator(g)`, with `g` a `GeneratorChoice`: the Sampler, MIDI Out or
  `{ kind: 'plugin', id }`.

## Definition (`GenPluginDef`, src/model/gen/types.ts)

The effect definition's shape (`FxPluginDef`: `id`, `name`, `params` of
`FxParamDef` in FL's control units with FL's names / indices / value texts,
`presets`, `viewState`, `state()`, `normalize()`, `outputs`, `width` /
`height`, `hidden`, `description`); the rules of docs/fx-framework.md apply
unchanged (FL's form `Min` / `Max` / `DefaultValue` / `Tag`, names from the
control hints, `format` = FL's value text, presets from the test host or the
.fst files). Instrument-specific fields:

- `category` (+ `alsoIn`): FL's Generators folder: Controller, Drum, MIDI,
  Misc, Patcher, Sampler, Synth classic, Synth special, Visual. Names drop
  "Fruity " (`Envelope Controller`, `DX10`, `Slicer`).
- `notes`: how notes reach the plugin:
  - `'voices'` (FL's TriggerVoice / Voice_Render, also the "hybrid"
    FPF_UseSampler generators): the channel triggers one voice per note and
    renders it (most synths and drum synths);
  - `'events'` (FL's Gen_Render plugins with their own voice management: FPC,
    DirectWave, Slicex...): the plugin gets note on / off events and renders
    all its voices itself.
- `ins`: FL shows the INS tab (legacy native generators: 3x Osc, Fruit Kick,
  BeepMap, DX10, Granulizer, Slicer...; their FL parameter lists contain the
  "Volume envelope - Attack time"... block). Their voices take the channel's
  INS envelopes, LFOs and filter with the Sampler's code and semantics.
  Other plugins get only the channel's levels. Ignored for `'events'` plugins.
- `levels`: who applies a voice's volume and panning: `'channel'` (default:
  the voice renders at unity gain, centred, and the channel multiplies and pans
  it like the Sampler) or `'plugin'` (the voice applies `levels.vol` /
  `levels.pan` itself, e.g. when FL's plugin maps velocity to its own
  modulation; use `computeLRVol` for FL's pan law).
- `velocity`: `'levels'` (default: velocity is part of the voice's final
  volume) or `'plugin'` (the plugin maps the note velocity itself, and FL
  leaves it out of FinalLevels.Vol; measured for BassDrum, MiniSynth, PoiZone
  and others: check each plugin with the test host).
- `noAudio`: controllers without audio output (FL hides the TRACK selector).
- `defPoly`: FL's `TFruityPlugInfo.DefPoly`, set as MISC max polyphony when the
  plugin is loaded.
- `keyNames(params)`: the names the plugin gives its Piano roll keys (FL's
  `GetName(FPN_Semitone)`: Dance's moves on keys 59..68, a drum kit's pads...) as
  `{ key: name }` for the plugin's state; the Piano roll's keyboard, note labels and
  hints show them, other keys keep their note names.

Registry (src/model/gen/registry.ts): `GEN_DEFS`, `genDef`, `genParamDef`,
`genInCategory`, `genCategories`, `defaultGenParams`, `normalizeGenParams`,
`genPresetState` (= the effects' `presetState`: defaults + preset, clamped to
the controls' ranges, normalised, view state kept; shared code in
src/model/fx/params.ts), `genOutputs`, `registerGenDef` (tests).

## DSP (`GenInstance`, src/engine/gen/types.ts)

The worklet restrictions of docs/fx-framework.md apply (no DOM, `window`,
timers, `fetch`, `performance` or storage; `structuredClone` is polyfilled; no
allocation in render paths: preallocate voices). `createGen(id, sr, bs, env)`
(src/engine/gen/index.ts) creates an instance; `env.sample(id)` reads the sample
pool (pool ids under keys containing "sample" in the plugin state are delivered
to the engine automatically, src/audio/engineSamples.ts).

- `setParams(p)`: the whole state on every edit and automation step.
  Precompute there.
- `'voices'` plugins: `triggerVoice(params, ctx?)` returns a `GenVoice` (or null)
  when the voice's first sample is due (`ctx`: the block's context, e.g. the
  tempo a plugin reads when a voice starts); the channel then calls
  `voice.render(L, R, n)` every control step (n <= 16, buffers start at 0 and
  arrive zeroed; add the voice; return false once it has finished),
  `voice.release()` at the note off (FL's Voice_Release) and `voice.kill()`
  when it drops the voice (end, stolen, panic; FL's Voice_Kill). Voices must
  not be reused while the channel holds them: keep as many as a channel can
  hold (128) or return null.
- `'events'` plugins: `noteOn(note, frameOffset)` / `noteOff(note,
  frameOffset)` (the sample in the next `render()` call), `killNote(note)`
  (polyphony limit, panic), `isActive()` (keep rendering while voices sound).
- `params` / `note` (`GenVoiceParams`, FL's TVoiceParams): `key` (after the
  root key when MISC "Add to key" is on), `velocity` (0..128), `release`
  velocity, `color` (0..15), `length` (samples after the gate, Infinity for
  live notes), `frame` (the block frame at which the channel triggers / releases / kills the voice:
  for plugins that time-stamp events, see Controllers), `init` (FL's InitLevels) and `levels` (FL's FinalLevels, live:
  updated by the channel before every render; `pitch` in cents with C5 = 6000,
  `vol` 1 = unity, `pan` -1..1, `fcut` / `fres` = Mod X / Mod Y offsets).
  The objects belong to the channel: keep a reference only while the voice lives.
- `render(L, R, n, ctx)` (optional): once per block after the voices:
  `'events'` plugins add all their voices; `'voices'` plugins may process the
  summed voices in place (a synth's global effects). `ctx` has tempo, ppq,
  playing, pos, songMode, track and `rendering` (true during WAV export: FL's
  PM_IsRendering; use only where FL's plugin renders differently on export).
- `setMaxPoly(n)` (optional): FL's FPE_MaxPoly, the channel's MISC max
  polyphony (0 = unlimited), sent when the channel gets the plugin and on every
  change, for plugins that limit their own voices with it (DX10, MiniSynth).
- `tail` (seconds the plugin sounds after its last voice; Infinity = always
  render, controllers), `latency` (reported, not compensated yet), `reset()`,
  `allNotesOff()` (panic), `monitor()` (editor data; the channel adds
  `__active`), `controls()` (controller outputs, see below),
  `takeStateChanges()` (state the plugin changed by itself, mirrored into the
  project like effects'), and for hosts (Patcher): `monitorHosted(moduleId)`
  (display data of a hosted module, watched as "ch:<channel id>#<module id>"),
  `midiPorts()` / `portNote(on, key, velocity, frame, port, channel)` (MIDI Out
  ports the plugin listens on by itself; the engine hands it their raw notes).
- Levels and their scaling to FL's TVoiceParams live in one file,
  src/engine/gen/levels.ts (`setInitLevels`, `setFinalLevels`, `noteVolume`,
  `computeLRVol`, `pitchToHz`, `PITCH_C5`, `FL_C5_HZ`, `flFinalPitch`), as the
  test host measured them: InitLevels.Vol = (11^(vel/100) - 1)/10, InitLevels
  .Pitch = 100 x key, FinalLevels = init + channel (volume gain 0.5510106 at
  the default 78 % knob, pitch -100 x root key so the final pitch is 0 at the
  root key, FL's circular pan law), and FL's instruments play final pitch 0 at
  523.25 Hz (`pitchToHz(levels.pitch)`). Correct scaling there, never in a plugin.
- Measure FL's instruments with the test host (scratchpad fx/host README,
  "Generators"): `flfxhost render "<Plugin>" --notes "60:100:0:0.5" -o out.wav`
  renders the plugin's raw output for a voice at channel volume 100 % (add
  `--fl-channel` for FL's default channel, `--preset Default` for the state FL
  loads into a new instance), `info` / `sweep` give parameter names and texts.

## Channel features and plugin voices

FL's channel note handling is shared by the Sampler and instrument channels
(src/engine/InstrumentChannel.ts; the Sampler's voice source is
src/engine/Sampler.ts, plugins' is src/engine/GenChannel.ts). Per FL's manual
(chansettings_misc, chansettings_main):

| Channel feature | Effect on a plugin channel |
|---|---|
| Key range (MISC keyboard), time SHIFT, swing mix | notes outside the range are dropped; notes move like the Sampler's |
| Root key, FINE, main pitch switch | pitch levels (`init.pitch`, `levels.pitch`); "Add to key" moves `key` instead of only the pitch |
| Arpeggiator, echo delay (feedback, pan, cut, res, pitch, time, count, ping pong, fat) | note-level: each arpeggio note / echo is its own voice with its own levels |
| GATE, full porta | caps note lengths (note offs come earlier) |
| Max polyphony | the oldest voice over the limit stops: a 10 ms declick fade by the channel, then `kill()` (`killNote` for 'events') |
| Mono | the sounding voice is released (`release()`); overlapping notes glide (pitch, pan, Mod X / Y levels) |
| Porta, SLIDE, slide notes | glides of `levels.pitch` (plugins that ignore pitch level changes cannot slide, as in FL) |
| Cut / cut by | an all-notes release (`release()`) of the cut channel's voices |
| Levels adjustment (PAN, VOL, MOD X, MOD Y), velocity / key tracking | `levels.pan`, `levels.vol`, `levels.fcut`, `levels.fres` |
| Channel VOL, PAN, PITCH x RANGE | `levels.vol` / `levels.pan` (applied per voice by the channel unless `levels: 'plugin'`), `levels.pitch` |
| INS envelopes / LFOs (INS plugins) | VOL: volume level (with the envelope on, its release is the voice's release: the plugin voice is not released and sounds until the envelope ends); PITCH: pitch level; MOD X / Y: `fcut` / `fres` and the INS filter; PAN LFO: pan level |
| INS filter (INS plugins) | applied to the voice output by the channel (the Sampler's SVF), cutoff / resonance from the knobs plus the Mod X / Y levels |
| ON switch | pattern / song notes stop reaching the plugin; live notes still play (as FL) |

Levels are updated every control step (16 samples, the Sampler's control rate),
and the channel's gain and pan ramp linearly over each step like the Sampler's.

## Note inputs

Pattern / song notes (sequencer), live notes (typing keyboard, preview
keyboards, piano roll previews, MIDI input: `host.noteOn(channelId, ...)`) and
MIDI Out notes all reach plugin channels. A plugin channel with
`plugin.midiPort` >= 0 (the window menu's MIDI input port, or the port box in
its title bar) plays the notes MIDI Out channels send on that port,
sample-accurately.

## Controllers (Link to controller)

Controller instruments (Envelope / Keyboard / Voltage Controller) name their
outputs in `def.outputs` and report them with `controls()` (0..1, read after
every block, also when no notes play: give them `tail = Infinity`). They are
listed as link sources "<channel name> - <output>" with the source slot id
"ch:<channel id>".

Controller engines (src/engine/gen/plugins/keyboardctrl.ts, envctrl.ts):

- Notes arrive as voices; `GenVoiceParams.frame` is the frame of the current block at which
  the channel triggers / releases / kills the voice (set before `triggerVoice`, `release()`
  and `kill()`), so a plugin can time-stamp its events and apply them in order inside its
  own `render()`. `levels.fcut / fres` are the voice's Mod X / Y including the channel's.
- FL runs these plugins once per song tick (NewTick, also while stopped). `render()` splits
  its block at the ticks: aligned to the song's ticks through `ctx.pos` while `ctx.playing`,
  free running otherwise. Tick k sits at sample floor(k x samples per tick); a note's events at
  a sample are applied before that sample's tick, and a tick that falls on a block boundary
  (float error of the position) belongs to the block that starts there (test the position
  with `Math.floor(t + 1e-6)`, never `t < n`).
- `controls()` returns NaN until the output was first set; FL sends an output when it changes.
- A plugin that feeds several mixer tracks (Voltage Controller's outputs 2..4) adds its extra
  stereo pairs with `GenContext.out(track, L, R, n)` from `render()` (absolute track index).
- `monitor()` data for the editor (last note, voltages) goes through `useFxMonitor`.
- Test with tests/gen/ctlutil.ts: `driveCtl` (blocks with timed notes), `driveCtlChanges`
  (16-sample control steps, scripted parameter changes, every output's changes as
  [tick, value]) and recorded FL outputs as golden data (tests/gen/envctrl.golden.ts).

## Patcher (an instrument that hosts plugins)

Patcher (docs/research/gen/patcher.md) is an `'events'` instrument that runs the effect's Patcher
engine: instruments and effects of its patch are modules of the channel's plugin state (`$graph`;
generator modules have ids starting with `g`). A module is addressed as "ch:<channel id>#<module id>"
(`isGenSlot` tells an instrument's slot id from an effect's: `channelOfSlot` is null for hosted ids,
`hostedInChannel` splits them); its automation / link target is channel-scoped
(`plugin.params.$graph.modules.<module>.params.<key>`). `HostedGen` (src/engine/gen/hosted.ts) plays
an instrument inside the patch from note events the way a channel does.

## Layer channel (Misc > Layer)

`Channel.kind` is `'layer'` and `Channel.layer = { children, random, sequential,
crossfade, fade }` (src/model/layer.ts; docs/research/layer.md): a channel that makes no
sound and plays its notes on its children (Sampler, instrument and MIDI Out channels).
`GeneratorChoice` has `{ kind: 'layer' }` (Add one / Replace / Insert, Browser > Plugin
database > Generators > Misc); actions: `A.addLayerChannel`, `A.setLayerChildren` (the rack's
selection, rack order, moving channels out of another layer), `A.showLayerChildren`,
`A.splitLayerChildren` / `A.resetLayerChildren` (children's key range and root key),
`A.groupLayerChildren`, `A.deleteLayerChildren`, `A.createLayerWithSelected`, `A.setLayer`.

Engine: `Engine.layers` (LayerChannel, no render step). Pattern notes (`Engine.dispatch`) and
live notes (`noteOn` / `noteOff`) of a layer reach every child (or one: Random, Sequential) at
the same frame with the same key, velocity, pan, fine, Mod X / Y, colour, slide / porta and
length, through the child's own note handling (`Engine.playOn`: cut groups, key range, SHIFT,
arpeggiator, echo...), whatever the child's ON switch says. The layer's VOL, PAN, PITCH,
levels adjustment, fine tune and crossfade reach the voices it started as a `LayerTap`
(InstrumentChannel: `voiceBase` / `controlStep` add it to the voice's levels every control
step: volume multiplies, pan / pitch / Mod add), so sounding voices follow knob moves,
automation and links (`layer.fade`, 0..256). A muted layer plays no pattern notes (live notes
still play). `Engine({ random })` injects Random's generator. Instrument plugins need nothing:
a child's `levels` already include the layer's.

UI: the layer's window (header without TRACK, one MISC page: Levels adjustment, Layering at
FL's form coordinates, Root note / key region keyboard), the rack row without a mixer box and
its Set / Show children / Layering menu items, "Create layer with selected channels".

## Editors

- An instrument editor is an `FxEditorModule` (src/ui/plugins/registry.ts:
  `Editor`, `menu(slotId)`, `size(params)`, `Persistent`) registered by
  src/ui/plugins/genRegistry.ts. Without one the generic knob editor shows.
- The editor runs inside the kit's `FxEditorContext` with
  `slotId = "ch:<channel id>"`, `trackName` = the channel name. Every kit
  control and action works unchanged: `useParam`, `useFxState`, `useFxEdit`,
  `useFxView`, `useFxMonitor`, `Wheel`, `Slider`, `Check`... The store's slot
  actions (`findFx`, `setFxParam`, `editFx`, `setFxStateNoHistory`,
  `fxParamsDraft`) resolve "ch:<id>" to `Channel.plugin.params`; walk all
  instruments with `allGens(project, pluginId)` (the counterpart of `allFx`).
- Automation / link targets: build them with `pluginTargetOf(slotId, key)`
  (src/model/fx/hosted.ts), which gives `{ scope: 'channel', id: <channel id>,
  path: 'plugin.params.<key>' }` for instruments (`fxTargetOf` returns the same
  for instruments and the scope-less `{ id, path }` of effects). Labels:
  `paramLabel(ctx, name)` = "<channel> - <parameter>". Automation clips,
  Init song with this position and Link to controller then work on instrument
  parameters; automation names and clip value texts use FL's parameter names
  and value texts.
- Panels follow FL's form (`SynthPanel` size, controls at the form's
  Left / Top / Width / Height, colours sampled from FL's screenshots; original
  drawings only). Plugin-specific widgets stay in the plugin's folder.
- The channel settings window (src/ui/channelsettings/ChannelSettings.tsx,
  GenPanel.tsx): header ON / PAN / VOL / PITCH / RANGE / TRACK (TRACK hidden
  for `noAudio`), tabs PLUGIN (the editor scaled to the window), INS (when
  `def.ins`) and MISC; the window follows the page size. The title bar has the
  wrapper's preset arrows and preset menu (`genPresetState`, one undo step) and
  the MIDI input port box when set; the options menu has Presets, MIDI input
  port, the editor's `menu` items, Reset <plugin>, Replace, Reset channel settings.
- Menus: the Channel rack's "+" and Add one, the channel button's Replace and
  Insert, and Browser > Plugin database > Generators list FL's folders with
  their plugins (src/ui/plugins/genMenu.ts). The Browser drags `gen:<id>` (onto
  the rack: a new channel; onto a channel: Replace); double-click adds one.

## Tests

`tests/gen/util.ts` has an engine factory, `play` (a pattern on channels),
`rms` / `peak` / `firstNonZero` and test instruments (a DC 'voices' plugin
recording its levels, an INS variant, a `levels: 'plugin'` variant, an
'events' recorder, a controller). Framework tests: tests/gen/framework.test.ts
(voices per note, levels, MISC features, INS, kind / plugin switches,
automation, 'events', note inputs, controllers, monitors, export flag),
tests/gen/store.test.ts ("ch:<id>" actions, targets, links, replace / insert,
save / load), tests/gen/roundtrip.test.ts (every def and preset) and
tests/gen/worklet-safety.test.ts. Each instrument tests its registration
(ranges, defaults, texts, presets), its signature sound, parameter changes and
finiteness at extreme settings and keys.

```
node node_modules/typescript/bin/tsc --noEmit -p .
node node_modules/vitest/vitest.mjs run tests/gen
```

## Reproduce FL exactly

The effect rules apply (docs/fx-framework.md, DSP): reproduce FL's own
parameter smoothing, stepping and clicks, add nothing FL does not have
(oversampling, anti-aliasing, de-zippering), keep output finite (document any
clamp). For instruments in addition:

- Measure with the test host's generator rendering (another agent extends
  `flfxhost` for TriggerVoice / Gen_Render): render notes at several keys,
  velocities and lengths, with parameter sweeps, and pin FL's numbers in the
  tests. Until then mark the research note "calibration pending (test host)".
- Voice semantics are FL's: whether a plugin's voice reacts to note offs, how
  it starts (phase, retrigger), how it ends (its own decay vs the note length),
  how velocity maps (to volume through `levels.vol`, or inside the plugin with
  `levels: 'plugin'`), what pitch levels do (FL plugins that cannot bend ignore
  later pitch changes).
- Channel-side behaviour is shared and must not be re-implemented in a plugin:
  envelopes, LFOs, filter (INS), arpeggio, echo, polyphony, glides.
- Pending confirmations shared by all instruments (src/engine/gen/levels.ts):
  InitLevels.Pitch origin (C5 = 6000 assumed), InitLevels.Vol for velocities
  (the Sampler's velocity law assumed), how channel volume / pan / MISC fold
  into FinalLevels, FL's ComputeLRVol pan law (the Sampler's circular law
  assumed), the A5 = 440 Hz reference, the fade FL uses when the polyphony limit
  stops a plugin voice (10 ms assumed, GenChannel.ts) and the rate at which FL
  updates FinalLevels (every 16 samples here).
