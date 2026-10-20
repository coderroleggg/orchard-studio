# Balance (FL: Fruity Balance)

Sources: FL's form (227 x 148: PanWheel, VolWheel, a peak meter), the manual
page, and FL's binary measured with the test host (`flfxhost info/sweep/render`
on "Fruity Balance"). Files: `src/model/fx/plugins/balance.ts` (parameters,
texts), `src/engine/effects/plugins/balance.ts` (DSP),
`src/ui/plugins/fx/balance.tsx` (editor), `tests/fx/balance.test.ts`.

Balance is the framework's reference plugin (docs/fx-framework.md).

## Parameters

| Index | Key | Name | Range | Default | Text |
|---|---|---|---|---|---|
| 0 | pan | Balance | -128..128 | 0 | `Centered`, `35% left`, `100% right` |
| 1 | vol | Volume | 0..320 | 256 | `0.0dB  1.00` (dB and linear gain, two spaces), `-InfdB  0.00` |

- Balance text: |v|·100/128 rounded half to even (80 reads `62%`). [C: host sweep]
- Volume: FL's volume law, gain = (11^(v/256) − 1)/10, so 256 = unity and
  320 = +5.6 dB. [C: host sweep, all 321 texts]

## DSP [C: host renders, bit-exact at static settings]

- x = float32((pan + 128)/256), p = float32(pan/128), θ = (1 + p)·π/4.
- k = (1 − sin(π·|x − 0.5|)/2) / (10·cos(π/4)).
- g = float32(11^float32(1.25·vol/320) − 1) · k, which is √2·(11^(vol/256) − 1)/10 at the centre.
- LL = g·cos θ, RR = g·sin θ. The channel balanced away pours into the other
  one: panned left, R→L = LL − RR; panned right, L→R = RR − LL. Hard left gives
  L' = (L + R)/√2, R' = 0. The centre is the identity.
- Per sample, in float32: L' = c0·L + c2·R, R' = c1·R + c3·L.
- The four coefficients move once per block toward their targets with FL's
  shared smoother: at most 10·float32(44.1/sr) per sample (0.01 at 44.1 kHz),
  with |c| < 2^-24 snapping to 0. They start from zero when the plugin is
  created, which gives a short fade-in.

## Editor

Classic vector knobs (purple balance, blue volume) with their value texts,
and a stereo peak meter between them. The meter reads the output peaks
(instant attack, ~20 dB/s fall, 1.5 s hold) on FL's compressed scale with
0/6/12/18/24/30/39 dB marks.

## Fidelity

- Static settings: bit-exact (float32-identical) against FL's renders. The
  test pins FL's outputs for L = 0.5, R = 0.25 DC at 8 pan / volume settings
  (hard left, -64, -1, centre, 37 at vol 300, hard right at vol 100, vol 0,
  -100 at vol 320).
- Parameter changes: the fade-in from zero and the per-block ramp match FL
  sample for sample at 44.1 kHz with 64- and 512-frame blocks (pinned values
  in the test).
- Gaps: none known.
