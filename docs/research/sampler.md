# FL Studio Channel Sampler: implementation spec (research notes)

Scope: FL Studio's built-in **Sampler** channel (Channel Sampler) and its Channel Settings window, written as a reference for a TypeScript + AudioWorklet + Canvas clone. This is research only: it contains formulas and behaviour rules but no code.

Baseline version: FL Studio **2026** (26.1.x). The online manual and change log were read in October 2026, and the newest change-log entry was 26.1.7.5 (2026-10-12). Default values were also read directly from the FL 2026 factory templates and presets in the local install (see [L-TPL]).

---

## Confidence legend and source keys

Every fact carries a confidence mark and one or more source tags.

| Mark | Meaning |
|---|---|
| **C** | Confirmed: the cited source states it, or FL 2026's own data files contain it. |
| **D** | Derived: computed or fitted from several independent sources that agree numerically. Confidence is high, but no source states it word for word. |
| **I** | Inferred: plausible from indirect evidence. Needs verification. |
| **U** | Unknown: not documented anywhere I could find. A placeholder is proposed and must be calibrated against real FL. |

Official Image-Line sources. Manual base URL: `https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/`

| Tag | URL |
|---|---|
| M-SMP | …/chansettings_sampler.htm (Sampler Channel Settings, SMP tab) |
| M-INS | …/chansettings_ins.htm (Envelope / Instrument settings, INS tab) |
| M-MISC | …/chansettings_misc.htm (Miscellaneous Channel Settings) |
| M-MAIN | …/chansettings_main.htm (header controls: ON, PAN, VOL, PITCH/RANGE, TRACK) |
| M-CS | …/chansettings.htm (Channel Settings overview and window menu) |
| M-RACK | …/channelrack.htm (Channel Rack: pan/volume knobs, routing, graph editor) |
| M-LVL | …/mixer_levelsandmixing.htm (section "Sampler Channels vs Audio Clips") |
| M-MIX | …/mixer.htm |
| M-PROJ | …/songsettings_settings.htm (panning law, PPQ, Fast declick for cut groups) |
| M-TB | …/toolbar_panels.htm (Master pitch) |
| M-AUD | …/envsettings_audio.htm (live interpolation) |
| M-EXP | …/fformats_save_export.htm (render interpolation, Disable max polyphony) |
| M-GEN | …/envsettings_general.htm (Auto name channels) |
| M-PR | …/pianoroll.htm (slides, portamento, note properties) |
| M-AC | …/playlist_audioclip.htm (tab names and icons) |
| M-FLP | …/plugins/Fruity%20Fast%20LP.htm |
| M-WRAP | …/plugins/wrapper.htm |
| M-API | …/midi_scripting.htm (Python `channels` module, REC event IDs) |
| M-WN | …/WhatsNew.htm (complete change log) |
| KB624 | https://support.image-line.com/action/knowledgebase?ans=624 (why a Sampler is quieter than an Audio Clip) |
| SDK-T | https://forum.image-line.com/viewtopic.php?p=26365 (Image-Line plugin SDK tutorial: voice velocity, volume and panning) |
| F-GOL | https://forum.image-line.com/viewtopic.php?p=186393 (FL developer: the host dictates the velocity-to-volume curve) |

Local FL Studio 2026 install. These files were read only, never modified.

| Tag | What |
|---|---|
| L-TPL | `/Applications/FL Studio 2026.app/Contents/Resources/FL/Data/Templates/Minimal/Empty/Empty.flp` holds one pristine "Sampler" channel, used here as the default channel state. `…/Minimal/Basic/Basic.flp` and `…/Basic with limiter/…flp` were also read. Decoded with the PyFLP / DawVert event layouts. |
| L-PRE | `…/Data/Patches/Channel presets/Sampler/Basic envelope.fst` and `…/Data/System/SamplerTrack.fst` |
| L-STR | UI strings from the FL 2026 engine binary, extracted locally by a parallel research task |

Community and reverse-engineered sources. Their FLP "raw" ranges are what FL stores in files.

| Tag | URL |
|---|---|
| PYFLP | https://pyflp.readthedocs.io/en/latest/reference/channel/sampler.html, …/shared.html, …/channel.html, …/patterns/pattern.html; source https://github.com/demberto/PyFLP/blob/master/pyflp/channel.py (also mixer.py, project.py) |
| STUBS | https://github.com/IL-Group/FL-Studio-API-Stubs (`midi/__miscellaneous.py`, `midi/__step_params.py`, `channels/__properties.py`) |
| FPSDK | https://crates.io/crates/fpsdk v1.0.3: Rust port of the FL plugin SDK (`src/voice.rs` `vol_to_vel`; bundled `fp_plugclass.h`) |
| VOLTAB | https://github.com/olyrhc/flstudio-volume-converter (measured mixer-fader dB lookup table) |
| DAWVERT | https://github.com/DawVert/DawVert (`plugins/input/mi_flp.py`, `objects/file_proj/_flp/channel.py`) |
| LMMS | https://github.com/LMMS/lmms/blob/v1.1.3/plugins/flp_import/FlpImport.cpp |
| F-294375 | https://forum.image-line.com/viewtopic.php?t=294375 (measured 1.94 dB gap between Sampler and Audio Clip) |
| F-282222 | https://forum.image-line.com/viewtopic.php?t=282222 (pitch-envelope amount formula, ±24 st) |
| F-324142 | https://forum.image-line.com/viewtopic.php?t=324142 (FL's default bend range is ±2 st) |
| F-263310 | https://forum.image-line.com/viewtopic.php?t=263310 (Sampler envelopes are not sample-accurate) |
| F-157671 | https://forum.image-line.com/viewtopic.php?t=157671 (sample plays to its end unless the volume envelope is on) |
| F-223231 | https://forum.image-line.com/viewtopic.php?t=223231 (Levels-adjust VOL: 50% = 0 dB) |
| BERK | https://online.berklee.edu/takenote/how-to-use-fl-sampler-in-fl-studio/ |

---

## 0. Quick reference: core formulas

### 0.1 FL's volume law (one curve for channel volume, velocity and mixer)

```
G(x) = (e^(2.4·x) − 1) / (e^2.4 − 1)          x ≥ 0, where x = 1 means unity gain (0 dB)
```

| Use | x | Notes | Conf |
|---|---|---|---|
| Channel VOL knob | knob position 0…1 (stored raw/12800) | 100% gives 0 dB. The default 78.125% gives 0.5508, which is −5.18 dB. The manual quotes "−5.2 dB (78%)" [M-RACK] and "55% … about −5.2 dB" [M-LVL, KB624]. | **D** |
| Note velocity | velocity/100 (velocity 0…128) | Velocity 100 gives 1.0 (0 dB); velocity 128 gives 2.054 (+6.25 dB). This matches the SDK helper `vol_to_vel`: its inverse, (21.551^(vel/128) − 1)/10, agrees with G within 0.01 dB [FPSDK]. The host owns this curve [F-GOL, SDK-T]. | **D** |
| Mixer fader (for reference) | raw/12800 (raw 0…16000) | Maximum is +5.59 dB (PyFLP: "125% / 5.6 dB / 1.90"). Fits the measured lookup table within ±0.05 dB from +5.6 to −60 dB, and within 0.12 dB at −69 dB [VOLTAB]. | **D** |

