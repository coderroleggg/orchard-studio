# Limiter (FL: Fruity Limiter)

Files: `src/model/fx/plugins/limiter.ts`, `src/engine/effects/plugins/limiter.ts`,
`src/ui/plugins/fx/limiter/` (index, display, widgets), `tests/fx/limiter.test.ts`.

All facts below were measured on FL Studio 2026's own `Fruity Limiter_x64.dylib`
through the scratchpad test host (`flfxhost info/sweep/render`, plus a private
host build that feeds a sidechain buffer). The DSP reproduces FL's output to
float32 precision (max error 1e-7 .. 4e-6) on DC steps, noise, sines, sidechain
input, 44.1 and 48 kHz, every parameter at representative and extreme values.

## Parameters (FL index = Tag, raw units = form ranges)

| # | key | FL name | range / default | value law (x = v/1000 or v/10000) | text |
|---|---|---|---|---|---|
| 0 | gain | Gain | 0..2000 / 1000 | g = (7^x - 1)/6 (max 8 = +18.06 dB) | `-11.2dB`, `-InfdB` |
| 1 | sat | Soft saturation threshold | 0..1000 / 1000 | (3^x - 1)/2 | dB |
| 2 | ceil | Limiter ceiling | 0..2000 / 1000 | (3^x - 1)/2 (max 4 = +12.04 dB) | dB |
| 3 | att | Limiter attack time | 0..10000 / 1115 | 1000 ms·(501^x - 1)/500 | `2.00ms` |
| 4,6 | attCurve, relCurve | Limiter attack/release curve | 1..8 / 3 | number of cascaded one-poles | `3` |
| 5 | rel | Limiter release time | 0..10000 / 5000 | 2000 ms·(501^x - 1)/500 | `85.53ms` |
| 7 | sustain | Limiter peak window | 0..10000 / 2882 | 1000 ms law | `10.00ms` |
| 8 | cThres | Comp threshold | 0..1000 / 1000 | b = 7 law, clamped to -60 dB; 1000 = compressor off | dB |
| 9 | cRatio | Comp ratio | -1000..1000 / 0 | k = (51^|x| - 1)/50; v>0: R = 1 + 19k (`20.0:1`); v<0: expansion 1:(1 + 3k) (`1:4.0`) | |
| 10 | cKnee | Comp knee | -1000..1000 / 0 | see below | `-99%` (round half away from 0) |
| 11 | cAtt | Comp attack time | 0..10000 / 0 | 1000 ms law | |
| 12 | cRel | Comp release time | 0..10000 / 6666 | 2000 ms law | `248.22ms` |
| 13 | cCurve | Comp curve | 1..8 / 1 | cascade order (FL shows no text) | |
| 14 | cSustain | Comp RMS window | 0..10000 / 650 | 1000 ms law | `1.00ms` |
| 15 | nGain | Noise gain | 0..1000 / 1000 | b = 7 law | dB |
| 16 | nThres | Noise threshold | 0..1000 / **0** | b = 7 law | `-InfdB` |
| 17 | nRel | Noise release time | 0..10000 / 4187 | 2000 ms law | `50.01ms` |

dB texts have no `+` and no `-0.0`. The noise threshold starts at 0 (constructor
and Default preset) but its knob resets to 100 (form DefaultValue): the editor
overrides the reset value. All 13 factory presets are in the def (values read with
`info --preset`; their spare state equals the defaults, `tab` is the saved tab).

State blob (v7): version, 18 params, 18 spare params, speed, tab, 4 display
flags, int, sidechain input (-1/0 none), 1 byte "no safety". Our state: `tab`,
`sidechain`, `safety` (default on: the byte is 0), `showIn/Out/Env/Levels`,
`speed` (50), `spare`.

## DSP (per sample)

1. **Compressor detector**: boxcar mean of (L²+R²)/2 over W = round(RMS window·sr)
   samples (W ≥ 1) of the input, or of sidechain input k (`ctx.sidechain[k-1]`;
   a selected but unrouted input is silent). sqrt -> N = Comp curve cascaded
   one-poles, each `s = v + (s - v)·(v > s ? a_att : a_rel)`, a = exp(-ln(100)·√N / T).
   The sidechain only drives the compressor (FL fetches it only while the
   compressor is on); the limiter and gate always use the main input.
2. **Static curve** (level -> gain, dB): o = level - T. Knee reshapes u = o + 1:
   knee > 0: u' = ln(1 + u·F)/ln(1 + F); knee < 0: u' = ((1 + F/5)^u - 1)/(F/5),
   F = (201^|knee| - 1)/200. gain = (u' - 1)/R - o. Positive knee turns the
   ratio progressively harder (100%: o' = log2(1 + o/2)); negative knee expands
   at high levels. Threshold 1000 bypasses the compressor.
3. **Limiter envelope**: max(|L|,|R|) of the input, running max over
   H = max(peak window, look-ahead, 1) samples, then N = release curve cascaded
   one-poles (instant attack per stage), a = exp(-ln(100)·√N / release).
4. **Gain**: lim = ceiling·0.975/env (safety option off: ·1). Gate open
   (env ≥ noise threshold): g = min(gain·compGain, lim); closed: g decays
   toward the noise gain (absolute, makeup gain not applied) with
   a = exp(-ln(100)/release); the smoother input is min(g, lim).
5. **Attack smoother**: N = attack curve symmetric one-poles on the linear
   gain, a = exp(-ln(10^2.5)·√N / L), initial state 1. L = round(attack·sr) is
   the look-ahead delay of the audio and the reported latency (88 @ 44.1 kHz).
6. **Output stage** per channel: SAT at 0 dB = hard clip at ±ceiling (no
   safety factor, also above 0 dB); otherwise |x| > th -> th + d(1 - e^(-(|x|-th)/d)),
   d = max(0, min(1, ceiling) - th) (d = 0 clamps at th).

Additions for production use (not in FL): gain/threshold/ceiling/ratio changes
ramp over 256 samples (FL applies automation at once); look-ahead changes
crossfade the delay read position; NaN/inf input is treated as 0; denormal flush;
`tail` = look-ahead + hold + 1.2 x slowest release so the state settles before the
mixer idles the track.

## Editor

Form geometry (626 x 300) with FL's colours sampled from the manual
screenshots: scrolling display (linear amplitude, 0 dB at mid-height; input
peaks purple, output green, overlap grey; gain envelope white and analysis
envelope cyan for the selected tab; additive GAIN/CEIL/THRESH markers that read
white when coincident; click pauses; while THRES/KNEE/RATIO is held the
transfer curve is drawn), display toggles, speed slider (5 ms/column at 50,
x2 per 20 steps), LIMIT/COMP selector, CURVE spinners, SIDECHAIN selector
(drag/wheel; right-click lists the routed tracks; shows the source track
number), A/B store/flip, Options menu (`0.2 dB limiter safety`). Knobs: FL's
3.3 px value ring, two-tone face with a lit/shaded facet on the pointer side.

## Open questions / approximations

- Gain at -inf (0) together with a 0 dB gate threshold: FL limits harder than
  the model (division by the zero gain inside FL); not reproduced.
- Display: FL's vertical scale and scroll rate are inferred from screenshots,
  not measured. The "Plugin information"/About item is not implemented.
- The engine re-reads `latency` only on mixer topology/parameter edits (PDC);
  automating the attack time does not re-align other tracks (FL does).
