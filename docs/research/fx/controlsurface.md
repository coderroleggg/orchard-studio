# Control Surface (FL: Control Surface)

Files: `src/model/fx/plugins/controlsurface.ts`, `src/engine/effects/plugins/controlsurface.ts`,
`src/ui/plugins/fx/controlsurface/index.tsx`, `tests/fx/controlsurface.test.ts`.

Sources: manual (control types, edit mode, menus), the form (540 x 454: Edit,
Add and Multi-touch buttons; surface menu Edit / Options: Show buttons, Show
labels, Grid None / 10..50px / Align controls / Tools: Control creator / Add
control), the screenshots (ControlSurface.png: XY pad, knob, slider with ruler,
button, red edit frames, resize corner, control menu Rename / Colors / Style
(Carved with fill, Default, Round Handle) / Size / Delete / Set default value).

## Model

No fixed parameters: the state holds `controls` (type, name, position, size,
colour, style, range, default, output indices), `values` (normalised 0..1 per
output index), `edit`, `showButtons`, `showLabels`, `grid`, `multiTouch`. Each
control gets new output indices when created and keeps them, so links survive
other controls being added or deleted. Types: Bevel, Button (momentary /
toggle), CheckBox, Digits (min..max display), Label, Keyboard (outputs Note =
key/127 and Gate), Knob, Slider (vertical or horizontal), XY (outputs X and
Y). Outputs are named after the controls (`Knob 2`, `XY 1 X`).

## Behaviour

The DSP passes audio and returns `values` as its outputs. Out of edit mode,
knobs / sliders / digits use the standard parameter behaviour and menu
(automation clip, Link to controller: target `params.values.<output>`), and
value changes are knob-tweak gestures (undo follows "Undo knob tweaks").

## Not implemented

Control creator, custom styles (.ilcontrol), images, multi-touch input,
Keyboard MIDI output (outputs note / gate values instead).