Cross-checks:
- **Default state:** VOL 78%, velocity 100, centre pan, circular law gives −8.19 dB. KB624 says the default Sampler state is "about 8.2 dB" below the recorded level. **D**
- **Velocity 128:** the same settings at velocity 128 give −1.94 dB relative to an Audio Clip at default settings. That is exactly the gap a user measured in F-294375. Audio clips are compensated so their default settings read as the recorded level [M-PROJ]. **D**

Channel VOL to dB:

| Knob | 100% | 90% | 80% | 78.125% (default) | 75% | 70% | 60% | 50% | 40% | 30% | 25% | 20% | 10% | 5% | 1% | 0 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dB | 0.00 | −2.32 | −4.72 | −5.18 | −5.95 | −7.22 | −9.86 | −12.71 | −15.87 | −19.56 | −21.72 | −24.23 | −31.35 | −37.91 | −52.31 | −∞ |

Velocity to dB, using G(vel/100):

| Velocity | 128 | 127 | 120 | 110 | 100 | 90 | 80 | 64 | 50 | 40 | 32 | 25 | 16 | 8 | 4 | 1 | 0 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dB | +6.25 | +6.03 | +4.49 | +2.27 | 0.00 | −2.32 | −4.72 | −8.78 | −12.71 | −15.87 | −18.77 | −21.72 | −26.61 | −33.51 | −39.95 | −52.31 | −∞ |

### 0.2 Per-voice amplitude

For one sample frame of one voice:

```
gainL/R = G(chanVol) · LevelsAdjVol · G(vel/100) · EchoGain · Env_vol(t) · LFO_vol(t) · PanLaw_L/R(pan_final)
```

- Channel volume and velocity are applied per voice inside the instrument. They multiply into the voice's final level, which FL keeps updating for the life of the voice, so automating them affects notes already sounding. **C** [M-RACK, SDK-T]
- The SDK says the final level must be multiplied with the plugin's own levels, never added to. **C** [SDK-T]
- The order of the factors and the forms of LevelsAdjVol and LFO_vol are **I/U** (see §6.1 and §5.6).

### 0.3 Pan law (project setting; Circular is the default)

**Circular** is the default (PanLaw enum 0) [M-PROJ, PYFLP, L-TPL]. It drops 3 dB at centre and reaches 0 dB at the hard L/R positions. **C** [M-PROJ, KB624]

Recommended taper (constant power), with p in −1…+1. The exact taper between the endpoints is **I**.
```
θ = (p + 1)·π/4      L = cos θ      R = sin θ
```

**Triangular** (enum 2) applies no compensation as the pan moves. The manual says the overall level is 3 dB below the circular law's extreme positions across the whole pan range. It was changed in FL 11.0.3 so it no longer sounds louder. **C** [M-PROJ, M-WN]
Recommended form (**I**):
```
L = 0.7071·min(1, 1 − p)      R = 0.7071·min(1, 1 + p)
```

Stereo samples are balanced, not truly panned: the L gain applies to the left channel and the R gain to the right. **I** (the SDK notes that stereo sources "are not mixed (not a true panning)" [FPSDK fp_plugclass.h]). FL exposes this law to plugins as `ComputeLRVol` [SDK-T].

### 0.4 Pitch and playback rate

```
cents = 100·(note − root) + noteFine + fineTune + chanPitch + mainPitch·[EnableMainPitch]
        + pitchEnv + pitchLFO + slide/porta offset + echoPitch·n
rate  = 2^(cents/1200) · (fileSampleRate / outputSampleRate) · stretchFactor
```

stretchFactor is 1 unless TIME is set while the mode is Resample (§3.5). The structure is **I**. Each component is sourced in §4.5.

---

## 1. Channel Settings window layout

### 1.1 Window frame

| Element | Behaviour | Conf / Src |
|---|---|---|
| Options menu (down-arrow, top-left) | Contains:<br>• **Save channel state as…** (.fst preset; draggable)<br>• **Route to free mixer track** (Ctrl+L): first empty insert<br>• **Rename…** (F2); right-clicking the title bar also renames<br>• **Sample ▸**: Reload, Save as… (writes the sample with precomputed effects applied), Edit… (E) (opens the audio editor), Detect tempo, Get properties, Spectrum view, Multichannel waveform view<br>• **Delete** (added in 26.1.5) | C [M-CS, M-WRAP, M-WN] |
| Title | Channel name. With "Auto name channels" on, a Sampler takes the sample's name; duplicates get "#1", "#2". A new empty Sampler is called "Sampler". | C [M-GEN, L-TPL] |
| Preset arrows | Step through channel presets; right-click opens the preset menu. Sampler factory presets live in `Channel presets/Sampler` ("Default", "Basic envelope"). | C [M-WRAP, L-PRE] |
| Minimize / close | Standard window controls | C [M-WRAP] |

### 1.2 Header row

Order follows the manual's numbering, which is the on-screen left-to-right order [M-MAIN].

| # | Control | Summary (full detail in §2) | Conf |
|---|---|---|---|
| 3–5 | **Tabs:** Sample settings (SMP) → Envelope/Instrument settings (INS) → Miscellaneous settings (MISC) | The Plugin-GUI and VST-wrapper tabs (1–2) do not appear for a Sampler. Icons: SMP is a waveform, MISC is a spanner [M-AC], INS is an envelope shape (I). | C [M-MAIN, M-AC] |
| 6 | **ON** | Mute switch. Right-click gives Solo. Affects only Step Sequencer and Piano roll playback; live MIDI still sounds. | C [M-MAIN] |
| 7 | **PAN** | Same control as the Pan knob in the Channel Rack row | C |
| 8 | **VOL** | Same control as the Volume knob in the Channel Rack row | C |
| 9 | **PITCH** with **RANGE** | PITCH bends the whole channel; RANGE sets the bend span in semitones | C |
| 10 | **TRACK** (mixer target) | LCD showing the target mixer track. Click the TRACK label to assign the next empty track. | C |

Legacy tab set: up to FL 11 the Sampler had four tabs, **SMP, INS, MISC, FUNC**. In current FL the FUNC content (Time, Echo delay, Arpeggiator) lives inside MISC. FL still names that tab "functions" internally (`forms.pluginform.tabs.functions`), and PyFLP calls the page "Miscellaneous functions". **I/C** [M-AC lists Time, Arpeggiator and Echo inside MISC; L-STR; PYFLP]

### 1.3 Channel Rack row (same channel)

From left to right: Mute LED, Pan knob, Volume knob, Mixer-track selector, Channel button (name; click opens the settings window), Selector/activity LED, then step buttons or a piano-roll preview. **C** [M-RACK]
- The mixer-track selector is visible only with the rack option "Show mixer track selectors" (Alt+M). **C**
- A missing sample turns the channel button red. **C**

---

## 2. Channel-level controls

