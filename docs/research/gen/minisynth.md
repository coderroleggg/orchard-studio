# MiniSynth (FL: MiniSynth)

FL Studio Mobile's subtractive synth, shipped in FL as a C++ plugin
(`Plugins/Fruity/Generators/MiniSynth/MiniSynth_x64.dylib`, 726 KB, no symbols,
RTTI names kept; `oscdata.dat` 8 KB; a bitmap editor in `Artwork/*.tga`),
Plugin database > Generators > Synth classic.

Sources: the arm64 slice of the binary (`otool -tV`; addresses below), lldb on
FL's test host (`flfxhost`, scratchpad fx/host) for run-time state (sub-block
sizes, the noise seed, call stacks), `flfxhost info / sweep / render` for
names, value texts and renders, the factory preset files, and FL's plugin
database state `Plugin database/Generators/Synth classic/MiniSynth.fst`.

Our port is FL's code in FL's precision. With FL's own oscillator data (a
research-only check, never shipped) it renders all 92 factory presets and 33
behaviour cases **bit for bit** like FL's plugin; with the shipped oscillator
data (our model of FL's waveform, see Oscillator tables) the error is -111 to
-125 dB (median -117 dB, max abs 9e-6). See Fidelity.

## Architecture

Two layers, both ported:

1. **FL's C++ plugin wrapper** (class `CPluginWrapper` / `TFruityPlug`, VMT at
   0x47588: GetName 0x2cf6c, ProcessEvent 0x2d1a8, ProcessParam 0x2d244,
   Gen_Render 0x2e584, TriggerVoice 0x2e688, Voice_Release 0x2e798, Voice_Kill
   0x2e7bc, MIDIIn 0x2eb14). It turns FL's voices into MIDI notes for the synth:
   - TriggerVoice: key = trunc(InitLevels.Pitch x 0.01) (clamped 0..127; one FL
     voice per key, a new note on a key whose slot holds another FL voice sends
     that key a note off and kills the old FL voice), velocity =
     trunc(logf(fma(InitLevels.Vol, 10, 1)) x 41.71426f) clamped 0..127 (= the
     FL velocity, 128 -> 127; 0x34f28), then `FPV_SetLinkVelocity(0)` (FL leaves
     velocity out of FinalLevels.Vol) and the synth's note on (velocity / 127).
   - Voice_Release and Voice_Kill (FL's polyphony limit): the synth's note off;
     the synth plays its release. The FL voice stays in its key slot.
   - Gen_Render, per call: (a) every key with an FL voice gets the synth's
     per-key levels from FinalLevels (0x2d8c4): gains L / R = FL's ComputeLRVol
     (pan, vol) (FL's pan law, float), pitch offset =
     f32(FinalLevels.Pitch x 0.01 + 60 - key) semitones (channel pitch, fine
     pitch, slides), FCut = Mod X, FRes = Mod Y; keys without an FL voice take
     the values of the last voiced key below them (keys below the first voiced
     key take its values); (b) the synth renders in chunks of at most 512
     frames (its 516-frame buffer minus 4); (c) FL voices whose key no synth
     voice rendered in this call and whose MIDI note is off are killed
     (`Voice_Kill`).
   - Parameters 0..42: FL's integer / 256 -> the synth's float (clamped 0..1);
     REC_GetValue returns trunc(float x 256). GetName: the synth's text + " " +
     unit (empty), hence the trailing space. 43..170 = "MIDI CC 0..127", 171 =
     "Chn. Aftertouch": the wrapper keeps value / 256 and sends
     trunc(value x 127) as a MIDI controller (CC 7, 10 and 32 are not sent);
     the synth only uses CC 1 (mod wheel). Text "%d" of trunc(value x 127).
   - FPE_Tempo -> the synth's tempo, FPE_MaxPoly -> its POLY voice count
     (0 = 99), FPD_SetPlaying -> transport sync of the LFO and phaser,
     FHD_GetMixingTime (beats) -> the song position at each call,
     FPD_SetSampleRate -> setSampleRate only when the rate changes, FPD_Flush ->
     setSampleRate(0) (a full reset).
2. **The synth** (`MiniSynthInstance`, 0x40c0 bytes, VMT 0x47be8; voices of
   0x220 bytes, VMT 0x46d98). Constructor 0x35058, setParam 0x36290, value
   texts 0x35c0c, note handler 0x36c40, setSampleRate 0x36ecc, process 0x37c80,
   voice: reset 0x2564c, note on 0x2575c, release 0x257a0, per-block controls
   0x2607c, oscillator setup 0x25be4, filter setup 0x257c8, render 0x26280;
   effects: distortion 0x375b8, delay 0x37a64, phaser 0x371a8, chorus 0x377cc.

## Parameters (FL's list: 172)

Control values 0..256 (FL's integer), stored continuous so that preset floats
stay exact (value = float x 256). Internal mapping (setParam 0x36290, f = value
/ 256 as float; trunc = toward zero):

| # | Name | Internal | FL text |
|---|---|---|---|
| 0 | Voices Mode | trunc(2f): POLY / MONO / LEAD | `POLY ` `MONO ` `LEAD ` |
| 1 | Transpose | trunc(fma(f, 24, -12)) semitones | `-12 `..`12 ` |
| 2 | Slide Time | slide coefficient 0.01 + 0.9 (1 - f)^4 per sub-block | `%.1f ` of f x 100 |
| 3 | MW Dest | trunc(f): Filter / LFO | `Filter ` `LFO ` |
| 4 | MW Amount | f | percent |
| 5 | OSC Kind | trunc(9f): SAW, SAW+SAW, PULSE, SQR+SAW, SQR+SQR, SUPERSAW, BELL, DEAF SAW, SAW SPREAD, SAW SPREAD 2 | the kind name |
| 6 | OSC Mod | f | percent |
| 7 | OSC Noise | f^2 | percent |
| 8 / 9 | FLT Freq / Peak | f / f x 0.99 | percent |
| 10 / 11 | FLT Kbd / Vel | f | percent |
| 12..15 | EGF Atk / Dec / Sus / Rel | rates (below), sustain f | percent |
| 16 | EGF Amnt | 2f - 1 (env range +-10 octaves) | `%.1f ` of 200f - 100 |
| 17 | LFO Shape | trunc(2f): SINE, SAW (1 - 2 phase), SQUARE | `SINE ` `SAW ` `SQUARE ` |
| 18 | LFO Dest | trunc(2f): FLT (+-4 oct), FRQ (+-12 st), OSCMOD (mod +- 12) | `FLT ` `FRQ ` `OSCMOD ` |
| 19 | LFO Rate | period 0.25, 0.375, 0.5, 0.75, 1, 2, 4, 8, 16, 64, 128, 256 beats (trunc(11f)) | `1/4 `..`16/1 `, `4 Bars `, `8 Bars `, `16 bars ` |
| 20 | LFO Amnt | a = 2f - 1, the LFO is scaled by a^2 with a's sign | `%.1f ` of 200f - 100 |
| 21..24 | AMP Atk / Dec / Sus / Rel | rates, sustain f | percent |
| 25 | DIST | on when f != 0 | percent |
| 26 / 27 | Overdrive / Decimator | drive 20 f^2; hold trunc(64 min(f^2, 1)) samples | percent |
| 28 | DELAY | on when f != 0 | percent |
| 29 | DELAY Time | 0.25, 0.5, 0.75, 1 beat (trunc(3f)) | `1/4 ` `2/4 ` `3/4 ` `1/1 ` |
| 30..32 | DELAY Fdbk / Filter / Mix | f / lowpass 0.99 f + 0.01 / f^2 | percent |
| 33 | CHORUS | on when f != 0 | percent |
| 34..36 | CHORUS ModRate / ModDepth / Mix | 4 f^2 Hz (+0.2 / +0.25 Hz L / R) / 0.36 f + 0.04 / f^2 | percent |
| 37 | PHASER | on when f != 0 | percent |
| 38 | PHASER ModSpeed | the LFO Rate steps (float) | as LFO Rate |
| 39..42 | PHASER ModWidth / Fdbk / Mix / Freq | 0.5 f^3 / 0.98 cbrt(f) / f / f^2 | percent |
| 43..171 | MIDI CC 0..127, Chn. Aftertouch | CC 1 = mod wheel trunc(127 f) / 127 | `%d` of trunc(127 f) |

"percent" = C's `%.1f` of f32(f x 100) plus a space (ties to even: 16 ->
`6.2 `, 48 -> `18.8 `). All 11822 texts of `flfxhost sweep` (43 parameters and
CC 0 / 1 / aftertouch, 0..256) match. Envelope rates (per sample, not
sample-rate dependent, as FL): attack `4e-7 / d`, decay / release `4e-6 / d`
with d = (0.95 f + 0.05)^4, rate 1 when f < 0.001 or d x 500 (attack) / d x 50
< 0.001; AMP Rel applies 0.95 f + 0.05 twice and multiplies the rate by 10
(FL's code). `def` = the synth's default table (getDefault 0x40e44).

## Presets and the fresh state

- 92 factory presets: `Plugin presets/Generators/MiniSynth/Default.fst`
  ("Default") and 91 FL Studio Mobile presets in its Default folder (`.flms`:
  `\x99FLS` or `\x99FLM` + HEAD (name, UTF-16) + DATA ("0rev" + 43 floats); the
  synth's loader 0x3821c reads the floats without checking the magic). In the
  def as "Default" and "Default/<file name>" with FL's exact floats.
- Constructor state: the synth sets its default table, then its preset
  library loads the first preset, "Bass Almost Sine" (what `flfxhost info`
  shows).
- FL's plugin database state (`Plugin database/.../MiniSynth.fst`, "Default",
  = `Default/Default.flms`: AMP Atk 0.02, AMP Rel 0.05) is what FL loads when the
  plugin is added from the plugin database or the channel rack menu: our fresh
  instance (`def.state()`). The Plugin presets "Default" (Default.fst) differs
  only in AMP Atk / Rel 0.
- No channel presets for MiniSynth (`Channel presets`: 0).

## DSP (exact)

All quantities float32 where FL stores floats, double where FL computes in
double; FL's fused multiply-adds are noted.

**Process (0x37c80)**, per Gen_Render chunk: sub-blocks of at most 32 samples.
Per sub-block: the LFO value from the current phase (sine `f32(sin(2 pi
phase))`, saw `1 - 2 phase`, square `+-1`), scaled by a^2 with a = LFO Amnt
(+ MW Amount x mod wheel when MW Dest = LFO; the clamp tests a, FL's code), then
the phase moves: with the transport playing `phase = position / rate`
(position at the sub-block start: the value used lags one sub-block),
otherwise `phase += n tempo / (rate x 60 x sr)`; then every active voice in
index order 0..98 (per-block controls, then its samples into the sub-block
buffer), then distortion, delay, phaser, chorus on the sum. Effects are skipped
only until the first voice has played after a reset (FL's idle counter never
reaches its half-second limit while a process call keeps the flag set).

**Note handler (0x36c40)**: held velocities per key. POLY: the last free voice
among the first maxPoly (FL's FPE_MaxPoly; 0 = 99; nothing plays in POLY mode
before FL sends it), else the one with the lowest age. MONO and LEAD always use
voice 0. Every note on starts its slide from the previously played key (also in
POLY); LEAD starts at the key itself when no other key is held. Note on with
LEAD and a held voice does not retrigger. Note off: POLY / MONO release every
voice on the key; LEAD hands the voice to the highest held key below, else the
lowest above (no retrigger, it slides), else releases.

**Global noise generator**: one static 32-bit LCG (x 0x0bb38435 + 0x3619636b,
seed 0 at load) shared by every voice and every MiniSynth instance in the
process. A voice reset draws 8 x 256 numbers (its 8 oscillator phases);
FL's start-up resets all 99 voices 3 times (constructor, the preset library's
setSampleRate(0) at 0x3131c, the wrapper's setSampleRate(44100) at 0x2c29c;
a 4th time when the host rate is not 44.1 kHz), so the first render starts at
seed 0x43b9a800 (48 kHz: 0x484ce000), as lldb shows. A voice that finishes
resets itself (2048 more numbers). Per sub-block each voice draws one number
(drift) and one per sample (noise, phase dither).

**Voice per-block controls (0x2607c)**: gain targets = key gains x velocity
(0 once the amp envelope is released and below 1e-5); smoothed gains start at
the targets; a released voice whose targets and smoothed gains are below 1e-5
resets (ends). Drift: `drift += (noise - drift) x 0.01`. Slide: `slide += (key
- slide) x slideCoef`. Pitch (semitones) = fma(drift, 0.08, slide +
transpose) + bend (MIDI only) + 12 LFO (FRQ) + the key's pitch offset;
frequency = 220 x 2^(pitch/12 - 4.75) (MIDI key 69 = 440 Hz: FL's key 60 plays
261.63 Hz).

**Oscillators (0x25be4)**: up to 8 phase accumulators (uint32, increments
trunc(f x (2^32 - 1) / sr)), gains, and one table pointer: every oscillator
reads oscillator 0's table (FL's code). Kinds (mod = OSC Mod, + 12 LFO for
OSCMOD): SAW = saw(p) - saw(p + d) + saw(p), d = (1 - |mod|) cycle (one
oscillator when d = 0); SAW+SAW = saw + saw x 2^(trunc((2 mod - 1) x 12)/12 +
0.00625); PULSE = saw(p) - saw(p + d); SQR+SAW = square + transposed saw;
SQR+SQR = two 56 % pulses (offset 0x8fffffff), the second transposed;
SUPERSAW = 8 saws x 0.5 at f (1 + c mod), c = -5, -3.75, -2.5, -1.25, 0, 1.25,
2.5, 3.75 %; BELL = 6 saws x 0.5 at phase offsets j |mod| / 2; DEAF SAW =
saw(p) + saw(p + d); SAW SPREAD = f (0.5 - 0.005 mod) + f + f (2 + 0.02 mod);
SAW SPREAD 2 = f (1.5 - 0.015 mod) + f + f (2 + 0.02 mod). Phases tied to
oscillator 0 are reset every sub-block. Sample = table[((seed & 0x3fffff) +
phase) >> 21] (a dithered lookup without interpolation, the seed just drawn).

**Oscillator tables**: 1024 tables of 2048 floats, table 1023 - h = harmonics
1..h+1 accumulated in float (constructor 0x35130). Harmonic data: FL's
`oscdata.dat` (1024 amplitudes, 1024 phases). Our data comes from our model
of that waveform (not a copy of the file): a naive 2048-point ramp-down saw
s[n] = 0.5 - (n + 0.5)/2048 mixed with the same saw through a one-pole lowpass
(periodic steady state), `w = 0.43490 s + 0.56510 lp(s)`, lowpass coefficient
0.0074999627 (fitted), analysed like FL's data (2|X_k|/N also at the Nyquist
bin, phase arg X_k). It reproduces FL's table waveform to -117 dB (max 8e-7;
the residual is the float noise of FL's own analysis plus a small low-harmonic
mismatch).

