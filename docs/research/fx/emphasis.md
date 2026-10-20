# Emphasis (`emphasis`)

FL Studio 2026 "Emphasis" (Image-Line; DSP by Dario Sanfilippo). Category Dynamics. Editor
740 x 366. Measured on FL's binary with `flfxhost` (a private build that also reaches the
hidden parameter indices) unless marked otherwise.

## Parameters

FL reports 10 parameters to hosts; its editor drives five more by Tag. All 15 are in the def
(index = Tag):

| # | key | FL name | range (def) | mapping / text |
|---|---|---|---|---|
| 0 | bypass | Bypass | 0..1 | Off/On, seamless (latency-aligned dry) |
| 1 | delta | Delta | 0..1 | residual (see below) |
| 2 | envOrder | Envelope order | 1..4 (1) | `1`..`4` |
| 3 | truePeak | True peak detection | 0..1 | 4x-interpolated peak detection in the brick wall |
| 4 | channelMode | Channel mode | 0..1 | `L/R`, `M/S` |
| 5 | mode | Emphasis mode | 0..3 | Versatile, Loud, Transient, Steady |
| 6 | inputGain | Input gain | 0..10000 (0) | 24 v/10000 dB, `%.1f dB` (single-precision) |
| 7 | linking | Linking | 0..10000 (10000) | `round(float(v/10000)*100)%` |
| 8 | emphasis | Emphasis amount | 0..10000 (10000) | same text |
| 9 | ceiling | Output ceiling | 0..10000 (Default preset 9912) | linear gain (11^x - 1)/10, `-0.2 dB`, `-Inf dB` at 0 |
| 10 | levelMatch | Level matching | 0..1 | RMS loudness compensation |
| 11 | oversampling | Oversampling Factor | 0..4 (2 = 4x) | Off/2x/4x/8x/16x (stage 2) |
| 12 | hardness | Emphasis Hardness | 0..9 (7) | `0`..`9` |
| 26 | instantRecovery | Instant recovery | 0..1 | faster stage-1 release |
| 27 | dcBlock | DC Block | 0..1 | 1st-order high-pass, 5 Hz |

All 40020 value texts of parameters 0-9 match FL. FL's `Default.fst` sets the ceiling to
-0.2 dB (constructor: 0 dB); the def uses the preset value. All 21 factory presets are included
(they vary mode, emphasis, hardness, ceiling, oversampling). Non-parameter state:
`lufsMode` (0 I, 1 S, 2 M), `displayRange` (-30/-18/-12 dB), `lowLatency`, `visuals`, `lock`.

## Measured behaviour

* Latency 54 ms at every sample rate and oversampling factor (2381 @ 44.1k, 2592 @ 48k,
  5184 @ 96k). Below the ceiling the signal passes unchanged (at 4x through the oversampling
  filters). Low latency (Options) shortens the windows; the clone reports 12 ms then.
* Steady sines above the ceiling: output peak exactly at the ceiling; the shaping (THD) depends
  on hardness and frequency. Each hardness step halves the shaper's time scale (the THD-vs-
  frequency curve moves one octave per step). Steady mode, +6 dB, THD %:

  | h | 200 Hz | 400 Hz | 1 kHz |
  |---|---|---|---|
  | 0-3 | 0 | 0 | 0 |
  | 5 | 4.7 | 0 | 0 |
  | 7 | 17.9 | 11.3 | 1.4 |
  | 9 | 21.0 | 18.1 | 10.4 |

* Step response (+12 dB, 6 kHz): at hardness 0 the gain ramps down from ~20 ms before the step
  with a steep final ~3 ms (brick wall), holds, then releases over ~20 ms; at hardness k the
  look-ahead and release are 2^-k times as long; from hardness 4 there is no visible pre-duck.
* Adaptive modes protect bass from shaping: at 50 Hz Versatile is clean (0 % THD), Loud 15.8 %,
  Transient/Steady 22 %; from 200 Hz up all modes shape alike. Emphasis amount sets the
  shaping share in the manual modes (Steady, 200 Hz: 0 % at 0, 10.8 % at 25 %, 14.5 % at 50 %;
  Transient keeps steady signals cleaner: 1.8 % at 25 %, 7.9 % at 50 %). Emphasis is ignored in
  Versatile/Loud (the editor shows AUTO).
* Output ceiling scales the output (the limiter works at 0 dBFS internally).
* Delta without level matching = (output - input * gain) / gain (-12.05 dB peak for a -6 dB sine
  at +12 dB gain); with level matching it is the matched residual.
* Linking showed no effect in these tests (the shaping stage works per channel); M/S couples
  the channels as expected.

## DSP design (clone)

```
input gain -> DC block -> L/R or M/S -> pre-delay
Stage 1  clean look-ahead limiter, 24 ms window + 6 ms hold, 4-pole smoothing (attack 4.1 ms,
         release 2.45 ms per pole), linked detection (Linking). It takes (1 - phi) of the gain
         reduction in dB: target gain = level^(phi - 1).
Stage 2  per channel, oversampled: look-ahead limiter at 0 dBFS with a fixed 24 ms delay,
         window 2 * 24 ms * 2^-x(h) (clamped to 24 ms), hold 6 ms * 2^-x, attack 4.1 ms * 2^-x,
         release 2.45 ms * 2^-x (x = h, 7.75 / 7.95 for h = 8 / 9).
Stage 3  brick wall, 4 ms look-ahead, sample or 4x true peak, final clamp.
-> ceiling gain, level matching (1.5 s RMS), delta, bypass
```

phi (shaping share): Versatile = spectral weight (bass share from a 120 Hz low-pass power
ratio; 0 for bass, 1 above ~200 Hz); Loud = 0.65 + 0.35 * spectral; Steady = 1 - (1 - e)^2;
Transient = steady part 1 - (1 - e^3)^2 blended toward 1 - 0.35 (1 - e)^2 by a transient
detector. Envelope order lengthens the stage-2 release (x1 .. x1.75).

Calibration results: steady-tone THD 1.4 % rms error over hardness 3-9 x 200/400/1000 Hz x
+6/+12 dB; Versatile 50/100/200 Hz and Steady/Transient emphasis curves within ~2 %; drum loop
at +12 dB within 0.1 dB RMS of FL for Versatile, Loud, Transient, Steady, hardness 0/5/7/9 and
envelope order 4; delta and ceiling exact, level matching within 0.1 dB. CPU: 1 % (Off), 3.4 %
(4x), 10 % (16x) of one core.

## Approximations and open questions

* FL's adaptive control (spectral and transient processing, "dynamic boost") is modelled, not
  decoded. FL briefly raises the level ~0.2 dB after loud passages (its dynamic boost); not
  modelled.
* The window factor that fits FL's distortion data makes the pre-duck at hardness 1-3 start
  earlier than FL's (FL: 24 ms * 2^-h); release timing matches. FL's -0.47 dB post-onset GR
  overshoot is -0.8 dB here.
* Envelope order and Instant recovery had no measurable effect on simple test signals in FL;
  their clone mappings follow the manual.
* Display semantics are inferred from the manual: orange line = clean (stage 1) GR, black =
  total GR, thin line = output peaks, blue = momentary LUFS, dashed = average GR; meters show GR
  (orange soft / red hard), output peak + RMS with peak hold, and LUFS (I/S/M) with its range.
  LUFS uses BS.1770 K-weighting and gating; it resets when the transport stops.
