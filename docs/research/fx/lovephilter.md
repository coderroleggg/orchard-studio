# Love Philter (FL: Fruity Love Philter)

Files: `src/model/fx/plugins/lovephilter.ts` (+ `lovephilter.presets.ts`),
`src/engine/effects/plugins/lovephilter.ts`,
`src/ui/plugins/fx/lovephilter/{index,widgets,envEditor}.tsx`,
`tests/fx/lovephilter.test.ts`.

Sources: FL 2026 form (`Fruity Love Philter.txt`), manual + its screenshot,
FL's plugin thumbnail, the plugin state blob (`SaveRestoreState`, version 3,
zlib; parser roundtrip-verified) and measurements of FL's binary with the test
host (48 kHz unless noted; scripts in the scratchpad `b5/lp*.py`, `mg*.py`).

## Parameters and state

359 parameters in FL's order: 8 masters (level, LFO level, EF level / attack /
release, pattern number, X, Y), then per unit 12 knobs (env, cut, res, low,
band, high, WS amp, WS mix, pan, vol, in, next; unit 8 has no "next") and
4 LFO knobs (speed, tension, skew, pulse width) for each of the 8 targets
(PAN VOL CUT RES LOW BAND HIGH WMIX). Defaults = FL's Default preset (it differs
from a fresh instance, e.g. master 128 vs 104). Everything else is state
(`lp`): per unit mode / type / alt / on / WS on / bipolar / WS curve and per
target 10 pattern envelopes, LFO amount + switch, X / Y / IEF mappings; globals
CENTER, HQ, SMOOTH, USE1, oversampling (0..4 = off..16x, default 2x), solo,
info text. `lpUi` (edited unit / tab / source) is view state.

Envelope blob facts: points `[dt, value, tension, flags]` (low byte = curve
type, 0..12); per envelope `[flags, ON, ?, loopStart, loopEnd]` where **ON**
(LongBool, -1 / 0) is the envelope's switch: a switched-off pattern or LFO is
neutral (verified by toggling it in FL's state; `tr[0]` bit 2 has no audible
effect). Factory presets keep switched-off patterns (`po` in the compact data).
Target `head[1]` holds the current envelope value (runtime cache).

## Signal flow (all verified sample-exact on static settings)

- One HIIR up-sampler (6 coefficients, transition 0.1, cascaded 2x stages) at
  the input and one down-sampler at the output around the whole unit chain
  (per-unit resampling did not match "Dist lowpass"; the global one does).
- Unit: in vol -> filter stages -> waveshaper -> out (vol, pan) summed; "to
  next" taps the post-WS signal into the next enabled unit.
- Pan: FL's stereo panner, not a balance: far side `sqrt2 cos th * own input`,
  near side `sqrt2 sin th * mid + sin 2th * side`, th = (pan + 128) / 256 * pi / 2
  (hard pan = both inputs at -3 dB on one side). Same for knob and modulation.
- Filters: Chocolate SVF (L / B / H gains, n-th root per stage), Lime LP / HP
  (Kellett form; f = 2 sin(pi min(fc, 17722 Hz, rate / 5) / rate); fb = 1 +
  R / (1 - f) unclamped with R raised to 1 - 0.9 / f so that (1 - f) + f R >= 0.1
  - fitted on impulse responses, f > 1 included), Vanilla RBJ types with the
  stage rules (Q root for LP2 / HP2 / AP, bandwidth x n (n + 2 in ALT modes) for
  BP, / for BS, gain / n for PK / LS / HS), Mango (below). The modulated cutoff
  is not clamped at the knob's top (FL lets X / Y / patterns push past 100 %).
- Modes off / single / dual / triple / alt dual / alt triple: alt modes spread
  stage frequencies `v_k = lo + (v - lo)^p_k` (p = 1, 0.5 or 1, 0.75, 0.5625) in
  each family's native units.

## Modulation

