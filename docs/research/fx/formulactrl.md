# Formula Controller (FL: Fruity Formula Controller)

Files: `src/model/fx/plugins/formulactrl.ts`, `src/engine/effects/plugins/formulactrl.ts`,
`src/model/formula.ts` (shared with the link mapping formulas),
`src/ui/plugins/fx/formulactrl.tsx`, `tests/fx/formulactrl.test.ts`, `tests/formula.test.ts`.

Sources: FL manual (syntax table, examples), the form (521 x 370), FL's
factory presets (Default, Empty, LFO/*, Mapping/*, Special/*: knob values,
formula, comment), `flfxhost info/sweep`, the plugin's NewTick (0x5d040).

## Parameters and state

| # | key | FL name | range / default | text |
|---|---|---|---|---|
| 0..2 | a, b, c | a / b / c parameter | 0..65536 / 0 (Default preset; form reset 32768) | `50.0%` |

State: `formula` (Default `a+b+c`), `comments` (plain text of FL's RTF
comment), `sheet` (Comments / Monitor). FL's blob: version 2, a, b, c, the
formula as a short string, the RTF comment. Output: `Out`. All 20 factory
presets are in the def (folder names kept as `LFO/...`).

## Behaviour

Once per song tick (FL's NewTick): evaluate the compiled formula with a, b, c
= knob/65536, SongTime = song position in quarters at the tick (pattern
position in pattern mode; held while stopped), Time = ms, the tempo and the
mouse; convert to single precision, clamp to 0..1 (NaN -> 0), send at 2^30
resolution on change. A formula that fails to compile sends nothing (FL clears
its "compiled" flag on an evaluation exception and stops too). Audio passes.

## Editor

Input panel (big coloured a / b / c knobs, 11 ticks over 300°, value dot,
dimmed when the formula does not read them, values `0.500`), Formula panel
(field coloured like FL: a green, b blue, c pink, operators dimmer; Enter or
Compile compiles; status "Compiled ok" in yellow or the error; ? lists the
syntax and inserts names), the comments sheet over the faint output graph and
the Monitor sheet (beat bands, white curve, current value), FL's slanted
Comments / Monitor tabs.
