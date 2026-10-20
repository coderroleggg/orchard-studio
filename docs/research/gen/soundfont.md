# SoundFont Player (FL: Soundfont Player, Plugin database > Generators > Misc)

FL 2026.1.6 (`Soundfont Player_x64.dylib`, universal; the arm64 slice, Free Pascal, unit `Sobanth` by Benjamin "BeRo"
Rosseaux: "Sobanth - Copyright (C) 2008-2021"). Classes TTestPlug (the FL plugin), TSynth, TVoice, TChannel, TReverb,
TChorus, TAttachedSoundFont, TPresetLayer...; editor SynthPanel 370 x 385. Everything below was read from the arm64 code and
measured with the test host (`flfxhost render "Soundfont Player" --load-file FILE.sf2 --notes ...`, `--state FILE` for the
options and the selected preset; FPD_LoadFile is handled); scratch work (lifted code, the SF2 writer / host drivers, the
scenario runners) is in `.flref/samplers/soundfont/` and is not shipped.

## Files

| Part | Files |
|---|---|
| Definition, state, 13 parameters | `src/model/gen/plugins/soundfont.ts`, `soundfont/state.ts` (state, parameters, preset list, patch / bank mapping, `currentPreset`) |
| SF2 reader (defensive), importer | `soundfont/sf2.ts` (RIFF / pdta parser, base64, pool WAV), `soundfont/import.ts` (`importSf2`), `soundfont/gens.ts` |
| Engine (events instrument) | `src/engine/gen/plugins/soundfont.ts` (instance: state -> synth, FL's parameters 5..12, sends), `soundfont/synth.ts` (voices, events, render segments, exclusive classes, links, voice end tails), `voice.ts` (one zone: tuning, envelopes, LFOs, resampling, loops, gains), `zone.ts` (preset layers), `mod.ts` (modulators), `env.ts`, `filter.ts`, `interp.ts` (banded sinc kernels), `fx.ts` (chorus, reverb), `num.ts` (FL's single precision clamp) |
| Editor (SynthPanel 370 x 385, FL's form coordinates, kit controls) | `src/ui/plugins/gen/soundfont/index.tsx`, `soundfont/ops.ts` (written by the Granulizer agent against this state model), `tests/gen/soundfont-editor.test.ts` |
| Tests | `tests/gen/soundfont.test.ts`, `soundfont-util.ts` (SF2 writer, sample generators, engine render helpers), `soundfont-scenarios.ts` (the fonts / notes pinned to FL), `soundfont-golden.ts` (FL's renders of them) |

No shared framework file was changed. The engine imports nothing from other plugins (the Apple libm port of the Granulizer was
tried for `exp` / `sin` / `cos` and made no measurable difference, so it is not used).

## Plugin facts (host `info`, binary)

- 13 parameters: 0 (1..256, unnamed, default 0: the patch number, FL's state stores 1) and 1 (0..127: the bank), 2 Reverb send
  level (multiplier) 0..256 def 128, 3 Chorus send level (multiplier) 0..256 def 128, 4 Modulation 0..127 (MIDI CC1),
  5 Env 2 attack time -1..5940 (-1 = "Disabled"), 6 Env 2 decay time, 7 Env 2 sustain level -1..127, 8 Env 2 release time,
  9 LFO 2 predelay -1..5900, 10 LFO 2 amount -128..127 (-128 = "Disabled"), 11 LFO 2 speed -1..127, 12 Initial filter cutoff -1..127.
  Value texts: plain integers, "Disabled" at the minimum of 5..12, sends "<n>%" with n = round(100 (19^(v/128) - 1) / 18)
  (v = 128 -> 100 %, 256 -> 2000 %; measured on all 257 values; pinned as fingerprints of the sweeps in the test).
- Flags: Generator, GetNoteInput, DemoVersion, NewVoiceParams, bit 22 (Reserved1) and bit 28; DefPoly 8192; implements Gen_Render,
  TriggerVoice, Voice_Release, Voice_Kill (Voice_ProcessEvent is an empty function); no factory presets.
- Params 5..12 are overrides of SF2 generators (ProcessParam 0x60780; table 0x2946f8): 5 -> attackVolEnv (34), 6 -> decayVolEnv
  (36), 7 -> sustainVolEnv (37), 8 -> releaseVolEnv (38), 9 -> delayVibLFO (23), 10 -> vibLfoToPitch (6), 11 -> freqVibLFO (24),
  12 -> initialFilterFc (8). "Env 2" is the volume envelope, "LFO 2" the vibrato LFO. Each override REPLACES the generator value
  (instrument + preset sum) of every voice, modulators still add (dest sum 0x1d7ee0: `gen * scale + modulators + channel offset`).
  Conversions (`disabled` = the control's minimum, no override): attack tc = clamp(1200 log2(0.001 v), -12000, 8000) (v = 0 -> -12000),
  decay and release tc = clamp(1200 log2(0.004 v), -12000, 8000), sustain = 1000 - 1000 (v / 127)^0.2 (v = 0 -> 1000), LFO predelay tc =
  clamp(1200 log2(0.004 v), -12000, 5000) (0 -> -12000), LFO amount = |v 1000 / 127| cents (!), LFO speed tc =
  clamp(1200 log2(0.0102739726 v), -16000, 4500) (0 -> -16000), filter fc = 1500 + 12000 v / 127 cents.
  A change reaches the voices that are already playing only where one of their modulators targets the destination (0x1fcde0 ->
  0x1ddff0 re-runs the handlers of the modulated destinations): the cutoff (velocity -> cutoff) and the LFO amount (CC1 -> vibrato)
  follow at once, the envelope times, the sustain, the LFO delay and speed apply to notes started later (a running note keeps its
  release). Measured with parameter changes during notes (`--at`).
- Velocity: TriggerVoice sends a MIDI note on with velocity min(127, round(FL velocity)) (FL velocity = 100 ln(10 InitLevels.Vol + 1) / ln 11),
  the plugin calls the host's FPV_SetLinkVelocity(0), so FinalLevels.Vol is the channel part only; Gen_Render passes per note
  FinalLevels.Vol (linear voice gain), FinalLevels.Pan (FL circular law, relative: L x sqrt2 cos, R x sqrt2 sin of (pan + 1) pi / 4) and
  the pitch (FinalLevels.Pitch/100 semitones, a private "BeRo" sysex) to the synth every block. Note off = MIDI note off, velocity 127.

## State (SaveRestoreState 0x628a0, version 6)

`i32 version(6)`, 13 x i32 (the parameters in index order), path string (length byte + bytes: FL stores the soundfont as a file
path, `%FLStudioFactoryData%\Data\Patches\Soundfonts\STR_Ensemble.sf2` in the plugin database state), then a 32 byte tail:

| Tail byte | Field |
|---|---|
| 0..3 / 4 | reverb: i32 send-to track (-1 = none), u8 BUILT-IN reverb on |
| 5..8 / 9 | chorus: i32 send-to track, u8 BUILT-IN chorus on |
| 10 | u8 [plugin+0x1d4] (1) |
| 11 | u8 ignore sample links ("Fix unexpected levels") |
| 12 | u8 velocity filter cutoff |
| 13..16, 17..20 | i32 [0x1b0] (-1), i32 [0x1b4] (1) |
| 21..24 | i32 index of the selected preset in FL's list **sorted by (bank, program)** (0 = first) |
| 25 | u8 EMU volume envelope |
| 26 / 27 | u8 "use level" of the chorus (ignored on load: FL bug) / of the reverb (the "disable for preset default" checks) |
| 28..31 | i32 program mode (0 Automatic, 1 Instrument, 2 Drum) |

FL's new-instance state: patch 1, bank 0, no soundfont (here empty; "Import FL content..." reads the user's own copy of
STR_Ensemble.sf2 / Default.sf2), BUILT-IN reverb and chorus OFF, all three option checks ON, resampling mode 4 (Standard).
The resampling mode is not part of the saved state. Here the soundfonts are kept in the instrument's state as
`fonts: [{ name, sample (pool id of the mono WAV with the smpl / sm24 data), rate, frames, has24, hydra (base64 pdta) }]`,
`active` (index of the playing font) and the options listed in `state.ts`; the pool delivers `sample` to the engine under
the usual "key contains sample" rule, the pdta (presets, zones, generators, modulators, sample headers) travels in the state.

## Synth model (ported from the code, measured against the host)

### Render structure
- A render call is cut at the note events and into **segments of at most 4096 frames** (the top level render, 0x1f01d0), and
  every voice is asked for the *rest of the segment*: up to the host's block of 512 frames (the app's worklet: 128). Inside a
  voice the parameters (envelopes, LFOs, gains, pitch, filter coefficients) are evaluated once per **32 sample control block**
  counted from the voice's own start; gains and filter coefficients ramp linearly over the next block (float32). The resampler is
  asked for the rest of the segment and the chunk it returns is then cut to the control block: the loop guard (below) is decided
  for the requested chunk, so short loops (and the loop entry) depend on the length of the render call. The test host cuts its
  blocks at the note events (a block of up to 512 frames starts at every note on / off): `renderFont` does the same. Measured with
  host blocks of 64 .. 2048 frames at 22.05 kHz, short noise loops at 11.025 .. 96 kHz and multi note renders of FL's Default.sf2;
  an earlier model with 64 frame chunks fitted 400 point loops at 44.1 kHz and was wrong for short loops, loop entries and
  notes that start inside a block.
- Per render call (the host's block of 512 frames, the worklet's 128) the plugin sends every note's levels (volume, pan, pitch).
  A velocity generator reaches the modulators with the first such update after the note started (see Generators).
- Voice_Kill (the channel's polyphony limit, 0x1d6160): the voice's volume envelope is sent into a release of -12000 timecents
  (the shortest time: 2 control blocks at 44.1 kHz, 3 at 96 kHz, 1 below 32 kHz) whatever the voice does, and the voice ends with it;
  measured at 22 .. 100 kHz with the host's `--poly`. A kill is queued at its frame like a note off. (`allNotesOff`, the panic, stops
  everything at once, as the framework asks.)
- Voices: 512 (SetMaxVoices); a voice per matching zone of the preset layer. When all are busy the oldest released, else the oldest
  voice is stolen (FL's choice, allocation 0x1e2b30, is not ported). A voice that ends abruptly (sample end, envelope end) leaves
  its last output decaying by 0.001^(1 / (sr 0.0195)) per sample (-60 dB in 19.5 ms) into three accumulators (dry, chorus, reverb).
- Percussion: the **percussion channel ignores MIDI note offs** (measured: drums ring on until their envelope or sample ends).
  Program mode Automatic puts presets with bank >= 127 on the percussion channel, Instrument mode never, Drum mode always; a preset
  only sounds when its bank 128 matches the channel (melodic presets are silent in Drum mode, bank 128 in Instrument mode).
  FL lists the presets sorted by (bank, program) and its saved state holds the index in that list (measured with five presets in
  scrambled file order). FL's patch parameter = program + 1, +128 (and bank - 128) for the percussion bank 128 (0x5eec0); a patch that
  is not in the list plays the first entry here (the host cannot set the parameter, FL's choice is unknown).

### Voice
- Sample access: the data from the sample start to its end point inclusive, the first and last point repeated beyond both ends
  (len = end - start + 1; a sample whose header lies outside the pool is not played, its end is cut to the pool).
  Position in 32.32 fixed point; the step is `440 2^((cents - 6900) / 1200) / (root frequency)` with FL's single precision 1/1200;
  a step within 1 cent of 1 takes the nearest sample path (hysteresis), exactly 1 an exact copy.
- Resampling (Crunchy 1 = linear, Standard 4 = 8 taps, HQ 6 = 32, Extreme HQ 8 = 128): Kaiser windowed sinc kernels, 4096 phases,
  64 per-semitone bands with the cutoff 2^(-band/12) (not renormalised), the kernel of the position's top 12 fractional bits
  blended with the next phase by the step's low 20 bits. See `interp.ts`.
- Tuning (0x1dd9e0): the root key's cents times a single precision 0.01 goes through FL's semitone table, so the root lies a hair
  below its note; the played key is blended in by the scale tuning (also x single precision 0.01); coarse and fine tune add, then
  the note's pitch offset. The sample header's root key 255 plays as 60 (other values above 127 are used as they are).
- **Generators are not clamped to the spec's ranges** (an instrument zone's value stands as it is: attenuation -300 boosts, pan 700
  has a negative left gain); only a generator that receives a preset level addend is clamped to the spec's range after the sum
  (preset attenuation -50 on an instrument zone without attenuation does nothing, preset pan 900 is 500...). The destination
  handlers clamp what they use
  (0x1d7fb0), mostly with FPC's single precision `EnsureRange` idiom `(|x - lo| + (lo + hi) - |x - hi|) x 0.5`, every step rounded to
  float32 (`num.ts`): fractional values (modulators, the EMU scale) are quantised by the size of the range (0.001 cents between
  +-12000, 0.0001 cB between 0 and 1440). Pan is not clamped at all (`sin / cos` of (500 + pan) pi / 2000: beyond +-500 the left
  gain turns negative), nor tuning, nor attenuation before the final clamp of 0..1440 *after* the EMU scale 0.4.
  Hold and decay times (with key scaling, 0x1d6f10) use double precision cuts: a hold below -32768 is zero, a decay is cut to
  -12000 timecents (43 samples). Times: `trunc(sr 2^(tc / 1200))` samples, blocks = `trunc(samples / 32)` (+1 for attack, release).
- keynum / velocity generators: keynum replaces the key in the tuning and the envelope key scaling, but the modulators keep seeing
  the played key; velocity reaches the modulators with the first level update after the note started (the first render block plays
  with the played velocity: a 12 ms burst at the played level with a 512 frame block). Measured at four block sizes.
- Sample modes: 1 loops; 2 and 3 loop until the note is released and then play on; any other value plays once. A loop of 8 points
  or less, or with its end before its start, is no loop; the points are cut to the sample, swapped when they cross, a loop under 3
  points is dropped (0x1e1184). Loop guard: the shared working copy of the sample holds the loop's other end in guard zones
  (9 points before the loop start, 10 from the loop end); the resampler reads it for chunks that touch a loop boundary (position
  within taps/2 - 2 after the loop start once the voice has looped, from taps/2 - 1 before the
  loop end, or a requested chunk reaching that far) and the original data otherwise.
- Volume envelope (0x1d5520): delay, attack (linear amplitude), hold, decay (linear in dB, 100 dB per timecent time), sustain
  (centibels, 96 dB range), release; blocks of 32 samples; a note off in the attack converts the linear value to the dB domain
  (0x1d53a0). A voice whose gain falls below 3e-5 past the attack releases itself. Attenuation: 10^(-a / 200) with a = 0.4 x generator
  (EMU volume envelope on) + modulators, 0..1440; EMU off uses 0.0018814 per centibel on the sum of the generator and modulators.
- Modulation envelope: the same stage machine; to pitch and filter cutoff. LFOs: triangle, per control block after their delay, mod
  LFO to pitch / filter / volume, vibrato LFO to pitch. Filter (0x1de670): RBJ low pass with the SF2 resonance convention, bypassed
  above 0.45 sr with no resonance, coefficients ramped over the block (see `filter.ts`).
- **Three filters in series**: every voice has the SF2 low pass and two more of the same kind that stay at the default cutoff (13500
  cents = 19.9 kHz, Q 0). A filter is bypassed while its cutoff is above 0.45 sr; for the default cutoff that holds below
  sr = 44250 Hz (0.45 x 44250 = 19912.5 Hz > 19912.1 Hz), so from 44250 Hz up (48, 88.2, 96 kHz ...) the two spare filters run: +1.505 dB
  each at Q 0 (together exactly sqrt 2), a 2nd order roll off at 19.9 kHz (against the engine without them, at 48 kHz: flat to 8 kHz,
  0.98 at 12 .. 16 kHz, 0.80 at 16 .. 20 kHz, 0.16 above 20 kHz) and 0.39 samples of delay. This is what the first measurements at
  48 kHz showed as "sqrt 2 louder, low-passed and delayed"; 44249 Hz is still bypassed (golden scenarios at 44249 / 44250 Hz).
- Exclusive classes: a new note cuts the voices of its class (not of the same note) with a fixed release of -200 timecents; a voice
  already releasing keeps its own release. Sample links ("Fix unexpected levels" off = links honoured): a left / right sample plays on
  its side only and the voices of its linked partners (up to 9 hops, balanced chains only) start with it; mono, ROM and unlinked
  samples play normally. With the option on (the default) links are ignored and every sample plays on both sides.

### Modulators (0x1d7070 source value, 0x1d7cf0 modulator, 0x1fada0 insertion)
- The default list of the SF2 spec (pan amount 500 as measured). Instrument modulators replace defaults with the same source /
  destination / amount source (FL ignores the transform); preset-level modulators add their amount to matching ones.
- A source maps its controller (a double 0..127; the pitch wheel 0..16383 divided by 16384, so its centre 8192 is exactly 0) by
  direction / polarity / type: linear (`d / 127`, bipolar `-1 + 2 d / 127`), concave and convex (float32 tables with linear
  interpolation of the fractional part; bipolar sources use the table at 2 (d - 64) on either side of 64), switch (d >= 64).
  Index 0 is zero for the primary source and one for an amount source; curve types above 3 and transforms make the amount 0; unsupported
  indices (linked modulators 127 included) are 0 / 1 the same way. Result = (source x amount source) x amount (double).
- The velocity -> filter cutoff default modulator has its own rule (0x1d7cf0): with the velocity switch as amount source it is half
  the amount below velocity 64 and `amount (127 - velocity) / 127` above; "Velocity filter cutoff" off makes it zero (and also the
  plain velocity -> cutoff form). Controller defaults: CC7 127, CC10 64, CC11 127, CC100 / CC101 127, all other CCs 0 (CC1 is the
  Modulation parameter), pitch wheel centred, no pressure, pitch bend range 2 semitones.

### Built-in effects (TChorus 0x1e6de0 / 0x1e7450, TReverb 0x1e7ec0 / 0x1e8d10)
- Chorus: GM "chorus 3" (3 voices, feedback 8 x 0.00763, rate 3 x 0.122 Hz, depth 20 x 0.3125 ms, no send to the reverb) with a 5 tap
  windowed sinc delay line interpolation, driven by the voices' chorus send; the reverb: Freeverb (8 lowpass feedback combs and 4
  allpasses per channel, GS "Hall 2": wet 1, input 1.5 x 0.018 x 0.5, feedback 1 - 0.17 / 1.8, width 0.8, 30 ms pre delay), driven by the
  reverb send and the chorus' send. Both are float32 operation by operation with FL's denormal guards ((x + 1e-18) - 1e-18) and a silence
  gate (they stop 10 s after the last input). The sends follow the zone's / modulator's reverb and chorus send; with "use level" on
  (the default) the Reverb / Chorus level knob replaces it: send = (19^(v / 128) - 1) / 18. SEND TO sends the bus to a mixer track
  relative to the channel's own (`GenContext.out`, clamped to 0..500) in addition to the built-in effect. The instance's `tail` is
  10 s with an effect on, else 0.25 s.
- Sample rate: the synth starts with 44100 Hz and SetSampleRate (0x1eb180) re-applies both effects with the real rate: chorus LFO
  step = rate / sr and delay depth = 6.25 ms x sr, reverb comb / allpass lengths x sr / 44100 and pre delay 30 ms x sr. The reverb's
  **damping coefficient** is derived when the reverb type is set up (0x1e95a0), before that call, and is not recomputed: it stays that
  of 44.1 kHz at every rate (bit exact at 22.05, 48 and 96 kHz only this way).
- The host's chorus LFO phase: all FL test renders start with 0.25 s of nothing (round(0.25 sr) frames in 512 frame blocks) and the
  LFO (0.366 Hz) runs through it, so the first note starts at phase 0.25 x 0.366 = 0.0915 cycles at every sample rate (a click through
  the chorus matches to float32 rounding at 8 .. 96 kHz and bit exact at 22.05 / 44.1 / 48 / 88.2 kHz, a sine -210 dB); `hostPreroll()` in `tests/gen/soundfont-util.ts`. The three voices are 1/3
  cycle apart, so phases 1/3 apart are equivalent (an earlier fit of "51189 idle frames" was that phase + 1/3).

## Loading soundfonts, "Import FL content..."

A soundfont is loaded from a file (Open button, window menu "Open SoundFont...", drag and drop onto the editor) through
`importSf2` (defensive: counts and sizes capped, offsets bounds-checked, truncated and damaged files repaired or rejected with a
message, SF3 / Vorbis refused, 768 MB limit): the sample data becomes a mono 16 bit WAV in the project's sample pool (FL ignores the
sm24 chunk of 24 bit soundfonts: a 24 bit font renders identically to its 16 bit part, so the low bytes are dropped) and the pdta goes
base64 into the state. The window menu item **"Import FL content..."** opens the same file picker for the
user's own `STR_Ensemble.sf2` / `Default.sf2` (FL's data is never shipped or read automatically).

