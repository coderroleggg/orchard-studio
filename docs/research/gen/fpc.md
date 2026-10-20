# FPC (FL: FPC)

**Status: calibrated against FL 2026's renders (test host).** The engine is a port of FL's own voice engine
(FPC_x64.dylib) and renders FL's output bit for bit in every tested case with PCM samples, at every
resampling quality, with envelopes, cut groups, layers and routed outputs. FL's factory kits keep their
sample *references*: no FL audio is shipped; the user loads their own samples or imports FL's drum library
from their own FL installation (window menu "Import FL content...").

Files: `src/model/gen/plugins/fpc.ts` (+ `fpc/state.ts` state model, `fpc/kits.ts` FL's 41 kits as data,
`fpc/layouts.ts` FL's note layouts),
`src/engine/gen/plugins/fpc.ts` (+ `fpc/resampler.ts` FL's TResampler, `fpc/sinc.ts` / `fpc/hermite.ts` its
kernels, `fpc/envelope.ts` FL's TMEnvelope player, `fpc/mix.ts` FL's NEON mixing kernels, `fpc/mt.ts`),
`src/ui/plugins/gen/fpc/index.tsx` (+ `flcontent.ts` sample loading / FL import), `tests/gen/fpc.test.ts`
(+ `fpc.golden.ts`). Shared: `GenInstance.setInterpolation` (src/engine/gen/types.ts) forwarded by
`GenChannel.setInterpolation` (the project's resampling quality reaches plugins that resample themselves).

## Sources

- `Plugins/Fruity/Generators/FPC/FPC_x64.dylib` (Free Pascal, universal; the arm64 slice for exact float
  operations, the x86_64 slice for reading packed records): TTestPlug VMT 0x2f9418 (arm64), TriggerVoice
  0x604b0 / voice creation 0x62dc0, Gen_Render 0x60750, pad voice render 0x61040, Voice_Release 0x68970,
  Voice_Kill 0x68c50, random layer choice (x86 0x526b0), parameter decoding (x86 0x5b440), GetName (x86
  0x57fc0), SaveRestoreState (x86 0x56290, pads 0x55a30, layers 0x555c0), TResampler (DSP_Resample unit:
  SetSpeed 0x201f80, SetPitch 0x2020d0, Render 0x202a70, linear 0x1fed00.., hermite 0x1fefb0.., sinc drivers
  0x1ffd90.. with NEON kernels 0x2978 / 0x2a9c / 0x2bb8 / 0x2cbc, edge windows 0x202380..), TMEnvelope
  (MEnvelope unit, x86: update 0x240300, NoteOn 0x244e90 / 0x242700, Tick 0x242b30, Release 0x242930,
  point value 0x241ef0; TFPCVolEnvelope / TFPCPanEnvelope 0x90e00 / 0x90eb0), mixing kernels (arm64 NEON
  0x395c constant gain, 0x3c3c ramp), MT19937 (x86 0x2879e0, time-seeded global).
- `Shared/dsp_ippv2_x64.dylib` (arm64): ippsVectorSlope_64f (positions, fused multiply-add),
  ippsThreshold_LT_64f_I, ippsSin_64f_A50 (= Accelerate vvsin). `FLEngine_x64.dylib`: the FPD_ProcessMode
  broadcaster (arm64 0xa50d0) sends mode | half-width << 8 with FL's quality table [1, 3, 8, 12, 16, 32, 64,
  128, 256] (linear, 6-point hermite, 16 .. 512-point sinc; 24-point = 12 is FL's default).
- The editor form (`.flref/gen/forms/FPC.txt`, TSynthEditorForm 790 x 367), FL's online manual, the
  thumbnail (colours), the 40 factory presets and the plugin database state (`FPC.fst`).
- Test host: `info` / `sweep` (all value texts), renders with FL states built from PCM test samples
  (`--state`), `--process-mode N` for the interpolation settings, `--mix-outs`, `--chan-pitch`, `--chan-vol`.

## Parameters and state

768 parameter slots, 416 named: per pad (bank b = pad / 16) volume 64 b + j (0..127, "v / 127 %"), pan
64 b + 16 + j (-128..128, "v / 128 %"), mute / solo 64 b + 32 / 48 + j ("off" / "on"), tune 256 + 64 b + j
(-128..128, 9.375 cents per step truncated: "-1190 cents"), and the envelopes' knobs 512 + 8 pad + n (volume /
pan attack, decay, release 0..256 "v / 128 %", sustain -128..128). FL rounds the percentages half away from
zero. FL's kits store pad volume 128 (above the control's 127; FL plays it, 2.1 dB over 127): the volume
parameters here allow 0..128 so the kits keep FL's level.