| Control | UI range | Default | Display | FLP storage | Script API (`channels.*`) | Notes | Conf / Src |
|---|---|---|---|---|---|---|---|
| **VOL** | 0–100% | **78%** (10000/12800 = 78.125%) | % with dB | `Levels.volume` 0…12800, default 10000 | get/setChannelVolume, normalized 0…1, default `ChannelDefaultVolume = 1000/1280`; `mode=1` returns dB | Gain = G(knob) (§0.1). Audio Clips play at their original level by default. | C [M-RACK, PYFLP, STUBS, L-TPL]; dB law D |
| **PAN** | 100% L … 100% R | Centred | "Centered", "N% left", "N% right" | `Levels.pan` 0…12800, centre 6400 | getChannelPan: −1…+1, default 0 | Sent to the instrument, so it is per voice. Combines with note pan (§4.4); the project pan law applies. | C [M-RACK, PYFLP, STUBS, L-STR, L-TPL] |
| **PITCH** | ±RANGE | 0 | cents / semitones | `Levels.pitch_shift` in cents, ±4800 | getChannelPitch: mode 0 = factor of range (−1…1), mode 1 = cents, mode 2 = range | Real-time bend applied to all voices. Automation or events can push it beyond RANGE. | C [M-MAIN, PYFLP, STUBS, M-WN 18338] |
| **RANGE** (bend range) | semitones; typed values allowed since 20.9 | **2** semitones | integer semitones | not found in the FLP layouts | getChannelPitch(mode=2) is unreliable [STUBS] | Max is probably **48** st, since storage spans ±4800 cents (I). The Berklee tutorial suggests the SMP-tab stretch PITCH knob follows RANGE (U). | default: forum report F-324142 (I); C [M-MAIN, M-WN 10914] |
| **TRACK** | `---` (Master), 1…500 inserts, `C` (Current) | `---` (Master) for any new channel | LCD | FLP event 104 (16-bit; 0 = Master). Older FLPs used `RoutedTo` (−1 = Current, 0 = Master). | get/setTargetFxTrack | Drag vertically to change. Double-click opens the Mixer at that track; clicking the TRACK label assigns the next empty track. | C [M-MAIN, M-RACK, M-MIX, PYFLP]; event 104 as the routing field is I (values 1–5 in the drum templates, 0 in Empty) [L-TPL] |
| **ON** (mute) | on / off | on | LED | `IsEnabled` | mute/solo functions | Gates only sequenced playback | C [M-MAIN, M-RACK] |

Template routing (FL 2026): **I** (strong; read from event 104 in [L-TPL])
- "Basic" and "Basic with limiter" route the four drum Samplers (808 Kick, Clap, HiHat, Snare) to inserts **1–4**. "Basic with limiter" also has a fifth channel ("808 Astronomic") on insert 5, with Cut/Cut-by = 1/1.
- "Empty" has one empty Sampler routed to Master.
- Channels added afterwards always go to Master unless re-routed (**C** [M-MIX, M-MAIN]). Users have asked for an auto-route option, but none exists.

---

## 3. SMP tab (Sample settings)

Section order on screen: File → Content → Playback → Declicking → Time stretching / Pitch shifting → Precomputed (Tools tab and Effects tab) → Sample view. **C** [M-SMP]

### 3.1 File

| Item | Behaviour | Conf |
|---|---|---|
| Sample name | Click to open the OS file browser at the sample | C [M-SMP] |
| Load sample | Opens a file dialog; right-click shows the load history | C |
| Locate in browser | Reveals the file in FL's Browser | C |
| Remove sample | Clears the channel; the file is not deleted | C |
| Loading | Drop a file on the Channel Rack to create a Sampler; dropping on the Playlist creates an Audio Clip instead. | C [M-SMP] |
| Embedded root note | Since FL 24.2/25 the root note embedded in a WAV or AIFF sets the channel root on load. A global option ("Read sample root note") can disable this. | C [M-WN 4473, 20055] |

### 3.2 Content (toggles)

| Toggle | Default | Behaviour | Conf / Src |
|---|---|---|---|
| Keep on disk | off | Stream the sample from disk; max 2 GB per channel; needs 16/32-bit WAV; disables precomputed effects. In a web clone this is only a flag. | C [M-SMP], default C [PYFLP] |
| Resample | **U**. PyFLP says off, but the FL 2026 empty Sampler has SamplerFlags = 3, which sets the bit PyFLP labels "Resample". | Pre-resample a sample whose rate differs from the device rate. Better quality, but loop points may click and it costs CPU/RAM. | C [M-SMP]; default U [PYFLP vs L-TPL] |
| Load regions | on | Read embedded region markers (ZGR/REX etc.) for Slice stretch / Slice map and tempo detection | C [M-SMP, PYFLP] |
| Load slice markers | off | Read embedded beat/slice markers | C [M-SMP, PYFLP] |

SamplerFlags bits: 1 = Resample, 2 = Load regions, 4 = Load slice markers, 8 = Use loop points, 256 = Keep on disk [PYFLP]. FL 2026 values seen: empty Sampler 3; drum templates 3 or 11 (11 = samples with loops); SamplerTrack.fst 10 [L-TPL, L-PRE].

### 3.3 Playback

| Control | Range | Default | Behaviour | Conf / Src |
|---|---|---|---|---|
| **Start offset** | 0–100% of sample length | 0 | Shifts the playback start without trimming data. Automatable (REC_Chan_SmpOfs). Declicking softens non-zero starts; the area before the offset is dimmed in the view. | C [M-SMP, M-API, M-WN 20921]; storage: double 0…1 [DAWVERT, L-TPL] |
| **Loop start / end** | sample positions | from the embedded WAV loop, else off | Stored per project, not in the file. Hold Shift to move both. Draggable handles. Added as "dynamic loop points" in 25.1.99. | C [M-SMP, M-WN 20749] |
| **Use loop points** | toggle | effectively on when the sample has loops | Playback starts at the sample start. On reaching loop end it jumps to loop start, and repeats while the note is held. | C [M-SMP]; default I [L-TPL flags, DAWVERT] |
| **Ping pong loop** | toggle | off | Plays forward then backward between the loop points. It is precomputed, so the handles are disabled. It works even without loop points (FL 1.5.23). | C [M-SMP, M-WN] |

### 3.4 Declicking (menu)

The default is **Out only**. **C** [M-SMP, PYFLP, L-TPL]

"Bleeding" means the fade runs past the start or end point, so it uses audio outside the region. Fade markers appear in the view only for bleeding modes.

| Enum | Mode | Fade in | Fade out | Bleeding |
|---|---|---|---|---|
| 0 | **Out only** (default) | none | 10 ms cosine S-curve | no |
| 1 | Transient (no bleeding) | only the first few samples are ramped, so the attack is kept | 10 ms "filtering" fade | no |
| 2 | Transient (bleeding) | as mode 1 | 20 ms cosine S-curve | yes |
| 3 | Generic (bleeding) | 20 ms S-curve | 20 ms S-curve | yes |
| 4 | Smooth (bleeding) | 100 ms | 100 ms | yes |
| 5 | Crossfade (bleeding) | 200 ms | 200 ms (designed for butted clips) | yes |

Related settings:
- Project option **Fast declick for cut groups** makes channels in a cut group use Transient (no bleeding), so a sample cut by another stops without a click. **C** [M-PROJ]
- Rack menu item "Change declicking for selected channels". **C** [M-RACK]
- Realtime stretch modes bypass the declicker (25.1.99 fix list). **C** [M-WN 20740]

When to apply declick in a clone (**I**):
- Fade in when Start offset (or a trimmed start) is non-zero.
- Fade out whenever a voice is stopped early: cut group, max-poly steal, end of the gate, or note-off on a looped voice without an envelope (§4.2).
- Fade out at a trimmed end (LENGTH < 100%).

### 3.5 Time stretching / Pitch shifting

