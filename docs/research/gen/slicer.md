# Slicer (FL: Fruity Slicer)

FL's Fruity Slicer cuts a loop into slices (beat detection, beat divisions or the file's
own slices), plays each slice on its own key, writes the beat into the channel's piano roll
("dump") and can stretch (TS), pitch-shift (PS), fade (ATT / DEC), declick and reverse the
slices. Category Drum, `notes: 'voices'`, INS tab (`ins: true`), `levels: 'plugin'`,
DefPoly 0. Credits in FL: Didier Dambrin (plugin), Peter Segerdahl (BeatSlicer engine).

Sources: FL 2026's binary (`Plugins/Fruity/Generators/Fruity Slicer/Fruity Slicer_x64.dylib`,
arm64 slice, FPC, class `TTestPlug`, VMT 0x239e68; no symbols), its editor form, the plugin
database state (`Data/Patches/Plugin database/Generators/Drum/Fruity Slicer.fst`), the editor
thumbnail (read-only, layout and colours), FL's online manual, FLEngine (host sample info) and
renders / states of FL's real plugin through the test host (`flfxhost`, with a private build
that prints FHD_AddNotesToPR notes, sets the host's sample tempo, calls FL's internal functions
and pokes fields). No factory presets; no FL content is shipped (the user loads audio).

| What | Address (arm64) |
|---|---|
| SaveRestoreState (slot 3) | 0x61660 (version 16) |
| GetName (slot 4, key names) | 0x62670 |
| TriggerVoice / Voice_Release / Voice_Kill (9 / 10 / 11) | 0x62af0 / 0x63160 / 0x631d0 |
| Voice_Render (13) | 0x634e0; Gen_Render (8) 0x676e0; NewTick (14) 0x678e0 |
| load / reprocess flow | 0x63810 (file drop: 0x65d10 -> mode -1, options 7) |
| slice check, base key, key map | 0x64570, 0x67090 / 0x65dd0 |
| auto-slicing | 0x64ec0 -> 0x64ad0, TBeatDetector 0x80a00 / 0x80d40 / 0x81000 / 0x81410 / 0x81830 |
| beat divisions | 0x64f60 |
| zero crossings | 0x77070 (stereo 0x6df90, mono 0x6e360), menu: 0x63810 option 8 |
| reverse / declick / fades | 0x648e0 (0x77d70), 0x65220 (0x78790 -> 0x6d4c0), 0x652d0 (0x78160 -> 0x78190) |
| stretch | 0x65490; TS factor 0x60d20, inverse 0x60d60; fill gaps 0x1ff8b0; elastique 0x7ee20 / 0x7f050 |
| AUTO-FIT | 0x65a40; dump 0x65e30 (helpers 0x66be0, 0x66b20) |
| voice resampler | TResampler 0x1a72e0..0x1a9400 (kernels table 0x2a4658: linear 0x1a5070, 6-point 0x1a58c0, sinc 0x1a6d40 -> 0x44a4) |
| channel sampler processing | 0x1fa000..0x1fc400 (levels 0x1fb7c0: pan law 0x6f5b0, ramp 0x6f460; release declick 0x1fd610) |

## Parameters and state

FL's 96 parameters are only the INS block (envelopes, LFOs, filter, "Filter frequency
(modulation X)", "Filter bandwidth (modulation Y)", "Filter type"), which FL pushes into the
plugin from the channel's INS tab (dispatcher id 90): in Orchard they are the channel's INS
settings, so `def.params` is empty. Everything else is FL's saved state (version 16, little
endian; Orchard keeps the same fields as JSON, `src/model/gen/plugins/slicer/state.ts`):

```
i32 version (16)
f32 beats (0x130)  f32 tempo (0x134)  i32 PS (0x138)  i32 TS (0x13c)  i32 method (0x140)   [v <= 8: 8 bytes]
i32 ATT (0x144)  i32 DEC (0x148)                     ms 0..100
shortstring file name (FHD_PackDataFile)
i32 count, per slice: shortstring name, i32 pos, i32 key (-1 = base key + index), f32 region time (-1), u8 REV
u8 ANIMATE  i32 base key (60)  u8 PLAY TO END  i32 sample rate (positions are rescaled when it differs)
u8 AUTO-DUMP  u8 DECLICK  u8 AUTO-FIT  i32 editor value (0)  [364 bytes INS settings]
```
Older versions: beats stored as int (v < 12, x4 for v < 7), tempo as int (v < 8), defaults for
missing fields (AUTO-DUMP on, DECLICK off, AUTO-FIT on), elastique methods renumbered (v <= 14:
method >= 2 gets +2). The AUTO LOW / HIGH wheels are editor controls (not saved; 100 on load).

