# Transistor Bass (FL: Transistor Bass)

FL's TB-303 emulation (Image-Line, FPC wrapper `Transistor Bass_x64.dylib` around a C++
engine `engine.dylib` built on the "d1framework"; its filter and halfband code derive from
Robin Schmidt's Open303 and musicdsp). Plugin database: Generators > Synth classic. Everything
below was decoded from FL 2026's arm64 `engine.dylib` (otool listings, constants, RTTI
vtables) and checked against FL's own renders with `flfxhost` at 44.1 kHz.

Files: `src/model/gen/plugins/transistorbass.ts` (def), `.../transistorbass/{data,factory}.ts`,
`src/engine/gen/plugins/transistorbass.ts` + `.../transistorbass/{engine,delay,reverb,wavetable,plugin}.ts`,
`src/ui/plugins/gen/transistorbass/index.tsx`, `tests/gen/transistorbass.test.ts`.

## Parameters

42 parameters in FL's order (index = form Tag), all 0..65536 except Tuning 0..24576 and the
switches 14 / 27 / 32 / 33 / 41 (0..1). The engine gets value / max as a float. Value texts
(full sweeps, 0 mismatches): FL rounds half away from zero and prints no `-0`:
Tuning `(v-12288)/1024` `"%.2f Semitones"`; Waveform `"N% Pulse"` below 32768, `"N% Saw"` above;
Cutoff key follow bipolar `%`; PW `50 + 45 v/65536 %`; dry / ER / wet `42 v/65536 - 36 dB`, 0 = `-inf`;
delay time synced = FL's 18-entry table (index `round(17 v/65536)`, entry 7 is FL's `1/3`,
1/3 of a whole note), free `10 + 490 v/65536 ms`; others `%.1f%%`.

