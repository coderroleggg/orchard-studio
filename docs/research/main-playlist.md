# FL Studio Main Window, Transport, Timing, Patterns, Playlist and Browser: Implementation Spec (Research)

Target behaviour: **FL Studio 21.x and FL Studio 2024 (24.x)**. Where FL 20 or FL 2025/2026 behave differently, it is called out inline and summarised in §9.
Compiled 2026-10-17. Research only; no code.

**Sources, in order of weight**

1. The official FL Studio online manual (current edition documents FL Studio 2026). Canonical URLs are cited (`https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/<page>.htm`). Note: `www.image-line.com` and `support.image-line.com` resolve to 127.0.0.1 on this machine (`/etc/hosts`), so the identical pages were read from Image-Line's own mirror host `cluster.image-line.com` (same path). The hosts file was not touched.
2. An older English snapshot of the same manual (FL 20.x era: it still describes "Punch in/out" markers, 32-bit memory notes and the Content Library) at `.../fl-studio-online-manual-de/html/`. Used to cross-check pre-2025 behaviour. Key prefix `M-OLD-`.
3. Local files of the FL Studio 2026 (26.1) install on this Mac, read only: factory project templates (parsed with a small FLP event dumper), toolbar layout presets (`*.tpr`), the UI string table of `FLEngine_x64.dylib`, the bundled change log `WhatsNew.htm` (full history back to FL 9), browser content folders and the default note-colour preset. Nothing was executed.
4. Community sources: PyFLP (open-source FLP parser), Image-Line's Python API stubs site, Image-Line forum threads, KVR, a Bonedo workshop article, a tutorial blog.

**Status tags**

| Tag | Meaning |
|---|---|
| **[C: KEY]** | Confirmed by the source `KEY` (resolved to a URL or file path in §12). |
| **[I]** | Inferred from confirmed facts, from file data, or from consistent indirect evidence. Reasoning is given where not obvious. |
| **[U]** | Uncertain, conflicting or undocumented. A recommended clone default is given (see also §10). |

Version shorthand: FL 21 = 21.0 to 21.2.x (Dec 2022 to Feb 2024); FL 2024 = 24.1 to 24.2.x (Jun 2024 to Feb 2025); FL 2025 = 25.1 to 25.2.x; FL 2026 = 26.1.x.

---

## 0. Quick reference

