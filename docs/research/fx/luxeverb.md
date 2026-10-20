# LuxeVerb (FL: LuxeVerb)

Modern algorithmic reverb (Kyle Spratt). Editor 940 x 450: blue top panel (Input, Reverb, Pitch,
Output) and the dark Envelope panel (envelope controls, spectrogram graph, output meter).
Measured on FL's plugin with `flfxhost` at 48 kHz (`tests/fx/luxeverb.test.ts` keeps reference values).

## Parameters

49 parameters in FL's index order (`src/model/fx/plugins/luxeverb.ts`), names from FL's GetName.
Value-text laws (all verified with `sweep`):

| control | law |
|---|---|
| gains (input wet gain, dry, wet) -600..1500 | dB = -60 + 75 sqrt((v+600)/2100) ("0.0dB" at 746; -0.0 prints 0.0) |
| input high cut 40..20000 | 40 + 19960 t^(2/3) Hz |
| input / feedback low and high cut 20..5000 | 20 + 4980 t^2 Hz; envelope low cut 20 + 1980 t^2; peak freq 40 + 9960 t^2 |
| decay 250..20000 | 0.25 + 19.75 t^2.5 s ("7.000s") |
| pre-delay 0..5000 | 500 (v/5000)^2 ms |
| synced times 1..768 | steps:ticks, 48 ticks per step ("4:0", "2:24") |
| feedback / FF 1 delay 10..5000 | v/10 ms; FF 2 delay 0..1000: 1 + 0.499 v ms |
| peak Q 25..5000 | 0.25 + (v-25) 4.75/4975 |
| percentages | `%2d%%` (" 5%"), offset = v-50 |

Defaults are FL's factory **Default** preset (FL applies it on insertion; it differs from the
plugin's built-in state in 40 parameters). All 174 factory presets are in the def (generated from
FL's own state blobs: 13-byte header + 49 int32 + 2 bytes). Non-parameter state: four tempo-sync T
buttons (blob bytes 8, 9, 209, 210; non-zero = on, which turns the Default preset's FF syncs on),
sidechain input number, display toggles.

## Reverb core (behavioural model, calibrated)

FL's network could not be reconstructed exactly; these are the measured facts the model reproduces:
- RT60 = decay setting at mid frequencies, independent of size (FL 0.5 -> 0.51 s, 2 -> 1.90, 16 -> 14.9).
- First arrival: 14.3 / 17.3 / 32.0 ms at size 1 / 20 / 100 (table); predelay adds to it (FL glides
  pre-delay changes over ~1 s).
- Line lengths: FL's first-pass "same side" pulses give the 16 lengths (17..105 ms at size 20),
  scaled by (size + 5.8)/25.8; two common early taps (mono) at the first arrival and +0.2438 (size + 8.3) ms;
  a +0.25 echo 0.312 (size + 5.8) ms after each arrival; in-loop allpasses for density.
- Every line is read fractionally (cubic = HQ, linear = HQ off): this reproduces FL's size- and
  HQ-dependent HF loss (RT at 16 kHz, decay 8 s: FL 2.03 / TS 2.19 HQ, FL 1.15 / TS 1.14 non-HQ),
  and why highs die out in freeze.
- Brightness: per-line first-order shelf, HF RT ratio from FL's plateaus (0.062 at 0 % ... 1 at 100 %),
  transition 2.0-2.7 kHz. Band RTs within ~3-5 % of FL at 25/50/70/85/100 %.
- Character = butterfly rotation angle: 0 independent combs (gritty), 0.5 Hadamard (smooth),
  1 swapped pairs -> ~500 ms "bunching" period at size 100 (FL 482 ms, TS 497 ms).
- Diffusion crossfades the plain and fully diffused input (FL: energy dips to 50 % at 50 %).
- Wet energy matched to FL within ~5 % over decay 0.5-16 s, size 1-100, brightness, HQ (per-size gain table).
- Stereo: L input feeds lines 0-7, R lines 8-15; raw L/R correlation ~0.26 like FL; width = M/S side gain.
- Modulation: per-line sine LFOs, excursion 14.5 ms x amp^0.7 x size factor (1.4 / 1 / 3.8 at size
  1 / 20 / 100), fitted to the spectral spread of a sustained sine (within ~30 % of FL).
- Freeze: input muted, loop lossless (brightness off, interpolation loss stays); Sustain: input open.

## Other sections

- Input HC: bilinear one-pole **without pre-warping** (FL: 20 kHz acts as 14.2 kHz at 48 kHz); LC first order.
- Output peaking EQ: FL's form H(s) = (s^2 + (K/Q) s + 1)/(s^2 + s/Q + 1) (constant-Q poles; boosts
  broader than cuts) — matches FL to 0.1 dB.
- Limiter (L): RMS detector on the wet signal before the wet gain, -11 dBFS (FL's ceiling varies with
  the reverb's crest factor exactly like an RMS limiter).
- Pitch: granular shifter with FL's 15 Hz crossfade rate (2 heads, 133 ms grains). Feedback loop:
  0.54 x gain (measured), mix = reverb out vs reverb in, first-order filters, delay; FF voices feed the reverb.
  Reverb off bypasses diffusion and the tank.
- Envelope: rectified input (or sidechain) -> low cut -> attack/decay follower
  (tau = 0.03 + 0.61 attack, 0.033 + 0.445 decay, seconds) -> smoothing. Wet mode:
  wet dB += scale (2 (env - thr)+ - 78.4 offset), clamped -60..+15 (measured, static curves match);
  decay mode: decay += 0.94 s per dB over threshold x scale (offset has no effect in FL).

## Open questions / approximations

- Exact internal topology (number of lines, taps) unknown; early pulse pattern only approximated.
- Pitch shifter quality / latency and the shimmer loop level for non-zero pitch (FL's +12 loop is louder).
- The meaning of FL's "peaks" display toggle (we draw the wet peak trace).
