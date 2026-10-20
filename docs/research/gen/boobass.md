# BooBass (FL: BooBass)

"A monophonic, realistic bass generator with adjustable frequency response
and supports portamento slides" (FL's manual), by David Billen. Plugin
database > Generators > Misc.

Sources: FL 2026's binaries: the FPC wrapper `BooBass_x64.dylib` (TTestPlug:
parameters, editor form, forwards Gen_Render / TriggerVoice / Voice_Release
/ Voice_Kill / ProcessParam / Dispatcher to the engine) and the C++ engine
`BooBass_Eng_x64.dylib` **with symbols** (arm64 addresses below), disassembled
with `otool -tV | c++filt`; FLEngine's pan law (0x33b0) and macOS libm
(`__exp10f`, `__sincosf_stret`, disassembled with lldb); renders through FL's
real plugin (scratchpad `flfxhost`, `--block 16`); lldb reads of the engine
state in the host process.

The port is FL's code in FL's single precision (`Math.fround`, the arm64
fused multiply-adds emulated exactly). **With FL's recordings loaded (see
Data) it renders FL's output bit for bit** in every tested case (keys 0..131,
velocities, all three knobs incl. the 10 % thresholds, automation at odd
samples, legato / overlapping / repeated notes, channel pan / pitch changes,
note offs at odd samples, 22.05 / 44.1 / 48 / 96 kHz, FL's HQ export mode).
**Without them it plays synthesized stand-in recordings** (same engine,
different source tables): a plausible bass, not FL's sound.

## Parameters (form 340 x 150)

| # | Name | Range | Default | FL value text | Engine |
|---|---|---|---|---|---|
| 0 | Bass | 0..65535 | 32767 | `round(v / 65535 x 100)%` (all 65536 values swept) | `SetBass(f32(v x (1/65535)))` |
| 1 | Mid | 0..65535 | 32767 | same | `SetMid` |
| 2 | Treble | 0..65535 | 32767 | same | `SetTreble` |

No factory presets (and no channel presets). The plugin database's `BooBass.fst` holds version 1 and
32767 x 3 (= the defaults). A fresh FL instance: the engine's constructor sets
exactly 0.5 (`DefaultPreset`), then FL's wrapper pushes 32767 to the engine
(renders with and without `--param i=32767` are identical), so a new BooBass
plays the form defaults. State key `dataSample`: the sample pool id of the
imported FL recordings ('' = synthesized).

## Data: FL's recordings

The engine's sound comes from 12 int16 PCM tables in the engine binary's
data segment (symbols `_b0`.. `_e32` and `_xxLength` = byte counts):

| zone | centre (cents above 16.35 Hz) | note | strike (16 kHz pluck) | single cycle |
|---|---|---|---|---|
| 0 | 1100 | B0 | `_b0` 25066 smp | `_b02` 297 |
| 1 | 1600 | E1 | `_e1` 27087 | `_e12` 389 |
| 2 | 2300 | B1 | `_b1` 30322 | `_b12` 259 |
| 3 | 2800 | E2 | `_e2` 30802 | `_e22` 194 |
| 4 | 3500 | B2 | `_b2` 29795 | `_b22` 129 |
| 5 | 4000 | E3 | `_e3` 22456 | `_e32` 97 |

They are FL content and are never shipped with Orchard. The plugin window
menu (FL's panel has no extra control) offers **Load FL Studio data...**: the
user picks `FL Studio.app/Contents/Resources/FL/Plugins/Fruity/Generators/
BooBass/BooBass_Eng_x64.dylib` from their own install;
`src/ui/plugins/gen/boobass/macho.ts` parses it as untrusted input (fat /
thin header, arm64 preferred, x86_64 accepted: both slices hold identical
tables; every load command, segment, symbol, offset and table length bounds-
checked; anything unexpected fails with a hint; Windows DLLs are not
supported), `packFlData` packs the tables into one mono pool sample (a
header with magic, version and the 12 lengths, then the values, all on the
16-bit grid so the pool's dithered 24-bit storage and float copies decode
exactly), stored like Convolver's impulses (pool + user sample storage, its
own exact 16-bit WAV; a watcher re-reads the stored bytes when the generic
loader resampled them) and referenced from the state (`dataSample`), so the
live engine and WAV export get it through `env.sample`. Further menu items:
**Use FL Studio data from this project** (when the pool already holds it) and
**Use synthesized sound**. Reset BooBass clears the reference (the pool sample
stays and can be reused).

