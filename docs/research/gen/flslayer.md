# FL Slayer (FL: FL Slayer)

**Silent shell.** FL Studio 2026 has no working 64-bit FL Slayer: its 64-bit file is a dummy with
the same code as Wasp and Wasp XT. It accepts notes, renders silence and shows the "Dummy x64"
window. Orchard Studio replicates that with a hidden instrument that has FL's parameter list and
outputs silence. FL's bundle describes it as a guitar and bass synth.

## What FL 2026 contains

- Binary `Plugins/Fruity/Generators/FL Slayer/FL Slayer_x64.dylib` (LongName `FL Slayer`), not in
  FL's plugin database. Its `Plugin.nfo` has only the vendor line (no `ps_dummy64bit`), but the
  dylib holds the same "doesn't have a 64 bit version." text as Wasp and renders silence, so it is
  treated as a dummy.
- `flfxhost info "FL Slayer"`: flags `0x00604011` (Generator, GetNoteInput, MIDIOut,
  NewVoiceParams, Reserved1), 29 parameters, DefPoly 0, no factory preset folder. Every parameter
  has an empty name and value text, range 0..1073741824 (the host's identity translation of the normalized range: none is defined) and default 0. A value set with `--param`
  reads back as 0.
- Editor (`.flref/gen/forms/FL Slayer.txt`): identical to Wasp's form (SynthPanel 356 x 201, colour
  #31373b, "Dummy x64" and the three messages). No controls.
- Plugin calls (`--show-out`): each note gets `TriggerVoice` handle `0xffffffffffffffff` (no
  voice). The summary reads 335 `Gen_Render` calls, 0 `Voice_Render`, 0 `NewTick`, and "plugin sent
  0 MIDIOut". The channel's MIDIOut events (`FPE_MIDI_Vol` 127, `FPE_MIDI_Pan` 64, `FPE_MIDI_Pitch`
  0) reach the plugin, which sends nothing back.
- State: no bytes from `--save-state`. Presets: none.

## Host renders (silent)

| Command (outputs in `.flref/legacy/`) | L / R peak |
|---|---|
| `flfxhost render "FL Slayer" --notes "60:100:0:0.5,64:127:0.6:1.0,48:40:1.8:0.5" -o FLSlayer_notes.wav` | -inf dBFS |
| `flfxhost render "FL Slayer" --fl-channel --notes "36:127:0:2,60:100:0.5:1,84:20:1:0.25" -o FLSlayer_flchan.wav` | -inf dBFS |
| `flfxhost render "FL Slayer" --note-mode both --notes "60:100:0:0.5" -o FLSlayer_both.wav` | -inf dBFS |
| `flfxhost render "FL Slayer" --show-out ...` (trace in `FLSlayer_show_out.log`) | -inf dBFS, 0 MIDIOut |

## Orchard Studio

- Definition `src/model/gen/plugins/flslayer.ts`: hidden, Synth special (guitar and bass, next to
  Plucked!), `notes: 'voices'`, DefPoly 0, panel 356 x 201, 29 parameters (`dummy64/params.ts`), no
  presets, no extra state.
- DSP `src/engine/gen/plugins/flslayer.ts` with the shared shell `dummy64/shell.ts`: `triggerVoice`
  returns null; no MIDI output.
- Editor `src/ui/plugins/gen/flslayer.tsx` (`dummy64/Panel.tsx`).
- Tests `tests/gen/flslayer.test.ts` (shared suite `tests/gen/dummy64.ts`).

## Fidelity

- Silence: exact (all zeros in every render tested, as in FL).
- Parameters: count, ranges, defaults, empty names and texts match `flfxhost info`.
- MIDI out: none, as in FL's trace (0 messages).

## Not verified

- Automation and link menus for the 29 unnamed parameters (FL's list not observed).
- Channel INS tab: none is offered (no INS parameters in the dummy).
- Editor fonts and colours: as for Wasp.
- The category (Synth special) is a guess: FL does not list the plugin in its database.
