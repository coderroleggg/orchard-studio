# Drumpad (FL: Drumpad)

**Status: calibrated against FL 2026's renders (test host).** The DSP is a port
of FL's own engine and wrapper; it renders FL's output bit for bit in every
tested case (60 random factory presets of all folders, keys, velocities 1 ...
128, velocity modulations, every section at its extremes, Lo-Fi, retrigger
seeds, overlapping and repeated notes, channel pitch / pan, 22.05 ... 96 kHz).
Drumpad uses no samples: it is a physical model, and names such as "Acoustic
HiTom 05 p - TomA" are just preset names.

Files: `src/model/gen/plugins/drumpad.ts` (+ `drumpad/keys.ts`,
`drumpad/presets.ts`), `src/engine/gen/plugins/drumpad.ts` (+
`drumpad/libm.ts`, `drumpad/voice.ts`: the voice, shared with Drumaxx),
`src/ui/plugins/gen/drumpad/index.tsx` (+ `controls.tsx`, shared with Drumaxx),
`tests/gen/drumpad.test.ts`.

## Sources

- `Plugins/Fruity/Generators/Drumpad/`: `Drumpad_x64.dylib` (FPC wrapper:
  TTestPlug, TSynthEditorForm 794 x 225, value texts, FL <-> engine value
  mapping 0x61dc0 / 0x61ec0) and `engine.dylib` (C++: DrumpadSynth /
  CSynthesizer, DrumpadInstance, the voice class). arm64 listings: voice
  constructor 0x1fb54, parameter setup 0x1fe4c, note on 0x20554, reset 0x20980,
  internal render 0x20a98, resampler / mixer 0x21484, LOW filter 0x26f2c, RBJ
  filters 0x27560, synth note on / voice allocation 0x27e60, per-block voice
  update 0x165f0, velocity modulation getter 0x164a0, state load 0x16844,
  wrapper TriggerVoice 0x2e0b0, Gen_Render 0x2dfac, per-slot levels 0x2d2ec.
- macOS libsystem_m (powf, exp2f, exp2, sinf, cosf, exp10f, __sincosf_stret),
  disassembled to reproduce FL's libm results bit for bit (`drumpad/libm.ts`;
  the tables are generated from their definitions, checked against Apple's on
  200 000 inputs and on every call FL makes while rendering).
- FL's online manual (control names), FL's thumbnail (look), the 961 factory
  presets (`Data/Patches/Plugin presets/Generators/Drumpad`).
- Test host: `info` / `sweep` (all 38 parameters), renders with `--preset`,
  `--param`, `--chan-pitch`, `--chan-pan`, `--sr`; libm calls logged by an
  interposed library.

## Parameters

