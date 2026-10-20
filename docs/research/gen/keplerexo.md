# Kepler Exo (FL: Kepler Exo)

The extended Kepler (Plugin database > Generators > Synth classic): two DCOs with hard sync, cross modulation and
AM, two LFOs and two envelopes, a multi-slope filter with FM, mono / legato / portamento, an 8 slot modulation
matrix, a nine-mode arpeggiator and an effect chain (saturation, equaliser, hyper chorus, delay, reverb). It is the
engine described in `kepler.md` with all 155 parameters exposed; this note covers what Exo adds. Method and tools
are the same (decoded from FL 2026's arm64 library, checked against the test host, the engine's own functions
called natively where a function was too large to trust a reading: the equaliser designer).

Files: `src/model/gen/plugins/keplerexo.ts` + `keplerexo/{data,params,presets}.ts`, `src/engine/gen/plugins/keplerexo.ts`
(GenModule) + the shared `kepler/` folder (`eq.ts`, `eqdesign.ts`, `sat.ts`, `hyperchorus.ts`, `delay.ts`, `reverb.ts`,
`modmatrix.ts` are the Exo parts), `src/ui/plugins/gen/keplerexo/{index,effects,matrix}.tsx` + `displays.ts`, tests
`tests/gen/keplerexo.test.ts`, `kepler-render.ts` / `.golden.ts`, `keplerexo-model.test.ts`.

## Parameters and state

155 FL parameters (index = engine id; value texts from full sweeps, hashed in `kepler-golden.ts`). Beyond
Kepler's: DCO2 (on, semitone -48..48, detune, saw / pulse / sub, pulse width and its source, LFO / env depths,
hard sync), cross modulation 1->2 and 2->1 (amount and shape: sine, triangle, pulse, saw, noise, other DCO),
DCO1 / DCO2 levels, noise level, AM, filter slope (6 / 12 / 18 / 24 dB), FM (amount, shape), key follow, two LFOs
(rate, sync, delay, trigger mode, retrigger phase; LFO2 shape: triangle, ramp up / down, sine, random, random +
glide), two envelopes, chorus (mode, noise, gate), volume, velocity volume, pan, mono, legato, retrigger, release
restart, portamento (mode, time), bend range, arpeggiator (rate, sync, range, 9 modes, gate, "bug"), the 8 matrix
amounts (ids 92..99), the effects (100..148), Mod X / Y offsets (149 / 150), VCA smooth (151), saturation HQ
(152), master tune (153) and the output high-pass (154). Pitch offsets for the matrix are the hidden ids 256 / 257
(DCO1 / DCO2 pitch, +-12 semitones).

The state is the wrapper record version 1: the engine payload (name "Kepler-2", version 4, 155 floats, the 8
(source, destination) route pairs, the Options bytes arp-quantize, HQ, enhanced oscillators) and a zero record.
188 factory presets. Options menu: Arp 1st Step Quantize, HQ mode, Enhanced Oscillators, Theme (editor only),
"Import FL content...".

## What Exo adds to the engine

- **DCO2, sync, cross modulation.** A second `SlaveOsc` per voice; hard sync resets DCO2 on DCO1's wrap with
  sub-sample correction through the band-limited step table, cross modulation adds the other oscillator or a
  shape (sine / triangle / pulse / saw / noise) to the phase, AM multiplies the two.
- **Mono, legato, retrigger, portamento.** One voice with the held-key list (last key priority); legato keeps the
  envelopes, retrigger restarts them, release restart restarts the release; portamento exponential or linear with
  time `curve(v)`.
- **Modulation matrix** (`modmatrix.ts`): 24 sources in the engine's order (LFO1 triangle / sine / unipolar, LFO2,
  Env1, Env2, velocity on / off, Mod X / Y bipolar and unipolar, gate and inverted, key follow, alternate sign,
  random value, and the "extra" LFO copies), 8 routes. A route table is shared by the engine (global destinations:
  LFO rates, effects, volume, pan...) and by every voice (per-voice destinations). Per destination the value is
  `clamp01(base + sum(source x amount))`, delivered once per 44-sample control period, amount = 2 v - 1. The
  engine's handler of a destination runs at every delivery: routing the **mono switch** therefore calls the
  engine's reset (every voice released, note stack, held keys and arpeggiator cleared, delay line and reverb
  emptied) every period, as FL does (automating Mono during playback does the same once).
