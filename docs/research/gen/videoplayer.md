# Video Player (FL: Fruity Video Player)

**Status: implemented; the audio level law and FL's handling of a stopped /
seeking transport are not measurable headlessly (see "What is exact"), the rest
follows FL's form, the manual and the test host.**

Files: `src/model/gen/plugins/videoplayer.ts` (definition, state reader, time
displays, the song-position -> video-time map), `src/engine/gen/plugins/videoplayer.ts`
(the audio), `src/ui/plugins/gen/videoplayer/` (`index.tsx` editor module and
detached window, `panel.tsx` the player, `controller.ts` the `<video>`
element, `load.ts` file loading, `media.ts` probing / decoding, `files.ts` the
file store, `dialog.tsx` the Set time dialog, `menus.ts` the Options menu,
`glyphs.tsx`, `videoplayer.css`), `tests/gen/videoplayer.test.ts` (model and engine),
`tests/gen/videoplayer-ui.test.ts` (the editor's logic that needs no browser).

## Sources

- FL 2026 (26.1.6) `Plugins/Fruity/Generators/Fruity Video Player/Fruity Video Player_x64.dylib`
  (class `TTestPlug`, a Delphi / VCL-on-Cocoa plugin that decodes with FFmpeg
  through `libILVideo_x64.dylib`: `ILVideo_openFile / setPlaybackPosition /
  getPlaybackPosition / hasReachedEnd / getSMPTETimecode / GetAudioDuration`)
  and the editor forms (`scratchpad/gen/forms/Fruity Video Player.txt`:
  `TDetachedForm` 563 x 470, `TSetTimeForm` 259 x 164, `TSynthEditorForm` 410 x 453
  with its menus).
- Test host (`scratchpad/gen/ctl/flfxhost`, see `scratchpad/gen/notes/HOST_TOOL.md`):
  `info`, `sweep`, `render --notes ... -vv`, `--save-state`.
- FL's manual page `plugins/Fruity Video Player.htm` and its screenshots
  (`VideoPlayer2.png`: the window with the control panel; `VideoPlayer2_timecontrols.png`:
  the time entry), condensed in `scratchpad/gen/notes/manual_video.md`.
- The factory preset `Data/Patches/Plugin presets/Generators/Fruity Video Player/Default.fst`.
- Plugin database folder: Generators > Visual. Info text: "A video file player."

## What the test host shows

- Flags `0x00e0c011`: Generator, GetNoteInput, MIDIOut, DemoVersion (bit 15),
  NewVoiceParams, Reserved1, CantSmartDisable. `DefPoly 0`, no latency, no
  controller outputs. Generator style **Gen_Render** (the plugin mixes its own
  audio); it implements TriggerVoice / Voice_Release / Voice_Kill /
  Voice_ProcessEvent. `ShortName` "Video Player".
- Three parameters, no value texts (`GetName(FPN_ParamValue)` always returns ""),
  `idx 0 "Volume" 0..127 (127)`, `idx 1 "Mute audio" 0..1 (0)`, `idx 2 "P lay /
  pause" 0..1 (0)` (FL's spelling: the form's hint `^^P ^Play / pause` was split
  at the wrong place).
- **Notes do nothing.** Notes at keys 0..119, velocities 1..128, colours, pan, Mod
  X / Y, short and long: `TriggerVoice` returns no voice (handle -1) every time,
  there are no `CTL`, `PARAM` or `EVT` lines besides the host's own, the output
  stays silent. The plugin asks the host for `FHD_GetMixingTime(fmt 1)` (the song
  position in absolute ms, GT_AbsoluteMS) while it runs: it follows the song's
  time in milliseconds, not in ticks.
- State (`--save-state`, FL's .fst chunk 0xd5): 37 bytes = 9 little-endian int32
  + one byte (a Pascal string's length: the file name, empty here; the file is
  packed with `FHD_PackDataFile`, located with `FHD_LocateDataFile`).
  Default `[3, 146, 0, 3, 127, 0, 0, 192000, 0] + 0x00`, factory preset
  `[3, 146, 0, 3, 100, 0, 0, 96000, 0] + 0x00`. Index 0 is a version (3), 1 a
  set of flags (146 = bits 1, 4, 7), 4 is the Volume (127 default, 100 in the
  preset). The other fields (2, 3, 5, 6, 7, 8) are not understood; they do not
  depend on the host's sample rate, tempo or block size, and `--param` does not
  reach them headlessly. [TODO: unknown]
- The headless host cannot load a video: any state or dropped file (`--preset
  file`) crashes inside the plugin's OpenClip (a nil viewer / editor form), so FL's
  audio level, start-up latency and transport handling could not be measured.
- Strings of the binary used here: `There was an error loading the file: "%s".`,
  the open dialog filter `*.wmv; *.avi; *.qt; *.mpg; *.mpeg; *.m1v; *.mov; *.mkv;
  *.mp4; *.gif`, the time dialog titles `Start / End / Current time (H:M:S:MS)` and
  `(H:M:S:Frame)`, `Delay playback by `, `SMPTE (Auto : <n> fps)`, `Opening the same
  file` (loading the loaded file again does nothing), `seek pos forced (looping)`
  (Loop is a forced seek), `This demo version stops after %d seconds.` (the DemoVersion
  flag: the trial stops after 35 s per the manual; the clone is the full version).

## Parameters

| Index | Key | Name | Range | Default | Text |
|---|---|---|---|---|---|
| 0 | volume | Volume | 0..127 | 127 | `100%` at 127, `79%` at 100 (the wheel's percentage: FL reports none) |
| 1 | mute | Mute audio | 0..1 | 0 | Off / On |
| 2 | play | P lay / pause | 0..1 | 0 | Off / On |

The Volume wheel's form values: `Max 127, Value 127, DefaultValue 100`: a new
plugin starts at 127, a reset (Alt-click, right-click Reset) gives 100.

Factory preset (1): **Default** = Volume 100, everything else at its default.
Loading a preset keeps the loaded video, its range and the detached window.

## State (the channel's `plugin.params`)

Besides the three parameters: `file` (name), `videoKey` (key in the file store),
`videoType`, `sampleId` (the pool sample of the decoded audio: a key containing
"sample", so the engine receives it), `duration` and `fps` (measured at load),
the Options menu (`audio` = Enable audio, `dock` = Dock control panel, `aspect` =
Keep aspect ratio), `link` (Link transport), `loop`, `timeMode` (0 = H:M:S:Ms, the
SMPTE menu entries 1..14 with FL's tags), `start` / `end` (seconds; `start` < 0 =
Delay playback), `pos` / `seek` (the player's own position and a counter of user
seeks), `detached` and `rect` (the detached window). Defaults: audio, dock, aspect,
link on; loop off; start 0, end 0 (= the end of the clip).

The video file itself is a Blob in IndexedDB (`orchard-video`), never in the
project JSON; the decoded audio is a pool sample (stored with the project like any
imported sample: embedded in a saved project file; after a reload from the
autosave, which carries no sample data, the editor decodes the stored file again
under the same id, `ensureAudio` in `load.ts`). Loading a clip is one undo step
(pool sample + state). A project opened where the file store has no such file
shows "No video" and a hint to load it again; its audio still plays when the
sample is in the project file.

`normalize()` clamps everything and always clears `play` (a saved project never
starts playing).

Defaults that are guesses: FL's saved flags (146) have three bits set; the
form says Dock control panel is checked, Link transport and Enable audio are on in
FL; Keep aspect ratio is on here (it may be off in FL).

## Behaviour

### Link transport (default)

FL controls the video. While the song plays, the video's time is `start` + the
song's time in seconds (the song position in ticks at the tempo of the block; FL
asks the host for the position in absolute ms). `start` is signed: positive trims
the beginning, negative delays the video ("Enter a negative number to delay the
video relative to the project": the menu item "Delay playback by <song position>"
on the Set start button's right-click sets `start` to minus the song position).
The play range is [max(0, start), end]; at its end the video stops (Loop wraps it).
The video's clock is real time: a tempo change does not change its speed (after
a seek, a loop wrap or a start the song position in ticks is converted at the
current tempo: tempo automation earlier in the song is not integrated, FL's
absolute-ms position would be). A seek
or a pattern / song loop wrap re-anchors the video at the new song position (the
engine detects it by comparing the block's song position with where the last block
ended, so a loop wrap is followed at the next block, 2.9 ms at most; its position
is exact).

While the song is stopped, the picture shows the frame at the song position
(`start` + position). Scrubbing, nudging (Left / Right = previous / next frame,
while stopped) and clicking the time labels move the picture; the position holds
until the song position changes. While the song plays the scrub bar does not
seek ("FL Studio controls the video, not the reverse"). The player's Play / Pause
(P) and Stop (Shift+P) buttons then operate FL's transport. [approximation: FL's
manual says they "work with Link transport"]

### Link transport off

The player is a media player of its own: Play (P) runs from the position
(`pos`; from the start of the range when it lies outside it) to the end of the
range, Pause keeps it, Stop (Shift+P) goes back to the start of the range, Loop
repeats the range, scrubbing and nudging move `pos`. The plugin's own state changes
(play = 0 and `pos` at a pause or at the end) are reported by the engine
(`takeStateChanges`) and mirrored into the project like FL's `PARAM` events.
"P lay / pause" and "Mute audio" and "Volume" are automatable. Switching Link
transport on stops a player that was running by itself (Play off, position kept);
switching it off leaves the player resting (it does not start by itself; with the
song playing, the player's own Play decides).

### Controls (form coordinates, SynthPanel 410 x 453)

Picture (410 x 353) with `No video`; control panel (410 x 100): Load video file
(folder, 12,4), Options arrow (50,8: Enable audio, Dock control panel, Keep aspect
ratio, Time display with the form's 15 entries and "SMPTE (Auto : 25 fps)"), start
time (13,50; click = go to, right-click = Set time dialog), Set start (88,50, S),
Link transport (chain, H), Loop (L), Play / pause (P), Stop (Shift+P) in a pill, the
current time under it (right-click = dialog), Volume wheel (345,8) and Mute (373,8,
M), Set end (301,49, E), end time (324,50), the scrub bar (4,70, 400 x 30: grey, the
play range in orange, the handle at the video's time). Left items keep their
distance from the left edge, the volume, mute and end time from the right edge,
the transport stays centred (its form position 125 at 410 px). Dock control panel
off: the panel floats over the picture and shows on mouse-over.

The Set time dialog (259 x 164: Hours 0..99, Minutes, Seconds, Milliseconds 0..999,
or the frame number in the SMPTE displays; Accept / Cancel) opens in the page's
centre (FL: the screen's). Time displays: `0:00:06:262`, SMPTE non-drop and drop-frame
(29.97 / 59.94 skip frame numbers like SMPTE, shown with `;`).

The detached window (wrapper menu "Detached", saved with the plugin) shows the
same player at any size (the picture takes what the panel leaves); `Persistent`
keeps the window, the video element, the engine monitor and the audio repair for
as long as the channel exists. Dropping a video file on the picture loads it.

### The video side in the browser

A hidden `<video>` (muted) holds the file; frames are painted into canvases (one
per open view). While the song plays the element is kept within about 50 ms of the
song's audible time (`live.latencySec` compensated) by nudging its `playbackRate`
(+-10 %) and seeking when it is 0.3 s off; in the player's own mode the engine's
monitor (video time at the last block + wall clock) is the clock. Frame rate: the
`requestVideoFrameCallback` media times while the element plays for a moment
(background tabs deliver few callbacks; unknown = 25 fps). Audio: the file's
audio track is decoded with `decodeAudioData` (stereo; surround is folded down;
clips longer than ten minutes, whose pool sample would not fit the project's JSON
text, and files without decodable audio play without sound, and the picture says
so: "No sound: no audio track could be decoded from this file" / "...the audio is
too long to decode here (over 10 minutes)").

## DSP model (engine)

- Design: `notes: 'events'` (not 'voices'). FL's plugin is a Gen_Render
  generator: it mixes its own stream into the mixer and its TriggerVoice returns no
  voice, so there is nothing for the channel to trigger per note; `render()` is the
  whole plugin and the note events (which the plugin does not implement) are
  ignored. It is rendered every block while a clip is loaded: `tail` is a getter
  that is Infinity then (GenChannel.isActive() is true for an infinite tail), 0
  without a clip, so an empty player costs nothing and a loaded one has the clock
  its own playback and the song follow need. No INS tab, no `levels`: the channel's
  volume / pan / ON switch do not touch its sound (as for FL's Gen_Render
  plugins with their own mixing; the mixer track's fader does).
- Output = the pool sample at the video's time: copied when its rate equals the
  engine's (sample accurate: the position is rounded to the nearest frame), else
  4-point Hermite resampled; mono plays on both sides; non-finite samples are
  replaced by 0. Gain = `Volume / 127` (linear) unless Mute audio or Enable audio
  is off; a change ramps over the block it happens in. No fades at starts, stops
  or jumps (assumed to be FL's behaviour: its player re-seeks the decoder, `seek
  pos forced (looping)`).
- The play range, delay and loop are handled inside the block at their exact
  frame.
- Export renders like live playback (`ctx.rendering` changes nothing): with Link
  transport on the video's audio appears in the WAV from the song start, which is how
  FL's player puts the audio into a project export (the manual's "rip the audio"
  recipe).

## What is exact, what is approximated

- Exact (form / host / manual): plugin name and folder, parameter names, indices,
  ranges, defaults and the Volume wheel's reset value, the preset, the form's
  controls, positions, hints, menus and captions, the Set time dialog, the time
  displays' formats, notes doing nothing, no demo limit in the clone.
- Measured by the host but not understood: the saved state's fields 2, 3, 5..8.
- Approximated: the volume law (linear; FL's curve could not be measured), value
  texts (percentage / On / Off; FL reports none), the default of Keep aspect
  ratio, the picture-side sync (browser video element vs FL's decoder), what the
  player's buttons do while linked, scrubbing while the song plays (ignored),
  loop wrap placement at block granularity, the dialog's place, no support for
  files the browser cannot play (FL uses FFmpeg: avi / wmv / mkv may not play in
  every browser; the message is FL's).
- Not implemented: the hidden menu items (Ignore tempo changes, Send audio to
  playlist, Fullscreen, Stay on top, Keep on disk).

## Tests

`tests/gen/videoplayer.test.ts`: registration, texts, preset, state normalising,
time displays (milliseconds, SMPTE, drop frame, round trips), the position map
(delay, trim, loop), the engine's audio sync against ramp samples at several tempi
(60..180 BPM), tempo changes, block sizes, seeks and loop wraps, start / end /
delay / loop at the exact frame, Volume / Mute / Enable audio, resampling, missing
and late audio, the player's own playback (pos, seek counter, end of range, reported
state changes), switching Link transport, finite output with garbage, automation
of Volume / Mute / Play, the project JSON round trip, the engine channel (pattern
loops, WAV export flag, notes ignored) and the worklet-safety of the two modules.
Two randomised suites (150 and 80 seeded scripts: seeks, pauses, ranges, delays,
loops, block sizes 37..128) compare the engine frame by frame with a plain
per-frame reference of the documented behaviour, for the song-following and for the
player's own playback (they found a loop-wrap bug at a range end that sits a
rounding error below the end).
`tests/gen/videoplayer-ui.test.ts`: the file keys and the controller's actions on
the project (Set start / end, Delay playback, seeking, nudging, Stop, the position
shown with and without Link transport). The picture side (video element,
canvases, dialogs) needs a browser and was checked in the app's browser pane
(loading webm / mp4 with and without audio, the persistence across a reload through
the autosave, drop, scrubbing, the dialog, the detached window, the Play / Stop
buttons, the shortcuts, the song and the player's own clock driving the picture:
the picture stayed within about 20..70 ms of the audible time, the 880 Hz beeps of
the test clip came at the integer seconds of the displayed time).

## Known gaps

- Dropping a video file on the channel's row in the Channel rack goes to the rack's
  shared drop handler, which turns the channel into a Sampler (FL hands the file to
  the plugin, FPD_LoadFile); drop it on the player's picture instead. A shared hook
  (an editor module's `onDropFile`) would fix it.
- The channel's ON switch does not mute the player (notes only reach the plugin; as
  documented for the other note-less plugins in docs/gen-framework.md).
- The decoded audio is a normal pool sample: it is saved with the project as base64
  float PCM (large for long clips, hence the ten-minute limit) and re-saved by every
  autosave.
