# Sakura (FL: Sakura)

Image-Line's string physical-modelling instrument (Maxx Claster's "hanami-go" method: Touch ->
Vibration -> String interaction -> Resonance -> Acoustics). `Sakura_x64.dylib` holds the Delphi
editor and the wrapper, `engine.dylib` the C++ engine (`CSakuraSynth` / `CSakuraKey` /
`CStringDelay` on IL's `CSynthesizer` / `CFLWrapper` framework, with the `CTapeDelay` / `CChorus`
/ reverb classes PoiZone, Toxic Biohazard and Sawer share). Plugin database: Generators > Synth
special.

**Sakura renders silence in FL's test host**: the plugin reports `DemoVersion` and its licence
check (`FHD_CheckProdCode`, plus an AES layer inside the engine) mutes it outside a registered FL.
The check was neither patched, nor faked, nor worked around, and no program that runs FL's engine
code to produce reference renders was built either (that would sidestep the check the same way).
So no FL render of Sakura exists here and none of the DSP below could be compared with FL's
output. Everything was decoded from FL 2026's arm64 code by static analysis (otool listings,
constants, RTTI vtables, function matching against the PoiZone / Toxic / Sawer engines whose ports
are verified, and a block-local symbolic lifter for the NEON-heavy functions); parameters, value
texts and presets come from the test host's `info` / `sweep` / `--preset` (they work without
sound) and FL's preset files. Nothing of FL's licence layer is replicated: Orchard's Sakura never
mutes.

Files: `src/model/gen/plugins/sakura.ts` (def), `.../sakura/{data,presets}.ts`,
`src/engine/gen/plugins/sakura.ts` + `.../sakura/{plugin,core,fx}.ts` (with
`../poizone/{dsp,applemath}.ts` and `../toxicbiohazard/reverb.ts`),
`src/ui/plugins/gen/sakura/{index.tsx,layout.ts,skin.tsx,art.tsx,hint.ts,sakura.css}`,
`tests/gen/sakura.test.ts`.

## Parameters and state

- 207 FL parameters: the 78 synth parameters (raw 0..256, engine value = raw / 256), MIDI CC
  0..127 (FL parameters 78..205; raw / 256 x 127 sent as MIDI CC, CC 7, 10 and 32 not passed:
  `CFLWrapper`, the code PoiZone and Sawer share) and channel aftertouch (206). Value texts are
  the Delphi wrapper's: percent with one decimal (Delphi rounding: half away from zero), Off / On
  for the 8 resonators, delay, chorus and reverb switches, "+" / "-" for the four "inverted"
  switches, chorus rate `round(0.1 + 5 raw / 256)` + "Hz" (the engine's rate is 5 v + 0.1 Hz; a
  plain `round(5 raw / 256)` differs at 25 points), CC 0 shows its raw integer and every
  other CC / the aftertouch "0". All 207 x 257 sweep points of the test host were compared with
  the port's texts, 0 differences; the tests pin them by rule for every text kind plus sampled
  points. Loaded presets show the integer part of engine value x 256 and treat any non-zero switch
  value as on (checked for all 501 presets x 78 parameters against `flfxhost info --preset`).
- State: `hidden` = engine values 78..113 (36 numbers): 78 a constant 0, 79..110 the eight
  modulation slots x (source 0..8, amount 0..1, phase 0 / 1, destination 0..14), 111 the string 2
  ratio index (4 : 1, 3 : 1, 2 : 1, 1 : 1, 1 : 2, 1 : 3, 1 : 4), 112 the delay sync index (---,
  1/16, 2/16, 3/16, 1/4, 2/4, 3/4, 4/4, 8/4, 16/4), 113 the transpose wheel (octave = trunc(6 v)
  - 3). Sources: "..." (off; the form's text, the manual says "---") / envelope / lfo / mod whl / ptch whl
  / aftch / velocity / key num / release; destinations: lfo ampl / level / pan / pitch / lo-cut ctf / hi-cut ctf / hi-cut atk /
  hi-cut dec / str1 decay / str2 decay / stri1&2 dec / str1 damp / str2  damp / str1&2 dmp / noise
  rate.
- FL's chunk: magic `1rkS` (FL also accepts `DrkS`, the trial build's magic, same layout), 114
  float32 engine values in order, a 128-byte name at 460 (588 bytes). Unlike PoiZone / Sawer
  there is no CC map. Loading calls `setParameter(i, v)` for i = 0..113.
