# Frequency Splitter

Files: `src/model/fx/plugins/freqsplitter.ts`, `src/engine/effects/plugins/freqsplitter.ts`,
`src/ui/plugins/fx/freqsplitter/index.tsx`, `tests/fx/freqsplitter.test.ts`.
9 factory presets (parameters read with the test host; the main mute switches
from the state blob).

Sources: FL 2026 form (`Frequency Splitter.txt`: 770 x 340, 14 parameters),
the manual + screenshot, value-text sweeps and renders of FL's binary
(`b5/fs*.py`).

## Parameters and state

- Low/Mid, Mid/High Freq: 30 * (16000 / 30)^(v / 65536) Hz; in 3-band mode the
  points cannot cross (FL's texts clamp each to the other).
- Slopes 0..7 = 6 / 12 / 18 / 24 / 36 / 48 / 72 / 96 dB; Linear phase (Normal /
  FFT); Number of bands (2 / 3); Linear Phase Quality (Lowest..Highest);
  Linear phase mod speed 2 * 100^t ms.
- Levels (sends Tags 8-10, main outputs Tags 11-13): gain 1 + v / 1800 below 0
  (-inf at -1800), 1 + (v / 1800) (10^(18/20) - 1) above (+18 dB); texts
  "-inf", "-12.0 dB", "8.7 dB".
- State: main / send band switches (left click) and solo (right click), send
  target mixer track per band. FL's state blob keeps the mute switches as a
  bit mask (bits 0-2 sends, 3-5 main): "Gentle low roll off" and "Steep 30Hz
  Cut" mute the main low band, "Isolate below 200Hz" mid + high, "Isolate over
  4kHz" low + mid.

## Normal mode (IIR, sample-exact to -70 .. -108 dB)

- Crossovers: Butterworth sections on the prewarped bilinear axis: 6 dB =
  BW1, 12 = BW1^2 (LR2), 18 = BW3, 24 = BW2^2 (LR4), 36 = BW3^2 (approximate:
  FL's 36 dB differs slightly, its bands do not sum quite flat; -35 dB),
  48 = BW4^2, 72 = BW6^2, 96 = BW8^2; the high pass is inverted for 12 / 18 /
  36 dB so the bands sum to an all pass.
- Three bands: low = LP1 * AP2, mid = HP1 * LP2, high = HP1 * HP2 (the low
  band runs through LP2 + HP2 to stay in phase).
- Sections as TPT state variable filters: a crossover jump then matches FL
  to -52 dB (a direct-form biquad cascade gave -34 dB transients).
- Levels and mutes glide with a one pole of 0.99045 per sample at 48 kHz
  (0.99521 at 96 kHz: 1 - exp(-459 / sr), ~2.2 ms).

## FFT (linear phase) mode

- Zero-phase band gains, amplitude complementary: low = 1 - r^k / 2 below the
  split, r^-k / 2 above (r = f / fc, k = slope / 6); bands are products as in
  normal mode (matches FL's magnitudes within 0.03 dB at Highest).
- FL's latency: 384 * 2^q samples (q = quality, doubled above 48 kHz). The
  clone uses weighted overlap-add with frame 512 * 2^q, hop 1/4, Hann / Hann:
  its latency is one frame (512 * 2^q, reported for PDC), a third more than
  FL's.
- Crossover / level changes slew with the SPEED time constant.

## Editor

FL's layout: band display (spectrum of input or output from the monitor,
main / send band shapes and EQ curves; drag bands for level, crossovers for
frequency), crossover section (slope combos, FREQ wheels, 2 / 3 band switch,
link), main out (levels, mute / solo boxes, BANDS and curve view switches),
sends (target track spinners listing the tracks this track is routed to,
levels, mute / solo, view switches), linear phase switch, precision, speed,
monitor buttons, options.
