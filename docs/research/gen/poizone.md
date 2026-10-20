# PoiZone (FL: PoiZone)

Image-Line's virtual-analog synthesizer (Delphi wrapper `PoiZone_x64.dylib` around a C++
`engine.dylib`: `PoiZoneSynth` on IL's `CSynth` / `CVoiceGenerator` / `CFLWrapper` framework,
shared with Sawer). Plugin database: Generators > Synth classic. Everything below was decoded
from FL 2026's arm64 engine (otool listings, constants, RTTI vtables) and checked against FL's
renders with `flfxhost` and against FL's own engine code called directly (`dlopen` of the
engine, its synth / tape / chorus / filter objects driven from C).

Files: `src/model/gen/plugins/poizone.ts` (def), `.../poizone/{data,presets}.ts`,
`src/engine/gen/plugins/poizone.ts` + `.../poizone/{core,dsp,applemath,plugin}.ts`,
`src/ui/plugins/gen/poizone/index.tsx`, `tests/gen/poizone.test.ts`.

## Parameters and state

FL shows 203 parameters: the 74 synth parameters (index = form Tag = engine id), MIDI CC
0..127 (raw / 256 x 127 sent to the engine; CC 7, 10, 32 not passed; CC 1 = mod wheel, 64 =
sustain, 121 / 123, others through the MIDI-learn map) and channel aftertouch (no effect).
Switches (shapes, sync, ring, retrig, delay / chorus on, mono, octaver, glide held / static,
the 16 gate steps) are raw 0 / 1 and reach the engine as is; the others are raw 0..256 / 256.
Value texts from full sweeps (0 mismatches): integers use Delphi's banker's rounding, decimals
round half away from zero; Osc B pitch / Transpose show trunc(48 v - 24) while the engine uses
trunc(48 v) - 24; Amplifier decay shows 1 + 19999 v^4 ms while the engine clamps to 5..20000.

