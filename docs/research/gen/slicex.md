# Slicex (FL: Slicex)

FL's Slicex is a two-deck beat slicer: each deck holds a sample cut into regions (markers or
regions with an end), each region plays from its own key (or a trigger note, several regions can
layer on one key), with per-region settings (cut group, output offset, pan, volume, pitch, delay,
sample start, filter cutoff / resonance and articulator assignment) and 8 articulator groups
(filter + envelope / LFO / MOD X / MOD Y / velocity / random maps for panning, volume, cutoff,
resonance, speed and sample start). Category Drum, `notes: 'events'` (FL: Gen_Render plugin,
TriggerVoice), DefPoly 0, 714 x 625 editor.

Sources: FL 2026's binary (`Plugins/Fruity/Generators/Slicex/Slicex_x64.dylib`, arm64 slice,
FPC, no symbols; the deck editor is FL's shared TWAVEditor / TWAVSample code (Edison's)), its
form data (published method table and DFM strings), the plugin database state and the three
factory presets (`Plugin presets/Generators/Slicex`: Default, Minimal, Sustaining; parameter data
only), and renders / saved states of FL's real plugin through the test host (`flfxhost`; a private
build in the scratch area also prints FHD_AddNotesToPR notes, dumps plugin memory before a given
Gen_Render call, pokes fields and calls FL's own functions, e.g. the dump 0x7dbe0 and the
options-menu handlers). No FL content is shipped: the plugin starts empty and the user loads audio.

Files: model `src/model/gen/plugins/slicex.ts` + `slicex/` (types, defaults, params, state, wav,
flstate, ops, dump), engine `src/engine/gen/plugins/slicex.ts` + `slicex/` (resampler, declick,
mix, voice, env, art, filter, libm), tests `tests/gen/slicex.test.ts` (+ `slicex-audio.ts`,
`slicex-render.ts`, `slicex-golden.ts`). The editor (`src/ui/plugins/gen/slicex/`) was written by
a separate agent on top of the model API.

## State

FL's state blob (SaveRestoreState 0x73450, version 0x00060003): int32 version; 8 int32 master
parameters; the 47-byte option block (+0x1304..+0x1332; 46 bytes before version 2); 12 editor
bytes; per deck: u8 "left on disk" (version > 1), file name (u8 length or 0xff + int32, UTF-8),
int32 size + the WAV (FL's TWAVSample writer 0x205e40), 76 view bytes, 4 curves, int32 count +
68-byte region records; per articulator (8): a 20-byte header (filter envelope amount, cutoff,
resonance ints, filter type byte + 3 bytes, int32 stages) and 6 targets (int32 3, base / envelope /
LFO amount floats, TMEnvelope curve + 4 ADSR ints, TMLFO curve + 4 ints + start phase, 4 TMMap
curves). Curves: type, version 3, count, per point f64 dx, f64 level, f32 tension, 4 bytes, then 5
marker ints (flags: bit 0 tempo sync, bit 1 global; enabled -1 / 0; decay, loop, sustain point).

Regions live in the WAV: `cue ` (starts), LIST adtl `labl` / `note` / `ltxt` (length, purpose
code loop, rgn, beat, dwnb, trak, indx, wtsc, none), a top-level `tlst` chunk (int32 count +
24-byte entries `cue `, cue id - 1, 1, 0xff, note, 0x90, 0, int32 0, int32 extra size) for the
trigger notes, `acid` (beats, tempo), `smpl` (root). A marker ends one frame before the next later
region's start (or at the last frame). The 17 record ints are cut, output, pan (-6400..6400),
volume (0..16000, 8000 = 1), amp articulator + amount (12800 = 100 %), cutoff, resonance, filter
articulator + amount, pitch (cents), speed articulator + amount, delay, start, start articulator +
amount. FL links each record to its region (region +0x34, re-linked by 0x7d3f0), so settings
follow a region when others are added or removed; new regions get the default record (0x7f770).

Orchard keeps the same data as JSON: `sampleA` / `sampleB` (pool sample ids), `deckA` / `deckB`
(title, file, tempo, beats, regions with their record fields), `arts` (8 x filter type / stages +
6 targets with curves), `opt` (the named options plus the raw block), the 352 parameters, and the
editor's view keys. Samples and decks are view state: FL's "Lock audio data" (+0x1341, a global
flag FL does not save) keeps them when presets load. The option block's named bytes: layering mode
(+0x1304, int), crossfade (+0x1308, int), display mode (+0x1314, int), deck loop (+0x1325),
no auto-scroll (+0x1326), smooth modulation (+0x1329), auto-dump deck A (+0x132a), dual deck
(+0x132b), start covers whole length (+0x132c), HQ envelopes (+0x132d), same deck layering
(+0x132e), velocity -> volume (+0x132f), keyboard shown (+0x1330), loop half of regions (+0x1331),
leave audio on disk (+0x1332); each was traced to the control that writes it.

`decodeFlSlicex` (flstate.ts) reads FL state blobs (presets, projects) for importing the user's
own FL content and for the scratch comparisons; the embedded WAVs are returned to the caller.

## Parameters

352 automatable parameters, FL's indices: 0 play / pause (the deck transport), 1 live selection,
2 master level (0..16000, 12800), 3 randomness (0..256), 4 LFO level (-128..128), 5 master pitch
(cents, +-1200), 6 / 7 MOD X / Y (0..512, 256); then per articulator group g (index 8 + 43 g):
filter envelope amount, cutoff, resonance (0..256, 128) and per target t of panning, volume,
cutoff, resonance and speed (index + 3 + 8 t): attack / decay / release scale (0..256, 128),
sustain offset (+-128), LFO speed (512..65536, 31102), tension / skew (+-128), pulse width (+-112).
The ADSR / LFO parameters are the live values of the curves' saved ints (start target: curve ints
only). Value texts (GetParamText) are FL's: "-16.2dB  0.16" for the master level (LogVol (11^x -
1) / 10), percentages rounded half away from zero, "+300.00 cents" / "+0.00 cent", LFO speed as the
period 625 / (10000^(v / 65536) - 1) x 0.5 s in "s:mmm" / "m:ss:mmm"; 2100 values checked against
the test host.

