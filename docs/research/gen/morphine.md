# Morphine (FL: Morphine)

FL's Morphine is Image-Line's additive morphing synthesizer. It has four generators (A..D). Each generator is a set of
keyboard zones, and each zone holds a timeline of spectra: breakpoints of 128 partials, with amplitude, pan and detune.
The generators are morphed on an XY square along a looping morph path. Each voice plays them on a bank of
"magic circle" sine oscillators, with:

- a master ADSR with a Catmull-Rom gain spline
- a sampled noise layer with its own resonant filter
- four looping modulation envelopes and a 12-slot modulation matrix (key, velocity, pitch wheel, aftertouch, envelopes,
  MIDI CCs)
- PWM per generator, polyphony / mono and four glide modes
- an effects chain: overdrive, chorus, delay, reverb, 8-band EQ

Category Synth special, `notes: 'events'` (FL's Gen_Render plugin with its own voices).

Sources:

- FL 2026's plugin binary (`Plugins/Fruity/Generators/Morphine/Morphine_x64.dylib`, plugin 1.7.0 Rev2653, arm64 slice,
  C++ with RTTI)
- the 300 factory programs (.mrp) and the plugin database state
- the GUI code (control placement and parameter tags) and the page backgrounds / thumbnail (read-only reference)
- renders of FL's real plugin through the scratchpad test host

Research notes and tools are in `.flref/morphine/`:

- `NOTES.md`: formats, parameters, DSP map with addresses, quirks
- `notes/fx.md`: the effects chain
- `notes/params.tsv`: all 252 parameters
- `tools/`: .mrp reader / writer, voice model, FX model
- `ui/`: the GUI scan

## State, parameters, presets (`src/model/gen/plugins/morphine/`)

- **Parameters.** 252 parameters as FL's raw 0..256 controls holding FL's exact stored floats (`params.ts`). 0..122 are
  the program parameters with FL's value texts; 123..250 are MIDI CC 0..127 and 251 channel aftertouch, which feed the
  modulation matrix and are not saved.
- **Program structure** (`state.ts`): generators / zones / breakpoints, morph path, envelopes, modulation matrix,
  polyphony, glide mode, noise loop / filter mode, program name. FL keeps it only in its state blob. `mrp.ts` reads and
  writes FL's .mrp, FL state and .fst formats.
- **Factory programs** (`presets.ts`): all 300 with their parameter-level data.
- **FL content.**
  - The analysed spectra of the factory programs and the Noise Samples WAVs are FL content and are not shipped. The
    presets play synthesized stand-in spectra (`spectraMissing`) and name their noise sample (`noiseMissing`).
  - The plugin menu's "Import FL content..." reads the user's own FL installation: the presets folder for the spectra
    and the Noise Samples folder. It stores them as pool samples (`spectraSample`: rows of 128 floats; `noiseSample`)
    in one undo step. See `import.ts` and `src/ui/plugins/gen/morphine/flimport.ts`.
- **New instance.** A new instance plays a synthesized init program (FL's reset values).

## Engine (exact port, `src/engine/gen/plugins/morphine/`)

- **Instance** (`morphine.ts`). FL's TriggerVoice / Voice_Release: one FL voice per key (the key is the voice handle),
  FL's MIDI velocity, and the per-key L / R levels (FL pan law) and pitch offset on every Gen_Render.
  - Events play at their sample. At the same sample a note off goes before another note's note on (FL's order),
    whatever order the channel's voice slots send them in.
  - FPE_MaxPoly comes from the channel (`setMaxPoly`, 0 = the 32 voices).
  - The CC 0..127 and aftertouch parameters feed the modulation matrix. Pool samples that arrive after the state are
    picked up.
  - A new instance snaps its master gain to FL's constructor program (the first factory program, Master Level 0.495);
    the state set next glides from there, as in FL.
- **Synth** (`synth.ts`, CMorSynth). Voice allocation among Polyphony + 1 voices: a free voice, else the oldest released,
  else the oldest. Mono legato glides to the nearest held key on note off. Four glide modes. The master gain glides at
  0.005 per sample and sticks just short of its target, as in FL.