The state (FL's `SSLF` blob, version "3reV" / "4reV") holds 156 engine floats: ids 0..73, the
hidden settings 74..80 (74 unused, unison voices index {1,2,3,4,8,12,16}, polyphony - 1,
arpeggiator speed index {1/32 .. 1/1}, pitch-bend range - 1, gate speed index, LFO tempo
sync index {off, 1/16 .. 4 bars}) and the MIDI-learn CC of every parameter (-1 = none). FL
loads it as "defaults, then ids 0..155 in order". Presets keep the exact floats (raw = v x 256
may be fractional). 385 presets (Default, Factory, Xenos Soundworks); FL's database entry =
"Factory/ARP Classic VA ToTc" (the insertion state).

## Engine (exact port)

- Pool of 1024 generators (+ 1 spare used as padding), random initial oscillator phases from a
  global 32-bit LCG (seed 22222, x * 0x0bb38435 + 0x3619636b) that also makes the noise. A note
  takes the first free generator among the first poly x unison (FL sends FPE_MaxPoly when it
  creates the channel; without it every note would use generator 0), else the oldest released
  one if older than generator 0, else the oldest. Mono: generators 0.., legato keeps the
  envelopes; glide held / static (rate 12 / (sr t) per 8x sample, or |interval| / (sr t)), glide
  time 2 v^3 s; random detune per note (2 u - 2) x 0.01 semitone (LCG seed 2222); unison detune
  1.5 v semitones spread, unison pan, octaver (+12 on odd unison voices); pitch = MIDI note
  (FL key 60 = 261.6 Hz) + transpose + fine + bend + FL's pitch offset.
- Everything runs at 8x in blocks of 8 x <= 64 samples. Per block: glide, amp / EG envelopes
  (doubles, attack linear / curve -2, decay and release `1 - (1 - x) 10^(c x)`, c = -2.5 amp,
  -2 EG; times 1..5000 / 5..20000 / 15..10000 ms, EG 5..50000 ms; value at the block's end),
  LFO (saw, pulse, triangle, sine, sample & hold with a 64-bit LCG that yields values up to
  2^32 - FL's, ported; free 30 v^5 Hz or tempo synced), modulation (EG / LFO / MW to cutoff
  (amount^2), oscillator A / AB pitch (EG: trunc(24 amount) semitones; LFO 2 amount^4 octaves;
  MW 2 amount^3 octaves), pulse widths, LFO amount, pan), linear ramps of oscillator levels,
  noise level and stereo gains.
- Per 8x sample: two descending naive saws, pulse = difference of two phases (offset
  0.49 PW - 0.99), hard sync, ring mod (B x (A + level B)), noise (u - 0.125) x level, input
  offset -0.42, feedback, soft clip of negative input x / (1 + 3 x^2), musicdsp Moog 4-pole
  (cutoff 2^(6 + 10 x) Hz, x = 1.1 cutoff + key track (key - 56) x 0.0084 + velocity + mods,
  max 0.91), LP / BP (3 y4 - 3 y3) / HP (x - y4), DC tracker (1e-4), smoothed gains (coefficient
  0.003 at 44.1 kHz). One active voice: FL's scalar loop; more: FL's four-voice NEON loop, with
  its own rounding order, gains applied one sample later, and a lane-reversed store of the
  oscillator levels (voice i gets voice 3 - i's level for the next block: FL's bug, reproduced).
- Decimation: one RBJ-style biquad low-pass per channel at sr / 3 (8x domain) with FL's
  mismatched alpha; +5 dB high shelf at 12 kHz (S 0.99); trance gate (16 steps, tempo synced,
  resynced to the song position while playing, smoothing (1 - s)^2 x 0.01 + 1e-4); chorus (three
  CTapeDelay lines of 22 / 17.08 / 20 ms on the mono sum, triangle-smoothstep speed modulation);
  delay (two tapes, 2 s, times (k + 1) / 4 beats, feedback 0.84 v, mod depth 0.01 v^2, 2-pole
  lo / hi cuts 10 x 2^(10 v) / 200 x 2^(6.6 v) Hz); master gain 10^(1.5 v - 1) x 0.5 with a
  0.005 one-pole; per-block parameter smoothing (0.04) of pulse widths, balances, mod amounts and
  cutoff.
- CTapeDelay: samples written with their tape position into two swapping buffers, read one
  tape length behind with linear interpolation (the sentinel sample and three history samples
  per buffer), speed smoothing 0.005 / sample, wet smoothing 0.01.
- Arpeggiator: held notes ascending x octaves (range 1..4), up / down / up-down / random (LCG
  seed 2222), steps of speed x 1/16 note, triggered at block starts.
- Wrapper: FL voice -> MIDI note (key = trunc(InitLevels.Pitch / 100), velocity = trunc(127
  ln(10 v + 1) / ln 21)); per render call every key's FinalLevels (FL's pan law gains, pitch
  offset, Mod X / Y) - keys without a voice take the nearest lower voice's values, with no voice
  at all 0 (FL's uninitialised locals, 0 in FL); voices killed once their key no longer sounds;
  FL's init order: SetSampleRate (effects created, smoothers snap) then a reset to defaults (the
  wrapper's float-parameter switch), which also decides the chorus wet sign quirk (a sample-rate
  change hands the tapes the negated wet amount).
- Apple's libm float functions (cosf, sinf, __sincosf_stret, exp2f, __exp10f, logf) are not
  correctly rounded (cosf / sinf differ from the nearest float about 1 call in 80): they are
  ported from macOS's libsystem_m (tables included); double FMA emulated with correct rounding
  (FL's tape speed smoothing converges to the hardware FMA's fixed point).

## Fidelity (TS vs FL, flfxhost, 44.1 kHz, FPE_MaxPoly 0)

| case | residual |
|---|---|
| one voice / chords (scalar and NEON loops), noise, LP / BP / HP, sync, ring, pulse, oscillator B | bit-exact |
| EG / LFO / MW to every destination, all LFO shapes (incl. random), retrigger, amp envelope, velocity / key tracking | bit-exact |
| mono legato, glide (held / static), gate, arpeggiator (up / down / up-down), unison, octaver | bit-exact |
| chorus, delay with feedback / modulation / cuts, note pan, fine pitch, Mod X / Y | bit-exact |
| all 385 factory presets (4 notes, overlapping, varied velocities, 1 s) | bit-exact |
| FL's engine objects called directly (synth block, tape, stereo delay, chorus, cut filter) | bit-exact |

## Approximations

- When no FL voice is left while generators still release (arpeggiator octave notes), FL reads
  uninitialised locals for the gains; this port uses 0, which is what FL's stack holds there
  in FL's call sequence (verified with the test host).
- FL keeps the engine running from creation; renders start from the state after the
  effects' sample-rate setup, like FL.
- Editor: original drawing at the form's coordinates; the pitch wheel springs back without
  sending pitch bend (FL's own MIDI pitch bend is not a parameter); the MIDI-learn display picks
  the parameter from a menu (FL: the last touched control) and the CC from a menu (FL: the last
  received CC).
