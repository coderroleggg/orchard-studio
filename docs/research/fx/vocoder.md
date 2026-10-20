# Vocoder (FL: Fruity Vocoder)

Zero-latency filter-bank vocoder. Category Misc. Editor 406 x 300. Modulator on the
left channel and carrier on the right (swappable); the output is mono, on both channels.

## Sources
- Form `Fruity Vocoder` (control geometry, ranges, defaults, tags), the manual page and
  the manual screenshot (2x the form, 1 px border).
- FL's plugin binary in the FL test host (`flfxhost`): parameter names and value texts
  (`info`, `sweep`), and renders with chosen inputs, parameters and saved states. All the
  DSP below was measured that way; the final TS engine matches FL's output to 1e-5..5e-5
  relative error (float32 level) on noise for default, formant, invert, scale 0, levels,
  4 bands/order 1, 8/3, 32/3 + formant and 128 bands.
- Factory presets `Default` and `Clear` (saved-state layout).

## Parameters (index, name, range, default, value text)
0 Starting freq 0..65536 = 0 (`10Hz`); 1 Ending freq 0..65536 = 65536 (`16000Hz`):
`f = 10 + 15990 (101^(v/65536) - 1) / 100`, text `round(f)Hz` (FL rounds in single
precision: 3 of 65537 values differ at exact .5 cases). 2 Freq scale 0..128 = 64 (`50%`).
3 Invert modulator freqs 0/1 (`OFF`/`ON`). 4 Formant -1200..1200 = 0 (`+0.00 cent`,
`-1.00 cent`, `+2.00 cents`). 5 Bandwidth 5..200 = 50 (`round(v/2)%`). 6 Attack 10..1000
= 20 (`20ms`); 7 Release 10..1000 = 100. 8 Hold modulator 0/1. 9 Modulator level,
10 Carrier level, 11 Wet level 0..160 (= 0, 0, 128; text `round(v/1.28)%`).

Non-parameter state (saved state v2: int32 version, int32 band count, int32 order,
int32 listen, byte swap, float32 x bands levels, then the 12 parameters): bands
4/8/16/32/64/128 (default 16), filter order 1..3 (default 2), listen
modulator/carrier/wet (default wet), L/R swap, per-band levels (1 = 0 dB).

## DSP (exact)
- Band edges `e_k = fmin + (fmax - fmin)(B^(k/n) - 1)/(B - 1)`, `B = 1 + 10^(4 scale)`
  (scale 0..1: B = 2, 101, 10001 at 0, 50, 100%). Band i is centred at
  `sqrt(e_i e_(i+1))`.
- Band filter: `order` identical RBJ constant-peak band-passes in cascade, each with an
  octave bandwidth `order * bw/100 * log2(e_(i+1)/e_i)` (RBJ: `1/Q = 2 sinh(ln2/2 BW w0/sin w0)`).
  Same design for the modulator and carrier banks.
- Envelope: `|x|` of the modulator band into a one-pole follower,
  `env = x + (env - x) a`, `a = 0.01^(1/(T sr))` with T = attack when `x > env`, else
  release (T is the time to 1%). Hold freezes the envelopes (hold from the start = silence).
- Output per band: carrier band (centre x `2^(formant/1200)`, band `n-1-i` when inverted)
  x env x level_i x `1500/bw`, where the level is indexed by the modulator band. Linear in
  both inputs; no limiting.
- Bands whose modulator or carrier centre exceeds `0.4535 sr` (20 kHz at 44.1 kHz, the
  threshold scales with the rate) are dropped. `fmax <= fmin` silences the vocoded signal
  (FL leaves ~1e-8). Negative band levels count as 0.
- Mix: `wet * vocoded + mod * modulator + car * carrier` with level gain
  `(11^(v/128) - 1)/10` (64 = -12.7 dB, 160 = +5.6 dB). Listen modulator/carrier outputs
  the raw input channel at unity.

## Implementation notes
- The band-passes run as Cytomic SVFs (`k v1` output; identical to the RBJ biquad) so the
  frequencies can glide: fmin, fmax, scale, bandwidth and formant glide over ~15 ms; band
  gains and the output mix ramp per block; band-count / order changes fade out and back in
  (6 ms each). Non-finite input is treated as silence; states are flushed.
- Latency 0. Tail: 1.5 x release plus the ringing of the narrowest band (capped at 30 s).
- CPU (48 kHz, 128-sample blocks): about 2% of a core at 16 bands, 18% at 128 bands order 3.

## Editor
FL's layout at form coordinates. The background and section panels use radial gradients
fitted to the screenshot. Knobs sweep 310 degrees with 33 ticks; sliders have FL's tick
rows, a hollow groove between zero and the value, and a centre line across the cap. The
band display draws each band's modulator envelope (-60..0 dB, a full-scale sine in the
band reads 0 dB) and its level line; drag across it to draw band levels (one undo step per
drag). The window menu has "Reset band levels". Clicking the L/R boxes swaps the channels;
the three LCDs select the listen mode (clicking the lit solo LCD returns to wet).

## Approximations / open questions
- The level line scale (0 dB at 68.5 px above the bottom of the 85 px display, 0.4788 dB
  per px, top = +7.9 dB) is inferred from the screenshot and the `Clear` preset's level
  steps; FL's exact slider law is not known. The envelope bar scale and colours are
  approximations (no GUI host measurement).
- When the band count changes FL may reset the levels; here the curve is resampled.
- The display title reads "VOCODER" (no Image-Line artwork); captions use the app font.
