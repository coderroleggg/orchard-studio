# Sytrus (FL: Sytrus, Plugin database > Generators > Synth classic)

Six operators (table oscillators with FM / RM / noise / plucked string), three
filters, a 9 x 9 FM / RM / routing matrix, articulators (envelope, LFO and six
mappings per modulation target), unison (normal and OSC), chorus, three delays,
reverb, 3-band EQ, oversampling. Reverse engineered from FL Studio 2026's
`Sytrus_x64.dylib` (arm64 slice; addresses below are slice addresses) and
measured with the test host (`flfxhost render Sytrus`).

| Part | Files |
|---|---|
| Definition, 597 parameters, value texts, preset list | src/model/gen/plugins/sytrus.ts |
| State model / defaults / repair / preset bank | src/model/gen/plugins/sytrus/{types,defaults,normalize,codec,inflate,presets}.ts |
| DSP | src/engine/gen/plugins/sytrus.ts, src/engine/gen/plugins/sytrus/{patch,voice,env,shape,fft,filter,fx,reverb,random}.ts |
| Editor | src/ui/plugins/gen/sytrus/ (form layout, kit controls, original drawing) |
| Tests | tests/gen/sytrus.test.ts, tests/gen/sytrus-editor.test.ts |

## State

FL's automatable parameters (597, index order and names from the plugin) are
the flat parameters. Everything else FL saves in its state blob (version
0x190003, zlib): matrix (FM, RM, mute flags), operators (ratio x10000, offset,
NS, SH TN SK SN FL, HALF EVEN ABS GLOBAL CENTER DECLICK PLUCK BAND LIMIT, 256
harmonic amplitudes / phases), filters (type 0..12, HQ, FLAT, WS on / bipolar,
WS curve), articulators, globals (quality, RANDOM, MONO KEY, GLOBAL PITCH, OSC
unison, CENTER, GIBBS, porta options, velocity links, EQ mode / types), delays,
reverb and the info text is `sy` (sytrus/types.ts). Articulators are stored
compactly: a curve equal to FL's default for its slot is `null`, an articulator
at its defaults is `null` (`artEnv` / `resolveArt` resolve them). Curves keep
FL's point format `[dt, y, tension, segment, arp, flag]` and markers
`[flags, enabled, decay, loop, sustain]`; the first point's dt is kept (an LFO
curve may start late).

Factory presets: all 984 .fst files were loaded in FL's Sytrus, saved in the
current format and converted (scratchpad tools); the bank is one deflated
binary (presets.ts, 650 KB: deduplicated harmonic sets as 16-bit log codes,
deduplicated curves, per preset the differences from Default).

## DSP (exact ports unless noted)

| What | FL |
|---|---|
| Gen_Render: voices newest first, each for the whole block; decimation; FX; global CENTER | 0x823a0 |
| TriggerVoice: unison (detune tables, phases, sub voices one octave lower in key), OSC unison links, MONO KEY, porta | 0x796e0 |
| voice init (articulators, operators, noise, pluck, declick / soften, filters) | 0x7a3b0 |
| routing lists (active / per-sample operators, FM records) | 0x7c320 |
| control tick (articulators, ramps, porta, damp, voice end) | 0x80f40 |
| audio: table select, per-chunk increment / wrap, OSC unison sums, CENTER, declick, filters, mix | 0x7f740 |
| FM / RM / noise / pluck kernel (per sample, operators in index order) | 0x7f050 |
| plain operator kernel (groups of 4, float positions) | 0x7f430 |
| band-limited table select, FM gains in table units | 0x79450 |
| plucked string init / retune (delay line + one-pole loop filter, IPP noise fill) | 0x78f50 / 0x79310 |
| envelope compile / eval / init / release / point value, curve setup | 0x272580 / 0x274ed0 / 0x274a50 / 0x274cd0 / 0x2741b0 / 0xbf4c0 |
| LFO init / eval (phase runs once the amplitude curve leaves its first point) | 0x277db0 / 0x277e60 |
| map reader (key / velocity / X / Y / random / unison tables) | 0x274a50 + 0x275dd0 |
| ramps: per-chunk gain ramp, per-tick parameter ramp | 0x8eb60 / 0x8ec40 |
| stereo mix kernels (ramped: double gain stepped after each sample; constant; unity) | 0xc09a0 -> 0x8d200 / 0x28cc / 0x8d370 |
| filters (12 types, x1..x3, ALT, FLAT, HQ, waveshaper) | 0x7d390 and following |
| chorus / delays / reverb / EQ | 0xbfc40, delay and reverb units in the FX code |

Numerics follow FL instruction by instruction (float32 vs double, frintx =
round half even, fused multiply-adds where FL fuses). Notable details:

- Noise: Sytrus's global LCG `s = s * 0x08088405 + 1` (seed 0 at load), read
  as signed; it is shared by all voices, so the voice order matters (FL renders
  every voice for the whole block, newest first; OSC unison masters render
  their linked voices chunk by chunk before themselves).