State (`pads`, 32): name, key, output offset, cut / cut-by group (-1 none), colour (TColor), icon, Lock
layers, Random and its mode (0 Random, 1 Random avoid previous, 2 Cycle backward, 3 Cycle), layers (sample
pool id, FL file reference, volume 0..127, pan, velocity range lo <= v < hi (hi 127 also 127), "scale volume
with velocity" (FL keeps it per layer; the pad's switch sets all), reverse, tune, region) and the volume /
pan envelopes (FL's points as [segment length before the point in units of 0.5 s, level, tension, curve
mode, 3 flag bytes], D / L / S markers, enabled). FL's state chunks (magic 0x1e84e403, [id u32][size u64]):
pad 2 { 100: 16 ints, 101 name, 102 random mode, 105 layer { 300 path, 301 7 ints, 302 }, 103 / 104
envelope (kind, version 3, points as doubles, flags, enabled, D, L, S, ADSR), 106 }, 1 MIDI loop name, 3 view,
4 window size. The 41 kits are converted to data (`fpc/kits.ts`, pads / envelopes / folders shared).

## DSP [C: FL's code, verified sample by sample]

- **Notes**: velocity = round(FPV_GetVelocity x 128) (0..127); the key from InitLevels.Pitch. Pads on the key
  play unless muted (or not soloed while a solo is active; a muted soloed pad plays). Layers: those whose
  range holds the velocity, or with Random on one of the overlapping ones (FL's MT19937; FL seeds its
  generator from the clock, here a fixed seed per instance; Cycle modes step from the last layer played).
- **Cut groups**: a new pad voice cuts every sounding pad voice whose cut-by group is the new pad's cut group
  (not -1), except voices started at the same instant (not yet rendered). Cut voices ramp to 0 over one
  control period and stop.
- **Gains** (per control period, 48 samples at 44.1 kHz: max(4, 4 round(sr x 48 / 44100 / 4))): pad and
  layer volume (21.527^(v / 127) - 1) / 10 in single precision; three FL ComputeLRVol pan laws (pad pan / 128
  with the pad volume, layer pan / 128 + 2 x pan envelope with the layer volume, the note's FinalLevels pan /
  volume) multiplied with the volume envelope; without "scale volume with velocity" divided by InitLevels.Vol.
  The first period starts at its target; later ones ramp linearly over the period (FL's NEON ramp kernel,
  including its scalar tail that swaps the left / right steps).
- **Pitch**: FinalLevels.Pitch + 100 (60 - key) + 9.375 (pad + layer tune) cents, speed
  exp(cents ln 2 / 1200) x sample rate x (1 / host rate); exactly 1 copies the samples (FL's copy mode).
- **Resampling** (FL's TResampler, `fpc/resampler.ts`): positions fma(i, speed, pos), safe ranges and the
  per-frame edge window (edge samples repeated); linear in double; FL's 6-point hermite (z = x - 1/2,
  coefficient table, single precision); FL's windowed sinc with 2N taps (window 0.36 + c + 0.64 c^2 of
  cos(pi x / N), sinc by recurrences, reciprocal by FRECPE + two Newton steps, anti-aliasing cut-off and more
  taps when the speed exceeds 1), lane by lane as FL's NEON kernels. The project's resampling setting picks
  the kernel like FL's (linear / 6-point hermite / 24 .. 512-point sinc).
