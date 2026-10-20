# VFX Script (FL: VFX Script)

Files: `src/model/fx/plugins/vfxscript.ts` (def, example scripts),
`src/model/fx/plugins/vfx/pyvm.ts` (sandboxed Python-subset interpreter),
`src/model/fx/plugins/vfx/vfxrun.ts` (the `flvfx` API and the tick runner),
`src/engine/effects/plugins/vfxscript.ts`, `src/ui/plugins/fx/vfxscript/` (editor),
`tests/fx/vfxscript.test.ts`.

Sources: FL 2026 form (799 x 521: SheetSelector with User interface / Script /
Log / API reference, CompileButton 6,6 105x30, RestartButton 116,6, MainMenuBtn
768,6 with the PlugPopupMenu items, LineNrLabel, ScriptMemo 6,44 787x272,
ErrorMemo, LogMemo, HelpMemo, RestoreScriptTabsButton), the manual page (API
reference, tutorial scripts), screenshots `VFX_script.png` (1.79x) and
`VFX_script_controllers.png`, and FL's preset files (plain text: `[Script]
Source=` with `<linebreak>` markers and `[Parameters] name=value`). The test
host cannot load the plugin (its embedded Python calls exit()).

## Interpreter (feasible, implemented)

FL runs CPython; the clone runs scripts on its own tree-walking interpreter: a
tokenizer with indentation, a recursive-descent parser and an evaluator. It
never uses `eval` / `new Function`: scripts reach only the builtins and the
`math`, `random` and `flvfx` modules, and every run has an instruction budget
(endless loops end with "RuntimeError: script took too long"). Supported:
def (defaults, keywords, *args, **kwargs), class (inheritance incl. vfx.Voice,
class attributes, methods, `__init__`, `__str__`), lambda, if / elif / else,
while / for (+ else), break / continue / pass, return, global / nonlocal, try /
except / else / finally, raise, assert, del, assignment with unpacking and
starred targets, augmented assignment, arithmetic, comparison chains, and / or /
not / in / is, conditional expressions, slicing, list / tuple / dict / set
displays and comprehensions, f-strings with format specs, `%` and `str.format`,
common builtins (print, len, range, int, float, str, round, min / max with key,
sum, sorted, enumerate, zip, map, filter, isinstance, getattr...) and str / list
/ dict methods. Errors have Python's types and line numbers ("SyntaxError:
expected ':' (line 22)", "NameError: name 'x' is not defined (line 5)").
Differences: no other modules (no numpy etc.), no generators / yield, no `with`,
no decorators; ints and floats are not distinguished (2.0 prints as 2).

## flvfx API and the runner

`vfx.context` (ticks, PPQ, tempo, isPlaying, voices, form), `vfx.Voice` (note,
finePitch, velocity 0..1, pan -1..1, length, output, fcut, fres, color;
trigger(), release(), copyFrom()), `vfx.ScriptDialog` (addInputKnob,
addInputKnobInt, addInputCheckbox, addInputCombo, addInputText, addInputSurface,
addGroup / endGroup ("Group: Name"), getInputValue, setNormalizedValue),
`vfx.addOutputController` / `vfx.setOutputController`.

`runScript` plays notes through a script tick by tick from tick 0 to the end of
the last note plus one bar (or a given horizon): note-offs call
onReleaseVoice(the same voice object), note-ons onTriggerVoice, then onTick.
Script voices become notes from trigger() to release() (or `length` ticks);
pitch changes after the trigger become a `mod.pitch` curve; output controller
values are returned per tick. Note properties map as velocity = vel/128, pan =
(pan-64)/64, finePitch = (fine-120)/100, fcut / fres = (modX / modY - 128)/128.

## Parameters and state

FL's automatable parameters are the dialog's controls by name. The clone has
32 fixed automatable "Script control N" parameters (0..1); control i of the
compiled dialog uses `c<i+1>` (knob: min..max, int knob / combo rounded,
checkbox at 50%); text fields are state. Compiling keeps values by control name.
State: `code` (editor text), `compiled` (the running script), `dialog`,
`outputs`, `texts`, `error`, `log`, `tab`, `hideTabs`.

## Editor

Sheets as in FL, active tab text `#fbdf4c`. Script: Compile (also Ctrl+Enter),
Restart (clears and re-runs, keeping the UI), the options menu (FL's items;
surface embedding and external editors disabled; Hide script tabs works), line
/ column label, the memo (`#e7f0f6`; keywords `#390cac`, strings `#ac340c`,
operators `#fc730d`), the error memo. User interface: the description and the
controls (knobs with values, checkboxes, combos, text fields, group titles) in
two columns. Log: print output of the last compile / restart (Backspace
clears). API reference: the clone's own summary of the API.

## Not implemented / differences

- Live notes: inside Patcher a script runs once per note when the note starts (2 bars,
  then outputs reaching the end last until the release; Patcher's LiveVfx), so scripts
  that keep state across notes (several held notes in onTick) do not behave as in FL;
  the Log shows compile-time output.
- Embedded Control Surface presets (`addInputSurface`) and external editors.
- FL's 22 factory scripts are Image-Line's content and are not copied; the
  clone ships seven example scripts of its own (Default bypass, Transpose,
  Chord, Note Gate, Arpeggiator, Pulse Generator, Sine LFO).
