# EQUO

Files: `src/model/fx/plugins/equo.ts` (+ `equo.presets.ts`),
`src/engine/effects/plugins/equo.ts`, `src/ui/plugins/fx/equo/{index,widgets}.tsx`,
`tests/fx/equo.test.ts`.

Sources: FL 2026 form (`EQUO.txt`), the manual page and its screenshot, and
measurements of FL's binary with the test host (scripts in the scratchpad:
`b5/eqst.py` builds plugin states, `eqcmp.py` compares FL with the clone,
`eqgains.py` recovers per-band gains by least squares on noise renders).

## Parameters and state

842 parameters in FL's order: band shift (-12000..12000), band mix
(-128..128, def 128), morph (0..7000), motion smoothness (0..1024, def 170),
output volume (0..256, def 128), then banks 0-7 and the master bank, each
31 volumes, 31 pannings, 31 sends (0..2^30, 2^29 = neutral). FL's value text
for band parameters is `round(gain) * 100` ("0", "100", "200"...); the editor
hint shows dB / pan instead.

Not parameters (FL keeps them in its state blob, version 4: 1023 floats +
11 ints): band width (80..500, def 150), oversampling, send track, add mode
(flags byte 1), send only (flags byte 0), the band modes per curve kind
(off / locked / enabled, stored next to a cached curve in region 1; the DSP
ignores both - verified). Band parameters cannot be changed through
ProcessParam in the test host (FL updates the curves from its editor), so
everything was measured through states.

## DSP (all sample-exact, -132 .. -145 dB on noise, 44.1 / 48 / 96 kHz)

- 31 RBJ band passes (TDF2) at 20 * 2^(j/3) Hz, RBJ digital bandwidth of
  BW / 300 octaves, peak gain 10^(-3/20) * 100 / BW (0.471964 at BW 150; the
  bank sums to about +0.25 dB, -5 dB at 20 kHz).
- The top three bands (12.9 / 16.3 / 20.5 kHz) are designed at twice the rate
  and run on a linearly interpolated input (one midpoint sample, then the
  sample): their poles are the squares of the 2x poles, numerator zeros at 1
  and -(1 + cos w2 - a) / (1 + cos w2 + a). With OVERSAMPLE on they are plain
  RBJ at the oversampled rate.
- Bands at or above the internal Nyquist frequency are silent (32 kHz: band
  30 and 31).
- OVERSAMPLE: the whole bank at 2x between HIIR halfbands (the 6 coefficient
  set Love Philter uses), no latency reported (FL: 0).
- Gains: volume / send (3^v - 1) / 2; pan is a linear balance (v < 1 lowers
  the right side, v > 1 the left).
- Curve pipeline, per bank: mix (v' = 1 + (v - 1) mix, all three kinds),
  shift by shift / 12000 * 30 bands with linear interpolation of the gains
  (of the values for pan) and the edge values beyond the ends, back to band
  values; morph = linear blend of the two banks' values (morph / 1000); then
  the gain law. Master bank: gains multiply, pans add (p + mp - 1, clamped),
  not shifted or morphed. Each step was isolated with recovered band gains.
- ADD MODE: x + sum (gain - 1) band (exact x when flat). SEND ONLY: the
  direct output is the dry input times the output volume.
- Output volume (11^(x/128) - 1) / 10, moved linearly across each processing
  block by at most 44.1 / s (FL: 1 -> 0.53144 over the first 512-sample block
  of a 128 -> 64 change, target at the end of the second).
- After 0.2 s of digital silence at the input (counted in whole blocks) FL
  stops processing: output zero, filter states frozen and resumed with the
  next sound (impulse response ends at sample 10240 with 512-sample blocks).

Not measurable with the host: motion smoothness (FL's curve updates run in
the editor; modelled as a glide of the band gains, 2 ms .. 0.5 s) and the
sends (modelled: band outputs weighted by the send curve times the output
volume, to the chosen track; none from the master track, as the manual
says).

## Presets

Default, Random bank, Resonant lowpass (oversampled, morph 5000, smoothness
0), Stereo separation, Vocals enhancer, Vowels - converted from the states FL
saves for each .fst (band values that differ from neutral). All six match FL
sample-exact.

## Editor

FL's layout at form coordinates (565 x 240): blue display panel with the
GRAPHIC EQ title, settings (band level bars on / off, reset all banks),
options menu (random curve, flat line, interpolate 1 to 8), pencil / line /
curve drawing modes, ANALYSE (hold: averages the input band levels, on
release writes the antagonistic volume curve; bands up to 40 Hz untouched),
the band modes row (click: off -> locked -> enabled; right-click: all), 31
band columns with markers, input level bars and frequency labels; BANK menu
(copy / paste / reset), M + banks 1-8, VOL / PAN / SEND. Curve mode moves the
band under the pointer and its neighbours with a triangular falloff over 5
bands (measured from the manual's animation); right-drag resets bands,
double-click resets one, the wheel nudges. Right panel: MORPH (shift, mix,
morph, smooth, vol knobs), SETUP (send only, send track among the routed
tracks, add mode, oversample, BW knob).