## Fidelity

Method: fonts built by `.flref/samplers/soundfont/sf2lib.py` (own data: sines, noise, clicks, saw teeth; the same fonts as `tests/gen/soundfont-util.ts`
writes, byte for byte), rendered by FL's SoundFont Player in the test host (512 frame blocks cut at the note events, 0.25 s preroll) and by
this engine in the same blocks, compared as the rms of the difference relative to the host's rms (stereo, per scenario). 108 scenarios of
the regression run (`regress_all.py`, 44.1 kHz) and the groups below. The only scenario above -129 dB is the chorus "use level" check
(`c_zone`): FL ignores that check when it loads a state, the host cannot set it, the engine honours it.

| Scenario class | Residual vs FL |
|---|---|
| Notes, velocities, keys 55..100, chords, fine tune, pan, attenuation | -138 ... -236 dB |
| Looped sine, keys 70 .. 109 (steps up to 14) | -143 ... -145 dB |
| Short noise loops (20 .. 600 points, loop entry and wraps), +0 / +7 semitones, 11.025 .. 96 kHz | -129 ... -252 dB |
| Volume envelope: all stages, key scaling, note off inside each stage | -132 ... -254 dB |
| Modulation envelope to pitch / cutoff | -139 ... -245 dB |
| LFOs, mod wheel (CC1 -> vibrato, attenuation) | -138 ... -245 dB |
| Sample offsets, loops, loop modes 0 / 1 / 2 / 3, start / end offsets | -131 ... -999 dB |
| Tuning: root key, scale tuning, coarse / fine, correction, sample header rates 22050 / 48000 | -138 ... -238 dB |
| Filter on noise (cutoff 3000..13400, Q up to 40 dB, velocity) | -234 ... -297 dB |
| Zones: key / velocity splits, layers, global zones, preset generators and modulators | -138 ... -234 dB |
| Exclusive classes | -141 ... -143 dB |
| Modulators: curves, bipolar, switch, amount sources, preset modulators, overriding defaults | -130 ... -243 dB |
| FL parameters 5..12 (Env 2, LFO 2, cutoff) | -214 ... -999 dB |
| Built-in reverb (levels, zone sends, polyphony) | bit exact (-999 ... -139 dB) |
| Built-in chorus on a click / a sine / noise, LFO at the host's phase | bit exact ... -154 dB (sine -210 dB) |
| Reverb and chorus together | -139 ... -195 dB |
| Sample links (stereo pairs, left only, mono, ROM, chains) | -237 ... -242 dB |
| Presets: sorted order, bank 128 / program modes, drum note offs | -152 ... -154 dB (the golden scenarios pin <= -110 dB) |
| Parameter changes during a note (mod wheel, cutoff, Env 2, LFO 2, reverb send) | -138 ... -269 dB |
| Voice_Kill (polyphony limit) in sustain, attack, decay | -137 ... -223 dB (the host sends no kill to a voice that is already releasing) |
| Extreme generators (out of range pan, attenuation, tuning, envelope times, LFO, key scaling), preset level clamps | <= -137 dB (silence cases excepted) |
| FL's own STR_Ensemble.sf2 (4 note / velocity scenarios) | -142 ... -144 dB |
| FL's own Default.sf2 (two layer stereo zones, preset level generators, offsets; five notes 36..84) | -123 dB (single notes -107 ... -124 dB) |
| Other host rates (22.05 / 48 / 96 kHz: 24 voice scenarios each; the golden set also pins 40, 44.249 and 44.25 kHz) | worst: a cutoff far below the tone (p_cut -97 / -88 / -79 dB) and a cutoff swept by the modulation envelope (m_fc -117 / -107 / -98 dB), the rest <= -127 dB |
| Reverb impulse response at 22.05 / 48 / 96 kHz | -177 / bit exact / -155 dB |
| Chorus on a click at 8 / 11.025 / 22.05 / 32 / 44.1 / 48 / 88.2 / 96 kHz | -139 / -139 / bit exact / -156 / bit exact / bit exact / bit exact / -152 dB |

