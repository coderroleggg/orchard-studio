# Fast Dist (FL: Fruity Fast Dist)

Sources: FL 2026's plugin binary (`TTestPlug` ProcessParam 0x5d070, Eff_Render
0x5d5f0), the host's `DistWave_32FM` as reverse-engineered from
FLEngine_x64.dylib by the scratchpad test host (`flfxhost`, bit-exact,
`flfxhost tablecheck`), the form, the manual and renders through FL's plugin.

## Parameters (form 380 x 120)

| # | Name | Range | Default | Value text |
|---|---|---|---|---|
| 0 | Pre amp | 64..192 | 128 | round(v/192*100) % (128 = "67%") |
| 1 | Threshold | 1..10 | 10 | v*10 % |
| 2 | Distortion type | 0..1 | 0 | A / B |
| 3 | Mix level | 0..128 | 128 | round(v/128*100) % |
| 4 | Post gain | 0..128 | 128 | round(v/128*100) % |

Factory presets (read with `flfxhost info --preset`): Default (= the
constructor values), Some Oomph, Something, The Heat, compressor, fuzz,
overdrive, warmth; in `def.presets`.

## DSP (exact)

The plugin stores the raw values and, on every change of pre amp / mix /
post, computes with the knob law `g(v) = (11^(v/128) - 1) / 10` (exactly 1
at 128; 3.548 at 192, 0.2317 at 64):

```
mul = g(preAmp), post = g(post), mix = g(mix)
wet = mix * post
dry = (post - wet) * mul * post          // = post^2 (1 - mix) mul (FL's formula, verified)
```

Eff_Render is a single call `Host.DistWave_32FM(type, thres, buffer, 2n, dry, wet, mul)`
on the interleaved buffer (memoryless, so channels are independent). FL's
host builds a 2 x 10 x 8192 int16 curve table (k = 10 - thres, x = j/8191,
rint):

- type A: `db = 20 log10 x; if db >= -25: db = -25 + (db + 25)(k+1)/10; if db <= -(9-k)1.6: db += (9-k)1.6`
  (threshold 10: 10:1 above -25 dBFS with +14.4 dB make-up; threshold 1: identity)
- type B: `att = -20 log10 x; out = 10^(-att^(0.8 + 0.02k) / 20)` (compresses the
  attenuation: fuzz-like gain near zero)

and `out = x * dry + sign(x) * T(|x| * mul) * wet / 32768`, with T read at
index `|x| * mul * 8191`: truncated during playback (dead zone below
1/8191 and a step at the first entry, audible as crossover grit on type B),
linearly interpolated when exporting. Threshold "100%" is the strongest
setting. No smoothing, no latency, no tail.

Gains as FL's ProcessParam computes them (single precision except the
exp): `s = f32(v x 0.0078125)`, `g = s == 1 ? 1 : f32((exp(f32(s x
f32(ln 11))) - 1) x f32(0.1))`; `wet = f32(mix x post)`, `dry =
f32(f32(f32(post - wet) x mul) x post)`. The kernels (the host's bit-exact
reimplementation): live `out = f32(f32(x dry) + f32(sgn T[trunc(f32(|x|
f32(mul 8191)))] f32(wet / 32768)))`; export: the same with linear
interpolation (`s3 = f32(x m)`, `k = int32(trunc s3)`, `frac = f32(s3 -
f32(k))`, negative k mirrored). Both clamp the index at 8191.

Measured (FL, export kernel): type A thres 10: 0.01->0.0527, 0.1->0.3126,
0.5->0.3672, 1->0.3935; type A thres 5: 0.1->0.1660, 1->0.6607; type B
thres 10: 0.5->0.6163, 1->1.0000.

## Our implementation

`src/engine/effects/plugins/distructor/fastdist.ts` (shared with
Distructor): FL's tables (generated at first use, JS libm, rint; all 20 x
8192 entries match FL's, read back through FL's plugin), FL's single-
precision gain law and both kernels. The plugin uses the truncating kernel
during playback and the interpolating one when `FxContext.rendering` is set
(project WAV export = FL's "HQ for all plugins"). No oversampling, no
smoothing: gain, type and threshold changes take effect at the next block,
as in FL. Departure (keeps the output finite): NaN / Inf input -> 0 (FL
would pass NaN on).

Fidelity: bit-exact against FL in live and export mode on noise, sweeps and
ramps (6 static cases each) and on automation of all five parameters.
Before this pass (4x oversampling + ADAA, interpolating kernel always,
4 ms gain smoothing, 5 ms crossfades): about 0 dB sample residual (-41 dB on
a slow ramp).

Distructor's Fast dist model keeps the truncating kernel in export mode too
(FL's module does not switch; measured).

## Editor

Purple-grey panel (radial gradient #58565c -> #4a484e) with FL's wheel
style: 33-tick scale (long every 4th) or 10 ticks on THRESH, sweep +-154 deg,
dark ring, outlined cap, light pointer on the ring; the A/B pill switch
(click the pill to toggle, a letter to select); captions; a title strip
("FAST DIST" outlined italic and a bolt badge, our own drawing); the
transfer-curve display (#793c2f, 4 x 4 grid #995d34, curve #ffbc4c) showing
the static curve for the current settings over input 0..1 / output 0..1.

## Open questions

- Whether FL's display includes mix / post (we draw the complete transfer
  function; at the default settings it is identical).
