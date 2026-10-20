# Soft Clipper (FL: Fruity Soft Clipper)

Files: `src/model/fx/plugins/softclipper.ts`, `src/engine/effects/plugins/softclipper.ts`,
`src/ui/plugins/fx/softclipper.tsx`, `tests/fx/softclipper.test.ts`.

Measured on FL Studio 2026's `Fruity Soft Clipper_x64.dylib` with the scratchpad
host: value texts by `sweep --all`, the DSP from ramps (static curves) and
stereo noise. Our implementation matches FL to 5e-7 (float32).

## Parameters

| # | key | FL name | range / default | text |
|---|---|---|---|---|
| 0 | thres | Threshold | 1..127 / 100 | `-4.4dB` = 20·log10((7^(v/127) - 1)/6) |
| 1 | post | Post gain | 0..160 / 128 | `80%` = round(v/1.6) |

Only these two parameters (no state); the factory "Default" preset equals the
defaults. Categories: Distortion and Dynamics.

## DSP (memoryless, per channel, no latency)

- t = v/128 (the knee position is linear in the knob value; the dB text uses a
  different law, as in FL).
- |x| ≤ t: y = x; otherwise y = sign(x)·(t + (1 - t)(1 - e^(-(|x| - t)/(1 - t)))),
  which is C1 at t and approaches full scale (1.0) asymptotically.
- out = y · (11^(post/128) - 1)/10 (128 = unity, 160 = 1.903 = +5.6 dB, 0 = mute).

Threshold and post gain changes take effect at the next block without
smoothing, as in FL (measured with `--at`: -134..-150 dB after each change,
-136.5 dB overall; the former 256-sample ramp gave -23 dB). Departure (finite
output): NaN input -> 0. Output meter peaks via `monitor()`.

## Editor

270 x 130 at form coordinates: THRES / POST wheels drawn in FL's older ticked
style (white pointer, no value arc), the SOFT | CLIPPER caption, a stereo output
meter (green bars, peak-hold markers) and the transfer display (linear 0..1 in
both axes, 5 x 5 grid, white curve, brighter line at the threshold output level).
Hovering the display shows input -> output in the hint bar; dragging sets the
threshold so that its line follows the cursor.

## Notes

- The manual's screenshot shows an older layout (knobs ~15 px higher, wider
  meter); we follow FL 2026's form. The meter scale is not documented and uses
  the volumeter-style curve shared with other FL meters here.
