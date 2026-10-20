# Newtone (`newtone`)

FL's Newtone: a pitch-correction and time-editing **editor** for a loaded
sample that lives in a mixer slot (category Misc). It does not process the
live signal: the input passes through, and the plugin's own output is the
preview playback of the edited sample. Sources: form `Newtone.txt`
(727 x 582: an 88 px toolbar and a piano roll created at run time), the
manual page, the manual screenshots (`Newtone.png`, `Newtone_vibrato.png`)
and the FL binary through `flfxhost`.

## Parameters (flfxhost)

| # | key | name | range / default | text |
|---|---|---|---|---|
| 0 | play | Play / pause | 0..1 / 0 | (empty) |

The binary reports the name as `Space lay / pause`: FL strips the hint
`|^b^a^^Space ^Play / pause` with its shortcut codes and swallows the "P".
We show `Play / pause`. The three wheels have `^a` hints but are not plugin
parameters; they are editor state, as is everything else.

## State (saved with the slot)

Source sample (`SampleInfo`, in the project sample pool), analysis
(sample rate, hop, frame count, pitch track as base64 Int16 of
(cents - 6000) x 8, level track as base64 Int16 dB x 10), notes and their
edits, the wheels (form: CENTER 0..8192 default 0, VARIATION 0..16384
default 8192 = 100 %, TRANS 0..16384, form Value 16384 / DefaultValue 0:
starts at 16384, Reset gives 0), render reference (`out`: pool id + edit
fingerprint), transport (loop, play region, seek counter, slave), editor
modes (cut, advanced pitch / vibrato, snap to scale + scale, snap to grid),
sample tempo + tempo-sync, the slave / load options of the File menu.

## Analysis (approximation; FL uses zplane's engine)

- Pitch: YIN on an anti-alias decimated copy (~11 kHz), 5 ms hop, 30 ms
  window, 55..1500 Hz, threshold 0.15; the period is refined on the
  full-rate signal (parabolic interpolation of the raw difference
  function): sub-cent accuracy on steady tones (tests: < 1 cent, 65 Hz ..
  1 kHz, 44.1 / 48 / 96 kHz). Voicing from periodicity (>= 0.72) and a level
  gate (-45 dB below the loudest frame); octave jumps folded toward the
  neighbourhood median; 3-frame median.
- Notes: voiced runs (15 ms gaps bridged); inside a run a vibrato-free
  contour (median 40 ms + average 180 ms) is followed with hysteresis
  (70 cents for 40 ms), the boundary where the sharp contour crosses half
  way between the levels; level dips of 9 dB split re-articulations; notes
  under 50 ms merge into the closer neighbour. Per note: average pitch
  (median of the middle 60 %), pitch ramps (glide in / out, <= 150 ms) and
  the natural vibrato rate (zero crossings of the detrended contour).

## Edit model (from the manual)

- Output centre of a note: an explicit target (dragged / snapped / set from
  the keyboard) or the average pulled toward the nearest semitone (scale
  note with Snap to scale) by CENTER.
- Output pitch inside a note: centre + VARIATION x note variation x
  (detected - average) + designer vibrato; the change fades in / out over
  the pitch ramps, scaled by TRANS (0 = instant: robotic).
- Volume (dB) + tremolo and formant (cents) fade over the volume ramps.
- Deleted notes are silenced (5 ms fades).
- Time: every note pins its output range; notes adjacent in the source stay
  attached (moving one stretches its neighbour), gaps shrink or grow;
  tempo-sync scales everything by sample tempo / project tempo.

## Render

TD-PSOLA: pitch marks phase-locked one period apart (cross-correlation with
sub-sample refinement; unvoiced 4.5 ms steps), output marks spaced by the
target period, two-period Hann grains resampled by the formant factor and
read through the time map, overlap-add normalised by the summed windows,
a small make-up gain for large shifts. Unshifted voiced parts keep their
output marks on the analysis marks (phase-aligned), and regions without any
change are passed through bit-exact (10 ms crossfades). Tests: shifts of
-12..+7 semitones land within 3 cents, level within 2 dB; formant shift
moves the formant peak and keeps the pitch; Center 100 % puts a +30 cent
note on A4; Variation 0 % flattens a 120-cent vibrato to < 25 cents.

Runs in a module Web Worker (`ui/plugins/fx/newtools/worker.ts`; inline
fallback). The render manager watches all slots (editor open or not):
when a slot's edit fingerprint differs from its render's, it re-renders
(debounced), stores the result as pool sample `ntr-<slot id>` (registered
in the project, WAV in IndexedDB), sends it to the engine as
`newtone:<id>` and then points the state at it. Undo / redo just changes
the fingerprint.

## DSP

Input passes through; the render plays on top while Play is on (4 ms
fades, Catmull-Rom resampling to the engine rate), from `pstart` (play
marker or selection start) to `pend` (selection end), looping with Loop.
Slave: plays while the song plays, at the song position (bar 1 = start).
`tail` is Infinity while the preview may sound. Monitor: position, length,
rate, playing / ended, output peaks (master meter).

## Editor

Toolbar at the form coordinates: Loop / Play / Stop, Slave (right-click:
ignore host selection / own selection / space bar), Auto-scroll, plugin
name (plain text, no Image-Line logo), TITLE, LENGTH / SEL (samples or
"a to b"), TEMPO (right-click: Sample properties dialog: Tempo, Tempo-sync,
Default, Accept), SYNC, File / Edit / Select menus with FL's items, Undo
(right-click redo), Send to piano roll (current pattern, selected
channel), Save as (WAV of the render or selection), Drag (drop onto the
channel rack), Send to playlist (adds the render to the channel rack: the
clone has no audio clips), CENTER / VARIATION / TRANS, Cut mode, Advanced
edit (right-click: pitch / vibrato), master meter.

Piano roll (colours sampled from the screenshot: rows #4c5f6b / #3a4c57,
step lines #344c54, bar lines #1b3246, keys #ecf0f9): keyboard with FL note
names (C5 = MIDI 60), ruler with bars and the orange position marker, notes
as in FL (volume blob, nearest-semitone block grey / light orange when
selected, average-pitch rectangle, orange pitch line with dark outline),
end-of-sample line, selection. Mouse: as the manual (see roll.tsx header).
Advanced edit box (pitch): volume, pitch variation, position, pitch,
formant handles, volume / pitch ramp lines, green ramp-in / red ramp-out
regions. Vibrato designer: tremolo, start / end level (signed = phase),
set frequency (blue, 1..12 Hz across the box) and detected frequency
(green). Keys: Space, Ctrl+Space, L, A, H, C, Ctrl+E, Del, Ctrl+A, Up,
Ctrl+Enter, Ctrl+O, Ctrl+S, F2, Esc.

## Omitted / approximations

- zplane's analysis and resynthesis (ours: YIN + TD-PSOLA).
- Scrubbing a note while stopped, copy / paste of slices, MIDI clipboard,
  WavPack / compressed formats, Export regions, host (playlist) selection
  sync: not available. "Send to playlist" adds a channel instead.
- The CENTER wheel's ring colour is not visible in FL's screenshot (green
  guessed).

## Shared infrastructure (local workaround)

`newtools/samples.ts` and `newtools/manager.ts` deliver renders with
`host.send({t:'sample'})` from a project listener, like Scratcher (also for
copies hosted in Patcher, via `allFx`), and give the offline WAV export the
same renders through `registerEngineSamples` (src/audio/engineSamples.ts).
The export therefore includes Newtone's preview (which only plays when Play is on
anyway).
