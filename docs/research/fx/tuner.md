# Tuner (FL: Tuner)

Pitch display for monophonic input. Category Visual. Editor 300 x 360 (FL's
window is resizable and the display scales with it; ours is fixed and scales
as a whole). Audio passes through unchanged.

## Parameters (flfxhost)
| idx | name | range | default | text |
|---|---|---|---|---|
| 0 | Reference | 0..6000 | 3000 | `400 + v*80/6000` -> `440.0 Hz` (all 6001 texts match) |
| 1 | Reactivity | 0..6000 | 3000 | `50.0 %`, computed in float32 (5993/6001 texts match; 8 differ in the last digit at exact .x5) |
| 2 | Bass mode | 0..1 | 0 | Off / On |

State blob (version 1): reference, reactivity, bass, display mode (2 = circular
dial, 1 = horizontal basic). Built-in default display: circular. Factory presets
live in `Circular/` and `Horizontal/` (Average, Bass, Default); there is no root
Default preset, so inserting the plugin uses the built-in defaults. FL's Default
presets store Reactivity = 1 (0.0 %), Average = 0; reproduced as-is.

## Display (from the manual screenshot at 1.5x, geometry measured)
- Background: horizontal gradient `#2f3639` -> `#40484d` -> `#2f3639`.
- Dial: centre (150,150); ring r 141.3 (2 px, `#a4a4a4`); 100 ticks, one per cent
  (+-50 around the full circle, 3.6 deg each), minor r 140.6..128.7, every 10th
  r ..124.6; the tick under the needle is red. In-tune wedge +-10.8 deg (+-3 cents)
  `#676b6e` from the disc to the ring, under the ticks. Needle `#d05b4a`, 4 px,
  r 64..108.5. Disc r 63 `#d1d3d5`; note 60 px (FL's base font size 60 for a 300 px
  display) `#e65943`. Frequency / cent boxes (8,7,59,21) and (233,7,59,21).
- Basic: same texts without boxes, ruler of 51 ticks (2 cents each, long every
  10 cents) at y 276, red double-triangle marker.
- Texts: `65.4 Hz` (`0 Hz` before a detection) and `+1 cent` (always singular,
  explicit sign, from the binary's strings). Note names use FL's octave numbering
  (key 60 = C5): 440 Hz shows `A5`, 65.4 Hz shows `C3` as in FL's screenshot.
- Control strip: knobs at (9,304) and (61,304), Bass switch (109,343), display
  tab (123,300,54,22) whose icon shows the current mode.

## Pitch detection (approximation: FL's algorithm was not reverse engineered)
- Mono sum, 4th-order Butterworth low-pass and 2x decimation at >= 32 kHz.
- McLeod pitch method: NSDF via FFT autocorrelation over a 50 ms window every
  20 ms (Bass: 100 ms window, 40 ms hop, as the manual's "around 100 ms"); first
  key maximum >= 0.9 x the highest (peak heights interpolated), clarity >= 0.75,
  RMS gate -66 dBFS; the lag is refined on the furthest strong period multiple.
- Range per the manual (FL names): F1 (21.8 Hz) .. E7 (slow) / C10 (fast); Bass
  adds an octave below. Fundamentals above the range are rejected.
- Reactivity: smoothing time constant 300 ms (0 %) .. 8 ms (100 %); a jump of more
  than 60 cents needs two agreeing estimates (one at > 85 %).
- The last detected note is held when the input stops.
- Analysis runs only while the editor polls (stops 1 s after the last poll).

## Approximations / omissions
- Detection algorithm and smoothing (see above); the needle eases over ~50 ms.
- Knob, switch and tab drawing follow the screenshot; the TUNER wordmark is plain
  text (FL's logo artwork is not copied).
- FL's resizable layout (the display grows with the window) is not reproduced.