Non-parameter state (FL's state blob, decoded): engine (0 V1 Legacy, 1 V2 Extended cutoff range,
2 V2 TB303 cutoff range), sequencer switch, auto follow, current program, 128 programs (patch,
sequence, transpose), 128 patches (stored + edit buffer: the parameters are the edit buffer,
READ restores the stored patch, WRITE stores; WRITE lit while they differ), 128 sequences
(name, length, 32 steps of pitch / gate / slide / accent, BPM, internal BPM, shuffle, gate),
layout (FL's four "show panels" layouts) and theme. Stored sparse (base patch + entries).

Presets: FL's three (Empty, Factory programs, Sequencer off). FL's plugin database entry
`Transistor Bass.fst` is byte-identical to "Factory programs", so that is the insertion state
(params' `def` = its program 65 "Nucleon"). These version-3 states select the **V1 Legacy**
engine in FL (setState: version < 5 -> engine 0); a raw new instance uses V2 Extended.

## Engines (exact ports)

V2 (`TB303Engine2`), per host sample: PW LFO (sinf, 0.1..10 Hz, x0.24), pitch glide
(`1 - 0.1^(1/(t sr))`, 0.1 ms, slides 50 ms), note pitch = note + bend - 36 + 24 tuning, mip-mapped
saw (48 quarter-octave levels built at load: 1024-point ramp, hann^2-windowed sinc kernels,
x16 tables), pulse = saw(phase) - saw(phase + PW), waveform blend, negated; filter envelope
`env *= 0.1^(1/(T sr))` with T from FL's Decay table and Minimum decay (accent: minimum decay);
accent "wow" RC circuit (resonance and accent pots, 47k/50k/100k, 1 uF); cutoff
`8.1758 2^(128 x/12)` with x = env mod (env - 0.325) + 0.75 wow + cutoff + 0.1 + key follow +
Mod X; cutoff / env mod laws differ per engine (Extended: x0.7; TB303: FL's 5-point tables);
resonance table; Open303 TeeBeeFilter (TB_303 mode, rational approximations, 160 Hz feedback
high-pass), 4x oversampled; VCA = max(main env, 3 acc env2, gate-off 1.75 acc env3) through
0.3 / 10 ms one-poles and the Clicks one-pole (0.1 + 50 c^3 ms); one-pole high-pass
10 + 390 HP Hz; volume 0.75 v; RAT distortion (gain 1 + 2305 d^3, 7.2 / 60 Hz / user high-passes,
drive low-pass table, 300000/sr slew limit, tanh, tone 475 + 19000 t^2 Hz, level exp2);
decimation by two musicdsp polyphase IIR halfbands (steep, order 12).
V1 (`TB303Engine1`): same parts, its own cutoff (0.1 + 0.58 v^1.5), env mod, decay
(0.185..2.16 s), accent and a per-oversampled-sample VCA (5 / 5 ms, Clicks 5..15 / 5..50 ms).

Plugin layer (FL wrapper + "MyPlugin"): notes -> mono note counter (slide while held, gate off at
the last release), velocity `127 ln(10 InitVol + 1)/ln 21`, accent at velocity >= 110 (110/127)
or accented steps; colour 12 (MIDI channel 13) sets the sequence transpose; FinalLevels per
block: Mod X -> cutoff, Mod Y -> resonance (V1), pitch offset, sqrt pan law; channel volume as
FL's FPE_MIDI_Vol (integer knob/100 -> CC 7 / 127, -2.076 dB at FL's default channel);
parameters through FL's smoother (16-sample steps, `1 - 0.01^(1/(0.005 sr))`, snap 1e-4;
switches at once); program switch on notes with the sequencer on (program = key), patch loaded at
once; one-second tail counter. Delay: FL's ILDelay3 engine as configured (two crossfade slots,
0.3 s crossfades at time / right-tap changes checked at block starts, interpolated slot 0,
whole-sample slot 1, 10 Hz DC blocker at 44.1 kHz coefficients, Chamberlin low-pass at FL's
270..22000 Hz table, soft saturation, limiter, 65-sample allpass slot). Reverb: FL's fxReverb
(Ultrafunk plate, C++): integer parameters, Dattorro tank with FL's buffer layout and
decrementing indices, mixed diffuser coefficients, one ER tap per side (FL's loop zeroes the
other seven gains), predelay feedback, stage-blended taps, wet slew, M/S width, buffers filled
with 1e-30. Sequencer: FL's arpeggiator class in sequencer mode (step from 0 at the note, FL
tempo or the sequence BPM, 16th steps, shuffle `s = 1 - shuffle/2` pairs, gate in steps, slide
= gate held into the next step).

## Fidelity (TS vs FL, flfxhost, 44.1 kHz)

| case | residual |
|---|---|
| V2 default note (FL's constructor state) | -78 dB in the first 10 ms (onset), -124..-134 dB after |
| V2 accent / max resonance / slide / saw / key follow / HP / clicks / distortion | -77..-110 dB first 50 ms, -126..-140 dB after |
| parameter automation (`--at`, smoother) | -114 dB |
| V2 TB303 cutoff range (crafted v5 state) | -101 dB |
| V1 engine ("Sequencer off" preset; accent, resonance, clicks, distortion) | -150..-215 dB (bit-exact) |
| Factory programs, sequencer + distortion + delay + reverb (programs 0..65) | -62..-124 dB relative |

## Approximations

- **303 Pulse**: FL plays 55 single cycles recorded from a TB-303 (WAV files embedded in the
  engine binary; never copied). A synthesized substitute (rounded 66 % pulse) plays instead.
  TODO: optional import from the user's own FL install.
- The engine runs only while the channel renders; FL keeps it running one second after
  creation, so free-running oscillator / LFO phases at the first note can differ.
- FL's constructor state quirk (the decay knob ignored until Decay / Minimum decay change)
  never shows here: every state comes from FL's database preset or a project.
- Editor: original drawing at the form's coordinates; theme colours approximate except Blue.