## Engine

Slicex renders all voices in Gen_Render (0x78030); each voice (0x630 bytes in FL) has a region,
a linked layer group (first voice + children), a resampler, a declicker, 6 target states, up to 3
filter stages and 4 ramped gains. All voices sum into the plugin output or, with an output
offset, into the mixer track `track + offset` (GetOutBuffer -> `ctx.out`).

- Trigger (TriggerVoice 0x79a38): key = round(InitLevels.Pitch / 100); velocity =
  FPV_GetVelocity(InitLevels.Vol); deck = note colour & 1, colours >= 14 play reversed. Key lists
  (0x7d3f0): trigger notes go into every deck's list (only their own with "same deck"), then each
  deck's automatic regions fill the empty keys from the base note (60, lowered by octaves above 65
  regions, 0x1fe810). Layering (+0x1304): 0 all, 1 all gain-compensated (1 / n), 2 velocity, 3 MOD X,
  4 MOD Y, 5 random, 6 cycle (per-key counter), 7 song time: the song position (FHD_GetMixingTime,
  beats) folded into the deck's loop weighs each region by its distance from the region start
  (1 - (pos - start) / length inside, 1 - (start - pos) / (start - previous start + 1) before).
  Other modes select round(pos n - 0.5) or crossfade with weight 1 - |pos (n - 1) - j| through the
  crossfade curve (+0x1308: none, linear, balanced (cos), unbalanced (1 - (e^(2.197 (1 - s)) - 1) /
  8), adding); voices start only above 2^-24. Cut groups quick-release voices of the same group.
  Delay = round(delay x sr x 60 / tempo) frames; start = (start + amount x START) x (whole length
  or 0.1 s); per-region pitch + (60 - key) x 100 cents.
- Voice render (0x7bf50): per call pitch = region pitch + FinalLevels.Pitch + master pitch, pan =
  region pan + FinalLevels.Pan, volume = gain x FinalLevels.Vol x master gain. Control ticks every
  `ctl` frames: ctl = max(4, round(sr x base / 44100 / 4) x 4) with base 48, or 4 with HQ envelopes
  or while rendering (FPD_ProcessMode PM_IsRendering); the first tick steps 0, then 1. MOD X / Y are
  smoothed per tick (exp(-4.60517 k / 96)) when "smooth" is on. Gains: circular pan law with
  Apple's __sincosf_stret at v sqrt 2 (0x44dc, centre: v), ramped over the tick with steps capped at
  the rate info's +0x40 = f32(f32(0.001 x 44100 / sr) x 10). Speed modulation scales the resampler
  speed (scratch: gains times the playback distance below a threshold).
