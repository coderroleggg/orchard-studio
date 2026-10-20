# Voltage Controller (FL: Fruity Voltage Controller)

**Status: parameters, texts, defaults and the form are measured; the signal levels are approximated.** The plugin's parameter list, value
texts, plugin database state and editor form come from FL 2026's own plugin (test host `info` / `sweep`, the `.fst` of the plugin
database, the extracted form). The test host's generator rendering was lost before the output levels could be recorded (the
working directory it lived in was cleared), so everything marked [A] below follows FL's manual and the plugin's own structure, not a
measurement. Re-measure with the host before relying on it for real hardware: sample level per source (and the full-scale mapping
of the three voltage ranges), the gate voltage, the pulse length default and the held-value rules.

Files: `src/model/gen/plugins/voltagectrl.ts`, `src/engine/gen/plugins/voltagectrl.ts`, `src/ui/plugins/gen/voltagectrl/index.tsx`,
`tests/gen/voltagectrl.test.ts`, `ctl-ui.test.ts`.

## Plugin facts [H]

Flags `0x10610431` = Generator | GetNoteInput | WantNewTick | NoWindow | CanSend | NewVoiceParams | bit 28; `Gen_Render` generator (notes through
`TriggerVoice`, mixed by the plugin), DefPoly 1, no factory presets, 16 parameters, no internal controller outputs. Category Misc
("Interfaces with external Control Voltage (CV) hardware"). Editor form: SynthPanel 302 x 472.

| Index | Key | Name | Range | Default | Text |
|---|---|---|---|---|---|
| 0..7 | `ofs0..7` | Left / Right offset, main out / out 2 / out 3 / out 4 | 0..65536 | 32768 | `00.000000 Volt(s)` |
| 8..15 | `scl0..7` | Left / Right scale, main out / out 2 / out 3 / out 4 | 0..65536 | 65536 | `01.000000` |

Offset texts [H, default state]: raw 0 = `-10.000000 Volt(s)`, 8192 = `-07.500000`, 16384 = `-05.000000`, 24576 = `-02.500000`, 32768 =
`00.000000`, 49152 = `05.000000`, 65536 = `10.000000`. Scale texts [H]: (raw - 32768) / 32768, `-01.000000` .. `01.000000`. Under the
+/- 5 V range the offset's volts are halved [A].

Plugin database state [S] (103 bytes): version 1, eight offsets (32768), eight scales (65536), eight source bytes `0 1 3 5 6 7 9 9`, five
zero ints (note colours, polarities), a byte 24 (clock resolution: 24 PPQ) and three zero bytes (ON and the menu choices). With the
combo order **Pitch, Gate, Trigger, Velocity, Volume, Panning, Mod X, Mod Y, Clock, None** [A: order inferred from the defaults] a new
instance is: Main = Pitch + Gate, Out 2 = Velocity + Panning, Out 3 = Mod X + Mod Y, Out 4 = None + None, every colour 1, bipolar
polarity, +/- 10 V, 1 V/Oct, 24 PPQ, **output off**.

Form [S]: ON check box (17, 4), settings button (259, 4), title "Fruity Voltage Controller" (30, 34), per side a source combo (33 / 193, 110;
75 x 23), a note colour digit wheel 1..16 (113 / 158, 110), the offset wheel (33 / 178, 154; 90), a polarity switch (60 / 205, 254), the
scale wheel (38 / 183, 315; 80), the labels "Left voltage" / "Right voltage" (y 408), the output tabs (18, 441; 225 x 26) and the target mixer
track digit wheel (248, 440; -125..125, "..." for none). The settings menu: Pitch scale (1 V/Oct, 1.2 V/Oct, Adjust scaling factor...), Voltage
range (+/- 5 V, +/- 10 V, 0 to 10 V), Clock resolution (2, 4, 8, 12, 16, 24, 32, 48, 64, 96 PPQ), Set trigger/clock pulse length..., Automap
extra outputs. A dialog "Warning!" (continuous DC signals) with "Don't show again" and OK is shown when ON is first switched on.

## Behaviour (manual + structure) [A]

- Channel output = scale x (source + offset), in volts; Left / Right of Main, Out 2, Out 3, Out 4 are eight such channels. The polarity switch
  applies to the offset only: unipolar lets it only add (a negative offset counts as 0), bipolar adds or subtracts.
- Sample level = volts / full scale, clipped to the range (+/- 5 V: full scale 5 V, else 10 V; 0 to 10 V clips below 0). Nothing is sent
  while ON is off (the plugin generates DC only when enabled).
- Sources: **Pitch** `key + pitch slide` x scale / 12 volts (1 V/Oct, 1.2 V/Oct or a custom factor; C0 = 0 V), held after the note off;
  **Gate** full scale while the note is held; **Trigger** a pulse at the note on (default 5 ms); **Velocity** velocity / 127 of full scale;
  **Volume** the voice's volume level (velocity scaled by the channel's volume); **Panning**, **Mod X**, **Mod Y** -1..1 as +/- full scale
  (0..full scale in the 0 to 10 V range); **Clock** a pulse every 1 / resolution of a quarter note while the song plays (also at its
  start); **None** 0 V (a fixed voltage through the offset). Held values follow the note's live levels while it sounds (pitch slides,
  Mod X / Y) and stay after it ends.
- A channel follows the notes of its colour (1..16); a note of a colour no channel follows gets no voice. The newest matching note is the
  channel's current note; a legato hand-over keeps the gate high.
- Main goes to the channel's mixer track; Out 2..4 go to the track at their target offset (0 = not routed) or, with Automap, to the next three
  tracks (`GenContext.out`).

## Engine / editor

'voices' plugin with `levels` untouched (the DC is written by `render`, so the channel's volume and pan do not scale it), `tail = Infinity`,
sample-accurate gate / trigger edges through `GenVoiceParams.frame`, `monitor()` reports every channel's voltage for the "Left / Right voltage"
readouts. The editor follows the form above with the kit's wheels (accent `#b9d5ff`, the form's digit colour); the settings are plugin state (not
automatable parameters), as in FL.
