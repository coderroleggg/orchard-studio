# VFX Key Mapper (FL: VFX Key Mapper)

Files: `src/model/fx/plugins/vfxkeymapper.ts` (def + factory presets),
`src/engine/effects/plugins/vfxkeymapper.ts`, `src/ui/plugins/fx/vfxkeymapper.tsx`,
`tests/fx/vfxkeymapper.test.ts`.

Sources: FL 2026 form (SynthPanel 775 x 373, MapVisual 8,16 759x239), manual
page, screenshot `VFX_keymapper.png` (1.5x, Scales\Blues), `flfxhost info` /
`sweep` (5 parameters, no value texts), and FL's 34 factory presets decoded
from their `.fst` files.

## Parameters

| # | key | FL name | range | default |
|---|---|---|---|---|
| 0 | enable | Enable | 0..1 | 1 |
| 1 | base | Base key | 0..11 (C..B) | 0 |
| 2 | offset | Offset (transpose) | -12..12 | 0 |
| 3 | mode | How multiple notes are played | 0..4: All, All (gain-compensated), Random, Cycle up, Cycle down | 0 |
| 4 | slide | Pitch sliding time | 0..192 | 0 |

State: `map` = 12 rows (input pitch classes C..B), each a list of output
entries in semitones from the C of the input's octave, -12..+23 (the editor's
36 columns).

## Preset format (decoded)

Event 213 holds: i32 version (2), i32 Enable, i32 Base key, i32 Offset, i32
Mode, i32 Pitch slide, then for each of the 12 rows an i32 count followed by
count i16 entries. All 34 presets (Chords, Harmony, Scales, Special, Default)
are in `def.presets`, named like FL's tree ("Scales\Blues").

## Note processing

- Disabled: notes pass unchanged.
- Row = (key - offset) mod 12, base = the C below (key - offset); each entry
  plays `base + entry + offset`. The Offset therefore moves the whole matrix, so
  a scale preset plus Offset sets the key's root, as the manual describes ("use
  the Offset control to set the Root note"). Base key only relabels the rows.
- All: every mapped note. All (gain-compensated): the same with velocity
  divided by sqrt(n) (and `gain = 1/n`), so n notes sound like one. Random: one
  mapped note at random. Cycle up / down: per row, the next mapped note up /
  down (sorted by pitch) each time the row plays, wrapping around.
- Pitch slide: a moved note starts at the input pitch and glides to its own
  over the sliding time (ticks at 96 PPQ, scaled to the project PPQ), as
  `note.mod.pitch = [[0, input - output], [time, 0]]`.
- A row without entries mutes its notes.

Audio passes through. Inside Patcher the notes of its event links are played live through it (Patcher's LiveVfx, per note; docs/research/fx/patcher.md); Cycle up / down keeps its position from
note to note (`VfxContext.state`).

## Editor (775 x 373)

The matrix with FL's shading (sampled: outer octaves `#c3c7ce` / black keys and
black rows 16 darker, the middle octave 32 lighter; row labels `#63676e`),
mapped notes orange when unchanged and red when moved, labelled with the output
note. Left-click toggles a note, right-click makes it the row's only note,
middle-click resets the matrix (manual). Base key and Multi mode combos, Offset
and Pitch slide sliders (FL 2026 tick rail with a black knob), Enable LED in the
title band. Presets: the plugin window's preset selector / arrows. The manual's
"Tree display" option of the preset menu is not reproduced.
