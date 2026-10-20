# Delay (FL: Fruity Delay, legacy)

Sources: FL's form (500 x 105), manual, factory presets, the plugin's own strings and FL
Studio 2026's `Fruity Delay_x64.dylib` measured with `flfxhost` (renders, `--at` changes,
44.1 / 48 kHz). Hidden in menus (legacy), kept loadable. Files: `src/model/fx/plugins/delay.ts`,
`src/engine/effects/plugins/delay.ts`, `src/ui/plugins/fx/delay/`, `tests/fx/delay.test.ts`.

## Parameters

| # | key | FL name | raw | default |
|---|---|---|---|---|
| 0 | input | Input | 0..1024 | 338 |
| 1 | feedback | Feedback | 0..1024 | 512 |
| 2 | cutoff | Cutoff | 0..1024 | 1024 |
| 3 | tempo | Tempo | 0..1024 | 0 (Auto) |
| 4 | steps | Steps | 1..16 | 3 |
| 5 | mode | Mode | 0..1024 | 0 |

FL reports empty value texts. The editor labels use the plugin's strings: "Auto bpm" /
"74 bpm", "%d notes" (also "1 notes"), "Normal" / "Inv. stereo" / "Ping pong"; input,
feedback and cutoff hints show percent. Defaults = Default preset; the 6 factory presets
are in the def. The horizontal bars beside INPUT / FEEDBACK / CUTOFF show (and drag) the
same parameters.

## Mappings (measured, exact)

- Input gain = raw / 1024 into the delay; the dry signal always passes at unity.
- Feedback gain = 0.99 x raw / 1024 per repeat.
- Cutoff: one-pole low-pass in the loop (`y += a (x - y)` before the line),
  a = (21^(raw/1024) - 1)/20 at every sample rate (Delay 2 scales it by 44.1 kHz / sr; this
  one does not). 1024 = open, 0 = silent echoes.
- Tempo: 0 = the song tempo, otherwise round(60 + raw x 220 / 1024) BPM (60..280; "Half step
  at 140" is 1 step at 280).
- Delay = steps x round-half-even(sr x 60 / (4 x tempo)) samples (4 steps at 120 BPM =
  22048, not 22050).
- Mode = min(2, raw x 3 div 1024): normal, inverted stereo (left line to the right output),
  ping pong (crossed feedback, outputs swapped: the first echo of a left input is on the right).

## Behaviour

- Input and feedback ramp per processing block: linear toward the target across the block,
  at most 0.001 x 44100 / sr per sample; each sample uses the value before it is stepped.
  Cutoff and mode switch at once.
- Any change of the delay length (steps, tempo wheel, song tempo) rebuilds the buffer: the
  next echoes start from silence (the manual's "echoes may break up with tempo automation").

## Fidelity

Against FL renders: defaults -164 dB, Ambient -148, Lowpass -117, Half step at 140 -132,
97 BPM -152, 48 kHz -149, input / feedback / cutoff / mode changes -125, steps and tempo
changes -159..-165 dB. The editor follows the form's geometry with the look of FL's manual
screenshot (dark skin, pink value arcs).
