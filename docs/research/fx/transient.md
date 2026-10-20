# Transient Processor (`transient`)

FL Studio 2026 "Transient Processor" (Image-Line, DSP by Daniel Schaack). Category Dynamics.
Editor 547 x 318 (form `SynthPanel`). Everything below was measured on FL's own binary with
`flfxhost` (render / sweep / info) unless marked otherwise.

## Parameters (FL index = form Tag, all values in FL control units)

| # | key | FL name | range (def) | mapping | value text |
|---|---|---|---|---|---|
| 0 | attack | Attack | 0..160 (80) | a = (v-80)/80, amount q = a^2 | `-100%`..`100%` |
| 1 | drive | Drive | 0..160 (0) | d = v/160, k = 0.1+9d (d<=0.1), else 15^((d-0.1)/0.9) | `0%`..`100%` |
| 2 | release | Release | 0..160 (80) | as Attack | |
| 3 | gain | Gain | 0..160 (80) | (v-80)/80 * 9 dB | `-9.0 dB`..`9.0 dB` (no `+`) |
| 4/5 | attackShape / releaseShape | Attack/Release Shape | 0..2 (1) | Sharp / Mid / Slow: detector time constants x1 / x2 / x4 | `Sharp` `Mid` `Slow` |
| 6 | splitFreq | Split Frequency | 0..160 (80) | 5 + 995 (v/160)^2 Hz (default 253.8 Hz, the manual's "260 Hz") | `253.8 Hz` |
| 7 | splitBal | Split Balance | 0..160 (80) | dry = min(1,(160-v)/80), wet = min(1,v/80), linear | `100% Wet`, `x% Wet` below 80, `x% Dry` above |
| 8 | effect | Effect | 0..1 (1) | bypass | `Off`/`On` |

All 974 value texts match FL exactly (single-precision chains and FL's rounding are reproduced in
`src/model/fx/plugins/transient.ts`). The factory `Default.fst` equals the constructor defaults.
All 10 factory presets are in the def (values read with `info --preset`).

## Signal flow (measured)

```
in -> TPT one-pole lowpass at Split Frequency; highpass = in - lowpass (sum is exactly flat)
highpass -> transient gain g(t) -> soft clipper y = S(k x)/k  -> * wet
lowpass  ------------------------------------------------------> * dry  -> sum -> * Gain -> out
```

* Detector input: |HP L| + |HP R| (stereo-linked by summing; checked against max/RMS/mid).
* Soft clipper: S(u) = u(27+u^2)/(27+9u^2), clamped to +-1 for |u| >= 3 (rational tanh). Fit error
  1e-5 at every drive. Active even at Drive 0 (k = 0.1: -0.003 x^3).
* Parameter smoothing: one-pole on the control values, tau = 17.3 ms (gain 0 -> -9 dB reaches
  -3.97 dB after 10 ms, -8.50 dB after 50 ms). FL's smoother starts only once audio arrives.
* Default settings and gain / mix / drive are bit-exact against FL (-120 dB error on a drum loop).

### Transient gain

Two sections (attack, release); each has one detector per direction. A section's signed
contribution is `+q*min(D, max)` (boost, amount > 0) or `-q*D` (cut, amount < 0), q = amount^2.
The contributions **add** (verified: 0.003 dB rms): s = s_att + s_rel, gain = 1+s (s >= 0) or
1/(1-s) (s < 0). Ceilings: attack boost 1+2.24 q (3.24x at +100%), release boost 1+6.6 q (7.6x).

Followers on the detector input a (peak followers: e = a > e ? attack step : e * release):

| path | detector | constants at 48 kHz (Sharp / Mid / Slow) |
|---|---|---|
| attack cut | fast/slow - 1; fast instant attack, slow one-pole attack, same release | slow attack 41.4 / 84.4 / 172.5 smp, release 4000 smp |
| attack boost | k e1/e2 - 1 | e1 attack 3.3/3.6/5.0, e2 attack 39.6/74/154.6 smp, release ~4150 smp, k 0.978/0.974/0.963 |
| release cut | e1/e2 - 1, both instant attack | e1 release 83469 smp (1.74 s), e2 release 1042 / 2085 / 4169 smp |
| release boost | 0.44 (e1/e2s - 1) - 0.095, e2s = e2 smoothed ~1 smp | e1 release ~88k smp, e2 release 1157 / 2307 / 4612 smp |

The release boost is negative in steady state (-0.8 dB at +100%), which is FL's behaviour.

* Release cut is exact (0.004 dB rms against FL on stepped tones, -116 dB output error on drums).
* The other three paths are fitted: gain-curve error 0.15-0.4 dB rms on drums and stepped tones,
  output-envelope error 0.05-0.47 dB rms on a drum loop (`DL_Classic Break`). The attack follower
  is not exactly a one-pole on |x| (its effective attack rises when the input is near the
  envelope; a least-squares fit suggests a slightly slope-emphasised input), so those constants
  are a best fit across signals.
* Startup: FL primes its followers at the first non-silent block (peak >= 1.5e-6) at that
  block's level, so the first hit after loading is not boosted. Through later silence the
  followers keep decaying (no re-priming). The clone does the same and reports `tail = 2` s so
  the mixer keeps it running while the followers decay.

## Editor

Form coordinates for every control. FL's vector wheels (segmented outer ring, thick black rim,
two-tone body whose dark half follows the pointer, lime pointer dash; centre tick lime when a
bipolar wheel is centred), shape spinners with curve icons, ON/OFF switch, Drive LED (lit while
the soft clipper bends the signal), help and block-diagram buttons (the diagram is drawn as an
SVG overlay; also in the window menu), FL volumeters (+3..-37 dB, linear dB scale, peak hold),
and the meter graph (input peaks green, output peaks purple, overlap grey, transient process red,
centre = 0 dB, +-12 dB full scale; I/O/S toggles and scroll-speed slider on mouse-over; click to
freeze). The graph view settings are non-parameter state (`visI`, `visO`, `visS`, `speed`).

## Open questions

* Exact attack-follower law (see above) and the second-order details of the release boost
  (onset dip, compression near the 6.6 ceiling).
* The graph's vertical scales (peaks linear 0..1, gain +-12 dB) are estimated from the manual
  screenshot.
* The LED threshold is a guess (FL only says it lights when saturation is applied).
