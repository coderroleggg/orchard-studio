# Peak Controller (FL: Fruity Peak Controller)

Files: `src/model/fx/plugins/peakctrl.ts`, `src/engine/effects/plugins/peakctrl.ts`,
`src/engine/dsp/flwavetables.ts`, `src/ui/plugins/fx/peakctrl.tsx`,
`src/ui/plugins/fx/controllers/kit.tsx`, `tests/fx/peakctrl.test.ts`.

Sources: the arm64 code of FL 2026's `Fruity Peak Controller_x64.dylib`
(ProcessParam 0x5c580, parameter helpers 0x5c170 / 0x5c370 / 0x5c400 /
0x5c4f0, Eff_Render 0x5ccb0, NewTick 0x5cda0, send helper 0x5d2d0, peak scan
0x3504), FL's wavetable builder in `FLEngine_x64.dylib` (0x43cbc0), the
scratchpad test host (`flfxhost info/sweep`), and a private host build that
calls `NewTick` once per song tick and logs `OnControllerChanged`. With FL's
tick schedule the DSP reproduces FL's sent values exactly (error < 2e-5 of the
range, i.e. a few units of FL's 2^30 resolution) for the default preset, a
ducking setting (negative volume and tension, base), LFO sine / triangle /
square with base, amount, tension, speed and phase, and Ramp.

## Parameters (Tag order, FL's control units)

| # | key | FL name | range / default | law | text |
|---|---|---|---|---|---|
| 0 | base | Peak base level | 0..65536 / 0 | base = v/65536 | `63%` |
| 1 | vol | Peak amount | -256..256 / **179** | a = ±(6^(|v|/256) - 1)·0.4 (179 = 1.0, 256 = 2.0) | `100%`, `-152%` |
| 2 | tension | Peak tension | -128..128 / 0 | k = (1001^(|v|/128) - 1)/10, sign = direction | `-13%` |
| 3 | decay | Peak decay speed | 5..128 / 66 | (10001^(v/128) - 1)·0.0192 per beat | `52%` |
| 4 | lfoBase | LFO base level | 0..65536 / 0 | v/65536 | |
| 5 | lfoVol | LFO amount | -256..256 / 0 | ±(6^(|v|/256) - 1)·0.2 (max 1.0) | `-57%` |
| 6 | lfoTension | LFO tension | -128..128 / 0 | as Peak tension | |
| 7 | lfoSpeed | LFO speed | 200..65536 / 32950 | period = round((1001^(v/65536) - 1)·(PPQ/4)·0.512) ticks, min 3 | `16:00` (steps : 48ths of a step) |
| 8 | lfoShape | LFO shape | 0..4 / 0 | Sine, Triangle, Square, Saw, Random | |
| 9 | lfoPhase | LFO phase | 0..65535 / 0 | phase << 16 | `62%` |

The Default preset (FL loads it on insertion) has VOL = 179; the form's reset
value is 0, the def uses 179 (coordinator rule: Default preset values). State
after the ten parameters: byte Mute, byte Ramp (both off in Default; the manual's
"Mute on by default" is outdated). Factory presets Default, Fast LFO, Randomness
(Ramp on) are in the def. Outputs (FPN_OutCtrl): `Peak+LFO`, `Peak`, `LFO`.

## Behaviour (per song tick; FL calls NewTick PPQ times per beat, also stopped)

- Eff_Render (between ticks): level = max(level, peaks of L and R). FL's peak
  routine takes |x| over whole groups of 8 frames and compares the last n mod 8
  frames of each render call **without** the absolute value (negative samples
  skipped); reproduced per tick-split segment. No -50 dB threshold in the code.
- NewTick: peak = base + a·T(level), T = tension curve (k, sign; `Tension()`),
  level may exceed 1; lfo = lfoBase + l·T((wave[phase >> 18] + 1)/2); phase
  += 2^32 / period (random: one table step per period); send Peak+LFO =
  clamp(peak + lfo), Peak = clamp(peak), LFO = clamp(lfo) at 2^30 resolution,
  only on change; Ramp limits each output step to 2^27 (1/8); then level -=
  decay/PPQ, floored at 0.
- While the song plays the LFO phase is song-locked: phase = phase0·65536 +
  round(song ticks)·increment, set when playback starts, on position jumps and
  when speed / shape / phase change (FPD_SetPlaying / SongPosChanged).
- Wavetables (FLEngine): sine sin(2πi/N); triangle 0 -> 1 at N/4 -> 0 -> -1;
  square +1 then -1; saw **rising** -1 -> 1; noise = MT19937 seeded 19650218,
  u/(2^32-1)·2 - 1 (the research host's tables guess a falling saw).
- Mute zeroes the audio; otherwise it passes unchanged.

## Editor

FL 2026 vector skin sampled from the manual's screenshot: Peak / LFO sober
panels with title tabs, ring knobs (300° sweep, arc from 7 o'clock or from the
top for bipolar knobs, dot pointer, centre tick lit at 0), tension knobs show
the curve, the shape box, the ticked phase knob, the output graph (beat bands,
orange Peak, green LFO, white Peak+LFO over the dark input level, current value
`0.382`; click freezes, holding a Peak / LFO knob isolates its envelope), Ramp
and Mute LED switches.
