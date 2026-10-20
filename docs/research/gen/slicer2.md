# Fruity Slicer 2 (FL: Fruity Slicer 2)

**Status: calibrated against FL 2026's renders (test host).** The engine is a port of FL's own
(`engine.dylib`: the C++ plugin layer, the slicer instance, its voices, envelope and filters) in FL's
single precision, fused multiply-adds and operation order, with Apple's libm `expf` / `tanf` / `exp2f` /
`logf` ported bit for bit; it renders FL's output bit for bit in every tested case except the
**Stretch** time-stretching mode (FL calls zplane's proprietary elastique: approximated). The slicing
on load and from the Slicing menu reproduces FL's slice lists exactly, and so does the score dump.
FL ships no sample: like FL's plugin database state the plugin starts empty and the user loads audio.

Files: `src/model/gen/plugins/slicer2.ts` (+ `slicer2/state.ts`, `texts.ts`, `slicing.ts`,
`wavmeta.ts`), `src/engine/gen/plugins/slicer2.ts` (+ `slicer2/engine.ts`, `libm.ts`),
`src/ui/plugins/gen/slicer2/index.tsx` (+ `ops.ts`), `tests/gen/slicer2.test.ts` (+
`slicer2-audio.ts`, `slicer2-golden.ts`). Reused read-only: FL's beat detector port
(`../slicer/slicing.ts` autoSlice, TBeatDetector), the score dump (`../slicer/dump.ts`, FL's dump
code is shared), Apple `exp2f` / `logf` (`poizone/applemath.ts`), `fma32` / `fmaD`
(`drumpad/libm.ts`), WAV import helpers (`bassdrum/flimport.ts`).

## Sources

- `Plugins/Fruity/Generators/Fruity Slicer 2/`: `Fruity Slicer 2_x64.dylib` (FPC wrapper TTestPlug:
  editor form TSynthEditorForm 1000 x 300, value texts 0x6b630, GetName 0x6af40, ProcessParam
  0x6ab80, the slicing menu 0x69180, TBeatDetector 0x28d5c0 / 0x28dec0 / 0x28d910 / 0x28d9b0 /
  0x28dc70, DecodeAudioFile export 0x68020, dump 0x6c720, BPM / BEATS 0x6d620 / 0x69680 / 0x7bb30,
  play-option bits 0x65eb0) and `engine.dylib` (Image-Line's d1framework: MyPlugin 0x7868 with
  TriggerVoice 0x87f8, Voice_Release 0x8b1c, Voice_Kill 0x8c90, Gen_Render 0x8428, ProcessEvent 0x8184,
  ProcessParam 0x82ac, SaveRestoreState 0x7e8c, DispatchToEngine 0xc670 (the wrapper's command API);
  the internal AudioPlugin 0xa9dc with per-sample process 0xba3c; slicer instance: note on 0xf19c,
  note off 0xf404, voice alloc / steal 0xf3a4 / 0xf640, render 0xf868, global filter 0xf7bc, gains
  0xed1c, parameters 0x10cec, state 0x114d0 / 0x112f4 / 0xef0c / 0xf034 / 0xd8b8 / 0xda78, sample
  load 0x10334, own onset slicing 0xfa04 (overridden by the wrapper's); voice: start 0xe07c, render
  0xe980, rate 0xe40c, cubic read 0xe518, end fade 0xe698, filter update 0xe28c, envelope update
  0xe344, pan law 0xdfdc; envelope 0x58d4..0x5f34 with curves 0x93c8 / 0x94f4; SVF 0xc160..0xc5ec;
  elastique pro V3 (statically linked) 0x31f94).
- FL's editor form (`.flref/gen/forms/Fruity Slicer 2.txt`), the plugin database state
  (`Plugin database/Generators/Drum/Fruity Slicer 2.fst` = `Plugin presets/.../Default.fst`), the
  thumbnail (colours), FL's online manual (features).
- Test host: `info` / `sweep` (all value texts), renders from patched states (`--state`, play modes,
  filter types, stretch modes, chromatic), `--param`, `--chan-vol / --chan-pan / --chan-pitch /
  --chan-at`, note pan / fine / Mod X / glides, `--sr`, `--bpm`, `--save-state` after `--load-file`
  (FL's slicing), and a private build with `FHD_AddNotesToPR` printing and `--call` (dump modes,
  Slicing menu tags).

## Parameters

1040 FL indices; 0..4 Monophonic (0..1 "Off" / "On"), Cutoff, Res (0..100000), Transpose
(-24..24 "%d ST"), Detune (0..200 "%d Cents" of value - 100); 5..15 exist but FL's engine ignores them
(and their names crash FL's GetName): left out. Per slice n (1..128): Transpose 16..143, Detune
144..271, Gain 272..399 (0..200000, default 153880 = 0 dB), Pan 400..527 (0..200000, centre 100000),
Attack 528..655, Release 656..783 (default 10000), Cutoff 784..911, Res 912..1039 (0..100000).
FL's wrapper hands the engine `f32((value - min) x (1 / (max - min)))` (double, clamped); the engine
takes integers as `trunc(f32(v x 48)) - 24`. Value texts (wrapper 0x6b630, all sweeps match):
"%.1f%%" of f32(v x 100), pan f32((v - 0.5) x 200), gain 20 log10 of FL's gain law below ("-Inf dB" at
0), rounded like Delphi (no "-0.0").

## State

FL's engine stream "slc1" version 4 (version 3 in Default.fst): array settings (auto-slice on load,
16 grid slices, sensitivity 0.75, flag, decoder value, base key), then per instance: MIDI volume and
pan (normalised), transpose, detune, stretch mode, mono, global filter type / cutoff / res, selected
slice, the sample section (file path, tempo, chromatic slice, embed flag; FL references the file by
path), 128 slice records (output, key, start, end, gain, pan, transpose, detune, play mode byte,
end fade, filter type, cutoff, res, attack, hold, decay, sustain, release, name) and max polyphony.
Here: FL's parameters for the eight per-slice values and five globals, and JSON state `sample`
(pool id), `file`, `slices` (start, end, key, name, mode, ftype, fade, hold, decay, sustain),
`stretch`, `gftype`, `tempo`, `beats`, `chromatic`, `baseKey`, `autoDump`, `markers`, view `sel`,
`bank`, `filterSlice`. A new plugin is FL's plugin database state: no sample, one empty slice "1"
whose gain is 0.77 (154000). Slice records persist by index when new audio is loaded (FL).

## DSP [C: FL's code, verified sample by sample]

- Notes (MyPlugin): key from the note, velocity trunc(127 ln(10 InitLevels.Vol + 1) / ln 21) (FL 100 ->
  100, 128 -> 127) / 127. A note on the same MIDI channel (colour) and key first releases the key.
  InitLevels pan / Mod X / Mod Y, then at every render FinalLevels changes (Mod X, Mod Y, pitch
  relative to the key x 0.01, pan) go to every voice (the last held note wins). Voice_Kill only
  forgets the note (the slice plays on); Voice_Release = note off for the key.
- Slices: every slice whose key (record key, else base key + index) is the note starts a voice
  (mono: all voices take a 1 ms release first, also between slices of one key); chromatic mode plays
  the chromatic slice transposed by note - slice key. 16 voices, the oldest is stolen (no fade).
- Voice: from / to from the play mode (bit 0 Hold: note off ignored, bit 1 Play to end: to the sample
  end, bit 2 Reverse: from the slice end backwards); every sr / 4410 samples: rate = (sample rate /
  host rate) 2^((bend + pitch offset + 2 (S.detune - 0.5 + slice detune - 0.5) + transposes +
  chromatic offset) / 12) (Resample: x host tempo / sample tempo), the slice SVF (freq 2^(10.5833 c)
  x 14.35 Hz, k = 1 - 0.7225 x 0.99 res, cutoff / res smoothed by 0.0508 per update, Mod X / Y added),
  envelope times, the pan / gain target. Per sample: 4-point Catmull-Rom read (zeros outside the
  sample; mono files feed both sides), the slice filter, envelope x velocity curve, pan gains smoothed
  by 1 - 0.1^(1 / (0.01 sr)). The voice ends with a 1 ms release at the slice end.
- Laws: velocity curve 0.98435 v^3 - 0.231573 v^2 + 0.247223 v; gain / volume = that x 10^0.3
  (+6 dB at 1); pan side gain x (1.828 - 0.828 x) 1.41443 (x = 1 - pan or pan, 1 at the centre).
- Envelope: attack / release 2^(15 v) ms (0 = instant), hold / decay / sustain fixed by the editor
  (0, 0.5, 1), curve exp(6.4544 x) shapes, note-off release to 1e-6, computed at 44.1 kHz whatever
  the rate (FL quirk, kept).
- Instance: global SVF (same law, updated every sr / 4410 samples, cutoff / res smoothed from 0 at
  the first use, as FL), then the instance gains from FL's MIDI volume (vol / 127 through the volume
  law: +6 dB at 100 %) and MIDI pan ((pan / 64 + 1) / 2 through the pan law), smoothed per sample. The
  channel pan therefore acts twice (MIDI pan and FinalLevels pan), as in FL.
- FL's flags: Generator, GetNoteInput, MIDIOut, NewVoiceParams, CanStealKBFocus, DefPoly 16. The
  plugin sends no MIDI (0 MIDIOut calls in every render): FPF_MIDIOut makes FL send it the channel's
  volume, panning and pitch knob as FPE_MIDI_Vol / Pan / Pitch events. FL's Gen_Render plugin manages
  its own voices: here an 'events' plugin.
- Here the channel's volume / pan events are derived from the notes' levels (velocity 'plugin':
  levels.vol is the channel part; MIDI vol = min(127, floor(128 log11(10 vol + 1))), pan flags =
  trunc(64 x (levels.pan - note pan))); with no voice sounding the instance's smoothing is settled at
  once (FL's runs all the time).

## Slicing [C, verified against FL's saved states]

- Load: the file's markers (WAV cue points + labl names; each slice ends one frame before the next
  marker, the last at length - 1), else FL's beat detector in mode 1 = medium auto-slicing (AUTO 100 /
  100, ../slicer/slicing.ts), slices at or past the end dropped, one slice at 0 when none, each ending
  at the next start. Base key 60, an octave lower while base + count > 124. Tempo: the file's (ACID
  chunk; FL's TSample tempo, not visible to the test host) else 120; beats = length x tempo / (rate x 60).
