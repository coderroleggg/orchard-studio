# Chorus (FL: Fruity Chorus)

Smart Electronix port hosted by FL's generic `TTestPlug` editor. Sources: FL's form
(`Fruity Chorus.txt`), the manual page, and measurements of FL 2026's own binary with
`flfxhost` (info / sweep for texts, impulse-train renders for the DSP). Files:
`src/model/fx/plugins/chorus.ts`, `src/engine/effects/plugins/chorus.ts`,
`src/ui/plugins/fx/chorus/` (`TestPlugEditor.tsx` is shared with Flanger and Phaser),
`tests/fx/chorus.test.ts`.

## Controls (FL order = parameter index)

| # | Name | Range (def) | Mapping | FL text |
|---|---|---|---|---|
| 0 | Delay | 0..1024 (512) | 0.05 + v/1024 x 29.95 ms (minimum delay) | `15.02500 ms` |
| 1 | Depth | 0..5000 (2250) | v/1000 ms (sweep width) | `2.25000 ms` |
| 2 | Stereo | 0..1024 (341) | right LFOs lead by v/1024 x 180 deg | `59 degrees` (floor) |
| 3-5 | LFO 1/2/3 Frequency | 0..5000 (1500/2500/3500) | 5 (v/5000)^2 Hz | `0.45000 Hz` (float32) |
| 6-8 | LFO 1/2/3 Wave | 0..1024 (0/0/0) | floor(3v/1024): sin, sin^3, multi-sin, multi-sin^3 (only at 1024) | `sin` |
| 9 | Cross Type | 0..100 (0) | v/100 > 0.25: Process LF, else Process HF | `Process HF` |
| 10 | Cross Cutoff | 0..5000 (2500) | MIDI note 127 v/5000 (8.18 Hz .. 12.5 kHz) | `320.24371 Hz` |
| 11 | Wet only | 0..1024 (0) | v/1024 > 0.25 | `no` / `yes` |

Defaults are FL's "Default" factory preset, which differs from the constructor only in
LFO 1 Wave (0 instead of 23; both read "sin"). The 8 factory presets are in the def.
The manual's "0 to 360 degrees" for Stereo is wrong: FL's text and DSP stop at 180.
All texts match FL's 31256 sweep values exactly except Cross Cutoff, where FL's
single-precision pow pipeline differs in the 5th decimal for about half of the values.

## DSP (measured)

- Three voices per channel, each a delay line read with **linear interpolation**;
  voice k's delay = Delay + Depth x (u_k + 1)/2, u_k = LFO k in -1..1, per sample.
- LFOs start at phase 0 when the plugin is created and run freely (no tempo sync, no
  reset on play). The right channel uses the same LFOs plus the Stereo phase.
- Waves: **sin = parabolic sine** (16x(0.5-x), fits FL to 0.07 samples; a true sine is
  8x worse); sin^3 = its cube; **multi-sin = (sin x + (sin 2x + sin 3x)/3) / 1.27614**
  (true sines, Fourier fit residual 4e-4); multi-sin^3 = its cube. Re-measured with
  the host's bit-exact copies of FL's wavetables (`WaveTables[0..5]`, which Fruity
  Chorus reads): same result, so "sin" is computed, while multi-sin follows the true
  sine table (we use a 4096-point table of the exact function).
- Cross-over: bilinear one-pole low-pass y = b(x + x[-1]) + p y[-1], p = (1-t)/(1+t),
  t = tan(pi fc/sr), b = (1-p)/2; the cut-off is clamped at 0.24396 sr (10.76 kHz at
  44.1 kHz, scales with the rate). Process LF feeds the voices with LP(x), Process HF
  with x - LP(x). The dry path is always full band.
- Output = 0.7 x (0 when Wet only) + 0.42 x sum of the three voices. No feedback,
  no latency; tail = 0.04 s (max delay 35.05 ms).
- Null test against FL: unmodulated paths (depth 0) null at -70 to -143 dB; modulated
  paths -27 to -42 dB with 1 kHz-band noise, limited by FL's own nondeterminism below.

## Approximations / differences

- FL's LFO phase accumulates in float32: effective rates are 0.01-0.12 % low
  (0.8 Hz -> 0.79908 Hz). We accumulate in float32 too (Math.fround), which moves our
  rates toward FL's but not exactly onto them (0.8 Hz -> 0.79962 Hz). FL's start phase
  also varies by up to ~0.6 deg between runs, even with identical input and the exact
  wavetables (static voices land 0-1 sample apart); we start at phase 0.
- Parameter changes: like FL (measured with `--at`), every control applies at once -
  Delay, Depth and Stereo jump (clicks), waves switch, Wet only, Cross type and cut-off
  switch. The cross-over filters the delay-line input, so a cut-off change reaches the
  output after the voice delay (15 ms at the default Delay). Matches FL at -67..-99 dB.
- Display texts for Cross Cutoff: last digit may differ by 1 (see above).

## Editor

FL's `TTestPlug` grid at form coordinates: 12 bevels (160 x 45, #50585b on #444a4f),
caption tab (106 x 16, #5a636a, caption #c3d2d9), value text (light cyan #dcffff) and a
46 x 40 knob: 270-degree ring (arc #d4ffff, r 15.3-19.3), two-tone body (r 14.7)
whose light half turns against the pointer. Captions follow the 2026 form
(`LFO 1 FREQ`; the manual's screenshot shows an older `LFO 1 FREQ.`). FL has no
display or plugin menu items for this plugin.

## Open questions

- Exact float32 formulation of FL's LFO accumulator (would reproduce the rate drift).
- FL's Cross Cutoff text pipeline (single-precision note-to-frequency).