- **Envelopes** (FL's TMEnvelope, `fpc/envelope.ts`): ticked once per control period with FL's step (period x
  2 / sr units); ATT before D, DEC after it (and in a release without S), REL in the release; SUS adds the
  knob value x the point weight (ramping in from D to L / S, out over the release) clamped to 0..1; S holds,
  L loops (DEC 0 holds the loop), the release continues from the current level; single curve, double curve
  and hold point modes. A finished volume envelope ramps the voice to 0 and stops it. The pan envelope is
  centred at 0.5.
- **Note offs** only release the envelopes; samples play to their end (one shot). Voice_Kill stops at once.
  The channel frees its note object at the note off, so a released voice keeps the levels it had then (FL's
  host keeps updating a released voice's FinalLevels until the plugin ends it).
- **Outputs**: pad voices mix into per-output buffers (FL's GetOutBuffer(offset)): offset 0 = the channel's
  track, others mixer track (channel track + offset) clamped to 0..500 (ctx.out). FL's voice lists are
  unordered TLists (a delete moves the last item into the hole) rendered from the last item to the first;
  both are kept, so sums round as FL's.

## Editor

FL's form at its coordinates: pad header (pad selector, name, Volume / Pan / Tune, Mute / Solo / Scale
volume with velocity, note menu with octave submenus and "Map notes for entire bank", CUT / BY, output offset),
the 4 x 4 pads in the kit colours (click plays and selects, the vertical position sets the velocity;
right-click plays, Ctrl+right-click opens the pad menu: banks, rename, colour, clear, Layouts = FL's six note
layouts (`fpc/layouts.ts`, converted from FPC/Data/*.notelayout: keys and cut groups of the 32 pads); middle-click renames),
BANK A / BANK B, the layer section (CREATE, DELETE, up / down, SPREAD EVEN as FL's 0x9c4b0: bounds i / n or,
with "Logarithmic" (right-click), ((2n)^(i / n) - 1) / (2n - 1) mirrored, x 127 rounded; Lock layers, the velocity range
bar that plays the pad at the clicked velocity, Random with its mode menu) and one row per layer (volume,
pan, tune, mini sample view, velocity range drag), the selected layer's sample view (click previews, load,
name in red when the file is missing, reverse) and the envelope editor (VOLUME / PAN, enable, ATT / DEC / SUS /
REL, points: drag, right-click adds or opens the point menu with S / D / L markers and curve modes, Alt+click
deletes, tension handles). Samples: drag from the Browser or the OS onto a pad, a layer or the layer list.
Window menu: "Import FL content..." (pick FL's folder: every layer reference of the instance is loaded, FL's
Vorbis WAVs decoded by the browser), "Load sample into selected layer...".

## Fidelity (FL vs ours, 44.1 kHz unless noted, raw channel, the test host's block grid)

| Case | Residual |
|---|---|
| single layer at its pitch (copy mode), 16-bit mono / stereo, float, pad / layer / note pan, pad volume, layer tune, velocity 57 / 80 / 100 / 127, scale-volume off | bit-exact |
| linear interpolation (FL's live ProcessMode 0) at +100 / -350 / +1900 cents, 22.05 / 48 kHz samples, 48 kHz host | bit-exact |
| 6-point hermite, 16 / 24 / 128 / 512-point sinc (ProcessMode 3, 8, 12, 64, 256 << 8) at +100 / -777 / +333 / +1900 / +5000 cents (more taps above speed 12), sample edges, stereo, 48 kHz host | bit-exact |
| velocity layers, overlapping notes on several pads at the same instant, mute / solo, sample ends | bit-exact |
| cut groups (the Default kit's hi-hats, a pad cutting itself, simultaneous notes) | bit-exact |
| routed outputs (`--mix-outs`) | bit-exact |
| volume / pan envelopes: ADSR with knobs, sustain offset, release during attack, S on the first point, loops, double curve and hold modes, finished envelopes | bit-exact |
| FL's Default kit with FL's own samples (Vorbis WAVs decoded by FFmpeg here, by libvorbis in FL), 7 notes, linear and 24-point sinc | -84 dB (decoder differences, max 2.2e-4) |

- Departures that keep the plugin running: a volume envelope loop made of zero-length segments (FL hangs)
  holds after a few passes; the pools hold 256 notes / 256 pad voices / 512 layer voices (FL: unbounded).
- Approximations: FL library samples are decoded by the browser (Chromium: FFmpeg's Vorbis decoder), FL
  uses libvorbis: about -84 dB. Random layer choices use their own seed (FL's generator is time-seeded and
  shared by all FPC instances). The editor's pad click plays every pad on that key (FL plays the clicked pad
  only). The volume parameter range is 0..128 (FL's control 0..127) so FL's kits keep their level. Curve modes
  3..12 (stairs, pulse, wave...) play as single curves; per-point loop counts are not modelled.
- Not implemented: MIDI drum loops (FL's FPC loop library), pad presets, saving note layouts, Learn / Last hit,
  icons, the two touch views (the view button cycles the state only), sample regions (whole samples play),
  Edison editing, Export / Import DirectWave / SFZ, Save kit.
