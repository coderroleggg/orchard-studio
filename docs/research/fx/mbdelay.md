# Multiband Delay (`mbdelay`)

FL Studio 2026 "Multiband Delay" (Image-Line; engine Daniel Schaack, UI Miroslav Krajcovic,
concept Dubswitcher). Category Delay reverb. Editor 560 x 290. Measured on FL's binary with
`flfxhost` (48 / 44.1 kHz).

## Parameters (396)

* 0..383: 8 banks x (16 DELAY, 16 VOL, 16 PAN), index = 48 (bank-1) + 16 type + band-1, range
  0..2^30. Texts: delay `v/2^30*1000` `%.2fms`, volume `%.1f%`, pan `Centered` /
  `%.1f% left|right` around 2^29.
* 384 Delay scale -6000..6000 (`v/60 %.2f%`), 385 Delay x 0.1, 386 Delay feedback 0..6000,
  387 Smoothing time 0..6000 (`v/6 ms`), 388 Filter mode (GENTLE / STEEP / LINEAR PHASE),
  389 Keep pitch, 390 Morph 0..7000 (`v/70 %`), 391 Wet/Dry mix -128..128 (`(v+128)/256`),
  392 Harmonic scale, 393 Weighting, 394 High pass 1000..100000 (`10*100^f32((v-1000)/99000)` Hz),
  395 Wet saturation (COMP / SAT / CLIP).
* All 130576 swept value texts match. The Default preset (= def values) has bank 1 without
  delays, bank 8 a 0..1000 ms ramp, banks 2..7 interpolated (FL's float32 values are embedded),
  smoothing 0 (the constructor has 250 ms and ramps in every bank). 17 factory presets embedded.
* Editor state: band switches (on / off = passes unaffected / locked), tool, target, bank,
  Semitone steps, Wave and Resulting delays visualization.

## Signal flow (measured)

Band table T = 31, 47, 71, 112, 172, 264, 413, 624, 958, 1502, 2266, 3611, 5456, 8395, 12660,
19000 Hz (the labels).
* Gentle: band 1 = LP1(1.0886 T1); bands 2..15 = 0.5 HP1 x LP1 at 1.0886 Tk (an RBJ band-pass,
  Q 0.5, at -12.04 dB; fit errors < 0.3 %); band 16 = HP1 x AP1^2 at 1.0886 T16 (bilinear).
* Steep: sqrt(2) x LR8 high-pass at T(k-1) x LR8 low-pass at Tk (LR8 = Butterworth-4 squared);
  band 16 also has AP_LR8(19 kHz)^2. Sum +0.5..+2.7 dB (not flat, as in FL).
* Linear phase: band k = 1023-tap FIR, a brick-wall over 2048-point FFT bins
  [floor(T(k-1) 2048/sr), floor(Tk 2048/sr) - 1], sine window (errors < 0.2 %). Latency 1536
  (FFT block 1024 + kernel centre 512); dry delayed by 1536 too.
* Per band: delay line with a 1-sample minimum, `D = max(1, floor(f32(dd*a) * range * sr))` with
  FL's float32 maths: a = |2x-1| (x = normalised scale), dd = d (scale >= 0) or 1-d (negative
  scale mirrors the curve), range 1 s or 0.1 s. Feedback loop = D, gain 0.95 x feedback; volume
  and pan outside the loop.
* Weighting: per-repeat gain `10^(-3 max(D/sr, 1 ms) / T60)`, T60 piecewise linear over
  0.95 x feedback: 0 / 0.06 / 0.3 / 1.5 / 7.5 / 30 s at 0 / 0.2 / 0.4 / 0.6 / 0.8 / 1.
* Harmonic scale: loop `floor(sr / (C3 2^((trunc(48 s) + 48 d) / 12)))` samples, C3 = 130.8128 Hz
  (the scale counts in whole semitones; x 0.1 has no effect).
* Smoothing: float32 one-pole on the delay, 90 % of a change in the smoothing time (it stalls
  a fraction of a sample short of the integer target, as FL does), linear interpolation. Keep
  pitch: no glide, a 100 ms linear crossfade from the old to the new tap.
* Morph: band parameters interpolated (float32) between neighbouring banks (0..7000 = bank 1..8).
* Volume law (cubic fit): g = 0.24719 v - 0.23133 v^2 + 0.98414 v^3. Pan: balance,
  L = sqrt(2(1-p)), R = sqrt(2p) (3 dB louder at the extremes).
* Wet sum -> 1st-order high-pass 10 Hz..1 kHz -> SAT = tanh (exact), CLIP = hard clip at 1
  (exact), COMP = per-channel compressor -> linear dry/wet crossfade.

## Accuracy (clone vs FL, drum loop)

Default -76 / -56 / -81 dB (Gentle / Steep / Linear), delays and negative scale -55..-74 dB,
feedback -57 dB, harmonic scale with feedback -69 dB, smoothing glide -46..-72 dB, keep-pitch
crossfades -53..-71 dB, wet/dry -60 dB. Comp in action -27 dB (level within 0.13 dB).

## Approximations / open questions

* COMP's detector is not decoded: steady sines settle at a 1.14 peak, squares at 1.01, noise
  and two-tone signals lower; modelled as a cubic-mean detector (17 ms) with 1.3 ms attack and
  177 dB/s release (fit to FL, about 4 % error on heavy limiting).
* The startup glide with smoothing (FL starts the delays from their constructor values) is only
  approximated (starts from 1 sample).
* "Off" bands (band switch) are not settable from the host; implemented per the manual.
* Semitone steps snaps edited delay values to 1/48 in harmonic mode (editor only).
