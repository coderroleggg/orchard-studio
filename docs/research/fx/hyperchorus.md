# Hyper Chorus (FL: Hyper Chorus)

Code Daniel Schaack, UI Miroslav Krajcovic, concept Sean Tyas. Measured from FL 2026's
binary with `flfxhost` (impulse trains with first-moment tap centroids, model-based line
tracking, sine and DC responses, pole fits of filter tails, `--at` automation, null tests).
Files: `src/model/fx/plugins/hyperchorus.ts`, `src/engine/effects/plugins/hyperchorus.ts`,
`src/ui/plugins/fx/hyperchorus/index.tsx`, `tests/fx/hyperchorus.test.ts`.

## Controls (11)

Delay, Feedback, Mod rate, Modulation, Movement, Mov rate, Phase dif: 0..1000, text
`v/10` with two decimals and `%`. Delay lines 4 / 8. Low pass 7140..22000 = 714 x
(22000/714)^x Hz, High pass 120..10900 = 12 x (1090/12)^x Hz (texts in single precision;
57 of 33652 swept texts differ in the last digit). Mix 0..1000, "D% Dry / W% Wet" with the
wet percentage rounded half to even. Defaults = FL's Default preset (the constructor
differs: Delay 40 %, Mod rate 40 %, Modulation 40 %, Movement 30 %, Mov rate 30 %,
Phase dif 10 %). 12 factory presets read with the host.

## DSP (measured)

- Per channel 4 or 8 delay lines (lines 1-4 are the 4-line set). Line j reads with a
  Catmull-Rom 4-point interpolator at `base (1 + depth psin(phase)) + 1` samples,
  base = (c_j + r_j x Delay) ms, c = 2.0 3.5 5.0 6.5 7.1 8.3 9.1 9.6, r = 4.0 4.75 7.8
  3.5 9.5 8.5 6.0 8.1 (amplitudes match to 0.01 %).
- psin = FL's parabolic sine (16p(0.5 - p) / mirrored): 3.7 % third harmonic, sine fits
  give 1.032 x its peak. depth = 2 % + 12 % a + 18 % a^2 (a = Modulation).
- LFO rate lo + (hi - lo) x Mod rate, lo = 1.5 1.57 1.29 0.38 3.41 3.01 2.47 3.3,
  hi = 2.47 3.41 3.68 3.64 5.03 6.02 5.37 6.5 Hz. Phases are accumulated in single
  precision (phase += float(rate / sr), wrap at 1): the effective rates (e.g. 1.50034 Hz
  for 1.5) match FL to 1e-5 Hz. Start phases measured to 0.003 degrees. The right
  channel's LFOs lead by 90 degrees x Phase dif^3.
- Movement: each line's input is balanced by sqrt(1 -+ p) (left / right) before it enters
  the line, p = 0.998 x Movement x psin(pan phase); pan rates lo + (hi - lo) x Mov rate,
  lo = 0.33 0.29 0.14 0.26 0.44 0.93 0.66 0.41, hi = 3.56 2.66 2.98 3.78 5.06 6.02 8.08
  10.22 Hz, single-precision phases. (The pan follows the line delay: proven by moving the
  Delay control.)
- Feedback: per line, 0.7 x Feedback of the line's own output, re-entering one sample late
  (echo spacing = tap delay + 1).
- Wet: line sums x 2.25 / lines (9/16 per line of 4) -> low pass and high pass, each a
  direct-form-I biquad equal to two bilinear first-order sections (pole fits match the
  mapping to 1e-5; DF-I reproduces FL's transients on coefficient jumps) -> x w(mix); dry
  x w(1 - mix), w(x) = sqrt2 x below 0.5, sqrt(1 - 2 (1 - x)^2) above.
- The high pass is off at its minimum (120): FL cross-fades between the plain sum and the
  high-pass output over 10 ms (441 samples, linear) when it leaves or reaches the
  minimum; off, the section rests (fades in from a cleared state).
- Lines not in use stand completely still (LFO phases, write positions, buffers, feedback
  memory) and resume where they stopped.

## Parameter changes (FL behaviour, reproduced)

- A new instance starts from FL's constructor values and glides to the first settings
  with a one-pole of 21.715 ms that snaps within 1e-4 (normalised) of the target; the
  rate glides shift the LFO phases exactly as in FL. At start-up the number of lines
  switches 15 ms late (sample 663 at 44.1 kHz), so lines 5-8 start late.
- After that every change applies at once (instant jumps, as FL with `--at`), including
  the 4 / 8 switch.

## Nulls against FL (white noise, from the first sample, fresh instances)

Defaults and Delay / Modulation / rates / Feedback / Mix / Phase dif / Low pass / 8-line
cases -70 .. -103 dB; High pass 2000..10900 -74 .. -78 dB; a sequence of 18 mid-render
changes (all controls) -63 dB worst, -77 dB median.

## Our deviations

- High pass at its lowest settings (about 12-20 Hz): FL's output carries a small DC offset
  and low-frequency error that depend on the setting and history (e.g. +1.6 % of the DC
  level at 121, -1.1 % at 122, 0.005 % at 4000; up to 0.7 degrees at 8 Hz) - a
  single-precision effect we have not identified. Ours is the exact filter (10-50 Hz band
  nulls -47 dB at 121, -54 dB at 2000).
- NaN / Inf input is replaced by 0; denormals flushed in the filter states.

## Editor

Form geometry (747 x 217): three X/Y pads (drag sets both controls; right click resets),
the vectorscope (mid up, side across; +L / +R / -R / -L) fed by the engine's latest 2048
output pairs, the display-scaling slider (editor only, our scale law 2^(v/40)), ten dark
wheels with tick rings and the 4 / 8 pill. Title drawn with a system font.
