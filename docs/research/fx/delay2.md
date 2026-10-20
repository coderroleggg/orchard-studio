# Delay 2 (FL: Fruity Delay 2)

Sources: FL's form (400 x 100), manual, factory presets, and FL Studio 2026's own
`Fruity Delay 2_x64.dylib` measured with `flfxhost` (sweeps, renders, `--at` changes,
44.1 / 48 kHz). Files: `src/model/fx/plugins/delay2.ts`,
`src/engine/effects/plugins/delay2.ts`, `src/ui/plugins/fx/delay2/`, `tests/fx/delay2.test.ts`.

## Parameters

| # | key | FL name | raw | default | text (exact vs FL sweeps) |
|---|---|---|---|---|---|
| 0 | pan | Input panning | -128..128 | 0 | `round(v/128*100)%`, half away from zero |
| 1 | vol | Input volume | 0..160 | 128 | `round(v/160*100)%` (128 shows "80%" but is unity gain) |
| 2 | dry | Dry level | 0..160 | 128 | as volume |
| 3 | feedback | Feedback level | 0..127 | 64 | `round(v/127*100)%` |
| 4 | time | Time | 1..768 | 144 | `steps:ticks`, 2-digit ticks (`3:00`) |
| 5 | offset | Time stereo offset | -512..512 | 0 | `15.3ms left` / `0.0ms right` |
| 6 | mode | Feedback mode | 0..2 | 0 | Normal / Invert / P.Pong |
| 7 | cutoff | Cutoff freq | 0..128 | 128 | `round(v/128*100)%` |

All texts match FL's full sweeps (0 mismatches). Defaults = `Default.fst` = constructor.
The 6 factory presets are in the def.

## Mappings (measured, exact)

- Time: raw/192 beats at the host tempo; delay = round-half-even(T * sr) samples
  (16537.5 -> 16538, 5512.5 -> 5512, 574.2 -> 574).
- Feedback gain = raw/128 per repeat (127 -> 0.992).
- Input volume and dry: `gain = (11^(v/128) - 1) / 10` (64 -> 0.23166, 160 -> 1.90328).
- Cutoff: one-pole low-pass `y += a (x - y)`, `a = (21^(v/128) - 1)/20 * 44100/sr`
  (so 128 is fully open only at 44.1 kHz; 0 silences the delay).
- Offset: `ms = (1001^(|v|/512) - 1) / 2` (up to 500 ms), round-half-even samples,
  a pre-delay of the left input (negative) or right input (positive).
- Input pan: FL's pour law, `p < 0`: `L' = L (1 + p/2) - R p/2`, `R' = R (1 + p)` (mirrored).

## Structure

```
in -> pan matrix -> x volume -> offset pre-delay (one input side)
   -> + feedback -> one-pole LP -> line (one per input side, D samples) -> wet
Normal: L line -> L out, feedback to itself. Invert: L line -> R out.
Ping pong: lines feed each other, outputs swapped (first echo opposite).
out = dry x in + wet   (no wet level)
```

Behaviours verified with `--at`:
- Any change of the delay length (time or tempo) or of the offset re-creates the lines:
  the next echoes start from silence (reproduced in O(1) by marking older samples silent).
- Feedback, cutoff and mode changes keep the lines; a mode change re-routes what is
  already in them (echoes jump sides), because the lines belong to the input sides.
- Smoothing is per processing block: volume and feedback head for the target linearly
  across the block with at most 0.001 x 44100/sr per sample; the pan matrix reaches its
  target within one block; the cutoff coefficient switches at once.

## Fidelity

Static settings match FL to -137..-153 dB or bit-exactly (defaults, cutoff, pan +
ping pong, invert + offset, offset, volume, 97 BPM, 48 kHz); time / offset changes
-149 dB; feedback / cutoff / mode changes -126 dB; volume + pan ramps -127 dB (each
sample uses the ramp value before it is stepped, like FL).

Dry level changes switch at once, as in FL (measured: -134..-146 dB after dry changes,
-140.8 dB overall; the former per-block ramp gave -15 dB). The bottom name strip shows
"DELAY 2" in plain text instead of FL's logo.