- Plucked strings fill the delay line with `ippsRandUniform_Direct_32f` of FL's
  IPP library (four LCG lanes x 1664525 + 1013904223, output `u * 2 + 1`,
  seeded with the start phase), measured equal to the library.
- Random mappings use Free Pascal's `Random` (Mersenne Twister). FL randomizes
  its seed when the plugin loads (renders of the same preset differ from run to
  run in the test host), so each instance starts from a random seed.
- PORTA: the previous note's pitch offsets every operator pitch envelope (1
  octave = 0.5), faded by the point weights over the attack; PORTA VAR scales
  the attack by the interval; porta limit; key tracking from the old note.
- OSC unison: operators of all unison voices are summed (`ippsMulC_32f`, then
  fused `ippsAddProductC_32f`) into the first voice, which alone runs the
  filters and output (centred, unison volume 1).
- Output gains ramp per audio chunk toward the tick's target (max 0.001 x
  44100 / rate per sample), flushed below 2^-24.

## Fidelity

Method: every factory preset, C5 velocity 100 held 1 s, 2 s rendered at
44.1 kHz in FL (test host, live quality) and in our engine with the host's
block structure (0.25 s preroll in 512-frame blocks, then blocks of up to 512
frames from t = 0 cut at note events). Residual = RMS(ours - FL) / RMS(FL) over
the whole render (stereo); level error = RMS-weighted mean |dB| difference in
20 ms windows.

| Set | Presets | Median residual | <= -80 dB | <= -60 dB | <= -40 dB | <= -20 dB | level within 0.1 dB |
|---|---|---|---|---|---|---|---|
| deterministic (no random mappings) | 920 | -85.3 dB | 605 | 804 | 869 (94.5 %) | 902 | 912 |
| with random mappings (FL itself differs per run) | 64 | -8.6 dB | 7 | 7 | 9 | 17 | 19 |
| all | 984 | -84.3 dB | 612 | 811 | 878 | 919 | 931 |

By feature (deterministic presets with residual <= -40 dB / total, median):
none 23/23 (-97), arp points 65/72 (-82), chorus 602/643 (-85), delays
478/518 (-83), EQ 497/534 (-82), filters 614/648 (-83), porta 19/21 (-82),
LFO 344/377 (-81), noise 180/192 (-85), pluck 70/74 (-89), RM 54/56 (-79),
unison 417/451 (-82), reverb 374/400 (-81). Examples: Default -100 dB,
Piano/E-grand -103, Plucked/Classic -101 (IPP noise), FX/Reactor -115 (noise
with unison), Arp/Acid 4 -99 (OSC unison), Bass/Synth 7 -84, X Saif Sameer/
Basses/Rocker Bass 1 -87, Short synth/Celestial 3 with a legato second note
-81 (porta). tests/gen/sytrus.test.ts pins FL's samples for these.

Remaining differences (residual above -40 dB, 51 deterministic presets):
- Operator waveform tables are computed in double precision; FL's come from its
  single-precision (vDSP) FFT with ~1e-7 roundoff (FL's sine table has -2^-23
  at phase 0). Identical to the ear, but chaotic FM (cross-feedback loops, self
  FM at full level) grows the difference: e.g. DX7 Boxed (-19.5 dB, o5 <-> o6
  loop), Satan FM, Pure FM 2, Sweeper (self FM 256 with unison phases).
- The rest (SY99 Grand Piano mk I-V, Hydronium, Guitar/Electric 4, Larga, Arp/
  Stairs, Big layer, Fantasy Harp ...) are not yet diagnosed; most combine
  unison, LFOs, delays and chorus.

## Not ported / approximated

- Arpeggio points in envelopes (stepping through the held chord, 0x274fa0):
  single notes are unaffected (FL's arp count stays unset), chords differ.
- Live unison updates (0x80c50: unison pan / volume / pitch changes reach
  playing voices); ours apply at note start.
- FL's porta note flag (host voice parameter 2 == 14 toggles porta per note);
  PORTA follows the switch only.
- Random mappings: FL's generator and per-call order are ported, its random
  seed is not reproducible (FL itself is not).
- Waveform table roundoff (above).

## Editor

Built from FL's editor form (`SynthEditorForm`, 845 x 450; control positions
from the DFM), kit controls and original drawing; colours from the form and
FL's 178 x 113 thumbnail (read only). Pages MAIN, OP 1-6, FILTER 1-3, FX; the
matrix (drag, double-click / Alt-click clears, FM / RM, mute menu); articulator
target / part selectors and the curve editor drawing with the engine's segment
code (13 point types, tension handles, markers, snap / slide / freeze); harmonics
(magnitude / phase bars); options menu, info and routing overlays, test
keyboard. Approximated: routing overlay is a list, keyboard is click-only,
reverb value texts, ratio / offset field formats; missing: FL's unison / chorus /
reverb presets and the harmonics convert / analyze / export functions.
