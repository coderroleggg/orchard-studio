# Vocodex (FL: Vocodex)

Channel vocoder with mapping envelopes, unison, contours, a soundgoodizer and an
internal carrier synthesizer. Category Misc. Editor 593 x 603.

## Sources
- Form `Vocodex` (geometry, ranges, defaults, tags, the ArtSelect target list), manual
  pages (Vocodex, _inputs, _parameters, _carrier, _tutorial) and screenshots (1.5x).
- FL's binary in the FL test host: names, value texts (full sweeps), the factory presets
  (all 21 decoded), and renders with L-R encoding, self-vocoding and (later) a real
  sidechain input. Saved state v5: 13 envelopes (`int a, int b, int n`, n x (dx, y,
  tension) doubles where **x is the delta from the previous point**, 20-byte tail), 20
  params (v2/v3 presets: 19, no noise HP), 7 ints `[holdMode(0 peak/1 RMS), order,
  unison(0 off .. 4 = 5 voices), bands, ?, modIn, carIn]`, 21 flag bytes `[L-R, MIN TIMES,
  TO MOD, TO NOISE, DRAFT?, THREADED?, FROM CAR, FROM CONSONANTS, 13 x pitch-follow]`, a
  Pascal string carrier tone and the held notes.

## Parameters (exact texts)
0 Wet `(7^(v/1000)-1)/6` in dB (`-InfdB`, `0.0dB`, `18.1dB`); 1 SG `round(v/10)%`;
2/4 MOD/CAR pass-through `(11^(v/12800)-1)/10` dB; 3/7 HP and 5 LP `40*375^(v/65536)` Hz
(0 = `Off` for the HPs, max = `Off` for the LP); 6 noise `round(v/128)%`, gain `(7^x-1)/6`;
8/9/11 hold/attack/release `T*(501^(v/10000)-1)/500` ms (T = 250/1000/2000, `%.2fms`);
10/12 curves `2^(v/1000)`; 13 freeze (FL text empty); 14 band width `100*(5^(v/1000)-1)%`;
15 flatness `v%`; 16 mod width `x4^((v-2000)/2000)`; 17 pitch `+0.00 cent`; 18 unison shift
`v/10 %`; 19 unison pan `round(v/2.56)%`. Defaults = FL's factory Default preset (MOD
pass-through 0 dB, HP 5785 Hz, contour FROM CONSONANTS -> MOD + NOISE, 47 bands, order 2).

## Measured DSP (implemented)
- Frequency scale (distribution envelope y, also the x axis of the other envelopes):
  `ln f = 3.4956 + 6.4245u + 0.0679u^2 - 0.0315u^3` for u >= 0.11, `606.06u` below,
  >= 20 Hz (21.1 kHz at u = 1). Band k of n at `u = env(k/(n-1))`; default 82.7 Hz .. 20 kHz.
- Carrier band: 2 RBJ band-pass sections; band octave width
  `max(1/30, (bw%/100) * local spacing * width-env)`; flatness f: sections `width/(1+f/2)`
  wide at `+-f*sectionWidth/2` octaves, centre made up by `2^f`.
- Output gain per band `69.65 / (width * sqrt(n))` (constant within 0.2% over 5..100 bands,
  1..400% widths, 270 Hz..5 kHz).
- Detection: order 2 = carrier shape; order 1 = one section, width/2; orders 3/4 =
  staggered sections, centre gains 16/9 and 4 at flatness 0 (fitted, see code); modulator
  width multiplier m widens and scales by `m^-1/2`; pitch shift moves the detection bands
  to `f*2^(-cents/1200)` (the carrier bands stay).
- Envelope: peak with hold (a peak within -3 dB restarts the hold) or 2.25 x RMS over the
  hold window; one-pole attack/release to 99% in the set time; MIN TIMES: hold >= 25 ms
  (RMS window >= 50 ms), attack >= 2 ms, release >= 3.6 ms. Curves 1..4 = 1..4 one-pole
  stages (FL's curve 2 within ~1%, 4 within ~5%).
- Envelopes: gain `(9^y-1)/2` (mute .. +12 dB), offset additive
  `+-0.1028 (10^(3(2|y-.5|-1)) - 0.001)`, pan linear law, unison voices across
  `+-shift*1200` cents.
- Mixer: 4th-order Butterworth HP (MOD) / LP (CAR), uniform noise `[-0.5,0.5)` per channel
  into the carrier (2nd-order HP), consonant contour ~ `1.3 * env(HP2 9.9 kHz)/env(all)`
  (FL: x(f/9.9k)^2 for tones, ~1 for noise), carrier contour.
- Soundgoodizer: `(1-s) dry + s * 3-band maximizer` (LR4 200 Hz / 3 kHz, gains 6.27 / 2.03 /
  6.89 = FL's low-level response, soft per-band compression), 3.47 ms look-ahead limiter
  at -0.35 dBFS. Latency 153 samples at 44.1 kHz (FL's value) is always reported.

## Fidelity (TS engine vs FL renders, speech-like modulator, chord carrier)
Default, pitch shift, gain/pan envelopes, hold/attack/release, curves, pass-through,
sidechain routing: level within -0.1..-0.4 dB, correlation 0.96-0.98, band levels within
+-1.5 dB. Orders 3/4, unison and wide/flat combinations: within ~1-3 dB (approximate
models). RMS mode: highest band -6.8 dB.

## Approximations / open questions
- FL's Default preset runs with a 16-sample extra delay (state int 4 = 0, probably THREADED)
  and slightly different filtering (same spectrum within ~1 dB, correlation 0.995 of the
  short-term envelopes); here DRAFT / THREADED are stored switches only.
- Orders 3/4 detection shapes, unison pans/weights, curve shapes 3-4, the soundgoodizer
  (static curves within ~1-2.5 dB at mid levels), the contours and the noise-threshold
  scale are fitted approximations. The internal carrier tones are this clone's own
  synth patches named after FL's Sytrus "Vocoder carriers". The keyboard latches notes by
  mouse and by MIDI (a MIDI Out channel on the slot's MIDI input port), with FL's
  controller rule: a note pressed while no other is held clears the chord, notes pressed
  while one is held join it, releases change nothing (up to 16 notes). MIDI notes apply at
  their sample and are mirrored into `notes` (takeStateChanges), so the keys light up and
  saves keep them; the tail is infinite while the internal carrier has notes. Velocity
  does not affect the carrier. The VCX sound button and FL's artwork are not reproduced.
- Envelope tension uses a power curve (FL's exact curve law not measured; factory
  presets only use tension 0).
