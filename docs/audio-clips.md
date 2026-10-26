# Audio Clips

FL Studio's **Audio Clip** channel and the audio clips in the Playlist: the model, how the engine plays them,
the Playlist and Channel Rack UI, project IO and export, what differs from FL and what is missing.

FL's online manual could not be fetched while this was built, so the behaviour comes from what the project
already researched (docs/research/main-playlist.md, sampler.md), FL 2026's own UI strings (menu captions, option
names), and FL's behaviour as the author knows it. Tags: **[C]** confirmed by one of those sources, **[I]**
inferred, **[U]** uncertain (a guess a measurement or the manual should settle).

## The model

| Part | Where |
|---|---|
| Audio Clip channel: `Channel.kind = 'audioclip'`, one pool sample in `sampler.sampleId`, the Sampler's own settings (`SamplerSettings`) | `src/model/types.ts`, `createAudioClipChannel` in `src/model/defaults.ts` |
| Audio clip: `Clip.kind = 'audio'`, `channelId` (its Audio Clip channel), `start` / `length` / `offset` (ticks), `muted`; optional `fadeIn`, `fadeOut` (ticks), `fadeInTension`, `fadeOutTension` (-1..1), `gain` (dB) | `src/model/types.ts` |
| Defaults, gain and fade laws, the time mapping (`clipSeconds`, `resampleSpeed`, `audioClipTicks`...), automatic crossfade rule | `src/model/audioclip.ts` |
| `Playlist.autoCrossfades` (project flag, on in new projects, off when absent) | `src/model/types.ts` |

