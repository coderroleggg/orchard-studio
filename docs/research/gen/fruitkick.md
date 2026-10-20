# Fruit Kick (FL: Fruit Kick)

**Status: calibrated against FL 2026's renders (test host).** The DSP is a
port of FL's own code (Fruit Kick_x64.dylib 26.1.6, class TTestPlug), and it
renders FL's output to float32 rounding (-148 dB residual) in every tested case.

Files: `src/model/gen/plugins/fruitkick.ts` (definition, texts, presets),
`src/engine/gen/plugins/fruitkick.ts` (DSP), `src/ui/plugins/gen/fruitkick.tsx`
(editor), `tests/gen/fruitkick.test.ts`. Fruit Kick is the instrument
framework's reference plugin (docs/gen-framework.md).

## Sources

- FL 2026 (26.1.6) `Plugins/Fruity/Generators/Fruit Kick/Fruit Kick_x64.dylib`
  (arm64 slice, `otool -tV`): TTestPlug VMT 0x201708; ProcessParam 0x5cec0,
  TriggerVoice 0x5d5b0, Voice_Render 0x5d800 (the voice), Gen_Render 0x5da10
  (FL's embedded channel sampler renderer, 0x1c04a0..0x1c06a0), the pitch to
  increment helpers 0x607e0 / 0x60830, SaveRestoreState 0x5c800. The editor
  form (`scratchpad/gen/forms/Fruit Kick.txt`), flags 0x11600031, 99 parameters.
- FL's manual page plugins/Fruit Kick.htm (MAX / MIN / DEC / A. DEC / CLICK /
  DIST), the eight factory presets.
- The test host: `flfxhost render "Fruit Kick" ...` at several keys,
  velocities, settings, presets and sample rates; `sweep` for every text.

## Parameters

| Index | Key | Name | Range | Default | Text |
|---|---|---|---|---|---|
| 0 | max | Max freq | -2400..3600 | 0 | `0%` |
| 1 | min | Min freq | -1200..1200 | -600 | `-50%` |
| 2 | freqDecay | Freq decay | 0..256 | 64 | `25%` |
| 3 | ampDecay | Amp decay | 0..256 | 128 | `50%` |
| 4 | click | Click | 0..64 | 32 | `50%` |
| 5 | dist | Distortion | 0..128 | 0 | `0%` |

- Value texts: `round(v x 100 / max)%` with ties away from zero, also below
  zero (Max freq -2400 reads `-67%`, -18 reads `-1%`, -17 `0%`). [C: sweep of
  all values of the six parameters, 0 mismatches]
- FL also lists parameters 6..98 (its embedded INS envelopes / LFOs / filter);
  here they are the channel's INS settings (`ins: true`).
- State: version 0 (factory presets) = the six values plus FL's internal end
  increment (the former `seed`: 4504291 = round(523.25 Hz x 2^32 / 44100 x
  2^(-4200/1200)) for Min freq -600), which FL recomputes on load; version 1 =
  the six values plus FL's 372-byte embedded sampler settings. `seed` is
  dropped by normalize.

## Presets [C: FL's .fst files]

Classic, Clicky, Default, High, Low, Punchy, Pure click, SciFi (values in the
definition).

## DSP [C: FL's code, verified sample by sample]

- Sine: FL's host wavetable 0 (16384 points, `sin(2 i pi / 16384)` as float;
  `FL_WAVES[0]`), read at index phase >> 18 of a 32-bit phase; the phase
  advances by the increment rounded half to even.
- Increment for c cents relative to C5: round(incC5 x exp(c ln2 / 1200)) with
  incC5 = float(2247346493527.166 / rate) (523.2511306 Hz x 2^32 / rate).
- TriggerVoice: start = clamp(FinalLevels.Pitch x 0.5 + Max + 1200, Min - 3600,
  4800) cents (single precision), increment stored as a float; phase = Click <<
  24 (Click 64 = a quarter cycle: a cosine start); amplitude 1.5. FL reads the
  pitch only here: later pitch changes (slides, pitch knob) do not reach a
  running voice; the kick follows the key at half rate (24 keys up = 1 octave).
- End increment: Min - 3600 cents (independent of the key), an integer compared
  as a float.
- Per sample: out = float(table x amp); phase += rint(inc); amp *= ampFactor;
  inc = inc > end ? inc x freqFactor : end.
- Factors: x = 1 - v / 256; e = float(exp(x ln 1001) - 1); amp: float(0.99998 -
  4.98e-6 e), freq: float(0.9997 - 9.7e-6 e); then FPC's Power(f, 44100 / rate)
  (IntPower when the exponent is an integer). Default Freq decay 64: tau = 11.2 ms.
- Distortion (Distortion > 0): FL's host DistWave_32FM (type A, threshold 10)
  on the voice buffer: dry = 1 - d, wet = float(3.3 d), mul 0.1, d = Dist / 128
  (shared core: src/engine/effects/plugins/distructor/fastdist.ts; live kernel
  truncates, export kernel interpolates).
- End: Voice_Render reports the end once amp < 0.0002 (checked per call); FL
  then drops the voice after that host block. Here: after that engine block.
- Note off (FL's embedded sampler, volume envelope off): a raised-cosine fade
  0.5 + 0.5 cos(pi k / 442), k = 1..441 from the release sample, then the
  voice ends; 441 samples at every sample rate (measured at 22.05 / 44.1 / 48 /
  96 kHz).
- Output: unity, centred; the channel applies velocity (FL's curve), volume and
  the pan law (FL: 1.5 x sin(pi/4) x 0.7071 = 0.75 at the first sample).

## Editor

FL's form at its coordinates (380 x 80): four 1 px outlined groups (MAX / MIN /
DECAY, AMP DECAY, CLICK, DIST), 40 px knobs turning 300 degrees with an orange
(#ffb43c) value arc, captions in a condensed bold face; colours sampled from
the manual's screenshot.

## Fidelity

| Case (FL vs ours, 44.1 kHz, raw channel) | Residual |
|---|---|
| default key 60 / 72 / 30 / 0 / 127, velocity 64, overlapping notes | -140 ... -149 dB |
| Distortion 20 / 128, Click 0 / 64, Max 3600, Max -2400 + Min 1200 | -148 dB |
| presets Classic, High, SciFi | -148 dB |
| presets Punchy, Amp decay 0 (voice end inside a host block) | -85 dB (end timing only) |

- Exact: parameters, texts, presets, the whole voice (float32 output
  rounding), release fade, pitch handling, distortion (live kernel).
- Approximate: where the voice is cut after it falls below 0.0002 (FL: end of
  the host's Gen_Render call, split at ticks; here: end of the 128-frame
  engine block); the INS envelopes / filter are the channel's (FL pushes them
  into its embedded sampler through an undocumented dispatcher call).
