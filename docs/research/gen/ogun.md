# Ogun (FL: Ogun)

FL's Ogun is Didier Dambrin's additive synthesizer for "exceptionally rich metallic and shimmering timbres" (Plugin database >
Generators > Synth special, also listed under Drum). A voice is up to 32 767 harmonics whose amplitudes come from two seeded random
spectra, shaped by four mapping curves (forced harmonics, impulse EQ, decay EQ, release EQ) and by a pre-decay, then turned into one
period of audio by an inverse FFT every few tens of milliseconds, cross-faded and read by a resampler at the note's pitch, with a unison
of up to 9 detuned read positions, a 1 - 3 stage filter, 13 articulated targets (envelope, LFO and keyboard / velocity / Mod X / Mod Y
mappings each) and an effects chain (3-band EQ, chorus, delay, reverb). It is a Free Pascal plugin (FPC 3.2.3, arm64) of the same code
base as Harmor: the curve classes (TMEnvelope, TMLFO, TMMap), the chorus, delay and reverb are Harmor's, function for function.
Category Synth special (+ Drum), `notes: 'voices'`, `levels: 'plugin'` (the plugin applies the voice volume and pan itself), DefPoly 0.

Sources: FL 2026's `Ogun_x64.dylib` (arm64 slice, no symbols), the 229 factory presets (`Plugin presets/Generators/Ogun`), the plugin
database state and renders of FL's real plugin through the test host (`flfxhost render Ogun ...`, `--fixed-time` for the clock-seeded
parts). Research tools are in `.flref/special/` (`ogun/` the engine notes and scripts, `ogun/host3/` a host with `script`, `call`,
`savestate` and `patch` commands to run single plugin functions, `ogun-ui/` the editor work).

## State, parameters, presets (`src/model/gen/plugins/ogun/`)

- **Parameters** (`params.ts`): 89 automatable parameters with FL's names, indices, control-unit ranges, defaults and value texts:
  0..48 are the plugin's (master level / pitch, Mod X / Y, timbre pre-decay / decay / release / fullness / morphing / seeds, unison,
  filter, chorus, delay, reverb, three EQ bands) and 49..88 the envelope (attack / decay / sustain / release scale) and LFO (speed,
  tension, skew, pulse width) knobs of the first five targets (volume, filter frequency, filter resonance, pitch, unison pitch). FL
  keeps those 40 inside the articulator curves; the flat keys are authoritative here and the curves' copies follow them.
- **State** (`state.ts`, `types.ts`; FL's `SaveRestoreState` 0x68750, version 0x130003): the 64 state ints (`xi` = ints 49..63: filter type
  and mode, alternate resonance, richness, reverb / delay switches, quality, the "smooth up modulation", "one voice per key", velocity
  link, click removal, portamento, comb, auto loudness ... bits), the delay bytes, the three EQ band types, the info text, 13
  articulators (mode, amounts, envelope, LFO, four mappings) and the four shaping maps. A curve is FL's `TCustomMEnvelope`.