| Control | Range | Default | Behaviour | Conf / Src |
|---|---|---|---|---|
| **PITCH** | ±1200 cents | 0 | Changes pitch but keeps the length. Moving it while the mode is Resample switches the mode to Auto. The knob's span may follow RANGE (BERK, U). | C [M-SMP, PYFLP] |
| **MUL** (time multiplier) | 25%–400%, logarithmic | 100% | Multiplies the sample's length | C [M-SMP, PYFLP, L-TPL] |
| **TIME** (duration) | right-click menu: (none), Autodetect, Project tempo, a number of beats/bars | **(none)** | Target duration of the sample from start to end. (none) = no stretch; the sample pitches with note and channel pitch. Project tempo locks the sample to tempo, so later tempo changes re-stretch it. Automatable since 20.1. | C [M-SMP, M-WN] |
| **Mode** | see the list below | **Resample** | How TIME and PITCH are realised | C list [M-SMP]; default C [L-TPL st_mode = 0] |
| **F.Shift** (formant shift, Stretch pro only) | about ±12 st (stored 0…1, centre 0.5) | 0 | Shifts formants | C [M-SMP]; range I [DAWVERT] |

Stretch modes, with FLP enum values [PYFLP]:

| Group | Modes |
|---|---|
| Realtime | **Resample** (0): pitch follows play speed, like tape. In the Piano roll each note of a chord plays at a different speed.<br>**Stretch** (−1): keeps time and pitch independent; in sync while tempo is automated; when first selected, TIME locks to the current tempo.<br>**Stretch pro**: élastique Pro with formant control, added in 20.9; enum value U. |
| Offline (Elastique) | **e3 Generic** (1), **e3 Mono** (2) |
| Special | **Slice stretch** (3): for loops slower than the project.<br>**Slice map** (4): slices moved without stretching, for loops faster than the project.<br>**Auto** (5) |
| Legacy | **e2 Generic** (6), **e2 Transient** (7), **e2 Mono** (8), **e2 Speech** (9). Projects from before FL 12 map onto these. |

Clone semantics (**I**):
- In Resample mode with TIME set: speed factor = (sample length in seconds) / (TIME in beats × 60 / BPM × MUL). Note pitch multiplies the rate further.
- Non-Resample modes keep the duration and shift pitch with a stretcher (phase vocoder or granular). A web clone may defer these modes.
- Stretch and Stretch Pro were capped at ±24 st until fixed in 25.1.2. **C** [M-WN 20405]

### 3.6 Precomputed processes

These are destructive re-renders of the sample data, so none of them can be automated. Tweaking one while the sample plays glitches when the data is replaced. **C** [M-SMP]

The display units below are **U** unless stated. Raw ranges come from PyFLP; defaults are confirmed by the FL 2026 empty template [L-TPL].

**Tools tab**

| Control | Type / raw range | Default | Behaviour |
|---|---|---|---|
| Remove DC offset | toggle | off | Removes DC bias |
| Reverse polarity | toggle | off | Inverts the waveform ("Flip Y" internally [L-STR]) |
| Normalize | toggle | off | Peak-normalizes to 0 dB |
| Fade stereo | toggle | off | Fades from the left channel to the right ("Pan fading" [L-STR]) |
| Reverse | toggle | off | Reverses the sample |
| Swap stereo | toggle | off | Swaps L and R |
| SMP START | 0…1 of the sample | 0 | Trims the start (unlike Start offset, which does not trim) |
| LENGTH | 0…1 | 1.0 | Trims the end |
| IN (quick fade-in) | 0…1024 | 0 = off | Turn fully left to disable |
| OUT (quick fade-out) | 0…1024 | 0 = off | Turn fully left to disable |
| CROSSFADE | 0…256 (0–100%) | 0 = off | Crossfades the loop region for a smooth loop |
| TRIM | 0…256 (0–100%) | 0 | Threshold for automatic trailing-silence trimming. At 0 only exact digital silence is removed. FL always trims trailing silence. |

**Effects tab**

| Control | Type / raw range | Default | Behaviour |
|---|---|---|---|
| BOOST | 0…256 | 0 | Pre-amp gain |
| CLIP | toggle | off | Hard-clips at 0 dB after boost |
| EQ | 0…256, bipolar | 128 = flat | Frequency tilt: left cuts, right boosts |
| RM MIX | 0…256 | 0 = off (I) | Ring-mod mix |
| RM FREQ | 0…256 | 128 | Frequency of the ring-mod sine |
| CUT | 16…1024 | 1024 = open | Lowpass cutoff |
| RES | 0…640 | 0 | Lowpass resonance |
| REVERB | mix 0…256, type A/B | mix 0; type B (raw 65536, I) | A = closer and tighter; B = farther and larger |
| STEREO DELAY | 0…4096, bipolar | 2048 = none | Haas delay. Right moves the left channel earlier; left moves the right channel earlier. |
| POGO | 0…512, bipolar | 256 = none | Pitch-bend effect. Left focuses the drop on the attack; right on the tail. |

The order of the effect chain is **U**. A sensible order: trim/start/length → DC → normalize → polarity → reverse → swap → fade stereo → boost/clip → EQ → ring mod → LP filter → stereo delay → pogo → reverb → in/out fades → loop crossfade → ping-pong render.

### 3.7 Sample view

- **Display:** the waveform after precomputed effects. Lower-right indicators show bit depth and channel count. MP3, OGG, WV and 24-bit files are converted to 32-bit on load. Shows red vertical lines for start and loop markers, orange triangles for regions, and fade markers for bleeding declick modes. **C** [M-SMP]
- **Mouse:**
  - Left-click previews (tempo-synced when stretching is on).
  - Drag the waveform out to the Playlist, Slicex, Edison and similar.
  - Drag the start and loop handles; mouse wheel zooms; there is a scrollbar.
  - Right-click menu: Reload, Save as…, Locate file, Copy/Paste audio (Ctrl+C/V; paste writes a new WAV), Edit in audio editor (E), Edit in pitch corrector, Edit in time warper, Open in new Sampler / Granulizer / Slicer / Slicex channel, Detect tempo, Get properties, Spectrum view, Multichannel waveform view, Tools. **C** [M-SMP]

### 3.8 Interpolation (global, not per channel)

| Where | Options | Default | Conf |
|---|---|---|---|
| Live: Audio Settings › Mixer › Resampling | Linear, 6-point Hermite, 24-point sinc, 64/128/256/512-point sinc | **24-point sinc** | C [M-AUD] |
| Render: Export dialog › Resampling | Linear, 6-point Hermite, 16/24…512-point sinc | not stated (U) | C [M-EXP] |

Higher-quality interpolation only matters for transposed samples. A clone needs at least linear and a windowed-sinc option. Web note: `decodeAudioData` already resamples to the context rate, which matches FL's per-channel "Resample" being on; real-time rate conversion is still needed for pitch.

---

## 4. Playback semantics (voice model)

### 4.1 Note-on processing order

**I** (assembled from the rules cited below):
1. **Key region:** notes outside the region are ignored. **C** [M-MISC]
2. **Arpeggiator and Echo delay** produce extra note events. **C**: echoes are real note voices [M-MISC].
3. **Cut groups:** this channel's **Cut** sends a release to every channel whose **Cut by** matches. **C** [M-MISC]
4. **Polyphony:**
   - Mono releases the current voice; overlapping notes glide.
   - Max poly forcibly releases the oldest voices over the limit, which stop immediately.
   - **C** [M-MISC]
5. **Create the voice:**
   - Start at SMP START plus Start offset.
   - Initial levels: velocity, pan, fine pitch, Mod X and Mod Y from the note.
   - Final levels = voice levels combined with channel levels. FL keeps updating these for slides and other effects. **C** [SDK-T, FPSDK header: "final voice levels (voice levels+parent channel levels)"]

### 4.2 How a voice ends