- 501 factory presets (`.fst`, data only, decoded into `presets.ts` by a deterministic generator;
  11 folders: Sonic Haiku Bank 160, Eastern Dreams Bank 139, Default 106, Xenos Soundworks Vol1 32,
  String 16, Bass 14, Keyboard 12, Atmosphere 9, Pads 5, Prc 4, Sfx 4). Particulars of FL's
  files, kept: 106 presets hold free floats on switch parameters (the engine rule is v != 0 = on),
  5 hold a chorus value between 0 and 1/256 (still "On"), 3 names contain a double space
  ("Clavi-Funeral  DS", "Clavi-Party  DS", "Semi-Guitar  DS"). FL's plugin database entry is the
  preset "Default/Bowed 6" (0 differences): the insertion state.

## Engine (static port)

- Plugin layer (`plugin.ts`): the `CFLWrapper` port of PoiZone / Sawer: FL voices become MIDI notes
  (key = trunc(pitch / 100), velocity = trunc(41.71426 ln(10 InitVol + 1)); a new voice on a
  sounding key first sends its note off), per-key FinalLevels (pan law gains, pitch offset, cutoff
  and resonance) are copied into the engine each render call, blocks of at most 64 samples, CC /
  aftertouch parameters sent when they change.
- CSynthesizer layer: note on (velocity / 127; velocity 0 = release), note off, CC (value / 127),
  channel aftertouch, pitch bend (never sent by FL's channel: it bends through the voices' pitch,
  so the "ptch whl" source stays 0, as in FL). 99 keys (voices); a note takes a free key, else
  the oldest (allocation counter); a note off releases every active key on that note. Output gain
  = CC 7 x master level (10^(4.8 v - 1.8)), balance from CC 10.
- Rendering: the engine runs at 48 kHz internally, whatever the host rate, in blocks of at most 64
  host samples (the 48 kHz block length follows from the linear-interpolation resampler's
  position, chunks of at most 48 host samples, carry, ring buffers). All keys prepare their
  coefficients once per block, the active keys are rendered in groups of four (FL's NEON loop; a
  group is padded with idle keys of the pool, then three sentinels; the first group overwrites
  the block, the next accumulate), and a key whose output stayed below 1e-8 for 1001 samples is
  freed. Then the host-rate block goes through the effect chain and the output gain.
