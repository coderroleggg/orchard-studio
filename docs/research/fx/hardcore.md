# Hardcore (id `hardcore`)

FL's guitar multi-effect: 5 pedal slots (11 stomp-box types), an 8-band graphic
EQ, 20 cabinet models, input / output levels. C++ plugin (no extracted form);
everything below was measured on FL 2026's `Hardcore_x64.dylib` with
`flfxhost` (48 kHz unless noted) and the manual's screenshots (100%).

## Interface and state

- FL parameters (GetName): 0 `Master IN Lvl`, 1 `Master OUT Lvl`, 2 `EQ Enable`,
  3-10 `EQ Band 1..8`, 11 (cabinet, unnamed), 12 unused, 13-37 `BoxN - Param 1..5`,
  39-43 `Box N Enable`, 44 unused, 45-49 (pedal types, unnamed), 50+ `MIDI CC n`
  (not modelled). Raw values 0..256 (= the plugin's 0..1 floats), text
  `trunc(v/256*100) + " % "`; FL ignores REC_FromMIDI for C++ plugins.
- FL's interface clamps every parameter to 0..256, so the cabinet (0 off, 1..20
  Model A..T, >20 off) and the types (0 none, 1..11 in menu order) can only be
  set by the plugin's menus: here integer, non-automatable params.
- Floats are truncated (`(int)`): 0.5 = no pedal / cabinet off. Enables and the
  EQ switch are on for any value > 0. Constructor state = Default.hdprg except
  EQ Enable 0.
- State blob: `SSLF` + size + `1RCH` + 50 floats + 256-byte name (the `.hdprg`
  preset format without the outer header). The plugin writes `DRCH` when it
  believes it is unregistered and then refuses to load `DRCH` states (resets
  to defaults); `1RCH` always loads. Knob values persist when a slot's type
  changes (seen in factory presets).
- Factory presets: the 98 `Default/*.hdprg` files, values reproduced in
  `src/model/fx/plugins/hardcore/presets.ts` (`def.presets`).

## Signal flow (measured)

input level -> fixed input filter -> pedal 1..5 -> graphic EQ -> cabinet ->
output level. (EQ and cabinet are after the pedals: a saturated pedal's output
keeps its harmonics through a -36 dB EQ notch, and the cabinet shapes them.)

- Levels: dB = 24 (2v - 1) (raw 0 = -24 dB, 256 = +24 dB). Exact.
- Fixed input filter: two DC blockers, poles at 31.5 and 28.5 Hz, gain
  (1 + p30)/2 (IR 0.998037, -0.0078232, ..., crosses zero near 500 samples;
  -10.1 dB at 20 Hz, -0.73 dB at 100 Hz). Within 0.1 dB.
- Graphic EQ: RBJ cookbook, BW = 1 octave (digital BW form): low shelf 125 Hz,
  bells 250, 500, 1k, 2k, 4k, 8k, high shelf 16 kHz; gain = 36 s|s| dB,
  s = 2v - 1. Exact (0.00 dB).
- Cabinets: magnitude responses of all 20 models measured (impulse, only the
  cabinet on), smoothed to 1/6 octave and fitted with HP + 2 LP + 7 bells
  (0.4-1.1 dB rms), including FL's absolute gain. M-T are stereo IRs (mostly
  identical channels; S differs by up to 12 dB at a few HF points) and play
  ~23 ms late in FL (IR peak at 1115 samples, latency not reported) - not
  reproduced. No IR is embedded.

## Pedals (knob order = Param 1..4; v = 0..1)

