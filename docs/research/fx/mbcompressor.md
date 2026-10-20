# Multiband Compressor

FL Studio's Fruity Multiband Compressor (three band compressor + limiter).
Files: `src/model/fx/plugins/mbcompressor.ts` (+ `mbcompressor/data.ts`, generated),
`src/engine/effects/plugins/mbcompressor.ts`, `src/ui/plugins/fx/mbcompressor/`,
`tests/fx/mbcompressor.test.ts`.

Everything below was measured on FL Studio 2026's `Fruity Multiband
Compressor_x64.dylib` with flfxhost (renders compared sample by sample, full
parameter sweeps, the 31 factory presets). **E** = matches FL to float
precision, **M** = measured model (error noted), **A** = approximation.

## Parameters (28, index = FL Tag)

| idx | key | FL name | range / default | law (text) |
|---|---|---|---|---|
| 0 | master | Master volume | 0..65536 / 32768 | gain 2^(v/32768) - 1 (`0.0dB`, `-oo`, max `9.5dB`) |
| 1 | limiter | Limiter | 0..1 / 0 | `OFF` / `ON` |
| 2 | filterType | Filter type | 0..1 / 0 | `BW IIR` / `LP FIR` |
| 3, 11, 20 | hState, mState, lState | High / Mid / Low band state | 0..2 / 0 | `ON`, `muted`, `bypassed` |
| 4, 12, 13, 21 | hFreq, mFreqH, mFreqL, lFreq | H Freq, M Freq H, M Freq L, L Freq | 20..20000 / 17000, 17000, 6500, 6500 | tabulated (below), `9237Hz` |
| 5, 14, 22 | ?Out | H / M / L Output | 0..65536 / 21845 | 2^(3v/65536) - 1 (`0.0dB`, max `16.9dB`) |
| 6, 15, 23 | ?Thres | ... Threshold | 0..65536 / 45875, 48875, 45875 | -60 + 60 v/65536 dB (`-18.0dB`) |
| 7, 16, 24 | ?Ratio | ... Ratio | 0..65536 / 32768 | x = v/65536, text 1/(1-x) (`2.0:1`, `oo:1`) |
| 8, 17, 25 | ?Att | ... Attack | 1..1000 / 100 | v/10 ms (`10.0ms`) |
| 9, 18, 26 | ?Rel | ... Release | 100..10000 / 1000 | v/10 ms |
| 10, 19, 27 | ?Knee | Hard / soft ? Knee | 0..65536 / 52429 | `80%` (round half up) |

FL names the three knees "Hard / soft  Knee" (the band letter of the form hint
is lost); the hint's names ("Hard / soft L Knee") are used. All value texts
match FL's full sweeps (65537 values each) except the frequency texts at 193 of
19981 values (rounding ties, the table's precision). FL computes the gain texts
in single precision; that is emulated. Threshold 61440 (-3.75 dB) is the one
tie FL rounds to `-3.7dB` (special-cased).

**Frequency law**: no closed form (not exponential, not power). Tabulated: ln(Hz)
every 50 control steps (data.ts), built from the transition points of the
integer text sweep (exact crossings of k + 0.5 Hz) and checked against cut-offs
fitted to FL's impulse responses (6500 -> 300.30 Hz, 12000 -> 2157.6 Hz, 17000 ->
9236.6 Hz; error < 3e-5 above 3 kHz, < 1 % at the 20 Hz end).

State: `io` (four meter IN / OUT switches: main, low, mid, high) and `speed`
(visual speed -1..100, default 50). FL's state blob: int32 0, the 28 values,
the four switches as bytes, the speed. 31 factory presets (`Plugin presets/
Effects/Fruity Multiband Compressor/*.fst`) decoded with the host.

## Signal flow

1. **Band split, BW IIR** (E): low = 4th-order Butterworth low-pass at L Freq;
   mid = Butterworth low-pass at M Freq H, then high-pass at M Freq L (FL's order:
   it shows when a crossover changes); high = high-pass at H Freq. Each is two RBJ
   biquads (prewarped bilinear, Q 0.5412 and 1.3066, direct form I), -3 dB at the
   shown frequency. Bands are simply summed (the default split is not flat: +0.4 dB
   at 100 Hz, bumps at the crossovers). Latency 0.
2. **Band split, LP FIR** (M, IR error ~1e-6): 105-tap linear phase filters at
   every sample rate (latency 52 samples, reported). LP(fc) = (2fc/sr) sinc(2fc/sr k)
   sinc(0.17 * 2fc/sr k) w(k): an ideal trapezoid low-pass (transition 17 % of fc)
   under a Kaiser window, beta = 0.1102 (55 - 8.7), not normalised (FL's 300 Hz
   low band has DC gain 0.672). low = LP(L Freq), mid = LP(M Freq H) - LP(M Freq L),
   high = delayed input - LP(H Freq).
3. **Detector** (M, < 0.001 dB on step responses): per band, stereo linked
   (max(|L|, |R|) of the band signal before the output gain):
   y = max(d, y * exp(-1 / (release sr))) (release = v/10 ms exactly, decays
   towards zero), then a prewarped bilinear one-pole low-pass
   e = p e + (1 - p)/2 (y + y_prev) with cut-off 1 / (1/17000 + 0.1 (v - 1)/999)
   Hz (v = attack value; 0.1 ms -> 17 kHz with a negative pole, 100 ms -> 9.99 Hz).
   Identified from step responses at 44.1 / 48 / 88.2 / 96 kHz (the pole depends on
   fc / sr only).
4. **Gain computer** (M, -65..-90 dB on presets): gain = 1 / (1 + x s), x = ratio
   amount, s = (e - t) / t above the knee (so oo:1 holds the threshold, 2:1 is
   not a dB ratio), quadratic soft knee s = (e - t + W)^2 / (4 W t) over t +- W,
   W = 0.005 + 0.995 (1 - k^2) t (k = knee / 65536). The absolute 0.005 widens the
   knee at low thresholds (at -54 dB even a hard knee starts 14 dB below the
   threshold) - measured at -54, -48, -42, -36, -18, -9.6 and -4.2 dB.
5. **Band output**: ON = band x gain x output gain; bypassed = band x output gain
   (no compression); muted = nothing. Sum x master volume.
6. **Limiter** (M): per channel (not linked), the same detector with a 17 kHz
   attack and 15 ms release, threshold -1.2 dB, 4:1 (x = 0.75), knee half width
   0.195 t; output x 0.99999, clipped at +-0.99999. Fitted on steps, ramps, spikes
   and sines (rms error 2e-5, -60..-68 dB on sines, noise and mono drums).
   Not reproduced: when the limiter clips hard on stereo material FL's two
   channels interact (a channel is sometimes pushed to the ceiling for a sample
   or two when the other clips, and the peak hold of one channel loses its peak
   after clipping); presets that drive the limiter into clipping on hot stereo
   drums differ by -15..-45 dB (the same presets without the limiter: -54..-135 dB).
   FL's steady-state output also carries a tiny 4-sample ripple (about -66 dB).

FL applies parameter changes at the next block without ramps, and so does the clone.
A band's detector runs only while the band is ON, and FL restarts it (from zero) when
the band turns ON again from muted / bypassed, so the band comes back with less gain
reduction for about its attack time (reproduced). Crossover changes switch the
coefficients and keep the direct-form-I states.

Parameter changes vs FL (`--at`, 2 s noise): gains, thresholds, ratios, knees, attack /
release, band states, crossovers, FIR gains -72..-78 dB (the static floor of the
modelled detector); limiter on / off and master with the limiter -63..-74 dB. Before
this pass: -10..-46 dB around changes (one-block ramps, HP-then-LP mid band, detector
kept running in muted / bypassed bands).

## Calibration (drum loop and stereo noise, 2 s)

Default -76 / -74 dB; FIR default -78 / -76 dB; knee 0 + oo:1, attack / release
extremes, uncrossed bands, mixed states -63..-80 dB. All 31 presets with the
limiter disabled on both sides: -54 (Mosquite: -54 dB threshold, x21 gain) ..
-135 dB, median -79 dB. With the limiter: as above. Tests store FL numbers:
value texts, preset values, cut-offs, attack poles, the low-threshold knee,
levels of 1 kHz / 100 Hz / 8 kHz sines (default), FIR (latency 52), soft knee,
low threshold, limiter, band states and gains, master before the limiter,
stereo link.

## Editor

800 x 155 at FL's form coordinates: main meter + IN / OUT, IIR / FIR switch,
LIMITER, master GAIN; the visual (192 x 76) scrolls input (light) and output
(pink) peaks at SPEED (at the far left: off) and shows the three band responses
(IIR or FIR, muted bands dimmed) while a crossover wheel is touched; four arc
wheels for L Freq, M Freq L, M Freq H, H Freq that snap together when crossed
(FL: "the cutoff knobs will snap when the bands are perfectly crossed"); per
band the A / M / B state selector (orange / red / white as FL's), THRES, RATIO,
KNEE, ATT, REL, GAIN (red ticks), stereo peak meter with IN / OUT and the C
gain-reduction meter (hints show dB). Drawn with SVG / canvas.

## Sidechain

None: the plugin makes no FHD_GetNumInOut / FHD_RegisterSideInput call and its
output is identical with flfxhost `--sc`.

## Open questions

- The limiter's stereo interaction under clipping and the 4-sample ripple
  (looks like SIMD processing of two frames at a time).
- FL's volumeter scale (linear amplitude assumed) and the visual's exact scale
  and colours per band.
- Exact frequency law (tabulated).
