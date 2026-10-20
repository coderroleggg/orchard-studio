# Filter (FL: Fruity Filter)

Files: `src/model/fx/plugins/filter.ts`, `src/engine/effects/plugins/filter.ts`,
`src/ui/plugins/fx/filter/index.tsx` (+ shared widgets in `filter/vector.tsx`),
`tests/fx/filter.test.ts`.

Sources: FL 2026 form (`Fruity Filter.txt`), manual page, screenshot
`Fruity_fiter.png`, and measurements of FL's plugin binary through the test
host (`flfxhost info / sweep / render`, impulse and noise renders compared
sample by sample).

## Parameters (FL order = form Tags)

| # | key | FL name | range | default | notes |
|---|---|---|---|---|---|
| 0 | cutoff | Cutoff frequency | 0..1024 | 1024 | |
| 1 | res | Resonance | 0..1024 | 205 | |
| 2 | lp | Low pass | 0..1024 | 1024 | mix amount |
| 3 | bp | Band pass | 0..1024 | 0 | mix amount |
| 4 | hp | High pass | 0..1024 | 512 | mix amount |
| 5 | x2 | X 2 | 0..1 | 0 | switch |
| - | center | Remove DC offset | 0..1 | 1 | editor switch (Tag -1), not automatable |

The plugin returns no value texts (`GetName(FPN_ParamValue)` is empty), so
the clone shows FL's percentage fallback. Each wheel has a value slider
(Tag -(index+1)) that mirrors and edits the same parameter.

## DSP (exact, verified against FL to float precision)

Chamberlin state variable filter per channel, per sample:

```
low  += f*band
high  = in - low - q*band
band += f*high
out   = gl*low + gb*band + gh*high
```

- `f = (26^(cutoff/1024) - 1) / 25` (0..1). The coefficient does not depend on
  the sample rate (checked at 44.1/48 kHz), so the cutoff in Hz scales with
  it, as in FL (f = 2 sin(pi fc/fs): f = 1 is fs/6).
- `q = 1 - 0.8*res/1024` (damping 1..0.2, i.e. Q 1..5).
- Mix gains `(11^(m/1024) - 1) / 10` (0..1).
- **X 2**: the mixed output goes through a second SVF with the same f but no
  resonance (q = 1) and is mixed again with the same gains (so a lone output
  gets its gain squared and a 24 dB/oct slope).
- **CENTER**: `out -= s2` with `s1 += (out - s1)*0.03948526`,
  `s2 += (s1 - s2)*(1 - exp(-25.51/fs))` (two cascaded one-pole smoothers;
  -2 dB at 5 Hz, +0.09 dB bump near 100 Hz).
- **Smoothing** (measured with block sizes 32..512): per processed block the
  wheel values move `min(1, n/128)` of the way to their targets; f, q and the
  three gains ramp linearly from their previous values to the values at the
  block end.
- Stable for every setting (f <= 1, q >= 0.2). Latency 0. Tail: computed from
  the pole radius sqrt(1 - f q) (decay to -80 dB, 0.1..4 s).

At cutoff 0, f = 0 and the filter state freezes (the low pass holds its last
value, removed by CENTER). This is FL's behaviour and is kept.

## Editor

Form coordinates and FL 2026 colours (panel #444a4f, bevels #50585b, caption
boxes #5a636a, text #c9d8e0, wheel/slider colour #d8ffd4). The wheel is FL's
vector knob: 300 degree sweep (verified on the screenshot: 20 % points at 9
o'clock), 4 px value ring, two-tone body. The switches are FL's TSwitchSelector.

## Approximations / open points

- The two-tone shading of the knob body is a model (pointer-side bevelled cap,
  split along the pointer) that matches most angles but not all.
- Caption font: Arial 8.4 px with letter spacing (FL uses its own renderer).
- FL's presets (Default, Party next door, Retro sound, Tiny speakers) are in the
  def, with values read from FL's .fst states through the test host.