Synthesized stand-ins (`src/engine/gen/plugins/boobass/synth.ts`): per zone a
stiff plucked string (harmonic series with a pluck-position comb, higher
partials decaying faster, a short noise transient, level riding to mimic
FL's evenly levelled recordings) and one cycle of its sustained tone, at the
same 16 kHz rate, zone pitches and engine gains. Measured against FL's
recordings through the same engine: level within -2.2..+1.9 dB over keys
36..84 in the first 0.5 s (-3.3..+1.7 dB at 1 s); waveforms uncorrelated.

Table building (FL's `WaveTable::Create` 0x262c, once per process, kept in
static buffers): `readfile` 0x254c converts int16 x 2^-15 into a buffer with
4 copies of the first value before and of the last after the data. Strikes
are scaled by `0.5 x exp10f(-0.05 c)` (c = 0.666, -0.333, -0.75, -1.5, -2,
-3), **from the start of the buffer**, so the last 4 data values keep the
recording's level (FL's bug, reproduced). The single cycles are resampled to
16384 points by `ConvertSnip` 0x246c (circular 4-point cubic, FL's operation
order) and scaled by `-0.5 x exp10f(-0.05 c)` (c = 4, 3.5, 3, 3.25, 3.5, 3),
with 4 wrapped values on either side.

## DSP

One string per plugin (`WaveTable` at BooBassPlug+0x200): **monophonic**.
FL's `TriggerVoice` (0x15f8) kills the sounding voice (host Voice_Kill) and
re-strikes the same string; filters and slew limiter carry on.
`Voice_Release` (0x1724) and `Voice_Kill` (0x1744) act only on the current
voice (both call `Mute`).

Pitch: `p = trunc(f32(FinalLevels.Pitch + 2400))` cents, clamped to 9600;
the wavetable step is `f32(exp2(p/1200) x f32(267955.84375/rate))` points
of 16384, i.e. **16.3547 Hz x 2^(p/1200): key 60 plays 65.42 Hz, three
octaves below FL's C5** (+0.33 cent from FL's equal temperament). The zone is
the nearest centre (ties to the lower); the strike plays at
`f32(16000/rate) x 2^((p - centre)/1200)`. `AlterFrq` (0x2c98) recomputes
both steps at every Gen_Render block from the current pitch (slides and
bends work; the zone stays), with FL's two different roundings
(`SetFrq` 0x2a3c vs `AlterFrq`).

Strike (0x2eac; the velocity argument is unused): phase 0, strike position
0, EQ gains jump to their targets, envelope `p_env` restarted from level 0
with stage lengths {0, 4 periods (FL's 30000-entry period table, built per
rate), 16 x strike length x rate/44100, 0.01818 x rate} and levels
{1, 0.9375, 0}: stage 1 dips 1 -> 0.9375 over 4 periods, stage 2 decays to 0
(about 9 s), then a 18.2 ms release follows on its own; `Mute` (note off)
starts that release from the current level. Below key 36 (p < 0) FL reads
the period table out of bounds: words of its own data segment (FL 2026 arm64
layout: B2 strike / B0 / B1 / B2 cycle PCM data and lengths, the sample rate,
PcmFile pointers, statics); integer keys 33..35 read 0, key 32 reads 1, lower
keys read PCM data (huge lengths: those notes do not decay). The port
reproduces that layout from the loaded tables.

`NextSample` (0x2f8c) per sample: wavetable `y0 + frac(new) x (y1 - y0)`
with y0 = table[int(old phase)], y1 = table[int(new phase)] (FL's two-index
interpolation); while the strike runs, `strike + (wave - strike) x pos/len`
(linear crossfade over the whole strike); gain = FL's 49-entry dB table
(10^((i-48)/20), 0 for the lowest two) interpolated at the envelope level;
then two cascaded 3-band splits (one-pole low passes at `0.025 x 44100/rate`
and `0.155 x 44100/rate`) weighted by the Bass, Mid and Treble gains, the
second low band soft-saturated `c + (sin(c pi/2) - c) x drive` (c clamped to
+-1), and a slew limiter on 3x the result (`+-44100/rate x (0.0328 +
crossfade)` per sample, 1.0328 after the strike). Gains: Bass
`exp10f(0.6 x - 0.6)` with drive `exp10f(1.2 x - 1.2)`, Mid `exp10f(0.5 x -
0.5)`, Treble `exp10f(0.6 x - 0.45)`; each 0 below x = 0.1 (10 %).