A new instance gets the plugin database state (version 15): no sample, method 4 (Transient),
ATT / DEC 0, base key 60, AUTO-DUMP, DECLICK and AUTO-FIT on (FL's constructor alone would give
method 2). Stretching methods: 0 Fill gaps, 1 Alternate fill gaps, 2 Pro default, 3 Pro
transient, 4 Transient, 5 Tonal, 6 Monophonic, 7 Speech.

## Loading (FL 0x63810)

FL's host loads the file (LoadSample, GetSampleInfo, GetSampleRegion); the plugin converts it
to float. The tempo comes from FL's host: FLEngine's GetSampleInfo (0x42d790) reports the
sample's own tempo (embedded tempo information) and beats = length x tempo / (rate x 60); a
plain WAV has none, so BEATS / BPM stay 0 (dumps then put every note at 0) until the user sets
them. Orchard reads the tempo of a WAV 'acid' chunk and its cue points as the file's slices.

File drop / Load sample (mode -1): the file's regions as slices, else Medium auto-slicing
(AUTO LOW / HIGH set to 100 / 100); beats / tempo; the slice check (0x64570: slices at or past
the end dropped from the first one on, one slice at 0 when none, lengths to the next slice
(>= 1), the last to the end; base key 60, an octave lower while base + slices > 124, down to
12; the key map: 125 keys, later slices win); AUTO-FIT (TS = round(log2(loop tempo / project
tempo) x 10000), never below 0: AUTO-FIT only stretches); AUTO-DUMP (mode 0, mode 9 for
".speech" files). Slicing menu: tags 1 (file slices / Medium), 20..22 (Dull / Medium / Sharp:
AUTO wheels 33/33, 100/100, 167/167), 101..106 (beat divisions), 2 (no slicing), each followed
by AUTO-FIT and AUTO-DUMP; "Zero-cross check slices" moves the slice starts on the freshly
loaded sample. BPM / BEATS edits recompute each other (tempo = beats x rate x 60 / length),
then AUTO-FIT and AUTO-DUMP.

## Auto-slicing (TBeatDetector, exact)

Analysis copy (0x80d40): peak-normalised to 1 (0x77b20), mono (L + R) / 2, resampled to
44.1 kHz (0x76d30 -> 0x766e0: TResampler with kernel 2, blocks of 1024), 4 passes of a spring high-pass (0x6d3e0, state reset per pass:
`v += (x - y) k; y += v; v *= 0.96; out = f32(x - y)`, k = 9.134e-5, double state).
Frames of 128 every 16 samples ((len + 143) / 16 frames, zero padded), Hamming window
(0.53836 - 0.46164 cos(2 pi i / 127), float) normalised by 1 / sum, real FFT (IPP RToPack),
magnitudes of bins 1..63 x norm, squared; low band = sqrt(sum bins 1..5 / 5), high band =
sqrt(sum 6..63 / 58) (0x81000).
Onset curve per band (0x815f0): 20 ms (low) / 15 ms (high) forward max-hold, instant attack,
exponential release over 15 / 10 ms (coefficient exp(-1 / (ms x 2.75625))), then the relative
rise `(env / max(prev env, 1e-10 / a) - 1) x 5 x thr` with a = 1.8 / 20.3448 and
thr = 0.9 x (2^(LOW/100) - 1) / (2^(HIGH/100) - 1); the curve is the maximum of both.
Picking (0x81830): where the curve reaches 1, the earliest frame within 28 frames back above
0.75; source position round((frame x 16 + 64 - 64) x rate / 44100); forward to the first frame
whose RMS over the channels exceeds 5 % of the original peak, back to the nearest zero
crossing within 20 ms (0x77070); slices closer than 60 ms to the end are dropped; the search
resumes 60 ms later. Zero crossings: both channels changing sign at once (else one channel,
else the quietest frame), |x| < 2^-14 counts as zero; mono: the first crossing either side
(else the smallest |x|).
FL computes the FFT, magnitudes and sums with IPP; the port uses double precision rounded at
FL's float32 steps (only an onset exactly at a threshold could differ; none did in the tests).

Beat divisions (0x64f60): step = length / beats / div (>= 16 samples), slices at round(k x
step), names "k" and "k - Beat n" on beat-aligned slices.

## Processed sample (exact)

FL processes the sample offline (0x63810 after any change) and the voices play the result
(`src/engine/gen/plugins/slicer/process.ts`):
- REV: the slice's frames reversed;
- DECLICK: the end of every slice (0x78790(.., 0.7, reverse)): from the last non-zero frame
  back over round(sr x 0.04 x 0.7) frames, a one-pole low-pass whose coefficient rises from
  2 / sr to 1 (`(2 / sr) exp(i ln(sr/2) / m)`) is subtracted and the last millisecond fades
  with a half cosine (double, per channel);