| Volume envelope | Loop | Note-off (end of note) | End of playable region | Conf |
|---|---|---|---|---|
| **off** | off | **Ignored**: the sample plays to its end whatever the note length (one-shot) | Voice ends | **C** [M-SMP, F-157671] |
| **off** | on | **U**. The manual only says looping repeats while the note is held. Recommended: leave the loop and stop with the declick fade-out. (A converter, DawVert, treats looped samples without an envelope as gated.) | not reached while looping | U |
| **on** | any | Jump to Release from the current level, whatever stage the envelope is in | Voice ends even if the envelope is still going | **C** for release [M-INS]; rest I |
| any | any | **Cut** (cut groups, Cut itself) or **Max-poly steal**: forced stop. Voices with an envelope release; voices without one stop with the declick fade. Max-poly notes "stop playing immediately". | | C [M-MISC, M-PROJ]; detail I |

Further rules:
- FL's "Basic envelope" preset gives gate behaviour: volume envelope on, minimum DEL/ATT/HOLD/DEC/REL, SUS 100%. **C** [L-PRE]
- **Gate** (MISC › Time) caps the note length, which only matters when note-off matters (envelope on or looping). **C** [M-MISC]; scope I
- **Full porta:** porta notes ignore the gate. **C**
- **Step-sequencer notes** are stored with zero length, and the manual says steps have no note-off of their own. How long a zero-length step holds a gated voice is **U**. Recommended: treat it as 1 step (1/16).

### 4.3 Velocity, release velocity and Mod X/Y

| Property | Range | Default | Effect on the Sampler | Conf / Src |
|---|---|---|---|---|
| Velocity | 0…128 (piano roll shows vel/128 as %, so 100 is "78%") | **100** | Volume through G(vel/100) (§0.1). Velocity 100 is unity; 128 is +6.25 dB. The host applies this mapping. | values C [PYFLP, STUBS DotVol_Default/DotVol_Max]; curve D [FPSDK, KB624, F-294375] |
| Velocity → cutoff/resonance/pan | via the MISC velocity tracker (§6.4) | amounts 0 | Bipolar offsets around MID (default 100) | C [M-MISC, L-TPL] |
| Release velocity | 0…128 | 64 | No documented Sampler mapping (**U**). The SDK gives plugins a release velocity and a "release time multiplier 0…2", which suggests relVel/64 could scale release time; unverified. | values C [PYFLP, STUBS]; SDK C [FPSDK FPV_GetRelVelocity / FPV_GetRelTime] |
| Note Mod X / Mod Y | 0…255 | 128 | Offset added to the channel's Mod X (cutoff) and Mod Y (resonance). Recommended: (v − 128)/128 in normalized units. | range C [PYFLP]; mapping I |
| Note pan | 0…128 | 64 (centre) | Added to channel pan (§4.4) | C [PYFLP, STUBS] |
| Note fine pitch | 0…240 = ±1200 cents (10-cent steps) | 120 (0 cents) | Added to pitch. The manual's Graph Editor text says ±100 cents; this conflicts. | C [PYFLP, STUBS]; conflict noted [M-RACK] |

### 4.4 Pan combination

```
pan_final = clamp(notePan + chanPan + levelsAdjPan + keyTrackPan + velTrackPan + panLFO + n·echoPan, −1, +1)
```

The pan law is then applied to pan_final (§0.3).
- Adding the terms is **I**, based on the SDK's statement that final levels are voice levels plus channel levels.
- The terms themselves are **C** [M-MISC].
- Echo pan "bounces" off ±100% when Ping Pong is on. **C** [M-MISC]
- Portamento and slides also glide the pan. **C** [M-MISC, M-PR]

### 4.5 Pitch components

| Term | Range | Default | Notes | Conf / Src |
|---|---|---|---|---|
| note − root | root 0…131 (C0…B10) | root **C5** (60) | A higher root makes a given key sound lower | C [M-MISC, PYFLP] |
| noteFine | ±1200 c | 0 | Per note | C [PYFLP] |
| fineTune (MISC FINE) | ±100 c | 0 | Tunes the base note | C [M-MISC, PYFLP] |
| chanPitch | ±RANGE (stored ±4800 c) | 0 | Real-time bend | C [M-MAIN, PYFLP] |
| mainPitch (toolbar Master pitch) | ±1200 c | 0 | Applies only if **Enable main pitch** is on (default on). Snaps to 100 c; hold Shift to bypass. Can be typed as Hz for A (default 440). | C [M-TB, PYFLP, L-TPL main_pitch = 1] |
| pitch envelope | AMT ±100% = **±24 st** | AMT 0 | User-derived formula: AMT = 0.5 + st/48 | community C [F-282222] |
| pitch LFO | AMT ±100% | 0 | Depth in semitones is U. Recommended: the same ±24 st scale. | U |
| porta / slide | glide toward the target | — | Covers pitch, cutoff, resonance and pan | C [M-MISC, M-PR] |
| echo | n × PITCH (±1200 c per echo) | 0 | Cumulative per echo | C [M-MISC, PYFLP] |
| stretch PITCH | ±1200 c | 0 | Only in non-Resample modes | C [M-SMP] |

**Add to key** has no audible effect on a single-sample Sampler. It only matters for multisampled instruments: it chooses whether the root offset and main pitch transpose the incoming note or re-pitch the samples. **C** [M-MISC]

### 4.6 Note naming

FL numbers notes 0…131 as **C0…B10**. MIDI 60 is **C5** (middle C, the default root), and MIDI 69 is A5 (440 Hz). Name = `["C","C#",…,"B"][n%12] + floor(n/12)`. FL uses sharps by default, configurable. **C** [M-MISC, STUBS `MiddleNote_Default = 60`, PYFLP, M-GEN]

### 4.7 Timing modifiers

| Modifier | Rule | Conf |
|---|---|---|
| Swing | Delays every even 16th. Effective amount = global swing × channel Swing mix (both 0…100%); either at 0 disables it. The maximum delay at 100% is U. | C [M-RACK, M-MISC] |
| Truncate swing notes | Right-click on Swing: shortens swung notes so they do not overlap | C [M-MISC] |
| Shift (MISC) | Delays all notes by 0 to 1 step | C [M-MISC] |
| Graph-editor Shift | Per-step offset: 100% ≈ 99% of one 16th | C [M-RACK] |
| PPQ | Default 96 (24 ticks per step); FL displays times as steps:ticks | C [M-PROJ] |

### 4.8 Envelope update rate

A forum reply says Sampler envelopes are not sample-accurate. **C** (forum) [F-263310]
Recommendation: evaluate envelopes and LFOs per sample, or per ≤32-sample block with linear smoothing. Do not try to reproduce FL's jitter. **I**

### 4.9 Per-voice signal flow (recommended)

**I**:
1. **Source read:** fractional position, loop or ping-pong, interpolation kernel.
2. **Filter:**
   - type from the INS menu;
   - cutoff = channel Mod X + note Mod X + Mod X envelope × AMT + Mod X LFO + tracking + levels-adjust + echo offset;
   - resonance from the matching Mod Y chain.
3. **Gain:** §0.2.
4. **Pan law:** §0.3.
5. **Declick ramps.**
6. Sum to the channel bus, then the mixer insert.

---

## 5. INS tab (Envelope / Instrument settings)

### 5.1 Layout

