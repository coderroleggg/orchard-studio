# Pitch Shifter (`pitchshifter`)

FL's Pitch Shifter (engine by Kyle and Steve Spratt): two pitch-shifting
engines, Voice and Music, behind tabs, plus an echo section and a mix.
Sources: form `Pitch Shifter.txt` (747 x 280), the manual page, four
screenshots (Voice, Music, spectrum options, harmonics), and the FL binary
through `flfxhost` (info, sweeps, about 90 renders at 48 kHz with
hand-built state blobs). All numbers below were measured on FL's output.

## Parameters (FL Tags, GetName texts)

| # | key | name | range / default | text |
|---|---|---|---|---|
| 0 | pitch | Pitch | -1200..1200 / 0 | "+2.00 semitones", "0.00 semitones" |
| 1 | formant | Formant | -1200..1200 / 0 | same |
| 2 | chan | Analysis Channel | 0..2 / 0 | LEFT / RIGHT / LEFT + RIGHT |
| 3 | mix | Mix | 0..2400 / 2400 | round(v / 24) % |
| 4 | dur | Duration | 2000..15000 / 8500 | v / 100 "ms" (20..150 ms) |
| 5 | dens | Density | 100..500 / 200 | "%" (overlap 1..5) |
| 6, 7 | jit, rand | Jitter, Rand | 0..100 / 0 | "%" |
| 8 | delay | Delay | 1..768 / 768 | 1 + (v - 1) 999 / 767 ms ("1000.0ms"); tempo: v / 48 steps ("9:0 steps") |
| 9 | fb | Feedback | 0..100 / 0 | "%" |
| 10 | dmode | Delay mode | 0..3 / 0 | OFF / POST / PRE / NO SHIFT |
| 11 | fcorr | Formant correction | 0..65536 / 65536 | round(v / 655.36) % |
| 12 | pmode | Pitch mode | 0..3 / 0 | RELATIVE / ABSOLUTE C4 / C5 / C6 |

State blob (75 bytes): int32 version 7, the 13 parameters as int32, the
formant correction again, then bytes: tempo sync, engine (0 Voice, 1 Music),
three zero bytes, pitch detector (0 FAST, 1 ACCURATE), three zero bytes,
int32 spectrum speed (2000 / 1000 / 500), spectrum enabled, monochrome.
Defaults are the Default preset (Music engine, density 200%, jitter and rand
0, formant correction 100%, ACCURATE); the constructor state is Voice/FAST
with density 300%, jitter 30%, rand 20%, correction 0. The 25 factory
presets (Music\*, Voice\*) were decoded from the plugin's state and are in
the def with their engine / tempo / detector.

## Measured facts

- Wet path ends in tanh: a -6 dBFS sine comes out at -6.52 dB with its 3rd /
  5th harmonics at -40.6 / -73 dB in both engines; an impulse of 1 gives
  0.7624. The echo section takes the post-tanh signal.
- Mix is linear (dry 1 - m, wet m): mix 50% gives -6 dB dry and wet.
- Latency (reported): Voice 1228 / 2457 samples at 44.1 kHz and 1336 / 2674
  at 48 kHz (FAST / ACCURATE, 27.85 / 55.71 ms); Music 0. The Voice wet
  output is 4 samples later than reported (vowel with vibrato: best match at
  1340, r = 0.988), the dry path 1 sample earlier (1335).
- Music: grains of D (Hann) every D / Density from the plugin's start
  (preroll 0: copies of an impulse at +12 at 2042 / 3062; after a 0.25 s
  preroll at 122 / 1142 / 2162 / 3182), reading at the ratio r from
  max(0, (r - 1) D) + 4 samples back; gain 1 per grain (no normalisation:
  density 300% at pitch 0 gives 1.5x before tanh). Reads: Catmull-Rom for
  r <= 1 (impulse at -12: 0.071 / 0.126 / 0.071, -0.008 at 1.5 samples), a
  low-passed kernel above (impulse at +12: a single 0.5 x window sample).
  Sine spectra: lines (k - frac(f D / density)) apart around r f, e.g. +12 on
  440 Hz: 887.06 / 863.53 / 910.59 Hz at -8.43 / -19.59 / -37.47 dB.
  Density 1: tremolo (click gains 0.46 0.07 0.31 0.31 0.06 0.46 0.02 0.38).
  Jitter lengthens hops (gaps, never more than one window: max 0.463);
  Rand delays grain starts by up to D / 2.