FL's wrapper holds 0..256 and hands the engine v = control / 256 (velocity
targets 30..33: their value as is). Value texts (all values match FL's sweeps):
"Off" / "On", Retrig "0" / "I" / "II" / "III" (trunc(3 v)), "%.2f %" of v
(bipolar: MID level, MID frequency mod, MID level mod, HIGH level, Pitch: 2 v - 1),
target names (value k targets parameter k + 1). A fresh FL instance plays the
engine's own defaults until a control is touched: Membrane decay 0.9, cutoff
0.35, tension 0.3 (FL's knobs show 230 / 90 / 77), so the defaults here are
230.4 / 89.6 / 76.8. Presets (.fst state "3PMD": name, comment, 38 floats)
are kept exactly as control values x 256 (FL's knobs show them rounded).

| # | Parameter | Engine value (read at note on) |
|---|---|---|
| 0 / 1 | Mallet retrig / Retrig | noise seed reset on / MID envelope re-triggers 0..3 |
| 2, 3 | Mallet amplitude / decay | 10^(4v - 4); level -> 1e-7 by 0.05 (1 - v)^4 + 1e-4 per sample |
| 4, 5 | Mallet noise / noise RP | noise mix; seed v (2^32 - 1) when Mallet retrig is on |
| 6, 7 | Membrane decay / cutoff | feedback -v^0.3; comb low-pass coefficient v^2 |
| 8, 9, 10 | tension / phase / material | comb weights: triangle (phase + tension^4 / 2 per comb)^(1 + 20 m^4), m = 2 material - 1 (inverse for m < 0) |
| 11, 12 | size / shape | combs trunc(512 (1 - v)) .. + trunc(128 v) |
| 13, 14 | LOW frequency / reso | high-pass 2^(11v + 2) Hz, Q 8v + 1; off at 0 |
| 15..17 | SOF frequency / decay / level | ladder g0 = 2^(4.65v + 5.93) / 6333; envelope decay ((v/2)^4) / 100 + 1e-5; level v^8 / 2, off at 0 |
| 18..23 | MID frequency / level / res / freq mod / level mod / attack | peaking 2^(9v + 5) Hz, 32v - 16 "dB" (A = 10^(dB / 20)), bandwidth 4 (1 - v) + 0.5; sweeps x (1 + (32v - 16)(1 - env)) and + (48v - 24)(1 - env); env decay (1 - v)^4 / 100 + 1e-5 |
| 24..26 | HIGH frequency / level / res | high shelf 2^(4.1v + 8) Hz, 36v - 18 dB, bandwidth 2 (1 - v) + 0.5 |
| 27 | Lo-Fi | 65536 (1 - v)^5 + 4 steps (off below 0.01) |
| 28 | Hold | 3 v^3 + 0.001 s |
| 29 | Pitch | x 2^(2v - 1) |
| 30..37 | Velocity mod 1..4 target / value | base + (value - base) x velocity^0.5 |

## DSP [C: FL's code, verified sample by sample]

- Wrapper: slot = the key; MIDI velocity trunc(41.714256 ln(10 InitVol + 1))
  (0: no note); voice velocity (velocity / 127)^0.5. Per Gen_Render FL fills
  128 per-slot level arrays from the notes' FinalLevels (ComputeLRVol, and
  semitones = FinalLevels.Pitch / 100 + 60 - slot), every slot from the nearest
  active one, and the synth reads them with the voice number. After each
  Gen_Render FL forgets (kills) the notes that are off and have no voice.
- Synth: 99 voices but polyphony 1 (measured): every note retriggers the first
  voice; the membrane, filters and resampler carry over. A voice's first note
  leaves it counted as free, so that note's levels are dropped one block after
  its note off and the voice fades out (gains move 0.001 per sample to 0).
  Note offs do not stop voices; a voice ends 25 ms after its output last
  exceeded 1e-4 (or after 0.5 s of silence).
- Voice, at 38000 Hz: mallet impulse + noise (the voice's own LCG, seeded by
  FL's constructor: 3000 steps from 0 per voice) -> 128 four-lane comb lines
  (lane j of line i: 512 - 4i - j samples; FL shifts each lane at the wrap, the
  shortest line has a quirk, both emulated) -> weighted sum -> SOF -> LOW ->
  HIGH -> MID (coefficients every 6 samples) -> hold gain (attack 0.1 per sample
  to 1, then x 0.999 per sample) -> clip +-1 -> Lo-Fi.
- Output: linear resampling (step 38000 / rate x pitch x 2^(semitones / 12),
  chunks of at most 256 frames), gains ramped by 0.001 per sample.
- Single precision with FL's operation order; fused multiply-adds emulated
  (exactly where it matters, via double elsewhere: a tie after the double
  rounding is the only case that can differ, about once in 2^29 operations).

## Editor

FL's form at its coordinates: the 32 knobs in FL's two TVectorWheel styles
(small: cap 0x626465, pointer 0xE8AC13; big: cap 0xD5D5D5, pointer 0x1D6E94),
the Mallet retrig check box, the MID Retrig selector (0 / I / II / III), the
four velocity target combos, in FL's sections (MALLET, MEMBRANE, LOW, SOF,
MIDDLE, HIGH, OUTPUT, VELOCITY; captions as FL's manual names the controls)
and the header (title, preset selector with arrows, SAVE / LOAD). Original
drawing in FL's colours; FL's panel artwork is not reproduced. SAVE (FL: .dmpatch
kits) is not implemented; LOAD opens the presets.

## Fidelity (FL vs ours, 44.1 kHz unless noted)

| Case | Residual |
|---|---|
| default note, 0.5 / 1 s | bit-exact |
| 60 random factory presets (all folders) | bit-exact |
| keys 48 / 72, velocities 1 / 64 / 127 / 128, velocity modulation (4 targets) | bit-exact |
| repeated and overlapping notes (1 ... 4 notes, same / different keys) | bit-exact |
| channel pitch +700 / -1300, channel pan -0.5 | bit-exact |
| 22050 / 48000 / 96000 Hz | bit-exact |
| every section at its extremes, Mallet retrig with seed, MID Retrig I / III, Lo-Fi | bit-exact |

- Approximate: notes with different per-note pans / volumes on different keys
  (FL's per-slot level arrays are reproduced, but the channel stops updating a
  note's levels at its note off, FL keeps updating them until it forgets the
  note); a project with several Drumpad instances (FL's voice seeds continue
  from instance to instance in its process; here each instance starts as FL's
  first).
