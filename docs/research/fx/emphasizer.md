# Emphasizer (`emphasizer`)

FL Studio 2026 "Emphasizer" (Image-Line; DSP by Dario Sanfilippo). Category Dynamics. Editor
580 x 120. Measured on FL's binary with `flfxhost`.

**Not an Emphasis preset.** Its algorithm differs from Emphasis: a 2 ms look-ahead, a static
(memoryless) clipper whose distortion does not depend on frequency, and a slow clean stage.

## Parameters

| # | key | FL name | range (def) | mapping / text |
|---|---|---|---|---|
| 0 | inputGain | Input gain | 0..10000 (0) | 24 v/10000 dB, `%.1f dB` |
| 1 | emphasis | Emphasis | 0..10000 (Default preset 5013) | `round(float(v/10000)*100)%` |
| 2 | clipping | Clipping | 0..1 (0) | `Hard` / `Soft` |
| 3 | levelMatch | Level matching | 0..1 | output x 10^(-input gain/20) |
| 4 | bypass | Bypass | 0..1 | latency-aligned dry |
| 5 | outputGain | Output gain | 0..10000 (10000) | linear (11^x - 1)/10, `-12.7 dB`, `-Inf dB` |

All 30009 value texts match FL. The only factory preset is Default (Emphasis 50 %).
State: `lufsPaused` (Options > Pause LUFS), `lufsReset` (double-click on the LUFS meter).

## Measured behaviour

* Latency 2 ms (88 / 96 / 192 samples at 44.1 / 48 / 96 kHz), exact; below the limit the signal
  passes unchanged.
* Stage 2 is static: hard clip at 1.0, or soft: linear to 0.86 then a rational knee
  y = T + (1-T) d / (1 + d^1.65)^(1/1.65), d = (u-T)/(1-T), T = 0.86 (max error 0.004).
* Stage 1 is stereo-linked and leaves the clipper a fixed, level-independent overshoot in steady
  state: -0.1 / 0.18 / 1.06 / 2.77 / 5.93 dB at Emphasis 0 / 25 / 50 / 75 / 100 %.
* At Emphasis 0 it is a 2 ms look-ahead limiter to -0.1 dBFS (pre-duck from -2 ms). Above 0 the
  clipper takes onsets alone and stage 1 takes over after a dead time and with a time constant
  that grow with Emphasis (+12 dB tone: dead time 0 / 8 / 50 / 145 / 450 ms, time constant
  6 / 37 / 150 / 420 / 750 ms at 10 / 25 / 50 / 75 / 100 %). Both shrink for large overshoots
  (~(12 dB / overshoot)^2 above 12 dB).
* Release: 20 ms hold, then ~70 dB/s for up to 80 ms while the reduction is more than ~6.5 dB
  above its target (abrupt stops), otherwise ~20 dB/s (dense material such as drums).
* Static THD at 0.6 s into a tone (hard): 0 % at 0, 0.7 % at 25, 5.6 % at 50, 13.4-18.1 % at 75,
  13.4 / 23.2 / 31.8 % at 100 % for +3 / +6 / +12 dB (identical at 100 Hz, 200 Hz and 1 kHz).

## DSP (clone)

`src/engine/effects/plugins/emphasizer.ts`: two stage-1 components in dB, the larger wins: (A)
look-ahead peak limiting beyond an instantaneous allowance (-0.1 dB at 0 %, effectively off
above); (B) a servo on the overshoot (input level envelope minus stage-1 reduction minus the
allowance) with a dead-time delay line and integration rate 1/tau, both scaled for large
overshoots. Then the clipper, output gain, level matching and bypass. Meters: total GR
(stage 1 + clipper), output peak / RMS, LUFS-I (BS.1770 gating; pause and reset).

Results against FL: THD snapshot table 1.8 % rms error (all Emphasis values, hard and soft);
stage-1 trajectories within ~1 dB; release curves within ~0.3 dB; drum loop RMS within 0.1 dB
for Emphasis 50-100 % and within 0.4 dB at 0 %.

## Open questions

* Very heavy drive with low Emphasis (+18 dB input at 25 %) is up to 1.3 dB louder than FL on
  drums: FL's servo reacts faster and deeper there (adaptive behaviour not fully decoded).
* The GR meter's red marker is drawn as a peak hold; FL's exact meter ballistics are estimated.
