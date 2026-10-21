# Patcher (FL: Patcher, effect slot)

Files: `src/model/fx/plugins/patcher.ts` (def) + `src/model/fx/plugins/patcher/graph.ts`
(graph types and pure graph operations), `src/engine/effects/plugins/patcher.ts`
(DSP), `src/ui/plugins/fx/patcher/` (editor: `index.tsx` registers `Editor.tsx`, `MapView.tsx`,
`Hosted.tsx`, `geometry.ts`, `sync.ts`, `icons.tsx`, `Surface.tsx`, `patcher.css`),
`tests/fx/patcher.test.ts`. The same graph, engine class and editor serve Patcher as an
instrument (docs/research/gen/patcher.md): generator modules (ids starting with `g`), the
`gen` graph flag, note sources from the channel.

Sources: FL 2026 form `Patcher.txt` (SynthPanel 1001 x 591, TopWP 30 px, RootPopup
and MinimapPopup menus), the manual page, screenshots `Patcher.png` (older theme,
1.25x), `Patcher_audio_gate_example.png` (FL 2026, 1.5x: colours and sizes),
`Patcher_minimap.png`, and FL's factory `Default.fst` (decoded by hand: a "From FL
Studio" node at (40, 181.5), "To FL Studio" at (548.5, 181.5), one audio link
between their ports "Audio input" -> "Audio output", a "Notes" event port on the
input node, and a Control Surface module named "Surface"). The test host loads
Patcher but it exposes 4096 anonymous parameters and renders silence without
FL's I/O buffers, so there is nothing to measure.

## State

`FxSlot.params = { $graph: PatcherGraph }` (plus the usual `__preset`).

- `modules: Record<id, { id, plugin, name, x, y, params, outs?, threaded?, compatLevels? }>`:
  each module keeps its own plugin state (`params`, exactly what a mixer slot
  would hold). Modules are keyed by a stable id (`m2`, `m3`...), so paths such as
  `params.$graph.modules.m2.params.gain` never change when other modules go.
- `order` (creation / z order, processing tie-break), `links: { id, kind:
  'audio'|'events', from, fromPort, to, toPort, level, mute }`, `io` (positions of
  the two FL nodes), `next` (id counter), `view` (filters and View-menu options,
  minimap, tab) and `focus` (see "Editing hosted modules").
- Default (FL's Default preset): no modules, From FL Studio linked to To FL Studio.
  FL also adds an empty Control Surface module named "Surface"; the clone's
  Surface tab is an empty placeholder (below), so it is omitted.
- `normalize` repairs stored graphs: unknown fields, dangling links, duplicate ids
  and links that would close a loop are dropped.

## Processing (DSP)

- Modules are created with `createEffect(plugin, sr, blockSize, env)` and keep
  their instance (and internal state) while their id and plugin stay the same.
  Every `setParams` passes each module its own params.
- Audio links are stereo. An input port sums its links, an output fans out.
  Modules run in topological order over all links (Kahn's algorithm). The editor
  refuses links that would close a loop (`wouldCycle` / `connectError`: also self
  links, duplicates, wrong port kinds, links into From FL Studio or out of To FL
  Studio). A corrupted state still processes: a link from a later module is
  ignored, and the order releases the earliest module of a loop.
- Latency compensation inside Patcher is automatic, as the manual says: every
  input port lines its links up with the latest one (`compensate`: arrival of a
  module output = latest input + module latency; each link gets a delay line of
  `latest - arrival(source)` samples). Patcher reports the longest path (the
  latency at To FL Studio) as its own `latency`, so the mixer's PDC compensates
  the whole patch.
- `tail`: the longest sum of module tails along a path to To FL Studio, plus the
  latency; Infinity when a module always runs.
- Link level: linear gain 0..1.25 (dragging the cable's centre arrow vertically;
  the hint shows `Level: 100% (0.0 dB)`); right-click on an audio link mutes it.
  Level and mute ramp linearly over one block. The level range and text are not
  documented by FL and are an assumption.
- Module output is kept finite (NaN / huge values are zeroed) so one bad module
  cannot poison the graph. The outer `FxContext` (tempo, transport, sidechain,
  `sendTo`) is passed to every module; `sendTargets()` is the union of the
  modules' targets.
- `monitor()`: the focused module's own display data (so that module's editor
  meters work through the Patcher slot), plus `__pIds`, `__pPeak` (output peak per module),
  `__pLat` (latency per module), `__pIn`, `__pOut`, `__pTotal`, `__pSr` for the
  Activity / Latency views.

### Notes (event links)

FL's manual ("Events or MIDI to FX plugins"): load a MIDI Out channel on a port,
right-click From FL Studio > Outputs > Events and activate that port, then make the
event connection to the plugin. The clone does the same:

- From FL Studio's event outputs: 0 = **Notes** (the notes of the slot's MIDI input
  port, `FxSlot.midiPort`) and 1 + p = **Port p** (MIDI port p). Port outputs are
  activated in the node's Outputs > Events menu (the project's MIDI Out ports are
  listed with their channel names, plus "Other port..."; stored as `io.in.ports`).
  Patcher's `midiPorts()` returns the activated ports, so the mixer delivers their
  notes to it (docs/research/midiout.md).
