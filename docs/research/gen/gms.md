# GMS (FL: GMS, Groove Machine Synth)

Image-Line's Groove Machine synth (`GMS_x64.dylib`: `GMSynth` / `GMSynthVoice` on IL's C++
`CSynth` / `CVoiceGenerator` framework with an older `CFLWrapper`, the bitmap editor
`GMSynthEditor` on IL's `CControl*` classes, `FXControl` effects, IL's fxReverb). Plugin
database: Generators > Synth classic.

**GMS renders silence in FL's test host**: it reports `DemoVersion` and its licence check
mutes it outside a registered FL. The check was neither patched nor faked, so no FL render of
GMS exists here and none of the DSP below could be compared with FL's output. Everything was
decoded from FL 2026's arm64 code by static analysis (otool listings, constants, RTTI vtables,
function matching against the verified PoiZone / Toxic / Sawer ports, a static interpreter for
the editor construction code); parameters and value texts come from the test host's `info` /
`sweep`, which work without sound, and FL's preset files.

Files: `src/model/gen/plugins/gms.ts` (def), `.../gms/{data,presets}.ts`,
`src/engine/gen/plugins/gms.ts` + `.../gms/{plugin,core,fx,tape,waves}.ts` (with
`../poizone/{dsp,applemath}.ts`, `../toxicbiohazard/reverb.ts`),
`src/ui/plugins/gen/gms/{index.tsx,flwaves.ts}`, `tests/gen/gms.test.ts`.

## Parameters and state

- The engine has 212 internal values (FL 0x157f4 / 0x15da0): 0..11 channel (mix level, pan,
  pitch, note length, amp ADSR, amp level, shuffle, slide time / enable), 12..15 filter, 16..25
  the two envelopes (amount, invert, attack, decay, destination; pairs), 26..39 the two LFOs
  (retrig, amount, invert, shape, rate, sync, destination), 40..60 synth (mono, unison voices /
  detune / stereo / phase / phase retrig, octave, noise, mix osc 2 / 3, modulation amount / kind,
  osc 2 phase / retrig / invert, osc pitch / fine x3), 117..186 per effect X, Y, LFO rate, glue,
  LFO shape, LFO sync, LFO amount, 197 MIDI / EQ screen, 198..205 MIDI routing (velocity /
  mod wheel / aftertouch amount and destination, velocity to level, bend range), 206..211 EQ.
  Note length, shuffle and 61..116 are not used by the DSP.
- FL's 205 parameters (76 synth, MIDI CC 0..127, channel aftertouch) view them (FL 0x17a44):
  channel / filter / synth parameters map to fixed values; envelope, LFO and FX parameters edit
  the selected envelope, LFO or effect; "Envelope Number" / "LFO Number" select; "FX 1..10",
  "FX Activate" and the "... Switch" parameters reach nothing. Values are raw / 256 (FL's
  `CFLWrapper`), CC parameters send MIDI CC (raw / 256 x 127, not 7 / 10 / 32), aftertouch the
  channel pressure. Value texts: FL's C formats (ties to even, a trailing space; the current
  value, so unmapped parameters always read "0.00 % "), equal to all 19 532 sweep points.
