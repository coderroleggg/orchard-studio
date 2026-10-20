# Transmitter (FL Studio 2026)

Sources: FL's form (`Transmitter.txt`, 740 x 366), the manual page, the two
manual screenshots, the 34 factory presets, and measurements of the real
plugin with `flfxhost` (info, sweep, render with crafted `--state` blobs:
version 3, 33 parameters, then Tags 33..41, sidechain-in / transient-out /
sustain-out, scroll speed, display flags).

## Parameters

FL reports 33 automatable parameters (0..32). The switches with Tags 33..41
(Lookahead, Stereo link, Detection mode, Transient/Sustain enabled,
Transient/Sustain FX, tempo switches) live in the same state but are not
automatable; the clone stores them as `noAuto` parameters at their Tags.
Names and ranges come from FL's GetName. All 24 431 sampled value texts match
FL: FL normalises the raw value as a float32 (`v/10000`) and scales in double,
which decides the rounding (2450 -> "0.25", 3150 -> "0.31", hold 3500 ->
"88.1 ms"); FL never prints "-0.0".

| param | law |
|---|---|
| Sensitivity | v/10000, "0.75" |
| Hold, Release | 1 + 249 x ms ("50.0 ms") |
| Levels | dB = -120 + 132 (v/12800)^0.25; 8743 = 0.0 dB; text "-120.0" .. "12.0" |
| Tilt | (x - 0.5) * 12 dB, "-6.0" .. "6.0" |
| Diffuser depth / delay | 0.99 x; 0.1 * 100^x s ("0.10 s" .. "10.00 s") |
| Saturation drive / warmth | 18 x dB ("0.0" .. "18.0"); x ("0.00") |
| Bounce curves | (x - 0.5) * 2 ("-1.0" .. "1.0"); param 24 is FL's "Sustain bounce delay drive" (sic) |
| Delay time | 0.001 + 1.999 x^2 s ("0.100 s"); synced 1..768 = steps:ticks, 48 ticks per step ("4:1") |

Defaults are FL's factory **Default** preset (FL applies it on insert; the
constructor state has both levels at -120 dB and is silent). All 34 factory
presets are in the def.

## Signal flow (measured)

- Split: T(t) in 0..1, sustain = 1 - T; with both effects Off and levels at
  0 dB the output equals the input (FL: 7.4e-5 error from the +0.0011 dB of
  raw 8743).
- Gate: opens on a detection, stays open for the hold time and is retriggered
  by every new detection (clicks every 20 ms with a 50 ms hold keep it open).
  Measured gate length 1.111 ms + 248.91 x ms (display says 1.0 + 249 x).
- Envelope: Sanfilippo's 4-stage exponential smoother (his LimiterClass
  `ExpSmootherCascade`): stage coefficient exp(-2*pi*c/(t*sr)), c =
  1/sqrt(2^(1/4) - 1); release = Release time (fit error 2e-5), attack instant,
  or exactly 2 ms with Lookahead (fit error 1.5e-4).
- Lookahead: latency floor(0.002*sr) (88 / 96 / 192 samples at 44.1 / 48 /
  96 kHz; the manual says 5 ms, the plugin uses 2 ms). Default preset has it on.
- Stereo link: detection on the mid (L+R)/2 (L = -R never triggers); off =
  independent per-channel detectors and envelopes.
- Per part: tilt (first-order shelf pair, pivot 1 kHz, +-6 dB; bilinear;
  h[0] = 0.5528 / 1.8085 at -6 / +6, clone 0.5528 / 1.8096) **before** the
  effect, effect with its own linear dry/wet mix, then level and on/off.
