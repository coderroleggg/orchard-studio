# Gross Beat (`grossbeat`)

FL Studio's tempo-synced time / volume manipulation effect. Sources: FL's
form (`Gross Beat.txt`), the manual, FL's factory presets, and measurements of
the real plugin binary with `flfxhost` (render, `--state`, `--at`), 48 kHz,
120 BPM unless noted.

## Parameters (FL Tags 0..8)

| # | key | FL name | range / default | value text (FL) |
|---|---|---|---|---|
| 0 | tslot | Time slot | 0..35 / 0 | "Slot 1" |
| 1 | vslot | Volume slot | 0..35 / 0 | "Slot 1" |
| 2 | tmix | Time mix | 0..256 / 256 | "38%" (round half away from 0) |
| 3 | vmix | Volume mix | 0..256 / 256 | % |
| 4 | att | Volume smoothing attack | 0..10000 / 1765 | `500*(501^x-1)/500` ms, "2.00ms" |
| 5 | rel | Volume smoothing release | 0..10000 / 5000 | `1000*(501^x-1)/500` ms, "42.77ms" |
| 6 | tns | Volume envelope tension | -256..256 / 0 | "-13%" |
| 7 | hold | Hold delay (bar repeat) | 0..1 / 0 | "" (FL shows nothing) |
| 8 | offset | Time offset (scratching) | 0..65536 / 65536 | "-bar:beat:tick": 65536-v in 1/8192 beat, ticks rounded without carry ("-000:00:096" for 57345) |

FL's insert state (`Default.fst` = constructor state): 36 + 36 unnamed flat
slots, trigger and position sync "4 beats". FL's 9 factory presets (Default,
Flanging, Juggling Science, Momentary = the classic bank of the manual,
Patterns, Pitch shifter, Repeater, Stutter, Turntablist) were decoded from
`--save-state` dumps and are stored compactly in the def (~74 KB text).

## State format (decoded)

int32 version, 9 int32 params, int32 edited-envelope (0 time / 1 volume),
bytes: Remove DC, Smoothing attack compensation, HQ, (MIDI or clock),
Click reduction (0 Off / 1 Low / 2 High); then 72 slots: shortstring name,
int32 trig sync, int32 pos sync, int32 force hold, bytes link / key-held /
one-shot, then an FL envelope (int32 3, flags, count, points of double dx
(beats), double y, float tension, int32 mode | sign<<24, then 20 bytes).
Point modes are the automation enum (0 single, 1 double, 2 hold, 3 stairs,
4 smooth stairs, 5 pulse, 6 wave, 7 alt single, 8 alt double, 9 half sine).
Snap / step / slide / freeze are not saved by FL (stored here anyway).

## DSP (measured)

- **Latency 15 samples** (reported and measured); the dry path is the input
  delayed 15 samples.
- **Time envelope**: y -> offset (1-y)*8 beats; envelope phase = song beat
  mod 4 for bar-synced slots. Read position = now - 15 - offset (the
  measured read position is within ~0.3 ms of this; FL shows a few samples
  of extra lag on some slopes). Before the buffer holds audio: silence.
- **Interpolation**: impulse response at a 2.93-sample offset is a 12-14 tap
  windowed sinc; fitted by a Kaiser (beta 7) sinc with half-width 6.
- **Time mix**: linear crossfade dry/wet (50% = average), FL-exact.
- **Volume**: TNS maps the envelope value by FL's Single curve with tension
  tns/512 (exact). ATT/REL: two cascaded one-poles, attack while the target
  is above the output; time constant = displayed time / 6.5 (max error 0.1%
  vs FL on a gate). Volume mix linear; volume applies after the time mix.
- **Click reduction** (option, default Low): at a jump the difference
  old - new is added to the output and decays exponentially: tau 5.42 ms
  (Low), 7.58 ms (High), same in ms at 44.1 kHz; Off = hard switch. With
  HQ off this matches FL within -75 dB.
- **HQ resampling** (default on in FL): kernel widened by the smoothed
  playback speed (anti-aliasing for fast playback). FL's HQ also widens the
  kernel enormously for ~1 ms after every jump (smearing the new segment's
  onset and reading stale buffer data); **not replicated**: with HQ on, the
  clone differs from FL by up to -20..-30 dB in the ~5 ms after each jump.
- **Smoothing attack compensation**: the time envelope is read earlier by the
  attack time (FL: jump 96 samples early with ATT 2 ms).
- **Remove DC offset**: one-pole DC blocker, tau 39.7 ms (~4 Hz).
- **Scratch offset**: three cascaded one-poles, tau 24.9 ms while the offset
  grows, 37.4 ms while it shrinks (fits FL within 0.04%).
- **Slot changes**: the new slot starts at the next multiple of its trigger
  sync (Off = at once); its envelope phase there is (start mod pos sync), or
  0 with pos sync Off (verified with Momentary and Repeater, `--at`).
- **HOLD** (button): engages at the next bar line and repeats the bar before
  it; the offset grows 4, 8, 12 beats in the following bars (FL); releases at
  the next bar line. Force hold Last = the same from the slot's start (silent
  at song start), Next = repeat the bar after the next bar line.
- Transport stopped: pass-through (latency kept). Start of playback forgets
  the buffer; a loop/jump while playing keeps it and restarts the envelopes.
- Tail: two bars at the current tempo + 0.25 s, clamped to 1..12.5 s.

## Editor

831 x 561 (FL's runtime size and the manual screenshot; the form's design
size 824 x 535 would put the ATT/REL/TNS row over the volume slots): the
bottom rows are anchored +26 px, the right-edge controls +7 px. Slots,
toolbar, envelope editor (square 4 x 8 beat grid, safety line, reverse
guides, -1..-7 labels, playback locator from `monitor()`), FL's point menu,
Options menu, mapping options menu (copy/paste state, undo, tools), bottom
bar combos and toggles. Colours sampled from the FL 2026 screenshot.

## Open questions / approximations

- HQ post-jump smear (above).
- **MIDI** (implemented): with *Trigger slots from MIDI notes* on (default), notes from a
  MIDI Out channel on the slot's MIDI input port select slots at their sample like a
  click: C5.. (keys 60..95, FL's numbering; the manual's "C4+" uses C4 = 60) the time
  slots 1..36, C2.. (24..59) the volume slots 1..36, with the slot's trigger sync, Link
  slots and Key-held (the previous slot comes back when the key is released). The
  selection is mirrored into the Time / Volume slot parameters (takeStateChanges).
- Which of the two option bytes is "MIDI" vs "View scratching clock";
  the trailing state byte (0 internal, 1 after loading any preset).
- Hold with the time mix below 100%: FL's dry path during hold not measured.
- Scale levels, Create sequence, Analyze audio file, open/save state files:
  disabled in the menu.
