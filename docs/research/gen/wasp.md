# Wasp (FL: Wasp)

**Silent shell.** FL Studio 2026 has no working 64-bit Wasp: its 64-bit file is a dummy. It
accepts notes and renders silence, and its editor says the plugin has no 64-bit version. Orchard
Studio replicates that: a hidden instrument with FL's parameter list that outputs silence.

## What FL 2026 contains

- Binary `Plugins/Fruity/Generators/Wasp/Wasp_x64.dylib` (LongName `WASP`), not in FL's plugin
  database. `Plugin.nfo`: `ps_dummy64bit=1`. The dylib holds the editor text "This plugin doesn't
  have a 64 bit version."
- `flfxhost info "Wasp"`: flags `0x00408011` (Generator, GetNoteInput, DemoVersion, Reserved1),
  41 parameters, DefPoly 4, no factory preset folder. Every parameter has an empty name and value
  text, range 0..1073741824 (the host's identity translation of the normalized range: none is defined) and default 0. A value set with `--param` reads back as 0.
- Editor (`.flref/gen/forms/Wasp.txt`): SynthPanel 356 x 201 at 0, 0, colour 3880753 (#31373b).
  Title "Dummy x64" (P_LargeBold, 336 x 18 at 5, 45), then three centred lines at y 70, 90 and 110:
  "This plugin doesn't have a 64 bit version.", "Your settings have been saved.", "Open this
  project in FL Studio 32 bit to use this plugin." No controls. The clone keeps FL's layout but
  replaces the third line with its own: "It makes no sound, as in the 64-bit original." (FL's
  32-bit version doesn't exist here).
- Plugin calls (`flfxhost render --show-out`): each note gets `TriggerVoice` handle
  `0xffffffffffffffff` (no voice). The summary reads 335 `Gen_Render` calls, 0 `Voice_Render`,
  0 `NewTick`, 0 MIDIOut and 0 OnControllerChanged. `Gen_Render` renders nothing.
- State: `--save-state` writes 0 bytes, so a new instance has no state beyond its parameters.
- Presets: none. `--preset Default` stops at the host's "no factory preset folder" check.

## Host renders (silent)

| Command (outputs in `.flref/legacy/`) | L / R peak |
|---|---|
| `flfxhost render "Wasp" --notes "60:100:0:0.5,64:127:0.6:1.0,48:40:1.8:0.5" -o Wasp_notes.wav` | -inf dBFS |
| `flfxhost render "Wasp" --fl-channel --notes "36:127:0:2,60:100:0.5:1,84:20:1:0.25" -o Wasp_flchan.wav` | -inf dBFS |
| `flfxhost render "Wasp" --note-mode both --notes "60:100:0:0.5" -o Wasp_both.wav` | -inf dBFS |

## Orchard Studio

- Definition `src/model/gen/plugins/wasp.ts`: hidden, Synth classic, `notes: 'voices'`, DefPoly 4,
  panel 356 x 201, 41 parameters (`src/model/gen/plugins/dummy64/params.ts`), no presets, no
  extra state.
- DSP `src/engine/gen/plugins/wasp.ts` with the shared shell `dummy64/shell.ts`: `triggerVoice`
  returns null, so nothing renders.
- Editor `src/ui/plugins/gen/wasp.tsx` (`dummy64/Panel.tsx`): FL's dummy window.
- Tests `tests/gen/wasp.test.ts` (shared suite `tests/gen/dummy64.ts`): registration, no voices,
  silence through a channel with parameters set, and the editor's text.

## Fidelity

- Silence: exact. Every render tested is all zeros, as in FL (residual 0).
- Parameters: count, ranges, defaults, empty names and texts match `flfxhost info`.

## Not verified

- Automation and link menus: FL's list for the 41 unnamed parameters was not observed. They are
  listed as the host reports them.
- Channel INS tab: the dummy shows no INS parameters, so none is offered.
- Editor fonts and colours: FL's P_LargeBold and P_Normal fonts are not reproduced, and the text
  colour is a neutral grey (no screenshot of the dummy window is available to sample).
