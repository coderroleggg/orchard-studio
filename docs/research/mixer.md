# FL Studio Mixer: Implementation Spec (Research)

Target behaviour: **FL Studio 21.x and FL Studio 2024 (24.x)**. Where FL 20 or FL 2025/2026 behave differently, it is called out (see also §11).
Compiled 2026-10-17. Primary source: the official FL Studio online manual. The current edition documents FL Studio 2026; an older English snapshot of the same pages, still hosted under the `-de` manual path, describes the pre-2025 mixer with 125 inserts and was used to cross-check FL 21/2024 behaviour. Supplementary sources: the FL Studio Python MIDI-scripting API, the full FL change log (bug and feature IDs), PyFLP (an open-source FLP parser), a community volume-to-dB lookup table, and Image-Line forum threads.

**Status tags used throughout**

| Tag | Meaning |
|---|---|
| **[C]** | Confirmed by the cited source (source keys are resolved to URLs in §13). |
| **[I]** | Inferred: derived from the sources by calculation, curve fitting or a consistency argument. The reasoning is given. |
| **[U]** | Uncertain or undocumented. A recommended clone default is given; verify it against a real FL 21/2024 install (checklist in §12). |

---

## 0. Quick reference

| Item | Value | Status |
|---|---|---|
| Insert tracks | 125, fixed (FL 12.9 to FL 2024). FL 2025+ adds dynamic add/delete, up to 500 | [C] PYFLP, M-NEW25 |
| Special tracks | Master (API index 0) and Current (utility track; API index 126 in FL 21) | [C] M-MIX, M-API; Current's index [I] |
| FX slots per track | 10 | [C] M-SLOTS |
| Fader normalized value | 0.0 to 1.0; default 0.8 = 0 dB | [C] STUBS |
| Fader maximum | 125% = +5.6 dB (linear gain about 1.90) | [C] PYFLP |
| Fader law | `g(v) = (e^(3v) − 1) / (e^2.4 − 1)` | [I] curve fit, §3.1 |
| Pan | −1 to +1 (100% L to 100% R), default 0. A "merge & pan" cross-mix, not a balance control | [C] M-API, M-MIX |
| Pan law | Circular (default) or Triangular; a per-project setting | [C] M-PROJ |
| Stereo separation | 100% separated to 100% merged; default centre = off | [C] M-MIX, PYFLP |
| Send level | 0 to 1 normalized, default 0.8 (0 dB); post-fader | [C] STUBS, M-MIX |
| FX slot mix | 0 to 100% wet, default 100% | [C] M-SLOTS, PYFLP |
| Built-in EQ | 3 fixed bands: low shelf, peaking, high shelf; ±18 dB; 10 Hz to 16 kHz | [C] M-PROPS, PYFLP |
| EQ default frequencies | 90 Hz, 1.5 kHz, 8 kHz | [C] PYFLP |
| Default routing | Every insert goes to Master at 0 dB. New channels go to Master (shown as `---`) | [C] M-MIX, M-CR |

---

## 1. Track inventory and default state

### 1.1 Tracks

| Track | API index | FLP id | Count | Notes | Status |
|---|---|---|---|---|---|
| Master | 0 | 0 | 1 | Final mix. Its Output selector must point at the device's main outputs or nothing is heard. Normal home of mastering FX | [C] M-MIX, M-API |
| Insert | 1 to 125 | 1 to 125 | 125 | Receives channels, sends and external inputs. Default names are "Insert N" (the manual refers to tracks such as "Insert 17") | [C] count; [I] naming |
| Current | trackCount()−1 (=126) | −1 | 1 | Utility track that receives the output of the currently selected track. Used to host analysers or recorders (Edison, Wave Candy). The manual warns that FX or EQ placed on Current apply to whichever track is selected | [C] M-MIX; index [I] from M-API (trackCount includes Master and Current, getTrackCount excludes them); FLP id [C] PYFLP |

Insert count history: 4 (FL 1.6.5), 8 (2.0), 16 inserts + 2 sends (3.0), 64 (4.0), 99 (9.0), 125 plus Master plus Current (12.9). FL 2025 introduced dynamic tracks with a 500 maximum [C] PYFLP, M-NEW25, F-2025B. Since FL 6.0.1 (2005), every insert can act as a send ("free track routing") [C] M-LOG.

### 1.2 Default state of a new project

