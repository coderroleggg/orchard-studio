# Audio input and audio recording

How Orchard Studio records audio, what it takes from FL Studio, and where it differs.
The code is `src/engine/Recording.ts` (the session), `src/engine/Mixer.ts` (inputs, monitoring,
taps), `src/audio/AudioInput.ts` (the browser's input device), `src/audio/Recorder.ts` and
`src/audio/recording.ts` (the Record flow and the Playlist), and the menus in
`src/ui/app/recordingMenus.ts` and `src/ui/mixer/inputMenus.ts`.

## In short

*Options > Audio settings > Input > System default* (allow the microphone). In the Mixer (F9) choose the insert, set
its **IN** to an input and click its red **arm** button (use headphones: the armed input is monitored). **R** arms Record,
**Space** starts recording (after the count-in, if *Countdown before recording* is on), **Space** again stops it. In Song
mode the recording is an Audio Clip on the Playlist at the position where it started; in Pattern mode it is an Audio
Clip channel. Right-click Record for the filter and where the audio goes (the Playlist or Edison).

## Sources, and how sure each fact is

FL's online manual could not be read while this was built (image-line.com is blocked on the machine,
and the offline manual is not part of the FL Studio 2026 install). The behaviour comes from:

- **[C]** FL Studio 2026's own resources, read-only: the menus, captions and hints of the mixer track
  Input / Record / Monitor / Delay menus, the Mixer's *Disk recording* menu, the Record button's recording
  filter, the precount and wait-for-input menus, and the messages (`strings` of `FLEngine_x64.dylib`);
  the change log `WhatsNew.htm`; and the project's research notes (`docs/research/mixer.md` §3.6, §3.10,
  `docs/research/main-playlist.md` §1.5, §1.12).
- **[I]** inferred where those do not say: marked below. Nothing was copied from FL; the artwork is code.

## The signal path

```
getUserMedia stream --> MediaStreamAudioSourceNode --> AudioWorkletNode input 0 (every device channel, none mixed)
   -> Engine.process(L, R, n, input) -> MixerEngine.setInput -> each track with an Input: extL / extR
        EXT tap  (recorded: the input as it is)
        monitored?  --> added to the track input (before the FX slots, no plugin delay compensation)
        MIX tap  (input + everything routed into the track, before the FX slots)
        FX slots -> FX tap -> built-in EQ -> EQ tap -> polarity / swap / separation
        -> volume and pan -> LVL tap (mute not applied yet) -> mute -> POST tap
```

Each recorded track hands the signal at its pickup point to its capture every block. A recorded track
is never skipped by the idle-track optimisation, so a recording cannot miss a block. The engine posts the audio
in 4096-frame chunks (`recData`, transferred, not copied) and a `recTake` per track and take at the end.

## Audio settings: the input device

*Options > Audio settings > Input* lists `(none)`, `System default`, the devices from
`enumerateDevices` and `Refresh device list`, then the status line and the latency FL shows
(`Latency: input: 441smp, output: 1667smp (48ms)`).

- The stream is opened with `echoCancellation`, `noiseSuppression` and `autoGainControl` **off**,
  `channelCount: { ideal: 32 }` (all channels of the device; the worklet node takes the stream's channel
  count with `channelInterpretation: 'discrete'`) and `latency: { ideal: 0 }`. The processing the browser
  applies anyway (a browser that ignores the request) is shown in the menu.
- **Permission** is asked on first use: choosing a device, choosing a track input or arming a track that
  has one while a device is selected, Record. The page never opens the microphone by itself. A device
  chosen in an earlier session is opened at start only if the browser already allows the microphone
  (`navigator.permissions`), otherwise it waits for the first use.
