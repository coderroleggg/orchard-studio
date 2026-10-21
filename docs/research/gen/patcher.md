# Patcher as an instrument (FL: Patcher, Generators > Patcher)

The instrument version of Patcher is the effect's Patcher (docs/research/fx/patcher.md: graph model,
engine, editor, hosted ids) living in a Channel Rack channel. From FL Studio delivers the channel's
notes as events, the map holds instruments, effects and VFX note processors, and To FL Studio is the
channel's audio. Nothing of the effect was forked: the graph, the DSP class and the editor are shared,
and the instrument adds generator modules, note routing from the channel, hosted ids / editors /
automation inside a channel, and the instrument's definition and default state.

Files: `src/model/gen/plugins/patcher.ts` (definition), `src/engine/gen/plugins/patcher.ts` (the
instrument wrapper), `src/engine/gen/hosted.ts` (`HostedGen`: an instrument inside the patch;
`NoteSrcPool`: the channel notes' live levels), `src/ui/plugins/gen/patcher/index.tsx` (registers the
shared editor, `src/ui/plugins/fx/patcher/Editor.tsx`), `tests/gen/patcher.test.ts` (engine),
`tests/gen/patcher-store.test.ts` (store, hosted ids, automation, save / load, editor).

## What FL says (sources)

- Test host (`flfxhost info gen:Patcher --preset Default`): flags `0x00604031` = Generator, GetNoteInput,
  WantNewTick, MIDIOut, NewVoiceParams (+ bit 22); methods Gen_Render, TriggerVoice, Voice_Release,
  Voice_Kill, Voice_ProcessEvent, NewTick, MIDIIn, MIDITick; 4096 anonymous parameters; DefPoly 0. The
  host renders it silent (no FL I/O buffers behind it), so nothing audio could be measured; the binary's
  strings name `TFruityVoice` / `TOutputVoice` / "Voice output %d": Patcher passes FL voices (notes with
  their properties) between modules. FL calls such a plugin once per note with the voice's levels; in
  this framework that is the `'events'` interface (note on / off / kill with live levels, the plugin
  renders everything itself), so the channel does its note handling (key range, SHIFT, arpeggiator, echo,
  gate, polyphony, mono / porta / slides, cut groups, levels) before Patcher sees a note.
- Plugin database: `Plugin database/Generators/Patcher/` holds Patcher and the seven VFX modules as
  presets of the effect-type plugins. Category: **Patcher**. (The VFX entries are not added as channels:
  VFX modules live inside a patch; see gaps.)
- Manual (plugins/Patcher.htm): "instrument or effect"; From FL Studio provides Events and audio, its
  outputs are activated per data type (right-click > Outputs > Events), audio from the generator goes to
  To FL Studio; the map hosts instruments and effects in one chain; "Patcherize": Shift + drop Patcher
  on a Channel Rack / mixer plugin encapsulates it (not implemented).