- **Target tabs:** PAN | VOL | MOD X | MOD Y | PITCH. The same order is used for the five EnvLFO records in the FLP. **C** [M-INS, PYFLP, LMMS, L-TPL]
- **Each target** has an envelope section and an LFO section.
- **No pan envelope** in current FL: the manual says there are 4 envelopes and 5 LFOs. **C** [M-INS]
  - Historically a pan envelope existed: FL 2.5 shipped full envelopes for pan, volume, filter and pitch; FL 8.0 made the pan envelope bipolar [M-WN].
  - FLP data still stores envelope fields for pan [L-TPL].
  - The clone should follow the current manual but keep those fields in the data model.
- **Filter section:** type menu, Mod X (cutoff) knob, Mod Y (resonance) knob. **C**
- **Envelope Presets menu:** `.fnv` files under User data › Presets › Channel envelopes. Added in FL 25. **C** [M-INS, M-WN 18358]
- **Preview keyboard** at the bottom (shared with MISC). **C**
- **Global options:** only the per-section **TEMPO** switches. No velocity→attack or key→decay controls are documented for the Sampler. **C** (by absence) [M-INS]

### 5.2 Envelope controls

These targets have envelopes: VOL, MOD X, MOD Y, PITCH.

Raw ranges and defaults are confirmed by PyFLP and by every envelope in the FL 2026 empty Sampler [PYFLP, L-TPL]. "%" is raw ÷ max.

| Control | Raw range | Default raw (≈ %) | Behaviour | Conf |
|---|---|---|---|---|
| Enable (orange LED) | bool | **off** (all envelopes) | The envelope applies only when enabled | C [M-INS, L-TPL] |
| DEL (pre-delay) | 100…65536 | 100 (min) | Gap between note start and the attack | C |
| ATT | 100…65536 | 20000 (31%) | Attack time (level 0 → 1) | C |
| HOLD | 100…65536 | 20000 (31%) | Holds at maximum before the decay | C |
| DEC | 100…65536 | 30000 (46%) | Decay time (1 → SUS) | C |
| SUS | 0…128 | 50 (39%) | Sustain level while the note is held | C |
| REL | 100…65536 | 20000 (31%) | Release time (current level → 0) | C |
| AMT | −128…128 (±100%) | 0 | Bipolar depth; 0 = no effect; negative inverts. The VOL envelope has no AMT, since the volume envelope always applies at full depth (I). | C [M-INS, PYFLP]; VOL detail I [LMMS] |
| Tension (ATT / DEC / REL) | −128…128 (±100%) | 0 / 0 / 0, except the **VOL release tension = −101 (−79%)** | Bends each segment convex or concave. Small knobs sit under ATT, DEC and REL; there is also a "tension edit mode". | C [M-INS, PYFLP, L-TPL] |
| TEMPO | bool | off | Times become tempo-based. Right-click any time knob for "Set ▸" presets; picking one turns TEMPO on. | C [M-INS] |

### 5.3 Envelope time scaling (U)

The non-synced seconds per knob value are not documented.

One community approximation, from DawVert, with x = raw/65535:
```
t_seconds ≈ ((3.66·x)^4.5 / 8)^0.6  =  (3.66·x)^2.7 / 3.48
```

| Raw (≈ %) | 5000 (8%) | 10000 (15%) | 20000 (31%, default ATT/HOLD/REL) | 30000 (46%, default DEC) | 40000 (61%) | 50000 (76%) | 65536 (100%) |
|---|---|---|---|---|---|---|---|
| Seconds | 0.009 | 0.06 | 0.39 | 1.16 | 2.5 | 4.6 | 9.5 |

**Action:** measure in FL. Render a known sample with each knob at 0, 25, 50, 75 and 100% and fit the result. Keep the curve as one swappable function.

### 5.4 Tension curve (U)

FL's formula is undocumented. Recommended placeholder for a segment with normalized time u in 0…1 and tension τ in −1…1:
```
shape(u) = u^(2^(k·τ))      with k ≈ 3
```
For release, level = start·(1 − shape(u)). With the default τ = −0.79 this gives a fast initial drop and a long tail, which matches the look of FL's default release. The k value and the sign per segment must be calibrated visually against FL's envelope graph.

### 5.5 What each envelope drives

All rows are **I** except the pitch row.

| Target | Effect of env(t) in 0…1 |
|---|---|
| VOL | gain ×= env(t). Note-off jumps to Release. When the envelope reaches 0 after release, the voice ends. |
| MOD X | cutoff_norm += AMT·env(t), then clamp to 0…1 |
| MOD Y | resonance_norm += AMT·env(t) |
| PITCH | cents += AMT·env(t)·2400 (±24 st per F-282222, community C) |

### 5.6 LFO controls (all five targets)

Raw values and defaults: **C** [PYFLP, L-TPL].

| Control | Raw range | Default | Behaviour | Conf |
|---|---|---|---|---|
| Shape | Sine / Triangle / Pulse (square) | **Sine** | Selector at the top-left of the section | C [M-INS, PYFLP] |
| DEL | 100…65536 | 100 (min) | Delay before the LFO starts | C |
| ATT | 100…65536 | 20000 (31%) | Fade-in of LFO depth | C |
| AMT | −128…128 | 0 | Bipolar depth; negative inverts phase; 0 = off | C |
| SPD | 200…65536, logarithmic | 32950 (50%) | Frequency. 50% equals a 16-step period when tempo-synced [PYFLP]. The Hz range when not synced is **U**. | C/U |
| TEMPO | bool | off | DEL, ATT and SPD become tempo-based; right-click "Set ▸" presets | C |
| GLOBAL | bool | off (I) | On: free-running and shared, does not restart. Off: restarts with every note. | C behaviour [M-INS]; default I |

