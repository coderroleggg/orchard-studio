# X-Y Controller (FL: Fruity X-Y Controller)

Files: `src/model/fx/plugins/xyctrl.ts`, `src/engine/effects/plugins/xyctrl.ts`,
`src/ui/plugins/fx/xyctrl/index.tsx` (+ `joystick.ts`), `tests/fx/xyctrl.test.ts`.

Sources: manual, form (239 x 352), the factory presets (10 parameters, the
skin name, joystick: enable, X axis, X absolute, Y axis, Y absolute, speed),
`flfxhost info/sweep`, the plugin's NewTick (0x5d290) and parameter helpers
(0x5c820, 0x5c940), and its first output on the research host (1703936 =
104·2^14, matched exactly).

## Parameters

| # | key | name | range / default | text |
|---|---|---|---|---|
| 0..3 | xLevel, xMin, xMax, xTension | X Level / Min / Max / Tension | 0..65536 (Tension -128..128) / 32768, 0, 65536, 0 | `50%` |
| 4..7 | yLevel ... | Y ... | same | |
| 8 | speed | Speed | 1024..2048 / 1536 | `50%` |
| 9 | accel | Acceleration | 256..1024 / 1024 | `100%` |

State: `axis` (the X/Y switch for the Level / Min / Max / Tension knobs),
`skin` (Default / Sampler grid), `joy` (enabled, axes, absolute per axis,
speed 70). Outputs `X`, `Y`. Eight factory presets.

## Motion (per song tick)

thrust step = (1e8^(speed/2304) - 1)·1e-8 + 1e-4 per tick (·96/PPQ; speed 2048 =
jump); damp = (1 - (1001^(acc/1024) - 1)/1000)^(96/PPQ) (0 at full acceleration);
within 0.3 of the goal damp *= 1 - (e^((1 - d/0.3)·ln 1e10) - 1)·1e-10;
vel = vel·damp + dir·min((1 - damp)·step, distance); pos += vel. The target
starts in the bottom-left corner (it glides to the goal on load, as in FL).
Each axis: v = Min + round(T(pos)·(Max - Min)), then max(v, Min), min(v, Max)
(so a reversed range sticks at Max, FL's own clamp); sent as v/65536.

## Editor

The pad (12 x 12 grid, crosshair and target at the moving position, a cross at
the goal, drag to set both levels; right-click: skin), the X/Y switch, white
metal knobs with red pointers (Level / Min / Max of the selected axis), the
tension box, Speed / Acc, joystick LED, axis menus (gamepads, axis 1-8,
Absolute) and speed. The Gamepad API drives the goal while a project has an X-Y
Controller with the joystick on. The "X-Y CONTROLLER" logo is not reproduced.
