# FL Studio Automation (Automation Clips, Event Automation, Recording): Implementation Spec (Research)

Target behaviour: **FL Studio 21.x and FL Studio 2024 (24.x)**. Where FL 20 or FL 2025/2026 differ, this is called out inline and summarised in §12.
Compiled 2026-10-17. Research only; no code. Formulas are given in plain maths notation.

**Sources, in order of weight**

1. The official FL Studio online manual (the current edition documents FL Studio 2026). Canonical URLs are `https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/<page>.htm`. Because `www.image-line.com` resolves to 127.0.0.1 on this machine, the identical pages were read from Image-Line's mirror host `cluster.image-line.com` (same path). An older English snapshot of the automation-clip page (pre-20.9: no target-links panel yet) under `.../fl-studio-online-manual-de/html/` was used for cross-checks (key prefix `M-OLD-`). Four screenshots embedded in the manual were downloaded from the mirror and viewed (key `L-IMG`).
2. The local FL Studio 2026 (26.1.x) install, read only, nothing executed, nothing copied into the repo:
   - the bundled change log `WhatsNew.htm` (bug/feature ids back to FL 3), key `CL`;
   - the UI form resources and string table embedded in `Contents/Libs/FLEngine_x64.dylib`. The program is written in Object Pascal, so its windows, menus, control ranges and default values are stored as binary form resources. These were decoded offline (keys `L-DFM` for forms and menus, `L-STR` for strings);
   - static disassembly of the arm64 code of the same library, limited to the envelope maths: the segment evaluator, the per-point precompute, the step-count helper and the formula-language `Tension()` function (key `L-CODE`, with addresses for build 26.1.x);
   - all 164 bundled demo and template projects (`Data/**/*.flp`), parsed with a small event dumper to confirm storage formats, defaults, naming and colours (key `L-DEMO`).
3. Community sources: PyFLP and DawVert (open-source FLP parsers; automation structs, controller addressing), Image-Line forum threads, and a 2009 tutorial blog.

**Caveat on binary-derived facts.** `L-DFM`, `L-STR` and `L-CODE` come from FL 2026. Projects saved by FL 12.3 already use all 13 point modes, and the current manual's point-menu screenshot (FL 2024/2025 era) shows exactly the same 13-item menu. The curve maths is therefore assumed unchanged for FL 21/2024 [I].

**Status tags**

| Tag | Meaning |
|---|---|
| **[C: KEY]** | Confirmed by source `KEY` (resolved in §14). |
| **[I]** | Inferred from confirmed facts, file data or consistent indirect evidence. The reasoning is given where it is not obvious. |
| **[U]** | Uncertain, conflicting or undocumented. A recommended clone default is given (also listed in §13). |

Version shorthand: FL 21 = 21.0 to 21.2.x; FL 2024 = 24.1 to 24.2.x; FL 2025 = 25.x; FL 2026 = 26.1.x.

---

## 0. Quick reference

