# Layer channel

FL Studio's Layer (Browser > Plugin database > Generators > Misc > Layer; the Channel
rack's "Create layer with selected channels") is a **channel kind**, not a plugin: it has
no binary, no editor and no mixer track. It plays its notes on its **child channels**.
Files: `src/model/layer.ts` (settings, rules, helpers), `src/engine/LayerChannel.ts` (the
engine side), `src/engine/InstrumentChannel.ts` (`LayerTap`: the layer's live levels on a
child's voices), `src/engine/Engine.ts` (dispatch, live notes, panic), `src/store/actions.ts`
(`addLayerChannel`, `setLayerChildren`, `splitLayerChildren`...),
`src/ui/channelsettings/LayerTab.tsx` + `layer.css` + `layerMenu.ts` (the window),
`tests/layer.test.ts`.

## Sources

- FL online manual, *Channel Settings - Layer* (`chansettings_layer.htm`, text and its
  screenshot `img_shot/layer_channel.png`, fetched 2026-10) and the local mirror's
  *Miscellaneous Channel Settings* (preview keyboard, key region, root note, the ON switch's
  note for instrument channels), *Main Plugin Wrapper Controls* (header, TRACK),
  *WhatsNew* (FL 21: new Layer channels default to 100 % volume; FL 20.x: the "Sequential"
  mode) and *Channel rack* (Sort by Type lists Layers first).
- FL 2026's forms, extracted with `extract_forms.py` (`scratchpad/auto/pluginform_full.txt`,
  `mainform_full.txt`): the channel window's **FuncSheet** (the MISC page) with the
  `LayerPanel`, `OfsLevelsPanel` and `KeybPanel`, and the main form's `LayerMenu` and
  `SSMenu` (the Channel rack's menu).
- FL 2026's templates, decoded with `fst_dump.py` + PyFLP's channel model:
  `Data/System/LayerTrack.fst` and `Data/Patches/Plugin database/Generators/Misc/Layer.fst`.
- The 28 layers in the FLP files FL ships (demo songs and templates, 7 files), read with
  the same event decoder: channel type, children events, flags, names, root notes.
- FL's release notes (`WhatsNew`, every version since 3.4.0): the history of the layer, see
  "From FL's release notes" below.
- FL SDK (`TLevelParams`): "final voice levels (voice levels + parent channel levels)".
- No test host exists for it (no plugin binary): everything below is the manual, the forms,
  the templates and the shipped projects. **Exact** and **interpreted** parts are listed at
  the end; calibration against FL itself is pending for the interpreted ones.

## What FL does (confirmed)

- A Layer **makes no sound**. The notes it plays (step sequencer, piano roll, typing
  keyboard, preview keyboards, MIDI input) are passed to its **children**: Sampler
  channels, native generators and VST / AU plugins, **not another Layer**. The children
  play them as if the notes were played on them: the child's own key range, root key,
  arpeggiator, echo, cut groups... apply. ("Setting a key region for a channel will cause
  notes outside the region to be ignored... useful when using a channel as part of a
  Layer".)
- **Levels adjustment** (VOL, PAN, pitch) and the header's controls apply only to notes
  played *through* the layer, not to a child's own steps or piano roll.
- **Setting children**: right-click the selector of each channel (selection toggles
  independently), press **Set children**. It assigns *all selected channels* as children;
  "to remove channels, select the ones to keep and press the button again" (everything
  unselected is unassigned). **Show children** selects the children and deselects all
  other channels.
- **Random**: off = every child sounds on each note; on = one random child plays.
  **Sequential**: the children play in turn, round robin, "starting with the highest
  channel working to the lowest *when Set children was used*"; the order is remembered
  (re-order the channels and press Set children again).
  **Crossfade**: the FADE wheel crossfades between the children: with three children the
  wheel sounds *Child 1 > Child 1 + Child 2 > Child 2 > Child 2 + Child 3 > Child 3*; the
  channels fade "from top (knob left) to bottom (knob right) in the Channel Rack". Only
  FL-native plugins crossfade, not VST / AU. An Envelope Controller can be a child, its
  output linked to the crossfade control.
- **Layering menu** (the arrow in the panel title): **Split children** (spreads the
  children over the keyboard from the layer's root key, one child per key, "the root keys
  of the children are automatically adjusted, so that the correct pitch is played through
  the Layer"); **Reset children** (resets range and root notes of all children, undoing
  Split); **Group children...** (adds all children to a named group); **Delete
  children...** (the manual: "removes selected children"; FL 2026's menu hint: "Delete all
  children channels").
- **Preview keyboard**: left-click plays, right-click sets the root key, dragging on the
  ruler sets the key region.
- The ON switch of an instrument channel "applies only to Stepsequencer and Piano roll
  playback; live MIDI input will continue to play".

## From FL's release notes

- 3.4.0 (2001): layer channels are introduced, "to control several channels at once".
- 12.5 (2017): *Split children* can be reset easily (*Reset children*).
- 20.9 (2021): undo for changing the children of a layer; a new **sequential** playback
  mode (round robin).
- 20.99 (2022): **cloning a layer channel takes the child channels into account** (undo /
  redo of the clone, the clones' display): the copy of a layer comes with copies of its
  children; the settings window is shown when a layer is added.
- 21.0.2 / 21.2: adding a layer records its children for undo; undoing the deletion of a
  layer's children puts them back (the same channels); the volume of new layers is 100 %;
  "Cut self" works for notes triggered on a parent layer (a child's cut groups apply to a
  layer's notes).
- 21.2.99 (Feb 2024): **hold Shift while dropping a file on a layer channel to add it as a
  new child channel**; the Channel rack's menu gets **Create layer with selected
  channels**; a layer is available in the menus that add instrument tracks.
- 25: *Show children* brings up the Channel rack if it is hidden; 25.1.99: a crash in "a
  project containing 2 layers with common children" (so a channel could be the child of two
  layers; Orchard keeps one layer per channel, as specified, and moves it on Set children).

## FL 2026's window (extracted forms)

The Layer's window shows the FuncSheet (MISC) with only three panels (manual screenshot):

| Panel | Left, Top, W x H | Contents (FL names, hints) |
|---|---|---|
| Levels adjustment (`OfsLevelsPanel`) | 7, 7, 176 x 100 | wheels 38 px at x 6 / 48 / 90 / 132, y 26: PAN "Panning offset" (+-6400 of 12800), VOL "Volume multiplier" (0..25600, default 12800 = 100 %), MOD X "Modulation X offset", MOD Y "Modulation Y offset" (+-256) |
| Layering (`LayerPanel`, caption "Layering", TextLeft 14) | 7, 115, 228 x 122 | `LayerMenuBtn` at -1,-1 15 x 21 ("Extra layer functions"); **Set children** 6,26 106 x 35 ("Layer with selected channels"); **Show children** 116,26 106 x 35 ("Show (select) all layered channels"); **Random** 3,75 ("Trigger one of the children at random"); **Sequential** 85,75 ("Trigger one of the children in sequential order"); **Crossfade** 3,95 ("Crossfade between children"); **FADE** wheel `Layer_FadeWheel` Tag 10, 192,74 30 x 30, 0..256, default 0, hint "Crossfade level", caption FADE at 193,107 |
| Keyboard (`KeybPanel`, caption "Root note: C5") | 7, 245, 544 x 137 | Reset 3,23 46 x 21 (hint "Default layer properties"), "Fine tune" slider 314,24 115 x 22 (-100..100 cents), multi-touch button, keyboard 544 x 89 at y 48 |

Hidden for a Layer (the same sheet shows them for other channels): Polyphony, Time,
Tracking, Group (Cut), Arpeggiator, Echo delay; also "Enable main pitch" / "Add to key" in
the Keyboard panel. The header is the usual row: ON, PAN, VOL, PITCH + RANGE; **no TRACK**
(FL hides it for generators without audio output).

FL's own strings (FLEngine's translation table): the confirmation **"No channel is
selected. This layer will then be linked to nothing."** (Set children with an empty
selection), the error **"Select one or more channels to create a layer."** (Create layer
with nothing selected), the hint **"Hold Shift and click to select layered channels"** (the
layer's channel button: Shift+click selects the children), the undo label "layer set
children".

The LayerMenu items (main form): *Split children* (hint "Assign one layer per key (starts at
root note)"), *Reset children*, *Group children...* ("Send children to a group"), *Delete
children...* ("Delete all children channels"). The Channel rack's menu has **Create layer
with selected channels**. The channel button's menu has no layer items.

## FL's data (templates, FLP)

- FLP: channel type (event 21) = 3; the children are **event 0x5E (WORD + 30), one per
  child**, holding the child channel's index, in stored order; the layer flags are event
  0x90 (DWORD + 16): bit 0 Random, bit 1 Crossfade (Sequential's bit is not documented;
  none of the shipped projects uses it). The FADE level has no event of its own that could
  be identified (no shipped layer uses crossfade); FL's wheel tag 10 is channel parameter
  10.
- Templates (`Layer.fst` = Plugin database entry; `LayerTrack.fst` = FL 3.5 era system
  template, same channel type): volume 100 % (Levels volume 12800 of 12800; in LayerTrack
  128 of 128, the old scale), pan centre, levels adjustment VOL 100 % (12800 of 25600),
  root note 60, fine tune 0, swing mix 128 (100 %), **"Enable main pitch" off** (the
  Sampler's template has it on), no children, flags 0. Colour: Layer.fst #404447
  (RGB 64 68 71; LayerTrack.fst #BCC0C4; a Sampler's is #5C656A). The new-layer defaults of
  the clone follow Layer.fst.
- The shipped projects' 28 layers: named "Layer", "Layer #2", "Layer #3"... (event 0xCB
  holds the name); 4 have no children, the others 2 to 10 (nine each with 2 and with 3);
  **no channel is the child of two layers**; the children lists are often not ascending by
  channel index (8 of 28: the list is the stored order, not the channel order); 26 layers
  have root key 60, two have 62 and 56; one layer is Random (three snare samples with root
  keys 60 / 61 / 61 under a layer root of 56).

## Orchard Studio

### Data

`Channel.kind` = `'layer'`, `Channel.layer: LayerSettings` (src/model/layer.ts):

| Field | Meaning |
|---|---|
| `children: Id[]` | child channel ids in the order Set children stored (rack order at that moment) |
| `random`, `sequential`, `crossfade: boolean` | the three check boxes (independent, as FL's) |
| `fade: number` | the FADE wheel 0..256 (integer), default 0; automation / link target `layer.fade` (min 0, max 256, step 1) |

The layer keeps the channel's usual fields: `enabled` (ON), `volume` (default **1** =
100 %), `pan`, `pitch` x `sampler.pitchRange`, `mixerTrack` (unused), and in `sampler` the
MISC fields FL shows: `adjPan`, `adjVol`, `adjModX`, `adjModY` (levels adjustment),
`rootKey`, `keyLo` / `keyHi` (key region), `fineTune`; `mainPitch` starts off. Its other
`sampler` fields are stored but have no effect (FL hides them).

Rules (`repairLayers`, `setChildren`, `removeFromLayers`): children exist, are not layers
and not the layer itself, and **belong to one layer** (Set children moves a channel out of
another layer; a project with a channel in two layers keeps it in the first one in rack
order). `normalizeChannel` repairs a layer's own settings, `normalizeProject` the
project-level rules; projects without layers load as before. Deleting a child takes it out
of its layer; deleting a layer leaves its children as they are; **cloning a layer clones
its children too** (`cloneChannel`: the copies follow the layer's copy in the rack, in the
stored order, with their notes; one undo step).

### Actions (one undo step each)

`addLayerChannel` / `addGenerator({ kind: 'layer' })` / `insertGenerator` (named "Layer",
"Layer #2"...), `replaceGenerator(id, { kind: 'layer' })` (the channel keeps notes and
settings and leaves its parent layer; a layer replaced by another generator lets its
children go and drops the links of its FADE), `setLayerChildren(layerId, ids =
selection)`, `showLayerChildren` (selection only, no undo step), `splitLayerChildren`,
`resetLayerChildren`, `groupLayerChildren(layerId, name)` (sets the children's
`filterGroup`), `deleteLayerChildren`, `createLayerWithSelected` (a new layer at the end
of the rack), `addLayerChild(layerId, name, sampleId)` (Shift + drop of a sample or file on a
layer row: a new Sampler channel right below the layer's last child, appended to the
children), `cloneChannel` (a layer's children are cloned with it), `setLayer(id, label,
recipe)` (flags, FADE; edits of the same control within 1.5 s merge). `showLayerChildren`
also shows the Channel rack if it is hidden. Layers are skipped by "Route selected
channels" / "Assign to free mixer tracks".

### Engine

`LayerChannel` (no voices, no render step: it never runs per block). The engine keeps
`layers` next to `midiOuts`; `Engine.dispatch` hands a pattern / song note of a layer to
`LayerChannel.scheduleNote`, `noteOn` / `noteOff` messages to `liveNoteOn` / `liveNoteOff`
(typing keyboard, preview keyboards, piano roll previews, MIDI input), and stop / pause /
seek / panic / removal release what the layer started (`allNotesOff`).

- **Forwarding**: the layer's key region filters its notes; then each chosen child gets the
  note through `Engine.playOn` = the same cut-group handling and `scheduleNote` as the
  channel's own notes, at the same frame, with the same key, velocity, release velocity,
  pan, fine pitch, Mod X / Y, colour, slide / porta flags and length, so the child's key
  range, root key, SHIFT, gate, arpeggiator, echo and polyphony apply. Live notes start
  the chosen children and remember them: the note off finds them even if the children
  changed meanwhile.
- **Which children**: all (default); **Random** one per note (`Engine({ random })` injects
  the generator; default `Math.random`), picked among the children that exist;
  **Sequential** the next present child in the stored order (the counter runs on across
  notes and restarts when the children change); Random wins when both are on. Slide notes
  go to every child (the one with a sounding voice slides) and take no turn.
- **Crossfade**: gain of child *i* of *n* at FADE *f*: `p = f / 256 x (n - 1)`, `d = |p -
  i|`, gain = `cos(d x pi / 2)` for `d < 1`, else 0 (`crossfadeGain`): equal power between
  neighbours, 1 at the child's own position (n = 3: 0 > 1+2 > 2 > 2+3 > 3 at 0, 64, 128,
  192, 256). It multiplies the child's voice volume; with crossfade on, all children are
  triggered (a child at gain 0 is silent but ready for the wheel to move).
- **Levels**: each child has a `LayerTap` (`pan`, `gain`, `cents`, `modX`, `modY`) the
  layer updates on every change of its controls (knob moves, automation, links, FADE); the
  voices started from the layer carry it, and the child adds it to its own levels every
  control step (`voiceBase` / `controlStep`): volume = channel VOL (FL's volume law) x
  levels VOL multiplier x crossfade gain, pan = channel PAN + levels PAN (added to the
  child's own and clamped like it), pitch = PITCH x RANGE + fine tune (cents), Mod X / Y
  = the levels adjustment's. Sounding voices follow knob moves; a child's own notes carry
  no tap (no stale values: the tap is set on every trigger). Arpeggiated and echoed voices
  keep the tap of the note they come from.
- **ON switches**: a muted layer plays no pattern / song notes (compiled out like any
  muted channel); live notes still play (FL: live input continues to play). A child plays
  the layer's notes whatever its own ON says (the switch gates a channel's own steps and
  piano roll; it also keeps "solo layer" audible, since solo mutes the others).
- **Activity**: `takePeak()` = the velocity of the notes since the last status, reported
  per channel like MIDI Out's, so the rack's selector flashes with the layer's notes.
- **Children can be** Sampler channels, instrument plugins and MIDI Out channels (FL lists
  MIDI Out among the generators); a MIDI Out child sends the note on its port and ignores
  the levels.

### UI

- Channel rack row: the usual LED, PAN, VOL, name button (Shift+click selects the
  layered channels) and steps / piano roll preview; no mixer track box, no "Route to mixer
  track" item; the button's menu (right-click) adds **Set children** (the channels
  selected before the right-click), **Show children** and a **Layering** submenu; the
  rack's own menu has **Create layer with selected channels**; Replace / Insert list Layer
  in Misc; dropping `layer` from the Browser on the rack adds one, on a channel replaces
  its generator; a sample dropped on a layer makes it a Sampler channel.
- Browser > Plugin database > Generators > Misc > Layer (double-click adds one); a layer
  added from the rack's menus, by a drop or from the Browser opens its settings window (FL
  shows it: Set children is the first thing to press).
- Channel settings window: header ON / PAN / VOL / PITCH + RANGE (no TRACK) and one MISC
  tab; the page is **Levels adjustment**, **Layering** (the panel at FL's coordinates
  above, the arrow opens the Layering menu) and **Root note: C5** (Reset, Fine tune, the
  preview keyboard with right-click root and ruler key region). The options menu: Rename,
  Replace, Set / Show children and the Layering items, Reset channel settings, Delete.

## Exact and interpreted

Exact (manual, forms, templates): what a layer is and is not; Set / Show children as
described; Random, Sequential (stored order), Crossfade (child sequence, top to bottom
order); the four Layering menu items and their effects; levels adjustment only on layered
notes; the window's panels, positions, captions and hints; the new-layer defaults (100 %
volume, main pitch off, root C5, no children); the naming "Layer", "Layer #2"; children
are not layers; the preview keyboard gestures; cloning a layer clones its children; Shift +
dropping a file on a layer adds a child; Show children brings up the rack; a child's cut
groups apply to a layer's notes.

Interpreted (document, then calibrate against FL when possible):

1. The **crossfade law** between neighbours (equal power; FL's manual gives only the child
   sequence). A linear law is one line in `crossfadeGain`.
2. **Random and Sequential both on**: Random wins; Crossfade composes with both (the
   chosen child plays at its crossfade gain). FL's check boxes are independent; its
   precedence is not documented.
3. **Sequential's counter**: it runs on across notes, transport restarts and live notes,
   and restarts when the children change. Whether FL resets it on play is unknown.
4. **Slide notes** go to every child and do not advance Sequential.
5. **Children ignore their own ON switch** for layer notes (derived from the ON switch's
   note for instrument channels and from how solo works).
6. **Live follow**: the layer's levels reach sounding voices (the SDK's FinalLevels =
   voice levels + parent channel levels); how FL folds them into the child's levels
   (multiply volume, add pan / pitch / Mod) is the natural reading, not measured.
7. The layer's **root key** only marks where Split children starts (it does not transpose
   the notes); its **fine tune** adds to the children's pitch; **main pitch** is off and
   ignored (the children follow it themselves); the key region filters the layer's own
   notes before they are distributed.
8. Set children excludes layers and the layer itself; the "at most one layer" rule is
   enforced on load and by Set children (moving), although FL has had projects with common
   children; the copies a clone makes follow the layer's copy in the rack and a Shift-dropped
   file's channel goes below the layer's last child (FL's positions are not documented).
   A sample dropped on a layer *without* Shift makes the channel a Sampler, as for any
   other generator (FL's behaviour for a plain drop is not documented).
9. **Delete children...** deletes all children (the form's hint) after a confirmation;
   **Group children...** sets the children's channel filter group (the rack's filter is
   not implemented yet).
10. The window shows a **single MISC tab** in the header (FL's tab selector lists the
    sheets the channel has); the new layer's colour is Layer.fst's; the keyboard shows
    the whole C0..B10 range (FL scrolls a zoomed range).
11. A muted **MIDI Out child** sends nothing (its own mute).

Not implemented: the FADE storage format of FLP (unknown), the Channel rack's group filter
and Sort by Type, the multi-touch keyboard, VST / AU children (no such plugins here).

## Tests

`tests/layer.test.ts`: model (defaults, normalisation, migration, children rules, Split /
Reset, crossfade law), actions (add / replace / insert, Set / Show / Split / Reset / Group /
Delete children, children moving between layers, clone, deleting, undo / redo, FADE as
automation clip and link target, save / load), engine (notes reach every child at the same
frame with identical data, a layer equals a direct note, chains of events across blocks,
Random with a seeded generator, Sequential, slide notes, Crossfade live, the layer's levels
on the test recorder and on a real Sampler voice, live notes and note offs, stop / pause /
seek / panic / removal, muted layer / child, key regions, Split children, the child's own
SHIFT / echo / cut groups / arpeggiator, a MIDI Out child, automation and link of FADE,
activity, no per-block state).

## Section for docs/gen-framework.md ("Layer channel")

```
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
```
