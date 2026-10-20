# Blood Overdrive (FL: Fruity Blood Overdrive)

Sources: FL 2026's plugin binary (`Fruity Blood Overdrive_x64.dylib`, arm64
slice: `TTestPlug` VMT, Eff_Render at 0x5d7f0, parameter update at 0x5dc70,
shaper lookup at 0x5dda0, table init in the constructor), the editor form,
the manual and renders through FL's real plugin (scratchpad `flfxhost`).
Our implementation is FL's code in FL's single precision and matches FL's
output bit for bit (noise, sweeps, x100, inputs up to +-30 that hit FL's
integer wrap, automation of every parameter, state loads, 44.1 / 48 /
96 kHz).

## Parameters (form 420 x 180)

| # | Name | Range | Default | FL value text | Internal |
|---|---|---|---|---|---|
| 0 | Pre band | 0..10000 | 0 | `0.0000`..`1.0000` | pb = v/10000 |
| 1 | Color | 0..10000 | 5000 | same | c = v/10000 |
| 2 | Pre amp | 0..10000 | 0 | same | p = v/10000 |
| 3 | x100 | 0..1 | 0 | `Off` / `On` | |
| 4 | Post filter | 0..10000 | 0 | same | pf = v/10000 |
| 5 | Post gain | 0..10000 | 10000 | `-1.0000`..`0.0000` (v/10000 - 1) | g = v/10000 |

Factory presets (`.fst`, event 213 = 9 int32: version 3 then the six values):
Boost (4000, 5000, 2000, off, 2500, 10000), Drive (8500, 5000, 10000, off,
5000, 5000), Reset (defaults). In `def.presets` (the plugin window's preset menu). There is no "Default" preset, so the defaults are the constructor values.

## DSP (exact, per sample, both channels independently)

FL's code (Eff_Render 0x5d7f0, update 0x5dc70, lookup 0x5dda0), every step a
float32 operation in this order, no fused multiply-add.

Parameters: `p_i = f32(raw_i / range)`. Update (on every parameter change):
`gainT = f32(f32(k p^3) + 1)` (k = 25, or 2500 with x100 > 0.5),
`nbT = f32(1 - pb)`, `pgT = f32(g^2)`, `fT = f32(c^3)`; each stored as
`target x f32(0.00025)`; post filter `a = f32(f32(pf x f32(0.7)) + f32(0.2))`,
`b = f32(1 - a)` (switches at once, not smoothed).

Smoothing, once per frame: `v = f32(f32(v x f32(0.99975)) + targetS)` for
gain, nb, pg, f. FL's constructor values are (1, 1, 1, 0); SaveRestoreState
(a state load) sets the parameters and then runs this recursion sample-rate
times (FL's sample rate helper), so a loaded state is practically settled.
Parameter edits (ProcessParam) glide.

```
SVF1 (Chamberlin, damping 1):  low1 += f*band1; high1 = x - low1 - band1; band1 += f*high1
in2 = gain * ((high1 + low1) * nb + band1)          // pre band: mix toward the band-pass
SVF2 (f = 0.25, damping 1):    low2 += band2*0.25; high2 = in2 - low2 - band2; band2 += high2*0.25
y = (T(low2) + T(band2) + T(high2)) * pg             // 3 bands shaped independently
y = clip(y, +-f32(0.99995))
lp1 = y*b + lp1*a; lp2 = lp1*b + lp2*a; out = lp2
```

`T` is FL's 65536-entry single-precision table: `T[32768 + i] =
f32(sin(i pi / 65536))`, `T[32767 - i] = -T[32768 + i]` (i = 0..32767; the
negative side is offset by one entry). Index `w = trunc(f32(u x 32767)) +
32768` as int64, its low 32 bits as a signed int, clamped to 0..65535: so
|u| >= 1 reads +-sin(32767 pi / 65536), NaN reads 0, and u >= 65537 wraps to
entry 0 (about -1), as FL does. The SVF states (not the post filter's) are
flushed below 2^-24 at the start of every block. No sample-rate dependence
(the filters are per-sample constants), no latency, no tail.

What this means acoustically: SVF2 (centre ~1.76 kHz at 44.1 kHz) splits
the signal into low / band / high parts that saturate separately (the
manual's "upward compression on the independent frequency bands"); their
sum is not flat even when clean (about -0.7 dB at 700 Hz, +2.4 dB at 3 kHz,
the post filter at its minimum still rolls off -3.7 dB at 20 kHz). The
small-signal gain is pi/2 (+3.9 dB) at Pre amp 0. Color sets the pre band
SVF frequency (f = c^3: ~880 Hz at 0.5, 7.35 kHz at 1). x100 is a hard,
unfiltered square-wave shaper at the base rate (FL's aliasing included).

## Our implementation

`src/engine/effects/plugins/distructor/blood.ts` (shared with Distructor):
a line-by-line port in single precision (`Math.fround`), at the base rate,
with FL's table, lookup and state-load pre-settling (`BloodCore(sampleRate)`;
Distructor's module uses `BloodCore(0)`: it does not pre-settle, see
distructor.md). The only departures keep the output finite: NaN / Inf input
samples become 0 and non-finite filter states are cleared.

Fidelity (FL vs ours, 44.1 kHz unless noted): bit-exact on 7 static cases
(noise, sweeps, x100, +-30 input), on automation of all six parameters
(including x100 and post filter steps), on state loads from preroll 0, and
at 48 / 96 kHz. Before this pass the plugin ran 4x oversampled with ADAA and
a continuous sine: -6.5..+4 dB sample residual (about 3 samples of group
delay, different aliasing); the 1x core was -62..-81 dB.

Difference left: FL's preset menu loads a state (pre-settled smoothing);
our preset loads arrive as ordinary parameter changes and glide with FL's
smoother (0.99975 per sample) instead.

## Editor

FL's "Dark Brown" skin: horizontal grey gradient (#343434 edge -> #434343
centre), 1 px dividers at x 134 / 287, faint lightning bolt behind Pre amp,
label plates #545454 with #838383 9 px text, knobs = arc track +-155 deg
(#414141, outline #303030) filling with #ff2c08, black rim with a top
highlight, grey body whose darker part tilts +-26 deg with the value (FL's
knob is a rendered filmstrip; the tilt / offset are measured from the
manual screenshot), red pointer on the rim. x100 is a rounded square that
lights red. Right-click the background: Theme menu (Dark Brown, Brown
Metalic, Brown Metalic Panels, Blood Red); the plugin menu has Theme and
Presets. Only Dark Brown has a reference screenshot; the other three are
our interpretation of the names.

## Open questions

- Exact look of the three non-default themes.
