# Maximus

FL Studio's 3-band (LOW / MID / HIGH) plus MASTER maximizer. Files:
`src/model/fx/plugins/maximus.ts` (+ `maximus/curve.ts`, `maximus/presets.ts`),
`src/engine/effects/plugins/maximus.ts` (+ `maximus/core.ts`, `maximus/satA.ts`),
`src/ui/plugins/fx/maximus/`, `tests/fx/maximus.test.ts`.

Everything below was measured on FL Studio 2026's own `Maximus_x64.dylib` with
flfxhost (a private copy with `SaveRestoreState` support, so curves and options
could be set), comparing renders sample by sample. Status: **E** exact (matches
FL to float precision, error below -100 dB), **M** measured model (error noted),
**A** approximation.

## Parameters (59, index = FL Tag)

| idx | key | FL name | range | default | law / text |
|---|---|---|---|---|---|
| 0, 2 | lowFreq, highFreq | Low / High band frequency | 0..65536 | 19800 (200 Hz), 48065 (3 kHz) | 30 * (1600/3)^(v/65536) Hz, text `200Hz` (half up) |
| 1, 3 | lowSlope, highSlope | Low / High band slope | 0..1 | **1 (24dB)** | `12dB` / `24dB`. FL's insert state is the Default preset, which uses 24 dB |
| 4 | lmhDelay | LMH lookahead delay | 0..10000 | 1115 | 2 * (501^(v/1e4) - 1) ms, `2.00ms` |
| 5 | lmhMix | LMH mix | 0..1000 | 1000 | `100%`, round half up |
| 6 | lowCut | Low cut | -1..65536 | 32768 | -1 `Off`, else 5 * 16^(v/65536) Hz |
| 7 + 13b | {band}Mode | ... mode | 0..3 | 0 | on, compression off, muted, off |
| +1, +2, +5 | Pre, Post, SatCeil | pre gain, post gain, soft saturation ceiling | 0..2000 | 1000 | (7^(v/1000) - 1) / 6, `0.0dB`, `-InfdB` |
| +3 | Stereo | stereo separation | -1000..1000 | 0 | side gain: separated 1 + a, merged (1 - 0.2^(1-a)) / 0.8; `Original`, `N% separated/merged` |
| +4 | SatThres | soft saturation threshold | -1000..1000 | 0 | `No saturation`, `N% mode A` (< 0), `N% mode B` (> 0) |
| +6 | Att | attack time | 0..10000 | 1115 | 2 * (501^(v/1e4) - 1) ms, 0 = `Default` (instant) |
| +7 | Rel2 | release 2 time | 0..10000 | 0 | 4 * (501^(v/1e4) - 1) ms, 0 = `Default` (uses the attack) |
| +8, +10 | AttCurve, RelCurve | attack / release 2 curve, release curve | 1..8 | 2, 3 | number of smoothing stages |
| +9 | Rel | release time | 0..10000 | 5000 | 4 * (501^(v/1e4) - 1) ms (`85.53ms`) |
| +11 | Sustain | sustain window | 0..10000 | 2882 | 2 * (...) ms (`10.00ms`) |
| +12 | SusMode | sustain mode | 0..1 | 0 | `PEAK` / `RMS` |

Bands b = low, mid, high, master; names "Low band ...", "Mid band ...", "High band ...", "Master ...".
Value texts match FL's full sweeps except: time texts differ in the last digit
for 0.3 % of values (FL's float formatting), and percentage texts reproduce
FL's odd rounding with explicit exceptions (stereo 12.5 / 50.5 / 56.5 / 62.5 %
round down, saturation 50.5 / 56.5 % round down, |v| < 5 gives `Original` /
`0% mode A`).

State (not parameters): `curves` (4 x [x, y, tension, mode]), `solo`,
`oversample`, `masterMid`, `linPhase`, `safety` (default on), `lockSpare`,
view state (`band`, `display`, `vis`, `speed`, `freeze`, `snap`, analyzer `an`)
and the A/B `spare`. FL's binary state (version 3/0x0f): 59 + 59 (spare) int32
params, speed, selected band, flags (solo at misc byte 19, oversample int at 24,
master mid mode 32, legacy FIR 33), then 8 envelopes (4 bands + spare) in the
`.fnv` format: int32 3, flags, count, then (dx double, y double, tension float,
mode int32) per point and a 20-byte trailer. The 0.2 dB safety is not stored per
instance in FL.

