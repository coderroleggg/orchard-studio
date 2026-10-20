# Vintage Phaser (FL: Vintage Phaser)

Electro-Harmonix Small Stone model (engine Daniel Schaack, OTA DSP Dario Sanfilippo,
UI Miroslav Krajcovic). Measured from FL 2026's binary with `flfxhost` (complex
responses from impulses and noise, a two-probe phase demodulator for the LFO, sine
harmonics, step responses, null tests). Files: `src/model/fx/plugins/vphaser.ts`,
`src/engine/effects/plugins/vphaser.ts`, `src/ui/plugins/fx/vphaser/index.tsx`,
`tests/fx/vphaser.test.ts`.

## Controls (36)

Frequencies 1.25 x 16384^x Hz (Min, Max, Manual), Speed r1 (r2/r1)^x with the Rate
frequencies 0.025 + 149.975 x^4 Hz, Feedback text 99 x % (gain 0.9 x), Tension 99 x %,
phases 360 x deg, delay time (v-1)/767 s (synced: v ticks, 48 per step), delay LP
320 x 64^x, HP 20 x 1024^x Hz, Mix 0..100 % wet, Noise -90..-40 dB, colour gain 30 x dB
/ freq 50 + 600 x Hz, input / feedback HP 5 + 195 x^3 Hz, LFO scale / pull 100 x %,
Drive 30 x dB. Synced Speed uses Vintage Chorus's tick law. Texts are computed in
single precision with decimal halves rounded up: 1371996 / 1373928 swept texts match
(the rest are last-digit ties of the exponential frequencies). Default preset = the
constructor; 16 factory presets (a few legacy ones store out-of-range values; clamped).

## DSP (measured)

- Signal flow: input HP (first order) -> dry (44 samples late) + phaser -> linear Mix
  -> [V2 output filter] -> colour low shelf (RBJ, Q 0.5) -> + noise -> delay. Latency 44.
- Phaser: 4 identical first-order allpasses at the oversampled rate (4x; HQ: V1 8x,
  V2 16x), coefficient from tan(pi f / osr): phase fits to 0.005 deg. FL's resampler is
  flat to 22 kHz and folds the band edge (-1.76 dB at 22 kHz for 1.8 kHz stages): it is
  a square-root-Nyquist design; ours is a 79-tap filter optimised for the same
  property (+-0.05 dB) followed by least-squares stages, 44 samples in total.
- V1: feedback 0.9 x Feedback taken one oversampled sample late through the Feedback
  HP, which also sits on the wet output (exact loop identification); Invert flips it.
- V2: stages are OTA one-poles whose integrating current tanh(0.18 e)/0.18 and output
  current tanh(0.115 e)/0.115 saturate (e = input - capacitor), linearised per sample;
  delay-free feedback (Feedback HP only in the loop); stage frequency x 2^(1/400);
  Drive scales in / out. Fitted to FL's 3rd-harmonic level, phase and compression
  (e.g. 441 Hz at 0 dBFS, 968 Hz stages, Drive 15 dB: gain -0.30 dB, H3 -35.3 dB). FL's
  V2 output filter (steep low-pass at 20 kHz, ~3.8 samples) is copied as a 128-tap FIR
  of its measured response (HQ has its own).
- LFO: triangle / sine from phase 0 (double precision), 22 samples ahead of the input,
  R = L + LR Phase; Start phase only for tempo sync. Tension: s -> (1 - e^-ks)/(1 - e^-k)
  with k(t) measured (0.13 at 10 %, 2.18 at 50 %, 6.45 at 99 %). Sweep position
  w = 1 - pull x^4 - (1 - (1 - scale) x)(1 - s), x = Speed position; f = Min (Max/Min)^w.
- Delay: echo = Delay mix x linear-interpolated tap, direct always passes; stereo per
  channel with quadratic laws (direct q + 0.293 q(1-q), echo sqrt2 - 0.121 q - 0.293 q^2);
  feedback = fb x LP(HP(echo)) one sample later; time glides with a 43.4 ms one-pole in
  single precision, which stalls short of the target (0.12 samples at 45 ms, 0.94 at
  260 ms) - replicated; Keep pitch = 100 ms linear crossfade between taps.
- Noise: white floor + white noise through a one-pole whose cutoff follows the LFO
  (130 Hz .. 1 kHz; 100 Hz in Manual), added after the shelf (echoed by the delay),
  -52.3 dB rms at -40 dB in Manual mode; the gate closes on silence.
- Nulls (2-3 kHz band noise): V1 static -52..-64 dB, V2 small signal -60..-66, V2 at
  0 dBFS -46 (with feedback -34), LFO cases -45..-55, delay -60..-64, sync identical.

## Our deviations

- Parameter changes are FL's (measured with `--at`): every control applies at once
  except the delay time (FL's single-precision 43.4 ms glide, or the 100 ms Keep pitch
  crossfade). Differences: FL applies the phaser controls (frequencies, Feedback, Drive,
  Invert, Engine) 22 samples (0.5 ms) ahead of the audio - its control path leads the
  oversampled core - while ours act at once on the core (-12..-20 dB for ~4 ms after a
  jump); a Colour gain jump rings differently for ~40 ms; Drive and Engine switches
  settle differently (-22..-40 dB for ~30 ms); the first ~50 ms after creation differ by
  about -29 dB (FL's start-up state).
- Resampler and noise are our designs (flat within 0.05 dB / spectra within 2 dB).
- Tail Infinity with ungated noise; otherwise the delay ring time (capped 30 s).

## Editor

Form geometry (747 x 277, advanced strip always present; the gear hides it since the
window size is fixed). Brushed silver, navy frames, gold / red / grey panels, white
metal knobs with lit dot rings, dark knobs with tick rings, faders, toggles (Type,
Engine, Inv FB), LED switches, "T" sync buttons, the delay lamp and the Tension preview.

## Open questions

- FL's exact resampler and noise generator; heavy-drive V2 (30 dB) H3 is ~4 dB off.
