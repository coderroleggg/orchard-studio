# Effector (FL Studio 2026)

Sources: FL's form (`Effector.txt`, 430 x 418), the manual page and
screenshot, and measurements of the real plugin with `flfxhost` (no factory
presets exist, so the defaults are the constructor state: VOX, bypass on).

## Parameters (all 0..256; all 2570 value texts match FL)

| # | name | text / mapping |
|---|---|---|
| 0 | Effect kind | effect = round(v * 11 / 256): Distort, Lo-fi, Flanger, Phaser, Filter, Delay, Reverb, Stereo, Trans, Grain, Vox, Ring (default 244 = Vox) |
| 1 | FX Bypass | 0 Off, >0 On (default 256) |
| 2, 3, 4, 6, 10 | Wet Mix, Param X, Param Y, Tempo reduce, Input Level | "%.2f%%" of v/256 |
| 5 | Mod Rate | floor((v+16)/32): 1/8, 1/4, 3/8, 1/2, 3/4, 1/1, 2/1, 4/1, 8/1 (beats per cycle; default 28 = 1/4) |
| 7, 8 | Mod Amount X / Y | (v-128)/128 as "-100.00%".."100.00%" |
| 9 | Mod shape | round(v/128): Sine, Saw, Square |
| 11 | Output Gain | (v-128)/128 * 24 dB, "0.00 dB" |

## Measured behaviour

- Gains: input gain (v/256)^2 (128 -> 0.25), output linear in dB, mix a linear
  dry/wet crossfade, bypass passes the input untouched (no gains).
- LFO: moves X/Y by modAmount * 0.5 * lfo (+-50 % at full amount, clamped);
  period = Mod Rate beats; the TEMPO knob speeds it up (x1.78 at 25 %, so
  2^(3.33 t) is used); sine / saw / square.
- DISTORT: response with Y = 0 is clean (0 dB); Y moves a one-pole split
  (cutoff ~80 Hz / 810 Hz / 4.7 kHz at Y 0.25 / 0.5 / 0.75, all at 1): the low
  band goes through the clipper, the high band stays clean (residual +1.2 dB
  at 20 kHz from the simple one-pole). Clipper: normalised to 0.5 at 0.5,
  small-signal gain 3.7 (X = 0) .. 43 (X = 1) (rational fit).
- LO-FI: X = sample hold of 1 + 127 X^3 samples (3 / 17 / 55 / 128 measured),
  Y = quantiser step Y^2 / 32, truncating toward zero (exact).
- FLANGER: y = x - s[n-D], s = x - 0.96 Y s[n-D], D = 3 + 218 X^2 samples at
  44.1 kHz with linear interpolation (exact taps).
- PHASER: x + six first-order allpasses; coefficient -0.9977 / -0.7507 /
  -0.3338 at X 0 / 0.5 / 1 (h[0] = 1 + a^6 matches 1.986 / 1.179 / 1.001;
  notches 538 / 1986 / 6864 Hz at X = 0.5).
- FILTER: X < 0.5 low-pass, X > 0.5 high-pass, very steep (about 60-80 dB per
  octave), passband -2.4 / -5.3 / -7.3 dB at Y 0 / 0.5 / 1; the high-pass side
  loses level towards X = 1 (-4.6 dB at 0.75, -44 dB at 1).
- DELAY: output = x + echoes; delay = the Mod Rate (0.1154 s for 1/4 at
  130 BPM), halved until it fits about 1 s (4/1 and 8/1 give 0.923 s); echo
  gain X^2 per repeat; echo filter: low-pass rising with Y up to 0.5
  (30 Hz .. full band), then a rising high-pass (1 kHz at 0.75, 2.5 kHz at 1).
- REVERB: dry + reverb; RT60 0.52 / 2.55 / 14.4 s at X 0 / 0.5 / 1; wet
  impulse energy 0.080 / 0.127 / 0.640 (X) and 0.031 / 0.127 / 0.214 (Y).
- STEREO: Haas panning: 3 samples base delay, the far channel up to 86 more
  samples (fractional); Y > 0.5 attenuates the far channel by
  (2Y - 1)(1 - min(1, 2(1 - |pan|))) (exact at the measured points).
- TRANS: the gain drops instantly to Y^2 at each LFO period (song-aligned)
  and recovers over ~30 / 50 / 125 ms at X 0 / 0.5 / 1.
- GRAIN: X / Y unused; period from the rate; the decoded playback alternates
  delays of one and two periods (each period is played twice), with a grain
  envelope. FL outputs nothing after a stopped-transport preroll in the host.
- VOX: three resonant formants (~+21 dB), cyclic vowel table over X
  (X = 0 equals X = 1), Y scales the formant frequencies (throat).
- RING: x * sin(2 pi f t), f = 32 * 415.6^X Hz (32 / 144 / 653 / 2947 / 13308 Hz).

## Clone vs FL

Exact or near-exact: parameters and texts, gains, mix, bypass, Lo-fi, Flanger,
Stereo, Ring, delay timing, reverb decay and energy, Trans depth.
Approximated: Distort curve (rational fit), Filter (8-pole Butterworth with a
resonant last section), Phaser feedback, Delay echo filter shapes (echo
energies within ~1 dB), Reverb (Freeverb-style network), Trans recovery
curve, Grain (one-period stutter), Vox (formant table from five measured
points), the TEMPO law.

## Editor

Form coordinates; colours sampled from the screenshot. X/Y pad with grid,
crosshair, current cell and a fading trail; dragging it lifts BYPASS until
release (as the manual says); rate column, shape buttons, 12 effect buttons,
in/out peak meters.

## Open questions

- FL's exact filter topology and Distort curve; Vox vowel table; Grain timing.
- Whether the TEMPO knob also changes the Delay time (the clone keeps it on the rate).
