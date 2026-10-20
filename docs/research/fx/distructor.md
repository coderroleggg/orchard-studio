# Distructor (FL: Distructor)

Sources: FL 2026's plugin binaries — the rack `Distructor_x64.dylib`
(TTestPlug: SaveRestoreState 0x5d080, Eff_Render 0x5eaa0) and the module
plugin it hosts four times, `Distructor/module/module_x64.dylib` (TTestPlug
SaveRestoreState 0x5ead0; DSP classes TDistortionProcessor, TFilterProcessor,
TChorusProcessor, TConvolverProcessor, TLinearSVF, TSFV4, TCombFilter,
TVowelFilter, TPhaser, TRateReducer, TBitCrusher...), the cabinet list in
the module binary, the manual, FL's screenshot, the 47 factory presets
(decoded from the state FL's plugin saves for each .fst), and renders through
FL's plugin with crafted states (`flfxhost --state`, see the scratchpad kit
`fx/wd/dx2.py`).

## Structure

Up to four modules in series (left to right), each a **Distortion** (18
models), **Filter** (22), **Chorus** (3) or **Speaker** (59-entry cabinet
list), then the optional **Soft clip output**. Without modules the plugin is
an exact passthrough (latency 0).

Per module (measured):

```
x * in -> [up 2^os] -> effect (wet) -> dry + (wet - dry) * mix -> [down 2^os] -> Center -> * out
```

- `in`, `out` = raw / 5000 (text 20 log10, "-InfdB" at 0, 6.0dB at 10000);
  `mix` = raw / 10000, a linear crossfade; the dry path is the signal after
  `in` (so it also passes the oversampler).
