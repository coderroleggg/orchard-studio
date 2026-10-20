# Wasp XT (FL: Wasp XT)

**Silent shell.** FL Studio 2026 has no working 64-bit Wasp XT: its 64-bit file is a dummy, the
same as Wasp. It accepts notes, renders silence and shows the same "Dummy x64" window. Orchard
Studio replicates that with a hidden instrument that has FL's parameter list and outputs silence.
FL's bundle describes it as Wasp's three-oscillator subtractive synthesizer.

## What FL 2026 contains

- Binary `Plugins/Fruity/Generators/Wasp XT/Wasp XT_x64.dylib` (LongName `WASP XT`), not in FL's
  plugin database. `Plugin.nfo`: `ps_dummy64bit=1`. The dylib holds the same editor text as Wasp.
- `flfxhost info "Wasp XT"`: flags `0x00408011` (Generator, GetNoteInput, DemoVersion, Reserved1),
  56 parameters, DefPoly 4, no factory preset folder. Every parameter has an empty name and value
  text, range 0..1073741824 (the host's identity translation of the normalized range: none is defined) and default 0. A value set with `--param` reads back as 0.
- Editor (`.flref/gen/forms/Wasp XT.txt`): identical to Wasp's form (SynthPanel 356 x 201, colour
  #31373b, "Dummy x64" and the three messages). No controls.
- Plugin calls (`--show-out`): each note gets `TriggerVoice` handle `0xffffffffffffffff` (no
  voice). The summary reads 335 `Gen_Render` calls, 0 `Voice_Render`, 0 MIDIOut.
- State: no bytes from `--save-state`. Presets: none (`--preset Default` hits the host's check).

## Host renders (silent)

| Command (outputs in `.flref/legacy/`) | L / R peak |
|---|---|
| `flfxhost render "Wasp XT" --notes "60:100:0:0.5,64:127:0.6:1.0,48:40:1.8:0.5" -o WaspXT_notes.wav` | -inf dBFS |
| `flfxhost render "Wasp XT" --fl-channel --notes "36:127:0:2,60:100:0.5:1,84:20:1:0.25" -o WaspXT_flchan.wav` | -inf dBFS |
| `flfxhost render "Wasp XT" --note-mode both --notes "60:100:0:0.5" -o WaspXT_both.wav` | -inf dBFS |

## Orchard Studio

- Definition `src/model/gen/plugins/waspxt.ts`: hidden, Synth classic, `notes: 'voices'`, DefPoly 4,
  panel 356 x 201, 56 parameters (`dummy64/params.ts`), no presets, no extra state.
- DSP `src/engine/gen/plugins/waspxt.ts` with the shared shell `dummy64/shell.ts`: `triggerVoice`
  returns null.
- Editor `src/ui/plugins/gen/waspxt.tsx` (`dummy64/Panel.tsx`).
- Tests `tests/gen/waspxt.test.ts` (shared suite `tests/gen/dummy64.ts`).

## Fidelity

- Silence: exact (all zeros in every render tested, as in FL).
- Parameters: count, ranges, defaults, empty names and texts match `flfxhost info`.

## Not verified

- Automation and link menus for the 56 unnamed parameters (FL's list not observed).
- Channel INS tab: none is offered (no INS parameters in the dummy).
- Editor fonts and colours: as for Wasp (fonts not reproduced, neutral grey text).