- **Presets** (`presets.ts`): the 229 factory presets, loaded and re-saved by FL's own plugin and stored as parameter-level data.
  141 of them keep an analysed resynthesis spectrum (a curve of up to 31 624 points) that is FL content: the state lists the curves left
  out (`missing`), the engine plays a flat stand-in and **Import FL content...** reads the curves from the matching `.fst` of the user's
  own FL installation (`flimport.ts`, `flstate.ts`: a defensive reader of FL's state versions 0..19).
- **New instance** (`base.ts`): the constructor state, which equals the plugin database entry Ogun.fst (master level 205, timbre seeds
  140 / 36 ...), not Default.fst.
- **Value texts** (`texts.ts`): a port of `GetName(FPN_ParamValue)` (0x6c3e0): percentages (round half away), the time and frequency
  texts (single-precision steps, ties to even), the decimal texts, "Infinite", "Random", "None", singular units for 0 and +-1 and the
  two texts that follow the state: the delay time and the reverb predelay are `beats:ticks` while their tempo switch is on and
  milliseconds otherwise (`format(v, state)`).

## Engine (`src/engine/gen/plugins/ogun/`)

`ogun.ts` is the instance (voices, polyphony, the effects after the voice mix), `plug.ts` the plugin object (the parameters turned
into what the voices read: ProcessParam 0x6bc70 and its handlers), `voice.ts` a voice (TriggerVoice 0x6dff0, per-block processing
0x6fa00, release 0x6f5c0), `fftsynth.ts` the timbre engine (TFFTSynth and the voice oscillator), `art.ts` / `ogcurve.ts` the
articulators and curves, `fx.ts` the effects chain, `biquad.ts`, `sinc.ts`.

- **Timbre**: two spectra of random amplitudes (IPP `ippsRandUniform_Direct_32f`, timbre seeds hashed by Bob Jenkins' mix: seed 2 = 0
  draws a new one per note from a counter that starts at FL's `RandSeed`, the clock in seconds), multiplied by the four maps evaluated
  per harmonic, the decay / release EQ and the pre-decay; an inverse FFT of 2^order samples every hop (50 ms, 25 ms at the two highest
  qualities) with fixed random phases; two periods are cross-faded linearly over the hop. All vector calls are the bit-exact IPP ports of
  the Harmor port (`harmor/ipp.ts`).
- **Qualities** (Draft .. Huge waste of CPU): linear / 6-point Hermite / 32-point windowed sinc reading (the Slicer's NEON kernel,
  `sinc.ts`), the three highest qualities process at twice the rate and decimate with a 6-section allpass halfband (`fx.ts`). While a
  project is exported FL forces quality 4 (`ctx.rendering`).
- **Voices**: unison of up to 9 read positions (detune weights 0x370f68, pan, volume, phase), the 3-stage biquad filter (types 1..4,
  RBJ coefficients cached per filter state), the five live articulators per block (envelope, LFO, mappings at note on / per block,
  Mod X / Y tables), pitch glide ("portamento", variable time, octave fold / semitone limit), attack click removal, key -> timbre seed
  link, velocity links (volume, attack time, attack length) and FL's velocity law in single precision. The voice list keeps FL's order
  (newest first, which matters for float addition), "one voice per key" and the polyphony limit (`FPE_MaxPoly`: the newest sounding
  voice is released).
- **Effects** (Gen_Render 0x706b0): 3-band EQ (low shelf / peaking / high shelf, counted silent bands skip), chorus (TStereoFlanger),
  delay (TDelay_32FS with the three feedback kernels norm / inv / pong, tempo-synced time), reverb (TFruityReverb + libreverb, mono sum),
  halfband; the tail counter keeps the delay and reverb running (`tail` is infinite while they are on). The block size the host passes
  (`FPD_SetBlockSize`) sizes the chorus and delay rings and so changes the tails; the chunks FL calls are reproduced.
- Libm: exp / log / sin / cos are Apple's (`harmor/fx-libm.ts`), single-precision steps and fused multiply-adds (vDSP `vsma`) follow
  the binary.

## Random preset generator (`random.ts`, `randomdata.ts`)

"Generate random preset" and "Enter random preset number..." are FL's TTestPlug 0x72b00: the preset number is the seed of FL's
Mersenne twister (MT19937 whose second twist loop starts at 226 and reads the index field), and every decision is one draw
`trunc(single(single(r) * 2^-32) * n)` in the order of FL's code:

1. a template by the first draw (21/30 plain pad, 7/30 pad with plateau spectra, 2/30 resynthesis template), loaded as FL loads
   `Random pad/Default.dat` or `Default_C.dat` (state version 12, data in `randomdata.ts`);
2. the alternate-decay switch (1/4); the volume and filter envelopes, each "free" with chance 1/4 (the filter envelope also with
   alternate decay, and only for the plain pad type), a free one replaced with chance 1/3 by one of the eight `Envelopes/N.fnv` shapes;
   the filter envelope is cut after its last marker point and its levels squeezed towards 0.75, the attack scales are drawn (volume
   32..256, filter 96..256) and the keyboard mapping's last point is lowered by 0 - 50 %; then the filter order (when the envelope is
   free), cutoff 85..169 and resonance 0..112, the flat switch, portamento, the master pitch octave, unison order / pitch / phase /
   pan, timbre seed 2, a chorus (drawn, or one of 8 table presets), a reverb (one of 7 table presets), the delay switch, volume and
   mode, decay, richness; the resynthesis template instead draws its seeds, Mod Y, fullness, decay and reverb;
3. the decay and release EQ maps scattered (`0x74bc0`), the pad harmonics tool run on the impulse EQ map (and on the decay EQ map with
   alternate decay): all bins and widths randomized (`padharm.ts`, FL's `TMEHarmToolForm`), the maps stored as FL stores them;
4. the info text from nine word lists (a title, a one-to-three line description, sometimes "Computer says no").

No FL content is needed: the resynthesis template's dense map is replaced by the pad tool in every preset. The master level is 128.
The number shown to the user is the counter + 1 (1 .. 4294967296); a new FL instance starts at a random counter.

## Editor (`src/ui/plugins/gen/ogun/`)

FL's form (SynthEditorForm 560 x 640) at its coordinates: all 89 parameters on their controls, the articulator editor (envelope / LFO
curves, mappings, target and part selectors), the options menu wired to the same state fields as FL's handlers, the info memo, the
keyboard, the **Create pad harmonics** tool (a 530 x 397 dialog over the editor, undo as one step), the effect presets (unison, chorus,
reverb) and **Import FL content...**. Original drawing in FL's layout; no Image-Line artwork. "Analyze timbre..." (a WAV analysis,
0x71ef0) is shown disabled.

