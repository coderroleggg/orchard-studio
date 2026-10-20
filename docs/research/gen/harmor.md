# Harmor (FL: Harmor)

FL's Harmor is Image-Line's additive / subtractive / resynthesis synthesizer
(Didier Dambrin): two parts (A, B), each a bank of up to 516 harmonics plus
three sub-harmonic slots and a resonance oscillator, shaped per partial by two
timbres, shaping maps and a chain of partial-domain units (local EQ, prism,
randomness, harmonizer, two filters, phaser, pluck, blur, protection,
clipping), modulated by 43 articulators (envelope, LFO and 9 mappings each),
with unison, image synthesis / resynthesis and a global effects chain.
Category Synth special, `notes: 'events'` (FL's Gen_Render plugin with its own
voices), DefPoly 16.

Sources: FL 2026's plugin binary (`Plugins/Fruity/Generators/Harmor/
Harmor_x64.dylib`, arm64 slice, FPC 3.2, class `TTestPlug`, no symbols), FL's
shared vector library `Shared/dsp_ippv2_x64.dylib` (IPP-compatible, a wrapper
over Apple Accelerate), the editor form, the 325 factory presets, the plugin
database state, the editor thumbnail (read-only reference) and renders /
memory dumps of FL's real plugin through the scratchpad test host (`host`,
with per-render-call snapshots of the plugin, parts, voices and sine banks and
direct calls of internal functions). Tooling lives in `.flref/harmor/`
(git-ignored): `HANDBOOK.md`, decompiler, host, dump specs, comparison tools.

## Addresses (arm64)

| What | Address |
|---|---|
| VMT TTestPlug | 0x6020c0 (SDK slots at +200) |
| SaveRestoreState / part load | 0xc6670 / 0xc7560 (state v0x130003) |
| GetName (value texts) | 0xd9890 -> 0xd4350, index map 0xd1010 |
| ProcessParam | 0xd1220 (handlers per part param 0..94 / globals 772..824) |
| sample rate / block setup | 0xd0190 (block = 4 * round(grain/100 ms * sr / 4)), precision fptrs 0xd0b30 |
| Gen_Render | 0xe8160 (tremolo 0xe82ec, arpeggio 0xe8ba0, voices 0xe8fac, FX 0xe91bc, end-of-call phases 0xe9254) |
| TriggerVoice / Voice_Release / Voice_Kill | 0xda2d0 / 0xdc1f0 / 0xdc580 |
| voice render (per control block) | 0xe1b60 |
| sine bank (render, refresh, activation, compaction) | 0x433000, 0x4326c0, 0x432c30, 0x432cf0 |
| articulator process / map lookup | 0xef000 / 0x451d30 (curve library TMEnvelope 0x83aec8, TMLFO 0x83b018, TMMap 0x83b168) |
| unit chain (built by 0xca920) | 0 dde00 local EQ, 1 dda80 prism, 2 dde30 randomness, 3 dcbf0 harmonizer, 4/5 ddea0 filters, 6 def50 phaser, 7 df500 pluck, 8 dd670 blur, 9 dd150 protection, 10 dd190 clipping, 11 dd0f0 envelope volume |
| part tables | ratios 0xe67e0, local EQ 0xe1070 (map reader 0xe00b0), timbres / phase 0xe5d60, unison 0xcaf90, shapes 0xcb280 / 0xcc010 / 0xcbb40 |
| declicker (shared TDeclicker) | setup 0x46bc70 / windows 0x46bec0, apply 0x46c9b0 |
| gain ramps (shared) | 0x460e20 (pan law 0x19c0 sincosf), 0x460410 / 0x460370 / 0x4604a0 |

## State, parameters, presets

- State (`src/model/gen/plugins/harmor/`): 825 parameters as flat keys (part A
  0..385, part B 386..771, globals 772..824; part params = 95 main + 31 x 8
  articulator envelope / LFO fields + 43 smoothing) and non-parameter data under
  `hA` / `hB` (HPart: settings, unit order, 43 articulators, 26 shaping maps,
  image header, resynthesis source), `hG` (HGlobal) and `hView` (editor view).
  `types.ts` documents every field with FL's offsets; combo settings store
  FL's TQuickCombo.Value (selectable items only).
- FL keeps the live articulator envelope / LFO parameters (95..342) in the
  curve objects; the saved parameter array holds stale zeros. The model fills
  them from the curves (`HEnv.a` / `HEnv.l`) for FL states (presets, Default,
  fresh state); after that the parameters are authoritative.
- Presets: all 325 factory presets (FL menu order) as differences to FL's
  Default (`base.ts`), deflated + base64 (`presets.ts`, 91 kB of 490 kB JSON).
  Dense per-partial curves (> 64 points: waveform imports / resynthesis) and
  image planes are FL content: they are not in the presets (`HPart.missing`,
  `HImage.missing`); the default curve stands in until the user imports them
  from their own FL install ("Import FL content..." in the plugin menu).
- A fresh Harmor is FL's plugin-database state ("Spacebass - nucleon").
- Parameter ranges are FL's control ranges except "Harmonizer pattern - gap -
  offset" (part param 32): FL's wheel stops at 8, but its state load does not
  clamp and the harmonizer uses the stored 9 of "FX/Ice rain" / "X Olbaid/FX/FX
  Inferno", so the parameter goes to 9.

## Voice engine (exact port, `src/engine/gen/plugins/harmor/`)

One voice per enabled part and unison voice. Per control block (88 samples at
44.1 kHz with envelope granularity 200):

1. articulators: list A (targets 31..42), snap / predelay / global envelope
   modifiers on the first block, list B (targets 0..30) with the block's input
   record (key, velocity, X, Y, Z, held index, X speed, LFO amount / speed);
2. pitch: FinalLevels pitch + glide of the part pitch (+ main pitch, frequency
   multiplier: FL plays key 60 at 261.63 Hz), vibrato from the part's
   free-running phase, pitch articulator, unison detune (cents x art 26^2);
3. partial count (0xe6690: p198 / f in Hz mode, (p198 - log2 f) * p19c in
   octave mode, + blur width + 4, up to 520 slots, rounded to 8), frequencies =
   ratio table x f / sr (unison Hz mode: a random per-partial detune table),
   starting phases on the first block (phase map table + starting phase x
   ratio, unison phase spread, phase randomness), slots 0/1 (and 2/3 below the
   fundamental) start at phase 0;
4. levels: timbre 1 / 2 mix (art 3) with the sub-harmonic levels, the unit
   chain in the part's order, sub-harmonic roll-off, resonance oscillator slot,
   raised-cosine taper of slots 456..519, the main shape (cuts partials above
   ~0.4 sr), auto gain, envelope gain (art 1^2 x envelope volume law);
5. targets to the sine bank, with per-partial ramping coefficients
   exp(Hz x rampK) after frequency changes (Ramping setting), smoothing
   exp(ln 0.01 / (25 ms x s8 x sr)) otherwise;
6. the sine bank renders: recursive float32 oscillators (y' = c y - y1) in
   groups of 8 lanes with FL's lane / summation order, activation above -96 dB,
   compaction every 512 samples, re-sync from double phases every
   round(f x 8192) samples (FL's ippsSin_32f), amplitudes glide per sample
   (no snap when declicking is off);
7. declicker windows (raised cosine; release window 10 ms after the voice
   ended), tremolo (Gen_Render builds stereo gains 1 + depth (0.21 - (0.55 cos
   + 0.55)^2) with a 100 ms fade-in for new voices), FX / dry split by the
   part's mix x art 2, equal-power pan (sincosf) with gain ramps
   (exp(ln 0.01 / (15 ms x sr)) per sample).

Voice end: the volume envelope finished (or, without one, right after the
release) -> state 9 and the declicker's release window -> state 10 (killed).
FL applies Voice_Release one render call late (the end test runs at the end of
the call).

Random numbers: FL's Tmt19937 (`plug+0xe98`) seeds per note / voice and FL's
ippsRandUniform_Direct; FL seeds the twister from the clock, the port (like the
test host) with 1.

## Articulators (`art.ts`, curve library `env.ts`)

- Each of a part's 43 targets combines an envelope (amount 1, or 2 in mode 2;
  the filter-frequency targets 4 / 5 get amount 0 and FL reads their envelopes
  separately), an LFO (times the global LFO amount) and 9 mappings (Keyboard,
  Velocity, Mod X, Mod Y, Mod Z, Random, Unison index, Held index, Mod X
  speed). The chain is built from the enabled curves and non-flat mappings;
  flat mappings fold into the base value, Random and Unison index apply once at
  note-on. Modes are fixed per target by the binary (0 multiply, 1 add with
  offset 0.5, 2 multiply x2 with offset 0.5), not by `HArt.mode`.
- Output smoothing a = exp(ln 0.01 / T), T = sr (2^(0.009 v) - 1) / (51.1 x
  block) blocks; v > 1000 freezes the output.
- Per block: list A (targets 31..42) -> first block only: snap, predelay check
  (restarts the block after the predelay), global envelope modifiers (33..37,
  40) -> list B (0..30) -> snap. One tick = one control block; envelope time
  2 x block / sr per tick (1.0 = 0.5 s) or block / sr x bpm / 60 with tempo
  sync; LFO phase 32-bit, increment round((10001^(speed/65536) - 1) x 2^32 /
  625 x time per tick), at most 805306368; global LFO phases start at
  0xc0000000 and follow the song position while playing.
- Notes: FL draws one random-input table per TriggerVoice (voices that don't
  draw read it); arpeggio index = rank of the note among the held notes;
  global envelopes copy the first live voice of the part (block timing too);
  poly release scale applies to every released, not yet scaled voice with the
  triggering part's factor.
- FL keeps the live envelope / LFO parameters in the curves (saved parameter
  array stale): see State.

## Global effects

See `fx.ts` (header): distortion (11 types, 2x/4x/8x oversampling by
precision), delay, chorus (TStereoFlanger), reverb (TFruityReverb) and
compression — a bit-exact port of the hosted SGv2 engine (24 dB crossover and
band compressors; `fx-comp-sg.ts`), identical to FL for all four types
(Limiting, Warming, Heating, Burning) and for all 325 factory presets with
compression on (FX agent's FX-input A/B) — the dry-bus insertion point and the
post-FX volume. All effects are exact against FL's host renders. Pre-FX volume
and part mix are part of each part's gain (0xcac00). The existing Maximus effect
port (`src/engine/effects/plugins/maximus*`, a measured model of the same
engine) could later be replaced by this exact SGv2 port.

## Fidelity (FL 2026 host renders vs the port, 44.1 kHz)

Tools: `.flref/harmor/tools/abtest.sh` (FL Default + parameters, both sides),
`batch_fl.py` + `fidelity.py` (all factory presets: note 60, velocity 100,
1 s + 0.5 s, 128-frame calls, no preroll); residual = rms(FL - port) /
rms(FL) over 0.1..0.9 s.

Renders compare the whole file (note, release, effect tails) with the same
call boundaries as the test host (128-frame calls, split at note events; FL
applies Voice_Release one call late, so call boundaries shape the release).

| Case | Residual |
|---|---|
| Default, key 60, whole render incl. release | identical (max diff 0) |
| Default + reverb / chorus / delay | identical (max diff 0) |
| Unison (incl. Hz mode), vibrato, tremolo, main pitch, velocity, chords | identical / float noise |
| Portamento, legato (sustain after the glide) | -81 dB |
| Factory presets without FL content (170, note 60, whole render) | 161 below -40 dB, 152 below -60 dB, 22 identical, median -84 dB |
| Factory presets with FL content (dense curves or images, 155) | 20 below -40 dB; the rest need the user's FL content (Import FL content...) and, for images, the image engine |

Remaining plain-preset mismatches (-15..-40 dB): FX/Lynchian texture, X Olbaid/Drums/Kick
Alien, FX/Drop 01, X Olbaid/FX/FX Caida, X Olbaid/Lead/Lead Electro Saws, Sequence/Plankton,
FX/Rotochip, X Olbaid/FX/FX Subida, X Olbaid/Drums/Kick Clic (not investigated yet).

Per area (agents' reports, block-by-block dumps): sine bank, articulators
(envelopes, LFOs incl. global LFOs and arpeggios, mappings), filters /
resonance / phaser / all shape tables, every partial unit and map table,
all global effects (distortion, chorus, delay, reverb, compression) are
bit-exact; the rare
exceptions are listed in the files' headers (e.g. 1-ulp prism-table doubles on
dense curves, Accelerate's double exp in the phaser's Freq type at precision
High / Perfect).

## Editor

`src/ui/plugins/gen/harmor/`: FL's form layout (main page sections,
articulator / envelope editors, image / resynthesis pages, effects), kit
controls, original drawing; tests `tests/gen/harmor-ui.test.ts`.

## Open questions / what remains

- Voice handling ported: portamento, legato (voice hand-over + glide, -81 dB
  after the glide), monophonic modes, FL's max polyphony. Not ported: strum
  (plug+0x1140), held index (0xdc6a0; the Held index mapping input stays 0),
  control notes (colour 15: part+0x48 filter offset, 0xe8564).
- Nine factory presets without FL content still differ (-15..-40 dB, see
  Fidelity); not investigated.
- Image / resynthesis playback in the voice (part+0x130 image object, the image
  path of 0xe1b60) and the resynthesis analysis (FFT-based; FL's FFT wrapper
  0x390d10 over Accelerate's vDSP, 32f, flags 0/1/2): not ported. Image presets
  render without their image (their planes are FL content anyway).
- FL content import ("Import FL content...", `src/ui/plugins/gen/harmor/flimport.ts`,
  `src/model/gen/plugins/harmor/import.ts`): dense curves into the state, image
  planes / resynthesis audio as pool samples (`<p>_imgSample`, `<p>_srcSample`).
  Known gap: WavPack (.wv) resynthesis sources are not decoded (convert them to
  WAV first).
- The editor's IMG page colours are our own (FL's rendering of that page was not
  seen): approximate.
- Model notes: mapping curves are kept as FL keeps them after loading (point at 0,
  distances scaled to sum 1, 0x447d00); a resynthesized part (img.mode 1) whose
  source audio was not imported is marked `img.missing`.
- lldb-based capture is blocked on this Mac (Developer Tools authorization);
  all verification uses the host's in-process dumps.
