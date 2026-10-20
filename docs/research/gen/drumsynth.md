# DrumSynth Live (FL: Fruity DrumSynth Live)

**Status: calibrated against FL 2026's renders (test host).** The DSP is a port
of FL's own wrapper and engine code; it renders FL's output bit for bit in every
tested case (both factory kits, all 48 kit patches, velocities, pan, pitch,
release, morph, mono / group cuts, overlapping voices, sends), given FL's
waveform samples. Without the import the 18 waveform samples are substitutes.

Files: `src/model/gen/plugins/drumsynth.ts` (4560 parameters, texts, kits),
`src/engine/gen/plugins/drumsynth.ts` (DSP), `src/ui/plugins/gen/drumsynth/`
(editor, FL wave import), `tests/gen/drumsynth.test.ts`.

## Sources

- `Plugins/Fruity/Generators/Fruity DrumSynth Live/`: `Fruity DrumSynth
  Live_x64.dylib` (FPC wrapper, TTestPlug: TriggerVoice 0x5f3a0, Gen_Render
  0x5f800, Voice_Release 0x5f690, Voice_Kill 0x5f6f0, ProcessParam 0x5e210
  (patch gains), patch preparation / morph 0x5ffb0, SaveRestoreState 0x5d990,
  value texts 0x5e740; editor form TSynthEditorForm 580 x 358) and
  `libDrumSynth_Eng_x64.dylib` (C++ engine, 2.4k instructions: TriggerVoice
  0x3178, Voice_Render 0x4040, Voice_Release 0x3ed4, sample rate 0x2dd4,
  constructor 0x2b48; 588 KB of int16 waveform data at 0x47bd of the arm64 slice).
- FL's manual page plugins/Fruity DrumSynth Live.htm (controls, credits: Paul
  Kellett, Frederic Vanmol, Didier Dambrin), FL's thumbnail.
- Factory kits Default.fst / Extra.fst (state version 1: 24 names and 24 x 38
  parameters, which FL's loader copies to all five 2-octave blocks, adding 48 to
  Morph To; versions < 4 turn Send track -1 into 0).
- Test host: `info` / `sweep` (all 38 parameter kinds), renders with
  `--preset`, `--param`, `--chan-pan`, `--chan-pitch`, `--mix-outs`.

## Parameters

120 patches (key = patch, C0..B9; FL's key names, 60 = C5) x 38: Patch Level,
Patch Pan, Tone Filter, Osc1 Harmonics, Osc1 Frequency, Osc1 Sweep Start (the
bandwidth in noise mode), Osc1 Sweep Time, Osc1 Envelope Decay Time, Osc1 Output
Level, Osc2 Envelope Shape, Osc2 Frequency, Osc2 Bandwidth, Osc2 Envelope Attack
Time, Osc2 Decay Time, Osc2 Output Level, Waveform Select, Wave Tuning, Waveform
Mix, Envelope Re-Trigger Count / Rate / Decay, Envelope Release Time, Osc1 Phase
Invert, DC Click At Note-On, Voice Mode, seven Vel. > mappings, Osc1 Mode, Osc1 >
Osc2 Ring Modulation, Morph To, Send level, Send track number, Morph To
Modulation. FL lists them in blocks C4..B5, C0..B3, C6..B9 (index = block x 38 +
local). Value texts (all values match FL): percentages of 128 / 127, pan
"n% left/right" (half-even rounding) / "Centered", times exp(9.210341 v / 127)
ms ("%.1f", Sweep Time 127 "Off"), attack / rate exp(8.5169 v / 127 - 2.3022),
tuning v x 0.24 semitones, "Off" for level 0, release >= 0.95 and Vel. > Osc1
Harmonics 0, click > 90 "Random", send track 0 "None", wave names.

A new instance gets the Default kit (FL's Default.fst; the plugin's own
constructor state differs only in Send track -1 and the Morph To targets).

## DSP [C: FL's code, verified sample by sample]

Wrapper, per note (TVoiceParams_Old: integer pan / pitch):
- patch = (InitLevels.Pitch + 50) / 100; Voice Mode: Mono marks the patch's
  previous mono voices cut, Group n marks every voice of group n, Poly nothing.
- Engine parameters from the patch: Level fixed to 45000 (the level is the
  wrapper's), params 2..33 from the patch morphed toward Morph To (when it is
  another patch) by m = curve(Morph To Modulation / 128): 1.6x - 0.3, above 0.9:
  0.4x + 0.6, below 0.1: 0.4x; v = rint(v + m (target - v)); NO WAVE -> 128.
- The pitch handed to the engine: FinalLevels.Pitch - (InitLevels.Pitch - 6000)
  (channel pitch, fine tune, not the key).
- Gen_Render: each voice renders mono into a buffer (in list order: the engine's
  noise generator is shared), then FL's AddWave ramp mixes it into the
  channel's track with ComputeLRVol_Old(patch pan + note pan, note volume x
  LogVol(level / 128)) and, when Send track != 0, into track (channel track +
  Send track) with x LogVol(send / 128); the first block starts at its gains,
  later blocks ramp (at most 0.001 x 44100 / rate per sample). Cut voices ramp to
  0 and are dropped; finished voices are dropped after the block; FL's voice
  list removes by moving its last voice into the hole (render order).