41 factory presets (`Plugin presets/Effects/Maximus/**.fst`) were loaded into the
real plugin, re-saved in the current format and decoded (params, curves,
oversample, master mid mode). The 18 curve maps (`Data/Maps/*.fnv`) are in the
curve editor's "Open state file" menu.

## Signal flow (E unless noted)

1. **Low cut** (M): 8th-order high-pass, -3 dB at 0.8 x the shown frequency
   (phase 0 there), shape scales with frequency. Close to Butterworth but with a
   0.03 dB passband dip; implemented as 4 fitted biquads (complex error -62 dB;
   plain Butterworth would be -42 dB). This is the only residual in most presets.
2. **Band split** (E), RBJ biquads (bilinear, prewarped):
   - 12 dB = LR2 (one Q 0.5 section), 24 dB = LR4 (two Butterworth sections).
   - low = s1 LP1 [x AP(f2, Q 0.5) when the high slope is 24 dB],
     mid = HP1 LP2, high = s2 HP1 HP2, with s = -1 for a 12 dB crossover.
     The 12/12 sum is FL's near-allpass (-0.06 dB at 1 kHz).
   - OFF low band: mid = LP2(x), high = s2 HP2(x); OFF high: low = s1 LP1, mid = HP1;
     both OFF: mid = x exactly; OFF mid: dropped. All three OFF: silence.
     Quirk (measured, reproduced): with LOW + MID OFF the HIGH band's output is
     summed twice (2 x HP2 with compression off; with compression the processed
     band twice): -6 dB before, -101.8 dB now.
   - Biquads are direct form I and crossover frequency changes switch at the
     next block (FL; -84..-87 dB right after a change, before -3..-12 dB with
     our 256-sample glide). Slope changes (12 / 24 dB) leave a slowly decaying
     transient in FL that we do not reproduce (-23 dB for 512 samples, then
     -41 dB); low cut changes follow the fitted low cut (-10 dB / -22 dB).
3. **Per band**: stereo separation (M/S side gain) -> pre gain (ON only; COMP OFF
   skips it) -> compressor -> post gain -> saturation -> LMH mix with the band's
   own dry signal (the band after stereo separation, delayed like it). A muted
   band contributes nothing. MASTER's input is the sum.
4. **Compressor** (E, error about -145 dB on all detector settings):
   - detector: PEAK max(|L|, |R|) with a sliding-maximum sustain window;
     RMS sqrt(mean((L^2 + R^2)/2)) over the window (box);
   - REL: N = release curve one-pole stages on the *level*, instant rise,
     c = 1 - exp(-ln(100) sqrt(N) / T);
   - static curve on the level scale p = ln(1 + 2a) / ln 9 (0 dB = 0.5, +12 dB = 1),
     FL's table: output level for input levels k / 8192, k = 0..32768, linear
     interpolation, levels below 1/8192 use the first entry's gain, level <= 1e-6
     passes (gain 1, smoother untouched);
   - the 0.2 dB compressor safety multiplies a compressing band by 0.975;
   - ATT / REL 2: N = attack curve one-pole stages on the *gain*; each stage
     attacks when its input is below its state: c_att = 1 - exp(-ln(316.2) sqrt(N) / T_att),
     c_rel2 = 1 - exp(-ln(100) sqrt(N) / T_rel2), REL 2 = 0 uses c_att;
   - lookahead D samples (LMH delay for LOW / MID / HIGH while one of them is ON,
     the attack time for MASTER while it is ON): the band is delayed by D, the
     attack time becomes at least D samples and the sustain window at least D;
   - initial gain state = the curve's gain at level 0 (e.g. 0.4875 for a 2:1 line).