- **Denied:** the status says so (`The browser did not give access to the audio input`), the Record flow
  stops with FL's `Audio input needed: please select an audio input first`, and choosing the device again
  asks again once the browser allows it. **Missing / busy / unsupported** each have their own message
  (`Missing external input` is FL's).
- **Device changes:** the list follows `devicechange`. If the open device disappears, or its stream ends,
  the input closes (FL: *input monitoring is disabled when the audio device is disconnected*) and the status
  becomes `Missing external input` (and the hint line says so); plugging it in again reopens it (and says so).
  A recording that is running continues with silence and keeps what it has.
- The choice is kept in local storage (`orchard-audio-input`). The recording options are kept too
  (`orchard-recording`): they are program settings in FL, not part of the project.

## The mixer track

The inspector's **IN** row: `[pickup] [input] [clock]`, and a red **arm** button on every insert's strip
(the master and Current have none); an armed track's fader is orange.

| Control | FL | Here |
|---|---|---|
| Input selector | `(none)`, stereo pairs on top, mono inputs below; right-click: *Auto map*, *Reset mapping*; Alt+click: none [C]; the input of a track being recorded can't be changed [C] | A pair is `{ ch }` (device channels ch and ch+1), a mono input `{ ch, mono: true }` (the same signal on both sides). *Auto map* gives the following inputs of the same kind to the following tracks from this one; *Reset mapping* clears every track. Several tracks can share an input. Without an open device the menu shows the devices instead |
| Recording pickup | External input only (EXT) / External and mixer input (MIX) / Post effects (FX) / Post EQ (EQ) / Post level and panning (LVL) / Post track (POST) [C] | As FL's menu, with FL's hints. LVL is taken before the mute switch, POST after it [I] |
| Monitor external input | Off / When armed / On, default When armed [C] | The same. Off: the input is not heard (EXT is still recorded); When armed: heard while the track is armed [C]; On: always |
| Input delay compensation | Reset / Set in ms / samples / beats; positive moves the recording earlier [C] | Stored in ms (`inputDelay`), set in any of the three units, ±5000 ms. *Adjust position of recorded audio* (per track, on) also compensates the plugin delay compensation of the playback chain |
| Arm disk recording | Right-click arms and names the recorded file [C] | Left-click arms; right-click arms and asks for the name (`recordName`). Tracks can be armed without an input if their pickup is not EXT [C] |
| Always show external input levels | Mixer > View [C] | The meter shows an unmonitored input too |

The track menu has *Arm / Disarm recording*, *Open audio editor* (Ctrl+E, in the Mixer) and *Open audio editor
and record* [C]: Edison is added in the first free slot, opened, and in the second case armed. Arming a track whose
input is monitored shows a one-time hint about feedback (a microphone next to the speakers).
*Mixer > Options > Disk recording* (menu of the Mixer window): *Auto-unarm*, *Auto-create audio clip*,
*Latency compensation*, *Ignore silent takes*, *Auto name playlist tracks* and the *Format* (16 bit / 24 bit /
32 bit float) [C]. Not here: *Render armed tracks to wave file(s)*, *Group loop recorded takes*,
*Apply track level and mute when recording*.

## The Record button and the toolbar

| | FL | Here |
|---|---|---|
| Record (R) | Arms recording; Play records [C] | R or the button arms. **Play then starts the session** (count-in, wait for input, loop); with *Recording starts playback* the arm itself starts it; arming while the song plays records at once, without the count-in. R again, while recording, ends the recording and leaves the transport playing. Stop / Space / pause end it and stop the transport |
| Right-click Record | Recording filter: Automation, Notes, **Audio**, Clips; Options: Recording starts playback, Disarm on stop, Enable recording markers [C] | Audio is the only filter that does anything (the others are listed, disabled: notes and automation are out of scope). Below it the choice FL asks for the audio: *Into playlist as an audio clip* or *Into Edison audio editor/recorder* [C]. *Disarm on stop* releases Record when the recording ends (default on) |
| Countdown before recording (Ctrl+P) | A metronome count-in; off by default [C]; right-click: Precount duration 1 bar / 2 bars [C] | The metronome clicks for the bars (accent on each bar), the transport waits, then the transport and the capture start on the same frame. The count-in sounds whether or not the metronome is on. Only when starting from stop. Stop, pause or Space during it cancel the recording |
| Wait for input to start playing (Ctrl+I) | Right-click: Only when recording, Respect recording filter [C] | The transport (and the capture) start on the first frame where an armed input reaches -40 dB (peak 0.01). After a count-in, if there is one. Both menu items are kept but have no effect: only audio recording waits, and only for audio |
| Loop recording | Loops the pattern or the Playlist selection; every pass is a take [C] | See below |
| Blend recording | Overdub (notes) | Disabled (notes are out of scope) |
| Tools > One-click audio recording | Into Edison / into the Playlist [C]; it opens the Playlist [C] | Opens the default input if none, gives the selected insert the first input if it has none, arms it, arms Record and starts; into the Playlist it also switches to Song mode and opens the Playlist |

### Takes and loops

A session is one take, or with *Loop recording* one take per pass of the transport loop: the time selection
in Song mode (`loop` message), the pattern in Pattern mode, the end of the song in Song mode without a
selection. Every take starts at the loop start, so its clip does too. Without *Loop recording* the take
continues through the loop points; in Song mode with no time selection the transport runs on past the end of
the song while recording (without it, it would loop at the end of the clips: a few bars in an empty
project) [I]. Moving the playhead while recording ends the take and starts one at the new position [I].
When the recording stops the earlier takes' clips are muted and the last take plays (FL: *recorded audio
clips in loop recording mode are now muted*) [C].

