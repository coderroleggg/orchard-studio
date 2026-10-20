# BassDrum (FL: BassDrum)

**Status: calibrated against FL 2026's renders (test host).** The DSP is a
port of FL's own engine; with FL's waveform imported it renders FL's output to
-100 ... -144 dB in every tested case. Without the import it uses a
substitute waveform (FL's file is not shipped): -58 ... -80 dB.

Files: `src/model/gen/plugins/bassdrum.ts` (definition, texts, 52 presets),
`src/engine/gen/plugins/bassdrum.ts` (DSP), `src/ui/plugins/gen/bassdrum/`
(editor, FL content import), `tests/gen/bassdrum.test.ts`.

## Sources

- `Plugins/Fruity/Generators/BassDrum/`: `Bassdrum_x64.dylib` (FPC wrapper,
  TTestPlug; editor form 389 x 420, TVectorWheel Tags 0..22), `engine.dylib`
  (C++, RTTI: BassDrumSynth / CSynthesizer, BassDrumGen / CVoiceGenerator,
  BassDrumInstance). arm64 listings: parameter mapping 0x18728, value texts
  0x185b4, voice trigger 0xbc0c, internal render 0xbf50, voice process 0xc370,
  sub filter 0x28168 / 0x282e4, resampler 0x226d0..0x22a40, interpolation
  0x1c218, wrapper TriggerVoice 0x2da24, per-slot levels 0x2cc60, synth note on
  0x29150.., synth mixing 0x18b04.
- FL's manual page plugins/BassDrum.htm (controls; credit Maxx Claster), FL's
  thumbnail (layout, colours).
- 52 factory presets (`Data/Patches/Plugin presets/Generators/BassDrum/Factory`);
  the noise samples (`Noise Samples/*.wav`, 44.1 kHz 16-bit mono) and the
  1024-point oscillator waveform (`sounddata`, a float WAV).
- Test host renders: keys, velocities, every section, presets with their
  noise samples (`--load-file` / preset state), channel pan / volume / pitch,
  overlapping notes; `sweep` of all 23 parameters.

## Parameters

FL's wrapper holds 0..256 and hands the engine v = control / 256:

| # | Name | Engine value | Text (sweep) |
|---|---|---|---|
| 0 | Output level | gain 10^(2v - 1) | `(40v - 20).toFixed(2)dB` |
| 1 | Sampling ratio | 2^(4v - 2), read per block | `.toFixed(2)` |
| 2 | Duration | v^3 s (+ 1 ms) | `(100v).toFixed(1)%` |
| 3 | Sub bass | Q = 0.5 + 6 v^2 | % |
| 4 | Drive | 2560 v^4 | % |
| 5 | Attack | rate 1 / (1 + 10^5 v^8) | % |
| 6 | Base | 2^(4v + 4) Hz | `.toFixed(2)Hz` |
| 7 | Peak | 100 v^3 | % |
| 8 | Slide time | 20 v^3 + 0.001 s | % |
| 9-11 | Variation base / peak / slide | 2^(2v - 1) x main | `((2v - 1) 100).toFixed(1)%` |
| 12 | Variation phase | slave delay trunc(350 v^2) samples | % |
| 13 | Click cut | start phase 0.75 + 0.25 v^(1/8) | % |
| 14 | Click frequency | 2^(14v) Hz | % |
| 15 | Click amount | 25 v^5 | % |
| 16-18 | Noise A / D / S | attack 1/(44100 A^6), decay 1/(44100 D^6 + 44.1), sustain | % |
| 19 | Noise start | delay 4410 (2v - 1)^3 samples | bipolar % |
| 20 | Noise pitch | rate 2^(4v - 2) | `(48v - 24).toFixed(1)` |
| 21 | Noise mix | 2 v^2 | % |
| 22 | Noise filter | one-pole coefficient v^2 | % |

- Texts use JavaScript's toFixed (ties away from zero, as FL's): 0 mismatches.
- A fresh FL instance plays the engine's own defaults (Base 0.1, Peak 0.4,
  Slide 0.4) until a knob is touched, while its knobs show 25 / 102 / 102:
  the defaults here are 25.6 / 102.4 / 102.4 (sound of a fresh FL instance).
