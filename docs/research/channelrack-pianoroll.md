# FL Studio Channel Rack (Step Sequencer) and Piano Roll: behavior spec

Research notes for a web clone (TypeScript + Web Audio + Canvas). Everything below is paraphrased from the sources listed in section D. This file holds no code, only behavior, data ranges and layout rules.

## How to read this document

Each statement carries a confidence tag:

| Tag | Meaning |
|---|---|
| **[C: KEY]** | Confirmed by the source with key `KEY` (see section D for URLs). |
| **[I]** | Inferred. It follows from confirmed facts or from widely known FL behavior, but no source states it directly. Treat it as a design decision you can revisit. |
| **[U]** | Uncertain or unknown. Sources conflict or say nothing. A recommended default is given where one helps. |
| **[L]** | Legacy. Documented for an older FL version (FL 11 = 2014 manual, FL 12 = 2016, FL 20 = 2019) and absent from or changed in the current manual. |

**Version baseline.** The current FL Studio online manual (FL Studio 2025/2026 generation). The live pages were read in Oct 2026 and match the Jan 2026 Internet Archive snapshot. Older manuals are used only for legacy features and to resolve gaps.

**Screen geometry.** No images were downloaded. Layout positions come from the HTML image maps (`<area title=… coords=…>`) that the manual puts over its screenshots: `channelrack_main.png`, drawn at 873 px wide, and `pianoroll_general.png`, drawn at 1000 px wide. Treat those numbers as relative proportions, not exact pixel sizes. Keys `CR-map` and `PR-map`.

---

## 0. Shared fundamentals (both editors)

### 0.1 Time base

| Item | Value | Tag |
|---|---|---|
| Timebase (PPQ, ticks per quarter note) | Default **96**, set per project. A higher PPQ gives finer placement and limits maximum zoom. Lowering PPQ moves events that fall between the new grid points. | [C: PROJ] |
| Time grid model | Either "time division" (beats per bar, steps per beat) or a time signature (numerator/denominator). Patterns can carry their own time-signature markers. Time signatures only change the grid and the metronome downbeat, never the note data. | [C: PROJ, PR] |
| Default grid | 4/4, 4 steps per beat, so 16 steps per bar. | [C: CR] 16-step default; [I] for steps per beat = 4 |
| Step | 1/16 note = PPQ/4 ticks (**24 ticks** at 96 PPQ). The step-shift range is "PPQ / 4 (the number of steps per beat)". | [C: STUB, CR] |
| Beat | A quarter note, PPQ ticks (96). FL calls a quarter note a "beat" even in 6/8. | [C: PROJ] |
| Bar | Beats per bar × PPQ (384 ticks in 4/4 at 96 PPQ). | [I] |
| Position/duration display | `bar:step:tick` in the Note Properties dialog. Bar and step are 1-based. The FL 11 manual example "bar 1, step 5, tick 000" shows a zero-based, zero-padded tick field. | [C: PR] [L: L11-PR] |

### 0.2 Pitch naming (FL octave convention)

- Note numbers run **0–131** = **C0 … B10**, 132 keys. [C: PYFLP-PAT] PyFLP gives the key range C0–B10 and rejects values outside 0–131. Scripts also drop notes outside 0–131. [C: PRS]
- **MIDI 60 = C5**, 48 = C4, 36 = C3. FL's octave numbers sit one higher than the "C4 = 60" convention: the scripting docs say 60 is C5, "like the MIDI standard, but an octave higher". [C: PRS]
- The Sampler's default root key is C5. [C: MISC] Step notes default to MIDI 60, which is C5. [C: STUB]
- Black keys show as sharps by default. A setting switches them to flats. Note-name language can be English (C D E F G A B), Germanic (H instead of B) or Solfège. [C: GEN]

### 0.3 The note record (shared by steps and piano-roll notes)

Steps *are* notes. A step is a note with **length 0** on a step boundary (see 3.1). One record type covers both editors.

| Field | File/internal range (PyFLP) | Scripting API form | Default | UI meaning / display | Tag |
|---|---|---|---|---|---|
| key | 0–131 | `number` int, 60 = C5 | Steps: 60 (C5). Piano roll: the clicked row. | Note name, e.g. "C5", "F#3" | [C: PYFLP-PAT, PRS, STUB] |
| position | ticks ≥ 0 | `time` (ticks) | — | bar:step:tick | [C: PRS, PR] |
| length | ticks. **0 = step-sequencer note** | `length` (ticks) | Steps: 0. Piano roll: see 5.6. | bar:step:tick | [C: PYFLP-PAT] |
| velocity | 0–128 (128 = 100%) | `velocity` 0.0–1.0 | **100** (= 0.8 ≈ 78%) | Probably shown as a percentage | [C: PYFLP-PAT, PRS]. The step API gives 0–127 with default 100 [C: STUB], an inconsistency to absorb (clamp 128 to 127 on MIDI out). [I] |
| release velocity | 0–128 | `release` 0.0–1.0 | **64** (0.5) | % | [C: PYFLP-PAT, STUB] |
| fine pitch | 0–240, center 120, units of 10 cents, so **±1200 cents** | `pitchofs` −120…+120 | 120 (0 cents) | Dialog label "PITCH". Hint name "Note fine pitch". Moves in 10-cent steps. | [C: PYFLP-PAT, PRS, STUB, F-FINE]. The step Graph Editor page says "±100 cents" [C: CR], which conflicts. [U] |
| pan | 0–128, 64 = center | `pan` 0.0–1.0 | 64 (0.5) | left/center/right | [C: PYFLP-PAT, PRS] |
| Mod X (filter cutoff) | 0–255 in the file, default 128 | `fcut` 0.0–1.0 | 128 (0.5) | % | [C: PYFLP-PAT, PRS] |
| Mod Y (filter resonance) | 0–255, default 128 | `fres` 0.0–1.0 | 128 (0.5) | % | [C: PYFLP-PAT, PRS] |
| color group | 0–15 | `color` 0–15 | 0 (color 1) | One of 16 note colors. Also acts as MIDI channel 1–16 for wrapped plugins. | [C: PRS, PR] |
| slide | bool | `slide` | false | Slide note (see 7.4) | [C: PRS] |
| porta | bool | `porta` | false | Portamento flag. It *inverts* the channel's porta setting for this note. | [C: PRS, PR] |
| muted | bool | `muted` | false | Muted note, not played | [C: PRS] |
| group | int, 0 = none | `group` | 0 | Notes in a group move, select and delete together | [C: PRS, PR] |
| repeats (FL 2024.1+) | 0–14 enum | `repeats` | 0 | 0 = none, 1 = 1/4 (beat), 2 = 1/8 dotted, 3 = 1/4 triplet, 4 = 1/8, 5 = 1/16 dotted, 6 = 1/8 triplet, 7 = 1/16 (step), 8 = 1/32 dotted, 9 = 1/16 triplet, 10 = 1/32 (half step), 11 = 1/64 dotted, 12 = 1/32 triplet, 13 = 1/64 (quarter step), 14 = 1/64 triplet. Retriggers the note. | [C: STUB, F-B24, CR] |
| shift (steps only, Graph Editor) | 0 … PPQ/4 ticks | step param 7 | 0 | Delays the step by up to one step | [C: STUB, CR] |
| selected | bool (UI state) | `selected` | false | — | [C: PRS] |

New piano-roll notes take the "currently active style": the last-touched note's length and, very likely, its other properties. [C: PR] for length. The other properties are [I], based on the `getDefaultNoteProperties()` API and a 2024.1 bug fix about new notes reusing the previous repeat value. [C: F-B24]

---

## A. CHANNEL RACK

### 1. Window layout

#### 1.1 Header (title) bar, left to right

From `CR-map`, current manual. x-ranges are on the 873-px-wide screenshot. The header strip spans y 0–79.

| # | Item | x-range | Function | Tag |
|---|---|---|---|---|
| 1 | **Channel options menu** (small arrow) | 0–27 | Opens the Channel Options menu (4.11). | [C: CR, CR-map] |
| 2 | **Loop Starter** button | 27–51 | FL 2025+ "Loop Starter" mode, which fills channels with cloud loops. Out of scope for a core clone. FL 20 had the channel-looping button in this slot. | [C: CR-map current and 2019] |
| 3 | (unlabeled) | 51–106 | Probably the window title text "Channel rack". | [I] |
| 4 | **Display filter / channel group selector** | 106–192 | Shows the current group ("All", "Unsorted", or a user group). Left-click opens the filter menu. Right-click adds, renames or deletes groups. PgUp/PgDn step through groups. | [C: CR] |
| 5 | **"Play pattern"** | 206–224 | Present in the image map in 2016, 2019 and 2026. The text never describes it. | [U]. Recommend: start/stop playback in Pattern mode. |
| 6 | (empty title area) | 224–345 | Drags the window. **Shift+wheel on an empty part of the title bar scrolls through patterns.** | [C: CR, SC] for Shift+wheel; [I] for the drag area |
| 7 | **Swing knob** (global) | 345–369 | Global swing 0–100% (see 3.7). | [C: CR] |
| 8 | **Pattern length** | 359–407 | "Auto", or 1–512 steps. Right-click chooses a length in bars. | [C: CR] |
| 9 | **Channel looping** (loop icon) | 406–442 | Left-click toggles looping. Right-click opens the advanced loop menu (3.9). | [C: CR] |
| 10 | **View toggles: Graph editor and Step/Piano-roll view** | 443–493 | Two small icons (see section 5). | [C: CR-map label "Graph and Step/Piano roll views"]; [I] icon order |

