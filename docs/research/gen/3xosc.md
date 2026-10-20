# 3x Osc (FL: 3x Osc)

Sources: FL Studio 2026's plugin (`Plugins/Fruity/Generators/3x Osc/3x Osc_x64.dylib`,
FPC, arm64 slice, class `TTestPlug`), its HQ oscillator library (`3x Osc/engine.dylib`,
C++ with symbols), FL's `Shared/dsp_ippv2_x64.dylib` (the IPP calls the voice
engine makes), the editor form (`SynthEditorForm`), the factory states
(`Plugin presets/Generators/3x Osc/Default.fst`, `Plugin database/Generators/Synth
classic/3x Osc.fst`), FL's editor thumbnail, the online manual, and renders of FL's
real plugin through the test host (`flfxhost render "3x Osc"`, raw channel volume,
`--fixed-time 1700000000` for the random generators). Our implementation is FL's
code in FL's single precision and reproduces FL's output bit for bit (see Fidelity).

## Parameters (form 558 x 389)

| # | Name | Range | Form default | FL value text |
|---|---|---|---|---|
| 0 / 7 / 14 | Osc n panning | -64..64 | 0 | `Centered`, `N% left` / `N% right`, N = round(|v| / 64 x 100), banker's rounding (FPC Round: -40 = `62% left`) |
| 1 / 8 / 15 | Osc n shape | 0..6 | 0 | empty (sine, triangle, square, saw, rounded saw, noise, custom) |
| 2 / 9 / 16 | Osc n coarse pitch | -24..24 | 0 | `+0 semitone`, `-1 semitone`, `-12 semitones` |
| 3 / 10 / 17 | Osc n fine pitch | -100..100 | 0 | `+0 cent`, `+13 cents` |
| 4 / 11 / 18 | Osc n stereo phase offset | -64..64 | 0 | `-63%`.. (round half away from zero: 8 = `13%`) |
| 5 / 12 / 19 | Osc n stereo detune | -50..50 | 0 | cents as above |
| 6 / 13 | Osc 2 / 3 mix level | 0..128 | 64 | `50%` (|v| / 128, half up) |
| 20 | Stereo phase randomness | 0..64 | 0 | percent of 64 |

Parameters 21..113 of FL's list are the INS tab (the hybrid generator's envelopes,
LFOs and filter): the channel's INS settings here.

Switches without a parameter (state): invert osc 1 / 2 / 3, AM OSC 3 ("Oscillator 3 =
amplitude modulation"), HQ ("High quality (anti aliased oscillators)"). The custom
shape's sample is a pool id under `sample` (FL: the channel's sample); a sample
dropped on the editor or picked in the plugin menu sets it.

State format (SaveRestoreState 0x5c9b0): version 14 = the 21 parameters, bytes
invert 1 / 2 / 3 and AM, a byte HQ (+3), then the 91-integer INS block. Older formats
(parameters missing from them read 0): < 10 = 11 integers, shape 1, coarse 1, fine 1,
then mix / shape / coarse / fine of oscillators 2 and 3 (the first value doubles as the
version: shapes are < 10), switches and HQ off; 10 and 11 = the first 20 parameters, then
the four switch bytes (cleared for 10); 12 and 13 = the 21 parameters, the switch bytes
and, when present, HQ.

## Fresh instance and presets

- Constructor: every parameter 0 (only oscillator 1 sounds), switches off.
- `Default.fst` (factory preset, FL 2.5 format version 0) and the plugin database's
  `3x Osc.fst` (version 12, what FL loads when the plugin is added): osc 2 at 64 (50 %)
  and -12 semitones, osc 3 at 32 (25 %) and -24 semitones, everything else 0, switches
  off (the 88-byte version-12 state has no HQ byte; FL reads an uninitialised stack byte
  there, 0 in the test host). Both render bit-identically. `def.state()` makes the fresh
  instance this patch; each parameter's `def` stays FL's form value (the wheels' Reset).
- Factory presets: `Default` only. `Channel presets/3x Osc` (169 full channel states) are
  out of scope.

## DSP (exact)

### Oscillators (Voice_Render 0x5e2b0)

Per oscillator i (records at plugin +0x190, computed by ProcessParam 0x5d550):
pitch offset = coarse x 100 + fine; levels (0x5d3c0, float32):
`l3 = mix3 / 128; s = AM ? 1 : 1 - l3; l2 = (s x mix2) / 128; l1 = s - l2`, negated when
inverted; gains L / R = FL's pan law of (pan / 64, level) (the host's ComputeLRVol:
`a = f32((pan + 1) x pi / 4)`, L = cosf(a) x level, R = sinf(a) x level); right-channel
start phase = phase offset x 0x1ffffff; detune in cents.

