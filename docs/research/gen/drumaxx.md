# Drumaxx (FL: Drumaxx)

**Status: calibrated against FL 2026's renders (test host).** The engine is a
port of FL's own (engine.dylib DMSynth plus the wrapper); it renders FL's
output bit for bit in every tested case, including all 131 factory kits. Like
Drumpad it uses no samples: every pad is a Drumpad physical model.

Files: `src/model/gen/plugins/drumaxx.ts` (+ `drumaxx/keys.ts`, `state.ts`,
`kits.ts`, `inflate.ts`), `src/engine/gen/plugins/drumaxx.ts` (voices:
`drumpad/voice.ts`, shared with Drumpad), `src/ui/plugins/gen/drumaxx/index.tsx`
(+ `../drumpad/controls.tsx`), `tests/gen/drumaxx.test.ts`.

## Sources

- `Plugins/Fruity/Generators/Drumaxx/`: `Drumaxx_x64.dylib` (wrapper, editor form
  TSynthEditorForm 762 x 614, menus in TSynthResModule, value texts) and
  `engine.dylib` (DMSynth: render 0x417e0, sequencer 0x412a8, kit loader 0x2a17c
  with the version 3 fix-up at 0x2a820, per-block voice update, master EQ and
  limiter; the voice is Drumpad's code).
- The 131 factory kits (`Data/Patches/Plugin presets/Generators/Drumaxx`) and
  the plugin database state (`Plugin database/Generators/Drum/Drumaxx.fst`,
  "Default Kit"), kept exactly (raw-deflated in `kits.ts`).
- FL's thumbnail (look), the online manual (control names).
- Test host: `info` / `sweep` (all 719 indices), renders with `--preset`
  (names and .fst files), `--param`, `--mix-outs`, notes on pads and pattern
  trigger keys.

## Parameters and kits

719 indices: per pad (16 x 44) Volume, Panning, Mute, Solo, Key, the 38
Drumpad parameters and one reserved index; reserved 704; Master Level, Swing,
EQ Enable, EQ Band 1..8, Limiter Enable, Limiter Gain, Limiter Release (705 ..
718). Engine value = control / 256, except Key (0..126) and the velocity
targets (0..28), which pass as they are. Value texts as FL's sweeps: "%.1f%"
(bipolar: Panning, MID level / freq mod / level mod, HIGH level, Pitch, the EQ
bands), "On" / "Off", Retrig "0" / "I" / "II" / "III", keys "C5" with the
General MIDI drum name for 35..81 ("C3 - Bass Drum 1"), target names with
FL's leading space (" ---" for none). FL's wrapper shows whole numbers: a
kit's values truncated (158.72 shows "61.7%"), Retrig rounded.

Kit (FL's state "3SMD" / "4SMD", 21636 bytes): magic, name / comment (256),
720 floats, 16 patterns (length - 1, trigger key, 16 tracks x 64 step bytes:
bit 7 on, bits 0..6 velocity), 16 pad names (128 bytes), 16 cut groups, 16
mixer track offsets (7-bit varints). Version 3 kits (130 of the 131) store
Retrig as a count 0..3: FL's loader scales it by 1/3 (single precision,
clamped to 1), so a stored 1 plays as I and shows "0", 2 plays and shows II.
Junk values some kits hold for unused pads act as their clamped values.

## DSP [C: FL's code, verified sample by sample]

- Pads: one Drumpad voice per pad (`drumpad/voice.ts`, the same DSP at 38000 Hz,
  without Drumpad's wrapper first-use quirk). A note triggers every unmuted pad
  whose Key matches (Solo: only soloed pads); velocity v = velocity / 127
  (linear) for the velocity modulations. A pad retriggers its own voice. Mallet
  retrig and Retrig are read from pad 1 for every pad (FL's engine).
- Cut groups: a pad's trigger ends the hold of the other pads in its group
  (they decay).
- Pad gains: L = 2 vol^2 (1 - pan) x levels L, R = 2 vol^2 pan x levels R of
  the note's slot (FL's per-slot level arrays, as Drumpad's wrapper; the slot is
  the pad's key, or the playing pattern's note), pitch from the slot's levels.
- Master: pads without an output offset are summed, then EQ (8 RBJ bands: 80 Hz
  low shelf, 160 ... 5120 Hz peaking, 10240 Hz high shelf, Q 2, gain 16 v - 8 dB,
  run from band 8 to band 1, denormals flushed below 1e-9), limiter (input gain
  10^(1.5 g), gain recovery t^4 with t rising (3 release^2 + 2) / rate per
  sample), Master Level 10^(1.6 m) / 8, ramped by 0.005 per sample. FL's ramp
  starts at 0 and stalls (single precision) slightly below its target: a
  playing instance's state is reproduced.
- Routing: a pad with an output track offset goes to mixer track (current
  track + offset) without the master section.
- Sequencer: the trigger key starts its pattern at step 0, its note off stops
  it. Steps 0 .. length - 1 of 16th notes: ((odd step ? -15 s : 15 s) + 15)
  x rate / tempo samples, s = Swing / 2 (0 ... 0.5); a step byte with bit 7
  triggers its pad at velocity (bits 0..6) / 127. Indices past a track read on
  into the pattern record (FL quirk, emulated).

## Editor

FL's form at its coordinates: header (kit folder / kit selector with arrows,
OPTIONS menu, Master Level), the pads panel (8 pads per bank: name, key
selector, Volume and Panning wheels, play button with the selected pad
outlined, Mute, Solo, layer up / down), DRUMSET SELECT (1-8 / 9-16), COPY /
PASTE (drum pad, pattern, pattern track), the selected pad's Drumpad controls
(Drumpad's form 16 px left and 255 px down, shared code), the sequencer (Play,
Pattern, Trigger key, Pattern Length, 4 bars, 16 steps with velocity sliders,
the playing step, Swing), the master strip (8 EQ bands, EQ / Limiter enable,
Gain, Release). Menus as FL's: pad (right-click: Rename, Load Drum patch, Copy,
Paste, Cut Group, Output track offset), OPTIONS (Load DrumKit, Copy / Paste bar
and pattern, Load pattern, Reset pattern). Original drawing in FL's colours;
FL's panel artwork is not reproduced.

## Fidelity (FL vs ours, 44.1 kHz, 130 BPM)

| Case | Residual |
|---|---|
| all 131 factory kits, 7 notes on pads and trigger keys (patterns, cut groups, EQ, limiter, swing), routed outputs summed | bit-exact |
| plugin database Default Kit: layered keys, velocities 80 / 100 / 127, note offs | bit-exact |
| single pads with volume / pan / Master, all EQ band types, limiter settings | bit-exact |
| version 3 kits with pad 1 Retrig (Cinematikit 2 FG, Guns & Munitions FG) | bit-exact |

- Approximate / not measured: the editor's Play button with no note playing
  (the test host has no GUI; the pattern plays with unity levels here), a
  project with several Drumaxx instances (FL's voice seeds continue from
  instance to instance), offsets beyond the mixer (clamped to 0 ... 500), Load
  Drum patch takes Drumpad's presets (the same 961 patches as FL's Drum Patches
  folder), layer up / down swaps neighbouring pads (with names, cut groups,
  offsets and pattern tracks). Not implemented: MIDI Learn, Save DrumKit /
  Drum patch / pattern (the state is saved with the project).
