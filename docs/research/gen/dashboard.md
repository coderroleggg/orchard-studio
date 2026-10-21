# Dashboard (FL: Dashboard)

**Silent shell, no audio.** FL Studio 2026 has no working 64-bit Dashboard. Its 64-bit file is a dummy
with the same strings and size as FL Slayer's. It accepts notes, renders silence and shows the "Dummy x64"
window. Orchard Studio replicates that with a hidden controller that has FL's parameter list and outputs
silence. FL's bundle describes it as "User-definable dashboard (internal controller plugin)".

## What FL 2026 contains

- Binary `Plugins/Fruity/Generators/Dashboard/Dashboard_x64.dylib` (LongName `Fruity Dashboard`, ShortName
  `Dashboard`), not in FL's plugin database. 4,607,328 bytes, as FL Slayer's dylib, and the same string table
  (`*This plugin doesn't have a 64 bit version.`, `Dummy x64`). The bytes differ in 5,328 places (not analysed
  further), and the host reports different flags, parameters and controls, so this is not FL Slayer's build.
  `Plugin.nfo` has only the vendor line.
- `flfxhost info "Dashboard"`: class TTestPlug; flags `0x00604071` (Generator, GetNoteInput, WantNewTick,
  NoProcess, MIDIOut, NewVoiceParams, Reserved1); 257 parameters; NumOutCtrls 1024; DefPoly 0. FL Slayer has
  flags `0x00604011` (no WantNewTick, no NoProcess), 29 parameters and no output controls.
- Parameters: all 257 have an empty name and value text, range 0..1073741824 (the host's identity translation;
  none is defined) and default 0. A value set with `--param` reads back as 0 (checked on 0, 100 and 256).
- Style: `no audio (FPF_NoProcess)`, so FL treats it as a controller. Notes go through TriggerVoice.
- Editor (`.flref/gen/forms/Dashboard.txt`): identical to FL Slayer's form (SynthPanel 356 x 201, colour
  #31373b, "Dummy x64" and the three messages). No controls.
- Plugin calls (`--show-out`): each note gets `TriggerVoice` handle `0xffffffffffffffff` (no voice). The
  summary reads 0 `Gen_Render`, 0 `Voice_Render`, 572 `NewTick`, 0 MIDIOut sent and 0 `OnControllerChanged`.
- Presets: `Data/Patches/Plugin presets/Generators/Dashboard/` holds seven `.fst` files (Empty, MIDI Out,
  Peavey, PhatBoy, Sliders, Wheels, XP30), which `.flref/gen/index.md` calls reference panel bitmaps. They are
  FL content and are not copied.
- State: a new instance saves 0 bytes (`--save-state`). After `--preset XP30` (1,578 bytes read from the file)
  the host saves 1,578 bytes again, so FL's dummy keeps the state it is given (see Not reproduced).

## Host renders (silent)

Outputs in `.flref/dashboard/`:

| Command | L / R peak |
|---|---|
| `flfxhost render "Dashboard" --notes "60:100:0:0.5" -o out.wav` | -inf dBFS |
| `flfxhost render "Dashboard" --show-out --notes "60:100:0:0.5" -o show_out.wav` (trace in `show_out.log`) | -inf dBFS, 0 MIDIOut |
| `flfxhost render "Dashboard" --preset XP30 --notes "60:100:0:0.5" -o preset_test.wav` | -inf dBFS |

`out.wav` (32-bit float, stereo, 44.1 kHz, 2.5 s): all 882,000 data bytes are zero.

## Orchard Studio

- Definition `src/model/gen/plugins/dashboard.ts`: hidden, category Controller, `notes: 'voices'`, `noAudio`
  (no TRACK selector, as for the other no-audio controllers), DefPoly 0, panel 356 x 201, 257 parameters
  (`dummy64/params.ts`), no presets, no extra state.
- DSP `src/engine/gen/plugins/dashboard.ts` with the shared shell `dummy64/shell.ts`: `triggerVoice` returns
  null; no MIDI output; no controls.
- Editor `src/ui/plugins/gen/dashboard.tsx` (`dummy64/Panel.tsx`).
- Tests `tests/gen/dashboard.test.ts` (shared suite `tests/gen/dummy64.ts`).

## Fidelity

- Silence: exact (every sample of the note render is zero, as in FL).
- Parameters: count 257, ranges, defaults, empty names and texts match `flfxhost info`.
- MIDI out: none, as in FL's trace.

## Not reproduced

- State: FL's dummy keeps a loaded state blob (the XP30 round trip above). The clone keeps none, as for FL
  Slayer: a new instance saves 0 bytes in FL too, and FL's preset blobs are not copied.
- Output controls: FL reports 1024 (`NumOutCtrls`) with no names or values, and sends no `OnControllerChanged`
  in the trace. Not modelled (no `controls()`).

## Not verified

- Automation and link menus for the 257 unnamed parameters (FL's list not observed).
- The category is a guess from FL's folder name (the plugin is not in FL's database), as for FL Slayer.
- The hidden TRACK selector (`noAudio`) is inferred from FPF_NoProcess, not seen in FL's channel window.
