# VFX Level Scaler (FL: VFX Level Scaler)

Files: `src/model/fx/plugins/vfxlevelscaler.ts` (def + mapping maths),
`src/engine/effects/plugins/vfxlevelscaler.ts`, `src/ui/plugins/fx/vfxlevelscaler.tsx`,
`tests/fx/vfxlevelscaler.test.ts`.

Sources: FL 2026 form (SynthPanel 566 x 481), manual page, screenshot
`VFX_levelscaler.png` (FL 2026, about 1.32x, Velocity tab with a tension S-curve
and a humanize band), `flfxhost info` and `sweep` (36 parameters, constructor
defaults; no value texts; no factory presets).

## Parameters (FL order, 6 per property)

Properties: Velocity, Release, Fine Pitch, Pan, Mod X, Mod Y (tabs Velocity,
Release, Pitch, Pan, Mod X, Mod Y). For property i the indices are 6i..6i+5:

| field | key suffix | FL name | range | default |
|---|---|---|---|---|
| Center | `Center` | `<prop> - Center` | 0..8192 | 0 (Velocity, Release, Pan), 4096 (Fine Pitch, Mod X, Mod Y) |
| Multiplier | `Mul` | `<prop> - Multiplier` | -16384..16384 | 8192 (x1) |
| Offset | `Ofs` | `<prop> - Offset` | -8192..8192 | 0 |
| Tension | `Tension` | `<prop> - Tension` | -8192..8192 | 0 |
| Humanize amount | `Hum` | `<prop> - Humanize amount` | 0..16384 | 0 |
| Humanize mode | `HumMode` | `<prop> - Humanize mode` | 0..2 (Subtract, Spread, Add) | 1 (Spread) |

Keys: `vel*`, `rel*`, `pitch*`, `pan*`, `modx*`, `mody*`. The plugin has no
value texts; the clone shows percentages (Multiplier 8192 = 100%).

## Mapping (derived from the manual and the screenshot)

Input x = property / full scale (velocity, release, pan: /128; fine pitch:
/240; mod X/Y: /255), output y in 0..1, written back rounded:

1. Tension curve around the centre c: each side of c is bent by
   `1 - (1 - d)^e`, `e = 2^(3 t)` (d = distance from c, normalised to that side),
   so positive tension is an S steep at the centre and flat at the ends, negative
   an inverse S, and with c = 0 (velocity default) a plain power curve.
2. Multiply around the centre: `y = c + (curve - c) * mul` (with c = 0 this is
   plain scaling; negative multipliers invert).
3. Offset: `+ ofs`; then humanize: half-width `a = sqrt(amount)` (Spread:
   `+-a`, Add: `+[0, a]`, Subtract: `-[0, a]`, uniform), clamped to 0..1.

Calibration against the screenshot: with the centre at 50%, tension at about
+45% and humanize at about 7%, the curve and the band (`curve +- 0.26`, clamped)
match FL's drawing; the square root reproduces the band width of such a small
knob setting. The exact curve family is not documented.

## Editor (566 x 481)

Tabs (8,8), the control sheet (8,38 550x378): FL 2026 vertical sliders with a
tick ladder, silver cap and a cyan line from the zero position (Center 12,26
40x210; Multiply 59,26 40x271; Offset 107,26 40x271), Tension and Humanize knobs
(36 px, cyan arcs), the Mode combo, RESET (resets the visible property), the
display (160,6 384x365: 10x10 grid, property watermark, identity diagonal, the
curve in `#63ebff` and the humanize band). "Event persistence" (FadeSpeedWheel,
Tag -1, 1..16384, default 12288) is editor state (`fade`). The display shows no
note lollipops: live notes (Patcher's event links, played through processNotes in the
engine) do not reach the editor. FL's window is resizable; the
clone's editor has the form size.