- Effects that take notes (Pitcher, Vocodex, Gross Beat, a nested Patcher) have a
  **Notes** event input; they get noteOn / noteOff at the event's sample, right before
  they process (port -1: "the module's notes input").
- **VFX modules** play the notes live (`LiveVfx` in the engine file) through their
  pure note processing (`notes()` / processNotes) and send the results on along their
  voice outputs (`note.port`), sample-accurately, to the next modules:
  - per-note mode (Color Mapper, Key Mapper, Keyboard Splitter, Level Scaler,
    Envelope, Script): a note is processed when it starts, on its own (times relative
    to its start, a seeded random source per note, 4 bars long, Script 2 bars); its
    outputs are scheduled from the note start and the release ends the ones still
    sounding (outputs that run to the provisional end last until the release). The
    module's counters carry over in `VfxContext.state` (Key Mapper's Cycle up / down);
  - batch mode (Sequencer: the arpeggiator needs the whole chord): the held notes and
    the recently released ones (with their real lengths) are processed together at
    song ticks whenever they change and every half bar; future outputs are replaced
    and sounding outputs the new result no longer has are released.
- A structural change of the patch (modules, links) releases every note inside it.
- Hosted modules' own state changes (Gross Beat's slot, Vocodex's notes) come out of
  Patcher's `takeStateChanges` at their graph paths
  (`$graph.modules.<id>.params.<key>`) and are mirrored into the project.

