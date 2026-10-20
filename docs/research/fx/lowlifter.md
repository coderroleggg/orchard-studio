# Low Lifter (`lowlifter`)

FL Studio 2026 "Low Lifter" (Image-Line; DSP by Dario Sanfilippo, UI by Miroslav Krajcovic).
Category Misc. Editor 680 x 280. Measured on FL's binary with `flfxhost` (48 / 44.1 / 96 kHz).

## Parameters

| # | key | FL name | default (Default preset) | value law (x = float32(v / 10000)) |
|---|---|---|---|---|
| 0 | enabled | Enabled | On | off = dry path only (same as dry/wet 0) |
| 1 | dryWet | Dry/Wet | 10000 | `round(float(x*100))%`, linear crossfade |
| 2 | lowGain | Low band gain | 4999 (0 dB) | `132 x^(1/7.275) - 120` dB, `-inf` at 0 |
| 3 | slope | Harmonics decay slope | 6993 (-6.53 dB) | `60 (x^(1/3.105) - 1)` dB = w |
| 4 | lookahead | Lookahead | On | 10 ms look-ahead limiter (latency) or instant |
| 5 | invert | Invert harmonics polarity | Off | negates the whole low band |
| 6 | preGain | Pre-shaping boost | 4998 (9 dB) | `18 x` dB (`x*18` printed in double) |
| 7 | diffMix | Diffuser mix | 0 | x, crossfade undiffused / diffused |
| 8 | diffDepth | Diffuser coefficient | 5000 (0) | `float(0.99) * (2x - 1)` |
| 9 | highGain | High band gain | 10000 | `120 (x^0.2 - 1)` dB, `-inf` at 0 |
| 10 | crossover | Crossover cutoff | 8920 (99.53 Hz) | `20 + 100 x^2.0043374` Hz |
| 11 | lowCut | Low cut | 0 (20 Hz) | same law |
| 12 | multiband | Multiband processsing (sic) | Off | |
| 13 | highBand | High band | On | switch next to High gain |
| 14 | lowBand | Low band | On | switch next to Low gain |

Texts print the exact binary value rounded half away from zero (`toFixed`); all 90021 value
texts match FL. The constructor differs from the Default preset (dry/wet 0, slope -6 dB, no
boost, 80 Hz). Factory presets: Bass isolator (low band off = bass removed), Bottom end, Default,
Density, Mastering bass boost, Nightclub next door, Sub presence.

## Measured signal flow

* Crossover: Linkwitz-Riley 4th order (two bilinear Butterworth 2nd-order sections, prewarped).
* Low band: pre-gain (not compensated) -> per-channel limiter at 1.0 (not linked) -> shaper
  `(T1(u) + w T2(u) + w^2 T3(u)) / (1 + 2w)` (Chebyshev; harmonics 2 and 3 only; h3/h2 = w A) ->
  2nd-order Butterworth high-pass at 20 Hz (DC blocker; FL keeps T2's constant, the clone drops it)
  -> low gain -> polarity -> diffuser.
* High band: high gain (switch = mute). Sum -> low cut (2nd-order Butterworth high-pass; at 20 Hz
  it still acts on both bands).
* Dry = crossover allpass (LP4 + HP4) then `HP1 - LP1` (first-order allpass) at the low-cut
  frequency, so dry and wet stay in phase. Out = dry + (wet - dry) * dry/wet; Enabled off = dry.
* Look-ahead: 10 ms (480 / 441 / 960 samples), dry and high band delayed to match; 0 without.
* Limiter (fit to tones and a drum loop): sliding maximum of |u| over look-ahead + 47.1 ms,
  gain reduction smoothed in the log domain by four one-poles: attack 0.65 ms each (look-ahead) or
  instant, release 6.9 ms each.
* Multiband: low band split at fc/2 and fc/4 (LR4, top band through the fc/4 allpass), each band
  limited and shaped separately; 1/16 of the top band also feeds the middle band. In this mode the
  high band passes HP4(fc/2) + AP(fc/4) and the dry AP(fc/2) + AP(fc/4).
* Diffuser: four allpasses `(c + z^-D)/(1 + c z^-D)` in series, integer delays
  `round(sr/fc * [0.5, 0.2061, 0.1581, 0.133])` (one crossover period in total), output crossfaded
  with the undiffused band by Mix.
* Parameter smoothing: gains and mixes follow a ~7.9 ms one-pole. After transport start FL fades
  the output in (about 0.15 s time constant); the clone does not.

## Accuracy (clone vs FL, drum loop, error relative to FL's output after 1 s)

Default -57 dB, lookahead off -59, slope max -54, max boost -48, multiband -64, multiband + max
boost -53, diffuser settings -55..-58, dry/wet 50 % -63; 44.1 and 96 kHz alike (diffuser at
44.1 kHz -36..-44 dB because of the delay rounding). Harmonic levels, crossover and limiter
ceilings match to 0.1 dB in the tests.

## Open questions

* The diffuser delays: ratios fitted at 80 and 120 Hz (48 kHz) are exact; at other settings FL's
  rounding differs by a sample or two.
* Limiter attack in look-ahead mode is fitted (overshoot on abrupt bursts ~1.06 vs FL 1.02).
* Analyzer details (FL's exact spectrum smoothing and ranges) are approximated.
