# Send (FL: Fruity Send)

Pre-fader send from any point of an FX chain to another mixer track. Category Gain.
Editor 258 x 84. 3 parameters plus the target (not a parameter). No latency, no tail.
No factory presets (FL has no preset folder for it).

## Sources
- Form `Fruity Send`: wheels Dry (Tag 2, 0..256, form DefaultValue 320 > Max, so 256),
  Pan (Tag 0, -128..128), Volume (Tag 1, 0..320, def 256); DigiWheel `SideChainSelect`
  (Tag -1, "Target mixer track", VDWS_Simple, red `#7e333c`) and the `ChanSelect` button
  ("Send to", "Target channel") that opens the InOutPopup menu.
- flfxhost value texts; a patched copy of flfxhost (scratch) that returns a real buffer
  from `GetOutBuffer` and pokes the hidden target field, to capture the send output.
- Disassembly of the arm64 plugin: Eff_Render (slot 7), ProcessParam (slot 6), the
  matrix routine and the editor's target/menu code (FHD_GetNumInOut 50, FHD_GetOutName 52).
- Manual page and screenshots (1.5x; "Send to" setup).

## Parameters and texts (exact)
| # | Name | Range | Text |
|---|---|---|---|
| 0 | Send panning | -128..128 | p64 = v div 2 (truncated, unlike PanOMatic); `Centered` or `Round(abs(p64)*100/64)% left/right` |
| 1 | Send volume | 0..320 | `%.1fdB` of g = (11^(v/256) - 1)/10, `-InfdB` at 0 |
| 2 | Dry level | 0..256 | `%.0f%%` of v/256 (half up), although the gain follows the 11^x law |

## DSP (exact; A/B renders match FL to float precision for dry and send outputs)
- Target: a hidden 4th value (object field 0x13c) = FL output index (1..N among the
  tracks this track is routed to, 0 = none). Each block with a target:
  `GetOutBuffer(index)`, mix the matrix-panned input into it, `GetOutBuffer(index, IO_Filled)`.
- Send matrix = PanOMatic's: p >= 0: LL=(1-p)v, LR=pv/2, RR=v-LR; p < 0: RR=(1+p)v,
  RL=-pv/2, LL=v-RL; v = (11^(vol/256)-1)/10. Coefficients ramp per block at most
  44.1/sr per sample, start at 0 (fade-in at creation) and only move while a target is set.
- Dry: `dst = src * (11^(dry/256)-1)/10`, plain copy at 256; the send is taken from the
  input before the dry gain. "50%" on the Dry wheel is -12.7 dB.

## Clone design
- The target is stored as the mixer track itself (`target`, -1 = none); `sendTargets()`
  reports it so the mixer processes the target after this track; `ctx.sendTo()` adds the
  panned send (computed in preallocated scratch buffers) to the target's input.
- The editor shows FL's number: the target's position among the track's routes (Master
  first, then tracks in order), `·` for none. Drag / wheel steps through the routes;
  right-click or the "Send to" button opens (none) + route names. Changes are undoable
  (merged while dragging).

## Deviations / open questions
- The dry gain steps per block without smoothing, as in FL (measured: -156 dB through dry
  changes; the former 44.1/sr ramp gave -12 dB).
- If the route to the target is removed, FL's output index would point elsewhere or
  nowhere; the clone keeps sending to the stored track (no feedback is possible: audio
  sent to an already processed track is dropped) and the editor shows `·` with a
  "not routed" hint.
- FL refuses Send on the Master track; the clone's engine never sends from a track to itself.
- The manual says Dry defaults to 0%; FL 2026's binary initialises it to 256 (100%).