Everything at -138 dB and below is float32 rounding (1 - 2 ulp). `tests/gen/soundfont.test.ts` (173 tests) pins 134 scenarios (window levels
and excerpts of FL's output, tolerance 3e-6 of the peak, tighter on the effects) and the odd-value behaviours above.

### Approximations, what remains
- **Float32 order in the resampler and libm**: the kernel dot products are summed in double and rounded once (FL's NEON code accumulates in
  float32 lanes) and the filter coefficients use the JS `exp` / `sin` / `cos` (FL: Apple's libm). The results agree to float32 rounding
  (-138 ... -150 dB; the copy and nearest sample paths are bit exact). A filter that attenuates hard or sweeps amplifies the difference
  through its own rounding noise: p_cut (100 Hz low pass on a 441 Hz tone) -97 / -88 / -79 dB, m_fc -117 / -107 / -98 dB at 22.05 / 48 / 96
  kHz (-239 / -234 dB at 44.1 kHz, where the arithmetic happens to coincide; the fundamental agrees to 3e-7 in all of them). Bit
  exactness would need the lane order of the NEON kernel (0x1fdd74) and Apple's libm.
- **Resampling modes Crunchy, HQ and Extreme HQ** cannot be measured (the host loads the mode neither from the state nor from a
  parameter): they use the same ported kernel builder as Standard (which is measured) and the same chunk logic; unverified against
  FL's output. Extreme HQ costs about 45 % of real time for 32 voices in JavaScript (FL's too is the expensive mode; fonts with very short loops, whose reads
  mostly take the guard path, cost more than 200 % with 32 voices); Standard costs 8 .. 20 %.
- **Render call length**: the loop guard is decided for the chunk a voice is asked for (the rest of the render call), as in FL, so short
  loops depend on the block size. The worklet renders 128 frame blocks and FL's mixer has its own buffer size: a short noise loop (100
  points) rendered with a different block size than FL's differs by a burst of ~13 samples at the loop entry and at a few wraps (about -30 dB
  over the note, inaudible on real material). With the test host's blocks the guard decisions are exact for every loop tested
  (9 .. 5000 points, steps 0.46 .. 14, 11 .. 96 kHz).
