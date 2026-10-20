# Wave Candy (FL: Wave Candy)

Oscilloscope, spectrum (sonogram), level meter and vectorscope. Category
Visual. Audio passes through unchanged. FL's editor (592 x 315) is a settings
panel; the visualisation lives in a separate display window (TSynthOSDForm).

## Parameters and state (flfxhost + disassembly of SaveRestoreState, version 9)
- Parameter 0 "Hold visualization" 0..1 (value text empty).
- State blob: version, hold, 28 colour targets x [object opacity, colour opacity,
  hue, lightness, saturation, stored ARGB], title (shortstring), font name, font
  height (negative px), style byte, alignment byte, an 88-byte settings struct
  mapped field by field to the form's controls through the form's RTTI field
  table (mode, gain, fade, reflect, punches, osc/spec/meter/vec wheels and combos,
  pinch, interpolate, visible, on desktop, keep in front, meter mode, auto visual
  mode, corners, stereo separation, vec block/thickness/mode/add, natural
  weighting, glow, enhanced frequency), 4 flag bytes (mini view, background,
  solid, on desktop) and two window rects (normal, mini view).
- All 38 factory presets (Default, Function/*, Theme/*) were loaded in flfxhost,
  saved and decoded; `src/model/fx/plugins/wavecandy/presets.ts` holds them as
  differences from Default. FL applies Default on insert, so it gives our defaults
  (Trebuchet MS 15 title, auto visual mode on, 301 x 126 window...).
- Colours: hue 0..256 = 0..360 deg; the stored colour is HLS(h, l, s) with alpha =
  colour opacity, premultiplied (and, for the spectrum stops, multiplied by object
  opacity); checked against FL's stored values (e.g. #67a014 for the -INF meter stop).
- Visual gain: value / 10 dB (FL: exp(v * 0.1 * ln10/20)).

## Display (approximations, after the manual screenshots)
- Frame: rounded rect (Corners / 16 px), background (colour opacity), punches
  grid, 1.5 px border, bevel when Reflect < 0, mirrored reflection (opacity
  Reflect/256, 42 % of the height) tinted by the reflection colours, glossy upper
  half (Glass effect), side lights (Glowing lights), outer glow (Glow), title with
  FL's font, style and alignment.
- Auto visual mode by aspect ratio (< 0.45 meter, < 0.8 spectrum, < 1.25
  vectorscope, else oscilloscope: matches the Function presets' window sizes).
  Mini view shows a meter.
- Oscilloscope: window = Window/100 ms, sync to a rising zero crossing within
  10 ms * 1000/Update; stereo separation (-1 = mono), pinch, interpolate.
- Spectrum: 2 x bands FFT, Hann, column every Update/100 ms (1 px), reassignment
  for "Enhanced frequency", log rows sent by the DSP; the vertical axis at Scale 0
  follows ln(1 + f/300) (fitted to the screenshot labels) and becomes log at 256 with
  a piano keyboard; dB range; natural weighting +3 dB/oct; 5-stop gradient.
- Meter: linear amplitude axis at Scale 128 with 0 dB at 80 % (fitted to the
  screenshot); FL's label set; modes Peak, PPM (5 ms), RMS (300 ms), VU, Leq(A)
  (A-weighted RMS 300 ms), ITU-R BS.1770 (K-weighted 400 ms momentary); hold
  (0 = none, 5001 = infinite) and decay (Decay speed ms per full scale).
- Vectorscope: rotated L/R (mono vertical), dotted pan grid, String / Spaghetti /
  Tube / Glowstick, thickness, additive blending; built-in colours per mode, tinted
  by the Lissajou target.
- Hover hints (dB, Hz + note, ms) with the Hint / Hint location colours.

## Display window lifetime
- The display is the module's `Persistent` part: it lives as long as the slot,
  editor open or not. It opens when the plugin is inserted (FL: "Visible" is on
  in the Default preset) and when a project with a visible display loads, and
  closes when the slot is removed. Its open state is the window store entry
  `fxaux:<slotId>`, kept in step with "Visible" (a close from elsewhere, e.g.
  F12, turns "Visible" off). It stays frameless like FL's layered window, is
  stacked with the app windows (raised on click; "Keep in front" puts it on
  top), and its rect is saved in the plugin state without an undo step.
  Double-click / "View settings" opens the editor.

## Omissions
- "On desktop" has no browser meaning.
- FL's exact drawing of bevel, glass, punches and glow, the oscilloscope
  update/window semantics and FL's spectrum colour interpolation are approximated.
- The font dialog is reduced to a title menu (fonts, size, italic, bold, alignment).