- **Arpeggiator modes.** Up, up / down, down, three random modes (clock-seeded in FL), as played up / up-down /
  down. An arpeggiator mode driven by the matrix can reach the random modes.
- **Enhanced oscillators** (Options menu; `junoex.ts`). The engine keeps a second oscillator class, `JunoOscEx`, two per voice, up to
  date with every oscillator parameter and runs it instead of the classic one when the option is on. It is a residual-corrected
  naive oscillator: rings of 32 samples for the saw, the pulse and the sub oscillator receive the naive waveform at the write
  position and a band-limited step (scaled by the height of the edge) at the read position, 15 samples behind; hard sync, pulse
  width, sub toggling (once per cycle) and several edges per sample at the highest notes are handled as FL does. The step table
  is a Hann-windowed sinc (cut-off 0.707) integrated to a step response with 16384 positions per sample, 32 taps, made at start-up
  by FL's generator (0x31ac0); `junoex.ts` rebuilds it (bit-identical to FL's: 1 048 640 floats compared, hash pinned in the tests).
  The classic oscillators of `kepler.md` run when the option is off.
- **Master.** Volume and pan smoothing, MIDI volume / pan gains, master tune, the output high-pass flag (id 154:
  a flag read before the chorus), VCA smooth (the envelope-driven amplifier is filtered in 5 ms; the gate is never
  smoothed).

## The effect chain

Per sample after the decimator, high-pass and Juno chorus: saturation (pre) -> equaliser -> hyper chorus ->
delay -> reverb -> saturation (post). All run in single precision with the arm64 fused operations in the order of
FL's code; every effect is checked alone (a state with only that effect on) against 188 presets.

- **Saturation** (134 on, 135 amount, 136 pre / post, 152 HQ; `sat.ts`). Drive `g = tan(1.55 cbrt(amount))` (the
  targets for the control positions 396 and 5312 of 6000 are pinned in the tests: 0.7236034274101257,
  12.099364280700684), a one-pole smoother of 50 ms starting at 1, `y = tanh(3 x g) / (3 tanh g)` with FL's rational
  tanh; so small signals pass unchanged and a hard-driven signal is held to 1/3. HQ replaces tanh by its first-order
  anti-derivative anti-aliased form `(ln cosh x - ln cosh x1) / (x - x1)` (the mean's tanh when |x - x1| < 0.001) with
  Apple's tanhf / coshf / logf.
- **Equaliser** (100 on, 101..103 Q, 104..106 gain, 107..109 frequency; `eq.ts`, `eqdesign.ts`). Low shelf, peak,
  high shelf as direct-form-I biquads in series, gain -16..+16 dB (32 v - 16), frequency `20 2^(10.036 v)` Hz
  (20 Hz .. 21 kHz), Q `0.28 13^(v^1.28)`. The coefficients come from FL's generic closed-form designer
  (0x32048, a ~1100 instruction function with nine filter shapes of which three are used, double precision with libm
  exp / sin / cos / log / pow / cosh); `eqdesign.ts` is a machine translation of the arm64 code (`tools/a2c.py` in the
  scratch work) and was compared with the native function over 120 000 random vectors (0 differing float32
  coefficients); nine native vectors are pinned in the tests. The coefficients are stored in single precision.
- **Hyper chorus** (137 on, 138..148; `hyperchorus.ts`). Two banks of four lines (65536-sample buffers, cubic
  interpolation, per-line delay and two LFOs), the second bank on with "lines 8". The LFO phases come from libc
  `rand()` as it is in FL's process before anything seeds it (Park-Miller from seed 1: 16807, 282475249,
  1622650073...; the first bank consumes 16 values, the second the next 8; pinned in the tests). Output scaled
  0.5623 (one bank) or 0.2812 (two), a low-pass `714 2^(4.945 v)` Hz and a high-pass `12 2^(6.505 v)` Hz (cross-faded
  in over 10 ms) designed in double precision, mix equal-power, phase.