- **Chorus phase**: FL's real LFO phase at a note depends on how long the instrument has been alive; the engine's LFO starts at 0 when the
  instrument is created and runs through its idle blocks like FL's. The golden scenarios render the host's 0.25 s preroll (phase 0.0915).
- Not measurable with the host: the chorus "use level" check (FL ignores it when loading), SEND TO routing, the pitch wheel /
  pressure controllers (the app has no input for them), the plugin's own voice stealing past 512 voices, linked modulators
  (source 127), the "Edit SoundFont" button (inert).
- The velocity generator quirk (first block at the played velocity) is reproduced per render call: with the worklet's 128 frame
  blocks it lasts at most 128 frames, in FL one buffer.
- Samples of large soundfonts live in the sample pool as 16 / 24 bit WAV and are decoded to float by the pool; a 100 MB font needs
  about twice its sample data in memory in the worklet (FL streams from the file).
- Not done: dropping a .sf2 from the Browser panel (shared file), a soundfont editor behind "Edit SoundFont...".

## Scratch tools (`.flref/samplers/soundfont/`, not shipped)

`sf2lib.py` / `sfhost.py` (SF2 writer / reader and the host driver), `batch.py` + `scen*.py` + `regress.py` / `regress_all.py` (scenario
runners comparing the host with this engine through a temporary job runner that was removed at the end: a vitest test that reads a job
file (font, notes, state keys, sample rate, preroll), builds `createGen('soundfont')`, feeds `noteOn` / `noteOff` / `killNote` and renders
in blocks cut at the events like `renderFont` in `tests/gen/soundfont-util.ts`, and writes a float WAV),
`mkgolden.py` (writes the golden file), `rdis.py` / `rlift.py` / `post.py` (disassembly and lifted code of the arm64 slice: the
functions quoted above), `t_*.py` (one-off probes: presets, kills, parameter changes, sample rates ...).

## Regenerating the golden numbers

```
SF_GOLDEN_DUMP=$PWD/.flref/samplers/soundfont/work/golden node node_modules/vitest/vitest.mjs run tests/gen/soundfont.test.ts -t "golden scenario dump"
python3 .flref/samplers/soundfont/mkgolden.py        # renders every scenario with FL's host, writes tests/gen/soundfont-golden.ts
```

`mkgolden.py` maps the scenario's state keys to the host: parameters 2..12 by `--param`, the options and the preset index by a
`--state` file built from the tail layout above.
