# Flangus (FL: Fruity Flangus)

Didier Dambrin's stacked-flanger effect. Everything below was measured from FL 2026's
binary with `flfxhost` (impulse trains tracked per voice, `--at` automation, null
tests). Files: `src/model/fx/plugins/flangus.ts`, `src/engine/effects/plugins/flangus.ts`,
`src/ui/plugins/fx/flangus/index.tsx`, `tests/fx/flangus.test.ts`.

## Controls

| # | Name | Range (def) | Text |
|---|---|---|---|
| 0 | Order | 1..9 (4) | `4` |
| 1 | Depth | 0..1024 (512) | `50%` |
| 2 | Speed | 0..1024 (768) | `75%` |
| 3 | Delay | 0..128 (8) | `6%` |
| 4 | Spread | 0..128 (128) | `100%` |
| 5 | Cross | -128..128 (-32) | `-25%` (halves round away from zero) |
| 6 / 7 | Dry level / Wet level | -128..128 (96) | `75%` |

Default preset = constructor state. 12 factory presets are in the def. All texts match.

## DSP (measured)

E(x) = (11^x - 1)/10 is FL's knob law here.

- **Voices**: Order N voices per channel. Voice j = 1..N has position p = j/N and a
  factor r from an 18-entry table (left voice j: r[N-j]; right voice j: r[N+j-1]):
  0.935088, 1.07952, 1.042441, 0.010264, 0.95453, 1.067087, 0.994011, 0.942841,
  1.125715, 0.896814, 1.062961, 0.010182, 1.12999, 0.908209, 0.98209, 1.100402,
  0.96632, 1.104601 (two entries are "slow" voices at ~1 % rate and delay).
- **Spread** weight w = (B^(s/128) - 1)/(B - 1), B ~ 1000 (fit: 1001.25). Every voice
  parameter blends a common value with the voice's own one, using r' = 1 + w(r - 1):
  - base delay = max(8 samples, D0 (1 - w (1 - p r'))), D0 = 100 ms E(Delay/128);
  - sweep A = Amin + S p, Amin = 10 samples @ 44.1 kHz (0.2268 ms), S = 24.77 ms E(Depth/1024)
    (25 ms at full depth); the sweep scales with p even at Spread 0;
  - rate = R0(Speed) [(1 - w) Amin/(Amin + S) + w r' Amin/(Amin + S p)], so A x rate
    (the pitch deviation) is what Speed sets and Depth trades sweep for rate;
  - start phase = 0.75 (left) / 0.25 (right) + 0.5 p w.
- R0(Speed): measured every 32 steps (0.146 Hz .. 22.05 Hz, super-exponential), stored
  and interpolated in the log domain (Catmull-Rom).
- **LFO** = FL's parabolic sine; delay(t) = base + A (1 + psin(phase)).
- **Interpolator**: tap round(d), fraction d - round(d) in [-0.5, 0.5) applied toward the
  next older sample, so half the time it extrapolates (taps like 1.45 / -0.48): a
  modulated treble lift that is part of the Flangus sound.
- **Mix**: out = Dry x + Wet g(N_eff) (sum of own voices + Cross sum of p x other
  side's voices). g is the per-voice normalisation versus N_eff = N + |Cross|(N+1)/2
  (0.969 at 1, 0.319 at 9, 0.219 at 14), a measured table (no closed form fit better
  than 0.3 %). Dry/Wet = sign E(|v|/128); Cross is linear and signed.
- **Smoothing as in FL**: Dry and Wet slew at 0.001 per sample (linear per block,
  starting at 0, which gives FL's ~1000-sample fade-in after creation). FL switches
  Cross and the normalisation instantly, jumps delays, and **restarts all LFOs when
  Order, Depth, Delay or Spread change** (Speed, Cross, Dry, Wet do not).
- Delays and amplitudes scale with the sample rate (ms based); rates are in Hz; the
  8-sample floor does not scale.
- Null tests (1.5 kHz-band noise, 3 s): default -55..-63 dB, order 9 full spread
  -48 dB, spread 112 -43..-49 dB (residual spread-weight error ~3e-5).

## Our deviations

- Parameter changes are FL's (measured with `--at`): Order, Depth, Delay and Spread
  re-initialise the voices - LFOs restart and the delay lines are cleared, so the wet
  output drops out and the delays jump; Speed, Cross and the normalisation switch at
  once; Dry and Wet slew at 0.001 per sample, ramped per block (ours are 128 frames, so a
  ramp that ends inside a block differs from FL at another block size).
- Start-up only: a fresh FL instance set to Order 2, 5, 6 or 7 (with the default Delay)
  keeps the LFO phases its constructor's 4 voices left in their slots instead of
  restarting them; we restart (formula phases). Phase alignment only, from creation.

## Editor

Form geometry (361 x 177). Navy rounded columns (#2e354e) with 21 ticks (long top,
bottom and dashed full-width centre), a bevelled dark cap (21 x 34) with a gold
centre mark, and a gold value line from the bottom (unipolar) or the centre (Cross,
Dry, Wet). ORD: tan 31 x 77 box with 2 x 9 cells; cells from row Order down are lit
(inferred from FL's only screenshot at Order 4). Radial blue background.

## Open questions

- Exact spread-weight base and the closed form of the speed law and normalisation.
- ORD display semantics at other orders (only the Order 4 screenshot is available).