- Oversampling 0..4 = 1x..16x, distortion and filter modules only (the
  state field is ignored by chorus / speaker modules): k cascaded HIIR
  polyphase half-bands, 6 coefficients, transition 0.1 — the same filters as
  Fruity WaveShaper (impulse responses match FL to 1e-5). No latency is
  reported. The model DSP runs at the internal rate with the same per-sample
  code (e.g. Blood Overdrive's filters move up with the rate).
- Center (distortion modules only): FL's WaveShaper DC remover
  `v += (x - p) a; p += v; v *= 0.96; y = x - p`, a = 2.2835e-5, at the base
  rate after the mix (step response matches FL to 1e-5).
- Power off: untouched passthrough (gains bypassed).
- in / mix / out are single precision and change at the next block (FL, no
  glide). With oversampling FL applies them inside the oversampled section
  (after the upsampler, before the downsampler); the mix is
  `f32(f32(f32(dry (1 - mix)) + f32(wet mix)) out)` (bit-exact).
- Soft clip output: the Soft Clipper curve with T = 100/128:
  `|x| <= T: x; else sign(x) (T + (1 - T)(1 - exp(-(|x| - T)/(1 - T))))`.
- Meters: input and each module's output (FL measures them in Eff_Render),
  shown with FL's dB scale (marks every 3 dB: 0 dB at y 55.7, 39 dB at y 315.7).

## State (FL SaveRestoreState)

Rack (version 5): `int32 5, int32 count, count x module block (231 bytes),
uint8 softClip, int32 4, int32 colour[4], int32 0, uint8 showMeters`.
Module block (version 4): `int32 4, int32 type, int32 distModel, int32 os,
uint8 center, uint8 bypass, int32 filterModel, uint8 smooth, int32 cabinet,
int32 params[49], int32 0, int32 chorusModel`. The colour array keeps each
module's accent colour (orange, green, blue, purple) when modules move.
Chorus models are stored as 0 Stereo, 1 Mono, 2 Wide (identified by routing:
Mono sums L/R, Wide swaps the channels). Cabinets: index into FL's list of 59
(group headers at 0, 20, 27, 38).

Our state: `modules` (0..4 descriptors: type, dist, filter, chorus, cab, os,
center, smooth, bypass, color), `softClip`, `meters`, plus the 196
parameters `m<slot>_<control>`. Moving a module swaps its descriptor and its
49 values; removing shifts the following slots left; a new module starts
from FL's constructor values. FL inserts the plugin with its "Default"
preset (Harmor Classic with cut 1100, Low pass 12 with resonance 2616,
Stereo chorus with delay 1, Combo 05 cabinet, soft clip on); these are our
defaults. All 47 factory presets are in `def.presets` ("Folder/Name").

## Parameters (index = 49 * slot + control)

| ctl | name | range | default | text |
|---|---|---|---|---|
| 0-4 | Blood overdrive: pre band, color, pre amp, post gain, post filter | 0..10000 | 0, 5000, 0, 10000, 0 | v/100 % (half up) |
| 5 | Blood overdrive - X100 | 0..1 | 0 | Off / On |
| 6 / 10 | Wave folder / Aperture - Pre amp | 0..10000 | 500 | 20 log10(1 + v/500) dB |
| 7, 8 / 11, 12 | crossover, asymmetry | 0..10000 | 5000 | (f32(f32(v/5000) - 1) 100) % |
| 9 | Wave folder - Threshold | 0..10000 | 10000 | 20 log10(0.1 + 0.9 v/10000) dB |
| 13 | Aperture - Threshold | 0..10000 | 10000 | 20 log10(0.5 + 0.5 v/10000) dB |
| 14, 15 | Aperture - Warp point, Mode | 0..10000, 0..1 | 2000, 0 | v/100 %, A / B |
| 16 | Fast dist - Pre amp | 64..192 | 128 | (v-64)/192 % |
| 17 | Fast dist - Threshold | 1..10 | 10 | (v-1) 10 % |
| 18, 19 | Fast dist - Postgain, Mix | 0..128 | 128 | v/128 % |
| 20 | Fast dist - Type | 0..1 | 0 | Off / On (A / B) |
| 21 | Soft clipper - Threshold | 1..127 | 100 | (v-1)/127 % |
| 22 | Soft clipper - Post gain | 0..160 | 128 | v/160 % |
| 23 | Harmor - Pre amp | 0..1000 | 500 | v/10 % |
| 24 | Harmor - Asymmetry | -500..500 | 0 | "N% stereo" / "N% mono" |
| 25 | Harmor - Wet vol | 0..2000 | 1000 | v/20 % |
| 26 | Harmor - Dry mix | -1000..1000 | 0 | trunc(v/10) % |
| 27 | Harmor - Filter cut | 500..1100 | 950 | Hz + note, note 72 + 0.12 (min(v,1099) - 500) |
| 28, 31 | Abrasive - Pre amp, Post gain | 0..10000 | 2000, 5000 | 20 log10(1 + v/5000) dB |
| 29 | Abrasive - Gate thresh | 0..10000 | 5000 | 20 log10(v/10000) dB |
| 30, 32 | Abrasive - Dry/wet, Noise bp | 0..10000 | 2000, 8400 | v/100 % |
| 33 | Abrasive - Filter | 0..1 | 0 | Off / On |
| 34 | Crusher - Rate crush | 0..10000 | 0 | "Max Hz", 44100 / hold(1 - v/10000) (Delay 3's cubic) |
| 35 | Crusher - Bit crush | 0..10000 | 0 | "Max bits", 16 - 14 sqrt(v/10000) bits |
| 36-38 | Input / Mix / Output volume | 0..10000 | 5000, 10000, 5000 | dB / % / dB |
| 39, 40 | Filter Cutoff, Resonance | 0..10000 | 10000, 0 | v/100 % |
| 41, 42 | Input / Output stereo separation | -1000..1000 | 0 | "N% separated" / "Original" / "N% merged" |
| 43 | Chorus delay | 1..216 | 108 | Delay 3's time law on v/768 (ms) |
| 44 | Chorus feedback | 0..3840 | 2880 | f32(f32(v/6000) 100) 1.25 % |
| 45 | Chorus speed | 0..6000 | 1500 | Delay 3's displayed modulation rate |
| 46, 47 | Chorus depth, blur | 300..6000, 0..6000 | 1995, 0 | f32(v/6000) 100 % |
| 48 | Chorus color | -3000..3000 | 0 | v/30 % |

All texts were checked against full FL sweeps: the distortion and rack
texts round half away from zero on the exact value (JS toFixed), the chorus
and separation texts (Delay 3 code) round half to even on single-precision
values. 0 mismatches except 0.01 Hz on some cut values (float32) and the
crusher rate's last digit at very high rates.

## Distortion models

| # | model | DSP | fidelity |
|---|---|---|---|
| 0 | Blood overdrive | FL's Blood Overdrive code (single precision; no pre-settling after a load: it glides from 1, 1, 1, 0) | bit-exact at 1x / 2x, -121..-127 dB at 4x / 8x |
| 1 | Fast dist | FL's DistWave table, truncating kernel in single precision (also when exporting, measured) | bit-exact (was -111..-122 dB) |
| 2 | Soft clipper | curve above, x (11^(v/128) - 1)/10 | -134 dB |
| 3-13 | Harmor | closed-form shapers, wet / dry crossfade, asymmetry per model, LR4 post low-pass | -103..-145 dB |
| 14 | Wave folder | triangle fold `T tri(g b / T)` | sample-exact |
| 15 | Aperture | mode A wrap, mode B multi-wrap | sample-exact |
| 16 | Abrasive | rectified input x FL's noise, gate, band-pass | sample-exact (FL's RNG) |
| 17 | Crusher | sample-and-hold, then truncating quantiser | sample-exact |

Harmor models (all exact closed forms, measured; evaluated per sample, no
table, no clamp at |x| = 1), g = 2^((pre - 400)/100), a = asym/500:

| model | curve |
|---|---|
| Classic | tanh(pi g z) / (pi tanh g) |
| Hill | (exp(tanh(pi g z)) - 1) / (pi tanh g) |
| Flathat | tanh(exp(pi g z) - 1) / (pi tanh g) |
| Cube | tanh(4 pi g z)^3 / (pi tanh(16 g)^3) |
| Log | sign(z) ln(1 + b|z|) / (ln(1 + b)(1 + pre/1000)), b = 2^((pre - 200)/40) |
| Softsat | cbrt(tanh((pi h z)^3)) / (pi tanh h), h = 2^(pre/200 - 3) |
| Rubber | sign(z) sin(k sqrt|z|) / sqrt(k), k = (pi/2) 2^(pre/500) |
| Ribbon | t(x) t(x + p) t(x + 2p) / (pi tanh g), t(u) = tanh(pi g u) |
| Sincrush | x + 4^-a sin(N pi x) / (N pi), N = 2^(7 - 7 pre/1000) |
| Bitcrush | roundHalfAway((x + a_ch / L) L) / L, L = 2^(9 - 7 pre/1000) (single precision) |
| Bitjam | log-companded quantiser, A = 2^(10 + 10 a), L = 2^(10 - 7 pre/1000) |

- Asymmetry: models 3-9 add `z = x + off`, off_L = 0.75 a^2, off_R = +-0.75 a^2
  ("mono" / "stereo"), no DC compensation (Center removes it); Ribbon spreads
  its factors by p = a^2 (p_R = a|a|); Sincrush and Bitjam use it on both
  channels; Bitcrush puts the sign on L.
- Wet / dry: `m = w (1 - |d|) s + d x`, w = (3^(wet/1000) - 1)/2, d = dry/1000
  (the dry term uses the input without the offset).
- Post filter after the sum: Linkwitz-Riley 24 dB/oct (two Butterworth
  biquads, prewarped bilinear, direct form I) at
  fc = 523.2511 2^((cut - 500)/100) Hz, at most 0.4999 sr - 45, at the
  module's internal rate; cut 1100 bypasses it.
- FL kicks the asymmetry offset the wrong way for one block after a change
  (`v_old - exp(-307/sr)(v_new - v_old)`), also after loading (old = 0);
  reproduced (-134..-146 dB through asymmetry changes and loads).

Wave folder / Aperture / Abrasive / Crusher (from the module's disassembly,
verified sample-exact on 160+ settings, oversampled too):

- Shared offsets, in input units before the pre amp: `sx = f32(asym/5000) -
  1`, `cx = f32(cross/5000) - 1`, `a = x + sx`, `b = a + sign(a) cx`
  (sign(0) = 0). Pre amp `g = f32(1 + f32(v/500))`.
- Wave folder: `T = 0.1 + 0.9 v/10000`, `y = T tri(g b / T)` (unit triangle,
  period 4). Aperture: `T = f32(0.5 + 0.5 v/10000)`, warp point `P = 1 - 2w`
  (an absolute level); mode A `|v| <= T ? v : fmod(v, T) + P - T`; mode B
  wraps `|v|` into (P, T] by subtracting `T - P` up to 8 times, then clips at
  +-T.
- FL smooths crossover / asymmetry oddly: the first block after a change
  uses `old + f (old - new)` (a step the wrong way, f = 0.9931 at 44.1 kHz),
  then the new value; a new or loaded module starts from offset 0, so its
  first block kicks too. Reproduced bit for bit.
- Abrasive: `y = clip1(post ((1 - mix) pre x + mix pre |x| [|x| > gate] n))`,
  pre / post = f32(1 + v/5000), gate = v/10000 (instantaneous, before the pre
  amp), n = FL's Mersenne Twister (seed 19650218, FL's twist off-by-one),
  uniform -1..1, one value per frame for both channels, paused while dry/wet
  is 0; Filter on = Simper SVF band-pass of the noise at 20 2^(v/1000) Hz,
  k = 0.505, single precision.