| pedal | measured model (exact unless noted) |
|---|---|
| Distortion | HP 589 Hz, INFERNO bass bell 86 Hz (+1.8 dB at 0, +24.3 at 50%, +40 at 100%), drive -> saturator -> broad 1.7 kHz dip, GLASS bell 2.43 kHz Q 0.42 gain 40(v-0.5) dB (exact), LPs 4.3 kHz (Q 2.2) and 2.7 kHz, COMB. Odd harmonics only. Drive / output staging per DIST fitted to output power: sine levels within ~1.5 dB (3.6 dB worst mid-level at 100%). **Approximated**: FL's fundamental dips at high drive (likely a different topology); COMB modelled as a short feed-forward comb. |
| Tube Stage | LOW = HP (982 Hz at 0 .. 9.5 Hz at 100%, table), fixed 2.1 kHz LP before the saturator, GAIN staging (small signal +5 .. +45 dB at 800 Hz), x/(1+|x|) (h3/h1 -> -9.5 dB, fits FL within 1 dB), HIGH = resonant LP (1.66 kHz .. 14 kHz Q 2.15, table), fixed 12.4 kHz LP. Filter fit 1.2 dB rms. |
| Chorus | dry 1 + voice A (8.573 ms, both sides) + voice B (11.042 ms L, 10.042 ms R), each -2 INTENSITY^2; delays sweep down by 4.28 WIDTH^2.3 ms; LFO 0.1 + 5 SPEED Hz. Voice phases and LFO shape **assumed** (sine, 120 degrees). |
| Flanger | dry 1 + voice -(0.11 + 0.894 I); delay between half and all of 0.125 + 4.846 W^2 ms; LFO 0.032 + 9.98 S^3 Hz; feedback -0.088; mono. |
| Phaser | 6 first-order all-passes at max(220, 6550 T^2) Hz swept up 1.78 W^2 octaves at 21 S^2 Hz, feedback 0.4, out = dry + I chain (static response fit 1.7 dB rms). |
| Reverb | dry 1 + FDN; RT60 from a measured table (0.41 s floor below 20%, 2.32 s at 50%, 17.3 s at 100%); HI-DUMP = HF loss per loop (1.75 v^2 dB per 45 ms; FL: 8 kHz RT 2.37 -> 0.98 s at 100%); wet 0.122 + 0.878 MIX^5 of full; L/R decorrelated, no pre-delay. Reverb structure is ours. |
| Delay | dry 1 + echo x -(0.1 + 0.9 MIX^2); time 995 TIME ms clamped 99.4..985.1 ms (same in ms at 44.1 kHz); feedback -0.96 DECAY^2 (polarity alternates); 1 Hz wow, p2p 3.13 sin(pi TIME) ms; linear interpolation (explains FL's per-repeat HF loss). |
| Noise Gate | hard gate, threshold -64 + 64 T dB (sine peak; opens -63.5 + 64 T, closes 0.5 dB lower), hold 100 ms, attack / release time constants 5.6 + 226 v^2 ms. |
| Equalizer | RBJ BW 0.98 oct: low shelf 300 Hz, bells 700 and 1800 Hz, high shelf 7 kHz; 20 s|s| dB. Exact within 0.03 dB. |
| Compressor | no make-up; peak follower on max(L,R): attack e^(2.061 + 1.949 A) ms, release e^(-0.371 + 2.202 R) ms; soft knee (40-52 dB wide), ratio 7.9:1 (RATIO 0) .. 44:1 (100%), threshold -38.7 .. -64.6 dB at TRESHOLD 0, +64 dB over TRESHOLD. Fitted to FL's static curves and attack/release grid (1.4 dB rms); **approximate** detector. |
| Modulator | signal at x2 through a vibrato line (between half and all of 0.125 + 9.8 PITCH^2 ms); LFO 30 RATE^2 Hz; gain 1 + AMP lfo; linear pan L (1 + PAN lfo), R (1 - PAN lfo). Same LFO for amp and pan **assumed**. |

Whole-preset check (synthetic guitar through 12 factory presets in FL and
here): overall RMS within -2.9 .. +3.4 dB, most within 1 dB; band differences
of several dB remain (LFO phases, distortion topology).

## Editor

767 x 485, layout measured on the manual's 1655-wide screenshot (stretched to
11 pedals) and `Hardcore_master.jpg` (767-wide top bar). Slot pitch 147 px,
casing 137 x 284 at y 148, face 117 x 138 at (+10, 180), footswitch 127 x 77
at y 334, combo boxes at y 455. Colours sampled per pedal. Bitmaps are
replaced by CSS / SVG and procedural textures; title fonts are system fonts
fitted to FL's widths; FL's logo is replaced by an engraved "HARDCORE".
Input / output boxes are level meters (FL shows dark boxes in the
screenshot). Presets: the PRESET display and arrows use `def.presets` and the
window's `__preset`.

## Open questions

- Distortion topology at high drive (FL's fundamental dips around -12 dB input
  at DIST 100%); COMB behaviour.
- Chorus voice LFO phases / waveform; modulator amp vs pan LFO relation.
- Box `Param 5` (unused by all 11 pedals here) and the hidden distortion
  "model" class (`CPedal_DistModelA`).
- Whether FL's 23 ms delay on cabinets M-T should be reproduced (with PDC).