- Presets: the .fst state ("SSLF" chunk, 1384 bytes: name, sample path, the 23
  engine floats at 0x50c) holds floats that are not multiples of 1/256; they
  are stored as control values x 256 exactly (FL's knobs show them truncated).
  Each preset names one of FL's 8 noise samples (`noiseName`).

## DSP [C: FL's code, verified sample by sample]

- Notes: FL's wrapper unlinks velocity (FPV_SetLinkVelocity 0), takes slot =
  trunc(InitLevels.Pitch / 100) (the key) and MIDI velocity =
  trunc(41.714256 ln(10 InitVol + 1)) (= velocity, 128 -> 127); a second note
  on the same slot kills FL's older voice. The synth is monophonic: every note
  retriggers its single voice (trigger 0xbc0c only: the drive low-pass, the
  four noise filters and the resampler's look-ahead samples carry over). The
  voice is mixed with ComputeLRVol(FinalLevels.Pan, FinalLevels.Vol) of the
  newest note's slot and transposed by 2^(semitones / 12), semitones =
  FinalLevels.Pitch / 100 + 60 - slot (channel pitch, fine tune, root key; not
  the key), both updated per Gen_Render. Implemented as an 'events' plugin.
- Internal render at 44100 Hz (1 internal sample per output sample at ratio 1):
  - oscillators: table = 1024-point waveform, phase from 0.25, linear
    interpolation, wrap; inc = base / 44100 x (1 + peak env^4) clamped to
    [0, 0.5], env *= 1 - 0.0002 / slide each sample; the slave uses the
    variation multipliers and starts after the phase delay;
  - click: one pass of the table from its start phase to 1 at 2^(14v) / 44100
    per sample, times 25 amount^5, added to both oscillators' phases;
  - sample layer: linear read at 2^(4 pitch - 2) frames per sample, four
    one-pole low-passes (coefficient filter^2), envelope level^16 (attack to 1,
    then decay to sustain from 0.99; Noise A < 1e-4 starts at 0.99), x 2 mix^2;
    the noise delay counts to 0: negative = the noise waits, positive = the
    oscillators wait (FL's manual describes the sign the other way round);
  - amplitude: out x att^2 (att -> 1 at the attack rate, previous value: the
    first sample is 0) x dur (dur -> 7x / (7x + 1) of a linear fall from 1 over
    the duration, smoothed by 0.005 per sample); no release stage (note offs
    are ignored).
- Resampler (FL's, linear): step = clamp(ratio x 2^(st/12), 0.25, 4) x 44100 /
  rate internal samples per output sample, two samples of look-ahead.
- Output stage per output sample: y1 += (x - y1) 0.7; d = x - y1 through three
  saturators d / (1 + drive |d|^k) (k = 1, 2, 3), normalised so that 0.5
  maps to the same output as without drive; + y1; the sub filter (biquad at 42
  Hz, rate = host rate: b0 = (1 + cos w) / (2 + sin w / Q), feedback
  -2Q cos w / (Q + sin w), (Q - sin w) / (Q + sin w), numerator 1, -2, 1);
  x 0.4 x velocity x output gain.
- The voice stops once its output stayed below 1e-5 for more than
  trunc(rate x 1024 / 44100) samples, checked once per block.
- Single precision with FL's operation order (fused multiply-adds emulated by
  double arithmetic rounded once).

## FL content (not shipped)

- The oscillators' waveform (`sounddata`) is replaced by a substitute rebuilt
  from its first 32 harmonics (measured; rms difference -87 dB).
- The options menu item "Import FL BassDrum samples..." lets the user pick
  `sounddata` and the `Noise Samples` from their own FL installation; the files
  are parsed (RIFF/WAVE, defensive) into the project's sample pool: the
  waveform under `waveSample` (exact), the noise samples by name (presets link
  their `noiseName` to an imported sample of that name).
- Noise samples with another sample rate keep their timing (FL's are 44.1 kHz).

## Editor

FL's form coordinates (389 x 420): Duration / Output level / Sampling ratio
(46 px), 13 knobs of 36 px in the four quadrants MAIN, MASTER, SLAVE, CLICK
around the round display, which holds the noise sample selector (FL's
previous / next buttons and a menu: FL's 8 sample names, project samples,
Load..., None) and the seven 20 px sample-layer knobs. Original drawing in FL's
colours (background #1f2021, orange #d5994e); FL's own editor background is
not reproduced.

## Fidelity (FL vs ours, 44.1 kHz)

| Case | FL's waveform imported | Substitute |
|---|---|---|
| default, keys 48 / 60 / 72, velocities 64 / 100 / 128 | -107 ... -114 dB | -78 dB |
| click, drive, sub, attack, variations, duration 0, level | -100 ... -123 dB | -59 ... -74 dB |
| sampling ratio 0 / 200, channel pitch +1200 / -700, pan | -103 ... -114 dB | -69 ... -80 dB |
| two / three overlapping notes (mono retrigger) | -113 ... -121 dB | -79 dB |
| presets 01, 02, 03, 04, 05, 17, 33, 52 with their noise samples | -121 ... -144 dB | -58 ... -68 dB |

- Approximate: the block at which a silent voice stops (FL: its host block);
  levels after a note off are no longer updated by the channel ('events'
  plugins), FL keeps updating them until the voice ends; FL keeps 99 voice
  objects but plays one.
