# Sawer (FL: Sawer)

Image-Line's analog-modelled saw synthesizer (`Sawer_x64.dylib`: the Delphi editor and wrapper;
`engine.dylib`: `SawerSynth` / `CSawerGenerator` on IL's C++ `CSynth` / `CVoiceGenerator` /
`CFLWrapper` framework, the code PoiZone and Toxic Biohazard share). Plugin database:
Generators > Synth classic.

**Sawer renders silence in FL's test host**: the plugin reports `DemoVersion` and its licence
check mutes it outside a registered FL. The check was neither patched nor faked, so no FL render
of Sawer exists here and none of the DSP below could be compared with FL's output. Everything
was decoded from FL 2026's arm64 code by static analysis (otool listings, constants, RTTI
vtables, normalized function matching against the PoiZone / Toxic engines whose ports are
verified sample for sample); parameters, value texts and presets come from the test host's
`info` / `sweep` (which work without sound) and FL's preset files.

Files: `src/model/gen/plugins/sawer.ts` (def), `.../sawer/{data,presets}.ts`,
`src/engine/gen/plugins/sawer.ts` + `.../sawer/{plugin,core,arp,fx,tables}.ts` (with
`../poizone/{dsp,applemath}.ts` and `../toxicbiohazard/reverb.ts`),
`src/ui/plugins/gen/sawer/{index.tsx,fldata.ts}`, `tests/gen/sawer.test.ts`.

## Parameters and state

- 202 FL parameters: the 73 synth parameters (raw 0..256, engine value = raw / 256), MIDI CC
  0..127 (raw / 256 x 127 sent as MIDI CC; CC 7, 10, 32 not passed: `CFLWrapper`, same code as
  PoiZone) and channel aftertouch (raw / 256 x 127; Sawer's modulation matrix uses it). Value
  texts are the Delphi wrapper's formats (integers round half to even, decimals half away from
  zero), equal to the test host's at all 18 761 sweep points. FL oddities kept: "Arp range"
  shows the raw value as octaves, "LFO speed" shows the free-running rate even when synced.
- State: `hidden` = engine values 73..95 (73 unused, 74 arpeggiator speed index {1/32, 1/16,
  2/16, 3/16, 1/4, 2/4, 3/4}, 75 polyphony index (4 v + 4 voices), 76 pitch-bend range, 77
  unused, 78..83 modulation amounts (amount = |2 v - 1| (2 v - 1)), 84..89 destinations
  (parameter index), 90..95 sources (0 none, 1 velocity, 2 channel aftertouch, 3 pitch wheel,
  4 + n MIDI CC n)), `ccMap` (MIDI-learn CC per engine value), `sample` (pool sample with FL's
  data.saw), view state `swKeys` (keyboard shown), `swLink` (MIDI link panel shown).
- FL's chunk: magic `1rwS` (FL also accepts `DrwS`), 96 floats, the 96-byte CC map at 388, a 128-byte name
  at 484; loading sets engine values 0..95 in order, then copies the map.
- 421 factory presets (`.fst`, data only, decoded into `presets.ts`; 48 hold NaN modulation
  sources, which FL's float-to-int conversion turns into 0 = none, as the port does). FL's
  plugin database entry is the values of "Ambient/MC Chains" with the MIDI-learn links of
  "Default" (master level = CC 7, master pan = CC 10): the insertion state.

## Engine (static port)

- CSynth layer: PoiZone's verified code (FL's functions are identical): MIDI note / CC /
  aftertouch entry points (value / 127), voice allocation among 24 generators (free, else oldest
  released, else oldest), polyphony = min(polyphony setting, host max; FPE_MaxPoly 0 = 24), mono
  / legato with glide modes (STATIC / VARI x BEND / HELD), unison 1 / 2 / 4 / 8 with detune,
  pan spread and octaver (odd voices +12), the arpeggiator (`arp.ts`, PoiZone's), CSynth's LCG
  note detune (+-1 cent), master gain (gain x 0.5 x CC 7, pan from CC 10 and Master pan,
  smoothed 0.005 per sample). After every note, CC (except 7 / 10 / 32), aftertouch and pitch
  bend the modulation matrix re-applies its destinations (value + source x amount, clamped).
- Generators render in blocks of trunc(sr / 1000) + 2 samples: per block the voice evaluates its
  amplitude envelope (one-pole: attack towards 5 x velocity clipped at 1, decay towards velocity
  x sustain, release; times 50 v^5 s, at least 1.01 ms), the filter envelope, the global LFO
  (triangle / saw / square / sample-and-hold, free 10 v^3 Hz or tempo-synced 1/16 .. 32/4, with
  per-voice attack / release fades, invert, retrigger; destinations cutoff, sync, sub phase,
  master frequency, noise, level, pan), a slow random pitch drift (+-0.01 octave, new target
  every 1024 blocks) and 24-bit phase increments at 6 x the sample rate.
- Per 6x sample: saw from table 1 (8192 points), sub oscillator from table 1 or table 2 (=
  table 1 minus table 1 half a cycle later: SQUARE) at ratio 1/4 .. 4 with phase offset, level
  and sign (INVERT), hard sync from a master phase that resets both, noise and +-3 % dither
  from the engine-wide LCG (once per output sample), DC offset -0.35, then a 4-pole ladder
  evaluated in three passes per sample with 1 / (1 + 5 x^4) saturation and resonance up to
  3.99; LP24 / LP12 / BP / HP mixes smoothed per sample; stereo gains smoothed per output
  sample. FL's NEON loop for groups of four voices has its own operation order, ported as is
  (`render4`; one voice left over uses the scalar loop `render1`).
- Decimation 6:1 through a biquad low-pass per channel, a 4 Hz 2-pole DC blocker whose single
  state FL shares between the left and right samples (kept), the effects, the arpeggiator clock
  and the master gain.
- Effects (`fx.ts`): IL's three-tape chorus (PoiZone's code, depth v^3 in float), Sawer's
  phaser (six first-order all-pass stages per channel in FL's lattice form, cosine LFO,
  cube-root feedback, smoothed centre / mix, input fade-in), the stereo tape delay (PoiZone's
  code: times in sixteenths, feedback, modulation depth, low / high cut), fxReverb (Toxic
  Biohazard's verified port: decay, high cut, damping, mix). After 2 s of output below 1e-5 the
  chain resets once and is skipped until sound returns.
- Plugin layer (`plugin.ts`): PoiZone's `CFLWrapper` port: FL voices become MIDI notes (key =
  trunc(pitch / 100), velocity = trunc(41.71426 ln(10 InitVol + 1))), per-key FinalLevels (pan
  law gains, pitch offset) copied into the engine each render call, blocks of at most 64
  samples, CC / aftertouch parameters sent when they change.

