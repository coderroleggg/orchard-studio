# Reeverb (FL: Fruity Reeverb, legacy)

Ultrafunk's original reverb. FL marks it legacy and leaves it out of the plugin database, but old
projects still load it, so the def is `hidden: true`. Editor 335 x 255 (form `Fruity Reeverb`).
Everything below was measured on FL's own plugin with `flfxhost` at 48 kHz.

## Parameters (index = form Tag)

All values are raw integers. The plugin has no value texts (`GetName` returns nothing); the texts are
the ones its editor shows (FL manual screenshot).

| # | key | FL name | range | default | text / mapping to Reeverb 2 units |
|---|---|---|---|---|---|
| 0 | lowCut | Low cut | 0..65536 | 1231 | Hz = `floor(19 + 2981 v/65536)`, 19 = `OFF`; `75 Hz` |
| 1 | highCut | High cut | 0..65536 | 10682 | tenths of kHz = `floor(5 + 216 v/65536)`, 221 = `OFF`; `4.0 kHz` |
| 2 | predelay | Predelay | 0..250 | 0 | ms; `0 ms` |
| 3 | room | Room size | 0..65536 | 26345 | `floor(1 + 99 v/65536)`; `40 size` |
| 4 | diffusion | Diffusion | 0..65536 | 65536 | `floor(100 v/65536)`; `100` |
| 5 | color | Color | 0..40 | 20 | step `Round(v/10)` (banker's rounding: 5 -> 0, 15/25 -> 2, 35 -> 4): `Brighter`, `Bright`, `Flat`, `Warm`, `Warmer` |
| 6 | decay | Decay | 0..65536 | 4614 | tenths of s = `floor(1 + 199 v/65536)`; `1.5  sec` (two spaces) |
| 7 | damping | High damping | 0..65536 | 10879 | as high cut |
| 8 | dry | Dry | 0..65536 | 65536 | linear gain v/65536; `100 %` |
| 9 | reverb | Reverb | 0..65536 | 13238 | linear gain of the first tank echo; `20 %` |

Defaults are the factory **Default** preset (the constructor uses 1250, 10800, 0, 26000, 65536, 20, 4700,
10800, 65536, 13120). The 21 factory presets (folders External and Internal) are in the def as
`External/...` / `Internal/...`. State blob: version int (1) followed by the 10 ints.

## DSP

FL's legacy plugin is the Reeverb 2 engine (same tank, taps, filters and coefficient laws). With the mapping
above, the TS model matches FL to a relative error of about 1e-7 at room size 50 (impulse responses for
decay, color, cuts, damping, diffusion and predelay settings), so the engine wraps `Reeverb2`:

- room, diffusion, decay, cuts and damping: truncated to Reeverb 2's units (table);
- color: Reeverb 2's bass multiplier **20 / 60 / 100 / 150 / 300 %** at a **500 Hz** crossover (fitted to
  relative error 1e-8 at decay 1.5, 4 and 20 s);
- predelay: whole ms, `round(ms fs/1000) - 1` samples (1 ms = 47 samples at 48 kHz);
- dry: linear; reverb: linear gain on the late reverb, normalised so the first echo equals the setting
  (Reeverb 2's wet gain 1 gives a first echo of 0.463325);
- no early reflections, mono (MID) input, no stereo separation, no modulation.

Reference values (diffusion 0, room 32438 = size 50, decay 13107, cuts and damping off, reverb 65536):
L echoes 2817 = 1.0, 4429 = 0.93087, 8430 = 0.82717, 15164 = -0.7128, 17254 = 0.68421; R 2615 = 1.0.
Color at decay 1.5 s, L[17254..17256]: Brighter 0.30086 / -0.10041 / -0.06053, Warmer 0.36812 / 0.00895 / 0.00838.

Room sizes other than 50 inherit Reeverb 2's state (see its notes).

## Editor

Ten bevels (160 x 45) in two columns; each has the wheel (46 x 40 at bevel + 2, 3), the caption bar
(106 x 16 at bevel + 54, 0) and the value text (bevel + 55, 26). FL 2026 skin colours sampled from the
manual screenshot: panel `#444a4f`, bevel `#50585b`, caption bar `#5a636a`, arc and pointer `#d4ffff`.
The wheel sweeps 300 degrees (measured), unlike the kit's 270-degree knobs. Captions are Arial-metric bold
~9.6 px (their widths match Arial Bold exactly), values Arial ~10.7 px.
