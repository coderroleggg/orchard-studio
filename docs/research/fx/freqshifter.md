# Frequency Shifter (`freqshifter`)

FL's Frequency Shifter: single-sideband frequency shifting (with an HQ
variant) and a ring modulator, with feedback, stereo phase offset and a
sidechain modulator. Sources: form `Frequency Shifter.txt` (460 x 220),
manual page, screenshots, and the FL binary through `flfxhost` (renders,
sweeps, presets). All numbers below were measured on FL's output at 48 kHz.

## Parameters (FL Tags, texts from GetName sweeps)

| # | key | name | range / default | mapping, text |
|---|---|---|---|---|
| 0 | mix | Dry/Wet mix | 0..10000 / 10000 | "62% Dry" below 5000, "50% Wet" from 5000 (Delphi round-half-even) |
| 1 | type | Type | 0..2 / 0 | Frequency Shifter HQ / Frequency Shifter / Ring Modulator |
| 2 | freq | Frequency | -70000..70000 / 70000 | s = 2(raw+70000)/140000 - 1 (float32); 20 kHz range 0.1 Hz x 200000^abs(s), 200 Hz range 0.1 Hz x 2000^abs(s), sign from s, exactly 0 Hz at 0; Tempo range one cycle per 2^(7(1-abs(s))) steps ("steps:ticks", 48 ticks, FL's float32 rounding gives "63:47", "-64:0") |
| 3 | lrphase | L/R Phase | 0..10000 / 0 | right oscillator leads by 0..90 degrees; "%.1f%%" bipolar text |
| 4, 5 | lshape, rshape | Left shape / Right Shape | 0..10000 / 10000 | sideband: +100% up, -100% down, 0% both |
| 6 | feedback | Feedback | 0..10000 / 5000 | bipolar |
| 7 | stereo | Stereo | 0..10000 / 10000 | "% Stereo" |
| 8 | range | Type (range) | 0..2 / 1 | 20kHz / 200Hz / Tempo |
| 9 | start | Start phase | 0..10000 / 5000 | oscillator phase at transport start, +-180 degrees |

Defaults are FL's Default preset (HQ, 200 Hz range, +200 Hz); the bare
constructor state is type 1 at 0 Hz. Ring modulation shows (and uses) the
ring frequency: sqrt(top x f) with top = 20000 / 200 Hz / one step
("67.5Hz" at raw 50000 in the 200 Hz range; "100 Hz" rings at 141.4 Hz,
1 kHz in the 20 kHz range at 4472 Hz); negative values stop the modulator
(the input passes at full level). Factory presets (+800 Hz, -800 Hz,
Default, Dry, Phaser, Phaser feedback, Phaser stereo, Ring mod,
Stereoizer) were read with `--preset` and are in the def. Latency 0.

## Measured facts (FL, 1 kHz sine at -6 dBFS unless noted)

- +100 Hz: 1100 Hz at -6.00 dBFS, the 900 Hz image at -55.0 (49 dB
  suppression), no carrier. HQ is identical away from the band edges.
  Shape -100%: 900 Hz at -6.0; 0%: both at -12.03; +50%: -8.50 / -18.05
  (I cos - s Q sin with s = shape).
- Tempo, 1 step at 120 BPM: 1008 Hz (8 Hz = tempo x 4 / 60 per step).
- Normal mode folds: 15 kHz + 10 kHz gives 23 kHz at -6.6 dB; HQ -61.7 dB.
  Through zero (1 kHz - 2 kHz): normal 1 kHz at -6.0, HQ -103 dB.
- HQ band limits (tone sweeps): up-shift +1 kHz passes 18 kHz, -14 dB at
  20 kHz, -51 at 21 kHz, -112 at 22 kHz; +3 kHz: -13 at 19 kHz, -40 at
  20 kHz; down-shift -1 kHz: -16 dB at 950/1000 Hz, -37 at 800, -103 at
  500; -300 Hz: -18 at 280 Hz, -62 at 200 Hz.
- Ring "100 Hz": 858.6 / 1141.4 Hz at -12.03 each, carrier below -140.
- Mix 25% (75% Dry): dry at 0 dB, wet at -6 dB (each full up to the middle).
- L/R phase -100 / 0 / +100%: mono sum of a 5 Hz shift -6.00 / -6.69 /
  -9.01 dB (0 / 45 / 90 degrees). Stereo 0%: L = R exactly.
- Feedback (sine at -12 dBFS, +100 Hz): +50% copies at 1100/1200/1300/1400 Hz
  -12.02 / -18.05 / -24.14 / -30.26; +100% -12.17 / -13.21 / -14.53 /
  -16.06 (bounded); -100% is identical in magnitude.
- Wet path band filters from impulse responses: high-pass 23.75 Hz (Q 0.56)
  and low-pass 0.4531 fs (Q 0.5).

## DSP

- Wet input: band filters, then (HQ, not ring) a 16th-order Butterworth:
  low-pass at min(20500 - 0.5f, 22900 - 1.1f, fs/2 - f - 100) for up-shifts,
  high-pass at 1.04 abs(f) for down-shifts (fitted to the edges above).
- Hilbert transformer: two cascades of four z^-2 allpass sections, fitted
  to FL's I and Q phase responses (Q one sample late); image suppression
  -56 dB vs FL's -55.
- Oscillator phase accumulates the shift, glides 20 ms per block-ramped,
  right channel offset by L/R phase, restart at Start phase on play.
- Ring: input x cos(phase), or x the selected sidechain input.
- Feedback: wet output one sample later, gain sign x 0.94 x abs(fb)^0.88
  (fitted: 0.51 at 50%, 0.94 at 100%), soft-saturated (cubic, flat beyond
  1.5); matches the four copies within 0.16 dB at +-50 / 100%.
- Mid/side width from Stereo, mix law min(1, 2(1-m)) dry / min(1, 2m) wet;
  all controls smoothed (20 ms); denormal flush, non-finite reset.

## Exact vs approximated

Exact: parameter texts and curves, ring curve, presets, mix law, L/R phase,
shape law, tempo sync. Within 0.1-3 dB: image suppression, HQ edges, fold
levels, feedback. Approximated: FL's own Hilbert/HQ filter designs (fitted,
not decoded), feedback saturation shape at extreme levels.

## Editor

Brushed-metal knobs at the form positions, frequency display with the
range-dependent text, visualiser (click toggles spectrum, input dark /
output light, or oscilloscope; stored in state), vertical 3-way switches
for range and type, sidechain source selector (mixer track, used by the
ring modulator), linked L/R shape knobs. Cyan in the shifter modes, orange
in ring modulation. Menu: Visualiser, Type, Range.

## Open questions

- FL's feedback saturation curve (inferred from level compression only).
- Whether FL's sidechain ring modulation normalises the sidechain level
  (ours multiplies by it directly).
