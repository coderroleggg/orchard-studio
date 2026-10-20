# dB Meter (FL: Fruity dB Meter)

Large stereo peak meter. Category Visual. Editor 100 x 270. No parameters
(the host reports NumParams 0), no state. Audio passes through bit-exactly.

## Sources
- Form `Fruity dB meter`: panel colour `#44545c`; TWAVVolumeter `PeakMeter` (40,0,60,270,
  Max 65536); TVectorSlider `Ruler` (25,8,15,255, -36..6) used as a tick ruler; eight
  TQuickLabels (26 x 9, colour `#8998a0`, P_SmallBold, centred) "+ 6" .. "- 36".
- Disassembly of the arm64 plugin (event handlers found through the published-method
  table): PeakMeterPaint, PeakMeterMouseMove, PeakMeterMouseDown, the resize routine,
  the meter timer and the shared TWAVVolumeter code.
- Manual page and the manual screenshot (an older build: 2x, scale ended at -34 dB).

## Behaviour (exact, from the binary)
- Layout at runtime: label spacing `s = (Ruler.Height - 1) / 7` = 36.29 px, labels at
  `round(4 + k*s)` (4, 40, 77, 113, 149, 185, 222, 258); 6.048 px/dB; 0 dB at y = 44;
  orange threshold y = round(8 + 2s) = 81 (-6 dB).
- Meter timer (FPD_SetIdleTime interval T): for each channel the peak since the last
  tick gives `level = dB * pxPerDb + 226` px (0 for silence); `target = max(target, level)`;
  display = target; then `target -= 2 * height * T / 1000` (bars fall two meter
  heights per second, about 90 dB/s).
- Peak hold: set to the new level whenever it is >= the hold; held for 2000 ms
  (`round(2000 / T)` ticks); then falls by a speed that starts at 0.03 px/tick and
  grows x1.03 per tick. Right-click (mbRight in MouseDown) resets the holds.
- Paint per channel: gap colour `#2f373d` from the bar's left edge to the right end; bar
  background vertical gradient `#3f484d` -> `#363d42`; bars `(W - gap)/2` wide with a
  gap of `round(3 * scale)` and a 1 px dark column at x = 0; hold line: rows weighted by
  the table {0,192,192,0} (2 rows, 3 when fractional), colour orange darkened by 40
  (`#c89c25`) at alpha 160/256, only above the bar; bar `#b1dc4a`; the part above the
  -6 dB line `#f0c44d`. No red zone.
- Hint on mouse move: `(H - 226 - y) / pxPerDb` formatted `FloatToStrF(ffFixed, 7, 1)`
  + "dB", e.g. `-6.0dB`.

## Approximations
- The meter timer runs at the editor's monitor rate (30 Hz). FL's idle interval is
  set by the host; only the hold-fall acceleration depends on it.
- Tick lines are 1 editor px (FL draws 1 device px).
- Label font: system sans-serif bold 8.5 px stands in for FL's P_SmallBold.
- General Settings > "Alternate meter scale" is not modelled.

## Open questions
- FL's exact FPD_SetIdleTime interval.