Older header orders [L]:
- FL 20 (2019 map): options 0–27, loop 27–51, (title), filter 106–192, play 206–224, swing, pattern length 376–421, view toggles 430–472.
- FL 12 (2016 map): options, filter, play, swing, view toggles. No loop control, no pattern-length control.
- FL 11 (2014): pattern length, "Repeat step sequencer", pattern selector, swing slider, Graph Editor (G), Keyboard Editor (K), display filter, and a row of **playing-step LEDs** above the steps. [L: L11-SS]

#### 1.2 Body

- One row per channel, stacked vertically. The rack's height changes as channels are added or removed. [C: CR]
- **Auto resize** option: Off, Minimum height (fits all channels), Maximum height (fills available space). [C: CR]
- The default template has four Sampler channels: Kick, Clap, Hat, Snare. [C: BON], third party. Optional for a clone.

#### 1.3 Bottom edge

- **"+" (Add plugin channels)** sits under the channel-button column (x 135–165 in the map). Left-click opens the same favorites list as Options > **Add one**. A chosen instrument is added at the bottom of the rack. A new channel joins the display group that is currently selected. [C: CR]
- **Bottom-right corner handle** (x 483–562, labeled "Drag to change Pattern length"). Dragging it shows more steps or bars. [C: CR, CR-map]

#### 1.4 Scrolling

- Vertical: when channels exceed the window height, the list scrolls vertically, presumably by mouse wheel and a scrollbar. [I]
- **Shift+wheel over the title bar** changes the current pattern. [C: CR, SC]
- **Shift+wheel over a channel button** moves the selected channel(s) up or down. [C: CR, SC]
- "**Focus selected channel on playback**" (option): on start/stop the highest selected channel scrolls into view. [C: CR]
- Horizontal: more steps appear as the window widens (in whole bars, see 3.3). Whether a horizontal scrollbar appears for long patterns is undocumented. [U] Recommend a scrollbar when pattern length exceeds the visible width.

#### 1.5 Layout-affecting options (Channel Options menu / General settings)

Channel button width 100%–400% · Channel name alignment: Centered (default) or Left · Show mixer track selectors (Alt+M) · Show complete piano roll preview · Show a mute button on the piano roll preview · Detached · Auto zip empty channels (General settings; collapses channels with no steps or notes in the current pattern). [C: CR, GEN]

### 2. Channel row composition

**Order, left to right** [C: CR overview]: **Mute/Solo LED → Pan knob → Volume knob → Mixer-track selector (optional) → Channel button (name) → Channel selector (outer border) with activity indicator (inner region) → Step buttons OR piano-roll preview.**

Approximate widths, derived from `CR-map` at the manual's screenshot scale [I]:

| Element | ~Width | Notes |
|---|---|---|
| Mute LED | 17–19 px | Main rack area 10–27. Inset view 516–535. |
| Pan knob + Volume knob | ~34–35 px total (~17 px each) | Main 27–61. Inset 533–568. |
| Mixer track box | ~34 px | 66–100 |
| Channel button | ~83–88 px at 100% width | Inset 570–658 |
| Channel selector | ~19 px | Inset 659–678 |
| Step button pitch | **~16 px per step** | 16 steps ≈ 256 px (216–472) |
| Row height | **~29 px** | 5 rows ≈ y 101–246 |

So a step is a tall rectangle, about 16 wide by 25–27 high, with a small gap. [I]

**Visual states**