- Crusher: sample-and-hold first (phase accumulator, period
  `P0(d) = 0.0002 d^3 - 0.0171 d^2 + 0.7435 d + 1`, d = 127 (v/10000)^3 at
  44.1 kHz, scaled with the rate; silent until the first capture), then
  `trunc(x 2^bits) / 2^bits` with bits = 2 + 14 (1 - v/10000). FL's display
  computes the Hz from v/10000 linearly, so above the ends it disagrees with
  the DSP (5000 shows 1447 Hz, holds 9.29 samples = 4745 Hz).

## Filter models (sample-identical to FL)

Decoded from the module binary (TFilterProcessor and its filter classes)
and verified bit for bit (impulses, loud noise, sweeps, automation, smooth
on / off, 44.1..705.6 kHz, the 2x oversampled path). c = cutoff/10000,
r = res/10000; cutoff fc = 20 2^(10 c) Hz for every cutoff-based model.

| models | structure |
|---|---|
| LP6, HP6 | bilinear one-pole (resonance unused) |
| LP12, HP12, BP12, Notch, Peak, Allpass | Simper trapezoidal SVF, k = 1 - 0.99 r (Notch 1 - 0.792 r); BP = raw band (peak gain Q), Peak = HP - LP (2/k at fc), Allpass = x - 2k band |
| LP24, HP24 | two identical SVFs, k = 2 sqrt(1 - 0.99 r) |
| Low / High shelf | SVF shelf modes, gain 40 r - 20 dB |
| LP / BP / HP 12 Alt | Chamberlin SVF run 4x per sample with a soft-clipped resonance term (self-oscillates above res 5000) |
| Low pass 24 Alt | 4-pole ladder, feedback 4.05 r, input 0.2 (x + 0.35), saturator, DC blocker 0.005 / sample |
| Comb + / - | feed-forward / feedback, gain 0.95 r, delay 0.05 s x c (16384-sample ring) |
| Vowel | 8 parallel band-passes (Q 12) morphing three formant sets, shifted by 2^(1.7 (r - 0.5)) |
| Phaser 1 / 2 / 3 | 5 / 4 / 6 SVF all-passes at 28.5 2^(9.27 c) Hz, feedback -0.728 / +0.728 / -0.728, 100 % wet, DC high-pass; Phaser 2 adds a 576 s triangle LFO |

