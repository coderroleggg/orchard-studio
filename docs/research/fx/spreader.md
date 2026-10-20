# Spreader (FL: Spreader)

Mono-compatible stereo widener (Kyle Spratt). Category Gain. Editor 540 x 255.
5 parameters + editor state (scope switches, theme). No latency; tail 0.25 s.

## Sources
- Form `Spreader` (SpreadWheel Tag 0 0..10000, SeparationWheel Tag 1 -10000..10000,
  LFBypassWheel Tag 2 1000..1000000, MonoSwitch Tag 3, OnOffCheckBox Tag 4; PRE-FX /
  POST-FX checkboxes and the Options menu Theme Light/Dark are Tag -1).
- flfxhost texts (5290 values compared) and renders (impulses, noise, automation at 48 kHz).
- Disassembly: the FPC plugin only feeds the scopes and forwards parameters to a C++
  engine, `StereoEnhancer` in FL's shared `Shared/ildsp_x64.dylib` (found by probing the
  plugin object at runtime; vtable: setSampleRate, setParameter("width", "separation",
  "lowbypass", "monobass", "enable"), getParameter, process, reset). The per-sample loop
  was transcribed instruction by instruction.

## Parameters and texts (exact)
- Spread: `%.1f%%` of v/100 (decimal half-up: 315 = "3.2%"); engine width = v/10000.
- Separation: p = Round(-(v/10000)·100) (half even, in double): `Original` if p = 0, else
  `p% merged` (v < 0) / `|p|% separated`; engine separation = (v+10000)/20000 (0.5 = original).
- Low bypass: x = float32((v-1000)/999000); Hz = 1000x (x <= 0.5) or 500 + 9500(2x-1);
  `%.2f Hz`; the engine clamps to >= 10 Hz (the wheel reaches "0.00 Hz").
- Mono, Enabled: Off/On.

## DSP (exact port; A/B renders match FL to float32 precision, -136..-143 dB)
- One-pole smoothing a = exp(-500/sr) of all five values, kept in float32, starting from 0
  at creation / reset (the enable gain crossfades dry -> processed, so it fades in).
- Input·B -> per channel two cascaded TPT SVFs (Butterworth, k = sqrt 2) at the smoothed
  bypass frequency (g = tan(pi f/sr)): ap = stage-1 all-pass (x - 2 sqrt2 bp), lp = LR4
  low-pass, hp = ap - lp.
- HS = hpL - hpR, HM = hpL + hpR go into 2048-sample lines; read at
  trunc(trunc(sr·0.0063492)·C) samples (C = smoothed width, max 280 at 44.1 kHz), the
  tap change crossfaded over trunc(sr·0.02322) samples by FL's two-tap state machine;
  multiplied by C.
- 15 kHz bilinear first-order LP/HP on the delayed signals: W(x) = LP(x) + 0.398·HP(x).
- out L/R = x(1-B) + lp(1-F) + F(lpL+lpR)/2 + HM/2 + C·W(HSd)/2 ± E·(HS + C·W(HMd)).
  E = separation, F = mono bass. A mono input gets ±(delayed high band): L+R unchanged.

## Editor
- Collar wheels (steel cap, slate collar, white marker; centre dot on SEPARATION), power
  LED, MONO switch (orange when on).
- Display: polar "sound flower" per sample pair (angle = atan2(side, |mid|), left = positive
  side; radius = pair RMS in dB, outer ring 0 dB, centre -40 dB; peak-hold per angle bin with
  ~1.4 s decay, smoothed across bins), pre (yellow) and post (orange); phase-correlation bars;
  balance dots on an arc just outside the outer ring; PRE-FX / POST-FX switches; Options
  menu (button and plugin menu) with Theme Light / Dark.
- Engine monitor(): decimated pre/post sample pairs, correlation and channel powers.

## Approximations / open questions
- The scope geometry was scaled from an annotated manual screenshot of a resized window
  (about 780 x 375 at 1.19x); ring radii (1, 0.62, 0.32), guide lines (+-45, +-73 degrees),
  the dB scale and decay of the flower are estimates, not read from FL's paint code.
- The default theme is taken to be the one in the manual screenshot ("Dark"); the Light
  theme colours are invented in the same spirit.
