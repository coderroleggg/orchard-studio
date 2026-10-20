# Scratcher (`scratcher`)

FL's Fruity Scratcher: a vinyl turntable that plays a **loaded sample**
(the manual calls it a "sample effect"); it does not scratch the incoming
audio. Sources: form `Fruity Scratcher.txt` (247 x 303), manual, two
screenshots, and the FL binary through `flfxhost`.

## Parameters (FL Tags, texts from GetName)

| # | key | name | range / default | text |
|---|---|---|---|---|
| 0 | pos | Wave position | 0..30000 / 690 | v/30000, 6 decimals ("0.023000") |
| 1 | mute | Mute | 0..1 / 1 | 0 "On" (muted), 1 "Off" |
| 2 | speed | Turntable speed | 0..100 / 50 | v/100 + " x" ("0.500000 x") |
| 3 | acc | Turntable acceleration | 0..100 / 25 | "%" |
| 4 | pan | Pan | -128..128 / 0 | "%" |
| 5 | vol | Volume | 0..255 / 199 | "%" (199 = 78%) |
| 6 | hold | Turntable hold | 0..1 / 0 | Off / On |
| 7 | sens | Turntable sensitivity | 0..100 / 50 | "%" |
| 8 | transport | Transport | -1..1 / 0 | Reverse / Pause / Forward |
| 9-12 | sm1..sm4 | Smooth 1..4 | 0..1000 / 500, 908, 999, 400 | 6 decimals |
| 13 | rot | Rotations | 0..18 / 9 | v/18 ("0.500000") |

No factory presets (no preset folder); defaults = constructor state.

## Measured facts

- With no sample loaded the input passes unchanged (sine through the
  plugin: identical output, also with Mute on). The manual's DVS section
  implies that normally the input is passed and the turntable added; with a
  time code the input is intercepted.
- State: int32 version, 14 normalised floats, then an AnsiString (int32
  length) with the sample path, then flags. On load the plugin calls the
  host's `LoadSample(path, needed format = 16-bit stereo 44.1 kHz PCM)` and
  `GetSampleData`. A private host build answering those calls (and calling
  `NewTick`) still produced no turntable output, so the platter physics could
  not be measured (it probably runs from the editor's timer).

## DSP (designed from the manual)

- Output = input + record x volume x pan (FL linear balance), gains smoothed
  10 ms; Mute silences the record only.
- Platter: position (sample frames) and velocity (1 = normal speed). Motor
  target = transport x speed factor (2 x v/100: 1x at the default, as the
  manual states, despite the "0.5 x" text); the velocity follows it with a
  one-pole whose time constant is 2 s .. 20 ms (acceleration 0..100%,
  exponential); Hold brakes to a stop (60 ms or faster).
- Scratching: a change of Wave position grabs the record; the position
  follows the hand through a damped spring (2..60 Hz from Smooth 1, damping
  0.3..1 from Smooth 2) on a smoothed target (Smooth 3 = retention per
  1/48000 s); a pause shorter than 20..220 ms (Smooth 4) keeps it grabbed.
  On release the record keeps its momentum and the motor takes over.
- The record loops; cubic interpolation; sample rate conversion by ratio.
- DVS (time code selected): relative mode. The input's quadrature carrier
  (Serato 1 kHz, Traktor Mk1 2 kHz, Mk2 2.5 kHz, CD 1 kHz) gives speed and
  direction from the unwrapped phase of atan2(R, L); below a level threshold
  (lower with RIAA preamp) the record stops. Absolute time code position is
  not decoded. The input is muted, as in FL.

## Editor

Form layout at 1:1; the record turns with the playback position (the sample
spans `Rotations` turns), drag it vertically to scratch (one platter height
= one turn at 50% sensitivity), right-click for automation; the tone arm's
pivot is the Rotations control (FL's dummy wheel); transport selector;
browse / drop an audio file; waveform with the play position (drag to
scratch); gear = time code page (type, RIAA, signal scope); 2x button
doubles the window. Turntable art is drawn (no FL artwork).

## Shared infrastructure (local workaround)

The editor module registers the loaded sample in the project's pool (saved
with the project) and sends its engine copy (`SC_SAMPLE_PREFIX` id) from a
project listener, for every Scratcher including ones hosted in Patcher
(`allFx`). The offline WAV export gets the same audio through
`registerEngineSamples` (src/audio/engineSamples.ts), so exports include the
record.

## Open questions

FL's exact platter physics (acceleration curve, smoothing filters, what
Rotations does), the speed mapping, the volume law, time code positions.
