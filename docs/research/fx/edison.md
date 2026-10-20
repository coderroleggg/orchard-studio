# Edison

FL Studio's audio recorder and wave editor, loaded into a mixer slot. FL plugin
database category **Misc**. Orchard id `edison`.

Files:

| Part | File |
|---|---|
| Definition, state, constants | `src/model/fx/plugins/edison.ts` |
| DSP (recording, playback, scrub, host sync) | `src/engine/effects/plugins/edison.ts` |
| Editor | `src/ui/plugins/fx/edison/index.tsx` (+ `view.tsx`, `icons.tsx`, `dialogs.tsx`, `menus.ts`, `edison.css`) |
| Edit operations (pure, Float32Array channels) | `src/ui/plugins/fx/edison/ops.ts` |
| Tools (stretch, EQ, reverb, blur, denoise, slicing, scripts) | `src/ui/plugins/fx/edison/tools.ts` |
| Pool / engine / undo / recorder bookkeeping | `src/ui/plugins/fx/edison/audio.ts` |
| Commands (every action) | `src/ui/plugins/fx/edison/commands.ts` |
| WAV writer / reader (cue regions, smpl loop and root note) | `src/ui/plugins/fx/edison/wav.ts` |
| Tests | `tests/fx/edison.test.ts` |

## Sources

- Manual: Edison.txt and Edison_2 to Edison_14 (transport, recording options, menus, edit buttons, special controls,
  peak meter, edit window, envelopes, feature switches, zoom bar, time display, sample properties).
- Form `forms/Edison.txt`: `TSynthEditorForm` (SynthPanel 744 x 487), `TEdisonSettingsForm` (185 x 248),
  `TScriptDialog` (480 x 335). The tool dialogs (Amp, Equalize, Time stretch...) live in FL's executable and are
  not in the form file.
- `flfxhost info "Edison" --keep-codes`: three parameters,
  `0 ^b^a^^Space ^Play / pause`, `1 ^b^a^^R ^Record`, `2 Live selection`, all 0..1, value text empty
  (`GetName(FPN_ParamValue)` returns "").
- `flfxhost --save-state` (state version 13, constructor and each factory preset) and the factory presets
  (`Plugin presets/Effects/Edison/*.fst`, older state versions 4 and 6). The state ends with five 32-bit fields:
  record mode, append, duration, key link, slave playback. Constructor: `1, 0, 3, 3, 0`. The state embeds an empty
  44.1 kHz 32-bit float WAV with `smpl` (root note 60), `inst` and `acid` chunks, a time of 0.00408 s
  (180 samples at 44.1 kHz: used here as the click-free crossfade) and the float 0.02 (gate threshold).
- FL's stock Edison scripts (`System/Config/Audio scripts`) and their API reference (`Reference.txt`): the
  semantics of PasteFromTo (insert / replace / mix), NormalizeFromTo, AmpFromTo, SilenceFromTo, CenterFromTo,
  ReverseFromTo, ReversePolarityFromTo, SwapChannelsFromTo, InsertSilence, NoiseFromTo, DeleteFromTo, TrimFromTo,
  ConvertToMono, regions (a SampleEnd past the end makes a marker).
- Screenshots: `edison.png` (annotated main view), special controls, loop recording (selection colours,
  "Song jump" markers), freeze mode, properties bar, sample properties dialog, envelope selector, feature switches.

## Parameters and state

| key | FL name | index | range | default |
|---|---|---|---|---|
| `play` | Play / pause | 0 | 0..1 | 0 |
| `rec` | Record | 1 | 0..1 | 0 |
| `livesel` | Live selection | 2 | 0..1 | 0 |

The parameters act on edges (0 -> 1 / 1 -> 0) so automation works: Play starts at the playhead within the
selection (or the whole sample) and pauses; Record arms / disarms. "Live selection" (no documentation found):
interpreted as "a selection changed during playback becomes the play range immediately"; off, the range is fixed
when playback starts.

