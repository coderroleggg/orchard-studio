# Phase Inverter (FL: Fruity Phase Inverter, legacy)

Inverts the left or the right channel (Didier Dambrin). Not in FL's plugin database
(`def.hidden`). Editor 170 x 55. No latency, no tail, no factory presets.

## Sources
- Form: StateBevel (5,5,160,45), StateWheel TVectorWheel (7,8,46,40) Tag 0, 0..1024,
  default 1024; header "STATE" (59,5,106,16); StateValueLabel (60,31,102,14).
- flfxhost renders (DC through every state) and disassembly; the editor's label captions
  were captured at runtime (lldb on the caption setter).

## Parameter (exact)
- x = float32(v / 1024); state = Round(float32(float32(x * 3) - 0.5)), banker's rounding:
  0..341 Off, 342..682 Left, 683..1024 Right.
- Value label = the state name ("Off", "Left", "Right"). FL 2026 shows the plain name; the
  manual's older screenshot reads "State: Right", which today is only the hint text
  (parameter name + ": " + name). FL's GetName returns no value text.

## DSP (exact)
- The input is copied, then the sign bit of every sample of L (state 1) or R (state 2) is
  flipped. Changes are instant (no ramp).

## Editor
- FL's legacy vector look (shared `mute2/legacy.tsx`), lime colour scheme
  (arc / pointer / caption #f4ffd4 measured on the 1.5x screenshot).