- An Audio Clip channel is a channel like the others: it is in `Project.channels` (Channel Rack row, mute LED, VOL,
  PAN, mixer track, automation of VOL / PAN / PITCH and of its Sampler settings) but has no notes and no steps.
  It **sounds only through its clips**; the channel holds the sample and how it is played, the clips choose which
  part plays where. Many clips can share a channel [C: FL's picker lists "Audio clip sources"].
- **Offset (slip):** `Clip.offset` is the number of ticks of the sample, as the channel plays it (after TIME / MUL
  / pitch), that lie before the clip's first tick. A clip is a window over its channel's sample [C: window model,
  research/main-playlist.md 4.13]; past the sample's end the clip is silent.
- **Defaults:** a new channel has VOL 100% (a Sampler has 78%; FL: Audio Clips play at the sample's original
  level [C: research/sampler.md]) and the Sampler's other defaults (Resample mode, declick Out only, no TIME).
  Colour `#4f7a86` [U].
- `addAudioClip(sampleId, start, { track?, mixerTrack?, name? })` (src/store/actions.ts) makes the channel and a
  clip of the sample's length (rounded **up**, so the tail is never cut) in one undo step. It registers a pool
  sample the project does not know yet from the sample pool (a recording only needs `addRaw`). `track` omitted:
  the highest empty track in view, as for new automation clips. `addAudioClipInstance(track, channelId, start)`
  places another clip of an existing channel; `AC.sendToPlaylist(sample)` (src/store/audioClipActions.ts) is
  "send to playlist as audio clip" (time selection, else the playhead in song mode, else tick 0).
- Deleting an Audio Clip channel deletes its clips. Replacing it by another generator does too.
- Clips that show the **whole sample** (offset 0, length = the sample's length) follow a change of that length (TIME,
  MUL, the trim tools, the channel's pitch in Resample mode): `setSampler` / `setChannel('pitch')` resize them in the
  same undo step. Clips that were trimmed, slipped or resized keep their window [I: FL clips end where their sample
  does until resized].

### Migration

`normalizeProject` brings older projects up to date: a project saved before audio clips existed has clips without
audio fields and no Audio Clip channels, and loads as it was (`Playlist.autoCrossfades` absent = off, so nothing
sounds different). Stored audio fields are sanitised (fades inside the clip, tensions -1..1, gain within range,
defaults left out); an audio clip whose Audio Clip channel is gone, or points at another kind of channel, is dropped.
`Project.version` stays 1.

## The engine (src/engine/AudioClips.ts)

`Engine.audio` (an `AudioClipPlayer`) owns the Audio Clip channels and the compiled clips. The Engine's hooks are
few: `channel` / `channelRemove` / `playlist` / `sample` messages, `scheduleBlock` (song mode only), `process`
(renders the voices into the channel's mixer track), `releaseAll`, status peaks, automation of channel controls.
`Sequencer.compileClips` ignores audio clips.

- **Timing.** A clip starts on the whole frame nearest its start tick (the same rule as notes) and ends on the whole
  frame nearest its end tick, so slices and clips that follow each other tile without an overlap or a gap, at any
  tempo. The clock is per voice: the song tick of its next frame, advanced each block, so a clip follows tempo
  changes, starts in the middle when playback starts or is relocated inside it (`pendingTruncated`, seek, loop wrap)
  and ends exactly at its end tick. The sample position of a clip is `(offset + ticks played) x seconds per tick x
  speed`; at the original speed a fractional start is rounded to a frame, so the clip plays the sample's own values.
- **Speed.** `rate = (sample rate / engine rate) x 2^(cents / 1200) x resampleSpeed(...)`: the header PITCH (range
  x knob), the main pitch (when the channel follows it) and, in **Resample** mode, TIME / MUL (the same law as the
  Sampler, from the tempo of each block, so it follows tempo automation). Interpolation is the engine's (linear,
  hermite6, sinc 24 ... 512; export uses sinc 64).
- **The buffer.** The engine plays the prepared sample (the Sampler's precomputed tools: trim, normalize, reverse,
  fades, EQ, reverb ... `prepareSample`) and, for the other stretch modes, the offline-stretched buffer
  (`src/audio/audioClipSample.ts`, below). Both the live host and the export use `prepareAudioClipSample`.
- **Level.** `G(VOL) x clip gain x fades x declick`, ramped over the block; pan is a **balance** with 0 dB at the
  centre (the Sampler's circular law takes 3 dB off there; FL's Audio Clips are "compensated so their default
  settings read as the recorded level" [C: research/sampler.md]; the exact law is [I]).
- **Declick** (the SMP tab's mode, `declickTimes`): a clip that cuts its sample before the end fades out over the
  mode's out time (10 ms in the default Out only); with an in time (all modes but Out only) a clip that starts
  inside its sample fades in. The "(bleeding)" modes carry the sound on **past** the clip end while it fades out
  [I]. A clip that plays its sample to the end, has a fade out of its own, or runs on into the next slice, gets
  no declick.
- **Seams.** Clips of one channel and track where one starts where the other ends at the matching sample position
  (what the slice tool and Chop make) are played straight through: no fade at the seam.
- **Fades and gain** (per clip, FL 21+ [C: research/main-playlist.md 9]): `fadeShape(u, tension)` (`u^(2^(3 t))`,
  linear at 0 [U: FL's curve shapes]); gain -inf (-60 dB) .. +12 dB [U].
- **Automatic crossfades** (`Playlist.autoCrossfades`, FL: "Automatic crossfades (current project)" [C]): clips of
  a track that overlap crossfade over the overlap (linear in and out); a longer fade the clip has stays.
- **Mutes.** Playlist track mute and solo (solo is the mute of the other tracks, as everywhere), clip mute, the
  channel's ON switch and the mixer track. Editing a sounding clip (resize, move, mute, delete) takes effect at once;
  a clip that disappears fades out. Stop, pause, seek and mode changes fade the voices out (10 ms).
- **Loops.** Song and time-selection loops cut the clips that cross the loop end (declick tail past the wrap) and
  restart the clips under way at the loop start.
- **Audition** (Channel Rack Ctrl+click, the clip menu's Preview, Alt+right-click): a live note on an Audio Clip
  channel plays the whole sample once.
- Pattern mode: audio clips are silent (only the pattern plays).

## Stretching (src/audio/stretch.ts, audioClipSample.ts)

The SMP tab's PITCH / MUL / TIME / MODE apply as for the Sampler (same `SamplerSettings`):

- **Resample**: the engine changes the speed (TIME: the sample lasts TIME x MUL beats, so the speed follows the
  tempo; pitch follows the speed). No offline work.
- **Stretch, E3 Generic, E3 Mono, Slice stretch, Slice map, Auto**: the sample is rendered **offline** (on the main
  thread, cached, 30 s of stereo in about 0.2 s) to the duration TIME x MUL beats (or its length x MUL) at the project
  tempo and shifted by PITCH cents; the engine plays it at speed 1. A tempo change renders it again when TIME is
  set; while that runs the old buffer plays. FL renders these modes with zplane's elastique library, which is not
  ported: the stand-ins are WSOLA (waveform-similarity overlap-add, one alignment for all channels), cut at detected
  onsets so every drum hit keeps its attack (E3 Generic: strong onsets; Slice stretch: every onset; E3 Mono: none,
  a longer window; **Slice map** moves the slices to their stretched positions without stretching them; **Auto**:
  slice stretch for loops that get shorter, slice map for loops that get longer, plain WSOLA without onsets).
  Pitch shifting is the stretch by `ratio x pitch` followed by a resample.
- Fidelity: these are approximations of FL's modes; transient-heavy material is good, dense polyphonic material
  and big ratios (> 2x) show WSOLA's phasiness. Stretch pro and the legacy e2 modes do not exist in the clone's
  mode list.

## UI

### Playlist (src/ui/playlist/Playlist.tsx, audioClip.ts)

- **Drawing:** title bar with the clip menu arrow and the channel's name (+ gain when set), the **waveform** of the
  sample window the clip shows (min/max peak pyramid; follows offset, speed, reverse and the trim tools; stretched
  modes are drawn at a uniform speed), the fades as shaded curves, handles when "Show fade editing controls" is on
  (Shift+F, window menu; on by default), muted clips dimmed, automatic crossfades drawn.
- **Creating:** dropping a sample from the Browser, an audio file from the desktop (or a picker panel entry) on the
  grid makes an Audio Clip at the snapped drop point on the track under it; several files go on consecutive tracks;
  dropped on a track header it also names the default-named track [C: M-BR table]. Edison, Newtone, Newtime and
  Slicex's "Send to playlist as audio clip" use `AC.sendToPlaylist`. Draw / Paint with an audio clip as the clip source
  (picker panel's *Audio* list, the toolbar's source menu, or the last clip clicked) place more instances.
- **Moving / copying:** drag moves (across tracks), Shift+drag clones, Ctrl+B duplicates, **Ctrl+X / C / V** cut, copy
  and paste clips of any kind (paste goes to the playhead in song mode [C: FL 21+]), Delete, marquee / Ctrl select,
  mute tool, Alt+M.
- **Trimming:** drag the right edge (any length; blank past the sample's end [I]) or the left edge (audio clips
  always trim from the left, the "Allow resizing from the left" switch is for pattern clips; the offset follows so
  the audio stays where it is). **Slip tool**: drag inside a clip to move the audio under its window (kept over the
  sample). **Slice tool** (C): cuts at the snapped tick, the first half keeps the fade in, the second the fade out.
  Shift+M "Stretch audio when resizing audio clips" (also in the window menu): dragging an edge re-times the channel
  (TIME beats) instead of trimming.
- **Fades and gain:** corner handles set the fade in / out lengths (snapped, Alt: free), right-click: curve
  shapes / reset; the diamond at the top sets the clip gain (drag, Ctrl: fine, snaps to 0 dB, double-click or
  right-click: reset); the hint bar shows the values.
- **Clip menu** (arrow, FL's items [C: FL 2026 strings]): Preview, Select source channel, Channel settings, Muted,
  Rename and color, Color, Make unique, Select all similar clips, Delete, **Chop** (in bars, beats, half / quarter
  / 8th / 16th / 32nd beats), Fades (show controls, reset, presets, automatic crossfades, reset gain), **Sample**
  (Make unique as sample, pitch -1 / +1 semitone [7 / 8], Reverse [9], Detect tempo, Fit to tempo), **Automate**
  (Volume, Panning: an automation clip over the audio clip). Double-click opens the channel settings; a handle
  resets itself.
- **Picker panel / window menu:** audio clip channels listed under *Audio* (click: clip source, drag into the
  playlist, double-click: settings, right-click: preview / rename / delete); the window menu has Cut / Copy / Paste,
  the audio options, the pitch / reverse commands and *Delete unused audio clips* (channels no clip plays [C: FL has
  the macro]).

### Channel Rack and channel settings

- An Audio Clip channel's row has the mute LED, PAN, VOL (default 100%), the mixer track and the name button as
  usual, and **no step buttons**: the waveform of its sample takes their place (click: channel settings). Its menu
  has Channel settings, Preview, Rename, Select clips in the playlist, Clone, Delete, Move, Route to mixer track.
  The rack's menu has FL's "Switch all / selected audio clip channels to" stretch-mode lists [C].
- The **channel settings** window is the Sampler's SMP page with the header (ON, PAN, VOL, PITCH + RANGE, TRACK):
  no INS and MISC tabs (an Audio Clip has no notes), no start offset or loop points (a clip plays the sample once).
  A sample dropped on it replaces the sample and the channel stays an Audio Clip channel.
- The Piano roll's channel list leaves Audio Clip channels out.

## Project IO and export

- A project file stores Audio Clip channels and clips as part of the project; user samples are embedded like any
  other. Autosave and "revert to backup" behave as before.
- **Export** (`exportWav`) prepares each Audio Clip channel with `prepareAudioClipSample` (stretch included) at the
  export rate, uses the 64-point sinc, and renders the song's clips like any other clip; the song length counts
  audio clips. Pattern-mode export renders only the pattern (as in FL).

## Differences from FL and gaps

- Stretch modes are WSOLA stand-ins for elastique; no Stretch pro, e2 modes, formant shift, slice markers / regions
  from files, tempo detection (Detect tempo assumes the sample is a loop of 2^n beats and reports its BPM).
- Clip lengths are windows in ticks: a clip does not resize itself when the tempo changes (unstretched audio
  plays at its natural speed, so its end can leave the clip) [U: FL may keep such clips at their length in time].
- Fade curve shapes, the gain range and the pan law are inferred [U]. Crossfades are linear (FL's shape unknown).
- Missing FL features: clip variants and clip properties (FL 2025.1, Alt+double-click), the zero-cross option,
  stereo / spectral waveform modes and frequency colours, ripple edit, consolidate and "Quick render as audio clip",
  the clip menu's *Edit sample* (Edison), *Pitch-correct sample* (Newtone), *Time-warp sample* (Newtime), *Extract
  stems*, *Crossfade with* (automation), the channel rack's display filter for audio clips (the rack's filter is
  a stub in the clone) and *Restretch all*, FL's audio / instrument playlist tracks (track modes).
- Time-synced clips in non-Resample modes re-render on a tempo change (debounced, main thread): a long sample
  at a long ratio pauses the UI for a moment while it renders.

## Tests

`tests/audioclip.test.ts` (model, project IO and migration, `addAudioClip`, the engine with simulated audio:
sample-accurate start / offset / length, loops, seek, fades, gain, pan, volume, routing, mutes, pitch, TIME / MUL,
declick modes, seams, automatic crossfades), `tests/audioclip-stretch.test.ts` (the stretcher and the stretched
buffer), `tests/audioclip-actions.test.ts` (clip edit actions, drawing helpers), `tests/audioclip-export.test.ts`
(`exportWav` end to end).

## Shared files changed

`src/model/types.ts` (channel kind, clip kind and fields, `Playlist.autoCrossfades`), `src/model/defaults.ts`
(`createAudioClipChannel`, normalisation), `src/store/actions.ts` (the *audio clips* section, `deleteChannels`,
`replaceGenerator`, `setChannel` / `setSampler` refit), `src/project/io.ts` (export, `importAudioClipFiles`, a drop
on an Audio Clip channel keeps its kind), `src/engine/Engine.ts` (the hooks above), `src/engine/protocol.ts` (the
`playlist` message's `autoCrossfades`).