| Item | Value | Status |
|---|---|---|
| Automation sources | Automation clips (Playlist, song mode only), event automation (stored per pattern), initialized values ("init song"), controller links (MIDI or internal controllers) | [C: M-PLAUTO, M-EE, M-AI, M-BR] |
| An automation clip is… | a **channel** of type "Automation clip" in the Channel Rack (holds the envelope, MIN/MAX, LFO, target links), plus any number of Playlist clip instances that play it | [C: M-PLAUTO], type id 5 [C: M-API, X-PYFLP] |
| Point fields | time offset from the previous point (double, in quarter notes), value 0…1 (double), tension −1…+1 (float), mode 0…12, a selected flag and a cached tension-sign byte | [C: L-DEMO, X-DAWVERT] |
| Segment owner | The **right-hand** point of a segment owns its mode and tension. The first point's mode and tension are ignored | [C: M-PLAUTO, L-CODE] |
| Point modes (menu order) | Smooth, Hold, Single curve, Single curve 2, Single curve 3, Double curve, Double curve 2, Double curve 3, Half sine, Stairs, Smooth stairs, Pulse, Wave | [C: L-DFM, L-IMG] |
| Default mode / tension | Single curve, 0 (straight line) | [C: M-PLAUTO]; tension default [I] |
| Single curve | t<0: `S(u) = (10^(6·abs(t)·u) − 1)/(10^(6·abs(t)) − 1)`; t>0: `S(u) = 1 − S_{−t}(1 − u)`; t=0: `S(u) = u` | [C: L-CODE] |
| Step / cycle count (Stairs, Smooth stairs, Pulse, Wave) | `N(t) = round((10^(6·(1 − 0.6·abs(t))) − 1)/1000)`: 1000 at t=0, 16 at \|t\|=0.5, 0 at \|t\|=1 | [C: L-CODE] |
| New clip from a control | Linked to the control. The control is "initialized" (current value stored for song start). The envelope starts as a flat line at the current value | [C: M-PLAUTO]; flat line [C: X-THUNTER]; point count [I] |
| Placement of new clip | Start: the playback position (FL 21.2+, option on by default) or song start. Span: the time selection if any, otherwise the song length. Track: a sub-track of the instrument track if instrument tracks are used, otherwise the topmost empty track visible | [C: M-PLAUTO, M-GS, CL 21.2 #16143/#16457, L-DFM]; "topmost" [I] |
| MIN / MAX defaults | 0% / 100%. Tempo clips: 60–180 BPM. Channel-pitch clips: ±1200 cents | [C: L-DEMO, CL 9.5] |
| After the last point | value holds | [C: L-CODE], [C: X-F17483] |
| Before the first clip | the initialized ("init song") value applies from song start; otherwise the control keeps its current value | [C: M-PLAUTO, M-BR], rest [I] |
| Pattern mode | Playlist clips do not play. Event automation in the playing pattern does | [C: M-TB, M-RA] |
| Manual tweak while playing | FL 21/2024: the clip stops driving that control until playback is restarted. FL 2026 adds a Playlist option "Automation clips reset remote controls" | [C: M-N26, M-PL, CL 26.1 #21233] |
| Relocating (clicking the ruler, stopping) | Clip values are chased to the new position | [C: CL 12.3, CL 5.0.1]; details [I] |
| Recording | Into the **selected pattern** as event automation, in both pattern and song mode | [C: M-RA] |
| Channel Rack | New automation channels go into the built-in filter group "Automation" | [C: L-DEMO, CL 12.9.2] |

---

## 1. Model and terminology

### 1.1 Automation sources

| Source | Lives in | Plays when | Edited in | Status |
|---|---|---|---|---|
| Automation clip | Its own channel (Channel Rack), instanced as Playlist clips | Song mode, when the playhead is inside a clip instance; or when the channel is triggered by notes or steps | Playlist (inline) and the clip's channel settings window | [C: M-PLAUTO] |
| Event automation | One data set per (pattern, target) | Whenever that pattern plays, in pattern or song mode | Event Editor, or the lower lane of the Piano roll | [C: M-EE, M-RA] |
| Initialized value | Project-level list ("Initialized controls") | At song start | Control menu: Init song with this position / Delete initial value; Browser > Current project > Patterns > Initialized controls | [C: M-PLAUTO, M-BR, M-TOOLS] |
| Controller link | Remote-control link records | Continuously, when the source moves | Remote control settings dialog | [C: M-AI] |

An automation clip is an **internal controller**. Once it exists it is listed as an internal-controller source in every control's "Link to controller" dialog. One clip can drive several targets, and several clips can drive one target [C: M-PLAUTO, M-AI].

### 1.2 Automation clip object

| Field | Meaning | Default | Status |
|---|---|---|---|
| Envelope | ordered list of points (§1.3); at least 2 points | — | [C: L-STR] ("The automation envelope must have at least two points") |
| MIN, MAX | output re-ranging: `out = MIN + (MAX − MIN)·env`. The Playlist display is not affected | 0%, 100% | [C: M-PLAUTO], defaults [C: L-DEMO] |
| TIME (+ multiplier digit) | playback-speed control | TIME centred (no change) | [C: M-PLAUTO, L-IMG]; mapping [U] |
| LFO block | LFO switch, SPD, TNS, SKEW, PW, AMT, MUL (§5.7) | LFO off; AMT +50% | [C: M-PLAUTO, L-DFM] |
| Target links | list of linked parameters, each with its own mapping formula and smoothing | the creating control | [C: M-PLAUTO, M-AI] |
| Name, colour, icon | channel properties | §2.5 | [C: L-DEMO] |
| ON switch | channel enable | on | [C: L-IMG] |

### 1.3 Envelope point

| Field | Storage | Range / units | Status |
|---|---|---|---|
| Time | difference from the previous point, as a double | quarter notes (beats). The first point is at 0. Zero differences are allowed and give a vertical jump | [C: L-DEMO, X-DAWVERT]. Zero-length segments occur in factory projects that automate switches [C: L-DEMO] |
| Value | double | 0.0 … 1.0, relative to the clip's MIN…MAX | [C: X-PYFLP, L-DEMO] |
| Tension | float32 | −1.0 … +1.0 (the UI shows a percentage) | [C: L-DEMO] (values such as −1.0, −0.055, 0.7208 occur); % display [I from L-STR] |
| Mode | uint16 | 0…12 (§4.2) | [C: L-DFM, L-DEMO, X-DAWVERT] |
| Selected | uint8 | 0/1 (always 0 in saved files) | [C: X-DAWVERT, L-DEMO] |
| Tension sign | int8 cache | −1, 0, +1, or 2 = "evaluate as straight line" (§4.3). Recomputed by the program, so a clone may recompute it | [C: L-CODE, L-DEMO] |

### 1.4 Segments

- Segment *i* runs from point *i−1* to point *i*. Its curve mode and tension are those of **point i** (the right-hand point). The manual says the same thing as a gesture: right-click the right-most point of a segment to change its curve [C: M-PLAUTO, L-CODE].
- Value inside the segment: `v(t) = v_{i−1} + (v_i − v_{i−1}) · S_mode(u)`, where `u = (t − t_{i−1}) / (t_i − t_{i−1})` runs from 0 to 1 [C: L-CODE].
- After the last point the value stays at the last point's value [C: L-CODE].

### 1.5 Event automation data

- Per pattern and per target: a list of (tick position, integer value) events, stored in the target's native integer units (e.g. 0…12800 for volumes, BPM×1000 for tempo) [C: L-DEMO, X-DAWVERT].
- A pattern may hold any number of event data sets [C: M-EE].
- Values hold from one event to the next. Ramps are many closely spaced events (live recording writes one event per PPQ tick, e.g. 384 per bar at 96 PPQ) [C: M-RA].

### 1.6 Initialized controls

- A project-level list of (target, value) pairs giving the control's value **at song start** [C: M-BR, M-GS].
- Created automatically when an automation clip is created from a control's menu (if "Initialize controls automatically" is on; default **on**), or manually with *Init song with this position* [C: M-PLAUTO, M-GS, L-DFM].
- All recorded automation also appears in the Initialized controls folder [C: M-BR].
- Typical symptom of a stale init value: a control jumps to a fixed position every time Play is pressed, for example after its automation clip was deleted [C: M-BR].
- Removal: control menu *Delete initial value*, or Browser entry > *Delete event* [C: M-BR, M-PLAUTO].

---

## 2. Creating automation clips

### 2.1 Entry points

| Method | Steps | Notes | Status |
|---|---|---|---|
| Native control menu | Right-click a native FL / Image-Line plugin control > **Create automation clip** | Most common | [C: M-PLAUTO] |
| Last tweaked | Move any control (including a VST/AU parameter), then **Tools > Last tweaked > Create automation clip**. *Next to last tweaked* acts on the control before that | Not every plugin reports "last tweaked" | [C: M-PLAUTO, M-TOOLS, L-DFM] |
| Multilink | Turn on the Multilink switch, tweak several controls, right-click the switch > **Create automation clips** | One clip per tweaked control | [C: M-TB, L-DFM] |
| Browser | Browser > Current project > Generators / Effects > plugin > right-click a parameter > Create automation clip | Fallback for plugins that do not report tweaks | [C: M-PLAUTO, M-BR] |
| Add menu | **Add > Automation for last tweaked parameter** | | [C: M-ADD, L-DFM] |
| From events | Event Editor > Edit > **Turn into automation clip…** (§8.6) | | [C: M-EE, L-DFM] |
| Audio clips | Clip menu > **Automate > Volume / Pan / Crossfade with** | The new clip is placed over the audio clip. Crossfade makes a single clip inversely linked to both clips (formulas `0.5*Tension(Input,10)` and `0.5-0.5*Tension(Input,-10)`, §4.7) | [C: M-PLAUTO, M-PL]; formulas [C: L-STR] |

### 2.2 Control right-click menu (exact items and order)

The order is from the decoded menu resource. Context-specific items are hidden at run time (for example the BPM presets appear only on the tempo control) [C: L-DFM]; hiding rules [I].

| # | Item | Notes |
|---|---|---|
| 1 | Reset | default value |
| 2 | (Truncate swing notes / Set ▸ step presets / Load oscillator shape… / Solo / Lock active/mute state) | context items |
| 3 | — **Automation** — (header) | |
| 4 | Edit events | Event Editor for this target in the selected pattern |
| 5 | Edit events in new window | |
| 6 | Edit events in piano roll | |
| 7 | Init song with this position | |
| 8 | Delete initial value | |
| 9 | — (separator) | |
| 10 | Create automation clip | |
| 11 | Edit automation clip… | FL 20.9+. Opens the linked clip's editor. If several clips are linked, a "Choose a clip" dialog appears [C: CL 20.9 #10119, L-STR] |
| 12 | — **Remote control** — | |
| 13 | Link to controller… | Remote control settings dialog |
| 14 | Override global link… | |
| 15 | — **Value** — | |
| 16 | Copy value / Paste value | compatible with point Copy/Paste value [C: CL 9.5] |
| 17 | Type in value… | |
| 18 | Set… | |
| 19 | (Tap tempo, 80…160 BPM presets, Half speed, Assign to free mixer track) | context items |

The **Tools > Last tweaked** submenu shows the last tweaked parameter's name as its title and offers: Edit events (also in a new window or in the Piano roll), Init song with this position, Delete initial value, Create automation clip, Link to controller, Copy/Paste value, Override volatile link [C: M-TOOLS].

The **Multilink** right-click menu: header "Controls"; "Automation": Edit events, Init song with these positions, Init pattern with these positions, (separator), Create automation clips; "Remote control": Link to controllers…, Override global links…; "Value": Randomize, Humanize; (separator) Cancel [C: L-DFM].

### 2.3 What "Create automation clip" produces

| Aspect | Behaviour | Status |
|---|---|---|
| Channel | A new channel of type Automation clip is added to the Channel Rack and filed in the built-in filter group **"Automation"**. All FL 21/2024/2025 demo projects have the groups "Audio", "Automation", "Unsorted", with automation channels in "Automation" | [C: L-DEMO, CL 12.9.2] |
| Channel Rack display | With "Auto switch display filter" on, the rack may switch to the most relevant filter group | [C: M-CR]; that it switches to "Automation" on creation [I from X-THUNTER] |
| Link | One target link: the control, using the default 1:1 mapping | [C: M-PLAUTO, L-DEMO] |
| Initialization | The control's current value is stored as its song-start value (if "Initialize controls automatically" is on, the default) | [C: M-PLAUTO, M-GS, L-DFM] |
| Envelope | Flat line at the control's current value, expressed inside MIN…MAX. Two points (start and end) | flat [C: X-THUNTER]; 2 points [I] (the minimum allowed, §1.2). Value relative to MIN/MAX [C: L-DEMO]: a tempo clip created at 150 BPM starts at 0.75 of 60…180 |
| MIN / MAX | 0 / 100%, except for "sane" defaults: tempo **60–180 BPM**, channel pitch **37.5–62.5%** of the full range (= ±1200 cents of ±4800) | [C: CL 9.5, L-DEMO]; cents interpretation [I] |
| Playlist start | At the **playback position** if General settings > "Create automation clips at the playback position" is on (FL 21.2+; default on). Otherwise at the start of the Playlist | [C: M-GS, CL 21.2, L-DFM, X-F1889510] |
| Playlist span | If a time range is selected: exactly that range. Otherwise "the entire song length" | [C: M-PLAUTO] |
| Length when started at the playback position | Undocumented. Recommend: from the playback position to the song end, with a minimum of 1 bar | **[U]** |
| Track | Instrument-track mode: a sub-track of the parent Playlist track. Otherwise "the highest empty track in the viewable area of the Playlist" (the manual says "mixer track", an evident slip) | [C: M-PLAUTO]; read as the topmost empty, unhidden track currently in view [I] (CL 20.0.3 fixed clips landing on hidden tracks) |
| Selection / windows | Undocumented. Recommend: no window opens. The new clip becomes the Playlist's current clip source, and the Picker's automation list shows it. FL 20.99 fixed "settings window is not shown when adding … automation clip", but that refers to adding a channel via the Channel Rack Add menu | **[U]** |
| Second clip for the same control | Allowed. It gets a unique name with a " #2" suffix | [C: L-DEMO] (e.g. "Croak - HighPass #3") |

### 2.4 Automation channel created from the Channel Rack

Adding an "Automation clip" channel from the Channel Rack Add menu gives an unlinked clip. Targets are added later with the target-links **+** button (§5.8). Its settings window opens on creation (FL 20.99 fix) [C: CL 20.99 #13001]; initial envelope [U] (recommend 2 points at 0.5).

### 2.5 Names and colours

**Names** use the target's owner plus the parameter's display name. Duplicates get " #2", " #3", … [C: L-DEMO]. The display names come from the program's parameter-naming routine, which uses strings such as "Volume", "Panning", "Stereo separation", "Mix level", "Mute / solo", "To %s" and "%s (Slot %d)" [C: L-STR].

| Target kind | Pattern | Real examples (demo projects) | Status |
|---|---|---|---|
| Channel control | `<channel name> - <control hint name>` | "Fx Squelch - Channel volume", "Fx Squelch - Channel panning", "Attack Snare 44 - Channel pitch" | [C: L-DEMO] |
| Generator plugin parameter | `<channel name> - <parameter name>` | "Wavvyy Synth - Filter frequency", "Croak - HighPass" | [C: L-DEMO] |
| Effect plugin parameter | `<effect slot name> - <mixer track name> - <parameter>` | "Reeverb 2 - Sidechain - Wet level", "Balance - Master - Volume", "Love Philter - Vocal Chop - Filter 1 - Cutoff frequency" | [C: L-DEMO]. FL 2024.1.1 fixed missing track names for third-party plugins [C: CL #18000] |
| Same plugin twice on one track (FL 2025+) | `<plugin> (Slot N) - <track> - <parameter>` | "Param. EQ 2 (Slot 9) - Terror - Band 7 level" | [C: L-DEMO, L-STR] |
| Mixer track control | `<track name> - <control>` | "Sub - Volume" | [C: L-DEMO]; for unnamed tracks the default "Insert N" is used [I] |
| Effect slot mix / on-off | `<slot name> [- <track>] - Mix level` / `- Mute / solo` | "Gross Beat - Mix level", "Gross Beat - Mute / solo" | [C: L-DEMO]; track name added in FL 2024 [C: CL 24.0.99 #7668] |
| Tempo | `Tempo` | "Tempo" | [C: L-DEMO] |
| Main pitch | `Master pitch` | — | [I from L-STR] |

**Colour** **[U]**. In FL 24.2/25 projects the new channel's colour equals the target channel's colour (e.g. #349B3E for both "Croak - HighPass" and its instrument channel). In FL 20.x projects clips have pastel palette colours (#60608E, #608E81, #60738E) that do not match their targets [C: L-DEMO]. The clip menu has *Random color* since FL 21.2.99 [C: CL #5511]. Recommend: copy the colour of the target's owner (channel or mixer track); otherwise use the next colour of the channel auto-colour palette.

### 2.6 Deleting

- Deleting a clip instance from the Playlist leaves the channel in the project. Deleting the channel (Channel Rack) or removing the clip from the Picker deletes it entirely [C: M-PLAUTO].
- The init value remains after the clip is deleted. Undoing the creation also removes the init value (fixed in FL 20.99) [C: M-PLAUTO, CL 20.99 #14017].

---

## 3. Editing automation clips in the Playlist

### 3.1 Clip anatomy and drawing

From the manual's screenshots [C: L-IMG]; pixel sizes [I].

| Element | Appearance |
|---|---|
| Title bar | Top strip filled with the clip colour. Holds the clip-menu icon (small automation glyph) at the left and the clip name. The clip is **moved and resized only by its title bar**, because the body is used for point editing [C: M-PL] |
| Body | Darker, semi-transparent shade of the clip colour over the track grid |
| Curve | Light line (pale tint of the clip colour, about 2 px), drawn through the points. Zero-length segments draw as vertical lines |
| Fill | The area under the curve, down to the clip bottom, filled with a translucent light tint of the clip colour |
| Control points | Circles about 9 px in diameter (at 100% scale): light outline, translucent fill |
| Tension handles | Smaller hollow circles (about 6 px), one per segment, at the segment's **time midpoint**. For curve modes the handle sits on the curve. For Wave it appears at the middle of the value range, which is also where a triangle or sine wave of N+½ cycles passes at the midpoint (§4.4) [C: L-IMG]; the general rule is [I] |
| LFO preview | With the LFO switch on, the clip shows the LFO and its amplitude envelope [C: M-PLAUTO] |
| Clip colour source | the automation channel's colour [I] |

### 3.2 Mouse and keyboard

Applies in Draw (P) or Paint (B) mode with the Automation focus active, or with any focus for a non-stacked clip [C: M-PLAUTO, M-PL].

| Gesture | Effect | Status |
|---|---|---|
| Right-click on the body | Add a point. Keep holding and drag to place it | [C: M-PLAUTO] |
| Shift + right-click | Add a point on the existing curve without changing the level. With Snap on: **Alt + Shift + right-click** | [C: M-PLAUTO, M-N20] |
| Left-drag a point | Move it. It snaps to the Playlist grid unless snap is "(none)" | [C: M-PLAUTO] |
| …+ Shift while dragging | Lock the vertical position (horizontal-only move) | [C: M-PLAUTO] |
| …+ Ctrl while dragging | Lock the horizontal position (vertical-only move) | [C: M-PLAUTO] |
| …+ Alt while dragging | Bypass snap | [C: M-PLAUTO, CL 9.5] |
| Drag the last point to the right | Extends (stretches) the clip | [C: M-PLAUTO] |
| Right-click a point | Point menu (§3.3). When STEP is on, right-click erases instead | [C: M-PLAUTO]; STEP behaviour [I] (forum report: right-click seemed to delete points with STEP on) |
| Right-Alt + left-click a point | Delete it (also Alt + right-click in envelope editors since FL 9.5) | [C: M-PLAUTO, CL 9.5] |
| Left-drag a tension handle up/down | Change tension (§4.8). **Ctrl** = fine adjustment | [C: M-PLAUTO] |
| Right-click a tension handle | Reset tension to 0 (straight line) | [C: M-PLAUTO]; undo name "automation default tension" [C: L-STR] |
| Double-click the clip | Open the automation clip editor (channel settings), scrolled to the clicked position | [C: M-PLAUTO] |
| Drag the title bar | Move the clip. Dragging the title bar's edge resizes it (left edge only with "Allow resizing from the left") | [C: M-PL] |
| Slip tool (S) | Slide the envelope inside the clip window | [C: M-PLAUTO, M-PL] |
| Ctrl + Shift + right-click | Zoom the Playlist onto a single clip | [C: CL 9.0] |
| Hint bar while moving | Point number and value in the target's units (since FL 20.9), honouring MIN/MAX (since FL 2024.2.1), plus the position | [C: M-PLAUTO, CL 20.9 #11236, CL 2024.2.1 #18865, CL 20.99 #12374]; format "Point i/n: value" [I from L-STR] |

**Step and Slide** (Automation focus tab options; defaults STEP off, SLIDE on) [C: M-PL, L-IMG, L-DFM]:

- **STEP**: left-drag draws a free-hand curve, laying down one point each time the mouse crosses a grid line (grid = current snap). Holding Shift draws "pulse" lines that are strictly horizontal or vertical. Each new segment takes the most recently set tension [C: M-PLAUTO, M-PL].
- **SLIDE on**: when a point is dragged horizontally, all following points move by the same amount, keeping their spacing (the clip length changes). **SLIDE off**: the point moves between its neighbours and the clip length is unchanged [C: M-PL, M-PLAUTO].
- Points cannot pass their neighbours in time. Equal times are allowed (vertical jump) [I], [C: L-DEMO].
- New-point mode and tension inheritance **[U]**. FL 26.1.3 fixed "adding a new point doesn't remember the previous tension mode", so a new point is meant to reuse the last used mode [C: CL #22363]. Recommend for FL 21/2024: a point inserted into a segment takes that segment's mode and tension; a point appended after the last point takes the last used mode with tension 0.

### 3.3 Point right-click menu (exact)

Playlist version (menu `EEACPointMenu`) [C: L-DFM, L-IMG]:

1. Header **Point i/n** (e.g. "Point 2/3")
2. Delete
3. Header **Mode**
4. Smooth · Hold · Single curve · Single curve 2 · Single curve 3 · Double curve · Double curve 2 · Double curve 3 · Half sine · Stairs · Smooth stairs · Pulse · Wave (radio items; the current mode is checked [C: CL 20.9 #12144])
5. (separator)
6. Copy value · Paste value · Type in value…

The channel-settings editor uses a generic envelope menu with the same 13 modes but **Hold before Smooth**, plus arpeggiator and ADSR sections that only apply to instrument envelopes [C: L-DFM]. Those sections are hidden for automation clips [I].

*Type in value…* originally took a number from 0 to 1. Since FL 20.9 it is context-aware (accepts units such as dB, Hz, %), and since FL 2024.2.1 it respects MIN/MAX [C: M-PLAUTO, CL 20.9 #11236, CL 2024.2.1 #18865].

The manual's text lists older, inconsistent names ("Alt single curve", "Alt double curve") and omits Single/Double curve 3. Use the menu labels above and the maths in §4 [C: M-PLAUTO vs L-DFM].

### 3.4 Clip menu (title-bar icon, exact)

From the current manual screenshot [C: L-IMG]: header **Automation clip**; Preview; Muted (check); Rename and color…; Random color; Change color…; Change icon…; Select source channel ▸; Channel settings; Articulator tools ▸; Make unique; Select all similar clips; Delete; header **Region**: Select region ▸; Chop ▸.

- *Articulator tools* ▸ = the envelope tools of §5.5 (Copy/Paste state, Flip vertically, Scale levels, Normalize levels, Filter, Smooth up, Smooth up abrupt changes, Turn all points smooth, Analyze audio file, Create sequence, Focus on click) [C: M-PL].
- *Make unique*: clones the automation channel so later edits do not affect other instances. Whether target links are kept **[U]**: CL 9.0 says links are preserved; the current manual says the clone is not linked. Recommend keeping the links (the 2024 audio-track fix #19165 also implies made-unique clips stay attached). The Channel Rack and Picker also offer *Clone with links* (FL 20.8) [C: CL 9.0, M-PLAUTO, CL 20.8 #10043].
- *Merge automation clips* (Playlist Edit menu, **Ctrl+Alt+G**): asks whether to keep the first clip's links, merge all links or delete all links. Lossy merges are approximated (allowed for LFO-mode clips since FL 20.99) [C: M-PL, L-DFM, CL 20.99 #13879].
- *Chop* works on automation clips since FL 21 [C: M-N21].

### 3.5 Snap

Points use the Playlist snap setting (Main / Line / Cell / fractions / none). Holding Alt bypasses snap temporarily [C: M-PLAUTO, M-PL].

---

## 4. Curve mathematics

All formulas give the normalized shape `S(u)` of one segment, with `u ∈ [0,1]` and `t ∈ [−1,1]` the tension of the segment's right-hand point. The value is `v0 + (v1 − v0)·S(u)` (§1.4). All of this is [C: L-CODE] (evaluator `0x58A690`, precompute `0x588670`, helpers `0x572D00` and `0x58B190`, build 26.1.x) unless tagged otherwise. Internal arithmetic mixes float32 and float64, and "round" means round to nearest with ties to even.

### 4.1 Mode enum

| Id | Menu label | Tension controls | Manual's description (paraphrased) |
|---|---|---|---|
| 0 | Single curve | curvature (exponential), sign = direction | default; straight or curved segment |
| 1 | Double curve | the same curvature on two mirrored halves | smooth S-curves |
| 2 | Hold | nothing | single step: hold the old value, jump at the next point |
| 3 | Stairs | number of stairs (\|t\|); whether the endpoints are included (sign) | multiple steps |
| 4 | Smooth stairs | number of stairs (\|t\|); phase of the plateaus (sign) | multiple smooth steps |
| 5 | Pulse | number of pulses (\|t\|); phase (sign) | square wave |
| 6 | Wave | number of cycles (\|t\|); shape: **sine for t<0, triangle for t≥0** | sine wave pulse |
| 7 | Single curve 2 | blend between a straight line and a 6th-power curve | (manual: "alt" curve, asymmetric) |
| 8 | Double curve 2 | the same on two halves | — |
| 9 | Half sine | blend between a straight line and a quarter-sine curve | half a sine |
| 10 | Smooth | blend between a monotone cubic spline and a straight line (\|t\| = 0 gives full smoothing) | joins points with an S-curve |
| 11 | Single curve 3 | rational (hyperbolic) curvature | — |
| 12 | Double curve 3 | the same on two halves | — |

### 4.2 Linear shortcut (tension-sign cache)

- `sign(t)` is −1, 0 or +1 [C: L-CODE].
- For modes 0, 1, 7, 8, 9, 11 and 12 with t = 0, the cache is set to 2 and the segment evaluates as `S(u) = u` [C: L-CODE].
- Smooth (10) also uses 2 when \|v1 − v0\| < 5.96·10⁻⁸ (flat segment) [C: L-CODE].
- Wave (6) uses 2 when N(t) = 0 and t > 0 (half a triangle cycle is a straight line) [C: L-CODE].
- Hold, Stairs, Smooth stairs and Pulse never take the shortcut, so they keep their shape at t = 0 [C: L-CODE].

### 4.3 Formulas

**0 — Single curve.** Let `k = 10^(6|t|) − 1`, so that `ln(1+k) = 6|t|·ln 10`.

- t < 0: `S(u) = ((1+k)^u − 1)/k = (10^(6|t|u) − 1)/(10^(6|t|) − 1)` (convex: slow start, fast end).
- t > 0: `S(u) = 1 − ((1+k)^(1−u) − 1)/k` (the 180° rotation: fast start).
- t = 0: `S(u) = u`.

At \|t\| = 1 the exponential spans 10⁶ (120 dB), which looks almost like a step.

**1 — Double curve.** Uses the Single-curve `S0`:

- u < ½: `S(u) = ½·S0(2u)`
- u ≥ ½: `S(u) = 1 − ½·S0(2(1−u))`

t < 0 gives the classic S (flat ends, steep middle). t > 0 gives a plateau (steep ends, flat middle). `S(½) = ½` always.

**2 — Hold.** `S(u) = 0`: the value stays at v0 for the whole segment and jumps to v1 at the right-hand point.

**3 — Stairs.** Let `s = +1` if t ≥ 0, otherwise −1, and `n = N(t) + 1 + (t ≥ 0 ? 1 : 0)`.

`S(u) = round(u·n − s/2) / (n − s)`

- t ≥ 0: n levels from 0 to 1 inclusive. The first stair holds v0 and the last reaches v1. At t = +1, n = 2: one jump at mid-segment.
- t < 0: n levels strictly between 0 and 1 (j/(n+1), j = 1…n). At t = −1, n = 1: the segment holds the mid value ½.

**4 — Smooth stairs.** `n = N(t) + 1`.

- `d = u·n − ½`
- `j = round(d − ½)`
- `x = 2(d − j) − 1`, with x ∈ [−1, 1]
- Easing: t ≥ 0: `e = x³`. t < 0: `e = sign(x)·(1 − (1 − |x|)³)`.
- `S(u) = (j + ½·e + 1)/n`

For t ≥ 0 the n+1 plateaus sit at the levels 0, 1/n, …, 1, with cubic transitions in between. For t < 0 the plateaus sit at the half levels. S(0) = 0 and S(1) = 1.

**5 — Pulse.** `m = 2·(N(t) + 1)` half-periods. `S(u) = round(u·m − s/2) mod 2`, giving 0 or 1. t ≥ 0 starts at v0 and ends at v1; t < 0 starts at v1 (inverted phase).

**6 — Wave.** `f = N(t) + ½` cycles.

- t < 0 (sine): `S(u) = ½·(sin(2π·(u·f + ¾)) + 1)`, starting at a trough and ending at a crest.
- t ≥ 0 (triangle): `d = u·f − ½`, `j = round(d − ½)`, `S(u) = |2(d − j) − 1|`.

Both start at 0, end at 1 and give `S(½) = ½`. With N = 0 the sine is a half-cosine ease and the triangle is a straight line.

**7 — Single curve 2.** `x = u` for t ≤ 0, `x = 1 − u` for t > 0. `S(u) = u − t·(x⁶ − x)`, so:

- t < 0: `S = (1 − |t|)·u + |t|·u⁶`
- t > 0: `S = (1 − t)·u + t·(1 − (1 − u)⁶)`

The bulge is asymmetric; its maximum is near u ≈ 0.3 or 0.7.

**8 — Double curve 2.**

- u < ½: `u' = 2u`, `S = ½·(u' − t·(x⁶ − x))`
- u ≥ ½: `u' = 2(1 − u)`, `S = 1 − ½·(u' − t·(x⁶ − x))`

Here x is u' or 1 − u' (by the sign of t, as in mode 7).

**9 — Half sine.** `q = sin(πu/2)` for t > 0, or `q = 1 − cos(πu/2)` for t ≤ 0. `S(u) = (1 − |t|)·u + |t|·q`.

**10 — Smooth** (monotone cubic Hermite, Fritsch–Butland / PCHIP tangents):

- Normalize the current segment so that `v0 → 0`, `v1 → 1` and its duration → 1. Let `r_p` and `r_n` be the previous and next segment durations divided by the current one (minimum 5.96·10⁻⁸). Let `δ_c = 1`, `δ_p = −ṽ_prev / r_p` and `δ_n = (ṽ_next − 1)/r_n`, where ṽ are neighbour values in the normalized scale.
- A neighbouring segment only counts if it is **also in Smooth mode**. Otherwise its slope is 0, which gives a flat tangent on that side.
- End tangent: `m1 = 0` if `δ_c·δ_n ≤ 0`. Otherwise `m1 = (w1 + w2)·δ_c·δ_n / (w1·δ_n + w2·δ_c)`, with `w1 = 2r_n + 1` and `w2 = r_n + 2`.
- Start tangent: the same with `(δ_p, δ_c)`, `w1 = 2 + r_p` and `w2 = 1 + 2r_p`.
- `H(u) = 3u² − 2u³ + m0·u(u − 1)² + m1·(u³ − u²)`
- `S(u) = u + (H(u) − u)·(1 − |t|)`

A single Smooth segment between non-Smooth segments is therefore a smoothstep S-curve. Chains of Smooth segments form a monotone spline through the points.

**11 — Single curve 3** (rational). `a = 1 − (1 − max(0.9|t|, 2⁻¹⁶))³`, so a ≈ 0.999 at \|t\| = 1.

- t < 0: `S(u) = (1 − a)·u / (1 − a·u)`
- t > 0: `S(u) = 1 − (1 − a)(1 − u) / (1 − a(1 − u))`

**12 — Double curve 3.** Mode 11 applied to mirrored halves, exactly as in mode 1: `½·S11(2u)` for u < ½, `1 − ½·S11(2(1−u))` otherwise.

### 4.4 Step-count function

`N(t) = round((10^(6·(1 − 0.6·|t|)) − 1)·0.001)`. The intermediate `1 − 0.6|t|` is rounded to float32 [C: L-CODE]. Larger \|t\| gives fewer steps or cycles.

| \|t\| | 0 | 0.1 | 0.2 | 0.3 | 0.4 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 | 1.0 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| N | 1000 | 437 | 191 | 83 | 36 | 16 | 7 | 3 | 1 | 1 | 0 |

Derived counts: Stairs has N+2 levels (t ≥ 0) or N+1 (t < 0); Smooth stairs has N+1 steps; Pulse has N+1 periods; Wave has N+½ cycles.

### 4.5 Test vectors

Values of S(u) at u = 0.25 / 0.5 / 0.75, computed from §4.3 [I]. Use them for unit tests.

| Mode | t = −0.5 | t = +0.5 | t = +1.0 |
|---|---|---|---|
| Single curve | 0.0046 / 0.0307 / 0.1770 | 0.8230 / 0.9693 / 0.9954 | 0.9684 / 0.9990 / 1.0000 |
| Double curve | 0.0153 / 0.5 / 0.9847 | 0.4847 / 0.5 / 0.5153 | 0.4995 / 0.5 / 0.5005 |
| Single curve 2 | 0.1251 / 0.2578 / 0.4640 | 0.5360 / 0.7422 / 0.8749 | 0.8220 / 0.9844 / 0.9998 |
| Double curve 2 | 0.1289 / 0.5 / 0.8711 | 0.3711 / 0.5 / 0.6289 | 0.4922 / 0.5 / 0.5078 |
| Single curve 3 | 0.0525 / 0.1426 / 0.3329 | 0.6671 / 0.8574 / 0.9475 | 0.9970 / 0.9990 / 0.9997 |
| Half sine | 0.1631 / 0.3964 / 0.6837 | 0.3163 / 0.6036 / 0.8369 | 0.3827 / 0.7071 / 0.9239 |
| Stairs | 0.2778 / 0.5 / 0.7222 | 0.2353 / 0.4706 / 0.7647 | 0 / 0 (tie, rounds to even) / 1 |
| Wave | 0.1464 / 0.5 / 0.8536 (sine) | 0.25 / 0.5 / 0.75 (triangle, 16.5 cycles) | 0.25 / 0.5 / 0.75 (straight line) |

### 4.6 Envelope evaluation rules

- Points are sorted by time; equal times are allowed. At a time shared by several points, the latest point's value applies, so a zero-length segment is an instantaneous jump [I], [C: L-DEMO].
- After the last point the value holds. Before the first point (only possible after slip editing) the first point's value holds [I].
- Point values are clamped to 0…1. The output is then re-ranged by MIN/MAX (§7).

### 4.7 The formula-language `Tension(Value, Speed)`

Used in Remote-control mapping formulas ("the same as the tension knobs") and in the crossfade links of §2.1 [C: M-AF, L-STR]. Implementation, with s = Speed:

- s = 0: `Tension(x, s) = x`
- s > 0: `Tension(x, s) = (s + 1 − (s+1)^(1−x)) / s`
- s < 0: `Tension(x, s) = ((1+|s|)^x − 1) / |s|`

This is the same exponential family as Single curve, parametrized directly by k = \|s\| [C: L-CODE, function at `0x205490`].

### 4.8 Tension handle behaviour

| Aspect | Behaviour | Status |
|---|---|---|
| Range | −1…+1 | [C: L-DEMO] |
| Hint | "Point i to j tension" with a percentage (e.g. 45%). The editor variant can show a text value instead (likely "N steps" for stepped modes) | [C: L-STR]; percentage = round(100·t) [I]; "steps" text [I] |
| Drag | vertical, relative; Ctrl = fine | [C: M-PLAUTO]. Scale and direction [U]. Recommend 1 unit of t per 200 px (Ctrl: per 2000 px), signed so that the handle and curve follow the mouse (on a falling segment, dragging up makes t more negative) |
| Reset | right-click → 0 | [C: M-PLAUTO] |
| Visibility | one handle per segment, including Wave and Pulse segments (FL 20.9 fixed handles that were invisible for those modes) | [C: CL 20.9 #12330] |
| Position | time midpoint; on the curve (§3.1) | [C: L-IMG], [I] |

---

## 5. Automation clip channel settings window ("Automation editor")

### 5.1 Opening

- Double-click a clip in the Playlist; the editor scrolls to the clicked location [C: M-PLAUTO].
- Other ways: clip menu > Channel settings; click the channel button in the Channel Rack; control menu > Edit automation clip… [C: M-PL, L-DFM].
- Envelope editing in this window exists since FL 20.9 [C: CL 20.9 #9827].
- Escape closes it (FL 2024.2 fix) [C: CL #18806].
- Help topic: `playlist_automationclip.htm#AutomationClip_ChannelSettings` [C: L-HELP].

### 5.2 Layout

From the manual screenshot [C: L-IMG]; control names and ranges [C: L-DFM].

| Region | Contents |
|---|---|
| Top bar | Sheet icon (only the Functions "wrench" page exists for automation channels); **ON** (channel enable LED); **MIN** knob; **MAX** knob; **TIME** knob; red multiplier digit (labelled **RANGE**, default 2); routing icon. The labels MIN, MAX, TIME replace the PAN, VOL, PITCH of normal channels [C: L-STR] |
| Panel "Automation editor" | Header with an **LFO** switch. Envelope editor with horizontal and vertical scroll bars and vertical grid bars (grid division 4 since FL 20.99/21 [C: CL #13098]). Bottom bar: Options-menu arrow, zoom (magnifier = zoom out full; key **Home**), and at the right: **Step editing** (hold Shift for pulse mode), **Snap to grid**, **Slide succeeding points** (lit yellow when on) |
| Panel "Target links" | Buttons: **+** Add target links (pulses while active), **×** Remove target link, Edit target link (wrench), Locate target link parameter, Animate target link parameter, Convert target to events in the current pattern, Select automation clips in the playlist (FL 2024). Below: a list of targets, e.g. "Default - Osc 1 coarse pitch" |
| Panel "Root note" | Root-note keyboard (C5 default), Reset, Fine tune. Used when the clip is triggered from notes [I] |
| LFO mode | Small knobs at the editor's bottom-left: **SPD, TNS, SKEW, PW, AMNT**, and a **MUL** switch. The editor shows the LFO waveform |

Envelope drawing in this window: white filled points, hollow tension handles on the curve at segment midpoints, a khaki/tan curve over a dark grid [C: L-IMG]. Exact colours are theme-dependent [I].

### 5.3 MIN, MAX, TIME

| Control | Storage | Behaviour | Status |
|---|---|---|---|
| MIN | the channel's Levels "pan" field, 0…12800 (= 0…100%) | `out = MIN + (MAX − MIN)·env` | [C: X-PYFLP, L-DEMO, M-PLAUTO] |
| MAX | the Levels "volume" field, 0…12800 | (same) | [C: X-PYFLP, L-DEMO] |
| Defaults | 0 / 12800. Tempo clips 1250 / 4250 (= 60 / 180 BPM, §7.2). Channel-pitch clips 4800 / 8000 | | [C: L-DEMO] |
| TIME | the Levels "pitch" field (0 = centre in every demo) | "Controls the speed at which the clip plays back"; the digit after it is a multiplier | [C: M-PLAUTO, L-DEMO]. Mapping [U]: TIME is the channel pitch knob relabelled, so it most likely scales speed like resampling (2^(cents/1200)) within ±RANGE semitones. Recommend implementing TIME = 1× and storing the value |

MIN > MAX is allowed and inverts the output [I].

### 5.4 Editor mouse and keys

| Gesture | Effect | Status |
|---|---|---|
| Left-click a point | select it | [C: M-PLAUTO] |
| Ctrl + drag | box-select points | [C: M-PLAUTO] |
| Shift + Ctrl + drag | add to the selection | [C: M-PLAUTO] |
| Middle-click a point | deselect it | [C: M-PLAUTO] |
| Left-click the background | deselect all | [C: M-PLAUTO] |
| Right-click / Shift+right-click / drag / Alt / Right-Alt | as in the Playlist (§3.2) | [C: M-N20, CL 9.5] |
| Ctrl+A / Ctrl+D / Ctrl+I | select all / deselect all / invert selection | [C: L-DFM] |
| Ctrl+X / Ctrl+C / Ctrl+V / Ctrl+R / Ctrl+B / Del | cut / copy / paste (insert) / paste (replace) / duplicate / delete the selected points | [C: L-DFM] |
| Home | zoom out | [C: M-PLAUTO] |
| Multi-point selection | available in all envelope editors since FL 20 | [C: M-N20] |
| Play position | a playback cursor moves through the editor | [C: CL 20.9 #12341] |

### 5.5 Options menu

From the screenshot [C: L-IMG]; extra items from the resource [C: L-DFM].

- **State**: Presets; Open state file…; Save state file…; Copy state; Paste state.
- **Tools**: Insert point(s) at marker(s) (greyed when there are no markers); Flip vertically; Scale levels…; Normalize levels; Decimate points…; Filter…; Smooth up…; Smooth up abrupt changes; Turn all points smooth; Create sequence…; Analyze audio file….
- **View**: Background gradient; Invert grid (on).
- Also in the resource: Reset, "Prepare for smooth editing", a Points-selection group (above shortcuts), the flags "Bipolar LFO tension" and "Frozen LFO", Make all loop, and the option "Focus on click". Visibility for automation clips **[U]**; recommend showing Points selection and Focus on click.

Tool behaviour [C: M-PLAUTO, M-ENVT]:

- **Flip vertically**: `v → 1 − v`.
- **Normalize levels**: scale so the extremes reach 0 and 1.
- **Scale levels**: Center, Multiply (−200…200%; negative inverts), Offset, Tension (reshapes slopes).
- **Decimate points**: reduce the number of points.
- **Filter**: convolve with a user-drawn impulse; Width, Offset, Decimation.
- **Smooth up**: Attack/Release smoothing and slope, Link, Offset, Decimation.
- **Smooth up abrupt changes** and **Turn all points smooth**: presets. The latter sets every point to Smooth mode [I].
- **Create sequence**: step sequencer of envelope steps (Off / normal / no gate / merged); Mode (normal loop / ping-pong), Time mul, Swing, Attack, Decay, Sustain, Gate; Randomize.
- **Analyze audio file…**: builds an envelope from an audio file's amplitude (also by dropping audio on the editor).

### 5.6 Target links panel

| Button | Behaviour | Status |
|---|---|---|
| + Add target links | Toggle a mode: every control tweaked while the mode is on is added as a target; click again to stop. Refused during playback or while multilink-to-controller mode is on | [C: M-PLAUTO, L-STR] |
| × Remove | removes the selected target, with confirmation | [C: M-PLAUTO, L-STR] |
| Edit | opens Remote control settings for that link (mapping formula, smoothing, §7.1) | [C: M-PLAUTO] |
| Locate | opens the window that contains the target | [C: M-PLAUTO] |
| Animate | wiggles the target so it is easy to find | [C: M-PLAUTO] |
| Convert to events | writes the clip's data as event automation for that target into the **current pattern**; the clip stays and remains linked | [C: M-PLAUTO, L-DFM]. Time mapping [U]: recommend clip start = pattern start |
| Select in playlist | selects every instance of this clip (Shift also zooms) | [C: M-PLAUTO, CL 24.0.99 #17586] |

### 5.7 LFO mode

| Control | Range (raw) | Default | Behaviour | Status |
|---|---|---|---|---|
| LFO switch | on/off | off | Replaces the envelope's output by the LFO and shows the LFO preview in Playlist clips. The envelope is kept and is combined when MUL is used | [C: M-PLAUTO]; default [I] |
| SPD (speed) | 512…65536 | 40000 (resource of the older settings panel) / 40898 (generic editor) | LFO rate. Unit and tempo-sync [U]: recommend a tempo-synced exponential mapping | [C: L-DFM] |
| TNS (tension) | −128…128 | 0 | Morphs the shape: square (pulse) → sine → triangle → pulse | [C: M-PLAUTO, L-DFM] |
| SKEW | −128…128 | 0 | Skews the shape; with a triangle, gives saw and reverse saw | [C: M-PLAUTO, L-DFM] |
| PW (pulse width) | −112…112 | 0 | Width of the shape | [C: M-PLAUTO, L-DFM] |
| AMT / AMNT (level) | −128…128 | +64 (+50%) for new clips; Reset gives 0 | Amplitude. The centre (0) disables the LFO; negative values invert it | [C: M-PLAUTO, L-DFM, L-DEMO, X-PYFLP] |
| MUL | on/off | off | On: LFO × envelope (amplitude modulation, for unipolar targets). Off: LFO + envelope (offset, for bipolar targets such as pan) | [C: M-PLAUTO] |

The exact LFO waveform maths **[U]**. Recommend `out = clamp(env ± level·lfo)` for MUL off, and `out = env·(1 − |level| + |level|·lfo01)` for MUL on, then MIN/MAX.

---

## 6. Playback semantics

### 6.1 Transport modes

| Mode | Automation clips | Event automation | Status |
|---|---|---|---|
| Song | Play while the playhead is inside a clip instance (whose track and clip are not muted) | Play inside every playing pattern clip, offset by the clip position | [C: M-TB, M-RA, M-PLAUTO] |
| Pattern | Do **not** play (only the current pattern plays) | Play (the pattern's own events) | [C: M-TB ("In Pattern Mode, only the current pattern is played"), M-RA] |
| Note-triggered | A clip channel triggered from the Piano roll, Step Sequencer or a MIDI keyboard automates while the note is held, without any Playlist instance. Older manuals add that note pitch varies the speed | | [C: M-PLAUTO, M-OLD-PLAUTO] |
| Precount | Clips must not play during the recording count-in | | [C: CL 20.5] |

### 6.2 Value timeline of one parameter (song mode)

| Interval | Value | Status |
|---|---|---|
| At song start | the initialized value, if one exists | [C: M-PLAUTO, M-BR, M-TOOLS ("press STOP, then PLAY")] |
| Before the first clip | the init value (if any). Otherwise whatever value the control already has (no look-ahead) | [I]. A 2007 forum report describes the opposite for FL 7 (the knob already at the clip's first value), which init values now prevent |
| Inside a clip | the clip's envelope at the position, offset by the clip window's start offset, re-ranged by MIN/MAX, through the link formula | [C: M-PLAUTO, L-CODE] |
| Clip longer than its envelope | holds the last point | [C: L-CODE] |
| After a clip ends | holds the last value the clip sent | [C: X-F17483 (2007)], [I] |
| Between two clips | holds the earlier clip's last value; jumps to the next clip's value at its start | [I] |
| After the last clip | holds | [I] |

### 6.3 Relocation, stop, pause, loop

- **Chase on relocation.** Setting the song position, by clicking the ruler while stopped or playing, Home, or Stop returning to the start, re-evaluates automation clips at the new position. Clips that end before it contribute their last value [C: CL 12.3 "Last node of automation clip is ignored when manually setting Playlist position" (bug fixed)]. Muted (disabled) clips are skipped [C: CL 5.0.1].
- Recommended chase algorithm [I]: (1) apply all init values; (2) for every target, take the last active, unmuted clip instance whose start ≤ position; if the position is inside it, use the envelope value there, else its end value.
- **Stop** returns to the play start or song start (see main-playlist.md §2.8), so controls jump to the values at that position [I].
- **Pause** (Ctrl+Space) keeps position and values [I].
- **Song loop**: when the song wraps to the start, treat it as a relocation to the start (init values, then clips) [U].
- Clips must not play beyond the loop point (FL 12.3.1 fix) [C: CL 12.3.1].
- Song length (and thus the loop length) includes automation clips [C: CL 20.9 #12163].

### 6.4 Several clips, one target

- Allowed: several clips may link to one control [C: M-PLAUTO].
- Overlap priority **[U]**. Undocumented. Each clip instance plays as a "voice" of its automation channel (class `TMixVoiceAutomationClip`, [C: L-STR]), and every clip sends its value when it changes, so in FL the most recently written value wins.
- Recommended deterministic rule: among the active instances for one target, the most recently started wins. Ties go to the higher Playlist track index (lower on screen).
- Event automation for the same target can coexist with clips (since FL 9.5); the last value written wins [C: CL 9.5], [I].

### 6.5 Manual tweak during playback

- **FL 21 / 2024**: moving an automated control by hand (mouse or MIDI) during playback takes it over. Its automation clip no longer drives it until playback is **stopped and restarted** [C: M-N26: "Previously playback would need to be restarted to have the Automation Clip regain control"].
- **FL 2026**: Playlist menu option **Automation clips reset remote controls**. When on, the control smoothly returns to clip control at the start of the next linked clip. When off, FL 2026 keeps the legacy behaviour [C: M-PL, CL 26.1 #21233].
- While stopped, tweaking just sets the value. The next Play from song start re-applies the init value and the clips [I].
- Event automation keeps applying its next events after a manual tweak **[U]**; recommend yes.

### 6.6 Mute states

| What is muted | Effect | Status |
|---|---|---|
| Clip (clip menu > Muted) | does not play and is ignored by chase; the control holds its value | [C: L-IMG (menu item), CL 5.0.1] |
| Playlist track | its clips do not play | [I] |
| Automation channel (ON switch / Channel Rack mute) | the channel sends nothing | [I] |

### 6.7 Timing, smoothing, latency

- Update rate **[U]**. FL evaluates the envelope per audio block in its mixer voice engine, and many targets smooth internally. Recommend evaluating at the audio block rate (≤128 samples) with sample-accurate segment boundaries, plus per-target de-zipper smoothing about 5 ms long.
- Remote-control links have a **Smoothing** section: an enable switch and a Time slider (−1024…1024, default 469). Stored per link [C: L-DFM, L-DEMO (smooth=469, flags=8 on every clip link)]. Whether it is enabled by default [U]; recommend off for automation-clip links.
- **PDC**: since FL 20.7, automation of effects is delayed to match plugin latency ("Compensate automations", on by default; see mixer.md) [C: M-N20].

---

## 7. Value mapping and ranges

### 7.1 Chain

1. Envelope value `e ∈ [0,1]` (LFO combined if on).
2. `y = MIN + (MAX − MIN)·e` (clip knobs).
3. Optional mapping formula of the link (`Input` → output; presets such as Inverted, Log scale, Switch, Steppy, First half…; user formulas) [C: M-AI, M-AF].
4. The control's own normalized-to-native mapping (taper, units) [C: M-PLAUTO, L-DEMO], [I].

Values are normalized 0…1 everywhere in the clip [C: X-PYFLP]. Hint and type-in show native units (context-aware) [C: CL 20.9].

### 7.2 Common targets

Native integer storage from [C: L-DEMO]; normalized meaning [I] unless tagged.

| Target | Normalized 0…1 means | Native storage | Default clip range | Status |
|---|---|---|---|---|
| Mixer volume | fader position. 0.8 = 0 dB; 1.0 = +5.6 dB | 0…12800 | 0…100% | [C: mixer.md] |
| Mixer pan | 0 = 100% L, 0.5 = centre, 1 = 100% R | 0…12800 | 0…100% | [I] |
| Mixer stereo separation | 0…1 across separated…merged | | 0…100% | [I] |
| Channel volume | knob 0…100% (78% default) | 0…12800 | 0…100% | [C: sampler.md] |
| Channel pan | as mixer pan | 0…12800 (6400 = centre) | | [C: sampler.md] |
| Channel pitch | linear in cents over ±4800 (0.5 = 0) | cents | **37.5…62.5% = ±12 semitones** | storage [C: sampler.md]; range [C: L-DEMO]; cents mapping [I] |
| Tempo | **linear 10…522 BPM** (`BPM = 10 + 512·y`) | BPM × 1000 | **60…180 BPM** (MIN 1250, MAX 4250) | [C: L-DEMO, CL 9.5]: 1250/12800 maps to exactly 60 and 4250/12800 to exactly 180 under the linear rule |
| Main pitch | ±1200 cents; linear [I] | | 0…100% | [U] |
| Plugin parameter (VST/AU/native) | the plugin's normalized parameter | per plugin | 0…100% | [I] |
| Switch (mute, FX-slot on, plugin on/off) | 0 = off, 1 = on. Factory projects use 0/1 values with zero-length jumps | 0/1 | 0…100% | data [C: L-DEMO]; threshold [U] (recommend on when ≥ 0.5) |
| Stepped control (filter type, arp mode, ZGE blend mode…) | quantized to the nearest step | integer index | 0…100% | [I] |

To automate tempo outside 60–180 BPM, widen MIN/MAX on the tempo clip [C: CL 9.5], [I]. Tempo automation updates the tempo map, which affects time displays and audio-clip stretching (FL 2024.1 fixed missing updates after point edits) [C: CL #17827].

### 7.3 Display while editing

The hint bar shows point values in the target's own format (e.g. "−6.0 dB", "120 BPM", "50% left") [C: M-PLAUTO, CL 20.9, CL 2024.2.1]; format details [I]. The tension display is described in §4.8.

---

## 8. Event editor (pattern automation)

### 8.1 What it is

- Holds automation data **bound to a pattern**. Each pattern can hold any number of target data sets [C: M-EE].
- Data can be recorded (§9) or drawn [C: M-EE].
- To link other controls to event data, first convert it to a clip [C: M-EE].
- Opening:
  - control menu > Edit events (in the selected pattern);
  - Edit events in new window;
  - Edit events in piano roll;
  - Tools > Last tweaked > Edit events;
  - Browser > Current project > Patterns > pattern > target.

  If no data exists yet, drawing creates it; closing without drawing creates nothing [C: M-EE, M-TOOLS].
- The window is the shared editor window: caption "Event editor" plus the target, and a **Target control** selector listing the data sets of the selected pattern [C: M-EE, L-DFM].
- Waveform helper: drop an audio file on the editor; Alt+N toggles it [C: M-EE].

### 8.2 Tools and gestures

[C: M-EE]; tool keys [C: L-DFM].

| Tool | Behaviour |
|---|---|
| Draw (P) | Left-drag draws free-hand (snapped); right-drag draws a straight line. Shift locks the vertical position, Ctrl selects time, Alt bypasses snap |
| Paint (B) | Like Draw but ignores snap (full PPQ resolution). Right-drag: straight line or interpolate |
| Erase / Delete (D) | Resets the data in the dragged range to the value at the range start (older manual: removes the selected events) |
| Interpolate (I) | Drag across events: left = linear, right = spline |
| Select (E) | Time-range selection; also Ctrl+click or double-click the ruler in any tool |
| Zoom (Z) | right-click zooms out |
| Snap | Main / Line / Cell / (none) / step and beat fractions / Bar; applies to Draw only |

Display: events are vertical bars whose height is the value. The vertical axis is 0–100% of the target range; the horizontal axis is in bars [C: M-EE].

### 8.3 Menu

[C: M-EE]; shortcuts [C: L-DFM].

- **File**: Open automation (.fsc score); Save automation as; Import MIDI (Ctrl+M); Paste from MIDI clipboard (Shift+Ctrl+V).
- **Edit**: Cut / Copy / Paste; Delete (deletes everything if nothing is selected); Select all; Select previous (Ctrl+←) / next (Ctrl+→); Insert space (Ctrl+Ins); Delete space (Ctrl+Del); **Insert current controller value (Ctrl+I)**, which writes the control's current value at the selection start or the pattern start; **Turn into automation clip…**.
- **Tools**: Scale levels (Center, Tension ±100, Multiply 0–200%, Offset ±100; **Alt+X**); LFO (Start/End value, range and speed, shape sine / triangle / square, phase; draws into the selection or bar 1). The manual gives Ctrl+L for LFO; the FL 2026 shortcut table has **Alt+O**.
- **View**: grid colour, detached, invert grid, time segments (default 4 bars), incremental scrolling, precise time indicator, helpers.
- **Snap**, **Zoom** (Page Up/Down; Shift+1…5 presets), **Target control**.
- **Relocate events**: when on, paste inserts and cut/delete close gaps.
- **Auto smoothing**: interpolate drawn events on mouse release. Default [U]; recommend off.
- **Center (0)**.

### 8.4 Playback

- Events play whenever their pattern plays: in pattern mode, and in song mode inside every clip of that pattern. Event automation "remains active in either Pattern or Song mode" [C: M-RA].
- Pattern clips show event data as a shaded background graph [C: M-EE, M-PL].
- Events are step changes. A sliced or trimmed pattern clip plays only the events inside its window [I].
- Chase of earlier events when starting mid-pattern [U]: recommend applying the last event before the start position for every target of each pattern clip under the playhead.
- Pattern length counts event positions (an event past the last note lengthens the pattern) [C: main-playlist.md].

### 8.5 Edit events in piano roll

Opens the Piano roll and shows this target's event data in the lower editor lane (the same tools as the Event Editor; Interpolate works only on real event data) [C: M-PR, M-TOOLS].

### 8.6 Turn into automation clip / Convert to events

- **Turn into automation clip…** opens a small dialog, "Convert to automation", with one slider, **Sensitivity** (internally a decimation threshold of 400…1000, default 1000), and Accept / Reset. Fewer points are easier to edit. When a conversion takes more than 40 ms, updates switch to compute-on-mouse-up [C: M-EE, L-DFM].
- The conversion algorithm fits a reduced point set with curve approximation (FL 20; it was improved again in 20.9) [C: M-N20, CL 20.9 #10603]. A clone can use a Ramer–Douglas–Peucker-style reduction whose tolerance follows Sensitivity, then fit Single-curve tensions [I].
- The result is a new automation channel linked to the target. With instrument tracks it is placed as a sub-track [C: CL 2024.1 #17453].
- Whether the event data is removed from the pattern **[U]**. The manual's warning that "the sync with the original pattern is lost and the clip must be aligned manually" suggests the events are moved into the clip. Recommend: remove the events (undoable) and place the clip at song start, or at the playback position if that option is on.
- **Convert to events** (target-links button) is the reverse; the clip stays [C: M-PLAUTO].

### 8.7 Event automation versus clips

Both can automate the same target (since FL 9.5); whichever writes last wins [C: CL 9.5], [I]. A clip writes continuously while it changes, so it usually dominates; events produce jumps only at their own times [I].

---

## 9. Recording automation

| Aspect | Behaviour | Status |
|---|---|---|
| Arm | Record button armed. Recording filter (right-click Record) item **Automation** ticked | [C: M-RA, M-TB, L-DFM] |
| Sources | mouse moves on any automatable control; linked MIDI controllers; internal controller plugins only if their link has "Record automation" on (off by default) | [C: M-RA, M-AI] |
| Destination | **event automation in the pattern selected at recording time**, in both pattern and song mode. Several controls go into the same pattern | [C: M-RA] |
| Song mode | After Stop, the recorded pattern appears as a clip at the position where playback started (documented for notes; the same mechanism is assumed for automation-only patterns) | [C: M-RS], automation [I] |
| Never into clips | FL deliberately records events, not clips: live recording yields one point per PPQ step (384 per bar at 96 PPQ). Use Turn into automation clip afterwards | [C: M-RA] |
| Initial value | Before the first recorded value, the control's previous value is stored, so the pattern and song start from the old value (flag `REC_Init`) | [C: M-API], [I] |
| Quantize | Recording filter > Quantize > **Automations** quantizes recorded automation to the main snap | [C: M-TB, L-DFM] |
| Cancel | Tools/Help > Cancel current recording while recording; Undo afterwards | [C: M-RA] |
| Defaults (FL 21/2024) | The recording filter has Automation, Notes and Audio ticked [U] (the factory default is not documented). "Initialize controls automatically" is on [C: L-DFM] | |

---

## 10. What can be automated

### 10.1 Rule

A native control is automatable if its hint shows the "recording" icon (it can be automated, recorded or driven by an envelope controller). The "MIDI plug" icon means it is linkable [C: M-TB, M-RA]. Plugin parameters are automatable when the plugin exposes them (Browser > Current project lists every automatable parameter) [C: M-BR].

### 10.2 Inventory and internal addresses (FL ≤ 2024 encoding)

Internal address ("REC id") = `group × 65536 + control` (the bit fields do not overlap, so + equals bitwise OR). These are confirmed from scripting constants and project data [C: M-API, X-DAWVERT, L-DEMO]. FL 2025 changed the mixer encoding for 500 tracks [C: L-DEMO].

| Owner | Controls (control index) | Address form |
|---|---|---|
| Channel *c* | Volume 0, Pan 1, Mod X / filter cutoff 2, Mod Y / filter resonance 3, Pitch 4, Filter type 5, Portamento time 6, Mute 7, Mixer track 8, Gate 9, Crossfade 10, Time shift 11, Swing mix 12, Sample start offset 13, Stretch time 14, Levels-adjust pan 16, vol 17, pitch 18, Mod X 19, Mod Y 20 | `c × 65536 + index` [C: M-API] |
| Channel echo / arp / tracking / envelopes | Echo 0x200+ (feedback, pan, pitch, echoes, time, Mod X/Y); Arp 0x300+ (type, range, chord, time, gate, repeat); Tracking 0x500+; per-target envelope/LFO 0x1100…0x1400 + (delay, attack, hold, decay, sustain, release, amount, LFO predelay/attack/amount/speed, tensions) | [C: X-DAWVERT] |
| Generator plugin parameter *p* | any exposed parameter | `c × 65536 + 0x8000 + p` [C: X-DAWVERT, L-DEMO] |
| Mixer track *m* | Volume 0x1FC0, Pan +1, Stereo separation +2, EQ gain +16…, EQ freq +24…, EQ width +32…, sends 0x1F40+/0x1F80+ | `(0x2000 + 64·m) × 65536 + control` [C: M-API (REC_Mixer_Vol = 0x20001FC0), X-DAWVERT] |
| Mixer slot *s* | On/off 0x1F00, Mix 0x1F01, plugin parameter 0x8000 + p | `(0x2000 + 64·m + s) × 65536 + control` [C: X-DAWVERT, L-DEMO] |
| Main | Swing 1, Main pitch 2, Tempo 5. Address 0 is the main (monitor) volume: it has an address and is stored with the mixer state, but it is not rendered and not automatable [C: M-TB via main-playlist.md] | `0x4000 × 65536 + index` [C: X-DAWVERT, L-DEMO] |
| Transport | the Record switch (via Start/Stop recording markers) | [C: M-TB] |
| Automation clip itself | its LFO knobs and Time can be automated (internal tags 1536–1540) | [C: L-DFM, CL 10.5] |

### 10.3 Switches and stepped controls

- Automated through the same 0…1 value. A clip drawn for a switch is usually made of zero-length jumps between 0 and 1, or uses Hold/Stairs/Pulse modes [C: L-DEMO].
- Clone rule [I]: switch = (value ≥ 0.5); stepped = round(value·(steps − 1)).
- The mapping-formula presets "Switch", "Steppy" and "Steppy (cents to semitones)" exist for links [C: M-AI].

---

## 11. Persistence reference (FLP; useful for import/export)

All entries [C: L-DEMO, X-PYFLP, X-DAWVERT]; field meanings tagged [I] or [U] where unknown.

| Item | Encoding |
|---|---|
| Channel type | event 21 = 5 (automation clip) |
| Clip data (event 234) | u32 version = 1; i32 LFO amount (default 64); u32 = 1024 [U]; u8 = 0/1 (probably the LFO-on flag) [U]; u32 = 3 [U]; u32 point count; then 24 bytes per point: f64 Δbeats, f64 value, f32 tension, u16 mode, u8 selected, i8 tension-sign cache; then a 112-byte trailer (LFO and editor state) [U] |
| MIN / MAX / TIME | event 219 (Levels): int32 fields pan = MIN, volume = MAX, pitch = TIME |
| Target link (event 227) | target channel index, internal address (§10.2), flags (8), smoothing (469); event 230 holds the mapping formula text when it is not the default (e.g. `1-Input`) |
| Initialized controls (event 216) | repeated (u32 0, u32 address, i32 native value); e.g. tempo 150000 = 150 BPM |
| Event automation (event 223 inside a pattern) | repeated (u32 tick, u32 address, i32 native value) |
| Playlist instance | item index = automation channel index (below 20480); position and length in ticks; start/end window offsets as **float32 beats** (e.g. 0.0 / 208.0) |
| Display groups (event 231) | "Audio", "Automation", "Unsorted"; the channel group index (event 145) is 1 for automation channels |

---

## 12. Version differences

| Version | Change | Source |
|---|---|---|
| FL 5 | Automation clips introduced | [C: CL 5.0] |
| FL 7 | Events can be turned into clips; "Stairs" line mode | [C: CL 7.0] |
| FL 9 | New point modes; Make unique keeps links; left Alt bypasses snap, right Alt deletes; copy/paste value; sane default ranges for tempo and pitch; clips no longer block event automation of the same target | [C: CL 9.0, 9.5] |
| FL 10.0.5 | "Smooth" point mode | [C: CL] |
| FL 12.x | Track/plugin names in clip names; type-in on points; all 13 modes present (FL 12.3 projects) | [C: CL 12.1.1, 12.5; L-DEMO] |
| FL 20.0–20.9 | Shift+right-click adds a point on the curve; merge clips (20.8); clone with links; envelope editing and target links in channel settings, "Edit automation clip…" (20.9); context-aware type-in (20.9); PDC for automation (20.7) | [C: M-N20, CL] |
| FL 21.0 | Convert-to-events button; chop pattern and automation clips; editor grid division 4 | [C: M-N21, CL 20.99] |
| FL 21.2 | New clips at the playback position, plus a General-settings option (default on) | [C: M-N21, CL 21.2] |
| FL 2024 | "Select in playlist" button; mixer track name in slot-mix and third-party plugin clip names; type-in and hints respect MIN/MAX (24.2.1); Escape closes the editor | [C: M-N24, CL] |
| FL 2025 | Better names for effects on instrument tracks, "(Slot N)" names; context-aware type-in for Playlist nodes; dynamic mixer (new address encoding) | [C: M-N25, CL 24.2.99, L-DEMO] |
| FL 2026 | **Automation clips reset remote controls** option; type-in applies immediately while playing; a new point remembers the previous tension mode (26.1.3); undo for loading an envelope state | [C: M-N26, CL 26.1.x] |

---

## 13. Open questions and verification checklist

Verify against a real FL 21/2024 install; recommended defaults in brackets.

1. Overlap priority when two active clips drive one target [the most recently started wins; ties go to the lower track].
2. Mode and tension of a newly inserted point [inherit from the split segment; appended points take the last used mode with t = 0].
3. Length of a new clip created at the playback position [from the playback position to the song end, at least 1 bar].
4. Exact track choice ("highest empty track in view") [topmost empty visible track].
5. Tension-handle drag scale and direction [1/200 px; the handle follows the mouse].
6. LFO waveform maths and speed units [§5.7 recommendation].
7. TIME knob and multiplier digit semantics [store only; 1×].
8. Whether *Turn into automation clip* deletes the events, and where the clip goes [delete; song start or playback position].
9. Whether init values are re-applied on song loop or when playing from mid-song [yes: relocation applies init values, then chase].
10. Default colour of new automation channels [the target owner's colour].
11. Channel Rack row appearance of an automation channel. The clip can be triggered by steps or notes, so a standard row with steps is likely [standard row with steps, channel button showing the clip name].
12. Switch threshold [≥ 0.5 = on].
13. Update rate and smoothing of clip output [block rate plus ~5 ms smoothing].
14. Whether event automation still applies after a manual tweak during playback [yes].
15. *Make unique*: are the links kept? [yes].
16. Behaviour when a new tempo clip is created while the tempo is outside 60–180 BPM [clamp the first value to 0 or 1; keep the range].

---

## 14. Sources

Manual pages (canonical `https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/<page>`), read 2026-10-17 through `https://cluster.image-line.com/...`:

| Key | Page |
|---|---|
| M-PLAUTO | playlist_automationclip.htm |
| M-OLD-PLAUTO | `.../fl-studio-online-manual-de/html/playlist_automationclip.htm` (older English snapshot, pre-20.9) |
| M-EE | automation_eventeditor.htm (+ automation_eventeditor_levelscale.htm, automation_eventeditor_lfo.htm, pianoroll_lfo.htm) |
| M-RA | recording_automation.htm |
| M-RS | recording_scores.htm |
| M-AI | automation_internal.htm (internal controllers, Remote control settings, mapping-formula presets, smoothing) |
| M-AF | automation_form.htm (mapping-formula functions incl. `Tension(Value,Speed)`) |
| M-FFC | plugins/Fruity Formula Controller.htm |
| M-GS | envsettings_general.htm ("Create automation clips at the playback position", "Initialize controls automatically") |
| M-TOOLS | menu_tools.htm (Last tweaked) |
| M-ADD | menu_add.htm |
| M-BR | browser.htm (Current project, Initialized controls) |
| M-CR | channelrack.htm (display filter, auto switch) |
| M-TB | toolbar_panels.htm (Pat/Song, recording filter, hint icons, Multilink) |
| M-PL | playlist.htm (focus tabs STEP/SLIDE, clip menus, resizing, merge, "Automation clips reset remote controls") |
| M-PR | pianoroll.htm |
| M-ENVT | plugins/envelopetools_scalelevel.htm, envelopetools_filter.htm, envelopetools_smoothup.htm, envelopetools_sequencer.htm |
| M-API | midi_scripting.htm (REC ids and flags, channel types) |
| M-N20 / M-N21 / M-N24 / M-N25 / M-N26 | basics_new_20.htm / basics_new_21.htm / basics_new_24.htm / basics_new_25.htm / basics_new.htm (FL 2026) |
| L-HELP | `/Applications/FL Studio 2026.app/Contents/Resources/FL/Help/HelpAliases.scr` |
| CL | change log `WhatsNew.htm` (local `/Applications/FL Studio 2026.app/Contents/Resources/FL/Help/WhatsNew.htm`), cited as version + id |

Local install evidence (FL Studio 2026, 26.1.x; read only):

| Key | What |
|---|---|
| L-DFM | Form and menu resources decoded from `/Applications/FL Studio 2026.app/Contents/Libs/FLEngine_x64.dylib`: `EEACPointMenu` (Playlist point menu), `PointMenu` / `EnvOptionsMenu` (envelope editor, form `TMEnvEditor`), `WheelMenu` (control menu), `MLWheelMenu` (Multilink), `RecMenu` (recording filter), `TPluginForm` → FuncSheet panels `ACLFOPanel`, `AutomationEditorPanel`, `TargetLinksPanel`, `TopPanel`; `TEventEditForm` (focus tab STEP/SLIDE defaults); `TMEEventsToAutoTool` ("Convert to automation"); `TMIDIInputForm` (Remote control settings, smoothing default); `TMIDIForm` (General-settings defaults); `TShortcutsModule` (action captions and shortcuts) |
| L-STR | UTF-16/ASCII strings of the same library (MIN/MAX/TIME labels, hints, undo names, parameter display names) |
| L-CODE | Static disassembly (llvm-objdump) of the library's arm64 slice: envelope segment evaluator `0x58A690` (13-way switch), per-point precompute `0x588670`, tension-parameter init `0x572D00`, step-count helper `0x58B190`, formula `Tension()` `0x205490` (and its copy `0x96A1F0`). Constants read from `__TEXT,__const`: ln(10⁶), 0.6, 0.001, 0.9, 2⁻¹⁶, π/2, 2π |
| L-DEMO | `/Applications/FL Studio 2026.app/Contents/Resources/FL/Data/**/*.flp` (164 projects, FL 10.9 to 25.2.5): automation channel events, links, init values, Levels, playlist items, display groups, names, colours |
| L-IMG | Manual screenshots `img_shot/chansettings_autoclip.png`, `playlist_automation.png`, `playlist_automation_edit.png`, `playlist_focus_automation.png` (from the mirror) |

Community and third-party:

| Key | URL |
|---|---|
| X-PYFLP | https://github.com/demberto/PyFLP (`channel.py`: AutomationEvent, AutomationPoint, ChannelType, Levels used for Min/Max) |
| X-DAWVERT | https://github.com/DawVert/DawVert (`objects/file_proj/_flp/auto.py`: point struct incl. type/selected/t_sign, controller-address decoding, remote-control and init-value records; `plugins/input/mi_flp.py`) |
| X-F16467 | https://forum.image-line.com/viewtopic.php?p=16467 (2007: knob already at the clip's first value before the clip) |
| X-F17483 | https://forum.image-line.com/viewtopic.php?p=17483 (2007: value stays at the last played value after the clip; "Init song" as the fix) |
| X-F1889510 | https://forum.image-line.com/viewtopic.php?p=1889510 (FL 21.1.2 beta: clips at the playback cursor; staff promise an option) |
| X-THUNTER | https://thomashunter.name/blog/fl-studio-automations/ (2009: new clip = flat line at the current value in the first free track; Channel Rack switches to automation clips) |

Cross-references in this repo: `docs/research/main-playlist.md` (transport, stop and relocate semantics, song length), `mixer.md` (fader law, PDC), `sampler.md` and `channelrack-pianoroll.md` (channel control ranges).