`ProcMono` (0x35f0) ramps the EQ gains per block: step `(target - current)
/ n x 16`, applied after every sample where the remaining count is a
multiple of 16 (a 16-sample block: after its first sample; shorter blocks:
not at all). `ProcMonoHQ` (0x37e0, FL's HQ mode, `FPD_ProcessMode` with HQ
bits: FL's export with "HQ for all plugins") uses `NextOverSample` (0x3314):
the wavetable averaged over one step (6-point cubic `Hermite` 0x2254 for the
fractional ends) and the strike by `Hermite`, gains stepped per sample.

`BooBassPlug::Gen_Render` (0x13b4) per block: AlterFrq, panning smoothed
`pan = (pan + FinalLevels.Pan) / 2`, ProcMono, four bilinear one-pole low
passes (0x1570: `y = b (x + x1) - a y1`, a = s0 - 1, b = s0 / 2, s0 =
`0.648 k - 0.288 x 0.18 k^2`, k = 44100/rate: about 5.6 kHz each), FL's pan
law on (pan, FinalLevels.Vol) and `AddWave_32FM_32FS_Ramp` (gains ramp from
the last ones at most 0.001 x 44100/rate per sample; TriggerVoice sets the
last gains to the new note's, so a note starts without a ramp). The voice
ends at the end of the block in which the envelope reached its last stage.
`levels: 'plugin'`; velocity only through FinalLevels.Vol (linear, FL's curve).

Sample rate (Dispatcher 0x1220, `FPD_SetSampleRate`): `ReCreate` rebuilds the
tables and rate constants but **clears the Bass drive** until the next Bass
change; FL's state load (or `BooBass.fst` from the plugin database) applies
the parameters after the rate, so the port always keeps the drive (a fresh
test-host instance at 48 kHz has none until `--param 0=...`).

libm: FL's engine calls macOS `exp10f`, which is not correctly rounded
(about 0.6 % of inputs differ by an ulp from `Math.pow` rounded, e.g. the B0
strike level), and FL's pan law calls `__sincosf_stret` (about 1.3 %
differ from rounded `Math.sin/cos`). `boobass/libm.ts` emulates both exactly
(checked against the real functions on all FL pan values and 160 000 inputs);
`exp2` / `sin` agree with `Math.pow` / `Math.sin` on every value BooBass
rounds to float.

## Our implementation

- `src/engine/gen/plugins/boobass/core.ts`: FL's WaveTable / p_env /
  Gen_Render in single precision; `tables.ts` (table building, pool pack),
  `synth.ts` (stand-ins), `libm.ts`, `f32.ts` (fused multiply-add),
  `flhost.ts` (FL's ComputeLRVol and AddWave, shared with Plucked!).
- `src/engine/gen/plugins/boobass.ts`: FL renders a voice in Gen_Render
  blocks and a new note cuts the old voice at its first sample, which the
  channel may already have rendered past. So the voices only log trigger /
  per-step levels / release / kill, and `render()` replays the log once per
  channel block in FL's block grid: blocks of 16 samples (the channel's
  control step) restarted at every note event, parameter change and level
  change (as the test host splits blocks at events), continued across
  channel blocks (FL's per-block ramps and steps computed for the whole
  block).
- Editor `src/ui/plugins/gen/boobass/` (`index.tsx`, `fldata.ts`, `macho.ts`).

## Fidelity (FL vs ours, test host `--block 16`)

| Case | Result |
|---|---|
| FL data: keys 0, 6, 12, 24, 30..36, 40, 45, 48..50, 55, 56, 60..62, 67, 68, 72..74, 84, 96, 108, 120, 127, 131 | bit-exact |
| FL data: velocity 1, 30, 64, 100, 127; Bass / Mid / Treble 0, 6553, 6554, 20000, 65535; all max / min; 12 s note (self ending) | bit-exact |
| FL data: legato (aligned and odd samples), abutting, repeated, parameter jumps (aligned / odd), channel pan and pitch steps (odd samples), note pan, note offs at odd samples | bit-exact |
| FL data: 22.05, 48, 96 kHz (parameters applied after the rate, as FL's state load), HQ export (single and legato, odd samples) | bit-exact |
| FL data: velocity 128, channel volume steps | 1 ulp of FinalLevels.Vol (shared level formula, see below): max 6e-8 / 4e-9 |
| Synthesized tables vs FL's recordings | levels -2.2..+1.9 dB (0..0.5 s), waveform uncorrelated (residual about 0 dB) |

Residual differences and why:
- FinalLevels.Vol: the shared channel code computes velocity and channel
  volume gains in double; FL in single precision (75 of 129 velocities and
  most channel volumes differ by an ulp).
- Block structure: FL's real Gen_Render blocks follow its audio buffer and
  ticks; here they are 16 samples. Only block-rate quantities differ (EQ /
  level ramps after changes, panning smoothing speed, the voice's last
  partial block: up to 15 samples of filter tail at about -100 dB).
- After a voice has been replaced, FL still starts a new block at its note
  off; the channel no longer reports that note off, so later block
  boundaries can differ (same effects as above).
- The test host's pan law uses `cosf/sinf` instead of FL's
  `__sincosf_stret` (an ulp apart for ~1.4 % of pans); the port follows FL.

## Editor

FL's panel: slate background (#31373b), a light grey (#c0c0c0) curved body
with a blue-grey rim, the BOOBASS logo (outlined BOO, solid BASS) top right,
three black knobs with metal caps, red pointers and tick dots (form
positions: Bass 50,45; Mid 120,66; Treble 190,75; 56 x 56), dark captions.
Colours sampled from FL's plugin database thumbnail; original drawing.

## Open questions

- FL's audio block size in a real session (affects ramp lengths only).
- The PcmFile pointer words below key 32 with fine pitch depend on FL's load
  address (unslid offsets used).
