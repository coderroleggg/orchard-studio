# Parametric EQ (FL: Fruity Parametric EQ)

Files: `src/model/fx/plugins/peq.ts`, `src/engine/effects/plugins/peq.ts`,
`src/ui/plugins/fx/peq/{index,widgets}.tsx`, `tests/fx/peq.test.ts`.

Sources: FL 2026 form (`Fruity Parametric EQ.txt`), manual, the manual
screenshot (older bitmap layout), FL 2026's own plugin thumbnail
(`System/Config/Thumbnails/Fruity Parametric EQ.png`, confirms the 2026
layout and look), and measurements of FL's binary with the test host.

## Parameters (29, FL order)

| Tags | keys | FL name | range | default | text |
|---|---|---|---|---|---|
| 0-6 | level1..7 | Band N level | -1800..1800 | 0 | `-18.0dB` |
| 7-13 | freq1..7 | Band N freq | 0..65536 | 5777, 13024, 19904, 33145, 42327, 49307, 55825 | `90Hz` |
| 14-20 | width1..7 | Band N width | 0..65536 | 17500 (bands 5, 6: 24000) | `27%` |
| 21-27 | type1..7 | Band N type | 0..7 | 5, 6, 6, 6, 6, 6, 7 | Disabled, Low pass, Band pass, High pass, Notch, Low shelf, Peaking, High shelf |
| 28 | main | Main level | 0..256 | 128 | `50%` |

The width defaults are the plugin's initial values (the form's DefaultValue is
17500 for all seven; FL starts bands 5 and 6 at 24000).

## DSP (bit-exact)

A port of FL's code (Eff_Render 0x5c1a0, band update 0x5b7a0, coefficient
routines 0x176a20 / 0x176470, stereo biquad kernel 0x2350). Verified bit
for bit against FL renders: static settings of every type, level /
frequency / width / type / main automation, 0 dB and disabled bands, 44.1 /
48 / 96 kHz.

- Main level first: `x f32` times `g = f32((exp(f32(f32(v/128) ln11)) - 1) x
  f32(0.1))` (a copy at 128), then the seven bands in series.
- Band kernel: stereo direct form I in double precision, `y = ((b1 x1 + b2
  x2) - a1 y1 - a2 y2) + b0 x`, input and output single precision (rounded
  between bands), state in double.
- Frequency: `f = f32(10 + 159.9 f32(exp(t ln 101) - 1))`, t = f32(wheel /
  65536), clamped to f32(0.4999 fs); `w0 = f 2pi (1/fs)`; level = f32(f32(v)
  f32(0.01)) dB; width t = f32(wheel / 65536).
- LP / BP / HP / notch: RBJ, `Q = 0.1 + 18.9 t`, alpha = sin / 2Q (band pass:
  0 dB peak). Peaking: `A = Power(10, f32(dB 0.025))` (single), `Q = 0.1 +
  0.0999 f32(1001^t - 1)`. Shelves: RBJ slope form, `S = 0.1 + 1.9 t`, beta =
  sqrt((A^2 + 1)/S - (A - 1)^2) (times sin). Coefficients in double, in FL's
  operation order (see the code).
- Parameter changes: new coefficients from the next block, no smoothing, the
  band state kept; a type change clears the band's state; a disabled band
  stops at once (state kept); a 0 dB peaking / shelf band keeps running for
  fs div 5 samples with identity coefficients (it rings out), then its state
  is cleared and it is skipped.
- Tail: longest band ring time (from the pole radius), at most 5 s. Latency 0.

Before this pass: static -73 dB (approximate peaking Q law), parameter
changes -2..-34 dB (4 ms glides, transposed direct form II, main level
ramped at the output).

## Editor

FL 2026 form coordinates with the plugin's brushed metal skin (colours sampled
from the manual screenshot; the 2026 thumbnail shows the same skin): green
type spinners with FL's glyphs (drag / wheel / right-click menu), level
sliders (hidden for low/band/high pass and notch, as in FL), green frequency
read-outs, metal frequency and width wheels, the band graph and the main
level wheel. Graph: x follows the frequency wheel mapping (10 Hz .. 16 kHz,
as in the 2026 thumbnail), y is +-18 dB, vertical lines at the band
frequencies; left-drag changes level/frequency and right-drag level/width of
the nearest band (manual).

## Open points

- The graph's vertical lines: the 2026 thumbnail shows lines at the seven
  default band frequencies; the clone draws them at the current band
  frequencies (identical at the defaults).
- The FRUITY PARAMETRIC EQ caption is Arial italic compressed to 83 %
  (FL's form uses Arial at a larger size; the screenshot shows a narrow face).
