# Vintage Chorus (FL: Vintage Chorus)

Juno-6 BBD chorus model (engine: Daniel Schaack, UI: Miroslav Krajcovic). Everything
below was measured from FL 2026's binary with `flfxhost` (impulse-train delay
tracking, complex transfer functions from noise, step responses, null tests). Files:
`src/model/fx/plugins/vchorus.ts`, `src/engine/effects/plugins/vchorus.ts`,
`src/ui/plugins/fx/vchorus/index.tsx`, `tests/fx/vchorus.test.ts`.

## Controls

| # | Name | Range (Default) | Mapping | FL text |
|---|---|---|---|---|
| 0 | Mode | 0..2 (0) | Chorus 1 / Chorus 2 / Custom | `Custom` |
| 1 | Link Chorus I+II | 0..1 (0) | shift-click I or II (hidden check box) | `On` |
| 2 | Speed | 1..245760 (80) | 10 x^2 Hz, x = (v-1)/245759 | `0.40 Hz` (float32); synced `4:0` |
| 3 | LFO type | 0..1 (0) | Triangle / Sine | |
| 4 / 16 | LR Phase / Start phase | 0..6000 (3000 / 0) | v/6000 cycle | `180.00°` |
| 5 / 6 | Time 1 / Time 2 | 0..6000 (60 / 3000) | 0.244 + 0.0098 (v/6) ms of delay | `10.0 ms` (v/6) |
| 7 | Mix | 0..6000 (3000) | m = v/6000 | `50% Dry / 50% Wet` |
| 8 / 9 / 14 / 15 | Mono input / Invert wet / Noise gate / Tempo sync | 0..1 | | `On` |
| 10 | Feedback | 0..6000 (0) | g = 0.6284 v/6000 | `50.0%` |
| 11 | High pass | 0..6000 (3000) | 10 + 160 x^2 Hz | `50.00 Hz` (float32) |
| 12 | Gain | 0..6000 (0) | 0..12 dB | `12.00 dB` |
| 13 | Noise | 0..6000 (3000) | -90 + 50 x dB, off at 0 | `-65.0 dB`, `-∞` |

Defaults: FL's "Default" preset (differs from the constructor only in Speed 80 vs
49152). 22 factory presets. Texts: 299777/299784 swept texts match (7 Mix ties).
Tempo-synced period in ticks (48 per step) = max(1, floor(6143/127 (128^(1-x) - 1) + 1.1)):
all 481 swept texts and every measured LFO period match (FL's own "1/32" and "1/64" menu
values land on 2 and 1 ticks).

## DSP (measured)

```
d(t)  = onepole_21.7ms( lo + (hi - lo)(1 + lfo)/2 )            delay trajectory (ms)
w     = HP( LP4( BBD(x + g * t[-1]) ) );  t = w (feedback take-off, one sample late)
wet   = LP1_7kHz(w) + hiss
out   = gain * ( sqrt(0.999942 (1-m) + 0.0000285 m) x  +/-  sqrt(m) wet )
```

- **LFO**: phase accumulated in float32 from 0 (L) at every start (rates drift exactly
  like FL: -0.07 % at 0.4 Hz); R = L + LR Phase. Triangle or sine.
- **Delay smoothing**: a one-pole of 21.7 ms on the delay: rounds the triangle's
  corners, 8 Hz modulation -3.4 dB / 47 degrees late. Fitted to 0.01 sample.
- **Parameter changes** (measured with `--at`): the same 21.7 ms one-pole smooths the
  Mix control (the equal-power gains follow), Gain and Noise; Feedback, High pass,
  Invert, Mono, the times, Speed, LFO type and LR Phase apply at once (the delay then
  glides through the smoothing). The high pass sits ahead of the BBD inside the loop,
  so its changes reach the output after the delay. A new instance starts with the
  smoothed delay at 10 ms, Mix, Gain and Noise at 0 (the output fades in) and glides to
  the settings (FL's start-up).
- **Juno modes** (fixed, ignore Mix, Feedback, High pass, Invert, Mono, Speed, Times):
  I = triangle 0.4 Hz, II = 0.6 Hz, both 1.080..5.230 ms (before smoothing), R half a
  cycle on; I+II (Link) = sine 8 Hz, 3.110 +- 0.260 ms, R only 10.3 degrees on (FL's
  "Juno 6 Mode I + II" preset uses LR Phase 171 = 10.26 degrees). Mix fixed 50 %, wet
  high-pass 0.5 Hz (a DC blocker). Gain, Noise and Noise gate work in every mode.
- **Custom**: bulk delay = shown time - 1.95 samples (44.1 kHz); first-order HP 10..170 Hz.
- **Filters** (bilinear fits to FL's complex response, 0.05 dB / 0.3 degrees to 14 kHz):
  LP4 = biquads 7291.9 Hz Q 0.6726 and 6722.6 Hz Q 0.7442; LP1 = 7000 Hz (exact: the
  feedback loop's response relative to the forward path is z^-1 / LP1(7000), fit 7e-4).
  -3.4 dB at 5 kHz, -13 dB at 8 kHz.
- **Mix**: equal power sqrt law (not cos/sin); 100 % wet still leaks dry at -45.4 dB.
- **Hiss**: white noise, floor 0.195 + first-order HP 4.84 kHz, LP biquads 8.7 kHz /
  20.4 kHz (spectrum within 1 dB); amplitude (0.68 + p)^2 with p the smoothed LFO
  position (FL's hiss swells ~15 dB toward the long delay), independent of the times.
  Noise 6000: -53.55 dB rms at p = 0.5, 100 % wet. Gate closes on silence.
- **Tempo sync**: whole-tick periods (above); the LFO restarts at Start phase plus the
  song position when playback starts (Start phase does nothing when free running).
- Null tests (2 kHz-band noise, after FL's 0.5 s startup): modes I / II -54..-58 dB,
  I+II -52 dB, custom default -51..-62 dB, custom 50 % feedback -53 dB, 100 % -48 dB,
  modulated custom -53..-61 dB, static -42..-51 dB, tempo-synced LFO identical rate/phase.

## Our deviations

- Changes of Time / LFO controls differ by up to 0.1 % of the delay step during the
  glide (-28..-45 dB with white noise for ~40 ms); a Speed change leaves a ~0.03-sample
  delay offset (-38 dB); the first ~50 ms after creation differ by -21..-30 dB with the
  wet path on (cause unknown).
- Hiss is our own noise generator (spectrum, level and LFO tracking match, not the samples).
- Tail: Infinity while ungated hiss is on (FL never goes silent then), else 0.5 s.

## Editor

Form geometry (747 x 217) and colours sampled from the 1.5x manual screenshot: brushed
dark panel (#252525), title bar #8f4b2e with slanted stripes, headers MODE #4096c8,
DELAYS / MODULATION #cd5d4d, LEVELS #fffff6, light section rules, pads I / II / EDIT
with LEDs (red #ff4141), faders with 11-tick (Speed: 25-tick) scales and a track lit
below the cap, knobs with a 21-dot ring (lit up to the value, sweep +-155.6 degrees),
sine/triangle toggle, LED switches. Shift-click I or II = I+II. Right-click Speed >
Set: FL's note-length values. As the manual says, controls a mode ignores are dimmed
and locked (all custom controls in the Juno modes; Start phase without tempo sync).

## Open questions

- The exact Mix text rounding (7 ties) and why FL's screenshot dims L/R Phase in EDIT.
