# Instrument fidelity

How closely each implemented instrument matches FL Studio's own plugin. The
figures come from the instruments' research notes (`docs/research/gen/<id>.md`):
each instrument was played through FL's real plugin binary with a command-line
host and through ours, and the outputs were compared. A dB figure is the level
of the difference between the two ("residual"; lower is closer). *Bit-exact*
means identical samples.

The framework that hosts them is described in [gen-framework.md](gen-framework.md).

## Scope

Implemented: the 37 instruments below, the Layer channel and the three legacy
64-bit dummies at the end (Wasp, Wasp XT, FL Slayer: hidden and silent, as in
FL 2026). FL's other stock instruments are **not implemented** (the work was
stopped at this set): Autogun, Dashboard, DirectWave, FL Keys, FL
Studio Mobile (and its Rack), FLEX, Patcher as an instrument and the Audio
Clip channel. They do not appear in the Channel Rack or Browser menus.

## FL sound content

Several instruments play sounds that FL stores in its own files (recorded
waveforms, sample kits, spectra, preset curves). None of that content is
shipped. These instruments play a synthesized or empty substitute by default,
and their plugin menu has **Import FL content...**, which reads the files from
your own FL Studio installation at runtime. Figures marked "with FL content"
need that import.

## Synth classic

| Instrument | Match | Known gaps |
|---|---|---|
| 3x Osc | bit-exact (all shapes, Default patch, coarse / fine, pan, detune, phase, mix, noise, AM, HQ, automation) | 1-ulp level differences at some velocities (shared voice-level maths); polyphony-limit fade differs |
| DX10 | bit-exact on all 59 presets when processing blocks line up with FL's | with our 128-sample blocks: voice ends land on a block boundary (~1e-4), vibrato phase drifts with several voices |
| GMS | parameters, value texts, 306 presets and new-instance state exact | sound not measurable (FL's licence check silences it in the test host); ported from FL's code |
| MiniSynth | -110 .. -125 dB on all 92 presets | FL's waveform data file is modelled (bit-exact with it); release tails ignore channel changes |
| PoiZone | bit-exact | none noted |
| Sawer | parameters, value texts, 421 presets and new-instance state exact | sound not measurable (licence check); ported from FL's code |
| SimSynth | bit-exact on all 73 presets, keys, sample rates, automation | 1-ulp level differences at some velocities |
| Sytrus | 984 presets: median -85 dB; 869 of 920 deterministic presets within -40 dB | 51 presets above -40 dB (chaotic FM rounding, a few undiagnosed); presets with random mappings differ by FL's own random seed; chord arpeggio steps not ported |
| Toxic Biohazard | 789 of 790 presets bit-exact with FL content (last one -218 dB) | substitute waveforms without the import |
| Transistor Bass | -124 .. -140 dB after the first 50 ms; onsets -77 .. -110 dB; automation -114 dB | onset transients |
| Kepler | with FL's tables: all 277 presets bit-exact; ~400 random scenarios (parameters, notes, tempos, mid-note changes, 32 - 96 kHz) exact except cases traced to FL itself (clock-seeded arpeggio random modes, FL's own inf / NaN below 44.1 kHz) | its LFO / noise tables are FL content: the default stand-in is -23 dB median from FL until **Import FL content...**; filter types 1 / 2 (unused by any preset or control) not ported; matrix MIDI CC inputs |
| Kepler Exo | with FL's tables: all 188 presets bit-exact with effects off, each effect alone and Enhanced Oscillators on; 184 through the full chain as FL's .fst files (4 differ in LFO phase from an FL loader quirk, exact when loaded as states); every matrix destination and source exact; ~1000 random scenarios exact except FL-side cases | as Kepler (stand-in tables -43 dB median); reverb after a Mono reset differs by ~4e-28 |
| Harmless | 154 of 431 states bit-exact, the rest within FL's own run-to-run variation (FL is not deterministic); effects 97 of 97 sweeps exact | tremolo depth ramp under automation assumed |

## Synth special