### Punch in and out

*Enable recording markers*: the Playlist's **Start recording** and **Stop recording** markers (what FL 21 renamed
from *Punch in/out* [C]) start and stop the capture when the playhead reaches them. They are made from the
Playlist time selection with Record's right-click menu (*Start/stop recording at selection* [C], FL has it in the
time selection's menu) and drawn on the ruler in red (`recordingOverlay.ts`). The transport starts (after the
count-in) and the recording opens at the Start marker's frame; at the Stop marker the recording ends and the
transport plays on. The markers made from the time selection sit at the loop's own ends: there the recording ends
where the loop wraps (with *Loop recording* on the loop goes on and every pass is a take). A start position past the
span plays on and the recording opens when the span comes round again [I]. There is no way yet to drag a marker or
add one on its own (`Marker.kind`).

## Capture and latency compensation

The session runs in the engine (`engine/Recording.ts`), so everything is counted in **engine frames**:

- The block that holds the start of a session (count-in end, first sound, punch-in) is split at that
  frame, so the transport and the capture start sample-accurately (the tests start in the middle of a block).
- A take is `[A, B)` in transport frames. Its capture window is `[A + delta, B + delta)` in input frames, so
  the first sample of a take is what reached the engine `delta` frames after the transport played its first frame,
  and a clip placed at the take's start tick lines up with the playback. After the stop the session stays open
  for `delta` frames to finish the takes (FL fixed *recording doesn't stop at the expected position ... when there
  is latency* [C]).
