# X-Y-Z Controller (FL: Fruity X-Y-Z Controller)

Files: `src/model/fx/plugins/xyzctrl.ts`, `src/engine/effects/plugins/xyzctrl.ts`,
`src/ui/plugins/fx/xyzctrl.tsx`, `tests/fx/xyzctrl.test.ts`.

Sources: manual and screenshots (Fruity_XYZ.png, Fruity_XYZ_mapping.png), the
form, `flfxhost info/sweep`, FL's 11 factory presets (decoded state: version 3,
11 parameters, option flags, colour 144, then per axis an input and an output
mapping envelope: count, points of double x, double y, float tension and FL's
point mode byte), the plugin's NewTick (0x63e40), smoothing setup (0x637d0) and
its smoother library (0x1d10b0 setup, 0x1d1560 run, 0x1d1510 reset).

## Parameters

X / Y / Z value (0..65536 / 32768), X / Y / Z smoothing speed (0..4096 /
2048), X / Y / Z smoothing acceleration (0..3072 / 3072), Global smoothing
speed (0..4096 / 2048), External controller speed (0..4096 / 1024). Texts are
percentages of the range. State: `inMap` / `outMap` (3 curves each, envelope
points with FL's modes: single, stairs, wave...), `page`, `axis`, `color`,
`options` (Absolute mode, Fingertip control, Round to square), `hideControls`.
Outputs `X`, `Y`, `Z`. Presets: Default (absolute on), First half, Instant,
Inverted, Last half, Slow, Smooth, Steppy (stairs 0.65), Tension down / up
(single ±0.28), Wobbler (wave -0.725).

## Behaviour (per song tick, per axis)

target = input map(value); smoothed = three cascaded one-pole stages on
(target - base) + base; snap (reset base and stages) within 1.52587890625e-6;
sent = output map(smoothed) at 2^30. Stage coefficients 100^(-1/T) (T ticks to fall
40 dB; FL computes exp(-ln(100)/T)): T = time /
sqrt(poles) for full stages, the last stage scaled by the fractional pole
count, the rest bypassed; poles = acc/1024; time = (17^(global/4096) - 1)·24·
PPQ/96 ticks · axis factor (3^(speed/2048) - 1)/2 (1 at the centre). Loading
a state snaps the smoothers. The two constants FL initialises at load time were
read from their initialisers: -ln(100) (stage coefficient) and ln(3) (speed curve).

## Editor

Laid out after the screenshot (FL's form is arranged at run time): the pad
(room with checkerboard in the COLOR hue, cursor at the smoothed position, its
size from Z; drag = X/Y (absolute or relative), wheel = Z), x / y / z bars,
axis tabs, the page selector (Coordinates / Input mapping / Output mapping: the
pad edits the axis curve: drag points, double-click adds, drag a segment for
tension, right-click for delete / mode / reset), SPEED / ACC of the axis,
GLOBAL SPEED, the external controller SPEED, the options gear menu and COLOR.
External controllers (sensors, Leap Motion, joysticks) are not implemented.