Per FL render block of a voice:
- speed = round(f32(2^32 x 523.2511306 / rate) x exp(cents x ln 2 / 1200)) (0x6ca70;
  ties to even, low 32 bits), cents = FinalLevels.Pitch + offset (+ detune for the right
  channel), in float32 sums. Noise: speed = Random(0x99326) + 0x99326, drawn per block
  and channel pass (FPC's Random, also for silent noise oscillators).
- Non-HQ: 32-bit phase accumulators reading FL's host wavetables at `phase >>> 18`
  without interpolation (sine, triangle, square, saw, "analog" rounded saw, noise: FL's
  16384-point TFruityPlugHost.WaveTables, built exactly as FLEngine does; shape 6 reads
  the 16384-point custom shape, or the saw without one).
- Oscillator 1 is written, 2 and 3 added (out + t x g); an oscillator whose level is +0
  is skipped but its phase advances by speed x length; with AM, oscillator 3 computes
  out - out x (t x g) instead.
- The left pass, then the right pass with the right gains / phases / detuned speeds, or a
  copy of the left (phases copied too) when nothing is stereo: FL's stereo flag (0x5d4b0)
  is set by phase randomness or any oscillator with noise, phase offset, detune or
  panning, and a voice that has been stereo stays stereo.
- TriggerVoice (0x5dec0): phases 0 (left) and the phase offset (right); with phase
  randomness, plus (Random(rand << 18) - (rand << 17)) x 256 to each (left, then right
  per oscillator).
- Export: with FL's "HQ for all plugins" (PM_HQ_NonRealtime; `ctx.rendering` here) and
  HQ off, non-sine, non-noise shapes (0x5e7a0) are the average of n = max(1, speed >>> 22)
  copies with phases spread by speed / n (box anti-aliasing).

FPC's Random: genrand_MT19937 with the RTL's RandSeed / OldRandSeed handling (0x16020)
and Random(l) = (l x genrand) >> 32 (0x16130). FL seeds it with time(NULL) at load
(Randomize, 0x107b70); one generator per process.

### HQ oscillators (engine.dylib, 0x3660 Osc::addOsc)

Every output sample is `fma(s x m, gain, out)` (fused, single precision; m = 1, or -out for
the AM oscillator); "write" first clears the lane.
- Sine: sinf(f32(f32(phase / 2^32) x f32(2 pi))) (macOS libm's sinf, which is not
  correctly rounded: ported, 0 differences on 29 million arguments).
- Noise: a static LCG (seed 67998, x = x x 0x0bb38435 + 0x3619636b per sample, value
  f32(int32 x) / 2^31), shared by all instances; the phase advances by speed x length.
- Triangle, square, saw, rounded saw: engine.dylib's own 2048-point shapes (the rounded
  saw: 2 (1 - 0.997^(7600 x / 0.4638671875)) - 1, +1 from 950 / 2048, -1 from 5 / 6),
  custom: the 16384-point shape averaged over 8 points. Mip maps (createMipMapForWaveform
  0x210c): 16x linear upsampling (fused), a 32768-point kiss_fft (float, factors
  4^7 x 2, FMA in the complex multiplies), 44 levels keeping harmonics 0..cut_l (cut_0 =
  1024, / 2^(1/4) per level, truncated, at least 1; zeroed cumulatively per SIMD lane in
  FL, equivalently bins cut_l + 1 .. 32767 - cut_l), inverse transform / 32768, two wrap
  points. A voice reads level trunc(clamp(4 log2(f / 8.176 Hz) - 5, 0, 42)) with linear
  interpolation (fused); below 0.0005 cycles per sample the naive shape is computed
  (the custom shape gives 0 there).

### Voice engine (FL's channel sampler code linked into the plugin)

For each voice, after Voice_Render (0x1ccdd0):
- Release (Voice_Release with the INS volume envelope off, 0x1cd570): the "out" fade, type
  3, 10 ms, built once when the plugin is created at 44100 Hz, so 441 samples at every
  rate: `t[i] = (cos((i + 1) pi / 442) + 1) / 2` through ippsVectorSlope_32f /
  ippsMulC_32f_I / ippsCos_32f_A11 (= vvcosf on macOS) / ippsAddC_32f; the buffer is
  multiplied from the first sample after the note off, zeroed after it, and the voice is
  killed after the block in which the fade ends. No fade-in at the start.