- **Delay** (110 on, 111 sync, 112 amount, 113 time, 114 right tap, 115 feedback, 116 feedback cutoff, 117 feedback
  filter LP / HP / BP / off, 118 stereo, 119 blur, 120 tone; `delay.ts`). The wrapper checks the settings every
  `trunc(sr / 500)` samples and cross-fades over 1000 samples between two time slots when the time or the right tap
  changed; free time `0.01 + 0.49 v` s, synced time from an 18-entry table of beats at the song tempo. The core takes
  the mono sum times the amount, adds the feedback (DC pole at 10 Hz, state-variable or band-pass biquad, a drive-
  and-ceiling saturator, a limiter, a 65-sample allpass), four blur rings read at 0.63 / 0.76 / 0.41 / 0.54 of the
  time, two tone poles and the stereo mix; the left echo arrives at three quarters of the time with the default
  right tap.
- **Reverb** (121 on, 122..133; `reverb.ts`). IL's plate reverb ("fxReverb": input high cut, allpass low cut, four
  input diffusers, an early-reflection line, predelay with feedback, Dattorro's figure-eight tank with damping and
  bass shelf, 7 + 7 output taps, M/S width), the same code as Transistor Bass's and Sawer's; the integer parameter
  laws and buffer sizes are FL's.

## Fidelity (TS vs FL, flfxhost, 44.1 kHz)

With FL's own tables (`flTablesSample` imported):

| case | result |
|---|---|
| 188 factory presets, one C5 note, effects off | bit-exact |
| each effect alone (EQ, saturation pre / post / HQ, hyper chorus, delay, reverb), 188 presets each | bit-exact |
| 188 presets through the full chain, loaded as states | bit-exact |
| the same loaded as FL's .fst files | 184 bit-exact; 4 FX presets differ in LFO phase (see below) |
| 188 presets with Options > Enhanced Oscillators, two notes | bit-exact |
| velocity, FL channel volume / pan / pitch, Mod X / Y, fine pitch, retrigger, HQ, ten notes on eight voices, 48 / 96 kHz, 100 BPM, parameter automation of delay time, EQ gain, delay amount, hyper chorus, saturation | bit-exact |
| every matrix destination (155 ids and the two pitch offsets) driven by a fast LFO at full amount, every one of the 24 sources into cutoff, pulse width and pitch | bit-exact (the Mono switch to 4e-28: denormal dust of the reverb after the engine reset) |
| 27 recorded scenarios (tests/gen/keplerexo.test.ts, hash of the whole render) | bit-exact |
| about 1000 random scenarios (every parameter, option and matrix slot at random values, random notes and tempos, parameter changes during the notes, sample rates from 32 to 96 kHz, also with the enhanced oscillators) | bit-exact except what is FL's own doing (below) |

What FL does that cannot be compared: the arpeggiator's random modes are seeded from the clock (reachable through the matrix
too), the test host now and then writes a bad file, drops a parameter event or crashes on extreme random states (every
discrepancy was re-rendered three times), a parameter event that does not change the value (automation of Mono to the value it has) still
runs the engine's reset, and below 44.1 kHz FL's hyper chorus and delay filters blow up to inf / NaN.

With the stand-in tables: residual -34 .. -52 dB on the recorded scenarios without LFO / noise dependence (the hiss floor
of -40 dB is the limit), median over the 188 presets -43 dB, 127 presets within -30 dB.

The .fst quirk: FL's file loader sets the four old-scale LFO rates of presets 103, 112, 113 and 120 (FX presets) before converting
them, which leaves their free-running LFOs in another phase for the whole note than a render of the same values loaded as
a state; the port (and the factory data in `presets.ts`) follows the state path.

## Approximations and what remains

- The LFO and noise tables (see `kepler.md`).
- Random arpeggiator modes use a fixed seed; FL's depend on the clock.
- Below 44.1 kHz the hyper chorus and delay filters are clamped to 0.49995 of the sample rate where FL becomes
  unstable (FL's output there is inf / NaN; only finiteness is guaranteed).
- Filter types 1 and 2 (hidden id 156) are not ported; the reverb reset (the mono switch) clears the reverb memory
  and filter states but leaves some write indices FL zeroes.
- The editor (1080 x 574) is original drawing at FL's form coordinates with the effects pages and the matrix.
