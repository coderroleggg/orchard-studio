# Free Filter (FL: Fruity Free Filter, legacy)

Files: `src/model/fx/plugins/freefilter.ts`, `src/engine/effects/plugins/freefilter.ts`,
`src/ui/plugins/fx/freefilter/index.tsx`, `tests/fx/freefilter.test.ts`.
Hidden (legacy). 9 factory presets (values read from FL's .fst files with the
test host; Default = initial state).

Sources: FL 2026 form (`Fruity Free Filter.txt`: 419 x 105; Type wheel
100..700 Tag 0; Frequency / Q / Gain 0..1024 Tags 1-3; CENTER switch Tag -1,
on), FL's thumbnail (Fruity Filter skin, pink accent, value texts under the
captions, a value bar for Q), value-text sweeps and renders of FL's binary
(`b5/ff*.py`).

## Mappings (value texts, all 1025 / 601 values checked)

- Type: 7 zones of 600 / 7: floor((v - 100) * 7 / 600) -> Low pass, Band pass,
  High pass, Notch, Low shelf, Peaking, High shelf (boundaries 186, 272, 358,
  443, 529, 615).
- Frequency: 10 + 159.9 (101^t - 1) Hz ("1457 Hz" at 512, 16000 Hz at 1024) -
  the Parametric EQ curve.
- Q: 0.1 + 18.9 t (filter types), 0.1 * 1000^t (peaking), shelf slope
  0.1 + 1.9 t (Parametric EQ band mappings; fitted Q 3.22 / 9.56 / 19.0 at
  169 / 512 / 1024). FL's text draws round(filter Q) bars ("|||").
- Gain: (v - 512) / 512 * 18 dB; FL's text omits the sign ("18.0 dB" at 0).

## DSP (sample-exact)

- One RBJ biquad, **designed for 44.1 kHz at every sample rate** (fitted corner
  1586 Hz at 48 kHz for the "1457 Hz" setting, 1457 Hz at 44.1 kHz, 34.8 kHz at
  96 kHz for 16 kHz).
- Direct form I. Parameter changes act immediately (no glide); a type change
  clears the filter memory. With these, jumps of frequency / Q / gain / type
  match FL to -84 .. -108 dB (a TDF2 or gliding model gave -9 .. -35 dB:
  FL's DF1 transients on coefficient jumps are part of its sound).
- CENTER: Fruity Filter's DC remover (0.03948526 / 1 - exp(-25.51 / sr)).
- Static settings: -100 .. -130 dB for all types (peaking with high gain
  -73 dB, FL's single precision).

## Editor

FL's layout: TYPE / FREQ / GAIN sections (wheel, caption, value text), Q with
its value bar, CENTER switch; FL's logo glyph replaced by a generic curve mark.