Recommended target mappings (**U**): with lfo in −1…1 after the delay and fade-in,
- Pan: += AMT·lfo
- Mod X / Mod Y: += AMT·lfo (normalized)
- Volume: gain ×= 1 − |AMT|·(1 − lfo')/2, where lfo' = ±lfo by the sign of AMT, so tremolo never exceeds unity
- Pitch: §4.5

### 5.7 Filter section

| Item | Values | Default | Conf |
|---|---|---|---|
| Type (enum) | 0 **Fast LP**, 1 LP, 2 BP, 3 HP, 4 BS (band-stop), 5 LPx2 (steep LP), 6 SVF LP, 7 SVF LPx2 | **Fast LP** | C [M-INS, PYFLP] |
| Mod X (cutoff) | 0…256 raw (0–100%); higher = higher cutoff in every type, so HP at 100% leaves almost nothing | **100%** (256) | C [M-INS, PYFLP, L-TPL] |
| Mod Y (resonance) | 0…256 raw | **0%** | C |
| Bypass | Fast LP with Mod X = 100% and Mod Y = 0% bypasses filtering entirely; this is the default state | — | C [M-INS] |

Notes on the filter types:
- Fast LP uses the same algorithm as the Fruity Fast LP effect: very cheap and built for automation. **C** [M-FLP]
- Filters were made consistent across sample rates in FL 4.1.2. **C** [M-WN]
- Slopes (**I**): LP/BP/HP/BS about 12 dB/oct; LPx2 and SVF LPx2 about 24 dB/oct; SVF types are state-variable designs.

Mapping from Mod X to Hz and Mod Y to Q is **U**. Recommended placeholder:
```
f_c = 20 Hz · 2^(10·modX)        (20 Hz … 20.5 kHz)
Q   = 0.707 · 30^modY            (≈0.7 … 21)
```
- Keep the Fast LP bypass rule exactly.
- DawVert's guess differs: (modX·100)²·0.45 Hz, with ×2.7 for non-Fast types. Calibrate against FL.

### 5.8 Everything that feeds Mod X / Mod Y

- Channel knob value (INS)
- Note Mod X/Y
- Envelope and LFO
- Velocity and key trackers (MISC)
- Levels adjustment MOD X/Y (MISC)
- Per-echo CUT/RES offsets (MISC)
- Portamento and slide glides

**C** for the list [M-INS, M-MISC, M-RACK, M-PR]. That they combine by addition is **I**.

---

## 6. MISC tab (Miscellaneous functions)

Section order: Levels Adjustment → Polyphony → Time → Velocity/Keyboard Tracking → Cut Groups → Arpeggiator → Echo Delay → Preview Keyboard. **C** [M-MISC]

FL 2026 defaults below come from the empty Sampler [L-TPL].

### 6.1 Levels adjustment

These are separate offset and multiplier knobs, so automation can work on them without touching the main knobs.

| Knob | Range | Default | Behaviour | Conf / Src |
|---|---|---|---|---|
| PAN | bipolar | 0 | Pan offset | C [M-MISC, L-TPL] |
| VOL | 0–200% | 100% (raw 12800) | Volume multiplier, "up to twice as loud". The curve is **U**: linear would give +6 dB at 200%, while G(raw/12800) would give +21.6 dB. A user reports knob 50% = 0 dB and maximum "≈ +18 dB?", which favours the G law. | C range/default [M-MISC, L-TPL]; curve U [F-223231] |
| MOD X / MOD Y | bipolar | 0 | Offsets | C |

The scripting API also lists a "Levels adjustment pitch" event (`REC_Chan_OfsPitch`), but there is no visible knob for it. **C** [M-API]

### 6.2 Polyphony

| Control | Range | Default | Behaviour | Conf / Src |
|---|---|---|---|---|
| MAX | `---` (unlimited) or 1…N; N is U | `---` (raw 0) | Over the limit, the oldest notes are force-released and stop immediately. Ignored when exporting with "Disable maximum polyphony". | C [M-MISC, M-EXP, L-TPL] |
| Mono | toggle | off | One note at a time. Overlapping notes slide into each other, including cutoff, resonance and pan, over SLIDE. Mono triggers the release of the current note, so overlap is possible. Overrides MAX. | C [M-MISC] |
| Porta | toggle | off | Portamento: each new note glides from the previous one over SLIDE, including cutoff, resonance and pan | C [M-MISC] |
| SLIDE (portamento time) | 0…8 steps (raw 0…1660, nonlinear) | **raw 820 ≈ ½ step** (Basic templates use 500) | Used for porta, for overlapping notes in mono mode, and for porta-flag notes, even when greyed out | C range [PYFLP], default C [L-TPL], mapping I |

Proposed SLIDE mapping, fitted to two points (raw 820 ↔ 0:12 and raw 1660 ↔ 8:00 from PyFLP):
```
steps ≈ 8·(raw/1660)^3.93
```
This fit is **I**.

### 6.3 Time (legacy FUNC tab)

| Control | Range | Default | Behaviour | Conf / Src |
|---|---|---|---|---|
| GATE | 0:03 … 4:00 (steps:ticks), logarithmic (raw 450…1446); fully clockwise = **off** (raw 1447) | **off** | Maximum note length; longer notes are truncated | C [M-MISC, PYFLP, L-TPL] |
| SHIFT | 0 … 1 step (raw 0…1024, nonlinear) | 0 | Delays note triggering | C |
| SWING (Swing mix) | 0–100% (raw 0…128) | **100%** | Multiplies the global swing | C [M-MISC, M-RACK, PYFLP, L-TPL] |
| Truncate swing notes | right-click on SWING | — | | C |
| Full porta | toggle | **off** (Basic templates have it on) | With porta notes, ignore GATE and play the full length | C [M-MISC, L-TPL] |

Proposed GATE fit, in ticks at 24 ticks per step:
```
ticks ≈ 2^((raw − 129)/200)
```
This fit is **I**.

### 6.4 Velocity / Keyboard tracking

There are two trackers, both always active. The Vel / Key buttons only select which one the knobs show. **C** [M-MISC]

| Knob | Range | Default | Behaviour |
|---|---|---|---|
| MID | note index 0…131 (velocity for the Vel tracker) | Vel tracker **100**, Key tracker **60 (C5)** | No offset at MID; above gives positive offsets, below negative |
| PAN | ±100% (raw ±256) | 0 | |
| MOD X | ±100% | 0 | Usually cutoff |
| MOD Y | ±100% | 0 | Usually resonance |

Ranges: C [PYFLP]. Defaults: C [L-TPL].

Offset scaling is **U**. Recommended:
```
offset = knob · (value − MID) / 127
```
With an exponential cutoff map of about 10 octaves, Key tracking at 100% then follows pitch roughly 1:1.

### 6.5 Cut groups

- **Cut** = n: this channel releases every channel whose **Cut by** = n.
- **Cut by** = n: this channel is released by activity on group n.
- `--` means none, and is the default. Raw data is a (cut, cutBy) pair. **C** [M-MISC, PYFLP, L-TPL]

Notes:
- **Cut itself** sets both values to the same number; it is also on the channel button's right-click menu. It works for Step Sequencer notes but **not Piano roll notes**. For piano-roll use, Max poly = 1 is the equivalent. **C** [M-MISC, M-RACK]
- A cut is a note-level release, not an audio mute, so long releases still ring out. **C** [M-MISC]
- SamplerTrack.fst and the "Basic with limiter" channel 5 ship with Cut/Cut-by = 1/1. **C** [L-PRE, L-TPL]

### 6.6 Arpeggiator (legacy FUNC tab)

| Control | Values | Default (FL 2026 raw) | Behaviour | Conf / Src |
|---|---|---|---|---|
| Direction | 0 Off, 1 Up, 2 Down, 3 Up-Down (bounce), 4 Up-Down (sticky: lowest and highest notes twice), 5 Random | **Off** | Choosing a direction turns the arp on | C [M-MISC, PYFLP, L-TPL] |
| TIME | tempo-based; right-click "Set ▸" presets; at maximum the notes are held (FL 3.4) | raw 1024 (probably 1 step) | Time between arpeggiated notes | C [M-MISC, M-WN]; unit I |
| GATE | 0…100% | raw 48 (= 100%, I) | Shortens notes for a staccato feel | C [M-MISC]; scale I [LMMS] |
| RANGE | octaves | 1 | Transposes the chord across this many octaves | C [M-MISC, L-TPL] |
| REPEAT | count | 1 | Repeats of each note or chord before moving to the next octave | C |
| CHORD | None, Auto, Auto (sustain), then preset chords and scales | raw −1 (probably **Auto**, I) | None steps by 12 semitones. Auto arpeggiates held chords (classic). Preset chords apply a template to each note. Auto (sustain) skips monophonic lines when range = 1. | C [M-MISC, L-TPL] |
| Slide | toggle | off | Slides between arp notes on native instruments | C |

Notes:
- The arpeggiator was "always one tick late" until FL 20.7. **C** [M-WN 8793]
- Burning arp output to MIDI is in the channel menu. **C** [M-RACK]

### 6.7 Echo delay / Fat mode (legacy FUNC tab)

Echoes are extra **note voices**, not an audio delay, so each echo costs a voice. Every setting is applied cumulatively per echo. **C** [M-MISC]

| Control | Range | Default | Behaviour (echo n = 1…ECH) | Conf / Src |
|---|---|---|---|---|
| FEED | 0–200% (raw 0…25600); fully left = **echo off** | **off** (0) | Centre (100%) keeps every echo at the original volume; left fades out; right grows. Recommended: echo gain = (feed/100%)^n (I). | C [M-MISC, PYFLP, L-TPL] |
| PAN | ±100% | 0 | pan += n·PAN, bouncing at ±100% if Ping Pong is on | C |
| CUT (MOD X) | bipolar (raw 0…256) | 128 = none | Cutoff offset per echo | C [PYFLP, L-TPL] |
| RES (MOD Y) | bipolar | 128 = none | Resonance offset per echo | C |
| PITCH | ±1200 cents | 0 | Pitch += n·PITCH (example: +10 c, +20 c, …) | C |
| TIME | 0 … 8 steps; tempo-based | **3 steps** (dotted 1/8; raw 144 at PPQ 96) | Delay between echoes | C [M-MISC, PYFLP, L-TPL]; unit I |
| # ECH | 1…10 | **4** | Number of echoes | C [PYFLP, L-TPL] |
| Ping Pong | toggle | off | Pan bounces | C |
| Fat mode | toggle | off | Subtle echoes with alternating pan, for flanger/chorus effects (similar to unison). Turning it off resets some echo settings to defaults so the result is not too loud. Exact timing in fat mode is **U**. | C [M-MISC] |
| Presets | small arrow at the top-left | — | | C |

### 6.8 Preview keyboard (root, region, tuning)

| Item | Range | Default | Behaviour | Conf / Src |
|---|---|---|---|---|
| Root note | C0…B10 | **C5** | Right-click a key to set it. Shown as the blue key; the hint reads "Root note: X / zone: A to B". | C [M-MISC, PYFLP, L-STR] |
| Key region (zone) | lo…hi | full range (raw 0…256) | Drag on the ruler to set; notes outside are not played; ends are draggable | C [M-MISC, L-TPL] |
| FINE | ±100 cents | 0 | Fine-tunes the base note | C [M-MISC, PYFLP] |
| Reset | — | — | Root back to C5 and region removed | C |
| Enable main pitch | toggle | **on** | Follow the toolbar Master pitch | C [M-MISC, L-TPL] |
| Add to key | toggle | **off** | §4.5 (no effect on a single-sample Sampler) | C [M-MISC, PYFLP, L-TPL] |
| Velocity preview | — | — | The vertical click position on a key sets the preview velocity | C |
| Multi-touch | toggle | — | Enlarges the keyboard | C |
| Sampler / DrumSynth / SimSynth buttons | — | — | Appear only when a DrumSynth or SimSynth preset fills the sample; pick which engine uses the root | C (out of scope) |

Pitch-bend range: in current FL this is the header **RANGE** control (§2), not a MISC control. **C** [M-MAIN]

---

## 7. Legacy FUNC tab

The user-facing "FUNC" tab of FL ≤ 11 corresponds to these MISC sections in FL 2026:
- **Time** (GATE, SHIFT, SWING; §6.3)
- **Echo delay / Fat mode** (§6.7)
- **Arpeggiator** (§6.6)

All defaults are listed in those sections. **C/I**: the content is C [M-MISC, M-AC]; the legacy split is I (PyFLP naming, a third-party FL 20 book, internal tab name in L-STR).

---

## 8. Raw-storage cheat sheet (FLP, FL 2026 empty Sampler)

[L-TPL decoded with PYFLP/DAWVERT layouts]

| Record | Fields = default |
|---|---|
| Levels | pan 6400 · vol 10000 · pitch 0 · modX 256 · modY 0 · filterType 0 (Fast LP) |
| LevelAdjusts | pan 0 · vol 12800 · modX 0 · modY 0 |
| Polyphony | max 0 · slide 820 · flags 0 (Mono = 1, Porta = 2) |
| Tracking (×2) | [Vel] mid 100 · [Key] mid 60 · pan/modX/modY 0 |
| EnvLFO (×5: Pan, Vol, ModX, ModY, Pitch) | env off · del 100 · att 20000 · hold 20000 · dec 30000 · sus 50 · rel 20000 · amt 0 · lfoDel 100 · lfoAtt 20000 · lfoAmt 0 · lfoSpd 32950 · shape 0 · tension 0/0/0 (Vol release −101). Flags: 1 = env tempo, 2 = LFO tempo, 32 = LFO global/retrigger. |
| Delay (echo) | feedback 0 · pan 6400 (centre) · pitch 0 · echoes 4 · time 144 · DelayModXY 128/128 · flags: ping-pong 2, fat 4 |
| Parameters | main_pitch 1 · arp dir 0 / range 1 / chord −1 / time 1024 / gate 48 / repeat 1 / slide 0 · full_porta 0 · add_to_key 0 · gate 1447 (off) · key 0…256 · normalize 0 · polarity 0 · declick 0 · crossfade 0 · trim 0 · stretch time 0 / pitch 0 / mul 0 (= ×1) / mode 0 · start 0.0 · length 1.0 · start offset 0.0 · formant 0.5 |
| Precomputed events | FreqTilt 128 · Pogo 256 · Cutoff 1024 · Resonance 0 · Preamp 0 · FadeIn 0 · FadeOut 0 · StereoDelay 2048 · RingMod (mix 0, freq 128) · FXFlags 0 (fade stereo 1, reverse 2, clip 4, swap 256) · Reverb 65536 |
| Swing / shift | SwingMix 128 · TimeShift 0 |
| Cut | CutGroup 0 (low/high 16-bit = cut / cut-by) |
| Keyboard | RootNote absent → 60 · FineTune absent → 0 |
| Routing | event 104 = 0 (Master) |

Scripting conversions [M-API, STUBS]:
- `channels.getChannelVolume`: 0…1; default 0.78125; `useDb` flag returns dB.
- Pan: −1…1.
- Pitch: factor of range, cents, or range.
- Step parameters: velocity default 100, release 64, fine pitch 0…240 (120 = 0 c), pan 0…128 (64 = centre).

---

## 9. Open questions and calibration checklist (U items)

1. Envelope time curve: seconds for DEL/ATT/HOLD/DEC/REL. Tension formula and the sign per segment.
2. LFO speed when not synced, in Hz; tempo-synced value table; LFO depth for pitch and volume; default of GLOBAL.
3. Mod X → cutoff Hz and Mod Y → Q for each filter type; exact Fast LP topology.
4. Looped sample with the volume envelope off: does note-off stop the voice or exit the loop?
5. Effective hold time of zero-length step notes when the envelope is on.
6. Release velocity: does the Sampler scale release time (for example by relVel/64)?
7. Levels-adjustment VOL curve (linear or the G law).
8. Exact pan taper between centre and edges (sin/cos or square root); triangular law formula.
9. Units for arp TIME and GATE (raw 1024 and 48); meaning of arp CHORD −1; timing in fat mode.
10. Display units for precomputed knobs (IN/OUT ms, BOOST dB, RM FREQ Hz, CUT Hz, STEREO DELAY ms).
11. Default of the Resample flag (bit 0 of SamplerFlags = 1 in the FL 2026 empty Sampler).
12. Maximum values of RANGE and MAX polyphony; numeric value of the Stretch pro mode.
13. Default render interpolation; processing order of precomputed effects.

Suggested method: with the local FL 2026 install, render test projects (one parameter swept per render) and fit the curves above. Every curve is isolated behind one function so it can be swapped later.
