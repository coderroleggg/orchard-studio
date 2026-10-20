# Granulizer (FL: Fruity Granulizer)

FL's granular sampler (Plugin database > Generators > Sampler). It plays the channel's sample as overlapping
grains (each a fade-in of the ATTACK time, the HOLD time and a fade-out of the ATTACK time), starting a grain
every GR. SPACING and moving through the wave by WAVE SPACING per grain: both at 100 % is the original
speed; WAVE SPACING below / above stretches / compresses time, below zero plays the grains backwards (not their
content), 0 % (or the HOLD button) freezes. EFFECTS: PAN alternates odd / even grains between the sides, DEPTH /
SPEED are an LFO on the wave position, RAND randomises it. TIME: START, LOOP, HOLD, TEMPO LOCKED and KEY TO (Pitch,
Percent, Step, Transient). TRANSIENTS: HOLD and the source (OFF, USE REGIONS, DETECT) align grains to transients.
Category Sampler, `notes: 'voices'`, INS tab (`ins: true`), `levels: 'plugin'`, DefPoly 0. Credits in FL: Didier
Dambrin.

Sources: FL 2026's binary (`Plugins/Fruity/Generators/Fruity Granulizer/Fruity Granulizer_x64.dylib`, arm64 slice,
Free Pascal, class `TTestPlug`, VMT 0x225c90; no symbols; the DSP library calls resolve to
`Shared/dsp_ippv2_x64.dylib`, which has symbols), its form (`.flref/gen/forms/Fruity Granulizer.txt`), the plugin
database state, the eight factory presets, the editor thumbnail (colours), FL's online manual and renders of FL's
real plugin through the test host (`flfxhost render "Fruity Granulizer" --chan-sample FILE.wav ...`, with `--state`
blobs written by hand and `--process-mode N` = interpolation points << 8 for the resampler's quality), plus lldb
sessions on the host (breakpoints at plugin offsets, structure dumps). No FL content is shipped: the user loads audio.

| What | Address (arm64) |
|---|---|
| Dispatcher / SaveRestoreState / GetName / ProcessEvent / ProcessParam | 0x617b0 / 0x61c80 / 0x63580 / 0x623e0 / 0x628a0 |
| Gen_Render / TriggerVoice / Voice_Release / Voice_Kill / Voice_Render / NewTick | 0x66550 / 0x63b20 / 0x63fc0 / 0x64030 / 0x65e40 -> 0x64b00 / 0x66750 |
| recalculation of the derived fields (params 0 1 2 3 8 11) | 0x62580 (ms 0x62460, spacing 0x624e0, ms -> samples 0x6cfb0) |
| AddGrain / value texts / key names | 0x645c0 / 0x62c40 / 0x63580 |
| channel sample load, regions, DETECT | 0x66230, 0x69040, 0x65fc0; detector class created at 0x9e110 (0x9e450, 0x9e680, 0x9f440) |
| region list (AddRegion, sort) | 0x73750, 0x73510 |
| grain list (unordered delete) | 0x165af0 add, 0x165890 delete |
| voice list (TList, unordered delete: Voice_Kill moves the last voice into the hole) | 0x165650 index of, 0x1655c0 delete (flag +0x18 = keep order, off) |
| libm calls: `exp` / `cos` / `sin` (libsystem_m stubs 0x9720 / 0x9780 / 0x9760) and `ippsSin_64f` (= Accelerate `vvsin`) | ported in `granulizer/libm.ts` (below) |
| TResampler (read, config, speed, limits, tap gathering) | 0x1966d0, 0x195df0, 0x195ba0, 0x194fd0, 0x195fe0 / 0x196230 / 0x196480; kernels table 0x290650 (linear 0x192b20) |
| channel sampler processing (levels, release) | 0x1e8710 (render voice), 0x1eabe0 (fade table), pan law 0x50e4, kernels 0x5a34 / 0x5d14 |
| Random (MT19937), Randomize | 0x18b70, 0x18c80 / 0x21230 |

## Parameters and state

FL's parameter list is the 12 values (index = form Tag) followed by the INS block (the channel's INS tab here, so
`def.params` has the first 12). Control units, ranges, defaults and value texts as in FL (the texts were swept over
every value and are pinned by fingerprints in the tests):

