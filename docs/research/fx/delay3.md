# Delay 3 (FL: Fruity Delay 3)

Sources: FL's form (747 x 217), manual page, factory presets, the engine laws decoded
for Distructor's chorus module, and measurements of FL Studio 2026's own
`Fruity Delay 3_x64.dylib` with `flfxhost` (info/sweep/render, `--at` automation,
44.1 / 48 / 176.999 / 191.111 / 192 kHz). Files:
`src/model/fx/plugins/delay3.ts` (params, mappings, texts, presets),
`src/engine/effects/plugins/delay3.ts` (DSP), `src/ui/plugins/fx/delay3/` (editor),
`tests/fx/delay3.test.ts` (reference values from FL).

## Parameters (index = FL parameter = form Tag)

| # | key | FL name | raw range | default* | text |
|---|---|---|---|---|---|
| 0 | inWet | Input wet | 0..6000 | 6000 | `100.0%` |
| 1 | model | Delay type | 0..3 | 1 | Fake Stereo / True Stereo / Ping Pong / OFF (GUI: Mono / Stereo / Ping pong / Off) |
| 2 | sync | Tempo sync | 0..1 | 1 | Off / On |
| 3 | keepPitch | Keep pitch | 0..1 | 0 | Off / On |
| 4 | time | Time | 1..768 | 192 | free `4.6ms`, synced `steps:ticks` (`4:0`, 48 ticks per step, unpadded) |
| 5 | offset | Delay time R/L offset | 0..6000 | 3000 | `-100.0%`..`100.0%` |
| 6 | smoothing | Time smooth | 0..1000 | 500 | `50.0%` |
| 7 | spread | Stereo spread | 0..6000 | 6000 | % |
| 8 | modRate | Modulation rate | 0..6000 | 3000 | `1.1Hz` (0.1..20 Hz) |
| 9, 10 | modTime, modCutoff | Modulation time / cutoff | 0..6000 | 0 | % |
| 11, 12 | diffLevel, diffSpread | Diffusion level / spread | 0..6000 | 0, 0 | % |
| 13 | distType | Distortion type | 0..1 | 1 | Limit / Saturate |
| 14 | feedback | Feedback level | 0..6000 | 3000 | `62.5%` (x 1.25, up to 125 %) |
| 15 | filterType | Filter mode | 0..3 | 0 | LP / HP / BP / OFF |
| 16 | cutoff | Feedback cutoff | 0..6000 | 6000 | Hz, per filter mode |
| 17 | res | Feedback resonance | 0..6000 | 0 | % |
| 18-20 | distLevel, distKnee, distSym | Distortion (all three) | 0..6000 | 0 | % |
| 21 | rate | Rate reduction | 0..60000 | 60000 | `192.3 Hz` .. `Max Hz` |
| 22 | bits | Bits reduction | 0..6000 | 6000 | `2.0 bits` .. `Max bits` |
| 23, 25 | wet, dry | Output wet / dry | 0..6000 | 6000 | % |
| 24 | tone | Output tone | -3000..3000 | 0 | `-100.0%`..`100.0%` |

*Defaults are the factory `Default.fst`, which FL loads on insert (it differs from the
plugin constructor in 7 values: True Stereo, sync on, time 4:0, Saturate, cutoff max,
resonance 0, diffusion spread 0). All 10 factory presets are in the def.

Value texts: FL formats single-precision values with round-half-even; reproduced
exactly for every parameter (full sweeps: 0 mismatches, including cutoff in all three
modes, modulation rate and rate reduction, which use the engine's laws below).

## The engine (FL's code, shared with Distructor's chorus module)

Delay 3's DSP is a C++ engine (`Plugins/Fruity/Effects/Fruity Delay 3/engine.vst`,
class ILDelay3). Its laws were decoded by the Distructor work (scratchpad
`fx/wd/out/dxchorus_notes.txt`, port in `src/engine/effects/plugins/distructor/chorus.ts`)
and are used here, extended to every Delay 3 feature and checked against renders of
FL's plugin. Arithmetic is single precision (Math.fround, multiply-adds rounded once).

- Free time: `T = 0.001 + 0.999 ((0.06 + 0.94 x)^3 - 0.06^3) / (1 - 0.06^3)`,
  x = the knob's float32 position (raw-1)/767; D = trunc(sr T). Synced: raw / 192 beats.
- Taps per crossfade slot: allpass length `M = trunc(max(1, (65 + 590 s) sr/44100
  min(1, D / 0.015 sr)))`, line tap `Z = D - M`; true stereo pre-delay
  `P = trunc(max(1, (f/2)^2 D))` on one input (read at P, 1 = none); mono reads a second
  tap at `trunc(f D / 2 + Z)` (f = |offset| as 0..1).
- Diffusion: one allpass per slot on the WRITE side, `w = x - c w[n-M]`,
  `y = c x + (1 - c^2) w[n-M]`, c = 0.499 level; the line input is the slots' allpass
  outputs mixed by the slot gains. Line, pre-delay and allpass reads interpolate
  linearly (taps glide).
- LFO: period table [8.872, 3.808, 1.833, 0.878, 0.398, 0.15, 0.05] s read at
  value x 0.99 x 5.9994 (the display reads it at value x 5.9994: the DSP runs 1..11 %
  slower); float32 phase in cycles, u = (1 + sin)/2 taken before the step. Delay =
  tap + A (u + 0.5); A heads for `0.05 sr depth^2 sqrt(P / 8.872)` with a per-sample
  one-pole (-40 dB in 0.1 s), so depth / rate changes glide.