- TS / PS (only when one is set): factor 2^(TS / 10000) (0.25..4), the sample resized to
  round(length x factor), slice starts scaled (round), lengths to the next slice. Methods 0 / 1
  with TS: the whole sample goes to 16 bit (clamp to +-1, round(x x 32767)), each longer slice
  is gap-filled (0x1ff8b0, below), shorter ones copied, back to float (x / 32768). Methods >= 2
  or any PS: zplane's elastique per slice (FL's Shared/elastique_x64.dylib; FL's input = the
  gap-filled slice, else the original slice, with its new length when PS is set; pitch factor
  2^(PS / 1200); methods 2..7 = FL's stretcher codes 6, 6, 7, 7, 8, 9 (table 0x29ca7b),
  ElPro_CreateInstance mode bytes 0, 0, 2, 2, 4, 5 (0x29ca72 + code)), then DECLICK again;
- ATT / DEC (0x652d0): frames = round(ms x f32(sr / 1000)), ramps (0x78190): fade in linear
  (mode 2), fade out FL's curve 10 (mode 3: `(e^(t ln 11) - 1) / 10`, reversed), both a half
  cosine (mode 4) when the ramp lasts at most 50 ms.
Fill gaps (BeatSlicer engine, 0x1ff8b0, 16-bit data): a slice whose last 10 ms hold no sample
above +1/32768 is copied with a silent gap; else per channel the part after the slice's middle
plays back and forth (ping-pong) between its first and last local peaks of |x| (searched from
20 ms before the middle), and the gap (up to the slice length again, silence after) fades with
(1 - t)^3 towards 0.275 (Fill gaps; then a 2 ms fade at the end) or with a curve reaching 0
(Alternate); slices shorter than 150 samples always use method 0.

## Voices

