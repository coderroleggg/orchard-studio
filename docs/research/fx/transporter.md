# Transporter (FL Studio 2026)

Sources: FL's form (`Transporter.txt`, 740 x 366), the manual page, the manual
screenshot (an older, smaller layout: 1027 x 497 px, used for style only), the
6 factory presets, and measurements of the real plugin with `flfxhost`.

## Parameters

22 parameters, names and ranges from FL's GetName. FL normalises a control as
a float32 `(v - min) / (max - min)` before scaling it for display; with that,
37 944 of 37 945 sampled texts match (minLen 1505 prints "1.51" in FL, "1.50"
here).

| # | param | law / text |
|---|---|---|
| 0-2 | Dry levels, Loop level A/B | gain (11^x - 1)/10, "0.0dB", "-12.7dB", "-InfdB" |
| 3-5, 21 | Reverse / Octave shift / Octave down up / Ignore bias | x, "0.46" |
| 6, 10 | Spread and auto panning, Bouncing rate | (x - 0.5) * 2, "-1.00".."1.00" |
| 7 | Minimum length A (20..2000) | 0.02 + 1.98 x s, "0.50" |
| 8 | A/B ratio (0..36) | 1 + v/4, "3.00" |
| 9 | Transient sensitivity (0..1024) | x, "0.50" |
| 11, 12, 14-17 | Ignore transients, Flush, Bypass, Update loop A/B/A-B | Off / On |
| 13 | Loop mode | AUTO, BOUNCING, ADAPTIVE, TEMPO |
| 18 | Probabilities | Probabilistic / Deterministic |
| 19, 20 | Tempo ratio length / trigger | 1/1 .. 1/16 quint. (21 items), trigger adds "Off" (default) |

Defaults: the constructor state, identical to the Default preset. FL's preset
files store parameters 0..19 only. Options (Flush on pause/stop, Lookahead,
Mono/Stereo architecture, Transient source) are not parameters; the clone
keeps them in the slot state (defaults: on, on, Stereo-to-stereo, Left+right).

## Behaviour (measured with tone sweeps whose frequency encodes the input time)

- Latency 220 samples at 44.1 kHz (5 ms), constant (also with Lookahead off).
- Ring of 960000 samples. Stereo-to-stereo: loop A plays the **left** input,
  loop B the **right** input (left-only input leaves B silent); Mono-to-stereo
  feeds both with the mono sum.
- Per loop, a trigger at t is effective when t - tPrev >= its minimum length
  (B: A / ratio). The loop then plays [tPrev, t] from tPrev, repeating, until
  the next effective trigger (clicks every 0.3 s with a 0.5 s minimum: loop A
  takes every other click; B, minimum 0.167 s, takes all). Before the first
  effective trigger the loops are silent; the plugin start counts as tPrev.
  The input stopping abruptly also triggers.
- New segments start one lookahead after the trigger, aligned with the delayed
  dry signal. With Lookahead, jumps and wraps dip: about 2.5 ms fade-out,
  2.25 ms of silence, 2.5 ms fade-in.
- Bouncing: the first cycle lasts the minimum length (from tPrev); each cycle
  is multiplied by ~exp(-rate/2) (0.78 at +0.5, 0.58 at +1, 1.28 at -0.5),
  growth stops at the region length, the loop stops below ~20 ms.
- Tempo: cycles of the tempo ratio length; tempo triggers (Bouncing / Tempo)
  fire every chosen subdivision.
- Reverse plays backwards from the segment end; octave shift plays at speed 2
  or 1/2 while each cycle keeps its length. Decisions are made per event
  (bias 0.5: all cycles of one event go the same way); FL's random sequence
  is reproducible per instance.
- Spread > 0: linear pan, A to the left, B to the right (0.5/0.5 at centre,
  3:1 at +0.5, hard at +1). Spread < 0: sine auto-pan at 20*|spread| Hz (the
  manual says 0-10 Hz; FL measures 19.95 Hz at -1, 9.98 at -0.5, 1.01 at -0.05).

## Clone

- DSP follows the rules above; loops read with linear interpolation (speed 1/2).
- Ignore bias, reverse, shift and up/down are drawn per event: a seeded
  xorshift (Probabilistic) or a hash of the segment position (Deterministic).
- Adaptive: the effective minimum length follows the average interval between
  detected transients for short settings and opposes it for long ones
  (manual's description; not measured).
- Detection: fast/slow envelope ratio of the 200 Hz high-passed source, rises
  and sudden drops; threshold 10.5 - 9 * sensitivity dB (calibrated so the
  click tests trigger as in FL at 0.5).
- Sidechain input (FL's input number) replaces the trigger source; the output
  send makes the plugin's output go to that track exclusively.
- Editor at form coordinates: buffer display (ring waveform, write head, read
  and min-length markers; top / middle / bottom thirds pulse Update loop
  A / A-B / B), faders, sliders, spinners, knobs, mode buttons, options menu.
  The sensitivity slider flashes on detections.

## Open questions

- FL's detector and the exact sensitivity mapping.
- Adaptive mode's analysis, the exact Bouncing factor law and stop length.
- The meaning of the option bytes in FL's state (131329 / 65536).
- FL's exclusive send semantics (not measurable in the host).
