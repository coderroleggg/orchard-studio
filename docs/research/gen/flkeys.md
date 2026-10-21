# FL Keys (FL: FL Keys)

FL's "wavetable piano synth" (plugin info) is Image-Line's generalisation of Paul Kellett's open-source mda Piano /
ePiano: integer-position wavetable voices (one decay envelope, a muffling low-pass, a velocity-dependent
"hardness" shift of the key-group lookup), a stereo comb, treble boost, tremolo / autopan and overdrive, running on
any wavetable described by an ini file (key groups, velocity layers, loop points). Category Misc (Browser >
Plugin database > Generators > Misc), `notes: 'voices'`, `levels: 'plugin'`, DefPoly 32, no INS tab, editor 480 x 270,
15 parameters.

Sources: FL 2026's `Plugins/Fruity/Generators/FL Keys/FL Keys_x64.dylib` (arm64 slice, 2.7 MB, Delphi, class
`TTestPlug : TDelphiFruityPlug`, VMT 0x215a98, no symbols; engine classes `TPianoWaveTable`, `TLoadWavTableThread`), its
`Wavtables/` folder (5 `.wti` descriptors, 2 raw `.dat`, 30 Ogg-in-WAV and 7 PCM wavs, `wti_description.txt`), the editor form
(`.flref/gen/forms/FL Keys.txt`), the 9 factory presets, the plugin database entry (`FL Keys.fst`), the editor thumbnail
(`Plugin database/Generators/Misc/FL Keys.png`, read-only, for layout and colours) and renders of FL's real plugin through
the test host (`flfxhost`, 16-sample blocks; a private copy of the host with the wavetable folder (path ID 1020) redirected
by `FLKEYS_GENDIR`, which lets FL's plugin play synthetic wavetables written for the tests).

| What | Address (arm64) |
|---|---|
| Dispatcher (slot 1; SetSampleRate -> iFs, derived update) | 0x5dd90 |
| SaveRestoreState (slot 3) | 0x5e2b0 (string writer 0x5e4b0, reader 0x5e590) |
| ProcessParam (slot 6): value -> `p_i = f32((v - min)/(max - min))`, update | 0x5ec60 |
| derived parameters (`update`) | 0x5fc40 |
| TriggerVoice / Voice_Release / Voice_Kill (9 / 10 / 11) | 0x60010 / 0x60b00 / 0x60cb0 |
| Gen_Render (slot 8), per-voice pitch update | 0x60d30, 0x61770 |
| wavetable list scan (IPathManager.ScanDir 1020 "FL Keys/Wavtables/", .WTI) / LoadWavetable (starts the loader thread) | 0x61be0 / 0x61a20 |
| .wti loader, raw loader, RIFF loader, compaction, validation | 0x62ae0, 0x64250, 0x643c0, 0x64f20, 0x65280 |
| Delphi `Power` (used for the velocity exponent), exp / ln stubs | 0x5dcb0, 0x5db0 / 0x5dd0 |
| constructor (volume 0.2, muffle base 160, comb 256 floats, `cmax` 127, poly = DefPoly) | 0x5e670 |

## Parameters (form SynthPanel 480 x 270)

Wheels in FL's control units (form Min / Max, Tag = parameter index); `p_i = f32((v - min) / (max - min))` is what the engine reads.

| # | Name | Range | Reset (DefaultValue) | Form's initial value | Value text (every value verified against `flfxhost sweep`) |
|---|---|---|---|---|---|
| 0 | Decay | -1000..1000 | 0 | 0 | `No decay (sustain)` at -1000, else `round(v/10)%` (half away from zero) |
| 1 | Release | -1000..1000 | 0 | 0 | percent |
| 2 | Hardness | -1000..1000 | 0 | 0 | percent |
| 3 | Velocity to Hardness | -1000..1000 | 0 | **-1000** | percent |
| 4 | Muffle | 0..1000 | 784 | 784 | `round(100 - v/10)%` (shown inverted) |
| 5 | Velocity to Muffle | 0..2000 | 502 | 502 | percent (0..200 %) |
| 6 | Velocity Sensitivity | -1000..1000 | 0 | **-248** | percent |
| 7 | Stereo | 0..2000 | 1000 | 1000 | percent (0..200 %) |
| 8 | Tune | -1000..1000 | 0 | 0 | `round(v/10) cents` |
| 9 | Detune | 0..500 | 123 | 123 | `%.1f` of `v^2 / 5000` |
| 10 | Stretch | -500..500 | 0 | 0 | `%.1f cents` of `v/10` |
| 11 | Treble | -1000..1000 | 0 | 0 | percent |
| 12 | Pan/Tremolo | -1000..1000 | 0 | 0 | `Off` at 0, else `N% (pan)` (v < 0) / `N% (tremelo)` (sic) |
| 13 | LFO Rate | 0..65536 | 0 | 0 | `%.2f Hz` of `exp(9.22 v/65536 - 4.61)` (0.01 .. 100.48 Hz) |
| 14 | Overdrive | 0..1000 | 0 | 0 | `%.1f%%` of `v/10` |

A constructed instance holds the form's initial values (equal to the factory preset `default.fst`); the entry FL inserts
(`Plugin database/.../FL Keys.fst`) is the **Grand Piano** with Decay -1000 (no decay), Release 250, Velocity to Hardness -1000,
Muffle 0, Velocity to Muffle 1000, Velocity Sensitivity -500, Stereo 0, Detune 123: the clone's `state()` (a new channel plays it,
the wheels' Reset goes to the DefaultValue).

State (SaveRestoreState): `int32 version = 1`, a Delphi short string (the wavetable's name: length byte + chars, at most 254), 15 x
`int32` (the control values in parameter order). The name is looked up (case-insensitively) in the scanned list of `.wti` files; an
unknown name (the presets say `Piano`) loads the first entry, the default (`default.wti` -> `mda piano.wti`). Loading a state does not
apply the wavetable's [parameters]; picking a table in the list does (below). Presets (data in the def, from the `.fst` states):
Broken Piano, Compressed Piano, Concert Piano, Dance Piano, Dark Piano, Default, ePiano (wavetable `Rhodes (mda ePiano)`, LFO on),
Plain Piano, School Piano; all use `mda Piano` except ePiano.

## Wavetables (FL's data, optional import)

`.wti` (ini; `wti_description.txt`): [info] `name`, `samples` (groups), `samplefile` (one raw 16-bit file) or per-sample files
(`filetype` raw | riff, `path`), `samplerate` (the rate the engine assumes for pitch), `velocityfactor` (the envelope's start level,
default 1), `releasehighnotes`, `resample` (default true), `canloop` (default true); [velocitylayers] `count`, `1..n-1` = the
lowest velocity of layer i (default 128); [parameters] `0..14` in 0..1 (the control values FL sets when the table is picked: `min +
round(p (max - min))`); [sampleN] `name`, `root` and `high` (inherited from the previous group when absent), `pos`, `end`, `loop`,
`canloop`. The four tables: mda Piano (15 groups, raw 22050 Hz, velocityfactor 3), Rhodes (mda ePiano) (33 = 11 key groups x 3
velocity layers 0 / 48 / 80, raw 32000 Hz, vf 3, `releasehighnotes`), Grand Piano (30 Ogg-in-WAV stereo files, 44100 Hz, vf 4, `canloop`
false, `resample` false) and Roto Organ (7 PCM mono files with `smpl` loops, 44100 Hz, resample on). FL's samples are FL content and
never ship with Orchard.

Loader rules (reverse engineered, then verified with synthetic wavetables played by FL's plugin):
- Groups: `root` / `high` per sample section, inherited; velocity layers are consecutive groups of the same key range.
- Raw + `samplefile`: `pos` / `end` / `loop` from the sections; **compaction** (0x64f20): every region copied in turn into a new buffer,
  each followed by one spare frame; the frame after a region's `end` is set to the one at `end - loop + 1` (what the loop wrap lands
  on). A group whose `pos` equals the previous group's shares its data: it keeps the *old* start of the last unique group (FL does not
  remap it; the Rhodes' top keys read other regions of the compacted buffer).
- RIFF files: every file is appended with one spare frame; `pos` + `end` default to the file's frame positions: `end` = the smpl loop
  end, or the last frame without a loop chunk; `loop` = the loop length (end - start + 1; without a chunk the whole file); the frame
  after `end` is set from `end - loop` (not +1: the RIFF loader and the raw compaction differ). Spare frames that nothing writes hold
  uninitialised memory in FL (the clone: 0).
- Validation (0x65280): `root` 0..127, `high` 0..999, `pos` / `end` inside the data, `loop` <= data - pos, and `loop := end` when
  the group may not loop (info `canloop` false, or the section's): the voice then ends at its sample's end.
- `resample` (RIFF only): the files are converted to the host's sample rate when loaded, but the pitch maths keep using the .wti's
  `samplerate`: at 48 kHz the Roto Organ sounds 44.1 / 48 flat (measured; `pitch` of key 60: 130.5 Hz at 44.1 kHz, 119.9 at 48,
  60.0 at 96, 260.9 at 22.05). The conversion is a 6-point cubic Hermite with 4th-order tangents in double precision rounded to 16 bits
  per file to `round(N r)` frames; loop start `round(s r)`, loop end `round((e + 1) r) - 1` (half to even like Delphi's `Round`).
- Ogg Vorbis WAVs (format tag 0x674F): the data chunk is an Ogg stream; FL's decoder gives 16-bit values `round(x * 32767)` (measured:
  x 32768, truncation etc. are 12 dB worse) and gives the `fact` frame count (ffmpeg stops decoding three files 2.4 .. 2.9 k frames short of
  it at an Ogg page it rejects; the clone pads any short decode with silence).

## DSP

The engine is mda Piano's in single precision (`Math.fround` for every FL float operation, doubles where FL's code uses them:
`exp`, `ln`, `Power`, constants). Notation: `iFs = f32(1 / sr)`, `p_i` as above, all constants are the plugin's literals.

Derived fields (0x5fc40), recomputed when a parameter or the sample rate changes:
`size = rne(12 p2 - 6)` (key-group shift, semitones); `sizevel = 0.12 p3`; `muffvel = 5 p5^2`; `treb = 4 p11^2 - 1` with `tfrq` =
0.27200443 (p11 > 0.5) / 0.10718750 (stored 44.1 kHz constants, not sample-rate dependent); `rmod = lmod = 2 p12 - 1` (rmod negated when
p12 < 0.5); `dlfo = 6.283 iFs exp(9.22 p13 - 4.61)`; `velsens = 1 + 2 p6` (minus `0.75 - 3 p6` below 0.25); `fine = 2 p8 - 1`
(semitones); `random = 0.077 p9^2`; `stretch = 0.000434 (p10 - 0.5)`; `overdrive = 1.8 p14`; `cdep = p7^2`, `vcomp = 1 - 0.53
cdep`, `width = min(0.04 p7, 0.03)`. Constants: `volume = 0.2`, muffle base 160.

TriggerVoice (0x60010; `FPF_NewVoiceParams`, FinalLevels read live):
1. no table loaded -> no voice (the table loads on a worker thread). With `poly` (FPE_MaxPoly, DefPoly 32) > 0 and that many voices in
   the list, the quietest live voice (smallest envelope) is marked finished.
2. `cents = f32(6000 + Final.Pitch)`, `note = clamp(cents x 0.01, 0, 127)` (so key 60 at the default root key plays MIDI note 60 =
   261.6 Hz, unlike FL's 523 Hz for other plugins), `vel = min(127, round(100 ln(10 Init.Vol + 1) / ln 11))` (the FL velocity back
   from InitLevels.Vol).
3. `k = round((note - 60)^2)`; `l = fine + random (k mod 13 - 6.5)` (+ `stretch k` above note 60); `s = size` (+ `round(sizevel (vel - 40))` for
   vel > 40); group = the first key group with `note <= high + s` (in steps of the layer count), then + the number of layers 1..n-1 whose
   threshold `vel` exceeds; `delta = round(65536 f32(f32(rate iFs) exp(0.05776226505 (l + note - root))))` (16.16 position increment).
4. Voice: `pos/end/loop` of the group, `env = velocityfactor`, `dec = 1` when `p0 = 0` (no decay) else `exp(-iFs exp(-0.6 + 0.033 max(note, 44) - s))` with `s
   = 2 p0` (`1.5 p0 + 0.25` below 1); muffle `l = 50 + p4^2 160 + muffvel (vel - 64)`, at least `55 + 0.4 note`, at most 210,
   `ff = l^2 iFs` (**clamped to 2 here**: above 2, at the brightest settings below 22.05 kHz, FL's one-pole filter diverges to NaN);
   pan gains `outr = volume vcomp (1 + width (note' - 60))`, `outl = 2 volume vcomp - outr` (note' = note clamped to 12..108).
5. Voice_Release (0x60b00): `dec = exp(-iFs exp(6 + 0.01 note - 5 p1))` when the table has `releasehighnotes` **or** note >= 94, else
   `exp(-iFs exp(2 + 0.017 note - 2 p1))` (mda ePiano's / Piano's laws). Voice_Kill removes the voice.

Gen_Render (0x60d30), once per block and only when the voice list is not empty (otherwise it returns at once: the filters, LFO and
comb freeze while nothing sounds, their content is kept):
- per voice: if `6000 + Final.Pitch` changed, redo the pitch maths (group search from the original note, new delta); `vol =
  Power(max(Final.Vol, 0), velsens)` (Delphi `Power`: `exp(y ln x)`, integer exponents by repeated squaring), `ComputeLRVol(Final.Pan,
  vol)` (FL's circular law) -> lvol / rvol, held for the block;
- per sample: `frac += delta; pos += frac >> 16; frac &= 0xffff`; past `end`: `pos -= loop` while `loop < end`, else the voice is finished
  (no further samples); the 16-bit samples at pos / pos + 1 interpolate in integers, `n = (y0 << 7) + (y1 - y0)(frac >> 9)` (7-bit
  fraction), value `n 2^-22` (FL builds the float from the bit pattern 0x40400000 + n); `x = env value`, `env *= dec`; overdrive for
  x > 0: `x -= od x^2`, then `x += 0.5 x^2` if it went negative; muffle `f0 += ff (x + f1 - f0)`, `f1 = x`; `out += (lvol outl) f0` / `(rvol outr) f0`
  (mono tables: one channel through both; stereo tables (interleaved) filter left and right separately);
- after the voices (every frame of the block): treble `tl += tfrq (L - tl)` (same right), `L += treb (L - tl)`; LFO `lfo0 += dlfo lfo1`,
  `lfo1 -= dlfo lfo0`; `L += L lmod lfo1`, `R += R rmod lfo1`; comb `buf[cpos] = L + R; cpos = (cpos & 127) + 1; x = cdep buf[cpos]`, output
  `L + x` / `R - x`; denormal flush of the two treble states below 1e-10;
- end of block: voices with `env < 1e-4` (SILENCE) are finished; finished voices are killed.

## Our implementation

- `src/engine/gen/plugins/flkeys/core.ts`: the engine (`KeysEngine`: parameters, TriggerVoice, Voice_Release, pitch update, Gen_Render's
  per-voice and closing stages, FL's pan law from `boobass/flhost.ts`); `table.ts`: the wavetable model, the .wti / loader rules, the pool
  pack, `resampleKeysTable`; `catalog.ts`: the four wavetables, their state keys (`samplePiano`, `sampleGrand`, `sampleRhodes`,
  `sampleOrgan`) and descriptor defaults; `synth.ts`: the synthesized stand-ins.
- `src/engine/gen/plugins/flkeys.ts`: the instance. Every channel voice renders its own control step (<= 16 frames, FL's block here) into the
  channel's mix; `render()` runs FL's closing stage on the frames in which a voice sounded (the voices mark them), so the "no voice, no
  processing" behaviour is kept. `levels: 'plugin'`: the voice applies FinalLevels.Vol^velsens and the pan law itself. The wavetable is the
  imported pool pack when the state references one (decoded without copying: the pack is the sample buffer in 16-bit units), else the
  stand-in; a changed table finishes the sounding voices; `setMaxPoly` feeds FPE_MaxPoly.
- `src/model/gen/plugins/flkeys.ts`: FL's parameters, value texts, parse functions, the 9 presets, the insertion state.
- Editor `src/ui/plugins/gen/flkeys/index.tsx`, importer `fldata.ts`. Tests `tests/gen/flkeys.test.ts`, `flkeys-ui.test.ts`; FL numbers in
  `tests/gen/flkeys.golden.ts` (generated from the host renders; synthetic wavetables in `flkeys-syn.ts`, scenarios in `flkeys-scenarios.ts`).
  Shared framework files: none changed.

### Wavetable content

- **Import FL content...** (plugin window menu): the user picks FL's `FL Keys/Wavtables` folder (or a folder above it); the `.wti` descriptors
  and their files are read as untrusted input (size limits, ini and RIFF parsed defensively; the Ogg Vorbis wavs through the browser's
  decoder, checked in Chrome: the decoded 16-bit values equal ffmpeg's), built by the loader rules above, packed (a header, the groups and
  the 16-bit sample buffer as values k / 32768 of one mono pool sample per wavetable, exact in the pool's float storage and in an exact 16-bit
  WAV kept in the user sample storage like BooBass's data) and referenced from the state (`samplePiano` ... ); a watcher restores a pack that
  the generic loader damaged. Memory: the Grand Piano is 10 M stereo frames (80 MB as floats). Missing tables keep their stand-in.
- **Synthesized stand-ins** (default): the same structure as FL's tables (key groups with root / high, loops or none, velocity layers for the
  Rhodes, sample rates and velocity factors) built additively (struck-string transient into a slowly beating looped sustain for mda Piano,
  two-stage inharmonic partials without loop for the Grand Piano, tines with a bell partial and three velocity layers for the Rhodes,
  drawbar harmonics in an exactly periodic loop for the Roto Organ), levelled to FL's recordings (first 0.5 s RMS within +-3 dB at the
  default parameters, mda key 72 -5.6 dB). Built once per table (about 0.1 s). They are not FL's recordings: a plausible piano / e-piano /
  organ played by the real engine.

## Fidelity

Measured against FL's plugin through the test host with 16-sample blocks (`--block 16`; the clone's control step), 44.1 kHz stereo float
renders, whole renders compared sample by sample (residual = 10 log10 of the error energy over the render's energy). FL's own wavetables
(mda Piano, Rhodes, Roto Organ read from the install, the Grand Piano decoded with ffmpeg):

| Case | Result |
|---|---|
| mda Piano / Rhodes / Roto Organ, keys 24..120 (every key group, layers, loops), 1 s notes | identical to the last 8 frames (below) |
| velocities 1, 20, 40, 41, 64, 80, 81, 100, 127, 128 | -121 .. -138 dB (1 ulp of FinalLevels.Vol: the shared channel code computes it in double) |
| every parameter at its minimum, mid + 37 and maximum, on mda Piano / Rhodes / Roto Organ (135 renders; treble, LFO, overdrive, stereo, tune, detune, stretch, hardness, muffle...) | -109 dB and better |
| the 8 presets with a 6-note chord (ePiano with tremolo and autopan), all-parameter mixes with detune / stretch / tune over 11 keys | -105 .. -115 dB |
| long notes through loops and to the end of the sample (mda key 36 10 s, Rhodes 8 s, Roto Organ 4 s) | bit exact (Rhodes, Roto Organ: 0 differing samples; mda: 16) |
| Rhodes velocity layers incl. the shared (dup) groups at keys 91 / 93 / 96 | -131 .. -133 dB, layer 2 bit exact |
| chords (6 notes at 10 ms / 3 ms offsets, 20 overlapping notes), a repeated key, 0.5 ms / 0.02 ms notes | -112 .. -132 dB |
| 22.05 / 32 / 48 / 96 kHz: mda Piano, Rhodes | bit exact (Rhodes at 22.05 kHz: the last 22 frames, -120 dB) |
| channel volume 25 / 50 / 78.125 %, channel pan, note pan, channel pitch +150 / -300, root note 64, note fine pitch | -106 .. -140 dB (bit exact where the level formula agrees) |
| channel pitch / volume / pan steps mid-note (at 128-frame boundaries) | -107 .. -145 dB |
| Roto Organ at 22.05 / 32 / 48 / 96 kHz (FL converts the files, plays them flat) | -73 .. -90 dB (the converter is FL's 6-point cubic; loop positions floor-rounded like FL) |
| Grand Piano (decode differences) | -110 .. -115 dB, a one-frame click at the end of non-looping samples |
| FL's reference project `Data/System/Render tests/FL Keys.flp` (120 BPM, the C notes 24..96, velocity 64, 0.25 s each, the Grand Piano with its descriptor's Decay -1000 / Release -164 / Stereo 0), on FL's Grand Piano and on a synthetic RIFF table | within -70 dB (Grand Piano: Ogg decode) / bit exact (synthetic) |
| synthetic wavetables (raw with 2 velocity layers and a shared group, RIFF mono with loops / no loop chunk / canloop=false, RIFF stereo; 78 renders over keys 40..110, velocities 30 / 100) | bit exact (residual -296 .. -338 dB) except the tail below |
| synthetic RIFF files at another rate than the host's (32 kHz in a 44.1 / 48 / 22.05 kHz host) | -55 dB (FL's converter differs on 9 kHz content) |

Residual differences and why:
- Block phase: FL ends a voice at the end of the host block in which its envelope fell below 1e-4; the clone checks at the end of its
  control step, whose phase against the host's 16-frame blocks differs by up to 15 frames after notes and 128-frame channel blocks. The
  last <= 24 frames of a voice differ by < 3e-5 (-100 .. -135 dB); the LFO of a later note starts that many frames out of phase (up to
  -46 dB on the next note when Pan/Tremolo and LFO are on and a gap lies between). FL's real block size is the audio buffer's.
- The test host's own default block is 512 frames: against `--block 512` only the above differs more (voices end up to 496 frames
  early/late, still < 3e-5).
- Grand Piano: FL's Ogg decoder and ffmpeg's differ by an occasional 16-bit step; at the end of a non-looping sample FL reads one
  uninitialised spare frame (a click of about -40 dB for one frame), the clone reads 0.
- Polyphony above the channel's limit: FL's host kills the oldest voice at once (and FL Keys steals the quietest at DefPoly), the
  shared channel fades it for 10 ms (docs/gen-framework.md); 40 overlapping notes (peak +12 dBFS) therefore differ.
- Level formula: FinalLevels.Vol in double vs FL's single (1 ulp) in the shared channel code.

Approximations and what remains:
- the Roto Organ's rate conversion is not FL's converter (about -57 dB on broadband material, -73 .. -90 dB on the Roto Organ's own files), and
  96 kHz loop positions are matched to a frame or two;
- the synthesized wavetables are original sounds, not FL's (level matched only);
- the importer ran end to end in Chrome on synthetic wavetables and on one real FL Ogg file (decode identical to ffmpeg's); FL's four real
  tables were verified through Node with FL's files, the Grand Piano with ffmpeg; a browser without Ogg Vorbis decoding (older Safari) cannot import the Grand Piano; user `.wti` files other than FL's four are not offered in the list;
- note pitch glides (`glide`, slide notes) use the shared channel's per-step pitch updates through the verified pitch-update path, but were
  not compared with the host's per-block ramps; FL Keys' own MIDI handling (sustain pedal) does not exist in FL 2026 (the plugin takes no MIDI);
- the editor follows FL's form (positions, sizes, ranges, texts) with original drawing; the keyboard scrolls with the mouse wheel (FL's is a
  1540 px control scrolled to E4), the about panel shows the table's descriptor data, the title is drawn with a font stack.

## Editor

FL's SynthPanel 480 x 270, colours from the plugin database thumbnail (form #1e1e1e, keyboard bar #252525, group bars #575757, white
keys #babec5): the FL KEYS title (top left), the wavetable list (328, 9, 127 x 19, light grey) and the info button (454, 9), four bars
at y 36 (ENVIRONMENT, MISC, VELOCITY, TUNING), fifteen 42 px wheels at the form's coordinates (row 1 y 62: Decay 14, Release 72, Overdrive
135, LFO Rate 192, Velocity to Muffle 255, Muffle 311, Tune 425; row 2 y 124: Pan/Tremolo 14, Stereo 72, Treble 135, Stretch 192, Velocity to
Hardness 255, Hardness 311, Velocity Sensitivity 364, Detune 425; captions under them, the velocity wheels' link glyph between pairs) and
the 462 x 71 keyboard at (9, 190) (22.5 white keys from E4, mouse wheel scrolls; played keys light up). Picking a wavetable applies its
descriptor's default parameters (FL does). The info button toggles the about panel (NAME, AUTHOR, SAMPLERATE, VELOCITY LAYERS, NR OF
SAMPLES, RANGE, FILESIZE at the form's label positions).
