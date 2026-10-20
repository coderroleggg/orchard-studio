# FL Studio Mobile Rack FX (`mobilerack`)

FL Studio 2026, *Effects > Misc > FL Studio Mobile Rack FX* (`FL Studio Mobile Rack FX_x64.dylib`,
LongName "Mobile Rack FX"). A modular rack that hosts FL Studio Mobile's effect modules in series.
Everything below was measured on FL's own binary with `flfxhost` (48 kHz, 130 BPM unless noted)
or read from its state chunks and strings. Files:

- model: `src/model/fx/plugins/mobilerack.ts`, module table `src/model/fx/plugins/mobilerack/modules.ts`
- DSP: `src/engine/effects/plugins/mobilerack.ts` (rack) + `src/engine/effects/plugins/mobilerack/*` (modules)
- editor: `src/ui/plugins/fx/mobilerack/` (`index.tsx`, `panels.tsx`, `controls.tsx`, `mobilerack.css`)
- tests: `tests/fx/mobilerack.test.ts`

## Plugin interface and state

- `NumParams` is 0: FL exposes a module control only after *Activate* (right-click). We declare
  no static parameters; every module value is automatable through the state path
  `params.mods.<id>.p.<index>` (0..1), the module mixer through `params.mods.<id>.mx.<k>`.
- FL state (`SSLF` + chunks): `HEAD`, `RACK` { `RHED`, `RPRM` (6 floats), `FOUT`, `RMOd` per module
  { `HEAD` (type id, uid, flags), `DESC` ("Default"), `PRST`, `ADD1`, `PRMS` (normalised floats,
  [0] = Enable), `SMPR` (3 floats) } }, `PMAP` (activated controls: uid, param index, 1). Writing
  PMAP entries is how the host exposed module parameters for sweeps and renders.
