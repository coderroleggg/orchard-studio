# Effect fidelity

How closely each effect matches FL Studio's own plugin. The figures come from
the plugins' research notes (`docs/research/fx/<id>.md`), where each effect was
measured with a command-line host that runs FL's real plugin binaries: the
same input is rendered through FL's plugin and through ours, and the
difference between the two outputs is measured. A dB figure is the level of
that difference ("residual"; lower is closer, as each note defines it).
*Exact* or *bit-exact* means identical output up to float precision.

Coverage: every effect in FL's plugin database (Browser > Plugin database >
Effects, all ten folders), plus the legacy effects FL still ships. Plugins
marked (legacy) are hidden from the menus, as in FL, but load in old projects.
Not included: the other three binaries in FL's effects folder, which are
outside that database: Fruity Wrapper (the VST host), Fruity LSD (a DLS
sampler built on the Microsoft synthesizer) and Razer Chroma (drives the
lighting of Razer devices). Effects without audio output (controllers, visualizers, note
effects) are compared on their outputs, texts and behaviour instead.

## Controller

| Plugin | Match | Known gaps |
|---|---|---|
| Control Surface | outputs, not audio | control creator, custom styles, multi-touch, keyboard MIDI |
| Formula Controller | outputs, not audio | none noted |
| Peak Controller | outputs exact (< 2e-5 of range) | none noted |
| X-Y Controller | first output matched exactly | none noted |
| X-Y-Z Controller | outputs, not audio | external controllers (sensors, joysticks) |

## Delay and reverb

| Plugin | Match | Known gaps |
|---|---|---|
| Convolver | not measured (the host cannot load impulses) | FL's impulse files are not shipped (a synthetic default room is); Edison tools missing |
| Delay (legacy) | -164 dB default, worst -117 dB (low pass) | none noted |
| Delay 2 | -137 .. -153 dB or bit-exact; parameter changes -126 .. -146 dB | none noted |
| Delay 3 | -132 dB default; time glides -72 .. -81 dB | FL's load-time glide (keep pitch -57 .. -69 dB) |
| Delay Bank | -105 .. -148 dB; grain preset -44 dB | grain stalls, buffer-wrap ramps (-40 dB) |
| LuxeVerb | approximation: band decay times within ~3-5 %, energy ~5 % | FL's reverb topology is unknown |
| Multiband Delay | -76 / -56 / -81 dB (Gentle / Steep / Linear); COMP -27 dB | the COMP detector is modelled |
| Reeverb (legacy) | ~1e-7 at room size 50 | other room sizes reuse Reeverb 2's echo offsets |
| Reeverb 2 | 48 kHz, diffusion 0: -99 .. -113 dB; level changes -102 .. -127 dB | 44.1 kHz and full diffusion differ (-3 .. -27 dB); decay / filter / room / predelay / diffusion changes not FL's |

## Distortion

| Plugin | Match | Known gaps |
|---|---|---|
| Blood Overdrive | bit-exact (static, automation, state loads, 44.1 / 48 / 96 kHz) | preset menu loads glide instead of FL's pre-settled state load |
| Distructor | rack, gains, kicks, filters, Blood (1x / 2x), Fast dist exact; in / mix / out changes exact or -140 dB | cabinet responses fitted (0.2 .. 1.6 dB rms); chorus in slot 3 / three or more choruses diverge after loading |
| Fast Dist | bit-exact, playback (truncating) and export (interpolating) kernels | none known |
| Hardcore | presets within -2.9 .. +3.4 dB rms | fitted cabinets; distortion topology |
| Soft Clipper | 5e-7 (float32 exact); parameter steps -134 .. -150 dB | none noted |
| Squeeze | bit-exact (static, full resonance, puncher, automation) | none known |
| WaveShaper | -74 .. -150 dB over the 12 presets; changes -99 .. -151 dB; export -129 .. -139 dB | 16-bit rounding on steep curves |

## Dynamics