TriggerVoice (0x62af0): the slice of key round(InitLevels.Pitch / 100) (keys 0..124, none ->
no voice), a TResampler on its frames (play to end: to the end of the sample; FL reads the
host's "solid length" there, the full length in the test host and here), pitch offset
(60 - key) x 100 cents. Voice_Render: speed = 2^((FinalLevels.Pitch + offset) / 1200) x sample
rate / host rate, so every slice plays at its own pitch with the root key at C5, transposed by
the channel pitch, fine pitch and (60 - root key). TResampler (0x1a8c90) copies samples when
the speed is exactly 1 at an integral position inside the slice; otherwise it interpolates
with the kernel FL selects from the interpolation points FL passes in FPD_ProcessMode (bits
8..23, FL's resampling setting; 0x6cf60): <= 2 linear (kernel 1: `x0 (1 - f) + x1 f` in
double), 3 a 6-point polynomial (kernel 2, coefficients 0x2a45d0), else a windowed sinc with
that many points per side (kernel 3, at most 512; NEON routine 0x44a4): sinc phases from
ippsSin_64f, sine / cosine recurrences in float32, window 0.36 + c + 0.64 c^2 (c = cos of
pi d / points), 1 / x by ARM FRECPE plus a fused and an unfused Newton step, output x 0.5;
when speeding up the sinc's cutoff follows 1 / speed and the kernel widens past
round(speed) + 3. Near the slice edges positions advance per sample and taps outside the slice
repeat its first / last frame (0x1a8a40), elsewhere a block's positions are pos + i x speed.
Once the slice has ended the edge taps keep producing its last frame until the end of the
processing block; FL kills the voice after the block. Orchard uses 24 points (FL's default
24-point sinc; `setSlicerInterpolation` changes it).
FL's channel sampler processing inside the plugin then applies (like DX10) the voice levels:
float32 pan law of FinalLevels (cos / sin of (pan + 1) pi / 4) x volume, gains ramped from
the previous block's, at most 0.001 per sample, FL's NEON mix kernel; a note off starts a
441-sample release declick at any sample rate (`(cos((k + 1) pi / 442) + 1) / 2`, float32,
IPP's cosine), after which the voice ends. With the INS volume envelope on, the channel's
envelope releases instead (Orchard: the channel's INS).

## Dump beat to piano roll (exact)

FHD_AddNotesToPR into the channel's current pattern, empty first (Orchard: the channel's notes
in the current pattern are replaced). Positions (ticks): a slice with a region time uses
time x PPQ, else pos x f32(PPQ x steps per beat x beats / length x 0.25) (mode 9 "Original
length": pos x (length / rate / 60 x project tempo x PPQ) / length); Quantize / Swing round to
quarter beats (Swing: odd quarters + a third); the loop end at beats x PPQ x steps per beat /
4. Length = the distance to the nearest later position (1 when none). Notes: key of the slice
(Reverse n-1-i, Random, Flatten 0, Shift up i-1, Shift down i+1, wrapped), velocity 100;
Accentuate: velocity 110 on the first note at or after each beat (from -1/8 beat), else 95;
Pitch up beat: +300 cents in the odd beats' windows; Widen stereo: pan -16 / +16 alternating
(-64..64 scale); Crazy: pan -8..8, velocity 90..109, pitch -200..600 cents (random); Stutter:
each note split in 2 / 4 parts.

## Our implementation

- `src/model/gen/plugins/slicer.ts`: definition (no parameters, FL's database state, key
  names); `slicer/state.ts` (state, normalisation, keys, timing), `slicer/slicing.ts`
  (detector, beat divisions, zero crossings), `slicer/dump.ts` (dump modes).
- `src/engine/gen/plugins/slicer.ts`: engine (processes the sample on state changes, key
  map, voices); `slicer/process.ts`, `slicer/fillgaps.ts`, `slicer/voice.ts`,
  `slicer/elastique.ts` (stand-in, below).
- `src/ui/plugins/gen/slicer/`: editor and its operations (`ops.ts`: loading, slicing,
  AUTO-FIT, AUTO-DUMP, dump into the store, the processed sample for the displays).

## Fidelity (FL 2026 via the test host, 44.1 kHz, test-host block grid)

- Slicing: identical slice positions for 5 synthetic loops x 6 LOW / HIGH settings, the golden
  loop (5 settings), stereo with different channels, mono samples; beat divisions (1..6) and
  zero-cross checks identical. Dumps: identical notes for all deterministic modes on 5 loops.
- Sound: bit-exact until a note off for the default state (DECLICK), DECLICK off, REV, ATT /
  DEC (5..100 ms, both curves), PLAY TO END, stereo and mono samples, Fill gaps / Alternate fill
  gaps with TS -4000..6000 (also with REV, fades, DECLICK off); pitched slices with the linear
  kernel (+37, -700, +1200, -2400 cents: <= 1e-9) and the sinc kernel with 12, 24 and 64
  points (+37, -700, -260 cents: <= 6e-8, IPP's double sine; +1200 cents exact). After a note
  off the release declick differs by IPP's cosine (<= 1.5e-8 absolute, about -150 dB).
- Analysis at 22.05 / 48 / 96 kHz (FL resamples the analysis copy with kernel 2): identical
  slices.
- Not exact: elastique (methods 2..7 with TS, any PS): zplane's proprietary library is
  replaced by WSOLA time stretching + linear resampling (same lengths and pitch, different
  waveform: residual about 0 dB, level within 1 dB). Voices never get FL's kernel 2 (FL's
  settings pass 1 or >= 6 points); 3 points would play linearly here. The end-of-slice hold,
  the block positions and the level ramps follow the engine's blocks (FL's blocks differ).

## Editor

FL's layout at the form coordinates (377 x 330): top bar (sample name, BPM / BEATS spinners
once a sample is loaded), the function buttons (groove .zgr loading not supported: FL content;
Sample menu: Load sample; Slicing menu: slicing modes, zero-cross, stretching method, View >
Spectrum; Dump menu: the 15 dump modes), AUTO-DUMP / AUTO-FIT / DECLICK, the slice properties
view (REV, name with rename / GM drum names, key menu with Default / Last hit / keys, the
selected slice's waveform: click auditions, right-click Remove / Split slice), PS / TS (menu:
Reset, Autodetect) / ATT / DEC sliders, the sample display (processed sample, slice markers,
selected marker highlighted, ANIMATE highlights playing slices; click selects, right-click
auditions, hint = slice name and key), ANIMATE / PLAY TO END, AUTO LOW / HIGH (re-slice while
turned, AUTO-DUMP on release). Colours from FL's thumbnail; original drawing. Audio: Browser
sample drag, OS file drop, Load sample (WAV read natively with its 'acid' tempo and cue points;
other formats decoded by the browser), kept in the project's sample pool.

## Open questions

- The interpolation points FL passes for its own settings (24 assumed for "24-point sinc"; FL's
  sinc with 4..6 points leaves the window phase unset).
- Whether FL's host derives a tempo for plain WAV loops anywhere else (only embedded tempo was
  found in FLEngine's GetSampleInfo).
- FL's solid length (trailing silence) for PLAY TO END; regions FL's loader reads besides cue
  points (REX, Acid beat markers, FL's own region chunk).