- State: `iv`, `sel` (selected effect, envelope, LFO), `waves` (the three oscillators' wave file
  names), `wavePool` (imported waves by name), view state `fxHold` (X / Y pad held). The FL
  parameter values mirror the internal values they view; the editor writes edited views back
  before changing a selection, and on load an internal value is replaced only when its FL
  parameter was edited (its raw value differs from FL's readback), so presets keep their exact
  floats.
- FL's chunk (`4nyS`, old `3nyS`, demo `ED4S`): three 512-byte wave paths, the selections (v4),
  212 floats, the name. 306 factory presets (.gmsynth, data only, decoded into `presets.ts`;
  some hold uninitialised values from Groove Machine, kept: e.g. 13 presets switch the EQ on
  that way). FL's plugin database entry (the insertion state) is "Agressive TE" with the
  Beast / Sine / Saw waves, phaser and reverb glued.

## Engine (static port)

- Notes (FL 0x19f0c / 0x1a3ac): 99 voices, polyphony min(99, host max; FL sends FPE_MaxPoly
  16, GMS's DefPoly): the last free voice of the first n, else the oldest; mono plays voice 0;
  note off releases every voice of the key. Voice pitch = key + channel pitch (+-24) + octave
  (-2..+2) ; slide glides towards it (time 2 t^3 s) from the previous note when enabled.
- Envelopes (per sample, one-pole): amplitude ADSR (attack towards 5 until 1, 50 a^3 s; decay
  towards sustain, 50 d^4 s; release 25 (0.55 r + 0.1)^3 s; the voice ends below 1e-4); two
  attack / decay envelopes (towards 5 until 1, then to 0; 300 a^5 / 70 (0.8 d + 0.2)^5 s).
  Destinations: cutoff, modulation amount, pitch (x 24 semitones), the same-numbered LFO's
  amount. Two global LFOs (sine bipolar, triangle / saw down / square unipolar; free 0.01..25 Hz
  or 1/8 beat .. 8 bars, phase locked to the song while the host plays unless retriggered):
  cutoff, modulation amount, pitch (x 12), amplitude. MIDI velocity / mod wheel / aftertouch add
  (2 amount - 1) x source to one internal value each (FL 0x19d78).
- Oscillators (FL 0x1a498 / 0x1aeb8): up to 16 unison voices (detune 2^(0.16 d^2 (u / (n - 1)
  - 1 / 2)), stereo spread, start phases from the unison phase or random), three 32-bit phase
  accumulators per unison voice reading the wave tables at the level for their frequency, the
  table index dithered by the global LCG (also the noise); oscillator 1 hard-synced to a master
  at its pitch (ratio 1 + 3 x amount), frequency-modulated (15 x amount x osc 2) or ring-
  modulated (3 x amount) by oscillator 2 (invertible, phase offset, optional random restart);
  mix weights (1 - n)(1 - m3)(1 - m2) / (1 - n)(1 - m3) m2 / (1 - n) m3 / n (squared knobs),
  0.005 / (1 + 0.15 (n - 1)) per unison voice, the per-key pan gains, amplitude envelope^2.
- Wave tables (FL 0x17270): the wave (channel 0) resampled to 1024 points with 4-point Hermite
  interpolation, its spectrum (vDSP complex FFT: magnitude / 1024, phase), 512 levels of
  cumulative cosine sums (level k = harmonics 1..k + 1, half the wave's amplitude, DC dropped);
  level trunc(sr / 2f) is used.
- Filter (FL 0x18580): per voice and channel a 4-pole ladder run four times per sample with
  x / (1 + 0.04 x^2) input saturation and feedback k x resonance; g and k from a 65536-entry
  table of the cutoff (g = 2^(9.77 c) x 0.0005, k = (5 + 7.5 g) x 0.7565); LP / BP (stage 3 -
  4) / HP (input - stage 4); cutoff = smoothed knob + key tracking ((pitch - 57) / 128 x kbd) +
  modulation; then the voice level (dB(50 v - 25) x 200, x velocity when routed).
- Effects (`fx.ts`, FL 0x7828 ..): processed in order, each with bypass fade (0.01 per sample)
  and its LFO (rate in beats, x 4 for bars, phase from the song position while playing):
  distortion (x (512 d + 0.5) / (1024 d |x| + 1), d = (X + lfo)^4, low-pass 2^(4.28 Y + 10) Hz),
  crusher (sample hold of 64 (1 - X + lfo)^2 + 3 samples, same low-pass), flanger (three
  cascaded 2 ms tapes per side, feedback -Y / 2), phaser (six all-passes per side in FL's
  lattice, 50..20 kHz, feedback cbrt(0.6 Y) x 0.98), low pass / high pass (three RBJ sections,
  2^(8.28 v + 6) / 2^(7.42 v + 5) Hz, Q 1 + 2 Y^2), delay (1.5 s tapes, time 2/3 of the LFO
  period, feedback X^2, record filter from Y; added to the input), reverb (IL's fxReverb, the
  Toxic Biohazard port: decay 0.75 X^3, damping Y^2, wet 0.5 + 0.225 X^3, no dry, ER muted: the
  effect replaces the signal while it rings), panner (2 ms binaural tapes and level from the pan
  position), trancer (gate envelope per LFO cycle: 1 % attack, release 1 + 50 (1 - X)^2). While
  no voice sounds, an effect is forced to bypass unless one before it is still active. Then
  the five-band EQ (80 / 220 / 1200 / 6000 / 12000 Hz, +-12 dB, PoiZone's RBJ shelf / peak
  class) when enabled, the channel level (-60..+20 dB) and pan ([1 - p, p], at least 1e-4,
  smoothed 0.01 per sample).
- Plugin layer: FL voices become MIDI notes (key = trunc(pitch / 100), velocity = trunc(41.71426
  ln(10 InitVol + 1))), per-key FinalLevels each render call, blocks of at most 508 samples.

## FL's Synth Waves (content)

The 29 single-cycle waves in FL's GMS folder (Beast .. Vocal, 1024 frames, 16-bit or float) are
FL content: Orchard synthesizes stand-ins under the same names (exact sine / saw / square /
triangle shapes, others as deterministic spectra), so the timbre of most presets differs until
the user imports FL's files ("Import FL Synth Waves..." picks the folder; "Load Waveform..."
loads any wave file into one oscillator, as GMS does). Imported waves are packed exactly into
pool samples (`wavePool`), re-read from storage when a decoder resampled them.

## Editor

964 x 414: the 964 x 389 skin plus room for FL's program bar (the control positions reach y = 414). Every control at the position
FL's construction code gives it (0x26f70, run in a static interpreter: knobs, faders, numbers,
menus, state selectors, buttons, the X / Y pad, meters): the synth screen (wave menus with
arrows, osc pitch / fine, modulation kind and amount, mix, phase, unison, octave, mono) or the
MIDI / EQ screen (internal value 197, as in FL), filter / envelope / LFO faders with their
switches and state rows, the channel column, the ten effect buttons with glue LEDs, the X / Y
pad (dragging sets X / Y, pressing activates the selected effect), X / Y knobs, glue and the
effect LFO. The envelope / LFO number tabs are placed by hand (they come from code the
interpreter does not reach). Original drawing; no Image-Line artwork.

## Fidelity vs FL

- Exact: parameter list, names, value texts (all sweep points), the FL-parameter mapping,
  presets and insertion state (decoded bytes), MIDI / velocity conversion, the CSynth MIDI
  entry points, Apple libm calls (exp2f, exp10f), the reverb's parameter laws.
- Unverified (no FL render possible): all of GMS's DSP. The port follows FL's instruction order
  and float precision where practical, but: the wave tables use a double-precision DFT where FL
  uses vDSP's float FFT (tables differ in the last bits); the reverb is the Toxic Biohazard build
  of fxReverb (same parameter laws, process not byte-identical); fused multiply-adds are
  emulated in double. Expect close but not sample-identical output even with FL's waves.
- With the stand-in waves the timbre differs from FL's.

## Limits

- MIDI pitch bend and the mod wheel only reach GMS through FL's CC parameters (mod wheel = CC 1);
  the editor's program bar, preset browser and about box are not reproduced (Orchard's preset
  menu lists the factory presets); the level meters are not drawn.
