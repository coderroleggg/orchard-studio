# 7 Band EQ (FL: Fruity 7 Band EQ, legacy)

Files: `src/model/fx/plugins/eq7.ts`, `src/engine/effects/plugins/eq7.ts`,
`src/ui/plugins/fx/eq7/index.tsx`, `tests/fx/eq7.test.ts`.
Hidden (legacy). 14 factory presets ("Fruity 7 band EQ" folder; values read
with the test host, Default first).

Sources: FL 2026 form (`Fruity 7 Band EQ.txt`: 340 x 150, seven vertical
sliders -1800..1800 (dB x 100) Tags 0-6, captions 63 / 250 / 500 / 1500 /
3000 / 5000 / 8000), the manual screenshot and FL's thumbnail, renders of
FL's binary (`b5/eq7*.py`).

## DSP (fitted from noise input / output, residual 5e-8)

Impulse-response biquad fits were ill-conditioned for the fast shelves (wrong
coefficients with tiny residuals); equation-error fits on 1-2 s of noise gave
clean results:

- Band 1: **first order** low shelf, band 7: **first order** high shelf
  (a first order model fits as well as any higher order), bilinear and
  prewarped with the midpoint (half the dB gain) at 63 Hz / 8000 Hz for every
  gain: pole (1 - K sqrt V) / (1 + K sqrt V), zero (1 - K / sqrt V) / (1 + K /
  sqrt V) (HS; LS mirrored), K = tan(pi f / 44100), V = 10^(dB / 20).
- Bands 2-4: RBJ peaking, bandwidth 2 octaves (250, 500, 1500 Hz); bands 5-6:
  RBJ peaking, 1 octave (3000, 5000 Hz) (max coefficient error 1e-7).
- Everything is designed for 44.1 kHz whatever the sample rate (at 48 kHz the
  bands sit 8.8 % higher than their captions).
- Bands in series, direct form I, levels apply at once. Static settings match
  FL to -77 .. -105 dB (FL's single precision: even all-flat differs by 8e-6);
  jumps of peaking levels are exact (-92 dB); jumps of the shelf levels give a
  short different transient (-29 / -42 dB): FL's shelf update is not a plain
  DF1 / DF2 / TDF2 / LP-state coefficient swap (open item).

## Editor

FL's slider strip: ticked grooves, 3D caps, a pale value bar from 0 dB,
frequency captions in rounded boxes, at the form coordinates.