- `Data/Patches/Plugin presets/Generators/Patcher/Default.fst` and `Data/System/Patcherize (Generator).fst`,
  decoded with `.flref/gen/tools/fst_dump.py` and a chunk walker (`.flref/patcher/chunks.py`: records
  are `[id:i32][size:i32][0:i32][payload]`, nested in `id 0` records): the generator's patch has **two
  ports only: "Notes" (events, activated: flags 7, FL's effect default has them at 5) on From FL Studio and
  "Audio output" (audio, flags 6) on To FL Studio**; there is no "Audio input" port and no link; plus the
  empty Control Surface module "Surface" (its record has one more chunk, 5009, than the effect's). The
  database's own `Generators/Patcher/Patcher.fst` has the same two ports. The
  packed I/O block holds the nodes' positions (-40, 191) and (-548, 191) where the effect's has 184: the
  instrument's nodes sit 7 map units lower.

## State

`Channel.plugin = { id: 'patcher', params: { $graph }, midiPort? }`. The graph is the effect's
(`PatcherGraph`), with:

- `gen: true`: From FL Studio has no audio output (`nodePorts`); `defaultGraph(true)` has no module and no
  link, I/O nodes at (64, 251) / (920, 251) (the effect's y is 240; same 7-unit step as FL's). The effect
  keeps its audio link. `normalizeGraph(raw, true)` (the definition's `normalize`) repairs a stored graph into
  an instrument graph; the graph without the flag still loads in an effect slot.
- generator modules: module ids start with `g` (`g2`, `g3`..., `isGenModule`), effects' with `m`. The
  kind is part of the id so that hosted ids tell the registry (`isGenSlot`); `addModule(..., gen)` makes
  one. A generator module's `plugin` is an instrument id, `params` its channel-plugin state
  (`defaultGenParams`). Ports: a "Notes" event input and a stereo audio output (`pluginPorts`).
- Everything else (links, link levels, `io.in.ports`, view, focus) is the effect's.

Hosted ids: a module of a channel's patch is `ch:<channel id>#<module id>`; a module of an effect slot's
patch stays `<slot id>#<module id>`. `channelOfSlot` returns the channel for `ch:<id>` only (not for hosted
ids, which are plugins of their own), `hostedInChannel` splits a hosted id, `isGenSlot` says which registry
a slot id belongs to (channel instruments and `g` modules: the instrument registry). Store actions
(`findFx`, `setFxParam`, `editFx`, `setFxStateNoHistory`, `fxParamsDraft`) resolve hosted ids in a channel
(`slotParamsDraft`: the module inside `Channel.plugin.params`). `allGens` also yields the generators hosted
in Patcher channels (`ch:<id>#g<n>`) and `allFx` the effects hosted in them.

Automation / link targets of a hosted parameter: `{ scope: 'channel', id: <channel id>, path:
'plugin.params.$graph.modules.<module>.params.<key>' }` (`fxTargetOf` / `pluginTargetOf`), so the
engine's generic `setPath` writes it and the channel re-applies its plugin state: automation, Init song
with this position and the clips' names and value texts (`channelParamAt`, in `formatAutoValue`) work for
instruments and effects hosted in a channel exactly as for a slot's modules. Plugin-owned state changes
(`takeStateChanges`) come out at `$graph.modules.<id>.params.<path>`.

## Engine

`GenPatcher` (an `'events'` instrument) wraps the effect's `Patcher` class (now exported):

- **Notes.** The channel calls `noteOn(note, frame)` / `noteOff` / `killNote`; they become events on From
  FL Studio's "Notes" output (sorted by sample, note offs first at a sample) for the next `render()`.
  A MIDI Out port activated on the node (`io.in.ports`, "Port p") delivers raw notes: `GenInstance.midiPorts()`
  / `portNote()` (new optional methods; `Engine.deliverPortNotes` hands the notes of those ports over).
  The channel's own MIDI input port (`plugin.midiPort`) still plays through the channel and reaches
  "Notes". Keys go to 131 (FL's range) on the channel path, 127 on MIDI ports.
- **Source levels.** Each event carries the index of its channel note in `NoteSrcPool` (512 entries, a ring
  that skips held ones): copies of the note's `init` / `levels`, refreshed every block while the note is
  held (the channel updates them once per block), frozen at its note off. VFX modules pass the source on
  with their output notes (per-note modules: the note's; Sequencer: the latest held note's). Notes
  without a source (MIDI ports) play at unity channel volume, centred, root key C5.
- **Hosted instruments** (`HostedGen`, an `EffectInstance` so `Patcher` runs it like any module: its input is
  silence, its output the voices' sum). It plays the events like a channel of its own would:
  - `'voices'` plugins: a voice per note-on at its sample (`triggerVoice` with the note's `GenVoiceParams`),
    `render` in control steps of 16 samples from the voice's first sample, volume and FL's circular pan law
    ramped per step unless the plugin applies its levels (`levels: 'plugin'`; velocity outside the volume
    for `velocity: 'plugin'`), release at the note off, the 10 ms declick of forced stops, 128 voices.
    This is `GenChannel.renderVoice` minus the INS tab.
  - `'events'` plugins: `noteOn` / `noteOff` / `killNote` with the voice object (levels once per block) and
    `render()` for the lot, as `GenChannel.runNote`.
  - levels: `pitch = source pitch + 100 x (event key - source key)` (a VFX transposition moves the pitch),
    volume = the channel's part of the source volume x the law of the event's velocity (a Level Scaler
    changes it; an unchanged velocity keeps the channel's final volume as is), pan / Mod X / Mod Y of the
    source, colour = the event's MIDI channel - 1, length and release velocity of the source.
  - `setMaxPoly` / `setInterpolation` of the channel are forwarded; sample ids resolve through the same
    pool (`slotSampleRefs` scans every hosted module's state from its own root).
- **Rendering and activity.** `render()` runs the graph with the instrument's `GenContext` as the effects'
  `FxContext` (no sidechains; `sendTo` goes through `GenContext.out`). The channel keeps rendering while
  voices sound or VFX modules still owe notes (`busy()`), then for the longest path's tail (hosted
  instruments' tails, effects' tails; Infinity when a module always runs): `isActive()`.
- A killed channel note (polyphony limit, panic) fades its hosted voices out over 10 ms from the block of the
  kill (the channel gives 'events' plugins no frame for a kill; a standalone channel starts the fade at the
  stealing note's sample). A structural change of the patch releases every note inside it (the effect's
  rule).
- `monitor()` is the patch's activity data; `monitorHosted(<module id>)` serves the hosted editors watching
  `ch:<channel>#<module>` (`Engine` routes `hostedInChannel` ids to `GenChannel.monitorHosted`).

Generators in an **effect slot's Patcher** use the same code (FL: "instruments and effects in one chain"):
their notes come from the MIDI Out ports / VFX modules, at neutral levels. The picker offers them there too
(last in Add plugin, as a Generators folder); effect slots do not reach hosted generators through
`allGens`.

## Editor

The effect's editor (1001 x 591, FL's form) bound to `ch:<channel id>`; `Editor.tsx` is the component
(`fx/patcher/index.tsx` registers it for the effect, `gen/patcher/index.tsx` for the instrument, loaded
lazily: it imports every effect editor, which the instrument registry's importers must not pull in).
In a channel (`channelOfSlot(slotId) !== null`): From FL Studio shows only its event outputs; the
Add plugin menu (right-click, F8) lists a **Generators** folder first (FL's folders; not the controllers
without audio, not Patcher itself) and then the effect categories; the node thumbnails, plugin windows
("<name> (Patcher)", factory presets, Reset to default, the editor's own menu) and window sizes come from the
instrument's own editor (`genEditorFor`, generic editor otherwise) and definition. Everything else (cables,
link levels, minimap, zoom, auto-arrange, latency / activity views) is the effect's. Verified in the app:
add Patcher from the Channel Rack, add and link a generator and an effect, open their windows, create an
automation clip from a hosted knob, live notes sound through the chain.

## Fidelity

- Exact where it can be: with the patch Notes -> generator -> To FL Studio and the Patcher channel set
  like a channel of its own, **the output is bit-identical to the generator on its own channel** for
  every deterministic instrument checked (3x Osc, DX10, Sytrus, Harmor, PoiZone, BassDrum, Drumpad, Fruit
  Kick, Harmless, Kepler, BooBass, Sawer, Sakura, Morphine, Transistor Bass, DrumSynth, Drumaxx; the legacy
  generators at their default INS tab), and the voices see the same keys, velocities, colours, lengths,
  releases and levels at the same samples (tests/gen/patcher.test.ts: a DC test instrument records them;
  an 'events' instrument gets the same note events). The instruments with a random component (SimSynth,
  MiniSynth, Plucked!, GMS, Toxic Biohazard, Ogun, BeepMap) differ from their own renders from run to run;
  hosted ones are no different.
- FL itself could not be measured (silent in the test host), so the following are assumptions: the
  channel's volume, panning and pitch reach hosted voices per voice (before the effects behind them);
  MIDI port notes play at unity volume; the polyphony limit of a hosted plugin is the plugin's own (the
  Patcher channel's DefPoly is 0, so FL's limit is not applied to hosted plugins).
- Default state: decoded from FL's files (above); the Control Surface module is left out as in the effect.

## Gaps

- **Surface tab and parameter links** (red links, Formula / Peak / Envelope controllers driving parameters)
  are not implemented (same as the effect). Controller generators (Envelope / Keyboard / Voltage
  Controller) and Dashboard-like no-audio instruments are not offered inside the patch.
- **Factory presets**: FL's `Plugin presets/Generators/Patcher/` has 172 files (36 MB): Default, 141 "X Cipryan
  Bot" instruments (1.6 MB: stacks of 3x Osc with Fruity Free Filter / Flanger / Limiter / 7 Band EQ /
  Reeverb / Center / Fast Dist / Parametric EQ / Delay, a few Peak / Envelope Controllers and VFX Keyboard
  Splitters, each with a Control Surface) and 30 "X WiseLabs" instruments (35 MB, embedded samples, 3000
  Formula Controller modules, Control Surfaces). Their modules keep the plugins' own binary states, and
  what makes them play as designed (Surface controls, parameter links, formula wiring) does not exist yet:
  not imported, nothing shipped. Feasible later: a decoder of native plugin states by FL parameter index
  (our definitions carry the index) as a runtime "Import FL content..." from the user's install, after
  Surface and parameter links.
- **INS tab of hosted legacy generators** (3x Osc, DX10, Fruit Kick, BeepMap, Granulizer, Slicer...): in
  FL 2026 their envelopes, LFOs and filter are plugin parameters; here they belong to a channel, so inside
  Patcher the INS tab is at its defaults (neutral) and the Patcher channel's own INS / MISC tabs act on the
  channel's notes only. Instruments that read the channel's sample need it in their own state.
- VFX outputs carry key, velocity and colour only (pan, fine pitch, Mod X / Y and release of a VFX
  Envelope / Key Mapper output are not applied to hosted voices; they play with the source note's);
  `GenVoiceParams.length` is the source's.
- Latency of hosted plugins is not compensated against the channel (as for every instrument).
- Editor actions of hosted instruments that need a channel (preview keyboards, slice previews, channel
  sample operations) do nothing in their Patcher windows: `channelOfSlot` is null for hosted ids, which the
  editors treat as "no channel". Everything that goes through the slot actions (parameters, state edits,
  menus, presets) works.
- "Patcherize" (Shift + drop Patcher on a plugin channel), the VFX entries of the Generators > Patcher
  database folder and "Save preset as..." are not implemented.
- Event cables do not animate for the instrument (From FL Studio has no input peak for notes).

## Shared files changed

`src/model/fx/plugins/patcher/graph.ts` (+ `gen`, `isGenModule`, `defaultGraph(gen)`, `normalizeGraph(raw, gen)`,
`addModule(..., gen)`, `pluginPorts(plugin, gen)`), `src/model/fx/plugins/patcher.ts` unchanged (re-exports),
`src/engine/effects/plugins/patcher.ts` (exported `Patcher` / `EvList`, note sources, generator nodes,
channel-note entry points, `CHANNEL_PORT`), `src/model/fx/hosted.ts` (`isGenSlot`, channel-hosted
`fxTargetOf`, `channelParamAt`, `fxParamAt.gen`, `allFx` over channels), `src/model/gen/ids.ts`
(`channelOfSlot` null for hosted ids, `hostedInChannel`, `allGens` over hosted generators),
`src/store/actions.ts` (`findFx` / `slotParamsDraft` for modules hosted in a channel, `pluginParamDef`),
`src/ui/plugins/kit/context.ts` (`pluginDefOf` / `paramDefOf` by `isGenSlot`),
`src/ui/plugins/pluginMenu.ts` (`genPickerItems`), `src/ui/playlist/autoClip.ts` (value texts of hosted
parameters), `src/audio/engineSamples.ts` (hosted modules' samples scanned from their own root),
`src/engine/gen/types.ts` (`monitorHosted`, `midiPorts`, `portNote`), `src/engine/GenChannel.ts`
(forwards them), `src/engine/Engine.ts` (port notes to plugins' own ports, hosted monitors),
`src/ui/plugins/fx/patcher/*` (`Editor.tsx` split from `index.tsx`; `Hosted.tsx`, `MapView.tsx`,
`geometry.ts`, `sync.ts`: registry by module kind, Generators picker).
