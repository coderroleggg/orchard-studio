# Envelope Controller (FL: Fruity Envelope Controller)

**Status: measured against FL's plugin.** The test host loaded FL 2026's own `Fruity Envelope Controller_x64.dylib`, played
notes and recorded the plugin's `OnControllerChanged` calls. [H] = observed behaviour of the real plugin, [S] = its saved
state (FL's `.fst` files and the plugin's `SaveRestoreState`). A Python reference model of the rules below reproduced the
plugin's output on every non-hanging random state and on all of FL's presets; the TypeScript engine was then compared with
that model on 6000 further random states (no difference above 1e-5) and with the host on 55 recorded scenarios
(`tests/gen/envctrl.golden.ts`).

Files: `src/model/gen/plugins/envctrl.ts` (+ `envctrl/presetData.ts`: the 22 presets' numbers), `src/engine/gen/plugins/envctrl.ts`,
`src/ui/plugins/gen/envctrl/` (`index.tsx` panel, `Controls.tsx`, `EnvEditor.tsx`, `draw.ts`, `shapeOps.ts`, the key range keyboard of
`keyboardctrl/PianoKb.tsx`), `tests/gen/envctrl.test.ts`, `envctrl.golden.ts`, `envctrl-edit.test.ts`, `ctl-ui.test.ts`.

## Plugin facts [H]

Flags `0x10600060` = WantNewTick | NoProcess | NewVoiceParams | bit 28 (not a generator: notes arrive through `TriggerVoice`,
`Voice_Release`, `Voice_Kill`), 90 parameters, 8 internal outputs "Articulator 1..8", DefPoly 0. Editor form: SynthPanel 737 x 395.
Info text "Generates envelopes and LFOs as knob tweaks (internal controller plugin)".

| Index | Key | Name | Range | Form / DB default | Text |
|---|---|---|---|---|---|
| 11 a + 0 | `base<a+1>` | Base level | 0..256 | 128 / 128 | v / 256 % |
| 11 a + 1 | `env` | Envelope level | -256..256 | 0 / 256 | % |
| 11 a + 2 | `lfo` | LFO level | -256..256 | 0 / 128 | % |
| 11 a + 3 / 4 / 6 | `att` / `dec` / `rel` | Attack / Decay / Release time scale | 0..256 | 128 | v / 128 % |
| 11 a + 5 | `sus` | Sustain level offset | -128..128 | 0 | v / 128 % |
| 11 a + 7 | `spd` | LFO speed (phase) | 512..65536 | 40898 / 40000 | time text |
| 11 a + 8 / 9 | `tns` / `skw` | LFO tension / skew | -128..128 | 0 | v / 128 % |
| 11 a + 10 | `pw` | LFO pulse width | -112..112 | 0 | v / 112 % |
| 88 / 89 | `modx` / `mody` | Global modulation X / Y | 0..65536 | 32768 | v / 65536 % |

Percent texts round half away from zero. The speed text follows the LFO's TEMPO switch: absolute `m:ss:mmm` / `s:mmm` of the period
(floored to ms), tempo based `bars:beats:ticks` of the period at 120 BPM (rounded to a tick, 999 bars at most). LFO frequency in
Hz = 32 (10001^(v/65536) - 1) / 10000 (exact on 509 recorded texts and measured periods). **A new instance starts at FL's plugin
database state** (envelope level 100 %, LFO 50 %, one ADSR envelope on articulator 1, spd 40000), not at the form defaults.

State [S]: per articulator an ENV, an LFO shape (the LFO's modifier envelope) and five mapping envelopes (key, velocity, Mod X, Mod Y,
random): points (position, value, tension, mode), enable / TEMPO / GLOBAL flags and the section markers D (decay start), L (loop
start), S (sustain) as point indexes; the MODE polarity, the key range (`hi` 256 = open), the "Continuous output" option, the
editor's selected articulator and source. Orchard keeps JSON (`arts[8] = {env, lfo, maps[5], polar, lo, hi}`, `cont`, `sel`, `src`;
view state `sel`, `src`, `tb`, `kscroll` survives preset loads). Positions are in envelope units: 0.5 s, or beats when TEMPO is on.

## Behaviour [H]

- **Ticks.** The plugin runs once per song tick (NewTick, also while stopped); tick k sits at sample floor(k x samples per tick).
  A note's events at a sample are processed before that sample's tick. An output is sent only when its value changes (float32
  compare, the initial value is 0).
- **Voices.** A note creates a voice for every articulator whose key range holds its key; an articulator follows its newest
  voice (a new note takes it over), a note no articulator takes gets no voice. The voice lives while a source is still running
  (envelope not finished, LFO not finished or waiting).
- **Envelope time.** One step per tick of `1/PPQ` beat (TEMPO) or 2 x tick seconds (units of 0.5 s). Segment lengths before the D
  marker are scaled by ATT, D..S by DEC, after S by REL (no S: ATT up to D, DEC after it). SUS offsets the values from D to the
  loop start (or S), ramped in over the unscaled time; S on the first point without a D marker tilts the whole envelope the other way.