| Element | States | Tag |
|---|---|---|
| Mute LED | **Lit = channel plays. Dark = muted.** The theme has a "Mute" LED color, probably green by default. When soloed, the soloed channel stays lit and the others go dark. | [C: CR, THEME]; [I] for color and solo display |
| Pan knob | Bipolar, default **center** (6400 of 0–12800). | [C: PYFLP-CH] |
| Volume knob | Default **≈78%** (10000 of 12800). For a Sampler this is −5.2 dB; set 100% for the sample's original level. Audio Clip channels play at 100%. | [C: PYFLP-CH, CR] |
| Mixer track box | LCD number. **"---" = routed to Master (the default).** Dimmed when the channel belongs to an instrument/audio track group, in which case changing the value moves the mixer track instead of re-routing. Generators with no audio output show icons instead of the box. | [C: CR] |
| Channel button | Shows the channel name. Background is the channel color (default **#5C656A**, granite gray). Name centered by default. Optional icons on the left: audio track, instrument track, and a lock when "Receive notes from" is set. **Red button** = missing sample or plugin. | [C: CR, PYFLP-CH] |
| Channel selector | **Outer border lit = selected.** **Inner region flashes = note activity.** **Orange = channel locked to a MIDI controller.** | [C: CR] |
| Step buttons | **Odd and even beat groups use two theme colors** ("Steps: choose odd and even colors"). With 4 steps per beat, steps 1–4 and 9–12 use one color, 5–8 and 13–16 the other. Default look: gray vs. reddish. Active steps are drawn lit/bright. | [C: THEME] for odd/even; [I] for group = beat, the colors and the lit look |
| Ghost steps | With looping on, a shorter channel's repeated steps show as dimmed "ghost steps". | [C: CR]; [I] for "dimmed" |
| Piano-roll preview | Replaces the step buttons. **Alternating lighter/darker blocks, one per bar.** Notes drawn as mini bars. **Not editable.** | [C: CR] |
| Zipped channel | Compact row. Right-click its button to unzip. | [C: CR] |
| Selected channel | Only the selector lights. No other row highlight is documented. | [I] |

### 3. Steps vs. notes

#### 3.1 Identity and defaults

- The step sequencer is laid over the channel's piano-roll score. A step is a **zero-length note** on a step boundary. PyFLP: note length "returns 0 for notes punched in through step sequencer". [C: CR, PYFLP-PAT]
- Default step-note properties [C: STUB]: pitch **60 (C5)**, velocity **100**, release **64**, fine pitch **120** (0 cents), pan **64** (center), Mod X/Y at midpoint, shift **0**, repeat 0.
- Opened in the Piano roll, step notes appear **aligned to the grid at the minimum note length**. [C: CR] How wide a zero-length note is drawn is unspecified. [I] Recommend drawing it one step wide (or a minimum of a few px), with its length still stored as 0.
- Steps that should cut each other: **"Cut self"** works for step notes but not piano-roll notes. Use Max polyphony = 1 for those. [C: CR, MISC]

#### 3.2 Activation semantics

- Activating step *k* creates a note at `k × (PPQ/4)` ticks.
- **"Mute removed steps"** (Options menu):
  - **On:** deactivating a step *mutes* its note, so its graph values (velocity, pan, …) survive. Muted step notes show as muted notes in the Piano roll.
  - **Off:** deactivating *deletes* the note and its data. [C: CR]
  - Default state undocumented. [U]
- Re-activating a step without preserved data uses the defaults from 3.1. [I]
- **No note-off.** A sampler step plays to the end of its sample. To stop a sound, place a zero-velocity step after it or use the Piano roll. [C: CR] For synths, an implied duration of about one step is likely. [I]

#### 3.3 Step count and pattern-length growth

| Rule | Tag |
|---|---|
| Each step button = one 16th note. The default view is **16 steps** (4 beats × 4 steps). | [C: CR] |
| **Pattern length "Auto"**: the pattern ends at the **end of the last bar that contains data**. | [C: CR] |
| Turning on a step at position 17 makes the pattern **32 steps** (2 bars). | [C: BON] (2017 tutorial) |
| Manual pattern length: **1–512 steps** (up to 64 bars in 4/4). Right-click sets it in bars. Max 512 steps; use the Piano roll beyond that. | [C: CR] |
| FL 11/12 limit was 64 steps. | [L: L11-SS, 2016 CR] |
| Visible steps are set by window width. Drag the bottom-right corner to show more bars. The visible range is whole bars, since the manual's preview option talks of "the number of bars visible in the Stepsequencer". | [C: CR]; [I] for whole-bar units |
| A **Pattern-length time marker** in the Piano roll can also define the length. | [C: PR, PRM] |
| Pattern length in the scripting API is measured in beats. | [C: MS] |
| Auto-length rule for a clone: `bars = max(1, ceil(lastDataEnd / ticksPerBar))`, where a note's end is `position + max(length, 1 tick)` and automation counts as data. | [I], built on the [C] rule above |

#### 3.4 When a row shows the piano-roll preview instead of steps

- The manual: the mini preview replaces the steps when a Piano roll is active on the channel. Step editing in piano-roll mode works only if notes stay **zero-length** and **on step positions**. To go back to steps: select all, set Snap to (none), then Discard lengths (Shift+D). [C: CR]
- Rule for a clone [I]: show step buttons only if every note of that channel in the current pattern
  - has `length == 0`,
  - starts exactly on a step boundary,
  - has no slide or porta flag, and
  - has at most one note per step position.

  Otherwise show the preview. Pitch alone does not force the preview, because steps can carry a pitch through the Graph Editor "Note" lane. [C: CR]
- **Show complete piano roll preview** on: the preview fits the whole score. Off: it shows only the bars that are visible in the step area. [C: CR]

#### 3.5 Channel-row interactions with the preview

See table 4.2.

#### 3.6 Step pitch in modern FL

There is no keyboard editor (removed after FL 11). Step pitch is edited in the Graph Editor **Note** lane or in the Piano roll. [C: CR]; [L] for the removal

#### 3.7 Swing

| Item | Spec | Tag |
|---|---|---|
| Global swing | Header knob, 0–100% (file 0–128). **Default 0.** Stored once per project, not per pattern. | [C: CR, PYFLP-RACK]. "Applies to all channels and all patterns." [C: F-GSW] (user statement) |
| Channel swing mix | Channel Settings > Misc > Time > **Swing**, 0–100%. **Default 100%** (follows the global value). Options menu "Set swingmix for selected" offers 0/25/50/75/100% or a custom value. | [C: CR, MISC, PYFLP-SH] |
| Effective amount | `global × channelMix`. Both must be above 0 for any swing. | [C: CR] |
| Affected notes | With 4 beats per bar, swing **holds the odd 16ths (1,3,5…15) at the expense of the even 16ths (2,4…16)**. Even steps are delayed, and the odd/even step lengths become unequal. | [C: CR] |
| Magnitude | At 100%, every second step is delayed by **half a step**, i.e. 12 ticks at 96 PPQ. A linear mapping is likely. | [U]. A forum answer, visible only as a snippet, reads "100% Swing shifts every second Step by half a s…". [C: F-SWING] (partial) |
| Piano-roll notes | Probably swung too. The global knob "applies to all channels", and the truncate option mentions slides/portamento, which exist only for piano-roll notes. | [I] |
| Truncate swing notes | Per channel: right-click the channel's Swing knob. A macro covers selected channels. On: swung notes are shortened so they don't overlap the next note. Off: they may overlap. | [C: CR, MISC, F-B24] |
| Double-time caveat | Swing works on every second step, so beats programmed at double spacing won't swing as expected. | [C: CR] |
| Clone timing model | A piecewise-linear time warp per pair of steps (cycle 2S, delay `d = amount × S/2`): `[0,S)` maps linearly to `[0,S+d)` and `[S,2S)` to `[S+d,2S)`. Apply it to note starts. Apply it to note ends only when "truncate" is on, clamped to the next note. | [I] |

#### 3.8 Per-step Shift

The Graph Editor's **Shift** lane delays a step by up to one step ("100% shift = one 16th note"). To move a step earlier, delay the *preceding* step instead. The Channel's **Time > Shift** knob delays the whole channel by up to one step. [C: CR, MISC, STUB]

#### 3.9 Channel looping (header loop icon)

- **Loop on:** each channel loops its own sequence independently of the others. With "Loop all steps", all channels loop to match the longest sequence. Ghost steps show the repetition. [C: CR]
- **Right-click menu:**
  - *Loop step channels*: step-mode channels loop at the next step.
  - *Loop all channels*: step and piano-roll channels loop at the next beat.
  - *Advanced looping*: a per-channel control at the end of each row with "…" (off) / Bar / Beat / Step. Its right-click menu holds: Don't loop / Step / Beat / Bar / Set to next beat / Set to next bar; *Burn to pattern* (selected or all looping channels); *Colorful loop controls*; *Always show advanced controls*. [C: CR]
- Bar/Beat/Step modes play up to the end of the last used bar/beat/step, then loop. [C: CR]
- API constants: `ssLoopOff = 0`, `ssLoopNextStep = −1`, `ssLoopNextBeat = −2`, `ssLoopNextBar = −3`. [C: STUB]
- Default looping state undocumented. [U]

### 4. Mouse and keyboard interactions

#### 4.1 Step buttons

| Action | Result | Tag |
|---|---|---|
| Left-click | Activate the step. | [C: CR] |
| Right-click | Deactivate the step. | [C: CR] |
| With "Use both mouse buttons in Step sequencer" **off** (General settings) | Left-click toggles on/off. The default is on: left adds, right removes. | [C: GEN, CR] |
| Left-drag across steps | Activates every step passed over (paint). Right-drag deactivates. | [I] (well known, not in the manual text) |
| Modifiers (Shift/Ctrl/Alt) or mouse wheel over steps | Undocumented. | [U]. Recommend no-ops. |
| Ctrl+C / Ctrl+X / Ctrl+V | Copy / cut the steps (or score) of the **selected** channel(s). Paste starts at the uppermost selected channel. Works across patterns. | [C: CR, EDIT, SC] |
| Shift+Ctrl+Left / Right | Rotate the step data one step left/right. | [C: SC, CR] |

#### 4.2 Piano-roll preview (in a row)

| Action | Result | Tag |
|---|---|---|
| Left-click | Show/hide that channel's Piano roll window. | [C: CR] |
| Right-click | Open the Piano roll scrolled/centered to the clicked notes. | [C: CR] |
| Hover (with "Show a mute button…") | Shows a mute icon linked to the channel mute. | [C: CR] |

#### 4.3 Channel button (name)

| Action | Result | Tag |
|---|---|---|
| Left-click | Open/close Channel Settings and the plugin interface. With "Auto select linked modules" on (the default), opening one plugin closes the others and the channel becomes the selected channel. | [C: CR, GEN]; [I] for "becomes selected" |
| Alt+Left-click | Open the plugin without closing the ones already open. | [C: CR] |
| Ctrl+Left-click | Preview the channel's sound without opening it. | [C: CR]. Plays C5. [I] |
| Right-click | **Channel menu** (list below). | [C: CR] |
| Shift+wheel | Move the selected channel up/down. | [C: CR] |
| Middle-click on the button icon | Opens the icon menu. | [C: CR] |
| Right-click a zipped button | Unzip. | [C: CR] |

**Channel button right-click menu, current manual order** [C: CR]:

1. Piano roll (opens the channel's Piano roll; step data shows aligned at minimum length)
2. Graph editor
3. Rename, recolor and icon… (name field plus a color square. Left-click the square for the color dialog, right-click it for a random color. In the dialog, F2 picks a random color and F3 the last-used color.)
4. Random color · Change color · Change icon
5. Load sample (sample channels only)
6. Cut self
7. Show waveform preview
8. Insert (new channel *before* this one, from favorites) · Replace (swap generator)
9. Patcherize
10. Clone · Delete
11. Separate from instrument track
12. Cut / Copy / Paste (note data)
13. Fill each 2 / 4 / 8 steps (turns on every 2nd, 4th or 8th step from step 1, clearing the others [L: L11 menu])
14. Advanced fill… (Euclidean, "Fill every" or manual, with sequence length, step count and rotation [C: FILL])
15. Rotate left / right (Shift+Ctrl+Left/Right)
16. MIDI channel through · Receive notes from (locks a controller and shows the lock icon plus an orange selector)
17. Create DirectWave instrument
18. Burn MIDI to (Current pattern / New pattern)

#### 4.4 Mute/Solo LED

| Action | Result | Tag |
|---|---|---|
| Left-click | Toggle mute. | [C: CR] |
| Ctrl+Left-click | Solo/unsolo: this channel plays, all others mute. Repeat to unsolo (unmute all). | [C: CR] |
| Right-click | Popup menu with **Solo**. | [C: CR] (a third-party guide agrees) |
| Alt+Left-click | The manual lists it **both** as solo and as "mute/solo the channel's display-filter group". | [U] (conflict inside [C: CR]). Recommend: Alt+click toggles mute for the whole filter group. |
| Shift+Left-click | **Lock state.** A locked channel ignores solo/mute changes made through other channels. | [C: CR]; [I] for the lock semantics (PyFLP: "mute and solo behave differently when locked") |
| Keys 1…9, 0 | Mute/unmute the first 10 channels. | [C: SC] |
| Ctrl+1…9, 0 | Solo/unsolo the first 10 channels. | [C: SC] |

- **Restore previous state after solo** (General settings): undoing a solo restores the earlier mute pattern. [C: GEN]
- Mute/solo affects only step and piano-roll playback. Live MIDI input still plays. [C: CR]

#### 4.5 Pan and Volume knobs (FL-wide knob rules)

- Left-drag up/down changes the value. **Ctrl+drag** (or both buttons) for fine adjustment. **Shift** stops the knob pausing at the default and other detents. **Alt+click or middle-click resets to default.** [C: UI]
- **Right-click** opens a menu with "Type in value…", "Set", Reset, link to controller, Edit events and so on. [C: UI]
- The mouse wheel adjusts the value. [I]
- The hint bar shows the value: % and dB for volume, left/right % for pan. [I]
- Both knobs send pan/volume *to the plugin*, so how they behave depends on the plugin. [C: CR]

#### 4.6 Mixer-track selector

- Drag vertically to change the target track. "---" = Master. [C: CR]
- LCD conventions: click the top edge to increment, the bottom edge to decrement. Click and hold, then type a number. [C: UI]
- Double-click opens the Mixer at that track. [C: WRAP] for the Channel Settings selector; [I] for the rack box.
- Ctrl+L assigns the selected channels to free mixer tracks. [C: CR, SC]
- Hidden or shown with Alt+M. [C: CR, SC] Default visibility in recent versions is probably shown. [I]

#### 4.7 Channel selector (green indicator right of the name)

| Action | Result | Tag |
|---|---|---|
| Left-click | Select this channel. If several are selected, focus the selection on it. | [C: CR] |
| Right-click | Toggle this channel's selection independently (multi-select). | [C: CR] |
| Right-drag down the selectors | Select several channels. | [C: CR] |
| Left-drag down the selectors | Range selection (used before "Color selected > Gradient"). | [C: CR] |
| Double-click | Select all channels. | [C: CR] |

- Selected channels are the targets for cut/copy/paste and receive live MIDI. [C: CR]
- With "Auto select linked modules" off, the selector chooses the live-MIDI target channel, while the channel button only opens the editor. [C: CR, GEN]

#### 4.8 Reordering channels

- Documented methods: **Alt+Up/Down**, **Shift+wheel over a channel button**, and Options menu Move selected up/down. Reordering doesn't change mixer routing. [C: CR, SC]
- **Drag-to-reorder is not documented.** [U] A third-party page claims Alt+drag, unverified.
- Options menu **Sort by**: Color, Name, Track number, Type. [C: CR]

#### 4.9 Header controls

| Control | Interactions | Tag |
|---|---|---|
| Options arrow | Left-click opens the Channel Options menu. | [C: CR] |
| Display filter | Left-click: choose All / Unsorted / a group. Right-click: Add filter group; with a group selected, Rename/Delete (deleting a group never deletes its channels). PgUp/PgDn cycle groups: the manual says PgDn = next in one place and PgUp = next in another. Option "Auto switch display filter". | [C: CR, SC]; [U] PgUp/PgDn direction |
| Swing knob | Knob rules from 4.5. | [C: CR] |
| Pattern length | Value drag (LCD rules). Right-click: length in bars. "Auto". | [C: CR] |
| Loop icon | Left-click toggles. Right-click opens the menu from 3.9. | [C: CR] |
| Graph editor / view toggles | See section 5. | [C: CR] |
| "+" | Add-one menu. | [C: CR] |
| Bottom-right handle | Drag to show more bars of steps. | [C: CR] |
| Title bar | Shift+wheel changes the pattern. | [C: CR, SC] |

#### 4.10 Channel Rack keyboard shortcuts

Focus must be on the Channel Rack. On macOS Ctrl = Cmd and Alt = Opt. [C: SC]

| Keys | Action | Tag |
|---|---|---|
| Up / Down | Select the channel above / below. | [C: SC] |
| Shift+Up / Shift+Down | "Moves channel selection up/down". Ambiguous: extend the selection or move it. | [C: SC]; [U] meaning |
| Alt+Up / Alt+Down | Move the selected channel(s) up/down. | [C: SC, CR] |
| PgUp / PgDn | Next/previous channel group (direction conflicting). | [C: SC]; [U] |
| 1…9, 0 / Ctrl+1…9, 0 | Mute / solo the first 10 channels. | [C: SC] |
| Alt+C | Clone selected channels (no notes copied). | [C: SC, CR] |
| Alt+Del | Delete selected channels. | [C: SC, CR] |
| Alt+G | Group selected channels (prompts for a name). | [C: SC, CR] |
| Alt+M | Toggle mixer track selectors. | [C: SC, CR] |
| Alt+Z / Alt+U | Zip selected / unzip (the Options menu says "Unzip all"). | [C: SC, CR] |
| Ctrl+C / X / V | Copy / cut / paste the steps or score of the selected channels. | [C: SC, EDIT] |
| Ctrl+L | Route the selected channels to free mixer tracks. | [C: SC, CR] |
| Ctrl+Alt+R | Restretch all audio-clip channels. | [C: SC, CR] |
| Shift+Ctrl+Left / Right | Shift (rotate) steps left/right. | [C: SC] |
| Ctrl+Enter | Focus the Playlist. | [C: SC] |
| Ctrl+K | Open the Graph Editor (per the manual). | [C: CR] |
| Global | F6 shows/hides the Channel Rack. Numpad 1–9 / + / − select patterns. F4 = next empty pattern. Space = play/stop. L = pattern/song mode. | [C: SC] |

#### 4.11 Channel Options menu (header arrow), in order

[C: CR]

- Add one (favorites; "More plugins…")
- Loop Starter
- Select unused channels
- Clone selected (Alt+C)
- Delete selected (Alt+Del)
- Move selected up / down (Alt+Up/Down)
- Sort by: Color / Name / Track number / Type
- Group selected (Alt+G)
- Color selected: Gradient / Random
- Mute selected / Unmute selected
- Transpose selected… (semitones, ±)
- Set swingmix for selected: 0 / 25 / 50 / 75 / 100% / Custom…
- Set truncate swing notes for selected: On / Off
- Assign selected to free mixer track(s) (Ctrl+L)
- Change declicking for selected channels
- Zip selected (Alt+Z)
- Unzip all (Alt+U)
- Restretch all (Ctrl+Alt+R)
- Group playlist tracks created by Loop starter
- Auto resize: Off / Minimum / Maximum
- Auto switch display filter
- Channel button width (100–400%)
- Channel name alignment (Centered / Left)
- Focus selected channel on playback
- Mute removed steps
- Show mixer track selectors (Alt+M)
- Show complete piano roll preview
- Show a mute button on the Piano roll preview
- Detached
- Switch all / selected audio clip channels to (stretch mode)

### 5. Graph Editor, Step/Piano-roll view, legacy Keyboard Editor

#### 5.1 Graph Editor (per-step properties)

- **Open** from the header icon, the channel menu "Graph editor", or **Ctrl+K** (per the manual). [C: CR]
- **Placement:** an inline panel **aligned under the selected channel's steps**. A 2024.1 bug fix reads "graph editor isn't aligned to the selected channel if the channel is not in view". [C: F-B24]; [I] that rows below are pushed down.
- **Lanes** (tabs): **Note, Velocity, Release, Fine pitch, Pan(ning), Mod X, Mod Y, Shift**, plus **Rep(eat)** since FL 2024.1. [C: CR, F-B24]

| Lane | Range / default | Notes | Tag |
|---|---|---|---|
| Note | Key 0–131, default **C5 (60)** | Meant for drums and FX pitch; use the Piano roll for melodies. | [C: CR, STUB] |
| Velocity | Default 100 (≈78%) | — | [C: STUB] |
| Release | Default 64 (50%) | Release velocity | [C: STUB] |
| Fine pitch | 0–240, center 120 | Manual text: "±100 cents". API/PyFLP: ±1200 cents in 10-cent units. | [U] conflict |
| Pan | 0–128, center 64 | — | [C: STUB] |
| Mod X / Mod Y | Midpoint default | Usually filter cutoff/resonance for the Sampler | [C: CR, STUB] |
| Shift | 0…PPQ/4 ticks, default 0 | 100% = one 16th | [C: CR, STUB] |
| Rep | Repeat enum (0.3) | Retriggers the step | [C: CR, F-B24, STUB] |

**Editing gestures** [C: CR]:
- **Left-click/drag up or down on a column** sets its value.
- **Ctrl+drag one column** moves all columns together ("the others will follow"). Relative offset is probably right. [I]
- **Right-click a value and drag to another column** draws a linear ramp between them.
- **Alt+click or Alt+drag across bars** resets them to the default.

**Scope:** the legacy manual says graph values affect active steps only. [L: L11-GE] With "Mute removed steps" on, values persist for removed steps. [C: CR] Most instruments respond to velocity and pan. Some VSTs ignore the other lanes. [C: CR]

#### 5.2 Step / Piano-roll view toggle (second header icon)

- The manual: the step sequencer sits on top of the Piano roll. Switching to "Piano roll mode" lets you edit step sequences as piano-roll data as long as notes stay zero-length and on-step. [C: CR]
- Recommended reading [I]: the toggle switches **every** channel row to the mini piano-roll preview, so step notes show at their pitches. A click on a preview opens that channel's Piano roll. Toggle again to see the step buttons.

#### 5.3 Legacy Keyboard Editor (FL ≤ 11, removed in FL 12)

[L: L11-KB]

- **Toggle:** header button or key **K**. The Graph Editor used **G** in that era.
- **Look:** one vertical mini piano keyboard per step (rotated 90°), under the step row. Actions apply to **all selected channels**.
- **Active note:** an orange key marks the step's pitch. **Left-click** a key sets the pitch and activates the step.
- **Inactive note:** light orange, the default pitch used when the step is activated. **Right-click** sets the pitch and deactivates the step.
- **Ctrl+drag** a note to move all notes together.
- **Slide/portamento line** per step: left-click on, right-click off. Native instruments only.
- Max 64 steps.
- The legacy Graph Editor picked the property with a slider and had lanes Pan, Velocity, Release, Mod X, Mod Y, Pitch, Shift. [L: L11-GE]

---

## B. PIANO ROLL

### 6. Window layout

#### 6.1 Regions

From `PR-map`, a 1000-px-wide screenshot.

| Region | Position in the screenshot | Content | Tag |
|---|---|---|---|
| Title / main menu | x 95–215, top row | Piano roll main menu (options arrow) and the window title. The **target-channel drop-down lives in the title bar**. | [C: PR, PR-map] |
| Tools menu (wrench) and Snap (magnet) | x 169–191 and 189–208, second row (y 37–65), above the keyboard column | Wrench: left = Tools menu, right = Chord Progression tool, middle = Riff Machine. Magnet: left = Snap menu, right = default note length. | [C: PR, PR-map] |
| Tool buttons | x 232–406 (y 0–65) | Toolbar buttons (6.2) | [C: PR-map] |
| Target channel selector | x 453–577 | Left: choose channel. Channels with notes in the current pattern show a tick. Right-click: open that channel's plugin. Wheel cycles channels *with notes*; Ctrl+wheel cycles all channels. | [C: PR, PR-map] |
| Ghost-note controls | x 668–854 | Left-click: ghost-channel panel. Right-click: menu (Show all/none, ghost tracks, ghost pattern clips). | [C: PR, PR-map] |
| Top-left corner above the keyboard | Color selector x 147–180 (y 65–102). Slide/Porta toggles x 9–214 (y 87–117). | Note color for new notes: left-click picks, right-click sets a custom color. Slide (S) and Portamento (O) mode toggles. | [C: PR, PR-map] |
| Horizontal scroll/zoom bar | **Top of the grid**, x 478–787 (y 64–83) | Drag the center to scroll. Drag the edges to zoom. | [C: PR, PR-map] |
| Top-right strip | x 813–998 (y 64–84) | Hint reads: "Increase vertical zoom to see control values. Mouse-wheel changes values." Probably the vertical zoom control. | [C: PR-map] label; [I] function |
| Keyboard | Left column (~0–214 px in the screenshot) | Preview keyboard (6.4) | [C: PR]; [I] width |
| Note grid | Center | — | [C: PR] |
| Event editor | Bottom. Target selector at x 0–214, y 360–383. Data area x 215–831, y 362–459. | 8.3 | [C: PR, PR-map] |
| Splitter | Between grid and event editor | Drag to resize. Right-click: the Piano roll page says it restores the original position, the menu page says it flips (shows/hides) the editor. Shift+Enter shows/hides the event editor ("Flip separator"). View > Swap panels exchanges the two. | [C: PR, PRM]; [U] right-click conflict |

#### 6.2 Toolbar buttons

In the manual's table order, which most likely matches the toolbar order. [C: PR]

| Icon | Key | Summary |
|---|---|---|
| Tools (wrench) | — | Tools menu. Right-click: Chord Progression. Middle-click: Riff Machine. |
| Snap (magnet) | — | Left: snap menu. Right: set the default note length. |
| Snap to scale (note icon) | — | Left: toggle scale snapping. Right: scale menu (root, scale, "Snap PR notes to scale", "Snap incoming MIDI", shading: Default / Black notes / Auto). Notes snap to the scale only when moved. |
| Chord Stamp | — | Stamp chords. Options: Only one; Automatic chord (top-down / bottom-up); Melodic chords (+Advanced); Melodic scales; Percussions; Special (e.g. "Slide up"). Follows snap and scale. |
| Draw (pencil) | **P** | 7.1 |
| Paint (brush) | **B** | 7.1 |
| Paint drum-sequencer mode | **N** | 7.1 |
| Delete | **D** | 7.1 |
| Mute | **T** | 7.1 |
| Interpolate | **I** | Event-editor *automation* data only |
| Slice | **C** | 7.1 |
| Select | **E** | 7.1 |
| Zoom | **Z** | 7.1 |
| Play selected / scrub | **Y** | 7.1 |
| Play/Pause | — | Left: start/pause. Right while playing: stop and return to the start position. Right while stopped: playhead to the Piano roll start. |

FL 11 had no Paint-drum, Interpolate, Snap-to-scale or Play buttons. [L: L11-PR]

#### 6.3 Context Tool Menu

**Middle-click + right-click** anywhere opens a local menu that repeats the toolbar and main menu. [C: PR, SC]

#### 6.4 Preview keyboard (left)

| Aspect | Spec | Tag |
|---|---|---|
| Range and naming | C0–B10, 60 = C5 (section 0.2). | [C] |
| Key labels (View > Keyboard labels) | None / All notes / Root notes (of the chosen scale) / Highlighted notes (in the scale), plus a "White notes only" switch. Presets save and load custom labels. User labels override plugin labels. Over-long labels are truncated. | [C: PRM]. Default probably C notes only ("C5"). [I] |
| Keyboard style | Classic (realistic), Modern (minimal), Flat (black keys extend into the grid), List (text rows for drum/slice names). Key **M** toggles keyboard view mode (piano vs. text list). | [C: PRM, SC, L11-PR] |
| Left-click a key | Previews the note. **Doesn't work while playing.** | [C: PR] |
| Click position and velocity | On the Channel Settings keyboard, click position sets preview velocity. The piano roll keyboard probably uses the position across the key length. | [I] (by analogy with [C: MISC]) |
| Ctrl+click a key | Selects all notes of that pitch. Ctrl+drag vertically selects a pitch range. | [C: PR] |
| Middle-drag vertically | Vertical zoom, centered on the clicked note. | [C: PR] |
| Right-click a key | Key menu, including **Rename** (custom label; drag the red note indicator to change the target key). | [C: PR, PRM] |
| Colors | White and black keys. Optional root/scale highlighting. | [C: PRM]; [I] details |

#### 6.5 Grid

| Feature | Spec | Tag |
|---|---|---|
| Axes | Pitch on the vertical axis (low at the bottom). Time on the horizontal axis. Ruler numbers are bars. | [C: PR] |
| Grid resolution | Set by snap. With **Line** snap the visible resolution also changes with zoom. | [C: PR, PRM] |
| Lines | Bar lines strongest, then beats, then steps or finer. | [I] |
| Black-key row shading | "Note grid highlights" (**Alt+B**) extends keyboard shading into the grid. | [C: PRM]. Default state [U]. Recommend on. |
| Scale highlighting | With a scale chosen, in-scale lanes are drawn lighter. Shading modes: Default (none), Black notes, Automatic (detects the scale; scale name in the hint bar). | [C: PR, PRM] |
| Time segments | Alternating light/dark vertical background bands. **Default "4 Bars".** | [C: PRM] |
| Grid contrast / Invert grid / Grid color | High/Medium/Low. Invert swaps light and dark bar lines. Ctrl+Alt+G opens the grid color dialog. | [C: PRM] |
| Precise time indicator | Option: a full-height vertical line marks the playback/edit position. | [C: PRM] |
| Mini piano-roll preview on the scrollbar | Option. | [C: PRM] |
| Background waveform | Drop a waveform onto the roll. Alt+N toggles it. | [C: PR, PRM] |

#### 6.6 Time ruler and markers

| Action | Result | Tag |
|---|---|---|
| Left-click the ruler | Moves the playback position. | [C: PL] for the Playlist; [I] for the Piano roll |
| **Ctrl+left-drag** or **double-click+drag** on the ruler | Time-range selection; selects the notes in that range. | [C: PR] |
| Time selection | Pattern playback loops inside it. | [C: PL] for the Playlist ("Timeline Selections will play in loop mode"). [I] for the Piano roll, supported by the 2024.1 fix "position indicator … can go past the end of the timeline selection" [C: F-B24]. |
| Delete a time selection | Ctrl+click on it, or double-click the ruler. | [C: PL]; [I] for the Piano roll |
| Markers | Alt+T adds a named marker. Ctrl+T adds an "Auto" marker. "Add two" marks the selection ends. "Add one every" 1/2/4/8 bars. Time signature change: Shift+Alt+T. Key marker. Right-click a marker to change its type, including **Pattern length**. | [C: PR, PRM] |

### 7. Tools and mouse behavior

#### 7.1 Per-tool behavior

[C: PR] unless marked otherwise.

| Tool | Left button | Right button | Modifiers |
|---|---|---|---|
| **Draw (P)** | Click empty grid: add a note at the snapped position with the default length. Keep holding and drag to reposition before release. Drag a note: move it. Drag a note's right edge: resize. | Click: delete the note. Drag: delete the notes passed over. Click and hold on the background (with click-and-hold option): slice tool. | **Shift**: add in stretch mode, i.e. click and drag out the length. **Ctrl**: selection. **Alt**: draw with snap = none. |
| **Paint (B)** | Click: one note. Drag: paints repeated notes along the drag. Painting above or below existing notes builds chords. | Click: delete the note. | **Shift**: monophonic paint; replaces existing notes, allows vertical movement. **Ctrl**: selection. The General option "Monophonic painting in piano roll" swaps the Shift behavior. The two pages describe vertical movement differently. [U] |
| **Paint drum-seq (N)** | Click: add. Drag: paint a line of notes. **Click an existing note: mute/unmute it.** Snap sets the note length. | Click: delete. Drag: delete several. Hold: slice tool. | **Ctrl**: selection. **Alt**: paint at half the snap value. |
| **Delete (D)** | Click or drag deletes notes. | Hold: slice tool. | **Ctrl**: select, then press Delete. |
| **Mute (T)** | Click or drag toggles mute. | Click: delete. Hold: slice tool. | **Ctrl**: selection. |
| **Interpolate (I)** | Drag horizontally in the event editor: turns stepped automation into straight lines. Only works with real automation events, not note-property lollipops. | — | — |
| **Slice (C)** | Drag a vertical line: cuts the notes it crosses at the intersection. | — | **Shift**: slice without dragging. **Shift+Alt**: same with no snap. **Ctrl**: selection. Ctrl+G glues touching notes. |
| **Select (E)** | Click a note or drag a rectangle. | — | **Shift**: add/remove from the selection. |
| **Zoom (Z)** | Drag a rectangle: zoom to it. Click the background: zoom out. | Click: toggle zoom/unzoom. In other tools, Ctrl+right-drag draws a zoom rectangle. Right-click the icon: quick-zoom menu. | — |
| **Play selected (Y)** | Click notes to play them. Drag to scrub. | — | **Ctrl**: selection. |

#### 7.2 General gestures in Draw mode

| Gesture | Result | Tag |
|---|---|---|
| Click an existing note | Its length becomes the default length for new notes. | [C: PR] |
| Double-click a note | **Note Properties dialog** (8.2). | [C: PR, SC] |
| Drag a note body | Move. The snap setting governs horizontal steps. **Alt** bypasses snap. | [C: PR] |
| Move a selection | Dragging any selected note moves the whole selection. | [C: PR] |
| Snap during a move | The grabbed note lands on a grid position. The others keep their offsets. | [I] |
| Axis lock | **Click first, then hold Shift** to lock pitch (horizontal move only). **Click first, then hold Ctrl** to lock timing (vertical move only). | [C: PR] |
| Resize from the right edge | Cursor turns into a double arrow. Drag horizontally. Snap applies. Works on a selection. | [C: PR] |
| Resize from the left edge | Only with Edit > **Allow resizing from left** (Ctrl+Alt+Home). Off by default, so a left-edge drag moves the note. Alt bypasses snap. | [C: PR, PRM] |
| Caps Lock resize | FL 11/20: with Caps Lock on, a grab near the left side anchors the end; near the right side anchors the start. | [L: L11-PR, L20-PR] |
| **Shift+drag a selection** | Clone (copy) the selection and drag the copy. | [C: PR, SC] |
| Left-Shift+left-click on empty grid | Add a note and drag out its length. | [C: SC] |
| Right-Shift+drag a selected note's right edge | Stretch or compress the selection (lengths and positions). Alt+Right-Shift stretches in 25% steps. A selection also shows a **stretch handle**: drag it to stretch, with Alt for no snap. | [C: PR] |
| Ctrl+drag on empty grid | Rectangle selection. | [C: PR] |
| Ctrl+click a note | Select it. | [C: PR, SC] |
| Ctrl+Shift+click / drag | Add to (or remove from) the selection. | [C: PR] |
| Ctrl+click empty grid | Deselect all. | [C: PR] |
| Right-click empty grid | Deselect all. | [C: PR] (stated in the magic-lasso text) |
| Right-click a note | Delete it. The shortcut table says right-click deletes the selected notes. | [C: PR, SC] |
| Magic lasso (Select menu option) | Circle notes with the pointer, no click needed. | [C: PR, PRM] |
| Middle-drag | Pan both axes. | [C: PR, SC] |
| Left-Shift+right-drag | Pan view. | [C: SC] |
| Left-Alt+right-click | Audio preview / scrub at the cursor. | [C: SC, PR] |
| Right-Alt+right-click | Quantize the selection. | [C: SC] |
| Right-Shift+left-drag | Slice notes. Right-Shift+right-drag slices and deletes the smaller part. | [C: SC] |
| Double right-click a ghost note (or X1 button) | Switch to that ghost's channel. | [C: PR, SC] |
| **Alt+wheel over a note** | Changes the event editor's current property (velocity by default). **Ctrl+Alt+wheel** for fine steps. Also works on one note of a selection. | [C: PR] |
| **Shift+Alt+wheel over a note** | Nudge its position (PPQ units). With Edit > "Nudge notes with mouse wheel", Shift alone does this. | [C: PR, PRM] |

**Click-and-hold functions** (General option): hold on a note to copy it. Hold while adding a note to cycle slide/porta. Hold between two touching notes to glue them. Snap note sides. Right-click a tool and roll the wheel to change tools. Middle click zooms out fully. [C: GEN, PR]

#### 7.3 Sound preview

| Case | Behavior | Tag |
|---|---|---|
| Keyboard click | Previews the note, but not while playing. | [C: PR] |
| Placing or clicking notes when stopped | The notes are heard. "Preview notes during playback" (option) extends this to playback. When that option is off, only the keyboard previews during playback. | [C: PRM] (stopped-state preview implied) |
| Slide notes | Make no sound of their own but preview when created or moved. | [C: PR] |
| Moving a note to another pitch | Re-previews it. | [I] |

#### 7.4 Slides and portamento

[C: PR, MISC]

- **Native FL instruments only.** VSTs need channel-pitch automation instead.
- **Slide note** (toggle S, then draw): doesn't sound on its own. It must overlap a normal note of the **same color group**. It bends that note toward its own pitch, arriving at the slide note's end, so the slide note's length sets the glide time.
  - Chords: the topmost note is the reference and all notes move by the same interval. Pitches stay offset after the slide.
  - All note properties also glide toward the slide note's values.
  - 16 color groups allow 16 independent slides.
- **Portamento note** (toggle O): a short glide from the previous note into this note. Glide time comes from the channel's Misc > Polyphony **SLIDE** knob. In the Note Properties dialog, Porta *inverts* the channel's global Porta setting for that note.
- Mono mode applies per color group.

#### 7.5 Zoom and scroll

| Input | Result | Tag |
|---|---|---|
| PgUp / PgDn | Zoom in/out, centered on the cursor. | [C: PR, PRM, SC] |
| Shift+1 / 2 / 3 | Quick-zoom presets 1–3. | [C: PRM] |
| Shift+4 | Zoom out far (minimum horizontal zoom). | [C: PRM] |
| Shift+5 | Zoom to the time selection. | [C: PRM] |
| Shift+0 | Center the view on the playhead (top-row digit keys, not the numpad). | [C: PRM] |
| Drag the edges of the horizontal scrollbar | Horizontal zoom. | [C: PR] |
| Drag the vertical zoom boxes / middle-drag on the keyboard | Vertical zoom. | [C: PR] |
| Ctrl+wheel | Horizontal zoom at the cursor. | [I] (documented for the Playlist [C: PL]) |
| Plain wheel | Vertical scroll. | [I] |
| Shift+wheel | Horizontal scroll. | [I]. With the nudge option on, Shift+wheel over notes nudges them. [C: PRM] |
| Alt+wheel over empty grid | Probably vertical zoom. | [U] |
| Max zoom | Limited by PPQ. | [C: PROJ] |
| Option "Auto zoom in piano roll" | Fits the zoom to the note data. | [C: GEN] |
| Option "Incremental scrolling" | Clicking the scrollbar rail scrolls in increments. | [C: PRM] |
| Snap and scroll speed | Scrolling is slower when snap is anything other than Line. | [C: PR] |

### 8. Note properties

#### 8.1 Value table

Ranges and defaults are in 0.3. The UI exposes them through the **event editor** under the grid and the **Note Properties dialog**.

| Property | Event-editor target | Display |
|---|---|---|
| Velocity | Note velocity, the **default target** [I] | % [I] |
| Release velocity | Note release | %. Supported only by some synths: Sytrus, Harmor, Harmless, Ogun. [C: PR] |
| Fine pitch | Note fine pitch | cents, 10-cent steps, ±1200 [C: F-FINE] |
| Pan | Note panning | left/center/right % [I] |
| Mod X | Note Mod X (filter cutoff) | % |
| Mod Y | Note Mod Y (filter resonance) | % |
| Repeat (2024.1+) | Note repeat | Enum names (0.3) [C: F-B24, STUB] |
| Automation events | Any automated control in the pattern (channel volume, pan, pitch, plugin params…) | 0–100% vertical scale [C: EE] |

Target strings in FL read like "Note velocity" and "Note fine pitch". [C: F-FINE] for "Note fine pitch"; [I] for the rest.

#### 8.2 Note Properties dialog (double-click a note)

[C: PR]

- **Levels:** PAN, VEL, REL, MODX, MODY, and PITCH (fine) knobs.
- **Slide** on/off and **Porta** (inverts the channel porta for this note).
- **Color** group selector.
- **Time:** start position as `bar:step:tick`.
- **Duration:** `bar:step:tick`. One tick = 1/PPQ beat.
- **Reset** restores the values from when the dialog opened. **Accept** applies.
- If the double-clicked note belongs to a selection, the changes apply to the whole selection and the Time section is disabled.

#### 8.3 Event editor behavior (lower panel)

| Aspect | Spec | Tag |
|---|---|---|
| Note-property display | A **vertical line with a small circle on top** ("lollipop") at each note start. A right-facing tail separates notes that share a start time. Option "Note length in properties" draws a horizontal line as long as the note. | [C: PR, PRM] |
| Legacy display | A square instead of a circle on top. | [L: L11-PR] |
| Edit | Click or drag sets values. For notes sharing a start time, select one first, then edit. **Shift+left-drag** sets every value under the drag to the same value. **Alt+left-click** resets to default. | [C: PR] |
| Right-drag | Probably draws a straight-line ramp, as in the automation editor. | [I] |
| Changing targets | Left-click the target selector, roll the wheel over it, press Shift+F (cycle) or F (next property), or right-click the area at the start of the editor. | [C: PR, SC] |
| Automation data | Same tools as the standalone Event Editor. Draw: left-drag draws freehand, right-drag draws a line. Snap applies to the Draw tool only. Paint ignores snap. Erase. Interpolate: left-drag linear, right-drag spline. **Auto Smoothing** option. Ctrl+I inserts the current controller value. Data shows as vertical lines on a 0–100% scale. | [C: EE, PRM] |

### 9. Note appearance

| Aspect | Spec | Tag |
|---|---|---|
| Shape | Horizontal bars. Options **Rounded** and **Shadow**. | [C: PR, PRM] |
| Color | The note's **color group** (16 colors). The default palette is built on green, cyan, pink and yellow shades: group 1 green, 5 blue, 9 pink, 13 yellow. Palettes can be edited, saved and loaded (`.ncp`). | [C: L11-PR, CHP, PRM] |
| Velocity shading | Notes are **shaded light to dark by velocity**. | [C: F-VEL] (FL 8-era thread thanking the developer for velocity coloring). Higher velocity is drawn brighter/more saturated. [I] |
| Selected notes | Drawn **red**. | [C: F-RED] (FL 20.9 report: notes "turn red as if they are selected") |
| Muted notes | Grayed or desaturated, semi-transparent. | [I] |
| Label | The note name (e.g. "C5", or a custom key label) drawn inside the note when wide enough. Option **Keep labels on screen**: the label slides along so it stays visible. | [C: PRM] option; [I] for default visibility |
| Ghost notes | Notes of the pattern's other channels, drawn **gray and semi-transparent**. Same-pattern ghosts are **solid blocks** and can be double-right-clicked to switch channel. Ghosts from **overlapping playlist pattern clips** are **open (outlined) blocks** and can't be switched to. Alt+V toggles. **Editable ghosts** (Ctrl+Alt+V) allows direct edits. | [C: PR, PRM] |
| Slide notes | A **small triangle** marker. One current passage says it's drawn on the right side, another says at the note start. FL 11 says the left side. | [U]. Recommend the start (left) side. |
| Porta notes | A "portamento flag" icon. | [C: PR] |
| Step (zero-length) notes | Shown at minimum length on the grid. | [C: CR]; [I] width rule in 3.1 |

### 10. Snap

#### 10.1 Snap options in menu order

Tick values assume 96 PPQ, 4 steps per beat and 4/4 time. They are derived [I] from the definitions [C: PRM, TB, MS]. API constants come from [C: MS].

| # | Option | Meaning | Ticks @96 | API constant |
|---|---|---|---|---|
| 1 | **Main** | Use the Global Snap value. Local selectors only. | — | `Snap_Default = −2` [C: STUB] |
| 2 | **Line** | Snap to the **nearest visible grid line**. The grid density follows horizontal zoom. | Zoom-dependent | `Snap_Line = 0` |
| 3 | **Cell** | Snap to the **start of the grid cell** the pointer is in (a floor, not rounding). Zoom-dependent. | Zoom-dependent | `Snap_Cell = 1` |
| 4 | **(none)** | No snapping, limited only by PPQ. Holding **Alt** gives the same effect temporarily. | 1 | `Snap_None = 3` |
| 5 | 1/6 step | — | 4 | 4 |
| 6 | 1/4 step | 64th notes | 6 | 5 |
| 7 | 1/3 step | — | 8 | 6 |
| 8 | 1/2 step | 32nd notes | 12 | 7 |
| 9 | Step | 16th | 24 | 8 |
| 10 | 1/6 beat | 16th triplet | 16 | 9 |
| 11 | 1/4 beat | 16th notes | 24 | 10 |
| 12 | 1/3 beat | 8th triplets | 32 | 11 |
| 13 | 1/2 beat | 8th notes | 48 | 12 |
| 14 | Beat | Quarter | 96 | 13 |
| 15 | Bar | Whole note in 4/4 | 384 | 14 |
| 16 | **Events** (Piano roll) | Snap relative to existing events, ghost notes included. Neighbor events change color to show sliced boundaries. | — | — |
| 17 | **Markers** (Piano roll) | Snap to time markers. | — | — |

The notation column restates the manual's table: 1/4 step = 64ths, 1/2 step = 32nds, 1/4 beat = 16ths, 1/3 beat = triplets, 1/2 beat = 8ths, 1 beat = quarters, Bar = whole. [C: PRM, TB] The API stubs also list bar fractions that clash with the official constants. Ignore them. [U: STUB]

#### 10.2 Snap rules

| Rule | Tag |
|---|---|
| Snap affects drawing, moving, resizing, slicing and quantizing. **Holding Alt sets snap to (none) temporarily.** | [C: PRM, PR] |
| **Main** follows the **Global Snap** on the toolbar Snap panel. The Global Snap also sets MIDI input quantize during recording, except for (none), Line and Cell. **Backspace** toggles Global Snap between Line and (none). | [C: TB, SC] |
| Shift+arrow nudges move by one snap unit. Alt+arrow nudges move by pixel units, so the size depends on zoom. | [C: PR] |
| **Defaults:** local Piano roll snap = Main; Global Snap = Line. | [U]. Not documented. Line is Image-Line's general recommendation and Backspace toggles Line/none. |
| Recommended Line/Cell grid density: candidate units bar → beat → step → 1/2 step → 1/4 step → … → PPQ tick. Use the finest unit whose on-screen spacing is at least about 8–12 px. Triplet grids appear only through explicit 1/3 or 1/6 snaps. | [I] |
| Line snaps a position with round-to-nearest-grid-line. Cell snaps with floor-to-grid. | [I] (follows the [C] definitions) |

#### 10.3 Default note length

| Rule | Tag |
|---|---|
| **Right-click the Snap icon** to set the default length for new notes. Global Snap right-click does the same. | [C: PR, TB] |
| Clicking any existing note also sets it. New notes use the length of the **last touched note**. | [C: PR] |
| Starting value in an empty Piano roll | [U]. Recommend one snap unit, i.e. one step at default zoom. |

### 11. Keyboard shortcuts (Piano roll focus)

On macOS, Ctrl = Cmd and Alt = Opt. [C: SC]

#### 11.1 Tools and modes

| Key | Action | Tag |
|---|---|---|
| P / B / N / D / T / I / C / E / Z / Y | Draw / Paint / Paint drum-seq / Delete / Mute / Interpolate / Slice / Select / Zoom / Playback tool | [C: PR, SC] |
| S / O | Slide toggle / Portamento toggle | [C: PR, SC] |
| M | Keyboard view mode toggle (piano vs. text list) | [C: SC, L11-PR] |
| F / Shift+F | Next property in the event lane / cycle note properties | [C: SC, PR] |
| G / K | Select the channel above / below | [C: SC] |
| H / J | Select the channel above / below **with note data** | [C: SC] |
| Shift+H / Shift+K | Next channel with notes / next channel | [C: SC] |
| Alt (hold) | Bypass snap | [C: SC] |
| Backspace | Toggle Global Snap (Line ↔ none) | [C: SC] |

#### 11.2 Edit

| Key | Action | Tag |
|---|---|---|
| Ctrl+A | Select all | [C] |
| **Ctrl+D** | **Deselect** (not duplicate) | [C: SC, PRM] |
| Ctrl+C / Ctrl+X / Ctrl+V | Copy / cut / paste. **Paste lands at the leftmost bar visible in the window.** | [C: PRM] |
| **Ctrl+B** | **Duplicate** the selection to the right, or all notes if nothing is selected (FL 11: "all notes in zoom range"). A time-line selection sets the repeat interval independently of the note selection. | [C: PR, PRM, L11-PR]. Interval without a time selection = selection length rounded up to the snap unit. [I] |
| Del | Delete the selection. **With nothing selected it deletes all notes, slides and events in the Piano roll.** | [C: PRM] |
| Shift+Ctrl+V / Ctrl+M / Shift+Ctrl+M | Paste from MIDI clipboard / import MIDI / export MIDI | [C: PRM, SC] |
| Ctrl+Ins / Ctrl+Alt+Ins / Ctrl+Del | Insert space equal to the time selection / slice and insert space / delete space (closes the gap) | [C: PRM] |
| Ctrl+I | Insert the current controller value into the event editor | [C: PRM] |
| Ctrl+Alt+Home | Toggle "Allow resizing from left" | [C: PRM, SC] |
| Alt+C | Change the selected notes (or all) to the current color group | [C: PRM] |
| Alt+M / Alt+Shift+M | Mute / unmute the selection | [C: SC] |
| Shift+G / Alt+G | Group / ungroup the selection | [C: PRM] |

#### 11.3 Move and transpose

| Key | Action | Tag |
|---|---|---|
| Shift+Left / Right | Move one snap unit (works on the selection) | [C: PRM] |
| Shift+Ctrl+Left / Right | Rotate one snap unit, wrapping within the bar(s) | [C: PRM] |
| Shift+Up / Down | Transpose ±1 semitone | [C: PRM] |
| Ctrl+Up / Down | Transpose ±1 octave | [C: PRM] |
| Alt+arrows | Nudge by pixel units (zoom-dependent). FL 11 applied this to all notes when nothing was selected. | [C: SC, PR, L11-PR] |

#### 11.4 Selection

| Key | Action | Tag |
|---|---|---|
| Ctrl+Left / Right | Shift the time selection by its own width | [C: PRM] |
| Ctrl+Enter | Set the time selection around the selected notes | [C: PRM] |
| Shift+I | Invert selection | [C: PRM] |
| Shift+C | Select by the current color group | [C: PRM] |
| Shift+R / Shift+M | "Select one at random" / "Select more at random". The manual's descriptions for the two are swapped. | [C: PRM]; [U] which is which |
| Shift+O | Select odd ("swung") notes, i.e. notes off the main beat grid | [C: PRM] |
| Select menu (no shortcut) | Select muted · Select overlapping notes (all but the lowest) · Select stacked notes (100% overlap) · Magic lasso | [C: PRM] |

#### 11.5 Tools (dialogs and quick actions)

| Key | Action | Tag |
|---|---|---|
| **Ctrl+Q** (Mac **Cmd+Opt+Q**) | **Quick quantize**: snaps the selected notes (or all) to the **Global Snap** value | [C: PRM]; [C: L20-PR] for Ctrl+Q |
| **Shift+Q** | Quick quantize, start times only | [C: PRM] |
| **Alt+Q** | **Quantizer** dialog: groove template (.fsc), start-time mix, sensitivity, duration mix, mode (quantize duration / end time / leave duration / leave end time), level mixes | [C: PRM, QNT] |
| **Ctrl+L** | **Quick legato**: a preset of Articulate. Notes run on to the next note; applies to the selection if there is one. | [C: PRM, ART] |
| Alt+L | Articulate dialog (Legato / Portato / Staccato presets, multiply 10–100%, variation, seed, chop chords, use lengths, only with selection) | [C: ART] |
| **Ctrl+U** | **Quick chop**: slices long notes into snap-sized pieces | [C: PRM] |
| Alt+U | Chopper dialog (pattern .fsc, time multiplier, absolute pattern, group notes) | [C: CHP] |
| Ctrl+G | Glue touching notes | [C: PRM] |
| Shift+D | Discard lengths: shortens notes to the minimum the snap allows. With snap = none they become length 0, i.e. step notes. | [C: PRM, CR] |
| Alt+A / Alt+S / Alt+F / Alt+W / Alt+K / Alt+Y / Alt+R / Alt+X / Alt+O | Arpeggiate / Strum / Flam / Claw machine / Limit / Flip / Randomize / Scale levels / LFO | [C: PRM, SC] |
| Alt+E / Alt+P / Ctrl+Alt+Y | Riff machine / Chord progression / Run last script | [C: PRM] |

#### 11.6 View

| Key | Action | Tag |
|---|---|---|
| Alt+V / Ctrl+Alt+V | Ghost channels / Editable ghosts | [C: PRM] |
| Alt+B / Alt+N / Ctrl+Alt+G | Note grid highlights / background waveform / grid color | [C: PRM] |
| Shift+Enter | Flip separator (show/hide the event editor) | [C: PRM] |
| PgUp / PgDn / Shift+0…5 | Zoom (see 7.5) | [C: PRM] |

#### 11.7 Markers

| Key | Action | Tag |
|---|---|---|
| Alt+T | Add marker | [C: PRM] |
| Ctrl+T | Add "Auto" marker | [C: PRM] |
| Shift+Alt+T | Time signature at the playhead or selection | [C: PR] |

#### 11.8 Focus-dependent conflicts

The same keys do different things depending on the focused window. A clone needs per-window keymaps.

| Keys | Piano roll | Channel Rack | Elsewhere |
|---|---|---|---|
| Ctrl+B | Duplicate | — | Global: recording "blend" toggle |
| Ctrl+L | Quick legato | Route to free mixer tracks | — |
| Alt+C | Change color | Clone channels | — |
| Ctrl+T | Auto marker | — | Global: typing keyboard to piano toggle |
| Ctrl+E | — | — | Global: step-edit mode |
| Ctrl+H | — | — | Global: panic |

[C: SC, PRM]

### 12. Default zoom, grid density and pattern length

| Topic | Spec | Tag |
|---|---|---|
| Default horizontal and vertical zoom | Not documented. "Auto zoom in piano roll" (General) fits zoom to the notes. | [C: GEN]. [U] defaults. Recommend about 4 bars visible at a typical width (a step of roughly 16–20 px, close to the Channel Rack step pitch), key height about 12 px, view centered near C5. [I] |
| Grid density | Follows snap. Line/Cell density follows zoom (10.2). | [C] |
| Pattern length from notes | **Auto**: end of the last bar with data (3.3). An explicit Channel Rack pattern length or a **Pattern-length marker** overrides it. | [C: CR, PR] |
| Piano-roll extent | Unbounded to the right. The Channel Rack step grid tops out at 512 steps. | [C: CR] |
| Notes in other patterns | Shown only as out-of-pattern ghosts when pattern clips overlap in the Playlist. | [C: PR] |

---

## C. Open questions and recommended defaults

| # | Question | Evidence | Recommendation |
|---|---|---|---|
| 1 | Exact swing magnitude and curve | A partial forum answer says 100% = half a step. Linearity unknown. | Linear: `delay = amount × S/2` for even steps, with the warp from 3.7. |
| 2 | Does swing move piano-roll notes, and how are off-grid notes treated? | Implied but unconfirmed. | Apply the time warp to every note start in swung channels. Make it switchable. |
| 3 | Fine-pitch range: Graph Editor says ±100 cents, API says ±1200 | Conflict | Store ±1200 cents in 10-cent units. The step lane may show the same range. |
| 4 | Default Global Snap and Piano roll snap | Not documented | Global = Line, local = Main. |
| 5 | Starting default note length | Not documented | One snap unit. |
| 6 | Default zoom levels | Not documented | About 4 bars visible, key height about 12 px. |
| 7 | Velocity-to-brightness mapping, muted look | The velocity shading itself is confirmed. | Brightness or alpha from about 35% at velocity 0 to 100% at 128. Muted notes desaturated at about 40% alpha. |
| 8 | Slide-triangle side | Conflicting text | Triangle at the start (left) of the note. |
| 9 | Mute LED Alt+click: solo or group mute? | Conflicting text | Ctrl+click = solo. Alt+click = mute/unmute the filter group. Right-click = menu with Solo. |
| 10 | PgUp/PgDn direction for groups; meaning of Shift+Up/Down | Conflicting or ambiguous | PgDn = next group. Shift+Up/Down extends the selection. |
| 11 | Mouse wheel and modifiers over steps; drag-reorder of channels | Undocumented | Wheel and modifiers: no-op. Drag-reorder: optional, Alt+drag. |
| 12 | Playhead in the step grid | FL 11 had a playing-step LED row. The current manual doesn't mention one. | Light up the current step column subtly during playback. |
| 13 | "Play pattern" header button | In the image map only | Toggle Pattern-mode playback. |
| 14 | Defaults for looping, "Mute removed steps", auto-resize, mixer selector visibility | Not documented | Looping on (step channels). Mute removed steps on. Auto resize off. Mixer selectors shown. |
| 15 | Note-off length of zero-length step notes for synths | Undocumented | Gate a step note for one step. Samplers play their one-shot to the end. |
| 16 | Piano-roll keyboard click velocity | By analogy only | Velocity from the click position along the key, louder toward the tip. |

---

## D. Sources

All official manual pages are under `https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/`. They were read through the Internet Archive snapshot (2026-01) and Image-Line's mirror `cluster.image-line.com/fl-studio-learning/fl-studio-online-manual/html/`, which is live and diffed identical.

**Official manual (current)**

| Key | Page |
|---|---|
| CR / CR-map | `channelrack.htm`: text plus the `ChannelRack_Map` image map |
| PR / PR-map | `pianoroll.htm`: text plus the `PianoRoll_Map` image map |
| PRM | `pianoroll_menu.htm` |
| SC | `basics_shortcuts.htm` |
| GEN | `envsettings_general.htm` |
| MISC | `chansettings_misc.htm` |
| PROJ | `songsettings_settings.htm` |
| TB | `toolbar_panels.htm` (Global Snap panel, Pattern panel) |
| EE | `automation_eventeditor.htm` |
| UI | `basics_interface.htm` (knob, slider and LCD conventions) |
| WRAP | `chansettings_main.htm` |
| THEME | `envsettings_themes.htm` |
| EDIT | `menu_edit.htm` |
| FILL | `stepsequencer_advancedfilltool.htm` |
| QNT, CHP, ART | `pianoroll_qnt.htm`, `pianoroll_chp.htm`, `pianoroll_articulate.htm` |
| PRS | `pianoroll_scripting_api.htm` (note fields, ranges, C5 = 60) |
| MS | `midi_scripting.htm` (channels, patterns, step-parameter and snap-mode constants) |
| PL | `playlist.htm` (timeline-selection and ruler behavior) |

**Older official manuals (legacy)**

| Key | Source |
|---|---|
| L20-PR, 2019 CR | `https://www.image-line.com/support/flstudio_online_manual/html/pianoroll.htm` and `…/channelrack.htm`, archive 2019 (FL 20) |
| 2016 CR | Same path, archive 2016 (FL 12) |
| L11-SS | `http://www.image-line.com/support/FLHelp/html/stepsequencer.htm`, archive 2014 (FL 11) |
| L11-KB | `…/FLHelp/html/stepsequencer_kbedit.htm` |
| L11-GE | `…/FLHelp/html/stepsequencer_gredit.htm` |
| L11-PR | `…/FLHelp/html/pianoroll.htm` |
| L11 menu | `…/FLHelp/html/stepsequencer_menu.htm` |

**Scripting, file format and community**

| Key | Source |
|---|---|
| STUB | IL-Group FL Studio API Stubs: `https://github.com/IL-Group/FL-Studio-API-Stubs`. Files: `src/midi_controller_scripting/channels/__sequencer.py`, `…/midi/__step_params.py`, `…/midi/__snap_modes.py`, `…/midi/__step_sequencer_loop.py`, `src/piano_roll_scripting/flpianoroll/__note.py`. Community-maintained, used for defaults. |
| PYFLP-PAT | `https://pyflp.readthedocs.io/en/latest/reference/patterns/pattern.html` (note field ranges and defaults) |
| PYFLP-CH | `https://pyflp.readthedocs.io/en/latest/reference/channel/channel.html` (channel volume, pan, color defaults) |
| PYFLP-SH | `https://pyflp.readthedocs.io/en/latest/reference/channel/shared.html` (Time: swing mix, shift, gate) |
| PYFLP-RACK | `https://pyflp.readthedocs.io/en/latest/reference/channel/index.html` (global swing 0–128, default 0) |
| F-FINE | `https://forum.image-line.com/viewtopic.php?p=1966980` (fine pitch ±1200 cents, 10-cent steps) |
| F-SWING | `https://forum.image-line.com/viewtopic.php?p=2025139` (swing math; only partly visible without login) |
| F-GSW | `https://forum.image-line.com/viewtopic.php?p=2056859` (global swing covers all channels and patterns) |
| F-VEL | `https://forum.image-line.com/viewtopic.php?p=77913` (velocity-based note coloring) |
| F-RED | `https://forum.image-line.com/viewtopic.php?p=1820177` (selected notes drawn red) |
| F-B24 | `https://forum.image-line.com/viewtopic.php?p=1949214` (FL 2024.1 beta changelog: note repeat, swing truncate, graph-editor alignment fix) |
| BON | `https://www.bonedo.de/artikel/fl-studio-step-programmierung-workshop-2` (2017; auto-extend from 16 to 32 steps) |
