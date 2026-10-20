# Phaser (FL: Fruity Phaser)

Smart Electronix port (Bram's SupaPhaser, reduced to 9 controls) in FL's `TTestPlug`
editor. Measured from FL 2026's binary with `flfxhost`. Files:
`src/model/fx/plugins/phaser.ts`, `src/engine/effects/plugins/phaser.ts`,
`src/ui/plugins/fx/phaser/index.tsx` (shared grid from `../chorus/TestPlugEditor`),
`tests/fx/phaser.test.ts`.

## Controls

| # | Name | Range (Default) | Mapping | FL text |
|---|---|---|---|---|
| 0 | Sweep frequency | 0..5000 (1500) | x = v/5000 (see rate law) | `0.30000 Hz` (text is just x) |
| 1 / 2 | Minimum / Maximum depth | 0..1000 (0 / 900) | allpass coefficient v/1000 | `0.90000` |
| 3 | Frequency range | 0..1024 (0) | large above 512 | `small` |
| 4 | Stereo | 0..1024 (512) | right LFO leads by v/1024 x half a cycle | `0.50000 phase` |
| 5 | Number of stages | 0..22 (11) | sections = max(3, v + 1) | `12` (label `Nr. stages: 12`) |
| 6 | Feedback | 0..1000 (693) | fb = v/1000 | `0.69300 amount` |
| 7 | Dry - Wet | 0..1024 (0) | dry share d = v/1024 | `100 % wet` (banker's rounding) |
| 8 | Output gain | 0..5000 (2500) | v/2500 | `0.00000 dB`, `-oo   dB` |

Defaults are FL's "Default" preset, which differs from the constructor in 7 controls
(constructor: 0.5, 0.1..0.8, 8 stages, 0.4, 50 % wet, +4.08 dB). 27 factory presets.
All 16103 swept texts match.

## DSP (measured, exact where stated)

```
u   = x sqrt(1 - fb^2) + 0.99 fb y[-1]                 exact (IR fit 1e-8)
y   = k sections (-a + z^-1)/(1 - a z^-1)               exact statically (h0 = (-a)^k)
a   = lo + (hi - lo)(1 + sin 2 pi phase)/2              per sample, matches to 4e-6
out = gain (d x sqrt(1 - fb^2) + (1 - d) y)             exact (the dry share is scaled too)
```

- LFO rate = R (e^(4x) - 1)/(e^4 - 1), R = 2 Hz (small) / 10 Hz (large); measured rates
  agree within 0.2 % (1.8 % near zero), the rest is FL's float32 phase accumulation,
  which we reproduce approximately. The LFO starts at phase 0 and runs freely.
- Null tests: static settings -126..-137 dB; modulated settings start at -50 dB and
  drift with the residual rate error (inaudible; phase alignment with FL is arbitrary
  in practice anyway). Under modulation a transposed direct form II with the
  coefficient taken before the phase step matched best.

## Our deviations

- Parameter changes apply at once, as in FL (measured with `--at`: FL's output does not
  depend on the host block size). Only the sections in use run; the others keep their
  state, so added sections start from rest. Residual differences on changes: after a
  Feedback change FL settles differently for ~20 ms (-18 dB at first, cause unknown);
  adding sections differs for ~2 ms (-26 dB).
- Tail = feedback ring time estimated from the chain's group delay, capped at 10 s.

## Editor

Shared TTestPlug grid (see chorus.md), light green accent #e6ffd4, text #f0ffdc.

## Open questions

- Exact float32 formulation of the LFO increment (would remove the slow drift).
