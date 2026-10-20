# SimSynth (FL: SimSynth Live)

FL's three-oscillator subtractive synth (Plugin database > Generators > Synth classic).
Sources: FL 2026's binaries, read with `otool` / `lldb` and measured with the test host
(`flfxhost`, scratchpad fx/host):

- `SimSynth_x64.dylib` (FPC wrapper, class `TTestPlug`): the editor form (TSynthEditorForm,
  panel 562 x 376, 58 controls, `Tag` = the engine's control index), the 26 automatable
  parameters, the value texts (0x5f210), ProcessParam (0x5ef30: coarse knobs x 420),
  SaveRestoreState (0x5eae0: after a load it re-applies all 58 controls with a get / set
  round trip), Gen_Render / TriggerVoice / Voice_* pass through to the engine.
- `SimSynth_eng_x64.dylib` (C++ engine, with symbols): `SSPlug` (CreatePlugInstance 0x8a7c,
  DefaultPreset 0x8ba4, Dispatcher 0x8cb8, SaveRestoreState 0x900c, ProcessParam 0x93c8 with
  its control table at 0xb52c, Gen_Render 0x95ec, TriggerVoice 0x9c74, Voice_Release 0x9fcc,
  Voice_Kill 0xa000), `Preset` (Set(int, double) 0x685c, Set(int, int) 0x7884), `Voice`
  (Set 0x72fc / 0x7698, Gate, Change, FiltMod, QMod), `synth` (MakeSamp 0x5e7c, f_generate
  0x5ba0), `patch` (FillBuff 0x3da0, Gate 0x4a74, retrigger 0x4918, RethinkOscs 0x4bbc,
  RethinkFilter 0x4668, RethinkEnvs 0x5660, RethinkLFO 0x5980 ...), `p_env`, `p_lfo`,
  `p_loopquality`, `p_noise`, `p_filt`, the chorus (`Mod`) inside Gen_Render, and
  init_soft_clip (0x24c4, which builds all global tables).
- lldb on the test host: memory dumps of the engine at the first TriggerVoice (tables,
  voice states, the noise counter), per-sample register traces of FillBuff.
- FL's manual (control descriptions) and FL's plugin database thumbnail (look).

The port (`src/engine/gen/plugins/simsynth.ts` + `simsynth/`) is FL's code line by line in
FL's precision (float32 with FL's fused multiply-adds, the filter in double); it renders
FL's output bit for bit (see Fidelity).

## Parameters and state

`def.params` = FL's 26 automatable parameters (index = Tag, range 0..65535, `def` = the
form's DefaultValue). Value texts = FL's (`flfxhost sweep`, all 65536 values checked):
percent `round(v/65535*100)%` (levels, LFO delay, cut, high, band, envelopes, VCA Velo),
centre-zero `round(v/65535*200-100)%` (osc LFO / Env, SVF Env / LFO), LFO Rate
`round(v/65535*999+1)` (1..1000), Emphasis `round(v/65535*94)%`.

| Tag | Key | Name | Engine (patch value d = v/65535) |
|---|---|---|---|
| 0, 3, 6 | o1Level.. | Osc1..3 Level | level = trunc(d*100); amplitude (level*0.01)^2 |
| 1, 4, 7 | o1Lfo.. | Osc1..3 LFO | trunc(fma(d, 200, -100)) x 12 cents x LFO B |
| 2, 5, 8 | o1Env.. | Osc1..3 Env | trunc(fma(d, 200, -100)) x 12 cents x amp env |
| 9 | lfoDelay | LFO Delay | trunc(d*100) x 3528 samples fade-in (any rate) |
| 10 | lfoRate | LFO Rate | r = trunc(d*999)/999: half period 4 s (1-r)^3, >= 64 samples |
| 11 | svfCut | SVF Cut | trunc(d*255)/255 (filter coefficient, linear) |
| 12 | svfEmph | SVF Emphasis | e = trunc(d*255): damping (1 - e/255)^2 + 0.1 |
| 13 | svfEnv | SVF Env | trunc(fma(d, 255, -127.5))/128 x envelope |
| 14 | svfLfo | SVF LFO | same x LFO A |
| 15, 16 | svfHigh, svfBand | SVF High / Band | trunc(d*255) x (pi/2)/255: mix angles |
| 17..20 | envA..envR | Env Attack / Decay / Sustain / Release | ms: trunc(d^3 x 8000), trunc(d^2 x 8000), trunc(d*255)/255, trunc(d^2 x 8000) (>= 2 ms) |
| 21 | vcaVelo | VCA Velo | the plugin's output gain (float d), not a velocity amount |
| 22..25 | fenvA..fenvR | SVF Env Attack .. Release | as 17..20 (release >= 1 ms) |