| Item | Value | Status |
|---|---|---|
| Tempo range | 10 to 522 BPM; fine part in 1/1000 BPM | [C: M-TB], [C: X-PYFLP] |
| Tempo of default template ("Basic with limiter") | 130 BPM | [C: L-TPL] for the 2025/2026 template files; FL 21/2024 [I] (same value in a 2017 description, X-BONEDO) |
| Tempo of "Empty" templates | 140 BPM | [C: L-TPL] |
| Tempo presets (tempo LCD right-click) | 80, 90, 100, 110, 120, 130, 140, 150, 160 BPM | [C: M-TB] range, exact list [C: L-BIN] |
| PPQ default | 96 | [C: M-PGS] |
| PPQ options | 24, 48, 72, 96, 120, 144, 168, 192, 384, 768, 960 | [C: X-PYFLP] (community); not listed in the manual |
| Default time signature | 4/4, 4 steps per beat, 16 steps per bar | [C: L-TPL], [C: M-CR] |
| Ticks per step at 96 PPQ | 24 (step = 1/16 note) | [I] PPQ / 4 |
| Song position formats | `B:S:T` (bar:step:tick), `B:B:T` (bar:beat:tick), `M:S:CS` (min:sec:centisec); SMPTE added in 2024.2 | [C: M-TB], labels [C: L-BIN], SMPTE [C: M-N24] |
| Main (monitor) volume | 0 to 125 %; 125 % = +5.6 dB; not rendered, not automatable, saved per project | [C: X-PYFLP], [C: M-TB]; default 100 % [I] |
| Main (master) pitch | -1200 to +1200 cents, default 0; snaps to 100 cents (Shift = free); type-in in Hz, default A = 440 Hz | [C: X-PYFLP], [C: M-TB] |
| Patterns per project | 999 max | [C: M-TB] |
| Default pattern name | `Pattern N` (N = pattern number) | [C: L-BIN] |
| Playlist tracks | 500, default names `Track N` | [C: L-TPL] (500 track records), [C: CL 21.2 #14031], names [C: L-BIN] |
| Mixer inserts | FL 21/2024: 125 inserts + Master + Current. FL 2025+: dynamic, up to 500 | [C: M-N25], [C: CL] |
| Default pattern / track colour | #485156 | pattern [C: X-PYFLP]; track [C: L-TPL] |
| Default channel colour (2026 template) | #5C656A | [C: L-TPL] |
| Default snap | global "Line", local snaps "Main" | [U] (see §10) |
| Stop behaviour | returns to where playback started ("Remember seek time", apparently on by default); stop again = song start | [C: M-TB], default [I: X-F239007, X-F321104] |
| Song mode end | loops back to the start; no "stop at end" option | [C: X-F190640] |
| Window shortcuts | F5 Playlist, F6 Channel rack, F7 Piano roll, F9 Mixer, Alt+F8 Browser, F8 Plugin picker, F12 close all | [C: M-SC] |

---

## 1. Main window

### 1.1 Overall structure

Top to bottom:

1. **Toolbar dock.** Two horizontal "toolbar racks" stacked at the top of the screen. Each holds an ordered list of panels and icon buttons. Both racks can be moved by grab handles; the dock can sit at the top or bottom [C: M-TE], [C: M-OLD-TB]. Right-clicking an empty toolbar area opens the Toolbars menu: Edit, Separators, Flat buttons, Hint bar, Hide (Ctrl+F11), Presets [C: M-TB].
2. **Workspace ("FL Studio desktop").** Fills the rest of the window and shows a background colour or wallpaper [C: M-VIEW]. The main windows (Playlist, Channel Rack, Piano roll, Mixer, plugin windows) live inside it as movable, overlapping, resizable child windows. Each has a title bar with a window menu at top-left and minimise/maximise/close at top-right [C: M-UI]. Child windows snap to each other when dragged close; holding Alt stops snapping [C: M-UI]. Any of them can be "Detached" to float outside the desktop [C: M-UI].
3. **Browser** docked at the left edge by default (it can dock right, auto-hide or detach) [C: M-BR].
4. **Extended hint panel** (optional, off by default) floats at the lower-left corner of the workspace. It ignores mouse clicks so controls under it stay usable [C: M-TB].

There is no status bar. Hints appear in the toolbar's info box (§1.4).

### 1.2 Toolbar layout

The toolbar is built from named panels and buttons. The exact layouts ship as preset files. The FL 2026 install still contains the FL 2024 layouts, named "FL Studio 24 (Windows)" and "FL Studio 24 (macOS)". Their internal name is "Default", so they are taken to be the FL 2024 default [C: L-TBP]. FL 21 most likely used the same layout [I]: it has the same panel set, and the separate FL 12 preset differs.

Format of a preset entry: `PanelName|width_px|id|rack`, where rack 13 is the top rack and 14 the bottom rack. Panels collapse to the left; the last spacer stretches so items to its right stay right-aligned when the window is resized [C: M-TE].

**FL 2024 default, Windows** [C: L-TBP] (widths are px at 100 % scale; meanings [C: M-TB] unless marked)

| # | Top rack (13) | W | Bottom rack (14) | W |
|---|---|---|---|---|
| 1 | Main menu (FILE … HELP) | 300 | Title & hint info box | 300 |
| 2 | Main volume | 40 | Main pitch | 40 |
| 3 | Transport (PAT/SONG, Play, Stop, Record, Tempo) | 196 | Song position slider | 196 |
| 4 | Metronome | 30 | Typing keyboard to piano | 30 |
| 5 | Wait for input | 30 | Auto scroll | 30 |
| 6 | Recording count-in (precount) | 30 | Step editing | 30 |
| 7 | Blend recording (overdub) | 30 | Grouping (notes and clips) | 30 |
| 8 | Loop recording | 30 | Multilink to controllers | 30 |
| 9 | Time panel (song position digits) | 136 | Global snap | 92 |
| 10 | Output monitor (oscilloscope / spectrum / peak) | 172 | Pattern panel | 136 |
| 11 | CPU & memory | 156 | View Playlist | 30 |
| 12 | Undo / history | 30 | View Piano roll | 30 |
| 13 | Open audio editor (Edison) | 30 | View Channel rack | 30 |
| 14 | One-click audio recording | 30 | View Mixer | 30 |
| 15 | Help | 30 | View Browser | 30 |
| 16 | Save as | 30 | Project picker | 30 |
| 17 | Render (export) | 30 | Plugin picker | 30 |
| 18 | Project info / song settings ("SongSetBtn") [I] | 30 | Tempo tapper | 30 |
| 19 | Downloads ("DownloaderBtn") [I] | 30 | Touch controller | 30 |
| 20 | Flexible spacer | 370 | Shop | 35 |
| 21 | Window buttons (minimise / restore / close) | 68 | Online news panel | 172 |

- **macOS FL 2024 default** [C: L-TBP]: the window buttons come first (far left) in the top rack. Main volume moves to the bottom rack next to main pitch (info box 288, volume 40, pitch 40). The project-info button and the spacer are absent, and the online panel is 139 wide. The manual puts window buttons on the right on Windows and on the left on macOS [C: M-TB].
- **Rack height** is not stored. The manual's toolbar screenshot image map uses about 32 px per rack (two racks, y 0 to 32 and 33 to 64, image 1200 px wide) [C: M-TB image map]. Use about 32 px per rack at 100 % [I].
- **An older manual screenshot** (image map in M-TB) shows a different arrangement. Top: menu, recording icons, multilink, time, output, CPU, more icons, window buttons. Bottom: title/hint, volume and pitch together (60 px), transport, snap, pattern, view icons, online. Treat it as an alternative preset [I].
- **FL 2025/2026 default** (for reference) [C: L-TBP]. Top: menu, transport, time, typing keyboard, count-in, loop record, metronome, (2026: chord detection panel 96), output, CPU, spacer, window buttons. Bottom: info box, then Browser, Channel rack, Piano roll, Playlist and Mixer buttons, auto scroll, one-click recording, snap, pattern (144), Shift/Ctrl/Alt touch keys, Gopher, (Shop), online. Main volume, main pitch and the song position slider are no longer in the default set.
- Dragging content (for example a sample) over the Playlist, Channel Rack or Piano roll buttons brings that window to the front [C: M-TB].

### 1.3 Main menu bar

The bar reads FILE, EDIT, ADD, PATTERNS, VIEW, OPTIONS, TOOLS, HELP [C: M-MENU]. Checkable menu items can be right-clicked to toggle them without closing the menu [C: M-UI]. A "Save" item can carry a drag icon, so the file can be dragged out of the menu [C: M-UI].

**FILE** [C: M-FILE] (shortcuts per M-FILE / M-SC)

| Item | Notes |
|---|---|
| New | New project from the last selected template; asks to save changes |
| New from template ▸ | Template categories. In the 2026 install: Advanced, Empty, Minimal, Other, Performance, Power User, Utility [C: L-TPL folders]. The default template is set in General settings [C: M-GS] |
| Open… (Ctrl+O) | Has a Favorites section |
| Save (Ctrl+S) | Overwrites; for an unsaved project, shows the project-folder dialog (FL 21.x, if project folders are enabled [C: M-N21], [C: CL 21.2 #10302]) or a name dialog |
| Save as… (Shift+Ctrl+S) | |
| Save new version (Ctrl+N) | Saves `Name_2`, `Name_3`, … |
| Save to new project folder | FL 21.x [I] (fixes for it appear in CL 21.2 betas) |
| Save as template… | FL 21.2+ [C: CL 21.2 #14913] |
| Save and back up to FL Cloud | FL 2025/2026 era [I] |
| Import ▸ | MIDI and other formats |
| Export ▸ | Wave file (Ctrl+R), MP3 (Shift+Ctrl+R), OGG, MIDI (Shift+Ctrl+M), Master (FL Cloud, 21.2+), All playlist tracks ▸ (from song start / from track start / time selection), All playlist track groups ▸, Video, Zipped loop package, Project bones, Project data files |
| Recent projects (Alt+1 … Alt+0) | 10 listed; a "More" submenu shows up to 50 (FL 21.0+) |
| Revert to last backup | |
| Exit | |

**EDIT** [C: M-EDIT]: Undo / step back through history (Ctrl+Z, Ctrl+Alt+Z; see §7), Cut (Ctrl+X), Copy (Ctrl+C), Paste (Ctrl+V). Cut, copy and paste act on the steps and notes of the Channel Rack's selected channels; automation events are excluded. The target of Edit commands depends on the focused window.

**ADD** [C: M-ADD]: Channel ▸ (instrument list), Effect ▸, View plugin picker, Browse plugin database, Browse all installed plugins, Browse presets, Refresh plugins list (fast scan), Manage plugins, Automation for last tweaked parameter, Pattern (creates a new pattern).

**PATTERNS** [C: M-PAT] (full detail in §3)

| Item | Shortcut |
|---|---|
| Pattern list (select at left; name/copy at right) | |
| Find first empty | Shift+F4 |
| Find next empty | F4 (opens the name dialog) |
| Find next empty (no naming) | Ctrl+F4 [C: M-SC]. M-PAT says "Ctrl+4", a typo [I] |
| Select in playlist | |
| Rename and color… | F2 (press F2 again to cycle random colours) |
| Random color | |
| Open in project browser | Shift+Ctrl+P |
| Group selected / Ungroup selected | picker-panel filter groups |
| Set time signature… | (Shift+Alt+T in the Playlist and Piano roll) |
| Transpose… | |
| Insert one | Shift+Ctrl+Ins |
| Clone | Alt+C |
| Delete | Del |
| Move up / Move down | Shift+Ctrl+Up / Down |
| Split by channel | |
| Quick render as audio clip / Render as audio clip / Render and replace | |

**VIEW** [C: M-VIEW]

| Group | Items |
|---|---|
| Windows | Playlist (F5), Piano roll (F7), Channel rack (F6), Mixer (F9), Browser (Alt+F8), Project picker (Ctrl+F8), Plugin picker (F8), Tempo tapper, Touch controller (Alt+F7), Script output, Toolbars ▸ (Edit, Separators, Hint bar, Flat buttons, Hide Ctrl+F11), Tests, Plugin performance monitor (FL 20.5+ [C: CL 20.5]), Welcome to FL Studio (FL 2024+ [C: M-N24]) |
| Layout | Close all windows (F12), Close all plugin windows (Alt+F12), Close all unfocused windows (Ctrl+F12), Align all channel editors (Shift+F12), Arrange windows ▸ (Realign Shift+Ctrl+H, Into workspace, Desktop (default), Alternate, Tablet (default), Tablet (alternate), Custom, Save custom layout), Background ▸ (image, HTML on Windows, colour) |
| Browser | Undo history, Patterns, Generators in use, Effects in use, Remote control, Plugin database (Shift+F8) |
| News and Notifications | Downloads, News, Notifications (FL 2024+ [C: M-N24]) |

**OPTIONS** [C: M-OPT]: MIDI settings (F10), Audio settings, General settings, File settings, Theme settings (FL 21+), Manage plugins; Project info (F11), Project general settings; Debugging log; Enable MIDI remote control / MIDI output / MIDI master sync; switches (Typing keyboard to piano Ctrl+T, Metronome Ctrl+M, Recording precount Ctrl+P, Start on input Ctrl+I, Blend recorded notes Ctrl+B, Step edit Ctrl+E, Loop record, Auto scrolling, Enable groups, Multi-link to controllers Ctrl+J); Manage cloud accounts.

**TOOLS** [C: M-TOOLS]: Browser find (Ctrl+F); One-click audio recording ▸ (into Edison / into Playlist); Remix a song (2025/2026) [I]; Riff machine; Chord progression tool (FL 2024+ [C: M-N24]); Control creator; Macros ▸ (Prepare for performance mode, Prepare for MIDI export, Select unused channels, Purge unused audio clips, Switch smart disable for all plugins, Switch all/selected audio clip channels to…, Lock/Unlock all playlist tracks to/from content, Reset empty playlist tracks, Remove all Edison instances, Delete unused files and save project, Switch all plugin editors to Attached/Detached, Change declicking…); Panic ▸ (Stop sound Ctrl+H, Cancel recording); FL Cloud ▸ (21.2+); Clipboard ▸; Score logger ▸; Audio logger (2026); **Last tweaked ▸** (Edit events, Edit events in new window, Edit events in piano roll, Init song with this position, Delete initial value, Create automation clip, Link to controller, Copy value / Paste value, Override volatile link); Before last tweaked ▸; External tools….

**HELP** [C: M-HELP]: Help index (F1), Gopher (Alt+F1, FL 2025+), Tutorials (newer), Registration & unlock ▸, Support ▸ (diagnostics, reset settings, …), What's new, Buy FL Studio and upgrades, Internet links ▸, About….

FL 2024+ on macOS also copies the main menu into the macOS application menu [C: M-N24].

### 1.4 Title & hint bar (info box)

- The info box holds two lines [C: M-TB]:
  - **Title (upper)**: licence status, user name (or a "licence plate" number for privacy, FL 2024+), and the current project name. From FL 2024.2, if the project has no Title, the project file name is shown instead of the author name [C: M-N24].
  - **Hint (lower)**: a short description of the control under the mouse, plus that control's value while it is hovered or adjusted.
- Clicking a control also shows its value. Hovering most peak meters shows the level at the mouse position [C: M-TB].
- **Capability icons** at the right end of the hint line [C: M-TB]:

  | Icon | Meaning |
  |---|---|
  | Record | Automatable (recordable, envelope-controllable) |
  | MIDI plug | Linkable to a MIDI or internal controller |
  | Right mouse button | Has a right-click menu (its absence does not prove there is none) |
  | Happy / sad face | Success / failure (for example a browser search) |
  | Warning | Important hint (for example plugin latency) |
  | Clock | Long operation (rare) |
  | Fast-forward / rewind | Seeking (Playlist, Edison) |
  | Group | Two linked (grouped) events |
- **Sync indicator** next to it [C: M-TB]: blinks on MIDI input. Orange = handled by a project link, blue = handled by a global link, green = received but unused, grey = idle. The MIDI-sync LED blinks every beat and shows blue on each bar (only when MIDI output is enabled).
- **Extended hint panel** (View › Toolbars › Hint bar): a larger copy of the same text at the lower left of the desktop. Drag it by the centre of its progress circle [C: M-TB].
- Hint message markup: see §8.6.

### 1.5 Transport panel

Left to right inside the 196 px panel [I from widths and M-TB]: PAT/SONG switch, Play, Stop, Record, tempo LCD.

**PAT / SONG switch (L)** [C: M-TB]
- Two-state mode switch. Pattern mode plays only the current pattern; Song mode plays the Playlist arrangement.
- Right-clicking PAT opens the Channel Rack; right-clicking SONG opens the Playlist. The control's right-click also toggles the Playlist / Channel Rack window.
- Hint text: "Pattern or song mode / Show channel rack or playlist", shortcut L [C: L-BIN].
- The Channel Rack title bar has its own "Play / pause pattern" button and the Playlist title bar has "Play / pause song" [C: L-BIN], [C: M-TB].
- New-project default mode: Pattern [I] (the template opens with an empty pattern selected; not stated in any source).

**Play / Pause**
- FL 20/21-era manual: clicking Play starts playback and clicking it again **pauses**. Space = play/stop; Ctrl+Space = play/pause [C: M-OLD-TB]. The FL 2026 binary still labels the button "Play / pause" (Space) [C: L-BIN]. A 21.2 fix mentions the button's hint showing a different shortcut while pressed [C: CL 21.2 #13294], consistent with a pause state.
- The current (2026) manual instead says a second click "stops and rewinds" [C: M-TB]. This conflicts with the older manual. For FL 21/2024, implement play/pause [I].
- If Record is armed, Play starts recording [C: M-TB].
- macOS: Cmd+Space may clash with Spotlight [C: M-TB].

**Stop (Space)** [C: M-TB]
- Stops playback or recording. Double-click = panic (all notes off).
- Right-click shows the option **Remember seek time**. When on, the next Play starts from the position last chosen by clicking the timeline.
- Full semantics in §2.8.

**Record (R)** [C: M-TB]
- Toggles record arm (shown red when armed [C: M-RS]).
- Pressing Record with nothing configured shows a popup asking what to record. Once that popup has been disabled, Alt+click shows it again.
- Record can be automated with Start/Stop recording time markers. These were called Punch in/out before FL 21.0 [C: M-N21].
- **Right-click = recording filter** (ticked items are recorded; left-click toggles):

  | Item | Effect |
  |---|---|
  | Automation | record knob, slider and switch movements |
  | Notes | record note input |
  | Audio | record audio |
  | Clips | record clips triggered in Performance mode |
  | Recording starts playback | pressing Record also starts playback |
  | Disarm on stop | unarm when stopped |
  | Enable recording markers | honour Start/Stop recording markers |
  | Quantize options ▸ | Note start time, Note end time, Leave note duration, Record to step sequencer, Automations |

**Tempo LCD** [C: M-TB]
- Large digits show the whole BPM. Range 10 to 522.
- Small digits are the **fine tune**, in 1/1000 BPM, added to the base tempo. The usual display is a 3-decimal number such as `130.000` [I].
- Time signature is not set here; see §2.3.
- Editing (common LCD rules, §8.2):
  - drag up/down on the digits;
  - click the top or bottom edge to step by one unit;
  - hold the left button and type digits [C: M-UI];
  - mouse wheel steps the value [I];
  - Right-click › Type in value… takes a real BPM value [C: CL, old entry].
- Right-click menu, in order of the manual [C: M-TB]:
  - automation and linking items (Edit events, Create automation clip, Copy value / Paste value, Type in value…, …);
  - **Tap** (tempo tapper: tempo follows from the second tap; +/- nudge while held; Sync; Mute; Now; FL 2024.2 adds "Apply tempo" so tapping can just measure [C: M-N24]);
  - presets 80 to 160 BPM in steps of 10 [C: L-BIN];
  - **Half speed** (plays at half BPM without changing the display; temporary).
- Hint: "Tempo" with the automatable and linkable icons [C: L-BIN].
- A tempo automation clip's default range is 60 to 180 BPM [C: M-TB].
- MIDI-controller tempo jog steps 0.1 BPM [C: M-API].

### 1.6 Song position slider and Time panel

- **Song position slider** ("PositionToolbar", 196 px under the transport) [C: L-TBP]. Shows and sets the playhead of the Playlist (Song mode) or of the current pattern (Pattern mode); click and drag to move [C: M-TB]. Hint: "Song position" [C: L-BIN].
- **Time panel** (136 px): digital readout of the same position [C: M-TB].

  | Mode | Label | Fields |
  |---|---|---|
  | Bar mode, step | `B:S:T` | bar : step-in-bar : tick-in-step |
  | Bar mode, beat | `B:B:T` | bar : beat-in-bar : tick-in-beat |
  | Real time | `M:S:CS` | minutes : seconds : centiseconds (1/100 s) |
  | SMPTE (2024.2+) | e.g. 23.976 / 24 / 25 / 29.97 drop / 30 fps, Auto | right-click to choose |

  Labels [C: L-BIN]; modes and S/B switch [C: M-TB], [C: M-OLD-TB]; SMPTE [C: M-N24], [C: L-BIN].
  - The **S/B switch** chooses whether the middle field shows steps or beats. It applies to bar mode only.
  - Beats per bar, steps per beat and PPQ come from Project general settings.
  - Field numbering: bars and steps/beats count from 1, ticks from 0, so the start reads `1:01:00` [I].
  - Tick field width: 2 digits at 96 PPQ (0 to 23 per step). Pad to the width needed for higher PPQ [I].
  - Default mode: B:S:T [U].

### 1.7 Main volume and main pitch

| | Main (monitor) volume | Main (master) pitch |
|---|---|---|
| Purpose | Listening level only; spares the Master fader | Global pitch of instruments and audio clips |
| Range | 0 to 125 %, where 125 % = +5.6 dB [C: X-PYFLP] | -1200 to +1200 cents [C: X-PYFLP] |
| Default | 100 % [I] (neutral, matches mixer scaling where 100 % = 0 dB) | 0 cents [C: X-PYFLP]; type-in reference A = 440 Hz [C: M-TB] |
| Snapping | none documented | snaps to 100-cent steps, Shift = free [C: M-TB]; mouse wheel moves 100 cents (FL 21.0.3+) [C: M-N21] |
| Type in value | % (FL 2026 adds dB-aware type-in [C: CL 26.1 #22161]) | value entered in Hz for note A [C: M-TB] |
| Rendered? | no | yes |
| Automatable? | no [C: M-TB] | yes (record + plug icons) [C: L-BIN] |
| Saved | per project | per project |
| Hint | "Main volume" (right-click icon) [C: L-BIN] | "Master pitch" [C: L-BIN] |
| Notes | | Affects only channels with "Enable main pitch" ticked (Channel settings › Misc). "Add to key" makes it transpose notes instead [C: M-TB] |

The current manual calls the first control "Monitor Volume"; FL 21-era strings call it "Main volume".

### 1.8 Output (monitor) panel

172 px [C: L-TBP]. Right-click selects [C: M-TB]:
- **Oscilloscope**, with Stereo (stereo vs single line) and Long (stationary vs scrolling) options;
- **Spectrograph** (lows left; scaled so pink noise looks flat);
- **Peak meter** (red = clipping; hover to read the level in the hint).

Default mode: oscilloscope [U]. Resizing the panel needs toolbar edit mode [C: M-TB].

### 1.9 CPU & memory panel

156 px [C: L-TBP]. Shows [C: M-TB]:
- **CPU meter**: % of each audio-buffer period spent rendering; 100 % = underrun.
- **Memory**: address space in use, MB.
- **Polyphony**: active voices.
- **CPU graph**: rolling history.

Right-click: Refresh (Slow / Medium / Fast), View voice count / View FPS (alternating field), Misc (handles, threads, fonts). Double-click opens the Plugin performance monitor (FL 20.5+) [C: M-TB], [C: CL 20.5]. Hints: "CPU load", "CPU load history", "Memory usage", "Polyphony" [C: L-BIN].

### 1.10 Global snap panel

92 px [C: L-TBP]: a magnet icon plus the snap name.
- Sets the snap used by the Piano roll, Playlist and Event editor wherever their local snap is "Main" [C: M-TB].
- Right-click sets the default note length [C: M-TB].
- Global snap also drives **MIDI input quantize**. Line, Cell and (none) do not quantize input; step, beat and bar values do [C: M-TB], [C: M-RS].
- Backspace toggles between Line and (none) [C: M-SC].
- Hint: "Main snap / quantization / step edit step", shortcut BkSp [C: L-BIN].
- Value list, in menu order [C: M-API snap constants], [C: M-TB]:

  | API value | Option | Meaning |
  |---|---|---|
  | 0 | Line | nearest visible grid line (resolution follows horizontal zoom) |
  | 1 | Cell | start of the grid cell under the pointer |
  | 3 | (none) | free; resolution = 1 tick (PPQ) |
  | 4 | 1/6 step | |
  | 5 | 1/4 step | = 1/64 note |
  | 6 | 1/3 step | |
  | 7 | 1/2 step | = 1/32 note |
  | 8 | step | = 1/16 note |
  | 9 | 1/6 beat | |
  | 10 | 1/4 beat | = 1/16 note |
  | 11 | 1/3 beat | = triplet 1/8 |
  | 12 | 1/2 beat | = 1/8 note |
  | 13 | beat | = 1/4 note |
  | 14 | bar | = whole note in 4/4 |

  Local snap menus add "Main" at the top. The Playlist's local menu also has "Events" (snap relative to existing clips) [C: M-PL]. Value 2 is unused in the API, probably a menu separator [I].
- Holding Alt while dragging temporarily disables snap everywhere [C: M-TB].

### 1.11 Pattern panel

136 px in FL 2024 (144 in 2025+) [C: L-TBP]. Elements [C: M-TB], [C: L-BIN]:

- **Pattern options menu** (arrow): Find first empty (Shift+F4), Find next empty (F4), Find next empty without naming, Select in playlist, Rename / recolor (F2), Open in project browser (Shift+Ctrl+P), Set time signature, Insert one (Shift+Ctrl+Ins), Clone (Alt+C), Delete (Del), Move up / down (Shift+Ctrl+Up / Down), Split by channel, Quick render as audio clip, Render as audio clip.
- **Pattern name / selector**: shows the current pattern's name, for example "Pattern 1".
  - Drag up/down to change the pattern number [C: M-WF].
  - Numpad + / - = next / previous [C: M-SC].
  - Mouse wheel changes the pattern [I].
  - Right-click lists all patterns.
  - Left-click on the name opens the Playlist with that pattern selected as the clip source.
  - Hint "Pattern selector", badge "+-".
- **New pattern button**: hint "New pattern (find first / next empty)" [C: L-BIN]. Left-click = find first empty, right-click = find next empty [I] (from the " / " hint convention).
- Shift+wheel over the Channel Rack title bar also steps patterns [C: M-SC].

### 1.12 Shortcut icon buttons

All are optional toolbar items [C: M-TB]. Hint strings [C: L-BIN].

| Button | Left click | Right click | Shortcut |
|---|---|---|---|
| Metronome | toggle click (accent on bar start) | choose sound; route to a mixer track | Ctrl+M |
| Wait for input | Play waits for first input | options: only when recording, respect recording filter | Ctrl+I |
| Recording count-in | metronome count-in before recording | number of bars | Ctrl+P |
| Blend recording | overdub instead of replace (notes); sound-on-sound for audio | | Ctrl+B |
| Loop recording | loop the pattern, piano roll or playlist selection while recording | | |
| Typing keyboard to piano | QWERTY becomes a MIDI keyboard | root note, octave, layouts, snap to scale | Ctrl+T |
| Auto scroll | editors follow the playhead (linked to Scroll Lock; ON at start) | continuous scrolling | |
| Step editing | step entry in the Piano roll | | Ctrl+E |
| Grouping | enable or disable note and clip groups | | (Shift+Alt+G in FL 2026) |
| Multilink to controllers | §1.13 | menu | Ctrl+J |
| Undo | undo | history in Browser | Ctrl+Z |
| Open audio editor | Edison | new Edison instance | |
| One-click audio recording | recording wizard | | |
| Help | manual | About | F1 |
| Save as | Save as | Save new version | Ctrl+Shift+S |
| Render | export wave | export MP3 | Ctrl+R |
| View Playlist | toggle Playlist | maximise | F5 |
| View Piano roll | toggle Piano roll | maximise | F7 |
| View Channel rack | toggle | | F6 |
| View Mixer | toggle | | F9 |
| View Browser | toggle | Plugin picker | Alt+F8 |
| Plugin picker / Project picker | open | the other one | F8 / Ctrl+F8 |
| Tempo tapper | open | | (hint shows Ctrl+F5 in 2026) |
| Touch controller | open | | Alt+F7 |
| Project info | open project info | | F11 |
| Shop, Online news | IL shop / news feed (inactive until first clicked) | | |

FL 2025/2026 add Shift/Ctrl/Alt touch keys, Gopher, Quick tweak, Language and Arrange buttons [C: M-TB].

### 1.13 Multilink panel (Ctrl+J)

When on, every software control you tweak is queued. Then [C: M-TB]:
- tweaking the same number of hardware controls links them in the same order; or
- the right-click menu applies to all queued controls: Edit events, Init song with these positions, Init pattern with these positions, Create automation clips, Link to controllers, Override global links, Randomize, Humanize, Cancel.

When off, its right-click menu acts on the last and second-to-last tweaked controls.

### 1.14 Window control buttons

Minimise, Restore, Close [C: M-TB].
- Restore's right-click (or Alt+Enter) shows/hides the OS taskbar or Dock.
- Close (Alt+F4) has a right-click menu: Stop playback, Restore, Minimise, Maximise, Maximise for all monitors, Exit.
- Order: Windows = minimise, restore, close at the right; macOS = close, minimise, restore at the left.

### 1.15 Workspace windows and window management

- Main windows: Channel Rack (F6), Piano roll (F7), Mixer (F9), Playlist (F5), Browser (Alt+F8) [C: M-WF].
  - F-keys toggle show/hide [C: M-SC].
  - Enter toggles the Playlist between maximised and restored [C: M-SC].
  - Esc closes the focused window; Tab cycles windows [C: M-SC].
  - F12 closes all windows; Ctrl+Shift+H restores the default arrangement [C: M-VIEW], [C: M-SC].
- Window menus: a small icon at each window's top-left opens its menu [C: M-UI].
- Two-dimensional scrollbars (Playlist, Piano roll) [C: M-UI]:
  - right-drag the scrollbar to scroll horizontally and vertically together;
  - middle-drag in the content pans;
  - dragging the horizontal scroll handle's edges zooms;
  - the vertical zoom handle is a small box dragged up/down.
- Startup: FL 2024+ can show a **Welcome window** (recent projects, templates, quick actions) before the project [C: M-N24].

---

## 2. Timing model

### 2.1 Units and formulas

| Unit | Definition | Status |
|---|---|---|
| Tick | 1/PPQ of a quarter note | [C: M-PGS], [C: X-STUBS] |
| Beat | FL calls a quarter note a beat; BPM always counts quarter notes | [C: M-PGS] |
| Step | 1/(steps per beat) of a beat; default 4, so a step is a 1/16 note | [C: M-CR], [C: X-STUBS] |
| Bar | beats-per-bar beats (time-division mode) or numerator × (4/denominator) quarter notes (time-signature mode) | [C: M-PGS] |

Derived values [I]:
- `ticksPerStep = PPQ / stepsPerBeat` → 24 at 96 PPQ
- `ticksPerBar(4/4) = 4 × PPQ` → 384
- `secondsPerTick = 60 / (BPM × PPQ)`
- One beat lasts `(60 / BPM) × (4 / denominator)` seconds [C: M-PGS], so 6/8 at 120 BPM gives 0.25 s per eighth-note beat.
- Display conversion for B:S:T: `bar = floor(t / ticksPerBar) + 1`, `step = floor((t mod ticksPerBar) / ticksPerStep) + 1`, `tick = t mod ticksPerStep`. For M:S:CS, use absolute seconds (tempo automation changes the mapping) [I].

### 2.2 Tempo

- One project tempo (10 to 522 BPM, fine part 0.001). It can be automated with a tempo automation clip [C: M-TB].
- Patterns have no tempo of their own [C: M-TB].
- MIDI-scripting tempo set/get accept floats [C: M-API].
- Before FL 11 the maximum was 999 [C: X-PYFLP]; irrelevant for the clone.

### 2.3 Time signature and time division

Project general settings › Time settings offers two modes [C: M-PGS]:
- **Set as time division**: "Bar" = beats per bar and "Beat" = steps per beat. The grid is 4/4-like. This is the pre-time-signature system. It is greyed out once any time-signature marker exists.
- **Set as time signature**: numerator / denominator.
- Multiple signatures: Playlist time markers of type Time signature (Shift+Alt+T) change it from a point or over a selection. With a selection, a second marker restores the previous signature [C: M-PL].
- Each pattern can have its own signature (Patterns › Set time signature, Piano roll markers). Changing a pattern's signature affects all its clips; "Make unique" avoids that [C: M-PL].
- Default template: numerator 4, beat 4 [C: L-TPL].

### 2.4 PPQ (timebase)

- Default 96 [C: M-PGS]; options [C: X-PYFLP] in §0.
- Raising PPQ never moves events. Lowering it moves events that fall between the new grid points, after a warning that it cannot be undone [C: M-PGS], [C: L-BIN].
- PPQ limits zoom depth and placement resolution for notes, clips, automation points and recorded events [C: M-PGS].
- Live-recorded automation at 96 PPQ produces 384 points per bar [C: M-RA].

### 2.5 Pattern length (Pattern-mode loop)

Rules, in priority order:

1. **Explicit length.** The Channel Rack "Pattern length" control: Auto, or 1 to 512 steps (right-click to pick bars); dragging the rack's lower-right edge exposes more steps [C: M-CR]. A Piano roll time marker of type "Pattern length" also sets it [C: M-PR].
2. **Auto** (default) [C: M-CR], [C: M-WF], [C: X-KVR317373]: the pattern ends at the end of the last bar that contains data. Data includes notes, steps and event automation; an automation event past the notes lengthens the pattern.
   - Formula [I, verified against demo projects in L-DEMO]: `lengthBars = max(1, ceil(lastEnd / ticksPerBar))`. `lastEnd` is the maximum over all notes of `pos + max(len, 1)` and over automation events of `pos + 1`. Zero-length steps count as occupying their tick.
   - Examples from the factory demos: last note ends at tick 288, 755, 1148 or 1476 → pattern of 384, 768, 1152 or 1536 ticks (1, 2, 3, 4 bars). A note that ends exactly on a bar line does not add a bar.
   - Empty pattern → 1 bar [I]. The Channel Rack shows 16 steps by default [C: M-CR].
3. **Channel looping** (Channel Rack loop button, FL 20.1+, off by default [I: CL 21.2 #16226]). Channels with shorter sequences loop to fill the pattern, recreating FL 11 behaviour [C: M-N20]. Right-click modes [C: M-CR]:
   - Loop step channels (loops at the next step);
   - Loop all channels (loops at the next beat);
   - Advanced looping (per-channel Bar / Beat / Step / don't loop);
   - plus Burn tools.

   Looped "ghost steps" are drawn in the rack, and looped content also appears in Playlist pattern clips [C: CL 21.2 #15933].

Pattern mode plays the current pattern from its start (or from a clicked Piano roll position) and wraps at its length. A Piano roll time selection loops just that range [I], [C: M-PL] (time selections loop).

### 2.6 Song mode playback and song length

- Song mode plays the active arrangement. At the end it **loops back to the beginning**. There is no built-in "stop at end"; the forum workaround is to place a loop marker after the content [C: X-F190640].
- **Song end** = end of the last clip of any type, automation clips included [C: CL 20.9 #12163: a song once looped "after one bar instead of when an automation clip ends"]. It is rounded up to the next whole bar [I]. An empty playlist loops 1 bar [I, same changelog entry].
- Return point: bar 1, or the marker of type **Start**, if any ("playback and time = 0 starts from" it) [C: M-PL]. A marker of type **Loop** sets where playback returns when the end of the data is reached; placed after the last data, it also extends rendering to that point [C: M-PL].
- A **timeline selection** restricts playback to the selection and loops it [C: M-PL].

### 2.7 Loops and timeline selection

How to make a selection [C: M-PL]:
- Ctrl+left-drag in the bar ruler selects time across all tracks. Plain left-drag may also select [U].
- Ctrl+drag in the track-name area selects a group of tracks.
- Double-click a time marker selects from it to the next marker (or the song end).
- Ctrl+click the left edge of the leftmost bounding marker selects between markers.
- Ctrl+Enter sets the selection to the selected clips (or the zoomed range).
- Ctrl+Left / Ctrl+Right shifts the selection by its own width.

Removing it: double-click anywhere on the ruler, or Ctrl+click the selection [C: M-PL].

Effects of a selection:
- It loops on playback and renders as a single section [C: M-PL].
- Clip parts inside it turn red (selected); parts outside do not play [C: M-PL].
- The Playlist play button and Stop honour it [I].
- Timeline-selection editing [C: M-PL]: Ctrl+Ins inserts that much empty time (clips right of the start shift right); Ctrl+Alt+Ins slices at the start and inserts space; Ctrl+Del deletes the time and closes the gap; Ctrl+B with a selection duplicates using the selection length as the interval.

### 2.8 Start / stop / pause / relocate semantics

| Action | Result | Status |
|---|---|---|
| Space while stopped | Play from the current play position | [C: M-SC] |
| Space while playing | Stop and return to the position playback started from (when "Remember seek time" is on) | [C: M-TB], [C: X-F239007] |
| Stop while already stopped | Return to song start | [I]. CL 26.1.2 #22254 (a fix for "clicking the Stop button once doesn't reset the playback position") shows a single Stop click is meant to reset the position; the "second press goes to song start" rule is from a secondary summary only |
| "Remember seek time" off | Stop always returns to the song start (0) | [C: X-F239007] |
| "Remember seek time" default | On [I]: users report "stop returns to where I clicked" without changing settings (X-F321104), and turning it off gives return-to-0 (X-F239007) | [I] |
| Ctrl+Space | Pause / resume (keeps position) | [C: M-SC] |
| Click on the ruler (stopped or playing) | Moves the playhead; while playing, playback jumps there | [C: M-PL] |
| Drag the playhead marker | Scrub / relocate | [C: M-PL] |
| Home | Playhead to song start | [C: M-SC] |
| Playlist play button, right-click while playing | Stop and return to last start position | [C: M-PL] |
| Playlist play button, right-click while stopped | Playhead to song start | [C: M-PL] |
| Numpad * / Numpad / | Next / previous bar (Song mode) | [C: M-SC] |
| Numpad 0 | Fast forward (hold) | [C: M-SC] |
| Alt+Numpad * / Alt+Numpad / | Jump to next / previous time marker | [C: M-SC] |
| "Quantize song jumps" (Playlist menu) | Relocations wait until the next beat or 1 to 8 bars; Off by default [I] | option [C: M-PL] |
| Audio settings "Play truncated notes" | On relocation, notes already sounding at the new position are played | [C: M-AS] |
| Audio settings "Reset plugins on transport" | Plugins are reset on start, stop and relocate | [C: M-AS] |
| Multimedia keyboard Stop | Stops and returns to the Playlist start | [C: M-UI] |

FL 2025+ draws a visible "Remember seek time" marker on the Playlist and Piano roll ruler [C: CL 25.1.99 #18940].

### 2.9 Time markers

- Add with Alt+T (named) or Ctrl+T ("Auto"), or by right-clicking the ruler › Add marker [C: M-PL].
- Drag a marker by its left edge; markers can pass over each other [C: M-PL].
- **Right-click a marker**: Add marker, Add time signature…, Place loop (Shift+T), Delete, Rename…, Move content left/right [C: M-PL].
- **Action types** [C: M-PL]:

  | Type | Effect |
  |---|---|
  | None | label only (default) |
  | Start | song start / time 0 |
  | Loop | return point when playback reaches the end of the data |
  | Marker loop | at the next marker, jump back to this one |
  | Marker skip | skip to the next marker |
  | Marker pause | pause unless the previous marker is a loop |
  | Time signature | signature change from this point |
  | Start recording / Stop recording | automate the Record button |

- Playlist menu › Time markers adds: Add two (at selection edges), Add one every Bar / 2 / 4 / 8 bars, Add jump to next bar, Change marker to loop, Start/Stop recording at selection [C: M-PL].
- View › Time segments › Markers shades marker regions [C: M-PL].

---

## 3. Patterns

### 3.1 Concept and relation to channels

- A pattern holds, for **every** Channel Rack channel, its step sequence, Piano roll notes and event automation [C: M-CR], [C: M-PAT]. All patterns share the same channel list; one pattern can drive any number of instruments [C: M-CR].
- Selecting a pattern changes what the Channel Rack and Piano roll show [C: M-CR].
- Channels, not patterns, carry the mixer routing [C: M-PL].
- Patterns are placed in the Playlist as **pattern clips**. Every clip of a pattern references the same data, so editing the pattern updates every instance [C: M-PL]. "Make unique" makes a copy [C: M-PL].
- Event automation recorded during playback goes into the selected pattern [C: M-RA]. Notes recorded in Song mode create or extend a pattern clip where playback started; that clip expands to fit [C: M-RS].

### 3.2 Numbering, naming, limits

- Pattern numbers run 1 to 999 [C: M-TB].
- Default display name is `Pattern N` [C: L-BIN]. FL 2025 shows that default in the rename dialog [C: CL 24.2.99 #5707].
- Names are kept unique: a duplicate name gets a suffix such as `Synth Bass #2` [C: L-DEMO], [C: CL 24.0.99 #17424].
- `#` became usable in names in 21.2; an empty name is allowed [C: CL 21.2 #16287, #16354].

### 3.3 Creating

- Step the pattern selector to an unused number [C: M-WF].
- F4 / Shift+F4 / Ctrl+F4 = next empty with name dialog / first empty / next empty without naming [C: M-PAT], [C: M-SC].
- ADD › Pattern [C: M-ADD]; the toolbar "New pattern" button [C: L-BIN].
- Adding an instrument track creates a default pattern named after the instrument [C: M-PL].
- Picker panel: "Show empty patterns" option [C: M-PL].

A pattern is "empty" if it holds no data; empty patterns may be hidden from the picker [I].

### 3.4 Selecting

Pattern selector (§1.11), Patterns menu list, picker panel click, numpad 1 to 9 (patterns 1 to 9), numpad + / - [C: M-SC].

Clicking a pattern clip in the Playlist makes it the current clip source and selects it in the picker; whether it also becomes the current pattern is controlled by "Select from playlist/channel rack" [C: M-PL].

### 3.5 Clone, insert, delete, move

| Command | Behaviour | Status |
|---|---|---|
| Clone (Alt+C) | Copy of the selected pattern placed directly after it; later patterns move down one number [I]. The clone takes a unique name (`X #2`) [I] | [C: M-PAT] |
| Insert one (Shift+Ctrl+Ins) | Empty pattern inserted before the selected one | [C: M-PAT] |
| Delete (Del) | Deletes the pattern | [C: M-PAT] |
| Move up / down (Shift+Ctrl+Up / Down) | Swaps with the neighbouring number | [C: M-PAT] |
| Reordering in the picker panel | Renumbers the patterns | [C: M-PL] |
| Split by channel | One new pattern per channel in use, named after the channel | [C: M-PAT] |
| Merge pattern clips (Ctrl+G) / Merge similar (Shift+Ctrl+G) | New merged pattern; originals kept | [C: M-PL] |

### 3.6 Colours

- F2 opens the name dialog; pressing F2 again cycles random colours; the colour square opens the colour selector [C: M-PAT].
- Patterns › Random color [C: M-PAT].
- The picker panel can recolour without renaming (FL 2024.2) and apply gradient recolours [C: M-N24], [C: M-PL].
- Default colour #485156 [C: X-PYFLP]; the same value is used for default playlist track colour [C: L-TPL].
- Colour picker modes and "safe colours": see M-UI.
- How pattern clips use colour: §4.10.

---

## 4. Playlist

### 4.1 Concept

- The Playlist has 500 multi-purpose **clip tracks**. Any track can hold pattern, audio and automation clips, and clips may overlap or stack [C: M-PL].
- Tracks are **not** bound to mixer tracks: the channel routing of the instruments inside a pattern decides which mixer tracks sound [C: M-PL].
- Optional **Track mode** (FL 20+) links Channel ↔ Playlist track ↔ Mixer track as an "Instrument track" or "Audio track"; renames and recolours then ripple through the group [C: M-PL].
- Multiple **arrangements** (FL 20+) share the same channels, patterns and mixer [C: M-PL].

### 4.2 Window layout

Relative positions come from the manual's image map (screenshot 1300 px wide; treat as proportions) [C: M-PL image map]:

| Region | x range | y range | Notes |
|---|---|---|---|
| Title bar + toolbar | full width | 0 to ~68 | window menu, snap, tools; arrangement selector in the middle (x 385 to 530); window buttons right |
| Picker panel | 40 to 204 | 95 to 506 | optional; left by default ("Show on right side" option) |
| Clip-focus selector block | 211 to 329 | 71 to 128 | above the track headers, left of the ruler |
| Ruler (marker lane + bar numbers) | ~330 to right | ~71 to 128 | [I] |
| Track headers | ~212 to ~330 | 130 down | [I] |
| Clip grid | ~330 to right | 130 down | [I] |
| Scrollbars | right edge (vertical, with track-height zoom box); bottom (horizontal, edge-drag zoom, optional mini preview) | | [C: M-PL] |

Window title reads "Playlist - <Arrangement name>" followed by the current clip source [I].

### 4.3 Toolbar

Left to right [C: M-PL]:

1. **Playlist menu** (arrow): Edit, Tools, View, Snap, Select, Group, Zoom, Time markers, Picker panel, Edit patterns in, Quantize song jumps, Performance mode, Detached, and more (§4.15).
2. **Snap selector** (magnet) with local options Main / Line / Cell / (none) / steps / beats / bar / Events.
   - Alt = no snap while held.
   - Snap other than Line slows scrolling.
   - If placement becomes offset from the grid, Alt+Q on a selection resets the remembered grid offset [C: M-PL].
3. **Draw (P)**: §4.11.
4. **Paint (B)**
5. **Delete (D)**
6. **Mute (T)**
7. **Slip (S)**
8. **Slice (C)**
9. **Select (E)**
10. **Zoom (Z)**: right-click menu of quick zooms.
11. **Playback (Y)**
12. **Play / Pause** (song). Right-click while playing stops and returns to the last start; right-click while stopped goes to the song start.

Hint texts [C: L-BIN]: "Draw" (P), "Paint" (B), "Delete" (D), "Mute" (T), "Slip" (S), "Slice" (C), "Select" (E), "Zoom" (Z), "Playback" (Y).

Default active tool: Draw [U].

A **context tool menu** (middle-click plus right-click anywhere) offers the same tools and the main menu at the pointer [C: M-PL]. F3 opens the tool selector of the active window [C: M-SC].

### 4.4 Arrangements

Dropdown in the title bar [C: M-PL]:
- Clone, Rename, Delete, Add one.
- Merge with… (source arrangement; position Start / Current selection / End; mode Insert / Merge / Replace).

The default arrangement is named "Arrangement" [C: L-TPL].

### 4.5 Clip source selector, clip focus, add-track button

- **Clip source menu** (title bar): the clip that Draw/Paint will place. Right-click opens the Project picker (Ctrl+F8) [C: M-PL].
- **Clip focus selector**: three tabs, Audio, Automation, Pattern [C: M-PL].
  - Left-click a tab brings that clip type to the top of overlapping stacks for selection and editing. Ctrl+click focuses all types.
  - Right-click a tab lists that type's clips to choose a source.
  - M cycles focus when typing-to-piano is off.
  - Options under each tab:
    - Audio: Show fades (Shift+F, right-click menu: automatic crossfades, manual fades for new clips, snap fade handles, fade previews, gain scale/value), Zero-cross, Stretch (Shift+M).
    - Automation: Step (free-hand drawing; Shift = pulse lines), Slide (keep relative spacing of following points).
    - Pattern: **Note / Chan / Pat** colour source for clip content (§4.10).
- **"+" button** (FL 21.0+) left of the focus tabs [C: M-N21], [C: M-PL]: add an Instrument or Audio track. Right-click = quick audio track; middle-click = "More plugins".

### 4.6 Picker panel (Alt+P)

[C: M-PL]
- A list of every pattern, audio clip and automation clip, with filter switches at the top. Right-click a filter: All / Unused; sort by name, colour or mixer track.
- Placing clips:
  - click to select, then click in the Playlist to place; or drag into the Playlist;
  - Shift- or Alt-click selects several; Ctrl+click toggles items; Shift+click the first and last item selects a range.
- Preview a clip: Alt+right-click and hold.
- Rename: Shift+click (one or many). Recolour and gradient recolour work on multiple items.
- Reorder: drag, or Shift+wheel. Reordering patterns renumbers them.
- Shift+C scrolls the Playlist to the first instance of the selected clip.
- Right-click menus per item: the Patterns menu items, Transpose, Render, and others.
- Panel menu (Playlist menu › Picker panel): Enable, Show on right side, Width, Select linked channels, Select from playlist/channel rack, Show empty patterns, Drag to rearrange, Auto group patterns/channels, Select unused, Sort.
- The current source is highlighted.

### 4.7 Track header column

Per track [C: M-PL] unless noted:

- **Name** (default `Track N`), **colour** (default #485156), optional **icon** [C: L-TPL], [C: L-BIN].
- **Mute / solo switch**: a round LED-style icon [I]. Lit = playing, dark = muted [I] (same convention as the Channel Rack mute LED [C: M-CR]).
  - Left-click: mute / unmute.
  - Ctrl+click or right-click: solo / unsolo.
  - Alt+click: mute or solo the whole track group.
  - Shift+click: lock its state so solo does not touch it.
  - Hint "Mute / solo" [C: L-BIN].
- **Track selection** by clicking the header/selector. Ctrl+Up / Down moves the selected track; Ctrl+Alt+Up / Down extends the selection; Ctrl+drag in the name area selects several.
- **Resize**: drag the divider between headers. Alt+click a divider resets the height. Dragging a divider up past the track above groups it with that track (repeat to ungroup).
- **Reorder**: Shift+wheel over the header area, or the menu's Move up/down.
- **Drop targets**:
  - an audio file on a header creates an audio clip and names the track. Track-mode options: As audio clips (the pre-FL 20 behaviour), As audio tracks, As instrument tracks, Always ask;
  - a plugin on a header creates an Instrument track with a default pattern (Shift prevents the plugin window opening);
  - an effect on an instrument or audio track header goes into its linked mixer track.
- **Instrument / audio track extras**: the header shows a track-mode icon. Audio tracks show record controls (input, monitoring, arm), and the A icon turns red when armed. Headers can show level meters (View options). Double-clicking an instrument track header opens the plugin.

**Header right-click menu** [C: M-PL]:
- Rename / color (F2 random colour, F3 last colour inside the dialog); Set icon; Auto name; Auto name clips; Reset.
- Track mode ▸ (Unassigned / Audio track / Instrument track, with "Use existing" sub-items).
- Performance settings (Performance mode only); Size (% height); Lock to this size.
- Group with above track; Auto color group; Lock to content; Merge pattern clips.
- Consolidate this track ▸ (from track start Ctrl+Alt+C / from song start Ctrl+Alt+Shift+C); Mute all clips / Unmute all clips.
- Insert one; Delete; Clone…; Move up / Move down.
- FL 2024.2+: "Show patterns as PR ghosts" [C: M-N24].

### 4.8 Tracks

- 500 tracks [C: L-TPL], [C: CL 21.2 #14031].
- Heights: global vertical zoom (the track-height control), per-track Size %, View › Resize all tracks (33 % to 200 %). Default height multiplier 1.0 (FLP track record) [C: L-TPL].
- At small heights clips draw as "tiles"; "Content in title bars" shows content in tile mode [C: M-PL].
- Groups: child tracks are indented under a parent and can collapse. "Hide collapsed grouped tracks" shows an arrow on the parent [C: M-PL].
- Tools › Reset empty playlist tracks restores the default name, colour and icon [C: M-TOOLS].

### 4.9 Timeline ruler, markers, playhead

- Time runs horizontally. The ruler shows bar numbers [C: M-PL] above a time-marker lane [I].
- Grid density depends on the snap value, the horizontal zoom (more lines as you zoom in, down to the snap value), the time signature and PPQ [C: M-PL].
- Background shading per View › Time segments (default "Bars") [C: M-PL].
- Grid colour (Ctrl+Alt+G), contrast (High / Medium / Low), Invert grid, Track separators [C: M-PL].
- **Playhead** ("play position marker"): click on the ruler to set it, or drag it. Optional "Precise time indicator", a vertical line through the editor [C: M-PL].
- **Time selection**: §2.7. Selected clip parts are drawn red [C: M-PL].

### 4.10 Clip types and rendering

All clips have a **title bar** at the top showing the clip name, with the **clip menu** icon at its top-left corner [C: M-PL], [C: M-PLP]. "Keep labels on screen" slides the label along so it stays visible while scrolling [C: M-PL].

| Clip | Body content | Title | Colour |
|---|---|---|---|
| Pattern | Mini piano roll of the pattern's notes; step data as short marks; **event automation** drawn as a background graph, pink by default [C: M-PL], [C: M-RA]. Notes and events can share a clip (layered view) [C: M-PLP]. With channel looping, looped steps and a loop marker are drawn [C: CL 21.2 #15933, CL 25.1.1 #20124] | pattern name | Clip colour = pattern colour [I]. Note colour by the focus mode: **Note** (Piano roll note colours; default note colour #9ED1A5 [C: L-NCP]), **Chan** (channel colour), **Pat** (pattern colour) [C: M-PL]. Default mode [U]; recommend Note |
| Audio | Waveform: stereo / combined / spectral (set in channel settings); optional frequency-coloured waveforms (FL 21.1+) [C: M-PLA], [C: M-N21]; fade and gain handles and fade previews (FL 21+) [C: M-N21] | sample / channel name | channel colour [I] |
| Automation | Envelope line with control points and tension handles, edited directly in the body; the clip is moved and resized only by its title bar [C: M-PLAUTO], [C: M-PL] | target or clip name | channel colour [I] |

- **Overlap**: stacked clips are drawn with transparency; the focused type sits on top [C: M-PL].
- **"Behind clips" styles** (View): Nothing, Plain, Cel, Glass, Aqua, Solid, plus a Shadow option [C: M-PL]. Default [U].
- **Muted clips** (mute tool / Alt+M) are drawn dimmed [I]. FL 2024.2.1 makes the gain label on muted audio clips dimmer [C: M-N24].

### 4.11 Tools

| Tool (key) | Left button | Right button | Modifiers | Status |
|---|---|---|---|---|
| Draw (P) | Click empty space: place the current source at the snapped position; drag before releasing to reposition. Click a clip: select it and make it the source; drag to move | Click a clip: delete. Drag: delete several. Hold on the background: slice (if click-and-hold functions are on) | Shift: paint behaviour; Ctrl: rectangle select; Alt: no snap | [C: M-PL] |
| Paint (B) | Click: place; drag: paint repeated clips along the track at clip-length steps | as Draw | Shift: copy the clicked clip; Ctrl: select; Alt+click a clip: move without snap | [C: M-PL] |
| Delete (D) | Click or drag over clips deletes them | | Shift: make a selection, then press Delete | [C: M-PL] |
| Mute (T) | Click toggles a clip's mute; drag mutes several. Independent of the track mute switch | Click: delete | Ctrl: select; Alt+click: move without snap | [C: M-PL] |
| Slip (S) | Drag inside a clip shifts its content left or right while its start and end stay put (for clips shorter than their source) | | Shift+S / dragging an edge: ripple edit (§4.13) | [C: M-PL] |
| Slice (C) | Drag across clips to cut them. FL 2025+: the cut is vertical by default and Left-Shift gives a diagonal cut [C: M-N25]. FL ≤2024: the FL 20 manual says "drag vertically" [C: M-OLD-PL]; the cut line probably followed the drag, so diagonal cuts were possible [I] | | Shift: slice without dragging; Shift+Alt: same, unsnapped | [C: M-PL], [C: M-OLD-PL] |
| Select (E) | Click or drag a rectangle | | Shift: add or remove | [C: M-PL] |
| Zoom (Z) | Drag to zoom to an area | Quick-zoom menu: Zoom in/out (PgUp/PgDn), Quick-zoom 1 to 3 (Shift+1 to 3), Zoom out far (Shift+4), On selection (Shift+5) | | [C: M-PL] |
| Playback (Y) | Click a clip to audition from that point | | | [C: M-PL] |

Holding Shift in Draw or Paint swaps between the two modes (the cursor does not change). Holding Ctrl gives temporary Select mode [C: M-PL].

FL 2026 shortcut page: a right-click with another tool active acts as the Delete tool; a double right-click acts as Mute [C: M-SC]. FL 20-era: right-click deletes the clip under the pointer [C: M-OLD-SC].

### 4.12 Mouse interactions and modifiers

| Gesture | Effect | Status |
|---|---|---|
| Drag a clip body (Draw / Paint / Select) | Move; snapped; can move across tracks | [C: M-PL] |
| Alt while dragging | Disable snap | [C: M-PL] |
| Shift+drag a clip or selection (release keys first, then hold Shift and drag) | Copy (clone) the selection | [C: M-PL], [C: M-SC] |
| Shift+V+drag | Copy and make unique (FL 2024+); Ctrl+Shift+V makes the selection unique | [C: M-N24] |
| Double-click a pattern clip | Open in Piano roll (if it has notes) or Channel Rack. FL 21.2+: Alt+double-click opens the opposite one. FL 2024.1.2+: "Edit patterns in" option (Automatic / Channel rack / Piano roll / Piano roll or event editor; Scroll to position; 2024.2.1 Adjust start time) | [C: M-PL], [C: M-N21], [C: M-N24] |
| Double-click an audio clip | Channel settings (FL 2025+: clip properties on Alt+double-click; swappable) | [C: M-PLA] |
| Double-click a clip title bar | Channel settings for that clip | [C: M-PL] |
| Alt+right-click a clip | Audition / preview | [C: M-SC] |
| Ctrl+right-drag | Zoom to the dragged area; Ctrl+right-click again unzooms | [C: M-PL] |
| Ctrl+Shift+right-click a clip | Zoom to that clip | [C: M-PL] |
| Ctrl+right-click empty space | Zoom to full view / back | [C: M-PL] |
| Middle-drag | Pan (both axes) | [C: M-PL] |
| Middle-click + right-click | Context tool menu | [C: M-PL] |
| Ctrl+wheel | Horizontal zoom centred on the pointer | [C: M-PL] |
| Shift+wheel over track headers | Reorder tracks | [C: M-SC] |
| Shift+Alt+wheel over a clip | Nudge the clip by PPQ ticks (FL 2024+ default). FL ≤21: Shift+wheel nudged. The 2024.1 option "Nudge clips with mouse wheel" restores Shift+wheel | [C: M-SC], [C: M-OLD-SC], [C: M-N24] |
| Plain wheel | Vertical scroll [I] | [I] |
| Shift+wheel over the grid | Horizontal scroll [U] | [U] |
| Left-Shift+left-click | FL 2026: switch resize to ripple editing. FL 20-era (Draw mode): add a clip and resize it by moving left or right while held | [C: M-SC], [C: M-OLD-SC] |
| Right-Shift+left-drag | Slice (from any tool) | [C: M-SC] |
| Right-Shift+right-drag | Slice and delete the smaller part | [C: M-SC] |
| Alt+Right-Shift | Snap-free slice; release Alt after clicking to re-enable snap | [C: M-SC], [C: M-PL] |
| Right-Shift+drag the right edge of the rightmost selected clip | Rescale the positions of the selection (Alt = 25 % steps) | [C: M-PL] |
| Right-Alt+left-click | Mute | [C: M-SC] |
| Right-Alt+right-click | Quantize | [C: M-SC] |
| Magic lasso | With nothing selected, circling clips with the pointer (no click) selects them | [C: M-PL] |
| Right-click empty space | Deselects (and deletes under the pointer in Draw mode) | [C: M-PL] |

### 4.13 Resizing, slicing, slip and the clip "window" model

- A clip is a **window over its source**. Resized or sliced clips still hold the data outside their visible bounds [C: M-PL].
- **Resize the end**: drag the clip's right edge; the length snaps [C: M-PL].
  - The current manual says to hold Shift and drag the start or end in Draw/Paint mode [C: M-PL]. In practice a plain edge-drag with a resize cursor is the common behaviour [I].
  - FL 2026 adds separate cursors for resize vs stretch and a hold-A toggle for audio clips [C: CL 26.1 #21332, #21307].
- **Resize the start**: needs "Allow resizing from the left" (Ctrl+Alt+Home), and there must be source data left of the clip start [C: M-PL].
- **Automation clips** resize only from their title bar [C: M-PL].
- **Audio clips with Stretch on** (Shift+M): dragging an edge time-stretches using the channel's stretch settings. FL 2025.1+ makes the stretched clip a variant by default [C: M-PL].
- **Slip** (S tool): shifts content inside a fixed window [C: M-PL].
- **Ripple edit** (Shift+S, or the slip tool on an edge): moves the start or end while keeping the data at that edge by slipping the opposite end [C: M-PL].
- **Default length of a newly placed pattern clip** = the pattern's current length (§2.5).
  - Clips that were never resized follow the pattern when it changes length. FLP files store such clips with start/end offsets of -1, meaning "auto" [I: L-DEMO, X-PYFLP]. A recorded clip "expands to fit" [C: M-RS].
  - Painting after a resize reuses the new size [I: CL 21.2 #3628 "painting a new clip after resizing a clip doesn't use the new size" was fixed]. Picking the pattern again in the picker restores its natural length [C: X-F266478].
- **Pattern clip made longer than its pattern**: by default the region past the pattern's end is **empty and silent**. The pattern is not repeated [I, medium confidence].
  - Evidence: the window model above; a user report that the stretched part shows no notes [C: X-F18321, old]; a tutorial that clips loop when stretched only after enabling the Channel Rack loop mode [C: X-SLOOPLY].
  - With channel looping on (FL 20.1+), the channels keep looping inside the longer clip and the clip draws looped steps and a loop marker [C: CL 20.1 betas "playback of looping pattern clips", CL 21.2 #15933, CL 25.1.1 #20124].
  - Counter-evidence: several factory demos stretch 1-bar patterns to 4 or 5 bars, which would be odd if silent [C: L-DEMO]. **Mark as [U]; make it a per-project option in the clone.**
- **Audio clip made longer than its sample**: blank past the sample end [I].
- **Slice**: cuts a clip into two windows on the same source.
  - Project setting "Play truncated notes in clips" (default ON in templates [C: L-TPL]) keeps notes that cross the cut sounding in the second part [C: M-PGS].
  - Zero-cross (audio) moves cuts to zero crossings [C: M-PL].
- **Chop** (clip menu): split into bars or beats, Beat random; Dull / Medium / Sharp auto-slicing or Regions for audio. FL 21+ can also chop pattern and automation clips [C: M-PL], [C: M-N21].

### 4.14 Clip menu

The icon at the top-left of each clip opens it [C: M-PL]:

| Item | Types |
|---|---|
| Preview | all |
| Select source pattern/channel ▸ (Shift keeps the relative start/end) | all |
| Channel settings | audio, automation |
| Articulator tools ▸ (copy/paste state, flip vertically, scale levels, normalize, filter, smooth, turn all points smooth, analyze audio file, create sequence, focus on click) | automation |
| Edit pattern | pattern (Piano roll if it has data, else Channel Rack) |
| Rename and recolor / Change color | all |
| Make unique | all |
| Select all similar clips | all |
| Delete | all |
| Use current time signature | pattern |
| Region ▸ (select region) | |
| Chop ▸ | all (applies to all selected clips) |
| Sample ▸ (Make unique as sample, Edit sample E, Pitch correct P, Time-warp, Extract stems (21.2+), Deverb (2025.1+), Detect tempo, Fit to tempo) | audio |
| Automate ▸ (Volume, Pan, Crossfade with) | audio |

### 4.15 Playlist menu (summary)

[C: M-PL]
- **Edit**:
  - Cut / Copy / Paste (Ctrl+X/C/V; paste goes to the play position when possible, FL 21+ [C: M-N21]);
  - Duplicate (Ctrl+B; with no selection, all clips in the zoom range);
  - Delete (Del; with no selection, all clips);
  - Shift left/right by one snap unit (Shift+arrows); Shift up/down by one track;
  - Allow resizing from the left; Nudge clips with mouse wheel; Dropping on track header locks to content; Drop audio on track headers ▸;
  - Mute/Unmute; Insert space (Ctrl+Ins); Slice and insert space (Ctrl+Alt+Ins); Delete space (Ctrl+Del);
  - Merge pattern clips (Ctrl+G); Merge similar pattern clips (Shift+Ctrl+G); Merge automation clips (Ctrl+Alt+G);
  - Pitch selected audio clips -1 / +1 semitone (7 / 8) and Reverse (9) (FL 2025+); fade options.
- **Tools**: Quick quantize start times (Ctrl+Q / Shift+Q); Consolidate playlist selection ▸; Export all playlist tracks ▸; Export all playlist track groups ▸; Clone selected playlist track(s) (Shift+Ctrl+B).
- **View**: grid options, Time segments, Keep labels on screen, Content in title bars, Behind clips, Shadow, Resize all tracks, Hide collapsed grouped tracks, fade/gain previews, Incremental scrolling, Precise time indicator, Performance clip/track progress, Mini playlist preview ▸ (Enable, Double height, Show time markers), audio/instrument track controls and levels, Remove background picture (PNG images dropped on the Playlist become its background).
- **Snap**: §1.10.
- **Select**: Deselect (Ctrl+D), Select all (Ctrl+A), Select by selected source (Shift+C), Select muted, Select overlapping, Select stacked (2024.2+), Invert (Shift+I), Select time around selection (Ctrl+Enter), Select previous/next time (Ctrl+Left / Right).
- **Group**: Group (Shift+G), Ungroup (Alt+G). The toolbar Grouping switch enables or disables group behaviour.
- **Zoom**: §4.17.
- **Time markers**: §2.9.
- **Picker panel**: §4.6. **Edit patterns in** (2024.1.2+). **Quantize song jumps**. **Automation clips reset remote controls**.
- **Prepare for performance mode**; **Performance mode** (Ctrl+P).
- Macros: declicking, stretch modes, lock/unlock tracks to content, reset empty tracks, collapse/expand groups.
- **Center** (Shift+0); **Detached**.

### 4.16 Snap options

Same list as the global snap (§1.10), plus "Main" (use global) and "Events" (relative to existing clips; highlights neighbouring sliced events) [C: M-PL]. Default local value "Main" [U].

### 4.17 Zoom and scroll

- Horizontal: drag the horizontal scroll handle's edges; Ctrl+wheel at the pointer; PgUp / PgDn; Shift+1 to 3 quick zooms; Shift+4 zoom out far (show all); Shift+5 / 5 zoom to the time selection; Shift+6 / 6 fit the performance zone [C: M-PL], [C: M-SC]. Maximum zoom is limited by PPQ [C: M-PGS].
- Vertical: drag the track-height control (all tracks); drag dividers (one track) [C: M-PL].
- Shift+0 centres on the playhead [C: M-SC]. Auto scroll follows the playhead near the window edge; right-click on the button gives continuous scrolling [C: M-TB]. Adding a note or clip turns auto scroll off while editing [C: M-TB].
- "Incremental scrolling": clicking the scroll rail moves the view gradually instead of jumping [C: M-PL].

### 4.18 Track mute / solo semantics

- The track mute applies to all clips on that track [C: M-PL].
- Clip mute (Mute tool, Alt+M / Alt+Shift+M) is a separate per-clip flag. The track mute "has no effect on muted clips": a clip muted by the tool stays muted regardless of the track [C: M-PL].
- **Solo** (Ctrl+click or right-click the switch) mutes every other track; repeating it unsolos. With General settings › "Restore previous state after solo", the earlier mute pattern comes back on unsolo [C: M-PL], [C: M-GS].
- **Lock state** (Shift+click) exempts a track from solo changes [C: M-PL].
- **Groups**: Alt+left-click toggles mute and Alt+right-click toggles solo for the whole group [C: M-PL].
- Muted tracks still show their clips. FL 21.2.99 allows previewing clips on muted tracks [C: CL 21.2.99 #5465].
- Automation clips on a muted track do not drive their targets [I].

### 4.19 Playlist keyboard shortcuts

Single-key shortcuts work only while "Typing keyboard to piano" is off [C: M-SC].

| Key | Action |
|---|---|
| P / B / D / T / S / C / E / Z / Y | Draw / Paint / Delete / Mute / Slip / Slice / Select / Zoom / Playback tools |
| Alt (hold) | bypass snap |
| Backspace | toggle global snap Line / (none) |
| Del | delete selected clips |
| Insert | slice the clip at the pointer |
| Home | playhead to start |
| 5 / 6 / 7 / 8 / 9 | zoom on selection / zoom on performance clips / audio clip pitch -1 / +1 / reverse audio clip |
| Shift+0, Shift+1…3, Shift+4, Shift+5, Shift+6 | centre / zoom levels / show all / zoom to selection / fit performance zone |
| PgUp / PgDn | zoom in / out |
| Ctrl+A / Ctrl+D / Shift+I | select all / deselect / invert |
| Ctrl+C / Ctrl+X / Ctrl+V | copy / cut / paste |
| Ctrl+B | duplicate the selection to the right |
| Ctrl+Ins / Ctrl+Del | insert / delete time per the timeline selection |
| Ctrl+Enter, Ctrl+Left / Right | select time around the selection, shift the time selection |
| Ctrl+T / Alt+T | add an "Auto" time marker / add a named time marker |
| Shift+Alt+T | time signature marker |
| Shift+T | place a loop marker |
| Alt+M / Alt+Shift+M | mute / unmute the selection |
| Shift+G / Alt+G | group / ungroup |
| Shift+C | select all clips of the current source |
| Shift+M | toggle stretch mode (audio) |
| Shift+Q / Ctrl+Q | quick quantize clip start times |
| Shift+Left / Right, Shift+Up / Down | move the selection by one snap unit / one track |
| Ctrl+Alt+C, Ctrl+Alt+Shift+C | consolidate from the first clip / from song start |
| Ctrl+Alt+G | grid colour |
| Ctrl+Alt+Home | toggle resizing from the left |
| Ctrl+P | Performance mode |
| Alt+P | picker panel |
| Ctrl+F8 | project picker |
| Shift+Ctrl+B | clone selected tracks |
| Ctrl+Up / Down, Ctrl+Alt+Up / Down | select track / extend track selection |

Sources: [C: M-SC], [C: M-PL].

---

## 5. Browser

### 5.1 Layout, tabs, controls

- Docked at the left edge by default. It can dock right (drag its header), auto-hide (View option), or detach; "Hide while dragging (when detached)" option [C: M-BR].
- The divider can be dragged; right-click it to jump between two remembered widths [C: M-BR].
- Shift+wheel quick-zooms the font size [C: M-BR].
- Header: Browser menu (arrow), Collapse structure (Ctrl+Up), Refresh / reread (Ctrl+R), Minimise, Close (Alt+F8) [C: M-BR].
- **Tabs** (user-editable): All, Current project, Plugin database, online content, Starred [C: M-BR].
  - The online-content tab was "Library" from FL 21.0 [C: M-N21] and was renamed "Presets" in FL 2025.1 [C: M-N25].
  - FL Cloud **Sounds** tab added in 21.2 [C: M-N21].
  - Tab right-click: Rename / color / icon, Hide, Show hidden, Delete (user tabs), Clone this tab, Move left/right, Save search result as tab, View ▸ (zoom: Compact / Normal / Large / Huge / Massive; show only one folder open; icons, images, preview, inline waveform, extensions, unknown types; Frozen), Sort files by Name / Type / Date / Group, View layout Standard / Columns / Samples / Plugins [C: M-BR].
- **Search** (bottom by default; can move to the top) [C: M-BR]:
  - type filter, Any/All tag logic, TAGS panel, text field;
  - Ctrl+F advanced find (wildcards, AND/OR/NOT); Shift+F find in the selected folder; F2 / F3 previous / next match; Esc cancels;
  - Browser menu › Search options: Show parent folders, Expand folders, Search for folders, Type to filter, Enable indexing, Re-index changed folders on startup, Search FL Cloud.
  - Backspace / Shift+Backspace = navigation history back / forward.

### 5.2 Default folder list ("All" tab)

The All tab merges factory content (`<install>/Data/Patches/`) with the user data folder (`Documents/Image-Line/FL Studio/`). Folder names and tooltips below come from the FL 2026 install [C: L-PATCH] and the engine string table [C: L-BIN]. The FL 21/2024 set is the same apart from newer additions [I].

| Folder | Content (tooltip paraphrased) | Origin |
|---|---|---|
| Current project | patterns, automation, plugins, history of the open project (§5.4) | special |
| Recent files | recently used files | special [C: L-BIN] |
| Plugin database | favourite and installed plugins, sorted (Installed › Effects / Generators) | factory + user |
| Plugin presets | presets to drop on channels or effect slots | factory + user |
| Channel presets | channel states | factory + user |
| Mixer presets | mixer track states | factory + user |
| Scores | scores and automation (.fsc) | factory + user |
| Packs | sample packs: Drums, Drums (ModeAudio), FLEX, Instruments, **Legacy** (Drums / FX / Instruments / Loops / Vocals), Loops, Risers, SFX, Shapes, Vocals | factory (+ downloaded content) |
| Clipboard files | saved audio and MIDI clipboards | factory + user |
| Envelopes | for envelope and mapping editors | factory + user |
| Impulses | convolver impulses | factory |
| Misc | miscellaneous | factory |
| Soundfonts | for the Soundfont player | factory |
| Sliced beats / Sliced audio | files dragged out of Edison / Slicex | user |
| Recorded, Rendered | recordings, renders | user |
| Speech, Shapes, Channel envelopes, Chord progressions | various | user (some FL 2024+) [I] |
| Backup, Project bones, Templates | autosaves, exported bones, user templates | user (Projects) |
| My projects / Demo projects / IL shared data | projects | [C: L-BIN] names; exact visibility [U] |

- Custom folders come from File settings ("Browser extra search folders", up to 30) and appear in **green** [C: M-BR]. Dragging a folder from the OS file browser onto the Browser adds it [C: M-BR].
- By default no personal folders are included [C: M-BR].

### 5.3 Behaviour

- **Preview**: left-click an audio file plays up to 5 s unless "Full sample preview" is on or the preview player's Play is pressed [C: M-BR].
  - Alt+click plays to the end; Shift+click or right-click plays from the pointer position (FL 21+) [C: M-BR], [C: M-N21].
  - Stop on the transport ends a preview [C: M-BR].
  - Hovering shows BPM / Loop / Key / Sync controls for tagged samples (FL 2024+) [C: M-N24].
- **Drag and drop targets** [C: M-BR], [C: M-WF], [C: M-PLA]:

  | Drop on | Result |
  |---|---|
  | Channel Rack (empty area) | new Sampler channel, routed to Master ("---") [C: M-CR]; named after the sample when "Auto name channels" is on [C: M-GS] |
  | An existing channel that accepts samples | loads the sample into it |
  | Playlist grid | new Audio clip channel plus a clip at the drop point (snapped) |
  | Playlist track header | audio clip and track renamed, or audio/instrument track per the "Drop audio on track headers" option |
  | Mixer track (instrument or preset) | routes to that track; audio is added to the linked playlist track (Shift = sequential) |
  | Effect presets / plugins on mixer tracks or slots | load there |
  | Project files onto the desktop | open the project |
  | Main window buttons (Playlist / Channel Rack / Piano roll) | bring that window to the front while dragging [C: M-TB] |

  Holding Alt while dropping keeps the channel window closed [C: M-BR].
- **Send to**:
  - right-click › "Send to selected channel or focused plugin", "Open in new channel", "Open in new sampler / Granulizer / Slicer / Slicex channel", "Edit in audio editor / pitch corrector / time warper", Tags ▸, Favorite, Locate / Open parent folder, Delete file [C: M-BR];
  - middle-click loads the item onto the selected channel [C: M-BR];
  - Enter replaces the selected channel with the item; Ctrl+Alt+click does the same (21.0.3+) [C: M-SC], [C: M-N21].
- **Step through** files with Shift+Up / Down: each step sends the file to the selected channel or plugin, even during playback [C: M-BR].
- **Multi-select**: Shift+click; Ctrl+Alt+click [C: M-N21].

### 5.4 Current project folder

Sub-folders [C: M-BR]:
- **History**: undo list; click to jump to a step.
- **Patterns**: per-pattern automation, plus "Initialized controls".
- **Effects** and **Generators**: each lists every automatable parameter. Left-hold opens a quick control; right-click › Create automation clip / Edit events / Link to controller.
- **Remote control**: linked controls.
- **Initialized controls**: values set at song start; delete them here.
- **Samples** (FL 2024.2+).

---

## 6. Default template / new project

### 6.1 Which template

- Since FL 20.7 the default template is "Basic 808 with limiter" [C: CL 20.7 #8568]. It is the **Minimal › Basic with limiter** file [I: name match], described as a kick, clap, hi-hat and snare in a minimal 808 style with a limiter on the master [C: L-TPL .nfo].
- The default is changed in General settings › Default template. "Startup project" can be Empty project, Default template or Last used project [C: M-GS].
- FL 2024+ shows a Welcome window first (optional) [C: M-N24].

### 6.2 Contents

FLP files parsed from the FL 2026 install. "Basic" was last saved with **24.2.99** (an FL 2025 beta), "Basic with limiter" with **26.1** [C: L-TPL].

| Property | Basic with limiter (26.1 file) | Basic (24.2.99 file) | Empty templates (24.2.99) | FL 21/2024 default, best estimate |
|---|---|---|---|---|
| Tempo | 130 | 130 | 140 | 130 [I]; X-BONEDO (2017) also says 130 |
| Time signature | 4/4 | 4/4 | 4/4 | 4/4 |
| PPQ | 96 | 96 | 96 | 96 |
| Channels | 808 Kick, 808 Clap, 808 HiHat, 808 Snare (Samplers) + **808 Astronomic** (FLEX) | 808 Kick, 808 Clap, 808 HiHat, 808 Snare (Samplers) | one Sampler named "Sampler" (no sample) | 808 Kick, 808 Clap, 808 HiHat, 808 Snare [I] (FLEX channel probably added in 2025/26) |
| Samples | `%FLStudioFactoryData%\Data\Patches\Packs\Legacy\Drums\Dance\Basic 808 {Kick,Clap,HiHat,Snare}.wav` | same | none | same names [I]; folder may differ before FL 21's pack reorganisation [U] |
| Channel → mixer | inserts 1, 2, 3, 4 (FLEX → 5) | inserts 1 to 4 | Master | inserts 1 to 4 [I] |
| Channel colour | #5C656A (FLEX #485156) | | | [I] same |
| Master FX | **Emphasizer** in master slot 10 | none | none | a limiter on the master, most likely **Fruity Limiter** [I: template name; X-KVR294169 (2010) and a 2020 KVR thread report Fruity Limiter on the master of the default template]. Emphasizer only exists from FL 2025.2 [C: M-N25] |
| Patterns | none stored; Pattern 1 selected, empty | same | same | same |
| Playlist | arrangement "Arrangement", no clips, 500 tracks (#485156) | same | same | same |
| Play truncated notes in clips | on | on | on | on |
| Pan law | circular (0) | | | circular |
| Global swing | 0 | | | 0 |
| Mixer tracks stored | 18 (dynamic mixer, FL 2025+) | 18 | 18 | FL 21/2024: 125 inserts + Master + Current [C: M-N25] |

Notes:
- The channels' mixer target was read from a word event (id 104) present in 24.2.99+ files. Older files use a byte event (id 22) [C: X-PYFLP]. That 104 is the target is [I], from the 1 to 5 sequence and Master = 0 in the empty template.
- New channels added later through the Channel Rack go to Master by default [C: M-CR].

### 6.3 Startup window state

- Browser docked left and Channel Rack in the centre on first launch [C: X-PACKT, search-result summary only; weak].
- Playlist open behind the Channel Rack (filling the area right of the Browser); Mixer and Piano roll closed [U].
- Transport in Pattern mode [I]. Pattern 1 selected [C: L-TPL].
- Recommended clone default: Browser (left), Playlist (large), Channel Rack floating top-left over the Playlist, Mixer hidden, Piano roll hidden.

---

## 7. Global keyboard shortcuts

Windows key names. macOS: Ctrl → Cmd, Alt → Opt, Backspace → delete, Delete → fn+delete, Insert → fn+return [C: M-SC]. Shortcuts depend on the focused window; single keys need typing-to-piano off [C: M-SC].

| Keys | Action | Status |
|---|---|---|
| Space | play / stop | [C: M-SC] |
| Ctrl+Space | play / pause | [C: M-SC] |
| L | Pattern / Song mode | [C: M-SC] |
| R | record arm on/off (also during playback) | [C: M-SC], [C: M-OLD-SC] |
| Backspace | snap Line ↔ (none) | [C: M-SC] |
| Numpad 0 / * / / | fast forward / next bar / previous bar (Song) | [C: M-SC] |
| Numpad 1…9, Numpad + / - | pattern 1…9, next / previous pattern | [C: M-SC] |
| F2 | rename the selected pattern (or the focused item, e.g. mixer track); repeat = random colour | [C: M-SC] |
| F4 / Shift+F4 / Ctrl+F4 | next empty pattern (name dialog) / first empty / next empty without dialog | [C: M-SC], [C: M-PAT] |
| F1 | help | [C: M-SC] |
| F5 / F6 / F7 / F9 | toggle Playlist / Channel Rack / Piano roll / Mixer | [C: M-SC] |
| F8 / Ctrl+F8 / Shift+F8 | plugin picker / project picker / plugin database | [C: M-SC], [C: M-VIEW] |
| Alt+F8 | browser | [C: M-SC] |
| Alt+F7 | touch controller | [C: M-VIEW] |
| F10 | MIDI settings (settings window) | [C: M-SC] |
| F11 | project info | [C: M-SC] |
| F12 / Alt+F12 / Ctrl+F12 / Shift+F12 | close all windows / all plugin windows / unfocused windows / align channel editors | [C: M-VIEW] |
| Ctrl+F11 | hide toolbar | [C: M-VIEW] |
| Enter | Playlist maximise ↔ restore | [C: M-SC] |
| Esc | close the focused window | [C: M-SC] |
| Tab | cycle windows | [C: M-SC] |
| Ctrl+Shift+H | arrange (realign) windows | [C: M-SC] |
| Ctrl+S / Ctrl+Shift+S / Ctrl+N / Ctrl+O | save / save as / save new version / open | [C: M-SC] |
| Alt+0…9 | open recent file | [C: M-SC] |
| Ctrl+R / Ctrl+Shift+R / Ctrl+Shift+M | export WAV / MP3 / MIDI | [C: M-SC] |
| Ctrl+Z | undo/redo toggle of the last step (classic). With "Alternate undo mode" (on by default on fresh FL 21+ installs [C: M-N21]) it steps back through history | [C: M-EDIT], [C: M-GS] |
| Ctrl+Alt+Z | undo step by step (backwards) | [C: M-SC] |
| Ctrl+H | stop all sound (panic) | [C: M-SC] |
| Ctrl+M / Ctrl+P / Ctrl+I / Ctrl+B / Ctrl+E / Ctrl+T / Ctrl+J | metronome / count-in / wait for input / blend / step edit / typing keyboard / multilink. In the Playlist, Ctrl+P = performance mode, Ctrl+B = duplicate, Ctrl+T = add marker | [C: M-SC], [C: M-OPT] |
| Ctrl+F | browser find | [C: M-TOOLS] |
| Alt+Enter | show/hide OS taskbar / Dock | [C: M-TB] |
| Alt+F4 | exit | [C: M-TB] |
| Alt+F1 | Gopher (FL 2025+) | [C: M-HELP] |
| Ctrl+Cmd+F | macOS full screen (FL 2024.2+) | [C: M-N24] |
| Alt+Numpad 2…6 | typing-keyboard octave (FL 21+) | [C: M-SC], [C: M-N21] |

---

## 8. Control conventions

### 8.1 Knobs and sliders

[C: M-UI] unless noted

| Gesture | Effect |
|---|---|
| Left-drag up/down (knobs, vertical sliders) or left/right (horizontal sliders) | change value |
| Ctrl+drag, or drag with **both** mouse buttons held | fine adjustment |
| Shift while adjusting | disable "snapping" (controls pause at default and other useful values) |
| Alt+left-click | reset to default |
| Middle-click | reset to default |
| Mouse wheel | step the value [I]; FL 21 mentions mouse-wheel precision for some controls [C: M-N21]. Shift+wheel / Shift+drag give finer steps on some plugin controls [U] |
| Right-click | control menu (§8.4) |
| Hover | hint shows the name and current value (§8.6) |

- Values can be shown as %, 0 to 1, or context units (dB, Hz, cents, ms) [C: M-UI].
- Undo of knob tweaks is off by default (General settings › Undo knob tweaks) [C: M-GS].

### 8.2 LCD number displays (tempo, pattern number, mixer track selector, and so on)

- Drag up/down like a wheel [C: M-UI].
- Hover the top or bottom edge for an increment or decrement cursor; click steps by one [C: M-UI].
- Left-click and hold, then type digits [C: M-UI]. The FL 20 manual limits this to "red LCD controls" [C: M-OLD-UI].
- Right-click › Type in value… [C: M-TB].

### 8.3 Switches and LEDs

- Mute LEDs (Channel Rack, Playlist tracks): lit = active. Click toggles mute; Ctrl+click or right-click solos; Alt+click acts on the group; Shift+click locks [C: M-CR], [C: M-PL].
- Toolbar toggle buttons: lit when on. FL 2024 shows the pressed state on hover [C: M-N24].
- "Flat buttons" removes 3-D shading [C: M-TB].

### 8.4 Control right-click menu

Item labels come from the engine string table [C: L-BIN]. The set is confirmed by M-TOOLS (Last tweaked), M-TB (tempo "usual automation controls") and M-UI (Type in value, Set, reset). Order is [I].

| Item | Effect |
|---|---|
| (title: parameter name) | [I] |
| Edit events | open the event editor for this parameter in the current pattern |
| Edit events in new window / Edit events in piano roll | when an editor is already open |
| Init song with this position | store the current value as the value at song start (applies after Stop, Play) |
| Delete initial value | remove that initialisation |
| Create automation clip | new automation clip linked to the control; also initialises it [C: M-PLAUTO]. With a time selection the clip covers only that range, otherwise the whole song [C: M-PLAUTO]. FL 21.2+ creates it at the playback position when "Create automation clips at the playback position" is on [C: M-GS], [C: M-N21] |
| Link to controller… | Remote control settings dialog (a MIDI CC moved now links automatically; internal controllers listed) |
| Override global link… | permanent link |
| Copy value / Paste value | |
| Type in value… | numeric entry (§8.5) |
| Set… | larger control for precise adjustment |
| Reset (where offered) | default value |

Multilink and Last-tweaked versions of these act on several controls (§1.13).

### 8.5 Type in value dialog

- Choose the unit category: context-aware (the control's own units) or normalised (0 to 1 / %) [C: M-UI].
- FL 21.0 shows more information about the current value [C: M-N21].
- FL 2025.2.1 converts a typed comma into a period [C: M-N25].
- Tempo accepts real BPM; master pitch takes Hz for A [C: M-TB].

### 8.6 Hint bar message format

From the manual [C: M-TB]:
- On hover, the hint shows the control's short name; while adjusting, it shows the value.
- Hovering a knob or slider also shows its current value. Changelog bugs fixed cases where "no value is displayed in the hint bar when hovering" [C: CL 2024.2.2 #19038], [C: CL 24.2.99 #19746].
- Capability icons sit at the right (§1.4).
- Right-click on a control lets you copy its value.

Internal markup observed in the FL 2026 engine string table [C: L-BIN], decoded [I]:

| Element | Markup | Example |
|---|---|---|
| Help-topic id | `^?NNN^` | `^?171^` before "Tempo" |
| Capability icons | `^b` (automatable), `^a` (linkable), `^d` (right-click menu) | `^b^aMaster pitch` |
| Badge (shortcut or value) | `^^TEXT^` | `^^Space^Play / pause`, `^^%d%%^Point %d to %d tension` |
| Left / right-click actions | text separated by ` / ` | `Playlist / Maximize Play list` (left opens, right maximises) |

Real hint texts [C: L-BIN]:

| Control | Hint text | Badge | Icons |
|---|---|---|---|
| Main volume | Main volume | | right-click |
| Master pitch | Master pitch | | automatable, linkable |
| Tempo | Tempo | | automatable, linkable |
| PAT/SONG switch | Pattern or song mode / Show channel rack or playlist | L | |
| Play | Play / pause | Space | |
| Stop | Stop | Space | |
| Record | Record | R | right-click |
| Pattern selector | Pattern selector | +- | right-click |
| New pattern button | New pattern (find first / next empty) | | right-click |
| Global snap | Main snap / quantization / step edit step | BkSp | right-click |
| Song position | Song position | | right-click |
| CPU panel | CPU load / Memory usage / Polyphony | | |
| View Playlist | Playlist / Maximize Play list | F5 | right-click |
| View Piano roll | Piano roll / Maximize Piano roll | F7 | right-click |
| View Channel rack | Channel rack | F6 | |
| View Mixer | Mixer | F9 | |
| View Browser | Browser / Plugin picker | Alt+F8 | right-click |
| Plugin picker | Plugin picker / Project picker | F8 | right-click |
| Undo | Undo / Undo history | Ctrl+Z | right-click |
| Save as | Save as... / Save new version | Ctrl+Shift+S | right-click |
| Render | Export > Wave file... / MP3 file... | Ctrl+R | right-click |
| Typing keyboard | Typing keyboard to piano | Ctrl+T | |
| Step edit | Step edit | Ctrl+E | |
| Multilink | Multilink to controllers | Ctrl+J | |
| Metronome | Metronome | Ctrl+M | |
| Count-in | Recording precount | Ctrl+P | |
| Wait for input | Start on input | Ctrl+I | |
| Blend | Blend recorded notes | Ctrl+B | |
| Track mute | Mute / solo | | automatable, linkable |

Recommended clone rendering [I]: plain text left; badge as a small boxed label after the text; icons right-aligned; on value change, update the badge or text with the formatted value plus units (for example `78%`, `-5.2 dB`, `130.000 BPM`, `+0 cents`). The idle hint line shows the project title, or the file name if there is no title.

### 8.7 Menu conventions

- Checkable items can be right-clicked to toggle without closing the menu [C: M-UI].
- Menus show shortcuts next to items. Accelerators are marked with & in the string table (for example `&Edit events`) [C: L-BIN].
- F-key help: clicking a menu image in the manual opens help; F1 opens help [C: M-HELP].

---

## 9. Version differences relevant to the clone

| Area | FL 20.x | FL 21 | FL 2024 | FL 2025 / 2026 |
|---|---|---|---|---|
| Toolbar default | similar 2-rack layout | same as 2024 [I] | 2-rack "Default" (§1.2) [C: L-TBP] | slimmer default without volume, pitch or song-position slider; 2026 adds chord panel, Gopher, touch modifier keys |
| Play button second click | pause [C: M-OLD-TB] | pause [I] | pause [I] | manual says stop and rewind [C: M-TB] (binary still says Play / pause) |
| Time panel | B:S:T / M:S:CS | same | 2024.2 adds SMPTE [C: M-N24] | same |
| Markers | Punch in/out | renamed Start/Stop recording [C: M-N21] | same | same |
| Playlist add-track "+" | no | yes (21.0) [C: M-N21] | yes | yes |
| Audio clip fades / gain handles | no | yes (21.0) [C: M-N21] | yes | yes; clip variants and properties (2025.1) [C: M-N25] |
| Paste at playhead | no | yes (21.0) | yes | yes |
| Alt+double-click pattern clip → Channel Rack | Shift+double-click | Alt (21.2) [C: M-N21] | Alt; "Edit patterns in" (2024.1.2) [C: M-N24] | same |
| Clip nudge wheel | Shift+wheel [C: M-OLD-SC] | Shift+wheel [I] | Shift+Alt+wheel default, option to restore [C: M-N24] | same |
| Make unique drag (Shift+V) | no | no | yes [C: M-N24] | yes |
| Slice tool | free-direction line | same | same | vertical by default, Left-Shift diagonal [C: M-N25] |
| Browser online tab | Content Library | Library (21.0); Sounds / FL Cloud (21.2) [C: M-N21] | same | Library renamed Presets [C: M-N25] |
| Mixer inserts | 125 | 125 | 125 | dynamic up to 500 [C: M-N25] |
| Welcome window | no | no | yes [C: M-N24] | redesigned |
| Default template master FX | Fruity Limiter [I] | Fruity Limiter [I] | Fruity Limiter [I] | Emphasizer (25.2+) [C: L-TPL], [C: M-N25] |
| Alternate (classic) undo default | off | on for new installs [C: M-N21] | on | on |
| Automation clip placement | song start | playback position option (21.2) [C: M-N21] | same | same |

---

## 10. Open questions and recommended clone defaults

| # | Question | Evidence | Recommended clone behaviour |
|---|---|---|---|
| 1 | Pattern clip stretched past its pattern: silence or repeat? | Window model and forum/blog suggest silence unless channel looping is on; demos with 1→4-bar stretches suggest repeats | Implement both: per-project flag "Channel looping" off = silent, on = repeat. Default off |
| 2 | "Remember seek time" default | forum reports | On: stop returns to where play began; stop again → bar 1 |
| 3 | Play button second click | old manual says pause, new manual says stop+rewind | Pause (FL 21/2024) |
| 4 | Default global snap / Playlist local snap | Backspace toggles Line/none; IL recommends Line | Global = Line; Playlist and Piano roll local = Main |
| 5 | Main volume default | 125 % max = +5.6 dB | 100 % (0 dB) |
| 6 | Song end rounding | bar-oriented UI | Round the last clip end up to the next bar; minimum 1 bar |
| 7 | Time panel default mode | | B:S:T, start reads `1:01:00` |
| 8 | Default windows at startup | weak | Browser left, Playlist large, Channel Rack floating, Mixer and Piano roll hidden |
| 9 | FL 21/2024 template master plugin, slot and sample paths | template name and old reports | 4 × 808 samplers → inserts 1 to 4; limiter on master; 130 BPM |
| 10 | Pattern clip content colour mode default | | "Note" (notes in note colour on a pattern-coloured clip) |
| 11 | Plain mouse wheel / Shift+wheel in the Playlist grid | | wheel = vertical scroll; Shift+wheel = horizontal scroll; Ctrl+wheel = zoom |
| 12 | Default Playlist tool | | Draw (P) |
| 13 | Clone pattern numbering | | insert after, renumber following patterns, unique name `Name #2` |
| 14 | Exact control right-click menu order | | order of §8.4 |

---

## 11. Appendix A: data-model notes taken from FLP files

Read from the factory templates and demos; field semantics follow PyFLP plus own observation [I].

- **Project**: tempo (BPM × 1000 as an integer), main pitch (cents), time signature (numerator / beat), PPQ in the file header, selected pattern, "loop active" (a time selection exists), pan law, "play truncated notes".
- **Pattern**: index (1-based), name, colour, notes (position, length, channel, key, …; steps are zero-length notes), event automation, optional explicit length (0 / absent = auto), looping flags for channel looping.
- **Playlist item (clip)**: position (ticks), length (ticks), track (stored reversed, 499 = track 1), source (pattern index offset by 20480, or channel index for audio/automation clips), flags (0x2000 appears on muted clips [I]), group id, **start offset / end offset** in source ticks (-1 / -1 = auto window that follows the source length; explicit values after slicing or resizing; examples: a slice at tick 89 of a 384-tick pattern gives offsets 89 to 384 and length 295).
  - Item record size: 32 bytes up to FL 20, 60 in FL 21 to 24, 240 in FL 2025+ files.
- **Track**: index, colour (default #485156), height multiplier (1.0), name (empty = `Track N`), flags.
- **Arrangement**: name ("Arrangement"), its clips, its tracks, time markers.
- **Channel**: type (Sampler, plugin generator, audio clip, automation clip, layer), name, colour, sample path, mixer target, plugin data.

Suggested clone model [I]:

```
Clip = { id, trackIndex, position, length, sourceType, sourceId, startOffset|auto, endOffset|auto, muted, groupId, colorOverride? }
```

When `auto`, `length = pattern.length(lengthBars × ticksPerBar)`, recomputed when the pattern changes.

---

## 12. Sources

Official manual pages: canonical `https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/<page>.htm`, read 2026-10-17 through the identical mirror `https://cluster.image-line.com/...`.

| Key | Page |
|---|---|
| M-TB | toolbar_panels.htm (incl. toolbar screenshot image map) |
| M-TE | toolbar_edit.htm |
| M-UI | basics_interface.htm |
| M-SC | basics_shortcuts.htm |
| M-MENU | menu.htm / menu_panel.htm |
| M-FILE | menu_file.htm |
| M-EDIT | menu_edit.htm |
| M-ADD | menu_add.htm |
| M-PAT | menu_patterns.htm |
| M-VIEW | menu_view.htm |
| M-OPT | menu_options.htm |
| M-TOOLS | menu_tools.htm |
| M-HELP | menu_help.htm |
| M-PGS | songsettings_settings.htm |
| M-PL | playlist.htm (incl. image map) |
| M-PLP | playlist_patterns.htm |
| M-PLA | playlist_audioclip.htm |
| M-PLAUTO | playlist_automationclip.htm |
| M-BR | browser.htm |
| M-CR | channelrack.htm |
| M-PR | pianoroll.htm, pianoroll_menu.htm |
| M-GS | envsettings_general.htm |
| M-AS | envsettings_audio.htm |
| M-WF | basics_workflow.htm |
| M-RS | recording_scores.htm |
| M-RA | recording_automation.htm |
| M-AI | automation_internal.htm |
| M-API | midi_scripting.htm (snap constants, song-length modes, transport command ids, pattern length API) |
| M-N20 / M-N21 / M-N24 / M-N25 | basics_new_20.htm / basics_new_21.htm / basics_new_24.htm / basics_new_25.htm |
| M-OLD-TB / M-OLD-PL / M-OLD-SC / M-OLD-UI | older FL 20-era English snapshot: `https://www.image-line.com/fl-studio-learning/fl-studio-online-manual-de/html/` toolbar_panels.htm / playlist.htm / basics_shortcuts.htm / basics_interface.htm |
| CL | full change log `WhatsNew.htm` (local: `/Applications/FL Studio 2026.app/Contents/Resources/FL/Help/WhatsNew.htm`; online: `.../fl-studio-online-manual/html/WhatsNew.htm`), cited as version + bug id |

Local install evidence (FL Studio 2026, 26.1.x, read only):

| Key | File(s) |
|---|---|
| L-TPL | `/Applications/FL Studio 2026.app/Contents/Resources/FL/Data/Templates/Minimal/{Basic with limiter,Basic,Empty}/*.flp`, `.../Templates/Empty/Empty.flp` and `.nfo` descriptions (parsed with a custom FLP event dumper) |
| L-TBP | `.../FL/System/Config/Toolbar presets/*.tpr` (FL Studio 24 (Windows), FL Studio 24 (macOS), FL Studio 25 (Windows), Default, FL Studio 12, Default (hint above menu), Compact, Single line) |
| L-BIN | UI strings of `/Applications/FL Studio 2026.app/Contents/Libs/FLEngine_x64.dylib` (menu labels, hint texts, time-display labels, tempo presets, default names) |
| L-PATCH | `.../FL/Data/Patches/` folder tree and `.nfo` tooltips; `~/Documents/Image-Line/FL Studio/` sub-folders |
| L-NCP | `.../FL/System/Config/Note color presets/Default.ncp` (16 note colours; colour 1 = #9ED1A5) |
| L-DEMO | `.../FL/Data/Demo projects/**/*.flp` (pattern auto-length and clip offset examples) |

Community and third-party sources:

| Key | URL |
|---|---|
| X-PYFLP | https://github.com/demberto/PyFLP (project.py: tempo limits, VALID_PPQS, main pitch/volume; pattern.py: default colour; arrangement.py: playlist item layout; channel.py) |
| X-STUBS | https://il-group.github.io/FL-Studio-API-Stubs/midi_controller_scripting/tutorials/time_units/ |
| X-F190640 | https://forum.image-line.com/viewtopic.php?t=190640 (FL 20, 2018: song mode cannot stop at end) |
| X-F239007 | https://forum.image-line.com/viewtopic.php?t=239007 (2020: Remember seek time on = back to start position; off = back to 0) |
| X-F321104 | https://forum.image-line.com/viewtopic.php?t=321104 (2023 to 2025: stop now returns to 0; fix = enable Remember seek time) |
| X-F266478 | https://forum.image-line.com/viewtopic.php?t=266478 (2021: clip length resets when picked again from the picker) |
| X-F18321 | https://forum.image-line.com/viewtopic.php?t=18321 (old: stretched pattern clip shows empty) |
| X-SLOOPLY | https://slooply.com/blog/how-to-loop-patterns-infinitely-in-fl-studio-loop-all-steps/ |
| X-KVR317373 | https://www.kvraudio.com/forum/viewtopic.php?t=317373 (note crossing into the next bar extends the pattern by a bar; events count) |
| X-KVR294169 | https://www.kvraudio.com/forum/viewtopic.php?t=294169 (2010: Fruity Limiter on master of default templates) |
| X-BONEDO | https://www.bonedo.de/artikel/fl-studio-step-programmierung-workshop-2/ (2017: "Basic with Limiter", four sampler channels, 130 BPM) |
| X-PACKT | https://www.packtpub.com/en-fi/product/a-power-users-guide-to-fl-studio-21-9781803234380 (search-result summary only: Browser left, Channel Rack centre) |