- Control period 4 * round(sr * 16 / 44100) samples (64 / 68 / 140 at 44.1 /
  48 / 96 kHz), HQ ENVELOPES 4 * round(sr * 2 / 44100) (8 / 8 / 16); ticks
  restart with each host block (as FL). Values are taken at the tick and
  ramped linearly over the following block (one block late), gains and filter
  coefficients alike; every target's value changes by at most 441 / s
  (full scale in 100 samples at 44.1 kHz - measured on pattern steps).
- Pattern envelopes run on the song position (free-running while stopped);
  loops wrap to the loop start and the segment leaving it starts from the
  loop-end value (so two-point loops hold). Curve types measured: single /
  double curve (B = 2^(20 |T|)), hold, stairs (steps from |T|: 1000 at 0, 17
  at 0.5, 3 at 0.75, 1 at 0.95; T < 0 offsets the levels), smooth stairs (cubic
  S per step), pulse, alt single / double (blend to 1 - (1 - u)^6), half sine,
  smooth (smoothstep blend), curve 3 (hyperbola); wave is approximated.
- Additive targets (PAN, CUT, RES) use offsets (CUT: 2 * env * dev + 256 * XY),
  the others factors. LFO: tempo-locked triangle shaped by tension / skew /
  pulse width, amount = (point - 0.5) * 2, scaled by the master LFO level.
- X / Y smoothing (SMOOTH): one-pole, 60 ms. Envelope follower on the input or
  unit 1 (USE1).

## Mango (LP3)

Small signal (impulse responses, rel. error 1e-5): 4 identical one-poles
`s += g (u - s)`, output 0.5 (s4 + s4[n-1]), feedback k * previous output, gain
1 + k / 2; g(cut, rate) tabulated at 44.1 / 48 / 88.2 / 96 / 176.4 / 192 kHz
(clamped at 0.929579); k = 5 * res / 256 * R(g) with R measured over g (rate
independent). Drive (low knob) 1 .. 7.54. Large signals: FL's DC transfer
saturates at a ceiling that grows with g (~2.78 g^0.27) and drive; the clone
uses an input soft clip with that ceiling. Loud broadband signals are
compressed much harder in FL than by this model - the main open item.

## Calibration status (factory presets, white noise, matched block 544)

Exact (< -100 dB): Default, Simple lowpass / highpass, Comb all pass / peaking,
Low pass and high pass, Volume and panning, Basic noise gate. -40 .. -85 dB:
Dist lowpass, Melodic / Simple bandpass, triangle LFOs, Basic / Basic 2 / 3,
alt panning, Level-driven noise gate, Phaser, Stereoizer, 10 pattern lowpass,
3 Band distortion, Bit crush, Compressed distortion, Compressor, Formant
vowels, Sidechain low freq. -25 .. -40 dB: LP into HP, Twinkle, Sequenced gate,
Stronger phaser, EF lowpass, PC lowpass (+ phaser), Pulser. Worse: Mango
presets (Self oscillating, Step pyramid, Yuk yuk, Lowpass 2, Wobble -15 dB),
High-low double pattern, Multipattern gate, Gated sequence template, Mangled,
Tri filter damage, Lowpass into highpass: all involve fast, large cutoff jumps
of Lime / Vanilla filters where FL's transients differ (FL rings much harder,
e.g. a peaking filter jumping down) or the Mango nonlinearity.

## Editor

FL's layout at form coordinates: unit LEDs (right-click = solo) with routing
arrows, unit tabs, IN / FILTER (type box with menu, mode LEDs, ALT, ENV / CUT /
RES, L B H faders for SVF or GAIN / DRIVE) / WS (ON, AMP, MIX, uni / bipolar) /
OUT (PAN, VOL, NEXT); target tabs with activity markers, pattern number,
source tabs; envelope editor (points, tension handles, curve-type menu, loop
markers, snap / slide / freeze / step, scroll + zoom, play position), LFO
panel (speed / tension / skew / pulse knobs, amount handle), mapping editors
with the current X / Y / level, WS curve; right panel with master / LFO / IEF
faders, X / Y pad, SMOOTH, X / Y wheels, IEF (USE1, ATT, REL), CENTER, HQ
ENVELOPES, oversampling spinner, info text, options menu (reset unit, copy /
paste preset).