- Slicing menu: Use sample built-in slicing (the load slicing), Dull / Medium / Sharp (AUTO 33 / 100 /
  167), Beat .. 1/6 beat (step f32(length / beats / div), at least 16, names "k" / "k - Beat n"), No
  slicing (one slice named after the file); these end one frame before the next slice.
- BPM / BEATS: tempo -> beats = f32(f32(length x tempo) / (rate x 60)); beats -> tempo -> beats again.

## Score dump [C]

FL's dump (0x6c720) is Fruity Slicer's (`FHD_AddNotesToPR`, flags "empty first" + "use selection"):
the 15 modes of the Dump menu, auto-dump after loading, re-slicing, marker edits and BPM / BEATS changes (the edit and
its dump are one undo step). Here the
notes replace the channel's notes in the current pattern (one undo step).

## Editor

FL's form at its coordinates: logo, Load sample, Regions (the selected marker's menu), Slicing and
Dump menus, BPM / BEATS selectors, FILTER MODE (Slice / Global target of the filter controls),
options; the sample view (markers with names, the selected slices, playback positions, drag a marker,
Ctrl+click adds one, right-click a marker: Delete, Rename, Quick rename, Trigger note, Select, Zoom on;
right-click a slice previews it; wheel zooms, the bar scrolls / zooms); TIME STRETCHING, PLAY TO END,
HOLD, REVERSE, CHROMATIC; 8 pads per bank (click plays, Ctrl / Shift multi-select, wheel / arrows
change bank, ALL, right-click Select All / Reset All); slice GAIN, PAN, ATTACK, RELEASE, TRANSPOSE,
DETUNE (applied to every selected pad); the filter display (drag cutoff / res), FILTER TYPE, CUTOFF,
RES; MONOPHONIC, TRANSPOSE, DETUNE. Original drawing in FL's colours (form TColor values, thumbnail).

