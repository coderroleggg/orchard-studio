# Newtime (`newtime`)

FL's Newtime: a time-warping **editor** for a loaded sample that lives in a
mixer slot (category Misc). Like Newtone, the live input passes through and
the plugin's own output is the preview of the warped sample. Sources: form
`Newtime.txt` (727 x 582: 88 px toolbar + the warp view built at run time),
the manual page, the screenshots (`Newtime.png` with the four marker types,
`Newtime_sampleproperties.png`) and the FL binary through `flfxhost`.

## Parameters (flfxhost)

| # | key | name | range / default | text |
|---|---|---|---|---|
| 0 | play | Play / pause | 0..1 / 0 | (empty) |

As in Newtone the binary reports `Space lay / pause` (hint
`|^b^a^^Space ^Play / pause`); we show `Play / pause`. GROOVE
(`MarkerDensityWheel`, hint "Groove pattern") and SHIFT
(`ShiftMarkerAmountWheel`, "Shift marker amount") are -16384..16384,
default 0, editor state (not plugin parameters).

## State (saved with the slot)

Source sample, warp markers `{id, src, dst, type, g}` (source sample ->
output sample at the sample tempo; type 0 warp, 1 downbeat, 2 groove,
3 shift; `g` = a groove marker's template position), sample tempo + Sync,
GROOVE / SHIFT, groove pattern name, marker detection mode (Transient /
Tempo / None), snap (Beat .. 1/8 beat, Off; default 1/4), the render
reference, transport (loop, play region, seek, slave) and the File menu
options.

## Analysis (approximation; FL uses zplane's engine)

- Onsets: spectral flux of the log-compressed 1024-point STFT (hop 256),
  adaptive threshold (local mean + 1.5 x mean deviation + floor), 45 ms
  minimum spacing, each onset moved to the start of the 0.5 ms energy rise
  and accepted only when the energy rises (no false onset at an abrupt end).
  Tests: clicks found to < 1 ms, none on a steady tone or silence.
- Tempo: autocorrelation of the onset strength, 60..200 BPM, log-normal
  preference around 120 BPM plus the half / double lags; a loop whose length
  is within 3 % of 2..64 beats snaps to that whole number (a two-bar loop at
  100 BPM gives exactly 100). Beats: the comb phase with the most onset
  strength (frame bias compensated).
- Marker detection: Transient = a warp marker per onset; Tempo = one per
  beat (moved to an onset within 30 ms); None = no markers.

## Warp model (from the manual)

- The sample start and end are fixed; markers keep source order; moving a
  marker stretches the audio on both sides (clamped between neighbours).
- Downbeat (right-click): unique; sets bar 1 of the grid; Edit > Snap
  downbeat puts it on the nearest bar.
- Groove: Load applies a pattern (built-in swing / push / laid-back
  patterns, or a `.groovepat` file); warp markers within 1/4 beat of a
  pattern position become groove markers (yellow); the GROOVE wheel moves
  them from their position (0 %) to the pattern position (+100 %), the
  other way below 0 ("markers may move in opposite directions"). Save writes
  the markers of the first bar as a pattern (JSON `.groovepat`; FL's binary
  format is unknown).
- Shift (Alt+click): the SHIFT wheel moves all shift markers together by up
  to half a beat.
- Quantize time: markers to the snap grid (from the downbeat). Apply
  selected pattern to all: the marker offsets of the selected bar applied to
  markers within 1/4 beat in every bar.
- Sync: output scaled by sample tempo / project tempo.

## Render

Segment-wise WSOLA: every segment between anchors starts exactly on its
marker (1.5 ms crossfade placed before it, frames never read past the
segment, so attacks are neither smeared nor pre-echoed); inside a segment
40 ms Hann frames at 50 % overlap, source positions searched within
+-12 ms (coarse-to-fine normalised cross-correlation on the mono mix),
stereo shares positions. Unwarped segments are copied exactly. Tests:
0.6..2x stretch keeps the pitch within 2 cents and the level within
1.5 dB; a marker moved 50 ms moves its click to within 1 ms of the target;
tempo-sync 100 -> 120 BPM gives 5/6 of the length at the same pitch.
Rendering runs in the shared worker; the render manager stores it as pool
sample `nmr-<slot id>` and sends it as `newtime:<id>` (see newtone.md).

## DSP

Same preview player as Newtone (input + render, Play / Stop / Loop, play
region from the selection, slave to the song position, master meter).

## Editor

Toolbar at the form coordinates: transport, slave (right-click options),
auto-scroll, plugin name (plain text), TITLE, LENGTH / SEL, TEMPO
(right-click: Sample properties: Tempo, Tempo-sync, Default, Accept, plus
the length in beats), SYNC, File / Edit / Select / Snap menus with FL's
items, Undo (right-click redo), Send to piano roll (one note per slice),
Save as (WAV), Drag (drop onto the channel rack), Send to playlist (adds the
render to the channel rack), GROOVE with Load / Save, SHIFT, master meter.

Warp view (colours from the screenshot: background #4c5f6b, waveform
#e9fbff, soft 3 px sixteenth lines #405460, beat lines #344c54, flags warp
#fcd484, downbeat #d9fc84 square, groove #fcfc0c, shift #0cd4fc): ruler
with bars and the orange position marker, warped waveform, end line,
selection, FL's scroll-zoom bar (drag to scroll, drag its ends to zoom).
Mouse: see wave.tsx. Keys: Space, Ctrl+Space, L, A, H, Del, Ctrl+A, Up,
Ctrl+Enter, Ctrl+O, Ctrl+S, F2.

## Omitted / approximations

- zplane's transient / tempo analysis and stretching (ours: spectral flux,
  autocorrelation, WSOLA). Tempo metadata in files is not read.
- Scrubbing, Save analysis files, MIDI clipboard, WavPack / compressed
  formats, host (playlist) selection sync; "Send to playlist" adds a
  channel instead (the clone has no audio clips).
- FL's groove pattern file format and its factory patterns.
- GROOVE / SHIFT ring colours are not visible in FL's screenshot (we use
  the groove / shift marker colours).