## Fidelity (FL 2026 vs ours, test host renders)

- **Sound: bit-exact.** Every sample of both channels equals FL's for 228 of the 229 factory presets (the 229th, a unison order outside
  the control's range, crashes FL's test host), with all effects, at 44.1 kHz and block 16; tests/gen/ogun.golden.ts pins 17 cases
  (hash of every sample plus picked samples) that cover several qualities and export mode, sample rates 22.05 / 44.1 / 48 / 96 kHz,
  blocks of 1 / 16 / 64 / 1024, tempos 60 and 130, glide, velocity links, polyphony and the polyphony limit, parameter automation at
  odd samples, random timbre seeds with a fixed clock, and long notes. Further scenario runs (177 parameter-automation
  scenarios, 32 / 88.2 / 192 kHz, voice stealing, same key twice, velocities, note pan and fine pitch, Mod X / Y) matched too.
- **Value texts: exact.** 81 parameters at every value of their range (digests of FL's sweeps in tests/gen/ogun-texts.golden.ts),
  the tempo-dependent texts in both modes. The unison / chorus order and delay mode selects show the control's caption in FL (the
  value's own text here); the LFO speed knobs' text belongs to the envelope editor (0xca2a0: Hz / tempo / harmonic by the LFO's mode) and
  shows the raw value in the parameter list.
- **Random presets: exact.** Preset numbers 1 .. 1000 produce states identical to FL's in every field (64 ints, delay and EQ bytes, info
  text, 13 articulators with all curves, 4 maps with their up to 31 000 points); tests/gen/ogun-random.golden.ts pins 37 of them
  (digests), including all three template types.
- **State reader**: matches the states FL re-saved, bit for bit, for all 229 presets (every state version they use); 2 400 damaged
  inputs raise no unexpected exception. Imported curves equal FL's.
- **Pad harmonics tool**: equal to FL's own functions run in the test host (bins, randomize / humanize sequences, 12 complete map builds
  up to 24 148 points, the window shapes).

## Approximations and what remains

- The framework turns a velocity into the channel's volume in double precision (`velocityGain`); FL's single-precision law differs by
  about 1e-8 relative. The golden harness uses FL's law; through `GenChannel` a velocity-64 note differs at that level.
- The four sines per output frame of the highest-quality resampler are `Math.sin` here and IPP's `ippsSin_64f` in FL (at most one ulp
  apart in double, visible only through single-precision rounding in rare samples).
- The first random timbre seed of a session uses the clock in seconds like FL's `RandSeed` (`setRandomCounter` fixes it for tests).
- FL's own output depends on its block structure at the single-precision level for some chains; ours is exact for the block structure
  the host passes (`setBlockSize`, the chunks of Gen_Render).
- Not ported: **Analyze timbre...** (needs WAV loading and the FFT analysis 0x71ef0), the LFO speed knobs' mode-dependent text, the INS
  tab (envelopes / filter of the channel: Ogun handles its own), MIDI learn. **Autogun** (a sibling plugin of the same code that
  generates its preset from a number) is implemented on top of this engine: docs/research/gen/autogun.md.
- A map's distances are scaled to sum to its length once, when FL reads the curve (`flstate.ts fixLength`, which the model applies to
  every curve it keeps). `OgCurve.fixLength` only normalises a curve that is really off scale (relative error above 1e-9): scaling a second
  time by the residual of the sum (2e-14 for a 27 000 point map) moved the impulse EQ table of the large pad maps by an ulp where a
  harmonic sits on a knot, and gave 1 - 5 ulp output differences in about 8 % of Autogun's presets.