## FL's oscillator table (content)

data.saw (FL's plugin folder, 32 KB: 8192 floats spanning about -1 .. 0.22, one cycle of a
rounded analog saw) is FL content, so Orchard ships a synthesized stand-in with the same layout
(an additive, band-limited rising ramp that falls to -1, scaled like FL's). The plugin menu's
"Import FL data.saw..." reads the user's own file (exactly 8192 finite, bounded floats), packs it
into one pool sample (exact 32-bit float WAV, magic + checksum, re-read from storage when a
decoder resampled it) referenced by the state's `sample`; the engine then uses it bit for bit.

## Editor

SynthEditorForm 897 x 622 at the form's coordinates: knobs (TVectorWheel 52 / 46 / 44 / 36 px),
faders (TVectorSlider), TSwitchSelector levers (upper label = On), TVectorCheckBox section
switches, the FS_DigiWheel combos (polyphony, bend range, arpeggiator speed, the matrix's
sources ` ---` / Velocity / Aftertouch / PitchWheel / FL's CC names and destinations), the MIDI
link panel (CTRL / LINK / UNLINK / PARAM for the last touched control) and the keyboard panel
(shown by default, covering the effect and matrix rows; the toggle button at 854, 373). Labels
use the texts FL's editor code paints (LEVEL, PANNING, GLIDE MODE, SUB-SAW, FILTER ENVELOPE,
MIDI MODULATION MATRIX...). Original drawing in the form's colours; no Image-Line artwork. The
options menu holds FL's "Convert old presets" (disabled: Orchard reads every preset directly)
and the data.saw import.

## Fidelity vs FL

- Exact: parameter list, names, ranges, value texts (all sweep points), presets and insertion
  state (decoded bytes), the CSynth / arpeggiator / chorus / delay / reverb code (function for
  function identical to the verified PoiZone / Toxic ports), Apple libm calls (exp2f, exp10f,
  sincosf, cosf).
- Unverified (no FL render possible): everything specific to Sawer's DSP: generator envelopes,
  LFO, drift, oscillator / sync / sub, the ladder, filter modes, decimator, DC blocker, phaser,
  modulation matrix and the wrapper's use of them. The port follows FL's instruction order and
  float / double precision (fused multiply-adds emulated), so it should be sample-exact where
  the decoding is right, but no residual can be stated. The tests check invariants instead:
  finite deterministic output, silence without notes, voices ending after release, every
  factory preset rendering, polyphony / unison / mono / arpeggiator / matrix behaviour.
- With the stand-in table the timbre differs from FL's (FL's data.saw is not shipped); after
  the import the oscillator uses FL's exact table.

## Approximations and limits

- MIDI pitch bend never reaches Sawer from FL's channel (FL bends through the voices' pitch), so
  the bend range setting and the matrix's PitchWheel source stay at 0, as in FL.
- Speed: 6x oversampling with float rounding emulated in JavaScript costs about 1 / 5 of real
  time per 8 voices (Node, Apple M-series); 24 voices of unison-heavy presets are the worst case.