- Our state: `{ mods: { [id]: { id, type, p[], mx[3], min? } }, order: id[], next }`.
- Factory presets (FL's preset folder, values recreated, not copied): `Default` (one Reverb 2 with
  FL's Default.fst values - also our default state, as FL loads Default.fst on insert), `Empty`,
  and one per module (folders Echo / Filter / Level / Misc, listed flat in FL's order).

### Rack- and module-level mixing

- `RPRM[0]` is a master volume (0.8531 = 0 dB, 1.0 = +6.02 dB, 0.5 = -16.46 dB, 0 = silent) and
  `RPRM[1]` a linear balance; `RPRM[2..5]` had no audible effect. FL's editor shows none of them,
  so they are not reproduced (unity).
- `SMPR` = the module mixer behind the header's mixer button: level = 40 (v - 0.5) dB applied to the
  wet signal only, mix = linear dry/wet, pan = wet balance (left mix x min(1, 2(1 - p)), right x
  min(1, 2p)). Measured: Distortion at -24 dB, mix 0.5 -> -16.05 dB; level +20 dB at mix 0.5 -> -6.91 dB. Exact.
- Enable off = full bypass (level ignored). We crossfade 10 ms and clear the module once silent.
- Latencies (FL does **not** report latency to the host, and the module mixer's dry path is not
  compensated): Equalizer 1, Filter 1, Graphic / Tuned EQ 8 samples, Limiter 96 (2 ms look-ahead),
  Gate 255 (5.3 ms look-ahead). Reproduced exactly (not reported either).

## Modules (29)

Type ids, FL GetName names (module prefix removed), defaults (FL's module presets) and value texts
were dumped for all modules. Value texts are computed in single precision and printed with C
`printf` (ties to even, "-0.0"), which `modules.ts` reproduces; 5834 of 5925 swept texts match.
The rest are FL quirks we chose not to copy (FL prints a constant text for Compressor Auto gain /
RMS, Comb Filter Mode / Polarity, Spacer M/S Inversion, Tape Stop Warp / Sync) and default texts
computed from FL's unquantised floats. Several FL texts are a bare 0..100 number where the module
UI shows a choice (EQ Kind / Channel, LFO shapes, Trance Delay Time / Mode...): our hints keep FL's
number, the editor shows the choice.

| Module | Status | Notes |
|---|---|---|
| Equalizer (Param EQ) | exact design | Analog RBJ prototypes, impulse-invariant poles, FL's numerators (fitted with Prony): peak = 1 + (G-1)(1-r)(1-z^-1)(1/2 + (r+1/2)z^-1)/D; low shelf = 1 + (G-1)[D(1)(1/16+10/16 z^-1+5/16 z^-2) + BP/(A+1)]/D; high shelf = G x low shelf(1/A). Gains are **twice** the displayed dB (FL's "+12 dB" boosts 24 dB). Kinds: Low Shelf / Peaking / High Shelf (trunc v x 2). BW = 0.25 + 7v octaves, f = 32 x 2^(9.25 v). Per-band channel (Stereo/L/R/M/S). Error < 0.06 dB for peaks, < 0.5 dB for shelves / peaks above 5 kHz. |
| Graphic EQ | exact | RBJ low shelf 80 Hz, bells 160..6 kHz, high shelf 12 kHz, 1 octave (cookbook digital BW), +-24 dB. Bit-exact responses. |
| Tuned EQ | exact | Same family on C2..C9 (+ Tuning semitones), BW = 0.1 + 10 v^3 octaves. Bit-exact. |
| Filter | exact | 2/4/8 cascaded RBJ sections, Q = 0.4 + res^2, f = 16 x 2^(10.3 v); BP = skirt-gain sections with 2Q; LP/HP sections carry a frequency- and Q-dependent gain (2/sqrt5 at DC, up to 1.23 near 10 kHz) - tabulated from FL; HP gain = sqrt(1.25) x LP's. < 0.04 dB. |
| Compressor | laws exact, curve approximated | Threshold -40..0 dB, ratio 1 + 19 v^2 (inf), attack 50 v^2 ms, release 10 + 490 v^2 ms, hold 50 v^2 ms; Level is 40 v dB (text 20 dB lower), Auto gain adds -20 dB - thr(1 - 1/r); Input gain drives the detector. FL's static curve compresses harder near the threshold at low thresholds (up to +3 dB more GR) - not identified; ours is a hard-knee feed-forward design. |
| Limiter | exact | 2 ms look-ahead brick wall (min filter + moving average), in/out +-24 dB, threshold -24..0 dB, release 0.1 + 1.9 v^4 s. Static curves identical. |
| Gate | close | Look-ahead 5.3 ms, open threshold -60(1 - v) dB, hysteresis 66 v^2 dB, attack / release / hold 1000 v ms (hold = minimum open time), curves blend linear and dB-linear ramps, mix -100..100 % (negative = inverted gate). Burst envelopes match. |
| Leveller | exact law | -60 + 72 v^0.6 dB (FL's texts differ by <= 0.1 dB at a few points), linear balance. |
| Autoduck | close | One cycle per beat, locked to the song position; floor (1 - d)^1.645; attack ramp, hold, recovery over Time along FL's measured curves (Shape 0, .25, .5, .8, 1 tabulated, interpolated), blended to linear by Curve; Shift. Within ~0.03 of FL's envelopes. |
| Multiband Compressor | approximated | Crossovers 20 x 2^(9v) Hz (LR4 + all-pass compensation), per band input / threshold / ratio 1 + 30v / attack 50 v^2 / release 10 + 990 v ms / gain / On-Bypass-Mute / width, dry mix v^2, "Safe" mode as a soft limiter. Laws from FL's texts; dynamics not compared in detail. |
| Distortion | exact | Hard (1+g)x/(1+g abs x), g = 10^(5d) - 1; Tube tanh(gx)/tanh g, g = 10^(4d) - 1; Soft = exponential curve with small-signal gain 1 + 46 d^2 (curve approximated, < 1.5 % rms); Clip = clip(10^(3d^2) x). Bias (2v-1)^5 before the curve + 35 Hz DC blocker; BitCrush = sample-and-hold of 1 + 256 v^4 samples; Stereo scales the drive per channel; Gain -24..0 dB. |
| Waveshaper | approximated | FL's six curves (Analog, Moshpit, Foldback, Chainsaw, Rectifuzz, Cyclone) were only characterised (describing functions: Y sets +2..+22 dB into the curve, X extremes -6 dB, Drive up to +42 dB, Rectifuzz at X = 0.5 cancels the fundamental). Curves are our approximations; EQ (fixed 60 Hz roll-off, low / high cut, bass / mid / treble) and LFO to X / Y follow FL's parameter laws. |
| Chorus | close | One voice per channel in a 10 ms buffer, voice gain 2 mix^2 on top of the dry signal; left voice 475 - 74 d^1.47 +- (0.8 + 76 d^1.76) samples (FL: 417..470 at default); FL's right voice sits at the end of its buffer (reads wrap onto the newest sample) - reproduced; Stereo blends the voices into both channels. LFO 0.2 + 4 v^2 Hz. |
| Flanger | close | Delay 3 samples + 2.5 v^2 ms x 119/120, LFO x (1 + 0.49 amount); LFO sine / saw / square (round v x 2), free 0.1 + 9.9 v^3 Hz or synced; Stereo = right LFO phase up to 180 deg; wet = +-mix^2, feedback +-v. |
| Phaser | close | Six first-order all-passes whose coefficient uses f/sr in place of tan(pi f/sr) (FL's notches sit at f_text/pi), feedback v (notch depth fb/(1+fb) measured), wet mix^2, Stereo = LFO phase offset. Sync divisions measured: "1 Bar" = 16 beats (list doubles from 1/4 beat to "16 bars" = 256 beats). The LFO depth law (we move the Frequency knob by 0.75 x amount) is an approximation. |
| Tremolo | close | Raised-cosine / triangle LFO, skew, shape (square .. peaky), width offset, min / max, phase and stereo offsets; free 0.1 + 19.9 v Hz or FL's irregular sync list (boundaries swept). |
| Wow & Flutter | close | Fully wet modulated delay in a 10 ms buffer: wow 10 ms and flutter 3 ms peak-to-peak at full amount (measured); Random jitters both rates (FL showed no effect of Random alone). |
| Comb Filter | close | Delay sr/f + 3 samples, feedback v, wet = mix x tap, dry 1; pitch from Pitch (1 + 2499 v^4 Hz) or Octave / Note when Snap is on, Offset +-2 octaves, Asymmetry +-5 % L/R, Smoothing glide; Audio Pitch mode tracks the input pitch. |
| Tape Delay | exact | 1000 v^2 ms (+3 samples), linear interpolation, no tone or saturation; line fed x + fb x tap, output x + mix x fb x tap (no echo at all with Fdbk 0), Async shortens one side by up to half. |
| Trance Delay | exact | 1/4, 3/8, 1/2, 3/4, 1/1 beat (trunc v x 4), whole-sample delay, feedback x 0.99, loop filter (v < .5: one-pole LP pole 1 - 2v; v > .5: x - LP with coefficient (2v-1)^4); modes (round v x 2) Normal / Ping-Pong (crossed lines) / Offset (two-division echo, left output delayed one division - 1 sample); the last parameter balances the inputs. FL's GetName names of parameters 5 and 6 are empty ("Mode" and "Pan" are ours). Echo gains and positions identical. |
| Reverb 2 | calibrated | FL Mobile's Reverb 2 has Fruity Reeverb 2's controls. Ours is a compact rendition matched to FL: HIGH / LOW CUT one-pole input filters (19 + 2981 v Hz), early reflections at 37.5 / 28.5 ms x size through three all-passes (5.3, 1.75, 5.3 ms, gain from DIFFUSION), late part from 19.9 ms x size (+DELAY) through four diffusers into an 8-line FDN, RT ~ 1.3 x DECAY, bass multiplier below CROSS, DAMPING = 50/50 one-pole blend on the late output; the late output also carries the early reflections (FL's ER and late outputs add coherently). Late energy 0.041 vs 0.043 (decay 1 s) .. 0.121 vs 0.118 (10 s); ER 0.042 vs 0.043; first arrivals within 1 sample. SIDE INPUT is not routed. |
| Spacer | exact structure | L/R delay 300 x^3 ms (positive delays left), balance, separation (mid/side gains), L/R inversion, M/S delay 100 x^5 ms (positive delays mid), M/S inversion, stereo mode (Standard / Output M/S / Input M/S). FL's delays read 1.4..2.6 samples short and its -100 % separation is asymmetric (right +25 %) - not copied. |
| Stereoizer | exact structure | L +- s, s = strength^2 x filter(delay(L + R)), delay 0.5 + 49.5 timbre^3 ms; focus > 0: x - one-pole LP (coefficient focus^3), < 0: LP (1 - abs(focus)^(1/3)); L/R delay +-25 ms (one sample short, as FL); balance. |
| Spreader | approximated | FL's Width had no measurable effect in the host and its side processing was only partly identified (Haas-like 6.3 ms cross terms with Separation). Ours: first-order split at Low Bypass, mono bass option, side gain from Separation, a 6.3 ms Haas side signal from the mid scaled by Width. |
| Tape Stop | approximated | Variable-speed playback (12 s buffer), spin down / up over the stop / start times (5v s; the "(sync)" pair when Sync is on), Warp shapes the speed curve; Play toggles; with Sync the transport also stops it. |
| Multi FX | approximated | Eight effects with X/Y and an LFO on X; FL's exact mappings not identified. |
| Pitcher 2 | approximated | Pitch tracker (YIN on a 12 kHz decimation), nearest enabled note, speed smoothing, stability, humanisation, vibrato, mix, two-grain pitch shifter; formant shifting not reproduced. |
| Analyzer / Tuner | functional | Pass-through with spectrum / scope / level and pitch displays. |

## Editor

Layout from FL's manual screenshot (`FLStudioMobile_Rack.png`, 575 x 605 client area): orange
"Mobile Rack" title bar, slate background, module panels 508 px wide (header: power switch with
orange dot, mixer button, "FX <name>", "Default" preset selector with arrow, menu), tab rows
(selected tab white with an underline), orange ring knobs with the value inside (handle from ~7
to ~5 o'clock), vertical sliders, chevron spinners, segmented selectors, an orange line under each
module, the (+) Add Module button and an orange scrollbar. Module menu items are FL's (binary
strings): Enable / Disable module, Minimize / Maximize module, Minimize all, Maximize all, Move up /
down, Insert above / below, Replace module, Copy module, Paste, Delete module; the title bar holds
the rack menu (Add module, Copy / Paste / Clear rack). Add Module lists the modules by FL's preset
categories (Echo, Filter, Level, Misc). Module presets: FL ships one ("Default") per module.

## Open questions

- Compressor static curve (threshold-dependent effective ratio, input-gain saturation).
- Waveshaper curve shapes, Multi FX X/Y mappings, Spreader width, Pitcher 2 formants.
- Phaser / Flanger LFO depth laws in detail; Tremolo "Shape" family.
- Leveller's exact law (FL texts differ by up to 0.1 dB from -60 + 72 v^0.6).
- Whether FL stores some choices (Comb Mode / Polarity / Snap, Spacer M/S Inversion) as raw indices.
