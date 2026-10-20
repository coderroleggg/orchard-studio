# Soundgoodizer

FL Studio's one-knob "maximizer-enhancer". Files:
`src/model/fx/plugins/soundgoodizer.ts`, `src/engine/effects/plugins/soundgoodizer.ts`,
`src/ui/plugins/fx/soundgoodizer.tsx`, `tests/fx/soundgoodizer.test.ts`. The DSP
is the Maximus core (see maximus.md).

## What FL does (measured with flfxhost on `Soundgoodizer_x64.dylib`)

- **No automatable parameters** (NumParams 0). The state is 12 bytes: int32 3
  (version), int32 mode (0..3 = A..D), int32 amount (0..1000, default 600).
  Both controls are kept as `noAuto` parameters here (bound controls, undo,
  hints, but no automation, as in FL).
- **Modes** load `Plugins/Fruity/Effects/Soundgoodizer/Data/Presets/a..d.dat`,
  which are byte-identical to the Maximus factory presets
  `Soundgoodizer presets/a..d.fst` (version-4 Maximus states).
- **The knob is the LMH mix** (manual) and indeed: Soundgoodizer output equals
  Maximus with that preset and LMH mix = amount, with one difference:
- **Its built-in Maximus omits the low-band allpass compensation** of the 24 dB
  split (an older engine). Modes A and B (24/24 dB) differ from current Maximus
  by -22 dB on drums; without the compensation the clone matches FL's
  Soundgoodizer. C (24/12) and D (low and high bands off) are unaffected.
  Implemented as `lowComp: false` in the core configuration.
- No sidechain input (no FHD_RegisterSideInput call; output identical with
  flfxhost `--sc`).
- Latency (FHD_SetLatency, 44.1 kHz): A 153, B 88, C 153, D 176 samples
  (LMH delay 1.48 ms in A and C + 2 ms master attack).

Mode summary (from the presets): A: 3-band with type A saturation on LOW/HIGH,
stereo narrowing in LOW (100 % merged) and widening in MID, master type A
19.6 %. B: bands uncompressed (COMP OFF) with saturation and post gains,
master soft-knee compressor (type A 29.6 %). C: like A with a 12 dB high split
at 2.3 kHz and no master saturation. D: MID only (full range) RMS compressor,
master limiter.

## Calibration

FL's Soundgoodizer vs the clone, all modes, amounts 0 / 60 / 100 %: drum loop
-64..-71 dB, decorrelated noise -76..-84 dB relative error (residual: Maximus'
low cut). Tests hold FL levels: A 60 % with a 1 kHz -6 dBFS sine RMS 0.50996,
peak 0.72087; C 100 % with 100 Hz -3 dBFS RMS 0.67999, peak 0.92443; latencies.

## Editor

210 x 294 (FL's SynthPanel2): wooden cheeks, brushed-metal body (narrow
reflection at the top, soft highlight under the knob), "SG / POWERED BY
MAXIMUS" lettering, the Amount knob (MixWheel 23, 60, 164 x 164) with a
36-cell blue LED ring lit clockwise from 6 o'clock over 30 cells (FL: 180 deg
at 60 %), silver disc, and the A / B / C / D LEDs at FL's positions (orange
when selected). Vertical drag on the knob, click a LED or letter for the mode.
All drawn with SVG.

## Open questions

- FL's hint text for the knob value (no host value text: assumed `60%`).
- The editor's hidden Maximus panel (SynthPanel) is not shown in FL either.
