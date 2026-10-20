# Stereo Enhancer (FL: Fruity Stereo Enhancer)

Stereo separation, one-channel delay ("phase offset"), polarity inversion, balance and
volume. Category Gain. Editor 400 x 110. 6 parameters. No latency; tail = the delay.

## Sources
- Form `Fruity Stereo Enhancer` (wheels PAN Tag 0 -128..128, VOL Tag 1 0..320, STEREO SEP
  Tag 2 -96..96, PHASE OFFSET Tag 3 -512..512; LED selectors Tag 4 PRE/POST, Tag 5
  NONE/LEFT/RIGHT; radial `TVectorGradient`, blue `TVectorBevel` 80..270; fonts:
  OpenSans-CondLight 11 (wheel captions), 15 (section names), 16 (logo), P_SmallBold LEDs).
- flfxhost texts and renders (matrix with one-sided DC, impulses for the delay, noise A/B);
  disassembly of Eff_Render, ProcessParam, the matrix and delay routines.
- Factory presets read with `info --preset`: Default (= constructor), For strings, Subtle.

## Texts (exact)
- Panning: `Centered` at 0, else `Round(|v|*100/128)% left/right` (half even: 16 -> 12%).
- Volume: `%.0f%%` of v/320 (256 = "80%" = unity gain).
- Stereo separation: `Original`, `N% merged` (v > 0) / `N% separated` (v < 0), N = %.0f of |v|/96.
- Phase offset: `%.1fms left|right` of (1001^(|v|/512) - 1)/2 ms in float32 ("right" for v >= 0);
  matches FL for all 1025 values.

## DSP (exact; A/B renders match FL to float precision, 44.1 and 48 kHz)
- s = sep/128 (-0.75..0.75), v = (11^(vol/256) - 1)/10, p = pan/128:
  L' = gL v(1 - s/2)(L + sR), R' = gR v(1 - s/2)(R + sL); gL = 1-p if p > 0 (else 1),
  gR = 1+p if p < 0; LEFT/RIGHT inversion negates gL/gR. Measured: sep 96 -> 0.625 / 0.46875,
  sep -96 -> 1.375 / -1.03125. (So "100% merged" leaves 16% of the side signal; "100%
  separated" scales mid by 0.34 and side by 2.41.)
- Smoother: per-block ramps limited to 44.1/sr per sample, from zero at creation.
- Delay: round_half_even(float32((1001^(|v|/512)-1)*50) * float32(sr/100000)) samples
  (0..sr/2) in a circular buffer on R (v > 0) or L (v < 0); measured 676 / 63 / 22050 samples
  for 256 / -100 / 512 at 44.1 kHz. PRE: before the matrix; POST: after it. Offset 0 bypasses
  the delay. Every offset change reallocates and clears the delay line (the clone clears it).

## Editor
- Three wheel styles share one "collar" drawing (cap, dark line, collar with marker, track
  band and 7 ticks over +-154 degrees, centre dot): dark (SEP), blue-dark (PHASE OFFSET) and
  white/silver with red marker (PAN, VOL). Background: elliptical radial gradient centred at
  the top middle (fitted to the screenshot), the blue section its own radial gradient.

## Approximations
- Fonts: condensed system fonts squeezed to Open Sans Condensed Light; P_SmallBold -> system bold 9 px.
- The logo text is drawn as faint italic condensed text (FL draws an outlined logo font).