- Feedback filter: TPT state-variable filter (Cytomic form), `g = tan(3.1415 fc / sr)`,
  k = 1/Q, LP / HP Q = 0.707 + r^2, BP (k v1, 0 dB peak) Q = 0.107 + 1.15 r^2. Cutoff
  tables read at x * 3.999 (BP: LP table at x * 3.6), clamped to 0.49 sr.
  Coefficients (and the filter mode) are updated every 4 samples from sample 0, with the
  cutoff modulation `x = cutoff + 0.5 modCutoff u`.
- DC blocker: bilinear 10 Hz high-pass with 44.1 kHz coefficients at any rate, on the
  feedback signal after the feedback gain.
- Saturate: drive `10^(1.425 level)` (+28.5 dB at 100 %), knee and symmetry shape as
  before (exact; at level 0 `y = x - x|x|/4`); the ceiling c(level) has no closed form
  found and is a 121-point measured table (Catmull-Rom in log), within ~1e-6.
- Limit: envelope steps 1 - exp(-1/191.5) attack, 1 - exp(-1/1915.1) release per sample
  (measured; the ping-pong output limiter uses the engine's own 1 - 0.01^(1/(0.02 x 44100))
  and 1 - 0.01^(1/(0.2 x 44100)), y = x / max(env, 1)).
- Sample & hold: hold = (1 + 0.7435 s1 - 0.0171 s1^2 + 0.0002 s1^3) sr/44100 with
  s1 = 127 (1 - rate)^3, counter `n = cnt + 1; take when n >= hold, cnt = n frac(n/hold)`
  (FL's pattern, e.g. 9, 9, 10, 9 at 50 %). The DISPLAY uses s1 = 127 (1 - rate).
  Bits: Q = 2^(16 - 14 sqrt(1 - n)), y = trunc(x Q)/Q.
- Parameter smoothing: inWet, spread, modCutoff, diffLevel, feedback, cutoff, res,
  distortion, rate, bits, wet, tone, dry step every 8 samples (from the 8th sample after
  creation) with k = 1 - 0.01^(1/(0.005 sr)), snapping within 1e-4; time, offset, Time
  smooth, mod rate, mod time, diffusion spread, model, sync, keep pitch and types apply
  at once.
- Time changes: without Keep pitch the taps glide per sample with
  k = 1 - 0.01^(1/(sr smooth)) (in double precision); with Keep pitch a new tap set is
  computed into the other slot and crossfaded linearly in trunc(0.1 sr) samples (changes
  during a crossfade wait); the old slot keeps 1/len (-73 dB) afterwards (engine quirk,
  reproduced). A model change resets lines, allpasses and filter states.
- Ping pong: the outputs pass an output limiter (transparent below 0 dBFS).

## Signal flow

```
in -> x input wet -> [True stereo: pre-delay of one input | Mono: (L+R)/2 | Ping pong: pour-law pan]
   + DC-blocked feedback (line output x feedback) -> filter -> S&H -> bits -> limit/saturate
   -> diffusion allpass (write side) -> line   (Mono: the filter after the distortion)
line read at Z + modulation (Mono: two taps) -> wet -> stereo spread -> tone
   -> [ping pong limiter] -> x wet (+ dry x in)
Off model: the chain (filter, S&H, bits, distortion) runs on the input itself, then
spread, tone, wet, dry.
```

## Verification against FL renders (temporary harness, error / reference)

Static settings: default -132 dB, 48 kHz -130, 97 BPM -126, true stereo + limiter -127,
ping pong + saturation + HP -139, mono + BP + diffusion + tone -137, stereo offset -133,
Off chain -147, bits -151, short delays with diffusion -116..-inf (several bit-exact),
modulation (time + cutoff) -126, time modulation alone bit-exact, cutoff modulation -133,
125 % feedback (limiter self-oscillation) -89.
Automation (FL `--at`): feedback, cutoff / resonance, spread, input wet, distortion,
mod cutoff -123..-132 dB; mod rate / mod time changes -108 / -110; offset glide -106;
model change -127; filter mode changes -137; diffusion level / spread changes -94;
mono offset -91; output tone through LP/HP -84; time glides -72..-81.

## Approximations and open questions

- Load: FL starts its engine from its own defaults and glides to the loaded state
  (smoothed controls, a time glide or a keep-pitch crossfade from stale taps); we apply
  a loaded state at once. In Keep pitch mode FL therefore carries a -61..-66 dB residual
  of its stale start-up taps until the first time change (keep-pitch renders -57..-69 dB).
  Its S&H counter phase also comes from that start-up, so S&H renders do not line up
  sample for sample (the hold law and pattern are FL's).
- Time glides differ from FL by ~1e-3 sample in the read position (-72..-81 dB).
- The saturation ceiling is a dense measured table, not FL's formula.
- FL's Set menu writes the item's Tag into the wheel, so "1/64" and "1/32" give raw 1
  and 2 (0:1, 0:2), not 12 and 24. Reproduced as is.
- The distortion display draws the normalized shape over +-2 (fits FL's screenshot
  exactly); for Limit we draw a hard ceiling (FL's Limit display not observed).
- The editor's sync dots around TIME follow the manual (one dot per step); their exact
  look in FL was not observed.
