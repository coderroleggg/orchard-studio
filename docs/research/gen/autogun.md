# Autogun (FL: Autogun)

FL's Autogun is "a universe of sounds waiting to be discovered" (Plugin database > Generators > Synth special): Didier Dambrin's Ogun
engine playing one of 4 294 967 296 patches, each generated from its preset number, through a hosted Soundgoodizer ("magic dust"). It is
built from the same Free Pascal code base as Ogun (docs/research/gen/ogun.md): the same `TTestPlug` class compiled with a few additions,
so the engine, the random preset generator and the form's controls are Ogun's; what Autogun adds is described here. Category Synth
special, `notes: 'voices'`, `levels: 'plugin'`, DefPoly 0, FL's editor 282 x 379.

Sources: FL 2026's `Autogun_x64.dylib` (arm64 slice, no symbols; FL's own Ogun and Autogun render the same patch identically, apart from the
master level and the Soundgoodizer), its `Data/` folder (the same random pad data as Ogun's, and `SG.dat`, the Soundgoodizer's state), the
manual (`.flref/special/man/Autogun.txt`), the plugin database thumbnail and the artwork bitmaps (looked at for the layout and the colours
only), and renders / states of the real plugin through the test host (`flfxhost render Autogun --state ...`, the tools' `host3`).

## What differs from Ogun (Autogun_x64 against Ogun_x64, function by function)

- **One parameter.** `NumParams` is 1: "Master level" (0 .. 256, default 256, shown 0 - 200 %; the texts are Ogun's, sweep identical).
  Ogun's other 88 parameter handlers exist in the binary but FL does not expose them. The master level function (0x6af10) is Ogun's
  `(3^x - 1) / 2` (x = level / 128) **times 0.25**: at the default 256 the gain is 1 (Ogun's 4), at 128 it is 0.25.
- **State** (`SaveRestoreState` 0x65800, version 0x130003 as Ogun's): Ogun's state plus the **preset counter** (plug+0x620, 4 bytes, between
  the info text and the articulators, version >= 19). Int 63 is the **magic dust** (plug+0x238, 0 .. 1000, default 430), int 54 the
  processing quality. A generated patch is a pure function of the counter, so the clone stores only `{ level, dust, n, quality }`
  (`src/model/gen/plugins/autogun/state.ts`) and plays `ogunStateOf(state)`, the patch of the counter with the plugin's own level,
  quality and dust. FL stores the whole patch and loads it as it is; a state saved by FL that was not made by the generator would play
  differently here.
- **New instance** (constructor 0x677a0): `counter = round(Random * 2^32)` (FPC's Random seeded with the clock), master level 256, magic dust
  430, then the generator (0x70170) with the counter unchanged; quality 1 (the generator's template). `defaultGenParams` does the same with
  `Math.random`; a new instance has a random preset (so do "Reset Autogun" and a new channel).
- **Random preset generator** (0x70170, "Generate random preset" of the buttons and "Enter preset number...": the counter changes by
  -1 / 0 / +1, then the Mersenne twister is seeded with it): Ogun's function (random.ts) with four differences, all reproduced:
  the master level (state int 0) and the magic dust (int 63) are kept instead of being set to 128 / 430; **no "Computer says no" draw**
  (one draw fewer, so the title words differ from Ogun's for the same number); the condition that appends the last clause (a thing
  "tweaked by yo motha") to a second line no longer needs a one-line text; and the info text is
  `U+E427 title U+E4FF CR U+E5A0 author U+E5FF CR description` with the author drawn from the first word list (Ogun draws it and drops it).
  The quality is reset to the template's 1 by every generation. In the code: `generateOgun(seed, autogun = true)`.
  The number a user sees is the counter + 1 (1 .. 4294967296, "Enter preset number...", "Current preset number" dialog); the previous /
  next buttons move the counter by -1 / +1 modulo 2^32.
- **Soundgoodizer.** The constructor loads FL's `Shared/SGv2_x64.dylib` (the Maximus engine, as Harmor's compression unit does) into a
  plugin wrapper and its state from `Data/SG.dat` (a version 7 Maximus state: 59 parameters, two banks of four band curves). Gen_Render
  (0x6d9a0) is Ogun's with one addition at its end: **while the magic dust is above 0, SGv2's `Eff_Render` runs on each chunk of the
  plugin's output in place** (after the effects and the halfband, before the sum is added to the channel); the dust is forwarded to SGv2
  parameter 5, the mix of the three bands (`SGSliderChange`: `ProcessParam(5, dust)`; the state load applies it too). SGv2 reports its
  latency (153 samples at 44.1 kHz) only to the wrapper, so the plugin reports none.
  The engine is Harmor's port of SGv2 (`harmor/fx-comp-sg.ts`, bit-exact). `SG.dat` differs from Harmor's four compression states in
  **parameter 6 = 32768, the low cut** (a negative value = off; else 4 high-pass biquads at `5 * 2^(raw / 16384)` Hz = 20 Hz here, the
  factors 0.1977 / 0.6193 / 0.6768 / 1.0794 of SGv2 0x3632d8 times sin(w), w = 0.8 * f * 2 pi / sr, before the bands: SGv2 0x68220 /
  0x24d770 / 0x24d8a0), which Harmor's states never use; it was added to the port (`setLowCut`, additive, off for a negative value).
  The state's data is `src/engine/gen/plugins/autogun/sgdata.ts` (bank A's parameters and the four band curves; the curves' shape values
  of the master curve's last point come from a fit against SGv2, see Fidelity).
- **Editor.** The same `TSynthEditorForm` as Ogun's (the Ogun form is compiled in, with the Autogun panel `SynthPanel2` hidden there):
  `SynthPanel2` is 282 x 379 with `MainVolSlider2` (the master level, 97,132 88 x 88), `SGSlider` (the magic dust, a `TCircleWheel` 0 .. 1000
  default 430, 105,232 72 x 29), `PrevPresetBtn` (0,10) / `NextPresetBtn` (231,10) 51 x 156 (`RandPadBtnClick` 0x614f0 calls the generator with delta = Tag + 2, the tags are
-3 / -1; the mouse wheel over the panel, `SynthPanel2MouseWheel` 0x623d0, steps the preset too: delta = -sign(WheelDelta)), `InfoBtn`
  (the "Info / settings" popup, 4,215 67 x 67); the screen (51,28 180 x 117) shows the info text and the bottom strip a keyboard (Kb.bmp
  238 x 72: two octaves of 17 px keys). The popup shows the items tagged -100: "Enter preset number...", "Processing quality" (Draft, Average,
  High, Pristine, Huge waste of CPU), "About" and "Autogun homepage". The magic dust hint is its percentage ("43%", `OnHint` at load).

## Clone (`src/model/gen/plugins/autogun*`, `src/engine/gen/plugins/autogun*`, `src/ui/plugins/gen/autogun/`)

- `autogun.ts` (model): the definition (one parameter), `state()` = a new instance. `autogun/state.ts`: `{ level, dust, n, quality }`,
  `normalizeAutogun`, `autogunPatch(n)` (the generated Ogun patch, four kept in a small cache; FL's unclamped values are kept, e.g. the
  reverb low cut 0 of the "Large hall" preset), `ogunStateOf`, `infoOf` / `presetInfo` (title, author, description lines), the number
  helpers (`presetNumber`, `counterOfNumber`, `randomCounter`).
- `engine/gen/plugins/autogun.ts`: `AutogunInstance` wraps `OgunInstance` (`og`) and installs `og.postFx`, the Soundgoodizer run on every
  chunk the effects chain produced; `og.plug.masterScale = 0.25`. `setParams` generates the patch when the counter changes (tens of
  milliseconds in the audio thread, once per preset change; FL does it in the UI thread) and keeps it otherwise; `tail` covers the
  Soundgoodizer's silence gate (1.5 s) while the dust is up.
- Shared files changed (all additive, Ogun / Harmor unchanged when the new options are off): `ogun/random.ts` (`generateOgun(seed, autogun)`),
  `ogun/flstate.ts` (`parseOgunState(blob, asSaved, autogun)` reads the counter), `ogun/plug.ts` (`masterScale`), `engine/gen/plugins/ogun.ts`
  (`postFx` hook), `harmor/fx-comp-sg.ts` (low cut: `setLowCut`, `SgBiquad.setAlpha`); and one fix that Ogun profits from too:
  `ogun/ogcurve.ts` (`FIX_TOLERANCE`: a map is not scaled to its length a second time, see Fidelity).
- Editor (`ui/plugins/gen/autogun/index.tsx`): FL's layout, an original drawing: the lid, screen, brushed plate with the engraved name, the
  knob with a clockwise LED ring (the master level), the dust arc (orange dots lit from the left), the previous / next buttons (lit when
  hovered or pressed), the "?" button opening the options popup (also the plugin window's menu), the info screen (title, author in a
  second colour, description), the mouse wheel over the panel (wheel up = previous preset), the testing keyboard (C5 .. B6, a click plays the channel with the pressed height as velocity) and an About
  panel with the credits of the manual. Changing the preset is not undoable (FL: "No undo"), the level and the dust are.

## Fidelity (FL 2026 vs ours, test host renders)

- **Preset number to patch: exact.** The state `generateOgun(n, true)` makes equals FL's in every field (64 ints, delay and EQ bytes, info
  text with the style codes, 13 articulators with all curves, 4 maps with their up to 31 000 points, the counter) for **all numbers 1 .. 1000**
  and for 24 numbers spread over the 32 bit range (1001 .. 2^32 - 1, including 2^31 and 0xFFFFFFFF); tests/gen/autogun-random.golden.ts
  pins 38 numbers (digests).
- **Value text: exact** (digest of all 257 texts of the master level, the sweep is Ogun's).
- **Soundgoodizer: bit-exact** against SGv2 itself (the tools' `sghost` with `SG.dat`): mixes 0 .. 1000, blocks 16 .. 1024, 22.05 / 44.1 /
  48 kHz, input levels up to 3.5 and silent gaps (the silence gate); tests/gen/autogun.test.ts pins 7 runs. The four curved points'
  shape values of the three band curves are SGv2's own (Harmor's presets use them); the fourth (the master curve's last point, tension
  0.38) is not computed from a formula but taken from a fit: the (c1, c2) pair that reproduces SGv2's output bit for bit at levels up to 3.5
  (a one ulp step in either value breaks it).
- **Sound: bit-exact** for 19 pinned scenarios (tests/gen/autogun.golden.ts: FL's output hashed, every sample of both channels): presets 2 - 77
  of every template type including the two resynthesis ones (clock-seeded timbre seeds with a fixed clock) and four large pad-map presets
  (65, 71, 91, 158), dust 0 / 1 / 250 / 300 / 430 / 700 / 800 / 1000, master level 0 .. 256 and automated during the note, every quality
  (Draft .. Huge), 22.05 / 44.1 / 48 / 96 kHz, blocks of 1 / 16 / 64 / 1024, tempo 60 and 130, export mode, overlapping notes and chords,
  velocities 1 .. 127, max polyphony 2. Many more runs (not pinned): the counters 1 .. 240 (three overlapping notes each) and 24 numbers
  spread over the 32 bit range: **264 of 264 presets identical to FL in every sample.**
- **The 8 % that once deviated, and why** (fixed in the shared Ogun engine). Before the fix about 8 % of the random presets (all with the
  timbre richness 15 or 16, i.e. spectra of 2^15 / 2^16 samples) differed from FL by 1 - 5 ulp of the float32 output in sporadic samples,
  for Autogun and for FL's own Ogun alike. Diagnosis (preset 91, FL's plugin run under lldb with breakpoints on its IPP calls): the inverse
  FFT, `ippsExp_32f`, `ippsRandUniform_Direct_32f`, the phase table and the amplitude chain were bit-exact against FL's IPP; the first
  difference was the **impulse EQ table** (the pad harmonics map sampled at the harmonic positions, `plug.ts updateMap`, FL 0x71910): 6 of
  its 32 767 entries differed by one float ulp (harmonics 1519, 2939, 6270, 10203, 11175, 11352), and two of them flipped a spectrum value,
  which an inverse FFT of 2^16 spreads into 1 ulp differences of the output. The map has one point per 1/32767, the table is read at
  those positions plus 2^-24, so every entry is a point's level plus 0.2 % of the step to the next: the table is as sensitive as the
  position noise of the sequential reader. The reader's position drift (`pos += step * inc`, about -6e-14 per sample) depended on the
  length of the point distances, and the port had scaled them **twice** to the map's length (`flstate.ts fixLength` when it reads the
  state, as FL does, and again in `OgCurve.load` -> `fixLength`): the residual of a sum of 27 000 distances is 2e-14, so the second scaling
  moved every distance by 2e-14 relative, about 1e-10 of a position step after 11 000 entries - enough to put six table entries on the
  other side of a float rounding. Skipping the second scaling when the curve already sums to its length within 1e-9
  (`ogcurve.ts FIX_TOLERANCE`; a curve that is really off scale is still normalised) makes the table identical to FL's in all 32 767
  entries and every render above bit-exact; Ogun's own tests stay green. The scratch scripts are `.flref/autogun/mm1.ts` - `mm3.ts`
  (per-entry reader state, feasible position shifts, the tolerance test) and the lldb scripts `cap*.py`.
- **State reader**: `parseOgunState(blob, false, true)` reads the counter; FL's saved Autogun states parse and match the generated
  patches field by field (the 1000 + 24 numbers above); a state this writer makes (tests) is read back.

## Approximations and what remains

- Presets generated in the audio thread: a preset change takes up to about 65 ms there (the patch of a large map is 2 MB of curves); FL
  generates in its UI thread. Only the number is stored in the project, the patch is not.
- The state does not keep a patch FL generated differently (an older plugin version) or edited: FL loads the stored patch, the clone
  regenerates it from the counter. Importing FL states reads the counter only.
- The editor is an original drawing, not FL's bitmaps: the lid, plate, wood and cables, the knob, the dust arc's orientation (lit from the
  left: FL's mask is a smile arc, its fill direction was not seen), the preset buttons' and the info button's lit states are approximations;
  the info screen's style codes (U+E427 / U+E4FF title, U+E5A0 / U+E5FF author) are shown as a larger title and an author line in another
  colour, the fonts are not FL's; the keyboard covers C5 .. B6 (FL's range was not extracted). "About" shows the manual's credits, not FL's
  picture.
- Not ported: Ogun's own editor panel and menus (FL hides them in Autogun), "Analyze timbre..." (as in Ogun), MIDI learn, the copy / paste
  of the state text of the options menu (FL's popup shows none of Ogun's items; the manual lists none).
- `docs/research/gen/ogun.md` still says Autogun is not implemented.

## Tools (scratch, git-ignored: `.flref/autogun/`)

`agfl.sh` / `batch2.ts` (FL's plugin through the test host against ours for presets, dust, level, quality, rates, blocks, notes),
`mkgolden.ts` / `mkrandom.ts` / `mksg.ts` (the three golden files), `mkbig.sh` + `cmpbig.ts` (FL's generator for large numbers, the test host's
script mode: the counter written to plug+0x620, then 0x70170), `sgcmp*.ts` (the Soundgoodizer against SGv2), `cmpgen.ts` (all 1000 states),
`mkstate.py` / `ag2og.py` (state edits). FL's states of presets 1 .. 1000 made by the plugin itself were in `/tmp/ogw/or/ag_N.state`.