- Voice: TD-PSOLA. Grains are two input periods (Hann) around pitch marks,
  placed one output period apart, no normalisation (pulses keep their
  amplitude at +12; formant-preserving shifts of broadband sound gain about
  +6 dB per octave up). Each grain is resampled by the formant factor
  f = 2^(Formant/12) x 2^(Pitch (1 - correction) / 12): correction 0 moves
  formants with the pitch (a vowel's 700 Hz formant goes to 1.4 kHz at +12),
  100% keeps them (the manual's description is reversed). Checks: +12 on a
  220 Hz sine at 0% gives 440.18 Hz at -6.50 dB; at 100% it is silent
  (-60.6 dB rms) because the grain spectrum has a zero at 440 Hz; -12 at
  100% on 440 Hz gives 440 / 219.8 / 660.2 Hz at -12.33 / -18.5 / -18.5 dB;
  Formant +12 at pitch 0 gives 880 / 440 / 1320 Hz at -12.3 / -18.5 /
  -18.5 dB, Formant -12 silence.
- Detection: both detectors shift harmonic tones from 55 Hz up to at least
  2 kHz and leave 35..50 Hz unshifted (unvoiced input passes unshifted).
  The analysis channel's marks drive both channels.
- Absolute modes ignore the input pitch: targets C4 / C5 / C6 in FL's
  numbering (130.8 / 261.6 / 523.3 Hz) x 2^(Pitch / 12); a five-note melody
  comes out at 261.6 Hz; formant movement follows the Pitch slider only
  (correction 0 and 100% give identical output at pitch 0).
- Echo (delay 1000 ms, feedback 50%, pitch 0): No shift 0.3338 / 0.1670 /
  0.0833 rms (y = s + fb D(y)); Post 0.3338 / 0.1649 / 0.0822 (the echo goes
  back through shifter and tanh: y = W(x + fb D(y)), so each echo of a +12
  burst is another octave up); Pre: silent for one delay, then 0.3340 /
  0.1649 (y = D(W(x + fb y))); Off ignores the feedback; 100% sustains
  forever. Tempo sync: v / 48 steps of a quarter beat.

## DSP (ours)

- Music engine exactly as measured (grain clock, offsets, Hann, gain 1,
  Catmull-Rom for r <= 1, 8-tap windowed sinc with cutoff 1 / r above).
  Matches FL's sine spectra within 0.05 dB and impulse copies within 2%.
- Voice engine: YIN on the analysis channel decimated to about 12 kHz (window
  28 / 56 ms like FL's latency), refined at full rate; voiced 53 Hz..2.2 kHz
  with hysteresis; pitch marks one period apart aligned by cross-correlation
  of the low-passed signal; synthesis marks from the mark spacing / ratio
  (or the absolute target period); grains read with Catmull-Rom or the sinc
  reader at the formant factor. Unvoiced: identity grains (exact pass).
  Delay alignment as FL (wet latency + 4, dry latency - 1).
- tanh, echo topologies, linear mix, smoothing (mix and feedback 10 ms,
  delay time 50 ms glide), finite-output guard, bounded tail (grain length
  plus echo decay, capped at 31 s; the No shift loop is soft-limited above
  4.0 so 100% feedback cannot run away).

## Exact vs approximated

Exact: texts, ranges, presets, state options, latency (44.1 / 48 kHz),
Music engine timing and gains, mix law, tanh, echo topologies and levels,
detection range, absolute targets, formant model. Approximated: FL's grain
kernel above r = 1 (FL's is a slightly smoother low-pass), Voice pitch marks
(FL's drift a little, which costs it 10..20 dB of harmonics above 2 kHz on a
synthetic vowel after a shift and puts a fifth 6 cents sharp; ours stay
aligned), unvoiced input (FL scrambles noise with 34..44 ms grain delays;
ours passes it), and the random sequences of Jitter / Rand.

## Editor

Form coordinates: tabs, X/Y pad (left-click glides to the point and follows
the mouse, right-click jumps; Pitch vertical, Formant or Duration
horizontal) over a scrolling input spectrogram (Voice blue, Music
green-yellow, or monochrome; Speed is the time across the pad), sliders
with semitone detents for Pitch / Formant, the knobs, arrow combos (pitch
mode, detector, analysis channel), DELAY with T, FEEDBACK, the delay mode
switch and MIX, value boxes in FL's display units. The options button and
the window menu hold the spectrum options, engine, detector and tempo sync.
The X/Y cursor is a plain ring (FL's bitmap cursor is not copied).

## Open questions

- FL's interpolation kernel for 1 < r < 2 and its Voice mark placement.
- The real time span of the spectrum speeds (taken as 2 / 1 / 0.5 s).