| Plugin | Match | Known gaps |
|---|---|---|
| Compressor | 2e-6 .. 3e-5; parameter steps -104 .. -121 dB | float32 vs double |
| Emphasis | approximation: drums within 0.1 dB rms | adaptive control modelled, not decoded |
| Emphasizer | drums within 0.1 dB (0.4 dB at 0 %) | heavy drive up to 1.3 dB louder |
| Limiter | 1e-7 .. 4e-6 | a zero-gain gate edge case |
| Maximus | presets worst -61 dB, median -71 dB; LOW + MID OFF quirk, crossover and post gain changes reproduced | fitted low cut; no FFT linear-phase mode; stereo separation glide; slope-change transient |
| Multiband Compressor | presets -54 .. -135 dB (median -79); parameter changes at the static floor | limiter clipping interaction (-15 .. -45 dB) |
| Soundgoodizer | drums -64 .. -71 dB; noise -76 .. -84 dB | residual comes from Maximus's low cut |
| Transient Processor | defaults bit-exact (-120 dB); fits within 0.05 .. 0.47 dB rms | attack / boost followers fitted |

## Filter and EQ

| Plugin | Match | Known gaps |
|---|---|---|
| 7 Band EQ (legacy) | static -77 .. -105 dB; peaking level jumps -92 dB | shelf level jumps -29 / -42 dB |
| Bass Boost (legacy) | bit-identical | coefficients follow the sample rate (FL's do not) |
| EQUO | sample-exact, -132 .. -145 dB on all 6 presets and test states, 44.1 / 48 / 96 kHz | motion smoothing and sends modelled (the host cannot capture them) |
| Fast LP (legacy) | exact laws; static -127 .. -155 dB | resonance jumps -48 .. -56 dB |
| Filter | exact (float precision) | none noted |
| Free Filter (legacy) | sample-exact, -84 .. -130 dB | none noted |
| Frequency Splitter | IIR -70 .. -108 dB; FFT mode within 0.03 dB | the 36 dB slope is approximated (-35 dB) |
| Love Philter | every signal path exact on static settings; 8 presets exact, most others -40 .. -85 dB | Mango presets and fast, large cutoff jumps (-5 .. -17 dB): FL rings harder |
| Parametric EQ | bit-exact (static and every parameter change, 44.1 / 48 / 96 kHz) | none known |
| Parametric EQ 2 | HQ off / HQ+ / Legacy / Enhanced: median -128 .. -143 dB, worst -105 .. -113 dB (random 1-4 band settings, 44.1 / 48 / 96 kHz); automation steps -133 .. -145 dB; LIN -78 .. -101 dB | HQ+ high pass resonating above Nyquist (-13 .. -21 dB) and narrow shelves (-34 dB); LIN with narrow or very low bands at low precision (-15 .. -60 dB) |

## Modulation (FL's "Flanger" folder)

| Plugin | Match | Known gaps |
|---|---|---|
| Chorus | unmodulated -70 .. -143 dB; modulated -27 .. -42 dB; after parameter changes -67 .. -99 dB | LFO rates drift slightly from FL's single-precision accumulator, and FL's own start phase varies between runs |
| Flanger | static -87 .. -90 dB; LFO frozen -79 dB; modulated -44 .. -53 dB | residual LFO rate drift |
| Flangus | default -55 .. -63 dB; order 9 full spread -48 dB; spread 112 -43 .. -49 dB (band-limited noise; full-band noise -20 .. -36 dB) | dry / wet ramps run per 128-frame block; FL's leftover LFO phases at creation (orders 2, 5, 6, 7) |
| Hyper Chorus | -70 .. -103 dB from the first sample (defaults and every control); 18 mid-render changes -63 dB worst, -77 dB median | FL's small DC offset at the lowest high-pass settings (12-20 Hz); vectorscope scaling estimated |
| Phaser | static -126 .. -137 dB; modulated from -50 dB | settles differently for ~20 ms after a Feedback change; slow LFO drift |
| Vintage Chorus | modes I / II -54 .. -58 dB, I+II -52 dB, custom -51 .. -62 dB, modulated -53 .. -61 dB (after FL's start-up) | our own hiss generator; up to 0.1 % delay error for ~40 ms after time / LFO changes; first ~50 ms of a fresh instance |
| Vintage Phaser | V1 static -52 .. -64 dB; V2 small signal -60 .. -66 dB, at 0 dBFS -46 dB (with feedback -34 dB); LFO -45 .. -55 dB | our own resampler and noise; heavy-drive V2 3rd harmonic ~4 dB off; control changes 0.5 ms later than FL |

## Gain and stereo

| Plugin | Match | Known gaps |
|---|---|---|
| Balance | bit-exact | none known |
| Mute 2 (legacy) | exact | none noted |
| PanOMatic | exact (float precision) | LFO start phase |
| Phase Inverter (legacy) | exact | none noted |
| Send | exact (float precision), dry steps -156 dB | none known |
| Spreader | -136 .. -143 dB | scope scales estimated |
| Stereo Enhancer | exact (float precision) | none noted |
| Stereo Shaper | exact (float precision) | all-pass clamp assumed |

## Misc

| Plugin | Match | Known gaps |
|---|---|---|
| Center (legacy) | bit-identical | none noted |
| Edison | recorder / editor, not measured | some tools substituted or omitted; WAV only |
| Effector | Lo-fi, Flanger, Stereo, Ring near-exact; other modes approximated | Distort, Filter, Reverb, Grain, Vox fitted |
| FL Studio Mobile Rack FX | varies by module; Graphic / Tuned EQ bit-exact | Waveshaper, Spreader, Tape Stop, Multi FX, Pitcher 2 approximated |
| Frequency Shifter | laws exact; image / HQ / feedback within 0.1 .. 3 dB | Hilbert / HQ filters fitted |
| Gross Beat | -75 dB (HQ off) | HQ jump smear missing (-20 .. -30 dB) |
| Low Lifter | default -57 dB, worst -48 dB | diffuser at 44.1 kHz -36 .. -44 dB |
| Newtime | not measured | WSOLA stretching instead of FL's zplane engine |
| Newtone | not measured | YIN / TD-PSOLA instead of FL's zplane engine |
| Pitch Shifter | Music engine within 0.05 dB / 2 % | Voice engine approximated |
| Pitcher | pitch within 0.2 cents; glide ~1.5 cents | scale / MIDI / formant behaviour unmeasured |
| Scratcher | not measured | platter physics taken from the manual |
| Transmitter | approximation (fitted detector) | misses small steps and hard stops |
| Transporter | approximation | detector and Adaptive mode unmeasured |
| Vocoder | 1e-5 .. 5e-5 | display scales inferred |
| Vocodex | level -0.1 .. -0.4 dB, correlation 0.96 .. 0.98 | filter orders 3 / 4, unison ~1-3 dB |

## Patcher and VFX (note effects)

| Plugin | Match | Known gaps |
|---|---|---|
| Patcher | not measured (the host renders Patcher silent) | Surface tab, parameter links between modules |
| VFX Color Mapper | note output | none noted |
| VFX Envelope | note output | behaviour inferred (the host cannot run it) |
| VFX Key Mapper | note output | preset tree display |
| VFX Keyboard Splitter | note output | live notes not displayed |
| VFX Level Scaler | note output | curve family inferred |
| VFX Script | note output | a Python subset; FL's own scripts are not included |
| VFX Sequencer | note output | MIDI channels, chains |

## Visual

| Plugin | Match | Known gaps |
|---|---|---|
| Big Clock | no audio | no tempo automation |
| dB Meter | bit-exact pass-through | meter timer at 30 Hz |
| HTML NoteBook | no audio | no web loading |
| NoteBook | no audio | HTML instead of RTF |
| NoteBook 2 | no audio | none noted |
| Spectroman | analysis exact | blend mode fitted |
| Tuner | no audio | own pitch detector |
| Wave Candy | pass-through | drawing approximated |
| ZGameEditor Visualizer | pass-through | our own canvas effects instead of FL's shaders, at most 8 layers, no image / video sources, no video export, FL's presets missing |