- Per key and block (`prepare`, FL 0x6630): the string loop's iteration rate `iter` = f / (48000
  / length) x 2^((tune + FinalLevels pitch) / 12 + pitch modulation / 6) (tune: +-99 cents in steps
  of 1 cent); the amplitude one-pole (attack toward 5, clipped at 1, at 4.66e-6 / T per
  48 kHz sample; decay toward the sustain at 1.84e-4 / T; release toward 0 at 1.84e-4 / T; T = 35 v^5
  + 0.001, 50 v^5 + 0.001, 10 v^5 + 0.1 s); the free EG (attack 10 v^3 + 0.001 s, decay 50 v^5 +
  0.001 s, sustain v^2, release 50 v^5 + 0.1 s) and the global cosine LFO (10 v^3 + 0.01 Hz, its
  amplitude is the matrix' "lfo ampl"); the noise threshold (1 - rate)^(1/4) x 0.996; the Hi-Cut
  cutoff scale (one-pole segments: attack of a^2 / 2 s, then decay toward sustain^2 at 2e-4 / (3
  d^3 + 0.001), 2e-3 after the note off), the ladder gain min((hiCut + mod / 2)^2, 1) and its
  resonance feedback max(10 res (gain - 1), -4); the Lo-Cut 2-pole high-pass (f = 2^(9.3 c + 5)
  Hz with c = lo-cut + mod / 2 clamped to 0..1, q = 1 + 10 res); each string's two damping filters
  (coefficient min(2^(14.5 - 5.08 d^3) / 22050, 1) with d = damping amount + modulation, the
  second rail's is (1 - offset^2) of it, sharpness^2 is the filter feedback), its decay gain
  (decay + modulation)^0.05 (negated by the "inverted" switch, smoothed per iteration) and the
  stereo gains (mix, spread by pan, 10^(2 level modulation) x 0.05); comb level and feedback with
  their sign switches. The modulation matrix (`getMod(dest)`, FL 0x6f4c) sums, per destination,
  the slots' sources (EG, LFO, mod wheel CC 1, pitch wheel, aftertouch, velocity, key number x
  0.0125, release flag) x amount^2 with the phase switch's sign; "lfo ampl" and "level" read 1
  when no slot targets them.
- Per 48 kHz sample (`process4`, FL 0x1a110): four keys in lock step. Engine-wide LCG noise (one
  static generator, seed 1935757395, four draws per sample, one per lane); a draw replaces the
  key's held noise value only above its threshold (so the noise rate sets how often the noise
  changes). The exciter noise (1 - c)^2 + c (c = the Click / Noise slider, raw 256 = click) passes
  the Lo-Cut high-pass, the Hi-Cut ladder (four one-poles with resonance feedback and the envelope
  scaled cutoff) and the saturation x / (1 + drive x^2). Each key then runs its string loops
  `iter` times with a fractional accumulator (the pitch is fine-tuned by the iteration rate): four
  ring-buffer rails of the loop length (A, B string 1; D, E string 2, whose length follows the S2
  ratio), each a damping filter (two states) + saturation x / (1 + sat x^2) + the smoothed decay
  gain + the exciter term (exciter minus its one-pole of rate 1 / length), and two comb buffers
  (C, F; comb ratio x loop length; feedback and level with signs) added to the rails' output; the
  output interpolates the last two iterations' stereo results and multiplies the key's amplitude.
- Effects (`fx.ts`, the container at FL 0x3f024): DC high-pass 32 Hz per side (IL's `PzCut`), the
  8-resonator bank (16 string-delay "tapes", A / B pair per resonator: frequency coefficient
  1 - v^0.1, feedback sqrt(v) x 0.9999, the B delay fed with minus A's output, stereo weights
  0.75 / 1.25 alternating, the result through a 32 Hz high-pass added to the dry sound), IL's
  three-tape chorus (PoiZone's `PzChorus` with the depth law v^3 in float, as Sawer), the plate
  reverb (Toxic Biohazard's verified `TxReverb`; mix 0.999 v + 0.001, decay 0.6 v^3, colour v^3)
  when on, and the delay when on (six `PzTape`s, three in series per side; rates v^2 x 20 and
  x 1.1, time v^2 + 0.01, feedback -0.99 v^2, depth v^4, wet / blur laws, tempo sync
  0.5 / (tempo x factor) for 1/16 .. 16/4).

## Editor

SynthEditorForm 855 x 532 at the form's coordinates: all 78 parameters on their controls
(knobs, sliders, the Click / Noise slider with CLICK at the top as the manual says, switch LEDs,
the string 2 ratio and delay sync digi wheels that also open their list on a click, the 8 matrix
combos with source / destination / amount / phase, the transpose wheel, the analog level meter
and the hint display), the hidden settings edited through undoable edits, the options menu with
FL's "Convert old presets" (disabled: Orchard reads every preset directly). Original drawing in
the form's colours (crimson bands with a blossom logo, silver zones, the string and damper picture
whose bells follow the six damping knobs); no Image-Line artwork. Open it in the app gallery with
`/?fxgallery=sakura`.

## Fidelity vs FL

- Exact (compared with FL's data): parameter list, names, ranges, defaults, value texts (all
  sweep points), the 501 presets (the decoded float32 values, pinned by checksums) and the
  insertion state; the chunk layout; the shared code of the CSynthesizer / wrapper / chorus /
  tape delay / reverb / DC filter classes (function for function identical to the PoiZone / Toxic
  / Sawer ports, whose engines are verified sample for sample against FL), Apple libm calls
  (`powf`, `exp10f`, `cosf`, `sinf`, `logf`) as in those ports.
- Unverified (no FL render possible): everything specific to Sakura's DSP: the key's exciter,
  noise hold, Lo-Cut / Hi-Cut, the string loops, damping, comb, amplitude and release logic, the
  modulation matrix and per-block coefficient laws, the 48 kHz rendering order, the resampler,
  the resonator bank, the delay network's wiring (the tape classes themselves are shared), the
  gain stage. The port follows FL's instruction order and float / double precision (fused
  multiply-adds emulated), so it should be sample-exact where the decoding is right, but no
  residual against FL can be stated and no error bound is claimed. The tests check invariants
  instead: silence without notes, pitch of keys 36..84 within 1.2 %, finite deterministic
  output, strings that sustain when lossless and end after the release, decay / damping / click
  vs noise / amp envelope / master level / transpose / S2 ratio behaviour, the modulation matrix,
  chords and polyphony limits, effects, every preset kind rendering.
- Review: the port was transcribed from the lifted instruction streams and then compared against
  them a second time, function by function (key note on / off and reset, the per-block
  coefficients, the modulation matrix with its jump table, the four-key sample loop, the block
  dispatcher and resampler, the 114 parameter laws via their jump table, the output gain, the
  effect container, the resonator bank and its string delays, the key constructor's initial
  values); every numeric literal was checked against the listing. The second pass found one
  difference, in the delay's behaviour for out-of-range sync indices (fixed; the editor cannot
  produce them). The sound of the factory presets was checked by survey only (finite, pitched,
  audible, plausible envelopes), not against FL.