| # | key | FL name | range | default | text |
|---|---|---|---|---|---|
| 0 | attack | Grain attack time | 50..500 | 204 | `ms(v)` ms |
| 1 | hold | Grain hold time | 0..500 | 50 | `ms(v)` ms |
| 2 | spacing | Grain spacing | 125..1000 | 611 | `F(v) / 256` as % |
| 3 | wave | Wave spacing | -1000..1000 | 611 | `F(v) / 256` as % (signed) |
| 4 | depth | Effect depth | 0..384 | 0 | v / 384 as % |
| 5 | speed | Effect speed | 4..200 | 180 | v / 200 as % |
| 6 | random | Randomness | 0..256 | 0 | v / 256 as % |
| 7 | stereo | Stereo separation | 0..64 | 0 | v / 64 as % |
| 8 | loop | Repeat sound | 0..1 | 0 | Off / On |
| 9 | holdSound | Hold sound | 0..1 | 0 | Off / On |
| 10 | start | Sample start | 0..4096 | 0 | v / 4096 as % |
| 11 | transHold | Transient hold time | 0..500 | 228 | `ms(v)` ms |

Percent texts are `v x 100 / max` rounded half away from zero (checked on all 4097 values of `start`).
`ms(v)` (0x62460) = round_even(f32(f32(exp(f32(v x 0.002) x ln 51) - 1) x 10)) (5 ms at 50, 40 ms at 204, 500 ms at
500) and `F(v)` (0x624e0) = sign x round_even(f32(exp(f32(|v| x 0.001) x ln 11) - 1) x 76.8) (256 at 611 = 100 %,
768 at 1000 = 300 %); typed values use the inverses (0x63490 / 0x634f0).