- `delta` per track, in frames, capped at 5 s: `manual input delay` (ms)
  `+ plugin latency of the track` for the pickups after its effects (FX, EQ, LVL, POST)
  `+` for a track with an input: `input latency + output latency` when *Latency compensation* is on [C],
  `+ the plugin delay compensation of the playback chain` (the master's arrival latency and its own) unless the
  track's *Adjust position of recorded audio* is off [C]; for a track without an input (an internal pickup only):
  `the arrival latency of the routes into the track`.
- The device latency comes from the browser: **output** = `AudioContext.baseLatency + outputLatency`, **input** =
  the input track's `getSettings().latency` (0 where the browser does not say). The numbers are estimates;
  the track's input delay is there to correct them (FL has the same menu). A negative total pads the start of the take
  with silence (the audio of the take before its start cannot be had).
- *Wait for input*: the first sound defines time zero, so the automatic part of `delta` is dropped (manual and
  plugin delays still apply); nothing of the attack is cut off [I].
- Verification in a real browser (Chrome, an AudioContext at 44.1 kHz): the engine's metronome played back
  into the input through a `MediaStreamAudioDestinationNode` (a software loopback with a round trip of 21.6 ms)
  was recorded with *Latency compensation* off (clicks 21.63 ms late), on (estimate 47.8 ms: -26.16 ms), and with
  +30 / -30 ms of input delay (-8.36 / +51.64 ms), each as the numbers say to within one sample.

## What a recording becomes

When the engine reports the end (`recDone`) the Recorder assembles each take of each track
(`FinishedTake`: stereo, the AudioContext's sample rate) and `commitRecording` stores them, as **one undo step**
(`Record audio`):

- a pool sample (`addRaw`, `SampleInfo.source = { kind: 'user' }`), so the project save embeds it like any user
  sample; its file goes to IndexedDB too (`storeUserSample`), as a WAV in the *Format* chosen in Disk recording
  (32-bit float exact; 16 / 24 bit PCM with dither, written to the file only: the pool sample in memory stays
  float);
- in Song mode with *Auto-create audio clip*: `addAudioClip(sampleId, startTick, { mixerTrack, name })`, so
  an Audio Clip channel routed to the recorded mixer track and a clip at the take's start, on the highest free
  Playlist track in view (`addAudioClip`'s rule). In Pattern mode, or with *Auto-create audio clip* off, only the
  Audio Clip channel is made (FL: *No Channel created after recording when 'Auto create audio clips' is off* was a
  bug [C]) and the hint after the recording says so, since a new project starts in Pattern mode;
- a clip starts on a whole tick: the part of the position between ticks is moved into the audio (zero frames at the
  start, or the first frames cut), and a take that is a whole number of ticks within two frames (a bar of a loop
  recording at a tempo whose bar is not a whole number of frames) gets exactly those ticks;
- names: the track's recording name, else its name (`Insert 4`), and `... take 2` for the takes of a loop recording
  (numbered from 1 in every session); a name that a channel or pool sample already has (or has as the start of its
  take names) gets the next number (`Insert 4 2`); *Auto name playlist tracks* names a default-named Playlist track after it;
- *Ignore silent takes* skips takes whose peak stays below -60 dB; *Auto-unarm* (default on) releases the recorded tracks
  in the same undo step; a recording is limited to 10 minutes (it stops with a hint).

## Edison

Edison is an effect: it records the signal that passes through its slot (`engine/effects/plugins/edison.ts`), before
its own playback is added and before its *Mute input* is applied, and it keeps the take in the pool by itself (its
editor module watches every Edison slot of the project, open or not).

- **On a track with an input**, Edison records that input: the input flows into the track while the track is
  monitored, and an *armed Edison* (its Record on, `params.rec`) counts as an armed track, so with the default
  *When armed* it hears the input without the track being armed [I]. *Off* keeps the input out of the track (and of
  Edison).
- **Transport Record with *Into Edison*:** Edison is added to each armed track that has none (the first free slot),
  opened, set to *Record when host is playing* and armed; the engine session only runs the transport side
  (count-in, wait for input, punch); when the recording ends Edison is disarmed and its record mode put back.
  Nothing is stored by the Recorder. FL's one-click recording and the audio logger presets use the same mode [C].

## Out of scope, differences, gaps

- Recording **notes and automation**, *Blend recording*, step editing and everything of FL's other recording filters.
- *Render armed tracks to wave file(s)* (Alt+R), *Group loop recorded takes*, *Apply track level and mute when recording*,
  *Delay audio output* (low latency mode), the track's **Ping**, FL's per-channel device names (the browser has none:
  `Input 1`, `Input 2`), **ASIO-style** hardware outputs per track (the Output selector is unchanged).
- Playlist **audio tracks** with recording controls and sub tracks for takes (the takes are stacked on free tracks
  and muted). While recording, the Playlist marks the stretch on the ruler and the grid and draws the level of each
  recorded track on the free tracks its clips will land on (`ui/playlist/recordingOverlay.ts`, fed by 90 ms chunks);
  it is not a clip yet, and the waveform is the peak, not min / max.
- FL's first-press dialog (*What would you like to record?*, with *Don't ask this in the future*): the right-click
  recording filter menu takes its place.
- **Pattern mode** makes an Audio Clip channel only (above); FL's behaviour there is inferred from its change log.
- Recording is **stereo** whatever the input; a mono input is the same signal on both sides.
- Negative latency compensation loses the start of the take's audio; at a loop wrap with a negative total the first
  frames of the next take are silence [I].
- The master and the Current track have no input.
- Latency numbers are the browser's estimates; the input delay is for the rest.

## To check against FL's manual (or FL itself) when it can be read

The [I] points above, in the order they matter: what FL does with audio recorded in **Pattern mode** (here: an Audio
Clip channel only); **Loop recording** without a Playlist selection (here: the pattern, or the song up to its end) and
without *Loop recording* on a selection (here: one take through the loop points); whether **Edison** hears the input
while the track is not armed (here: yes, while Edison itself is armed); what *Apply track level and mute when
recording* does to the pickups; where **LVL** and **POST** differ (here: the mute switch); the *Recording starts
playback* default (here: off, so Play records); the **Wait for input** level (here -40 dB); and the `Record button >
Audio` destination dialog.

## Tests

- `tests/recording-engine.test.ts`: simulated input buffers through the engine: routing, mono / stereo,
  monitoring modes, armed against unarmed, the pickups, sample-accurate start (mid-block count-in), latency and
  input delay (incl. negative), loop takes (also at fractional loop lengths), no wrap at the end of the song, wait
  for input, punch in / out, stop with a tail, Edison recording the input.
- `tests/recording-flow.test.ts`: the Recorder driving a real engine: the messages and hints, FinishedTake audio,
  count-in, loops, sub-tick alignment, Edison, markers, the length limit.
- `tests/recording-commit.test.ts`: recording -> pool sample -> clip with the real store: undo, muted takes,
  pattern mode, Auto-unarm, Auto-name, the Record button and the Play hook, the options kept, the WAV file.
- `tests/recording-input.test.ts`: the input device against a stubbed `navigator.mediaDevices`: constraints, permission
  denied then granted, device list, unplugging and plugging in, races, the remembered choice.
- `tests/recording-ui.test.ts`: the UI flow against the same stub: Options > Audio settings > Input, the mixer track's
  Input / pickup / delay menus, Auto map, the Record button's menus, the Disk recording options, the recording
  markers, one-click recording.