## Approximations and limits

- Doubles use JavaScript's `Math.pow` / `sin` / `cos` where FL calls Apple's `exp2` /
  `__sincos_stret` / `cos`: at most 1 ulp apart, only visible through float rounding in rare
  samples. Float fused multiply-adds go through double arithmetic (the double rounding differs
  from a true float FMA in about 1 case in 2^29).
- Unknown FL state: the engine's polyphony setting is read at construction from a field of FL's
  host object (not decodable statically), clamped to 1..99; Orchard uses the maximum, 99 keys,
  and the channel's own polyphony (`FPE_MaxPoly`, 0 = 99) limits it further. Flush-to-zero is
  not emulated.
- The engine reset FL does when a chunk is loaded (flush of keys, ring buffers and effects) is
  not replicated on preset switches while notes sound: only changed values are applied, like
  FL's live parameter changes.
- FL's `flag48` quirk (the per-key current damping / pan vectors jump to their targets every
  block, so they never smooth across blocks) and the pad-lane behaviour of the grouped NEON loop
  (random draws and filter state of idle pool keys) are replicated on purpose.
- The demo timer and the licence layer are not ported (see the top); the key activity array and
  the peak getters are only partly exposed (the editor's meter uses the output level).
- Editor: the two transparent string buttons of FL's form (`StringABtn`, `StringBBtn`) are not
  drawn; the first matrix source shows the form's "..." (the manual says "---"); Alt / middle
  click on a hidden control resets it to the form's default value (amount 128, ratios and sync 0,
  transpose 0), not the insertion value; the logo lettering and some small glyphs are
  approximations; the hint display shows two lines (FL's exact layout is unknown).
- Speed (plain Node, Apple M-series, 48 kHz, blocks of 128): "Default/Default" (no effects) with
  one key renders 38x faster than real time; "Default/Bowed 6" (four resonators, chorus, reverb)
  12x with one key and 7x with ten; "FX Faraway Runaway Train" (six resonators, delay, chorus,
  reverb) 5x with four keys; "Default/Pad 7" (three resonators, delay, reverb) 4x with sixteen
  keys. The resonator bank (16 string-delay tapes read per sample) and the reverb are the heavy
  parts of the effect chain. Under vitest's module wrapper the same code is about four times
  slower.
