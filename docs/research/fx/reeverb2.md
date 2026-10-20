# Reeverb 2 (FL: Fruity Reeverb 2)

Algorithmic reverb by Ultrafunk / Daniel Schaack (`DSP_UFReverb`, `TFullReverb` in the binary).
Editor 530 x 160: a 160 x 160 room visual and four control sections (form `Fruity Reeverb 2`).
Everything below was measured on FL's own plugin with `flfxhost` (48 kHz unless noted).

## Parameters (index = form Tag)

| # | key | FL name | range | default | text |
|---|---|---|---|---|---|
| 0 | lowCut | Low cut | 19..3000 | 75 | `75Hz`, 19 = `Off` |
| 1 | highCut | High cut | 5..221 | 40 | tenths of kHz `4.0kHz`, 221 = `Off` |
| 2 | predelay | Predelay | 0..384 | 0 | `floor(v*1000/384)ms`; tempo mode `s:tt` (48 ticks per step) |
| 3 | room | Room size | 1..100 | 50 | integer |
| 4 | diffusion | Diffusion | 0..100 | 100 | integer |
| 5 | decay | Decay time | 1..200 | 15 | `1.5sec` |
| 6 | damping | High damping | 5..221 | 40 | as high cut |
| 7 | bass | Bass multiplier | 20..300 | 100 | `100%` |
| 8 | cross | Crossover | 25..2000 | 500 | `500Hz` |
| 9 | sep | Stereo separation | -64..64 | 0 | `Original`, `83% separated` (<0), `17% merged` (>0) |
| 10-12 | dry / er / wet | Dry level / Early reflection level / Wet level | 0..160 | 128 / 128 / 87 | `round(v/128*100)%` |
| 13-14 | modSpeed / modDepth | Mod Speed / Mod Depth | 0..2048 | 684 / 0 | `round(v/2048*100)%` |

Defaults are FL's factory **Default** preset (applied on insertion): ER 128, wet 87 (the plugin's
built-in state has 64 / 64). Non-parameter state: `side` (MID/SIDE switch) and `tempo` (tempo-based
predelay); in FL's state blob they are the two bytes after the 15 ints (tempo, then side).
All six factory presets are in the def (read with `info --preset`).

## Measured DSP (implemented exactly unless noted)

- **Input**: mono = (L+R)/2. SIDE: (L-R)/2 and the reverb's right output (after the width stage) is
  negated, so the reverb returns as side signal. Dry passes untouched.
- **High cut**: one-pole LP, pole `b = (2-cos w) - sqrt((2-cos w)^2 - 1)` (exact -3 dB at fc, no zero).
  **Low cut**: first-order bilinear HP, `p = (1-t)/(1+t)`, `t = tan(pi fc/fs)`, gain `(1+p)/2`. Both act on ER and wet.
