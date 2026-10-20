# Plucked! (FL: Plucked!)

"An example of a physical modeling synth, where mathematical formula are
used to simulate real sound producing objects" (FL's manual): a
Karplus-Strong plucked string by Didier Dambrin. Plugin database >
Generators > Synth special.

Sources: FL 2026's `Plucked!_x64.dylib` (FPC, arm64 slice; TTestPlug VMT
0x1c5498: Dispatcher 0x5ca10, ProcessParam 0x5d0e0, Gen_Render 0x5ea70,
TriggerVoice 0x5dd20 with the voice init 0x5d530 and decay 0x5e120,
Voice_Release 0x5e030, Voice_Kill 0x5e060, voice render 0x5e230; FPC RTL:
Random 0x18220, genrand_MT19937 0x18070, sgenrand 0x17e50, twist 0x17ed0,
Randomize 0x20230 called once at library init 0xe64c8, Math.Power(Single)
0x144ea0, IntPower 0x9d7e0, IL's list delete 0x13d020), the editor form, the
manual, and renders through FL's real plugin (scratchpad `flfxhost`,
`--block 16 --fixed-time 1700000000`).

The port is FL's code in FL's single precision (FPC rounds every single
operation; no fused multiply-add) **and renders FL's output bit for bit**,
noise included when seeded like FL (keys 0..131, all parameters, Mod X / Mod
Y, Short release, chords and up to 16 overlapping voices with voices ending,
decay automation at odd samples, channel pan changes, 44.1 / 48 / 96 kHz, a
16384-sample channel sample).

## Parameters (form 360 x 156)

| # | Name | Range | Default | FL value text | Engine |
|---|---|---|---|---|---|
| 0 | Decay | 0..256 | 128 | `round(v / 256 x 100)%`, halves up (swept) | per block (Decay changes reach sounding voices) |
| 1 | Color | 0..128 | 64 | `round(v / 128 x 100)%` | at the trigger |
| 2 | Normalize decay | 0..1 | 1 | empty | at the trigger |
| 3 | Short release | 0..1 | 0 | empty | at the note off |
| 4 | Widen (stereo) | 0..1 | 1 | empty | at the trigger |

Factory presets: `Default.fst` (the only plugin preset; the 2 channel presets
"Arp" and "KB tracked" are out of scope) and the plugin database's
`Plucked!.fst` both hold the constructor state (128, 64, 1, 0, 1). State key
`sample`: the channel sample (pool id) whose shape excites the string.

## DSP

**Voice init** (TriggerVoice 0x5dd20 -> 0x5d530), from FL's FinalLevels at the
trigger (pitch bends are not supported, as the manual says):

- `p = rint(FinalLevels.Pitch)` (cents, half to even); below -3600 folded to
  `((p + 100) mod 1200) - 2500`, from 3600 up to `(p mod 1200) + 2400`;
  `ratio = Power(2, f32(1 + f32((p - 2400) x f32(1/1200))))` (FPC's Power:
  IntPower for integral exponents, else `exp(e ln 2)`); delay length
  `N = rint(rate / (ratio x 523.2511306))`: an integer delay, **key 60 = C4
  minus 6.4 cents (period 169.5 samples: 260.18 Hz)**, one octave below FL's
  C5; high notes are audibly out of tune (no fractional delay, as FL).
- Colour `c = clamp(Color + rint(f32(Mod Y x 128)), 0, 128) / 128`.
- The line: a square wave, the first `N/2` samples `+a`, the rest `-a`,
  `a = f32((1 - c) x 0.5)`; or, with a channel sample, its 16384-point shape
  resampled to N samples (fixed point step 2^32 / N, linear) times `1 - c`.
  Widen: a second line for the right channel = line + `c x (2 Random - 1)`
  (N random values), then the first line += `c x (2 Random - 1)` (N more).
- Normalize decay: exponent `1 / ratio`.

**Decay** (0x5e120, at the trigger, when Mod X changes and after a Decay
change): `d = clamp(Decay + rint(f32(Mod X x 256)), 0, 256)`, `g = f32(0.95 +
f32(ln(d + 1) / ln 257) x 0.0499)`, Normalize: `g = Power(g, 1 / ratio)`;
coefficient `f32(g x 0.5)`.

