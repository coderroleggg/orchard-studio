# Convolver (FL: Fruity Convolver)

Convolution reverb / impulse processor (convolution engine by LiquidSonics in FL). Editor 714 x 346:
knob row, NORMALIZE, impulse / equalizer tabs, Edison-style impulse editor or the impulse equalizer.

## Parameters and state

FL automates only four parameters (form Tags 0..3; names, ranges and texts from `flfxhost`):

| # | key | FL name | range | default | text / curve |
|---|---|---|---|---|---|
| 0 | dry | Dry level | 0..1000 | 1000 | gain (11^(v/1000) - 1)/10, `-12.7dB` at 500, `-InfdB` at 0 |
| 1 | wet | Wet level | 0..1000 | 500 | gain (1000^(v/1000) - 1)/999, `-30.3dB` at 500 |
| 2 | inSep | Input stereo separation | -1000..1000 | 0 | `50% separated` / `Original` / `100% merged` (M/S width 2..0) |
| 3 | wetSep | Wet stereo separation | -1000..1000 | 0 | same, on the wet output |

The form's other knobs have Tag -1 (not automatable): pre-delay (0..1000 ms), self-convolution,
stretch (resampling ratio 2^(v/1000)), EQ mix; kept as `noAuto` parameters. Plugin state: impulse
(sample-pool id, null = built-in room), name, normalize (on, as in FL's screenshot/state), reverse,
fades, trim, four impulse envelopes, EQ curve, reported latency, editor view, trigger / record counters.
FL's own Default impulse (Default.wav) is not copied: the built-in room is synthesised
(3.4 s stereo, RT60 ~3.4 s at LF -> ~1.5 s at 8 kHz, energy ~240/channel at 44.1 kHz like Default.wav),
so the default wet -30.3 dB gives FL's level (verified in the test). Factory presets are not included:
they all reference FL's impulse library.

## Impulse processing (renderImpulse, shared by editor and engine)

trim -> reverse -> stretch (sinc resampling to the engine rate, length and pitch change) -> fades
-> envelopes (volume, pan, stereo separation, all-purpose = time-varying damping 200 Hz..20 kHz)
-> self-convolution (impulse * impulse, mixed at equal energy) -> equalizer (zero-phase, FFT; FL's
axis measured from its labels, +12 dB top / 0 middle / -inf bottom, balanced by the EQ knob)
-> loudness normalisation (energy 240 per channel at 44.1 kHz) -> pre-delay. The editor module
renders it on the main thread and sends it to the engine as sample `convolver:<hash of the settings>`
(the engine only receives channel samples itself; see the report). The engine renders the built-in
room / cheap steps itself until the sample arrives (and in tests).

## Convolution engine

Zero latency: 128-tap direct-form head + uniformly partitioned overlap-save FFT levels with 128,
1024 and 8192-sample partitions covering taps 128..2047, 2048..16383 and 16384..; the two big levels
spread their FFT/MAC work over the 128-sample ticks of their one-frame slack (no spikes). Stereo
signals and impulses share complex FFTs (L + iR). Verified against direct convolution (error < 1e-4
over all levels with irregular block sizes). Impulse changes are prepared a few FFTs per block and
swapped with a 10 ms wet fade (FL: "a short period of silence when updating"). Max impulse 20 s.
CPU: ~40x realtime for the 3.4 s default impulse. `latency` = the manually set PDC value (FL's
latency button), `tail` = impulse length.

## Editor

Knob row and labels/icons at form positions (FL 2026 knobs drawn in SVG), NORMALIZE LED, updating
spinner, tabs. Impulse tab: transport preview (main-thread playback), record (arms the engine: starts
at the first sound, stops after 0.3 s of silence, the take becomes a pool sample), trigger impulse
(click on the output), file / edit / view / zoom menus, undo, normalize, fades, reverse, trim, EQ,
save as WAV, info row, browse menu (pool samples), latency menu, waveform/spectrum view with
selection, zoom (wheel) and overview scroller, envelope bar with the four envelopes (FL editing:
right-click adds, drag moves points and tension markers). Equalizer tab: EQ curve over the impulse
spectrogram with FL's note / frequency labels, reset / flip / "Turn EQ into impulse response"
(linear-phase impulse, 100% wet, 0% dry, latency set to half the impulse as FL does).

## Not measurable / approximations

- The FL host cannot load impulse files (its sample loading is a stub), so the wet DSP was not
  compared with FL; levels follow FL's curves and Default.wav's energy.
- FL's Edison tools (scripts, blur, reverb, stretch dialog, regions, snap, click-free editing) are
  not implemented; their toolbar buttons are omitted. The all-purpose envelope's FL meaning (Edison
  playback functions) is replaced by a damping envelope.
- Stretch range (FL's text unknown) assumed x0.5..x2; FL's normalisation target assumed from Default.wav.