- Resampler (TResampler, shared with FPC): speed = 2^(cents / 1200) x rate ratio, positions from
  the region start, copy mode at speed 1, FL's windowed kernels (linear, 6-point hermite, 24..512
  point sinc; the host's interpolation setting through `setInterpolation`, FL's default 24-point
  sinc, the test host's live mode linear), edge frames repeated, loop wraps, renders past the end.
- Declicker: attack over 4 ms when the voice starts inside the sample (raised cosine of the first
  frame), release over 20 ms (DC tracker, cosine fade over the last 1 ms).
- Articulators (TGroupArticulator, curves of FL's MEnvelope library): volume and speed multiply
  (mode 0), the others add (mode 1, curves offset 0.5); SetMode (0x7f050) clamps envelopes / LFOs
  for mode 1 and sets the envelope and map offsets to 0.5 x mode, the LFO keeps its 0.5. Curve time
  per tick (0x7d070): ctl / sr x 2 seconds, or ctl / sr x tempo / 60 beats with tempo sync, from
  FL's +0x1064 = ctl 44100 / (sr 96). LFO oscillator (TMLFO +0xac): tension / skew / pulse width
  shape, increment 2^32 / 625 x (10000^(v / 65536) - 1) x time per tick, phase from the shape's
  start phase + the saved phase; global LFOs share one phase that runs with the render calls and is
  re-synced to the song position when playback starts or jumps (FPD_SetPlaying / SongPosChanged ->
  0x7fd40: start phase + round(control ticks since the song start x increment)). Maps: 513-entry
  tables for MOD X / Y, velocity and random maps read at the note start. Filter cutoff = region
  cutoff + (knob - 128) / 256 + CUT target x amount (likewise resonance), envelope amount knob / 128.
- Filter: RBJ biquads, low-pass, band-pass, band-stop, high-pass (type byte 0..3), 1..3 stages
  (0 = off), FL's exponential cutoff / Q laws, double-precision direct form I.
- Master: gain LogVol(level / 12800); randomness and LFO levels signed LogVol of the knob; the CUT
  target's envelope amount is the filter envelope knob, its LFO amount envelope amount x LFO level.
- Math: FL calls macOS libm (exp, log, sin, cos, __sincosf_stret); the engine uses bit-exact
  ports (Harmor's and Drumpad's), since V8's Math.* differ in the last bit for a few percent of
  arguments.

## Loading, slicing and editing

- Load (deck editor change kind 5, 0x790d0): the WAV's regions and acid tempo; for samples of
  1..30 s without a tempo or without regions FL guesses the tempo (0x8ee20: the length in bars of
  the PROJECT tempo rounded to whole bars, 2 beats under 3/4 bar, at most 256 beats; kept within
  30..240 BPM) and auto-slices with the editor's default Medium preset; regions stay sorted by start
  (0x1fd860). After loading or editing deck A FL dumps the score when auto-dump is on.
- Auto-slicing (AutoRoughMenuClick 0xaa8c0): FL's beat detector (TBeatDetector, byte-identical to
  Fruity Slicer's, `slicer/slicing.ts` autoSlice) on the whole sample with factor 2^table - 1
  (table 0.33 / 1 / 1.67); within the range (selection or whole sample) the slice-purpose regions
  ('beat', the default) starting or ending inside are replaced by markers at the detected positions.
- Grid slicing (GridSmallMenuClick 0x99870): same replacement, markers every 1/4 beat, beat or bar
  from the range start, beats at the deck's tempo (or the project tempo, 0x1ffc20).
- Zero-cross check (0xa10e0): starts move to the nearest crossing within 50 ms (0x1ff710, the
  same search as Fruity Slicer's), ends follow the crossing after them.
- Assign (RegionsToWMenuClick 0xa2e60, tags 0..7): whole keyboard, white keys, black keys, default,
  all on C5, MPC / Trigger Finger / padKontrol pad tables (unnamed regions become "Pad #n"; regions
  past a table continue above the highest pad key + 1), notes capped at 124. Cut groups for all
  regions of the current deck (0x64910).
- Macros (options menu): both decks on the whole keyboard (0x812d0), deck A white / deck B black
  (0x808f0), layer both decks (0x814b0), layer the selections of both decks (0x80c00), layer
  homonymous regions (ASCII case-insensitive names, 0x80950), deck A / B to articulator 1 / 2
  (0x80710), normalize layered region levels (0x81880: RMS of the first 100 ms times the region gain
  of each layer's first region, volume = round(ln(2 g + 1) / ln 3 x 8000)).
- Dump score (0x7dbe0, FHD_AddNotesToPR, flags "empty first" + "use selection"): one note per
  region at its time (beats of the deck when its tempo is known, else real time at the project
  tempo; "Original length" always), length to the next later region, key = the region's key; the 20
  menu tags (separators included) are Normal, Reverse, Flatten, Random, Shift up / down, Quantize,
  Swing, Accentuate beat, Pitch up beat, Widen stereo, Crazy, Stutter half / fourth, Original length;
  deck B's notes carry colour 1 (on the first stutter part only).

- Key names (GetName FPN_Semitone, the piano roll's key labels): the regions in deck A's list of
  each key (with deck B's trigger-note regions), unnamed ones as "Region #n" / "Marker #n", unique
  ignoring case, joined with " + ".

## Fidelity

All comparisons are against FL 2026's own plugin in the test host (live mode, 512-frame blocks
split at the events, 130 BPM, 44.1 kHz unless stated).

| Area | Cases | Result |
|---|---|---|
| Renders, scratch regression (FL's saved states, test audio incl. 48 kHz stereo float, sine, saw, noise) | 82: default playback, master pitch / level, linear / hermite / sinc 24 / sinc 64, reverse and deck B colours, region pan / vol / pitch / delay / start, start whole length, cut groups, loop half, output offsets, layering modes 1..7 x crossfades 0..4, trigger notes, same deck, volume / pan envelopes with ADSR knobs, local / global / tempo-synced LFOs with tension / skew / pulse width, master LFO level, filters (4 types x 1..3 stages, cutoff envelope, resonance LFO, knobs), velocity / MOD X / MOD Y maps with smoothing on / off and automation, speed (scratch, reverse speed), sample start target, HQ envelopes, export rendering | bit-exact (max difference 0) |
| Renders at 48 / 96 kHz output (envelopes, filter, global LFO, maps with automation, short notes) | 10 | bit-exact |
| Renders pinned in the tests (synthesized audio, TS-built states, incl. 48 / 96 kHz output) | 22 | bit-exact (FNV hash + samples) |
| Load (regions + tempo guess) | 33 files: lengths 0.3..20 s, project tempos 90 / 130 / 170, cue regions, mono / stereo, 44.1 / 48 kHz | identical |
| Dump score | 84 deck / mode cases (13 non-random modes, decks A / B, trigger notes, irregular slices, cue regions) | identical notes |
| Macros | 19 (plugin memory after FL's own handlers ran; "layer selections" with the editors' selections poked) | identical notes / volumes / articulators |
| Value texts | 2100 | identical |
| Key names | 4 states (names, case duplicates, unnamed regions / markers, deck B trigger notes) | identical |

Residuals / approximations:
- Random features (RAND maps, random layering, dump Random / Crazy): FL seeds from the clock, so
  they cannot be compared sample by sample; Orchard uses a fixed-seed xorshift.
- Dull auto-slicing: the shared beat detector computes the threshold as f32(33 x f32(0.01)), FL's
  Slicex uses f32(0.33), 1 float ulp apart; the detector's FFT (IPP in FL) is computed in double.
  Both only matter for an onset exactly at the threshold.
- The deck transport (Play / Loop / Stop, which FL renders through the plugin output with its own
  previewer 0x210dd0) is not in the engine: the editor previews the raw audio.
- The deck editor's sample processing (Tools menu: normalize, fades, reverse ...) lives in the
  editor, which reuses Edison's processing; it was not compared against Slicex here.
- Not implemented in the model / engine: Detect beats / Detect pitch regions / tempo detection
  tools, region export, the hidden "Layer homophonic regions", FL's "leave audio on disk".

## Tests

`tests/gen/slicex.test.ts`: registration (352 parameters, indices, names, ranges, FL's texts),
state / presets / options, FL's load results and tempo guess, slicing / grid / zero-crossing /
edits / key assignment, FL's dumps and macros, 22 renders bit for bit against FL's hashes, level /
pitch, voice lifetime, finiteness under random extremes, key lists and monitor data. The audio is
synthesized in `slicex-audio.ts` (the same bytes were loaded into FL to make the references).
