# Flanger (FL: Fruity Flanger)

Smart Electronix port hosted by FL's `TTestPlug` editor (same grid as Chorus and
Phaser). Sources: FL's form, the manual page, and FL 2026's binary measured with
`flfxhost` (texts by sweep; DSP by impulse responses, impulse trains and null tests).
Files: `src/model/fx/plugins/flanger.ts`, `src/engine/effects/plugins/flanger.ts`,
`src/ui/plugins/fx/flanger/index.tsx` (uses `../chorus/TestPlugEditor`),
`tests/fx/flanger.test.ts`.

## Controls (FL order = parameter index)

Skew law s_k(x) = x / (k - (k-1) x), x = v / max.

| # | Name | Range (Default) | Mapping | FL text |
|---|---|---|---|---|
| 0 | Delay | 0..1024 (0) | 20 s_5(x) ms (minimum delay) | `3.20513 ms` |
| 1 | Depth | 0..5000 (2000) | 20 s_5(x) ms (sweep width) | `2.35294 ms` |
| 2 | Rate | 0..5000 (2000) | 5 s_10(x) Hz | `0.31250 Hz` |
| 3 | Phase | 0..360 (119) | right LFO lead in degrees | `119 degrees` |
| 4 | Damp | 0..5000 (0) | one-pole coefficient v/5000 | `0.10000` |
| 5 | Shape | 0..1024 (0) | sine (0) to triangle (1) crossfade | `s------|-------t` (14 steps, banker's rounding) |
| 6 | Feed | 0..100 (24) | feedback 0.98 v/100 | `24 percent` |
| 7 | Invert feedback | 0..1024 (1024) | on above 512 | `on` |
| 8 | Invert wet | 0..1024 (1024) | on above 512 | `on` |
| 9-11 | Dry / Wet / Cross | 0..5000 (3500/3000/2500) | gain v/5000 | `-3.09804 dB`, `   -oo   dB` at 0 |

Defaults are FL's "Default" factory preset (Phase 119, Feed 24; the constructor uses
118/23). The 27 factory presets are in the def (values read through flfxhost).
Texts match FL exactly except the Delay/Depth/Rate laws, where FL's single-precision
arithmetic changes the 5th decimal in 1-3 % of the values. dB texts are exact with
20 log10(float32(v/5000)).

## DSP (measured)

Per channel, per sample:

```
lfo = (1 - shape) sin(2 pi ph) + shape tri(ph)       ph: L = phase, R = phase + Phase/360
d   = Delay + Depth/2 + floor(Depth/2) * lfo          (samples; the half-width is a whole number)
buf[w] = x + fb * y                                   (y = previous damped output; write first)
r   = buf[w - d]                                      (linear interpolation)
y   = (1 - damp) r + damp y                           (damping inside the feedback loop)
out = Dry x + s (Wet y + Cross y_other)               (s = -1 with Invert wet)
```

- fb = +-0.98 Feed/100; the feedback loop length is d + 1 samples.
- The sweep centre is exact but its half-width is floor(Depth_samples / 2): depth
  103.77 samples sweeps 0.88..102.88 (FL measurement; 42 / 280.6 / 882 samples give
  half-widths 21 / 140 / 441).
- Triangle and sine both start at 0 rising; R leads by Phase. Shape 512 measured as
  exactly 0.5 sin + 0.5 tri.
- The LFO is free-running from creation and accumulates its phase in float32: FL's
  rates are off by up to 0.1 % (0.3125 Hz runs at 0.31280 Hz); our float32 cycles
  accumulator brings this to within 140 ppm.
- Null tests (1.5 kHz-band noise): static settings -87..-90 dB; LFO frozen -79 dB;
  modulated -44..-53 dB (residual LFO drift), lower with high feedback since it
  amplifies phase drift.
- Tail: (Delay + Depth) x (log 1e-4 / log |fb| + 1) + 20 ms, capped at 30 s.

## Approximations

- FL's read position is a float32 near the write index, so fractional delays are
  quantized to 1/4096 sample there; we read exact positions.
- Parameter changes: every control applies at once, as in FL (measured with `--at`;
  Dry / Wet / Cross / Invert wet are sample-exact, the others then ring through the
  feedback exactly like FL's).

## Editor

Shared TTestPlug grid (see chorus.md) with the cream accent #fff8d4 (value text
#ffffdc). No display, no extra menu items.

## Open questions

- Exact float32 formulation of the LFO accumulator and of the skew-law texts.
