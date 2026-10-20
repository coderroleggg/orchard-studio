# Toxic Biohazard (FL: Toxic Biohazard)

Image-Line's six-operator FM / additive synthesizer (`Toxic Biohazard_x64.dylib`: `ToxicSynth`
on IL's C++ `CSynth` / `CVoiceGenerator` / `CFLWrapper` framework, the code PoiZone and Sawer
share; editor `ToxicEditor` on IL's bitmap control classes). Plugin database: Generators >
Synth classic. Everything below was decoded from FL 2026's arm64 code (otool listings,
constants, RTTI vtables, a small static interpreter for the editor construction code) and
checked against FL's renders with `flfxhost`.

Files: `src/model/gen/plugins/toxicbiohazard.ts` (def), `.../toxicbiohazard/{data,presets}.ts`,
`src/engine/gen/plugins/toxicbiohazard.ts` + `.../toxicbiohazard/{plugin,synth,gen,osc,wave,seq,chords,fx,fxslot,reverb,eq}.ts`,
`src/engine/gen/plugins/poizone/applemath.ts` (Apple libm ports, shared with PoiZone),
`src/ui/plugins/gen/toxicbiohazard/{index.tsx,layout.ts,fltables.ts}`, `tests/gen/toxicbiohazard.test.ts`.

## Parameters and state

- 423 FL parameters: the synth's 294 (raw 0..256, engine value = raw / 256), MIDI CC 0..127
  (raw / 256 x 127; CC 7, 10, 32 not passed) and channel aftertouch. Names from FL; value texts
  ported from FL's own text code (unit table, per-parameter formats: dB, s, Hz, %, `---` / `SUS`
  sequencer steps), checked against the test host's texts (all 423 at the insertion state, 272
  sweep points). Note FL's own oddities: transpose and EGF-to-pitch show semitones with a `%`
  unit, the EQ bands' text is linear (-18..18 dB) while the gain law is (36 v - 18) |2 v - 1|.
- State: `hidden` (engine values 294..339: bend range, LFO sync / free run, filter mode,
  polyphony, unison, glide mode, delay sync, the 8 waveform selectors, effect types, modulation
  matrix sources / targets (+1) / amounts), `waves` (custom harmonics per operator / LFO:
  128 amplitudes + 128 phases), `ccMap` (CC link per parameter), `sample` (pool sample with FL's
  built-in tables, see below), `txPage` (screen page, view state).
- FL's chunk (magic `TBi2` / old `TBio` / demo `TBiD`): 8 modulation sources (u16), targets
  (i16), amounts (f32) at 0x04..0x43, 8 x (128 + 128) harmonic floats at 0x44, 340 floats at
  0x2044, the 294-byte CC map at 0x2594, a 128-byte name in new files. Old chunks number the
  sources differently: v != 0 -> (v > 2 ? v + 1 : v) + 3 (FL converts on load).
- 790 factory presets (`.tbio`, data only, decoded into `presets.ts`). FL's plugin database
  entry equals the first factory preset "Ambient Textures/AquaTone ToTc", and FL's constructor
  loads it before the sample rate is set: the insertion state and the starting point of every
  smoother (needed for exact sample values).

## Engine (exact port)

- CSynth layer identical to PoiZone's (voice allocation, mono / legato, glide modes, the
  arpeggiator used by the sequencer, CC / aftertouch / bend handling, master gain smoothing).
- 256 generators, each a bank of up to 48 wavetable oscillators (6 operators x 8 unison voices)
  rendered four at a time like FL's NEON loop: 32-bit phases with linearly gliding increments,
  phase modulation round(fm x 16777215) << 8 (inputs rest at 20.0), Catmull-Rom table reads,
  one-pole levels towards the envelope target times a cubic in block time (velocity / LFO
  amplitude via a 4-point history, 2 blocks of latency), smoothed stereo gains, FM routing after
  every sample (input[dst] += amount x output[src]).
- Waveforms: 128 harmonics (amplitude, phase) built into 128 band-limited tables of 1024 points
  (partial sums, table chosen per note frequency). Shapes 1..5 are formulas; 6..32 are FL's
  harmonic tables (see below); 0 is the preset's custom harmonics.
- Operator envelopes (one-pole ADSR with FL's time laws), master envelope, filter (FL's 65536 x 3
  coefficient table, four bilinear one-poles with soft clip, LP / BP / HP), filter EG / LFO /
  key / velocity tracking, two LFOs (free or tempo-synced, free-run or retriggered), modulation
  matrix (velocity, LFOs, aftertouch, pitch wheel, CC n; clamps), unison detune / pan, octaver.
