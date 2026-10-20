# Remote control links ("Link to controller...")

Files: `src/model/links.ts` (data model, FL's mapping presets, value chain),
`src/model/formula.ts` (the formula language), `src/engine/Engine.ts`
(`setLinks` / `applyLinks`), `src/engine/Automation.ts` (`setLinked`),
`src/engine/protocol.ts` (`links`, `mouse`), `src/audio/AudioHost.ts`
(sync + UI mirror), `src/audio/midiLinks.ts` (MIDI CC links),
`src/store/actions.ts` (`saveLink`, `removeLink`, `linkToController`,
`controllerSources`, `linksOf`), `src/ui/link/RemoteControlDialog.tsx` + `remote.css`,
`src/ui/widgets/control.ts` (menu item), tests `tests/links.test.ts`, `tests/formula.test.ts`.

Sources: FL manual pages automation_internal / automation_linking /
automation_form (scratchpad `auto/pages`), FL's `TMIDIInputForm` decoded from
`FLEngine_x64.dylib` (geometry, captions, hints, the Mapping formula menu with
every preset formula in its item hints), strings of FLEngine ("Compiled ok.",
"Error compiling expression", "Link ", "New link", "Controller plugins",
"Automation clips", "User defined", "(default 1:1 mapping)", "In: %s out: %s",
"%dms", "Disabled"), FL's `Config/Mapping/Formulas.txt`, and the controller
plugins' own code (outputs are sent per song tick with `OnControllerChanged`,
values 0..2^30).

## Data model

`Project.links?: ControllerLink[]` (missing in old saves; `normalizeProject`
fills `[]`, drops malformed entries and links whose controller slot is gone):

| field | meaning |
|---|---|
| `id` | stable id |
| `target` | an `AutomationTarget` (scope / id / path / min / max / step / label), the same addressing as automation clips |
| `source` | `{ slotId, output }`: output index of a controller plugin in a mixer slot |
| `midi` | `{ port (-1 any), chan 1..16, ctrl, omni, mode }` (main-thread MIDI CC link) |
| `formula` | mapping formula, `Input` = 1:1 |
| `relative` | set by the "Incremental (relative)" presets (endless encoders) |
| `smooth`, `smoothTime` | Smoothing switch and Time control (-1024..1024, default 469) |
| `record` | "Record automation" switch (stored only) |

A parameter may have several links ("Link 1", "Link 2"...; the dialog's entry
combo). Removing a plugin (or replacing it) removes the links it sources or
targets; deleting a channel removes links targeting it.

Plugins declare their outputs with `FxPluginDef.outputs` (names, or a
function of the slot state for the Control Surface; '' = unused index); the
DSP returns the values with `EffectInstance.controls()` (0..1, a buffer the
instance keeps). The dialog lists `<slot name> (<mixer track>) - <output>`,
FL's text (e.g. `Peak Controller (Insert 2) - Peak`).

## Engine flow

1. `links` message: each link with a `source` is compiled once (formula ->
   closure tree), keyed by `targetKey(target)`. `AutomationRuntime.setLinked()`
   gets the linked keys.
