# Keyboard Controller (FL: Fruity Keyboard Controller)

**Status: measured against FL's plugin** (the test host loads FL 2026's own
`Fruity Keyboard Controller_x64.dylib`, plays notes and records the plugin's
`OnControllerChanged` calls). Everything below marked [H] is observed
behaviour of the real plugin; [S] is the plugin's saved state read from FL's
`.fst` files and the plugin's own `SaveRestoreState`.

Files: `src/model/gen/plugins/keyboardctrl.ts` (definition, texts, auto map,
presets), `src/engine/gen/plugins/keyboardctrl.ts` (DSP), `src/ui/plugins/gen/
keyboardctrl/` (editor + the scrolled piano keyboard widget the Envelope
Controller shares), `tests/gen/keyboardctrl.test.ts`, `tests/gen/ctlutil.ts`
(controller test driver).

## Sources

- FL 2026 `Plugins/Fruity/Generators/Fruity Keyboard Controller`: editor form
  (`scratchpad/gen/forms/Fruity Keyboard Controller.txt`), flags
  `0x10600460` = WantNewTick | NoProcess | NoWindow | NewVoiceParams | bit 22 | bit 28
  (not FPF_Generator, no FPF_GetNoteInput: FL still delivers notes through
  `TriggerVoice`), two parameters, two internal outputs named by the plugin
  (`GetName(FPN_OutCtrl)`: "Note", "Velocity"). Info text "Turns keyboard strokes
  into knob tweaks (internal controller plugin)".
- FL's manual page plugins/Fruity Keyboard Controller.htm and its screenshots
  (`KeyboardController.png`, 1.5x) for the editor's look.
- The seven factory presets (`Data/Patches/Plugin presets/Generators/Fruity
  Keyboard Controller`) and the plugin database state (`Plugin database/
  Generators/Controller/Fruity Keyboard Controller.fst`).

## Parameters (FL's two)

| Index | Key | Name | Range | Default | Text |
|---|---|---|---|---|---|
| 0 | attack | Smoothing envelope attack time | 0..256 | 32 (form) | `35ms` at 32 |
| 1 | release | Smoothing envelope release time | 0..256 | 32 (form) | |

Text [H]: `round(T)ms`, T = 1000 ms x (11^(v/256) - 1) / 10: 0, 1, 8, 16, 35, 82,
232, 504, 1000 ms at 0, 1, 8, 16, 32, 64, 128, 192, 256 (the same law as the link
smoothing time). **A new instance starts at FL's plugin database state**: both
times 0 (not the form default 32, which is only what a control reset gives).

## State [S]

Plugin state versions 0 (presets, 501 bytes), 2 (database, 553), 3 (the
plugin's own current format, 554): `int32 version`, (v2+: attack, release),
(v0: one smoothing value that sets both), the key table (v0: 120 float32 for
keys 0..119, v2+: 132 for 0..131; the first key is at index 2 in v0, 3 in
v3), `int32 lo`, `int32 hi` (the key range; `hi` 256 = open), `float32 note
off value`, then flag bytes (the first = "Note off value" / auto release on).
Orchard keeps JSON: `values[132]` (0..1), `lo`, `hi`, `noteOff`, `autoRel`,
`link` (the attack / release link switch, editor level), `key` (current key),
`scroll` (viewport). The editor's view keys survive preset loads (`viewState`).

Factory presets [S]: all seven are Auto maps of a range, with both smoothing
times 0 and the note off value 0: 1 octave (white + black) 60..71, 1 octave
(white only) 60..71, Default 48..71 (white only), Full keyboard (white only)
0..open, Gross Beat - white + black 48..83, Gross Beat - white only 48..108,
To pitch knob (transposing) 12..108 (white + black). `kbAutoMap` reproduces all
132 keys of each to 3e-8.

Auto map [S]: keys below the range 0, above it 1; white + black: (k - lo) /
(hi - lo); white only: the range's white keys spread from 0 to 1, a black
key takes the value of the white key below it; an open `hi` (256) maps up to
key 119. The editor's menu items: Auto map (white + black / white only),
Interpolate (white + black / white only: from and to the end keys' existing
values).

## Behaviour [H]

- **Key range**: the voice of a key outside lo..hi is refused at once (FL:
  `TriggerVoice` returns -1 after the plugin kills it). Default state: C4..B5
  (48..71). A key answers with `values[key]`; the key is the voice's key
  (InitLevels pitch / 100: not affected by the channel's root key, pitch knob or
  fine pitch).
- **Outputs**: `Note` = the value of the last held key; `Velocity` = velocity /
  128 x 65512 / 65536 (1073348608 / 2^30 at 128: FL's range top for this
  output; measured at all 129 velocities to 2e-7).
- **Held keys**: the newest held key is the target. Releasing it returns to the
  key pressed before it (value and velocity). Releasing the last key sends the
  note off value to Note when "Note off value" (auto release) is on, nothing
  otherwise; Velocity keeps its value. Releasing a key under a newer one changes
  nothing. 40 keys can be held at once.
- **Smoothing**: once per song tick (NewTick: PPQ ticks per beat at the
  tempo, also while stopped) each output moves toward its target by 1 -
  0.01^(tick time / T): T is the time to settle to 1%; T = the attack time
  while the target is above the output and the release time otherwise (the
  direction decides: a note off value above the output rises with the attack
  time). Tempo-independent in real time (0.5307 per tick at 130 BPM / T = 35 ms,
  0.2817 at 65, 0.7285 at 260). The first key ever sets the outputs at the next
  tick with no smoothing; before it the plugin sends nothing (a linked control
  keeps its position: `controls()` returns NaN until then).
- Once active the plugin sends its outputs every tick, even when unchanged (FL's
  Link to controller only reacts to changes, so this is not observable here).

## Engine notes

- 'voices' plugin, `noAudio`, `tail = Infinity`. Each key is a voice that lives
  while the key is held. The plugin timestamps its events with
  `GenVoiceParams.frame` (the frame of the block where the channel triggers /
  releases / kills the voice; a shared field added for controllers) and applies
  them in time order between its own tick boundaries (blocks of 128 frames
  hold up to a few ticks at high tempos). Ticks align to the song's ticks while
  it plays (`ctx.pos`) and run free while stopped. A tick sees the notes up to
  its own sample plus one (the test host runs a tick's notes before its
  NewTick; the song's note positions are rounded while ticks are floored).
- Polyphony 128 (the channel's voice count).

## Editor

FL's form (558 x 232) at its coordinates: "Note off value" ring switch with its
horizontal slider, the Auto map button (menu with the four map items), "Value"
slider and the key selector ("for C5", drag / wheel / arrows), "Smoothing"
Attack / Release vertical sliders with the link switch (FL's chain glyph),
and the scrolled keyboard panel (11 octaves of 13 px keys, the key range ruler
you drag, the blue selected key, octave names, a scroll bar; dragging past the
edge scrolls). Colours sampled from FL's screenshot (#3f454a panel, #d7dbe3 /
#9da1a9 in / out of range keys, #8cc4ff selected key, #ffa830 value line).

## Fidelity

- Exact: parameter list, ranges, texts, outputs, plugin database state,
  presets, key table and Auto map, the key range, velocity law, held-key stack,
  note off value, the smoothing law per tick (verified at 7 times and 3
  tempos), the first-key rule.
- Approximate: event timing inside a tick (see above), the editor's drawing,
  the interpolation menu items (the end keys' existing values are used), key
  tests by clicking a key do not send notes.