- **Topology**: Dattorro's plate tank. All delays are Dattorro's lengths (29761 Hz samples) times
  `s = 0.0208682 (room+15) fs/48000`, truncated: input diffusers 142/107/379/277; left half
  AP1 672, D1 4453, AP2 1800, D2 3720; right half 908, 4217, 2656, 3163 (loop 29280 samples at room 50).
  The input enters both halves; each half: + other half's output -> damping one-pole -> AP1 -> D1 -> AP2 -> D2
  -> bass shelf -> x half-gain -> other half. Allpasses: diffusers/AP1 `y = v - g w, w = x + g v`;
  AP2 stores `x + g y` (FL's taps read that node). Verified sample-exact (rel. error < 1e-3) at room 50.
- **Allpass gains**: input `g = 0.5^((room+15)/130 / D)`, AP1 `exp(-0.0067718 (room+15)/D)`,
  AP2 `exp(-0.01313 (room+15)/D)`, D = diffusion/100 (0 = pure delays).
- **Taps**: 7 per channel at Dattorro's positions, except five moved by +500 / -300 Dattorro samples
  (L: R.D1 266, L.D1 1690, R.D1 2974, L.AP2 187, R.AP2 1913, L.D2 1566, R.D2 2496; R: L.D1 353, R.D1 1811,
  L.D1 3627, R.AP2 335, L.AP2 1728, R.D2 621, L.D2 3173). Gain 0.463325 times a **staged decay**: FL
  applies the decay in two equal stages per half (gain `gs = sqrt(g_half)` each) and gives a tap the
  linear blend of its stage's end gains, `gs^floor(F) * lerp(1, gs, frac(F))` with stage positions
  F = 0, 0.4, 0.75, 1, 1.3, 1.5, 1.8 in output time order, identical for L and R (fitted from 0.5 to 20 s,
  rms error 1e-5). A plain exponential per tap is off by up to 17 % at 0.5 s.
- **Decay**: each half loses exactly `60 dB x (10548 / 48000 s) / T` at room 50 (constant from the tap at
  a stage node, identical to 7 digits at all decay times), scaled with the room like the delays; RT60 =
  1.38813 x the set time.
- **Bass**: shelf `y = v + (G-1) LP(v)` after each half, `ln G = -ln(g_half) (m-1)/(2m)` (RT_low / RT =
  2m/(1+m)); LP is a **bilinear one-pole without prewarp**, `H = (1-p)/2 (1+1/z)/(1-p/z)`,
  `p = (1-t)/(1+t)`, `t = pi fc/fs`, fc = crossover (boost) or crossover/G (cut), unclamped. Sample-exact
  (rel. error 1e-8) for bass 20..300 %, crossover 150..2000 Hz, decay 0.5..20 s.
- **Damping**: the exact -3 dB one-pole at the damping frequency, once per half (Off at 221).
- **Predelay** (late reverb only): `round(v fs/384) - 1` samples; tempo mode `v/192` beats `- 1` sample.
- **Early reflections**: diffuser-1 output tapped at `17.4646 (room+3)` (L) and `13.2727 (room+3)` (R)
  48 kHz samples, gains 0.17587 / 0.16680. Not delayed by the predelay, not damped.
- **Modulation**: both AP1 delays get `+ A/2 (1 + sin(2 pi f t))`, A = depth x 200 samples at 44.1 kHz
  (4.535 ms) peak to peak, `f = 0.1 + 9.9 speed^3` Hz, linear interpolation; LFO starts at phase 0 on reset.
- **Levels**: dry `(11^(v/128) - 1)/10`; ER and wet `(11^(v/256) - 1)/(sqrt 11 - 1)` (128 = unity).
- **Separation** (on ER + wet): M/S width `w = 1 - v/64` (v < 0) or `1 - (5^(v/64) - 1)/4` (v >= 0).

Cross-checks against FL (TS vs real plugin, impulse responses at room 50, modulation off): relative
error ~1e-8 at diffusion 0 for any decay / bass / crossover, ~4e-7 at full diffusion with filters and ER
(the allpass laws are fitted). Energies within 2 %, RT60 within 1 %, octave spectra within 0.2 dB at
44.1/48/96 kHz. Other room sizes: same amplitudes, echo times within 1-3 samples (see open questions).

## Engine notes

- Levels follow FL's per-block slew (measured exact): dry heads linearly for its target at most
  0.001 x 44100 / sr per sample, ER and wet at most 0.01 / (sqrt 11 - 1) x 44100 / sr (the same slew of
  their (11^x - 1)/10 value), each sample using the value before its step; stereo separation ramps
  across one block. dry / ER / wet / separation changes match FL to -102..-127 dB (48 kHz, diffusion 0;
  before: -4.5..-38 dB). The legacy Reeverb steps its levels at once (measured).
- Not FL's yet (measured at 48 kHz, diffusion 0, where the static path matches to -113 dB): decay
  changes (-28..-36 dB after the change), damping / high cut / low cut (-33..-65 dB from ~10 ms after
  the change), bass / crossover (-90..-96 dB), diffusion (-26..-38 dB), room size and predelay
  (-14..-16 dB). Ours: room size glides the delay lengths (~60 ms, interpolated reads while gliding),
  predelay glides, coefficients glide per block (~20 ms); FL's smoothing of these was not decoded
  (a slew of the damping pole like the levels' made it worse). Denormals flushed in feedback / filter
  states.
- `tail` = predelay + 1.25 x the longest RT60 (incl. bass) + one loop.
- `monitor()`: reverb output peak (visual glow) and room size.

## Editor

Form coordinates; knobs drawn as FL 2026 grey domes with a muted pink arc (`#9c8889`, red `#bc6d74` on
hover as in FL's screenshot), faders with pink fill, MID/SIDE pill, TEMPO LED (s:tt texts on the delay
knob when on). The visual is a glowing wireframe frustum with FL's geometry at room 50, scaled by room
size and brightened by the output level (FL's exact visual behaviour is not documented).

## Open questions

- Static mismatch found in this pass: at 44.1 kHz our output differs from FL's by -3..-8 dB (wet only;
  -25 dB with the dry path), at 48 kHz by -27 dB with full diffusion (diffusion 0 with the cuts off:
  -99..-113 dB). The cross-checks above were made at 48 kHz with impulse responses; the delay / tap
  scaling with the sample rate and the diffusion allpasses need FL's code (TFullReverb in the binary).

- FL quirk not replicated: at creation the plugin computes its decay for 44.1 kHz and only updates it
  when a parameter changes (seen at 96 kHz when no parameter is set).
- Delay / tap rounding for rooms other than 50. Measured over all 100 sizes: the delays scale with
  `(room + 15)` at an average 0.020869 per Dattorro sample (we use 0.0208682, which is exact at 50), but no
  single rule `floor(len * k (room+15))` reproduces FL's half lengths and tap offsets at every size (per-size
  fits disagree by ~1e-4), so FL's size scale is not exactly linear or its rounding differs per delay. We
  are within 1-3 samples (echo timing only; levels match).
