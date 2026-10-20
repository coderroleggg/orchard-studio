# VFX Sequencer (FL: VFX Sequencer, powered by BlueARP)

Files: `src/model/fx/plugins/vfxsequencer.ts` (def), `src/model/fx/plugins/vfx/seqPrograms.ts`
(FL's 128 built-in programs), `src/engine/effects/plugins/vfxsequencer.ts`,
`src/ui/plugins/fx/vfxsequencer/` (editor + `seq.css`), `tests/fx/vfxsequencer.test.ts`.

Sources: FL 2026 form (SynthPanel 984 x 560: ProgramComboBox 8,22, MapVisual 133,22
532x244, GridSettingsPanel 0,294 with the six lanes, SettingsPanel 674,0 309x460,
MIDIKbPanel 2,460), the manual page, the screenshot `VFX_sequencer.png` (exactly
1.5x), and the plugin itself through the test host: parameter names, ranges and
value texts (`info`, `sweep --all`), and all 128 programs (setting CurProgram to
0..127 loads each program's values, which were read back).

## Parameters

FL's indices and names. Settings: MIDI In Channel (1, -1 = All), MIDI Out Channel
(2), Arp Mode (5: Off, On, Thru, 2 note on/off, 2 note on/thru, 3 note on/off,
3 note on/thru), CurProgram (8), Input range mode (16), Output velo mode (17),
Steps (40, 0..64, 16), Gate (41, 1..125, shown x0.8 %: 90 = 72%), Sync (42: 1/64 ..
3/8, 1/16), Latch (43), Missing key subst. (44), Input range low / high (45 / 46,
note names, C0..G10), Output rng wrap low / high (47 / 48), Order algorithm (49),
Fixed key (50, 57 = A4), Master transpose oct / semi (51 / 53), Input quantize
(52, 1/16), Page scroll (54), Swing (55, shown x2 %), Restart On (56), Force scale
key / scale / mode (57 / 58 / 59), Page lock (60), Input rng wrap (63 / 64),
Polyphonic octave / key sel. (65 / 66), Missing key octave (67), GATE lane mode
(69), Randomize velocity / gate / start (70 / 71 / 72), Smart bend (80).
Lanes, 64 steps each: ScaleStep (128+, -12..12), Octave (192+, -3..3; a bit mask
of octaves with Polyphonic octave, as the chord programs store), StepType (256+:
Off, Nrm, Rst, Tie, Chr, Rnd), KeySelect (320+: Fix = -1, Root, N1..N5; a bit mask
with Polyphonic key sel.), Velocity (384+, MIDI 0..127, 96), GateStep (448+: 1/8,
1/4, 1/2, -, 2x .. 32x). FL's internal parameters (patch version, programs count,
chains, MIDI ports, message filters, 512..575) are not exposed.

Defaults = program 0 ("000. - Initial program -"). The 128 programs are offered as
the plugin's presets and in the editor's Sequence selector (grouped by 16, with
previous / next / random), stored compactly as the settings and lanes that differ
from program 0.

## Processing (`processNotes`)

The input notes are filtered (range: Truncate drops, Pass thru passes the notes
unarpeggiated), folded into the input wrap range, quantized (In quantize), and
bent (Smart bend: scale steps with Force to scale, else semitones). Thru passes
everything with transpose / scale / output wrap. The arpeggiator then walks the
step grid (Sync x whole note; swing delays the even steps by swing x2 % of a step)
while notes are held (Latch keeps the last chord; offline, one pattern length past
the last note): the pattern index follows Restart On (Beat 0 / Play: song step
mod Steps; Key: restart on every new note; 1st key: on the first key after
silence). Per step: the held notes are ordered (by pitch, pitch down, as played,
as played down, by velocity, velocity down, chord normalized / as played: the
detected chord completed from its root or from the lowest key), StepType and
KeySelect pick the notes (missing notes per Replace / Transpose missing notes;
Root = root of the detected chord below the lowest key; Fix = Fixed note), then
Octave (bit masks in poly mode), ScaleStep (semitones, or scale steps with Force
to scale), master transpose, force to scale (All notes / Semi-transposed: only
steps with a scale step) and the output wrap apply. Velocity: lane (MIDI ->
FL's 0..128), input, or lane x input; Gate: gate x the lane's multiplier;
randomized velocity (+-64 x amount), gate (+-50%) and start (later, up to half a
step). Rst lengthens the previous step's notes, Tie plays legato (slide, the
previous notes reach the tied one). Chord detection: triads, sevenths, sus and
diminished / augmented templates scored on the held pitch classes.

Not reproduced: MIDI channels (notes carry none), chains / meta-chains, program
change messages, the live "Detected chord" display and the preview keyboard
(live notes reach the engine only), the GATE lane's channel mode. Live notes: inside
Patcher the held chord is processed together at song ticks whenever it changes and every
half bar (Patcher's LiveVfx batch mode); Latch continues for the offline model's one
pattern length after the last release.

## Editor

Layout and colours from the 1.5x screenshot: sequence selector (light combo),
previous / next / dice, Auto scroll and Page lock, page buttons and PAGE, display
mode (Simple: matrix only; Advanced: + lanes; Complete: + settings), the matrix
(white grid, selected notes in `#f16b78`, columns past Steps or with Off dimmed;
click to select, wheel to move; poly key mode toggles bits), step numbers and page
bar, the six lanes in FL's colours (`#fc7482 #c7ffcf #ffa569 #71f8ff #50f29d #ffe45e`)
with drag / wheel cells, Poly / G/CH switches and lane menus (reset, randomize,
shift, copy page to all), the settings sections with labelled value boxes,
Pattern shift buttons (rotate every lane within Steps), the display options
(Octave numbering changes the note names; Scale step range is stored), the
keyboard and the title band. Captions use the system font narrowed (font-stretch)
for BlueARP's condensed face.
