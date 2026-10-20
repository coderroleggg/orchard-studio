# Stereo Shaper (FL: Fruity Stereo Shaper)

L/R mixer matrix with polarity, a one-channel delay and all-pass ("dephasing") before or
after it, and an "In/Out difference" output. Category Gain. Editor 271 x 313.
6 parameters + 2 state fields. No latency; tail = delay (+0.25 s with the all-pass on).

## Sources
- Form `Fruity Stereo Shaper`: TVectorSliders LR/L/R/RL (Tag 0..3, -25600..25600),
  DelWheel (Tag 4) and APFreqWheel (Tag 5) -4096..4096, FXPosSelect (Tag -1,
  "pre mixer"/"post mixer", Value 1), SideChainSelect DigiWheel (Tag -1, "Difference
  sidechain output number"), title labels (Arial 16). Labels such as DELAY, PHASE,
  IN/OUT DIFFERENCE, LEFT/RIGHT, the routing brackets and +/- are painted by code.
- flfxhost texts (20325 values compared), renders (matrix, delay, all-pass impulse
  responses, PRE/POST), a patched flfxhost copy capturing `GetOutBuffer` for the
  difference output, factory presets via `info --preset` / `--save-state`.
- Disassembly: Eff_Render, ProcessParam, the slider law, the delay, the RBJ biquad set of
  FL's filter library (type 5 = all-pass), the DF1 biquad loop; IPP calls resolved with lldb
  (ippsCplxToReal/RealToCplx for (de)interleaving, ippsSub_32f_I/ippsAdd_32f_I for the
  difference).

## Texts (exact)
- Sliders: `%.1fdB normal|inverted` of g = (3^(|v|/12800) - 1)/2; v <= 0 reads "inverted",
  0 is `-InfdB inverted`; 12800 = 0 dB, 25600 = 12.0 dB, 6400 = -8.7 dB (FL's limiter law).
- Delay: `%.1fms left|right`, (1001^(|v|/4096) - 1)/2 ms (float32). Dephasing: `%.0f%% left|right`.

## DSP (exact; A/B renders match FL to float precision, incl. difference output)
- Matrix: L' = gL·L + gRL·R, R' = gR·R + gLR·L, g = sign(v)·(3^(|v|/12800)-1)/2 computed in
  float32 like FL; per-block ramps at most 44.1/sr per sample, from zero at creation.
- Effects (`fxpos` 0 = before the matrix, 1 = after): delay of round((1001^(|d|/4096)-1)·50 ·
  sr/100000) samples on R (d > 0) / L (d < 0), cleared on change; then an RBJ all-pass,
  Q = 0.5 (alpha = sin w), DF1 in double, at fc = 10 + 4.398·(5001^(1 - |p|/4096) - 1) Hz
  (22 kHz near the centre, 10 Hz at the ends; clamped to sr/2), on R (p > 0) / L (p < 0);
  p = 0 bypasses it and clears its state. Coefficients change without clearing the state.
- Difference: input (saved before the effects) minus output, sent to the target.
- FL's constructor starts with the effects PRE, but its "Default" preset (applied on
  insert) and the form say POST; the clone defaults to POST.

## Presets
25 factory presets (Default, Effects/..., Mixing/...) with their effect position; the four
"splitter" presets select FL's difference output 2 (`diffIdx`). The editor maps that to the
second track this track routes to (Master is first) when the preset is loaded.

## Editor
- Sliders: 41 ticks (every 10th long) as translucent light lines, translucent groove,
  colour fill from the centre, grey cap with a yellow (left source) or red (right source) line.
- DELAY / PHASE: collar wheels with a brushed steel cap (2-fold pattern), dark collar with a
  top highlight, thin track, yellow marker and centre dot.
- Background: elliptical radial gradient fitted to the screenshot; header band `#495357`.
- IN/OUT DIFFERENCE: red output display (FL index among the routes, `·` for none),
  drag/wheel/right-click menu like Send.

## Approximations / open questions
- FL's maximum all-pass frequency clamp ([sr object]+0x38) is assumed to be sr/2 (only
  matters below 44 kHz).
- Painted labels use the system UI font; titles use Arial Narrow Bold Italic.
- FL stores the difference target as an output index; the clone stores the track (see Send).