| Parameter | Default | Status |
|---|---|---|
| Volume | v = 0.8 (0.0 dB) | [C] STUBS, PYFLP |
| Pan | 0 (centre) | [C] STUBS, PYFLP |
| Stereo separation | 0 (no effect) | [C] PYFLP |
| Polarity / swap | Off / off | [I] (insert flag bits default to 0 in PYFLP) |
| Mute / solo / lock | Unmuted, not soloed, unlocked | [I] |
| FX master switch | Enabled | [I] |
| FX slots | Empty. Each slot is enabled with mix at 100% | [C] PYFLP ("mix defaults to maximum"); [I] enabled |
| EQ | All gains 0 dB; frequencies 90 Hz, 1500 Hz, 8000 Hz; bandwidth raw value 17500 of 65536 | [C] PYFLP |
| Routing | Each insert is routed to Master with send level 0.8 (0 dB) | [C] M-MIX, STUBS |
| Audio input / output | (none). Master's output is the device's main outputs | [C] M-MIX |
| Recording pickup / monitoring | EXT (auto-selected when an external input is chosen); monitoring "When armed" | [C] M-NEW20 |
| Manual track delay (PDC offset) | 0 | [C] M-PROPS |
| Colour | Default track colour (#636C71 "granite gray" in the FLP) | [C] PYFLP |
| Dock | Inserts in the middle dock. Master docked left, Current docked right | [U] |
| Selected ("current") track | Master | [C] M-LOG #16387 (fix: selection resets to Master in a new project) |
| PDC mode | Automatic | [C] M-MENU |

---

## 2. Window layout

### 2.1 Header / toolbar

The manual lists these icons along the top of the window [C] M-MIX. Their left-to-right order here is [U].

| # | Element | Behaviour |
|---|---|---|
| 1 | Mixer menu (small triangle) | Opens the menu tree in §2.7 |
| 2 | Window title | Shows the selected track, e.g. "Mixer - Insert 3" [U] |
| 3 | Multi-touch control | Toggles multi-touch fader control. It is mutually exclusive with OS multi-touch gestures |
| 4 | Meter-wave view (Alt+W) | Replaces the peak meters with scrolling waveforms whose width equals the peak level |
| 5 | Extra mixer track properties | Shows or hides additional per-strip controls. Polarity and swap are the likely members [I]. Visibility also depends on window height and layout |
| 6 | Track inspector & FX panel (Ctrl+Enter) | Shows or hides the right-hand panel (§2.5) |
| 7 | "+" Add insert track(s), **FL 2025+ only** | Left-click adds one track after the selection. Right-click offers Add one / Add multiple… / Add from state. Middle-click opens the Add multiple dialog. A matching "+" appears after the last insert [C] M-MIX, M-NEW25 |
| 8 | Layout (view preset) selector | §2.2 [C] (changelog mentions a "mixer layout selector" in the title bar) |

### 2.2 Layout presets

- There are **8 view modes**, from Compact to Extra large. They interact with the window's width and height, and controls appear or disappear as the window size allows [C] M-MIX.
- The **default is "Wide"** (since FL 12.5) [C] M-LOG.
- Names confirmed in the sources: "Compact", "Compact alt", "Wide", "Extra large". The manual also calls the plugins-under-tracks view "Extra wide" [C] M-LOG, M-MENU, M-MIX.
- The probable full set is Compact, Compact 2, Compact alt, Wide, Wide 2, Wide 3, Wide alt, Extra large [I]. Reasoning: FL 12.0 shipped six layouts (Compact, Compact 2, Wide, Wide 2, Wide 3, Extra large per a third-party FL 12 review), and FL 12.9 added "two new layouts with track names at the bottom" [C] M-LOG.
- **Alt views** move the track names under the peak meters [C] M-MIX.
- **Extra large** shows each track's FX list under the strip. Left-click an FX to open it; right-click an empty slot to add one; right-click an FX for move up/down, replace and so on. The "Compact plugin list" view option removes empty rows and has been on by default since FL 12.5 [C] M-MIX, M-MENU, M-LOG.
- "Names at top" pins track names to the top of the window [C] M-MENU.

### 2.3 Track area

- **Three docks** (Left, Middle, Right) separated by track dividers. The left and right docks stay fixed while the middle dock scrolls. Any track can be docked with the context menu > Dock to. Clicking a splitter opens or closes the side dock [C] M-MIX, M-MENU.
- Each divider carries a **3-dot drag handle** that sets the relative height of the fader area and the peak-meter area [C] M-MIX. This implies that in Wide-type layouts the meters are a separately resizable region (changelog: "resizing the meters in the mixer's 'Wide' layout") [I].
- **Horizontal navigation:** a track scrollbar sits below the send switches, and the mouse wheel over track names or meters scrolls the tracks [C] M-MIX.
- The window can be stretched in both directions and detached [C].
- **Separators** are visual dividers inserted before a track; they are not docks. **Groups** are separators on both sides plus a name and icon. "Auto color group" copies a colour across the group [C] M-MENU.
- Master sits at the left (fixed) and Current at the far right [U]. This is consistent with the API order, where Master is 0 and Current is last.

### 2.4 Strip composition

Elements confirmed to exist on every strip [C] M-MIX:

- Track label (number and name, optional icon). Coloured with the track colour on the top part only, unless "Colorful mixer" is enabled [C] M-MENU.
- Stereo peak meter, or a waveform in wave view.
- Pan knob and stereo separation knob.
- Mute switch, drawn as an LED. The theme has a dedicated "Mute LED" colour [C] M-THEME.
- Invert polarity and swap L/R icons.
- FX master switch, track delay (PDC) icon and record arm switch.
- Vertical volume fader. A small dB "volume label" accompanies it [C] M-LOG #11530 ("increased brightness of volume label on mixer tracks"). The dB readout appears only on the active track [I] F-1188392.
- Send switch, which becomes a send-level knob once a route exists, at the bottom. The track scrollbar sits below the send switches [C].

**Recommended top-to-bottom order for the default Wide layout** [U]. Verify against a screenshot; only the bottom routing row and the scrollbar position are confirmed.

1. Header: track number, name, icon.
2. Peak meter region (resizable with the divider handle).
3. Mute LED, pan knob, stereo separation knob.
4. Polarity and swap icons (when extra properties are shown).
5. Volume fader with its dB label.
6. FX master switch, track delay, record arm.
7. Routing row: send switch or send knob, plus routing cables.
8. Extra large only: the per-track FX list.

The Master strip has the same composition apart from routing. Master cannot be a send destination of itself, and the clone should not offer master-to-insert routes [I].

### 2.5 Track inspector (right-hand "FX panel")

- It always shows the **selected track only** [C] M-PROPS.
- It is docked right by default; "Track inspector on left side" moves it [C] M-MENU. The older manual says the panel holds the FX slots, Track Properties and Track I/O [C] M-MENU-OLD.
- Contents. The components are [C]; the top-to-bottom order is [I].

| Section | Contents | Status |
|---|---|---|
| Header | Track name | [I] |
| Input | Recording-pickup selector (EXT / MIX / FX / EQ / LVL / POST) in front of the Input menu, which also holds the monitoring modes. Input device selector. Input delay compensation (IDC) icon | [C] M-PROPS, M-MIX |
| FX slots 1–10 | Per slot: menu arrow, name label, enable LED, mix knob (§6) | [C] M-SLOTS |
| Built-in EQ | Response graph plus per-band controls (gain slider, frequency knob, width knob) (§9) | [C] graph; [I] controls (changelog mentions "mixer track EQ sliders" and "EQ Width knobs") |
| Output | Output device selector, track latency (PDC) selector, and "Delay audio output" options (FL 2024.2+) | [C] M-PROPS |

### 2.6 Visual states

| State | Visual | Status |
|---|---|---|
| Selected track | Fader turns green and the track is highlighted | [C] M-MIX |
| Multi-selection | All selected faders turn green. The first-selected (or right-clicked) "this track" target is slightly lighter | [C] M-MIX |
| Alternative highlighting (view option) | Square brackets around the first selected track; contrasting header text | [C] M-MENU |
| Armed | Arm switch red; fader orange | [C] M-MIX |
| Default fader | Grey | [C] M-MIX |
| Muted | Mute LED dark. The LED means "enabled" (green = playing) | [I] (API enableTrack, PYFLP "Enabled" flag) |
| Mute-locked | Lock icon on the LED | [C] M-LOG ("mute lock icon") |
| FX master switch | Dark grey and unresponsive when the track has no FX. Lit (orange) when FX are loaded and enabled | [C] M-MIX, M-SLOTS |
| Track delay icon | Grey = no value; orange = automatic PDC; blue = manual offset; yellow when a source channel has delay | [C] M-MIX; M-LOG #14137 |
| Routing (relative to the selected track) | Selected track: downward green arrow. Other tracks: up-arrows mark available sends and are clickable. An active route shows a level knob. Tracks that feed the selected track show a greyed switch (unavailable). Small up-arrows mean another track is already sending here. A low-contrast cable means the send level is at minimum (sidechain only) | [C] M-MIX "Routing Iconography" |
| Routing cables (View option) | Animated ("jiggly") cables from the selected track to each destination. A cable to Master drops off the bottom of the mixer | [C] M-MIX, M-MENU |
| Track colour | Header only. "Colorful mixer" Off / Low / Medium / High tints the whole strip | [C] M-MENU |
| Lines between tracks (option) | Subtle separator lines | [C] M-MENU |

### 2.7 Mixer menu (complete tree)

All items [C] M-MENU, M-MENU-OLD. The version that introduced an item is noted where known.

- **Options › Disk recording:** Render armed tracks to wave file(s) (Alt+R) · Render selected tracks… (Shift+Alt+R, FL 21+) · Auto-unarm · Auto-create audio clips · Latency compensation · Auto-name playlist tracks · Group loop recorded takes · bit depth (16/32; 24-bit added in FL 2026; older builds had a "32-bit float recording" toggle).
- **Options › Plugin delay compensation:** Reset manual latency on all tracks · Automatic (default for new projects) · Compensate automations (FL 20.7+).
- **Options:** Link all parameters…
- **View:** Waveforms (Alt+W) · Names at top · Routing cables · Compact plugin list · Small text in plugin lists (20.9+) · Track inspector on left side · Colorful mixer (Off/Low/Medium/High) · Alternative mixer highlighting · Lines between tracks · Always show external input levels (20.9.1+).
- **Detached · Remove all Edison instances.**
- **Mixer track:** Rename, color & icon… (F2) · Assign to new audio track(s) · Unassign from audio track(s) · File › Open / Save mixer track state, Browse states · Open audio editor (Ctrl+E) · Open audio editor and record · Reset selected track(s) to default.
- **Routing › Channel routing:** Route selected channels to this track (Ctrl+L) · …starting from this track (Shift+Ctrl+L).
- **Routing › Track routing › Selected tracks to this track:** Route · Route … only · Sidechain · Sidechain … only · Create submix…
- **Routing › Track routing › This track to selected tracks:** Route · Route … only · Sidechain · Sidechain … only.
- **Routing › Select:** Channels routed to this track (Alt+L) · Channels and playlist tracks routed to this track (2024.2+) · Tracks this one is routed to · Tracks routed to this one (Ctrl+Alt+L).
- **Routing:** Reset selected track(s) routing · Solo (S) · Alt Solo (Alt+S). FL 2025+ adds "Unroute tracks routed to the selected track(s)".
- **Group:** Separator · Create group… · Auto color group.
- **Layout:** Dock to (Left / Middle / Right) · Move left · Move right · Delete (2025+) · Insert (2025+) · Trim unused tracks (2025+).
- **CPU:** Allow threaded processing.

The track label's right-click menu mirrors the Mixer track, Routing, Group and Layout sections.

---

## 3. Controls reference

### 3.1 Volume fader

| Property | Value | Status |
|---|---|---|
| Normalized value v | 0.0 to 1.0 | [C] STUBS, M-API |
| Default | v = 0.8, which is 0.0 dB | [C] STUBS, PYFLP |
| Maximum | v = 1.0: "125%", +5.6 dB, gain 1.90 | [C] PYFLP |
| Minimum | v = 0: −inf dB | [C] PYFLP |
| FLP raw value | 0 to 16000, default 12800 (v = raw / 16000) | [C] PYFLP |
| Typed-in / percent display | P = 125·v %, so 100% = 0 dB and 125% = max. Typed values are entered as decimals or percent, not dB | [I] from PYFLP's percentages plus F-DB79 ("−5 dB is 79%"); [C] F-DB79 for the decimals |
| Hint while dragging | dB (e.g. "−1.1dB") | [C] F-DB79, F-HINT |
| Snap | Pauses at the default (0 dB) while dragging; hold Shift to avoid snapping | [C] M-UI (applies to all knobs and sliders) |
| Position in chain | Post-effect: after the FX slots and the EQ | [C] M-MIX |

**Position-to-gain law** [I]:

```
g(v)  = (e^(3·v) − 1) / (e^2.4 − 1)          where e^2.4 − 1 ≈ 10.023176
dB(v) = 20·log10(g(v))
v(g)  = ln(1 + g·(e^2.4 − 1)) / 3
```

Evidence:

- The law fits a community-measured lookup table of 70 points (values read back from FL through `mixer.getTrackVolume(i, 1)`, from +5.6 dB down to −70 dB) with a mean absolute error of 0.04 dB [VOLCONV].
- It gives g(1) = 1.9041 (+5.594 dB), matching PYFLP's "125% / 5.6dB / 1.90", and g(0.8) = 1 exactly.
- It maps −5 dB to v = 0.6309, i.e. 78.9%, matching the forum's "−5 dB is 79%".
- Character of the curve: near the top, dB is almost linear in position (about 0.036 of travel per dB). Near the bottom it becomes amplitude-linear: v = 0.0104 is −50 dB and v = 0.0033 is −60 dB.

Reference points:

| v | Typed % | Gain | dB |
|---|---|---|---|
| 1.000 | 125.0 | 1.904 | +5.59 (shown +5.6) |
| 0.906 | 113.3 | 1.413 | +3.0 |
| 0.800 | 100.0 | 1.000 | 0.0 |
| 0.697 | 87.1 | 0.708 | −3.0 |
| 0.599 | 74.8 | 0.501 | −6.0 |
| 0.506 | 63.2 | 0.355 | −9.0 |
| 0.419 | 52.4 | 0.251 | −12.0 |
| 0.272 | 34.0 | 0.126 | −18.0 |
| 0.163 | 20.4 | 0.063 | −24.0 |
| 0.092 | 11.5 | 0.032 | −30.0 |
| 0.032 | 4.0 | 0.010 | −40.0 |
| 0.0104 | 1.3 | 0.0032 | −50.0 |
| 0.0033 | 0.4 | 0.0010 | −60.0 |
| 0 | 0 | 0 | −inf |

Fader behaviours:

- Clicking the rail above or below the handle starts a smooth glide toward that point instead of a jump [C] M-MIX. The glide speed is [U].
- Left-drag changes the value. Ctrl+drag, or dragging with both mouse buttons held, gives fine control. Alt+click or a middle-click resets to the default [C] M-UI.
- The right-click menu holds the standard automatable-control items: Edit events (also in a new window or the piano roll), Init song with this position, Create automation clip, Link to controller…, Copy / Paste value, Type in value…, Set… (opens a larger control), and Reset [C] M-UI, M-TOOLS, M-MIX.
- Left-clicking the fader selects the track [C] M-MIX.
- **Multi-selection:** dragging one selected fader moves every selected fader while keeping their relative dB offsets [C] M-MIX, M-LOG #11070. Each fader is clamped at its maximum [C] M-LOG #20809 (fix). Tracks sitting at −inf need special handling (FL had a bug, #12996, "linked faders behave oddly around inf dB"). Clone default [U]: apply the dB delta, and for tracks at v = 0 apply the equivalent delta in v instead.
- The mouse wheel adjusts the fader [I]; the step size is [U] (suggest 1/100 of the range per notch, finer with Ctrl).
- Fader colours: grey, green when selected, orange when armed [C].

### 3.2 Pan knob

| Property | Value | Status |
|---|---|---|
| Range | −1.0 (100% left) to +1.0 (100% right) | [C] M-API, STUBS |
| Default | 0 (centre) | [C] |
| FLP raw value | −6400 to +6400, linear | [C] PYFLP |
| Display | Percent left / right, e.g. "35% left", "Centered" | [U] |
| Algorithm | **Merge & pan**: cross-channel mixing that pours one side into the other, not a balance control. At 100% pan the output is the mono sum of L and R on one side | [C] M-MIX, M-SHAPER, M-BAL, F-PANMESS |
| Pan law | **Circular (default)** or Triangular, set in Project settings › Advanced › Panning law. It is stored per project and affects all panning | [C] M-PROJ, M-MIX |
| Snap | Pauses at centre | [I] (generic snapping, M-UI) |
| Position in chain | After stereo separation and volume | [C] order listed in M-MIX |

The DSP model is in §4.3.4. Note: Channel Rack panning is a balance control, unlike mixer pan [C] F-PANMESS.

### 3.3 Stereo separation knob

| Property | Value | Status |
|---|---|---|
| Range | Fully counter-clockwise = 100% separated (wider); fully clockwise = 100% merged (mono) | [C] M-MIX |
| Default | Centre, which disables the effect | [C] M-MIX |
| FLP raw value | +64 = 100% merged, −64 = 100% separated, 0 = no effect | [C] PYFLP |
| API | −1.0 to +1.0. The community docs say −1 = "100% centered" and +1 = "100% separated", the opposite sign to the FLP raw value | [C] M-API range; STUBS orientation (unverified) |
| Effect on mono input | None, because it works on the L−R difference | [C] M-MIX |
| Maximum strength | About 98% for both separation and merging (stated for Fruity Stereo Enhancer, which "is the same process as the Mixer" control) | [C] M-ENH |
| Display | "NN% separated" / "NN% merged" | [U] |
| Mono check | Turning it fully clockwise is the documented way to monitor a track in mono | [C] M-MIX |

The DSP model is in §4.3.2.

### 3.4 Polarity invert and channel swap

| Control | Behaviour | Status |
|---|---|---|
| Invert polarity | Toggle. Flips the sign of the signal so positive peaks become negative (both channels) | [C] M-MIX |
| Swap channels | Toggle. Exchanges L and R | [C] M-MIX |
| Storage | Insert flags `PolarityReversed` and `SwapLeftRight` | [C] PYFLP |
| API | `revTrackPolarity`, `swapTrackChannels` (value −1 toggles, 0 off, 1 on) | [C] M-API |
| Undo | Undoable since FL 2025 | [C] M-LOG #19726 |

### 3.5 Mute switch (LED): clicks

| Gesture on the track's mute LED | Action | Status |
|---|---|---|
| Left-click | Mute / unmute | [C] M-MIX |
| Right-click | Solo / unsolo | [C] M-MIX, M-LOG #19422 |
| Ctrl+left-click | Solo / unsolo | [C] M-MIX |
| Alt+left-click | "Alt solo": solo the track plus every track routed to it and from it | [C] M-MIX, M-API (solo mode 3 is "same as Alt+click") |
| Shift+left-click | Lock / unlock the mute state. Locked tracks are not changed by solo or unmute-all | [C] M-MIX; [I] lock semantics (M-LOG #17897, #12307) |
| Ctrl+right-click | Unmute all | [C] M-MIX |

Solo and mute semantics are in §8.2.

### 3.6 Record arm

- Left-click arms the track (red). Right-click arms it and offers record-file naming [C] M-MIX.
- An armed track's fader turns orange [C].
- Since FL 20.8.4 a track can be armed without an external input [C] M-LOG #10430.
- Mixer menu > Render armed tracks (Alt+R) bounces the armed tracks [C].

### 3.7 FX master switch

- Left-click enables or disables every slot effect on the track. It respects multi-selection: Ctrl+A then a click toggles FX on all tracks [C] M-MIX, M-NEW21.
- Right-click opens or closes every effect editor on that track [C].
- With no FX loaded it is dark grey and does nothing [C].
- It corresponds to the API/FLP "Enable effect slots" flag [C] M-API, PYFLP.
- Whether it also bypasses the built-in EQ is [U]. Clone default: slots only.

### 3.8 Track delay (manual PDC offset)

- Clicking the icon opens a menu: Reset · Set in ms · Set in samples · Set in beats · Set from (lists tracks that have plugin latency) [C] M-PROPS.
- Mouse wheel over the icon or display: 10 ms steps; Ctrl+wheel 1 ms; Ctrl+Alt+wheel 1 sample [C] M-PROPS.
- A positive value delays this track; a negative value delays all other tracks. Manual values act as offsets on top of automatic PDC [C].
- Colours are listed in §2.6. Hovering shows the detected latency in the hint bar [C].

### 3.9 Send switch and send level knob

| Property | Value | Status |
|---|---|---|
| Send level (normalized) | 0 to 1, default 0.8 | [C] STUBS ("for the default volume, use 0.8") |
| Law | Same as the fader: 0.8 = 0 dB, 1.0 ≈ +5.6 dB | [I] (same 0.8 default and dB hint) |
| Hint | dB (since FL 20.9) | [C] M-NEW20, M-LOG #11194 |
| Tap point | Post-fader | [C] M-MIX |
| Level 0 | Sidechain-only link (inaudible, but still available to sidechain-capable plugins) | [C] M-MIX |

UI behaviour (all relative to the selected track) [C] M-MIX:

- **Left-click** the send switch on a destination track to create a route from the selected track. The switch is replaced by a level knob.
- **Remove a route** with the small deselect switch attached to the knob. Alternatively, turn the level to 0 to keep only the sidechain link.
- **Right-click** the switch or deselect switch for a menu that routes or sidechains with the source's Master send disabled. Known items: "route … only" and "Sidechain only to this track"; "Sidechain to this track" is a macro that creates the route with level 0 [C]. The exact item labels are [I].
- Alt+click removes routing; in FL 2025 it works on multi-selections [I] M-LOG #19874.

### 3.10 Input / output selectors

- Each track has one stereo input and one stereo output. The input list offers stereo pairs at the top and mono inputs below. Several tracks may share an input or output [C] M-MIX.
- Right-click the Input or Output menu for "Auto map" (maps device channels to consecutive tracks, starting at the selection) or "Reset mapping" [C] M-MIX.
- FL 2026: Alt+left-click resets a selector to "(none)" [C] M-LOG #22015.
- **Recording pickup** (FL 20.9+), the point the recording is taken from [C] M-PROPS:

| Code | Taken from | Notes |
|---|---|---|
| EXT | Direct external input | Recommended for takes |
| MIX | External input plus internally routed audio, before the FX slots | Was "PRE" before FL 20.9 |
| FX | After the last FX slot | |
| EQ | After the built-in EQ | |
| LVL | After volume and pan | Was "POST" before FL 20.9 |
| POST | After the mute switch | |

- **Monitor external input:** Off / When armed / On; the default is When armed [C] M-PROPS, M-NEW20.
- **Input delay compensation:** values in ms, samples or beats; positive moves the recording earlier. "Adjust position of recorded audio" (FL 21) also compensates plugin latency [C].
- **Output side:** PDC selector. "Delay audio output" (FL 2024.2+) bypasses PDC for low-latency monitoring, with modes Never / Always / When recording or not playing [C] M-PROPS, M-NEW24.
- Web clone mapping (design): the input maps to `getUserMedia` channel pairs; the Master output maps to `AudioContext.destination`; other outputs are optional and only possible when multichannel output is available.

### 3.11 FX slot controls: see §6.

### 3.12 Built-in EQ: see §9.

---

## 4. Signal flow inside a track

### 4.1 Processing order

```
 Channel Rack channels routed here ─────────┐   (channel vol/pan applied upstream)
 Sends from other tracks (× send gain) ─────┼──► Σ input ──► [MIX tap]
 External input (if monitored) ─────────────┘
   ──► FX slot 1 → FX slot 2 → … → FX slot 10   (each: plugin, enable, mix)   ──► [FX tap]
   ──► Built-in 3-band EQ (low shelf → peaking → high shelf)                  ──► [EQ tap]
   ──► Polarity invert → Swap L/R → Stereo separation
   ──► Volume fader → Pan                                                     ──► [LVL tap]
   ──► Mute                                                                   ──► [POST tap]
   ──► Track output ──► route to Master (× send gain)
                    ──► routes to other tracks (× send gain each)
                    ──► sidechain feeds (independent of send gain)
                    ──► audio-device output (if set)
                    ──► Current track (when this track is selected)
                    ──► peak meter
```

| Step | Status / evidence |
|---|---|
| Input summing of channels, sends and external input | [C] M-MIX, M-PROPS (the MIX tap includes "external input and internally routed tracks") |
| FX slots 1 to 10, top to bottom | [C] M-SLOTS |
| EQ after the FX slots | [C] M-PROPS ("integrated effects are the last processing stage… follow any plugin FX") |
| Order EQ, phase, stereo separation, volume, panning | [C] M-MIX lists the integrated effects in that order |
| Swap placed next to polarity | [I] |
| Volume and pan before the LVL tap; mute after it, before POST | [C] M-PROPS |
| Muted tracks keep processing (mute is a gain stage) | [I] (the LVL tap is pre-mute and FL can record "post" while ignoring mute, M-LOG #11072) |
| Sends are post-fader | [C] M-MIX |
| Sends are post-pan and post-mute | [I] |
| Meter tap: final post-mute output | [I]. Rationale: the "Always show external input levels" option exists to make meters react to unmonitored inputs, so normally they show only what passes through |
| Pre-fader sends | Not native. Done with the Fruity Send plugin placed in an FX slot [C] M-MIX |

### 4.2 Current track tap [U]

The documentation says only that Current receives the selected track's output and that FX or EQ on Current "apply to any selected track" [C].

Clone default [U]: feed Current with a copy of the selected track's post-mute output and do **not** sum Current into Master, so selecting a track never doubles its level. Meter it, and let plugins on Current (analysers, recorders) process it. Flag for verification (§12, test T7).

### 4.3 DSP formulas

L and R are the per-sample channel values entering each stage.

**4.3.1 Polarity and swap** [C]:

```
polarity:  L' = −L,  R' = −R
swap:      L' = R,   R' = L
```

**4.3.2 Stereo separation** [I]. The model follows the Stereo Shaper tutorial, which states that the mixer separation knob uses the same processes: an inverted cross-mix for expansion and a cross-mix to 50/50 for reduction [C] M-SHAPER.

Let k ∈ [−1, +1] be the knob value: +1 fully clockwise (merged), −1 fully counter-clockwise (separated). This is the FLP raw value divided by 64.

```
k ≥ 0 (merge):     b = k/2
                   L' = (1−b)·L + b·R
                   R' = (1−b)·R + b·L
                   in mid/side terms: M' = M, S' = (1−k)·S   → k = 1 gives L' = R' = (L+R)/2

k < 0 (separate):  c = |k|/2
                   L' = L − c·R
                   R' = R − c·L
                   in mid/side terms: M' = (1−c)·M, S' = (1+c)·S
                   → k = −1: centre content at 50% (−6 dB), side content at 150%
```

Here M = (L+R)/2 and S = (L−R)/2. No make-up gain is applied; the manual notes that separation can change the output level [C] M-ENH. Optionally scale |k| by 0.98 to match the "around 98%" note [U].

**4.3.3 Volume:** `L' = g(v)·L`, `R' = g(v)·R`, with g from §3.1 [I].

**4.3.4 Pan (merge & pan)** [I]. Facts the model must satisfy:

1. A 100% pan outputs the mono sum on one side [C] M-MIX.
2. It works by adding one channel into the other while reducing the source channel by the same amount [C] M-SHAPER.
3. With the Circular law, a mono source summed to mono reads 3 dB lower at the sides than at the centre [C] F-PAN20. That is the constant-power signature.
4. Circular: "level drops 3 dB at center"; Triangular: no compensation, its overall level 3 dB below the Circular extremes [C] M-PROJ.
5. A default (centred) track must be transparent [I].

Let p ∈ [−1, +1] and a = |p|.

```
Cross-mix (p < 0, pan left):   L1 = L + a·R ,   R1 = (1−a)·R
Cross-mix (p > 0, pan right):  R1 = R + a·L ,   L1 = (1−a)·L
Law normalisation:             L' = κ(a)·L1 ,   R' = κ(a)·R1

Circular (default):  κ(a) = 1 / sqrt(1 + a²)
   → mono input x: near side (1+a)·x/√(1+a²), far side (1−a)·x/√(1+a²); total power constant
   → hard pan: near side = (L+R)/√2, i.e. +3.01 dB for a mono source; far side silent

Triangular:          κ(a) = 1 / (1 + a)            [U]
   → mono input: near side stays at 0 dB, far side falls as (1−a)/(1+a)
   → satisfies facts 4 and 5 (extremes 3 dB below Circular)
```

Circular gains for a mono source under this model: a = 0.25 gives +1.67 / −2.76 dB; a = 0.5 gives +2.55 / −6.99 dB; a = 0.75 gives +2.92 / −13.98 dB; a = 1 gives +3.01 dB / −inf.

The angle mapping is not documented. A standard √2·sin/cos law (θ = π/4·(1+a)) satisfies the same endpoint facts but differs mid-travel (a = 0.5 gives +2.32 / −5.33 dB). Pick one and verify (§12, test T3).

**4.3.5 Mute:** gain 0 or 1 after pan. Ramp it over about 5 ms to avoid clicks [U]; FL's declick time is undocumented.

**4.3.6 Parameter smoothing** [U]. FL applies automatic smoothing to mixer parameters; the API exposes smoothing-related calls such as `getAutoSmoothEventValue` and the `smoothTarget` argument [C] M-API. Clone default: smooth volume, pan, separation, send and mix changes over about 10–20 ms per sample block.

**4.3.7 Headroom:** the engine is 32-bit float. Inserts cannot meaningfully clip; only Master, a track routed to a hardware output, or a fixed-bit-depth render can clip [C] M-MIX, M-LEVELS. Do **not** clamp internal buses.

---

## 5. Routing

### 5.1 Graph model

- **Nodes:** Master, Inserts 1 to 125, Current.
- **Edges** (insert to track): each edge has a send level (0 to 1, default 0.8) and carries both an audible path (scaled by the level) and a sidechain path (unscaled) [C] M-MIX ("two independent audio paths"). An edge at level 0 is "sidechain only".
- **Default:** every insert has exactly one edge, to Master at 0.8 [C].
- **Channel to track:** each Channel Rack channel has a target track index. 0 means Master, displayed `---` and used for every new instrument channel; 1 to 125 select an insert [C] M-CR, M-CS.
- **Any track to any track:** routes are not restricted to higher-numbered tracks (all tracks can be sends since FL 6.0.1) [C] M-LOG ("enhanced free track routing").

### 5.2 Routing operations

| Operation | Effect | Status |
|---|---|---|
| Left-click the send switch on track D (with S selected) | Toggle the S → D route at level 0.8 | [C] M-MIX |
| "Route … to this track only" | Create S → D and remove S → Master | [C] M-MIX, M-MENU |
| "Sidechain to this track" | Create S → D at level 0 | [C] M-MIX |
| "Sidechain … only" | As above and remove S → Master | [C] M-MENU |
| Route selected to this track / …only / Sidechain selected… | Batch version: every selected track to the right-clicked track | [C] M-MENU |
| Route this track to selected / …only / Sidechain this track to selected… | Right-clicked track to every selected track | [C] M-MENU |
| Create submix… | Prompts for a name. The selected tracks route to the right-clicked track, which routes to Master. Removing the selected tracks' Master routes is [I] | [C] M-MENU |
| Reset selected track(s) routing | Back to the default single route to Master; also resets send levels (fixed in FL 2024) | [C] M-MENU, M-LOG #12021 |
| Unroute tracks routed to selected (FL 2025+) | Removes incoming routes | [C] M-NEW25 |
| Delete track (FL 2025+) | Tracks that fed the deleted track are re-routed to its destinations | [C] M-NEW25, M-LOG #19603 |

### 5.3 Sidechain semantics

- The source signal is available to sidechain-capable plugins on the destination track (Fruity Limiter, Vocodex and others), but it is not heard there unless a plugin passes it through [C] M-MIX.
- Direction depends on the plugin. Fruity Limiter receives a sidechain; Stereo Shaper sends one to a track. A plugin's sidechain selector lists only tracks connected in the right direction [C] M-MIX.
- The sidechain feed is the source's output, independent of the send level [I] (a level-0 send still provides it).
- A source keeps its Master route unless that route is removed, so the source remains audible [C] M-MIX.

### 5.4 Cycle prevention

- While S is selected, every track that routes to S is shown as a greyed, unavailable send switch, which prevents feedback loops [C] M-MIX.
- Clone rule [I]: disallow S → D whenever D can already reach S through existing routes (a transitive check), and grey those switches. Master can never route to an insert [I].

### 5.5 Processing order and latency

- Process tracks in topological order of the routing graph, with Master last and Current after the selected track [I].
- No extra buffer delay is introduced by "backward" routes in the clone [U].

### 5.6 Plugin delay compensation (PDC)

Behaviour [C] M-PROPS, M-MENU:

- Automatic PDC is on for new projects. It detects plugin latency, for both instruments and effects, and delays the other paths so everything arrives aligned at Master. It covers inter-track routing, multi-in/out plugins and sidechains.
- Manual offsets are added on top of automatic PDC.
- "Compensate automations" (FL 20.7+) time-aligns FX automation with the delayed audio.
- "Delay audio output" (FL 2024.2+) can skip PDC on tracks sent straight to a hardware output while monitoring.

Clone algorithm [I]:

1. Per track, compute `L_own` = sum of slot-plugin latencies + manual offset.
2. Arrival latency `A(t)` = max over inputs (`A(src) + L_own(src)`) for routed sources, and channel latency for channels.
3. Insert compensation delays of `A(t) − (A(src) + L_own(src))` on each shorter input edge (sidechain edges included).
4. A negative manual value is implemented as a delay on all other tracks.

### 5.7 Channel Rack to insert targeting

| Item | Behaviour | Status |
|---|---|---|
| Default target for new instrument channels | Master, shown as `---` | [C] M-CR, M-CS |
| Mixer track selector (Channel Rack, Alt+M toggles visibility) | Drag vertically to change the target | [C] M-CR |
| Channel Settings "TRACK" label click | Assigns the first free insert and names it after the channel | [C] M-CS, M-MIX |
| Ctrl+L in the Channel Rack | Assign the selected channels to free mixer track(s) | [C] M-CR |
| Ctrl+L in the Mixer | Route the selected channels to the selected mixer track | [C] M-KEYS |
| Shift+Ctrl+L in the Mixer | Route the selected channels starting at the selected track (one per track, ascending) | [C] M-MENU |
| Drop an instrument from the browser or plugin picker onto a mixer track | Creates a channel routed there and names the track after the instrument | [C] M-MIX |
| Drop a sample onto a mixer track (FL 2024+) | Creates a sampler channel linked to that track | [C] M-LOG #3957 |
| Instrument / Audio Track modes (Playlist) | Lock channel-to-track routing; the selector dims and moves the mixer track instead of re-routing | [C] M-CR |
| "Auto select linked modules" (General settings) | Selecting a channel also selects its linked mixer track | [C] M-GEN |
| Metronome and Preview targets | Audio settings; default `---` (Master) | [C] M-AUDIO |

Templates: the default template's channels and Master FX (for example a limiter on Master) depend on the template, not on the mixer itself [U]. The manual hints that a limiter "may be there already" on Master [C] M-LEVELS.

---

## 6. Effect slots

### 6.1 Per-slot controls

| Control | Range / behaviour | Default | Status |
|---|---|---|---|
| Menu arrow (left end of the slot) | Left-click: slot menu (Select when empty, Replace when occupied). Right-click: plugin picker. Middle-click: "More plugins" | none | [C] M-MIX |
| Name label | Left-click opens or closes the plugin editor. Right-click renames the slot. "Auto name effects slots" names slots after the preset | Plugin name | [C] M-SLOTS, M-FX, M-GEN |
| Enable / disable LED | Bypass. The effect is disabled and the dry signal passes through unchanged. Automatable. Same click gestures as the track mute LED: Ctrl+click solos the slot (disables the others), Shift+click locks | Enabled | [C] M-SLOTS, M-MIX |
| Mix knob | 0% = dry only, 100% = fully processed. FLP raw −6400 to +6400 | 100% | [C] M-SLOTS, PYFLP |
| Slot colour | Per-slot colour (API `getSlotColor`); "Random color" added in FL 2024 | none | [C] M-API, M-NEW24 |

Notes:

- The manual advises keeping mix at 100% and using the plugin's own dry/wet, because latent plugins phase-cancel against the dry path [C] M-FX.
- **Mix DSP** [I]: `out = (1 − m)·dry + m·wet` with m = mix/100.
  - Evidence: when a slot is Patcherized, FL reproduces a custom mix with two wires (dry and wet), and a muted slot becomes mix level 0 [C] M-MIX. This supports both a linear crossfade and "disabled ≡ mix 0".
  - Equal-power versus linear crossfade is [U]; use linear.
  - Delay the dry path by the plugin's latency when PDC is on [U] (FL does not appear to; the manual warns about phase cancellation).
- **Processing when disabled:** the slot passes audio unprocessed. Whether the plugin still runs in the background (keeping tails) is [U]. Clone default: skip `process()` and let the plugin's own "Smart disable" mechanism handle CPU.
- Deleting a disabled slot's plugin re-enables the slot (FL 2024) [C] M-LOG #8940.
- Empty-slot menu: in FL 21/2024 the menu opens with a "Select" submenu (favourites, More…), and items that need a loaded plugin are disabled or hidden [C] M-SLOTS. FL 2026 shows only the plugin selection list [C] M-NEW, M-MIX.

### 6.2 Reordering and copying

- Mouse wheel over a slot moves its effect up or down. The mixer must have focus, and the mouse must stay still [C] M-SLOTS.
- Slot menu Move up / Move down; the 'u' and 'd' keys work while the menu is open [C].
- Drag the slot menu's "Save preset as…" item onto another track or slot to copy the effect with its settings [C].
- Dragging the "Save mixer track state" icon onto another track duplicates the whole FX chain [C] M-MENU.

### 6.3 Slot menu items

Items requiring a loaded plugin are hidden when the slot is empty [C] M-MIX, M-SLOTS.

- Select / Replace (favourites, More…)
- Delete (resets the slot to empty)
- Patcherize, Patcherize all (FL 2025+)
- Presets submenu (presets, Randomize, Hybridize, tree display)
- Browse presets
- Save preset as… (draggable)
- Add to plugin database (flag as favourite)
- Display preset name in preset selector
- Store in spare state / Flip with spare state
- Link all parameters… / Browse parameters
- Allow threaded processing
- Smart disable
- Move up / Move down
- View editor
- Rename, color and icon… (F2) / Random color / Change color… / Change icon…
- Help

### 6.4 Track-level FX behaviour

- The FX master switch (§3.7) disables all slots. It works on multi-selections, and FL 21+ applies bypass to all selected tracks [C].
- More than 10 effects means routing to another track or using Patcher [C].

---

## 7. Peak meters

| Aspect | Specification | Status |
|---|---|---|
| Data | Per-channel peak (L, R) as linear amplitude: 1.0 = 0 dBFS, values above 1.0 are overs. The API also exposes the max of L and R | [C] M-API (`getTrackPeaks`, PEAK_L / R / LR) |
| Display unit | dB. Hovering shows the level at the pointer position in the hint bar; hovering at the peak marker reads the actual peak | [C] M-MIX, M-GEN, M-TB |
| Layout | Two bars (L, R) per strip | [I] |
| Over 0 dB | Meter segments above 0 dB turn **orange** | [C] M-LEVELS |
| Clip latch | No latching clip LED is documented for mixer strips | [U]. Clone default: none (FL's main toolbar meter "turns red" when clipping [C] M-TB) |
| Scale | Default scale, plus a global "Alternate meter scale" option that shows a narrower band above and below 0 dB. 0 dB sits "almost" at the top, and peaks above 0 dB remain visible up to a limit | [C] M-GEN, M-DB, M-LEVELS |
| Scale mapping | Not documented | [U] |
| Ticks / labels | FL 12+'s large Current meter uses 3 dB sections. Narrow strips are read by hovering | [C] F-METER12 for the 3 dB sections; [U] for strip labels |
| Ballistics | Bars fall gradually, leaving a peak "tail", rather than resetting instantly | [C] F-PEAKHOLD |
| Peak marker | A peak position marker exists | [I] (M-GEN wording) |
| Wave view | Alt+W replaces the meters with waveforms whose width equals the peak level | [C] M-MIX |
| Colours | Theme-defined gradient with per-dB-band start and end colours. Mixer meter colours have been separately themeable since the FL 21 betas | [C] M-THEME, M-LOG #14266 |
| Tap point | Post-mute track output | [I] (§4.1) |
| External input | Meters ignore unmonitored external input unless "Always show external input levels" is on | [C] M-MENU |
| Current meter | Shows the selected track's level | [C] M-LOG #19501, #19612 |

Clone defaults for the [U] items above:

- **Scale mapping:** use the fader law, `y = v(g)` from §3.1, so 0 dB sits at 80% of the meter height, the top is +5.6 dB and −30 dB is about 9% up. The alternate scale can be a linear-dB window from −24 to +6 dB.
- **Ticks:** every 3 dB from +3 to −24, then −30, −40, −60. No numeric labels on narrow strips; show labels in Wide and Extra large.
- **Ballistics:** instant attack; release about 24 dB/s; peak-hold marker held about 1.2 s, then falling at the same rate. Tune by eye against FL footage.
- **Colours:** a green-to-yellow gradient up to 0 dB, orange above 0 dB.

---

## 8. Interactions

### 8.1 Generic knob and slider behaviour

Applies to the fader, pan, stereo separation, send and mix knobs, and EQ controls [C] M-UI.

- Left-drag: knobs drag vertically, sliders along their axis.
- Fine adjustment: Ctrl+drag, or drag with both mouse buttons held.
- Snapping: controls pause at the default and other useful values; hold Shift to avoid it.
- Reset: Alt+left-click or middle-click (also available as right-click > Reset).
- Right-click menu: Type in value… (choose context-aware units such as dB, or normalized 0–1 / percent), Set… (a larger control), plus the automation and linking items listed in §3.1.
- The hint bar shows the control's name on hover and its value while it is being adjusted [C] M-TB.
- The mouse wheel adjusts the value [I]; step sizes are [U]. The EQ gain sliders were changed to a wheel step independent of window height [C] M-LOG #19208.
- "Undo knob tweaks" (General settings) is **off by default**, so plain control moves are not added to the undo history [C] M-GEN.

### 8.2 Mute and solo semantics

- **Mute** is a per-track "enabled" flag. Processing continues while muted [I] (§4.1).
- **Solo is exclusive and implemented by muting:** soloing T turns off the LEDs of other tracks [C] M-API ("Solo only this track, muting all other tracks").
  - Exempt from that muting [I]: Master, locked tracks [C], and T's downstream destinations, followed recursively so T stays audible through buses. Evidence for the downstream rule: the API has an "include sends" solo mode, and users report that a plain solo does not include upstream sources [C] F-BUSSOLO.
  - **Alt solo** (Alt+click or Alt+S) additionally keeps every upstream source, recursively. It equals API mode 3, "routed TO and FROM" [C].
  - API solo modes [C] M-API: 1 = with sources, 2 = with destinations (sends), 3 = both, 4 = only this track.
- **Unsolo** (solo the same track again) unmutes all unlocked tracks. If General settings › "Restore previous state after solo" is enabled, the mute pattern from before the solo is restored instead [C] M-GEN. That option's default is [U].
- **Unmute all:** Ctrl+right-click on any mute LED [C]. Ctrl + the key above Tab unsolos and unmutes all (FL 12.3+) [C] M-LOG; its exact scope is [U].
- **Multi-selection:** in FL 2025+ mute and solo clicks apply to all selected tracks, and mute/solo became undoable. In FL 21/2024 only the clicked track changes [C] M-LOG #19776, #19755.
- Locked tracks ignore solo and unmute-all, and Alt+click must not change them [C] M-LOG #17897.

### 8.3 Selection

- **Single selection:** left-click the pan knob, the fader, or the label/number area [C] M-MIX.
- **Multi-selection:** Ctrl+Shift+left-click, or Ctrl+Shift+drag, across label or meter areas. Do not use the faders for this [C] M-MIX. Ctrl+A selects all tracks (FL 21+) [C].
- The first-selected or right-clicked track is the "this track" target of routing commands and is drawn lighter [C].
- The selection determines the inspector contents, the routing indicators, the Current track's input, and the targets of Ctrl+L.
- Moving a selection includes only the selected tracks [C] M-LOG #16368.

### 8.4 Rename, colour, icon

- Open the dialog with F2, a middle-click on the label, or right-click › Rename, color & icon… [C] M-MIX, M-MENU.
- Pressing F2 inside the dialog picks a random colour [C].
- With several tracks selected, the name and icon apply only to unnamed tracks [C] M-MENU.
- Random color (FL 2024+), gradient colour for a selection (FL 2025+), and Auto color group [C] M-LOG.
- Icons include surround-labelling icons [C] M-MENU.
- Naming tracks marks them as "used", which matters for multi-output plugins, PDC and split rendering [C] M-MIX.

### 8.5 Reordering, docking, grouping

- **Move the selected track(s) left or right:** Alt+Left / Alt+Right [C] M-MIX, M-KEYS (the Mixer menu lists Shift+Left / Shift+Right; the sources conflict). Shift+mouse wheel over a track also moves it [C].
- Linked channels and inputs move with the track [C].
- **Mouse drag-and-drop reordering of tracks is not documented** [U]; do not implement it unless verified.
- Dock to Left / Middle / Right, separators and groups: §2.3.

### 8.6 Keyboard shortcuts (mixer focused)

| Keys | Action | Status |
|---|---|---|
| F9 | Show / hide the Mixer | [C] M-KEYS |
| S | Solo the selected track (Shift+S also reported) | [C] M-KEYS, M-LOG #14039 |
| Alt+S | Alt solo (routed to and from) | [C] |
| Alt+L | Select channels linked to the selected track | [C] |
| Ctrl+Alt+L | Select tracks routed to this one | [C] M-MENU |
| Alt+Left / Alt+Right | Move the selected track(s) | [C] |
| Shift+mouse wheel | Move the track under the cursor or the selection | [C] |
| Alt+R / Shift+Alt+R | Render armed tracks / selected tracks to wave | [C] |
| Alt+W | Toggle meter wave view | [C] |
| Ctrl+A | Select all mixer tracks | [C] |
| Ctrl+L / Shift+Ctrl+L | Link selected channels to the track / starting from the track | [C] |
| Ctrl+Shift+left-click | Add to the selection | [C] |
| Ctrl+Shift+S | Save mixer track state | [C] |
| Ctrl+Enter | Show / hide the track inspector | [C] |
| F2 | Rename, color & icon | [C] |
| Ctrl+E | Open audio editor (Edison) in the first free slot | [C] M-MENU |
| Ctrl + key above Tab | Unsolo / unmute all | [C] M-LOG (12.3) |
| D (in the track menu) | Delete track (FL 2025+) | [C] M-NEW25 |
| Left / Right arrows | Select the previous / next track | [U] |

### 8.7 Drag and drop onto the mixer

- Plugin from the browser or plugin picker onto a track: an effect loads into the first free slot; an instrument creates a channel routed to the track and renames it [C] M-MIX, M-FX.
- Effect or mixer-state preset onto a track or slot; with multiple selected tracks, FL asks for confirmation [C] M-LOG.
- A sample onto a track creates a sampler channel (FL 2024+) [C].
- FL 2025+: dropping into the empty space after the last track creates a new track [C] M-NEW25.

---

## 9. Built-in 3-band EQ

The EQ is present in FL 20, 21, 2024 and later, and sits after the FX slots [C] M-PROPS.

| Band | Type (fixed, not changeable) | Default frequency | Gain | Width | Status |
|---|---|---|---|---|---|
| 1 | Low shelf | 90 Hz (raw 5777) | 0 dB | raw 17500 / 65536 (≈0.267) | [C] M-PROPS types; PYFLP values |
| 2 | Peaking | 1500 Hz (raw 33145) | 0 dB | ≈0.267 | [C] |
| 3 | High shelf | 8000 Hz (raw 55825) | 0 dB | ≈0.267 | [C] |

| Parameter | Range | Mapping | Status |
|---|---|---|---|
| Gain | −18 to +18 dB (raw −1800 to +1800, in 0.01 dB) | Linear in dB. The API's normalized 0–1 is presumably (dB + 18) / 36 | [C] PYFLP range; [I] API mapping |
| Frequency | 10 Hz to 16 kHz (raw 0 to 65536, nonlinear) | `f(x) = 10 + 159.9·(101^x − 1)` Hz, with x = raw/65536 | [C] range; [I] law (all three defaults reproduced within 0.4 Hz: 90.3 / 1500.3 / 8000.3 Hz) |
| Width (bandwidth, "reso") | Normalized 0 to 1 | Mapping to Q or octaves undocumented. In Fruity Parametric EQ, turning the width knob left widens the band | [U]; [C] M-PEQ for direction |

Frequency law reference points [I]: x = 0.1 is 104 Hz; 0.25 is 357 Hz; 0.5 is 1457 Hz; 0.75 is 4.94 kHz; 0.9 is 10.0 kHz. Inverse: `x = ln(1 + (f − 10)/159.9) / ln(101)`.

UI:

- **Graph:** left-drag moves a band's frequency horizontally and its gain vertically. Right-drag changes bandwidth horizontally and gain vertically [C] M-PROPS, M-MIX.
- **Per-band controls:** gain slider, frequency knob, width knob [I].
- **Values via the API:** `getEqGain(i, band, 1)` returns dB, `getEqFrequency(i, band, 1)` returns Hz, `getEqBandwidth` is normalized. There are 3 bands [C] M-API, STUBS.
- EQ settings on the Current track apply to the selected track [C] M-MIX.

DSP recommendation [U]: RBJ-cookbook biquads (low shelf, peaking, high shelf) at the project sample rate. A band with 0 dB gain is an identity and can be skipped.

Suggested width-to-Q map until verified: `Q = 0.2·100^w`, giving the default w = 0.267 → Q ≈ 0.68, w = 0 → 0.2, w = 1 → 20. For shelves, use the same w as the shelf slope or Q.

Note: Web Audio's `BiquadFilterNode` ignores Q for lowshelf and highshelf, so implement the shelves in the AudioWorklet.

---

## 10. Suggested data model

This is a field list, not code. Ranges are kept FLP- and API-compatible.

| Entity | Field | Type / range | Default |
|---|---|---|---|
| Track | `index` | 0 = Master, 1–125 = inserts, Current is separate | |
| | `name`, `color`, `icon` | string / RGB / id | "Insert N" / default / none |
| | `volume` | v in [0, 1] | 0.8 |
| | `pan` | [−1, +1] | 0 |
| | `stereoSep` | [−1, +1] (+1 = merged) | 0 |
| | `polarityInverted`, `swapLR` | bool | false |
| | `enabled` (not muted), `muteLocked`, `solo` | bool | true, false, false |
| | `fxEnabled` (master FX switch) | bool | true |
| | `armed`, `recordFileName` | bool / string | false |
| | `input`, `output` | device port id or none | none (Master output = main) |
| | `recordPickup` | EXT / MIX / FX / EQ / LVL / POST | EXT |
| | `monitorMode` | Off / WhenArmed / On | WhenArmed |
| | `manualLatency` | samples (signed) | 0 |
| | `inputLatencyComp` | samples (signed) | 0 |
| | `dock` | Left / Middle / Right | Middle |
| | `separatorBefore`, `group` | bool / id | false / none |
| | `eq[3]` | {gainDb ∈ [−18, 18], freqNorm ∈ [0, 1], widthNorm ∈ [0, 1]} | {0, 0.0882 / 0.5058 / 0.8518, 0.267} |
| | `slots[10]` | {plugin, enabled, mix ∈ [0, 1], name, color} | {none, true, 1.0} |
| Route | `src`, `dst`, `level` | track ids, v in [0, 1] (0 = sidechain only) | level 0.8 |
| Channel | `mixerTarget` | 0–125 (0 = Master) | 0 |
| Project | `panLaw` | Circular / Triangular | Circular |
| | `pdcAutomatic`, `compensateAutomations` | bool | true, true |
| Mixer UI | `layout`, `viewFlags`, `selectedTracks`, `firstSelected` | | Wide, …, [Master] |

---

## 11. Version differences

| Version | Mixer-relevant differences |
|---|---|
| FL 12.x (baseline of the vector mixer) | 99 inserts until 12.9, then 125. Default view Wide (12.5). Two "alt" layouts added in 12.9 [C] |
| FL 20.0–20.8 | Recording pickup only Pre or Post. Automatic PDC applies to automation from 20.7. Option to ignore level and mute when recording "post" (20.8.4). Reset routing for selected tracks. Arm without an input [C] |
| FL 20.9 | Six recording pickup points and monitoring modes (default When armed). Send-knob hints in dB. Grouped faders keep relative dB. "Small text in plugin lists". "Always show external input levels" (20.9.1) [C] |
| FL 21.0 | Ctrl+A selects all tracks. FX bypass applies to all selected tracks. Render selected tracks. Separate meter theme colours. "Adjust position of recorded audio". Mixer CPU improvements [C] M-NEW21, M-LOG |
| FL 2024 (24.1) | Random colours for tracks and slots. Mix-level automation clips named with the track. Samples and FX presets droppable on tracks. Resetting routing also resets send levels. Scripting can get and set send levels [C] M-NEW24, M-LOG |
| FL 2024.2 | "Delay audio output" low-latency monitoring mode. Select channels and playlist tracks routed to a track [C] |
| FL 2025 | Dynamic mixer tracks (add, insert, delete, trim; up to 500; "+" buttons). Deleting a track re-routes its sources to its destinations. Mute and solo act on multi-selections and are undoable. Polarity and swap are undoable. "Unroute tracks routed to selected". Patcherize. Gradient colours [C] M-NEW25, M-LOG |
| FL 2026 | Alt+click resets input or output to (none). 24-bit disk recording. Master and Current selectable in split renders [C] M-LOG |

---

## 12. Open questions and verification checklist

Run these in FL 21 or 2024 with a test-tone generator (for example a sine at −6 dBFS in a channel routed to an insert) and a meter plugin on Master.

| # | Question | Test | Clone default until verified |
|---|---|---|---|
| T1 | Fader law exactness | Type values 0.1 to 1.0 and read the hint dB. Compare with the §3.1 table | Use the §3.1 law (strong evidence) |
| T2 | Send knob law and maximum | Max out a send; read the hint | Same as the fader |
| T3 | Pan curve (both laws) | Mono sine; pan −100 / −50 / −25 / 0 %; read L and R peaks. Then L-only content at −100% | §4.3.4 model |
| T4 | Stereo separation curve | L-only content; separation ±50 / ±100 %; read L and R | §4.3.2 model |
| T5 | Meter scale, ticks, top value, ballistics | Hover readouts at the top, at 0 dB and at the bottom; record a video of the decay after a burst | §7 defaults |
| T6 | Meter tap: pre- or post-mute, pre- or post-fader | Mute a playing track; move its fader | Post-mute, post-fader |
| T7 | Current track: audible or tap-only | Put a gain plugin on Current, select a track, listen and meter Master | Tap only |
| T8 | Solo: are downstream buses kept? | Route A → B → Master; solo A | Keep the downstream path |
| T9 | Strip element order per layout; the 8 layout names | Screenshot each layout | §2.4 order |
| T10 | Hint text formats (pan, separation, send, mix) | Hover and drag each control | §3 suggestions |
| T11 | EQ width-to-Q mapping, shelf slope, graph frequency span | Sweep width with a noise source and a spectrum analyser | §9 suggestion |
| T12 | Slot bypass: does the plugin still run? Is mix linear or equal-power? | Reverb with long tail; toggle bypass; mix 50% with a phase-inverting plugin | Skip processing; linear |
| T13 | Mute ramp time; parameter smoothing time | Record a fast mute toggle | 5 ms; 10–20 ms |
| T14 | Plain arrow keys in the mixer | Press Left / Right | Select previous / next |
| T15 | Default dock of Master and Current | New project | Master left, Current right |
| T16 | "Restore previous state after solo" default | Check General settings | Off |

---

## 13. Sources

Manual pages are on `https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/` (abbreviated `…/html/` below).

| Key | Source |
|---|---|
| M-MIX | Mixer: …/html/mixer.htm |
| M-MENU | Mixer menu: …/html/mixer_mixermenu.htm |
| M-MENU-OLD | Older English snapshot of the Mixer menu (pre-2025): https://www.image-line.com/fl-studio-learning/fl-studio-online-manual-de/html/mixer_mixermenu.htm (also …-de/html/mixer.htm, which shows "125 x Insert Tracks") |
| M-PROPS | Mixer track properties: …/html/mixer_trackprops.htm |
| M-SLOTS | Effect slots: …/html/mixer_plugin.htm |
| M-FX | Effect plugins: …/html/effects_plugins.htm |
| M-LEVELS | Levels, mixing & clipping: …/html/mixer_levelsandmixing.htm |
| M-DB | dB metering scale: …/html/mixer_dB.htm |
| M-PROJ | Project settings (Panning law): …/html/songsettings_settings.htm |
| M-GEN | General settings (Alternate meter scale, Restore previous state after solo, Auto select linked modules, Undo knob tweaks): …/html/envsettings_general.htm |
| M-UI | Knobs and sliders: …/html/basics_interface.htm |
| M-KEYS | Keyboard shortcuts: …/html/basics_shortcuts.htm |
| M-TB | Toolbar / hint bar: …/html/toolbar_panels.htm |
| M-TOOLS | Tools menu, last-tweaked items: …/html/menu_tools.htm |
| M-THEME | Theme settings (meter colours): …/html/envsettings_themes.htm |
| M-CR | Channel Rack: …/html/channelrack.htm |
| M-CS | Channel Settings: …/html/chansettings_main.htm |
| M-AUDIO | Audio settings (metronome and preview tracks): …/html/envsettings_audio.htm |
| M-SHAPER | Fruity Stereo Shaper (expansion, reduction, pan method): …/html/plugins/Fruity%20Stereo%20Shaper.htm |
| M-ENH | Fruity Stereo Enhancer: …/html/plugins/Fruity%20Stereo%20Enhancer.htm |
| M-BAL | Fruity Balance: …/html/plugins/Fruity%20Balance.htm |
| M-PEQ | Fruity Parametric EQ: …/html/plugins/Fruity%20Parametric%20EQ.htm |
| M-API | MIDI scripting, mixer module and constants: …/html/midi_scripting.htm |
| M-NEW20 / 21 / 24 / 25 / M-NEW | What's new: …/html/basics_new_20.htm, basics_new_21.htm, basics_new_24.htm, basics_new_25.htm, basics_new.htm |
| M-LOG | Full change log (bug and feature IDs cited as #nnnnn): …/html/WhatsNew.htm |
| STUBS | FL Studio API stubs (IL-Group): https://il-group.github.io/FL-Studio-API-Stubs/midi_controller_scripting/mixer/tracks/ and …/mixer/eq/ |
| PYFLP | PyFLP mixer module (FLP value ranges and defaults): https://pyflp.readthedocs.io/en/latest/_modules/pyflp/mixer.html (source: https://github.com/demberto/PyFLP) |
| VOLCONV | Community fader lookup table: https://github.com/olyrhc/flstudio-volume-converter (volume.py) |
| F-DB79 | Forum, typed values versus dB ("−5dB is 79%"): https://forum.image-line.com/viewtopic.php?p=2026258 |
| F-HINT | Forum (FL 8.5 era), hint bar value formats such as "95%", "−1.1dB", "0.8": https://forum.image-line.com/viewtopic.php?p=222888 |
| F-1188392 | Forum, dB shown only on the active track: https://forum.image-line.com/viewtopic.php?p=1188392 |
| F-PAN20 | Forum, Circular law measured 3 dB quieter at sides (mono-summed): https://forum.image-line.com/viewtopic.php?t=220524 |
| F-PANMESS | Forum, mixer = merge & pan, Channel Rack = balance: https://forum.image-line.com/viewtopic.php?p=2046627 |
| F-BUSSOLO | Forum, plain solo of a bus does not include its sources: https://forum.image-line.com/viewtopic.php?p=2044720 |
| F-METER12 | Forum, FL 12 Current meter uses 3 dB sections: https://forum.image-line.com/viewtopic.php?t=141639 |
| F-PEAKHOLD | Forum, meter peak "tail" decays gradually: https://forum.image-line.com/viewtopic.php?p=1087091 |
| F-2025B | FL 2025 beta notes (500 tracks, dynamic mixer): https://forum.image-line.com/viewtopic.php?p=2000500 |
