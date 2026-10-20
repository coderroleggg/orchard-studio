# Instrument fidelity

How closely each implemented instrument matches FL Studio's own plugin. The
figures come from the instruments' research notes (`docs/research/gen/<id>.md`):
each instrument was played through FL's real plugin binary with a command-line
host and through ours, and the outputs were compared. A dB figure is the level
of the difference between the two ("residual"; lower is closer). *Bit-exact*
means identical samples.

The framework that hosts them is described in [gen-framework.md](gen-framework.md).

## Scope

Implemented: the 29 instruments below plus the Layer channel. FL's other stock
instruments are **not implemented** (the work was stopped at this set): Autogun,
BeepMap, Dashboard, DirectWave, FL Keys, FL Slayer, FL Studio Mobile (and its
Rack), FLEX, Fruity Granulizer, Kepler, Kepler Exo, Ogun, Patcher as an
instrument, Sakura, SoundFont Player, Wasp, Wasp XT, Wave Traveller and the
Audio Clip channel. They do not appear in the Channel Rack or Browser menus.

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
| Harmless | 154 of 431 states bit-exact, the rest within FL's own run-to-run variation (FL is not deterministic); effects 97 of 97 sweeps exact | tremolo depth ramp under automation assumed |

## Synth special

| Instrument | Match | Known gaps |
|---|---|---|
| Harmor | engine and all effects (incl. the compressor) bit-exact against FL; default patch identical; 170 presets without FL content: median -84 dB, 152 within -60 dB | image / resynthesis playback, strum and a held-index mapping not ported; 155 presets need FL content; WavPack sources must be converted to WAV |
| Morphine | bit-identical in all 429 comparisons (300 factory programs with FL content) | live playback uses a cheaper rounding mode (rare 1-ulp, exports stay exact); pitch-wheel source, MIDI learn, resynthesis not ported |
| Plucked! | bit-exact in 56 cases, including FL's noise generator | channel samples not 16384 frames long (-58 dB); voice stealing above 16 voices |

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

## Misc, Controller, Visual

| Instrument | Match | Known gaps |
|---|---|---|
| BooBass | bit-exact in 71 of 73 cases with FL content | substitute timbre without the import |
| Envelope Controller | 55 recorded FL scenarios and 22 presets match | random value; some editor tools |
| Keyboard Controller | matches FL | none noted |
| Voltage Controller | parameters, texts, default state and layout exact | output levels approximated (not measured) |
| Fruity Dance | behaviour and options per FL | original artwork |
| Fruity Video Player | synced to the song, FL's options | plays your own video files |
| Layer (channel) | children, random / crossfade / split as in FL | none noted |