- Saturation: tanh(g x), g = 10^(drive/20), with a measured knee to a 0.9763
  ceiling (u: 1.6 -> 0.9215, 2.0 -> 0.9566, 3.0 -> 0.9741, 6 -> 0.9763); no
  oversampling (aliases at FL's level). Warmth: small-signal response is an
  exact first-order allpass whose corner falls from Nyquist (0) through
  2285 Hz (0.1), 152 Hz (0.5) to 20 Hz (1.0), table-interpolated.
- Bounce: 64 taps over a 2 s window, odd taps left (from the left input), even
  taps right; t_k = 2 (1 - q^k)/(1 - q^64) s, q = exp(-10 c/64) (exact sample
  positions); gains 1 - 0.95|a|(1 - e) with e = exp(-10(64-k)/64) for a > 0,
  exp(-10k/64) for a < 0 (exact). No normalisation (a sustained tone is
  boosted about 12 dB with flat curves).
- Diffusion: depth 0 = exactly 16 samples of delay; the first burst is a
  16-stage first-order allpass chain with coefficient = depth (group delay
  matches); a feedback network whose delays scale with the delay control
  (bursts at ~107/149/203/257 samples per second of "delay"); RT60 / delay ~
  2.4 (depth 0.1), 3.7 (0.5), 6.3 (0.7), 17.5 (0.9), ~90 (0.99). Mono (L = R).
- Blur: identical to Off in FL 2026 (verified on tones, noise and impulses).
- Delay: 1 ms..2 s, feedback 0..1, linear dry/wet; echo kernel = linear
  interpolation averaged over two neighbouring reads, plus a 20 Hz DC blocker
  in the echoes; delay changes glide. Tempo sync: 1/48 step units, max 2 s.
- Controller output: "TSS Envelope" (the T envelope, block maximum).

## Detection (fitted)

FL's detector is not documented and the binary is stripped. Measured facts:
zero latency for strong onsets (DC steps >= 0.1 detected on the first sample);
falling steps and hard stops also trigger; the minimum level detected from
silence falls from about -10 dBFS (sensitivity 0) to about -60 dBFS (1.0);
modes set the minimum spacing between detections: Smooth 50 ms, Balanced
20 ms, Dense 5 ms (stationary noise at sensitivity 1 retriggers at exactly
these intervals). The clone's detector (two cascaded 1 kHz high-passes, a
fast and a slow cascaded envelope follower compared in dB with a
sensitivity-dependent floor and threshold, the mode spacing) was fitted with
a random search to FL's gate on drums, stepped tones, onsets and noise
(4 sensitivities x 3 modes). It reproduces every drum hit of the test loop
at sensitivity 0.75 / Balanced; it misses FL's detections of small level
steps (< 6 dB), of hard stops and of noise retriggers at high sensitivity.

## Editor

Form coordinates for every control; colours sampled from the manual's
screenshot. Effect knobs swap with the effect (Saturation: Drive/Warmth,
Bounce: Time curve/Amp curve, Diffusion: Diffusion/Delay, Delay:
Feedback/Delay + T switch; Blur/Off: inactive). LEDs: click = enable,
right-click = solo. Link buttons move both level faders together. Routing
boxes: detection sidechain input (FL's input number), transient / sustain
send tracks (choosing one drops that level to -120 dB, as in FL). Display:
waveform plus T (green) / S (orange) envelopes, scroll speed slider and W/T/S
toggles on mouse-over, right-click pauses. Gear: Theme menu (4 themes).

## Approximations / open questions

- Detector internals (see above).
- Warmth's large-signal behaviour: FL's warmth also lowers the harmonics at
  high drive (300 Hz, drive 18 dB: h3 0.338 -> 0.193 at 0.5) through a
  structure not identified; the clone applies only the measured allpass.
- Diffusion network topology and its exact levels (calibrated within a few dB).
- Delay echo kernel (FL's has a 4th tap) and FL's ~2 sample shorter delay;
  FL's tempo-synced times come out 1-3 ms short of the nominal step length.
- FL's bounce at a delay curve of exactly 0.0 collapses the taps onto 1/17 s
  multiples (numerical singularity); the clone uses the linear limit.
- Send routing cannot be measured in the host; the clone sends the part after
  its effect, before the level fader, nothing while the part is disabled.
