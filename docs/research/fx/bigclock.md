# Big Clock (FL: Fruity Big Clock)

Large song position readout. Category Visual. Editor 200 x 146. No parameters,
no audio processing (pass-through). The editor reads the transport position
(`currentTick()` from src/audio/live.ts) every frame; pattern mode wraps at the
pattern length like the top bar's clock.

## From the binary
- Saved state: version 2, step flag (byte), scheme index (int32). The built-in
  state is `02 01 00000000`: **B:S:T on**, scheme 0. Stored as `steps` and `scheme`.
- Left click on the song display toggles Bar:Step:Tick / Bar:Beat:Tick (label
  STEP / BEAT, tag `B:S:T` / `B:B:T`); left click on the clock display cycles the
  colour scheme; the ColorSchemePopup lists Default, Orange, Blue, Black, Green,
  Red, Yellow (right-click, and the plugin window menu here).
- Scheme colours (digits / background): Default `#dbedee`/`#536566`, Orange
  `#ea5c0c`/`#672b1f`, Blue `#33d5e5`/`#141d22`, Black `#141615`/`#739479`, Green
  `#06c400`/`#141d22`, Red `#f11c22`/`#111111`, Yellow `#f2e3b5`/`#7f4950`.
- Panel `#31363b`. The digit font (P_DigitWheel) is sized to the box height
  (`min(W/9 * 2.63, H)` = 45 px).

## Layout (form + manual screenshot)
- Panels (0,0,200,71) and (0,76,200,70); digit boxes (5,21,190,45) and
  (5,95,190,45); labels BAR/BEAT|STEP/TICK and MIN/SEC/1/100 at the form positions
  (OpenSans-CondLight 12 px; a system condensed font stands in).
- Digit centres measured on FL's display: big digits 36 px tall, 21.6 px apart,
  first `bb` digit at x 107, colon at 91, `a` right-aligned at 73.6; small group
  22 px tall, 13.7 px apart, last digit at 173.6, colon at 146; tag bold ~7.5 px at
  the top right.

## Approximations
- Fonts (P_DigitWheel, P_Tiny2, OpenSans-CondLight) replaced by system fonts
  scaled to FL's glyph sizes.
- Clock time uses the current project tempo (no tempo automation), as the app's
  own top-bar clock does. FL's "REC IN" countdown and negative times are not shown.