- Gain: target = FL's pan law (0x2ba0, sincosf) of clamp(FinalLevels.Pan, -1, 1) and
  FinalLevels.Vol (x the INS envelopes, which arrive in the levels here). The first block
  uses the target directly; later blocks ramp (0x71480): step = (target - last) / length,
  clamped to +-0.001 per sample (then target = last + step x length, 0 below 2^-24); mixed
  by the NEON kernel 0x3768 (even / odd sample gain accumulators advancing by 2 steps;
  for lengths not a multiple of 8 the tail samples advance with the left and right steps
  crossed, as in FL) or, with zero steps, 0x3488 (out + buf x gain).

## Our implementation

`src/engine/gen/plugins/3xosc.ts` (voice, parameters), `3xosc/tables.ts` (host
wavetables, the 441-entry fade table), `3xosc/rng.ts` (FPC's Random), `3xosc/hq.ts`
(engine.dylib: kiss_fft, mip maps, sinf, exact `fma32`). `levels: 'plugin'`: the voice
applies FL's pan law and ramps itself after the release fade (the channel's gain and pan
are 1); velocity stays in `levels.vol` (FL: linear in FinalLevels.Vol).

FL renders a voice a whole block at a time (both passes, then fade and mix); here an FL
block is the channel's audio block (128 frames; a voice's first block ends with the
current audio block), rendered when it starts and served to the channel's 16-frame
steps, so levels, pitch, noise draws and parameter changes take effect per block as in
FL (whose blocks are its audio buffer split at ticks and events). `setBlockLength(n)`
is a test hook for the host's block structure.

The random generator is shared by all 3x Osc instances like FL's, seeded with
1700000000 (FL: the clock; `seed3xOscRandom()`); the HQ noise LCG likewise
(`resetHqNoise()`). HQ mip maps are built (about 50 ms per shape, shared) when
setParams first plays a shape in HQ, so voices never allocate.

Custom shape: FL converts the channel sample (FLEngine 0x7564e0: select all, its
resampler mode 6 to 16384 / length, then hands the data to the plugin). That resampler is
not ported: we use a mono mix linearly resampled over the whole sample (identical for a
16384-frame sample).

## Fidelity (FL 2026 vs ours, test host renders)

Bit-exact (every sample, both channels), 44.1 kHz unless noted:
- through the real GenChannel (128-frame blocks): constructor state, Default patch,
  shapes 1..4, 48 kHz, velocity 64, coarse / fine, panning, detune, phase offset, mix
  levels with saw / square, note panning, five overlapping notes incl. a 5 ms note and
  key 131, extreme keys with coarse +24 (32-bit speed wrap);
- with the host's block structure (direct driver): velocities 90 / 110 / 128 with FL's
  single-precision vol, noise (one and two oscillators), phase randomness, channel
  volume / pan changes (gain ramps), automation of coarse, mix, shape, pan, detune and
  fine mid-note, invert (incl. two cancelling oscillators), AM (incl. a skipped
  oscillator 2), HQ for all six shapes (3 keys each), HQ Default, HQ at 48 kHz, HQ AM, HQ
  rounded saw below 22 Hz, export anti-aliasing, the custom shape (non-HQ, HQ, Default
  patch, without a sample).

Differences:
- Through the channel, velocities whose FL single-precision volume differs from our
  double-precision velocity curve (90, 110, 128; FL's default 78 % channel volume too):
  max 1.2e-7 (vel 128, -141 dB), 2.4e-7 (mixed, -138 dB). Shared levels code
  (src/engine/gen/levels.ts) computes InitLevels.Vol / the channel volume in double.
- Random-dependent sounds (noise, phase randomness) and gain ramps follow the block
  structure; FL's depends on its audio buffer size and ticks, so they match FL exactly
  only for the same blocks (as the parity driver shows).
- Polyphony limit: the channel's 10 ms declick; FL's plugin (FPE_MaxPoly, 0x5e020) starts
  its 441-sample out fade on the oldest voice instead.
- FL on Windows uses Intel IPP (ippsCos_32f_A11) and the MSVC libm: its fade table and
  HQ sine may differ in the last bit from FL on macOS, which we follow.

## Editor

FL's layout at the form coordinates: oscillator tabs, the shape selector grid (column by
column, the invert switch in its last cell, the selected shape orange on a dark disc),
phase offset / detune sliders, coarse wheel with the semitone value, fine, pan and mix
wheels, AM OSC 3 / HQ switches, the phase randomness wheel, the title. Background radial
grey-blue gradient and dark bottom strip sampled from FL's thumbnail; original drawing.
