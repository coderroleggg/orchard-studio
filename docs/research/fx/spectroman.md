# Spectroman (FL: Fruity Spectroman)

Spectrum analyser: spectrograph (bars + band peaks) or sonograph (scrolling
intensity). Category Visual. Editor 285 x 159 (FL's minimum window size; FL's
window is resizable, ours scales). Audio passes through unchanged.

## Parameters (flfxhost)
| idx | name | range | default | text |
|---|---|---|---|---|
| 0 | Output mode | 0..1 | 1 | spectrograph / sonograph |
| 1 | Amplification | 0..128 | 64 | `round(v*100/128)%` |
| 2 | Frequency scale (Center frequency) | 0..128 | 64 | centre frequency, `3058Hz` @44.1k |

State (Tag -1 check boxes, saved after the params): WINDOWING (default on),
SHOW PEAKS (on), STEREO (off). Saved order: version 100, mode, amp, scale,
windowing, peaks, stereo (the factory Default preset decodes to these values).
All 129 texts of params 1 and 2 match FL at 44.1 and 48 kHz (tests).

## Analysis (exact, from the binary)
- 2048-point real FFT (IPP pack format), new frame every 1536 samples (the last
  512 are kept). Only while the editor is shown (FL checks a visibility flag; we
  stop after 1 s without monitor polls).
- Window: 4-term Blackman-Harris, `a = 2pi/2047`.
- Mono input = L + R; level factor `s = 15/1024`, doubled per channel in stereo.
- Frequency map: `k = round(exp(scale/128 * ln 2000) - 1) + 1`;
  column i (0..128) starts at bin `round((exp((i/128 + 0.03)/1.03 * ln(k+1)) - 1) * 1024 / k)`.
  A column takes the max |X|^2 of its bins (at least its first bin).
- Level `v = round(4096/ln 11 * ln(1 + sqrt(m) * s))` (4096 = |X|*s of 10).
- Bars: `max(bar - 341, v)` per frame; the spectrograph merges stereo into one
  bar set with 170 per channel pass; the sonograph has one per channel.
- Band peaks (32 bands of 4 columns, per channel): set to v with counter -75;
  each frame `counter++`, once positive `peak -= 16 * counter`.
- Value text of the scale wheel: `(bin(64) + bin(65)) >> 1` * sr / 2048.
  Hover hint: the same for the column under the mouse, `1234Hz`.

## Display (exact unless noted)
- Panel paint: header gradients `#737c81 -> #778085` (0..9) and
  `#778085 -> #879095` (9..36), lines `#97a0a5` / `#576065` at y 36/37, body
  `#4e575c -> #5e676c` and a 9 px bottom strip back to `#4e575c`; bezel rounded rect
  (7,4)-(W-101,H-4) r 6, 4 px frame `#2f3438 -> #3f4448`, interior `#151e23`, inner
  outline `#283035`; two radial glows `#52634b` of radius min(scopeW, scopeH) at
  (scope centre x, 10) and (x, H-14). Glow falloff (1-r)^2 is fitted to the manual
  screenshot.
- Scope 128 x 100 at (32,28). Spectrograph: column x at height `v * (H*amp>>6) >> 12`,
  drawn only when its top stays below the scope top (FL skips taller columns);
  FL draws `#546f1b` at alpha 180 in a blend mode we fitted as rgba(103,128,40,0.69).
  Peaks: polylines through band centres (4b+2) at `(H+1) - peak*gain/4096`, right
  channel `#0000f0` first, then left `#f00000`.
- Sonograph: ring of H rows (one per frame), oldest at the top; each pixel adds
  `min(255, v*amp*4 >> 12)` to the background with saturation: to R, G and B in
  mono, to R (left) and B (right) in stereo.

## Approximations
- Mode selector, LED check boxes and knobs are FL shared widgets; drawn after the
  (older) manual screenshot.
- Title / label fonts: Arial 12 bold and Arial 16 italic (condensed by scaling).

## Open questions
- The exact blend mode FL uses for the spectrograph fill.