| Instrument | Match | Known gaps |
|---|---|---|
| BeepMap | bit-exact (every sample) in all 7 factory presets with their FL bitmaps, keys, velocities, block sizes 1 - 1000, 8 - 192 kHz, Log / Linear / Harmonics, Use Blue, Grainy, Loop, automation, glides, chords and bitmaps from 3 x 3 to 300 rows; importing FL's `.fst` files reproduces FL's renders bit for bit | a picture loaded from FL's BMP instead is resampled by an empirical model of Apple's image scaler (-56 dB); FL's sample blocks differ from ours at -132 dB re peak; polyphony limit fades with the channel's declick; INS tab not host-testable |
| Harmor | engine and all effects (incl. the compressor) bit-exact against FL; default patch identical; 170 presets without FL content: median -84 dB, 152 within -60 dB | image / resynthesis playback, strum and a held-index mapping not ported; 155 presets need FL content; WavPack sources must be converted to WAV |
| Morphine | bit-identical in all 429 comparisons (300 factory programs with FL content) | live playback uses a cheaper rounding mode (rare 1-ulp, exports stay exact); pitch-wheel source, MIDI learn, resynthesis not ported |
| Ogun | engine bit-exact (every sample, with all effects) on 228 of 229 factory presets, qualities, export mode, 22 - 192 kHz, block sizes 1 - 1024, automation, glide, polyphony; value texts exact at every value of 81 parameters; random presets identical to FL's for the numbers 1 - 1000 | 141 presets need FL's analysed spectra (Import FL content...); Analyze timbre; LFO speed text; velocity law ~1e-8 (shared); Autogun not implemented |
| Plucked! | bit-exact in 56 cases, including FL's noise generator | channel samples not 16384 frames long (-58 dB); voice stealing above 16 voices |
| Sakura | parameters, value texts, all 501 presets and the new-instance state exact; shared classes (wrapper, chorus, tape delay, reverb) function for function equal to the verified ports | sound not measurable (FL's licence check silences it in the test host): the DSP is ported from FL's code without any residual against FL; demo timer and licence layer not ported |

## Drum

| Instrument | Match | Known gaps |
|---|---|---|
| BassDrum | -100 .. -144 dB with FL content; -58 .. -80 dB with the substitute | a new instance starts from engine defaults (FL's needs an FL sample) |
| Drumaxx | bit-exact on all 131 factory kits | MIDI learn; saving kits / patterns |
| Drumpad | bit-exact (random presets, keys, velocities, 22-96 kHz) | several instances / levels after note-off |
| DrumSynth Live | bit-exact in most cases with FL content | note tails -85 .. -135 dB (block grid) |
| Fruit Kick | about -148 dB | voice end inside a block (-85 dB) |
| FPC | bit-exact (layers, velocity layers, mute / solo, cut groups, outputs, envelopes) | FL's compressed kit samples decode slightly differently (-84 dB); some envelope shapes, regions, MIDI loops, Learn, touch views |
| Fruity Slicer | slicing identical; playback bit-exact to note-off | élastique stretch modes approximated (third-party library) |
| Fruity Slicer 2 | bit-exact playback, filters, envelopes; slicing identical | élastique stretch approximated |
| Slicex | identical in every render test (regions, tempo, dumps, playback) | some Edison editing tools, beat / pitch detection, region export |

## Sampler

Both play your own audio (drop, file picker or Browser); FL's demo content is only read by **Import FL content...**.

| Instrument | Match | Known gaps |
|---|---|---|
| Fruity Granulizer | bit-exact in 58 pinned renders and the 8 factory presets; 1 240 random scenarios (every control, 22 - 96 kHz, linear / 6-point / 24 - 256-point sinc resampling, KEY TO modes, DETECT, RAND with FL's clock, channel pitch / pan ramps) bit-exact but one, a single float32 ulp | TEMPO LOCKED has no effect (no per-channel fit time); USE REGIONS is not host-verifiable; RAND draws of several voices follow the channel's voice order; original editor drawing |
| Wave Traveller | bit-exact in 59 host renders (one at 1 ulp): all spline types, mutes, VOL, ATT / REL, both speed modes, pitch / pan levels, the 64-tap export sinc, all 6 factory presets | FL's pack samples need **Import FL content...** (Ogg inside WAV); "Continuous output" has no effect; the 128 / 256-tap sinc is not render-verified; editor drawing approximated |

## Misc, Controller, Visual

| Instrument | Match | Known gaps |
|---|---|---|
| BooBass | bit-exact in 71 of 73 cases with FL content | substitute timbre without the import |
| Envelope Controller | 55 recorded FL scenarios and 22 presets match | random value; some editor tools |
| Keyboard Controller | matches FL | none noted |
| SoundFont Player | parameters, value texts and state exact; the Sobanth synth ported from FL's code and measured with self-made .sf2 files: 108 voice / envelope / LFO / modulator / filter / zone / link scenarios at -129 .. -297 dB (float32 rounding), 134 scenarios pinned in the tests; reverb bit-exact, chorus bit-exact .. -154 dB; 11 - 96 kHz hosts; FL's own STR_Ensemble.sf2 -142 dB, Default.sf2 -123 dB | Crunchy / HQ / Extreme HQ resampling not measurable with the host (same kernel builder as the measured Standard); strongly attenuating or swept filters away from 44.1 kHz differ at -79 .. -117 dB (float32 / libm order); short loops depend on the render block size; FL's soundfonts are not shipped (**Import FL content...** loads your own copy) |
| Voltage Controller | parameters, texts, default state and layout exact | output levels approximated (not measured) |
| Fruity Dance | behaviour and options per FL | original artwork |
| Fruity Video Player | synced to the song, FL's options | plays your own video files |
| Layer (channel) | children, random / crossfade / split as in FL | none noted |

## Legacy 64-bit dummies

FL 2026 ships these three as 64-bit dummies: they accept notes, render silence
and show a "Dummy x64" window. They are hidden here (not in the menus), keep
FL's parameter counts and ranges, and are silent like FL.

| Instrument | Match | Known gaps |
|---|---|---|
| Wasp | silent in every render (all samples zero), as FL; 41 parameters as `flfxhost info` reports | automation list for the unnamed parameters not observed |
| Wasp XT | silent in every render, as FL; 56 parameters | as Wasp |
| FL Slayer | silent in every render, as FL; 29 parameters; no MIDI out | as Wasp |