- **Sustain and release.** The S marker holds its level until the note off; the release plays the points after S: the value reached
  tilts down into them (`y_i + (v - y_S)(1 - t/R)`); with D on S (no decay section) the release starts at S and the missed distance
  tilts it down (`y_i - (v - y_S) t/R`). A release without length ends on its first step on the last release point. Without an S
  marker a note off switches to the decay stage (the segments after the running one are scaled by DEC).
- **Loops.** L..S (or L..end) repeats while the note is held, restarting from the loop end's level; a loop needs some length
  unscaled and scaled; after the first pass (only with a decay stage, D < end, L < D) the looped segments before D scale by DEC;
  a loop marker keeps an envelope without S on its last level until the note off.
- **LFO.** A trapezoid (rise 0.25 (1 + skew) (1 - |pw|), fall 0.5 (1 - skew) (1 - |pw|), hold |pw| on top / bottom), bent by the tension
  law `(1 - e^(-q|w|)) / (1 - e^-q)`, q = 0.9 ln 10 (21^(|t|/128) - 1); output w (2y - 1) with y the modifier envelope. A retriggered
  LFO starts at phase 0 (rising zero crossing); GLOBAL runs on the tick count with the wave's natural origin. A modifier envelope
  with S on its first point **waits silent until the note off**, then runs from its start without a sustain marker (GLOBAL continues
  from the global phase of the note on, free running afterwards).
- **Combining.** Bipolar: `o = base + E (e - 1/2) + L w / 2 + sum (m - 1/2)`; unipolar: `o = (base + E e) (1 + L w) prod m`; clamped to 0..1.
  Mapping inputs: key / 120, velocity x 0.007748626 (0..128), Mod X = global X + (note + channel Mod X) / 2 (likewise Y), a random
  value per note. A flat Mod X / Y map counts twice (plugin quirk). "Continuous output" sends the outputs from the global X / Y
  alone while no note plays.
- Channel Mod X / Y reach the plugin as `levels.fcut / fres` (FinalLevels = note + channel).

## Engine notes

'voices' plugin, `noAudio`, `tail = Infinity`. Voices carry `GenVoiceParams.frame` (the block frame of the trigger / release /
kill); events are applied in time order between tick boundaries (`render` splits the block at the song's ticks, aligned through
`ctx.pos` while playing, free running while stopped). A tick that falls on a block boundary stays in the block that starts there
(the epsilon in `render`). `monitor()` reports the last note of every articulator (key, velocity, random, Mod X / Y) for the
mapping views' vertical line. Polyphony is the channel's (128 voices).

## Editor

FL's form (737 x 395) at its coordinates: the X / Y pad with the global Mod X / Y wheels and the options menu ("Continuous output"), the
articulator selector (1..4, 5..8), MODE (bipolar `+/-` / unipolar `x`), the BASE / ENV / LFO wheels (arc from the bottom,
centre at the top for the bipolar ones), the source combo (Envelope, LFO, the five mappings; an arrow marks the sources in use:
enabled envelope / LFO, a mapping that is not flat), the key range keyboard (drag the ruler; a click plays the articulator),
and the envelope editor: grid (0.1 s lines, a major line per second, quarter beats / beats when TEMPO; 16 value rows, 4 major
columns in the mapping views, black key columns and octave lines in the key mapping), the translucent fill and red curve, orange
points, red tension circles, D / L / S marker lines with their flags, the LFO preview (`0.5 + L w (2y - 1) / 2`), the last note's
line in the mapping views, time and level scrollers, the bottom strip (activate, ATT / DEC / SUS / REL or SPD / TNS / SKEW / PW,
TEMPO, GLOBAL) and the toolbar (menu, reset, Freeze, Step, Snap, Slide). Mouse: right-click adds a point (on the line or the
background), drag moves (Shift locks vertical, Ctrl locks horizontal movement), drag the circle for the tension (Ctrl fine, right-click
resets), right-click a point for its menu (S / L / D / DL markers, Delete, curve type), Alt + click deletes, drag the background
to select points, Delete deletes them, wheel zooms the time axis (Ctrl: levels). Colours were sampled from FL's manual screenshots
(the fill and marker lines are additive: +19 +3 +2 and +94 per channel).

## Fidelity

- **Exact (measured):** parameter list, ranges, defaults of both states, value texts, speed law, the 22 presets, outputs, the ENV player
  (ATT / DEC / REL / SUS, S, D == S release, loops and their validity and rescale, no-sustain note off), the LFO wave / tension /
  skew / pulse law and phase origins, the S-wait rule, combining, mapping inputs, tick timing and the on-change output rule.
- **Not replicated (FL hangs or misbehaves):** D after S and L at or after S marker combinations (the editor does not offer them).
- **Approximate:** the random value (uniform `Math.random`, FL's generator is not seeded like ours); float32 noise up to 1e-5 against
  the host; the editor's drawing, the default zoom / scroll range of the time axis, the Step tool, the envelope menu (FL's has more
  items: load / save state, smoothing tools, scaling, decimate, filter, sequence, audio analysis) and the selection tools.
- ZGE Video Controller preset modes 6 / 7 are verified only through the recorded scenarios.
