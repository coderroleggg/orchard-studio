# Mute 2 (FL: Fruity Mute 2, legacy)

Automatable mute of the left, the right or both channels (Robert Conde). Not in FL's
plugin database (`def.hidden`). Editor 335 x 55. No latency, no tail, no factory presets.

## Sources
- Form: MuteBevel (5,5) / ChannelBevel (170,5) 160 x 45; MuteWheel (7,8) Tag 0 and
  ChannelWheel (172,8) Tag 1, 46 x 40, 0..1024, default 512; headers "MUTE" (59,5) and
  "CHANNEL" (224,5) 106 x 16; value labels (60,31) and (225,31) 102 x 14.
- flfxhost renders (L = 0.5, R = 0.25 DC across both wheels, automation steps),
  disassembly, and the label captions captured at runtime.

## Parameters (exact)
- x = float32(v / 1024).
- Mute: muted = x < 0.5 (v < 512). Label: "On" when not muted (sound on), "Off" when muted.
- Channel: trunc(float32(x / float32(1/3))) capped at 2: 0..341 "L", 342..682 "L + R",
  683..1024 "R". The name tables live in the binary as UTF-16 constants.
- FL's GetName gives no value text; the hint reads "Mute: On", "Channel: L + R".

## DSP (exact)
- Not muted: the input passes untouched (whatever the channel).
- Muted: L -> gains (0, 1); L + R -> buffer cleared; R -> gains (1, 0).
- Changes are instant (no ramp, no declick), as measured with `--at` automation.

## Editor
- FL's legacy vector look, pink scheme (#ffd4dd), shared `mute2/legacy.tsx`: 270 degree
  TVectorWheel with the lit / shaded pointer facet, rounded bevels, header strips, captions.