Engine:
- Noise: FL's LCG x = x * 0x0bb38435 + 0x3619636b (state shared by the
  instance's voices, seeded 0x...fff9f854 from FL's wave data), the low 23 bits
  as a float in [-1, 1), x (1.0001 - wave mix) x sqrt(rate) / 210; waveform:
  FL's 22.05 kHz samples, 20.12 fixed-point read with 7-bit linear
  interpolation and loops, x 3 wave mix, step 22050 / rate x 2^(pitch / 12) x
  exp(ln 4 tune + velocity term), at most 8.
- Osc 1: swept tone = an undamped two-pole resonator started at (click, click^3
  - 1), coefficient w - 0.04 w^3 gliding from the sweep start to the frequency;
  noise band = the same structure damped (bandwidth) on the noise. Frequencies
  floor(16 e^(x ln 1000)) Hz (x 2^(pitch / 12), at most 16 kHz). Harmonics: an
  asymmetric quadratic shaper; envelope decaying to 1e-5.
- Osc 2: band-passed noise / sample (the same filter), attack ramp, decay toward
  a negative target (shape), x (1 + ring (osc1 - 1)).
- Re-trigger envelope, release (Voice_Release: decays x (0.5 + 0.5 release)),
  clip to +-1, tone filter (one-pole low-pass 20 e^(14 t) Hz, or high-pass), gain
  2 x note volume x curve(45000) (so the level follows the note volume
  squared, as measured).
- The voice ends when no re-trigger is left and both envelopes are below 1e-4
  (checked per block).

## FL content (not shipped)

FL's engine embeds 293174 int16 samples (808 / 606 / 909 / Linn / "Real" drum
sounds). The default is a deterministic synthesized substitute at FL's positions
and lengths (noise / metallic / tone with decays). The options menu item
"Import FL DrumSynth waves..." reads the user's `libDrumSynth_Eng_x64` (or any
file holding the block), finds the block by FL's own checksum, and stores it in
the project's pool (`wavesSample`). Patches using waves (Default kit: 808
Cowbell, Hat, Ride, 909 Crash, Hats, Ride; Extra: 15) differ without it.

## Editor

FL's form at its coordinates: WAVE (wave spinner, velocity / tune / mix), TRIG
(voice mode spinner, count / rate / decay, velocity / tone / click), OSC 1
(velocity, frequency and sweep / bandwidth sliders, harmonics, decay, sweep,
NOISE and INVERT switches, velocity, mix), OSC 2 (velocity, frequency and
bandwidth sliders, ring, attack, decay, shape, release, velocity, mix), MAIN
OUT (pan, vol), SEND TO (track number spinner, level), SELECTED (patch list),
MORPH TO (patch list, modulation strip), the two-octave patch keyboard (click:
select and play; right-click: copy / paste, set to a default patch; bank
buttons, AUTO follows the played notes). Original drawing in the form's colours.

## Fidelity (FL vs ours, 44.1 kHz, with FL's waves)

| Case | Residual |
|---|---|
| Default kit, 24 patches (C4..B5), 0.5 s notes | bit-exact (17), tail end only -85 ... -100 dB (7) |
| Extra kit, 24 patches | bit-exact (23), -120 dB (1) |
| velocities 64 / 127 / 128, pan, channel pitch +700 / -300 | bit-exact / -98 dB (tails) |
| short notes (release), morph (3 settings, 2 patches) | bit-exact |
| mono cut, group cut, 3-5 overlapping voices, sends (`--mix-outs`) | bit-exact ... -135 dB |

- "Tail end": where a finished voice is cut depends on the host's block
  boundaries (FL's test host restarts its 512-frame grid at every note event;
  with the same grid the tails are exact too).
- Approximate: the 18 waves without the import; after a project reload the
  imported block is decoded by the browser (exact at a 44.1 kHz decode rate,
  re-interpolated otherwise); levels after a note off are no longer updated by
  the channel ('events' plugins).
