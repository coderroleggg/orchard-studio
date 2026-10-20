# Dance (FL: Fruity Dance)

**Status: measured against FL's plugin.** The test host loaded FL 2026's own
`Fruity Dance_x64.dylib`, played notes and read its parameters back, and a copy
of the host (with a helper that drives the song position and captures the
plugin's own character window) recorded which sprite-sheet cell the plugin
shows at which song position. Everything marked [H] is observed behaviour of
the real plugin; [S] is its saved state; [M] is FL's manual. The artwork is not
FL's: "Pippin" and the countdown are drawn by code (src/ui/plugins/gen/dance/art.ts).

Files: `src/model/gen/plugins/dance.ts` (definition, note table, animation and
sprite sheet rules, window geometry), `src/engine/gen/plugins/dance.ts` (the
engine plugin: notes -> parameters), `src/ui/plugins/gen/dance/` (`index.tsx`
the editor, `character.tsx` the character window, `anim.ts` the animation
logic, `render.ts` the canvas drawing, `sheets.ts` sprite sheets and their
storage, `art.ts` the built-in artwork, `widgets.tsx` the form's controls,
`actions.ts` Visible / View settings),
`tests/gen/dance.test.ts`. Shared changes: `GenPluginDef.keyNames` (src/model/gen/types.ts) and its use in
the Piano roll (src/ui/pianoroll/PianoRoll.tsx: the keyboard, note labels and hints show an instrument's key names).

## Sources

- FL 2026 `Plugins/Fruity/Generators/Fruity Dance`: the editor form
  (`scratchpad/gen/forms/Fruity Dance.txt`: SynthPanel 558 x 224, the character's
  own "OSD form" and its menu), class `TTestPlug`, flags `0x10600451` =
  Generator | GetNoteInput | NoProcess | NoWindow | NewVoiceParams | bit 22 | bit 28,
  seven parameters (`scratchpad/fx/host/gen/flags/Fruity_Dance.log`), the
  Artwork folder (Dance.png 1760 x 2560 = 8 x 10 cells of 220 x 256, Dance.txt, Count.png
  800 x 100 = 8 cells, Count.txt). Info text: "A dancing FL-chan; a visual, not a sound source."
  No factory presets.
- FL's manual page plugins/Fruity Dance.htm [M] (controls, the sprite sheet rules,
  "different moves are associated with a range of notes"; it names no keys, no
  timing and does not mention Freestyle) and its old-style screenshot.
- The test host (`flfxhost render "Fruity Dance" --notes ...`, `--param`,
  `--state`, `--save-state`, `--preset <sprite sheet>` = a file dropped on the
  plugin, `sweep`), and a copy of it with: a state dump after the notes, a
  transport driver (the host's playback time in beats advances in real time, or
  jumps, or stands still; the plugin reads it with `FHD_GetPlaybackTime`), timed
  parameter / note events, a synthetic mouse press / drag, and a capture of the
  plugin's character window (an NSWindow of the host process) every few ms. The
  captured frames were matched against the cells of FL's own sprite sheet to read
  off the frame shown (distances 0.1 of 255 = an exact cell); the sheet itself
  was only read for that, never copied.

## Parameters (FL's seven)

| Index | Key | Name | Range | Default | Text |
|---|---|---|---|---|---|
| 0 | move | Dance move | 0..9 | 2 (Stepping) | the move names, see below |
| 1 | mirror | Mirror character horizontally | 0..1 | 0 | none |
| 2 | visible | Show window | 0..1 | 1 | none |
| 3 | blend | Motion blending | 0..256 | 64 | none |
| 4 | speed | Speed multiplicator | -96..96 | 0 | none |
| 5 | x | X coordinate | -8192..8192 | random 400..800 at creation (Orchard: the control default is 600, a new instance picks 400..799 at random as FL does) | none |
| 6 | y | Y coordinate | -8192..8192 | 500 | none |

- Texts [H]: `GetName(FPN_ParamValue)` returns names for parameter 0 only: 0 Freestyle,
  1 Waiting, 2 Stepping, 3 Jumping, 4 Zombie, 5 Waving, 6 Hula, 7 Windmill,
  8 Zitabata, 9 Dervish; "" for 1..6 (the plain number is shown). With a loaded
  sprite sheet the list is "Freestyle" + the sheet's moves (below) and the range
  of parameter 0 shrinks to their count (Orchard keeps 0..9: values beyond the
  list play the last move, as the plugin does with out-of-range values).
- The plugin stores whatever it is given (no clamping: 15, -1, 999, 99999 read
  back unchanged); FL's host clamps to the range first.
- Form: the combo's `DefaultValue` is 1; the plugin starts at 2 (Stepping). Hints
  from the form: Dance move, Mirror character horizontally, Synchronize changes with
  song, Show window, Set window clickable, Keep window on top, Don't minimize window
  along with application, Load sprite sheet..., Motion blending, Speed multiplicator,
  Bevel size / reflection opacity.
- The default X changes with every instance (423..793 in 40 samples, equal within a
  second: a `Randomize` / `Random` at creation); Y is always 500.

## State [S]

41 bytes (`SaveRestoreState`): `int32 version` (always written as 2; any value is
read), `int32` move, mirror, visible, blend, speed, x, y, `int32 reflect` (0..256, clamped
on load), 4 bytes: **Sync changes, Solid, On desktop, Keep in front** (stored as
given, tested one at a time: byte 1 = Solid sets the window to ignore the mouse,
byte 0 = Sync defers changes to the cycle's end, byte 3 sets the window level of
the window created from the state), then a Pascal string (1 length byte) with the
sprite sheet's file path (empty = the built-in FL Chan sheet). A path in a state
file is not taken (the plugin writes one only after a sheet has been loaded).
Orchard keeps JSON keys: the seven parameters by key, `sync`, `solid`, `front`,
`desktop`, `reflect`, `sheet` (`pippin` | `countdown` | `user`), and for a user
sheet `sheetName`, `sheetNames` (its row names), `sheetSize`, and the image
as `sheetData` (data URL, re-encoded, up to 500 KB: saved with the project and
the autosave) or, for larger sheets, `sheetKey` (the file in the browser's file
store, IndexedDB `orchard-dance`, like the Video Player's file; another browser
shows the built-in character).

## Notes [H]

FL calls `TriggerVoice` for every note; the plugin reads **only the key**
(InitLevels.Pitch / 100 = the played key; the fine pitch of a note is not part of
it, the channel's root note, pitch knob and volume do not move it), changes its own
parameters, calls `Voice_Kill(tag, KillHandle = 0)` inside the call and returns
-1 ("no voice"): no voice is ever rendered, the host drops the note off
("note-off-dropped"), the plugin is FPF_NoProcess (no render call at all) and does not
take MIDIIn. It does **not** call `OnParamChanged` (the host is not told; FL's
editor follows through the plugin's own form). Everything else about a note is
ignored: velocity 0..255, note colour 0..15, pan, Mod X / Y, release velocity, note
length 1 ms..3 s (checked on key 61 from a start state where it changes the move).

Full table, every key 0..131 played from two start states (move 5, mirror 0, shown;
move 6, mirror 1, hidden; blend, speed, X, Y also set to unusual values: no key changes
those): **22 keys do something, the other 110 nothing** (also not the 4 switches or
the reflection).

| Keys (FL numbering, C5 = 60) | Effect |
|---|---|
| 59 B4 .. 68 G#5 | Dance move = key - 59 (59 Freestyle, 60 Waiting, 61 Stepping, 62 Jumping, 63 Zombie, 64 Waving, 65 Hula, 66 Windmill, 67 Zitabata, 68 Dervish), **Mirror off** |
| 48 C4 .. 39 D#3 | Dance move = 48 - key (48 Freestyle, 47 Waiting, 46 Stepping, 45 Jumping, 44 Zombie, 43 Waving, 42 Hula, 41 Windmill, 40 Zitabata, 39 Dervish), **Mirror on** |
| 53 F4 | Show window = 0 (hide) |
| 54 F#4 | Show window = 1 (show) |

**The table follows the loaded sprite sheet** [H] (measured with sheets of 6, 3, 2 and 1 row(s) and
Count.png): the keys reach Freestyle plus the sheet's rows but the last one (the Held row): a 6-row sheet
(Alpha..Echo, Held) answers keys 59..64 and 48..43 only, a 3-row sheet 59..61 / 48..46, and a one-row sheet
(its single row is a move in the combo, but has no key) only 59 and 48 (Freestyle); 53 / 54 always. A key
beyond them does nothing. FL's range grows with a larger sheet (12 names: keys 59..70 and 48..37 reach moves
0..11); Orchard keeps the parameter's range 0..9, so a sheet's first 9 moves are selectable and answer the keys.

**Key names** [H]: the plugin names its keys for the Piano roll (`GetName(FPN_Semitone)`): "Freestyle", "Waiting",
"Stepping", ... "Dervish" on keys 59..68, "M Freestyle", "M Waiting", ... "M Dervish" on 48..39 ("M" =
mirrored), "Hide" on 53 and "Show" on 54, nothing on other keys; with a loaded sheet the row names
("Alpha".. / "M Alpha"..) on as many keys as the table reaches. This independently confirms the sweep.
Orchard: `GenPluginDef.keyNames(params)` (`danceKeyNames`) and the Piano roll's keyboard, note labels and hints show
them (shared change: src/model/gen/types.ts, src/ui/pianoroll/PianoRoll.tsx).

In Orchard the engine plugin applies the table at the note's sample and reports the changes with
`takeStateChanges()` (`move`, `mirror`, `visible`, only values that changed, the last
value of a block wins): AudioHost mirrors them into the project, so the editor and the
character window follow. A new note state is not an undo step.

## Animation [H]

All measured from the plugin's window: the displayed cell was identified for
hundreds of captures per configuration.

- **Frame law.** The plugin polls the song position in beats (`FHD_GetPlaybackTime`,
  format 0) about 30 times a second. While the song plays the frame is a function of the
  position alone: `frame = floor(beats x 4 / (1 + |speed| / 32)) mod 8`. Each frame lasts
  a quarter of a beat and the 8-frame cycle two beats at speed 0 (4 beats at +-32, 8 at
  +-96); all nine moves, the Held row and a one-row sheet (Count.png) alike. The phase is
  absolute (starting the song at beat 3.3 shows frame 5; position 0 = frame 0; also at
  beat 12345.6). Speed is symmetric (-s and +s identical, no reversal); a speed change
  recomputes the frame from the position (it jumps). Frame durations at speed 1, 4, 12, 24, 40, 80:
  0.2578, 0.2813, 0.3438, 0.4375, 0.5625, 0.875 beats (0.25 (1 + s / 32)). The plugin's
  reading lags the song by one timer tick (about 15-50 ms).
- **Speed quirk.** The law above holds for
  the speed the plugin was loaded with and for every change made from a speed that is not positive. A change of the Speed
  parameter **from a positive value** (to any other value, a negative one included) switches the plugin to
  the opposite law: `frame = floor(beats x 4 x (1 + |speed| / 32)) mod 8`, i.e. FL's character then dances
  *faster* the larger |speed| is (frame durations 0.25 / (1 + |s| / 32) beats; the phase is still absolute). The mode is
  decided by speed changes alone: a later change from a speed that is zero or negative brings the normal law
  back, while changing the move, Mirror, Blend or the window, or writing the speed it already has, leaves
  it alone. Measured with chains of speed changes (+8, +16, +24, +32 and -8 ... -32 steps, mixed chains and a
  chain started at +24), the frame durations of each stretch classified as slower or faster than the base.
  `danceSpeedInverse(previous, next)` is the model's rule (`previous > 0 && next !== previous`), `dancePhase` and
  `danceFramesPerBeat` take it as an argument, and `DanceAnimator` keeps the mode.
- **Stopped.** `FPD_SetPlaying(0)`: the character stands on frame 0 of its move
  whatever the position (in FL's sheet frame 0 of Waiting and Stepping is the neutral standing pose, the other
  rows start in their own poses; Pippin's frame 0 is neutral for every move). With the playing flag set (or never set) it shows the frame of the position
  even if the position stands still. (The brief assumed the cycle runs free at the project
  tempo when stopped: it does not.)
- **Motion blending** (0..256) crossfades the current cell into the next one (the first cell
  of the row after the last; the next cell is drawn from the target move at the end of a
  cycle) linearly, as a straight mix (weights sum to 1): over the last B = blend / 256 of each
  frame, reaching the full next cell at the frame's end: t = clamp((frac - (1 - B)) / B, 0, 1)
  (blend 256: t = frac; 128: the last half; 64: the last quarter; 0: none; fitted weights
  agree within the plugin's timer lag, about 0.03 frame, for blends 64, 128 and 256).
- **Sync changes** on, song playing: a new move or Mirror state (from the editor, an
  automation or a note) is shown at the end of the running cycle, and the last frame's
  crossfade already blends into the first frame of the new move; off, or stopped: at once
  (the same frame index in the new row). Speed, Blend and the window changes apply at once.
  **The end of the cycle is the position inside the cycle going back.** The plugin compares the
  position inside the 8-frame cycle (`phase mod 8`, continuous, not the frame index) with the last poll's and
  applies the pending move and Mirror state whenever it is lower. In ordinary playback that is the wrap from
  frame 7 to 0, but a **Speed change moves the phase** (it is a function of the song position and the speed), so a
  speed change that lands earlier in the cycle applies the pending change at once and one that lands later leaves it waiting
  for the next wrap. Measured at 30 bpm with a move (row 1 -> 5) written early in the cycle and a speed change later
  (the Mirror state behaves like the move; Blend, Visible and X / Y writes never apply a pending change):

  | speed change | phase before -> after (cycle position) | pending change applied |
  |---|---|---|
  | 0 -> 8 at beat 3.0 | 12 -> 9.6 (4.0 -> 1.6) | at once |
  | 0 -> 32 at beat 3.0 | 12 -> 6 (4.0 -> 6.0) | at the wrap (beat 4) |
  | 0 -> 32 at beat 3.8 | 15.2 -> 7.6 (7.2 -> 7.6, same frame 7) | at the wrap |
  | 0 -> 32 at beat 4.45 | 17.8 -> 8.9 (1.8 -> 0.9) | at once |
  | 0 -> 64 at beat 3.1 | 12.4 -> 4.13 (4.4 -> 4.13, same frame 4) | at once |
  | 0 -> 64 at beat 2.9 | 11.6 -> 3.87 (3.6 -> 3.87, same frame 3) | at the wrap |
  | 0 -> 64 at beat 3.45 | 13.8 -> 4.6 (5.8 -> 4.6) | at once |
  | 8 -> 16 at beat 3.4 (fast mode) | 10.9 -> 20.4 (2.9 -> 4.4) | at the wrap (beat 4) |
  | 12 -> 20 or -20 at beat 2.2 (fast mode) | 6.4 -> 14.3 (6.4 -> 6.3, same frame 6) | at once |

  Replays of ten event timelines (moves, mirror toggles and speeds of every sign written at hand-picked or random
  times, 12 to 15 s long, 100 ms captures) through the animator reproduce every row and mirror change at the
  captured time, Freestyle's random rows aside (the frames themselves agree except for single-capture jitter at the frame
  boundaries, with the plugin's position read about 0.02 beat behind the capture's).
- **Freestyle** (move 0): a random one of the moves after the first, for each
  cycle (changes at the cycle's end; never Waiting, the idle move; rows 1..8 of the nine in
  160 measured cycles with repeats; on a sheet of M move rows rows 1..M-1; with 1 move
  row 0). Different every run (Delphi `Random`); Orchard uses `Math.random`.
- **Held**: pressing the mouse on the character shows the sheet's last row at once on the
  running frame (no Sync), release returns at once; dragging moves the window and updates X /
  Y. The Held row is **not mirrored** (with Mirror on the held cells were matched unflipped) and crossfades
  **always over the last two thirds of each frame**, whatever the Blend slider says (same ramp at blend 0, 16, 32,
  64, 128 and 256: weight of the next cell 0 until a third of the frame, 0.27 at half, 0.84 at 0.9). It also
  **ignores the Speed slider** (at speed 32 a held frame still lasts a quarter beat).

## Sprite sheets [H][M]

- A sheet is 8 cells wide; its **row names file** (text, one name per line) names the rows
  **and sets their number**: cell = width / 8 by height / names (measured on a 312 px tall image
  with 12 / 7 / 6 / 4 / 3 / 2 names: 26 px cells / refused / 52 / 78 / 104 / 156; a 156 px tall image
  with one name: one 156 px row); a size that is not a
  whole number of cells (height not divisible by the names, width by 8) is refused and the
  previous sheet stays; without a text file the sheet is refused. The last name is the Held
  row; the moves are the names before it (a single name is both the move and the held pose);
  Dance move = "Freestyle" + the moves; a move beyond them plays the last move row.
- Sprites are @2x: the window shows a cell at **half its pixel size** whatever the display (a
  220 x 256 cell = 110 x 128; Count.png's 100 x 100 = 50 x 50; verified on a 1x display).
- The folder button loads a sheet (the plugin then writes its path into its state); FL ships
  FL Chan (Dance.png) and Countdown (Count.png: a bold digit then its pale ghost for 1, 2, 3, 4).
- Orchard: the folder button's menu lists the built-in Pippin and Countdown and "Load sprite
  sheet..." (file chooser taking the image and its .txt together, PNG / JPG / GIF / BMP / WebP), and
  files can be dropped on the editor or the character. A sheet without a .txt is accepted with
  rows guessed from square cells and named "Move 1.." plus "Held" (FL refuses it).

## Character window [H]

- A frameless, transparent window (class CustomWindow, floating level while Keep in front)
  of the cell size / 2 (110 x 128) plus, while Reflect > 0, a reflection area below it of
  round(height / 3) (43 px; 5 under 16). Reflect 0 = no reflection area (the cell stays in place).
- Reflection = the cell's last rows flipped (the row under the feet shows the cell's last
  row) with the same colours, opacity falling linearly from Reflect / 256 at the feet to 0 at its
  bottom (at 2x: 0.854 .. 0.020 for Reflect 256, 0.212 .. 0.0 for 64: alpha = Reflect/256 x (1 - y/86)).
- **X, Y** are in doubled points on macOS (the coordinates of the 2x screen): the window's horizontal
  centre = X / 2 and the bottom of the cell (the feet) = Y / 2 from the top left of the screen
  (X 600, Y 500 put the 110 x 128 window's left edge at 245 pt and the feet 250 pt below the top;
  Orchard: left 545, top 372 in CSS px). FL keeps 16 px of the window on screen at the left, right
  and bottom and never moves it above the work area's top (X = -100 and -8192 stop at left = -94 for the
  110 px window; Y <= 322 stops at the top, 33 pt below the screen's top = the menu bar; a Y beyond the
  bottom stops 16 px above the screen's bottom edge). Orchard uses CSS px 1:1 in the browser window
  and its top is the viewport's top.
- Dragging with the mouse (press and hold) moves the window and writes X and Y (X +200, Y +100 for a
  +100 / +50 point drag).
- **Greeting.** When the window first appears (plugin creation / project load, not when it is hidden and
  shown again with Visible or keys 53 / 54) a second small window (25 x 20 pt, level 101, ignores the mouse) shows
  "Hi !" in bold white with a black outline over the top of the character (its left at the character's left + 44 pt,
  5 pt above the window's top edge): fully opaque for about half a second, then fading out linearly over about 0.7 s
  while drifting 7 pt up, gone after about 1.2 s. (The manual's screenshot shows it.) Orchard draws the same
  text in the overlay (`Greeting` in character.tsx).
- Solid off: the window ignores the mouse (`ignoresMouseEvents`). Keep in front: floating window
  level. On desktop: no visible effect on macOS. Visible (parameter 2 / the menu item) shows or
  hides it. The window's menu (the OSD form): "-State" (hidden header), Visible, a separator, View settings.

## Editor

FL's form at its coordinates (SynthPanel 558 x 224, form colour 3880753 = #31373B,
sampled panel #3f454a like the Keyboard Controller's screenshot): the label "Dance move"
(7, 12, 76 x 30, right-aligned, bold), the combo AnimSel (88, 12, 180 x 30, colour #262B2F),
the folder button (272, 12, 30 x 30, #2D3236), check boxes 140 x 23 at x = 86: Visible
y 58, Mirror horizontally 81, Sync changes 116, Solid 139, Keep in front 162, On desktop 185;
captions "Blend", "Speed", "Reflect" at y 19 (54 x 15) over the vertical sliders (54 x 185 at
y 30; x 339, 403, 483). Controls are the dark Keyboard Controller family (ring check boxes with a
glowing disc, sliders with a metal cap and an orange line, from the middle for the bipolar Speed).
Mirror and Visible are parameters (automation / link menu, undo), Sync, Solid, Keep in front, On
desktop and Reflect are plugin state (undoable edits). The combo also takes the wheel; right-click
gives the automation menu.

## Orchard's implementation

- The character window is a `position: fixed` overlay in `document.body`, mounted by the
  editor module's `Persistent` part for every channel that holds the plugin (editor open or not);
  it renders nothing while Visible is off and unmounts with the channel (plugin replacement too).
  Solid off = `pointer-events: none`; Keep in front = above all app windows (z 9000), otherwise it
  joins the window stack (raised when clicked, below windows opened later). The right-click menu has
  Visible and View settings (opens the channel settings window); files dropped on it load a sheet.
- The animation runs in the browser (`requestAnimationFrame`) from the transport: `currentTick()` /
  project ppq = beats (so it includes the audio latency compensation), `live.playing`; the engine
  does not need the position (it only applies the notes). `DanceAnimator` (anim.ts) holds the Sync /
  Freestyle / Held logic; the drawing mixes cells with `lighter` compositing (a linear mix of the
  premultiplied cells, as measured).
- Sync changes has a grace window here: a move / mirror change that reaches the page within 120 ms after a cycle
  began counts as made before it. FL's plugin gets a note slightly ahead of the audible position; ours is reported
  back by the engine (AudioHost batches the reports every 33 ms) slightly behind it, and a note on the downbeat must
  still switch at that downbeat instead of one cycle (two beats) later.
- The page's song position is re-anchored by every engine status report, so it can step back by a few ms of
  jitter, which for FL's smooth position would end the cycle: the animator takes backward steps below 100 ms (in beats at the
  project tempo) for noise and holds the position; larger steps (a loop, a seek) are real jumps.
- The tests (tests/gen/dance.test.ts) pin the whole note table, the voice behaviour, the state
  changes reported through a real engine, the frame / speed / blend laws, Sync, Freestyle, the sheet
  layout rules and the window geometry with the numbers above.

## Fidelity

- Exact [H]: parameter list, ranges, plugin default, value texts, the note table (all 132 keys),
  voice handling, the frame / speed / blend laws, the speed quirk (the faster law after a positive speed), Sync
  changes including the crossfade into the new move and the end-of-cycle rule (a speed change that lands earlier in the cycle
  applies the pending change), the stopped state, Freestyle's range, Held, sprite sheet layout and name rules, sprite
  size, window size, reflection law, X / Y meaning and edge rules, the state's fields.
- Approximate: the artwork (original: Pippin instead of FL Chan, a countdown at 200 px cells shown
  at 100 x 100 instead of FL's 50 x 50, frame 0 of every move neutral), Freestyle's random numbers,
  the default X (random in FL), X / Y in CSS pixels, stacking with the app's windows instead of the
  desktop's, "On desktop" (no meaning in a browser: kept as state), the 120 ms grace of Sync changes and the 100 ms jitter filter of the position, loading by file chooser / drop
  with guessed row names when no .txt comes along, the user sheet's storage, the plugin's one-tick lag
  (not reproduced), the range of the move parameter with a custom sheet (always 0..9: only a sheet's first 9 moves are selectable).