**Render** (0x5e230, each Gen_Render block, newest voice first): output
`x = line[pos]`, `line[pos] = f32(coef x f32(x + x_prev))`, `x_prev = x`
(both lines with Widen); the raw line samples go through FL's pan law
(FinalLevels.Pan / Vol: `levels: 'plugin'`, velocity linear) and
`AddWave_32FM_32FS_Ramp` (stereo source with Widen). A note off does nothing
unless Short release is on: then the target gains become 0, AddWave ramps
there (0.001 per sample at 44.1 kHz: ~16 ms) and the voice ends once both
gains are 0. Otherwise a voice ends at the end of the block in which the
peak of its line samples over a window of more than 256 samples (counted in
whole blocks) fell below 0.004. FL's voice list removes an ended voice by
moving the last one into its place (unordered), and FL's host kills ended
voices in note order: both change the order in which later blocks sum the
voices, which the port reproduces.

**Random** (FPC RTL): MT19937; whenever RandSeed differs from the last seed,
the generator is reseeded from it and RandSeed is inverted (FPC's `not`);
`Random = genrand x 2^-32`; `Randomize` sets RandSeed = `time(NULL)` once
when the library loads, so FL's noise differs per FL session and is one
stream for all Plucked! instances. The port: one stream per engine, seeded
from the clock on first use (`pluckedSeed(epoch)` restarts it: tests use the
test host's 1700000000).

**Channel sample** (FPF_GetChanCustomShape, `FPD_ChanSampleChanged` stores
FL's 16384-point shape pointer): the port builds the shape from the pool
sample like the 3x Osc port (mono mix, linear resampling of the whole
sample). FL's own conversion is not verified (the test host resamples
nearest-neighbour): identical for 16384-sample samples, -58 dB apart for a
5000-sample one.

Polyphony: DefPoly 16 (the channel's MISC max polyphony). FL's plugin also
has its own limit (`FPE_MaxPoly`: TriggerVoice then releases the quietest
voice); Orchard's channel does not send it, so it is not modelled. FL's
`FPD_Flush` releases all voices (a 16 ms fade); the channel's panic here stops
them at once.

## Our implementation

`src/engine/gen/plugins/plucked/core.ts` (voice: init, decay, render in block
parts), `fpcrandom.ts` (FPC's Random), `src/engine/gen/plugins/plucked.ts`
(instance): FL renders all voices per Gen_Render block in its list order, so
the channel's voices only log trigger / per-step levels / release / kill and
`render()` replays the log in FL's block grid (16 samples, restarted at note
events, parameter and level changes, continued across channel blocks), all
voices per block, newest first. FL's pan law and AddWave come from
`boobass/flhost.ts`. 128 preallocated voices with lines long enough for the
lowest folded pitch.

## Fidelity (FL vs ours, test host `--block 16 --fixed-time 1700000000`)

| Case | Result |
|---|---|
| keys 0, 12, 23, 24, 36, 47, 48, 59..61, 72, 84, 95, 96, 108, 119, 120, 131; velocity 1, 64, 127 | bit-exact |
| Decay 0 / 256, Color 0 / 128, Normalize off (high and low notes), Widen off, Short release (aligned and odd note off), Mod X +-, Mod Y, note pan | bit-exact |
| chords, overlapping notes at odd samples (with and without Short release), 2..16 voices with voices ending, Decay automation (aligned and odd samples), channel pan steps | bit-exact |
| 48 / 96 kHz; 16384-sample channel sample (Color 64 and 0) | bit-exact |
| velocity 128, channel volume steps | 1 ulp of FinalLevels.Vol (shared level formula): max 1.2e-7 / 7e-9 |
| channel sample of another length | -58 dB (shape resampling, FL's method unverified) |
| more than 16 voices (channel polyphony 16) | the channel stops the oldest voice with a 10 ms fade; the test host kills one immediately |
| 17 voices, unlimited polyphony | a voice ends up to one 256-sample window later (see below): max 2.6e-3 at -48 dB |

Residuals and why:
- FinalLevels.Vol: the shared channel code computes velocity and channel
  volume gains in double, FL in single precision.
- When a voice has ended before its note off, FL still starts a new block at
  that note off; the channel no longer reports it, so later block boundaries
  (and the 256-sample end windows of other voices) can shift.
- FL's real Gen_Render blocks follow its audio buffer; here 16 samples. Only
  block-rate effects differ (when a voice ends, ramp lengths).

## Editor

FL's panel: amber gradient, a light translucent band around the two knobs,
the Decay and Color captions (OpenSans Light, #374046), dark octagonal knobs
with metal caps and radial spokes (DecayWheel 58,25 and ColorWheel 178,45,
88 x 88), the PLUCKED! title, FL's pad buttons NORM (301,5), GATE (301,32),
WIDEN (301,127) lit amber when on. Colours sampled from FL's plugin database
thumbnail; original drawing. A sample dropped on the panel (or chosen under
the window menu's "Channel sample") becomes the channel sample.
