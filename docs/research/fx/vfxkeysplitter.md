# VFX Keyboard Splitter (FL: VFX Keyboard Splitter)

Files: `src/model/fx/plugins/vfxkeysplitter.ts` (def + presets),
`src/model/fx/plugins/vfx/envelope.ts` (FL envelope points, shared with VFX Envelope),
`src/engine/effects/plugins/vfxkeysplitter.ts`, `src/ui/plugins/fx/vfxkeysplitter.tsx`,
`src/ui/plugins/fx/vfx/EnvEdit.tsx` (FL's envelope editor), `tests/fx/vfxkeysplitter.test.ts`.

Sources: FL 2026 form (SynthPanel 941 x 388: PartSelect 7,7 432x39, EnvSelect
544,7 122x39, KeyOfsSlider 728,7 207x20 -48..48, Random / Absolute 667,28,
MEnvEditor 8,54 925x270, Manual mapping 812,339 122x42), the manual page, the
screenshots `VFX_keysplitter_key.png` / `_velocity.png`, `flfxhost info`
(NumParams 0, 16 voice outputs), and FL's 17 factory presets decoded from their
`.fst` files.

## State (no parameters)

`zones[16] = { key, vel, transpose, abs, random }`, plus the editor's `zone`
(selected) and `view` (0 Keyboard, 1 Velocity). `key` / `vel` are FL envelope
points `{ pos, value, tension, mode }` (the same point model and evaluator as
automation clips); the keyboard envelope spans keys 0..132 (x = key / 132),
the velocity envelope velocity 0..128.

Default (FL's Default preset): zone 1 covers the whole keyboard, zones 2-16 are
empty, velocity envelopes flat at 100%.

## Preset format (decoded)

Event 213: a header (`03 00 00 00`, or `03 00 10 00 01` in the Velocity presets),
then per zone two envelopes and 7 bytes. Envelope: i32 3, i32 3, i32 point
count, 24 bytes per point (f64 position delta, f64 value, f32 tension, u16
curve mode, u8 selected, i8 tension sign), then i32 0 and four i32 -1. Zone
tail: i32 transpose, u8 Absolute, u8 Random, u8 (always 0). The presets'
zone edges sit on multiples of 1/132, which fixes the key scale.

## Note processing

For each zone: k = keyboard envelope at the key. Without Random the zone plays
the note when k > 0 and scales its velocity by k (fades cross-fade zones); with
Random, k is the probability that the zone plays it (the hint "Mapping output =
probability"; the manual's text mentions the velocity envelope here). The
velocity envelope at the input velocity multiplies the velocity, or replaces it
with Absolute ("the set velocity envelope overrides the input velocity"). A zone
whose velocity comes out at 0 does not play, so velocity envelopes split by
velocity (Split high low presets). The copy goes to voice output = zone, with
the zone's transpose. Audio passes through. Inside Patcher the notes of its event links are played live through it (Patcher's LiveVfx, per note; docs/research/fx/patcher.md).

## Editor

Zone buttons in the zones' colours (selected: filled), "Zone N", the
Keyboard / Velocity switch (cyan when active), Transpose slider (per zone),
Random (keyboard view) / Absolute (velocity view), and FL's envelope editor: in
the keyboard view every zone's mapping is filled in its colour over key stripes,
in the velocity view every used zone's velocity curve; the selected zone's
envelope is outlined in its colour and editable (drag points, drag the segment
circles for tension, right-click to add / for the point menu, Alt+right-click
deletes), with a zoomable time scrollbar and the toolbar (menu: reset, flips,
zoom out; reset; Freeze, Points, Snap (key / velocity steps), Slide).

Manual mapping: FL takes the split keys from the preview keyboard or MIDI; the
editor does not see the live notes (they reach the engine only), so while Manual mapping is on, clicks on
the keyboard display act as the played keys (each starts the next zone from
zone 1 on; zone 16 or switching it off closes the last zone). The white preview
line of the input note is therefore not shown either.
