# PanOMatic (FL: Fruity PanOMatic)

Merge-pan and volume with an LFO on either. Category Gain. Editor 300 x 160.
6 parameters, no latency, no tail.

## Sources
- Form `Fruity PanOMatic`: wheels PAN (Tag 0, 0..256, def 128), VOL (Tag 1, 0..320,
  def 256), AMT (Tag 4, 0..128, def 64), SPD (Tag 5, 0..55000, def 27500); glyph selector
  LFO shape (Tag 2: Sine/Triangle/Square), LED selector LFO target (Tag 3: OFF/PAN/VOL);
  GridSelect paint box (145,5,150,150) "Panning / volume".
- flfxhost (FL 2026 binary): `info`/`sweep` value texts, renders of every pan and volume
  value, LFO periods at several speeds, rates and block sizes.
- Disassembly of the arm64 plugin: Eff_Render (VMT slot 7), ProcessParam (slot 6), the
  matrix routine, the LFO-speed routine, the smoother and the grid paint routine.
- Manual page and screenshot (2x).

## Parameters and value texts (exact)
| # | Name | Range | Text |
|---|---|---|---|
| 0 | Panning | 0..256 | p64 = Round((v-128)/2); 0 -> `Centered`, else `Round(abs(p64)*100/64)% left/right` (Delphi Round = half-even, so 127 and 129 read Centered) |
| 1 | Volume | 0..320 | `%.1fdB` of g = (11^(v/256) - 1)/10, `-InfdB` at 0, no "+" (320 = `5.6dB`) |
| 2 | LFO shape | 0..2 | Sine, Triangle, Square |
| 3 | LFO target | 0..2 | OFF, PAN, VOL |
| 4 | LFO amount | 0..128 | `%.0f%%` of v/128 (half up: 16 -> 13%) |
| 5 | LFO speed | 0..55000 | `%.0f%%` of v/550 |

Factory defaults: FL's `Default.fst` (factory preset folder) differs from the form /
constructor defaults: Panning 127 (still "Centered", a hair left) and Volume 239
("-1.5dB") instead of 128 / 256. The clone takes these as the inserted state (`state()`
overrides the two defaults; the wheels still reset to 128 / 256) and lists the preset as
"Default". The wavetables FL's host hands the plugin (sine, triangle, square) were checked
against flfxhost's bit-exact copies, which use the same conventions as the clone.

## DSP (exact, matches the binary to float precision in A/B renders)
- Matrix from pan p in -1..1 and gain v: p >= 0: LL = (1-p)v, LR = pv/2, RR = v - LR,
  RL = 0; p < 0: RR = (1+p)v, RL = -pv/2, LL = v - RL, LR = 0. Mono input keeps 0 dB on
  the near side; hard pan puts (L+R)/2 on that side.
- Smoother (FL's shared ramp routine): once per block, step = (target - current)/n,
  clamped to +-float32(44.1/sr) per sample (a clamped ramp that ends within 2^-24 of
  zero, FL's runtime threshold, snaps to 0); coefficients ramp linearly over the block. They start
  at 0 when the plugin is created (fade-in); FPD_Reset jumps to the targets and zeroes
  the LFO phase.
- LFO: uint32 phase, advanced once per block by inc*n (low 32 bits) before it is read;
  value = WaveTables[shape][phase >> 18] (16384-point host tables, no interpolation).
  Period P = Round(float32((50001^(w/65536) - 1) * w * (2048/sr))) samples with
  w = 65536 - speed; inc = 2^32 div P. Range 152 M samples (spd 0) to 2297 samples
  (19.2 Hz at 44.1 kHz). The 2048/sr factor makes FL's LFO frequency grow with sr^2
  (22.7 Hz at 48 kHz at full speed); the clone reproduces this.
- PAN target: p = clamp(pan + lfo*amt/128, -1, 1). VOL target: v = max(0, v + lfo*amt/256)
  (no upper clamp). The phase does not advance while the target is OFF.
- No tempo sync (renders at 65 and 130 BPM are identical; the plugin makes no
  time-related host calls), despite what was assumed in the task.

## Editor
- Steel metal wheels with tick rings (FL wheels sweep 300 degrees); PAN has a centre dot.
- Grid: x = pan*(W-1)/256, y = (H-1) - vol*(H-1)/320 (from the paint routine); white
  cross from the wheel values; while the LFO runs a second line follows the modulated
  pan, or the modulated volume converted back to a wheel position (ln(10v+1)/ln 11*256).
  Dragging in the grid sets pan and volume in one undo step; Alt/middle-click resets both.
- Colours sampled from the 2x screenshot: panels `#4e565b`, separators `#373c50`, grid
  `#347443`, grid lines `#5b936a`, cross `#ffffdf`, pointer `#ffc12c`.

## Approximations / open questions
- LFO starting phase: the clone (like flfxhost, whose tables are bit-exact with FL's
  generator) uses sin(2*pi*i/N), a triangle starting at 0 going up and a square that is +1
  for the first half; FL's live start phase also depends on how long the plugin ran.
- The LFO line colour (`-16192` in FL's code) is shown as light red; the exact colour
  mapping of FL's canvas is unverified.
- LFO resolution follows the host block size (FL: its mixer buffer; clone: 128 frames).
- Captions use condensed system fonts squeezed to Open Sans Condensed Light's width; the
  "PanOMatic" name is drawn in an oblique system sans fitted to FL's width.