**Filter (0x257c8 per sub-block, 0x26280 per sample)**: cutoff (octaves) =
fma(fma(drift, 0.01, Freq), 10.3, 4) + Kbd (pitch/12 - 4) + 14 Vel (velocity -
0.5) + 4 LFO (FLT) + 4 MW (Filter) + the key's Mod X; base = 2^c, top =
2^(c + 10 EGF Amnt), cutoff Hz = base + (top - base) x filter envelope, <=
20000; g = clamp(cutoff / (sr x 655.36), 0, 1); feedback k = -4.05 x
clamp(Peak x 0.99 + Mod Y, 0, 1). A 4-stage cascade ladder (stage i: s_i +=
g (s_{i-1}' - s_i), stage 1 input x + k s_4) is discretised by squaring its
4 x 5 state matrix [A | B] 12 times (A^4096: 4096 fine steps per sample),
transcribed in FL's operation order (loop 0x259bc). Per sample: x = (0.2 in +
0.07) x amp envelope (the 0.07 offset passes the amp envelope as a thump that
the DC tracker removes), r = M [s; x]; the first stage saturates, s1 = r /
(1 + r^2); out = row 3; y = 4.99999993 out - dc, dc += (4.99999993 out - dc) x
0.005 (float). Output: L += y x gL, R += y x gR, gains smoothed by 0.005 per
sample toward their targets.

**Envelopes** (per sample, float, fused): value += (target - value) x rate;
attack target 4, decay when above 1 (target sustain), release target 0. A note
on resets the filter envelope to 0 (the amp envelope continues from its value).

**Effects**: distortion (on with DIST != 0): x >= 0: y = 1 - (1 - x) 10^(-20
od^2 x), x < 0: y = (1 + x) 10^(20 od^2 x) - 1, times 0.3 + 0.7 (1 - 1.25
od^2)^8 (float), then the decimator's sample hold. FL gets 10^x from macOS's
`__exp10f` (libsystem_m: 128-entry 2^(j/128) table and a quadratic), which
differs from the correctly rounded value in 0.6 % of inputs; we port that
algorithm. Delay (1.5 s buffer, mono L + R in): length = beats x 40 / tempo of
the buffer, halved until it fits; per sample lp = lp + (fdbk x buf + 1e-30 -
lp) x (0.99 filter + 0.01), buf = in + lp, out += Mix^2 x lp on both sides (the
delay outputs only its feedback path: no echo at Fdbk 0). Phaser: 6 first-order
allpasses per side, coefficient from (smoothed Freq^2 + width (1 +- cos LFO))
mapped to 50 / sr .. 20000 / sr, feedback 0.98 cbrt(Fdbk), output added x Mix,
LFO phase (float) synced to the position while playing. Chorus: 10 ms mono
buffer, left tap at (0.5 + depth sin)^2 x depth x 10 ms, right tap at 0.5 +
depth sin samples (FL's code: a crossfade with the 10 ms old sample), LFO
phases start at 0.62 / 0.1, added x Mix^2.

## Our implementation

- `src/model/gen/plugins/minisynth.ts` (def), `minisynth/presets.ts`
  (FL's preset floats, generated from FL's files).
- `src/engine/gen/plugins/minisynth.ts`: FL's wrapper as an `'events'`
  plugin (the synth manages its own voices): note events at their frames
  split the render call; each call between events is one Gen_Render call (FL
  at the engine's block size, notes splitting blocks at their sample);
  per-key levels from the notes' live levels (snapshotted while the note
  object still belongs to the note), FL's kill rule, MIDI velocity, CC 1;
  at the same frame note offs are applied before note ons (FL's host order:
  back-to-back LEAD notes retrigger, they are not legato).
- `src/engine/gen/plugins/minisynth/core.ts`: the synth (voices, LFO, effects,
  global LCG shared by all instances like FL's static); `tables.ts`: the
  waveform model and FL's table build (8 MB, built once per process, ~20 ms).
- Fused multiply-adds: float ones (`fmadd s`) are exact (double product plus
  FL's single rounding, midpoint-checked); double ones are computed unfused by
  default (1.6 % CPU for 8 voices with effects at 44.1 kHz vs 8 % exact);
  `miniSynthExact(true)` emulates them exactly (Dekker product, two-sum) for
  bit-exact research renders. The difference shows only near zero crossings
  (1 ulp, below -150 dB) and below the table model's error.
- POLY voice count: the channel's max polyphony (FL's FPE_MaxPoly, sent by
  GenChannel when the plugin is loaded and on every change; DefPoly 8, 0 = 99).

## Fidelity (FL's plugin through flfxhost vs ours through GenChannel)

Harness: FL's partition (blocks of 128 restarting at note events), 0.25 s
preroll with the transport stopped, song position advancing, FPE_MaxPoly 8,
44.1 kHz unless noted.

- **Port check with FL's oscillator data** (loaded from FL's installation in
  the scratchpad harness only) and exact fused operations: all 92 factory
  presets (3 overlapping notes, 1 s) bit-exact; every parameter at 0 / 77 /
  256 over a base with all effects on (129 renders) bit-exact; 34 of 35
  behaviour cases bit-exact
  (POLY / MONO / LEAD with slide and overlapping or back-to-back notes, voice
  stealing, the same key twice, a note after a finished tail, 12 notes over FL's polyphony
  8, velocities 40 / 128, note pan / fine pitch, keys 24 / 108, resonant filter
  envelope, amp envelope, the three LFO shapes and destinations at 130 / 97
  BPM, delay at 130 / 87 BPM, chorus, phaser at 130 / 150 BPM, distortion with
  decimator, mod wheel, 48 kHz, parameter changes during notes, channel pitch,
  pan and volume, LEAD / MONO key changes with different pans); the 35th,
  a channel volume step to 40 % (-145 dB: our shared channel volume law is
  computed in double, FL's in float).
- **Shipped (model oscillator data, default mode)**: presets -110.8 to -125
  dB (median -116.6 dB; FX Noise Sweep -185 dB), max abs error 8.9e-6; the
  behaviour cases -114 to -122 dB. All parameter value texts match FL's
  sweeps (11822 / 11822).
- Measured behaviours (README "Level behaviour" confirmed): velocity linear in
  MIDI velocity (64 vs 100: -3.876 dB), key 60 = 261.627 Hz, delay 1/4 at 130
  BPM: first echo sample 5089.

## Differences left

- The oscillator's harmonic data is our model of FL's waveform (-117 dB).
  Bit-exact output needs FL's `oscdata.dat` (2048 floats), which the project
  does not copy.
- FL keeps updating a released FL voice's FinalLevels until its sound ends;
  our channel stops updating a note's levels at its note off, so channel
  volume / pan / pitch changes during a release tail do not reach it.
- While the channel is idle (no voice, effects silent) the engine does not
  render it: the free-running LFO / phaser / chorus phases pause (synced to
  the song while playing, as FL).
- Live MIDI pitch bend / mod wheel (FL's MIDIIn) do not reach the plugin; the
  mod wheel is the "MIDI CC 1" parameter. The synth's sustain flag is never
  set by FL's wrapper (not implemented).

## Editor

FL's 717 x 473 panel (FL Studio Mobile style): page tabs, controls at FL's
editor coordinates (CMiniSynthEditor: knobs 63 x 65 with value display at +6,
+79; faders with value display at +5, +245; LED selectors with FL's spacing;
effect switches; the cutoff / resonance pad; the waveform drop-down; Effects
page tabs Delay / Chorus / Phaser / Distortion at the right), group frames
and displays where FL's page bitmaps have them, the preset bar (previous /
next, preset name) at the bottom. Colours sampled from FL's bitmaps; all
drawing original (SVG / CSS). Stepped controls set the values FL's editor
sets (OSC Kind i / 9, rates 0.01 + i / 11, delay time i / 3, selectors i / n).
