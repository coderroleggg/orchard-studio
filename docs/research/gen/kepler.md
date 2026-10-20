# Kepler (FL: Kepler) and the shared Kepler engine

Image-Line's Juno-6 emulation (Plugin database > Generators > Synth classic). Kepler and Kepler Exo are two
front ends of one C++ engine (`engine.dylib`, class `MyPlugin` on IL's d1framework `FLWrapperPlug`); this note
describes the engine and Kepler, `keplerexo.md` what Exo adds (second oscillator, matrix, effects). Everything
was decoded from FL 2026's arm64 libraries (otool listings, constants, jump tables, RTTI vtables, the engine
called natively through `dlopen` from C) and checked against FL's renders with the test host
(`.flref/host`, copied and extended with `--peek` to dump the engine's memory after every render call).

Files: `src/model/gen/plugins/kepler.ts` (def) + `kepler/{data,params,presets,texts}.ts`, `src/engine/gen/plugins/kepler.ts`
(GenModule) + `kepler/` (the engine, below), `src/ui/plugins/gen/kepler/index.tsx` + `keplercommon/`, tests
`tests/gen/kepler.test.ts`, `kepler-render.ts` (scenarios and host-emulating renderer), `kepler-render.golden.ts`
(numbers recorded from FL's renders), `kepler-model.test.ts`, `kepler-ui.test.ts`.

## Parameters and state

36 FL parameters (names, ranges, defaults, value texts from full test-host sweeps: 0 mismatches over 4.8 million
texts, hashed in `kepler-golden.ts`). The Pascal wrapper sends each as `(v - min) / (max - min)` (the chorus mode as
0 / 0.33 / 0.66 / 1) to the engine, which keeps its parameters as normalised floats in three arrays:
P (targets), A (applied, unmodulated) and B (applied, modulated; ids up to 156). Kepler is the Exo engine with a
36-entry id map (FL index -> engine id: 0:85 1:89 2:88 3:86 4:87 5:48 6:49 7:50 8:51 9:81 10:0 11:5 12:6 13:7 14:8
15:9 16:10 17:34 18:36 19:37 20:38 21:43 22:44 23:45 24:39 25:47 26:61 27:62 28:63 29:64 30:69 31:82 32:83
33:72 34:52 35:53); the engine ids Kepler does not expose keep its constructor defaults (`defaults.ts`: 260
floats for each build; no effects, DCO2 off, matrix empty except the two fixed Mod X / Y routes).

The state blob (wrapper record, version 4) holds the 36 floats and the Options switches that are not
parameters: arp first-step quantize, velocity to volume (engine id 73), sub-oscillator phase (id 11), chorus
noise (id 70) and noise gate (id 71), HQ (oversampling 4 instead of 2). 277 factory presets (decoded with FL's
own loader into data rows; the three preset-borne switches are stored with them). FL loads a state as
"parameters first, in id order", and Orchard does too (the order matters for the matrix, see Exo).

Kepler is flagged MIDI-out in the wrapper: the channel's volume, pan and pitch reach the engine as FPE_MIDI
events (volume / 127, pan (flags / 64 + 1) / 2, pitch cents / 1200 octaves), not as FinalLevels. Per voice the
wrapper passes key = trunc(Init.Pitch / 100), velocity = trunc(127 ln(10 v + 1) / 3.0445225) and, every render
call and only on change, FCut / FRes (Mod X / Y), the pitch beyond the key and the pan (`noteExpr` kinds 1..4;
the engine takes the first voice in its list with that key). A note on an already sounding (colour, key) first
releases the old one with the new velocity.

## Engine

- **Time.** One sample at a time (`process` 0x8508 -> `0x8918`). A parameter smoother (one pole per sample,
  coefficient `1 - 0.01^(1/(0.2 sr))`, snapping at 1e-4) glides only ids {10, 17, 32, 33, 35, 37,
  63, 67, 72, 138..148 except 144}; every other parameter acts at once. Everything that is routed through the
  matrix gets its value once per control period `trunc(sr / 1000)` = 44 samples (parameters first, then the
  matrix: a routed destination keeps its plain value until the first tick). The song time comes from the host
  (position while playing, otherwise a free-running counter; tempo-synced rates use its difference per sample).
  The seconds clock (the free-running arpeggio) is restarted from the host's milliseconds at every block; the wrapper turns them
  into samples at 44.1 kHz whatever the sample rate is and the engine divides that count by its own rate, so the clock runs
  fast below 44.1 kHz and slow above it at block starts (reproduced; found with 32 and 22.05 kHz renders).
- **Voices.** Eight (`Voice`, 0x32e8 bytes): allocation takes a voice already playing the key, else the one
  with the largest age; mono (Exo) uses voice 0 with the held-key list for legato and retrigger rules.
  Per voice: DCO1 (`SlaveOsc`), two envelopes, the noise generator, the filter lane, the amplifier, pan gains,
  a mod-matrix of its own (24 sources, Exo destinations) and the parameter copies the matrix modulates.
- **DCO** (`slaveosc.ts`, `blep.ts`): a phase accumulator in double precision raises events (two pulse
  edges, the wrap, hard sync); each event adds a band-limited step from a table (the 16th-order Butterworth
  impulse response, eight cascaded RBJ biquads in double precision, 1025 sub-sample rows, 16 or 32 taps; "eco"
  n = 2 by default, n = 4 in HQ) to a ring buffer and a leaky integrator turns the impulses into saw / pulse /
  sub. Everything runs at the oversampled rate (2x, HQ 4x) and a polyphase half-band decimator (six all-pass
  sections per side, `halfband.ts`) brings it back.
- **Filter** (`filter.ts`): one object per group of four voices (NEON lanes, run one by one with the same fused
  operations): the 4-stage transistor ladder in Zavalishin's TPT form with FL's tanh (a Pade 135135/... rational,
  clamped at +-5) at the input and in every stage, resonance k = 4.2 res, drive 2.745, selectable tap (6..24 dB),
  tan approximated by `x (2.4716885 - 0.18975969 x^2) / (2.467401 - x^2)`. The cutoff is `2^curve(x)` Hz with key
  tracking, envelope, LFO and Mod X.
- **Envelopes** (`env.ts`): attack `v += (1.7 - v) a` until 1 (a = 1 - 0.41176472^(1/(t sr))), decay
  `d *= 0.1^(1/(t sr))`, `v = s + (1 - s) d`, release `v *= 0.1^(1/(t sr))` (-20 dB per t); the amplifier either
  follows the gate (smoothed to 90 % in 2.5 ms) or `velocity x max(env - 0.025, 0)` (Exo's "VCA smooth" option filters that
  envelope signal, not the gate, to 90 % in 5 ms); the pan gains glide in 5 ms. Time and cutoff curves are
  ten-segment piecewise-linear tables read from the binary (`tables.ts`).
- **LFO** (`lfo.ts`): double-precision phase, free-running or restarted by note / trigger, a delay fade,
  tempo sync from the song time. LFO1 yields a triangle and a table sine, LFO2 six shapes (Exo). The table sine is
  FL content (see below).
- **Chorus** (`chorus.ts`): the Juno-6 chorus: stereo summed to mono, 50 Hz high-pass, two 7 kHz low-passes, two delay
  lines of 1.08..5.23 ms swept by triangles of 0.4 Hz (I) or 0.6 Hz (II) (I + II: 8 Hz sine, 2.85..3.37 ms), right
  line offset in phase, no feedback, equal-power dry / wet; a mode change fades out, switches and fades in
  (200 / sr per step); the optional chorus hiss is filtered LCG noise whose peaking gain follows the LFO.
- **Arpeggiator** (`arp.ts`): four note lists (as played, newest first, ascending, descending), range 1 / 2 / 3
  octaves, up / up-down / down in Kepler (Exo adds three random and three "as played" modes), gate, free (s) or
  tempo-synced (beats) clock, hold, optional first-step quantize. FL seeds the random modes from the clock; the
  port uses a fixed seed.
- **Output.** High-pass (one pole), the chorus, master volume / pan smoothing, then the MIDI volume and pan gains
  (the first note settles them when the engine has rendered less than 0.2 s, as FL's long-running engine has).
- **Arithmetic.** Single precision with the arm64 fused multiply-adds emulated exactly (`fmath.ts`), Apple's libm
  float functions ported instruction by instruction with their tables (`applemath.ts`: sinf, cosf, sincosf, tanf,
  expf, exp2f, exp10f, logf, powf, tanhf, coshf; they are not correctly rounded and FL calls them).

## FL content: the two tables

The engine library carries two tables: an LFO sine of 2170 signed 16-bit points (an analog-looking sine, min
-32768, max 30425, 3% second and 1.3% third harmonic) and a recorded noise loop of 682245 points (the hiss of the
oscillator mix: the noise level has a floor of 0.01, so it is always present at about -40 dB). Neither ships
with Orchard. By default a synthesised stand-in is used: a sine with the same harmonic character for the LFO,
a hashed, two-tap-smoothed noise of the same level and colour for the noise. "Import FL content..." in the
editor's menu reads `engine.dylib` from the user's own FL Studio install (either plugin folder), finds both tables
by fingerprint (a defensive window scan, nothing is parsed), packs them into one float pool sample under the state
key `flTablesSample` and the engine switches to them. With them the render equals FL's bit for bit.

## Fidelity (TS vs FL, flfxhost, 44.1 kHz, 130 BPM, one C5 note unless noted)

With FL's own tables:

| case | result |
|---|---|
| all 277 factory presets, C5, 3 s | bit-exact |
| velocities, FL channel volume / pan / pitch (MIDI events), Mod X / Y, fine pitch, release velocity | bit-exact |
| HQ, 48 and 96 kHz, 100 BPM, parameter automation, ten notes on eight voices, retrigger, hold | bit-exact |
| arpeggiator up / up-down / down x 1..3 octaves, chords, first-step quantize | bit-exact |
| 22 recorded scenarios (tests/gen/kepler.test.ts, hash of the whole render) | bit-exact |
| about 400 random scenarios (every parameter and option at random values, random notes and tempos, parameter changes during the notes, sample rates from 32 to 96 kHz) | bit-exact except what is FL's own doing (see keplerexo.md) |

With the stand-in tables (tests/gen/kepler.test.ts, recorded samples): residual -34 .. -66 dB for the
presets whose sound does not depend on the LFO or the hiss (Default -44 dB: the hiss), for example AceBass
-67 dB, J6 Organ 2 -60 dB, Twanguitar -59 dB. Patches that modulate the pitch with the free-running LFO drift
in phase (a deviation of 0.01 semitone is a full cycle of the waveform in a second); over the 277 presets, with the
three-harmonic stand-in for the LFO shape: median -23 dB, 149 presets within -20 dB, 209 within -10 dB (a plain sine gave
-8 dB and 108 within -20 dB). The sound is the same character in every case.

## Approximations and what remains

- The two tables above (user import closes the gap).
- Arpeggiator random modes use a fixed seed (FL: the clock).
- FL itself is not deterministic in rare cases: in about one of thirty renders of a chord arpeggio the oscillator phase of
  the first voice came out different (the cause is not known; the common result is what is reproduced), and the test
  host sometimes writes a corrupt WAV or crashes on extreme random states; the recorded scenarios were checked by
  repeated renders.
- Filter types 1 and 2 (hidden engine id 156, used by no preset and not exposed) are not ported.
- The editor is original drawing at the form's coordinates (1080 x 217): the panel style follows FL's thumbnail,
  the labels the strings FL's code paints.