2. Every block, after `mixer.process()` (the controllers have run), each link
   reads `controls()[output]` of its slot (slot index cached, rebuilt on mixer
   changes). When the value changed (or the formula reads time / random
   values), it is mapped: `Input` -> formula -> clamp 0..1 (NaN -> 0) ->
   optional smoothing (one pole reaching 95% within FL's smoothing time,
   (11^(|t|/1024) - 1) x 100 ms: 200 ms at the default 469, the law of FL's
   "%dms" hint; FL's filter shape and the sign of t are not known) -> `denormalize(target)` -> applied with
   `applyAuto` when the model value differs, then `flushAuto`.
3. The changed values go to the UI with the status message (`auto`, merged with
   automation values); `AudioHost.queueAutomation` writes them into the project
   (no undo entry), so linked knobs move. Linked keys are never dropped as
   "released" values.

Links run in song and pattern mode, playing or stopped: controllers process
every block (`tail = Infinity`, so their tracks never go idle). A linked value
takes effect from the next block (FL's controllers are a tick late too).

### Links and automation clips

FL treats an automation clip as just another internal controller; several
links to one control fight (the last value sent wins). Here a linked control
**follows its controller**: while the link exists its automation clips and
initialized value are ignored (`AutomationRuntime.update` skips linked keys).
As in FL a link sends only on change, so a control moved by hand keeps its
position until the controller moves again. Removing the link hands the control
back to its clips (and initialized value on the next relocation).

## Formula language (`src/model/formula.ts`)

Hand-written tokenizer, precedence-climbing parser and closure compiler (no
`eval` / `Function`); constant sub-expressions fold at compile time; compiled
once per link (cached by text). Case-insensitive.

- Operators: `+ - * / ^` (right associative; unary minus binds looser than `^`),
  comparisons `= in <> < > <= >=` (lowest, 1 / 0), `and or xor` and unary `not`
  (true = above 0.5), `div mod` (integer, truncated operands), `fmod`, `shl shr`,
  postfix `%` (/100) and `!` (factorial of the integer part).
- Values: `Input`, `a b c`, `SongTime` (quarters), `Time` (ms), `GetTempo`,
  `Pi`, `Rand`, `MouseX/MouseY` (window 0..1, Y up; the host forwards the mouse
  only while some formula uses it), `Date` (Delphi day number).
- Functions: Abs ArcCos ArcCosh ArcSin ArcSinh ArcTg/ArcTan ArcTanh ATan2 Case
  Ceil Cos Cosh CoSec Ctg DegToRad Exp Floor Fold Frac If IfE IfG IfGE IfL IfLE Int
  Inter Internoswap IntPower Ln Log10 Log2 LogN Map Max Min (any arity) Neg Pow
  Power RadToDeg Round (half to even, Delphi) Sec SeededRand Sin Sinh Sqr Sqrt Sum
  Tan/Tg Tanh Tension Trunc Warp. Zero-argument functions may take `()`.
- `Tension(x, s)`: s > 0: (s + 1 - (s+1)^(1-x)) / s; s < 0: ((1+|s|)^x - 1)/|s|
  (research doc automation.md §4.7; FL's controllers use the same curve).
- Interpretations where the manual is vague: `Case(a,b,c)` = b when a = 1;
  `Fold` reflects into 0..1; `Warp(a,b)` wraps a into 0..b; `SeededRand` is a
  hash of the seed's bits; `If` evaluates only the chosen branch.
- Errors carry a position ("')' expected", "Unknown identifier 'foo'",
  "sin expects 1 argument"...); the dialog shows FL's "Error compiling
  expression" plus the detail, "Compiled ok." or "(default 1:1 mapping)".

Presets: FL's Mapping formula menu (Linear (absolute): Default, Inverted, Log
scale `Tension(Input,10)`, Inverted log scale, Switch `Round(Input)`, Steppy
`Int(Input*9)/8`, Steppy (cents to semitones) `Int(Input*25)/24`, First / Last
half, Center dead zone small / large, MIDI CC centered around 63 / 64;
Incremental (relative): Default / Inverted increment, 4x / 2x smaller / bigger,
1/50, 1/20, 1/10 increment, Force boolean; Special: Launchpad XY - X / Y), plus
the "User defined" entries of FL's shipped Formulas.txt.

## Remote control settings dialog

FL's form is 256 x 490: caption (settings glyph, "Remote control settings"),
parameter combo (P_LargeBold), link entry combo (Link 1..N / New link), MIDI
controller panel (Port -1..255, Channel 1..16, Ctrl, Auto detect, Omni, Mode
Default / Hold / Latch / Inc / Stay), Internal controller panel (hidden when
the project has no controller outputs: "(none)", "Controller plugins" header,
the outputs; Record automation), mapping graph (76 x 75, hint "In: x% out: y%")
and Mapping formula panel (edit, presets button, status), Smoothing panel
(switch in the title, Time slider), Remove conflicts, Reset / Skip / Accept.
Colours are the form's (#4d565c, panels #3c454b, combos #262b2f / #9fa7ad).
FL's "Skip" (multi-link) is shown as **Remove** (deletes the current link).
Accept with neither an internal controller nor a MIDI controller removes the
link. Escape cancels, Enter accepts. The dialog mounts its own React root.

## MIDI CC links

`src/audio/midiLinks.ts` (Web MIDI, main thread): requested only when the
project has MIDI links or Auto detect waits. A CC on the link's channel (any
with Omni) and port (input index, -1 any) maps cc/127 through the formula
and writes the target in the project (one merged history step), like a mouse
tweak; relative links read 1..63 / 65..127 as +/- steps. Note links (Mode) and
FL's per-port numbering from MIDI settings are not implemented.

## Left out

Automation clips as link sources (FL lists them under "Automation clips"),
Override global link / Multilink, Record automation, the smoothing filter's exact shape.