- **Voice** (`voice.ts`, CMorGenerator).
  - Control blocks of trunc(0.0029 sr) samples (127 at 44.1 kHz); spectrum updates at blocks 0, 1, 4, 7, ...
  - Master ADSR (15 a^3.5, 30 d^3, 10 r^3 seconds, FL's curves) through the Catmull-Rom gain spline.
  - Four envelopes with loops, release loops, tempo sync, key / velocity tracking and bipolar output; the 12-slot matrix.
  - The morph path and corner weights; the generator timelines with keyboard zones, breakpoint levels and PWM. FL's bug
    is kept: every generator's PWM rate reads generator A's modulation target.
  - The noise layer: 4-point Hermite reading, loop modes and the LP / BP / HP filter with key tracking.
- **Oscillator bank** (`osc.ts`).
  - Up to 128 "magic circle" sine oscillators with FL's tilt, pan and gain ramps.
  - The active partials are compacted into one of FL's 8 NEON renderers. Each sums its lanes in its own vector order,
    extracted from the binary by symbolic execution.
  - Float FMAs are emulated exactly. f32(a·b + c) double-rounds when the double lands exactly on a float midpoint; those
    ties are resolved from the exact sum (`setExactFma`). This costs about 2.4 times the oscillator time, so it is
    on for project export and direct renders and off in live playback (below).
- **Effects** (`fx.ts`). Overdrive → chorus (three tape delays) → delay → reverb → EQ, in FL's order. FL's quirks are
  kept:
  - the chorus wet is negative
  - the EQ applies ±24 dB at the ends while its text says ±12 dB
  - the delay time text is right only at Stereo 50 %
- **libm** (`src/model/gen/plugins/morphine/libm.ts`). macOS libm's exp2 / exp10 are ported; V8's Math.pow differs on
  about 0.2 % of arguments.
- **When it renders.** FL renders the plugin all the time. The channel stops rendering it only while nothing can change:
  no events or voices, every effect off and the master gain settled. With an effect on it keeps rendering, so tails,
  LFOs and the drive glide run as in FL.

## Fidelity (engine vs FL 2026, test host renders)

The harness (`.flref/morphine/port/harness`) renders the same cases through FL's plugin in the test host and through the
port. FL's renders repeat bit for bit, so no seeding is needed. Every case is **bit-identical (residual 0)**:

| Cases | Count |
|---|---|
| All factory programs with their real spectra and noise samples: 6 notes with overlaps, velocities 60..127 and releases, about 4 s | 300 |
| Long notes on programs with loops, release loops, tempo sync, PWM, noise loops and filters; CC and aftertouch modulation; 48 kHz; mono legato with glide; no max-polyphony event | 74 |
| Synthesized programs for what no factory program uses (backward loops, envelope release loops, bipolar envelopes, solo A..D, noise loop modes 0..3 with LP / BP / HP, tempo sync at 97 BPM), automation of 14 parameters mid-note including the effect enables, polyphony to mono | 14 |
| Channel pan, volume and pitch steps; note pan | 3 |
| Development sets: 28 programs plus 2 at 48 kHz, single-partial and two-note programs | 38 |
| The committed data with spectra and noise samples brought in by "Import FL content" (a separate run) | 100 |

Other checks:

- **Value texts.** 4883 of them, for 19 parameters across every raw value, match FL's own.
- **Effects chain.** Identical to the C model of FL's code in every test, and to FL through the program renders.
- **Repository tests.** `tests/gen/morphine.test.ts` covers the definition, value texts, formats, presets, import
  helpers and engine invariants: frequency, level, pan, event order, the constructor gain and activity. Bit-exactness against FL is checked outside the
  repository, because the reference renders are FL content.

Approximations and what is not ported:

- **Pitch Wheel modulation source.** It stays 0. Orchard has no MIDI pitch wheel for plugins; channel pitch bends reach
  the voices through the FL levels, and that path is verified.
- **MIDI learn.** Morphine's own MIDI-learn mapping is not ported.
- **Resynthesis.** Charge Sample / Test is not ported (see the editor section).
- **Noise sample formats.** Imported noise samples are read from WAV only. FL also reads Ogg, WavPack and AIFF; every
  factory sample is a WAV.
- **Live playback uses the fast mode.** The render sets `setExactFma(ctx.rendering !== false)`: exact for WAV export
  (`rendering: true`) and direct renders (tests), plain rounding when the live engine says `rendering: false`. The
  fast path is about 2.4 times cheaper (8 voices of String Section: 160 ms instead of 391 ms per second of audio) and
  1 float ulp off very rarely: 2 corrections in 240 s of audio, and 30 programs re-checked that way were still
  identical. Exports therefore stay bit-exact with FL.

## Editor (`src/ui/plugins/gen/morphine/`)

FL's Morphine GUI is custom C++ (classes CControlKnob / CControlSlider / CControlMenu / CControlStateSelector ...,
pages CVoicePage / CMorphPage / CModPage). `layout.ts` holds the controls' exact boxes and parameter tags, read from
the code that places them (`.flref/morphine/ui/guiscan.py`: SetBounds / SetPos calls):

- main editor: 0x304d4
- generator page: 0x4186c / 0x41ec0
- morph page: 0x3d7ac
- modulation page: 0x1dc40 / 0x1e740

The panel is 886 x 552. The drawing is original (`paint.ts`, `widgets.tsx`, `views.tsx`):

- **Top bar.** Program name with previous / next program and FL's OPTIONS menu (Save / Load / Reset Program; .mrp
  files); polyphony, transpose, fine and glide mode; glide, velocity curve, master envelope, drive and level knobs.
- **Page column.** Morphing, modulation, generators A..D. The resynthesis box is shown but disabled; see below.
- **Generator page.**
  - Breakpoint spectrum: amplitude / panning / detune / velocity / window views, drawn with FL's TOOL partial sets.
  - BREAKPOINT and SPECTRUM menus: copy / paste / reset, normalize level, delete breakpoints before / within / after
    the loop.
  - Spectrum timeline: select breakpoints, drag their levels; loop mode, release loop, tempo sync, rate, key and
    velocity tracking.
  - Keyboard zone layout: select a zone (FL's current-zone parameter swap); copy / paste / reset.
  - Control range and PWM filter faders, PWM free and mode.
- **Morphing page.**
  - The morph square (drag the path's points) with each generator's mix / pan / mute / solo and menu.
  - X / Y lanes of the morph path, with loop mode, tempo sync and rates.
  - The noise layer: sample name, bypass, mono, loop / filter mode, seven knobs.
- **Modulation page.** The 12-slot matrix (source / amount / destination), pitch-bend amount, and the four envelopes
  (EG 1..4 tabs, loop, release loop, tempo sync, bipolar, rate, key / velocity tracking, velocity, drag point levels).
- **Effect strip.** Chorus, delay, reverb with their enables; the 8-band EQ faders.

Not in the editor:

- FL's own import / export file formats for single breakpoints, spectra, generators, zone layouts, morph paths and
  envelopes (the menu items are shown disabled)
- resynthesis (Charge Sample, Test) and its parameters
- the about page