All coefficients are recomputed for the module's internal (oversampled)
rate. Smooth: the normalised cutoff (and the resonance of the 24 dB, Alt,
comb, vowel and phaser models) glides, 90 % in 10 ms; off, values change at
block start. A new or loaded FL processor starts at c = r = 0.5 and glides
from there; so does ours (bit-exact from a state load).

## Chorus (FL's Delay 3 engine; -101..-122 dB from state load)

FL's chorus processor loads Fruity Delay 3's engine and drives it with fixed
settings (keep pitch, Saturate at level 0, LP feedback filter fully open,
10 Hz DC blocker in the feedback, rate / bits off, wet 1, dry 0); there are no
voices. Mapping: delay -> time raw/768 (T = 0.001 + 0.999 ((0.06 + 0.94 x)^3 -
0.06^3)/(1 - 0.06^3) s, = the display law; D = trunc(sr T)), feedback ->
raw/6000 (gain raw/4800), speed -> mod rate (period table [8.872, 3.808,
1.833, 0.878, 0.398, 0.15, 0.05] s read at 0.99 x the displayed position),
depth -> mod time (read position D + A (u + 0.5), u = (1 + sin)/2, A = 0.05 sr
depth^2 sqrt(P/8.872), gliding -40 dB in 0.1 s), blur -> diffusion level and
spread (one write-side allpass, c = 0.499 blur), color -> output tone (1st
order LP down to 270 Hz / HP up to 4200 Hz). Saturator y = x - x|x|/4 (so DC
0.5 -> 0.4375). Models: Stereo = True Stereo with offset +68 % (L pre-delay
0.1156 D), Mono = (L + R)/2 into one line, Wide = Ping Pong (an L input
appears on R first). The LFO starts at phase 0 at state load; feedback /
blur / color step every 8 samples (-20 dB in 20 ms); a delay change runs a
0.1 s crossfade between two tap sets; the first ~0.1 s after load repeat FL's
start-up glides (dry leak, brief S&H / bits). The module's oversampling does
not apply to chorus modules.

## Speaker (fitted cabinets, no impulse responses)