## Fidelity (FL vs ours, 44.1 kHz unless noted, host tempo 130 BPM)

| Case | Residual |
|---|---|
| loop120 (16 slices), 4 overlapping notes, velocities 80 / 100 / 128 | bit-exact |
| global Transpose +5 / -7, Detune +37 cents | bit-exact |
| slice Gain, Pan, Attack / Release, Transpose / Detune (several slices) | bit-exact |
| play modes: Hold, Play to end, Reverse and their combinations (6 / 7) | bit-exact |
| slice filters LP / HP / BP with cutoff / res; global LP / HP / BP | bit-exact |
| Monophonic, chromatic slice, velocities 1 .. 128 | bit-exact |
| Resample at 130 and 90 BPM (sample tempo 120) | bit-exact |
| channel volume 50 %, channel pan +0.5 / -0.37, note pan, fine pitch, glides (slides), Mod X / Y | bit-exact |
| channel volume + pan changes during notes (FL's MIDI events, smoothing) | bit-exact |
| voice stealing (20 overlapping play-to-end notes), retriggered keys | bit-exact |
| stereo file, 48 kHz and 22.05 kHz files, transposed | bit-exact |
| host rate 48 kHz and 96 kHz | bit-exact |
| synthesized test loop (tests): 7 cases incl. stereo, levels, filters, modes | bit-exact (FNV hashes pinned) |
| slicing on load: 6 files (5 drum loops, loop120, stereo / other rates) | identical slices |
| Slicing menu: Medium, Beat, 1/2, 1/3, 1/6 beat, No slicing; cue markers | identical slices |
| score dump: modes 0-3, 5-11, 13, 14 on 6 files | identical notes (Random / Crazy are random in FL too) |
| value texts: 16510 sweep points | identical |
| Stretch mode (elastique) | approximation: uncorrelated waveform (residual +0.4 dB), level envelope within about 1.5 dB |

- Approximations / not implemented: the Stretch mode (zplane elastique pro V3, proprietary and
  statically linked: a granular pitch shifter keeps FL's position / pitch contract); the channel's
  volume / pan are derived from the notes' levels (FL sends them as events: MISC level adjustments and
  echo gains fold in here); pads preview through live notes (FL's engine preview command plays the
  slice directly with its own voice); Open in Edison, the Spectrum view and themes; REX files; FL's
  sample tempo from other metadata than the ACID chunk; the engine's own onset slicing (0xfa04, only
  used by FL when its beat detector returns nothing, which it never does) and its grid slicing;
  several engine instances and per-slice output routing (FL's state supports them, its editor does
  not); a sample embedded in the state (FL references files by path; here the pool sample).
