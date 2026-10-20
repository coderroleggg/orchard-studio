# Squeeze (FL: Fruity Squeeze)

Sources: FL 2026's plugin binary (`TTestPlug`: Eff_Render 0x5d2d0,
ProcessParam 0x5c8d0 with its jump table, filter 0x5d810, SVF class
0x5e320..0x5e7b0, relation 0x5d730), the form, the manual and renders
through FL's plugin (`flfxhost`). Our output is FL's bit for bit
(single-precision port): static settings, every filter type, full
resonance, the puncher and the Relation quirk, automation of all
parameters, 44.1 and 48 kHz.

## Parameters (form 279 x 220)

| # | Name | Range | FL default | Default preset | Value text / law |
|---|---|---|---|---|---|
| 0 | Gain | 0..160 | 127 | 93 | v/127 (round(%)) |
| 1 | Mix | 0..128 | 64 | 108 | "x% dry / y% wet", wet = v/128 |
| 2 | Steps | 1..32768 | 1 | 28417 | steps = 32768^(1 - v/32768), "%.1f steps" |
| 3 | Filter | 0..1 | 0 | 1 | off / on |
| 4 | Filter type | 0..4 | 0 | 4 | low pass, high pass, band pass, notch, peak |
| 5 | Filter Resonance | 0..65536 | 32768 | 46592 | % |
| 6 | Filter Cutoff | 0..65536 | 32768 | 23552 | % |
| 7 | Filter Position | 0..1 | 0 | 1 | pre / pos |
| 8 | Relation | 0..3 | 0 | 0 | none, impact = preserve, x 2, / 2 |
| 9 | Impact | 0..44100 | 0 | 2892 | samples = 44101^(v/44100) - 1 (x sr/44100) |
| 10 | Preserve | 0..44100 | 7500 | 4684 | same |
| 11 | Amount | 0..65536 | 0 | 0 | % |

FL inserts the plugin with its "Default" factory preset (filter on, peak,
post), so our defaults are the preset's values; all six factory presets
(Default, Grit, Low Squeek, Off, Punch, Squeek) are in `def.presets`. The
manual's screenshot shows the constructor state. FL's sample texts scale
with the sample rate (227 instead of 209 samples at 48 kHz); ours use 44.1 kHz.

## DSP (exact)

Per block: if every input sample is within +-1e-6 the block is copied
through untouched (filter and puncher state freeze). Otherwise, on a copy
of the input:

1. filter, if on and "pre";
2. squarize: `x = rint(x * steps) / steps` (round half to even), whenever steps < 32768;
3. puncher, if impact > 0: a per-frame state machine alternating a preserve
   phase (gain 1, `preserve` samples) and an impact phase (gain
   amount/65536, `impact` samples), with a fractional crossfade sample at
   each switch (`wImp + wPres = 1`); both channels share it;
4. filter, if on and "pos";
5. `out = (in * (1 - mix) + processed * mix) * gain`.

Filter: Chamberlin SVF run twice per sample with the same input (2x
oversampling) and the two outputs averaged; per pass
`notch = x - q band; low += f band; high = notch - low; band += f high`;
outputs low / high / band / notch / low - high (peak). Coefficients:
`fc = 50 * (33075/50)^cutoff` Hz (log, clamped), `f = 2 sin(pi min(fc / 88200, 0.25))`,
`q = min(2 (1 - res^0.25), 2/f - f/2, 2)`. FL builds the filter for 44100 Hz
and its sample-rate handler never stores the new rate, so the coefficients
always assume 44.1 kHz (at 48 kHz the 50 % peak sits at 1400 Hz, measured).
Puncher lengths do scale with sr/44100. Relation (FL's ProcessParam):
changing Preserve or Relation sets the Impact parameter to preserve,
2 x preserve or preserve div 2 in raw units (not samples).

Measured responses (cutoff 50 %, res 50 %, 0.1 sine): LP 200 Hz 1.0231,
1286 Hz 3.136, 5 kHz 0.0702; HP 0.0247 / 3.136 / 1.0821; BP 0.1592 / 3.136 /
0.2716; notch 0.9984 / 0.0021 / 1.0119; peak 1.0478 / 6.272 / 1.1524 (tests).

## Our implementation

`src/engine/effects/plugins/squeeze.ts`: a line-by-line port of FL's code in
single precision (`Math.fround`), with FL's operation order (filter: x and
notch flushed below 2^-24; outputs averaged as f32(0.5 o1) + f32(0.5 o2);
squarize f32(f32(rint(f32(x steps))) / steps); puncher counters in single
precision, impact gain f32(amount / 65536 x wImp); mix
f32(f32(f32(dry x) + f32(wet p)) gain)), FL's `Power` for steps, lengths and
res^0.25, and FL's single-precision cutoff mapper (ln 50 .. ln 33075).

- No smoothing: gain, mix, steps, filter coefficients and puncher settings
  switch at the next block, as in FL.
- No q clamp: full resonance gives q = 0 (a lossless Chamberlin resonator).
  In FL's single precision its rounding keeps it bounded (30 s of 0.1-rms
  noise: peak 13.5 low pass, 27 peak mode), and our single-precision port
  reproduces that output exactly, so the clamp is gone.
- Relation follows FL's ProcessParam events: a Relation or Preserve change
  writes Impact (preserve, 2 x preserve without a clamp, preserve div 2), an
  Impact change sets it; a state load applies them in index order. Above
  44100 (x 2) the impact phase never ends; when such a long phase is cut
  short FL's crossfade weights give one sample a gain of tens of thousands
  (reproduced, finite).
- Departure (finite output): NaN / Inf input samples become 0.

Before this pass: Default preset -59 dB, full resonance -1.7 dB (q clamp),
gain / mix / steps / filter changes -5..-53 dB (3 ms smoothing).

## Editor

FL's flat grey skin (#595a5a panel, #767778 sections), italic section
titles, dark caption plates with the 30 px wheels in their right ends,
FILTER LED switch, type spinner (drag / wheel / arrows), FREQ. / RES.
wheels, PRE / POS LED selector, MIX / GAIN faders with tick marks and a
white fill, and a name plate with our own citrus badge (FL's juicer
artwork is not copied). Wheels sweep +-154 degrees like FL's vector wheels.

## Open questions

- The function of FL's caption plates (TQuickBtn, Tag -1) when clicked.
