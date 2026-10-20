# Fruity Parametric EQ 2 (PEQ2): behavior and DSP spec

Research notes for the FL-core web clone (TypeScript + Web Audio AudioWorklet + Canvas). Everything is paraphrased from the sources in section 9. This file holds no code: only parameter ranges, defaults, value mappings, layout, interactions and DSP behavior.

## How to read this document

Every statement carries a confidence tag.

| Tag | Meaning |
|---|---|
| **[C: KEY]** | Stated by the source with key `KEY` (URLs in section 9). Keys `MAN`, `MAN-DE`, `MAN-ZH`, `CHG`, `PRESET`, `THUMB`, `UI`, `FSPLIT`, `VID`, `F-B208` and `F-GOL` are official Image-Line material. All other keys are community sources (forums, KVR, PyFLP). |
| **[I]** | Inferred. It follows from confirmed facts, from data shipped with FL Studio, or from pixel measurement. The reasoning is given. Treat it as a design decision you can revisit. |
| **[U]** | Unknown, or sources conflict. A recommended clone behavior follows, marked **Rec:**. |
| **[L]** | Legacy. True only for an older FL version. |
| **[C: HOST]** | Measured on FL Studio 2026's own plugin (`Fruity Parametric EQ 2_x64.dylib`) with the command-line plugin host, October 2026. Laws, designs and residuals: `docs/research/fx/peq2.md`. |

**Version baseline.** Target behavior is the plugin as shipped in FL Studio 2024, 2025 and 2026 (internal versions 24.x to 26.x). The current English manual page was read in October 2026. Older behavior (FL 12, FL 20, FL 21) is noted where it differs (section 1.2).

**Method notes.**
- The manual has three revisions online at the same time: the current English page, an older English revision still served under the German manual path, and a Chinese translation of an even older English revision. Section 1.2 compares them. The Internet Archive was rate-limited or offline during this research, so no date-stamped snapshots of the PEQ2 page were read. The older revisions are dated by their content, cross-checked against the changelog.
- No images were downloaded. Screen geometry and colors come from the 234 × 117 px plugin thumbnail that ships with FL Studio 2026 (key `THUMB`), measured pixel by pixel. Treat positions as proportions and colors as approximate.
- Defaults come from decoding the factory default state file shipped with FL Studio (key `PRESET`), using the field layout published in PyFLP issue #159 (key `PYFLP`). Raw stored values are given so they can be re-checked.

---

## 0. Summary

- **7 fixed bands.** Each has Level (−18 to +18 dB, linear in dB), Frequency (20 Hz to 20 kHz, logarithmic), Bandwidth (BW knob 0–100 %, which equals 0.1 to 5.0 octaves, linear in octaves), Type (Off plus 7 shapes), Order (7 slope settings: Steep 8/6/4, "2", Gentle 4/6/8), and a Mute/Solo switch.
- **Global controls.** Main level (−18 … +18 dB, applied to the input [C: HOST]), LIN (linear phase, 6-step precision), HQ (modes HQ+, Legacy, Enhanced), View band tokens, Monitor (off / input / output), Compare (A/B spare bank), and an Options menu (band solo, phase line, analyzer settings).
- **Default state.** Band 1 low shelf, bands 2–6 peaking, band 7 high shelf, all at 0 dB. Center frequencies sit 1/3 decade apart: 63.2, 136, 294, 632, 1363, 2936 and 6324 Hz. BW is 2.0 octaves (Q = 2/3) on the peaking bands and 3.1 octaves on the shelves.
- **Graph.** X axis 20 Hz to 20 kHz, logarithmic. Y axis ±18 dB. Numbered, colored band tokens. Histogram and heatmap analyzer. Optional phase line (±180° drawn on the ±18 dB scale).
- **DSP.** Standard mode uses Robert Bristow-Johnson ("Audio EQ Cookbook") biquads, which are minimum-phase IIR filters. HQ Legacy and HQ Enhanced run them at 2× oversampling. HQ+ (FL 24 and later) uses "decramped" analog-matched IIR filters without oversampling. LIN applies FFT linear-phase filtering and adds latency.

---

## 1. History

### 1.1 Feature timeline

| FL version (date) | Change | Tag |
|---|---|---|
| 7.0 (2007-01-03) | PEQ2 introduced | [C: CHG] |
| 8.0 (2008-02-09) | New slope (order) modes for LP, HP, LS, Peak and HS bands | [C: CHG] |
| 9.0 (2009-09-10) | PEQ2 spectral display switched to "natural weighting" | [C: CHG] |
| 12.x (2015) | New spectrum algorithm. The pre-FL 12 one stays available as "Legacy monitor". | [C: MAN-ZH] |
| 12.3 beta 5 (2016-06-28) | Key (note) selection for band tokens | [C: CHG] |
| 12.3.1 (Sep 2016) | Vector (resizable) UI. Fix: band types and orders changed too quickly when dragged. | [C: CHG] |
| 20.8 (Nov–Dec 2020) | Linear-phase mode (LIN). "HQ2" option, which is probably the FIR "Enhanced" downsampler [I]. Band mute and solo switches. Band solo on Shift, with modes. Phase-shift line. Frequency histogram and heatmap. Mid/Side/L/R monitor source. Updated visuals, larger default window, values shown on hover, hints in popup menus. Adaptive solo keeps band BW while Shift is held. | [C: CHG, F-B208] |
| 20.8.1 (2021-01-21) | Context-aware type-in values (Hz, dB) for frequency and gain. Fix: inverted dB scale in the hint bar. Heatmap menu items reordered to match Maximus. | [C: CHG] |
| 20.8.2 (2021-02-25) | Note-snap values from the token popup added to the FREQ knob popup | [C: CHG] |
| 21.0 (Nov 2022) | Fix: moving band 7 level made clicks. Histogram fixes. | [C: CHG] |
| 21.0.2 (Jan 2023) | Changelog fixes a bug involving "Minimum phase mode speed" with LIN, so that option existed by then | [C: CHG] |
| 21.2.99 beta 1 = FL 24 beta (2024-02-28) | HQ+ ("decramped") filter mode | [C: CHG] |
| 24.2.99 beta 4 = FL 2025 beta (2025-04-26) | Subscripts on the HQ button for Legacy and Enhanced. UI scaling. Fix: Monitor parameter was not saved. | [C: CHG] |
| 25.1.3 (2025-09-11) | More changes undoable | [C: CHG] |
| 25.2.x (Dec 2025) | Patcher crash and scaling fixes | [C: CHG] |

### 1.2 Manual revisions compared (FL 20 vs FL 21 vs FL 2024–2026)

- **Rev A** = Chinese page `MAN-ZH`: a translation of the English text from before 20.8 (FL 12 to 20.7 era). Dated by content: it has no LIN, solo or histogram, and it mentions "Legacy monitor" (the pre-FL 12 algorithm).
- **Rev B** = the page under the German manual path, `MAN-DE`, still served in English: the FL 20.8 to 21.x text. It has LIN, solo and the histogram, but no HQ+.
- **Rev C** = current English page `MAN` (FL 24 to 2026).

| Topic | Rev A (FL 12–20.7) | Rev B (FL 20.8–21) | Rev C (FL 24–2026) |
|---|---|---|---|
| Intro | 7-band parametric EQ with spectrum analysis | Adds Standard (IIR) and Linear Phase (FFT) modes | Same as B |
| Controls under the faders | Only "Frequency / Bandwidth" knobs | Headphone icon (Band solo on Shift), Mute/Solo switches, FREQ, BW | Same as B |
| Options menu | Lock spare state, High precision monitor, Legacy monitor, About | Lock spare state, Band solo on shift (Bandpass/Adaptive, Inherit bandwidth), Linear phase mod speed, Phase rotation, Monitor input, Histogram, Range, Pivot slope, Frequency precision, Time smoothing, Average mode, Heatmap, High precision, Enhanced frequency, Heatmap position, About. "Legacy monitor" is gone. | Same as B, plus **Minimum phase mod speed** |
| LIN | None | Present. Right-click opens Precision. | Same as B |
| HQ | One toggle: oversampling improves quality above ~15 kHz, costs CPU, and resampling can raise inter-sample peaks | Standard mode: 2× oversampling. LIN mode: same analog-style curve without oversampling. Right-click: Legacy (polyphase, no latency) or Enhanced (FIR, 1 ms latency). | **HQ+** (decramped, no oversampling) added. Button subscript shows the mode. Legacy and Enhanced are kept for older projects. |
| Monitor | Spectrum on/off, or show the output | Three icons: off / input / output | Same as B |
| Credits | Didier Dambrin | Didier Dambrin, Daniel Schaack, Miroslav Krajcovic | Same as B |
| Same in all three | Band types and slope list (Steep 4/6/8, 2, Gentle 4/6/8). Token gestures (Shift, middle button or wheel = BW; Alt = reset; Ctrl = fine; click outside tokens = main level; right-click = Type/Order/Key). Compare, View band tokens, the CPU note, "stack two instances for 14 bands". | | |

Older wording:
- FL 12 manual (quoted 2015): slopes "Down = Steep 4, 6 & 8, Up = Gentle 2, 6 & 8". [L] [C: F-SLOPE]
- FL 7/8 era menus: slope names "gentle / steep 1, 2, 3, 4" rather than dB/oct. [L] [C: F-SLOPE07]