5. **Saturation** (B: E; A: M, -60..-85 dB): in the pre-post domain with ceiling
   c' = ceiling / post. B: linear to th = 1 - amount, then th + (1 - th)(1 - e^-(u-th)/(1-th))
   (u = |x|/c'), 100 % = 1 - e^-u. A: base curve N_a(u), normalised at
   xc = max(4, c') for an uncompressed band or max(curve's maximum output, 1, c')
   when compressing, clamped above xc; 100 % A = atan(u). Other amounts are FL
   lookup tables (FL rebuilds a table when type A changes): 31 measured rows
   (0.1 % .. 100 %) interpolated linearly.
6. **MASTER**: same as a band; OFF still applies its post gain (only).
7. **Master mid mode** (E): the MID compressor's detector hears the mid band,
   its gain, post gain and saturation apply to the full-band signal; LOW / HIGH
   compression is off; MASTER follows normally.
8. **Solo**: only the selected LMH band reaches MASTER.
9. **Oversample** (E): HIIR polyphase IIR halfbands, 6 coefficients, transition
   0.1 (FL's up/down impulse response matches exactly), around the band split and
   LMH bands; MASTER at the base rate; LMH delay = 2 x the base-rate delay;
   FL reports 5 extra samples. FL's int values 2 and 3 (other filters) are not
   offered by its menu and are treated as 2x.
10. **Linear-phase split** (M/A): FL's legacy FIR mode: 2 ms half-length FIRs,
    low = LP(f1), mid = LP(f2) - LP(f1), high = delayed x - LP(f2); LP = sinc x
    bell window exp(-|k fc / (C sr)|^p), not normalised (FL's 200 Hz low band is
    -7 dB at DC). Fitted C, p: 12 dB 0.1205, 2; 24 dB 0.252, 1.5 (24 dB presets
    -65 dB, 12 dB band-muting cases -28..-42 dB). The LIN button drives the same
    mode (FL stores LIN elsewhere; its FFT precision menu is not reproduced).

11. **No sidechain input**: FL 2026's Maximus never calls FHD_GetNumInOut /
    FHD_RegisterSideInput and its output is bit-identical with and without a
    sidechain signal (flfxhost `--sc`). Its "sidechain" effects are internal
    (Master mid mode, a band's detector driving the whole signal); the clone has
    no external sidechain either.

Latency = LMH delay (when an LMH band is ON) + split delay + master attack
(when MASTER is ON), as FL reports through FHD_SetLatency (176 samples at
44.1 kHz by default). With oversampling FL reports the base-rate LMH delay
only, not its resampler pair (Pow preset, lmhDelay 0..4000: 88..1060
samples; the former +5 put our oversampled presets 5 samples off after
delay compensation: Pow -3 dB before, -80.6 dB now). `tail` = latency + 50 ms.

Gain changes: band / master post gain, pre gain and saturation ceiling step
at the next block (post gain measured exact); the LMH mix ramps across the
block (exact). Stereo separation: FL glides it over ~400 samples in two
linear segments (not reproduced; we ramp across one block: -16 dB in the
first block, -36 dB after); pre gain with compression on: -14 dB in the
first block after a change.

## Calibration results

All 41 factory presets on a drum loop and on decorrelated stereo noise: worst
-61 dB, median -71 dB relative error against FL's output (presets without the
low cut: -95..-133 dB). Unit tests store FL numbers: Default limiting to
-0.22 dBFS, latency rules, a 3-tone signal through five presets (RMS and sample
values), crossover magnitudes, attack / release / sustain laws, saturation
points, stereo gains and master mid mode.

## Editor

626 x 385 at FL's form coordinates: curve editor (points, tension handles,
FL's Single / Double curve / Hold / Stairs / Smooth stairs via right-click,
add / delete, SHIFT / CTRL locks, SNAP to 0.05, FREEZE, envelope menu with the
maps, copy / paste, flip, normalize, reset), MONITOR (scrolling main / band
input / output peaks, analysis and gain envelopes, all gain envelopes, level
markers; click pauses; SPEED) and BANDS (band regions at their post gains,
input spectrum, detected frequencies, drag boundaries and levels; flashes while
a crossover knob moves), FL's options menu, band tabs, mode switch, SOLO, all
knobs and switches, LIN, A/B spare state, compression indicators.

## Open questions

- Low-cut prototype (not Butterworth, not Chebyshev); FL's exact design.
- Type A saturation formula (tabulated here).
- FL's newer LIN (FFT) mode and its precision / crossfade menu; where it is stored.
- Histogram / heatmap analyzer options are stored but drawn as a simple spectrum.
- The LOW + MID OFF quirk (high band about 6 dB louder in FL).
