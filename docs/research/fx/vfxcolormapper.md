# VFX Color Mapper (FL: VFX Color Mapper)

Files: `src/model/fx/plugins/vfxcolormapper.ts`, `src/engine/effects/plugins/vfxcolormapper.ts`,
`src/ui/plugins/fx/vfxcolormapper.tsx` (+ shared VFX widgets in `src/ui/plugins/fx/vfx/`),
`tests/fx/vfxcolormapper.test.ts`. Shared note model: `src/model/fx/plugins/vfx/notes.ts`.

Sources: FL 2026 form `VFX Color Mapper.txt`, manual page, screenshot
`VFX_colormapper.png` (1x), `flfxhost info` (32 parameters, NumOutVoices 16,
FPF_NoProcess: no audio processing). No factory presets.

## Parameters (FL order)

| # | key | FL name | range | default |
|---|---|---|---|---|
| 0..15 | out1..out16 | `Note color group Nto voice output` | 0..15 | N-1 |
| 16..31 | col1..col16 | `Note color group Nto note color group` | 0..15 | N-1 |

The names are FL's own strings, including the missing space before "to". The
plugin returns no value texts; the editor (and the clone's value text) shows
"N to M" as the combos do.

## Note processing

`processNotes(notes, params)`: a note of colour group c goes to voice output
`out<c+1>` (`note.port`, 0-based) and leaves with colour group `col<c+1>`; all
other properties are untouched. In Patcher the module has 16 event outputs, of
which voice ports 1-4 are active on a new module (FL's default, per the manual);
module menu > Outputs > Events activates the others. Audio passes through
untouched (a VFX does nothing in a mixer slot). Inside Patcher the notes of its event links are played live through it (Patcher's LiveVfx, per note; docs/research/fx/patcher.md); the voice
outputs carry the notes to the next modules.

## Editor (319 x 230)

Tab selector "Voice output" / "Color" (13,10; active tab dark `#1c252a` with
orange `#ff7838` text, inactive `#2f383d` with blue-grey text), the dark
PlugPanel (14,40 293x121) with 16 combos (69x26 at 4 + 72*col, 4 + 29*row)
painted in FL's note colours (sampled: `#aee1b5 #aedcc0 #aed7cb #aed2d6
#aecee1 #bac6db #c7bed6 #d4b6d0 #e1aecb #e6b9c0 #ecc4b6 #f1cfac #f7daa2 #e4dba6
#d2ddab`, the 16th extrapolated), and the VFX title band (0,174 319x56). A combo
click lists "N to 1" .. "N to 16" (the app's popup menu rather than FL's coloured
list), the wheel steps, right-click is the usual automation menu.