Saved state (SaveRestoreState 0x61c80), little endian: `i32 version` (7), the 12 values, `i32` TRANSIENTS source
(0 OFF, 1 USE REGIONS, 2 DETECT; version >= 4), `i32` KEY TO (0 Pitch, 1 Percent, 2 Step, 3 Transient; >= 5), `i32`
tempo-lock mode (>= 7; 0 off, 1 on, the constructor's 2 = off) and the 364-byte INS block. Orchard keeps the 12 values
under FL's parameter keys, `trans`, `trigger`, `tempoLocked` and the sample reference (`sample` = pool id, `file`,
`regions`, `detected`, `detectedFor`, `view`) as JSON. A new instance gets the plugin database state (version 5:
204, 50, 611, 611, 0, 180, 0, 0, 0, 0, 0, 228, source 0, KEY TO 0). Older presets lack the trailing fields: the
loader sets the sample start 0, the transient hold 248 (before the read; the test host's stream zero-fills what is
missing, FL's own stream leaves it: the presets use 248 as the code says, not measured), the source and KEY TO 0.
Preset loads keep the channel's sample (`viewState`).

Factory presets (8, .fst versions 1..5): Backwards (188, 0, wave -613), Default (200), Drumloops (190, 118, source
DETECT), Rearranging drumloops (50, 172, stereo 3, LOOP, hold 242, DETECT, KEY TO Step), Stutter (wave 107, stereo
26), Time stretch - twice faster (spacing 413), Time stretch - twice slower (wave 410), Weird language (random 256).

## The voice (TriggerVoice 0x63b20, Voice_Render 0x64b00)

Derived fields (recalculation 0x62580, all float32; `rate` = the host rate, `1/rate` as a double):
`att = f32(ms(p0) x rate x f32(0.001))`, `hold`, `tHold` likewise; `sum = att + hold`; grain spacing in samples
`max(5, f32(f32(F(p2) x sum) / 256))`; wave step per grain `f32(f32(sum x F(p3)) x (sampleRate x 1/rate) / 256)`;
`inv = 1 / sum`, `stepRatio = sum / max(step, 1)`; DEPTH amount `p4 / 256`, LFO phase step `pi / (204 - p5)`; the
sample start `trunc(p10 x last / 4096)` (`last` = frames - 1). With the channel's fit time set and TEMPO LOCKED the
step is `spacing x length / fit length` and the sound loops (needs FPD_SetFitTime: not available here).

TriggerVoice: nothing without a sample. The voice's source position (float32) is the sample start; in the KEY TO
modes other than Pitch the key's pitch is cancelled (pitch offset -(key - 60) x 100 cents) and the start moves by
k = max(key - 60, 0): Percent `last x k / 24`, Step `k x 0.25` beats (`x 60 x sampleRate / tempo`, or `last x beats
/ fit` with a fit time), Transient `transients[k mod count]`; the position becomes `round_even(position + offset)
mod (last + 1)`.

Voice_Render keeps the voice's time counter (+= block length) and schedules grains while the next grain time is before
the end of the block: the grain starts at `round_even(position)`; with RAND > 0 (and the HOLD button off) a grain is
moved when `255 - Random(256) < rand` to `position + Random(length)` (wrapped by the length) and then no transient
logic runs; otherwise, with transients and a positive step, a grain whose attack end (`position + att x 2^(cents /
1200)`) reaches the next transient is aligned to it (new transient: hold = the transient hold, or `max(0, d - att)` when
the grain would end first, d = distance x `stepRatio`; the same transient again: the remaining distance is spread over
the grains left, `hold = max(0, hold + (d - k x step) x stepRatio / k)`, k = max(1, round(d / step))) and the spacing
factor becomes `(att + hold) x inv`. AddGrain (0x645c0): grain position counter -att, hold end `hold`, end `att + hold`,
start delay in the block, gain = slope = 1 / att (so the fade-in runs 1/att .. 1 and the fade-out 1 .. 1/att: the
windows of neighbouring grains sum to 1 + 1/att), pan gains `ComputeLRVol(stereo / 64, 1.42)` (circular law,
float32), swapped for odd grains (the voice's grain counter, incremented before use). The first grain of a voice at
position 0 skips its fade-in (hold end and end shift by att, gain 1, slope 0). Afterwards the next grain time moves by
`round_even(spacing x factor)` and, unless HOLD, the position by `f19c x factor` (DEPTH first subtracts
`round_even(|sin(phase)| x step x depth)`, the phase advances by the LFO step); past the last frame the position wraps
by the length (without LOOP the voice stops scheduling and ends when its last grain has finished) and negative
positions wrap up.

The mixing phase takes each grain in list order (the list deletes unordered: the last grain takes a deleted grain's
index and is mixed next), reads its frames from a TResampler (below) into a scratch buffer, and adds them to the
voice's output in segments of the fade-in, hold and fade-out stages with FL's NEON kernels: constant gains `g x pan`, or
the ramp kernel (gains stepping by `slope x pan` per frame, pairs of frames by two steps in groups of 8, the tail frames
stepping left by the right step and vice versa), the gain `g += segment x slope` accumulating in float32; stage changes
set the slope (`-1 / (end - holdEnd)` at the hold end, 0 at 0). A grain ends at its end or when its non-looping source
has run out; a voice ends when it has stopped scheduling and has no grain.

Gen_Render (0x66550) renders the plugin's voices in the order of its own voice list (TriggerVoice appends; a finished
voice leaves through Voice_Kill, whose TList.Delete is unordered: the last voice takes the deleted one's place, so
three voices A B C become C B after A ends). The order matters where voices share state: the random numbers (one
generator for all voices) and the order of the float32 sum of their outputs. The test renderer (`granulizer-util.ts`)
keeps that order; the channel renders its voices in its own order, so with RAND > 0 and several voices, the draws of
overlapping voices can fall to the other voice after one has ended (a different random position, statistically the
same sound).

TResampler (0x1966d0, shared with Fruity Slicer): one per grain on the whole sample, the grain's position (the start
frame) and speed `exp(cents x ln 2 / 1200) x sampleRate / hostRate` (1 when both are neutral; the `exp` is Apple's libm's) with cents =
FinalLevels.Pitch + the key offset, fixed at the grain's start. A block is read in FL's way: the fast path takes all remaining
frames at positions `pos + i x speed` computed with a fused multiply-add (`ippsVectorSlope_64f`) when `round(pos) >=
taps + 2` and the block stays below `length - taps - 3`; else the slow path walks the frames accumulating `pos +=
speed`, with direct taps inside the kernel's safe zone [taps - 1, length - taps) and gathered ones outside (the first /
last frame repeated, or wrapped around the loop once the reader has looped), and tests the fast condition again after a
gathered frame. Copy mode (speed exactly 1 at an integral position) copies. The kernel follows the points
FPD_ProcessMode carries (Orchard: the project's resampling setting as FL's half widths; setter 0x195120 picks kernel and
taps, the function comes from the table at 0x290650 by kernel, channels and sample format): up to 2 points the linear
kernel (taps 1; double `x0 (1 - f) + x1 f` rounded to float32, 0x192b20); 3 the 6-point polynomial (taps 3, "6-point
Hermite", 0x1935b0: frames k - 2 .. k + 3 as even / odd sums of the symmetric pairs, five float32 Horner steps whose
products with `f - 0.5` (a double) are rounded to float32, 18 float coefficients at 0x2905c8, ported in `reader.ts`);
from 4 the windowed sinc with that many points per side, 12 = 24-point sinc, 32, 64, 128, 256 (ported by Fruity Slicer,
`slicer/interp.ts`). A non-looping reader reports the frames before the end of the sample, the rest of the block is not
mixed.