- Step sequencer: on every note event FL detects the held chord (a branch-free detector over the
  12 pitch classes, tabulated here for all 4096 sets: minor, major, minor 7, dominant 7,
  minor-major 7, major 7, diminished or none), maps the pattern's degrees (-26 off, -25 tie,
  -24..24) through that chord's scale at its root in the octave of the lowest held note (the
  first degree differs above the first octave for 7th chords), and loads the arpeggiator; dual
  (two notes per step, 32 steps), ping-pong, random, swing 0.25, velocity = the lowest note's.
- Effects: distortion with DC blocker, two slots (delay with blur on six tape delays, chorus,
  IL's fxReverb as built into Toxic, flanger, phaser, lo-fi) with fade-in / bypass ramps, the
  8-band EQ (IL's RBJ biquads), silence detection.
- FL's per-operator parameter handlers were compiled differently: LFO amounts of operators 1
  and 5 round 199 v - 99 toward zero in float, operators 2, 3, 4 and 6 use trunc(199 v) - 99;
  ported as such.
- Apple libm: FL calls libsystem_m's `tanf`, `expf`, `powf`, `exp10f`, `cosf`, `sinf`, `logf`,
  which are not correctly rounded (tanf differs from the rounded exact value for ~0.5 % of
  inputs, powf 0.6 %, expf 0.1 %); ported instruction by instruction (3 x 3 million random
  inputs identical to the real functions; `cbrtf` is correctly rounded).

## FL's built-in waveforms (content)

Shapes 6..32 come from 27 harmonic tables inside FL's plugin binary. By default the engine uses
synthesized substitutes (own DFTs of the named shapes). The plugin menu's "Import FL waveforms..."
reads the user's own `Toxic Biohazard_x64.dylib`, locates the tables (defensive scan: 27 pairs of
128 amplitudes in 0..2 and 128 phases near multiples of 1/256, best alignment), stores them as a
pool sample (exact 32-bit float WAV, re-read from storage if a decoder resampled it) referenced
by the state key `sample`; the engine then uses FL's tables. Nothing of FL ships. Without the
import, the 541 factory presets that use shapes 6..32 sound close but not identical.

## Fidelity (TS vs FL, flfxhost, 44.1 kHz, FPE_MaxPoly 0)

| case | residual |
|---|---|
| sine / coarse / fine / shift, FM (cross, self, 6 x 6), unison 3 / 8 with FM, free-run random phases, phase, velocity sensitivity, chords | bit-exact |
| operator envelopes, LFO1 / LFO2 amplitude and pitch, shapes 1..5, custom harmonics | bit-exact |
| LP / BP / HP, filter EG / LFO / key / velocity tracking, cutoff sweeps, EGF to pitch, transpose, retrigger / declick, mono + glide, poly glide, master envelope | bit-exact |
| EQ, distortion, delay (blur), chorus, flanger, phaser, lo-fi, reverb (both slots), modulation matrix (velocity, LFOs, CC 1, velocity to transpose) | bit-exact |
| sequencer: chromatic, minor / major / 7th chords, negative and above-octave degrees, ties / rests, dual + ping-pong + swing, random | bit-exact |
| all 790 factory presets (4-note chord, 2.5 s), FL's tables imported | 789 bit-exact; "Keyboards/Mellow": 4 samples differ by 1 ulp (-218 dB) |
| factory presets without the import | bit-exact for the 237 that use shapes 0..5; the others use substitutes |
| value texts | identical (423 parameters at the insertion state, 272 sweep points) |

## Approximations

- Waveforms 6..32 without the import: synthesized substitutes (see above).
- "Keyboards/Mellow": one 1-ulp difference per flanger LFO cycle (not located; -218 dB).
- Double-precision libm calls (`exp2` for note pitch, a few coefficient laws) use the browser's
  Math functions; they can differ from Apple's by one double ulp, which changes a float32 result
  only at rounding boundaries (none seen in the tests).
- The oscillator start-phase random generator is one plugin-wide seed like FL's (shared by all
  instances, not reset per instance); FL's test host starts each render in a fresh process.
- The demo flag (`TBiD` chunks) only affects FL's editor and preset loading, not audio.
- Editor: every control at the position, size and parameter of FL's editor code (extracted from
  `ToxicEditor`'s construction code); original drawing and labels (FL paints them in its
  bitmaps); knobs drawn as vector wheels, faders as kit sliders. Not ported: FL's MIDI-learn link
  buttons, "Save Program", "Import Custom Wave" (WAV to harmonics), "Import CC Map / MIDI
  Modulations / Sequencer Pattern". "Load Program" reads `.tbio` files.