Generators now receive VFX output notes (the instrument version and generator modules,
docs/research/gen/patcher.md: they follow the key, velocity and colour of the notes and the live
levels of the channel note they come from); what is still without a receiver: note
properties other than key / velocity / colour (pan, fine pitch, mod X / Y, release,
`mod` curves of VFX Envelope / Key Mapper slides, Key Mapper's gain compensation) have
none; VFX Script runs per note (scripts that keep state across notes, such as
tick-driven arpeggiators of several held notes, run once per note; its Log shows
compile-time output only); the Sequencer's latch continues for the one pattern length
of its offline model after the last release; hosted modules do not listen on their own
ports (Pitcher's port inside Patcher is ignored: notes come from event links); MIDI
channels are not filtered (the Sequencer's MIDI In channel).

## Editor

Panel 1001 x 591 at FL's form coordinates. Colours sampled from the FL 2026
screenshot: top bar `#3c464c`, map `#454f55`, audio `#ffdf20` (unlinked port
`#b66700`), events `#2cffdb` (unlinked `#009259`), port outline black, labels white.

- Top bar: options button (4,2 17x26: the map menu), Map / Surface sheet tabs
  (25,2), minimap button (747,3) and the Audio (793) / Parameters (852) / Events
  (930) LED check boxes (left-click toggles a filter, middle-click solos it).
- Nodes: module icons are live miniatures of the modules' own editors scaled into
  FL's icon box (`min(0.45, 156/w, 76/h)`), with ports on the left / right edge,
  label below. From / To FL Studio use original arrow-and-bracket glyphs.
  Unconnected ports are drawn in the darker colour, as in FL 2026.
- Cables: cubic curves with horizontal tangents and an arrow at the middle;
  hovering the arrow shows the level ring; muted links are dashed and dim; with
  View > Activity, links whose source carries signal show moving dashes.
- Mouse: drag a node (Ctrl/Shift-click adds to the selection, rubber band on empty
  space), drag output -> input (or input -> output) to link, compatible ports light
  green, dropping on a node lists its compatible ports (FL's popup), pick up a link
  by its input end to move it or drop it in empty space to remove it, double-click
  a module to open its editor (closing the others), Alt+click to open it keeping
  the others, right-click for the module menu in FL 2026's order (Rename...,
  Save preset as... (disabled), Disconnect, Delete, Inputs, Outputs (activate
  VFX voice outputs: Activate all / Deactivate all / per port), Allow threaded
  processing) or the map menu (FL's RootPopup: Show plugin picker (F8),
  Add plugin (by category), View (Audio, Events, Parameters, Activity, Labels,
  Latency, Performance, Minimap), Zoom (Zoom out, Next zoom area), Auto-arrange
  modules, Hide all plugin windows, Visual and Processing options, About).
- Navigation: wheel scrolls, Ctrl / Alt / Shift + wheel zoom vertically /
  horizontally / both (node icons follow the smaller axis), middle-drag pans,
  Ctrl + right-drag zooms into a region (a click returns), double-click on empty
  space toggles the zoomed-out view, scrollbars at the right and bottom.
- Minimap (button, M, Shift+M cycles Tiny / Medium / Large, 1-4 corners, right-click
  menu = FL's MinimapPopup): grey modules, cyan I/O nodes, orange view rectangle
  that can be dragged; clicking elsewhere centres the view there.
- Auto-arrange modules puts modules in one column per processing depth (FL's
  "multithreaded columns"), From FL Studio left, To FL Studio right.
- Latency view: each module's latency in ms above it (inside with "Show info
  inside modules"). Performance view: shown, but the AudioWorklet has no
  high-resolution clock, so the CPU values read "-".
- Del deletes the selection, F8 opens the plugin picker at the mouse.

### Editing hosted modules

Double-clicking a module opens its own editor (`editorFor(plugin)`, or the
generic editor) in a floating plugin window inside the Patcher editor, titled
"<name> (Patcher)", with the module's factory presets (selector and arrows), a
window menu (presets, Reset to default) and a close button. Windows that do not
fit are scaled down.

Each hosted editor gets an `FxEditorCtx` built by `hostedCtx()` (`sync.ts`):

- `params` = the module's own state, `slotId` = the Patcher slot (meters, menus).
- `setParam(key, v)` writes `$graph.modules.<id>.params.<key>` (undo label = the
  parameter name, merge key per module and parameter, like `setFxParam`).
- `editState(label, recipe)` runs the recipe on the module's params object as one
  undoable graph edit. Patcher's version also takes an undo merge key (made
  unique per module) and adds `editView(label, recipe)` (no undo entry, for view
  fields such as a selected page); the VFX editors use these through
  `useVfxEdit()` / `useVfxView()` (`vfx/common.tsx`), other editors through the
  kit's `useFxEdit()`.
- `autoPath = 'params.$graph.modules.<id>.params'`, so right-click > Create
  automation clip on a hosted control targets the module itself; the engine's
  `setPath` writes the nested key and Patcher's `setParams` hands each module its
  params. Automation is exact whether or not the module is focused, and module
  ids are stable, so the path survives other modules being deleted.

Every edit is a normal Patcher slot edit, so undo / redo work across module
windows in any order (verified in the running app with two editors). The node
miniatures get an inert context (writes are no-ops, inert slot id: no meters).

`focus` (the module whose window got the last pointer, wheel, key or
context-menu press) only selects whose display data Patcher's `monitor()`
returns; meters and live displays of the other open module windows stay still.

Editors that still write with `A.editFx(ctx.slotId, ...)` /
`A.setFxStateNoHistory(ctx.slotId, ...)` / `setFxParam(ctx.slotId, ...)` instead
of the context reach the top of the Patcher state. A store listener (`sync.ts`,
`guardFix`) drops such stray keys and restores the graph when a recipe removed
it (a preset recipe that clears every key), so those edits are lost rather than
harmful. The same holds for an editor's own `menu(slotId)` items, which is why
hosted windows do not show them.

## Not implemented / differences

- **Surface tab** (Control Surface with controls linked to module parameters,
  edit mode, grid): skipped. The tab is shown and empty. FL's default "Surface"
  module is therefore not added.
- **Parameter links** (red): no controller -> parameter links inside Patcher; the
  Parameters filter has nothing to show and module menus list "Parameters"
  disabled.
- Event links carry notes (above); VFX editors do not show the live notes (Level Scaler
  lollipops, Sequencer detected chord, Keyboard Splitter input line).
- Patcher inside Patcher is not offered in the Add plugin menu (Patcher's own
  editor writes its slot directly, so a nested one would edit the outer graph, and hosted
  ids have one level, "<slot>#<module>"); the DSP would run it.
- Generators can be added to an effect slot's patch too (Add plugin > Generators, last):
  their notes come from MIDI Out ports and VFX modules, at unity volume.
- Modules get the outer track's sidechain inputs; FL can expose them as extra
  outputs of From FL Studio.
- Plugin picker (F8) is the categorized plugin menu; plugin presets cannot be
  saved; module rename uses a prompt.
- "Remember tab sizes", "Hide all plugin windows on close" (kept), "Link velocity",
  "Multithread plugins on this map" and "Allow threaded processing" are stored
  switches without effect.
