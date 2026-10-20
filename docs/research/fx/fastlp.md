# Fast LP (FL: Fruity Fast LP, legacy)

Files: `src/model/fx/plugins/fastlp.ts`, `src/engine/effects/plugins/fastlp.ts`,
`src/ui/plugins/fx/fastlp/index.tsx`, `tests/fx/fastlp.test.ts`.
Hidden (`def.hidden`): kept loadable, not offered in menus, as FL lists it
among legacy plugins. No factory presets in FL 2026.

Sources: FL 2026 form (`Fruity Fast LP.txt`: 335 x 55, two wheels 0..1024,
Cutoff Tag 0 default 1024, Resonance Tag 1 default 0, value sliders that
mirror the wheels), FL's plugin thumbnail (Fruity Filter skin with a pink
accent), measurements with the test host (`b5/flp*.py`).

## DSP (measured, exact)

Impulse responses fit a biquad with relative error < 1e-7:
`y = f x + (1 + r - f) y[n-1] - r y[n-2]`, i.e. a one-pole low pass with a
momentum term: `v = r v + f (x - y); y += v`. With r = 0 it is a plain one
pole; cutoff 100 % gives f = 1 (input passes unchanged).

- f(t) = 0.000175244 + (1 - 0.000175244) (543.81926^t - 1) / 542.81926,
  t = cutoff / 1024 (max relative error 2e-7). Identical at 44.1 and 48 kHz:
  per-sample coefficients, no sample-rate scaling (as Fruity Filter).
- r(t) = 0.98330438 (1 - 0.018331722^t) / (1 - 0.018331722), t = res / 1024
  (max error 8e-7). The pole product is r, so full resonance rings long but
  stays stable.
- Parameter jumps (test host `--at`): the cutoff coefficient ramps across the
  block (wheel smoothing min(1, n / 128) per block as Fruity Filter), the
  resonance takes effect at once (-48 / -55 / -56 dB residual for resonance,
  cutoff and combined jumps; static settings match to -127 .. -155 dB).

## Editor

Two Fruity Filter wheel sections (CUTOFF, RESONANCE) at the form coordinates:
wheel, rounded caption, value bar; FL 2026's lighter plugin palette with the
thumbnail's pink accent.