---

## 2. Parameter model

### 2.1 Per-band parameters (×7)

| Parameter | Range | Default | Unit / hint display | Mapping and notes | Tag |
|---|---|---|---|---|---|
| **Level** (band gain) | −18 … +18 dB | 0 dB on every band | dB. Hover and Type-in show dB since 20.8.1 ("context aware"); before that, percent only [C: F-FORM]. | Linear in dB. Normalized value x = 0.5 + dB/36. Stored as an integer in hundredths of a dB (−1800…1800). The vertical fader and vertical token drag edit the same value. For LP, BP, HP and Notch the fader is greyed out and the value is ignored. | ±18 dB: [C: MAN] (±18 dB fader labels), [C: F-FORM]. Stored ints: [C: PRESET]. Context-aware display: [C: CHG #10470]. Greyed fader: [C: MAN] |
| **Frequency** | 20 Hz … 20 kHz | Per band, see 3.1 | Hz / kHz on hover and in Type-in since 20.8.1 | Logarithmic: f = 20 · 1000^x Hz, and back, x = log10(f/20)/3. One decade is 1/3 of the travel. Knob center (x = 0.5) = 632.5 Hz. Stored as 0…65536 (= x · 65536). Range does not depend on sample rate [I]. | Range and 50 % = 632 Hz: [C: F-FREQ]. Formula: [C: F-FORM]. Factory presets decode to sensible values under it (see the Appendix): [I] from [C: PRESET]. |
| **Bandwidth (BW)** | 0 … 100 %, i.e. 0.1 … 5.0 octaves | Peaking: 38.8 % = 2.0 oct. Shelves: 61.2 % = 3.1 oct. | Percent; 0 % = narrowest, 100 % = widest | Linear in octaves: BW = 0.1 + 4.9 · x. The analog-equivalent Q is 1 / (2 · sinh(ln 2 · BW / 2)): Q = 14.4 at 0 %, 0.18 at 100 %, 2/3 at 2.0 oct, 0.707 at 1.9 oct (x = 36.7 %). Stored as 0…65536. Confirmed for peaking bands [C: HOST]; the other types read the knob differently (4.4) [C: HOST]. | Formula: [C: F-FORM]. Check: the shipped default 25412/65536 decodes to exactly 2.000 oct [C: PRESET]. Percent display and direction: [C: KVR10] |
| **Type** | Off, Low pass, Band pass, High pass, Notch, Low shelf, Peaking, High shelf | Band 1 LS, bands 2–6 Peaking, band 7 HS | Name (selector icon, popup menu) | Enum 0–7 in that order, which is also the order the selector cycles through. Off = band bypassed. | Order: [C: MAN]. Enum: [C: PYFLP], consistent with presets [C: PRESET] |
| **Order** (slope) | Steep 8, Steep 6, Steep 4, 2, Gentle 4, Gentle 6, Gentle 8 | "2" (−12 dB/oct) | Name, menu shows dB/oct (12–48) | Enum −3…+3, 0 = "2". Negative = Steep (selector dots dragged down), positive = Gentle (dragged up). | List: [C: MAN]. Range −3…3: [C: PYFLP]. Sign confirmed [C: HOST]: FL's value texts are −3 "Steep 8", −2 "Steep 6", −1 "Steep 4", 0 "2", +1 "Gentle 4", +2 "Gentle 6", +3 "Gentle 8". |
| **Enabled** (Mute switch) | on / off | on | Switch lit in band color when on [I] | One bit per band in the saved state. Default bitmask 0x7F (all on). | Switch: [C: MAN]. Bitfield: [C: PYFLP], which calls it "muted bands" even though the default is all ones. Confirmed [C: HOST]: bit k set = band k+1 enabled (0x77 removes band 4); higher bits are ignored. |
| **Solo** (latched) | on / off | off | — | Right-click or Ctrl+click on the band's Mute switch. What "solo" does to audio is [U] (UI state; the host cannot set it). **Rec:** only soloed bands stay active; the rest are bypassed. No solo field exists in the saved state [C: HOST] (mask bits above band 7 have no effect). | [C: MAN] |

### 2.2 Global parameters

| Parameter | Range | Default | Display | Notes | Tag |
|---|---|---|---|---|---|
| **Main level** | −18 … +18 dB [C: HOST] (parameter 35, −1800…1800, same value text as the band levels) | 0 dB | dB | Gain 10^(dB/20), applied to the input before the bands, moved per processing block by at most 44.1/s in linear gain (22.05/s while HQ Legacy/Enhanced is selected, also in LIN) [C: HOST]. Set with its own fader (left of the band faders) or by left-dragging empty graph area. Stored as a signed int in 0.01 dB. | Exists: [C: MAN]. +18 dB: [C: F-MAIN26]. Default: [C: PRESET]. Law and range: [C: HOST] |
| **LIN** | off / on | off | Button | All bands switch to FFT linear-phase processing, with latency. Not one of the plugin's 36 automatable parameters (7 × level, frequency, width, type, order, plus main level) [C: HOST]; it lives in the state. The changelog fixes "linear phase mode is not updated when automated". | [C: MAN, CHG #10069]. Default [I] from [C: PRESET] |
| **LIN precision** | Lowest, Low, Medium, High, Higher, Highest | Medium (stored 2) | Right-click LIN | Higher precision allows steeper slopes and adds latency: a K = 256·2^p tap kernel, latency 1.5 K = 384, 768, 1536, 3072, 6144, 12288 samples at any sample rate [C: HOST] | Concept: [C: MAN]. Choices: [C: PYFLP]. Default [I] |
| **HQ** (on/off) | off / on | on [C: HOST] (see 3.2) | Button | Left-click toggles [I] | [C: MAN] |
| **HQ mode** | HQ+ (decramped), HQ L (Legacy), HQ E (Enhanced) | HQ+ [C: HOST] (see 3.2) | Subscript letter on the HQ button | Chosen by right-click on HQ. State: the `HQ` int holds bit 0 = on, bit 1 = HQ+; without HQ+, bit 1 of the flags byte picks Enhanced (set) or Legacy [C: HOST] | [C: MAN, CHG #18098] |
| **View band tokens** | on / off | on | Check-mark button | Hides or shows the graph tokens | [C: MAN]. Default [I] from [C: PRESET] |
| **Monitor** | off / input / output | output (stored 2) [I] | Three icons | Analyzer source: none, pre-EQ, or post-EQ signal | [C: MAN]. Default [I] |
| **Compare** | main ↔ spare bank | Spare bank = copy of main | Two arrow buttons | The spare bank is saved with the plugin state (and so with presets) | [C: MAN, PRESET] |

### 2.3 Options-menu settings (current order as listed in MAN)

| Item | Choices | Default (stored value) | What it does | Tag |
|---|---|---|---|---|
| Lock spare state | toggle | off [I] | Stops the compare bank from being overwritten | [C: MAN] |
| Band solo on shift | toggle (also the headphone icon) | off (bit = 0) | Shift+click on a token solos that band while held | [C: MAN]. Default [I] |
| ↳ Solo mode | Bandpass / Adaptive | stored 0, read as "Adaptive" under PyFLP's ordering [U] | See 6.6 | [C: MAN, PYFLP] |
| ↳ Inherit bandwidth | toggle | off | BW changed during solo is written back to the band when Shift is released | [C: MAN] |
| Minimum phase mod speed | Off / Medium / Smooth | Off (0) | Slew limit for IIR parameter changes, against crackles from fast frequency moves (HQ modes) | [C: MAN, PYFLP] |
| Linear phase mod speed | Normal / Fast / Faster / Ultra | Normal (0) | Maximum parameter slew in LIN mode; faster settings use more CPU | [C: MAN] |
| Phase rotation | toggle | off (bit = 0) | Draws the IIR phase response line | [C: MAN]. Default [I] |
| Monitor input | Mid / Side / Left / Right | stored 1; the mapping from stored value to menu item is [U]. **Rec:** default Mid. | Analyzer source channel. Mid = (L + R)/2, Side = L − R. Display only; it does not change what the bands process. | [C: MAN] |
| Histogram enabled | toggle | on (bit = 1) | Line spectrum behind the curve | [C: MAN]. Default [I] |
| Range | −60 / −90 / −120 dB | stored 2, which is −120 dB if the enum follows menu order [U] | Analyzer floor | [C: MAN] |
| Pivot slope | 0 / 1.5 / 3 / 4.5 / 6 dB/oct | **4.5 dB/oct** (stored 3) | Visual tilt of the analyzer around 1 kHz | Default stated by [C: MAN]. Stored index 3 = 4.5 confirms PyFLP's enum order. |
| Frequency precision | Low / Medium / High / Highest | Medium (1) | Analyzer frequency resolution. More resolution adds display delay but no audio latency. | [C: MAN, PYFLP] |
| Time smoothing | Fastest / Fast / Medium / Slow / Slowest | Medium (2) | Peak fall time (Average off) or averaging window (Average on) | [C: MAN, PYFLP] |
| Average mode (RMS) | toggle | off | Averaged level instead of instantaneous peaks | [C: MAN] |
| Heatmap enabled | toggle | off | Intensity strip of vertical lines | [C: MAN] |
| High precision (heatmap) | toggle | stored 0 [U] | Sharper vertical lines. Off = an alternative algorithm that blurs the lowest bands but makes their centers easier to spot. | [C: MAN] |
| Enhanced frequency | toggle | off (stored inverted flag = 1) | Thinner frequency lines | [C: MAN, PYFLP] |
| Heatmap position | Top / Bottom / Full | Full (2) | Heatmap placement when shown together with the histogram | [C: MAN, PYFLP] |
| About | — | — | Version and credits | [C: MAN] |

### 2.4 Value mappings

With x = the normalized control value 0…1 (FL "Type in value" decimal; internal stored value = x · 65536 for frequency and BW):

- **Level:** dB = 36·x − 18. [C: F-FORM]
- **Frequency:** f = 20 · 10^(3x) Hz. [C: F-FORM, F-FREQ] Reference points: 100 Hz ↔ 0.2330, 200 Hz ↔ 1/3, 1 kHz ↔ 0.5663, 2 kHz ↔ 2/3, 5 kHz ↔ 0.7993, 10 kHz ↔ 0.8997. [C: F-FORM]
- **Bandwidth:** octaves = 0.1 + 4.9·x. Q from octaves: Q = 1 / (2·sinh(ln 2 · oct / 2)). Octaves from Q: oct = (2 / ln 2) · asinh(1 / (2Q)). [C: F-FORM] The author notes the conversion does not hold for HP/LP bands. [C: F-FORM] Per type [C: HOST]: peaking uses the octaves directly (RBJ bandwidth form, pre-warped); band pass oct·10^(−3/20) and notch oct·10^(3/20) in the same form; LP/HP Q = (0.1 + 9.9·(1 − x)³)/√2; shelves the RBJ slope S = (117 − 98x)/57.
- **Main level:** dB = 36·x − 18 (raw −1800…1800 in 0.01 dB), gain 10^(dB/20). [C: HOST]
- **Type enum:** 0 Off, 1 LP, 2 BP, 3 HP, 4 Notch, 5 LS, 6 Peak, 7 HS. [C: PYFLP, MAN]
- **Order enum:** −3 Steep 8, −2 Steep 6, −1 Steep 4, 0 "2", +1 Gentle 4, +2 Gentle 6, +3 Gentle 8. Range [C: PYFLP]; sign [I].

### 2.5 Saved state (FL's own format; needed only if the clone imports FL `.fst` presets)

Plugin data block, little-endian [C: PYFLP], checked against the factory files [C: PRESET]:

1. `u32` data version (6 in FL 20.8 files, 8 in FL 24+ files).
2. Main bank: 7 × `i32` level (0.01 dB), 7 × `u32` frequency (0…65536), 7 × `u32` BW (0…65536), 7 × `u32` type (0–7), 7 × `i32` order (−3…3), 1 × `i32` main level.
3. Spare (compare) bank: the same 36 values again.
4. Options tail: `i32` HQ, `i32` heatmap high precision, `u8` view band tokens, `i32` monitor mode (0 off, 1 input, 2 output), `i32` "not enhanced frequency" flag, `i32` LIN precision (0–5), `i32` LIN mod speed (0–3), `u8` bitfield (bit 0 LIN, 1 Enhanced HQ, 2 phase rotation, 3 band solo on shift, 4 inherit bandwidth, 5 heatmap, 6 histogram, 7 average), `u32` band bitmask (bits 0–6 = bands 1–7), `i32` monitor input, `i32` solo mode, `i32` pivot index (0, 1.5, 3, 4.5, 6), `i32` frequency precision, `i32` time smoothing, `i32` histogram range, `i32` heatmap position. Version 8 adds `i32` minimum phase mod speed (0 Off, 1 Medium, 2 Smooth).

The plugin wrapper block of the default file stores a window rectangle ending in 700 × 350, so the default editor size is about 700 × 350 px [I].

---

## 3. Default state

### 3.1 Bands

Band k sits at normalized frequency x = (2k + 1)/18, so f = 20 · 10^((2k + 1)/6) Hz. Adjacent bands are a factor 10^(1/3) ≈ 2.154 apart (about 1.1 octaves). Band 1 and band 7 are exactly two decades apart. [I] from [C: PRESET] plus the frequency formula.

| Band | Color (approx.) | Type | Order | Frequency (stored → Hz) | Level | BW (stored → %, octaves, Q) |
|---|---|---|---|---|---|---|
| 1 | violet `#B17DEC` | Low shelf | 2 | 10923 → **63.2 Hz** | 0 dB | 40124 → 61.2 %, 3.1 oct (Q 0.387 if read as peaking) |
| 2 | pink `#EC7DCD` | Peaking | 2 | 18204 → **136 Hz** | 0 dB | 25412 → 38.8 %, 2.0 oct, Q 0.667 |
| 3 | salmon `#EC917E` | Peaking | 2 | 25486 → **294 Hz** | 0 dB | 2.0 oct |
| 4 | yellow `#EBED7E` | Peaking | 2 | 32768 → **632 Hz** | 0 dB | 2.0 oct |
| 5 | green `#89EC7E` | Peaking | 2 | 40050 → **1.36 kHz** | 0 dB | 2.0 oct |
| 6 | aqua `#7CECD5` | Peaking | 2 | 47332 → **2.94 kHz** | 0 dB | 2.0 oct |
| 7 | blue `#7CABED` | High shelf | 2 | 54613 → **6.32 kHz** | 0 dB | 61.2 %, 3.1 oct |

Values: [C: PRESET]. Hz conversion: [I] via [C: F-FORM]. Colors: [I] sampled from [C: THUMB].

The shelf default (61.2 %) is exactly 100 % minus the peaking default (38.8 %). That hints shelves may read the BW knob in a mirrored way (see 4.4). [I]

### 3.2 Global defaults (FL 24–2026 factory default)

| Setting | Default | Tag |
|---|---|---|
| Main level | 0 dB | [C: PRESET] |
| Spare bank | Identical copy of the main bank | [C: PRESET] |
| All bands enabled | yes (0x7F) | [I] from [C: PRESET] |
| HQ | Stored value 3 = HQ on + HQ+ [C: HOST]: with it a band is a single decramped biquad with no latency (stored 1 = 2× oversampling, Legacy or Enhanced by the flags byte; 0 and 2 = off). The plugin constructor and `Default.fst` agree. Forum posts claiming HQ E as the default refer to older versions or projects. | [C: PRESET], [C: HOST] |
| LIN | off, precision Medium, LIN mod speed Normal | [I] from [C: PRESET] |
| Minimum phase mod speed | Off | [I] from [C: PRESET] |
| View band tokens | on | [I] from [C: PRESET] |
| Monitor | Output | [I] from [C: PRESET] |
| Band solo on shift / Inherit bandwidth / Phase rotation | off / off / off | [I] from [C: PRESET] |
| Histogram / Heatmap / Average | on / off / off | [I] from [C: PRESET] |
| Pivot slope | 4.5 dB/oct | [C: MAN, PRESET] |
| Frequency precision / Time smoothing / Heatmap position | Medium / Medium / Full | [I] from [C: PRESET, PYFLP] |
| Range | stored 2 (−120 dB if menu order) | [U] |
| Editor size | about 700 × 350 px at 100 % scaling. 20.8 increased the default size. | [I] from [C: PRESET]; [C: CHG #10056] |

Older defaults [L]: before 20.8, a fresh PEQ2 seems to have had HQ (oversampling) on. In 2019, a user found a flat default instance raised measured level; the answer was "HQ will add gain, turn it off". [C: F-HQ19] An Image-Line developer explained an earlier peak-meter rise with flat settings as "peak <> volume". [C: F-GOL]

---

## 4. Band types and slopes

### 4.1 Types

| Selector order / enum | Name in selector (MAN) | Name in token popup (MAN) | Uses Level? | Notes |
|---|---|---|---|---|
| 0 | Off | (not listed) | — | Band bypassed, costs no CPU. Its token is not drawn [I]. To re-enable it you change its type again. [C: F-REEN] |
| 1 | Low pass | Low Pass | No (fader disabled) | Cuts highs above the cutoff |
| 2 | Band pass | Band Pass | No | Passes a band around the center |
| 3 | High pass | High Pass | No | Cuts lows below the cutoff |
| 4 | Notch | "Band Cut" (called "Band stop" in the solo table) | No | Rejects a band around the center |
| 5 | Low shelf | Low Shelf | Yes | Bass-shelf style |
| 6 | Peaking | Peaking | Yes | Bell. Called "the default" type in MAN. |
| 7 | High shelf | High Shelf | Yes | Treble-shelf style |

All rows: [C: MAN]. Enum: [C: PYFLP]. Whether the token popup can set Off is [U]. **Rec:** keep Off out of the token popup and reachable from the selector, as MAN's lists suggest.

### 4.2 Slopes (Order)

| Enum | Label | Nominal slope | Level at the cutoff | Selector gesture | Tag |
|---|---|---|---|---|---|
| −3 | Steep 8 | −48 dB/oct | ≈ −3.1 dB [C: HOST] | Dots dragged fully down | [C: MAN], sign [C: HOST] |
| −2 | Steep 6 | −36 dB/oct | ≈ −3.1 dB [C: HOST] | down | [C: MAN] |
| −1 | Steep 4 | −24 dB/oct | ≈ −2.6 dB [C: HOST] | down | [C: MAN] |
| 0 | 2 | −12 dB/oct | (one 2nd-order section) | center | [C: MAN] |
| +1 | Gentle 4 | −24 dB/oct | ≈ −6 dB | up | [C: MAN] |
| +2 | Gentle 6 | −36 dB/oct | −9 dB [C: HOST] | up | [C: MAN] (slope), [C: HOST] (−9 dB) |
| +3 | Gentle 8 | −48 dB/oct | ≈ −12 dB | fully up | [C: MAN] |

Order modes exist for LP, HP, LS, Peak and HS (FL 8 changelog). [C: CHG] BP and Notch accept orders too [C: HOST]: n = 1 + |order| identical sections, Steep and Gentle identical, the band pass BW multiplied by √n and the notch BW divided by √n. (Cutoff levels above: at the neutral LP/HP resonance, Q = 0.7071.)

### 4.3 Steep vs Gentle

What MAN says: both kinds reach the same final slope. Gentle filters bend into the slope earlier and attenuate more before the cutoff: about −6 dB at the cutoff for Gentle 4, up to −12 dB for Gentle 8. Steep filters stay near −3 dB at the cutoff. [C: MAN]

How they are built for LP/HP [C: HOST] (Q = the order-2 resonance from the BW knob, n = N/2 sections, all at the cutoff):
- **Steep N**: section Qs c_i·Q^(1/n), with c = (0.630012, 1.667835) for N = 4, (0.551023, 0.858402, 2.097782) for N = 6 and (0.505166, 0.805575, 0.880403, 2.757819) for N = 8. Not a Butterworth set: at Q = 0.7071 Steep 4 is 0.5298 / 1.4025.
- **Gentle N**: n identical sections of Q_g = 2^(−(n−1)/(2n))·Q^(1/n): at Q = 0.7071 that is n Butterworth sections (−6 / −9 / −12 dB at fc; Gentle 4 = Linkwitz-Riley 4).

For peaking and shelf bands [C: HOST]: Gentle N = n identical sections with gain G/n (same BW, same shelf slope). Steep shelves: gain G/n and slopes S·d_i with d = (0.615645, 2.630447), (0.509868, 1.109270, 5.161229), (0.552999, 0.694030, 1.514437, 10.319122). Steep peaking bands are staggered sections: Steep 4 at f·2^(±BW/8), width BW/2, gain (0.6625 − 0.01·BW)·G; Steep 6 at f·2^(±19·BW/120) (width BW/3) and f (width π·BW/6), gain 0.4884·G; Steep 8 at f·2^(±3·BW/40) (width π·BW/8) and f·2^(±31·BW/160) (width BW/4), gain 0.42889·G. The rest of this paragraph is the earlier research: A forum user in 2019 found a Steep and a Gentle setting nulled each other perfectly in one test, so for some types the two may be identical. [C: F-GS19] Asked in 2007 to label slopes in dB/oct, an Image-Line developer replied that this "wouldn't apply" to most of the filters; the rest of the reply is cut off. [C: F-SLOPE07] **Rec (shelves):** Gentle N = N/2 identical shelf biquads, each with gain G/(N/2). Steep N = a higher-order Butterworth-style shelf, e.g. the Holters & Zölzer 2006 parametric high-order shelving design. **Rec (peaking):** the same idea, with the gain split across sections and the section Q chosen to keep the band's half-gain bandwidth. Confirm by measurement before committing.

### 4.4 What each type does with Level, BW and Order

| Type | Level | BW meaning | Order | Token height |
|---|---|---|---|---|
| Off | — | — | — | Not drawn [I] |
| Low pass / High pass | Ignored; fader greyed [C: MAN] | Resonance: Q = (0.1 + 9.9·(1 − x)³)/√2, 7.07 at 0 %, 1.68 at the 39 % default, 0.07 at 100 % [C: HOST] | Yes [C: CHG] | 0 dB line [I] (weak evidence from THUMB) |
| Band pass | Ignored [C: MAN] | RBJ bandwidth form with (0.1 + 4.9x)·10^(−3/20) octaves [C: HOST] | Yes, BW·√n [C: HOST] | 0 dB line [I] |
| Notch | Ignored [C: MAN] | RBJ bandwidth form with (0.1 + 4.9x)·10^(3/20) octaves [C: HOST] | Yes, BW/√n [C: HOST] | 0 dB line [I] |
| Peaking | Used [C: MAN] | Octaves between the half-gain (dB/2) points, RBJ definition [I]. Verified 0.1–5 oct scale. [C: F-FORM] | Yes [C: CHG] | At (f, level) [C: MAN] |
| Low / High shelf | Used [C: MAN] | RBJ slope S = (117 − 98x)/57: 2.05 at 0 %, 1.0 at the 61 % default, 1/3 at 100 % [C: HOST] | Yes [C: CHG] | At (f, level) [C: MAN] |

Shelf BW hypotheses (settled [C: HOST]: neither; the knob is the RBJ shelf slope S above, so the 61 % default is S = 1 and 0 % overshoots by up to ~1.5 dB):
- **H1, same scale as peaking.** BW 0.1–5 oct is converted to Q with the analog formula. Narrower BW gives a steeper shelf with overshoot. The default 3.1 oct gives Q 0.387, a gentle shelf (RBJ S ≈ 0.3).
- **H2, mirrored scale.** Shelves use 1 − x. The default 61.2 % then becomes 2.0 oct, Q 0.667, which is close to the classic RBJ S = 1 shelf. This would explain why the shelf default mirrors the peaking default.
- Factory presets cannot settle it. "Radio" sets both shelves to BW 0 %: under H1 that gives a resonant ±12–17 dB ripple around the corner, under H2 a broad tilt. [I] from [C: PRESET]
- **Rec:** implement H1 (one consistent knob meaning: narrower = steeper) behind a switch, and settle it by measurement (section 8).

---

## 5. Display

### 5.1 Window and layout

- The editor can be resized by dragging the window. [C: MAN] Default size is about 700 × 350 px (2:1). [I] from [C: PRESET] and the 2:1 thumbnail. FL 2025 added UI scaling. [C: CHG #17530]
- Proportions measured on THUMB [I]:
  - Graph: left ≈ 73 % of width, top ≈ 82 % of height.
  - Band panel: right ≈ 27 % of width.
  - Bottom bar: ≈ 18 % of height, full width.
- History [L]: the bitmap UI before FL 12.3 had a graph of about 400 × 180 px with a "red bars" spectrum. [C: F-DISP10] The vector UI arrived in 12.3.1 and was restyled in 20.8 (inner border removed, new visualization). [C: CHG #9776, #9849]

### 5.2 Graph axes, grid and rulers

| Element | Spec | Tag |
|---|---|---|
| X axis | Logarithmic. 20 Hz at the left edge, 20 kHz at the right edge. Same mapping as the FREQ knob, so a token's x position equals its knob position. | [I] from THUMB geometry and [C: F-FORM]. MAN says the analyzer covers 20 Hz–20 kHz. [C: MAN] |
| Bottom ruler | A row of label cells with borders at 50, 100, 200, 500, 1k, 2k, 5k and 10 kHz. The first cell starts at 20 Hz and the last ends at 20 kHz: a 1-2-5 pattern whose cell widths match log spacing to within 1 px. | [I] from [C: THUMB] |
| Bottom-ruler text | [U]. **Rec:** "20, 50, 100, 200, 500, 1k, 2k, 5k, 10k, 20k" | |
| Vertical grid | Log grid with lines at 1…9 × each decade: 20, 30 … 90, 100, 200 … 900, 1k … 9k, 10k, 20k Hz. | [I] from [C: THUMB] |
| Top ruler, row 1 | Octave cells, each starting at a C: 32.7, 65.4, 130.8 … 16 744 Hz, plus a clipped C0 cell at the left edge. Measured cell starts match the C frequencies to within 1 px. Whether the labels follow FL's note naming (MIDI 60 = "C5" = 261.6 Hz) or scientific naming (261.6 Hz = "C4") is [U]. **Rec:** use FL naming, consistent with the rest of the clone. | [I] from [C: THUMB] |
| Top ruler, row 2 | Named frequency-range cells, 8 of them. Borders at about 40, 80, 250, 500, 2k, 4k and 6k Hz. The text cannot be read at thumbnail resolution [U]. **Rec:** sub / low bass / bass / low mids / mids / high mids / presence / brilliance (air). The official video has a chapter called "Frequency display scaling and annotations". | Borders [I] from THUMB. Annotations exist: [C: VID] (chapter title only) |
| Y axis (EQ curve) | ±18 dB. Labels on the right edge every 6 dB: +18, +12, +6, 0, −6, −12, −18. | ±18 dB labels on the right: [C: MAN]. 6 dB spacing: [I] from THUMB |
| Horizontal grid | Present. Spacing [U]: THUMB suggests about 4 dB. **Rec:** major lines at the 6 dB labels, faint minor lines at 3 dB. | [I] |
| Phase scale | The phase line reuses the dB scale: +18 dB = +180°, −18 dB = −180°, 0 dB = 0° (no rotation) | [C: MAN] |
| Analyzer scale | Independent of the EQ dB scale. The floor is set by Range (−60/−90/−120 dB) and the picture is tilted by Pivot slope around 1 kHz. | [C: MAN] |

### 5.3 Response curve, band curves and phase line

- **Composite curve:** one light, near-white line for the total response of all bands. Below it, a faint lighter tint fills the area down to the bottom of the graph. [I] from THUMB. The line was thickened at 100 % scaling in FL 2025. [C: CHG #18010]
- **Per-band curves** in band colors exist; the 2024 changelog fixes band line colors that did not match band colors. [C: CHG #17590] When they are drawn (always, on hover, while dragging) is [U]. **Rec:** draw the hovered or dragged band's own response in its color over the composite curve.
- **Phase line** (Options > Phase rotation): the IIR phase response on the scale above. It wraps from one edge to the other for steep filters, and is flat in LIN mode. [C: MAN] The line's color is [U].
- **Main level and the curve:** whether Main level shifts the drawn curve is [U]. **Rec:** include it, so the curve shows the true output gain.
- **Curve accuracy:** whether the curve shows the real digital response (with cramping near Nyquist when HQ is off) or the analog ideal is [U]. **Rec:** draw the real response of the active mode.

### 5.4 Tokens

- Circles marked with the band number 1–7: a band-colored rim and number on a dark fill. [I] from THUMB
- Position: (frequency, level) for peaking and shelf bands. LP, BP, HP and Notch tokens sit on the 0 dB line. [I] (weak evidence from THUMB) Off bands are not drawn. [I] from [C: F-REEN] and the "3 bands" factory preset.
- "View band tokens" off hides all tokens. [C: MAN] The changelog fixes "band selection is wrong", which implies a hover/selected state. **Rec:** enlarge or brighten the hovered token. [I] from [C: CHG]
- Tokens can overlap; no rule for overlap order was found. [U] **Rec:** draw higher band numbers on top, and pick the topmost token on click.

### 5.5 Analyzer

| Element | Behavior | Tag |
|---|---|---|
| Monitor switch | Off / Input (pre-EQ) / Output (post-EQ) | [C: MAN] |
| Monitor input | Mid = (L + R)/2, Side = L − R, Left, Right. Changes only the display. | [C: MAN] |
| Histogram | Line spectrum, a "series of peaks", from 20 Hz to 20 kHz, drawn behind the EQ curve | [C: MAN] |
| Range | Lowest level shown: −60, −90 or −120 dB | [C: MAN] |
| Pivot slope | Tilts the spectrum around 1 kHz by 0 / 1.5 / 3 / 4.5 / 6 dB per octave (lows drawn lower, highs higher). Default 4.5 makes an evenly loud mix look roughly flat; 6 shows a saw wave flat; 0 shows white noise flat. | [C: MAN]. Formula [I]: displayed dB = measured dB + slope · log2(f / 1000 Hz) |
| Frequency precision | Number of analysis bands (FFT resolution), Low…Highest. More bands add display delay but no audio latency. | [C: MAN, PYFLP] |
| Time smoothing + Average mode | Average off: smoothing sets how slowly peaks fall. Average on (RMS): smoothing sets the averaging window. | [C: MAN] |
| Heatmap | Each frequency's level shown as the brightness of a vertical line, a "top-down" view of the histogram. Placed at the Top, Bottom or Full height of the graph. High precision = sharper lines. Enhanced frequency = thinner lines. | [C: MAN] |
| Combined view | Histogram and heatmap can be shown at once | [C: MAN] |
| Legacy look | [L] Before 20.8: a background "spectrograph" of vertical red/orange bars. [C: F-DISP10, MAN-ZH] The shipped `Spectrum.bmp` holds a 512-step palette from black through dark purple and crimson to red and orange (stops: 0 `#000000`, 256 `#0F0110`, 320 `#250319`, 352 `#400318`, 384 `#5F0313`, 416 `#7B0810`, 448 `#911A10`, 480 `#A63611`, 511 `#BA5213`). It is probably that legacy palette [I]. Modern histogram and heatmap colors are [U]. | |
| Weighting | Since FL 9, the spectral display uses "natural weighting" | [C: CHG] |

### 5.6 Right-hand panel

Per band strip, top to bottom [C: MAN] (elements), [I] from THUMB (arrangement):
1. **Type/slope selector:** a tile in the band color showing the shape icon, with slope dots under the shape.
2. **Vertical Level fader**, greyed when the type has no gain.
3. **Mute/Solo switch:** a small bar in the band color.
4. **FREQ knob:** an arc indicator in the band color.
5. **BW knob:** an arc indicator in the band color.

A label column at the left holds the headphone icon (Band solo on Shift) on the switch row and the "FREQ" and "BW" captions. The **Main level fader** sits at the left of the band faders, same height, without a color tile.

### 5.7 Bottom bar (left to right)

"PARAMETRIC EQ 2" logo (EQ with subscript 2), Options menu button, **LIN**, **HQ** (with mode subscript), **View band tokens** (✔), **Monitor** (three icons: – off, | input, O output, captioned MONITOR), **Compare** (down-arrow "store" plus up/down "swap", captioned COMPARE).

Order: [C: MAN] ("from left to right"). Captions and icons: [I] from THUMB.

### 5.8 Colors (approximate, sampled from THUMB)

| Item | Color |
|---|---|
| Band 1 … 7 | `#B17DEC`, `#EC7DCD`, `#EC917E`, `#EBED7E`, `#89EC7E`, `#7CECD5`, `#7CABED` (violet, pink, salmon, yellow, green, aqua, blue) |
| Graph background | `#142028` to `#1B2B35` (slight gradient) |
| Grid lines | about `#263640` |
| Ruler cells | about `#2F3F4A` |
| Composite curve | near white. The fill under the curve is about 10 levels lighter than the background. |

All colors [I]. Re-sample them from a 100 % scale screenshot before final art.

---

## 6. Interaction

### 6.1 Band tokens (graph)

| Gesture | Action | Tag |
|---|---|---|
| Left-drag | Horizontal = frequency. Vertical = level, on types that use level. | Dragging tokens: [C: MAN]. Axis assignment: [C: FLSP], [I] |
| Shift + left-drag left/right | Bandwidth (when "Band solo on shift" is off) | [C: MAN] |
| Middle-button drag left/right | Bandwidth | [C: MAN] |
| Mouse wheel over a token | Bandwidth. Direction [U]. **Rec:** wheel up = wider (higher BW %). | [C: MAN] |
| Ctrl + drag | Fine adjustment (same as all FL knobs and sliders) | [C: MAN] |
| Alt + click | Reset the band. Which fields reset is [U]. **Rec:** level, frequency and BW go back to that band's defaults; keep type and order. | [C: MAN] |
| Right-click | Popup with Type ▸, Order ▸, Key ▸ (see 6.8) | [C: MAN] |
| Shift + click (with "Band solo on shift" on) | Solo the band while held; vertical mouse movement changes the solo bandwidth (see 6.6) | [C: MAN] |
| Hover | Values shown since 20.8 | [C: CHG #10009] |
| While dragging | A floating hint near the token; its position was improved in 20.8 | [C: CHG #9781] |
| Axis-lock modifier, double-click | None documented [U]. **Rec:** none. | |

A 2018 fix stopped tokens from shifting horizontally on mouse-down. **Rec:** a click without movement must not change values. [C: CHG]

### 6.2 Empty graph area

- Left-drag anywhere outside the tokens adjusts Main level; the cursor changes from pointer to crosshair. [C: MAN] Drag direction is vertical [I].
- Hovering shows a cursor readout. The 20.8.1 fix for an "inverted dB scale in hint bar" implies the hint shows frequency and dB at the mouse. [I] from [C: CHG #10645]
- Mouse wheel over empty area: [U]. **Rec:** no action.

### 6.3 Type and slope selectors (top of each strip)

- Left-drag up/down on the shape cycles: Off, Low pass, Band pass, High pass, Notch, Low shelf, Peaking, High shelf. [C: MAN] Drag sensitivity was lowered in 12.3.1. [C: CHG] Which drag direction moves forward in the list is [U]. **Rec:** up = next item, matching FL value-up convention.
- Left-drag up/down on the dots sets the slope: down gives Steep 4/6/8, center gives "2", up gives Gentle 4/6/8. [C: MAN] **Rec:** draw dots below the shape for Steep and above for Gentle, with the dot count showing the order.

### 6.4 Faders and knobs (Level, Main level, FREQ, BW)

These follow FL's standard control behavior. [C: UI]
- Left-drag (vertical) changes the value.
- Ctrl + drag, or holding both mouse buttons, gives fine control.
- Shift avoids the pause ("snap") at default and other useful points.
- Alt + left-click or a middle-click resets to the default.
- Right-click opens the control menu (Type in value, Set, automation and controller links).
- Values show as %, 0–1, or context-aware units.

PEQ2 specifics:
- FREQ and Level use context-aware type-in in Hz and dB (20.8.1). [C: CHG #10470]
- The FREQ knob popup includes the note-snap values (20.8.2). [C: CHG #10683]
- Level faders are disabled for LP, BP, HP and Notch. [C: MAN]
- Mouse wheel over a knob or fader steps the value. [I] (FL convention)

### 6.5 Mute/Solo switch (one per band)

- Left-click toggles band disable (mute). [C: MAN]
- Right-click, or Ctrl + click, toggles solo. [C: MAN] Solo semantics are [U] (see 2.1).
- A forum reply suggests using these switches to turn bands off and on, rather than changing the type. [C: F-REEN]

### 6.6 Band solo on Shift

- Toggled by the headphone icon or the Options menu. Right-clicking the headphone icon chooses the mode. [C: MAN]
- While Shift is held on a token, that band is auditioned in isolation. Moving the mouse vertically changes the audition bandwidth. [C: MAN]
- **Bandpass mode:** a Steep 8 band-pass around the token's frequency. [C: MAN]
- **Adaptive mode:** the audition filter depends on the band type. [C: MAN]

| Band type | Audition filter | You hear |
|---|---|---|
| Low pass | High pass | what is removed |
| Band pass | Band pass | what is selected |
| High pass | Low pass | what is removed |
| Notch (band stop) | Band pass | what is removed |
| Low shelf | Low pass | the region being adjusted |
| Peaking | Band pass | the region being adjusted |
| High shelf | High pass | the region being adjusted |

- In Adaptive mode the band keeps its own bandwidth while Shift is held (20.8). [C: CHG #10088]
- **Inherit bandwidth:** when Shift is released, the audition bandwidth is written to the band. [C: MAN]
- Turning solo on in LIN mode once caused a short playback stop (fixed in 20.8.1). [C: CHG] **Rec:** in LIN mode, run the audition filter as IIR so no extra latency switch is needed.

### 6.7 Buttons

| Button | Left-click | Right-click | Tag |
|---|---|---|---|
| Options | Opens the Options menu (2.3) | — | [C: MAN] |
| LIN | Toggle linear phase | Precision menu: Lowest, Low, Medium, High, Higher, Highest | [C: MAN, PYFLP] |
| HQ | Toggle HQ [I] | Mode menu: HQ+, Legacy, Enhanced. The button shows the mode as a subscript. A 20.8 fix stopped the button highlighting on right-click. | [C: MAN, CHG #9984, #18098] |
| View band tokens (✔) | Toggle token visibility | — | [C: MAN] |
| Monitor (–, \|, O) | Select off / input / output | — | [C: MAN] |
| Compare: first down-arrow | Copy the current settings to the spare bank (blocked while "Lock spare state" is on) | — | [C: MAN] |
| Compare: up/down arrow | Swap the main and spare banks. Editing any parameter while on the spare bank makes it the main bank. | — | [C: MAN] |

### 6.8 Popup menus

- **Token right-click** [C: MAN]:
  - Type ▸ Low Pass, Band Pass, High Pass, Band Cut, Low Shelf, Peaking, High Shelf.
  - Order ▸ the seven slopes (12–48 dB/oct).
  - Key ▸ a list of notes. Choosing one moves the band to that note's fundamental frequency.
  - The Key list layout is [U]. **Rec:** octaves, then the 12 notes; equal temperament with A = 440 Hz; only notes inside 20 Hz–20 kHz; FL note naming. Since 20.8 popup items carry hints. [C: CHG #10010]
- **FREQ knob right-click:** the standard FL control menu, plus note-snap values. [C: CHG #10683]
- **Options menu:** the items in 2.3, in that order. The heatmap items were reordered in 20.8.1 to match Maximus. [C: CHG #10607]
- **LIN right-click:** six precision steps. **HQ right-click:** three modes. **Headphone right-click:** Adaptive / Bandpass. [C: MAN]

### 6.9 Hint-bar texts

Exact strings are [U]. What is known:
- Values are shown on hover since 20.8. [C: CHG #10009]
- Frequency and level are context aware since 20.8.1. [C: CHG #10470]
- BW shows as a percent. [C: KVR10]
- Hovering the graph gives a dB readout. [I]

**Rec:**
- Level: "Band 3 level: +2.5 dB"
- Frequency: "Band 3 frequency: 294 Hz" (switch to kHz from 1000 Hz, e.g. "1.36 kHz")
- BW: "Band 3 bandwidth: 39%"
- Type and order: "Band 3 type: Peaking", "Band 3 order: Steep 8 (48 dB/oct)"
- Main level: "Main level: +0.0 dB"
- Graph hover: "1.25 kHz / −3.4 dB"

### 6.10 Modifier summary

| Modifier | On a token | On a knob or fader | On empty graph |
|---|---|---|---|
| none (drag) | frequency + level | value | main level |
| Ctrl | fine | fine | fine [I] |
| Shift | bandwidth drag, or band solo when that option is on | no snap | [U] |
| Alt + click | reset band | reset control | [U] |
| Middle button | bandwidth drag | reset control | [U] |
| Wheel | bandwidth | step value | [U] |
| Right-click | Type/Order/Key popup | control menu | [U] |

### 6.11 Undo, automation, type-in

- Parameter edits go to FL's undo history; more PEQ2 changes became undoable in 25.1.3. [C: CHG #20502]
- Automatable: the 36 plugin parameters, i.e. every band's level, frequency, width, type and order, plus Main level [C: HOST]. LIN, HQ, Monitor and the options are state only (not parameters) [C: HOST]. [C: CHG #10069, #19268]
- Automation must be honored during offline rendering; a 20.8 fix made automation work in renders. [C: CHG #10389]

---

## 7. DSP

### 7.1 Signal flow

1. Stereo input; the same coefficients are used on L and R. There is no Mid/Side processing: Monitor input affects only the display. [C: MAN, FLSP]
2. The 7 band filters in series.
3. Main level gain.
4. Output.

Mode variations:
- **HQ L / HQ E:** the band chain runs at 2× the host rate between an upsampler and a downsampler. [C: MAN-DE, MAN]
- **LIN:** the combined response of all bands is applied as one FFT-domain linear-phase filter. [C: MAN]
- **Skipped bands:** Off bands, and peaking or shelf bands at 0 dB, use no CPU. [C: MAN]

### 7.2 Standard IIR mode ("draft", HQ off)

PEQ2 credits Robert Bristow-Johnson's EQ Cookbook. [C: MAN] Community sources say the same. [C: KVR10, FLIP] Cookbook definitions [C: RBJ]:
- ω0 = 2π·f0/Fs
- A = 10^(dBgain/40)
- α from Q: α = sin ω0 / (2Q)
- α from bandwidth in octaves: α = sin ω0 · sinh((ln 2 / 2) · BW · ω0 / sin ω0)
- α from shelf slope S: α = (sin ω0 / 2) · sqrt((A + 1/A)(1/S − 1) + 2)

Coefficients per type (unnormalized; divide by a0) [C: RBJ]:
- **LPF:** b = ((1−cos)/2, 1−cos, (1−cos)/2); a = (1+α, −2cos, 1−α)
- **HPF:** b = ((1+cos)/2, −(1+cos), (1+cos)/2); a as LPF
- **BPF** (0 dB peak): b = (α, 0, −α); a as LPF
- **Notch:** b = (1, −2cos, 1); a as LPF
- **Peaking:** b = (1+αA, −2cos, 1−αA); a = (1+α/A, −2cos, 1−α/A)
- **Low shelf:**
  - b0 = A[(A+1) − (A−1)cos + 2√A·α]
  - b1 = 2A[(A−1) − (A+1)cos]
  - b2 = A[(A+1) − (A−1)cos − 2√A·α]
  - a0 = (A+1) + (A−1)cos + 2√A·α
  - a1 = −2[(A−1) + (A+1)cos]
  - a2 = (A+1) + (A−1)cos − 2√A·α
- **High shelf:**
  - b0 = A[(A+1) + (A−1)cos + 2√A·α]
  - b1 = −2A[(A−1) + (A+1)cos]
  - b2 = A[(A+1) + (A−1)cos − 2√A·α]
  - a0 = (A+1) − (A−1)cos + 2√A·α
  - a1 = 2[(A−1) − (A+1)cos]
  - a2 = (A+1) − (A−1)cos − 2√A·α

Mapping PEQ2 parameters onto these [C: HOST]: peaking, BPF and notch use the bandwidth form of α with the ω0/sin ω0 pre-warp (BW per 4.4); LPF/HPF α = sin ω0/(2Q); shelves the S form. Peaking frequencies are limited to 0.35·Fs (0.4·Fs for staggered Steep sections), LP/HP/shelves to 0.4995·Fs; BP/notch at or above Nyquist are bypassed (FL's notch returns NaN there). The filters run in direct form I. Earlier recommendation:
- Peaking, BPF and Notch: use the bandwidth-in-octaves form of α. The ω0/sin ω0 factor pre-warps the bandwidth; whether IL uses it is unknown.
- LPF, HPF and shelves: convert BW to Q with the analog formula (2.4) and use α = sin ω0 / (2Q), subject to the shelf hypotheses in 4.4.
- At 0 dB a peaking or shelf biquad is exactly the identity, so the default instance is transparent in this mode.

Near Nyquist, these bilinear-transform filters "cramp": peaks and shelves get squeezed and the curve is forced to Nyquist. That is the reason HQ exists. [C: FLIP, MAN-DE]

### 7.3 Higher orders

See 4.3 for the measured section sets of every type and order [C: HOST]. Implement every order as a cascade of biquads, so all modes reuse the same section code.

### 7.4 HQ modes

| Mode | How it is built | Latency | Side effects | Tag |
|---|---|---|---|---|
| HQ off | RBJ biquads at the host rate | 0 | Cramping near Nyquist | [C: FLIP]. The name "draft": [C: F-BUG25] |
| HQ L (Legacy) | 2× oversampling with HIIR polyphase IIR half-bands (6 coefficients, transition 0.1) around RBJ biquads designed at 2·Fs [C: HOST] | 0 [C: HOST] | Extra phase rotation above ~15 kHz. Inter-sample peaks can raise the output peak level. | [C: MAN, MAN-DE] |
| HQ E (Enhanced; probably the "HQ2" of the 20.8 changelog [I]) | Zero-stuffing, RBJ biquads at 2·Fs, then a 176-tap sine-windowed sinc and every other sample [C: HOST] | 44 samples at any rate (1 ms at 44.1 kHz), reported to the host [C: HOST] | No extra phase rotation, accurate output peaks. Recommended when the EQ'd signal is mixed with the dry one. | [C: MAN, CHG #9625] |
| HQ+ (FL 24+) | "Decramped" IIR filters that copy the response of an ideal analog filter up to Nyquist. Bandwidth stays constant at any center frequency and does not change with gain. No oversampling, CPU equal to the standard IIR. | 0 | Slight phase difference from true analog | [C: MAN, CHG #9793]. "No more cramping", no latency, low CPU: [C: F-HQP24] |
| HQ inside LIN | Gives the analog-style magnitude without oversampling | (LIN latency) | — | [C: MAN-DE] |

- **HQ+ method [C: HOST]:** each section is a biquad matched to the analog prototype's magnitude at characteristic points: peaking at DC, Nyquist, the centre (value and extremum) and the lower half-gain edge; LP at DC (value and curvature), Nyquist and the resonance peak (value and position) or min(f0, Fs/4); HP from the (f/f0)^4 asymptote and the peak or Nyquist + min(f0, Fs/4); BP and notch with impulse-invariant poles; shelves with impulse-invariant poles and a numerator matched at DC, min(f0, Fs/10) and Nyquist, or (Q² > 0.6) at both overshoot extrema. Details and the two unidentified corner cases in docs/research/fx/peq2.md. Vicanek's matched filters [C: VIC] are a related family but not FL's choice.
- [L] Before 20.8, HQ was oversampling whose latency the host was not told about; a community null test showed this. [C: FLIP] It also produced a small peak increase with flat settings. [C: F-HQ19, F-GOL]
- **Known issue:** a 2025 report says the slope changes when switching between draft and HQ. [C: F-BUG25] **Rec:** keep all modes matched on the magnitude curve below about 10 kHz.

### 7.5 LIN mode (linear phase)

- FFT-based filtering with no phase rotation. A proprietary scheme lets cutoff and level move quickly, which normal FFT linear-phase EQs cannot do. [C: MAN]
- Linear phase mod speed (Normal, Fast, Faster, Ultra) sets the maximum parameter slew; faster settings use more CPU. [C: MAN]
- The Precision menu (6 steps, default Medium) trades a steeper achievable slope for more latency. [C: MAN, PYFLP] The latency is reported for delay compensation. [C: MAN]
- Latency per step [C: HOST]: 384·2^p samples (384 … 12288) at every sample rate; kernel K = 256·2^p taps from the minimum-phase design's magnitude converted as 2^(dB/6), sampled on 2K bins, sine window; kernel changes crossfade over 0.1 / 0.25 / 0.01 / 0.02 s (stored LIN mod speed 0 … 3). The earlier estimate: The sister plugin Frequency Splitter describes its FFT engine in the same words and comes from the same developer, so it probably shares the engine [I]. It documents 12 to 290 ms of latency depending on precision. [C: FSPLIT] **Rec:** FFT sizes from 1024 (Lowest) to 32768 (Highest) at 44.1/48 kHz, scaled with the sample rate. Latency is about half the FFT length for a centered linear-phase kernel.
- Past bugs show the engine is sample-rate dependent and block based [I]: noise at 22 050 Hz, glitches at some sample rates, a crash at 22 kHz, breakage at 96 kHz, buffers not flushed on resume. [C: CHG]

### 7.6 Parameter smoothing

- Minimum phase mod speed (Off, Medium, Smooth; default Off) limits how fast IIR coefficients follow parameter changes, against crackles. [C: MAN, PYFLP] Measured [C: HOST]: Off = changes apply at once (sample-exact, direct form I state kept; type or order changes clear the band); Smooth = one-pole glide per sample of level (dB), frequency and BW (knob units) with k = 44100/(192·Fs) (τ ≈ 4.3 ms), Medium = 1 − (1 − k)² (τ ≈ 2.2 ms); coefficients recomputed every sample.
- A 21.0 fix removed clicks when the band 7 level moves. In FL 2026 the level is not smoothed with the option Off [C: HOST]; a band at 0 dB keeps its filter history for 0.2 s (then it is dropped), so leaving 0 dB is seamless within that time. [C: CHG #12460]

### 7.7 Latency summary

| Mode | Latency | Tag |
|---|---|---|
| Standard IIR / HQ+ / HQ Legacy | 0 | [C: MAN] |
| HQ Enhanced | 44 samples at any rate (≈ 1 ms at 44.1 kHz) | [C: MAN], [C: HOST] |
| LIN | 384·2^precision samples (384 … 12288) at any rate | [C: MAN], [C: HOST] |

### 7.8 Sample rate and Nyquist

- The frequency range is 20 Hz to 20 kHz at every sample rate. [I]
- Below 40 kHz (HQ off) [C: HOST]: LP/HP/shelf frequencies are held at 0.4995·Fs, peaking at 0.35·Fs, band pass is bypassed at or above Nyquist and FL's notch outputs NaN there (the clone bypasses it). HQ+ at those rates was not measured (the clone holds f0 below Nyquist).
- PEQ2 runs at 22.05 kHz and 96 kHz; changelog fixes mention both. [C: CHG #10443, #10450]

### 7.9 CPU and transparency

- Off bands and 0 dB peaking or shelf bands are skipped. [C: MAN]
- A default instance in HQ off or HQ+ is bit-transparent (all biquads are identity). [C: HOST]
- HQ L and HQ E always resample, so they change the waveform slightly even when flat (inter-sample peaks, phase above 15 kHz for Legacy). [C: MAN] Confirmed [C: HOST]: flat Legacy is the HIIR up/down impulse response, flat Enhanced a 44-sample delay with gain 0.99984.

### 7.10 Analyzer DSP (Rec, built from the documented options)

- **Input:** the Monitor source (pre- or post-EQ), downmixed to Mid, Side, L or R. [C: MAN]
- **FFT:** size set by Frequency precision. [I] **Rec:** 2048 / 4096 / 8192 / 16384, Hann window, 50–75 % overlap. Map bins to the log x axis, with peak-hold per pixel column.
- **Ballistics:** peak mode falls at a rate set by Time smoothing; Average mode is an RMS average over a window set by Time smoothing. [C: MAN]
- **Pivot tilt:** add slope · log2(f / 1 kHz) dB. [I]
- **Floor:** Range. [C: MAN] Heatmap brightness = normalized level per column. [I]

### 7.11 Clone implementation notes (Rec)

- **AudioWorklet:** one processor per instance.
  - Biquad cascade in transposed direct form II, in double precision, for all IIR modes.
  - 2× oversampling for HQ L/E: an IIR all-pass half-band for Legacy, a ~31–63 tap FIR half-band for Enhanced. Report its latency to the clone's own delay compensation.
- **LIN:** uniformly partitioned or overlap-save FFT convolution with a zero-phase kernel built from the summed band magnitudes. Crossfade kernels on parameter change; the crossfade time sets the mod-speed setting.
- **Shared math:** compute the drawn curve from the same coefficients the audio uses (main thread copy), so display and sound always agree.

---

## 8. Open questions and how to settle them

FL Studio is installed on this machine, so each item can be measured. Render a sine sweep or an impulse through PEQ2, or use a null test, and read values from the hint bar.

Items 1–6 and 9 were answered with the plugin host (October 2026; see the [C: HOST] entries and docs/research/fx/peq2.md). Item 10: solo is not saved; its audio effect is UI state the host cannot set.

1. **BW on shelves, LP and HP.** Measure a high shelf (+12 dB, 1 kHz) at BW 0 %, 38.8 %, 61.2 % and 100 %, and an HP at the same BW values. Fit to RBJ Q or S to choose between hypotheses H1 and H2 (4.4).
2. **Peak and shelf orders.** Measure Peaking +12 dB at 1 kHz for every order from Steep 8 to Gentle 8; do the same for a shelf.
3. **BP and Notch orders.** Check whether the selector dots and popup offer orders for these types, and what they do.
4. **Order sign.** Confirm that stored −3 = Steep 8: save a preset with Steep 8 and decode it.
5. **Main level range** (lower end) and whether the curve moves with it.
6. **HQ defaults and encoding.** Which mode a fresh instance shows, and which stored HQ value means HQ+.
7. **Exact strings:** hint-bar texts, Key menu layout, top-ruler labels (both rows), bottom-ruler labels.
8. **Per-band curve drawing rules,** token rendering for gainless types, hover/selected styles, analyzer colors. Take a 100 %-scale screenshot of the default instance with audio playing.
9. **LIN latency** per precision step at 44.1 and 48 kHz (read FL's mixer delay-compensation display).
10. **Mute/Solo semantics** (band solo vs. EQ bypass), and whether solo is saved.
11. **Mouse wheel direction** on tokens, and the drag direction of the type selector.

---

## 9. Sources

**Official Image-Line material**

| Key | Source |
|---|---|
| MAN | Current manual page: `https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/Fruity%20Parametric%20EQ%202.htm` (read 2026-10-17; identical copies under `/support/flstudio_online_manual/`, `/support/FLHelp/` and `/fl-studio-learning-content/`) |
| MAN-DE | Older English revision (FL 20.8–21 content) served at `https://www.image-line.com/fl-studio-learning/fl-studio-online-manual-de/html/plugins/Fruity%20Parametric%20EQ%202.htm` |
| MAN-ZH | Chinese translation of the pre-20.8 revision: `https://www.image-line.com/fl-studio-learning/fl-studio-online-manual-zh/html/plugins/Fruity%20Parametric%20EQ%202.htm` |
| CHG | FL Studio "What's New" changelog bundled with FL Studio 2026: `/Applications/FL Studio 2026.app/Contents/Resources/FL/Help/WhatsNew.htm`. Cited by version and bug number. |
| PRESET | Factory state files shipped with FL Studio 2026. Plugin-database default `…/Resources/FL/Data/Patches/Plugin database/Effects/Filter/Fruity Parametric EQ 2.fst` (saved by FL 21.2.99.4033; byte-identical to the user-folder copy). 13 factory presets in `…/Data/Patches/Plugin presets/Effects/Fruity Parametric EQ 2/`. Decoded for this document. |
| THUMB | Plugin thumbnail `…/Resources/FL/System/Config/Thumbnails/Fruity Parametric EQ 2.png` (234 × 117), and palette `…/Plugins/Fruity/Effects/Fruity Parametric EQ 2/Artwork/Spectrum.bmp` (512 × 1). Pixel-measured locally. |
| UI | FL manual, generic control behavior: `https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/basics_interface.htm` |
| FSPLIT | Frequency Splitter manual (shares the analyzer and the linear-phase engine): `https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/Frequency%20Splitter.htm` |
| VID | Image-Line video "FL STUDIO \| Parametric EQ 2 (Updated)", 2021-01-12, chapter list in its description: `https://www.youtube.com/watch?v=YrGxCRlCvQI` |
| F-B208 | FL Studio 20.8 Beta 4 announcement (Image-Line staff, 2020-11-16): `https://forum.image-line.com/viewtopic.php?p=1554003` |
| F-GOL | Developer reply "peak <> volume" (2014): `https://forum.image-line.com/viewtopic.php?f=200&t=127201` |

**Community and reference**

| Key | Source |
|---|---|
| PYFLP | PyFLP issue #159, "Fruity Parametric EQ 2 parser" (2023): state layout and option enums. `https://github.com/demberto/PyFLP/issues/159` |
| F-FORM | "I derived useful formulas for Fruity Parametric EQ 2 and volume fader" (2020-08-02): `https://forum.image-line.com/viewtopic.php?t=236047`, with its Desmos calculator `https://www.desmos.com/calculator/egt4lkk9ow` (gain, frequency and BW formulas) |
| F-FREQ | "What's the freq scale for Parametric EQ 2?" (2013; 20 Hz–20 kHz, 50 % = 632 Hz): `https://forum.image-line.com/viewtopic.php?t=117965` |
| F-SLOPE | "About slope types in EQ 2" (2015; quotes the FL 12 manual): `https://forum.image-line.com/viewtopic.php?t=146191` |
| F-SLOPE07 | "Parametric EQ 2 (Show the Filter Slope dB/Oct)" (2007): `https://forum.image-line.com/viewtopic.php?t=6377` |
| F-GS19 | "PEQ2: Gentle and Steep curves are the same?" (2019): `https://forum.image-line.com/viewtopic.php?p=1372720` |
| F-REEN | "Parametric EQ 2 manual missing reenable band instructions" (2021): `https://forum.image-line.com/viewtopic.php?t=267965` |
| F-DISP10 | "Fruity Parametric EQ 2: Bigger display + professional spectrum" (2010): `https://forum.image-line.com/viewtopic.php?p=428951` |
| F-HQ19 | "A Default, completely flat Fruity Parametric EQ 2 adds dB?" (2019): `https://forum.image-line.com/viewtopic.php?t=211395` |
| F-HQ20 | "Parametric EQ 2 problem" (2020; HQ = 2× oversampling): `https://forum.image-line.com/viewtopic.php?t=229921` |
| F-HQP24 | "Parametric EQ 2 HQ+ is great with no compromises" (2024): `https://forum.image-line.com/viewtopic.php?t=327322` |
| F-HQE25 | "Parametric EQ2 - HQ+ Mode vs. HQE Mode" (2025): `https://forum.image-line.com/viewtopic.php?p=2015844` |
| F-BUG25 | "Parametric EQ2 BUG in HQ/Draft and Linear Phase" (2025): `https://forum.image-line.com/viewtopic.php?p=1993858` |
| F-MAIN26 | "Improvement for Fruity Balance / New Utility Plugin" (2026; Main level reaches +18 dB): `https://forum.image-line.com/viewtopic.php?p=2059109` |
| KVR10 | KVR "FL Parametric EQ 2 discussion!!!" (2010; BW shown in %, 100 % = widest; cookbook filters): `https://www.kvraudio.com/forum/viewtopic.php?t=281064` |
| FLIP | FLipside forum "Parametric EQ 2" (cookbook filters, cramping, old HQ latency): `https://www.theflipsideforum.com/index.php?topic=30216.0` |
| FLSP | flstudiopro.com guide (2026, secondary summary of MAN): `https://flstudiopro.com/fruity-parametric-eq-2/` |
| RBJ | W3C Audio EQ Cookbook (Bristow-Johnson): `https://www.w3.org/TR/audio-eq-cookbook/` |
| VIC | M. Vicanek, "Matched Second Order Digital Filters": `https://www.vicanek.de/articles/BiquadFits.pdf` |
| HOST | FL Studio 2026 (26.1.6) `Fruity Parametric EQ 2_x64.dylib` measured with the command-line plugin host (value-text sweeps, impulse/noise/automation renders, saved states); method and residuals in `docs/research/fx/peq2.md` |

Forum replies on forum.image-line.com are cut short for visitors who are not logged in, so only first posts and reply openings were readable. Claims taken from truncated replies are not used.

### Appendix: factory presets decoded (test fixtures)

Bands set to Off are omitted. Frequencies use f = 20 · 1000^x. "2" = default order. Source: [C: PRESET]; conversion [I].

| Preset | Active bands |
|---|---|
| Default | B1 LS 63 Hz 0 dB BW 61 %; B2–B6 Peak 136 / 294 / 632 / 1363 / 2936 Hz 0 dB BW 39 %; B7 HS 6.32 kHz 0 dB BW 61 % |
| Peaking only | As Default, but all seven bands Peaking (B1 and B7 keep BW 61 %) |
| 3 bands | B1 LS 63 Hz, B2 Peak 632 Hz, B3 HS 6.32 kHz, all 0 dB, BW 61 %; B4–B7 Off |
| 20Hz + 18kHz cut | B1 HP Steep 8 20 Hz BW 55 %; B7 LP Steep 8 18.7 kHz BW 55 % |
| 30Hz + 18kHz cut | B1 HP Steep 8 23.9 Hz BW 55 %; B7 LP Steep 8 18.7 kHz BW 55 % |
| 40Hz + 18kHz cut | B1 HP Steep 8 32.2 Hz BW 55 %; B7 LP Steep 8 18.7 kHz BW 55 % |
| 40Hz cut | B1 HP Steep 8 32.2 Hz BW 55 % |
| Quick Low Roll-Off | B1 HP order 2, 61.6 Hz, BW 69 % |
| Kick | B1 Peak 48 Hz +2.6 dB BW 20 %; B2 Peak 532 Hz −2.7 dB BW 21 %; B3 Peak 4.02 kHz +1.0 dB BW 39 % |
| Old Telephone | B1 LS 540 Hz −18 dB BW 19 %; B2 Peak 107 Hz −18 dB; B3 Peak 221 Hz −18 dB; B4 Peak 16.3 kHz −18 dB; B5 Peak 2.24 kHz +8.8 dB (B2–B5 BW 39 %); B7 HS 6.86 kHz −18 dB BW 23 % |
| Radio | B1 LS 319 Hz −17.7 dB BW 0 %; B2 Peak 144 Hz −0.1 dB; B3 Peak 452 Hz −3.5 dB; B4 Peak 1.23 kHz 0 dB; B5 Peak 1.99 kHz +7.0 dB; B6 Peak 2.50 kHz −5.3 dB (B2–B6 BW 39 %); B7 HS 4.28 kHz −18 dB BW 0 % |
| Tight Drum Sizzle | B1 LS 51 Hz −18 dB BW 75 %; B2 Peak 375 Hz +0.3 dB BW 0 %; B6 Peak 11.9 kHz +4.2 dB BW 33 % |
| Vocal Presence | B1 LS 52 Hz −18 dB BW 75 %; B2 Peak 355 Hz −5.7 dB BW 20 %; B6 Peak 12.1 kHz +3.7 dB BW 31 % |

The "…Hz cut" names refer to where the passband is flat, not to the −3 dB cutoff. For example, "40Hz cut" puts a Steep 8 HP at 32 Hz, which is only −0.13 dB at 40 Hz. [I]