FL convolves with the IR files of its cabinet list (59 entries, 4 group
headers). Measured: headers are an exact passthrough (separations ignored);
no cabinet has crosstalk (all dual mono; "stereo" cabinets differ in L / R
level, delay and polarity); zero reported latency (Model M..T carry ~23 ms of
quiet lead-in); linear; the module's oversampling does not apply; FL plays
the 44.1 kHz IRs unresampled, so at other rates the response moves with the
rate and the level changes by -20 log10(sr/44100) dB (we emulate that).

We store no IR data: each path is a fitted cascade (high-pass, 2-3 low-pass,
up to 16 peaking biquads; magnitude-matched design) plus gain, polarity and a
pure delay, fitted with Levenberg-Marquardt to FL's 1/6-octave smoothed
response: 0.03..0.68 dB rms (40 Hz..16 kHz), 0.14..0.95 dB rms when both are
smoothed. The phase is minimum-phase, so dispersed IRs (Blues, Guitaro,
Metal, Wide, some Hardcore models) keep their spectrum, delay and polarity
but not their time structure; with output separation or partial mix those
paths interfere differently than in FL (1.7..4.9 dB rms).

Stereo separation (input before the cabinet, output after; exact):
`L' = M + W S, R' = M - W S`, M = (L + R)/2, S = (L - R)/2;
v < 0: W = 1 - v/1000 (up to 2), v >= 0: W = (5 - 5^(v/1000))/4 (down to 0 =
mono); W ramps by at most 0.002 per sample within a block. Cabinet changes
crossfade over 20 ms (FL's behaviour could not be measured).

## Fidelity (our output vs FL's renders)

- Rack, gains, mix, oversampling, Center, soft clip output: exact
  (-120..-600 dB); in / mix / out changes bit-exact (blood, filter, folder,
  aperture modules) or -140..-145 dB (Harmor), with oversampling and Center
  -130..-143 dB. Before this pass (1 ms glides, gains outside the
  oversampler): -11..-27 dB around each change.
- Distortion: Blood bit-exact at 1x / 2x (-121..-127 dB at 4x / 8x, the
  double-precision oversampler), Fast dist bit-exact (1x and 2x), Soft
  clipper -134 dB, Harmor -103..-145 dB, Wave folder / Aperture / Abrasive /
  Crusher sample-exact; crossover / asymmetry kicks bit-exact.
- Filters: sample-identical (22 models, any rate, automation), including the
  start from c = r = 0.5 after loading.
- Chorus: -101..-131 dB from state load for one or two chorus modules.
  Open: a chorus module in slot 3 (and racks with three or more chorus
  modules) diverges from FL after loading: about -14 dB for the first 0.1 s,
  then -52..-79 dB (single modules in slots 1, 2 and 4 match); cause not
  identified (pre-existing, not a parameter-change effect).
- Speaker: magnitude within 0.2..1.6 dB rms (1/6 octave), not phase-exact.
- Factory presets from a state load (block 128): 17 of 47 bit-exact or
  -100..-150 dB; with speaker modules limited by the fitted cabinets
  (-1..-21 dB sample residual); Heavy Chorus / Multichorus by the chorus
  slot issue above; Fuzzing -45 dB.

## Deviations

- Speaker cabinets are fitted filters (no Image-Line impulse data).
- A module created by our engine starts at FL's module start-up state (Blood
  smoothers 1, 1, 1, 0, filter c = r = 0.5, Harmor / folder / aperture offsets
  0): exactly FL's behaviour from a state load. FL processes idle plugins
  continuously, so in FL these start-up glides are normally over before audio
  arrives; our engine does not process idle tracks, so they play out on the
  first audio after loading (and at the start of an export).
- Moving modules (UI) swaps parameters between slot processors (FL moves the
  processor with its state); model / type changes restart the processor.

## Editor

FL's layout measured on the screenshot (form coordinates): five meters at
x = 5 + 224 i (20 px), slots at x = 29 + 224 s (196 x 346): header (type
title with menu, power LED), the model's controls (3 x 2 grid for
distortion / chorus, CUTOFF + resonance for filters, two big STEREO SEP
knobs for speakers), CENTER / SMOOTH LED and OVERSAMPLING stepper (1x..16x),
model selector (grouped menus: Harmor and Distructor submenus, cabinet
groups), IN / MIX / OUT, and the footer (move left, options = remove /
reset, move right; + on the first empty slot adds a module). Knobs: track
ring, value arc from the minimum in the module colour (sweep +-152 deg),
grey cap, accent pointer. FL's UI font is narrower than Arial; texts are
squeezed to FL's measured widths.