Controls 26..57 have no parameter index (FL cannot automate them); they are plugin state
under these keys (FL saves them in the same state blob):
`o1Pw o1Coarse o1Fine` .. `o3Pw o3Coarse o3Fine` (PW 0..65535: pw = trunc(d*96)+2;
coarse knob 0..48 = -24..+24 semitones; fine trunc(fma(d,200,-100)) cents), `svfKb`
(0..65535: filter offset kb x pitch index / 12700), switches `chorus retrigger trackAmp
lfoOn svfOn o1On o2On o3On ring o1Oct1 o1Oct2 o1Warm .. o3Warm`, shapes `o1Shape..o3Shape`
(0 square, 1 saw, 2 triangle, 3 noise, 4 sine) and `lfoShape` (0..3). FL's hint texts
(e.g. "+12.00 semitones", "-4.00 cents") are shown on these controls.

FL's state (`.fst` event 0xd5, 564 bytes): 45 doubles (the patch values above, by engine
slot), 19 ignored ints, 19 switches, 12 ignored ints, version (14). Slots 23, 25, 31, 34, 40
and switch 15 exist but the renderer never reads them. Load fixes: version 0 scales VCA
Velo by 0.75, <= 4 / <= 12 re-quantise the coarse values. After FL's load the wrapper reads
every control back (floor(d x 65535), coarse round(floor(d x 20160)/420), shapes by reverse
lookup with unknown values read as Saw) and sets it again, so a loaded patch holds
quantised knob values: `def.presets` holds exactly those (73 presets from
`Plugin presets/Generators/SimSynth`, versions 0 / 4 / 5 / 14; parameters 0..25 equal the
test host's `info --preset` for every preset).

Fresh instance: FL's plugin database state `Plugin database/Generators/Synth classic/
SimSynth.fst` has the same plugin data as `Plugin presets/SimSynth/Default.fst`, so a new
SimSynth plays the Default patch; `def.state()` gives it. FL's constructor state (what a
host shows before loading: `info SimSynth`) is the engine's DefaultPreset table overwritten
by the editor form's design-time values (osc 1 saw only, SVF and chorus off, VCA Velo
37630): about 11 dB quieter than Default.

## DSP

All per sample, float32 with FL's fused multiply-adds (exact emulation in `fmath.ts`),
FL's constants by bit pattern (several are not the float nearest their decimal: 0.2275,
0.02...).

- Voices: the engine owns 12 voices (SetNumVoices(12): per-voice detune 0, -8, 8, -6, 6,
  -5, 5, -4, 4, -2, 2, -1 cents, added to the pitch index and the raw increment). A 13th
  note steals the voice released longest ago (by FL's Gen_Render call count), else the
  newest one; FL's DefPoly 16 is never reached.
- Pitch: index = final pitch (cents, root key 0) + 7200 + coarse + fine (+ 4 cents down /
  up for osc 2 / 3 until the next update), clamped by FL's table (10..29996), frequency
  4.0886817 x 2^(index/1200): key C5 plays 261.68 Hz (an octave below 3x Osc, A = 440.08 Hz).
  Oscillators update their increment every 32 samples from the note start (with the LFO B /
  envelope modulation); TVoiceParams_Old (integer cents and pan / 64) as FL passes it.
- Oscillators (p_loopquality): a 4096-point table read twice per sample with 2x-rate
  increments, y = (y + t[p] + t[p + inc]) x 0.333333; "warm" adds a second copy 20 cents
  up. Tables (MakeSamp): square = one-pole steps to +-0.65 with the pulse width, saw =
  sin((1 - i/2048) pi/2), triangle, sine morphing to sine^4 by PW; +1 / +2 octave switches
  add the table at 2x / 4x; then a 2-point average. Noise: the shared noise table through a
  two-state filter (colour = the coarse knob), x16. Ring: osc1 x (2 x osc2).
  Start phases are random: the noise table (rand() after srand(666): Park-Miller) read at a
  process-wide 16-bit counter that every oscillator start, noise sample and LFO period
  advances (creation and every patch rebuild consume it; FL's position at the first note
  after loading Default is 696, reproduced).
- Amplitude: linear ADSR (p_env: stage lengths in samples from ms x samplesPerMs); the
  level is env (attack) or env^2 (later stages), smoothed: s = s + 0.03 (level^2 - s)
  (flushed below 6e-8), so the output follows env^2 / env^4.
- Filter (p_filt, double): two Chamberlin SVF stages (stage 1 at f^2, stage 2 at f, f =
  cut + modulation clamped 1e-4..1, x 44100/rate), each stage's input / output the mix
  low cos(a)cos(b) + band sin(b) + high sin(a)cos(b); cutoff modulation every 32 samples:
  KB x pitch / 12700 + Mod X + envelope x amount + LFO A x amount; Mod Y offsets the
  emphasis. TRACK AMP drives it with the amplitude envelope instead of the SVF envelope.
- LFO: a ramp per half period: square (0 / 1), saw (ramp), triangle (A unipolar, B
  bipolar), random (sample and hold); A goes to the filter, B to the pitch; delayed fade-in;
  RETRIGGER restarts it per note, otherwise it syncs to the plugin's sample counter (which
  FL never initialises: we start it at 0x065e065e, the value FL shows in the test host).
- Output: per voice FL's ComputeLRVol(pan, VCA Velo x FinalLevels.Vol) with a 128-sample
  linear ramp whenever the gain changes, summed with fused multiply-adds in slot order.
  Velocity acts only through FinalLevels.Vol (linear, FL's velocity curve).
- Chorus: a 65536-point delay of the left sum read 882 samples (20 ms) behind with a read
  speed sweeping 0.9928..1.0072 (triangle, period 333 + Mod::inst ms: a counter of plugin
  instances and sample rate changes, +5 mod 53), linear interpolation: left = the delayed
  copy only, right = dry. After the last voice it runs 20 ms on silence.
- A voice ends when its amplitude envelope reaches the end stage; FL drops it at the end of
  the Gen_Render call in which that happened (the smoothed tail runs to there).
- Parameter changes: every control acts on playing voices as in FL (Voice::Set): shape /
  osc on / octave / warm changes restart that oscillator at a new random phase, a live
  sustain change uses FL's own (slightly different) sustain rounding, a state / preset load
  stops every voice.

## Our implementation

`simsynth/fmath.ts` (float semantics), `tables.ts` (global tables and counters, checked
against FL's runtime tables dumped with lldb: all identical; FL's sine table needs 57 one-
ulp corrections because Apple's sinf is not correctly rounded), `dsp.ts` (p_env, p_lfo,
oscillators, p_filt), `synth.ts` (patch data, MakeSamp), `patch.ts` (the voice, FillBuff),
`preset.ts` (Preset::Set, Voice::Set), `plug.ts` (SSPlug + the wrapper: creation, controls,
state loads, voices, gains, chorus). Process-wide state (noise counter, tables, chorus
counter) is module-level like FL's library globals.

`simsynth.ts` drives it like FL: the channel's voices only log trigger / level changes /
release / kill with their frame; `render()` replays them in time order and emulates FL's
Gen_Render calls (up to 512 samples, re-anchored at every event, like the test host): at
each call start the voice gains / pitch / Mod X / Y, voices rendered in slot order, the
mix, the chorus, at each call end the finished voices are dropped. `def.levels` 'plugin'
(the plugin applies volume and pan with FL's ramps), velocity in the levels.

Creation emulates FL's sequence in the test host (constructor, 12 voices, quality / render
switches, DefaultPreset, the form values, sample rate, process mode) and the first state
(`setParams`) is a SaveRestoreState load with the wrapper's re-apply, so the engine is in
FL's exact state at the first note. Later edits are FL's ProcessParam per changed control;
a new `__preset` is a state load.

## Fidelity

FL (test host, real plugin) vs ours through GenChannel, 44.1 kHz unless noted:

- **Bit-exact (maxAbs 0)**: all 73 factory presets (C5, 0.6 s note + release); keys 12 .. 131;
  velocities 1, 100, 127; chords, staggered and overlapping notes, a 32-note arpeggio
  (Default, PolySynthBright); 14 / 16 notes (voice stealing); note pan; Mod X / Mod Y; 48 and
  96 kHz; repeated notes on one voice; automation of each of the 26 parameters during two
  notes (LFO, filter, envelopes, VCA Velo ramps); channel volume / pan steps (FL's 128-sample
  ramps); 49 variants of the non-automatable controls (all shapes per oscillator, pulse
  widths, octave switches, warm, ring, oscillators off, coarse / fine, KB, TRACK AMP, SVF /
  chorus off, every LFO shape with and without RETRIGGER, LFO delay, noise colour, envelope
  extremes, emphasis / high / band); live mid-note changes of every non-automatable
  control (28 cases plus on / off / on toggles, through a test host build that accepts
  FL's control indices 26 .. 57); FL's own render test `Data/System/Render tests/SimSynth.flp`
  (its version-14 state: Default with chorus, SVF, oscillators 2 / 3 and WARM 1 / 2 off; its
  seven 0.25 s notes on keys 24 .. 96) at 44.1 and 48 kHz.
- **FL itself is not deterministic** for patches with the LFO on and RETRIGGER off (Magic,
  BassGoodRange, TB303ish, Clav, ...): the LFO syncs to an uninitialised counter, and two
  test host runs of the same render differ (-8 dBFS). With the host's usual value they are
  bit-exact.
- **Noise with two or more voices** (noise oscillators, random LFO): FL's voices consume
  one shared noise sequence call by call (512 samples here); our replay renders per channel
  block (128), so the voices get different (statistically identical) noise: -0.6 .. -8 dB
  difference. Rendered with the host's block structure they are bit-exact too.
- **Velocities other than 1 / 100 / 127**: maxAbs 2.4e-7 (-137 dB) from the shared velocity
  law (`levels.ts` noteVolume is double, FL's is float: f32((exp(f32(f32(vel x 0.01f) x
  ln11f)) - 1) x 0.1f)); with FL's formula bit-exact (checked).

Approximations, all in how FL's host drives the plugin rather than in its DSP: FL calls
Gen_Render per audio buffer (variable), we emulate 512-sample calls split at events (the test
host's): where FL's buffer differs, a voice's end can be cut at another point and
multi-voice noise interleaves differently; level changes (glides, automation through the
channel) reach the plugin every 16 samples instead of per FL buffer; voice stealing orders by
sample time instead of FL's call counter (same order except ties inside one call); the
chorus instance counter starts at 0 per process like a freshly loaded FL library.

Performance: about 0.3 us per voice-sample (12 voices of Default at 44.1 kHz: ~16 % of one
core in Node), instance creation ~2 ms after the first.

## Editor

FL's form layout (562 x 376, every control at the form's coordinates): three oscillator rows
(on LED, 5-icon shape selector, PW / CRS / FINE / LEVEL / LFO / ENV wheels with green arcs,
octave 1 / 2 buttons, WARM, RING 1x2), AMP (envelope display, ATT / DEC / SUS / REL /
LEVEL), SVF (on LED, envelope display, ATT / DEC / SUS / REL / ENV, LFO / KB, TRACK AMP,
CUT / EMPH / HIGH / BAND), LFO (on LED, 4-icon selector, RATE / DEL, RETRIGGER) with blue
arcs, the CHORUS switch, and where the form keeps a preview keyboard FL 2026 shows its logo
(an original lettering here). Colours after the plugin database thumbnail (187 x 125;
`System/Config/Thumbnails/SimSynth.png` is the same file; the only reference image);
original drawing.

## Open questions

- FL's buffer structure in real sessions (affects only voice-end tails and multi-voice noise).
- The exact look of FL's envelope displays (drawn here from the four knobs, each stage over a
  quarter of the box) and of the shape icons.