Apple's libm and Accelerate (`granulizer/libm.ts`): the sinc kernel (a lane-by-lane port of FL's NEON code, shared with
Fruity Slicer) starts from doubles that FL's code gets from `libsystem_m` (`cos` of pi / taps and of pi / speed, the
grain speed's `exp`, the LFO's `sin`) and from `ippsSin_64f_A26 / A50 / A53`, which only call Accelerate's `vvsin`
(libvMisc VVSIN: a vectorised polynomial, 63 % of its results differ from the correctly rounded sine by an ulp). JS's
Math.exp / cos / sin differ from Apple's in the last bit for 4 - 10 % of arguments. Usually float32 hides that, but
the sine recurrence computes `sin((f - 1) B)` as `2 cos(B) sin(f B) - sin(f B + B)`: for a source position just below an
integer (`f` = 1 - 1e-14, which is what accumulating a rational speed such as 147 / 40 gives every 40 frames) the
difference of two nearly equal doubles is dominated by those last bits, the tap next to the position gets a weight
that is off by up to 1 %, and a sample is wrong by 1e-5. So the port: `exp` (128-entry table of 2^(j / 128) as high /
low pairs, a short polynomial, the exponent added to the bits; 0x197e3a380), `cos` / `sin` (round(x 2 / pi), a
three-part pi / 2 without fused operations, a sine or cosine polynomial on the remainder, `n mod 4` choosing and
signing; 0x197e39968 / 0x197e39ad4) and `vvsin` (k = round(|x| / pi) by the magic-number add, a fused three-part
|x| - k pi, the sign flipped for odd k, an odd polynomial of degree 15 by Horner steps, all fused; 0x1995ba474), each
transcribed from the arm64 code with an exact fused multiply-add (Boldo-Melquiond round-to-odd emulation); they cover
the ranges the plugin uses (|x| < 700 / 524288 / 2^23) and defer to Math outside, where Apple's code takes other
paths (Payne-Hanek, denormals). Checked against the system libm and Accelerate on 300 000 - 376 000 arguments each
(random, pitch constants, multiples of pi / 2): 0 differences. The reader sets `SincKernel.cos = appleCos` and, because
`vvsin` costs ten fused operations a sine, `SincKernel.sinNear = vvsin` for the frames with `f > 0.9999` only (elsewhere
the double's last bit cannot reach the float32 weights except with a chance of about 1e-9 per frame). Without
the port these scenarios differ from FL by up to 1.5e-5 (pinned tests: key +24 with sinc 12 in a 48 kHz host, a
48 kHz sample in a 44.1 kHz host, ...).

Output stage (the channel sampler processing compiled into the plugin, same code as Fruity Slicer's): the release
declick (441 samples, `(cos((k + 1) pi / 442) + 1) / 2` with FL's DSP library cosine, i.e. Accelerate's `vvcosf`: 86 of
the 441 float32 gains differ by an ulp from a correctly rounded cosine, so the table is stored, `release.ts`) then the
voice levels: float32 pan law of FinalLevels x volume, gains ramped from the previous block's at most 0.001 per sample
(`levels: 'plugin'`); the INS filter / envelopes / LFOs are the channel's. The random numbers are FPC's MT19937
(`Random(n) = n x genrand >> 32`) seeded by Randomize = `time(NULL)` when FL loads the library, shared by all
instances; tests seed it with the clock the host was given (`--fixed-time`).

Transients: USE REGIONS takes the sample file's regions (Orchard: the WAV's cue points, as Fruity Slicer's), DETECT
runs FL's BeatSlicer detector (the one of Fruity Slicer's auto-slicing, `slicer/slicing.ts`) with both bands' threshold
factors set to 2.0 (Slicer wheel 158.49625); the list is sorted. The test host implements no regions, so USE REGIONS is
not host-verified; DETECT matched on five signals (the positions are pinned). KEY TO Transient plays `transients[k mod
count]`; the piano roll key names (GetName 0x63580) are "<n>%" (Percent, C5..B6), "<k + 1>" with " - Beat <k / 4 + 1>" on
every fourth key (Step) and "Slice #<k + 1>" (Transient).

## Our implementation

- `src/model/gen/plugins/granulizer.ts` (definition, presets, key names), `granulizer/convert.ts` (FL's
  conversions and texts), `granulizer/state.ts` (typed state, defaults), `granulizer/detect.ts` (DETECT).
- `src/engine/gen/plugins/granulizer.ts` (instance: sample lookup, derived fields, transients, voices),
  `granulizer/voice.ts` (grain engine and output stage), `granulizer/reader.ts` (TResampler), `granulizer/random.ts`,
  `granulizer/release.ts` (declick table), `granulizer/libm.ts` (Apple's exp / cos / sin / vvsin, exact fused multiply-add).
- Shared: `slicer/interp.ts` (the sinc kernel) got the hooks `cos`, `sin`, `sinNear` (JS Math by default: Fruity Slicer unchanged).
- `src/ui/plugins/gen/granulizer/` (editor and `ops.ts`: loading, regions, detection stored in the state).
- Tests: `tests/gen/granulizer.test.ts` (including pinned libm results), `granulizer-golden.ts` (58 host renders as fingerprints),
  `granulizer-signals.ts` (code-generated test signals), `granulizer-util.ts` (host-like render).

## Fidelity (FL 2026 via the test host, 44.1 kHz, the host's block grid: 512 samples split at notes and song ticks)

58 renders pinned in the tests are bit-identical to FL's output (not one differing sample): the default state on DC
(window shapes), a ramp (positions), pulses and sweeps; WAVE SPACING 50 / 200 / backwards, grain spacing 413 and 1000
with other attack / hold, stereo 26 and 64, DEPTH with SPEED, RAND 128 / 256 (with the host's clock), LOOP (4 s),
HOLD with a start, the sample start, pitches (linear at +400 / -1200 / -4200 cents, sinc 12 / 32 points at +400,
+1200, +2400 and +3000, a looped sinc at -2400, linear loops at +700 / -2000, notes to the end of the sample, the 6-point kernel
at +400 / +700 with a loop, to the end, with DETECT and RAND), host rates 48 /
96 kHz, 22.05 kHz and 48 kHz samples (the sinc cases where the libm port matters), KEY TO Percent with start, Step at
100 / 200 BPM, DETECT with Transient keys (24 notes) and with the transient hold at pitch 0 / +400 cents / backwards /
WAVE 50 % / LOOP / RAND, the channel's pitch and pan ramping while notes play (+700 / -1500 cents with the 24-point sinc,
pan -1 .. 1 with the grain stereo, both on two notes, with RAND, at the host's control rates 64 and 16: grain pitch follows
FinalLevels at each grain start, the voice's pan gains ramp over the block), and the notes' releases (the declick table
makes them exact). The eight factory presets,
loaded by the host from FL's .fst files, play identically to our preset values on two signals (16 renders of four
notes each, including Drumloops' DETECT and Rearranging drumloops' Step + DETECT + LOOP).

Checked while developing, beyond the pinned renders: 1240 random scenarios (34 seeds of 20 - 40: every control at
random, five signals, sample rates 22.05 / 44.1 / 48 kHz, host rates 44.1 / 48 / 96 kHz, tempos 100 / 130 / 170,
interpolation linear, the 6-point kernel and 12 / 32 / 64 / 128 / 256-point sinc, the four KEY TO modes, DETECT, LOOP, HOLD, RAND with the
host's clock, one to three overlapping notes) are bit-identical to FL's, except one: a 32-point sinc at +1500 cents
in a 96 kHz host with three notes differs by one float32 ulp (1.2e-7) at one frame (a sine of the kernel setup within two
double ulps of a float32 rounding boundary; using Accelerate's sine on every frame instead of near the integer
positions fixes it but doubles the cost of a sinc frame: vvsin takes about 200 ns in JS), and 81 note pans from -1 to 1 (the voice level law).

CPU (Orchard's default 24-point sinc): about 4 % of real time for one pitched voice, 26 % for eight, 1 % for a copy-mode
voice (the grain count is small: at most about 2 / spacing grains overlap).

## Not done / open

- TEMPO LOCKED needs FL's per-channel fit time (FPD_SetFitTime, the channel's "fit to steps"), which the channels
  here do not have: the box is stored and has no effect (the Step mode likewise uses the project tempo only).
- USE REGIONS reads WAV cue points; FL's loader may know more region sources (REX / Acid beats, `smpl` loops: a loop
  region would also set the resampler's loop range). Not testable on the host.
- Polyphony: FL's plugin releases the oldest unreleased voice (441-sample declick) when FPE_MaxPoly is exceeded; the channel
  fades the oldest voice over 10 ms instead (framework behaviour, ~equal length).
- The tempo reaches Step mode through the block context of the first voice of a block (`triggerVoice(params, ctx)`).
- RAND with several voices: FL's Gen_Render keeps its voices in an unordered list (a finished voice is replaced by the last
  one), the channel here renders them in its own order, so after a voice has ended the random draws of the others can fall
  to a different voice (a different random position, the same distribution). The test renderer follows FL's list.
- Block length: grain scheduling does not depend on it, but the order of the float32 sum of overlapping grains does (FL
  deletes a finished grain at the end of its block pass) and so does FL's ramp kernel, whose last 1 - 7 frames of a fade
  segment step the left gain by the right step and vice versa. The channel's 16-sample control steps therefore differ from
  renders in the host's 512-sample blocks by about -116 dB, and by about -65 dB with the EFFECTS PAN above 0 (a fade cut into
  16-frame segments has no such tail frames); FL's own output depends on its audio buffer length the same way.
- Sinc resampling at source positions that fall on integers (a rational speed such as a 44.1 kHz sample in a 48 kHz
  project, +2 octaves) is numerically fragile in FL's code: which frames take the fused or the accumulated position path
  differs with the block length and moves those samples by up to 4e-4 (-97 dB residual between 16 and 512-sample blocks).
- The editor is an original drawing at FL's form coordinates (fonts and the logo are not FL's).