Plugin state (`EdState` in the model): `sample` (pool id), `hist` / `hpos` (undo), `markers`, `loopPts`, `sel`,
recording options (`recMode`, `recMax`, `append`, `mute`, `threshold`), transport (`loop`, `sync`,
`syncNoHostSel`, `syncNoOwnSel`, `keyLink`, `cmd`, `scrub`), sample properties (`title`, `comments`, `bits`,
`tempo`, `tsync`, `root`, `fine`), envelopes (`envSel`, `envs`) and the view / feature switches.

Defaults (FL's constructor state): record mode **On input**, duration **5 minutes**, Append off, Slave playback
off, key link Auto, threshold 0.02 (-34 dB). The duration combo's value skips FL's separators (FL's "3 min audio
logger" presets store 2 = "3 minutes").

Factory presets (FL's names; loading one resets the audio, as FL's presets carry an empty WAV):

| preset | mode | append | duration | slave |
|---|---|---|---|---|
| 3 min audio logger (input) | Input | off | 3 minutes | off |
| 3 min audio logger (on play) | On play | off | 3 minutes | on |
| Default | On input | off | 5 minutes | off |
| Record on audio input | Input | on | 5 minutes | off |
| Record on song playback | On play | on | 5 minutes | on |

Project load (`normalize`): Play and Record go to 0 and the undo history restarts at the saved audio.

## Architecture

**Audio never lives in the slot state.** Each version of Edison's audio is a sample in the project's pool
(`addRaw`), registered in `project.samples` (source `user`) while it is the current audio, so it is embedded in
saved projects and restored on load. The engine gets it as `edison:<id>` (`host.send({t: 'sample'})`), the DSP
reads it with `env.sample('edison:' + id)` and retries the lookup when the sample arrives after the state.
Engine copies of audio that is no slot's current audio are removed (`sampleRemove`); undo delivers them again.
The current audio is also written to IndexedDB as a 32-bit WAV (debounced) so the autosave backup restores it,
like user samples.

**Undo** is kept in the slot state as a list of pool sample ids, each step with its regions and loop points
(`hist`, `hpos`). An edit creates a new pool sample, truncates the redo branch and appends a step (global undo
records the same change, so FL-style Ctrl+Z outside Edison also works). Edison's own undo / redo moves `hpos`
(no global entry) and swaps the current sample in `project.samples`. Depth: 20 steps (FL's history menu shows 10).
As in FL, samples above 16 MB keep no undo unless Edit > "Enable undo for large samples" is on. Audio that drops
out of every history is freed from the shared pool (`removeRaw`).

**Recording.** The DSP writes the input into a ring buffer of 2^20 frames (21.8 s at 48 kHz), allocated in
`setParams` when Edison is first armed (never in `process()`). `monitor()` hands out the recorded frames in
chunks (at most 16384 frames per call, the engine polls about 30 times a second), tagged with the take number,
the offset in the take and a per-instance id. A module-level watcher in `audio.ts` subscribes to every Edison
slot in the project (also while its editor is closed), assembles each take, shows it live in the editor and,
when the take ends (Record off, or the cap), commits it as a new pool sample: replacing the audio, or appended
to it with Append on. Because the audio thread empties the ring on every poll, a busy UI thread only delays the
messages; nothing is lost while the slot is watched.

Length limits: the "For" setting wraps (the take keeps its last N minutes / MB, FL: "Edison will wrap and
overwrite the previously recorded sample"); the result is stored in chronological order. Recording is capped at
**10 minutes** (`ED_MAX_SECONDS`): "Forever" stops there, and the 30 / 60 minute and 500 MB / 1 GB settings wrap
at 10 minutes. 50 MB = 6,553,600 stereo float frames (136 s at 48 kHz).

## DSP behaviour

- Signal path: the input is recorded at the slot position (pre-fader), passed through unless **Mute input** is
  on, and the playback / scrub signal is added. `tail = Infinity` (the track never idles), latency 0.
- **Now**: records from the moment Record is armed. **On input**: waits for the input peak to reach the threshold,
  keeps a 100 ms pre-record buffer so the attack is not lost. **Input**: records only while there is input;
  pauses after 0.5 s below the threshold and resumes with the pre-record buffer. **On play**: records while the
  host transport plays; a "Song jump" marker at every start of playback and at every backward jump of the song
  position (loops), as FL's loop recording. The take stays open while armed.
- Playback: from the playhead within the play range (selection, else the loop points when Loop is on, else the
  whole sample); at the end it loops (Loop on) or stops and returns to where it started. A 64-sample ramp is used
  when starting mid-range and when pausing / stopping; from the range start the sample plays untouched, so a
  recording plays back bit-exact. Samples at another rate are read with 4-point Hermite interpolation.
- Scrub: the head follows the (smoothed, 25 ms) mouse position; the output gain follows the head speed (8 ms), so
  a still mouse is silent.
- Slave playback to host: while the host plays, the playhead follows the song time (ticks -> seconds at the
  current tempo) from the selection start (unless "Ignore own selection"), jumping when the song jumps; stops with
  the host. Disabled while recording.
- Meter: peak of input and playback per channel since the last poll.

## Editor

Layout follows FL 2026's form (SynthPanel 744 x 487): transport (SyncBtn 6,9; Loop 29,5; Play 62,5; Scrub 93,5;
Stop 118,5), Record (154,7, round), RecModeSel (188,11, arrow-shaped combo), "FOR", RecMaxTimeSelect (275,11),
APPEND (154,39), the main menu (NewMainMenu 19,53,231,39: File, Format, Edit, Tools, Regions, View, Snap, Select,
Zoom as icons), the **single row of 18 tool pads** (Top 57, 25 x 31, x = 251..674), the title (602,-2), Mute input
(702,1), the peak meter (731,2,10,116), the properties bar (labels at 7, 68, 120, 199 and the length / selection
display at the right), the edit window (WAVEditor from y = 122, 720 wide), the zoom / scroll bar, the bottom bar
(menu button, envelope selector, feature switches in the form's order: display mode, click-free, threshold,
regions, freeze, envelope draw, snap, slide) and the auto-scroll strip on the right (AutoScrollBtn, alRight).

The manual's annotated screenshot shows an older layout (two rows of nine larger tool buttons, auto scroll in
the bottom bar, a 722 x 360 window); colours, glyph meanings and the plate / properties bar / edit window look
were taken from it. Colours: plate gradient #787c82..#5c5e64, edit window gradient #3b4252 / #2c3344 / #3c4353,
waveform #d2d9e9, selection red with the waveform turning #ffdeef, markers #ffb871, threshold band green with the
waveform turning #ceede5, properties bar #191d24..#2e3239. Icons are Orchard's own SVG drawings of FL's glyphs.

Mouse (wave mode): drag selects (snapped: grid / regions / samples / zero-crossing / pitch period, default
zero-crossing); drag a selection edge to move it; click outside the selection moves its nearest edge (manual),
click elsewhere places the playhead, Ctrl+click always places it; double-click a marker tag or Ctrl+click selects
its region, double-click outside deselects; drag marker / region-end / loop tags; right-click a marker tag for
its menu (Delete, Clone as region, Turn into marker, Rename, Quick rename, Set info, Purpose, Trigger note, Select,
Zoom on); right-drag scrubs, right-click opens the Edit menu; wheel zooms at the mouse, Shift+wheel scrolls;
middle-drag zooms (up / down) and scrolls (left / right). Envelope modes: right-click adds / deletes points, drag
moves them (Slide moves the following points too). Files dropped on Edison load (Shift: append, Alt: replace the
selection, with a marker named after the file). The scrub button scrubs while held. The peak meter sets the
threshold by dragging (-72..0 dB).

Keyboard (Edison focused): Space play / pause, Ctrl+Z / Ctrl+Shift+Z undo / redo, Ctrl+X/C/V, Alt+V paste
replace, Shift+V paste mix, Del delete, Shift+Del clear, Ctrl+Del trim, Alt+Del delete after loop, Ins insert
silence, Ctrl+N normalize, Ctrl+F / Alt+F fades, Alt+Left reverse, Alt+A amp, Alt+T time stretch, Ctrl+Q EQ,
Ctrl+R reverb, Ctrl+B blur, Ctrl+U clean up, Alt+U noise profile, Alt+N noise threshold, Ctrl+E mixdown envelopes,
Alt+E cancel envelopes, Ctrl+O load, Ctrl+S save, M marker, Alt+M region, Alt+L loop, Alt+S auto-slice,
Shift+Ctrl+Del delete region, Ctrl+F2 rename all, F2 properties, Ctrl+A select zoomed part, Up / Down deselect,
Left / Right previous / next region, PgUp / PgDn / Home / End zoom, Ctrl+Left / Right zoom on selection edges,
1-5 snap mode, C click-free, S spectrum, R record, L loop, H slave, I mute input, A auto scroll, P envelope points,
Shift+C send to playlist, Shift+S settings. Escape closes an open tool dialog.

## Edit operations (ops.ts)

Half-open ranges [a, b) in frames; every function returns new arrays.

- copy, cut, delete (click-free: the removed audio fades out over the first 4.08 ms after the splice while the
  following audio fades in; the length stays len - (b - a)), trim, clear (click-free fades inside the range),
  insert silence (selection length at the selection start), paste insert / replace / mix (replace and mix grow the
  sample when the clip runs past the end; clipboard audio is resampled to the sample rate and matched to its
  channel count; with no selection the clip goes to the playhead), paste mix (envelope) (the all-purpose envelope
  sets the mix), delete part after loop.
- reverse (markers inside mirrored), reverse polarity, amplify, normalize (peak to 0 dBFS), Amp tool (left / right
  volume, balance, stereo separation), fade in (1 - (1 - t)^2, the fast rise of FL's "logarithmic" curve and
  icon), fade out ((1 - t)^2), declick in / out (4 ms linear), center (DC offset), swap channels, convert left /
  right / both to mono, convert mono signal to mono format (only when L == R), to stereo, 16-bit conversion
  (quantizes, as FL warns it is lossy).
- Markers follow the audio: inserts move later markers, deletes remove markers inside and clip regions.
- Processing edits mark the audio 32-bit (FL converts 16-bit samples before processing).

## Tools menu: implemented subset

| FL tool | Orchard |
|---|---|
| Amp > Amp, Normalize, Reverse polarity, Fade in / out, Declick in / out | yes |
| Amp > Mixdown amp envelopes, Envelope > Cancel all, Add points at selection | yes (linear envelopes) |
| Waveform > Center | yes |
| Time > Reverse | yes |
| Time > Time stretch / pitch shift | WSOLA stretch (40 ms windows, +-10 ms search, shared alignment for all channels) and pitch shift (stretch + cubic resampling), or "Resample" (tape). Formants are not preserved |
| Channels (swap, mono left / right, mono format) | yes |
| Synthesis > Generate noise | yes (white, 1 s when empty) |
| Scripting > Run script | TypeScript versions of FL's stock scripts: Amp, Bit reduction, Destructoid, Limiter, Old school, Ring modulation, Pulse / Saw / Sine / Silence generator, Convert markers, Play to end; Run last script |
| Noise > Acquire noise threshold, Gate noise, Trim side noise, Trim all noise & slice up | yes |
| Spectral > Convolution reverb | an algorithmic reverb (Freeverb combs / allpasses, RT60 decay, pre-delay, damping, wet / dry); no impulse responses |
| Spectral > Blur | spectral smearing (per-bin magnitude release over time) |
| Spectral > Equalize | 6-band biquad EQ (cuts, shelves, two bells) with a response graph; FL's tool is a drawn FFT curve |
| Spectral > Acquire noise profile, Clean up (denoise) | spectral subtraction (2048-point STFT, amount, floor, release smoothing) |
| Regions > Normalize / declick in / declick out / perfect all regions | yes |
| Sequencing > Send to selected channel | yes (new pool sample on the selected Sampler channel) |
| Sequencing > Send to playlist as audio clip | Orchard's playlist has no audio clips: the selection becomes a new Sampler channel |
| Regions menu: add marker / region, set loop, set first downbeat, delete, rename all, assign trigger notes, auto-slice (dull / medium / sharp onset detection), grid slicing (1/4 beat, beat, bar), zero-cross check | yes |

Omitted (listed disabled in the menus): Claw machine, Drum(loop) stretch, Scratch (envelope), Paste stretch,
Paste replace (drum), Paste mix (spectral), Undo using mix (envelope / spectral), Lossy normalize, Tune loop,
Vocal denoise / isolator, Deverb (AI), Convert to score, Detect beats, Detect pitch regions, Quick / auto rename,
envelope filter / smoothing / sequencer tools, spectrum display settings, live tool previews (tools apply on
Accept), compressed formats (WavPack, MP3, OGG, FLAC): Save writes WAV (16 / 24-bit PCM or 32-bit float, with
regions as cue points, the loop and root note in `smpl`, the title in `INFO`), and loading reads those markers
back. The piano keyboard preview (Link key to) is stored but not played.

## Menus

FL's nine menus with FL's item names and shortcuts; the bottom-left menu button shows them all, the plugin window
menu shows all but View and Zoom. View: spectrum (FFT view, seven FL gradient names, natural scale), dual view,
waveform channels (mono / multichannel / left / right), regions, loop, time in samples, background gradient. Time
display: BAR:BEAT:TICK (synced to the project tempo, or the sample tempo when FREE), MIN:SEC:MS without a tempo,
or samples; right-click it for the select menu. Properties (F2): title, comments, sample rate (resample or not),
format, tempo with Round / Default / quick-estimation Autodetect, length / selection in beats, tempo-sync, middle
note, fine tune. Settings: FL's EdisonSettingsForm (link key to, ignore host / own selection).

## Tests (tests/fx/edison.test.ts)

Registration (names, indices, ranges, defaults, presets, recording limits, load normalisation); recording in all
four modes (exact capture in Now mode, On input trigger with the 100 ms pre-roll, Input pausing, On play markers);
playback (bit-exact playback of a pool sample, recording -> playback round trip, looping, pause fade), mute input,
scrub, host sync, missing sample; every edit operation on small arrays, click-free delete, markers following
edits, time stretch / pitch shift, EQ, scripts, auto-slicing, WAV round trip with regions; undo history with the
real store (pool samples, project sample list, undo / redo, redo branch, region steps, global undo, the 20-step
limit freeing old audio).

## Limitations / shared changes that would help

- Freed audio leaves the pool (`removeRaw`), but IndexedDB copies of old versions are not removed (a
  `deleteUserSample` in `src/audio/samples.ts` would do that).
- Edison delivers its own engine copies (`ED_PREFIX` ids) from a module-level project watcher and gives the
  WAV export its audio through `registerEngineSamples` (src/audio/engineSamples.ts). AudioHost's generic
  `pushFxSamples` covers effect state keys that hold pool sample ids directly.
- The app's global Escape closes the focused window even when it only closed a popup menu (it runs after the
  menu's capture handler). Edison handles Escape itself only for its tool dialogs.
- Global undo deeper than Edison's 20 steps can return to audio that was freed (the editor then shows it empty).
- Song time for host sync ignores tempo automation.
