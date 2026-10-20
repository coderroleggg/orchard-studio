# WaveShaper (FL: Fruity WaveShaper)

Sources: FL 2026's plugin binary (`TTestPlug`: Eff_Render 0x62c30, the four
table kernels 0x69400 / 0x694b0 / 0x69710 / 0x697d0, table builder 0x63180,
oversampler 0x236320..0x236540 with its SIMD stages 0x3880 / 0x39b0, Center
filter 0x67e30, SaveRestoreState 0x619b0, dispatcher 0x61530), the 34
factory presets (.fst, decoded), the form, the manual, and renders through
FL's plugin with crafted states (`flfxhost --state`). Ours matches FL to
-74..-150 dB on 12 presets (noise and sweeps, including oversampling and
Center); the rest is int16 table rounding at near-vertical curve segments.

## Parameters (form 270 x 353)

| # | Name | Range | Default | Value text | Law |
|---|---|---|---|---|---|
| 0 | Pre amp | 64..192 | 128 | (v-64)/64 % ("0%".."200%") | mul = (4^(v/128) - 1)/3 |
| 1 | Mix level | 0..128 | 128 | v/128 % | m = v/128 (linear) |
| 2 | Post gain | 0..128 | 128 | v/128 % | post = (11^(v/128) - 1)/10 |

`wet = m * post`, `dry = (1 - m) * post^2 * mul` (FL's formula, measured).

Non-parameter state (FL's SaveRestoreState, version 0x00040003): curve,
bipolar, center, oversample (0..4 = 1x..16x), snap (default on), HQ, smooth.
FL also keeps freeze / step as editor options (we store them too). Curve
points: FL envelope points `(dx, y, tension, mode)`; stored as absolute
`[x, y, t, mode]`. Point record formats seen in presets: 12 bytes (3
floats, mode 0), 16 (+int32 mode), 24 (2 doubles, float, mode byte + 3).
All 34 factory presets are in `def.presets` (curve and switches; FL's v1
presets do not carry HQ / smooth).

## DSP (exact)

- Curve: FL's envelope evaluator, identical to automation clips
  (`evalEnvelope` / `curveShape`; verified against FL for single curve,
  double curve and half sine at several tensions). Unipolar: x = |input|,
  output mirrored for negative input. Bipolar: x in -1..1, y in -1..1.
- Table: unipolar 16384 points over 0..1, `rint(y * 32767)`; bipolar 32768
  points over -1..1, `rint((y - 0.5) * 65535)` clamped to int16; guard
  entries at both ends.
- Kernels (`out = x dry + T(x mul) wet / 32768`): HQ off = truncating lookup
  (unipolar `trunc(|x| mul size)`, bipolar `rint(x mul size/2 + size/2)`),
  i.e. FL's "don't truncate below -85 dB" dead zone of 1/16383; HQ on =
  linear interpolation (bipolar extrapolates one table step below the left
  edge, as FL does).
- Oversampling 2^k: k cascaded HIIR polyphase half-bands, 6 coefficients,
  transition 0.1 (decoded from FL's SIMD code, identical coefficients),
  dry and wet inside the oversampled domain; no reported latency (group
  delay ~2 samples at 2x).
- Smooth: pre / mix / post glide in single precision, `g = f32(g + f32(f32(t -
  g) k))` per frame of the (oversampled) buffer, `k = f32(1 - Power(0.1,
  1/(0.005 sr)))` from the base rate (so faster when oversampling, as in FL).
  The smoothed gains only move while Smooth is on and start at 0 in a new
  plugin, so a state loaded with Smooth on fades in from silence (FL's
  constructor; measured). Without Smooth FL uses the current gains for the
  whole block (a step per block), and so do we.
- Export: with "HQ for all plugins" FL forces the interpolating lookup and
  turns any oversampling setting into 16x (1x stays 1x): export renders equal
  live renders with HQ on and 16x exactly. We do the same when
  `FxContext.rendering` is set.
- Center: per channel `v += (x - p) a; p += v; v *= 0.96; out = x - p` with
  `a = 2.2835e-5 x 44100/sr` (about a 4 Hz DC blocker; FL's TAudioRenderer
  helper supplies 44100/sr, confirmed in the binary).
- Editor level display: input peak x pre gain, held 2 s, then falls
  `t^2/5` (FL computes this only while the editor is open).

## Editor

FL's blue graph (#41687e, 16 x 16 grid, quarter lines #2d546a), white
curve, square end points, hollow round points, the tension handle of the
hovered segment, a faint level marker. Editing as FL's envelope editor:
drag points (Shift / Ctrl lock an axis, the end points stay at the edges),
Alt+click deletes, right-click a point for the 13 curve modes and Delete,
right-click empty space adds a point, tension handles drag (Ctrl fine) and
reset on right-click, Snap (1/16), Step drawing (Shift: pulses), Freeze.
Settings panel per the form: WAVE / SHAPER badge, unipolar / bipolar
switch, PRE / MIX / POST wheels, options menu (reset, flips, mode
switches), LED switches with glyphs, OVERSAMPLE selector (1x..16x).

## Fidelity of parameter changes

flfxhost `--at` (pre / mix / post steps, 44.1 kHz): Soft clip 1 without
Smooth -99..-146 dB, with HQ and 4x -117..-145 dB, with Smooth (2x)
-103..-151 dB; Fuzzy (143-point bipolar curve) -55..-105 dB, limited by the
int16 table rounding on its steep segments (the static residual). Export
mode vs FL's export: -129..-139 dB. Before this pass: -27..-46 dB with
changes (1 ms de-zipper, snapped Smooth start), and -72 dB / +3 dB against
FL's export.

## Open questions

- FL's exact options menu content (we offer reset / flips / switches).
- Whether FL's point menu lists all 13 modes (the manual names three).
